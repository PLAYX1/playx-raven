import { sha256 } from '@noble/hashes/sha256';

/*
 * 제작자 올리기(creator publish) 공용 바이트 도구 — 순수 함수, Node·브라우저·RN 어디서나 같은 결과.
 * 데스크탑(playx-raven)에 그대로 복사해 쓰므로(core/creator/PROVENANCE.md) 지갑 다른 모듈에 기대지 않는다.
 * canonicalJson 은 게임 허용 목록(core/game-registry/allowlist.ts)과 같은 규칙이다(시험이 같은 입력으로 대조).
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Loose = any;
export const plain = (v: unknown): v is Record<string, Loose> => !!v && typeof v === 'object' && !Array.isArray(v);
export const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);
export const hex = (bytes: Uint8Array): string => Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
export const sha256Hex = (bytes: Uint8Array): string => hex(sha256(bytes));

/** 객체 키를 UTF-16 코드 유닛 순으로 정렬, 공백 없음(RFC 8785 부분집합). 숫자는 안전 정수만 받는다(소수는 표현이 갈릴 수 있다). */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') { if (!Number.isSafeInteger(value)) throw new Error('canonical'); return JSON.stringify(value); }
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  if (plain(value)) {
    return '{' + Object.keys(value).sort().map(k => {
      if (value[k] === undefined) throw new Error('canonical');
      return JSON.stringify(k) + ':' + canonicalJson(value[k]);
    }).join(',') + '}';
  }
  throw new Error('canonical');
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
export function base64Encode(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i], b = bytes[i + 1], c = bytes[i + 2];
    out += B64[a >> 2] + B64[((a & 3) << 4) | ((b ?? 0) >> 4)];
    out += b === undefined ? '=' : B64[((b & 15) << 2) | ((c ?? 0) >> 6)];
    out += c === undefined ? '=' : B64[c & 63];
  }
  return out;
}
export function base64Decode(text: string): Uint8Array {
  if (typeof text !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(text) || text.length % 4 !== 0) throw new Error('base64');
  const clean = text.replace(/=+$/, '');
  const out = new Uint8Array(Math.floor((clean.length * 6) / 8));
  let acc = 0, bits = 0, at = 0;
  for (const ch of clean) {
    acc = ((acc << 6) | B64.indexOf(ch)) & 0xffffff; bits += 6;
    if (bits >= 8) { bits -= 8; out[at++] = (acc >> bits) & 0xff; }
  }
  return out;
}
export const b64urlEncode = (bytes: Uint8Array) => base64Encode(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
export function b64urlDecode(text: string): Uint8Array {
  if (typeof text !== 'string' || !/^[A-Za-z0-9_-]+$/.test(text)) throw new Error('base64url');
  const b64 = text.replace(/-/g, '+').replace(/_/g, '/');
  return base64Decode(b64 + '='.repeat((4 - b64.length % 4) % 4));
}

/** RVN 소수 문자열 → 정수 atoms 문자열(부동소수 없이). 소수 8자리까지. 틀리면 null. */
export function rvnToAtoms(text: string): string | null {
  const m = /^\s*(\d{1,11})(?:\.(\d{1,8}))?\s*$/.exec(String(text ?? ''));
  if (!m) return null;
  const atoms = BigInt(m[1]) * 100_000_000n + BigInt((m[2] ?? '').padEnd(8, '0') || '0');
  return atoms.toString();
}
/** 정수 atoms → 「12.5」 같은 RVN 표기(뒤 0 제거). */
export function atomsToRvn(atoms: string | number | bigint): string {
  const v = BigInt(atoms), whole = v / 100_000_000n, frac = (v % 100_000_000n).toString().padStart(8, '0').replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : String(whole);
}
