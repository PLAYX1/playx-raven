import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {webcrypto} from 'node:crypto';
import {build} from 'esbuild';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const fixture=JSON.parse(readFileSync('src-tauri/testdata/rv-shop-seal-vectors.json','utf8'));
const bundle=await build({entryPoints:['web/shop-seal.src.ts'],bundle:true,format:'cjs',platform:'node',write:false});
const cryptoBundle=await build({stdin:{contents:`import {x25519} from '@noble/curves/ed25519';import {hkdf} from '@noble/hashes/hkdf';import {sha256} from '@noble/hashes/sha256';import {hexToBytes,bytesToHex,concatBytes,utf8ToBytes} from '@noble/hashes/utils';import {xchacha20poly1305} from '@noble/ciphers/chacha.js';export {x25519,hkdf,sha256,hexToBytes,bytesToHex,concatBytes,utf8ToBytes,xchacha20poly1305};`,resolveDir:process.cwd()},bundle:true,format:'cjs',platform:'node',write:false});
const lib={exports:{}};new Function('module','exports','require',cryptoBundle.outputFiles[0].text)(lib,lib.exports,require);
const {x25519,hkdf,sha256,hexToBytes,bytesToHex,concatBytes,utf8ToBytes,xchacha20poly1305}=lib.exports;
const html=readFileSync('web/staff.html','utf8');
const block=html.slice(html.indexOf('      const rfLabel ='),html.indexOf('      const NEXT ='));
assert.ok(block.includes('refundRequestId'));
const key='rv-refund-pending';
function harness(saved) {
  const storage=new Map(saved?[[key,JSON.stringify(saved)]]:[]),requests=[],answers=[];
  const elements=new Map();
  const $=id=>{if(!elements.has(id))elements.set(id,{value:'',textContent:'',disabled:false,addEventListener(){},replaceChildren(d){this.textContent=d.textContent;}});return elements.get(id);};
  const document={documentElement:{lang:'en'},body:{prepend(){throw new Error('unexpected connection warning')}},createElement(){return{setAttribute(){},style:{}}}};
  const sessionStorage={getItem:k=>storage.get(k)||null,setItem:(k,v)=>storage.set(k,v),removeItem:k=>storage.delete(k)};
  const window={isSecureContext:true,fetch:async(path,init)=>{
    assert.equal(path,'/api/scan/sealed');assert.equal(new Headers(init.headers).has('x-playx-token'),false);
    const env=JSON.parse(init.body),eph=hexToBytes(env.eph),n=hexToBytes(env.n),desk=hexToBytes(fixture.desk_pub);
    const shared=x25519.getSharedSecret(hexToBytes(fixture.desk_sk),eph);
    const secret=hkdf(sha256,shared,sha256(utf8ToBytes(fixture.tokens.staff)),utf8ToBytes('rv-shop-seal-v1'),32);
    const decoded=JSON.parse(new TextDecoder().decode(xchacha20poly1305(secret,n,concatBytes(utf8ToBytes('rv-shop-seal-v1/req'),eph,desk)).decrypt(hexToBytes(env.ct))));
    assert.equal(decoded.path,'/api/staff/refund');requests.push(decoded.body);
    const answer=answers.shift();assert.ok(answer,'unexpected automatic retry');
    if(answer.throw)throw new Error(answer.throw);
    if(answer.plain)return new Response(JSON.stringify(answer.plain),{status:401});
    const body=typeof answer.body==='function'?answer.body(decoded.body):answer.body;
    const nonce=webcrypto.getRandomValues(new Uint8Array(24));
    const ct=xchacha20poly1305(secret,nonce,concatBytes(utf8ToBytes('rv-shop-seal-v1/res'),eph,n)).encrypt(utf8ToBytes(JSON.stringify({v:1,status:answer.status||400,body})));
    return new Response(JSON.stringify({v:1,n:bytesToHex(nonce),ct:bytesToHex(ct)}));
  }};
  const location={pathname:'/staff',search:'',hash:`#t=${fixture.tokens.staff}&k=${fixture.desk_pub}`};
  const history={replaceState(){location.hash='';}},module={exports:{}};
  new Function('window','location','sessionStorage','document','navigator','crypto','history','module','exports','require',bundle.outputFiles[0].text)(window,location,sessionStorage,document,{language:'en'},webcrypto,history,module,module.exports,require);
  const api=(path,body)=>window.fetch(path,{method:'POST',headers:{'content-type':'application/json','x-playx-token':fixture.tokens.staff},body:JSON.stringify(body)}).then(r=>r.json());
  const rfT=(s,...args)=>s.replace(/\{(\d+)\}/g,(_,i)=>args[i]);
  new Function('$','window','sessionStorage','crypto','document','api','rfT','money','loadLimits',`let rfCur='USD';${block}`)($,window,sessionStorage,webcrypto,document,api,rfT,n=>`${n} USD`,()=>{});
  return {storage,requests,answers,$,pending:()=>JSON.parse(storage.get(key)||'null'),click:()=>$('rf-go').onclick(),fill(to='wrong-payer',amount='20'){$('rf-order').value='original-order';$('rf-to').value=to;$('rf-krw').value=amount;$('rf-why').value='synthetic reason';}};
}
function notSent(b){return{error:'recipient mismatch',refund_outcome:'not_sent',request_id:b.request_id,request:{order_address:b.order_address,to:b.to,amount:b.krw,reason:b.reason}};}
const cases={
  async cancelled(){
    const h=harness();h.fill();h.answers.push({body:notSent});await h.click();
    assert.equal(h.pending(),null,'authenticated matching pre-send cancellation must release pending ID');
    h.fill('correct-payer');h.answers.push({status:200,body:{amount:20,currency:'USD',rvn:5,left:60,result:{txid:'a'.repeat(64)}}});await h.click();
    assert.notEqual(h.requests[0].request_id,h.requests[1].request_id,'correction must use a fresh manual request ID');
    assert.equal(h.requests.length,2);assert.equal(h.pending(),null);assert.match(h.$('rf-result').textContent,/20 USD.*5 RVN/);
  },
  async uncertain(){
    for(const answer of [{throw:'synthetic lost response'},{body:{error:'[SENT_UNKNOWN] synthetic send timeout'}},{body:{error:'synthetic storage failure'}},{body:{error:'already completed'}},{plain:{error:'recipient mismatch',refund_outcome:'not_sent'}}]){
      const h=harness();h.fill('correct-payer');h.answers.push(answer);await h.click();assert.ok(h.pending(),'uncertain/send/storage/completed/plain outer response must preserve intent');assert.equal(h.requests.length,1);
      const saved=h.pending(),reload=harness(saved);assert.deepEqual(reload.pending(),saved);assert.equal(reload.$('rf-to').value,'correct-payer');
    }
  },
  async edited(){
    const h=harness();h.fill('correct-payer');h.answers.push({throw:'synthetic timeout'});await h.click();const pending=h.pending();
    h.fill('edited-payer','21');h.answers.push({body:notSent});await h.click();
    assert.deepEqual(h.pending(),pending,'edited retry must preserve the original uncertain intent and cannot release it');
    h.$('rf-krw').value='bad';await h.click();assert.deepEqual(h.pending(),pending,'invalid local input must keep uncertain intent');
  },
  async mismatched(){
    for(const change of [b=>({...notSent(b),request_id:'f'.repeat(32)}),b=>({...notSent(b),request:{...notSent(b).request,amount:21}}),b=>({...notSent(b),request:{...notSent(b).request,reason:'other'}})]){
      const h=harness();h.fill();h.answers.push({body:change});await h.click();assert.ok(h.pending(),'unbound not_sent response cannot release intent');
    }
  },
  async cancelledReload(){
    const saved={id:'e'.repeat(32),order:'original-order',to:'wrong-payer',krw:20,reason:'synthetic reason'};
    const h=harness(saved);h.answers.push({body:notSent});await h.click();assert.equal(h.pending(),null,'matching persisted cancellation can resolve lost pre-send response after reload');
  }
};
const selected=process.argv.find(a=>a.startsWith('--case='))?.slice(7);
for(const [name,run] of Object.entries(cases)){if(selected&&selected!==name)continue;await run();console.log(`PASS staff refund ${name}`);}

