import { secp256k1 } from '@noble/curves/secp256k1';
import { base64Decode, canonicalJson, plain, sha256Hex, utf8, type Loose } from './bytes';
import { safePath } from './limits';
import { LOCK_CHUNK_BYTES, LOCK_DELIVER, LOCK_SCHEME, LOCK_WRAP, type LockSection } from './manifest';
import type { LockHolder } from './lock';
import { checkAssetNameV3 } from './asset-name-v3';
import { CID_V0, MARKET_FEE_ADDRESS, MAX_PRICE_ATOMS, addressOfPublicKey, isRvnAddress, messageHash } from './trade-primitives';
import { PlatformFeeError, splitPrice, type PriceSplit } from '../game-registry/platform-fee';
import { signMessageWith, type SignDigest } from '../signer/signmessage';
import { signMessageWithKeyForTest } from '../signer/test-key';

/*
 * 오락실 게임 상품 문서(rv-arcade-product v1) — 오락실 1단계 C 묶음(올리기와 목록). 순수 함수만(네트워크·키 저장소·송금 없음). (2026-11-03)
 *
 * 무엇: 판매자가 자기 주소 키로 서명한 게임 한 편의 JSON 한 장. 목록(arcade-catalog.ts)·구매 화면은 이 서명만 믿는다.
 *   · 자산(RVLT/…)이 없어도 판다(대표 결정): 서명된 문서 + RVN 결제, 거래 안에 플랫폼 수수료 1%. 자산은 「공개 목록 확인 표시」용이다.
 *   · 값 바꾸기 = 같은 (seller, id) 로 version 을 올린 새 서명 문서(자산 재발행 없음). 높은 version 이 낮은 것을 대신한다(pickNewer).
 *
 * 형식(정본 JSON = bytes.ts canonicalJson, 키 정렬·공백 없음·안전 정수만):
 *   { format:'rv-arcade-product', v:1, kind:'arcade-game', id, version, title, description, priceSats:<atoms 정수 문자열, "0" = 무료>,
 *     seller:'R…'(서명 주소), payTo:'R…'(받는 주소, seller 와 같아도 된다), feeBps:100, entry:<시작 파일 경로>, cid:<IPFS 폴더 CID>,
 *     files:[{ path, sha256, size }…](경로 순·중복 없음), lock?:{…}, assetName?:'RVLT/…', x:{ arcade:{ mode:'solo', network:'none', minutes } },
 *     sig:<base64 65바이트 복구형> }
 *   · 서명 = 레이븐 노드 signmessage 와 같은 바이트. 문구 = ARCADE_SIGN_DOMAIN \n sha256:<본문(sig 제외) 정본 JSON 해시>.
 *     데스크탑은 노드 `signmessage <seller> <문구>` 로, 폰은 signArcadeProduct(SignDigest) 로 서명한다. 서명에서 되살린 주소 = seller 여야 한다.
 *   · 수수료 = core/game-registry/platform-fee.ts splitPrice(게임 결제와 같은 규칙: 올림, 먼지 1000 atoms) · 요율 ARCADE_FEE_BPS(1%, 대표 결정) ·
 *     주소는 코드 고정(trade-primitives.ts MARKET_FEE_ADDRESS) — 문서·견적에서 받지 않는다. 무료("0")면 수수료 출력 없음.
 *     ⚠ 장터 상품 문서(product-doc.ts)의 수수료는 다른 경로(내림·면제선·서명된 일정)다. 두 경로를 하나로 모을지는 대표 확인 필요.
 *   · files[].sha256·size 는 **평문** 파일 기준. 잠긴 게임이면 IPFS 폴더의 같은 경로에 RV-LOCK v1 암호문이 들어 있다(크기 = lockCipherSize(size)).
 *   · lock(선택) = RV-LOCK v1(lock.ts) 참조: { scheme, keyId, paths }. 잠금 이름(lock.ts 의 asset 자리) = arcadeLockName(seller, id).
 *     🔴 열쇠를 누가 내주는지(판매자 앱 직접·체인 우편함·서버)는 **대표 결정 대기** — 그래서 문서에 deliver 칸을 두지 않고,
 *        arcadeLockHolder 가 부르는 쪽에서 deliver 를 받는다(지금은 정하지 않는다).
 *   · assetName(선택) = asset-name-v3 의 상품(RVLT/<가게>/<상품>) 또는 고유 자산(RVLT/<가게>#<이름>) 이름. 가게 이름만은 안 된다.
 *     이름이 있다고 확인된 것이 아니다 — 체인 목록에서 그 자산의 IPFS 해시가 이 문서를 가리켜야 확인 표시가 붙는다(arcade-catalog.ts).
 *   · x.arcade: 1단계는 혼자 하기·네트워크 없음만 받는다(mode 'solo', network 'none'), minutes = 한 판 대략 분(1~240).
 *     genre(선택) = ARCADE_GENRES 의 id 하나(고정 목록, 모르는 id 는 거절). 없으면 화면은 'other'(기타)로 본다(arcadeGenreOf).
 *     v1 그대로다: genre 가 없는 옛 문서도 그대로 확인되고, 있으면 다른 칸처럼 서명 본문에 들어간다(바꾸면 서명이 깨진다).
 */

