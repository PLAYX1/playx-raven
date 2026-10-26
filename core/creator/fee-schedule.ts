import { ed25519 } from '@noble/curves/ed25519';
import { sha256 } from '@noble/hashes/sha256';
import { decodeBase58Check } from '../wallet-offline/base58check';
import { b64urlDecode, b64urlEncode, canonicalJson, hex, plain, sha256Hex, utf8, type Loose } from './bytes';
import { isContentType, type ContentType } from './limits';
import { OPERATING_LIST_KEYS } from './operating-keys';

/*
 * 장터 수수료 일정(fee schedule) — 대표 확정 2026-10-11. 요율은 코드 상수가 아니라 **서명된 목록 묶음의 데이터**다.
 *
 *   정책(출발값, policySchedule 한 곳): 시작(launch) 뒤 약 6개월 0% → 5%. 판매자별 연 100만 RVN 초과 판매자 3%(서명 목록이 선언),
 *   창립 판매자(최대 50명, 목록에 명시) 무료 기간 끝난 뒤 12개월 2.5%, 상품당 수수료 상한 500 RVN.
 *   티켓만 무료 기간 0(처음부터 5%). 사용자끼리 2차 경매·교환 1% 는 core/market/auction.ts 그대로(이 일정과 무관).
 *
 * 🔴 기간은 **체인으로** 판정한다(로컬 시계 불신). 시작·구간 경계는 블록 높이다. 시각(timeNote)은 안내 화면의 「예상 날짜」에만 쓴다.
 *    지갑이 구매를 만들 때 = 체인 팁 높이 + 1(다음 블록), 기록된 구매를 판정할 때 = 그 거래가 들어간 블록 높이.
 *    블록 높이는 단조 증가라 블록 시각 조작(±2시간) 영향이 없다. 대신 「6개월」은 블록 수(1분 = 1블록 가정)로 근사된다.
 *    경계: 포함 블록 H 기준 [H − BOUNDARY_TOLERANCE_BLOCKS, H] 안에서 한 번이라도 유효했던 요율과 **정확히** 맞으면 정당
 *    (견적 뒤 늦게 채굴돼 경계를 넘은 거래를 살린다). 「낮은 쪽까지」가 아니라 「그 창 안의 요율 중 하나」인 이유: 판매자 출력은
 *    「가격 − 그 요율의 수수료」 이상이어야 하므로 두 요율을 섞은 거래는 어느 쪽으로도 맞지 않는다.
 *
 * 🔴 원격 권한의 한계(목록 키가 새어도): 수수료 **주소는 코드에 고정**(MARKET_FEE_ADDRESS, 목록에 없음),
 *    요율은 코드 천장 MARKET_FEE_BPS_CEILING(5%) 이하, 상한은 MARKET_FEE_CAP_CEILING_ATOMS(500 RVN) 이하, 창립 판매자 50명 이하.
 *    → 키가 새면 요율을 0~5% 사이에서 바꾸는 것까지만 가능하다.
 *
 * 상품당 상한은 「정수 bps 를 낮춰 수수료가 상한을 넘지 않게」로 구현한다(capBps). 그래서 거래·게임 검증기·가격표는 여전히
 * bps 하나로 표현된다(실제 수수료 ≤ 상한, 차이는 가격의 0.01% 미만). 1 bps 로도 상한을 넘는 가격(5,000,000 RVN 초과)은 팔지 않는다.
 */

export const FEE_SCHEDULE_FORMAT = 'rv-fee-schedule';
export const FEE_SCHEDULE_DOMAIN = 'RAVENVAULT-FEE-SCHEDULE-V1';
export const FEE_SCHEDULE_SIGNATURE_FORMAT = 'rv-fee-schedule-signature';
/** 매니페스트 fee.policy — 「이 상품의 수수료는 서명된 일정 scheduleId 를 따른다」. */
export const FEE_SCHEDULE_POLICY = 'rv-fee-schedule-v1';
/** 옛 매니페스트(선언 요율). 호환 규칙: manifestFeeRef. */
export const LEGACY_FEE_POLICY = 'rv-platform-fee-v4';
export const MARKET_SCHEDULE_ID = 'rv-market';

