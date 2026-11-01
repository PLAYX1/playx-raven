// 설정 → 「폰과 지갑 연결」 + 폰 요청 승인 창.
// 비밀(연결 열쇠·복구 단어·암호 저장)은 화면에 없다 — 서명·봉인·지급은 전부 러스트(src-tauri/src/wallet_link.rs).
// 화면은 공개 값(연결 제안·확인 숫자·요청 내용·수수료)만 보여 주고, 사람이 누른 것만 러스트에 전한다.
// 🔴 자동 승인 없음: 승인 단추는 사람이 누를 때만 wallet_link_approve 를 부른다.
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

export function wireWalletLink(deps: { invoke: Invoke; ask: () => Promise<string | null> }) {
  const { invoke } = deps;
  let offer: Offer | null = null, offerTimer: ReturnType<typeof setInterval> | undefined;
  let pollTimer: ReturnType<typeof setTimeout> | undefined, polling = false, links: LinkRow[] = [], pending: Pending[] = [];
  let shown: string | null = null, review: Review | null = null, approving = false, deferred = new Set<string>();
  const msg = (text: string, bad = false) => { const m = $("wl-msg"); m.textContent = text; m.classList.toggle("wl-bad", bad); };

  // ── 연결 만들기 ──
  const agree = $("wl-agree") as HTMLInputElement, make = $("wl-make") as HTMLButtonElement;
  agree.onchange = () => { make.disabled = !agree.checked; };
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
    const password = await deps.ask();
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
  $("wl-yes").onclick = async () => {
    try {
      await invoke("wallet_link_confirm", { dailyRvn: ($("wl-daily") as HTMLInputElement).value, phoneName: ($("wl-phonename") as HTMLInputElement).value });
      stopOffer(); agree.checked = false; make.disabled = true;
      msg(t("연결했어요. 폰에서 이 컴퓨터 지갑의 잔액과 받는 주소를 볼 수 있어요."));
      await refresh();
    } catch (e) { msg(errOf(e), true); }
  };

  // ── 연결된 폰 목록 ──
  function renderLinks() {
    const box = $("wl-list");
    const live = links.filter(l => !l.revoked);
    box.replaceChildren(...live.map(l => {
      const row = document.createElement("div"); row.className = "wl-row";
      const txt = document.createElement("div"); txt.className = "wl-rowtxt";
      const b = document.createElement("b"); b.textContent = l.name; b.translate = false;
      const d = document.createElement("span"); d.className = "wl-d";
      d.textContent = tf("하루 한도 {0} RVN · 오늘 나간 것 {1} RVN · {2} 연결", rvn(l.dailySats), rvn(l.spentToday), new Date(l.created).toLocaleDateString());
      txt.append(b, d);
      const cut = document.createElement("button"); cut.className = "ghost"; cut.type = "button"; cut.textContent = t("끊기");
      cut.onclick = async () => {
        cut.disabled = true;
        try { await invoke("wallet_link_revoke", { linkId: l.linkId }); msg(tf("「{0}」 연결을 끊었어요. 기다리던 요청도 모두 버렸어요.", l.name)); await refresh(); }
        catch (e) { msg(errOf(e), true); cut.disabled = false; }
      };
      row.append(txt, cut);
      return row;
    }));
    $("wl-empty").hidden = live.length > 0;
    const waiting = pending.length;
    $("wl-waiting").hidden = waiting === 0;
    $("wl-waiting-n").textContent = tf("폰이 보낸 요청 {0}건이 승인을 기다려요.", waiting);
  }
  $("wl-waiting-open").onclick = () => { deferred.clear(); nextModal(); };

  // ── 받은 요청 확인(앱이 열려 있고 잠기지 않은 동안) ──
  function schedule(ms: number) { clearTimeout(pollTimer); pollTimer = setTimeout(poll, ms); }
  async function poll() {
    if (polling) return;
    const active = links.some(l => !l.revoked);
    if (!offer && !active) return;
    if (document.hidden && !offer) { schedule(30_000); return; }
    polling = true;
    try {
      const box = await invoke<Inbox>("wallet_link_inbox");
      apply(box);
      if (box.offer?.stage === "cancelled" && offer) await cancelOffer(t("폰에서 연결을 취소했어요. 연결하지 않았어요. 처음부터 다시 해 주세요."));
      else if (box.offer?.stage === "confirm" && offer && $("wl-confirm").hidden) await showConfirm(box.offer.offer, box.offer.phoneKey, box.offer.code, box.offer.phoneAddresses);
    } catch { /* 앱 잠금·인터넷 끊김 — 다음 차례에 다시 */ }
    finally { polling = false; schedule(offer ? 4_000 : 30_000); }
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
    $("wl-m-title").textContent = send ? t("폰이 다른 곳으로 보내 달래요") : t("내 폰으로 채우기");
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
  return { refresh };
}
