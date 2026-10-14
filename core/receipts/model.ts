/** 결제 영수증 모델 — 결제수단과 무관한 공통 구조. 환산 실패는 지어내지 않고 「환산 없음」. */
import { RECEIPT_PARAMS } from './params';
import { isFeeKind, type FeeKind } from '../creator/fee-track-v2';
import { MARKET_FEE_BPS_CEILING } from '../creator/trade-primitives';

export type PaymentKind = 'rvn' | 'card' | 'cash' | 'transfer';
export type OrderStatus = 'pending' | 'paid' | 'refunded' | 'cancelled';

/**
 * 환율 칸은 둘 중 하나: rateKrwMilli(1 RVN 당 원 × 10³, 판 1 영수증) 또는 rateKrwE4(× 10⁴, 판 2 — 매장 견적 krwE4 와 같은 배율).
 * 계산은 모두 ×10⁴ 로 한다(milli 는 ×10 — 손실 없는 방향). 두 칸을 함께 쓰지 않는다.
 */
export type ConversionOk = {
  status: 'ok';
  /** 원화 환산액(원, 정수·반올림) */
  krw: string;
  source: string;
  /** 시세 조회 시각(ms) */
  quotedAt: number;
  /** 결제 뒤 보충한 환산 = 「사후 환산」 */
  late: boolean;
} & ({ /** 1 RVN 당 원, 1/1000원 단위 정수 문자열 */ rateKrwMilli: string; rateKrwE4?: undefined } | { /** 1 RVN 당 원 × 10⁴ 정수 문자열 */ rateKrwE4: string; rateKrwMilli?: undefined });
export type Conversion = ConversionOk | { status: 'none'; reason: string };

/**
 * 판 1 = 아래 확장 칸 없음(옛 백업 그대로). 판 2 = 확장 칸(전부 선택)을 쓸 수 있다:
 *   orderHash·docHash·nonce = 주문 원문 v2 의 그 값(매장 견적이면 orderHash = 견적 해시) — 영수증만으로 RVLT 메모를 다시 대조한다.
 *   ticketId = 발행한 티켓 ID(16바이트 hex) — 「환불됨」 영수증에서 철회 목록 키 ticket:<상품 ID>:<티켓 ID> 를 만든다(receiptTicketSubject).
 *   skeletonOnly = 백업에 없는 체인 거래에서 되살린 뼈대 — 총액·수수료·공유 몫은 모름(빈 문자열), merchantSats = 내 주소가 받은 sats 만.
 * 판 3 = 판 2 칸 + 수수료 근거 세 칸(25라운드 §36 「요율표 버전 고정」, 셋이 함께 있어야 한다):
 *   feeTrackId = 적용한 서명 일정의 식별자(fee-track-v2 feeTrackIdOf, 16 hex). 서명 확인된 일정이 없어 수수료 0 이면 null — 지어내지 않는다.
 *   appliedFeeBps = 그때 적용한 요율(0..천장). feeKind = 수수료 종류(모양이 깨진 상품 kind 면 null = 0%).
 *   불변식: 일정 없음(null)·종류 없음(null)이면 요율 0, 요율 0 이면 수수료 0. 요율 > 0 인데 수수료 0 = 면제선 미만(면제).
 */
export interface Receipt {
  version: 1 | 2 | 3;
  id: string;
  method: PaymentKind;
  status: OrderStatus;
  /** 결제(또는 표기) 시각 ms */
  paidAt: number;
  productId: string;
  productName: string;
  /** 총 결제 RVN, sats 정수 문자열 (RVN 아닌 수단은 '0') */
  amountSats: string;
  /** 분리 열: 판매자·플랫폼 수수료·공유 몫 (합 = amountSats) */
  merchantSats: string;
  platformFeeSats: string;
  shareSats: string;
  conversion: Conversion;
  counterparty: string;
  txid: string;
  /** 판매자 수동 「받았다고 표기」 — 체인 확인 없음, 수수료 대상 아님 */
  selfReported: boolean;
  orderHash?: string;
  docHash?: string;
  nonce?: string;
  ticketId?: string;
  skeletonOnly?: true;
  feeTrackId?: string | null;
  appliedFeeBps?: number;
  feeKind?: FeeKind | null;
}
/** 판 2 확장 칸 이름(판 1 영수증에 있으면 거절). */
export const RECEIPT_EXT_KEYS = ['orderHash', 'docHash', 'nonce', 'ticketId', 'skeletonOnly'] as const;
/** 판 3 수수료 칸 이름(판 1·2 영수증에 있으면 거절, 판 3 에는 셋 다 있어야 한다). */
export const RECEIPT_FEE_KEYS = ['feeTrackId', 'appliedFeeBps', 'feeKind'] as const;
export type ReceiptOrderRef = { orderHash?: string; docHash?: string; nonce?: string; ticketId?: string };
/** 수수료 근거(fee-track-v2 receiptFeeRef 가 만든다). */
export type ReceiptFeeFields = { feeTrackId?: string | null; appliedFeeBps?: number; feeKind?: FeeKind | null };