/** 레이븐볼트 장터 수수료 주소(대표 확정 2026-10-11, 기존 플랫폼 주소 = core/market/auction.ts PLATFORM_ADDRESS, 데스크탑 shop.rs). */
export const MARKET_FEE_ADDRESS = 'RLFnbkjmf1VCVq7D9TZvRp7fv6W97rm2cB';
export const MARKET_FEE_BPS_CEILING = 500;
export const MARKET_FEE_CAP_CEILING_ATOMS = 500n * 100_000_000n;
export const MAX_FOUNDERS = 50;
/** 레이븐코인 목표 블록 간격 1분. 날짜 ↔ 블록 환산(안내·일정 작성용)에만 쓴다. */
export const BLOCKS_PER_DAY = 1440;
export const BLOCK_MS = 60_000;
/** 경계 허용 블록 수(약 2시간): 견적(15분) + 멤풀 지연 여유. */
export const BOUNDARY_TOLERANCE_BLOCKS = 120;

export type ScheduleKey = { readonly keyId: string; readonly publicKey: string };
/** 일정 안쪽 서명을 믿는 내장 키 — 값은 operating-keys.ts 한 곳. 🔴 비어 있다(운영 키 대표 결정 전) — 묶음의 믿는 목록 키(partKeys)로만 검증된다. */
export const FEE_SCHEDULE_PUBLIC_KEYS: readonly ScheduleKey[] = OPERATING_LIST_KEYS;

/**
 * 받은 일정이 하나도 없을 때(새 설치 + 목록 못 받음, 또는 출하 상태처럼 목록 키가 비어 있음) 🔶 대표 결정.
 *   'refuse'    (지금 값): 구매 거래를 만들지 않는다. 판매자에게 약속한 무료 기간·창립 요율을 어기지 않는다. 구매는 어차피 온라인이라 대개 곧 목록을 받는다.
 *   'base-rate' : 기본 일정(BASE_RATE_SCHEDULE: 처음부터 5%, 무료·창립·누적 없음)으로 판다. 판매는 안 막히지만 무료 기간 약속을 어길 수 있다.
 * 만료된 일정은 「없음」이 아니다 — 마지막으로 검증된 일정을 계속 쓴다(creator-parts.ts, 요율은 신뢰 부여가 아니라 정책이므로).
 */
export const MISSING_SCHEDULE_POLICY: 'refuse' | 'base-rate' = 'refuse';

export type KindRule = {
  /** 시작 높이부터 무료(0%) 블록 수. 티켓 0. */
  freeBlocks: number;
  /** 무료 기간 뒤 기본 요율(bps, ≤ 천장). */
  bps: number;
  /** 창립 판매자 요율을 이 종류에도 적용하나. */
  founders: boolean;
  /** 연 누적 구간 요율을 이 종류에도 적용하나. */
  volume: boolean;
  /** 상품당 수수료 상한(atoms 문자열, ≤ 500 RVN). */
  capAtoms: string;
  /** 가격 없는(무료) 상품을 목록에 「무료」로 보이나(false 면 숨김). 무료 상품은 결제가 없으니 수수료 0. */
  freePrice: boolean;
};
export type VolumeSeller = { address: string; year: number; fromHeight: number; untilHeight: number };
export type RegionPolicy = { mode: 'none' } | { mode: 'deny'; countries: string[] };
export type FeeSchedule = {
  format: typeof FEE_SCHEDULE_FORMAT; version: 1; scheduleId: string;
  /** 시작 = 블록 높이(판정 기준). timeNote = 그 블록의 예상/실제 시각(안내용, 판정에 쓰지 않음). */
  launch: { height: number; timeNote: string };
  rules: { '*': KindRule } & Partial<Record<ContentType, KindRule>>;
  founders: { bps: number; blocks: number; sellers: string[] };
  /** 연 누적 100만 RVN 초과 판매자 = 서버 없이 지갑이 셀 수 없어 **서명 목록이 선언**한다(판매자·해·적용 높이 구간). */
  volume: { bps: number; thresholdAtoms: string; sellers: VolumeSeller[] };
  /** 지역 정책(기본 제한 없음 — 대표 결정으로만 바꾼다). 코드에 나라를 박지 않는다. */
  regions: RegionPolicy;
};
export type FeeScheduleSignature = { format: typeof FEE_SCHEDULE_SIGNATURE_FORMAT; version: 1; keyId: string; listVersion: number; issuedAt: string;
  algorithm: 'Ed25519'; domain: typeof FEE_SCHEDULE_DOMAIN; docSha256: string; signature: string };

