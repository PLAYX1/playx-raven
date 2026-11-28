/**
 * 11-29 라비 창 머리 「더 보기」(⋯) 메뉴 — 페이블 판정 1묶음.
 * 창 위에 늘 있던 두 줄(「+ 홍보 만들기」·「그냥 묻기/두 곳에 묻기」)과 늘 떠 있던 「답 읽어 주기」 칩을 여기로 옮겼다.
 * 대화 기록 칸을 넓히는 것이 목적이다. 돈·키·삭제·공개 글은 여기서도 실제 화면의 단추로만 끝난다(이 메뉴는 화면을 열기만 한다).
 * 판매자 단추(홍보 만들기)는 가게가 있거나 판매자 기능을 켠 사람에게만 보인다.
 */
export function mountRaviMenu(api: { seller(): boolean; help(): void }) {
  const button = document.getElementById("ravi-more");
  const menu = document.getElementById("ravi-menu");
  const panel = document.getElementById("ravi-panel");
  if (!button || !menu || !panel) return { close() {}, paint() {} };
  const paint = () => {
    const seller = api.seller();
    menu.querySelectorAll<HTMLElement>("[data-ravi-seller]").forEach(el => { el.hidden = !seller; });
  };
  const set = (open: boolean, focus = false) => {
    if (open) paint();
    menu.hidden = !open;
    button.setAttribute("aria-expanded", String(open));
    if (open && focus) menu.querySelector<HTMLElement>("button:not([hidden])")?.focus({ preventScroll: true });
  };
  button.addEventListener("click", () => set(menu.hidden, true));
  // 메뉴 안 단추를 누르면 접는다(읽어 주기 켜고 끄기는 눌린 표시를 보여 주려고 열어 둔다).
  menu.addEventListener("click", event => {
    const target = event.target as HTMLElement;
    if (target.closest("[data-ravi-help]")) api.help();
    if (target.closest("button") && !target.closest("#ravi-read")) set(false);
  });
  // Escape 는 메뉴부터 닫는다(대화창 접기보다 먼저). 바깥을 누르면 닫는다.
  document.addEventListener("keydown", event => {
    if (event.key === "Escape" && !menu.hidden) { event.preventDefault(); event.stopImmediatePropagation(); set(false); button.focus({ preventScroll: true }); }
  }, true);
  document.addEventListener("pointerdown", event => {
    const target = event.target as Node;
    if (!menu.hidden && !menu.contains(target) && !button.contains(target)) set(false);
  }, true);
  new MutationObserver(() => { if (panel.hidden) set(false); }).observe(panel, { attributes: true, attributeFilter: ["hidden"] });
  paint();
  return { close: () => set(false), paint };
}
