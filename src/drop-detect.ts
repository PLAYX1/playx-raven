import { suggestNames } from '../core/creator/asset-name';
import { CONTENT_TYPES, COVER_EXT, MIME_BY_EXT, extOf, safePath, sniff, type ContentType, type FileInput } from '../core/creator/limits';

/*
 * 끌어놓기 발행 — 「놓은 것이 무엇인지」 알아맞히기(순수 함수, 화면·네트워크 없음).
 *
 * 규칙(설계 docs/design/drop-publish.md §3):
 *   · 폴더 안에 HTML(index.html 우선)            → 게임
 *   · 소리 파일만(+그림 한 장)                   → 음악: 1곡 = 싱글, 2~6곡 = EP, 7곡 이상 = 앨범(제안 — 고칠 수 있음)
 *   · PDF·EPUB 만(+그림 한 장)                   → 책: EPUB 이 있으면 그게 본문, PDF 둘이면 작은 쪽·「preview/sample/미리」 이름이 미리보기
 *   · 그림만                                    → 모를 때 한 번만 묻는다: 「그림 모음(디지털)」 / 「행사 티켓 포스터」
 *   · 글(.txt)만                                → 디지털
 *   · 섞여 있으면                                → 한 번만 묻는다(가능한 종류만 보기로)
 * 결정은 늘 「제안」이다. 화면은 고칠 길(고급 → 종류)을 남긴다.
 *
 * 🔴 파일 이름 자동 정리: 제작자 상품의 파일 경로는 영문·숫자·. _ - / 만 된다(core/creator/limits.ts safePath).
 *    한글·빈칸 이름을 사람에게 고치라고 하면 아무도 못 끝낸다. 그래서 여기서 안전한 이름으로 바꾸고, 원래 이름은
 *    곡 제목·표시용으로만 쓴다(구매자에게는 곡 제목이 보인다). 바꾼 이름이 겹치면 _2, _3 을 붙인다.
 */

export type MusicFormat = 'single' | 'ep' | 'album';
export type DroppedFile = { path: string; bytes: Uint8Array; mime?: string };
export type TrackGuess = { path: string; title: string; original: string };
export type Guess = {
  type: ContentType | null;
  /** 'sure' = 묻지 않음 · 'ask' = 한 가지를 물어야 함(options 중 하나). */
  confidence: 'sure' | 'ask';
  options: ContentType[];
  question: string | null;
  format: MusicFormat | null;
  /** 안전한 이름으로 바꾼 파일들(표지 제외). role 은 content. */
  files: FileInput[];
  cover: FileInput | null;
  /** 바꾸기 전 → 후(사람에게 「이름을 바꿨어요」로 한 번 알린다). */
  renamed: Array<{ from: string; to: string }>;
  /** 받지 않은 파일과 이유(실행 파일·압축·모르는 확장자). OS 찌꺼기(.DS_Store 등)는 조용히 뺀다. */
  ignored: Array<{ path: string; say: string }>;
  title: string;
  entry: string | null;
  bookFile: string | null;
  bookPreview: string | null;
  tracks: TrackGuess[];
  reasons: string[];
};

const AUDIO = new Set(['mp3', 'm4a', 'ogg', 'opus', 'wav', 'flac']);
const BOOK = new Set(['pdf', 'epub']);
const IMAGE = new Set([...COVER_EXT, 'gif']);
const JUNK = /(^|\/)(\.[^/]*|__MACOSX|Thumbs\.db|desktop\.ini)(\/|$)/i;
const COVER_NAME = /(^|\/)(cover|folder|front|artwork|album|poster|표지|커버|앨범)[^/]*\.(png|jpe?g|webp)$/i;
const PREVIEW_NAME = /(preview|sample|excerpt|미리|맛보기)/i;

const stem = (p: string) => (p.split('/').pop() ?? p).replace(/\.[^.]+$/, '');
/** 「01 - 숲의 노래」 → 「숲의 노래」, 「track_02_sea」 → 「sea」. */
export function trackTitle(original: string): string {
  const s = stem(original).replace(/[_]+/g, ' ').replace(/^\s*(?:track|트랙|cd\s*\d+)?\s*\d{1,3}\s*[-._)\]]?\s*/i, '').trim();
  return (s || stem(original)).slice(0, 80);
}
/** 앞 번호 → 이름 순(자연 정렬). */
export function naturalCompare(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
}

