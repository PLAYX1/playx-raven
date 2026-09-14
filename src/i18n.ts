/* 데스크톱 프로그램 네 나라 말 — 한국어 · 영어 · 일본어 · 중국어.
 *
 * ## 웹(`web/i18n.js`)과 같은 방식이다
 *
 * 열쇠는 **한국어 원문 그대로**다. `t("보내기")` 처럼. 이유는 셋:
 *   1. 화면 곳곳에 `data-t="send_button"` 같은 이름표를 다는 순간, 빠뜨린
 *      자리가 반드시 생기고 그 자리만 한국어로 남는다.
 *   2. 사전에 없는 말은 **한국어 그대로 나온다.** 빈 자리나 `send_button`
 *      같은 것이 뜨는 것보다 낫다.
 *   3. 원문을 고치면 열쇠가 어긋나 사전에서 빠지는데, 그건 **눈에 띈다** —
 *      조용히 틀리는 것보다 훨씬 낫다.
 *
 * ## 🔴 화면이 스스로 번역한다
 *
 * 화면마다 `translate()` 를 부르게 하면 반드시 빠뜨린다. 실제로 웹 지갑에서
 * 그 한 줄이 안 돌고 있었다(2026-08-22 실측: 언어는 영어인데 화면은 한국어).
 *
 * 그리고 이 프로그램은 화면 대부분을 **나중에 그린다**(잔액·주문·자산 목록).
 * 한 번만 번역하면 그 뒤에 그려진 것은 다시 한국어다. 그래서 바뀔 때마다
 * 다시 번역한다. 되돌이는 저절로 멈춘다 — 번역된 글자는 한국어 열쇠와
 * 안 맞아서 두 번째부터는 아무것도 안 바뀐다.
 *
 * ## ⚠️ 옮기지 않는 것
 *
 * 사장이 직접 적은 것(가게 이름·메뉴 이름·자산 이름)은 **절대 안 옮긴다.**
 * 「제육볶음」을 우리가 옮기면 손님이 카운터에서 그 말을 하고 아무도 못
 * 알아듣는다. 사용자 데이터의 표시 요소에는 translate="no"를 붙인다. 사전 일치 여부는
 * 앱 문구와 사용자 글을 구분하는 근거가 될 수 없다.
 */

import { DICT } from "./dict";

export type Lang = "ko" | "en" | "ja" | "zh";

const KEY = "playx-raven-lang";

/** 이 컴퓨터가 정한 말. 저장해 둔 선택이 있으면 그게 이긴다. */
function pick(): Lang {
  try {
    const saved = localStorage.getItem(KEY);
    if (saved && (DICT as Record<string, unknown>)[saved]) return saved as Lang;
  } catch {
    /* localStorage 가 막혀 있어도 프로그램은 돈다 */
  }
  const sys = (navigator.language || "en").slice(0, 2).toLowerCase();
  if ((DICT as Record<string, unknown>)[sys]) return sys as Lang;
  // 🔴 사전에 없는 언어(불어·독어 등)일 때 **한국어를 주면 안 된다.**
  //    그 사람에게 한국어는 빈 화면과 같다. 영어는 적어도 짐작이 된다.
  //    한국어는 컴퓨터가 한국어일 때만 나온다 — 그때는 정확히 맞는다.
  return "en";
}

export let lang: Lang = pick();

/** 한 마디를 옮긴다. 없으면 **한국어 그대로** — 빈 자리보다 낫다. */
export function t(s: string): string {
  if (lang === "ko") return s;
  const d = DICT[lang];
  return (d && d[s]) || s;
}

/**
 * 값이 끼는 문장. 사전 열쇠는 `"{0}분 전"` 처럼 값 자리를 비운 한국어 원문이다.
 * 값은 **계산된 그대로** 끼운다 — 숫자를 다시 만들지 않는다(틀린 숫자보다
 * 한국어가 낫다는 원칙을 지키려고 번역은 문장 틀만 바꾼다).
 * 번역에 `{n}` 이 빠져 있으면 원문 틀을 쓴다.
 */
export function tf(source: string, ...values: unknown[]): string {
  const fill = (template: string) => template.replace(/\{(\d+)\}/g, (_, i) => String(values[Number(i)] ?? ""));
  const translated = t(source);
  const complete = values.every((_, i) => translated.includes(`{${i}}`));
  return fill(complete ? translated : source);
}

/** Change language without losing navigation, drafts, or reviewed transactions. */
export function setLang(l: Lang) {
  try {
    localStorage.setItem(KEY, l);
  } catch {
    /* 저장 못 해도 이번 판은 바뀐다 */
  }
  lang = l;
  translateDom();
  window.dispatchEvent(new Event("desktop-language-change"));
}

