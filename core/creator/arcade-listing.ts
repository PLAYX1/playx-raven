import { schnorr } from '@noble/curves/secp256k1';
import { sha256 } from '@noble/hashes/sha256';
import { hex, plain, utf8, type Loose } from './bytes';
import { isRvnAddress } from './trade-primitives';
import { ArcadeProductError, arcadeGenreOf, recoverArcadeSigner, verifyArcadeProduct, type ArcadeGenre, type VerifiedArcadeProduct } from './arcade-product';
import { buildArcadeCatalog, type ChainAssetEntry } from './arcade-catalog';
import { signMessageWithKeyForTest } from '../signer/test-key';

/*
 * 오락실 「일반 판매자」 올리기(open listing) — Nostr 알림 쪽지 rv.arcade-listing/1 (kind 31405) + 두 출처 합치기. 순수 함수만. (2026-11-13, 대표 승인)
 *
 * 대표 결정: 누구나 0 RVN 으로 게임을 올린다(체인 자산 없이). RVLT/<가게> 자산을 가진 가게는 「확인 판매자」, 나머지는 「일반 판매자」.
 *
 * 상품 문서는 그대로 rv-arcade-product v1 (arcade-product.ts) — assetName 칸이 없으면 일반 판매자 문서다.
 *   🔴 문서에 새 칸(listing:'open' 등)을 더하지 않은 까닭: v1 검사는 모르는 칸을 거절한다(엄격). 칸을 더하면 이미 나간 폰·데스크탑이
 *      새 문서를 전부 「틀린 문서」로 버린다. assetName 이 이미 선택 칸이라 「없음 = 일반」이 옛 앱과도 그대로 맞는다.
 *   새로 판(version)이 붙는 것은 이 알림 쪽지(rv.arcade-listing/1)다.
 *
 * 알림 쪽지(Nostr kind 31405, 매개변수 교체형 — 같은 d 를 다시 올리면 바뀐다):
 *   tags    = [["d", "<seller>/<id>"], ["t", "ravenvault-arcade"]]
 *   content = JSON { kind:'rv.arcade-listing/1', seller, id, version, docCid, docHash, at, state:'open'|'removed', signature }
 *   signature = 판매자 주소의 레이븐 메시지 서명(노드 signmessage 와 같은 65바이트 복구형 base64) — 문구:
 *     JSON.stringify(['rv.arcade-listing/1', seller, id, version, docCid, docHash, at, state, <겉봉투 pubkey>])
 *   · 두 겹 서명(가게 링크 쪽지 31404 와 같은 생각): 겉봉투 BIP340(Nostr) + 안쪽 판매자 주소 서명. 안쪽 문구에 겉봉투 pubkey 가 들어가
 *     남이 같은 쪽지를 다른 열쇠로 다시 싸도 서명이 맞지 않는다.
 *   · 문서와 묶임: docHash = arcadeDocHash(문서 본문), version = 문서 version, seller/id = 문서 seller/id. 하나라도 다르면 버린다.
 *   · 고치기 = 같은 d 로 더 높은 version 문서를 가리키는 새 쪽지. 내리기 = state:'removed' 쪽지(+ 데스크탑은 NIP-09 지우기도 보낸다).
 *   · 같은 (seller,id) 쪽지가 여럿이면 at 이 큰 것. 같은 at 이면 removed 가 이긴다(내린 것을 옛 쪽지로 되살리지 못하게). 그다음 이벤트 id 작은 것.
 *
 * 숨김 목록(rv-arcade-hidden v1) — 플랫폼이 관리하고 사이트가 내준다(읽기 전용). 일반 판매자 게임에만 쓴다(확인 판매자는 체인이 닻).
 *   { format:'rv-arcade-hidden', v:1, updatedAt:<ISO>, games:['R…/<id>'…], sellers:['R…'…], docs:['<문서 CID>'…] }
 */

