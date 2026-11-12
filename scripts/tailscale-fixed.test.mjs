// 11-12 테일스케일로 바뀌지 않는 가게 주소(tailscale-fixed.ts) — 라비가 알아듣는 말·임시 주소 경고·걸음 이어 가기.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
const root = resolve(import.meta.dirname, '..');
const js = ts.transpileModule(readFileSync(resolve(root, 'src/tailscale-fixed.ts'), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const mod = { exports: {} };
vm.runInNewContext(js, { module: mod, exports: mod.exports, setTimeout, Date });
const T = mod.exports;

test('「고정 주소 만들어 줘」를 알아듣는다', () => {
  // 11-13 일반 「고정 주소」는 무료 고정 링크를 먼저 권하고(on), 테일스케일을 콕 집으면 바로 그 흐름(tailscale).
  for (const q of ['고정 주소 만들어 줘', '가게 주소 안 바뀌게 해 줘', '링크가 안 바뀌게 해줘', '고정 링크 부탁해']) {
    assert.equal(T.raviFixedAddressIntent(q), 'on', q);
  }
  for (const q of ['테일스케일 연결해 줘', 'tailscale funnel 켜줘', '퍼널로 고정 주소 만들어 줘']) assert.equal(T.raviFixedAddressIntent(q), 'tailscale', q);
  for (const q of ['테일스케일 꺼 줘', '퍼널 닫아 줘']) assert.equal(T.raviFixedAddressIntent(q), 'off', q);
});

test('다른 말은 건드리지 않는다', () => {
  for (const q of ['잔액이 안 보여요', '지갑 주소가 안 바뀌어요', '받는 주소 고정해 줘', '가게 화면 보여줘', '지도에 올려 줘', '테일스케일이 뭐야', '글자 크게']) {
    assert.equal(T.raviFixedAddressIntent(q), null, q);
  }
});

test('퍼널 주소(…ts.net)면 임시 주소 경고를 안 띄운다', () => {
  assert.equal(T.isFixedTsUrl('https://shop-mac.tail1234.ts.net'), true);
  assert.equal(T.isFixedTsUrl('https://shop-mac.tail1234.ts.net/'), true);
  assert.equal(T.isTemporaryUrl('https://shop-mac.tail1234.ts.net'), false);
  assert.equal(T.isTemporaryUrl('https://abc-def.trycloudflare.com'), true);
  // 보통 테일스케일 주소는 고정 주소로 치지 않는다(손님에게 안 열린다).
  for (const u of ['http://100.101.102.103:8790', 'https://100.101.102.103', 'http://shop-mac.tail1234.ts.net', 'https://ts.net', 'https://evil.ts.net.example.com']) {
    assert.equal(T.isFixedTsUrl(u), false, u);
  }
  // map-card 의 경고 줄은 isTemporaryUrl 을 거친다 — 퍼널 주소에서 경고가 새지 않게.
  const card = readFileSync(resolve(root, 'src/map-card.ts'), 'utf8');
  const i = card.indexOf('const temporary = ');
  assert.ok(i > 0 && card.slice(i, i + 80).includes('isTemporaryUrl(url)'), '경고 판단에 isTemporaryUrl 을 쓴다');
  assert.ok(card.indexOf('if (temporary)') > i, '경고는 temporary 일 때만');
});

test('사람이 할 일이 나오면 창을 한 번만 열고, 되면 이어 간다', async () => {
  const seq = [{ state: 'not_installed' }, { state: 'not_installed' }, { state: 'needs_login' }, { state: 'needs_login' }, { state: 'starting' }, { state: 'needs_funnel' }, { state: 'ready', url: 'https://pc.tail1.ts.net', published: false }];
  const calls = [];
  const invoke = async (cmd, args) => { calls.push([cmd, args?.target]); return cmd === 'tailscale_fixed_setup' ? seq.shift() : undefined; };
  const steps = [];
  const end = await T.runFixedAddress(invoke, (r) => steps.push(r.state), { pollMs: 0, sleep: async () => {} });
  assert.equal(end.state, 'ready');
  assert.equal(end.url, 'https://pc.tail1.ts.net');
  assert.deepEqual(steps, ['not_installed', 'needs_login', 'starting', 'needs_funnel', 'ready']);
  const opened = calls.filter(([c]) => c === 'tailscale_open').map(([, t]) => t);
  assert.deepEqual(opened, ['download', 'login', 'approve'], '같은 걸음에서 창을 두 번 열지 않는다');
  assert.equal(T.fixedAddressRunning(), false);
});

test('오래 기다리면 멈추고, 두 번 누르면 하나만 돈다', async () => {
  const invoke = async (cmd) => (cmd === 'tailscale_fixed_setup' ? { state: 'needs_login' } : undefined);
  const first = T.runFixedAddress(invoke, () => {}, { pollMs: 0, maxMs: 50, autoOpen: false, sleep: () => new Promise((r) => setTimeout(r, 5)) });
  assert.equal(await T.runFixedAddress(invoke, () => {}, { sleep: async () => {} }), null);
  assert.equal(await first, 'timeout');
  // 오류는 failed 로 끝난다(멈추지 않고 돌지 않는다).
  const bad = await T.runFixedAddress(async () => { throw new Error('boom'); }, () => {}, { sleep: async () => {} });
  assert.equal(bad.state, 'failed');
});

test('걸음마다 할 말이 있고, 사람이 누를 곳은 정해 둔 이름만', () => {
  const allowed = new Set(['download', 'app', 'login', 'approve', 'machines', 'dns']);
  for (const [k, v] of Object.entries(T.TS_STEP)) {
    assert.ok(v.say && /[가-힣]/.test(v.say), k);
    if (v.open) assert.ok(allowed.has(v.open.target), k);
  }
  assert.match(T.TS_STEP.needs_login.say, /암호는 저에게 알려 주지 마세요/);
  const rs = readFileSync(resolve(root, 'src-tauri/src/tailscale.rs'), 'utf8');
  for (const t of allowed) if (t !== 'app') assert.ok(rs.includes(`"${t}"`), `tailscale_open 이 ${t} 를 안다`);
});
