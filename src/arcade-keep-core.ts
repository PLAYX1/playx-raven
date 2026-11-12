/*
 * 오락실 게임 보관 — 순수 함수(화면 글 없음 · 시험이 여기를 본다). 화면은 src/arcade-keep.ts.
 */
import { productsFromSources } from "./arcade-model";

/** 바이트 → 「0.4 MB」(소수 한 자리 · 0 이 아닌데 0.1 MB 보다 작으면 0.1 MB 로 — 「0.0 MB 보관 중」이라 말하지 않게). */
export function mbText(bytes: number): string {
  const n = Math.max(0, Number(bytes) || 0) / 1048576;
  return `${n > 0 && n < 0.1 ? "0.1" : n.toFixed(1)} MB`;
}

/**
 * 구매 화면과 같은 확인(productsFromSources → core mergeArcadeSources)을 통과한 게임 → 러스트에 넘길 [{docCid, verified, listing, key?}] (겹침 없이).
 * verified = 확인 판매자(체인 RVLT 자산 · 문서의 assetName = 그 자산) — 먼저 돕는다. 일반 판매자(listing=open)는 두 서명·docHash·CID 를 본 쪽지의 key 를 같이 넘긴다.
 * 플랫폼 숨김 목록에 오른 일반 판매자 게임은 여기서 이미 빠진다(돕지 않는다).
 */
export function shareCandidates(raw: unknown): { docCid: string; verified: boolean; listing: "verified" | "open"; key?: string }[] {
  const seen = new Set<string>();
  const out: { docCid: string; verified: boolean; listing: "verified" | "open"; key?: string }[] = [];
  for (const p of productsFromSources(raw).items) {
    if (seen.has(p.docCid)) continue;
    seen.add(p.docCid);
    const listing = p.listing === "open" ? "open" : "verified";
    out.push({ docCid: p.docCid, verified: p.verified, listing, ...(listing === "open" ? { key: p.id } : {}) });
  }
  return out;
}

/** 러스트 arcade_share_get 의 shops → 가게별 [가게, 개수, 「0.4 MB」]. 모양이 틀린 칸은 버린다. */
export function shareRows(v: unknown): [string, number, string][] {
  const shops = Array.isArray((v as any)?.shops) ? (v as any).shops : [];
  return shops.filter((s: any) => typeof s?.shop === "string" && s.shop && Number(s.games) > 0)
    .map((s: any) => [s.shop, Number(s.games), mbText(s.bytes)] as [string, number, string]);
}
