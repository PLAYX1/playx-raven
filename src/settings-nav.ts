// 0.9.0 「이 컴퓨터(설정)」 — 시안 B(왼쪽 목록 + 오른쪽 한 주제). 시안: ~/rv-design-089/mockups/settings-B.html
// main.ts 는 import 한 줄만 한다(레인 충돌 최소화). 마크업은 index.html #page-settings, 모양은 src/settings-apple.css.
//
// ① 자리 옮기기: 다른 파일이 나중에 #page-settings 에 붙이는 칸(표시 방식·폰 연결·라비 동의·트레이·초기 설정 단추)을
//    data-sx-slot 자리로 옮긴다. 그 파일들은 고치지 않는다. 모르는 칸이 바로 밑에 붙으면 「일반」 끝으로 모은다
//    (숨기지 않는다 — 숨긴 기능은 없앤 기능이다).
// ② 한 주제씩: 목록을 누르면 그 주제만 보인다. 나머지 주제는 [hidden].
// ③ 🔴 바로 가기: 다른 화면에서 설정의 특정 칸으로 가는 길(라비 안내 사전 page:"settings" el:…, pageTiles 의 jump,
//    사이드바 표시등 → #sec-node, 「새 버전」 → #up-box, 폰 연결 → #rvp-card …)은 전부 그 칸의 scrollIntoView 를 부른다.
//    숨은 주제 속 칸은 스크롤해도 아무 일이 없다 — 「눌렀는데 안 간다」. 그래서 scrollIntoView 가 불리면
//    그 칸이 든 주제를 먼저 연다(설정 화면 속 칸만, 나머지는 원래대로). 길마다 고치면 한 곳은 반드시 빠진다.
// ⚠️ .sx·.sx-pane·.sx-list 에는 id 를 두지 않는다 — 레이아웃 관문(scripts/layout-check.mjs)이 가장 가까운 id 로 칸 이름을 짓는데,
//    id 를 끼우면 기존 설정 칸의 이름이 바뀌어 같은 실패가 「새 실패」로 잡힌다.
// ④ 찾기: 주제 이름·안의 글자로 거른다. Enter 는 첫 주제의 맞는 칸으로 데려간다.

const ROUTED = ["firstrun-setup", "display-mode-card", "rvp-connect-settings", "rvp-card", "ravi-agent-settings", "companion-preferences"];
let current = "general";

function route(page: HTMLElement): void {
  for (const id of ROUTED) {
    const el = document.getElementById(id);
    const slot = page.querySelector<HTMLElement>(`[data-sx-slot="${id}"]`);
    if (el && slot && el.parentElement !== slot) slot.append(el);
  }
  const rest = page.querySelector<HTMLElement>('[data-sx-pane="general"]');
  for (const child of [...page.children]) if (!child.classList.contains("sx") && rest) rest.append(child);
}

const sections = () => [...document.querySelectorAll<HTMLElement>("#page-settings section[data-sx-pane]")];

/** 한 주제만 보인다. focus 면 그 주제 제목으로 키보드 자리를 옮긴다(목록에서 고른 경우). */
export function showSettingsTopic(key: string, focus = false): void {
  const sx = document.querySelector("#page-settings .sx");
  if (!sx?.classList.contains("sx-b")) return;
  if (!sections().some((s) => s.dataset.sxPane === key)) return;
  const changed = key !== current;
  current = key;
  for (const s of sections()) s.hidden = s.dataset.sxPane !== key;
  document.querySelectorAll<HTMLElement>(".sx-list .sx-it").forEach((b) => b.setAttribute("aria-current", String(b.dataset.sxGo === key)));
  // 「고급」은 주제 자체가 접어 둔 칸이다 — 열고 들어온 사람에게 또 접힌 상자를 내밀지 않는다.
  if (key === "advanced") { const d = document.querySelector<HTMLDetailsElement>("#page-settings details.advanced"); if (d) d.open = true; }
  if (changed) document.querySelector("main")?.scrollTo?.(0, 0);
  if (focus) { const h = document.querySelector<HTMLElement>(`#page-settings section[data-sx-pane="${key}"] .sx-ptitle`); if (h) { h.tabIndex = -1; h.focus({ preventScroll: true }); } }
}

