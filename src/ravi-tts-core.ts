// 라비 목소리(Supertonic 3, 내 컴퓨터 안에서 만드는 한국어 음성) — 순수 계산부.
// ONNX 런타임·창·파일을 모른다: 모델 네 개는 `run()` 만 가진 물건으로 주입받는다(시험은 가짜로, 워커는 진짜로).
// 기준: 모델 폴더의 py/helper.py. 확정 규칙(바꾸지 말 것): lang=ko, 목소리 F1, speed 0.908 로 만든 뒤
// 샘플레이트를 ×1.1553 으로 「선언」해서 재생 → 길이는 그대로, 음만 +2.5음. 별도 신호 처리는 없다.

export const RAVI_LANG = "ko";
export const RAVI_SPEED = 0.908;
export const RAVI_PLAYBACK_FACTOR = 1.1553; // 2^(2.5/12)
export const RAVI_STEPS = 8; // 기준 소리를 만든 값(py 기본)
export const RAVI_SILENCE_SEC = 0.3;
export const RAVI_MAX_TEXT = 400; // 한 번에 읽는 글자 상한 — 더 길면 앞부분만(느려지지 않게)

/** 만든 소리를 틀 때 쓸 샘플레이트(선언만 바꾼다). */
export function playbackRate(sampleRate: number): number { return Math.round(sampleRate * RAVI_PLAYBACK_FACTOR); }

export interface TtsConfig { ae: { sample_rate: number; base_chunk_size: number }; ttl: { latent_dim: number; chunk_compress_factor: number } }
export interface TtsStyle { ttl: { data: Float32Array; dims: number[] }; dp: { data: Float32Array; dims: number[] } }
export interface TtsSession { run(feeds: Record<string, unknown>): Promise<Record<string, { data: ArrayLike<number> | BigInt64Array | Float32Array }>> }
export interface TtsRuntime {
  Tensor: new (type: string, data: unknown, dims: number[]) => unknown;
  dp: TtsSession; enc: TtsSession; vec: TtsSession; voc: TtsSession;
}

const EMOJI = /[\u{1f600}-\u{1f64f}\u{1f300}-\u{1f5ff}\u{1f680}-\u{1f6ff}\u{1f700}-\u{1f77f}\u{1f780}-\u{1f7ff}\u{1f800}-\u{1f8ff}\u{1f900}-\u{1f9ff}\u{1fa00}-\u{1fa6f}\u{1fa70}-\u{1faff}☀-⛿✀-➿\u{1f1e6}-\u{1f1ff}]+/gu;
const REPLACE: [string, string][] = [["–", "-"], ["‑", "-"], ["—", "-"], ["_", " "], ["“", '"'], ["”", '"'], ["‘", "'"], ["’", "'"], ["´", "'"], ["`", "'"], ["[", " "], ["]", " "], ["|", " "], ["/", " "], ["#", " "], ["→", " "], ["←", " "]];

