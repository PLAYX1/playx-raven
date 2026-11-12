// 11-13 가게 링크 두 갈래(src/shop-link.ts) — 무료 고정 링크면 「임시 주소」 경고가 안 뜨고, 라비가 「가게 링크 알려 줘」를 알아듣고, 가격은 한 상수에서.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
const root = resolve(import.meta.dirname, '..');
const load = (f) => {
  const js = ts.transpileModule(readFileSync(resolve(root, f), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const mod = { exports: {} };
  vm.runInNewContext(js, { module: mod, exports: mod.exports, setTimeout, Date });
  return mod.exports;
};
const S = load('src/shop-link.ts');
const own = 'https://ravenvault.ex.erci.se/s/playx-gym-ymr3qhcu';

test('무료 고정 링크면 임시 주소 경고를 안 띄운다', () => {
  assert.equal(S.shopLinkKind(own, own), 'free');
  assert.equal(S.shopLinkKind(own + '/', own), 'free');
  assert.equal(S.shopLinkKind('https://abc-def.trycloudflare.com', own), 'temporary');
  assert.equal(S.shopLinkKind('', own), 'none');
  assert.equal(S.shopLinkKind('https://shop.tail1.ts.net', own), 'fixed');
  // 남의 /s/ 링크는 「내 무료 링크」가 아니다(고정 주소로만 본다 — 경고 대상도 아님)
  assert.equal(S.shopLinkKind('https://ravenvault.ex.erci.se/s/other-abcdefgh', own), 'fixed');
});

test('무료 고정 링크 모양 — map_format.rs is_shop_link_url 과 같다', () => {
  assert.equal(S.isFreeShopLink(own), true);
  for (const bad of ['https://ravenvault.ex.erci.se/s/SHOP.PLAYX', 'https://evil.com/s/playx-gym-ymr3qhcu', 'http://ravenvault.ex.erci.se/s/playx-gym-ymr3qhcu', 'https://ravenvault.ex.erci.se/s/playx-gym-YMR3QHCU']) assert.equal(S.isFreeShopLink(bad), false, bad);
  const rs = readFileSync(resolve(root, 'src-tauri/src/map_format.rs'), 'utf8');
  assert.ok(rs.includes('"https://ravenvault.ex.erci.se/s/"'), 'Rust 도 같은 주소 앞부분');
});

test('라비: 「가게 링크 알려 줘」를 알아듣고, 지갑 주소는 건드리지 않는다', () => {
  for (const q of ['가게 링크 알려 줘', '가게 주소 뭐야', '가게 링크 복사해 줘', '손님한테 보낼 링크 알려줘', 'shop link']) assert.equal(S.raviShopLinkTellIntent(q), true, q);
  for (const q of ['지갑 주소 알려 줘', '받는 주소 알려줘', '잔액 알려 줘', '지도에 올려 줘']) assert.equal(S.raviShopLinkTellIntent(q), false, q);
});

test('가격은 한 상수 — 확인한 날·「약」 표기', () => {
  const p = S.SHOP_LINK_PRICES;
  assert.match(p.checked, /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(p.tailscaleStandardUsdMonth > 0 && p.comDomainUsdYear > 0);
  assert.equal(S.wonPlain(15000), '1만 5천 원');
  assert.equal(S.wonPlain(12000), '1만 2천 원');
  assert.equal(S.wonPlain(20000), '2만 원');
  assert.ok(S.domainPriceText('ko').includes('1만 5천 원'));
  assert.ok(!/[가-힣]/.test(S.tailscalePriceText('en')));
  const card = readFileSync(resolve(root, 'src/map-card.ts'), 'utf8');
  assert.ok(card.includes('약 {0}'), '화면 문구는 「약」을 붙인다');
  assert.ok(!/\$\d/.test(card.replace(/\/\*[\s\S]*?\*\//g, '')), '가격 숫자를 map-card.ts 에 직접 쓰지 않는다');
});

test('화면: 두 갈래가 있고 무료가 먼저, 유료 안에 테일스케일 단추', () => {
  const html = readFileSync(resolve(root, 'index.html'), 'utf8');
  const free = html.indexOf('id="mp-opt-free"'), paid = html.indexOf('id="mp-opt-paid"'), tsgo = html.indexOf('id="mp-ts-go"');
  assert.ok(free > 0 && paid > free && tsgo > paid, '무료 → 유료(테일스케일 단추는 유료 안)');
  assert.ok(html.includes('컴퓨터를 다시 켠 직후 잠깐(1분 안팎) 손님이 못 들어올 수 있어요.'));
  assert.ok(/\.mplinkrow button \{ white-space: nowrap; flex-shrink: 0; \}/.test(html), '단추 글자 두 줄 금지');
  const card = readFileSync(resolve(root, 'src/map-card.ts'), 'utf8');
  const i = card.indexOf('if (kind === "free")'), j = card.indexOf('} else if (temporary)', i);
  assert.ok(i > 0 && j > i && !card.slice(i, j).includes('임시 주소'), '무료 링크 갈래에는 임시 주소 경고가 없다');
});
