/* 라비 작은 얼굴(16·20·22·24·32px) — 손맞춤 그림. 96px 이상 큰 얼굴(face.webp + 눈 덧그림)은 손대지 않는다.
 *
 * 왜 따로 그리나: 420px 그림을 16px 로 줄이면 눈이 2~3px 짜리 흐린 점이 되고, 부리(주황)·얼굴(살구)·
 * 리본(보라)·머리(남색)·배경(연보라)이 서로 비슷한 밝기라 뭉개진다. 그래서 작은 크기에서만
 *   ① 머리를 크게 잘라(몸통 버림) 그리고, ② 진남색 외곽선 1~2px 로 윤곽을 세우고,
 *   ③ 얼굴은 한 단계 밝은 살구로, 눈·눈썹·부리 테는 거의 검정(INK)으로 대비를 올리고,
 *   ④ 눈은 픽셀 격자에 맞춘 원(번짐 없음)으로 찍는다.
 * 라비 정체성(남색 머리·볏·보라 리본·주황 부리·별 눈)은 그대로 — 색은 같은 색상 계열에서 밝기만 조정.
 *
 * 좌표: 각 크기의 실제 픽셀 격자(viewBox = 0 0 n n). 형태는 32 단위 설계를 k=n/32 로 줄이고,
 * 눈·눈썹·표정은 픽셀 단위 비트맵으로 찍는다(shape-rendering: crispEdges).
 */
import type { RaviMood } from "./ravi-face";

export const SMALL_SIZES = [16, 20, 22, 24, 32] as const;
export type SmallSize = (typeof SMALL_SIZES)[number];
/** 작은 그림을 쓰는 상한(이 값 이하만). 33px 이상은 기존 경로 그대로. */
export const SMALL_MAX = 32;

/** 크기 → 그림 세트. 같은 크기가 있으면 그것, 없으면 바로 아래 세트(늘리지 않고 살짝 키움). */
export function smallBucket(size: number): SmallSize | null {
  if (!(size > 0) || size > SMALL_MAX) return null;
  let pick: SmallSize = 16;
  for (const s of SMALL_SIZES) if (s <= size) pick = s;
  return pick;
}

/** 색 — 큰 그림 face.webp 에서 뽑은 색상 계열 그대로, 밝기만 대비용으로 조정(값은 보고서 표). */
export const SMALL_COLORS = {
  outline: "#0E1028", // 진남색 외곽선(머리털과 같은 계열, 더 어둡게)
  hair: "#2F386E", // 큰 그림 머리 남색 그대로
  hairLight: "#3E508A", // 볏(큰 그림 볏 색 그대로)
  face: "#FFC896", // 큰 그림 살구 #FBB680 보다 한 단계 밝게(밝은 안쪽 면)
  beak: "#EC7D25", // 큰 그림 부리 주황 그대로
  ribbon: "#B98CF2", // 큰 그림 리본 보라 #6D4199 → 같은 보라를 밝게(남색 머리와 구별)
  ink: "#12101C", // 눈·눈썹·입 — 거의 검정
  white: "#FFFFFF",
  blush: "#F28AA0",
  heart: "#D8234F",
  drop: "#7FC6F0",
  star: "#FFD84A",
} as const;

type Px = [number, number];
type Layout = { n: SmallSize; d: number; lx: number; rx: number; cy: number; fw: number; ow: number };

/** 크기별 손맞춤 표. d=눈 지름(px), lx·rx·cy=눈 중심(짝수 지름은 정수, 홀수는 .5), fw=표정 선 굵기, ow=외곽선. */
const LAYOUT: Record<SmallSize, Layout> = {
  16: { n: 16, d: 4, lx: 5, rx: 11, cy: 9, fw: 1, ow: 1 },
  20: { n: 20, d: 5, lx: 6.5, rx: 13.5, cy: 11.5, fw: 1, ow: 1 },
  22: { n: 22, d: 5, lx: 7.5, rx: 14.5, cy: 12.5, fw: 1, ow: 1 },
  24: { n: 24, d: 6, lx: 8, rx: 16, cy: 13, fw: 2, ow: 1 },
  32: { n: 32, d: 8, lx: 10, rx: 22, cy: 17, fw: 2, ow: 1.5 },
};
export function smallLayout(n: SmallSize): Layout { return LAYOUT[n]; }

