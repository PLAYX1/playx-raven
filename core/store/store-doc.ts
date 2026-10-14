import { secp256k1 } from '@noble/curves/secp256k1';
import { canonicalJson, plain, sha256Hex, utf8, type Loose } from '../creator/bytes';
import { recoverMessagePublicKey } from '../creator/product-doc';
import { isSsrfRiskyHost } from './photo';
import { hasForbiddenPhrase } from '../brand/forbidden-phrases';
import { hasClaimOrForbidden } from './claim-words';
import { signMessageWithKeyForTest } from '../signer/test-key';
import { signMessageWith, type SignDigest } from '../signer/signmessage';
import {
  MAX_STORE_DOC_BYTES, STORE_CATEGORIES, STORE_DEFAULT_LIFETIME_SECONDS, STORE_EXPIRY_WARNING_SECONDS, STORE_NOTICE_MODES, type StoreNoticeMode, STORE_CLOCK_SKEW_SECONDS, STORE_CONTACTS_MAX, STORE_DOC_VERSION, STORE_INTRO_MAX, STORE_MAX_LIFETIME_SECONDS,
  STORE_MAX_REV, STORE_MIN_LIFETIME_SECONDS, STORE_NAME_MAX, STORE_PHOTOS_MAX, STORE_REGION_MAX, STORE_SIGN_DOMAIN, type StoreCategory,
} from './limits';

/*
 * 가게 문서 v1(rv-store) — 판매자가 직접 서명한 가게 프로필 JSON 한 장. 체인 자산·소각 없음(결정문 §21 A1, §26: RV.<종류>.<이름> 폐기).
 * 서명 방식은 core/creator/product-doc.ts 와 같다: signmessage 호환(65바이트 복구형), 문구 = STORE_SIGN_DOMAIN \n sha256:<본문 해시>,
 * 되살린 공개키가 seller 와 바이트까지 같아야 한다. 도메인이 달라서 상품 서명·사진 서명은 가게 서명으로 재사용되지 않는다.
 *
 * 형식(정본 JSON = bytes.ts canonicalJson):
 *   { v:1, kind:'store', seller, name, intro, category, area:{region}, contacts:[{kind,value}], notice:'none'|'on-request'|'public-doc',
 *     photos:[sha256 hex…], rev, id, prev, issuedAt, expiresAt, sig }
 *   · area 는 「대략」: 숫자(번지·좌표)를 허용하지 않는다. 정확한 주소는 문서에 넣지 않는다.
 *   · 사업자번호·상호·대표자는 공개 가게 문서에 넣지 않는다(해시도 없음, §29: 10자리라 해시는 전수대입으로 풀린다). notice 만 둔다:
 *     'public-doc' 이면 별도 서명 문서(seller-notice.ts)가 의미를 가지고, 기본 'on-request' 는 요청 시 판매자가 구매자에게 직접 알린다.
 *   · 이름의 「인증/공식/보증/검증」 계열 단어(ko/ja/zh/en)와 §25 금지 문구는 거절한다(claim-words.ts). 소개글은 금지 문구만 거절(§31: 「KC 인증」 같은 사실 진술 허용).
 *     비교는 NFKC·공백/구두점 제거 뒤에 한다(core/brand/forbidden-phrases.ts 와 같은 규칙).
 *   · 재전송 방지: rev(연속 증가)+prev(앞 판 본문 해시)+issuedAt/expiresAt(만료). 옛 판·만료 문서는 acceptStoreUpdate / verifyStoreDoc 이 거절.
 *   · 키 지문 = 판매자 압축 공개키의 SHA-256 hex(release-site/og/r-page.mjs sellerFingerprint 와 같은 값).
 * 🔴 이 파일은 네트워크·저장·송금을 하지 않는다. 시각은 호출자가 now(초)로 넘긴다.
 */

