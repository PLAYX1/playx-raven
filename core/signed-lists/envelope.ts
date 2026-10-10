import { ed25519 } from '@noble/curves/ed25519';
import { sha256 } from '@noble/hashes/sha256';
import { b64urlDecode, b64urlEncode, hex, plain, sha256Hex, utf8, type Loose } from '../creator/bytes';

/**
 * 정본 JSON(키 정렬·공백 없음). 게임 등록부(core/game-registry/allowlist.ts canonicalJson)와 같은 규칙 — 유한한 수는 받는다
 * (등록부에 소수 「krwPerRvn」가 있을 수 있다). 제작자 bytes.ts 판은 안전 정수만 받아 여기서는 쓰지 않는다.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') { if (!Number.isFinite(value)) throw new Error('canonical'); return JSON.stringify(value); }
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  if (plain(value)) {
    return '{' + Object.keys(value).sort().map(k => {
      if (value[k] === undefined) throw new Error('canonical');
      return JSON.stringify(k) + ':' + canonicalJson(value[k]);
    }).join(',') + '}';
  }
  throw new Error('canonical');
}

/*
 * 서명된 허용·차단 목록 「실행 중 갱신」 — 봉투(envelope)와 상태 기계. 지갑·데스크탑이 같은 파일을 쓴다(데스크탑은 바이트 그대로 복사).
 *
 * 왜: 검증된 게임 등록부·제작자 허용 목록·차단 목록이 지갑 묶음에 내장되어 있어, 게임/제작자 하나를 검증·차단할 때마다 지갑을 다시
 * 빌드·배포해야 했다. 이제 내장 목록은 「기본값(최소 시작 목록)」이고, 지갑은 **서명된 최신 목록 묶음**을 따로 받아 서명만 검증해 적용한다.
 * 서버·DB 없음: 묶음은 지갑 사이트의 정적 파일(release-site /lists/signed-lists.json) 또는 IPFS 로 나른다(sources.ts). 전달 경로는 믿지 않는다.
 *
 * 묶음 = 바깥 서명(이 파일, 도메인 RAVENVAULT-SIGNED-LISTS-V1) + 안쪽 목록마다 **원래 서명**(원래 도메인 그대로 —
 * 게임 등록부 RAVENVAULT-GAME-ALLOWLIST-V1 · 제작자 허용 RAVENVAULT-CREATOR-ALLOWLIST-V1 · 차단 RAVENVAULT-CREATOR-DENYLIST-V1 ·
 * 수수료 일정 RAVENVAULT-FEE-SCHEDULE-V1).
 * 바깥 서명은 일련번호·발행 시각·만료와 안쪽 목록 각각의 SHA-256 을 묶는다. 도메인 문자열은 목적마다 따로다(재사용 금지).
 *
 * 안전 규칙(전부 시험이 있다 — signed-lists.test.ts):
 *  1. 일련번호(sequence)가 올라갈 때만 적용한다. 같은 번호에 다른 내용 = 거절, 낮은 번호 = 거절(되돌림 공격).
 *  2. 만료(expiresAt)가 지났거나, 발행 시각이 미래(시계 오차 1일 초과)이거나, 수명이 180일을 넘으면 거절.
 *  3. 서명 실패·형식 이상·크기 초과·네트워크 실패면 **마지막으로 검증된 목록을 그대로 유지**(없으면 내장 기본값).
 *  4. 부분 적용 없음: 바깥 서명·모든 목록 해시·쓰는 목록의 안쪽 서명·내용 검사가 **전부** 통과해야 상태가 바뀐다.
 *  5. 키 전환(rotation): 내장 공개키 여러 개 허용 + 「키 전환 문」(지금 믿는 키 서명 + 새 키 서명, 순번 연속)으로 키를 더하고 은퇴시킨다.
 *     은퇴한 키는 다시 살아나지 않고, 믿는 키가 하나도 남지 않게 하는 전환은 거절한다.
 * 🔴 이 파일에 개인키는 없다. 서명은 대표 도구(scripts/signed-lists/sign-lists.mjs)가 키 파일로 한다.
 */

