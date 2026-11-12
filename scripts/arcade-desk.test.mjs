// 장터 「바로 해 보는 게임」(데스크탑) — 순수 규칙 시험. 노드·IPFS·네트워크·실제 결제 없음. 던져 버리는 키만.
// 폰·웹과 같은 확인: 서명 문서만 믿는다 · 체인 RVLT 자산이 닻 · 받는 주소 = 문서 payTo · 수수료 1%(코드 고정 주소) · 예시 게임 없음.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { build } from 'esbuild';

const built = await build({ entryPoints: ['scripts/fixtures/arcade-entry.ts'], bundle: true, write: false, platform: 'node', format: 'cjs', logLevel: 'silent' });
const mod = { exports: {} };
new Function('require', 'exports', 'module', built.outputFiles[0].text)(createRequire(import.meta.url), mod.exports, mod);
const A = mod.exports;

const key = A.secp256k1.utils.randomPrivateKey();
const seller = A.addressOfPublicKey(A.secp256k1.getPublicKey(key, true));
const cidOf = n => 'Qm' + String(n).padStart(44, '1').replace(/0/g, 'A');
const body = (over = {}) => ({
  format: 'rv-arcade-product', v: 1, kind: 'arcade-game', id: 'star-run', version: 1, title: 'Star Run', description: 'one tap',
  priceSats: '100000000', seller, payTo: seller, feeBps: A.ARCADE_FEE_BPS, entry: 'index.html', cid: cidOf(9),
  files: [{ path: 'index.html', sha256: A.sha256Hex(A.utf8('h')), size: 1 }], x: { arcade: { mode: 'solo', network: 'none', minutes: 3, genre: 'puzzle' } },
  assetName: 'RVLT/PLAYX#STAR_RUN', ...over,
});
const b64 = bytes => Buffer.from(bytes).toString('base64');
const docB64 = (over, k = key) => b64(A.encodeArcadeProduct(A.signArcadeProductForTest(body(over), k)));

test('체인 자산 + 서명 문서 → 확인 판매자 상품 · 받는 주소는 문서 payTo · 게임 길은 확인된 사이트 길 하나', () => {
  const r = A.productsFromSources({ assets: [{ name: 'RVLT/PLAYX#STAR_RUN', ipfsHash: cidOf(1) }], docs: { [cidOf(1)]: docB64() } });
  assert.equal(r.items.length, 1);
  const p = r.items[0];
  assert.equal(p.verified, true); assert.equal(p.sellerAddress, seller); assert.equal(p.priceSats, 100_000_000);
  assert.equal(p.genre, 'puzzle'); assert.equal(p.docCid, cidOf(1)); assert.equal(p.sellerName, 'PLAYX');
  assert.equal(A.gameUrl(p), `https://ravenvault.ex.erci.se/arcade/ipfs/${cidOf(1)}/index.html`);
});

test('빈 체인·모양 틀린 답 → 빈 목록(예시 게임을 지어 넣지 않는다)', () => {
  for (const raw of [null, {}, { assets: 'x' }, { assets: [], docs: {} }, { assets: [{ name: 'RVLT/PLAYX#STAR_RUN', ipfsHash: cidOf(1) }] }]) {
    assert.deepEqual(A.productsFromSources(raw).items, []);
  }
  const src = readFileSync('src/arcade-market.ts', 'utf8') + readFileSync('src/arcade-model.ts', 'utf8');
  assert.doesNotMatch(src, /SAMPLE_ARCADE|sample-tap|sample:\s*true/, '데스크탑에는 예시 상품이 없다');
  assert.match(readFileSync('src/arcade-market.ts', 'utf8'), /아직 올라온 게임이 없어요/);
});

