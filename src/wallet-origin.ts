/* 0.9.60 지갑 출생 기록(src-tauri/src/wallet_origin.rs) → 설정 › 백업과 복구의 「만든 곳」 한 줄.
 * 기록은 이 컴퓨터 안에만 있다(서버·Nostr 로 안 나간다). 단어·주소는 기록에 없다. */
import { t, tf } from "./i18n";

export type WalletBirth = { origin?: string; platform?: string; nodeVersion?: string; appVersion?: string; createdAt?: number };

/** 0.9.60 지갑 출생 기록 → 「만든 곳: …」 한 줄. 기록이 없거나(지갑 전) 못 읽으면 숨긴다. */
export function walletOriginLine(b: WalletBirth | null): string {
  if (!b || !b.origin) return "";
  const app = b.appVersion || "?";
  const date = b.createdAt ? new Date(b.createdAt).toLocaleDateString() : "";
  if (b.origin === "created") return b.nodeVersion ? tf("만든 곳: 이 컴퓨터 노드 v{0} · 앱 {1} · {2}", b.nodeVersion, app, date) : tf("만든 곳: 이 컴퓨터 노드 · 앱 {0} · {1}", app, date);
  if (b.origin === "imported") return tf("만든 곳: 복구 단어로 되살림 · 앱 {0} · {1}", app, date);
  return t("만든 곳: 기록 없음 · 이 기능 전부터 있던 지갑");
}
