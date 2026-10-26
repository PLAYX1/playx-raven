import { isRvnAddress, MARKET_FEE_ADDRESS, MAX_PRICE_ATOMS } from '../creator/trade-primitives';
import { plain, type Loose } from '../creator/bytes';
import { PRODUCT_DUST_ATOMS, decodeOrderMemo, encodeOrderMemo, feeAmount, parseOrderMemo } from '../creator/product-doc';
import { candidateCeilingBps, kindAppliedBps, type FeeActivation } from '../creator/fee-policy';
import type { FeeTrackV2 } from '../creator/fee-track-v2';
import {
  addressOfKey, bodyHash, encodeDoc, fail, int, isNowMs, isPublicKey, keysAre, ORDER_ID, readDoc, SHA, ShopOrderError, signShopDoc, signedBy, text, time,
} from './signed';
import type { SignDigest } from '../signer/signmessage';

/*
 * 매장 주문 견적서 v1(RAVENVAULT-QUOTE-V1) — 결정문 §21 B2·B5, §23(견적 만료 시 조용한 재견적 금지), §25 Q3.
 *
 * 원화 메뉴 → 가게 키가 서명한 RVN 견적 한 장. 주문마다 새로 만들어 화면 QR 로 띄운다(고정 QR 스티커 금지).
 *   { v:1, quoteVersion:2, store:<가게 압축 공개키>, payTo:'R…', orderId, table:<테이블 번호|null>, items:[{title,qty,unitKrw}], shippingKrw, totalKrw,
 *     rate:{ method:'median'|'manual', krwE4, sources:[…], at }, amountAtoms, fee:{kind:'pos',address,bps,atoms}|null, sellerAtoms, issuedAt, expiresAt, sig }
 *   · 서명 도메인은 그대로 RAVENVAULT-QUOTE-V1(배포 전) — 칸 배치는 quoteVersion 으로 구분한다. 수수료 칸이 없는 옛 배치(quoteVersion 없음)는 거절.
 *   · krwE4 = 1 RVN 의 원화 × 10^4(정수). 금액은 부동소수 없이 atoms 정수로만 계산한다.
 *   · totalKrw = Σ qty × unitKrw + shippingKrw(배달비). 손님이 낼 amountAtoms = ceil(totalKrw × 10^8 × 10^4 / krwE4) — 1 atom 올림. 검증 때 다시 계산해 대조한다.
 *   · 수수료(대표 결정 2026-10-14: 매장 주문도 'pos' 1%): 기준 = 주문 총액 amountAtoms(가격 × 수량 + 배달비). 요율 = fee-policy kindAppliedBps('pos')
 *     — 서명 확인된 일정(verifyFeeTrackV2)이 있고 징수 개시('active')일 때만, 아니면 0. 산식은 product-doc feeAmount 하나(내림·상한 500 RVN·면제선).
 *     수수료가 0 이거나 면제선 미만이면 fee = null(수수료 줄 없음). 수수료 주소 = MARKET_FEE_ADDRESS 고정. sellerAtoms = amountAtoms − fee.atoms.
 *     결제 거래 = payTo ← sellerAtoms, MARKET_FEE_ADDRESS ← fee.atoms, RVLT 메모(견적 해시) — quoteReceipt 가 셋을 모두 대조한다.
 *   · 유효 시간 = expiresAt − issuedAt 이 [QUOTE_TTL_MIN_MS, QUOTE_TTL_MAX_MS]. expiresAt 시각 그 자체는 만료.
 *   · rate.method='median': 공개 시세 2~3곳 중간값(decideRate). 'manual': 시세가 없을 때 가게가 정한 고정 가격(sources 비움) — 화면에 그대로 표시.
 * 시세는 이 파일이 가져오지 않는다(네트워크 없음). 🔶 시세 출처(국내 RVN 상장 여부)는 확인 필요 — 대표 결정.
 * 환불은 영수증의 「받은 RVN 수량」 기준이다(지금 시세로 다시 환산하지 않는다).
 */

export const QUOTE_SIGN_DOMAIN = 'RAVENVAULT-QUOTE-V1';
export const QUOTE_VERSION = 1;
/** 견적 칸 배치 버전(quoteVersion). 2 = 배달비·수수료 줄·판매자 몫이 서명 대상에 들어간 배치. */
export const QUOTE_LAYOUT_VERSION = 2;
/** 매장 주문의 수수료 종류(fee-track-v2 FEE_KINDS 의 'pos', 후보 상한 1%). */
export const QUOTE_FEE_KIND = 'pos' as const;
/** 결제 거래 출력 수 상한(모양 검사). */
export const MAX_PAYMENT_OUTPUTS = 100;
export const MAX_QUOTE_BYTES = 8 * 1024;
export const MAX_QUOTE_ITEMS = 50;