export const ARCADE_LISTING_KIND = 31405;
export const ARCADE_LISTING_TAG = 'ravenvault-arcade';
export const ARCADE_LISTING_FORMAT = 'rv.arcade-listing/1';
export const ARCADE_HIDDEN_FORMAT = 'rv-arcade-hidden';
export const ARCADE_LISTING_LIMITS = Object.freeze({
  /** 한 번에 살펴볼 쪽지 수 · 목록에 둘 일반 판매자 게임 수 · 쪽지 content 크기 · 숨김 목록 칸 수. */
  events: 300, open: 100, contentBytes: 4096, hiddenEntries: 5000,
});

export type ArcadeListingState = 'open' | 'removed';
export type ArcadeListingFields = { seller: string; id: string; version: number; docCid: string; docHash: string; at: number; state: ArcadeListingState };
export type ArcadeListing = ArcadeListingFields & { key: string; nostrPubkey: string; eventId: string };
export type NostrEventLike = { id: string; pubkey: string; created_at: number; kind: number; tags: string[][]; content: string; sig: string };

const ID = /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/;
const HEX64 = /^[a-f0-9]{64}$/;
const CID = /^(Qm[1-9A-HJ-NP-Za-km-z]{44}|b[a-z2-7]{58})$/;
const SIG = /^[A-Za-z0-9+/]{86}[A-Za-z0-9+/=]{2}$/;
const LONE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const unhex = (s: string) => Uint8Array.from(s.match(/../g) ?? [], b => parseInt(b, 16));
const keysAre = (o: Record<string, Loose>, keys: string) => Object.keys(o).sort().join() === keys.split(',').sort().join();

export const arcadeListingD = (seller: string, id: string): string => `${seller}/${id}`;
export const arcadeListingTags = (seller: string, id: string): string[][] => [['d', arcadeListingD(seller, id)], ['t', ARCADE_LISTING_TAG]];

/** 안쪽 서명 문구. nostrPubkey = 겉봉투를 쌀 열쇠의 x-only 공개키(64 hex). */
export function arcadeListingMessage(f: ArcadeListingFields, nostrPubkey: string): string {
  return JSON.stringify([ARCADE_LISTING_FORMAT, f.seller, f.id, f.version, f.docCid, f.docHash, f.at, f.state, nostrPubkey]);
}

/** 모양 검사(서명은 보지 않는다). 맞으면 null, 틀리면 이유. */
export function arcadeListingProblem(f: Partial<ArcadeListingFields>): string | null {
  if (!isRvnAddress(f.seller)) return 'seller';
  if (typeof f.id !== 'string' || !ID.test(f.id)) return 'id';
  if (!Number.isSafeInteger(f.version) || (f.version as number) < 1 || (f.version as number) > 1_000_000_000) return 'version';
  if (typeof f.docCid !== 'string' || !CID.test(f.docCid)) return 'doc-cid';
  if (typeof f.docHash !== 'string' || !HEX64.test(f.docHash)) return 'doc-hash';
  if (!Number.isSafeInteger(f.at) || (f.at as number) < 1_600_000_000) return 'at';
  if (f.state !== 'open' && f.state !== 'removed') return 'state';
  return null;
}

/** 쪽지 content(키 순서 고정 — 데스크탑 러스트 arcade_listing.rs 와 같다). */
export function arcadeListingContent(f: ArcadeListingFields, signature: string): string {
  const p = arcadeListingProblem(f);
  if (p) throw new ArcadeProductError('arcade-shape', `listing-${p}`);
  return JSON.stringify({ kind: ARCADE_LISTING_FORMAT, seller: f.seller, id: f.id, version: f.version, docCid: f.docCid, docHash: f.docHash, at: f.at, state: f.state, signature });
}

/** NIP-01 이벤트 id. */
export const nostrEventIdOf = (e: Omit<NostrEventLike, 'id' | 'sig'>): string => hex(sha256(utf8(JSON.stringify([0, e.pubkey, e.created_at, e.kind, e.tags, e.content]))));

