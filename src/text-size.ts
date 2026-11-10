/**
 * 11-10 글자 크기 — 작게(100%) · 보통(115%, 기본) · 크게(130%). 대표·페이블 합의.
 * 웹뷰 확대(러스트 set_text_zoom)라 단추·아이콘도 같이 커지고, 창 최소 폭도 같이 늘어 데스크탑 배치가 유지된다.
 * 브라우저 시험(타우리 없음)에서는 아무것도 하지 않는다 — 화면 배치 검사가 100% 기준을 그대로 본다.
 */
import { invoke } from "@tauri-apps/api/core";

export type TextSize = "small" | "normal" | "large";
export const TEXT_SIZES: readonly TextSize[] = ["small", "normal", "large"];
export const TEXT_SIZE_NAME: Record<TextSize, string> = { small: "작게", normal: "보통", large: "크게" };
const KEY = "ravenvault-text-size";

export function textSize(): TextSize {
  try { const v = localStorage.getItem(KEY); if (v === "small" || v === "normal" || v === "large") return v; } catch { /* 기본 */ }
  return "normal";
}
const inTauri = () => typeof window !== "undefined" && "__TAURI_INTERNALS__" in window && !(window as any).__RV_FIXTURE__;

export async function applyTextSize(size: TextSize = textSize()): Promise<void> {
  if (!inTauri()) return;
  try { await invoke("set_text_zoom", { level: size }); } catch (e) { console.warn("set_text_zoom failed", e); }
}
/** 바꾸고 저장한다. 바뀌기 전 값을 돌려준다(되돌리기용). */
export async function setTextSize(size: TextSize): Promise<TextSize> {
  const was = textSize();
  try { localStorage.setItem(KEY, size); } catch { /* 이번 실행만 */ }
  await applyTextSize(size);
  document.dispatchEvent(new CustomEvent("rv-text-size", { detail: size }));
  return was;
}
export function biggerOf(s: TextSize): TextSize { return s === "small" ? "normal" : "large"; }
export function smallerOf(s: TextSize): TextSize { return s === "large" ? "normal" : "small"; }
