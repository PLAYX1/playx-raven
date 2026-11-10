// 11-09 이야기 SNS 빈 곳 채우기 — 폰 phone/screens/TalkSocial.tsx 와 같은 것을 데스크탑에:
//   알림(종 + 새 알림 점) · 찾기(사람·글·#태그) · 글 속 링크(「@이름」·「글 보기」·#태그) · NIP-05 이름 확인 표시
//   · 「내 글 모두 받기」·「다른 Nostr 앱에서 보기」 · 글쓰기 「@」(팔로우한 사람 넣기).
// 릴레이·바깥 사이트에 묻는 일은 모두 러스트(src-tauri/src/talk_social.rs)가 한다 — 화면 CSP(connect-src)는 그대로.
//
// 🔴 지키는 것
//  - 좋아요 수·리포스트·알고리즘은 넣지 않는다(대표 결정). 알림도 「누가 무엇을」만.
//  - 「다른 Nostr 앱에서 보기」·내보내기는 공개 주소(npub)만. 비밀 열쇠는 보이지도 담지도 않는다.
//  - 아이콘은 SVG(이모지 금지) · 모양은 src/talk-social.css(style="" 은 CSP 가 막는다).
import { copyHtml, t, tf } from "./i18n";
import {
  applyMentions, cleanSeen, exportFileName, firstSeen, isUnread, markSeen, matchNotes, matchPeople, noteSegments, npubOf, readSearch,
  type NoticeSeen, type Person, type TalkNotice,
} from "./talk-links";
import { hideRaviCard, looksRisky, raviCardKey, showRaviCard } from "./ravi-card";
import { RAVI_STICKERS, addSticker, stickerName, stickerOnly, stickerParts, type RaviStickerCode } from "../core/talk/sticker";

type Invoke = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;
export type TalkSocialHost = {
  invoke: Invoke;
  me: () => string;
  nameOf: (pk: string) => string;
  profile: (pk: string) => { name?: string; about?: string; nip05?: string } | null | undefined;
  people: () => Person[];
  loadNames: (pks: string[]) => Promise<void>;
  muted: (pk: string) => boolean;
  showPerson: (pk: string) => void;
  /** 지금 목록에 있는 글이면 그리로 내려가 표시하고 true. */
  focusNote: (id: string) => boolean;
  /** 11-10 라비 카드 「글 보기」·「답장하기」: 이야기(광장)를 열고 그 글로 간다. reply 면 답장 줄까지 켠다. */
  openTalkNote?: (id: string, reply: boolean) => void;
  /** 처음 뜰 때 한 번 내는 낮은 소리(대화 알림 소리 켬일 때만). */
  sound?: () => void;
  active: () => boolean;
  errText: (e: unknown) => string;
  pickSave: (name: string) => Promise<string | null>;
};

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const HEX64 = /^[0-9a-f]{64}$/;
const $ = (id: string) => document.getElementById(id);
let host: TalkSocialHost | null = null;

// ── 아이콘(SVG · currentColor) ───────────────────────────────────
const SVG = (d: string, size = 20) => `<svg class="tk-sico" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
export const ICON_BELL = SVG(`<path d="M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15z"/><path d="M10 20a2 2 0 0 0 4 0"/>`);
export const ICON_SEARCH = SVG(`<circle cx="10.5" cy="10.5" r="6.5"/><path d="m15.5 15.5 5 5"/>`);
const ICON_CHECK = `<svg class="tk-nip05-ico" width="15" height="15" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="10" class="tk-nip05-bg"/><path d="m7.5 12.3 3 3 6-6.3" fill="none" class="tk-nip05-tick" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const ICON_NOTE = SVG(`<path d="M5 5h14v10H9l-4 4z"/>`, 16);
const ICON_FILE = SVG(`<path d="M7 3h7l5 5v13H7z"/><path d="M14 3v5h5"/><path d="M12 11v6m-3-3 3 3 3-3"/>`, 18);
const ICON_PEOPLE = SVG(`<circle cx="9" cy="8" r="3.2"/><path d="M3 20a6 6 0 0 1 12 0"/><circle cx="17" cy="9" r="2.6"/><path d="M16 14.2A5 5 0 0 1 21 19"/>`, 18);

const when = (at: number) => {
  const d = new Date(at * 1000), now = new Date();
  return d.toDateString() === now.toDateString() ? d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : d.toLocaleDateString([], { month: "long", day: "numeric" });
};
const snip = (s: string, n = 80) => { const one = s.replace(/\s+/g, " ").trim(); return [...one].length > n ? [...one].slice(0, n).join("") + "…" : one; };

// ── 글 속 링크 ──────────────────────────────────────────────────
/** 글 본문 HTML: 사람 링크 → 「@이름」(누르면 이름표), #태그 → 누르면 그 태그 글 찾기, 글 링크 → 본문엔 「[인용한 글]」 + 아래 「글 보기」 단추. */
/** 11-10 대표 「데스크탑에 이모티콘이 :ravi_like: 로 보이네」 — 폰·웹과 같은 부호표(core/talk/sticker.ts)로 앱에 든 그림을 그린다.
 *  글 속 표(emoji 태그)의 바깥 주소는 쓰지 않는다(추적 픽셀일 수 있다). 모르는 짧은 이름은 글자 그대로. */
