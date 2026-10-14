import { ed25519 } from '@noble/curves/ed25519';
import { b64urlDecode, b64urlEncode, canonicalJson, plain, sha256Hex, utf8, type Loose } from './bytes';
import { OPERATING_LIST_KEYS } from './operating-keys';
import {
  FEE_TRACK_FORMAT, FEE_TRACK_SIGNATURE_FORMAT, INCREASE_DELAY_BLOCKS, ProductError, isProductKindShape, productFeeAt, type ProductBody, type ProductErrorCode, type ProductFee, type ProductFeeOpts,
} from './product-doc';
import { MARKET_FEE_BPS_CEILING, keyIdOf } from './trade-primitives';

/*
 * 수수료 일정 v2(rv-fee-track v2, 종류 칸) — 결정문 §18 Q1 채택안 (b). 순수 함수(네트워크·시계·키 저장소 없음).
 *
 * 서명 문서 하나에 종류별 요율 단계를 모두 싣는다:
 *   { format:'rv-fee-track', version:2, steps:[{ kind, bps, announcedHeight, effectiveHeight }, …] }
 *   · kind = 닫힌 열거형 FEE_KINDS(digital, game, ticket, pos, sdk, groupbuy, used, secondary, transfer, other). 모르는 종류가 하나라도 있으면 문서 전체 거절.
 *   · 단계는 덧붙이기만 한다(공지 높이가 목록 전체에서 줄지 않음). 상품 문서 feeSchedule 칸은 앞 n 단계의 해시(feeTrackV2Hash) — v1 과 같은 「앞부분 약속」.
 *   · 현재 요율 = 시행된 단계, 예정 요율 = 시행 높이가 아직 안 온 단계. 시행 높이 ≥ 공지 높이.
 *
 * 높이 h 에서 종류 k 의 요율(kindBpsAtV2):
 *   k 의 단계를 시행 높이 순(같으면 목록 순)으로 따라가며 「직전까지의 요율(기준)」과 비교한다. 단계가 시행되기 전 기준은 0.
 *   · 기준 이하(인하·동결) → 시행 높이에 바로 적용(인하 즉시).
 *   · 기준 초과(인상) → 시행 높이 − 공지 높이 ≥ INCREASE_DELAY_BLOCKS(183일 환산, product-doc.ts 기존 상수)이고 한 번에 +MAX_INCREASE_STEP_BPS 이내일 때만 적용.
 *     아니면 그 단계는 무시한다(낮은 쪽으로 안전).
 *   · 즉시 인하 뒤 예약돼 있던 인상은 **새 기준(인하된 요율)**에서 다시 판정한다. 인하 전에는 「인하·동결」이던 예약 단계가 새 기준에선 인상이 되면
 *     예고(6개월) 요건을 새로 따져, 못 채우면 무시된다.
 *   · 닫힌 구역(transfer = 단순 송금)은 0 고정 — 0 보다 큰 값이 서명돼 있어도 무시하고 0. used·secondary 는 2026-10-14 대표 결정으로 열림(판매 = 1%).
 *   · 모르는 종류(열거형 밖)·첫 단계 시행 전 = 0. (상품 kind → 종류 분류는 feeKindOf: 모양이 정상인 모르는 상품 kind 는 'other', 10-14 §33.)
 * 거절(오류 = 호출 측은 유료 계산을 하지 않는다 = 0%): 알 수 없는 version, v1/v2 섞임(v1 문서·v1 칸·v1 서명), 모르는 종류, 천장(5%) 초과, 모양 틀림.
 * 서명: 자기 도메인 RAVENVAULT-FEE-TRACK-V2. 검증 함수는 주입할 수 있고, 운영 키가 비어 있으면(출하 상태) 어떤 일정도 믿지 않는다(기존 정책 유지).
 *
 * ⚠ 공지 높이는 서명자가 적는 값이다. 지갑이 그 일정을 처음 본 높이와 대조(소급 공지 방지)하는 것은 호출 측 몫 — 운영 확인 필요.
 * 🔶 블록 = 1분 근사(183 × 1440). 실제 시각과의 차이는 시험망·메인넷 블록 시간 확인 필요.
 */

