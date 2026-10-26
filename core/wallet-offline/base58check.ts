import { sha256 } from '@noble/hashes/sha256';
import { concatBytes } from '../playx-asset-proof/crypto';

const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const BASE = BigInt(58);
const RVN_P2PKH_VERSION = 0x3c;
const RVN_P2SH_VERSION = 0x7a;

export class Base58CheckError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'Base58CheckError';
  }
}

export function decodeBase58Check(addr: string): { version: number; hash160: Uint8Array } {
  if (typeof addr !== 'string' || addr.length < 26 || addr.length > 35) {
    throw new Base58CheckError('Ravencoin 주소 길이가 올바르지 않습니다');
  }

  const raw = decodeBase58(addr);
  if (raw.length !== 25) {
    throw new Base58CheckError(`Base58Check payload 길이가 25바이트가 아닙니다: ${raw.length}`);
  }

  const body = raw.slice(0, 21);
  const checksum = raw.slice(21);
  const expected = sha256(sha256(body)).slice(0, 4);
  if (!equalBytes(checksum, expected)) {
    throw new Base58CheckError('Base58Check 체크섬이 일치하지 않습니다');
  }

  const version = body[0];
  const hash160 = body.slice(1);
  if (hash160.length !== 20) {
    throw new Base58CheckError('주소 hash160 길이가 20바이트가 아닙니다');
  }
  return { version, hash160 };
}

export function encodeBase58Check(version: number, payload: Uint8Array): string {
  if (!Number.isInteger(version) || version < 0 || version > 0xff) {
    throw new Base58CheckError('Base58Check version 은 1바이트 정수여야 합니다');
  }
  if (payload.length !== 20) {
    throw new Base58CheckError('Ravencoin 주소 payload 는 hash160 20바이트여야 합니다');
  }
  const body = concatBytes(Uint8Array.from([version]), payload);
  const checksum = sha256(sha256(body)).slice(0, 4);
  return encodeBase58(concatBytes(body, checksum));
}

export function isValidRvnAddressStrict(addr: unknown): addr is string {
  if (typeof addr !== 'string') return false;
  try {
    const decoded = decodeBase58Check(addr);
    return decoded.version === RVN_P2PKH_VERSION || decoded.version === RVN_P2SH_VERSION;
  } catch (error) {
    if (error instanceof Base58CheckError) return false;
    throw error;
  }
}

function decodeBase58(text: string): Uint8Array {
  let value = BigInt(0);
  for (const ch of text) {
    const digit = ALPHABET.indexOf(ch);
    if (digit < 0) throw new Base58CheckError(`Base58 문자가 아닙니다: ${ch}`);
    value = value * BASE + BigInt(digit);
  }

  const bytes: number[] = [];
  while (value > BigInt(0)) {
    bytes.push(Number(value & BigInt(0xff)));
    value /= BigInt(256);
  }
  bytes.reverse();

  let leadingZeroes = 0;
  for (const ch of text) {
    if (ch !== '1') break;
    leadingZeroes++;
  }

  const out = new Uint8Array(leadingZeroes + bytes.length);
  out.set(bytes, leadingZeroes);
  return out;
}

function encodeBase58(bytes: Uint8Array): string {
  let value = BigInt(0);
  for (const byte of bytes) value = (value << BigInt(8)) + BigInt(byte);

  let text = '';
  while (value > BigInt(0)) {
    const digit = Number(value % BASE);
    text = ALPHABET[digit] + text;
    value /= BASE;
  }

  for (const byte of bytes) {
    if (byte !== 0) break;
    text = '1' + text;
  }
  return text || '1';
}

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}
