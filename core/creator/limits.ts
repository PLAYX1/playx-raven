/*
 * 올릴 파일 검사 — 종류(게임·음악·책·티켓·디지털)별 표, 크기·확장자·MIME·파일 머리(magic bytes)·글자 파일 UTF-8·위험 무늬 경고.
 *
 * 🔴 이 검사는 「실수와 뻔한 위장」을 거르는 것이지 악성 코드를 찾아내는 장치가 아니다. 경고가 없다고 안전한 것이
 *    아니며, 화면은 그 사실을 늘 같이 말한다(SCRIPT_NOTICE). 그래서 실행되는 콘텐츠(게임)는 「검증됨」 전에는 지갑 안에서
 *    실행하지 않고 외부 링크로만 연다(설계 asset-game-market.md §3, docs/open-seller-platform.md §3).
 *
 * 숫자 상한은 전부 **초안**이다(대표 결정: 핀 서비스·보관 비용과 함께 정한다). 종류별 규칙은 이 파일의 CONTENT_TYPES 한 곳에만 있다.
 * 새 종류를 더할 때: 여기 표에 한 줄 + manifest.ts 의 details 검사 한 칸 + 시험.
 */

export type ContentType = 'game' | 'music' | 'book' | 'ticket' | 'digital';
export type FileRole = 'content' | 'cover';
export const CONTENT_TYPE_IDS: readonly ContentType[] = Object.freeze(['game', 'music', 'book', 'ticket', 'digital']);

/** 확장자 → 정해진 MIME. 이 표에 없는 확장자는 어느 종류에서도 받지 않는다. */
export const MIME_BY_EXT: Readonly<Record<string, string>> = Object.freeze({
  html: 'text/html', htm: 'text/html', js: 'text/javascript', mjs: 'text/javascript', css: 'text/css', json: 'application/json',
  txt: 'text/plain', svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif',
  mp3: 'audio/mpeg', m4a: 'audio/mp4', ogg: 'audio/ogg', opus: 'audio/ogg', wav: 'audio/wav', flac: 'audio/flac',
  woff: 'font/woff', woff2: 'font/woff2', wasm: 'application/wasm', glb: 'model/gltf-binary',
  pdf: 'application/pdf', epub: 'application/epub+zip',
});
const TEXT_EXT = new Set(['html', 'htm', 'js', 'mjs', 'css', 'json', 'txt', 'svg']);
const AUDIO = ['mp3', 'm4a', 'ogg', 'opus', 'wav', 'flac'];
const IMAGES = ['png', 'jpg', 'jpeg', 'webp'];

export type TypeRule = {
  /** 쉬운 이름(화면). */
  readonly label: string;
  /** 한 줄 설명(마법사 ① 단계). */
  readonly say: string;
  readonly ext: ReadonlySet<string>;
  readonly minFiles: number; readonly maxFiles: number; readonly maxFileBytes: number; readonly maxTotalBytes: number;
  /** 코드를 실행하는 종류인가(게임). true 면 「검증됨」 전에는 지갑 안에서 열지 않는다. */
  readonly runsCode: boolean;
  /** (b)층 「보증 결제」를 허용하는가. 실행 코드(게임)는 막는다 — docs/open-seller-platform.md §3.3 */
  readonly bondedPayment: boolean;
  /** details 칸의 필수 키(매니페스트 검사와 문서가 같은 표를 본다). */
  readonly detailKeys: readonly string[];
};

