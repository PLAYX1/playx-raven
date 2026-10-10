// 창 모드 화면 규칙(순수 함수) — 칩 크기 순서, 대기화면 흐림·번인 이동(Rust 와 같은 값), 카드 카탈로그 거르기, 대화 부품 규칙.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { build } from 'esbuild';

const root = resolve(import.meta.dirname, '..');
async function load(file) {
  const built = await build({ stdin: { contents: `export * from './src/${file}';`, resolveDir: root, loader: 'ts' },
    bundle: true, write: false, platform: 'node', format: 'cjs', logLevel: 'silent', external: ['@tauri-apps/*'], loader: { '.css': 'empty' } });
  const mod = { exports: {} };
  new Function('require', 'exports', 'module', built.outputFiles[0].text)(createRequire(import.meta.url), mod.exports, mod);
  return mod.exports;
}
const mini = await load('mini-view.ts');
const sb = await load('standby-view.ts');
const cards = await load('card-catalog.ts');
const chat = await load('chat-thread.ts');

test('칩(xs)은 S 로 펼치고, 순환은 S→M→L→S 그대로', () => {
  assert.deepEqual(['xs', 's', 'm', 'l'].map(mini.nextSize), ['s', 'm', 'l', 's']);
});

test('대기화면 흐림 시간은 자정을 넘고 같으면 끈다(Rust dim_now 와 같은 규칙)', () => {
  assert.ok(sb.dimNow(23, 22, 7) && sb.dimNow(3, 22, 7) && !sb.dimNow(12, 22, 7) && !sb.dimNow(7, 22, 7));
  assert.ok(sb.dimNow(13, 12, 14) && !sb.dimNow(14, 12, 14));
  assert.equal(sb.dimNow(5, 6, 6), false);
});

test('번인 이동은 Rust shift_for 와 같은 값, 범위 안, 분마다 바뀐다', () => {
  assert.deepEqual(sb.shiftFor(5, 24), [22, -12]);
  assert.deepEqual(sb.shiftFor(29_000_000, 24), [23, 1]);
  assert.deepEqual(sb.shiftFor(29_000_001, 24), [-7, 14]);
  const seen = new Set();
  for (let m = 0; m < 120; m++) { const [x, y] = sb.shiftFor(29_000_000 + m, 24); assert.ok(Math.abs(x) <= 24 && Math.abs(y) <= 24); seen.add(`${x},${y}`); }
  assert.ok(seen.size > 60);
});

test('카드 카탈로그: 모르는 카드·임의 HTML·돈 동작·판매자 전용은 버리고 값은 열거 안에서만', () => {
  const evil = [
    { id: 'send', size: 'm', params: { to: 'RXXX', amount: 100 } },
    { id: 'balance', size: 'chip', params: { show: '<img src=x onerror=alert(1)>' }, html: '<script>' },
    { id: 'sales', size: 'm', params: { range: '7d' } },
    { id: 'clock', size: 'chip' },
    { id: '__proto__', size: 'm' },
    { id: 'recent', size: 'standby', params: { count: 5, filter: 'sales', url: 'https://evil' } },
  ];
  const plain = cards.validateLayout(evil, { seller: false });
  assert.deepEqual(plain.cards.map((c) => `${c.id}/${c.size}`), ['balance/chip', 'recent/standby']);
  assert.equal(plain.cards[0].params.show, 'confirmed', '열거 밖 값은 기본값으로');
  assert.deepEqual(Object.keys(plain.cards[1].params).sort(), ['count', 'filter']);
  assert.ok(plain.dropped.some((d) => /모르는 카드: send/.test(d)));
  assert.ok(plain.dropped.some((d) => /판매자 기능/.test(d)));
  assert.ok(plain.dropped.some((d) => /html|url/.test(d)));
  const seller = cards.validateLayout({ cards: evil }, { seller: true });
  assert.ok(seller.cards.some((c) => c.id === 'sales' && c.params.range === '7d'));
  assert.equal(JSON.stringify(seller.cards).includes('<'), false, '어떤 꺾쇠도 통과 못 함');
  for (const id of Object.keys(cards.CATALOG)) assert.doesNotMatch(id, /send|sign|buy|sell|pay|seed|key|word/, '돈·열쇠 카드는 카탈로그에 없다');
  assert.equal(cards.validateLayout(Array(20).fill({ id: 'node', size: 'm' }), { seller: false }).cards.length, 1, '중복 제거');
  assert.deepEqual(cards.validateLayout('<html>', { seller: true }).cards, []);
});

test('대화 부품: 시각은 같은 사람·같은 분 묶음의 마지막에만, 입력창 1~6줄', () => {
  const m = (me, at) => ({ id: String(at), me, text: 'x', at });
  assert.deepEqual(chat.timeShown([m(true, 60), m(true, 70), m(false, 80), m(true, 130)]), [false, true, true, true]);
  assert.equal(chat.rowsFor('', 30), 1);
  assert.equal(chat.rowsFor('a'.repeat(61), 30), 3);
  assert.equal(chat.rowsFor('a\nb\nc\nd\ne\nf\ng\nh', 30), 6);
  assert.match(chat.fmtTime(0, 'ko'), /^(오전|오후) \d{1,2}:\d{2}$/);
});

const auto = await load('auto-mode.ts');
test('자동 전환: 문턱 · 히스테리시스(깜박임 없음) · 핀 우선 · 돈 화면은 모드 유지 + 안전 축소', () => {
  assert.equal(auto.tierFor(1440, 900), 'large');
  assert.equal(auto.tierFor(800, 600), 'medium');
  assert.equal(auto.tierFor(300, 140), 'mini-m');
  assert.equal(auto.tierFor(160, 40), 'chip');
  // 문턱(960) 바로 위아래를 오가도 large↔medium 이 깜박이지 않는다
  let t = 'large';
  t = auto.tierFor(950, 700, t); assert.equal(t, 'medium');
  t = auto.tierFor(970, 700, t); assert.equal(t, 'medium', '올라갈 때는 960+24 가 필요');
  t = auto.tierFor(990, 700, t); assert.equal(t, 'large');
  assert.deepEqual(auto.decide({ w: 300, h: 140, prev: 'large', pinned: 'large', sensitive: false }), { tier: 'large', safeShrink: false, reason: 'pinned' });
  assert.deepEqual(auto.decide({ w: 300, h: 140, prev: 'large', pinned: null, sensitive: true }), { tier: 'large', safeShrink: true, reason: 'sensitive' });
  assert.deepEqual(auto.decide({ w: 300, h: 140, prev: 'large', pinned: null, sensitive: false }), { tier: 'mini-m', safeShrink: false, reason: 'auto' });
  for (const k of Object.keys(auto.PRIORITY)) assert.ok(auto.PRIORITY[k].length >= 2);
});
