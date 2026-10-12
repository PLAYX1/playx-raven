import { x25519 } from '@noble/curves/ed25519';
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { hkdf } from '@noble/hashes/hkdf';
import { sha256 } from '@noble/hashes/sha256';
import { b64urlDecode, b64urlEncode, canonicalJson, hex, plain, sha256Hex, utf8, type Loose } from './bytes';
import {
  LOCK_CHUNK_BYTES, LOCK_CHUNK_OVERHEAD, LOCK_SCHEME, LOCK_WRAP, lockCipherSize, recoverMessageAddress,
  type CreatorManifest, type LockFile, type LockSection,
} from './manifest';

/*
 * RV-LOCK v1 — 구매자 열람권(수동 전달판). 설계: 바탕화면 「레이븐볼트-구매자-열람권-설계.md」 §3.4·§4·§5.
 *
 * 🔴🔴 독립 검수 필요 🔴🔴
 *   이 파일의 암호 **부품**(X25519 · HKDF-SHA256 · XChaCha20-Poly1305, @noble)은 표준이고 새 암호를 만들지 않았다. 그러나
 *   **조합**(어떤 값을 AAD 에 묶는가, HKDF 의 salt·info 문자열, 조각 번호·크기·해시 묶음, 열쇠 지문 만드는 법)은 이 저장소가 정한 것이고
 *   암호 전문가나 독립 모델의 검수를 아직 받지 않았다. 검수 전에는 「안전하다」고 말하지 않는다. 검수 대상은 이 파일 전체와 시험 벡터
 *   (lock.test.ts · lock-vectors.json)다.
 *
 * 하는 일 / 못 하는 일 (사실만):
 *   · 파일은 상품 열쇠 K 로 암호화되어 IPFS 에 올라간다. K 는 판매자만 갖는다(백업 필수 — 잃으면 판매자도 못 연다).
 *   · 구매자가 결제한 **주소가 서명한 열람 요청**을 판매자 앱이 보고(결제 확인·확인 수·입력 주소 대조), 구매자의 열람 공개키로 K 를 싼
 *     **열람 허가**를 만든다. 전달은 사람 손(메신저 등)이다. 판매자 앱이 켜져 있어야 허가가 나간다.
 *   · 열쇠나 복호된 파일을 받은 사람이 남에게 주는 것은 기술로 막을 수 없다. 녹음도 막지 못한다. 한 번 준 열쇠는 거둘 수 없다.
 *
 * ── 형식 ───────────────────────────────────────────────────────────────────────────────────────
 *  상품 열쇠 K        : OS 난수 32바이트. 상품(자산)당 하나.
 *  열쇠 지문 keyId    : hex( sha256( "RV-LOCK-V1-KEYID\n" + asset + "\n" ‖ K )[0..16] )  — 매니페스트 lock.keyId. K 자체는 안 나온다.
 *  파일 열쇠          : HKDF-SHA256( ikm = K, salt = "RV-LOCK-V1", info = "rv-lock-file-v1\n" + asset + "\n" + path, 32 )
 *  암호문(조각 이어붙임): 조각 i (평문 ≤ 65536바이트) → nonce(24, 난수) ‖ XChaCha20-Poly1305( 파일열쇠, nonce, aad_i, 평문조각 )
 *                       aad_i = canonicalJson( ["rv-lock-chunk-v1", asset, path, i, plainSize, plainSha256] )
 *                       전체 크기 = plainSize + 40 × ceil(plainSize / 65536)  (조각 수가 크기로 정해진다 → 잘림·덧붙임은 길이로 먼저 거절)
 *  열람 요청 RVLQ1.   : "RVLQ1." + base64url( canonicalJson({ v:1, asset, txid, lockPub(hex32), at(초), sig }) )
 *                       sig = 결제한 주소의 signmessage(base64), 메시지 =
 *                       "RAVENVAULT-LOCK-REQ-V1\n" + asset + "\n" + txid + "\n" + lockPub + "\n" + at
 *  열람 허가 RVLG1.   : "RVLG1." + base64url( canonicalJson({ v:1, asset, txid, keyId, lockPub, eph(hex32), nonce(hex24), ct(hex) }) )
 *                       eph = 임시 X25519 공개키. shared = X25519(ephPriv, lockPub).
 *                       wrapKey = HKDF-SHA256( shared, salt = eph ‖ lockPub, info = "rv-lock-wrap-v1", 32 )
 *                       ct = XChaCha20-Poly1305( wrapKey, nonce, aad, K ) ,  aad = canonicalJson( ["rv-lock-grant-v1", asset, txid, keyId, lockPub, eph] )
 *  받는 쪽 확인        : 푼 K 의 지문이 **서명된 매니페스트의 lock.keyId** 와 같아야 한다(가짜 허가가 쓰레기 열쇠를 주는 것을 막는다).
 *  v 필드             : 글 형식 버전. 전달 통로(체인 우편함·서버)를 나중에 바꿔도 이 글은 그대로 오간다.
 * ───────────────────────────────────────────────────────────────────────────────────────────────
 * 이 파일은 지갑 저장소 원본이다. 데스크탑(core/creator/PROVENANCE.md)이 바이트 그대로 복사한다.
 */

