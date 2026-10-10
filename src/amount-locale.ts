/* 금액 입력·표시 — 언어(지역)와 무관하게 안전한 한 곳.
 *
 * 이 파일은 데스크탑(`src/amount-locale.ts`)과 지갑(`core/i18n/amount-locale.ts`)에
 * **바이트가 같게** 들어 있다. 고칠 때는 둘 다 고치고 docs/amount-locale.md 의 SHA 를 갱신한다.
 * DOM·Node·네트워크를 쓰지 않는다(지갑 core 의 이식성 규칙).
 *
 * ## 규칙 (2026-10-11 유럽어 6개 추가 ①②단계)
 * 1. 금액은 안에서 **정수 사토시(bigint)** 로만 다룬다. 부동소수 계산 금지.
 *    문자 → 사토시는 글자를 잘라 붙여 만든다(`parseFloat` 안 씀).
 * 2. 입력은 **선택한 지역의 소수기호**만 소수점으로 받는다. 점·쉼표를 무조건 지우거나
 *    바꾸지 않는다. 두 해석(1.234 = 1.234 / 1234)이 다 성립하면 **모호** 로 돌려주고
 *    값을 정하지 않는다. 다른 지역 형식으로만 읽히면 **다른 형식** 으로 돌려준다.
 * 3. 음수·지수(1e3)·소수 9자리 이상·총발행량(210억 RVN) 초과는 거절.
 * 4. 표시는 정수 부분만 Intl.NumberFormat(지역)에 맡기고 소수는 글자 그대로 붙인다 —
 *    8자리 정밀도를 잃지 않고, 0 이 아닌 값이 0 으로 보이는 일이 없다.
 * 5. 통화 코드는 언제나 숫자 **뒤에** 줄바꿈 없는 공백과 함께(「1.234,5 RVN」).
 *    화면 글자와 낭독용 글자는 같은 함수가 만든다.
 * 6. 주소·복구 단어·프로토콜 값은 이 파일의 대상이 아니다(번역·형식 변경 금지).
 */

export const RVN_DECIMALS = 8;
/** 총발행량 210억 RVN — 이보다 큰 입력은 오타다. */
export const MAX_RVN_SATS = 21_000_000_000n * 100_000_000n;
const NBSP = ' ';

export type NumberSymbols = { decimal: string; group: string; minus: string };

const symbolCache = new Map<string, NumberSymbols>();
/** 지역의 소수기호·천단위 기호. 공백 계열 천단위(fr U+202F, ru U+00A0)는 그대로 돌려준다. */
export function numberSymbols(locale: string): NumberSymbols {
  const hit = symbolCache.get(locale);
  if (hit) return hit;
  const parts = new Intl.NumberFormat(locale).formatToParts(-12345.6);
  const pick = (type: string, fallback: string) => parts.find(p => p.type === type)?.value ?? fallback;
  const out = { decimal: pick('decimal', '.'), group: pick('group', ','), minus: pick('minusSign', '-') };
  symbolCache.set(locale, out);
  return out;
}

/* ── 사토시 ⇄ 정확한 십진 글자 ─────────────────────────────────────────── */

/** 123456789n → "1.23456789" (점 소수, 묶음 없음, 끝 0 지움). 프로토콜·저장용. */
export function satsToDecimal(sats: bigint, decimals = RVN_DECIMALS): string {
  const neg = sats < 0n;
  const abs = neg ? -sats : sats;
  const base = 10n ** BigInt(decimals);
  const whole = abs / base;
  const frac = decimals > 0 ? (abs % base).toString().padStart(decimals, '0').replace(/0+$/, '') : '';
  return `${neg ? '-' : ''}${whole}${frac ? '.' + frac : ''}`;
}

/** "1.5" (점 소수, 묶음 없음) → 150000000n. 형식이 틀리면 null. 화면 입력에는 parseAmountInput 을 쓴다. */
export function decimalToSats(text: string, decimals = RVN_DECIMALS): bigint | null {
  const m = /^(\d+)(?:\.(\d*))?$/.exec(text);
  if (!m) return null;
  const frac = m[2] ?? '';
  if (frac.length > decimals) return null;
  return BigInt(m[1]) * 10n ** BigInt(decimals) + BigInt((frac + '0'.repeat(decimals)).slice(0, decimals) || '0');
}

