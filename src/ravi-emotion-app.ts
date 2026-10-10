/* 큰 창(main.ts)에 감정 엔진을 잇는 한 곳. main.ts 는 mountRaviEmotionApp(...) 한 번 + emitRaviEvent(...) 한 줄씩만.
 *
 *  - 기본 얼굴은 main.ts 의 setAllRaviMood 를 그대로 거친다(라비 홈·대화 아바타가 함께 바뀐다).
 *  - 덧그림·움직임은 화면에 보이는 .ravi-face 중 40px 이상에만(작은 칩은 기본 표정만).
 *  - 말풍선은 오른쪽 위에 떠 있고 클릭을 막지 않는다(pointer-events:none).
 *  - 밤·오래 안 씀은 여기서 본다(1분마다 한 번, 입력이 오면 「반가워요」).
 */
import { raviEmotion, emitRaviEvent, listenRaviEventBus, isNightHour, type RaviEmotion, type RaviEventName } from "./ravi-emotion";
import { createEmotionView, playMotion } from "./ravi-emotion-view";
import { paintEmotionFace, emotionFace } from "./ravi-face-emotion";
import { expressionFor } from "./ravi-emotion";
import { lang } from "./i18n";
import type { RaviMood } from "./ravi-face";
import type { SoundSlot } from "./ravi-emotion-rules";

export { emitRaviEvent };
export type { RaviEventName };

export type AppHooks = {
  setMood: (mood: RaviMood) => void;
  /** 감정이 없을 때 얼굴(열쇠 없으면 sleep, 있으면 normal). */
  rest: () => RaviMood;
  masked?: () => boolean;
  soundOn?: () => boolean;
  playSound?: (slot: SoundSlot) => void;
  idleMs?: number;
};

let mounted = false;
export function mountRaviEmotionApp(hooks: AppHooks): void {
  if (mounted || typeof document === "undefined") return;
  mounted = true;
  const restEmotion = (): RaviEmotion => (hooks.rest() === "sleep" ? "asleep" : "neutral");
  const engine = raviEmotion({ masked: hooks.masked, soundOn: hooks.soundOn ?? (() => false), rest: restEmotion,
    dnd: () => isNightHour(new Date().getHours()) });
  const reduced = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

  const float = document.createElement("div");
  float.className = "rv-emo-float";
  const speaker = emotionFace("neutral", 36, { round: true, detail: false });
  speaker.setAttribute("aria-hidden", "true");
  float.append(speaker);
  document.body.append(float);
  const view = createEmotionView(float, speaker, { size: "large", locale: () => lang, reducedMotion: reduced, masked: hooks.masked, playSound: hooks.playSound });

  engine.subscribe(d => {
    // 열쇠가 없을 때(잠든 라비)는 일상 감정(밤·졸림)이 잠을 깨우지 않는다.
    const sleepingRest = hooks.rest() === "sleep";
    const base: RaviMood = d.priority < 0 ? hooks.rest() : sleepingRest && d.priority === 0 && d.tone === "rest" ? "sleep" : d.baseMood;
    try { hooks.setMood(base); } catch { /* 얼굴 갱신 실패는 무시 */ }
    if (d.priority >= 0 && base === d.baseMood) {
      document.querySelectorAll<HTMLElement>(".ravi-face").forEach(face => {
        if (face.closest("#rv-profile-characters") || !face.isConnected) return;
        const size = face.getBoundingClientRect().width;
        if (size < 40) return; // 칩: 기본 표정만
        const ex = expressionFor(d, size >= 96 ? "large" : "medium", reduced());
        paintEmotionFace(face, d.emotion, true);
        if (d.fresh) playMotion(face, ex.motion, reduced());
      });
    }
    view.apply(d);
  });
  listenRaviEventBus(window);

  // 밤·오래 안 씀
  const idleMs = hooks.idleMs ?? 10 * 60_000;
  let lastInput = Date.now(), idle = false, night: boolean | null = null;
  const onInput = () => {
    lastInput = Date.now();
    if (idle) { idle = false; emitRaviEvent("user_return"); }
  };
  for (const type of ["pointerdown", "keydown"]) window.addEventListener(type, onInput, { passive: true });
  const tick = () => {
    const n = isNightHour(new Date().getHours());
    if (n !== night) { night = n; emitRaviEvent(n ? "night_start" : "night_end"); }
    if (!idle && Date.now() - lastInput > idleMs) { idle = true; emitRaviEvent("idle_long"); }
  };
  tick();
  setInterval(tick, 60_000);
}
