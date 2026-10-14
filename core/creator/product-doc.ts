import { ed25519 } from '@noble/curves/ed25519';
import { secp256k1 } from '@noble/curves/secp256k1';
import { b64urlDecode, b64urlEncode, base64Decode, canonicalJson, hex, plain, sha256Hex, utf8, type Loose } from './bytes';
import { OPERATING_LIST_KEYS } from './operating-keys';
import { hasClaimWord } from '../store/claim-words';
import { productLockProblem, type ProductLockSection } from './product-lock-shape';
import { mediaHashItemProblem, mediaKeyOf, type ProductMedia } from './media-ref';
import { productPreviewProblem, type ProductPreview } from './product-preview';
import { signMessageWithKeyForTest } from '../signer/test-key';
import { signMessageWith, type SignDigest } from '../signer/signmessage';
import {
  BLOCKS_PER_DAY, CID_V0, MARKET_FEE_ADDRESS, MARKET_FEE_BPS_CEILING, MAX_PRICE_ATOMS, addressOfPublicKey, isRvnAddress, keyIdOf, messageHash,
} from './trade-primitives';

/*
 * 상품 문서 v1(rv-product) — 「진짜 거래」 1단계 핵심 코어. 순수 함수만 있다(네트워크·키 저장소·송금 없음). (2026-10-13, 7모델 토론 확정 설계)
 *
 * 무엇: 판매자가 직접 서명한 상품 JSON 한 장. 지갑은 **이 서명과 payTo 만** 믿는다 — 운영 목록·서버 견적·다른 프로그램(JS→Rust)이 넘긴 주소는
 *   결제 주소의 근거가 될 수 없다(assertPayTo 로 대조만 한다). 웹 노래 구매의 「서버 견적 신뢰」, 데스크톱이 JS 가 준 주소를 믿는 구멍을 닫는 자리.
 *
 * 형식(정본 JSON = bytes.ts canonicalJson, 키 정렬·공백 없음·안전 정수만):
 *   { v:1, kind, seller:<압축 공개키 66 hex>, payTo:'R…', title, price:<atoms 정수 문자열>, media:[CID… 또는 {sha256, cid?}…], feeBps, feeSchedule:<sha256 hex>,
 *     rev, id, prev, x?:{종류별 칸}, sig:<base64 65바이트 복구형> }
 *   · preview?:{ seconds, cipher?:{ urls, sha256, size } } — 미리듣기 정보도 서명·상품 ID 범위 안이다.
 *   · kind 는 확장형이다: KNOWN_KINDS(digital/game/ticket/used/menu/groupbuy…)가 아니어도 모양만 맞으면 받는다. 화면이 모르는 종류는 「기타」로 그린다.
 *   · media 항목(§38): 옛 CID 문자열 그대로 받고, 새 항목은 { sha256:<재인코딩 결과 바이트 해시> } (+ 선택 cid = 같은 다이제스트의 CIDv1-raw 표기만).
 *     옛 항목만 있는 문서의 서명 바이트·상품 ID 는 바뀌지 않는다. 표기 규칙은 media-ref.ts 한 곳.
 *   · price 는 RVN 이 아니라 atoms(1 RVN = 1e8) 정수 문자열이다 — 부동소수로 금액을 다루지 않는다.
 *   · feeBps = 판매자가 이 문서로 동의한 수수료 최대 요율. 실제 요율은 min(feeBps, 서명된 수수료 일정의 그 높이 요율)(productFee).
 *     🔶 해석: 설계의 「상품 문서 값과 일정 중 낮은 값」을 「문서의 동의 요율 칸」으로 읽었다 — 대표 확인 필요.
 *   · feeSchedule = 판매자가 서명할 때 본 수수료 일정(rv-fee-track)의 **앞부분** 해시. 일정은 덧붙이기만 하므로 이후 판도 이 앞부분으로 시작해야 한다(trackExtends).
 *   · 상품 ID = 최초 선언(rev 0, id·prev 가 null)의 본문 해시(sig 제외) — 서명 바이트가 바뀌어도 ID 는 같다.
 *     수정본(rev ≥ 1)은 id = 그 ID, prev = 바로 앞 판의 본문 해시. 판매자 공개키는 판을 넘어 바뀔 수 없다(verifyRevisionChain).
 *
 * 서명 = 레이븐 코어 signmessage 와 같은 바이트(manifest.ts messageHash, 65바이트 복구형 base64). 서명 문구:
 *   PRODUCT_SIGN_DOMAIN \n sha256:<본문 해시>
 *   서명에서 되살린 공개키가 seller 와 **바이트까지** 같아야 한다(주소만 같은 것으로는 부족 — 압축/비압축 구별).
 *   노드에서 서명하려면 seller 공개키의 주소(sellerAddress)로 `signmessage <주소> <문구>` 를 부른다. 🔶 노드 실기 대조는 시험망 확인 필요.
 *
 * 수수료(productFee): 서명된 일정 1개(rv-fee-track, 덧붙이기 전용 판 목록). 인하는 공지 블록부터 즉시, 인상은 공지 뒤 INCREASE_DELAY_BLOCKS(약 6개월) 뒤부터.
 *   계산(feeAmount 한 곳, §18 Q4) = floor(주문 총액 × 요율 / 10000) **내림** → 상한 500 RVN → MIN_FEE_OUTPUT_ATOMS 미만이면 면제(0, 수수료 출력 없음).
 *   주문 총액(§29 ①, 7/7) = 단가(문서 price) × 수량 + 배송비(수수료 전) — orderAmounts 한 곳. 수수료·공유 몫(product-ext/split.ts) 모두 이 기준.
 *   1000 atoms 올림은 새 경로에서 폐기했다. 판매자 몫 = 총액 − 수수료(구매자는 총액만 낸다).
 *   영수증 표시값 receipt = { rateBps, computedAtoms(산출), exempt, actualAtoms(실제) } — 「요율 1%, 산출 0.12 RVN, 면제, 실제 0」을 그대로 그린다.
 *   수수료 주소는 코드 고정(trade-primitives.ts MARKET_FEE_ADDRESS) — 문서·일정·견적 어디에서도 받지 않는다.
 *   ⚠ 옛 장터 규칙(fee-schedule.ts·platform-fee.ts, 「먼지 한계 미만이면 1000 atoms 로 올림」)은 이 파일이 import 하지 않는다(fee-guard.test.ts).
 *   종류별 요율 일정은 fee-track-v2.ts(rv-fee-track v2)다. 아래 v1 일정(종류 칸 없음)은 옛 시험·도구용으로 남아 있고, 새 수수료 경로(fee-policy.ts)는 v1 을 받지 않는다.
 *
 * 구매 메모(RVLT): OP_RETURN = "RVLT" | 버전 1바이트 | 주문 해시 32바이트 (37바이트). 지금 버전 = RVLT_VERSION(2, §29 ②).
 *   일회용 키는 공개키가 아니라 그 해시(buyerKeyHash)만 주문 해시에 들어간다 → 체인에는 공개키가 나오지 않는다. 🔶 레이븐 노드의 OP_RETURN 중계 크기 한계는 시험망 확인 필요(기존 RVDP v3 메모 ≤ 75바이트가 이미 다녔다).
 *
 * 🔴 이 파일은 거래를 만들거나 보내지 않는다. 메인넷 스위치(mainnet-switch.json)와 무관하게 판매는 지금 닫혀 있다(purchase.ts 가 문).
 */

