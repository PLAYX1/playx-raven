/*
 * 「라비가 다 해 줄게요」 — 게임 올리기 화면에서 이름·표지·미리보기·설명·첫 판 무료를 라비가 대신 채운다. (2026-11-27, 대표 「썸네일등 모든것을 라비가 대신」)
 *
 * 순서: ① 이름(빈 칸이면 시작 파일 <title> → 폴더 이름) · 장르(확실한 말이 있을 때만)
 *   → ② 표지 · ③ 미리보기: 고른 폴더를 이 컴퓨터 미리보기 칸(127.0.0.1:8791, arcade_preview.rs)에서 `?auto=1&free=1&play=1`(스스로 하는 데모)로 돌리고,
 *      붙잡기 도우미(__rv_capture.js)에게 표지 JPEG · 약 6초 영상을 받아 고른 폴더에 쓴다(arcade_picked_write → 다시 훑은 답으로 scan 갱신).
 *      캔버스가 없거나 · 25초 넘거나 · 그림이 거의 한 색이면 → 앱이 이름 카드 표지를 그린다(장터 색 · 이름 · 장르 · 라비 얼굴).
 *   → ④ 설명(빈 칸이면 틀) · 「첫 판 무료」 표시.
 * 🔴 게임은 남이 만든 코드다: iframe sandbox="allow-scripts" 만(같은 출처 권한 없음). 메시지는 그 iframe(불투명 출처 'null')에서 온 정해진 모양만 받는다.
 * 🔴 판매자가 넣어 둔 표지·미리보기는 덮지 않는다(이번에 라비가 쓴 파일만 다시 만들 때 바꾼다). 판매자가 적은 칸도 덮지 않는다.
 * 🔴 아무것도 올리지 않는다 — 「확인하기」·「올리기」는 사람이 누른다.
 */
import { t, tf, copyHtml, setCopyText } from "./i18n";
import { ARCADE_GENRE_LABELS, type ArcadeGenre } from "../core/creator/arcade-product";
import { scanOf, type FolderScan } from "./arcade-upload-rules";
import {
  DESC_TEMPLATE, MAKER_LIMITS, TONE_COLORS, bytesLookLike, guessGenre, guessTitle, isBlankImage, ownCoverOf, ownPreviewOf, previewNameFor,
} from "./arcade-maker-rules";

type Invoke = <T = any>(cmd: string, args?: Record<string, unknown>) => Promise<T>;
export type MakerDeps = {
  invoke: Invoke;
  errText: (e: unknown) => string;
  getScan: () => FolderScan | null;
  /** 라비가 파일을 쓴 뒤 새로 훑은 폴더(화면이 scan·검사를 바꾼다). */
  setScan: (s: FolderScan) => void;
  /** 판매자 칸(없으면 null). */
  field: <T extends HTMLElement>(sel: string) => T | null;
};
type StepKey = "name" | "cover" | "preview" | "desc";
type StepState = "wait" | "doing" | "done" | "skip" | "fail";
const STEP_LABEL: Record<StepKey, string> = { name: "이름", cover: "표지", preview: "미리보기", desc: "설명" };

const TOTAL_MS = 25_000, SETTLE_MS = 3_000, READY_MS = 8_000;

function esc(s: unknown): string {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const randId = () => Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => b.toString(16).padStart(2, "0")).join("");

/** 게임이 돌려준 메시지(모양만 믿는다). */
type CaptureReply = { id: string; ok: true; kind: "cover" | "preview"; mime: string; bytes: ArrayBuffer } | { id: string; ok: false; kind: string; reason: string };
function parseReply(d: unknown): CaptureReply | { ready: true } | null {
  if (!d || typeof d !== "object") return null;
  const m = d as Record<string, unknown>;
  if (m.type !== "rv-capture" || m.v !== 1) return null;
  if (m.ready === true) return { ready: true };
  if (typeof m.id !== "string" || m.id.length > 40) return null;
  if (m.ok === true && (m.kind === "cover" || m.kind === "preview") && typeof m.mime === "string" && m.bytes instanceof ArrayBuffer && m.bytes.byteLength <= 4 * 1024 * 1024) {
    return { id: m.id, ok: true, kind: m.kind, mime: m.mime.slice(0, 60), bytes: m.bytes };
  }
  if (m.ok === false) return { id: m.id, ok: false, kind: String(m.kind ?? ""), reason: String(m.reason ?? "").slice(0, 80) };
  return null;
}

