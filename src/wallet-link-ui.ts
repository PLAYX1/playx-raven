// 설정 → 「폰과 지갑 연결」 + 폰 요청 승인 창.
// 비밀(연결 열쇠·복구 단어·암호 저장)은 화면에 없다 — 서명·봉인·지급은 전부 러스트(src-tauri/src/wallet_link.rs).
// 화면은 공개 값(연결 제안·확인 숫자·요청 내용·수수료)만 보여 주고, 사람이 누른 것만 러스트에 전한다.
// 🔴 자동 승인 없음: 승인 단추는 사람이 누를 때만 wallet_link_approve 를 부른다.
import { getCurrentWindow, UserAttentionType } from "@tauri-apps/api/window";
import { t, tf } from "./i18n";
import { MATCH_BEAT_MS, MATCH_COLOR_HEX, MATCH_COLOR_NAME, MATCH_SHAPE_NAME, MATCH_SHAPE_PATH, matchSymbols } from "../core/wallet-link/match-symbols";

type Invoke = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;
type Offer = { v: 1; chain: "rvn-main"; account: 0; desktopKey: string; name: string; xpub: string; firstAddress: string; nonce: string; expires: number };
type SellPolicy = { enabled: boolean; daily: number; today: number };
type LinkRow = { linkId: string; name: string; phoneAddresses: string[]; dailySats: string; spentToday: string; created: number; revoked: boolean; sell?: SellPolicy; talkSame?: boolean | null };
/** 폰에서 판매(0.9.18) 일 하나. 러스트 wallet_link/sell.rs jobs_view 모양. */
type SellRow = { id: string; linkId: string; phoneName: string; status: string; resume: string | null; reason: string | null; asset: string; amount: string;
  priceSats: string; title: string; category: string; d: string | null; eventId: string | null; received: number; updated: number };
type Pending = { id: string; linkId: string; phoneName: string; kind: "fill" | "send"; to: string; sats: string; created: number; expires: number };
type Inbox = { pending: Pending[]; links: LinkRow[]; sells?: SellRow[]; online?: boolean;
  offer: null | { stage: "waiting"; expires: number } | { stage: "cancelled" } | { stage: "confirm"; code: string; phoneKey: string; phoneAddresses: string[]; offer: Offer } };
type Review = { id: string; short: boolean; kind?: "fill" | "send"; to?: string; sats?: string; feeSats?: string; totalSats?: string; fingerprint?: string; phoneName?: string; expires?: number };

const $ = (id: string) => document.getElementById(id) as HTMLElement;
const errOf = (e: unknown) => (typeof e === "string" ? e : (e as Error)?.message || t("알 수 없는 오류"));
/** 사토시 글자 → 「12.5」 RVN. 부동소수 없이. */
export function rvn(sats: string): string {
  if (!/^\d+$/.test(sats)) return "?";
  const n = BigInt(sats), whole = n / 100000000n, frac = (n % 100000000n).toString().padStart(8, "0").replace(/0+$/, "");
  return whole.toLocaleString("en-US") + (frac ? "." + frac : "");
}
const shortAddr = (a: string) => `${a.slice(0, 4)} … ${a.slice(-4)}`;
/** 「한도 없음」 = RVN 총발행량(21,000,000,000 RVN). 폰 core 의 LINK_DAILY_SATS · 러스트 DAILY_MAX_SATS 와 같다. */
export const NO_LIMIT_RVN = "21000000000";
const NO_LIMIT_SATS = "2100000000000000000";
/** 11-08 연결할 때 열쇠 확인(docs/SYNC-ARCHIVE.md §3) — 모르면(옛 폰·이야기 이름 없음) 빈 글. */
const talkLine = (same: unknown) => same === true ? t("폰과 컴퓨터가 같은 이야기 이름이에요 — 글이 한곳에 모여요")
  : same === false ? t("폰과 컴퓨터의 이야기 이름이 달라요. 같은 12단어로 맞추면 글이 한곳에 모여요") : "";
const limitText = (sats: string) => (sats === NO_LIMIT_SATS ? t("한도 없음") : `${rvn(sats)} RVN`);

/** 홈·사이드바가 듣는 요약: 살아 있는 연결 수 · 승인을 기다리는 요청 수. */
export type WalletLinkState = { linked: number; waiting: number };

