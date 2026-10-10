/* 라비 감정 → 화면. 엔진(ravi-emotion.ts)이 낸 Display 하나를 크기에 맞게 그린다.
 *
 *  - 얼굴: paintEmotionFace(기존 표정 + 덧그림)
 *  - 움직임: 스프링 곡선을 샘플링한 WAAPI 1회. 새 감정이 오면 지금 위치에서 끊고 다시 간다(중단 가능).
 *            동작 줄이기면 움직이지 않는다(덧그림 투명도만). serious 감정은 움직이지 않는다.
 *  - 말풍선: CSS transition(열림/닫힘), 크기별 full/line/none.
 *  - 낭독: 한 앱에 live region 하나, 같은 말 반복 금지, 경고가 아니면 8초에 한 번까지.
 *  - 소리: 슬롯 id 만 호스트에게 넘긴다(파일 없음).
 */
import "./ravi-emotion.css";
import { emotionText } from "./ravi-emotion-copy";
import { paintEmotionFace } from "./ravi-face-emotion";
import { expressionFor, MOTION_SPEC, type Display, type SizeName, type Glyph, type RaviEmotionEngine, type Motion } from "./ravi-emotion";
import type { RaviMood } from "./ravi-face";
import type { SoundSlot } from "./ravi-emotion-rules";

/** 감쇠 스프링(Apple: damping ratio·response) — 1 에서 0 으로 가라앉는 값을 n 개 뽑는다. */
export function springSamples(damping: number, response: number, durationMs: number, n = 24): number[] {
  const w = (2 * Math.PI) / response; // 고유 진동수
  const out: number[] = [];
  for (let i = 0; i <= n; i++) {
    const t = (i / n) * (durationMs / 1000);
    let x: number;
    if (damping >= 1) x = (1 + w * t) * Math.exp(-w * t);
    else { const wd = w * Math.sqrt(1 - damping * damping); x = Math.exp(-damping * w * t) * (Math.cos(wd * t) + (damping * w / wd) * Math.sin(wd * t)); }
    out.push(i === n ? 0 : x);
  }
  return out;
}

/** 움직임마다 「1 에서 0 으로」의 의미(얼마나 기울고 뜨는가). 작게 — 과장 금지. */
const MOTION_SHAPE: Record<Exclude<Motion, "none">, (v: number) => string> = {
  nod: v => `translateY(${(2.5 * v).toFixed(2)}px) rotate(${(3 * v).toFixed(2)}deg)`,
  bounce: v => `translateY(${(-5 * v).toFixed(2)}px)`,
  sparkle: v => `translateY(${(-4 * v).toFixed(2)}px) scale(${(1 + .04 * v).toFixed(3)})`,
  sway: v => `rotate(${(-4 * v).toFixed(2)}deg)`,
  droop: v => `translateY(${(3 * (1 - Math.abs(v - .5) * 2) ).toFixed(2)}px)`,
  settle: v => `scale(${(1 - .025 * v).toFixed(3)})`,
};

const running = new WeakMap<Element, Animation>();
const lastStart = new WeakMap<Element, number>();

/** 얼굴 한 번 움직이기. 앞선 움직임은 지금 위치에서 끊는다. 600ms 안에 또 오면 건너뛴다. */
export function playMotion(el: HTMLElement, motion: Motion, reduced: boolean): Animation | null {
  if (motion === "none" || reduced || typeof el.animate !== "function") return null;
  const t = performance.now();
  if (t - (lastStart.get(el) ?? -Infinity) < 600) return null;
  lastStart.set(el, t);
  const spec = MOTION_SPEC[motion];
  if (!spec.spring) return null;
  const from = getComputedStyle(el).transform;
  running.get(el)?.cancel();
  const samples = motion === "droop" ? Array.from({ length: 25 }, (_, i) => i / 24) : springSamples(spec.spring.damping, spec.spring.response, spec.durationMs);
  const frames: Keyframe[] = samples.map(v => ({ transform: MOTION_SHAPE[motion](v) }));
  // 중단 가능: 앞선 움직임의 「지금 위치」에서 시작한다.
  if (from && from !== "none") frames[0] = { transform: from };
  const anim = el.animate(frames, { duration: spec.durationMs, easing: "linear", composite: "replace" });
  running.set(el, anim);
  anim.onfinish = () => { if (running.get(el) === anim) running.delete(el); };
  return anim;
}

