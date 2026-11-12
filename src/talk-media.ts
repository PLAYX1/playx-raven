/* 11-13 이야기 — 글 속 웹 주소 · 링크 미리보기 · 방 사진 · 내 사진 이름표 (폰 phone/ui/TalkLinks.tsx · core/talk/url-links.ts 와 같은 규칙).
 *
 * 링크(지갑 대화 = 피싱 표적):
 *  · 누르면 **컴퓨터 기본 브라우저**로 연다(@tauri-apps/plugin-opener). 앱 화면(웹뷰) 안에서는 절대 열지 않는다.
 *  · 위험해 보이는 주소(chat-links.ts linkRisk)는 열기 전에 「이 링크 조심하세요」 시트 — 진짜 도메인을 크게.
 *    평범한 주소는 바로 연다. 오른쪽 클릭 = 전체 주소 + 「주소 복사」 시트.
 *  · 보이는 글자는 짧은 모양(shortUrl), 긴 주소는 overflow-wrap:anywhere.
 * 미리보기: 글의 첫 주소 하나만, 그 글이 그려질 때. **러스트(talk_unfurl)가 우리 사이트에만 묻는다** — 그림도 data: 로 받아 온다.
 *  설정 「링크 미리보기」(기본 켬, 이 컴퓨터에만). 우리 사이트 주소(상품·방 초대)는 붙이지 않는다.
 * 사진: 이름표 그림 = 라비 이모티콘 16종 또는 내 사진(Blossom 지문 주소), 방 사진 = Blossom 지문 주소만. 그 밖의 주소는 그리지 않는다.
 *  신고한 사진은 이 컴퓨터에서 숨긴다. 못 읽은 사진은 지운다 → 밑의 첫 글자 동그라미가 보인다.
 * 🔴 남이 쓴 글·주소는 전부 escape(HTML 문자열) 또는 textContent 로만 넣는다.
 */
import "./talk-media.css";
import { DICT } from "./dict";
import { copyHtml, t } from "./i18n";
import { TALK_MEDIA_COPY } from "./talk-media-copy";
import { RISK_TEXT, firstUrl, linkRisk, shortUrl, urlSegments, type LinkRisk } from "./chat-links";

for (const [source, values] of Object.entries(TALK_MEDIA_COPY)) {
  (["en", "ja", "zh"] as const).forEach((language, index) => { DICT[language][source] ??= values[index]; });
}

type Invoke = <T = any>(cmd: string, args?: Record<string, unknown>) => Promise<T>;
export type MediaDeps = { invoke: Invoke; openUrl: (url: string) => Promise<void> | void };
let deps: MediaDeps | null = null;

const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const OWN_HOSTS = new Set(["ravenvault.ex.erci.se"]);

