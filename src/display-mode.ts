// 설정 화면 「표시 방식」 칸 — 큰 창 · 작은 창 · 칩 · 메뉴바만 + 대기화면 켜기.
// main.ts 는 이 파일을 import 한 줄만 한다(접점 최소화). 칸은 #page-settings 의 판매자 칸 뒤에 스스로 붙는다.
// 레이아웃 토큰·작은 고침 CSS 도 여기서 함께 들여온다(src/layout-tokens.css).
// 🔴 이 칸은 창을 바꾸는 것뿐 — 돈·열쇠와 무관. 명령은 display_mode_get/set·standby_open(큰 창 전용, 미니·대기화면 문지기가 막는다).
import { invoke } from "@tauri-apps/api/core";
import "./layout-tokens.css";
import "./display-mode.css";
import { lockCopy, enterStoreMode } from "./app-lock";

export type DisplayMode = "window" | "mini" | "chip" | "menubar";
type Settings = { mode: DisplayMode; hide_dock: boolean; tray_text: "alerts" | "balance" | "none"; dim_from: number; dim_to: number; shift: boolean; locale: string };
type Supports = { dock: boolean; tray_text: boolean; tray: boolean; tray_click_menu: boolean; os: string };
type State = { settings: Settings; supports: Supports; standby_open?: boolean };

const KO = {
  title: "표시 방식",
  lede: "레이븐볼트를 화면에 어떻게 둘지 골라요. 작은 모양들은 모두 읽기 전용이에요 — 보내기는 큰 창에서만.",
  modes: {
    window: ["큰 창", "지금처럼 모든 기능"],
    mini: ["작은 창", "구석에 잔액·최근 변화 (S·M·L)"],
    chip: ["칩", "점 하나와 숫자 한 줄 (160×40)"],
    menubar: ["메뉴바만", "창 없이 메뉴막대·트레이 아이콘만"],
  } as Record<DisplayMode, [string, string]>,
  standby: "대기화면 켜기",
  standbyNote: "큰 모니터에 켜 두는 읽기 전용 화면이에요. 아무 키나 누르면 돌아와요.",
  more: "더 고르기",
  trayText: "메뉴막대 글자",
  trayOpts: { alerts: "새 소식 수", balance: "잔액 (가림이면 ••••)", none: "없음" },
  hideDock: "메뉴바만일 때 독 아이콘 숨기기",
  dim: "대기화면 어둡게",
  dimOff: "끔",
  shift: "번인 막기 (1분마다 조금씩 옮기기)",
  noTray: "이 컴퓨터에서는 트레이를 쓸 수 없어 큰 창만 쓸 수 있어요.",
  failed: "바꾸지 못했어요. 다시 해 주세요.",
  saved: (m: string) => `${m}(으)로 바꿨어요.`,
};
const EN: typeof KO = {
  title: "Display",
  lede: "Choose how RavenVault sits on your screen. The small forms are read-only — sending happens in the full window.",
  modes: {
    window: ["Full window", "Everything, as now"],
    mini: ["Mini window", "Balance and recent activity in a corner (S·M·L)"],
    chip: ["Chip", "One dot and one number (160×40)"],
    menubar: ["Menu bar only", "No window — just the menu bar / tray icon"],
  },
  standby: "Start standby screen",
  standbyNote: "A read-only screen for a big monitor. Press any key to come back.",
  more: "More options",
  trayText: "Menu bar text",
  trayOpts: { alerts: "New alerts count", balance: "Balance (•••• when hidden)", none: "None" },
  hideDock: "Hide the Dock icon in menu-bar-only mode",
  dim: "Dim standby",
  dimOff: "off",
  shift: "Prevent burn-in (shift slightly every minute)",
  noTray: "No tray on this computer — only the full window is available.",
  failed: "Couldn't change it. Please try again.",
  saved: (m) => `Switched to ${m}.`,
};
const lang = () => { try { return (localStorage.getItem("playx-raven-lang") || navigator.language || "ko").startsWith("en") ? "en" : "ko"; } catch { return "ko"; } };
export const copyFor = (l: string) => (l === "en" ? EN : KO);

