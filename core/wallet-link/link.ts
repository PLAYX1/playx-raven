/**
 * 데스크탑 지갑 연결 — 폰과 데스크탑이 주고받는 글의 모양·확인값·서명(순수 함수: 시계·저장소·네트워크 없음).
 * 설계 정본: docs/DESKTOP-WALLET-LINK.md (11-02 GPT·그록 검토 반영, 대표 결정: 데스크탑 주 지갑 계정 0).
 *
 *  · 연결 제안(데스크탑 → 폰 QR, 1분): 데스크탑 연결 공개키 · 주 지갑 account xpub(m/44'/175'/0', 받기 전용) · 첫 받는 주소 · 1회용 난수.
 *    폰은 xpub 에 개인키가 없고(깊이 3·계정 0'), 첫 주소가 xpub 에서 나온 것과 같을 때만 받는다.
 *  · 6자리 확인값 = 두 연결 공개키 + xpub + 경로 + 첫 주소 + 체인 + 난수. QR 이 바뀌면 두 화면 숫자가 달라진다(바꿔치기 방지).
 *  · 연결 키는 지갑 열쇠·판매 리모컨 기기 키와 다른 난수 키다(이 파일은 공개키·서명만 다룬다).
 *  · 요청(폰 → 데스크탑)은 폰 연결 키로 따로 서명한다: 도메인·연결 id·체인·계정·만료가 서명에 들어간다.
 *    데스크탑은 이 검사를 통과해도 **사람 승인 없이는 서명하지 않는다**. 받는 곳이 연결 때 등록한 폰 주소면 'fill', 아니면 'send'(빨간 표시).
 */
import { HDKey } from '@scure/bip32';
import { ripemd160 } from '@noble/hashes/ripemd160';
import { sha256 } from '@noble/hashes/sha256';
import { schnorr } from '../crypto-backend';
import { b64urlDecode, b64urlEncode, canonicalJson } from '../creator/bytes';
import { encodeBase58Check } from '../wallet-offline/base58check';

export const LINK_DOMAIN = 'ravenvault-wallet-link-v1';
export const LINK_CHAIN = 'rvn-main';
export const LINK_ACCOUNT = 0;
export const LINK_OFFER_PREFIX = 'RVWL1.';
export const LINK_OFFER_TTL_MS = 60_000;
export const LINK_REQUEST_TTL_MS = 10 * 60_000;
/** 쓴 요청 id 를 이만큼 기억한다(만료창의 여러 배 — 늦게 다시 온 같은 요청을 다시 서명하지 않게). */
export const LINK_SEEN_RETAIN_MS = 6 * LINK_REQUEST_TTL_MS;
/** 하루 합계의 최대 = RVN 총발행량(21,000,000,000 RVN) — 이 값이면 「한도 없음」. 실제 한도는 연결 때 데스크탑이 정한다(기본 1,000 RVN).
 *  한도가 없어도 돈은 언제나 데스크탑에서 사람이 승인해야 나간다. */
export const LINK_DAILY_SATS = 21_000_000_000n * 100_000_000n;
const MAX_PHONE_ADDRESSES = 8;

const HEX64 = /^[0-9a-f]{64}$/, SIG = /^[0-9a-f]{128}$/, ADDRESS = /^R[1-9A-HJ-NP-Za-km-z]{25,34}$/, SATS = /^[1-9]\d{0,17}$/;
const hex = (b: Uint8Array) => Array.from(b, x => x.toString(16).padStart(2, '0')).join('');
const unhex = (h: string) => Uint8Array.from(h.match(/../g) ?? [], x => parseInt(x, 16));
const utf8 = (s: string) => new TextEncoder().encode(s);
const digest = (tag: string, body: unknown) => sha256(utf8(`${LINK_DOMAIN}|${tag}|${canonicalJson(body)}`));
const int = (n: unknown, min = 0): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= min;

export type LinkOffer = { v: 1; chain: typeof LINK_CHAIN; account: 0; desktopKey: string; name: string; xpub: string; firstAddress: string; nonce: string; expires: number };

