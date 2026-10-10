import { sha256 } from '@noble/hashes/sha256';
import { ed25519 } from '@noble/curves/ed25519';
import { PLATFORM_FEE_BPS_MAX } from '../game-registry/platform-fee';
import { b64urlDecode, b64urlEncode, canonicalJson, hex, plain, sha256Hex, utf8, type Loose } from './bytes';
import { CREATOR_ASSET_PREFIX, checkCreatorAssetName } from './asset-name';
import { CID_V0, CreatorError, isRvnAddress, verifyManifest, type CreatorManifest } from './manifest';
import { isContentType, type ContentType } from './limits';
import { assetPrefixFor, nameConflicts } from './asset-name';
import { activeFeeSchedule, freeListingAllowed, manifestFeeRef, type FeeSchedule } from './fee-schedule';
import { BONDED_BADGE, OPEN_MARKET_GAME_INDEX, bondBlockers, type AutoCheck, type BondBlocker } from './open-market';

/*
 * 발견·등록 신청·「검증됨」 판정.
 *
 * 서버는 없다. 목록은 체인 자산 검색(listassets "RV.*", 종류 탭은 "RV.M.*" — asset-name.ts kindSearchPattern)으로 찾고, 각 자산의 ipfs_hash 가 가리키는 매니페스트를
 * 받아 서명·형식을 확인한다. 신뢰 3층(open-market.ts): 미검증 → 보증(자동 점검 + 루트 소각, 결제+경고) → 검증됨(대표 서명 허용 목록).
 * 대표가 서명한 차단 목록(deny)에 있으면 어느 층이든 숨긴다. 허용·차단 목록은 같은 Ed25519 방식이고 도메인만 다르다.
 *
 * 허용 목록 서명은 게임 허용 목록과 같은 바이트 규칙(DOMAIN \n listVersion \n issuedAt \n canonicalJson(doc), Ed25519 분리
 * 서명)이지만 도메인이 다르다 — 게임 등록부 서명을 제작자 목록으로 재사용할 수 없다.
 *
 * 🔴 CREATOR_ALLOWLIST_PUBLIC_KEYS 는 **비어 있다.** 운영 키를 누가 어디서 만들지 정하기 전(대표 결정)에는 아무것도
 *    「검증됨」이 되지 않는다. 시험은 일회용 키를 넘긴다.
 */

export const CREATOR_ALLOWLIST_FORMAT = 'rv-creator-allowlist';
export const CREATOR_ALLOWLIST_DOMAIN = 'RAVENVAULT-CREATOR-ALLOWLIST-V1';
export const CREATOR_SIGNATURE_FORMAT = 'rv-creator-allowlist-signature';
export const CREATOR_DENYLIST_FORMAT = 'rv-creator-denylist';
export const CREATOR_DENYLIST_DOMAIN = 'RAVENVAULT-CREATOR-DENYLIST-V1';
export const CREATOR_DENY_SIGNATURE_FORMAT = 'rv-creator-denylist-signature';
export type AllowlistKey = { readonly keyId: string; readonly publicKey: string };
export const CREATOR_ALLOWLIST_PUBLIC_KEYS: readonly AllowlistKey[] = Object.freeze([]);

export type AllowlistEntry = {
  asset: string; type: ContentType; manifestCid: string; manifestSha256: string; creatorAddress: string; receivingAddress: string;
  /** 결제 메모(RVDP v3)·신원 키 경로에 쓰는 영구 번호. 게임 등록부 대장(add-a-game.md)에서 받는다. */
  gameIndex: number; feeBps: number; origins: string[]; status: 'verified' | 'suspended'; verifiedAt: string;
};
export type CreatorAllowlist = { format: typeof CREATOR_ALLOWLIST_FORMAT; version: 1; entries: AllowlistEntry[] };
export type CreatorAllowlistSignature = { format: typeof CREATOR_SIGNATURE_FORMAT | typeof CREATOR_DENY_SIGNATURE_FORMAT; version: 1; keyId: string; listVersion: number; issuedAt: string;
  algorithm: 'Ed25519'; domain: typeof CREATOR_ALLOWLIST_DOMAIN | typeof CREATOR_DENYLIST_DOMAIN; docSha256: string; signature: string };