export type FeeScheduleErrorCode = 'schedule-shape' | 'schedule-signature' | 'before-launch' | 'cap-range' | 'price-format';
export class FeeScheduleError extends Error {
  constructor(readonly code: FeeScheduleErrorCode, readonly detail = '') { super(detail ? `${code}: ${detail}` : code); this.name = 'FeeScheduleError'; }
}
const fail = (code: FeeScheduleErrorCode, detail = ''): never => { throw new FeeScheduleError(code, detail); };
const int = (n: unknown, min: number, max: number): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= min && n <= max;
const keysAre = (o: Record<string, Loose>, keys: string) => Object.keys(o).sort().join() === keys.split(',').sort().join();
const ATOMS = /^[1-9]\d{0,17}$/;
const ADDRESS = /^R[1-9A-HJ-NP-Za-km-z]{33}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;
const MAX_HEIGHT = 1_000_000_000;
export const isFeeAddress = (a: unknown): a is string => {
  if (typeof a !== 'string' || !ADDRESS.test(a)) return false;
  try { return decodeBase58Check(a).version === 0x3c; } catch { return false; }
};

/* ── 정책 출발값(한 곳) ─────────────────────────────────────────────── */

export const MARKET_POLICY = Object.freeze({
  freeDays: 183, baseBps: 500, volumeBps: 300, volumeThresholdRvn: 1_000_000, founderBps: 250, founderDays: 365, maxFounders: MAX_FOUNDERS,
  capRvn: 500, ticketFreeDays: 0,
});

/** 대표 확정 정책 → 일정 문서. 서명 도구·시험·「일정을 아직 못 받음」 안내가 같은 값을 쓴다. */
export function policySchedule(p: { launchHeight: number; launchTimeNote: string; founders?: string[]; volumeSellers?: VolumeSeller[]; regions?: RegionPolicy; scheduleId?: string }): FeeSchedule {
  const cap = String(BigInt(MARKET_POLICY.capRvn) * 100_000_000n);
  const rule = (freeDays: number): KindRule => ({ freeBlocks: freeDays * BLOCKS_PER_DAY, bps: MARKET_POLICY.baseBps, founders: true, volume: true, capAtoms: cap, freePrice: true });
  return validateFeeSchedule({
    format: FEE_SCHEDULE_FORMAT, version: 1, scheduleId: p.scheduleId ?? MARKET_SCHEDULE_ID,
    launch: { height: p.launchHeight, timeNote: p.launchTimeNote },
    rules: { '*': rule(MARKET_POLICY.freeDays), ticket: rule(MARKET_POLICY.ticketFreeDays) },
    founders: { bps: MARKET_POLICY.founderBps, blocks: MARKET_POLICY.founderDays * BLOCKS_PER_DAY, sellers: [...(p.founders ?? [])] },
    volume: { bps: MARKET_POLICY.volumeBps, thresholdAtoms: String(BigInt(MARKET_POLICY.volumeThresholdRvn) * 100_000_000n), sellers: [...(p.volumeSellers ?? [])] },
    regions: p.regions ?? { mode: 'none' },
  });
}

