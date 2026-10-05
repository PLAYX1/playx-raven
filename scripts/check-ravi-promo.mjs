// Execute production logic against public synthetic facts. No AI or wallet calls.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
const compile = path => ts.transpileModule(readFileSync(path, 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
const exports = {};
vm.runInNewContext(compile('src/ravi-promo.ts'), { exports, URL });
const { promoShop, templatePromo, promoPriceWarnings, promoLength, limitPromo, isPromoRequest, PROMO_CHANNELS, PROMO_LIMITS } = exports;
const saved = { name_ko:'시험 카페', name_en:'Fixture Cafe', description:'원두를 직접 볶습니다', currency:'KRW',
  menu:[{name:'커피',price:3000},{name:'차',price:4000},{name:'미정'},{name:'잘못된 가격',price:-1}],
  hours:{1:{open:'09:00',close:'18:00'}}, order_url:'https://example.test/order?table=1', seed:'private-fixture', payment_address:'private-fixture' };
const shop = promoShop(saved,'ko');
assert.equal(shop.menu.length,2);
assert.ok(!JSON.stringify(shop).includes('private-fixture'));
for (const language of ['ko','en','ja','zh']) {
  const data = promoShop(saved,language), drafts = templatePromo(data,language);
  for (const channel of PROMO_CHANNELS) {
    assert.ok(drafts[channel].includes(data.name));
    assert.ok(drafts[channel].includes(data.orderUrl),'every channel contains the existing QR order URL');
    assert.ok(promoLength(drafts[channel],channel)<=PROMO_LIMITS[channel]);
    assert.equal(promoPriceWarnings(drafts[channel],data).length,0);
    assert.ok(!/할인|특가|수익|discount/i.test(drafts[channel]));
  }
  assert.equal(drafts.kakao.split('\n').length,3);
  assert.ok((drafts.instagram.match(/#[^\s#]+/g)||[]).length<=5);
}
assert.equal(promoPriceWarnings('커피 3,000원 · 차 4,000원',shop).length,0);
assert.equal(promoPriceWarnings('커피 2,500원',shop).length,1);
assert.equal(promoPriceWarnings('커피 2500',shop).length,1);
assert.equal(promoPriceWarnings('커피 4,000원',shop).length,1,'another item’s price is not valid');
assert.equal(promoPriceWarnings('커피 $3,000',shop).length,1,'currency must match');
assert.equal(promoPriceWarnings('영업시간 09:00–18:00 https://example.test/9000원',shop).length,0);
for (const channel of PROMO_CHANNELS) {
  const text=limitPromo(('아주 긴 글\n'.repeat(800))+'#a #b #c #d #e #f #g https://other.test',channel,shop.orderUrl);
  assert.ok(text.includes(shop.orderUrl));
  assert.ok(!text.includes('https://other.test'));
  assert.ok(promoLength(text,channel)<=PROMO_LIMITS[channel]);
  if(channel==='kakao')assert.equal(text.split('\n').length,3);
  if(channel==='instagram')assert.ok((text.match(/#[^\s#]+/g)||[]).length<=5);
}
const empty = promoShop({},'ko');
assert.equal(empty.orderUrl,'');
assert.equal(templatePromo(empty,'ko').x,'');
assert.equal(templatePromo(promoShop({name_ko:'이름만'},'ko'),'ko').kakao.split('\n').length,3);
assert.equal(promoShop({order_url:'javascript:alert(1)'},'ko').orderUrl,'');
assert.equal(promoShop({order_url:'https://user:pass@example.test'},'ko').orderUrl,'');
assert.equal(promoLength('가'.repeat(140),'x'),280);
assert.equal(promoLength('https://example.test/'+'x'.repeat(300),'x'),23);
for(const text of ['홍보 글 만들어 줘','오늘 특가 알려 줘','write a promotional post','宣伝を作って','制作宣传'])assert.ok(isPromoRequest(text));
assert.ok(!isPromoRequest('메뉴 가격 바꿔 줘'));
const ai=readFileSync('src-tauri/src/ai.rs','utf8');
const command=ai.slice(ai.indexOf('pub async fn ai_promo('),ai.indexOf('mod promo_tests'));
assert.ok(command.includes('Lane::Owner') && command.includes('permit.charge()') && command.includes('try_order(&provider, false)'));
assert.ok(command.includes('crate::shop::shop_load()') && !command.includes('ai_chat('));
assert.ok(ai.includes('가게 데이터에 없는 할인·가격·효능·수익 약속 금지, 모르면 비워 두기'));
const translations = {};
vm.runInNewContext(compile('src/desktop-copy.ts'),{exports:translations});
for(const [key,values] of Object.entries(translations.PROMO_COPY)) assert.ok(values.length===3 && values.every(s=>s && s!==key));
console.log('PASS production promo: saved public facts, four languages/channels, templates, matching item/currency prices, limits, three lines, ≤5 hashtags, QR links, owner budget and translated copy');