/** 글을 모델이 읽는 꼴로: 기호 정리 → 끝 마침표 → `<ko>…</ko>`. */
export function preprocessText(text: string, lang = RAVI_LANG): string {
  let s = text.normalize("NFKD").replace(EMOJI, "");
  for (const [a, b] of REPLACE) s = s.split(a).join(b);
  s = s.replace(/[♥☆♡©\\]/g, "");
  s = s.split("@").join(" at ").split("e.g.,").join("for example, ").split("i.e.,").join("that is, ");
  s = s.replace(/ ,/g, ",").replace(/ \./g, ".").replace(/ !/g, "!").replace(/ \?/g, "?").replace(/ ;/g, ";").replace(/ :/g, ":").replace(/ '/g, "'");
  while (s.includes('""')) s = s.split('""').join('"');
  while (s.includes("''")) s = s.split("''").join("'");
  while (s.includes("``")) s = s.split("``").join("`");
  s = s.replace(/\s+/g, " ").trim();
  if (!/[.!?;:,'")\]}…。」』】〉》›»]$/.test(s)) s += ".";
  return `<${lang}>${s}</${lang}>`;
}

/** 문장 단위로 나눠 max_len(한국어 120) 안으로 묶는다 — helper.py chunk_text 와 같은 규칙. */
export function chunkText(text: string, maxLen = 120): string[] {
  const out: string[] = [];
  for (const raw of text.trim().split(/\n\s*\n+/)) {
    const paragraph = raw.trim(); if (!paragraph) continue;
    const sentences = paragraph.split(/(?<=[.!?])\s+/);
    let cur = "";
    for (const sentence of sentences) {
      if (cur.length + sentence.length + 1 <= maxLen) cur += (cur ? " " : "") + sentence;
      else { if (cur) out.push(cur.trim()); cur = sentence; }
    }
    if (cur) out.push(cur.trim());
  }
  return out;
}

export function textToIds(processed: string, indexer: ArrayLike<number>): BigInt64Array {
  const ids = new BigInt64Array(processed.length);
  for (let i = 0; i < processed.length; i++) {
    const id = indexer[processed.charCodeAt(i)];
    ids[i] = BigInt(id === undefined || id < 0 ? 0 : id); // 모르는 글자는 0(빈 칸)으로 — 멈추지 않는다
  }
  return ids;
}

/** 시드가 같으면 같은 소리가 나오는 난수(시험·캐시가 흔들리지 않게). */
export function gaussianNoise(count: number, seed: number): Float32Array {
  let a = seed >>> 0;
  const rand = () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const out = new Float32Array(count);
  for (let i = 0; i < count; i += 2) {
    const u = Math.max(rand(), 1e-12), v = rand(), r = Math.sqrt(-2 * Math.log(u));
    out[i] = r * Math.cos(2 * Math.PI * v); if (i + 1 < count) out[i + 1] = r * Math.sin(2 * Math.PI * v);
  }
  return out;
}

async function inferChunk(rt: TtsRuntime, cfg: TtsConfig, indexer: ArrayLike<number>, style: TtsStyle, chunk: string, steps: number, speed: number, seed: number, cancelled: () => boolean) {
  const T = rt.Tensor;
  const ids = textToIds(preprocessText(chunk), indexer), n = ids.length;
  const textIds = new T("int64", ids, [1, n]), mask = new Float32Array(n).fill(1), textMask = new T("float32", mask, [1, 1, n]);
  const styleDp = new T("float32", style.dp.data, style.dp.dims), styleTtl = new T("float32", style.ttl.data, style.ttl.dims);
  const dur = (await rt.dp.run({ text_ids: textIds, style_dp: styleDp, text_mask: textMask })).duration.data as ArrayLike<number>;
  const seconds = dur[0] / speed;
  if (!(seconds > 0) || seconds > 60) throw new Error("duration");
  const emb = (await rt.enc.run({ text_ids: textIds, style_ttl: styleTtl, text_mask: textMask })).text_emb;
  const sr = cfg.ae.sample_rate, chunkSize = cfg.ae.base_chunk_size * cfg.ttl.chunk_compress_factor;
  const latentLen = Math.trunc((seconds * sr + chunkSize - 1) / chunkSize), latentDim = cfg.ttl.latent_dim * cfg.ttl.chunk_compress_factor;
  const validLen = Math.floor((Math.floor(seconds * sr) + chunkSize - 1) / chunkSize);
  const lmask = new Float32Array(latentLen); lmask.fill(1, 0, Math.min(validLen, latentLen));
  let xt = gaussianNoise(latentDim * latentLen, seed);
  for (let d = 0; d < latentDim; d++) for (let t = 0; t < latentLen; t++) xt[d * latentLen + t] *= lmask[t];
  const latentMask = new T("float32", lmask, [1, 1, latentLen]);
  const total = new T("float32", new Float32Array([steps]), [1]);
  for (let step = 0; step < steps; step++) {
    if (cancelled()) throw new Error("cancelled");
    const out = await rt.vec.run({
      noisy_latent: new T("float32", xt, [1, latentDim, latentLen]), text_emb: emb, style_ttl: styleTtl,
      text_mask: textMask, latent_mask: latentMask, current_step: new T("float32", new Float32Array([step]), [1]), total_step: total,
    });
    xt = Float32Array.from(out.denoised_latent.data as ArrayLike<number>);
  }
  const wav = (await rt.voc.run({ latent: new T("float32", xt, [1, latentDim, latentLen]) })).wav_tts.data as ArrayLike<number>;
  return { wav: Float32Array.from(wav), seconds };
}

export interface SynthResult { samples: Float32Array; sampleRate: number; seconds: number }
/** 한 문장(또는 짧은 글)을 만든다. 돌려주는 sampleRate 는 「틀 때 선언할」 값(×1.1553)이다. */
export async function synthesize(rt: TtsRuntime, cfg: TtsConfig, indexer: ArrayLike<number>, style: TtsStyle, text: string,
  o: { steps?: number; speed?: number; seed?: number; cancelled?: () => boolean } = {}): Promise<SynthResult> {
  const steps = o.steps ?? RAVI_STEPS, speed = o.speed ?? RAVI_SPEED, seed = o.seed ?? 1234, cancelled = o.cancelled ?? (() => false);
  const chunks = chunkText(text.slice(0, RAVI_MAX_TEXT), 120);
  if (!chunks.length) throw new Error("empty");
  const sr = cfg.ae.sample_rate, parts: Float32Array[] = []; let seconds = 0;
  for (let i = 0; i < chunks.length; i++) {
    if (cancelled()) throw new Error("cancelled");
    const r = await inferChunk(rt, cfg, indexer, style, chunks[i], steps, speed, seed + i, cancelled);
    if (i > 0) { parts.push(new Float32Array(Math.floor(RAVI_SILENCE_SEC * sr))); seconds += RAVI_SILENCE_SEC; }
    parts.push(r.wav); seconds += r.seconds;
  }
  const all = new Float32Array(parts.reduce((s, p) => s + p.length, 0)); let at = 0;
  for (const p of parts) { all.set(p, at); at += p.length; }
  const samples = all.subarray(0, Math.min(all.length, Math.floor(sr * seconds)));
  return { samples, sampleRate: playbackRate(sr), seconds: samples.length / playbackRate(sr) };
}

export interface WavCheck { ok: boolean; seconds: number; peak: number; nan: number; silent: boolean }
/** 만든 소리가 쓸 만한가: NaN 없음·무음 아님·너무 짧지 않음. 아니면 폴백(기기 목소리)으로 간다. */
export function checkSamples(samples: ArrayLike<number>, rate: number): WavCheck {
  let peak = 0, nan = 0;
  for (let i = 0; i < samples.length; i++) { const v = samples[i]; if (!Number.isFinite(v)) { nan++; continue; } const a = Math.abs(v); if (a > peak) peak = a; }
  const seconds = samples.length / rate;
  return { ok: nan === 0 && peak > 0.01 && seconds >= 0.2, seconds, peak, nan, silent: peak <= 0.01 };
}

/** 16비트 모노 WAV 바이트. */
export function encodeWav(samples: ArrayLike<number>, rate: number): Uint8Array {
  const n = samples.length, buf = new ArrayBuffer(44 + n * 2), v = new DataView(buf);
  const tag = (o: number, s: string) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  tag(0, "RIFF"); v.setUint32(4, 36 + n * 2, true); tag(8, "WAVE"); tag(12, "fmt "); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); tag(36, "data"); v.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) { const x = Math.max(-1, Math.min(1, samples[i])); v.setInt16(44 + i * 2, x < 0 ? x * 0x8000 : x * 0x7fff, true); }
  return new Uint8Array(buf);
}

export function parseStyle(json: { style_ttl: { data: unknown; dims: number[] }; style_dp: { data: unknown; dims: number[] } }): TtsStyle {
  const flat = (x: unknown): number[] => Array.isArray(x) ? (x as unknown[]).flatMap(flat) : [x as number];
  return { ttl: { data: Float32Array.from(flat(json.style_ttl.data)), dims: json.style_ttl.dims }, dp: { data: Float32Array.from(flat(json.style_dp.data)), dims: json.style_dp.dims } };
}
