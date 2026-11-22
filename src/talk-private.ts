/*
 * 11-23 「나만」·「친구만」 글 (내 데이터 통제 3·4단계 · 폰과 같은 형식 — src-tauri/src/talk_private.rs).
 *
 * 풀기·잠그기·열쇠는 전부 러스트가 메모리에서만 한다. 화면이 받는 것은 푼 글자와 사진 지문뿐이고,
 * 사진은 보일 때 talk_private_photo 가 메모리에서 풀어 준 data: 주소로 그린다(디스크·브라우저 저장소에 안 남긴다).
 * 🔴 이 글들은 공유 링크·답글·저장·「내 말로」(바깥 번역)를 달지 않는다 — 고른 사람 밖으로 새는 길을 만들지 않는다.
 */
import { t, tf, copyHtml } from "./i18n";

type Invoke = <T = any>(cmd: string, args?: Record<string, unknown>) => Promise<T>;
export type Audience = "all" | "friends" | "self";

const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const HEX64 = /^[0-9a-f]{64}$/;

/** 소식 카드가 그대로 쓰는 모양(이벤트처럼) + `_aud`(self|friends) · `_photos`(지문). 메모리에만. */
let cache: { me: string; notes: any[]; friends: string[]; at: number } | null = null;
let busy: Promise<void> | null = null;

function asEvent(n: any): any | null {
  const id = String(n?.id ?? ""), pubkey = String(n?.pubkey ?? "");
  if (!HEX64.test(id) || !HEX64.test(pubkey)) return null;
  const aud = n?.audience === "friends" ? "friends" : n?.audience === "self" ? "self" : "";
  if (!aud) return null;
  const photos = (Array.isArray(n?.photos) ? n.photos : []).map((p: any) => String(p?.sha256 ?? "")).filter((h: string) => HEX64.test(h)).slice(0, 4);
  return { id, pubkey, created_at: Number(n?.at ?? 0), kind: 4470, content: String(n?.text ?? ""), tags: [], _aud: aud, _photos: photos };
}

/** 다시 읽는다(1분 안에 읽었으면 건너뜀 · force 면 바로). 다 읽으면 onDone. 못 읽어도 소식은 그대로. */
export function loadPrivate(invoke: Invoke, onDone: () => void, force = false): void {
  if (busy || (!force && cache && Date.now() - cache.at < 60_000)) return;
  busy = (async () => {
    try {
      const r = await invoke<any>("talk_private_load");
      const notes = (Array.isArray(r?.notes) ? r.notes : []).map(asEvent).filter(Boolean);
      cache = { me: String(r?.me ?? ""), notes, friends: Array.isArray(r?.friends) ? r.friends.map(String) : [], at: Date.now() };
      onDone();
    } catch { /* 지갑이 잠겼거나 못 닿음 — 비공개 글 없이 그린다 */ }
    finally { busy = null; }
  })();
}
export function privateNotes(): any[] { return cache?.notes ?? []; }
export function myPrivateNotes(): any[] { return cache ? cache.notes.filter((e) => e.pubkey === cache!.me) : []; }
export function circleFriends(): string[] | null { return cache ? cache.friends : null; }
export function addPrivateNote(n: any): void {
  const e = asEvent(n);
  if (!e) return;
  if (!cache) cache = { me: e.pubkey, notes: [], friends: [], at: 0 };
  cache.notes = [e, ...cache.notes.filter((x) => x.id !== e.id)];
}
export function forgetPrivateNote(id: string): void { if (cache) cache.notes = cache.notes.filter((e) => e.id !== id); }

export const isPrivate = (e: any): boolean => e?._aud === "self" || e?._aud === "friends";
export function privateBadgeHtml(e: any): string {
  return isPrivate(e) ? `<span class="fpriv" title="${esc(t(e._aud === "self" ? "나만 봐요" : "내가 고른 친구만 봐요"))}">${copyHtml(e._aud === "self" ? "나만" : "친구만")}</span>` : "";
}
export function privatePhotosHtml(e: any): string {
  const list: string[] = Array.isArray(e?._photos) ? e._photos : [];
  return list.length ? `<div class="fpriv-pics">${list.map((h) => `<img data-psha="${h}" alt="${esc(t("사진"))}" />`).join("")}</div>` : "";
}
/** 보일 때 메모리에서 풀어 채운다. 못 풀면 「사진을 열지 못했어요」 한 줄. */
export function fillPrivatePhotos(root: HTMLElement, invoke: Invoke): void {
  const imgs = [...root.querySelectorAll<HTMLImageElement>("img[data-psha]:not([src])")];
  if (!imgs.length) return;
  const fill = async (img: HTMLImageElement) => {
    const d = await invoke<string | null>("talk_private_photo", { sha256: img.dataset.psha }).catch(() => null);
    if (typeof d === "string" && /^data:image\/(jpeg|png|gif|webp);base64,/.test(d)) img.src = d;
    else { const p = document.createElement("span"); p.className = "meta"; p.textContent = t("사진을 열지 못했어요"); img.replaceWith(p); }
  };
  if (typeof IntersectionObserver !== "function") { imgs.forEach((i) => void fill(i)); return; }
  const io = new IntersectionObserver((es) => { for (const en of es) if (en.isIntersecting) { io.unobserve(en.target); void fill(en.target as HTMLImageElement); } }, { rootMargin: "300px" });
  imgs.forEach((i) => io.observe(i));
}

