/*
 * 올릴 파일 검사 — 크기·확장자·MIME·파일 머리(magic bytes)·글자 파일 UTF-8·악성 스크립트 경고.
 *
 * 🔴 이 검사는 「실수와 뻔한 위장」을 거르는 것이지 악성 코드를 찾아내는 장치가 아니다. 경고가 없다고 안전한 것이
 *    아니며, 화면은 그 사실을 늘 같이 말한다(SCRIPT_NOTICE). 그래서 미검증 콘텐츠는 지갑 안에서 실행하지 않고
 *    외부 링크로만 연다(설계 asset-game-market.md §3).
 *
 * 숫자 상한은 전부 **초안**이다(대표 결정: 핀 서비스·보관 비용과 함께 정한다). 상수는 이 파일 한 곳에만 있다.
 */

export type ContentType = 'game' | 'music';
export type FileRole = 'content' | 'cover';

export const LIMITS = Object.freeze({
  game: Object.freeze({ maxFileBytes: 25 * 1024 * 1024, maxTotalBytes: 200 * 1024 * 1024, maxFiles: 2000 }),
  music: Object.freeze({ maxFileBytes: 200 * 1024 * 1024, maxTotalBytes: 400 * 1024 * 1024, maxFiles: 20 }),
  cover: Object.freeze({ maxFileBytes: 5 * 1024 * 1024 }),
  pathChars: 200,
});

/** 확장자 → 정해진 MIME. 이 표에 없는 확장자는 받지 않는다. */
export const MIME_BY_EXT: Readonly<Record<string, string>> = Object.freeze({
  html: 'text/html', htm: 'text/html', js: 'text/javascript', mjs: 'text/javascript', css: 'text/css', json: 'application/json',
  txt: 'text/plain', svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif',
  mp3: 'audio/mpeg', m4a: 'audio/mp4', ogg: 'audio/ogg', opus: 'audio/ogg', wav: 'audio/wav', flac: 'audio/flac',
  woff: 'font/woff', woff2: 'font/woff2', wasm: 'application/wasm', glb: 'model/gltf-binary',
});
const TEXT_EXT = new Set(['html', 'htm', 'js', 'mjs', 'css', 'json', 'txt', 'svg']);
const AUDIO_EXT = new Set(['mp3', 'm4a', 'ogg', 'opus', 'wav', 'flac']);
const COVER_EXT = new Set(['png', 'jpg', 'jpeg', 'webp']);
export const ALLOWED_EXT: Readonly<Record<ContentType | 'cover', ReadonlySet<string>>> = Object.freeze({
  game: new Set(Object.keys(MIME_BY_EXT).filter(e => !['flac', 'opus'].includes(e))),
  music: AUDIO_EXT,
  cover: COVER_EXT,
});
/** 브라우저가 type 을 비워 두거나 이렇게 일반값으로 줄 때는 확장자 표의 값을 쓴다. */
const GENERIC_MIME = new Set(['', 'application/octet-stream', 'binary/octet-stream']);
/** 확장자 표와 다르지만 같은 것으로 보는 흔한 별칭. */
const MIME_ALIASES: Readonly<Record<string, readonly string[]>> = Object.freeze({
  'text/javascript': ['application/javascript', 'application/x-javascript'],
  'audio/mpeg': ['audio/mp3'], 'audio/wav': ['audio/x-wav', 'audio/wave', 'audio/vnd.wave'], 'audio/mp4': ['audio/x-m4a', 'audio/m4a'],
  'audio/flac': ['audio/x-flac'], 'image/jpeg': ['image/jpg'],
});

export const SCRIPT_NOTICE = '자동 검사는 나쁜 코드를 다 찾아내지 못해요. 검증 전에는 이 콘텐츠가 지갑 안에서 실행되지 않고, 외부 링크로만 열려요.';

