/* 「방 설정」 시트 · 「숨긴 방」 목록 · 숨기기 (0.9.0 레인 C) — 누를 때 읽는 지연 묶음.
 *
 * 모양은 시안 ~/rv-design-089/mockups/talk.html 의 `aside#info`(방 설정): 오른쪽에서 나오는 380px 덮개.
 * 시안은 넓은 창(1180 이상)에서 셋째 칸으로 붙지만, 그 칸(.rv-person)은 레인 A 의 이야기 화면 몫이라
 * 여기서는 **모든 폭에서 덮개**로 둔다(1024 폭 시안과 같은 모양).
 *
 * 🔴 지키는 것
 *  - 이름·설명 고치기는 **만든 사람만**(러스트가 다시 확인한다 — 화면은 단추를 숨길 뿐).
 *  - 검사는 러스트와 같은 선(40자·80자·빈 이름·제어 문자·숨은 방향 문자). 화면이 먼저 말하고 러스트가 한 번 더 막는다.
 *  - 지갑이 잠겨 있으면 오류 상자 대신 **「지갑 열기」 안내를 시트 안에서 먼저**(기존 ensureUnlocked 재사용 —
 *    새 암호 입력 경로 없음). 열고 나면 같은 저장을 다시 시도한다.
 *  - 결과는 정직하게: 공개 릴레이 몇 곳 중 몇 곳이 받았는지, 이 컴퓨터 릴레이에 남았는지.
 *  - 「지우기」는 없다. 공개 릴레이에 있는 방은 완전히 지울 수 없다고 적는다.
 *  - 사용자가 적은 방 이름·설명은 번역하지 않는다(translate="no").
 */
import "./talk-rooms-admin.css";
import { DICT } from "./dict";
import { t, tf, setCopyText } from "./i18n";
import { seedErrorKind } from "./seed-recovery";
import { TALK_ROOMS_ADMIN_COPY } from "./talk-rooms-admin-copy";
import {
  ROOM_ABOUT_MAX, ROOM_NAME_MAX, canEditRoom, hideRoom, isOfficialRoom, loadHidden, unhideRoom,
  type AdminCore, type TalkRoom,
} from "./talk-rooms-admin";

for (const [source, values] of Object.entries(TALK_ROOMS_ADMIN_COPY)) {
  (["en", "ja", "zh"] as const).forEach((language, index) => { DICT[language][source] ??= values[index]; });
}

export interface Sheet {
  openSettings(): void;
  close(): void;
  isOpen(): boolean;
  /** 열린 시트를 지금 방 정보로 다시 그린다(목록이 새 이름을 돌려줬을 때). */
  refresh(): void;
  hideCurrent(): Promise<void>;
  toggleHidden(): void;
  paintHidden(): void;
}

/** 러스트 `bad_meta_char` 와 같은 글자들. 제어 문자 + 폭 없는 공백·방향 표시·방향 덮어쓰기·BOM. */
const BAD = /[\u0000-\u001F\u007F-\u009F​‎‏‪-‮⁦-⁩﻿]/;
const chars = (s: string) => Array.from(s).length;

/** 이름·설명 검사. 문제가 없으면 null, 있으면 화면에 띄울 말(이미 옮긴 것). */
export function checkRoomMeta(name: string, about: string): string | null {
  const n = name.trim();
  const a = about.trim();
  if (!n) return t("방 이름이 필요해요.");
  if (BAD.test(n) || BAD.test(a)) return t("줄바꿈이나 보이지 않는 특수 문자는 쓸 수 없어요.");
  if (chars(n) > ROOM_NAME_MAX) return tf("방 이름은 {0}자까지 쓸 수 있어요. 지금 {1}자예요.", ROOM_NAME_MAX, chars(n));
  if (chars(a) > ROOM_ABOUT_MAX) return tf("한 줄 설명은 {0}자까지 쓸 수 있어요. 지금 {1}자예요.", ROOM_ABOUT_MAX, chars(a));
  return null;
}