const bi = (s: string): bigint => { if (!/^\d+$/.test(s)) throw new Error('금액은 0 이상의 정수 문자열'); return BigInt(s); };
const TXID = /^[0-9a-f]{64}$/;

const CLOCK_SKEW_MS = 60_000;
/** 원화 = sats × (1 RVN 당 원 × 10⁴) ÷ (10⁸ × 10⁴), 반올림. milli 시세는 ×10 해서 같은 식(옛 ÷10¹¹ 반올림과 결과가 같다). */
const krwOfE4 = (sats: bigint, rateKrwE4: bigint): bigint => { const d = RECEIPT_PARAMS.satsPerRvn * 10_000n; return (sats * rateKrwE4 + d / 2n) / d; };
/** 환산의 시세를 ×10⁴ 정수로(milli 는 ×10). 환산 없음·모양이 틀리면 null. */
export function conversionRateE4(c: Conversion): bigint | null {
  if (!c || c.status !== 'ok') return null;
  const e4 = c.rateKrwE4, milli = c.rateKrwMilli;
  if ((e4 === undefined) === (milli === undefined)) return null;
  const s = e4 ?? milli as string;
  if (typeof s !== 'string' || !/^(0|[1-9]\d*)$/.test(s)) return null;
  return e4 !== undefined ? BigInt(e4) : BigInt(s) * 10n;
}
/**
 * 결제 금액(sats)의 원화 환산. 결제 시점 환산(late=false)은 시세 시각이 **결제 시각(paidAt)** 과 maxQuoteAgeMs 안이어야 한다
 * (오래된·나중의 시세를 결제 시점 값처럼 박지 않는다). 사후 환산(late=true)은 결제 뒤에 조회한 시세만(quotedAt ≥ paidAt).
 * 시각은 지금(now)보다 미래일 수 없다(시계 차 1분 허용). 실패는 지어내지 않고 「환산 없음」.
 */
export function convertSats(sats: string, rateKrwMilli: string, source: string, quotedAt: number, paidAt: number, now: number, late = false): Conversion {
  return convertAt(sats, rateKrwMilli, 'milli', source, quotedAt, paidAt, now, late);
}
/** convertSats 와 같되 시세가 1 RVN 당 원 × 10⁴(매장 견적 krwE4 배율) — 판 2 영수증 전용(rateKrwE4 칸). */
export function convertSatsE4(sats: string, rateKrwE4: string, source: string, quotedAt: number, paidAt: number, now: number, late = false): Conversion {
  return convertAt(sats, rateKrwE4, 'e4', source, quotedAt, paidAt, now, late);
}
function convertAt(sats: string, rate: string, unit: 'milli' | 'e4', source: string, quotedAt: number, paidAt: number, now: number, late: boolean): Conversion {
  if (!source || typeof rate !== 'string' || !/^\d+$/.test(rate) || BigInt(rate) <= 0n) return noConversion('시세를 받지 못함');
  if (!Number.isSafeInteger(quotedAt) || !Number.isSafeInteger(paidAt) || !Number.isFinite(now) || quotedAt > now + CLOCK_SKEW_MS || paidAt > now + CLOCK_SKEW_MS)
    return noConversion('시세 시각이 올바르지 않음');
  if (late) { if (quotedAt < paidAt) return noConversion('사후 환산 시세가 결제보다 이름'); }
  else if (Math.abs(paidAt - quotedAt) > RECEIPT_PARAMS.maxQuoteAgeMs) return noConversion('시세가 결제 시각과 멂');
  const krw = krwOfE4(bi(sats), unit === 'e4' ? BigInt(rate) : BigInt(rate) * 10n).toString();
  return unit === 'e4' ? { status: 'ok', krw, rateKrwE4: rate, source, quotedAt, late } : { status: 'ok', krw, rateKrwMilli: rate, source, quotedAt, late };
}
export const noConversion = (reason: string): Conversion => ({ status: 'none', reason });

