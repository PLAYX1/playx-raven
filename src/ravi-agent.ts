import { mountRaviOpening } from "./ravi-opening";
import { t } from "./i18n";
import { containsRaviSecret } from "./ravi-guide";

export const GREETING_OFF = "rv-ravi-start-off";
const GREETING_SESSION = "rv-ravi-start-seen";
let greeted = false;
export const TOOL_LABELS: Record<string, string> = {
  wallet_balance: "잔액을 보고 있어요", recent_transactions: "최근 거래 요약을 보고 있어요",
  rvn_price_krw: "원화 시세를 보고 있어요", shop_sales: "가게 매출을 보고 있어요",
  shop_orders: "주문 상태를 보고 있어요", node_status: "서버·동기화 상태를 보고 있어요",
  backup_status: "마지막 백업을 보고 있어요", fee_status: "개발비 기록을 보고 있어요",
  prepare_send: "보내기 확인을 준비하고 있어요", open_screen: "요청한 화면을 열고 있어요", prepare_promo: "홍보 도우미를 준비하고 있어요",
};
export type Consent = { reviewed: boolean; balance: boolean; transactions: boolean; shop: boolean };
type Invoke = <T = any>(name: string, args?: Record<string, unknown>) => Promise<T>;
const defaults = (): Consent => ({ reviewed: false, balance: false, transactions: false, shop: false });
export function shouldGreet(local: Pick<Storage, "getItem">, session: Pick<Storage, "getItem" | "setItem">): boolean {
  if (greeted) return false;
  try {
    if (local.getItem(GREETING_OFF) === "1" || session.getItem(GREETING_SESSION) === "1") return false;
    session.setItem(GREETING_SESSION, "1");
  } catch { /* The in-memory guard still limits this process to once. */ }
  greeted = true;
  return true;
}
const numeric = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
export function todayLines(v: any): string[] {
  if (v?.wallet === "locked") return ["지갑이 잠겨 있어요. 잠금을 풀면 더 알려 드릴게요."];
  if (v?.wallet !== "open") return ["지갑 상태 데이터 없음"];
  const one = ["지갑이 열려 있어요"];
  if (v.wallet_balance?.status === "ok" && numeric(v.wallet_balance.confirmed)) one.push(`${v.wallet_balance.confirmed.toLocaleString("ko-KR", { maximumFractionDigits: 8 })} RVN`);
  const sales = v.shop_sales, orders = v.shop_orders?.counts;
  if (numeric(orders?.paid_today)) one.push(`오늘 결제 주문 ${orders.paid_today}건`);
  if (sales?.status === "ok" && numeric(sales.total) && typeof sales.currency === "string") one.push(`오늘 순매출 ${sales.total.toLocaleString("ko-KR")} ${sales.currency}`);
  const two: string[] = [];
  const at = v.backup_status?.last_success_at;
  if (numeric(at)) two.push(`마지막 백업 ${new Date(at * 1000).toLocaleDateString("ko-KR")}`);
  else two.push("백업 기록 데이터 없음");
  const node = v.node_status;
  if (node?.status === "ok" && typeof node.synced === "boolean") two.push(node.synced ? "서버 연결 · 동기화됨" : "서버 연결 · 동기화 중");
  else two.push("서버 상태 데이터 없음");
  return [one.join(" · "), two.join(" · ")];
}
export function toolSummary(name: string, v: any): string {
  if (v?.status === "locked") return "지갑이 잠겨 있어요. 잠금을 풀면 더 알려 드릴게요.";
  if (v?.status === "consent_required") return "이 정보의 AI 전달에 동의하지 않았어요. 설정에서 바꿀 수 있어요.";
  if (v?.status !== "ok") return "데이터 없음";
  switch (name) {
    case "wallet_balance": return numeric(v.confirmed) ? `확인된 잔액 ${v.confirmed} RVN` : "잔액 데이터 없음";
    case "rvn_price_krw": return numeric(v.rate) ? `1 RVN = ${v.rate} KRW${v.unstable ? " · 시세 차이 큼" : ""}` : "시세 데이터 없음";
    case "backup_status": return numeric(v.last_success_at) ? `마지막 백업 ${new Date(v.last_success_at * 1000).toLocaleString()}` : "백업 기록 데이터 없음";
    case "node_status": return `서버 연결 · ${v.synced === true ? "동기화됨" : "동기화 중"}${numeric(v.progress) ? ` (${(v.progress * 100).toFixed(1)}%)` : ""}`;
    case "shop_sales": return `결제 ${v.sales ?? "데이터 없음"}건 · 환불 ${v.refunds ?? "데이터 없음"}건 · 순매출 ${v.total ?? "데이터 없음"} ${v.currency ?? ""}`;
    case "shop_orders": return `오늘 결제 ${v.counts?.paid_today ?? "데이터 없음"}건 · 오늘 환불 ${v.counts?.refunded_today ?? "데이터 없음"}건 · 입금 대기 ${v.counts?.awaiting_payment ?? "데이터 없음"}건`;
    case "fee_status": return `개발비 ${numeric(v.rate) ? v.rate * 100 : "데이터 없음"}% · 미전송 ${v.owed ?? "데이터 없음"} RVN · 전송 누계 ${v.sent_total ?? "데이터 없음"} RVN`;
    case "recent_transactions": return (v.recent || []).map((r: any) => `${r.category === "send" ? "출금" : r.category === "receive" ? "입금" : "거래"} ${r.amount ?? "데이터 없음"} RVN · 확인 ${r.confirmations ?? "데이터 없음"}회`).join("\n") || "최근 거래 없음";
    default: return "데이터 없음";
  }
}
function button(text: string, run: () => void): HTMLButtonElement {
  const b = document.createElement("button"); b.type = "button"; b.textContent = text; b.onclick = run; return b;
}
/** 대화 중에 조용히 내미는 카드의 머리말 — 질문은 이미 일반 대화로 답했다는 것을 먼저 말한다. */
export const CONSENT_OFFER_LEAD = "방금은 내 정보 없이 답했어요. 잔액·거래·가게 정보를 보고 답하길 원하시면 골라서 저장하세요. 저장하면 방금 질문을 다시 물어볼게요.";
function privacyForm(value: Consent, save: (v: Consent) => Promise<void>, dismiss?: () => void, lead = ""): HTMLElement {
  const card = document.createElement("section"); card.className = "ravi-privacy card";
  const title = document.createElement("h3"); title.textContent = "라비에게 보여 줄 정보";
  const p = document.createElement("p"); p.textContent = "선택한 정보 중 질문에 필요한 요약만 AI에 전달해요. 주소·주문 메모·고객 이름은 보내지 않아요. 모두 꺼도 일반 대화와 로컬 조회는 쓸 수 있어요. 설정에서 언제든 바꿀 수 있어요.";
  if (lead) { const intro = document.createElement("p"); intro.className = "ravi-privacy-lead"; intro.textContent = lead; card.append(title, intro, p); }
  else card.append(title, p);
  const fields = new Map<string, HTMLInputElement>();
  for (const [key, label] of [["balance", "잔액"], ["transactions", "최근 거래 요약"], ["shop", "가게 매출·주문·개발비"]] as const) {
    const row = document.createElement("label"), input = document.createElement("input");
    input.type = "checkbox"; input.checked = value[key]; fields.set(key, input); row.append(input, document.createTextNode(label)); card.append(row);
  }
  const status = document.createElement("p"); status.setAttribute("role", "status");
  const commit = button("선택 저장", () => { void (async () => {
    commit.disabled = true;
    try { await save({ reviewed: true, balance: fields.get("balance")!.checked, transactions: fields.get("transactions")!.checked, shop: fields.get("shop")!.checked }); status.textContent = "저장했어요."; }
    catch { status.textContent = "저장하지 못했어요. 정보는 전달하지 않았어요."; }
    finally { commit.disabled = false; }
  })(); });
  card.append(commit, status);
  if (dismiss) card.append(button("지금은 취소", dismiss));
  return card;
}
export function createRaviAgentUI(api: { invoke: Invoke; keyed(): string | null; key(): void; dock(): void; landed?(): void; afterLanding?(run: () => void): void; tz(): number }) {
  let consent = defaults(), started = false;
  const host = document.createElement("div"); host.id = "ravi-agent-settings";
  document.getElementById("page-settings")!.append(host);
  const renderSettings = async () => {
    try { consent = await api.invoke<Consent>("ravi_consent"); } catch { consent = defaults(); }
    host.replaceChildren(privacyForm(consent, async value => { await api.invoke("ravi_consent_save", { consent: value }); consent = value; }));
    const off = document.createElement("label"), input = document.createElement("input"); input.type = "checkbox";
    try { input.checked = localStorage.getItem(GREETING_OFF) === "1"; } catch { /* optional storage */ }
    input.onchange = () => { try { localStorage.setItem(GREETING_OFF, input.checked ? "1" : "0"); } catch { input.checked = false; } };
    off.append(input, document.createTextNode("시작 인사 끄기")); host.append(off);
    const log = document.createElement("pre"); log.className = "ravi-audit"; log.setAttribute("aria-live", "polite");
    host.append(button("라비 도구 사용 기록 보기", () => { void api.invoke<any[]>("ravi_audit").then(rows => {
      log.textContent = rows.map(r => `${new Date(r.at * 1000).toLocaleString()} · ${Object.prototype.hasOwnProperty.call(TOOL_LABELS, r.name) ? r.name : "rejected"} · ${r.success ? "성공" : "실패"}`).join("\n") || "아직 도구 사용 기록이 없어요.";
    }).catch(() => { log.textContent = "기록을 읽지 못했어요."; }); }), log);
  };
  const settingsReady = renderSettings();
  const tools = document.createElement("div"); tools.className = "ravi-local-tools";
  const title = document.createElement("p"); title.textContent = "로컬 정보 조회 · AI에 보내지 않아요";
  const result = document.createElement("p"); result.className = "ravi-tool-result"; result.setAttribute("role", "status"); tools.append(title);
  for (const [name, label] of Object.entries(TOOL_LABELS).slice(0, 8)) {
    const b = button(label.replace("을 보고 있어요", " 보기").replace("를 보고 있어요", " 보기"), () => { void (async () => {
      b.disabled = true; result.textContent = `라비가 ${label}…`;
      try { result.textContent = toolSummary(name, await api.invoke("ravi_tool", { name, args: {}, tz: api.tz() })); }
      catch { result.textContent = "데이터 없음 · 지금 읽지 못했어요."; }
      finally { b.disabled = false; }
    })(); }); tools.append(b);
  }
  tools.append(result); document.getElementById("ravi-tools")!.append(tools);
  // 대화 속 제안 카드는 한 번에 하나, 「지금은 취소」를 누르면 이번 실행 동안 다시 내밀지 않는다.
  let offer: HTMLElement | null = null, declined = false, onSaved: (() => void) | null = null;
  return {
    /** 저장된 선택. 읽지 못하면 null — 부르는 쪽은 개인 정보 없는 일반 대화로 간다. */
    async consentState(): Promise<Consent | null> {
      try { consent = await api.invoke<Consent>("ravi_consent"); return consent; } catch { return null; }
    },
    /**
     * 🔴 질문을 붙잡지 않는다(옛 ensureConsent 는 저장하지 않으면 질문을 버렸고, 카드가 떠 있는 동안
     *    다음 질문까지 막혔다). 답은 이미 나갔고, 이 카드는 그 아래에 조용히 한 번 놓인다.
     *    저장하면 saved() — 부르는 쪽이 보류한 질문을 다시 보낸다.
     */
    offerConsent(saved: () => void): boolean {
      onSaved = saved;
      if (declined || consent.reviewed) { offer?.remove(); offer = null; return false; }
      const log = document.getElementById("chat-log")!;
      if (!offer) {
        offer = privacyForm(consent, async value => {
          await api.invoke("ravi_consent_save", { consent: value }); consent = value;
          offer?.remove(); offer = null; void renderSettings(); onSaved?.();
        }, () => { declined = true; offer?.remove(); offer = null; }, CONSENT_OFFER_LEAD);
        offer.setAttribute("data-ravi-consent-offer", "1");
      }
      log.append(offer); // 이미 있으면 맨 아래로 옮길 뿐, 쌓지 않는다
      return true;
    },
    start() {
      if (started) return;
      started = true;
      if (!shouldGreet(localStorage, sessionStorage)) { api.landed?.(); return; }
      const overlay = document.createElement("aside"); overlay.className = "ravi-arrival"; overlay.setAttribute("aria-label", "라비 시작 인사");
      const bird = document.createElement("button"); bird.type = "button"; bird.className = "ravi-arrival-bird"; bird.setAttribute("data-ravi-skip", "true"); bird.setAttribute("aria-label", t("인사 건너뛰기"));
      const bubble = document.createElement("div"); bubble.className = "ravi-arrival-bubble"; bubble.hidden = true;
      const title = document.createElement("strong"); title.textContent = "짜잔! 오늘 어땠어요?";
      const summary = document.createElement("p"); summary.textContent = "오늘의 로컬 정보를 확인하고 있어요…";
      const natural = document.createElement("p"); natural.setAttribute("aria-live", "polite");
      let timer = 0, closed = false;
      const dismiss = () => { if (closed) return; closed = true; clearTimeout(timer); document.removeEventListener("keydown", onEscape); overlay.classList.add("docking"); window.setTimeout(() => { opening.destroy(); overlay.remove(); }, 360); };
      // The landed bubble covers home controls for up to 18s; Escape and a close button release them without opening the chat.
      const onEscape = (event: KeyboardEvent) => { if (event.key !== "Escape" || event.defaultPrevented || !landed) return; event.preventDefault(); dismiss(); };
      const dock = () => {
        const run = () => { if (closed) return; dismiss(); api.dock(); };
        if (api.afterLanding) api.afterLanding(run); else run();
      };
      const key = button("AI 열쇠를 넣으면 더 많은 걸 해 드려요", () => { const run = () => { dock(); api.key(); }; if (api.afterLanding) api.afterLanding(run); else run(); }); key.hidden = !!api.keyed();
      bubble.append(title, summary, natural, key, button("라비와 이야기하기", dock), button(t("닫기"), dismiss)); overlay.append(bird, bubble); document.body.append(overlay);
      const skip = button(t("인사 건너뛰기"), () => opening.finish());
      skip.className = "ravi-arrival-skip"; skip.setAttribute("data-ravi-skip", "true"); overlay.append(skip);
      let landed = false;
      const land = () => {
        if (landed) return;
        landed = true; skip.hidden = true; bird.setAttribute("aria-label", t("라비와 이야기하기")); bubble.hidden = false; api.landed?.();
        timer = window.setTimeout(dismiss, 18000);
        document.addEventListener("keydown", onEscape);
      };
      const opening = mountRaviOpening(bird, land);
      void api.invoke("companion_settings").then(value => opening.batterySaver(value?.settings?.battery === true)).catch(() => {});
      void api.invoke("ravi_today", { tz: api.tz() }).then(async data => {
        await settingsReady;
        if (closed) return;
        summary.textContent = todayLines(data).join("\n"); key.hidden = !!api.keyed();
        if (landed) { clearTimeout(timer); timer = window.setTimeout(dismiss, 18000); }
        // No consent means no automatic provider call, even when a key exists.
        if (api.keyed() && consent.reviewed) {
          try { const line = await api.invoke<string>("ravi_greeting", { provider: api.keyed(), tz: api.tz() }); if (!closed && !containsRaviSecret(line)) natural.textContent = line; } catch { /* Fixed greeting and local numbers stay visible. */ }
        }
      }).catch(() => { if (!closed) summary.textContent = "오늘 요약 데이터 없음"; });
      bird.onclick = () => { if (!landed) opening.finish(); else dock(); };
    },
  };
}
