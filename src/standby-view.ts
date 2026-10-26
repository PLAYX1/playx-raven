// 대기화면 그리기 — 받은 한 장(mini::snapshot, Rust 에서 가림)만 그린다. 노드·지갑을 모른다.
// 글자는 전부 textContent. 금액이 null 이면 ••••(두 겹 가림).
import { HIDDEN, copyFor as miniCopy, nodeLine, type Snapshot } from "./mini-view";

export type StandbySettings = { dim_from: number; dim_to: number; shift: boolean; locale: string };

const KO = {
  balance: "잔액", incoming: (v: string) => `들어오는 중 ${v}`, recent: "최근 입금", seller: "오늘 판매",
  sales: (n: number) => `${n}건`, salesAmt: (v: string | null) => (v === null ? "" : `${v} RVN`),
  deps: (n: number, p: number) => `입금 ${n}건${p > 0 ? ` · 확인 전 ${p}` : ""}`,
  empty: "최근 입금이 없어요", hint: "아무 키나 누르면 돌아가요 · 읽기 전용", masked: "금액 가림",
};
const EN: typeof KO = {
  balance: "Balance", incoming: (v) => `incoming ${v}`, recent: "Recent deposits", seller: "Sales today",
  sales: (n) => `${n} sales`, salesAmt: (v) => (v === null ? "" : `${v} RVN`),
  deps: (n, p) => `${n} deposits${p > 0 ? ` · ${p} unconfirmed` : ""}`,
  empty: "No recent deposits", hint: "Press any key to return · read-only", masked: "amounts hidden",
};
export const standbyCopy = (l: string) => (l.startsWith("en") ? EN : KO);

/** 밤 시간인가 — Rust display_mode::dim_now 와 같은 규칙(시험이 묶는다). */
export function dimNow(hour: number, from: number, to: number): boolean {
  if (from === to) return false;
  return from < to ? hour >= from && hour < to : hour >= from || hour < to;
}

/** 번인 방지 이동 — Rust display_mode::shift_for 와 같은 식(분마다 결정적, -max..max px). */
export function shiftFor(minute: number, max: number): [number, number] {
  if (max <= 0) return [0, 0];
  const span = BigInt(2 * max + 1);
  const m = ((BigInt(minute) * 2654435761n) % (span * span) + span * span) % (span * span);
  return [Number(m % span) - max, Number(m / span) - max];
}

export function clockText(d: Date, locale: string): { time: string; date: string } {
  const hh = String(d.getHours()).padStart(2, "0"), mm = String(d.getMinutes()).padStart(2, "0");
  const date = d.toLocaleDateString(locale.startsWith("en") ? "en-US" : "ko-KR", { month: "long", day: "numeric", weekday: "long" });
  return { time: `${hh}:${mm}`, date };
}

const $ = (id: string) => document.getElementById(id)!;
const text = (id: string, v: string) => { const el = $(id); if (el.textContent !== v) el.textContent = v; };

export function render(snap: Snapshot, st: StandbySettings) {
  const c = standbyCopy(st.locale), mc = miniCopy(snap.locale);
  const root = $("sb");
  root.dataset.status = snap.status;
  document.documentElement.lang = st.locale.startsWith("en") ? "en" : "ko";
  text("sb-bal-label", snap.masked ? `${c.balance} · ${c.masked}` : c.balance);
  const bal = snap.balance.known ? (snap.balance.confirmed === null ? HIDDEN : `${snap.balance.confirmed} RVN`) : mc.noBalance;
  text("sb-balance", bal);
  $("sb-balance").classList.toggle("masked", snap.balance.confirmed === null);
  $("sb-incoming").hidden = !snap.balance.has_pending;
  text("sb-incoming", c.incoming(snap.balance.pending === null ? HIDDEN : `${snap.balance.pending} RVN`));
  text("sb-recent-title", c.recent);
  const deposits = snap.recent.filter((r) => r.dir === "in").slice(0, 3);
  $("sb-recent").replaceChildren(...(deposits.length ? deposits.map((r) => {
    const li = document.createElement("li");
    const k = document.createElement("span"); k.className = "k"; k.textContent = r.sale ? mc.sale : mc.in;
    const v = document.createElement("span"); v.className = "v"; v.textContent = r.amount === null ? HIDDEN : `${r.amount} ${r.unit ?? ""}`.trim();
    const m = document.createElement("span"); m.className = "m"; m.textContent = `${mc.conf(r.conf, snap.need)} · ${mc.ago(r.ago)}`;
    li.append(k, v, m); return li;
  }) : [Object.assign(document.createElement("li"), { className: "empty", textContent: c.empty })]));
  $("sb-seller").hidden = !snap.seller;
  if (snap.seller) {
    text("sb-seller-title", c.seller);
    text("sb-sales", `${c.sales(snap.seller.sales)}${snap.seller.sales_rvn === null ? "" : ` · ${c.salesAmt(snap.seller.sales_rvn)}`}`);
    text("sb-deps", c.deps(snap.seller.deposits, snap.seller.pending));
  }
  text("sb-node-text", nodeLine(snap));
  text("sb-hint", c.hint);
}

/** 1분마다: 시계·날짜, 밤 흐림, 위치 이동. */
export function tick(now: Date, st: StandbySettings) {
  const { time, date } = clockText(now, st.locale);
  text("sb-clock", time);
  text("sb-date", date);
  $("sb-clock").setAttribute("datetime", now.toISOString());
  $("sb").dataset.dim = String(dimNow(now.getHours(), st.dim_from, st.dim_to));
  const [x, y] = st.shift ? shiftFor(Math.floor(now.getTime() / 60000), 24) : [0, 0];
  moveStage(x, y);
}

let moving: Animation | null = null;
/** 묶음을 옮긴다 — Web Animations(style 속성을 안 남김 → Tauri nonce CSP 와 무관). 지금 자리에서 출발(중단 가능),
 *  천천히(1.6s ease-in-out — 눈에 띄지 않게), 움직임 줄이기면 즉시. */
function moveStage(x: number, y: number) {
  const stage = $("sb-stage");
  const to = `translate(${x}px, ${y}px)`;
  const from = getComputedStyle(stage).transform;
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const next = stage.animate([{ transform: from === "none" ? "translate(0px, 0px)" : from }, { transform: to }], { duration: reduce ? 0 : 1600, easing: "cubic-bezier(.77,0,.175,1)", fill: "forwards" });
  moving?.cancel();
  moving = next;
  stage.dataset.shift = `${x},${y}`;
}