/** 겉봉투 모양·id·BIP340 서명. 맞으면 깨끗한 사본, 아니면 null. */
export function checkNostrEnvelope(raw: unknown): NostrEventLike | null {
  if (!plain(raw)) return null;
  const e = raw as Loose;
  if (typeof e.id !== 'string' || !HEX64.test(e.id) || typeof e.pubkey !== 'string' || !HEX64.test(e.pubkey) || typeof e.sig !== 'string' || !/^[a-f0-9]{128}$/.test(e.sig)) return null;
  if (!Number.isSafeInteger(e.kind) || !Number.isSafeInteger(e.created_at) || e.created_at < 0 || typeof e.content !== 'string' || !Array.isArray(e.tags) || e.tags.length > 16) return null;
  if (e.content.length > ARCADE_LISTING_LIMITS.contentBytes || LONE.test(e.content)) return null;
  if (e.tags.some((t: unknown) => !Array.isArray(t) || t.length < 1 || t.length > 8 || t.some(x => typeof x !== 'string' || x.length > 256 || LONE.test(x)))) return null;
  const clean: NostrEventLike = { id: e.id, pubkey: e.pubkey, created_at: e.created_at, kind: e.kind, tags: e.tags.map((t: string[]) => [...t]), content: e.content, sig: e.sig };
  if (nostrEventIdOf(clean) !== clean.id) return null;
  try { return schnorr.verify(unhex(clean.sig), unhex(clean.id), unhex(clean.pubkey)) ? clean : null; } catch { return null; }
}

/**
 * 받은 이벤트 하나 → 알림 쪽지. 겉봉투·종류·태그·모양·안쪽 판매자 서명 중 하나라도 틀리면 null(조용히 버린다).
 * now 보다 10분 넘게 앞선 시각은 버린다(미래 시각으로 다른 쪽지를 영원히 이기지 못하게).
 */
export function parseArcadeListingEvent(raw: unknown, now = Math.floor(Date.now() / 1000)): ArcadeListing | null {
  const e = checkNostrEnvelope(raw);
  if (!e || e.kind !== ARCADE_LISTING_KIND || !e.tags.some(t => t[0] === 't' && t[1] === ARCADE_LISTING_TAG)) return null;
  let c: Loose;
  try { c = JSON.parse(e.content); } catch { return null; }
  if (!plain(c) || !keysAre(c, 'kind,seller,id,version,docCid,docHash,at,state,signature') || c.kind !== ARCADE_LISTING_FORMAT) return null;
  const f: ArcadeListingFields = { seller: c.seller, id: c.id, version: c.version, docCid: c.docCid, docHash: c.docHash, at: c.at, state: c.state };
  if (arcadeListingProblem(f) || f.at > now + 600) return null;
  const ds = e.tags.filter(t => t[0] === 'd');
  if (ds.length !== 1 || ds[0][1] !== arcadeListingD(f.seller, f.id)) return null;
  if (typeof c.signature !== 'string' || !SIG.test(c.signature)) return null;
  if (recoverArcadeSigner(arcadeListingMessage(f, e.pubkey), c.signature) !== f.seller) return null;
  return { ...f, key: arcadeListingD(f.seller, f.id), nostrPubkey: e.pubkey, eventId: e.id };
}