export const FEE_TRACK_V2_VERSION = 2;
export const FEE_TRACK_V2_DOMAIN = 'RAVENVAULT-FEE-TRACK-V2';
/** 종류 칸 닫힌 열거형. 새 종류 개방 = 코드 변경 = 대표 결정(§16-3). */
export const FEE_KINDS = ['digital', 'game', 'ticket', 'pos', 'sdk', 'groupbuy', 'used', 'secondary', 'transfer', 'other'] as const;
export type FeeKind = (typeof FEE_KINDS)[number];
/** 닫힌 구역 = 영구 0%(§14-1). 2026-10-14 대표: 중고·2차 거래는 판매라 1%, 단순 송금(transfer)만 무료로 남는다(결정문 §32). */
export const CLOSED_FEE_KINDS: readonly FeeKind[] = Object.freeze(['transfer'] as FeeKind[]);
/** 인상은 1회 +2%p 이내(§14-3). */
export const MAX_INCREASE_STEP_BPS = 200;
export const MAX_FEE_STEPS = 1000;
const MAX_HEIGHT = 1_000_000_000;

export type FeeStepV2 = { kind: FeeKind; bps: number; announcedHeight: number; effectiveHeight: number };
export type FeeTrackV2 = { format: typeof FEE_TRACK_FORMAT; version: 2; steps: FeeStepV2[] };
export type FeeTrackV2Signature = { format: typeof FEE_TRACK_SIGNATURE_FORMAT; version: 2; keyId: string; algorithm: 'Ed25519'; domain: typeof FEE_TRACK_V2_DOMAIN; signature: string };
/** 주입 가능한 서명 검증 함수(공개키 32바이트, 서명 대상 바이트, 서명 64바이트). */
export type TrackVerifier = (publicKey: Uint8Array, message: Uint8Array, signature: Uint8Array) => boolean;
export const ed25519Verifier: TrackVerifier = (pub, msg, sig) => ed25519.verify(sig, msg, pub);

const fail = (code: ProductErrorCode, detail = ''): never => { throw new ProductError(code, detail); };
const keysAre = (o: Record<string, Loose>, keys: string) => Object.keys(o).sort().join() === keys.split(',').sort().join();
const int = (n: unknown, min: number, max: number): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= min && n <= max;
const own = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);

export const isFeeKind = (k: unknown): k is FeeKind => typeof k === 'string' && (FEE_KINDS as readonly string[]).includes(k);
export const isClosedFeeKind = (k: FeeKind): boolean => CLOSED_FEE_KINDS.includes(k);

/**
 * 상품 문서 kind(확장형 문자열) → 수수료 종류.
 *   · 표에 있는 kind → 그 종류(transfer → transfer = 닫힌 구역 0%, used·secondary·resale 도 표 그대로 — 'other' 로 새지 않는다).
 *   · 표에 없지만 모양이 정상인 kind(product-doc.ts isProductKindShape = 상품 문서 검증과 같은 규칙) → 'other'(기타).
 *   · 문자열 아님·모양 깨짐('', 대문자, 너무 김, '__proto__' 등) → null = 0%.
 * 2026-10-14 대표 결정(결정문 §33): 「기타」도 1%. 옛 정책 「모르는 종류 유료 거부(null = 0%)」는 모양이 정상인 kind 에 한해 폐기 —
 *   ⚠ 새 상품 종류는 표에 없어도 자동으로 기타 요율(서명된 일정의 other)이 붙는다. 표 조회는 own-property 만(프로토타입 우회 없음).
 */
const KIND_MAP: Readonly<Record<string, FeeKind>> = Object.freeze({
  digital: 'digital', music: 'digital', book: 'digital', game: 'game', ticket: 'ticket', menu: 'pos', pos: 'pos', sdk: 'sdk',
  groupbuy: 'groupbuy', used: 'used', secondary: 'secondary', resale: 'secondary', transfer: 'transfer',
});
export const feeKindOf = (kind: unknown): FeeKind | null =>
  typeof kind !== 'string' ? null : own(KIND_MAP, kind) ? KIND_MAP[kind] : isProductKindShape(kind) ? 'other' : null;

/** 들어온 일정 문서의 버전. rv-fee-track 이 아니면 null. */
export function feeTrackVersionOf(raw: unknown): number | null {
  return plain(raw) && raw.format === FEE_TRACK_FORMAT && typeof raw.version === 'number' ? raw.version : null;
}