export const LISTS_FORMAT = 'rv-signed-lists';
export const LISTS_VERSION = 1;
export const LISTS_DOMAIN = 'RAVENVAULT-SIGNED-LISTS-V1';
export const TRANSITION_FORMAT = 'rv-list-key-transition';
export const TRANSITION_DOMAIN = 'RAVENVAULT-LIST-KEY-TRANSITION-V1';
export const STATE_FORMAT = 'rv-signed-lists-state';
/**
 * 묶음 안 목록 이름. 묶음은 칸을 다 가진다(값은 목록 또는 null = 「이 목록 없음」). 스냅숏이라 합치기(merge)가 없다.
 * feeSchedule(장터 수수료 일정, 2026-10-11)은 나중에 더한 칸이다 — 그 칸이 없는 옛 세 칸 묶음도 받는다(없음 = null).
 * 서명기(signBundle)는 늘 네 칸을 쓴다.
 */
export const PART_NAMES = ['gameRegistry', 'creatorAllowlist', 'creatorDenylist', 'feeSchedule'] as const;
export type PartName = typeof PART_NAMES[number];
const LEGACY_PART_NAMES = PART_NAMES.filter(n => n !== 'feeSchedule');
const partKeysOk = (o: Record<string, Loose>) => keysAre(o, PART_NAMES.join(',')) || keysAre(o, LEGACY_PART_NAMES.join(','));

export const MAX_BUNDLE_BYTES = 8 * 1024 * 1024;
export const MAX_LIFETIME_MS = 180 * 24 * 3600 * 1000;
export const CLOCK_SKEW_MS = 24 * 3600 * 1000;
export const MAX_TRANSITIONS = 64;

export type ListKey = { readonly keyId: string; readonly publicKey: string };
/**
 * 바깥 서명(묶음)을 믿는 내장 공개키. 🔴 **비어 있다** — 운영 키를 누가 어디서 만들지(대표 결정) 정하기 전에는 출하 앱이
 * 어떤 묶음도 받아들이지 않는다(늘 내장 기본값). 시험은 일회용 키를 넘긴다. 키 교체는 여기 한 줄 추가 + 키 전환 문.
 */
export const SIGNED_LISTS_PUBLIC_KEYS: readonly ListKey[] = Object.freeze([]);

export type PartPayload = { doc: unknown; signature: unknown };
export type KeyTransition = {
  format: typeof TRANSITION_FORMAT; version: 1; index: number; issuedAt: string;
  add: ListKey; retire: string[];
  /** 두 서명 이상: 지금 믿는(은퇴 안 한) 키 하나 + 새 키(add) 자신. */
  signatures: Array<{ keyId: string; signature: string }>;
};
export type BundleBody = { sequence: number; issuedAt: string; expiresAt: string; parts: Record<PartName, { sha256: string } | null> };
export type SignedBundle = {
  format: typeof LISTS_FORMAT; version: 1; body: BundleBody; parts: Record<PartName, PartPayload | null>;
  transitions: KeyTransition[]; signature: { keyId: string; algorithm: 'Ed25519'; domain: typeof LISTS_DOMAIN; signature: string };
};

export type RejectReason =
  | 'too-large' | 'not-json' | 'shape' | 'transition' | 'unknown-key' | 'signature' | 'part-hash' | 'part-invalid'
  | 'rollback' | 'same-sequence-different' | 'expired' | 'not-yet-valid' | 'lifetime' | 'network';
export class SignedListsError extends Error {
  constructor(readonly code: RejectReason, readonly detail = '') { super(detail ? `${code}: ${detail}` : code); this.name = 'SignedListsError'; }
}
const fail = (code: RejectReason, detail = ''): never => { throw new SignedListsError(code, detail); };