/** 받기 줄(0)의 index 번째 주소. 거스름 줄(1)은 쓰지 않는다. xpub 는 공개 계정 키(깊이 3·계정 0')만. */
export function linkReceiveAddress(xpub: string, index: number): string {
  if (!int(index) || index > 1_000_000) throw new Error('link-index');
  const key = HDKey.fromExtendedKey(xpub);
  if (key.privateKey || key.depth !== 3 || key.index !== 0x80000000 + LINK_ACCOUNT) throw new Error('link-xpub');
  const child = key.deriveChild(0).deriveChild(index);
  if (child.index !== index || !child.publicKey) throw new Error('link-xpub');
  return encodeBase58Check(60, ripemd160(sha256(child.publicKey)));
}

export function encodeLinkOffer(offer: LinkOffer): string {
  return LINK_OFFER_PREFIX + b64urlEncode(utf8(canonicalJson(offer)));
}
/** QR 글 → 검사한 제안. 모양·만료·xpub(공개·계정 0)·첫 주소가 하나라도 틀리면 던진다. */
export function parseLinkOffer(text: string, now: number): LinkOffer {
  if (typeof text !== 'string' || !text.startsWith(LINK_OFFER_PREFIX) || text.length > 2000) throw new Error('link-offer');
  let v: Record<string, unknown>;
  try { v = JSON.parse(new TextDecoder().decode(b64urlDecode(text.slice(LINK_OFFER_PREFIX.length)))); } catch { throw new Error('link-offer'); }
  const keys = ['account', 'chain', 'desktopKey', 'expires', 'firstAddress', 'name', 'nonce', 'v', 'xpub'];
  if (!v || Object.keys(v).sort().join() !== keys.join()) throw new Error('link-offer');
  if (v.v !== 1 || v.chain !== LINK_CHAIN || v.account !== LINK_ACCOUNT || typeof v.desktopKey !== 'string' || !HEX64.test(v.desktopKey) || typeof v.nonce !== 'string' || !HEX64.test(v.nonce)) throw new Error('link-offer');
  if (typeof v.name !== 'string' || !v.name.trim() || v.name.length > 40 || typeof v.xpub !== 'string' || !v.xpub.startsWith('xpub') || v.xpub.length > 120) throw new Error('link-offer');
  if (!int(v.expires, 1) || v.expires < now || v.expires > now + LINK_OFFER_TTL_MS + 5_000) throw new Error('link-expired');
  if (typeof v.firstAddress !== 'string' || linkReceiveAddress(v.xpub, 0) !== v.firstAddress) throw new Error('link-address');
  return v as LinkOffer;
}

/** 이 연결의 이름표(두 키 + 난수). 요청·결과가 다른 연결로 옮겨 가지 못하게 서명에 들어간다. */
export function linkId(offer: Pick<LinkOffer, 'desktopKey' | 'nonce'>, phoneKey: string): string {
  return hex(digest('id', { desktopKey: offer.desktopKey, phoneKey, nonce: offer.nonce }));
}
/** 두 화면에 같은 6자리가 떠야 연결한다. xpub·첫 주소·경로·체인까지 묶여 있다. */
export function linkConfirmCode(offer: LinkOffer, phoneKey: string): string {
  if (!HEX64.test(phoneKey)) throw new Error('link-key');
  const d = digest('code', { desktopKey: offer.desktopKey, phoneKey, xpub: offer.xpub, path: "m/44'/175'/0'", firstAddress: offer.firstAddress, chain: offer.chain, nonce: offer.nonce });
  const n = ((d[0] << 24) >>> 0) + (d[1] << 16) + (d[2] << 8) + d[3];
  return String(n % 1_000_000).padStart(6, '0');
}