// ── 사진 주소 규칙 ─────────────────────────────────────────────
export const BLOSSOM = /^https:\/\/(?:(?:blossom|image|i|media)\.nostr\.build|npub1[02-9ac-hj-np-z]{58}\.blossom\.band)\/[a-f0-9]{64}(?:\.(?:jpg|jpeg|png|webp|gif))?$/;
const STICKER_CODES = ["ravi_hello", "ravi_thanks", "ravi_like", "ravi_love", "ravi_congrats", "ravi_laugh", "ravi_sad", "ravi_angry", "ravi_surprised", "ravi_curious", "ravi_cheer", "ravi_sorry", "ravi_goodnight", "ravi_gift", "ravi_waiting", "ravi_ok"] as const;
export const STICKERS: readonly string[] = STICKER_CODES;
const EMOJI_BASE = "https://ravenvault.ex.erci.se/emoji/";
export const stickerUrl = (code: string) => `${EMOJI_BASE}${code}.webp`;
export function stickerCodeOf(url: unknown): string {
  if (typeof url !== "string" || !url.startsWith(EMOJI_BASE)) return "";
  const m = /^([a-z_]{1,40})\.webp$/.exec(url.slice(EMOJI_BASE.length));
  return m && STICKERS.includes(m[1]) ? m[1] : "";
}
const HIDDEN_KEY = "rv.talk.hiddenPics";
function hiddenPics(): string[] { try { const v = JSON.parse(localStorage.getItem(HIDDEN_KEY) || "[]"); return Array.isArray(v) ? v.filter((x) => typeof x === "string") : []; } catch { return []; } }
export function hidePicture(url: string): void { try { localStorage.setItem(HIDDEN_KEY, JSON.stringify([url, ...hiddenPics().filter((x) => x !== url)].slice(0, 300))); } catch { /* 이번 판만 */ } }
/** 사람 이름표 그림 → 화면이 그릴 주소(라비 이모티콘은 앱에 든 그림으로). 못 그리면 "". */
export function personPictureSrc(url: unknown): string {
  if (typeof url !== "string" || !url || hiddenPics().includes(url)) return "";
  const code = stickerCodeOf(url);
  if (code) return `/ravi-stickers/${code}.webp`;
  return BLOSSOM.test(url) ? url : "";
}
/** 방 사진 → 화면 주소. Blossom 지문 주소만. */
export function roomPictureSrc(url: unknown): string {
  return typeof url === "string" && BLOSSOM.test(url) && !hiddenPics().includes(url) ? url : "";
}
/** 동그라미 위에 덮는 그림(못 읽으면 지워져 첫 글자가 보인다 — 아래 error 잡기). */
export const avatarImgHtml = (src: string) => src ? `<img class="tk-avpic" src="${esc(src)}" alt="" draggable="false" loading="lazy" referrerpolicy="no-referrer" />` : "";
export function setAvatarPicture(el: HTMLElement | null, src: string): void {
  if (!el) return;
  el.querySelectorAll(":scope > img.tk-avpic").forEach((x) => x.remove());
  el.classList.toggle("has-pic", !!src);
  if (!src) return;
  const img = document.createElement("img");
  img.className = "tk-avpic"; img.alt = ""; img.draggable = false; img.referrerPolicy = "no-referrer"; img.src = src;
  el.append(img);
}

