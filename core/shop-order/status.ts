import { plain, type Loose } from '../creator/bytes';
import { bodyHash, encodeDoc, fail, int, isNowMs, isPublicKey, keysAre, ORDER_ID, readDoc, SHA, signedBy, text, time } from './signed';
import { verifyStaffCert, type DelegationReason, type RevocationList, type StaffCert, type StaffScope } from './delegation';

/*
 * 서명 주문 상태 메시지 v1(RAVENVAULT-ORDER-STATUS-V1) — 결정문 §21 B1, §23(접수/처리 중/나왔습니다 3열·근거 없는 예상 시간 금지).
 *
 *   { v:1, store, orderId, quoteHash, seq, status, table, issuedAt, expiresAt, signer, cert, sig }
 *   · status 는 accepted(접수) → preparing(처리 중) → ready(나왔습니다) 순서뿐이고 seq = 단계 번호(1·2·3).
 *   · quoteHash = 이 주문의 견적서 본문 해시(quote.ts) — 다른 주문·다른 견적의 메시지를 끼워 넣지 못한다.
 *   · table 은 견적서의 table 과 같아야 한다(리뷰 L2) — 같은 견적에 다른 테이블 번호를 붙인 상태 알림은 'other-table'.
 *   · signer = 가게 키(cert:null) 또는 직원 키(cert = 가게가 서명한 직원 위임 증서, 그 단계의 범위가 있어야 함).
 *   · 받는 쪽(applyStatus)은 재전송(같은 메시지)·역행(이미 지난 단계)·건너뛰기(접수 없이 나왔습니다 등)·만료를 거절한다.
 * 이 파일은 메시지를 보내거나 받지 않는다(우편함은 envelope.ts 의 타입만). 상태가 없으면 손님 화면은 「매장 확인 대기」로 정직하게 표시.
 */

export const STATUS_SIGN_DOMAIN = 'RAVENVAULT-ORDER-STATUS-V1';
export const MAX_STATUS_BYTES = 8 * 1024;
/** 상태 메시지 하나의 유효 시간 상한. 🔶 잠정 6시간(매장 영업 중 한 주문). 대표 결정. */
export const STATUS_TTL_MAX_MS = 6 * 3600_000;
export const STATUS_CLOCK_SKEW_MS = 30_000;

export const ORDER_STAGES = ['accepted', 'preparing', 'ready'] as const;
export type OrderStage = (typeof ORDER_STAGES)[number];
export const STAGE_SCOPE: Record<OrderStage, StaffScope> = { accepted: 'order-accept', preparing: 'order-progress', ready: 'order-ready' };

export type StatusBody = {
  v: 1; store: string; orderId: string; quoteHash: string; seq: number; status: OrderStage; table: string | null;
  issuedAt: number; expiresAt: number; signer: string; cert: StaffCert | null;
};
export type StatusMessage = StatusBody & { sig: string };

export function validateStatus(raw: unknown, withSig = true): StatusMessage {
  if (!plain(raw) || !keysAre(raw, 'v,store,orderId,quoteHash,seq,status,table,issuedAt,expiresAt,signer,cert' + (withSig ? ',sig' : ''))) return fail('shape', 'keys');
  const m = raw as Loose;
  if (m.v !== 1 || !isPublicKey(m.store) || !isPublicKey(m.signer)) fail('shape', 'key');
  if (typeof m.orderId !== 'string' || !ORDER_ID.test(m.orderId) || typeof m.quoteHash !== 'string' || !SHA.test(m.quoteHash)) fail('shape', 'order');
  const stage = (ORDER_STAGES as readonly unknown[]).indexOf(m.status);
  if (stage < 0 || !int(m.seq, 1, ORDER_STAGES.length) || m.seq !== stage + 1) fail('shape', 'seq');
  if (m.table !== null && !text(m.table, 1, 16)) fail('shape', 'table');
  if (!time(m.issuedAt) || !time(m.expiresAt) || m.expiresAt <= m.issuedAt || m.expiresAt - m.issuedAt > STATUS_TTL_MAX_MS) fail('ttl', 'range');
  if (m.signer === m.store ? m.cert !== null : !plain(m.cert)) fail('cert', 'presence');
  return m as StatusMessage;
}
export const statusHash = (m: StatusMessage | StatusBody): string => bodyHash(m);
export const encodeStatus = (m: StatusMessage): Uint8Array => encodeDoc(m);

/** 받는 쪽이 들고 있는 주문 하나의 상태(직렬화 가능). */
export type OrderStatusState = {
  store: string; orderId: string; quoteHash: string; seq: number; status: OrderStage; table: string | null;
  issuedAt: number; lastHash: string; signer: string; byStaff: boolean;
};
export type StatusReason =
  | 'shape' | 'other-store' | 'other-order' | 'other-quote' | 'other-table' | 'signature' | 'expired' | 'not-yet' | 'replay' | 'regress' | 'skip' | 'bad-clock'
  | `delegation:${DelegationReason}`;
export type StatusResult = { ok: true; state: OrderStatusState } | { ok: false; reason: StatusReason };
export type StatusContext = {
  /** 이 주문의 견적서에서 온 값(verifyQuote 결과) — 메시지에 적힌 값을 믿지 않고 대조만 한다. */
  store: string; orderId: string; quoteHash: string; table: string | null;
  /** ms(isNowMs). 아니면 'bad-clock'. */
  now: number; revocations: RevocationList | null; requireRevocationList?: boolean;
};