/** 폰이 연결을 받아들이며 데스크탑에 보내는 것: 폰 연결 공개키 + 「폰으로 채우기」 받을 내 폰 주소들(서명). */
export type LinkAccept = { v: 1; linkId: string; phoneKey: string; phoneAddresses: string[] };
export type Signed<T> = { body: T; sig: string };
const sign = <T>(tag: string, body: T, secret: Uint8Array): Signed<T> => ({ body, sig: hex(schnorr.sign(digest(tag, body), secret)) });
const verify = (tag: string, s: Signed<unknown>, pub: string) => {
  try { return typeof s?.sig === 'string' && SIG.test(s.sig) && HEX64.test(pub) && schnorr.verify(digest(tag, s.body), unhex(pub), unhex(s.sig)); } catch { return false; }
};
export function signLinkAccept(body: LinkAccept, phoneSecret: Uint8Array): Signed<LinkAccept> {
  if (!HEX64.test(body.phoneKey) || !HEX64.test(body.linkId) || !Array.isArray(body.phoneAddresses) || body.phoneAddresses.length < 1 || body.phoneAddresses.length > MAX_PHONE_ADDRESSES || !body.phoneAddresses.every(a => ADDRESS.test(a))) throw new Error('link-accept');
  return sign('accept', body, phoneSecret);
}
/** 데스크탑: 받은 수락이 이 제안·이 폰 키에 묶여 있고 서명이 맞나. */
export function verifyLinkAccept(s: Signed<LinkAccept>, offer: LinkOffer): LinkAccept {
  const b = s?.body;
  if (!b || b.v !== 1 || !HEX64.test(b.phoneKey) || b.linkId !== linkId(offer, b.phoneKey) || !Array.isArray(b.phoneAddresses) || b.phoneAddresses.length < 1
    || b.phoneAddresses.length > MAX_PHONE_ADDRESSES || !b.phoneAddresses.every(a => typeof a === 'string' && ADDRESS.test(a)) || !verify('accept', s, b.phoneKey)) throw new Error('link-accept');
  return { v: 1, linkId: b.linkId, phoneKey: b.phoneKey, phoneAddresses: [...b.phoneAddresses] };
}

/** 폰 → 데스크탑 요청. sats 는 사토시 정수 글자. */
export type LinkRequest = { v: 1; chain: typeof LINK_CHAIN; account: 0; linkId: string; id: string; to: string; sats: string; created: number; expires: number };
export function signLinkRequest(body: LinkRequest, phoneSecret: Uint8Array): Signed<LinkRequest> {
  if (!requestShapeOk(body)) throw new Error('link-request');
  return sign('request', body, phoneSecret);
}
function requestShapeOk(b: LinkRequest | undefined): b is LinkRequest {
  return !!b && b.v === 1 && b.chain === LINK_CHAIN && b.account === LINK_ACCOUNT && HEX64.test(b.linkId) && HEX64.test(b.id) && typeof b.to === 'string' && ADDRESS.test(b.to)
    && typeof b.sats === 'string' && SATS.test(b.sats) && int(b.created, 1) && int(b.expires, 1) && b.expires > b.created && b.expires - b.created <= LINK_REQUEST_TTL_MS;
}
/** 데스크탑이 아는 이 연결(수락 때 저장). revoked 면 어떤 요청도 받지 않는다. */
export type LinkRecord = { linkId: string; phoneKey: string; phoneAddresses: readonly string[]; revoked: boolean; dailySats: bigint };
export type LinkSpend = { at: number; sats: bigint };
export type RequestCheck = { ok: true; kind: 'fill' | 'send'; request: LinkRequest } | { ok: false; reason: 'shape' | 'signature' | 'revoked' | 'other-link' | 'expired' | 'future' | 'seen' | 'daily-limit' };
/**
 * 데스크탑 검사(사람 승인 화면을 띄우기 전). seen = 이미 받은 요청 id(서명 전에 기록해야 한다 — 이중 지급 방지).
 * spent = 지난 24시간 이 연결로 나간 것. 통과해도 승인은 사람이 한다.
 */