const fail = (code: 'allowlist-signature' | 'allowlist-shape', detail = ''): never => { throw new CreatorError(code, detail); };
const keysAre = (o: Record<string, Loose>, keys: string) => Object.keys(o).sort().join() === keys.split(',').sort().join();
const int = (n: unknown, min: number, max: number): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= min && n <= max;
export const keyIdOf = (publicRaw: Uint8Array) => hex(sha256(publicRaw).slice(0, 8));

export function validateCreatorAllowlist(raw: unknown, prefix: string = CREATOR_ASSET_PREFIX): CreatorAllowlist {
  if (!plain(raw) || !keysAre(raw, 'format,version,entries') || raw.format !== CREATOR_ALLOWLIST_FORMAT || raw.version !== 1 ||
      !Array.isArray(raw.entries) || raw.entries.length > 4096) return fail('allowlist-shape', 'doc');
  const assets = new Set<string>(), indexes = new Set<number>();
  for (const e of raw.entries as Loose[]) {
    if (!plain(e) || !keysAre(e, 'asset,type,manifestCid,manifestSha256,creatorAddress,receivingAddress,gameIndex,feeBps,origins,status,verifiedAt')) fail('allowlist-shape', 'entry-keys');
    if (!checkCreatorAssetName(e.asset, prefix, { type: isContentType(e.type) ? e.type : null }).valid || assets.has(e.asset)) fail('allowlist-shape', 'asset');
    if (!isContentType(e.type) || typeof e.manifestCid !== 'string' || !CID_V0.test(e.manifestCid) ||
        typeof e.manifestSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(e.manifestSha256)) fail('allowlist-shape', 'manifest');
    if (!isRvnAddress(e.creatorAddress) || !isRvnAddress(e.receivingAddress)) fail('allowlist-shape', 'address');
    // 0..65533: 65534 는 열린 장터 (b)층 구매 메모(OPEN_MARKET_GAME_INDEX), 65535 는 시험 데모 게임 전용으로 영구 예약.
    if (!int(e.gameIndex, 0, OPEN_MARKET_GAME_INDEX - 1) || indexes.has(e.gameIndex) || !int(e.feeBps, 0, PLATFORM_FEE_BPS_MAX)) fail('allowlist-shape', 'index-fee');
    if (!Array.isArray(e.origins) || e.origins.length < 1 || e.origins.length > 8 ||
        e.origins.some((o: unknown) => { try { const u = new URL(String(o)); return u.protocol !== 'https:' || u.origin !== o; } catch { return true; } })) fail('allowlist-shape', 'origins');
    if ((e.status !== 'verified' && e.status !== 'suspended') || typeof e.verifiedAt !== 'string' || !Number.isFinite(Date.parse(e.verifiedAt))) fail('allowlist-shape', 'status');
    assets.add(e.asset); indexes.add(e.gameIndex);
  }
  return raw as CreatorAllowlist;
}

