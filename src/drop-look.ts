import type { ContentType } from '../core/creator/limits';
import { copy, type CopyKey, type DropLang } from './drop-copy';
import type { MusicFormat } from './drop-detect';

/*
 * 판매 페이지 꾸미기 — 템플릿(모양) 7종 × 색 7종. 🔴 사용자는 「값만 고른다」.
 *
 *   · 템플릿·색은 앱이 가진 고정 부품이다. 사용자 HTML·CSS·JS 는 어디에도 받지 않는다(매니페스트에도 없다).
 *   · 글은 전부 textContent 로만 그린다(이스케이프가 아니라 애초에 HTML 로 해석하지 않는다).
 *   · 그림 주소는 blob:·data:image(png/jpeg/webp/gif)·이 컴퓨터 IPFS 게이트웨이(127.0.0.1:8080/ipfs/Qm…)만 받는다.
 *   · 신뢰 띠(「보증 · 미검증」 배지 + 경고)는 템플릿 바깥에서 고정 색으로 맨 위에 그린다 — 템플릿·색이 가릴 수 없다.
 *   · 색 7종은 본문·흐린 글·강조 글 모두 대비 4.5:1 이상(시험: scripts/drop-publish.test.mjs).
 */

export type TemplateId = 'album' | 'single' | 'book' | 'gallery' | 'event' | 'shop' | 'basic';
export type ThemeId = 'auto' | 'paper' | 'night' | 'forest' | 'sunset' | 'ocean' | 'mono';
export type PageKind = ContentType | 'shop';

export const TEMPLATE_IDS: readonly TemplateId[] = ['album', 'single', 'book', 'gallery', 'event', 'shop', 'basic'];
export const THEME_IDS: readonly ThemeId[] = ['auto', 'paper', 'night', 'forest', 'sunset', 'ocean', 'mono'];

/** 템플릿마다 쓸 수 있는 종류. 「기본형」은 모두. 가게(shop)는 RV.S. 종류 글자가 정해지기 전까지 미리보기 전용. */
export const TEMPLATES: Readonly<Record<TemplateId, { label: string; kinds: readonly PageKind[] }>> = Object.freeze({
  album: { label: '음악 앨범 표지형', kinds: ['music'] },
  single: { label: '싱글 한 곡형', kinds: ['music'] },
  book: { label: '책 표지형', kinds: ['book'] },
  gallery: { label: '스크린샷 갤러리형', kinds: ['game', 'digital'] },
  event: { label: '행사 카드형', kinds: ['ticket'] },
  shop: { label: '가게 메뉴형', kinds: ['shop'] },
  basic: { label: '간단 기본형', kinds: ['game', 'music', 'book', 'ticket', 'digital', 'shop'] },
});
export type Theme = { label: string; bg: string; surface: string; ink: string; muted: string; accent: string; onAccent: string };
/** 'auto' 는 앱 색(라이트·다크)을 따른다 — 값은 CSS 변수라 대비 시험은 화면 하네스가 한다. */
export const THEMES: Readonly<Record<Exclude<ThemeId, 'auto'>, Theme>> = Object.freeze({
  paper: { label: '종이', bg: '#FBF8F2', surface: '#FFFFFF', ink: '#1B1A17', muted: '#5C574D', accent: '#8A3B12', onAccent: '#FFFFFF' },
  night: { label: '밤', bg: '#0E1117', surface: '#171B24', ink: '#EEF0F5', muted: '#A9B0C0', accent: '#F0A35E', onAccent: '#1A1205' },
  forest: { label: '숲', bg: '#EEF3EC', surface: '#FFFFFF', ink: '#15241A', muted: '#46584B', accent: '#1F5E3A', onAccent: '#FFFFFF' },
  sunset: { label: '노을', bg: '#2A1420', surface: '#3A1C2C', ink: '#FFF1E8', muted: '#E8C3B5', accent: '#FFB37A', onAccent: '#2A1206' },
  ocean: { label: '바다', bg: '#E9F2F8', surface: '#FFFFFF', ink: '#0F2233', muted: '#3F5668', accent: '#0B5C8C', onAccent: '#FFFFFF' },
  mono: { label: '흑백', bg: '#FFFFFF', surface: '#F2F2F2', ink: '#000000', muted: '#4A4A4A', accent: '#000000', onAccent: '#FFFFFF' },
});
export const THEME_LABEL = (id: ThemeId) => id === 'auto' ? '앱 색 따라가기' : THEMES[id].label;

