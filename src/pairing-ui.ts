/* 설정 › 「폰 연결」 (RV6).
 *
 * 폰으로 QR 을 찍으면 폰에서 이 컴퓨터의 지갑·증서·매출을 보고, 요청을 보낼 수 있다.
 * 🔴 폰 지갑과 이 컴퓨터 지갑은 섞이지 않는다. 복구 단어·개인키·지갑 암호는 이 화면이 다루지 않는다.
 * 🔴 돈이 나가는 일의 기본은 「이 컴퓨터에서 확인」 — 폰 요청을 열면 **기존 보내기 화면**에 채우기만
 *    하고, 사장이 거기서 평소처럼 확인하고 보낸다.
 *
 * main.ts 는 두 줄만 안다: `wirePairing()` 과, 보내기가 끝났을 때 알리는 `rv-sent` 사건.
 * 이 파일이 설정 화면에 카드를 스스로 만들어 넣는다(index.html 은 안 고친다).
 * style="…" 속성은 쓰지 않는다(CSP nonce 가 막는다) — 모양은 pairing-ui.css.
 */
import { invoke } from "@tauri-apps/api/core";
import { copyHtml, setCopyText, t, tf } from "./i18n";
import "./pairing-ui.css";

type Perms = { view: boolean; request: boolean; money: "desktop" | "phone"; daily_limit_rvn: number };
type Ago = { at: number; secs: number };
type Device = { sign: string; name: string; fingerprint: string; perms: Perms; paired: Ago; last_used: Ago; limit_left_rvn: number };
type Req = { id: string; t: string; peer_name: string; body: Record<string, unknown>; status: string; received: Ago; left_secs: number };
type State = {
  ready: boolean; fingerprint?: string; desk_name?: string; qr_live_until?: number | null;
  pending?: { name: string; sas: string; fingerprint: string; want: string[]; left_secs: number } | null;
  devices: Device[]; requests: Req[]; public_backup?: boolean; server_running?: boolean;
};
type Shown = { svg: string; expires_at: number; fingerprint: string; desk_name: string; lan: string | null; outside: boolean };

