import { plain, type Loose } from './bytes';
import { safePath } from './limits';
import { cipherLocationProblem, sha256OfCidV1Raw, type CipherLocation } from './media-ref';
import { downloadDaysProblem, songFormatProblem, type SongFormat } from './download-terms';

/*
 * 상품 문서 v1 의 「잠긴 파일」 칸(lock, 선택) 모양 — RV-LOCK v1 잠금 정보를 판매자 서명 범위 안에 싣는다. (2026-10-14)
 *
 * 왜 따로 두나: product-doc.ts 는 manifest.ts(옛 수수료 파일을 import, 데스크톱과 sha256 으로 묶임)를 import 할 수 없다(fee-guard.test.ts).
 *   그래서 RV-LOCK 상수를 여기에 옮겨 적고, 값이 manifest.ts 와 같다는 것은 product-lock.test.ts 가 대조한다(한쪽만 바뀌면 시험 실패).
 *   암호 로직은 없다 — 모양만 본다. 잠금·허가·복호는 lock.ts 그대로(product-lock.ts 가 잇는다).
 *
 * 칸: lock = { scheme, chunk, keyId, wrap, deliver, files:[{ path, cid, plainSize, plainSha256 }] } — manifest.ts LockSection 과 같은 모양.
 *   차이: cid 는 상품 문서 media 와 같은 규칙(IPFS v0 Qm… 또는 v1 b…). 파일은 경로 순 정렬·중복 없음(정본 JSON 이 하나로 정해진다).
 * 파일마다 선택 칸 cipher = { urls:[판매자 https 1~3], sha256:<암호문 해시>, size:<암호문 바이트> }(결정문 §38, 2026-10-14) — 플랫폼이 암호문을 보관하지 않고
 *   판매자 위치를 서명 범위 안에 적는다. size 는 평문 크기로 정해지는 RV-LOCK 암호문 크기와 **정확히** 같아야 한다(평문 200MB 상한 그대로).
 *   칸이 없으면 예전 모양 그대로(서명 바이트·상품 ID 불변). 상품 ID 는 lock 칸을 뺀 본문 해시라 cipher 를 넣어도 ID 는 같다.
 * 선택 칸(2026-10-14 대표 결정, download-terms.ts): lock.downloadDays = 구매 후 다시 받기 기간(일, 최소~최대 정수),
 *   lock.files[].format = 파일 형식(소문자 열거). 둘 다 서명 범위 안이고, 없으면 예전 모양·바이트·ID 그대로.
 */

export const PRODUCT_LOCK_SCHEME = 'rv-lock-v1';
export const PRODUCT_LOCK_CHUNK_BYTES = 65536;
/** 조각마다 붙는 바이트(nonce 24 + 인증 태그 16 = manifest.ts LOCK_CHUNK_OVERHEAD 와 같음, 시험이 대조). */
export const PRODUCT_LOCK_CHUNK_OVERHEAD = 40;
export const PRODUCT_LOCK_WRAP = 'x25519-hkdf-sha256-xchacha20poly1305';
export const PRODUCT_LOCK_DELIVER: readonly string[] = Object.freeze(['manual', 'chain-mailbox', 'server']);
/** 잠긴 파일 하나의 평문 상한(manifest.ts lock 칸과 같은 200MB). */
export const PRODUCT_LOCK_MAX_PLAIN_BYTES = 200 * 1024 * 1024;
export const PRODUCT_LOCK_MAX_FILES = 50;
/** 잠금 칸을 둘 수 있는 상품 종류(manifest.ts LOCKABLE 과 같은 셋). */
export const PRODUCT_LOCK_KINDS: readonly string[] = Object.freeze(['music', 'book', 'digital']);

/** 평문 크기 → RV-LOCK 암호문 크기(manifest.ts lockCipherSize 와 같은 식: 평문 + 40 × 조각 수, 조각 수 ≥ 1). */
export const productLockCipherSize = (plainSize: number): number => plainSize + PRODUCT_LOCK_CHUNK_OVERHEAD * Math.max(1, Math.ceil(plainSize / PRODUCT_LOCK_CHUNK_BYTES));
/** 암호문 크기 상한 = 평문 상한(200MB)의 암호문 크기. */
export const PRODUCT_LOCK_MAX_CIPHER_BYTES = productLockCipherSize(PRODUCT_LOCK_MAX_PLAIN_BYTES);