/* ── 대표 결정 전 숫자(한 곳) ─────────────────────────────────────────── */
/** 견적 유효 시간: 기본 5분(§29, 4:3 채택 — 상수는 이 한 곳). 하한 3분·상한 5분 범위 안에서만 서명을 받는다. */
export const QUOTE_TTL_DEFAULT_MS = 5 * 60_000;
export const QUOTE_TTL_MIN_MS = 3 * 60_000;
export const QUOTE_TTL_MAX_MS = QUOTE_TTL_DEFAULT_MS;
/** 견적 한 장의 원화 상한 — 전문가 확인 전 「소액·시험 매장 한정」(§21 B5). 🔶 잠정 100만 원. */
export const MAX_QUOTE_KRW = 1_000_000;
/**
 * 🔶 만료 뒤 결제 허용폭 60초(리뷰 H2). paidAt = 가게가 그 거래를 처음 본 시각(멤풀 기준). 손님이 만료 직전에 보낸 거래가 조금 늦게 보이는 것만 봐준다.
 * paidAt ≥ expiresAt + 이 값이면 영수증을 만들지 않는다('ttl: late') — 받은 RVN 은 환불 대상(시세가 바뀌었으므로 조용히 받지 않는다, §23).
 */
export const QUOTE_PAY_GRACE_MS = 60_000;
export const RATE_LIMITS = {
  /** 시세 출처: 최대 3곳을 시도해(maxSources) 유효한 것이 2곳 이상(minSources)이면 진행, 1곳 이하면 중단(§29). */
  minSources: 2,
  maxSources: 3,
  /** 출처별 시세가 이보다 오래되면 버린다. 🔶 잠정 60초. */
  maxAgeMs: 60_000,
  /** 기기 시계 어긋남 허용(미래 시각 시세·견적). */
  clockSkewMs: 30_000,
  /** 출처 간 괴리 (최고−최저)/중간값 상한. 넘으면 중단. 🔶 잠정 3%. */
  maxSpreadBps: 300,
  /** 직전 중간값 대비 급변 상한(직전 값이 jumpWindowMs 안일 때만). 넘으면 중단. 🔶 잠정 5% / 10분. */
  maxJumpBps: 500,
  jumpWindowMs: 10 * 60_000,
} as const;
export type RateLimits = { [K in keyof typeof RATE_LIMITS]: number };

/* ── 시세 중간값 판정(순수) ──────────────────────────────────────────── */

export type RateSample = { source: string; krwE4: number; at: number };
export type RateHaltReason = 'shape' | 'duplicate-source' | 'too-few' | 'spread' | 'jump';
export type RateDecision =
  | { ok: true; krwE4: number; sources: string[]; at: number }
  | { ok: false; reason: RateHaltReason };

const SOURCE = /^[a-z0-9][a-z0-9.-]{0,31}$/;
const MAX_KRW_E4 = 1_000_000_000_000; // 1 RVN = 1억 원까지(모양 검사용)

/**
 * 출처 2~3곳의 시세로 견적 환율을 정한다. 오래된(maxAgeMs 초과)·미래 시세는 버리고, 남은 것이 minSources 미만이면 'too-few'.
 * 중간값: 3곳 = 가운데, 2곳 = 두 값 평균(내림). at = 쓴 시세 중 가장 오래된 시각.
 * 괴리(spread)·급변(jump)이면 중단 — 호출 측은 견적을 만들지 않고 「새 시세 받기」나 고정 가격(manual)으로 안내한다.
 */
export function decideRate(samples: readonly RateSample[], now: number, previous: { krwE4: number; at: number } | null = null, limits: RateLimits = RATE_LIMITS): RateDecision {
  if (!Array.isArray(samples) || samples.length > limits.maxSources || !isNowMs(now)) return { ok: false, reason: 'shape' };
  for (const s of samples) if (!plain(s) || typeof s.source !== 'string' || !SOURCE.test(s.source) || !int(s.krwE4, 1, MAX_KRW_E4) || !time(s.at)) return { ok: false, reason: 'shape' };
  if (new Set(samples.map(s => s.source)).size !== samples.length) return { ok: false, reason: 'duplicate-source' };
  const fresh = samples.filter(s => now - s.at <= limits.maxAgeMs && s.at - now <= limits.clockSkewMs);
  if (fresh.length < limits.minSources) return { ok: false, reason: 'too-few' };
  const values = fresh.map(s => s.krwE4).sort((a, b) => a - b);
  const mid = values.length >> 1;
  const median = values.length % 2 ? values[mid] : Math.floor((values[mid - 1] + values[mid]) / 2);
  const spread = BigInt(values[values.length - 1] - values[0]);
  if (spread * 10_000n > BigInt(limits.maxSpreadBps) * BigInt(median)) return { ok: false, reason: 'spread' };
  if (previous && int(previous.krwE4, 1, MAX_KRW_E4) && time(previous.at) && now - previous.at <= limits.jumpWindowMs) {
    const diff = BigInt(Math.abs(median - previous.krwE4));
    if (diff * 10_000n > BigInt(limits.maxJumpBps) * BigInt(previous.krwE4)) return { ok: false, reason: 'jump' };
  }
  return { ok: true, krwE4: median, sources: fresh.map(s => s.source).sort(), at: Math.min(...fresh.map(s => s.at)) };
}