export type StoreContact = { kind: 'chat' | 'email' | 'phone' | 'url'; value: string };
export type StoreBody = {
  v: 1; kind: 'store'; seller: string; name: string; intro: string; category: StoreCategory; area: { region: string };
  contacts: StoreContact[]; notice: StoreNoticeMode; photos: string[];
  rev: number; id: string | null; prev: string | null; issuedAt: number; expiresAt: number;
};
export type StoreDoc = StoreBody & { sig: string };
/**
 * idProven = storeId 가 증명된 값인가. rev 0 은 본문 해시라 스스로 증명되고, rev>0 은 체인(verifyStoreChain / acceptStoreUpdate 에 rev 0 부터 넘김)으로만 증명된다.
 * rev>0 문서를 verifyStoreDoc 단독으로 확인하면 id 칸은 서명자 자신의 주장일 뿐이다(idProven=false) — 「이 가게 ID 의 최신 판」으로 보여 주면 안 된다.
 */
export type VerifiedStore = { doc: StoreDoc; storeId: string; docHash: string; fingerprint: string; idProven: boolean };

export type StoreErrorCode = 'store-shape' | 'store-seller' | 'store-text' | 'store-category' | 'store-area' | 'store-contact' | 'store-notice' | 'store-notice-scope' | 'store-photos' |
  'store-revision' | 'store-time' | 'store-signature' | 'store-too-large' | 'store-json' | 'store-expired' | 'store-replay' | 'store-link';
export class StoreError extends Error {
  constructor(readonly code: StoreErrorCode, readonly detail = '') { super(detail ? `${code}: ${detail}` : code); this.name = 'StoreError'; }
}
const fail = (code: StoreErrorCode, detail = ''): never => { throw new StoreError(code, detail); };
export const keysAre = (o: Record<string, Loose>, keys: string) => Object.keys(o).sort().join() === keys.split(',').sort().join();
export const int = (n: unknown, min: number, max: number): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= min && n <= max;
export const SHA = /^[a-f0-9]{64}$/;
export const PUBKEY = /^0[23][a-f0-9]{64}$/;
const unhex = (h: string): Uint8Array => Uint8Array.from(h.match(/../g) ?? [], b => parseInt(b, 16));
/** 제어문자·양방향/보이지 않는 서식 문자 거절, NFC 만. multiline 은 소개글(줄바꿈 허용). */
export function cleanText(s: unknown, min: number, max: number, multiline = false): s is string {
  if (typeof s !== 'string' || s !== s.normalize('NFC') || s.trim() !== s) return false;
  const len = Array.from(s).length;
  if (len < min || len > max) return false;
  const bad = multiline ? /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f​-‏‪-‮⁦-⁩﻿]/ : /[\u0000-\u001f\u007f​-‏‪-‮⁦-⁩﻿]/;
  return !bad.test(s) && !INVISIBLE.test(s) && !/[\ud800-\udfff]/.test(s.replace(/[\ud800-\udbff][\udc00-\udfff]/g, ''));
}
/** 보이지 않는 서식·채움 문자(우회용): 모든 Cf(소프트하이픈·U+2060·U+180E 등), 결합 자소 잇기 U+034F, 한글 채움 U+115F·U+1160·U+3164·U+FFA0. */
const INVISIBLE = /[\p{Cf}\u034f\u115f\u1160\u3164\uffa0]/u;
/* 소개글 금지 문구는 core/brand/forbidden-phrases.ts 한 곳 — 플랫폼 보증처럼 읽히는 표현만. 「KC 인증」 같은 판매자 자신의 사실 진술은 막지 않는다(§31: 소개글은 허용 + 미검증 라벨 상시). */

/* ── 본문·해시·서명 문구 ─────────────────────────────────────────────── */

export function storeBody(doc: StoreDoc | StoreBody): StoreBody {
  const { sig: _s, ...rest } = doc as StoreDoc;
  return rest as StoreBody;
}
export const storeDocHash = (doc: StoreDoc | StoreBody): string => sha256Hex(utf8(canonicalJson(storeBody(doc))));
export const storeIdOf = (doc: StoreDoc | StoreBody): string => (doc.rev === 0 ? storeDocHash(doc) : (doc.id as string));
export const storeSigningMessage = (doc: StoreDoc | StoreBody): string => `${STORE_SIGN_DOMAIN}\nsha256:${storeDocHash(doc)}`;
export const encodeStoreDoc = (doc: StoreDoc): Uint8Array => utf8(canonicalJson(doc));
/** 키 지문 = 판매자 압축 공개키의 SHA-256 hex(64자). 화면은 앞 8자…뒤 8자로 줄여 보인다. */
export const storeKeyFingerprint = (sellerHex: string): string => sha256Hex(unhex(sellerHex));