test('사칭·변조 거절: 다른 키로 서명 · 다른 자산 이름 · 바꾼 값 → 목록에 안 나온다', () => {
  const other = A.secp256k1.utils.randomPrivateKey();
  const forged = JSON.parse(Buffer.from(docB64(), 'base64').toString()); forged.priceSats = '1';
  const cases = [
    { name: 'RVLT/PLAYX#STAR_RUN', doc: docB64({}, other) },                      // seller 주소와 다른 키
    { name: 'RVLT/OTHER#STAR_RUN', doc: docB64() },                                // 남의 문서를 내 자산에
    { name: 'RVLT/PLAYX#STAR_RUN', doc: b64(Buffer.from(JSON.stringify(forged))) }, // 값만 바꿈(서명 깨짐)
  ];
  for (const c of cases) assert.equal(A.productsFromSources({ assets: [{ name: c.name, ipfsHash: cidOf(2) }], docs: { [cidOf(2)]: c.doc } }).items.length, 0, c.name);
});

test('결제 준비: 문서 다시 확인 · 99/1 나누기 · 수수료 주소 코드 고정 · 화면 값이 바뀌면 거절 · 무료는 결제 없음', () => {
  const [p] = A.productsFromSources({ assets: [{ name: 'RVLT/PLAYX#STAR_RUN', ipfsHash: cidOf(1) }], docs: { [cidOf(1)]: docB64() } }).items;
  const plan = A.prepareArcadePay(p);
  assert.deepEqual([plan.sellerAtoms, plan.feeAtoms, plan.priceAtoms], [99_000_000, 1_000_000, 100_000_000]);
  assert.equal(plan.feeAddress, A.MARKET_FEE_ADDRESS); assert.equal(plan.feeAddress, 'RLFnbkjmf1VCVq7D9TZvRp7fv6W97rm2cB');
  assert.equal(plan.payTo, seller);
  assert.throws(() => A.prepareArcadePay({ ...p, sellerAddress: A.MARKET_FEE_ADDRESS }), /mismatch/);
  assert.throws(() => A.prepareArcadePay({ ...p, priceSats: 1 }), /mismatch/);
  const [free] = A.productsFromSources({ assets: [{ name: 'RVLT/PLAYX#STAR_RUN', ipfsHash: cidOf(1) }], docs: { [cidOf(1)]: docB64({ priceSats: '0' }) } }).items;
  assert.equal(A.playsWithoutPay(free), true);
  assert.throws(() => A.prepareArcadePay(free), /free/);
  // 러스트 arcade.rs split_price 와 같은 규칙(올림·먼지 1000) — 같은 수를 두 곳에서 본다.
  for (const [price, s, f] of [[100_000_000, 99_000_000, 1_000_000], [100_001, 99_000, 1_001], [50_000, 49_000, 1_000]]) {
    const x = A.splitPrice(price, 100); assert.deepEqual([Number(x.sellerAtoms), Number(x.feeAtoms)], [s, f]);
  }
  const rs = readFileSync('src-tauri/src/arcade.rs', 'utf8');
  assert.match(rs, /assert_eq!\(split_price\(100_001\)\.unwrap\(\), \(99_000, 1_001\)\)/);
  assert.match(rs, new RegExp(`ARCADE_FEE_ADDRESS: &str = "${A.MARKET_FEE_ADDRESS}"`));
});

