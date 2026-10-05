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
}) {
  let enabled = false, recognition: RaviRecognition | null = null, epoch = 0;
  const cancel = () => {
    epoch++;
    const previous = recognition; recognition = null;
    if (previous) {
      previous.onresult = previous.onend = previous.onerror = null;
      try { previous.abort(); } catch { /* already stopped */ }
    }
    api.synthesis?.cancel(); api.listening(false);
  };
  return {
    supported: !!api.Recognition,
    setEnabled(on: boolean) { enabled = on; if (!on) { cancel(); api.ended(); } },
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
    speak(text: string): boolean {
      if (!enabled || !api.allowed() || !api.synthesis || !api.utterance) return false;
      const voice = naturalKoreanVoice(api.synthesis.getVoices());
      if (!voice) { api.unavailable(); return false; }
      cancel();
      const session = epoch, u = new api.utterance(text);
      u.voice = voice; u.lang = "ko-KR"; u.rate = 1;
      u.onboundary = () => { if (session === epoch && api.allowed()) api.boundary(); };
      u.onend = u.onerror = () => { if (session === epoch) api.ended(); };
      try { api.synthesis.speak(u); return true; } catch { api.unavailable(); return false; }
    },
  };
}