/**
 * 노드·서버가 준 JS 수(RVN 단위)를 사토시로. 이 경계에서만 부동소수를 받는다.
 * toFixed 는 이진값의 정확한 십진 전개를 반올림하므로 0.1 → 10000000n 이 정확히 나온다.
 */
export function rvnNumberToSats(value: number, decimals = RVN_DECIMALS): bigint | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  const neg = value < 0;
  const s = decimalToSats(Math.abs(value).toFixed(decimals), decimals);
  return s === null ? null : neg ? -s : s;
}

/**
 * 사토시 → 노드 명령에 넘길 JS 수. 되돌렸을 때 같은 사토시가 나와야만 돌려준다
 * (15자리 넘는 값은 이진 수로 정확히 못 담는다 — 그때는 보내지 않고 오류를 낸다).
 */
export function satsToRvnNumber(sats: bigint, decimals = RVN_DECIMALS): number {
  const n = Number(satsToDecimal(sats, decimals));
  if (rvnNumberToSats(n, decimals) !== sats) throw new Error('AMOUNT_PRECISION');
  return n;
}

/* ── 표시 ─────────────────────────────────────────────────────────────── */

export type FormatOptions = {
  /** 소수 자리(자산은 0~8). 기본 8. */
  decimals?: number;
  /** 통화·자산 코드. 빈 글자면 붙이지 않는다. 기본 'RVN'. */
  code?: string;
  /** 천단위 묶음. 기본 true. 입력칸에 되돌려 넣을 때는 false. */
  grouping?: boolean;
  /** 보일 최대 소수 자리. 이보다 작은 0 아닌 값은 「< 0,01」 처럼 보인다(0 으로 안 보인다). 기본 = decimals. */
  maxFraction?: number;
  /** 최소 소수 자리(끝 0 채움). 기본 0. */
  minFraction?: number;
  /** 양수에도 + 를 붙인다(입출금 목록). */
  signed?: boolean;
};

function groupWhole(whole: bigint, locale: string, grouping: boolean): string {
  // grouping=true 는 지역 기본(it·es 는 4자리를 안 묶는다). useGrouping:true 를 주면 「항상 묶음」이 된다.
  return new Intl.NumberFormat(locale, grouping ? { maximumFractionDigits: 0 } : { useGrouping: false, maximumFractionDigits: 0 }).format(whole);
}

/** 사토시를 지역 형식 글자로. 예) de: 123456789000n → "1.234,56789 RVN". */
export function formatAmount(sats: bigint, locale: string, opts: FormatOptions = {}): string {
  const decimals = opts.decimals ?? RVN_DECIMALS;
  const code = opts.code ?? 'RVN';
  const grouping = opts.grouping ?? true;
  const maxFraction = Math.min(opts.maxFraction ?? decimals, decimals);
  const minFraction = Math.min(opts.minFraction ?? 0, maxFraction);
  const sym = numberSymbols(locale);
  const neg = sats < 0n;
  let abs = neg ? -sats : sats;
  const base = 10n ** BigInt(decimals);
  const cut = 10n ** BigInt(decimals - maxFraction);
  let tiny = false;
  if (cut > 1n) {
    // 보일 자리 밖은 반올림(절반 올림). 0 이 아닌데 0 이 되면 「< 최소단위」.
    const rounded = ((abs + cut / 2n) / cut) * cut;
    if (abs > 0n && rounded === 0n) { tiny = true; abs = cut; } else abs = rounded;
  }
  const whole = abs / base;
  let frac = decimals > 0 ? (abs % base).toString().padStart(decimals, '0').slice(0, maxFraction) : '';
  frac = frac.replace(/0+$/, '');
  if (frac.length < minFraction) frac = frac.padEnd(minFraction, '0');
  const body = groupWhole(whole, locale, grouping) + (frac ? sym.decimal + frac : '');
  const sign = neg ? sym.minus : opts.signed && sats > 0n ? '+' : '';
  const num = (tiny ? '<' + NBSP : '') + sign + body;
  return code ? num + NBSP + code : num;
}

