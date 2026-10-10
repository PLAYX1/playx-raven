import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir, rm, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { prepareRelease, installerSuffixes, ALL_RELEASE_TARGETS } from './release-manifest.mjs';
async function fixture(fn, brand = "PLAY-X-Raven") {
  const dir = await mkdtemp(path.join(tmpdir(), 'ravenvault-release-')), source=path.join(dir,'in'), out=path.join(dir,'out');
  await mkdir(source); await mkdir(out);
  for (const suffix of new Set([...installerSuffixes,'mac-apple-silicon.tar.gz','mac-intel.tar.gz'])) await writeFile(path.join(source,`${brand}-0.4.0-${suffix}`),`synthetic installer ${suffix}`);
  for (const suffix of ['windows.exe','mac-apple-silicon.tar.gz','mac-intel.tar.gz','linux.AppImage']) await writeFile(path.join(source,`${brand}-0.4.0-${suffix}.sig`),Buffer.from('synthetic signature '.repeat(20)).toString('base64'));
  try { await fn(source,out); } finally { await rm(dir,{recursive:true,force:true}); }
}
test('all platforms publish immutable version URLs, hashes, aliases and preserve older files',()=>fixture(async(source,out)=>{
  await writeFile(path.join(out,'older-installer.exe'),'keep');
  const {manifest,paths}=await prepareRelease(source,out,'0.4.0',undefined,ALL_RELEASE_TARGETS);
  assert.equal(Object.keys(manifest.platforms).length,4); assert.equal(manifest.installers.length,5);
  assert.ok(Object.values(manifest.platforms).every(p=>p.url.includes('/v0.4.0/PLAY-X-Raven-0.4.0-')&&!p.url.includes('latest-')));
  for(const item of manifest.installers) assert.match(item.sha256,/^[a-f0-9]{64}$/);
  assert.equal(await readFile(path.join(out,'older-installer.exe'),'utf8'),'keep');
  assert.ok(paths.includes('PLAY-X-Raven-latest-windows.exe'));
  await assert.rejects(prepareRelease(source,out,'0.4.0',undefined,ALL_RELEASE_TARGETS),/already exists/);
}));
test('missing platform and missing signature stop publication',()=>fixture(async(source,out)=>{
  await rm(path.join(source,'PLAY-X-Raven-0.4.0-windows.exe.sig'));
  await assert.rejects(prepareRelease(source,out,'0.4.0',undefined,ALL_RELEASE_TARGETS),/Missing updater signature/);
  await rm(path.join(source,'PLAY-X-Raven-0.4.0-mac-intel.dmg'));
  await assert.rejects(prepareRelease(source,out,'0.4.0',undefined,ALL_RELEASE_TARGETS),/Missing installer/);
  await assert.rejects(readFile(path.join(out,'latest.json')));
}));
test('invalid version and malformed signature fail before writing',()=>fixture(async(source,out)=>{
  await assert.rejects(prepareRelease(source,out,'../../bad',undefined,ALL_RELEASE_TARGETS),/Invalid release version/);
  await writeFile(path.join(source,'PLAY-X-Raven-0.4.0-windows.exe.sig'),'bad');
  await assert.rejects(prepareRelease(source,out,'0.4.0',undefined,ALL_RELEASE_TARGETS),/Malformed updater signature/);
  await assert.rejects(readFile(path.join(out,'latest.json')));
}));
test('Linux RPM output produced by the real Tauri build is preserved',()=>fixture(async(source,out)=>{
  const name='PLAY-X-Raven-0.4.0-linux.rpm';
  await writeFile(path.join(source,name),'synthetic rpm');
  const {paths}=await prepareRelease(source,out,'0.4.0',undefined,ALL_RELEASE_TARGETS);
  assert.ok(paths.includes(path.join('v0.4.0',name)));
  assert.equal(await readFile(path.join(out,'v0.4.0',name),'utf8'),'synthetic rpm');
}));
test('RavenVault keeps the original wallet, updater and Windows MSI identity',async()=>{
  const config=JSON.parse(await readFile(new URL('../src-tauri/tauri.conf.json',import.meta.url),'utf8'));
  assert.equal(config.identifier,'se.erci.ex.playx.raven');
  assert.equal(config.bundle.windows.wix.upgradeCode,'693df2cf-3ab4-5924-9965-a3bf71d75a61');
  assert.deepEqual(config.plugins.updater.endpoints,['https://rvn.ex.erci.se/update/{{target}}/{{arch}}/{{current_version}}']);
  assert.equal(config.plugins.updater.dangerousInsecureTransportProtocol,false);
});
test('publishing an older or equal version cannot downgrade a newer public update',()=>fixture(async(source,out)=>{
  await writeFile(path.join(out,'latest.json'),JSON.stringify({version:'0.4.1'}));
  await assert.rejects(prepareRelease(source,out,'0.4.0',undefined,ALL_RELEASE_TARGETS),/must be newer/);
  assert.equal(JSON.parse(await readFile(path.join(out,'latest.json'),'utf8')).version,'0.4.1');
  await assert.rejects(readFile(path.join(out,'v0.4.0','manifest.json')));
  await writeFile(path.join(out,'latest.json'),JSON.stringify({version:'0.4.0'}));
  await assert.rejects(prepareRelease(source,out,'0.4.0',undefined,ALL_RELEASE_TARGETS),/must be newer/);
}));

 test('new installer brand keeps both latest aliases and old immutable files',()=>fixture(async(source,out)=>{
   await mkdir(path.join(out,'v0.3.9'));
   const old=path.join(out,'v0.3.9','PLAY-X-Raven-0.3.9-windows.exe');
   await writeFile(old,'old published bytes');
   const {manifest,paths}=await prepareRelease(source,out,'0.4.0',undefined,ALL_RELEASE_TARGETS);
   assert.ok(Object.values(manifest.platforms).every(p=>p.url.includes('/RavenVault-Desktop-0.4.0-')));
   for(const item of manifest.installers) {
     const suffix=item.platform;
     assert.deepEqual(await readFile(path.join(out,`PLAY-X-Raven-latest-${suffix}`)),await readFile(path.join(out,`RavenVault-Desktop-latest-${suffix}`)));
     assert.ok(paths.includes(`PLAY-X-Raven-latest-${suffix}`));
   }
   assert.equal(await readFile(old,'utf8'),'old published bytes');
 },'RavenVault-Desktop'));