/** 같은 (seller,id) 끼리 하나로: at 큰 것 → 같으면 removed → 이벤트 id 작은 것. 결과는 key 순. */
export function pickArcadeListings(raws: readonly unknown[], now = Math.floor(Date.now() / 1000)): ArcadeListing[] {
  const best = new Map<string, ArcadeListing>();
  const seen = new Set<string>();
  for (const raw of raws.slice(0, ARCADE_LISTING_LIMITS.events)) {
    const l = parseArcadeListingEvent(raw, now);
    if (!l || seen.has(l.eventId)) continue;
    seen.add(l.eventId);
    const cur = best.get(l.key);
    const wins = !cur || l.at > cur.at || (l.at === cur.at && (l.state === 'removed' && cur.state === 'open' || (l.state === cur.state && l.eventId < cur.eventId)));
    if (wins) best.set(l.key, l);
  }
  return [...best.values()].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

/* ── 숨김 목록 ─────────────────────────────────────────────────────── */

export type ArcadeHidden = { ok: boolean; updatedAt: string | null; games: ReadonlySet<string>; sellers: ReadonlySet<string>; docs: ReadonlySet<string> };
export const EMPTY_ARCADE_HIDDEN: ArcadeHidden = Object.freeze({ ok: false, updatedAt: null, games: new Set<string>(), sellers: new Set<string>(), docs: new Set<string>() });

/** 사이트가 내준 숨김 목록. 모양이 틀리면 빈 목록(ok:false) — 목록을 못 읽었다고 게임을 다 숨기지는 않는다. 틀린 칸 하나는 그 칸만 버린다. */
export function parseArcadeHidden(raw: unknown): ArcadeHidden {
  if (!plain(raw) || raw.format !== ARCADE_HIDDEN_FORMAT || raw.v !== 1) return EMPTY_ARCADE_HIDDEN;
  const list = (v: unknown, ok: (s: string) => boolean) => new Set((Array.isArray(v) ? v : []).slice(0, ARCADE_LISTING_LIMITS.hiddenEntries).filter((s): s is string => typeof s === 'string' && ok(s)));
  return {
    ok: true, updatedAt: typeof raw.updatedAt === 'string' && raw.updatedAt.length <= 40 ? raw.updatedAt : null,
    games: list(raw.games, s => { const i = s.lastIndexOf('/'); return i > 0 && isRvnAddress(s.slice(0, i)) && ID.test(s.slice(i + 1)); }),
    sellers: list(raw.sellers, s => isRvnAddress(s)),
    docs: list(raw.docs, s => CID.test(s)),
  };
}
export const isArcadeHidden = (h: ArcadeHidden, x: { key: string; seller: string; docCid: string }): boolean =>
  h.games.has(x.key) || h.sellers.has(x.seller) || h.docs.has(x.docCid);

/* ── 두 출처 합치기 ────────────────────────────────────────────────── */

export type ArcadeSourceItem = {
  key: string; seller: string; id: string; version: number; title: string; priceSats: string; genre: ArcadeGenre; entry: string;
  /** true = 확인 판매자(체인 RVLT/* 자산이 이 문서를 가리킨다) · false = 일반 판매자(Nostr 알림 쪽지). */
  verified: boolean;
  listing: 'verified' | 'open';
  /** 상품 문서 CID — 게임 길(/arcade/ipfs/<docCid>/…)·결제 기록이 이것으로 묶인다. */
  docCid: string;
  /** 확인 판매자면 닻 자산 이름. */
  verifiedBy: string | null;
  /** 일반 판매자면 알림 쪽지 시각(초). */
  listedAt: number | null;
  verifiedDoc: VerifiedArcadeProduct;
};
export type ArcadeSourceDrop = { reason: 'duplicate-verified' | 'hidden' | 'doc-missing' | 'cid-mismatch' | 'doc-invalid' | 'listing-mismatch' | 'over-cap'; key?: string; detail?: string };
export type ArcadeSources = { items: ArcadeSourceItem[]; removed: string[]; dropped: ArcadeSourceDrop[]; verifiedCount: number; openCount: number };

const byTitle = (a: ArcadeSourceItem, b: ArcadeSourceItem) => (a.title < b.title ? -1 : a.title > b.title ? 1 : 0) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);

/**
 * 오락실 목록 = (a) 확인 판매자: 체인 RVLT/* 자산 → 문서(기존 buildArcadeCatalog) + (b) 일반 판매자: Nostr 알림 쪽지 → 문서.
 * 같은 (seller,id) 가 둘 다 있으면 확인 판매자 하나만. 순서 = 확인 판매자(제목 순) → 일반 판매자(제목 순). 같은 입력 = 어느 기기에서나 같은 답.
 * 숨김 목록은 (b) 에만. cidMatches(선택) = 받은 문서 바이트가 그 CID 블록인지(arcade-cid bytesMatchCid) — 넘기면 다르면 버린다.
 * 🔴 오락실 게임 지키기·이웃 도우미도 이 함수를 쓴다: verified 로 순서를 정한다(코드는 그쪽 몫).
 */
