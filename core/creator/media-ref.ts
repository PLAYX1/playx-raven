import { plain, sha256Hex, type Loose } from './bytes';
import { isSsrfRiskyHost } from '../store/ssrf-host';

/*
 * 상품 문서의 파일 표기 — 27라운드(결정문 §38) 권고의 순수 부분. 새 암호 없음(sha256 = @noble, 아래 base32 는 인코딩일 뿐).
 *
 * ① 사진(media 항목): 「재인코딩 결과 바이트의 SHA-256 하나」가 서명값·서빙 경로·검증 값이다.
 *    새 항목 = { sha256:<hex> } 또는 { sha256, cid } — cid 는 **같은 다이제스트의 CIDv1-raw(sha2-256) 표기**일 때만 받는다.
 *    옛 항목(문자열 CID: Qm…/b…)은 그대로 받는다(서명 바이트 불변). 옛 Qm/dag-pb 값을 sha256 으로 취급·자동 변환하지 않는다.
 * ② 잠근 곡 암호문 위치(lock.files[].cipher): 플랫폼이 보관하지 않는다 — 판매자 HTTPS 위치 1~MAX_CIPHER_URLS 개 + 암호문 sha256·크기.
 *    위치 주소는 isSellerFileUrl 로만 받는다(https·계정 없음·포트 없음·내부 이름/IP 거절 — core/store/ssrf-host.ts 재사용).
 *    🔴 이름 검사는 DNS 재바인딩을 막지 못한다(ssrf-host.ts 주석). 구매자 앱이 가져올 때는 판매자 위치를 「믿지 않는 바이트」로만 다루고
 *       해시·크기로 다시 맞춘다(file-check.ts). 서버가 이 주소를 대신 가져가지 않는다.
 *
 * CIDv1-raw = multibase 'b'(base32 소문자, 패딩 없음) ‖ base32( 0x01(cid v1) 0x55(raw) 0x12(sha2-256) 0x20(32바이트) ‖ 다이제스트 ).
 * ⚠ 이 표기가 IPFS 에 올린 파일의 실제 CID 와 같은 것은 파일이 raw 블록 하나일 때뿐이다(`ipfs add --raw-leaves` 단일 블록 조건은 §38 미확인).
 */

/** 판매자 파일 위치 개수 상한. 🔶 §38 본문은 「최대 4개」, 이번 지시는 1~3 — 지시 값을 기본으로 두고 대표 확인 대기. */
export const MAX_CIPHER_URLS = 3;
/** 위치 주소 한 개 길이 상한(문자). 상품 문서 16KB 안에 파일 여러 개가 들어가야 한다. */
export const MAX_FILE_URL_CHARS = 300;

const SHA = /^[a-f0-9]{64}$/;
const B32 = 'abcdefghijklmnopqrstuvwxyz234567';
const CIDV1_RAW_SHA256_PREFIX = Uint8Array.of(0x01, 0x55, 0x12, 0x20);
const unhex = (h: string): Uint8Array => Uint8Array.from(h.match(/../g) ?? [], b => parseInt(b, 16));
const hexOf = (b: Uint8Array): string => Array.from(b, x => x.toString(16).padStart(2, '0')).join('');

/** RFC 4648 base32, 소문자, 패딩 없음. */
export function base32Lower(bytes: Uint8Array): string {
  let out = '', bits = 0, acc = 0;
  for (const b of bytes) {
    acc = (acc << 8) | b; bits += 8;
    while (bits >= 5) { out += B32[(acc >>> (bits - 5)) & 31]; bits -= 5; }
    acc &= (1 << bits) - 1;
  }
  if (bits > 0) out += B32[(acc << (5 - bits)) & 31];
  return out;
}
/** base32Lower 의 역. 모르는 글자·남는 비트가 0 이 아니면 null(같은 바이트에 표기가 하나만 있게). */
export function base32LowerDecode(s: string): Uint8Array | null {
  const out: number[] = [];
  let bits = 0, acc = 0;
  for (const ch of s) {
    const v = B32.indexOf(ch);
    if (v < 0) return null;
    acc = (acc << 5) | v; bits += 5;
    if (bits >= 8) { out.push((acc >>> (bits - 8)) & 255); bits -= 8; }
    acc &= (1 << bits) - 1;
  }
  if (bits >= 5 || acc !== 0) return null;
  return Uint8Array.from(out);
}

