import { ASSET_NAME_V3, checkAssetNameV3 } from './asset-name-v3';
import { ARCADE_GENRES, ArcadeProductError, arcadeGenreOf, pickNewer, verifyArcadeProduct, type ArcadeGenre, type VerifiedArcadeProduct } from './arcade-product';

/*
 * 오락실 목록 읽기 — 순수 함수. 네트워크 코드 없음: 체인 자산 목록·IPFS 에서 받은 문서·nostr 문서를 부르는 쪽이 넘긴다. (2026-11-03)
 *
 * 서버 없는 목록(대표 결정):
 *   ① 체인 `listassets RVLT/*` → 자산 이름 + IPFS 해시. 그 해시로 받은 문서가 서명이 맞고 문서의 assetName = 그 자산 이름이면 「확인됨」의 닻이 된다.
 *   ② 일반 판매자(자산 없음)는 nostr 등으로 퍼진 서명 문서만 있다 → 목록에 나오되 확인 표시 없음(verified: false).
 *   ③ 값 바꾸기 = 같은 (seller, id) 의 더 높은 version 문서. 어디서 왔든 서명만 맞으면 판이 갈린다(pickNewer).
 *      최신 판도 같은 assetName 을 들고 있어야 확인 표시가 남는다(이름을 빼거나 바꾼 판은 확인 없음 — 이유 'asset-changed').
 *
 * 🔴 자산 이름만으로는 아무것도 믿지 않는다. 남의 문서 IPFS 해시를 자기 자산에 실어도, 그 문서의 assetName 이 다르니 닻이 되지 못한다.
 *    owner(자산을 쥔 주소)를 넘겨 주면 문서 seller 와 같아야 한다(다르면 'owner-mismatch'). 넘겨 주지 않으면 이 검사는 건너뛴다.
 *
 * 장르: 항목마다 genre(문서 x.arcade.genre, 없으면 'other'). 거르기 = arcadeItemsByGenre, 칩에 보일 장르 = arcadeGenresPresent.
 */

export type ChainAssetEntry = { name: string; ipfsHash: string | null; owner?: string | null };
export type DocSource = 'chain-ipfs' | 'nostr' | 'link' | 'peer';
export type CatalogDocInput = { source: DocSource; doc: Uint8Array | unknown; cid?: string };
export type DropReason = 'not-rvlt' | 'bad-asset-name' | 'no-ipfs' | 'doc-missing' | 'doc-invalid' | 'asset-mismatch' | 'owner-mismatch' | 'older-version' | 'duplicate-anchor';
export type Dropped = { reason: DropReason; asset?: string; source?: DocSource; detail?: string };

export type CatalogItem = {
  key: string; seller: string; id: string; version: number; docHash: string; title: string; priceSats: string;
  cid: string; entry: string; assetName: string | null;
  /** 장르(문서에 없으면 'other'). */
  genre: ArcadeGenre;
  /** RVLT/* 체인 자산이 이 판매자·이 상품을 가리키고, 최신 판도 그 이름을 들고 있다. */
  verified: boolean;
  /** 확인의 근거가 된 체인 자산 이름(없으면 null). */
  verifiedBy: string | null;
  /** 확인 표시가 빠진 이유(확인됐으면 null). */
  unverifiedReason: 'no-asset' | 'asset-changed' | null;
  /** 같은 version 에 서로 다른 문서가 있었다(판매자가 두 판을 냈다). */
  conflict: boolean;
  sources: DocSource[];
  verifiedDoc: VerifiedArcadeProduct;
};
export type Catalog = { items: CatalogItem[]; dropped: Dropped[] };

const errDetail = (e: unknown) => e instanceof ArcadeProductError ? e.code : 'error';

/**
 * 목록 만들기. assets = 체인 자산 목록, docsByCid = IPFS 해시 → 받은 문서 바이트, docs = 그 밖의 서명 문서(nostr·링크·이웃 데스크탑).
 * 정렬: 확인됨 먼저 → 제목(코드 포인트 순) → key. 같은 입력이면 어느 기기에서나 같은 결과.
 */
