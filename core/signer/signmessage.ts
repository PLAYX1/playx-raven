import { secp256k1 } from '@noble/curves/secp256k1';
import { base64Encode, hex } from '../creator/bytes';
import { addressOfPublicKey, messageHash } from '../creator/trade-primitives';

/*
 * 운영용 signmessage 서명 경로 — 키를 갖지 않는다. (2026-10-14)
 *
 * 키는 호출자가 넘긴 서명 콜백(SignDigest) 안에만 있다. 이 파일의 어떤 함수도 비밀키를 인자로 받거나 돌려주거나 로그에 쓰지 않는다.
 * 콜백은 32바이트 다이제스트(= sha256d("\x16Raven Signed Message:\n" ‖ varint ‖ 문구), 노드 signmessage 와 같은 바이트)만 받는다.
 *
 * 흐름: 다이제스트 → 콜백 서명 → (r,s) 범위 검사 → low-S 정규화(s>n/2 이면 n-s, recid^1) → recid 확정 → 65바이트 복구형(머리 31+recid, 압축 키)
 *   → 즉시 자기 검증(복구 공개키 = 기대 공개키, ECDSA 검증 lowS) → base64. 어느 단계든 실패하면 SignerError(코드만, 바이트 없음)를 던지고
 *   부분 서명은 돌려주지 않는다.
 * low-S 가 필수인 이유: 같은 문서에 (r,s)·(r,n-s) 두 서명이 다 유효하면 sig 칸이 들어간 문서 해시(방 문서 판 해시 등)가 둘로 갈린다.
 * 결정적 서명(RFC6979)은 콜백의 책임이다(노드·noble 기본값). 결정적이면 같은 키·문구는 노드와 같은 바이트가 된다(node-vectors.json).
 */

/** 콜백이 돌려줄 수 있는 모양: {r,s,recid?}(bigint 또는 32바이트) · 65바이트 복구형(머리 27~34) · 64바이트 compact(recid 없음). */
export type RawDigestSignature = { r: bigint | Uint8Array; s: bigint | Uint8Array; recid?: number } | Uint8Array;
/** 키를 가진 쪽의 서명 콜백. 받은 다이제스트를 바꾸지 말고, 키는 콜백 안에서 쓰고 지운다. */
export type SignDigest = (digest32: Uint8Array) => Promise<RawDigestSignature>;
export type SignOptions = {
  /** 기대 서명자 압축 공개키(66 hex). 주면 recid 를 이 키로 확정하고 다른 키의 서명은 거절한다. 문서 헬퍼는 항상 준다. */
  publicKey?: string;
};

export type SignerErrorCode = 'digest' | 'signer-failed' | 'signature-shape' | 'signature-range' | 'recid' | 'public-key' | 'key-mismatch' | 'self-verify';
export class SignerError extends Error {
  constructor(readonly code: SignerErrorCode) { super(`signer: ${code}`); this.name = 'SignerError'; }
}
const fail = (code: SignerErrorCode): never => { throw new SignerError(code); };

const N = secp256k1.CURVE.n;
const PUBKEY = /^0[23][a-f0-9]{64}$/;
const toBig = (v: bigint | Uint8Array): bigint => {
  if (typeof v === 'bigint') return v;
  if (!(v instanceof Uint8Array) || v.length !== 32) return fail('signature-shape');
  return BigInt('0x' + (hex(v) || '0'));
};

function parseRaw(raw: RawDigestSignature): { r: bigint; s: bigint; recid: number | null } {
  if (raw instanceof Uint8Array) {
    if (raw.length === 65) {
      if (raw[0] < 27 || raw[0] > 34) fail('signature-shape');
      return { r: toBig(raw.slice(1, 33)), s: toBig(raw.slice(33, 65)), recid: (raw[0] - 27) & 3 };
    }
    if (raw.length === 64) return { r: toBig(raw.slice(0, 32)), s: toBig(raw.slice(32, 64)), recid: null };
    return fail('signature-shape');
  }
  if (!raw || typeof raw !== 'object') return fail('signature-shape');
  const recid = raw.recid === undefined ? null : raw.recid;
  if (recid !== null && !(Number.isInteger(recid) && recid >= 0 && recid <= 3)) fail('recid');
  return { r: toBig(raw.r), s: toBig(raw.s), recid };
}

