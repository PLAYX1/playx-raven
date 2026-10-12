import type { Listing } from './listing';
import { PAYMENT_ALLOWLIST_ONLY } from './mainnet-switches';

/*
 * 결제 허용 목록(C10) — 「대표가 서명한 허용 목록에 오른 상품만 결제」.
 *
 * 허용 목록 = 이미 있는 서명된 제작자 허용 목록(rv-creator-allowlist, 도메인 RAVENVAULT-CREATOR-ALLOWLIST-V1)이다. 새 형식은 없다.
 *   · 목록이 비어 있거나 못 받았거나 만료됐으면(creator-parts.ts: 만료 = 허용 목록은 기본값 = 없음) 판정이 'verified' 인 상품이 없다 → 결제할 수 있는 상품이 없다.
 *   · 항목이 status:'suspended' 이면 judgeListing 이 verified 로 보지 않는다 → 결제 닫힘. 차단 목록(deny)에 있으면 어느 층이든 숨는다.
 *   · 보증(b)층(500 RVN 소각만 한 판매자)·미검증은 PAYMENT_ALLOWLIST_ONLY 가 true 인 동안 결제 닫힘. 목록·미리보기·확인 화면은 그대로 보인다.
 * checkCreatorPurchase 가 거래를 만들기 전에 반드시 이 판정을 다시 한다(화면이 단추를 켰는지와 무관하게).
 */
export type PaymentGate = { ok: true } | { ok: false; reason: 'not-on-payment-allowlist' | 'no-payment' };

export function paymentGate(listing: Listing, onlyAllowlist: boolean = PAYMENT_ALLOWLIST_ONLY): PaymentGate {
  if (listing.status !== 'verified' && listing.status !== 'bonded') return { ok: false, reason: 'no-payment' };
  if (onlyAllowlist && listing.status !== 'verified') return { ok: false, reason: 'not-on-payment-allowlist' };
  return listing.payment ? { ok: true } : { ok: false, reason: 'no-payment' };
}

/** 화면이 「구매」 단추를 켤지 정하는 한 줄(거래를 만들지는 않는다 — 판매 스위치는 따로 본다). */
export const canPayOnWallet = (listing: Listing, onlyAllowlist: boolean = PAYMENT_ALLOWLIST_ONLY): boolean => paymentGate(listing, onlyAllowlist).ok;

/** 결제 닫힘 이유를 사람 말로(홍보 문구 아님 — 지금 사실만). */
export const PAYMENT_ALLOWLIST_SAY = '지금은 레이븐볼트가 확인해 목록에 올린 상품만 지갑에서 살 수 있어요. 이 상품은 아직 목록에 없어서 결제가 열려 있지 않아요.';