const MB = 1024 * 1024;
export const CONTENT_TYPES: Readonly<Record<ContentType, TypeRule>> = Object.freeze({
  game: Object.freeze({ label: '게임', say: '웹으로 만든 게임 묶음(HTML·JS·그림·소리)', runsCode: true, bondedPayment: false,
    ext: new Set(Object.keys(MIME_BY_EXT).filter(e => !['flac', 'opus', 'pdf', 'epub'].includes(e))),
    minFiles: 1, maxFiles: 2000, maxFileBytes: 25 * MB, maxTotalBytes: 200 * MB, detailKeys: ['entry', 'origin', 'capabilities'] }),
  music: Object.freeze({ label: '음악', say: '노래·연주 파일(MP3·M4A·OGG·WAV·FLAC)과 표지', runsCode: false, bondedPayment: true,
    ext: new Set(AUDIO), minFiles: 1, maxFiles: 20, maxFileBytes: 200 * MB, maxTotalBytes: 400 * MB, detailKeys: ['previewFile', 'previewStartMs', 'previewEndMs'] }),
  book: Object.freeze({ label: '책', say: '전자책(PDF·EPUB)과 미리보기 몇 쪽', runsCode: false, bondedPayment: true,
    ext: new Set(['pdf', 'epub']), minFiles: 1, maxFiles: 3, maxFileBytes: 100 * MB, maxTotalBytes: 150 * MB,
    detailKeys: ['bookFile', 'format', 'previewFile', 'previewPages', 'pageCount'] }),
  ticket: Object.freeze({ label: '티켓', say: '공연·모임·수업 입장권(행사 정보와 사용 확인 방법)', runsCode: false, bondedPayment: true,
    ext: new Set([...IMAGES, 'pdf']), minFiles: 0, maxFiles: 4, maxFileBytes: 10 * MB, maxTotalBytes: 20 * MB,
    detailKeys: ['eventName', 'startsAt', 'endsAt', 'venue', 'quantity', 'redemption', 'refundPolicy', 'contact'] }),
  digital: Object.freeze({ label: '그 밖의 디지털 상품', say: '그림·문서·소리 같은 내려받는 파일(실행 파일·압축 파일은 안 돼요)', runsCode: false, bondedPayment: true,
    ext: new Set([...IMAGES, 'gif', 'pdf', 'epub', 'txt', ...AUDIO]), minFiles: 1, maxFiles: 50, maxFileBytes: 100 * MB, maxTotalBytes: 300 * MB,
    detailKeys: ['label'] }),
});

export const LIMITS = Object.freeze({
  cover: Object.freeze({ maxFileBytes: 5 * MB }),
  pathChars: 200,
});
export const COVER_EXT: ReadonlySet<string> = new Set(IMAGES);
export const isContentType = (t: unknown): t is ContentType => typeof t === 'string' && (CONTENT_TYPE_IDS as readonly string[]).includes(t);
export const allowedExt = (type: ContentType | 'cover'): ReadonlySet<string> => type === 'cover' ? COVER_EXT : CONTENT_TYPES[type].ext;

/** 브라우저가 type 을 비워 두거나 이렇게 일반값으로 줄 때는 확장자 표의 값을 쓴다. */
const GENERIC_MIME = new Set(['', 'application/octet-stream', 'binary/octet-stream']);
/** 확장자 표와 다르지만 같은 것으로 보는 흔한 별칭. */
const MIME_ALIASES: Readonly<Record<string, readonly string[]>> = Object.freeze({
  'text/javascript': ['application/javascript', 'application/x-javascript'],
  'audio/mpeg': ['audio/mp3'], 'audio/wav': ['audio/x-wav', 'audio/wave', 'audio/vnd.wave'], 'audio/mp4': ['audio/x-m4a', 'audio/m4a'],
  'audio/flac': ['audio/x-flac'], 'image/jpeg': ['image/jpg'], 'application/pdf': ['application/x-pdf'],
});

export const SCRIPT_NOTICE = '자동 검사는 나쁜 코드를 다 찾아내지 못해요. 검증 전에는 이 콘텐츠가 지갑 안에서 실행되지 않고, 외부 링크로만 열려요.';

export type FileProblem = { code: string; path: string; say: string };
export type FileWarning = { code: string; path: string; say: string };
export type CheckedFile = { path: string; ext: string; mime: string; size: number; role: FileRole };

