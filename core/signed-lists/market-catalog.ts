import { ed25519 } from '@noble/curves/ed25519';
import { b64urlDecode, b64urlEncode, plain, sha256Hex, utf8, type Loose } from '../creator/bytes';
import { checkCreatorAssetName } from '../creator/asset-name';
import { isContentType, type ContentType } from '../creator/limits';
import { CID_V0, CreatorError, isRvnAddress, verifyManifest, type CreatorManifest } from '../creator/manifest';
import { OPERATING_LIST_KEYS } from '../creator/operating-keys';
import { MAX_BUNDLE_BYTES, canonicalJson, keyIdOf, type ListKey } from './envelope';
import { SIGNING_DOMAINS, brandUrl } from '../brand/brand';
import { httpSource, storageStore, type FetchLike, type ListSource, type StateStore } from './sources';

/*
 * 서명된 장터 상품 목록(진열대) — C3, 2026-10-12. 지갑·데스크탑 공용(데스크탑은 바이트 그대로 복사).
 *
 * 무엇: 「지금 장터에 올라온 상품」을 대표(운영 키)가 서명한 JSON 한 파일로 받는다. 서버·DB 없음 — 지갑 사이트의 정적 파일
 *   https://ravenvault.ex.erci.se/lists/market-catalog.json (release-site/lists/, 같은 출처라 CSP 변경 없음). 전달 경로는 믿지 않는다(서명이 전부다).
 * 왜 따로: 상품을 찾는 데 노드 listassets 가 필요 없게(C1 이 연결되기 전에도 목록을 그릴 수 있게) 하고, 서명 안 된 목록은 아예 그리지 않기 위해서다.
 *   이 목록은 「보여 줄 후보」일 뿐이다. 결제 자격은 서명된 허용 목록(creatorAllowlist)이 따로 정한다(payment-allowlist.ts) —
 *   이 목록에 있다고 살 수 있는 것이 아니다. 차단 목록(creatorDenylist)에 있으면 judgeListing 이 어느 경우든 숨긴다.
 *
 * 형식 `rv-market-catalog` v1:
 *   { format, version:1, sequence, issuedAt, expiresAt,
 *     entries:[ { asset:'RV.M.NAME', type, manifestCid:'Qm…', manifestSha256:<hex>, creatorAddress:'R…', listedAt:<ISO> } … ≤ 2000 ],
 *     signature:{ keyId, algorithm:'Ed25519', domain:'RAVENVAULT-MARKET-CATALOG-V1', signature:<base64url> } }
 *   서명 대상 = `RAVENVAULT-MARKET-CATALOG-V1\n` + canonicalJson({format, version, sequence, issuedAt, expiresAt, entries}).
 *   목록 서명 도메인과 다르다 — 다른 목록의 서명을 재사용할 수 없다. 키는 서명된 목록 묶음과 같은 운영 키(operating-keys.ts) 또는 키 전환으로 더해진 키.
 *
 * 안전 규칙(시험 있음):
 *  · 서명이 맞지 않으면 한 줄도 보이지 않는다(서명 없음·키 모름·글자 하나 바뀜·도메인 다름 = 거절). 부분 적용 없음.
 *  · sequence 는 올라갈 때만(되돌림·같은 번호 다른 내용 거절), 만료(최대 수명 60일)·미래 발행(1일 초과)·크기(2 MiB)·항목 수(2000) 제한.
 *  · 실패하면 마지막으로 검증된 목록을 유지한다. 단 **만료된 목록은 보여 주지 않는다**(옛 상품이 계속 살아 있는 척하지 않게) — entries 는 빈 배열.
 *  · 믿는 키가 하나도 없으면(출하 상태) 네트워크에 묻지도 않는다.
 *  · 항목은 매니페스트의 해시(manifestSha256)를 고정한다: 매니페스트는 CID 로 받아 verifyCatalogManifest 로 항목과 맞는지 확인한다(게이트웨이가 바꿔치기해도 걸린다).
 * 🔴 개인키는 이 파일에 없다. 서명은 대표 도구(scripts/signed-lists/sign-catalog.ts)가 키 파일 경로로만 받아 한다.
 */

export const CATALOG_FORMAT = 'rv-market-catalog';
export const CATALOG_DOMAIN = SIGNING_DOMAINS.MARKET_CATALOG_V1;
export const CATALOG_STATE_FORMAT = 'rv-market-catalog-state';
export const MARKET_CATALOG_URL = brandUrl('/lists/market-catalog.json');
export const CATALOG_MAX_BYTES = Math.min(2 * 1024 * 1024, MAX_BUNDLE_BYTES);
export const CATALOG_MAX_ENTRIES = 2000;
export const CATALOG_MAX_LIFETIME_MS = 60 * 24 * 3600 * 1000;
export const CATALOG_CLOCK_SKEW_MS = 24 * 3600 * 1000;
export const CATALOG_REFRESH_EVERY_MS = 6 * 3600 * 1000;

