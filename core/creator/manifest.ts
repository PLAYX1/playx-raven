import { sha256 } from '@noble/hashes/sha256';
import { ripemd160 } from '@noble/hashes/ripemd160';
import { secp256k1 } from '@noble/curves/secp256k1';
import { decodeBase58Check, encodeBase58Check } from '../wallet-offline/base58check';
import { PLATFORM_FEE_BPS_MAX, splitPrice } from '../game-registry/platform-fee';
import { FEE_SCHEDULE_POLICY, LEGACY_FEE_POLICY, MARKET_FEE_BPS_CEILING, type ManifestFee } from './fee-schedule';
import { canonicalJson, base64Decode, base64Encode, plain, sha256Hex, utf8, type Loose } from './bytes';
import { checkCreatorAssetName, CREATOR_ASSET_PREFIX } from './asset-name';
import { CONTENT_TYPES, LIMITS, MIME_BY_EXT, allowedExt, extOf, isContentType, safePath, type ContentType } from './limits';

/*
 * 제작자 상품 매니페스트(rv-creator-manifest v2) — 게임·음악·책·티켓·디지털 같은 규격, type 으로 구분하고 종류별 칸은 details 에.
 * v1(게임·음악 전용, game/music 칸)은 메인넷에 나간 적이 없어 받지 않는다(서명 도메인도 V2 로 바꿔 섞이지 않게 했다).
 * 종류별 필수 칸 표 = limits.ts CONTENT_TYPES[type].detailKeys (문서 docs/open-seller-platform.md §4 와 같은 표).
 *
 * IPFS 에 올리는 JSON 이고, 레이븐코인 자산의 ipfs_hash 가 이 파일의 CID 를 가리킨다.
 *   · 파일마다 경로·CID·SHA-256·크기·MIME. 받는 쪽은 받은 바이트의 SHA-256 으로 내용을 확인한다(게이트웨이를 믿지 않는다).
 *   · 제작자 서명 = 레이븐코인 표준 메시지 서명(노드 signmessage, 65바이트 복구형). 서명 주소가 creator.address 와 같아야 한다.
 *     서명 문구 = DOMAIN \n 자산 이름 \n sha256:<서명 칸을 뺀 매니페스트의 정본 JSON 의 SHA-256>.
 *     도메인을 앞에 붙여 다른 서명(신원·송금 확인 문구)과 섞이지 않게 한다.
 *   · asset 칸 = 이 매니페스트를 가리키는 자산 이름. 남의 매니페스트 CID 를 자기 자산에 붙이는 「도용」을 막는다.
 *   · 가격은 RVN 정수 atoms 문자열. 수수료 칸은 **요율 참조**({policy:'rv-fee-schedule-v1', scheduleId}) — 실제 요율은 구매 시점
 *     (체인 높이)에 서명된 수수료 일정에서 계산하고, 수수료 주소는 코드 고정(docs/fee-schedule.md). 옛 선언 요율 칸은 호환 규칙으로만 받는다.
 *
 * 미검증 콘텐츠는 이 서명이 맞아도 「미검증」이다. 서명은 「누가 만들었나」만 증명하고 「안전한가」는 증명하지 않는다.
 * 정본 직렬화(canonicalJson)는 정렬 키 JSON 이며, JCS(RFC 8785)를 그대로 쓸지는 결정 필요(설계 §2.3 마지막 줄).
 */

export const MANIFEST_FORMAT = 'rv-creator-manifest';
export const MANIFEST_VERSION = 2;
export const MANIFEST_SIGN_DOMAIN = 'RAVENVAULT-CREATOR-MANIFEST-V2';
export const MANIFEST_SIGN_SCHEME = 'rvn-signmessage';
/** 옛 선언 요율 정책 이름(호환). 새 매니페스트는 fee-schedule.ts FEE_SCHEDULE_POLICY(요율 참조)를 쓴다. */
export const FEE_POLICY = LEGACY_FEE_POLICY;
export const MAX_MANIFEST_BYTES = 64 * 1024;
/** 아이템 하나 가격의 플랫폼 상한(게임 등록부 PLATFORM_MAX_ITEM_ATOMS 와 같은 100,000 RVN). */
export const MAX_PRICE_ATOMS = 100_000n * 100_000_000n;
export const MAX_PREVIEW_MS = 60_000;
export const MAX_PREVIEW_PAGES = 50;
export const MAX_TICKETS = 100_000;