/* ── 모양 검사 ─────────────────────────────────────────────────────── */

function validateContact(c: Loose, sellerFp: string): void {
  if (!plain(c) || !keysAre(c, 'kind,value') || typeof c.value !== 'string') return fail('store-contact', 'shape');
  switch (c.kind) {
    case 'chat': if (c.value !== sellerFp) fail('store-contact', 'chat-must-be-own-fingerprint'); break;
    case 'email': if (c.value.length > 80 || !/^[A-Za-z0-9._%+-]{1,40}@[A-Za-z0-9.-]{1,40}\.[A-Za-z]{2,12}$/.test(c.value)) fail('store-contact', 'email'); break;
    case 'phone': if (!/^\+?[0-9]{8,15}$/.test(c.value)) fail('store-contact', 'phone'); break;
    case 'url': {
      let u: URL;
      try { u = new URL(c.value); } catch { return fail('store-contact', 'url'); }
      if (c.value.length > 200 || u.protocol !== 'https:' || u.username || u.password || u.port || isSsrfRiskyHost(u.hostname) || u.href !== c.value && u.href !== c.value + '/') fail('store-contact', 'url');
      break;
    }
    default: fail('store-contact', 'kind');
  }
}

/** 엄격 검사(모르는 칸·빠진 칸 거절). 서명은 보지 않는다. */
export function validateStoreDoc(raw: unknown): StoreDoc {
  if (!plain(raw) || !keysAre(raw, 'v,kind,seller,name,intro,category,area,contacts,notice,photos,rev,id,prev,issuedAt,expiresAt,sig')) return fail('store-shape', 'keys');
  const d = raw as Loose;
  if (d.v !== STORE_DOC_VERSION || d.kind !== 'store') fail('store-shape', 'version');
  if (typeof d.seller !== 'string' || !PUBKEY.test(d.seller)) fail('store-seller', 'pubkey');
  try { secp256k1.ProjectivePoint.fromHex(d.seller).assertValidity(); } catch { fail('store-seller', 'point'); }
  if (!cleanText(d.name, 1, STORE_NAME_MAX) || hasClaimOrForbidden(d.name)) fail('store-text', 'name');
  if (!cleanText(d.intro, 0, STORE_INTRO_MAX, true) || hasForbiddenPhrase(d.intro)) fail('store-text', 'intro');
  if (typeof d.category !== 'string' || !(STORE_CATEGORIES as readonly string[]).includes(d.category)) fail('store-category');
  if (!plain(d.area) || !keysAre(d.area, 'region') || !cleanText(d.area.region, 1, STORE_REGION_MAX) || /\d/.test(d.area.region)) fail('store-area', 'approximate-region-without-digits');
  const fp = storeKeyFingerprint(d.seller);
  if (!Array.isArray(d.contacts) || d.contacts.length > STORE_CONTACTS_MAX) fail('store-contact', 'count');
  for (const c of d.contacts) validateContact(c, fp);
  if (new Set(d.contacts.map((c: Loose) => c.kind + ':' + c.value)).size !== d.contacts.length) fail('store-contact', 'duplicate');
  if (typeof d.notice !== 'string' || !(STORE_NOTICE_MODES as readonly string[]).includes(d.notice)) fail('store-notice', 'mode');
  if (!Array.isArray(d.photos) || d.photos.length > STORE_PHOTOS_MAX || d.photos.some((h: unknown) => typeof h !== 'string' || !SHA.test(h)) || new Set(d.photos).size !== d.photos.length) fail('store-photos');
  if (!int(d.rev, 0, STORE_MAX_REV)) fail('store-revision', 'rev');
  if (d.rev === 0 ? d.id !== null || d.prev !== null : typeof d.id !== 'string' || !SHA.test(d.id) || typeof d.prev !== 'string' || !SHA.test(d.prev)) fail('store-revision', 'link');
  if (!int(d.issuedAt, 1_600_000_000, 4_100_000_000) || !int(d.expiresAt, 1_600_000_000, 4_200_000_000)) fail('store-time', 'range');
  const life = d.expiresAt - d.issuedAt;
  if (life < STORE_MIN_LIFETIME_SECONDS || life > STORE_MAX_LIFETIME_SECONDS) fail('store-time', 'lifetime');
  if (typeof d.sig !== 'string' || d.sig.length > 200) fail('store-signature', 'shape');
  let bytes = 0;
  try { bytes = utf8(canonicalJson(d)).length; } catch { fail('store-shape', 'canonical'); }
  if (bytes > MAX_STORE_DOC_BYTES) fail('store-too-large');
  return d as StoreDoc;
}

