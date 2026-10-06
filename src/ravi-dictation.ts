// Audio exists only inside a recording session and its IPC request. Never persist or log it.
export type VoiceState = 'idle' | 'consent' | 'requesting' | 'listening' | 'transcribing' | 'done' | 'error';
export type VoiceError = 'denied' | 'permission' | 'device' | 'busy' | 'network' | 'unsupported' | 'unsupported_provider' | 'key' | 'budget' | 'silence' | 'storage' | 'response';
export const MAX_VOICE_MS = 30_000, SILENCE_MS = 2200, INITIAL_SILENCE_MS = 5000, MAX_VOICE_BYTES = 4 * 1024 * 1024;
export function voiceError(error: unknown): VoiceError {
  const name = typeof error === 'object' && error ? (error as { name?: string }).name : '';
  if (name === 'NotAllowedError') return 'denied';
  if (name === 'SecurityError') return 'permission';
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'device';
  if (name === 'NotReadableError' || name === 'AbortError') return 'busy';
  const safe: VoiceError[] = ['network','unsupported','unsupported_provider','key','budget','silence','storage','response'];
  return safe.includes(error as VoiceError) ? error as VoiceError : 'response';
}
export class VoiceSilence {
  lastSound = 0;
  heard = false;
  sample(elapsed: number, rms: number): boolean {
    if (rms >= .012) { this.heard = true; this.lastSound = elapsed; }
    return elapsed >= MAX_VOICE_MS || (this.heard ? elapsed - this.lastSound >= SILENCE_MS : elapsed >= INITIAL_SILENCE_MS);
  }
}
export interface LocalRecognition {
  processLocally?: boolean; lang: string; continuous: boolean; interimResults: boolean;
  onresult: ((event: { results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }> }) => void) | null;
  onerror: (() => void) | null; onend: (() => void) | null;
  start(): void; abort(): void;
}
export interface DictationAPI {
  provider(): string;
  language(): string;
  allowed(): boolean;
  consent(provider: string): Promise<boolean>;
  saveConsent(provider: string, allowed: boolean): Promise<void>;
  cancelRequest(): void;
  transcribe(provider: string, audio: number[], mime: string, durationMs: number, language: string): Promise<string>;
  transcript(text: string): void;
  state(state: VoiceState, error?: VoiceError): void;
  level(elapsed: number, samples: Uint8Array): void;
  quiet(): void;
  getUserMedia?: () => Promise<MediaStream>;
  Recorder?: typeof MediaRecorder;
  Recognition?: new () => LocalRecognition;
  Audio?: typeof AudioContext;
  now(): number;
  every(callback: () => void): ReturnType<typeof setInterval>;
  clear(timer: ReturnType<typeof setInterval>): void;
}
export function createRaviDictation(api: DictationAPI) {
  let state: VoiceState = 'idle', epoch = 0, provider = '', language = '', timer: ReturnType<typeof setInterval> | undefined;
  let stream: MediaStream | undefined, recorder: MediaRecorder | undefined, context: AudioContext | undefined;
  let local: LocalRecognition | undefined;
  let chunks: Blob[] = [], size = 0, start = 0, consent = false;
  const change = (next: VoiceState, error?: VoiceError) => { state = next; api.state(next, error); };
  function release() {
    if (timer !== undefined) api.clear(timer); timer = undefined;
    if (recorder) {
      recorder.ondataavailable = recorder.onstop = recorder.onerror = null;
      if (recorder.state !== 'inactive') { try { recorder.stop(); } catch { /* already stopped */ } }
    }
    recorder = undefined;
    if (local) { local.onresult = local.onerror = local.onend = null; try { local.abort(); } catch { /* already ended */ } local = undefined; }
    stream?.getTracks().forEach(track => track.stop()); stream = undefined;
    if (context) void context.close().catch(() => {}); context = undefined;
    chunks = []; size = 0;
  }
  function stop() {
    const pending = state === 'transcribing';
    epoch++; release();
    if (pending) api.cancelRequest();
    if (state !== 'idle') change('idle');
  }
  function fail(error: unknown) { release(); change('error', voiceError(error)); }
  const valid = (session: number) => session === epoch && api.allowed() && api.provider() === provider && api.language() === language;
  async function finish(session: number, heard: boolean) {
    if (!valid(session)) { stop(); return; }
    if (!heard || size === 0) { fail('silence'); return; }
    const duration = Math.min(MAX_VOICE_MS, Math.max(1, Math.round(api.now() - start)));
    let blob: Blob | undefined = new Blob(chunks, { type: recorder?.mimeType || chunks[0]?.type });
    const mime = blob.type;
    release(); change('transcribing');
    let bytes: Uint8Array | undefined, payload: number[] = [];
    try {
      bytes = new Uint8Array(await blob.arrayBuffer()); blob = undefined;
      if (!valid(session)) { stop(); return; }
      payload = Array.from(bytes); bytes.fill(0);
      const result = await api.transcribe(provider, payload, mime, duration, language);
      if (valid(session)) { api.transcript(result); change('done'); }
      else if (session === epoch) stop();
    } catch (error) { if (valid(session)) fail(error); }
    finally { bytes?.fill(0); payload.fill(0); payload.length = 0; }
  }
  function primeAudio() {
    // Resume during the explicit click, before IPC/permission awaits consume activation.
    // No device is opened here; capture still requires provider consent.
    if (api.Audio && !context) { context = new api.Audio(); void context.resume().catch(() => {}); }
  }
  async function record(session: number) {
    if (!api.getUserMedia || !api.Recorder || !api.Audio) { fail('unsupported'); return; }
    change('requesting'); api.quiet();
    try {
      const media = await api.getUserMedia();
      if (!valid(session)) { media.getTracks().forEach(t => t.stop()); if (session === epoch) stop(); return; }
      stream = media;
      const mime = ['audio/webm;codecs=opus','audio/mp4','audio/webm','audio/ogg;codecs=opus'].find(m => api.Recorder!.isTypeSupported(m));
      if (!mime) { fail('unsupported'); return; }
      if (!context) context = new api.Audio();
      await context.resume();
      if (!valid(session) || !context) { if (session === epoch) stop(); return; }
      const analyser = context.createAnalyser(); analyser.fftSize = 256;
      context.createMediaStreamSource(media).connect(analyser); // No speaker connection: no feedback.
      const samples = new Uint8Array(analyser.fftSize), silence = new VoiceSilence();
      recorder = new api.Recorder(media, { mimeType: mime, audioBitsPerSecond: 64000 });
      recorder.ondataavailable = event => {
        if (!valid(session)) { if (session === epoch) stop(); return; }
        size += event.data.size;
        if (size > MAX_VOICE_BYTES) { epoch++; fail('response'); return; }
        if (event.data.size) chunks.push(event.data);
      };
      recorder.onerror = () => { if (session === epoch) { epoch++; fail('busy'); } };
      recorder.onstop = () => { void finish(session, silence.heard); };
      start = api.now(); recorder.start(200); change('listening');
      timer = api.every(() => {
        if (!valid(session)) { stop(); return; }
        const elapsed = api.now() - start;
        analyser.getByteTimeDomainData(samples);
        const rms = Math.sqrt(samples.reduce((sum, v) => sum + ((v - 128) / 128) ** 2, 0) / samples.length);
        api.level(Math.min(MAX_VOICE_MS, elapsed), samples);
        if (silence.sample(elapsed, rms) && recorder?.state === 'recording') recorder.stop();
      });
    } catch (error) { if (session === epoch) fail(error); }
  }
  async function listen(session: number) {
    // Keep Web Speech only when on-device recognition is explicitly supported.
    // Remote browser recognition may send to a different company without consent.
    if (api.Recognition) {
      let r: LocalRecognition;
      try { r = new api.Recognition(); } catch { await record(session); return; }
      if ('processLocally' in r) {
        local = r; r.processLocally = true; r.lang = language; r.continuous = false; r.interimResults = false;
        const fallback = () => { if (session !== epoch) return; const primed = context; context = undefined; release(); context = primed; if (valid(session)) void record(session); else stop(); };
        r.onerror = r.onend = fallback;
        r.onresult = event => {
          if (!valid(session)) { stop(); return; }
          let text = '';
          for (let i = 0; i < event.results.length; i++) if (event.results[i].isFinal) text += event.results[i][0].transcript;
          if (text.trim()) { release(); api.transcript(text); change('done'); }
        };
        start = api.now(); change('listening');
        timer = api.every(() => { if (!valid(session)) stop(); else if (api.now() - start >= INITIAL_SILENCE_MS) fallback(); });
        try { r.start(); } catch { fallback(); }
        return;
      }
    }
    await record(session);
  }
  async function begin() {
    if (state === 'listening' && local) { release(); await record(epoch); return; }
    if (state === 'listening' && recorder?.state === 'recording') { recorder.stop(); return; }
    if (['requesting','transcribing','consent'].includes(state)) { stop(); return; }
    if (!api.allowed()) return;
    stop(); provider = api.provider(); language = api.language();
    const session = epoch;
    change('requesting'); api.quiet();
    if (!['openai','google','groq'].includes(provider)) { fail(provider ? 'unsupported_provider' : 'key'); return; }
    try {
      primeAudio();
      consent = await api.consent(provider);
      if (!valid(session)) { if (session === epoch) stop(); return; }
      if (!consent) { release(); change('consent'); return; }
      await listen(session);
    } catch (error) { if (session === epoch) fail(error); }
  }
  return {
    begin, stop,
    get state() { return state; },
    async agree() {
      if (state !== 'consent') return;
      const session = epoch;
      if (!valid(session)) { stop(); return; }
      change('requesting');
      try {
        primeAudio();
        await api.saveConsent(provider, true);
        if (valid(session)) { consent = true; await listen(session); }
      } catch { if (session === epoch) fail('storage'); }
    },
    async revoke() { stop(); try { await api.saveConsent('', false); consent = false; } catch { fail('storage'); } },
  };
}
