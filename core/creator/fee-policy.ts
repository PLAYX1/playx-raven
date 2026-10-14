import {
  FEE_TRACK_FORMAT, INCREASE_DELAY_BLOCKS, MIN_FEE_OUTPUT_ATOMS, PRODUCT_FEE_CAP_ATOMS, ProductError, feeAmount, type FeeReceipt, type OrderLine, type ProductBody, type ProductFee,
} from './product-doc';
import { atomsToRvn, plain, type Loose } from './bytes';
import {
  FEE_KINDS, FEE_TRACK_V2_VERSION, feeKindOf, isClosedFeeKind, isVerifiedFeeTrackV2, kindBpsAtV2, nextKindChangeV2, productFeeV2, validateFeeTrackV2,
  type FeeKind, type FeeStepV2, type FeeTrackV2,
} from './fee-track-v2';
import { MARKET_FEE_BPS_CEILING } from './trade-primitives';

/*
 * 수수료 정책(fee policy) — 결정문 §14-3 · §14-7 · §16 · §18 (2026-10-13). 순수 함수만 있다(서버 조회·네트워크·시계 없음).
 *
 * 한 곳 원칙(§18 「예고 문구·미리보기·실제 계산은 한 함수」): 구매 출력·영수증·예고 문구는 모두 quoteFee 하나에서 나온다.
 *   요율은 서명된 종류별 일정(fee-track-v2.ts, rv-fee-track v2) 하나가 정하고, 산식(내림·상한 500 RVN·면제선)은 product-doc.ts feeAmount 하나다.
 *   금액 기준 = 주문 총액(단가 × 수량 + 배송비, §29 ① 7/7) — 예정 수수료·영수증도 같은 총액(fee.totalAtoms)으로 센다.
 *   이 파일은 ① 종류별 후보 상한표(2차 안전망, 낮추기만) ② 징수 개시 규칙(feeActivation, §18 Q2) ③ 외부 독립 판매자 집계 ④ 표시값·문구만 더한다.
 *
 * 시작 방식(§20 A, 대표 확정 2026-10-13): 출시 첫날부터 서명된 일정의 요율(예: 디지털 1%)을 걷는다(FEE_START_POLICY = 'day-one').
 *   §18 Q2 관문(출시+183일·외부 독립 판매자 30명)은 끌 수 있는 명시 옵션('gated')으로 남겼다.
 *   단 징수는 **서명 확인된 일정**(fee-track-v2.ts isVerifiedFeeTrackV2)이 들어왔을 때만 — 첫 일정 서명·운영 키 등록은 대표 승인이고,
 *   운영 키가 빈 출하 상태에서는 어떤 일정도 검증되지 않으므로 실제 요율은 0 이다.
 * 옛 규칙(fee-schedule.ts 5%/2.5%/3%/티켓 5%, 구매자 가산, platform-fee.ts)은 import 하지 않는다(fee-guard.test.ts).
 */

/* ── 상수 ─────────────────────────────────────────────────────────── */

/** 건당 상한 500 RVN. */
export const FEE_CAP_ATOMS = PRODUCT_FEE_CAP_ATOMS;
/** 면제선 0.01 RVN — 시험망 실측 반영(대표 승인 10-14, docs/testnet-measure). 값은 product-doc.ts 한 곳. */
export { MIN_FEE_OUTPUT_ATOMS };
/** 인상 예고 = 징수 개시 대기 = 약 6개월(183일 환산 블록, 기존 상수). */
export const FEE_INCREASE_DELAY_BLOCKS = INCREASE_DELAY_BLOCKS;
/** 일정에 공지가 없는 종류의 출시 요율. */
export const LAUNCH_BPS = 0;
/**
 * 수수료 시작 방식. 'day-one' = §20 A(출시 첫날 일정 요율, 대표 확정·7모델 동의) — 기본.
 * 'gated' = §18 Q2(출시+약 6개월 예정일 + 외부 독립 판매자 30명, 미달이면 30명 된 높이부터 6개월 예고). 켜려면 명시적으로 넘긴다.
 */
export type FeeStartPolicy = 'day-one' | 'gated';
export const FEE_START_POLICY: FeeStartPolicy = 'day-one';
/** 외부 독립 판매자(대표 관계자 제외) 이 수 이상이어야 징수를 시작한다(§14-7·§18 Q2). */
export const MIN_INDEPENDENT_SELLERS = 30;