export function checkLinkRequest(s: Signed<LinkRequest>, link: LinkRecord, now: number, seen: ReadonlySet<string>, spent: readonly LinkSpend[]): RequestCheck {
  const b = s?.body;
  if (!requestShapeOk(b)) return { ok: false, reason: 'shape' };
  if (link.revoked) return { ok: false, reason: 'revoked' };
  if (b.linkId !== link.linkId) return { ok: false, reason: 'other-link' };
  if (!verify('request', s, link.phoneKey)) return { ok: false, reason: 'signature' };
  if (b.created > now + 120_000) return { ok: false, reason: 'future' };
  if (b.expires < now) return { ok: false, reason: 'expired' };
  if (seen.has(b.id)) return { ok: false, reason: 'seen' };
  const day = spent.filter(x => x.at > now - 86_400_000).reduce((n, x) => n + x.sats, 0n);
  if (day + BigInt(b.sats) > link.dailySats) return { ok: false, reason: 'daily-limit' };
  return { ok: true, kind: link.phoneAddresses.includes(b.to) ? 'fill' : 'send', request: { ...b } };
}

/** 데스크탑 → 폰 결과(데스크탑 연결 키 서명). 거절도 결과다. */
export type LinkResult = { v: 1; linkId: string; id: string; txid?: string; refused?: string };
export function signLinkResult(body: LinkResult, desktopSecret: Uint8Array): Signed<LinkResult> {
  if (!HEX64.test(body.linkId) || !HEX64.test(body.id) || (body.txid === undefined) === (body.refused === undefined) || (body.txid !== undefined && !HEX64.test(body.txid))) throw new Error('link-result');
  return sign('result', body, desktopSecret);
}
export function verifyLinkResult(s: Signed<LinkResult>, desktopKey: string, linkIdHere: string): LinkResult {
  const b = s?.body;
  if (!b || b.v !== 1 || b.linkId !== linkIdHere || !HEX64.test(b.id) || (b.txid !== undefined && !HEX64.test(b.txid)) || (b.txid === undefined) === (b.refused === undefined) || !verify('result', s, desktopKey)) throw new Error('link-result');
  return { ...b };
}

/**
 * 데스크탑 → 폰 「받았어요」(데스크탑 연결 키 서명). 요청을 검사해 승인 대기 목록에 올린 때 한 번 보낸다 — 승인이 아니다.
 * dailySats·spentToday = 그때 이 연결의 하루 한도·지난 24시간 쓴 것(사토시 정수 글자). dailySats 가 LINK_DAILY_SATS 면 「한도 없음」.
 * 옛 폰은 이 종류를 모르니 조용히 버리고, 옛 데스크탑은 보내지 않는다 — 폰은 이것 없이도 결과만으로 동작한다.
 */
export type LinkSeen = { v: 1; linkId: string; id: string; at: number; dailySats: string; spentToday: string };
const DAILY = /^[1-9]\d{0,18}$/, SPENT = /^(0|[1-9]\d{0,19})$/;
function seenShapeOk(b: LinkSeen | undefined): b is LinkSeen {
  return !!b && b.v === 1 && HEX64.test(b.linkId) && HEX64.test(b.id) && int(b.at, 1) && typeof b.dailySats === 'string' && DAILY.test(b.dailySats)
    && BigInt(b.dailySats) <= LINK_DAILY_SATS && typeof b.spentToday === 'string' && SPENT.test(b.spentToday);
}
export function signLinkSeen(body: LinkSeen, desktopSecret: Uint8Array): Signed<LinkSeen> {
  if (!seenShapeOk(body)) throw new Error('link-seen');
  return sign('seen', body, desktopSecret);
}
export function verifyLinkSeen(s: Signed<LinkSeen>, desktopKey: string, linkIdHere: string): LinkSeen {
  const b = s?.body;
  if (!seenShapeOk(b) || b.linkId !== linkIdHere || !verify('seen', s, desktopKey)) throw new Error('link-seen');
  return { v: 1, linkId: b.linkId, id: b.id, at: b.at, dailySats: b.dailySats, spentToday: b.spentToday };
}

