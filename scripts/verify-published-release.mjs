import path from 'node:path';
import { pathToFileURL } from 'node:url';

// Public metadata and HEAD requests only. No publish APIs, credentials, or binary downloads.
export const PUBLIC_BASE = 'https://raw.githubusercontent.com/PLAYX1/playx-raven-releases/dist/';
export const PLATFORMS = Object.freeze({
  'windows-x86_64': 'windows.exe',
  'darwin-aarch64': 'mac-apple-silicon.tar.gz',
  'darwin-x86_64': 'mac-intel.tar.gz',
  'linux-x86_64': 'linux.AppImage',
});
export const INSTALLERS = Object.freeze(['windows.exe', 'windows.msi', 'mac-apple-silicon.dmg', 'mac-intel.dmg', 'linux.AppImage']);
export const ALL_TARGETS = Object.freeze(Object.keys(PLATFORMS));
// Which installers belong to which updater target. A partial release must name its targets explicitly.
export const TARGET_INSTALLERS = Object.freeze({
  'windows-x86_64': ['windows.exe', 'windows.msi'], 'darwin-aarch64': ['mac-apple-silicon.dmg'],
  'darwin-x86_64': ['mac-intel.dmg'], 'linux-x86_64': ['linux.AppImage'],
});
// Targets whose release statement is always required when the target is listed (the original, shipped behavior).
export const MAC_SIGNED_TARGETS = Object.freeze(['darwin-aarch64', 'darwin-x86_64']);
// Opt-in targets: a signed statement is required for them only in strict mode (the CLI, and the offline
// release builder), so a release without their statements keeps auto-update blocked for them.
export const EXTENDED_SIGNED_TARGETS = Object.freeze(['windows-x86_64', 'linux-x86_64']);
const MAX_MANIFEST_BYTES = 64 * 1024;
const MAX_ARTIFACT_BYTES = 99_000_000;
export class InvalidRelease extends Error {}
class NotVisible extends Error {}

function checkVersion(version) {
  if (typeof version !== 'string' || version.length > 32 || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) {
    throw new InvalidRelease('Invalid release version; use a canonical major.minor.patch version');
  }
}
/** Explicit target list only: no default, no unknown or duplicate names. Returned in canonical order. */
export function checkTargets(targets) {
  if (!Array.isArray(targets) || targets.length < 1) throw new InvalidRelease('Release targets must be listed explicitly (--targets)');
  if (new Set(targets).size !== targets.length || targets.some(t => !ALL_TARGETS.includes(t))) throw new InvalidRelease('Unknown or duplicate release target');
  return ALL_TARGETS.filter(t => targets.includes(t));
}
export function parseTargetsArg(argv) {
  const at = argv.indexOf('--targets');
  if (at < 0 || typeof argv[at + 1] !== 'string' || argv[at + 1].startsWith('--')) throw new InvalidRelease('Missing required --targets list (e.g. --targets darwin-aarch64)');
  const rest = argv.slice(0, at).concat(argv.slice(at + 2));
  if (rest.includes('--targets')) throw new InvalidRelease('--targets may be given only once');
  return { targets: checkTargets(argv[at + 1].split(',')), rest };
}
function newer(a, b) {
  const x = a.split('.').map(Number), y = b.split('.').map(Number);
  return x.reduce((order, n, i) => order || Math.sign(n - y[i]), 0) > 0;
}
function exactKeys(value, keys, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join('\0') !== [...keys].sort().join('\0')) {
    throw new InvalidRelease(`Invalid ${name} fields`);
  }
}
function artifactUrls(version, suffix) {
  return ["PLAY-X-Raven", "RavenVault-Desktop"].map(brand => `${PUBLIC_BASE}v${version}/${brand}-${version}-${suffix}`);
}

