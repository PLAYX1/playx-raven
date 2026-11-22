/*
 * 장터 「이번 주 공동구매 · 마주가 고른 상품」 — 데스크탑. (2026-11-16, 대표 「레이븐볼트 데스크탑도 상품 살 수 있어야지」)
 *
 * 폰·웹(phone/screens/Maju.tsx)과 같은 흐름·같은 문구:
 *   · 칸은 서버가 판매 중 상품을 줄 때만 보인다(못 받으면 칸이 없다 — 지어내지 않는다). 시험 상품은 설정 「마주 시험 상품」을 켠 컴퓨터만.
 *   · 결제하기 → 잡기(15분) → 받는 곳(동의 3가지 · 매번 빈 체크) → 0원이면 바로 확정 · RVN 이면 「RVN 보내기」 확인 → 사람이 누름 → 지갑 열기
 *     → 러스트 maju_pay(받는 곳·수수료 주소·1% 나누기 다시 대조, 같은 잡기는 한 번만) → 보낸 txid 로 확정(장부에 아직 안 보이면 잠시 뒤 다시 — 다시 보내지 않는다).
 *   · 「내 주문」: 진행(결제 → 준비 중 → 보냄 → 도착) · 배송 조회(택배사 공식 화면) · 받은 뒤(잘 받았어요·문제·칭찬·만든 분께 묻기 — 서버가 정한 것만).
 *   · 공급자 이름·공급가는 서버가 보내지 않는다. 상품 이름·설명은 마주가 적은 글이라 번역하지 않는다(translate="no").
 *   · 회차 공동구매(참여하기)는 아직 폰·웹에서만(desktopProducts 가 뺀다).
 *   · 🔴 버튼 글자 두 줄 금지 — maju-market.css 의 nowrap.
 */
import "./maju-market.css";
import { t, tf, copyHtml, setCopyText, lang } from "./i18n";
import {
  MajuError, MAJU_DOMESTIC_ONLY, MAJU_ORDERS_KEY, MAJU_PRIVACY_LINES, MAJU_RETURN_LINES, MAJU_SELLER_LINE, MAJU_SHIP_KEY, MAJU_STEPS,
  addSavedOrder, atomsText, bindMajuInvoke, checkMajuPayTo, confirmMaju, desktopProducts, loadMajuOrder, loadMajuProducts, majuAsk, majuConsent,
  majuDraftFromSaved, majuErrorText, majuLookupCode, majuOpen, majuPhone, majuPraise, majuProblem, majuReceived, majuShipFromDraft, majuTestOn, majuTracking,
  parseMajuOrderCode, parseSavedOrders, parseShip, readPref, releaseMaju, reserveMaju, searchMajuAddress, writePref,
  type MajuAddressHit, type MajuConfirmed, type MajuConsent, type MajuOrderView, type MajuPayment, type MajuProduct, type MajuReservation, type MajuShip,
  type MajuShipDraft, type MajuShipSaved, type SavedMajuOrder,
} from "./maju-model";

type Invoke = <T = any>(cmd: string, args?: Record<string, unknown>) => Promise<T>;
export interface MajuDeps {
  invoke: Invoke;
  ensureUnlocked: (why: string) => Promise<boolean>;
  errText: (e: unknown) => string;
  openUrl: (url: string) => Promise<unknown>;
}