/* ── 서명 확인 ─────────────────────────────────────────────────────── */

/**
 * 받은 가게 문서(바이트 또는 객체)를 검사·서명·만료 확인한다. 바이트면 정본 JSON 그대로여야 한다.
 * now = 현재 시각(초). 만료됐거나 아직 먼 미래에 발행된 문서는 거절한다.
 * expectedId 를 주면 가게 ID 가 같아야 하고, **rev 0 문서에만** 쓸 수 있다(rev>0 이면 'store-revision: expected-id-needs-chain').
 * rev>0 문서의 id 칸은 서명자가 마음대로 적을 수 있어서(남의 가게 ID 도) 단독 확인으로는 증명되지 않는다 — 가게 ID 로 최신 판을 고를 때는
 * verifyStoreChain(rev 0 부터 전부) 또는 들고 있는 판에서 acceptStoreUpdate 로만 판단한다. /r/ 공유 페이지처럼 문서 한 장만 오는 호출은
 * 이 함수를 단독으로 써서 「이 가게의 최신 판」을 주장하면 안 된다(결과의 idProven 이 false).
 */
export function verifyStoreDoc(input: Uint8Array | unknown, opts: { now: number; expectedId?: string }): VerifiedStore {
  if (!int(opts?.now, 0, 5_000_000_000)) return fail('store-time', 'now');
  let doc: unknown;
  if (input instanceof Uint8Array) {
    if (input.length > MAX_STORE_DOC_BYTES) fail('store-too-large');
    try { doc = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(input)); } catch { return fail('store-json'); }
  } else doc = input;
  const d = validateStoreDoc(doc);
  if (input instanceof Uint8Array && sha256Hex(input) !== sha256Hex(encodeStoreDoc(d))) fail('store-shape', 'not-canonical');
  const signer = recoverMessagePublicKey(storeSigningMessage(d), d.sig);
  if (signer === null || signer !== d.seller) fail('store-signature', 'invalid');
  if (d.issuedAt > opts.now + STORE_CLOCK_SKEW_SECONDS) fail('store-time', 'issued-in-future');
  if (opts.now >= d.expiresAt) fail('store-expired');
  const storeId = storeIdOf(d);
  if (opts.expectedId !== undefined) {
    if (d.rev !== 0) fail('store-revision', 'expected-id-needs-chain');
    if (storeId !== opts.expectedId) fail('store-revision', 'id-mismatch');
  }
  return { doc: d, storeId, docHash: storeDocHash(d), fingerprint: storeKeyFingerprint(d.seller), idProven: d.rev === 0 };
}

/**
 * 재전송 방지: 이미 받아 둔 판(current)이 있을 때 새 판(next)을 받아도 되는지. 같은 가게 ID·같은 판매자 키,
 * rev = 앞 rev + 1, prev = 앞 판 본문 해시, issuedAt 이 앞 판 이상이어야 한다. 옛 판·같은 판 재전송·가지치기 판은 거절한다.
 * current 가 없으면 rev 0 만 받는다.
 */