const stickerImg = (code: RaviStickerCode, big: boolean) =>
  `<img class="tk-stk${big ? " big" : ""}" src="/ravi-stickers/${code}.webp" alt="${esc(t(stickerName(code)))}" title="${esc(t(stickerName(code)))}" draggable="false" />`;
const textWithStickers = (text: string) =>
  stickerParts(text).map((p) => p.kind === "text" ? esc(p.text) : stickerImg(p.code, false)).join("");
/** 글 전체가 라비 이모티콘 하나면 그 이름 — 말풍선 없이 크게 그린다. */
export function noteStickerOnly(text: string): RaviStickerCode | null { return stickerOnly(text); }
export function noteBodyHtml(text: string): string {
  const only = stickerOnly(text);
  if (only) return stickerImg(only, true);
  const segs = noteSegments(text);
  if (!segs.some((s) => s.kind !== "text")) return `<span translate="no">${textWithStickers(text)}</span>`;
  const notes: string[] = [];
  const body = segs.map((s) => {
    if (s.kind === "text") return textWithStickers(s.text);
    if (s.kind === "person") return `<button type="button" class="tk-at" data-tk-person="${s.pubkey}">@${esc(host?.nameOf(s.pubkey) || s.pubkey.slice(0, 8))}</button>`;
    if (s.kind === "tag") return `<button type="button" class="tk-hash" data-tk-tag="${esc(s.tag)}">${esc(s.raw)}</button>`;
    if (!notes.includes(s.id)) notes.push(s.id);
    return `<span class="tk-quoted">[${copyHtml("인용한 글")}]</span>`;
  }).join("");
  const chips = notes.slice(0, 6).map((id) => `<button type="button" class="tk-chip" data-tk-note="${id}">${ICON_NOTE}<span>${copyHtml("글 보기")}</span></button>`).join("");
  return `<span translate="no">${body}</span>${chips ? `<span class="tk-chips">${chips}</span>` : ""}`;
}
/** 화면에 한 줄로(알림·찾기 미리보기): 사람 링크 → @이름, 글 링크 → [인용한 글]. */
export function readableLine(text: string, n = 80): string {
  return snip(noteSegments(text).map((s) => s.kind === "text" ? stickerParts(s.text).map((p) => p.kind === "text" ? p.text : `[${t(stickerName(p.code))}]`).join("") : s.kind === "person" ? "@" + (host?.nameOf(s.pubkey) || s.pubkey.slice(0, 8)) : s.kind === "note" ? `[${t("인용한 글")}]` : s.raw).join(""), n);
}
/** 그린 뒤: 아직 모르는 「@이름」의 이름표를 가져와 고쳐 쓰고, NIP-05 표시를 채운다. */
export async function fillNoteLinks(root: ParentNode): Promise<void> {
  if (!host) return;
  const h = host;
  const people = [...root.querySelectorAll<HTMLElement>("[data-tk-person]")];
  const want = [...new Set(people.map((b) => String(b.dataset.tkPerson || "")))].filter((p) => HEX64.test(p));
  if (want.length) {
    await h.loadNames(want);
    for (const b of people) { const pk = String(b.dataset.tkPerson || ""); b.textContent = "@" + h.nameOf(pk); }
  }
  void fillNip05(root);
}

/** 이름 옆에 붙일 NIP-05 자리. 확인되면 「체크 그림 + 이름@사이트」로 채운다(fillNip05). */
export function nip05Slot(pk: string): string {
  return HEX64.test(pk) ? `<span class="tk-nip05" data-nip05-for="${pk}" hidden></span>` : "";
}
const nip05Seen = new Map<string, { ok: boolean; shown: string; at: number }>();
const nip05Asking = new Map<string, Promise<void>>();
const NIP05_TTL = 24 * 60 * 60 * 1000;
async function nip05Of(pk: string): Promise<string> {
  const id = String(host?.profile(pk)?.nip05 || "");
  if (!id || !host) return "";
  const key = `${pk}|${id}`;
  const c = nip05Seen.get(key);
  if (c && Date.now() - c.at < NIP05_TTL) return c.ok ? c.shown : "";
  let going = nip05Asking.get(key);
  if (!going) {
    going = host.invoke<any>("talk_nip05_check", { pubkey: pk, nip05: id })
      .then((r) => { nip05Seen.set(key, { ok: r?.ok === true, shown: String(r?.shown || ""), at: Date.now() }); }, () => { /* 못 물으면 표시하지 않는다(다음에 다시) */ })
      .finally(() => nip05Asking.delete(key));
    nip05Asking.set(key, going);
  }
  await going;
  const got = nip05Seen.get(key);
  return got?.ok ? got.shown : "";
}
export async function fillNip05(root: ParentNode): Promise<void> {
  const slots = [...root.querySelectorAll<HTMLElement>("[data-nip05-for]")];
  await Promise.all(slots.map(async (el) => {
    const pk = String(el.dataset.nip05For || "");
    const shown = await nip05Of(pk);
    if (!shown) { el.hidden = true; el.innerHTML = ""; return; }
    el.innerHTML = `${ICON_CHECK}<span translate="no">${esc(shown)}</span>`;
    el.title = t("이 사이트가 이 이름표를 자기 이름으로 올려 두었어요. 사람의 신원 확인은 아니에요.");
    el.setAttribute("aria-label", tf("이름 확인 · {0}", shown));
    el.hidden = false;
  }));
}