/** MISSING_SCHEDULE_POLICY = 'base-rate' 일 때만 쓰는 기본 일정: 처음부터 5%, 무료·창립·누적 없음, 상한 500 RVN. */
export const BASE_RATE_SCHEDULE: FeeSchedule = deepFreeze({
  format: FEE_SCHEDULE_FORMAT, version: 1, scheduleId: MARKET_SCHEDULE_ID, launch: { height: 1, timeNote: '2018-01-03T00:00:00Z' },
  rules: { '*': { freeBlocks: 0, bps: MARKET_POLICY.baseBps, founders: false, volume: false, capAtoms: String(500n * 100_000_000n), freePrice: true } },
  founders: { bps: MARKET_POLICY.founderBps, blocks: 0, sellers: [] }, volume: { bps: MARKET_POLICY.volumeBps, thresholdAtoms: String(1_000_000n * 100_000_000n), sellers: [] },
  regions: { mode: 'none' },
} as FeeSchedule);

function deepFreeze<T>(o: T): T {
  if (o && typeof o === 'object') { Object.freeze(o); for (const v of Object.values(o as object)) deepFreeze(v); }
  return o;
}

/* ── 형식 검사 ──────────────────────────────────────────────────────── */

function checkRule(r: unknown): KindRule {
  if (!plain(r) || !keysAre(r, 'freeBlocks,bps,founders,volume,capAtoms,freePrice') || !int(r.freeBlocks, 0, 10 * 365 * BLOCKS_PER_DAY) ||
      !int(r.bps, 0, MARKET_FEE_BPS_CEILING) || typeof r.founders !== 'boolean' || typeof r.volume !== 'boolean' || typeof r.freePrice !== 'boolean' ||
      typeof r.capAtoms !== 'string' || !ATOMS.test(r.capAtoms) || BigInt(r.capAtoms) < 100_000n || BigInt(r.capAtoms) > MARKET_FEE_CAP_CEILING_ATOMS) return fail('schedule-shape', 'rule');
  return r as KindRule;
}

