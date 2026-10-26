// 라비 목소리(Supertonic 3) — 합성 파이프라인·폴백·취소·캐시 시험. 가짜 장치만 쓴다(네트워크·지갑 없음).
// 진짜 모델 시험(기준 wav 와 길이 비교)은 모델·크롬이 있을 때만 scripts/ravi-tts-real.mjs 가 한다.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
function load(file, extra = {}) {
  const exports = {};
  vm.runInNewContext(ts.transpileModule(readFileSync(file, 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText,
    { exports, require: n => { throw new Error('no require ' + n); }, BigInt64Array, Float32Array, Uint8Array, TextDecoder, DataView, ArrayBuffer, Promise, Math, Number, Map, Object, Error, URL, setTimeout, clearTimeout, ...extra });
  return exports;
}
const core = load('src/ravi-tts-core.ts');
const tts = load('src/ravi-tts.ts');
const voiceMod = load('src/ravi-voice.ts', { SpeechSynthesisVoice: class {} });

test('전처리: 마침표 보충·태그·기호 정리', () => {
  assert.equal(core.preprocessText('안녕하세요'.normalize('NFC')), '<ko>' + '안녕하세요.'.normalize('NFKD') + '</ko>');
  assert.equal(core.preprocessText('a _ b ,c [x]  😀'), '<ko>a b,c x.</ko>');
  assert.equal(core.preprocessText('끝났어요?'), '<ko>' + '끝났어요?'.normalize('NFKD') + '</ko>');
});
test('나누기: 120자 안으로 문장 단위', () => {
  assert.deepEqual(Array.from(core.chunkText('안녕. 반가워요!')), ['안녕. 반가워요!']);
  const long = Array.from({ length: 10 }, (_, i) => '이것은 꽤 긴 문장 번호 ' + i + ' 입니다.').join(' ');
  const parts = core.chunkText(long, 60); assert.ok(parts.length > 2); assert.ok(parts.every(p => p.length <= 60));
});
test('샘플레이트 규칙: 44100 → ×1.1553 선언(길이 그대로, 음만 +2.5음)', () => {
  assert.equal(core.RAVI_SPEED, 0.908); assert.equal(core.RAVI_PLAYBACK_FACTOR, 1.1553);
  assert.equal(core.playbackRate(44100), Math.round(44100 * 1.1553));
  assert.ok(Math.abs(core.RAVI_PLAYBACK_FACTOR - 2 ** (2.5 / 12)) < 1e-4);
});
test('소리 점검: NaN·무음·너무 짧음은 쓰지 않는다', () => {
  const ok = new Float32Array(50000).map((_, i) => 0.3 * Math.sin(i / 7));
  assert.equal(core.checkSamples(ok, 50000).ok, true);
  const nan = ok.slice(); nan[5] = NaN; assert.equal(core.checkSamples(nan, 50000).ok, false);
  assert.equal(core.checkSamples(new Float32Array(50000), 50000).ok, false);
  assert.equal(core.checkSamples(new Float32Array(10).fill(0.5), 50000).ok, false);
});
test('WAV 머리글', () => {
  const b = core.encodeWav(new Float32Array([0, 1, -1]), 50949), v = new DataView(b.buffer);
  assert.equal(String.fromCharCode(...b.slice(0, 4)), 'RIFF'); assert.equal(v.getUint32(24, true), 50949); assert.equal(b.length, 44 + 6); assert.equal(v.getInt16(46, true), 32767);
});
test('합성 흐름(가짜 모델): 길이 = 예측 길이 / 0.908, 네 모델을 순서대로 부른다', async () => {
  const calls = []; const T = class { constructor(type, data, dims) { this.type = type; this.data = data; this.dims = dims; } };
  const rt = { Tensor: T,
    dp: { run: async () => { calls.push('dp'); return { duration: { data: [5.0] } }; } },
    enc: { run: async () => { calls.push('enc'); return { text_emb: new T('float32', new Float32Array(4), [1, 4]) }; } },
    vec: { run: async f => { calls.push('vec'); assert.equal(f.noisy_latent.dims[1], 144); return { denoised_latent: { data: f.noisy_latent.data } }; } },
    voc: { run: async f => { calls.push('voc'); const n = f.latent.dims[2] * 3072; return { wav_tts: { data: new Float32Array(n).map((_, i) => 0.4 * Math.sin(i / 9)) } }; } } };
  const cfg = { ae: { sample_rate: 44100, base_chunk_size: 512 }, ttl: { latent_dim: 24, chunk_compress_factor: 6 } };
  const style = { ttl: { data: new Float32Array(2), dims: [1, 1, 2] }, dp: { data: new Float32Array(2), dims: [1, 1, 2] } };
  const r = await core.synthesize(rt, cfg, new Array(65536).fill(1), style, '안녕하세요.', { steps: 3 });
  assert.equal(calls.filter(c => c === 'vec').length, 3); assert.deepEqual(calls.slice(0, 2), ['dp', 'enc']); assert.equal(calls.at(-1), 'voc');
  const seconds = 5.0 / 0.908; assert.ok(Math.abs(r.samples.length / 44100 - seconds) < 0.01, '예측 길이대로 자른다');
  assert.equal(r.sampleRate, core.playbackRate(44100));
  assert.equal(core.checkSamples(r.samples, r.sampleRate).ok, true);
});
test('같은 시드 = 같은 잡음', () => { assert.deepEqual(Array.from(core.gaussianNoise(8, 7)), Array.from(core.gaussianNoise(8, 7))); });

// ── 관리자(폴백·취소·캐시) ──
const wavBytes = () => core.encodeWav(new Float32Array(2000).fill(0.3), 50949);
function rig({ status = { ok: true, sizes: [['dp', 4], ['enc', 4], ['vec', 4], ['voc', 4], ['cfg', 2], ['indexer', 2], ['style', 2], ['license', 2]] }, invokeFail = false, workerMode = 'ok', playFail = false } = {}) {
  const log = { workers: 0, speaks: [], cancels: [], played: 0, stopped: 0 };
  const timers = []; const sched = { setTimer: (f, ms) => timers.push({ f, ms }), clearTimer: () => {} };
  const worker = () => { log.workers++; const w = { onmessage: null, onerror: null, terminate() {}, postMessage(m) {
    if (m.type === 'init') queueMicrotask(() => w.onmessage({ data: workerMode === 'initfail' ? { type: 'error', phase: 'init', id: 0, message: 'x' } : { type: 'ready' } }));
    else if (m.type === 'speak') { log.speaks.push(m.text); if (workerMode === 'hang') return; queueMicrotask(() => w.onmessage({ data: workerMode === 'error' ? { type: 'error', id: m.id, message: 'bad-sound' } : { type: 'done', id: m.id, wav: wavBytes(), seconds: 1, ms: 5 } })); }
    else if (m.type === 'cancel') log.cancels.push(m.id);
  } }; return w; };
  const deps = { base: '/ravi-tts/', ...sched, newWorker: worker,
    invoke: async (c, a) => { if (invokeFail) throw new Error('boom'); if (c === 'ravi_tts_status') return status; return new Uint8Array(a.len); },
    play: async () => { if (playFail) throw new Error('blocked'); log.played++; let end; const ended = new Promise(r => { end = r; }); setTimeout(end, 5); return { ended, stop() { log.stopped++; end(); } }; } };
  return { t: tts.createRaviTts(deps), log, timers };
}
test('정상: 만들어서 재생하고 같은 문장은 캐시', async () => {
  const { t, log } = rig(); let started = 0;
  assert.equal(await t.speak('안녕하세요', { started: () => started++ }), 'played'); assert.equal(started, 1);
  assert.equal(await t.speak('안녕하세요'), 'played'); assert.equal(log.speaks.length, 1, '두 번째는 캐시'); assert.equal(log.workers, 1); assert.equal(log.played, 2);
});
test('폴백: 리소스 없음/깨짐 → fallback (워커도 안 만든다)', async () => {
  const { t, log } = rig({ status: { ok: false, missing: ['vec'] } });
  assert.equal(await t.speak('안녕'), 'fallback'); assert.equal(log.workers, 0); assert.equal(t.state, 'unavailable');
  assert.equal(await t.speak('또'), 'fallback');
});
test('폴백: 읽기 오류·워커 초기화 실패·합성 실패·재생 막힘', async () => {
  assert.equal(await rig({ invokeFail: true }).t.speak('가'), 'fallback');
  assert.equal(await rig({ workerMode: 'initfail' }).t.speak('가'), 'fallback');
  assert.equal(await rig({ workerMode: 'error' }).t.speak('가'), 'fallback');
  assert.equal(await rig({ playFail: true }).t.speak('가'), 'fallback');
});
test('폴백: 너무 느리면(제한 시간) fallback, 두 번 느리면 이번 실행은 기기 목소리', async () => {
  const { t, timers, log } = rig({ workerMode: 'hang' });
  for (let n = 1; n <= 2; n++) {
    const p = t.speak('느린 문장 ' + n);
    for (let i = 0; i < 20; i++) await new Promise(r => setTimeout(r, 1));
    const slow = timers.filter(x => x.ms === tts.synthBudgetMs('느린 문장 ' + n)).pop(); assert.ok(slow, '제한 시간이 걸려 있다'); slow.f();
    assert.equal(await p, 'fallback');
  }
  assert.equal(t.state, 'unavailable'); assert.ok(log.cancels.length >= 2, '워커에게 취소를 알린다');
});
test('취소: 말하는 도중 새 요청이 오면 이전 것은 cancelled', async () => {
  const { t, log } = rig(); const first = t.speak('첫 문장'); await new Promise(r => setTimeout(r, 0));
  const second = t.speak('둘째 문장');
  assert.equal(await first, 'cancelled'); assert.equal(await second, 'played');
});
test('시간 제한 식: 6초 분량 문장에 충분하고 끝없이 기다리지 않는다', () => {
  assert.ok(tts.synthBudgetMs('안녕하세요, 저는 라비예요. 오늘 레이븐볼트에서 무엇을 도와 드릴까요?') >= 10000); assert.ok(tts.synthBudgetMs('가'.repeat(400)) <= 40000);
});

// ── 말하기 어댑터: 라비 목소리 실패 → 기기 목소리 ──
function voiceRig(raviResult, { prefer = true, voices = [{ lang: 'ko-KR', name: 'Yuna' }] } = {}) {
  const ev = { tags: 0, device: 0, ended: 0, ai: [], cancelled: 0, boundary: 0 };
  const synthesis = { getVoices: () => voices, cancel() {}, speak() { ev.device++; } };
  class U { constructor(t) { this.text = t; } }
  const v = voiceMod.createRaviVoice({ synthesis, utterance: U, allowed: () => true, transcript() {}, listening() {}, boundary: () => ev.boundary++, ended: () => ev.ended++, unavailable() {},
    ravi: { speak: async (t, h) => { if (raviResult === 'throw') throw new Error('x'); if (raviResult === 'played') h.started?.(); return raviResult; }, cancel: () => ev.cancelled++, warm: async () => true },
    preferRavi: () => prefer, aiVoice: on => ev.ai.push(on), aiTag: () => ev.tags++ });
  v.setEnabled(true); return { v, ev };
}
const settle = () => new Promise(r => setTimeout(r, 5));
test('어댑터: 라비 목소리 성공 → 기기 목소리 안 씀, 「AI 음성」 켰다가 끈다', async () => {
  const { v, ev } = voiceRig('played'); assert.equal(v.speak('안녕'), true); await settle();
  assert.equal(ev.device, 0); assert.equal(ev.tags, 0, 'bubble 을 안 넘기면 말풍선 표시 없음'); assert.deepEqual(ev.ai.filter(Boolean).length, 1); assert.equal(ev.ai.at(-1), false); assert.equal(ev.ended, 1);
});
test('어댑터: 소리가 나기 시작하면 그 말풍선에 표시, 폴백이면 표시 안 붙임', async () => {
  const a = voiceRig('played'); a.v.speak('안녕', {}); await settle(); assert.equal(a.ev.tags, 1);
  const b = voiceRig('fallback'); b.v.speak('안녕', {}); await settle(); assert.equal(b.ev.tags, 0);
});
test('어댑터: 실패/예외 → 기기 목소리로 자동 폴백', async () => {
  for (const r of ['fallback', 'throw']) { const { v, ev } = voiceRig(r); v.speak('안녕'); await settle(); assert.equal(ev.device, 1, r); assert.equal(ev.ai.at(-1), false); }
});
test('어댑터: 폴백인데 기기 한국어 목소리도 없으면 화면을 쉬는 모습으로 돌린다', async () => {
  const { v, ev } = voiceRig('fallback', { voices: [] }); v.speak('안녕'); await settle(); assert.equal(ev.device, 0); assert.equal(ev.ended, 1);
});
test('어댑터: 「기기 목소리」 선택이면 라비 목소리를 아예 안 부른다(옛 경로)', async () => {
  const { v, ev } = voiceRig('played', { prefer: false }); assert.equal(v.speak('안녕'), true); await settle(); assert.equal(ev.device, 1); assert.equal(ev.ai.filter(Boolean).length, 0);
});
test('어댑터: 말하는 도중 새 요청 → 이전 라비 결과는 버린다', async () => {
  const { v, ev } = voiceRig('fallback'); v.speak('하나'); v.speak('둘'); await settle(); assert.equal(ev.device, 1, '새 요청만 말한다(옛 결과가 새 말을 덮거나 겹치지 않음)');
});
