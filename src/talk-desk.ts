/* 이야기 — 카톡 PC · 텔레그램 데스크탑의 손버릇(11-12 대표: 「카톡보다 못하다」).
 *
 * 화면 모양은 src/talk-dm.css, 쪽지 그리기는 src/talk-dm.ts. 이 파일은 손버릇만 묶는다:
 * - 목록 찾기 칸(Ctrl/⌘+F) · Esc 로 닫기(열린 칸 → 정보 칸 → 답장 → 대화 순서)
 * - 말풍선 오른쪽 클릭 · 길게 누르기 → 작은 메뉴(답장·복사·내 말로·간직·안 보기·지우기 요청)
 *   🔴 메뉴는 **이미 있는 단추를 대신 누를 뿐**이다(말풍선 아래 .bubacts). 보내기·암호·서명 길은 하나도 안 건드린다.
 * - 보내기 단추는 글(또는 붙인 사진)이 있을 때만 진하게 · 「새 메시지 N개 ↓」 알약
 */
import { copyHtml, setCopyText, t, tf } from "./i18n";
import { reportClose, reportOpen } from "./talk-report";

const $ = (id: string) => document.getElementById(id);

/** 가운데를 비운다(대화를 닫은 뒤). 다른 대화·방·광장을 열면 꺼진다. */
export function talkIdle(on: boolean) {
  const page = $("page-talk");
  if (!page) return;
  page.classList.toggle("idle", on);
  const box = $("tk-idle");
  if (box) box.hidden = !on;
}

/** 목록 찾기 칸의 말로 지금 보이는 목록(채팅·친구·광장 방·라비)을 거른다. */
export function applyFilter() {
  const input = $("tk-filter") as HTMLInputElement | null;
  const q = (input?.value || "").trim().toLowerCase();
  document.querySelectorAll<HTMLElement>("#tk-chats .tkc-row, #tk-friends .tkc-row, #tk-rooms .room, #rv-room-ravi").forEach((r) => {
    r.classList.toggle("tk-filtered", !!q && !(r.textContent || "").toLowerCase().includes(q));
  });
}

/**
 * 「새 메시지 N개 ↓」 — 맨 아래에 있지 않을 때 새로 온 말 수. 맨 아래로 내려오면(굴림·알약) 센 것을 비운다.
 * key 는 대화마다 다르게(방·쪽지) — 대화를 바꾸면 처음부터 센다.
 */
export function unreadPill(box: HTMLElement, ids: string[], atBottom: boolean, key: string) {
  const nm = $("tk-new-messages");
  if (!nm) return;
  const last = ids[ids.length - 1] || "";
  if (box.dataset.pillFor !== key) { box.dataset.pillFor = key; box.dataset.seenLast = last; }
  box.dataset.lastId = last;
  if (atBottom) { box.dataset.seenLast = last; nm.hidden = true; return; }
  const i = ids.lastIndexOf(box.dataset.seenLast || "");
  const n = i < 0 ? 0 : ids.length - 1 - i;
  if (n <= 0) { nm.hidden = true; return; }
  setCopyText(nm, () => tf("새 메시지 {0}개 ↓", n));
  nm.hidden = false;
}

export type DeskDeps = {
  dm: { active: () => boolean; close: (repaint?: boolean) => void; side: () => string; textOf: (id: string) => string | undefined };
  room: () => string;
  openFeed: () => void;
  me: () => string;
  /** 「신고」 창(src/talk-report.ts)을 연다. */
  report: (bub: HTMLElement, text: string) => void;
};

