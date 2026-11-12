/*
 * 오락실 게임 보관 — 순수 함수(화면 글 없음 · 시험이 여기를 본다). 화면은 src/arcade-keep.ts.
 */
import { productsFromSources } from "./arcade-model";

/** 바이트 → 「0.4 MB」(소수 한 자리 · 0 이 아닌데 0.1 MB 보다 작으면 0.1 MB 로 — 「0.0 MB 보관 중」이라 말하지 않게). */
export function mbText(bytes: number): string {
  const n = Math.max(0, Number(bytes) || 0) / 1048576;
  return `${n > 0 && n < 0.1 ? "0.1" : n.toFixed(1)} MB`;
}

/** 구매 화면과 같은 확인(productsFromSources: 서명 · 문서의 assetName = 그 자산)을 통과한 체인 게임 → 러스트에 넘길 [{docCid, verified}] (겹침 없이). */
export function shareCandidates(raw: unknown): { docCid: string; verified: boolean }[] {
  const seen = new Set<string>();
  const out: { docCid: string; verified: boolean }[] = [];
  for (const p of productsFromSources(raw).items) {
    if (seen.has(p.docCid)) continue;
    seen.add(p.docCid);
    out.push({ docCid: p.docCid, verified: p.verified });
  }
  return out;
}

/** 러스트 arcade_share_get 의 shops → 가게별 [가게, 개수, 「0.4 MB」]. 모양이 틀린 칸은 버린다. */
export function shareRows(v: unknown): [string, number, string][] {
  const shops = Array.isArray((v as any)?.shops) ? (v as any).shops : [];
  return shops.filter((s: any) => typeof s?.shop === "string" && s.shop && Number(s.games) > 0)
    .map((s: any) => [s.shop, Number(s.games), mbText(s.bytes)] as [string, number, string]);
}
