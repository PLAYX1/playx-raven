/*
 * 0.9.17 맞교환 장터 화면 · 「장터에 올리기」 · 「내 글」.
 *
 * 러스트 명령(swap.rs · market 쪽)은 따로 만든다. 여기는 보여 주고 누르는 것만.
 *   market_publish_listing({offerHex, title, summary, category, image?}) → {eventId, d, listing}
 *   market_browse({category?, limit?})       → ListingView[]
 *   market_my_listings()                     → ListingView[]
 *   market_cancel_listing({d, passphrase?})  → {txid, eventId}
 *   swap_take_listing({listing, broadcast, passphrase?}) → 미리보기 | {txid}
 *   talk_my_posts({limit})                   → talk_read 와 같은 글 목록
 *
 * 🔴 돈이 나가는 일(사기·내리기)은 **사람이 한 번 더 누를 때만** 보낸다. 미리보기 없이 보내는 길은 없다.
 * 🔴 남이 적은 글자(제목·설명·자산 이름·글)는 번역하지 않는다(translate="no") — 사장이 적은 말 그대로.
 * 🔴 답의 모양을 믿지 않는다 — 배열이 아니면 빈 목록, 숫자가 아니면 그 줄을 안 그린다(지어낸 숫자를 보이지 않는다).
 */
import "./listing-market.css";
import { t, copyHtml, setCopyText } from "./i18n";
import { fmtRvn } from "./amount-ui";

type Invoke = <T = any>(cmd: string, args?: Record<string, unknown>) => Promise<T>;

export interface ListingDeps {
  invoke: Invoke;
  /** 잠긴 지갑이면 암호를 묻고 잠깐 연다. 취소하면 false. (main.ts 의 ensureUnlocked) */
  ensureUnlocked: (why: string) => Promise<boolean>;
  errText: (e: unknown) => string;
  fmtQty: (n: number) => string;
}

export const LISTING_CATEGORIES: readonly (readonly [string, string])[] = [
  ["music", "노래"], ["game", "게임"], ["image", "이미지"], ["book", "책"],
  ["ticket", "티켓"], ["work", "작품"], ["other", "기타"],
];
const CATEGORY_LABEL = new Map(LISTING_CATEGORIES.map(([id, ko]) => [id, ko]));

export interface ListingView {
  d: string; pubkey: string; eventId: string; title: string; summary: string; category: string;
  asset: string; amount: number; priceRvn: number; pay: unknown; outpoint: { txid: string; vout: number };
  swap: unknown; image: string; publishedAt: number; status: string; mine: boolean; check: { ok: boolean; reason: string };
}

function esc(s: unknown): string {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}
const num = (v: unknown): number | null => {
  const n = typeof v === "string" && v.trim() !== "" ? Number(v) : typeof v === "number" ? v : NaN;
  return Number.isFinite(n) ? n : null;
};
/** 처음 나온 숫자 값. 없으면 null — 0 으로 바꾸지 않는다(모르는 값을 0 으로 보이면 거짓말이다). */
function pickNum(o: any, keys: string[]): number | null {
  if (!o || typeof o !== "object") return null;
  for (const k of keys) { const n = num(o[k]); if (n !== null) return n; }
  return null;
}
const isSentUnknown = (e: unknown) => /SENT_UNKNOWN/.test(String(e));