export type { FeeKind } from './fee-track-v2';
export { feeKindOf } from './fee-track-v2';

/* ── 종류별 후보 상한표(2차 안전망) ───────────────────────────────── */

export type FeeCandidate = {
  /** 재검토 통과 후 후보(bps). 범위 후보(공동구매 1~2%)는 min..max. 적용 상한으로는 max 를 쓴다. */
  minBps: number; maxBps: number;
  /** 닫힌 구역 = 영구 0%(징수하지 않음). */
  closed: boolean;
  /** 안내 문구(한국어). */
  label: string;
};

/** §14-3 「재검토 통과 후 후보」 = 서명된 일정이 넘을 수 없는 상한(낮추기만, §18 Q1). 지금 적용값이 아니다. */
export const FEE_CANDIDATES: Readonly<Record<FeeKind, Readonly<FeeCandidate>>> = Object.freeze({
  digital: Object.freeze({ minBps: 300, maxBps: 300, closed: false, label: '디지털' }),
  game: Object.freeze({ minBps: 300, maxBps: 300, closed: false, label: '게임·앱' }),
  ticket: Object.freeze({ minBps: 300, maxBps: 300, closed: false, label: '티켓·한정판 1차' }),
  pos: Object.freeze({ minBps: 100, maxBps: 100, closed: false, label: '상점 POS' }),
  sdk: Object.freeze({ minBps: 100, maxBps: 100, closed: false, label: '개발자 SDK' }),
  groupbuy: Object.freeze({ minBps: 100, maxBps: 200, closed: false, label: '공동구매' }),
  // 2026-10-14 대표: 중고·2차 거래도 판매 = 1%(결정문 §32, 옛 「used/transfer 0%」 대체). 송금만 닫힌 구역.
  used: Object.freeze({ minBps: 100, maxBps: 100, closed: false, label: '중고·동네' }),
  secondary: Object.freeze({ minBps: 100, maxBps: 100, closed: false, label: '2차 거래' }),
  transfer: Object.freeze({ minBps: 0, maxBps: 0, closed: true, label: '송금' }),
  // 2026-10-14 대표: 기타도 판매 = 1%(결정문 §33). 표에 없는 정상 상품 kind 는 feeKindOf 가 기타로 분류한다.
  other: Object.freeze({ minBps: 100, maxBps: 100, closed: false, label: '기타' }),
});

/** 종류의 후보 상한(bps). 닫힌 구역·모양이 깨진 kind(null)는 0. */
export const candidateCeilingBps = (kind: FeeKind | null): number =>
  kind === null || FEE_CANDIDATES[kind].closed || isClosedFeeKind(kind) ? 0 : FEE_CANDIDATES[kind].maxBps;

/* ── 출시 일정(v2) ────────────────────────────────────────────────── */

/**
 * 출시 일정(서명 전 초안 — 서명은 대표 도구 signFeeTrackV2). announce(예: { digital: 100 })가 없는 종류는 출시 높이에 0%.
 *   start 'day-one'(기본, §20 A): 공지한 종류는 **첫 단계 자체가 그 요율**로 출시 높이에 시행(fee-track-v2.ts 첫 단계 예외 'initial-rate').
 *   start 'gated'(§14-7 옛 안): 출시 높이에 0% 를 두고 출시 + 약 6개월에 시행되는 인상 단계를 덧붙인다.
 * 닫힌 구역에 0 보다 큰 값을 넣으면 거절.
 */
export function launchFeeTrackV2(launchHeight: number, announce: Partial<Record<FeeKind, number>> = {}, opts: { start?: FeeStartPolicy } = {}): FeeTrackV2 {
  const start = opts.start ?? FEE_START_POLICY;
  if (start !== 'day-one' && start !== 'gated') throw new Error('unknown fee start policy');
  const ann = (kind: FeeKind): number | null => {
    const bps = announce[kind];
    if (bps === undefined || bps === LAUNCH_BPS) return null;
    if (isClosedFeeKind(kind)) throw new Error(`closed kind cannot be announced: ${kind}`);
    return bps;
  };
  const steps: FeeStepV2[] = FEE_KINDS.map(kind => ({ kind, bps: start === 'day-one' ? ann(kind) ?? LAUNCH_BPS : LAUNCH_BPS, announcedHeight: launchHeight, effectiveHeight: launchHeight }));
  if (start === 'gated') for (const kind of FEE_KINDS) {
    const bps = ann(kind);
    if (bps !== null) steps.push({ kind, bps, announcedHeight: launchHeight, effectiveHeight: launchHeight + INCREASE_DELAY_BLOCKS });
  }
  return validateFeeTrackV2({ format: FEE_TRACK_FORMAT, version: FEE_TRACK_V2_VERSION, steps });
}

