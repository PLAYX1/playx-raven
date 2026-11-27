/*
 * 「라비가 다 해 줄게요」(게임 올리기) 순수 규칙 — 이름·장르 짐작 · 설명 틀 · 빈 그림 알아보기 · 표지/미리보기 파일 이름. 화면·네트워크 없음(시험 가능). (2026-11-27)
 *
 * 🔴 짐작은 빈 칸만 채운다 — 판매자가 적은 것은 건드리지 않는다. 장르는 확실한 말이 있을 때만 바꾼다(없으면 null = 그대로).
 * 🔴 기술·게임 이름을 지어내지 않는다: 이름은 게임 HTML 의 <title> 또는 폴더 이름에서만.
 */
import type { ArcadeGenre } from "../core/creator/arcade-product";
import type { FolderScan } from "./arcade-upload-rules";
import { COVER_FILES, PREVIEW_FILES } from "./arcade-model";

const ENT: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", "#39": "'", nbsp: " " };

/** <title> 글(엔티티 몇 개만 풀고 공백 정리, 80자). 없으면 "". */
export function titleFromHtml(html: string | undefined): string {
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html ?? "");
  if (!m) return "";
  const s = m[1].replace(/&(#\d+|#x[0-9a-f]+|[a-z]+\d*);/gi, (all, e: string) => {
    const k = e.toLowerCase();
    if (k in ENT) return ENT[k];
    const n = k.startsWith("#x") ? parseInt(k.slice(2), 16) : k.startsWith("#") ? parseInt(k.slice(1), 10) : NaN;
    return Number.isFinite(n) && n > 31 && n < 0x110000 ? String.fromCodePoint(n) : all;
  }).replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  return [...s].slice(0, 80).join("");
}

/** 폴더 이름 → 사람이 읽는 이름: 「land-grab」 → 「Land Grab」 · 「game-7-beat-tap」 → 「Beat Tap」(앞 번호 칸은 뺀다). */
export function prettifyFolder(name: string): string {
  const words = name.normalize("NFC").replace(/[_\-.]+/g, " ").trim().split(/\s+/).filter(Boolean);
  // 「game 7 …」·「7 …」 같은 앞 번호는 이름이 아니다.
  if (words.length > 2 && /^game$/i.test(words[0]) && /^\d+$/.test(words[1])) words.splice(0, 2);
  while (words.length > 1 && /^\d+$/.test(words[0])) words.shift();
  return words.map((w) => (/^[a-z]/.test(w) ? w[0].toUpperCase() + w.slice(1) : w)).join(" ").slice(0, 80);
}

/** 이름 짐작: 시작 파일의 <title> → 폴더 이름. */
export function guessTitle(scan: Pick<FolderScan, "folder" | "htmlTexts">, entry: string): string {
  return titleFromHtml(scan.htmlTexts[entry]) || prettifyFolder(scan.folder);
}

/** 장르 낱말(영어 낱말은 경계로 · 한국어는 들어 있으면). 위에서부터 먼저 맞는 것 — 이름·폴더가 파일 이름보다 세다. */
const GENRE_WORDS: [ArcadeGenre, RegExp][] = [
  ["racing", /\b(race|racing|racer|kart|drift|car|cars)\b|레이스|레이싱|자동차|경주/],
  ["shooting", /\b(shoot|shooter|shooting|bullet|bullets|gun|blaster|invaders?)\b|슈팅|총알|비행기/],
  ["rhythm", /\b(rhythm|beat|beats|dance|piano|drum)\b|리듬|비트|박자/],
  ["puzzle", /\b(puzzle|puzzles|match3|match-3|tetris|sudoku|sokoban|2048|block|blocks)\b|퍼즐|블록|맞추기/],
  ["sports", /\b(soccer|football|basketball|golf|tennis|baseball|bowling|sport|sports|pingpong)\b|축구|농구|야구|골프|스포츠|볼링/],
  ["board", /\b(chess|card|cards|poker|board|solitaire|janggi|baduk|omok)\b|바둑|장기|카드|보드|체스|오목|화투/],
  ["adventure", /\b(adventure|quest|rpg|dungeon|explore)\b|모험|던전|탐험/],
  ["action", /\b(fight|fighter|ninja|slash|slice|platformer|runner|jump)\b|액션|격투|점프|달리기/],
  ["kids", /\b(kids|kid|child|children|toddler)\b|어린이|유아/],
  ["casual", /\b(tap|clicker|idle|casual|merge)\b|캐주얼|탭/],
];
/** 파일 이름에서 장르로 보지 않을 낱말(게임마다 흔한 소리·도구 파일). */
const FILE_NOISE = /\b(music|sound|sounds|audio|sfx|bgm|kit|lib|vendor|bridge)\b/g;