// ── 본 글 기억(찾기가 이 컴퓨터에서 본 글 안에서 낱말을 찾는다) ──
const seenNotes = new Map<string, any>();
export function rememberNotes(list: readonly any[]): void {
  for (const e of list) if (e && Number(e.kind) === 1 && HEX64.test(String(e.id || ""))) seenNotes.set(String(e.id), e);
  if (seenNotes.size > 3000) for (const k of [...seenNotes.keys()].slice(0, 1000)) seenNotes.delete(k);
}

// ── 글쓰기 「@」 ─────────────────────────────────────────────────
let picks: { name: string; pubkey: string }[] = [];
/** 보낼 때: 고른 「@이름」을 nostr:npub… 로(그 사람 알림에 뜬다). 고른 목록은 보낸 뒤 clearMentions 로 비운다(실패하면 다시 보낼 때 그대로). */
export function mentionText(text: string): string {
  return applyMentions(text, picks.filter((p) => text.includes("@" + p.name)));
}
export function clearMentions(): void { picks = []; }
async function paintMentionBox() {
  const box = $("tk-mentionbox");
  if (!box || !host) return;
  const h = host;
  box.innerHTML = `<p class="mutewhy2">${copyHtml("내가 팔로우한 사람을 글에 넣어요. 그 사람에게 알림이 가요.")}</p><p class="meta">${copyHtml("팔로우 목록을 읽는 중")}</p>`;
  let ids: string[] = [];
  try { const r = await h.invoke<any>("talk_follows"); ids = Array.isArray(r?.ids) ? r.ids.map(String).filter((x: string) => HEX64.test(x)) : []; }
  catch (e) { box.innerHTML = `<p class="meta">${esc(h.errText(e))}</p>`; return; }
  await h.loadNames(ids.slice(0, 50));
  const draw = (q: string) => {
    const k = q.trim().toLowerCase();
    const shown = ids.filter((p) => !k || h.nameOf(p).toLowerCase().includes(k)).slice(0, 30);
    const list = box.querySelector(".tk-mentionlist");
    if (!list) return;
    list.innerHTML = shown.length
      ? shown.map((p) => `<button type="button" class="tk-chip" data-tk-pick="${p}" aria-label="${esc(tf("{0} 넣기", h.nameOf(p)))}"><span translate="no">@${esc(h.nameOf(p))}</span></button>`).join("")
      : ids.length ? `<p class="meta">${copyHtml("찾은 사람이 없어요.")}</p>` : `<p class="meta">${copyHtml("아직 팔로우한 사람이 없어요.")}</p>`;
  };
  box.innerHTML = `<p class="mutewhy2">${copyHtml("내가 팔로우한 사람을 글에 넣어요. 그 사람에게 알림이 가요.")}</p>` +
    (ids.length > 8 ? `<input id="tk-mentionq" class="tk-sinput" type="search" autocomplete="off" placeholder="${esc(t("이름으로 찾기"))}" aria-label="${esc(t("이름으로 찾기"))}" />` : "") +
    `<div class="tk-mentionlist tk-chips"></div>`;
  draw("");
  const q = $("tk-mentionq") as HTMLInputElement | null;
  if (q) q.oninput = () => draw(q.value);
  box.onclick = (ev) => {
    const b = (ev.target as HTMLElement | null)?.closest<HTMLElement>("[data-tk-pick]");
    if (!b) return;
    const pk = String(b.dataset.tkPick || "");
    const name = h.nameOf(pk).replace(/\s+/g, " ").trim();
    if (!name || !HEX64.test(pk)) return;
    picks = [...picks.filter((p) => p.pubkey !== pk), { name, pubkey: pk }];
    const ta = $("tk-text") as HTMLTextAreaElement | null;
    if (ta) {
      const at = ta.selectionStart ?? ta.value.length;
      const before = ta.value.slice(0, at), after = ta.value.slice(at);
      const ins = (before && !/\s$/.test(before) ? " " : "") + "@" + name + " ";
      ta.value = before + ins + after;
      ta.selectionStart = ta.selectionEnd = before.length + ins.length;
      ta.dispatchEvent(new Event("input"));
      ta.focus();
    }
    toggleMention(false);
  };
}
/** 11-10 라비 이모티콘 고르기 — 입력칸 끝에 :ravi_…: 를 붙인다(올릴 때 러스트가 emoji 표를 단다). */
function toggleStickers(open?: boolean) {
  const box = $("tk-stickerbox"), btn = $("tk-stk");
  if (!box || !btn) return;
  const on = open ?? box.hidden;
  box.hidden = !on;
  btn.setAttribute("aria-expanded", on ? "true" : "false");
  if (!on) return;
  toggleMention(false);
  box.innerHTML = `<div class="tk-stkgrid">${RAVI_STICKERS.map((x) =>
    `<button type="button" data-tk-stk="${x.code}"><img src="/ravi-stickers/${x.code}.webp" alt="" draggable="false" /><span>${copyHtml(x.name)}</span></button>`).join("")}</div>`;
  box.querySelectorAll<HTMLElement>("[data-tk-stk]").forEach((b) => {
    b.onclick = () => {
      const ta = $("tk-text") as HTMLTextAreaElement | null;
      if (!ta) return;
      ta.value = addSticker(ta.value, b.dataset.tkStk as RaviStickerCode);
      ta.dispatchEvent(new Event("input"));
      ta.focus();
      toggleStickers(false);
    };
  });
}
function toggleMention(open?: boolean) {
  const box = $("tk-mentionbox"), btn = $("tk-at");
  if (!box || !btn) return;
  const on = open ?? box.hidden;
  box.hidden = !on;
  btn.setAttribute("aria-expanded", on ? "true" : "false");
  btn.setAttribute("aria-label", t(on ? "사람 넣기 닫기" : "사람 넣기"));
  if (on) void paintMentionBox();
}