export const PRODUCT_DOC_VERSION = 1;
export const PRODUCT_SIGN_DOMAIN = 'RAVENVAULT-PRODUCT-V1';
export const KNOWN_KINDS = ['digital', 'game', 'music', 'book', 'ticket', 'used', 'menu', 'groupbuy'] as const;
export const MAX_PRODUCT_DOC_BYTES = 16 * 1024;
export const MAX_MEDIA = 16;
export const MAX_REV = 1_000_000;

export type ProductBody = {
  v: 1; kind: string; seller: string; payTo: string; title: string; price: string; media: ProductMedia[];
  feeBps: number; feeSchedule: string; rev: number; id: string | null; prev: string | null;
  /** 종류별 칸(선택). 정본 JSON 으로 표현할 수 있는 값만. */
  x?: Record<string, Loose>;
  /**
   * 가게 문서 ID(선택, GAP-1) = core/store 가게 문서의 storeId(rev 0 본문 해시, 64 hex). 한 판매자 키가 가게를 여럿 열 때 이 상품이 어느 가게 것인지 정한다.
   * 칸이 없으면 서명 바이트·상품 ID 는 예전과 같다. 있으면 core/store/product-link verifyProductStoreLink 가 서명자 키 = 가게 판매자 키, ID 같음을 확인한다.
   */
  storeId?: string;
  /**
   * 잠긴 파일(선택, RV-LOCK v1 잠금 정보 — product-lock-shape.ts). 서명 본문 안이라 판매자 키가 서명한다(바꾸면 서명이 깨진다).
   * 칸이 없으면 서명 바이트·상품 ID 는 예전과 같다. rev 0 상품 ID 는 이 칸을 **뺀** 본문 해시다 — 잠금 이름(RVP1:<상품 ID>)이 ID 에 기대므로
   * ID 가 잠금 정보에 기대면 돌고 돈다. 판 연결(prev)·docHash 는 이 칸을 포함한 본문 해시다.
   */
  lock?: ProductLockSection;
  preview?: ProductPreview;
};
export type ProductDoc = ProductBody & { sig: string };
export type VerifiedProduct = { doc: ProductDoc; productId: string; docHash: string; sellerAddress: string };

export type ProductErrorCode = 'product-shape' | 'product-kind' | 'product-seller' | 'product-pay-to' | 'product-price' | 'product-fee' |
  'product-media' | 'product-revision' | 'product-signature' | 'product-too-large' | 'product-json' | 'pay-to-mismatch' |
  'track-shape' | 'track-signature' | 'track-mismatch' | 'track-version' | 'track-mixed' | 'before-schedule' | 'price-too-small' | 'memo' | 'share-link' | 'order-shipping';
export class ProductError extends Error {
  constructor(readonly code: ProductErrorCode, readonly detail = '') { super(detail ? `${code}: ${detail}` : code); this.name = 'ProductError'; }
}
const fail = (code: ProductErrorCode, detail = ''): never => { throw new ProductError(code, detail); };
const keysAre = (o: Record<string, Loose>, keys: string) => Object.keys(o).sort().join() === keys.split(',').sort().join();
const int = (n: unknown, min: number, max: number): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= min && n <= max;
const text = (s: unknown, min: number, max: number) => typeof s === 'string' && s.length >= min && s.length <= max && s === s.normalize('NFC') &&
  !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f‪-‮⁦-⁩]/.test(s);
const SHA = /^[a-f0-9]{64}$/;
const ATOMS = /^[1-9]\d{0,17}$/;
const KIND = /^[a-z][a-z0-9-]{1,23}$/;
/** 상품 문서 kind 모양 검사(verifyProductDoc 와 같은 규칙). 수수료 분류(fee-track-v2.ts feeKindOf)도 이 함수 하나를 쓴다. */
export const isProductKindShape = (k: unknown): k is string => typeof k === 'string' && KIND.test(k);
const PUBKEY = /^0[23][a-f0-9]{64}$/;
/** IPFS CID: v0(Qm…) 또는 v1 base32 소문자(b…). */
const CID_V1 = /^b[a-z2-7]{58,100}$/;
export const isMediaCid = (c: unknown): c is string => typeof c === 'string' && (CID_V0.test(c) || CID_V1.test(c));
const unhex = (h: string): Uint8Array => Uint8Array.from(h.match(/../g) ?? [], b => parseInt(b, 16));

/* ── 본문·해시·서명 문구 ─────────────────────────────────────────────── */

export function productBody(doc: ProductDoc | ProductBody): ProductBody {
  const { sig: _s, ...rest } = doc as ProductDoc;
  return rest as ProductBody;
}
/** 본문(sig 제외) 정본 JSON 의 SHA-256 hex. 판 연결(prev)과 상품 ID 가 이 값이다. */
export const productDocHash = (doc: ProductDoc | ProductBody): string => sha256Hex(utf8(canonicalJson(productBody(doc))));
/** rev 0 이면 자기 본문 해시(잠긴 파일 칸 lock 은 뺀다 — 칸이 없는 문서는 예전과 같은 값), 아니면 id 칸. */
export const productIdOf = (doc: ProductDoc | ProductBody): string => {
  if (doc.rev !== 0) return doc.id as string;
  const { lock: _l, ...rest } = productBody(doc);
  return productDocHash(rest as ProductBody);
};
/** signmessage 에 넘길 문구. */
export const productSigningMessage = (doc: ProductDoc | ProductBody): string => `${PRODUCT_SIGN_DOMAIN}\nsha256:${productDocHash(doc)}`;
/** 판매자 공개키 → 노드 signmessage 에 쓸 주소. */
export const sellerAddressOf = (sellerHex: string): string => addressOfPublicKey(unhex(sellerHex));
/** IPFS·공유에 쓰는 바이트 = 서명 포함 정본 JSON. */
export const encodeProductDoc = (doc: ProductDoc): Uint8Array => utf8(canonicalJson(doc));

