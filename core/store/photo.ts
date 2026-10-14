import { canonicalJson, plain, sha256Hex, utf8, type Loose } from '../creator/bytes';
import { recoverMessagePublicKey } from '../creator/product-doc';
import { signMessageWithKeyForTest } from '../signer/test-key';
import { signMessageWith, type SignDigest } from '../signer/signmessage';
import {
  PHOTO_EXT_BY_MIME, PHOTO_INPUT_MIMES, PHOTO_MAX_DIMENSION, PHOTO_MAX_INPUT_BYTES, PHOTO_MAX_INPUT_PIXELS, PHOTO_MAX_OUTPUT_BYTES, PHOTO_MIN_DIMENSION,
  PHOTO_OUTPUT_MIMES, PHOTO_SERVE_HOSTS, PHOTO_SERVE_PATH_PREFIX, STORE_PHOTO_SIGN_DOMAIN,
} from './limits';
import { isSsrfRiskyHost } from './ssrf-host';

/*
 * 사진 파이프라인의 순수 부분(결정문 §21 A3). 실제 재인코딩·업로드·서빙 코드는 여기 없다(서버 미적용) — 인터페이스·검증 함수·한도만.
 * 흐름: ① 판매자가 파일을 직접 올린다(URL 가져오기 금지) → ② 서버가 형식·크기 검증 후 재인코딩(메타데이터 제거, SVG 거절)
 *   → ③ 재인코딩 결과의 SHA-256 을 판매자가 서명(PhotoAttestation) 또는 가게 문서 photos 칸에 넣어 서명 → ④ 레이븐볼트 전용 호스트에서만 서빙
 *   → ⑤ 받는 쪽은 받은 바이트의 해시가 서명된 해시와 같을 때만 그린다. 신고 시 해시를 숨긴다(목록은 서버 쪽 일이다).
 * Vercel 이미지 최적화는 쓰지 않는다(과금). 한도 초과·검증 실패 시 화면은 도형 표지로 돌아간다.
 */

export type PhotoErrorCode = 'photo-source' | 'photo-size' | 'photo-format' | 'photo-mismatch' | 'photo-dimension' | 'photo-metadata' | 'photo-animated' |
  'photo-hash' | 'photo-signature' | 'photo-shape' | 'photo-host';
export class PhotoError extends Error {
  constructor(readonly code: PhotoErrorCode, readonly detail = '') { super(detail ? `${code}: ${detail}` : code); this.name = 'PhotoError'; }
}
const failP = (code: PhotoErrorCode, detail = ''): never => { throw new PhotoError(code, detail); };
const SHA = /^[a-f0-9]{64}$/;
const PUBKEY = /^0[23][a-f0-9]{64}$/;
const int = (n: unknown, min: number, max: number): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= min && n <= max;

/* ── SSRF: 외부 URL fetch 금지 ───────────────────────────────────────── */

// 호스트 거르기는 ssrf-host.ts(의존 없음)에 있다 — 상품 문서 쪽도 같은 함수를 쓴다.
export { WILDCARD_DNS_DOMAINS, isSsrfRiskyHost } from './ssrf-host';