/** 답 하나를 화면이 쓰는 모양으로. 빠진 칸은 빈 값 — 지어 넣지 않는다. */
export function normalizeListing(raw: any): ListingView | null {
  if (!raw || typeof raw !== "object") return null;
  const op = raw.outpoint && typeof raw.outpoint === "object" ? raw.outpoint : {};
  const check = raw.check && typeof raw.check === "object" ? raw.check : {};
  return {
    d: String(raw.d ?? ""), pubkey: String(raw.pubkey ?? ""), eventId: String(raw.eventId ?? raw.event_id ?? ""),
    title: String(raw.title ?? ""), summary: String(raw.summary ?? ""), category: String(raw.category ?? "other"),
    asset: String(raw.asset ?? ""), amount: num(raw.amount) ?? 0, priceRvn: num(raw.priceRvn ?? raw.price_rvn) ?? 0,
    pay: raw.pay, outpoint: { txid: String(op.txid ?? ""), vout: num(op.vout) ?? 0 },
    swap: raw.swap, image: String(raw.image ?? ""), publishedAt: num(raw.publishedAt ?? raw.published_at) ?? 0,
    status: String(raw.status ?? ""), mine: raw.mine === true,
    // check 가 없으면 「살 수 있다」로 두지 않는다 — 러스트가 확인한 것만 믿는다.
    check: { ok: check.ok === true, reason: String(check.reason ?? "") },
    // 원본은 그대로 들고 다닌다 — swap_take_listing 에는 받은 그대로 돌려준다.
    __raw: raw,
  } as ListingView & { __raw: unknown };
}
const rawOf = (l: ListingView): unknown => (l as any).__raw ?? l;
const listOf = (r: unknown): ListingView[] =>
  (Array.isArray(r) ? r : []).map(normalizeListing).filter((x): x is ListingView => !!x);

/* ── 그림 ────────────────────────────────────────────────────────
   🔴 남이 적은 https 주소를 저절로 열면 그 서버가 읽는 사람의 IP·시각을 안다(이야기 사진과 같은 규칙).
      IPFS(이 컴퓨터의 파일창고)와 nostr.build 만 저절로 그리고, 나머지는 「그림 보기」를 눌러야 연다. */
