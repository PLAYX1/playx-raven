import { MAX_PREVIEW_CLIP_BYTES } from './manifest';

/*
 * 미리듣기 클립 만들기(순수 계산). 디코딩된 소리(PCM)에서 [startMs, endMs) 구간을 잘라 16비트 WAV 로 인코딩한다.
 * 디코딩(mp3·m4a 등 → PCM)은 이 파일의 일이 아니다 — 데스크탑은 웹뷰의 AudioContext.decodeAudioData 로 하고, 못 하면(코덱 미지원 등)
 * 미리듣기를 **끈다**(details.previewFile = null). 곡 전체를 「미리듣기」라고 올려 두지 않는다.
 * 크기가 MAX_PREVIEW_CLIP_BYTES 를 넘으면 모노로 섞고, 그래도 넘으면 null(끈다).
 */
export function pcmToWavClip(p: { channels: ReadonlyArray<Float32Array>; sampleRate: number; startMs: number; endMs: number }): Uint8Array | null {
  const { channels, sampleRate } = p;
  if (!channels.length || channels.length > 2 || !Number.isInteger(sampleRate) || sampleRate < 8000 || sampleRate > 96000) return null;
  const total = channels[0].length;
  if (channels.some(c => c.length !== total)) return null;
  const from = Math.floor(p.startMs / 1000 * sampleRate), to = Math.min(total, Math.floor(p.endMs / 1000 * sampleRate));
  if (!(to > from) || (to - from) < sampleRate) return null; // 1초 미만이면 클립이 아니다
  const frames = to - from;
  let ch = channels.length;
  const bytesFor = (c: number) => 44 + frames * c * 2;
  if (bytesFor(ch) > MAX_PREVIEW_CLIP_BYTES) ch = 1;
  if (bytesFor(ch) > MAX_PREVIEW_CLIP_BYTES) return null;
  const out = new Uint8Array(bytesFor(ch));
  const dv = new DataView(out.buffer);
  const ascii = (at: number, s: string) => { for (let i = 0; i < s.length; i++) out[at + i] = s.charCodeAt(i); };
  ascii(0, 'RIFF'); dv.setUint32(4, out.length - 8, true); ascii(8, 'WAVE'); ascii(12, 'fmt '); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true);
  dv.setUint16(22, ch, true); dv.setUint32(24, sampleRate, true); dv.setUint32(28, sampleRate * ch * 2, true); dv.setUint16(32, ch * 2, true); dv.setUint16(34, 16, true);
  ascii(36, 'data'); dv.setUint32(40, frames * ch * 2, true);
  const s16 = (x: number) => Math.max(-32768, Math.min(32767, Math.round((Number.isFinite(x) ? Math.max(-1, Math.min(1, x)) : 0) * 32767)));
  let at = 44;
  for (let i = from; i < to; i++) {
    if (ch === 1) { let m = 0; for (const c of channels) m += c[i]; dv.setInt16(at, s16(m / channels.length), true); at += 2; }
    else for (let c = 0; c < ch; c++) { dv.setInt16(at, s16(channels[c][i]), true); at += 2; }
  }
  return out;
}