const URLISH = /(?:^|[\s"'(<])(?:https?|ftp|file|gopher|data|ws|wss|javascript):/i;
/** 요청 안(깊이 5)의 문자열이나 키가 URL·원격 가져오기 모양이면 true. */
function hasExternalReference(v: Loose, depth = 0): boolean {
  if (depth > 5) return true;
  if (typeof v === 'string') return URLISH.test(v) || /^\/\//.test(v.trim());
  if (v instanceof Uint8Array || v === null || typeof v !== 'object') return false;
  if (Array.isArray(v)) return v.some(x => hasExternalReference(x, depth + 1));
  return Object.entries(v).some(([k, x]) => /^(url|uri|href|src|link|remote|fetch)/i.test(k) || hasExternalReference(x, depth + 1));
}
/**
 * 사진 요청은 **직접 올린 바이트**(`{ kind:'upload', mime, bytes }`)만 받는다. URL·원격 참조·알 수 없는 칸은 거절 — 서버가 외부 주소를 가져가지 않는다.
 */
export function assertUploadOnly(req: unknown): { mime: string; bytes: Uint8Array } {
  if (!plain(req) || req.kind !== 'upload') return failP('photo-source', 'upload-only');
  if (Object.keys(req).sort().join() !== 'bytes,kind,mime') return failP('photo-source', 'unknown-keys');
  if (!(req.bytes instanceof Uint8Array)) return failP('photo-source', 'bytes');
  if (typeof req.mime !== 'string' || hasExternalReference({ mime: req.mime })) return failP('photo-source', 'mime');
  return { mime: req.mime, bytes: req.bytes };
}
/** 서버가 외부로 나가는 요청 후보(문자열 URL)를 스캔한다 — 어떤 값이든 URL 모양이면 거절용. */
export const containsExternalReference = (v: unknown): boolean => hasExternalReference(v);

/* ── 이미지 읽기(형식·크기·메타데이터) ─────────────────────────────── */

/** trailingBytes: 끝 표시(JPEG EOI·PNG IEND·WebP RIFF 길이) 뒤에 남은 바이트 수. 0 이 아니면 폴리글롯(이미지+HTML/ZIP) 의심. */
export type ImageInfo = { mime: string; width: number; height: number; metadata: string[]; animated: boolean; trailingBytes: number };
const u16 = (b: Uint8Array, o: number) => (b[o] << 8) | b[o + 1];
const u32 = (b: Uint8Array, o: number) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
const l32 = (b: Uint8Array, o: number) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
const tag = (b: Uint8Array, o: number, n: number) => String.fromCharCode(...b.subarray(o, o + n));

/** 매직 바이트로 형식 판별. 모르면 null. SVG·HTML 같은 텍스트는 'text', GIF/HEIC 등은 이름만 돌려주고 호출자가 거절한다. */
export function sniffImage(b: Uint8Array): string | null {
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length >= 8 && tag(b, 0, 8) === '\x89PNG\r\n\x1a\n') return 'image/png';
  if (b.length >= 12 && tag(b, 0, 4) === 'RIFF' && tag(b, 8, 4) === 'WEBP') return 'image/webp';
  if (b.length >= 6 && /^GIF8[79]a$/.test(tag(b, 0, 6))) return 'image/gif';
  if (b.length >= 12 && tag(b, 4, 4) === 'ftyp') return 'image/heif';
  const head = tag(b, 0, Math.min(b.length, 512)).replace(/^﻿/, '').trimStart().toLowerCase();
  if (head.startsWith('<')) return 'text';
  return null;
}

/** JPEG 를 EOI 까지 모든 마커를 따라 읽는다(압축 데이터 구간은 0xFF00·RST 를 건너뛰며 다음 마커까지). SOS 뒤의 APPn·COM 도 메타데이터로 센다. */
function readJpeg(b: Uint8Array): ImageInfo {
  const metadata: string[] = []; let width = 0, height = 0, o = 2, sawScan = false;
  for (;;) {
    if (o + 2 > b.length || b[o] !== 0xff) return failP('photo-format', 'jpeg-structure');
    while (o + 1 < b.length && b[o + 1] === 0xff) o++;
    if (o + 2 > b.length) return failP('photo-format', 'jpeg-structure');
    const m = b[o + 1];
    if (m === 0xd9) { o += 2; break; }                                    // EOI
    if (m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { o += 2; continue; }
    if (o + 4 > b.length) return failP('photo-format', 'jpeg-structure');
    const len = u16(b, o + 2);
    if (len < 2 || o + 2 + len > b.length) return failP('photo-format', 'jpeg-length');
    if (m >= 0xe1 && m <= 0xef) metadata.push('APP' + (m - 0xe0) + (sawScan ? '-after-scan' : ''));   // EXIF·XMP·ICC·Adobe 등
    else if (m === 0xfe) metadata.push(sawScan ? 'COM-after-scan' : 'COM');
    if ((m >= 0xc0 && m <= 0xc3) || (m >= 0xc5 && m <= 0xc7) || (m >= 0xc9 && m <= 0xcb) || (m >= 0xcd && m <= 0xcf)) {
      if (len < 8) return failP('photo-format', 'jpeg-sof');
      height = u16(b, o + 5); width = u16(b, o + 7);
    }
    o += 2 + len;
    if (m === 0xda) {                                                     // 압축 데이터: 다음 진짜 마커까지
      sawScan = true;
      while (o < b.length) {
        if (b[o] !== 0xff) { o++; continue; }
        const n = b[o + 1];
        if (n === 0x00 || (n >= 0xd0 && n <= 0xd7)) { o += 2; continue; }
        if (n === 0xff) { o++; continue; }
        break;
      }
      if (o >= b.length) return failP('photo-format', 'jpeg-no-eoi');
    }
  }
  if (!width || !height) return failP('photo-format', 'jpeg-no-size');
  return { mime: 'image/jpeg', width, height, metadata, animated: false, trailingBytes: b.length - o };
}

function readPng(b: Uint8Array): ImageInfo {
  const metadata: string[] = []; let width = 0, height = 0, o = 8, animated = false, sawEnd = false;
  while (o + 12 <= b.length) {
    const len = u32(b, o), type = tag(b, o + 4, 4);
    if (o + 12 + len > b.length) return failP('photo-format', 'png-length');
    if (type === 'IHDR') { if (len !== 13) return failP('photo-format', 'png-ihdr'); width = u32(b, o + 8); height = u32(b, o + 12); }
    else if (type === 'acTL') animated = true;
    else if (!['PLTE', 'IDAT', 'IEND', 'tRNS', 'sRGB', 'gAMA', 'cHRM', 'sBIT', 'pHYs'].includes(type)) metadata.push(type);
    o += 12 + len;
    if (type === 'IEND') { sawEnd = true; break; }
  }
  if (!width || !height || !sawEnd) return failP('photo-format', 'png-structure');
  return { mime: 'image/png', width, height, metadata, animated, trailingBytes: b.length - o };
}

function readWebp(b: Uint8Array): ImageInfo {
  if (l32(b, 4) + 8 !== b.length) return failP('photo-format', 'webp-riff-size');
  const metadata: string[] = []; let width = 0, height = 0, animated = false, o = 12;
  while (o + 8 <= b.length) {
    const type = tag(b, o, 4), len = l32(b, o + 4), d = o + 8;
    if (d + len > b.length) return failP('photo-format', 'webp-length');
    if (type === 'VP8X' && len >= 10) { width = 1 + (b[d + 4] | (b[d + 5] << 8) | (b[d + 6] << 16)); height = 1 + (b[d + 7] | (b[d + 8] << 8) | (b[d + 9] << 16)); if (b[d] & 0x02) animated = true; }
    else if (type === 'VP8 ' && len >= 10 && b[d + 3] === 0x9d && b[d + 4] === 0x01 && b[d + 5] === 0x2a) { if (!width) { width = (b[d + 6] | (b[d + 7] << 8)) & 0x3fff; height = (b[d + 8] | (b[d + 9] << 8)) & 0x3fff; } }
    else if (type === 'VP8L' && len >= 5 && b[d] === 0x2f) { if (!width) { const bits = l32(b, d + 1); width = (bits & 0x3fff) + 1; height = ((bits >>> 14) & 0x3fff) + 1; } }
    else if (type === 'ANIM' || type === 'ANMF') animated = true;
    else if (type === 'EXIF' || type === 'XMP ' || type === 'ICCP') metadata.push(type.trim());
    o = d + len + (len & 1);
  }
  if (!width || !height) return failP('photo-format', 'webp-no-size');
  return { mime: 'image/webp', width, height, metadata, animated, trailingBytes: Math.max(0, b.length - o) };
}

/** 형식·크기·메타데이터 이름을 읽는다(디코딩 안 함). 구조가 깨졌으면 PhotoError. */
export function readImageInfo(bytes: Uint8Array): ImageInfo {
  const mime = sniffImage(bytes);
  if (mime === 'image/jpeg') return readJpeg(bytes);
  if (mime === 'image/png') return readPng(bytes);
  if (mime === 'image/webp') return readWebp(bytes);
  return failP('photo-format', mime ?? 'unknown');
}

/* ── ② 서버 입력 검증 / 재인코딩 계약 ──────────────────────────────── */

/** 올라온 원본을 재인코딩하기 전에 거른다. SVG·GIF·HEIC·텍스트 거절, 선언 형식과 실제 형식 불일치 거절, 크기·픽셀 한도. */
export function validatePhotoInput(bytes: Uint8Array, declaredMime: string): ImageInfo {
  if (!(bytes instanceof Uint8Array) || bytes.length < 16 || bytes.length > PHOTO_MAX_INPUT_BYTES) return failP('photo-size', 'input-bytes');
  const sniffed = sniffImage(bytes);
  if (sniffed === null || !(PHOTO_INPUT_MIMES as readonly string[]).includes(sniffed)) return failP('photo-format', sniffed ?? 'unknown');
  if (declaredMime !== sniffed) return failP('photo-mismatch', `${declaredMime} vs ${sniffed}`);
  const info = readImageInfo(bytes);
  if (info.animated) return failP('photo-animated');
  if (info.width < PHOTO_MIN_DIMENSION || info.height < PHOTO_MIN_DIMENSION) return failP('photo-dimension', 'too-small');
  if (info.width * info.height > PHOTO_MAX_INPUT_PIXELS) return failP('photo-dimension', 'too-many-pixels');
  return info;
}

export type PhotoReencodeOptions = Readonly<{ maxDimension: number; maxBytes: number; outputMimes: readonly string[]; stripMetadata: true }>;
export const DEFAULT_REENCODE_OPTIONS: PhotoReencodeOptions = Object.freeze({
  maxDimension: PHOTO_MAX_DIMENSION, maxBytes: PHOTO_MAX_OUTPUT_BYTES, outputMimes: PHOTO_OUTPUT_MIMES, stripMetadata: true,
});
export type ReencodedPhoto = Readonly<{ bytes: Uint8Array; mime: string; width: number; height: number }>;
/** 서버가 구현할 인터페이스(여기에는 구현 없음). 입력은 validatePhotoInput 을 통과한 바이트만. */
export interface PhotoReencoder { reencode(input: Uint8Array, options: PhotoReencodeOptions): Promise<ReencodedPhoto>; }

export type PhotoDigest = Readonly<{ hash: string; mime: string; size: number; width: number; height: number }>;
export const photoHash = (bytes: Uint8Array): string => sha256Hex(bytes);

/**
 * 끝 표시 뒤 바이트·메타데이터 검사만(형식 무관 — JPEG·PNG·WebP). 재인코딩 결과는 verifyReencoded 가 이것까지 본다.
 * 구조가 깨졌거나 끝 뒤에 바이트가 있거나 메타데이터가 있으면 PhotoError.
 */
export function assertCleanImageEnvelope(bytes: Uint8Array): ImageInfo {
  const info = readImageInfo(bytes);
  if (info.metadata.length) return failP('photo-metadata', info.metadata.join(','));
  if (info.trailingBytes !== 0) return failP('photo-format', 'trailing-bytes');
  return info;
}

/**
 * 재인코딩 결과 검증(서버도, 받는 앱도 쓴다): 출력 형식·크기·치수·애니메이션 없음, 메타데이터(EXIF·XMP·ICC·텍스트 청크, 압축 데이터 뒤 것 포함) 0개, 끝 표시 뒤 바이트 0,
 * 보고된 mime·치수가 실제 바이트와 같음. 통과하면 해시를 포함한 요약을 돌려준다.
 */
export function verifyReencoded(out: { bytes: Uint8Array; mime: string; width?: number; height?: number }): PhotoDigest {
  if (!(out?.bytes instanceof Uint8Array) || out.bytes.length < 16 || out.bytes.length > PHOTO_MAX_OUTPUT_BYTES) return failP('photo-size', 'output-bytes');
  if (!(PHOTO_OUTPUT_MIMES as readonly string[]).includes(out.mime)) return failP('photo-format', 'output-mime');
  const info = readImageInfo(out.bytes);
  if (info.mime !== out.mime) return failP('photo-mismatch', `${out.mime} vs ${info.mime}`);
  if (info.animated) return failP('photo-animated');
  if (info.metadata.length) return failP('photo-metadata', info.metadata.join(','));
  if (info.trailingBytes !== 0) return failP('photo-format', 'trailing-bytes');   // 이미지+HTML/ZIP 폴리글롯
  if (info.width > PHOTO_MAX_DIMENSION || info.height > PHOTO_MAX_DIMENSION || info.width < PHOTO_MIN_DIMENSION || info.height < PHOTO_MIN_DIMENSION) return failP('photo-dimension', 'output');
  if ((out.width !== undefined && out.width !== info.width) || (out.height !== undefined && out.height !== info.height)) return failP('photo-mismatch', 'reported-size');
  return { hash: photoHash(out.bytes), mime: info.mime, size: out.bytes.length, width: info.width, height: info.height };
}

/* ── ③ 판매자 서명(사진 증명) ──────────────────────────────────────── */

export type PhotoAttestationBody = { v: 1; seller: string; hash: string; mime: string; size: number; width: number; height: number; issuedAt: number };
export type PhotoAttestation = PhotoAttestationBody & { sig: string };
export const photoAttestationHash = (a: PhotoAttestationBody | PhotoAttestation): string => {
  const { sig: _s, ...body } = a as PhotoAttestation;
  return sha256Hex(utf8(canonicalJson(body)));
};
export const photoSigningMessage = (a: PhotoAttestationBody | PhotoAttestation): string => `${STORE_PHOTO_SIGN_DOMAIN}\nsha256:${photoAttestationHash(a)}`;

/**
 * 받은 사진 바이트가 판매자의 서명된 증명과 일치하는지: 증명 모양·서명, 바이트의 해시·형식·크기·치수, 재인코딩 검증(메타데이터 없음).
 * 서명 문구의 도메인이 달라 상품·가게 서명으로는 통과하지 않는다.
 */
export function verifyPhotoAttestation(att: unknown, bytes: Uint8Array, opts: { now: number; expectedSeller?: string }): PhotoDigest {
  if (!plain(att) || Object.keys(att).sort().join() !== 'hash,height,issuedAt,mime,seller,sig,size,v,width') return failP('photo-shape', 'keys');
  const a = att as Loose;
  if (a.v !== 1 || typeof a.seller !== 'string' || !PUBKEY.test(a.seller) || typeof a.hash !== 'string' || !SHA.test(a.hash) || typeof a.mime !== 'string' ||
      !int(a.size, 1, PHOTO_MAX_OUTPUT_BYTES) || !int(a.width, 1, PHOTO_MAX_DIMENSION) || !int(a.height, 1, PHOTO_MAX_DIMENSION) ||
      !int(a.issuedAt, 1_600_000_000, 4_100_000_000) || typeof a.sig !== 'string' || a.sig.length > 200) return failP('photo-shape', 'fields');
  if (opts.expectedSeller !== undefined && a.seller !== opts.expectedSeller) return failP('photo-signature', 'seller');
  if (a.issuedAt > opts.now + 600) return failP('photo-signature', 'issued-in-future');
  const signer = recoverMessagePublicKey(photoSigningMessage(a), a.sig);
  if (signer === null || signer !== a.seller) return failP('photo-signature', 'invalid');
  const digest = verifyReencoded({ bytes, mime: a.mime, width: a.width, height: a.height });
  if (digest.hash !== a.hash || digest.size !== a.size) return failP('photo-hash', 'bytes-do-not-match-signed-hash');
  return digest;
}
/** 시험·도구용 서명기. 앱은 노드 signmessage 로 서명한다. */
export function signPhotoAttestationForTest(body: PhotoAttestationBody, privateKey: Uint8Array): PhotoAttestation {
  const sig = signMessageWithKeyForTest(photoSigningMessage(body), privateKey);
  return { ...body, sig };
}
/** 운영용: 키를 가진 서명 콜백으로 서명한다. 서명자가 body.seller 가 아니면 SignerError. */
export async function signPhotoAttestation(signer: SignDigest, body: PhotoAttestationBody): Promise<PhotoAttestation> {
  return { ...body, sig: await signMessageWith(signer, photoSigningMessage(body), { publicKey: body.seller }) };
}
/** 가게 문서(또는 상품 문서)의 서명된 photos 해시 목록에 이 바이트가 들어 있나. 없으면 그리지 않는다. */
export const servedPhotoIsSigned = (signedHashes: readonly string[], bytes: Uint8Array): boolean => signedHashes.includes(photoHash(bytes));

/* ── ④ 서빙 주소(전용 호스트만) ─────────────────────────────────────── */

export function photoServeUrl(hash: string, mime: string, host: string = PHOTO_SERVE_HOSTS[0]): string {
  const ext = PHOTO_EXT_BY_MIME[mime];
  if (!SHA.test(hash) || !ext || !PHOTO_SERVE_HOSTS.includes(host)) return failP('photo-host', 'build');
  return `https://${host}${PHOTO_SERVE_PATH_PREFIX}${hash}.${ext}`;
}
/**
 * 서빙 응답 헤더 규칙(사진 전용 호스트). 브라우저가 내용을 짐작해 HTML 로 그리지 않게(nosniff), 주소를 직접 열면 내려받게(attachment),
 * 혹시 그려져도 스크립트·하위 요청이 없게(CSP sandbox). 이미지 태그(<img>)로 보이는 데에는 영향이 없다.
 */
export const PHOTO_SERVE_HEADER_RULES = Object.freeze({
  'X-Content-Type-Options': 'nosniff',
  'Content-Security-Policy': "default-src 'none'; sandbox",
});
export function photoServeHeaders(hash: string, mime: string): Record<string, string> {
  const ext = PHOTO_EXT_BY_MIME[mime];
  if (!SHA.test(hash) || !ext || !(PHOTO_OUTPUT_MIMES as readonly string[]).includes(mime)) return failP('photo-host', 'headers');
  return { 'Content-Type': mime, ...PHOTO_SERVE_HEADER_RULES, 'Content-Disposition': `attachment; filename="${hash}.${ext}"` };
}
/** 서빙 응답 헤더 점검(대소문자 무시). 빈 배열이어야 통과. */
export function checkPhotoServeHeaders(headers: Readonly<Record<string, string | undefined>>, mime: string): string[] {
  const h: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) if (typeof v === 'string') h[k.toLowerCase()] = v.trim();
  const problems: string[] = [];
  if (h['content-type']?.toLowerCase() !== mime || !(PHOTO_OUTPUT_MIMES as readonly string[]).includes(mime)) problems.push('content-type');
  if (h['x-content-type-options']?.toLowerCase() !== 'nosniff') problems.push('nosniff');
  if (!/^attachment\s*(;|$)/i.test(h['content-disposition'] ?? '')) problems.push('content-disposition');
  if (!/(^|;)\s*sandbox\s*(;|$)/i.test(h['content-security-policy'] ?? '') || !/default-src\s+'none'/i.test(h['content-security-policy'] ?? '')) problems.push('csp');
  return problems;
}

/** 서빙 주소 엄격 해석: https·허용 호스트·포트/계정/쿼리/조각 없음·경로가 정확히 /store-photos/<해시>.<확장자>. 아니면 null. */
export function parsePhotoServeUrl(url: unknown): { hash: string; mime: string } | null {
  if (typeof url !== 'string' || url.length > 200) return null;
  let u: URL;
  try { u = new URL(url); } catch { return null; }
  if (u.protocol !== 'https:' || u.username || u.password || u.port || u.search || u.hash || !PHOTO_SERVE_HOSTS.includes(u.hostname) || isSsrfRiskyHost(u.hostname)) return null;
  const m = /^\/store-photos\/([a-f0-9]{64})\.(jpg|webp)$/.exec(u.pathname);
  if (!m || u.href !== url) return null;
  return { hash: m[1], mime: m[2] === 'jpg' ? 'image/jpeg' : 'image/webp' };
}
