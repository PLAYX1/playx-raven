import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { prepareRelease, installerSuffixes } from './release-manifest.mjs';
async function fixture(fn, brand = "PLAY-X-Raven") {
  const dir = await mkdtemp(path.join(tmpdir(), 'ravenvault-release-')), source=path.join(dir,'in'), out=path.join(dir,'out');
  await mkdir(source); await mkdir(out);
  for (const suffix of new Set([...installerSuffixes,'mac-apple-silicon.tar.gz','mac-intel.tar.gz'])) await writeFile(path.join(source,`${brand}-0.4.0-${suffix}`),`synthetic installer ${suffix}`);
  for (const suffix of ['windows.exe','mac-apple-silicon.tar.gz','mac-intel.tar.gz','linux.AppImage']) await writeFile(path.join(source,`${brand}-0.4.0-${suffix}.sig`),Buffer.from('synthetic signature '.repeat(20)).toString('base64'));
  try { await fn(source,out); } finally { await rm(dir,{recursive:true,force:true}); }
}
test('all platforms publish immutable version URLs, hashes, aliases and preserve older files',()=>fixture(async(source,out)=>{
  await writeFile(path.join(out,'older-installer.exe'),'keep');
  const {manifest,paths}=await prepareRelease(source,out,'0.4.0');
  assert.equal(Object.keys(manifest.platforms).length,4); assert.equal(manifest.installers.length,5);
  assert.ok(Object.values(manifest.platforms).every(p=>p.url.includes('/v0.4.0/PLAY-X-Raven-0.4.0-')&&!p.url.includes('latest-')));
  for(const item of manifest.installers) assert.match(item.sha256,/^[a-f0-9]{64}$/);
  assert.equal(await readFile(path.join(out,'older-installer.exe'),'utf8'),'keep');
  assert.ok(paths.includes('PLAY-X-Raven-latest-windows.exe'));
  await assert.rejects(prepareRelease(source,out,'0.4.0'),/already exists/);
}));
test('missing platform and missing signature stop publication',()=>fixture(async(source,out)=>{
  await rm(path.join(source,'PLAY-X-Raven-0.4.0-windows.exe.sig'));
  await assert.rejects(prepareRelease(source,out,'0.4.0'),/Missing updater signature/);
  await rm(path.join(source,'PLAY-X-Raven-0.4.0-mac-intel.dmg'));
  await assert.rejects(prepareRelease(source,out,'0.4.0'),/Missing installer/);
  await assert.rejects(readFile(path.join(out,'latest.json')));
}));
test('invalid version and malformed signature fail before writing',()=>fixture(async(source,out)=>{
  await assert.rejects(prepareRelease(source,out,'../../bad'),/Invalid release version/);
  await writeFile(path.join(source,'PLAY-X-Raven-0.4.0-windows.exe.sig'),'bad');
  await assert.rejects(prepareRelease(source,out,'0.4.0'),/Malformed updater signature/);
  await assert.rejects(readFile(path.join(out,'latest.json')));
}));
test('Linux RPM output produced by the real Tauri build is preserved',()=>fixture(async(source,out)=>{
  const name='PLAY-X-Raven-0.4.0-linux.rpm';
  await writeFile(path.join(source,name),'synthetic rpm');
  const {paths}=await prepareRelease(source,out,'0.4.0');
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
  await assert.rejects(prepareRelease(source,out,'0.4.0'),/must be newer/);
  assert.equal(JSON.parse(await readFile(path.join(out,'latest.json'),'utf8')).version,'0.4.1');
  await assert.rejects(readFile(path.join(out,'v0.4.0','manifest.json')));
  await writeFile(path.join(out,'latest.json'),JSON.stringify({version:'0.4.0'}));
  await assert.rejects(prepareRelease(source,out,'0.4.0'),/must be newer/);
}));

 test('new installer brand keeps both latest aliases and old immutable files',()=>fixture(async(source,out)=>{
   await mkdir(path.join(out,'v0.3.9'));
   const old=path.join(out,'v0.3.9','PLAY-X-Raven-0.3.9-windows.exe');
   await writeFile(old,'old published bytes');
   const {manifest,paths}=await prepareRelease(source,out,'0.4.0');
   assert.ok(Object.values(manifest.platforms).every(p=>p.url.includes('/RavenVault-Desktop-0.4.0-')));
   for(const item of manifest.installers) {
     const suffix=item.platform;
     assert.deepEqual(await readFile(path.join(out,`PLAY-X-Raven-latest-${suffix}`)),await readFile(path.join(out,`RavenVault-Desktop-latest-${suffix}`)));
     assert.ok(paths.includes(`PLAY-X-Raven-latest-${suffix}`));
   }
   assert.equal(await readFile(old,'utf8'),'old published bytes');
 },'RavenVault-Desktop'));
