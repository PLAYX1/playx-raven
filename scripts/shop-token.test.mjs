// 가게 토큰 이름 — 새 가게 `RV.S.<이름>`(대표 확정 2026-10-11)·옛 가게 `SHOP.<이름>` 읽기 호환.
// 화면 쪽(src/shop-token.ts). Rust 쪽 같은 규칙은 src-tauri/src/shop.rs rv_s_tests.
// 체인·지갑·노드는 부르지 않는다(순수 함수 + 소스 대조).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve, join } from 'node:path';
import { build } from 'esbuild';

const root = resolve(import.meta.dirname, '..');
const built = await build({
  stdin: { contents: "export * from './src/shop-token.ts'; export { DESKTOP_COPY } from './src/desktop-copy.ts'; export { MAX_ASSET_NAME, RESERVED_WORDS, checkCreatorAssetName } from './core/creator/asset-name.ts';", resolveDir: root, loader: 'ts' },
  bundle: true, write: false, platform: 'node', format: 'cjs', logLevel: 'silent', loader: { '.json': 'json' },
});
const mod = { exports: {} };
new Function('require', 'exports', 'module', built.outputFiles[0].text)(createRequire(import.meta.url), mod.exports, mod);
const T = mod.exports;
const src = p => readFileSync(join(root, p), 'utf8');

test('새 가게 앞부분은 RV.S. — 제작자 규칙 RV.<종류>. 의 S 칸', () => {
  assert.equal(T.SHOP_PREFIX, 'RV.S.');
  assert.equal(T.LEGACY_SHOP_PREFIX, 'SHOP.');
  assert.deepEqual([...T.SHOP_SEARCH_PATTERNS], ['RV.S.*', 'SHOP.*']);
  // 제작자 종류 글자(M·G·B·T·X)와 겹치지 않는다 — 겹치면 가게가 음악·게임 칸에 앉는다.
  assert.equal(T.checkCreatorAssetName('RV.S.KIMBAP').valid, false, '제작자 규칙은 S 를 모른다(가게는 따로 검사)');
});

test('이름 검사 — 예약어·30자·허용 문자·종류 글자', () => {
  assert.equal(T.checkShopAssetName('RV.S.PLAYX').valid, true);
  assert.equal(T.checkShopAssetName('RV.S.GANGNAM_CAFE').valid, true);
  for (const w of T.RESERVED_WORDS) {
    const r = T.checkShopAssetName('RV.S.' + w);
    assert.equal(r.valid, false, w);
    assert.ok(r.problems.includes(T.SHOP_NAME_SAY.reserved), w);
  }
  assert.equal(T.checkShopAssetName('RV.S.MY.RAVEN').valid, false, '점으로 나뉜 칸의 예약어');
  assert.equal(T.checkShopAssetName('RV.S.RAVENS_NEST').valid, true, '낱말 일부는 괜찮다');
  const thirty = 'RV.S.' + 'A'.repeat(25);
  assert.equal(thirty.length, T.MAX_ASSET_NAME);
  assert.equal(T.checkShopAssetName(thirty).valid, true);
  assert.deepEqual(T.checkShopAssetName(thirty + 'B').problems, [T.SHOP_NAME_SAY.long]);
  for (const bad of ['RV.S.cafe', 'RV.S.CAFE-1', 'RV.S.카페', 'RV.S.CA FE', 'RV.S.CAFE!'])
    assert.ok(T.checkShopAssetName(bad).problems.includes(T.SHOP_NAME_SAY.chars), bad);
  for (const bad of ['RV.S.CAFE__1', 'RV.S._CAFE', 'RV.S.CAFE.', 'RV.S.CA._FE'])
    assert.ok(T.checkShopAssetName(bad).problems.includes(T.SHOP_NAME_SAY.punct), bad);
  assert.deepEqual(T.checkShopAssetName('RV.S.').problems, [T.SHOP_NAME_SAY.empty]);
  // 종류 글자 — 가게는 S 뿐. 옛 SHOP. 으로 새로 만들지 않는다.
  for (const bad of ['RV.M.CAFE', 'RV.X.CAFE', 'SHOP.NEWCAFE', 'CAFE', ''])
    assert.ok(T.checkShopAssetName(bad).problems.includes(T.SHOP_NAME_SAY.prefix), bad);
});

