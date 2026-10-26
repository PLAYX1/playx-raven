// Additional scenario audit through chatSend, including the front send-recognition path.
// These inputs are held out of the learning table and threshold calibration.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { chatFixture, intents, guides, bundle } from './ravi-chat-fixture.mjs';
import vm from 'node:vm';
const pairs=[
 ['내 레이븐 몇 개야','balance'],['엄마한테 10개 보내줘','send'],
 ['잘못 보냈어 되돌려줘','undo'],['폰 바꾸면 지갑 어떻게 옮겨','backup'],
 ['AI 깨우는 법','key'],['오늘 얼마 팔았어','sales'],['카톡에 올릴 글 써줘','promo'],
 ['이 앱 뭐하는 거야','about'],['일본어로','language'],['앱이 이상해','report'],
 ['누가 나한테 보내 준다는데 뭐 알려줘야 돼','receive'],['라비 말 안 해','key'],
 ['해킹 당하면','safety'],['안녕','help'],
 ['내 코인 수가 궁금한데','balance'],['친구가 코인 준다는데 어디로 받지','receive'],
 ['받을 사람을 틀렸는데 다시 돌릴 수 있나','undo'],['새 기기에 지갑을 복원하려는데','backup'],
 ['AI 대답을 들으려면 무엇부터 설정해','key'],['가게 판매한 합계 볼 수 있을까','sales'],
 ['가게 광고를 카카오톡에 공유하고 싶어','promo'],['프로그램이 자꾸 먹통이 된다','report'],
 ['여기 지갑 믿고 써도 되나','safety'],['커피 메뉴에 하나 추가하고 싶은데','menu'],
 ['손님 주문이 들어온 것 확인할래','orders'],['테이블 QR을 종이에 인쇄할래','qr'],
 ['매출 CSV를 세무사에게 보내야 하는데','export'],['온라인 주문 링크 수정할 수 있나','order-link'],
 ['우리 매장 연락처를 바꾸려는데','shop'],['내가 받았던 쿠폰 목록을 보자','assets'],
 ['신규 회원권 발행 준비를 할래','create'],['수료증 진위 검증할 수 있나','cert'],
 ['친구랑 채팅하려면 어디 눌러','talk'],['휴대폰과 컴퓨터 페어링 해보자','phone'],
 ['시드 단어는 어디에 보관해야 하니','seed'],['노드 동기화가 진행되고 있나','sync'],
 ['돈 보낼 때 수수료가 얼마나 나올까','fee'],['내일 비 와?','miss'],
 ['비트코인 거래 대신 해줄래','miss'],['오늘 날씨 예측해줘','miss'],
];
assert.equal(pairs.length,40);
const learned=new Set(JSON.parse(readFileSync('src/ravi-intent-examples.json')).flatMap(g=>g.examples.map(intents.normalizeRavi)));
const ui=await chatFixture(),rows=[];
for(const [q,expected] of pairs) {
 assert.ok(!learned.has(intents.normalizeRavi(q)),`scenario overlap: ${q}`);
 const a=await ui.send(q,'en');
 const candidate=a.intent==='clarify' && a.candidates.length===2 && a.candidates.includes(expected);
 const expectedLanguage=expected==='language'?'ja':'ko';
 const pass=(a.intent===expected || candidate) && a.language===expectedLanguage;
 if(expectedLanguage==='ja')assert.ok(!/[가-힣]/.test(a.text));
 assert.ok(!a.calls.some(c=>typeof c==='string' && c!=='shop_load'),'no AI, spending or wallet RPC');
 rows.push({q,expected,intent:a.intent,candidates:a.intent==='clarify'?a.candidates:[],language:a.language,expectedLanguage,pass,
  wrong:!['miss','clarify'].includes(a.intent) && a.intent!==expected});
}
// Candidate selection reuses translated, existing input handlers for all four languages.
for(const id of ['help','promo','language'])for(const language of ['ko','en','ja','zh']) {
 const topic=guides.guideById(id);assert.ok(topic);
 assert.ok(guides.raviCopy(language)(topic.name));
 const a=await ui.send(guides.raviText(topic.say,language),language);
 assert.equal(a.intent,id);assert.equal(a.language,language);
}
// Empty/no-overlap text abstains. The pure matcher has no imports with side effects or RPCs.
const ctx={module:{exports:{}},exports:{}};vm.runInNewContext(await bundle('src/ravi-similarity.ts'),ctx);
const sim=ctx.module.exports;
assert.equal(sim.raviSimilarity('').kind,'miss');assert.equal(sim.raviSimilarity('🪐🛸').kind,'miss');
const close=sim.decideRaviSimilarity([{intent:'balance',score:.99},{intent:'receive',score:.98}]);
assert.equal(close.kind,'clarify');assert.deepEqual([...close.ids],['balance','receive']);
assert.equal(sim.decideRaviSimilarity([{intent:'balance',score:.01}]).kind,'miss');
const report={entry:'production chatSend; no AI key; amount+send reaches explicit send guide, not a transfer parser or RPC',
 total:rows.length,pass:rows.filter(r=>r.pass).length,direct:rows.filter(r=>r.pass&&r.intent!=='clarify').length,
 candidates:rows.filter(r=>r.pass&&r.intent==='clarify').length,wrong:rows.filter(r=>r.wrong).length,
 languageLeaks:rows.filter(r=>r.language!==r.expectedLanguage).length,rows};
mkdirSync('artifacts/ravi-understand3',{recursive:true});writeFileSync('artifacts/ravi-understand3/scenarios40.json',JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({...report,rows:rows.filter(r=>!r.pass)},null,2));
assert.equal(report.wrong,0);assert.equal(report.languageLeaks,0);assert.equal(report.pass,40);
