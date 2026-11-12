/*
 * 장터 「바로 해 보는 게임」(오락실) — 데스크탑의 순수 규칙. 화면·네트워크·키 없음(시험 가능).
 *
 * 폰·웹과 같은 자료 모양·같은 규칙이다(지갑 저장소 phone/ui/arcade/product.ts · pay.ts 를 옮김 — 폰 전용 부품에 기대서 바이트 복사는 못 한다).
 *   · 상품은 판매자가 서명한 문서(rv-arcade-product v1, core/creator/arcade-product.ts)에서만 온다. 받는 주소 = 문서 payTo.
 *   · 목록 = core/creator/arcade-catalog.ts buildArcadeCatalog(체인 `RVLT/*` 자산 ↔ 문서). 「확인 판매자」 = 체인 자산이 그 문서를 가리킨다.
 *   · 예시(가짜) 상품은 데스크탑에 두지 않는다 — 올라온 게임이 없으면 「아직 올라온 게임이 없어요」(대표 지시: 가짜 대신 정직한 빈 화면).
 *   · 게임 주소 = 레이븐볼트 공유 사이트의 확인된 게임 길(/arcade/ipfs/<문서 CID>/<시작 파일>) — 사이트가 문서 sha256·크기를 맞추고
 *     게임 CSP(밖으로 연결 없음)를 붙여 내준다(폰 「링크로 연 게임」과 같은 길). 앱 창 안 iframe sandbox="allow-scripts" 로만 연다.
 *   · 결제 직전 문서를 다시 확인하고(checkArcadeDoc) 나누기는 splitPrice(1%, 올림·먼지 1000) — 러스트 arcade_pay 가 한 번 더 나눠 맞춘다.
 */
import { ARCADE_GENRES, ARCADE_GENRE_LABELS, arcadeSplit, verifyArcadeProduct, type ArcadeGenre, type ArcadeProductDoc } from "../core/creator/arcade-product";
import { buildArcadeCatalog, type ChainAssetEntry, type CatalogItem } from "../core/creator/arcade-catalog";
import { MARKET_FEE_ADDRESS } from "../core/creator/trade-primitives";

export const ARCADE_SITE = "https://ravenvault.ex.erci.se";
/** 게임 iframe 이 열 수 있는 유일한 길 — tauri.conf.json CSP frame-src 와 같아야 한다(시험). */
export const ARCADE_LINK_BASE = `${ARCADE_SITE}/arcade/ipfs/`;
export const ARCADE_FEE_ADDRESS = MARKET_FEE_ADDRESS;

export type ArcadeProduct = {
  /** 판매자 주소 + 문서 id (arcadeKeyOf). */
  id: string;
  title: string;
  description: string;
  priceSats: number;
  sellerName: string;
  sellerAddress: string;
  assetName?: string;
  verified: boolean;
  minutes: number;
  genre: ArcadeGenre;
  /** 상품 문서가 있는 CID(체인 자산의 ipfs_hash) — 게임 길·결제 기록이 이것으로 묶인다. */
  docCid: string;
  entry: string;
  /** 시작 파일이 잠긴 게임(열쇠 전달 방식 대표 결정 대기) — 아직 열 수 없다. */
  locked: boolean;
  doc: ArcadeProductDoc;
};

const shopOf = (d: ArcadeProductDoc) => d.assetName ? d.assetName.replace(/^RVLT\//, "").split(/[/#]/)[0] : `${d.seller.slice(0, 6)}…${d.seller.slice(-4)}`;

/** 목록 한 줄(서명 확인 끝) → 화면이 받는 상품. docCid 는 확인의 닻이 된 체인 자산의 IPFS 해시. */
export function productFromCatalogItem(item: CatalogItem, docCid: string): ArcadeProduct {
  const d = item.verifiedDoc.doc, price = Number(d.priceSats);
  if (!Number.isSafeInteger(price) || price < 0) throw new Error("arcade-price");
  return {
    id: item.key, title: d.title, description: d.description, priceSats: price, sellerName: shopOf(d), sellerAddress: d.payTo,
    ...(d.assetName ? { assetName: d.assetName } : {}), verified: item.verified, minutes: d.x.arcade.minutes, genre: item.genre,
    docCid, entry: d.entry, locked: !!d.lock?.paths.includes(d.entry), doc: d,
  };
}

/** base64 → 바이트(러스트 arcade_catalog_sources 의 docs 값). 틀리면 null. */
export function bytesOfBase64(b64: unknown): Uint8Array | null {
  if (typeof b64 !== "string" || b64.length > 800_000 || !/^[A-Za-z0-9+/]*={0,2}$/.test(b64)) return null;
  try { return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)); } catch { return null; }
}