/** 연결 끊기(어느 쪽이든 자기 연결 키로 서명). 받은 쪽은 그 연결의 대기 요청을 모두 버리고 철회로 기록한다. */
export type LinkRevoke = { v: 1; linkId: string; at: number };
export function signLinkRevoke(body: LinkRevoke, secret: Uint8Array): Signed<LinkRevoke> {
  if (!HEX64.test(body.linkId) || !int(body.at, 1)) throw new Error('link-revoke');
  return sign('revoke', body, secret);
}
export function verifyLinkRevoke(s: Signed<LinkRevoke>, signerKey: string, linkIdHere: string): LinkRevoke {
  const b = s?.body;
  if (!b || b.v !== 1 || b.linkId !== linkIdHere || !int(b.at, 1) || !verify('revoke', s, signerKey)) throw new Error('link-revoke');
  return { ...b };
}

/**
 * 폰 → 데스크탑 「팔아 줘」(폰 연결 키 서명, 꼬리표 'sell'). 0.9.18 — 데스크탑에서 먼저 더함(폰 저장소에 같은 바이트로 옮긴다).
 * 데스크탑이 그 연결에 「폰에서 판매 허용」을 켜 두었을 때만, 데스크탑 지갑의 자산을 묶음 → 반쪽 제안 → 장터 글로 올린다.
 * 사는 쪽이 낼 돈을 데스크탑이 보내는 일은 없다(파는 쪽 반쪽 서명뿐). 폰은 보내기 전에 생체 인증을 거친다(폰 몫).
 *  · amount = 자산 수량 글자(소수 8자리까지) · priceRvn = RVN 값 글자(소수 정확히 8자리, 파는 사람이 받는 값)
 *  · image 는 없어도 된다(없으면 키 자체를 빼고 서명한다 — undefined 는 정규 JSON 이 받지 않는다).
 *  · 모르는 키가 있으면 받지 않는다(돈 글은 엄격히).
 */
export const LINK_SELL_TTL_MS = 10 * 60_000;
export const LINK_SELL_CATEGORIES = ['music', 'game', 'image', 'book', 'ticket', 'work', 'other'] as const;
export type LinkSellCategory = typeof LINK_SELL_CATEGORIES[number];
export type LinkSell = { v: 1; linkId: string; id: string; asset: string; amount: string; priceRvn: string; title: string; summary: string; category: LinkSellCategory; image?: string; created: number; expires: number };
export type LinkUnsell = { v: 1; linkId: string; id: string; d: string; created: number; expires: number };
export const LINK_SELL_STATUSES = ['published', 'pending_human', 'refused', 'failed', 'cancelled', 'sold'] as const;
export type LinkSellStatus = typeof LINK_SELL_STATUSES[number];
/** 데스크탑 → 폰 판매 결과(데스크탑 연결 키 서명, 꼬리표 'sellresult'). id = 그 sell(또는 unsell) 의 id. */
export type LinkSellResult = { v: 1; linkId: string; id: string; status: LinkSellStatus; reason?: string; eventId?: string; d?: string; outpoint?: { txid: string; vout: number }; at: number };
/** 판매 하루 건수의 범위(데스크탑 설정 칸). 기본 3. */
export const LINK_SELL_DAILY_MIN = 1, LINK_SELL_DAILY_MAX = 20, LINK_SELL_DAILY_DEFAULT = 3;

const AMOUNT = /^(0|[1-9]\d{0,10})(\.\d{1,8})?$/, PRICE = /^(0|[1-9]\d{0,10})\.\d{8}$/, CONTROL = /\p{Cc}/u;
const keysAre = (o: object, need: string[], may: string[] = []) => Object.keys(o).every(k => need.includes(k) || may.includes(k)) && need.every(k => k in o);
const line = (s: unknown, max: number, required: boolean): s is string =>
  typeof s === 'string' && !CONTROL.test(s) && [...s].length <= max && utf8(s).length <= 1024 && (!required || s.trim().length > 0);
