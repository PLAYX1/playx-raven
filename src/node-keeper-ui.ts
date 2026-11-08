/* 설정 › 「노드 지킴이」 카드.
 *
 * 하루 한 번 확인 서버가 이 컴퓨터 노드에 접속해 블록 하나를 받아 본다. 최근 30일 중 25일 확인되면
 * 이야기에서 이름 옆에 「노드 지킴이」 표시가 붙는다. 서버 쪽 규칙·서명은 src-tauri/src/node_keeper.rs.
 *
 * main.ts 는 `wireNodeKeeper()` 한 줄만 안다. 카드는 이 파일이 #page-settings 에 붙이고,
 * settings-nav.ts 가 「일반」 끝으로 옮긴다(index.html 은 안 고친다).
 * style="…" 속성은 쓰지 않는다(CSP nonce 가 막는다) — 모양은 node-keeper.css.
 */
import { invoke } from "@tauri-apps/api/core";
import { copyHtml, setCopyText, t, tf } from "./i18n";
import "./node-keeper.css";

type Day = { day: string; ok: boolean; reason?: string; at: number };
type State = {
  enabled: boolean; port: number; inbound_off: "listen0" | "connect" | "proxy" | null;
  today: string; today_ok: boolean; today_tried: boolean; last: Day | null;
  days_ok: number; window_days: number; needed_days: number; eligible: boolean; busy: boolean;
  result?: { ok: boolean; reason?: string | null; day: string };
};
type Awards = { days_ok: number; relay_ok: boolean; eligible: boolean };

export const NODE_KEEPER_CARD = "nk-card";

const REASON: Record<string, string> = {
  "port-closed": "바깥에서 이 컴퓨터 노드로 들어오지 못했어요.",
  timeout: "노드가 제때 답하지 않았어요. 잠시 뒤 다시 해 볼게요.",
  "wrong-network": "레이븐코인 본 네트워크 노드가 아닌 것 같아요.",
  "bad-block": "노드가 보낸 블록이 맞지 않았어요. 장부를 다 받았는지 확인해 주세요.",
  auth: "확인 요청 서명이 맞지 않았어요. 컴퓨터 시계가 맞는지 확인해 주세요.",
  "not-configured": "확인 서버가 아직 준비 중이에요. 나중에 다시 해 볼게요.",
  "node-off": "노드가 꺼져 있어요.",
  "not-synced": "노드가 아직 장부를 따라잡는 중이에요. 다 받으면 확인할 수 있어요.",
  "no-key": "이야기 이름(열쇠)이 아직 없어요. 이야기 화면을 한 번 열어 주세요.",
  network: "확인 서버에 닿지 못했어요. 인터넷 연결을 확인해 주세요.",
  server: "확인 서버가 알 수 없는 답을 했어요. 나중에 다시 해 볼게요.",
  busy: "이미 확인하는 중이에요.",
};
export const reasonText = (code: string | null | undefined) => REASON[String(code || "server")] ?? REASON.server;