/* ── 모양 검사 ─────────────────────────────────────────────────────── */

/** 엄격 검사(모르는 칸·빠진 칸 거절). 서명은 보지 않는다. */
export function validateProductDoc(raw: unknown): ProductDoc {
  const base = 'v,kind,seller,payTo,title,price,media,feeBps,feeSchedule,rev,id,prev,sig';
  if (!plain(raw) || !keysAre(raw, base + ('x' in raw ? ',x' : '') + ('storeId' in raw ? ',storeId' : '') + ('lock' in raw ? ',lock' : '') + ('preview' in raw ? ',preview' : ''))) return fail('product-shape', 'keys');
  const d = raw as Loose;
  if (d.v !== PRODUCT_DOC_VERSION) fail('product-shape', 'version');
  if (typeof d.kind !== 'string' || !KIND.test(d.kind)) fail('product-kind');
  if (typeof d.seller !== 'string' || !PUBKEY.test(d.seller)) fail('product-seller', 'pubkey');
  try { secp256k1.ProjectivePoint.fromHex(d.seller).assertValidity(); } catch { fail('product-seller', 'point'); }
  if (!isRvnAddress(d.payTo)) fail('product-pay-to', 'address');
  if (d.payTo === MARKET_FEE_ADDRESS) fail('product-pay-to', 'fee-address');
  if (!text(d.title, 1, 80) || d.title.trim() !== d.title) fail('product-shape', 'title');
  // 제목은 공유 카드(OG)·화면에 그대로 나간다 — 「인증·공식·보증·검증」 계열 주장 단어는 거절(§29, store/claim-words 한 곳).
  if (hasClaimWord(d.title)) fail('product-shape', 'title-claim-word');
  if (typeof d.price !== 'string' || !ATOMS.test(d.price) || BigInt(d.price) > MAX_PRICE_ATOMS) fail('product-price');
  if (!Array.isArray(d.media) || d.media.length > MAX_MEDIA || d.media.some((c: unknown) => typeof c === 'string' ? !isMediaCid(c) : mediaHashItemProblem(c) !== null) ||
      new Set(d.media.map((c: ProductMedia) => mediaKeyOf(c))).size !== d.media.length) fail('product-media');
  if (!int(d.feeBps, 0, MARKET_FEE_BPS_CEILING)) fail('product-fee', 'bps');
  if (typeof d.feeSchedule !== 'string' || !SHA.test(d.feeSchedule)) fail('product-fee', 'schedule');
  if (!int(d.rev, 0, MAX_REV)) fail('product-revision', 'rev');
  if (d.rev === 0 ? d.id !== null || d.prev !== null : typeof d.id !== 'string' || !SHA.test(d.id) || typeof d.prev !== 'string' || !SHA.test(d.prev)) fail('product-revision', 'link');
  if ('x' in d && !plain(d.x)) fail('product-shape', 'x');
  if ('storeId' in d && (typeof d.storeId !== 'string' || !SHA.test(d.storeId))) fail('product-shape', 'storeId');
  if ('lock' in d) { const p = productLockProblem(d.lock, d.kind); if (p) fail('product-shape', `lock-${p}`); }
  if ('preview' in d) { const p = productPreviewProblem(d.preview, d.kind); if (p) fail('product-shape', `preview-${p}`); }
  if (typeof d.sig !== 'string' || d.sig.length > 200) fail('product-signature', 'shape');
  let bytes = 0;
  try { bytes = utf8(canonicalJson(d)).length; } catch { fail('product-shape', 'canonical'); }
  if (bytes > MAX_PRODUCT_DOC_BYTES) fail('product-too-large');
  return d as ProductDoc;
}

/* ── 서명 확인 ─────────────────────────────────────────────────────── */

/** 65바이트 복구형 서명에서 서명한 공개키(서명 머리 바이트가 정한 압축 여부 그대로)를 hex 로. 안 되면 null. */
export function recoverMessagePublicKey(message: string, signatureBase64: string): string | null {
  try {
    const sig = base64Decode(signatureBase64);
    if (sig.length !== 65 || sig[0] < 27 || sig[0] > 34) return null;
    const recovery = (sig[0] - 27) & 3, compressed = sig[0] >= 31;
    const point = secp256k1.Signature.fromCompact(sig.subarray(1)).addRecoveryBit(recovery).recoverPublicKey(messageHash(message));
    return hex(point.toRawBytes(compressed));
  } catch { return null; }
}

/**
 * 받은 상품 문서(바이트 또는 객체)를 검사·서명 확인한다. 바이트면 정본 JSON 그대로여야 한다.
 * expectedId 를 주면(공유 링크 /r/<ID> 로 연 경우 항상) 상품 ID 가 같아야 한다.
 */
export function verifyProductDoc(input: Uint8Array | unknown, opts: { expectedId?: string } = {}): VerifiedProduct {
  let doc: unknown;
  if (input instanceof Uint8Array) {
    if (input.length > MAX_PRODUCT_DOC_BYTES) fail('product-too-large');
    try { doc = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(input)); } catch { return fail('product-json'); }
  } else doc = input;
  const d = validateProductDoc(doc);
  if (input instanceof Uint8Array && sha256Hex(input) !== sha256Hex(encodeProductDoc(d))) fail('product-shape', 'not-canonical');
  const signer = recoverMessagePublicKey(productSigningMessage(d), d.sig);
  if (signer === null || signer !== d.seller) fail('product-signature', 'invalid');
  const productId = productIdOf(d);
  if (opts.expectedId !== undefined && productId !== opts.expectedId) fail('product-revision', 'id-mismatch');
  return { doc: d, productId, docHash: productDocHash(d), sellerAddress: sellerAddressOf(d.seller) };
}

/**
 * 판 목록(rev 0 부터 순서대로) 전체를 확인하고 마지막 판을 돌려준다. 각 판의 서명, rev 연속, prev = 앞 판 본문 해시,
 * id = rev 0 의 본문 해시, 판매자 공개키 불변. 하나라도 틀리면 거절(부분 적용 없음).
 */
