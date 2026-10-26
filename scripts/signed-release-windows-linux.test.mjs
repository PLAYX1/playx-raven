import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign, createHash } from 'node:crypto';
import { mkdtemp, writeFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { signedReleaseMetadata, SIGNED_PACKAGES } from './signed-release-metadata.mjs';
import { prepareRelease } from './release-manifest.mjs';
import { validatePublishedManifest, ALL_TARGETS, PLATFORMS, PUBLIC_BASE, TARGET_INSTALLERS } from './verify-published-release.mjs';

const V = '0.9.6', PREFIX = `RavenVault-Desktop-${V}-`;
const ALL4 = ['windows-x86_64', 'darwin-aarch64', 'darwin-x86_64', 'linux-x86_64'];
function keys(seed = 7) { // ephemeral, never written to disk
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const id = Buffer.alloc(8, seed), raw = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
  const publicText = Buffer.from(`untrusted comment: test\n${Buffer.concat([Buffer.from('Ed'), id, raw]).toString('base64')}\n`).toString('base64');
  return { id, privateKey, publicText };
}
function signText(k, text) {
  const hash = sign(null, createHash('blake2b512').update(text).digest(), k.privateKey), comment = 'fixture';
  return ['untrusted comment: test', Buffer.concat([Buffer.from('ED'), k.id, hash]).toString('base64'), `trusted comment: ${comment}`,
    sign(null, Buffer.concat([hash, Buffer.from(comment)]), k.privateKey).toString('base64')].join('\n');
}
async function setup(fn) {
  const dir = await mkdtemp(path.join(tmpdir(), 'rv-wl-')), k = keys(), pkgs = {};
  try {
    for (const [target, suffix] of SIGNED_PACKAGES) { pkgs[target] = Buffer.from(`synthetic ${target} package`); await writeFile(path.join(dir, PREFIX + suffix), pkgs[target]); }
    const statement = async (target, over = {}, signer = k) => {
      const text = JSON.stringify({ version: V, sha256: createHash('sha256').update(pkgs[target]).digest('hex'), target, expires: Math.floor(Date.now() / 1000) + 3600, sequence: 9, ...over });
      await writeFile(path.join(dir, `${target}.json`), text); await writeFile(path.join(dir, `${target}.json.minisig`), signText(signer, text));
    };
    await fn({ dir, k, statement });
  } finally { await rm(dir, { recursive: true, force: true }); }
}
const run = (dir, k, targets) => signedReleaseMetadata(dir, dir, PREFIX, V, k.publicText, targets);

test('package suffix per target: mac tarballs, Windows NSIS .exe, Linux AppImage', () => {
  assert.deepEqual(Object.fromEntries(SIGNED_PACKAGES), { 'darwin-aarch64': 'mac-apple-silicon.tar.gz', 'darwin-x86_64': 'mac-intel.tar.gz', 'windows-x86_64': 'windows.exe', 'linux-x86_64': 'linux.AppImage' });
  for (const [t, s] of SIGNED_PACKAGES) assert.equal(PLATFORMS[t], s, 'must agree with the updater platform suffix');
});
test('default targets are still the two mac targets: Windows/Linux statements are opt-in via targets', () => setup(async ({ dir, k, statement }) => {
  await statement('darwin-aarch64'); await statement('darwin-x86_64');
  assert.deepEqual(Object.keys(await run(dir, k)), ['darwin-aarch64', 'darwin-x86_64']);
}));
test('windows and linux statements verify when listed; the package is the .exe / .AppImage', () => setup(async ({ dir, k, statement }) => {
  for (const t of ALL4) await statement(t);
  const out = await run(dir, k, ALL4);
  assert.deepEqual(Object.keys(out).sort(), [...ALL4].sort());
  for (const t of ['windows-x86_64', 'linux-x86_64']) assert.equal(JSON.parse(out[t].statement).target, t);
}));
test('listing windows or linux without its statement is refused (1st switch: no statement = no auto update)', () => setup(async ({ dir, k, statement }) => {
  await statement('darwin-aarch64'); await statement('darwin-x86_64');
  await assert.rejects(run(dir, k, ['darwin-aarch64', 'darwin-x86_64', 'windows-x86_64']), /windows-x86_64/);
  await assert.rejects(run(dir, k, ['linux-x86_64']), /linux-x86_64/);
  const src = path.join(dir, 'src'); await mkdir(src);
  const sigText = Buffer.from('synthetic signature '.repeat(20)).toString('base64');
  for (const [, n] of SIGNED_PACKAGES) await writeFile(path.join(src, PREFIX + n), 'x');
  for (const n of ['windows.msi', 'mac-apple-silicon.dmg', 'mac-intel.dmg']) await writeFile(path.join(src, PREFIX + n), 'x');
  for (const [, n] of SIGNED_PACKAGES) await writeFile(path.join(src, PREFIX + n + '.sig'), sigText);
  const empty = path.join(dir, 'empty-statements'); await mkdir(empty);
  await assert.rejects(prepareRelease(src, path.join(dir, 'dist'), V, empty, ALL4), /statement missing/);
}));
test('unsigned, wrong-key, wrong-sha, wrong-target, wrong-version and expired windows/linux statements are refused', () => setup(async ({ dir, k, statement }) => {
  for (const t of ['windows-x86_64', 'linux-x86_64']) {
    await statement(t, {}, keys(9)); await assert.rejects(run(dir, k, [t]), /signature|Prehashed/, `${t} wrong key`);
    await statement(t); await writeFile(path.join(dir, `${t}.json.minisig`), ''); await assert.rejects(run(dir, k, [t]), undefined, `${t} no signature`);
    await statement(t, { sha256: 'b'.repeat(64) }); await assert.rejects(run(dir, k, [t]), /binding/, `${t} sha`);
    await statement(t, { target: t === 'windows-x86_64' ? 'linux-x86_64' : 'windows-x86_64' }); await assert.rejects(run(dir, k, [t]), /binding/, `${t} target`);
    await statement(t, { version: '0.9.5' }); await assert.rejects(run(dir, k, [t]), /binding/, `${t} version`);
    await statement(t, { expires: 10 }); await assert.rejects(run(dir, k, [t]), /binding/, `${t} expired`);
    await statement(t); assert.deepEqual(Object.keys(await run(dir, k, [t])), [t]);
  }
}));
test('swapped package bytes break the binding for windows and linux', () => setup(async ({ dir, k, statement }) => {
  await statement('windows-x86_64'); await writeFile(path.join(dir, PREFIX + 'windows.exe'), 'swapped');
  await assert.rejects(run(dir, k, ['windows-x86_64']), /binding/);
  await statement('linux-x86_64'); await writeFile(path.join(dir, PREFIX + 'linux.AppImage'), 'swapped');
  await assert.rejects(run(dir, k, ['linux-x86_64']), /binding/);
}));

function manifest(withStatements, targets = ALL_TARGETS) {
  const url = suffix => `${PUBLIC_BASE}v${V}/${PREFIX}${suffix}`, sig = Buffer.from('synthetic signature '.repeat(20)).toString('base64');
  const installers = ['windows.exe', 'windows.msi', 'mac-apple-silicon.dmg', 'mac-intel.dmg', 'linux.AppImage'];
  const m = { version: V, notes: 'n', pub_date: '2026-10-23T00:00:00.000Z',
    platforms: Object.fromEntries(Object.entries(PLATFORMS).filter(([p]) => targets.includes(p)).map(([p, s]) => [p, { url: url(s), signature: sig }])),
    installers: installers.map(platform => targets.flatMap(t => TARGET_INSTALLERS[t]).includes(platform)
      ? { platform, url: url(platform), bytes: 10, sha256: 'a'.repeat(64) }
      : { platform, url: `${PUBLIC_BASE}v0.9.5/RavenVault-Desktop-0.9.5-${platform}`, bytes: 10, sha256: 'a'.repeat(64), version: '0.9.5' }), signed_releases: {} };
  for (const t of withStatements) m.signed_releases[t] = { statement: JSON.stringify({ version: V, sha256: 'a'.repeat(64), target: t, sequence: 1, expires: Math.floor(Date.now() / 1000) + 3600 }), signature: 'x'.repeat(120) };
  return m;
}
test('public verifier: strict mode (the CLI) requires a statement for every listed target; legacy mac-only manifests still pass non-strict', () => {
  const macOnly = manifest(['darwin-aarch64', 'darwin-x86_64']);
  assert.doesNotThrow(() => validatePublishedManifest(macOnly, V, ALL_TARGETS));
  assert.throws(() => validatePublishedManifest(macOnly, V, ALL_TARGETS, { strictSigned: true }), /signed releases/);
  const macTargets = ['darwin-aarch64', 'darwin-x86_64'], macOnlyPlatforms = manifest(macTargets, macTargets);
  assert.doesNotThrow(() => validatePublishedManifest(macOnlyPlatforms, V, macTargets, { strictSigned: true }));
  const full = manifest(ALL4);
  const out = validatePublishedManifest(full, V, ALL_TARGETS, { strictSigned: true });
  assert.deepEqual(Object.keys(out.signed_releases).sort(), [...ALL4].sort());
  assert.doesNotThrow(() => validatePublishedManifest(full, V, ALL_TARGETS));
});
test('public verifier rejects bad windows/linux statements and statements for unlisted targets', () => {
  for (const mutate of [
    m => { m.signed_releases['windows-x86_64'].statement = m.signed_releases['windows-x86_64'].statement.replace('windows-x86_64', 'linux-x86_64'); },
    m => { m.signed_releases['linux-x86_64'].statement = m.signed_releases['linux-x86_64'].statement.replace(V, '0.9.5'); },
    m => { m.signed_releases['linux-x86_64'].signature = ''; },
    m => { delete m.signed_releases['windows-x86_64']; },
  ]) { const m = manifest(ALL4); mutate(m); assert.throws(() => validatePublishedManifest(m, V, ALL_TARGETS, { strictSigned: true })); }
  const macTargets = ['darwin-aarch64', 'darwin-x86_64'], extra = manifest(ALL4, macTargets);
  assert.throws(() => validatePublishedManifest(extra, V, macTargets, { strictSigned: true }), /signed releases/);
  assert.throws(() => validatePublishedManifest(extra, V, macTargets), /signed releases/);
});