export type FileEntry = { path: string; cid: string; sha256: string; size: number; mime: string };
export type GameSection = { entry: string; origin: string | null; capabilities: { identity: boolean; payment: boolean } };
export type MusicSection = { previewFile: string; previewStartMs: number; previewEndMs: number };
export type BookSection = { bookFile: string; format: 'pdf' | 'epub'; previewFile: string | null; previewPages: number; pageCount: number | null };
/** 사용(입장) 확인 = 서버 없이: 제작자(또는 제작자가 정한 확인 담당 주소)가 서명한 입장 코드를 문 앞 기기가 오프라인으로 검사한다(ticket.ts). */
export type TicketSection = { eventName: string; startsAt: string; endsAt: string | null; venue: string; quantity: number;
  redemption: { method: 'creator-signed-code'; checkerAddress: string }; refundPolicy: string; contact: string };
export type DigitalSection = { label: string };
export type Details = GameSection | MusicSection | BookSection | TicketSection | DigitalSection;
export type UnsignedManifest = {
  format: typeof MANIFEST_FORMAT; version: typeof MANIFEST_VERSION; type: ContentType; asset: string;
  title: string; description: string; files: FileEntry[]; cover: FileEntry | null;
  creator: { address: string; receivingAddress: string };
  price: { atoms: string } | null; fee: ManifestFee;
  details: Details; createdAt: string;
};
export type ManifestSignature = { scheme: typeof MANIFEST_SIGN_SCHEME; domain: typeof MANIFEST_SIGN_DOMAIN; address: string; value: string };
export type CreatorManifest = UnsignedManifest & { signature: ManifestSignature };

export type CreatorErrorCode = 'manifest-shape' | 'manifest-type' | 'manifest-files' | 'manifest-price' | 'manifest-asset' | 'manifest-signature' |
  'manifest-too-large' | 'manifest-json' | 'file-hash' | 'allowlist-signature' | 'allowlist-shape' | 'purchase-closed' | 'purchase-invalid';
export class CreatorError extends Error {
  constructor(readonly code: CreatorErrorCode, readonly detail = '') { super(detail ? `${code}: ${detail}` : code); this.name = 'CreatorError'; }
}
const fail = (code: CreatorErrorCode, detail = ''): never => { throw new CreatorError(code, detail); };

export const CID_V0 = /^Qm[1-9A-HJ-NP-Za-km-z]{44}$/;
const SHA = /^[a-f0-9]{64}$/;
const ATOMS = /^[1-9]\d{0,15}$/;
const ADDRESS = /^R[1-9A-HJ-NP-Za-km-z]{25,34}$/;
const keysAre = (o: Record<string, Loose>, keys: string) => Object.keys(o).sort().join() === keys.split(',').sort().join();
const int = (n: unknown, min: number, max: number): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= min && n <= max;
const text = (s: unknown, min: number, max: number) => typeof s === 'string' && s.length >= min && s.length <= max && s === s.normalize('NFC') && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f‪-‮⁦-⁩]/.test(s);

/** 표준 P2PKH(R…) 주소인가 — 모양 + Base58Check + 버전 0x3c. */
export function isRvnAddress(a: unknown): a is string {
  if (typeof a !== 'string' || !ADDRESS.test(a)) return false;
  try { return decodeBase58Check(a).version === 0x3c; } catch { return false; }
}
export const addressOfPublicKey = (pub: Uint8Array): string => encodeBase58Check(0x3c, ripemd160(sha256(pub)));

/* ── 레이븐코인 표준 메시지 서명(노드 signmessage 와 같은 바이트) ─────────────── */