/**
 * 러스트 답 { assets:[{name, ipfsHash}], docs:{cid: base64} } → 상품 목록. 답의 모양을 믿지 않는다(틀린 칸은 버린다).
 * 서명이 맞고 「문서의 assetName = 그 자산」인 것만 확인 판매자. 확인되지 않은 문서는 이 길로는 들어오지 않는다(체인 자산이 닻).
 */
export function productsFromSources(raw: unknown): { items: ArcadeProduct[]; dropped: number } {
  const r = raw && typeof raw === "object" ? raw as { assets?: unknown; docs?: unknown } : {};
  const assets: ChainAssetEntry[] = (Array.isArray(r.assets) ? r.assets : [])
    .filter((a): a is { name: string; ipfsHash?: unknown } => !!a && typeof a === "object" && typeof (a as any).name === "string")
    .map((a) => ({ name: a.name, ipfsHash: typeof a.ipfsHash === "string" ? a.ipfsHash : null }));
  const docsByCid: Record<string, Uint8Array> = {};
  if (r.docs && typeof r.docs === "object") {
    for (const [cid, b64] of Object.entries(r.docs as Record<string, unknown>)) { const b = bytesOfBase64(b64); if (b) docsByCid[cid] = b; }
  }
  const cat = buildArcadeCatalog({ assets, docsByCid });
  const cidOf = new Map<string, string>();
  for (const a of assets) if (a.ipfsHash) cidOf.set(a.name, a.ipfsHash);
  const items: ArcadeProduct[] = [];
  for (const it of cat.items) {
    const cid = it.verifiedBy ? cidOf.get(it.verifiedBy) : undefined;
    if (!cid) continue;
    try { items.push(productFromCatalogItem(it, cid)); } catch { /* 값이 틀린 문서는 그리지 않는다 */ }
  }
  return { items, dropped: cat.dropped.length };
}

/** 게임 시작 주소. 확인된 게임 길 아래의 https 주소만, 아니면 null(iframe 을 만들지 않는다). */
export function gameUrl(p: Pick<ArcadeProduct, "docCid" | "entry" | "locked">): string | null {
  if (p.locked) return null;
  if (!/^[A-Za-z0-9]{46,100}$/.test(p.docCid)) return null;
  if (!/^(?:[A-Za-z0-9_-][A-Za-z0-9._-]*\/)*[A-Za-z0-9_-][A-Za-z0-9._-]*$/.test(p.entry)) return null;
  if (p.entry.split("/").some((s) => s === "." || s === "..")) return null;
  const href = `${ARCADE_LINK_BASE}${p.docCid}/${p.entry}`;
  return href.startsWith(ARCADE_LINK_BASE) ? href : null;
}

/** 무료 게임만 결제 없이 연다. 한 판마다 내는 게임이라 「이미 산 게임」은 없다(폰과 같은 규칙, 대표 11-03). */
export const playsWithoutPay = (p: Pick<ArcadeProduct, "priceSats">) => p.priceSats === 0;

export const genreLabel = (g: ArcadeGenre): string => ARCADE_GENRE_LABELS[g];
export function genresPresent(items: readonly Pick<ArcadeProduct, "genre">[]): ArcadeGenre[] {
  const have = new Set(items.map((i) => i.genre));
  return ARCADE_GENRES.filter((g) => have.has(g));
}
export const filterByGenre = <T extends Pick<ArcadeProduct, "genre">>(items: readonly T[], g: ArcadeGenre | "all"): T[] =>
  g === "all" ? [...items] : items.filter((i) => i.genre === g);