/** 종류(와 음악 형식)에 맞는 기본 템플릿. */
export function defaultTemplate(kind: PageKind, format: MusicFormat | null = null): TemplateId {
  if (kind === 'music') return format === 'single' ? 'single' : 'album';
  return kind === 'book' ? 'book' : kind === 'game' ? 'gallery' : kind === 'ticket' ? 'event' : kind === 'shop' ? 'shop' : 'basic';
}
export const templatesFor = (kind: PageKind): TemplateId[] => TEMPLATE_IDS.filter(t => TEMPLATES[t].kinds.includes(kind));

/* ── 꾸밈 데이터(매니페스트에 실리는 안전한 칸) ─────────────────────────── */

/** 그림은 경로로만 가리킨다 — 경로는 매니페스트 files/cover/look.images 의 항목(CID·SHA-256·크기 포함)이어야 한다. */
/** 태그는 장르 칸(drop-genre.ts genre.tags, 3개까지)에 있다 — 꾸밈이 아니라 찾기용이라서. */
export type Look = { template: TemplateId; theme: ThemeId; tagline: string; coverImage: string | null; background: string | null; gallery: string[] };
export const LOOK_LIMITS = Object.freeze({ tagline: 80, tags: 3, tag: 20, gallery: 8, images: 8 });

/** core/creator/manifest.ts 의 글자 규칙과 같다(NFC, 제어 문자·양방향 덮어쓰기 문자 금지 — 이름 사칭 방지). */
export const safeText = (s: unknown, min: number, max: number): s is string =>
  typeof s === 'string' && s.length >= min && s.length <= max && s === s.normalize('NFC') && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f‪-‮⁦-⁩]/.test(s);

export class LookError extends Error { constructor(readonly detail: string) { super('look: ' + detail); this.name = 'LookError'; } }

/**
 * 꾸밈 칸 엄격 검사. 모르는 칸·빠진 칸·틀린 값은 전부 거절. images = 이 상품에서 그림으로 쓸 수 있는 경로 집합.
 * kind 가 템플릿이 받지 않는 종류면 거절(음악 템플릿에 책을 담아 음악처럼 보이게 하는 것을 막는다).
 */
export function validateLook(raw: unknown, kind: PageKind, images: ReadonlySet<string>): Look {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new LookError('shape');
  const o = raw as Record<string, unknown>;
  if (Object.keys(o).sort().join() !== 'background,coverImage,gallery,tagline,template,theme') throw new LookError('keys');
  if (!TEMPLATE_IDS.includes(o.template as TemplateId)) throw new LookError('template');
  if (!TEMPLATES[o.template as TemplateId].kinds.includes(kind)) throw new LookError('template-kind');
  if (!THEME_IDS.includes(o.theme as ThemeId)) throw new LookError('theme');
  if (!safeText(o.tagline, 0, LOOK_LIMITS.tagline) || (o.tagline as string).trim() !== o.tagline) throw new LookError('tagline');
  const img = (p: unknown) => p === null || (typeof p === 'string' && images.has(p));
  if (!img(o.coverImage) || !img(o.background)) throw new LookError('image-ref');
  if (!Array.isArray(o.gallery) || o.gallery.length > LOOK_LIMITS.gallery || !o.gallery.every(p => typeof p === 'string' && images.has(p)) || new Set(o.gallery).size !== o.gallery.length) throw new LookError('gallery');
  return { template: o.template as TemplateId, theme: o.theme as ThemeId, tagline: o.tagline as string, coverImage: o.coverImage as string | null, background: o.background as string | null, gallery: [...o.gallery as string[]] };
}

