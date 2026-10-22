// WebView Web Speech only. This adapter has no native RPC or approval callback.
export interface RecognitionResult { isFinal: boolean; 0: { transcript: string }; }
export interface RaviRecognition {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  onresult: ((event: { results: ArrayLike<RecognitionResult> }) => void) | null;
  onend: (() => void) | null;
  onerror: (() => void) | null;
  start(): void;
  abort(): void;
}
export type RecognitionConstructor = new () => RaviRecognition;
export function naturalKoreanVoice(voices: SpeechSynthesisVoice[]): SpeechSynthesisVoice | undefined {
  return voices.filter(v => /^ko(?:[-_]KR)?$/i.test(v.lang) &&
    !/Albert|Eddy|Bad News|Bells|Boing|Bubbles|Jester|Whisper|Zarvox|Trinoids|Wobble|Organ|Cellos|Good News|Bahh/i.test(v.name))
    .sort((a, b) => Number(/Yuna|유나|Google.*한국|Sora|선희|SunHi|Heami/i.test(b.name)) -
      Number(/Yuna|유나|Google.*한국|Sora|선희|SunHi|Heami/i.test(a.name)))[0];
}
export function createRaviVoice(api: {
  Recognition?: RecognitionConstructor;
  synthesis?: SpeechSynthesis;
  utterance?: typeof SpeechSynthesisUtterance;
  allowed(): boolean;
  transcript(text: string): void;
  listening(on: boolean): void;
  boundary(): void;
  ended(): void;
  unavailable(): void;
  // 라비 목소리(Supertonic): 없으면 기존처럼 기기 목소리만 쓴다. 실패·느림·리소스 없음은 모두 기기 목소리로 넘어간다.
  ravi?: { speak(text: string, hooks: { started?(): void }): Promise<"played" | "fallback" | "cancelled">; cancel(): void; warm(): Promise<boolean> };
  preferRavi?(): boolean;
  aiVoice?(on: boolean): void;
  aiTag?(bubble: Element): void; // 소리가 실제로 나기 시작했을 때 그 말풍선에 「AI 음성」을 남긴다(기기 목소리로 넘어가면 안 붙는다)
}) {
  let enabled = false, recognition: RaviRecognition | null = null, epoch = 0;
  const cancel = () => {
    epoch++;
    const previous = recognition; recognition = null;
    if (previous) {
      previous.onresult = previous.onend = previous.onerror = null;
      try { previous.abort(); } catch { /* already stopped */ }
    }
    api.synthesis?.cancel(); api.ravi?.cancel(); api.aiVoice?.(false); api.listening(false);
  };
  return {
    supported: !!api.Recognition,
    setEnabled(on: boolean) { enabled = on; if (!on) { cancel(); api.ended(); } else if (api.ravi && api.preferRavi?.()) void api.ravi.warm(); },
    stop: cancel,
    listen() {
      if (recognition) { cancel(); return; }
      if (!api.allowed() || !api.Recognition) return;
      cancel();
      const session = epoch;
      const r = recognition = new api.Recognition();
      r.lang = "ko-KR"; r.interimResults = true; r.continuous = false;
      r.onresult = event => {
        if (session !== epoch || !api.allowed()) { cancel(); return; }
        let text = "";
        for (let i = 0; i < event.results.length; i++) text += event.results[i][0].transcript;
        // Deliberately only fill the conversation input. Sending remains a direct click.
        api.transcript(text);
      };
      r.onerror = () => { if (session === epoch) { cancel(); api.unavailable(); } };
      r.onend = () => { if (session === epoch) { recognition = null; api.listening(false); } };
      api.listening(true);
      try { r.start(); } catch { cancel(); api.unavailable(); }
    },
    speak(text: string, bubble?: Element): boolean {
      if (!enabled || !api.allowed()) return false;
      if (api.ravi && api.preferRavi?.()) {
        cancel();
        const session = epoch;
        api.aiVoice?.(true); // 만드는 동안에도 「AI 음성」이 보인다(기계 음성임을 숨기지 않는다)
        api.ravi.speak(text, { started: () => { if (session === epoch) { api.boundary(); if (bubble) api.aiTag?.(bubble); } } }).then(result => {
          if (session !== epoch) return;
          if (result === "played") { api.aiVoice?.(false); api.ended(); }
          else if (result === "fallback") { api.aiVoice?.(false); deviceSpeak(text, session, true); }
        }, () => { if (session === epoch) { api.aiVoice?.(false); deviceSpeak(text, session, true); } });
        return true;
      }
      cancel();
      return deviceSpeak(text, epoch, false);
    },
  };
  // 기기 목소리(옛 경로 그대로). 세션이 바뀌었으면 말하지 않는다.
  function deviceSpeak(text: string, session: number, late: boolean): boolean {
    // late=라비 목소리가 못 해서 넘어온 경우: 말이 안 나가면 화면을 쉬는 모습으로 돌려놓는다. 옛 경로(late=false)는 부른 쪽이 정리한다.
    const giveUp = () => { if (late && session === epoch) api.ended(); return false; };
    if (session !== epoch || !api.synthesis || !api.utterance) return giveUp();
    const voice = naturalKoreanVoice(api.synthesis.getVoices());
    if (!voice) { api.unavailable(); return giveUp(); }
    const u = new api.utterance(text);
    u.voice = voice; u.lang = "ko-KR"; u.rate = 1;
    u.onboundary = () => { if (session === epoch && api.allowed()) api.boundary(); };
    u.onend = u.onerror = () => { if (session === epoch) api.ended(); };
    try { api.synthesis.speak(u); return true; } catch { api.unavailable(); return giveUp(); }
  }
}