/* ── 견적서 ─────────────────────────────────────────────────────────── */

export type QuoteItem = { title: string; qty: number; unitKrw: number };
export type QuoteRate = { method: 'median' | 'manual'; krwE4: number; sources: string[]; at: number };
/** 견적의 수수료 줄. 수수료가 0·면제면 견적 fee 칸이 null(줄 없음). */
export type QuoteFeeLine = { kind: typeof QUOTE_FEE_KIND; address: string; bps: number; atoms: string };
export type QuoteBody = {
  v: 1; quoteVersion: 2; store: string; payTo: string; orderId: string; table: string | null; items: QuoteItem[]; shippingKrw: number; totalKrw: number;
  rate: QuoteRate; amountAtoms: string; fee: QuoteFeeLine | null; sellerAtoms: string; issuedAt: number; expiresAt: number;
};
/**
 * 수수료 판정 입력. track = verifyFeeTrackV2 가 돌려준 일정(서명 확인 표식이 있는 그 객체)이어야 요율이 0 보다 클 수 있다.
 * height = 견적 시 팁 + 1. activation = fee-policy feeActivation 결과. 일정이 없으면 null(= 수수료 0).
 */
export type QuoteFeeContext = { track: FeeTrackV2 | null; height: number; activation: FeeActivation | null };
export type QuoteDoc = QuoteBody & { sig: string };
export type VerifiedQuote = { doc: QuoteDoc; quoteHash: string; storeAddress: string };

/** 원화 총액·환율 → 받을 atoms(올림). */
export function krwToAtoms(totalKrw: number, krwE4: number): bigint {
  const n = BigInt(totalKrw) * 100_000_000n * 10_000n, d = BigInt(krwE4);
  return (n + d - 1n) / d;
}
export const quoteTotalKrw = (items: readonly QuoteItem[], shippingKrw = 0): number => items.reduce((sum, i) => sum + i.qty * i.unitKrw, 0) + shippingKrw;

/** 매장 주문 수수료 요율(bps) — fee-policy kindAppliedBps('pos') 그대로. ctx 가 null 이면 0. */
export const quoteFeeBps = (ctx: QuoteFeeContext | null): number =>
  ctx ? kindAppliedBps({ kind: QUOTE_FEE_KIND, track: ctx.track, height: ctx.height, activation: ctx.activation }) : 0;
/** 총액(atoms)·요율 → 수수료 줄. 0 이거나 면제선 미만이면 null(줄 없음). 산식은 product-doc feeAmount(내림·상한·면제선). */
export function quoteFeeLine(amountAtoms: bigint, bps: number): QuoteFeeLine | null {
  if (bps === 0) return null;
  const a = feeAmount(amountAtoms, bps);
  return a.actualAtoms === 0n ? null : { kind: QUOTE_FEE_KIND, address: MARKET_FEE_ADDRESS, bps, atoms: a.actualAtoms.toString() };
}

