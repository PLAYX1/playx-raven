// Public synthetic fixtures only. No HTTP or native bridge.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {build} from 'esbuild';
const root=new URL('../',import.meta.url).pathname;
async function moduleAt(path) {
  const r=await build({entryPoints:[path],bundle:true,write:false,platform:'node',format:'cjs'});
  const Module=createRequire(import.meta.url)('node:module'),m=new Module(path);m.filename=path;m.paths=Module._nodeModulePaths(root);m._compile(r.outputFiles[0].text,path);return m.exports;
}
const {transactionCode}=await moduleAt(root+'src/phone-transaction-qr.ts');
const fixture=JSON.parse(readFileSync(root+'scripts/phone-transaction-fixture.json','utf8'));
const uri='ravenvault://transaction?v=1&hex='+fixture.raw;
assert.equal(await transactionCode(uri),uri);
assert.equal(await transactionCode([...fixture.parts].reverse().join('\n')),uri);
assert.equal(await transactionCode([...fixture.parts,fixture.parts[0]].join('\n')),uri);
await assert.rejects(transactionCode(fixture.parts.slice(1).join('\n')),/조각/);
await assert.rejects(transactionCode('x'.repeat(600001)));
const corrupt=fixture.parts.map((part,i)=>{if(i)return part;const u=new URL(part);const bytes=Buffer.from(u.searchParams.get('d'),'base64');bytes[bytes.length-1]^=1;u.searchParams.set('d',bytes.toString('base64'));return u.href;});
await assert.rejects(transactionCode(corrupt.join('\n')));
await assert.rejects(transactionCode(fixture.parts.join('\n')+'\n'+corrupt[0]));
await assert.rejects(transactionCode(fixture.parts.map(p=>p.replace('v=1','v=2')).join('\n')));
await assert.rejects(transactionCode(fixture.parts.map(p=>p+'&i=0').join('\n')));
const envelope='playx://mesh?'+new URLSearchParams({v:'1',d:Buffer.from(uri).toString('base64')});
assert.equal(await transactionCode(envelope),uri);
console.log('PASS mesh parts: reversed order, identical duplicate, missing, corrupt hash, conflicting duplicate, version, duplicate parameter, size cap, single envelope');
const web=root+'../wt-ravenvault-web-ux/';
const {parseTransactionQR}=await moduleAt(web+'core/wallet-offline/transaction-qr.ts');
assert.equal(parseTransactionQR(uri).hex,fixture.raw);
assert.equal(parseTransactionQR(await transactionCode(fixture.parts.join('\n'))).hex,fixture.raw);
const {validateNetworkSnapshot}=await moduleAt(web+'core/network/status.ts');
const snapshot=JSON.parse(readFileSync(root+'artifacts/claude-desktop-ux/network-snapshot.json','utf8'));
assert.equal(validateNetworkSnapshot(snapshot).peers.total,3);
console.log('PASS desktop fixture accepted by actual phone parser; real mocked Rust route response accepted by actual phone network validator');