export function verifyRevisionChain(docs: readonly unknown[]): VerifiedProduct {
  if (!Array.isArray(docs) || docs.length < 1) return fail('product-revision', 'empty');
  let last: VerifiedProduct | null = null;
  for (const [i, raw] of docs.entries()) {
    const v = verifyProductDoc(raw);
    if (v.doc.rev !== i) fail('product-revision', 'rev-order');
    if (last) {
      if (v.doc.seller !== last.doc.seller) fail('product-revision', 'seller-changed');
      if (v.doc.prev !== last.docHash || v.productId !== last.productId) fail('product-revision', 'prev');
    }
    last = v;
  }
  return last as VerifiedProduct;
}

/** 시험·도구용 문서 서명기(개인키를 받는다). 앱은 노드 signmessage(데스크톱 sign_message)로 서명한다. */
export function signProductDocForTest(body: ProductBody, privateKey: Uint8Array): ProductDoc {
  const sig = signMessageWithKeyForTest(productSigningMessage(body), privateKey);
  return { ...productBody(body), sig };
}
/** 운영용: 키를 가진 서명 콜백으로 서명한다. 서명자가 body.seller 가 아니면 SignerError. */
export async function signProductDoc(signer: SignDigest, body: ProductBody): Promise<ProductDoc> {
  const clean = productBody(body);
  return { ...clean, sig: await signMessageWith(signer, productSigningMessage(clean), { publicKey: clean.seller }) };
}

/* ── payTo 대조 ───────────────────────────────────────────────────── */

/**
 * 결제 주소 대조: 화면·서버 견적·다른 프로그램이 넘긴 주소가 **서명된 문서의 payTo** 와 같아야 한다. 다르면 거절.
 * 결제 출력은 이 함수가 돌려준 값(= 문서 payTo)으로만 만든다.
 */
export function assertPayTo(v: VerifiedProduct, claimedAddress: unknown): string {
  if (typeof claimedAddress !== 'string' || claimedAddress !== v.doc.payTo) fail('pay-to-mismatch');
  return v.doc.payTo;
}

/* ── 수수료 일정(rv-fee-track) ─────────────────────────────────────── */

export const FEE_TRACK_FORMAT = 'rv-fee-track';
export const FEE_TRACK_DOMAIN = 'RAVENVAULT-FEE-TRACK-V1';
export const FEE_TRACK_SIGNATURE_FORMAT = 'rv-fee-track-signature';
/** 인상 유예 = 약 6개월(183일 × 1440블록, 1분 = 1블록 가정 — fee-schedule.ts 와 같은 근사). */
export const INCREASE_DELAY_BLOCKS = 183 * BLOCKS_PER_DAY;
export const PRODUCT_FEE_CAP_ATOMS = 500n * 100_000_000n;
/**
 * 수수료 면제선(§18 Q4) — 계산(내림·상한 적용)한 수수료가 이보다 작으면 수수료 출력을 만들지 않는다(면제, 실제 0).
 * 1,000,000 atoms = 0.01 RVN — 시험망 실측 반영(대표 승인 10-14, 결정문 §34). 근거 docs/testnet-measure/README.md (3):
 *   출력 하나를 나중에 쓰는 비용 ≈ 148,000 atoms → 0.01 RVN 이면 그 비용이 약 15%. 수수료 1% 기준 총액 1 RVN 미만 주문은 면제.
 *   불변식: MIN_FEE_OUTPUT_ATOMS ≥ PRODUCT_DUST_ATOMS(수수료 출력은 먼지가 될 수 없다, 시험이 고정).
 * (옛 「1 RVN 미만 면제」 PRODUCT_FEE_EXEMPT_BELOW_ATOMS 를 대체한다: 1% 는 100 RVN 이상에서만 걷히던 문제, §14-7.)
 */
export const MIN_FEE_OUTPUT_ATOMS = 1_000_000n;
/**
 * 판매자 출력 최소 금액 = 쓸 수 있는 최소 출력(150,000 atoms ≈ 0.0015 RVN, 실측한 「나중에 쓰는 비용」 ≈148,000 을 덮는 값).
 * 판매자 몫이 이보다 작으면 팔 수 없다. 시험망 실측 반영(대표 승인 10-14), 근거 docs/testnet-measure/README.md (3). 체인 표준 먼지 한도는 546.
 */
export const PRODUCT_DUST_ATOMS = 150_000n;
const MAX_HEIGHT = 1_000_000_000;

export type FeeVersion = { bps: number; announcedHeight: number };
export type FeeTrack = { format: typeof FEE_TRACK_FORMAT; version: 1; versions: FeeVersion[] };
export type FeeTrackSignature = { format: typeof FEE_TRACK_SIGNATURE_FORMAT; version: 1; keyId: string; algorithm: 'Ed25519'; domain: typeof FEE_TRACK_DOMAIN; signature: string };

/** 덧붙이기 전용 판 목록. 공지 높이는 엄격히 증가, 요율은 0..천장(5%). 지금 값은 전부 0%(currentZeroTrack). */
export function validateFeeTrack(raw: unknown): FeeTrack {
  const t = raw as Loose;
  if (plain(t) && t.format === FEE_TRACK_FORMAT && t.version !== 1) return fail(t.version === 2 ? 'track-mixed' : 'track-version', 'v1-parser');
  if (plain(t) && 'steps' in t) return fail('track-mixed', 'v2-field-in-v1');
  if (!plain(t) || !keysAre(t, 'format,version,versions') || t.format !== FEE_TRACK_FORMAT || t.version !== 1 ||
      !Array.isArray(t.versions) || t.versions.length < 1 || t.versions.length > 1000) return fail('track-shape', 'doc');
  let prev = 0;
  for (const v of t.versions as Loose[]) {
    if (!plain(v) || !keysAre(v, 'bps,announcedHeight') || !int(v.bps, 0, MARKET_FEE_BPS_CEILING) || !int(v.announcedHeight, prev + 1, MAX_HEIGHT)) fail('track-shape', 'version');
    prev = v.announcedHeight;
  }
  return t as FeeTrack;
}
/** 앞 n 판의 해시(상품 문서 feeSchedule 칸 값). n 생략 = 전체. */
export function feeTrackHash(track: FeeTrack, n: number = track.versions.length): string {
  validateFeeTrack(track);
  if (!int(n, 1, track.versions.length)) fail('track-shape', 'prefix');
  return sha256Hex(utf8(canonicalJson({ format: track.format, version: track.version, versions: track.versions.slice(0, n) })));
}
/** 이 일정이 문서가 서명한 일정(앞부분 해시)으로 시작하나. 맞으면 그 앞부분 길이, 아니면 0. */
export function trackExtends(track: FeeTrack, committed: string): number {
  for (let n = 1; n <= track.versions.length; n++) if (feeTrackHash(track, n) === committed) return n;
  return 0;
}
/** 출발값: 지금 수수료 전부 0%. 시작 높이는 대표 결정(서명 도구가 넣는다). */
export const zeroFeeTrack = (announcedHeight: number): FeeTrack => validateFeeTrack({ format: FEE_TRACK_FORMAT, version: 1, versions: [{ bps: 0, announcedHeight }] });