/** 견적 본문을 만든다(서명 전). 시세는 decideRate 결과 또는 가게 고정 가격. 어긋나면 던진다. */
export function buildQuote(input: {
  store: string; payTo: string; orderId: string; table?: string | null; items: QuoteItem[]; shippingKrw?: number;
  rate: { method: 'median'; decision: RateDecision } | { method: 'manual'; krwE4: number; at: number };
  /** 수수료 판정 입력 — 일정이 없으면 null 을 명시한다(수수료 0). */
  fee: QuoteFeeContext | null;
  issuedAt: number; ttlMs?: number;
}): QuoteBody {
  let rate: QuoteRate;
  if (input.rate.method === 'median') {
    const d = input.rate.decision;
    if (!d.ok) return fail('rate', d.reason);
    rate = { method: 'median', krwE4: d.krwE4, sources: d.sources, at: d.at };
  } else rate = { method: 'manual', krwE4: input.rate.krwE4, sources: [], at: input.rate.at };
  const items = input.items.map(i => ({ title: i.title, qty: i.qty, unitKrw: i.unitKrw }));
  const shippingKrw = input.shippingKrw ?? 0;
  const totalKrw = int(shippingKrw, 0, MAX_QUOTE_KRW) ? quoteTotalKrw(items, shippingKrw) : 0;
  const amount = int(rate.krwE4, 1, MAX_KRW_E4) && int(totalKrw, 1, MAX_QUOTE_KRW) ? krwToAtoms(totalKrw, rate.krwE4) : 0n;
  const fee = amount > 0n && amount <= MAX_PRICE_ATOMS ? quoteFeeLine(amount, quoteFeeBps(input.fee)) : null;
  const body: QuoteBody = {
    v: 1, quoteVersion: QUOTE_LAYOUT_VERSION, store: input.store, payTo: input.payTo, orderId: input.orderId, table: input.table ?? null, items, shippingKrw, totalKrw, rate,
    amountAtoms: amount.toString(), fee, sellerAtoms: (amount - BigInt(fee?.atoms ?? 0)).toString(),
    issuedAt: input.issuedAt, expiresAt: input.issuedAt + (input.ttlMs ?? QUOTE_TTL_DEFAULT_MS),
  };
  validateQuoteBody(body);
  return body;
}

/** 엄격 모양·계산 검사(모르는 칸 거절). 서명은 보지 않는다. */
export function validateQuoteBody(raw: unknown, withSig = false): QuoteBody {
  const keys = 'v,quoteVersion,store,payTo,orderId,table,items,shippingKrw,totalKrw,rate,amountAtoms,fee,sellerAtoms,issuedAt,expiresAt' + (withSig ? ',sig' : '');
  if (!plain(raw)) return fail('shape', 'keys');
  // 수수료 칸이 없는 옛 배치(quoteVersion 없음)는 수수료를 빼먹은 견적과 구분할 수 없으므로 받지 않는다.
  if (!('quoteVersion' in raw)) return fail('shape', 'quote-version-legacy');
  if (raw.quoteVersion !== QUOTE_LAYOUT_VERSION) return fail('shape', 'quote-version');
  if (!keysAre(raw, keys)) return fail('shape', 'keys');
  const q = raw as Loose;
  if (q.v !== QUOTE_VERSION) fail('shape', 'version');
  if (!isPublicKey(q.store)) fail('key', 'store');
  if (!isRvnAddress(q.payTo)) fail('pay-to', 'address');
  if (q.payTo === MARKET_FEE_ADDRESS) fail('pay-to', 'fee-address');
  if (typeof q.orderId !== 'string' || !ORDER_ID.test(q.orderId)) fail('shape', 'orderId');
  if (q.table !== null && !text(q.table, 1, 16)) fail('shape', 'table');
  if (!Array.isArray(q.items) || q.items.length < 1 || q.items.length > MAX_QUOTE_ITEMS) fail('shape', 'items');
  for (const i of q.items as Loose[]) {
    if (!plain(i) || !keysAre(i, 'title,qty,unitKrw') || !text(i.title, 1, 60) || !int(i.qty, 1, 999) || !int(i.unitKrw, 0, MAX_QUOTE_KRW)) fail('shape', 'item');
  }
  if (!int(q.shippingKrw, 0, MAX_QUOTE_KRW)) fail('shape', 'shipping');
  if (!int(q.totalKrw, 1, MAX_QUOTE_KRW) || q.totalKrw !== quoteTotalKrw(q.items, q.shippingKrw)) fail('amount', 'total');
  const r = q.rate as Loose;
  if (!plain(r) || !keysAre(r, 'method,krwE4,sources,at') || !int(r.krwE4, 1, MAX_KRW_E4) || !time(r.at) || !Array.isArray(r.sources)) fail('rate', 'shape');
  if (r.method === 'median') {
    if (r.sources.length < RATE_LIMITS.minSources || r.sources.length > RATE_LIMITS.maxSources ||
        r.sources.some((s: unknown) => typeof s !== 'string' || !SOURCE.test(s)) || new Set(r.sources).size !== r.sources.length) fail('rate', 'sources');
  } else if (r.method !== 'manual' || r.sources.length !== 0) fail('rate', 'method');
  if (!time(q.issuedAt) || !time(q.expiresAt)) fail('ttl', 'time');
  const ttl = q.expiresAt - q.issuedAt;
  if (ttl < QUOTE_TTL_MIN_MS || ttl > QUOTE_TTL_MAX_MS) fail('ttl', 'range');
  if (r.at > q.issuedAt + RATE_LIMITS.clockSkewMs) fail('rate', 'future');
  if (r.method === 'median' && q.issuedAt - r.at > RATE_LIMITS.maxAgeMs) fail('rate', 'stale');
  if (typeof q.amountAtoms !== 'string' || !/^[1-9]\d{0,17}$/.test(q.amountAtoms)) fail('amount', 'atoms');
  const expected = krwToAtoms(q.totalKrw, r.krwE4);
  if (BigInt(q.amountAtoms) !== expected) fail('amount', 'rate-mismatch');
  if (expected > MAX_PRICE_ATOMS) fail('amount', 'too-large');
  let feeAtoms = 0n;
  const f = q.fee as Loose;
  if (f !== null) {
    if (!plain(f) || !keysAre(f, 'kind,address,bps,atoms') || f.kind !== QUOTE_FEE_KIND) fail('fee', 'shape');
    if (f.address !== MARKET_FEE_ADDRESS) fail('fee', 'address');
    if (!int(f.bps, 1, candidateCeilingBps(QUOTE_FEE_KIND))) fail('fee', 'bps');
    if (typeof f.atoms !== 'string' || !/^[1-9]\d{0,17}$/.test(f.atoms)) fail('fee', 'atoms');
    const a = feeAmount(expected, f.bps);
    // 면제선 미만(actual 0)이면 줄 자체가 없어야 한다.
    if (a.actualAtoms === 0n || BigInt(f.atoms) !== a.actualAtoms) fail('fee', 'atoms-mismatch');
    feeAtoms = a.actualAtoms;
  }
  if (typeof q.sellerAtoms !== 'string' || !/^[1-9]\d{0,17}$/.test(q.sellerAtoms) || BigInt(q.sellerAtoms) !== expected - feeAtoms) fail('amount', 'seller');
  if (expected - feeAtoms < PRODUCT_DUST_ATOMS) fail('amount', 'seller-dust');
  return q as QuoteBody;
}