/** 엄격 검사. v1 문서·v1 칸(versions)·알 수 없는 버전·모르는 종류·천장 초과·시행 < 공지·공지 높이 역행은 거절. */
export function validateFeeTrackV2(raw: unknown): FeeTrackV2 {
  const t = raw as Loose;
  if (!plain(t) || t.format !== FEE_TRACK_FORMAT) return fail('track-shape', 'format');
  if (t.version === 1 || own(t, 'versions')) return fail('track-mixed', 'v1-in-v2');
  if (t.version !== FEE_TRACK_V2_VERSION) return fail('track-version', String(t.version));
  if (!keysAre(t, 'format,version,steps') || !Array.isArray(t.steps) || t.steps.length < 1 || t.steps.length > MAX_FEE_STEPS) return fail('track-shape', 'doc');
  let lastAnnounced = 0;
  for (const s of t.steps as Loose[]) {
    if (!plain(s)) fail('track-shape', 'step');
    if (own(s, 'announcedHeight') && own(s, 'bps') && !own(s, 'kind')) fail('track-mixed', 'v1-step');
    if (!keysAre(s, 'kind,bps,announcedHeight,effectiveHeight')) fail('track-shape', 'step-keys');
    if (!isFeeKind(s.kind)) fail('track-shape', 'kind');
    if (!int(s.bps, 0, MARKET_FEE_BPS_CEILING)) fail('track-shape', 'bps');
    if (!int(s.announcedHeight, 1, MAX_HEIGHT) || s.announcedHeight < lastAnnounced) fail('track-shape', 'announced');
    if (!int(s.effectiveHeight, s.announcedHeight, MAX_HEIGHT)) fail('track-shape', 'effective');
    lastAnnounced = s.announcedHeight;
  }
  return t as FeeTrackV2;
}

/** 앞 n 단계의 해시(상품 문서 feeSchedule 칸). n 생략 = 전체. v1 해시와 절대 같아질 수 없다(version 칸이 다르다). */
export function feeTrackV2Hash(track: FeeTrackV2, n: number = track.steps.length): string {
  validateFeeTrackV2(track);
  if (!int(n, 1, track.steps.length)) fail('track-shape', 'prefix');
  return sha256Hex(utf8(canonicalJson({ format: track.format, version: track.version, steps: track.steps.slice(0, n) })));
}
/**
 * 요율표 버전 식별자(영수증 feeTrackId) = 일정 **전체** 본문 해시(feeTrackV2Hash) 앞 16자(소문자 hex).
 * 서명 키 id 는 검증된 일정 객체에 남지 않으므로 본문 해시를 쓴다 — 같은 일정이면 어느 지갑에서도 같은 값, 단계가 하나라도 다르면 다른 값(25라운드 §36).
 */
export const FEE_TRACK_ID_HEX = 16;
export const feeTrackIdOf = (track: FeeTrackV2): string => feeTrackV2Hash(track).slice(0, FEE_TRACK_ID_HEX);
/** 서명 확인된 일정(isVerifiedFeeTrackV2)이면 그 식별자, 아니면 null(지어내지 않는다). */
export const verifiedFeeTrackId = (track: unknown): string | null => (isVerifiedFeeTrackV2(track) ? feeTrackIdOf(track as FeeTrackV2) : null);
/** 영수증에 남기는 수수료 근거(receipts Receipt 판 3 칸과 같은 모양). */
export type ReceiptFeeRef = { feeTrackId: string | null; appliedFeeBps: number; feeKind: FeeKind | null };
/**
 * 구매·견적 시점의 일정·적용 요율·종류 → 영수증 칸. 일정이 서명 확인되지 않았으면 feeTrackId = null 이고 요율은 0 이어야 한다
 * (fee-policy kindAppliedBps 가 그때 0 을 낸다). 일정 없이 요율 > 0, 종류 없이 요율 > 0, 천장 밖 요율은 던진다.
 */
export function receiptFeeRef(p: { track: FeeTrackV2 | null; appliedBps: number; feeKind: FeeKind | null }): ReceiptFeeRef {
  if (!int(p.appliedBps, 0, MARKET_FEE_BPS_CEILING)) return fail('product-fee', 'receipt-bps');
  if (p.feeKind !== null && !isFeeKind(p.feeKind)) return fail('product-fee', 'receipt-kind');
  const feeTrackId = verifiedFeeTrackId(p.track);
  if (p.appliedBps > 0 && (feeTrackId === null || p.feeKind === null)) return fail('product-fee', 'receipt-rate-without-track');
  return { feeTrackId, appliedFeeBps: p.appliedBps, feeKind: p.feeKind };
}
/** 이 일정이 문서가 서명한 앞부분으로 시작하나. 맞으면 그 길이, 아니면 0. */
export function trackV2Extends(track: FeeTrackV2, committed: string): number {
  for (let n = 1; n <= track.steps.length; n++) if (feeTrackV2Hash(track, n) === committed) return n;
  return 0;
}

