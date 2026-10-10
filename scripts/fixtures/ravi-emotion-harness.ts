// 감정 갤러리 하네스(실제 Chrome 에서 돈다) — 합성 이벤트만. 지갑·노드·IPC 없음.
import { createRaviEmotionEngine, type RaviEmotion, type RaviEventName, type Display } from "../../src/ravi-emotion";
import { createEmotionView, playMotion, springSamples, glyphElement } from "../../src/ravi-emotion-view";
import { emotionFace } from "../../src/ravi-face-emotion";
import { expressionFor } from "../../src/ravi-emotion";

export const SAMPLE_EVENT: Record<RaviEmotion, RaviEventName | null> = {
  neutral: null, happy: "deposit_confirmed", celebrate: "first_sale", fond: "follower_new", surprised: "deposit_seen",
  focused: "node_syncing", thinking: "ai_thinking", worried: "node_down", calm: "send_review", apologetic: "error_generic",
  sleepy: "night_start", asleep: null, welcome: "user_return", waiting: "key_missing", puzzled: "ai_unknown",
  shy: "user_thanks", proud: "backup_done", relieved: "node_recovered",
};

function displayFor(emotion: RaviEmotion): Display {
  const engine = createRaviEmotionEngine({ soundOn: () => false, rest: () => (emotion === "asleep" ? "asleep" : "neutral"), setTimer: () => 0, clearTimer: () => {} });
  const ev = SAMPLE_EVENT[emotion];
  return ev ? engine.emit(ev)! : { ...engine.current(), fresh: true };
}

type Size = "large" | "medium" | "mini-l" | "mini-s" | "chip";
const PX: Record<Size, number> = { large: 120, medium: 56, "mini-l": 28, "mini-s": 20, chip: 24 };

function cell(emotion: RaviEmotion, size: Size, locale: string, overrideText?: string) {
  const box = document.createElement("div");
  box.className = `cell cell-${size}`;
  const d = displayFor(emotion);
  const face = emotionFace(d.emotion, PX[size], { round: size !== "large", detail: size !== "mini-s" && size !== "chip" });
  const wrap = document.createElement("div");
  wrap.className = "stage";
  wrap.append(face);
  box.append(wrap);
  const view = createEmotionView(wrap, face, { size, locale: () => locale, reducedMotion: () => matchMedia("(prefers-reduced-motion: reduce)").matches });
  view.apply(overrideText ? { ...d, fresh: true, bubble: overrideText, copy: overrideText, bubbleArgs: [] } : d);
  if (size === "mini-s" || size === "chip") {
    const ex = expressionFor(d, size);
    wrap.prepend(glyphElement(ex.glyph));
  }
  const cap = document.createElement("small");
  cap.textContent = `${emotion} · ${size}`;
  box.append(cap);
  return box;
}

declare global { interface Window { renderGallery: (o: { locale: string; emotions: RaviEmotion[]; sizes: Size[]; texts?: Record<string, string> }) => void; springSamples: typeof springSamples; playMotion: typeof playMotion } }
window.springSamples = springSamples;
window.playMotion = playMotion;
window.renderGallery = ({ locale, emotions, sizes, texts }) => {
  const root = document.getElementById("gallery")!;
  root.replaceChildren();
  for (const emotion of emotions) {
    const row = document.createElement("section");
    row.className = "row";
    row.dataset.emotion = emotion;
    for (const size of sizes) row.append(cell(emotion, size, locale, texts?.[emotion]));
    root.append(row);
  }
};

declare global { interface Window { renderFaces: (px: number, emotions: RaviEmotion[]) => void } }
/** 표정만 크게 — 덧그림이 실제로 보이는지 대표가 한눈에 비교하는 판. */
window.renderFaces = (px, emotions) => {
  const root = document.getElementById("gallery")!;
  root.replaceChildren();
  const grid = document.createElement("section");
  grid.className = "faces";
  for (const emotion of emotions) {
    const fig = document.createElement("figure");
    fig.append(emotionFace(emotion, px, { detail: true }));
    const cap = document.createElement("figcaption");
    cap.textContent = emotion;
    fig.append(cap);
    grid.append(fig);
  }
  root.append(grid);
};

declare global { interface Window { renderLadder: (sizes: number[], emotions: RaviEmotion[], tray: string) => void } }
/** 크기 사다리 — 같은 표정을 176→16px 로 줄여 「작아도 귀여운가」를 본다. 맨 끝은 실제 트레이 아이콘(svg). */
window.renderLadder = (sizes, emotions, tray) => {
  const root = document.getElementById("gallery")!;
  root.replaceChildren();
  for (const emotion of emotions) {
    const row = document.createElement("section");
    row.className = "ladder";
    for (const px of sizes) row.append(emotionFace(emotion, px, { round: px <= 32, detail: px >= 28 }));
    const t = document.createElement("img");
    t.src = tray; t.width = 22; t.height = 22; t.alt = "tray"; t.className = "tray";
    const t16 = t.cloneNode() as HTMLImageElement; t16.width = t16.height = 16;
    row.append(t, t16);
    root.append(row);
  }
};