const trackSignedBytes = (track: FeeTrack) => utf8(`${FEE_TRACK_DOMAIN}\n${canonicalJson(track)}`);
/** 대표 도구·시험 전용. 앱은 부르지 않는다. */
export function signFeeTrack(track: FeeTrack, privateKey: Uint8Array): FeeTrackSignature {
  validateFeeTrack(track);
  return { format: FEE_TRACK_SIGNATURE_FORMAT, version: 1, keyId: keyIdOf(ed25519.getPublicKey(privateKey)), algorithm: 'Ed25519', domain: FEE_TRACK_DOMAIN,
    signature: b64urlEncode(ed25519.sign(trackSignedBytes(track), privateKey)) };
}
/** 운영 키(기본 = operating-keys.ts, 지금 비어 있음 → 어떤 일정도 믿지 않음 → 구매 계산 거절). */
export function verifyFeeTrack(track: unknown, signature: unknown, keys: readonly { keyId: string; publicKey: string }[] = OPERATING_LIST_KEYS): FeeTrack {
  const s = signature as Loose;
  if (!plain(s) || !keysAre(s, 'format,version,keyId,algorithm,domain,signature') || s.format !== FEE_TRACK_SIGNATURE_FORMAT || s.version !== 1 ||
      s.algorithm !== 'Ed25519' || s.domain !== FEE_TRACK_DOMAIN || typeof s.keyId !== 'string' || typeof s.signature !== 'string') return fail('track-signature', 'shape');
  const key = keys.find(k => k.keyId === s.keyId);
  if (!key) return fail('track-signature', 'unknown-key');
  const t = validateFeeTrack(track);
  let ok = false;
  try {
    const raw = b64urlDecode(key.publicKey), sig = b64urlDecode(s.signature);
    ok = raw.length === 32 && sig.length === 64 && keyIdOf(raw) === key.keyId && ed25519.verify(sig, trackSignedBytes(t), raw);
  } catch { ok = false; }
  if (!ok) fail('track-signature', 'invalid');
  return JSON.parse(JSON.stringify(t)) as FeeTrack;
}

/**
 * 높이 h 에서 일정의 요율(bps). 첫 판 공지 전이면 null.
 * 판 i 의 적용 높이 = 공지 높이(직전 유효 요율 이하 = 인하·동결) 또는 공지 높이 + INCREASE_DELAY_BLOCKS(인상).
 * h 에서 유효한 판 = 적용 높이 ≤ h 인 판 중 **가장 늦게 공지된** 판(뒤에 공지된 인하가 대기 중인 인상을 이긴다).
 */
export function trackBpsAt(track: FeeTrack, height: number): number | null {
  validateFeeTrack(track);
  if (!int(height, 0, MAX_HEIGHT)) fail('before-schedule', 'height');
  const vs = track.versions, takes: number[] = [];
  const at = (h: number, upto: number): number | null => {
    let best = -1;
    for (let j = 0; j < upto; j++) if (takes[j] <= h && vs[j].announcedHeight <= h) best = j;
    return best < 0 ? null : vs[best].bps;
  };
  for (let i = 0; i < vs.length; i++) {
    const before = i === 0 ? null : at(vs[i].announcedHeight - 1, i);
    takes.push(before === null || vs[i].bps <= before ? vs[i].announcedHeight : vs[i].announcedHeight + INCREASE_DELAY_BLOCKS);
  }
  return at(height, vs.length);
}

/** 영수증 표시값. 「요율 1%, 산출 0.12 RVN, 면제, 실제 0」 = { rateBps:100, computedAtoms:'12000000', exempt:true, actualAtoms:'0' }. */
export type FeeReceipt = { rateBps: number; computedAtoms: string; exempt: boolean; actualAtoms: string };
export type FeeAmount = {
  /** 상한 전 내림 계산값. */ rawAtoms: bigint;
  /** 상한까지 적용한 산출값(면제 전). */ computedAtoms: bigint;
  capped: boolean;
  /** 산출값이 0 보다 크고 면제선 미만. */ exempt: boolean;
  /** 실제 수수료 출력 금액(면제면 0). */ actualAtoms: bigint;
};

/**
 * 수수료 금액 계산 — 새 경로의 **유일한** 산식(§18 Q4). 내림 · 상한 · 면제선. 올림 없음.
 * 요율 0..천장(5%), 가격은 양의 정수 atoms 만.
 */
export function feeAmount(priceAtoms: bigint, bps: number, capAtoms: bigint = PRODUCT_FEE_CAP_ATOMS, minOutputAtoms: bigint = MIN_FEE_OUTPUT_ATOMS): FeeAmount {
  if (typeof priceAtoms !== 'bigint' || priceAtoms < 0n) fail('product-price');
  if (!int(bps, 0, MARKET_FEE_BPS_CEILING)) fail('product-fee', 'bps');
  const raw = (priceAtoms * BigInt(bps)) / 10000n;
  const capped = raw > capAtoms;
  const computed = capped ? capAtoms : raw;
  const exempt = computed > 0n && computed < minOutputAtoms;
  return { rawAtoms: raw, computedAtoms: computed, capped, exempt, actualAtoms: exempt ? 0n : computed };
}
export const feeReceiptOf = (bps: number, a: FeeAmount): FeeReceipt =>
  ({ rateBps: bps, computedAtoms: String(a.computedAtoms), exempt: a.exempt, actualAtoms: String(a.actualAtoms) });

