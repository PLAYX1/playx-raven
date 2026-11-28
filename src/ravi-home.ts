import { mountRaviRig, type RaviMode } from "./ravi-rig";
import { createRaviVoice, type RecognitionConstructor } from "./ravi-voice";
import { mountRaviMicrophone } from "./ravi-microphone";
import { createRaviPanel } from "./ravi-panel";
import { t, lang } from "./i18n";
import type { RaviTts } from "./ravi-tts";
import { isKoreanText } from "./ravi-ko-g2p";
import "./ravi-home.css";

const labels: Record<RaviMode, string> = {
  sleep: "잠듦 · 느린 숨", idle: "깨어 있음 · 곁에 있어요", listening: "듣는 중 · 편하게 말해 주세요",
  thinking: "생각 중 · 조각을 모아요", speaking: "말하는 중 · 라비의 목소리", joy: "기쁨 · 고마워요",
};
export function createRaviHome(api: { afterLanding?(run: () => void): void; wake(): void; wallet(): void; report(): void; send(): void; tools(): void; companion?(mode: RaviMode): void; voiceProvider?(): string; micReason?(): string; invoke?(cmd: string, args?: Record<string, unknown>): Promise<unknown> }) {
  const byId = (id: string) => document.getElementById(id)!;
  const home = byId("ravi-home-slot");
  const conversation = byId("ravi-conversation");
  home.append(conversation);
  const rig = mountRaviRig(byId("ravi-rig"));
  const small = mountRaviRig(byId("ravi-panel-rig")), face = mountRaviRig(byId("ravi-launcher-rig"));
  const caption = byId("ravi-caption"), state = byId("ravi-state"), transcript = byId("ravi-transcript");
  const input = byId("chat-q") as HTMLTextAreaElement;
  const mic = byId("rv-voice") as HTMLButtonElement;
  const read = byId("ravi-read") as HTMLButtonElement;
  let connected = false, background = document.hidden, mode: RaviMode = "sleep";
  let speakingTimer = 0, joyTimer = 0, speechEpoch = 0;
  // 11-29 말로 물은 질문의 답만 저절로 읽는다(글로 친 질문은 조용히 + 말풍선 스피커 단추). 받아쓴 글이 입력칸에 들어오면 켠다.
  let spokenDraft = false, turnSpoken = false;
  const visible = (el: Element) => !!el.getClientRects().length;
  function externalApproval(): boolean {
    return Array.from(document.querySelectorAll(".ravi-lifecycle[open], .sheet:not(.hidden), #askwrap.on, #rpwrap, #onboard:not(.hidden), #hello, #send-review, #qrwrap, #phone-tx-send:not([hidden])")).some(visible);
  }
  function approval(): boolean {
    return externalApproval() || ["ravi-key", "rv-send-card"].some(id => !byId(id).hidden && visible(byId(id)));
  }
  function blocked(): boolean {
    return background || document.hidden || !panel.visible() || approval();
  }
  function setMode(value: RaviMode) {
    mode = value; api.companion?.(value); [rig, small, face].forEach(r => r.mode(value));
    state.textContent = byId("ravi-panel-state").textContent = t(labels[value]);
    for (const id of ["ravi-stage", "ravi-panel-stage"]) byId(id).setAttribute("aria-label", t(connected ? "라비와 말하기" : "잠든 라비 깨우기"));
  }
  const resting = () => setMode(connected ? "idle" : "sleep");
  function clearSpeech() { speechEpoch++; clearTimeout(speakingTimer); speakingTimer = 0; }
  const speechWindow = window as Window & { SpeechRecognition?: RecognitionConstructor; webkitSpeechRecognition?: RecognitionConstructor };
  // 라비 목소리(Supertonic 3). 무거우니 처음 말할 때(또는 읽어 주기를 켤 때) 그때서야 불러온다.
  // 불러오기·합성이 어떤 이유로든 안 되면 「fallback」 → 기기 목소리.
  let ttsLoad: Promise<RaviTts> | null = null, ttsNow: RaviTts | null = null, speakToken = 0;
  const tts = () => ttsLoad ??= Promise.all([import("./ravi-tts"), import("./ravi-tts-real")]).then(([m, r]) => ttsNow = m.createRaviTts(r.realDeps(api.invoke!)));
  // 11-27 한국어는 작은 라비 목소리(ko-v2, 앱 안 19MB — 「라비」를 「나비」로 읽던 것 고침)가 먼저 읽는다.
  // 한국어가 아니거나 작은 목소리가 못 하면 위 Supertonic → 그래도 안 되면 기기 목소리.
  let koLoad: Promise<RaviTts> | null = null, koNow: RaviTts | null = null;
  const ko = () => koLoad ??= Promise.all([import("./ravi-tts"), import("./ravi-tts-real")]).then(([m, r]) => koNow = m.createRaviTts(r.realDeps(api.invoke!, "ko")));
  const aiTag = byId("ravi-ai-voice");
  const raviSpeech = api.invoke ? {
    async speak(text: string, hooks: { started?(): void }) {
      const mine = ++speakToken;
      try {
        if (isKoreanText(text)) {
          const small = await ko(); if (mine !== speakToken) return "cancelled" as const;
          const r = await small.speak(text, hooks);
          if (r !== "fallback" || mine !== speakToken) return mine === speakToken ? r : "cancelled" as const;
        }
        const engine = await tts(); return mine === speakToken ? await engine.speak(text, hooks) : "cancelled" as const;
      } catch { return "fallback" as const; }
    },
    // 동기로 취소한다: 늦게 도착하는 취소가 새 말을 죽이지 않게(실제로 겪은 일 — 시험이 잡았다).
    cancel() { speakToken++; koNow?.cancel(); ttsNow?.cancel(); },
    // 작은 목소리만 미리 올린다(가볍다). 그게 안 될 때만 무거운 Supertonic 을 올린다.
    async warm() { try { return await (await ko()).warm() || await (await tts()).warm(); } catch { return false; } },
  } : undefined;
  const voice = createRaviVoice({
    ravi: raviSpeech,
    preferRavi: () => { try { return localStorage.getItem("rv-ravi-voice") !== "device"; } catch { return true; } },
    aiVoice(on) { aiTag.hidden = !on; },
    aiTag(bubble) {
      // 말풍선 옆에도 남긴다: 이 답은 기계(AI) 음성으로 읽혔다.
      if (bubble.querySelector(".ai-voice-tag")) return;
      const tag = document.createElement("span"); tag.className = "ai-voice-tag"; tag.textContent = t("AI 음성"); tag.translate = false;
      bubble.querySelector(".msgtxt")?.before(tag);
    },
    Recognition: speechWindow.SpeechRecognition || speechWindow.webkitSpeechRecognition,
    synthesis: window.speechSynthesis,
    utterance: window.SpeechSynthesisUtterance,
    allowed: () => !blocked(),
    transcript(text) { spokenDraft = true; input.value = text; transcript.textContent = text; [rig, small, face].forEach(r => r.pose.level = Math.min(1, text.length / 24)); },
    listening(on) {
      mic.setAttribute("aria-pressed", String(on));
      if (on) { clearSpeech(); setMode("listening"); } else if (mode === "listening") resting();
    },
    boundary() { [rig, small, face].forEach(r => r.pose.level = .9); },
    // 「말하는 중」은 소리가 실제로 날 때만(11-29 — 말하지 않는데 「말하는 중」이 떠 있었다).
    started() { if (connected && !blocked() && mode !== "speaking") { setMode("speaking"); [rig, small, face].forEach(r => r.pose.level = .7); } },
    ended() { clearSpeech(); resting(); },
    unavailable() { transcript.textContent = t("이 기기에서는 글로 물어봐 주세요"); },
  });
  mic.hidden = !voice.supported;
  mic.onclick = () => voice.listen();
  const microphone = api.voiceProvider ? mountRaviMicrophone({
    provider: api.voiceProvider, allowed: () => !blocked(),
    transcript(text) { spokenDraft = true; input.value = text; input.dispatchEvent(new Event("input", { bubbles: true })); },
    quiet() { voice.stop(); clearSpeech(); },
    listening(on) { if (on) setMode("listening"); else if (mode === "listening") resting(); },
  }) : undefined;
  function stopVoice() { microphone?.stop(); voice.stop(); }
  // 11-29 마이크는 숨기지 않는다. 받아쓰기에 키가 필요한데 없으면 흐리게 + 이유 한 줄(빈 대화에서 보임 · 누르면 같은 안내).
  const micWhy = document.getElementById("ravi-mic-why");
  function paintMic() {
    const reason = api.micReason?.() || "";
    mic.hidden = false;
    mic.setAttribute("aria-disabled", String(!!reason));
    mic.title = reason || t("말로 묻기");
    if (micWhy) { micWhy.textContent = reason; micWhy.hidden = !reason; }
  }
  if (api.micReason) paintMic();
  let readEnabled = false;
  // 0.9.46: 기억한다. 11-29 뜻이 바뀌었다 — 말로 물으면 늘 읽고, 이 스위치는 「글로 물어도 읽기」(기본 꺼짐 · 메뉴 안).
  const readKey = "rv-ravi-read-aloud";
  voice.setEnabled(true, false);
  const applyRead = (on: boolean) => {
    readEnabled = on;
    read.setAttribute("aria-pressed", String(readEnabled));
    read.textContent = t("글로 물어도 답 읽어 주기");
    if (on && raviSpeech && kind.value === "ravi") void raviSpeech.warm();
  };
  read.onclick = () => {
    applyRead(!readEnabled);
    try { localStorage.setItem(readKey, readEnabled ? "1" : "0"); } catch { /* 이번 실행만 */ }
    void pack?.then(p => p?.setWant(wantRavi));
  };
  // 설정 「라비 목소리」: 라비 목소리(기본) / 기기 목소리. 기존 읽어 주기 켜짐·꺼짐과 따로 저장한다.
  const kind = byId("ravi-voice-kind") as HTMLSelectElement, kindNote = byId("ravi-voice-kind-note");
  try { kind.value = localStorage.getItem("rv-ravi-voice") === "device" ? "device" : "ravi"; } catch { kind.value = "ravi"; }
  applyRead(false);
  try { if (localStorage.getItem(readKey) === "1") applyRead(true); } catch { /* 기본 꺼짐 */ }
  // 라비 목소리 받기(모델은 설치 파일에 없다): 설정 카드 + 말풍선 옆 안내. 끝나면 합성 엔진을 새로 만든다.
  // 380MB 받기 안내(말풍선 옆)는 「답 읽어 주기」를 켠 사람에게만.
  const wantRavi = () => readEnabled && kind.value === "ravi";
  const laterKey = "rv-ravi-pack-later";
  const pack = api.invoke ? import("./ravi-voice-pack").then(m => m.mountVoicePack({
    invoke: api.invoke!,
    reset() { ttsNow?.dispose(); ttsNow = null; ttsLoad = null; aiTag.hidden = true; },
    useRavi() { try { localStorage.setItem("rv-ravi-voice", "ravi"); } catch { /* 저장 못 해도 이번 실행엔 기본값 */ } kind.value = "ravi"; if (readEnabled) void raviSpeech?.warm(); kindHint(); },
    later: { get() { try { return localStorage.getItem(laterKey) === "1"; } catch { return false; } }, set(v) { try { v ? localStorage.setItem(laterKey, "1") : localStorage.removeItem(laterKey); } catch { /* 이번 실행에만 */ } } },
  })).then(p => { void p?.refresh(wantRavi); return p; }).catch(() => undefined) : undefined;
  const kindHint = () => {
    kindNote.textContent = "";
    void pack?.then(p => p?.setWant(wantRavi));
    if (kind.value !== "ravi" || !api.invoke) return;
    // 아직 안 받았거나 파일이 깨졌으면 미리 알려 준다(말은 기기 목소리로 나온다).
    // 11-27 한국어 화면은 받지 않아도 앱 안 작은 목소리가 읽으니 이 안내가 틀린 말이 된다 → 한국어가 아닐 때만.
    if (lang === "ko") return;
    void api.invoke("ravi_tts_status").then(r => { if (kind.value === "ravi" && !(r as { ok?: boolean } | null)?.ok) kindNote.textContent = t("라비 목소리를 아직 받지 않아서 지금은 기기 목소리로 말해요. 아래 「받기」를 누르면 받아요."); }).catch(() => {});
  };
  kind.onchange = () => {
    try { localStorage.setItem("rv-ravi-voice", kind.value); } catch { /* 저장 못 해도 이번 실행엔 기본값으로 */ }
    if (kind.value === "device") { voice.stop(); koNow?.dispose(); ttsNow?.dispose(); aiTag.hidden = true; }
    else if (readEnabled) void raviSpeech?.warm();
    kindHint();
  };
  kindHint();
  // 정보 화면: 목소리 라이선스 원문을 설치 폴더의 파일에서 그대로 보여 준다(없으면 안내만).
  const lic = byId("about-supertonic-license") as HTMLDetailsElement;
  lic.addEventListener("toggle", () => {
    if (!lic.open || !api.invoke) return;
    const pre = byId("about-supertonic-license-text");
    void api.invoke("ravi_tts_read", { key: "license", offset: 0, len: 15007 }).then(b => { pre.textContent = new TextDecoder().decode(b as ArrayBuffer); })
      .catch(() => { pre.textContent = "https://huggingface.co/supertone-oss-archive/supertonic-3 (OpenRAIL-M)"; });
  });
  byId("ravi-stage").onclick = api.wake;
  byId("ravi-panel-stage").onclick = api.wake;
  byId("ravi-balance").onclick = api.wallet;
  byId("ravi-plus").onclick = () => {
    api.tools();
    const tools = byId("ravi-tools") as HTMLDetailsElement;
    tools.open = !tools.open;
    byId("ravi-plus").setAttribute("aria-expanded", String(tools.open));
    if (tools.open) tools.scrollIntoView({ block: "nearest" });
  };
  input.addEventListener("input", () => { [rig, small, face].forEach(r => r.pose.level = Math.min(1, input.value.length / 24)); transcript.textContent = input.value; });
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
    const approvalOpen = approval();
    // Inline key/request cards stay in the panel; all other approval surfaces take precedence.
    const inline = ["ravi-key", "rv-send-card"].some(id => !byId(id).hidden && visible(byId(id)));
    panel.suspend(externalApproval());
    const stop = blocked(), idleStop = background || document.hidden || approvalOpen;
    rig.pause(idleStop || document.querySelector(".page.on")?.id !== "page-home");
    small.pause(stop); face.pause(idleStop || panel.visible());
    document.body.classList.toggle("ravi-paused", idleStop);
    byId("ravi-panel").classList.toggle("reviewing", inline);
    mic.disabled = read.disabled = approvalOpen;
    if (stop) {
      stopVoice(); clearSpeech(); clearTimeout(joyTimer);
      if (["speaking", "listening", "joy"].includes(mode)) resting();
    }
  }
  // paint calls changed; queue it so initialization completes before the first sync.
  const panel = createRaviPanel(api.send, () => queueMicrotask(sync), api.afterLanding);
  const observer = new MutationObserver(sync);
  document.querySelectorAll(".page, .sheet, #askwrap, #rpwrap, #onboard, #hello, #ravi-key, #rv-send-card, #send-review, #qrwrap, #phone-tx-send, #phone-tx-panel, #ravi-tools").forEach(el =>
    observer.observe(el, { attributes: true, attributeFilter: ["class", "style", "hidden", "open"] }));
  const onVisibility = () => { background = document.hidden; sync(); };
  document.addEventListener("visibilitychange", onVisibility);
  document.addEventListener("ravi-lifecycle-change", sync);
  window.addEventListener("blur", () => { if (microphone?.state === "requesting") return; background = true; sync(); });
  window.addEventListener("focus", () => { background = document.hidden; sync(); });
  window.addEventListener("pagehide", () => { background = true; sync(); });
  // 받아쓴 글을 다 지우면 다음 질문은 글로 친 것이다.
  input.addEventListener("input", () => { if (!input.value.trim()) spokenDraft = false; });
  function speakNow(text: string, bubble?: Element) {
    resting();   // 소리가 실제로 나면 started() 가 「말하는 중」으로 바꾼다
    const session = speechEpoch;
    if (voice.speak(text, bubble)) {
      // Long utterances must also terminate if the WebView drops its onend event.
      // 라비 목소리는 불러오기·만들기가 먼저라서 기기 목소리 기준 시간(글자당 0.2초)으로는 말하는 도중에 끊긴다 — 그만큼 더 기다린다.
      const allowance = raviSpeech && (() => { try { return localStorage.getItem("rv-ravi-voice") !== "device"; } catch { return true; } })() ? 75000 : 0;
      speakingTimer = window.setTimeout(() => { if (session === speechEpoch) { stopVoice(); resting(); } }, Math.min(200000, Math.max(8000, text.length * 200) + allowance));
      return true;
    }
    return false;
  }
  // 글로 물은 답에는 스피커 단추 하나(누르면 그 답만 읽는다). 소리 내기는 승인이 아니다 — 돈·키와 상관없다.
  const SPEAKER = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 9.5v5h3.5L12 18.5v-13L7.5 9.5z"/><path d="M15.5 9a4 4 0 0 1 0 6M18 6.5a7.5 7.5 0 0 1 0 11"/></svg>';
  function addSpeaker(bubble: Element | undefined, text: string) {
    if (!bubble || bubble.querySelector(".ravi-say") || typeof document.createElement !== "function") return;
    const b = document.createElement("button");
    b.type = "button"; b.className = "ravi-say"; b.innerHTML = SPEAKER;
    b.setAttribute("aria-label", t("소리로 듣기")); b.title = t("소리로 듣기");
    b.onclick = () => { clearSpeech(); stopVoice(); if (!blocked()) speakNow(text, bubble); };
    bubble.append(b);
  }
  // 앱이 켜지고 한가할 때 작은 라비 목소리(ko-v2, 한국어)를 미리 올려 둔다 — 첫 소리를 빠르게. 화면은 막지 않는다(워커).
  if (raviSpeech && lang === "ko") {
    const idle = (run: () => void) => { const w = window as Window & { requestIdleCallback?(cb: () => void, o?: { timeout: number }): number }; if (w.requestIdleCallback) w.requestIdleCallback(run, { timeout: 8000 }); else window.setTimeout(run, 1500); };
    window.setTimeout(() => idle(() => { if (kind.value === "ravi" && !document.hidden) void ko().then(k => k.warm()).catch(() => false); }), 4000);
  }
  // 창을 열 때·마이크를 누를 때 한 번 더(5분 쉬면 내려 두므로) — 이미 올라와 있으면 시간만 늘린다.
  const rewarm = () => { if (raviSpeech && lang === "ko" && kind.value === "ravi") void ko().then(k => k.warm()).catch(() => false); };
  mic.addEventListener("pointerdown", rewarm);
  resting(); sync();
  return {
    background(value: boolean) { background = value; sync(); },
    open(focus?: boolean) { rewarm(); panel.open(focus); },
    message: panel.message,
    sent() { turnSpoken = spokenDraft; spokenDraft = false; panel.sent(); },
    page(id: string) {
      if (id === "ravi") panel.open(false);
      sync();
    },
    mood(value: string) {
      if (value === "thinking") { clearSpeech(); stopVoice(); setMode(connected ? "thinking" : "sleep"); }
      else if (value === "wake") { [rig, small, face].forEach(r => r.wake()); resting(); }
      else if (!["speaking", "listening", "joy"].includes(mode)) setMode(value === "sleep" ? "sleep" : "idle");
    },
    connected(value: boolean) {
      const wake = value && !connected;
      connected = value; if (wake) [rig, small, face].forEach(r => r.wake());
      if (api.micReason) paintMic();
      if (!["speaking", "listening", "joy"].includes(mode)) resting();
      caption.textContent = t(value ? "깨어났어요. 무엇을 도와드릴까요?" : "라비가 잠들어 있어요. 눌러서 깨워 주세요.");
    },
    reply(text: string, bubble?: Element) {
      if (!text.trim()) return;
      clearSpeech(); stopVoice();
      if (blocked()) { resting(); return; }
      // 11-29 말로 물었으면 읽고(라비 목소리 ko-v2), 글로 물었으면 조용히 + 스피커 단추. 메뉴 「글로 물어도 답 읽어 주기」가 켜져 있으면 늘 읽는다.
      if ((turnSpoken || readEnabled) && speakNow(text, bubble)) return;
      resting(); addSpeaker(bubble, text);
    },
    joy() {
      if (!connected || blocked()) return;
      clearSpeech(); stopVoice(); clearTimeout(joyTimer); setMode("joy");
      joyTimer = window.setTimeout(resting, 1700);
    },
    thinking() { if (!blocked()) { stopVoice(); clearSpeech(); setMode(connected ? "thinking" : "sleep"); } },
    finish() { if (mode === "thinking") resting(); },
  };
}