/**
 * 받은 견적(바이트 또는 객체)을 검사·서명 확인한다. 서명자는 store 공개키여야 한다(직원 위임 키로는 견적을 낼 수 없다).
 * opts.fee(손님 앱이 가진 서명 확인된 일정·높이·개시 판정)를 주면 견적의 수수료 줄이 그 일정의 'pos' 요율과 정확히 같은지도 본다
 *   — 빠졌으면 'fee: missing', 다르면 'fee: policy'. 주지 않으면 견적 안의 계산 일치만 본다(가게 쪽 재확인용).
 */
export function verifyQuote(input: Uint8Array | unknown, opts: { fee?: QuoteFeeContext | null } = {}): VerifiedQuote {
  const raw = readDoc(input, MAX_QUOTE_BYTES);
  const q = validateQuoteBody(raw, true) as QuoteDoc;
  if (!signedBy(QUOTE_SIGN_DOMAIN, q, q.store)) fail('signature', 'invalid');
  if (opts.fee !== undefined) {
    const want = quoteFeeLine(BigInt(q.amountAtoms), quoteFeeBps(opts.fee));
    if (want && !q.fee) fail('fee', 'missing');
    const same = want === null ? q.fee === null : q.fee !== null && q.fee.kind === want.kind && q.fee.address === want.address && q.fee.bps === want.bps && q.fee.atoms === want.atoms;
    if (!same) fail('fee', 'policy');
  }
  return { doc: q, quoteHash: bodyHash(q), storeAddress: addressOfKey(q.store) };
}
export const encodeQuote = (q: QuoteDoc): Uint8Array => encodeDoc(q);

export type QuoteState = 'valid' | 'expired' | 'not-yet' | 'bad-clock';
/** 지금 결제해도 되는 견적인가. 만료면 「새 시세 받기」(조용히 다시 만들지 않는다, §23). now 가 ms 정수가 아니면 'bad-clock'(닫힌 실패). */
export function quoteState(v: VerifiedQuote, now: number): QuoteState {
  if (!isNowMs(now)) return 'bad-clock';
  if (now >= v.doc.expiresAt) return 'expired';
  if (v.doc.issuedAt - now > RATE_LIMITS.clockSkewMs) return 'not-yet';
  return 'valid';
}
/** 남은 ms(만료면 0). 화면 동심원 링용. */
export const quoteRemainingMs = (v: VerifiedQuote, now: number): number => (isNowMs(now) ? Math.max(0, v.doc.expiresAt - now) : 0);

/* ── 받은 금액·영수증·환불 ───────────────────────────────────────────── */

const ATOMS = /^(0|[1-9]\d{0,17})$/;
const TXID = SHA;

