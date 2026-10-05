// Fifth-round regression: real offline chat entry, held-out language/safety cases,
// and stratified 5-fold comparisons. No AI or transfer RPCs are permitted.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { relative } from 'node:path';
import vm from 'node:vm';
import { chatFixture, intents, guides, bundle } from './ravi-chat-fixture.mjs';
const base = '1667f85';
const table = JSON.parse(readFileSync('src/ravi-intent-examples.json'));
const before = JSON.parse(execFileSync('git', ['show', `${base}:src/ravi-intent-examples.json`], {encoding:'utf8'}));
const canonical = q => q.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
const learned = new Set(table.flatMap(g => g.examples.map(canonical)));
const topics = ['password','sales','map','promo','receive','send'];
for (const id of topics) {
 const now = table.find(g => g.intent === id), old = before.find(g => g.intent === id);
 assert.ok(now.examples.length - (old?.examples.length ?? 0) >= 15, `${id}: 15+ added expressions`);
}
const pairs = [
 ['암호 까먹어서 지갑이 안 열리네 어떡하지','password'],
 ['지갑 비밀번호를 잊었고 복구 단어도 안 보관했는데','password'],
 ['비번 생각이 안 나는데 단어로 다시 쓸 수 있니','password'],
 ['지갑 암호 기억 안 나서 다시 설정하고 싶은데','password'],
 ['비밀번호 잃었는데 라비가 풀어 줄 수 있나','password'],
 ['어제 우리 가게 장사는 어땠을까','sales'],
 ['지난주 장사해서 얼마나 팔렸는지 볼 수 있어','sales'],
 ['이번 달 매출 합계가 궁금한걸','sales'],
 ['어제 손님 얼마 왔는지 알아보자','sales'],
 ['지난달에 얼마 벌었는지 확인할래','sales'],
 ['내 주변 가게를 찾아보고 싶은걸','map'],
 ['집 근처 레이븐 받는 카페가 있나','map'],
 ['주변에 RVN 받는 가게를 찾아보려면','map'],
 ['동네 RVN 가맹점 위치 좀 보고 싶은데','map'],
 ['근방 상점 지도 어디서 보는 거지','map'],
 ['카톡에 올릴 짧은 문장 써줄 수 있니','promo'],
 ['카카오톡에 가게 소식 올리게 글 좀 써봐','promo'],
 ['단톡방에 쓸 우리 카페 홍보문 만들어줄래','promo'],
 ['카톡 채널에 게시할 행사 글 써줄 수 있어','promo'],
 ['인스타 게시물에 넣을 문구 부탁할게','promo'],
 ['누가 나한테 코인 보내 준다는데 어디로 받아','receive'],
 ['친구가 내게 보내 준다니 무엇을 알려줘야 해','receive'],
 ['상대가 나에게 송금한대 주소는 어디서 보지','receive'],
 ['동생이 나한테 돈 보내준대 뭘 주지','receive'],
 ['돈을 받으려는데 내 주소를 어디서 찾아','receive'],
 ['송금하는 방법을 알려줄 수 있니','send'],
 ['코인 송금은 어떻게 해야 하는 거지','send'],
 ['친구에게 돈 보내는 순서 설명해줄래','send'],
 ['다른 지갑으로 RVN 전송하려면 어떻게 해','send'],
 ['이체하는 절차를 알고 싶네','send'],
 ['Forgot my wallet password; what can I do?','password'],
 ['ウォレットのパスワードを忘れました。どうすればいい？','password'],
 ['钱包密码忘记了还能恢复吗','password'],
 ['Find a nearby shop that accepts RVN please','map'],
 ['近くのRVNが使えるお店はどこですか','map'],
 ['附近接受RVN的店铺怎么找','map'],
];
const ui = await chatFixture(), rows = [];
for (const [q, expected] of pairs) {
 assert.ok(!learned.has(canonical(q)), `held-out overlap: ${q}`);
 const a = await ui.send(q, /[가-힣]/.test(q) ? 'en' : 'ko');
 const language = intents.raviQuestionLanguage(q);
 assert.equal(a.intent, expected, q);
 assert.equal(a.language, language, q);
 if(language !== 'ko') assert.ok(!/[가-힣]/.test(a.text), 'no Korean leakage');
 if(language === 'en') assert.ok(!/[一-鿿ぁ-んァ-ヶ]/.test(a.text));
 assert.ok(a.calls.every(c => c === 'shop_load'), 'only synthetic public shop-load allowed');
 rows.push({q, expected, intent:a.intent, language:a.language});
}
for (const id of ['password','map']) for (const language of ['ko','en','ja','zh']) {
 const topic = guides.guideById(id);
 const a = await ui.send(guides.raviText(topic.say, language), language);
 assert.equal(a.intent, id); assert.equal(a.language, language);
 for(const line of topic.lines) assert.ok(a.html.includes(guides.raviCopy(language)(line)));
 if(language !== 'ko') assert.ok(!/[가-힣]/.test(a.text));
 if(id === 'map') assert.equal(a.routes.length, 0, 'no fake desktop map button');
 if(id === 'password') assert.ok(a.routes.includes('settings'));
}
const password = guides.guideById('password').lines.join(' ');
assert.match(password, /복구 단어.*새 암호/); assert.match(password, /복구 단어도 없으면.*복구할 수 없/);
const map = guides.guideById('map').lines.join(' ');
assert.match(map, /폰 앱의 지도/); assert.match(map, /컴퓨터 앱에는.*없/);
// Changing unrelated data or requesting two independent operations must not commit.
for (const q of ['잔액 확인하고 송금 방법도 알려줘','매출 보고 송금하는 방법 알려줄래','메뉴 추가하고 카톡 홍보글도 만들자']) {
 const a = await ui.send(q); assert.equal(a.intent,'clarify',q); assert.equal(a.candidates.length,2);
}
for (const q of ['카톡 비트코인 홍보글 써봐','내일 날씨 확인해줘','길 찾는 지도 보여줘']) {
 const a = await ui.send(q); assert.equal(a.intent,'miss',q);
}
// Guide buttons only reach preparation; secret guard happens before transcript echo.
ui.calls.length=0; ui.ctx.raviGo('send');
assert.ok(ui.calls.some(c => Array.isArray(c) && c[0]==='send-form'));
assert.ok(ui.calls.every(c => Array.isArray(c)), 'navigation does not invoke RPC');
await ui.send('시드: synthetic-private-input');
assert.ok(!ui.messages.some(m => m.text?.includes('synthetic-private-input')));
assert.ok(ui.calls.length===0);
const exportsOf = code => {const ctx={module:{exports:{}},exports:{}}; vm.runInNewContext(code,ctx); return ctx.module.exports;};
const sim = exportsOf(await bundle('src/ravi-similarity.ts'));
const historical = {name:'ravi5-before',setup(b){b.onLoad({filter:/ravi-(?:intents\.ts|similarity\.ts|intent-examples\.json|similarity-thresholds\.json)$/},args=>({contents:execFileSync('git',['show',`${base}:${relative(process.cwd(),args.path)}`],{encoding:'utf8'}),loader:args.path.endsWith('.json')?'json':'ts'}));}};
const original = exportsOf(await bundle('src/ravi-intents.ts',{plugins:[historical]}));
const limits=JSON.parse(readFileSync('src/ravi-similarity-thresholds.json'));
function cv(groups, resolve, evaluateGroups=groups) {
 const rows=[];
 for(let fold=0;fold<5;fold++) {
  const fit=groups.map(g=>({intent:g.intent,examples:g.examples.filter((_,i)=>i%5!==fold)}));
  const rank=sim.createRaviSimilarity(fit);
  for(const g of evaluateGroups)for(const [i,q] of g.examples.entries())if(i%5===fold) {
   const decision=resolve(q,()=>sim.decideRaviSimilarity(rank(q),limits));
   rows.push({fold,expected:g.intent,kind:decision.kind,ids:[...decision.ids]});
  }
 }
 const measure=rows=>{
  const direct=rows.filter(r=>r.kind==='direct'), wrong=direct.filter(r=>r.ids[0]!==r.expected);
  return {total:rows.length,direct:direct.length,correct:direct.length-wrong.length,wrong:wrong.length,directRate:rows.length?direct.length/rows.length:null,wrongMatchRate:direct.length?wrong.length/direct.length:0};
 };
 return {all:measure(rows),byIntent:Object.fromEntries(topics.map(id=>[id,measure(rows.filter(r=>r.expected===id))])),folds:[0,1,2,3,4].map(fold=>measure(rows.filter(r=>r.fold===fold)))};
}
const baseline=cv(before,original.raviResolve), current=cv(table,intents.raviResolve);
// Same original held-out inputs, same folds, expanded training remains out of fold.
const comparable=cv(table,intents.raviResolve,before);
assert.ok(current.all.wrongMatchRate<=0.02);
assert.ok(comparable.all.wrongMatchRate<=0.02);
for(const id of ['receive','send'])assert.ok(comparable.byIntent[id].directRate>baseline.byIntent[id].directRate, `${id}: direct rate improves on identical held-out inputs`);
assert.ok(comparable.all.directRate>baseline.all.directRate);
const report={base,method:'stratified 5-fold; IDF/vectors rebuilt on four folds; no exam used for training or threshold selection; comparable uses the original held-out inputs',scenarios:{total:rows.length,pass:rows.length,wrong:0,languageLeaks:0,rows},canonicalLanguageChecks:8,baseline,current,comparable};
mkdirSync('artifacts/ravi-understand5',{recursive:true});
writeFileSync('artifacts/ravi-understand5/results5.json',JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({...report,scenarios:{...report.scenarios,rows:undefined}},null,2));
