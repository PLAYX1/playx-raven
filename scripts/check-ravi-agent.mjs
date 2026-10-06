// Production controller + Rust loop, with synthetic data only. No live AI/RPC.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import { build } from 'esbuild';

const out = 'artifacts/agent1'; mkdirSync(out, { recursive: true });
const source = readFileSync('src/ravi-agent.ts', 'utf8').replace(/\r\n/g, '\n');
const compiled = ts.transpileModule(source.replace(/^import .*;\n/gm, ''), {
  compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS },
}).outputText;
const guideBundle = await build({ entryPoints: ['src/ravi-guide.ts'], bundle: true, platform: 'node', format: 'cjs', write: false });
const guideContext = { module: { exports: {} }, exports: {} }; vm.runInNewContext(guideBundle.outputFiles[0].text, guideContext);
const secret = guideContext.module.exports.containsRaviSecret;
const storage = () => { const m = new Map(); return { getItem: k => m.get(k) ?? null, setItem: (k,v) => m.set(k,v) }; };
const defaultConsent = () => ({ reviewed: false, balance: false, transactions: false, shop: false });
const flush = async () => { for (let i=0;i<20;i++) await Promise.resolve(); };
function fixture({ keyed = false, consent = defaultConsent(), local = storage(), session = storage(), today = {wallet:'locked'}, failSave = false } = {}) {
  class Element {
    constructor(tag) { this.tagName=tag; this.children=[]; this.attributes={}; this.textContent=''; this.hidden=false; this.classes=new Set(); this.classList={ add: v=>this.classes.add(v) }; }
    append(...children) { for (const c of children) { c.parent=this; this.children.push(c); } }
    replaceChildren(...children) { this.children=[]; this.append(...children); }
    remove() { if (this.parent) this.parent.children=this.parent.children.filter(c=>c!==this); }
    setAttribute(k,v) { this.attributes[k]=v; }
    scrollIntoView() {}
    addEventListener() {}
  }
  const nodes = new Map(['page-settings','ravi-tools','chat-log'].map(id=>[id,new Element('div')]));
  const body=new Element('body'), timers=new Map(), calls=[]; let serial=0, docks=0, keys=0;
  const document={body,getElementById:id=>nodes.get(id),createElement:tag=>new Element(tag),createTextNode:text=>({textContent:text})};
  const exports={};
  vm.runInNewContext(compiled,{ exports, document, localStorage:local,sessionStorage:session,
    raviFace:()=>new Element('svg'),containsRaviSecret:secret,
    window:{setTimeout:(f,delay)=>{timers.set(++serial,{f,delay});return serial;}},clearTimeout:id=>timers.delete(id),
  });
  const api={ keyed:()=>keyed?'synthetic-provider':null,key:()=>keys++,dock:()=>docks++,tz:()=>540,
    async invoke(name,args) {
      calls.push({name,args});
      if(name==='ravi_consent')return {...consent};
      if(name==='ravi_consent_save'){if(failSave)throw 'synthetic save failure';consent={...args.consent};return;}
      if(name==='ravi_today')return today;
      if(name==='ravi_greeting')return '오늘도 반가워요.';
      if(name==='ravi_tool')return {status:'locked'};
      if(name==='ravi_audit')return [{name:'wallet_balance',at:100,success:true},{name:'untrusted-name',at:101,success:false}];
      throw Error('Unexpected mock command');
    },
  };
  return {exports,api,body,nodes,timers,calls,local,session,get docks(){return docks;},get keys(){return keys;}};
}
const walk = n => [n,...(n.children||[]).flatMap(walk)];
const button = (n,text) => walk(n).find(x=>x.tagName==='button'&&x.textContent===text);
const textOf = n => walk(n).map(x=>x.textContent).join('\n');

let f=fixture();
assert.equal(f.exports.shouldGreet(f.local,f.session),true);
assert.equal(f.exports.shouldGreet(f.local,f.session),false);
let fresh=fixture({session:f.session}); assert.equal(fresh.exports.shouldGreet(fresh.local,fresh.session),false,'session survives controller reload');
f=fixture(); f.local.setItem(f.exports.GREETING_OFF,'1'); assert.equal(f.exports.shouldGreet(f.local,f.session),false);
f.local.setItem(f.exports.GREETING_OFF,'0'); assert.equal(f.exports.shouldGreet(f.local,f.session),true);
f=fixture();const unavailable={getItem(){throw Error('disabled');},setItem(){throw Error('disabled');}};
assert.equal(f.exports.shouldGreet(unavailable,unavailable),true);assert.equal(f.exports.shouldGreet(unavailable,unavailable),false);
assert.equal(f.exports.todayLines({wallet:'locked',wallet_balance:{confirmed:123}}).length,1);
assert.ok(!f.exports.todayLines({wallet:'locked',wallet_balance:{confirmed:123}}).join('').includes('123'));
assert.match(f.exports.todayLines({}).join(''),/데이터 없음/);
assert.match(f.exports.todayLines({wallet:'open',wallet_balance:{status:'ok',confirmed:12.5},shop_sales:{status:'ok',total:300,currency:'KRW'},shop_orders:{counts:{paid_today:2}},node_status:{status:'ok',synced:true},backup_status:{last_success_at:100}}).join(''),/12\.5 RVN/);
assert.ok(!f.exports.todayLines({wallet:'open'}).join('').includes('0 RVN'));
console.log('PASS arrival once/session, opt-out, storage failure fallback, truthful and locked summaries');