// Return a canonical projection, so JSON property / installer ordering is immaterial.
export function validatePublishedManifest(value, expectedVersion, targets, { strictSigned = false } = {}) {
  checkVersion(expectedVersion);
  targets = checkTargets(targets);
  const present = value && value.signed_releases && typeof value.signed_releases === 'object' ? value.signed_releases : {};
  const signedTargets = [...MAC_SIGNED_TARGETS, ...EXTENDED_SIGNED_TARGETS]
    .filter(t => targets.includes(t) && (MAC_SIGNED_TARGETS.includes(t) || strictSigned || Object.hasOwn(present, t)));
  const included = new Set(targets.flatMap(t => TARGET_INSTALLERS[t]));
  if (!value || typeof value !== 'object') throw new InvalidRelease('Invalid release manifest');
  checkVersion(value.version);
  if (value.version !== expectedVersion) throw new NotVisible(`Expected ${expectedVersion}; public manifest still reports ${value.version}`);
  const needsStatement = expectedVersion.split('.').map(Number).reduce((order,n,i)=>order || Math.sign(n-[0,8,4][i]),0) >= 0;
  exactKeys(value, ['version', 'notes', 'pub_date', 'platforms', 'installers', ...(needsStatement ? ['signed_releases'] : [])], 'manifest');
  const signed = {};
  if (needsStatement) {
    exactKeys(value.signed_releases, signedTargets, 'signed releases');
    for (const target of signedTargets) {
      const item = value.signed_releases[target];
      exactKeys(item, ['statement','signature'], 'signed release');
      if (typeof item.statement !== 'string' || item.statement.length > 4096 || typeof item.signature !== 'string'
          || item.signature.length < 100 || item.signature.length > 4096) throw new InvalidRelease('Invalid signed statement encoding');
      let statement;
      try { statement = JSON.parse(item.statement); } catch { throw new InvalidRelease('Invalid signed statement JSON'); }
      exactKeys(statement, ['version','target','sha256','sequence','expires'], 'release statement');
      if (statement.version !== expectedVersion || statement.target !== target || !/^[a-f0-9]{64}$/.test(statement.sha256)
          || !Number.isSafeInteger(statement.sequence) || statement.sequence < 1
          || !Number.isSafeInteger(statement.expires) || statement.expires <= Math.floor(Date.now()/1000)) throw new InvalidRelease('Invalid signed statement binding');
      signed[target] = {statement:item.statement,signature:item.signature};
    }
  }
  if (typeof value.notes !== 'string' || value.notes.length > 16_384) throw new InvalidRelease('Invalid release notes');
  if (typeof value.pub_date !== 'string' || !Number.isFinite(Date.parse(value.pub_date)) || new Date(value.pub_date).toISOString() !== value.pub_date) {
    throw new InvalidRelease('Invalid publication date');
  }
  exactKeys(value.platforms, targets, 'updater platform');
  const platforms = {};
  for (const [platform, suffix] of Object.entries(PLATFORMS).filter(([p]) => targets.includes(p))) {
    const item = value.platforms[platform];
    exactKeys(item, ['signature', 'url'], 'updater item');
    if (!artifactUrls(expectedVersion, suffix).includes(item.url)) throw new InvalidRelease(`Invalid immutable updater URL: ${platform}`);
    const signature = typeof item.signature === 'string' ? item.signature.replace(/[\r\n]/g, '') : '';
    if (signature.length < 100 || signature.length > 2048 || !/^[A-Za-z0-9+/]+={0,2}$/.test(signature) || Buffer.from(signature, 'base64').toString('base64') !== signature) {
      throw new InvalidRelease(`Invalid updater signature encoding: ${platform}`);
    }
    platforms[platform] = { signature: item.signature, url: item.url };
  }
  if (!Array.isArray(value.installers) || value.installers.length !== INSTALLERS.length) throw new InvalidRelease('Expected exactly five installers');
  const installers = INSTALLERS.map(suffix => {
    const found = value.installers.filter(item => item?.platform === suffix);
    if (found.length !== 1) throw new InvalidRelease(`Missing or duplicate installer: ${suffix}`);
    const item = found[0];
    // Installers of targets outside this release keep their earlier version's immutable entry, labeled with that version.
    const own = included.has(suffix);
    exactKeys(item, own ? ['platform', 'url', 'bytes', 'sha256'] : ['platform', 'url', 'bytes', 'sha256', 'version'], 'installer');
    if (!own) {
      checkVersion(item.version);
      if (!newer(expectedVersion, item.version)) throw new InvalidRelease(`Carried installer must be from an older version: ${suffix}`);
    }
    if (!artifactUrls(own ? expectedVersion : item.version, suffix).includes(item.url)) throw new InvalidRelease(`Invalid immutable installer URL: ${suffix}`);
    if (!Number.isSafeInteger(item.bytes) || item.bytes < 1 || item.bytes >= MAX_ARTIFACT_BYTES) throw new InvalidRelease(`Invalid installer size: ${suffix}`);
    if (typeof item.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(item.sha256)) throw new InvalidRelease(`Invalid installer hash: ${suffix}`);
    return { platform: suffix, url: item.url, bytes: item.bytes, sha256: item.sha256, ...(own ? {} : { version: item.version }) };
  });
  return { version: value.version, notes: value.notes, pub_date: value.pub_date, platforms, installers, ...(needsStatement ? {signed_releases:signed} : {}) };
}