export type LockErrorCode =
  | 'key' | 'key-id' | 'format' | 'asset' | 'size' | 'chunk' | 'plain-hash' | 'aborted' | 'too-big' | 'grant' | 'request-signature' | 'wrong-key';
export class LockError extends Error {
  constructor(readonly code: LockErrorCode, readonly detail = '') { super(detail ? `${code}: ${detail}` : code); this.name = 'LockError'; }
}
const fail = (code: LockErrorCode, detail = ''): never => { throw new LockError(code, detail); };

export type Rng = (n: number) => Uint8Array;
export const osRandom: Rng = n => globalThis.crypto.getRandomValues(new Uint8Array(n));

export const LOCK_REQ_DOMAIN = 'RAVENVAULT-LOCK-REQ-V1';
export const REQUEST_PREFIX = 'RVLQ1.';
export const GRANT_PREFIX = 'RVLG1.';
/** 판매자 기본: 열람 요청에 필요한 최소 확인 수(대표 결정 항목 — 설계 §5.3 ②. 게임 결제 층 confirmationTiers 와 같은 6). */
export const DEFAULT_MIN_CONFIRMATIONS = 6;
/** 한 결제(txid)에 서로 다른 열람 공개키로 내줄 수 있는 최대 허가 수(기기를 잃고 다시 요청하는 경우 몫 — 대표 결정 항목). */
export const DEFAULT_MAX_KEYS_PER_PAYMENT = 3;
/** 한 번에 메모리에 복호해 담는 파일의 상한. 이보다 크면 거절(메모리 폭주 방지). */
export const MAX_MEMORY_PLAIN_BYTES = 256 * 1024 * 1024;

const unhex = (s: string): Uint8Array => {
  if (typeof s !== 'string' || s.length % 2 || !/^[0-9a-f]*$/.test(s)) throw new Error('hex');
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
};
const HEX = (n: number) => new RegExp(`^[a-f0-9]{${n * 2}}$`);
const concat = (...a: Uint8Array[]): Uint8Array => { const o = new Uint8Array(a.reduce((n, x) => n + x.length, 0)); let p = 0; for (const x of a) { o.set(x, p); p += x.length; } return o; };
const allZero = (b: Uint8Array) => b.every(x => x === 0);

/* ── 열쇠 ─────────────────────────────────────────────────────────────── */

export function newProductKey(rng: Rng = osRandom): Uint8Array {
  const k = Uint8Array.from(rng(32));
  if (k.length !== 32 || allZero(k)) fail('key', 'rng');
  return k;
}
export function lockKeyId(asset: string, key: Uint8Array): string {
  if (key.length !== 32) fail('key', 'length');
  return hex(sha256(concat(utf8(`RV-LOCK-V1-KEYID\n${asset}\n`), key)).slice(0, 16));
}
export const fileKeyOf = (key: Uint8Array, asset: string, path: string): Uint8Array =>
  hkdf(sha256, key, utf8('RV-LOCK-V1'), utf8(`rv-lock-file-v1\n${asset}\n${path}`), 32);

/* ── 파일 암호화(조각) ───────────────────────────────────────────────────── */

export const chunkCountOf = (plainSize: number): number => Math.max(1, Math.ceil(plainSize / LOCK_CHUNK_BYTES));
const chunkAad = (asset: string, path: string, index: number, plainSize: number, plainSha256: string) =>
  utf8(canonicalJson(['rv-lock-chunk-v1', asset, path, index, plainSize, plainSha256]));