f=fixture();let ui=f.exports.createRaviAgentUI(f.api);await flush();ui.start();ui.start();await flush();
assert.equal(f.body.children.length,1); assert.match(textOf(f.body),/짜잔! 오늘 어땠어요/);assert.match(textOf(f.body),/잠금을 풀면/);
assert.ok(!f.calls.some(c=>c.name==='ravi_greeting'));
const toolButtons=walk(f.nodes.get('ravi-tools')).filter(n=>n.tagName==='button');assert.equal(toolButtons.length,8);
for (const b of toolButtons){b.onclick();await flush();}
assert.equal(f.calls.filter(c=>c.name==='ravi_tool').length,8);
assert.ok(!f.calls.some(c=>c.name.startsWith('ai_')||c.name==='ravi_agent_chat'));
button(f.body,'AI 열쇠를 넣으면 더 많은 걸 해 드려요').onclick();
assert.equal(f.keys,1);assert.equal(f.docks,1);assert.ok(f.body.children[0].classes.has('docking'));
[...f.timers.values()].find(t=>t.delay===360).f();assert.equal(f.docks,1);assert.equal(f.body.children.length,0);

f=fixture({keyed:true,consent:{reviewed:true,balance:false,transactions:false,shop:false}});ui=f.exports.createRaviAgentUI(f.api);ui.start();await flush();
assert.equal(f.calls.filter(c=>c.name==='ravi_greeting').length,1,'waits for persisted consent before greeting');
assert.match(textOf(f.body),/오늘도 반가워요/);assert.equal(button(f.body,'AI 열쇠를 넣으면 더 많은 걸 해 드려요').hidden,true);
[...f.timers.values()].find(t=>t.delay===2100).f();[...f.timers.values()].find(t=>t.delay===18000).f();[...f.timers.values()].find(t=>t.delay===360).f();assert.equal(f.docks,0,'timeout never opens conversation');

f=fixture({keyed:true});ui=f.exports.createRaviAgentUI(f.api);await flush();let resolved=false;const pending=ui.ensureConsent().then(v=>resolved=v);await flush();
assert.equal(resolved,false);const card=f.nodes.get('chat-log');assert.match(textOf(card),/라비에게 보여 줄 정보/);
const checks=walk(card).filter(n=>n.tagName==='input');assert.equal(checks.length,3);assert.ok(checks.every(c=>!c.checked));
checks[0].checked=true;button(card,'선택 저장').onclick();await pending;
assert.equal(resolved,true);assert.equal(f.calls.find(c=>c.name==='ravi_consent_save').args.consent.transactions,false);
await flush();const settings=f.nodes.get('page-settings');button(settings,'라비 도구 사용 기록 보기').onclick();await flush();
assert.match(textOf(settings),/wallet_balance/);assert.match(textOf(settings),/rejected/);assert.ok(!textOf(settings).includes('untrusted-name'));
const off=walk(settings).find(n=>n.tagName==='label'&&textOf(n).includes('시작 인사 끄기')).children[0];off.checked=true;off.onchange();assert.equal(f.local.getItem(f.exports.GREETING_OFF),'1');

f=fixture({failSave:true});ui=f.exports.createRaviAgentUI(f.api);await flush();let settled=false;const cancelled=ui.ensureConsent().then(v=>{settled=true;return v;});await flush();
button(f.nodes.get('chat-log'),'선택 저장').onclick();await flush();assert.equal(settled,false);
assert.match(textOf(f.nodes.get('chat-log')),/저장하지 못했어요/);button(f.nodes.get('chat-log'),'지금은 취소').onclick();assert.equal(await cancelled,false);
console.log('PASS production UI: offline tools, key card, greeting consent, opt-in defaults/save failure/cancel, settings and audit');

