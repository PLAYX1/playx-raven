/*
 * 장터 첫 화면 「바로 해 보는 게임」 줄 · 전체 목록(더 보기) · 게임 페이지 · 앱 창 안에서 하기 · 한 판 결제. (2026-11-12)
 *
 * 폰·웹 장터(phone/screens/ArcadeMarket.tsx · GamePage.tsx · GameHost.web.tsx)와 같은 규칙:
 *   · 카드에서 가장 큰 글은 값(사는 사람이 먼저 보는 것). 판매자 확인 여부는 색만이 아니라 글(「확인 판매자」·「판매자 미확인」)로도 말한다.
 *   · 장르 칩 = 「전체」 + 게임이 실제로 있는 장르만(둘 이상일 때만 줄을 그린다).
 *   · 게임은 앱 창 안 iframe — sandbox="allow-scripts" 만(같은 출처 권한·팝업·폼·최상위 이동 없음), referrerpolicy no-referrer, allow 비움.
 *     지갑은 iframe 의 메시지를 듣지 않는다 — 게임에는 결제 통로가 없다. 주소는 arcade-model gameUrl(확인된 게임 길 하나)뿐.
 *   · 🔴 결제: 앱이 **준비**하고(문서 다시 확인 → 나누기 → 확인 칸), 사람이 「읽었어요」에 표시하고 「정말 내기」를 눌러야 보낸다. 자동으로 보내는 길은 없다.
 *     보낸 뒤 「보냈는지 모름」(SENT_UNKNOWN)이면 다시 내는 단추를 살리지 않는다(장터 사기 화면과 같은 규칙).
 *   · 🔴 예시(가짜) 게임을 그리지 않는다. 올라온 게임이 없으면 「아직 올라온 게임이 없어요」.
 *   · 판매자가 적은 글(제목·설명·가게 이름)은 번역하지 않는다(translate="no").
 */
import "./arcade-market.css";
import { t, tf, copyHtml, setCopyText } from "./i18n";
import { fmtRvn } from "./amount-ui";
import type { ArcadeGenre } from "../core/creator/arcade-product";
import {
  ArcadeDocError, atomsToRvn, filterByGenre, filterProducts, gameUrl, genreLabel, genresPresent, playsWithoutPay, prepareArcadePay,
  productsFromSources, sortProducts, type ArcadeProduct,
} from "./arcade-model";

type Invoke = <T = any>(cmd: string, args?: Record<string, unknown>) => Promise<T>;
export interface ArcadeDeps {
  invoke: Invoke;
  ensureUnlocked: (why: string) => Promise<boolean>;
  errText: (e: unknown) => string;
}

/** 첫 화면 줄에 보이는 카드 수(그 너머는 「더 보기」). */
export const ROW_MAX = 6;
const FRESH_MS = 120_000;

function esc(s: unknown): string {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}
const isSentUnknown = (e: unknown) => /SENT_UNKNOWN/.test(String(e));
const ICON_PAD = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2.5" y="7" width="19" height="11" rx="5"/><path d="M7.5 10.5v4M5.5 12.5h4"/><circle cx="15.5" cy="11.5" r="1"/><circle cx="18" cy="14" r="1"/></svg>`;
const ICON_CHECK = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>`;
const ICON_WARN = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 4l9 16H3z"/><path d="M12 10v4M12 17h.01"/></svg>`;
/** 그림이 없을 때 표지 색 번호(0~4) — 같은 게임은 늘 같은 색. */
export function toneOf(id: string): number { let h = 0; for (const c of id) h = (h * 31 + c.charCodeAt(0)) >>> 0; return h % 5; }

/** 카드·페이지의 값 글자. 무료 = 「무료」, 아니면 「1 RVN」. */
export function priceText(p: Pick<ArcadeProduct, "priceSats">): string {
  return p.priceSats === 0 ? t("무료") : fmtRvn(atomsToRvn(p.priceSats));
}
const sellerLine = (p: ArcadeProduct) => p.verified
  ? `<span class="ar-ok">${ICON_CHECK}<span>${copyHtml("확인 판매자")}</span></span>`
  : `<span class="ar-unv">${ICON_WARN}<span>${copyHtml("판매자 미확인")}</span></span>`;
const cardLabel = (p: ArcadeProduct) => [p.title, priceText(p), t(p.verified ? "확인 판매자" : "판매자 미확인"), tf("{0} · 한 판", p.sellerName)].join(" · ");