// ── 알림 ────────────────────────────────────────────────────────
const SEEN_KEY = "rv.talk.notices-seen.v1";
let notices: TalkNotice[] | null = null;
let noticeAt = 0, noticeBusy = false, noticeProblem = "";
function seenMap(): Record<string, NoticeSeen> {
  try {
    const v = JSON.parse(localStorage.getItem(SEEN_KEY) || "{}");
    const out: Record<string, NoticeSeen> = {};
    if (v && typeof v === "object" && !Array.isArray(v)) for (const [k, x] of Object.entries(v)) { const c = cleanSeen(x); if (c && HEX64.test(k)) out[k] = c; }
    return out;
  } catch { return {}; }
}
function seenFor(me: string): NoticeSeen | null { return seenMap()[me] ?? null; }
function saveSeen(me: string, s: NoticeSeen) {
  try {
    const m = seenMap(); delete m[me];
    localStorage.setItem(SEEN_KEY, JSON.stringify(Object.fromEntries([...Object.entries(m).slice(-4), [me, s]])));
  } catch { /* 기억 못 해도 지금 화면은 그대로 */ }
}
function visibleNotices(): TalkNotice[] {
  return (notices ?? []).filter((n) => !host?.muted(n.pubkey));
}
function unreadNow(): number {
  const me = host?.me() || "";
  const seen = me ? seenFor(me) : null;
  return seen ? visibleNotices().filter((n) => isUnread(n, seen)).length : 0;
}
function paintBell() {
  const b = $("tk-bell"), dot = $("tk-bell-dot");
  if (!b || !dot) return;
  const n = unreadNow();
  dot.hidden = !n;
  dot.textContent = n > 9 ? "9+" : String(n);
  b.setAttribute("aria-label", n ? tf("알림 · 새 알림 {0}개", String(n)) : t("알림"));
}
/** 알림을 다시 묻는다(1분 안에 물었으면 force 가 아니면 건너뛴다). */
export async function refreshNotices(force = false): Promise<void> {
  if (!host || noticeBusy || (!force && Date.now() - noticeAt < 60_000)) return;
  const h = host;
  noticeBusy = true; noticeProblem = "";
  try {
    const r = await h.invoke<any>("talk_notices");
    const me = String(r?.me || h.me() || "");
    notices = (Array.isArray(r?.notices) ? r.notices : []).filter((n: any) => n && HEX64.test(String(n.pubkey || ""))).map((n: any) => ({
      key: String(n.key), kind: n.kind === "follow" ? "follow" : n.kind === "reply" ? "reply" : "mention", pubkey: String(n.pubkey), at: Number(n.at || 0), noteId: String(n.noteId || ""), text: String(n.text || ""),
    }));
    noticeAt = Date.now();
    if (HEX64.test(me) && !seenFor(me)) saveSeen(me, firstSeen(notices!, Math.floor(Date.now() / 1000)));
  } catch (e) {
    noticeProblem = h.errText(e);
  } finally {
    noticeBusy = false;
  }
  paintBell();
  if ($("tk-noticebox")?.hidden === false) void paintNotices(false);
  void announceNotices();
}

/* ── 11-10 「연락이 왔어요」 — 라비 카드(페이블 합의) ─────────────────────
 * 답글·나를 부른 글이 새로 오면 라비 단추 위에 카드 한 장. 저절로 안 사라지고, 새것이 오면 같은 카드가 바뀐다.
 * 팔로우는 카드 없음(종 숫자만). 카드는 아무것도 보내지 않는다 — 글을 열거나 답장 줄을 켤 뿐.
 * 이야기 화면에서 알림 칸을 이미 보고 있으면 띄우지 않는다. */
