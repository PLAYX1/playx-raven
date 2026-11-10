/* 체인 POS ③ — 「체인 매장」 카드 안의 매출 보내기(매장)·매출 합계(본점) (docs/CHAIN-POS.md).
 *
 *  - 매장 PC: 본점 주소 칸 + 「지금 보내기」 + 마지막 보낸 때 · 안 보낸 기록 수 · 「본점과 연결 안 됨」. 10분마다는 러스트가 알아서 보낸다.
 *  - 본점 PC: 「○○점 꺼짐」(30분째 안 옴) · 오늘/이번 달 합계(체인 전체 · 사업자별 · 매장별, 결제 방법별) · 거절한 요청.
 *    합계는 본점이 받은 기록에서 직접 센다(매장이 보낸 합계는 없다). 취소 기록은 빠진다.
 *
 * 70대 기준: 글자 16px 이상, 단추 48px 이상, 말 적게. 사용자가 적은 매장 이름·주소는 번역하지 않는다(translate="no").
 */
import { DICT } from "./dict";
import { t, tf, setCopyText } from "./i18n";
import { CHAIN_SALES_COPY } from "./chain-sales-copy";

for (const [source, values] of Object.entries(CHAIN_SALES_COPY)) {
  (["en", "ja", "zh"] as const).forEach((language, index) => { DICT[language][source] ??= values[index]; });
}

type Invoke = <T = any>(name: string, args?: Record<string, unknown>) => Promise<T>;
export interface ChainSalesDeps {
  invoke: Invoke;
  errText(e: unknown): string;
  /** 잠김(12단어 필요)이면 「지갑 열기」를 붙이고 다시 시도하게 하는 쪽(chain-store.ts fail). */
  fail(e: unknown, retry: () => Promise<unknown>): void;
}

type Sum = { net: number; count: number; methods: Record<string, number> };
type StoreRow = { store: number; name: string; biz: { no?: string; sub?: string } | null; revoked: boolean; today: Sum; month: Sum;
  lastSeen: number | null; offline: boolean; misses: number; warn: { why: string; at: number } | null };
type Totals = { stores: StoreRow[]; all: { today: Sum; month: Sum }; biz: { no: string; subs: string[]; stores: number[]; today: Sum; month: Sum }[] };

const METHODS: [string, string][] = [["card", "카드"], ["cash", "현금"], ["cash_receipt", "현금영수증"], ["rvn", "RVN"], ["other", "기타"]];
const won = (n: number) => tf("{0}원", Math.round(n || 0).toLocaleString());
const when = (ms: number | null | undefined) => (ms ? new Date(ms).toLocaleString([], { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "");
const bizText = (no?: string) => (no ? `${no.slice(0, 3)}-${no.slice(3, 5)}-${no.slice(5)}` : "");

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls = "", copy?: () => string): HTMLElementTagNameMap[K] => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (copy) setCopyText(e, copy);
  return e;
};
const button = (copy: () => string, ghost = false): HTMLButtonElement => {
  const b = el("button", ghost ? "ghost" : "", copy);
  b.type = "button";
  return b;
};

/** 매장 PC 의 보내기 오류 코드 → 쉬운 말. */
function storeErr(code: string | null | undefined): string {
  if (!code) return "";
  if (code.startsWith("warn:")) return t("본점이 일부 기록을 받지 않았어요(기록이 끊기거나 바뀐 흔적). 본점에 알려 주세요.");
  switch (code) {
    case "no-head": return t("본점 주소를 아직 적지 않았어요.");
    case "unreachable": return t("본점 컴퓨터에 닿지 않아요. 본점 컴퓨터가 켜져 있는지, 인터넷이 되는지 확인해 주세요.");
    case "bad-reply": return t("본점이 아닌 곳에서 답이 왔어요. 본점 주소를 확인해 주세요.");
    case "refused:revoked": return t("본점이 이 매장을 끊었어요.");
    case "refused:expired": return t("매장 증서 기한이 지났어요. 본점에서 새 꾸러미를 받아 주세요.");
    case "refused:need-prepare": return t("본점이 아직 받을 준비를 안 했어요. 본점 화면에서 「받을 준비」를 눌러 달라고 해 주세요.");
    case "refused:not-head": return t("그 주소는 본점 컴퓨터가 아니에요.");
    case "refused:bad-clock": return t("이 컴퓨터의 날짜·시각이 맞지 않아요. 시계를 맞춘 뒤 다시 보내 주세요.");
    default: return t("본점이 받지 않았어요. 본점에 연락해 주세요.");
  }
}