export const ARCADE_PRODUCT_FORMAT = 'rv-arcade-product';
export const ARCADE_PRODUCT_VERSION = 1;
export const ARCADE_KIND = 'arcade-game';
export const ARCADE_SIGN_DOMAIN = 'RAVENVAULT-ARCADE-PRODUCT-V1';
/** 플랫폼 수수료 1%(대표 결정 2026-11-03). */
export const ARCADE_FEE_BPS = 100;
export const ARCADE_LOCK_PREFIX = 'RVA1:';
export const ARCADE_LIMITS = Object.freeze({
  docBytes: 512 * 1024, files: 2000, fileBytes: 200 * 1024 * 1024, totalBytes: 200 * 1024 * 1024,
  title: 80, description: 2000, minutesMin: 1, minutesMax: 240, maxVersion: 1_000_000_000,
  /** 잠글 수 있는 파일 수 = RV-LOCK v1 매니페스트 lock 칸 상한(manifest.ts 50)과 같게. */
  lockFiles: 50,
});

export type ArcadeFile = { path: string; sha256: string; size: number };
export type ArcadeLockRef = { scheme: typeof LOCK_SCHEME; keyId: string; paths: string[] };
/** 장르 — 고정 목록(id 는 문서에, 이름은 화면에). 순서 = 화면 칩 순서. 새 장르는 이 목록에 더하는 별도 결정으로만. */
export const ARCADE_GENRES = ['action', 'puzzle', 'arcade', 'racing', 'sports', 'rhythm', 'board', 'adventure', 'shooting', 'casual', 'kids', 'other'] as const;
export type ArcadeGenre = typeof ARCADE_GENRES[number];
/** 장르 이름(한국어 원문 — 화면은 이 글을 번역 열쇠로 쓴다). */
export const ARCADE_GENRE_LABELS: Readonly<Record<ArcadeGenre, string>> = Object.freeze({
  action: '액션', puzzle: '퍼즐', arcade: '아케이드', racing: '레이싱', sports: '스포츠', rhythm: '리듬',
  board: '보드·카드', adventure: '모험', shooting: '슈팅', casual: '캐주얼', kids: '어린이', other: '기타',
});
export const isArcadeGenre = (g: unknown): g is ArcadeGenre => typeof g === 'string' && (ARCADE_GENRES as readonly string[]).includes(g);
export type ArcadeX = { arcade: { mode: 'solo'; network: 'none'; minutes: number; genre?: ArcadeGenre } };
/** 문서의 장르. 칸이 없으면(옛 문서) 'other'. */
export const arcadeGenreOf = (doc: { x: ArcadeX }): ArcadeGenre => doc.x.arcade.genre ?? 'other';
export type ArcadeProductBody = {
  format: typeof ARCADE_PRODUCT_FORMAT; v: 1; kind: typeof ARCADE_KIND; id: string; version: number; title: string; description: string;
  priceSats: string; seller: string; payTo: string; feeBps: number; entry: string; cid: string; files: ArcadeFile[];
  lock?: ArcadeLockRef; assetName?: string; x: ArcadeX;
};
export type ArcadeProductDoc = ArcadeProductBody & { sig: string };
export type VerifiedArcadeProduct = { doc: ArcadeProductDoc; docHash: string; key: string };

