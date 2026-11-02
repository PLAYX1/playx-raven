// 설정 → 「폰과 지갑 연결」 + 폰 요청 승인 창.
// 비밀(연결 열쇠·복구 단어·암호 저장)은 화면에 없다 — 서명·봉인·지급은 전부 러스트(src-tauri/src/wallet_link.rs).
// 화면은 공개 값(연결 제안·확인 숫자·요청 내용·수수료)만 보여 주고, 사람이 누른 것만 러스트에 전한다.
// 🔴 자동 승인 없음: 승인 단추는 사람이 누를 때만 wallet_link_approve 를 부른다.
import { getCurrentWindow, UserAttentionType } from "@tauri-apps/api/window";
import { t, tf } from "./i18n";

type Invoke = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;
type Offer = { v: 1; chain: "rvn-main"; account: 0; desktopKey: string; name: string; xpub: string; firstAddress: string; nonce: string; expires: number };
type LinkRow = { linkId: string; name: string; phoneAddresses: string[]; dailySats: string; spentToday: string; created: number; revoked: boolean };
type Pending = { id: string; linkId: string; phoneName: string; kind: "fill" | "send"; to: string; sats: string; created: number; expires: number };
type Inbox = { pending: Pending[]; links: LinkRow[]; online?: boolean;
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
const limitText = (sats: string) => (sats === NO_LIMIT_SATS ? t("한도 없음") : `${rvn(sats)} RVN`);

/** 홈·사이드바가 듣는 요약: 살아 있는 연결 수 · 승인을 기다리는 요청 수. */
export type WalletLinkState = { linked: number; waiting: number };

export function wireWalletLink(deps: { invoke: Invoke; ask: (why: "link" | "limit") => Promise<string | null>; onState?: (s: WalletLinkState) => void }) {
  const { invoke } = deps;
  let offer: Offer | null = null, offerTimer: ReturnType<typeof setInterval> | undefined;
  let pollTimer: ReturnType<typeof setTimeout> | undefined, polling = false, links: LinkRow[] = [], pending: Pending[] = [];
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
    $("wl-qr").hidden = true; $("wl-confirm").hidden = false;
    $("wl-code").textContent = `${code.slice(0, 3)} ${code.slice(3)}`;
    $("wl-phoneaddr").textContent = addresses.join("\n");
  }
  // 「한도 없음」을 켜면 숫자 칸은 쓰지 않는다(총발행량을 저장한다). 승인은 그대로 매번 사람이 한다.
  ($("wl-nolimit") as HTMLInputElement).onchange = () => { ($("wl-daily") as HTMLInputElement).disabled = ($("wl-nolimit") as HTMLInputElement).checked; };
  $("wl-yes").onclick = async () => {
    try {
      const daily = ($("wl-nolimit") as HTMLInputElement).checked ? NO_LIMIT_RVN : ($("wl-daily") as HTMLInputElement).value;
      await invoke("wallet_link_confirm", { dailyRvn: daily, phoneName: ($("wl-phonename") as HTMLInputElement).value });
      stopOffer(); agree.checked = false; make.disabled = true; $("wl-agree-hint").hidden = false;
      msg(t("연결했어요. 폰에서 이 컴퓨터 지갑의 잔액과 받는 주소를 볼 수 있어요."));
      await refresh();
    } catch (e) { msg(errOf(e), true); }
  };

  // ── 연결된 폰 목록 ──
  function renderLinks() {
    const box = $("wl-list");
    const live = links.filter(l => !l.revoked);
    // 한도를 고치는 중이면 목록을 다시 그리지 않는다(몇 초마다 오는 확인이 적던 칸을 지우지 않게).
    if (!editing || !live.some(l => l.linkId === editing)) { editing = null; box.replaceChildren(...live.map(linkRow)); }
    $("wl-empty").hidden = live.length > 0;
    const waiting = pending.length;
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
    row.append(txt, btns);
    return row;
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
  function apply(box: Pick<Inbox, "pending" | "links">) {
    links = box.links; pending = box.pending;
    renderLinks();
    if (shown && !pending.some(p => p.id === shown)) closeModal(t("요청이 끝났어요(시간이 지났거나 연결이 끊겼어요)."));
    if (!shown) nextModal();
  }
  async function refresh() {
    try { apply(await invoke<Inbox>("wallet_link_list")); } catch { /* 기록이 없으면 빈 목록 */ }
    schedule(500);
  }

  // ── 승인 창 ──
  const modal = $("wl-modal");
  function closeModal(note = "") {
    modal.classList.remove("on"); shown = null; review = null;
    ($("wl-m-pass") as HTMLInputElement).value = ""; ($("wl-m-tail") as HTMLInputElement).value = "";
    if (note) msg(note);
  }
  function nextModal() {
    const p = pending.find(x => !deferred.has(x.id));
    if (p) void openModal(p);
  }
  async function openModal(p: Pending) {
    shown = p.id; review = null;
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
    const p = pending.find(x => x.id === shown);
    const go = $("wl-m-go") as HTMLButtonElement;
    if (!p) { go.disabled = true; return; }
    const tail = ($("wl-m-tail") as HTMLInputElement).value.trim();
    const tailOk = p.kind !== "send" || tail.toLowerCase() === p.to.slice(-4).toLowerCase();
    const passOk = $("wl-m-passbox").hidden || !!($("wl-m-pass") as HTMLInputElement).value;
    go.disabled = approving || !review || !tailOk || !passOk || Date.now() > p.expires;
    go.textContent = review ? tf("승인하고 {0} RVN 보내기", rvn(review.sats!)) : t("승인");
  }
  ($("wl-m-tail") as HTMLInputElement).oninput = gate;
  ($("wl-m-pass") as HTMLInputElement).oninput = gate;
  $("wl-m-later").onclick = () => { if (shown) deferred.add(shown); closeModal(t("요청은 그대로 기다려요(10분 안에 승인하지 않으면 저절로 거절돼요).")); renderLinks(); };
  $("wl-m-no").onclick = async () => {
    const id = shown; if (!id) return;
    try { await invoke("wallet_link_refuse", { id }); closeModal(t("거절했어요. 폰에 알렸어요.")); await refresh(); }
    catch (e) { $("wl-m-say").textContent = errOf(e); }
  };
  $("wl-m-go").onclick = async () => {
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