/** 한 주문의 수량 상한(공동구매 등). product-ext/params.ts 가 이 값을 다시 내보낸다. */
export const MAX_ORDER_QTY = 999;
/** 주문 줄: 수량(기본 1)·배송비(atoms, 기본 0). 배송비는 서명된 문서 줄에서만 온다(product-ext productShareSplit). */
export type OrderLine = { qty?: number; shippingAtoms?: bigint };
export type OrderAmounts = { unitPriceAtoms: bigint; qty: number; goodsAtoms: bigint; shippingAtoms: bigint; totalAtoms: bigint };

/**
 * 주문 총액(§29 ①, 7/7) = 단가 × 수량 + 배송비, 수수료 전. 수수료와 공유 몫의 **유일한** 계산 기준이다
 * (옛 「상품가(배송비 제외)」 기준은 §28 안이었고 §29 에서 총액 하나로 통일 — 두 기준이 공존하지 않게 한다).
 */
export function orderAmounts(unitPriceAtoms: bigint, line: OrderLine = {}): OrderAmounts {
  const qty = line.qty ?? 1, ship = line.shippingAtoms ?? 0n;
  if (typeof unitPriceAtoms !== 'bigint' || unitPriceAtoms <= 0n || unitPriceAtoms > MAX_PRICE_ATOMS) fail('product-price');
  if (!int(qty, 1, MAX_ORDER_QTY)) fail('product-price', 'qty');
  if (typeof ship !== 'bigint' || ship < 0n || ship > MAX_PRICE_ATOMS) fail('product-price', 'shipping');
  const goods = unitPriceAtoms * BigInt(qty);
  return { unitPriceAtoms, qty, goodsAtoms: goods, shippingAtoms: ship, totalAtoms: goods + ship };
}

/**
 * 주문 총액 기준 수수료 — productFeeAt 과 공유 분할(product-ext/split.ts)이 함께 지나는 한 경로(feeAmount 산식 그대로).
 * 계산 순서(결정문 §36, 25라운드 — 지갑·화면·검증기가 모두 이 순서, 시험 fee-order.test.ts):
 *   ① 총액 T = 가격 × 수량 + 배송비(orderAmounts)
 *   ② 이용료 F = floor(T × 요율 / 10000) → 상한 500 RVN(PRODUCT_FEE_CAP_ATOMS) → 면제선(MIN_FEE_OUTPUT_ATOMS) 미만이면 0(feeAmount)
 *   ③ 공유 몫 S = floor(T × 공유% / 100) — 디지털 상품만(product-ext), **총액 기준이고 500 RVN 상한은 S 에 걸리지 않는다**
 *   ④ 판매자 몫 = T − F − S(나머지)
 */
export function orderFee(unitPriceAtoms: bigint, bps: number, line: OrderLine = {}, opts: { capAtoms?: bigint; minOutputAtoms?: bigint } = {}): { amounts: OrderAmounts; fee: FeeAmount } {
  const amounts = orderAmounts(unitPriceAtoms, line);
  return { amounts, fee: feeAmount(amounts.totalAtoms, bps, opts.capAtoms, opts.minOutputAtoms) };
}

export type ProductFee = {
  /** 실제 적용 요율 = min(문서 feeBps, 일정 요율). */
  bps: number; docBps: number; scheduleBps: number;
  /** 주문 줄(§29 ②): 단가·수량·배송비·총액(수수료 전). 수수료는 총액 기준. */
  unitPriceAtoms: string; qty: number; shippingAtoms: string; totalAtoms: string;
  /** 상한·면제 전 수수료(내림). */ rawFeeAtoms: string;
  /** 상한 적용·면제 전 산출값. */ computedAtoms: string;
  /** sellerAtoms = 총액 − 수수료. */
  feeAtoms: string; sellerAtoms: string; capped: boolean; exempt: boolean;
  /** 영수증 표시값(rateBps = bps). */ receipt: FeeReceipt;
};
export type ProductFeeOpts = { capAtoms?: bigint; minOutputAtoms?: bigint } & OrderLine;

/** 일정 요율이 정해진 뒤의 공통 마무리(v1·v2 일정 모두 이 함수를 지난다). 금액 기준 = 주문 총액(orderFee). */
export function productFeeAt(doc: ProductBody, scheduleBps: number, opts: ProductFeeOpts = {}): ProductFee {
  const price = BigInt(doc.price);
  if (price < PRODUCT_DUST_ATOMS) fail('price-too-small');
  const bps = Math.min(doc.feeBps, scheduleBps);
  const { amounts: o, fee: a } = orderFee(price, bps, { qty: opts.qty, shippingAtoms: opts.shippingAtoms }, opts);
  const seller = o.totalAtoms - a.actualAtoms;
  if (seller < PRODUCT_DUST_ATOMS) fail('price-too-small');
  return { bps, docBps: doc.feeBps, scheduleBps, unitPriceAtoms: String(o.unitPriceAtoms), qty: o.qty, shippingAtoms: String(o.shippingAtoms), totalAtoms: String(o.totalAtoms),
    rawFeeAtoms: String(a.rawAtoms), computedAtoms: String(a.computedAtoms), feeAtoms: String(a.actualAtoms),
    sellerAtoms: String(seller), capped: a.capped, exempt: a.exempt, receipt: feeReceiptOf(bps, a) };
}

/**
 * 상품 하나의 수수료(순수, v1 일정). height = 구매 시 팁 + 1, 기록 판정 시 포함 블록.
 * 문서가 서명한 일정 앞부분으로 시작하지 않는 일정이면 'track-mismatch'(다른 일정으로 바꿔치기 방지). 첫 판 공지 전이면 'before-schedule'.
 */
export function productFee(p: { doc: ProductBody; track: FeeTrack; height: number } & ProductFeeOpts): ProductFee {
  if (!trackExtends(p.track, p.doc.feeSchedule)) fail('track-mismatch');
  const scheduleBps = trackBpsAt(p.track, p.height);
  if (scheduleBps === null) return fail('before-schedule');
  return productFeeAt(p.doc, scheduleBps, p);
}

/* ── 주문 해시 v2 · 구매 메모(RVLT) ───────────────────────────────── */

export const RVLT_MAGIC = 'RVLT';
/** 메모 버전(매직 바로 뒤 1바이트). 2 = 주문 해시 v2(§29 ②). 배포 전이라 v1(가격만·분할표 없음)은 읽지 않고 2 로 올렸다. 새 칸(예: 추천 몫)은 이 버전을 올려 더한다. */
export const RVLT_VERSION = 2;
export const ORDER_HASH_DOMAIN = 'RAVENVAULT-ORDER-V2';