export type SealedFile = { cipher: Uint8Array; plainSize: number; plainSha256: string };
/** 파일 한 개를 통째로 암호화한다(발행 때 메모리에 있는 파일). 평문이 비어 있으면 거절. */
export function sealLockedFile(p: { key: Uint8Array; asset: string; path: string; bytes: Uint8Array; rng?: Rng }): SealedFile {
  const rng = p.rng ?? osRandom;
  if (p.key.length !== 32) fail('key', 'length');
  const plainSize = p.bytes.length;
  if (plainSize < 1) fail('size', 'empty');
  const plainSha256 = sha256Hex(p.bytes);
  const fk = fileKeyOf(p.key, p.asset, p.path);
  const n = chunkCountOf(plainSize);
  const cipher = new Uint8Array(lockCipherSize(plainSize));
  let at = 0;
  for (let i = 0; i < n; i++) {
    const part = p.bytes.subarray(i * LOCK_CHUNK_BYTES, Math.min(plainSize, (i + 1) * LOCK_CHUNK_BYTES));
    const nonce = Uint8Array.from(rng(24));
    if (nonce.length !== 24) fail('chunk', 'nonce');
    const ct = xchacha20poly1305(fk, nonce, chunkAad(p.asset, p.path, i, plainSize, plainSha256)).encrypt(part);
    cipher.set(nonce, at); cipher.set(ct, at + 24); at += 24 + ct.length;
  }
  fk.fill(0);
  if (at !== cipher.length) fail('size', 'seal-length');
  return { cipher, plainSize, plainSha256 };
}

/** 암호문 조각 하나를 푼다(조각 번호·파일 정보는 호출한 쪽이 매니페스트에서 가져온다). 변조·다른 파일·다른 열쇠면 거절. */
export function openLockedChunk(p: { fileKey: Uint8Array; asset: string; file: Pick<LockFile, 'path' | 'plainSize' | 'plainSha256'>; index: number; packet: Uint8Array }): Uint8Array {
  const n = chunkCountOf(p.file.plainSize);
  if (!Number.isInteger(p.index) || p.index < 0 || p.index >= n) fail('chunk', 'index');
  const want = Math.min(LOCK_CHUNK_BYTES, p.file.plainSize - p.index * LOCK_CHUNK_BYTES) + LOCK_CHUNK_OVERHEAD;
  if (p.packet.length !== want) fail('chunk', 'length');
  try {
    return xchacha20poly1305(p.fileKey, p.packet.subarray(0, 24), chunkAad(p.asset, p.file.path, p.index, p.file.plainSize, p.file.plainSha256)).decrypt(p.packet.subarray(24));
  } catch { return fail('chunk', 'auth'); }
}

/** 평문을 받는 곳. 임시 파일을 쓰는 구현이면 abort() 에서 반드시 지운다(앱 기본은 메모리 — 디스크에 평문을 쓰지 않는다). */
export interface PlainSink { write(chunk: Uint8Array): void | Promise<void>; commit(): void | Promise<void>; abort(): void | Promise<void> }
export type DecryptInput = {
  key: Uint8Array; asset: string; file: LockFile;
  /** 암호문 offset 부터 length 바이트(정확히). 게이트웨이가 준 바이트는 믿지 않는다 — 조각마다 인증 태그를 검사한다. */
  read(offset: number, length: number): Promise<Uint8Array>;
  signal?: AbortSignal;
};
/**
 * 조각 단위 복호. 평문은 sink.write 로만 나가고, 전체 평문 SHA-256 이 매니페스트와 맞은 **뒤에만** sink.commit() 한다.
 * 어떤 오류·취소든 sink.abort() 를 부르고 던진다 — 반쯤 복호된 평문을 남기지 않는다.
 */