/** 장르 짐작. 확실한 말이 없으면 null(지금 고른 값 그대로). */
export function guessGenre(scan: Pick<FolderScan, "folder" | "files">, title: string): ArcadeGenre | null {
  const strong = `${title} ${scan.folder}`.toLowerCase().replace(/[_\-.]+/g, " ");
  for (const [g, re] of GENRE_WORDS) if (re.test(strong)) return g;
  const weak = scan.files.map((f) => f.path.replace(/\.[a-z0-9]+$/i, "")).join(" ").toLowerCase().replace(/[_\-./]+/g, " ").replace(FILE_NOISE, " ");
  for (const [g, re] of GENRE_WORDS) if (re.test(weak)) return g;
  return null;
}

/** 설명 틀(한국어 원문 — 화면이 tf 로 번역해 채운다: {0} 이름 · {1} 장르 · {2} 분). */
export const DESC_TEMPLATE = "{0} — {1} 게임이에요. 한 판 약 {2}분.";

/**
 * 거의 한 색인 그림인가(캡처가 비었을 때 — WebGL 버퍼 비움·검은 화면·로딩 화면 한 색). RGBA 바이트.
 * 밝기 표준편차가 작고(< 4) 색이 다른 점이 1% 아래면 빈 그림.
 */
export function isBlankImage(rgba: ArrayLike<number>, width: number, height: number): boolean {
  const n = Math.floor(rgba.length / 4);
  if (width < 1 || height < 1 || n < 1) return true;
  const step = Math.max(1, Math.floor(n / 4096));
  let count = 0, sum = 0, sum2 = 0, odd = 0;
  const r0 = rgba[0], g0 = rgba[1], b0 = rgba[2];
  for (let i = 0; i < n; i += step) {
    const r = rgba[i * 4], g = rgba[i * 4 + 1], b = rgba[i * 4 + 2], a = rgba[i * 4 + 3];
    const y = a === 0 ? 0 : 0.299 * r + 0.587 * g + 0.114 * b;
    count++; sum += y; sum2 += y * y;
    if (Math.abs(r - r0) + Math.abs(g - g0) + Math.abs(b - b0) > 30) odd++;
  }
  const mean = sum / count, sd = Math.sqrt(Math.max(0, sum2 / count - mean * mean));
  return sd < 4 && odd < count * 0.01;
}

/** 판매자가 넣어 둔 표지(맨 위 cover.png/webp/jpg). 없으면 null. */
export const ownCoverOf = (files: readonly { path: string }[]): string | null => COVER_FILES.find((n) => files.some((f) => f.path === n)) ?? null;
/** 폴더에 이미 있는 미리보기 영상. 없으면 null. */
export const ownPreviewOf = (files: readonly { path: string }[]): string | null => PREVIEW_FILES.find((n) => files.some((f) => f.path === n)) ?? null;
/** 녹화 결과 종류 → 쓸 파일 이름. 모르는 종류면 null. */
export function previewNameFor(mime: string): "preview.mp4" | "preview.webm" | null {
  const m = mime.toLowerCase().split(";")[0].trim();
  return m === "video/mp4" ? "preview.mp4" : m === "video/webm" ? "preview.webm" : null;
}
/** 바이트 앞머리가 그 종류인가(러스트 arcade_picked_write 와 같은 확인 — 보내기 전에 한 번 더). */
export function bytesLookLike(name: string, b: Uint8Array): boolean {
  if (name === "cover.jpg") return b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
  if (name === "preview.mp4") return b.length > 8 && b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70;
  if (name === "preview.webm") return b.length > 4 && b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3;
  return false;
}
/** 라비 표지·미리보기 크기 상한(러스트와 같게: 표지 1MB · 미리보기는 화면이 1.5MB 에서 자른다, 러스트 상한 2MB). */
export const MAKER_LIMITS = Object.freeze({ cover: 1024 * 1024, preview: 1.5 * 1024 * 1024 });

/** 그림 표지 색(장터 toneOf 0~4 와 같은 순서 — 보라 · 주황 · 초록 · 노랑 · 연보라). [위, 아래]. */
export const TONE_COLORS: readonly [string, string][] = [["#5b3fd6", "#2a1d72"], ["#f08a3c", "#a8461a"], ["#2f9e66", "#155c3a"], ["#e0a526", "#8a5a00"], ["#8f7bf0", "#4a3aa8"]];
