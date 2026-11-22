/* 이야기 실시간 받기(제미나이 D1) — 뒤쪽: src-tauri/src/talk_live.rs
 * 바깥 릴레이 구독이 새 쪽지(1059)·방 글(42)·나를 부른 글(1·7)을 받으면 `talk-live` 사건이 온다.
 * 화면은 받은 즉시 원래의 읽기 함수를 부른다(그리는 길은 그대로). 구독이 살아 있으면 묻기 바퀴를 길게 한다.
 */
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

export type LiveNotice = { kind: number; id: string; room: string | null };
type Hook = (n: LiveNotice) => void;

let up = false;
let wired = false;
const hooks: Hook[] = [];

/** 지금 실시간 구독이 하나라도 살아 있나. */
export const liveUp = (): boolean => up;

/** 새 글 알림을 받는다. 같은 화면이 여러 번 불러도 각자 받는다. */
export function onTalkLive(h: Hook): void {
  hooks.push(h);
  wireTalkLive();
}

/** 같은 일을 짧은 사이에 여러 번 부르지 않게(세 릴레이·여러 글이 한꺼번에 와도 한 번). */
export function debounce(fn: () => void, ms: number): () => void {
  let t: number | undefined;
  return () => { if (t !== undefined) clearTimeout(t); t = window.setTimeout(() => { t = undefined; fn(); }, ms); };
}

export function wireTalkLive(): void {
  if (wired) return;
  wired = true;
  void listen<LiveNotice>("talk-live", (e) => { for (const h of hooks) { try { h(e.payload); } catch { /* 한 화면이 실패해도 나머지는 */ } } }).catch(() => {});
  void listen<{ up: boolean }>("talk-live-state", (e) => { up = !!e.payload?.up; }).catch(() => {});
  void invoke<{ up: boolean }>("talk_live_status").then((s) => { up = !!s?.up; }, () => {});
}