/* ── 외부 독립 판매자 집계(§18 Q2) ─────────────────────────────────── */

/** 체인에서 누구나 다시 만들 수 있는 거래 기록(조회 코드는 호출 측). completed = 결제 확인 완료. height = 거래가 들어간 블록 높이('gated' 판정에 필수). */
export type SaleRecord = { sellerKey: string; buyerKey: string; completed: boolean; height?: number };

/**
 * 외부 독립 판매자 수 = 서로 다른 구매자 키에게 완료한 거래가 있는 서로 다른 판매자 키의 수.
 *   · 판매자 = 구매자(자기 거래)는 세지 않는다. 같은 판매자-구매자 쌍은 몇 번 팔아도 1건.
 *   · 제외 목록(대표 관계자, 출시 전 1회 서명·이후 추가만 — 서명 확인은 호출 측)의 키는 판매자로도 구매자로도 세지 않는다
 *     (관계자가 사 주어 숫자를 채우는 것을 막는다).
 *   · minBuyersPerSeller(기본 1): 판매자마다 서로 다른 구매자가 이만큼 있어야 1명으로 센다.
 *   · 모양이 틀린 기록은 건너뛴다.
 */
export function countIndependentSellers(records: readonly unknown[], excludedKeys: Iterable<string> = [], opts: { minBuyersPerSeller?: number; atHeight?: number } = {}): number {
  const min = Number.isSafeInteger(opts.minBuyersPerSeller) && (opts.minBuyersPerSeller as number) >= 1 ? (opts.minBuyersPerSeller as number) : 1;
  const buyers = new Map<string, Set<string>>();
  for (const r of cleanSales(records, new Set(excludedKeys), opts.atHeight)) {
    if (!buyers.has(r.sellerKey)) buyers.set(r.sellerKey, new Set());
    (buyers.get(r.sellerKey) as Set<string>).add(r.buyerKey);
  }
  let n = 0;
  for (const set of buyers.values()) if (set.size >= min) n++;
  return n;
}

const okHeight = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0 && n <= 1_000_000_000;
/** 셀 수 있는 기록만(완료·서로 다른 키·제외 목록 밖). atHeight 를 주면 높이가 있고 그 높이 이하인 기록만. */
function cleanSales(records: readonly unknown[], excluded: ReadonlySet<string>, atHeight?: number): Required<SaleRecord>[] {
  const out: Required<SaleRecord>[] = [];
  for (const r of Array.isArray(records) ? records : []) {
    if (!r || typeof r !== 'object') continue;
    const { sellerKey, buyerKey, completed, height } = r as Partial<SaleRecord>;
    if (completed !== true || typeof sellerKey !== 'string' || typeof buyerKey !== 'string' || !sellerKey || !buyerKey) continue;
    if (sellerKey === buyerKey || excluded.has(sellerKey) || excluded.has(buyerKey)) continue;
    if (atHeight !== undefined && (!okHeight(height) || height > atHeight)) continue;
    out.push({ sellerKey, buyerKey, completed, height: okHeight(height) ? height : -1 });
  }
  return out;
}

/**
 * 외부 독립 판매자 수가 처음 min 명 이상이 된 높이(upTo 이하 기록만). 없으면 null. 기록(체인)만으로 정해진다 — 호출 측이 보관한 상태를 쓰지 않는다.
 * 기록은 덧붙기만 하므로 이 높이는 새 기록으로 앞당겨지지 않는다(제외 목록 추가는 소급 적용 = 늦어지는 쪽).
 */
