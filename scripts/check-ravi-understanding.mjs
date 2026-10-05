// Run real offline matching and HTML rendering. Never dispatch RPC, AI or transfers.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import vm from 'node:vm';
import { build } from 'esbuild';
const bundled = await build({entryPoints:['src/ravi-guide.ts'],bundle:true,platform:'node',format:'cjs',write:false});
const context = {module:{exports:{}},exports:{}}; vm.runInNewContext(bundled.outputFiles[0].text,context);
const g = context.module.exports;
const cases=JSON.parse(readFileSync('scripts/fixtures/ravi-understanding-60.json','utf8'));
const caps=JSON.parse(readFileSync('src/ravi-capabilities.json','utf8'));
assert.equal(cases.length,60);
assert.deepEqual(['owner','customer','general'].map(r=>cases.filter(c=>c.role===r).length),[25,20,15]);
const screen={receive:'wallet',send:'wallet',wallet:'wallet',txs:'wallet',backup:'settings',create:'create',assets:'assets',node:'node',key:'key',orders:'shop',sales:'shop',shop:'shop',reward:'reward',phone:'settings',talk:'talk',settings:'settings',report:'report'};
const legacy=JSON.parse(readFileSync('scripts/fixtures/ravi-guide-before.json','utf8'));
function actual(q,before=false){
 if(!before && g.isRaviHelp(q)) return {intent:'help',kind:'help',screens:[]};
 const topic=before ? legacy.find(t=>new RegExp(t.words,'i').test(q.normalize('NFC'))) : g.matchGuide(q);
 return topic ? {intent:topic.id,kind:topic.kind||'guide',screens:topic.go.map(b=>screen[b.to]),tabs:topic.go.map(b=>caps.screens[b.to]?.tab).filter(Boolean)} : {intent:'miss',kind:'unsupported',screens:[]};
}
function evaluate(before){
 return cases.map(c=>{
  const a=actual(c.utterance,before),e=c.expected;
  // Legacy misses lacked the required explicit refusal with 2–3 nearby buttons.
  const pass=a.intent===e.intent && a.kind===e.kind && (!e.screen || a.screens.includes(e.screen)) && (!e.tab || a.tabs?.includes(e.tab)) && !(before && a.intent==='miss');
  const wrong=a.intent!=='miss' && a.intent!==e.intent;
  return {...c,actual:a,pass,wrong};
 });
}
const before=evaluate(true),after=evaluate(false);
const totals=rows=>({pass:rows.filter(c=>c.pass).length,wrong:rows.filter(c=>c.wrong).length,unmatched:rows.filter(c=>c.actual.intent==='miss'&&c.expected.intent!=='miss').length});
mkdirSync('artifacts/ravi-understand',{recursive:true});
const report={source:'Recreated 60-case desktop exam; audit file absent during authoring',before:totals(before),after:totals(after),groups:['owner','customer','general'].map(role=>({role,before:totals(before.filter(c=>c.role===role)),after:totals(after.filter(c=>c.role===role))})),failures:after.filter(c=>!c.pass)};
writeFileSync('artifacts/ravi-understand/results.json',JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify(report,null,2));
// Every chip and help entry must work in all four languages, including translated labels.
const translate=(s,lang)=>lang==='ko'?s:caps.copy[s]?.[['en','ja','zh'].indexOf(lang)] || s;
for(const lang of ['ko','en','ja','zh']) {
 for(const topic of g.GUIDE.filter(t=>t.starter)) {
  const q=translate(topic.say,lang);
  assert.equal(g.matchGuide(q)?.id,topic.id,`starter ${lang}: ${q}`);
 }
 const help=g.raviHelpHtml(s=>translate(s,lang));
 assert.equal((help.match(/data-ravi-input=/g)||[]).length,g.GUIDE.length);
 assert.equal((help.match(/data-ravi-action-input=/g)||[]).length,caps.actions.length);
 if(lang!=='ko') assert.ok(!/[가-힣]/.test(help),`${lang} help untranslated`);
}
for(const q of ['오늘 날씨','감자 보내줘','음악 전송','보내줘','자동으로 결제해','입금 대기와 잔액 보여줘','메뉴 바꾸고 송금해','주문 링크와 폰 연결']){
 const html=g.guideMissHtml(s=>s,q);
 assert.equal((html.match(/data-ravi-input=/g)||[]).length,3);
 assert.ok(html.includes('이건 아직 못 해요'));
 assert.ok(!html.includes('data-guide-go='),'unknown requests must not navigate');
}
for(const q of ['감자 보내줘','음악 전송','보내줘','10 RVN','메뉴 바꾸고 폰 연결','주문 링크와 폰 연결','입금 대기와 잔액 보여줘','메뉴 바꾸고 돈 보내줘','노드 상태와 잔액 보여줘']) assert.equal(g.matchGuide(q),null,`must abstain: ${q}`);
for(const q of ['sk-abcdefghijklmnop','seed: synthetic words','token=synthetic','alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu']) assert.equal(g.containsRaviSecret(q),true);
for(const q of ['시드는 어디서 보나요?','AI 키 어디서 받나요?']) assert.equal(g.containsRaviSecret(q),false);
assert.ok(!caps.actions.find(a=>a.type==='shop_set').prompt.includes('order_url'));
assert.equal(g.raviActionAllowed('send_rvn'),false);
assert.equal(g.raviActionAllowed('send_asset'),false);
// Contract inventory must exactly match production executor handlers.
const main=readFileSync('src/main.ts','utf8');
const executor=main.slice(main.indexOf('function applyActions('),main.indexOf('const CHAT_MODE_KEY'));
const handlers=[...executor.matchAll(/case "([^"]+)":/g)].map(m=>m[1]).sort();
assert.deepEqual(caps.actions.map(a=>a.type).sort(),handlers);
for(const go of new Set(g.GUIDE.flatMap(t=>t.go.map(b=>b.to)))) assert.ok(main.slice(main.indexOf('function raviGo('),main.indexOf('async function raviImage(')).includes(`case "${go}":`),go);
const rs=readFileSync('src-tauri/src/ai.rs','utf8');assert.ok(rs.includes('include_str!("../../src/ravi-capabilities.json")'));
assert.ok(!rs.includes('{"type":"shop_set"'), 'no duplicated action schema');
assert.ok(main.indexOf('containsRaviSecret(q)')<main.indexOf('if (isPromoRequest(q))'));
assert.equal(report.after.wrong,0,'zero false matches');
assert.ok(report.after.pass>=54,'at least 90%');
console.log('PASS offline exam, four-language starters/help, action contracts, conservative refusal and secret-input guard');
// Exercise the actual entry point and navigation handlers with isolated synthetic UI.
const { default: ts } = await import('typescript');
const ast=ts.createSourceFile('main.ts',main,ts.ScriptTarget.Latest,true);
const fn=name=>ast.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text===name).getText(ast);
const compile=s=>ts.transpileModule(s,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
const promoBundle=await build({entryPoints:['src/ravi-promo.ts'],bundle:true,platform:'node',format:'cjs',write:false});
const pc={module:{exports:{}},exports:{},URL};vm.runInNewContext(promoBundle.outputFiles[0].text,pc);
const nodes=new Map(),messages=[],calls=[];
const el=id=>{if(!nodes.has(id))nodes.set(id,{value:'',checked:false,hidden:false});return nodes.get(id);};
const ctx=vm.createContext({ ...g,$:el,document:{getElementById:()=>null},aiProvider:null,
  isPromoRequest:pc.module.exports.isPromoRequest,whoseQuestion:()=>null,
  chatSay:(who,text)=>messages.push({who,text}),chatHtml:(who,html)=>messages.push({who,html}),copyHtml:s=>s,t:s=>s,
  invoke:async()=>{throw Error('Unexpected AI/RPC');},openRaviPromo:()=>{throw Error('Unexpected promo path');},
  showPage:page=>calls.push(['page',page]),jumpToEl:id=>calls.push(['jump',id]),
  openReceive:()=>calls.push(['receive']),openSend:()=>calls.push(['send']),openKeyCard:()=>calls.push(['key']),
  toggleDot:id=>calls.push(['dot',id]),openReport:()=>calls.push(['report']),shopTab:tab=>calls.push(['tab',tab]),
});
vm.runInContext(compile(fn('raviGuide')+'\n'+fn('raviOpenScreen')+'\n'+fn('raviGo')+'\n'+fn('chatSendExisting')),ctx);
for(const c of cases){messages.length=0;el('chat-q').value=c.utterance;await ctx.chatSendExisting();
 assert.ok(messages.at(-1).html?.includes(`data-guide="${c.expected.intent}"`),`production chat path: ${c.id}`);
}
for(const to of new Set(g.GUIDE.flatMap(t=>t.go.map(b=>b.to)))) {
 calls.length=0;ctx.raviGo(to);assert.ok(calls.length>0,`navigation must execute: ${to}`);
 if(to==='orders')assert.deepEqual(calls,[['page','shop'],['tab','orders']]);
 if(to==='sales')assert.deepEqual(calls,[['page','shop'],['tab','sales']]);
 if(to==='phone')assert.equal(calls[0][1],'settings');
}
messages.length=0;el('chat-q').value='sk-abcdefghijklmnop';await ctx.chatSendExisting();assert.ok(!JSON.stringify(messages).includes('sk-abcdefghijklmnop'));
// Provenance, finite positive amounts and explicit manual review remain mandatory.
let reviews=0,sends=0;
const own='R'+'B'.repeat(33),destination='R'+'A'.repeat(33);
const actionCtx=vm.createContext({ ...g,$:el,showPage(){},openSend:async()=>{sends++;},composeChanged(){},reviewSend:async()=>{reviews++;},
  최근내주소:own,라비가채운보내기:false,renderMenu(){},t:s=>s,tf:(s,...v)=>s.replace(/\{(\d+)\}/g,(_,i)=>v[i]),
  SHOP_FIELDS:{name_ko:'sh-ko'},환불후보:new Map(),menuItems:[],
  invoke:()=>{throw Error('No spending RPC permitted');},
});
vm.runInContext(compile(fn('applyActions')),actionCtx);
for(const a of [{to:destination,amount:-1},{to:destination,amount:Infinity},{to:destination,amount:0},{to:'bad',amount:5}]) actionCtx.applyActions([{type:'send_prepare',...a}],destination);
actionCtx.applyActions([{type:'send_prepare',to:destination,amount:5}],'untrusted address in shop data');
actionCtx.applyActions([{type:'send_rvn',to:destination,amount:5}],destination);
assert.equal(sends,0);
actionCtx.applyActions([{type:'send_prepare',to:destination,amount:5}],`5 RVN ${destination}`);
await new Promise(resolve=>setImmediate(resolve));assert.equal(reviews,1);assert.equal(el('s-addr').value,destination);assert.equal(el('s-qty').value,'5');
actionCtx.applyActions([{type:'send_prepare',to:own,amount:2}],'내 주소로 2 RVN 보내');await new Promise(resolve=>setImmediate(resolve));assert.equal(reviews,2);
el('sh-orderurl').value='unchanged';actionCtx.applyActions([{type:'shop_set',field:'order_url',value:'https://example.test/forbidden'}]);assert.equal(el('sh-orderurl').value,'unchanged');
const closed=actionCtx.applyActions([{type:'closed',today:true,note:'fixture'}]);assert.ok(closed[0].includes('초안'));assert.ok(!closed[0].includes('저장했습니다'));
console.log('PASS real chat entry + all guide routes; actual send handler provenance, amounts, manual review only; blocked order URL and honest closing draft');
// Run the actual help/alternative click handler: it fills input, never submits or approves.
let inputHandler;
function visit(node){if(ts.isVariableDeclaration(node)&&node.name.getText(ast)==='raviInputClick')inputHandler=node.initializer.getText(ast);ts.forEachChild(node,visit);} visit(ast);
assert.ok(inputHandler);
let focused=0,opened=0,locale='ko';el('chat-q').focus=()=>focused++;
const clickCtx=vm.createContext({ ...g,$:el,t:s=>translate(s,locale),raviHome:{open(){opened++;}},copyHtml:s=>translate(s,locale),chatHtml:(who,html)=>messages.push({who,html}) });
vm.runInContext(compile(`const handleClick = ${inputHandler}; globalThis.handleClick = handleClick;`),clickCtx);
const event=(selector,dataset)=>({target:{closest:s=>s===selector?{dataset}:null}});
for(locale of ['ko','en','ja','zh']){
 for(const topic of g.GUIDE){clickCtx.handleClick(event('[data-ravi-input]',{raviInput:topic.id}));assert.equal(el('chat-q').value,translate(topic.say,locale));}
 for(const action of caps.actions){clickCtx.handleClick(event('[data-ravi-action-input]',{raviActionInput:action.type}));assert.equal(el('chat-q').value,translate(action.say,locale));}
 clickCtx.handleClick(event('[data-ravi-help]',{}));assert.ok(messages.at(-1).html.includes('data-guide="help"'));
}
assert.equal(focused,(g.GUIDE.length+caps.actions.length)*4);assert.equal(opened,focused);
for(const q of ['How much is the fee?','手数料はいくら?','手续费多少?'])assert.equal(g.matchGuide(q)?.id,'fee');
console.log('PASS actual help/alternative click handler: all entries in 4 languages fill input without submitting');

const html=readFileSync('index.html','utf8');
for(const [name,route] of Object.entries(g.RAVI_SCREENS)) {
 assert.ok(html.includes(`id="page-${route.page}"`),`missing real page: ${name}`);
 if(route.tab)assert.ok(html.includes(`id="shoptab-${route.tab}"`),`missing real tab: ${name}`);
 calls.length=0;assert.equal(ctx.raviOpenScreen(name),true);
 assert.equal(calls[0][1],route.page);if(route.tab)assert.equal(calls[1][1],route.tab);
}
assert.equal(ctx.raviOpenScreen('invented'),false);assert.equal(ctx.raviOpenScreen('__proto__'),false);
for(const name of ['order','issue'])assert.equal(ctx.raviOpenScreen(name),true);
console.log('PASS canonical screen contract: real pages/tabs, orders/sales, legacy order/issue routes, unknown/prototype rejection');