test('잠긴 게임·틀린 경로는 열지 않는다 · iframe 길은 CSP frame-src 와 같다', () => {
  const lock = { scheme: 'rv-lock-v1', keyId: 'ab'.repeat(16), paths: ['index.html'] };
  const [locked] = A.productsFromSources({ assets: [{ name: 'RVLT/PLAYX#STAR_RUN', ipfsHash: cidOf(1) }], docs: { [cidOf(1)]: docB64({ lock }) } }).items;
  assert.ok(locked, 'lock 문서도 서명이 맞으면 목록에 나온다'); assert.equal(locked.locked, true); assert.equal(A.gameUrl(locked), null);
  assert.equal(A.gameUrl({ docCid: cidOf(1), entry: '../x.html', locked: false }), null);
  assert.equal(A.gameUrl({ docCid: 'Qm/../../x', entry: 'index.html', locked: false }), null);
  const csp = JSON.parse(readFileSync('src-tauri/tauri.conf.json', 'utf8')).app.security.csp['frame-src'];
  assert.ok(csp.split(' ').includes(A.ARCADE_LINK_BASE), 'CSP frame-src 에 게임 길이 있어야 iframe 이 열린다');
  const ui = readFileSync('src/arcade-market.ts', 'utf8');
  assert.match(ui, /setAttribute\("sandbox", "allow-scripts"\)/);
  assert.doesNotMatch(ui, /allow-same-origin|allow-popups|allow-top-navigation/);
  // 게임 메시지는 이 iframe 의 contentWindow(불투명 출처 'null')에서 온 것만, 정해진 모양만(arcade-credit parseGameMessage).
  assert.match(ui, /if \(e\.source !== frame\.contentWindow \|\| e\.origin !== "null"\) return;/);
  assert.match(ui, /const m = parseGameMessage\(e\.data\);\n\s+if \(!m\) return;/);
});