export function independentSellersReachedAt(records: readonly unknown[], excludedKeys: Iterable<string>, opts: { min: number; upTo: number; minBuyersPerSeller?: number }): number | null {
  const per = Number.isSafeInteger(opts.minBuyersPerSeller) && (opts.minBuyersPerSeller as number) >= 1 ? (opts.minBuyersPerSeller as number) : 1;
  if (!okHeight(opts.upTo) || !Number.isSafeInteger(opts.min) || opts.min < 1) return null;
  const sales = cleanSales(records, new Set(excludedKeys), opts.upTo).sort((a, b) => a.height - b.height);
  const buyers = new Map<string, Set<string>>();
  let n = 0;
  for (let i = 0; i < sales.length; i++) {
    const r = sales[i];
    if (!buyers.has(r.sellerKey)) buyers.set(r.sellerKey, new Set());
    const set = buyers.get(r.sellerKey) as Set<string>;
    const before = set.size;
    set.add(r.buyerKey);
    if (before < per && set.size >= per) n++;
    // 같은 높이의 기록을 다 넣은 뒤에 판정한다.
    if (n >= opts.min && (i === sales.length - 1 || sales[i + 1].height !== r.height)) return r.height;
  }
  return null;
}

/* ── 징수 개시 규칙(§20 A 기본 · §18 Q2 옵션) ─────────────────────── */

export type ActivationPhase = 'pre-launch-window' | 'active' | 'notice' | 'postponed';
export type FeeActivation = {
  /** 0 또는 scheduledBps. 'active' 일 때만 scheduledBps. quoteFee 는 이 값을 적용 요율의 상한으로 쓴다. */
  appliedBps: number;
  phase: ActivationPhase;
  /** 예고 시작 높이(30명이 된 높이). 'gated' 의 'notice' 와 그 뒤 'active' 에서만. */
  noticeFromHeight?: number;
  /** 적용(예정) 높이. 'pre-launch-window' = 시작 예정 높이, 'notice' = 예고 끝, 'active' = 실제 적용 높이. */
  effectiveHeight?: number;
  reason: string;
};

/**
 * 징수 개시 판정(순수). 입력은 **체인에서 누구나 다시 만들 수 있는 값만** 받는다(높이·출시 높이·거래 기록·서명된 제외 목록).
 * 호출 측이 보관한 「직전 판정」「30명 된 높이」 같은 상태는 받지 않는다 — 같은 체인이면 누구나 같은 결과(조작·기기 차이 없음).
 *
 * policy 'day-one'(기본, §20 A): 출시 높이부터 'active'(scheduledBps). 출시 전 = 'pre-launch-window'.
 * policy 'gated'(§18 Q2, 명시 옵션):
 *   ① 출시 + 6개월(예정일 S) 전 = 'pre-launch-window', 0.
 *   ② 외부 독립 판매자가 처음 30명 이상이 된 높이 R(sales 로 계산, independentSellersReachedAt)이 S 이하 → S 에 적용('active').
 *   ③ R 이 없으면 'postponed'. R > S 면 R 부터 6개월 예고('notice') → R + 6개월에 'active'.
 *   기록은 덧붙기만 하므로 R 은 한 번 정해지면 새 기록으로 바뀌지 않고, 'active' 는 되돌아가지 않는다(오락가락 방지).
 *   (옛 「예고 중 30명 밑으로 내려가면 취소」는 기록이 줄지 않으므로 생기지 않는다. 제외 목록 추가는 소급 적용 = 늦어지는 쪽.)
 * scheduledBps = 공개한 요율 상한(기본 5% 천장 — 실제 요율은 서명된 일정·문서·종류 상한이 정한다). 0..천장 밖이면 0.
 */
