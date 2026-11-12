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

// ── 문장 조각(스트리밍) — 폰 phone/ui/ravi/ravi-voice-core.ts 의 voiceChunks 와 같은 규칙(바꾸면 둘 다) ──
/**
 * 읽을 글 → 차례로 합성할 조각들(문장 단위). 첫 조각을 짧게 해서 첫 소리를 빨리 낸다 — 글 전체를 다 만든 뒤에 틀면 3~4문장 답에 십수 초가 걸린다(11-13 실측).
 * - 문장 끝(. ! ? … 。 ！ ？ 뒤 빈칸·끝)에서 나눈다. 소수점(3.5)·약어(e.g. Mr. etc.)·번호(1. 2.)에서는 안 나눈다.
 * - 너무 긴 문장(maxLen=40 초과 — 앞 조각이 재생되는 동안 다음 조각을 만들 수 있게 짧게)은 쉼표에서, 그래도 길면 빈칸에서 나눈다.
 * - 첫 문장이 firstMax 보다 길면 가장 이른 숨 쉬는 자리에서 한 번 더 나눈다: 쉼표, 또는 이어지는 말끝(…고, …면, …서, …는데, …지만)·주제/주어 조사(…은/는/이/가/에서) 뒤에 쉼표를 붙여(억양이 이어지게).
 * - 읽을 글자(글자·숫자)가 없는 조각(이모지만 등)은 앞 조각에 붙인다.
 */