test('한 판 넣기: 게임이 물을 때마다 사람이 「한 판 X 넣기」를 눌러야 보낸다 · 미리 넣은 돈 없음 · 다시 내기 막기', () => {
  const ui = readFileSync('src/arcade-market.ts', 'utf8');
  const calls = [...ui.matchAll(/invoke<[^>]*>\("arcade_pay"|invoke\("arcade_pay"/g)];
  assert.equal(calls.length, 1, 'arcade_pay 부름은 한 곳');
  const askAt = ui.indexOf('function askCoin'), goAt = ui.indexOf('go.onclick', askAt), payAt = ui.indexOf('"arcade_pay"');
  assert.ok(askAt > 0 && goAt > askAt && payAt > goAt, 'arcade_pay 는 askCoin 의 「넣기」 누름 안에서만');
  assert.match(ui, /askCoin\(p, plan!, coin/, '유료 ask 는 확인 칸으로');
  assert.match(ui, /if \(free\) \{ gate\.settle\(\); grant\(\); return; \}/, '무료는 묻지 않고 크레딧');
  assert.doesNotMatch(ui, /localStorage[^\n]*(credit|balance|prepaid)/i, '크레딧·잔액을 저장하지 않는다');
  assert.match(ui, /isSentUnknown\(e\)/);
});

test('문구 표: 화면의 한국어 열쇠마다 영·일·중이 있다 · 단추는 줄바꿈 금지', () => {
  const copy = readFileSync('src/arcade-copy.ts', 'utf8');
  const keys = new Set([...copy.matchAll(/^\s*"([^"]+)": \[/gm)].map(m => m[1]));
  const ui = readFileSync('src/arcade-market.ts', 'utf8');
  const used = [...ui.matchAll(/(?:copyHtml|\bt|tf|row)\("([^"]*[가-힣][^"]*)"/g)].map(m => m[1]);
  for (const k of used) assert.ok(keys.has(k), `번역 없음: ${k}`);
  for (const m of copy.matchAll(/^\s*"[^"]+": \[("[^"]*"), ("[^"]*"), ("[^"]*")\]/gm)) for (const v of m.slice(1)) assert.doesNotMatch(v, /[가-힣]/);
  assert.match(readFileSync('src/arcade-market.css', 'utf8'), /\.ar button \{ white-space: nowrap; flex-shrink: 0; \}/);
});

// ── 11-13 게임은 판매자 컴퓨터에 산다 · 돕기 보관은 기본 꺼짐 · 못 받는 게임은 돈을 받지 않는다 ──
test('돕기 보관 후보 = 구매 화면과 같은 확인을 통과한 체인 게임만(서명·assetName)', () => {
  const other = A.secp256k1.utils.randomPrivateKey();
  const raw = {
    assets: [
      { name: 'RVLT/PLAYX#STAR_RUN', ipfsHash: cidOf(1) },
      { name: 'RVLT/PLAYX#FAKE', ipfsHash: cidOf(2) },      // 다른 키로 서명
      { name: 'RVLT/OTHER#STAR_RUN', ipfsHash: cidOf(3) },  // 남의 문서를 내 자산에
    ],
    docs: { [cidOf(1)]: docB64(), [cidOf(2)]: docB64({ assetName: 'RVLT/PLAYX#FAKE', id: 'fake' }, other), [cidOf(3)]: docB64() },
  };
  assert.deepEqual(A.shareCandidates(raw), [{ docCid: cidOf(1), verified: true, listing: 'verified' }]);
  assert.deepEqual(A.shareCandidates(null), []);
});

test('보관 상태 글: 가게별 「PLAYX 게임 7개 보관 중 · 0.4 MB」 재료 · 크기 글자', () => {
  assert.deepEqual(A.shareRows({ shops: [{ shop: 'PLAYX', games: 7, bytes: 419430 }, { shop: '', games: 1, bytes: 1 }, { shop: 'X', games: 0, bytes: 0 }] }), [['PLAYX', 7, '0.4 MB']]);
  assert.equal(A.mbText(0), '0.0 MB');
  assert.equal(A.mbText(1), '0.1 MB', '0 이 아니면 0.0 이라 하지 않는다');
  assert.equal(A.mbText(5 * 1048576), '5.0 MB');
  assert.deepEqual(A.shareRows(undefined), []);
  const ui = readFileSync('src/arcade-keep.ts', 'utf8');
  assert.match(ui, /\{0\} 게임 \{1\}개 보관 중 · \{2\}/);
  assert.match(ui, /내 컴퓨터가 꺼져 있으면 손님이 게임을 못 해요/);
});

test('「지금 쉬는 중」: 최근 실패만 · 오래되면 잊는다 · 확인한 적 없으면 쉬는 중이라 하지 않는다', () => {
  const log = new Map();
  assert.equal(A.isResting(log, 'Q', 1000), false);
  A.noteReach(log, 'Q', false, 1000);
  assert.equal(A.isResting(log, 'Q', 1000 + A.REST_MS - 1), true);
  assert.equal(A.isResting(log, 'Q', 1000 + A.REST_MS), false);
  A.noteReach(log, 'Q', true, 2000);
  assert.equal(A.isResting(log, 'Q', 2001), false);
});

test('🔴 결제 확인 칸 전에 늘 다시 확인 · 못 받으면 「판매자 컴퓨터가 꺼져 있어서…」 · 돈 받는 길 없음', () => {
  const src = readFileSync('src/arcade-market.ts', 'utf8');
  assert.match(src, /판매자 컴퓨터가 꺼져 있어서 지금은 할 수 없어요/);
  const ask = src.indexOf('askCoin(p, plan!');
  const check = src.lastIndexOf('reachNow(p)', ask);
  assert.ok(check > 0 && ask - check < 600, '확인 칸(askCoin) 바로 앞에 reachNow');
  assert.match(src.slice(check, ask), /if \(!ok\)[\s\S]*denyMessage\("failed"\)/);
  const rs = readFileSync('src-tauri/src/arcade.rs', 'utf8');
  assert.match(rs, /\/g\/\{doc_cid\}\/doc/, '문서도 본다');
  assert.match(rs, /REACH_SECS: u64 = 5/, '짧게 기다린다');
});

test('🔴 플랫폼은 남의 게임 창고가 아니다: 특정 컴퓨터 주소·모드로 켜는 코드 없음 · 돕기는 기본 꺼짐', () => {
  const files = ['src/arcade-keep.ts', 'src/arcade-keep-core.ts', 'src-tauri/src/arcade_keep.rs'];
  for (const f of files) {
    const s = readFileSync(f, 'utf8').split('#[cfg(test)]')[0];
    assert.doesNotMatch(s, /taile277f6|N100|n100/, f);
  }
  const rs = readFileSync('src-tauri/src/arcade_keep.rs', 'utf8');
  assert.match(rs, /Share \{ mode: Mode::Off/);
});
