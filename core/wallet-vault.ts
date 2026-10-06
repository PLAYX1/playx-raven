/** 순수 정책 코어: 시계·저장소·DOM·RPC·시드·암호 라이브러리 의존성 없음. */
import type { HotPayment, SandboxNetwork } from "./wallet-hot";

export type Policy = Readonly<{ perPayment: bigint; daily: bigint; utcOffsetMinutes: number }>;
export type Ledger = Readonly<{ day: number; lastNow: number; spent: bigint }>;
export type Decision = "allow" | "per_payment" | "daily" | "balance";
export type Transfer = Readonly<HotPayment & {
  id: string; network: SandboxNetwork; source: "hot" | "vault";
  purpose: "payment" | "topup"; expiresAt: number;
}>;
export type Stage = "review" | "authenticating" | "signing" | "signed" | "failed" | "cancelled" | "expired";
export type Event = "authenticate" | "authorize" | "complete" | "fail" | "cancel" | "expire";

export function nonnegative(value: bigint): void {
  if (typeof value !== "bigint" || value < 0n) throw new Error("INVALID_AMOUNT");
}
export function validatePolicy(p: Policy): void {
  nonnegative(p.perPayment); nonnegative(p.daily);
  if (p.perPayment > p.daily || !Number.isInteger(p.utcOffsetMinutes)
    || p.utcOffsetMinutes < -720 || p.utcOffsetMinutes > 840) throw new Error("INVALID_POLICY");
}
export function dayAt(now: number, offset: number): number {
  if (!Number.isSafeInteger(now) || now < 0 || now > 8_000_000_000_000_000
    || !Number.isInteger(offset) || offset < -720 || offset > 840) throw new Error("INVALID_CLOCK");
  return Math.floor((now + offset * 60_000) / 86_400_000);
}
export function newLedger(now: number, policy: Policy): Ledger {
  validatePolicy(policy);
  return Object.freeze({ day: dayAt(now, policy.utcOffsetMinutes), lastNow: now, spent: 0n });
}
export function rollDay(ledger: Ledger, now: number, policy: Policy): Ledger {
  validatePolicy(policy); nonnegative(ledger.spent);
  const day = dayAt(now, policy.utcOffsetMinutes);
  if (!Number.isSafeInteger(ledger.lastNow) || ledger.day !== dayAt(ledger.lastNow, policy.utcOffsetMinutes)
    || now < ledger.lastNow || day < ledger.day) throw new Error("CLOCK_ROLLBACK");
  return Object.freeze({ day, lastNow: now, spent: day > ledger.day ? 0n : ledger.spent });
}
export function paymentTotal(payment: HotPayment): bigint {
  if (!payment || typeof payment !== "object" || Array.isArray(payment)
    || Object.keys(payment).sort().join(",") !== "amount,fee,to") throw new Error("INVALID_PAYMENT");
  nonnegative(payment.amount); nonnegative(payment.fee);
  if (payment.amount === 0n || typeof payment.to !== "string"
    || !/^[A-Za-z0-9:_-]{1,128}$/.test(payment.to)) throw new Error("INVALID_PAYMENT");
  return payment.amount + payment.fee;
}
export function decideHot(policy: Policy, ledger: Ledger, available: bigint, payment: HotPayment): Decision {
  validatePolicy(policy); nonnegative(ledger.spent); nonnegative(available);
  const total = paymentTotal(payment);
  if (total > policy.perPayment) return "per_payment";
  if (ledger.spent + total > policy.daily) return "daily";
  return total > available ? "balance" : "allow";
}
/** 서명 전에 금액+수수료를 예약한다. 실패/불확실도 보수적으로 당일 합계에 남긴다. */
export function reserveHot(policy: Policy, ledger: Ledger, available: bigint, payment: HotPayment, now: number) {
  const current = rollDay(ledger, now, policy);
  const decision = decideHot(policy, current, available, payment);
  if (decision !== "allow") return Object.freeze({ decision, ledger: current, available });
  const total = paymentTotal(payment);
  return Object.freeze({ decision, ledger: Object.freeze({ ...current, spent: current.spent + total }), available: available - total });
}
export function transition(stage: Stage, event: Event): Stage {
  const edges: Partial<Record<Stage, Partial<Record<Event, Stage>>>> = {
    review: { authenticate: "authenticating", cancel: "cancelled", expire: "expired" },
    authenticating: { authorize: "signing", fail: "failed", cancel: "cancelled", expire: "expired" },
    signing: { complete: "signed", fail: "failed" },
  };
  const row = Object.prototype.hasOwnProperty.call(edges, stage) ? edges[stage] : undefined;
  const next = row && Object.prototype.hasOwnProperty.call(row, event) ? row[event] : undefined;
  if (!next) throw new Error("INVALID_TRANSITION");
  return next;
}