export type CatalogEntry = { asset: string; type: ContentType; manifestCid: string; manifestSha256: string; creatorAddress: string; listedAt: string };
export type CatalogBody = { format: typeof CATALOG_FORMAT; version: 1; sequence: number; issuedAt: string; expiresAt: string; entries: CatalogEntry[] };
export type SignedCatalog = CatalogBody & { signature: { keyId: string; algorithm: 'Ed25519'; domain: typeof CATALOG_DOMAIN; signature: string } };

export type CatalogRejectReason = 'too-large' | 'not-json' | 'shape' | 'unknown-key' | 'signature' | 'rollback' | 'same-sequence-different' | 'expired' | 'not-yet-valid' | 'lifetime' | 'network';
export class CatalogError extends Error {
  constructor(readonly code: CatalogRejectReason, readonly detail = '') { super(detail ? `${code}: ${detail}` : code); this.name = 'CatalogError'; }
}
const fail = (code: CatalogRejectReason, detail = ''): never => { throw new CatalogError(code, detail); };
const keysAre = (o: Record<string, Loose>, keys: string) => Object.keys(o).sort().join() === keys.split(',').sort().join();
const SHA = /^[a-f0-9]{64}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;
const isoMs = (s: unknown): number => {
  if (typeof s !== 'string' || s.length > 40 || !ISO.test(s)) return fail('shape', 'time');
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : fail('shape', 'time');
};

const signedBytes = (body: CatalogBody) => utf8(`${CATALOG_DOMAIN}\n${canonicalJson(body)}`);
const bodyOf = (c: CatalogBody): CatalogBody => ({ format: c.format, version: c.version, sequence: c.sequence, issuedAt: c.issuedAt, expiresAt: c.expiresAt, entries: c.entries });

export function validateCatalogBody(raw: unknown): CatalogBody {
  const b = raw as Loose;
  if (!plain(b) || !keysAre(b, 'format,version,sequence,issuedAt,expiresAt,entries') || b.format !== CATALOG_FORMAT || b.version !== 1 ||
      !Number.isSafeInteger(b.sequence) || b.sequence < 1 || !Array.isArray(b.entries) || b.entries.length > CATALOG_MAX_ENTRIES) return fail('shape', 'doc');
  isoMs(b.issuedAt); isoMs(b.expiresAt);
  const seen = new Set<string>();
  for (const e of b.entries as Loose[]) {
    if (!plain(e) || !keysAre(e, 'asset,type,manifestCid,manifestSha256,creatorAddress,listedAt')) return fail('shape', 'entry-keys');
    if (typeof e.asset !== 'string' || !isContentType(e.type) || !checkCreatorAssetName(e.asset, undefined, { type: e.type }).valid || seen.has(e.asset)) return fail('shape', 'asset');
    if (typeof e.manifestCid !== 'string' || !CID_V0.test(e.manifestCid) || typeof e.manifestSha256 !== 'string' || !SHA.test(e.manifestSha256)) return fail('shape', 'manifest');
    if (!isRvnAddress(e.creatorAddress)) return fail('shape', 'address');
    isoMs(e.listedAt);
    seen.add(e.asset);
  }
  return b as CatalogBody;
}

/** 대표 도구·시험 전용 서명기(앱은 부르지 않는다). 개인키는 32바이트 ed25519 비밀값. */
export function signCatalog(body: CatalogBody, privateKey: Uint8Array): SignedCatalog {
  validateCatalogBody(body);
  const pub = ed25519.getPublicKey(privateKey);
  return { ...bodyOf(body), signature: { keyId: keyIdOf(pub), algorithm: 'Ed25519', domain: CATALOG_DOMAIN, signature: b64urlEncode(ed25519.sign(signedBytes(bodyOf(body)), privateKey)) } };
}

export type VerifiedCatalog = { sequence: number; issuedAt: string; expiresAt: string; issuedAtMs: number; expiresAtMs: number; entries: readonly CatalogEntry[]; bodyCanonical: string };