export const LANG_NAMES: Record<Lang, string> = {
  ko: "한국어",
  en: "English",
  ja: "日本語",
  zh: "简体中文",
};

/**
 * 화면에 이미 박힌 글자를 바꾼다.
 *
 * 🔴 긴 문장은 원본 HTML 에서 **줄바꿈으로 쪼개져** 있다. 그래서 글자 사이에
 * 줄바꿈과 들여쓰기가 들어가고, 한 줄짜리 사전 열쇠와 안 맞는다. 웹에서
 * 정확히 그 일이 났다 — 짧은 말은 다 옮겨졌는데 긴 안내문 열두 개만
 * 한국어로 남았고, 사전에는 다 있었다. **찾을 때만** 공백을 고르게 편다.
 */
/** App-authored HTML fragments carry their source; user strings never use this. */
export function copyHtml(source: string): string {
  const escape = (value: string) => value.replace(/[&<>"']/g, c => ({"&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;"}[c]!));
  return `<span data-desktop-copy="${escape(source)}">${escape(t(source))}</span>`;
}

// Explicit JS copy keeps its render function on the exact Text node. A user
// edit replaces that node, so it can never inherit another string's origin.
const textRenderers = new WeakMap<Node, { render: () => string; language: Lang }>();
export function setCopyText(element: Element, render: () => string) {
  const node = document.createTextNode(render());
  textRenderers.set(node, {render, language: lang});
  element.replaceChildren(node);
}

type Rendered = { source: string; rendered: string; lead: string; trail: string };
const originals = new WeakMap<Node, Rendered>();
const attributes = new WeakMap<Element, Map<string, Rendered>>();
// 🔴 앞뒤 공백은 **처음 본 원문의 것**을 기억한다. 번역값이 공백으로 시작하면
//    (「개」→" items") 다시 돌 때마다 공백이 한 칸씩 늘어났다(2026-09-14 실측).
function renderCopy(raw: string, previous?: Rendered): Rendered {
  if (previous?.rendered === raw) {
    const rendered = previous.lead + t(previous.source) + previous.trail;
    return { ...previous, rendered };
  }
  const lead = raw.match(/^\s*/)![0];
  const trail = raw.slice(lead.length).match(/\s*$/)![0];
  const source = raw.trim().replace(/\s+/g, " ");
  return { source, rendered: lead + t(source) + trail, lead, trail };
}
export function translateDom(root: Node = document.body) {
  const box = root instanceof Element ? root : document;
  box.querySelectorAll<HTMLElement>('[data-desktop-copy]').forEach(element => {
    if (element.closest('[translate="no"]')) return;
    const rendered = t(element.dataset.desktopCopy!);
    if (element.textContent !== rendered) element.textContent = rendered;
  });
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let n: Node | null;
  while ((n = walker.nextNode())) {
    const binding = textRenderers.get(n);
    if (binding) {
      if (binding.language !== lang) {
        n.nodeValue = binding.render();
        binding.language = lang;
      }
      continue;
    }
    if (n.parentElement?.closest('script, style, [translate="no"], [data-desktop-copy], textarea, input')) continue;
    const raw = n.nodeValue || "";
    if (!raw.trim()) continue;
    const next = renderCopy(raw, originals.get(n));
    originals.set(n, next);
    if (raw !== next.rendered) n.nodeValue = next.rendered;
  }
  box.querySelectorAll('[placeholder], [title], [aria-label]').forEach(e => {
    if (e.closest('[translate="no"]')) return;
    const saved = attributes.get(e) || new Map();
    for (const attr of ["placeholder", "title", "aria-label"]) {
      const raw = e.getAttribute(attr);
      if (!raw) continue;
      const next = renderCopy(raw, saved.get(attr));
      saved.set(attr, next);
      if (raw !== next.rendered) e.setAttribute(attr, next.rendered);
    }
    attributes.set(e, saved);
  });
  document.documentElement.lang = lang;
}

/** 켤 때 한 번 부른다. 그 뒤로는 화면이 바뀔 때마다 저절로 따라간다. */
export function startI18n() {
  const run = () => {
    try {
      translateDom(document.body);
    } catch {
      /* 번역이 실패해도 프로그램은 돌아야 한다 */
    }
  };
  run();
  if (!window.MutationObserver) return;
  let timer: number | null = null;
  new MutationObserver(() => {
    // 한 번에 몰아서. 글자 하나 바뀔 때마다 돌면 화면이 느려진다.
    if (timer !== null) return;
    timer = window.setTimeout(() => {
      timer = null;
      run();
    }, 60);
  }).observe(document.body, { childList: true, subtree: true, characterData: true });
}