const KEY_ID = /^[a-f0-9]{16}$/;
const SHA = /^[a-f0-9]{64}$/;
const int = (n: unknown, min: number, max: number): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= min && n <= max;
const keysAre = (o: Record<string, Loose>, keys: string) => Object.keys(o).sort().join() === keys.split(',').sort().join();
const isoTime = (s: unknown): number => {
  if (typeof s !== 'string' || s.length > 40 || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/.test(s)) return fail('shape', 'time');
  const t = Date.parse(s as string);
  return Number.isFinite(t) ? t : fail('shape', 'time');
};
export const keyIdOf = (publicRaw: Uint8Array) => hex(sha256(publicRaw).slice(0, 8));

/** 공개키 모양 검사 + keyId 가 공개키 해시와 맞는지. */
function checkKey(k: unknown): ListKey {
  if (!plain(k) || !keysAre(k, 'keyId,publicKey') || typeof k.keyId !== 'string' || !KEY_ID.test(k.keyId) || typeof k.publicKey !== 'string') return fail('transition', 'key-shape');
  let raw: Uint8Array;
  try { raw = b64urlDecode(k.publicKey); } catch { return fail('transition', 'key-encoding'); }
  if (raw.length !== 32 || keyIdOf(raw) !== k.keyId) fail('transition', 'key-id');
  return { keyId: k.keyId, publicKey: k.publicKey };
}
function verifyWith(key: ListKey, signature: unknown, message: Uint8Array): boolean {
  try {
    if (typeof signature !== 'string') return false;
    const raw = b64urlDecode(key.publicKey), sig = b64urlDecode(signature);
    return raw.length === 32 && sig.length === 64 && keyIdOf(raw) === key.keyId && ed25519.verify(sig, message, raw);
  } catch { return false; }
}

/* ── 믿는 키 집합과 키 전환 ─────────────────────────────────────────── */

export type Trust = { readonly keys: readonly ListKey[]; readonly retired: readonly string[]; readonly transitions: readonly KeyTransition[] };
export const initialTrust = (builtin: readonly ListKey[]): Trust => ({ keys: builtin.map(k => ({ ...k })), retired: [], transitions: [] });

const transitionBody = (t: Pick<KeyTransition, 'format' | 'version' | 'index' | 'issuedAt' | 'add' | 'retire'>) =>
  ({ format: t.format, version: t.version, index: t.index, issuedAt: t.issuedAt, add: { keyId: t.add.keyId, publicKey: t.add.publicKey }, retire: [...t.retire] });
export const transitionSigningBytes = (t: Pick<KeyTransition, 'format' | 'version' | 'index' | 'issuedAt' | 'add' | 'retire'>) =>
  utf8(`${TRANSITION_DOMAIN}\n${canonicalJson(transitionBody(t))}`);