export type FileProblem = { code: string; path: string; say: string };
export type FileWarning = { code: string; path: string; say: string };
export type CheckedFile = { path: string; ext: string; mime: string; size: number; role: FileRole };

const startsWith = (b: Uint8Array, sig: number[], at = 0) => sig.every((x, i) => b[at + i] === x);
const ascii = (s: string) => Array.from(s, c => c.charCodeAt(0));
/** 파일 머리로 실제 종류를 본다. 글자 파일은 null(머리가 없다). 모르는 바이너리는 'unknown'. */
export function sniff(bytes: Uint8Array): string | null {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'png';
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return 'jpg';
  if (startsWith(bytes, ascii('GIF87a')) || startsWith(bytes, ascii('GIF89a'))) return 'gif';
  if (startsWith(bytes, ascii('RIFF')) && startsWith(bytes, ascii('WEBP'), 8)) return 'webp';
  if (startsWith(bytes, ascii('RIFF')) && startsWith(bytes, ascii('WAVE'), 8)) return 'wav';
  if (startsWith(bytes, ascii('OggS'))) return 'ogg';
  if (startsWith(bytes, ascii('fLaC'))) return 'flac';
  if (startsWith(bytes, ascii('ID3')) || (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0)) return 'mp3';
  if (startsWith(bytes, ascii('ftyp'), 4)) return 'm4a';
  if (startsWith(bytes, [0x00, 0x61, 0x73, 0x6d])) return 'wasm';
  if (startsWith(bytes, ascii('wOFF'))) return 'woff';
  if (startsWith(bytes, ascii('wOF2'))) return 'woff2';
  if (startsWith(bytes, ascii('glTF'))) return 'glb';
  return null;
}
const SNIFF_OK: Readonly<Record<string, readonly string[]>> = Object.freeze({
  png: ['png'], jpg: ['jpg'], jpeg: ['jpg'], gif: ['gif'], webp: ['webp'], wav: ['wav'], ogg: ['ogg'], opus: ['ogg'], flac: ['flac'],
  mp3: ['mp3'], m4a: ['m4a'], wasm: ['wasm'], woff: ['woff'], woff2: ['woff2'], glb: ['glb'],
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

/** 위험해 보이는 글자 파일 무늬. 찾으면 경고(거절 아님) — 게임은 원래 스크립트를 쓴다. 음악 묶음에는 글자 파일이 아예 못 들어온다. */
const RISKY: ReadonlyArray<{ code: string; re: RegExp; say: string }> = [
  { code: 'remote-script', re: /<script[^>]+src\s*=\s*["']?\s*(?:https?:)?\/\//i, say: '다른 사이트의 스크립트를 불러와요. 올린 뒤에도 그 사이트가 코드를 바꿀 수 있어요.' },
  { code: 'dynamic-code', re: /\beval\s*\(|\bnew\s+Function\s*\(/, say: '문자열을 코드로 실행해요(eval·new Function).' },
  { code: 'parent-access', re: /\b(?:window\.)?(?:parent|top|opener)\s*\.\s*(?:postMessage|location|document)/, say: '바깥 창(지갑 화면)에 말을 걸거나 옮기려 해요.' },
  { code: 'miner', re: /coinhive|cryptonight|stratum\+tcp|xmrig|webminer/i, say: '채굴 프로그램으로 보이는 이름이 있어요.' },
  { code: 'wallet-words', re: /mnemonic|seed\s*phrase|private\s*key|복구\s*단어|비밀\s*키/i, say: '복구 단어·개인키를 묻는 것처럼 보이는 글이 있어요.' },
  { code: 'svg-script', re: /<script|\son[a-z]+\s*=|javascript:/i, say: '그림(SVG) 안에 스크립트가 있어요.' },
];

export type FileInput = { path: string; bytes: Uint8Array; mime?: string; role?: FileRole };
export type FilesCheck = { ok: boolean; files: CheckedFile[]; problems: FileProblem[]; warnings: FileWarning[]; totalBytes: number };

/** 콘텐츠 종류별로 파일 묶음을 검사한다. 문제(problems)가 하나라도 있으면 올리지 않는다. 경고(warnings)는 보여 주고 진행할 수 있다. */
export function checkFiles(type: ContentType, inputs: readonly FileInput[]): FilesCheck {
  const problems: FileProblem[] = [], warnings: FileWarning[] = [], files: CheckedFile[] = [];
  const lim = LIMITS[type];
  const contents = inputs.filter(f => (f.role ?? 'content') === 'content');
  const covers = inputs.filter(f => f.role === 'cover');
  if (contents.length === 0) problems.push({ code: 'no-files', path: '', say: type === 'game' ? '게임 파일을 골라 주세요.' : '음악 파일을 골라 주세요.' });
  if (contents.length > lim.maxFiles) problems.push({ code: 'too-many-files', path: '', say: `파일은 ${lim.maxFiles}개까지 올릴 수 있어요.` });
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
    const allowed = role === 'cover' ? ALLOWED_EXT.cover : ALLOWED_EXT[type];
    if (!allowed.has(ext)) { problems.push({ code: 'ext', path, say: role === 'cover' ? '표지는 PNG·JPG·WEBP 만 돼요.' : `이 종류(.${ext || '없음'})의 파일은 올릴 수 없어요.` }); continue; }
    const mime = mimeFor(ext, f.mime ?? '');
    if (!mime) { problems.push({ code: 'mime', path, say: '파일 이름(확장자)과 파일 종류가 서로 달라요.' }); continue; }
    const size = f.bytes?.length ?? -1;
    if (!(f.bytes instanceof Uint8Array) || size === 0) { problems.push({ code: 'empty', path, say: '빈 파일이에요.' }); continue; }
    const max = role === 'cover' ? LIMITS.cover.maxFileBytes : lim.maxFileBytes;
    if (size > max) { problems.push({ code: 'file-too-big', path, say: `파일 하나가 ${Math.floor(max / 1024 / 1024)}MB 를 넘어요.` }); continue; }
    if (TEXT_EXT.has(ext)) {
      let text = '';
      try { text = new TextDecoder('utf-8', { fatal: true }).decode(f.bytes); } catch { problems.push({ code: 'not-text', path, say: '글자 파일인데 글자로 읽히지 않아요(위장된 파일일 수 있어요).' }); continue; }
      if (sniff(f.bytes)) { problems.push({ code: 'magic', path, say: '글자 파일 이름인데 실제로는 다른 종류의 파일이에요.' }); continue; }
      for (const r of RISKY) {
        if (r.code === 'svg-script' ? ext === 'svg' && r.re.test(text) : r.re.test(text)) warnings.push({ code: r.code, path, say: r.say });
      }
    } else {
      const got = sniff(f.bytes);
      if (!got || !(SNIFF_OK[ext] ?? []).includes(got)) { problems.push({ code: 'magic', path, say: '파일 이름(확장자)과 실제 내용이 달라요.' }); continue; }
    }
    total += role === 'content' ? size : 0;
    files.push({ path, ext, mime, size, role });
  }
  if (total > lim.maxTotalBytes) problems.push({ code: 'total-too-big', path: '', say: `전체 크기가 ${Math.floor(lim.maxTotalBytes / 1024 / 1024)}MB 를 넘어요.` });
  if (type === 'game') {
    if (!contents.some(f => ['html', 'htm'].includes(extOf(String(f.path))))) problems.push({ code: 'no-entry', path: '', say: '게임을 여는 HTML 파일(예: index.html)이 필요해요.' });
    if (files.some(f => ['js', 'mjs', 'html', 'htm', 'wasm'].includes(f.ext))) warnings.unshift({ code: 'runs-code', path: '', say: '이 게임은 코드를 실행해요. ' + SCRIPT_NOTICE });
  }
  return { ok: problems.length === 0, files, problems, warnings, totalBytes: total };
}