/** sha256 hex → CIDv1-raw(sha2-256) 표기('b…', 59자). */
export function cidV1RawOf(sha256: string): string {
  if (typeof sha256 !== 'string' || !SHA.test(sha256)) throw new Error('media-ref: sha256');
  const bytes = new Uint8Array(36);
  bytes.set(CIDV1_RAW_SHA256_PREFIX); bytes.set(unhex(sha256), 4);
  return 'b' + base32Lower(bytes);
}
/** CIDv1-raw(sha2-256) 표기 → sha256 hex. 다른 CID(v0 Qm…·dag-pb·다른 해시)면 null — 자동 변환하지 않는다. */
export function sha256OfCidV1Raw(cid: unknown): string | null {
  if (typeof cid !== 'string' || cid.length !== 59 || cid[0] !== 'b') return null;
  const raw = base32LowerDecode(cid.slice(1));
  if (!raw || raw.length !== 36 || CIDV1_RAW_SHA256_PREFIX.some((b, i) => raw[i] !== b)) return null;
  return hexOf(raw.subarray(4));
}
/** cid 가 이 sha256 의 CIDv1-raw 표기와 같은가. */
export const cidMatchesSha256 = (cid: unknown, sha256: unknown): boolean => typeof sha256 === 'string' && SHA.test(sha256) && sha256OfCidV1Raw(cid) === sha256;

/* ── 사진(media 항목) ─────────────────────────────────────────────── */

/** 새 사진 항목. sha256 = 재인코딩 결과 바이트의 SHA-256(hex). cid(선택) = 같은 값의 CIDv1-raw 표기. */
export type MediaHashItem = { sha256: string; cid?: string };
/** 상품 문서 media 항목: 옛 CID 문자열 또는 해시 항목. */
export type ProductMedia = string | MediaHashItem;

/** 해시 항목 모양 문제(없으면 null). 칸은 sha256 또는 sha256+cid 만, cid 는 같은 다이제스트 표기여야 한다. */
export function mediaHashItemProblem(x: unknown): string | null {
  if (!plain(x)) return 'shape';
  const keys = Object.keys(x).sort().join();
  if (keys !== 'sha256' && keys !== 'cid,sha256') return 'keys';
  if (typeof x.sha256 !== 'string' || !SHA.test(x.sha256)) return 'sha256';
  if ('cid' in x && !cidMatchesSha256(x.cid, x.sha256)) return 'cid-mismatch';
  return null;
}
/** 항목의 바이트 해시(sha256 hex). 해시 항목이면 그 값, 문자열이 CIDv1-raw 면 그 다이제스트, 옛 Qm/dag-pb 면 null(모름). */
export function mediaSha256Of(item: ProductMedia): string | null {
  if (typeof item === 'string') return sha256OfCidV1Raw(item);
  return item && typeof item === 'object' && typeof item.sha256 === 'string' && SHA.test(item.sha256) ? item.sha256 : null;
}
/** 중복 판정 열쇠: 같은 바이트를 가리키면 표기가 달라도 같은 열쇠. */
export const mediaKeyOf = (item: ProductMedia): string => { const h = mediaSha256Of(item); return h ? `sha256:${h}` : `cid:${String(item)}`; };
/**
 * 받은 사진 바이트가 이 항목과 같은 바이트인가(해시를 다시 계산). 옛 Qm/dag-pb 항목은 바이트로 맞춰 볼 수 없어 false —
 * 그리지 않는 쪽으로 넘어진다.
 */
export function mediaMatchesBytes(item: ProductMedia, bytes: Uint8Array): boolean {
  const h = mediaSha256Of(item);
  if (!h || !(bytes instanceof Uint8Array)) return false;
  if (typeof item !== 'string' && mediaHashItemProblem(item)) return false;
  return sha256Hex(bytes) === h;
}
/**
 * 판매자 앱 흐름: 재인코딩·검사가 끝난 사진(phone/ui/store/adapter.ts preparePhoto 결과의 hash = core/store/photo.ts verifyReencoded 의 hash)
 * → 상품 문서 media 항목. withCid=true 면 같은 다이제스트의 CIDv1-raw 표기를 덧붙인다.
 */
export function productMediaFromPhoto(photo: { hash: string }, opts: { withCid?: boolean } = {}): MediaHashItem {
  const sha256 = photo?.hash;
  if (typeof sha256 !== 'string' || !SHA.test(sha256)) throw new Error('media-ref: photo hash');
  return opts.withCid ? { sha256, cid: cidV1RawOf(sha256) } : { sha256 };
}