export type ProductLockFile = { path: string; cid: string; plainSize: number; plainSha256: string; cipher?: CipherLocation; format?: SongFormat };
export type ProductLockSection = {
  scheme: typeof PRODUCT_LOCK_SCHEME; chunk: typeof PRODUCT_LOCK_CHUNK_BYTES; keyId: string; wrap: typeof PRODUCT_LOCK_WRAP; deliver: string[]; files: ProductLockFile[];
  /** 구매 후 다시 받기 기간(일). 없으면 옛 문서(기간 미표시). */
  downloadDays?: number;
};

const keysAre = (o: Record<string, Loose>, keys: string) => Object.keys(o).sort().join() === keys.split(',').sort().join();
const CID = /^(Qm[1-9A-HJ-NP-Za-km-z]{44}|b[a-z2-7]{58,100})$/;
const SHA = /^[a-f0-9]{64}$/;

/** 잠금 칸의 다시 받기 기간(일). 칸이 없거나(옛 문서) 모양이 틀리면 null. */
export const lockDownloadDays = (lock: unknown): number | null =>
  plain(lock) && 'downloadDays' in lock && downloadDaysProblem(lock.downloadDays) === null ? (lock.downloadDays as number) : null;

/** 모양 문제를 짧은 영문 코드로 돌려준다(없으면 null). 던지지 않는다 — 부르는 쪽이 자기 오류 형식으로 바꾼다. */
export function productLockProblem(x: unknown, kind?: string): string | null {
  if (kind !== undefined && !PRODUCT_LOCK_KINDS.includes(kind)) return 'kind';
  if (!plain(x) || !keysAre(x, 'scheme,chunk,keyId,wrap,deliver,files' + ('downloadDays' in x ? ',downloadDays' : ''))) return 'keys';
  if ('downloadDays' in x) { const p = downloadDaysProblem(x.downloadDays); if (p) return p; }
  if (x.scheme !== PRODUCT_LOCK_SCHEME || x.chunk !== PRODUCT_LOCK_CHUNK_BYTES || x.wrap !== PRODUCT_LOCK_WRAP) return 'scheme';
  if (typeof x.keyId !== 'string' || !/^[a-f0-9]{32}$/.test(x.keyId)) return 'key-id';
  if (!Array.isArray(x.deliver) || x.deliver.length < 1 || x.deliver.length > PRODUCT_LOCK_DELIVER.length || new Set(x.deliver).size !== x.deliver.length ||
      x.deliver.some((d: unknown) => typeof d !== 'string' || !PRODUCT_LOCK_DELIVER.includes(d))) return 'deliver';
  if (!Array.isArray(x.files) || x.files.length < 1 || x.files.length > PRODUCT_LOCK_MAX_FILES) return 'files';
  let last = '';
  for (const f of x.files as unknown[]) {
    if (!plain(f) || !keysAre(f, 'path,cid,plainSize,plainSha256' + ('cipher' in f ? ',cipher' : '') + ('format' in f ? ',format' : '')) || typeof f.path !== 'string' || !safePath(f.path) || typeof f.cid !== 'string' || !CID.test(f.cid) ||
        typeof f.plainSha256 !== 'string' || !SHA.test(f.plainSha256) || typeof f.plainSize !== 'number' || !Number.isSafeInteger(f.plainSize) ||
        f.plainSize < 1 || f.plainSize > PRODUCT_LOCK_MAX_PLAIN_BYTES) return 'file';
    if ('format' in f) { const p = songFormatProblem(f.format); if (p) return p; }
    if ('cipher' in f) {
      const p = cipherLocationProblem(f.cipher, productLockCipherSize(f.plainSize));
      if (p) return p;
      // cid 가 CIDv1-raw 표기면 같은 암호문 다이제스트여야 한다(같은 파일을 두 값으로 적지 않는다). Qm/dag-pb 는 바이트로 맞출 수 없어 그대로 둔다.
      const d = sha256OfCidV1Raw(f.cid);
      if (d !== null && d !== f.cipher.sha256) return 'cipher-cid';
    }
    if (last && f.path <= last) return 'file-order';
    last = f.path;
  }
  return null;
}