/** 사람 파일 이름 → 묶음 안 안전 경로(영문·숫자·. _ - /). 확장자는 소문자. */
export function safeName(path: string): string {
  const parts = String(path ?? '').split(/[\\/]+/).filter(seg => seg && seg !== '.' && seg !== '..');
  const out = parts.map((seg, i) => {
    const last = i === parts.length - 1;
    const ext = last ? extOf(seg) : '';
    const base = last && ext ? seg.slice(0, -(ext.length + 1)) : seg;
    let clean = base.normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^A-Za-z0-9._-]+/g, '_').replace(/_{2,}/g, '_').replace(/^[._-]+|[._-]+$/g, '');
    if (!clean) clean = last ? 'file' : 'folder';
    return (last && ext ? `${clean}.${ext}` : clean).slice(-80);
  });
  return out.join('/').slice(-200) || 'file';
}

function uniquePaths(files: DroppedFile[]): { list: Array<DroppedFile & { original: string }>; renamed: Guess['renamed'] } {
  const seen = new Set<string>(), renamed: Guess['renamed'] = [], list: Array<DroppedFile & { original: string }> = [];
  for (const f of files) {
    let p = safePath(f.path) ? f.path.replace(/\.([A-Za-z0-9]+)$/, (_, e: string) => '.' + e.toLowerCase()) : safeName(f.path);
    if (seen.has(p.toLowerCase())) {
      const ext = extOf(p), base = ext ? p.slice(0, -(ext.length + 1)) : p;
      for (let i = 2; i < 10_000; i++) { const c = `${base}_${i}${ext ? '.' + ext : ''}`; if (!seen.has(c.toLowerCase())) { p = c; break; } }
    }
    seen.add(p.toLowerCase());
    if (p !== f.path) renamed.push({ from: f.path, to: p });
    list.push({ ...f, path: p, original: f.path });
  }
  return { list, renamed };
}

/** 표지로 쓸 그림 하나(이름이 cover·표지 등이면 그것, 아니면 그림이 딱 하나일 때 그것). */
function pickCover<T extends { path: string; original: string }>(images: T[]): T | null {
  return images.find(f => COVER_NAME.test(f.original) || COVER_NAME.test(f.path)) ?? (images.length === 1 ? images[0] : null);
}

const KIND_SAY: Record<ContentType, string> = { game: '게임', music: '음악', book: '책', ticket: '티켓', digital: '그림·파일 모음' };

/**
 * 놓은 파일들 → 종류·형식·제목·표지·여는 파일·곡 목록 제안. folderName 은 폴더를 놓았을 때 그 폴더 이름(제목 후보).
 * 숨김·OS 파일은 빼고, 받지 않는 파일은 ignored 로 돌려준다.
 */