test('입력 → 새 가게 이름 제안(한글은 폰과 같은 로마자 표)', () => {
  assert.equal(T.suggestShopAssetName('gangnam cafe'), 'RV.S.GANGNAM_CAFE');
  assert.equal(T.suggestShopAssetName('GANGNAM_CAFE'), 'RV.S.GANGNAM_CAFE');
  assert.equal(T.suggestShopAssetName('Kim-bap 2'), 'RV.S.KIM_BAP_2');
  assert.equal(T.suggestShopAssetName('강남 카페'), 'RV.S.GANGNAM_KAPE');
  assert.equal(T.suggestShopAssetName('김밥천국'), 'RV.S.GIMBAPCHEONGUK');
  // 이미 앞부분을 적었으면 떼고 다시 붙인다 — 옛 SHOP. 을 적어도 새 가게는 RV.S. 다.
  assert.equal(T.suggestShopAssetName('RV.S.PLAYX'), 'RV.S.PLAYX');
  assert.equal(T.suggestShopAssetName('shop.playx'), 'RV.S.PLAYX');
  assert.equal(T.suggestShopAssetName('rv.s.shop.x'), 'RV.S.X');
  assert.equal(T.suggestShopAssetName(''), '');
  assert.equal(T.suggestShopAssetName('日本'), '', '로마자로 못 바꾸는 글자만이면 빈 이름 → 검사에서 막힌다');
  const long = T.suggestShopAssetName('a very long shop name that keeps going on');
  assert.ok(long.length <= 30 && T.checkShopAssetName(long).valid, long);
  for (const s of ['강남 카페', 'gangnam cafe', 'Kim-bap 2', '김밥천국']) assert.equal(T.checkShopAssetName(T.suggestShopAssetName(s)).valid, true, s);
});

test('옛 가게 SHOP.PLAYX 호환 읽기 — 이 가게의 토큰 이름 한 값', () => {
  assert.equal(T.shopTokenOf({ chain_asset: 'SHOP.PLAYX' }), 'SHOP.PLAYX');
  assert.equal(T.shopTokenOf({ chain_asset: ' RV.S.KIMBAP ' }), 'RV.S.KIMBAP');
  // 이미 저장된 다른 모양(하위 자산 가게)은 바꿔 읽지 않는다.
  assert.equal(T.shopTokenOf({ chain_asset: 'HOMEFIT/SHOP' }), 'HOMEFIT/SHOP');
  for (const v of [{}, { chain_asset: '' }, { chain_asset: 'SHOP.PLAYX!' }, { chain_asset: 'A#B' }, { chain_asset: 'shop.playx' }, null, 'SHOP.PLAYX', { chain_asset: 'X'.repeat(31) }])
    assert.equal(T.shopTokenOf(v), null, JSON.stringify(v));
  assert.equal(T.shopNameStyle('SHOP.PLAYX'), 'legacy');
  assert.equal(T.shopNameStyle('RV.S.KIMBAP'), 'rv');
  for (const v of ['SHOP.PLAYX!', 'RV.S.', 'SHOP.', 'RV.M.SONG', 'SHOP.X/Y', 'PLAYX', 7]) assert.equal(T.shopNameStyle(v), null, String(v));
});

test('새 RV.S. 가게 표시 — 앞부분만 뗀 간판 이름', () => {
  assert.equal(T.shopLabel('RV.S.GANGNAM_CAFE'), 'GANGNAM_CAFE');
  assert.equal(T.shopLabel('SHOP.PLAYX'), 'PLAYX');
  assert.equal(T.shopLabel('HOMEFIT/SHOP'), 'HOMEFIT/SHOP');
  // 장터 화면(web/shops.html)도 두 앞부분을 다 뗀다.
  const shops = src('web/shops.html');
  assert.doesNotMatch(shops, /replace\(\/\^SHOP\\\.\/, ""\)/);
  assert.equal((shops.match(/replace\(\/\^\(\?:RV\\\.S\|SHOP\)\\\.\/, ""\)/g) || []).length, 3);
});