const esc = (v: unknown) => String(v ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
const el = (id: string) => document.getElementById(id);
let state: State | null = null;
let relayDays: number | null = null;

function ensureCard(): HTMLElement | null {
  const page = el("page-settings");
  if (!page) return null;
  let card = el(NODE_KEEPER_CARD);
  if (card) return card;
  card = document.createElement("div");
  card.id = NODE_KEEPER_CARD;
  card.className = "card nk-card";
  card.innerHTML = `
    <h3>${copyHtml("노드 지킴이")}</h3>
    <p class="nk-what">${copyHtml("내 컴퓨터의 레이븐코인 노드가 네트워크를 돕고 있다는 표시예요. 최근 30일 중 25일 확인되면 이야기에서 내 이름 옆에 「노드 지킴이」 표시가 붙어요.")}</p>
    <p class="meta">${copyHtml("확인 서버는 하루 한 번 내 컴퓨터 노드에 접속해 블록 하나를 받아 봐요. IP와 위치는 어디에도 공개하지 않아요.")}</p>
    <label class="check nk-switch"><span class="sx-txt"><b>${copyHtml("참여하기")}</b></span><input type="checkbox" id="nk-on" role="switch" /></label>
    <div class="nk-status" id="nk-status" role="status"></div>
    <div class="meta nk-days" id="nk-days"></div>
    <div class="nk-help" id="nk-help" hidden></div>
    <div class="row sx-acts"><button class="ghost" id="nk-check">${copyHtml("지금 확인하기")}</button></div>`;
  page.append(card);
  (el("nk-on") as HTMLInputElement).addEventListener("change", (e) => void setEnabled((e.target as HTMLInputElement).checked));
  el("nk-check")?.addEventListener("click", () => void checkNow());
  return card;
}

function statusLine(s: State): string {
  const r = s.result;
  if (s.busy) return t("확인하는 중…");
  if (s.today_ok) return t("오늘 확인됨");
  const code = r && !r.ok ? r.reason : s.last && !s.last.ok && s.last.day === s.today ? s.last.reason : null;
  if (code) return tf("확인 못 함 — {0}", t(reasonText(code)));
  return t("아직 오늘 확인 안 됨");
}

function helpHtml(s: State, code: string | null | undefined): string {
  const parts: string[] = [];
  if (s.inbound_off === "listen0") {
    parts.push(`<p>${copyHtml("raven.conf 에 listen=0 이 적혀 있어 노드가 바깥 연결을 받지 않아요.")}</p>
      <p class="meta">${copyHtml("아래 단추는 raven.conf 의 그 한 줄만 listen=1 로 바꾸고 사본을 남겨요. 노드를 다시 켜야 적용돼요. 지갑 열쇠와 송금 권한은 열리지 않아요.")}</p>
      <button class="ghost" id="nk-inbound">${copyHtml("바깥 연결 받기로 바꾸기")}</button>`);
  } else if (s.inbound_off) {
    parts.push(`<p>${copyHtml("raven.conf 에 connect= 또는 proxy= 가 있어 노드가 바깥 연결을 받지 않아요. 직접 적으신 설정이라 앱이 바꾸지 않아요.")}</p>`);
  }
  if (code === "port-closed") {
    parts.push(`<ol class="nk-steps">
      <li>${esc(tf("공유기에서 {0} 포트를 이 컴퓨터로 열어 주세요(포트 포워딩).", s.port))}</li>
      <li>${copyHtml("레이븐코인 노드가 바깥 연결을 받도록 켜져 있어야 해요(listen=1). 이 앱은 기본으로 켜 둬요.")}</li>
      <li>${copyHtml("공유기가 UPnP 를 지원하면 「바깥 접속 자동으로 열기」를 켜도 돼요.")}</li>
    </ol>`);
  }
  return parts.join("");
}

function paint(s: State) {
  state = s;
  if (!ensureCard()) return;
  const on = el("nk-on") as HTMLInputElement | null;
  if (on) on.checked = !!s.enabled;
  const status = el("nk-status");
  if (status) {
    setCopyText(status, () => statusLine(s));
    status.classList.toggle("ok", s.today_ok);
  }
  const days = el("nk-days");
  if (days) {
    const n = Math.max(s.days_ok, relayDays ?? 0);
    setCopyText(days, () => tf("최근 30일 중 {0}일", n) + " · " + (n >= s.needed_days ? t("「노드 지킴이」 표시가 붙어 있어요") : t("25일이 되면 표시가 붙어요")));
  }
  const code = s.result && !s.result.ok ? s.result.reason : s.last && !s.last.ok ? s.last.reason : null;
  const help = el("nk-help");
  if (help) {
    const html = helpHtml(s, code);
    help.innerHTML = html;
    help.hidden = !html;
    el("nk-inbound")?.addEventListener("click", () => void allowInbound());
  }
  const btn = el("nk-check") as HTMLButtonElement | null;
  if (btn) btn.disabled = s.busy;
}

async function refresh() {
  try { paint(await invoke<State>("node_keeper_settings_get")); } catch { /* 명령이 없는 판 — 카드만 남는다 */ }
  try {
    const a = await invoke<Awards>("node_keeper_awards");
    relayDays = a.days_ok;
    if (state) paint(state);
  } catch { /* 릴레이를 못 읽으면 이 컴퓨터 기록만 */ }
}

async function setEnabled(on: boolean) {
  try { paint(await invoke<State>("node_keeper_settings_set", { enabled: on })); } catch (e) { flash(e); }
  // 켜면 뒤에서 한 번 확인한다 — 잠시 뒤 다시 읽는다.
  if (on) setTimeout(() => void refresh(), 20_000);
}

async function checkNow() {
  const btn = el("nk-check") as HTMLButtonElement | null;
  if (btn) btn.disabled = true;
  const status = el("nk-status");
  if (status) setCopyText(status, () => t("확인하는 중…"));
  try { paint(await invoke<State>("node_keeper_check")); } catch (e) { flash(e); }
  finally { if (btn) btn.disabled = false; }
  void refresh();
}

async function allowInbound() {
  try {
    const r = await invoke<{ changed: boolean; needs_restart: boolean }>("node_keeper_allow_inbound");
    const help = el("nk-help");
    if (help && r.changed) {
      const p = document.createElement("p");
      p.className = "nk-done";
      setCopyText(p, () => t("바꿨어요. 노드를 다시 켜면 적용돼요."));
      help.append(p);
    }
  } catch (e) { flash(e); }
}

function flash(e: unknown) {
  const status = el("nk-status");
  if (status) status.textContent = e instanceof Error ? e.message : String(e ?? "");
}

/** 설정 화면에 카드를 붙이고, 열 때마다 다시 읽는다. */
export function wireNodeKeeper() {
  if (!ensureCard()) return;
  void refresh();
  window.addEventListener("desktop-language-change", () => { if (state) paint(state); });
  document.addEventListener("click", (e) => {
    const a = (e.target as Element | null)?.closest?.('nav a[data-page="settings"]');
    if (a) void refresh();
  });
}

/** 라비 「노드 지킴이」 — 설정을 열고 이 카드로 데려간다. */
export function openNodeKeeper(show: (page: string) => void) {
  show("settings");
  ensureCard()?.scrollIntoView({ block: "start" });
  void refresh();
}
