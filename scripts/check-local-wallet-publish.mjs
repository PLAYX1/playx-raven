import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {createRequire} from 'node:module';
import {schnorr} from '@noble/curves/secp256k1';
import {sha256} from '@noble/hashes/sha256';
import {bytesToHex,utf8ToBytes} from '@noble/hashes/utils';
const require=createRequire(import.meta.url);
const key=new Uint8Array(32).fill(41),pubkey=bytesToHex(schnorr.getPublicKey(key));
const unsigned={pubkey,created_at:Math.floor(Date.now()/1000),kind:30402,tags:[['d','playx-synthetic'],['title','Synthetic bicycle'],['price','25','USD'],['status','active'],['t','playx']],content:'Plain-text description from the wallet listing flow.'};
const id=bytesToHex(sha256(utf8ToBytes(JSON.stringify([0,pubkey,unsigned.created_at,unsigned.kind,unsigned.tags,unsigned.content]))));
const event={...unsigned,id,sig:bytesToHex(schnorr.sign(id,key))};key.fill(0);
const {outputFiles}=await build({entryPoints:['web/shop-seal.src.ts'],bundle:true,format:'cjs',platform:'node',write:false});
function page(origin,pathname='/wallet',secure=true,search='') {
  const url=new URL(origin),calls=[];let banners=0;
  const location={origin,hostname:url.hostname,host:url.host,protocol:url.protocol,pathname,search,hash:''};
  const window={isSecureContext:secure,fetch:async(path,init)=>{
    calls.push({path,init});
    assert.equal(path,'/api/nostr/publish');assert.equal(init.method,'POST');assert.equal(init.redirect,'error');assert.equal(init.referrerPolicy,'no-referrer');
    assert.equal(new Headers(init.headers).has('x-playx-token'),false);
    const received=JSON.parse(init.body);assert.deepEqual(received,event);assert.ok(schnorr.verify(received.sig,received.id,received.pubkey));
    return new Response(JSON.stringify({ok:['synthetic publisher'],failed:[]}),{status:200});
  }};
  const storage={getItem(){throw new Error('wallet publish must not read owner credentials')},setItem(){throw new Error('wallet publish must not store owner credentials')}};
  const document={documentElement:{lang:'en'},body:{prepend(){banners++}},createElement(){return{setAttribute(){},style:{}}}};
  const module={exports:{}};
  new Function('window','location','sessionStorage','document','navigator','crypto','history','module','exports','require',outputFiles[0].text)(window,location,storage,document,{language:'en'},{},{},module,module.exports,require);
  return{window,calls,get banners(){return banners}};
}
const init={method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(event)};
for(const origin of ['http://localhost:8790','http://127.0.0.1:8790','http://[::1]:8790']) {
  const p=page(origin);
  await assert.doesNotReject(async()=>{assert.equal((await p.window.fetch('/api/nostr/publish',init)).status,200)},'supported loopback wallet must publish without owner pairing');
  assert.equal(p.calls.length,1);assert.equal(p.banners,0,'no unnecessary owner connection banner');
  await assert.rejects(async()=>p.window.fetch('/api/nostr/publish',{...init,body:'x'.repeat(32769)}));assert.equal(p.calls.length,1);
  await assert.rejects(async()=>p.window.fetch('/api/nostr/publish',{...init,headers:{'x-playx-token':'not-a-role-secret'}}));assert.equal(p.calls.length,1);
}
for(const [origin,path,secure,search] of [['http://192.168.1.10:8790','/wallet',false,''],['https://shop.example','/wallet',true,''],['http://localhost:8790','/staff',true,''],['http://localhost:8790','/wallet',true,'?t=unsafe']]) {
  const p=page(origin,path,secure,search);await assert.rejects(async()=>p.window.fetch('/api/nostr/publish',init));assert.equal(p.calls.length,0);
}
console.log('PASS: signed app-shaped listing through 3 loopback wallet origins without owner token; bounded body, role/remote/query boundaries');