const esc = (v: unknown) => String(v ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
/** 사용자·폰이 쓴 글. 번역하지 않는다. */
const user = (v: unknown) => `<span translate="no">${esc(v)}</span>`;
const el = (id: string) => document.getElementById(id);

function ago(secs: number): string {
  if (secs < 60) return t("방금");
  if (secs < 3600) return tf("{0}분 전", Math.floor(secs / 60));
  if (secs < 86400) return tf("{0}시간 전", Math.floor(secs / 3600));
  return tf("{0}일 전", Math.floor(secs / 86400));
}
function errText(e: unknown) {
  return e instanceof Error ? e.message : String(e ?? "");
}

let state: State = { ready: false, devices: [], requests: [] };
let shown: Shown | null = null;
let armed: { id: string; to: string; amount: number } | null = null;
let pendingKey = "";
let busy = false;
type Ask = (title: string, message: string) => Promise<boolean>;
let ask: Ask = async (title, message) => window.confirm(`${title}\n${message}`);

const CARD = `
  <h2>${copyHtml("폰 연결")}</h2>
  <p class="meta">${copyHtml("폰으로 QR 을 찍으면, 폰에서 이 컴퓨터의 잔액·증서·매출을 보고 요청을 보낼 수 있어요.")}</p>
  <p class="meta">${copyHtml("폰 지갑과 이 컴퓨터 지갑은 섞이지 않아요. 복구 단어와 개인키는 이 컴퓨터 밖으로 나가지 않아요.")}</p>
  <div class="rvp-qrbox">
    <button id="rvp-show">${copyHtml("폰 연결 QR 보이기")}</button>
    <div id="rvp-qrarea" hidden>
      <div class="rvp-qr" id="rvp-qr" translate="no"></div>
      <div class="rvp-qrside">
        <p><b>${copyHtml("폰에서: RavenVault 앱 › 「데스크톱 연결」 › QR 찍기")}</b></p>
        <p class="meta" id="rvp-left"></p>
        <p class="meta">${copyHtml("이 컴퓨터 확인 글자")}: <b id="rvp-fp" translate="no"></b></p>
        <p class="meta">${copyHtml("QR 은 한 번만 쓸 수 있어요. 새로 띄우면 앞의 QR 은 못 써요.")}</p>
        <p class="warnbox" id="rvp-nolan" hidden>${copyHtml("같은 Wi-Fi 로 바로 잇는 길이 꺼져 있어요. 「폰으로 보기」 서버가 켜져 있는지 확인해 주세요.")}</p>
        <button class="ghost" id="rvp-cancel">${copyHtml("QR 닫기")}</button>
      </div>
    </div>
  </div>
  <div class="rvp-pending" id="rvp-pending" hidden>
    <h3>${copyHtml("폰이 연결하려고 해요")}</h3>
    <p><span class="rvp-name" id="rvp-pname" translate="no"></span></p>
    <p class="meta">${copyHtml("폰 화면의 숫자와 같을 때만 허락하세요. 다르면 거절하세요.")}</p>
    <div class="rvp-sas" id="rvp-sas" translate="no"></div>
    <p class="meta rvp-want" id="rvp-want" hidden>${copyHtml("이 폰은 「요청」 권한도 원해요. 필요할 때만 켜 주세요.")}</p>
    <p class="meta" id="rvp-pleft"></p>
    <fieldset class="rvp-perms">
      <legend>${copyHtml("이 폰이 할 수 있는 일")}</legend>
      <label><input type="checkbox" id="rvp-view" checked /> ${copyHtml("보기 — 잔액·자산·증서·매출")}</label>
      <label><input type="checkbox" id="rvp-request" /> ${copyHtml("요청 — 증서 만들기·손님 QR 띄우기·보내기 요청")}</label>
      <p class="rvp-sub">${copyHtml("돈이 나가는 일")}</p>
      <label><input type="radio" name="rvp-money" id="rvp-money-desk" value="desktop" checked /> ${copyHtml("이 컴퓨터에서 확인 (기본)")}</label>
      <label><input type="radio" name="rvp-money" id="rvp-money-phone" value="phone" /> ${copyHtml("폰 승인 허용 — 하루 한도 안에서만")}</label>
      <label class="rvp-limit">${copyHtml("하루 한도 (RVN, 최근 24시간)")} <input type="number" id="rvp-limit" min="0" step="1" value="0" /></label>
      <p class="meta">${copyHtml("폰 승인이어도 지갑이 잠겨 있으면 풀릴 때까지 기다려요. 자산 보내기는 언제나 이 컴퓨터에서 확인해요.")}</p>
    </fieldset>
    <div class="rvp-row">
      <button id="rvp-allow">${copyHtml("허락")}</button>
      <button class="ghost" id="rvp-deny">${copyHtml("거절하기")}</button>
    </div>
  </div>
  <p class="meta" id="rvp-say" aria-live="polite"></p>
  <h3>${copyHtml("연결된 기기")}</h3>
  <div id="rvp-devices"></div>
  <h3>${copyHtml("폰 요청")}</h3>
  <p class="meta">${copyHtml("폰이 보낸 요청은 24시간 기다려요. 열면 이 컴퓨터의 원래 화면으로 가요.")}</p>
  <div id="rvp-requests"></div>
  <div class="rvp-detail" id="rvp-detail" hidden></div>
  <label class="rvp-public"><input type="checkbox" id="rvp-public" /> ${copyHtml("공개 Nostr 중계도 예비 통로로 쓰기 (기본 끔)")}</label>
  <p class="meta">${copyHtml("공개 중계는 내용은 못 보지만, 언제 어느 기기끼리 주고받는지는 볼 수 있어요.")}</p>
`;

function say(render: () => string) {
  const s = el("rvp-say");
  if (s) setCopyText(s, render);
}

function kindLabel(kind: string) {
  return ({ "req.send": "보내기 요청", "req.cert": "증서 만들기 요청", "req.guestqr": "손님 QR 띄우기" } as Record<string, string>)[kind] || "요청";
}
function permsText(p: Perms) {
  const parts: string[] = [];
  if (p.view) parts.push(copyHtml("보기"));
  if (p.request) parts.push(copyHtml("요청"));
  parts.push(p.money === "phone" ? `${copyHtml("폰 승인")} <span translate="no">${esc(p.daily_limit_rvn)} RVN</span>` : copyHtml("돈은 이 컴퓨터에서 확인"));
  return parts.join(" · ");
}
function summary(r: Req) {
  const b = r.body || {};
  if (r.t === "req.send") return `<span translate="no">${esc(b.amount_rvn)} RVN → ${esc(b.to)}</span>`;
  if (r.t === "req.cert") return user([b.title, b.holder, b.count ? `×${b.count}` : ""].filter(Boolean).join(" · "));
  return b.memo ? user(b.memo) : "";
}

function paintDevices() {
  const box = el("rvp-devices");
  if (!box) return;
  if (!state.devices.length) {
    box.innerHTML = `<p class="meta">${copyHtml("아직 연결된 폰이 없어요.")}</p>`;
    return;
  }
  box.innerHTML = state.devices.map((d, i) => `
    <div class="rvp-item">
      <div class="rvp-itemmain">
        <b translate="no">${esc(d.name)}</b> <span class="meta" translate="no">${esc(d.fingerprint)}</span>
        <p class="meta">${permsText(d.perms)}</p>
        <p class="meta">${copyHtml("마지막 사용")}: <span id="rvp-used-${i}"></span></p>
      </div>
      <button class="ghost" data-unpair="${esc(d.sign)}">${copyHtml("연결 끊기")}</button>
    </div>`).join("");
  state.devices.forEach((d, i) => { const s = el(`rvp-used-${i}`); if (s) setCopyText(s, () => ago(d.last_used.secs)); });
}

function paintRequests() {
  const box = el("rvp-requests");
  if (!box) return;
  if (!state.requests.length) {
    box.innerHTML = `<p class="meta">${copyHtml("기다리는 요청이 없어요.")}</p>`;
    return;
  }
  box.innerHTML = state.requests.map((r, i) => `
    <div class="rvp-item">
      <div class="rvp-itemmain">
        <b>${copyHtml(kindLabel(r.t))}</b> · <span translate="no">${esc(r.peer_name)}</span>
        <p>${summary(r)}</p>
        <p class="meta" id="rvp-rq-${i}"></p>
      </div>
      <div class="rvp-row">
        <button data-open="${esc(r.id)}">${copyHtml("열기")}</button>
        <button class="ghost" data-decline="${esc(r.id)}">${copyHtml("거절하기")}</button>
      </div>
    </div>`).join("");
  state.requests.forEach((r, i) => {
    const s = el(`rvp-rq-${i}`);
    if (!s) return;
    const note = r.status === "waiting_unlock" ? () => t("폰 승인 보내기 — 지갑이 잠겨 있어 기다리는 중")
      : r.status === "opened" ? () => t("보내기 화면에서 확인하는 중")
      : () => tf("{0} · 남은 시간 {1}시간", ago(r.received.secs), Math.max(1, Math.ceil(r.left_secs / 3600)));
    setCopyText(s, note);
  });
}

function paintPending() {
  const p = state.pending;
  const box = el("rvp-pending")!;
  box.hidden = !p;
  if (!p) { pendingKey = ""; return; }
  const key = p.name + p.sas;
  if (key !== pendingKey) {
    pendingKey = key;
    (el("rvp-view") as HTMLInputElement).checked = true;
    // 🔴 폰이 원한다고 미리 켜지 않는다 — 권한은 사장이 정한다(기본: 보기만).
    (el("rvp-request") as HTMLInputElement).checked = false;
    (el("rvp-money-desk") as HTMLInputElement).checked = true;
    (el("rvp-limit") as HTMLInputElement).value = "0";
    box.scrollIntoView({ behavior: "smooth", block: "center" });
  }
  el("rvp-pname")!.textContent = p.name;
  el("rvp-want")!.hidden = !p.want.includes("request") && !p.want.includes("money");
  el("rvp-sas")!.textContent = `${p.sas.slice(0, 3)} ${p.sas.slice(3)}`;
  setCopyText(el("rvp-pleft")!, () => tf("{0}분 안에 허락하지 않으면 자동으로 거절돼요.", Math.max(1, Math.ceil(p.left_secs / 60))));
  // 요청을 켜야 돈 방식이 뜻이 있다.
  const req = (el("rvp-request") as HTMLInputElement).checked;
  for (const id of ["rvp-money-desk", "rvp-money-phone", "rvp-limit"]) (el(id) as HTMLInputElement).disabled = !req;
  (el("rvp-limit") as HTMLInputElement).disabled = !req || !(el("rvp-money-phone") as HTMLInputElement).checked;
}

function paintQr() {
  const area = el("rvp-qrarea")!;
  const now = Math.floor(Date.now() / 1000);
  const live = !!shown && now <= shown.expires_at && !state.pending && (state.qr_live_until ?? 0) > 0;
  area.hidden = !live;
  (el("rvp-show") as HTMLButtonElement).hidden = live;
  if (!live || !shown) return;
  const left = shown.expires_at - now;
  setCopyText(el("rvp-left")!, () => tf("남은 시간 {0}:{1}", Math.floor(left / 60), String(left % 60).padStart(2, "0")));
  el("rvp-fp")!.textContent = shown.fingerprint;
  el("rvp-nolan")!.hidden = !!shown.lan;
}

function paint() {
  if (!el("rvp-card")) return;
  paintQr();
  paintPending();
  paintDevices();
  paintRequests();
  (el("rvp-public") as HTMLInputElement).checked = !!state.public_backup;
  (el("rvp-public") as HTMLInputElement).disabled = !state.ready;
}

async function refresh() {
  try {
    const s = await invoke<State | null>("pairing_state", { tzOffsetMin: -new Date().getTimezoneOffset() });
    state = s && typeof s === "object" ? { ...{ devices: [], requests: [] }, ...s } : { ready: false, devices: [], requests: [] };
  } catch {
    state = { ready: false, devices: [], requests: [] };
  }
  paint();
}

async function act(run: () => Promise<void>) {
  if (busy) return;
  busy = true;
  try { await run(); } catch (e) { const m = errText(e); say(() => t(m)); } finally { busy = false; await refresh(); }
}

function go(where: string) {
  window.dispatchEvent(new CustomEvent("rv-go", { detail: where }));
}

async function openRequest(id: string) {
  const r = await invoke<{ id: string; t: string; body: Record<string, unknown>; peer_name: string }>("pairing_request_open", { id });
  const detail = el("rvp-detail")!;
  if (r.t === "req.send") {
    const to = String(r.body.to ?? ""), amount = Number(r.body.amount_rvn ?? 0);
    armed = { id: r.id, to, amount };
    // 기존 보내기 화면으로 가서 채우기만 한다. 사장이 거기서 평소처럼 확인하고 보낸다.
    (document.querySelector('nav [data-page="wallet"]') as HTMLElement | null)?.click();
    (el("w-send-rvn") as HTMLButtonElement | null)?.click();
    window.setTimeout(() => {
      const a = el("s-addr") as HTMLInputElement | null, q = el("s-qty") as HTMLInputElement | null;
      if (a && q) {
        a.value = to; q.value = String(amount);
        a.dispatchEvent(new Event("input", { bubbles: true }));
        q.dispatchEvent(new Event("input", { bubbles: true }));
      }
    }, 50);
    say(() => t("보내기 화면에 채워 두었어요. 받는 주소와 금액을 다시 확인하고 보내세요."));
    return;
  }
  if (r.t === "req.guestqr") {
    go("qr");
    await invoke("pairing_request_done", { id: r.id, txid: null }).catch(() => {});
    return;
  }
  // 증서 만들기: 폰이 적은 것을 보여 주고, 만들기 화면으로 간다(사진·엑셀은 이 컴퓨터에서 붙인다).
  const b = r.body;
  detail.hidden = false;
  detail.innerHTML = `
    <b>${copyHtml("증서 만들기 요청")}</b> · <span translate="no">${esc(r.peer_name)}</span>
    <dl>
      <dt>${copyHtml("제목")}</dt><dd translate="no">${esc(b.title)}</dd>
      ${b.holder ? `<dt>${copyHtml("받는 사람")}</dt><dd translate="no">${esc(b.holder)}</dd>` : ""}
      ${b.count ? `<dt>${copyHtml("장수")}</dt><dd translate="no">${esc(b.count)}</dd>` : ""}
      ${b.note ? `<dt>${copyHtml("메모")}</dt><dd translate="no">${esc(b.note)}</dd>` : ""}
    </dl>
    <p class="meta">${copyHtml("사진·엑셀은 이 컴퓨터에서 붙여 주세요. 만들기 화면에서 평소처럼 확인하고 발행해요.")}</p>
    <div class="rvp-row"><button id="rvp-gocreate">${copyHtml("만들기 화면으로")}</button><button class="ghost" id="rvp-closedetail">${copyHtml("닫기")}</button></div>`;
  el("rvp-gocreate")!.onclick = () => go("create");
  el("rvp-closedetail")!.onclick = () => { detail.hidden = true; };
}

function wireCard(card: HTMLElement) {
  card.addEventListener("click", (ev) => {
    const b = (ev.target as HTMLElement).closest("button");
    if (!b) return;
    if (b.id === "rvp-show") void act(async () => {
      // 같은 Wi-Fi 직통은 이 컴퓨터 릴레이(폰 서버)에 붙는다. 「QR 보이기」를 누른 사람은 켜고 싶다는 뜻이다
      // (「손님 QR」과 같은 규칙). 이미 켜져 있으면 그대로다.
      if (!state.server_running) await Promise.race([invoke("start_phone_server"), new Promise((r) => setTimeout(r, 20000))]).catch(() => {});
      shown = await invoke<Shown>("pairing_show_qr");
      el("rvp-qr")!.innerHTML = shown.svg;
      say(() => "");
    });
    else if (b.id === "rvp-cancel") void act(async () => { shown = null; await invoke("pairing_cancel_qr"); });
    else if (b.id === "rvp-allow") void act(async () => {
      const request = (el("rvp-request") as HTMLInputElement).checked;
      const phone = request && (el("rvp-money-phone") as HTMLInputElement).checked;
      const limit = Math.max(0, Math.floor(Number((el("rvp-limit") as HTMLInputElement).value) || 0));
      const r = await invoke<{ name: string }>("pairing_approve", {
        view: (el("rvp-view") as HTMLInputElement).checked, request, money: phone ? "phone" : "desktop", dailyLimitRvn: phone ? limit : 0,
      });
      shown = null;
      say(() => tf("{0} 폰과 연결했어요.", r.name));
    });
    else if (b.id === "rvp-deny") void act(async () => { shown = null; await invoke("pairing_reject"); say(() => t("거절했어요. 폰에는 연결이 안 돼요.")); });
    else if (b.dataset.unpair) {
      const sign = b.dataset.unpair;
      void act(async () => {
        if (!(await ask(t("이 폰과 연결을 끊을까요?"), t("끊으면 그 폰은 바로 아무것도 못 해요. 다시 쓰려면 QR 로 새로 연결해요.")))) return;
        await invoke("pairing_unpair", { sign });
        say(() => t("연결을 끊었어요."));
      });
    } else if (b.dataset.open) {
      const id = b.dataset.open;
      void act(() => openRequest(id));
    } else if (b.dataset.decline) {
      const id = b.dataset.decline;
      void act(async () => { await invoke("pairing_request_decline", { id }); say(() => t("요청을 거절했어요. 폰에 알렸어요.")); });
    }
  });
  card.addEventListener("change", (ev) => {
    const target = ev.target as HTMLInputElement;
    if (target.id === "rvp-public") void act(async () => { await invoke("pairing_set_public_backup", { on: target.checked }); });
    else paintPending();
  });
}

/** 설정 화면에 「폰 연결」 카드를 넣고, 구석 알림과 보내기 끝 알림을 잇는다. */
export function wirePairing(confirmBox?: Ask) {
  if (confirmBox) ask = confirmBox;
  const settings = document.getElementById("page-settings");
  if (!settings || document.getElementById("rvp-card")) return;
  const card = document.createElement("div");
  card.className = "card rvp";
  card.id = "rvp-card";
  card.innerHTML = CARD;
  const lang = settings.querySelector(".desktop-language-settings");
  if (lang) lang.after(card); else settings.prepend(card);
  wireCard(card);

  // 구석 알림 — 설정을 안 보고 있어도 폰 요청·연결 요청을 놓치지 않게.
  const notice = document.createElement("button");
  notice.id = "rvp-notice";
  notice.className = "rvp-notice";
  notice.hidden = true;
  document.body.append(notice);
  notice.addEventListener("click", () => {
    (document.querySelector('nav [data-page="settings"]') as HTMLElement | null)?.click();
    window.setTimeout(() => card.scrollIntoView({ behavior: "smooth", block: "start" }), 80);
  });

  // 기존 보내기 화면에서 보내기가 끝났다 → 그게 폰 요청이었다면 폰에 「완료」.
  window.addEventListener("rv-sent", (ev) => {
    const d = (ev as CustomEvent).detail as { txid?: string; address?: string; amount?: number; what?: string } | undefined;
    if (!armed || !d || d.what !== "RVN" || d.address !== armed.to || Math.abs(Number(d.amount) - armed.amount) > 1e-9 || !d.txid) return;
    const id = armed.id;
    armed = null;
    void invoke("pairing_request_done", { id, txid: d.txid }).catch(() => {});
  });

  const onSettings = () => document.getElementById("page-settings")?.classList.contains("on");
  let lastSeenGuest = new Set<string>();
  window.setInterval(() => {
    if (onSettings()) notice.hidden = true;
    if (onSettings()) void refresh();
    else paintQr();
  }, 2000);
  window.setInterval(() => { if (onSettings()) paintQr(); }, 1000);
  const poll = async () => {
    try {
      const w = await invoke<{ requests: number; pending: boolean; guestqr: string[] } | null>("pairing_waiting");
      const n = w?.requests ?? 0, pending = !!w?.pending;
      notice.hidden = !(n || pending) || !!onSettings();
      setCopyText(notice, () => pending ? t("폰이 연결을 기다려요 — 확인하기") : tf("폰 요청 {0}건 — 보기", n));
      // 손님 QR 띄우기는 확인 없이 바로(허락할 때 「요청」을 준 폰만 보낼 수 있다).
      for (const id of w?.guestqr ?? []) {
        if (lastSeenGuest.has(id)) continue;
        lastSeenGuest.add(id);
        void act(() => openRequest(id));
      }
      if (lastSeenGuest.size > 200) lastSeenGuest = new Set();
    } catch { notice.hidden = true; }
  };
  window.setInterval(poll, 10_000);
  void poll();
  void refresh();
}
