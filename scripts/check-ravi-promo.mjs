// Execute production logic against public synthetic facts. No AI or wallet calls.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
const compile = path => ts.transpileModule(readFileSync(path, 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
const exports = {};
vm.runInNewContext(compile('src/ravi-promo.ts'), { exports, URL, require:()=>({default:JSON.parse(readFileSync("src/ravi-promo-facts.json", "utf8"))}) });
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
  assert.ok(drafts.kakao.split('\n').length<=4);
  assert.ok((drafts.instagram.match(/#[^\s#]+/g)||[]).length>=8);
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

}
const empty = promoShop({},'ko');
assert.equal(empty.orderUrl,'');
assert.ok(templatePromo(empty,'ko').x.includes('메뉴를 먼저 등록하세요'));

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
assert.ok(!command.includes('request.chars().take('),'original request must not be silently truncated');
assert.ok(ai.includes('input["app_facts"]') && ai.includes('input["shop"]'));
assert.ok(ai.includes('가게 데이터에 없는 할인·가격·효능·수익 약속 금지, 모르면 비워 두기'));
const translations = {};
vm.runInNewContext(compile('src/desktop-copy.ts'),{exports:translations, require:()=>({default:JSON.parse(readFileSync('src/ravi-capabilities.json','utf8'))})});
for(const [key,values] of Object.entries(translations.PROMO_COPY)) assert.ok(values.length===3 && values.every(s=>s && s!==key));
console.log('PASS production promo: saved public facts, four languages/channels, templates, matching item/currency prices, limits, bilingual hashtags, QR links, owner budget and translated copy');

const {inferPromoTarget, promoImageUrl, appPromoUrl, promoFactWarnings, preparePromo, combinePromo, normalizeHashtags, HASHTAG_LIMITS, APP_PROMO_FACTS} = exports;
for (const r of ['레이븐볼트 홍보글 써 줘', 'RavenVault promo', '이 앱 홍보', '프로그램 홍보', '지갑 홍보']) assert.equal(inferPromoTarget(r),'app');
for (const r of ['내 가게 홍보', '메뉴 소개', '오늘 특가 홍보']) assert.equal(inferPromoTarget(r),'shop');
assert.equal(inferPromoTarget('동네 독서 모임 홍보글 써 줘'),'custom');
const filtered = promoShop({menu:[{name:'샘플 아메리카노',price:.01},{name:' Sample latte',price:10},{name:'예시 케이크',price:1},{name:'default',price:3,is_sample:true},{name:'카페라떼',price:5000,image:'QmbibWRDaWKyJKQPKjAr7N83ckz3eAyU34vKdWss1eUQF6'},{name:'진짜 메뉴',price:3}]},'ko');
assert.equal(filtered.menu.length,1); assert.equal(filtered.menu[0].name,'진짜 메뉴');
assert.deepEqual(Array.from(normalizeHashtags('#RVN #rvn #레이븐코인 #foo! #foo #hello-world')),['#RVN','#레이븐코인','#foo','#helloworld']);
const detailed = promoShop({...saved,category:'카페',location:'서울 강남'},'ko');
for(const lang of ['ko','en','ja','zh']) {
  assert.equal(APP_PROMO_FACTS[lang].length,9);
  assert.equal(promoImageUrl(empty,'app',lang),appPromoUrl(lang));
  assert.equal(promoImageUrl(shop,'app',lang),shop.orderUrl,'existing order URL takes precedence');
  assert.equal(promoImageUrl(promoShop({chain_asset:'SHOP.FIXTURE'},lang),'shop',lang),'https://rvn.ex.erci.se/s/SHOP.FIXTURE');
  for(const target of ['shop','app','custom']) {
    const drafts = templatePromo(detailed,lang,target,'동네 독서 모임');
    for(const channel of PROMO_CHANNELS) {
      const draft=preparePromo(drafts[channel],channel,detailed,target,lang);
      const tags=normalizeHashtags(draft.hashtags);
      assert.ok(tags.length>=HASHTAG_LIMITS[channel][0] && tags.length<=HASHTAG_LIMITS[channel][1]);
      assert.ok(tags.some(t=>/[가-힣]/.test(t)) && tags.some(t=>/^#[A-Za-z]+$/.test(t)));
      assert.ok(promoLength(combinePromo(draft.body,draft.hashtags),channel)<=PROMO_LIMITS[channel]);
      assert.ok(!draft.body.includes('#'),'separate hashtag field');
      if(lang==='ja')assert.ok(tags.some(t=>/[ァ-ヶ]/.test(t)));
      if(lang==='zh')assert.ok(tags.some(t=>/[渡钱包]/.test(t)));
      if(target==='shop')for(const word of ['시험카페','카페','서울강남'])assert.ok(draft.hashtags.includes(word));
      if(target==='app') {
        assert.ok(!draft.body.includes('시험 카페') && !draft.body.includes('커피'));
        assert.equal(promoFactWarnings(draft.body).length,0);
      }
    }
  }
}
const long=preparePromo('가'.repeat(500)+' #RVN #rvn #fake','x',detailed,'app','ko');
assert.ok(promoLength(combinePromo(long.body,long.hashtags),'x')<=280);
assert.ok(long.body.endsWith(appPromoUrl('ko')));
assert.equal(promoImageUrl(empty,'shop','ko'),'','missing shop URL has an explicit UI reason');
assert.ok(promoFactWarnings('개발비 2% 수익 100%').length===2);
assert.ok(promoFactWarnings('가격 전망 4 RVN').length>0);
assert.equal(promoFactWarnings('개발비 1%').length,0);
console.log('PASS targets, shared app fact sheet, original request, samples/default fixtures, QR fallbacks, bilingual tags + local language, channel tag limits, metadata, deduplication, X combined 280 and unsupported numbers');

const enormous=promoShop({...saved,name_ko:'가'.repeat(100),category:'나'.repeat(100),location:'다'.repeat(100)},'ko');
for(const lang of ['ko','en','ja','zh']) {
 const d=preparePromo('글'.repeat(500)+' #수익보장 #GuaranteedProfit','x',enormous,'shop',lang);
 assert.ok(promoLength(combinePromo(d.body,d.hashtags),'x')<=280);
 assert.ok(!d.hashtags.includes('GuaranteedProfit') && !d.hashtags.includes('수익보장'));
 assert.ok(d.hashtags.includes('가'.repeat(18)) && d.hashtags.includes('나'.repeat(18)) && d.hashtags.includes('다'.repeat(18)));
}
console.log('PASS very long shop metadata still leaves X within 280; generated claim hashtags cannot override curated tags');