/** 사람이 적은 태그 한 줄 → 규칙에 맞춘 목록(앞뒤 공백·#·중복 제거, 3개·20자까지 — 장르 태그). */
export function parseTags(line: string): string[] {
  const out: string[] = [];
  for (const raw of String(line ?? '').split(/[,，、]/)) {
    const t = raw.replace(/[#<>]/g, '').trim().normalize('NFC').slice(0, LOOK_LIMITS.tag).trim();
    if (t && safeText(t, 1, LOOK_LIMITS.tag) && !out.some(x => x.toLowerCase() === t.toLowerCase())) out.push(t);
    if (out.length >= LOOK_LIMITS.tags) break;
  }
  return out;
}

/* ── 그리기 ─────────────────────────────────────────────────────────── */

export type Trust = 'unverified' | 'bonded' | 'verified';
export type StoreTrack = { title: string; durationMs: number | null; previewUrl: string | null };
export type StoreModel = {
  kind: PageKind; title: string; description: string; assetName: string; priceRvn: string | null;
  format?: MusicFormat | null; tracks?: StoreTrack[];
  coverUrl: string | null; backgroundUrl: string | null; galleryUrls: string[];
  book?: { format: 'pdf' | 'epub'; pageCount: number | null; previewPages: number } | null;
  ticket?: { eventName: string; startsAt: string; venue: string; quantity: number } | null;
  shopItems?: Array<{ title: string; priceRvn: string | null; assetName: string }>;
  trust: Trust; officialLooking: boolean; similar: string[];
};

const GATEWAY = /^http:\/\/127\.0\.0\.1:8080\/ipfs\/Qm[1-9A-HJ-NP-Za-km-z]{44}$/;
/** 그림 주소로 받을 수 있는가(그 밖의 주소 — javascript:·외부 http 등 — 는 그리지 않는다). */
export function safeImageUrl(u: unknown): u is string {
  return typeof u === 'string' && (/^blob:[a-z0-9:/._%-]+$/i.test(u) || /^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(u) || GATEWAY.test(u));
}
const safeAudioUrl = (u: unknown): u is string => typeof u === 'string' && (/^blob:[a-z0-9:/._%-]+$/i.test(u) || GATEWAY.test(u));

type Make = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string) => HTMLElementTagNameMap[K];
const maker = (doc: Document): Make => (tag, cls, text) => {
  const e = doc.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e;
};
const mmss = (ms: number | null) => ms === null || !Number.isFinite(ms) ? '' : `${Math.floor(ms / 60000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}`;

/**
 * 판매 페이지 한 장을 DOM 으로 만든다(innerHTML 없음). 판매자 미리보기와 구매자 화면이 같은 함수를 쓴다.
 * look 이 이상하면(검사 전 값) 기본형·앱 색으로 그린다.
 */
export function renderStorefront(model: StoreModel, look: Pick<Look, 'template' | 'theme' | 'tagline'> & { tags: string[]; genre?: string }, opts: { lang?: DropLang; doc?: Document; say?: (k: CopyKey, v?: Record<string, string | number>) => string } = {}): HTMLElement {
  const doc = opts.doc ?? document, h = maker(doc), lang = opts.lang ?? 'ko';
  const say = opts.say ?? ((k: CopyKey, v?: Record<string, string | number>) => copy(lang, k, v));
  const template = TEMPLATE_IDS.includes(look.template) && TEMPLATES[look.template].kinds.includes(model.kind) ? look.template : 'basic';
  const theme = THEME_IDS.includes(look.theme) ? look.theme : 'auto';
  const root = h('article', 'rvs');
  root.dataset.template = template; root.dataset.theme = theme; root.lang = lang;
  root.setAttribute('aria-label', say('previewHead'));
  if (theme !== 'auto') {
    const t = THEMES[theme];
    for (const [k, v] of Object.entries({ bg: t.bg, surface: t.surface, ink: t.ink, muted: t.muted, accent: t.accent, 'on-accent': t.onAccent })) root.style.setProperty(`--rvs-${k}`, v);
  }

  // 🔴 신뢰 띠: 템플릿 바깥·맨 위·고정 색. 검증됨이 아니면 늘 경고가 같이 나온다.
  const trust = h('div', 'rvs-trust'); trust.setAttribute('role', 'note'); trust.dataset.trust = model.trust;
  trust.append(h('strong', 'rvs-badge', model.trust === 'verified' ? say('verifiedBadge') : say('unverifiedBadge')));
  if (model.trust !== 'verified') trust.append(h('span', 'rvs-trust-say', say('unverifiedWarning')));
  if (model.officialLooking) trust.append(h('span', 'rvs-trust-say', say('officialWarning')));
  if (model.similar.length) trust.append(h('span', 'rvs-trust-say', say('similarWarning', { names: model.similar.slice(0, 3).join(', ') })));
  root.append(trust);

  const body = h('div', 'rvs-body');
  if (model.backgroundUrl && safeImageUrl(model.backgroundUrl)) {
    const bg = h('img', 'rvs-bgimg'); bg.alt = ''; bg.src = model.backgroundUrl; bg.setAttribute('aria-hidden', 'true'); body.append(bg);
  }
  const cover = (cls = 'rvs-cover') => {
    if (model.coverUrl && safeImageUrl(model.coverUrl)) { const i = h('img', cls); i.src = model.coverUrl; i.alt = model.title; return i; }
    const ph = h('div', cls + ' rvs-ph'); ph.setAttribute('role', 'img'); ph.setAttribute('aria-label', model.title);
    ph.append(h('span', '', kindLabel(model, say))); return ph;
  };
  const head = () => {
    const box = h('div', 'rvs-head');
    box.append(h('span', 'rvs-kind', kindLabel(model, say)));
    const t = h('h3', 'rvs-title', model.title); t.setAttribute('translate', 'no'); box.append(t);
    if (look.tagline) { const p = h('p', 'rvs-tagline', look.tagline); p.setAttribute('translate', 'no'); box.append(p); }
    const row = h('div', 'rvs-row');
    row.append(h('span', 'rvs-price', model.priceRvn ? `${model.priceRvn} RVN` : say('free')));
    const name = h('code', 'rvs-asset', model.assetName); name.setAttribute('translate', 'no'); row.append(name);
    box.append(row);
    if (look.tags.length || look.genre) {
      const ul = h('ul', 'rvs-tags'); ul.setAttribute('aria-label', 'tags');
      if (look.genre) ul.append(h('li', 'rvs-genre', look.genre));
      for (const tag of look.tags.slice(0, LOOK_LIMITS.tags)) { const li = h('li', '', tag); li.setAttribute('translate', 'no'); ul.append(li); }
      box.append(ul);
    }
    return box;
  };
  const desc = () => {
    const box = h('div', 'rvs-desc'); box.setAttribute('translate', 'no');
    for (const line of model.description.split(/\n{2,}|\r\n\r\n/).map(s => s.trim()).filter(Boolean).slice(0, 20)) box.append(h('p', '', line));
    return box;
  };
  const trackList = () => {
    const ol = h('ol', 'rvs-tracks'); ol.setAttribute('aria-label', say('tracks'));
    (model.tracks ?? []).forEach((tr, i) => {
      const li = h('li'); li.append(h('span', 'rvs-tn', String(i + 1)), Object.assign(h('span', 'rvs-tt', tr.title), { translate: false }), h('span', 'rvs-td', mmss(tr.durationMs)));
      if (tr.previewUrl && safeAudioUrl(tr.previewUrl)) {
        const a = h('audio'); a.controls = true; a.preload = 'none'; a.src = tr.previewUrl; a.setAttribute('aria-label', `${say('previewListen')} — ${tr.title}`); li.append(a);
      }
      ol.append(li);
    });
    return ol;
  };

  if (template === 'album') {
    const top = h('div', 'rvs-split'); top.append(cover(), head()); body.append(top, trackList(), desc());
  } else if (template === 'single') {
    const c = h('div', 'rvs-center'); c.append(cover('rvs-cover rvs-cover-big'), head());
    const first = model.tracks?.[0];
    if (first?.previewUrl && safeAudioUrl(first.previewUrl)) { const a = h('audio', 'rvs-player'); a.controls = true; a.preload = 'none'; a.src = first.previewUrl; a.setAttribute('aria-label', `${say('previewListen')} — ${first.title}`); c.append(a); }
    body.append(c, desc());
  } else if (template === 'book') {
    const top = h('div', 'rvs-split'); top.append(cover('rvs-cover rvs-cover-tall'), head());
    const b = model.book;
    if (b) {
      const facts = h('ul', 'rvs-facts');
      facts.append(h('li', '', b.format.toUpperCase()));
      if (b.pageCount) facts.append(h('li', '', say('pages', { n: b.pageCount })));
      if (b.previewPages) facts.append(h('li', '', say('previewPages', { n: b.previewPages })));
      top.querySelector('.rvs-head')?.append(facts);
    }
    body.append(top, desc());
  } else if (template === 'gallery') {
    const urls = model.galleryUrls.filter(safeImageUrl).slice(0, LOOK_LIMITS.gallery);
    const hero = h('div', 'rvs-hero');
    if (urls[0]) { const i = h('img', 'rvs-shot rvs-shot-hero'); i.src = urls[0]; i.alt = model.title; hero.append(i); } else hero.append(cover('rvs-cover rvs-cover-wide'));
    body.append(hero, head());
    if (urls.length > 1) {
      const grid = h('div', 'rvs-grid');
      urls.slice(1).forEach((u, i) => { const im = h('img', 'rvs-shot'); im.src = u; im.alt = `${model.title} ${i + 2}`; im.loading = 'lazy'; grid.append(im); });
      body.append(grid);
    }
    body.append(desc());
  } else if (template === 'event') {
    const t = model.ticket, d = t ? new Date(t.startsAt) : null, ok = d && Number.isFinite(d.getTime());
    const card = h('div', 'rvs-event');
    const date = h('div', 'rvs-date'); date.setAttribute('aria-hidden', 'true');
    date.append(h('span', 'rvs-month', ok ? d!.toLocaleDateString(lang, { month: 'short' }) : '—'), h('span', 'rvs-day', ok ? String(d!.getDate()) : '—'));
    const info = head();
    if (t) {
      const facts = h('ul', 'rvs-facts');
      if (ok) facts.append(h('li', '', d!.toLocaleString(lang, { dateStyle: 'full', timeStyle: 'short' })));
      facts.append(Object.assign(h('li', '', t.venue), { translate: false }), h('li', '', say('quantity', { n: t.quantity })));
      info.append(facts);
    }
    card.append(date, info);
    body.append(card, cover('rvs-cover rvs-cover-wide'), desc());
  } else if (template === 'shop') {
    const top = h('div', 'rvs-split'); top.append(cover(), head());
    const menu = h('ul', 'rvs-menu'); menu.setAttribute('aria-label', say('menu'));
    for (const it of (model.shopItems ?? []).slice(0, 50)) {
      const li = h('li'); li.append(Object.assign(h('span', 'rvs-mt', it.title), { translate: false }), h('span', 'rvs-mp', it.priceRvn ? `${it.priceRvn} RVN` : say('free')));
      menu.append(li);
    }
    body.append(top, menu, desc());
  } else {
    const top = h('div', 'rvs-split rvs-split-small'); top.append(cover('rvs-cover rvs-cover-small'), head()); body.append(top);
    if (model.tracks?.length) body.append(trackList());
    body.append(desc());
  }
  root.append(body);
  return root;
}

function kindLabel(m: StoreModel, say: (k: CopyKey) => string): string {
  if (m.kind === 'music' && m.format) return `${say('kind_music')} · ${say(`format_${m.format}` as CopyKey)}`;
  return say(`kind_${m.kind}` as CopyKey);
}

/* ── 대비(시험·문서용) ──────────────────────────────────────────────── */

const lum = (hex: string) => {
  const n = parseInt(hex.slice(1), 16), c = [n >> 16 & 255, n >> 8 & 255, n & 255].map(v => { const x = v / 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
};
export const contrast = (a: string, b: string) => { const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m); return (x + 0.05) / (y + 0.05); };
/** 색 하나에서 글자가 놓이는 짝 전부의 대비. */
export function themePairs(t: Theme): Array<[string, number]> {
  return [['ink/bg', contrast(t.ink, t.bg)], ['ink/surface', contrast(t.ink, t.surface)], ['muted/bg', contrast(t.muted, t.bg)], ['muted/surface', contrast(t.muted, t.surface)],
    ['accent/bg', contrast(t.accent, t.bg)], ['accent/surface', contrast(t.accent, t.surface)], ['onAccent/accent', contrast(t.onAccent, t.accent)]];
}
