// 대화 화면 부품(카카오톡 기준) — 라비 대화·사용자 대화가 같은 규칙을 쓰게 한다.
// 규칙(docs/design/layout-tokens.md §대화):
//   1. 말풍선 최대 폭 --bubble-max(72%, 560px 상한). 좁은 칸(≤360px)에서는 86%, 시각은 숨김.
//   2. 긴 낱말·주소·해시는 overflow-wrap:anywhere — 가로 넘침 0. 한국어는 낱말 단위(keep-all).
//   3. 시각은 말풍선 바깥 아래쪽 정렬, 고정폭 숫자. 같은 분·같은 사람이면 마지막 줄에만.
//   4. 입력창은 글 양에 따라 1~6줄 자동으로 커지고 그 뒤는 안에서 스크롤.
//   5. 바닥에 붙어 있을 때만 새 글에 따라 내려간다(위를 읽는 중이면 「새 글 ↓」 단추).
//   6. 키보드: Enter 보내기 · Shift+Enter 줄바꿈 · 한글 조합 중 Enter 는 무시 · 기록에서 ↑/↓ 로 말풍선 이동 · End 로 바닥.
// 🔴 글자는 전부 textContent — HTML 로 넣지 않는다(대화 글은 남이 쓴 것일 수 있다).

export type ChatMsg = { id: string; me: boolean; text: string; at: number };

const NEAR_BOTTOM = 48;

export function sameGroup(a: ChatMsg | undefined, b: ChatMsg | undefined): boolean {
  return !!a && !!b && a.me === b.me && Math.floor(a.at / 60) === Math.floor(b.at / 60);
}

/** 각 메시지에 시각을 붙일지 — 같은 사람·같은 분의 연속이면 마지막에만. */
export function timeShown(list: ChatMsg[]): boolean[] {
  return list.map((m, i) => !sameGroup(m, list[i + 1]));
}

/** 입력창 줄 수(1~max) — 높이 계산을 DOM 없이 시험할 수 있게. */
export function rowsFor(text: string, charsPerLine: number, max = 6): number {
  const lines = text.split("\n").reduce((n, l) => n + Math.max(1, Math.ceil([...l].length / Math.max(1, charsPerLine))), 0);
  return Math.min(max, Math.max(1, lines));
}

export function fmtTime(at: number, locale = "ko"): string {
  const d = new Date(at * 1000);
  const h = d.getHours(), m = String(d.getMinutes()).padStart(2, "0");
  if (locale.startsWith("ko")) return `${h < 12 ? "오전" : "오후"} ${h % 12 || 12}:${m}`;
  return `${h % 12 || 12}:${m} ${h < 12 ? "AM" : "PM"}`;
}

export type ChatThread = { el: HTMLElement; add(m: ChatMsg): void; set(list: ChatMsg[]): void; atBottom(): boolean };

export function createChatThread(opts: { label: string; placeholder: string; send: string; jump: string; locale?: string; onSend?: (text: string) => void }): ChatThread {
  const locale = opts.locale ?? "ko";
  const root = document.createElement("section");
  root.className = "rvc";
  root.setAttribute("aria-label", opts.label);
  const log = document.createElement("div");
  log.className = "rvc-log";
  log.setAttribute("role", "log");
  log.setAttribute("aria-live", "polite");
  log.tabIndex = 0;
  const jump = document.createElement("button");
  jump.type = "button"; jump.className = "rvc-jump ghost"; jump.textContent = opts.jump; jump.hidden = true;
  const form = document.createElement("div");
  form.className = "rvc-input";
  const ta = document.createElement("textarea");
  ta.rows = 1; ta.placeholder = opts.placeholder; ta.setAttribute("aria-label", opts.placeholder);
  const btn = document.createElement("button");
  btn.type = "button"; btn.textContent = opts.send;
  form.append(ta, btn);
  root.append(log, form);
  let list: ChatMsg[] = [];

  const atBottom = () => log.scrollHeight - log.scrollTop - log.clientHeight < NEAR_BOTTOM;
  const toBottom = () => { log.scrollTop = log.scrollHeight; jump.hidden = true; };
  log.addEventListener("scroll", () => { if (atBottom()) jump.hidden = true; });
  jump.addEventListener("click", () => { toBottom(); ta.focus(); });

  function row(m: ChatMsg, showTime: boolean, fresh: boolean): HTMLElement {
    const r = document.createElement("div");
    r.className = `rvc-row${m.me ? " me" : ""}${fresh ? " new" : ""}`;
    r.dataset.id = m.id;
    const b = document.createElement("div");
    b.className = "rvc-bubble"; b.textContent = m.text; b.tabIndex = -1;
    r.append(b);
    if (showTime) { const t = document.createElement("time"); t.className = "rvc-time"; t.dateTime = new Date(m.at * 1000).toISOString(); t.textContent = fmtTime(m.at, locale); r.append(t); }
    return r;
  }
  function paint(fresh: string | null) {
    const stick = atBottom();
    const shows = timeShown(list);
    log.replaceChildren(...list.map((m, i) => row(m, shows[i], m.id === fresh)), jump);
    if (stick || fresh === null) toBottom(); else if (fresh) jump.hidden = false;
  }
  function grow() {
    // rows 속성으로만 키운다(style 속성을 남기지 않는다 — Tauri nonce CSP 규칙). 6줄 넘으면 안에서 스크롤.
    ta.rows = 1;
    while (ta.rows < 6 && ta.scrollHeight > ta.clientHeight + 1) ta.rows += 1;
  }
  ta.addEventListener("input", grow);
  let composing = false;
  ta.addEventListener("compositionstart", () => (composing = true));
  ta.addEventListener("compositionend", () => (composing = false));
  const submit = () => { const v = ta.value.trim(); if (!v) return; opts.onSend?.(v); ta.value = ""; grow(); };
  ta.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !composing && !e.isComposing) { e.preventDefault(); submit(); }
  });
  btn.addEventListener("click", submit);
  log.addEventListener("keydown", (e) => {
    const bubbles = [...log.querySelectorAll<HTMLElement>(".rvc-bubble")];
    if (!bubbles.length) return;
    const i = bubbles.indexOf(document.activeElement as HTMLElement);
    if (e.key === "ArrowUp" || e.key === "ArrowDown") {
      e.preventDefault();
      const n = i < 0 ? bubbles.length - 1 : Math.max(0, Math.min(bubbles.length - 1, i + (e.key === "ArrowUp" ? -1 : 1)));
      bubbles[n].focus();
    } else if (e.key === "End") { e.preventDefault(); toBottom(); bubbles[bubbles.length - 1].focus(); }
  });
  return {
    el: root,
    add(m) { list = [...list, m]; paint(m.id); },
    set(l) { list = [...l]; paint(null); },
    atBottom,
  };
}