export type ArcadeErrorCode = 'arcade-json' | 'arcade-shape' | 'arcade-id' | 'arcade-version' | 'arcade-text' | 'arcade-price' | 'arcade-address' |
  'arcade-fee' | 'arcade-files' | 'arcade-entry' | 'arcade-cid' | 'arcade-lock' | 'arcade-asset' | 'arcade-x' | 'arcade-too-large' | 'arcade-signature';
export class ArcadeProductError extends Error {
  constructor(readonly code: ArcadeErrorCode, readonly detail = '') { super(detail ? `${code}: ${detail}` : code); this.name = 'ArcadeProductError'; }
}
const fail = (code: ArcadeErrorCode, detail = ''): never => { throw new ArcadeProductError(code, detail); };
const keysAre = (o: Record<string, Loose>, keys: string) => Object.keys(o).sort().join() === keys.split(',').sort().join();
const int = (n: unknown, min: number, max: number): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= min && n <= max;
const text = (s: unknown, min: number, max: number): s is string => typeof s === 'string' && s.length >= min && s.length <= max && s === s.normalize('NFC') &&
  !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f‪-‮⁦-⁩]/.test(s);
const SHA = /^[a-f0-9]{64}$/;
const SATS = /^(0|[1-9]\d{0,17})$/;
const ID = /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/;
const CID_V1 = /^b[a-z2-7]{58,100}$/;
export const isFolderCid = (c: unknown): c is string => typeof c === 'string' && (CID_V0.test(c) || CID_V1.test(c));

/* ── 본문·해시·서명 문구 ─────────────────────────────────────────────── */

export function arcadeBody(doc: ArcadeProductDoc | ArcadeProductBody): ArcadeProductBody {
  const { sig: _s, ...rest } = doc as ArcadeProductDoc;
  return rest as ArcadeProductBody;
}
/** 본문(sig 제외) 정본 JSON 의 SHA-256 hex. */
export const arcadeDocHash = (doc: ArcadeProductDoc | ArcadeProductBody): string => sha256Hex(utf8(canonicalJson(arcadeBody(doc))));
export const arcadeSigningMessage = (doc: ArcadeProductDoc | ArcadeProductBody): string => `${ARCADE_SIGN_DOMAIN}\nsha256:${arcadeDocHash(doc)}`;
/** IPFS·nostr·공유에 쓰는 바이트 = 서명 포함 정본 JSON. */
export const encodeArcadeProduct = (doc: ArcadeProductDoc): Uint8Array => utf8(canonicalJson(doc));
/** 같은 상품을 묶는 열쇠(판매자 주소 + id). */
export const arcadeKeyOf = (doc: Pick<ArcadeProductBody, 'seller' | 'id'>): string => `${doc.seller}/${doc.id}`;
/** RV-LOCK v1 잠금 이름(lock.ts asset 자리). 판매자 + id 라 자산이 없어도 정해지고, 판(version)이 바뀌어도 같다. */
export const arcadeLockName = (seller: string, id: string): string => `${ARCADE_LOCK_PREFIX}${seller}/${id}`;

/* ── 모양 검사 ─────────────────────────────────────────────────────── */

