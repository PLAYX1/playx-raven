import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const read = p => readFileSync(p, 'utf8');
const server = read('src-tauri/src/server.rs');
const owner = server.slice(server.indexOf('async fn api_owner_ask('), server.indexOf('async fn api_ai_status('));
assert.ok(owner.includes('ai_ask_owner_limited('));
assert.ok(!owner.includes('ai_answer_any('));
assert.ok(owner.includes('"answer":') && owner.includes('"left":'));
const ai = read('src-tauri/src/ai.rs');
const ownerAI = ai.slice(ai.indexOf('pub(crate) async fn ai_ask_owner_limited('), ai.indexOf('fn owner_system('));
assert.ok(ownerAI.includes('try_order(&provider, false)'));
assert.ok(ownerAI.includes('owner_system(owner.as_ref())'));
console.log('PASS owner phone system instructions, provider order and answer/left contract');

// Run production action handlers with synthetic DOM and RPC. No network.
const { default: ts } = await import('typescript');
const { default: vm } = await import('node:vm');
const main = read('src/main.ts');
const ast = ts.createSourceFile('main.ts', main, ts.ScriptTarget.Latest, true);
const fn = name => ast.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === name).getText(ast);
const compile = s => ts.transpileModule(s, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
let calls = [], removed = false;
const save = {}, cancel = {}, note = {}, swatch = { style: {} };
const card = { style: {}, remove() { removed = true; }, querySelector(s) { return ({'[data-theme-save]':save,'[data-theme-cancel]':cancel,'[data-theme-note]':note,'[data-theme-swatch]':swatch})[s]; } };
const c = vm.createContext({ $, chatHtml() {}, copyHtml:s=>s, t:s=>s, tf:s=>s, errText:()=> 'synthetic error', setCopyText:(el,draw)=>el.textContent=draw(), invoke:async(cmd,args)=>{ calls.push({cmd,args}); } });
function $(id) { assert.equal(id,'chat-log'); return { lastElementChild:{querySelector:()=>card} }; }
vm.runInContext(compile(fn('previewRaviTheme')),c);
assert.equal(c.previewRaviTheme('112233','eef0ff'),true);
assert.equal(calls.length,0,'preview must not save');
cancel.onclick(); assert.equal(removed,true); assert.equal(calls.length,0);
c.previewRaviTheme('112233','eef0ff'); await save.onclick();
assert.equal(calls.length,1); assert.equal(calls[0].cmd,'theme_save'); assert.equal(calls[0].args.accent,'#112233');
assert.equal(c.previewRaviTheme('bad<script>','eef0ff'),false);
assert.ok(!fn('applyActions').includes('invoke("theme_save"'));
const html = read('web/admin.html');
const apply = html.slice(html.indexOf('      function apply(actions)'),html.indexOf('      // 손님은 주문하고'));
const menu = [{name:'fixture',price:10}]; let agreed=false, confirmations=0;
const admin = vm.createContext({menu, renderMenu(){}, confirm(){ confirmations++; return agreed; }, Number, $(){return {};} });
vm.runInContext(apply,admin);
admin.apply([{type:'menu_clear'}]); assert.equal(menu.length,1); assert.equal(confirmations,1);
agreed=true; admin.apply([{type:'menu_clear'}]); assert.equal(menu.length,0);
menu.push({name:'fixture',price:10});
for (const field of ['__proto__','constructor','image','unknown']) admin.apply([{type:'menu_set',index:0,field,value:'forbidden'}]);
assert.deepEqual(menu[0],{name:'fixture',price:10});
admin.apply([{type:'menu_set',index:0,field:'price',value:'not a number'}]); assert.equal(menu[0].price,10);
admin.apply([{type:'menu_set',index:0,field:'price',value:'12'}]); assert.equal(menu[0].price,12);
console.log('PASS theme preview/manual save, admin delete confirmation and menu field allowlist');

const customer = server.slice(server.indexOf('async fn api_ask('), server.indexOf('struct OrderBody'));
const adminAI = server.slice(server.indexOf('async fn admin_ai('), server.indexOf('struct IssueBody'));
assert.ok(customer.includes('Lane::Customer') && customer.includes('|| permit.charge()'));
assert.ok(owner.includes('Lane::Owner') && owner.includes('|| permit.charge()'));
assert.ok(adminAI.includes('Lane::Owner'));
assert.ok(adminAI.indexOf('permit.charge()') < adminAI.indexOf('ai_chat('));
const attempts = ai.slice(ai.indexOf('async fn run_attempts'),ai.indexOf('mod attempt_tests'));
assert.ok(attempts.indexOf('before_attempt()?') < attempts.indexOf('match request('));
console.log('PASS customer/owner/admin budget wiring and pre-dispatch fallback charge');

// Key onboarding is driven by fake fetch responses; never call a provider.
const latestMain = read('src/main.ts');
const latestAST = ts.createSourceFile('main.ts', latestMain, ts.ScriptTarget.Latest, true);
const latestFn = name => latestAST.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === name).getText(latestAST);
async function onboarding(outcome) {
  const pending = new Set(), elements = new Map(); let awake=false, closed=false, refreshes=0, requests=0;
  const element = id => { if (!elements.has(id)) elements.set(id,{value:'',textContent:'',disabled:false,hidden:false,querySelector:()=>elements.get('retry')}); return elements.get(id); };
  element('ravi-key-input').value='synthetic-input'; element('retry');
  let release;
  const barrier = new Promise(resolve=>{release=resolve;});
  const fakeFetch = async () => { requests++; await barrier; return new Response('{}',{status:outcome}); };
  const ctx = vm.createContext({ $,keyPick:'openai',aiKeyed:{openai:true}, PROVIDERS:{openai:['Fixture AI']},
    markKeyPending(p,on){if(on)pending.add(p);else pending.delete(p);},
    async invoke(command){
      if(command==='save_api_key')return {};
      assert.equal(command,'ai_check_connection');
      const response=await fakeFetch(); if(!response.ok)throw Error('synthetic connection failure');
    },
    async refreshKeys(){refreshes++; awake=!pending.has('openai');},
    closeKeyCard(){closed=true;}, chatHtml(){}, copyHtml:s=>s,escapeHtml:s=>s,t:s=>s,tf:s=>s,
    setCopyText:(el,draw)=>el.textContent=draw(), showPage(p){assert.equal(p,'ravi');},openKeyCard(){closed=false;},aiProvider:null,
  });
  function $(id){return element(id);}
  vm.runInContext(compile(latestFn('saveKeyCard')+'\n'+latestFn('wakeRavi')),ctx);
  ctx.wakeRavi(); assert.equal(closed,false);
  const saving=ctx.saveKeyCard(); await new Promise(resolve=>setImmediate(resolve));
  assert.equal(awake,false,'must sleep while connection is pending');
  assert.ok(element('ravi-key-input').value==='', 'clear input before connection check');
  assert.equal(element('ravi-key-save').disabled,true);
  await ctx.saveKeyCard(); assert.equal(requests,1,'double click must not check twice');
  release(); await saving;
  assert.equal(awake,outcome===200); assert.equal(closed,outcome===200);
  assert.ok(element('ravi-key-input').value===''); assert.equal(element('ravi-key-save').disabled,false);
  if(outcome!==200){
    assert.ok(pending.has('openai')); assert.equal(element('retry').hidden,false);
    assert.ok(element('kc-note').textContent.includes('확인하지 못했어요'));
  }
  assert.ok(refreshes>0);
}
await onboarding(200); await onboarding(401); await onboarding(503);
const refresh = latestFn('refreshKeys');
assert.ok(refresh.includes('!pendingKeyChecks.has(sel.value)'));
assert.ok(refresh.includes('setAllRaviMood(keyed ? "normal" : "sleep")'));
assert.ok(read("src/ravi-home.ts").includes('byId("ravi-stage").onclick = api.wake'));
assert.ok(!latestMain.includes('$("ravi-face").replaceWith'), "legacy hero face must not be mounted");
for (const phrase of ['눌러서 깨우기','저장하고 연결 확인','저장된 키로 연결 확인','연결을 확인하는 중…']) {
  assert.equal((read('src/dict.ts').match(new RegExp('"'+phrase+'":','g'))||[]).length,3);
}
console.log('PASS sleeping Ravi, clickable key entry, fake-fetch connection success/failure and duplicate-click guard');