/* ── 판매자 파일 위치(곡 암호문) ───────────────────────────────────── */

/**
 * 자격증명으로 보이는 쿼리 이름(서명된 임시 주소·접근 토큰). 상품 문서는 공개되므로 이런 값이 들어가면 판매자 저장소 열쇠가 퍼진다 — 거절.
 * 알려진 것만(완전하지 않음).
 */
const CREDENTIAL_QUERY = /^(x-amz-[a-z-]+|x-goog-[a-z-]+|awsaccesskeyid|signature|sig|se|sp|sv|skoid|sktid|token|access_token|auth|authorization|key|apikey|api_key|password|passwd|pwd|secret|session|code)$/i;
/** 쿼리 이름 목록(+ 는 공백). 해석할 수 없으면 null(거절). URLSearchParams.keys 는 이 저장소의 TS lib 설정에 없다. */
function queryNames(u: URL): string[] | null {
  if (!u.search) return [];
  try { return u.search.slice(1).split('&').map(kv => decodeURIComponent(kv.split('=')[0].replace(/\+/g, ' '))); } catch { return null; }
}
const hasCredentialQuery = (u: URL): boolean => { const n = queryNames(u); return n === null || n.some(k => CREDENTIAL_QUERY.test(k)); };
/** 판매자 HTTPS 파일 위치로 받을 수 있는 주소인가: https · 계정/포트/조각 없음 · 자격증명 쿼리 없음 · 내부 이름·IP 아님 · 정규형 그대로 · 길이 상한. */
export function isSellerFileUrl(url: unknown): url is string {
  if (typeof url !== 'string' || url.length < 12 || url.length > MAX_FILE_URL_CHARS || /[\s\u0000-\u001f\u007f]/.test(url)) return false;
  let u: URL;
  try { u = new URL(url); } catch { return false; }
  if (u.protocol !== 'https:' || u.username || u.password || u.port || u.hash || isSsrfRiskyHost(u.hostname)) return false;
  if (hasCredentialQuery(u)) return false;
  return u.href === url;
}
/** 왜 거절했는지(화면·시험용). 받을 수 있으면 null. 'ssrf' = 내부 이름·IP·계정·포트·자격증명 쿼리 — 구매자 앱이 가져가지 않는다. */
export function sellerFileUrlProblem(url: unknown): 'shape' | 'ssrf' | null {
  if (isSellerFileUrl(url)) return null;
  if (typeof url !== 'string' || url.length > MAX_FILE_URL_CHARS) return 'shape';
  let u: URL;
  try { u = new URL(url); } catch { return 'shape'; }
  if (u.protocol !== 'https:') return 'shape';
  if (u.username || u.password || u.port || isSsrfRiskyHost(u.hostname)) return 'ssrf';
  if (hasCredentialQuery(u)) return 'ssrf';
  return 'shape';
}

/** 잠근 파일 하나의 암호문 위치(상품 문서 lock.files[].cipher, 판매자 서명 범위 안). */
export type CipherLocation = { urls: string[]; sha256: string; size: number };

/** 위치 칸 모양 문제(없으면 null). expectedSize = 평문 크기로 정해지는 암호문 크기(product-lock-shape.ts productLockCipherSize). */
export function cipherLocationProblem(x: unknown, expectedSize: number): string | null {
  return fileLocationProblem(x, n => n === expectedSize);
}

/** 파일 위치 공통 검사. 크기 정책은 호출자가 정한다. */
export function fileLocationProblem(x: unknown, sizeOk: (n: number) => boolean): string | null {
  if (!plain(x) || Object.keys(x).sort().join() !== 'sha256,size,urls') return 'cipher-keys';
  const c = x as Loose;
  if (typeof c.sha256 !== 'string' || !SHA.test(c.sha256)) return 'cipher-sha256';
  if (typeof c.size !== 'number' || !Number.isSafeInteger(c.size) || !sizeOk(c.size)) return 'cipher-size';
  if (!Array.isArray(c.urls) || c.urls.length < 1 || c.urls.length > MAX_CIPHER_URLS || new Set(c.urls).size !== c.urls.length) return 'cipher-urls';
  for (const u of c.urls as unknown[]) if (!isSellerFileUrl(u)) return 'cipher-url';
  return null;
}
