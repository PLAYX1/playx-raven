import { convertSatsE4, makeRvnReceipt, noConversion, type Receipt } from '../receipts';
import { receiptFeeRef } from '../creator/fee-track-v2';
import { QUOTE_FEE_KIND, QUOTE_PAY_GRACE_MS, QUOTE_TTL_MAX_MS, RATE_LIMITS, quoteFeeBps, quoteFeeLine, type QuoteFeeContext, type QuoteReceipt } from './quote';

/*
 * 매장 영수증(QuoteReceipt) → 공통 영수증(receipts Receipt) — GAP-13/6. 영수증 모델을 하나로: 매장 결제도 S1 CSV(receiptsToCsv)·백업·환불 목록에 그대로 들어간다.
 *   · 금액: merchantSats = 판매자 주소가 실제로 받은 것(receivedAtoms), platformFeeSats = 수수료 주소가 실제로 받은 것(feePaidAtoms), 공유 몫 0,
 *     amountSats = 둘의 합(정확히 낸 결제면 견적 총액 amountAtoms 와 같다).
 *   · 환율: 견적 krwE4(1 RVN 당 원 × 10⁴)를 그대로 rateKrwE4 칸에 싣는다(판 2 영수증). 예전 ×10³(rateKrwMilli)로 ÷10 하면 10 의 배수가 아닌 시세가 잘렸다 —
 *     이제 영수증 계산 자체가 ×10⁴ 이고 옛 milli 는 ×10 해서 같은 식을 쓴다(손실 없는 방향).
 *   · 주문 칸: orderHash = 견적 해시(= RVLT 메모). 매장 견적에는 상품 문서·구매자 nonce 가 없어 docHash·nonce 는 비운다.
 *   · 수수료 근거(판 3, 25라운드 §36): 견적 때의 수수료 판정 입력(fee = buildQuote 에 넘긴 QuoteFeeContext)을 다시 받아 적용 요율(pos)·요율표 버전을 남긴다.
 *     견적의 수수료 줄과 다시 계산한 요율이 맞지 않으면 던진다(다른 일정을 영수증에 박지 않음). 면제(수수료 줄 없음)면 요율은 남기고 수수료 0.
 *     수수료 줄이 없는 견적에 손님이 수수료 주소로 보낸 돈이 있으면(요율 근거 없는 수수료) 수수료 칸을 지어내지 않고 판 2 로 남긴다.
 *   · 시세 나이: 견적 경로가 허용하는 결제 시각 − 시세 시각의 최대값(QUOTE_RECEIPT_MAX_RATE_AGE_MS, 아래)이 영수증 상한(RECEIPT_PARAMS.maxQuoteAgeMs = 10분) 이하라서
 *     중간값 시세 견적은 항상 「결제 시점 환산」이 된다. 상한 둘(시세 60초 · 영수증 10분)은 뜻이 다르다: 60초 = 견적을 만들 때 출처 시세의 신선도,
 *     10분 = 영수증에 박는 시세와 결제 시각의 거리. 직접 입력(manual) 시세는 견적에서 나이를 보지 않으므로 10분을 넘으면 「환산 없음」이 된다(지어내지 않음).
 */

/**
 * 견적 경로의 최대 시세 나이(ms) = 출처 시세 신선도(60초) + 견적 유효 시간 상한(5분) + 만료 뒤 결제 유예(60초) + 시계 차(30초).
 * receipt-adapter 시험·종단 시험이 이 값 ≤ RECEIPT_PARAMS.maxQuoteAgeMs 를 확인한다(어느 한쪽 상수를 바꿔 어긋나면 시험이 멈춘다).
 */
export const QUOTE_RECEIPT_MAX_RATE_AGE_MS = RATE_LIMITS.maxAgeMs + QUOTE_TTL_MAX_MS + QUOTE_PAY_GRACE_MS + RATE_LIMITS.clockSkewMs;

/**
 * 매장 영수증 → 공통 영수증(판 2). productName 은 화면이 견적 품목에서 만든 요약(예: 「아메리카노 외 1」), counterparty = 손님 주소(체인 입력에서 읽은 것).
 * now(기본 = 결제 시각)는 시세·결제 시각이 미래인지 보는 기준. 환산이 영수증 규칙(10분)을 넘으면 「환산 없음」으로 둔다. 모양이 틀리면 던진다.
 */
export function quoteReceiptToReceipt(qr: QuoteReceipt, o: { id: string; productName: string; counterparty: string; now?: number; fee: QuoteFeeContext | null }): Receipt {
  if (!qr || qr.v !== 1) throw new Error('매장 영수증 형식 오류');
  if (typeof o?.id !== 'string' || !o.id || typeof o.productName !== 'string' || !o.productName.trim()) throw new Error('영수증 ID·상품명 없음');
  const amount = (BigInt(qr.receivedAtoms) + BigInt(qr.feePaidAtoms)).toString();
  const source = qr.rateMethod === 'manual' ? 'manual' : qr.rateSources.join('+');
  const conversion = Number.isSafeInteger(qr.rateKrwE4) && qr.rateKrwE4 > 0 && source
    ? convertSatsE4(amount, String(qr.rateKrwE4), source, qr.rateAt, qr.paidAt, o.now ?? qr.paidAt)
    : noConversion('견적 시세 없음');
  if (o.fee === undefined) throw new Error('수수료 판정 입력(fee) 없음 — 일정이 없으면 null 을 명시');
  const bps = quoteFeeBps(o.fee);
  // 견적의 수수료 줄 = 그 요율로 다시 낸 줄이어야 한다(면제면 둘 다 없음).
  const line = quoteFeeLine(BigInt(qr.quotedAtoms), bps);
  if ((line?.bps ?? 0) !== qr.feeBps || (line?.atoms ?? '0') !== qr.quotedFeeAtoms) throw new Error('견적 때와 다른 수수료 일정·요율');
  const fee = qr.feeBps === 0 && qr.feePaidAtoms !== '0' && bps === 0 ? {} : receiptFeeRef({ track: o.fee?.track ?? null, appliedBps: bps, feeKind: QUOTE_FEE_KIND });
  return makeRvnReceipt({
    id: o.id, productId: '', productName: o.productName, paidAt: qr.paidAt, counterparty: o.counterparty, txid: qr.txid,
    merchantSats: qr.receivedAtoms, platformFeeSats: qr.feePaidAtoms, shareSats: '0', conversion, orderHash: qr.quoteHash, ...fee,
  });
}
