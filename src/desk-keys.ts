/* 0.9.47 글쇠(설계 최종안 10 — 카톡처럼 손이 마우스로 안 가게). 있는 단추를 대신 누를 뿐이다.
 *   ⌘/Ctrl 1~4  왼쪽 메뉴 위에서부터 넷(지갑 · 이야기 · 장터 · 동네 가게 — 보이는 순서)
 *   ⌘/Ctrl ,    설정
 *   ⌘/Ctrl N    이야기 「새 쪽지」
 *   ⌘/Ctrl [    뒤로(좁은 창: 방 → 목록 · 설정 주제 → 목록)
 *   ⌥ ↑ / ↓     이야기 목록에서 이전·다음 대화
 * (⌘F 목록 찾기 · Esc 단계 닫기는 src/talk-desk.ts 에 있다.) 입력칸에서 글자를 쓰는 중이면 ⌥↑↓ 는 쓰지 않는다. */
const visible = (el: Element | null): el is HTMLElement => !!el && (el as HTMLElement).offsetParent !== null;

export function wireDeskKeys(): void {
  document.addEventListener("keydown", (ev) => {
    if (ev.defaultPrevented || ev.isComposing) return;
    const mod = (ev.metaKey || ev.ctrlKey) && !ev.altKey && !ev.shiftKey;
    const talkOn = !!document.querySelector("#page-talk.on");
    if (mod && /^[1-4]$/.test(ev.key)) {
      const links = [...document.querySelectorAll<HTMLElement>("body > nav > a[data-page]")].filter(visible)
        .sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top);
      const a = links[Number(ev.key) - 1];
      if (a) { ev.preventDefault(); a.click(); }
      return;
    }
    if (mod && ev.key === ",") { const a = document.querySelector<HTMLElement>('body > nav > a[data-page="settings"]'); if (a) { ev.preventDefault(); a.click(); } return; }
    if (mod && ev.key.toLowerCase() === "n" && talkOn) { const b = document.getElementById("tk-newdm"); if (b) { ev.preventDefault(); b.click(); } return; }
    if (mod && ev.key === "[") {
      const back = [document.getElementById("tk-back"), document.getElementById("sx-back")].find(visible);
      if (back) { ev.preventDefault(); back.click(); }
      return;
    }
    if (ev.altKey && !ev.metaKey && !ev.ctrlKey && (ev.key === "ArrowUp" || ev.key === "ArrowDown") && talkOn) {
      const rows = [...document.querySelectorAll<HTMLElement>("#tk-chats:not([hidden]) .tkc-row, #tk-rooms .room")].filter((r) => r.closest("[hidden]") === null);
      if (!rows.length) return;
      const i = rows.findIndex((r) => r.classList.contains("on"));
      const next = rows[Math.min(rows.length - 1, Math.max(0, (i < 0 ? -1 : i) + (ev.key === "ArrowDown" ? 1 : -1)))];
      if (next) { ev.preventDefault(); next.click(); }
    }
  });
}