const varint = (n: number) => n < 0xfd ? [n] : n <= 0xffff ? [0xfd, n & 255, n >> 8] : [0xfe, n & 255, (n >> 8) & 255, (n >> 16) & 255, (n >>> 24) & 255];
/** sha256d("\x16Raven Signed Message:\n" ‖ varint(len) ‖ msg) — core/playx-asset-proof/crypto.ts ravencoinMessageHash 와 같다(시험이 대조). */
export function messageHash(message: string): Uint8Array {
  const prefix = utf8('\x16Raven Signed Message:\n'), msg = utf8(message);
  const all = new Uint8Array(prefix.length + msg.length + 5);
  const v = varint(msg.length);
  all.set(prefix, 0); all.set(v, prefix.length); all.set(msg, prefix.length + v.length);
  return sha256(sha256(all.subarray(0, prefix.length + v.length + msg.length)));
}
/** 65바이트 복구형 서명(base64)에서 서명한 주소를 되살린다. 형식이 틀리거나 복구가 안 되면 null. */
export function recoverMessageAddress(message: string, signatureBase64: string): string | null {
  try {
    const sig = base64Decode(signatureBase64);
    if (sig.length !== 65 || sig[0] < 27 || sig[0] > 34) return null;
    const recovery = (sig[0] - 27) & 3, compressed = sig[0] >= 31;
    const point = secp256k1.Signature.fromCompact(sig.subarray(1)).addRecoveryBit(recovery).recoverPublicKey(messageHash(message));
    return addressOfPublicKey(point.toRawBytes(compressed));
  } catch { return null; }
}
/** 시험·도구용 서명기(개인키를 받는다). 앱은 이 함수를 쓰지 않고 노드 signmessage(데스크탑 sign_message)로 서명한다. */
export function signMessageForTest(message: string, privateKey: Uint8Array): string {
  const s = secp256k1.sign(messageHash(message), privateKey, { lowS: true });
  const out = new Uint8Array(65); out[0] = 31 + (s.recovery ?? 0); out.set(s.toCompactRawBytes(), 1);
  return base64Encode(out);
}

/* ── 매니페스트 만들기·서명 문구 ─────────────────────────────────────── */

export function unsignedPart(doc: CreatorManifest | UnsignedManifest): UnsignedManifest {
  const { signature: _s, ...rest } = doc as CreatorManifest;
  return rest as UnsignedManifest;
}
/** 노드 signmessage 에 넘길 문구. 사람이 읽을 수 있는 첫 두 줄 + 내용 해시. */
export function manifestSigningMessage(doc: UnsignedManifest): string {
  return `${MANIFEST_SIGN_DOMAIN}\n${doc.asset}\nsha256:${sha256Hex(utf8(canonicalJson(unsignedPart(doc))))}`;
}
export const withSignature = (doc: UnsignedManifest, address: string, value: string): CreatorManifest =>
  ({ ...unsignedPart(doc), signature: { scheme: MANIFEST_SIGN_SCHEME, domain: MANIFEST_SIGN_DOMAIN, address, value } });
/** IPFS 에 올리는 바이트 = 정본 JSON(UTF-8). 허용 목록의 manifestSha256 은 이 바이트의 해시다. */
export const encodeManifest = (doc: CreatorManifest): Uint8Array => utf8(canonicalJson(doc));

/* ── 검사 ───────────────────────────────────────────────────────────── */

function checkFileEntry(f: unknown, type: ContentType | 'cover'): FileEntry {
  if (!plain(f) || !keysAre(f, 'path,cid,sha256,size,mime')) return fail('manifest-files', 'entry-keys');
  if (!safePath(f.path) || typeof f.cid !== 'string' || !CID_V0.test(f.cid) || typeof f.sha256 !== 'string' || !SHA.test(f.sha256)) fail('manifest-files', 'entry-format');
  const ext = extOf(f.path);
  if (!allowedExt(type).has(ext) || MIME_BY_EXT[ext] !== f.mime) fail('manifest-files', 'type');
  const max = type === 'cover' ? LIMITS.cover.maxFileBytes : CONTENT_TYPES[type].maxFileBytes;
  if (!int(f.size, 1, max)) fail('manifest-files', 'size');
  return f as FileEntry;
}

const isoTime = (t: unknown) => typeof t === 'string' && t.length <= 40 && /^\d{4}-\d{2}-\d{2}T/.test(t) && Number.isFinite(Date.parse(t));