export function mergeArcadeSources(p: {
  assets: readonly ChainAssetEntry[]; docsByCid?: Readonly<Record<string, Uint8Array | unknown>>;
  listings?: readonly unknown[]; listingDocs?: Readonly<Record<string, Uint8Array | unknown>>;
  hidden?: ArcadeHidden; now?: number; maxOpen?: number; cidMatches?: (bytes: Uint8Array, cid: string) => boolean;
}): ArcadeSources {
  const dropped: ArcadeSourceDrop[] = [];
  const cat = buildArcadeCatalog({ assets: p.assets, docsByCid: p.docsByCid });
  const cidOf = new Map<string, string>();
  for (const a of p.assets) if (a?.ipfsHash) cidOf.set(a.name, a.ipfsHash);
  const verified: ArcadeSourceItem[] = [];
  for (const it of cat.items) {
    const cid = it.verified && it.verifiedBy ? cidOf.get(it.verifiedBy) : undefined;
    if (!cid) continue;
    verified.push({ key: it.key, seller: it.seller, id: it.id, version: it.version, title: it.title, priceSats: it.priceSats, genre: it.genre, entry: it.entry,
      verified: true, listing: 'verified', docCid: cid, verifiedBy: it.verifiedBy, listedAt: null, verifiedDoc: it.verifiedDoc });
  }
  const known = new Set(verified.map(v => v.key));
  const hidden = p.hidden ?? EMPTY_ARCADE_HIDDEN;
  const cap = Math.max(0, Math.min(p.maxOpen ?? ARCADE_LISTING_LIMITS.open, ARCADE_LISTING_LIMITS.open));
  const picked = pickArcadeListings(p.listings ?? [], p.now ?? Math.floor(Date.now() / 1000));
  const removed = picked.filter(l => l.state === 'removed').map(l => l.key);
  const open: ArcadeSourceItem[] = [];
  for (const l of picked.filter(x => x.state === 'open').sort((a, b) => b.at - a.at || (a.key < b.key ? -1 : 1))) {
    if (known.has(l.key)) { dropped.push({ reason: 'duplicate-verified', key: l.key }); continue; }
    if (isArcadeHidden(hidden, l)) { dropped.push({ reason: 'hidden', key: l.key }); continue; }
    if (open.length >= cap) { dropped.push({ reason: 'over-cap', key: l.key }); continue; }
    const raw = p.listingDocs?.[l.docCid];
    if (raw === undefined) { dropped.push({ reason: 'doc-missing', key: l.key }); continue; }
    if (p.cidMatches && raw instanceof Uint8Array && !p.cidMatches(raw, l.docCid)) { dropped.push({ reason: 'cid-mismatch', key: l.key }); continue; }
    let v: VerifiedArcadeProduct;
    try { v = verifyArcadeProduct(raw); } catch (e) { dropped.push({ reason: 'doc-invalid', key: l.key, detail: e instanceof ArcadeProductError ? e.code : 'error' }); continue; }
    if (v.key !== l.key || v.doc.version !== l.version || v.docHash !== l.docHash) { dropped.push({ reason: 'listing-mismatch', key: l.key }); continue; }
    open.push({ key: v.key, seller: v.doc.seller, id: v.doc.id, version: v.doc.version, title: v.doc.title, priceSats: v.doc.priceSats, genre: arcadeGenreOf(v.doc), entry: v.doc.entry,
      verified: false, listing: 'open', docCid: l.docCid, verifiedBy: null, listedAt: l.at, verifiedDoc: v });
  }
  verified.sort(byTitle); open.sort(byTitle);
  return { items: [...verified, ...open], removed, dropped, verifiedCount: verified.length, openCount: open.length };
}

/* ── 시험·도구 전용 ───────────────────────────────────────────────── */

/** 던져 버리는 키로 알림 쪽지 전체(겉봉투까지)를 만든다. 실제 앱은 데스크탑 러스트가 겉봉투를, 노드 signmessage 가 안쪽을 서명한다. */
export function signArcadeListingForTest(f: ArcadeListingFields, rvnKey: Uint8Array, nostrKey: Uint8Array, createdAt = f.at): NostrEventLike {
  const pubkey = hex(schnorr.getPublicKey(nostrKey));
  const content = arcadeListingContent(f, signMessageWithKeyForTest(arcadeListingMessage(f, pubkey), rvnKey));
  const unsigned = { pubkey, created_at: createdAt, kind: ARCADE_LISTING_KIND, tags: arcadeListingTags(f.seller, f.id), content };
  const id = nostrEventIdOf(unsigned);
  return { ...unsigned, id, sig: hex(schnorr.sign(unhex(id), nostrKey)) };
}
