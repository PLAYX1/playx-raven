import { sha256 } from '@noble/hashes/sha256';
import { ed25519 } from '@noble/curves/ed25519';
import { PLATFORM_FEE_BPS_MAX } from '../game-registry/platform-fee';
import { b64urlDecode, b64urlEncode, canonicalJson, hex, plain, sha256Hex, utf8, type Loose } from './bytes';
import { CREATOR_ASSET_PREFIX, checkCreatorAssetName } from './asset-name';
import { CID_V0, CreatorError, isRvnAddress, verifyManifest, type CreatorManifest } from './manifest';

/*
 * 발견·등록 신청·「검증됨」 판정.
 *
 * 서버는 없다. 목록은 체인 자산 검색(listassets "<접두어>*")으로 찾고, 각 자산의 ipfs_hash 가 가리키는 매니페스트를
 * 받아 서명·형식을 확인한다. 그 결과는 전부 「미검증」이다. **대표가 서명한 허용 목록(creator allowlist)에 같은 항목이
 * 있을 때만** 「검증됨」이 되고, 검증된 것만 지갑 안에서 열리거나 결제가 붙는다(설계 §3 3층).
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
export type AllowlistKey = { readonly keyId: string; readonly publicKey: string };
export const CREATOR_ALLOWLIST_PUBLIC_KEYS: readonly AllowlistKey[] = Object.freeze([]);

export type AllowlistEntry = {
  asset: string; type: 'game' | 'music'; manifestCid: string; manifestSha256: string; creatorAddress: string; receivingAddress: string;
  /** 결제 메모(RVDP v3)·신원 키 경로에 쓰는 영구 번호. 게임 등록부 대장(add-a-game.md)에서 받는다. */
  gameIndex: number; feeBps: number; origins: string[]; status: 'verified' | 'suspended'; verifiedAt: string;
};
export type CreatorAllowlist = { format: typeof CREATOR_ALLOWLIST_FORMAT; version: 1; entries: AllowlistEntry[] };
export type CreatorAllowlistSignature = { format: typeof CREATOR_SIGNATURE_FORMAT; version: 1; keyId: string; listVersion: number; issuedAt: string;
  algorithm: 'Ed25519'; domain: typeof CREATOR_ALLOWLIST_DOMAIN; docSha256: string; signature: string };

const fail = (code: 'allowlist-signature' | 'allowlist-shape', detail = ''): never => { throw new CreatorError(code, detail); };
const keysAre = (o: Record<string, Loose>, keys: string) => Object.keys(o).sort().join() === keys.split(',').sort().join();
const int = (n: unknown, min: number, max: number): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= min && n <= max;
export const keyIdOf = (publicRaw: Uint8Array) => hex(sha256(publicRaw).slice(0, 8));
export const allowlistSigningBytes = (listVersion: number, issuedAt: string, doc: unknown) =>
  utf8(`${CREATOR_ALLOWLIST_DOMAIN}\n${listVersion}\n${issuedAt}\n${canonicalJson(doc)}`);

export function validateCreatorAllowlist(raw: unknown, prefix: string = CREATOR_ASSET_PREFIX): CreatorAllowlist {
  if (!plain(raw) || !keysAre(raw, 'format,version,entries') || raw.format !== CREATOR_ALLOWLIST_FORMAT || raw.version !== 1 ||
      !Array.isArray(raw.entries) || raw.entries.length > 4096) return fail('allowlist-shape', 'doc');
  const assets = new Set<string>(), indexes = new Set<number>();
  for (const e of raw.entries as Loose[]) {
    if (!plain(e) || !keysAre(e, 'asset,type,manifestCid,manifestSha256,creatorAddress,receivingAddress,gameIndex,feeBps,origins,status,verifiedAt')) fail('allowlist-shape', 'entry-keys');
    if (!checkCreatorAssetName(e.asset, prefix).valid || assets.has(e.asset)) fail('allowlist-shape', 'asset');
    if ((e.type !== 'game' && e.type !== 'music') || typeof e.manifestCid !== 'string' || !CID_V0.test(e.manifestCid) ||
        typeof e.manifestSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(e.manifestSha256)) fail('allowlist-shape', 'manifest');
    if (!isRvnAddress(e.creatorAddress) || !isRvnAddress(e.receivingAddress)) fail('allowlist-shape', 'address');
    // 0..65534: 65535 는 시험 데모 게임 전용으로 영구 예약(game-registry DEMO_GAME_INDEX).
    if (!int(e.gameIndex, 0, 0xfffe) || indexes.has(e.gameIndex) || !int(e.feeBps, 0, PLATFORM_FEE_BPS_MAX)) fail('allowlist-shape', 'index-fee');
    if (!Array.isArray(e.origins) || e.origins.length < 1 || e.origins.length > 8 ||
        e.origins.some((o: unknown) => { try { const u = new URL(String(o)); return u.protocol !== 'https:' || u.origin !== o; } catch { return true; } })) fail('allowlist-shape', 'origins');
    if ((e.status !== 'verified' && e.status !== 'suspended') || typeof e.verifiedAt !== 'string' || !Number.isFinite(Date.parse(e.verifiedAt))) fail('allowlist-shape', 'status');
    assets.add(e.asset); indexes.add(e.gameIndex);
  }
  return raw as CreatorAllowlist;
}