function rejectText(why: string): string {
  if (why === "revoked") return t("끊긴 매장");
  if (why === "expired") return t("기한 지난 증서");
  if (why === "bad-box") return t("열 수 없는 묶음");
  if (why.startsWith("lines-")) return t("끊기거나 바뀐 기록");
  return t("올바르지 않은 요청");
}

export function mountChainSales(host: HTMLElement, role: "owner" | "store", deps: ChainSalesDeps): { refresh(): Promise<void> } {
  const msg = el("p", "cs-msg");
  msg.setAttribute("role", "status");
  const say = (text: string, bad = false) => { msg.textContent = text; msg.classList.toggle("cs-bad", bad); };
  return role === "store" ? storeView(host, deps, msg, say) : ownerView(host, deps, msg, say);
}

// ── 매장 PC ──
function storeView(host: HTMLElement, deps: ChainSalesDeps, msg: HTMLElement, say: (s: string, bad?: boolean) => void) {
  const state = el("div", "verdict");
  const st = el("div", "v-state");
  const why = el("div", "v-why");
  state.append(st, why);
  const facts = el("p", "csl-facts");
  const url = Object.assign(document.createElement("input"), { autocomplete: "off", spellcheck: false, placeholder: "https://…  /  http://192.168.0.10:8790" });
  url.setAttribute("translate", "no");
  url.id = "csl-head";
  const saveUrl = button(() => t("주소 저장"), true);
  const send = button(() => t("지금 보내기"));
  const field = el("label", "cs-field");
  field.append(el("span", "", () => t("본점 주소")), url, el("span", "cs-hint", () => t("본점 화면의 「매장에 적을 본점 주소」를 그대로 적어요.")));
  const acts = el("div", "cs-acts");
  acts.append(saveUrl, send);
  host.replaceChildren(el("h4", "", () => t("본점으로 매출 보내기")),
    el("p", "meta", () => t("10분마다 이 매장의 결제 기록을 봉해서 본점으로 보내요. 끊겨도 기록은 여기 쌓였다가 연결되면 이어서 가요.")),
    state, facts, field, acts, msg);

  saveUrl.onclick = async () => {
    try {
      const r = await deps.invoke<{ head: string }>("chain_sales_head_set", { url: url.value });
      url.value = r.head;
      say(t("본점 주소를 저장했어요."));
      await refresh();
    } catch (e) { say(deps.errText(e), true); }
  };
  send.onclick = async () => {
    send.disabled = true;
    setCopyText(send, () => t("보내는 중…"));
    try {
      const r = await deps.invoke<{ ok: boolean; why?: string }>("chain_sales_push_now");
      if (r.ok) say(t("본점으로 보냈어요."));
      else say(storeErr(r.why), true);
    } catch (e) { say(deps.errText(e), true); }
    finally {
      send.disabled = false;
      setCopyText(send, () => t("지금 보내기"));
      await refresh();
    }
  };

  async function refresh(): Promise<void> {
    let s: any;
    try { s = await deps.invoke<any>("chain_sales_status"); } catch (e) { say(deps.errText(e), true); return; }
    if (s.role !== "store") { host.hidden = true; return; }
    if (s.head && document.activeElement !== url) url.value = s.head;
    state.className = "verdict " + (s.connected ? "ok" : "bad");
    setCopyText(st, () => (s.connected ? t("본점과 연결돼 있어요") : t("본점과 연결 안 됨")));
    setCopyText(why, () => (s.connected ? "" : storeErr(s.lastErr) || t("아직 본점으로 보낸 적이 없어요.")));
    setCopyText(facts, () => (s.lastOkAt ? tf("마지막으로 보낸 때 {0}", when(s.lastOkAt)) : t("아직 보낸 적이 없어요.")) + " · " + tf("안 보낸 기록 {0}건", s.pending ?? 0)
      + (s.warn ? " · " + storeErr("warn:" + s.warn) : ""));
  }
  void refresh();
  const timer = window.setInterval(() => { if (!host.isConnected) { window.clearInterval(timer); return; } void refresh(); }, 60_000);
  return { refresh };
}