export async function decryptToSink(p: DecryptInput, sink: PlainSink): Promise<void> {
  const fk = fileKeyOf(p.key, p.asset, p.file.path);
  const digest = sha256.create();
  try {
    const n = chunkCountOf(p.file.plainSize);
    for (let i = 0; i < n; i++) {
      if (p.signal?.aborted) fail('aborted');
      const plainLen = Math.min(LOCK_CHUNK_BYTES, p.file.plainSize - i * LOCK_CHUNK_BYTES);
      const packet = await p.read(i * (LOCK_CHUNK_BYTES + LOCK_CHUNK_OVERHEAD), plainLen + LOCK_CHUNK_OVERHEAD);
      if (p.signal?.aborted) fail('aborted');
      const part = openLockedChunk({ fileKey: fk, asset: p.asset, file: p.file, index: i, packet });
      digest.update(part);
      await sink.write(part);
    }
    if (hex(digest.digest()) !== p.file.plainSha256) fail('plain-hash');
    await sink.commit();
  } catch (e) {
    try { await sink.abort(); } catch { /* 지우기 실패가 원래 오류를 가리지 않게 */ }
    throw e instanceof LockError ? e : new LockError('chunk', 'read');
  } finally { fk.fill(0); }
}

/** 메모리 sink: commit 전에는 아무도 평문 전체를 볼 수 없고, abort 면 0 으로 덮는다. */
export class MemorySink implements PlainSink {
  private buf: Uint8Array | null; private at = 0; private done: Uint8Array | null = null;
  constructor(private readonly size: number) {
    if (!Number.isSafeInteger(size) || size < 1 || size > MAX_MEMORY_PLAIN_BYTES) fail('too-big');
    this.buf = new Uint8Array(size);
  }
  write(chunk: Uint8Array) { if (!this.buf || this.at + chunk.length > this.size) return fail('size', 'overflow'); this.buf.set(chunk, this.at); this.at += chunk.length; }
  commit() { if (!this.buf || this.at !== this.size) fail('size', 'short'); this.done = this.buf; this.buf = null; }
  abort() { this.buf?.fill(0); this.buf = null; this.done?.fill(0); this.done = null; this.at = 0; }
  /** commit 된 평문. 아니면 null. */
  get result(): Uint8Array | null { return this.done; }
}
/** 파일 한 개를 메모리로 복호한다(재생용 Blob 의 원료). 실패·취소면 던지고 아무것도 남기지 않는다. */
export async function decryptToMemory(p: DecryptInput): Promise<Uint8Array> {
  const sink = new MemorySink(p.file.plainSize);
  await decryptToSink(p, sink);
  const out = sink.result;
  if (!out) return fail('size', 'no-result');
  return out;
}

/* ── 열람 키쌍·열람 요청(구매자) ───────────────────────────────────────────── */

export type LockKeypair = { priv: Uint8Array; pub: string };
export function newLockKeypair(rng: Rng = osRandom): LockKeypair {
  const priv = Uint8Array.from(rng(32));
  if (priv.length !== 32 || allZero(priv)) fail('key', 'rng');
  return { priv, pub: hex(x25519.getPublicKey(priv)) };
}

export type LockRequest = { v: 1; asset: string; txid: string; lockPub: string; at: number; sig: string };
export const lockRequestMessage = (r: Pick<LockRequest, 'asset' | 'txid' | 'lockPub' | 'at'>) => `${LOCK_REQ_DOMAIN}\n${r.asset}\n${r.txid}\n${r.lockPub}\n${r.at}`;
/** 결제한 주소의 서명기(노드 signmessage). 서명은 그 주소가 이 지갑 것이 아니면 실패한다. */
export type RequestSigner = (message: string) => Promise<string>;
export async function createLockRequest(p: { asset: string; txid: string; lockPub: string; at: number; sign: RequestSigner }): Promise<string> {
  if (!/^[a-f0-9]{64}$/.test(p.txid) || !HEX(32).test(p.lockPub) || !Number.isSafeInteger(p.at) || p.at < 1) fail('format', 'request-fields');
  const sig = await p.sign(lockRequestMessage(p));
  const body: LockRequest = { v: 1, asset: p.asset, txid: p.txid, lockPub: p.lockPub, at: p.at, sig };
  return REQUEST_PREFIX + b64urlEncode(utf8(canonicalJson(body)));
}
export function decodeLockRequest(text: string): LockRequest | null {
  try {
    const t = String(text ?? '').trim().replace(/\s+/g, '');
    if (!t.startsWith(REQUEST_PREFIX) || t.length > 2000) return null;
    const d = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(b64urlDecode(t.slice(REQUEST_PREFIX.length)))) as Loose;
    if (!plain(d) || Object.keys(d).sort().join() !== 'asset,at,lockPub,sig,txid,v' || d.v !== 1) return null;
    if (typeof d.asset !== 'string' || d.asset.length > 100 || !/^[a-f0-9]{64}$/.test(d.txid) || !HEX(32).test(d.lockPub) ||
        !Number.isSafeInteger(d.at) || d.at < 1 || typeof d.sig !== 'string' || d.sig.length > 200) return null;
    return d as LockRequest;
  } catch { return null; }
}