export function feeActivation(p: {
  height: number; launchHeight: number; scheduledBps?: number; policy?: FeeStartPolicy;
  sales?: readonly unknown[]; excludedKeys?: Iterable<string>; minSellers?: number; minBuyersPerSeller?: number; delayBlocks?: number;
}): FeeActivation {
  const policy = p.policy ?? FEE_START_POLICY;
  const delay = okHeight(p.delayBlocks) && p.delayBlocks > 0 ? p.delayBlocks : INCREASE_DELAY_BLOCKS;
  const min = okHeight(p.minSellers) && p.minSellers >= 1 ? p.minSellers : MIN_INDEPENDENT_SELLERS;
  const sched = p.scheduledBps === undefined ? MARKET_FEE_BPS_CEILING : okHeight(p.scheduledBps) && p.scheduledBps <= MARKET_FEE_BPS_CEILING ? p.scheduledBps : 0;
  if (!okHeight(p.height) || !okHeight(p.launchHeight) || (policy !== 'day-one' && policy !== 'gated')) return { appliedBps: 0, phase: 'pre-launch-window', reason: 'invalid-input' };
  const h = p.height;
  if (policy === 'day-one') {
    if (h < p.launchHeight) return { appliedBps: 0, phase: 'pre-launch-window', effectiveHeight: p.launchHeight, reason: 'before-launch' };
    return { appliedBps: sched, phase: 'active', effectiveHeight: p.launchHeight, reason: 'day-one' };
  }
  const S = p.launchHeight + delay;
  if (h < S) return { appliedBps: 0, phase: 'pre-launch-window', effectiveHeight: S, reason: 'before-scheduled-date' };
  const R = independentSellersReachedAt(p.sales ?? [], p.excludedKeys ?? [], { min, upTo: h, minBuyersPerSeller: p.minBuyersPerSeller });
  if (R === null) return { appliedBps: 0, phase: 'postponed', reason: 'below-min-sellers' };
  if (R <= S) return { appliedBps: sched, phase: 'active', effectiveHeight: S, reason: 'met-on-scheduled-date' };
  const eff = R + delay;
  if (h >= eff) return { appliedBps: sched, phase: 'active', noticeFromHeight: R, effectiveHeight: eff, reason: 'notice-complete' };
  return { appliedBps: 0, phase: 'notice', noticeFromHeight: R, effectiveHeight: eff, reason: 'notice-running' };
}

/* ── 견적·영수증·예고 문구(한 함수) ──────────────────────────────── */

export type DeliveryMethod = 'store' | 'courier';
/** 견적 주문 줄: 수량 + 수령 방식. shippingAtoms 는 넘기지 않아도 된다(넘기면 문서 값과 대조만). */
export type QuoteOrderLine = OrderLine & { delivery?: DeliveryMethod };

/**
 * 서명된 상품 문서의 배송 줄(x.groupbuy.delivery = { methods, shippingAtoms }) → 이 주문의 배송비(atoms).
 * product-ext productShareSplit 과 같은 규칙: 공동구매 — 방식 생략은 방식이 하나일 때만(그 방식), 문서에 없는 방식은 거절, courier = 서명된 배송비, store = 0.
 * 공동구매가 아닌 문서 — 배송 줄 없음 = 0(방식은 생략 또는 'store'만).
 * 모양 검사는 최소(이 파일은 product-ext 를 import 하지 않는다 — 전체 검사는 verifyProductDocExt). 틀리면 'order-shipping'.
 */
export function docShippingAtoms(doc: ProductBody, delivery?: DeliveryMethod): bigint {
  const g = doc.x !== undefined && plain(doc.x) && Object.prototype.hasOwnProperty.call(doc.x, 'groupbuy') ? (doc.x as Loose).groupbuy : undefined;
  if (g === undefined) {
    if (delivery !== undefined && delivery !== 'store') throw new ProductError('order-shipping', 'method-not-offered');
    return 0n;
  }
  const dl = plain(g) ? (g as Loose).delivery : null;
  const methods: unknown = plain(dl) ? dl.methods : null;
  if (!Array.isArray(methods) || methods.length < 1 || methods.some(m => m !== 'store' && m !== 'courier')) throw new ProductError('order-shipping', 'shape');
  if (delivery === undefined && methods.length > 1) throw new ProductError('order-shipping', 'delivery-required');
  const method = delivery ?? (methods[0] as DeliveryMethod);
  if (!methods.includes(method)) throw new ProductError('order-shipping', 'method-not-offered');
  if (method === 'store') return 0n;
  const ship = (dl as Loose).shippingAtoms;
  if (typeof ship !== 'string' || !/^(0|[1-9]\d{0,17})$/.test(ship)) throw new ProductError('order-shipping', 'shape');
  return BigInt(ship);
}