/** 수수료 근거 칸을 주면 판 3, 확장 칸(orderHash·docHash·nonce·ticketId)만 주면 판 2, 아무것도 없으면 판 1(옛 모양 그대로). */
export function makeRvnReceipt(i: {
  id: string; productId: string; productName: string; paidAt: number; counterparty: string; txid: string;
  merchantSats: string; platformFeeSats: string; shareSats?: string; conversion: Conversion; status?: OrderStatus;
} & ReceiptOrderRef & ReceiptFeeFields): Receipt {
  const share = i.shareSats ?? '0';
  const total = bi(i.merchantSats) + bi(i.platformFeeSats) + bi(share);
  if (total <= 0n) throw new Error('결제 금액이 0');
  if (!TXID.test(i.txid)) throw new Error('txid 형식이 올바르지 않음');
  if (!i.counterparty) throw new Error('상대 주소 없음');
  const ext: ReceiptOrderRef = {};
  for (const k of ['orderHash', 'docHash', 'nonce', 'ticketId'] as const) if (i[k] !== undefined) ext[k] = i[k];
  const fee: ReceiptFeeFields = {};
  if (i.feeTrackId !== undefined) fee.feeTrackId = i.feeTrackId;
  if (i.appliedFeeBps !== undefined) fee.appliedFeeBps = i.appliedFeeBps;
  if (i.feeKind !== undefined) fee.feeKind = i.feeKind;
  const r: Receipt = {
    version: Object.keys(fee).length > 0 ? 3 : Object.keys(ext).length > 0 || i.conversion?.status === 'ok' && i.conversion.rateKrwE4 !== undefined ? 2 : 1,
    id: i.id, method: 'rvn', status: i.status ?? 'paid', paidAt: i.paidAt, productId: i.productId, productName: i.productName,
    amountSats: total.toString(), merchantSats: i.merchantSats, platformFeeSats: i.platformFeeSats, shareSats: share,
    conversion: i.conversion, counterparty: i.counterparty, txid: i.txid, selfReported: false, ...ext, ...fee,
  };
  const problem = validateReceipt(r);
  if (problem) throw new Error(problem);
  return r;
}

/** 현금·계좌이체 「받았다고 표기」 — 장부용. 체인 증거·수수료 없음. */
export function makeSelfReportedReceipt(i: {
  id: string; method: 'cash' | 'transfer'; productId: string; productName: string; paidAt: number; krw?: string; note?: string;
}): Receipt {
  if (i.krw !== undefined && !/^(0|[1-9]\d*)$/.test(i.krw)) throw new Error('원화 금액은 0 이상의 정수');
  return {
    version: 1, id: i.id, method: i.method, status: 'paid', paidAt: i.paidAt, productId: i.productId, productName: i.productName,
    amountSats: '0', merchantSats: '0', platformFeeSats: '0', shareSats: '0',
    conversion: i.krw === undefined ? noConversion('원화 금액 미입력')
      : { status: 'ok', krw: i.krw, rateKrwMilli: '0', source: '판매자 입력', quotedAt: i.paidAt, late: false },
    counterparty: i.note ?? '', txid: '', selfReported: true,
  };
}

const METHODS: readonly PaymentKind[] = ['rvn', 'card', 'cash', 'transfer'];
const STATUSES: readonly OrderStatus[] = ['pending', 'paid', 'refunded', 'cancelled'];
const INT = /^(0|[1-9]\d*)$/;
const SHA = /^[a-f0-9]{64}$/, HEX16 = /^[a-f0-9]{32}$/;