function markAllSeenNow() {
  const me = host?.me() || "";
  if (!HEX64.test(me)) return;
  saveSeen(me, markSeen(seenFor(me), visibleNotices(), Math.floor(Date.now() / 1000)));
  paintBell();
}
async function announceNotices() {
  if (!host) return;
  const h = host;
  const me = h.me();
  const seen = HEX64.test(me) ? seenFor(me) : null;
  if (!seen) { if (raviCardKey().startsWith("notice:")) hideRaviCard(); return; }
  const fresh = visibleNotices().filter((n) => n.kind !== "follow" && isUnread(n, seen)).sort((a, b) => b.at - a.at);
  if (!fresh.length) { if (raviCardKey().startsWith("notice:")) hideRaviCard(); return; }
  if (h.active() && $("tk-noticebox")?.hidden === false) return;
  const key = "notice:" + fresh.map((n) => n.key).join(",");
  if (raviCardKey() === key) return;
  await h.loadNames(fresh.slice(0, 10).map((n) => n.pubkey));
  const top = fresh[0];
  const risky = fresh.some((n) => looksRisky(n.text));
  const open = (reply: boolean) => { markAllSeenNow(); h.openTalkNote?.(top.noteId, reply); };
  const first = showRaviCard(fresh.length === 1
    ? {
        key, title: tf(NOTICE_LINE[top.kind], h.nameOf(top.pubkey)), body: top.text ? readableLine(top.text, 60) : undefined,
        warn: risky ? t("돈·비밀 단어 이야기가 있어요. 사기일 수 있어요.") : undefined,
        buttons: [{ label: "답장하기", primary: true, run: () => open(true) }, { label: "글 보기", run: () => open(false) }, { label: "닫기", run: markAllSeenNow }],
      }
    : {
        key, title: tf("연락 {0}개가 왔어요", String(fresh.length)), body: `${tf(NOTICE_LINE[top.kind], h.nameOf(top.pubkey))}${top.text ? " · " + readableLine(top.text, 40) : ""}`,
        warn: risky ? t("돈·비밀 단어 이야기가 있어요. 사기일 수 있어요.") : undefined,
        buttons: [{ label: "모두 보기", primary: true, run: () => { h.openTalkNote?.("", false); if (toggleBox("tk-noticebox", "tk-bell")) { freshKeys = new Set(); void paintNotices(true); } } }, { label: "닫기", run: markAllSeenNow }],
      });
  if (first) h.sound?.();
}
const NOTICE_LINE: Record<TalkNotice["kind"], string> = { reply: "{0}님이 답글을 달았어요", mention: "{0}님이 글에서 나를 불렀어요", follow: "{0}님이 나를 팔로우해요" };
let freshKeys = new Set<string>();
async function paintNotices(markAfter = true) {
  const box = $("tk-noticebox");
  if (!box || !host) return;
  const h = host;
  const me = h.me();
  const seen = seenFor(me);
  const list = visibleNotices();
  if (seen) for (const n of list) if (isUnread(n, seen)) freshKeys.add(n.key);
  await h.loadNames(list.map((n) => n.pubkey).slice(0, 50));
  const rows = list.slice(0, 100).map((n) => {
    const name = h.nameOf(n.pubkey), fresh = freshKeys.has(n.key);
    const line = tf(NOTICE_LINE[n.kind], name);
    return `<button type="button" class="tk-nrow${fresh ? " fresh" : ""}" data-tk-notice="${esc(n.key)}" aria-label="${esc((fresh ? t("새 알림") + " · " : "") + line)}">
      <span class="tk-nmain"><b translate="no">${esc(line)}</b>${nip05Slot(n.pubkey)}${n.text ? `<small translate="no">${esc(readableLine(n.text))}</small>` : ""}<small>${esc(when(n.at))}</small></span>${fresh ? `<span class="tk-freshdot" aria-hidden="true"></span>` : ""}</button>`;
  }).join("");
  box.innerHTML = `<p class="mutewhy"><b>${copyHtml("알림")}</b></p>
    <p class="mutewhy2">${copyHtml("내 글에 단 답글, 글에서 나를 부른 것, 나를 팔로우한 사람이 보여요. 다른 앱에서 쓴 것도 와요.")}</p>
    ${noticeProblem ? `<p class="meta danger">${esc(noticeProblem)}</p>` : ""}
    ${notices === null ? `<p class="meta">${copyHtml("알림을 불러오는 중")}</p>` : !list.length ? `<p class="mutenone">${copyHtml("아직 알림이 없어요.")}</p>` : `<div class="tk-nlist">${rows}</div>`}
    <div class="muterow2"><button class="ghost" type="button" data-tk-nrefresh="1">${copyHtml(noticeBusy ? "불러오는 중" : "새로 불러오기")}</button><button class="ghost" type="button" data-tk-close="tk-noticebox">${copyHtml("닫기")}</button></div>`;
  void fillNip05(box);
  box.onclick = (ev) => {
    const el = ev.target as HTMLElement | null;
    if (el?.closest("[data-tk-nrefresh]")) { void refreshNotices(true).then(() => paintNotices(false)); return; }
    const row = el?.closest<HTMLElement>("[data-tk-notice]");
    if (!row) return;
    const n = list.find((x) => x.key === row.dataset.tkNotice);
    if (!n) return;
    if (n.kind === "follow") h.showPerson(n.pubkey); else void openNote(n.noteId);
  };
  // 연 순간의 「새 알림」 표시는 그대로 보여 주고, 기록만 「본 것」으로(닫고 다시 열면 점이 없다).
  if (markAfter && notices) { saveSeen(me, markSeen(seen, list, Math.floor(Date.now() / 1000))); paintBell(); }
}
function toggleBox(id: string, btnId: string, open?: boolean): boolean {
  const box = $(id), btn = $(btnId);
  if (!box) return false;
  const on = open ?? box.hidden;
  box.hidden = !on;
  btn?.setAttribute("aria-expanded", on ? "true" : "false");
  return on;
}

