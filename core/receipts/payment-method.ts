/** 결제수단 자리 — 「결제 확인」은 verify(payment) 한 함수 뒤. 카드는 구현하지 않는다(자리만). */
import { encodeOrderMemo, parseOrderMemo } from '../creator/product-doc';
import type { PaymentKind, Receipt } from './model';
import { RECEIPT_PARAMS } from './params';

export interface PaymentClaim {
  kind: PaymentKind;
  /** rvn: 기대 txid·수취 주소별 금액 */
  txid?: string;
  expectedOutputs?: { address: string; sats: string }[];
  /** rvn: 이 결제가 갚는 주문 해시(64 hex). 거래의 RVLT 메모가 정확히 이 주문이어야 한다 — 다른 주문의 txid 를 재사용(재전송)하지 못한다. */
  orderHash?: string;
  /** 최소 확인 수(기본 RECEIPT_PARAMS.minConfirmations, 1 이상). 모자라면 ok:false + pending:true. */
  minConfirmations?: number;
}
export type VerifyResult = { ok: true; confirmations: number } | { ok: false; reason: string; pending?: true };

export interface PaymentMethod {
  readonly kind: PaymentKind;
  /** 체인 증거가 있는 수단인가. false 면 영수증에 「체인 영수증 없음」 표기 */
  readonly chainEvidence: boolean;
  /** 수수료 집행 대상인가 */
  readonly feeApplies: boolean;
  verify(payment: PaymentClaim): Promise<VerifyResult>;
}

/** 체인 조회 주입 — 구현은 기존 chain-gateway 쪽. 메모(OP_RETURN) 출력은 scriptHex 를 채운다(address 는 null 가능). */
export type TxOutputs = { confirmations: number; outputs: { address: string | null; sats: string; scriptHex?: string | null }[] } | null;
const SATS = /^(0|[1-9]\d{0,20})$/, HASH = /^[0-9a-f]{64}$/;
export function rvnPaymentMethod(lookup: (txid: string) => Promise<TxOutputs>): PaymentMethod {
  return {
    kind: 'rvn', chainEvidence: true, feeApplies: true,
    async verify(p) {
      if (!p || p.kind !== 'rvn' || typeof p.txid !== 'string' || !HASH.test(p.txid) || !Array.isArray(p.expectedOutputs) || !p.expectedOutputs.length) return { ok: false, reason: '검증 정보 부족' };
      if (typeof p.orderHash !== 'string' || !HASH.test(p.orderHash)) return { ok: false, reason: '주문 해시 없음' };
      if (p.expectedOutputs.some(w => !w || typeof w.address !== 'string' || !w.address || typeof w.sats !== 'string' || !SATS.test(w.sats) || w.sats === '0')) return { ok: false, reason: '검증 정보 부족' };
      const minConf = p.minConfirmations ?? RECEIPT_PARAMS.minConfirmations;
      if (!Number.isSafeInteger(minConf) || minConf < 1) return { ok: false, reason: '최소 확인 수가 올바르지 않음' };
      let tx: TxOutputs;
      try { tx = await lookup(p.txid); } catch { return { ok: false, reason: '체인 조회 실패' }; }
      if (!tx || !Array.isArray(tx.outputs)) return { ok: false, reason: '거래를 찾지 못함' };
      // RVLT 메모가 정확히 하나이고 이 주문이어야 한다(같은 txid 를 다른 주문 영수증에 쓰는 재전송 방지).
      const memos = tx.outputs.filter(o => o && typeof o.scriptHex === 'string' && parseOrderMemo(o.scriptHex) !== null);
      if (memos.length !== 1 || memos[0].scriptHex !== encodeOrderMemo(p.orderHash)) return { ok: false, reason: '주문 메모가 맞지 않음' };
      // 같은 출력을 두 번 쓰지 않도록 소비 표시
      const used = new Set<number>();
      for (const want of p.expectedOutputs) {
        const idx = tx.outputs.findIndex((o, k) => !used.has(k) && !!o && o.address === want.address && o.sats === want.sats);
        if (idx < 0) return { ok: false, reason: '금액·주소가 맞지 않음' };
        used.add(idx);
      }
      if (!Number.isSafeInteger(tx.confirmations) || tx.confirmations < 0) return { ok: false, reason: '확인 수를 읽지 못함' };
      if (tx.confirmations < minConf) return { ok: false, reason: `확인 대기(${tx.confirmations}/${minConf})`, pending: true };
      return { ok: true, confirmations: tx.confirmations };
    },
  };
}

/** 현금·계좌이체 — 확인 수단이 없다. 판매자가 표기한 기록일 뿐. */
export function manualPaymentMethod(kind: 'cash' | 'transfer'): PaymentMethod {
  return { kind, chainEvidence: false, feeApplies: false, verify: async () => ({ ok: false, reason: '자진 표기 — 확인할 방법이 없음' }) };
}

/** 카드 자리. 서버·PG·사업 주체가 필요해 별도 모듈로만 구현한다. */
export const cardPaymentMethod: PaymentMethod = {
  kind: 'card', chainEvidence: false, feeApplies: false,
  verify: async () => ({ ok: false, reason: '카드 결제는 아직 지원하지 않음' }),
};

export const receiptHasChainEvidence = (r: Receipt): boolean => !r.selfReported && r.method === 'rvn' && r.txid !== '';
