// 미니 창 화면 — 받은 한 장(snapshot)을 그리기만 한다. 노드·지갑을 모른다.
// 🔴 금액 가리기는 Rust(mini_feed::snapshot)가 이미 했다: 가림이면 금액 칸이 null 로 온다.
//    여기서도 null 이면 「••••」로 그린다(두 겹). 글자는 전부 textContent — HTML 로 넣지 않는다.

export type Size = "xs" | "s" | "m" | "l";
export type Recent = { dir: "in" | "out"; sale: boolean; amount: string | null; unit: string | null; conf: number; done: boolean; ago: number };
export type Notice = { kind: string; count: number; title: string; body: string };
export type Snapshot = {
  masked: boolean;
  locale: string;
  status: "ok" | "warn" | "bad";
  node: { state: string; blocks: number | null; peers: number | null; behind: number | null };
  balance: { known: boolean; confirmed: string | null; pending: string | null; has_pending: boolean };
  recent: Recent[];
  lock: string;
  awake: { holding: boolean; note: string };
  seller: null | { sales: number; sales_rvn: string | null; deposits: number; deposits_rvn: string | null; pending: number };
  unseen: number;
  need: number;
  watching?: boolean;
  notice?: Notice | null;
};
export type Settings = { size: Size; on_top: boolean; mask: boolean; capture_guard: boolean; sound: boolean; os_notify: boolean; need: number; locale: string; os_notify_supported: boolean };

export const HIDDEN = "••••";

const KO = {
  title: "레이븐볼트 미니",
  balance: "잔액",
  pending: "들어오는 중",
  unseen: (n: number) => `새 소식 ${n}`,
  noBalance: "잔액 확인 중",
  in: "입금", out: "보냄", sale: "판매",
  conf: (c: number, need: number) => (c <= 0 ? "확인 전" : c >= need ? "확인됨" : `확인 ${c}/${need}`),
  ago: (s: number) => (s < 60 ? "방금" : s < 3600 ? `${Math.floor(s / 60)}분 전` : s < 86400 ? `${Math.floor(s / 3600)}시간 전` : `${Math.floor(s / 86400)}일 전`),
  empty: "최근 변화가 없어요",
  node: {
    ok: "노드 정상", syncing: "따라잡는 중", rescanning: "지갑 되살리는 중", down: "노드 응답 없음",
    disconnected: "연결 끊김", stalled: "동기화 멈춤", unknown: "노드 확인 중",
  } as Record<string, string>,
  peers: (n: number) => `연결 ${n}곳`,
  lock: { locked: "지갑 잠김 · 감지는 계속", open: "지갑 열림", none: "지갑 암호 없음", unknown: "잠금 확인 중" } as Record<string, string>,
  awakeOn: "잠들지 않게 하는 중",
  awakeOff: "잠들 수 있음",
  today: "오늘",
  sales: (n: number, v: string | null) => `판매 ${n}건${v === null ? "" : ` · ${v} RVN`}`,
  deps: (n: number, v: string | null) => `입금 ${n}건${v === null ? "" : ` · ${v} RVN`}`,
  pendingN: (n: number) => (n > 0 ? ` · 확인 전 ${n}` : ""),
  mask: "금액 가리기", unmask: "금액 보이기", size: "크기 바꾸기 (두 번 눌러도 돼요)", main: "큰 화면 열기", close: "닫기 (트레이로)",
  expand: "눌러서 펼치기",
  onTop: "항상 위에", sound: "소리", notify: "알림", readOnly: "읽기 전용 · 보내기는 큰 화면에서",
  status: { ok: "정상", warn: "확인 중", bad: "문제 있음" } as Record<string, string>,
};
const EN: typeof KO = {
  title: "RavenVault mini",
  balance: "Balance",
  pending: "incoming",
  unseen: (n) => `${n} new`,
  noBalance: "Checking balance",
  in: "In", out: "Sent", sale: "Sale",
  conf: (c, need) => (c <= 0 ? "unconfirmed" : c >= need ? "confirmed" : `${c}/${need} conf`),
  ago: (s) => (s < 60 ? "now" : s < 3600 ? `${Math.floor(s / 60)}m ago` : s < 86400 ? `${Math.floor(s / 3600)}h ago` : `${Math.floor(s / 86400)}d ago`),
  empty: "No recent changes",
  node: { ok: "Node OK", syncing: "Catching up", rescanning: "Restoring wallet", down: "Node not responding", disconnected: "Disconnected", stalled: "Sync stalled", unknown: "Checking node" },
  peers: (n) => `${n} peers`,
  lock: { locked: "Wallet locked · still watching", open: "Wallet unlocked", none: "No wallet password", unknown: "Checking lock" },
  awakeOn: "Keeping awake",
  awakeOff: "May sleep",
  today: "Today",
  sales: (n, v) => `${n} sales${v === null ? "" : ` · ${v} RVN`}`,
  deps: (n, v) => `${n} deposits${v === null ? "" : ` · ${v} RVN`}`,
  pendingN: (n) => (n > 0 ? ` · ${n} unconfirmed` : ""),
  mask: "Hide amounts", unmask: "Show amounts", size: "Change size (or double-click)", main: "Open main window", close: "Close (to tray)",
  expand: "click to expand",
  onTop: "On top", sound: "Sound", notify: "Alerts", readOnly: "Read-only · send from the main window",
  status: { ok: "OK", warn: "Checking", bad: "Problem" },
};
export const copyFor = (locale: string) => (locale.startsWith("en") ? EN : KO);