function checkFiles(files: unknown): ArcadeFile[] {
  if (!Array.isArray(files) || files.length < 1 || files.length > ARCADE_LIMITS.files) return fail('arcade-files', 'count');
  let total = 0, prev = '';
  const lower = new Set<string>();
  for (const f of files as Loose[]) {
    if (!plain(f) || !keysAre(f, 'path,sha256,size') || !safePath(f.path) || typeof f.sha256 !== 'string' || !SHA.test(f.sha256) ||
        !int(f.size, 0, ARCADE_LIMITS.fileBytes)) fail('arcade-files', 'entry');
    if (prev && !(prev < f.path)) fail('arcade-files', 'order');
    if (lower.has(f.path.toLowerCase())) fail('arcade-files', 'case-duplicate');
    lower.add(f.path.toLowerCase());
    prev = f.path; total += f.size;
  }
  if (total > ARCADE_LIMITS.totalBytes) fail('arcade-files', 'total');
  return files as ArcadeFile[];
}

function checkLock(lock: unknown, files: ArcadeFile[]): void {
  if (!plain(lock) || !keysAre(lock, 'scheme,keyId,paths') || lock.scheme !== LOCK_SCHEME) return fail('arcade-lock', 'shape');
  if (typeof lock.keyId !== 'string' || !/^[a-f0-9]{32}$/.test(lock.keyId)) fail('arcade-lock', 'key-id');
  const known = new Set(files.map(f => f.path));
  if (!Array.isArray(lock.paths) || lock.paths.length < 1 || lock.paths.length > Math.min(files.length, ARCADE_LIMITS.lockFiles)) fail('arcade-lock', 'paths');
  let prev = '';
  for (const p of lock.paths as unknown[]) {
    if (typeof p !== 'string' || !known.has(p) || (prev && !(prev < p))) fail('arcade-lock', 'paths');
    prev = p as string;
  }
}

/** 엄격 검사(모르는 칸·빠진 칸 거절). 서명은 보지 않는다. */
export function validateArcadeProduct(raw: unknown): ArcadeProductDoc {
  const base = 'format,v,kind,id,version,title,description,priceSats,seller,payTo,feeBps,entry,cid,files,x,sig';
  if (!plain(raw) || !keysAre(raw, base + ('lock' in raw ? ',lock' : '') + ('assetName' in raw ? ',assetName' : ''))) return fail('arcade-shape', 'keys');
  const d = raw as Loose;
  if (d.format !== ARCADE_PRODUCT_FORMAT || d.v !== ARCADE_PRODUCT_VERSION || d.kind !== ARCADE_KIND) fail('arcade-shape', 'format');
  if (typeof d.id !== 'string' || !ID.test(d.id)) fail('arcade-id');
  if (!int(d.version, 1, ARCADE_LIMITS.maxVersion)) fail('arcade-version');
  if (!text(d.title, 1, ARCADE_LIMITS.title) || d.title.trim() !== d.title) fail('arcade-text', 'title');
  if (!text(d.description, 0, ARCADE_LIMITS.description)) fail('arcade-text', 'description');
  if (!isRvnAddress(d.seller)) fail('arcade-address', 'seller');
  if (!isRvnAddress(d.payTo) || d.payTo === MARKET_FEE_ADDRESS) fail('arcade-address', 'pay-to');
  if (d.feeBps !== ARCADE_FEE_BPS) fail('arcade-fee', 'bps');
  if (typeof d.priceSats !== 'string' || !SATS.test(d.priceSats) || BigInt(d.priceSats) > MAX_PRICE_ATOMS) fail('arcade-price');
  if (d.priceSats !== '0') {
    try { splitPrice(d.priceSats, d.feeBps); } catch (e) { fail('arcade-price', e instanceof PlatformFeeError ? e.code : 'split'); }
  }
  if (!isFolderCid(d.cid)) fail('arcade-cid');
  const files = checkFiles(d.files);
  if (typeof d.entry !== 'string' || !/\.html?$/i.test(d.entry) || !files.some(f => f.path === d.entry)) fail('arcade-entry');
  if ('lock' in d) checkLock(d.lock, files);
  if ('assetName' in d) {
    const c = checkAssetNameV3(d.assetName);
    if (!c.valid || c.parsed!.kind === 'shop') fail('arcade-asset');
  }
  const x = d.x as Loose;
  if (!plain(x) || !keysAre(x, 'arcade') || !plain(x.arcade) || !keysAre(x.arcade, 'mode,network,minutes' + ('genre' in x.arcade ? ',genre' : '')) || x.arcade.mode !== 'solo' ||
      x.arcade.network !== 'none' || !int(x.arcade.minutes, ARCADE_LIMITS.minutesMin, ARCADE_LIMITS.minutesMax)) fail('arcade-x');
  if ('genre' in x.arcade && !isArcadeGenre(x.arcade.genre)) fail('arcade-x', 'genre');
  if (typeof d.sig !== 'string' || d.sig.length > 200) fail('arcade-signature', 'shape');
  let bytes = 0;
  try { bytes = utf8(canonicalJson(d)).length; } catch { fail('arcade-shape', 'canonical'); }
  if (bytes > ARCADE_LIMITS.docBytes) fail('arcade-too-large');
  return d as ArcadeProductDoc;
}