/** 글자 → 검증된 목록. 시간·일련번호는 보지 않는다(applyCatalog 가 본다). 하나라도 틀리면 던진다. */
export function verifyCatalogText(text: unknown, keys: readonly ListKey[] = OPERATING_LIST_KEYS): VerifiedCatalog {
  if (typeof text !== 'string') return fail('shape', 'text');
  if (utf8(text).length > CATALOG_MAX_BYTES) fail('too-large');
  let raw: Loose;
  try { raw = JSON.parse(text); } catch { return fail('not-json'); }
  if (!plain(raw) || !keysAre(raw, 'format,version,sequence,issuedAt,expiresAt,entries,signature')) return fail('shape', 'catalog');
  const sig = raw.signature as Loose;
  if (!plain(sig) || !keysAre(sig, 'keyId,algorithm,domain,signature') || sig.algorithm !== 'Ed25519' || sig.domain !== CATALOG_DOMAIN ||
      typeof sig.keyId !== 'string' || !/^[a-f0-9]{16}$/.test(sig.keyId) || typeof sig.signature !== 'string') return fail('shape', 'signature');
  const { signature: _sig, ...bodyRaw } = raw;
  const body = validateCatalogBody(bodyRaw);
  const key = keys.find(k => k.keyId === sig.keyId);
  if (!key) return fail('unknown-key');
  let ok = false;
  try {
    const pub = b64urlDecode(key.publicKey), sg = b64urlDecode(sig.signature);
    ok = pub.length === 32 && sg.length === 64 && keyIdOf(pub) === key.keyId && ed25519.verify(sg, signedBytes(body), pub);
  } catch { ok = false; }
  if (!ok) fail('signature');
  return { sequence: body.sequence, issuedAt: body.issuedAt, expiresAt: body.expiresAt, issuedAtMs: isoMs(body.issuedAt), expiresAtMs: isoMs(body.expiresAt),
    entries: Object.freeze(body.entries.map(e => Object.freeze({ ...e }))), bodyCanonical: canonicalJson(bodyOf(body)) };
}

/* ── 상태 ──────────────────────────────────────────────────────────── */

export type CatalogState = { format: typeof CATALOG_STATE_FORMAT; version: 1; sequenceFloor: number; text: string | null };
export const emptyCatalogState = (): CatalogState => ({ format: CATALOG_STATE_FORMAT, version: 1, sequenceFloor: 0, text: null });
export function parseCatalogState(text: unknown): CatalogState {
  try {
    const s = JSON.parse(String(text));
    if (!plain(s) || s.format !== CATALOG_STATE_FORMAT || s.version !== 1 || !Number.isSafeInteger(s.sequenceFloor) || s.sequenceFloor < 0 || !(s.text === null || typeof s.text === 'string')) return emptyCatalogState();
    return { format: CATALOG_STATE_FORMAT, version: 1, sequenceFloor: s.sequenceFloor, text: s.text };
  } catch { return emptyCatalogState(); }
}

export type CatalogApply = { applied: true; changed: boolean; state: CatalogState; verified: VerifiedCatalog } | { applied: false; reason: CatalogRejectReason; detail: string; state: CatalogState };

/** 받은 글자를 지금 상태에 적용한다(순수 함수). 실패하면 상태를 그대로 돌려준다. */
export function applyCatalog(state: CatalogState, text: unknown, now: number, keys: readonly ListKey[] = OPERATING_LIST_KEYS): CatalogApply {
  const keep = (reason: CatalogRejectReason, detail = ''): CatalogApply => ({ applied: false, reason, detail, state });
  let v: VerifiedCatalog;
  try { v = verifyCatalogText(text, keys); } catch (e) { return e instanceof CatalogError ? keep(e.code, e.detail) : keep('shape', 'unexpected'); }
  if (v.sequence < state.sequenceFloor) return keep('rollback', `${v.sequence} < ${state.sequenceFloor}`);
  if (v.sequence === state.sequenceFloor) {
    let same = false;
    try { same = state.text !== null && verifyCatalogText(state.text, keys).bodyCanonical === v.bodyCanonical; } catch { same = false; }
    return same ? { applied: true, changed: false, state, verified: v } : keep('same-sequence-different', String(v.sequence));
  }
  if (v.issuedAtMs > now + CATALOG_CLOCK_SKEW_MS) return keep('not-yet-valid');
  if (v.expiresAtMs <= now) return keep('expired');
  if (v.expiresAtMs <= v.issuedAtMs || v.expiresAtMs - v.issuedAtMs > CATALOG_MAX_LIFETIME_MS) return keep('lifetime');
  return { applied: true, changed: true, state: { format: CATALOG_STATE_FORMAT, version: 1, sequenceFloor: v.sequence, text: text as string }, verified: v };
}