/* ── 열람 허가(판매자가 만들고 구매자가 푼다) ───────────────────────────────── */

export type LockGrant = { v: 1; asset: string; txid: string; keyId: string; lockPub: string; eph: string; nonce: string; ct: string };
const grantAad = (g: Pick<LockGrant, 'asset' | 'txid' | 'keyId' | 'lockPub' | 'eph'>) => utf8(canonicalJson(['rv-lock-grant-v1', g.asset, g.txid, g.keyId, g.lockPub, g.eph]));
const wrapKeyOf = (shared: Uint8Array, eph: Uint8Array, lockPub: Uint8Array) => hkdf(sha256, shared, concat(eph, lockPub), utf8('rv-lock-wrap-v1'), 32);

/** K 를 구매자 열람 공개키로 싼다. K 가 매니페스트의 지문과 맞는지 먼저 확인한다(틀린 열쇠를 내주지 않는다). */
export function createLockGrant(p: { manifest: CreatorManifest; key: Uint8Array; request: Pick<LockRequest, 'asset' | 'txid' | 'lockPub'>; rng?: Rng }): string {
  const lock = p.manifest.lock;
  if (!lock) return fail('format', 'no-lock');
  if (p.request.asset !== p.manifest.asset) fail('asset');
  const keyId = lockKeyId(p.manifest.asset, p.key);
  if (keyId !== lock.keyId) fail('wrong-key');
  const rng = p.rng ?? osRandom;
  const ephPriv = Uint8Array.from(rng(32)), nonce = Uint8Array.from(rng(24));
  if (ephPriv.length !== 32 || nonce.length !== 24 || allZero(ephPriv)) fail('key', 'rng');
  let lockPub: Uint8Array, eph: Uint8Array, shared: Uint8Array, wrap: Uint8Array;
  try {
    lockPub = unhex(p.request.lockPub);
    eph = x25519.getPublicKey(ephPriv);
    shared = x25519.getSharedSecret(ephPriv, lockPub);
  } catch { return fail('format', 'lock-pub'); }
  if (allZero(shared)) fail('format', 'lock-pub-weak'); // 작은 위수 점 거절
  wrap = wrapKeyOf(shared, eph, lockPub);
  const g = { asset: p.manifest.asset, txid: p.request.txid, keyId, lockPub: p.request.lockPub, eph: hex(eph) };
  const ct = xchacha20poly1305(wrap, nonce, grantAad(g)).encrypt(p.key);
  ephPriv.fill(0); shared.fill(0); wrap.fill(0);
  const body: LockGrant = { v: 1, ...g, nonce: hex(nonce), ct: hex(ct) };
  return GRANT_PREFIX + b64urlEncode(utf8(canonicalJson(body)));
}
export function decodeLockGrant(text: string): LockGrant | null {
  try {
    const t = String(text ?? '').trim().replace(/\s+/g, '');
    if (!t.startsWith(GRANT_PREFIX) || t.length > 1500) return null;
    const d = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(b64urlDecode(t.slice(GRANT_PREFIX.length)))) as Loose;
    if (!plain(d) || Object.keys(d).sort().join() !== 'asset,ct,eph,keyId,lockPub,nonce,txid,v' || d.v !== 1) return null;
    if (typeof d.asset !== 'string' || d.asset.length > 100 || !/^[a-f0-9]{64}$/.test(d.txid) || !HEX(16).test(d.keyId) || !HEX(32).test(d.lockPub) ||
        !HEX(32).test(d.eph) || !HEX(24).test(d.nonce) || typeof d.ct !== 'string' || d.ct.length !== 96 || !/^[a-f0-9]+$/.test(d.ct)) return null;
    return d as LockGrant;
  } catch { return null; }
}
/**
 * 구매자: 허가를 풀어 K 를 얻는다. 거절하는 경우 — 모양이 틀림 · 다른 상품/다른 결제(txid) · 내 열람 공개키가 아님 · 변조 · 푼 K 의 지문이
 * 매니페스트 lock.keyId 와 다름(가짜 허가). 조용히 쓰레기 열쇠를 돌려주지 않는다.
 */
