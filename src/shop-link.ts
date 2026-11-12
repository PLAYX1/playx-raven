/* 가게 링크 두 갈래 — ① 무료 · 레이븐볼트 고정 링크(추천) ② 더 안정적 · 유료(내 도메인+클라우드플레어 / 테일스케일).
 *
 * 무료 고정 링크 `https://ravenvault.ex.erci.se/s/<가게 주소 이름>-<8자리>` 는 웹이 가게의 **지금** 주소로 이어 준다
 * (src-tauri/src/map.rs publish_link · 웹 core/market/merchants/shop-link.ts). 이 파일은 순수 함수와 가격 상수만 —
 * 시험(scripts/shop-link.test.mjs)이 그대로 읽는다. 다른 파일을 import 하지 않는다.
 */

/** 🔴 가격은 여기 한 곳만 고친다. 화면은 「약」을 붙여 보여 주고, 확인한 날도 함께 적는다.
 *  - 테일스케일: https://tailscale.com/pricing — Personal 무료(비상업용만), Standard(옛 Starter) 1명 월 $8, Premium $18.
 *  - .com 도메인: 클라우드플레어 등록 대행은 원가 판매 — 1년 $10.46(cfdomainpricing.com, 11-12 갱신 기준).
 *  원화는 1달러 약 1,450원으로 어림해 반올림했다. */
export const SHOP_LINK_PRICES = {
  checked: "2026-11-13",
  tailscaleStandardUsdMonth: 8,
  tailscaleStandardKrwMonth: 12_000,
  comDomainUsdYear: 10.5,
  comDomainKrwYear: 15_000,
} as const;

/** 「약 1만 5천 원」 같은 쉬운 말. 화면 말이 한국어가 아니면 숫자만(₩15,000). */
export function wonPlain(n: number): string {
  const man = Math.floor(n / 10_000), cheon = Math.round((n % 10_000) / 1_000);
  if (!man) return `${cheon}천 원`;
  return cheon ? `${man}만 ${cheon}천 원` : `${man}만 원`;
}

export function domainPriceText(lang = "ko"): string {
  const p = SHOP_LINK_PRICES;
  return lang === "ko" ? `$${p.comDomainUsdYear} (${wonPlain(p.comDomainKrwYear)})` : `$${p.comDomainUsdYear} (₩${p.comDomainKrwYear.toLocaleString("en-US")})`;
}

export function tailscalePriceText(lang = "ko"): string {
  const p = SHOP_LINK_PRICES;
  return lang === "ko" ? `$${p.tailscaleStandardUsdMonth} (${wonPlain(p.tailscaleStandardKrwMonth)})` : `$${p.tailscaleStandardUsdMonth} (₩${p.tailscaleStandardKrwMonth.toLocaleString("en-US")})`;
}

/** 무료 고정 링크 모양(`https://ravenvault.ex.erci.se/s/<slug>-<8자리>`) — map_format.rs `is_shop_link_url` 과 같다. */
export function isFreeShopLink(u: unknown): boolean {
  return typeof u === "string" && /^https:\/\/ravenvault\.ex\.erci\.se\/s\/[a-z0-9][a-z0-9-]{1,39}-[0-9b-hjkmnp-z]{8}\/?$/.test(u.trim());
}

export type LinkKind = "free" | "temporary" | "none" | "fixed";

/**
 * 가게 링크 칸 아래에 무엇을 말할지.
 * - free: 이 가게 자신의 무료 고정 링크 → 「임시 주소」 경고 **없음**.
 * - temporary: …trycloudflare.com → 경고(무료 고정 링크를 권한다).
 * - none: 비었음. fixed: 테일스케일·내 도메인 등.
 */
export function shopLinkKind(url: unknown, ownFreeLink: unknown): LinkKind {
  const u = typeof url === "string" ? url.trim() : "";
  if (!u) return "none";
  if (isFreeShopLink(u) && typeof ownFreeLink === "string" && u.replace(/\/$/, "") === ownFreeLink) return "free";
  if (u.toLowerCase().includes(".trycloudflare.com")) return "temporary";
  return "fixed";
}

/** 「가게 링크 알려 줘」 — 라비가 무료 고정 링크를 먼저 보여 준다. 지갑·받는 주소 이야기는 아니다. */
const TELL = /가게\s?(링크|주소|url).{0,8}(알려|뭐|보여|복사|줘|어디)|(손님|고객).{0,8}(링크|주소).{0,6}(알려|뭐|줘|보내)|(shop|store) (link|url)|店(の)?リンク|店铺链接/;
export function raviShopLinkTellIntent(q: string): boolean {
  const s = q.replace(/\s+/g, " ").trim().toLowerCase();
  if (!s || s.length > 60) return false;
  if (/지갑|받는\s?주소|보내는\s?주소|rvn|코인|wallet/.test(s)) return false;
  return TELL.test(s);
}