const SENTENCE_END = /([.!?…。！？]+)(["'”’)\]」』]*)(\s+|$)/g;
const ABBREVIATION = /^(?:e\.g|i\.e|etc|vs|mr|mrs|ms|dr|prof|st|no|inc|ltd|jr|sr|approx|a\.m|p\.m)\.$/i;
const SPEAKABLE = /[\p{L}\p{N}]/u;
const CONNECTIVE = /(?:고|면|서|며|는데|은데|지만|니까|으니|려면|도록|거나|든지|면서|어서|아서|해서|하고)$/;
/** 첫 조각만: 말할 때 숨을 쉬는 자리(주제·주어 조사 뒤) — 「복구 단어는, 이 지갑을…」 */
const TOPIC = /[가-힣](?:은|는|이|가|에서|에게|께서|도|마다|부터|까지|에는|에도|으로|로|에)$/;
/** 이 말로 시작하는 낱말 앞에서는 끊지 않는다(앞말에 붙어 한 덩어리: 「옮길 수」「할 때」「본 적」). */
const BOUND_NEXT = /^(?:수|것|거|때|줄|적|뿐|만큼|대로|듯|중|등|번|개|분|원)(?:$|[^가-힣]|[은는이가을를도에의와과로])/;
function sentencesOf(text: string): string[] {
  const out: string[] = []; let start = 0;
  for (const m of text.matchAll(SENTENCE_END)) {
    const end = m.index! + m[1].length + m[2].length;
    const piece = text.slice(start, end).trim(), last = piece.split(/\s+/).pop() ?? '';
    if (m[3] && m[1] === '.' && (ABBREVIATION.test(last) || /^\d{1,3}\.$/.test(last))) continue;   // 약어·번호 목록은 문장 끝이 아니다
    if (piece) out.push(piece);
    start = end + m[3].length;
  }
  const rest = text.slice(start).trim(); if (rest) out.push(rest);
  return out;
}
function pack(parts: string[], maxLen: number, join = ' '): string[] {
  const out: string[] = []; let cur = '';
  for (const p of parts) { if (cur && cur.length + join.length + p.length > maxLen) { out.push(cur); cur = p; } else cur = cur ? cur + join + p : p; }
  if (cur) out.push(cur);
  return out;
}
/** 쉼표도 없이 긴 부분: 빈칸에서 고르게 나눈다 — 길이가 고른 자리 중 숨 쉬는 자리(이어지는 말끝·조사 뒤)를 먼저 고르고, 「옮길 수」처럼 붙은 말은 떼지 않는다.
 *  문장 중간에서 끊은 곳엔 쉼표를 붙인다(억양이 이어지게 — 안 붙이면 합성 전처리가 마침표를 붙인다). */
function splitWords(part: string, maxLen: number): string[] {
  const words = part.split(/\s+/), out: string[] = [];
  let from = 0;
  while (from < words.length) {
    const left = words.slice(from).join(' ');
    if (left.length <= maxLen) { out.push(left); break; }
    const n = Math.ceil(left.length / maxLen), target = left.length / n;
    let best = -1, bestScore = Infinity, head = '';
    for (let i = from; i < words.length - 1; i++) {
      head = head ? head + ' ' + words[i] : words[i];
      if (head.length > maxLen) break;
      if (head.length < target * 0.5 || BOUND_NEXT.test(words[i + 1])) continue;
      const score = Math.abs(head.length - target) - (CONNECTIVE.test(words[i]) || TOPIC.test(words[i]) || /(?:을|를)$/.test(words[i]) ? maxLen / 3 : 0);
      if (score < bestScore) { bestScore = score; best = i; }
    }
    if (best < 0) { out.push(left); break; }   // 끊을 자리가 없으면 그대로(합성기가 한 번에 읽는다)
    const piece = words.slice(from, best + 1).join(' ');
    out.push(/[,，、]$/.test(piece) ? piece : piece + ','); from = best + 1;
  }
  return out;
}
function splitLong(sentence: string, maxLen: number): string[] {
  if (sentence.length <= maxLen) return [sentence];
  const out: string[] = [];
  for (const part of pack(sentence.split(/(?<=[,，、])\s+/), maxLen)) out.push(...(part.length <= maxLen ? [part] : splitWords(part, maxLen)));
  return out;
}
function splitFirst(sentence: string, firstMax: number): string[] {
  if (sentence.length <= firstMax) return [sentence];
  // 가장 이른 자연스러운 끊김: 쉼표(머리 5자 이상) 또는 이어지는 말끝 낱말(머리 6자 이상, 쉼표를 붙인다). 머리는 firstMax×2 안, 꼬리는 4자 이상.
  const words = sentence.split(' '); let head = '';
  for (let i = 0; i < words.length - 1; i++) {
    head = head ? head + ' ' + words[i] : words[i];
    if (head.length > firstMax * 2) break;
    const tail = words.slice(i + 1).join(' ');
    if (tail.length < 4) break;
    if (BOUND_NEXT.test(words[i + 1])) continue;
    if (/[,，、]$/.test(words[i]) && head.length >= 5) return [head, tail];
    if ((CONNECTIVE.test(words[i]) || TOPIC.test(words[i])) && head.length >= 6) return [head + ',', tail];
  }
  return [sentence];
}
export function voiceChunks(text: string, o: { firstMax?: number; maxLen?: number } = {}): string[] {
  const firstMax = o.firstMax ?? 10, maxLen = o.maxLen ?? 40;
  const chunks: string[] = [];
  const sentences = sentencesOf(text.replace(/\s+/g, ' ').trim());
  if (sentences.length) sentences.splice(0, 1, ...splitFirst(sentences[0], firstMax));   // 첫 문장은 먼저 짧은 머리를 떼어 낸다(첫 소리)
  for (const s of sentences) for (const c of splitLong(s, maxLen)) {
    if (!SPEAKABLE.test(c) && chunks.length) chunks[chunks.length - 1] += ' ' + c;   // 이모지·기호만 → 앞에 붙인다(합성 전처리가 지운다)
    else chunks.push(c);
  }
  while (chunks.length > 1 && !SPEAKABLE.test(chunks[0])) chunks.splice(0, 2, chunks[0] + ' ' + chunks[1]);
  if (!chunks.length || !SPEAKABLE.test(chunks.join(''))) return [];
  return chunks;
}
/** 앞 조각 다음에 둘 쉼(초). 문장 사이 0.3초(합성 기준 RAVI_SILENCE_SEC 와 같다), 쉼표로 나눈 곳은 짧게. */
export const chunkPauseSec = (previous: string): number => /[,，、]$/.test(previous) ? 0.12 : 0.3;