export function guessDrop(input: readonly DroppedFile[], folderName = ''): Guess {
  const reasons: string[] = [], ignored: Guess['ignored'] = [];
  const kept: DroppedFile[] = [];
  for (const f of input) {
    const p = String(f.path ?? '').replace(/\\/g, '/');
    if (JUNK.test(p)) continue;
    const ext = extOf(p);
    if (!MIME_BY_EXT[ext]) { ignored.push({ path: p, say: ext === 'zip' || ext === 'exe' || ext === 'dmg' || ext === 'app' ? '압축·실행 파일은 받지 않아요(풀어서 놓아 주세요).' : `.${ext || '확장자 없음'} 파일은 받지 않아요.` }); continue; }
    if (f.bytes && sniff(f.bytes) === 'executable') { ignored.push({ path: p, say: '프로그램(실행 파일)은 받지 않아요.' }); continue; }
    kept.push({ ...f, path: p });
  }
  const { list, renamed } = uniquePaths(kept);
  const exts = list.map(f => extOf(f.path));
  const has = (s: Set<string>) => exts.some(e => s.has(e));
  const only = (...sets: Set<string>[]) => exts.length > 0 && exts.every(e => sets.some(s => s.has(e)));
  const htmls = list.filter(f => ['html', 'htm'].includes(extOf(f.path)));
  const images = list.filter(f => IMAGE.has(extOf(f.path)));
  const base: Omit<Guess, 'type' | 'confidence' | 'options' | 'question' | 'format' | 'files' | 'cover' | 'title' | 'entry' | 'bookFile' | 'bookPreview' | 'tracks'> = { renamed, ignored, reasons };
  const titleFrom = (fallback: string) => (folderName.trim() ? folderName.trim() : fallback).slice(0, 80);
  const strip = (f: DroppedFile & { original: string }): FileInput => ({ path: f.path, bytes: f.bytes, mime: f.mime ?? '' });

  if (!list.length) {
    reasons.push(ignored.length ? '받을 수 있는 파일이 없어요.' : '놓은 것이 비어 있어요.');
    return { ...base, type: null, confidence: 'ask', options: [], question: null, format: null, files: [], cover: null, title: '', entry: null, bookFile: null, bookPreview: null, tracks: [] };
  }

  // 게임: HTML 이 있으면 게임 묶음이다(index.html 우선, 가장 얕은 것).
  if (htmls.length) {
    const byDepth = [...htmls].sort((a, b) => (a.path.split('/').length - b.path.split('/').length) || naturalCompare(a.path, b.path));
    const entry = byDepth.find(f => /(^|\/)index\.html?$/i.test(f.path)) ?? byDepth[0];
    reasons.push(`「${entry.path}」로 여는 웹 게임으로 봤어요.`);
    // 게임 안의 그림은 게임이 쓰는 파일일 수 있어 빼지 않는다(표지는 따로 놓거나 고급에서). 갤러리는 이 그림들로 만든다.
    return { ...base, type: 'game', confidence: 'sure', options: ['game'], question: null, format: null,
      files: list.map(strip), cover: null,
      title: titleFrom(stem(entry.path) === 'index' ? 'My Game' : trackTitle(entry.original)), entry: entry.path, bookFile: null, bookPreview: null, tracks: [] };
  }
  // 음악
  if (has(AUDIO) && only(AUDIO, IMAGE)) {
    const audio = list.filter(f => AUDIO.has(extOf(f.path))).sort((a, b) => naturalCompare(a.original, b.original));
    const coverF = pickCover(images.filter(f => COVER_EXT.has(extOf(f.path))));
    images.filter(f => f !== coverF).forEach(f => ignored.push({ path: f.original, say: '음악에는 표지 그림 한 장만 넣어요.' }));
    const format: MusicFormat = audio.length === 1 ? 'single' : audio.length <= 6 ? 'ep' : 'album';
    reasons.push(`소리 파일 ${audio.length}개 → ${format === 'single' ? '싱글(한 곡)' : format === 'ep' ? 'EP(짧은 앨범)' : '앨범'}으로 봤어요.`);
    if (audio.length > CONTENT_TYPES.music.maxFiles) reasons.push(`음악은 ${CONTENT_TYPES.music.maxFiles}곡까지예요.`);
    const tracks = audio.map(f => ({ path: f.path, title: trackTitle(f.original), original: f.original }));
    return { ...base, type: 'music', confidence: 'sure', options: ['music'], question: null, format, files: audio.map(strip),
      cover: coverF ? { ...strip(coverF), role: 'cover' } : null, title: titleFrom(audio.length === 1 ? tracks[0].title : 'My Album'), entry: null, bookFile: null, bookPreview: null, tracks };
  }
  // 책
  if (has(BOOK) && only(BOOK, IMAGE)) {
    const books = list.filter(f => BOOK.has(extOf(f.path)));
    const epub = books.find(f => extOf(f.path) === 'epub');
    const pdfs = books.filter(f => extOf(f.path) === 'pdf').sort((a, b) => a.bytes.length - b.bytes.length);
    const preview = pdfs.find(f => PREVIEW_NAME.test(f.original)) ?? (epub ? pdfs[0] : pdfs.length > 1 ? pdfs[0] : undefined) ?? null;
    const main = epub ?? pdfs.filter(f => f !== preview).pop() ?? pdfs[pdfs.length - 1];
    const coverF = pickCover(images.filter(f => COVER_EXT.has(extOf(f.path))));
    images.filter(f => f !== coverF).forEach(f => ignored.push({ path: f.original, say: '책에는 표지 그림 한 장만 넣어요.' }));
    const used = [main, ...(preview && preview !== main ? [preview] : [])];
    books.filter(f => !used.includes(f)).forEach(f => ignored.push({ path: f.original, say: '책 하나에는 본문 한 개와 미리보기 한 개만 넣어요.' }));
    reasons.push(`「${main.original}」을(를) 책 본문으로${preview ? `, 「${preview.original}」을(를) 미리보기로` : ''} 봤어요.`);
    return { ...base, type: 'book', confidence: 'sure', options: ['book'], question: null, format: null, files: used.map(strip),
      cover: coverF ? { ...strip(coverF), role: 'cover' } : null, title: titleFrom(trackTitle(main.original)), entry: null, bookFile: main.path, bookPreview: preview && preview !== main ? preview.path : null, tracks: [] };
  }
  // 글만 → 디지털
  if (only(new Set(['txt']))) {
    reasons.push('글 파일이라 내려받는 디지털 상품으로 봤어요.');
    return { ...base, type: 'digital', confidence: 'sure', options: ['digital'], question: null, format: null, files: list.map(strip), cover: null,
      title: titleFrom(trackTitle(list[0].original)), entry: null, bookFile: null, bookPreview: null, tracks: [] };
  }
  // 그림만 → 한 번만 묻는다
  if (only(IMAGE)) {
    const coverF = list.length > 1 ? pickCover(images.filter(f => COVER_EXT.has(extOf(f.path)) && COVER_NAME.test(f.original))) : null;
    reasons.push('그림만 있어요. 그림 모음으로 팔지, 행사 티켓의 포스터로 쓸지 골라 주세요.');
    return { ...base, type: 'digital', confidence: 'ask', options: ['digital', 'ticket'], question: '그림을 어떻게 팔까요?', format: null,
      files: list.filter(f => f !== coverF).map(strip), cover: coverF ? { ...strip(coverF), role: 'cover' } : null,
      title: titleFrom(list.length === 1 ? trackTitle(list[0].original) : 'My Collection'), entry: null, bookFile: null, bookPreview: null, tracks: [] };
  }
  // 섞임 → 가능한 종류만 보기로
  const options = (['digital', 'music', 'book', 'ticket'] as ContentType[]).filter(t => exts.every(e => CONTENT_TYPES[t].ext.has(e) || (IMAGE.has(e) && COVER_EXT.has(e))));
  reasons.push('여러 종류가 섞여 있어요. 무엇으로 팔지 하나만 골라 주세요.');
  return { ...base, type: options[0] ?? null, confidence: 'ask', options, question: options.length ? '무엇으로 팔까요?' : '한 상품에 함께 넣을 수 없는 파일이 섞여 있어요. 종류별로 나눠서 놓아 주세요.',
    format: null, files: list.map(strip), cover: null, title: titleFrom(trackTitle(list[0].original)), entry: null, bookFile: null, bookPreview: null, tracks: [] };
}