/* ── 서명 ───────────────────────────────────────────────────────────── */

const signedBytesV2 = (track: FeeTrackV2) => utf8(`${FEE_TRACK_V2_DOMAIN}\n${canonicalJson(track)}`);
/** 대표 도구·시험 전용. 앱은 부르지 않는다. */
export function signFeeTrackV2(track: FeeTrackV2, privateKey: Uint8Array): FeeTrackV2Signature {
  validateFeeTrackV2(track);
  return { format: FEE_TRACK_SIGNATURE_FORMAT, version: 2, keyId: keyIdOf(ed25519.getPublicKey(privateKey)), algorithm: 'Ed25519', domain: FEE_TRACK_V2_DOMAIN,
    signature: b64urlEncode(ed25519.sign(signedBytesV2(track), privateKey)) };
}
/**
 * 서명 확인. keys 기본 = operating-keys.ts(지금 비어 있음 → 어떤 일정도 믿지 않는다 → 'track-signature').
 * verify 는 주입 가능(기본 ed25519). v1 서명(version 1·V1 도메인)은 'track-mixed'.
 */
export function verifyFeeTrackV2(track: unknown, signature: unknown,
  opts: { keys?: readonly { keyId: string; publicKey: string }[]; verify?: TrackVerifier } = {}): FeeTrackV2 {
  const keys = opts.keys ?? OPERATING_LIST_KEYS, verify = opts.verify ?? ed25519Verifier;
  if (!Array.isArray(keys) || keys.length === 0) return fail('track-signature', 'no-operating-keys');
  const s = signature as Loose;
  if (plain(s) && (s.version === 1 || (typeof s.domain === 'string' && s.domain !== FEE_TRACK_V2_DOMAIN && s.domain.startsWith('RAVENVAULT-FEE-TRACK')))) return fail('track-mixed', 'v1-signature');
  if (!plain(s) || !keysAre(s, 'format,version,keyId,algorithm,domain,signature') || s.format !== FEE_TRACK_SIGNATURE_FORMAT || s.version !== 2 ||
      s.algorithm !== 'Ed25519' || s.domain !== FEE_TRACK_V2_DOMAIN || typeof s.keyId !== 'string' || typeof s.signature !== 'string') return fail('track-signature', 'shape');
  const key = keys.find(k => k.keyId === s.keyId);
  if (!key) return fail('track-signature', 'unknown-key');
  const t = validateFeeTrackV2(track);
  let ok = false;
  try {
    const raw = b64urlDecode(key.publicKey), sig = b64urlDecode(s.signature);
    ok = raw.length === 32 && sig.length === 64 && keyIdOf(raw) === key.keyId && verify(raw, signedBytesV2(t), sig) === true;
  } catch { ok = false; }
  if (!ok) fail('track-signature', 'invalid');
  const out = JSON.parse(JSON.stringify(t)) as FeeTrackV2;
  out.steps.forEach(s => Object.freeze(s)); Object.freeze(out.steps); Object.freeze(out);
  VERIFIED_TRACKS.add(out);
  return out;
}

/**
 * 「검증된 일정」 표식(§20 A 조건): verifyFeeTrackV2 가 서명을 확인하고 돌려준 **그 객체**(얼려 둔 사본)만 true. 모양이 같은 다른 객체·복사본은 false.
 * fee-policy.ts quoteFee 는 이 표식이 없으면 징수하지 않는다(0%). 운영 키가 비어 있는 출하 상태에서는 어떤 일정도 표식을 얻지 못한다.
 */
const VERIFIED_TRACKS = new WeakSet<object>();
export const isVerifiedFeeTrackV2 = (track: unknown): boolean => typeof track === 'object' && track !== null && VERIFIED_TRACKS.has(track);

/* ── 요율 판정 ──────────────────────────────────────────────────────── */

export type StepOutcome = { index: number; step: FeeStepV2; base: number; applied: boolean;
  reason: 'decrease-or-same' | 'increase-with-notice' | 'initial-rate' | 'short-notice' | 'step-too-large' };

/**
 * 첫 단계 예외(결정문 §20 A, 대표 확정 「출시 첫날 1%」): 종류 k 의 **첫 단계**(목록에서 k 의 첫 줄)가 일정의 **출시 공지**(steps[0].announcedHeight)에
 * 함께 실린 것이고 k 에서 처음 판정되는 단계면, 예고 6개월 없이 시행 높이에 적용한다(reason 'initial-rate'). 1회 +2%p 상한은 그대로.
 * 출시 뒤 새로 덧붙인 종류의 첫 단계·두 번째 이후 단계는 예외가 아니다(인상 = 6개월 예고).
 */