type SignedKind = { domain: string; sigFormat: string };
const ALLOW: SignedKind = { domain: CREATOR_ALLOWLIST_DOMAIN, sigFormat: CREATOR_SIGNATURE_FORMAT };
const DENY: SignedKind = { domain: CREATOR_DENYLIST_DOMAIN, sigFormat: CREATOR_DENY_SIGNATURE_FORMAT };
const signedBytes = (k: SignedKind, listVersion: number, issuedAt: string, doc: unknown) => utf8(`${k.domain}\n${listVersion}\n${issuedAt}\n${canonicalJson(doc)}`);
function signDoc(k: SignedKind, doc: unknown, listVersion: number, issuedAt: string, privateKey: Uint8Array): CreatorAllowlistSignature {
  const pub = ed25519.getPublicKey(privateKey);
  return { format: k.sigFormat, version: 1, keyId: keyIdOf(pub), listVersion, issuedAt, algorithm: 'Ed25519', domain: k.domain,
    docSha256: sha256Hex(utf8(canonicalJson(doc))), signature: b64urlEncode(ed25519.sign(signedBytes(k, listVersion, issuedAt, doc), privateKey)) } as CreatorAllowlistSignature;
}
function verifyDoc(k: SignedKind, doc: unknown, signature: unknown, keys: readonly AllowlistKey[]): void {
  const s = signature as Loose;
  if (!plain(s) || !keysAre(s, 'format,version,keyId,listVersion,issuedAt,algorithm,domain,docSha256,signature') || s.format !== k.sigFormat ||
      s.version !== 1 || s.algorithm !== 'Ed25519' || s.domain !== k.domain || typeof s.keyId !== 'string' || !/^[a-f0-9]{16}$/.test(s.keyId) ||
      !int(s.listVersion, 1, Number.MAX_SAFE_INTEGER) || typeof s.issuedAt !== 'string' || !Number.isFinite(Date.parse(s.issuedAt)) ||
      typeof s.docSha256 !== 'string' || typeof s.signature !== 'string') return fail('allowlist-signature', 'shape');
  const key = keys.find(x => x.keyId === s.keyId);
  if (!key) return fail('allowlist-signature', 'unknown-key');
  let ok = false;
  try {
    const raw = b64urlDecode(key.publicKey), sig = b64urlDecode(s.signature);
    ok = raw.length === 32 && sig.length === 64 && keyIdOf(raw) === key.keyId && sha256Hex(utf8(canonicalJson(doc))) === s.docSha256 &&
      ed25519.verify(sig, signedBytes(k, s.listVersion, s.issuedAt, doc), raw);
  } catch { ok = false; }
  if (!ok) fail('allowlist-signature', 'invalid');
}

/** 대표 도구(오프라인)와 시험이 쓰는 서명기. 앱은 이 함수를 부르지 않는다. 개인키는 32바이트 ed25519 비밀값. */
export function signCreatorAllowlist(doc: CreatorAllowlist, listVersion: number, issuedAt: string, privateKey: Uint8Array): CreatorAllowlistSignature {
  validateCreatorAllowlist(doc);
  return signDoc(ALLOW, doc, listVersion, issuedAt, privateKey);
}
/** 서명이 맞기 전에는 목록의 어떤 값도 믿지 않는다. 맞으면 내용까지 검사한 목록을 돌려준다. */
export function verifyCreatorAllowlist(doc: unknown, signature: unknown, keys: readonly AllowlistKey[] = CREATOR_ALLOWLIST_PUBLIC_KEYS): CreatorAllowlist {
  verifyDoc(ALLOW, doc, signature, keys);
  return validateCreatorAllowlist(doc);
}

/* ── 차단 목록(신고 처리 결과) ──────────────────────────────────────────
 * 대표가 서명한다(허용 목록과 같은 키·같은 방식, 도메인만 다르다 — 허용 목록 서명을 차단 목록으로, 또는 반대로 쓸 수 없다).
 * kind 'asset' = 그 상품만, 'creator' = 그 제작자 주소의 모든 상품. 차단은 검증됨보다 앞선다.
 * 신고 접수 경로(누가 어디로 신고하나)는 대표 결정 — 지금은 목록 형식과 검증만 있다.
 */