// ── 사진 고르기·올리기 ───────────────────────────────────────────
/** 고른 그림 → 가운데 정사각 512px JPEG(base64). 위치 정보 같은 EXIF 는 캔버스에 다시 그리며 빠진다. */
export async function squareJpeg(file: Blob, size = 512): Promise<string> {
  const bmp = await createImageBitmap(file);
  const side = Math.min(bmp.width, bmp.height);
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = Math.min(size, side);
  const g = canvas.getContext("2d");
  if (!g) throw new Error(t("사진을 읽지 못했어요."));
  g.drawImage(bmp, (bmp.width - side) / 2, (bmp.height - side) / 2, side, side, 0, 0, canvas.width, canvas.height);
  bmp.close?.();
  const blob: Blob | null = await new Promise((ok) => canvas.toBlob(ok, "image/jpeg", 0.86));
  if (!blob) throw new Error(t("사진을 읽지 못했어요."));
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
/** 파일 고르기 창 → 정사각 512 → Blossom. 답 = 사진 주소(우리 규칙에 맞는 것만) 또는 ""(고르지 않음). */
export async function pickAndUploadPhoto(): Promise<string> {
  if (!deps) return "";
  const file = await new Promise<File | null>((ok) => {
    const input = document.createElement("input");
    input.type = "file"; input.accept = "image/jpeg,image/png,image/webp,image/heic";
    input.onchange = () => ok(input.files?.[0] ?? null);
    input.addEventListener("cancel", () => ok(null));
    input.click();
  });
  if (!file) return "";
  const data = await squareJpeg(file);
  const r = await deps.invoke<{ url?: string }>("talk_blossom_upload", { data, mime: "image/jpeg" });
  const url = String(r?.url || "");
  if (!BLOSSOM.test(url)) throw new Error(t("사진을 읽지 못했어요."));
  return url;
}

/** 사진 신고 — 「문제 알리기」와 같은 길(report_send, category counterparty). 신고하면 이 컴퓨터에서 그 사진을 숨긴다. */
export async function reportPicture(kind: "room" | "profile", target: string, url: string): Promise<boolean> {
  if (!deps || !url) return false;
  const ok = await sheetConfirm(t("이 사진을 신고할까요?"), t("신고하면 이 사진은 내 화면에서 바로 숨겨지고 첫 글자 동그라미로 보여요."), t("신고하기"));
  if (!ok) return false;
  hidePicture(url);
  try {
    await deps.invoke("report_send", {
      title: `[이야기 신고] ${kind === "room" ? "방 사진" : "프로필 사진"}`,
      description: `[이야기 신고] ${kind === "room" ? "방 사진" : "프로필 사진"}`,
      category: "counterparty", screen: "talk",
      context: { kind: "talk-picture-report", where: kind, target, picture: url, lang: document.documentElement.lang || "" },
      attachLog: false,
    });
  } catch { /* 못 보내도 숨김은 이미 됐다 — report_send 가 다음에 켤 때 보낸다 */ }
  return true;
}

// ── 시트(경고·전체 주소·확인) ─────────────────────────────────────
let sheetWrap: HTMLElement | null = null;
function sheetHost(): HTMLElement {
  if (!sheetWrap) {
    sheetWrap = document.createElement("div");
    sheetWrap.className = "tk-lsheet-wrap"; sheetWrap.id = "tk-lsheet"; sheetWrap.hidden = true;
    sheetWrap.addEventListener("mousedown", (e) => { if (e.target === sheetWrap) closeSheet(); });
    sheetWrap.addEventListener("keydown", (e) => { if (e.key === "Escape") { e.stopPropagation(); closeSheet(); } });
    document.body.append(sheetWrap);
  }
  return sheetWrap;
}
let onClose: (() => void) | null = null;
export function closeSheet(): void { if (sheetWrap) sheetWrap.hidden = true; const f = onClose; onClose = null; f?.(); }
export const sheetOpen = () => !!sheetWrap && !sheetWrap.hidden;

function sheetConfirm(title: string, body: string, go: string): Promise<boolean> {
  return new Promise((done) => {
    const w = sheetHost();
    w.innerHTML = `<div class="tk-lsheet" role="dialog" aria-modal="true" aria-labelledby="tk-ls-h"><h3 id="tk-ls-h">${esc(title)}</h3><p class="tk-ls-body">${esc(body)}</p>` +
      `<div class="tk-ls-acts"><button type="button" class="ghost" data-ls="no">${copyHtml("취소")}</button><button type="button" class="danger" data-ls="yes">${esc(go)}</button></div></div>`;
    let answered = false;
    onClose = () => { if (!answered) done(false); };
    w.querySelector<HTMLElement>('[data-ls="no"]')!.onclick = () => closeSheet();
    w.querySelector<HTMLElement>('[data-ls="yes"]')!.onclick = () => { answered = true; closeSheet(); done(true); };
    w.hidden = false;
    w.querySelector<HTMLElement>('[data-ls="no"]')?.focus();
  });
}

/** 위험한 주소면 경고 시트(why=risky), 오른쪽 클릭이면 전체 주소 시트(why=hold). */
export function openLinkSheet(href: string, risk: LinkRisk = linkRisk(href)): void {
  const w = sheetHost();
  const risky = risk.risky;
  w.innerHTML = `<div class="tk-lsheet${risky ? " risky" : ""}" role="dialog" aria-modal="true" aria-labelledby="tk-ls-h">` +
    (risky ? `<h3 id="tk-ls-h" class="tk-ls-warn">⚠ ${copyHtml("이 링크 조심하세요")}</h3>` : `<h3 id="tk-ls-h" class="tk-ls-small">${copyHtml("링크")}</h3>`) +
    `<p class="tk-ls-lbl">${copyHtml("진짜 도메인")}</p><p class="tk-ls-domain" translate="no">${esc(risk.host || href)}</p>` +
    (risky ? `<ul class="tk-ls-why">${risk.reasons.map((r) => `<li>${copyHtml(RISK_TEXT[r])}</li>`).join("")}</ul><p class="tk-ls-tip">${copyHtml("복구 단어·비밀번호는 어떤 사이트에도 넣지 마세요.")}</p>` : "") +
    `<p class="tk-ls-full" translate="no">${esc(href)}</p><p class="tk-ls-say" role="status"></p>` +
    `<div class="tk-ls-acts"><button type="button" class="ghost" data-ls="close">${copyHtml("닫기")}</button><button type="button" class="ghost" data-ls="copy">${copyHtml("주소 복사")}</button>` +
    `<button type="button" class="${risky ? "danger" : ""}" data-ls="open">${copyHtml(risky ? "그래도 열기" : "열기")}</button></div></div>`;
  w.querySelector<HTMLElement>('[data-ls="close"]')!.onclick = () => closeSheet();
  w.querySelector<HTMLElement>('[data-ls="open"]')!.onclick = () => { closeSheet(); void deps?.openUrl(href); };
  w.querySelector<HTMLElement>('[data-ls="copy"]')!.onclick = async () => {
    const say = w.querySelector<HTMLElement>(".tk-ls-say")!;
    try { await navigator.clipboard.writeText(href); say.textContent = t("주소를 복사했어요."); } catch { say.textContent = t("복사하지 못했어요."); }
  };
  onClose = null;
  w.hidden = false;
  w.querySelector<HTMLElement>('[data-ls="close"]')?.focus();
}
/** 링크 누름: 위험하면 시트, 아니면 바로 기본 브라우저. */
export function pressLink(href: string): void {
  const risk = linkRisk(href);
  if (risk.risky) openLinkSheet(href, risk); else void deps?.openUrl(href);
}

// ── 글 → HTML ────────────────────────────────────────────────
/** 글 조각(이미 이모티콘을 뺀 글자)을 escape 하며 주소만 누르는 링크로. */
export function linkifyHtml(text: string): string {
  return urlSegments(text).map((s) => s.kind === "text" ? esc(s.text)
    : `<a class="tk-url" href="#" data-tk-url="${esc(s.href)}" title="${esc(s.href)}" translate="no">${esc(shortUrl(s.href))}</a>`).join("");
}
/** 미리보기를 붙일 주소(첫 주소 · https · 우리 사이트 아님). */
export function previewUrlOf(text: string): string {
  const url = firstUrl(text);
  if (!url) return "";
  try { const u = new URL(url); if (u.protocol !== "https:" || OWN_HOSTS.has(u.hostname.toLowerCase())) return ""; } catch { return ""; }
  return url;
}
/** 말풍선 끝에 둘 미리보기 자리. 그린 뒤 fillPreviews 가 채운다. */
export const previewSlotHtml = (text: string) => { const u = previewUrlOf(text); return u ? `<span class="tk-lp" data-tk-lp="${esc(u)}"></span>` : ""; };

// ── 미리보기 ───────────────────────────────────────────────
const PREF = "rv.talk.linkPreview";
export const previewOn = () => { try { return localStorage.getItem(PREF) !== "off"; } catch { return true; } };
export function setPreviewOn(on: boolean) { try { localStorage.setItem(PREF, on ? "on" : "off"); } catch { /* 이번 판만 */ } }
type Preview = { url: string; kind: "page" | "x" | "youtube"; site: string; title: string; description: string; image: string };
const cache = new Map<string, Promise<Preview | null>>();
function loadPreview(url: string): Promise<Preview | null> {
  let p = cache.get(url);
  if (!p && deps) {
    if (cache.size > 300) cache.clear();
    const d = deps;
    p = d.invoke<any>("talk_unfurl", { url }).then((j) => {
      if (!j || j.none || (!j.title && !j.description)) return null;
      const image = typeof j.image === "string" && /^data:image\/(jpeg|png|webp|gif);base64,/.test(j.image) ? j.image : "";
      return { url, kind: j.kind === "x" || j.kind === "youtube" ? j.kind : "page", site: String(j.site || ""), title: String(j.title || ""), description: String(j.description || ""), image } as Preview;
    }, () => null);
    p.then((v) => { if (!v) setTimeout(() => cache.delete(url), 60_000); });
    cache.set(url, p);
  }
  return p ?? Promise.resolve(null);
}
/** 그린 뒤 부른다: 자리마다 한 번, 우리 서버를 거친 답으로 카드를 만든다(DOM — 글자는 textContent). */
export async function fillPreviews(root: ParentNode): Promise<void> {
  if (!previewOn()) return;
  const slots = [...root.querySelectorAll<HTMLElement>("[data-tk-lp]:not([data-lp-done])")];
  await Promise.all(slots.map(async (slot) => {
    slot.dataset.lpDone = "1";
    const url = String(slot.dataset.tkLp || "");
    const p = await loadPreview(url);
    if (!p || !slot.isConnected) return;
    let host = ""; try { host = new URL(url).hostname.replace(/^www\./, ""); } catch { /* */ }
    const card = document.createElement("a");
    card.className = "tk-lpcard"; card.href = "#"; card.dataset.tkUrl = url; card.setAttribute("translate", "no");
    if (p.image) { const img = document.createElement("img"); img.src = p.image; img.alt = ""; img.className = "tk-lpimg"; img.onerror = () => img.remove(); card.append(img); }
    const body = document.createElement("span"); body.className = "tk-lpbody";
    const line = (cls: string, text: string) => { if (!text) return; const s = document.createElement("span"); s.className = cls; s.textContent = text; body.append(s); };
    line("tk-lpsite", p.kind === "x" ? "X" : p.site || host);
    line("tk-lptitle", p.title);
    line(p.kind === "x" ? "tk-lpdesc x" : "tk-lpdesc", p.description);
    line("tk-lphost", host);
    card.append(body);
    slot.replaceChildren(card);
  }));
}

/** 한 번만 잇는다: 링크·미리보기 누름(문서 전체 위임), 오른쪽 클릭, 그림 못 읽음, 설정 스위치. */
export function wireTalkMedia(d: MediaDeps): void {
  deps = d;
  document.addEventListener("click", (e) => {
    const a = (e.target as HTMLElement | null)?.closest?.<HTMLElement>("[data-tk-url]");
    if (!a) return;
    e.preventDefault(); e.stopPropagation();
    pressLink(String(a.dataset.tkUrl || ""));
  }, true);
  document.addEventListener("contextmenu", (e) => {
    const a = (e.target as HTMLElement | null)?.closest?.<HTMLElement>("[data-tk-url]");
    if (!a) return;
    e.preventDefault(); e.stopPropagation();
    openLinkSheet(String(a.dataset.tkUrl || ""), { ...linkRisk(String(a.dataset.tkUrl || "")) });
  }, true);
  // 시트가 열려 있으면 Esc 는 시트만 닫는다(대화 화면의 Esc — 방 닫기 — 로 새지 않게). talk-desk 의 문서 capture 보다 먼저(window).
  window.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    const pic = document.getElementById("tk-picsheet");
    if (sheetOpen()) { e.preventDefault(); e.stopImmediatePropagation(); closeSheet(); }
    else if (pic && !pic.hidden) { e.preventDefault(); e.stopImmediatePropagation(); pic.hidden = true; }
  }, true);
  document.addEventListener("error", (e) => {
    const img = e.target as HTMLElement | null;
    if (img instanceof HTMLImageElement && img.classList.contains("tk-avpic")) { img.parentElement?.classList.remove("has-pic"); img.remove(); }
  }, true);
  const sw = document.getElementById("tk-lp-on") as HTMLInputElement | null;
  if (sw) { sw.checked = previewOn(); sw.addEventListener("change", () => setPreviewOn(sw.checked)); }
}
