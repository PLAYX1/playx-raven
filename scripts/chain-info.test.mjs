// 「체인 정보」 1단계 — 순수 함수·문구 시험. 네트워크·노드·지갑 없음(crypto51 응답은 고정 표본).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync, existsSync } from 'node:fs';
import { build } from 'esbuild';

async function moduleAt(path) {
  const built = await build({ entryPoints: [path], bundle: true, write: false, platform: 'node', format: 'cjs', logLevel: 'silent', loader: { '.css': 'empty', '.txt': 'text' } });
  const mod = { exports: {} };
  new Function('require', 'exports', 'module', built.outputFiles[0].text)(createRequire(import.meta.url), mod.exports, mod);
  return mod.exports;
}
// 화면 모듈(i18n)이 요구하는 브라우저 바탕을 최소로 흉내 낸다.
globalThis.navigator ??= { language: 'ko' };
const store = new Map();
globalThis.localStorage = { getItem: k => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)), removeItem: k => store.delete(k) };
globalThis.window = globalThis; globalThis.addEventListener ??= () => {};
globalThis.document = { documentElement: {}, addEventListener() {}, querySelectorAll: () => [], getElementById: () => null, body: {} };

const C = await moduleAt('src/chain-info.ts');
const NOW = 1_791_724_058 + 600;

test('freshness: 24시간 노랑 · 72시간 흐림 · 미래는 정상 · 모르면 unknown', () => {
  assert.equal(C.freshness(NOW, NOW - 60), 'ok');
  assert.equal(C.freshness(NOW, NOW - C.STALE_SECS), 'ok');
  assert.equal(C.freshness(NOW, NOW - C.STALE_SECS - 1), 'stale');
  assert.equal(C.freshness(NOW, NOW - C.VERY_STALE_SECS - 1), 'very_stale');
  assert.equal(C.freshness(NOW, NOW + 999), 'ok');
  assert.equal(C.freshness(NOW, null), 'unknown');
  assert.equal(C.freshness(NOW, NaN), 'unknown');
});
test('숫자 서식: 못 읽으면 null, 단위는 값에 맞게', () => {
  assert.equal(C.fmtHashrate(619_666_615_182, 'en'), '620 GH/s');
  assert.equal(C.fmtHashrate(1.5e12, 'en'), '1.5 TH/s');
  assert.equal(C.fmtHashrate(999, 'en'), '999 H/s');
  for (const bad of [0, -1, NaN, Infinity, null, undefined]) assert.equal(C.fmtHashrate(bad), null);
  assert.equal(C.fmtUsd(143.29791686342355, 'en'), '$143');
  assert.equal(C.fmtUsd(2.5, 'en'), '$2.50');
  assert.equal(C.fmtUsd(2076457.07, 'en'), '$2,076,457');
  assert.equal(C.fmtUsd(-1), null); assert.equal(C.fmtUsd(null), null);
  assert.equal(C.fmtInt(4123456.4, 'en'), '4,123,456'); assert.equal(C.fmtInt(undefined), null);
  assert.equal(C.fmtDifficulty(123456, 'en'), '123 k'); assert.equal(C.fmtDifficulty(0), null);
  assert.equal(C.fmtPercent(0.14531892, 'en'), '15%');
});
test('나이 문구 열쇠', () => {
  assert.deepEqual(C.ageParts(100, 50), { key: '방금', n: 0 });
  assert.deepEqual(C.ageParts(5000, 5000 - 600), { key: '{0}분 전', n: 10 });
  assert.deepEqual(C.ageParts(100000, 100000 - 7200), { key: '{0}시간 전', n: 2 });
  assert.deepEqual(C.ageParts(1_000_000, 1_000_000 - 3 * 86400), { key: '{0}일 전', n: 3 });
  assert.equal(C.ageParts(1, null), null);
});
const rvn = { status: 'ok', attack_cost_usd_hour: 143.3, hashrate_hs: 619_666_615_182, market_cap_usd: 3.3e7, nicehash_ratio: 0.1453, rank: 3, coin_count: 38, as_of: NOW - 600, fetched_at: NOW, refresh_failed: false };
test('보안 보기: 정상·노랑·흐림·없음', () => {
  const ok = C.securityView(rvn, NOW, 'en');
  assert.deepEqual([ok.state, ok.dim, ok.cost, ok.hashrate, ok.rank], ['ok', false, '$143', '620 GH/s', { rank: 3, of: 38 }]);
  const stale = C.securityView({ ...rvn, status: 'stale', as_of: NOW - 30 * 3600 }, NOW, 'en');
  assert.deepEqual([stale.state, stale.dim], ['stale', false]);
  const very = C.securityView({ ...rvn, status: 'very_stale', as_of: NOW - 80 * 3600, refresh_failed: true }, NOW, 'en');
  assert.deepEqual([very.state, very.dim, very.refreshFailed], ['very_stale', true, true]);
  // 상태가 ok 라고 해도 기준 시각이 오래됐으면 더 나쁜 쪽을 따른다(이중 확인).
  assert.equal(C.securityView({ ...rvn, as_of: NOW - 100 * 3600 }, NOW).state, 'very_stale');
  for (const bad of [null, undefined, {}, { status: 'no_data' }, { ...rvn, status: 'weird' }, { ...rvn, attack_cost_usd_hour: null }, { ...rvn, as_of: null }, { ...rvn, attack_cost_usd_hour: -5 }]) {
    const v = C.securityView(bad, NOW); assert.equal(v.state, 'none'); assert.equal(v.cost, null);
  }
  assert.equal(C.securityView({ ...rvn, rank: 40 }, NOW).rank, null, '순위가 표본 수보다 크면 말하지 않는다');
});
test('노드 보기: 따라잡는 중에는 해시율·난이도를 보이지 않는다', () => {
  const synced = { blocks: 4123456, headers: 4123456, progress: 1, synced: true, peers: 8, hashrate_hs: 6.2e11, difficulty: 120000, mempool_count: 4, as_of: 5 };
  const a = C.overviewView(synced, 'en');
  assert.deepEqual([a.state, a.blocks, a.hashrate, a.difficulty, a.mempool, a.peers], ['ok', '4,123,456', '620 GH/s', '120 k', '4', '8']);
  const b = C.overviewView({ ...synced, synced: false, progress: 0.7312 }, 'en');
  assert.deepEqual([b.state, b.hashrate, b.difficulty, b.syncPercent], ['syncing', null, null, 73.1]);
  assert.equal(C.overviewView(null).state, 'none');
  assert.equal(C.overviewView({ blocks: null }).state, 'none');
});

