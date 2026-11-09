// 11-09 이야기 글 속 링크·찾기·알림 기록 — 폰 core/talk/{npub,links,search,notify}.ts 와 같은 규칙(순수 로직).
//
// - 읽기: noteSegments 가 글을 조각으로 나눈다. 화면은 사람 조각을 「@이름」, 글 조각을 「글 보기」 단추로 그린다.
// - 쓰기: applyMentions 가 글쓰기 칸의 「@이름」(고른 사람만)을 nostr:npub… 로 바꾼다. t·p 표는 러스트(talk_social.rs)가 단다.
// - nsec(열쇠)는 링크로 읽지 않는다.

const CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
const HEX64 = /^[a-f0-9]{64}$/;

function polymod(values: number[]): number {
  let chk = 1;
  for (const v of values) {
    const top = chk >> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) if ((top >> i) & 1) chk ^= GEN[i];
  }
  return chk;
}
const expand = (hrp: string) => [...[...hrp].map((c) => c.charCodeAt(0) >> 5), 0, ...[...hrp].map((c) => c.charCodeAt(0) & 31)];
function convert(data: number[], from: number, to: number, pad: boolean): number[] | null {
  let acc = 0, bits = 0;
  const out: number[] = [], max = (1 << to) - 1;
  for (const v of data) {
    acc = ((acc << from) | v) & 0xffffff; bits += from;
    while (bits >= to) { bits -= to; out.push((acc >> bits) & max); }
  }
  if (pad) { if (bits) out.push((acc << (to - bits)) & max); }
  else if (bits >= from || ((acc << (to - bits)) & max)) return null;
  return out;
}
const hexOf = (b: number[]) => b.map((x) => x.toString(16).padStart(2, "0")).join("");
function bech32Decode(raw: string): { hrp: string; bytes: number[] } | null {
  const s = raw.trim().toLowerCase();
  if (s.length < 8 || s.length > 1000) return null;
  const at = s.lastIndexOf("1");
  if (at < 1) return null;
  const hrp = s.slice(0, at), data = [...s.slice(at + 1)].map((c) => CHARSET.indexOf(c));
  if (data.length < 6 || data.some((v) => v < 0) || polymod([...expand(hrp), ...data]) !== 1) return null;
  const bytes = convert(data.slice(0, -6), 5, 8, false);
  return bytes ? { hrp, bytes } : null;
}

/** 공개키(16진수) → npub1…(다른 Nostr 앱에 붙여 넣는 모양). */
export function npubOf(pubHex: string): string {
  if (!HEX64.test(pubHex)) return "";
  const data = convert(pubHex.match(/../g)!.map((h) => parseInt(h, 16)), 8, 5, true)!;
  const mod = polymod([...expand("npub"), ...data, 0, 0, 0, 0, 0, 0]) ^ 1;
  const check = Array.from({ length: 6 }, (_, i) => (mod >> (5 * (5 - i))) & 31);
  return "npub1" + [...data, ...check].map((v) => CHARSET[v]).join("");
}

export type Nip19 = { type: "person"; pubkey: string } | { type: "note"; id: string; author: string };
/** npub·nprofile·note·nevent(앞에 「nostr:」 있어도 됨) → 뜻. nsec 등 다른 것·틀린 것은 null. */
export function decodeNip19(raw: string): Nip19 | null {
  const d = bech32Decode(raw.trim().replace(/^nostr:/i, ""));
  if (!d) return null;
  if (d.hrp === "npub" || d.hrp === "note") {
    if (d.bytes.length !== 32) return null;
    return d.hrp === "npub" ? { type: "person", pubkey: hexOf(d.bytes) } : { type: "note", id: hexOf(d.bytes), author: "" };
  }
  if (d.hrp !== "nprofile" && d.hrp !== "nevent") return null;
  let main: number[] | null = null, author: number[] | null = null;
  for (let i = 0; i < d.bytes.length;) {
    const t = d.bytes[i], l = d.bytes[i + 1];
    if (l === undefined || i + 2 + l > d.bytes.length) return null;
    const v = d.bytes.slice(i + 2, i + 2 + l);
    if (t === 0 && !main) main = v;
    else if (t === 2 && !author) author = v;
    i += 2 + l;
  }
  if (!main || main.length !== 32) return null;
  if (d.hrp === "nprofile") return { type: "person", pubkey: hexOf(main) };
  return { type: "note", id: hexOf(main), author: author && author.length === 32 ? hexOf(author) : "" };
}