function lengthHeader(response, limit) {
  const text = response.headers.get('content-length');
  if (text === null) return null;
  if (!/^[0-9]+$/.test(text) || !Number.isSafeInteger(Number(text)) || Number(text) < 1 || Number(text) >= limit) {
    throw new InvalidRelease('Public response size is invalid or exceeds the limit');
  }
  return Number(text);
}
async function request(fetcher, url, method, signal) {
  const response = await fetcher(url, {
    method, signal, redirect: 'error', credentials: 'omit', cache: 'no-store',
    headers: { accept: method === 'GET' ? 'application/json' : 'application/octet-stream', 'accept-encoding': 'identity' },
  });
  if (response.redirected || (response.url && response.url !== url)) throw new InvalidRelease('Public release URL redirected unexpectedly');
  return response;
}
async function readManifest(fetcher, url, signal) {
  const response = await request(fetcher, url, 'GET', signal);
  if (response.status !== 200) throw new NotVisible(`Public manifest unavailable (HTTP ${response.status})`);
  lengthHeader(response, MAX_MANIFEST_BYTES + 1);
  if (!response.body) throw new InvalidRelease('Public manifest has no body');
  const reader = response.body.getReader();
  let size = 0;
  const chunks = [];
  try {
    while (true) {
      signal.throwIfAborted();
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > MAX_MANIFEST_BYTES) throw new InvalidRelease('Public manifest exceeds the size limit');
      chunks.push(part.value);
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, size)));
  } catch {
    throw new InvalidRelease('Public manifest is not valid UTF-8 JSON');
  }
}
async function checkArtifact(fetcher, item, signal) {
  const response = await request(fetcher, item.url, 'HEAD', signal);
  if (response.status !== 200) throw new NotVisible(`Artifact unavailable (HTTP ${response.status}): ${item.url}`); // HEAD_STATUS_GUARD
  const bytes = lengthHeader(response, MAX_ARTIFACT_BYTES);
  if (bytes !== null && item.bytes !== undefined && bytes !== item.bytes) throw new InvalidRelease('Public artifact size does not match its manifest');
}
async function attemptVerification(version, targets, fetcher, signal, strictSigned) {
  const raw = await Promise.all([
    readManifest(fetcher, `${PUBLIC_BASE}latest.json`, signal),
    readManifest(fetcher, `${PUBLIC_BASE}v${version}/manifest.json`, signal),
  ]);
  const [latest, immutable] = raw.map(value => validatePublishedManifest(value, version, targets, { strictSigned }));
  if (JSON.stringify(latest) !== JSON.stringify(immutable)) throw new InvalidRelease('Latest and immutable release manifests disagree');
  const artifacts = new Map(Object.values(latest.platforms).map(item => [item.url, { url: item.url }]));
  for (const item of latest.installers) artifacts.set(item.url, { url: item.url, bytes: item.bytes });
  // Future branded releases must keep the old download links live, too.
  for (const item of [...artifacts.values()]) {
    const prefix = `${PUBLIC_BASE}v${version}/RavenVault-Desktop-${version}-`;
    if (!item.url.startsWith(prefix)) continue;
    const suffix = item.url.slice(prefix.length);
    for (const brand of ['PLAY-X-Raven', 'RavenVault-Desktop']) {
      const url = `${PUBLIC_BASE}${brand}-latest-${suffix}`;
      artifacts.set(url, { ...item, url });
    }
  }
  const items = [...artifacts.values()];
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(4, items.length) }, async () => {
    while (cursor < items.length) {
      signal.throwIfAborted();
      await checkArtifact(fetcher, items[cursor++], signal);
    }
  }));
  return { version, updaterPlatforms: Object.keys(latest.platforms).length, installers: latest.installers.length, artifacts: items.length };
}

