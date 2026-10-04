import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
const require=createRequire(import.meta.url);
const vectors=JSON.parse(readFileSync('src-tauri/testdata/rv-shop-seal-vectors.json','utf8'));
const output=await build({entryPoints:['web/shop-seal.src.ts'],bundle:true,format:'cjs',platform:'node',write:false});
const code=output.outputFiles[0].text;
for(const test of [...vectors.cases,...vectors.interop]) {
  const storage=new Map();const calls=[];
  const location={pathname:'/staff',search:'',hash:`#t=${vectors.tokens.staff}&k=${vectors.desk_pub}`};
  const window={isSecureContext:true,fetch:async (path,init)=>{calls.push({path,init});assert.deepEqual(JSON.parse(init.body),test.envelope,`${test.label} request known-answer before decrypt`);return new Response(JSON.stringify(test.response || vectors.cases[0].response));}};
  const document={documentElement:{lang:'en'},body:{prepend(){throw new Error('unexpected guidance')}},createElement(){return {setAttribute(){},style:{}}}};
  const sessionStorage={getItem:k=>storage.get(k)||null,setItem:(k,v)=>storage.set(k,v)};
  const history={replaceState(){location.hash='';}};
  const sequence=[test.nonce,test.eph_sk,test.n].map(x=>Uint8Array.from(Buffer.from(x,'hex')));
  const crypto={getRandomValues(array){const bytes=sequence.shift();assert.equal(array.length,bytes.length);array.set(bytes);return array;}};
  const module={exports:{}};
  new Function('window','location','sessionStorage','document','navigator','crypto','history','Date','module','exports','require',code)(window,location,sessionStorage,document,{language:'en'},crypto,history,{now:()=>test.now_ms},module,module.exports,require);
  const plain=JSON.parse(test.plaintext);
  let response;
  try { response=await module.exports.sealedFetch(plain.path,plain.m==='POST'?{method:'POST',body:JSON.stringify(plain.body)}:{},{token:vectors.tokens[test.role],desk:vectors.desk_pub}); } catch(e) { if (test.response) throw e; }
  assert.equal(location.hash,'');assert.equal(calls.length,1);assert.equal(calls[0].path,'/api/scan/sealed');
  assert.deepEqual(JSON.parse(calls[0].init.body),test.envelope,`${test.label} request known-answer`);
  assert.equal(new Headers(calls[0].init.headers).has('x-playx-token'),false);
  assert.equal(calls[0].init.body.includes(vectors.tokens[test.role]),false);
  if(test.response) {
    assert.equal(response.status,test.answer.status);
    const body=await response.json();
    if(test.answer.body) assert.deepEqual(body,test.answer.body);else assert.ok(body.error);
  } else assert.equal(response,undefined,'foreign response must not decrypt for interop request');
}
// An insecure page cannot read/store/send role credentials or fall back to plain fetch.
let calls=0,guidance=0;
const module={exports:{}};
const window={isSecureContext:false,fetch:async()=>{calls++;throw new Error('plaintext fetch attempted')}};
const location={pathname:'/staff',search:'',hash:'#t='+vectors.tokens.staff+'&k='+vectors.desk_pub};
const storage={getItem(){throw new Error('insecure token read')},setItem(){throw new Error('insecure token write')}};
const document={documentElement:{lang:'en'},body:{prepend(){guidance++}},createElement(){return {setAttribute(){},style:{}}}};
new Function('window','location','sessionStorage','document','navigator','crypto','history','module','exports','require',code)(window,location,storage,document,{language:'en'},{},{replaceState(){}},module,module.exports,require);
await assert.rejects(module.exports.sealedFetch('/api/staff/refund',{}, {token:vectors.tokens.staff,desk:vectors.desk_pub}),/HTTPS/);
await assert.rejects(window.fetch('/api/staff/refund',{headers:{'x-playx-token':'synthetic'}}),/HTTPS/);
assert.equal(calls,0);assert.equal(guidance,1);
// Execute each served role screen's actual credential bootstrap in script order.
for (const [screen, role] of [['admin','owner'],['staff','staff'],['scan','scanner']]) {
  const html=readFileSync(`web/${screen}.html`,'utf8').replace(/<!--[\s\S]*?-->/g,'');
  const tags=[...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)];
  const inline=tags.find(tag=>tag[2].includes('let token = ""'));
  assert.ok(inline, `${screen} credential bootstrap exists`);
  const token=role==='scanner'?'c'.repeat(64):vectors.tokens[role],storage=new Map();
  const window={isSecureContext:true,fetch:async()=>{throw new Error('bootstrap must not send credentials')}};
  const location={pathname:`/${screen}`,search:'',hash:`#t=${token}&k=${vectors.desk_pub}`};
  const document={documentElement:{lang:'en'},body:{prepend(){}},createElement(){return{setAttribute(){},style:{}}}};
  const args=[window,location,{getItem:k=>storage.get(k)||null,setItem:(k,v)=>storage.set(k,v)},document,{language:'en'},{},{replaceState(){location.hash=''}},{exports:{}},require];
  if(tags.some(tag=>tag.index<inline.index && /src=["']\/shop-seal\.bundle\.js["']/.test(tag[1]))) {
    new Function('window','location','sessionStorage','document','navigator','crypto','history','module','require',code)(...args);
    assert.equal(window.RVShopSeal.connection().token, token);
  }
  const prefix=inline[2].slice(0,inline[2].indexOf('const H =')+inline[2].slice(inline[2].indexOf('const H =')).indexOf(';')+1);
  const headers=new Function('window','document',prefix+';return H;')(window,document);
  assert.equal(headers['x-playx-token'],token, `${screen} served bootstrap must load authenticated seal before its API calls`);
  assert.equal(location.hash,'', `${screen} credential fragment removed before API calls`);
}
console.log(`PASS: ${vectors.cases.length+vectors.interop.length} encrypted request vectors / ${vectors.cases.length} response vectors; fragment stripping, no wire token, insecure-context no-fallback; 3 served role bootstraps`);