export type NoteSegment =
  | { kind: "text"; text: string }
  | { kind: "person"; pubkey: string; raw: string }
  | { kind: "note"; id: string; raw: string }
  | { kind: "tag"; tag: string; raw: string };

const LINK = /(?:nostr:)?\b(?:npub1|nprofile1|note1|nevent1)[02-9ac-hj-np-z]{20,600}\b/gi;
/** 해시태그: 맨 앞이나 띄어쓰기·괄호 뒤의 #, 글자·숫자·_ 1~50자(한글 포함). 숫자만은 해시태그로 보지 않는다. */
const TAG = /(^|[\s(（\[{,.!?·])#([\p{L}\p{N}_]{1,50})/gu;

/** 글 → 조각. 모양이 틀린 링크는 글자 그대로 둔다(폰 noteSegments 와 같다). */
export function noteSegments(text: string): NoteSegment[] {
  const marks: { at: number; end: number; seg: NoteSegment }[] = [];
  for (const m of text.matchAll(LINK)) {
    const d = decodeNip19(m[0]);
    if (!d) continue;
    const seg: NoteSegment = d.type === "person" ? { kind: "person", pubkey: d.pubkey, raw: m[0] } : { kind: "note", id: d.id, raw: m[0] };
    marks.push({ at: m.index!, end: m.index! + m[0].length, seg });
  }
  for (const m of text.matchAll(TAG)) {
    const word = m[2];
    if (/^\p{N}+$/u.test(word)) continue;
    const at = m.index! + m[1].length, end = at + 1 + word.length;
    if (marks.some((x) => at < x.end && end > x.at)) continue;
    marks.push({ at, end, seg: { kind: "tag", tag: word.toLowerCase(), raw: "#" + word } });
  }
  marks.sort((a, b) => a.at - b.at);
  const out: NoteSegment[] = [];
  let pos = 0;
  for (const m of marks) {
    if (m.at < pos) continue;
    if (m.at > pos) out.push({ kind: "text", text: text.slice(pos, m.at) });
    out.push(m.seg); pos = m.end;
  }
  if (pos < text.length) out.push({ kind: "text", text: text.slice(pos) });
  return out;
}

/** 글쓰기 칸의 「@이름」 → nostr:npub…. 고른 사람(picks)만, 긴 이름부터 바꾼다. */
export function applyMentions(text: string, picks: { name: string; pubkey: string }[]): string {
  let out = text;
  const list = [...picks].filter((p) => p.name && HEX64.test(p.pubkey)).sort((a, b) => b.name.length - a.name.length);
  for (const p of list) out = out.split("@" + p.name).join("nostr:" + npubOf(p.pubkey));
  return out;
}

export type SearchInput =
  | { kind: "empty" }
  | { kind: "person"; pubkey: string }
  | { kind: "note"; id: string }
  | { kind: "tag"; tag: string }
  | { kind: "text"; text: string };
/** 찾기 칸 → 무엇을 찾을지(폰 readSearch 와 같다). */
export function readSearch(raw: string): SearchInput {
  const s = raw.trim();
  if (!s) return { kind: "empty" };
  if (/^(nostr:)?[a-f0-9]{64}$/i.test(s)) return { kind: "person", pubkey: s.replace(/^nostr:/i, "").toLowerCase() };
  const d = decodeNip19(s);
  if (d) return d.type === "person" ? { kind: "person", pubkey: d.pubkey } : { kind: "note", id: d.id };
  const tag = /^#([\p{L}\p{N}_]{1,50})$/u.exec(s);
  if (tag) return { kind: "tag", tag: tag[1].toLowerCase() };
  return { kind: "text", text: s.slice(0, 100) };
}
const fold = (s: string) => s.normalize("NFC").toLowerCase();
export type Person = { pubkey: string; name: string; about: string };
/** 이름·소개에 낱말이 든 사람(이름 앞부분이 맞으면 먼저). */
export function matchPeople(people: readonly Person[], q: string, max = 30): Person[] {
  const k = fold(q.trim().replace(/^@/, ""));
  if (!k) return [];
  return people.filter((p) => fold(p.name).includes(k) || fold(p.about).includes(k))
    .sort((a, b) => Number(fold(b.name).startsWith(k)) - Number(fold(a.name).startsWith(k)) || Number(fold(b.name).includes(k)) - Number(fold(a.name).includes(k)))
    .slice(0, max);
}
type Ev = { id?: unknown; content?: unknown; created_at?: unknown };
/** 글에 낱말이 든 것(최신이 앞, 같은 글 한 번). */
export function matchNotes<T extends Ev>(notes: readonly T[], q: string, max = 100): T[] {
  const k = fold(q.trim());
  if (!k) return [];
  const seen = new Set<string>();
  return notes.filter((n) => { const id = String(n.id || ""); if (!id || seen.has(id)) return false; seen.add(id); return fold(String(n.content || "")).includes(k); })
    .sort((a, b) => Number(b.created_at || 0) - Number(a.created_at || 0)).slice(0, max);
}

// ── 알림 「본 것」 기록(폰 core/talk/notify.ts 의 firstSeen·markSeen 과 같다) ──
export type NoticeKind = "reply" | "mention" | "follow";
export type TalkNotice = { key: string; kind: NoticeKind; pubkey: string; at: number; noteId: string; text: string };
export type NoticeSeen = { seenAt: number; known: string[] };
export const FIRST_LOOK_BACK_SEC = 3 * 86_400;
const MAX_KNOWN = 2000;
/** 처음 쓰는 기록 — 지금 팔로워는 모두 본 것으로, 답글은 사흘 안 것만 새것으로(처음 열자마자 숫자가 쏟아지지 않게). */
export function firstSeen(list: readonly TalkNotice[], now: number): NoticeSeen {
  return { seenAt: now - FIRST_LOOK_BACK_SEC, known: list.filter((n) => n.kind === "follow").map((n) => n.pubkey) };
}
/** 새것인가 — 답글·부름은 본 시각 뒤, 팔로우는 아직 본 적 없는 사람(kind 3 은 시각이 늘 바뀌어 시각으로 가리면 틀린다). */
export function isUnread(n: TalkNotice, seen: NoticeSeen): boolean {
  return n.kind === "follow" ? !seen.known.includes(n.pubkey) : n.at > seen.seenAt;
}
export function markSeen(seen: NoticeSeen | null, list: readonly TalkNotice[], now: number): NoticeSeen {
  const known = [...new Set([...(seen?.known ?? []), ...list.filter((n) => n.kind === "follow").map((n) => n.pubkey)])].slice(-MAX_KNOWN);
  return { seenAt: Math.max(now, seen?.seenAt ?? 0), known };
}
export function cleanSeen(v: unknown): NoticeSeen | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  if (typeof o.seenAt !== "number" || !Number.isFinite(o.seenAt) || !Array.isArray(o.known)) return null;
  return { seenAt: o.seenAt, known: o.known.filter((x): x is string => typeof x === "string" && HEX64.test(x)).slice(-MAX_KNOWN) };
}

/** 파일 이름: ravenvault-nostr-<npub 끝 6>-<YYYY-MM-DD>.json (폰 exportFileName 과 같다). */
export function exportFileName(pubHex: string, nowMs = Date.now()): string {
  return `ravenvault-nostr-${npubOf(pubHex).slice(-6)}-${new Date(nowMs).toISOString().slice(0, 10)}.json`;
}
