import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { chatFixture, guides as g, intents, dict, flatten } from './ravi-chat-fixture.mjs';
const cases=JSON.parse(readFileSync('scripts/fixtures/ravi-understanding-120.json','utf8'));
const training=JSON.parse(readFileSync('src/ravi-intent-examples.json','utf8'));
assert.equal(cases.length,120);
assert.deepEqual(['owner','customer','general'].map(role=>cases.filter(c=>c.role===role).length),[45,45,30]);
for(const lang of ['en','ja','zh'])assert.ok(cases.filter(c=>c.lang===lang).length>=10);
const learned=new Set(training.flatMap(t=>t.examples.map(intents.normalizeRavi)));
for(const t of training)assert.ok(t.examples.length>=8,`${t.intent} has 8 training examples`);
for(const id of [...g.GUIDE.map(t=>t.id),'help','promo','miss'])assert.ok(training.some(t=>t.intent===id),`document intent ${id}`);
assert.equal(new Set(cases.map(c=>intents.normalizeRavi(c.utterance))).size,120,'no duplicate exam text');
for(const c of cases)assert.ok(!learned.has(intents.normalizeRavi(c.utterance)),`held-out overlap: ${c.id}`);
// Prevent accidental sentence memorization by importing the example table into production.
for(const path of ['src/ravi-intents.ts','src/ravi-guide.ts','src/ravi-promo.ts'])assert.ok(!readFileSync(path,'utf8').includes('ravi-intent-examples'));
const screen={receive:'wallet',send:'wallet',wallet:'wallet',txs:'wallet',backup:'settings',create:'create',assets:'assets',node:'node',key:'key',orders:'shop',sales:'shop',shop:'shop',reward:'reward',phone:'settings',talk:'talk',settings:'settings',report:'report',qr:'shop'};
const ui=await chatFixture(),rows=[];
function leaks(answer,c) {
 if(answer.language!==c.lang)return ['response language'];
 const issues=[];
 if(c.lang!=='ko' && /[가-힣]/.test(answer.text))issues.push('Korean text');
 if(['en','zh'].includes(c.lang) && /[ぁ-んァ-ヶ]/.test(answer.text))issues.push('Japanese kana');
 if(c.lang==='en' && /[一-鿿]/.test(answer.text))issues.push('CJK text');
 // Exact canonical strings check the title, each body paragraph and each button.
 const topic=g.guideById(answer.intent);
 if(topic)for(const source of [topic.name,...topic.lines,...topic.go.map(b=>b.label)])if(!answer.html.includes(g.raviCopy(c.lang)(source)))issues.push('localized canonical copy');
 if(answer.intent==='help')for(const topic of g.GUIDE)if(!answer.html.includes(g.raviCopy(c.lang)(topic.name)))issues.push('help button');
 if(answer.intent==='miss' && !answer.html.includes(g.raviCopy(c.lang)('이건 아직 못 해요. 대신 아래에서 할 수 있는 일을 골라 주세요.')))issues.push('refusal body');
 if(answer.intent==='clarify' && !answer.html.includes(g.raviCopy(c.lang)('혹시 이거요? 아래 두 가지 중 골라 주세요.')))issues.push('clarification title');
 if(answer.intent==='promo') {
  // Each static promo node must belong to the chosen-language dictionary or the
  // localized language picker. User text/URLs are not treated as UI translations.
  const allowed=new Set(c.lang==='ko' ? Object.keys(dict.en) : Object.values(dict[c.lang]));
  const neutral=/^(?:[\d\s/.]+|X|PNG|RVN)$/;
  const languages={ko:['한국어','영어','일본어','중국어'],en:['Korean','English','Japanese','Chinese'],ja:['韓国語','英語','日本語','中国語'],zh:['韩语','英语','日语','中文']};
  for(const node of flatten(answer.root))if(node._text && !allowed.has(node._text) && !neutral.test(node._text) && !languages[c.lang].includes(node._text))issues.push(`promo node: ${node._text}`);
 }
 return issues;
}
for(const c of cases) {
 const a=await ui.send(c.utterance,c.lang==='ko'?'en':'ko');
 const languageLeaks=leaks(a,c);
 const expected=c.expected;
 let navigation=true;
 if(expected.route){ui.calls.length=0;ui.ctx.raviGo(expected.route);navigation=ui.calls.some(call=>Array.isArray(call) && call[0]==='page' && call[1]===expected.screen) || ['node','key','report'].includes(expected.screen);
 if(expected.tab)navigation &&=ui.calls.some(call=>Array.isArray(call) && call[0]==='tab' && call[1]===expected.tab);}
 const pass=a.intent===c.intent && a.kind===expected.kind && !languageLeaks.length && (!expected.route || a.routes.includes(expected.route) && navigation) &&
  (c.intent!=='miss' || a.buttons.length>=2 && a.buttons.length<=3) && (c.intent!=='clarify' || a.candidates.length===2 && expected.candidates.every(id=>a.candidates.includes(id)));
 rows.push({...c,actual:{intent:a.intent,kind:a.kind,language:a.language,routes:a.routes,candidates:a.candidates,calls:a.calls},pass,languageLeaks,
  wrong:a.intent!==c.intent && !['miss','clarify'].includes(a.intent)});
}
const totals=rows=>({total:rows.length,pass:rows.filter(c=>c.pass).length,wrong:rows.filter(c=>c.wrong).length,languageLeaks:rows.filter(c=>c.languageLeaks.length).length});
const failures=['가게 문 닫을게','영업시간 바꿔','QR 코드 출력','영수증','레이븐 얼마 있어?','민수한테 5 보내','홍보 글 써줘','인스타 올릴 글','세금 자료 엑셀','CSV 내보내기','레이븐볼트가 뭐야','이거 안전해?','what can you do','비트코인 사줘','오늘 날씨'];
const legacy=await chatFixture(true),comparisons=[];
for(const q of failures){const before=await legacy.send(q,'ko'),after=await ui.send(q,'ko');comparisons.push({question:q,before:{intent:before.intent,language:before.language||'ko',text:before.text,buttons:before.buttons},after:{intent:after.intent,language:after.language,text:after.text,buttons:after.buttons}});}
// The learning table is validated separately and is never used for test labels.
for(const t of training)for(const example of t.examples){const a=await ui.send(example);assert.equal(a.intent,t.intent,`learning table: ${example}`);}
// Safety tests also traverse the top entry, before echo, promo or logging.
for(const q of ['sk-abcdefghijklmnop','seed: synthetic words','token=synthetic','개인키: synthetic','秘密鍵=synthetic','私钥:synthetic','K'+'A'.repeat(51),'alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu']) {
 await ui.send(q);assert.ok(!JSON.stringify(ui.messages).includes(q));assert.equal(ui.calls.length,0);assert.equal(ui.cards.length,0);
}
// Real guide navigation functions must reach existing pages, never confirm or submit.
const html=readFileSync('index.html','utf8');
for(const topic of g.GUIDE)for(const button of topic.go) {
 assert.ok(screen[button.to],`mapped route ${button.to}`);
 ui.calls.length=0;ui.ctx.raviGo(button.to);assert.ok(ui.calls.length);
 if(!['node','key','report'].includes(button.to))assert.ok(html.includes(`id="page-${screen[button.to]}"`));
}
const report={baseline:'efcc880',entry:'chatSend → chatSendExisting → help / promo (real openRaviPromo + createPromoCard) / address / guide / refusal',
 training:{intents:training.length,examples:training.reduce((n,t)=>n+t.examples.length,0),overlap:0},after:totals(rows),
 groups:['owner','customer','general'].map(role=>({role,...totals(rows.filter(c=>c.role===role))})),
 languages:['ko','en','ja','zh'].map(lang=>({lang,...totals(rows.filter(c=>c.lang===lang))})),
 failures:rows.filter(c=>!c.pass),rows,comparisons};
mkdirSync('artifacts/ravi-understand2',{recursive:true});writeFileSync('artifacts/ravi-understand2/results.json',JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({after:report.after,groups:report.groups,languages:report.languages,failures:report.failures},null,2));
assert.equal(report.after.pass,120,'all 120 held-out production-path inputs');
assert.equal(report.after.wrong,0);assert.equal(report.after.languageLeaks,0);
console.log('PASS 120 held-out top-level inputs; no overlap; title/body/buttons language; promo production path; safe routes and secret-before-echo');