export function filterProducts<T extends Pick<ArcadeProduct, "title" | "sellerName">>(items: readonly T[], query: string): T[] {
  const q = query.trim().toLowerCase();
  return q ? items.filter((i) => i.title.toLowerCase().includes(q) || i.sellerName.toLowerCase().includes(q)) : [...items];
}
/** 확인 판매자 먼저 → 제목(목록 정렬과 같게). */
export const sortProducts = <T extends Pick<ArcadeProduct, "verified" | "title" | "id">>(items: readonly T[]): T[] =>
  [...items].sort((a, b) => Number(b.verified) - Number(a.verified) || (a.title < b.title ? -1 : a.title > b.title ? 1 : 0) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

export class ArcadeDocError extends Error { constructor(readonly code: "no-doc" | "invalid" | "mismatch" | "free" | "split") { super(code); this.name = "ArcadeDocError"; } }
export type ArcadePayPlan = { productId: string; docCid: string; payTo: string; priceAtoms: number; sellerAtoms: number; feeAtoms: number; feeAddress: string };

/**
 * 결제 준비(앱이 준비하고 사람이 보낸다). 서명 문서를 **다시** 확인하고, 화면의 받는 곳·가격이 문서와 정확히 같을 때만 계획을 낸다.
 * 수수료 주소는 코드 고정(문서·목록에서 받지 않는다). 무료 게임은 결제 계획이 없다.
 */
export function prepareArcadePay(p: ArcadeProduct): ArcadePayPlan {
  if (!p.doc) throw new ArcadeDocError("no-doc");
  let v;
  try { v = verifyArcadeProduct(p.doc); } catch { throw new ArcadeDocError("invalid"); }
  if (v.key !== p.id || v.doc.payTo !== p.sellerAddress || v.doc.priceSats !== String(p.priceSats)) throw new ArcadeDocError("mismatch");
  const s = arcadeSplit(v);
  if (s.free) throw new ArcadeDocError("free");
  if (s.payTo !== p.sellerAddress || s.feeAddress !== ARCADE_FEE_ADDRESS || s.payTo === ARCADE_FEE_ADDRESS) throw new ArcadeDocError("split");
  const sellerAtoms = Number(s.sellerAtoms), feeAtoms = Number(s.feeAtoms);
  if (sellerAtoms + feeAtoms !== p.priceSats) throw new ArcadeDocError("split");
  return { productId: p.id, docCid: p.docCid, payTo: p.sellerAddress, priceAtoms: p.priceSats, sellerAtoms, feeAtoms, feeAddress: ARCADE_FEE_ADDRESS };
}

/** atoms → RVN 숫자(화면 글자는 amount-ui fmtRvn 이 만든다). */
export const atomsToRvn = (a: number): number => a / 100_000_000;

/*
 * 「지금 쉬는 중」 — 게임은 판매자 컴퓨터에 산다(11-13 대표). 최근 「지금 할 수 있나」 확인이 실패한 게임은 목록·페이지에 표시하고,
 * 돈을 받기 전에는 늘 다시 확인한다(표시는 참고일 뿐 결제를 막는 것은 그 자리의 확인이다).
 */
export const REST_MS = 10 * 60_000;
export type ReachLog = Map<string, { ok: boolean; at: number }>;
export function noteReach(log: ReachLog, docCid: string, ok: boolean, now: number): void {
  log.set(docCid, { ok, at: now });
  if (log.size > 500) { const first = log.keys().next().value; if (first !== undefined) log.delete(first); }
}
/** 최근(REST_MS 안) 확인이 실패했다. 확인한 적 없거나 오래됐으면 거짓(모르는 것을 쉬는 중이라 하지 않는다). */
export function isResting(log: ReachLog, docCid: string, now: number): boolean {
  const r = log.get(docCid);
  return !!r && !r.ok && now - r.at < REST_MS;
}