const isInitialStep = (track: FeeTrackV2, kind: FeeKind, index: number): boolean =>
  track.steps.findIndex(s => s.kind === kind) === index && track.steps[index].announcedHeight === track.steps[0].announcedHeight;

/** 종류 k 의 단계를 시행 높이 순으로 따라간 기록(높이 h 까지 시행된 것만). 화면·시험이 「왜 무시됐나」를 볼 수 있게 남긴다. */
export function kindHistoryV2(track: FeeTrackV2, kind: FeeKind, height: number): { bps: number; outcomes: StepOutcome[] } {
  validateFeeTrackV2(track);
  if (!int(height, 0, MAX_HEIGHT)) fail('before-schedule', 'height');
  if (isClosedFeeKind(kind)) return { bps: 0, outcomes: [] };
  const steps = track.steps.map((step, index) => ({ step, index })).filter(x => x.step.kind === kind && x.step.effectiveHeight <= height)
    .sort((a, b) => a.step.effectiveHeight - b.step.effectiveHeight || a.index - b.index);
  let cur = 0;
  const outcomes: StepOutcome[] = [];
  for (const { step, index } of steps) {
    const base = cur;
    if (step.bps <= base) { cur = step.bps; outcomes.push({ index, step, base, applied: true, reason: 'decrease-or-same' }); continue; }
    const noticed = step.effectiveHeight - step.announcedHeight >= INCREASE_DELAY_BLOCKS;
    const initial = !noticed && outcomes.length === 0 && isInitialStep(track, kind, index);
    if (!noticed && !initial) { outcomes.push({ index, step, base, applied: false, reason: 'short-notice' }); continue; }
    if (step.bps - base > MAX_INCREASE_STEP_BPS) { outcomes.push({ index, step, base, applied: false, reason: 'step-too-large' }); continue; }
    cur = step.bps; outcomes.push({ index, step, base, applied: true, reason: initial ? 'initial-rate' : 'increase-with-notice' });
  }
  return { bps: cur, outcomes };
}

/** 높이 h 에서 종류의 일정 요율(bps). 모르는 종류·닫힌 구역·시행 전 = 0. */
export function kindBpsAtV2(track: FeeTrackV2, kind: unknown, height: number): number {
  validateFeeTrackV2(track);
  if (!isFeeKind(kind)) return 0;
  return kindHistoryV2(track, kind, height).bps;
}

/** h 다음에 종류 요율이 처음 바뀌는 높이와 요율(같은 판정 함수로 탐색 — 미리보기와 실제 계산이 갈리지 않는다). 없으면 null. */
export function nextKindChangeV2(track: FeeTrackV2, kind: unknown, height: number): { height: number; bps: number } | null {
  if (!isFeeKind(kind)) return null;
  const now = kindBpsAtV2(track, kind, height);
  const hs = [...new Set(track.steps.filter(s => s.kind === kind).map(s => s.effectiveHeight))].filter(h => h > height).sort((a, b) => a - b);
  for (const h of hs) {
    const b = kindBpsAtV2(track, kind, h);
    if (b !== now) return { height: h, bps: b };
  }
  return null;
}

/**
 * 상품 하나의 수수료(v2 일정). 문서가 서명한 일정 앞부분으로 시작해야 한다('track-mismatch'). 산식은 product-doc.ts productFeeAt(내림·상한·면제선).
 * 적용 요율 = min(문서 feeBps, 종류 일정 요율). 모르는 정상 kind = 기타(other) 요율, 모양이 깨진 kind = 0%. 금액 기준 = 주문 총액(단가 × qty + shippingAtoms, §29 ①).
 */
export function productFeeV2(p: { doc: ProductBody; track: FeeTrackV2; height: number } & ProductFeeOpts): ProductFee & { feeKind: FeeKind | null } {
  validateFeeTrackV2(p.track);
  if (!trackV2Extends(p.track, p.doc.feeSchedule)) fail('track-mismatch');
  const feeKind = feeKindOf(p.doc.kind);
  const scheduleBps = feeKind === null ? 0 : kindBpsAtV2(p.track, feeKind, p.height);
  return { ...productFeeAt(p.doc, scheduleBps, { capAtoms: p.capAtoms, minOutputAtoms: p.minOutputAtoms, qty: p.qty, shippingAtoms: p.shippingAtoms }), feeKind };
}