const imageOk = (u: unknown) => typeof u === 'string' && u.length <= 1024 && (u.startsWith('https://') || u.startsWith('ipfs://')) && !/[\s"<>\p{Cc}]/u.test(u);
/** 수량 글자 → 1e-8 단위 정수(0 이면 받지 않는다). */
export function linkAmountUnits(a: string): bigint | null {
  if (typeof a !== 'string' || !AMOUNT.test(a)) return null;
  const [w, f = ''] = a.split('.');
  const n = BigInt(w) * 100_000_000n + BigInt((f + '00000000').slice(0, 8));
  return n > 0n && n <= LINK_DAILY_SATS ? n : null;
}
/** 값 글자(8자리) → 사토시. 총발행량을 넘으면 null. */
export function linkPriceSats(p: string): bigint | null {
  if (typeof p !== 'string' || !PRICE.test(p)) return null;
  const n = BigInt(p.replace('.', ''));
  return n <= LINK_DAILY_SATS ? n : null;
}
/**
 * 팔 수 있는 자산 이름(모양만 — 진짜 있는지는 노드가 안다). 3~64자 ASCII, 첫 글자 A-Z·0-9·$,
 * 영문 소문자와 @%&*()[]{}?:- 는 고유 자산 꼬리표(# 뒤)에서만, '!' 는 맨 끝에서만(그 경우는 주인 토큰 — 따로 거절한다).
 */
export function linkSellAssetOk(name: string): boolean {
  if (typeof name !== 'string' || name.length < 3 || name.length > 64 || !/^[A-Z0-9$]/.test(name)) return false;
  const hash = name.indexOf('#');
  for (let i = 0; i < name.length; i++) {
    const c = name[i];
    if (/[A-Z0-9._/#~$]/.test(c)) continue;
    if (c === '!' && i === name.length - 1) continue;
    if (hash >= 0 && i > hash && /[a-z@%&*()[\]{}?:-]/.test(c)) continue;
    return false;
  }
  return true;
}
function sellShapeOk(b: LinkSell | undefined): b is LinkSell {
  return !!b && typeof b === 'object' && keysAre(b, ['v', 'linkId', 'id', 'asset', 'amount', 'priceRvn', 'title', 'summary', 'category', 'created', 'expires'], ['image'])
    && b.v === 1 && HEX64.test(b.linkId) && HEX64.test(b.id) && typeof b.asset === 'string' && b.asset.length >= 1 && b.asset.length <= 64
    && linkAmountUnits(b.amount) !== null && linkPriceSats(b.priceRvn) !== null && line(b.title, 100, true) && line(b.summary, 300, false)
    && (LINK_SELL_CATEGORIES as readonly string[]).includes(b.category) && (!('image' in b) || imageOk(b.image))
    && int(b.created, 1) && int(b.expires, 1) && b.expires > b.created && b.expires - b.created <= LINK_SELL_TTL_MS;
}
function unsellShapeOk(b: LinkUnsell | undefined): b is LinkUnsell {
  return !!b && typeof b === 'object' && keysAre(b, ['v', 'linkId', 'id', 'd', 'created', 'expires']) && b.v === 1 && HEX64.test(b.linkId) && HEX64.test(b.id)
    && typeof b.d === 'string' && /^rvswap:[0-9a-f]{64}:\d{1,6}$/.test(b.d)
    && int(b.created, 1) && int(b.expires, 1) && b.expires > b.created && b.expires - b.created <= LINK_SELL_TTL_MS;
}
export function signLinkSell(body: LinkSell, phoneSecret: Uint8Array): Signed<LinkSell> {
  if (!sellShapeOk(body)) throw new Error('link-sell');
  return sign('sell', body, phoneSecret);
}
export function signLinkUnsell(body: LinkUnsell, phoneSecret: Uint8Array): Signed<LinkUnsell> {
  if (!unsellShapeOk(body)) throw new Error('link-unsell');
  return sign('unsell', body, phoneSecret);
}
/** 데스크탑이 아는 그 연결의 판매 허용(없으면 꺼짐). */
export type LinkSellPolicy = { enabled: boolean; daily: number };
export type SellCheck = { ok: true; sell: LinkSell } | { ok: false; reason: 'shape' | 'revoked' | 'other-link' | 'signature' | 'future' | 'expired' | 'seen' | 'sell-off' | 'daily-count' | 'asset' | 'owner-token' | 'price' };
/**
 * 데스크탑 검사(러스트 check_sell 과 같은 순서). 이 뒤에 데스크탑은 노드에 그 자산을 그만큼 가졌는지 본다(못 가졌으면 'not-held').
 * countToday = 지난 24시간 이 연결에서 받아들인 판매 건수(거절은 세지 않는다).
 */
export function checkLinkSell(s: Signed<LinkSell>, link: LinkRecord & { sell?: LinkSellPolicy }, now: number, seen: ReadonlySet<string>, countToday: number): SellCheck {
  const b = s?.body;
  if (!sellShapeOk(b)) return { ok: false, reason: 'shape' };
  if (link.revoked) return { ok: false, reason: 'revoked' };
  if (b.linkId !== link.linkId) return { ok: false, reason: 'other-link' };
  if (!verify('sell', s, link.phoneKey)) return { ok: false, reason: 'signature' };
  if (b.created > now + 120_000) return { ok: false, reason: 'future' };
  if (b.expires < now) return { ok: false, reason: 'expired' };
  if (seen.has(b.id)) return { ok: false, reason: 'seen' };
  if (!link.sell?.enabled) return { ok: false, reason: 'sell-off' };
  if (countToday >= link.sell.daily) return { ok: false, reason: 'daily-count' };
  if (!linkSellAssetOk(b.asset)) return { ok: false, reason: 'asset' };
  if (b.asset.endsWith('!')) return { ok: false, reason: 'owner-token' };
  if ((linkPriceSats(b.priceRvn) ?? 0n) < 100_000_000n) return { ok: false, reason: 'price' };
  return { ok: true, sell: { ...b } };
}
/** 데스크탑: 받은 내리기가 이 연결·이 폰 키에 묶여 있고 서명이 맞나(만료·중복은 데스크탑 기록으로 따로 본다). */
export function verifyLinkUnsell(s: Signed<LinkUnsell>, phoneKey: string, linkIdHere: string): LinkUnsell {
  const b = s?.body;
  if (!unsellShapeOk(b) || b.linkId !== linkIdHere || !verify('unsell', s, phoneKey)) throw new Error('link-unsell');
  return { ...b };
}
function sellResultShapeOk(b: LinkSellResult | undefined): b is LinkSellResult {
  return !!b && typeof b === 'object' && keysAre(b, ['v', 'linkId', 'id', 'status', 'at'], ['reason', 'eventId', 'd', 'outpoint']) && b.v === 1 && HEX64.test(b.linkId) && HEX64.test(b.id)
    && (LINK_SELL_STATUSES as readonly string[]).includes(b.status) && int(b.at, 1)
    && (!('reason' in b) || line(b.reason, 300, true)) && (!('eventId' in b) || (typeof b.eventId === 'string' && HEX64.test(b.eventId)))
    && (!('d' in b) || (typeof b.d === 'string' && /^rvswap:[0-9a-f]{64}:\d{1,6}$/.test(b.d)))
    && (!('outpoint' in b) || (!!b.outpoint && typeof b.outpoint === 'object' && keysAre(b.outpoint, ['txid', 'vout']) && typeof b.outpoint.txid === 'string' && HEX64.test(b.outpoint.txid) && int(b.outpoint.vout)));
}
export function signLinkSellResult(body: LinkSellResult, desktopSecret: Uint8Array): Signed<LinkSellResult> {
  if (!sellResultShapeOk(body)) throw new Error('link-sellresult');
  return sign('sellresult', body, desktopSecret);
}
export function verifyLinkSellResult(s: Signed<LinkSellResult>, desktopKey: string, linkIdHere: string): LinkSellResult {
  const b = s?.body;
  if (!sellResultShapeOk(b) || b.linkId !== linkIdHere || !verify('sellresult', s, desktopKey)) throw new Error('link-sellresult');
  return { ...b, ...(b.outpoint ? { outpoint: { ...b.outpoint } } : {}) };
}
