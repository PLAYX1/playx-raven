/**
 * 복구 단어가 보이는 동안 창을 **화면 캡처·녹화에서 가린다**(0.4.8).
 *
 * 🔴 왜 — 복구 단어 한 장면이 스크린숏 폴더·화면 공유·녹화에 남으면 그게 곧 지갑이다.
 *    Tauri `setContentProtected` 는 맥에서는 창을 캡처에서 빼고(NSWindowSharingNone),
 *    윈도우에서는 SetWindowDisplayAffinity 로 검게 찍히게 한다. 사진기로 화면을 찍는
 *    것까지 막지는 못한다 — 그래서 「사진 찍지 마세요」 안내는 그대로 둔다.
 *
 * 켜고 끄는 것은 복구 단어 시트(열기 → 켬, 닫기 → 끔)만 한다. 늘 켜 두면 사장님이
 * 문제 신고용 캡처를 못 찍는다. Tauri 밖(시험 화면)에서는 조용히 넘어간다.
 */
import { getCurrentWindow } from "@tauri-apps/api/window";

export async function protectScreen(on: boolean): Promise<void> {
  try {
    await getCurrentWindow().setContentProtected(on);
  } catch {
    // 시험 화면(가짜 Tauri)·권한 없음 — 가리지 못해도 단어 시트는 그대로 열린다.
  }
}
