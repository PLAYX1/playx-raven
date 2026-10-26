// 대기화면 연결 — 부를 수 있는 것은 standby_state·standby_exit 둘뿐(Rust 문지기 display_mode::command_allowed).
// 아무 키·아무 클릭이면 돌아간다(비밀번호 없음 — 읽기 전용 화면이라 지킬 것이 없다). 마우스 움직임으로는 안 닫는다(계산대에서 스쳐도 유지).
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { Snapshot } from "./mini-view";
import { render, tick, type StandbySettings } from "./standby-view";
import "./standby.css";

let st: StandbySettings = { dim_from: 22, dim_to: 7, shift: true, locale: "ko" };
let snap: Snapshot | null = null;
let timer = 0;
let leaving = false;

function schedule() {
  tick(new Date(), st);
  const now = Date.now();
  // 다음 분 경계에 맞춰 깨운다 — 1초 타이머를 돌리지 않는다(분 단위 시계).
  timer = window.setTimeout(schedule, 60_000 - (now % 60_000) + 50);
}

function leave() {
  if (leaving) return;
  leaving = true;
  window.clearTimeout(timer);
  void invoke("standby_exit").catch(() => { leaving = false; });
}

async function boot() {
  try {
    const r = await invoke<{ snapshot: Snapshot; settings: StandbySettings }>("standby_state");
    st = r.settings; snap = r.snapshot;
    render(snap, st);
  } catch { /* 다음 이벤트를 기다린다 */ }
  schedule();
  await listen<Snapshot>("standby-snapshot", (e) => { snap = e.payload; render(snap, st); });
  window.addEventListener("keydown", (e) => { e.preventDefault(); leave(); });
  window.addEventListener("pointerdown", leave);
  document.addEventListener("visibilitychange", () => { if (document.hidden) window.clearTimeout(timer); else { window.clearTimeout(timer); schedule(); } });
}

void boot();