/** 전환 문 하나를 지금 믿음에 적용한 새 믿음. 틀리면 던진다(믿음은 바뀌지 않는다). */
export function applyTransition(trust: Trust, raw: unknown): Trust {
  if (!plain(raw) || !keysAre(raw, 'format,version,index,issuedAt,add,retire,signatures') || raw.format !== TRANSITION_FORMAT || raw.version !== 1) return fail('transition', 'shape');
  const index = trust.transitions.length + 1;
  if (raw.index !== index) fail('transition', 'index');
  isoTime(raw.issuedAt);
  const add = checkKey(raw.add);
  if (!Array.isArray(raw.retire) || raw.retire.length > 16 || raw.retire.some((k: unknown) => typeof k !== 'string' || !KEY_ID.test(k)) ||
      new Set(raw.retire).size !== raw.retire.length || raw.retire.includes(add.keyId)) fail('transition', 'retire');
  if (trust.retired.includes(add.keyId)) fail('transition', 'resurrect');
  if (!Array.isArray(raw.signatures) || raw.signatures.length < 2 || raw.signatures.length > 4 ||
      raw.signatures.some((s: unknown) => !plain(s) || !keysAre(s as Loose, 'keyId,signature'))) fail('transition', 'signatures');
  const message = transitionSigningBytes(raw as KeyTransition);
  const live = trust.keys.filter(k => !trust.retired.includes(k.keyId));
  const sigs = raw.signatures as Array<{ keyId: string; signature: string }>;
  // 새 키가 자기 개인키를 가졌다는 증명(남의 공개키를 몰래 넣지 못한다).
  if (!sigs.some(s => s.keyId === add.keyId && verifyWith(add, s.signature, message))) fail('transition', 'new-key-proof');
  // 지금 믿는 키 하나 이상의 승인.
  if (!sigs.some(s => s.keyId !== add.keyId && live.some(k => k.keyId === s.keyId && verifyWith(k, s.signature, message)))) fail('transition', 'not-authorized');
  const keys = live.some(k => k.keyId === add.keyId) ? [...trust.keys] : [...trust.keys, add];
  const retired = [...trust.retired, ...raw.retire.filter((id: string) => !trust.retired.includes(id))];
  if (!keys.some(k => !retired.includes(k.keyId))) fail('transition', 'no-key-left');
  return { keys, retired, transitions: [...trust.transitions, JSON.parse(JSON.stringify(raw)) as KeyTransition] };
}
/** 지금 믿는(은퇴하지 않은) 키. */
export const liveKeys = (trust: Trust): ListKey[] => trust.keys.filter(k => !trust.retired.includes(k.keyId));
/** 안쪽 목록 서명을 볼 키 = 그 목록의 원래 내장 키 + 믿는 운영 키 − 은퇴한 키. */
export function partKeys(trust: Trust, builtinForPart: readonly ListKey[]): ListKey[] {
  const out = new Map<string, ListKey>();
  for (const k of [...builtinForPart, ...trust.keys]) if (!trust.retired.includes(k.keyId)) out.set(k.keyId, { keyId: k.keyId, publicKey: k.publicKey });
  return [...out.values()];
}

/* ── 묶음 검증 ──────────────────────────────────────────────────────── */

export const bundleSigningBytes = (body: BundleBody) => utf8(`${LISTS_DOMAIN}\n${canonicalJson(body)}`);
export const partSha256 = (p: PartPayload) => sha256Hex(utf8(canonicalJson({ doc: p.doc, signature: p.signature })));

/**
 * 묶음이 쓰는 목록 하나를 검사하는 함수(안쪽 서명 + 내용). 맞으면 쓸 값(얼린 사본 등)을 돌려주고, 틀리면 던진다.
 * keys = partKeys(믿음, 그 목록의 원래 내장 키).
 */
export type PartVerifier = (doc: unknown, signature: unknown, keys: readonly ListKey[]) => unknown;
export type PartVerifiers = Partial<Record<PartName, { builtinKeys: readonly ListKey[]; verify: PartVerifier }>>;

export type VerifiedBundle = {
  sequence: number; issuedAt: string; expiresAt: string; issuedAtMs: number; expiresAtMs: number;
  /** verifiers 가 있는 목록만 값이 있다. null = 묶음이 「이 목록 없음」이라고 서명했다. */
  values: Partial<Record<PartName, unknown | null>>;
  trust: Trust; bodyCanonical: string;
};

/**
 * 묶음 글자 → 검증된 묶음. 시간·일련번호는 여기서 보지 않는다(applyBundle 이 본다). 하나라도 틀리면 던진다 — 부분 결과는 없다.
 * trust 는 지금까지 적용한 키 전환까지 반영한 믿음. 묶음에 실린 전환 문 중 새것(순번이 이어지는 것)을 먼저 적용한 믿음으로 바깥 서명을 본다.
 */
export function verifyBundleText(text: unknown, trust: Trust, verifiers: PartVerifiers): VerifiedBundle {
  if (typeof text !== 'string') return fail('shape', 'text');
  if (utf8(text).length > MAX_BUNDLE_BYTES) fail('too-large');
  let raw: Loose;
  try { raw = JSON.parse(text); } catch { return fail('not-json'); }
  return verifyBundle(raw, trust, verifiers);
}

