/*
 * 「게임 올리기」 화면 — 장터 「바로 해 보는 게임」의 판매자 쪽. (2026-11-13, 대표 승인)
 *
 * 순서: ① 게임 폴더 고르기(이 컴퓨터 대화상자 — 러스트가 고른 폴더만 기억) → ② 검사(문서 한도·공유 사이트 게임 CSP·파일 4MB)
 *   → ③ 적기(가게·이름·장르·값·받는 주소·시작 파일) → ④ 확인 칸(소각 RVN·공개 IPFS·되돌릴 수 없음 — 「읽었어요」 표시해야 단추가 켜진다)
 *   → ⑤ 사람이 「올리기」를 누르면: 폴더 붙잡기 → 문서 서명(노드 signmessage = sign_message · attachArcadeSignature 로 다시 확인)
 *     → 문서 붙잡기(ipfs_add_file) → 자산 발행(issue_asset, 고유 RVLT/<가게>#<꼬리표>) 또는 재발행(reissue, RVLT/<가게>/<상품>, 수량 0 · 문서만 바꿈).
 *   → 다 되면 장터 목록(arcade-catalog 길)을 새로 읽는다.
 * 🔴 공개(IPFS)·소각(체인)은 ④ 를 지난 뒤에만. 그만두면 아무것도 나가지 않는다. 「보냈는지 모름」(SENT_UNKNOWN)이면 다시 올리는 단추를 살리지 않는다.
 * 🔴 판매자가 적은 글(제목·설명)은 번역하지 않는다(translate="no").
 *
 * 11-13 대표 승인 「누구나 0 RVN」: 첫 칸 = 「일반 판매자로 올리기」 — 체인 자산·소각 없음. 폴더·문서는 IPFS, 알림 쪽지(kind 31405)는 공개 릴레이
 *   (길 = arcade-open.ts runOpenUpload). RVLT/<가게> 주인 표가 있으면 그 아래로 올려 「확인 판매자」가 된다(아래 옛 길 그대로).
 *   내가 올린 일반 판매자 게임은 같은 화면에서 「고치기」(더 높은 판) · 「내리기」(내림 쪽지).
 */
import { t, tf, copyHtml, setCopyText } from "./i18n";
import { ARCADE_GENRES, ARCADE_GENRE_LABELS, arcadeDocHash, arcadeSigningMessage, attachArcadeSignature, encodeArcadeProduct, type ArcadeGenre } from "../core/creator/arcade-product";
import {
  PLACEHOLDER_CID, atomsOfRvnText, buildBody, checkFolder, entryCandidates, idFromTag, scanOf, sellerPlaces, suggestTag, targetName,
  type FolderScan, type Target,
} from "./arcade-upload-rules";
import type { ArcadeProduct } from "./arcade-model";
import { publishListing, runOpenUpload, type OpenStep } from "./arcade-open";

type Invoke = <T = any>(cmd: string, args?: Record<string, unknown>) => Promise<T>;
export interface UploadDeps { invoke: Invoke; ensureUnlocked: (why: string) => Promise<boolean>; errText: (e: unknown) => string }

const SELLER_KEY = "rv-arcade-seller";
function esc(s: unknown): string {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}
const isSentUnknown = (e: unknown) => /SENT_UNKNOWN/.test(String(e));
const fmtSize = (n: number) => n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;