/** 이름 카드 표지(캡처를 못 했을 때) — 장터 색 · 큰 이름 · 장르 · 라비 얼굴. JPEG 바이트. */
export async function titleCardCover(title: string, genreText: string, tone: number): Promise<Uint8Array> {
  const W = 1200, H = 675;
  const c = document.createElement("canvas"); c.width = W; c.height = H;
  const g = c.getContext("2d")!;
  const [top, bottom] = TONE_COLORS[((tone % TONE_COLORS.length) + TONE_COLORS.length) % TONE_COLORS.length];
  const bg = g.createLinearGradient(0, 0, W, H); bg.addColorStop(0, top); bg.addColorStop(1, bottom);
  g.fillStyle = bg; g.fillRect(0, 0, W, H);
  // 은은한 원 두 개(빈 판처럼 보이지 않게)
  g.fillStyle = "rgba(255,255,255,0.08)";
  g.beginPath(); g.arc(W * 0.86, H * 0.18, 220, 0, Math.PI * 2); g.fill();
  g.beginPath(); g.arc(W * 0.1, H * 0.95, 180, 0, Math.PI * 2); g.fill();
  const font = (px: number, w = 800) => `${w} ${px}px system-ui, -apple-system, "Apple SD Gothic Neo", "Malgun Gothic", "Noto Sans KR", sans-serif`;
  // 장르 알약
  g.font = font(34, 700);
  const gw = g.measureText(genreText).width + 48;
  g.fillStyle = "rgba(255,255,255,0.18)";
  roundRect(g, 80, 96, gw, 60, 30); g.fill();
  g.fillStyle = "#ffffff"; g.textBaseline = "middle"; g.fillText(genreText, 104, 127);
  // 이름: 두 줄까지, 넘치면 글자를 줄인다
  const maxW = W - 160 - 260;
  let px = 112, lines: string[] = [];
  for (; px >= 56; px -= 8) { g.font = font(px); lines = wrap(g, title || "Game", maxW); if (lines.length <= 2) break; }
  lines = lines.slice(0, 2);
  g.fillStyle = "#ffffff"; g.textBaseline = "alphabetic";
  g.shadowColor = "rgba(0,0,0,0.25)"; g.shadowBlur = 12;
  lines.forEach((l, i) => g.fillText(l, 80, H / 2 + 40 + i * (px * 1.15) - (lines.length - 1) * px * 0.3));
  g.shadowBlur = 0;
  // 라비 얼굴(앱 그림 — 같은 출처라 캔버스가 깨끗하다). 못 읽으면 건너뛴다.
  try {
    const img = new Image(); img.src = "/raven-face.webp"; await img.decode();
    const r = 120, cx = W - 80 - r, cy = H - 80 - r;
    g.save(); g.beginPath(); g.arc(cx, cy, r, 0, Math.PI * 2); g.closePath();
    g.fillStyle = "rgba(255,255,255,0.92)"; g.fill(); g.clip();
    g.drawImage(img, cx - r + 12, cy - r + 12, (r - 12) * 2, (r - 12) * 2);
    g.restore();
  } catch { /* 얼굴 없이 */ }
  const blob = await new Promise<Blob | null>((res) => c.toBlob(res, "image/jpeg", 0.85));
  if (!blob) throw new Error("cover-encode");
  return new Uint8Array(await blob.arrayBuffer());
}
function roundRect(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  g.beginPath(); g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r); g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath();
}
function wrap(g: CanvasRenderingContext2D, text: string, maxW: number): string[] {
  const words = text.split(/(\s+)/).filter((w) => w.length);
  const out: string[] = []; let line = "";
  const push = (piece: string) => {
    // 띄어쓰기 없는 긴 낱말(한국어)은 글자 단위로 자른다.
    for (const ch of [...piece]) {
      if (g.measureText(line + ch).width > maxW && line.trim()) { out.push(line.trim()); line = ch.trimStart(); } else line += ch;
    }
  };
  for (const w of words) {
    if (g.measureText(line + w).width <= maxW) { line += w; continue; }
    if (line.trim()) { out.push(line.trim()); line = ""; }
    if (g.measureText(w).width > maxW) push(w); else line = w.trimStart();
  }
  if (line.trim()) out.push(line.trim());
  return out;
}