export type DenyReason = 'scam' | 'impersonation' | 'malware' | 'copyright' | 'illegal' | 'other';
export type DenyEntry = { kind: 'asset' | 'creator'; value: string; reason: DenyReason; addedAt: string };
export type CreatorDenylist = { format: typeof CREATOR_DENYLIST_FORMAT; version: 1; entries: DenyEntry[] };
const DENY_REASONS = new Set(['scam', 'impersonation', 'malware', 'copyright', 'illegal', 'other']);
export function validateCreatorDenylist(raw: unknown, prefix: string = CREATOR_ASSET_PREFIX): CreatorDenylist {
  if (!plain(raw) || !keysAre(raw, 'format,version,entries') || raw.format !== CREATOR_DENYLIST_FORMAT || raw.version !== 1 ||
      !Array.isArray(raw.entries) || raw.entries.length > 65536) return fail('allowlist-shape', 'deny-doc');
  const seen = new Set<string>();
  for (const e of raw.entries as Loose[]) {
    if (!plain(e) || !keysAre(e, 'kind,value,reason,addedAt') || !DENY_REASONS.has(e.reason) || typeof e.addedAt !== 'string' || !Number.isFinite(Date.parse(e.addedAt))) fail('allowlist-shape', 'deny-entry');
    if (e.kind === 'asset' ? !checkCreatorAssetName(e.value, prefix).valid : e.kind === 'creator' ? !isRvnAddress(e.value) : true) fail('allowlist-shape', 'deny-value');
    const k = e.kind + ':' + e.value;
    if (seen.has(k)) fail('allowlist-shape', 'deny-duplicate');
    seen.add(k);
  }
  return raw as CreatorDenylist;
}
export function signCreatorDenylist(doc: CreatorDenylist, listVersion: number, issuedAt: string, privateKey: Uint8Array): CreatorAllowlistSignature {
  validateCreatorDenylist(doc);
  return signDoc(DENY, doc, listVersion, issuedAt, privateKey);
}
export function verifyCreatorDenylist(doc: unknown, signature: unknown, keys: readonly AllowlistKey[] = CREATOR_ALLOWLIST_PUBLIC_KEYS): CreatorDenylist {
  verifyDoc(DENY, doc, signature, keys);
  return validateCreatorDenylist(doc);
}
const denied = (deny: CreatorDenylist | null, asset: string, m: CreatorManifest | null): DenyEntry | null =>
  deny?.entries.find(e => (e.kind === 'asset' && e.value === asset) || (m !== null && e.kind === 'creator' && (e.value === m.creator.address || e.value === m.creator.receivingAddress))) ?? null;

/* ── 등록 신청서 ───────────────────────────────────────────────────── */

export const LISTING_REQUEST_FORMAT = 'rv-creator-listing-request';
export type ListingRequest = {
  format: typeof LISTING_REQUEST_FORMAT; version: 1; asset: string; type: ContentType; manifestCid: string; manifestSha256: string;
  creatorAddress: string; receivingAddress: string; issueTxid: string | null; requestedAt: string; status: 'unverified';
};
/**
 * 제작자가 저장·전달하는 등록 신청서. 서버에 올리지 않는다 — 발견은 체인 검색으로 되고, 신청서는 「검증해 주세요」라는
 * 사람 사이의 문서다(전달 경로는 대표 결정). 이 문서만으로는 아무것도 열리지 않는다(status 는 늘 unverified).
 */
export function buildListingRequest(p: { manifest: CreatorManifest; manifestCid: string; manifestSha256: string; issueTxid: string | null; now: Date }): ListingRequest {
  if (!CID_V0.test(p.manifestCid) || !/^[a-f0-9]{64}$/.test(p.manifestSha256) || (p.issueTxid !== null && !/^[a-f0-9]{64}$/.test(p.issueTxid))) throw new CreatorError('manifest-shape', 'request');
  return { format: LISTING_REQUEST_FORMAT, version: 1, asset: p.manifest.asset, type: p.manifest.type, manifestCid: p.manifestCid, manifestSha256: p.manifestSha256,
    creatorAddress: p.manifest.creator.address, receivingAddress: p.manifest.creator.receivingAddress, issueTxid: p.issueTxid, requestedAt: p.now.toISOString(), status: 'unverified' };
}

/* ── 발견 + 판정 ───────────────────────────────────────────────────── */