/* ---------- 픽셀 도우미 ---------- */
function disc(cx: number, cy: number, d: number): Px[] {
  const r = d / 2 + 0.05, out: Px[] = [];
  for (let y = Math.floor(cy - d / 2); y < cy + d / 2; y++)
    for (let x = Math.floor(cx - d / 2); x < cx + d / 2; x++)
      if ((x + 0.5 - cx) ** 2 + (y + 0.5 - cy) ** 2 <= r * r) out.push([x, y]);
  return out;
}
/** 고리의 위(up=true) 또는 아래 절반 — 웃는 눈 ∩, 감은 눈 ∪. t = 선 굵기. */
function arc(cx: number, cy: number, d: number, t: number, up: boolean): Px[] {
  const r = d / 2 + 0.05;
  const shift = up ? Math.ceil(d / 4) : -Math.ceil(d / 4); // 반원이 눈 칸 가운데 오게
  return disc(cx, cy, d).filter(([x, y]) => {
    const dy = y + 0.5 - cy, dist = Math.hypot(x + 0.5 - cx, dy);
    return dist > r - t - 0.05 && (up ? dy < 0.01 : dy > -0.01);
  }).map(([x, y]) => [x, y + shift] as Px);
}
/** 두 점 사이 선(굵기 t, 아래쪽으로 두껍게). */
function line(x0: number, y0: number, x1: number, y1: number, t: number): Px[] {
  const out: Px[] = [], steps = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0)) || 1;
  for (let i = 0; i <= steps; i++) {
    const x = Math.round(x0 + ((x1 - x0) * i) / steps), y = Math.round(y0 + ((y1 - y0) * i) / steps);
    for (let k = 0; k < t; k++) out.push([x, y + k]);
  }
  return out;
}
function heart(cx: number, cy: number, d: number): Px[] {
  // 지름별 손그림 하트(가로 = d+1). '#' = 칠함.
  const art: Record<number, string[]> = {
    4: [".#.#.", "#####", ".###.", "..#.."],
    5: [".##.##.", "#######", ".#####.", "..###..", "...#..."],
    6: [".##.##.", "#######", "#######", ".#####.", "..###..", "...#..."],
    8: [".##...##.", "####.####", "#########", "#########", ".#######.", "..#####..", "...###...", "....#...."],
  };
  const rows = art[d] ?? art[8];
  const w = rows[0].length, h = rows.length, x0 = Math.round(cx - w / 2), y0 = Math.round(cy - h / 2);
  const out: Px[] = [];
  rows.forEach((row, y) => [...row].forEach((c, x) => { if (c === "#") out.push([x0 + x, y0 + y]); }));
  return out;
}
function pathOf(px: Px[]): string {
  const seen = new Set<string>(), uniq: Px[] = [];
  for (const p of px) { const k = p.join(","); if (!seen.has(k)) { seen.add(k); uniq.push(p); } }
  uniq.sort((a, b) => a[1] - b[1] || a[0] - b[0]);
  let d = "", i = 0;
  while (i < uniq.length) { // 가로로 이어진 칸은 한 사각형으로
    const [x, y] = uniq[i]; let w = 1;
    while (i + w < uniq.length && uniq[i + w][1] === y && uniq[i + w][0] === x + w) w++;
    d += `M${x} ${y}h${w}v1h-${w}z`; i += w;
  }
  return d;
}
const fill = (px: Px[], color: string) => (px.length ? `<path fill="${color}" d="${pathOf(px)}"/>` : "");

