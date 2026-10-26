import { sha256 } from '@noble/hashes/sha256';
import { ripemd160 } from '@noble/hashes/ripemd160';
import { decodeBase58Check, encodeBase58Check } from '../wallet-offline/base58check';
import { hex, utf8 } from './bytes';

/*
 * 새 수수료 코어(product-doc · fee-track-v2 · fee-policy · entitlement)가 쓰는 기초 값·함수 — 한 곳. (2026-10-13, 결정문 §18 Q3)
 *
 * 왜 따로 두나: 새 코어는 옛 수수료 규칙 파일(core/creator/fee-schedule.ts · core/game-registry/platform-fee.ts)을
 *   직접이든 간접이든 import 하면 안 된다(§18 Q3 「옛 경로 호출 불가」). manifest.ts 는 두 파일을 import 하고,
 *   fee-schedule.ts·manifest.ts 는 데스크톱과 sha256 으로 묶여 있어 고칠 수 없다. 그래서 새 코어가 필요한 값만 여기로 옮겨 적는다.
 *   옛 파일과 값이 같다는 것은 fee-guard.test.ts 가 대조한다(한쪽만 바뀌면 시험 실패).
 *
 * 이 파일은 옛 수수료 파일을 import 하지 않는다(fee-guard.test.ts 가 import 경로 전체를 따라가 확인).
 */

/** 레이븐코인 목표 블록 간격 1분 → 하루 1440블록(fee-schedule.ts BLOCKS_PER_DAY 와 같은 근사). */
export const BLOCKS_PER_DAY = 1440;
/** 레이븐볼트 장터 수수료 주소(대표 확정 2026-10-11, fee-schedule.ts MARKET_FEE_ADDRESS 와 같은 값). */
export const MARKET_FEE_ADDRESS = 'RLFnbkjmf1VCVq7D9TZvRp7fv6W97rm2cB';
/** 어느 칸도 5% 이하(§14-3, fee-schedule.ts MARKET_FEE_BPS_CEILING 과 같은 값). */
export const MARKET_FEE_BPS_CEILING = 500;
/** 상품 하나 가격 상한(manifest.ts MAX_PRICE_ATOMS 와 같은 값). */
export const MAX_PRICE_ATOMS = 100_000n * 100_000_000n;
/** IPFS CID v0(manifest.ts CID_V0 와 같은 정규식). */
export const CID_V0 = /^Qm[1-9A-HJ-NP-Za-km-z]{44}$/;

/** 운영 키 id = 공개키 32바이트 SHA-256 앞 8바이트 hex(fee-schedule.ts keyIdOf 와 같다). */
export const keyIdOf = (publicRaw: Uint8Array): string => hex(sha256(publicRaw).slice(0, 8));

const ADDRESS = /^R[1-9A-HJ-NP-Za-km-z]{25,34}$/;
/** 표준 P2PKH(R…) 주소인가 — 모양 + Base58Check + 버전 0x3c(manifest.ts isRvnAddress 와 같다). */
export function isRvnAddress(a: unknown): a is string {
  if (typeof a !== 'string' || !ADDRESS.test(a)) return false;
  try { return decodeBase58Check(a).version === 0x3c; } catch { return false; }
}
/** 공개키 → P2PKH 주소(manifest.ts addressOfPublicKey 와 같다). */
export const addressOfPublicKey = (pub: Uint8Array): string => encodeBase58Check(0x3c, ripemd160(sha256(pub)));

const varint = (n: number) => n < 0xfd ? [n] : n <= 0xffff ? [0xfd, n & 255, n >> 8] : [0xfe, n & 255, (n >> 8) & 255, (n >> 16) & 255, (n >>> 24) & 255];
/** sha256d("\x16Raven Signed Message:\n" ‖ varint(len) ‖ msg) — 노드 signmessage 와 같은 바이트(manifest.ts messageHash 와 같다). */
export function messageHash(message: string): Uint8Array {
  const prefix = utf8('\x16Raven Signed Message:\n'), msg = utf8(message);
  const all = new Uint8Array(prefix.length + msg.length + 5);
  const v = varint(msg.length);
  all.set(prefix, 0); all.set(v, prefix.length); all.set(msg, prefix.length + v.length);
  return sha256(sha256(all.subarray(0, prefix.length + v.length + msg.length)));
}
