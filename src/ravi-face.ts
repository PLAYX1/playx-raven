/** RaviFace: v2 RaviFace.dc.html eye geometry and motion. */
export type RaviMood = "normal" | "sleep" | "happy" | "surprised" | "thinking" | "worried" | "love" | "wink" | "wake";
export const RAVI_CHARACTERS = [
  { id: "basic", name: "기본", image: "/ravi/face.webp", background: "#EFEAF8", filter: "none" },
  { id: "dawn", name: "새벽", image: "/ravi/face.webp", background: "#DDE8F7", filter: "hue-rotate(-40deg)" },
  { id: "forest", name: "숲", image: "/ravi/face.webp", background: "#DCEFE3", filter: "hue-rotate(-110deg)" },
  { id: "ember", name: "불씨", image: "/ravi/face.webp", background: "#FBE7DA", filter: "hue-rotate(120deg) saturate(1.3)" },
  { id: "sea", name: "바다", image: "/ravi/face.webp", background: "#D9EEF0", filter: "hue-rotate(-70deg) saturate(1.2)" },
  { id: "blossom", name: "벚꽃", image: "/ravi/face.webp", background: "#F9E1EA", filter: "hue-rotate(60deg)" },
  { id: "ink", name: "먹", image: "/ravi/face.webp", background: "#E4E4E8", filter: "grayscale(1) contrast(1.1)" },
  { id: "gold", name: "황금", image: "/ravi/face.webp", background: "#F6EBC8", filter: "hue-rotate(160deg) saturate(1.4)" },
] as const;
const names: Record<RaviMood, string> = { normal: "라비", sleep: "자는 라비", happy: "웃는 라비", surprised: "깜짝 놀란 라비", thinking: "생각하는 라비", worried: "걱정하는 라비", love: "좋아하는 라비", wink: "윙크하는 라비", wake: "막 깬 라비" };
function eyes(m: RaviMood): string {
  const cover = ["sleep", "happy", "thinking", "surprised", "love"].includes(m)
    ? '<g fill="#FBB67F"><ellipse cx="135" cy="240" rx="42" ry="40"/><ellipse cx="286" cy="240" rx="42" ry="40"/></g>' : "";
  const normal = ["normal", "wake", "worried"].includes(m)
    ? '<g fill="#FBB67F"><rect class="rv-lid" x="94" y="200" width="84" height="80" rx="30"/><rect class="rv-lid rv-lid2" x="245" y="200" width="84" height="80" rx="30"/></g>' : "";
  const extras: Record<RaviMood, string> = {
    normal: "",
    sleep: '<g fill="none" stroke="#2A2340" stroke-width="8" stroke-linecap="round"><path d="M105 238q30 22 60 0"/><path d="M256 238q30 22 60 0"/></g><g fill="#2A2340" font-family="system-ui, sans-serif" font-weight="800"><text class="rv-z" x="330" y="150" font-size="34">z</text><text class="rv-z rv-z2" x="340" y="140" font-size="44">Z</text><text class="rv-z rv-z3" x="350" y="130" font-size="28">z</text></g>',
    happy: '<g fill="none" stroke="#1B1A25" stroke-width="9" stroke-linecap="round"><path d="M105 250q30 -34 60 0"/><path d="M256 250q30 -34 60 0"/></g><g fill="#F28AA0" opacity="0.75"><ellipse cx="110" cy="292" rx="22" ry="12"/><ellipse cx="312" cy="292" rx="22" ry="12"/></g>',
    surprised: '<g class="rv-pop"><circle cx="135" cy="240" r="44" fill="#FFFFFF"/><circle cx="135" cy="240" r="30" fill="#1B1A25"/><path d="M135 222l5 11 12 1-9 8 3 12-11-6-11 6 3-12-9-8 12-1z" fill="#FFFFFF"/></g><g class="rv-pop"><circle cx="286" cy="240" r="44" fill="#FFFFFF"/><circle cx="286" cy="240" r="30" fill="#1B1A25"/><path d="M286 222l5 11 12 1-9 8 3 12-11-6-11 6 3-12-9-8 12-1z" fill="#FFFFFF"/></g><g fill="#FFD84A" class="rv-pop"><path d="M60 150l8 18 18 8-18 8-8 18-8-18-18-8 18-8z"/><path d="M370 120l6 13 13 6-13 6-6 13-6-13-13-6 13-6z"/></g>',
    thinking: '<g><circle cx="135" cy="240" r="32" fill="#FFFFFF"/><circle cx="147" cy="228" r="17" fill="#1B1A25"/><circle cx="286" cy="240" r="32" fill="#FFFFFF"/><circle cx="298" cy="228" r="17" fill="#1B1A25"/></g><g fill="#FFFFFF"><circle class="rv-t1" cx="330" cy="120" r="10"/><circle class="rv-t2" cx="358" cy="96" r="13"/><circle class="rv-t3" cx="390" cy="66" r="16"/></g>',
    worried: '<g fill="none" stroke="#1B1A25" stroke-width="8" stroke-linecap="round"><path d="M100 196l58 14"/><path d="M321 196l-58 14"/></g><path d="M352 196c0 0 -16 22 -16 32a16 16 0 0032 0c0-10-16-32-16-32z" fill="#7FC6F0"/>',
    love: '<g class="rv-pop" fill="#E2436B"><path d="M135 272c-30-20-46-36-46-54a22 22 0 0146-8a22 22 0 0146 8c0 18-16 34-46 54z"/><path d="M286 272c-30-20-46-36-46-54a22 22 0 0146-8a22 22 0 0146 8c0 18-16 34-46 54z"/></g>',
    wink: '<g fill="#FBB67F"><ellipse cx="286" cy="240" rx="42" ry="40"/></g><path d="M256 246q30 -26 60 0" fill="none" stroke="#1B1A25" stroke-width="9" stroke-linecap="round"/>',
    wake: '<g fill="#FFD84A" class="rv-pop"><path d="M50 110l10 22 22 10-22 10-10 22-10-22-22-10 22-10z"/><path d="M372 90l8 18 18 8-18 8-8 18-8-18-18-8 18-8z"/><path d="M360 330l6 13 13 6-13 6-6 13-6-13-13-6 13-6z"/></g>',
  };
  return cover + normal + extras[m];
}
export function setMood(el: HTMLElement, mood: RaviMood): void {
  el.dataset.mood = mood;
  el.dataset.raviMood = mood;
  el.setAttribute("role", "img");
  el.setAttribute("aria-label", names[mood]);
  el.classList.toggle("rv-bob", mood !== "sleep");
  const img = el.querySelector("img");
  if (img) (img as HTMLElement).style.filter = `${el.dataset.characterFilter || "none"} ${mood === "sleep" ? "saturate(0.6) brightness(0.92)" : ""}`;
  const svg = el.querySelector("svg");
  if (svg) svg.innerHTML = eyes(mood);
}
export function raviFace(mood: RaviMood, size: number, options: { round?: boolean } = {}): HTMLElement {
  const el = document.createElement("span");
  el.className = "ravi-face";
  el.style.width = `${size}px`;
  el.style.height = `${size}px`;
  el.style.borderRadius = options.round ? "50%" : `${Math.round(size * .28)}px`;
  const img = document.createElement("img");
  img.src = "/ravi/face.webp";
  img.alt = "";
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 420 420");
  svg.setAttribute("aria-hidden", "true");
  el.append(img, svg);
  setMood(el, mood);
  return el;
}
