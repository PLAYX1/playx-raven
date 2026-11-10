/* 체인 POS ② — 「들어온 주문」 위의 「결제 기록」 + 「오늘 매출」 (docs/CHAIN-POS.md). 카드가 처음 보일 때 읽는 지연 묶음.
 *
 *  - 돈을 받은 **결과**만 적는다: 금액 → 결제 방법(카드·현금·현금영수증·RVN·기타) → 번호(필요할 때만) → 「기록」.
 *    카드 승인·현금영수증 발급은 하지 않는다(단말기·국세청 몫). 단말기 영수증의 번호를 옮겨 적을 뿐이다.
 *  - 「오늘 매출」: 결제 방법별 합계 + 오늘 목록. 잘못 적은 것은 「취소」(새 줄로 남는다 — 지우지 않는다).
 *  - RVN 주문 줄의 「결제 기록」을 누르면 그 주문이 붙는다 → 금액·거래 번호는 러스트가 매출장부에서 가져온다.
 *
 * 70대 기준: 글자 16px 이상, 단추 48px 이상, 말 적게.
 */
import "./pos-pay.css";
import { DICT } from "./dict";
import { t, tf, setCopyText } from "./i18n";
import { POS_PAY_COPY } from "./pos-pay-copy";

for (const [source, values] of Object.entries(POS_PAY_COPY)) {
  (["en", "ja", "zh"] as const).forEach((language, index) => { DICT[language][source] ??= values[index]; });
}

type Invoke = <T = any>(name: string, args?: Record<string, unknown>) => Promise<T>;
export interface PosPayDeps {
  invoke: Invoke;
  sure(title: string, message: string, ok: string): Promise<boolean>;
  errText(e: unknown): string;
}

type Method = "card" | "cash" | "cash_receipt" | "rvn" | "other";
const METHODS: { id: Method; label: string; number?: string; hint?: string }[] = [
  { id: "card", label: "카드", number: "승인번호", hint: "카드 단말기 영수증에 있어요." },
  { id: "cash", label: "현금" },
  { id: "cash_receipt", label: "현금영수증", number: "발급번호", hint: "현금영수증을 끊은 뒤 나온 번호예요." },
  { id: "rvn", label: "RVN", number: "거래 번호" },
  { id: "other", label: "기타" },
];
const label = (m: string) => t(METHODS.find((x) => x.id === m)?.label || "기타");
const won = (n: number) => tf("{0}원", Math.round(n).toLocaleString());
const hhmm = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
const bizText = (b?: { no?: string; sub?: string } | null) =>
  (b?.no ? `${b.no.slice(0, 3)}-${b.no.slice(3, 5)}-${b.no.slice(5)}` : "") + (b?.sub ? ` · ${b.sub}` : "");

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls = "", copy?: () => string): HTMLElementTagNameMap[K] => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (copy) setCopyText(e, copy);
  return e;
};
const button = (copy: () => string, cls = ""): HTMLButtonElement => {
  const b = el("button", cls, copy);
  b.type = "button";
  return b;
};
const input = (opts: Partial<HTMLInputElement> = {}): HTMLInputElement =>
  Object.assign(document.createElement("input"), { autocomplete: "off", spellcheck: false, ...opts });

let mounted: { attachOrder(address: string): void } | null = null;
let pendingOrder: string | null = null;

/** 「들어온 주문」 줄의 「결제 기록」 — 카드가 아직 안 읽혔으면 읽힐 때 붙인다. */
export function posAttachOrder(address: string) {
  if (mounted) mounted.attachOrder(address);
  else pendingOrder = address;
}