// ── 글쓰기 「누구에게」 ─────────────────────────────────────────────
let audience: Audience = "all";
export const currentAudience = (): Audience => audience;
/** 늘 「모두」부터 — 화면을 열 때·보낸 뒤 되돌린다. */
export function resetAudience(root: ParentNode = document): void { setAudience("all", root); }
function setAudience(a: Audience, root: ParentNode = document) {
  audience = a;
  root.querySelectorAll<HTMLButtonElement>("#tk-aud [data-aud]").forEach((b) => { const on = b.dataset.aud === a; b.classList.toggle("on", on); b.setAttribute("aria-pressed", String(on)); });
  const say = root.querySelector<HTMLElement>("#tk-aud-say");
  if (say) say.textContent = a === "self" ? t("나만 봐요. 다른 사람에게는 안 보여요.") : a === "friends" ? t("내가 고른 친구만 봐요.") : "";
}
export function wireAudience(): void {
  document.querySelectorAll<HTMLButtonElement>("#tk-aud [data-aud]").forEach((b) => { b.onclick = () => setAudience((b.dataset.aud as Audience) || "all"); });
  resetAudience();
}
/** 방·쪽지에서는 숨긴다(소식 글쓰기에만). 숨길 때 「모두」로 되돌린다. */
export function showAudience(on: boolean): void {
  const box = document.getElementById("tk-aud");
  if (!box) return;
  if (!on && !box.hidden) resetAudience();
  box.hidden = !on;
}

// ── 사람 칸 「친구만 글 보여 주기」 ───────────────────────────────────
export function circleRowHtml(pk: string, me: string): string {
  if (!HEX64.test(pk) || pk === me) return "";
  const on = !!circleFriends()?.includes(pk);
  return `<div class="tk-circle"><button type="button" class="ghost" data-circle="${pk}" data-on="${on ? "1" : ""}">${copyHtml(on ? "친구만 글 그만 보여 주기" : "친구만 글 보여 주기")}</button>` +
    `<p class="meta" data-circle-say role="status"></p></div>`;
}
export function wireCircleRow(root: HTMLElement, deps: { invoke: Invoke; sure: (title: string, body: string, ok: string) => Promise<boolean>; errText: (e: unknown) => string; repaint: () => void }): void {
  root.querySelectorAll<HTMLButtonElement>("[data-circle]").forEach((b) => {
    b.onclick = async () => {
      const pk = String(b.dataset.circle || ""), on = b.dataset.on === "1";
      const say = root.querySelector<HTMLElement>("[data-circle-say]");
      if (on && !(await deps.sure(t("친구만 글을 그만 보여 줄까요?"), t("지금부터 올리는 글만 안 보여요. 예전 글은 남을 수 있어요"), t("그만 보여 주기")))) return;
      b.disabled = true;
      if (say) say.textContent = t("친구 목록을 바꾸는 중…");
      try {
        const r = await deps.invoke<any>("talk_circle_set", { friend: pk, add: !on });
        if (cache) cache.friends = Array.isArray(r?.friends) ? r.friends.map(String) : cache.friends;
        const refused: string[] = Array.isArray(r?.refused) ? r.refused : [];
        const msg = on ? t("지금부터 올리는 글만 안 보여요. 예전 글은 남을 수 있어요") : t("이제 이 분도 내 「친구만」 글을 봐요.");
        deps.repaint();
        const s2 = root.querySelector<HTMLElement>("[data-circle-say]");
        if (s2) s2.textContent = msg + (refused.length ? " " + tf("릴레이 {0}곳은 받지 않았어요.", String(refused.length)) : "");
      } catch (e) {
        b.disabled = false;
        if (say) say.textContent = deps.errText(e);
      }
    };
  });
}