export function openLockGrant(p: { grantText: string; manifest: CreatorManifest; txid: string; lockPriv: Uint8Array }): Uint8Array {
  const lock = p.manifest.lock;
  if (!lock) return fail('format', 'no-lock');
  const g = decodeLockGrant(p.grantText);
  if (!g) return fail('grant', 'format');
  if (g.asset !== p.manifest.asset) fail('asset');
  if (g.txid !== p.txid || g.keyId !== lock.keyId) fail('grant', 'binding');
  let key: Uint8Array;
  try {
    const eph = unhex(g.eph), lockPub = unhex(g.lockPub);
    if (hex(x25519.getPublicKey(p.lockPriv)) !== g.lockPub) return fail('grant', 'not-my-key');
    const shared = x25519.getSharedSecret(p.lockPriv, eph);
    if (allZero(shared)) return fail('grant', 'weak');
    const wrap = wrapKeyOf(shared, eph, lockPub);
    key = xchacha20poly1305(wrap, unhex(g.nonce), grantAad(g)).decrypt(unhex(g.ct));
    shared.fill(0); wrap.fill(0);
  } catch (e) { if (e instanceof LockError) throw e; return fail('grant', 'auth'); }
  if (key.length !== 32 || lockKeyId(p.manifest.asset, key) !== lock.keyId) { key.fill(0); return fail('wrong-key'); }
  return key;
}

/* ── 판매자 처리 ───────────────────────────────────────────────────────── */

/** 체인에서 읽은 거래 요약. inputAddresses 는 이 거래가 쓴 입력(이전 출력)의 주소들. */
export type LockTx = { txid: string; confirmations: number; blockHeight: number | null; inputAddresses: string[]; outputs: Array<{ atoms: string; scriptHex: string }> };
export type PaymentVerdictLite = { ok: true } | { ok: false; reason: string };
/** 결제가 이 상품의 정당한 구매인지. 지갑은 verifyCreatorPayment 를, 데스크탑은 lock-payment.ts 의 판매자 몫 검사를 넣는다. */
export type PaymentVerifier = (tx: LockTx) => PaymentVerdictLite;
export type LedgerEntry = { asset: string; txid: string; lockPub: string; payer: string; grantedAt: number };
export interface LockLedger { list(asset: string, txid: string): readonly LedgerEntry[] }

export type RequestVerdict =
  | { ok: true; grant: string; entry: LedgerEntry; repeat: boolean; payer: string }
  | { ok: false; code: 'format' | 'wrong-asset' | 'signature' | 'tx-missing' | 'not-payer' | 'payment' | 'confirmations' | 'ledger-limit' | 'no-lock' | 'wrong-key'; say: string; wait: boolean; detail?: string };

const SAY: Record<string, string> = {
  format: '열람 요청 글이 아니에요. 구매자가 보낸 글 전체를 다시 붙여 넣어 주세요.',
  'wrong-asset': '이 상품의 요청이 아니에요(다른 상품의 글이에요).',
  signature: '서명이 맞지 않아요. 위조되었거나 글이 잘렸어요. 허가를 만들지 않았어요.',
  'tx-missing': '이 결제 거래를 체인에서 찾지 못했어요. 노드가 따라잡았는지 확인하고 조금 뒤 다시 해 주세요.',
  'not-payer': '요청에 서명한 주소가 이 결제를 보낸 주소가 아니에요. 허가를 만들지 않았어요.',
  payment: '이 거래는 이 상품의 정당한 결제로 확인되지 않아요(받는 곳·금액·메모가 맞지 않음). 허가를 만들지 않았어요.',
  'ledger-limit': '이 결제에는 이미 허가를 여러 번 내줬어요. 더 내주지 않아요.',
  'no-lock': '열람 보호가 걸린 상품이 아니에요.',
  'wrong-key': '이 컴퓨터에 있는 상품 열쇠가 이 상품과 맞지 않아요. 백업한 열쇠 파일로 복원해 주세요.',
};