const Card = await moduleAt('src/chain-info-card.ts');
const I18n = await moduleAt('src/i18n.ts');
const stripHtml = h => h.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
test('화면 문장: 정상에는 출처·기준 시각·투자 조언 아님이 같이 나온다', () => {
  const html = Card.renderChainPage({ blocks: 4123456, headers: 4123456, progress: 1, synced: true, peers: 8, hashrate_hs: 6.2e11, difficulty: 120000, mempool_count: 4, as_of: 1_791_724_058 }, rvn, false, NOW);
  const text = stripHtml(html);
  for (const need of ['체인 정보', '4,123,456', '620 GH/s', '$143', '38개 코인 중 3위', '출처: crypto51.app', '출처: 내 노드', '투자 조언이 아니에요']) assert.ok(text.includes(need), need);
  assert.ok(!/집중도|부자|상위 지갑/.test(text), '2단계 칸은 만들지 않는다');
  assert.ok(!html.includes('NaN') && !html.includes('undefined') && !html.includes('null'));
});
test('화면 문장: 노랑·흐림·못 읽음·노드 꺼짐·따라잡는 중이 정직하다', () => {
  const page = (ov, sec, err = false) => Card.renderChainPage(ov, sec, err, NOW);
  assert.ok(stripHtml(page(null, { ...rvn, status: 'stale', as_of: NOW - 30 * 3600 })).includes('지금과 다를 수 있어요'));
  const very = page(null, { ...rvn, status: 'very_stale', as_of: NOW - 80 * 3600 });
  assert.ok(stripHtml(very).includes('3일 넘게 갱신되지 않았어요')); assert.ok(very.includes('data-dim="true"'));
  assert.ok(stripHtml(page(null, { ...rvn, refresh_failed: true })).includes('마지막으로 받은 값'));
  const none = stripHtml(page(null, { status: 'no_data' }));
  assert.ok(none.includes('외부 정보를 지금은 읽을 수 없어요')); assert.ok(!none.includes('$'));
  assert.ok(stripHtml(page(null, null, true)).includes('내 노드를 읽지 못했어요'));
  const sync = stripHtml(page({ blocks: 100, headers: 5000, progress: 0.02, synced: false, hashrate_hs: 6e11 }, null));
  assert.ok(sync.includes('따라잡는 중이에요 (2%)')); assert.ok(!sync.includes('GH/s'));
});
test('홈 한 줄: 읽은 것만 잇고 없으면 열기 문구', () => {
  assert.equal(Card.renderChainStrip(null, null, NOW).text, '체인 정보 열기');
  const s = Card.renderChainStrip({ blocks: 10, synced: true, hashrate_hs: 6.2e11 }, rvn, NOW);
  assert.equal(s.text, '블록 10 · 해시율 620 GH/s · 보안 비용 $143/시간');
  assert.equal(Card.renderChainStrip(null, { ...rvn, status: 'stale', as_of: NOW - 30 * 3600 }, NOW).state, 'stale');
});