export type PaymentMatch = 'exact' | 'under' | 'over';
/** 판매자(payTo)가 받은 금액 대조 — 기준은 견적의 판매자 몫(sellerAtoms = 총액 − 수수료). 수수료 줄이 없으면 총액과 같다. */
export function paymentMatch(v: VerifiedQuote, receivedAtoms: string): PaymentMatch {
  if (typeof receivedAtoms !== 'string' || !ATOMS.test(receivedAtoms)) return fail('amount', 'received');
  const got = BigInt(receivedAtoms), want = BigInt(v.doc.sellerAtoms);
  return got === want ? 'exact' : got < want ? 'under' : 'over';
}

/**
 * 결제 메모에 담을 값(리뷰 M6) = 견적 본문 해시 32바이트(hex 64자). 손님 앱은 결제 거래에 RVLT 메모(quoteMemoScript = product-doc encodeOrderMemo 모양,
 * OP_RETURN "RVLT" | 버전 | 견적 해시)를 싣고, quoteReceipt 는 거래 출력에서 그 메모를 직접 읽는다 → 같은 금액의 열린 견적이 여럿이어도 어느 견적의 결제인지 정해진다.
 * 메모가 없으면 「같은 금액의 다른 열린 견적이 0개」라고 호출자가 말할 때만 금액으로 묶는다(binding 'amount').
 */
export const quotePaymentMemo = (v: VerifiedQuote): string => v.quoteHash;
/** 결제 거래에 넣을 메모 출력 스크립트(hex). */
export const quoteMemoScript = (v: VerifiedQuote): string => encodeOrderMemo(v.quoteHash);
/**
 * 결제 거래가 만들어야 할 출력(메모 제외): 판매자 ← sellerAtoms, (수수료 줄이 있으면) 수수료 주소 ← fee.atoms. 손님 앱은 이 표 그대로 보낸다.
 */
export function quotePaymentOutputs(v: VerifiedQuote): { role: 'seller' | 'fee'; address: string; atoms: string }[] {
  const out: { role: 'seller' | 'fee'; address: string; atoms: string }[] = [{ role: 'seller', address: v.doc.payTo, atoms: v.doc.sellerAtoms }];
  if (v.doc.fee) out.push({ role: 'fee', address: v.doc.fee.address, atoms: v.doc.fee.atoms });
  return out;
}

/** 영수증: 받은 RVN 수량과 결제 당시 견적의 원화·환율·출처·시각을 그대로 박는다(사후 환산 없음). match = 'exact' | 'over'(더 받음 — 차액 환불 대상), binding = 견적에 묶은 근거. */
/**
 * receivedAtoms = 판매자(payTo)가 받은 금액, quotedAtoms = 견적 총액(손님이 낼 금액), quotedSellerAtoms = 견적의 판매자 몫.
 * feeBps·quotedFeeAtoms = 견적의 수수료 줄(없으면 0·'0'), feePaidAtoms = 거래에서 수수료 주소가 받은 금액.
 */
export type QuoteReceipt = {
  v: 1; quoteHash: string; orderId: string; txid: string; receivedAtoms: string; quotedAtoms: string; quotedSellerAtoms: string;
  feeBps: number; quotedFeeAtoms: string; feePaidAtoms: string; totalKrw: number; shippingKrw: number;
  rateMethod: 'median' | 'manual'; rateKrwE4: number; rateSources: string[]; rateAt: number; paidAt: number;
  match: 'exact' | 'over'; binding: 'memo' | 'amount';
};
/** 체인 거래 출력(flow ChainLedger.splitTx 모양). 메모 출력은 address null + scriptHex. */
export type QuoteTxOutput = { address: string | null; atoms: string; scriptHex?: string | null };
export type QuotePayment = {
  txid: string;
  /** 체인에서 읽은 그 거래의 출력 전부(판매자·수수료·메모·거스름). */
  outputs: readonly QuoteTxOutput[];
  /** 가게가 그 거래를 처음 본 시각(ms). */
  paidAt: number;
};
/**
 * 영수증을 만든다 — 체인 거래 출력에서 판매자 출력·수수료 출력·RVLT 메모를 직접 대조한다. 아래 중 하나라도 걸리면 던진다
 * (영수증 없음 = 주문 미확정, 받은 RVN 은 환불 처리). 던지지 않고 이유를 받으려면 checkQuotePayment.
 *   판매자 몫 부족('amount: under') · 판매자 출력 없음('amount: zero') · 수수료 줄이 있는데 수수료 출력 없음('fee: missing') · 모자람('fee: under') ·
 *   만료 + QUOTE_PAY_GRACE_MS 이후('ttl: late') · 견적보다 이른 결제('ttl: early') ·
 *   RVLT 메모의 견적 해시가 다름('shape: memo-quote') · RVLT 메모가 둘 이상('shape: memo-many') · 이미 다른 영수증에 쓴 txid('amount: txid-used') ·
 *   메모 없이 정확하지 않은 금액이거나 같은 금액의 다른 열린 견적이 있음/모름('amount: ambiguous').
 * 같은 주소로 가는 출력이 여럿이면 합친다. 수수료 주소로 더 보낸 것은 거절하지 않는다(가게 몫과 무관). 수수료 줄이 없는 견적은 수수료 출력을 보지 않는다.
 * 🔶 호출자 책임: ctx.usedTxids 는 영수증을 만든 txid 전부(영속 저장). 성공하면 txid 를 저장한 **뒤** 주문을 확정한다.
 *    otherOpenQuotesSameAmount = 지금 열린(만료 전) 이 가게 견적 중 같은 amountAtoms 인 다른 견적 수 — 메모 없는 결제에만 쓴다.
 */
