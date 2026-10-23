import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign as edSign, createHash } from 'node:crypto';
import { mkdtemp, writeFile, readFile, rm, mkdir, rename, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { readPublished, nextSequence, runFlow, tauriSign, STATEMENT_DAYS } from './auto-publish-flow.mjs';
import { SIGNED_PACKAGES } from './signed-release-metadata.mjs';

const NOW = new Date('2026-10-23T00:00:00Z');
function keys(seed = 4) {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519'); // ephemeral
  const id = Buffer.alloc(8, seed), raw = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
  return { id, privateKey, publicKey: Buffer.from(`untrusted comment: t\n${Buffer.concat([Buffer.from('Ed'), id, raw]).toString('base64')}\n`).toString('base64') };
}
const signer = k => async file => {
  const text = await readFile(file, 'utf8'), hash = edSign(null, createHash('blake2b512').update(text).digest(), k.privateKey), c = 'fixture';
  return ['untrusted comment: t', Buffer.concat([Buffer.from('ED'), k.id, hash]).toString('base64'), `trusted comment: ${c}`, edSign(null, Buffer.concat([hash, Buffer.from(c)]), k.privateKey).toString('base64')].join('\n');
};
// stand-in for prepare-update-statement.py (that script has its own tests)
const prepare = async ({ packagePath, target, version, sequence, expires, output }) => {
  const sha256 = createHash('sha256').update(await readFile(packagePath)).digest('hex');
  await writeFile(output, JSON.stringify({ version, sha256, target, expires, sequence }));
};
const SIG = Buffer.from('synthetic signature '.repeat(20)).toString('base64');
async function candidate(dir, version, skip = []) {
  const src = path.join(dir, 'rel'); await mkdir(src, { recursive: true });
  const P = `RavenVault-Desktop-${version}-`;
  const names = ['windows.exe', 'windows.msi', 'mac-apple-silicon.dmg', 'mac-intel.dmg', 'linux.AppImage', 'mac-apple-silicon.tar.gz', 'mac-intel.tar.gz'];
  for (const n of names) if (!skip.includes(n)) await writeFile(path.join(src, P + n), `synthetic ${n} ${version}`);
  for (const [, n] of SIGNED_PACKAGES) if (!skip.includes(n + '.sig')) await writeFile(path.join(src, P + n + '.sig'), SIG);
  return src;
}
async function env(fn) {
  const dir = await mkdtemp(path.join(tmpdir(), 'rv-flow-')), k = keys();
  const pub = path.join(dir, 'pub'), statementsDir = path.join(dir, 'statements'); await mkdir(pub); await mkdir(statementsDir);
  try { await fn({ dir, k, pub, statementsDir, args: v => ({ pub, statementsDir, version: v, prepare, sign: signer(k), publicKey: k.publicKey, now: NOW }) }); }
  finally { await rm(dir, { recursive: true, force: true }); }
}
const exists = p => access(p).then(() => true, () => false);

test('first publication: date-based sequence, 30-day expiry, all four targets signed and written', () => env(async ({ dir, pub, args }) => {
  const source = await candidate(dir, '0.9.6');
  const r = await runFlow({ source, ...args('0.9.6') });
  assert.equal(r.sequence, 2026102301);
  const latest = JSON.parse(await readFile(path.join(pub, 'latest.json'), 'utf8'));
  assert.deepEqual(Object.keys(latest.signed_releases).sort(), ['darwin-aarch64', 'darwin-x86_64', 'linux-x86_64', 'windows-x86_64']);
  for (const item of Object.values(latest.signed_releases)) {
    const s = JSON.parse(item.statement);
    assert.equal(s.sequence, 2026102301); assert.equal(s.version, '0.9.6'); assert.equal(s.expires, Math.floor(NOW / 1000) + STATEMENT_DAYS * 86400);
  }
  assert.ok(await exists(path.join(pub, 'v0.9.6', 'manifest.json')));
}));
test('next release: sequence is the published maximum + 1 for every target', () => env(async ({ dir, pub, args }) => {
  await runFlow({ source: await candidate(dir, '0.9.6'), ...args('0.9.6') });
  assert.equal((await readPublished(pub)).maxSequence, 2026102301);
  await rm(path.join(dir, 'rel'), { recursive: true });
  const r = await runFlow({ source: await candidate(dir, '0.9.7'), ...args('0.9.7') });
  assert.equal(r.sequence, 2026102302);
  assert.equal(nextSequence({ version: '1.0.0', maxSequence: 41 }), 42);
}));
test('same or lower version than the published one is refused and nothing is written', () => env(async ({ dir, pub, args }) => {
  await runFlow({ source: await candidate(dir, '0.9.6'), ...args('0.9.6') });
  const before = await readFile(path.join(pub, 'latest.json'), 'utf8');
  await rm(path.join(dir, 'rel'), { recursive: true });
  for (const v of ['0.9.6', '0.9.5']) {
    await assert.rejects(runFlow({ source: await candidate(dir, v), ...args(v) }), /newer|already published/);
    await rm(path.join(dir, 'rel'), { recursive: true });
  }
  assert.equal(await readFile(path.join(pub, 'latest.json'), 'utf8'), before);
  assert.equal(await exists(path.join(pub, 'v0.9.5')), false);
}));
test('one missing installer, package or updater signature stops the whole publish before any file is written', () => env(async ({ dir, pub, args }) => {
  for (const skip of ['linux.AppImage', 'windows.exe.sig', 'mac-intel.tar.gz', 'windows.msi', 'linux.AppImage.sig']) {
    const source = await candidate(dir, '0.9.6', [skip]);
    await assert.rejects(runFlow({ source, ...args('0.9.6') }), /incomplete/, skip);
    await rm(source, { recursive: true });
  }
  assert.equal(await exists(path.join(pub, 'latest.json')), false);
  assert.equal(await exists(path.join(pub, 'v0.9.6')), false);
}));
test('a file at or over 95MB stops the publish', () => env(async ({ dir, pub, args }) => {
  const source = await candidate(dir, '0.9.6');
  await writeFile(path.join(source, 'RavenVault-Desktop-0.9.6-linux.AppImage'), Buffer.alloc(95_000_000));
  await assert.rejects(runFlow({ source, ...args('0.9.6') }), /95MB/);
  assert.equal(await exists(path.join(pub, 'latest.json')), false);
}));
test('statements signed with the wrong key are rejected before publish files exist', () => env(async ({ dir, pub, args }) => {
  const source = await candidate(dir, '0.9.6');
  await assert.rejects(runFlow({ source, ...args('0.9.6'), sign: signer(keys(9)) }), /signature|Prehashed/);
  assert.equal(await exists(path.join(pub, 'latest.json')), false);
}));
test('unsigned (empty) statement is rejected', () => env(async ({ dir, pub, args }) => {
  const source = await candidate(dir, '0.9.6');
  await assert.rejects(runFlow({ source, ...args('0.9.6'), sign: async () => '' }));
  assert.equal(await exists(path.join(pub, 'latest.json')), false);
}));
test('unreadable published latest.json is never guessed around', () => env(async ({ dir, pub, args }) => {
  await writeFile(path.join(pub, 'latest.json'), '{broken');
  await assert.rejects(runFlow({ source: await candidate(dir, '0.9.6'), ...args('0.9.6') }), /unreadable/);
}));
test('tauriSign passes the key only through the environment, hides tool output and decodes the signature', async () => {
  const { writeFileSync } = await import('node:fs');
  const dir = await mkdtemp(path.join(tmpdir(), 'rv-sign-')), file = path.join(dir, 't.json'), calls = [];
  const saved = process.env.TAURI_SIGNING_PRIVATE_KEY; process.env.TAURI_SIGNING_PRIVATE_KEY = 'synthetic-not-a-key';
  try {
    await writeFile(file, '{}');
    const run = (cmd, argv, opt) => { calls.push({ cmd, argv, opt }); writeFileSync(`${file}.sig`, Buffer.from('MINISIG TEXT').toString('base64')); return { status: 0 }; };
    assert.equal(await tauriSign({ run })(file), 'MINISIG TEXT');
    assert.deepEqual(calls[0].argv, ['--no-install', 'tauri', 'signer', 'sign', file]);
    assert.ok(!calls[0].argv.join(' ').includes('synthetic-not-a-key'), 'key must not be on the command line');
    assert.deepEqual(calls[0].opt.stdio, ['ignore', 'ignore', 'ignore']);
    assert.equal(await exists(`${file}.sig`), false, 'raw .sig is removed');
    delete process.env.TAURI_SIGNING_PRIVATE_KEY;
    await assert.rejects(tauriSign({ run })(file), /not available/);
  } finally { if (saved === undefined) delete process.env.TAURI_SIGNING_PRIVATE_KEY; else process.env.TAURI_SIGNING_PRIVATE_KEY = saved; await rm(dir, { recursive: true, force: true }); }
});