const DEFAULT: State = {
  settings: { mode: "window", hide_dock: true, tray_text: "alerts", dim_from: 22, dim_to: 7, shift: true, locale: "ko" },
  supports: { dock: false, tray_text: false, tray: true, tray_click_menu: true, os: "unknown" },
};

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, props: Record<string, unknown> = {}, ...kids: (Node | string)[]): HTMLElementTagNameMap[K] => {
  const n = Object.assign(document.createElement(tag), props) as HTMLElementTagNameMap[K];
  n.append(...kids);
  return n;
};

function hourOptions(sel: HTMLSelectElement, value: number) {
  for (let h = 0; h < 24; h++) sel.append(el("option", { value: String(h), textContent: `${String(h).padStart(2, "0")}:00`, selected: h === value }));
}

/** 칸을 그린다. 테스트(하네스)에서도 그대로 쓴다. */
export function buildCard(state: State, l = lang()): HTMLElement {
  const c = copyFor(l);
  const s = state.settings, sup = state.supports;
  const card = el("section", { className: "card rv-dm", id: "display-mode-card" });
  card.setAttribute("aria-labelledby", "dm-title");
  card.append(el("h3", { id: "dm-title", textContent: c.title }), el("p", { className: "meta rv-dm-lede", textContent: c.lede }));
  const group = el("div", { className: "rv-dm-modes" });
  group.setAttribute("role", "radiogroup");
  group.setAttribute("aria-labelledby", "dm-title");
  for (const m of ["window", "mini", "chip", "menubar"] as DisplayMode[]) {
    const id = `dm-mode-${m}`;
    const input = el("input", { type: "radio", name: "dm-mode", id, value: m, checked: s.mode === m, disabled: m !== "window" && !sup.tray });
    const lab = el("label", { className: "rv-dm-mode", htmlFor: id }, input, el("span", { className: "rv-dm-ico", innerHTML: ICONS[m] }), el("span", { className: "rv-dm-txt" }, el("b", { textContent: c.modes[m][0] }), el("small", { textContent: c.modes[m][1] })));
    lab.dataset.mode = m;
    group.append(lab);
  }
  card.append(group);
  if (!sup.tray) card.append(el("p", { className: "meta", textContent: c.noTray }));
  const sb = el("div", { className: "rv-dm-standby" }, el("button", { type: "button", id: "dm-standby", className: "ghost", textContent: c.standby }), el("p", { className: "meta", textContent: c.standbyNote }));
  card.append(sb);
  // 매장용 읽기 전용 모드 — 켜면 지갑이 잠기고(Rust app_lock) 조회만. 끌 때는 지갑 암호(잠금 풀기). 4개 국어.
  const lc = lockCopy();
  card.append(el("div", { className: "rv-dm-standby rv-dm-store" }, el("button", { type: "button", id: "dm-store", className: "ghost", textContent: lc.storeOn, title: lc.storeOn }), el("p", { className: "meta", textContent: lc.storeNote })));
  const more = el("details", { className: "rv-dm-more" }, el("summary", { textContent: c.more }));
  if (sup.tray_text) {
    const sel = el("select", { id: "dm-tray-text" });
    for (const k of ["alerts", "balance", "none"] as const) sel.append(el("option", { value: k, textContent: c.trayOpts[k], selected: s.tray_text === k }));
    more.append(el("label", { className: "rv-dm-row", htmlFor: "dm-tray-text" }, el("span", { textContent: c.trayText }), sel));
  }
  if (sup.dock) more.append(el("label", { className: "rv-dm-row check" }, el("input", { type: "checkbox", id: "dm-hide-dock", checked: s.hide_dock }), el("span", { textContent: c.hideDock })));
  const from = el("select", { id: "dm-dim-from" }), to = el("select", { id: "dm-dim-to" });
  hourOptions(from, s.dim_from); hourOptions(to, s.dim_to);
  from.setAttribute("aria-label", `${c.dim} ↦`); to.setAttribute("aria-label", `${c.dim} ↤`);
  more.append(el("div", { className: "rv-dm-row" }, el("span", { textContent: c.dim }), el("span", { className: "rv-dm-hours" }, from, "–", to)));
  more.append(el("label", { className: "rv-dm-row check" }, el("input", { type: "checkbox", id: "dm-shift", checked: s.shift }), el("span", { textContent: c.shift })));
  card.append(more, el("p", { className: "meta rv-dm-note", id: "dm-note", role: "status" }));
  return card;
}

