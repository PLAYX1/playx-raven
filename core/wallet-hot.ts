/** AI·게임에 전달할 수 있는 유일한 지갑 capability. 금고 타입/서명기는 없다. */
export type SandboxNetwork = "mock" | "testnet";
export type HotPayment = Readonly<{ to: string; amount: bigint; fee: bigint }>;
export type HotSnapshot = Readonly<{
  available: bigint; spentToday: bigint; remainingToday: bigint;
  perPayment: bigint; daily: bigint; day: number; utcOffsetMinutes: number;
}>;
export type HotResult = Readonly<{
  status: "signed" | "needs_vault_approval" | "needs_topup" | "failed";
  reason?: "per_payment" | "daily" | "balance" | "signer";
}>;
export interface HotWalletPort {
  snapshot(): HotSnapshot;
  pay(payment: HotPayment): Promise<HotResult>;
}
