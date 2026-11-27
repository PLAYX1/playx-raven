// 「폰 연결」 한 QR(11-28) — 지갑 연결 제안(RVWL1) 에 가게 직원 연결 주소를 겉봉 하나로 묶는다.
// 겉봉 규칙은 core/desktop-link/one-qr.ts(폰 ravenvault 저장소와 바이트 같음). 폰은 칸마다 원래 규칙으로 따로 검사한다.
// 🔴 복구 단어·개인키·지갑 암호는 어느 칸에도 없다(칸 이름이 정해져 있고 폰은 모르는 칸이 있으면 통째로 버린다).
import { encodeOneLinkQr } from "../core/desktop-link/one-qr";

/** 직원 주소가 없거나(가게 서버 꺼짐·봉함 키 없음) 겉봉을 못 만들면 옛 폰도 읽는 지갑 QR 그대로. */
export function oneLinkText(walletText: string, staffUrl: string | null | undefined): string {
  if (!staffUrl) return walletText;
  try { return encodeOneLinkQr({ wl: walletText, shop: staffUrl }); } catch { return walletText; }
}