const startsWith = (b: Uint8Array, sig: number[], at = 0) => sig.every((x, i) => b[at + i] === x);
const ascii = (s: string) => Array.from(s, c => c.charCodeAt(0));
/** 파일 머리로 실제 종류를 본다. 글자 파일은 null(머리가 없다). */
export function sniff(bytes: Uint8Array): string | null {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'png';
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return 'jpg';
  if (startsWith(bytes, ascii('GIF87a')) || startsWith(bytes, ascii('GIF89a'))) return 'gif';
  if (startsWith(bytes, ascii('RIFF')) && startsWith(bytes, ascii('WEBP'), 8)) return 'webp';
  if (startsWith(bytes, ascii('RIFF')) && startsWith(bytes, ascii('WAVE'), 8)) return 'wav';
  if (startsWith(bytes, ascii('OggS'))) return 'ogg';
  if (startsWith(bytes, ascii('fLaC'))) return 'flac';
  if (startsWith(bytes, ascii('%PDF-'))) return 'pdf';
  // EPUB = ZIP 이고 첫 항목이 압축 안 된 「mimetype」 = application/epub+zip (OCF 3.x 규칙). 그냥 ZIP 은 받지 않는다.
  if (startsWith(bytes, [0x50, 0x4b, 0x03, 0x04]) && startsWith(bytes, ascii('mimetypeapplication/epub+zip'), 30)) return 'epub';
  if (startsWith(bytes, [0x50, 0x4b, 0x03, 0x04])) return 'zip';
  if (startsWith(bytes, ascii('ID3')) || (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0)) return 'mp3';
  if (startsWith(bytes, ascii('ftyp'), 4)) return 'm4a';
  if (startsWith(bytes, [0x00, 0x61, 0x73, 0x6d])) return 'wasm';
  if (startsWith(bytes, ascii('wOFF'))) return 'woff';
  if (startsWith(bytes, ascii('wOF2'))) return 'woff2';
  if (startsWith(bytes, ascii('glTF'))) return 'glb';
  if (startsWith(bytes, ascii('MZ')) || startsWith(bytes, [0x7f, 0x45, 0x4c, 0x46]) || startsWith(bytes, [0xcf, 0xfa, 0xed, 0xfe])) return 'executable';
  return null;
}
const SNIFF_OK: Readonly<Record<string, readonly string[]>> = Object.freeze({
  png: ['png'], jpg: ['jpg'], jpeg: ['jpg'], gif: ['gif'], webp: ['webp'], wav: ['wav'], ogg: ['ogg'], opus: ['ogg'], flac: ['flac'],
  mp3: ['mp3'], m4a: ['m4a'], wasm: ['wasm'], woff: ['woff'], woff2: ['woff2'], glb: ['glb'], pdf: ['pdf'], epub: ['epub'],
});

/** 묶음 안 경로: 영문·숫자·. _ - / 만, 상대 경로, `..`·빈 칸·숨김 파일 금지. */
export function safePath(path: string): boolean {
  if (typeof path !== 'string' || !path || path.length > LIMITS.pathChars || !/^[A-Za-z0-9._\-/]+$/.test(path)) return false;
  if (path.startsWith('/') || path.endsWith('/') || path.includes('//')) return false;
  return path.split('/').every(seg => seg !== '.' && seg !== '..' && !seg.startsWith('.'));
}
export const extOf = (path: string) => { const m = /\.([A-Za-z0-9]+)$/.exec(path); return m ? m[1].toLowerCase() : ''; };

/** 브라우저가 준 MIME 와 확장자 표가 맞는지. 맞으면 정해진 MIME 를 돌려준다. */
export function mimeFor(ext: string, claimed: string): string | null {
  const want = MIME_BY_EXT[ext];
  if (!want) return null;
  const c = String(claimed ?? '').toLowerCase().split(';')[0].trim();
  if (GENERIC_MIME.has(c) || c === want || (MIME_ALIASES[want] ?? []).includes(c)) return want;
  return null;
}