/** 환산 칸 모양 검사. 결제 시점 RVN 환산이면 시세 시각이 결제 시각과 maxQuoteAgeMs 안이고 원화 = 금액 × 시세(반올림)와 같아야 한다. */
function conversionProblem(r: Receipt): string | null {
  const c = r.conversion as Conversion | null;
  if (!c || typeof c !== 'object') return '환산 형식 오류';
  if (c.status === 'none') return typeof c.reason === 'string' && c.reason ? null : '환산 형식 오류';
  if (c.status !== 'ok') return '환산 형식 오류';
  const e4 = conversionRateE4(c);
  if (typeof c.krw !== 'string' || !INT.test(c.krw) || e4 === null || typeof c.source !== 'string' || !c.source ||
      !Number.isSafeInteger(c.quotedAt) || typeof c.late !== 'boolean') return '환산 형식 오류';
  if (c.rateKrwE4 !== undefined && r.version === 1) return '버전 1 영수증에 확장 칸';
  if (r.selfReported) return c.rateKrwMilli === '0' && !c.late ? null : '자진 표기 원화 형식 오류';
  if (r.method !== 'rvn' || e4 === 0n || r.skeletonOnly) return '환산 형식 오류';
  if (c.late ? c.quotedAt < r.paidAt : Math.abs(r.paidAt - c.quotedAt) > RECEIPT_PARAMS.maxQuoteAgeMs) return '시세 시각 오류';
  if (krwOfE4(BigInt(r.amountSats), e4).toString() !== c.krw) return '원화 환산 불일치';
  return null;
}

/** 판 2 확장 칸 모양. 판 1 이면 확장 칸이 하나도 없어야 한다. 판 1·2 에는 판 3 수수료 칸이 없어야 한다. */
function extensionProblem(r: Receipt): string | null {
  const has = (k: string) => (r as unknown as Record<string, unknown>)[k] !== undefined;
  const present = RECEIPT_EXT_KEYS.filter(has);
  if (r.version === 1) return present.length || RECEIPT_FEE_KEYS.some(has) ? '버전 1 영수증에 확장 칸' : null;
  if (r.version === 2 && RECEIPT_FEE_KEYS.some(has)) return '버전 2 영수증에 판 3 칸';
  if (r.orderHash !== undefined && (typeof r.orderHash !== 'string' || !SHA.test(r.orderHash))) return '주문 해시 형식 오류';
  if (r.docHash !== undefined && (typeof r.docHash !== 'string' || !SHA.test(r.docHash))) return '문서 해시 형식 오류';
  if (r.nonce !== undefined && (typeof r.nonce !== 'string' || !HEX16.test(r.nonce))) return 'nonce 형식 오류';
  if (r.ticketId !== undefined && (typeof r.ticketId !== 'string' || !HEX16.test(r.ticketId) || !SHA.test(r.productId))) return '티켓 ID 형식 오류';
  if (r.skeletonOnly !== undefined && r.skeletonOnly !== true) return '영수증 형식 오류';
  return null;
}

/** 불변식 검사 — 백업 복원·가져오기 때 쓴다. 객체가 아니어도 던지지 않고 문제 문구를 돌려준다. */
export function validateReceipt(r: Receipt): string | null {
  if (!r || typeof r !== 'object' || Array.isArray(r)) return '영수증 형식 오류';
  if (r.version !== 1 && r.version !== 2 && r.version !== 3) return '버전 불일치';
  if (!METHODS.includes(r.method) || !STATUSES.includes(r.status)) return '결제수단·상태 형식 오류';
  if (typeof r.id !== 'string' || !r.id || typeof r.productId !== 'string' || typeof r.productName !== 'string' || typeof r.counterparty !== 'string' ||
      typeof r.txid !== 'string' || typeof r.selfReported !== 'boolean' || !Number.isSafeInteger(r.paidAt) || r.paidAt < 0) return '영수증 형식 오류';
  const ext = extensionProblem(r);
  if (ext) return ext;
  if (r.skeletonOnly) {
    // 뼈대: 총액·수수료·공유 몫 = 모름(빈 칸). 내 주소가 받은 sats(merchantSats)만 안다. 금액을 지어내지 않는다.
    if (r.version === 3) return '수수료 칸은 RVN 결제 영수증만';
    if (r.method !== 'rvn' || r.selfReported || !TXID.test(r.txid)) return '뼈대 영수증 형식 오류';
    if (r.amountSats !== '' || r.platformFeeSats !== '' || r.shareSats !== '') return '뼈대 영수증은 총액·수수료·공유 몫을 모름';
    if (typeof r.merchantSats !== 'string' || !/^[1-9]\d*$/.test(r.merchantSats)) return '금액 형식 오류';
    return r.conversion?.status === 'none' && typeof r.conversion.reason === 'string' && r.conversion.reason ? null : '환산 형식 오류';
  }
  try {
    for (const k of [r.amountSats, r.merchantSats, r.platformFeeSats, r.shareSats]) if (typeof k !== 'string' || !INT.test(k)) throw 0;
    const sum = bi(r.merchantSats) + bi(r.platformFeeSats) + bi(r.shareSats);
    if (sum !== bi(r.amountSats)) return '금액 열 합계 불일치';
  } catch { return '금액 형식 오류'; }
  if (r.method === 'card') return '카드 결제는 아직 지원하지 않음';
  if (r.selfReported) {
    if (r.method !== 'cash' && r.method !== 'transfer') return '자진 표기는 현금·계좌이체만';
    if (r.amountSats !== '0' || r.platformFeeSats !== '0' || r.shareSats !== '0' || r.txid) return '자진 표기에 수수료·txid 불가';
  } else if (r.method === 'rvn') {
    if (!TXID.test(r.txid)) return 'txid 형식 오류';
    if (bi(r.amountSats) <= 0n) return '결제 금액이 0';
  } else return '현금·이체는 자진 표기여야 함';
  return feeRefProblem(r) ?? conversionProblem(r);
}