function revealFor(el: Element): void {
  const sec = el.closest?.<HTMLElement>("#page-settings section[data-sx-pane]");
  if (sec?.hidden && sec.dataset.sxPane) showSettingsTopic(sec.dataset.sxPane);
}

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
function search(q: string): string[] {
  const query = norm(q);
  const hits: string[] = [];
  document.querySelectorAll<HTMLElement>(".sx-list .sx-it").forEach((b) => {
    const key = b.dataset.sxGo!;
    const sec = document.querySelector<HTMLElement>(`#page-settings section[data-sx-pane="${key}"]`);
    const hit = !query || norm(b.textContent || "").includes(query) || norm(sec?.textContent || "").includes(query);
    (b.parentElement as HTMLElement).hidden = !hit;
    if (hit) hits.push(key);
  });
  document.querySelectorAll<HTMLElement>(".sx-list .sx-sep").forEach((s) => (s.hidden = !!query));
  const none = document.getElementById("sx-none");
  if (none) none.hidden = !query || hits.length > 0;
  return hits;
}

/** 찾은 주제 안에서 글자가 맞는 첫 칸으로 데려간다(제목·이름표·단추 순). */
function goToHit(key: string, q: string): void {
  showSettingsTopic(key);
  const query = norm(q);
  const sec = document.querySelector<HTMLElement>(`#page-settings section[data-sx-pane="${key}"]`);
  const spot = [...(sec?.querySelectorAll<HTMLElement>("h2, h3, b, label, summary, button, .sx-t") || [])].find((e) => norm(e.textContent || "").includes(query));
  if (!spot) return;
  for (let up: HTMLElement | null = spot; up; up = up.parentElement) if (up instanceof HTMLDetailsElement) up.open = true;
  spot.scrollIntoView({ block: "center" });
  // 키보드·화면 읽기 사용자도 그 칸으로 간다 — 스크롤만 하고 포커스가 찾기 칸에 남으면 Tab 이 엉뚱한 데서 시작한다
  // (0.9.0 병합, GPT 교차검토 Q9). 누를 수 없는 제목·이름표는 tabIndex=-1 로 잠깐 받을 수 있게.
  if (!spot.matches("button, summary, a[href], input, select, textarea")) spot.tabIndex = -1;
  spot.focus({ preventScroll: true });
  spot.classList.add("justwent");
  setTimeout(() => spot.classList.remove("justwent"), 1600);
}

export function mountSettingsNav(): void {
  const page = document.getElementById("page-settings");
  const sx = page?.querySelector<HTMLElement>(".sx");
  if (!page || !sx || page.dataset.sxMounted) return;
  page.dataset.sxMounted = "1";
  route(page);
  new MutationObserver(() => route(page)).observe(page, { childList: true, subtree: true });

  sx.classList.add("sx-b");
  showSettingsTopic(current);

  const scroll = Element.prototype.scrollIntoView;
  Element.prototype.scrollIntoView = function (this: Element, arg?: boolean | ScrollIntoViewOptions) {
    revealFor(this);
    return scroll.call(this, arg as ScrollIntoViewOptions);
  };

  page.addEventListener("click", (e) => {
    const target = e.target as Element;
    const go = target.closest<HTMLElement>("[data-sx-go]");
    if (go) {
      showSettingsTopic(go.dataset.sxGo!, !go.dataset.sxTo);
      const to = go.dataset.sxTo && document.getElementById(go.dataset.sxTo);
      if (to) to.scrollIntoView({ block: "start" });
      return;
    }
    // 「이야기에서 쓰는 이름」 줄 → 내 소개(같은 이름표를 고치는 곳).
    const page2 = target.closest<HTMLElement>("[data-go-page]");
    if (page2) document.querySelector<HTMLElement>(`nav a[data-page="${page2.dataset.goPage}"]`)?.click();
  });

  // 목록 안에서 ↑↓ 로 옮겨 다닌다(맥 「시스템 설정」과 같은 손버릇).
  page.querySelector<HTMLElement>(".sx-list")?.addEventListener("keydown", (e: KeyboardEvent) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    const items = [...document.querySelectorAll<HTMLElement>(".sx-list .sx-it")].filter((b) => !(b.parentElement as HTMLElement).hidden);
    const i = items.indexOf(document.activeElement as HTMLElement);
    if (i < 0) return;
    e.preventDefault();
    const next = items[(i + (e.key === "ArrowDown" ? 1 : items.length - 1)) % items.length];
    next.focus();
    showSettingsTopic(next.dataset.sxGo!);
  });

  const box = document.getElementById("sx-search") as HTMLInputElement | null;
  box?.addEventListener("input", () => {
    const hits = search(box.value);
    if (box.value.trim() && hits.length && !hits.includes(current)) showSettingsTopic(hits[0]);
  });
  box?.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { box.value = ""; search(""); return; }
    if (e.key !== "Enter") return;
    const hits = search(box.value);
    if (hits.length) goToHit(hits.includes(current) ? current : hits[0], box.value);
  });
}

if (typeof document !== "undefined") {
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mountSettingsNav);
  else mountSettingsNav();
}