export function cardHtml(p: ArcadeProduct): string {
  return `<li><button type="button" class="ar-card" data-ar-open="${esc(p.id)}" aria-label="${esc(cardLabel(p))}">` +
    `<span class="ar-cover ar-tone${toneOf(p.id)}">${ICON_PAD}</span>` +
    `<span class="ar-cbody">` +
    `<span class="ar-price">${esc(priceText(p))}</span>` +
    `<span class="ar-title" translate="no">${esc(p.title)}</span>` +
    `<span class="ar-shop"><span translate="no">${esc(p.sellerName)}</span> · ${copyHtml(genreLabel(p.genre))}</span>` +
    `<span class="ar-who">${sellerLine(p)}</span>` +
    `</span></button></li>`;
}

export function mountArcade(page: HTMLElement, host: HTMLElement, deps: ArcadeDeps) {
  let view: "row" | "all" | "game" = "row";
  let items: ArcadeProduct[] | null = null;
  let loadedAt = 0;
  let failed = "";
  let genre: ArcadeGenre | "all" = "all";
  let query = "";
  let current: ArcadeProduct | null = null;
  let seq = 0;

  const focus = (on: boolean) => page.classList.toggle("ar-focus", on);

  async function load(force = false) {
    if (!force && items && Date.now() - loadedAt < FRESH_MS) return;
    const my = ++seq;
    failed = "";
    try {
      const r = await deps.invoke<unknown>("arcade_catalog_sources");
      if (my !== seq) return;
      items = sortProducts(productsFromSources(r).items);
      loadedAt = Date.now();
    } catch (e) {
      if (my !== seq) return;
      failed = deps.errText(e);
      items = null;
    }
  }

  const chipsHtml = (list: readonly ArcadeProduct[]) => {
    const gs = genresPresent(list);
    if (gs.length < 2) return "";
    const g = genre !== "all" && gs.includes(genre) ? genre : "all";
    return `<div class="ar-chips" role="group" aria-label="${esc(t("장르"))}">` +
      (["all", ...gs] as const).map((x) => `<button type="button" data-ar-genre="${x}" aria-pressed="${x === g}">${copyHtml(x === "all" ? "전체" : genreLabel(x))}</button>`).join("") +
      `</div>`;
  };
  const emptyHtml = () =>
    `<div class="ar-empty" role="status"><p class="ar-empty-title">${copyHtml("아직 올라온 게임이 없어요")}</p>` +
    `<p class="meta">${copyHtml("판매자가 게임을 공개 장부(RVLT)에 올리고 서명한 상품 문서를 붙이면 여기에 보여요. 예시 게임은 보여 드리지 않아요.")}</p></div>`;
  const failHtml = () =>
    `<div class="ar-empty" role="status"><p class="ar-empty-title">${copyHtml("게임 목록을 읽지 못했어요")}</p>` +
    `<p class="meta">${esc(failed)}</p><div class="row"><button type="button" class="ghost" data-ar-reload="1">${copyHtml("다시 읽기")}</button></div></div>`;

  function wire() {
    host.querySelectorAll<HTMLElement>("[data-ar-genre]").forEach((b) => { b.onclick = () => { genre = (b.dataset.arGenre || "all") as ArcadeGenre | "all"; paint(); }; });
    host.querySelectorAll<HTMLElement>("[data-ar-open]").forEach((b) => {
      b.onclick = () => { const p = items?.find((x) => x.id === b.dataset.arOpen); if (p) { current = p; view = "game"; paint(); host.scrollIntoView({ block: "start" }); } };
    });
    host.querySelectorAll<HTMLElement>("[data-ar-reload]").forEach((b) => { b.onclick = () => { setCopyText(b, () => t("가져오는 중…")); void load(true).then(paint); }; });
    host.querySelector<HTMLElement>("[data-ar-more]")?.addEventListener("click", () => { view = "all"; paint(); host.scrollIntoView({ block: "start" }); });
    host.querySelector<HTMLElement>("[data-ar-back]")?.addEventListener("click", () => { view = view === "game" && cameFromAll ? "all" : "row"; current = null; paint(); });
    const search = host.querySelector<HTMLInputElement>("[data-ar-search]");
    if (search) search.oninput = () => { query = search.value; paintAllList(); };
  }
  let cameFromAll = false;

  function paintRow() {
    focus(false);
    cameFromAll = false;
    const head = (more: boolean) => `<div class="ar-head"><h3>${copyHtml("바로 해 보는 게임")}</h3>` +
      (more ? `<button type="button" class="ghost ar-more" data-ar-more="1">${copyHtml("더 보기")}</button>` : "") + `</div>`;
    if (items === null && !failed) { host.innerHTML = head(false) + `<p class="meta" role="status">${copyHtml("게임 가져오는 중…")}</p>`; return; }
    if (failed) { host.innerHTML = head(false) + failHtml(); wire(); return; }
    const list = items ?? [];
    if (!list.length) { host.innerHTML = head(false) + emptyHtml(); return; }
    const shown = filterByGenre(list, genresPresent(list).includes(genre as ArcadeGenre) ? genre : "all");
    host.innerHTML = head(true) + chipsHtml(list) +
      `<ul class="ar-row">${shown.slice(0, ROW_MAX).map(cardHtml).join("")}</ul>` +
      (shown.length > ROW_MAX ? `<p class="meta">${esc(tf("{0}개 더 있어요", shown.length - ROW_MAX))}</p>` : "");
    wire();
  }

  function paintAllList() {
    const box = host.querySelector<HTMLElement>("[data-ar-all]");
    if (!box) return;
    const list = items ?? [];
    const g = genresPresent(list).includes(genre as ArcadeGenre) ? genre : "all";
    const shown = filterProducts(filterByGenre(list, g), query);
    const ok = shown.filter((p) => p.verified), fresh = shown.filter((p) => !p.verified);
    box.innerHTML = !list.length ? emptyHtml()
      : !shown.length ? `<p class="meta" role="status">${copyHtml("찾는 게임이 없어요.")}</p>`
      : (ok.length ? `<h4>${copyHtml("레이븐볼트 확인 판매자")}</h4><ul class="ar-grid">${ok.map(cardHtml).join("")}</ul>` : "") +
        (fresh.length ? `<h4>${copyHtml("새로 올라온 게임")}</h4><ul class="ar-grid">${fresh.map(cardHtml).join("")}</ul>` : "");
    box.querySelectorAll<HTMLElement>("[data-ar-open]").forEach((b) => {
      b.onclick = () => { const p = items?.find((x) => x.id === b.dataset.arOpen); if (p) { current = p; cameFromAll = true; view = "game"; paint(); host.scrollIntoView({ block: "start" }); } };
    });
  }

  function paintAll() {
    focus(true);
    const list = items ?? [];
    host.innerHTML =
      `<div class="ar-head"><button type="button" class="ghost ar-back" data-ar-back="1">${copyHtml("장터로")}</button><h3>${copyHtml("바로 해 보는 게임")}</h3></div>` +
      (failed ? failHtml() :
        `<input type="search" class="ar-search" data-ar-search="1" maxlength="60" autocomplete="off" spellcheck="false" value="${esc(query)}" placeholder="${esc(t("게임·가게 이름 찾기"))}" aria-label="${esc(t("게임·가게 이름 찾기"))}" />` +
        chipsHtml(list) + `<div data-ar-all="1"></div>`);
    wire();
    paintAllList();
  }

  function paintGame() {
    const p = current;
    if (!p) { view = "row"; paint(); return; }
    focus(true);
    const free = playsWithoutPay(p);
    const url = gameUrl(p);
    const action = !url
      ? `<p class="ar-note">${copyHtml("이 게임은 아직 열 수 없어요(잠긴 게임이거나 게임 주소를 확인하지 못했어요). 돈을 내는 단추도 두지 않아요.")}</p>`
      : free ? `<div class="row ar-acts"><button type="button" data-ar-play="1">${copyHtml("바로 하기")}</button></div>`
      : `<div class="row ar-acts"><button type="button" data-ar-buy="1">${esc(tf("한 판 하기 · {0}", priceText(p)))}</button></div>`;
    host.innerHTML =
      `<div class="ar-head"><button type="button" class="ghost ar-back" data-ar-back="1">${copyHtml(cameFromAll ? "목록으로" : "장터로")}</button></div>` +
      `<article class="ar-page">` +
      `<div class="ar-hero ar-tone${toneOf(p.id)}">${ICON_PAD}</div>` +
      `<div class="ar-info">` +
      `<div class="ar-big">${esc(priceText(p))}${free ? "" : ` <span class="ar-per">${copyHtml("한 판")}</span>`}</div>` +
      `<h3 translate="no">${esc(p.title)}</h3>` +
      `<p class="ar-who">${sellerLine(p)}</p>` +
      `<p class="meta"><span translate="no">${esc(p.sellerName)}</span>${p.assetName ? ` · <code translate="no">${esc(p.assetName)}</code>` : ""}</p>` +
      `<p class="meta">${esc(tf("{0} · 혼자 하기 · 약 {1}분", t(genreLabel(p.genre)), p.minutes))}</p>` +
      (p.description ? `<p class="ar-desc" translate="no">${esc(p.description)}</p>` : "") +
      (!p.verified ? `<p class="ar-note">${copyHtml("레이븐볼트가 이 판매자를 확인하지 않았어요. 서명은 맞지만, 체인의 가게 자산이 이 게임을 가리키지 않아요.")}</p>` : "") +
      `<p class="meta">${copyHtml("한 판마다 내는 게임이에요. 지난 결제로 다음 판이 열리지 않아요.")}</p>` +
      action +
      `<div data-ar-step="1"></div>` +
      `</div></article>` +
      `<div class="ar-stage" data-ar-stage="1" hidden></div>`;
    wire();
    host.querySelector<HTMLElement>("[data-ar-play]")?.addEventListener("click", () => openGame(p));
    host.querySelector<HTMLElement>("[data-ar-buy]")?.addEventListener("click", (e) => void prepare(p, e.currentTarget as HTMLButtonElement));
  }

  /** 앱 창 안에서 연다. 결제가 받아들여진 뒤(또는 무료)만 불린다. */
  function openGame(p: ArcadeProduct) {
    const stage = host.querySelector<HTMLElement>("[data-ar-stage]");
    const url = gameUrl(p);
    if (!stage || !url) return;
    stage.hidden = false;
    stage.innerHTML = `<div class="ar-stage-bar"><b translate="no">${esc(p.title)}</b><button type="button" class="ghost" data-ar-close="1">${copyHtml("게임 닫기")}</button></div>`;
    const frame = document.createElement("iframe");
    frame.title = p.title;
    frame.setAttribute("sandbox", "allow-scripts");
    frame.setAttribute("referrerpolicy", "no-referrer");
    frame.setAttribute("allow", "");
    frame.className = "ar-frame";
    frame.src = url;
    stage.appendChild(frame);
    stage.querySelector<HTMLElement>("[data-ar-close]")!.onclick = () => { stage.innerHTML = ""; stage.hidden = true; };
    stage.scrollIntoView({ block: "start" });
  }

  /** 결제 준비 → 확인 칸. 여기서는 아무것도 보내지 않는다. */
  async function prepare(p: ArcadeProduct, btn: HTMLButtonElement) {
    const step = host.querySelector<HTMLElement>("[data-ar-step]")!;
    let plan;
    try { plan = prepareArcadePay(p); } catch (e) {
      step.innerHTML = `<p class="danger">${copyHtml("상품 문서를 다시 확인하지 못해 결제를 준비하지 않았어요.")} <span class="meta">${esc(e instanceof ArcadeDocError ? e.code : "")}</span></p>`;
      return;
    }
    btn.disabled = true;
    setCopyText(step, () => t("게임 파일을 받을 수 있는지 확인하는 중…"));
    let reachable = false;
    try { reachable = await deps.invoke<boolean>("arcade_entry_reachable", { docCid: plan.docCid, entry: p.entry }) === true; } catch { reachable = false; }
    if (!reachable) {
      btn.disabled = false;
      step.innerHTML = `<p class="danger">${copyHtml("지금은 게임 파일을 받을 수 없어 결제를 준비하지 않았어요. 돈을 내고 못 하는 일이 없게 막았어요. 나중에 다시 눌러 주세요.")}</p>`;
      return;
    }
    const row = (label: string, v: string, strong = false) => `<div class="kv"><b>${copyHtml(label)}</b><span>${strong ? `<b>${v}</b>` : v}</span></div>`;
    step.innerHTML =
      `<div class="ar-confirm" role="group">` +
      `<h4>${copyHtml("내기 전에 확인해 주세요")}</h4>` +
      row("게임값", esc(fmtRvn(atomsToRvn(plan.priceAtoms))), true) +
      row("판매자에게 (99%)", esc(fmtRvn(atomsToRvn(plan.sellerAtoms)))) +
      row("레이븐볼트 수수료 (1%)", esc(fmtRvn(atomsToRvn(plan.feeAtoms)))) +
      row("받는 주소", `<code translate="no" class="ar-addr">${esc(plan.payTo)}</code>`) +
      `<p class="meta">${copyHtml("공개 장부 수수료는 노드가 정해 따로 조금 붙어요. 판매자 몫과 수수료는 한 거래 안에서 각자에게 바로 가요 — 레이븐볼트가 맡아 두지 않아요.")}</p>` +
      `<p class="ar-warn">${copyHtml("아직 돈은 나가지 않았어요. 「정말 내기」를 눌러야 보내요. 보낸 뒤에는 되돌릴 수 없어요.")}</p>` +
      `<label class="ar-agree"><input type="checkbox" data-ar-agree="1" /> <span>${copyHtml("레이븐볼트는 거래 당사자가 아닙니다. 게임에 대한 책임은 판매자에게 있습니다. 보낸 RVN은 돌려받을 수 없습니다.")} <b>${copyHtml("읽었어요")}</b></span></label>` +
      `<div class="row"><button type="button" data-ar-go="1" disabled>${copyHtml("정말 내기")}</button>` +
      `<button type="button" class="ghost" data-ar-stop="1">${copyHtml("그만두기")}</button></div>` +
      `<p class="meta" data-ar-say="1" role="status"></p></div>`;
    const go = step.querySelector<HTMLButtonElement>("[data-ar-go]")!;
    const stop = step.querySelector<HTMLButtonElement>("[data-ar-stop]")!;
    const say = step.querySelector<HTMLElement>("[data-ar-say]")!;
    const agree = step.querySelector<HTMLInputElement>("[data-ar-agree]")!;
    agree.onchange = () => { go.disabled = !agree.checked; };
    stop.onclick = () => { step.innerHTML = ""; btn.disabled = false; };
    const requestId = crypto.randomUUID();
    go.onclick = async () => {
      if (!agree.checked) return;
      go.disabled = true; stop.disabled = true;
      if (!(await deps.ensureUnlocked(t("게임값을 보내려면 지갑을 열어야 합니다.")))) { go.disabled = false; stop.disabled = false; return; }
      setCopyText(say, () => t("보내는 중…"));
      try {
        const r = await deps.invoke<any>("arcade_pay", {
          requestId, docCid: plan.docCid, payTo: plan.payTo, priceAtoms: plan.priceAtoms, sellerAtoms: plan.sellerAtoms, feeAtoms: plan.feeAtoms, passphrase: null,
        });
        const txid = String(r?.txid ?? "");
        if (!/^[0-9a-f]{64}$/i.test(txid)) {
          step.innerHTML = `<p class="danger">${copyHtml("보냈는지 확인하지 못했어요. 다시 내지 말고, 지갑의 거래 내역에서 먼저 확인해 주세요.")}</p>`;
          return;
        }
        void deps.invoke("arcade_ack", { requestId }).catch(() => {});
        step.innerHTML = `<p class="ok">${copyHtml("보냈어요. 게임을 열어요.")}</p><p class="meta ar-txid">${copyHtml("거래 번호")} <code translate="no">${esc(txid)}</code></p>`;
        openGame(p);
      } catch (e) {
        if (isSentUnknown(e)) {
          step.innerHTML = `<p class="danger">${copyHtml("보냈는지 확인하지 못했어요. 다시 내지 말고, 지갑의 거래 내역에서 먼저 확인해 주세요.")}</p>`;
          return;
        }
        go.disabled = false; stop.disabled = false;
        say.innerHTML = `<span class="danger">${esc(deps.errText(e))}</span>`;
      }
    };
  }

  function paint() {
    if (view === "game") paintGame();
    else if (view === "all") paintAll();
    else paintRow();
  }

  return {
    /** 장터 화면에 들어올 때. 늘 첫 화면(줄)부터. */
    enter() { view = "row"; current = null; paint(); void load().then(() => { if (view === "row") paint(); }); },
    /** 「새로 읽기」 — 목록을 처음부터. */
    refresh() { void load(true).then(paint); },
  };
}
