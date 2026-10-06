/** 데스크톱 조립 경계. main/네이티브 연결 없음; 모의 서명기만 허용한다. */
import { newLedger, rollDay, reserveHot, paymentTotal, nonnegative, transition } from "../core/wallet-vault";
import type { Policy, Transfer, Stage, Ledger } from "../core/wallet-vault";
import type { HotPayment, HotWalletPort, HotResult, SandboxNetwork } from "../core/wallet-hot";

export type MockSignature = Readonly<{ kind: "mock-signature"; requestId: string }>;
/** 비밀번호·생체 정보·시드·개인키를 주고받는 API는 의도적으로 없다. */
export interface VaultSigner {
  readonly mode: "mock";
  sign(transfer: Transfer): Promise<MockSignature>;
}
export interface HotSigner {
  readonly mode: "mock";
  sign(transfer: Transfer & { source: "hot"; purpose: "payment" }): Promise<MockSignature>;
}
export type VaultOptions = Readonly<{
  network: SandboxNetwork; policy: Policy; hotAddress: string; vaultAddress: string;
  hotBalance: bigint; vaultBalance: bigint; now(): number;
  hotSigner: HotSigner; vaultSigner: VaultSigner;
  /** 신뢰된 소유자 UI/OS 인증 경계만 주입. AI의 true/approved 필드를 넘기지 않는다. */
  authenticate(transfer: Transfer): Promise<boolean>;
}>;
export interface VaultOwnerPort {
  watch(): Readonly<{ address: string; available: bigint; watchOnly: true }>;
  prepare(purpose: "payment" | "topup", payment: HotPayment): Transfer;
  approveAndSign(id: string): Promise<Stage>;
  cancel(id: string): Stage;
  stage(id: string): Stage;
}
export interface WalletVault { readonly hot: HotWalletPort; readonly owner: VaultOwnerPort }