/** 메시지 한 장만 확인(순서 판정 없음). */
export function verifyStatus(raw: unknown, ctx: StatusContext): { ok: true; msg: StatusMessage; hash: string } | { ok: false; reason: StatusReason } {
  if (!isNowMs(ctx?.now)) return { ok: false, reason: 'bad-clock' };
  let m: StatusMessage;
  try { m = validateStatus(readDoc(raw, MAX_STATUS_BYTES)); } catch { return { ok: false, reason: 'shape' }; }
  if (m.store !== ctx.store) return { ok: false, reason: 'other-store' };
  if (m.orderId !== ctx.orderId) return { ok: false, reason: 'other-order' };
  if (m.quoteHash !== ctx.quoteHash) return { ok: false, reason: 'other-quote' };
  if (m.signer !== m.store) {
    const d = verifyStaffCert(m.cert, { store: m.store, now: ctx.now, scope: STAGE_SCOPE[m.status], revocations: ctx.revocations, requireRevocationList: ctx.requireRevocationList });
    if (!d.ok) return { ok: false, reason: `delegation:${d.reason}` };
    if (d.cert.staff !== m.signer) return { ok: false, reason: 'delegation:shape' };
  }
  if (!signedBy(STATUS_SIGN_DOMAIN, m, m.signer)) return { ok: false, reason: 'signature' };
  if (m.table !== ctx.table) return { ok: false, reason: 'other-table' };
  if (ctx.now >= m.expiresAt) return { ok: false, reason: 'expired' };
  if (m.issuedAt - ctx.now > STATUS_CLOCK_SKEW_MS) return { ok: false, reason: 'not-yet' };
  return { ok: true, msg: m, hash: statusHash(m) };
}

/**
 * 들고 있는 상태(null = 아직 없음)에 새 메시지를 적용한다. 바로 다음 단계(seq + 1)만 받는다.
 * 같은 메시지 = 'replay', 이미 지난 단계(같은 seq 의 다른 메시지 포함) = 'regress', 한 단계 넘게 앞 = 'skip'. 거절해도 들고 있는 상태는 그대로.
 */
export function applyStatus(state: OrderStatusState | null, raw: unknown, ctx: StatusContext): StatusResult {
  const v = verifyStatus(raw, ctx);
  if (!v.ok) return v;
  const m = v.msg, prevSeq = state?.seq ?? 0;
  if (state && v.hash === state.lastHash) return { ok: false, reason: 'replay' };
  if (m.seq <= prevSeq) return { ok: false, reason: 'regress' };
  if (m.seq !== prevSeq + 1) return { ok: false, reason: 'skip' };
  return { ok: true, state: {
    store: m.store, orderId: m.orderId, quoteHash: m.quoteHash, seq: m.seq, status: m.status, table: m.table,
    issuedAt: m.issuedAt, lastHash: v.hash, signer: m.signer, byStaff: m.signer !== m.store,
  } };
}

/** 서명기에 넘길 본문을 만든다(가게 키면 cert 없이, 직원 키면 증서와 함께). */
export function buildStatus(input: {
  store: string; orderId: string; quoteHash: string; status: OrderStage; table?: string | null; issuedAt: number; ttlMs?: number;
  signer: string; cert?: StaffCert | null;
}): StatusBody {
  const body: StatusBody = {
    v: 1, store: input.store, orderId: input.orderId, quoteHash: input.quoteHash, seq: ORDER_STAGES.indexOf(input.status) + 1, status: input.status,
    table: input.table ?? null, issuedAt: input.issuedAt, expiresAt: input.issuedAt + (input.ttlMs ?? STATUS_TTL_MAX_MS), signer: input.signer,
    cert: input.signer === input.store ? null : input.cert ?? null,
  };
  validateStatus(body, false);
  return body;
}

/** 손님·직원 화면 글자(§23 3열). 상태가 없으면 「매장 확인 대기」 — 예상 시간은 만들지 않는다. */
export function 주문상태글자(state: OrderStatusState | null): string {
  if (!state) return '매장 확인 대기';
  switch (state.status) {
    case 'accepted': return '접수';
    case 'preparing': return '처리 중';
    case 'ready': return '나왔습니다';
  }
}
export function 상태거절안내(reason: StatusReason): string {
  if (reason.startsWith('delegation:')) return '직원 위임장을 확인하지 못한 상태 알림이라 반영하지 않았어요.';
  switch (reason) {
    case 'replay': return '이미 받은 상태 알림이에요.';
    case 'regress': return '지난 단계의 상태 알림이라 반영하지 않았어요.';
    case 'skip': return '앞 단계 알림이 아직 오지 않았어요. 잠시 뒤 다시 확인해 주세요.';
    case 'expired': return '시간이 지난 상태 알림이에요.';
    case 'not-yet': return '상태 알림 시각이 이 기기 시계보다 앞서 있어요.';
    case 'signature': return '가게 서명이 맞지 않는 상태 알림이에요.';
    case 'other-store': case 'other-order': case 'other-quote': return '이 주문의 상태 알림이 아니에요.';
    case 'other-table': return '견적의 테이블 번호와 다른 상태 알림이라 반영하지 않았어요.';
    case 'bad-clock': return '기기 시계를 확인해 주세요. 시계를 읽지 못해 상태 알림을 반영하지 않았어요.';
    default: return '상태 알림을 알아보지 못했어요.';
  }
}