export function buildArcadeCatalog(p: {
  assets: readonly ChainAssetEntry[]; docsByCid?: Readonly<Record<string, Uint8Array | unknown>>; docs?: readonly CatalogDocInput[];
}): Catalog {
  const dropped: Dropped[] = [];
  const anchors = new Map<string, string>(); // key → 자산 이름
  const best = new Map<string, { v: VerifiedArcadeProduct; conflict: boolean; sources: Set<DocSource> }>();

  const offer = (v: VerifiedArcadeProduct, source: DocSource) => {
    const cur = best.get(v.key);
    if (!cur) { best.set(v.key, { v, conflict: false, sources: new Set([source]) }); return; }
    cur.sources.add(source);
    const r = pickNewer(cur.v, v);
    if (v.doc.version !== cur.v.doc.version) {
      const older = r.keep === v ? cur.v : v;
      dropped.push({ reason: 'older-version', source, detail: `${older.key}@${older.doc.version}` });
      if (r.keep === v) cur.conflict = false; // 새 판이 오면 옛 판의 충돌은 의미가 없다
    } else if (r.conflict) cur.conflict = true;
    cur.v = r.keep;
  };

  const sorted = [...p.assets].sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  for (const a of sorted) {
    if (typeof a?.name !== 'string' || !a.name.startsWith(ASSET_NAME_V3.root + '/')) { dropped.push({ reason: 'not-rvlt', asset: a?.name }); continue; }
    const c = checkAssetNameV3(a.name);
    if (!c.valid || c.parsed!.kind === 'shop') { if (!c.valid) dropped.push({ reason: 'bad-asset-name', asset: a.name }); continue; }
    if (!a.ipfsHash) { dropped.push({ reason: 'no-ipfs', asset: a.name }); continue; }
    const raw = p.docsByCid?.[a.ipfsHash];
    if (raw === undefined) { dropped.push({ reason: 'doc-missing', asset: a.name }); continue; }
    let v: VerifiedArcadeProduct;
    try { v = verifyArcadeProduct(raw); } catch (e) { dropped.push({ reason: 'doc-invalid', asset: a.name, detail: errDetail(e) }); continue; }
    if (v.doc.assetName !== a.name) { dropped.push({ reason: 'asset-mismatch', asset: a.name }); continue; }
    if (a.owner != null && a.owner !== v.doc.seller) { dropped.push({ reason: 'owner-mismatch', asset: a.name }); continue; }
    if (anchors.has(v.key)) dropped.push({ reason: 'duplicate-anchor', asset: a.name, detail: anchors.get(v.key) });
    else anchors.set(v.key, a.name);
    offer(v, 'chain-ipfs');
  }
  for (const d of p.docs ?? []) {
    let v: VerifiedArcadeProduct;
    try { v = verifyArcadeProduct(d.doc); } catch (e) { dropped.push({ reason: 'doc-invalid', source: d.source, detail: errDetail(e) }); continue; }
    offer(v, d.source);
  }

  const items: CatalogItem[] = [...best.values()].map(({ v, conflict, sources }) => {
    const anchor = anchors.get(v.key) ?? null;
    const verified = anchor !== null && v.doc.assetName === anchor;
    return {
      key: v.key, seller: v.doc.seller, id: v.doc.id, version: v.doc.version, docHash: v.docHash, title: v.doc.title, priceSats: v.doc.priceSats,
      cid: v.doc.cid, entry: v.doc.entry, assetName: v.doc.assetName ?? null, genre: arcadeGenreOf(v.doc),
      verified, verifiedBy: verified ? anchor : null, unverifiedReason: verified ? null : anchor === null ? 'no-asset' : 'asset-changed',
      conflict, sources: [...sources].sort(), verifiedDoc: v,
    };
  });
  items.sort((a, b) => (a.verified === b.verified ? 0 : a.verified ? -1 : 1) || (a.title < b.title ? -1 : a.title > b.title ? 1 : 0) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return { items, dropped };
}

/** 장르로 거르기. 'all' 이면 전부(순서 그대로). */
export function arcadeItemsByGenre<T extends { genre: ArcadeGenre }>(items: readonly T[], genre: ArcadeGenre | 'all'): T[] {
  return genre === 'all' ? [...items] : items.filter(i => i.genre === genre);
}
/** 실제로 게임이 있는 장르만, 고정 목록 순서(ARCADE_GENRES)대로 — 칩 줄에 쓴다. */
export function arcadeGenresPresent(items: readonly { genre: ArcadeGenre }[]): ArcadeGenre[] {
  const have = new Set(items.map(i => i.genre));
  return ARCADE_GENRES.filter(g => have.has(g));
}