const ICON = {
  reply: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 14L4 9l5-5"/><path d="M4 9h10a6 6 0 0 1 6 6v5"/></svg>`,
  copy: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 0 1 2-2h8"/></svg>`,
  link: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/></svg>`,
  tr: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 5h9M8.5 3v2M6 5c.6 3 2.6 5.5 5 7M11 5c-.8 3.6-3.3 6.6-7 8"/><path d="M13 21l4-9 4 9M14.5 18h5"/></svg>`,
  keep: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" aria-hidden="true"><path d="M6 3h12v18l-6-4-6 4z"/></svg>`,
  mute: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M5.6 5.6l12.8 12.8"/></svg>`,
  flag: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 21V4M5 4h11l-2 4 2 4H5"/></svg>`,
  del: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/></svg>`,
};

export function wireTalkDesk(d: DeskDeps) {
  const page = $("page-talk");
  const list = $("tk-list");
  const filter = $("tk-filter") as HTMLInputElement | null;
  if (!page || !list) return;
  const onTalk = () => page.classList.contains("on");
  const visible = (id: string) => { const e = $(id); return !!e && !e.hidden && getComputedStyle(e).display !== "none"; };

  // ── 목록 찾기 ─────────────────────────────────────────────────────
  filter?.addEventListener("input", applyFilter);
  filter?.addEventListener("keydown", (ev) => {
    if (ev.key !== "Escape") return;
    ev.preventDefault(); ev.stopPropagation();
    if (filter.value) { filter.value = ""; applyFilter(); } else filter.blur();
  });

  // ── 정보 칸(오른쪽) 열고 닫기 ───────────────────────────────────────
  const info = $("tk-info");
  const paintInfo = () => info?.setAttribute("aria-pressed", String(page.classList.contains("infoon")));
  info?.addEventListener("click", () => { page.classList.toggle("infoon"); paintInfo(); });
  new MutationObserver(paintInfo).observe(page, { attributes: true, attributeFilter: ["class"] });
  if (info) { info.title = t("정보"); }
  const more = $("tk-more");
  if (more) more.title = t("더 보기");
  for (const [id, label] of [["tk-searchbtn", "찾기"], ["tk-bell", "알림"]] as const) { const b = $(id); if (b) b.title = t(label); }
  for (const [id, label] of [["tk-photo", "사진"], ["tk-stk", "이모티콘"]] as const) { const b = $(id); if (b) b.title = t(label); }

  // ── 보내기: 글(또는 붙인 사진)이 있을 때만 진하게 ─────────────────────
  const ta = $("tk-text") as HTMLTextAreaElement | null;
  const composer = ta?.closest(".composer");
  const syncSend = () => { if (ta && composer) composer.classList.toggle("tk-empty", !ta.value.trim() && ($("tk-photobox")?.hidden ?? true)); };
  ta?.addEventListener("input", syncSend);
  // 글자를 코드가 바꾸는 자리(보낸 뒤 비우기·빠른 답장·이모티콘)가 여럿이라 이야기 화면이 보일 때만 가볍게 다시 본다.
  window.setInterval(() => { if (onTalk()) syncSend(); }, 400);
  syncSend();

  // ── 「새 메시지 N개 ↓」: 맨 아래로 내려오면 비운다 ──────────────────────
  list.addEventListener("scroll", () => {
    if (page.classList.contains("feedon")) return;
    if (list.scrollHeight - list.scrollTop - list.clientHeight < 40) {
      list.dataset.seenLast = list.dataset.lastId || "";
      const nm = $("tk-new-messages");
      if (nm) nm.hidden = true;
    }
  });

  // ── 말풍선 메뉴 ───────────────────────────────────────────────────
  let menu: HTMLElement | null = null;
  let onBub: HTMLElement | null = null;
  const closeMenu = () => {
    if (!menu || menu.hidden) return;
    menu.hidden = true;
    onBub?.classList.remove("tk-ctxon");
    onBub = null;
  };
  const say = (msg: string) => {
    const note = $("tk-note");
    if (!note) return;
    note.textContent = msg;
    window.setTimeout(() => { if (note.textContent === msg) note.textContent = ""; }, 2500);
  };
  const copyOf = (bub: HTMLElement): string => {
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed && sel.anchorNode && bub.contains(sel.anchorNode)) return sel.toString();
    const dmId = bub.dataset.dm;
    const raw = dmId ? d.dm.textOf(dmId) : undefined;
    if (raw !== undefined) return raw;
    const c = bub.cloneNode(true) as HTMLElement;
    c.querySelectorAll(".replyquote, .tr, .tk-fold, .picwait, .picfail").forEach((n) => n.remove());
    c.querySelectorAll<HTMLImageElement>("img.tk-stk").forEach((img) => img.replaceWith(document.createTextNode(img.alt ? `(${img.alt})` : "")));
    return (c.textContent || "").trim();
  };
  const openMenu = (bub: HTMLElement, x: number, y: number) => {
    if (!menu) {
      menu = document.createElement("div");
      menu.className = "tk-ctx"; menu.id = "tk-ctx"; menu.hidden = true;
      menu.setAttribute("role", "menu");
      document.body.append(menu);
      document.addEventListener("mousedown", (ev) => { if (menu && !menu.hidden && !menu.contains(ev.target as Node)) closeMenu(); }, true);
      window.addEventListener("blur", closeMenu);
      window.addEventListener("resize", closeMenu);
      menu.addEventListener("keydown", (ev) => {
        const items = [...menu!.querySelectorAll<HTMLElement>("button")];
        const i = items.indexOf(document.activeElement as HTMLElement);
        if (ev.key === "ArrowDown") { ev.preventDefault(); items[(i + 1) % items.length]?.focus(); }
        if (ev.key === "ArrowUp") { ev.preventDefault(); items[(i - 1 + items.length) % items.length]?.focus(); }
      });
    }
    const id = bub.dataset.say || "";
    const acts = id ? list.querySelector<HTMLElement>(`[data-acts="${CSS.escape(id)}"]`) : null;
    type Item = { label: string; icon: string; harm?: boolean; run: () => void } | "sep";
    const items: Item[] = [];
    const proxy = (sel: string, label: string, icon: string, harm = false) => {
      const b = acts?.querySelector<HTMLButtonElement>(sel);
      if (b && !b.disabled) items.push({ label, icon, harm, run: () => b.click() });
    };
    proxy("[data-reply]", "답장", ICON.reply);
    items.push({ label: "복사", icon: ICON.copy, run: () => {
      const text = copyOf(bub);
      void navigator.clipboard.writeText(text).then(() => say(t("복사했어요")), () => say(text));
    } });
    proxy("[data-share]", "링크 복사", ICON.link);
    proxy("[data-tr]", "내 말로", ICON.tr);
    proxy("[data-keep]", "간직", ICON.keep);
    const harmStart = items.length;
    proxy("[data-mute]", "안 보기", ICON.mute, true);
    proxy("[data-del]", "지우기 요청", ICON.del, true);
    const author = String(bub.dataset.author || "");
    if (author && author !== d.me()) items.push({ label: "신고", icon: ICON.flag, harm: true, run: () => d.report(bub, copyOf(bub)) });
    if (items.length > harmStart && harmStart > 0) items.splice(harmStart, 0, "sep");
    menu.innerHTML = items.map((it, i) => it === "sep" ? "<hr />" : `<button type="button" role="menuitem" data-i="${i}"${it.harm ? ' class="harm"' : ""}>${it.icon}${copyHtml(it.label)}</button>`).join("");
    menu.querySelectorAll<HTMLElement>("button[data-i]").forEach((b) => {
      b.onclick = () => { const it = items[Number(b.dataset.i)]; closeMenu(); if (it !== "sep") it.run(); };
    });
    onBub?.classList.remove("tk-ctxon");
    onBub = bub;
    bub.classList.add("tk-ctxon");
    menu.hidden = false;
    menu.style.left = "0px"; menu.style.top = "0px";
    const r = menu.getBoundingClientRect();
    menu.style.left = `${Math.max(8, Math.min(x, innerWidth - r.width - 8))}px`;
    menu.style.top = `${Math.max(8, Math.min(y, innerHeight - r.height - 8))}px`;
    menu.querySelector<HTMLElement>("button")?.focus({ preventScroll: true });
  };
  const bubAt = (target: EventTarget | null): HTMLElement | null => {
    if (page.classList.contains("feedon")) return null; // 광장 피드 카드는 단추가 늘 보인다
    return (target as HTMLElement | null)?.closest<HTMLElement>("#tk-list .bub[data-say], #tk-list .bub[data-dm]") ?? null;
  };
  list.addEventListener("contextmenu", (ev) => {
    const bub = bubAt(ev.target);
    if (!bub) return;
    ev.preventDefault();
    openMenu(bub, ev.clientX, ev.clientY);
  });
  // 손가락·펜: 길게 누르기(0.55초). 움직이면 굴리기로 보고 그만둔다.
  let hold: number | undefined, sx = 0, sy = 0, swallow = false;
  const stopHold = () => { window.clearTimeout(hold); hold = undefined; };
  list.addEventListener("pointerdown", (ev) => {
    if (ev.pointerType === "mouse") return;
    const bub = bubAt(ev.target);
    if (!bub) return;
    sx = ev.clientX; sy = ev.clientY;
    stopHold();
    hold = window.setTimeout(() => { hold = undefined; swallow = true; openMenu(bub, sx, sy); }, 550);
  });
  list.addEventListener("pointermove", (ev) => { if (hold && Math.hypot(ev.clientX - sx, ev.clientY - sy) > 10) stopHold(); });
  list.addEventListener("pointerup", stopHold);
  list.addEventListener("pointercancel", stopHold);
  list.addEventListener("click", (ev) => { if (swallow) { swallow = false; ev.stopPropagation(); ev.preventDefault(); } }, true);
  list.addEventListener("scroll", closeMenu);

  // ── 글쇠: Ctrl/⌘+F = 목록 찾기 · Esc = 닫기 ───────────────────────────
  // 먼저 듣는다(capture) — 확인 창·공유 창이 떠 있으면 그쪽이 Esc 를 받게 비켜 준다.
  document.addEventListener("keydown", (ev) => {
    if (!onTalk() || ev.defaultPrevented) return;
    if ((ev.ctrlKey || ev.metaKey) && !ev.altKey && !ev.shiftKey && ev.key.toLowerCase() === "f") {
      ev.preventDefault();
      if (page.classList.contains("infoon") && innerWidth <= 1320) page.classList.remove("infoon");
      filter?.focus(); filter?.select();
      return;
    }
    if (ev.key !== "Escape" || ev.isComposing) return;
    if (menu && !menu.hidden) { ev.preventDefault(); ev.stopPropagation(); closeMenu(); bubFocusBack(); return; }
    if (reportOpen()) { ev.preventDefault(); ev.stopPropagation(); reportClose(); return; }
    if ($("askwrap")?.classList.contains("on") || visible("tk-sharepop") || visible("desktop-language-menu") || visible("info") || $("dropveil")?.classList.contains("on")) return;
    if (ev.target === filter) return;
    // ① 열린 칸
    const boxes: [string, string][] = [["tk-stickerbox", "tk-stk"], ["tk-mentionbox", "tk-at"], ["tk-ravipanel", "tk-ravi"], ["tk-morebox", "tk-more"], ["tk-searchbox", "tk-searchbtn"], ["tk-noticebox", "tk-bell"], ["tk-dmbox", ""], ["tk-bmbox", ""], ["tk-mutebox", ""], ["tk-rvnbox", ""], ["tk-notebox", ""], ["tk-mydatabox", ""]];
    const openBox = boxes.find(([id]) => visible(id));
    if (openBox) { ev.preventDefault(); $(openBox[0])!.hidden = true; if (openBox[1]) $(openBox[1])?.setAttribute("aria-expanded", "false"); return; }
    // ② 정보 칸 · ③ 답장
    if (page.classList.contains("infoon")) { ev.preventDefault(); page.classList.remove("infoon"); return; }
    if (visible("tk-replybar")) { ev.preventDefault(); $("tk-replyx")?.click(); return; }
    // ④ 대화 닫기 — 채팅 칸이면 가운데를 비우고(카톡 PC), 광장 칸에서 방을 닫으면 광장 피드로.
    if (page.classList.contains("idle")) return;
    if (!d.dm.active() && !d.room()) return;
    ev.preventDefault();
    const fromChats = d.dm.side() !== "square";
    if (d.dm.active()) d.dm.close(true); else d.openFeed();
    if (fromChats) talkIdle(true);
    (document.activeElement as HTMLElement | null)?.blur?.();
  }, true);
  const bubFocusBack = () => ta?.focus({ preventScroll: true });
}
