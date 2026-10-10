// 카드 카탈로그 — 홈·미니·칩·대기화면이 같은 「카드」를 크기별로 다르게 보여 주는 구조의 **고정 목록**.
// 라비(AI)가 「판매 현황 위젯 만들어줘」를 들으면 여기서 **고르고 값만 정한 제안(JSON)** 을 낸다.
// 앱은 validateLayout 으로 거르고, 사람이 미리보기를 보고 「추가」를 눌러야 반영된다.
//
// 🔴 이 파일이 막는 것
//   - 임의 HTML·스크립트·URL·스타일: 제안에는 카드 id·크기·몇 개의 열거 값만 있다. 모르는 칸은 버린다.
//   - 돈이 움직이는 카드: 카탈로그에 「보내기·서명·사기·팔기」 카드가 아예 없다(읽기 전용만).
//     돈 동작은 늘 큰 창의 명시적 확인 화면에서(docs/design/window-modes.md §AI).
//   - 가림 우회: 카드는 금액을 직접 받지 않는다 — Rust 가 가린 한 장(mini::snapshot)만 그린다.

export type CardSize = "chip" | "s" | "m" | "l" | "standby";
export type CardId = "balance" | "recent" | "sales" | "node" | "stock" | "ravi" | "clock";

type Spec = { sizes: CardSize[]; params: Record<string, readonly (string | number)[]>; seller?: boolean; ko: string; en: string };

export const CATALOG: Readonly<Record<CardId, Spec>> = Object.freeze({
  balance: { sizes: ["chip", "s", "m", "l", "standby"], params: { show: ["confirmed", "confirmed+incoming"] }, ko: "잔액", en: "Balance" },
  recent: { sizes: ["m", "l", "standby"], params: { count: [3, 5], filter: ["all", "in", "sales"] }, ko: "최근 변화", en: "Recent activity" },
  sales: { sizes: ["s", "m", "l", "standby"], params: { range: ["today", "7d"] }, seller: true, ko: "판매 현황", en: "Sales" },
  node: { sizes: ["chip", "s", "m", "l", "standby"], params: { detail: ["dot", "line"] }, ko: "노드 상태", en: "Node status" },
  stock: { sizes: ["m", "l", "standby"], params: { low_only: ["yes", "no"] }, seller: true, ko: "재고", en: "Stock" },
  ravi: { sizes: ["m", "l"], params: { mode: ["face", "face+tip"] }, ko: "라비", en: "Ravi" },
  clock: { sizes: ["l", "standby"], params: { format: ["24h", "12h"] }, ko: "시계", en: "Clock" },
});

export type CardConf = { id: CardId; size: CardSize; params: Record<string, string | number> };
export const MAX_CARDS = 8;

/** 제안을 거른다. 버린 이유를 같이 돌려준다(미리보기에 「이건 넣을 수 없어요」로). */
export function validateLayout(input: unknown, opts: { seller: boolean }): { cards: CardConf[]; dropped: string[] } {
  const dropped: string[] = [];
  const cards: CardConf[] = [];
  const arr = Array.isArray(input) ? input : (input && typeof input === "object" && Array.isArray((input as { cards?: unknown }).cards) ? (input as { cards: unknown[] }).cards : null);
  if (!arr) return { cards, dropped: ["형식이 아니에요"] };
  for (const raw of arr.slice(0, 32)) {
    if (cards.length >= MAX_CARDS) { dropped.push("카드가 너무 많아요"); break; }
    if (!raw || typeof raw !== "object") { dropped.push("빈 카드"); continue; }
    const r = raw as Record<string, unknown>;
    const id = r.id as CardId;
    const spec = Object.prototype.hasOwnProperty.call(CATALOG, id) ? CATALOG[id] : undefined;
    if (!spec) { dropped.push(`모르는 카드: ${String(r.id).slice(0, 24)}`); continue; }
    if (spec.seller && !opts.seller) { dropped.push(`${spec.ko}: 판매자 기능을 켜야 해요`); continue; }
    const size = r.size as CardSize;
    if (!spec.sizes.includes(size)) { dropped.push(`${spec.ko}: 이 크기는 없어요`); continue; }
    const params: Record<string, string | number> = {};
    const given = (r.params && typeof r.params === "object" ? r.params : {}) as Record<string, unknown>;
    for (const [k, allowed] of Object.entries(spec.params)) {
      const v = given[k];
      params[k] = allowed.includes(v as never) ? (v as string | number) : allowed[0];
    }
    for (const k of Object.keys(given)) if (!(k in spec.params)) dropped.push(`${spec.ko}: 모르는 칸 ${k.slice(0, 16)}`);
    for (const k of Object.keys(r)) if (!["id", "size", "params"].includes(k)) dropped.push(`${spec.ko}: 모르는 칸 ${k.slice(0, 16)}`);
    if (cards.some((c) => c.id === id && c.size === size)) { dropped.push(`${spec.ko}: 이미 있어요`); continue; }
    cards.push({ id, size, params });
  }
  return { cards, dropped };
}

/** 같은 카드가 크기마다 무엇을 보이나 — 정보 위계 표(문서·갤러리와 같은 내용). */
export function cardFields(id: CardId, size: CardSize): string[] {
  const t: Record<CardId, Partial<Record<CardSize, string[]>>> = {
    balance: { chip: ["dot", "amount"], s: ["dot", "amount"], m: ["amount", "incoming"], l: ["amount", "incoming", "lock"], standby: ["amount-xl", "incoming"] },
    recent: { m: ["3 rows"], l: ["4 rows", "conf"], standby: ["3 deposits", "ago"] },
    sales: { s: ["count"], m: ["count", "amount"], l: ["count", "amount", "pending"], standby: ["count-xl", "amount", "pending"] },
    node: { chip: ["dot"], s: ["dot"], m: ["line"], l: ["line", "peers", "awake"], standby: ["dot", "line"] },
    stock: { m: ["low items"], l: ["low items", "counts"], standby: ["low items"] },
    ravi: { m: ["face"], l: ["face", "tip"] },
    clock: { l: ["hh:mm"], standby: ["hh:mm-xl", "date"] },
  };
  return t[id][size] ?? [];
}