export type CurrentCatalog = { source: 'none' | 'update' | 'expired'; sequence: number; expiresAt: string | null; entries: readonly CatalogEntry[] };
/** 지금 보여 줄 목록. 저장된 글자를 다시 검증한다(저장값을 믿지 않는다). 틀렸거나 만료면 빈 목록. */
export function currentCatalog(state: CatalogState, now: number, keys: readonly ListKey[] = OPERATING_LIST_KEYS): CurrentCatalog {
  if (!state.text) return { source: 'none', sequence: state.sequenceFloor, expiresAt: null, entries: [] };
  let v: VerifiedCatalog;
  try { v = verifyCatalogText(state.text, keys); } catch { return { source: 'none', sequence: state.sequenceFloor, expiresAt: null, entries: [] }; }
  return v.expiresAtMs <= now ? { source: 'expired', sequence: v.sequence, expiresAt: v.expiresAt, entries: [] } : { source: 'update', sequence: v.sequence, expiresAt: v.expiresAt, entries: v.entries };
}

/** 매니페스트(CID 로 받은 바이트)가 목록 항목과 정확히 맞는지. 맞으면 검증된 매니페스트, 틀리면 CreatorError 를 던진다. */
export function verifyCatalogManifest(entry: CatalogEntry, bytes: Uint8Array): CreatorManifest {
  const v = verifyManifest(bytes, { expectedAsset: entry.asset });
  if (v.bytesSha256 !== entry.manifestSha256) throw new CreatorError('manifest-shape', 'catalog-hash');
  if (v.manifest.type !== entry.type || v.manifest.creator.address !== entry.creatorAddress) throw new CreatorError('manifest-shape', 'catalog-mismatch');
  return v.manifest;
}

/* ── 받기 ──────────────────────────────────────────────────────────── */

export type CatalogRefresh = { applied: boolean; changed: boolean; source: string | null; tried: Array<{ source: string; reason: CatalogRejectReason | 'ok'; detail?: string }>; state: CatalogState };

export async function refreshMarketCatalog(p: { state: CatalogState; sources: readonly ListSource[]; now: () => number; keys: readonly ListKey[]; store?: StateStore | null }): Promise<CatalogRefresh> {
  const tried: CatalogRefresh['tried'] = [];
  for (const src of p.sources) {
    let text: string;
    try { text = await src.get(); } catch (e) { tried.push({ source: src.id, reason: 'network', detail: String((e as Error)?.message ?? e).slice(0, 80) }); continue; }
    const r = applyCatalog(p.state, text, p.now(), p.keys);
    if (r.applied) {
      tried.push({ source: src.id, reason: 'ok' });
      if (r.changed) p.store?.save(JSON.stringify(r.state));
      return { applied: true, changed: r.changed, source: src.id, tried, state: r.state };
    }
    tried.push({ source: src.id, reason: r.reason, detail: r.detail });
  }
  return { applied: false, changed: false, source: null, tried, state: p.state };
}

export type CatalogBootDeps = {
  fetch?: FetchLike | null; storage?: { getItem(k: string): string | null; setItem(k: string, v: string): void } | null; now?: () => number;
  /** 믿는 키. 기본 = 운영 키. 서명된 목록 묶음의 키 전환을 반영하려면 호출자가 liveKeys(trust) 를 넘긴다. */
  keys?: readonly ListKey[]; sources?: readonly ListSource[];
};
export const CATALOG_STORAGE_KEY = 'rv-market-catalog-v1';

/**
 * 저장된 마지막 유효 목록을 먼저 꺼내고(네트워크 없이), 믿는 키가 있으면 최신을 받아 본다. 🔴 절대 던지지 않는다.
 * 돌려주는 entries 는 서명 검증을 통과한 것뿐이다(없거나 만료면 빈 배열).
 */
export async function loadMarketCatalog(d: CatalogBootDeps = {}): Promise<CurrentCatalog> {
  const none: CurrentCatalog = { source: 'none', sequence: 0, expiresAt: null, entries: [] };
  try {
    const now = d.now ?? Date.now, keys = d.keys ?? OPERATING_LIST_KEYS;
    const store = storageStore(d.storage ?? null, CATALOG_STORAGE_KEY);
    let state = parseCatalogState(store.load());
    if (keys.length === 0) return currentCatalog(state, now(), keys);
    const sources = d.sources ?? (d.fetch ? [httpSource(MARKET_CATALOG_URL, d.fetch, { maxBytes: CATALOG_MAX_BYTES })] : []);
    if (sources.length) state = (await refreshMarketCatalog({ state, sources, now, keys, store })).state;
    return currentCatalog(state, now(), keys);
  } catch { return none; }
}