/** 판매 일 상태 → 쉬운 말. */
const SELL_STATUS: Record<string, string> = {
  queued: "준비 중", lot: "묶음이 장부에 들어가길 기다려요", lot_ready: "판매 제안 만드는 중", offered: "장터에 올리는 중", published: "올라가 있음",
  cancelling: "내리는 중", pending_human: "이 컴퓨터에서 지갑 암호가 필요해요", refused: "거절됨", failed: "못 올렸어요", cancelled: "내렸어요", sold: "팔렸음",
};
const SELL_REASON: Record<string, string> = {
  "not-held": "그만큼 가진 자산이 없어요", "daily-count": "오늘 판매 건수를 다 썼어요", "sell-off": "판매 허용이 꺼져 있어요", "owner-token": "주인 토큰은 팔 수 없어요",
  price: "값은 1 RVN 이상이어야 해요", asset: "자산 이름이 올바르지 않아요", expired: "폰 요청 시간(10분)이 지났어요", future: "폰 시계가 맞지 않아요",
  timeout: "2시간 안에 올리지 못했어요", refused: "이 컴퓨터에서 거절했어요", revoked: "연결을 끊었어요",
};
const sellStatusText = (j: SellRow) => {
  const base = t(SELL_STATUS[j.status] ?? j.status);
  const why = j.reason && (j.status === "refused" || j.status === "failed" || j.status === "cancelled") ? t(SELL_REASON[j.reason] ?? j.reason) : "";
  return why ? `${base} · ${why}` : base;
};

const calmMotion = () => { try { return matchMedia("(prefers-reduced-motion: reduce)").matches; } catch { return false; } };
/** 확인 숫자를 그림 4개로(폰과 같은 규칙 core/wallet-link/match-symbols.ts). 두 화면이 각자 시계로 같은 박자에 깜빡인다. */
function paintMatchSymbols(code: string) {
  const box = $("wl-syms");
  box.replaceChildren();
  const syms = matchSymbols(code);
  box.hidden = !syms;
  if (!syms) return;
  const delay = `-${Date.now() % MATCH_BEAT_MS}ms`;
  for (const m of syms) {
    const cell = document.createElement("span"); cell.className = "wl-sym";
    const ns = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(ns, "svg"); svg.setAttribute("viewBox", "0 0 24 24"); svg.setAttribute("aria-hidden", "true");
    const path = document.createElementNS(ns, "path"); path.setAttribute("d", MATCH_SHAPE_PATH[m.shape]); path.setAttribute("fill", MATCH_COLOR_HEX[m.color]);
    svg.append(path);
    const name = document.createElement("small"); name.textContent = `${t(MATCH_COLOR_NAME[m.color])} ${t(MATCH_SHAPE_NAME[m.shape])}`;
    cell.append(svg, name);
    cell.style.animationDelay = delay;
    box.append(cell);
  }
  box.setAttribute("aria-label", syms.map(m => `${t(MATCH_COLOR_NAME[m.color])} ${t(MATCH_SHAPE_NAME[m.shape])}`).join(", "));
}
/** 연결이 끝난 순간 — 라비가 폴짝 뛰어 폰으로 건너가고, 작은 소리. 확인(러스트 저장)이 끝난 뒤에만 부른다. */
function celebrateLinked() {
  const card = document.getElementById("wl-card");
  if (!card) return;
  document.getElementById("wl-done")?.remove();
  const done = document.createElement("div"); done.id = "wl-done"; done.className = "wl-done"; done.setAttribute("role", "status");
  const img = document.createElement("img"); img.src = "/raven-happy.webp"; img.alt = ""; img.className = "wl-done-ravi";
  const text = document.createElement("p"); text.textContent = t("폰과 이어졌어요. 라비가 폰으로 건너갔어요.");
  done.append(img, text);
  card.querySelector("h3")?.after(done);
  if (!calmMotion()) {
    try {
      const ac = new AudioContext(), now = ac.currentTime;
      [659.25, 987.77, 1318.5].forEach((f, i) => { const o = ac.createOscillator(), g = ac.createGain(); o.type = "sine"; o.frequency.value = f;
        g.gain.setValueAtTime(0, now + i * .09); g.gain.linearRampToValueAtTime(.06, now + i * .09 + .02); g.gain.exponentialRampToValueAtTime(.0001, now + i * .09 + .9);
        o.connect(g).connect(ac.destination); o.start(now + i * .09); o.stop(now + i * .09 + 1); });
      setTimeout(() => { void ac.close(); }, 2000);
    } catch { /* 소리는 덤 */ }
  }
  setTimeout(() => done.classList.add("wl-done-rest"), 2400);
}

