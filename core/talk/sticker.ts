/**
 * 라비 이모티콘 16종 — 이야기(방 글·쪽지)와 이름표 사진에 쓴다. 무료·기본 제공.
 *
 * 규약(3모델 검토로 정한 것):
 *   - 글 안에서는 짧은 이름 `:ravi_love:` 으로 적고, NIP-30 사용자 이모지 표 `["emoji", "ravi_love", 주소]` 를 붙인다.
 *     그래서 damus·primal 같은 다른 Nostr 앱도 같은 그림으로 그린다.
 *   - 주소는 같은 도메인(https://ravenvault.ex.erci.se/emoji/) — 웹 지갑 CSP(img-src 'self')가 그대로 허락한다.
 *   - 우리 앱은 표의 주소를 **믿지도 받지도 않는다.** 짧은 이름으로 앱에 들어 있는 그림을 그린다(남의 주소 = 추적 픽셀일 수 있다).
 *   - 모르는 짧은 이름은 그냥 글자로 둔다.
 * 그림 파일: phone/assets/ravi-stickers/<이름>.webp(앱 내장 256px) · release-site/emoji/<이름>.webp(공개 512px).
 */

export const EMOJI_BASE = 'https://ravenvault.ex.erci.se/emoji/';

/** 순서 = 고르기 칸(4x4) 순서. name 은 한국어 원문(화면에서 말()로 번역). */
export const RAVI_STICKERS = [
  { code: 'ravi_hello', name: '안녕' },
  { code: 'ravi_thanks', name: '고마워요' },
  { code: 'ravi_like', name: '좋아요' },
  { code: 'ravi_love', name: '사랑해요' },
  { code: 'ravi_congrats', name: '축하해요' },
  { code: 'ravi_laugh', name: '웃겨요' },
  { code: 'ravi_sad', name: '슬퍼요' },
  { code: 'ravi_angry', name: '화나요' },
  { code: 'ravi_surprised', name: '놀라요' },
  { code: 'ravi_curious', name: '궁금해요' },
  { code: 'ravi_cheer', name: '응원해요' },
  { code: 'ravi_sorry', name: '미안해요' },
  { code: 'ravi_goodnight', name: '잘 자요' },
  { code: 'ravi_gift', name: '선물이에요' },
  { code: 'ravi_waiting', name: '기다려요' },
  { code: 'ravi_ok', name: '알겠어요' },
] as const;

export type RaviStickerCode = (typeof RAVI_STICKERS)[number]['code'];
const CODES = new Set<string>(RAVI_STICKERS.map(s => s.code));

export function isRaviSticker(code: string): code is RaviStickerCode { return CODES.has(code); }
export function stickerName(code: RaviStickerCode): string { return RAVI_STICKERS.find(s => s.code === code)!.name; }
/** 공개 주소(다른 Nostr 앱·이름표 사진용). */
export function stickerUrl(code: RaviStickerCode): string { return `${EMOJI_BASE}${code}.webp`; }
/** 글에 넣는 짧은 이름. */
export function stickerText(code: RaviStickerCode): string { return `:${code}:`; }
/** 쓰던 글 끝에 이모티콘을 붙인다(11-06 대표: 누르면 바로 보내지 말고 입력칸에 — 글과 섞어 쓴다). */
export function addSticker(draft: string, code: RaviStickerCode): string {
  return draft && !/\s$/.test(draft) ? `${draft} ${stickerText(code)}` : `${draft}${stickerText(code)}`;
}

// NIP-30 짧은 이름: 영문·숫자·밑줄. 앞뒤 콜론.
const SHORTCODE = /:([A-Za-z0-9_]{1,40}):/g;

/** 글 속 라비 짧은 이름마다 emoji 표 하나(같은 것은 한 번, 많아야 16개). 모르는 이름은 표를 만들지 않는다. */
export function stickerTags(text: string): string[][] {
  const out: string[][] = [], seen = new Set<string>();
  for (const m of text.matchAll(SHORTCODE)) {
    const code = m[1];
    if (!isRaviSticker(code) || seen.has(code)) continue;
    seen.add(code); out.push(['emoji', code, stickerUrl(code)]);
  }
  return out;
}

/** 글 전체가 라비 이모티콘 하나뿐이면 그 이름(크게 그린다). 아니면 null. */
export function stickerOnly(text: string): RaviStickerCode | null {
  const m = /^:([A-Za-z0-9_]{1,40}):$/.exec(text.trim());
  return m && isRaviSticker(m[1]) ? m[1] : null;
}

export type TextPart = { kind: 'text'; text: string } | { kind: 'sticker'; code: RaviStickerCode };
/** 글 → 글 조각·이모티콘 조각(글 안에 섞인 것은 작게 그린다). 모르는 짧은 이름은 글 조각 그대로. */
export function stickerParts(text: string): TextPart[] {
  const parts: TextPart[] = [];
  let at = 0;
  const push = (t: string) => { if (!t) return; const last = parts[parts.length - 1]; if (last?.kind === 'text') last.text += t; else parts.push({ kind: 'text', text: t }); };
  for (const m of text.matchAll(SHORTCODE)) {
    if (!isRaviSticker(m[1])) continue;
    push(text.slice(at, m.index));
    parts.push({ kind: 'sticker', code: m[1] });
    at = m.index! + m[0].length;
  }
  push(text.slice(at));
  return parts;
}

/** 이름표 사진 주소 → 라비 이름. 우리 주소의 라비 그림만 받는다(모르는 바깥 주소는 null — 그리지 않는다). */
export function raviPictureCode(url: unknown): RaviStickerCode | null {
  if (typeof url !== 'string' || !url.startsWith(EMOJI_BASE)) return null;
  const m = /^([a-z_]{1,40})\.webp$/.exec(url.slice(EMOJI_BASE.length));
  return m && isRaviSticker(m[1]) ? m[1] : null;
}
