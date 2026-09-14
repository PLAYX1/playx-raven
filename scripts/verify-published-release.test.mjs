import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const script = new URL('./verify-published-release.mjs', import.meta.url);
let moduleUrl = script.href;
if (process.argv.includes('--mutant-head')) {
  const source = (await readFile(script, 'utf8')).replaceAll('\r\n', '\n');
  const broken = source.replace(/^  if \(response.status !== 200\).*HEAD_STATUS_GUARD$/m, '  // Deliberately broken: accept missing artifacts.');
  assert.notEqual(broken, source, 'Mutation must change the real HEAD status guard');
  moduleUrl = `data:text/javascript;base64,${Buffer.from(broken).toString('base64')}`;
}
const { PUBLIC_BASE, verifyPublishedRelease, validatePublishedManifest } = await import(moduleUrl);
const version = '0.4.1';
const platformPairs = [
  ['windows-x86_64', 'windows.exe'], ['darwin-aarch64', 'mac-apple-silicon.tar.gz'],
  ['darwin-x86_64', 'mac-intel.tar.gz'], ['linux-x86_64', 'linux.AppImage'],
];
const installerNames = ['windows.exe', 'windows.msi', 'mac-apple-silicon.dmg', 'mac-intel.dmg', 'linux.AppImage'];
function manifest(v = version) {
  const url = suffix => `${PUBLIC_BASE}v${v}/PLAY-X-Raven-${v}-${suffix}`;
  return {
    version: v, notes: 'Synthetic public release', pub_date: '2026-09-14T18:00:00.000Z',
    platforms: Object.fromEntries(platformPairs.map(([p, suffix]) => [p, { url: url(suffix), signature: Buffer.from('synthetic signature '.repeat(20)).toString('base64') }])),
    installers: installerNames.map(platform => ({ platform, url: url(platform), bytes: 1000, sha256: 'a'.repeat(64) })),
  };
}
function fixture({ latest = () => manifest(), immutable = () => manifest(), head = () => 200 } = {}) {
  const calls = [];
  const fetcher = async (url, options) => {
    calls.push({ url, ...options });
    assert.ok(url.startsWith(PUBLIC_BASE));
    assert.equal(new URL(url).search, '');
    assert.equal(options.credentials, 'omit');
    assert.equal(options.redirect, 'error');
    assert.deepEqual(Object.keys(options.headers).sort(), ['accept', 'accept-encoding']);
    if (options.method === 'HEAD') return { status: head(url), headers: new Headers(), get body() { throw Error('Must not download artifacts'); } };
    assert.equal(options.method, 'GET');
    assert.ok(url.endsWith('latest.json') || url.endsWith(`v${version}/manifest.json`));
    return new Response(JSON.stringify(url.endsWith('latest.json') ? latest() : immutable()));
  };
  return { calls, fetcher };
}
function clock() {
  let time = 0;
  return { now: () => time, sleep: async ms => { time += ms; } };
}