/** 일정 문서 엄격 검사(모르는 칸·빠진 칸·천장 초과 거절). 통과하면 같은 객체를 돌려준다. */
export function validateFeeSchedule(raw: unknown): FeeSchedule {
  const s = raw as Loose;
  if (!plain(s) || !keysAre(s, 'format,version,scheduleId,launch,rules,founders,volume,regions') || s.format !== FEE_SCHEDULE_FORMAT || s.version !== 1 ||
      typeof s.scheduleId !== 'string' || !/^[a-z0-9][a-z0-9-]{0,31}$/.test(s.scheduleId)) return fail('schedule-shape', 'doc');
  if (!plain(s.launch) || !keysAre(s.launch, 'height,timeNote') || !int(s.launch.height, 1, MAX_HEIGHT) || typeof s.launch.timeNote !== 'string' ||
      !ISO.test(s.launch.timeNote) || !Number.isFinite(Date.parse(s.launch.timeNote))) fail('schedule-shape', 'launch');
  if (!plain(s.rules) || !Object.prototype.hasOwnProperty.call(s.rules, '*') || Object.keys(s.rules).some(k => k !== '*' && !isContentType(k))) fail('schedule-shape', 'rules');
  for (const k of Object.keys(s.rules)) checkRule(s.rules[k]);
  const f = s.founders;
  if (!plain(f) || !keysAre(f, 'bps,blocks,sellers') || !int(f.bps, 0, MARKET_FEE_BPS_CEILING) || !int(f.blocks, 0, 10 * 365 * BLOCKS_PER_DAY) ||
      !Array.isArray(f.sellers) || f.sellers.length > MAX_FOUNDERS || f.sellers.some((a: unknown) => !isFeeAddress(a)) || new Set(f.sellers).size !== f.sellers.length) fail('schedule-shape', 'founders');
  const v = s.volume;
  if (!plain(v) || !keysAre(v, 'bps,thresholdAtoms,sellers') || !int(v.bps, 0, MARKET_FEE_BPS_CEILING) || typeof v.thresholdAtoms !== 'string' || !ATOMS.test(v.thresholdAtoms) ||
      !Array.isArray(v.sellers) || v.sellers.length > 10_000) fail('schedule-shape', 'volume');
  const seen = new Set<string>();
  for (const e of v.sellers as Loose[]) {
    if (!plain(e) || !keysAre(e, 'address,year,fromHeight,untilHeight') || !isFeeAddress(e.address) || !int(e.year, 2020, 2200) ||
        !int(e.fromHeight, 1, MAX_HEIGHT) || !int(e.untilHeight, e.fromHeight + 1, MAX_HEIGHT) || seen.has(e.address + ':' + e.year)) fail('schedule-shape', 'volume-seller');
    seen.add(e.address + ':' + e.year);
  }
  const r = s.regions;
  if (!plain(r) || !(r.mode === 'none' ? keysAre(r, 'mode') : r.mode === 'deny' && keysAre(r, 'mode,countries') && Array.isArray(r.countries) &&
      r.countries.length <= 250 && r.countries.every((c: unknown) => typeof c === 'string' && /^[A-Z]{2}$/.test(c)) && new Set(r.countries).size === r.countries.length)) fail('schedule-shape', 'regions');
  if (s.founders.sellers.includes(MARKET_FEE_ADDRESS) || s.volume.sellers.some((e: VolumeSeller) => e.address === MARKET_FEE_ADDRESS)) fail('schedule-shape', 'fee-address-as-seller');
  return s as FeeSchedule;
}

/* ── 서명(자기 도메인 — 다른 목록 서명을 재사용할 수 없다) ───────────────── */

export const keyIdOf = (publicRaw: Uint8Array) => hex(sha256(publicRaw).slice(0, 8));
const signedBytes = (listVersion: number, issuedAt: string, doc: unknown) => utf8(`${FEE_SCHEDULE_DOMAIN}\n${listVersion}\n${issuedAt}\n${canonicalJson(doc)}`);

/** 대표 도구·시험 전용 서명기. 개인키는 32바이트 ed25519 비밀값. 앱은 부르지 않는다. */
export function signFeeSchedule(doc: FeeSchedule, listVersion: number, issuedAt: string, privateKey: Uint8Array): FeeScheduleSignature {
  validateFeeSchedule(doc);
  const pub = ed25519.getPublicKey(privateKey);
  return { format: FEE_SCHEDULE_SIGNATURE_FORMAT, version: 1, keyId: keyIdOf(pub), listVersion, issuedAt, algorithm: 'Ed25519', domain: FEE_SCHEDULE_DOMAIN,
    docSha256: sha256Hex(utf8(canonicalJson(doc))), signature: b64urlEncode(ed25519.sign(signedBytes(listVersion, issuedAt, doc), privateKey)) };
}