function inside(x: number, y: number, pts: number[][]): boolean {
  let hit = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [a, b] = pts[i], [c, e] = pts[j];
    if ((b > y) !== (e > y) && x < ((c - a) * (y - b)) / (e - b) + a) hit = !hit;
  }
  return hit;
}
/* ---------- 바탕(머리·얼굴·부리·리본) ---------- */
const P = (pts: number[][], k: number) => pts.map(([x, y]) => `${+(x * k).toFixed(2)},${+(y * k).toFixed(2)}`).join(" ");
/** 32 단위 설계(큰 그림 420 → 32 를 머리 중심으로 약 1.15배 당겨 자름). 배경은 양옆·위로 조금 보이고, 아래는 주황 몸통. */
const HEAD = [[4.4, 24.6], [3.4, 17.5], [5.2, 11], [9.4, 7.4], [16, 6.2], [22.6, 7.4], [26.8, 11], [28.6, 17.5], [27.6, 24.6], [22, 27.4], [10, 27.4]];
const BODY = [[5, 23], [27, 23], [31.5, 33], [0.5, 33]];
const FACET = [[16, 6.2], [22.6, 7.4], [26.8, 11], [19.5, 12]];
const TUFT = [[13.6, 7.6], [15.4, 0.2], [17.4, 4.6], [21.6, 2.8], [19.8, 8]];
/** 얼굴 살구: 두 눈 둘레가 위로 볼록, 가운데는 남색 V 홈(부리 위). */
const FACE = [[5.4, 21.5], [5.6, 15], [7.6, 11.8], [11.5, 11.2], [14.6, 12.8], [16, 15.4], [17.4, 12.8], [20.5, 11.2], [24.4, 11.8], [26.4, 15], [26.6, 21.5], [23.4, 25], [16, 26.4], [8.6, 25]];
const RIBBON_L = [[8, 11.4], [2.2, 7.6], [2.8, 15.4]];
const RIBBON_R = [[8, 11.4], [13.6, 8.2], [13, 14.6]];

function base(n: SmallSize, mood: string): string {
  const L = LAYOUT[n], k = n / 32, ow = L.ow, C = SMALL_COLORS;
  // 외곽선은 도형 바깥으로만(paint-order: stroke) — 작은 리본·볏의 안쪽 색이 먹히지 않게.
  const st = `stroke="${C.outline}" stroke-width="${ow * 2}" stroke-linejoin="round" paint-order="stroke"`;
  // 부리는 두 눈 사이·아래(눈과 1px 이상 떨어져 보이게 크기별로 맞춤).
  const by = Math.max(19.8 * k, L.cy + L.d / 2 - (n >= 24 ? 1.5 : 1));
  const bw = Math.min(3.2 * k, (L.rx - L.lx - L.d) / 2 + 0.6), bh = 4.6 * k;
  const open = mood === "surprised";
  const f = (v: number) => +v.toFixed(2);
  const beak = `${f(16 * k - bw)},${f(by)} ${f(16 * k + bw)},${f(by)} ${f(16 * k)},${f(by + bh + (open ? 0.6 : 0))}`;
  return [
    `<polygon fill="${C.beak}" ${st} points="${P(BODY, k)}"/>`,
    `<polygon fill="${C.hairLight}" ${st} points="${P(TUFT, k)}"/>`,
    `<polygon fill="${C.hair}" ${st} points="${P(HEAD, k)}"/>`,
    n >= 22 ? `<polygon fill="${C.hairLight}" points="${P(FACET, k)}"/>` : "", // 큰 그림의 깎은 면(로우폴리) 한 조각
    `<polygon fill="${C.face}" points="${P(FACE, k)}"/>`,
    `<polygon fill="${C.beak}" stroke="${C.ink}" stroke-width="${n >= 24 ? 2 : 1.5}" stroke-linejoin="round" paint-order="stroke" points="${beak}"/>`,
    open ? `<path fill="${C.ink}" d="M${f(16 * k - bw * .55)} ${f(by + 1)}h${f(bw * 1.1)}l-${f(bw * .55)} ${f(bh * .45)}z"/>` : "",
    // 리본: 밝은 보라 + 진남색 테(테가 머리와 리본 사이 틈 역할)
    `<g fill="${C.ribbon}" ${st}><polygon points="${P(RIBBON_L, k)}"/><polygon points="${P(RIBBON_R, k)}"/></g>`,
    `<circle fill="${C.ribbon}" ${st} cx="${f(8 * k)}" cy="${f(11.4 * k)}" r="${f(Math.max(0.9, 1.5 * k))}"/>`,
  ].join("");
}