test('exact four updater platforms / five installers produce only seven deduplicated artifact HEAD requests', async () => {
  const f = fixture();
  const result = await verifyPublishedRelease(version, { ...f, cacheWaitMs: 0 });
  assert.deepEqual({ ...result, elapsedMs: 0 }, { version, updaterPlatforms: 4, installers: 5, artifacts: 7, attempts: 1, elapsedMs: 0 });
  assert.equal(f.calls.filter(c => c.method === 'GET').length, 2);
  assert.equal(f.calls.filter(c => c.method === 'HEAD').length, 7);
  assert.equal(new Set(f.calls.map(c => c.url)).size, 9);
});
test('50 seconds of stale raw cache recovers without rebuilding or publishing', async () => {
  const time = clock();
  const f = fixture({ latest: () => manifest(time.now() < 50_000 ? '0.4.0' : version) });
  const result = await verifyPublishedRelease(version, { ...f, ...time });
  assert.equal(result.attempts, 3);
  assert.equal(result.elapsedMs, 60_000);
});
test('cache may remain stale for fifteen minutes; final bounded attempt succeeds', async () => {
  const time = clock();
  const f = fixture({ latest: () => manifest(time.now() < 900_000 ? '0.4.0' : version) });
  const result = await verifyPublishedRelease(version, { ...f, ...time });
  assert.equal(result.attempts, 31);
  assert.equal(result.elapsedMs, 900_000);
});
test('permanently wrong version fails after bounded retries', async () => {
  const time = clock(), f = fixture({ latest: () => manifest('0.4.0') });
  await assert.rejects(verifyPublishedRelease(version, { ...f, ...time, cacheWaitMs: 60_000 }), /did not become available.*still reports 0\.4\.0/);
  assert.equal(time.now(), 60_000);
  assert.equal(f.calls.filter(c => c.method === 'GET').length, 6);
  assert.equal(f.calls.filter(c => c.method === 'HEAD').length, 0);
});
test('missing public artifact fails instead of reporting a successful release', async () => {
  const time = clock(), f = fixture({ head: url => url.endsWith('windows.msi') ? 404 : 200 });
  await assert.rejects(verifyPublishedRelease(version, { ...f, ...time, cacheWaitMs: 30_000 }), /Artifact unavailable \(HTTP 404\)/);
  assert.equal(time.now(), 30_000);
});
test('schema, exact platform identities and immutable URLs reject malformed public metadata', () => {
  const mutations = [
    m => { m.platforms['windows-arm64'] = m.platforms['windows-x86_64']; delete m.platforms['windows-x86_64']; },
    m => { m.installers[1] = m.installers[0]; },
    m => { m.platforms['windows-x86_64'].url = 'https://example.com/installer.exe'; },
    m => { m.installers[0].url += '?cache=1'; },
    m => { m.installers[0].sha256 = 'malformed'; },
    m => { m.installers[0].bytes = -1; },
    m => { m.platforms['windows-x86_64'].signature = 'not a signature'; },
  ];
  for (const mutate of mutations) {
    const value = manifest(); mutate(value);
    assert.throws(() => validatePublishedManifest(value, version));
  }
});
test('same-version metadata mismatch is rejected before any artifact request', async () => {
  const other = manifest(); other.installers[0].sha256 = 'b'.repeat(64);
  const f = fixture({ immutable: () => other });
  await assert.rejects(verifyPublishedRelease(version, { ...f, cacheWaitMs: 0 }), /manifests disagree/);
  assert.equal(f.calls.length, 2);
});
test('oversized manifest and a nonresponsive public request fail within limits', async () => {
  await assert.rejects(verifyPublishedRelease(version, { cacheWaitMs: 0, fetcher: async () => new Response(' '.repeat(65_537)) }), /size limit/);
  await assert.rejects(verifyPublishedRelease(version, { cacheWaitMs: 0, attemptTimeoutMs: 5, fetcher: () => new Promise(() => {}) }), /timed out/);
});
test('verify-only workflow cannot build, sign, or publish and shares the postpublish verifier', async () => {
  const workflow = (await readFile(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8')).replaceAll('\r\n', '\n');
  const verify = workflow.match(/^  verify:\n([\s\S]*?)(?=^  build:)/m)?.[1];
  assert.ok(verify);
  assert.match(workflow, /verify_only:\n[\s\S]*?type: boolean/);
  assert.match(verify, /if: inputs\.verify_only == true/);
  assert.match(verify, /contents: read/);
  assert.match(verify, /persist-credentials: false/);
  assert.doesNotMatch(verify, /secrets\.|git push|tauri build|npm ci|release-manifest\.mjs/);
  assert.match(workflow, /  build:\n    if: inputs\.verify_only != true/);
  assert.match(workflow, /  publish:\n    needs: build\n    #.*\n    if: success\(\)/);
  assert.equal((workflow.match(/run: node scripts\/verify-published-release\.mjs/g) ?? []).length, 1);
  assert.match(workflow, /Verify public version and every updater URL[\s\S]*node scripts\/verify-published-release\.mjs "\$V"/);
});

test('new RavenVault Desktop URLs pass the same immutable manifest and HEAD checks',async()=>{
  const renamed=()=>JSON.parse(JSON.stringify(manifest()).replaceAll('PLAY-X-Raven-','RavenVault-Desktop-'));
  const f=fixture({latest:renamed,immutable:renamed});
  const result=await verifyPublishedRelease(version,{...f,cacheWaitMs:0});
  assert.equal(result.artifacts,21);
  assert.equal(f.calls.filter(c=>c.method==='HEAD'&&c.url.includes('/PLAY-X-Raven-latest-')).length,7);
  assert.equal(f.calls.filter(c=>c.method==='HEAD'&&c.url.includes('/RavenVault-Desktop-latest-')).length,7);
  const bad=renamed();bad.platforms['darwin-aarch64'].url=bad.platforms['darwin-aarch64'].url.replace(version,'9.9.9');
  assert.throws(()=>validatePublishedManifest(bad,version),/Invalid immutable updater URL/);
});

test('new release verification fails if an old latest alias disappears',async()=>{
  const renamed=()=>JSON.parse(JSON.stringify(manifest()).replaceAll('PLAY-X-Raven-','RavenVault-Desktop-'));
  const f=fixture({latest:renamed,immutable:renamed,head:url=>url.includes('/PLAY-X-Raven-latest-')?404:200});
  await assert.rejects(verifyPublishedRelease(version,{...f,cacheWaitMs:0}),/Artifact unavailable/);
});
