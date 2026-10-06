/** 라비·게임·간식 결제용 허용목록. 조립자는 wallet.hot만 전달해야 한다. */
import type { HotPayment, HotWalletPort } from "../core/wallet-hot";

export const RAVI_WALLET_TOOLS = Object.freeze(["hot_status", "hot_pay"] as const);
export type RaviWalletTool = typeof RAVI_WALLET_TOOLS[number];
export function createRaviWalletTools(port: HotWalletPort) {
  // port 자체나 범용 invoke, 금고 factory/owner/sign 메서드를 노출하지 않는다.
  const snapshot = port.snapshot.bind(port), pay = port.pay.bind(port);
  return Object.freeze({
    async call(name: RaviWalletTool, args: unknown = undefined): Promise<unknown> {
      // 타입을 우회한 AI JSON/JS 요청도 같은 허용목록으로 거부한다.
      if (!(RAVI_WALLET_TOOLS as readonly unknown[]).includes(name)) throw new Error("TOOL_DENIED");
      if (name === "hot_status") {
        if (args !== undefined) throw new Error("INVALID_ARGUMENTS");
        return snapshot();
      }
      if (!args || typeof args !== "object" || Array.isArray(args)
        || Object.keys(args).sort().join(",") !== "amount,fee,to") throw new Error("INVALID_ARGUMENTS");
      const raw = args as Record<string, unknown>;
      // JSON 경계의 원자 단위 정수 문자열만 허용. float/지수/음수/임의 필드 금지.
      if (typeof raw.to !== "string" || typeof raw.amount !== "string" || typeof raw.fee !== "string"
        || !/^[1-9][0-9]{0,29}$/.test(raw.amount) || !/^(0|[1-9][0-9]{0,29})$/.test(raw.fee))
        throw new Error("INVALID_ARGUMENTS");
      const payment: HotPayment = Object.freeze({ to: raw.to, amount: BigInt(raw.amount), fee: BigInt(raw.fee) });
      return pay(payment);
    },
  });
}
