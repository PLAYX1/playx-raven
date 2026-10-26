import { PlatformFeeError, splitPrice } from '../game-registry/platform-fee';

/*
 * 구매 계획 — 「누구에게 얼마를 보내고 어떤 메모를 남기나」를 정하는 **순수 함수**. (C6 통합, 2026-10-12)
 *
 * 지갑(purchase.ts checkCreatorPurchase)과 데스크탑(Rust market.rs 의 거래 검사)이 같은 계획을 본다. 이 파일은 의존이 platform-fee.ts 하나뿐이라
 * 데스크탑 저장소가 바이트 그대로 복사해 간다. 두 구현이 어긋나지 않게 **공유 벡터** core/creator/purchase-plan-vectors.json 을 양쪽이 같이 읽는다:
 *   · 지갑 시험(purchase-plan.test.ts)이 벡터의 입력 → purchasePlan() 결과와 기대 출력을 대조한다.
 *   · 데스크탑 시험(scripts/market-092.test.mjs · market.rs)이 같은 벡터에서 기대 출력을 만들어 자기 검사기(inspect_decoded 등)에 먹인다.
 * 규칙(수수료 규약 v4, docs/fee-schedule.md):
 *   · 출력 순서 = 판매자 → (수수료 > 0 일 때만) 수수료 → 메모(0 atoms). 잔돈은 계획 밖(지갑·노드가 채운다).
 *   · 수수료 = ceil(가격 × bps / 10000), 먼지 한계(1000 atoms) 미만이면 한계로 올림. 판매자 몫이 먼지면 거절. bps 0 이면 수수료 출력 없음(0 출력은 만들지 않는다).
 *   · 판매자 주소 = 수수료 주소는 요율이 0 이어도 거절한다.
 */
export type PlanInput = { priceAtoms: string; feeBps: number; sellerAddress: string; feeAddress: string; memoScript: string };
export type PlanOutput = { role: 'seller' | 'fee' | 'memo'; address: string | null; atoms: string; scriptHex?: string };
export type PurchasePlan = { outputs: PlanOutput[]; sellerAtoms: string; feeAtoms: string };
export type PurchasePlanErrorCode = 'fee-equals-seller' | 'memo-invalid' | 'price-format' | 'fee-bps' | 'price-too-small' | 'address-missing';
export class PurchasePlanError extends Error {
  constructor(readonly code: PurchasePlanErrorCode) { super(code); this.name = 'PurchasePlanError'; }
}

/** OP_RETURN 메모 스크립트 모양(6a + 길이 1바이트 + 데이터, 최대 75바이트). 데스크탑 Rust memo_ok 와 같은 규칙. */
export function memoScriptOk(script: unknown): script is string {
  if (typeof script !== 'string' || !/^6a[0-9a-f]+$/.test(script) || script.length < 8 || script.length > 4 + 75 * 2) return false;
  return parseInt(script.slice(2, 4), 16) * 2 + 4 === script.length;
}

export function purchasePlan(p: PlanInput): PurchasePlan {
  if (typeof p.sellerAddress !== 'string' || !p.sellerAddress || typeof p.feeAddress !== 'string' || !p.feeAddress) throw new PurchasePlanError('address-missing');
  if (p.sellerAddress === p.feeAddress) throw new PurchasePlanError('fee-equals-seller');
  if (!memoScriptOk(p.memoScript)) throw new PurchasePlanError('memo-invalid');
  let split;
  try { split = splitPrice(p.priceAtoms, p.feeBps); }
  catch (e) { if (e instanceof PlatformFeeError) throw new PurchasePlanError(e.code); throw e; }
  const outputs: PlanOutput[] = [{ role: 'seller', address: p.sellerAddress, atoms: String(split.sellerAtoms) }];
  if (split.feeAtoms > 0n) outputs.push({ role: 'fee', address: p.feeAddress, atoms: String(split.feeAtoms) });
  outputs.push({ role: 'memo', address: null, atoms: '0', scriptHex: p.memoScript });
  return { outputs, sellerAtoms: String(split.sellerAtoms), feeAtoms: String(split.feeAtoms) };
}