/** 대표 도구(오프라인)와 시험이 쓰는 서명기. 앱은 이 함수를 부르지 않는다. 개인키는 32바이트 ed25519 비밀값. */
export function signCreatorAllowlist(doc: CreatorAllowlist, listVersion: number, issuedAt: string, privateKey: Uint8Array): CreatorAllowlistSignature {
  validateCreatorAllowlist(doc);
  const pub = ed25519.getPublicKey(privateKey);
  return { format: CREATOR_SIGNATURE_FORMAT, version: 1, keyId: keyIdOf(pub), listVersion, issuedAt, algorithm: 'Ed25519', domain: CREATOR_ALLOWLIST_DOMAIN,
    docSha256: sha256Hex(utf8(canonicalJson(doc))), signature: b64urlEncode(ed25519.sign(allowlistSigningBytes(listVersion, issuedAt, doc), privateKey)) };
}

/** 서명이 맞기 전에는 목록의 어떤 값도 믿지 않는다. 맞으면 내용까지 검사한 목록을 돌려준다. */
export function verifyCreatorAllowlist(doc: unknown, signature: unknown, keys: readonly AllowlistKey[] = CREATOR_ALLOWLIST_PUBLIC_KEYS): CreatorAllowlist {
  const s = signature as Loose;
  if (!plain(s) || !keysAre(s, 'format,version,keyId,listVersion,issuedAt,algorithm,domain,docSha256,signature') || s.format !== CREATOR_SIGNATURE_FORMAT ||
      s.version !== 1 || s.algorithm !== 'Ed25519' || s.domain !== CREATOR_ALLOWLIST_DOMAIN || typeof s.keyId !== 'string' || !/^[a-f0-9]{16}$/.test(s.keyId) ||
      !int(s.listVersion, 1, Number.MAX_SAFE_INTEGER) || typeof s.issuedAt !== 'string' || !Number.isFinite(Date.parse(s.issuedAt)) ||
      typeof s.docSha256 !== 'string' || typeof s.signature !== 'string') return fail('allowlist-signature', 'shape');
  const key = keys.find(k => k.keyId === s.keyId);
  if (!key) return fail('allowlist-signature', 'unknown-key');
  let ok = false;
  try {
    const raw = b64urlDecode(key.publicKey), sig = b64urlDecode(s.signature);
    ok = raw.length === 32 && sig.length === 64 && keyIdOf(raw) === key.keyId && sha256Hex(utf8(canonicalJson(doc))) === s.docSha256 &&
      ed25519.verify(sig, allowlistSigningBytes(s.listVersion, s.issuedAt, doc), raw);
  } catch { ok = false; }
  if (!ok) fail('allowlist-signature', 'invalid');
  return validateCreatorAllowlist(doc);
}

/* ── 등록 신청서 ───────────────────────────────────────────────────── */