/** 종류별 details 칸 검사. 필수 키 목록은 limits.ts CONTENT_TYPES[type].detailKeys 한 곳에서 온다(모르는 칸·빠진 칸 거절). */
function checkDetails(type: ContentType, x: Loose, files: FileEntry[], price: unknown): void {
  if (!plain(x) || !keysAre(x, CONTENT_TYPES[type].detailKeys.join(','))) fail('manifest-type', `${type}-section`);
  const has = (p: unknown) => typeof p === 'string' && files.some(f => f.path === p);
  if (type === 'game') {
    if (!has(x.entry) || !['html', 'htm'].includes(extOf(x.entry))) fail('manifest-type', 'entry');
    if (!plain(x.capabilities) || !keysAre(x.capabilities, 'identity,payment') ||
        typeof x.capabilities.identity !== 'boolean' || typeof x.capabilities.payment !== 'boolean') fail('manifest-type', 'capabilities');
    if (x.capabilities.payment && price === null) fail('manifest-type', 'payment-without-price');
    if (x.origin !== null) {
      let u: URL | null = null;
      try { u = new URL(x.origin); } catch { /* below */ }
      if (!u || u.protocol !== 'https:' || u.origin !== x.origin || /(^|\.)ex\.erci\.se$/i.test(u.hostname)) fail('manifest-type', 'origin');
    }
  } else if (type === 'music') {
    if (!has(x.previewFile)) fail('manifest-type', 'preview-file');
    if (!int(x.previewStartMs, 0, 24 * 3600_000) || !int(x.previewEndMs, x.previewStartMs + 1000, x.previewStartMs + MAX_PREVIEW_MS)) fail('manifest-type', 'preview-range');
  } else if (type === 'book') {
    if (!has(x.bookFile) || (x.format !== 'pdf' && x.format !== 'epub') || extOf(x.bookFile) !== x.format) fail('manifest-type', 'book-file');
    if (x.previewFile === null) { if (x.previewPages !== 0) fail('manifest-type', 'preview-pages'); }
    else if (!has(x.previewFile) || x.previewFile === x.bookFile || extOf(x.previewFile) !== 'pdf' || !int(x.previewPages, 1, MAX_PREVIEW_PAGES)) fail('manifest-type', 'preview-file');
    if (x.pageCount !== null && !int(x.pageCount, 1, 100_000)) fail('manifest-type', 'page-count');
    if (x.pageCount !== null && x.previewPages > x.pageCount) fail('manifest-type', 'preview-pages');
  } else if (type === 'ticket') {
    if (!text(x.eventName, 1, 80) || !text(x.venue, 1, 200) || !text(x.refundPolicy, 1, 1000) || !text(x.contact, 1, 200)) fail('manifest-type', 'ticket-text');
    if (!isoTime(x.startsAt) || (x.endsAt !== null && (!isoTime(x.endsAt) || Date.parse(x.endsAt) <= Date.parse(x.startsAt)))) fail('manifest-type', 'ticket-time');
    if (!int(x.quantity, 1, MAX_TICKETS)) fail('manifest-type', 'ticket-quantity');
    if (!plain(x.redemption) || !keysAre(x.redemption, 'method,checkerAddress') || x.redemption.method !== 'creator-signed-code' ||
        !isRvnAddress(x.redemption.checkerAddress)) fail('manifest-type', 'ticket-redemption');
  } else if (type === 'digital') {
    if (!text(x.label, 1, 40)) fail('manifest-type', 'label');
  }
}