/** 결제 출력 분할표 한 줄(메모 제외). 순서 = 판매자 → (공유자) → (수수료). */
export type OrderSplitRow = { role: 'seller' | 'share' | 'fee'; address: string; atoms: string };
/**
 * 주문 원문 v2(§29 ②). priceAtoms = 주문 총액(단가 × 수량 + 배송비, 수수료 전) = 분할표 합계. unitPriceAtoms·qty·shippingAtoms 는 따로 적는다.
 * split = 실제 결제 출력 금액표(수령 주소·금액) — 공유 몫이 주문 해시에 묶여, 체인 메모로 누가 얼마를 받기로 했는지 다시 맞춰 볼 수 있다.
 */
export type OrderPreimage = {
  productId: string; docHash: string; payTo: string;
  unitPriceAtoms: string; qty: number; shippingAtoms: string; priceAtoms: string;
  split: OrderSplitRow[]; buyerKeyHash: string; nonce: string;
};
const ROLE_ORDER: Record<OrderSplitRow['role'], number> = { seller: 0, share: 1, fee: 2 };

/**
 * 주문 원문 엄격 검사. 총액 = 단가 × 수량 + 배송비 = 분할표 합계, 판매자 줄 = payTo, 역할은 순서대로 한 번씩,
 * 수수료 줄 주소 = 코드 고정 MARKET_FEE_ADDRESS(다른 주소 거절), 공유자 ≠ payTo·수수료 주소.
 * (공유자 ≠ 판매자 공개키 주소는 문서가 있어야 알 수 있어 product-ext/split.ts 가 다시 본다.)
 */
export function validateOrderPreimage(raw: unknown): OrderPreimage {
  const o = raw as Loose;
  if (!plain(o) || !keysAre(o, 'productId,docHash,payTo,unitPriceAtoms,qty,shippingAtoms,priceAtoms,split,buyerKeyHash,nonce')) return fail('memo', 'order-keys');
  if (typeof o.productId !== 'string' || !SHA.test(o.productId) || typeof o.docHash !== 'string' || !SHA.test(o.docHash) ||
      typeof o.buyerKeyHash !== 'string' || !SHA.test(o.buyerKeyHash) || typeof o.nonce !== 'string' || !/^[a-f0-9]{32}$/.test(o.nonce)) fail('memo', 'order');
  if (!isRvnAddress(o.payTo)) fail('memo', 'pay-to');
  if (typeof o.unitPriceAtoms !== 'string' || !ATOMS.test(o.unitPriceAtoms) || typeof o.shippingAtoms !== 'string' || !/^(0|[1-9]\d{0,17})$/.test(o.shippingAtoms) ||
      typeof o.priceAtoms !== 'string' || !ATOMS.test(o.priceAtoms) || !int(o.qty, 1, MAX_ORDER_QTY)) fail('memo', 'amounts');
  if (BigInt(o.unitPriceAtoms) * BigInt(o.qty) + BigInt(o.shippingAtoms) !== BigInt(o.priceAtoms)) fail('memo', 'total');
  if (!Array.isArray(o.split) || o.split.length < 1 || o.split.length > 3) fail('memo', 'split');
  let sum = 0n, last = -1;
  for (const r of o.split as Loose[]) {
    if (!plain(r) || !keysAre(r, 'role,address,atoms') || !(typeof r.role === 'string' && Object.prototype.hasOwnProperty.call(ROLE_ORDER, r.role))) fail('memo', 'split-row');
    const rank = ROLE_ORDER[r.role as OrderSplitRow['role']];
    if (rank <= last || (last === -1 && rank !== 0)) fail('memo', 'split-order');
    last = rank;
    if (!isRvnAddress(r.address) || typeof r.atoms !== 'string' || !ATOMS.test(r.atoms)) fail('memo', 'split-row');
    sum += BigInt(r.atoms);
  }
  const rows = o.split as OrderSplitRow[];
  if (rows[0].address !== o.payTo) fail('memo', 'split-seller');
  const share = rows.find(r => r.role === 'share'), fee = rows.find(r => r.role === 'fee');
  if (fee && fee.address !== MARKET_FEE_ADDRESS) fail('memo', 'split-fee');
  if (o.payTo === MARKET_FEE_ADDRESS) fail('memo', 'pay-to');
  if (share && (share.address === o.payTo || share.address === MARKET_FEE_ADDRESS)) fail('memo', 'split-share');
  if (sum !== BigInt(o.priceAtoms)) fail('memo', 'split-sum');
  return o as OrderPreimage;
}

/**
 * 주문 해시 = sha256(DOMAIN \n 정본 JSON(주문 원문 v2)).
 * buyerKeyHash = 구매자 일회용 키 공개키의 sha256 hex(공개키 자체는 체인에 올리지 않는다 — 열람 요청 때 판매자에게만 보여 준다).
 */
export function orderHash(o: OrderPreimage): string {
  const v = validateOrderPreimage(o);
  const body = { buyerKeyHash: v.buyerKeyHash, docHash: v.docHash, nonce: v.nonce, payTo: v.payTo, priceAtoms: v.priceAtoms, productId: v.productId, qty: v.qty,
    shippingAtoms: v.shippingAtoms, split: v.split.map(r => ({ address: r.address, atoms: r.atoms, role: r.role })), unitPriceAtoms: v.unitPriceAtoms };
  return sha256Hex(utf8(`${ORDER_HASH_DOMAIN}\n${canonicalJson(body)}`));
}
const RVLT_HEX = '52564c54';
const verHex = (n: number) => n.toString(16).padStart(2, '0');
/** OP_RETURN 스크립트 hex: 6a 25 "RVLT" <버전 1바이트 = RVLT_VERSION> <주문 해시 32바이트>. */
export function encodeOrderMemo(orderHashHex: string): string {
  if (!SHA.test(orderHashHex)) fail('memo', 'hash');
  return '6a25' + hex(utf8(RVLT_MAGIC)) + verHex(RVLT_VERSION) + orderHashHex;
}
/** 메모 스크립트 → { 버전, 주문 해시 }. 모양만 본다(모르는 버전도 돌려준다 — 화면이 「다른 버전 메모」라고 말할 수 있게). RVLT 모양이 아니면 null. */
export function parseOrderMemo(scriptHex: unknown): { version: number; orderHash: string } | null {
  if (typeof scriptHex !== 'string') return null;
  const m = new RegExp(`^6a25${RVLT_HEX}([a-f0-9]{2})([a-f0-9]{64})$`).exec(scriptHex);
  return m ? { version: parseInt(m[1], 16), orderHash: m[2] } : null;
}
/** 메모 스크립트 → 주문 해시. 지금 버전(RVLT_VERSION)이 아니면 null(다른 버전·RVDP 메모와 섞지 않는다). */
export function decodeOrderMemo(scriptHex: unknown): string | null {
  const p = parseOrderMemo(scriptHex);
  return p && p.version === RVLT_VERSION ? p.orderHash : null;
}