// ── 본점 PC ──
function ownerView(host: HTMLElement, deps: ChainSalesDeps, msg: HTMLElement, say: (s: string, bad?: boolean) => void) {
  let span: "today" | "month" = "today";
  let last: Totals | null = null;
  const alerts = el("div", "csl-alerts");
  alerts.setAttribute("role", "alert");
  const prep = el("div", "csl-prep");
  const addr = el("div", "csl-addr");
  const tabs = el("div", "csl-tabs");
  tabs.setAttribute("role", "radiogroup");
  const tToday = button(() => t("오늘"), true);
  const tMonth = button(() => t("이번 달"), true);
  [tToday, tMonth].forEach((b) => b.setAttribute("role", "radio"));
  tabs.append(tToday, tMonth);
  const all = el("div", "csl-all");
  const biz = el("div", "csl-biz");
  const stores = el("div", "csl-stores");
  const rej = el("details", "csl-rej");
  const again = button(() => t("새로 고침"), true);
  host.replaceChildren(el("h4", "", () => t("매장 매출 합계")), alerts, prep, addr, tabs, all, biz, stores, rej, again, msg);

  tToday.onclick = () => { span = "today"; paint(); };
  tMonth.onclick = () => { span = "month"; paint(); };
  again.onclick = () => void refresh();

  const methodLine = (s: Sum) => {
    const box = el("div", "csl-methods");
    for (const [id, label] of METHODS) {
      const v = s.methods?.[id] || 0;
      if (!v) continue;
      const c = el("span", "csl-m");
      c.append(el("b", "", () => t(label)), document.createTextNode(" " + won(v)));
      box.append(c);
    }
    return box;
  };

  function paint() {
    tToday.setAttribute("aria-checked", String(span === "today"));
    tMonth.setAttribute("aria-checked", String(span === "month"));
    const d = last;
    if (!d) return;
    const sumOf = (x: { today: Sum; month: Sum }) => (span === "today" ? x.today : x.month);
    const a = sumOf(d.all);
    const head = el("p", "csl-total");
    setCopyText(head, () => tf("체인 전체 {0} · {1}건", won(a.net), a.count));
    all.replaceChildren(head, methodLine(a));

    biz.replaceChildren();
    if (d.biz.length > 1 || d.biz.some((b) => b.subs.length)) {
      biz.append(el("h5", "", () => t("사업자별")));
      for (const b of d.biz) {
        const s = sumOf(b);
        const row = el("div", "csl-row");
        const txt = el("div", "csl-rowtxt");
        const title = el("b");
        setCopyText(title, () => tf("사업자 {0}", bizText(b.no)) + (b.subs.length ? " · " + tf("종사업장 {0}", b.subs.join("·")) : ""));
        const sub = el("span", "csl-d");
        setCopyText(sub, () => tf("매장 {0}", b.stores.join("·")));
        txt.append(title, sub, methodLine(s));
        const amt = el("span", "csl-amt");
        amt.textContent = won(s.net);
        row.append(txt, amt);
        biz.append(row);
      }
    }

    stores.replaceChildren(el("h5", "", () => t("매장별")));
    if (!d.stores.length) { stores.append(el("p", "meta", () => t("아직 만든 매장이 없어요."))); return; }
    for (const r of d.stores) {
      const s = sumOf(r);
      const row = el("div", "csl-row" + (r.offline ? " csl-off" : ""));
      const txt = el("div", "csl-rowtxt");
      const title = el("b");
      title.setAttribute("translate", "no");
      title.textContent = `${r.store}. ${r.name}`;
      const sub = el("span", "csl-d");
      setCopyText(sub, () => tf("{0}건", s.count) + " · " + (r.lastSeen ? tf("마지막으로 받은 때 {0}", when(r.lastSeen)) : t("아직 받은 기록이 없어요")));
      txt.append(title, sub, methodLine(s));
      if (r.warn) txt.append(el("span", "csl-warn", () => r.warn!.why === "gap" ? t("기록이 건너뛰어 와서 기다리는 중이에요.")
        : tf("No.{0} 근처 기록이 끊기거나 바뀌어서 받지 않았어요. 그 매장에 확인해 주세요.", r.warn!.at)));
      const amt = el("span", "csl-amt");
      amt.textContent = won(s.net);
      row.append(txt, amt);
      if (r.revoked) row.append(el("span", "cs-cut", () => t("끊김")));
      else if (r.offline) row.append(el("span", "cs-cut", () => t("꺼짐")));
      stores.append(row);
    }
  }

  async function prepare(): Promise<void> {
    try {
      const r = await deps.invoke<{ added: number }>("chain_sales_prepare");
      say(tf("매장 {0}곳의 매출을 받을 준비를 했어요.", r.added));
      await refresh();
    } catch (e) { deps.fail(e, prepare); }
  }

  async function refresh(): Promise<void> {
    let s: any;
    try { s = await deps.invoke<any>("chain_sales_status"); } catch (e) { say(deps.errText(e), true); return; }
    if (s.role !== "owner") { host.hidden = true; return; }
    prep.replaceChildren();
    if (s.needPrepare > 0) {
      const b = button(() => t("받을 준비"));
      b.onclick = () => void prepare();
      prep.append(el("p", "cs-warn", () => tf("매장 {0}곳은 아직 매출을 받을 준비가 안 됐어요. 12단어로 한 번만 준비하면 돼요.", s.needPrepare)), b);
    }
    addr.replaceChildren(el("p", "meta", () => t("매장에 적을 본점 주소")));
    const urls = [s.tunnel, s.lan].filter(Boolean) as string[];
    if (!urls.length) addr.append(el("p", "meta", () => t("손님 폰 서버를 켜면 주소가 보여요. 다른 곳의 매장은 바깥 주소(터널)를 켜 주세요.")));
    for (const u of urls) { const c = el("code", "csl-url"); c.setAttribute("translate", "no"); c.textContent = u; addr.append(c); }

    const now = new Date();
    const d0 = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const d1 = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).getTime();
    const m0 = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
    const m1 = new Date(now.getFullYear(), now.getMonth() + 1, 1).getTime();
    try {
      last = await deps.invoke<Totals>("chain_sales_totals", { dayFrom: d0, dayTo: d1, monthFrom: m0, monthTo: m1 });
    } catch (e) { say(deps.errText(e), true); last = null; }

    alerts.replaceChildren(...(last?.stores || []).filter((r) => r.offline && !r.revoked).map((r) => {
      const a = el("p", "csl-alert");
      a.setAttribute("translate", "no");
      setCopyText(a, () => tf("「{0}」 꺼짐 — 30분째 매출이 오지 않아요", r.name));
      return a;
    }));
    const rows: any[] = s.rejects || [];
    const junk = Object.values((s.junk || {}) as Record<string, number>).reduce((a, b) => a + (Number(b) || 0), 0);
    rej.hidden = !rows.length && !junk;
    rej.replaceChildren(el("summary", "", () => tf("거절한 요청 {0}건", rows.length)),
      ...(junk ? [el("p", "csl-d", () => tf("확인 전에 버린 요청 {0}건(모양·서명이 틀린 것)", junk))] : []),
      ...rows.map((x) => { const p = el("p", "csl-d"); setCopyText(p, () => `${when(x.at)} · ${x.store ?? "?"} · ${rejectText(String(x.why || ""))}`); return p; }));
    paint();
  }
  void refresh();
  const timer = window.setInterval(() => { if (!host.isConnected) { window.clearInterval(timer); return; } void refresh(); }, 60_000);
  return { refresh };
}
