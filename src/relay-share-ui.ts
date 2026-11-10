/* 설정 › 「릴레이 나누기」 카드. 규약 정본: docs/RELAY-SHARE.md · 뒤쪽 동작: src-tauri/src/relay_share.rs
 *
 * 기본값이면 아무것도 안 만져도 된다(어르신 기준): 릴레이 나누기 꺼짐 · 내 글 다시 올리기 켬 · 이웃 릴레이에서도 읽기 켬.
 * 쓰는 릴레이 목록·주소 더하기는 접어 둔 「고급」 안에만 있다.
 *
 * main.ts 는 `wireRelayShare()` 한 줄만 안다. 카드는 이 파일이 #page-settings 에 붙이고,
 * settings-nav.ts 가 「일반」 끝으로 옮긴다(index.html 은 안 고친다).
 * style="…" 속성은 쓰지 않는다(CSP nonce 가 막는다) — 모양은 relay-share.css.
 */
import { invoke } from "@tauri-apps/api/core";
import { copyHtml, setCopyText, t, tf } from "./i18n";
import "./relay-share.css";

type State = {
  enabled: boolean; republish: boolean; outbox_read: boolean;
  outside_url: string | null; sharing: boolean; problem: string | null;
  peers: string[]; extra: string[]; defaults: string[]; own_url?: string | null;
  republish_at: number; republish_count: number; republish_ok: boolean;
  now: number; busy: boolean;
};

export const RELAY_SHARE_CARD = "relay-share-card";