/* ── 서명 ─────────────────────────────────────────────────────────── */

/** 65바이트 복구형 서명 → 서명한 주소(머리 바이트의 압축 여부 그대로). 모양이 틀리거나 높은 S 면 null(같은 문서가 두 바이트열이 되지 않게). */
export function recoverArcadeSigner(message: string, signatureBase64: string): string | null {
  try {
    const sig = base64Decode(signatureBase64);
    if (sig.length !== 65 || sig[0] < 27 || sig[0] > 34) return null;
    const recovery = (sig[0] - 27) & 3, compressed = sig[0] >= 31;
    const parsed = secp256k1.Signature.fromCompact(sig.subarray(1));
    if (parsed.hasHighS()) return null;
    return addressOfPublicKey(parsed.addRecoveryBit(recovery).recoverPublicKey(messageHash(message)).toRawBytes(compressed));
  } catch { return null; }
}

/** 받은 문서(바이트 또는 객체)를 검사·서명 확인한다. 바이트면 정본 JSON 그대로여야 한다. */
export function verifyArcadeProduct(input: Uint8Array | unknown): VerifiedArcadeProduct {
  let doc: unknown;
  if (input instanceof Uint8Array) {
    if (input.length > ARCADE_LIMITS.docBytes) fail('arcade-too-large');
    try { doc = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(input)); } catch { return fail('arcade-json'); }
  } else doc = input;
  const d = validateArcadeProduct(doc);
  if (input instanceof Uint8Array && sha256Hex(input) !== sha256Hex(encodeArcadeProduct(d))) fail('arcade-shape', 'not-canonical');
  if (recoverArcadeSigner(arcadeSigningMessage(d), d.sig) !== d.seller) fail('arcade-signature', 'invalid');
  return { doc: d, docHash: arcadeDocHash(d), key: arcadeKeyOf(d) };
}