/** JPEG 바이트가 거의 한 색인가(작게 줄여 본다). 읽지 못하면 빈 것으로 본다. */
async function coverIsBlank(bytes: Uint8Array): Promise<boolean> {
  try {
    const bmp = await createImageBitmap(new Blob([bytes as BlobPart], { type: "image/jpeg" }));
    const w = 96, h = Math.max(1, Math.round((96 * bmp.height) / Math.max(1, bmp.width)));
    const c = document.createElement("canvas"); c.width = w; c.height = h;
    const g = c.getContext("2d")!; g.drawImage(bmp, 0, 0, w, h); bmp.close?.();
    return isBlankImage(g.getImageData(0, 0, w, h).data, w, h);
  } catch { return true; }
}

/** 장터 toneOf 와 같은 셈(제목으로 — 아직 id 가 없다). */
const toneOfText = (s: string) => { let h = 0; for (const c of s) h = (h * 31 + c.charCodeAt(0)) >>> 0; return h % 5; };

export function mountMaker(box: HTMLElement, deps: MakerDeps) {
  /** 이번 고르기에서 라비가 쓴 파일(다시 만들 때만 덮는다). */
  const madeByRavi = new Set<string>();
  const urls: string[] = [];
  let running = false, ranOnce = false;
  const steps: Record<StepKey, { s: StepState; note: string }> = { name: { s: "wait", note: "" }, cover: { s: "wait", note: "" }, preview: { s: "wait", note: "" }, desc: { s: "wait", note: "" } };

  box.innerHTML =
    `<div class="ar-maker">` +
    `<div class="ar-maker-head"><img class="ar-maker-face" src="/raven-face.webp" alt="" width="40" height="40">` +
    `<div><b>${copyHtml("라비가 다 해 줄게요")}</b><p class="meta">${copyHtml("이름 · 표지 · 미리보기 · 설명을 라비가 채워요. 모두 고칠 수 있고, 올리기는 내가 눌러요.")}</p></div>` +
    `<button type="button" data-mk-go="1">${copyHtml("라비가 다 해 줄게요")}</button></div>` +
    `<ol class="ar-maker-steps" data-mk-steps="1" hidden></ol>` +
    `<div class="ar-maker-stage" data-mk-stage="1" hidden></div>` +
    `<div class="ar-maker-out" data-mk-out="1" hidden></div>` +
    `<p class="meta" data-mk-say="1" role="status"></p>` +
    `</div>`;
  const $ = <T extends HTMLElement>(sel: string) => box.querySelector<T>(sel)!;
  const goBtn = $<HTMLButtonElement>("[data-mk-go]");
  goBtn.onclick = () => void run();

  function paintSteps() {
    const ol = $("[data-mk-steps]");
    ol.hidden = false;
    const word: Record<StepState, string> = { wait: "기다리는 중", doing: "하는 중…", done: "됐어요", skip: "그대로 둬요", fail: "못 했어요" };
    ol.innerHTML = (Object.keys(STEP_LABEL) as StepKey[]).map((k) =>
      `<li class="ar-mk-${steps[k].s}"><b>${copyHtml(STEP_LABEL[k])}</b> <span>${copyHtml(word[steps[k].s])}</span>${steps[k].note ? ` <span class="meta">${esc(steps[k].note)}</span>` : ""}</li>`).join("");
  }
  const mark = (k: StepKey, s: StepState, note = "") => { steps[k] = { s, note }; paintSteps(); };

  function showOut(cover: Uint8Array | null, preview: { bytes: Uint8Array; mime: string } | null) {
    const out = $("[data-mk-out]");
    for (const u of urls.splice(0)) URL.revokeObjectURL(u);
    const parts: string[] = [];
    if (cover) { const u = URL.createObjectURL(new Blob([cover as BlobPart], { type: "image/jpeg" })); urls.push(u); parts.push(`<figure><img src="${esc(u)}" alt=""><figcaption>${copyHtml("라비가 만든 표지")}</figcaption></figure>`); }
    if (preview) { const u = URL.createObjectURL(new Blob([preview.bytes as BlobPart], { type: preview.mime })); urls.push(u); parts.push(`<figure><video src="${esc(u)}" muted loop playsinline autoplay></video><figcaption>${copyHtml("라비가 만든 미리보기")}</figcaption></figure>`); }
    out.hidden = !parts.length;
    out.innerHTML = parts.join("");
    out.querySelectorAll("video").forEach((v) => { v.muted = true; void v.play().catch(() => {}); });
  }

  /** 고른 폴더에 쓰고 새 scan 을 화면에 준다. 판매자 파일이면(라비가 쓴 것 아님) 쓰지 않는다. */
  async function write(name: string, bytes: Uint8Array): Promise<boolean> {
    const scan = deps.getScan();
    if (!scan || !bytesLookLike(name, bytes)) return false;
    const exists = scan.files.some((f) => f.path === name);
    if (exists && !madeByRavi.has(name)) return false;
    const r = await deps.invoke<unknown>("arcade_picked_write", { name, bytes: Array.from(bytes), replace: exists });
    const next = scanOf(r);
    if (!next) throw new Error(t("폴더를 읽지 못했어요."));
    madeByRavi.add(name);
    deps.setScan(next);
    return true;
  }

  /** 미리보기 칸에서 게임을 돌려 표지·영상을 받는다. 못 하면 그 칸은 null. */
  async function capture(entry: string, wantCover: boolean, wantPreview: boolean, deadline: number): Promise<{ cover: Uint8Array | null; preview: { bytes: Uint8Array; mime: string } | null; why: string }> {
    const res = { cover: null as Uint8Array | null, preview: null as { bytes: Uint8Array; mime: string } | null, why: "" };
    const open = await deps.invoke<{ base?: unknown }>("arcade_preview_open");
    const base = String(open?.base ?? "");
    if (!/^http:\/\/127\.0\.0\.1:8791\/arcade-preview\/[a-f0-9]{48}\/$/.test(base) || !/^[A-Za-z0-9_\-./]+$/.test(entry) || entry.split("/").some((s) => s === ".." || s.startsWith("."))) {
      res.why = "bad-url"; return res;
    }
    const stage = $("[data-mk-stage]");
    stage.hidden = false;
    stage.innerHTML = `<p class="meta">${copyHtml("라비가 게임을 해 보는 중…")}</p>`;
    const frame = document.createElement("iframe");
    frame.setAttribute("sandbox", "allow-scripts");
    frame.setAttribute("referrerpolicy", "no-referrer");
    frame.setAttribute("allow", "");
    frame.setAttribute("title", t("라비가 게임을 해 보는 중…"));
    // 1280x720 으로 돌려(표지가 크게 나오게) 480x270 칸에 줄여 보여 준다.
    frame.width = "1280"; frame.height = "720";
    frame.className = "ar-maker-frame";
    const view = document.createElement("div");
    view.className = "ar-maker-view";
    const waiters = new Map<string, (r: CaptureReply) => void>();
    let ready = false, readyWake: (() => void) | null = null;
    const onMsg = (e: MessageEvent) => {
      if (e.source !== frame.contentWindow || e.origin !== "null") return;
      const m = parseReply(e.data);
      if (!m) return;
      if ("ready" in m) { ready = true; readyWake?.(); return; }
      waiters.get(m.id)?.(m);
    };
    window.addEventListener("message", onMsg);
    const ask = (kind: "cover" | "preview", ms: number): Promise<CaptureReply | null> => new Promise((resolve) => {
      const id = randId();
      const left = Math.max(0, Math.min(ms, deadline - Date.now()));
      const timer = setTimeout(() => { waiters.delete(id); resolve(null); }, left);
      waiters.set(id, (r) => { clearTimeout(timer); waiters.delete(id); resolve(r); });
      frame.contentWindow?.postMessage({ type: "rv-capture", v: 1, id, ask: kind, ms: 6000 }, "*");
    });
    try {
      // ?auto=1 = 스스로 하는 데모 · free=1&play=1 = 무료 체험으로 바로 시작(지갑에 묻지 않는다) — 우리 게임 계약(ARCADE-CONTRACT). 다른 게임은 무시한다.
      frame.src = `${base}${entry}?auto=1&free=1&play=1`;
      view.appendChild(frame);
      stage.appendChild(view);
      await Promise.race([new Promise<void>((r) => { readyWake = r; if (ready) r(); }), sleep(Math.min(READY_MS, Math.max(0, deadline - Date.now())))]);
      if (!ready) { res.why = "not-ready"; return res; }
      await sleep(Math.min(SETTLE_MS, Math.max(0, deadline - Date.now())));
      if (wantCover) {
        const r = await ask("cover", 8000);
        if (r?.ok && r.kind === "cover" && r.bytes.byteLength <= MAKER_LIMITS.cover) res.cover = new Uint8Array(r.bytes);
        else res.why = r && !r.ok ? r.reason : "cover-timeout";
        if (r && !r.ok && r.reason === "no-canvas") return res;
      }
      if (wantPreview && Date.now() < deadline - 7000) {
        const r = await ask("preview", 14000);
        if (r?.ok && r.kind === "preview" && r.bytes.byteLength <= MAKER_LIMITS.preview && previewNameFor(r.mime)) res.preview = { bytes: new Uint8Array(r.bytes), mime: r.mime.split(";")[0] };
        else if (!res.why) res.why = r && !r.ok ? r.reason : r?.ok ? "preview-too-big" : "preview-timeout";
      }
      return res;
    } finally {
      window.removeEventListener("message", onMsg);
      frame.remove();
      stage.hidden = true; stage.innerHTML = "";
    }
  }

  async function run(auto = false) {
    const scan = deps.getScan();
    if (running || !scan) return;
    if (auto && ranOnce) return;
    running = true; ranOnce = true; goBtn.disabled = true;
    const say = $("[data-mk-say]");
    setCopyText(say, () => t("라비가 하는 중이에요. 조금만 기다려 주세요."));
    (Object.keys(steps) as StepKey[]).forEach((k) => { steps[k] = { s: "wait", note: "" }; });
    paintSteps();
    const deadline = Date.now() + TOTAL_MS;
    let made: { cover: Uint8Array | null; preview: { bytes: Uint8Array; mime: string } | null } = { cover: null, preview: null };
    try {
      // ① 이름 · 장르
      mark("name", "doing");
      const titleEl = deps.field<HTMLInputElement>("[data-up-title]");
      const entry = deps.field<HTMLSelectElement>("[data-up-entry]")?.value || "index.html";
      let title = titleEl?.value.trim() ?? "";
      if (titleEl && !title) {
        title = guessTitle(scan, entry);
        if (title) { titleEl.value = title; titleEl.dispatchEvent(new Event("input")); }
      }
      const genreEl = deps.field<HTMLSelectElement>("[data-up-genre]");
      if (genreEl && !genreEl.dataset.touched) { const g = guessGenre(scan, title); if (g) genreEl.value = g; }
      mark("name", title ? "done" : "fail", title);
      const genre = (genreEl?.value || "other") as ArcadeGenre;

      // ② 표지 · ③ 미리보기
      const ownCover = ownCoverOf(scan.files), ownPrev = ownPreviewOf(scan.files);
      const wantCover = !ownCover || madeByRavi.has(ownCover);
      const wantPreview = !ownPrev || madeByRavi.has(ownPrev);
      if (!wantCover) mark("cover", "skip", tf("내가 넣은 표지({0})를 그대로 써요.", ownCover));
      else mark("cover", "doing");
      if (!wantPreview) mark("preview", "skip", tf("내가 넣은 미리보기({0})를 그대로 써요.", ownPrev));
      else mark("preview", "doing");
      let cap: Awaited<ReturnType<typeof capture>> = { cover: null, preview: null, why: "" };
      if (wantCover || wantPreview) {
        try { cap = await capture(entry, wantCover, wantPreview, deadline); } catch (e) { cap.why = deps.errText(e); }
      }
      if (wantCover) {
        let cover = cap.cover;
        let note = t("게임 화면에서 떴어요.");
        if (!cover || await coverIsBlank(cover)) {
          cover = await titleCardCover(title, t(ARCADE_GENRE_LABELS[genre]), toneOfText(title || scan.folder));
          note = t("게임 화면을 못 떠서 이름 카드로 만들었어요.");
        }
        try {
          if (await write("cover.jpg", cover)) { made.cover = cover; mark("cover", "done", note); }
          else mark("cover", "skip", t("같은 이름 파일이 있어 그대로 둬요."));
        } catch (e) { mark("cover", "fail", deps.errText(e)); }
      }
      if (wantPreview) {
        const pv = cap.preview, name = pv ? previewNameFor(pv.mime) : null;
        if (pv && name) {
          try {
            if (await write(name, pv.bytes)) { made.preview = pv; mark("preview", "done", tf("{0}초 · {1}", 6, fmtKb(pv.bytes.length))); }
            else mark("preview", "skip", t("같은 이름 파일이 있어 그대로 둬요."));
          } catch (e) { mark("preview", "fail", deps.errText(e)); }
        } else {
          mark("preview", "fail", t(cap.why === "no-canvas" ? "캔버스로 그리는 게임이 아니라 영상을 못 떴어요." : "영상을 못 떴어요. 표지만으로도 올릴 수 있어요."));
        }
      }

      // ④ 설명 · 첫 판 무료
      mark("desc", "doing");
      const descEl = deps.field<HTMLTextAreaElement>("[data-up-desc]");
      const minutes = Math.max(1, Math.round(Number(deps.field<HTMLInputElement>("[data-up-min]")?.value) || 3));
      if (descEl && !descEl.value.trim()) { descEl.value = tf(DESC_TEMPLATE, title || scan.folder, t(ARCADE_GENRE_LABELS[genre]), minutes); mark("desc", "done"); }
      else mark("desc", "skip", t("내가 적은 설명을 그대로 둬요."));
      const ff = deps.field<HTMLInputElement>("[data-up-ff]");
      if (ff) { ff.checked = true; ff.dispatchEvent(new Event("change")); }
      showOut(made.cover, made.preview);
      const anyFail = (Object.keys(steps) as StepKey[]).some((k) => steps[k].s === "fail");
      setCopyText(say, () => t(anyFail ? "라비가 할 수 있는 만큼 했어요. 못 한 칸은 직접 채우거나 「다시 만들기」를 눌러 주세요." : "다 했어요. 고칠 곳이 있으면 고치고 「확인하기」를 눌러 주세요."));
      setCopyText(goBtn, () => t("다시 만들기"));
    } catch (e) {
      say.innerHTML = `<span class="danger">${esc(deps.errText(e))}</span>`;
    } finally {
      running = false; goBtn.disabled = false;
    }
  }

  return {
    /** 폴더를 고른 직후 한 번 — 판매자 표지가 없을 때만. */
    autoRun() { const s = deps.getScan(); if (s && !ownCoverOf(s.files)) void run(true); },
    run: () => run(false),
  };
}

const fmtKb = (n: number) => n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;