/**
 * 판매자: 열람 요청 한 건을 검사하고 허가를 만든다. 검사 순서(앞에서 막히면 그 뒤는 보지 않는다):
 *  형식 → 상품 일치 → 서명(signmessage 복원) → 체인 거래 → 서명 주소 ∈ 거래 입력 주소 → 정당한 결제 → 확인 수(미달은 「기다림」) → 장부 한도 → 허가 생성.
 * 같은 열람 공개키로 다시 오면 같은 K 를 새 봉투에 담아 다시 내준다(메시지를 잃은 경우). 다른 공개키는 maxKeysPerPayment 까지.
 */
export function processLockRequest(p: {
  requestText: string; manifest: CreatorManifest; key: Uint8Array; tx: LockTx | null; verifyPayment: PaymentVerifier;
  ledger: LockLedger; now: number; minConfirmations?: number; maxKeysPerPayment?: number; rng?: Rng;
}): RequestVerdict {
  const no = (code: Exclude<RequestVerdict, { ok: true }>['code'], wait = false, detail?: string): RequestVerdict => ({ ok: false, code, say: SAY[code] ?? code, wait, detail });
  if (!p.manifest.lock) return no('no-lock');
  const r = decodeLockRequest(p.requestText);
  if (!r) return no('format');
  if (r.asset !== p.manifest.asset) return no('wrong-asset');
  const payer = recoverMessageAddress(lockRequestMessage(r), r.sig);
  if (!payer) return no('signature');
  if (!p.tx || p.tx.txid !== r.txid) return no('tx-missing', true);
  if (!p.tx.inputAddresses.includes(payer)) return no('not-payer');
  const pay = p.verifyPayment(p.tx);
  if (!pay.ok) return no('payment', false, pay.reason);
  if (!(p.tx.confirmations >= (p.minConfirmations ?? DEFAULT_MIN_CONFIRMATIONS)))
    return { ok: false, code: 'confirmations', wait: true, say: `결제 확인이 아직 모자라요(${Math.max(0, p.tx.confirmations)}/${p.minConfirmations ?? DEFAULT_MIN_CONFIRMATIONS}). 조금 뒤에 다시 처리해 주세요.` };
  const prior = p.ledger.list(r.asset, r.txid);
  const repeat = prior.some(e => e.lockPub === r.lockPub);
  if (!repeat && prior.length >= (p.maxKeysPerPayment ?? DEFAULT_MAX_KEYS_PER_PAYMENT)) return no('ledger-limit');
  let grant: string;
  try { grant = createLockGrant({ manifest: p.manifest, key: p.key, request: r, rng: p.rng }); }
  catch (e) { if (e instanceof LockError && e.code === 'wrong-key') return no('wrong-key'); return no('format', false, e instanceof LockError ? e.detail : ''); }
  return { ok: true, grant, repeat, payer, entry: { asset: r.asset, txid: r.txid, lockPub: r.lockPub, payer, grantedAt: p.now } };
}

/* ── 발행 쪽 도우미 ──────────────────────────────────────────────────────── */

/** 암호화한 파일들의 정보로 매니페스트 lock 칸을 만든다(경로 순 정렬 → 정본 JSON 이 안정적). cids 는 경로 → 암호문 CID. */
export function buildLockSection(p: { asset: string; key: Uint8Array; files: Array<{ path: string; plainSize: number; plainSha256: string; cid: string }>; deliver?: string[] }): LockSection {
  return {
    scheme: LOCK_SCHEME, chunk: LOCK_CHUNK_BYTES, keyId: lockKeyId(p.asset, p.key), wrap: LOCK_WRAP, deliver: p.deliver ?? ['manual'],
    files: [...p.files].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0).map(f => ({ path: f.path, cid: f.cid, plainSize: f.plainSize, plainSha256: f.plainSha256 })),
  };
}

/** 판매자 장부(메모리 판). 앱은 같은 모양으로 저장소에 쓴다. 장부를 잃으면 한도가 풀릴 뿐 열쇠가 새지는 않는다. */
export class MemoryLedger implements LockLedger {
  readonly entries: LedgerEntry[] = [];
  list(asset: string, txid: string): readonly LedgerEntry[] { return this.entries.filter(e => e.asset === asset && e.txid === txid); }
  add(e: LedgerEntry): void { if (!this.entries.some(x => x.asset === e.asset && x.txid === e.txid && x.lockPub === e.lockPub)) this.entries.push(e); }
}
