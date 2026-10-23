// Automatic publish flow used by .github/workflows/release.yml (publish job).
// Steps b..f: read the published sequence, build + sign the statements, build the publish files,
// and verify everything locally. It NEVER pushes and never touches the network; the workflow does
// the single commit/push only after this whole script succeeds (all-or-nothing).
// The signing key arrives only through TAURI_SIGNING_PRIVATE_KEY(+_PASSWORD) in the environment of
// the signing child process; it is never written to a file or printed.
import { readFile, writeFile, readdir, stat, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareRelease, ALL_RELEASE_TARGETS } from './release-manifest.mjs';
import { SIGNED_PACKAGES } from './signed-release-metadata.mjs';
import { validatePublishedManifest, TARGET_INSTALLERS, InvalidRelease } from './verify-published-release.mjs';

export const STATEMENT_DAYS = 30; // same lifetime run-091-intel.sh has always used
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
// GitHub 은 파일 하나가 100MiB(104,857,600바이트)를 넘으면 푸시를 거부한다. 그보다 아래의 여유선.
const MAX_BYTES = 99_000_000;
const cmp = (a, b) => { const x = a.split('.').map(Number), y = b.split('.').map(Number); return x.reduce((o, n, i) => o || Math.sign(n - y[i]), 0); };

/** Version and highest statement sequence in the currently published latest.json (null when none). */
export async function readPublished(pub) {
  let latest;
  try { latest = JSON.parse(await readFile(path.join(pub, 'latest.json'), 'utf8')); }
  catch (e) { if (e.code === 'ENOENT') return { version: null, maxSequence: 0 }; throw new Error('Published latest.json is unreadable; refusing to guess a sequence'); }
  if (typeof latest.version !== 'string' || !SEMVER.test(latest.version)) throw new Error('Published latest.json has an invalid version');
  let maxSequence = 0;
  for (const item of Object.values(latest.signed_releases ?? {})) {
    let s; try { s = JSON.parse(item.statement); } catch { throw new Error('Published statement is unreadable; refusing to guess a sequence'); }
    if (!Number.isSafeInteger(s.sequence) || s.sequence < 1) throw new Error('Published statement has an invalid sequence');
    maxSequence = Math.max(maxSequence, s.sequence);
  }
  return { version: latest.version, maxSequence };
}
/** New sequence = published maximum + 1. First publication (or no published statements): YYYYMMDD01 of today (UTC). */
export function nextSequence(published, now = new Date()) {
  if (published.maxSequence > 0) return published.maxSequence + 1;
  const d = now.toISOString().slice(0, 10).replaceAll('-', '');
  return Number(d + '01');
}
export async function checkNewVersion(pub, version) {
  if (!SEMVER.test(version)) throw new Error('Invalid release version');
  const published = await readPublished(pub);
  if (published.version !== null && cmp(version, published.version) <= 0) throw new Error(`Release ${version} must be newer than the published ${published.version}`);
  try { await stat(path.join(pub, `v${version}`)); throw new Error(`Version ${version} is already published`); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  return published;
}
/** Every target needs its installers, updater package and updater signature; any gap stops the whole publish. */
export async function checkCandidate(source, version, targets = ALL_RELEASE_TARGETS) {
  const files = new Set(await readdir(source));
  const prefix = [...files].some(f => f.startsWith(`RavenVault-Desktop-${version}-`)) ? `RavenVault-Desktop-${version}-` : `PLAY-X-Raven-${version}-`;
  const need = new Set();
  for (const [target, suffix] of SIGNED_PACKAGES.filter(([t]) => targets.includes(t))) { need.add(suffix); need.add(suffix + '.sig'); for (const i of TARGET_INSTALLERS[target]) need.add(i); }
  const missing = [...need].filter(s => !files.has(prefix + s));
  if (missing.length) throw new Error(`Release candidate is incomplete; nothing will be published. Missing: ${missing.join(', ')}`);
  for (const name of files) {
    const info = await stat(path.join(source, name));
    if (!info.isFile() || info.size < 1 || info.size >= MAX_BYTES) throw new Error(`Release file is empty or at/over the 99MB limit: ${name}`);
  }
  return prefix;
}
export function pythonPrepare({ python = 'python3' } = {}) {
  return ({ packagePath, target, version, sequence, expires, output }) => {
    const r = spawnSync(python, ['-I', fileURLToPath(new URL('./prepare-update-statement.py', import.meta.url)), packagePath, '--target', target, '--version', version,
      '--sequence', String(sequence), '--expires', String(expires), '--output', output], { encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`Statement preparation failed for ${target}: ${(r.stderr || '').trim()}`);
  };
}
/** Last lines of the tool's error text with the key and password removed, so a failure can be diagnosed from the log. */
export function redactedTail(text, secrets = [process.env.TAURI_SIGNING_PRIVATE_KEY, process.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD]) {
  let out = String(text ?? '');
  for (const secret of secrets) if (secret && secret.length >= 4) out = out.split(secret).join('***');
  out = out.replace(/[A-Za-z0-9+/=]{40,}/g, '***').trim().split('\n').slice(-6).join(' | ');
  return out ? out.slice(0, 400) : '(no error text)';
}
/** Real signer: `tauri signer sign` reads the key only from the environment; the output is decoded into a .minisig. */
export function tauriSign({ run = spawnSync } = {}) {
  return async file => {
    if (!process.env.TAURI_SIGNING_PRIVATE_KEY) throw new Error('Signing key is not available in this job');
    const r = run('npx', ['--no-install', 'tauri', 'signer', 'sign', file], { encoding: 'utf8', env: process.env, stdio: ['ignore', 'ignore', 'pipe'] });
    if (r.status !== 0) throw new Error(`Statement signing failed for ${path.basename(file)}: ${redactedTail(r.stderr)}`);
    const sig = await readFile(`${file}.sig`, 'utf8');
    await rm(`${file}.sig`, { force: true });
    return Buffer.from(sig.trim(), 'base64').toString('utf8');
  };
}
export async function buildStatements({ source, prefix, version, sequence, statementsDir, expires, prepare, sign, targets = ALL_RELEASE_TARGETS }) {
  for (const [target, suffix] of SIGNED_PACKAGES.filter(([t]) => targets.includes(t))) {
    const json = path.join(statementsDir, `${target}.json`);
    await prepare({ packagePath: path.join(source, prefix + suffix), target, version, sequence, expires, output: json });
    await writeFile(`${json}.minisig`, await sign(json));
  }
}
/** Offline check of the produced publish files with the same strict rules the public verifier applies. */
export async function verifyLocalPub(pub, version, targets = ALL_RELEASE_TARGETS) {
  const [latest, immutable] = await Promise.all([readFile(path.join(pub, 'latest.json'), 'utf8'), readFile(path.join(pub, `v${version}`, 'manifest.json'), 'utf8')]);
  const a = validatePublishedManifest(JSON.parse(latest), version, targets, { strictSigned: true });
  const b = validatePublishedManifest(JSON.parse(immutable), version, targets, { strictSigned: true });
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new InvalidRelease('Latest and immutable release manifests disagree');
  for (const name of await readdir(path.join(pub, `v${version}`))) {
    const info = await stat(path.join(pub, `v${version}`, name));
    if (info.size >= MAX_BYTES) throw new Error(`Publish file at/over the 99MB limit: ${name}`);
  }
  return a;
}
/** Steps b..f. Throws before anything is considered publishable; the caller only pushes after success. */
export async function runFlow({ source, pub, version, statementsDir, prepare, sign, publicKey, now = new Date(), targets = ALL_RELEASE_TARGETS }) {
  const published = await checkNewVersion(pub, version);
  const prefix = await checkCandidate(source, version, targets);
  const sequence = nextSequence(published, now);
  const expires = Math.floor(now.getTime() / 1000) + STATEMENT_DAYS * 86400;
  await buildStatements({ source, prefix, version, sequence, statementsDir, expires, prepare, sign, targets });
  const result = await prepareRelease(source, pub, version, statementsDir, targets, publicKey);
  await verifyLocalPub(pub, version, targets);
  return { sequence, expires, paths: result.paths };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [cmd, source, pub, version] = process.argv.slice(2);
  if (cmd !== 'flow' || !source || !pub || !version) throw new Error('Usage: node scripts/auto-publish-flow.mjs flow <input> <dist-checkout> <version>');
  const statementsDir = path.resolve(pub, '../statements');
  await (await import('node:fs/promises')).mkdir(statementsDir, { recursive: true });
  const result = await runFlow({ source, pub, version, statementsDir, prepare: pythonPrepare(), sign: tauriSign() });
  await writeFile(path.resolve(pub, '../release-paths.txt'), result.paths.join('\n') + '\n');
  console.log(`Prepared and locally verified ${version} (sequence ${result.sequence}); nothing was pushed.`);
}
