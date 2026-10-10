// 라비 감정 엔진 단위 시험 — 규칙표 전 이벤트, 우선순위·합치기·쿨다운·만료, 경고에서 들뜸 금지,
// 금액 가림 누수 없음, 깜빡임 상한, 문구 번역·어두운 패턴 금지. 네트워크·지갑 없음(합성 이벤트만).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { build } from 'esbuild';

const root = resolve(import.meta.dirname, '..');
const entry = `export * from ${JSON.stringify(resolve(root, 'src/ravi-emotion.ts'))}; export { RAVI_EMOTION_COPY, emotionText } from ${JSON.stringify(resolve(root, 'src/ravi-emotion-copy.ts'))};`;
const out = await build({ stdin: { contents: entry, resolveDir: root, loader: 'ts' }, bundle: true, write: false, platform: 'node', format: 'esm', logLevel: 'silent' });
const M = await import('data:text/javascript;base64,' + Buffer.from(out.outputFiles[0].text).toString('base64'));
const { RULES, RAVI_EVENT_NAMES, RAVI_EMOTIONS, EMOTION_LABEL, SERIOUS_OK, UPBEAT, MOTION_SPEC, RAVI_EMOTION_COPY, createRaviEmotionEngine, expressionFor, miniKindToRaviEvent, trayHint, emotionText, BASE_MOOD } = M;

function clock(start = 1_000_000) {
  let t = start; const timers = [];
  return {
    now: () => t,
    setTimer: (fn, ms) => { const id = { at: t + ms, fn }; timers.push(id); return id; },
    clearTimer: id => { const i = timers.indexOf(id); if (i >= 0) timers.splice(i, 1); },
    advance(ms) { const end = t + ms; for (;;) { timers.sort((a, b) => a.at - b.at); const next = timers[0]; if (!next || next.at > end) break; timers.shift(); t = next.at; next.fn(); } t = end; },
  };
}
const engine = (extra = {}) => { const c = clock(); return { c, e: createRaviEmotionEngine({ now: c.now, setTimer: c.setTimer, clearTimer: c.clearTimer, soundOn: () => true, ...extra }) }; };
const allCopy = () => { const s = new Set(); for (const r of Object.values(RULES)) { for (const k of [r.copy, r.copyMany, r.masked?.copy]) if (k) s.add(k); } return [...s]; };

test('규칙표: 모든 이벤트가 알려진 감정·얼굴로 간다', () => {
  assert.ok(RAVI_EVENT_NAMES.length >= 35, `이벤트 ${RAVI_EVENT_NAMES.length}개`);
  for (const name of RAVI_EVENT_NAMES) {
    const { e } = engine();
    const d = e.emit(name);
    assert.ok(d, name);
    assert.ok(RAVI_EMOTIONS.includes(d.emotion), `${name} → ${d.emotion}`);
    assert.ok(BASE_MOOD[d.emotion], `${name} 기본 얼굴`);
  }
  const reachable = new Set(Object.values(RULES).map(r => r.emotion)); reachable.add('asleep');
  assert.ok(reachable.size >= 14, `표현되는 감정 ${reachable.size}종`);
});

test('문구: 모든 말풍선·낭독 문구가 en/ja/zh 에 있고 원문과 다르다', () => {
  for (const k of [...allCopy(), ...Object.values(EMOTION_LABEL).filter(x => x !== '라비')]) {
    const row = RAVI_EMOTION_COPY[k];
    assert.ok(row, `번역 없음: ${k}`);
    row.forEach((v, i) => { assert.ok(v && v !== k, `${['en', 'ja', 'zh'][i]}: ${k}`); if (k.includes('{0}')) assert.ok(v.includes('{0}'), `자리표시 빠짐 ${k}`); });
  }
  assert.equal(emotionText('입금 {0}건이 확인됐어요.', 'ko', 3), '입금 3건이 확인됐어요.');
  assert.equal(emotionText('입금이 확인됐어요.', 'de-DE'), 'The deposit is confirmed.', '사전에 없는 언어는 영어');
  assert.equal(emotionText('입금이 확인됐어요.', 'ja'), '入金が確認されました。');
});