// Optional isolated Chromium evidence. The only HTTP server and credentials are
// synthetic; all requests outside its loopback origin are blocked.
if(process.argv.includes('--visual')) {
  const {createServer}=await import('node:http');
  const {mkdirSync,mkdtempSync,writeFileSync}=await import('node:fs');
  const {default:puppeteer}=await import('puppeteer-core');
  const artifact='artifacts/desktop-security';
  const fixtureRoot='/Users/gimmusong/rv-test-fixture';
  const profile=mkdtempSync(fixtureRoot+'/refund-browser-');
  const server=createServer(async(req,res)=>{
    try {
      const path=new URL(req.url,'http://127.0.0.1').pathname;
      if(path==='/api/scan/sealed'){
        let raw='';for await(const chunk of req)raw+=chunk;
        const e=JSON.parse(raw),ep=hexToBytes(e.eph),n=hexToBytes(e.n),desk=hexToBytes(fixture.desk_pub);
        const secret=hkdf(sha256,x25519.getSharedSecret(hexToBytes(fixture.desk_sk),ep),sha256(utf8ToBytes(fixture.tokens.staff)),utf8ToBytes('rv-shop-seal-v1'),32);
        const opened=JSON.parse(new TextDecoder().decode(xchacha20poly1305(secret,n,concatBytes(utf8ToBytes('rv-shop-seal-v1/req'),ep,desk)).decrypt(hexToBytes(e.ct))));
        let status=200,body={};
        if(opened.path==='/api/staff/refund/limits')body={once:25,day:80,used:0,left:80,currency:'USD'};
        else if(opened.path==='/api/staff/refund'){status=400;body=notSent(opened.body);}
        else if(opened.path==='/api/admin/orders')body=[];
        const nonce=webcrypto.getRandomValues(new Uint8Array(24));
        const ct=xchacha20poly1305(secret,nonce,concatBytes(utf8ToBytes('rv-shop-seal-v1/res'),ep,n)).encrypt(utf8ToBytes(JSON.stringify({v:1,status,body})));
        res.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify({v:1,n:bytesToHex(nonce),ct:bytesToHex(ct)}));return;
      }
      const allowed={'/staff':['web/staff.html','text/html'],'/shop-seal.bundle.js':['web/shop-seal.bundle.js','application/javascript'],'/i18n.js':['web/i18n.js','application/javascript'],'/ravi.js':['web/ravi.js','application/javascript'],'/raven-head.webp':['web/raven-head.webp','image/webp'],'/raven-sleep.webp':['web/raven-sleep.webp','image/webp']};
      if(!allowed[path]){res.writeHead(404).end();return;}
      const [file,type]=allowed[path];res.writeHead(200,{'content-type':type}).end(readFileSync(file));
    } catch(error){res.writeHead(500).end('synthetic harness failure');}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const origin=`http://127.0.0.1:${server.address().port}`;
  let browser;const measurements=[];
  try {
    browser=await puppeteer.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true,userDataDir:profile,args:['--disable-background-networking','--disable-component-update','--disable-sync','--no-first-run']});
    for(const lang of ['ko','en','ja','zh']){
      const page=await browser.newPage();await page.setViewport({width:390,height:1000,deviceScaleFactor:1});
      await page.setRequestInterception(true);page.on('request',r=>r.url().startsWith(origin+'/')?r.continue():r.abort());
      await page.evaluateOnNewDocument(lang=>localStorage.setItem('playx-raven-lang',lang),lang);
      await page.goto(`${origin}/staff#t=${fixture.tokens.staff}&k=${fixture.desk_pub}`,{waitUntil:'networkidle0'});
      await page.click('[data-p="refund"]');
      await page.waitForFunction(()=>document.getElementById('rf-amt-l').textContent.includes('USD'));
      await page.type('#rf-order','synthetic-order');await page.type('#rf-to','wrong-payer');await page.type('#rf-krw','20');
      await page.click('#rf-go');
      await page.waitForFunction(()=>document.getElementById('rf-result').textContent.length>0&&!document.getElementById('rf-go').disabled);
      assert.equal(await page.evaluate(()=>sessionStorage.getItem('rv-refund-pending')),null);
      const measure=await page.evaluate(()=>{
        const size=id=>{const el=document.getElementById(id),box=el.getBoundingClientRect(),css=getComputedStyle(el);return{font:Number.parseFloat(css.fontSize),width:box.width,height:box.height};};
        return{lang:window.PXLANG,overflow:Math.max(document.documentElement.scrollWidth,document.body.scrollWidth)-innerWidth,result:size('rf-result'),label:size('rf-amt-l'),input:size('rf-krw'),button:size('rf-go'),currency:document.getElementById('rf-amt-l').textContent};
      });
      assert.equal(measure.lang,lang);assert.equal(measure.overflow,0);assert.ok(measure.result.font>=15);assert.ok(measure.label.font>=13);assert.ok(measure.input.font>=16);assert.ok(measure.button.height>=44);
      await page.screenshot({path:`${artifact}/refund-cancelled-390-${lang}.png`,fullPage:true});measurements.push(measure);await page.close();
    }
    writeFileSync(`${artifact}/refund-layout.json`,JSON.stringify(measurements,null,2)+'\n');
    console.log('PASS isolated staff refund UI: ko/en/ja/zh, 390px overflow 0, authenticated cancellation; screenshots and measured existing sizes');
  } finally {if(browser)await browser.close();await new Promise(resolve=>server.close(resolve));}
}