const ICONS: Record<DisplayMode, string> = {
  window: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 8h18"/></svg>',
  mini: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2" opacity=".35"/><rect x="12" y="6" width="7" height="5" rx="1"/></svg>',
  chip: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="9" width="16" height="6" rx="3"/><circle cx="7.5" cy="12" r="1.2"/></svg>',
  menubar: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 5h18"/><circle cx="17" cy="5" r="1.4"/><rect x="12" y="8" width="8" height="8" rx="1.5" opacity=".6"/></svg>',
};

async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  return invoke<T>(cmd, args);
}

export async function mountDisplayMode(): Promise<void> {
  const host = document.getElementById("page-settings");
  if (!host || document.getElementById("display-mode-card")) return;
  let state: State = DEFAULT;
  // 빈 답(null)·옛 판·가짜 IPC — 모양이 맞을 때만 쓰고 아니면 기본값으로 그린다(빈 답에 죽지 않기).
  const ok = (v: unknown): v is State => !!v && typeof v === "object" && !!(v as State).settings && !!(v as State).supports;
  try { const r = await call<unknown>("display_mode_get"); if (ok(r)) state = r; } catch { /* 기본값 */ }
  const l = lang();
  const c = copyFor(l);
  const card = buildCard(state, l);
  const anchor = document.getElementById("seller-mode-card");
  if (anchor?.parentElement) anchor.after(card); else host.append(card);
  const note = card.querySelector<HTMLElement>("#dm-note")!;
  const set = async (prefs: Partial<Settings>) => {
    try {
      const r = await call<unknown>("display_mode_set", { prefs: { ...prefs, locale: l } });
      if (!ok(r)) throw c.failed;
      state = r;
      if (prefs.mode) note.textContent = c.saved(c.modes[prefs.mode][0]);
    } catch (e) {
      note.textContent = typeof e === "string" && e ? e : c.failed;
      // 화면을 실제 상태로 되돌린다.
      card.querySelectorAll<HTMLInputElement>('input[name="dm-mode"]').forEach((i) => (i.checked = i.value === state.settings.mode));
    }
  };
  card.querySelectorAll<HTMLInputElement>('input[name="dm-mode"]').forEach((i) => i.addEventListener("change", () => i.checked && void set({ mode: i.value as DisplayMode })));
  card.querySelector("#dm-standby")?.addEventListener("click", () => void call("standby_open").catch(() => (note.textContent = c.failed)));
  card.querySelector("#dm-store")?.addEventListener("click", () => void enterStoreMode().catch(() => (note.textContent = c.failed)));
  card.querySelector<HTMLSelectElement>("#dm-tray-text")?.addEventListener("change", (e) => void set({ tray_text: (e.target as HTMLSelectElement).value as Settings["tray_text"] }));
  card.querySelector<HTMLInputElement>("#dm-hide-dock")?.addEventListener("change", (e) => void set({ hide_dock: (e.target as HTMLInputElement).checked }));
  card.querySelector<HTMLInputElement>("#dm-shift")?.addEventListener("change", (e) => void set({ shift: (e.target as HTMLInputElement).checked }));
  for (const id of ["dm-dim-from", "dm-dim-to"]) card.querySelector<HTMLSelectElement>(`#${id}`)?.addEventListener("change", () => void set({
    dim_from: Number(card.querySelector<HTMLSelectElement>("#dm-dim-from")!.value), dim_to: Number(card.querySelector<HTMLSelectElement>("#dm-dim-to")!.value),
  }));
}

if (typeof document !== "undefined") {
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", () => void mountDisplayMode());
  else void mountDisplayMode();
}