const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
const loc = () => (lang === "zh" ? "zh-CN" : lang === "ko" ? "ko-KR" : lang);
const wonText = (n: number) => tf("{0}원", n.toLocaleString(loc()));
const rvnText = (atoms: string | null) => (atoms === null ? null : `${atomsText(atoms)} RVN`);
const priceLine = (p: Pick<MajuProduct, "priceWon" | "priceRvnAtoms">) => { const r = rvnText(p.priceRvnAtoms); return r ? `${wonText(p.priceWon)} ≈ ${r}` : wonText(p.priceWon); };
function dayText(ymd: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ymd)) return "";
  return new Date(`${ymd}T12:00:00+09:00`).toLocaleDateString(loc(), { month: "long", day: "numeric", timeZone: "Asia/Seoul" });
}
function untilText(ms: number | undefined): string {
  if (!ms || !Number.isFinite(ms)) return "";
  return tf("{0}까지", dayText(new Date(ms + 9 * 3600_000).toISOString().slice(0, 10)));
}
const isSentUnknown = (e: unknown) => /SENT_UNKNOWN/.test(String(e));
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ICON_SHOP = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 9.5l1.5-5h13L20 9.5"/><path d="M4 9.5h16v1a3 3 0 0 1-5.3 1.9A3 3 0 0 1 12 13.5a3 3 0 0 1-2.7-1.1A3 3 0 0 1 4 10.5z"/><path d="M5.5 13v6.5h13V13"/></svg>`;
const ICON_CHECK = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>`;
const photo = (url: string | null, big = false) => url && url.startsWith("https://")
  ? `<span class="mj-photo${big ? " big" : ""}"><img src="${esc(url)}" alt="" referrerpolicy="no-referrer" loading="lazy" /></span>`
  : `<span class="mj-photo none${big ? " big" : ""}">${ICON_SHOP}</span>`;
const row = (label: string, value: string, strong = false) => `<div class="kv"><b>${copyHtml(label)}</b><span>${strong ? `<b>${value}</b>` : value}</span></div>`;

type View =
  | { at: "row" } | { at: "detail"; p: MajuProduct } | { at: "ship"; p: MajuProduct; r: MajuReservation }
  | { at: "pay"; p: MajuProduct; r: MajuReservation; ship: MajuShip; saved: MajuShipSaved; consent: MajuConsent; pay: MajuPayment }
  | { at: "sent"; p: MajuProduct; r: MajuReservation; ship: MajuShip; saved: MajuShipSaved; consent: MajuConsent; txid: string }
  | { at: "done"; p: MajuProduct; order: MajuConfirmed; qty: number } | { at: "orders" };

export function mountMaju(page: HTMLElement, host: HTMLElement, deps: MajuDeps) {
  bindMajuInvoke(deps.invoke);
  let view: View = { at: "row" };
  let items: MajuProduct[] = [];
  let loadedFor: boolean | null = null, loadedAt = 0;
  let held: MajuReservation | null = null;
  let qty = 1, busy = false, error = "";

  const focus = (on: boolean) => page.classList.toggle("mj-focus", on);
  const savedOrders = () => parseSavedOrders(readPref(MAJU_ORDERS_KEY));

  async function load(force = false) {
    const test = majuTestOn();
    if (!force && loadedFor === test && Date.now() - loadedAt < 120_000) return;
    try { items = desktopProducts((await loadMajuProducts(test)).products ?? []); } catch { items = []; }
    loadedFor = test; loadedAt = Date.now();
  }
  /** 잡아 둔 것을 돌려놓는다(15분 기다리지 않게). 돈을 보낸 뒤에는 부르지 않는다. */
  function releaseHeld() { const r = held; held = null; if (r) void releaseMaju(r).catch(() => {}); }
  function go(next: View) { if ((next.at === "row" || next.at === "detail" || next.at === "orders") && view.at !== "sent") releaseHeld(); view = next; error = ""; paint(); host.scrollIntoView({ block: "start" }); }
  const back = (label = "장터로") => `<div class="mj-head"><button type="button" class="ghost" data-mj-back="1">${copyHtml(label)}</button></div>`;
  const errLine = () => (error ? `<p class="danger mj-err" role="alert">${esc(t(error))}</p>` : "");
  function wireBack(to: () => View = () => ({ at: "row" })) { host.querySelector<HTMLElement>("[data-mj-back]")?.addEventListener("click", () => go(to())); }

  function paintRow() {
    focus(false);
    const list = items, hasOrders = savedOrders().length > 0;
    host.hidden = !list.length && !hasOrders;
    if (host.hidden) { host.innerHTML = ""; return; }
    const link = `<button type="button" class="ghost mj-link" data-mj-orders="1">${copyHtml("내 주문 · 주문 찾기")}</button>`;
    host.innerHTML = !list.length ? `<div class="mj-orders-only">${link}</div>` :
      `<div class="mj-sec-head"><h3>${copyHtml("이번 주 공동구매")}</h3>${link}</div>` +
      `<p class="meta">${copyHtml("PLAY X 장터가 고른 상품")}</p>` +
      `<ul class="mj-grid">${list.map((p) => {
        const left = p.left > 0 ? [tf("남은 수량 {0}개", p.left), untilText(p.sellUntil)].filter(Boolean).join(" · ") : t("다 팔렸어요");
        const tag = p.test ? t("시험") : !majuOpen(p) ? t("시험 중") : "";
        return `<li><button type="button" class="mj-card" data-mj-open="${esc(p.id)}" aria-label="${esc([tag, p.title, priceLine(p), left].filter(Boolean).join(" · "))}">` +
          photo(p.photoUrl) + (tag ? `<span class="mj-tag">${esc(tag)}</span>` : "") +
          `<span class="mj-cbody"><span class="mj-ctitle" translate="no">${esc(p.title)}</span><span class="mj-price">${esc(priceLine(p))}</span>` +
          `<span class="mj-left${p.left > 0 ? "" : " out"}">${esc(left)}</span></span></button></li>`;
      }).join("")}</ul>`;
    host.querySelectorAll<HTMLElement>("[data-mj-open]").forEach((b) => { b.onclick = () => { const p = items.find((x) => x.id === b.dataset.mjOpen); if (p) { qty = 1; go({ at: "detail", p }); } }; });
    host.querySelector<HTMLElement>("[data-mj-orders]")?.addEventListener("click", () => go({ at: "orders" }));
  }

  function paintDetail(p: MajuProduct) {
    focus(true);
    const max = Math.max(0, Math.min(5, p.left)), open = majuOpen(p);
    host.innerHTML = back() +
      `<article class="mj-page">${photo(p.photoUrl, true)}<div class="mj-info">` +
      `<p class="mj-seller">${ICON_CHECK}<span>${copyHtml(MAJU_SELLER_LINE)}</span></p>` +
      (p.test ? `<p class="mj-test">${copyHtml("시험 상품 · 돈을 받지 않아요")}</p>` : !open ? `<p class="mj-test">${copyHtml("시험 중 · RVN 결제는 곧 열려요")}</p>` : "") +
      `<h3 translate="no">${esc(p.title)}</h3>` + (p.line ? `<p class="meta" translate="no">${esc(p.line)}</p>` : "") +
      `<div class="mj-big">${esc(priceLine(p))}</div>` +
      `<div class="mj-facts">` +
      `<div><span>${copyHtml("남은 수량")}</span><b>${esc(p.left > 0 ? tf("{0}개", p.left) : t("다 팔렸어요"))}</b></div>` +
      `<div><span>${copyHtml("보내는 날")}</span><b>${esc(dayText(p.shipByDate))}</b></div>` +
      `<div><span>${copyHtml("배송비")}</span><b>${esc(p.shippingWon > 0 ? wonText(p.shippingWon) : t("무료"))}</b></div></div>` +
      `<p class="meta">${copyHtml(p.shipLine)}</p>` +
      `<p class="meta">${copyHtml(MAJU_DOMESTIC_ONLY)}</p>` +
      (max > 0 && open ? `<div class="mj-stepper"><button type="button" class="ghost" data-mj-q="-1" aria-label="${esc(t("하나 빼기"))}" ${qty <= 1 || busy ? "disabled" : ""}>−</button>` +
        `<b>${esc(tf("{0}개", qty))}</b><button type="button" class="ghost" data-mj-q="1" aria-label="${esc(t("하나 더"))}" ${qty >= max || busy ? "disabled" : ""}>+</button></div>` : "") +
      errLine() +
      `<div class="row mj-acts">${open
        ? `<button type="button" data-mj-buy="1" ${max > 0 && !busy ? "" : "disabled"}>${copyHtml(busy ? "잡아 두는 중…" : "결제하기")}</button>`
        : `<button type="button" disabled>${copyHtml("곧 열려요")}</button>`}</div>` +
      `</div></article>`;
    wireBack();
    host.querySelectorAll<HTMLElement>("[data-mj-q]").forEach((b) => { b.onclick = () => { qty = Math.max(1, Math.min(max, qty + Number(b.dataset.mjQ))); paint(); }; });
    host.querySelector<HTMLElement>("[data-mj-buy]")?.addEventListener("click", () => void buy(p));
  }

  async function buy(p: MajuProduct) {
    busy = true; error = ""; paint();
    try {
      // 서버는 손님 지갑 주소로 잡기를 묶는다(폰은 열린 지갑 주소) — 이 지갑의 받는 주소.
      const a = await deps.invoke<{ address?: string }>("receive_address", { fresh: false });
      if (!a?.address) throw new Error(t("지갑을 열면 살 수 있어요"));
      const r = await reserveMaju(p.id, qty, a.address);
      held = r; busy = false; view = { at: "ship", p, r }; error = ""; paint();
    } catch (e) { busy = false; error = e instanceof MajuError ? majuErrorText(e) : deps.errText(e); paint(); }
  }

  function paintShip(p: MajuProduct, r: MajuReservation) {
    focus(true);
    const q = r.quote, until = new Date(r.expiresAt), hhmm = `${String(until.getHours()).padStart(2, "0")}:${String(until.getMinutes()).padStart(2, "0")}`;
    const rvn = rvnText(q.rvnAtoms);
    let d: MajuShipDraft = majuDraftFromSaved(parseShip(readPref(MAJU_SHIP_KEY)));
    let mode: "search" | "found" | "manual" = d.road ? "found" : d.manual ? "manual" : "search";
    host.innerHTML = back("그만두기") +
      `<div class="mj-form"><h3>${copyHtml("받는 곳")}</h3><p class="meta">${esc(tf("{0}까지 {1}개를 잡아 뒀어요", hhmm, q.qty))}</p>` +
      `<div class="mj-box">${row("상품", esc(`${wonText(q.unitWon)} × ${q.qty}`))}${row("배송비", esc(q.shippingWon > 0 ? wonText(q.shippingWon) : t("무료")))}` +
      row("합계", esc(rvn ? `${wonText(q.totalWon)} ≈ ${rvn}` : wonText(q.totalWon)), true) + `</div>` +
      (q.test ? `<p class="meta">${copyHtml("시험 상품이라 돈이 나가지 않아요.")}</p>` : "") +
      `<label class="mj-field"><span>${copyHtml("받는 분")}</span><input data-mj-f="name" maxlength="40" autocomplete="name" /></label>` +
      `<label class="mj-field"><span>${copyHtml("연락처 (010-1234-5678)")}</span><input data-mj-f="phone" maxlength="20" inputmode="tel" autocomplete="tel" /></label>` +
      `<p class="danger" data-mj-phone-bad="1" hidden>${copyHtml("휴대폰 번호(010으로 시작)를 넣어 주세요")}</p>` +
      `<p class="mj-fhead">${copyHtml("주소")}</p><div data-mj-addr="1"></div>` +
      `<label class="mj-field"><span>${copyHtml("배송 메모 (없어도 돼요)")}</span><input data-mj-f="memo" maxlength="200" /></label>` +
      `<p class="meta">${copyHtml(MAJU_DOMESTIC_ONLY)}</p>` +
      `<div class="mj-box"><b>${copyHtml("교환·반품 택배비")}</b>${MAJU_RETURN_LINES.map((l) => `<p class="meta">· ${copyHtml(l)}</p>`).join("")}</div>` +
      `<div class="mj-box"><label class="check mj-agree"><input type="checkbox" data-mj-agree="1" /><b>${copyHtml("개인정보 수집·이용·제공에 동의해요 (필수)")}</b></label>` +
      MAJU_PRIVACY_LINES.map((l) => `<p class="meta">· ${copyHtml(l)}</p>`).join("") +
      `<p class="meta">${copyHtml("동의하지 않으면 주문할 수 없어요. 받는 분 정보는 다음에 쓰도록 이 기기에도 남겨요.")}</p></div>` +
      `<div data-mj-err="1">${errLine()}</div>` +
      `<div class="row mj-acts"><button type="button" data-mj-go="1" disabled>${copyHtml("결제하기")}</button><button type="button" class="ghost" data-mj-stop="1">${copyHtml("그만두기")}</button></div>` +
      `<p class="meta">${esc(tf("판매처 {0}", t("PLAY X 장터")))} · <span translate="no">${esc(p.title)}</span></p></div>`;
    wireBack(() => ({ at: "detail", p }));
    host.querySelector<HTMLElement>("[data-mj-stop]")!.onclick = () => go({ at: "detail", p });
    const field = (k: "name" | "phone" | "memo") => host.querySelector<HTMLInputElement>(`[data-mj-f="${k}"]`)!;
    (["name", "phone", "memo"] as const).forEach((k) => { const el = field(k); el.value = d[k]; el.oninput = () => { d = { ...d, [k]: el.value }; check(); }; });
    const agree = host.querySelector<HTMLInputElement>("[data-mj-agree]")!;
    const goBtn = host.querySelector<HTMLButtonElement>("[data-mj-go]")!;
    const addr = host.querySelector<HTMLElement>("[data-mj-addr]")!;
    agree.onchange = check;
    function check() {
      const digits = d.phone.replace(/\D/g, "");
      const phoneBad = !majuPhone(d.phone) && (digits.length >= 10 || (digits.length >= 2 && !digits.startsWith("01") && !d.phone.trim().startsWith("+")));
      host.querySelector<HTMLElement>("[data-mj-phone-bad]")!.hidden = !phoneBad;
      goBtn.disabled = !(majuShipFromDraft(d).ok && agree.checked && !busy);
    }
    function paintAddr(note = "", hits: MajuAddressHit[] | null = null) {
      const n = note ? `<p class="meta" role="status">${esc(t(note))}</p>` : "";
      if (mode === "found") {
        addr.innerHTML = `<div class="mj-box mj-found"><b>${esc(d.zip)}</b><span>${esc(d.road)}</span></div>` +
          `<label class="mj-field"><span>${copyHtml("상세주소 (동·호수)")}</span><input data-mj-a="detail" maxlength="100" /></label>` +
          `<button type="button" class="ghost mj-link" data-mj-a-re="1">${copyHtml("주소 다시 찾기")}</button>`;
        const el = addr.querySelector<HTMLInputElement>("[data-mj-a=detail]")!; el.value = d.detail; el.oninput = () => { d = { ...d, detail: el.value }; check(); };
        addr.querySelector<HTMLElement>("[data-mj-a-re]")!.onclick = () => { mode = "search"; d = { ...d, zip: "", road: "", detail: "" }; paintAddr(); check(); };
      } else if (mode === "search") {
        addr.innerHTML = `<div class="mj-search"><input data-mj-a="q" maxlength="80" placeholder="${esc(t("도로명·건물 이름 (예: 세종대로 110)"))}" aria-label="${esc(t("도로명·건물 이름 (예: 세종대로 110)"))}" />` +
          `<button type="button" class="ghost" data-mj-a-find="1">${copyHtml("주소 찾기")}</button></div>` +
          (hits?.length ? `<ul class="mj-hits" aria-label="${esc(t("찾은 주소"))}">${hits.map((h, i) => `<li><button type="button" class="ghost" data-mj-hit="${i}"><b>${esc(h.zip)}</b> <span>${esc(h.road)}</span>${h.jibun ? `<small>${esc(t("지번"))} ${esc(h.jibun)}</small>` : ""}</button></li>`).join("")}</ul>` : "") +
          n + `<button type="button" class="ghost mj-link" data-mj-a-manual="1">${copyHtml("주소를 직접 쓸게요")}</button>`;
        const qEl = addr.querySelector<HTMLInputElement>("[data-mj-a=q]")!, find = addr.querySelector<HTMLButtonElement>("[data-mj-a-find]")!;
        const run = async () => {
          const word = qEl.value.trim(); if (word.length < 2) return;
          find.disabled = true; setCopyText(find, () => t("찾는 중…"));
          try {
            const r = await searchMajuAddress(word);
            if (!r.ready) { mode = "manual"; d = { ...d, zip: "", road: "" }; paintAddr("주소 찾기를 아직 쓸 수 없어요. 주소를 직접 써 주세요"); return; }
            paintAddr(r.hits.length ? "" : "찾는 주소가 없어요. 도로명과 건물 번호로 다시 찾아 주세요", r.hits);
            const again = addr.querySelector<HTMLInputElement>("[data-mj-a=q]"); if (again) again.value = word;
            r.hits.forEach((h, i) => { const b = addr.querySelector<HTMLElement>(`[data-mj-hit="${i}"]`); if (b) b.onclick = () => { d = { ...d, zip: h.zip, road: h.road }; mode = "found"; paintAddr(); check(); }; });
          } catch (e) { paintAddr(majuErrorText(e)); }
        };
        find.onclick = () => void run();
        qEl.onkeydown = (e) => { if (e.key === "Enter") { e.preventDefault(); void run(); } };
        addr.querySelector<HTMLElement>("[data-mj-a-manual]")!.onclick = () => { mode = "manual"; d = { ...d, zip: "", road: "" }; paintAddr(); check(); };
      } else {
        addr.innerHTML = `<label class="mj-field"><span>${copyHtml("주소 (도로명·동·호수까지)")}</span><textarea data-mj-a="manual" maxlength="300" rows="2"></textarea></label>` + n +
          `<button type="button" class="ghost mj-link" data-mj-a-search="1">${copyHtml("도로명주소 찾기")}</button>`;
        const el = addr.querySelector<HTMLTextAreaElement>("[data-mj-a=manual]")!; el.value = d.manual; el.oninput = () => { d = { ...d, manual: el.value }; check(); };
        addr.querySelector<HTMLElement>("[data-mj-a-search]")!.onclick = () => { mode = "search"; paintAddr(); };
      }
    }
    paintAddr(); check();
    goBtn.onclick = async () => {
      const c = majuShipFromDraft(d);
      if (!c.ok || !agree.checked) return;
      const consent = majuConsent();
      if (r.payTo) {
        // 진짜 RVN — 받는 곳을 박힌 값과 대조한 뒤 확인 칸으로(러스트가 한 번 더 본다).
        try { const pay = checkMajuPayTo(r.payTo, r.quote.rvnAtoms); view = { at: "pay", p, r, ship: c.ship, saved: c.saved, consent, pay }; error = ""; paint(); }
        catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
        return;
      }
      busy = true; goBtn.disabled = true; setCopyText(goBtn, () => t("보내는 중…"));
      try { finished(p, r, c.saved, await confirmMaju(r, c.ship, consent, null)); }
      catch (e) { busy = false; check(); setCopyText(goBtn, () => t("결제하기")); setErr(majuErrorText(e)); }
    };
    function setErr(s: string) { error = s; host.querySelector<HTMLElement>("[data-mj-err]")!.innerHTML = errLine(); }
  }

  function finished(p: MajuProduct, r: MajuReservation, saved: MajuShipSaved, order: MajuConfirmed) {
    held = null; busy = false;
    writePref(MAJU_ORDERS_KEY, JSON.stringify(addSavedOrder(savedOrders(), { orderId: order.orderId, token: order.orderToken, title: p.title, shortNo: order.shortNo, at: Date.now(), test: p.test })));
    writePref(MAJU_SHIP_KEY, JSON.stringify(saved));
    loadedAt = 0;
    view = { at: "done", p, order, qty: r.quote.qty }; error = ""; paint();
  }

  function paintPay(v: Extract<View, { at: "pay" }>) {
    focus(true);
    const { p, pay } = v;
    host.innerHTML = `<div class="mj-form"><h3>${copyHtml("RVN 보내기")}</h3><p class="meta" translate="no">${esc(p.title)}</p>` +
      `<div class="mj-big">${esc(`${atomsText(pay.priceSats)} RVN`)}</div>` +
      `<div class="mj-box">${row("받는 곳", `${copyHtml("PLAY X 장터 판매 대금")} · <code translate="no">${esc(pay.address)}</code>`)}` +
      row("상품값", esc(`${atomsText(pay.sellerSats)} RVN`)) + row("레이븐볼트 1%", esc(`${atomsText(pay.feeSats)} RVN`)) + `</div>` +
      `<p class="meta">${copyHtml("공개 장부 수수료는 노드가 정해 따로 조금 붙어요. 레이븐볼트는 거래 당사자가 아니고, 보낸 RVN은 돌려받을 수 없어요.")}</p>` +
      `<p class="meta">${copyHtml("한 번 보내면 되돌릴 수 없어요. 15분 안에 보내야 주문이 돼요.")}</p>` +
      `<div data-mj-err="1">${errLine()}</div>` +
      `<div class="row mj-acts"><button type="button" data-mj-send="1" ${busy ? "disabled" : ""}>${copyHtml(busy ? "보내는 중…" : "RVN 보내고 주문하기")}</button>` +
      `<button type="button" class="ghost" data-mj-stop="1" ${busy ? "disabled" : ""}>${copyHtml("그만두기")}</button></div></div>`;
    host.querySelector<HTMLElement>("[data-mj-stop]")!.onclick = () => go({ at: "detail", p });
    host.querySelector<HTMLElement>("[data-mj-send]")!.onclick = () => void send(v);
  }

  async function send(v: Extract<View, { at: "pay" }>) {
    if (busy) return;
    busy = true; error = ""; paint();
    if (!(await deps.ensureUnlocked(t("지갑을 열면 살 수 있어요")))) { busy = false; paint(); return; }
    let txid = "";
    try {
      const r = await deps.invoke<{ txid?: string }>("maju_pay", { reservationId: v.r.reservationId, payTo: v.r.payTo, quoteAtoms: v.r.quote.rvnAtoms, passphrase: null });
      txid = String(r?.txid ?? "");
    } catch (e) {
      busy = false;
      if (isSentUnknown(e)) { held = null; view = { ...v, at: "sent", txid: "" }; error = "보냈는지 확인하지 못했어요. 다시 내지 말고, 지갑의 거래 내역에서 먼저 확인해 주세요."; paint(); return; }
      error = deps.errText(e); paint(); return;
    }
    busy = false; held = null;
    if (!/^[0-9a-f]{64}$/i.test(txid)) { view = { ...v, at: "sent", txid: "" }; error = "보냈는지 확인하지 못했어요. 다시 내지 말고, 지갑의 거래 내역에서 먼저 확인해 주세요."; paint(); return; }
    void deps.invoke("maju_ack", { reservationId: v.r.reservationId }).catch(() => {});
    await confirmPaid({ ...v, at: "sent", txid });
  }

  /** 보낸 txid 로 확정 — 장부에 보일 때까지 몇 번 기다린다. 끝내 안 보이면 「주문 다시 확인」을 남긴다. 다시 보내지 않는다. */
  async function confirmPaid(v: Extract<View, { at: "sent" }>) {
    view = v; busy = true; error = ""; paint();
    for (let i = 0; ; i++) {
      try { finished(v.p, v.r, v.saved, await confirmMaju(v.r, v.ship, v.consent, v.txid)); return; }
      catch (e) {
        const notSeen = e instanceof MajuError && e.code === "state" && e.detail === "rvn-not-seen";
        if (!notSeen || i >= 7) { busy = false; error = majuErrorText(e); if (view === v) paint(); return; }
        await wait(4000);
      }
    }
  }

  function paintSent(v: Extract<View, { at: "sent" }>) {
    focus(true);
    host.innerHTML = `<div class="mj-form mj-done"><span class="mj-mark">${ICON_CHECK}</span><h3>${copyHtml("RVN 을 보냈어요")}</h3>` +
      `<p class="meta">${copyHtml(busy ? "PLAY X 장터가 장부에서 확인하고 있어요…" : "PLAY X 장터가 아직 확인하지 못했어요")}</p>` + errLine() +
      `<p class="meta">${copyHtml("다시 보내지 마세요. 거래 보관함에도 남아 있어요.")}</p>` +
      (v.txid ? `<p class="meta">${copyHtml("거래 번호")} <code translate="no">${esc(v.txid)}</code></p>` : "") +
      `<div class="row mj-acts">${!busy && v.txid ? `<button type="button" data-mj-again="1">${copyHtml("주문 다시 확인")}</button>` : ""}` +
      `<button type="button" class="ghost" data-mj-orders="1">${copyHtml("내 주문 · 주문 찾기")}</button></div></div>`;
    host.querySelector<HTMLElement>("[data-mj-again]")?.addEventListener("click", () => void confirmPaid(v));
    host.querySelector<HTMLElement>("[data-mj-orders]")!.onclick = () => go({ at: "orders" });
  }

  function paintDone(v: Extract<View, { at: "done" }>) {
    focus(true);
    host.innerHTML = `<div class="mj-form mj-done"><span class="mj-mark">${ICON_CHECK}</span><h3>${copyHtml("결제했어요")}</h3><p class="meta">${copyHtml("PLAY X 장터가 주문을 받았어요")}</p>` +
      `<div class="mj-box">${row("주문 번호", esc(v.order.shortNo))}${row("상품", `<span translate="no">${esc(v.p.title)}</span> × ${v.qty}`)}${row("낸 돈", esc(wonText(v.order.totalWon)))}</div>` +
      (v.p.test ? `<p class="meta">${copyHtml("시험 주문이에요. 돈이 나가지 않았고 실제로 보내지 않아요.")}</p>` : "") +
      `<div class="row mj-acts"><button type="button" data-mj-orders="1">${copyHtml("내 주문 · 주문 찾기")}</button><button type="button" class="ghost" data-mj-back="1">${copyHtml("장터로")}</button></div></div>`;
    host.querySelector<HTMLElement>("[data-mj-orders]")!.onclick = () => go({ at: "orders" });
    wireBack();
    void load(true);
  }

  // ── 내 주문 ──
  const orderViews = new Map<string, MajuOrderView | "failed">();
  function paintOrders() {
    focus(true);
    const saved = savedOrders();
    host.innerHTML = back() + `<h3>${copyHtml("내 주문 · 주문 찾기")}</h3>` +
      (!saved.length ? `<p class="meta">${copyHtml("아직 주문이 없어요.")}</p>` : "") +
      `<div class="mj-orders">${saved.map((o) => `<div class="mj-order" data-mj-order="${esc(o.orderId)}"></div>`).join("")}</div>` +
      `<div class="mj-box mj-find"><b>${copyHtml("주문번호로 찾기")}</b><p class="meta">${copyHtml("다른 기기에서 한 주문은 그 기기 보관함의 「코드 복사」로 받은 주문 찾기 코드를 붙여 넣어 주세요.")}</p>` +
      `<div class="mj-search"><input data-mj-code="1" maxlength="160" placeholder="${esc(t("주문 찾기 코드 (MJ1.…)"))}" aria-label="${esc(t("주문 찾기 코드 (MJ1.…)"))}" /><button type="button" data-mj-find="1">${copyHtml("주문 찾기")}</button></div>` +
      `<p class="meta" data-mj-find-say="1" role="status"></p></div>`;
    wireBack();
    for (const o of saved) { paintOrder(o); void refreshOrder(o); }
    const code = host.querySelector<HTMLInputElement>("[data-mj-code]")!, find = host.querySelector<HTMLButtonElement>("[data-mj-find]")!, say = host.querySelector<HTMLElement>("[data-mj-find-say]")!;
    find.onclick = async () => {
      const c = parseMajuOrderCode(code.value.trim());
      if (!c) { say.innerHTML = `<span class="danger">${esc(t(majuErrorText(new MajuError("bad-code"))))}</span>`; return; }
      find.disabled = true; setCopyText(say, () => t("찾는 중…"));
      try {
        const v = await loadMajuOrder({ orderId: c.id, token: c.token });
        writePref(MAJU_ORDERS_KEY, JSON.stringify(addSavedOrder(savedOrders(), { orderId: c.id, token: c.token, title: v.title, shortNo: v.shortNo, at: Date.now(), test: v.test })));
        orderViews.set(c.id, v);
        paintOrders();
        const s2 = host.querySelector<HTMLElement>("[data-mj-find-say]"); if (s2) setCopyText(s2, () => t("이 기기 주문에 더했어요"));
      } catch (e) {
        find.disabled = false;
        const bad = e instanceof MajuError && (e.code === "forbidden" || e.code === "not-found") ? new MajuError("bad-code") : e;
        say.innerHTML = `<span class="danger">${esc(t(majuErrorText(bad)))}</span>`;
      }
    };
  }
  async function refreshOrder(o: SavedMajuOrder) {
    try { orderViews.set(o.orderId, await loadMajuOrder(o)); } catch { orderViews.set(o.orderId, "failed"); }
    if (view.at === "orders") paintOrder(o);
  }
  function paintOrder(o: SavedMajuOrder, note = "") {
    const box = host.querySelector<HTMLElement>(`[data-mj-order="${CSS.escape(o.orderId)}"]`);
    if (!box) return;
    const got = orderViews.get(o.orderId), v = got && got !== "failed" ? got : null, step = v ? v.step : -2;
    const tr = v ? majuTracking(v) : null;
    const a = v?.after;
    box.innerHTML =
      `<div class="mj-ohead"><b>${copyHtml("PLAY X 장터")}${o.test ? ` · ${copyHtml("시험")}` : ""}</b><span class="meta">${esc(o.shortNo)}</span></div>` +
      `<p class="mj-ctitle" translate="no">${esc(o.title)}${v ? ` × ${v.qty}` : ""}</p>` +
      (v ? `<p class="meta">${esc(wonText(v.totalWon))}</p>` : got === "failed" ? `<p class="meta">${copyHtml("지금 상태를 받지 못했어요")}</p>` : `<p class="meta">${copyHtml("가져오는 중…")}</p>`) +
      (step === -1 ? `<p class="danger">${copyHtml("취소된 주문이에요")}</p>` : "") +
      (v && step >= 0 ? `<ol class="mj-steps" aria-label="${esc(`${t("진행")} · ${t(MAJU_STEPS[Math.min(step, 3)])}`)}">${MAJU_STEPS.map((n, i) => `<li class="${i <= step ? "on" : ""}${i === step ? " now" : ""}">${copyHtml(n)}</li>`).join("")}</ol>` : "") +
      (tr ? `<p class="mj-track"><span>${esc(t(tr.name))}</span> <code translate="no">${esc(tr.number)}</code>${tr.url ? ` <button type="button" class="ghost" data-mj-track="1">${copyHtml("배송 조회")}</button>` : ""}</p>` : "") +
      (a ? afterHtml(a) : v?.ask.phone ? `<p class="meta">${copyHtml("PLAY X 장터에 묻기")} · <span translate="no">${esc(v.ask.phone)}</span></p>` : "") +
      (note ? `<p class="meta" role="status">${esc(t(note))}</p>` : "") +
      `<div class="row mj-small"><button type="button" class="ghost" data-mj-re="1">${copyHtml("새로 보기")}</button><button type="button" class="ghost" data-mj-copy="1">${copyHtml("코드 복사")}</button></div>` +
      `<p class="meta" data-mj-copied="1" role="status"></p>`;
    box.querySelector<HTMLElement>("[data-mj-track]")?.addEventListener("click", () => { if (tr?.url) void deps.openUrl(tr.url).catch(() => {}); });
    const re = box.querySelector<HTMLButtonElement>("[data-mj-re]")!;
    re.onclick = () => { re.disabled = true; setCopyText(re, () => t("읽는 중…")); void refreshOrder(o); };
    box.querySelector<HTMLElement>("[data-mj-copy]")!.onclick = async () => {
      const say = box.querySelector<HTMLElement>("[data-mj-copied]")!;
      try { await navigator.clipboard.writeText(majuLookupCode(o.orderId, o.token)); setCopyText(say, () => t("복사했어요 · 다른 기기 「주문번호로 찾기」에 붙여 넣어요")); }
      catch { setCopyText(say, () => t("복사하지 못했어요")); }
    };
    if (a) wireAfter(box, o, a);
  }

  /** 받은 뒤 — 잘 받았어요 · 칭찬 · 문제가 있어요 · 만든 분께 묻기. 누를 수 있는 것은 서버가 정한다. */
  function afterHtml(a: NonNullable<MajuOrderView["after"]>): string {
    return `<div class="mj-after">` +
      (a.canReceive ? `<button type="button" data-mj-recv="1">${copyHtml("잘 받았어요")}</button><p class="meta">${copyHtml("상품이 도착했으면 눌러 주세요")}</p>` : "") +
      (a.canPraise ? `<div class="mj-box"><b>${copyHtml("칭찬 한마디 남겨 주세요")}</b><div class="mj-chips">${a.praiseTags.map((g, i) => `<button type="button" class="ghost" data-mj-tag="${i}" aria-pressed="false">${copyHtml(g)}</button>`).join("")}</div>` +
        `<input data-mj-pline="1" maxlength="200" hidden placeholder="${esc(t("한 줄 더 적어도 돼요 (없어도 돼요)"))}" aria-label="${esc(t("한 줄 더 적어도 돼요 (없어도 돼요)"))}" />` +
        `<div class="row"><button type="button" data-mj-praise="1" disabled>${copyHtml("칭찬 보내기")}</button></div></div>` : "") +
      (a.praise ? `<div class="mj-box"><b>${copyHtml("남긴 칭찬")}</b><p class="meta">${esc(a.praise.tags.map((g) => t(g)).join(" · "))}</p>${a.praise.line && a.praise.line !== a.praise.tags.join(" · ") ? `<p class="meta">“${esc(a.praise.line)}”</p>` : ""}</div>` : "") +
      (a.problemSent ? `<p class="meta">${copyHtml("문제를 알려 주셨어요. PLAY X 장터가 확인한 뒤 연락드려요")}</p>` : "") +
      (a.thread.length ? `<div class="mj-thread">${a.thread.map((m) => `<div class="mj-bubble ${m.from === "me" ? "me" : "them"}"><small>${esc(m.from === "maker" ? m.who.replace("만든 분", t("만든 분")) : t(m.who))}</small><span>${esc(m.text)}</span></div>`).join("")}</div>` : "") +
      `<div data-mj-open-box="1"></div>` +
      `<div class="row mj-small"><button type="button" class="ghost" data-mj-ask="1">${copyHtml("만든 분께 묻기")}</button>` +
      (a.canProblem ? `<button type="button" class="ghost" data-mj-prob="1">${copyHtml("문제가 있어요")}</button>` : "") + `</div></div>`;
  }
  function wireAfter(box: HTMLElement, o: SavedMajuOrder, a: NonNullable<MajuOrderView["after"]>) {
    const run = async (btn: HTMLButtonElement, job: () => Promise<unknown>, done: string) => {
      btn.disabled = true; setCopyText(btn, () => t("보내는 중…"));
      try { await job(); await refreshOrderQuiet(o); paintOrder(o, done); }
      catch (e) { paintOrder(o, majuErrorText(e)); }
    };
    const recv = box.querySelector<HTMLButtonElement>("[data-mj-recv]");
    if (recv) recv.onclick = () => void run(recv, () => majuReceived(o), "고마워요! 맛있게 드세요");
    const tags = new Set<string>();
    const praise = box.querySelector<HTMLButtonElement>("[data-mj-praise]"), pline = box.querySelector<HTMLInputElement>("[data-mj-pline]");
    box.querySelectorAll<HTMLButtonElement>("[data-mj-tag]").forEach((b) => {
      b.onclick = () => { const g = a.praiseTags[Number(b.dataset.mjTag)]; if (tags.has(g)) tags.delete(g); else tags.add(g); b.setAttribute("aria-pressed", String(tags.has(g))); if (praise) praise.disabled = !tags.size; if (pline) pline.hidden = !tags.size; };
    });
    if (praise) praise.onclick = () => void run(praise, () => majuPraise(o, [...tags], pline?.value.trim() ?? ""), "칭찬 고마워요! 만든 분께 바로 전해 드렸어요");
    const openBox = box.querySelector<HTMLElement>("[data-mj-open-box]")!;
    box.querySelector<HTMLElement>("[data-mj-ask]")!.onclick = () => {
      openBox.innerHTML = `<div class="mj-box"><textarea data-mj-askt="1" maxlength="500" rows="3" placeholder="${esc(t("만든 분께 물어볼 것을 적어 주세요"))}" aria-label="${esc(t("만든 분께 물어볼 것을 적어 주세요"))}"></textarea>` +
        `<div class="row"><button type="button" data-mj-asksend="1" disabled>${copyHtml("보내기")}</button></div></div>`;
      const ta = openBox.querySelector<HTMLTextAreaElement>("[data-mj-askt]")!, sendBtn = openBox.querySelector<HTMLButtonElement>("[data-mj-asksend]")!;
      ta.oninput = () => { sendBtn.disabled = ta.value.trim().length < 2; };
      sendBtn.onclick = () => void run(sendBtn, () => majuAsk(o, ta.value.trim()), "보냈어요. 만든 분이나 PLAY X 장터가 답하면 여기에 보여요");
      ta.focus();
    };
    box.querySelector<HTMLElement>("[data-mj-prob]")?.addEventListener("click", () => {
      let reason = "";
      openBox.innerHTML = `<div class="mj-box"><b>${copyHtml("어떤 문제가 있나요?")}</b><div class="mj-chips" role="radiogroup">${a.problemReasons.map((g, i) => `<button type="button" class="ghost" data-mj-why="${i}" role="radio" aria-checked="false">${copyHtml(g)}</button>`).join("")}</div>` +
        `<textarea data-mj-probt="1" maxlength="500" rows="3" placeholder="${esc(t("조금 더 알려 주세요 (없어도 돼요)"))}" aria-label="${esc(t("조금 더 알려 주세요 (없어도 돼요)"))}"></textarea>` +
        `<div class="row"><button type="button" class="danger-btn" data-mj-probsend="1" disabled>${copyHtml("PLAY X 장터에 알리기")}</button></div></div>`;
      const sendBtn = openBox.querySelector<HTMLButtonElement>("[data-mj-probsend]")!;
      openBox.querySelectorAll<HTMLButtonElement>("[data-mj-why]").forEach((b) => {
        b.onclick = () => { reason = a.problemReasons[Number(b.dataset.mjWhy)]; openBox.querySelectorAll("[data-mj-why]").forEach((x) => x.setAttribute("aria-checked", String(x === b))); sendBtn.disabled = false; };
      });
      sendBtn.onclick = () => void run(sendBtn, () => majuProblem(o, reason, openBox.querySelector<HTMLTextAreaElement>("[data-mj-probt]")!.value.trim()), "알려 주셔서 고마워요. PLAY X 장터가 확인한 뒤 연락드려요");
    });
  }
  async function refreshOrderQuiet(o: SavedMajuOrder) { try { orderViews.set(o.orderId, await loadMajuOrder(o)); } catch { /* 그대로 */ } }

  function paint() {
    switch (view.at) {
      case "row": return paintRow();
      case "detail": return paintDetail(view.p);
      case "ship": return paintShip(view.p, view.r);
      case "pay": return paintPay(view);
      case "sent": return paintSent(view);
      case "done": return paintDone(view);
      case "orders": return paintOrders();
    }
  }

  return {
    /** 장터에 들어올 때 — 사는 중(잡기·보냄)이 아니면 첫 칸부터. */
    enter() {
      if (view.at === "ship" || view.at === "pay" || view.at === "sent") { paint(); return; }
      view = { at: "row" }; paint();
      void load().then(() => { if (view.at === "row") paint(); });
    },
    /** 설정 「마주 시험 상품」을 바꿨을 때. */
    reload() { void load(true).then(() => { if (view.at === "row") paint(); }); },
    /** 장터를 떠날 때 — 잡아 둔 것을 돌려놓는다(보낸 뒤는 아님). */
    leave() { if (view.at === "ship" || view.at === "detail") { releaseHeld(); view = { at: "row" }; focus(false); } },
  };
}