const GLYPH_SVG: Record<Glyph, string> = {
  dot: '<svg viewBox="0 0 10 10" aria-hidden="true"><circle cx="5" cy="5" r="3" fill="currentColor"/></svg>',
  heart: '<svg viewBox="0 0 10 10" aria-hidden="true"><path d="M5 9C2 7 .5 5.6.5 3.8A2.2 2.2 0 015 2.6a2.2 2.2 0 014.5 1.2C9.5 5.6 8 7 5 9z" fill="currentColor"/></svg>',
  ring: '<svg viewBox="0 0 10 10" aria-hidden="true"><circle cx="5" cy="5" r="3.4" fill="none" stroke="currentColor" stroke-width="1.8"/></svg>',
  triangle: '<svg viewBox="0 0 10 10" aria-hidden="true"><path d="M5 1l4.4 8H.6z" fill="currentColor"/></svg>',
  moon: '<svg viewBox="0 0 10 10" aria-hidden="true"><path d="M6.5 1a4 4 0 100 8 4.2 4.2 0 01-2-4 4.2 4.2 0 012-4z" fill="currentColor"/></svg>',
};
export function glyphElement(glyph: Glyph, className = "rv-emo-dot"): HTMLElement {
  const span = document.createElement("span");
  span.className = className;
  span.dataset.glyph = glyph;
  span.innerHTML = GLYPH_SVG[glyph];
  return span;
}

// ── 낭독(한 앱에 하나) ───────────────────────────────────────────
let live: HTMLElement | null = null, lastSaid = "", lastSaidAt = -Infinity;
export const ANNOUNCE_GAP_MS = 8000;
export function announce(text: string, urgent: boolean, now = performance.now()): boolean {
  if (!text || text === lastSaid && now - lastSaidAt < 30000) return false;
  if (!urgent && now - lastSaidAt < ANNOUNCE_GAP_MS) return false;
  if (!live || !live.isConnected) {
    live = document.createElement("p");
    live.className = "rv-emo-live";
    live.setAttribute("role", "status");
    live.setAttribute("aria-live", "polite");
    document.body.append(live);
  }
  live.textContent = text;
  lastSaid = text; lastSaidAt = now;
  return true;
}

export type ViewOptions = {
  size: SizeName;
  locale: () => string;
  reducedMotion?: () => boolean;
  /** 금액 가림 — 엔진이 이미 지웠지만 화면에서도 건수 문구를 쓰지 않는다(두 겹). */
  masked?: () => boolean;
  playSound?: (slot: SoundSlot) => void;
  /** 얼굴을 직접 칠하지 않고 맡길 때(큰 창은 setAllRaviMood 를 거친다). */
  setBaseMood?: (mood: RaviMood) => void;
};

/** 한 자리(카드·미니 창·대기화면)에 얼굴 + 말풍선을 붙인다. */
export function createEmotionView(host: HTMLElement, face: HTMLElement | null, options: ViewOptions) {
  host.classList.add("rv-emo-scope");
  const reduced = () => options.reducedMotion?.() ?? matchMedia("(prefers-reduced-motion: reduce)").matches;
  const bubble = document.createElement("p");
  bubble.className = "rv-emo-bubble";
  bubble.dataset.state = "closed";
  bubble.setAttribute("aria-hidden", "true"); // 낭독은 live region 한 곳에서만
  host.append(bubble);
  let hideTimer: ReturnType<typeof setTimeout> | null = null;

  function text(d: Display): string {
    const source = d.bubble ?? d.copy;
    if (!source) return "";
    const args = options.masked?.() ? [] : d.bubbleArgs;
    // 가림 켬인데 건수 문구가 왔다면(엔진 우회) 원문 대신 기본 문구 — {0} 을 그대로 두지 않는다.
    if (source.includes("{0}") && !args.length) return "";
    return emotionText(source, options.locale(), ...args);
  }

  function apply(d: Display) {
    const ex = expressionFor(d, options.size, reduced());
    host.dataset.tone = ex.tone;
    host.dataset.emotion = d.emotion;
    if (face) {
      if (ex.face !== "none") paintEmotionFace(face, d.emotion, ex.face === "full");
      if (d.fresh) playMotion(face, ex.motion, reduced());
    }
    options.setBaseMood?.(d.baseMood);
    const say = d.fresh && d.bubble ? text(d) : "";
    if (say && ex.bubble !== "none") {
      bubble.dataset.fit = ex.bubble;
      bubble.replaceChildren(glyphElement(ex.glyph, "rv-emo-glyph"), document.createTextNode(say));
      bubble.dataset.state = "open";
      if (hideTimer) clearTimeout(hideTimer);
      hideTimer = setTimeout(() => { bubble.dataset.state = "closed"; }, Math.max(3500, Math.min(9000, d.holdMs || 5000)));
    } else if (!d.copy || d.priority < 0) {
      bubble.dataset.state = "closed";
    }
    if (say) announce(say, d.urgent);
    if (d.sound) options.playSound?.(d.sound);
  }
  return { apply, bubble, destroy() { if (hideTimer) clearTimeout(hideTimer); bubble.remove(); host.classList.remove("rv-emo-scope"); } };
}

/** 엔진 하나를 화면 하나에 잇는다. 해제 함수 반환. */
export function bindEmotionView(engine: RaviEmotionEngine, view: ReturnType<typeof createEmotionView>): () => void {
  view.apply({ ...engine.current(), fresh: false });
  return engine.subscribe(d => view.apply(d));
}