/** 서명이 맞기 전에는 어떤 값도 믿지 않는다. 맞으면 내용 검사까지 한 얼린 일정을 돌려준다. */
export function verifyFeeSchedule(doc: unknown, signature: unknown, keys: readonly ScheduleKey[] = FEE_SCHEDULE_PUBLIC_KEYS): FeeSchedule {
  const s = signature as Loose;
  if (!plain(s) || !keysAre(s, 'format,version,keyId,listVersion,issuedAt,algorithm,domain,docSha256,signature') || s.format !== FEE_SCHEDULE_SIGNATURE_FORMAT ||
      s.version !== 1 || s.algorithm !== 'Ed25519' || s.domain !== FEE_SCHEDULE_DOMAIN || typeof s.keyId !== 'string' || !/^[a-f0-9]{16}$/.test(s.keyId) ||
      !int(s.listVersion, 1, Number.MAX_SAFE_INTEGER) || typeof s.issuedAt !== 'string' || !Number.isFinite(Date.parse(s.issuedAt)) ||
      typeof s.docSha256 !== 'string' || typeof s.signature !== 'string') return fail('schedule-signature', 'shape');
  const key = keys.find(k => k.keyId === s.keyId);
  if (!key) return fail('schedule-signature', 'unknown-key');
  let ok = false;
  try {
    const raw = b64urlDecode(key.publicKey), sig = b64urlDecode(s.signature);
    ok = raw.length === 32 && sig.length === 64 && keyIdOf(raw) === key.keyId && sha256Hex(utf8(canonicalJson(doc))) === s.docSha256 &&
      ed25519.verify(sig, signedBytes(s.listVersion, s.issuedAt, doc), raw);
  } catch { ok = false; }
  if (!ok) fail('schedule-signature', 'invalid');
  return deepFreeze(JSON.parse(JSON.stringify(validateFeeSchedule(doc)))) as FeeSchedule;
}

/* ── 지금 쓰는 일정(지갑 전역 — 서명된 묶음이 설치한다) ───────────────────── */

let active: FeeSchedule | null = null;
/** 지금 쓰는 일정. 받은 일정이 없으면 null(→ MISSING_SCHEDULE_POLICY). */
export const activeFeeSchedule = (): FeeSchedule | null => active;
/** 검증된(verifyFeeSchedule 를 거친) 일정만 넣는다. null 이면 「없음」. */
export function setActiveFeeSchedule(s: FeeSchedule | null): void { active = s === null ? null : deepFreeze(JSON.parse(JSON.stringify(validateFeeSchedule(s)))); }
/** 일정이 없을 때의 정책을 적용한 일정(없으면 null = 판매 안 함). */
export const usableSchedule = (s: FeeSchedule | null | undefined, policy: 'refuse' | 'base-rate' = MISSING_SCHEDULE_POLICY): FeeSchedule | null =>
  s ?? (policy === 'base-rate' ? BASE_RATE_SCHEDULE : null);

/* ── 요율 계산(높이 기준) ──────────────────────────────────────────── */

export type SellerRef = { address: string; receivingAddress: string };
export type RateReason = 'free' | 'founder' | 'volume' | 'base' | 'listed-ceiling';
export const ruleFor = (s: FeeSchedule, kind: ContentType): KindRule => s.rules[kind] ?? s.rules['*'];
const isSeller = (list: readonly string[], seller: SellerRef | null) => !!seller && (list.includes(seller.address) || list.includes(seller.receivingAddress));

/** 높이 h 의 상한 적용 전 요율. 시작 전이면 null. */
export function rawRateAt(s: FeeSchedule, kind: ContentType, seller: SellerRef | null, height: number): { bps: number; reason: RateReason } | null {
  if (!int(height, 0, MAX_HEIGHT)) return fail('before-launch', 'height');
  if (height < s.launch.height) return null;
  const r = ruleFor(s, kind);
  const freeEnd = s.launch.height + r.freeBlocks;
  if (height < freeEnd) return { bps: 0, reason: 'free' };
  let best: { bps: number; reason: RateReason } = { bps: r.bps, reason: 'base' };
  if (r.founders && height < freeEnd + s.founders.blocks && isSeller(s.founders.sellers, seller) && s.founders.bps < best.bps) best = { bps: s.founders.bps, reason: 'founder' };
  if (r.volume && s.volume.bps < best.bps && s.volume.sellers.some(v => isSeller([v.address], seller) && v.fromHeight <= height && height < v.untilHeight)) best = { bps: s.volume.bps, reason: 'volume' };
  return best;
}

