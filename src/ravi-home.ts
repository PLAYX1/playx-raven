import { mountRaviRig, type RaviMode } from "./ravi-rig";
import { createRaviVoice, type RecognitionConstructor } from "./ravi-voice";
import { t } from "./i18n";
import "./ravi-home.css";

const labels: Record<RaviMode, string> = {
  sleep: "잠듦 · 느린 숨", idle: "깨어 있음 · 곁에 있어요", listening: "듣는 중 · 편하게 말해 주세요",
  thinking: "생각 중 · 조각을 모아요", speaking: "말하는 중 · 라비의 목소리", joy: "기쁨 · 고마워요",
};
export function createRaviHome(api: { wake(): void; wallet(): void; report(): void }) {
  const byId = (id: string) => document.getElementById(id)!;
  const home = byId("ravi-home-slot"), page = byId("page-ravi");
  const conversation = byId("ravi-conversation");
  home.append(conversation);
  const rig = mountRaviRig(byId("ravi-rig"));
  const caption = byId("ravi-caption"), state = byId("ravi-state"), transcript = byId("ravi-transcript");
  const input = byId("chat-q") as HTMLInputElement;
  const mic = byId("rv-voice") as HTMLButtonElement;
  const read = byId("ravi-read") as HTMLButtonElement;
  let connected = false, background = document.hidden, mode: RaviMode = "sleep";
  let speakingTimer = 0, joyTimer = 0, speechEpoch = 0;
  const visible = (el: Element) => !!el.getClientRects().length;
  function blocked(): boolean {
    const active = document.querySelector(".page.on")?.id;
    return background || document.hidden || !["page-home", "page-ravi"].includes(active || "") ||
      Array.from(document.querySelectorAll(".sheet:not(.hidden), #askwrap.on, #rpwrap, #onboard:not(.hidden), #hello, #send-review, #ravi-key:not([hidden]), #rv-send-card:not([hidden])"))
        .some(visible);
  }
  function setMode(value: RaviMode) {
    mode = value; rig.mode(value); state.textContent = t(labels[value]);
    byId("ravi-stage").setAttribute("aria-label", t(connected ? "라비와 말하기" : "잠든 라비 깨우기"));
  }
  const resting = () => setMode(connected ? "idle" : "sleep");
  function clearSpeech() { speechEpoch++; clearTimeout(speakingTimer); speakingTimer = 0; }
  const speechWindow = window as Window & { SpeechRecognition?: RecognitionConstructor; webkitSpeechRecognition?: RecognitionConstructor };
  const voice = createRaviVoice({
    Recognition: speechWindow.SpeechRecognition || speechWindow.webkitSpeechRecognition,
    synthesis: window.speechSynthesis,
    utterance: window.SpeechSynthesisUtterance,
    allowed: () => !blocked(),
    transcript(text) { input.value = text; transcript.textContent = text; rig.pose.level = Math.min(1, text.length / 24); },
    listening(on) {
      mic.setAttribute("aria-pressed", String(on));
      if (on) { clearSpeech(); setMode("listening"); } else if (mode === "listening") resting();
    },
    boundary() { rig.pose.level = .9; },
    ended() { clearSpeech(); resting(); },
    unavailable() { transcript.textContent = t("이 기기에서는 글로 물어봐 주세요"); },
  });
  mic.hidden = !voice.supported;
  mic.onclick = () => voice.listen();
  let readEnabled = false;
  read.onclick = () => {
    readEnabled = !readEnabled;
    read.setAttribute("aria-pressed", String(readEnabled));
    read.textContent = t(readEnabled ? "답 읽어 주기 켜짐" : "답 읽어 주기 꺼짐");
    voice.setEnabled(readEnabled);
  };
  byId("ravi-stage").onclick = api.wake;
  byId("ravi-balance").onclick = api.wallet;
  byId("ravi-plus").onclick = () => {
    const tools = byId("ravi-tools") as HTMLDetailsElement;
    tools.open = !tools.open;
    byId("ravi-plus").setAttribute("aria-expanded", String(tools.open));
    if (tools.open) tools.scrollIntoView({ block: "nearest" });
  };
  input.addEventListener("input", () => { rig.pose.level = Math.min(1, input.value.length / 24); transcript.textContent = input.value; });
  // Capture at the document so the SVG stage never consumes the existing report gesture.
  let gestureLatched = false;
  const gesture = (event: TouchEvent) => {
    if (event.touches.length >= 5 && !gestureLatched) { gestureLatched = true; api.report(); }
    if (!event.touches.length) gestureLatched = false;
  };
  document.addEventListener("touchstart", gesture, { capture: true, passive: true });
  document.addEventListener("touchend", gesture, { capture: true, passive: true });
  document.addEventListener("touchcancel", gesture, { capture: true, passive: true });
  function sync() {
    const stop = blocked();
    rig.pause(stop); document.body.classList.toggle("ravi-paused", stop);
    if (stop) {
      voice.stop(); clearSpeech(); clearTimeout(joyTimer);
      if (["speaking", "listening", "joy"].includes(mode)) resting();
    }
  }
  const observer = new MutationObserver(sync);
  document.querySelectorAll(".page, .sheet, #askwrap, #rpwrap, #onboard, #hello, #ravi-key, #rv-send-card, #send-review").forEach(el =>
    observer.observe(el, { attributes: true, attributeFilter: ["class", "style", "hidden"] }));
  const onVisibility = () => { background = document.hidden; sync(); };
  document.addEventListener("visibilitychange", onVisibility);
  window.addEventListener("blur", () => { background = true; sync(); });
  window.addEventListener("focus", () => { background = document.hidden; sync(); });
  window.addEventListener("pagehide", () => { background = true; sync(); });
  resting(); sync();
  return {
    background(value: boolean) { background = value; sync(); },
    page(id: string) {
      if (id === "home") home.append(conversation);
      else if (id === "ravi") page.append(conversation);
      if (!["home", "ravi"].includes(id)) { voice.stop(); clearSpeech(); }
      // showPage flips .on immediately after this call; observer resumes when appropriate.
      sync();
    },
    mood(value: string) {
      if (value === "thinking") { clearSpeech(); voice.stop(); setMode(connected ? "thinking" : "sleep"); }
      else if (value === "wake") { rig.wake(); resting(); }
      else if (!["speaking", "listening", "joy"].includes(mode)) setMode(value === "sleep" ? "sleep" : "idle");
    },
    connected(value: boolean) {
      const wake = value && !connected;
      connected = value; if (wake) rig.wake();
      if (!["speaking", "listening", "joy"].includes(mode)) resting();
      if (!caption.dataset.reply) caption.textContent = t(value ? "깨어났어요. 무엇을 도와드릴까요?" : "라비가 잠들어 있어요. 눌러서 깨워 주세요.");
    },
    reply(text: string) {
      if (!text.trim()) return;
      caption.dataset.reply = "1"; caption.textContent = text;
      clearSpeech(); voice.stop();
      if (blocked()) { resting(); return; }
      if (!connected) { resting(); voice.speak(text); return; }
      setMode("speaking"); rig.pose.level = .7;
      const session = speechEpoch;
      if (voice.speak(text)) {
        // Long utterances must also terminate if the WebView drops its onend event.
        speakingTimer = window.setTimeout(() => { if (session === speechEpoch) { voice.stop(); resting(); } }, Math.min(120000, Math.max(8000, text.length * 200)));
      } else {
        speakingTimer = window.setTimeout(() => { if (session === speechEpoch) resting(); }, Math.min(12000, Math.max(1400, text.length * 90)));
      }
    },
    joy() {
      if (!connected || blocked()) return;
      clearSpeech(); voice.stop(); clearTimeout(joyTimer); setMode("joy");
      joyTimer = window.setTimeout(resting, 1700);
    },
    thinking() { if (!blocked()) { voice.stop(); clearSpeech(); setMode(connected ? "thinking" : "sleep"); } },
    finish() { if (mode === "thinking") resting(); },
  };
}