test('우선순위: 경고 > 오류 > 돈 > 사람 > 일상, 한 번에 하나', () => {
  const { c, e } = engine();
  e.emit('node_syncing'); assert.equal(e.current().emotion, 'focused');
  e.emit('follower_new'); assert.equal(e.current().emotion, 'fond');
  e.emit('deposit_confirmed'); assert.equal(e.current().emotion, 'happy');
  e.emit('error_generic'); assert.equal(e.current().emotion, 'apologetic');
  e.emit('node_down'); assert.equal(e.current().emotion, 'worried');
  const d = e.emit('deposit_confirmed');
  assert.equal(d.emotion, 'worried', '경고 중엔 입금 기쁨이 얼굴을 덮지 않는다');
  e.emit('node_recovered');
  assert.equal(e.current().emotion, 'apologetic', '노드가 돌아오면 다음으로 급한 것');
  c.advance(9000);
  assert.equal(e.current().emotion, 'neutral', '다 끝나면 쉼');
  assert.equal(e.active().length, 0);
});

test('합치기: 20초 안 입금 3건 = 한 번의 기쁨, 건수 문구, 말풍선·소리 1회', () => {
  const { c, e } = engine();
  const a = e.emit('deposit_confirmed'); assert.equal(a.fresh, true); assert.ok(a.bubble); assert.equal(a.sound, 'ravi.soft');
  c.advance(2000); const b = e.emit('deposit_confirmed');
  c.advance(2000); const d = e.emit('deposit_confirmed');
  assert.equal(b.fresh, false); assert.equal(d.fresh, false); assert.equal(d.bubble, null); assert.equal(d.sound, null);
  assert.equal(d.copy, '입금 {0}건이 확인됐어요.');
  assert.equal(e.active()[0].count, 3);
});

test('쿨다운: 기념일은 하루 한 번만 크게, 두 번째는 조용히', () => {
  const { c, e } = engine();
  assert.equal(e.emit('first_sale').fresh, true);
  c.advance(60_000);
  const again = e.emit('first_sale');
  assert.equal(again.fresh, false); assert.equal(again.bubble, null); assert.equal(again.sound, null);
});

test('만료: 머무는 감정은 풀어 주는 이벤트까지, 잠깐 감정은 시간이 지나면 끝', () => {
  const { c, e } = engine({ rest: () => 'asleep' });
  e.emit('ai_thinking'); c.advance(600_000); assert.equal(e.current().emotion, 'thinking');
  e.emit('ai_done'); assert.equal(e.current().emotion, 'asleep');
  e.emit('key_connected'); assert.equal(e.current().emotion, 'happy'); c.advance(4001); assert.equal(e.current().emotion, 'asleep');
  e.emit('send_review'); c.advance(60_001); assert.equal(e.current().emotion, 'asleep', '송금 검토의 진지함도 끝이 있다');
  e.emit('send_review'); e.emit('send_closed'); assert.equal(e.current().emotion, 'asleep');
});

test('🔴 불변식: 돈·보안 경고에서 들뜨지 않는다', () => {
  const banned = /[!！]|헤헤|~|축하|ㅎㅎ/;
  for (const [name, r] of Object.entries(RULES)) {
    if (!r.serious) continue;
    assert.ok(SERIOUS_OK.includes(r.emotion), `${name}: ${r.emotion}`);
    assert.ok(['none', 'settle'].includes(r.motion), `${name}: ${r.motion}`);
    assert.ok(r.sound === null || r.sound === 'ravi.attention', `${name}: ${r.sound}`);
    assert.ok(!banned.test(r.copy ?? ''), `${name}: ${r.copy}`);
    const en = RAVI_EMOTION_COPY[r.copy]?.[0] ?? '';
    assert.ok(!/!/.test(en), `${name} en: ${en}`);
  }
  for (const name of ['send_done', 'purchase_done', 'send_review', 'risk_warning', 'deposit_dropped', 'node_down'])
    assert.ok(!UPBEAT.includes(RULES[name].emotion), `${name} 은 들뜬 감정 금지`);
  for (const name of ['send_review', 'risk_warning', 'send_invalid', 'deposit_dropped', 'node_down', 'node_disconnected', 'node_stalled', 'awake_lost', 'confirm_delayed'])
    assert.equal(RULES[name].serious, true, name);
  // 화면에서도: serious 는 어떤 크기에서도 움직이지 않는다.
  for (const size of ['large', 'medium', 'mini-l', 'mini-m', 'mini-s', 'chip', 'tray'])
    assert.equal(expressionFor({ emotion: 'calm', tone: 'calm', motion: 'bounce', serious: true }, size).motion, 'none');
});

test('🔴 불변식: 돈이 나가는 일은 축하·부추김이 없다', () => {
  for (const name of ['send_done', 'purchase_done']) {
    assert.equal(RULES[name].emotion, 'relieved'); assert.equal(RULES[name].sound, null);
  }
});