/** 요율이 바뀔 수 있는 높이들(오름차순, 중복 없음). */
export function changeHeights(s: FeeSchedule, kind: ContentType, seller: SellerRef | null): number[] {
  const r = ruleFor(s, kind), freeEnd = s.launch.height + r.freeBlocks;
  const hs = [s.launch.height, freeEnd];
  if (r.founders && isSeller(s.founders.sellers, seller)) hs.push(freeEnd + s.founders.blocks);
  if (r.volume) for (const v of s.volume.sellers) if (isSeller([v.address], seller)) hs.push(v.fromHeight, v.untilHeight);
  return [...new Set(hs)].sort((a, b) => a - b);
}

/** 상품당 상한: bps 를 「수수료 ≤ cap」인 가장 큰 정수 bps 로 낮춘다. 1 bps 로도 넘으면 'cap-range'(팔지 않음). */
export function capBps(bps: number, priceAtoms: bigint, capAtoms: bigint): { bps: number; capped: boolean } {
  if (bps === 0) return { bps: 0, capped: false };
  if (priceAtoms < 1n) return fail('price-format');
  const byCap = (capAtoms * 10000n) / priceAtoms;
  if (byCap >= BigInt(bps)) return { bps, capped: false };
  if (byCap < 1n) return fail('cap-range');
  return { bps: Number(byCap), capped: true };
}

export type MarketRate = { bps: number; rawBps: number; reason: RateReason; capped: boolean; height: number; nextChange: { height: number; bps: number } | null };

/**
 * 높이 h(구매 = 팁 + 1, 기록 = 포함 블록)에서 이 상품의 실제 요율.
 * ceilingBps = 허용 목록 항목(검증됨)의 feeBps — 대표가 그 상품에 정한 「이보다 높게 받지 않음」(예: 회사 자기 상품 0). null = 없음.
 */
export function marketRate(p: { schedule: FeeSchedule; kind: ContentType; seller: SellerRef | null; height: number; priceAtoms: string | bigint; ceilingBps?: number | null }): MarketRate {
  let price: bigint;
  try { price = BigInt(p.priceAtoms); } catch { return fail('price-format'); }
  if (price < 1n) fail('price-format');
  const at = (h: number) => {
    const raw = rawRateAt(p.schedule, p.kind, p.seller, h);
    if (!raw) return null;
    let bps = raw.bps, reason = raw.reason;
    if (p.ceilingBps !== null && p.ceilingBps !== undefined && p.ceilingBps < bps) { bps = p.ceilingBps; reason = 'listed-ceiling'; }
    const c = capBps(bps, price, BigInt(ruleFor(p.schedule, p.kind).capAtoms));
    return { bps: c.bps, rawBps: raw.bps, reason, capped: c.capped };
  };
  const now = at(p.height);
  if (!now) return fail('before-launch', String(p.height));
  let nextChange: MarketRate['nextChange'] = null;
  for (const h of changeHeights(p.schedule, p.kind, p.seller)) {
    if (h <= p.height) continue;
    const r = at(h);
    if (r && r.bps !== now.bps) { nextChange = { height: h, bps: r.bps }; break; }
  }
  return { ...now, height: p.height, nextChange };
}

/**
 * 포함 블록 H 의 거래가 정당할 수 있는 요율들: [H − 허용, H] 안에서 한 번이라도 유효했던 실제 요율(상한 적용 후).
 * 첫째 값 = H 의 요율. 시작 전 높이는 건너뛴다. 빈 배열 = 그 창 전체가 시작 전.
 */