export function mountPosPay(host: HTMLElement, deps: PosPayDeps): { refresh(): Promise<void> } {
  let method: Method | null = null;
  let order: string | null = null;

  const who = el("p", "pp-who");
  const amount = input({ inputMode: "numeric", placeholder: "0", className: "pp-amount" });
  amount.setAttribute("aria-label", t("금액"));
  const chips = el("div", "pp-chips");
  chips.setAttribute("role", "radiogroup");
  const numWrap = el("label", "pp-field");
  const numLabel = el("span");
  const number = input({ className: "pp-number" });
  const numHint = el("span", "pp-hint");
  numWrap.append(numLabel, number, numHint);
  const issuerWrap = el("label", "pp-field");
  const issuer = input({ placeholder: t("예: 신한") });
  issuerWrap.append(el("span", "", () => t("카드사 (안 적어도 돼요)")), issuer);
  const memoWrap = el("label", "pp-field");
  const memo = input({ maxLength: 40 });
  memoWrap.append(el("span", "", () => t("메모 (안 적어도 돼요)")), memo);
  const orderRow = el("div", "pp-order");
  const save = button(() => t("기록"), "pp-save");
  const msg = el("p", "pp-msg");
  msg.setAttribute("role", "status");
  const say = (text: string, bad = false) => { msg.textContent = text; msg.classList.toggle("pp-bad", bad); };

  const form = el("div", "pp-form");
  const amountRow = el("label", "pp-amount-row");
  amountRow.append(el("span", "", () => t("받은 금액")), amount, el("span", "pp-unit", () => t("원")));
  form.append(orderRow, amountRow, chips, numWrap, issuerWrap, memoWrap, save, msg);

  const chipButtons = METHODS.map((m) => {
    const b = button(() => t(m.label), "pp-chip");
    b.setAttribute("role", "radio");
    b.dataset.method = m.id;
    b.onclick = () => pick(m.id);
    chips.append(b);
    return b;
  });

  function pick(m: Method | null) {
    method = m;
    chipButtons.forEach((b) => b.setAttribute("aria-checked", String(b.dataset.method === m)));
    const spec = METHODS.find((x) => x.id === m);
    // RVN 주문이 붙어 있으면 금액·거래 번호는 장부에서 온다 — 비워 둬도 된다(장부에 없으면 러스트가 번호를 달라고 한다).
    const fromOrder = m === "rvn" && !!order;
    numWrap.hidden = !spec?.number;
    issuerWrap.hidden = m !== "card";
    memoWrap.hidden = m !== "other";
    numLabel.textContent = spec?.number ? t(spec.number) : "";
    numHint.textContent = fromOrder ? t("비워 두면 주문 장부에서 가져와요.") : spec?.hint ? t(spec.hint) : "";
    amount.placeholder = fromOrder ? t("비워 두면 주문 금액") : "0";
    number.inputMode = m === "rvn" ? "text" : "numeric";
    number.value = "";
    save.disabled = !m;
  }

  function paintOrder() {
    orderRow.replaceChildren();
    orderRow.hidden = !order;
    if (!order) return;
    const txt = el("span", "", () => tf("주문 {0}… 결제", order!.slice(0, 8)));
    const drop = button(() => t("빼기"), "ghost");
    drop.onclick = () => { order = null; paintOrder(); pick(method); };
    orderRow.append(txt, drop);
  }

  save.onclick = async () => {
    if (!method) return;
    const raw = amount.value.replace(/[^\d]/g, "");
    const args: Record<string, unknown> = {
      method,
      amount: raw ? Number(raw) : null,
      number: number.value.trim() || null,
      issuer: method === "card" ? issuer.value.trim() || null : null,
      memo: method === "other" ? memo.value.trim() || null : null,
      order,
    };
    save.disabled = true;
    try {
      const r = await deps.invoke<any>("pos_record", args);
      say(tf("No.{0} · {1} · {2} 기록했어요.", r.receipt, label(r.method), won(r.amount)));
      amount.value = ""; number.value = ""; issuer.value = ""; memo.value = "";
      order = null; paintOrder(); pick(null);
      await refresh();
    } catch (e) {
      say(deps.errText(e), true);
      save.disabled = false;
    }
  };

  // ── 오늘 매출 ──
  const dayBox = el("div", "pp-day");
  const total = el("p", "pp-total");
  const perMethod = el("div", "pp-totals");
  const check = el("p", "pp-check");
  check.setAttribute("role", "alert");
  const list = el("ul", "pp-list");
  dayBox.append(el("h4", "", () => t("오늘 매출")), total, perMethod, check, list);

  // ── 사업자 번호(체인 매장이 아닐 때만) ──
  const bizBox = el("details", "pp-biz");
  const bizNo = input({ inputMode: "numeric", placeholder: "123-45-67890" });
  const bizSub = input({ inputMode: "numeric", placeholder: "0001" });
  const bizSave = button(() => t("저장"), "ghost");
  const bizSum = el("summary", "", () => t("사업자등록번호"));
  const f1 = el("label", "pp-field"); f1.append(el("span", "", () => t("사업자등록번호")), bizNo);
  const f2 = el("label", "pp-field"); f2.append(el("span", "", () => t("종사업장 번호 (없으면 비워 두세요)")), bizSub);
  bizBox.append(bizSum, el("p", "pp-hint", () => t("적어 두면 결제 기록마다 같이 남아요.")), f1, f2, bizSave);
  bizSave.onclick = async () => {
    try {
      await deps.invoke("pos_biz_save", { bizNo: bizNo.value, bizSub: bizSub.value || null });
      say(t("저장했어요."));
      await refresh();
    } catch (e) { say(deps.errText(e), true); }
  };

  host.replaceChildren(el("h3", "", () => t("결제 기록")),
    el("p", "meta", () => t("카드 단말기·현금으로 받은 돈을 여기 적어요. 인터넷이 끊겨도 쌓여요.")),
    who, form, dayBox, bizBox);

  async function voidRow(seq: number, amt: number, m: string) {
    const ok = await deps.sure(t("이 결제를 취소할까요?"),
      tf("No.{0} · {1} · {2}. 원래 기록은 그대로 두고 「취소」 기록을 새로 남겨요. 카드·현금영수증은 단말기에서도 따로 취소해 주세요.", seq, label(m), won(amt)),
      t("취소 기록"));
    if (!ok) return;
    try {
      const r = await deps.invoke<any>("pos_void", { seq, reason: null });
      say(tf("No.{0} 을 취소했어요(No.{1}).", seq, r.receipt));
      await refresh();
    } catch (e) { say(deps.errText(e), true); }
  }

  async function refresh() {
    const now = new Date();
    const from = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const to = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).getTime();
    let d: any;
    try {
      d = await deps.invoke<any>("pos_day", { fromMs: from, toMs: to });
    } catch (e) {
      total.textContent = deps.errText(e);
      list.replaceChildren(); perMethod.replaceChildren(); check.hidden = true;
      return;
    }
    const whoText = d.chain
      ? tf("{0} · {1}번 매장", d.name || "", d.store)
      : t("이 가게");
    who.textContent = whoText + (d.biz?.no ? " · " + tf("사업자 {0}", bizText(d.biz)) : "");
    who.setAttribute("translate", "no");
    bizBox.hidden = !!d.chain;
    if (!d.chain && d.biz?.no) { bizNo.value = d.biz.no; bizSub.value = d.biz.sub || ""; }

    total.textContent = tf("합계 {0} · {1}건", won(d.net || 0), d.count || 0);
    perMethod.replaceChildren(...METHODS.filter((m) => (d.totals?.[m.id] || 0) !== 0).map((m) => {
      const c = el("span", "pp-tot");
      c.append(el("b", "", () => t(m.label)), document.createTextNode(" " + won(d.totals[m.id])));
      return c;
    }));
    check.hidden = d.check?.ok !== false;
    check.textContent = d.check?.ok === false ? tf("기록이 지워지거나 바뀐 흔적이 있어요 (No.{0} 근처). 본점이나 담당자에게 알려 주세요.", d.check.at) : "";

    const rows: any[] = d.rows || [];
    if (!rows.length) {
      list.replaceChildren(el("li", "pp-empty", () => t("오늘은 아직 기록이 없어요.")));
      return;
    }
    list.replaceChildren(...rows.map((r) => {
      const li = el("li", "pp-row" + (r.voided ? " pp-voided" : "") + (r.kind === "void" ? " pp-void" : ""));
      const left = el("span", "pp-rowtxt");
      const no = r.approval || r.cashReceipt || (r.txid ? String(r.txid).slice(0, 10) + "…" : "");
      left.append(
        el("b", "", () => `No.${r.seq}`),
        document.createTextNode(` · ${hhmm(r.at)} · ${label(r.method)}${r.kind === "void" ? " · " + tf("취소(No.{0})", r.ref) : ""}`),
      );
      if (no) left.append(el("span", "pp-no", () => no));
      const amt = el("span", "pp-amt", () => won(r.amount));
      li.append(left, amt);
      if (r.voided) li.append(el("span", "pp-tag", () => t("취소됨")));
      else if (r.kind === "sale") {
        const v = button(() => t("취소"), "ghost pp-cancel");
        v.onclick = () => voidRow(r.seq, r.amount, r.method);
        li.append(v);
      }
      return li;
    }));
  }

  mounted = {
    attachOrder(address: string) {
      order = address;
      paintOrder();
      pick("rvn");
      say(t("RVN 주문이에요. 「기록」을 누르면 금액과 거래 번호를 장부에서 가져와요."));
      host.scrollIntoView({ block: "start", behavior: "smooth" });
    },
  };
  paintOrder();
  pick(null);
  if (pendingOrder) { const a = pendingOrder; pendingOrder = null; mounted.attachOrder(a); }
  void refresh();
  return { refresh };
}