test('🔴 금액 가림 켬: 기념일·건수 단서가 새지 않는다', () => {
  for (const name of RAVI_EVENT_NAMES) {
    const { c, e } = engine({ masked: () => true });
    let d = e.emit(name); c.advance(1000); d = e.emit(name) ?? d; c.advance(1000); d = e.emit(name) ?? d;
    assert.notEqual(d.emotion, 'celebrate', name);
    assert.deepEqual(d.bubbleArgs, [], name);
    assert.ok(!(d.copy ?? '').includes('{0}'), `${name}: ${d.copy}`);
    assert.ok(!/첫|번째|고개/.test(d.copy ?? ''), `${name}: ${d.copy}`);
  }
  // 이벤트는 값을 받지 않는다 — 금액이 섞일 길이 없음. 규칙 문구에도 숫자·크기 말이 없다.
  for (const k of allCopy().map(x => x.replace(/\{\d\}/g, ''))) assert.ok(!/\d|큰 (입금|금액)|많은 돈|큰돈/.test(k), k);
  const { e } = engine({ masked: () => true });
  assert.equal(e.emit('deposit_confirmed', { amount: 99999 }).copy, '입금이 확인됐어요.', '두 번째 인자는 무시');
});

test('어두운 패턴·압박 문구 금지(ko·en)', () => {
  const ko = /지금 (사|구매|보내)|놓치|서두르|외로웠|보고 싶었|왜 안|마지막 기회|한정/;
  const en = /buy now|hurry|don't miss|don’t miss|last chance|missed you|lonely|why didn/i;
  for (const k of allCopy()) { assert.ok(!ko.test(k), k); assert.ok(!en.test(RAVI_EMOTION_COPY[k][0]), RAVI_EMOTION_COPY[k][0]); }
});

test('말풍선·소리 빈도: 일상은 6초 간격, 경고는 바로. 소리 끔·방해 금지 존중', () => {
  const { c, e } = engine();
  assert.ok(e.emit('order_received').bubble);
  c.advance(1000);
  const second = e.emit('error_generic');
  assert.equal(second.emotion, 'apologetic'); assert.equal(second.fresh, true);
  assert.equal(second.bubble, null, '6초 안 두 번째 말풍선 없음(얼굴은 바뀐다)');
  // 경고는 간격과 상관없이 바로 뜬다
  assert.ok(e.emit('node_down').bubble);
  const quiet = engine({ soundOn: () => false }).e; assert.equal(quiet.emit('deposit_confirmed').sound, null);
  const dnd = engine({ dnd: () => true }).e; assert.equal(dnd.emit('deposit_confirmed').sound, null); assert.equal(dnd.emit('node_down').sound, 'ravi.attention');
});

test('깜빡임: 초당 3회 이하, 무한 반복 움직임 없음', () => {
  for (const [m, s] of Object.entries(MOTION_SPEC)) {
    if (!s.durationMs) continue;
    assert.ok(s.flashes / (s.durationMs / 1000) <= 3, m);
    assert.ok(s.durationMs <= 1000, `${m} 1초 넘는 움직임`);
  }
  const css = readFileSync(resolve(root, 'src/ravi-emotion.css'), 'utf8');
  assert.ok(!/infinite/.test(css), '감정 CSS 에 무한 반복 없음');
  assert.ok(/prefers-reduced-motion/.test(css));
});

test('크기별 표현·미니 창·트레이 호환', () => {
  const d = { emotion: 'celebrate', tone: 'warm', motion: 'sparkle', serious: false };
  assert.equal(expressionFor(d, 'large').motion, 'sparkle');
  assert.equal(expressionFor(d, 'large', true).motion, 'none', '동작 줄이기');
  assert.equal(expressionFor(d, 'mini-s').bubble, 'none');
  assert.equal(expressionFor(d, 'chip').face, 'base');
  assert.equal(expressionFor(d, 'tray').face, 'none');
  for (const k of ['deposit_seen', 'deposit_confirmed', 'deposit_dropped', 'order', 'node_down', 'node_disconnected', 'node_stalled', 'node_recovered', 'awake_lost'])
    assert.ok(RULES[miniKindToRaviEvent(k)], k);
  assert.equal(miniKindToRaviEvent('__proto__'), null);
  assert.equal(trayHint({ tone: 'alert', emotion: 'worried' }).variant, 'alert');
  assert.equal(trayHint({ tone: 'rest', emotion: 'asleep' }).variant, 'sleep');
});

test('모르는 이벤트는 무시, 구독자 오류가 엔진을 멈추지 않는다', () => {
  const { e } = engine();
  assert.equal(e.emit('rm -rf'), null);
  e.subscribe(() => { throw new Error('x'); });
  assert.equal(e.emit('deposit_confirmed').emotion, 'happy');
});