// ── 글 하나 열기(「글 보기」·알림) ───────────────────────────────
export async function openNote(id: string): Promise<void> {
  if (!host || !HEX64.test(id)) return;
  const h = host;
  if (h.focusNote(id)) return;
  const box = $("tk-notebox");
  if (!box) return;
  box.hidden = false;
  box.innerHTML = `<p class="meta">${copyHtml("글을 불러오는 중")}</p>`;
  box.scrollIntoView({ block: "nearest" });
  try {
    const got = await h.invoke<any[]>("talk_notes_by_id", { ids: [id] });
    const e = (Array.isArray(got) ? got : []).find((x) => String(x?.id || "") === id);
    if (!e) { box.innerHTML = `<p class="meta">${copyHtml("이 글을 찾지 못했어요. 지워졌거나 아직 릴레이에 닿지 않았을 수 있어요.")}</p>${closeRow("tk-notebox")}`; return; }
    rememberNotes([e]);
    const pk = String(e.pubkey || "");
    await h.loadNames([pk]);
    box.innerHTML = `<div class="tk-note1"><button type="button" class="tk-at" data-tk-person="${esc(pk)}"><b translate="no">${esc(h.nameOf(pk))}</b></button>${nip05Slot(pk)} <small class="meta">${esc(new Date(Number(e.created_at || 0) * 1000).toLocaleString())}</small>
      <p class="tk-note1-body">${h.muted(pk) ? copyHtml("안 보기 한 분의 글") : noteBodyHtml(String(e.content || ""))}</p></div>${closeRow("tk-notebox")}`;
    void fillNoteLinks(box);
  } catch (err) {
    box.innerHTML = `<p class="meta danger">${esc(h.errText(err))}</p>${closeRow("tk-notebox")}`;
  }
}
const closeRow = (id: string) => `<div class="muterow2"><button class="ghost" type="button" data-tk-close="${id}">${copyHtml("닫기")}</button></div>`;

// ── 찾기 ────────────────────────────────────────────────────────
let searchSeq = 0;
function noteRows(list: any[]): string {
  if (!host) return "";
  const h = host;
  return list.filter((e) => !h.muted(String(e.pubkey || ""))).slice(0, 150).map((e) => {
    const pk = String(e.pubkey || "");
    return `<button type="button" class="tk-nrow" data-tk-note="${esc(String(e.id || ""))}"><span class="tk-nmain"><b translate="no">${esc(h.nameOf(pk))}</b><small translate="no">${esc(readableLine(String(e.content || ""), 120))}</small><small>${esc(when(Number(e.created_at || 0)))}</small></span></button>`;
  }).join("");
}
export function openSearch(q?: string) {
  toggleBox("tk-searchbox", "tk-searchbtn", true);
  const input = $("tk-sq") as HTMLInputElement | null;
  if (!input) return;
  if (q !== undefined) { input.value = q; void runSearch(q); }
  input.focus();
}
async function runSearch(raw: string) {
  if (!host) return;
  const h = host;
  const seq = ++searchSeq;
  const out = $("tk-sresult");
  if (!out) return;
  const q = readSearch(raw);
  const live = () => seq === searchSeq;
  if (q.kind === "empty") { out.innerHTML = `<p class="mutewhy2">${copyHtml("사람 이름, 글 속 낱말, #해시태그를 찾아요. 다른 앱에서 받은 이야기 아이디(npub…)를 붙여 넣어도 돼요.")}</p>`; return; }
  if (q.kind === "person") { await h.loadNames([q.pubkey]); h.showPerson(q.pubkey); out.innerHTML = `<button type="button" class="ghost" data-tk-person="${q.pubkey}">${copyHtml("이 사람 이름표 열기")}</button>`; return; }
  if (q.kind === "note") { out.innerHTML = `<button type="button" class="ghost" data-tk-note="${q.id}">${copyHtml("이 글 열기")}</button>`; void openNote(q.id); return; }
  if (q.kind === "tag") {
    out.innerHTML = `<p class="mutewhy"><b translate="no">#${esc(q.tag)}</b></p><p class="meta">${copyHtml("글을 불러오는 중")}</p>`;
    try {
      const r = await h.invoke<any>("talk_tag_notes", { tag: q.tag });
      const notes: any[] = Array.isArray(r?.notes) ? r.notes : [];
      rememberNotes(notes);
      await h.loadNames(notes.map((e) => String(e.pubkey || "")).slice(0, 50));
      if (!live()) return;
      const rows = noteRows(notes);
      out.innerHTML = `<p class="mutewhy"><b translate="no">#${esc(q.tag)}</b></p>` + (rows ? `<div class="tk-nlist">${rows}</div>` : `<p class="mutenone">${copyHtml("찾은 글이 없어요.")}</p>`);
    } catch (e) { if (live()) out.innerHTML = `<p class="meta danger">${esc(h.errText(e))}</p>`; }
    return;
  }
  // 낱말: 사람(이 컴퓨터가 받은 이름표) + 글(이 컴퓨터가 본 글 + 낱말 찾기를 알린 릴레이)
  const people = matchPeople(h.people(), q.text).filter((p) => !h.muted(p.pubkey));
  let notes = matchNotes([...seenNotes.values()], q.text);
  const paint = (asked: number) => {
    const peopleHtml = people.length
      ? `<div class="tk-nlist">${people.map((p) => `<button type="button" class="tk-nrow" data-tk-person="${p.pubkey}"><span class="tk-nmain"><b translate="no">${esc(p.name || h.nameOf(p.pubkey))}</b>${nip05Slot(p.pubkey)}<small translate="no">${esc(npubOf(p.pubkey).slice(-6) + (p.about ? " · " + snip(p.about, 60) : ""))}</small></span></button>`).join("")}</div>`
      : `<p class="mutewhy2">${copyHtml("이 기기에서 본 이름표 중에는 없어요. 이야기 아이디를 알면 붙여 넣어 찾아요.")}</p>`;
    const how = asked < 0 ? `<p class="meta">${copyHtml("찾는 중")}</p>`
      : asked === 0 ? `<p class="mutewhy2">${copyHtml("이 기기에서 본 글 안에서만 찾았어요. 지금 쓰는 릴레이는 낱말 찾기를 지원하지 않아요.")}</p>`
      : `<p class="mutewhy2">${esc(tf("낱말 찾기를 지원하는 릴레이 {0}곳에도 물었어요.", String(asked)))}</p>`;
    const rows = noteRows(notes);
    out.innerHTML = `<p class="mutewhy"><b>${copyHtml("사람")}</b></p>${peopleHtml}<p class="mutewhy"><b>${copyHtml("글")}</b></p>${how}` +
      (rows ? `<div class="tk-nlist">${rows}</div>` : asked < 0 ? "" : `<p class="mutenone">${copyHtml("찾은 글이 없어요.")}</p>`);
    void fillNip05(out);
  };
  paint(-1);
  try {
    const r = await h.invoke<any>("talk_search", { text: q.text });
    const more: any[] = Array.isArray(r?.notes) ? r.notes : [];
    rememberNotes(more);
    // 릴레이 찾기 답은 그 릴레이의 판단(낱말이 글에 그대로 없을 수도 있다)이라 다시 거르지 않고 합친다.
    notes = [...new Map([...notes, ...more].map((e) => [String(e.id), e] as const)).values()].sort((a, b) => Number(b.created_at || 0) - Number(a.created_at || 0));
    await h.loadNames(notes.map((e) => String(e.pubkey || "")).slice(0, 50));
    if (live()) paint(Number(r?.asked || 0));
  } catch {
    if (live()) paint(0);
  }
}