// Exercise the actual status refresh, including browser select semantics.
let availability = {}, moods = [];
const slots = new Map();
const slot = id => { if(!slots.has(id))slots.set(id,{value:'',textContent:'',hidden:true,dataset:{}}); return slots.get(id); };
let options=[],selected='';
slots.set('ai-pick',{get value(){return selected;},set value(v){selected=options.includes(v)?v:'';},set innerHTML(html){options=[...html.matchAll(/value="([^"]+)"/g)].map(m=>m[1]); selected=options[0]||'';}});
const pending = new Set();
const statusContext=vm.createContext({$ : slot,document:{getElementById:()=>null},PROVIDERS:{openai:['Fixture A'],groq:['Fixture B']},
  aiProvider:null,lastKeyState:null,pendingKeyChecks:pending,
  async invoke(cmd){return cmd==='api_key_status'?{available:availability}:{};},
  renderKeyRows(){},escapeHtml:String,paintRaviBadge(){},t:s=>s,refreshOverview(){},closeKeyCard(){},
  setAllRaviMood:m=>moods.push(m),animateRavi:on=>moods.push(on?'awake':'sleep'),
});
vm.runInContext(compile(latestFn('refreshKeys')),statusContext);
await statusContext.refreshKeys(); assert.equal(statusContext.aiProvider,null); assert.equal(moods.at(-1),'sleep');
availability={openai:true}; pending.add('openai'); await statusContext.refreshKeys();
assert.equal(statusContext.aiProvider,null); assert.equal(moods.at(-1),'sleep');
pending.delete('openai'); availability.groq=true; await statusContext.refreshKeys('groq');
assert.equal(statusContext.aiProvider,'groq'); assert.equal(moods.at(-1),'awake');
console.log('PASS actual status refresh: no key asleep, unverified key asleep, checked provider selected and awake');
