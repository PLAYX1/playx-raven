/*
 * 플랫폼 수수료 계산 — 게임 public/commerce/platform-fee.js 와 같은 규칙의 독립 구현(계약 시험이 같은 입력으로 대조).
 *
 *   fee    = ceil(price × feeBps / 10000)   정수 atoms, 올림(플랫폼은 끝수를 잃지 않는다)
 *   seller = price − fee                    → seller + fee = 가격 정확히(구매자는 표시 가격만 낸다)
 *   feeBps = 0 → 수수료 출력 없음(같은 코드 경로. 예: 회사 자기 게임 라비 스토리)
 *   fee > 0 일 때만: 수수료가 먼지 한계(1000 atoms) 미만이면 한계로 올리고(작은 가격으로 수수료를 피할 수 없다),
 *   제작자 몫이 먼지면 'price-too-small'(그 가격은 팔 수 없다).
 *
 * 수수료율은 게임 가격표의 버전마다 feeBps 로, 수수료 주소는 서명된 등록부의 platform.feeAddresses 로 정해진다.
 * 견적·메모·거래 어디에서도 가져오지 않는다. 법률·세무 처리(수수료의 성격·신고)는 전문가 확인 필요.
 */

/** 플랫폼 몫의 상한 15% (1500 bps). 가격표 버전은 이보다 낮출 수만 있다. */
export const PLATFORM_FEE_BPS_MAX = 1500;
/** 수수료율 초안(대표가 정한다 — 게이트 feeStatus). 이 상수 하나로 초안을 바꾼다. */
export const DRAFT_PLATFORM_FEE_BPS = 1500;
/** 분할의 한쪽 출력이 가질 수 있는 최소 금액. 지갑의 RVN_DUST_THRESHOLD_SATS 와 같아야 한다(시험이 고정). */
export const OUTPUT_DUST_ATOMS = 1000;
const BPS_DENOM = 10000n;

export class PlatformFeeError extends Error {
  constructor(readonly code: 'fee-bps' | 'price-format' | 'price-too-small') { super(code); this.name = 'PlatformFeeError'; }
}

export type PriceSplit = { readonly priceAtoms: bigint; readonly feeAtoms: bigint; readonly sellerAtoms: bigint; readonly feeBps: number };

export function splitPrice(priceAtoms: bigint | number | string, feeBps: number): PriceSplit {
  if (!Number.isSafeInteger(feeBps) || feeBps < 0 || feeBps > PLATFORM_FEE_BPS_MAX) throw new PlatformFeeError('fee-bps');
  let price: bigint;
  try { price = BigInt(priceAtoms); } catch { throw new PlatformFeeError('price-format'); }
  if (price < 1n) throw new PlatformFeeError('price-format');
  if (feeBps === 0) return { priceAtoms: price, feeAtoms: 0n, sellerAtoms: price, feeBps };
  const dust = BigInt(OUTPUT_DUST_ATOMS);
  let fee = (price * BigInt(feeBps) + BPS_DENOM - 1n) / BPS_DENOM;
  if (fee < dust) fee = dust;
  const seller = price - fee;
  if (seller < dust) throw new PlatformFeeError('price-too-small');
  return { priceAtoms: price, feeAtoms: fee, sellerAtoms: seller, feeBps };
}