test('화면이 SHOP.PLAYX 를 박아 두지 않는다 — 가게 토큰 이름 한 값을 읽는다', () => {
  const main = src('src/main.ts');
  assert.doesNotMatch(main, /assets\.get\("SHOP\.PLAYX"\)/);
  assert.doesNotMatch(main, /openSend\("asset", "SHOP\.PLAYX"\)/);
  assert.doesNotMatch(main, /t\("SHOP\.PLAYX/);
  assert.doesNotMatch(main, /tf\("SHOP\.PLAYX/);
  assert.match(main, /const token = await currentShopToken\(\);[\s\S]{0,400}assets\.get\(token\)/);
  assert.match(main, /void openSend\("asset", token\)/);
  // 새 가게 이름은 화면 규칙으로 만들고, 같은 이름으로 노드에 묻는다(사장이 친 글자가 아니라).
  assert.match(main, /const full = suggestShopAssetName\(raw\);/);
  assert.match(main, /invoke<unknown>\("shop_name_free", \{ name: full \}\)/);
  assert.doesNotMatch(src('index.html'), /SHOP\.PLAYX/);
  assert.match(src('index.html'), /id="sh-assetrule">공개 장부 이름은 RV\.S\.가게이름 모양/);
});

test('번역 — 새 문구는 en·ja·zh, 자리표시자 그대로, 옛 SHOP.PLAYX 열쇠는 없다', () => {
  const keys = [
    '가게 토큰 수량 확인 중…', '{0}  {1}개 남음', '{0} 가 없습니다. 손님에게 줄 토큰이 없습니다.', '{0} 수량을 못 읽었습니다. 서버가 켜져 있는지 보세요.',
    '아직 공개 장부에 올린 가게가 없습니다. 「가게」에서 먼저 등록해 주세요.', '공개 장부에 이 이름으로 남습니다', '이 가게의 토큰: {0}',
    src('index.html').match(/id="sh-assetrule">([^<]+)</)[1],
    ...Object.values(T.SHOP_NAME_SAY),
  ];
  const vars = s => [...s.matchAll(/\{(\w+)\}/g)].map(m => m[1]).sort().join(',');
  for (const k of keys) {
    const row = T.DESKTOP_COPY[k];
    assert.ok(Array.isArray(row) && row.length === 3 && row.every(Boolean), k);
    for (const v of row) {
      assert.equal(vars(v), vars(k), `${k} → ${v}`);
      assert.doesNotMatch(v, /[가-힣]/, v);
    }
  }
  for (const k of Object.keys(T.DESKTOP_COPY)) assert.doesNotMatch(k, /SHOP\.PLAYX/, k);
  assert.doesNotMatch(src('src/dict.ts'), /SHOP\.PLAYX/);
  for (const lang of ['it', 'es', 'fr', 'pt-BR', 'de', 'ru'])
    assert.ok(!Object.keys(JSON.parse(src(`public/i18n/${lang}.json`)).dict).some(k => k.includes('SHOP.PLAYX')), lang);
});

test('Rust 쪽과 같은 규칙 — 앞부분·패턴·문구', () => {
  const rs = src('src-tauri/src/shop.rs');
  assert.match(rs, /pub const SHOP_PREFIX: &str = "RV\.S\.";/);
  assert.match(rs, /pub const LEGACY_SHOP_PREFIX: &str = "SHOP\.";/);
  assert.match(rs, /pub const SHOP_PATTERNS: \[&str; 2\] = \["RV\.S\.\*", "SHOP\.\*"\];/);
  assert.match(rs, /const MAX_NAME: usize = 30;/);
  assert.match(rs, /const RESERVED: \[&str; 3\] = \["RVN", "RAVEN", "RAVENCOIN"\];/);
  for (const say of Object.values(T.SHOP_NAME_SAY)) assert.ok(rs.includes(`"${say}"`), `shop.rs 에 「${say}」가 없다`);
  // 주인 찾기·장터 목록·돕기는 두 모양을 다 읽는다.
  assert.match(rs, /for pattern in \["RV\.S\.\*", "SHOP\*"\]/);
  assert.match(src('src-tauri/src/helping.rs'), /for pattern in crate::shop::SHOP_PATTERNS/);
});