export type WaiveReason = 'none' | 'zero-rate' | 'unverified-track' | 'pre-launch-window' | 'postponed' | 'notice' | 'below-min-output' | 'closed-kind' | 'unknown-kind' | 'kind-ceiling';
export type FeeQuote = {
  feeKind: FeeKind | null;
  /** 지금 실제로 걷는 요율·금액(거래 출력에 쓰는 값). fee 는 productFeeV2 결과. */
  appliedBps: number; fee: ProductFee;
  /** 일정만 보면(개시 규칙·종류 상한 전) 지금 요율. */
  trackBps: number;
  /** 공개된 다음 요율(문서 feeBps·종류 상한 적용 후)과 그 적용 높이(모르면 null). 없으면 null. */
  scheduledBps: number | null; scheduledFromHeight: number | null;
  /** 예정 요율로 계산한 이 주문(총액)의 실제 수수료(내림·상한·면제선 적용, atoms). */
  scheduledFeeAtoms: string | null;
  activation: FeeActivation;
  /** 지금 수수료가 0 인 이유(화면 문구 선택용). 0 이 아니면 'none'. */
  waiveReason: WaiveReason;
  /** 영수증 표시값: 공개 예정 요율이 있고 지금 면제 중이면 그 요율로 산출한 값 + exempt:true + 실제 0. */
  receipt: FeeReceipt;
};

/**
 * 구매 시점 수수료 + 영수증 + 예고 표시값. height = 구매 시 팁 + 1, 기록 판정 시 포함 블록. activation = feeActivation 결과.
 * 적용 요율 = 일정이 **서명 확인된 것**(verifyFeeTrackV2 가 돌려준 객체, isVerifiedFeeTrackV2)이고 activation 이 'active' 일 때만
 *   min(문서 feeBps, 종류 일정 요율, 종류 후보 상한, activation.appliedBps), 아니면 0. 검증 안 된 일정이면 예정 요율도 보여 주지 않는다('unverified-track').
 * order = 수량(기본 1)·수령 방식. 배송비는 **서명된 문서의 배송 줄**(docShippingAtoms, 분할 productShareSplit 과 같은 규칙)에서 읽는다(GAP-4) —
 *   호출자가 shippingAtoms 를 함께 넘기면 문서 값과 같아야 하고, 다르면 'order-shipping: shipping-mismatch' 로 거절(화면 견적 ≠ 실제 출력 방지).
 * 수수료·예정 수수료·영수증 모두 주문 총액 기준(공유 분할 computeShareSplit 과 같은 orderFee 경로).
 * 오류는 productFeeV2 와 같다(track-mismatch · track-mixed · track-version · price-too-small) + 배송 줄 오류(order-shipping).
 */
export function quoteFee(p: { doc: ProductBody; track: FeeTrackV2; height: number; activation: FeeActivation; order?: QuoteOrderLine }): FeeQuote {
  const feeKind = feeKindOf(p.doc.kind);
  const ceiling = candidateCeilingBps(feeKind);
  const verified = isVerifiedFeeTrackV2(p.track);
  const open = verified && !!p.activation && p.activation.phase === 'active';
  const shippingAtoms = docShippingAtoms(p.doc, p.order?.delivery);
  if (p.order?.shippingAtoms !== undefined && p.order.shippingAtoms !== shippingAtoms) throw new ProductError('order-shipping', 'shipping-mismatch');
  const line = { qty: p.order?.qty, shippingAtoms };
  const base = productFeeV2({ doc: p.doc, track: p.track, height: p.height, ...line });
  const trackBps = base.scheduleBps;
  // 적용 요율 = min(문서 feeBps, 종류 적용 요율) — 종류 규칙은 kindAppliedBps 한 곳(매장 견적과 같은 함수).
  const appliedBps = Math.min(p.doc.feeBps, kindAppliedBps({ kind: feeKind, track: p.track, height: p.height, activation: p.activation }));
  const fee = appliedBps === base.bps ? base : productFeeV2({ doc: { ...p.doc, feeBps: appliedBps }, track: p.track, height: p.height, ...line });
  const total = BigInt(fee.totalAtoms);

  // 공개 예정: 개시 전이면 개시 높이(모르면 지금)의 일정 요율, 개시 뒤면 일정의 다음 변경.
  let sched: { height: number | null; bps: number } | null = null;
  if (feeKind !== null && verified) {
    if (!open) {
      const at = Math.max(p.height, p.activation.effectiveHeight ?? p.height);
      sched = { height: p.activation.effectiveHeight ?? null, bps: Math.max(kindBpsAtV2(p.track, feeKind, at), kindBpsAtV2(p.track, feeKind, p.height)) };
    } else {
      const n = nextKindChangeV2(p.track, feeKind, p.height);
      if (n) sched = n;
    }
  }
  let scheduledBps: number | null = null, scheduledFromHeight: number | null = null, scheduledFeeAtoms: string | null = null;
  if (sched) {
    const b = Math.min(p.doc.feeBps, sched.bps, ceiling);
    if (b !== appliedBps) {
      scheduledBps = b; scheduledFromHeight = sched.height;
      scheduledFeeAtoms = String(feeAmount(total, b).actualAtoms);
    }
  }

  let waiveReason: WaiveReason = 'none';
  if (fee.feeAtoms === '0') {
    if (feeKind === null) waiveReason = 'unknown-kind';
    else if (isClosedFeeKind(feeKind)) waiveReason = 'closed-kind';
    else if (!verified) waiveReason = 'unverified-track';
    else if (!open && Math.min(p.doc.feeBps, ceiling, scheduledBps ?? 0) > 0) waiveReason = p.activation.phase as 'pre-launch-window' | 'postponed' | 'notice';
    else if (fee.exempt) waiveReason = 'below-min-output';
    else if (ceiling < Math.min(p.doc.feeBps, trackBps)) waiveReason = 'kind-ceiling';
    else waiveReason = 'zero-rate';
  }

  let receipt: FeeReceipt = fee.receipt;
  if (scheduledBps !== null && scheduledBps > appliedBps && fee.feeAtoms === '0') {
    const a = feeAmount(total, scheduledBps);
    receipt = { rateBps: scheduledBps, computedAtoms: String(a.computedAtoms), exempt: true, actualAtoms: '0' };
  }
  return { feeKind, appliedBps, fee, trackBps, scheduledBps, scheduledFromHeight, scheduledFeeAtoms, activation: p.activation, waiveReason, receipt };
}