const mainSource=readFileSync('src/main.ts','utf8'),ast=ts.createSourceFile('main.ts',mainSource,ts.ScriptTarget.Latest,true);
const fn=name=>ast.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text===name).getText(ast);
let dispatched=[],actions=[],messages=[],allowed=true;
const ctx=vm.createContext({raviAgentUI:{ensureConsent:async()=>allowed},document:{createElement:()=>({setAttribute(){},remove(){}})},$:()=>({append(){}}),Channel:class{},TOOL_LABELS:f.exports.TOOL_LABELS,aiProvider:'synthetic',tzMin:()=>540,
  containsRaviSecret:secret,chatSay:(who,text)=>messages.push({who,text}),raviOpenScreen:s=>actions.push(s),openRaviPromo:async()=>actions.push('promo'),
  applyActions:(a,q)=>{actions.push({a,q});return ['준비'];},invoke:async(cmd,args)=>{dispatched.push(cmd);args.progress.onmessage('wallet_balance');return {reply:'확인할 화면을 준비했어요',prepared:[{name:'prepare_send',args:{address:'R111111111111111111111111111111111',amount:1}}]};},
});
vm.runInContext(ts.transpileModule(fn('chatAgent'),{compilerOptions:{target:ts.ScriptTarget.ES2020}}).outputText,ctx);
await ctx.chatAgent('직접 요청');assert.deepEqual(dispatched,['ravi_agent_chat']);assert.equal(actions[0].a[0].type,'send_prepare');assert.equal(actions[0].q,'직접 요청');
allowed=false;dispatched=[];await ctx.chatAgent('취소');assert.equal(dispatched.length,0);
assert.ok(!/invoke\([^\n]*(?:send_rvn|send_asset|walletpassphrase)/.test(fn('chatAgent')));
assert.ok(mainSource.includes('raviAgentUI?.start();'),'arrival starts independently of provider availability');
const css=readFileSync('src/ravi-home.css','utf8'),html=readFileSync('index.html','utf8');
assert.match(css,/@media\(prefers-reduced-motion:reduce\)[\s\S]*\.ravi-arrival-bird[\s\S]*animation:ravi-hello/);
assert.match(html,/\.rv-lid\s*\{[^}]*transform:scaleY\(0\)/);
console.log('PASS chat integration passes only preparation actions, consent blocks dispatch, reduced-motion fade and folded eyelid invariant');

const report={vm:'passed',rust:'not_run',browser:'not_run',realAI:false,realRPC:false};
const rust=spawnSync('cargo',['test','--manifest-path','src-tauri/Cargo.toml','ravi_agent::tests'],{encoding:'utf8',env:{...process.env,RV_BACKUP_FIXTURE_ROOT:process.env.RV_BACKUP_FIXTURE_ROOT||join(tmpdir(),'rv-test-fixture')},timeout:240000,maxBuffer:8*1024*1024});
if(rust.status!==0){report.rust='failed';writeFileSync(join(out,'agent-check.json'),JSON.stringify(report,null,2)+'\n');throw Error('Rust agent tests failed; run cargo test ravi_agent::tests for diagnostics');}
report.rust=(rust.stdout.match(/test result: ok\.[^\n]*/)||[])[0]||'passed';console.log('PASS '+report.rust);

// Optional real geometry check; a launch failure is explicitly UNVERIFIED, never PASS.
const profile=mkdtempSync(join(tmpdir(),'rv-agent-browser-'));let browser;
try {
  const {default:puppeteer}=await import('puppeteer-core');
  try { browser=await puppeteer.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true,userDataDir:profile,timeout:15000}); }
  catch { report.browser='미검증: Chrome 실행 실패';console.log(report.browser); }
  if(browser){
    const page=await browser.newPage();await page.setViewport({width:1280,height:800});
    await page.setRequestInterception(true);page.on('request',r=>void r.abort());
    await page.emulateMediaFeatures([{name:'prefers-reduced-motion',value:'reduce'}]);
    await page.setContent(`<style>${css}</style><aside class="ravi-arrival"><div class="ravi-arrival-bird">라비</div><div class="ravi-arrival-bubble"><strong>짜잔! 오늘 어땠어요?</strong><p>지갑이 잠겨 있어요. 잠금을 풀면 더 알려 드릴게요.</p></div></aside>`);
    const geometry=await page.$eval('.ravi-arrival',el=>{const r=el.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,animation:getComputedStyle(el.querySelector('.ravi-arrival-bird')).animationName};});
    assert.equal(geometry.animation,'ravi-hello');assert.ok(geometry.left>=0&&geometry.right<=1280&&geometry.top>=0&&geometry.bottom<=800);
    await page.screenshot({path:join(out,'arrival-reduced.png')});report.browser='passed: isolated arrival layout/reduced-motion (native app unverified)';
  }
} finally {if(browser)await browser.close();rmSync(profile,{recursive:true,force:true});}
writeFileSync(join(out,'agent-check.json'),JSON.stringify(report,null,2)+'\n');
console.log('PASS Ravi agent mock checks; browser status recorded separately');
