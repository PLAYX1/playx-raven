// Public-only preparation: no private key access, signing, networking or publishing.
import { readFile } from 'node:fs/promises';
import { createHash, createPublicKey, verify } from 'node:crypto';
import path from 'node:path';

export function verifyStatement(text, signature, publicKey, expected, now = Math.floor(Date.now()/1000)) {
  if (Buffer.byteLength(text) > 4096 || signature.length > 4096) throw Error('Signed metadata too large');
  const lines = signature.trim().split(/\r?\n/);
  const pubLines = Buffer.from(publicKey, 'base64').toString('utf8').trim().split(/\r?\n/);
  const pub = Buffer.from(pubLines[1] || '', 'base64'), sig = Buffer.from(lines[1] || '', 'base64');
  if (pub.length !== 42 || sig.length !== 74 || pub.subarray(0,2).toString() !== 'Ed'
      || sig.subarray(0,2).toString() !== 'ED' || !pub.subarray(2,10).equals(sig.subarray(2,10))) throw Error('Prehashed minisign signature required');
  const key = createPublicKey({key:Buffer.concat([Buffer.from('302a300506032b6570032100','hex'),pub.subarray(10)]),format:'der',type:'spki'});
  if (!verify(null,createHash('blake2b512').update(text).digest(),key,sig.subarray(10))) throw Error('Release statement signature mismatch');
  if (!lines[2]?.startsWith('trusted comment: ') || !verify(null,Buffer.concat([sig.subarray(10),Buffer.from(lines[2].slice(17))]),key,Buffer.from(lines[3] || '', 'base64'))) throw Error('Release trusted comment signature mismatch');
  const release=JSON.parse(text);
  if (Object.keys(release).sort().join(',') !== 'expires,sequence,sha256,target,version'
      || release.version !== expected.version || release.target !== expected.target || release.sha256 !== expected.sha256
      || !Number.isSafeInteger(release.sequence) || release.sequence < 1
      || !Number.isSafeInteger(release.expires) || release.expires <= now) throw Error('Release statement binding/expiry mismatch');
  return {statement:text,signature};
}
export async function signedReleaseMetadata(directory, source, prefix, version, publicKey, targets = ['darwin-aarch64','darwin-x86_64']) {
  if (!directory) throw Error('Signed release statement directory required (secfix1)');
  const output={};
  for (const [target,suffix] of [['darwin-aarch64','mac-apple-silicon.tar.gz'],['darwin-x86_64','mac-intel.tar.gz']].filter(([t])=>targets.includes(t))) {
    const file=path.join(directory,`${target}.json`);
    const text=await readFile(file,'utf8'), signature=await readFile(`${file}.minisig`,'utf8');
    const bytes=await readFile(path.join(source,prefix+suffix));
    output[target]=verifyStatement(text,signature,publicKey,{version,target,sha256:createHash('sha256').update(bytes).digest('hex')});
  }
  return output;
}