export function quoteReceipt(v: VerifiedQuote, payment: QuotePayment, ctx: { usedTxids: ReadonlySet<string>; otherOpenQuotesSameAmount?: number }): QuoteReceipt {
  if (!plain(payment) || typeof payment.txid !== 'string' || !TXID.test(payment.txid)) return fail('shape', 'txid');
  if (!isNowMs(payment.paidAt)) fail('shape', 'paidAt');
  if (!ctx || typeof ctx.usedTxids?.has !== 'function') fail('shape', 'usedTxids');
  const outs = payment.outputs;
  if (!Array.isArray(outs) || outs.length < 1 || outs.length > MAX_PAYMENT_OUTPUTS) fail('shape', 'outputs');
  for (const o of outs as Loose[]) {
    if (!plain(o) || (o.address !== null && typeof o.address !== 'string') || typeof o.atoms !== 'string' || !ATOMS.test(o.atoms) ||
        (o.scriptHex !== undefined && o.scriptHex !== null && typeof o.scriptHex !== 'string')) fail('shape', 'output');
  }
  const d = v.doc;
  if (payment.paidAt < d.issuedAt - RATE_LIMITS.clockSkewMs) fail('ttl', 'early');
  if (payment.paidAt >= d.expiresAt + QUOTE_PAY_GRACE_MS) fail('ttl', 'late');
  const sumTo = (addr: string) => outs.filter(o => o.address === addr).reduce((s, o) => s + BigInt(o.atoms), 0n);
  const received = sumTo(d.payTo).toString(), feePaid = sumTo(MARKET_FEE_ADDRESS);
  const match = paymentMatch(v, received);
  if (received === '0') fail('amount', 'zero');
  if (match === 'under') fail('amount', 'under');
  if (d.fee) {
    if (feePaid === 0n) fail('fee', 'missing');
    if (feePaid < BigInt(d.fee.atoms)) fail('fee', 'under');
  }
  const memos = outs.filter(o => typeof o.scriptHex === 'string' && parseOrderMemo(o.scriptHex) !== null);
  if (memos.length > 1) fail('shape', 'memo-many');
  let binding: 'memo' | 'amount';
  if (memos.length === 1) {
    if (decodeOrderMemo(memos[0].scriptHex) !== v.quoteHash) fail('shape', 'memo-quote');
    binding = 'memo';
  } else {
    if (match !== 'exact' || ctx.otherOpenQuotesSameAmount !== 0) fail('amount', 'ambiguous');
    binding = 'amount';
  }
  if (ctx.usedTxids.has(payment.txid)) fail('amount', 'txid-used');
  return {
    v: 1, quoteHash: v.quoteHash, orderId: d.orderId, txid: payment.txid, receivedAtoms: received, quotedAtoms: d.amountAtoms, quotedSellerAtoms: d.sellerAtoms,
    feeBps: d.fee?.bps ?? 0, quotedFeeAtoms: d.fee?.atoms ?? '0', feePaidAtoms: feePaid.toString(), totalKrw: d.totalKrw, shippingKrw: d.shippingKrw,
    rateMethod: d.rate.method, rateKrwE4: d.rate.krwE4, rateSources: [...d.rate.sources], rateAt: d.rate.at, paidAt: payment.paidAt,
    match: match as 'exact' | 'over', binding,
  };
}

