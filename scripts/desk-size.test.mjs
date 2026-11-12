// 11-12 한눈에 많이 · 첫 실행 글씨 질문 · 왼쪽 줄 한 줄 표시 — 순수 함수와 배선을 DOM 없이 본다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
const root = resolve(import.meta.dirname, '..');
const read = (p) => readFileSync(resolve(root, p), 'utf8');
const load = (p, ctx = {}) => {
  const js = ts.transpileModule(read(p).replace(/^import .*;\n/gm, ''), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const mod = { exports: {} }; vm.runInNewContext(js, { module: mod, exports: mod.exports, ...ctx }); return mod.exports;
};
const plain = (x) => JSON.parse(JSON.stringify(x));

test('왼쪽 줄: 짧은 이름 한 줄 · 따라잡는 동안만 숫자 · 자세한 말은 따로', () => {
  const r = load('src/rail-status.ts');
  const ok = plain(r.nodeLine({ kind: 'ok' }));
  assert.equal(ok.label, '노드'); assert.equal(ok.tone, 'ok'); assert.equal(ok.pct, undefined);
  assert.match(ok.why, /장부 다 받음 · 결제 확인 바로 됨/);
  const sync = plain(r.nodeLine({ kind: 'sync', pct: 87.46 }));
  assert.deepEqual([sync.label, sync.pct, sync.tone], ['노드 {0}%', '87', 'warn']);
  assert.equal(r.nodeLine({ kind: 'sync', pct: 99.97 }).pct, '99', '다 되기 전에는 100% 라고 적지 않는다');
  assert.equal(r.nodeLine({ kind: 'warm' }).tone, 'warn');
  assert.deepEqual([r.nodeLine({ kind: 'down' }).label, r.nodeLine({ kind: 'down' }).tone], ['노드 꺼짐', 'bad']);
  for (const [k, label] of [['mine', '채굴'], ['ipfs', 'IPFS'], ['relay', '릴레이'], ['out', '바깥 연결'], ['map', '지도']]) {
    const on = plain(r.simpleLine(k, true)), off = plain(r.simpleLine(k, false));
    assert.equal(on.label, label); assert.equal(off.label, label, '켜짐·꺼짐은 점 색이 말한다 — 이름은 같다');
    assert.deepEqual([on.tone, off.tone], ['ok', 'quiet']);
    assert.notEqual(on.detail, off.detail);
  }
  // 모든 짧은 이름은 한 줄(92px 레일, 13px)에 들어가는 길이.
  for (const line of [ok, sync, plain(r.nodeLine({ kind: 'down' })), ...['mine', 'ipfs', 'relay', 'out', 'map'].map((k) => plain(r.simpleLine(k, true)))]) assert.ok(line.label.replace('{0}', '99').length <= 6, line.label);
});

test('왼쪽 줄 CSS: 줄바꿈 없음 · 동기화 막대는 hidden 이면 정말 숨는다', () => {
  const css = read('src/rail-status.css');
  assert.match(css, /white-space:nowrap/);
  assert.match(css, /\.syncbar\[hidden\] \{ display:none !important; \}/, '.navfoot div { display:flex } 가 hidden 을 이기던 흰 막대');
  assert.match(read('src/main.ts'), /setSyncBar\(synced \? null : pct\)/);
});

test('글씨 질문은 한 번만 · 고른 사람·인사 끈 사람은 안 묻는다', () => {
  const a = load('src/text-size-ask.ts');
  const store = (init = {}) => { const m = new Map(Object.entries(init)); return { m, getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, v) }; };
  assert.equal(a.shouldAskTextSize(store(), false), true);
  assert.equal(a.shouldAskTextSize(store({ 'ravenvault-text-size-asked': '1' }), false), false);
  const chosen = store(); assert.equal(a.shouldAskTextSize(chosen, true), false); assert.equal(chosen.m.get('ravenvault-text-size-asked'), '1', '이미 고른 사람은 기억해 두고 다시 안 본다');
  assert.equal(a.shouldAskTextSize(store({ 'rv-ravi-start-off': '1' }), false), false);
  const src = read('src/text-size-ask.ts');
  assert.match(src, /store\.setItem\(TEXT_ASK_KEY, "1"\);[^\n]*\n\s*showRaviCard/, '띄우는 순간 기억 — 건너뛰어도 다시 안 묻는다');
  assert.match(src, /label: "나중에"/);
  assert.match(read('src/main.ts'), /afterRaviLanding\(\(\) => askTextSizeOnce\(t\)\)/, '라비가 내려앉은 뒤에만');
});

test('한눈에 많이: 저장 값은 small 그대로 · 보통·크게는 속성 없음', () => {
  const html = { dataset: {} };
  const m = load('src/text-size.ts', { document: { documentElement: html }, localStorage: { getItem: () => 'small' } });
  assert.equal(m.TEXT_SIZE_NAME.small, '한눈에 많이');
  assert.equal(m.textSize(), 'small', '예전에 「작게」를 고른 사람은 한눈에 많이');
  m.applyDensity('small'); assert.equal(html.dataset.density, 'compact');
  m.applyDensity('normal'); assert.equal('density' in html.dataset, false);
  m.applyDensity('large'); assert.equal('density' in html.dataset, false);
  const css = read('src/text-size.css');
  for (const rule of css.replace(/\/\*[\s\S]*?\*\//g, '').split('}').filter((r) => r.trim() && !/rv-ravi-card/.test(r))) assert.match(rule, /html\[data-density="compact"\]/, '촘촘 규칙은 모두 compact 아래에만');
  assert.match(css, /main :is\(button, summary\),\s*\nhtml\[data-density="compact"\] \.todochip \{ min-height:40px !important; \}/);
  for (const px of [...css.matchAll(/min-height:(\d+)px/g)].map((x) => +x[1])) assert.ok(px >= 36, `누르는 자리 ${px}px < 36px`);
  assert.match(read('index.html'), /data-text-size="small">한눈에 많이</);
});

test('새 말은 en/ja/zh 사전에 있다', () => {
  const copy = read('src/desktop-copy.ts');
  for (const k of ['한눈에 많이', '글씨 잘 보이세요?', '눌러 보시면 바로 바뀌어요. 나중에 「언어 · 화면」이나 라비에게 「글자 크게」라고 해도 돼요.', '가나다 12.5', '이미 「한눈에 많이」로 보고 있어요.', '「한눈에 많이」로 바꿨어요. 글자·단추가 조금 작아지고 한 화면에 더 많이 보여요.', '지도', 'RVN 노드 따라잡는 중', '장부 다 받음 · 결제 확인 바로 됨']) {
    const line = copy.split('\n').find((l) => l.startsWith(`  ${JSON.stringify(k)}: [`));
    assert.ok(line, k);
    assert.equal(JSON.parse(line.slice(line.indexOf('['), line.lastIndexOf(']') + 1)).filter((v) => v.trim()).length, 3, k);
  }
});