export type ChainAsset = { name: string; ipfs_hash: string | null };
type Base = { asset: string; manifestCid: string; manifest: CreatorManifest; manifestSha256: string; lookalikes: string[]; officialLooking: boolean };
export type Listing =
  | { status: 'hidden'; asset: string; reason: string }
  | (Base & { status: 'unverified'; reason: 'not-listed' | 'suspended' | 'changed-since-review'; bondBlockers: BondBlocker[];
      access: 'external-link-only'; identity: false; payment: false; badge: '미검증'; autoCheck: AutoCheck | null })
  | (Base & { status: 'bonded'; reason: 'bonded'; bondBlockers: []; access: 'download'; identity: false; payment: true; badge: typeof BONDED_BADGE; autoCheck: AutoCheck })
  | (Base & { status: 'verified'; entry: AllowlistEntry; access: 'in-wallet' | 'download'; identity: boolean; payment: boolean; badge: '검증됨'; autoCheck: AutoCheck | null });

export type JudgeOptions = { denylist?: CreatorDenylist | null; autoCheck?: AutoCheck | null; now?: number; prefix?: string;
  /** 수수료 일정(가격 없는 상품을 그 종류에서 보일지 — freePrice). 기본 = 지금 쓰는 일정. */
  schedule?: FeeSchedule | null };

/**
 * 체인 자산 하나 → 목록 항목.
 *  · 매니페스트를 못 받거나 깨졌거나 서명이 틀리거나 남의 매니페스트(asset 칸 불일치)면 숨긴다(hidden). 차단 목록에 있어도 숨긴다.
 *  · 허용 목록 항목과 (자산·종류·매니페스트 CID·바이트 SHA-256·제작자·받는 주소)가 **전부** 같고 verified 면 검증됨.
 *    결제는 검증됨 + 가격 있음 + 수수료 칸이 일정 참조(옛 선언은 manifestFeeRef 호환 규칙)일 때만(게임은 결제 요청 칸도 켜져 있어야).
 *    허용 목록 feeBps 는 이제 「그 상품에 대표가 정한 최대 요율」(일정 요율보다 낮으면 그 값, 예: 회사 자기 상품 0).
 *  · 아니면 (b) 보증 조건(open-market.ts bondBlockers)을 본다. 이유가 하나도 없으면 보증(결제+경고), 하나라도 있으면 미검증.
 */
export function judgeListing(asset: ChainAsset, manifestBytes: Uint8Array | null, allowlist: CreatorAllowlist | null, opts: JudgeOptions | string = {}): Listing {
  const o: JudgeOptions = typeof opts === 'string' ? { prefix: opts } : opts;
  const prefix = o.prefix ?? CREATOR_ASSET_PREFIX, now = o.now ?? Date.now(), check = o.autoCheck ?? null;
  if (!asset.name.startsWith(prefix) || asset.name.endsWith('!')) return { status: 'hidden', asset: asset.name, reason: 'not-creator-asset' };
  if (denied(o.denylist ?? null, asset.name, null)) return { status: 'hidden', asset: asset.name, reason: 'denied' };
  if (!asset.ipfs_hash || !CID_V0.test(asset.ipfs_hash)) return { status: 'hidden', asset: asset.name, reason: 'no-manifest' };
  if (!manifestBytes) return { status: 'hidden', asset: asset.name, reason: 'manifest-unavailable' };
  let manifest: CreatorManifest, sha: string;
  try { const v = verifyManifest(manifestBytes, { expectedAsset: asset.name, prefix }); manifest = v.manifest; sha = v.bytesSha256; }
  catch (e) { return { status: 'hidden', asset: asset.name, reason: (e as CreatorError).code ?? 'manifest-invalid' }; }
  if (denied(o.denylist ?? null, asset.name, manifest)) return { status: 'hidden', asset: asset.name, reason: 'denied' };
  if (manifest.price === null && !freeListingAllowed(o.schedule === undefined ? activeFeeSchedule() : o.schedule, manifest.type)) return { status: 'hidden', asset: asset.name, reason: 'free-not-allowed' };
  const conflict = nameConflicts(asset.name, manifest.title, [], prefix);
  const base: Base = { asset: asset.name, manifestCid: asset.ipfs_hash, manifest, manifestSha256: sha, lookalikes: [], officialLooking: conflict.officialLooking };
  const entry = allowlist?.entries.find(e => e.asset === asset.name);
  if (entry && entry.status === 'verified' && entry.type === manifest.type && entry.manifestCid === asset.ipfs_hash && entry.manifestSha256 === sha &&
      entry.creatorAddress === manifest.creator.address && entry.receivingAddress === manifest.creator.receivingAddress) {
    const game = manifest.type === 'game' ? manifest.details as { capabilities: { identity: boolean; payment: boolean } } : null;
    // 수수료 칸 = 일정 참조(또는 호환 규칙을 통과한 옛 선언). 실제 요율은 구매 시점에 일정에서(purchase.ts).
    const payment = manifest.price !== null && manifestFeeRef(manifest.fee, entry.feeBps).ok && (game === null || game.capabilities.payment === true);
    return { status: 'verified', ...base, entry, access: game ? 'in-wallet' : 'download', identity: game?.capabilities.identity === true, payment, badge: '검증됨', autoCheck: check };
  }
  const reason = !entry ? 'not-listed' as const : entry.status !== 'verified' ? 'suspended' as const : 'changed-since-review' as const;
  const blockers = bondBlockers(manifest, asset.name, check, now, prefix);
  // 대표가 「정지」한 항목은 보증으로도 팔지 않는다.
  if (reason !== 'suspended' && blockers.length === 0 && check)
    return { status: 'bonded', ...base, reason: 'bonded', bondBlockers: [], access: 'download', identity: false, payment: true, badge: BONDED_BADGE, autoCheck: check };
  return { status: 'unverified', ...base, reason, bondBlockers: blockers, access: 'external-link-only',
    identity: false, payment: false, badge: '미검증', autoCheck: check };
}