export type QuotePaymentCheck = { ok: true; receipt: QuoteReceipt } | { ok: false; code: string; detail: string; message: string };
/** quoteReceipt 를 던지지 않는 모양으로 — 영수증이 없으면 이유(code·detail)와 화면 문구를 돌려준다. */
export function checkQuotePayment(v: VerifiedQuote, payment: QuotePayment, ctx: { usedTxids: ReadonlySet<string>; otherOpenQuotesSameAmount?: number }): QuotePaymentCheck {
  try { return { ok: true, receipt: quoteReceipt(v, payment, ctx) }; } catch (e) {
    if (!(e instanceof ShopOrderError)) throw e;
    return { ok: false, code: e.code, detail: e.detail, message: 결제거절안내(e.code, e.detail) };
  }
}
export function 결제거절안내(code: string, detail: string): string {
  if (code === 'fee') return detail === 'missing' ? '결제에 수수료 출력이 없어 주문을 확정하지 않았어요. 받은 RVN 은 환불 대상이에요.'
    : '결제의 수수료 출력이 견적보다 적어 주문을 확정하지 않았어요. 받은 RVN 은 환불 대상이에요.';
  if (code === 'ttl') return '견적 시간 밖의 결제라 주문을 확정하지 않았어요. 받은 RVN 은 환불 대상이에요.';
  if (code === 'amount' && detail === 'txid-used') return '이미 다른 주문에 쓴 거래예요.';
  if (code === 'amount') return '받은 금액이 견적과 맞지 않아 주문을 확정하지 않았어요.';
  return '결제 거래를 이 견적과 맞춰 보지 못했어요.';
}

/**
 * 환불 RVN 수량 — 기준은 손님이 실제로 낸 전체(판매자 몫 receivedAtoms + 낸 수수료 feePaidAtoms)다. 수수료는 플랫폼 주소로 이미 갔으므로
 * 판매자가 자기 지갑에서 전액을 돌려주고, 수수료는 플랫폼이 돌려주지 않는다(대표 10-14 확정 · 변호사 확인 항목). 지금 시세는 쓰지 않는다(시세가 올라도 내려도 같은 RVN 수량).
 * refundKrw 생략 = 전액(받은 수량 전부). 일부 = floor(받은 수량 × refundKrw / totalKrw). 비수탁이라 판매자가 직접 보낸다.
 */
export function refundAtoms(receipt: QuoteReceipt, refundKrw?: number): { atoms: string; basis: 'received-rvn' } {
  if (!plain(receipt) || typeof receipt.receivedAtoms !== 'string' || !ATOMS.test(receipt.receivedAtoms) || !int(receipt.totalKrw, 1, MAX_QUOTE_KRW)) return fail('shape', 'receipt');
  const feePaid = typeof receipt.feePaidAtoms === 'string' && ATOMS.test(receipt.feePaidAtoms) ? BigInt(receipt.feePaidAtoms) : 0n;
  const received = BigInt(receipt.receivedAtoms) + feePaid;
  if (refundKrw === undefined) return { atoms: received.toString(), basis: 'received-rvn' };
  if (!int(refundKrw, 0, receipt.totalKrw)) return fail('amount', 'refund');
  return { atoms: ((received * BigInt(refundKrw)) / BigInt(receipt.totalKrw)).toString(), basis: 'received-rvn' };
}

export function 시세중단안내(reason: RateHaltReason): string {
  switch (reason) {
    case 'too-few': return '시세를 두 곳 이상에서 받지 못해 견적을 멈췄어요. 잠시 뒤 다시 받거나 고정 가격을 써 주세요.';
    case 'spread': return '시세 출처끼리 값이 많이 달라 견적을 멈췄어요. 잠시 뒤 새 시세를 받아 주세요.';
    case 'jump': return '시세가 짧은 시간에 크게 움직여 견적을 멈췄어요. 잠시 뒤 새 시세를 받아 주세요.';
    case 'duplicate-source': case 'shape': return '시세 설정을 알아보지 못했어요. 가게 설정을 확인해 주세요.';
  }
}
export function 견적상태안내(state: QuoteState): string {
  switch (state) {
    case 'valid': return '견적이 아직 유효해요.';
    case 'expired': return '견적 시간이 지났어요. 「새 시세 받기」를 눌러 주세요.';
    case 'not-yet': return '견적 시각이 이 기기 시계보다 앞서 있어요. 기기 시계를 확인해 주세요.';
    case 'bad-clock': return '기기 시계를 읽지 못했어요. 기기 시계를 확인해 주세요.';
  }
}

/** 운영용: 가게 키 서명 콜백으로 견적에 서명한다(직원 위임 키는 견적을 낼 수 없다 — 서명자가 body.store 가 아니면 SignerError). */
export const signQuote = (signer: SignDigest, body: QuoteBody): Promise<QuoteDoc> => signShopDoc(signer, QUOTE_SIGN_DOMAIN, body, body.store);
