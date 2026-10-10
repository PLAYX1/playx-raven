// 금액 입력·표시 안전(유럽어 6개 추가 ①②단계). 순수 함수만 — 네트워크·노드·지갑 없음.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { build } from 'esbuild';

async function moduleAt(path) {
  const built = await build({ entryPoints: [path], bundle: true, write: false, platform: 'node', format: 'cjs', logLevel: 'silent' });
  const mod = { exports: {} };
  new Function('require', 'exports', 'module', built.outputFiles[0].text)(createRequire(import.meta.url), mod.exports, mod);
  return mod.exports;
}
const A = await moduleAt('src/amount-locale.ts');
const NB = ' ';
const plain = s => s.replace(/[  ]/g, ' ');

const LOCALES = ['it', 'es-ES', 'es-MX', 'de', 'fr', 'pt-BR', 'ru', 'ko', 'en', 'ja', 'zh'];
const COMMA_DECIMAL = new Set(['it', 'es-ES', 'de', 'fr', 'pt-BR', 'ru']);
let counted = 0;
const eq = (a, b, m) => { counted++; assert.equal(a, b, m); };

test('symbols: comma-decimal locales vs dot-decimal locales', () => {
  for (const l of LOCALES) eq(A.numberSymbols(l).decimal, COMMA_DECIMAL.has(l) ? ',' : '.', l);
});

test('round trip: format for input → parse gives the same sats, every locale', () => {
  const samples = [1n, 9n, 10n, 12345678n, 100000000n, 123450000000n, 99999999999n, 2_100_000_000_000_000_000n];
  for (const l of LOCALES) for (const s of samples) {
    const text = A.formatAmountForInput(s, l);
    const r = A.parseAmountInput(text, l);
    assert.ok(r.ok, `${l} ${text} ${JSON.stringify(r, (_, v) => typeof v === 'bigint' ? String(v) : v)}`);
    eq(r.sats, s, `${l} ${text}`);
  }
});

test('round trip with grouping: display text (minus code) parses back except when ambiguous by design', () => {
  for (const l of LOCALES) for (const s of [123456789012345n, 100012345678n, 1234567800000000n]) {
    const text = A.formatAmount(s, l, { code: '' });
    const r = A.parseAmountInput(text, l);
    assert.ok(r.ok, `${l} ${text}`);
    eq(r.sats, s, `${l} ${text}`);
  }
});

// 모호 입력 처리표 — 문서(docs/amount-locale.md)와 같은 표.
const TABLE = [
  // [입력, 지역, 기대 결과(sats 글자 | 문제 이름)]
  ['1.234', 'de', 'ambiguous'], ['1,234', 'de', 'ambiguous'], ['1.234', 'en', 'ambiguous'], ['1,234', 'en', 'ambiguous'],
  ['1.234', 'ru', 'ambiguous'], ['1,234', 'ru', 'ambiguous'], ['1,234', 'ko', 'ambiguous'], ['100.000', 'it', 'ambiguous'],
  ['1 234,5', 'de', '123450000000'], ['1 234,5', 'ru', '123450000000'], ['1 234,5', 'fr', '123450000000'], ['1 234,5', 'fr', '123450000000'],
  ['1 234,5', 'en', 'other-format'], ['1 234.5', 'en', '123450000000'], ['1 234.5', 'de', 'other-format'],
  ['1.234,5', 'de', '123450000000'], ['1.234,5', 'es-ES', '123450000000'], ['1.234,5', 'pt-BR', '123450000000'], ['1.234,5', 'en', 'other-format'],
  ['1,234.5', 'en', '123450000000'], ['1,234.5', 'es-MX', '123450000000'], ['1,234.5', 'de', 'other-format'], ['1,234.5', 'it', 'other-format'],
  ['1,5', 'de', '150000000'], ['1,5', 'en', 'other-format'], ['1.5', 'en', '150000000'], ['1.5', 'de', 'other-format'],
  ['0,001', 'de', '100000'], ['0.001', 'en', '100000'], ['0,001', 'en', 'other-format'],
  ['1234', 'de', '123400000000'], ['1234', 'en', '123400000000'], ['1.234.567', 'de', '123456700000000'], ['1.234.567', 'en', 'other-format'],
  ['12.345,678', 'de', '1234567800000'], ['1,23,456', 'en', 'invalid'], ['1..5', 'en', 'invalid'], ['1,2,3', 'de', 'invalid'],
  ['-1', 'en', 'negative'], ['−1', 'de', 'negative'], ['1e3', 'en', 'exponent'], ['1E-8', 'de', 'negative'], ['2e8', 'ru', 'exponent'],
  ['0,000000001', 'de', 'too-many-decimals'], ['0.000000001', 'en', 'too-many-decimals'], ['0', 'en', 'zero'], ['0,00', 'de', 'zero'],
  ['', 'en', 'empty'], ['   ', 'de', 'empty'], ['abc', 'en', 'invalid'], ['1/2', 'en', 'invalid'], ['$5', 'en', 'invalid'],
  ['21000000001', 'en', 'too-large'], ['21000000000', 'en', '2100000000000000000'],
  // 붙여넣기
  [' 1,5 RVN\n', 'de', '150000000'], ['RVN 1.5', 'en', '150000000'], ['１２３．４５', 'ja', '12345000000'], ['１，５', 'de', '150000000'],
  ['0.00000001', 'en', '1'], [',5', 'de', '50000000'], ['.5', 'en', '50000000'], ['1.', 'en', '100000000'],
];