type MetaResult = { name?: string; about?: string; public_ok?: number; public_total?: number; local_ok?: boolean };

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> & { cls?: string } = {}, ...kids: (Node | string)[]) => {
  const e = document.createElement(tag);
  const { cls, ...rest } = props as any;
  if (cls) e.className = cls;
  Object.assign(e, rest);
  e.append(...kids);
  return e;
};
/** 번역되는 앱 문구. 언어를 바꾸면 그 자리에서 다시 옮긴다. */
const copy = <E extends HTMLElement>(e: E, source: string): E => { setCopyText(e, () => t(source)); return e; };
/** 사용자가 적은 글(방 이름·설명). 옮기지 않는다. */
const user = <E extends HTMLElement>(e: E, text: string): E => { e.textContent = text; e.setAttribute("translate", "no"); return e; };

export function createSheet(core: AdminCore): Sheet {
  const { deps } = core;
  let box: HTMLElement | null = null;
  let roomId = "";
  let busy = false;
  let lastFocus: HTMLElement | null = null;

  const page = () => document.getElementById("page-talk");
  const infoBtn = () => document.getElementById("tk-room-settings");
  // 병합(0.9.0): 레인 A 가 비워 둔 마운트 자리 #tk-room-sheet(.talkwrap 격자 안, display:contents) 안에 붙인다.
  // 자리 상자의 hidden 은 시트와 같이 켜고 끈다. 자리가 없으면 예전처럼 #page-talk 에.
  const host = () => document.getElementById("tk-room-sheet");
  const show = (on: boolean) => { if (box) box.hidden = !on; const h = host(); if (h && box && h.contains(box)) h.hidden = !on; };

  function close(): void {
    if (!box || box.hidden) return;
    show(false);
    infoBtn()?.setAttribute("aria-expanded", "false");
    (lastFocus && document.contains(lastFocus) ? lastFocus : infoBtn())?.focus?.();
  }

  function build(): HTMLElement {
    const aside = el("aside", { id: "info", cls: "tkinfo", hidden: true });
    aside.setAttribute("role", "dialog");
    aside.setAttribute("aria-modal", "false");
    aside.setAttribute("aria-labelledby", "info-h");
    aside.addEventListener("keydown", (e) => { if (e.key === "Escape") { e.stopPropagation(); close(); } });
    (host() ?? page() ?? document.body).append(aside);
    return aside;
  }

  function render(room: TalkRoom): void {
    if (!box) box = build();
    const name = String(room.name || t("이름 없는 방"));
    const about = String(room.about || "");
    const closeBtn = copy(el("button", { id: "closeinfo", cls: "ghost", type: "button" }), "닫기");
    closeBtn.addEventListener("click", close);
    const av = el("span", { cls: "tkinfo-av" }, Array.from(name)[0] || "#");
    av.setAttribute("aria-hidden", "true");
    av.setAttribute("translate", "no"); // 방 이름 첫 글자 — 사용자 글이다

    // ── 방 정보(만든 사람만) ──────────────────────────────────────────
    const row = (id: string, label: string, value: string) => {
      const v = value ? user(el("span", { cls: "tkinfo-t" }), value) : copy(el("span", { cls: "tkinfo-t tkinfo-none" }), "(없음)");
      const b = el("button", { id, cls: "tkinfo-row", type: "button" },
        el("span", { cls: "tkinfo-txt" }, copy(el("span", { cls: "tkinfo-lbl" }), label), v),
        copy(el("span", { cls: "tkinfo-link" }), "수정"));
      b.addEventListener("click", () => openForm(id === "info-edit-about" ? "info-about" : "info-name"));
      return b;
    };
    const meta = el("div", { cls: "tkinfo-group", id: "info-meta" }, row("info-edit-name", "방 이름", name), row("info-edit-about", "한 줄 설명", about));

    const nameIn = el("input", { id: "info-name", value: name, autocomplete: "off", spellcheck: false });
    nameIn.maxLength = ROOM_NAME_MAX;
    const aboutIn = el("input", { id: "info-about", value: about, autocomplete: "off" });
    aboutIn.maxLength = ROOM_ABOUT_MAX;
    const nameN = el("span", { cls: "tkinfo-count", id: "info-name-n" });
    const aboutN = el("span", { cls: "tkinfo-count", id: "info-about-n" });
    const count = () => {
      nameN.textContent = `${chars(nameIn.value.trim())}/${ROOM_NAME_MAX}`;
      aboutN.textContent = `${chars(aboutIn.value.trim())}/${ROOM_ABOUT_MAX}`;
    };
    nameIn.addEventListener("input", count);
    aboutIn.addEventListener("input", count);
    count();
    const say = el("p", { id: "info-say", cls: "tkinfo-say" });
    say.setAttribute("role", "status");
    say.setAttribute("aria-live", "polite");
    const lock = el("div", { id: "info-lock", cls: "tkinfo-lock", hidden: true });
    const save = copy(el("button", { id: "info-save", type: "submit" }), "저장");
    const cancel = copy(el("button", { id: "info-cancel", cls: "ghost", type: "button" }), "취소");
    const nameLbl = copy(el("label", { htmlFor: "info-name" }), "방 이름");
    const aboutLbl = copy(el("label", { htmlFor: "info-about" }), "한 줄 설명 (없어도 됩니다)");
    const form = el("form", { id: "info-form", cls: "tkinfo-form", hidden: true },
      el("div", { cls: "tkinfo-field" }, nameLbl, nameN), nameIn,
      el("div", { cls: "tkinfo-field" }, aboutLbl, aboutN), aboutIn,
      copy(el("p", { cls: "tkinfo-note" }), "바꾼 이름은 릴레이에 닿는 대로 모두에게 보여요. 다른 Nostr 앱에서는 옛 이름으로 보일 수 있어요."),
      lock,
      el("div", { cls: "tkinfo-acts" }, save, cancel));
    cancel.addEventListener("click", () => { form.hidden = true; meta.hidden = false; say.textContent = ""; lock.hidden = true; });
    form.addEventListener("submit", (e) => { e.preventDefault(); void submit(); });
    for (const input of [nameIn, aboutIn]) input.addEventListener("keydown", (e) => {
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); cancel.click(); }
    });

    function openForm(focusId: string): void {
      nameIn.value = String(core.room(roomId)?.name || name);
      aboutIn.value = String(core.room(roomId)?.about ?? about);
      count();
      say.textContent = "";
      lock.hidden = true;
      meta.hidden = true;
      form.hidden = false;
      (focusId === "info-about" ? aboutIn : nameIn).focus();
    }

    async function submit(): Promise<void> {
      if (busy) return;
      const cur = core.room(roomId);
      if (!cur || !canEditRoom(cur, deps.me())) { close(); return; }
      const n = nameIn.value.trim();
      const a = aboutIn.value.trim();
      const bad = checkRoomMeta(n, a);
      say.className = "tkinfo-say";
      lock.hidden = true;
      if (bad) { say.textContent = bad; say.classList.add("warn"); return; }
      if (n === String(cur.name || "") && a === String(cur.about || "")) { say.textContent = t("바뀐 것이 없어요."); return; }
      busy = true;
      save.disabled = true;
      say.textContent = t("저장하는 중…");
      try {
        const r = await deps.call<MetaResult>("talk_room_meta_set", { room: roomId, name: n, about: a });
        core.setOverride(roomId, String(r?.name ?? n), String(r?.about ?? a));
        const ok = Number(r?.public_ok || 0);
        const total = Number(r?.public_total || 0);
        const parts = ok > 0
          ? [tf("이름을 바꿨어요. 공개 릴레이 {1}곳 중 {0}곳이 받았어요.", ok, total)]
          : [t("공개 릴레이는 한 곳도 받지 않았어요. 지금은 이 컴퓨터에서만 바뀐 이름이 보여요. 잠시 뒤 다시 저장해 주세요.")];
        if (r?.local_ok) parts.push(t("이 컴퓨터의 릴레이에도 저장했어요."));
        const message = parts.join(" ");
        await deps.reload();
        // 다시 그린 시트에 결과를 남긴다(목록·머리줄 이름도 이미 바뀌어 있다).
        renderCurrent();
        const s = document.getElementById("info-say");
        if (s) { s.textContent = message; s.classList.toggle("warn", ok === 0); }
      } catch (e) {
        if (seedErrorKind(e) === "LOCKED") {
          // 🔴 빨간 상자 대신 이유부터. 「지갑 열기」는 기존 ensureUnlocked — 새 암호 경로를 만들지 않는다.
          say.textContent = "";
          lock.replaceChildren(
            copy(el("p"), "지갑이 잠겨 있어요. 방 이름을 바꾸려면 지갑을 한 번 열어야 해요. 지갑 암호만 묻고, 복구 단어는 묻지 않아요."),
            unlockButton(),
          );
          lock.hidden = false;
        } else {
          say.textContent = `${t("이름을 바꾸지 못했어요. 원래 이름 그대로예요.")} ${deps.errText(e)}`;
          say.classList.add("warn");
        }
      } finally {
        busy = false;
        save.disabled = false;
      }
    }

    function unlockButton(): HTMLButtonElement {
      const b = copy(el("button", { id: "info-unlock", type: "button" }), "지갑 열기");
      b.addEventListener("click", async () => {
        b.disabled = true;
        const ok = await deps.unlock(t("지갑을 열면 방 이름 바꾸기를 다시 시도합니다."));
        b.disabled = false;
        if (ok) { lock.hidden = true; await submit(); }
      });
      return b;
    }

    // ── 숨기기 · 지울 수 없다는 말 ──────────────────────────────────────
    const hideRow = el("button", { id: "info-hide", cls: "tkinfo-row", type: "button" },
      el("span", { cls: "tkinfo-txt" },
        copy(el("span", { cls: "tkinfo-t" }), "이 방 숨기기"),
        copy(el("span", { cls: "tkinfo-d" }), "내 목록에서만 사라져요. 다른 사람 화면에는 그대로 보여요. 「숨긴 방」에서 되돌릴 수 있어요.")));
    hideRow.addEventListener("click", () => void hideCurrent());

    const title = user(el("h3", { id: "info-h" }), name);
    box.replaceChildren(
      el("div", { cls: "tkinfo-top" }, av, copy(el("span", { cls: "tkinfo-kind" }), "방 설정"), closeBtn),
      title,
      about ? user(el("p", { cls: "tkinfo-about" }), about) : el("p", { cls: "tkinfo-about", hidden: true }),
      copy(el("p", { cls: "tkinfo-mine" }), "내가 만든 방이에요. 이름과 설명은 나만 바꿀 수 있어요."),
      meta,
      form,
      say,
      el("div", { cls: "tkinfo-group" }, hideRow),
      copy(el("p", { id: "info-nodelete", cls: "tkinfo-foot" }), "이 방은 공개 릴레이에 있어서 완전히 지울 수 없어요. 숨기거나 이름을 바꿀 수 있어요."),
      copy(el("p", { cls: "tkinfo-foot" }), "공개 방이라 글은 세계 릴레이로 함께 나가요."),
    );
  }

  function renderCurrent(): void {
    const room = core.room(roomId);
    if (!room || !canEditRoom(room, deps.me())) { close(); return; }
    const open = !!box && !box.hidden;
    render(room);
    if (open) show(true);
  }

  function openSettings(): void {
    const id = deps.current();
    const room = id ? core.room(id) : undefined;
    // 화면은 단추를 내 방에서만 보인다. 그래도 여기서 한 번 더 본다 — 남의 방 시트가 열리는 일이 없게.
    if (!room || !canEditRoom(room, deps.me())) return;
    roomId = id;
    lastFocus = document.activeElement as HTMLElement | null;
    render(room);
    show(true);
    infoBtn()?.setAttribute("aria-expanded", "true");
    document.getElementById("closeinfo")?.focus();
  }

  // ── 숨기기 ────────────────────────────────────────────────────────────
  async function hideCurrent(): Promise<void> {
    const id = deps.current();
    if (!id) return;
    const room = core.room(id) ?? { id, name: "" };
    const name = String(room.name || t("이름 없는 방"));
    if (isOfficialRoom(room)) {
      const ok = await deps.sure(
        t("공식 방을 숨길까요?"),
        t("「RavenVault 레이븐볼트」는 레이븐볼트의 공식 안내 방이에요. 숨기면 새 공지를 목록에서 못 보게 돼요. 이 컴퓨터에서만 숨겨지고, 「숨긴 방」에서 언제든 되돌릴 수 있어요."),
        t("숨기기"),
      );
      if (!ok) return;
    }
    hideRoom(id, name);
    close();
    // 보던 방을 숨겼으면 「레이븐 이야기」로 돌아간다 — 목록에서 사라진 방에 머물러 있으면 길을 잃는다.
    if (deps.current() === id) deps.leave();
    else await deps.reload();
    note(id, name);
    core.paint();
  }

  /** 「숨겼어요 · 되돌리기」 한 줄. 스스로 사라지지 않는다 — 다음 숨기기·되돌리기 때 바뀐다. */
  function note(id: string, name: string): void {
    const anchor = document.getElementById("tk-hiddenrooms") ?? document.getElementById("tk-rooms");
    if (!anchor) return;
    let n = document.getElementById("tk-hiddennote");
    if (!n) {
      n = el("div", { id: "tk-hiddennote", cls: "tk-hiddennote" });
      n.setAttribute("role", "status");
      anchor.before(n);
    }
    const msg = el("p");
    setCopyText(msg, () => tf("「{0}」 방을 숨겼어요. 이 컴퓨터에서만 숨겨져요 — 다른 사람 화면에는 그대로 보여요.", name));
    const undo = copy(el("button", { cls: "ghost", type: "button", id: "tk-hiddenundo" }), "되돌리기");
    undo.addEventListener("click", () => { unhideRoom(id); n!.remove(); void Promise.resolve(deps.reload()).then(() => core.paint()); });
    n.replaceChildren(msg, undo);
  }

  // ── 숨긴 방 목록 ──────────────────────────────────────────────────────
  let hiddenOpen = false;
  function paintHidden(): void {
    const btn = document.getElementById("tk-hiddenrooms");
    let host = document.getElementById("tk-hiddenbox");
    if (!hiddenOpen || !btn) { host?.remove(); btn?.setAttribute("aria-expanded", "false"); return; }
    if (!host) {
      host = el("div", { id: "tk-hiddenbox", cls: "tk-hiddenbox" });
      btn.after(host);
    }
    btn.setAttribute("aria-expanded", "true");
    const hidden = loadHidden();
    const ids = Object.keys(hidden).sort((a, b) => (hidden[b]?.at || 0) - (hidden[a]?.at || 0));
    const rows = ids.map((id) => {
      const back = copy(el("button", { cls: "ghost", type: "button" }), "다시 보이기");
      back.dataset.unhide = id;
      back.addEventListener("click", () => {
        unhideRoom(id);
        document.getElementById("tk-hiddennote")?.remove();
        void Promise.resolve(deps.reload()).then(() => core.paint());
      });
      return el("div", { cls: "tk-hiddenrow" }, user(el("span"), hidden[id]?.name || `#${id.slice(0, 6)}`), back);
    });
    const closeBtn = copy(el("button", { cls: "ghost", type: "button" }), "닫기");
    closeBtn.addEventListener("click", () => { hiddenOpen = false; paintHidden(); });
    host.replaceChildren(
      copy(el("b"), "숨긴 방"),
      copy(el("p", { cls: "tk-hiddenwhy" }), "이 컴퓨터에서만 숨겼어요. 다른 사람 화면과 다른 기기에는 그대로 보여요. 방 자체는 지워지지 않아요."),
      ...(rows.length ? rows : [copy(el("p", { cls: "tk-hiddenwhy" }), "숨긴 방이 없어요.")]),
      closeBtn,
    );
  }

  return {
    openSettings,
    close,
    isOpen: () => !!box && !box.hidden,
    refresh: () => { if (box && !box.hidden && !busy && document.getElementById("info-form")?.hidden !== false) renderCurrent(); },
    hideCurrent,
    toggleHidden: () => { hiddenOpen = !hiddenOpen; paintHidden(); },
    paintHidden,
  };
}