export function paintUpload(host: HTMLElement, deps: UploadDeps, o: { existing: readonly ArcadeProduct[]; onBack: () => void; onPublished: () => void }) {
  let scan: FolderScan | null = null;
  let places = { shops: [] as string[], products: [] as string[] };
  let busy = false;

  host.innerHTML =
    `<div class="ar-head"><button type="button" class="ghost ar-back" data-up-back="1">${copyHtml("장터로")}</button><h3>${copyHtml("게임 올리기")}</h3></div>` +
    `<div class="ar-up">` +
    `<p class="meta">${copyHtml("게임 폴더(index.html 이 든 폴더)를 고르면, 장터 「바로 해 보는 게임」에 올릴 수 있는지 먼저 살펴봐요. 확인하기 전에는 아무것도 공개되지 않아요.")}</p>` +
    `<div class="row"><button type="button" data-up-pick="1">${copyHtml("게임 폴더 고르기")}</button></div>` +
    `<div data-up-mine="1"></div>` +
    `<div data-up-folder="1"></div><div data-up-form="1"></div><div data-up-step="1"></div>` +
    `</div>`;
  const $ = <T extends HTMLElement>(sel: string) => host.querySelector<T>(sel)!;
  $("[data-up-back]").onclick = () => { if (!busy) o.onBack(); };

  const savedSeller = () => { try { return localStorage.getItem(SELLER_KEY) || ""; } catch { return ""; } };
  /** 이 지갑이 올린 일반 판매자 게임(판매자 주소 = 이 화면이 기억한 판매 주소). */
  const myOpen = () => { const me = savedSeller(); return me ? o.existing.filter((p) => p.listing === "open" && p.doc.seller === me) : []; };
  paintMine();
  function paintMine() {
    const box = $("[data-up-mine]"), mine = myOpen();
    if (!mine.length) { box.innerHTML = ""; return; }
    box.innerHTML = `<div class="ar-up-mine"><h4>${copyHtml("내가 올린 일반 판매자 게임")}</h4><ul>` +
      mine.map((p) => `<li><span translate="no">${esc(p.title)}</span> <span class="meta">${esc(tf("{0}판", p.doc.version))}</span>` +
        `<button type="button" class="ghost" data-up-down="${esc(p.id)}">${copyHtml("내리기")}</button></li>`).join("") + `</ul><p class="meta" data-up-mine-say="1" role="status"></p></div>`;
    box.querySelectorAll<HTMLButtonElement>("[data-up-down]").forEach((b) => { b.onclick = () => askDown(b.dataset.upDown || ""); });
  }
  function askDown(key: string) {
    const p = myOpen().find((x) => x.id === key);
    const say = $("[data-up-mine-say]");
    if (!p || busy) return;
    say.innerHTML = `<span class="ar-warn">${esc(tf("「{0}」을 내릴까요? 공개 릴레이에 「내림」 쪽지를 올려요. 체인 거래는 없어요(0 RVN).", p.title))}</span> ` +
      `<button type="button" data-up-down-go="1">${copyHtml("내리기")}</button> <button type="button" class="ghost" data-up-down-stop="1">${copyHtml("그만두기")}</button>`;
    say.querySelector<HTMLElement>("[data-up-down-stop]")!.onclick = () => { say.textContent = ""; };
    say.querySelector<HTMLButtonElement>("[data-up-down-go]")!.onclick = async (e) => {
      (e.currentTarget as HTMLButtonElement).disabled = true; busy = true;
      try {
        if (!(await deps.ensureUnlocked(t("게임을 내리려면 지갑을 열어야 합니다.")))) { busy = false; say.textContent = ""; return; }
        setCopyText(say, () => t("내림 쪽지를 올리는 중…"));
        await publishListing(deps.invoke, { seller: p.doc.seller, id: p.doc.id, version: p.doc.version, docCid: p.docCid, docHash: arcadeDocHash(p.doc), state: "removed" });
        setCopyText(say, () => t("내렸어요. 몇 분 안에 장터에서 사라져요."));
        o.onPublished();
      } catch (err) { say.innerHTML = `<span class="danger">${esc(deps.errText(err))}</span>`; }
      busy = false;
    };
  }

  // 가게 목록은 미리 읽는다(주인 표 RVLT/<가게>!).
  void deps.invoke<unknown>("owner_tokens").then((r) => { places = sellerPlaces(r); if (scan) paintForm(); }).catch(() => { places = { shops: [], products: [] }; });

  $("[data-up-pick]").onclick = async () => {
    if (busy) return;
    const box = $("[data-up-folder]");
    setCopyText(box, () => t("폴더를 살펴보는 중…"));
    try {
      const r = await deps.invoke<unknown>("arcade_pick_folder");
      if (r == null) { box.textContent = ""; return; }
      scan = scanOf(r);
      if (!scan) throw new Error(t("폴더를 읽지 못했어요."));
      paintForm();
    } catch (e) { box.innerHTML = `<p class="danger">${esc(deps.errText(e))}</p>`; }
  };

  function listHtml(items: { say: string }[], cls: string) {
    return items.length ? `<ul class="ar-up-list ${cls}">${items.map((p) => `<li>${esc(t(p.say) === p.say ? p.say : t(p.say))}</li>`).join("")}</ul>` : "";
  }

  function paintForm() {
    if (!scan) return;
    const s = scan;
    const entries = entryCandidates(s.files);
    const total = s.files.reduce((n, f) => n + f.size, 0);
    $("[data-up-folder]").innerHTML =
      `<div class="ar-up-folder"><b translate="no">${esc(s.folder)}</b> · ${esc(tf("파일 {0}개 · {1}", s.files.length, fmtSize(total)))}</div>`;
    const tokens = places;
    const openOpts = `<option value="open:new">${esc(t("새 게임 · 일반 판매자 (0 RVN · 자산 없음)"))}</option>` +
      myOpen().map((p) => `<option value="open:update:${esc(p.id)}">${esc(tf("고치기 · {0} (일반 판매자 · 0 RVN)", p.title))}</option>`).join("");
    const shopOpts = openOpts + tokens.shops.map((x) => `<option value="new:${esc(x)}">${esc(tf("새 게임 · RVLT/{0}#… (고유 자산)", x))}</option>`).join("") +
      tokens.products.map((x) => `<option value="update:${esc(x)}">${esc(tf("고치기 · {0} (재발행)", x))}</option>`).join("");
    const saved = (() => { try { return localStorage.getItem(SELLER_KEY) || ""; } catch { return ""; } })();
    $("[data-up-form]").innerHTML =
      `<div class="ar-up-form">` +
      `<p class="ar-note">${copyHtml(tokens.shops.length || tokens.products.length
        ? "일반 판매자로 올리면 0 RVN 이에요. 내 RVLT 가게 아래로 올리면 「확인 판매자」 표시가 붙고 RVN 이 소각돼요."
        : "가게 자산이 없어도 일반 판매자로 0 RVN 에 올릴 수 있어요. 장터에는 「일반 판매자」로 보여요. RVLT/<가게> 자산이 있으면 「확인 판매자」 표시가 붙어요.")}</p>` +
      `<label>${copyHtml("어디에 올릴까요")}<select data-up-target="1">${shopOpts}</select></label>` +
      `<label data-up-tagrow="1">${copyHtml("꼬리표 (# 뒤 영문 이름)")}<input data-up-tag="1" maxlength="20" autocomplete="off" spellcheck="false" placeholder="STAR_RUN" /></label>` +
      `<label>${copyHtml("게임 이름")}<input data-up-title="1" maxlength="80" autocomplete="off" translate="no" /></label>` +
      `<label>${copyHtml("설명 (없어도 돼요)")}<textarea data-up-desc="1" rows="3" maxlength="2000" translate="no"></textarea></label>` +
      `<div class="ar-up-two">` +
      `<label>${copyHtml("장르")}<select data-up-genre="1">${ARCADE_GENRES.map((g) => `<option value="${g}"${g === "arcade" ? " selected" : ""}>${copyHtml(ARCADE_GENRE_LABELS[g])}</option>`).join("")}</select></label>` +
      `<label>${copyHtml("한 판 값 (RVN · 0 = 무료)")}<input data-up-price="1" inputmode="decimal" autocomplete="off" placeholder="0.5" /></label>` +
      `<label>${copyHtml("한 판 약 몇 분")}<input data-up-min="1" inputmode="numeric" value="3" /></label>` +
      `</div>` +
      `<label>${copyHtml("시작 파일")}<select data-up-entry="1">${entries.map((p) => `<option>${esc(p)}</option>`).join("")}</select></label>` +
      `<label>${copyHtml("판매 대금 받는 주소 (비우면 이 지갑의 새 주소)")}<input data-up-payto="1" maxlength="40" autocomplete="off" spellcheck="false" translate="no" value="${esc(saved)}" /></label>` +
      `<div data-up-check="1"></div>` +
      `<div class="row"><button type="button" data-up-review="1">${copyHtml("확인하기")}</button></div>` +
      `</div>`;
    const target = $<HTMLSelectElement>("[data-up-target]");
    const syncTag = () => { $("[data-up-tagrow]").hidden = !(target.value.startsWith("new:") || target.value === "open:new"); };
    target.onchange = syncTag; syncTag();
    const title = $<HTMLInputElement>("[data-up-title]"), tag = $<HTMLInputElement>("[data-up-tag]");
    title.oninput = () => { if (!tag.dataset.touched) tag.value = suggestTag(title.value); };
    tag.oninput = () => { tag.dataset.touched = "1"; };
    const recheck = () => {
      const c = checkFolder(s, $<HTMLSelectElement>("[data-up-entry]").value || null);
      $("[data-up-check]").innerHTML =
        (c.problems.length ? `<p class="danger"><b>${copyHtml("이대로는 올릴 수 없어요")}</b></p>${listHtml(c.problems, "bad")}` : `<p class="ok">${copyHtml("폴더 검사를 통과했어요.")}</p>`) +
        listHtml(c.warnings, "warn");
      return c.problems.length === 0;
    };
    $<HTMLSelectElement>("[data-up-entry]").onchange = recheck;
    recheck();
    $("[data-up-review]").onclick = () => void review(recheck);
  }

  /** 일반 판매자 길의 확인 칸 — 소각 없음 · 공개 IPFS · 공개 릴레이. 「읽었어요」 전에는 「올리기」가 잠긴다. */
  function reviewOpen(tv: string, say: (k: string) => void) {
    const step = $("[data-up-step]");
    if (!scan) return;
    const prior = tv.startsWith("open:update:") ? myOpen().find((p) => p.id === tv.slice(12)) : undefined;
    if (tv.startsWith("open:update:") && !prior) { say("고칠 게임을 찾지 못했어요."); return; }
    const tag = $<HTMLInputElement>("[data-up-tag]").value.trim();
    if (!prior && !/^[A-Za-z0-9_]{1,20}$/.test(tag)) { say("꼬리표는 영문·숫자·밑줄로 적어 주세요."); return; }
    const title = $<HTMLInputElement>("[data-up-title]").value.trim();
    if (!title) { say("게임 이름을 적어 주세요."); return; }
    const priceSats = atomsOfRvnText($<HTMLInputElement>("[data-up-price]").value || "0");
    if (priceSats === null) { say("값은 숫자로 적어 주세요(예: 0.5)."); return; }
    const minutes = Math.round(Number($<HTMLInputElement>("[data-up-min]").value));
    const genre = $<HTMLSelectElement>("[data-up-genre]").value as ArcadeGenre;
    const entry = $<HTMLSelectElement>("[data-up-entry]").value;
    const description = $<HTMLTextAreaElement>("[data-up-desc]").value;
    const id = prior ? prior.doc.id : idFromTag(tag);
    const version = prior ? prior.doc.version + 1 : 1;
    let seller = prior ? prior.doc.seller : "";
    let payTo = $<HTMLInputElement>("[data-up-payto]").value.trim();
    const probe = "R" + "1".repeat(33);
    try { buildBody({ id, version, title, description, priceSats, seller: seller || payTo || probe, payTo: payTo || seller || probe, entry, cid: PLACEHOLDER_CID, files: scan.files, minutes, genre, assetName: "" }); }
    catch (e) { if (!/arcade-address/.test(String(e))) { step.innerHTML = `<p class="danger">${esc(t("상품 문서 모양이 맞지 않아요."))} <span class="meta">${esc(String((e as Error)?.message ?? e))}</span></p>`; return; } }
    const priceText = priceSats === "0" ? t("무료") : `${(Number(priceSats) / 1e8).toString()} RVN`;
    step.innerHTML =
      `<div class="ar-confirm" role="group">` +
      `<h4>${copyHtml("올리기 전에 확인해 주세요")}</h4>` +
      `<div class="kv"><b>${copyHtml("올리는 곳")}</b><span>${copyHtml("일반 판매자")} · <code translate="no">${esc(id)}</code>${prior ? ` · ${esc(tf("{0}판", version))}` : ""}</span></div>` +
      `<div class="kv"><b>${copyHtml("게임 이름")}</b><span translate="no">${esc(title)}</span></div>` +
      `<div class="kv"><b>${copyHtml("한 판 값")}</b><span>${esc(priceText)}</span></div>` +
      `<div class="kv"><b>${copyHtml("소각")}</b><span><b>${copyHtml("없음 (0 RVN · 체인 거래 없음)")}</b></span></div>` +
      `<p class="meta">${copyHtml("장터에는 「일반 판매자」로 보여요. 사는 사람은 첫 결제 전에 「일반 판매자 게임이에요」 안내를 봐요. 신고가 쌓이면 레이븐볼트가 숨길 수 있어요.")}</p>` +
      `<p class="ar-warn">${copyHtml("「올리기」를 누르면 게임 폴더와 상품 문서가 공개 IPFS 에, 알림 쪽지가 공개 릴레이에 올라가요. 게임 파일은 이 컴퓨터가 지켜요 — 켜 두어야 사람들이 받을 수 있어요.")}</p>` +
      `<label class="ar-agree"><input type="checkbox" data-up-agree="1" /> <span>${copyHtml("게임과 그 안의 그림·소리는 내가 팔 권리가 있는 것입니다.")} <b>${copyHtml("읽었어요")}</b></span></label>` +
      `<div class="row"><button type="button" data-up-go="1" disabled>${copyHtml("올리기")}</button><button type="button" class="ghost" data-up-stop="1">${copyHtml("그만두기")}</button></div>` +
      `<p class="meta" data-up-say="1" role="status"></p></div>`;
    const go = $<HTMLButtonElement>("[data-up-go]"), stop = $<HTMLButtonElement>("[data-up-stop]"), sayEl = $("[data-up-say]");
    $<HTMLInputElement>("[data-up-agree]").onchange = (e) => { go.disabled = !(e.target as HTMLInputElement).checked; };
    stop.onclick = () => { step.innerHTML = ""; };
    const words: Record<OpenStep, string> = { pin: "게임 폴더를 이 컴퓨터 IPFS 에 올리는 중…", sign: "상품 문서에 서명하는 중…", doc: "상품 문서를 IPFS 에 올리는 중…", listing: "알림 쪽지를 공개 릴레이에 올리는 중…", done: "" };
    go.onclick = async () => {
      if (busy || !scan) return;
      busy = true; go.disabled = true; stop.disabled = true;
      if (!(await deps.ensureUnlocked(t("게임을 올리려면 지갑을 열어야 합니다.")))) { busy = false; go.disabled = false; stop.disabled = false; return; }
      try {
        if (!seller) {
          seller = savedSeller();
          if (!seller) { seller = String(await deps.invoke<string>("new_address", { label: "arcade" })); try { localStorage.setItem(SELLER_KEY, seller); } catch { /* 없어도 된다 */ } }
        }
        if (!payTo) payTo = seller;
        const r = await runOpenUpload(deps.invoke, { files: scan.files, id, version, title, description, priceSats, seller, payTo, entry, minutes, genre },
          (st) => { if (words[st]) setCopyText(sayEl, () => t(words[st])); });
        try { localStorage.setItem(SELLER_KEY, seller); } catch { /* 없어도 된다 */ }
        step.innerHTML = `<p class="ok">${copyHtml("올렸어요. 몇 분 안에 장터 「바로 해 보는 게임」에 「일반 판매자」로 보여요.")}</p>` +
          `<p class="meta ar-txid">${copyHtml("상품 문서")} <code translate="no">${esc(r.docCid)}</code></p>`;
        busy = false;
        o.onPublished();
      } catch (e) { busy = false; go.disabled = false; stop.disabled = false; sayEl.innerHTML = `<span class="danger">${esc(deps.errText(e))}</span>`; }
    };
  }

  async function review(folderOk: () => boolean) {
    const step = $("[data-up-step]");
    const say = (k: string) => { step.innerHTML = `<p class="danger">${esc(t(k))}</p>`; };
    if (!scan || !folderOk()) { say("폴더 검사를 먼저 통과해야 해요."); return; }
    const tv = $<HTMLSelectElement>("[data-up-target]").value;
    if (!tv) { say("올릴 가게가 없어요."); return; }
    if (tv.startsWith("open:")) { reviewOpen(tv, say); return; }
    const target: Target = tv.startsWith("new:") ? { mode: "new", shop: tv.slice(4), tag: $<HTMLInputElement>("[data-up-tag]").value.trim() } : { mode: "update", asset: tv.slice(7) };
    const tn = targetName(target);
    if (tn.problems.length) { step.innerHTML = `<p class="danger">${esc(tn.problems.map((p) => t(p)).join(" · "))}</p>`; return; }
    const title = $<HTMLInputElement>("[data-up-title]").value.trim();
    if (!title) { say("게임 이름을 적어 주세요."); return; }
    const priceSats = atomsOfRvnText($<HTMLInputElement>("[data-up-price]").value || "0");
    if (priceSats === null) { say("값은 숫자로 적어 주세요(예: 0.5)."); return; }
    const minutes = Math.round(Number($<HTMLInputElement>("[data-up-min]").value));
    const genre = $<HTMLSelectElement>("[data-up-genre]").value as ArcadeGenre;
    const entry = $<HTMLSelectElement>("[data-up-entry]").value;
    const description = $<HTMLTextAreaElement>("[data-up-desc]").value;
    // 고치기: 체인에 있는 지금 판의 id·판매자 주소를 그대로 잇는다(같은 판매자·같은 id 의 더 높은 판).
    const prior = target.mode === "update" ? o.existing.find((p) => p.assetName === tn.name) : undefined;
    const id = prior ? prior.doc.id : idFromTag(target.mode === "new" ? target.tag : tn.name.split("/").pop()!);
    const version = prior ? prior.doc.version + 1 : 1;
    let seller = prior ? prior.doc.seller : "";
    let payTo = $<HTMLInputElement>("[data-up-payto]").value.trim();
    // 모양 먼저 확인(자리 주소·자리 CID) — 공개·서명 전에 문서가 맞는지.
    const probe = "R" + "1".repeat(33);
    try {
      buildBody({ id, version, title, description, priceSats, seller: seller || payTo || probe, payTo: payTo || seller || probe, entry, cid: PLACEHOLDER_CID, files: scan.files, minutes, genre, assetName: tn.name });
    } catch (e) {
      if (!/arcade-address/.test(String(e))) { step.innerHTML = `<p class="danger">${esc(t("상품 문서 모양이 맞지 않아요."))} <span class="meta">${esc(String((e as Error)?.message ?? e))}</span></p>`; return; }
    }
    const priceText = priceSats === "0" ? t("무료") : `${(Number(priceSats) / 1e8).toString()} RVN`;
    step.innerHTML =
      `<div class="ar-confirm" role="group">` +
      `<h4>${copyHtml("올리기 전에 확인해 주세요")}</h4>` +
      `<div class="kv"><b>${copyHtml("자산")}</b><span><code translate="no">${esc(tn.name)}</code></span></div>` +
      `<div class="kv"><b>${copyHtml("게임 이름")}</b><span translate="no">${esc(title)}</span></div>` +
      `<div class="kv"><b>${copyHtml("한 판 값")}</b><span>${esc(priceText)}</span></div>` +
      `<div class="kv"><b>${copyHtml("소각")}</b><span><b>${esc(tf("{0} RVN", tn.burnRvn))}</b> + ${copyHtml("공개 장부 수수료(노드가 정함, 조금)")}</span></div>` +
      `<p class="meta">${copyHtml(target.mode === "new" ? "고유 자산은 이름을 바꾸거나 나중에 다시 가리키게 할 수 없어요. 값을 바꾸려면 새 꼬리표로 다시 올려요." : "재발행은 수량을 늘리지 않고 붙은 상품 문서만 새 판으로 바꿔요.")}</p>` +
      `<p class="ar-warn">${copyHtml("「올리기」를 누르면 게임 폴더와 상품 문서가 공개 IPFS 에 올라가고, 위 RVN 이 소각돼요. 되돌릴 수 없어요.")}</p>` +
      `<label class="ar-agree"><input type="checkbox" data-up-agree="1" /> <span>${copyHtml("게임과 그 안의 그림·소리는 내가 팔 권리가 있는 것입니다.")} <b>${copyHtml("읽었어요")}</b></span></label>` +
      `<div class="row"><button type="button" data-up-go="1" disabled>${copyHtml("올리기")}</button><button type="button" class="ghost" data-up-stop="1">${copyHtml("그만두기")}</button></div>` +
      `<p class="meta" data-up-say="1" role="status"></p></div>`;
    const go = $<HTMLButtonElement>("[data-up-go]"), stop = $<HTMLButtonElement>("[data-up-stop]"), sayEl = $("[data-up-say]");
    $<HTMLInputElement>("[data-up-agree]").onchange = (e) => { go.disabled = !(e.target as HTMLInputElement).checked; };
    stop.onclick = () => { step.innerHTML = ""; };
    go.onclick = async () => {
      if (busy || !scan) return;
      busy = true; go.disabled = true; stop.disabled = true;
      const fail = (e: unknown) => { busy = false; go.disabled = false; stop.disabled = false; sayEl.innerHTML = `<span class="danger">${esc(deps.errText(e))}</span>`; };
      if (!(await deps.ensureUnlocked(t("게임을 올리려면 지갑을 열어야 합니다.")))) { busy = false; go.disabled = false; stop.disabled = false; return; }
      try {
        if (!seller) {
          seller = (() => { try { return localStorage.getItem(SELLER_KEY) || ""; } catch { return ""; } })();
          if (!seller) { seller = String(await deps.invoke<string>("new_address", { label: "arcade" })); try { localStorage.setItem(SELLER_KEY, seller); } catch { /* 없어도 된다 */ } }
        }
        if (!payTo) payTo = seller;
        setCopyText(sayEl, () => t("게임 폴더를 이 컴퓨터 IPFS 에 올리는 중…"));
        const pinned = await deps.invoke<any>("arcade_pin_folder", { expect: scan.files });
        const body = buildBody({ id, version, title, description, priceSats, seller, payTo, entry, cid: String(pinned?.cid ?? ""), files: scan.files, minutes, genre, assetName: tn.name });
        setCopyText(sayEl, () => t("상품 문서에 서명하는 중…"));
        const signed = await deps.invoke<any>("sign_message", { address: seller, message: arcadeSigningMessage(body), passphrase: null });
        const v = attachArcadeSignature(body, String(signed?.signature ?? "")); // 서명이 seller 로 되살아나야 통과
        setCopyText(sayEl, () => t("상품 문서를 IPFS 에 올리는 중…"));
        const docAdded = await deps.invoke<any>("ipfs_add_file", { file: { name: "product.json", bytes: Array.from(encodeArcadeProduct(v.doc)) } });
        const docCid = String(docAdded?.cid ?? "");
        if (!/^Qm[1-9A-HJ-NP-Za-km-z]{44}$/.test(docCid)) throw new Error(t("IPFS 가 문서 주소를 돌려주지 않았어요."));
        setCopyText(sayEl, () => t("공개 장부에 올리는 중…"));
        const r = target.mode === "new"
          ? await deps.invoke<any>("issue_asset", { name: tn.name, qty: 1, units: 0, reissuable: false, ipfsHash: docCid, toAddress: null })
          : await deps.invoke<any>("reissue", { asset: tn.name, qty: 0, toAddress: null, keepReissuable: true, newIpfs: docCid, passphrase: null });
        const txid = String(r?.txid ?? (typeof r === "string" ? r : ""));
        try { localStorage.setItem(SELLER_KEY, seller); } catch { /* 없어도 된다 */ }
        step.innerHTML = `<p class="ok">${copyHtml("올렸어요. 공개 장부에 기록되면(몇 분) 장터 「바로 해 보는 게임」에 보여요.")}</p>` +
          `<p class="meta ar-txid">${copyHtml("거래 번호")} <code translate="no">${esc(txid)}</code></p>` +
          `<p class="meta ar-txid">${copyHtml("상품 문서")} <code translate="no">${esc(docCid)}</code></p>`;
        busy = false;
        o.onPublished();
      } catch (e) {
        if (isSentUnknown(e)) { busy = false; step.innerHTML = `<p class="danger">${copyHtml("보냈는지 확인하지 못했어요. 다시 올리지 말고, 자산 화면에서 기록됐는지 먼저 확인해 주세요.")}</p>`; return; }
        fail(e);
      }
    };
  }
}