/**
 * 종류 하나의 지금 적용 요율(bps) — 상품 문서 없이 종류만으로 정하는 경로(매장 견적 'pos', core/shop-order/quote.ts).
 * quoteFee 의 적용 요율과 같은 규칙(문서 feeBps 상한만 없다): 서명 확인된 일정(isVerifiedFeeTrackV2)이고 activation 'active' 일 때만
 * min(종류 일정 요율, 종류 후보 상한, activation.appliedBps), 아니면 0. 모르는 종류(null)·닫힌 구역 = 0.
 */
export function kindAppliedBps(p: { kind: FeeKind | null; track: FeeTrackV2 | null; height: number; activation: FeeActivation | null }): number {
  if (p.kind === null || !p.track || !isVerifiedFeeTrackV2(p.track) || !p.activation || p.activation.phase !== 'active') return 0;
  const actCap = Number.isSafeInteger(p.activation.appliedBps) && p.activation.appliedBps >= 0 ? p.activation.appliedBps : 0;
  return Math.min(kindBpsAtV2(p.track, p.kind, p.height), candidateCeilingBps(p.kind), actCap);
}

const pct = (bps: number) => `${bps / 100}%`;

/** 영수증 한 줄(한국어). 예: 「요율 1%, 산출 0.12 RVN, 면제, 실제 0 RVN」 / 「요율 1%, 산출 0.12 RVN, 실제 0.12 RVN」. */
export function feeReceiptKo(r: FeeReceipt): string {
  return `요율 ${pct(r.rateBps)}, 산출 ${atomsToRvn(r.computedAtoms)} RVN${r.exempt ? ', 면제' : ''}, 실제 ${atomsToRvn(r.actualAtoms)} RVN`;
}

/** 공개 예정 안내 한 줄(한국어). 예: 「수수료 1% 예정 → 지금 0% 면제」. 숫자만 쓴다(날짜 변환은 화면 몫). */
export function feeNoticeKo(q: FeeQuote): string {
  if (q.waiveReason === 'closed-kind') return '수수료 없음(영구 0%)';
  if (q.waiveReason === 'unknown-kind') return '수수료 없음(0%)';
  if (q.waiveReason === 'unverified-track') return '지금 0%(서명 확인된 수수료 일정 없음)';
  const now = `지금 ${pct(q.appliedBps)}${q.fee.feeAtoms === '0' ? ' 면제' : ''}`;
  if (q.scheduledBps !== null && q.scheduledBps > q.appliedBps) {
    const why = q.activation.phase === 'postponed' ? '(판매자 30명 모집 중이라 연기)' : q.activation.phase === 'notice' ? '(판매자 30명 도달, 예고 중)' : '';
    return `수수료 ${pct(q.scheduledBps)} 예정${why} → ${now}`;
  }
  return now;
}