export function verifyBundle(raw: unknown, trust: Trust, verifiers: PartVerifiers): VerifiedBundle {
  const b = raw as Loose;
  if (!plain(b) || !keysAre(b, 'format,version,body,parts,transitions,signature') || b.format !== LISTS_FORMAT || b.version !== LISTS_VERSION) return fail('shape', 'bundle');
  const body = b.body as Loose;
  if (!plain(body) || !keysAre(body, 'sequence,issuedAt,expiresAt,parts') || !int(body.sequence, 1, Number.MAX_SAFE_INTEGER) ||
      !plain(body.parts) || !partKeysOk(body.parts) || !plain(b.parts) || !partKeysOk(b.parts) ||
      ('feeSchedule' in body.parts) !== ('feeSchedule' in b.parts)) fail('shape', 'body');
  const issuedAtMs = isoTime(body.issuedAt), expiresAtMs = isoTime(body.expiresAt);
  for (const name of PART_NAMES) {
    const h = body.parts[name] ?? null, p = b.parts[name] ?? null;
    if (h === null && p === null) continue;
    if (!plain(h) || !keysAre(h, 'sha256') || typeof h.sha256 !== 'string' || !SHA.test(h.sha256) || !plain(p) || !keysAre(p, 'doc,signature')) fail('shape', 'part-' + name);
  }
  // 키 전환 문: 이미 적용한 것은 글자 그대로 같아야 하고(갈림 방지), 그 뒤 것만 차례로 적용한다.
  if (!Array.isArray(b.transitions) || b.transitions.length > MAX_TRANSITIONS) fail('transition', 'list');
  let t = trust;
  (b.transitions as unknown[]).forEach((tr, i) => {
    if (i < trust.transitions.length) { if (canonicalJson(tr) !== canonicalJson(trust.transitions[i])) fail('transition', 'fork'); }
    else t = applyTransition(t, tr);
  });
  const s = b.signature as Loose;
  if (!plain(s) || !keysAre(s, 'keyId,algorithm,domain,signature') || s.algorithm !== 'Ed25519' || s.domain !== LISTS_DOMAIN ||
      typeof s.keyId !== 'string' || !KEY_ID.test(s.keyId) || typeof s.signature !== 'string') fail('shape', 'signature');
  const key = liveKeys(t).find(k => k.keyId === s.keyId);
  if (!key) fail('unknown-key');
  let bodyCanonical: string;
  try { bodyCanonical = canonicalJson(body); } catch { return fail('shape', 'canonical'); }
  if (!verifyWith(key!, s.signature, bundleSigningBytes(body as BundleBody))) fail('signature');
  // 서명된 해시와 실린 목록이 같아야 한다(쓰지 않는 목록도 — 서명되지 않은 바이트는 하나도 받지 않는다).
  for (const name of PART_NAMES) {
    const p = b.parts[name] ?? null;
    if (p === null) continue;
    let sha: string;
    try { sha = partSha256(p); } catch { return fail('part-hash', name); }
    if (sha !== body.parts[name].sha256) fail('part-hash', name);
  }
  const values: VerifiedBundle['values'] = {};
  for (const name of PART_NAMES) {
    const v = verifiers[name];
    if (!v) continue;
    const p = b.parts[name] ?? null;
    if (p === null) { values[name] = null; continue; }
    try { values[name] = v.verify(JSON.parse(JSON.stringify(p.doc)), JSON.parse(JSON.stringify(p.signature)), partKeys(t, v.builtinKeys)); }
    catch (e) { return fail('part-invalid', `${name}: ${(e as Error)?.message ?? 'invalid'}`.slice(0, 200)); }
  }
  return { sequence: body.sequence, issuedAt: body.issuedAt, expiresAt: body.expiresAt, issuedAtMs, expiresAtMs, values, trust: t, bodyCanonical };
}

