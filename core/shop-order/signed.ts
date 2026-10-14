import { secp256k1 } from '@noble/curves/secp256k1';
import { canonicalJson, plain, sha256Hex, utf8, type Loose } from '../creator/bytes';
import { recoverMessagePublicKey } from '../creator/product-doc';
import { addressOfPublicKey } from '../creator/trade-primitives';
import { signMessageWithKeyForTest } from '../signer/test-key';
import { signMessageWith, type SignDigest } from '../signer/signmessage';

/*
 * 매장 주문(§21 B1·B2, §25) 서명 문서 공용 도구 — 순수 함수(시계·저장소·네트워크 없음, 시각은 호출 측이 ms 로 준다).
 * 서명 = 상품 문서 v1 과 같은 방식: 레이븐 코어 signmessage 바이트(65바이트 복구형 base64), 문구 = `<도메인>\nsha256:<본문 정본 JSON 해시>`.
 * 확인은 product-doc.ts recoverMessagePublicKey 를 그대로 쓴다(새 암호 구현 없음). 되살린 공개키가 기대 공개키와 바이트까지 같아야 한다.
 * 노드에서 서명하려면 공개키 주소(addressOfKey)로 `signmessage <주소> <문구>`.
 */

export type ShopOrderErrorCode =
  | 'shape' | 'json' | 'too-large' | 'signature' | 'key' | 'pay-to' | 'amount' | 'ttl' | 'rate' | 'scope' | 'cert' | 'revocation' | 'fee';
export class ShopOrderError extends Error {
  constructor(readonly code: ShopOrderErrorCode, readonly detail = '') { super(detail ? `${code}: ${detail}` : code); this.name = 'ShopOrderError'; }
}
export const fail = (code: ShopOrderErrorCode, detail = ''): never => { throw new ShopOrderError(code, detail); };

export const PUBKEY = /^0[23][a-f0-9]{64}$/;
export const SHA = /^[a-f0-9]{64}$/;
/** 주문 ID: 가게가 정하는 짧은 토큰(영숫자·-·_ 1~64자). */
export const ORDER_ID = /^[A-Za-z0-9_-]{1,64}$/;
/** 시각(ms) 상한 — 안전 정수 안, 9999년 이전. */
export const MAX_TIME_MS = 253_402_300_799_000;

export const keysAre = (o: Record<string, Loose>, keys: string) => Object.keys(o).sort().join() === keys.split(',').sort().join();
export const int = (n: unknown, min: number, max: number): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= min && n <= max;
export const time = (n: unknown): n is number => int(n, 1, MAX_TIME_MS);
/**
 * 판정 함수가 받는 「지금」(ms) — 유한 안전 정수이고 2001-09-09 이후여야 한다(리뷰 M1). NaN·undefined·소수·초 단위(10자리)를 넣으면
 * 모든 판정 함수가 첫 줄에서 닫힌 실패(bad-clock)를 낸다. 이 하한이면 초 단위 값(≈1.7e9)은 절대 통과하지 못한다.
 */
export const MIN_NOW_MS = 1_000_000_000_000;
export const isNowMs = (n: unknown): n is number => int(n, MIN_NOW_MS, MAX_TIME_MS);
/** 화면 글자: NFC·앞뒤 공백 없음·제어/방향 바꿈 문자 없음. */
export const text = (s: unknown, min: number, max: number): s is string => typeof s === 'string' && s.length >= min && s.length <= max &&
  s === s.normalize('NFC') && s.trim() === s && !/[\u0000-\u001f\u007f‎‏‪-‮⁦-⁩]/.test(s);

/** 압축 공개키 hex 이고 곡선 위의 점인가. */
export function isPublicKey(k: unknown): k is string {
  if (typeof k !== 'string' || !PUBKEY.test(k)) return false;
  try { secp256k1.ProjectivePoint.fromHex(k).assertValidity(); return true; } catch { return false; }
}
const unhex = (h: string): Uint8Array => Uint8Array.from(h.match(/../g) ?? [], b => parseInt(b, 16));
/** 공개키 → signmessage 에 쓸 주소. */
export const addressOfKey = (pubHex: string): string => addressOfPublicKey(unhex(pubHex));

export function withoutSig<T extends { sig?: unknown }>(doc: T): Omit<T, 'sig'> {
  const { sig: _s, ...rest } = doc;
  return rest;
}
/** sig 를 뺀 본문의 정본 JSON 해시. */
export const bodyHash = (doc: Record<string, Loose>): string => sha256Hex(utf8(canonicalJson(withoutSig(doc))));
export const signingMessage = (domain: string, doc: Record<string, Loose>): string => `${domain}\nsha256:${bodyHash(doc)}`;

/** 서명이 이 공개키(압축)에서 나왔나. 모양이 틀린 서명도 false. */
export function signedBy(domain: string, doc: Record<string, Loose>, pubHex: string): boolean {
  if (typeof doc.sig !== 'string' || doc.sig.length > 200) return false;
  return recoverMessagePublicKey(signingMessage(domain, doc), doc.sig) === pubHex;
}

/** 바이트 또는 객체를 받아 객체로. 바이트는 정본 JSON 이어야 한다(다른 직렬화는 같은 서명이어도 거절). */
export function readDoc(input: Uint8Array | unknown, maxBytes: number): Record<string, Loose> {
  let doc: unknown = input;
  if (input instanceof Uint8Array) {
    if (input.length > maxBytes) fail('too-large');
    try { doc = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(input)); } catch { fail('json'); }
  }
  if (!plain(doc)) return fail('shape', 'not-object');
  let bytes: Uint8Array;
  try { bytes = utf8(canonicalJson(doc)); } catch { return fail('shape', 'canonical'); }
  if (bytes.length > maxBytes) fail('too-large');
  if (input instanceof Uint8Array && sha256Hex(input) !== sha256Hex(bytes)) fail('shape', 'not-canonical');
  return doc;
}
export const encodeDoc = (doc: Record<string, Loose>): Uint8Array => utf8(canonicalJson(doc));

/** 시험·도구 전용 서명기(개인키를 받는다). 앱은 노드 signmessage(데스크톱 sign_message)로 서명한다. product-doc signProductDocForTest 와 같은 바이트. */
export function signForTest<T extends Record<string, Loose>>(domain: string, body: T, privateKey: Uint8Array): T & { sig: string } {
  const clean = withoutSig(body) as T;
  const sig = signMessageWithKeyForTest(signingMessage(domain, clean), privateKey);
  return { ...clean, sig };
}
/** 운영용: 키를 가진 서명 콜백으로 매장 주문 문서(견적·상태·직원 위임·철회)에 서명한다. publicKey = 그 문서의 기대 서명자(압축 hex). */
export async function signShopDoc<T extends Record<string, Loose>>(signer: SignDigest, domain: string, body: T, publicKey: string): Promise<T & { sig: string }> {
  const clean = withoutSig(body) as T;
  return { ...clean, sig: await signMessageWith(signer, signingMessage(domain, clean), { publicKey }) };
}