// ── 내 글 모두 받기 · 다른 Nostr 앱에서 보기 ────────────────────────
export function openMyData(which: "export" | "elsewhere") {
  const box = $("tk-mydatabox");
  if (!box || !host) return;
  const h = host;
  const me = h.me();
  const npub = npubOf(me);
  box.hidden = false;
  box.innerHTML = which === "export"
    ? `<p class="mutewhy"><b>${ICON_FILE} ${copyHtml("내 글 모두 받기")}</b></p>
       <p class="mutewhy2">${copyHtml("내 이름표·글·팔로우·릴레이 목록·북마크를 한 파일로 받아요. 서명된 원본이라 다른 앱이나 도구에서도 읽어요.")}</p>
       <p class="mutewhy2">${copyHtml("복구 단어와 열쇠는 들어가지 않아요. 북마크는 잠긴 채로 들어가요(같은 12단어로만 열려요). 지우기 요청한 글은 빼요.")}</p>
       <div class="muterow2"><button type="button" id="tk-exportgo">${copyHtml("파일로 받기")}</button><button class="ghost" type="button" data-tk-close="tk-mydatabox">${copyHtml("닫기")}</button></div>
       <p class="meta" id="tk-exportsay" role="status"></p>`
    : `<p class="mutewhy"><b>${ICON_PEOPLE} ${copyHtml("다른 앱에서 보기")}</b></p>
       <p class="mutewhy2">${copyHtml("damus·primal 같은 다른 앱(Nostr 방식)에서 아래 내 이야기 아이디를 찾으면 내 이름표와 글이 보여요. 팔로우 목록도 같아요.")}</p>
       <p><code class="tk-npub" translate="no">${esc(npub)}</code></p>
       <div class="muterow2"><button type="button" id="tk-npubcopy">${copyHtml("이야기 아이디 복사")}</button><button class="ghost" type="button" data-tk-close="tk-mydatabox">${copyHtml("닫기")}</button></div>
       <p class="meta" id="tk-npubsay" role="status"></p>
       <p class="moneywarn">${copyHtml("다른 앱에서 내 이름으로 글을 쓰려면 열쇠가 필요해요. 이 화면은 열쇠를 보여 주지 않아요. 열쇠나 복구 단어를 달라는 앱·사람은 조심하세요.")}</p>`;
  const copyBtn = $("tk-npubcopy");
  if (copyBtn) copyBtn.onclick = () => {
    const say = $("tk-npubsay");
    void navigator.clipboard.writeText(npub).then(
      () => { if (say) say.textContent = t("이야기 아이디를 복사했어요."); },
      () => { if (say) say.textContent = t("복사하지 못했어요. 이야기 아이디를 직접 골라 복사해 주세요."); },
    );
  };
  const go = $("tk-exportgo") as HTMLButtonElement | null;
  if (go) go.onclick = async () => {
    const say = $("tk-exportsay");
    let path: string | null = null;
    try { path = await h.pickSave(exportFileName(me)); } catch (e) { if (say) say.textContent = h.errText(e); return; }
    if (!path) return;
    go.disabled = true;
    if (say) say.textContent = t("모으는 중");
    try {
      const r = await h.invoke<any>("talk_export", { path });
      const count = String(r?.count ?? 0), own = Number(r?.from_own || 0);
      if (say) say.innerHTML = `${esc(tf("{0}개를 한 파일에 담았어요.", count))}${own ? " " + esc(tf("내 컴퓨터 릴레이에서 {0}개를 더 찾았어요.", String(own))) : ""} <code translate="no">${esc(String(r?.path || path))}</code>`;
    } catch (e) {
      if (say) say.textContent = h.errText(e);
    } finally {
      go.disabled = false;
    }
  };
  box.scrollIntoView({ block: "nearest" });
}