/* ---------- 표정(눈·눈썹) ---------- */
type SmallMood = RaviMood | "calm";
function eyesFor(n: SmallSize, mood: SmallMood): string {
  const L = LAYOUT[n], { d, lx, rx, cy, fw } = L, C = SMALL_COLORS;
  const ink: Px[] = [], white: Px[] = [], extra: string[] = [], cover: Px[] = [];
  const top = Math.floor(cy - d / 2); // 눈 맨 윗줄
  const sparkle = (cx: number, star: boolean): Px[] => {
    // 별 눈 정체성: 32px 은 + 모양 별, 그 아래는 한 칸 반짝임(오른쪽 위).
    if (star && d >= 8) { const x = Math.floor(cx), y = Math.floor(cy) - 1; return [[x, y - 1], [x - 1, y], [x, y], [x + 1, y], [x, y + 1]]; }
    const x = Math.floor(cx + d / 4 - 0.01), y = top + 1;
    return star && d >= 6 ? [[x, y], [x - 1, y + 1]] : [[x, y]];
  };
  const inFace = ([x, y]: Px) => inside((x + 0.5) * 32 / n, (y + 0.5) * 32 / n, FACE);
  const brow = (cx: number, side: -1 | 1, kind: "stern" | "flat" | "up") => {
    // side -1 = 왼눈, +1 = 오른눈. stern = 안쪽이 낮음(진지·걱정), up = 놀람(높이 뜸).
    // 눈썹은 살구 얼굴 안에 들어오는 칸만 찍는다(남색 머리 위 검정 눈썹은 안 보이므로).
    const x0 = Math.floor(cx - d / 2), x1 = Math.ceil(cx + d / 2) - 1;
    const yb = top - 1 - fw - (kind === "up" ? 1 : 0);
    const outer = side < 0 ? x0 : x1, inner = side < 0 ? x1 : x0;
    const drop = kind === "stern" ? Math.max(1, Math.round(d / 4)) : 0;
    ink.push(...line(outer, yb - drop, inner, yb, fw).filter(inFace));
  };
  /** 눈 윗부분을 깎는다(살구로 덮음) — stern: 안쪽이 더 깎임(걱정·진지), flat: 수평으로(차분). */
  const lid = (cx: number, side: -1 | 1, kind: "stern" | "flat") => {
    const x0 = Math.floor(cx - d / 2), w = Math.ceil(cx + d / 2) - x0;
    for (const [x, y] of disc(cx, cy, d)) {
      const t = side < 0 ? (x - x0) / (w - 1) : 1 - (x - x0) / (w - 1); // 0 = 바깥, 1 = 안쪽
      const cut = kind === "flat" ? Math.max(1, Math.round(d / 5)) : Math.round(t * Math.max(1, Math.round(d / 3)));
      if (y < top + cut) cover.push([x, y]);
    }
  };
  const both = (f: (cx: number, side: -1 | 1) => void) => { f(lx, -1); f(rx, 1); };
  switch (mood) {
    case "happy":
      both(cx => ink.push(...arc(cx, cy, d, fw, true)));
      if (n >= 20) both((cx, s) => extra.push(fill(disc(cx + s * 1, cy + d / 2 + 1.5, Math.max(2, d - 3)), C.blush)));
      break;
    case "sleep": case "sleepy":
      both(cx => ink.push(...arc(cx, cy, d, fw, false)));
      if (mood === "sleep" && n >= 20) { // 작은 z 하나(오른쪽 위, 흰색 — 남색 머리 위라 대비 큼)
        const x = n - 1 - Math.round(n / 5), y = 1;
        const z = Math.max(3, Math.round(n / 7));
        white.push(...line(x, y, x + z - 1, y, 1), ...line(x + z - 1, y, x, y + z - 1, 1), ...line(x, y + z - 1, x + z - 1, y + z - 1, 1));
      }
      break;
    case "worried": case "calm":
      // 진지한 눈: 별 반짝임 없음, 둥근 눈 + 굵은 눈썹(걱정은 안쪽이 내려가 단단하게, 차분은 수평).
      both(cx => ink.push(...disc(cx, cy, d)));
      both((cx, s) => lid(cx, s, mood === "worried" ? "stern" : "flat"));
      both(cx => white.push(...sparkle(cx, false).map(([x, y]) => [x, y + 1] as Px)));
      both((cx, s) => brow(cx, s, mood === "worried" ? "stern" : "flat"));
      if (mood === "worried" && n >= 24) extra.push(`<path fill="${C.drop}" stroke="${C.outline}" stroke-width="1" d="M${n - 3.5} ${Math.round(n * .16)}c0 0-2.2 3-2.2 4.4a2.2 2.2 0 004.4 0c0-1.4-2.2-4.4-2.2-4.4z"/>`);
      break;
    case "surprised":
      // 놀람: 큰 눈(흰 테는 24px 이상만 — 그 아래는 흰 면이 눈을 지워 버린다) + 높이 뜬 눈썹 + 벌린 부리.
      both(cx => {
        const eye = disc(cx, cy, d), k = new Set(eye.map(p => p.join(",")));
        ink.push(...eye);
        if (d >= 5) white.push(...disc(cx, cy, d + 2).filter(p => !k.has(p.join(",")))); // 흰 테
        else white.push(...disc(cx, cy, 2)); // 16px: 가운데를 비운 「o」 눈
      });
      both(cx => white.push(...sparkle(cx, false)));
      both((cx, s) => brow(cx, s, "up"));
      break;
    case "love":
      both(cx => extra.push(fill(heart(cx, cy, d), C.heart)));
      both(cx => { const h = heart(cx, cy, d); const [x, y] = h[1]; white.push([x, y + 1]); });
      break;
    case "thinking": case "focused": case "working":
      // 생각: 눈동자를 오른쪽 위로(흰자는 눈 크기 그대로, 눈동자는 그보다 1~2px 작게).
      both(cx => {
        const pupil = disc(cx + (d >= 6 ? 1 : 0.5), cy - (d >= 6 ? 1 : 0.5), d - (d >= 6 ? 2 : 1)), k = new Set(pupil.map(p => p.join(",")));
        ink.push(...pupil); white.push(...disc(cx, cy, d).filter(p => !k.has(p.join(","))));
      });
      if (mood === "focused" || mood === "working") both((cx, s) => brow(cx, s, "flat"));
      break;
    case "wink":
      ink.push(...disc(lx, cy, d)); white.push(...sparkle(lx, true));
      ink.push(...arc(rx, cy, d, fw, true));
      break;
    default: // normal · wake
      both(cx => ink.push(...disc(cx, cy, d)));
      both(cx => white.push(...sparkle(cx, true)));
      if (mood === "wake" && n >= 24) extra.push(`<path fill="${C.star}" stroke="${C.outline}" stroke-width="1" d="M${n - 4} 1.5l1 2.2 2.2 1-2.2 1-1 2.2-1-2.2-2.2-1 2.2-1z"/>`);
  }
  // 흰 칸은 같은 자리 검정 칸을 지운다(눈동자 반짝임).
  const w = new Set([...white, ...cover].map(p => p.join(",")));
  const inkOnly = ink.filter(p => !w.has(p.join(",")));
  return `<g shape-rendering="crispEdges">${fill(cover, C.face)}${fill(inkOnly, C.ink)}${fill(white, C.white)}</g>` + extra.join("");
}

export type SmallSvgParts = { base: string; mood: string };
/** 작은 얼굴 두 겹: base(캐릭터 색 필터가 먹는 몸통) · mood(필터 없이 눈·표정). 둘 다 viewBox 0 0 n n. */
export function smallFaceSvg(mood: SmallMood, n: SmallSize): SmallSvgParts {
  return { base: base(n, mood), mood: eyesFor(n, mood) };
}
/** 한 장짜리 SVG 문자열(갤러리·파일 출력용). bg 를 주면 배경 칸을 깐다. */
export function smallFaceSvgString(mood: SmallMood, n: SmallSize, bg?: string): string {
  const p = smallFaceSvg(mood, n);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n} ${n}" width="${n}" height="${n}">${bg ? `<rect width="${n}" height="${n}" fill="${bg}"/>` : ""}${p.base}${p.mood}</svg>`;
}
export type { SmallMood };