function imageInfo(raw: string): { src: string; auto: boolean } | null {
  const s = String(raw || "").trim();
  if (!s) return null;
  const cid = s.match(/^ipfs:\/\/([A-Za-z0-9]{20,100}(?:\/[\w.-]+)*)$/)?.[1] || s.match(/^https?:\/\/[^\s"'<>]+\/ipfs\/([A-Za-z0-9]{20,100}(?:\/[\w.-]+)*)$/)?.[1];
  if (cid) return { src: `http://127.0.0.1:8080/ipfs/${cid}`, auto: true };
  try {
    const u = new URL(s);
    if (u.protocol !== "https:" || s.length > 500) return null;
    const h = u.hostname;
    return { src: u.href, auto: h === "nostr.build" || h.endsWith(".nostr.build") };
  } catch { return null; }
}
/** 러스트(clean_image)와 같은 규칙: 비었거나 https:// · ipfs:// 로 시작하고 빈칸·따옴표·꺾쇠가 없다. */
export function validImageAddress(raw: string): boolean {
  const s = raw.trim();
  return !s || (/^(https|ipfs):\/\/[^\s"'<>]+$/.test(s) && s.length <= 500);
}

function imageHtml(raw: string): string {
  const info = imageInfo(raw);
  if (!info) return "";
  if (info.auto) return `<div class="lm-pic"><img src="${esc(info.src)}" alt="" loading="lazy" data-onfail="remove" /></div>`;
  return `<div class="lm-pic lm-pic-ask"><button type="button" class="ghost" data-lm-pic="${esc(info.src)}">${copyHtml("그림 보기")}</button>` +
    `<span class="meta">${copyHtml("그림을 열면 그림이 있는 서버가 내 컴퓨터 주소(IP)를 알게 돼요.")}</span></div>`;
}
function wirePics(host: HTMLElement) {
  host.querySelectorAll<HTMLButtonElement>("[data-lm-pic]").forEach((b) => {
    b.onclick = () => {
      const img = document.createElement("img");
      img.src = String(b.dataset.lmPic || ""); img.alt = ""; img.dataset.onfail = "remove";
      b.parentElement?.replaceChildren(img);
    };
  });
}

/* ── 카드 ──────────────────────────────────────────────────────── */
function statusLabel(s: string): string {
  const v = s.toLowerCase();
  if (!v || /^(open|active|listed|live)$/.test(v)) return "올라가 있음";
  if (/^(sold|taken|spent|filled)$/.test(v)) return "팔렸음";
  if (/^(cancel+ed|withdrawn|closed|removed)$/.test(v)) return "내렸음";
  return s;
}
const isOpen = (l: ListingView) => statusLabel(l.status) === "올라가 있음";

function cardHtml(l: ListingView, deps: ListingDeps, mode: "browse" | "mine" | "preview", key = ""): string {
  const off = mode === "browse" && !l.check.ok;
  const mineBad = mode === "mine" && isOpen(l) && !l.check.ok && !!l.check.reason;
  const cat = CATEGORY_LABEL.get(l.category) || "기타";
  const head =
    `<div class="lm-top"><span class="lm-cat">${copyHtml(cat)}</span>` +
    (mode === "mine" ? ` <span class="lm-status">${copyHtml(statusLabel(l.status))}</span>` : "") +
    (mode === "browse" && l.mine ? ` <span class="lm-status">${copyHtml("내가 올린 것")}</span>` : "") +
    `</div>`;
  const body =
    `<h3 translate="no">${esc(l.title)}</h3>` +
    (l.summary ? `<p class="lm-sum" translate="no">${esc(l.summary)}</p>` : "") +
    `<p class="lm-asset"><span translate="no">${esc(l.asset)}</span> · ${esc(deps.fmtQty(l.amount))}${copyHtml("개")}</p>` +
    `<p class="lm-price"><b>${esc(fmtRvn(l.priceRvn))}</b> <span class="meta">${copyHtml("수수료 1% 별도")}</span></p>`;
  const why = off || mineBad
    ? `<p class="lm-why"><b>${copyHtml("살 수 없어요")}</b>${l.check.reason ? ` — ${esc(t(l.check.reason))}` : ""}</p>`
    : "";
  const acts =
    mode === "browse" && l.check.ok && !l.mine ? `<div class="row lm-acts"><button type="button" data-lm-buy="${esc(key)}">${copyHtml("사기")}</button></div>`
    : mode === "mine" && isOpen(l) ? `<div class="row lm-acts"><button type="button" class="ghost" data-lm-cancel="${esc(key)}">${copyHtml("내리기")}</button></div>`
    : "";
  return `<li class="card lm-card${off ? " lm-off" : ""}" data-lm-key="${esc(key)}">${imageHtml(l.image)}<div class="lm-body">${head}${body}${why}${acts}` +
    `<div class="lm-step" data-lm-step="${esc(key)}"></div></div></li>`;
}

/* ── 사기: 미리보기 → 「정말 사기」 ────────────────────────────────── */
async function buyFlow(l: ListingView, step: HTMLElement, deps: ListingDeps, onDone: () => void) {
  if (!(await deps.ensureUnlocked(t("살 때 내 몫을 서명하려면 지갑을 열어야 합니다.")))) return;
  step.innerHTML = `<p class="meta">${copyHtml("거래를 만들어 확인하는 중…")}</p>`;
  let p: any;
  try {
    p = await deps.invoke<any>("swap_take_listing", { listing: rawOf(l), broadcast: false, passphrase: null });
  } catch (e) {
    step.innerHTML = `<p class="meta danger">${esc(deps.errText(e))}</p>`;
    return;
  }
  // 러스트 답: { check: swap_check 결과(price·fee=개발비·total=price+개발비), take: swap_take 미리보기(fee=공개 장부 수수료·dev_fee) }.
  //   모양이 바뀌어도 아는 숫자만 그린다 — 모르는 칸은 0 이 아니라 「안 그림」.
  const chk = p?.check && typeof p.check === "object" ? p.check : {};
  const take = p?.take && typeof p.take === "object" ? p.take : {};
  const asset = String(chk.asset || take.asset || l.asset);
  const amount = pickNum(chk, ["amount"]) ?? pickNum(take, ["amount"]) ?? l.amount;
  const price = pickNum(chk, ["price"]) ?? pickNum(take, ["price"]) ?? l.priceRvn;
  const dev = pickNum(chk, ["fee"]) ?? pickNum(take, ["dev_fee", "devFee"]);
  const net = pickNum(take, ["fee"]);
  const sub = pickNum(chk, ["total"]) ?? (dev !== null ? price + dev : null);
  // 「모두」 = 파는 사람 + 개발비 + 공개 장부 수수료. 하나라도 모르면 「모두」를 안 그린다.
  const total = sub !== null && net !== null ? Math.round((sub + net) * 1e8) / 1e8 : null;
  const row = (label: string, v: string, strong = false) =>
    `<div class="kv"><b>${copyHtml(label)}</b><span>${strong ? `<b>${v}</b>` : v}</span></div>`;
  step.innerHTML =
    `<div class="lm-confirm" role="group">` +
    `<h4>${copyHtml("사기 전에 확인해 주세요")}</h4>` +
    row("받는 것", `<span translate="no">${esc(asset)}</span> ${esc(deps.fmtQty(amount))}${copyHtml("개")}`) +
    row("파는 사람에게", esc(fmtRvn(price))) +
    (dev !== null ? row("개발비 1%", esc(fmtRvn(dev))) : "") +
    (net !== null ? row("공개 장부 수수료", esc(fmtRvn(net))) : "") +
    (total !== null ? row("모두", esc(fmtRvn(total)), true) : "") +
    `<p class="meta">${copyHtml("한 거래 안에서 동시에 오갑니다. 먼저 보내지 않습니다.")}</p>` +
    `<p class="lm-warn">${copyHtml("아직 돈은 나가지 않았어요. 「정말 사기」를 눌러야 보내요. 보낸 뒤에는 되돌릴 수 없어요.")}</p>` +
    `<div class="row"><button type="button" data-lm-go="1">${copyHtml("정말 사기")}</button>` +
    `<button type="button" class="ghost" data-lm-stop="1">${copyHtml("그만두기")}</button></div>` +
    `<p class="meta" data-lm-say="1" role="status"></p></div>`;
  const go = step.querySelector<HTMLButtonElement>("[data-lm-go]")!;
  const stop = step.querySelector<HTMLButtonElement>("[data-lm-stop]")!;
  const say = step.querySelector<HTMLElement>("[data-lm-say]")!;
  stop.onclick = () => { step.innerHTML = ""; };
  go.onclick = async () => {
    // 두 번 눌러 두 번 사지 않게 — 누르는 즉시 막는다.
    go.disabled = true; stop.disabled = true;
    setCopyText(say, () => t("보내는 중…"));
    try {
      if (!(await deps.ensureUnlocked(t("살 때 내 몫을 서명하려면 지갑을 열어야 합니다.")))) { go.disabled = false; stop.disabled = false; say.textContent = ""; return; }
      const r = await deps.invoke<any>("swap_take_listing", { listing: rawOf(l), broadcast: true, passphrase: null });
      const txid = String(r?.txid ?? "");
      if (!txid) {
        step.innerHTML = `<p class="danger">${copyHtml("보냈는지 확인하지 못했어요. 같은 것을 다시 사지 말고, 지갑의 거래 내역에서 먼저 확인해 주세요.")}</p>`;
        return;
      }
      step.innerHTML = `<p class="ok">${copyHtml("보냈어요. 체인에 올라가려면 몇 분 걸려요.")}</p>` +
        (txid ? `<p class="meta lm-txid">${copyHtml("거래 번호")} <code translate="no">${esc(txid)}</code></p>` : "");
      onDone();
    } catch (e) {
      if (isSentUnknown(e)) {
        // 보냈을 수도 있다 — 다시 사는 단추를 살리지 않는다.
        step.innerHTML = `<p class="danger">${copyHtml("보냈는지 확인하지 못했어요. 같은 것을 다시 사지 말고, 지갑의 거래 내역에서 먼저 확인해 주세요.")}</p>`;
        return;
      }
      go.disabled = false; stop.disabled = false;
      say.innerHTML = `<span class="danger">${esc(deps.errText(e))}</span>`;
    }
  };
}

/* ── 내리기: 화면 안에서 한 번 더 묻기(창을 띄우지 않는다) ─────────────── */
function cancelFlow(l: ListingView, step: HTMLElement, deps: ListingDeps, onDone: () => void) {
  step.innerHTML =
    `<div class="lm-confirm" role="group"><p>${copyHtml("정말 내릴까요? 내리면 이 제안에 묶어 둔 자산을 내 지갑으로 되돌리는 거래를 보내요. 공개 장부 수수료가 조금 들어요.")}</p>` +
    `<div class="row"><button type="button" data-lm-yes="1">${copyHtml("네, 내리기")}</button>` +
    `<button type="button" class="ghost" data-lm-no="1">${copyHtml("그만두기")}</button></div>` +
    `<p class="meta" data-lm-say="1" role="status"></p></div>`;
  const yes = step.querySelector<HTMLButtonElement>("[data-lm-yes]")!;
  const no = step.querySelector<HTMLButtonElement>("[data-lm-no]")!;
  const say = step.querySelector<HTMLElement>("[data-lm-say]")!;
  no.onclick = () => { step.innerHTML = ""; };
  yes.onclick = async () => {
    yes.disabled = true; no.disabled = true;
    if (!(await deps.ensureUnlocked(t("내리려면 지갑을 열어야 합니다.")))) { yes.disabled = false; no.disabled = false; return; }
    setCopyText(say, () => t("내리는 중…"));
    try {
      const r = await deps.invoke<any>("market_cancel_listing", { d: l.d, passphrase: null });
      const txid = String(r?.txid ?? "");
      step.innerHTML = `<p class="ok">${copyHtml("내렸어요.")}</p>` +
        (txid ? `<p class="meta lm-txid">${copyHtml("거래 번호")} <code translate="no">${esc(txid)}</code></p>` : "") +
        (r?.warn ? `<p class="meta warn">${esc(t(String(r.warn)))}</p>` : "");
      onDone();
    } catch (e) {
      if (isSentUnknown(e)) { step.innerHTML = `<p class="danger">${esc(deps.errText(e))}</p>`; return; }
      yes.disabled = false; no.disabled = false;
      say.innerHTML = `<span class="danger">${esc(deps.errText(e))}</span>`;
    }
  };
}

/* ── 장터 화면 ───────────────────────────────────────────────────── */
export function mountListingMarket(page: HTMLElement, deps: ListingDeps) {
  let tab: "browse" | "mine" = "browse";
  let cat = "";
  let seq = 0;
  const tabs = page.querySelector<HTMLElement>("#lm-tabs")!;
  const chips = page.querySelector<HTMLElement>("#lm-chips")!;
  const list = page.querySelector<HTMLUListElement>("#lm-list")!;
  const say = page.querySelector<HTMLElement>("#lm-say")!;
  const refresh = page.querySelector<HTMLButtonElement>("#lm-refresh")!;

  const paintTabs = () => {
    tabs.innerHTML = ([["browse", "둘러보기"], ["mine", "내 판매 글"]] as const)
      .map(([id, ko]) => `<button type="button" data-lm-tab="${id}" aria-pressed="${tab === id}">${copyHtml(ko)}</button>`).join("");
    tabs.querySelectorAll<HTMLElement>("[data-lm-tab]").forEach((b) => {
      b.onclick = () => { tab = b.dataset.lmTab === "mine" ? "mine" : "browse"; void paint(); };
    });
    chips.hidden = tab !== "browse";
    chips.innerHTML = [["", "전체"] as const, ...LISTING_CATEGORIES]
      .map(([id, ko]) => `<button type="button" data-lm-cat="${id}" aria-pressed="${cat === id}">${copyHtml(ko)}</button>`).join("");
    chips.querySelectorAll<HTMLElement>("[data-lm-cat]").forEach((b) => {
      b.onclick = () => { cat = String(b.dataset.lmCat || ""); void paint(); };
    });
  };

  async function paint() {
    const my = ++seq;
    paintTabs();
    list.innerHTML = "";
    setCopyText(say, () => t("장터 가져오는 중…"));
    let items: ListingView[];
    try {
      const r = tab === "mine"
        ? await deps.invoke<unknown>("market_my_listings")
        : await deps.invoke<unknown>("market_browse", { category: cat || null, limit: 30 });
      items = listOf(r);
    } catch (e) {
      if (my !== seq) return;
      say.innerHTML = `<span class="danger">${copyHtml(tab === "mine" ? "내 판매 글을 읽지 못했어요." : "장터를 읽지 못했어요.")} ${esc(deps.errText(e))}</span>`;
      return;
    }
    if (my !== seq) return;
    // 러스트가 종류로 거르지 않아도 화면이 한 번 더 거른다.
    if (tab === "browse" && cat) items = items.filter((l) => l.category === cat);
    if (!items.length) {
      setCopyText(say, () => t(tab === "mine" ? "아직 올린 판매 글이 없어요." : cat ? "이 종류에는 아직 없어요." : "아직 올라온 것이 없어요."));
      return;
    }
    say.textContent = "";
    // 살 수 있는 것이 위, 살 수 없는 것은 아래(회색).
    if (tab === "browse") items = [...items].sort((a, b) => Number(b.check.ok) - Number(a.check.ok) || b.publishedAt - a.publishedAt);
    list.innerHTML = items.map((l, i) => cardHtml(l, deps, tab, String(i))).join("");
    wirePics(list);
    list.querySelectorAll<HTMLElement>("[data-lm-buy]").forEach((b) => {
      b.onclick = () => {
        const k = String(b.dataset.lmBuy);
        const step = list.querySelector<HTMLElement>(`[data-lm-step="${k}"]`);
        if (step) void buyFlow(items[Number(k)], step, deps, () => { /* 목록은 그대로 둔다 — 거래 번호가 사라지지 않게 */ });
      };
    });
    list.querySelectorAll<HTMLElement>("[data-lm-cancel]").forEach((b) => {
      b.onclick = () => {
        const k = String(b.dataset.lmCancel);
        const step = list.querySelector<HTMLElement>(`[data-lm-step="${k}"]`);
        if (step) cancelFlow(items[Number(k)], step, deps, () => { b.remove(); });
      };
    });
  }

  refresh.onclick = () => void paint();
  return {
    enter(open?: "browse" | "mine") { if (open) tab = open; void paint(); },
  };
}

/* ── 맞교환 → 「장터에 올리기」 ─────────────────────────────────────── */
export function mountPublishForm(host: HTMLElement, offer: { hex: string; asset: string; amount: number; price: number }, deps: ListingDeps, goMarket: (tab: "browse" | "mine") => void) {
  const catOptions = LISTING_CATEGORIES.map(([id, ko]) => `<option value="${id}">${copyHtml(ko)}</option>`).join("");
  host.innerHTML =
    `<div class="lm-publish">` +
    `<button type="button" id="lm-pub-open">${copyHtml("장터에 올리기")}</button>` +
    `<div id="lm-pub-form" hidden>` +
    `<p class="meta">${copyHtml("이 제안을 장터에 올리면 누구나 보고 살 수 있어요. 산 사람이 RVN 을 붙여야 거래가 돼요.")}</p>` +
    `<label>${copyHtml("제목")}<input id="lm-pub-title" maxlength="100" autocomplete="off" placeholder="${esc(t("예: 1집 한정판"))}" /></label>` +
    `<label>${copyHtml("설명")}<textarea id="lm-pub-summary" rows="3" maxlength="300" placeholder="${esc(t("어떤 것인지 짧게 적어 주세요"))}"></textarea></label>` +
    `<label>${copyHtml("종류")}<select id="lm-pub-cat">${catOptions}</select></label>` +
    `<label>${copyHtml("그림 주소 (없어도 돼요)")}<input id="lm-pub-image" maxlength="500" spellcheck="false" autocomplete="off" placeholder="ipfs://… · https://…" /></label>` +
    `<div class="row"><button type="button" class="ghost" id="lm-pub-preview">${copyHtml("미리 보기")}</button></div>` +
    `<p class="meta" id="lm-pub-say" role="status"></p>` +
    `</div>` +
    `<div id="lm-pub-check" hidden></div>` +
    `</div>`;
  const $ = <T extends HTMLElement>(id: string) => host.querySelector<T>("#" + id)!;
  const form = $("lm-pub-form"), check = $("lm-pub-check"), say = $("lm-pub-say");
  const field = () => ({
    title: $<HTMLInputElement>("lm-pub-title").value.trim(),
    summary: $<HTMLTextAreaElement>("lm-pub-summary").value.trim(),
    category: $<HTMLSelectElement>("lm-pub-cat").value || "other",
    image: $<HTMLInputElement>("lm-pub-image").value.trim(),
  });
  $("lm-pub-open").onclick = () => { $("lm-pub-open").hidden = true; form.hidden = false; $<HTMLInputElement>("lm-pub-title").focus(); };
  $("lm-pub-preview").onclick = () => {
    const f = field();
    if (!f.title) { setCopyText(say, () => t("제목을 적어 주세요.")); return; }
    if (!validImageAddress(f.image)) { setCopyText(say, () => t("그림 주소는 ipfs:// 나 https:// 로 시작해야 해요.")); return; }
    say.textContent = "";
    const preview: ListingView = {
      d: "", pubkey: "", eventId: "", title: f.title, summary: f.summary, category: f.category, asset: offer.asset,
      amount: offer.amount, priceRvn: offer.price, pay: null, outpoint: { txid: "", vout: 0 }, swap: null,
      image: f.image, publishedAt: 0, status: "", mine: true, check: { ok: true, reason: "" },
    };
    form.hidden = true;
    check.hidden = false;
    check.innerHTML =
      `<p class="meta">${copyHtml("아래처럼 보여요. 맞으면 「올리기」를 누르세요.")}</p>` +
      `<ul class="lm-list">${cardHtml(preview, deps, "preview")}</ul>` +
      `<div class="row"><button type="button" id="lm-pub-go">${copyHtml("올리기")}</button>` +
      `<button type="button" class="ghost" id="lm-pub-edit">${copyHtml("고치기")}</button></div>` +
      `<p class="meta" id="lm-pub-gosay" role="status"></p>`;
    wirePics(check);
    const go = $<HTMLButtonElement>("lm-pub-go"), edit = $<HTMLButtonElement>("lm-pub-edit"), gosay = $("lm-pub-gosay");
    edit.onclick = () => { check.hidden = true; check.innerHTML = ""; form.hidden = false; };
    go.onclick = async () => {
      go.disabled = true; edit.disabled = true;
      setCopyText(gosay, () => t("장터에 올리는 중…"));
      try {
        await deps.invoke<any>("market_publish_listing", {
          offerHex: offer.hex, title: f.title, summary: f.summary, category: f.category, image: f.image || null,
        });
        check.innerHTML = `<p class="ok">${copyHtml("장터에 올렸어요.")}</p>` +
          `<div class="row"><button type="button" class="ghost" id="lm-pub-see">${copyHtml("장터에서 보기")}</button></div>`;
        $("lm-pub-see").onclick = () => goMarket("mine");
      } catch (e) {
        go.disabled = false; edit.disabled = false;
        gosay.innerHTML = `<span class="danger">${esc(deps.errText(e))}</span>`;
      }
    };
  };
}

/* ── 내 소개 → 「내 글」 ────────────────────────────────────────────── */
let myPostsSeq = 0;
export async function paintMyPosts(host: HTMLElement, deps: Pick<ListingDeps, "invoke" | "errText">, openFeed: () => void): Promise<void> {
  const my = ++myPostsSeq;
  setCopyText(host, () => t("내 글 가져오는 중…"));
  let list: any[];
  try {
    const r = await deps.invoke<unknown>("talk_my_posts", { limit: 30 });
    list = Array.isArray(r) ? r.filter((e) => e && typeof e === "object") : [];
  } catch (e) {
    if (my !== myPostsSeq) return;
    host.innerHTML = `<p class="meta danger">${copyHtml("내 글을 읽지 못했어요.")} ${esc(deps.errText(e))}</p>`;
    return;
  }
  if (my !== myPostsSeq) return;
  if (!list.length) { host.innerHTML = `<p class="meta">${copyHtml("아직 올린 글이 없어요.")}</p>`; return; }
  const items = [...list].sort((a, b) => (num(b.created_at) ?? 0) - (num(a.created_at) ?? 0));
  host.innerHTML =
    `<ul class="lm-posts">` +
    items.map((e) => {
      const ms = (num(e.created_at) ?? 0) * 1000;
      const when = ms ? new Date(ms).toLocaleString() : "";
      return `<li><time class="meta">${esc(when)}</time><p translate="no">${esc(String(e.content ?? ""))}</p></li>`;
    }).join("") +
    `</ul><div class="row"><button type="button" class="ghost" id="lm-posts-feed">${copyHtml("피드에서 보기")}</button></div>`;
  host.querySelector<HTMLButtonElement>("#lm-posts-feed")!.onclick = openFeed;
}
