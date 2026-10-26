import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign, createHash } from 'node:crypto';
import { verifyStatement } from './signed-release-metadata.mjs';

test('signed version/target/hash/expiry binding; reject unsigned, tampered and raw mode metadata', () => {
  const {publicKey,privateKey}=generateKeyPairSync('ed25519'); // Ephemeral, never serialized to disk/logs.
  const id=Buffer.alloc(8,3), bytes=publicKey.export({format:'der',type:'spki'}).subarray(-32);
  const publicText=Buffer.from(`untrusted comment: test\n${Buffer.concat([Buffer.from('Ed'),id,bytes]).toString('base64')}\n`).toString('base64');
  const expected={version:'0.8.4',target:'darwin-aarch64',sha256:'a'.repeat(64)};
  const text=JSON.stringify({...expected,expires:200,sequence:2});
  const raw=sign(null,createHash('blake2b512').update(text).digest(),privateKey);
  const comment='fixture';
  const signature=['untrusted comment: test',Buffer.concat([Buffer.from('ED'),id,raw]).toString('base64'),`trusted comment: ${comment}`,sign(null,Buffer.concat([raw,Buffer.from(comment)]),privateKey).toString('base64')].join('\n');
  assert.equal(verifyStatement(text,signature,publicText,expected,100).statement,text);
  assert.throws(()=>verifyStatement(text+' ',signature,publicText,expected,100));
  for(const change of [{version:'0.8.3'},{target:'darwin-x86_64'},{sha256:'b'.repeat(64)}]) assert.throws(()=>verifyStatement(text,signature,publicText,{...expected,...change},100));
  assert.throws(()=>verifyStatement(text,signature,publicText,expected,200));
  assert.throws(()=>verifyStatement(text,'',publicText,expected,100));
  assert.throws(()=>verifyStatement(text,signature.replace('trusted comment: fixture','trusted comment: changed'),publicText,expected,100));
});

test('target subset: only listed mac statements are required and each still binds to its exact package', async () => {
  const { signedReleaseMetadata } = await import('./signed-release-metadata.mjs');
  const { mkdtemp, writeFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os'); const path = await import('node:path');
  const {publicKey,privateKey}=generateKeyPairSync('ed25519'); // Ephemeral, never serialized to disk/logs.
  const id=Buffer.alloc(8,5), bytes=publicKey.export({format:'der',type:'spki'}).subarray(-32);
  const publicText=Buffer.from(`untrusted comment: test\n${Buffer.concat([Buffer.from('Ed'),id,bytes]).toString('base64')}\n`).toString('base64');
  const dir=await mkdtemp(path.join(tmpdir(),'rv-subset-'));
  try {
    const pkg=Buffer.from('synthetic arm package'); await writeFile(path.join(dir,'RavenVault-Desktop-0.8.4-mac-apple-silicon.tar.gz'),pkg);
    const text=JSON.stringify({version:'0.8.4',sha256:createHash('sha256').update(pkg).digest('hex'),target:'darwin-aarch64',expires:Math.floor(Date.now()/1000)+3600,sequence:2026101001});
    const raw=sign(null,createHash('blake2b512').update(text).digest(),privateKey), comment='fixture';
    const sig=['untrusted comment: test',Buffer.concat([Buffer.from('ED'),id,raw]).toString('base64'),`trusted comment: ${comment}`,sign(null,Buffer.concat([raw,Buffer.from(comment)]),privateKey).toString('base64')].join('\n');
    await writeFile(path.join(dir,'darwin-aarch64.json'),text); await writeFile(path.join(dir,'darwin-aarch64.json.minisig'),sig);
    const out=await signedReleaseMetadata(dir,dir,'RavenVault-Desktop-0.8.4-','0.8.4',publicText,['darwin-aarch64']);
    assert.deepEqual(Object.keys(out),['darwin-aarch64']);
    await assert.rejects(signedReleaseMetadata(dir,dir,'RavenVault-Desktop-0.8.4-','0.8.4',publicText,['darwin-aarch64','darwin-x86_64']));
    await assert.rejects(signedReleaseMetadata(dir,dir,'RavenVault-Desktop-0.8.4-','0.8.4',publicText));
    await writeFile(path.join(dir,'RavenVault-Desktop-0.8.4-mac-apple-silicon.tar.gz'),'swapped bytes');
    await assert.rejects(signedReleaseMetadata(dir,dir,'RavenVault-Desktop-0.8.4-','0.8.4',publicText,['darwin-aarch64']),/binding/);
  } finally { await rm(dir,{recursive:true,force:true}); }
});