export function acceptStoreUpdate(current: VerifiedStore | null, nextInput: Uint8Array | unknown, opts: { now: number }): VerifiedStore {
  const next = verifyStoreDoc(nextInput, opts);
  if (current === null) { if (next.doc.rev !== 0) fail('store-replay', 'first-must-be-rev0'); return next; }
  if (next.doc.seller !== current.doc.seller) fail('store-revision', 'seller-changed');
  if (next.storeId !== current.storeId) fail('store-revision', 'id-mismatch');
  if (next.doc.rev <= current.doc.rev) fail('store-replay', 'old-or-same-rev');
  if (next.doc.rev !== current.doc.rev + 1 || next.doc.prev !== current.docHash) fail('store-revision', 'prev');
  if (next.doc.issuedAt < current.doc.issuedAt) fail('store-replay', 'time-went-back');
  // 들고 있는 판의 ID 가 증명돼 있을 때만 새 판의 ID 도 증명된다(current 를 rev 0 부터 쌓아 온 경우).
  return { ...next, idProven: current.idProven };
}

/** 판 목록(rev 0 부터)을 처음부터 끝까지 확인한다. 각 판은 발행 시점이 아니라 now 기준 만료는 마지막 판만 본다. */
export function verifyStoreChain(docs: readonly unknown[], opts: { now: number }): VerifiedStore {
  if (!Array.isArray(docs) || docs.length < 1) return fail('store-revision', 'empty');
  let last: VerifiedStore | null = null;
  for (const [i, raw] of docs.entries()) {
    const isTip = i === docs.length - 1;
    // 앞 판은 만료돼도 괜찮다(이력). 서명·연결만 본다: 앞 판 검사는 그 판 만료 직전 시각으로 한다.
    const at = isTip ? opts.now : Math.min(opts.now, validateStoreDoc(raw).expiresAt - 1);
    last = acceptStoreUpdate(last, raw, { now: at });
  }
  return last as VerifiedStore;
}

/* ── 수명·갱신 알림(§29) ─────────────────────────────────────────────── */

/** 새 문서의 기본 만료 시각(발행 + 90일). */
export const defaultStoreExpiry = (issuedAt: number): number => issuedAt + STORE_DEFAULT_LIFETIME_SECONDS;
/** 만료 14일 전부터 만료 직전까지 true — 앱이 「다시 서명하세요」 알림을 띄울 시점. */
export const storeRenewalDue = (doc: StoreDoc | StoreBody, now: number): boolean => now >= doc.expiresAt - STORE_EXPIRY_WARNING_SECONDS && now < doc.expiresAt;

/* ── 화면 문구(허용 문구만) ─────────────────────────────────────────── */

export const NOTICE_LABELS: Readonly<Record<StoreNoticeMode, string | null>> = Object.freeze({
  none: null, 'on-request': '판매자 고지: 요청 시 판매자가 직접 안내', 'public-doc': '판매자 고지: 공개 문서 있음 · 판매자 입력 · 미검증',
});
/** 소개글 옆에 항상 붙는 라벨(§31). 상수 한 곳 · 끄는 옵션 없음. */
export const INTRO_UNVERIFIED_LABEL = '판매자가 직접 쓴 소개이며 레이븐볼트는 확인하지 않았습니다';
export function storeTrustLabels(v: VerifiedStore): { signature: string; notice: string | null; intro: string } {
  const short = `${v.fingerprint.slice(0, 8)}…${v.fingerprint.slice(-8)}`;
  return { signature: `서명 확인됨 · 키 지문 ${short}`, notice: NOTICE_LABELS[v.doc.notice], intro: INTRO_UNVERIFIED_LABEL };
}

/* ── 서명(시험·도구용) ─────────────────────────────────────────────── */

/** 시험·도구용 서명기(개인키를 받는다). 앱은 노드 signmessage(seller 공개키의 주소)로 서명한다. */
export function signStoreDocForTest(body: StoreBody, privateKey: Uint8Array): StoreDoc {
  const sig = signMessageWithKeyForTest(storeSigningMessage(body), privateKey);
  return { ...storeBody(body), sig };
}
/** 운영용: 키를 가진 서명 콜백으로 서명한다(core 는 키를 보지 않는다). 서명자가 body.seller 가 아니면 SignerError. */
export async function signStoreDoc(signer: SignDigest, body: StoreBody): Promise<StoreDoc> {
  const clean = storeBody(body);
  return { ...clean, sig: await signMessageWith(signer, storeSigningMessage(clean), { publicKey: clean.seller }) };
}
