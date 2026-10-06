// Production startup controllers, synthetic DOM/clock/RPC only. No secrets or network.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
const read = p => readFileSync(p, 'utf8');
const compile = p => ts.transpileModule(read(p).replace(/^import .*;\n/gm, ''), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;
const sources = ['firstrun', 'ravi-panel', 'ravi-agent', 'pairing-ui'];
const compiled = Object.fromEntries(sources.map(n => [n, compile(`src/${n}.ts`)]));
const flush = async () => { for (let i=0;i<30;i++) await Promise.resolve(); };
function fixture({ keyed=false, restart=false, greetingOff=false, waiting=null }={}) {
  const nodes=new Map(), calls=[], timers=new Map(), listeners=new Map(); let now=0, serial=0;
  class Element {
    constructor(tag='div') { this.tagName=tag; this.children=[]; this.hidden=false; this.attributes={}; this.events=new Map(); this.style={}; this.value=''; this.textContent=''; this.scrollHeight=600; this.clientHeight=200; this.scrollTop=0; this.classes=new Set(); this.classList={add:n=>this.classes.add(n),remove:n=>this.classes.delete(n),contains:n=>this.classes.has(n),toggle:(n,on)=>on?this.classes.add(n):this.classes.delete(n)}; }
    set id(v){this._id=v;nodes.set(v,this);} get id(){return this._id;}
    set className(v){this.classes=new Set(v.split(' '));} get className(){return [...this.classes].join(' ');}
    append(...children){for(const child of children){child.parent=this;this.children.push(child);}}
    prepend(child){child.parent=this;this.children.unshift(child);}
    after(child){this.parent?.append(child);}
    replaceChildren(...children){this.children=[];this.append(...children);}
    remove(){if(this.parent)this.parent.children=this.parent.children.filter(c=>c!==this);this.parent=null;}
    set innerHTML(html){this.children=[];for(const m of html.matchAll(/<([\w-]+)[^>]*\bid="([^"]+)"[^>]*>/g)){const n=new Element(m[1]);n.id=m[2];n.hidden=/\bhidden\b/.test(m[0]);this.append(n);}}
    setAttribute(k,v){this.attributes[k]=v;} removeAttribute(k){delete this.attributes[k];} hasAttribute(k){return k in this.attributes;}
    addEventListener(k,f){this.events.set(k,f);} dispatchEvent(e){this.events.get(e.type)?.(e);}
    querySelector(){return null;} querySelectorAll(){return [];}
    contains(n){for(;n;n=n.parent)if(n===this)return true;return false;}
    focus(){document.activeElement=this;} scrollIntoView(){}
    get isConnected(){return !!this.parent;}
    closest(){return this;} matches(){return this.tagName==='button';}
    click(){this.onclick?.();}
  }
  const el=id=>{if(!nodes.has(id)){const n=new Element();n.id=id;}return nodes.get(id);};
  const document={body:new Element('body'),documentElement:new Element('html'),activeElement:null,getElementById:id=>nodes.get(id)||null,createElement:tag=>new Element(tag),createTextNode:text=>({textContent:text}),addEventListener:(k,f)=>listeners.set(k,f),querySelector:()=>null};
  for(const id of ['page-settings','page-wallet','ravi-tools','chat-log','ravi-panel','ravi-launcher','chat-q','ravi-new','ravi-chatwrap','ravi-expand','rv-header-ravi','ravi-open','ravi-menu-open','ravi-collapse','ravi-announcement'])document.body.append(el(id));
  const storage=new Map(restart?[['ravenvault-ravi-panel','{"open":true,"large":true}'],['rv-companion-page','ravi']]:[]);
  if(greetingOff)storage.set('rv-ravi-start-off','1');
  const session=new Map(), store=m=>({getItem:k=>m.get(k)??null,setItem:(k,v)=>m.set(k,v)});
  const schedule=(f,ms,interval=false)=>{const id=++serial;timers.set(id,{f,at:now+ms,ms,interval});return id;};
  const invoke=async(name,args)=>{
    calls.push(name);
    if(name==='ravi_consent')return {reviewed:keyed,balance:false,transactions:false,shop:false};
    if(name==='ravi_today')return {wallet:'locked'};
    if(name==='ravi_greeting')return '반가워요.';
    if(name==='pairing_waiting')return waiting;
    if(name==='pairing_state')return {ready:false,devices:[],requests:[]};
    throw Error('Unexpected startup RPC');
  };
  const ctx=vm.createContext({document,Element,HTMLElement:Element,KeyboardEvent:class{constructor(type,opts){this.type=type;Object.assign(this,opts);}},localStorage:store(storage),sessionStorage:store(session),queueMicrotask,Date,Promise,Set,Map,console,
    window:{setTimeout:(f,ms)=>schedule(f,ms),setInterval:(f,ms)=>schedule(f,ms,true),addEventListener(){},confirm(){throw Error('Automatic confirm forbidden');}},clearTimeout:id=>timers.delete(id),setTimeout:(f,ms)=>schedule(f,ms),
    MutationObserver:class{observe(){}},ResizeObserver:class{observe(){}},raviFace:()=>new Element('svg'),containsRaviSecret:()=>false,invoke,t:s=>s,tf:(s,...a)=>s.replace(/\{(\d+)\}/g,(_,i)=>a[i]),copyHtml:s=>s,setCopyText:(el,render)=>{el.textContent=render();}});
  const modules={};for(const name of sources){ctx.exports={};vm.runInContext(`{const exports = globalThis.exports; ${compiled[name]}\n}`,ctx);modules[name]=ctx.exports;}
  const gate=modules.firstrun;gate.installFirstRunBarrier();
  const panel=modules['ravi-panel'].createRaviPanel(()=>{},()=>{},gate.afterRaviLanding);
  let keys=0;const agent=modules['ravi-agent'].createRaviAgentUI({invoke,keyed:()=>keyed?'fixture-provider':null,key:()=>keys++,dock:()=>panel.open(),tz:()=>0,landed:gate.finishRaviLanding,afterLanding:gate.afterRaviLanding});
  modules['pairing-ui'].wirePairing();agent.start();
  const advance=async ms=>{const end=now+ms;while(true){const entry=[...timers].filter(([,t])=>t.at<=end).sort((a,b)=>a[1].at-b[1].at)[0];if(!entry)break;const [id,t]=entry;now=t.at;timers.delete(id);if(t.interval)timers.set(id,{...t,at:now+t.ms});t.f();await flush();}now=end;await flush();};
  const walk=n=>[n,...(n.children||[]).flatMap(walk)];
  return {ctx,agent,panel,gate,el,calls,document,listeners,advance,walk,get keys(){return keys;}};
}
let count=0;
for(const restart of [false,true])for(const keyed of [false,true]) {
  const f=fixture({restart,keyed});await flush();f.agent.start();
  assert.ok(f.document.documentElement.hasAttribute('data-ravi-arriving'),'duplicate start cannot release flight barrier');
  assert.equal(f.panel.visible(),false);
  const bubble=f.walk(f.document.body).find(n=>n.className==='ravi-arrival-bubble');assert.equal(bubble.hidden,true);
  await f.advance(1699);assert.equal(f.panel.visible(),false);assert.equal(bubble.hidden,true);
  await f.advance(401);assert.equal(bubble.hidden,false);assert.equal(f.panel.visible(),false);
  await f.advance(60000);assert.equal(f.panel.visible(),false,'greeting timeout and polling never open conversation');
  assert.equal(f.el('rvp-card').hidden,true);assert.equal(f.el('rvp-notice').hidden,true);assert.equal(f.keys,0);
  assert.ok(!f.calls.includes('pairing_request_open'));assert.ok(!f.calls.includes('pairing_show_qr'));
  f.el('ravi-launcher').click();assert.equal(f.panel.visible(),true,'explicit click still opens');
  count++;
}
for(const waiting of [{requests:0,pending:true,guestqr:[]},{requests:1,pending:false,guestqr:['synthetic-request']}]){
  const f=fixture({waiting});await f.advance(30000);
  assert.equal(f.el('rvp-notice').hidden,false,'only genuine pending requests notify');assert.equal(f.el('rvp-card').hidden,true);
  assert.ok(!f.calls.includes('pairing_request_open'));assert.ok(!f.calls.includes('pairing_request_done'));assert.equal(f.panel.visible(),false);
  f.el('rvp-connect-wallet').click();assert.equal(f.el('rvp-card').hidden,false,'wallet phone-connect button opens settings card');
}
{
  const f=fixture();let recovery=0;f.gate.afterRaviLanding(()=>recovery++);f.panel.open();
  await f.advance(1699);assert.equal(recovery,0);assert.equal(f.panel.visible(),false);
  await f.advance(401);assert.equal(recovery,1);assert.equal(f.panel.visible(),true,'explicit requests drain only after landing');
}
{
  const f=fixture();await flush();const bird=f.walk(f.document.body).find(n=>n.className==='ravi-arrival-bird');
  bird.onclick();assert.equal(f.panel.visible(),false);await f.advance(2100);assert.equal(f.panel.visible(),true);
}
{
  const f=fixture({greetingOff:true,restart:true});await f.advance(60000);
  assert.equal(f.panel.visible(),false);assert.equal(f.document.documentElement.hasAttribute('data-ravi-arriving'),false);
}
{
  const f=fixture();let prevented=0;
  f.listeners.get('click')({target:f.el('ravi-launcher'),preventDefault(){prevented++;},stopImmediatePropagation(){}});
  assert.equal(prevented,1);assert.equal(f.panel.visible(),false);
  await f.advance(2100);assert.equal(f.panel.visible(),true,'captured clicks replay after landing');
}
{
  const f=fixture();let prevented=0;
  f.listeners.get('keydown')({target:f.el('chat-q'),key:' ',preventDefault(){prevented++;},stopImmediatePropagation(){}});
  f.listeners.get('keydown')({target:f.el('chat-q'),key:'Enter',shiftKey:true,preventDefault(){prevented++;},stopImmediatePropagation(){}});
  assert.equal(prevented,0,'ordinary spaces and Shift+Enter retain editing behavior');
}
// The real shared modal entry points must defer state and focus, not just paint.
const mainAst=ts.createSourceFile('main.ts',read('src/main.ts'),ts.ScriptTarget.Latest,true);
for(const name of ['ask','sure','choose','say']) {
  const f=fixture();Object.assign(f.ctx, {$:f.el, afterRaviLanding:f.gate.afterRaviLanding});
  const source=mainAst.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text===name).getText(mainAst);
  vm.runInContext('let askResolve = null; const ASK_ALT = "alternate"; '+ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,f.ctx);
  f.ctx[name]('Fixture title','Fixture message');
  assert.equal(f.el('askwrap').classList.contains('on'),false);
  await f.advance(2100);assert.equal(f.el('askwrap').classList.contains('on'),true);
}
// Integration invariants cover bootstrap paths outside the isolated controllers.
const main=read('src/main.ts'),css=read('src/ravi-home.css');
assert.match(main,/installFirstRunBarrier\(\)/);
assert.match(main,/showPage\(restoredPage === "ravi" \? "home" : restoredPage\)/);
assert.match(main,/afterRaviLanding\(\(\) => wordsRestore.checkOnStart\(\)\)/);
assert.doesNotMatch(main,/if \(!localStorage.getItem\(ONBOARD_KEY\)\)\s*\{\s*startOnboard/);
const mode=main.slice(main.indexOf('async function applyMode'),main.indexOf('let helpTimer'));
assert.doesNotMatch(mode,/hello.style.display = ""/);
for(const id of ['askwrap','rpwrap','onboard','hello','send-review','qrwrap','ravi-panel','ravi-key','rvp-notice','phone-tx-send']) assert.ok(css.slice(css.indexOf('html[data-ravi-arriving]')).includes('#'+id));
assert.match(read('src/ravi-companion.ts'),/if \(on\) await new Promise<void>\(resolve => afterRaviLanding\(resolve\)\)/);
assert.match(read('.github/workflows/release.yml'),/npm run check:pre-release/);
console.log(`PASS first-run: ${count} fresh/restart × no-key/key scenarios; flight barrier, timeout, saved-open, opt-out, explicit clicks, recovery queue, pending/guest notifications; no live services`);

// Optional rendered full-app pass: npm run build && node scripts/check-firstrun.mjs --browser
// Request interception serves dist from memory; no HTTP listener or live native app.
if (process.argv.includes('--browser')) {
  const {default:puppeteer}=await import('puppeteer-core');
  const {existsSync,mkdtempSync,rmSync}=await import('node:fs');
  const {resolve,extname}=await import('node:path');
  const {tmpdir}=await import('node:os');
  const profile=mkdtempSync(resolve(tmpdir(),'rv-firstrun-browser-'));
  const dist=resolve('dist'),origin='http://firstrun.test';let browser;
  try {
    browser=await puppeteer.launch({executablePath:process.env.CHROME_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true,userDataDir:profile});
    for(const restart of [false,true])for(const keyed of [false,true]) {
      const context=await browser.createBrowserContext(),page=await context.newPage(),errors=[];
      page.on('pageerror',e=>errors.push(e.name));
      await page.setRequestInterception(true);
      page.on('request',r=>{
        if(!r.url().startsWith(origin+'/')){void r.abort();return;}
        const pathname=new URL(r.url()).pathname,file=resolve(dist,'.'+(pathname==='/'?'/index.html':pathname));
        if(!file.startsWith(dist+'/')||!existsSync(file)){void r.respond({status:404,body:''});return;}
        void r.respond({status:200,contentType:({'.html':'text/html','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml','.webp':'image/webp'})[extname(file)]||'application/octet-stream',body:readFileSync(file)});
      });
      await page.evaluateOnNewDocument(({restart,keyed})=>{
        localStorage.clear();sessionStorage.clear();localStorage.setItem('playx-raven-lang','ko');
        if(restart){localStorage.setItem('ravenvault-ravi-panel','{"open":true,"large":true}');localStorage.setItem('rv-companion-page','ravi');localStorage.setItem('playx-onboarded','1');}
        window.__FIRST_CALLS=[];
        window.__TAURI_INTERNALS__={invoke:async(command)=>{
          window.__FIRST_CALLS.push(command);
          if(command==='api_key_status')return keyed?{available:{openai:true},has_key:{openai:true},last4:{openai:'TEST'}}:{};
          if(command==='node_status')return {blocks:1000,headers:1000,progress:1,peers:3};
          if(command==='wallet_balance')return {confirmed:0,unconfirmed:0};
          if(command==='mode_get')return {chosen:restart,mode:restart?'wallet':''};
          if(command==='ravi_today')return {wallet:'locked'};
          if(command==='ravi_consent')return {reviewed:false,balance:false,transactions:false,shop:false};
          if(command==='pairing_waiting')return {requests:0,pending:false,guestqr:[]};
          if(command==='pairing_state')return {ready:false,devices:[],requests:[]};
          if(command==='plugin:app|version')return '0.8.0';
          if(command==='backup_survey')return {items:[],automatic:null};
          if(command==='model_settings')return {};
          if(['list_assets','pin_list','my_channels'].includes(command))return [];
          return null;
        },transformCallback:f=>f,metadata:{}};
        // Observe every painted frame, including the first one, without recording content.
        window.__FIRST_POPUPS=[];
        const sample=()=>{
          const selectors=['.sheet:not(.hidden)','#askwrap.on','#hello','#onboard:not(.hidden)','#qrwrap','#rpwrap','#ravi-panel','#chat.on','dialog[open]'];
          for(const selector of selectors)if([...document.querySelectorAll(selector)].some(el=>el.getClientRects().length))window.__FIRST_POPUPS.push(selector);
          window.__FIRST_FRAME=requestAnimationFrame(sample);
        };requestAnimationFrame(sample);
      },{restart,keyed});
      await page.goto(origin,{waitUntil:'networkidle0'});
      await page.waitForFunction(()=>!document.documentElement.hasAttribute('data-ravi-arriving'));
      await page.waitForFunction(()=>!document.querySelector('.ravi-arrival'),{timeout:25000});
      assert.deepEqual(await page.evaluate(()=>[...new Set(window.__FIRST_POPUPS)]),[],'no painted popup during flight, landing, greeting, expiry or saved-page restore');
      assert.deepEqual(errors,[]);
      assert.equal(await page.evaluate(()=>window.__FIRST_CALLS.some(n=>['pairing_request_open','pairing_show_qr','send_rvn','send_asset'].includes(n))),false);
      await page.evaluate(()=>cancelAnimationFrame(window.__FIRST_FRAME));
      await page.click('#ravi-launcher');
      assert.equal(await page.$eval('#ravi-panel',el=>!!el.getClientRects().length),true);
      await context.close();
    }
    console.log('PASS rendered full-app first-run matrix (synthetic services only)');
  } finally {await browser?.close();rmSync(profile,{recursive:true,force:true});}
}