/** 입력칸에 되돌려 넣는 글자 — 묶음 없음, 지역 소수기호, 코드 없음. 언어를 바꿀 때 값 보존용. */
export function formatAmountForInput(sats: bigint, locale: string, decimals = RVN_DECIMALS): string {
  return formatAmount(sats, locale, { decimals, code: '', grouping: false });
}

/** 개수·블록 수 같은 정수(소수 없음). */
export function formatCount(n: number | bigint, locale: string): string {
  return new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format(n as number);
}

/** JS 수(RVN)를 바로 표시 — 노드·서버 값을 그릴 때. 수가 아니면 '—'. */
export function formatRvnNumber(value: number, locale: string, opts: FormatOptions = {}): string {
  const sats = rvnNumberToSats(Number(value), opts.decimals ?? RVN_DECIMALS);
  return sats === null ? '—' : formatAmount(sats, locale, opts);
}

/** 입력칸 아래 예시: de → "1234,5", en → "1234.5". 묶음 없이 쓰는 것을 권한다. */
export function amountExample(locale: string): string {
  return formatAmountForInput(123450000000n, locale);
}

/* ── 입력 ─────────────────────────────────────────────────────────────── */

export type AmountProblem =
  | 'empty' | 'negative' | 'exponent' | 'invalid' | 'too-many-decimals'
  | 'too-large' | 'zero' | 'ambiguous' | 'other-format';

export type ParsedAmount =
  | { ok: true; sats: bigint }
  /** ambiguous: 두 해석이 다 성립(choices 둘). other-format: 이 지역 형식으로는 안 읽히고 다른 형식으로만 읽힘(choices 하나). */
  | { ok: false; problem: AmountProblem; choices: bigint[] };

export type ParseOptions = { decimals?: number; maxSats?: bigint; allowZero?: boolean };

const SPACES = /[   -   　]/g;
const FULLWIDTH = /[０-９，．－＋]/g;

function normalizeTyped(raw: string): string {
  let s = String(raw ?? '').replace(FULLWIDTH, c => {
    const code = c.charCodeAt(0);
    if (code >= 0xff10 && code <= 0xff19) return String.fromCharCode(code - 0xff10 + 48);
    return ({ '，': ',', '．': '.', '－': '-', '＋': '+' } as Record<string, string>)[c];
  });
  s = s.replace(/^[\s  　]+|[\s  　]+$/g, '');
  // 붙여넣기: 「1,5 RVN」「RVN 1.5」 — 코드는 떼어 낸다(대소문자 무관). 다른 글자는 그대로 둬서 거절된다.
  s = s.replace(/^rvn[\s  ]*/i, '').replace(/[\s  ]*rvn$/i, '');
  return s.replace(SPACES, ' ');
}

type Reading = { sats: bigint } | { error: AmountProblem };

/** 한 관례로 읽어 본다. dec = 소수점, groups = 천단위로 허용하는 글자. */
function readWith(s: string, dec: string, groups: string, decimals: number): Reading {
  const decAt = s.indexOf(dec);
  if (decAt !== s.lastIndexOf(dec)) return { error: 'invalid' };
  const intPart = decAt < 0 ? s : s.slice(0, decAt);
  const fracPart = decAt < 0 ? '' : s.slice(decAt + 1);
  if (!/^\d*$/.test(fracPart)) return { error: 'invalid' };
  if (intPart === '' && fracPart === '') return { error: 'invalid' };
  let digits = intPart;
  const used = [...new Set(intPart.replace(/\d/g, ''))];
  if (used.length > 0) {
    if (used.length > 1 || !groups.includes(used[0])) return { error: 'invalid' };
    const chunks = intPart.split(used[0]);
    if (!/^[1-9]\d{0,2}$/.test(chunks[0])) return { error: 'invalid' };
    if (!chunks.slice(1).every(c => /^\d{3}$/.test(c))) return { error: 'invalid' };
    digits = chunks.join('');
  }
  if (fracPart.length > decimals) return { error: 'too-many-decimals' };
  const sats = BigInt(digits || '0') * 10n ** BigInt(decimals) + BigInt((fracPart + '0'.repeat(decimals)).slice(0, decimals) || '0');
  return { sats };
}