const TRACK_ID = /^[0-9a-f]{16}$/;
/** 판 3 수수료 근거 칸. 셋 다 있어야 하고, 일정·종류 없이 요율이 있거나 요율 0 인데 수수료가 나간 영수증은 거절. 자진 표기·뼈대에는 없다. */
function feeRefProblem(r: Receipt): string | null {
  if (r.version !== 3) return null;
  const has = (k: string) => Object.prototype.hasOwnProperty.call(r, k) && (r as unknown as Record<string, unknown>)[k] !== undefined;
  if (!RECEIPT_FEE_KEYS.every(has)) return '판 3 영수증에 수수료 칸 없음';
  if (r.selfReported || r.skeletonOnly || r.method !== 'rvn') return '수수료 칸은 RVN 결제 영수증만';
  const { feeTrackId: id, appliedFeeBps: bps, feeKind: kind } = r;
  if (id !== null && (typeof id !== 'string' || !TRACK_ID.test(id))) return '요율표 버전 형식 오류';
  if (typeof bps !== 'number' || !Number.isSafeInteger(bps) || bps < 0 || bps > MARKET_FEE_BPS_CEILING) return '적용 요율 형식 오류';
  if (kind !== null && !isFeeKind(kind)) return '수수료 종류 형식 오류';
  const feeSats = BigInt(r.platformFeeSats);
  if ((id === null || kind === null) && (bps !== 0 || feeSats !== 0n)) return '서명된 일정·종류 없이 수수료';
  if (bps === 0 && feeSats !== 0n) return '요율 0 인데 수수료';
  return null;
}

/** 철회 목록 키 — core/room ticketSubject · core/product-ext verifyTicketEntry 의 revoked 키와 같은 모양 「ticket:<상품 ID>:<티켓 ID>」. */
export const receiptTicketKey = (productId: string, ticketId: string): string => `ticket:${productId}:${ticketId}`;
/** 티켓 영수증(ticketId 칸 있음)이면 철회 목록 키, 아니면 null. */
export function receiptTicketSubject(r: Receipt): string | null {
  return r && typeof r.ticketId === 'string' && HEX16.test(r.ticketId) && typeof r.productId === 'string' && SHA.test(r.productId)
    ? receiptTicketKey(r.productId, r.ticketId) : null;
}
/** 환불·취소된 티켓 영수증 → 방 입장·현장 검표에 넘길 철회 목록(revoked). 검사에 실패한 영수증은 넣지 않는다(지어내지 않음). */
export function revokedFromReceipts(receipts: readonly Receipt[]): Set<string> {
  const out = new Set<string>();
  for (const r of receipts) {
    if (!r || (r.status !== 'refunded' && r.status !== 'cancelled') || validateReceipt(r) !== null) continue;
    const k = receiptTicketSubject(r);
    if (k) out.add(k);
  }
  return out;
}