test('0.8.4 refuses metadata publication without secfix1 signed statements',()=>fixture(async(source,out)=>{
  const {readdir,rename}=await import('node:fs/promises');
  for (const name of await readdir(source)) await rename(path.join(source,name),path.join(source,name.replace('0.4.0','0.8.4')));
  await assert.rejects(prepareRelease(source,out,'0.8.4',undefined,ALL_RELEASE_TARGETS),/Signed release statement directory required/);
  await assert.rejects(readFile(path.join(out,'latest.json')));
}));

// ── Explicit target subsets (0.8.4: Apple Silicon only). No default; the listed targets stay strict.
import { validatePublishedManifest } from './verify-published-release.mjs';
async function writeTarget(source, version, label, suffixes, sigs) {
  for (const s of suffixes) await writeFile(path.join(source,`RavenVault-Desktop-${version}-${s}`),`synthetic ${version} ${s}`);
  for (const s of sigs) await writeFile(path.join(source,`RavenVault-Desktop-${version}-${s}.sig`),Buffer.from(`synthetic signature ${label} `.repeat(20)).toString('base64'));
}
test('targets must be listed explicitly: missing, empty, unknown or duplicate targets are refused before writing',()=>fixture(async(source,out)=>{
  for (const bad of [undefined, [], ['darwin'], ['darwin-aarch64','darwin-aarch64'], 'darwin-aarch64'])
    await assert.rejects(prepareRelease(source,out,'0.4.0',undefined,bad),/release target/i);
  await assert.rejects(readFile(path.join(out,'latest.json')));
}));
test('CLI refuses to run without --targets',async()=>{
  const {execFile}=await import('node:child_process');
  const r=await new Promise(res=>execFile(process.execPath,[new URL('./release-manifest.mjs',import.meta.url).pathname,'/nonexistent-in','/nonexistent-out','0.4.0'],(e,o,er)=>res({code:e?.code,er})));
  assert.notEqual(r.code,0); assert.match(r.er,/--targets/);
});
test('partial release: only listed target is published, other aliases untouched, others carried with their old version',()=>fixture(async(source,out)=>{
  await prepareRelease(source,out,'0.4.0',undefined,ALL_RELEASE_TARGETS);
  const before={}; for (const s of ['windows.exe','windows.msi','mac-intel.dmg','mac-intel.tar.gz','linux.AppImage']) for (const b of ['PLAY-X-Raven','RavenVault-Desktop']) before[`${b}-latest-${s}`]=await readFile(path.join(out,`${b}-latest-${s}`));
  const oldLatest=JSON.parse(await readFile(path.join(out,'latest.json'),'utf8'));
  const next=path.join(path.dirname(source),'next'); await mkdir(next);
  await writeTarget(next,'0.4.1','arm',['mac-apple-silicon.dmg','mac-apple-silicon.tar.gz'],['mac-apple-silicon.tar.gz']);
  const {manifest,paths}=await prepareRelease(next,out,'0.4.1',undefined,['darwin-aarch64']);
  assert.deepEqual(Object.keys(manifest.platforms),['darwin-aarch64']);
  assert.equal(manifest.installers.length,5);
  for (const item of manifest.installers) {
    if (item.platform==='mac-apple-silicon.dmg') { assert.equal(item.version,undefined); assert.match(item.url,/\/v0\.4\.1\/RavenVault-Desktop-0\.4\.1-mac-apple-silicon\.dmg$/); }
    else assert.deepEqual(item,{...oldLatest.installers.find(o=>o.platform===item.platform),version:'0.4.0'});
  }
  for (const [name,bytes] of Object.entries(before)) assert.deepEqual(await readFile(path.join(out,name)),bytes,`alias changed: ${name}`);
  assert.equal(await readFile(path.join(out,'RavenVault-Desktop-latest-mac-apple-silicon.dmg'),'utf8'),'synthetic 0.4.1 mac-apple-silicon.dmg');
  assert.ok(paths.every(p=>!/windows|mac-intel|linux/.test(p)),'partial release must not stage other targets');
  const sums=(await readFile(path.join(out,'SHA256SUMS.txt'),'utf8')).trim().split('\n');
  assert.ok(sums.some(l=>l.endsWith('v0.4.1/RavenVault-Desktop-0.4.1-mac-apple-silicon.dmg')));
  assert.ok(sums.some(l=>l.endsWith('v0.4.0/PLAY-X-Raven-0.4.0-windows.exe')),'other targets keep their checksum lines');
  assert.ok(!sums.some(l=>l.includes('v0.4.0/PLAY-X-Raven-0.4.0-mac-apple-silicon')),'replaced target drops its old checksum lines');
  const latest=JSON.parse(await readFile(path.join(out,'latest.json'),'utf8'));
  assert.ok(validatePublishedManifest(latest,'0.4.1',['darwin-aarch64']));
  assert.throws(()=>validatePublishedManifest(latest,'0.4.1',['darwin-aarch64','darwin-x86_64','windows-x86_64','linux-x86_64']));
  assert.throws(()=>validatePublishedManifest(oldLatest,'0.4.0',['darwin-aarch64']),'a full manifest is not a darwin-only manifest');
  assert.throws(()=>validatePublishedManifest(latest,'0.4.1',undefined),/targets/i);
  const bumped=structuredClone(latest); bumped.installers.find(i=>i.version).version='0.4.1';
  assert.throws(()=>validatePublishedManifest(bumped,'0.4.1',['darwin-aarch64']),'carried entries must be older');
  const unlabeled=structuredClone(latest); delete unlabeled.installers.find(i=>i.version).version;
  assert.throws(()=>validatePublishedManifest(unlabeled,'0.4.1',['darwin-aarch64']),'carried entries keep their version label');
}));
test('partial release still demands every file of the listed target and refuses files of unlisted targets',()=>fixture(async(source,out)=>{
  await prepareRelease(source,out,'0.4.0',undefined,ALL_RELEASE_TARGETS);
  const next=path.join(path.dirname(source),'next'); await mkdir(next);
  await writeTarget(next,'0.4.1','arm',['mac-apple-silicon.dmg','mac-apple-silicon.tar.gz'],[]);
  await assert.rejects(prepareRelease(next,out,'0.4.1',undefined,['darwin-aarch64']),/Missing updater signature/);
  await writeTarget(next,'0.4.1','arm',[],['mac-apple-silicon.tar.gz']);
  await rm(path.join(next,'RavenVault-Desktop-0.4.1-mac-apple-silicon.dmg'));
  await assert.rejects(prepareRelease(next,out,'0.4.1',undefined,['darwin-aarch64']),/Missing installer/);
  await writeTarget(next,'0.4.1','arm',['mac-apple-silicon.dmg','windows.exe'],[]);
  await assert.rejects(prepareRelease(next,out,'0.4.1',undefined,['darwin-aarch64']),/not listed/);
  await assert.rejects(stat(path.join(out,'v0.4.1')));
  assert.equal(JSON.parse(await readFile(path.join(out,'latest.json'),'utf8')).version,'0.4.0');
}));
test('partial release refuses when there is nothing valid to carry for the other targets',()=>fixture(async(source,out)=>{
  const next=path.join(path.dirname(source),'next'); await mkdir(next);
  await writeTarget(next,'0.4.1','arm',['mac-apple-silicon.dmg','mac-apple-silicon.tar.gz'],['mac-apple-silicon.tar.gz']);
  await assert.rejects(prepareRelease(next,out,'0.4.1',undefined,['darwin-aarch64']),/needs the current latest\.json/);
  await prepareRelease(source,out,'0.4.0',undefined,ALL_RELEASE_TARGETS);
  const latest=JSON.parse(await readFile(path.join(out,'latest.json'),'utf8'));
  latest.installers=latest.installers.filter(i=>i.platform!=='linux.AppImage');
  await writeFile(path.join(out,'latest.json'),JSON.stringify(latest));
  await assert.rejects(prepareRelease(next,out,'0.4.1',undefined,['darwin-aarch64']),/Cannot carry previous installer: linux\.AppImage/);
  latest.installers.push({platform:'linux.AppImage',url:'https://example.test/evil.AppImage',bytes:1,sha256:'a'.repeat(64)});
  await writeFile(path.join(out,'latest.json'),JSON.stringify(latest));
  await assert.rejects(prepareRelease(next,out,'0.4.1',undefined,['darwin-aarch64']),/Invalid carried installer entry/);
  await assert.rejects(stat(path.join(out,'v0.4.1')));
}));