export function createWalletVault(options: VaultOptions): WalletVault {
  // 입력 옵션/정책을 나중에 변조해도 기존 세션의 권한과 한도는 바뀌지 않는다.
  const { network, hotAddress, vaultAddress, now, authenticate } = options;
  if (network !== "mock" && network !== "testnet") throw new Error("SANDBOX_ONLY");
  if (options.hotSigner.mode !== "mock" || options.vaultSigner.mode !== "mock") throw new Error("MOCK_SIGNER_ONLY");
  const hotSign = options.hotSigner.sign.bind(options.hotSigner);
  const vaultSign = options.vaultSigner.sign.bind(options.vaultSigner);
  paymentTotal({ to: hotAddress, amount: 1n, fee: 0n });
  paymentTotal({ to: vaultAddress, amount: 1n, fee: 0n });
  if (hotAddress === vaultAddress) throw new Error("SEPARATE_WALLETS_REQUIRED");
  const policy = Object.freeze({ ...options.policy });
  let hotBalance = options.hotBalance, vaultBalance = options.vaultBalance;
  nonnegative(hotBalance); nonnegative(vaultBalance);
  let ledger: Ledger = newLedger(now(), policy);
  let serial = 0;
  const requests = new Map<string, { transfer: Transfer; stage: Stage }>();
  const tick = () => { const time = now(); ledger = rollDay(ledger, time, policy); return time; };
  const get = (id: string) => {
    const request = requests.get(id);
    if (!request) throw new Error("UNKNOWN_REQUEST");
    return request;
  };
  const expire = (request: { transfer: Transfer; stage: Stage }, time: number) => {
    if ((request.stage === "review" || request.stage === "authenticating") && time >= request.transfer.expiresAt)
      request.stage = transition(request.stage, "expire");
  };
  const validReceipt = (receipt: MockSignature, transfer: Transfer) => {
    if (!receipt || receipt.kind !== "mock-signature" || receipt.requestId !== transfer.id)
      throw new Error("INVALID_RECEIPT");
  };
  const hot: HotWalletPort = Object.freeze({
    snapshot() {
      tick();
      return Object.freeze({ available: hotBalance, spentToday: ledger.spent,
        remainingToday: policy.daily > ledger.spent ? policy.daily - ledger.spent : 0n,
        perPayment: policy.perPayment, daily: policy.daily, day: ledger.day, utcOffsetMinutes: policy.utcOffsetMinutes });
    },
    async pay(input: HotPayment): Promise<HotResult> {
      paymentTotal(input);
      const payment = Object.freeze({ to: input.to, amount: input.amount, fee: input.fee });
      const time = tick();
      const reserved = reserveHot(policy, ledger, hotBalance, payment, time);
      ledger = reserved.ledger;
      if (reserved.decision !== "allow") return Object.freeze({
        status: reserved.decision === "balance" ? "needs_topup" : "needs_vault_approval", reason: reserved.decision,
      });
      // 첫 await 이전 예약: 동시 호출/더블클릭도 같은 잔액과 일일 한도를 공유한다.
      hotBalance = reserved.available;
      const transfer = Object.freeze({ ...payment, id: `hot-${++serial}`, network, source: "hot" as const,
        purpose: "payment" as const, expiresAt: time + 120_000 });
      try { validReceipt(await hotSign(transfer), transfer); return Object.freeze({ status: "signed" }); }
      catch { return Object.freeze({ status: "failed", reason: "signer" }); }
    },
  });
  const owner: VaultOwnerPort = Object.freeze({
    watch() { return Object.freeze({ address: vaultAddress, available: vaultBalance, watchOnly: true as const }); },
    prepare(purpose: "payment" | "topup", input: HotPayment) {
      const total = paymentTotal(input);
      if (purpose !== "payment" && purpose !== "topup") throw new Error("INVALID_PURPOSE");
      if (purpose === "topup" && input.to !== hotAddress) throw new Error("TOPUP_DESTINATION");
      if (total > vaultBalance) throw new Error("VAULT_BALANCE");
      const transfer: Transfer = Object.freeze({ to: input.to, amount: input.amount, fee: input.fee,
        id: `vault-${++serial}`, network, source: "vault", purpose, expiresAt: tick() + 120_000 });
      requests.set(transfer.id, { transfer, stage: "review" });
      return transfer;
    },
    async approveAndSign(id: string): Promise<Stage> {
      const request = get(id);
      expire(request, tick());
      request.stage = transition(request.stage, "authenticate");
      let authorized = false;
      try { authorized = (await authenticate(request.transfer)) === true; } catch { /* 오류 원문에는 인증 정보가 있을 수 있다. */ }
      try { expire(request, tick()); } catch {
        if (request.stage === "authenticating") request.stage = transition(request.stage, "fail");
        return request.stage;
      }
      // 인증 대기 중 취소/만료되면 서명하지 않는다. 인증 결과는 다른 요청에 재사용 불가.
      if (request.stage !== "authenticating") return request.stage;
      if (!authorized) return request.stage = transition(request.stage, "fail");
      const total = request.transfer.amount + request.transfer.fee;
      if (total > vaultBalance) return request.stage = transition(request.stage, "fail");
      request.stage = transition(request.stage, "authorize");
      vaultBalance -= total;
      try {
        validReceipt(await vaultSign(request.transfer), request.transfer);
        request.stage = transition(request.stage, "complete");
      } catch { request.stage = transition(request.stage, "fail"); }
      // 서명 ≠ 입금 확정. 금고→핫 서명 성공만으로 핫 잔액을 늘리지 않는다.
      return request.stage;
    },
    cancel(id: string) {
      const request = get(id); expire(request, tick());
      return request.stage = transition(request.stage, "cancel");
    },
    stage(id: string) { const request = get(id); expire(request, tick()); return request.stage; },
  });
  return Object.freeze({ hot, owner });
}