/**
 * 사람이 친(또는 붙여넣은) 금액을 사토시로. 값을 짐작하지 않는다.
 * - 이 지역 관례로만 하나로 읽히면 ok.
 * - 점 관례(1,234.5)와 쉼표 관례(1.234,5)로 **다른 값**이 다 나오면 'ambiguous'.
 * - 이 지역 관례로는 안 되고 다른 관례로만 되면 'other-format'(값을 정하지 않는다).
 */
export function parseAmountInput(raw: string, locale: string, opts: ParseOptions = {}): ParsedAmount {
  const decimals = opts.decimals ?? RVN_DECIMALS;
  const maxSats = opts.maxSats ?? MAX_RVN_SATS;
  const fail = (problem: AmountProblem, choices: bigint[] = []): ParsedAmount => ({ ok: false, problem, choices });
  const s = normalizeTyped(raw);
  if (s === '') return fail('empty');
  if (/[-−‒–—]/.test(s)) return fail('negative');
  if (/[eE]/.test(s) && /\d/.test(s)) return fail('exponent');
  if (!/^[\d.,' ’]+$/.test(s)) return fail('invalid');

  const sym = numberSymbols(locale);
  const localDec = sym.decimal === ',' ? ',' : '.';
  const groupsFor = (dec: string) => (dec === '.' ? ", '’" : ". '’");
  const local = readWith(s, localDec, groupsFor(localDec), decimals);
  const otherDec = localDec === '.' ? ',' : '.';
  const other = readWith(s, otherDec, groupsFor(otherDec), decimals);

  const finish = (sats: bigint): ParsedAmount => {
    if (sats > maxSats) return fail('too-large');
    if (sats === 0n && !opts.allowZero) return fail('zero');
    return { ok: true, sats };
  };
  if ('sats' in local && 'sats' in other) {
    if (local.sats === other.sats) return finish(local.sats);
    return fail('ambiguous', [local.sats, other.sats]);
  }
  if ('sats' in local) return finish(local.sats);
  if ('sats' in other) return fail('other-format', [other.sats]);
  // 둘 다 안 되면 더 구체적인 이유를 고른다.
  if (local.error === 'too-many-decimals' || other.error === 'too-many-decimals') return fail('too-many-decimals');
  return fail('invalid');
}

/** 화면 안내용 한국어 원문(번역 열쇠). 숫자는 {0} 자리에 지역 형식으로 끼운다. */
export const AMOUNT_PROBLEM_SOURCE: Record<AmountProblem, string> = {
  empty: '금액을 적어 주세요.',
  negative: '금액에는 빼기 기호를 쓸 수 없어요.',
  exponent: '금액은 숫자로만 적어 주세요(1e3 같은 표기는 안 돼요).',
  invalid: '금액을 숫자로 적어 주세요. 예: {0}',
  'too-many-decimals': '소수점 아래는 8자리까지예요.',
  'too-large': '금액이 너무 커요.',
  zero: '0보다 큰 금액을 적어 주세요.',
  ambiguous: '「{1}」은 두 가지로 읽혀요. 천 단위 기호 없이 적어 주세요. 소수점은 「{2}」예요. 예: {0}',
  'other-format': '이 언어 설정에서는 소수점이 「{2}」예요. 천 단위 기호 없이 적어 주세요. 예: {0}',
};

/** 안내 문장에 끼울 값: {0}=예시, {1}=사람이 친 글자, {2}=이 지역 소수기호. */
export function amountProblemValues(raw: string, locale: string): [string, string, string] {
  return [amountExample(locale), normalizeTyped(raw), numberSymbols(locale).decimal];
}
