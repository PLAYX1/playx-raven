// 미니 창 화면 규칙(순수 함수) — 크기 순서·가림·판매 요약 비노출·노드 글.
// Rust 쪽 판단(묶기·가림·확인 수·노드 흔들림)은 src-tauri/src/mini_feed.rs·mini.rs 시험.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { build } from 'esbuild';

const root = resolve(import.meta.dirname, '..');
const built = await build({ stdin: { contents: "export * from './src/mini-view.ts';", resolveDir: root, loader: 'ts' },
  bundle: true, write: false, platform: 'node', format: 'cjs', logLevel: 'silent' });
const mod = { exports: {} };
new Function('require', 'exports', 'module', built.outputFiles[0].text)(createRequire(import.meta.url), mod.exports, mod);
const { nextSize, headline, recentLine, nodeLine, sellerLines, HIDDEN } = mod.exports;

export const snap = (over = {}) => ({
  masked: false, locale: 'ko', status: 'ok',
  node: { state: 'ok', blocks: 3_500_000, peers: 8, behind: 0 },
  balance: { known: true, confirmed: '1,234.5', pending: '12.5', has_pending: true },
  recent: [{ dir: 'in', sale: false, amount: '+12.5', unit: 'RVN', conf: 0, done: false, ago: 30 }],
  lock: 'locked', awake: { holding: true, note: '' }, seller: null, unseen: 0, need: 1, ...over,
});

test('크기는 S → M → L → S 로 돈다(Rust next_size 와 같은 순서)', () => {
  assert.deepEqual(['s', 'm', 'l'].map(nextSize), ['m', 'l', 's']);
});

test('가림(null)이면 금액 대신 ••••, 자산 이름도 없음', () => {
  const masked = snap({ masked: true, balance: { known: true, confirmed: null, pending: null, has_pending: true },
    recent: [{ dir: 'in', sale: false, amount: null, unit: null, conf: 0, done: false, ago: 30 }] });
  assert.equal(headline(masked, 'm'), HIDDEN);
  const l = recentLine(masked.recent[0], masked);
  assert.equal(l.amount, HIDDEN);
  assert.doesNotMatch(JSON.stringify(l), /\d+\.\d|RVN/);
  assert.equal(headline(snap(), 'm'), '1,234.5 RVN');
});

test('S 는 새 소식이 있으면 그 수를 먼저, 잔액을 모르면 「확인 중」', () => {
  assert.equal(headline(snap({ unseen: 3 }), 's'), '새 소식 3');
  assert.equal(headline(snap({ unseen: 3 }), 'm'), '1,234.5 RVN');
  assert.equal(headline(snap({ balance: { known: false, confirmed: null, pending: null, has_pending: false } }), 'm'), '잔액 확인 중');
  assert.equal(headline(snap({ unseen: 2, locale: 'en' }), 's'), '2 new');
});

test('확인 수 글: 0 → 확인 전, 미달 → n/need, 도달 → 확인됨', () => {
  const s = snap({ need: 3 });
  assert.match(recentLine({ ...s.recent[0], conf: 0 }, s).meta, /^확인 전/);
  assert.match(recentLine({ ...s.recent[0], conf: 2 }, s).meta, /^확인 2\/3/);
  assert.match(recentLine({ ...s.recent[0], conf: 3 }, s).meta, /^확인됨/);
  assert.equal(recentLine({ ...s.recent[0], dir: 'out', amount: '−3' }, s).label, '보냄');
});

test('판매자 모드가 아니면(seller=null) 판매 요약은 없다', () => {
  assert.equal(sellerLines(snap()), null);
  const on = sellerLines(snap({ seller: { sales: 2, sales_rvn: '30', deposits: 1, deposits_rvn: '5', pending: 1 } }));
  assert.deepEqual(on, ['판매 2건 · 30 RVN', '입금 1건 · 5 RVN · 확인 전 1']);
  const hid = sellerLines(snap({ seller: { sales: 2, sales_rvn: null, deposits: 1, deposits_rvn: null, pending: 0 } }));
  assert.deepEqual(hid, ['판매 2건', '입금 1건']);
});

test('노드 글 — 응답 없음이면 연결 수를 붙이지 않는다', () => {
  assert.equal(nodeLine(snap()), '노드 정상 · 연결 8곳');
  assert.equal(nodeLine(snap({ node: { state: 'down', blocks: null, peers: null, behind: null } })), '노드 응답 없음');
  assert.equal(nodeLine(snap({ node: { state: 'stalled', blocks: 1, peers: 3, behind: 0 } })), '동기화 멈춤 · 연결 3곳');
});