test('ambiguous / foreign / invalid input table', () => {
  for (const [input, l, want] of TABLE) {
    const r = A.parseAmountInput(input, l);
    const got = r.ok ? String(r.sats) : r.problem;
    eq(got, want, `${JSON.stringify(input)} @ ${l}`);
    if (!r.ok && r.problem === 'ambiguous') eq(r.choices.length, 2, 'two readings');
  }
});

test('ambiguity is the same in every locale: 1.234 and 1,234 never pick a value silently', () => {
  for (const l of LOCALES) for (const s of ['1.234', '1,234', '999.999', '10,000', '100.000']) {
    const r = A.parseAmountInput(s, l);
    eq(r.ok, false, `${s} @ ${l}`);
    assert.ok(['ambiguous'].includes(r.problem), `${s} @ ${l} → ${r.problem}`);
  }
});

test('display: 8-digit precision, small values never 0, code after number with NBSP', () => {
  eq(A.formatAmount(1n, 'de'), `0,00000001${NB}RVN`);
  eq(A.formatAmount(1n, 'en'), `0.00000001${NB}RVN`);
  eq(plain(A.formatAmount(123456789012345678n, 'fr')), '1 234 567 890,12345678 RVN');
  eq(plain(A.formatAmount(123456789012345678n, 'ru')), '1 234 567 890,12345678 RVN');
  eq(A.formatAmount(123456789012345678n, 'de'), `1.234.567.890,12345678${NB}RVN`);
  eq(A.formatAmount(123456789012345678n, 'es-MX'), `1,234,567,890.12345678${NB}RVN`);
  eq(A.formatAmount(123400000000n, 'it'), `1234${NB}RVN`); // it/es-ES: 4자리는 묶지 않는 것이 CLDR 관례
  eq(A.formatAmount(1234500000000n, 'it'), `12.345${NB}RVN`);
  eq(A.formatAmount(100000n, 'de', { maxFraction: 2 }), `<${NB}0,01${NB}RVN`);
  eq(A.formatAmount(0n, 'de', { maxFraction: 2 }), `0${NB}RVN`);
  eq(A.formatAmount(-150000000n, 'de'), `-1,5${NB}RVN`);
  eq(A.formatAmount(150000000n, 'en', { signed: true }), `+1.5${NB}RVN`);
  eq(A.formatAmount(150000000n, 'en', { minFraction: 2 }), `1.50${NB}RVN`);
  eq(A.formatAmount(7n, 'ko', { decimals: 0, code: '' }), '7');
  eq(A.formatAmount(1234567n, 'de', { decimals: 2, code: 'TOKEN' }), `12.345,67${NB}TOKEN`);
  for (const l of LOCALES) assert.notEqual(A.formatAmount(1n, l, { maxFraction: 2 }).replace(/\D/g, ''), '0');
});

test('JS-number boundary (node values): exact sats, refusal when a number cannot hold the value', () => {
  eq(A.rvnNumberToSats(0.1), 10000000n); eq(A.rvnNumberToSats(0.3), 30000000n); eq(A.rvnNumberToSats(0.00000001), 1n);
  eq(A.rvnNumberToSats(1e-9), 0n); eq(A.rvnNumberToSats(NaN), null); eq(A.rvnNumberToSats(-2.5), -250000000n);
  eq(A.satsToRvnNumber(123456789n), 1.23456789); eq(A.satsToRvnNumber(1n), 1e-8);
  eq(A.satsToRvnNumber(999999912345678n), 9999999.12345678);
  assert.throws(() => A.satsToRvnNumber(2_099_999_999_999_999_999n), /AMOUNT_PRECISION/);
  eq(A.formatRvnNumber(0.1 + 0.2, 'de'), `0,3${NB}RVN`);
  eq(A.formatRvnNumber(Number('x'), 'de'), '—');
});

test('locale switch keeps the value: sats are the truth, input text is rebuilt', () => {
  for (const from of LOCALES) for (const to of LOCALES) {
    const typed = A.formatAmountForInput(123450000000n, from);
    const r = A.parseAmountInput(typed, from);
    assert.ok(r.ok);
    const rebuilt = A.formatAmountForInput(r.sats, to);
    const back = A.parseAmountInput(rebuilt, to);
    eq(back.ok && back.sats, 123450000000n, `${from}→${to}`);
  }
  // 「다른 언어의 글자를 그대로 두고 다시 읽기」가 왜 안 되는지 — 값이 바뀌거나 막힌다.
  eq(A.parseAmountInput('1234,5', 'en').ok, false);
});

test('examples and problem copy', () => {
  eq(A.amountExample('de'), '1234,5'); eq(A.amountExample('en'), '1234.5'); eq(A.amountExample('ru'), '1234,5');
  eq(A.amountProblemValues('1.234', 'de')[2], ',');
  for (const k of ['empty','negative','exponent','invalid','too-many-decimals','too-large','zero','ambiguous','other-format']) assert.ok(A.AMOUNT_PROBLEM_SOURCE[k]);
});

test('wallet copy is byte-identical when the wallet worktree is present', t => {
  const other = process.env.RV_WALLET_AMOUNT || '/Users/gimmusong/wt-rv-i18n-num-wallet/core/i18n/amount-locale.ts';
  if (!existsSync(other)) { t.skip('wallet worktree absent'); return; }
  const h = p => createHash('sha256').update(readFileSync(p)).digest('hex');
  eq(h('src/amount-locale.ts'), h(other));
});

test.after(() => console.log(`amount-locale assertions: ${counted}`));
