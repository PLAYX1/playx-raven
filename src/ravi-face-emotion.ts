/* 라비 얼굴 확장 — 기존 ravi-face.ts(RaviMood 9+3종)는 그대로 두고, 감정 엔진의 새 감정을
 * 「기존 표정 + 얇은 덧그림(overlay)」으로 그린다. 기존 이름·함수는 바꾸지 않는다.
 *
 * 덧그림 규칙: 같은 420×420 좌표, 선 색은 기존 눈(#1B1A25)·볼(#F28AA0) 그대로 — 캐릭터를 바꾸지 않는다.
 * 반짝임(celebrate)만 한 번 「팝」 하고 멈춘다(반복 없음). 나머지는 정지 그림.
 */
import { raviFace, setMood } from "./ravi-face";
import { BASE_MOOD, type RaviEmotion } from "./ravi-emotion";
import { EMOTION_LABEL } from "./ravi-emotion-rules";
import { t } from "./i18n";
import "./ravi-emotion-copy";

const INK = "#1B1A25", BLUSH = "#F28AA0", DROP = "#7FC6F0", STAR = "#FFD84A";

/** 진지한 눈 — 기본 그림의 「별 눈동자」는 들뜬 느낌이라 돈·보안 경고(calm·worried·apologetic)에서는 둥근 눈으로 덮는다. */
const PLAIN_EYES = `<g fill="#FBB67F"><ellipse cx="135" cy="240" rx="42" ry="40"/><ellipse cx="286" cy="240" rx="42" ry="40"/></g><g fill="${INK}"><circle cx="135" cy="242" r="25"/><circle cx="286" cy="242" r="25"/></g><g fill="#FFFFFF"><circle cx="144" cy="233" r="7"/><circle cx="295" cy="233" r="7"/></g>`;

/** 새 감정에만 덧그림이 있다. 기존 표정과 같은 감정은 빈 문자열. */
export const OVERLAY: Partial<Record<RaviEmotion, string>> = {
  // 축하 — 반짝이 셋, 한 번만 등장(rv-emo-pop: 1회).
  celebrate: `<g class="rv-emo-pop" fill="${STAR}"><path d="M58 128l8 18 18 8-18 8-8 18-8-18-18-8 18-8z"/><path d="M362 96l7 15 15 7-15 7-7 15-7-15-15-7 15-7z"/><path d="M372 300l5 11 11 5-11 5-5 11-5-11-11-5 11-5z"/></g>`,
  // 차분·진지 — 수평 눈썹. 놀람·웃음 없음.
  calm: PLAIN_EYES + `<g fill="none" stroke="${INK}" stroke-width="8" stroke-linecap="round"><path d="M104 204h62"/><path d="M255 204h62"/></g>`,
  // 미안함 — 처진 눈썹 + 반쯤 내린 눈꺼풀(기존 worried 의 땀방울 위에).
  worried: PLAIN_EYES + `<g fill="none" stroke="${INK}" stroke-width="8" stroke-linecap="round"><path d="M100 198l58 12"/><path d="M321 198l-58 12"/></g>`,
  apologetic: PLAIN_EYES + `<g fill="#FBB67F"><rect x="94" y="200" width="84" height="34" rx="14"/><rect x="245" y="200" width="84" height="34" rx="14"/></g><g fill="none" stroke="${INK}" stroke-width="8" stroke-linecap="round"><path d="M100 214l58-12"/><path d="M321 214l-58-12"/></g>`,
  // 기다림 — 머리 위 점 셋(움직이지 않음).
  waiting: `<g fill="#FFFFFF"><circle cx="322" cy="120" r="9"/><circle cx="350" cy="120" r="9"/><circle cx="378" cy="120" r="9"/></g>`,
  // 곤란함 — 한쪽 눈썹만 올라감 + 작은 땀.
  puzzled: `<g fill="none" stroke="${INK}" stroke-width="8" stroke-linecap="round"><path d="M104 210q30-18 60 0"/><path d="M257 206h58"/></g><path d="M356 188c0 0-12 17-12 25a12 12 0 0024 0c0-8-12-25-12-25z" fill="${DROP}"/>`,
  // 수줍음 — 볼 빗금 + 진한 볼.
  shy: `<g fill="${BLUSH}"><ellipse cx="110" cy="292" rx="26" ry="14"/><ellipse cx="312" cy="292" rx="26" ry="14"/></g><g stroke="#D2557A" stroke-width="5" stroke-linecap="round"><path d="M96 286l8-10"/><path d="M110 290l8-10"/><path d="M298 286l8-10"/><path d="M312 290l8-10"/></g>`,
  // 뿌듯함 — 머리 옆 작은 별 하나(정지).
  proud: `<path fill="${STAR}" d="M360 120l7 15 15 7-15 7-7 15-7-15-15-7 15-7z"/>`,
  // 안도(relieved)는 덧그림 없음 — 작은 숨 표시가 부리 옆 얼룩처럼 보여 뺐다(10-11 갤러리). 웃는 눈 + 차분한 문구로 구분.
};

/** 얼굴 하나를 감정으로 칠한다. detail=false 면 기본 표정만(미니 S·칩). */
export function paintEmotionFace(el: HTMLElement, emotion: RaviEmotion, detail = true): void {
  setMood(el, BASE_MOOD[emotion]);
  el.dataset.raviEmotion = emotion;
  el.setAttribute("aria-label", t(EMOTION_LABEL[emotion]));
  const svg = el.querySelector("svg");
  if (!svg) return;
  svg.querySelector(".rv-emo")?.remove();
  const overlay = detail ? OVERLAY[emotion] : "";
  if (overlay) {
    const g = document.createElementNS("http://www.w3.org/2000/svg", "g");
    g.setAttribute("class", "rv-emo");
    g.innerHTML = overlay;
    svg.append(g);
  }
}

/** 새 얼굴 하나(기존 raviFace 와 같은 모양 + 감정). */
export function emotionFace(emotion: RaviEmotion, size: number, options: { round?: boolean; detail?: boolean } = {}): HTMLElement {
  const el = raviFace(BASE_MOOD[emotion], size, options);
  paintEmotionFace(el, emotion, options.detail ?? size >= 28);
  return el;
}