/* ── 구매 출력(한 거래: 판매자 + 수수료 + 메모) ─────────────────────── */

export type ProductOutput = { role: 'seller' | 'fee' | 'memo'; address: string | null; atoms: string; scriptHex?: string };

/**
 * 결제 분할표(메모 제외) = 판매자(payTo) → (수수료 > 0 일 때만) 수수료(코드 고정 주소). 주문 원문 split 칸과 출력이 같은 값에서 나온다.
 * 판매자 주소는 문서 payTo 에서만, 수수료 주소는 코드(MARKET_FEE_ADDRESS)에서만 온다(인자로 받지 않는다).
 * 수수료 정보(fee)는 이 문서·그 요율로 **다시 계산한 값과 같아야** 한다(feeAtoms 0 등으로 고친 견적 거절). 요율은 문서 feeBps·일정 요율을 넘을 수 없다.
 */
export function productSplitRows(v: VerifiedProduct, fee: ProductFee): OrderSplitRow[] {
  if (v.doc.payTo === MARKET_FEE_ADDRESS) fail('product-pay-to', 'fee-address');
  if (!plain(fee) || fee.unitPriceAtoms !== v.doc.price) fail('product-fee', 'order');
  if (!int(fee.bps, 0, MARKET_FEE_BPS_CEILING) || !int(fee.scheduleBps, 0, MARKET_FEE_BPS_CEILING) || fee.bps > v.doc.feeBps || fee.bps > fee.scheduleBps) fail('product-fee', 'bps');
  let again: ProductFee | null = null;
  try {
    if (!/^(0|[1-9]\d{0,17})$/.test(fee.shippingAtoms)) throw 0;
    again = productFeeAt({ ...v.doc, feeBps: fee.bps }, fee.scheduleBps, { qty: fee.qty, shippingAtoms: BigInt(fee.shippingAtoms) });
  } catch { again = null; }
  const pick = (f: ProductFee) => [f.bps, f.unitPriceAtoms, f.qty, f.shippingAtoms, f.totalAtoms, f.rawFeeAtoms, f.computedAtoms, f.feeAtoms, f.sellerAtoms, f.capped, f.exempt,
    f.receipt?.rateBps, f.receipt?.computedAtoms, f.receipt?.exempt, f.receipt?.actualAtoms].join('|');
  if (again === null || pick(again) !== pick(fee)) fail('product-fee', 'split');
  const rows: OrderSplitRow[] = [{ role: 'seller', address: v.doc.payTo, atoms: fee.sellerAtoms }];
  if (BigInt(fee.feeAtoms) > 0n) rows.push({ role: 'fee', address: MARKET_FEE_ADDRESS, atoms: fee.feeAtoms });
  return rows;
}

/** 주문 원문(해시 전). 분할표는 productSplitRows 와 같다. */
export function productOrderPreimage(v: VerifiedProduct, fee: ProductFee, buyer: { buyerKeyHash: string; nonce: string }): OrderPreimage {
  return validateOrderPreimage({ productId: v.productId, docHash: v.docHash, payTo: v.doc.payTo, unitPriceAtoms: fee.unitPriceAtoms, qty: fee.qty,
    shippingAtoms: fee.shippingAtoms, priceAtoms: fee.totalAtoms, split: productSplitRows(v, fee), buyerKeyHash: buyer.buyerKeyHash, nonce: buyer.nonce });
}

/**
 * 출력 순서 = 판매자(payTo) → (수수료 > 0 일 때만) 수수료 → 메모. 잔돈·네트워크 수수료는 지갑이 채운다.
 * order = 메모에 실을 주문 원문. 이 문서·견적으로 다시 만든 원문과 해시가 같아야 하고, memo = encodeOrderMemo(orderHash(order)) 여야 한다
 * (모양만 맞는 남의 메모·다른 분할표의 메모를 붙이지 못한다).
 */
export function productPurchaseOutputs(v: VerifiedProduct, fee: ProductFee, order: OrderPreimage, memoScriptHex: string): ProductOutput[] {
  const expected = productOrderPreimage(v, fee, { buyerKeyHash: order?.buyerKeyHash, nonce: order?.nonce });
  let h = '';
  try { h = orderHash(order); } catch { fail('memo', 'order'); }
  if (h !== orderHash(expected)) fail('memo', 'order-mismatch');
  if (memoScriptHex !== encodeOrderMemo(h)) fail('memo', 'script');
  const out: ProductOutput[] = expected.split.map(r => ({ role: r.role as 'seller' | 'fee', address: r.address, atoms: r.atoms }));
  out.push({ role: 'memo', address: null, atoms: '0', scriptHex: memoScriptHex });
  return out;
}

/* ── 공유 링크 /r/<상품 ID> ─────────────────────────────────────── */

export const SHARE_ORIGIN = 'https://ravenvault.ex.erci.se';
/** QR 에도 이 https 주소를 그대로 싣는다. */
export function productShareUrl(productId: string, origin: string = SHARE_ORIGIN): string {
  if (!SHA.test(productId)) fail('share-link', 'id');
  return `${origin}/r/${productId}`;
}
/** 공유 링크 → 상품 ID. https 와 /r/<64 hex> 만. 열린 문서는 verifyProductDoc(…, { expectedId }) 로 다시 맞춰 본다. */
export function parseShareUrl(url: unknown, origin: string = SHARE_ORIGIN): string | null {
  if (typeof url !== 'string') return null;
  let u: URL;
  try { u = new URL(url); } catch { return null; }
  if (u.protocol !== 'https:' || u.origin !== origin) return null;
  const m = /^\/r\/([a-f0-9]{64})\/?$/.exec(u.pathname);
  return m ? m[1] : null;
}
