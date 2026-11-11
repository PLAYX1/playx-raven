// 11-11 라비 카드(데스크탑 홈 2단계) — src/ravi-cards.ts. 보내는 단추 없음·금지어 없음·순서·최대 3장·모르면 카드 없음.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
const root = resolve(import.meta.dirname, '..');
const DICT = { en: {}, ja: {}, zh: {} };
const stubs = { './i18n': { t: (s) => s, tf: (s, ...v) => s.replace(/\{(\d)\}/g, (_, n) => String(v[n])), setCopyText: (e, f) => { e.textContent = f(); } }, './dict': { DICT } };
const src = readFileSync(resolve(root, 'src/ravi-cards.ts'), 'utf8');
const js = ts.transpileModule(src, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const m = { exports: {} }; vm.runInNewContext(js, { module: m, exports: m.exports, require: (id) => stubs[id], JSON, Date, Number, Math, Object });
const C = m.exports;

const base = { incoming: null, confirmed: null, anyTx: null, nodeAt: 1, newOrders: 0, ordersAt: null, phoneWaiting: 0, phoneAt: null,
  backupTone: null, lockNone: false, safetyAt: null, storesOff: 0, headFail: false, chainAt: null, talkNew: 0, talkAt: null, rvn: (n) => `${n} RVN` };
const ids = (patch) => JSON.parse(JSON.stringify(C.allCards({ ...base, ...patch }).map((c) => c.id)));

test('모르면 카드가 없다(빈 상태)', () => { assert.deepEqual(ids({}), []); });
test('순서: 돈 → 주문 → 폰 요청 → 문제 → 새 글', () => {
  assert.deepEqual(ids({ incoming: 12.5, newOrders: 2, phoneWaiting: 1, lockNone: true, backupTone: 'bad', storesOff: 3, talkNew: 4 }),
    ['money', 'order', 'prepared', 'lock', 'backup', 'stores-off', 'message']);
  assert.equal(C.cards({ ...base, incoming: 1, newOrders: 1, phoneWaiting: 1, talkNew: 1 }).length, 3);
});
test('백업 warn 은 카드가 아니다(나쁨만), 첫 받기 안내는 확실히 0일 때만', () => {
  assert.deepEqual(ids({ backupTone: 'warn' }), []);
  assert.deepEqual(ids({ confirmed: 0, anyTx: false }), ['first-receive']);
  assert.deepEqual(ids({ confirmed: 0, anyTx: null }), []);
  assert.deepEqual(ids({ confirmed: 0, anyTx: false, incoming: 2 }), ['money']);
});
test('어떤 카드도 보내지 않는다 — 여는 곳만, 금지어 없음', () => {
  const all = C.allCards({ ...base, incoming: 1, newOrders: 1, phoneWaiting: 1, lockNone: true, backupTone: 'bad', storesOff: 1, headFail: true, talkNew: 1, confirmed: 0, anyTx: false });
  for (const c of all) {
    assert.ok(C.OPEN_TARGETS.includes(c.action.opens), c.id);
    assert.equal(typeof c.action.opens, 'string');
    for (const v of c.values) assert.ok(typeof v === 'number' || /RVN$/.test(v), `${c.id} 값은 숫자·금액만`);
  }
  const words = [...Object.values(C.CARD_COPY), ...Object.values(C.ACTION_COPY), ...Object.values(C.SOURCE_COPY)].join(' ');
  for (const w of C.CARD_BANNED_WORDS) assert.ok(!words.includes(w), w);
  assert.ok(!/보내기|송금|입찰|승인하기/.test(Object.values(C.ACTION_COPY).join(' ')), '단추에 보내는 말 없음');
  assert.ok(!/send_|auto_reply|invoke\(/.test(src), '카드 모듈은 명령을 부르지 않는다');
});
test('번역이 사전에 들어간다', () => {
  for (const s of Object.values(C.CARD_COPY)) for (const l of ['en', 'ja', 'zh']) assert.ok(DICT[l][s], `${l}: ${s}`);
});