/* ── 상태: 마지막으로 검증된 묶음 + 일련번호 바닥 + 키 전환 ───────────────── */

/** 저장되는 상태. 저장소에서 다시 읽을 때 묶음·전환을 처음부터 다시 검증한다(저장된 값을 믿지 않는다). */
export type ListsState = { format: typeof STATE_FORMAT; version: 1; sequenceFloor: number; transitions: KeyTransition[]; bundle: string | null };
export const emptyState = (): ListsState => ({ format: STATE_FORMAT, version: 1, sequenceFloor: 0, transitions: [], bundle: null });

export type ApplyResult = { applied: true; changed: boolean; state: ListsState; verified: VerifiedBundle }
  | { applied: false; reason: RejectReason; detail: string; state: ListsState };

/** 저장된 전환 문을 내장 키부터 다시 적용한 믿음. 하나라도 틀리면 그 앞까지만(저장소가 망가져도 내장 키로는 돌아간다). */
export function trustFromState(state: ListsState, builtin: readonly ListKey[]): Trust {
  let t = initialTrust(builtin);
  for (const tr of state.transitions ?? []) { try { t = applyTransition(t, tr); } catch { break; } }
  return t;
}

/**
 * 받은 묶음 글자를 지금 상태에 적용한다. 순수 함수 — 저장은 호출자가 한다.
 * 실패하면 **상태를 그대로** 돌려준다(마지막으로 검증된 목록 유지). 성공하면 일련번호 바닥·전환·묶음 글자가 함께 바뀐다.
 */
export function applyBundle(state: ListsState, text: unknown, now: number, builtin: readonly ListKey[], verifiers: PartVerifiers): ApplyResult {
  const keep = (reason: RejectReason, detail = ''): ApplyResult => ({ applied: false, reason, detail, state });
  let v: VerifiedBundle;
  try { v = verifyBundleText(text, trustFromState(state, builtin), verifiers); }
  catch (e) { return e instanceof SignedListsError ? keep(e.code, e.detail) : keep('shape', 'unexpected'); }
  if (v.sequence < state.sequenceFloor) return keep('rollback', `${v.sequence} < ${state.sequenceFloor}`);
  if (v.sequence === state.sequenceFloor) {
    let same = false;
    try { same = state.bundle !== null && verifyBundleText(state.bundle, trustFromState(state, builtin), {}).bodyCanonical === v.bodyCanonical; } catch { same = false; }
    return same ? { applied: true, changed: false, state, verified: v } : keep('same-sequence-different', String(v.sequence));
  }
  if (v.issuedAtMs > now + CLOCK_SKEW_MS) return keep('not-yet-valid');
  if (v.expiresAtMs <= now) return keep('expired');
  if (v.expiresAtMs <= v.issuedAtMs || v.expiresAtMs - v.issuedAtMs > MAX_LIFETIME_MS) return keep('lifetime');
  const next: ListsState = { format: STATE_FORMAT, version: 1, sequenceFloor: v.sequence, transitions: v.trust.transitions.map(t => JSON.parse(JSON.stringify(t))), bundle: text as string };
  return { applied: true, changed: true, state: next, verified: v };
}

/** 저장된 상태를 읽는다. 모양이 틀리면 빈 상태(내장 기본값). 일련번호 바닥은 숫자 모양만 맞으면 지킨다. */
export function parseState(text: unknown): ListsState {
  try {
    const s = JSON.parse(String(text));
    if (!plain(s) || s.format !== STATE_FORMAT || s.version !== 1 || !int(s.sequenceFloor, 0, Number.MAX_SAFE_INTEGER) ||
        !Array.isArray(s.transitions) || s.transitions.length > MAX_TRANSITIONS || !(s.bundle === null || typeof s.bundle === 'string')) return emptyState();
    return { format: STATE_FORMAT, version: 1, sequenceFloor: s.sequenceFloor, transitions: s.transitions, bundle: s.bundle };
  } catch { return emptyState(); }
}