export const LISTING_REQUEST_FORMAT = 'rv-creator-listing-request';
export type ListingRequest = {
  format: typeof LISTING_REQUEST_FORMAT; version: 1; asset: string; type: 'game' | 'music'; manifestCid: string; manifestSha256: string;
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
export type Listing =
  | { status: 'hidden'; asset: string; reason: string }
  | { status: 'unverified'; asset: string; manifestCid: string; manifest: CreatorManifest; manifestSha256: string; reason: 'not-listed' | 'suspended' | 'changed-since-review';
      access: 'external-link-only'; identity: false; payment: false }
  | { status: 'verified'; asset: string; manifestCid: string; manifest: CreatorManifest; manifestSha256: string; entry: AllowlistEntry;
      access: 'in-wallet'; identity: boolean; payment: boolean };

/**
 * 체인 자산 하나 → 목록 항목. 매니페스트를 못 받거나 깨졌거나 서명이 틀리면 숨긴다(hidden). 나머지는 미검증.
 * 허용 목록 항목과 (자산·종류·매니페스트 CID·바이트 SHA-256·제작자·받는 주소)가 **전부** 같고 status verified 일 때만 검증됨.
 * 결제는 검증됨 + 가격 있음 + 매니페스트 선언 수수료율 = 목록 수수료율일 때만 열린다(어긋나면 결제 없음 — 지갑이 고르지 않는다).
 */
export function judgeListing(asset: ChainAsset, manifestBytes: Uint8Array | null, allowlist: CreatorAllowlist | null, prefix: string = CREATOR_ASSET_PREFIX): Listing {
  if (!asset.name.startsWith(prefix) || asset.name.endsWith('!')) return { status: 'hidden', asset: asset.name, reason: 'not-creator-asset' };
  if (!asset.ipfs_hash || !CID_V0.test(asset.ipfs_hash)) return { status: 'hidden', asset: asset.name, reason: 'no-manifest' };
  if (!manifestBytes) return { status: 'hidden', asset: asset.name, reason: 'manifest-unavailable' };
  let manifest: CreatorManifest, sha: string;
  try { const v = verifyManifest(manifestBytes, { expectedAsset: asset.name, prefix }); manifest = v.manifest; sha = v.bytesSha256; }
  catch (e) { return { status: 'hidden', asset: asset.name, reason: (e as CreatorError).code ?? 'manifest-invalid' }; }
  const base = { asset: asset.name, manifestCid: asset.ipfs_hash, manifest, manifestSha256: sha };
  const entry = allowlist?.entries.find(e => e.asset === asset.name);
  const unverified = (reason: 'not-listed' | 'suspended' | 'changed-since-review') =>
    ({ status: 'unverified' as const, ...base, reason, access: 'external-link-only' as const, identity: false as const, payment: false as const });
  if (!entry) return unverified('not-listed');
  if (entry.status !== 'verified') return unverified('suspended');
  if (entry.type !== manifest.type || entry.manifestCid !== asset.ipfs_hash || entry.manifestSha256 !== sha ||
      entry.creatorAddress !== manifest.creator.address || entry.receivingAddress !== manifest.creator.receivingAddress) return unverified('changed-since-review');
  const payment = manifest.price !== null && manifest.fee.declaredBps === entry.feeBps && (manifest.type === 'music' || manifest.game?.capabilities.payment === true);
  const identity = manifest.type === 'game' && manifest.game?.capabilities.identity === true;
  return { status: 'verified', ...base, entry, access: 'in-wallet', identity, payment };
}

/** 여러 자산을 한꺼번에. 숨긴 것은 빼고, 검증됨을 위에 둔다(설계 §3.4 T1). */
export async function discoverListings(p: { assets: readonly ChainAsset[]; fetchManifest: (cid: string) => Promise<Uint8Array | null>; allowlist: CreatorAllowlist | null; prefix?: string }): Promise<Listing[]> {
  const out: Listing[] = [];
  for (const a of p.assets) {
    let bytes: Uint8Array | null = null;
    if (a.ipfs_hash && CID_V0.test(a.ipfs_hash)) { try { bytes = await p.fetchManifest(a.ipfs_hash); } catch { bytes = null; } }
    out.push(judgeListing(a, bytes, p.allowlist, p.prefix));
  }
  const rank = (l: Listing) => l.status === 'verified' ? 0 : l.status === 'unverified' ? 1 : 2;
  return out.filter(l => l.status !== 'hidden').sort((a, b) => rank(a) - rank(b) || a.asset.localeCompare(b.asset));
}