// 칩(xs)은 두 번 누르면 한 줄(S)로 펼친다 — 순환은 S→M→L→S (Rust mini::next_size 와 같다).
export const nextSize = (s: Size): Size => (s === "xs" ? "s" : s === "s" ? "m" : s === "m" ? "l" : "s");

const money = (v: string | null, unit = "RVN") => (v === null ? HIDDEN : `${v} ${unit}`);

/** 한 줄 막대(S)·머리줄의 글. 새 소식이 있으면 S 에서는 그게 먼저다. */
export function headline(snap: Snapshot, size: Size): string {
  const c = copyFor(snap.locale);
  if ((size === "s" || size === "xs") && snap.unseen > 0) return c.unseen(snap.unseen);
  if (!snap.balance.known) return c.noBalance;
  return money(snap.balance.confirmed);
}

export function recentLine(r: Recent, snap: Snapshot): { label: string; amount: string; meta: string } {
  const c = copyFor(snap.locale);
  const amount = r.amount === null ? HIDDEN : `${r.amount} ${r.unit ?? ""}`.trim();
  return { label: r.sale ? c.sale : r.dir === "in" ? c.in : c.out, amount, meta: `${r.dir === "in" ? c.conf(r.conf, snap.need) + " · " : ""}${c.ago(r.ago)}` };
}

export function nodeLine(snap: Snapshot): string {
  const c = copyFor(snap.locale);
  const base = c.node[snap.node.state] ?? c.node.unknown;
  return snap.node.peers !== null && snap.node.state !== "down" ? `${base} · ${c.peers(snap.node.peers)}` : base;
}

export function sellerLines(snap: Snapshot): string[] | null {
  if (!snap.seller) return null;
  const c = copyFor(snap.locale);
  const s = snap.seller;
  return [c.sales(s.sales, s.sales_rvn), c.deps(s.deposits, s.deposits_rvn) + c.pendingN(s.pending)];
}

const $ = (id: string) => document.getElementById(id)!;
const text = (id: string, v: string) => { const el = $(id); if (el.textContent !== v) el.textContent = v; };

/** 한 장을 화면에 그린다(같은 값이면 안 건드린다 — 깜박임 없음). */
export function render(snap: Snapshot, st: Settings) {
  const c = copyFor(snap.locale);
  const root = $("mini");
  root.dataset.size = st.size;
  root.dataset.status = snap.status;
  document.documentElement.lang = snap.locale.startsWith("en") ? "en" : "ko";
  $("dot").setAttribute("aria-label", c.status[snap.status] ?? "");
  $("dot").setAttribute("title", nodeLine(snap));
  text("headline", headline(snap, st.size));
  $("headline").classList.toggle("is-hidden", snap.masked);
  $("headline").setAttribute("aria-label", `${c.balance}: ${headline(snap, st.size)}${st.size === "xs" ? ` · ${c.expand}` : ""}`);
  text("pending", snap.balance.has_pending ? `${c.pending} ${money(snap.balance.pending)}` : "");
  $("pending").hidden = !snap.balance.has_pending || st.size === "s" || st.size === "xs";

  const mask = $("mask");
  mask.setAttribute("aria-pressed", String(snap.masked));
  mask.setAttribute("aria-label", snap.masked ? c.unmask : c.mask);
  mask.title = snap.masked ? c.unmask : c.mask;
  for (const [id, label] of [["size", c.size], ["open-main", c.main], ["close", c.close]] as const) { $(id).setAttribute("aria-label", label); $(id).title = label; }
  text("size-label", st.size.toUpperCase());

  const list = $("recent");
  // L 은 4건, 판매 요약이 들어가면 자리를 내주고 3건.
  const rows = snap.recent.slice(0, st.size === "l" && !snap.seller ? 4 : 3);
  list.replaceChildren(...(rows.length ? rows.map((r) => {
    const li = document.createElement("li");
    const l = recentLine(r, snap);
    li.className = `row ${r.dir}${r.sale ? " sale" : ""}`;
    const a = document.createElement("span"); a.className = "k"; a.textContent = l.label;
    const b = document.createElement("span"); b.className = "v"; b.textContent = l.amount;
    const m = document.createElement("span"); m.className = "m"; m.textContent = l.meta;
    li.append(a, b, m);
    return li;
  }) : [Object.assign(document.createElement("li"), { className: "row empty", textContent: c.empty })]));

  text("node", nodeLine(snap));
  text("lockline", c.lock[snap.lock] ?? c.lock.unknown);
  text("awake", snap.awake.holding ? c.awakeOn : snap.awake.note || c.awakeOff);
  const sl = sellerLines(snap);
  $("seller").hidden = !sl;
  if (sl) { text("seller-title", c.today); text("sales", sl[0]); text("deps", sl[1]); }
  text("readonly", c.readOnly);
  for (const [id, label, on, show] of [["opt-top", c.onTop, st.on_top, true], ["opt-sound", c.sound, st.sound, true], ["opt-notify", c.notify, st.os_notify, st.os_notify_supported]] as const) {
    const input = $(id) as HTMLInputElement;
    input.checked = on;
    text(`${id}-label`, label);
    ($(id).closest("label") as HTMLElement).hidden = !show;
  }
}

/** 알림 한 장 — 미니 창 안 띠. S 에서는 머리줄 자리에 제목만. */
export function showNotice(n: Notice | null, size: Size) {
  const box = $("notice");
  if (!n) { box.hidden = true; document.body.classList.remove("has-notice"); return; }
  text("notice-title", n.title);
  text("notice-body", size === "s" || size === "xs" ? "" : n.body);
  box.hidden = false;
  document.body.classList.add("has-notice");
}