export type CurrentLists = {
  /** builtin = 받은 묶음 없음 · update = 유효한 최신 묶음 · expired = 마지막 묶음이 만료(허용은 기본값으로, 차단은 유지) */
  source: 'builtin' | 'update' | 'expired';
  sequence: number; expiresAt: string | null; trust: Trust;
  values: Partial<Record<PartName, unknown | null>>;
};
/**
 * 지금 쓸 목록. 저장된 묶음을 다시 검증하고(틀리면 내장 기본값), 만료됐으면 source 'expired' 로 알린다 —
 * 어느 목록을 기본값으로 되돌릴지는 호출자 정책(지갑: 허용 목록·등록부는 기본값, 차단 목록은 유지 — wallet.ts / creator-parts.ts).
 */
export function currentLists(state: ListsState, now: number, builtin: readonly ListKey[], verifiers: PartVerifiers): CurrentLists {
  const trust = trustFromState(state, builtin);
  if (!state.bundle) return { source: 'builtin', sequence: state.sequenceFloor, expiresAt: null, trust, values: {} };
  let v: VerifiedBundle;
  try { v = verifyBundleText(state.bundle, trust, verifiers); } catch { return { source: 'builtin', sequence: state.sequenceFloor, expiresAt: null, trust, values: {} }; }
  return { source: v.expiresAtMs <= now ? 'expired' : 'update', sequence: v.sequence, expiresAt: v.expiresAt, trust: v.trust, values: v.values };
}

/* ── 서명기(대표 도구·시험 전용 — 앱은 부르지 않는다) ─────────────────────── */

/** 32바이트 ed25519 비밀값으로 묶음을 만든다. 시험과 sign-lists.mjs 의 참고 구현. */
export function signBundle(p: { sequence: number; issuedAt: string; expiresAt: string; parts: Partial<Record<PartName, PartPayload | null>>; transitions?: KeyTransition[] }, privateKey: Uint8Array): SignedBundle {
  const parts = Object.fromEntries(PART_NAMES.map(n => [n, p.parts[n] ?? null])) as Record<PartName, PartPayload | null>;
  const body: BundleBody = { sequence: p.sequence, issuedAt: p.issuedAt, expiresAt: p.expiresAt,
    parts: Object.fromEntries(PART_NAMES.map(n => [n, parts[n] ? { sha256: partSha256(parts[n]!) } : null])) as BundleBody['parts'] };
  const pub = ed25519.getPublicKey(privateKey);
  return { format: LISTS_FORMAT, version: 1, body, parts, transitions: p.transitions ?? [],
    signature: { keyId: keyIdOf(pub), algorithm: 'Ed25519', domain: LISTS_DOMAIN, signature: b64urlEncode(ed25519.sign(bundleSigningBytes(body), privateKey)) } };
}
/** 키 전환 문. signers = [지금 믿는 키의 비밀값, …], 새 키 비밀값은 newKey. */
export function signTransition(p: { index: number; issuedAt: string; newKey: Uint8Array; retire?: string[]; signers: Uint8Array[] }): KeyTransition {
  const pub = ed25519.getPublicKey(p.newKey);
  const add = { keyId: keyIdOf(pub), publicKey: b64urlEncode(pub) };
  const t = { format: TRANSITION_FORMAT as typeof TRANSITION_FORMAT, version: 1 as const, index: p.index, issuedAt: p.issuedAt, add, retire: p.retire ?? [] };
  const msg = transitionSigningBytes(t);
  const signatures = [...p.signers, p.newKey].map(k => ({ keyId: keyIdOf(ed25519.getPublicKey(k)), signature: b64urlEncode(ed25519.sign(msg, k)) }));
  return { ...t, signatures };
}
export const publicListKey = (privateKey: Uint8Array): ListKey => { const pub = ed25519.getPublicKey(privateKey); return { keyId: keyIdOf(pub), publicKey: b64urlEncode(pub) }; };