/** 운영용: 키를 가진 서명 콜백(폰 지갑 어댑터 등)으로 서명. publicKey = seller 주소의 압축 공개키(다른 키면 SignerError). */
export async function signArcadeProduct(signer: SignDigest, body: ArcadeProductBody, publicKey: string): Promise<ArcadeProductDoc> {
  const clean = arcadeBody(body);
  if (addressOfPublicKey(Uint8Array.from(publicKey.match(/../g) ?? [], b => parseInt(b, 16))) !== clean.seller) fail('arcade-address', 'signer-not-seller');
  return { ...clean, sig: await signMessageWith(signer, arcadeSigningMessage(clean), { publicKey }) };
}
/** 노드 signmessage 결과를 붙인다(데스크탑). 붙인 뒤 검증해 틀리면 던진다. */
export function attachArcadeSignature(body: ArcadeProductBody, sig: string): VerifiedArcadeProduct {
  return verifyArcadeProduct({ ...arcadeBody(body), sig });
}
/** 시험·도구 전용. */
export function signArcadeProductForTest(body: ArcadeProductBody, privateKey: Uint8Array): ArcadeProductDoc {
  const clean = arcadeBody(body);
  return { ...clean, sig: signMessageWithKeyForTest(arcadeSigningMessage(clean), privateKey) };
}

/* ── 판 고르기 ────────────────────────────────────────────────────── */

/**
 * 같은 (seller, id) 의 두 확인된 문서 중 남길 것. 높은 version 이 이긴다.
 * 같은 version 인데 내용이 다르면(판매자가 두 문서를 낸 것) conflict: true — 둘 중 본문 해시가 작은 쪽을 남긴다(어느 기기에서나 같은 답).
 */
export function pickNewer(a: VerifiedArcadeProduct, b: VerifiedArcadeProduct): { keep: VerifiedArcadeProduct; conflict: boolean } {
  if (a.key !== b.key) fail('arcade-id', 'different-product');
  if (a.doc.version !== b.doc.version) return { keep: a.doc.version > b.doc.version ? a : b, conflict: false };
  if (a.docHash === b.docHash) return { keep: a, conflict: false };
  return { keep: a.docHash < b.docHash ? a : b, conflict: true };
}

/* ── 결제 분할 · 잠금 ─────────────────────────────────────────────── */

export type ArcadeSplit = { free: true } | ({ free: false; payTo: string; feeAddress: string } & PriceSplit);
/** 결제 출력: 판매자(payTo) sellerAtoms + 수수료(코드 고정 주소) feeAtoms. 무료면 출력 없음. */
export function arcadeSplit(v: VerifiedArcadeProduct): ArcadeSplit {
  if (v.doc.priceSats === '0') return { free: true };
  return { free: false, payTo: v.doc.payTo, feeAddress: MARKET_FEE_ADDRESS, ...splitPrice(v.doc.priceSats, v.doc.feeBps) };
}

/**
 * 잠긴 게임 → lock.ts 가 읽는 LockHolder. cids = 경로 → 그 파일 암호문의 CID(v0), deliver = 열쇠 전달 방식.
 * 🔴 deliver 는 대표 결정 대기라 문서가 정하지 않는다 — 부르는 쪽이 넘긴다(lock.ts LOCK_DELIVER 중에서).
 */
export function arcadeLockHolder(v: VerifiedArcadeProduct, p: { cids: Readonly<Record<string, string>>; deliver: readonly string[] }): LockHolder {
  const lock = v.doc.lock;
  if (!lock) return fail('arcade-lock', 'none');
  if (!p.deliver.length || p.deliver.some(x => !(LOCK_DELIVER as readonly string[]).includes(x))) fail('arcade-lock', 'deliver');
  const byPath = new Map(v.doc.files.map(f => [f.path, f]));
  const files = lock.paths.map(path => {
    const f = byPath.get(path)!, cid = p.cids[path];
    if (typeof cid !== 'string' || !CID_V0.test(cid)) fail('arcade-lock', 'cid');
    if (f.size < 1) fail('arcade-lock', 'empty-file');
    return { path, cid, plainSize: f.size, plainSha256: f.sha256 };
  });
  const section: LockSection = { scheme: LOCK_SCHEME, chunk: LOCK_CHUNK_BYTES, keyId: lock.keyId, wrap: LOCK_WRAP, deliver: [...p.deliver], files };
  return { asset: arcadeLockName(v.doc.seller, v.doc.id), lock: section };
}
