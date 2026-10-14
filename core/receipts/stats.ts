import { validateReceipt, type Receipt } from './model';

/*
 * 영수증 건수 통계(25라운드 §36 「통계 오염」) — 순수 함수. 「유료 주문(플랫폼 수수료 > 0)」과 「수수료 0 주문」을 따로 센다:
 * 1 RVN 미만으로 쪼개 판 주문은 이용료가 면제(0)라 유료 건수에 섞이지 않는다(12개월 재토론 근거 보호).
 *   orders = 셀 수 있는 주문 = 결제 완료(paid)·RVN 체인 결제·불변식 통과·뼈대 아님. paidFee + feeFree = orders.
 *   feeFree 의 이유: exemptBelowMin(요율 > 0 인데 면제선 미만) · zeroRate(요율 0 — 일정 없음·닫힌 구역 등) · unknownRate(판 1·2 — 요율 기록 없음).
 *   excluded = 세지 않은 것: notPaid(대기·환불·취소) · selfReported(현금·이체 표기) · skeleton(총액·수수료 모름) · invalid(검사 실패).
 */
export type ReceiptStats = {
  orders: number; paidFee: number; feeFree: number;
  exemptBelowMin: number; zeroRate: number; unknownRate: number;
  /** 유료 주문의 수수료 합(sats 정수 문자열). */ feeSats: string;
  excluded: { notPaid: number; selfReported: number; skeleton: number; invalid: number };
};

export function receiptStats(receipts: readonly Receipt[]): ReceiptStats {
  const s: ReceiptStats = { orders: 0, paidFee: 0, feeFree: 0, exemptBelowMin: 0, zeroRate: 0, unknownRate: 0, feeSats: '0', excluded: { notPaid: 0, selfReported: 0, skeleton: 0, invalid: 0 } };
  let fee = 0n;
  for (const r of Array.isArray(receipts) ? receipts : []) {
    if (validateReceipt(r) !== null) { s.excluded.invalid++; continue; }
    if (r.skeletonOnly) { s.excluded.skeleton++; continue; }
    if (r.selfReported || r.method !== 'rvn') { s.excluded.selfReported++; continue; }
    if (r.status !== 'paid') { s.excluded.notPaid++; continue; }
    s.orders++;
    const f = BigInt(r.platformFeeSats);
    if (f > 0n) { s.paidFee++; fee += f; continue; }
    s.feeFree++;
    if (r.version !== 3 || r.appliedFeeBps === undefined) s.unknownRate++;
    else if (r.appliedFeeBps > 0) s.exemptBelowMin++;
    else s.zeroRate++;
  }
  s.feeSats = fee.toString();
  return s;
}
