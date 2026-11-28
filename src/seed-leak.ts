/* 0.9.60 복구 단어 유출 경고 — 보내기 전에 한 번 묻는다(막지는 않는다).
 *
 * 사기꾼이 제일 먼저 하는 말이 「확인해 드릴 테니 복구 단어를 보내 주세요」다. 레이븐볼트는 누구에게도
 * 단어를 묻지 않는다 — 그러니 보내는 글에 단어처럼 보이는 것이 있으면, 보내기 **전에** 그 말을 한 번 한다.
 *
 * ## 판별 규칙(폰·웹 ~/wt-rv-060-site 와 같다)
 *   1. 소문자로 바꾸고(NFKC) 번호·쉼표·마침표·괄호·줄바꿈 같은 것은 띄어쓰기로 바꾼다.
 *   2. 띄어쓰기로 자른 낱말이 **BIP39 영어 단어장**에 있으면 이어 센다. 없는 낱말(한글·다른 영어)이 끼면 0부터.
 *   3. **연속 12개 이상**이면 「복구 단어처럼 보인다」.
 *
 * 🔴 지갑의 실제 단어는 보지 않는다(노드에 묻지도 않는다). 단어장 2048개와만 대조한다 —
 *    그래서 남의 지갑 단어·다른 앱 단어도 똑같이 잡고, 이 검사 때문에 내 단어가 화면에 드러날 일도 없다.
 * 🔴 확인 창의 기본은 「보내지 않기」다. Enter·Esc·바깥 누르기 모두 보내지 않는다.
 *    라비(AI)로 가는 글은 더 세게: 한 줄 더 말하고 「그래도 보내기」는 3초 뒤에야 눌린다.
 */
import WORDLIST_TXT from "./bip39-english.txt?raw";
import "./seed-leak.css";
import { t, tf } from "./i18n";
import { NEVER_ASKS, SEED_RUN_MIN, seedRunLength, seedTokens } from "./seed-leak-rule";

/** 라비 쪽 「그래도 보내기」가 잠겨 있는 시간. */
export const RAVI_SEND_DELAY_MS = 3000;
export { SEED_RUN_MIN, NEVER_ASKS, seedTokens };

let words: Set<string> | null = null;
function wordSet(): Set<string> {
  return (words ??= new Set(String(WORDLIST_TXT).trim().split(/\s+/)));
}

export function looksLikeSeedWords(text: string, list: ReadonlySet<string> = wordSet()): boolean {
  return seedRunLength(text, list) >= SEED_RUN_MIN;
}

export type LeakKind = "message" | "ravi";

let opened: Promise<boolean> | null = null;

/**
 * 보내도 되면 `true`. 단어처럼 보이지 않으면 묻지 않고 바로 `true`.
 * 보이면 확인 창 — 「보내지 않기」(기본) → `false`, 「그래도 보내기」 → `true`.
 */
export function confirmSeedLeak(text: string, kind: LeakKind = "message"): Promise<boolean> {
  if (!looksLikeSeedWords(text)) return Promise.resolve(true);
  if (typeof document === "undefined") return Promise.resolve(false);
  // 두 번 눌러 창이 겹치면 하나만 띄우고 같은 답을 준다.
  if (opened) return opened;
  opened = new Promise<boolean>((resolve) => {
    const wrap = document.createElement("div");
    wrap.className = "seedleak-wrap";
    const box = document.createElement("div");
    box.className = "askbox seedleak-box";
    box.setAttribute("role", "alertdialog");
    box.setAttribute("aria-modal", "true");
    box.setAttribute("aria-labelledby", "seedleak-title");
    box.setAttribute("aria-describedby", "seedleak-msg");
    box.dataset.kind = kind;
    const h = document.createElement("h3");
    h.id = "seedleak-title";
    h.textContent = t("복구 단어처럼 보여요");
    const msg = document.createElement("div");
    msg.className = "msg";
    msg.id = "seedleak-msg";
    msg.textContent = t("레이븐볼트는 누구에게도 복구 단어를 묻지 않습니다. 그래도 보낼까요?");
    box.append(h, msg);
    if (kind === "ravi") {
      const more = document.createElement("p");
      more.className = "seedleak-more";
      more.textContent = t("라비에게 보낸 글은 AI 회사로 나갈 수 있어요. 복구 단어를 아는 사람은 지갑의 돈을 모두 가져갈 수 있어요.");
      box.append(more);
    }
    const row = document.createElement("div");
    row.className = "askrow";
    const anyway = document.createElement("button");
    anyway.type = "button";
    anyway.className = "ghost seedleak-anyway";
    anyway.textContent = t("그래도 보내기");
    const keep = document.createElement("button");
    keep.type = "button";
    keep.className = "seedleak-keep";
    keep.textContent = t("보내지 않기");
    row.append(anyway, keep);
    box.append(row);
    wrap.append(box);

    let timer = 0;
    const prevFocus = document.activeElement as HTMLElement | null;
    const done = (send: boolean) => {
      clearInterval(timer);
      window.removeEventListener("keydown", onKey, true);
      wrap.remove();
      opened = null;
      try { prevFocus?.focus?.(); } catch { /* 창이 바뀌었으면 그만이다 */ }
      resolve(send);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); done(false); }
      // Enter 는 지금 초점이 있는 단추를 누른다(기본은 「보내지 않기」). 칸 밖으로 새지 않게 여기서 막는다.
      else if (e.key === "Enter") { e.preventDefault(); e.stopPropagation(); done(document.activeElement === anyway && !anyway.disabled); }
      else if (e.key === "Tab") {
        // 창 안에서만 돈다.
        const order = [anyway, keep].filter((b) => !b.disabled);
        const i = order.indexOf(document.activeElement as HTMLButtonElement);
        e.preventDefault();
        order[(i + (e.shiftKey ? order.length - 1 : 1)) % order.length]?.focus();
      }
    };
    keep.onclick = () => done(false);
    anyway.onclick = () => { if (!anyway.disabled) done(true); };
    wrap.addEventListener("mousedown", (e) => { if (e.target === wrap) done(false); });
    // 창(window)에서 먼저 듣는다 — 이야기 화면의 Esc(대화 닫기)·입력칸의 Enter(보내기)보다 앞서야 한다.
    window.addEventListener("keydown", onKey, true);

    if (kind === "ravi") {
      anyway.disabled = true;
      let left = Math.ceil(RAVI_SEND_DELAY_MS / 1000);
      anyway.textContent = tf("그래도 보내기 ({0})", left);
      timer = window.setInterval(() => {
        left--;
        if (left > 0) { anyway.textContent = tf("그래도 보내기 ({0})", left); return; }
        clearInterval(timer);
        anyway.disabled = false;
        anyway.textContent = t("그래도 보내기");
      }, 1000);
    }
    document.body.append(wrap);
    setTimeout(() => keep.focus(), 0);
  });
  return opened;
}