export function wireWalletLink(deps: { invoke: Invoke; ask: (why: "link" | "limit" | "sell" | "unsell") => Promise<string | null>; onState?: (s: WalletLinkState) => void }) {
  const { invoke } = deps;
  let offer: Offer | null = null, offerTimer: ReturnType<typeof setInterval> | undefined;
  let pollTimer: ReturnType<typeof setTimeout> | undefined, polling = false, links: LinkRow[] = [], pending: Pending[] = [], sells: SellRow[] = [];
  let sellShown: string | null = null, sellBusy = false;
  let shown: string | null = null, review: Review | null = null, approving = false, deferred = new Set<string>(), editing: string | null = null;
  const msg = (text: string, bad = false) => { const m = $("wl-msg"); m.textContent = text; m.classList.toggle("wl-bad", bad); };

  // ── 연결 만들기 ──
  const agree = $("wl-agree") as HTMLInputElement, make = $("wl-make") as HTMLButtonElement;
  agree.onchange = () => { make.disabled = !agree.checked; $("wl-agree-hint").hidden = agree.checked; };
  make.disabled = true;
  function stopOffer() { offer = null; clearInterval(offerTimer); $("wl-qr").hidden = true; $("wl-confirm").hidden = true; make.hidden = false; }
  async function showOffer(o: Offer) {
    // 러스트가 준 제안을 폰과 같은 규격 코드로 한 번 더 읽는다: 첫 주소가 이 xpub 에서 나온 것인지까지.
    const link = await import("../core/wallet-link/link");
    const text = link.encodeLinkOffer(o);
    link.parseLinkOffer(text, Date.now());
    const svg = await invoke<string>("qr_svg", { text });
    offer = o;
    const img = $("wl-qrimg") as HTMLImageElement;
    img.src = `data:image/svg+xml,${encodeURIComponent(svg)}`;
    $("wl-qr").hidden = false; $("wl-confirm").hidden = true; make.hidden = true;
    ($("wl-again") as HTMLButtonElement).hidden = true;
    const tick = () => {
      const left = Math.ceil((o.expires - Date.now()) / 1000);
      if (left > 0) { $("wl-left").textContent = tf("남은 시간 {0}초", left); return; }
      img.removeAttribute("src");
      $("wl-left").textContent = t("1분이 지나 QR 을 숨겼어요. 폰에서 이미 찍었다면 그대로 기다려 주세요.");
      ($("wl-again") as HTMLButtonElement).hidden = false;
      clearInterval(offerTimer);
    };
    clearInterval(offerTimer); offerTimer = setInterval(tick, 1000); tick();
    schedule(1500);
  }
  make.onclick = async () => {
    if (!agree.checked) return;
    msg("");
    const password = await deps.ask("link");
    if (!password) return;
    make.disabled = true;
    try {
      const pendingOffer = invoke<Offer>("wallet_link_offer", { passphrase: password, name: ($("wl-name") as HTMLInputElement).value });
      await showOffer(await pendingOffer);
      msg(t("폰의 지갑 고르기 → 「데스크탑 지갑 연결」에서 이 QR 을 찍어 주세요."));
    } catch (e) { msg(errOf(e), true); }
    finally { make.disabled = !agree.checked; }
  };
  $("wl-again").onclick = async () => {
    try { await showOffer(await invoke<Offer>("wallet_link_offer_again")); }
    catch (e) { stopOffer(); msg(errOf(e), true); }
  };
  const cancelOffer = async (text: string) => { stopOffer(); await invoke("wallet_link_cancel").catch(() => {}); msg(text); };
  $("wl-stop").onclick = () => void cancelOffer(t("연결을 그만뒀어요."));
  $("wl-no").onclick = () => void cancelOffer(t("숫자가 달라 연결하지 않았어요. 다른 사람이 QR 을 찍었을 수 있어요. 처음부터 다시 해 주세요."));
  async function showConfirm(o: Offer, phoneKey: string, code: string, addresses: string[]) {
    // 확인 숫자는 러스트와 폰 규격 코드가 같아야 보여 준다.
    const link = await import("../core/wallet-link/link");
    if (link.linkConfirmCode(o, phoneKey) !== code) { await cancelOffer(t("확인 숫자를 맞춰 보지 못해 연결하지 않았어요.")); return; }
    clearInterval(offerTimer);
    // 11-08 연결 장면: 폰이 찍으면 QR 이 빛으로 흩어지고(움직임 줄이기면 건너뜀), 확인 숫자를 그림 4개로도 보인다.
    if (!calmMotion()) { $("wl-qrimg").classList.add("wl-dissolve"); await new Promise(r => setTimeout(r, 650)); }
    $("wl-qrimg").classList.remove("wl-dissolve");
    $("wl-qr").hidden = true; $("wl-confirm").hidden = false;
    paintMatchSymbols(code);
    $("wl-code").textContent = `${code.slice(0, 3)} ${code.slice(3)}`;
    $("wl-phoneaddr").textContent = addresses.join("\n");
  }
  // 「한도 없음」을 켜면 숫자 칸은 쓰지 않는다(총발행량을 저장한다). 승인은 그대로 매번 사람이 한다.
  ($("wl-nolimit") as HTMLInputElement).onchange = () => { ($("wl-daily") as HTMLInputElement).disabled = ($("wl-nolimit") as HTMLInputElement).checked; };
  $("wl-yes").onclick = async () => {
    try {
      const daily = ($("wl-nolimit") as HTMLInputElement).checked ? NO_LIMIT_RVN : ($("wl-daily") as HTMLInputElement).value;
      const done = await invoke<{ talkSame?: boolean | null }>("wallet_link_confirm", { dailyRvn: daily, phoneName: ($("wl-phonename") as HTMLInputElement).value });
      stopOffer(); agree.checked = false; make.disabled = true; $("wl-agree-hint").hidden = false;
      const same = talkLine(done?.talkSame);
      msg(t("연결했어요. 폰에서 이 컴퓨터 지갑의 잔액과 받는 주소를 볼 수 있어요.") + (same ? ` ${same}` : ""));
      celebrateLinked();
      await refresh();
    } catch (e) { msg(errOf(e), true); }
  };

  // ── 연결된 폰 목록 ──
  function renderLinks() {
    const box = $("wl-list");
    const live = links.filter(l => !l.revoked);
    // 한도를 고치는 중이면 목록을 다시 그리지 않는다(몇 초마다 오는 확인이 적던 칸을 지우지 않게).
    if (!editing || !live.some(l => l.linkId === editing)) { editing = null; box.replaceChildren(...live.map(linkRow), ...orphanBlock()); }
    $("wl-empty").hidden = live.length > 0;
    const waiting = pending.length + sells.filter(j => j.status === "pending_human").length;
    $("wl-waiting").hidden = waiting === 0;
    $("wl-waiting-n").textContent = tf("폰이 보낸 요청 {0}건이 승인을 기다려요.", waiting);
    deps.onState?.({ linked: live.length, waiting });
  }
  function linkRow(l: LinkRow) {
    const row = document.createElement("div"); row.className = "wl-row";
    const txt = document.createElement("div"); txt.className = "wl-rowtxt";
    const b = document.createElement("b"); b.textContent = l.name; b.translate = false;
    const d = document.createElement("span"); d.className = "wl-d";
    d.textContent = tf("하루 한도 {0} · 오늘 나간 것 {1} RVN · {2} 연결", limitText(l.dailySats), rvn(l.spentToday), new Date(l.created).toLocaleDateString());
    const left = document.createElement("span"); left.className = "wl-left";
    const room = /^\d+$/.test(l.dailySats) && /^\d+$/.test(l.spentToday) ? BigInt(l.dailySats) - BigInt(l.spentToday) : 0n;
    left.textContent = l.dailySats === NO_LIMIT_SATS ? t("오늘 남은 한도: 한도 없음") : tf("오늘 남은 한도 {0} RVN", rvn((room > 0n ? room : 0n).toString()));
    txt.append(b, d, left);
    const same = talkLine(l.talkSame);
    if (same) { const k = document.createElement("span"); k.className = l.talkSame ? "wl-d" : "wl-d wl-talk-diff"; k.textContent = same; txt.append(k); }
    const btns = document.createElement("div"); btns.className = "wl-rowbtns";
    const lim = document.createElement("button"); lim.className = "ghost"; lim.type = "button"; lim.textContent = t("한도 바꾸기");
    const cut = document.createElement("button"); cut.className = "ghost"; cut.type = "button"; cut.textContent = t("끊기");
    lim.onclick = () => openLimit(l, txt, btns);
    cut.onclick = async () => {
      cut.disabled = true;
      try { await invoke("wallet_link_revoke", { linkId: l.linkId }); msg(tf("「{0}」 연결을 끊었어요. 기다리던 요청도 모두 버렸어요.", l.name)); await refresh(); }
      catch (e) { msg(errOf(e), true); cut.disabled = false; }
    };
    btns.append(lim, cut);
    txt.append(sellBox(l));
    row.append(txt, btns);
    return row;
  }
  // ── 폰에서 판매(0.9.18) ──
  /** 줄 안: 「폰에서 판매 허용」(기본 꺼짐) + 하루 최대 건수 + 이 폰이 맡긴 판매 목록·내리기. */
  function sellBox(l: LinkRow) {
    const pol = l.sell ?? { enabled: false, daily: 3, today: 0 };
    const box = document.createElement("div"); box.className = "wl-sell";
    const on = document.createElement("label"); on.className = "check";
    const onBox = document.createElement("input"); onBox.type = "checkbox"; onBox.checked = pol.enabled;
    const onTxt = document.createElement("span"); onTxt.textContent = " " + t("폰에서 판매 허용");
    on.append(onBox, onTxt);
    const per = document.createElement("label"); per.className = "wl-d";
    per.textContent = t("하루 최대 건수") + " ";
    const sel = document.createElement("select"); sel.setAttribute("aria-label", t("하루 최대 건수"));
    for (let n = 1; n <= 20; n++) { const o = document.createElement("option"); o.value = String(n); o.textContent = String(n); sel.append(o); }
    sel.value = String(pol.daily);
    per.append(sel);
    const note = document.createElement("span"); note.className = "wl-d";
    note.textContent = pol.enabled
      ? tf("폰이 서명한 「팔아 줘」로 이 컴퓨터 지갑의 자산을 장터에 올려요 · 오늘 {0}/{1}건", pol.today, pol.daily)
      : t("켜면 폰에서 이 컴퓨터 지갑의 자산을 장터에 올릴 수 있어요. 사는 사람 돈은 건드리지 않아요. 켤 때 지갑 암호가 필요해요.");
    const go = async (enabled: boolean, daily: number) => {
      let pass: string | null = null;
      if (enabled) { pass = await deps.ask("sell"); if (!pass) { renderLinks(); return; } }
      onBox.disabled = sel.disabled = true;
      try {
        apply(await invoke<Inbox>("wallet_link_set_sell", { linkId: l.linkId, enabled, daily, passphrase: pass }));
        msg(enabled ? tf("「{0}」 폰에서 판매를 허용했어요(하루 {1}건까지).", l.name, daily) : tf("「{0}」 폰에서 판매를 껐어요. 올리기 전 일은 멈췄어요.", l.name));
      } catch (e) { msg(errOf(e), true); renderLinks(); }
    };
    onBox.onchange = () => void go(onBox.checked, Number(sel.value));
    sel.onchange = () => { if (onBox.checked) void go(true, Number(sel.value)); };
    box.append(on, per, note, ...sellList(sells.filter(j => j.linkId === l.linkId)));
    return box;
  }
  function sellList(rows: SellRow[]): HTMLElement[] {
    return rows.slice(0, 10).map(j => {
      const r = document.createElement("div"); r.className = "wl-sellrow";
      const d = document.createElement("span"); d.className = "wl-d";
      const what = document.createElement("b"); what.textContent = j.title; what.translate = false;
      d.append(what, ` · ${j.asset} × ${j.amount} · ${rvn(j.priceSats)} RVN · ${sellStatusText(j)}`);
      r.append(d);
      if (j.status === "published") {
        const down = document.createElement("button"); down.type = "button"; down.className = "ghost"; down.textContent = t("내리기");
        down.onclick = () => void cancelSell(j, down);
        r.append(down);
      }
      return r;
    });
  }
  /** 끊은 폰이 올린 글은 그대로 장터에 있다 — 여기서 내리기를 권한다. */
  function orphanBlock(): HTMLElement[] {
    const dead = new Set(links.filter(l => l.revoked).map(l => l.linkId));
    const rows = sells.filter(j => dead.has(j.linkId) && j.status === "published");
    if (!rows.length) return [];
    const box = document.createElement("div"); box.className = "wl-row wl-orphan";
    const txt = document.createElement("div"); txt.className = "wl-rowtxt";
    const b = document.createElement("b"); b.textContent = t("끊은 폰이 올린 판매 글");
    const note = document.createElement("span"); note.className = "wl-d"; note.textContent = t("연결을 끊어도 글은 장터에 남아 있어요. 팔지 않으려면 내려 주세요.");
    txt.append(b, note, ...sellList(rows));
    box.append(txt);
    return [box];
  }
  async function cancelSell(j: SellRow, btn: HTMLButtonElement) {
    const lock = await invoke<{ encrypted?: boolean; unlocked?: boolean }>("wallet_lock_state").catch(() => null);
    let pass: string | null = null;
    if (lock && lock.encrypted && !lock.unlocked) { pass = await deps.ask("unsell"); if (!pass) return; }
    btn.disabled = true;
    try { apply(await invoke<Inbox>("wallet_link_sell_cancel", { id: j.id, passphrase: pass })); msg(tf("「{0}」 판매 글을 내렸어요. 묶음은 이 지갑의 새 주소로 돌아왔어요.", j.title)); }
    catch (e) { msg(errOf(e), true); btn.disabled = false; }
  }
  /** 줄 안에서 새 하루 한도 → 지갑 암호 재인증 → 저장. 연결은 끊지 않는다. */
  function openLimit(l: LinkRow, txt: HTMLElement, btns: HTMLElement) {
    editing = l.linkId; btns.hidden = true;
    const box = document.createElement("div"); box.className = "wl-limit";
    const label = document.createElement("label"); label.className = "wl-d"; label.textContent = t("새 하루 한도(RVN)");
    const unlimited = l.dailySats === NO_LIMIT_SATS;
    const input = document.createElement("input"); input.inputMode = "decimal"; input.value = unlimited ? "1000" : rvn(l.dailySats).replace(/,/g, "");
    input.setAttribute("aria-label", t("새 하루 한도(RVN)"));
    const noLim = document.createElement("label"); noLim.className = "check";
    const noBox = document.createElement("input"); noBox.type = "checkbox"; noBox.checked = unlimited; input.disabled = unlimited;
    noBox.onchange = () => { input.disabled = noBox.checked; };
    const noTxt = document.createElement("span"); noTxt.textContent = " " + t("한도 없음");
    noLim.append(noBox, noTxt);
    const ok = document.createElement("button"); ok.type = "button"; ok.textContent = t("바꾸기");
    const no = document.createElement("button"); no.type = "button"; no.className = "ghost"; no.textContent = t("그만두기");
    const close = () => { editing = null; box.remove(); btns.hidden = false; renderLinks(); };
    no.onclick = close;
    const go = async () => {
      const v = noBox.checked ? NO_LIMIT_RVN : input.value.trim().replace(/,/g, "");
      const n = Number(v);
      if (!/^\d+(\.\d{1,8})?$/.test(v) || !(n > 0) || n > Number(NO_LIMIT_RVN)) { msg(t("하루 한도는 0보다 큰 RVN 수로 적어 주세요. 제한을 두지 않으려면 「한도 없음」을 고르세요."), true); input.focus(); return; }
      const password = await deps.ask("limit");
      if (!password) return;
      ok.disabled = no.disabled = true;
      try {
        const box2 = await invoke<Pick<Inbox, "pending" | "links">>("wallet_link_set_limit", { linkId: l.linkId, dailyRvn: v, passphrase: password });
        editing = null;
        msg(tf("「{0}」 하루 한도를 {1}(으)로 바꿨어요.", l.name, limitText(box2.links.find(x => x.linkId === l.linkId)?.dailySats ?? "0")));
        apply(box2);
      } catch (e) { msg(errOf(e), true); ok.disabled = no.disabled = false; }
    };
    ok.onclick = () => void go();
    input.onkeydown = e => { if (e.key === "Enter") void go(); if (e.key === "Escape") close(); };
    label.append(input);
    const note = document.createElement("span"); note.className = "wl-d"; note.textContent = t("한도가 없어도 폰 요청은 매번 이 컴퓨터에서 승인해야 나가요.");
    box.append(label, noLim, ok, no, note);
    txt.append(box);
    input.focus(); input.select();
  }
  $("wl-waiting-open").onclick = () => { deferred.clear(); nextModal(); };

  // ── 받은 요청 확인(앱이 열려 있고 잠기지 않은 동안) ──
  // 빠르게: 연결 중 1.5초 · 화면이 보이면 3초 · 창이 가려져도 10초. 연결이 없으면 멈춘다(refresh 가 다시 깨운다).
  const POLL_OFFER_MS = 1_500, POLL_VISIBLE_MS = 3_000, POLL_HIDDEN_MS = 10_000;
  const live = (text: string, bad = false) => { const el = $("wl-live"); el.hidden = !text; el.textContent = text; el.classList.toggle("wl-bad", bad); };
  function schedule(ms: number) { clearTimeout(pollTimer); pollTimer = setTimeout(poll, ms); }
  async function poll() {
    if (polling) return;
    const active = links.some(l => !l.revoked);
    if (!offer && !active) { live(""); return; }
    polling = true;
    try {
      const before = new Set(pending.map(p => p.id));
      const box = await invoke<Inbox>("wallet_link_inbox");
      apply(box);
      live(box.online === false ? t("인터넷에 닿지 못해 폰 요청을 아직 못 받아요. 잠시 뒤 저절로 다시 확인해요.") : t("폰 요청을 몇 초마다 확인하고 있어요."), box.online === false);
      // 창이 가려져 있을 때 새 요청이 오면 작업 표시줄·독에서 알린다(승인은 여전히 사람이 직접).
      if (document.hidden && box.pending.some(p => !before.has(p.id))) void getCurrentWindow().requestUserAttention(UserAttentionType.Critical).catch(() => {});
      if (box.offer?.stage === "cancelled" && offer) await cancelOffer(t("폰에서 연결을 취소했어요. 연결하지 않았어요. 처음부터 다시 해 주세요."));
      else if (box.offer?.stage === "confirm" && offer && $("wl-confirm").hidden) await showConfirm(box.offer.offer, box.offer.phoneKey, box.offer.code, box.offer.phoneAddresses);
    } catch (e) { live(tf("폰 요청을 확인하지 못했어요: {0}", errOf(e)), true); /* 앱 잠금·인터넷 끊김 — 다음 차례에 다시 */ }
    finally { polling = false; schedule(offer ? POLL_OFFER_MS : document.hidden ? POLL_HIDDEN_MS : POLL_VISIBLE_MS); }
  }
  function apply(box: Pick<Inbox, "pending" | "links" | "sells">) {
    links = box.links; pending = box.pending; if (box.sells) sells = box.sells;
    renderLinks();
    if (shown && !pending.some(p => p.id === shown)) closeModal(t("요청이 끝났어요(시간이 지났거나 연결이 끊겼어요)."));
    if (sellShown && !sellBusy && !sells.some(j => j.id === sellShown && j.status === "pending_human")) closeModal();
    if (!shown && !sellShown) nextModal();
  }
  async function refresh() {
    try { apply(await invoke<Inbox>("wallet_link_list")); } catch { /* 기록이 없으면 빈 목록 */ }
    schedule(500);
  }

  // ── 승인 창 ──
  const modal = $("wl-modal");
  function closeModal(note = "") {
    modal.classList.remove("on"); shown = null; review = null; sellShown = null;
    $("wl-m-pay").hidden = false; $("wl-m-sell").hidden = true;
    ($("wl-m-pass") as HTMLInputElement).value = ""; ($("wl-m-tail") as HTMLInputElement).value = "";
    if (note) msg(note);
  }
  function nextModal() {
    const p = pending.find(x => !deferred.has(x.id));
    if (p) { void openModal(p); return; }
    const j = sells.find(x => x.status === "pending_human" && !deferred.has(x.id));
    if (j) openSellModal(j);
  }
  /** 잠긴 지갑 때문에 멈춘 판매: 사람이 여기서 암호를 넣어야 이어 간다(남에게 돈을 보내는 일이 아니다). */
  function openSellModal(j: SellRow) {
    sellShown = j.id; shown = null; review = null;
    modal.classList.add("on"); modal.classList.remove("wl-send");
    $("wl-m-pay").hidden = true; $("wl-m-sell").hidden = false;
    const cancel = j.resume === "cancelling";
    $("wl-m-title").textContent = cancel ? tf("「{0}」 폰이 판매 글을 내려 달래요", j.phoneName) : tf("「{0}」 폰이 장터에 팔아 달래요", j.phoneName);
    $("wl-m-lead").textContent = cancel
      ? t("이 컴퓨터 지갑이 잠겨 있어 내리지 못했어요. 지갑 암호를 넣으면 묶음을 이 지갑의 새 주소로 옮기고 글을 내려요.")
      : t("이 컴퓨터 지갑이 잠겨 있어 멈췄어요. 지갑 암호를 넣으면 이 자산을 장터에 올려요. 사는 사람이 값을 내야만 자산이 나가요. 내가 보낸 요청이 아니면 거절하세요.");
    $("wl-m-s-phone").textContent = j.phoneName;
    $("wl-m-s-what").textContent = `${j.asset} × ${j.amount}`;
    $("wl-m-s-price").textContent = `${rvn(j.priceSats)} RVN`;
    $("wl-m-s-title").textContent = j.title;
    $("wl-m-s-step").textContent = cancel ? t("판매 글 내리기") : j.resume === "lot_ready" ? t("판매 제안 서명") : t("팔 묶음 만들기(내 지갑 안에서)");
    $("wl-m-say").textContent = "";
    $("wl-m-passbox").hidden = false;
    gate();
  }
  async function openModal(p: Pending) {
    shown = p.id; review = null; sellShown = null;
    $("wl-m-pay").hidden = false; $("wl-m-sell").hidden = true;
    const send = p.kind === "send";
    modal.classList.add("on");
    modal.classList.toggle("wl-send", send);
    // 폰 화면과 같은 방향 문장(내 컴퓨터 → 폰). 다른 곳으로 보내기는 경고형 그대로.
    $("wl-m-title").textContent = send ? t("폰이 다른 곳으로 보내 달래요") : tf("내 컴퓨터 → 「{0}」 폰으로 보내기", p.phoneName);
    $("wl-m-phone").textContent = p.phoneName;
    $("wl-m-when").textContent = new Date(p.created).toLocaleString();
    $("wl-m-lead").textContent = send
      ? tf("「{0}」 폰이 이 컴퓨터 지갑에서 연결된 폰이 아닌 주소로 보내 달라고 했어요. 내가 보낸 요청이 아니면 거절하세요.", p.phoneName)
      : tf("「{0}」 폰이 이 컴퓨터 지갑에서 폰으로 채워 달라고 했어요.", p.phoneName);
    $("wl-m-short").textContent = shortAddr(p.to);
    $("wl-m-addr").textContent = p.to;
    $("wl-m-tailbox").hidden = !send;
    $("wl-m-amount").textContent = `${rvn(p.sats)} RVN`;
    $("wl-m-fee").textContent = t("계산 중…");
    $("wl-m-total").textContent = "";
    $("wl-m-say").textContent = "";
    const lock = await invoke<{ encrypted?: boolean; unlocked?: boolean }>("wallet_lock_state").catch(() => null);
    $("wl-m-passbox").hidden = !(lock && lock.encrypted && !lock.unlocked);
    await loadReview(p);
  }
  async function loadReview(p: Pending) {
    review = null; gate();
    try {
      const r = await invoke<Review>("wallet_link_review", { id: p.id });
      if (shown !== p.id) return;
      if (r.short) { $("wl-m-fee").textContent = t("수수료까지 합치면 잔액이 모자라요."); return; }
      review = r;
      $("wl-m-fee").textContent = `${rvn(r.feeSats!)} RVN`;
      $("wl-m-total").textContent = `${rvn(r.totalSats!)} RVN`;
    } catch (e) { if (shown === p.id) $("wl-m-fee").textContent = errOf(e); }
    gate();
  }
  function gate() {
    const go = $("wl-m-go") as HTMLButtonElement;
    if (sellShown) { go.disabled = sellBusy || !($("wl-m-pass") as HTMLInputElement).value; go.textContent = t("이어서 하기"); return; }
    const p = pending.find(x => x.id === shown);
    if (!p) { go.disabled = true; return; }
    const tail = ($("wl-m-tail") as HTMLInputElement).value.trim();
    const tailOk = p.kind !== "send" || tail.toLowerCase() === p.to.slice(-4).toLowerCase();
    const passOk = $("wl-m-passbox").hidden || !!($("wl-m-pass") as HTMLInputElement).value;
    go.disabled = approving || !review || !tailOk || !passOk || Date.now() > p.expires;
    go.textContent = review ? tf("승인하고 {0} RVN 보내기", rvn(review.sats!)) : t("승인");
  }
  ($("wl-m-tail") as HTMLInputElement).oninput = gate;
  ($("wl-m-pass") as HTMLInputElement).oninput = gate;
  $("wl-m-later").onclick = () => { if (sellShown) { deferred.add(sellShown); closeModal(t("판매는 그대로 기다려요(2시간 안에 이어 가지 않으면 저절로 닫혀요).")); renderLinks(); return; }
    if (shown) deferred.add(shown); closeModal(t("요청은 그대로 기다려요(10분 안에 승인하지 않으면 저절로 거절돼요).")); renderLinks(); };
  $("wl-m-no").onclick = async () => {
    if (sellShown) {
      const id = sellShown;
      try { apply(await invoke<Inbox>("wallet_link_sell_refuse", { id })); closeModal(t("거절했어요. 폰에 알렸어요.")); }
      catch (e) { $("wl-m-say").textContent = errOf(e); }
      return;
    }
    const id = shown; if (!id) return;
    try { await invoke("wallet_link_refuse", { id }); closeModal(t("거절했어요. 폰에 알렸어요.")); await refresh(); }
    catch (e) { $("wl-m-say").textContent = errOf(e); }
  };
  $("wl-m-go").onclick = async () => {
    if (sellShown) {
      const id = sellShown, pass = ($("wl-m-pass") as HTMLInputElement).value;
      if (!pass || sellBusy) return;
      ($("wl-m-pass") as HTMLInputElement).value = "";
      sellBusy = true; gate(); $("wl-m-say").textContent = t("이어서 하는 중…");
      try { const box = await invoke<Inbox>("wallet_link_sell_continue", { id, passphrase: pass }); sellBusy = false; closeModal(t("이어서 했어요. 장터에 오르면 폰에 알려요.")); apply(box); }
      catch (e) { $("wl-m-say").textContent = errOf(e); }
      finally { sellBusy = false; gate(); }
      return;
    }
    const p = pending.find(x => x.id === shown), r = review;
    if (!p || !r || approving) return;
    approving = true; gate();
    const pass = ($("wl-m-pass") as HTMLInputElement).value || null;
    ($("wl-m-pass") as HTMLInputElement).value = "";
    $("wl-m-say").textContent = t("보내는 중…");
    try {
      const out = await invoke<{ txid: string }>("wallet_link_approve", { id: p.id, fingerprint: r.fingerprint, passphrase: pass });
      closeModal(tf("보냈어요. 거래 번호 {0}", out.txid.slice(0, 16) + "…"));
      await refresh();
    } catch (e) {
      // 거래가 바뀌었으면 이 승인은 무효 — 새로 계산한 내용을 다시 보고 다시 눌러야 한다.
      $("wl-m-say").textContent = errOf(e);
      if (shown === p.id) await loadReview(p);
    } finally { approving = false; gate(); }
  };

  document.addEventListener("visibilitychange", () => { if (!document.hidden) schedule(300); });
  void refresh();
  /** 기다리는 요청 승인 창을 바로 연다(홈에서 누를 때). */
  const openWaiting = () => { deferred.clear(); nextModal(); };
  return { refresh, openWaiting };
}
