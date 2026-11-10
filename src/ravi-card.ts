/**
 * 라비 카드 — 오른쪽 아래 라비 단추 위에 뜨는 카드 한 장(11-10 대표·페이블).
 *
 * 규칙(바꾸지 말 것):
 *  - **저절로 사라지지 않는다.** 어르신은 화면을 늦게 본다. 사람이 단추를 누를 때까지 남는다.
 *  - **한 장만.** 새 소식이 오면 같은 카드가 바뀐다(쌓지 않는다). 소리는 처음 뜰 때 한 번.
 *  - 글자 16px+, 단추 44px+. 앞으로 「확인하고 보내기」(돈·글·설정) 카드도 이 틀을 쓴다.
 *  - 카드는 **아무것도 보내지 않는다.** 단추는 화면을 열거나 입력칸을 채울 뿐이다.
 */
import { copyHtml } from "./i18n";
import "./ravi-card.css";

export type RaviCardButton = { label: string; primary?: boolean; run: () => void };
export type RaviCard = { key: string; title: string; body?: string; warn?: string; buttons: RaviCardButton[] };

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
let shownKey = "";

/** 카드를 띄우거나 바꾼다. 처음 뜰 때만 true(그때만 소리를 낸다). */
export function showRaviCard(card: RaviCard): boolean {
  let box = document.getElementById("rv-ravi-card");
  const first = !box || box.hidden;
  if (!box) {
    box = document.createElement("section");
    box.id = "rv-ravi-card";
    box.className = "rv-ravi-card";
    box.setAttribute("role", "status");
    box.setAttribute("aria-live", "polite");
    document.body.appendChild(box);
  }
  shownKey = card.key;
  box.innerHTML =
    `<div class="rv-ravi-card-head"><img src="/raven-hello.webp" alt="" width="40" height="40" /><b>${esc(card.title)}</b></div>` +
    (card.body ? `<p class="rv-ravi-card-body" translate="no">${esc(card.body)}</p>` : "") +
    (card.warn ? `<p class="rv-ravi-card-warn">${esc(card.warn)}</p>` : "") +
    `<div class="rv-ravi-card-row">${card.buttons.map((b, i) => `<button type="button" class="${b.primary ? "" : "ghost"}" data-rc="${i}">${copyHtml(b.label)}</button>`).join("")}</div>`;
  box.querySelectorAll<HTMLElement>("[data-rc]").forEach((el) => {
    el.onclick = () => { const b = card.buttons[Number(el.dataset.rc)]; hideRaviCard(); b?.run(); };
  });
  box.hidden = false;
  return first;
}
export function hideRaviCard() {
  const box = document.getElementById("rv-ravi-card");
  if (box) { box.hidden = true; box.innerHTML = ""; }
  shownKey = "";
}
export function raviCardKey(): string { return shownKey; }

/**
 * 돈·비밀 단어·딴 데로 끌어내는 말이 있는 글인가(사기 의심). 어르신 대상 사기는 주소보다
 * 「전화」「카톡으로」「급해」「대신 보내」처럼 **딴 데로 끌어내는 말**로 시작한다(페이블 11-10).
 * 막지는 않는다 — 그 글에 답장을 보내기 전에 한 번 더 묻는다.
 */
const RISKY = /송금|입금\s*해|이체\s*해|돈\s*(좀\s*)?(보내|빌려)|대신\s*보내|보내\s*주(세요|면|실)|복구\s*단어|12\s*단어|열두\s*단어|비밀\s*번호|비밀번호|지갑\s*주소|주소\s*(좀\s*)?알려|전화\s*(주세요|해\s*주|번호)|카톡\s*으로|카카오톡\s*으로|텔레그램|급해요|급합니다|https?:\/\/|seed\s*phrase|recovery\s*words|password|send\s*me|whatsapp|telegram/i;
export function looksRisky(text: string): boolean { return RISKY.test(String(text || "")); }