/** 위험해 보이는 글자 파일 무늬. 찾으면 경고(거절 아님) — 게임은 원래 스크립트를 쓴다. */
const RISKY: ReadonlyArray<{ code: string; re: RegExp; say: string }> = [
  { code: 'remote-script', re: /<script[^>]+src\s*=\s*["']?\s*(?:https?:)?\/\//i, say: '다른 사이트의 스크립트를 불러와요. 올린 뒤에도 그 사이트가 코드를 바꿀 수 있어요.' },
  { code: 'dynamic-code', re: /\beval\s*\(|\bnew\s+Function\s*\(/, say: '문자열을 코드로 실행해요(eval·new Function).' },
  { code: 'parent-access', re: /\b(?:window\.)?(?:parent|top|opener)\s*\.\s*(?:postMessage|location|document)/, say: '바깥 창(지갑 화면)에 말을 걸거나 옮기려 해요.' },
  { code: 'miner', re: /coinhive|cryptonight|stratum\+tcp|xmrig|webminer/i, say: '채굴 프로그램으로 보이는 이름이 있어요.' },
  { code: 'wallet-words', re: /mnemonic|seed\s*phrase|private\s*key|복구\s*단어|비밀\s*키/i, say: '복구 단어·개인키를 묻는 것처럼 보이는 글이 있어요.' },
  { code: 'svg-script', re: /<script|\son[a-z]+\s*=|javascript:/i, say: '그림(SVG) 안에 스크립트가 있어요.' },
];
/** PDF 안의 「열면 저절로 움직이는」 표시. 거절하지 않고 경고한다(정상 PDF 에도 가끔 있다). PDF 는 압축 스트림 안에 숨길 수 있어 다 찾지 못한다. */
const PDF_RISKY: ReadonlyArray<{ code: string; re: RegExp; say: string }> = [
  { code: 'pdf-script', re: /\/JavaScript\b|\/JS\s*[(<\[]/, say: 'PDF 안에 스크립트가 있어요. 구매자 PDF 프로그램에서 실행될 수 있어요.' },
  { code: 'pdf-autorun', re: /\/OpenAction\b|\/AA\s*<</, say: 'PDF 를 열 때 저절로 실행되는 동작이 있어요.' },
  { code: 'pdf-launch', re: /\/Launch\b/, say: 'PDF 가 다른 프로그램을 열려고 해요.' },
  { code: 'pdf-embedded', re: /\/EmbeddedFile\b/, say: 'PDF 안에 다른 파일이 숨어 있어요.' },
];
const latin1 = (b: Uint8Array) => { let s = ''; for (let i = 0; i < b.length; i += 65536) s += String.fromCharCode(...b.subarray(i, i + 65536)); return s; };

export type FileInput = { path: string; bytes: Uint8Array; mime?: string; role?: FileRole };
export type FilesCheck = { ok: boolean; files: CheckedFile[]; problems: FileProblem[]; warnings: FileWarning[]; totalBytes: number };

/** 받은 파일 하나의 위험 무늬만 본다(구매자 쪽 자동 점검이 받은 바이트로 다시 부른다). */
export function riskWarnings(path: string, bytes: Uint8Array): FileWarning[] {
  const ext = extOf(path), out: FileWarning[] = [];
  if (TEXT_EXT.has(ext)) {
    let text = '';
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { return out; }
    for (const r of RISKY) if (r.code === 'svg-script' ? ext === 'svg' && r.re.test(text) : r.re.test(text)) out.push({ code: r.code, path, say: r.say });
  } else if (ext === 'pdf') {
    const raw = latin1(bytes);
    for (const r of PDF_RISKY) if (r.re.test(raw)) out.push({ code: r.code, path, say: r.say });
  } else if (ext === 'epub') {
    out.push({ code: 'epub-web', path, say: '전자책(EPUB) 안에는 웹 문서가 들어 있어요. 레이븐볼트는 열지 않고 내려받기만 해요. 읽는 프로그램이 스크립트를 실행할 수 있어요.' });
    if (/<script/i.test(latin1(bytes))) out.push({ code: 'epub-script', path, say: '전자책 안에 스크립트가 보여요.' });
  }
  return out;
}

/** 콘텐츠 종류별로 파일 묶음을 검사한다. 문제(problems)가 하나라도 있으면 올리지 않는다. 경고(warnings)는 보여 주고 진행할 수 있다. */
export function checkFiles(type: ContentType, inputs: readonly FileInput[]): FilesCheck {
  const problems: FileProblem[] = [], warnings: FileWarning[] = [], files: CheckedFile[] = [];
  const rule = CONTENT_TYPES[type];
  if (!rule) return { ok: false, files, problems: [{ code: 'type', path: '', say: '무엇을 파는지 골라 주세요.' }], warnings, totalBytes: 0 };
  const contents = inputs.filter(f => (f.role ?? 'content') === 'content');
  const covers = inputs.filter(f => f.role === 'cover');
  if (contents.length < rule.minFiles) problems.push({ code: 'no-files', path: '', say: `${rule.label} 파일을 골라 주세요.` });
  if (contents.length > rule.maxFiles) problems.push({ code: 'too-many-files', path: '', say: `파일은 ${rule.maxFiles}개까지 올릴 수 있어요.` });
  if (covers.length > 1) problems.push({ code: 'cover-count', path: '', say: '표지는 한 장만 올릴 수 있어요.' });
  const seen = new Set<string>();
  let total = 0;
  for (const f of inputs) {
    const role: FileRole = f.role ?? 'content';
    const path = String(f.path ?? '');
    if (!safePath(path)) { problems.push({ code: 'path', path, say: '파일 이름에는 영문·숫자·점·밑줄·빼기만 쓸 수 있어요(한글·빈칸·숨김 파일은 안 돼요).' }); continue; }
    const key = path.toLowerCase();
    if (seen.has(key)) { problems.push({ code: 'duplicate', path, say: '같은 이름의 파일이 두 번 있어요.' }); continue; }
    seen.add(key);
    const ext = extOf(path);
    if (!allowedExt(role === 'cover' ? 'cover' : type).has(ext)) {
      problems.push({ code: 'ext', path, say: role === 'cover' ? '표지는 PNG·JPG·WEBP 만 돼요.' : `${rule.label}에는 이 종류(.${ext || '없음'})의 파일을 올릴 수 없어요.` }); continue;
    }
    const mime = mimeFor(ext, f.mime ?? '');
    if (!mime) { problems.push({ code: 'mime', path, say: '파일 이름(확장자)과 파일 종류가 서로 달라요.' }); continue; }
    const size = f.bytes?.length ?? -1;
    if (!(f.bytes instanceof Uint8Array) || size === 0) { problems.push({ code: 'empty', path, say: '빈 파일이에요.' }); continue; }
    const max = role === 'cover' ? LIMITS.cover.maxFileBytes : rule.maxFileBytes;
    if (size > max) { problems.push({ code: 'file-too-big', path, say: `파일 하나가 ${Math.floor(max / MB)}MB 를 넘어요.` }); continue; }
    if (TEXT_EXT.has(ext)) {
      try { new TextDecoder('utf-8', { fatal: true }).decode(f.bytes); } catch { problems.push({ code: 'not-text', path, say: '글자 파일인데 글자로 읽히지 않아요(위장된 파일일 수 있어요).' }); continue; }
      if (sniff(f.bytes)) { problems.push({ code: 'magic', path, say: '글자 파일 이름인데 실제로는 다른 종류의 파일이에요.' }); continue; }
    } else {
      const got = sniff(f.bytes);
      if (!got || !(SNIFF_OK[ext] ?? []).includes(got)) { problems.push({ code: 'magic', path, say: got === 'executable' ? '프로그램(실행 파일)을 이름만 바꿔 올리려 해요.' : '파일 이름(확장자)과 실제 내용이 달라요.' }); continue; }
    }
    warnings.push(...riskWarnings(path, f.bytes));
    total += role === 'content' ? size : 0;
    files.push({ path, ext, mime, size, role });
  }
  if (total > rule.maxTotalBytes) problems.push({ code: 'total-too-big', path: '', say: `전체 크기가 ${Math.floor(rule.maxTotalBytes / MB)}MB 를 넘어요.` });
  if (type === 'game') {
    if (!contents.some(f => ['html', 'htm'].includes(extOf(String(f.path))))) problems.push({ code: 'no-entry', path: '', say: '게임을 여는 HTML 파일(예: index.html)이 필요해요.' });
    if (files.some(f => ['js', 'mjs', 'html', 'htm', 'wasm'].includes(f.ext))) warnings.unshift({ code: 'runs-code', path: '', say: '이 게임은 코드를 실행해요. ' + SCRIPT_NOTICE });
  }
  return { ok: problems.length === 0, files, problems, warnings, totalBytes: total };
}