export function acceptableRates(p: { schedule: FeeSchedule; kind: ContentType; seller: SellerRef | null; height: number; priceAtoms: string | bigint; ceilingBps?: number | null; toleranceBlocks?: number }): number[] {
  const tol = p.toleranceBlocks ?? BOUNDARY_TOLERANCE_BLOCKS;
  const lo = Math.max(0, p.height - tol);
  const hs = [p.height, lo, ...changeHeights(p.schedule, p.kind, p.seller).filter(h => h > lo && h <= p.height)];
  const out: number[] = [];
  for (const h of hs) {
    try { const r = marketRate({ ...p, height: h }); if (!out.includes(r.bps)) out.push(r.bps); }
    catch (e) { if (!(e instanceof FeeScheduleError && e.code === 'before-launch')) throw e; }
  }
  return out;
}

/** 지역 정책. country = ISO 3166-1 alpha-2(모르면 null → 제한 없음 쪽으로 판단, 대표 결정 목록). */
export function regionAllowed(s: FeeSchedule, country: string | null | undefined): boolean {
  if (s.regions.mode === 'none' || !country) return true;
  return !s.regions.countries.includes(country.toUpperCase());
}
/** 가격 없는 상품을 이 종류에서 「무료」로 보이나. */
export const freeListingAllowed = (s: FeeSchedule | null, kind: ContentType): boolean => (s ? ruleFor(s, kind).freePrice : true);

/* ── 매니페스트의 수수료 칸(요율 참조 / 옛 선언 요율) ────────────────────── */

export type ManifestFee = { policy: typeof FEE_SCHEDULE_POLICY; scheduleId: string } | { policy: typeof LEGACY_FEE_POLICY; declaredBps: number };
export const scheduleFee = (scheduleId: string = MARKET_SCHEDULE_ID): ManifestFee => ({ policy: FEE_SCHEDULE_POLICY, scheduleId });

/**
 * 매니페스트 수수료 칸 → 이 상품이 따르는 일정.
 *   새 형식 {policy:'rv-fee-schedule-v1', scheduleId} = 그 일정. 구매 시점 요율은 서명된 일정에서 계산 → 요율이 바뀌어도 이미 낸 상품은 계속 팔린다.
 *   옛 형식 {policy:'rv-platform-fee-v4', declaredBps} 호환 규칙: 선언 요율을 「제작자가 동의한 최대 요율」로 본다.
 *     선언 ≥ 기준(천장 5%, 검증됨이면 min(허용 목록 feeBps, 천장)) 이면 시장 일정(rv-market)을 따르는 것으로 보고, 아니면 결제 없음(fee-mismatch).
 *     (메인넷 발행 스위치가 꺼져 있어 옛 형식이 실제로 나간 적은 없다 — 초안 시험 상품 호환용.)
 */
export function manifestFeeRef(fee: ManifestFee, listedCeilingBps: number | null = null): { ok: true; scheduleId: string } | { ok: false } {
  if (fee.policy === FEE_SCHEDULE_POLICY) return { ok: true, scheduleId: fee.scheduleId };
  const need = Math.min(listedCeilingBps ?? MARKET_FEE_BPS_CEILING, MARKET_FEE_BPS_CEILING);
  return fee.declaredBps >= need ? { ok: true, scheduleId: MARKET_SCHEDULE_ID } : { ok: false };
}

/* ── 날짜 안내(예상 — 판정에 쓰지 않음) ──────────────────────────────── */

/** 지금 높이를 모를 때의 어림(시작 timeNote + 1분 = 1블록). 화면은 「예상」이라고 적는다. */
export const estimateHeight = (s: FeeSchedule, nowMs: number): number => Math.max(0, s.launch.height + Math.floor((nowMs - Date.parse(s.launch.timeNote)) / BLOCK_MS));
/** 높이 → 예상 날짜(KST 「2027년 4월 12일」). */
export function heightDateKo(s: FeeSchedule, height: number): string {
  const t = new Date(Date.parse(s.launch.timeNote) + (height - s.launch.height) * BLOCK_MS + 9 * 3600_000);
  return `${t.getUTCFullYear()}년 ${t.getUTCMonth() + 1}월 ${t.getUTCDate()}일`;
}
export const bpsPercent = (bps: number) => (bps / 100).toString();
