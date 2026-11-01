/**
 * NIP-44 v2 — 쪽지 봉투 암호. 데스크탑 웹 지갑(`web/nip44.ts`)을 그대로 옮겼다(같은 바이트가 나와야 서로 연다).
 *
 * 1. ECDH 공유점의 x 좌표 → HKDF-extract(salt "nip44-v2") = 대화 열쇠
 * 2. 32바이트 nonce 로 HKDF-expand → chacha 열쇠·nonce·hmac 열쇠
 * 3. 길이 2바이트 + 본문 + 0 채움(2의 거듭제곱 칸) → chacha20 → HMAC-SHA256(nonce‖암호문)
 *
 * ECDH 는 core/crypto-backend 의 secp256k1.ecdh(압축점 x 32바이트)를 쓴다.
 * ⚠️ 이 암호는 외부 감사를 받지 않았다. 화면이 그렇게 말한다.
 */
import { chacha20 } from '@noble/ciphers/chacha.js';
import { extract, expand } from '@noble/hashes/hkdf';
import { hmac } from '@noble/hashes/hmac';
import { sha256 } from '@noble/hashes/sha256';
import { secp256k1 } from '../crypto-backend';
import { hexToBytes as unhex, utf8Bytes as utf8 } from '../playx-asset-proof/crypto';

const VERSION = 2;
const SALT = utf8('nip44-v2');

export function conversationKey(mySecret: Uint8Array, theirPubHex: string): Uint8Array {
  const shared = secp256k1.ecdh(mySecret, unhex('02' + theirPubHex));
  return extract(sha256, shared, SALT);
}

function messageKeys(convKey: Uint8Array, nonce: Uint8Array) {
  const k = expand(sha256, convKey, nonce, 76);
  return { chachaKey: k.subarray(0, 32), chachaNonce: k.subarray(32, 44), hmacKey: k.subarray(44, 76) };
}

export function paddedLength(len: number): number {
  if (len <= 32) return 32;
  const next = 1 << (Math.floor(Math.log2(len - 1)) + 1);
  const chunk = next <= 256 ? 32 : next / 8;
  return chunk * (Math.floor((len - 1) / chunk) + 1);
}

function pad(plain: string): Uint8Array {
  const b = utf8(plain);
  if (b.length < 1 || b.length > 65535) throw new Error('쪽지 길이가 맞지 않아요(1~65,535바이트).');
  const out = new Uint8Array(2 + paddedLength(b.length));
  out[0] = b.length >> 8; out[1] = b.length & 0xff; out.set(b, 2);
  return out;
}

function unpad(padded: Uint8Array): string {
  const len = (padded[0] << 8) | padded[1];
  const body = padded.subarray(2, 2 + len);
  if (len < 1 || body.length !== len || padded.length !== 2 + paddedLength(len)) throw new Error('쪽지 내용이 깨졌어요.');
  return new TextDecoder().decode(body);
}

const random32 = () => globalThis.crypto.getRandomValues(new Uint8Array(32));

/** nonce 는 시험(공개 벡터)에서만 넣는다. */
export function encrypt(plain: string, convKey: Uint8Array, nonce: Uint8Array = random32()): string {
  const { chachaKey, chachaNonce, hmacKey } = messageKeys(convKey, nonce);
  const ct = chacha20(chachaKey, chachaNonce, pad(plain));
  const mac = hmac(sha256, hmacKey, concat(nonce, ct));
  return b64(concat(Uint8Array.of(VERSION), nonce, ct, mac));
}

export function decrypt(payload: string, convKey: Uint8Array): string {
  if (typeof payload !== 'string' || payload.length < 132 || payload.length > 87_472 || payload[0] === '#') throw new Error('쪽지 형식이 아니에요.');
  const raw = unb64(payload);
  if (raw[0] !== VERSION) throw new Error(`모르는 쪽지 방식이에요(${raw[0]}).`);
  const nonce = raw.subarray(1, 33), ct = raw.subarray(33, raw.length - 32), mac = raw.subarray(raw.length - 32);
  const { chachaKey, chachaNonce, hmacKey } = messageKeys(convKey, nonce);
  if (!equal(hmac(sha256, hmacKey, concat(nonce, ct)), mac)) throw new Error('봉인이 맞지 않아 열지 않았어요.');
  return unpad(chacha20(chachaKey, chachaNonce, ct));
}

function concat(...arr: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(arr.reduce((n, a) => n + a.length, 0));
  let at = 0;
  for (const a of arr) { out.set(a, at); at += a.length; }
  return out;
}
function equal(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
// Hermes 의 atob/btoa 유무에 기대지 않는다(폰·웹·node 모두 같은 결과).
function b64(b: Uint8Array): string {
  let s = '';
  for (let i = 0; i < b.length; i += 3) {
    const n = (b[i] << 16) | ((b[i + 1] ?? 0) << 8) | (b[i + 2] ?? 0);
    s += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + (i + 1 < b.length ? B64[(n >> 6) & 63] : '=') + (i + 2 < b.length ? B64[n & 63] : '=');
  }
  return s;
}
function unb64(s: string): Uint8Array {
  const clean = s.replace(/=+$/, '');
  if (/[^A-Za-z0-9+/]/.test(clean)) throw new Error('쪽지 형식이 아니에요.');
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let bits = 0, acc = 0, at = 0;
  for (const c of clean) {
    acc = (acc << 6) | B64.indexOf(c); bits += 6;
    if (bits >= 8) { bits -= 8; out[at++] = (acc >> bits) & 0xff; }
  }
  return out.subarray(0, at);
}
