// 라비 목소리(Supertonic 3) — 합성 파이프라인·폴백·취소·캐시 시험. 가짜 장치만 쓴다(네트워크·지갑 없음).
// 진짜 모델 시험(기준 wav 와 길이 비교)은 모델·크롬이 있을 때만 scripts/ravi-tts-real.mjs 가 한다.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
function load(file, extra = {}, modules = {}) {
  const exports = {};
  vm.runInNewContext(ts.transpileModule(readFileSync(file, 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText,
    { exports, require: n => { if (n in modules) return modules[n]; throw new Error('no require ' + n); }, BigInt64Array, Float32Array, Uint8Array, TextDecoder, DataView, ArrayBuffer, Promise, Math, Number, Map, Object, Error, URL, setTimeout, clearTimeout, ...extra });
  return exports;
}
const core = load('src/ravi-tts-core.ts');
const tts = load('src/ravi-tts.ts', {}, { './ravi-tts-core': core });
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
const pcmFor = text => new Float32Array(1000 + text.length).fill(0.3);   // 길이로 어떤 조각인지 알아본다
function rig({ status = { ok: true, sizes: [['dp', 4], ['enc', 4], ['vec', 4], ['voc', 4], ['cfg', 2], ['indexer', 2], ['style', 2], ['license', 2]] }, invokeFail = false, workerMode = 'ok', playFail = false, failText = null, playMs = 5 } = {}) {
  const log = { workers: 0, speaks: [], cancels: [], played: 0, stopped: 0, pushes: [], events: [] }; const held = [];
  const timers = []; const sched = { setTimer: (f, ms) => timers.push({ f, ms }), clearTimer: () => {} };
  const worker = () => { log.workers++; const w = { onmessage: null, onerror: null, terminate() {}, postMessage(m) {
    if (m.type === 'init') queueMicrotask(() => w.onmessage({ data: workerMode === 'initfail' ? { type: 'error', phase: 'init', id: 0, message: 'x' } : { type: 'ready' } }));
    else if (m.type === 'speak') { log.speaks.push(m.text); log.events.push('synth:' + m.text); if (workerMode === 'hang') return;
      const answer = () => w.onmessage?.({ data: workerMode === 'error' || m.text === failText ? { type: 'error', id: m.id, message: 'bad-sound' } : { type: 'done', id: m.id, pcm: pcmFor(m.text), rate: 50949, seconds: 1, ms: 5 } });
      if (workerMode === 'manual') held.push({ text: m.text, send: answer }); else queueMicrotask(answer); }
    else if (m.type === 'cancel') { log.cancels.push(m.id); log.events.push('cancel'); }
  } }; return w; };
  const deps = { base: '/ravi-tts/', ...sched, newWorker: worker,
    invoke: async (c, a) => { if (invokeFail) throw new Error('boom'); if (c === 'ravi_tts_status') return status; return new Uint8Array(a.len); },
    queue: async () => {
      if (playFail) throw new Error('blocked');
      let pending = 0, stopped = false; const waiters = []; const settle = () => { if (stopped || pending === 0) waiters.splice(0).forEach(f => f()); };
      return { push(pcm, rate, pause) { if (stopped) return; log.played++; log.pushes.push({ n: pcm.length, rate, pause }); log.events.push('play:' + pcm.length); pending++; setTimeout(() => { pending--; settle(); }, playMs); },
        idle: () => new Promise(r => { waiters.push(r); settle(); }), stop() { if (!stopped) log.stopped++; stopped = true; settle(); } };
    } };
  return { t: tts.createRaviTts(deps), log, timers, release: text => { const i = held.findIndex(h => h.text === text); if (i >= 0) held.splice(i, 1)[0].send(); } };
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
    const slow = timers.filter(x => x.ms === tts.FIRST_SOUND_LIMIT_MS).pop(); assert.ok(slow, '첫 조각에 2.5초 마감이 걸려 있다'); slow.f();
    assert.equal(await p, 'fallback');
  }
  assert.equal(t.state, 'unavailable'); assert.ok(log.cancels.length >= 2, '워커에게 취소를 알린다');
});
test('취소: 말하는 도중 새 요청이 오면 이전 것은 cancelled', async () => {
  const { t, log } = rig(); const first = t.speak('첫 문장'); await new Promise(r => setTimeout(r, 0));
  const second = t.speak('둘째 문장');
  assert.equal(await first, 'cancelled'); assert.equal(await second, 'played');
});
// ── 문장 조각 줄(스트리밍) ──
const reply = '안녕하세요! 저는 라비예요. RVN을 보내려면 아래의 보내기 단추를 누르고, 받는 사람 주소와 금액을 넣어 주세요. 보내기 전에 주소를 한 번 더 확인하면 안전해요.';
const tick = async (n = 20) => { for (let i = 0; i < n; i++) await new Promise(r => setTimeout(r, 0)); };
test('조각(폰과 같은 규칙): 첫 조각 짧게 · 문장/쉼표 · 숫자·약어·이모지·영어', () => {
  assert.deepEqual(Array.from(core.voiceChunks(reply)), ['안녕하세요!', '저는 라비예요.', 'RVN을 보내려면 아래의 보내기 단추를 누르고,', '받는 사람 주소와 금액을 넣어 주세요.', '보내기 전에 주소를 한 번 더 확인하면 안전해요.']);
  assert.deepEqual(Array.from(core.voiceChunks('수수료는 0.5 RVN이에요. 1. 지갑을 열어요. e.g. 이런 식. Then click send. 😊')), ['수수료는 0.5 RVN이에요.', '1. 지갑을 열어요.', 'e.g. 이런 식.', 'Then click send. 😊']);
  assert.deepEqual(Array.from(core.voiceChunks('복구 단어는 이 지갑을 어느 기기에서든 되살리는 열쇠예요.')), ['복구 단어는,', '이 지갑을 어느 기기에서든 되살리는 열쇠예요.']);
  assert.deepEqual(Array.from(core.voiceChunks('...')), []);
  const phone = '/Users/gimmusong/wt-rv-buy-phone/phone/ui/ravi/ravi-voice-core.ts';
  try { const src = readFileSync(phone, 'utf8'), mine = readFileSync('src/ravi-tts-core.ts', 'utf8'); const grab = t => t.slice(t.indexOf('const SENTENCE_END'), t.indexOf('export const chunkPauseSec')); assert.equal(grab(mine), grab(src), '폰 voiceChunks 와 같은 코드'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
});
test('조각 줄: 첫 조각이 오면 바로 틀고, 트는 동안 다음 조각을 만들고, 차례대로 · 한 번에 하나만 시킨다', async () => {
  const { t, log, release } = rig({ workerMode: 'manual', playMs: 1 }); await t.warm(); let started = 0;
  const parts = Array.from(core.voiceChunks(reply));
  const p = t.speak(reply, { started: () => started++ }); await tick();
  assert.deepEqual(log.speaks, [parts[0]]); release(parts[0]); await tick();
  assert.equal(log.played, 1, '첫 조각 즉시 재생'); assert.equal(started, 1); assert.deepEqual(log.speaks, parts.slice(0, 2), '첫 조각을 트는 동안 둘째 조각 합성');
  assert.ok(log.events.indexOf('synth:' + parts[1]) < log.events.indexOf('play:' + (1000 + parts[0].length)));
  for (const x of parts.slice(1)) { release(x); await tick(); }
  assert.equal(await p, 'played'); assert.deepEqual(log.pushes.map(x => x.n), parts.map(x => 1000 + x.length)); assert.deepEqual(log.pushes.map(x => x.pause), [0, 0.3, 0.3, 0.12, 0.3]);
});
test('조각 줄: 도중에 멈추면 바로 끊고 남은 합성 취소, 더 안 튼다', async () => {
  const { t, log, release } = rig({ workerMode: 'manual', playMs: 50 }); await t.warm(); const parts = Array.from(core.voiceChunks(reply));
  const p = t.speak(reply); await tick(); release(parts[0]); await tick(); assert.equal(log.played, 1);
  t.cancel(); assert.equal(log.stopped, 1); assert.ok(log.cancels.length >= 1); release(parts[1]); await tick();
  assert.equal(await p, 'cancelled'); assert.equal(log.played, 1);
});
test('조각 줄: 첫 조각이 늦으면 fallback(소리 0) · 중간 조각 실패면 { rest } = 남은 글만(두 번 말하지 않는다)', async () => {
  { const { t, log, timers } = rig({ workerMode: 'manual' }); await t.warm(); const p = t.speak(reply); await tick();
    timers.filter(x => x.ms === tts.FIRST_SOUND_LIMIT_MS).pop().f(); assert.equal(await p, 'fallback'); assert.equal(log.played, 0); }
  { const parts = Array.from(core.voiceChunks(reply)); const { t, log } = rig({ failText: parts[2], playMs: 1 });
    const r = await t.speak(reply); assert.deepEqual({ ...r }, { rest: parts.slice(2).join(' ') }); assert.equal(log.played, 2); }
});
test('어댑터: { rest } 면 기기 목소리는 남은 글만 읽는다', async () => {
  const said = []; const synthesis = { getVoices: () => [{ lang: 'ko-KR', name: 'Yuna' }], cancel() {}, speak(u) { said.push(u.text); } };
  const v = voiceMod.createRaviVoice({ synthesis, utterance: class { constructor(x) { this.text = x; } }, allowed: () => true, transcript() {}, listening() {}, boundary() {}, ended() {}, unavailable() {},
    ravi: { speak: async (_t, h) => { h.started?.(); return { rest: '남은 글이에요.' }; }, cancel() {}, warm: async () => true }, preferRavi: () => true, aiVoice() {}, aiTag() {} });
  v.setEnabled(true); v.speak('앞 글이에요. 남은 글이에요.'); await new Promise(r => setTimeout(r, 5)); assert.deepEqual(said, ['남은 글이에요.']);
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
