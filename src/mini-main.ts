// 미니 창 연결 — 부를 수 있는 것은 mini_* 다섯 개뿐(Rust 문지기 mini::command_allowed).
// 보내기·서명·복구 단어·비밀번호 입력은 이 창에 없다. 그 일은 「큰 화면」에서.
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { render, showNotice, nextSize, type Snapshot, type Settings, type Notice } from "./mini-view";
import "./mini.css";

let settings: Settings | null = null;
let snap: Snapshot | null = null;
let noticeTimer = 0;
let audio: AudioContext | null = null;
const $ = (id: string) => document.getElementById(id)!;

function paint() {
  if (snap && settings) render(snap, settings);
}

type Prefs = Partial<Omit<Settings, "os_notify_supported">> & { tz?: number };
async function set(prefs: Prefs) {
  try {
    const r = await invoke<{ settings: Settings }>("mini_set", { prefs });
    settings = r.settings;
    paint();
  } catch { /* 설정 실패 — 화면은 그대로(Rust 가 값을 안 바꿨다) */ }
}

function beep() {
  if (!settings?.sound) return;
  try {
    audio ??= new AudioContext();
    const o = audio.createOscillator(), g = audio.createGain(), t = audio.currentTime;
    o.frequency.value = 880; g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.08, t + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.25);
    o.connect(g).connect(audio.destination); o.start(t); o.stop(t + 0.3);
  } catch { /* 소리 장치 없음 */ }
}

function notice(n: Notice | null, fresh: boolean) {
  window.clearTimeout(noticeTimer);
  showNotice(n, settings?.size ?? "m");
  if (n && fresh) {
    beep();
    noticeTimer = window.setTimeout(() => showNotice(null, settings?.size ?? "m"), 12_000);
  }
}

async function boot() {
  const tz = -new Date().getTimezoneOffset();
  const locale = navigator.language || "ko";
  try {
    const r = await invoke<{ settings: Settings; snapshot: Snapshot }>("mini_state");
    settings = r.settings; snap = r.snapshot;
    paint();
    // 「오늘」 경계와 말(한국어/영어)은 이 컴퓨터를 따른다.
    void set({ tz, locale });
  } catch { /* 첫 장을 못 받으면 다음 이벤트를 기다린다 */ }
  await listen<Snapshot>("mini-snapshot", (e) => { snap = e.payload; paint(); });
  await listen<Notice>("mini-notice", (e) => notice(e.payload, true));

  // 끌어서 옮기기 — 단추 위가 아니면 어디든. 두 번 누르면 크기 바꾸기.
  $("mini").addEventListener("mousedown", (e) => {
    if (e.button !== 0 || (e.target as HTMLElement).closest("button,input,label,a")) return;
    if (e.detail >= 2) return;
    void getCurrentWindow().startDragging().catch(() => {});
  });
  $("mini").addEventListener("dblclick", (e) => {
    if ((e.target as HTMLElement).closest("button,input,label,a")) return;
    if (settings) void set({ size: nextSize(settings.size) });
  });
  $("size").addEventListener("click", () => settings && void set({ size: nextSize(settings.size) }));
  $("mask").addEventListener("click", () => settings && void set({ mask: !settings.mask }));
  $("headline").addEventListener("click", () => settings && void set({ mask: !settings.mask }));
  $("open-main").addEventListener("click", () => void invoke("mini_open_main").catch(() => {}));
  $("close").addEventListener("click", () => void invoke("mini_show", { visible: false }).catch(() => {}));
  $("notice").addEventListener("click", () => { notice(null, false); void invoke("mini_seen").catch(() => {}); });
  ($("opt-top") as HTMLInputElement).addEventListener("change", (e) => void set({ on_top: (e.target as HTMLInputElement).checked }));
  ($("opt-sound") as HTMLInputElement).addEventListener("change", (e) => void set({ sound: (e.target as HTMLInputElement).checked }));
  ($("opt-notify") as HTMLInputElement).addEventListener("change", (e) => void set({ os_notify: (e.target as HTMLInputElement).checked }));
  // 창에 손이 오면 새 소식을 본 것으로 친다(배지 지움).
  window.addEventListener("focus", () => { if (snap && snap.unseen > 0) void invoke("mini_seen").catch(() => {}); });
}

void boot();