function recover(digest: Uint8Array, r: bigint, s: bigint, recid: number): string | null {
  try { return new secp256k1.Signature(r, s).addRecoveryBit(recid).recoverPublicKey(digest).toHex(true); } catch { return null; }
}

/**
 * 콜백이 준 서명을 노드 signmessage 형식으로 마무리한다(동기, 키 없음). 시험 경로(*ForTest)와 운영 경로가 이 함수를 같이 쓴다.
 * 돌려주는 값 = 65바이트 복구형 base64. 실패하면 SignerError.
 */
export function finishSignature(digest: Uint8Array, raw: RawDigestSignature, opts: SignOptions = {}): string {
  if (!(digest instanceof Uint8Array) || digest.length !== 32) fail('digest');
  const want = opts.publicKey;
  if (want !== undefined && (typeof want !== 'string' || !PUBKEY.test(want))) fail('public-key');
  let { r, s, recid } = parseRaw(raw);
  if (r <= 0n || r >= N || s <= 0n || s >= N) fail('signature-range');
  if (s > N >> 1n) { s = N - s; if (recid !== null) recid ^= 1; }
  let signer: string | null = null;
  if (recid !== null) {
    signer = recover(digest, r, s, recid);
    if (signer === null) fail('recid');
    if (want !== undefined && signer !== want) fail('key-mismatch');
  } else {
    if (want === undefined) fail('recid');
    for (let i = 0; i < 4 && signer === null; i++) if (recover(digest, r, s, i) === want) { recid = i; signer = want!; }
    if (signer === null) fail('key-mismatch');
  }
  const out = new Uint8Array(65);
  out[0] = 31 + (recid as number);
  out.set(new secp256k1.Signature(r, s).toCompactRawBytes(), 1);
  // 자기 검증: 내보낼 바이트 그대로 다시 읽어 복구·검증한다.
  let verified = false;
  try {
    const again = secp256k1.Signature.fromCompact(out.subarray(1)).addRecoveryBit((out[0] - 27) & 3);
    const point = again.recoverPublicKey(digest);
    verified = !again.hasHighS() && point.toHex(true) === signer &&
      secp256k1.verify(again.toCompactRawBytes(), digest, point.toRawBytes(true), { lowS: true });
  } catch { verified = false; }
  if (!verified) fail('self-verify');
  return base64Encode(out);
}

/** 문구의 signmessage 다이제스트(32바이트). 콜백에는 사본을 넘긴다. */
export const signMessageDigest = (message: string): Uint8Array => {
  if (typeof message !== 'string') fail('digest');
  return messageHash(message);
};

/**
 * 운영용 signmessage. signer = 키를 가진 콜백(폰 지갑 어댑터 등). 노드 `signmessage <주소> <문구>` 와 같은 base64 를 돌려준다.
 * 콜백이 던지면 SignerError('signer-failed') — 콜백의 오류 문구는 옮기지 않는다(키·부분 값이 섞여 있을 수 있다).
 */
export async function signMessageWith(signer: SignDigest, message: string, opts: SignOptions = {}): Promise<string> {
  const digest = signMessageDigest(message);
  let raw: RawDigestSignature;
  try { raw = await signer(digest.slice()); } catch { return fail('signer-failed'); }
  return finishSignature(digest, raw, opts);
}

/** 압축 공개키 hex → signmessage 에 쓰는 R… 주소. */
export const signerAddressOf = (publicKey: string): string => {
  if (typeof publicKey !== 'string' || !PUBKEY.test(publicKey)) fail('public-key');
  return addressOfPublicKey(Uint8Array.from(publicKey.match(/../g)!, b => parseInt(b, 16)));
};