export const kindWord = (t: ContentType) => KIND_SAY[t];

/* ── 기본값(초안) ───────────────────────────────────────────────────── */

/** 가격 기본값(RVN, 초안 — 대표 결정). 화면은 「제안」으로만 보이고 고급에서 바꾼다. 0 = 무료. */
export const DEFAULT_PRICE_RVN: Readonly<Record<ContentType | MusicFormat, number>> = Object.freeze({
  single: 5, ep: 15, album: 30, music: 5, book: 20, game: 0, ticket: 30, digital: 10,
});
export function defaultPrice(type: ContentType, format: MusicFormat | null): number {
  // 게임은 검증 전에는 지갑 결제가 안 된다(실행 코드) — 기본 무료로 둔다.
  return type === 'music' && format ? DEFAULT_PRICE_RVN[format] : DEFAULT_PRICE_RVN[type];
}
export const FALLBACK_WORD: Readonly<Record<ContentType, string>> = Object.freeze({ game: 'GAME', music: 'SONG', book: 'BOOK', ticket: 'TICKET', digital: 'ITEM' });
/** 제목 → 이름 제안(이미 있는 이름 제외). core suggestNames 를 그대로 쓴다. */
export const suggestAsset = (title: string, type: ContentType, taken: ReadonlySet<string>, format: MusicFormat | null = null) =>
  suggestNames(title, taken, { type, fallback: type === 'music' && format === 'album' ? 'ALBUM' : FALLBACK_WORD[type], n: 3 });
/** 미리듣기 기본 구간: 곡 길이를 알면 30초 지점부터 30초(짧으면 처음부터), 모르면 0~30초. */
export function defaultPreview(durationMs: number | null): { startMs: number; endMs: number } {
  if (!durationMs || durationMs < 2000) return { startMs: 0, endMs: 30_000 };
  if (durationMs >= 75_000) return { startMs: 30_000, endMs: 60_000 };
  return { startMs: 0, endMs: Math.max(1000, Math.min(30_000, Math.floor(durationMs))) };
}

/* ── 붙여 넣은 IPFS 주소 ─────────────────────────────────────────────── */

export type PastedCid = { ok: true; cid: string } | { ok: false; say: string };
/** 「ipfs://Qm…」·「Qm…」·게이트웨이 주소(…/ipfs/Qm…) → CIDv0. CIDv1(bafy…)은 아직 안 받는다(체인 ipfs_hash 가 34바이트 CIDv0 만 담는다). */
export function parsePastedCid(text: string): PastedCid {
  const s = String(text ?? '').trim();
  const m = /(?:^|ipfs:\/\/|\/ipfs\/)(Qm[1-9A-HJ-NP-Za-km-z]{44})(?=$|[/?#\s])/.exec(s);
  if (m) return { ok: true, cid: m[1] };
  if (/(?:^|ipfs:\/\/|\/ipfs\/)b[a-z2-7]{50,}/i.test(s)) return { ok: false, say: '「bafy…」 모양(CIDv1)은 아직 받지 않아요. 체인에는 Qm… 모양만 적을 수 있어요.' };
  return { ok: false, say: 'IPFS 주소가 아니에요. 「ipfs://Qm…」나 「Qm…」(46자)를 붙여 넣어 주세요.' };
}
