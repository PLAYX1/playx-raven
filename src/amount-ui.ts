/* 데스크탑 금액 입력칸·표시 — src/amount-locale.ts(지갑과 같은 바이트) 위의 얇은 화면 층.
 *
 * - 숫자 형식은 화면 언어를 따른다. 컴퓨터 지역이 같은 언어면 그 지역(es-MX·pt-BR)까지 쓴다.
 * - 금액 입력칸은 type="text" + inputmode="decimal". type="number" 는 브라우저가 제 마음대로
 *   쉼표를 버리거나 값을 비워서(「1,5」→ "") 우리가 모호함을 알 수조차 없다.
 * - 입력칸의 진실은 **마지막으로 받아들인 사토시**다. 언어를 바꾸면 그 사토시로 글자를 다시
 *   쓴다(재해석 금지). 받아들이지 못한 글자는 언어를 바꿀 때 비운다 — 다른 언어 규칙으로
 *   조용히 「맞는 값」이 되는 일을 막는다.
 */
import { lang, tf } from "./i18n";
import {
  AMOUNT_PROBLEM_SOURCE, amountExample, amountProblemValues, formatAmount, formatAmountForInput, formatCount,
  formatRvnNumber, parseAmountInput, rvnNumberToSats, type FormatOptions, type ParsedAmount,
} from "./amount-locale";

let localeOverride: string | null = null;
/**
 * 숫자 지역을 직접 정한다(예: 스페인어 화면에서 es-ES / es-MX 고르기 — ⑤단계 언어 사전과 함께 쓸 자리).
 * null 이면 화면 언어를 따른다. 바꾸면 입력칸의 받아들인 값이 새 형식으로 다시 쓰인다.
 */
export function setNumberLocale(locale: string | null) {
  localeOverride = locale;
  if (typeof window !== "undefined") window.dispatchEvent(new Event("desktop-language-change"));
}

/** 화면 언어의 숫자 지역. navigator 가 같은 언어면 지역까지(es-MX 등) 그대로. */
export function numLocale(): string {
  if (localeOverride) return localeOverride;
  const nav = typeof navigator !== "undefined" ? String(navigator.language || "") : "";
  return nav.toLowerCase().split("-")[0] === lang ? nav : lang;
}

/** 노드·서버의 RVN 수를 표시(8자리 보존, 0 아닌 값은 0 으로 안 보임, 「RVN」 뒤). */
export const fmtRvn = (n: number, opts: FormatOptions = {}) => formatRvnNumber(n, numLocale(), opts);
/** 사토시 표시. */
export const fmtSats = (sats: bigint, opts: FormatOptions = {}) => formatAmount(sats, numLocale(), opts);
/** 개수·블록 수. */
export const fmtCount = (n: number | bigint) => formatCount(n, numLocale());

type Bound = { decimals: number; sats: bigint | null };
const bound = new WeakMap<HTMLInputElement, Bound>();
const all = new Set<HTMLInputElement>();

/** 금액 입력칸으로 만든다. 여러 번 불러도 한 번만 묶인다. */
export function bindAmountInput(el: HTMLInputElement, decimals = 8): HTMLInputElement {
  if (!bound.has(el)) {
    bound.set(el, { decimals, sats: null });
    all.add(el);
    el.addEventListener("input", () => remember(el));
    el.addEventListener("paste", () => queueMicrotask(() => remember(el)));
  }
  bound.get(el)!.decimals = decimals;
  el.type = "text";
  el.inputMode = "decimal";
  el.autocomplete = "off";
  el.spellcheck = false;
  el.setAttribute("autocapitalize", "off");
  el.placeholder = amountExample(numLocale());
  remember(el);
  return el;
}

function remember(el: HTMLInputElement) {
  const b = bound.get(el);
  if (!b) return;
  const r = parseAmountInput(el.value, numLocale(), { decimals: b.decimals });
  b.sats = r.ok ? r.sats : null;
}

/** 지금 칸의 글자를 지금 언어 규칙으로 읽는다. */
export function readAmount(el: HTMLInputElement): ParsedAmount {
  const b = bound.get(el);
  return parseAmountInput(el.value, numLocale(), { decimals: b?.decimals ?? 8 });
}

/** 코드가 칸을 채울 때(라비·짝 기기·환불 제안) — 사토시로 받고 지역 글자로 쓴다. */
export function setAmountSats(el: HTMLInputElement, sats: bigint | null) {
  el.value = sats === null || sats <= 0n ? "" : formatAmountForInput(sats, numLocale(), bound.get(el)?.decimals ?? 8);
  remember(el);
}
/** 노드·요청이 준 RVN 수로 칸을 채운다. */
export function setAmountRvn(el: HTMLInputElement, rvn: number) {
  setAmountSats(el, rvnNumberToSats(Number(rvn), bound.get(el)?.decimals ?? 8));
}

/** 못 받아들인 이유를 사람 말로(한국어 원문 = 번역 열쇠). */
export function amountProblemText(el: HTMLInputElement, r: ParsedAmount): string {
  if (r.ok) return "";
  return tf(AMOUNT_PROBLEM_SOURCE[r.problem], ...amountProblemValues(el.value, numLocale()));
}

/** 언어가 바뀌면: 받아들인 값은 새 지역 글자로 다시 쓰고, 못 받아들인 글자는 비운다. 자리표시도 새로. */
export function relocalizeAmountInputs(previousLocale: string) {
  for (const el of [...all]) {
    // 다시 그려져 화면에서 빠진 칸은 놓아준다(환불 창처럼 innerHTML 로 새로 만드는 칸).
    if (!el.isConnected) { all.delete(el); continue; }
    const b = bound.get(el)!;
    el.placeholder = amountExample(numLocale());
    if (!el.value.trim()) continue;
    const before = parseAmountInput(el.value, previousLocale, { decimals: b.decimals });
    const sats = before.ok ? before.sats : null;
    el.value = sats === null ? "" : formatAmountForInput(sats, numLocale(), b.decimals);
    b.sats = sats;
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }
}

let lastLocale = "";
if (typeof window !== "undefined") {
  lastLocale = numLocale();
  window.addEventListener("desktop-language-change", () => {
    const prev = lastLocale;
    lastLocale = numLocale();
    if (prev !== lastLocale) relocalizeAmountInputs(prev);
  });
}
