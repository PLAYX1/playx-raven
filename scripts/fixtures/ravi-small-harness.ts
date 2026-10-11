// 라비 작은 얼굴 갤러리 하네스(실제 Chrome) — 변경 전(ravi-face-before.ts = f584be9 원본 사본) vs 지금.
// 합성 데이터만. 지갑·노드·네트워크 없음.
import { raviFace as beforeFace, type RaviMood } from "./ravi-face-before";
import { raviFace as afterFace } from "../../src/ravi-face";
import { emotionFace } from "../../src/ravi-face-emotion";
import type { RaviEmotion } from "../../src/ravi-emotion";

export const MOODS: RaviMood[] = ["normal", "happy", "worried", "sleep", "surprised", "love", "thinking", "wink", "wake", "sleepy", "focused", "working"];
export const SIZES = [16, 20, 22, 24, 32];
export const BIG = [33, 36, 40, 44, 50, 56, 64, 96, 116, 120, 150];

function cell(which: "before" | "after", mood: RaviMood, size: number, round = false): HTMLElement {
  const c = document.createElement("span");
  c.className = "cell";
  Object.assign(c.dataset, { which, mood, size: String(size) });
  c.append((which === "before" ? beforeFace : afterFace)(mood, size, { round }));
  return c;
}

declare global { interface Window {
  sheet: (root: HTMLElement, o: { which: "before" | "after"; moods?: RaviMood[]; round?: boolean }) => void;
  emotions: (root: HTMLElement) => void;
  bigSame: () => { size: number; mood: string; same: boolean }[];
} }

window.sheet = (root, { which, moods = MOODS, round = false }) => {
  root.replaceChildren();
  const grid = document.createElement("div");
  grid.className = "sheet";
  grid.style.gridTemplateColumns = `48px repeat(${moods.length}, 40px)`;
  grid.append(Object.assign(document.createElement("b"), { textContent: which === "before" ? "전" : "후" }));
  for (const m of moods) grid.append(Object.assign(document.createElement("small"), { textContent: m }));
  for (const s of SIZES) {
    grid.append(Object.assign(document.createElement("small"), { textContent: `${s}px` }));
    for (const m of moods) grid.append(cell(which, m, s, round));
  }
  root.append(grid);
};

/** 돈·보안 경고 감정(calm·worried·apologetic)과 들뜬 감정의 작은 크기 모습(감정 엔진 경로). */
window.emotions = root => {
  root.replaceChildren();
  const list: RaviEmotion[] = ["neutral", "calm", "worried", "apologetic", "happy", "celebrate", "surprised", "asleep"];
  const grid = document.createElement("div");
  grid.className = "sheet";
  grid.style.gridTemplateColumns = `48px repeat(${list.length}, 64px)`;
  grid.append(document.createElement("b"));
  for (const e of list) grid.append(Object.assign(document.createElement("small"), { textContent: e }));
  for (const s of [20, 24, 32]) {
    grid.append(Object.assign(document.createElement("small"), { textContent: `${s}px` }));
    for (const e of list) { const c = document.createElement("span"); c.className = "cell"; c.append(emotionFace(e, s, { round: true, detail: s >= 28 })); grid.append(c); }
  }
  root.append(grid);
};

/** 33px 이상: 변경 전·후 DOM 이 글자 하나까지 같은지. */
window.bigSame = () => {
  const out: { size: number; mood: string; same: boolean }[] = [];
  for (const size of BIG) for (const mood of MOODS) for (const round of [false, true]) {
    const a = beforeFace(mood, size, { round }).outerHTML, b = afterFace(mood, size, { round }).outerHTML;
    out.push({ size, mood: `${mood}${round ? "·round" : ""}`, same: a === b });
  }
  return out;
};
declare global { interface Window { __before: typeof beforeFace; __after: typeof afterFace } }
window.__before = beforeFace;
window.__after = afterFace;
import { smallFaceSvgString, type SmallSize } from "../../src/ravi-face-small";
/** 색 트레이(윈도우·리눅스)용: 작은 그림을 투명 바탕 RGBA 로. alert = 오른쪽 위 주황빨강 점(흰 테). */
declare global { interface Window { trayRgba: (n: SmallSize, variant: "normal" | "alert" | "sleep") => Promise<number[]> } }
window.trayRgba = async (n, variant) => {
  let svg = smallFaceSvgString(variant === "sleep" ? "sleep" : "normal", n);
  if (variant === "alert") { const r = Math.max(2.5, n * 0.17); svg = svg.replace("</svg>", `<circle cx="${n - r - 0.5}" cy="${r + 0.5}" r="${r}" fill="#ED6345" stroke="#FFFFFF" stroke-width="1"/></svg>`); }
  const img = new Image();
  img.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
  await img.decode();
  const c = document.createElement("canvas"); c.width = c.height = n;
  const g = c.getContext("2d")!; g.drawImage(img, 0, 0, n, n);
  return [...g.getImageData(0, 0, n, n).data];
};
/** 16~32px: 그림만 바뀌고 겉(클래스·크기·모서리·라벨·data-mood·rv-bob)은 변경 전과 같아야 한다. 감정 경로(emotionFace)도. */
declare global { interface Window { smallApiSame: () => { size: number; mood: string; same: boolean; why: string }[] } }
window.smallApiSame = () => {
  const outer = (el: HTMLElement) => JSON.stringify([el.className, el.style.width, el.style.height, el.style.borderRadius, el.getAttribute("role"), el.getAttribute("aria-label"), el.dataset.mood, el.dataset.raviMood]);
  const out: { size: number; mood: string; same: boolean; why: string }[] = [];
  for (const size of [12, 16, 18, 20, 22, 24, 28, 32]) for (const mood of MOODS) for (const round of [false, true]) {
    const a = outer(beforeFace(mood, size, { round })), b = outer(afterFace(mood, size, { round }));
    out.push({ size, mood, same: a === b, why: a === b ? "" : `${a} ≠ ${b}` });
  }
  return out;
};