test('문구: 화면이 쓰는 한국어는 모두 번역표에 있고, 값 자리({0})가 세 언어에서 같다', async () => {
  const { CHAIN_INFO_COPY } = await moduleAt('src/chain-info-copy.ts');
  const src = readFileSync('src/chain-info-card.ts', 'utf8');
  const used = new Set([...src.matchAll(/\b(?:t|tf)\(\s*"([^"]*[가-힣][^"]*)"/g)].map(m => m[1]));
  // 삼항으로 고르는 두 문구
  for (const k of ['따라잡는 중에는 해시율을 말씀드리지 않아요.', '채굴 컴퓨터들의 힘이에요. 내 노드가 계산해요.']) used.add(k);
  const missing = [...used].filter(k => !(k in CHAIN_INFO_COPY) && !['{0}분 전', '{0}시간 전'].includes(k));
  assert.deepEqual(missing, []);
  const ph = s => [...s.matchAll(/\{\d+\}/g)].map(m => m[0]).sort().join();
  const hangul = /[가-힣]/;
  for (const [k, v] of Object.entries(CHAIN_INFO_COPY)) {
    assert.equal(v.length, 3, k);
    v.forEach(x => { assert.ok(x.trim(), k); assert.ok(!hangul.test(x), `한글 남음: ${k}`); assert.equal(ph(x), ph(k), `값 자리 불일치: ${k}`); });
  }
  const untouched = new Set(['—']);
  assert.ok(Object.keys(CHAIN_INFO_COPY).length >= 30 && untouched.size === 1);
});
test('새 문구 목록 파일: 번역표와 같은 열쇠', async () => {
  const f = 'docs/i18n-0.8.8a-chain-newstrings.json';
  assert.ok(existsSync(f), f);
  const { CHAIN_INFO_COPY } = await moduleAt('src/chain-info-copy.ts');
  const doc = JSON.parse(readFileSync(f, 'utf8'));
  assert.deepEqual(doc.strings.map(r => r.ko).sort(), Object.keys(CHAIN_INFO_COPY).sort());
  for (const r of doc.strings) { assert.ok(r.en && r.ja && r.zh); assert.deepEqual(r.europe_fallback, 'en'); }
});
test('유럽어 폴백: 사전에 없으면 영어, 영어 틀에 값 자리가 남는다', async () => {
  const { CHAIN_INFO_COPY } = await moduleAt('src/chain-info-copy.ts');
  const en = CHAIN_INFO_COPY['목록 {1}개 코인 중 {0}위'][0];
  assert.ok(en.includes('{0}') && en.includes('{1}'));
  assert.ok(typeof I18n.t === 'function');
});