const esc = (v: unknown) => String(v ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
const el = (id: string) => document.getElementById(id);
let state: State | null = null;

function ensureCard(): HTMLElement | null {
  const page = el("page-settings");
  if (!page) return null;
  let card = el(RELAY_SHARE_CARD);
  if (card) return card;
  card = document.createElement("div");
  card.id = RELAY_SHARE_CARD;
  card.className = "card rs-card";
  card.innerHTML = `
    <h3>${copyHtml("릴레이 나누기")}</h3>
    <p class="meta">${copyHtml("릴레이는 글을 받아 두었다가 전해 주는 우체통 같은 서버예요.")}</p>
    <p class="rs-what">${copyHtml("켜면 이 컴퓨터 릴레이 주소를 알리고, 「릴레이 나누기」를 켠 다른 레이븐볼트 컴퓨터와 서로 이야기 글을 나눠요. 큰 릴레이가 막혀도 켠 컴퓨터끼리는 글이 돌아요.")}</p>
    <p class="meta">${copyHtml("「바깥에서도 열리게」가 켜져 있어야 해요. 지갑 정보는 보내지 않아요. 이미 공개된 이야기 글만 오가요.")}</p>
    <label class="check rs-switch"><span class="sx-txt"><b>${copyHtml("릴레이 나누기 켜기")}</b></span><input type="checkbox" id="rs-on" role="switch" /></label>
    <div class="rs-status" id="rs-status" role="status"></div>
    <div class="rs-outside" id="rs-outside" hidden>
      <p class="meta">${copyHtml("왜 필요한가요? 이 컴퓨터는 보통 집 안에서만 보여요. 바깥 주소가 있어야 밖에 있는 폰과 다른 분들도 이 릴레이로 글을 주고받을 수 있어요.")}</p>
      <p class="meta">${copyHtml("「바깥 접속」을 켜면 클라우드플레어를 통해 바깥에서 들어올 수 있는 주소가 생겨요. 테일스케일을 쓰시면 「고급」에서 주소를 직접 적을 수 있어요.")}</p>
      <div class="row sx-acts"><button class="sx-primary" id="rs-tunnel-on">${copyHtml("바깥 접속 켜기")}</button></div>
      <div class="meta" id="rs-tunnel-msg" role="status"></div>
    </div>
    <div class="meta rs-peers" id="rs-peers"></div>
    <label class="check rs-switch"><span class="sx-txt"><b>${copyHtml("내 글 다시 올리기")}</b>
      <span class="meta">${copyHtml("6시간마다 최근 30일 내 글이 큰 릴레이에 남아 있는지 보고, 빠진 글만 다시 올려요. 지운 글은 올리지 않아요.")}</span></span>
      <input type="checkbox" id="rs-republish" role="switch" /></label>
    <div class="meta rs-result" id="rs-result"></div>
    <label class="check rs-switch"><span class="sx-txt"><b>${copyHtml("이웃 릴레이에서도 읽기")}</b>
      <span class="meta">${copyHtml("다른 사람 컴퓨터 릴레이에 연결하면 그 주인이 내 인터넷 주소(IP)를 볼 수 있어요. 공개 릴레이도 마찬가지예요.")}</span></span>
      <input type="checkbox" id="rs-outbox" role="switch" /></label>
    <div class="rs-keeper" id="rs-keeper" hidden>
      <p class="rs-keeper-h"><b>${copyHtml("릴레이 지킴이")}</b></p>
      <p class="meta">${copyHtml("하루 한 번 확인 서버가 내 릴레이에 들어와 내 주소 목록을 읽어 봐요. 최근 30일 중 25일 확인되면 이야기에서 내 이름 옆에 「릴레이 지킴이」 표시가 붙어요.")}</p>
      <div class="rs-status" id="rs-k-status" role="status"></div>
      <div class="meta" id="rs-k-days"></div>
      <div class="row sx-acts"><button class="ghost" id="rs-k-check">${copyHtml("지금 확인하기")}</button></div>
    </div>
    <details class="rs-adv">
      <summary>${copyHtml("고급")}</summary>
      <p class="meta">${copyHtml("쓰는 릴레이")}</p>
      <ul class="rs-list" id="rs-list"></ul>
      <div class="row rs-add">
        <input type="text" id="rs-new" inputmode="url" autocomplete="off" spellcheck="false" placeholder="wss://" />
        <button class="ghost" id="rs-add-btn">${copyHtml("더하기")}</button>
      </div>
      <div class="meta rs-err" id="rs-err" role="alert"></div>
      <p class="meta"><b>${copyHtml("내 바깥 주소 직접 쓰기 (테일스케일 등)")}</b><br>${copyHtml("「바깥 접속」이 꺼져 있을 때만 써요. 알리기 전에 이 주소로 직접 들어와 보고, 되는 주소만 알려요.")}<br>${copyHtml("테일스케일은 이미 쓰고 계신 분을 위한 것이에요. 클라우드플레어 주소는 컴퓨터를 다시 켤 때마다 바뀌지만(앱이 새 주소를 알아서 다시 알려요), 테일스케일 주소는 바뀌지 않아요.")}</p>
      <div class="row rs-add">
        <input type="text" id="rs-own" inputmode="url" autocomplete="off" spellcheck="false" placeholder="wss://" />
        <button class="ghost" id="rs-own-save">${copyHtml("저장")}</button>
        <button class="ghost" id="rs-own-clear">${copyHtml("지우기")}</button>
      </div>
    </details>`;
  page.append(card);
  (el("rs-on") as HTMLInputElement).addEventListener("change", (e) => void setSwitch({ enabled: (e.target as HTMLInputElement).checked }));
  (el("rs-republish") as HTMLInputElement).addEventListener("change", (e) => void setSwitch({ republish: (e.target as HTMLInputElement).checked }));
  (el("rs-outbox") as HTMLInputElement).addEventListener("change", (e) => void setSwitch({ outboxRead: (e.target as HTMLInputElement).checked }));
  el("rs-add-btn")?.addEventListener("click", () => void addRelay());
  el("rs-tunnel-on")?.addEventListener("click", () => void tunnelOn());
  el("rs-own-save")?.addEventListener("click", () => void setOwn((el("rs-own") as HTMLInputElement | null)?.value ?? ""));
  el("rs-own-clear")?.addEventListener("click", () => void setOwn(""));
  el("rs-k-check")?.addEventListener("click", () => void keeperCheckNow());
  el("rs-new")?.addEventListener("keydown", (e) => { if ((e as KeyboardEvent).key === "Enter") void addRelay(); });
  el("rs-list")?.addEventListener("click", (e) => {
    const b = (e.target as Element | null)?.closest?.("button[data-rs-remove]") as HTMLButtonElement | null;
    if (b) void removeRelay(b.dataset.rsRemove || "");
  });
  return card;
}

export function statusLine(s: State): string {
  if (!s.enabled) return t("꺼져 있어요");
  if (s.problem === "no-outside") return t("바깥 주소가 없어 나누지 못해요 — 바깥 접속을 켜 주세요");
  if (s.problem === "self-test") return t("바깥 주소로 들어와 보지 못했어요. 잠시 뒤 다시 해 볼게요.");
  if (s.problem === "no-key") return t("이야기 이름(열쇠)이 아직 없어요. 이야기 화면을 한 번 열어 주세요.");
  if (s.problem === "publish") return t("내 릴레이 주소를 알리지 못했어요. 잠시 뒤 다시 해 볼게요.");
  if (!s.sharing) return t("준비하는 중이에요…");
  if (s.peers.length === 0) return t("내 릴레이 주소를 알렸어요. 이웃을 찾는 중이에요.");
  return tf("내 릴레이를 {0}명의 이웃과 나누고 있어요", s.peers.length);
}

/** 「어제 3개를 다시 올렸어요」 */
export function resultLine(s: State): string {
  if (!s.republish) return "";
  if (!s.republish_at) return t("아직 확인 전이에요. 켜 두면 알아서 해요.");
  if (!s.republish_ok) return t("큰 릴레이에 닿지 못했어요. 다음에 다시 해 볼게요.");
  const days = Math.max(0, Math.floor(s.now / 86400) - Math.floor(s.republish_at / 86400));
  const n = s.republish_count;
  if (n === 0) {
    if (days === 0) return t("오늘 확인했어요 — 빠진 글이 없어요");
    if (days === 1) return t("어제 확인했어요 — 빠진 글이 없어요");
    return tf("{0}일 전에 확인했어요 — 빠진 글이 없어요", days);
  }
  if (days === 0) return tf("오늘 {0}개를 다시 올렸어요", n);
  if (days === 1) return tf("어제 {0}개를 다시 올렸어요", n);
  return tf("{0}일 전에 {1}개를 다시 올렸어요", days, n);
}

function listHtml(s: State): string {
  const row = (url: string, label: string, removable: boolean) =>
    `<li><span class="rs-url">${esc(url)}</span><span class="meta rs-tag">${esc(label)}</span>` +
    (removable ? `<button class="ghost rs-del" data-rs-remove="${esc(url)}">${copyHtml("지우기")}</button>` : "") + `</li>`;
  return [
    ...s.defaults.map((u) => row(u, t("기본"), false)),
    ...s.extra.map((u) => row(u, t("내가 더함"), true)),
    ...s.peers.map((u) => row(u, t("이웃"), true)),
  ].join("");
}

function paint(s: State) {
  state = s;
  if (!ensureCard()) return;
  const set = (id: string, v: boolean) => { const i = el(id) as HTMLInputElement | null; if (i) i.checked = v; };
  set("rs-on", s.enabled);
  set("rs-republish", s.republish);
  set("rs-outbox", s.outbox_read);
  const status = el("rs-status");
  if (status) {
    setCopyText(status, () => statusLine(s));
    status.classList.toggle("ok", s.enabled && s.sharing);
  }
  const peers = el("rs-peers");
  if (peers) {
    peers.hidden = !s.enabled;
    setCopyText(peers, () => tf("이웃 릴레이 {0}곳", s.peers.length));
  }
  const result = el("rs-result");
  if (result) {
    const line = resultLine(s);
    result.hidden = !line;
    setCopyText(result, () => resultLine(s));
  }
  const list = el("rs-list");
  if (list) list.innerHTML = listHtml(s);
  const outside = el("rs-outside");
  if (outside) outside.hidden = !(s.enabled && s.problem === "no-outside");
  const own = el("rs-own") as HTMLInputElement | null;
  if (own && document.activeElement !== own) own.value = s.own_url ?? "";
  paintKeeper();
}

/* ── 릴레이 지킴이(docs/KEEPER-THANKS.md §1 · src-tauri/src/relay_keeper.rs) ── */
type KDay = { day: string; ok: boolean; reason?: string; at: number };
type KState = {
  sharing: boolean; today: string; today_ok: boolean; last: KDay | null;
  days_ok: number; needed_days: number; busy: boolean;
  result?: { ok: boolean; reason?: string | null; day: string };
};
let kstate: KState | null = null;
let kRelayDays: number | null = null;
let kChecking = false;

const KREASON: Record<string, string> = {
  "bad-url": "이 릴레이 주소는 확인할 수 없는 모양이에요.",
  unreachable: "확인 서버가 바깥에서 내 릴레이로 들어오지 못했어요. 잠시 뒤 다시 해 볼게요.",
  "no-list": "내 릴레이에서 내 주소 목록을 찾지 못했어요. 잠시 뒤 다시 해 볼게요.",
  mismatch: "내 릴레이에 있는 주소 목록이 지금 주소와 달라요. 잠시 뒤 다시 알릴게요.",
  auth: "확인 요청 서명이 맞지 않았어요. 컴퓨터 시계가 맞는지 확인해 주세요.",
  "not-configured": "확인 서버가 아직 준비 중이에요. 나중에 다시 해 볼게요.",
  unavailable: "확인 서버가 잠시 쉬고 있어요. 나중에 다시 해 볼게요.",
  "not-sharing": "릴레이 나누기를 켜고 내 주소를 알린 뒤에 확인할 수 있어요.",
  "no-key": "이야기 이름(열쇠)이 아직 없어요. 이야기 화면을 한 번 열어 주세요.",
  network: "확인 서버에 닿지 못했어요. 인터넷 연결을 확인해 주세요.",
  server: "확인 서버가 알 수 없는 답을 했어요. 나중에 다시 해 볼게요.",
  busy: "이미 확인하는 중이에요.",
};
export const keeperReasonText = (code: string | null | undefined) => KREASON[String(code || "server")] ?? KREASON.server;

export function keeperStatusLine(k: KState): string {
  if (k.busy || kChecking) return t("확인하는 중…");
  if (k.today_ok) return t("오늘 확인됨");
  const code = k.result && !k.result.ok ? k.result.reason : k.last && !k.last.ok && k.last.day === k.today ? k.last.reason : null;
  if (code) return tf("확인 못 함 — {0}", t(keeperReasonText(code)));
  return t("아직 오늘 확인 안 됨");
}

function paintKeeper() {
  const box = el("rs-keeper");
  if (!box) return;
  const k = kstate;
  // 켜 둔 사람에게만 — 꺼져 있으면 확인할 것이 없다.
  box.hidden = !(state?.enabled && k);
  if (!k) return;
  const status = el("rs-k-status");
  if (status) {
    setCopyText(status, () => keeperStatusLine(k));
    status.classList.toggle("ok", k.today_ok);
  }
  const days = el("rs-k-days");
  if (days) {
    const n = Math.max(k.days_ok, kRelayDays ?? 0);
    setCopyText(days, () => tf("최근 30일 중 {0}일", n) + " · " + (n >= k.needed_days ? t("「릴레이 지킴이」 표시가 붙어 있어요") : t("25일이 되면 표시가 붙어요")));
  }
  const btn = el("rs-k-check") as HTMLButtonElement | null;
  if (btn) btn.disabled = k.busy || kChecking || !k.sharing;
}

async function keeperRefresh() {
  try { kstate = await invoke<KState>("relay_keeper_get"); paintKeeper(); } catch { /* 명령이 없는 판 */ }
  try {
    const a = await invoke<{ days_ok: number }>("relay_keeper_awards");
    kRelayDays = a.days_ok;
    paintKeeper();
  } catch { /* 릴레이를 못 읽으면 이 컴퓨터 기록만 */ }
}

async function keeperCheckNow() {
  kChecking = true;
  paintKeeper();
  try { kstate = await invoke<KState>("relay_keeper_check"); } catch { /* 아래에서 다시 읽는다 */ }
  finally { kChecking = false; }
  paintKeeper();
  void keeperRefresh();
}

const ERR: Record<string, string> = {
  "bad-url": "이 주소는 쓸 수 없어요. wss:// 로 시작하는 인터넷 주소만 돼요.",
  already: "이미 쓰고 있는 주소예요.",
  "too-many": "더 이상 더할 수 없어요. 하나를 지우고 더해 주세요.",
};

function showErr(e: unknown) {
  const box = el("rs-err");
  if (!box) return;
  const code = e instanceof Error ? e.message : String(e ?? "");
  setCopyText(box, () => (code ? t(ERR[code] ?? code) : ""));
}

async function refresh() {
  try { paint(await invoke<State>("relay_share_get")); } catch { /* 명령이 없는 판 — 카드만 남는다 */ }
  void keeperRefresh();
}

async function setSwitch(v: { enabled?: boolean; republish?: boolean; outboxRead?: boolean }) {
  try { paint(await invoke<State>("relay_share_set", v)); } catch (e) { showErr(e); }
  // 켜면 뒤에서 한 번 해 본다 — 잠시 뒤 다시 읽는다.
  if (v.enabled) setTimeout(() => void refresh(), 15_000);
}

async function addRelay() {
  const input = el("rs-new") as HTMLInputElement | null;
  const url = (input?.value || "").trim();
  if (!url) return;
  showErr("");
  try {
    paint(await invoke<State>("relay_share_add", { url }));
    if (input) input.value = "";
  } catch (e) { showErr(e); }
}

/** 기본 = 클라우드플레어(「바깥 접속」). 준비물이 없으면 먼저 받는다. */
async function tunnelOn() {
  const btn = el("rs-tunnel-on") as HTMLButtonElement | null;
  const msg = el("rs-tunnel-msg");
  const say = (k: string) => { if (msg) setCopyText(msg, () => t(k)); };
  if (btn) btn.disabled = true;
  try {
    const st = await invoke<{ running?: boolean; installed?: boolean }>("tunnel_status");
    if (!st?.running) {
      if (!st?.installed) { say("준비물을 받는 중입니다. 1~2분 걸립니다."); await invoke("tunnel_install"); }
      say("켜는 중입니다…");
      await invoke("tunnel_start", { port: 8790 });
    }
    say("바깥 접속을 켰어요. 곧 내 릴레이 주소를 알릴게요.");
    await setSwitch({ enabled: true });
  } catch (e) {
    if (msg) msg.textContent = e instanceof Error ? e.message : String(e ?? "");
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function setOwn(url: string) {
  showErr("");
  try {
    paint(await invoke<State>("relay_share_set_own", { url: url.trim() || null }));
    setTimeout(() => void refresh(), 15_000);
  } catch (e) { showErr(e); }
}

async function removeRelay(url: string) {
  if (!url) return;
  showErr("");
  try { paint(await invoke<State>("relay_share_remove", { url })); } catch (e) { showErr(e); }
}

/** 설정 화면에 카드를 붙이고, 설정을 열 때마다 다시 읽는다. */
export function wireRelayShare() {
  if (!ensureCard()) return;
  void refresh();
  window.addEventListener("desktop-language-change", () => { if (state) paint(state); });
  document.addEventListener("click", (e) => {
    const a = (e.target as Element | null)?.closest?.('nav a[data-page="settings"]');
    if (a) void refresh();
  });
}