/** 엄격 검사: 모르는 칸·빠진 칸·틀린 모양은 전부 거절. 서명은 보지 않는다(verifyManifest 가 본다). */
export function validateManifest(raw: unknown, prefix: string = CREATOR_ASSET_PREFIX): CreatorManifest {
  if (!plain(raw) || !keysAre(raw, 'format,version,type,asset,title,description,files,cover,creator,price,fee,details,createdAt,signature')) return fail('manifest-shape', 'keys');
  const d = raw as Loose;
  if (d.format !== MANIFEST_FORMAT || d.version !== MANIFEST_VERSION) fail('manifest-shape', 'format');
  if (!isContentType(d.type)) fail('manifest-type');
  const type: ContentType = d.type;
  const rule = CONTENT_TYPES[type];
  const nameCheck = checkCreatorAssetName(d.asset, prefix);
  if (!nameCheck.valid) fail('manifest-asset', 'name');
  // 이름의 종류 글자(RV.M. = 음악)와 매니페스트 type 이 다르면 거절한다 — 책을 음악 칸에 올려 음악처럼 보이게 하는 사칭을 막는다.
  if (nameCheck.type !== type) fail('manifest-asset', 'kind');
  if (!text(d.title, 1, 80) || !text(d.description, 0, 2000) || d.title.trim() !== d.title || !d.title.trim()) fail('manifest-shape', 'title');
  if (!isoTime(d.createdAt)) fail('manifest-shape', 'createdAt');
  if (!Array.isArray(d.files) || d.files.length < rule.minFiles || d.files.length > rule.maxFiles) fail('manifest-files', 'count');
  const files = (d.files as unknown[]).map(f => checkFileEntry(f, type));
  const paths = new Set(files.map(f => f.path.toLowerCase()));
  if (paths.size !== files.length) fail('manifest-files', 'duplicate');
  if (files.reduce((n, f) => n + f.size, 0) > rule.maxTotalBytes) fail('manifest-files', 'total');
  if (d.cover !== null) { const c = checkFileEntry(d.cover, 'cover'); if (paths.has(c.path.toLowerCase())) fail('manifest-files', 'cover-duplicate'); }
  if (!plain(d.creator) || !keysAre(d.creator, 'address,receivingAddress') || !isRvnAddress(d.creator.address) || !isRvnAddress(d.creator.receivingAddress)) fail('manifest-shape', 'creator');
  const scheduleRef = plain(d.fee) && keysAre(d.fee, 'policy,scheduleId') && d.fee.policy === FEE_SCHEDULE_POLICY &&
    typeof d.fee.scheduleId === 'string' && /^[a-z0-9][a-z0-9-]{0,31}$/.test(d.fee.scheduleId);
  const legacy = plain(d.fee) && keysAre(d.fee, 'policy,declaredBps') && d.fee.policy === LEGACY_FEE_POLICY && int(d.fee.declaredBps, 0, PLATFORM_FEE_BPS_MAX);
  if (!scheduleRef && !legacy) fail('manifest-price', 'fee');
  if (d.price !== null) {
    if (!plain(d.price) || !keysAre(d.price, 'atoms') || typeof d.price.atoms !== 'string' || !ATOMS.test(d.price.atoms) || BigInt(d.price.atoms) > MAX_PRICE_ATOMS) fail('manifest-price', 'atoms');
    // 요율 참조면 일정이 받을 수 있는 가장 높은 요율(천장)로 나눠도 판매자 몫이 남아야 한다.
    try { splitPrice(d.price.atoms, scheduleRef ? MARKET_FEE_BPS_CEILING : d.fee.declaredBps); } catch { fail('manifest-price', 'split'); }
  }
  checkDetails(type, d.details, files, d.price);
  if (!plain(d.signature) || !keysAre(d.signature, 'scheme,domain,address,value') || d.signature.scheme !== MANIFEST_SIGN_SCHEME ||
      d.signature.domain !== MANIFEST_SIGN_DOMAIN || typeof d.signature.value !== 'string' || d.signature.value.length > 200) fail('manifest-signature', 'shape');
  try { canonicalJson(d); } catch { fail('manifest-shape', 'canonical'); }
  return d as CreatorManifest;
}

export type VerifiedManifest = { manifest: CreatorManifest; bytesSha256: string; signedBy: string };

/**
 * 받은 매니페스트 바이트(또는 객체)를 검사·서명 확인한다. expectedAsset 이 있으면 asset 칸이 그 이름과 같아야 한다
 * (체인 자산의 ipfs_hash 로 받은 경우 항상 넘긴다). 바이트로 받으면 그 바이트가 정본 JSON 그대로여야 한다.
 */
export function verifyManifest(input: Uint8Array | unknown, opts: { expectedAsset?: string; prefix?: string } = {}): VerifiedManifest {
  let doc: unknown, bytes: Uint8Array;
  if (input instanceof Uint8Array) {
    if (input.length > MAX_MANIFEST_BYTES) fail('manifest-too-large');
    try { doc = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(input)); } catch { return fail('manifest-json'); }
    bytes = input;
  } else { doc = input; bytes = new Uint8Array(); }
  const m = validateManifest(doc, opts.prefix);
  const canonical = encodeManifest(m);
  if (canonical.length > MAX_MANIFEST_BYTES) fail('manifest-too-large');
  if (input instanceof Uint8Array && sha256Hex(bytes) !== sha256Hex(canonical)) fail('manifest-shape', 'not-canonical');
  if (opts.expectedAsset !== undefined && m.asset !== opts.expectedAsset) fail('manifest-asset', 'mismatch');
  if (m.signature.address !== m.creator.address) fail('manifest-signature', 'address');
  const signer = recoverMessageAddress(manifestSigningMessage(m), m.signature.value);
  if (signer === null || signer !== m.signature.address) fail('manifest-signature', 'invalid');
  return { manifest: m, bytesSha256: sha256Hex(canonical), signedBy: signer as string };
}

/** 받은 파일 바이트가 매니페스트 항목(크기·SHA-256)과 같은지. 게이트웨이가 다른 내용을 줘도 여기서 걸린다. */
export function checkFileBytes(entry: FileEntry, bytes: Uint8Array): void {
  if (bytes.length !== entry.size || sha256Hex(bytes) !== entry.sha256) fail('file-hash', entry.path);
}