// ── 연결 ────────────────────────────────────────────────────────
/** 글 목록·패널 안의 링크 단추(@이름·#태그·글 보기)를 한 곳에서 받는다 — 말풍선 누르기(단추 줄 열기)보다 먼저. */
function onLinkClick(ev: Event) {
  const el = (ev.target as HTMLElement | null)?.closest<HTMLElement>("[data-tk-person],[data-tk-tag],[data-tk-note],[data-tk-close]");
  if (!el || !host) return;
  if (el.closest("#tk-noticebox [data-tk-notice]")) return; // 알림 줄은 자기가 연다
  ev.stopPropagation();
  ev.preventDefault();
  if (el.dataset.tkClose) { const b = $(el.dataset.tkClose); if (b) b.hidden = true; $("tk-bell")?.setAttribute("aria-expanded", String(!$("tk-noticebox")?.hidden)); $("tk-searchbtn")?.setAttribute("aria-expanded", String(!$("tk-searchbox")?.hidden)); return; }
  if (el.dataset.tkPerson && HEX64.test(el.dataset.tkPerson)) { const pk = el.dataset.tkPerson; void host.loadNames([pk]).then(() => host?.showPerson(pk)); return; }
  if (el.dataset.tkTag) { openSearch("#" + el.dataset.tkTag); return; }
  if (el.dataset.tkNote) void openNote(el.dataset.tkNote);
}

export function wireTalkSocial(h: TalkSocialHost) {
  host = h;
  const page = $("page-talk") ?? document.body;
  page.addEventListener("click", onLinkClick, true);
  const bell = $("tk-bell");
  if (bell) bell.onclick = () => { if (toggleBox("tk-noticebox", "tk-bell")) { freshKeys = new Set(); void paintNotices(true); void refreshNotices(); } };
  const sb = $("tk-searchbtn");
  if (sb) sb.onclick = () => { if (toggleBox("tk-searchbox", "tk-searchbtn")) { ($("tk-sq") as HTMLInputElement | null)?.focus(); if (!$("tk-sresult")?.innerHTML) void runSearch(""); } };
  const form = $("tk-sform") as HTMLFormElement | null;
  if (form) form.onsubmit = (ev) => { ev.preventDefault(); void runSearch(($("tk-sq") as HTMLInputElement).value); };
  const at = $("tk-at");
  if (at) at.onclick = () => { toggleStickers(false); toggleMention(); };
  const stk = $("tk-stk");
  if (stk) stk.onclick = () => toggleStickers();
  const ex = $("tk-export");
  if (ex) ex.onclick = () => openMyData("export");
  const el = $("tk-elsewhere");
  if (el) el.onclick = () => openMyData("elsewhere");
  // 그림 아이콘을 단추에 넣는다(글자는 index.html 그대로 — 그림만 두지 않는다).
  for (const [id, icon] of [["tk-bell-ico", ICON_BELL], ["tk-search-ico", ICON_SEARCH]] as const) { const s = $(id); if (s) s.innerHTML = icon; }
  paintBell();
  // 11-10: 「연락이 왔어요」 — 어느 화면에 있든 2분마다(이야기 화면이면 1분 반) 알림을 묻는다. 창이 숨어 있으면 쉬고, 다시 보이면 곧바로 한 번.
  setInterval(() => { if (!document.hidden && (host?.active() || Date.now() - noticeAt >= 120_000)) void refreshNotices(); }, 30_000);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) void refreshNotices(); });
}

/** 사람 이름표 칸(오른쪽)이 나일 때 「내 글 모두 받기」·「다른 Nostr 앱에서 보기」를 보인다. */
export function personMineHtml(pk: string): string {
  if (!host || pk !== host.me()) return nip05Slot(pk) ? `<p class="tk-person-nip05">${nip05Slot(pk)}</p>` : "";
  return `<p class="tk-person-nip05">${nip05Slot(pk)}</p><div class="tk-mine-row"><button class="ghost" type="button" data-tk-mydata="export">${copyHtml("내 글 모두 받기")}</button><button class="ghost" type="button" data-tk-mydata="elsewhere">${copyHtml("다른 앱에서 보기")}</button></div>`;
}
export function wirePersonMine(root: HTMLElement) {
  root.querySelectorAll<HTMLElement>("[data-tk-mydata]").forEach((b) => { b.onclick = () => openMyData(b.dataset.tkMydata === "export" ? "export" : "elsewhere"); });
  void fillNip05(root);
}
