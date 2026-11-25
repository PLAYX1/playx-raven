/* 0.9.47 이야기를 작은 창에서도 카톡처럼(설계: 페이블·네온 최종안 11-25 · 모양은 src/responsive.css).
 *
 * 이 파일은 **있는 단추를 옮기거나 대신 누를 뿐**이다. 보내기·읽기·서명 길은 하나도 안 건드린다.
 * ① 방 칸 폭 → .chat[data-w] = s(<480) · m(<640) · l. 방 안 규칙은 창 폭이 아니라 이 값을 본다(창 760 에서 목록이 붙어도 방은 좁다).
 *    ResizeObserver 한 개 · 값이 바뀔 때만 속성을 쓴다(창 끌 때 무거운 일 없음).
 * ② 방 머리줄은 한 줄: 알림·정보·방 설정(·좁으면 초대하기)은 「⋯」 안 맨 위 줄로 — 원래 단추를 대신 누른다.
 * ③ 광장: 「피드 | 팔로우」 탭을 머리줄 안으로 · 「누구에게」 줄 대신 입력줄의 「모두 ▾」 표(누르면 같은 세 단추가 뜬다) · 글쓰기는 비었을 때 한 줄로 접힌다.
 * ④ 채팅 목록 위 「전체 · 안 읽음 N」 — 안 읽은 줄만 거른다(순서는 그대로 — 줄이 튀지 않게).
 */
import { t } from "./i18n";

const $ = (id: string) => document.getElementById(id);

export function roomWidthClass(w: number): "s" | "m" | "l" {
  return w < 480 ? "s" : w < 640 ? "m" : "l";
}

export function wireTalkCompact(): void {
  const page = $("page-talk");
  const chat = page?.querySelector<HTMLElement>(".chat");
  if (!page || !chat) return;

  // ① 방 칸 폭
  const setW = (w: number) => { if (w <= 0) return; const c = roomWidthClass(w); if (chat.dataset.w !== c) chat.dataset.w = c; };
  setW(chat.getBoundingClientRect().width);
  if ("ResizeObserver" in window) new ResizeObserver((es) => { for (const e of es) setW(e.contentRect.width); }).observe(chat);

  // ② 「⋯」 안 맨 위 줄 — 머리줄에서 뺀 단추를 대신 누른다
  const more = $("tk-more"), box = $("tk-morebox");
  if (more && box) {
    const row = document.createElement("div");
    row.className = "tkmorerow tk-moreproxy";
    const proxies: [string, string][] = [["tk-inv", "초대하기"], ["tk-bell", "알림"], ["tk-info", "정보"], ["tk-room-settings", "방 설정"]];
    const paint = () => {
      row.replaceChildren();
      for (const [id, label] of proxies) {
        const real = $(id) as HTMLButtonElement | null;
        if (!real || real.hidden || real.disabled) continue;
        if (id === "tk-inv" && chat.dataset.w === "l") continue; // 넓은 방 칸은 머리줄에 글자 단추로 있다
        if ((id === "tk-bell") && page.classList.contains("dmon")) continue; // 쪽지 머리에는 안 맞는다(talk-dm.css 와 같은 규칙)
        const b = document.createElement("button");
        b.type = "button"; b.className = "ghost"; b.dataset.proxy = id; b.textContent = t(label);
        b.onclick = () => { box.hidden = true; more.setAttribute("aria-expanded", "false"); real.click(); };
        row.append(b);
      }
      row.hidden = !row.childElementCount;
    };
    box.prepend(row);
    more.addEventListener("click", paint, true); // 먼저 — 열리는 순간 지금 상태로 그린다
  }

  // ③ 광장 머리줄 탭 · 「모두 ▾」 · 접히는 글쓰기
  const head = page.querySelector<HTMLElement>(".chathead");
  const tabs = $("tk-feedtabs");
  if (head && tabs) head.querySelector(".tk-headtxt")?.after(tabs);
  const aud = $("tk-aud"), composer = page.querySelector<HTMLElement>(".composer"), send = $("tk-send"), text = $("tk-text") as HTMLTextAreaElement | null;
  if (aud && composer && send && text) {
    const chip = document.createElement("button");
    chip.type = "button"; chip.id = "tk-audchip"; chip.className = "ghost tk-audchip";
    chip.setAttribute("aria-haspopup", "true"); chip.setAttribute("aria-expanded", "false"); chip.setAttribute("aria-controls", "tk-aud");
    composer.insertBefore(chip, send);
    const label = () => {
      const on = aud.querySelector<HTMLElement>('[data-aud][aria-pressed="true"]') ?? aud.querySelector<HTMLElement>('[data-aud="all"]');
      chip.textContent = `${(on?.textContent || "").trim()} ▾`;
      chip.title = (aud.querySelector(".tk-aud-label")?.textContent || "").trim();
      chip.hidden = aud.hidden;
    };
    const setOpen = (o: boolean) => { aud.classList.toggle("tk-audopen", o); chip.setAttribute("aria-expanded", String(o)); };
    chip.onclick = () => setOpen(!aud.classList.contains("tk-audopen"));
    aud.addEventListener("click", (ev) => { if ((ev.target as HTMLElement).closest("[data-aud]")) setOpen(false); });
    document.addEventListener("mousedown", (ev) => { const n = ev.target as Node; if (!aud.contains(n) && !chip.contains(n)) setOpen(false); }, true);
    new MutationObserver(label).observe(aud, { attributes: true, subtree: true, attributeFilter: ["aria-pressed", "hidden"], childList: true, characterData: true });
    label();
    // 글쓰기 접힘: 광장에서 비어 있고 손이 안 가 있으면 한 줄(사진 단추 · 쓰는 칸만)
    const sync = () => composer.classList.toggle("tk-folded", page.classList.contains("feedon") && !text.value.trim() && !composer.contains(document.activeElement) && ($("tk-photobox")?.hidden ?? true) && !aud.classList.contains("tk-audopen"));
    composer.addEventListener("focusin", sync);
    composer.addEventListener("focusout", () => setTimeout(sync, 0));
    text.addEventListener("input", sync);
    new MutationObserver(sync).observe(page, { attributes: true, attributeFilter: ["class"] });
    sync();
  }

  // ④ 채팅 목록 「전체 · 안 읽음 N」
  const chats = $("tk-chats");
  if (chats) {
    const pills = document.createElement("div");
    pills.className = "tk-pills"; pills.setAttribute("role", "group");
    const all = document.createElement("button"), unread = document.createElement("button");
    for (const b of [all, unread]) { b.type = "button"; b.className = "tk-pill"; }
    pills.append(all, unread);
    chats.before(pills);
    let only = false;
    const paint = () => {
      const n = chats.querySelectorAll(".tkc-row:has(.tkc-n, .tkc-dot)").length;
      all.textContent = t("전체");
      unread.textContent = n ? `${t("안 읽음")} ${n > 99 ? "99+" : n}` : t("안 읽음");
      all.setAttribute("aria-pressed", String(!only)); unread.setAttribute("aria-pressed", String(only));
      chats.classList.toggle("tk-only-unread", only);
    };
    all.onclick = () => { only = false; paint(); };
    unread.onclick = () => { only = true; paint(); };
    new MutationObserver(paint).observe(chats, { childList: true });
    paint();
  }
}