export async function verifyPublishedRelease(version, {
  targets, strictSigned = false, fetcher = fetch, now = () => performance.now(), sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
  cacheWaitMs = 15 * 60_000, retryMs = 30_000, attemptTimeoutMs = 20_000, onRetry = () => {},
} = {}) {
  checkVersion(version);
  targets = checkTargets(targets);
  for (const [name, value, min, max] of [['cacheWaitMs', cacheWaitMs, 0, 900_000], ['retryMs', retryMs, 1, 30_000], ['attemptTimeoutMs', attemptTimeoutMs, 1, 20_000]]) {
    if (!Number.isFinite(value) || value < min || value > max) throw new InvalidRelease(`Invalid ${name} limit`);
  }
  const start = now(), deadline = start + cacheWaitMs;
  for (let attempts = 1; attempts <= 64; attempts++) {
    const finalAttempt = now() >= deadline;
    const timeoutMs = finalAttempt ? attemptTimeoutMs : Math.min(attemptTimeoutMs, Math.max(1, deadline - now()));
    const controller = new AbortController();
    let timer;
    try {
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new NotVisible('Public release request timed out'));
        }, timeoutMs);
      });
      const result = await Promise.race([attemptVerification(version, targets, fetcher, controller.signal, strictSigned), timeout]);
      return { ...result, attempts, elapsedMs: Math.round(now() - start) };
    } catch (error) {
      if (error instanceof InvalidRelease) throw error;
      if (finalAttempt || attempts === 64) throw new Error(`Public release ${version} did not become available within the verification window: ${error.message}`);
      onRetry({ attempt: attempts, elapsedMs: Math.round(now() - start), reason: error instanceof NotVisible ? error.message : 'Public request failed' });
    } finally {
      clearTimeout(timer);
      controller.abort();
    }
    await sleep(Math.min(retryMs, Math.max(0, deadline - now())));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const { targets, rest } = parseTargetsArg(process.argv.slice(2));
    if (rest.length !== 1) throw new Error('Usage: node scripts/verify-published-release.mjs major.minor.patch --targets darwin-aarch64[,darwin-x86_64,windows-x86_64,linux-x86_64]');
    const result = await verifyPublishedRelease(rest[0], {
      targets, strictSigned: true,
      onRetry: ({ attempt, elapsedMs, reason }) => console.log(`Waiting for public cache (attempt ${attempt}, ${Math.round(elapsedMs / 1000)}s): ${reason}`),
    });
    console.log(JSON.stringify(result));
    console.log('Verified metadata and public HEAD availability only; binary hashes and cryptographic signatures are not checked by this job.');
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
