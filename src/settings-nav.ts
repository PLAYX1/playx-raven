// 0.9.0 「이 컴퓨터(설정)」 — 묶음 자리 정리(시안 ~/rv-design-089 설정 A·B). main.ts 는 import 한 줄만 한다(레인 충돌 최소화).
//
// ① 자리 옮기기: 다른 파일이 나중에 #page-settings 에 붙이는 칸(표시 방식·폰 연결·라비 동의·트레이·초기 설정 단추)을
//    index.html 의 data-sx-slot 자리로 옮긴다. 그 파일들은 고치지 않는다 — 붙는 순간 따라가서 옮길 뿐이다.
//    모르는 칸이 #page-settings 바로 밑에 붙으면 「일반」 끝으로 모은다(숨기지 않는다 — 숨긴 기능은 없앤 기능이다).

const ROUTED = ["firstrun-setup", "display-mode-card", "rvp-connect-settings", "rvp-card", "ravi-agent-settings", "companion-preferences"];

function route(page: HTMLElement): void {
  for (const id of ROUTED) {
    const el = document.getElementById(id);
    const slot = page.querySelector<HTMLElement>(`[data-sx-slot="${id}"]`);
    if (el && slot && el.parentElement !== slot) slot.append(el);
  }
  const rest = page.querySelector<HTMLElement>('[data-sx-pane="general"]');
  for (const child of [...page.children]) if (child.id !== "sx" && rest) rest.append(child);
}

export function mountSettingsNav(): void {
  const page = document.getElementById("page-settings");
  if (!page || page.dataset.sxMounted) return;
  page.dataset.sxMounted = "1";
  route(page);
  new MutationObserver(() => route(page)).observe(page, { childList: true, subtree: true });
  // 「이야기에서 쓰는 이름」 줄 → 내 소개(같은 이름표를 고치는 곳).
  page.addEventListener("click", (e) => {
    const go = (e.target as Element).closest<HTMLElement>("[data-go-page]");
    if (go) document.querySelector<HTMLElement>(`nav a[data-page="${go.dataset.goPage}"]`)?.click();
  });
}

if (typeof document !== "undefined") {
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mountSettingsNav);
  else mountSettingsNav();
}