/**
 * 여러 자산을 한꺼번에. 숨긴 것은 빼고, 검증됨 → 보증 → 미검증 순. 서로 비슷한 이름(사칭 의심)을 lookalikes 에 붙인다.
 * type 을 주면 그 종류 글자로 시작하는 자산(kindSearchPattern(type) = 「RV.M.*」)만 본다 — 종류 탭. 노드 검색이 넓게 돌려줘도 여기서 한 번 더 거른다.
 * 이름의 종류 글자와 매니페스트 type 이 다르면 매니페스트 검사에서 숨긴다(manifest-asset).
 */
export async function discoverListings(p: { assets: readonly ChainAsset[]; fetchManifest: (cid: string) => Promise<Uint8Array | null>; allowlist: CreatorAllowlist | null;
  denylist?: CreatorDenylist | null; autoChecks?: ReadonlyMap<string, AutoCheck>; now?: number; prefix?: string; type?: ContentType | null; schedule?: FeeSchedule | null }): Promise<Listing[]> {
  const out: Listing[] = [];
  const kindHead = p.type ? assetPrefixFor(p.type, p.prefix ?? CREATOR_ASSET_PREFIX) : null;
  for (const a of p.assets) {
    if (kindHead && !String(a?.name ?? '').startsWith(kindHead)) continue;
    let bytes: Uint8Array | null = null;
    if (a.ipfs_hash && CID_V0.test(a.ipfs_hash)) { try { bytes = await p.fetchManifest(a.ipfs_hash); } catch { bytes = null; } }
    out.push(judgeListing(a, bytes, p.allowlist, { denylist: p.denylist, autoCheck: p.autoChecks?.get(a.name) ?? null, now: p.now, prefix: p.prefix, schedule: p.schedule }));
  }
  const visible = out.filter((l): l is Exclude<Listing, { status: 'hidden' }> => l.status !== 'hidden');
  const neighbors = visible.map(l => ({ asset: l.asset, title: l.manifest.title }));
  for (const l of visible) l.lookalikes = nameConflicts(l.asset, l.manifest.title, neighbors, p.prefix ?? CREATOR_ASSET_PREFIX).similar.map(s => s.asset);
  const rank = (l: Listing) => l.status === 'verified' ? 0 : l.status === 'bonded' ? 1 : 2;
  return visible.sort((a, b) => rank(a) - rank(b) || a.asset.localeCompare(b.asset));
}
