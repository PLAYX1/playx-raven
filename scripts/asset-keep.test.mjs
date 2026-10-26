// 자산 파일 보관(0.8.8a) — 순수 판단 함수 단위 시험. Rust 쪽(내 뜻 저장·자동 보관 건너뛰기·앱 안 확인 분류)은
// src-tauri/src/asset_keep.rs · peers.rs · asset_verify.rs 의 #[cfg(test)] (cargo test — 이 환경에서는 실행하지 않음).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { build } from 'esbuild';

const root = resolve(import.meta.dirname, '..');
const built = await build({ stdin: { contents: "export * from './src/asset-keep-core.ts';", resolveDir: root, loader: 'ts' },
  bundle: true, write: false, platform: 'node', format: 'cjs', logLevel: 'silent' });
const mod = { exports: {} };
new Function('require', 'exports', 'module', built.outputFiles[0].text)(createRequire(import.meta.url), mod.exports, mod);
const C = mod.exports;
const CID = 'QmcwUFCZ8saJgoE6D9LEgVqtteCbVcdzWFcGzuhe7VTeW7';

test('줄 상태: 파일 있는 모든 줄에 탭 동작이 있다(보관 중 제외), 파일 없음·원본 지문만 단추 없음', () => {
  const base = { cid: CID, fingerprint: false, pinned: false, health: 'unknown' };
  assert.equal(C.rowState({ ...base, cid: null }).kind, 'nofile');
  assert.equal(C.rowState({ ...base, fingerprint: true }).kind, 'fingerprint');
  assert.equal(C.rowState({ ...base, pinned: true }).label, '보관 중');
  const found = C.rowState({ ...base, health: 'found' });
  assert.deepEqual([found.kind, found.label, found.tap], ['off', '보관 안 함', 'keep']);
  const unk = C.rowState(base);
  assert.deepEqual([unk.kind, unk.label, unk.tap], ['unknown', '확인 안 됨', 'find-keep']);
  assert.equal(C.rowState({ ...base, health: 'checking' }).label, '확인 중…');
  const miss = C.rowState({ ...base, health: 'missing' });
  assert.deepEqual([miss.kind, miss.label, miss.tap, miss.reserved], ['missing', '찾지 못함', 'retry-keep', false]);
  // 이전 「미확인」「찾지 못함」 줄에는 단추가 구조적으로 없었다 — 이제 모두 탭 동작이 있다.
  for (const health of ['unknown', 'checking', 'found', 'missing']) assert.notEqual(C.rowState({ ...base, health }).tap, 'none', health);
});

test('줄 상태: 내가 일부러 뺀 것은 자물쇠(declined), 못 찾았지만 보관하기를 눌렀으면 예약됨', () => {
  const base = { cid: CID, fingerprint: false, pinned: false, health: 'missing' };
  const skipped = C.rowState({ ...base, decision: 'skip' });
  assert.deepEqual([skipped.kind, skipped.declined, skipped.tap], ['off', true, 'keep']);
  const reserved = C.rowState({ ...base, decision: 'keep' });
  assert.deepEqual([reserved.kind, reserved.reserved, reserved.label], ['missing', true, '찾지 못함 · 예약됨']);
  // 붙잡고 있으면 결정이 무엇이든 보관 중(화면은 실제 상태를 말한다)
  assert.equal(C.rowState({ ...base, pinned: true, decision: 'skip' }).kind, 'kept');
});

function fakeClock() {
  let t = 0, seq = 0; const timers = new Map();
  return {
    now: () => t, setTimer: (fn, ms) => { const id = ++seq; timers.set(id, { at: t + ms, fn }); return id; }, clearTimer: (id) => timers.delete(id),
    advance(ms) { t += ms; for (const [id, x] of [...timers]) if (x.at <= t) { timers.delete(id); x.fn(); } },
    pending: () => timers.size,
  };
}

test('길게 누르기: 0.6초 전에 떼면 아무 일 없고, 0.6초를 채우면 한 번만 해제 요청', () => {
  const clock = fakeClock(); const done = []; let changes = 0;
  const hold = C.createHold(clock, (cid) => done.push(cid), () => changes++);
  assert.equal(C.HOLD_MS, 600);
  assert.equal(hold.start(CID), true);
  assert.equal(hold.start('other'), false, '동시에 두 개를 누르지 않는다');
  clock.advance(599);
  assert.deepEqual(hold.pressing(), { cid: CID, elapsed: 599 });
  assert.equal(hold.cancel(), true);
  clock.advance(5000);
  assert.deepEqual(done, [], '떼면 해제되지 않는다');
  assert.equal(clock.pending(), 0);
  hold.start(CID);
  clock.advance(600);
  assert.deepEqual(done, [CID]);
  assert.equal(hold.pressing(), null);
  assert.equal(hold.cancel(), false);
  clock.advance(10_000);
  assert.deepEqual(done, [CID], '한 번만');
  assert.ok(changes >= 4);
});

test('용량: 80% 주황 · 95% 빨강 · 값을 못 읽으면 0% 로 그리지 않는다 · 꺼짐은 따로', () => {
  assert.deepEqual(C.capacityView(3.2e9, 15e9, true), { level: 'ok', pct: 21 });
  assert.equal(C.capacityView(12e9, 15e9, true).level, 'warn');
  assert.equal(C.capacityView(14.3e9, 15e9, true).level, 'full');
  assert.equal(C.capacityView(null, 15e9, true).level, 'unknown');
  assert.equal(C.capacityView(1, 0, true).level, 'unknown');
  assert.equal(C.capacityView(null, null, false).level, 'off');
  assert.equal(C.capacityView(20e9, 15e9, true).pct, 100);
  assert.equal(C.fmtBytes(3.2e9), '3.2GB');
  assert.equal(C.fmtBytes(15e9), '15GB');
  assert.equal(C.fmtBytes(0), '0B');
});

const R = (o) => ({ name: 'N', cid: CID, mine: false, fingerprint: false, pinned: false, health: 'unknown', ...o });

test('일괄 보관: 내가 만든 것부터 · 받은 것은 체크해야 포함 · 보관 안 하기·이미 보관·원본 지문 제외 · 같은 주소 한 번', () => {
  const c = (n) => `Qm${String(n).padStart(44, '0')}`;
  const rows = [
    R({ name: 'got1', cid: c(1) }), R({ name: 'mine1', cid: c(2), mine: true }), R({ name: 'skip', cid: c(3), mine: true, decision: 'skip' }),
    R({ name: 'pinned', cid: c(4), mine: true, pinned: true }), R({ name: 'fp', cid: c(5), mine: true, fingerprint: true }),
    R({ name: 'dup', cid: c(2), mine: true }), R({ name: 'nofile', cid: null, mine: true }), R({ name: 'mine2', cid: c(6), mine: true, health: 'missing' }),
  ];
  assert.deepEqual(C.bulkTargets(rows, false).map((r) => r.name), ['mine1', 'mine2']);
  assert.deepEqual(C.bulkTargets(rows, true).map((r) => r.name), ['mine1', 'mine2', 'got1']);
});

test('처음 보는 받은 파일: 결정 없음 · 안 붙잡음 · 내 것 아님 · 주소 중복 제거', () => {
  const rows = [R({ name: 'a', cid: 'QmA' + '0'.repeat(43) }), R({ name: 'b', cid: 'QmA' + '0'.repeat(43) }), R({ name: 'mine', mine: true }),
    R({ name: 'asked', decision: 'skip' }), R({ name: 'pinned', pinned: true }), R({ name: 'fp', fingerprint: true })];
  assert.deepEqual(C.undecidedReceived(rows).map((r) => r.name), ['a']);
  assert.deepEqual(C.counts([R({ pinned: true }), R({}), R({ fingerprint: true }), R({ cid: null })]), { total: 4, files: 2, kept: 1, prints: 1 });
});

test('다시 확인: 찾았으면 안 묻고, 6시간 안에 못 찾은 것도 안 묻는다', () => {
  const now = 10 * 3600_000;
  assert.equal(C.shouldRecheck('found', undefined, now), false);
  assert.equal(C.shouldRecheck('missing', now - 3600_000, now), false);
  assert.equal(C.shouldRecheck('missing', now - 7 * 3600_000, now), true);
  assert.equal(C.shouldRecheck('missing', undefined, now), true, '시각을 모르면 묻는다');
  assert.equal(C.shouldRecheck('unknown', undefined, now), true);
  assert.deepEqual(C.agoMsg(5), { k: '방금' });
  assert.deepEqual(C.agoMsg(7200), { k: '{0}시간 전', a: [2] });
});

test('이유 안내: 「파일이 없어졌다는 뜻이 아닙니다」 · 내가 만든 것 · IPFS 꺼짐 · 연결 0곳 · 예약', () => {
  const ctx = { kind: 'missing', reserved: false, mine: false, ipfsRunning: true, peers: 5, checkedAtSec: 1000, nowSec: 1000 + 3 * 3600, stopped: false };
  const base = C.reasonFor(ctx);
  assert.ok(base.lines.some((l) => l.k.includes('파일이 없어졌다는 뜻이 아닙니다')));
  assert.deepEqual(base.lines.at(-1), { k: '마지막 확인: {0}', a: [{ k: '{0}시간 전', a: [3] }] });
  assert.deepEqual(base.actions, ['retry']);
  assert.ok(C.reasonFor({ ...ctx, peers: 0 }).lines.some((l) => l.k.includes('연결되지 않았어요')));
  assert.ok(C.reasonFor({ ...ctx, mine: true }).lines.some((l) => l.k.includes('내가 올린 파일')));
  assert.ok(C.reasonFor({ ...ctx, reserved: true }).lines.some((l) => l.k.includes('예약') || l.k.includes('보관하기를 눌러')));
  const off = C.reasonFor({ ...ctx, ipfsRunning: false });
  assert.deepEqual(off.actions, ['settings']);
  const unk = C.reasonFor({ ...ctx, kind: 'unknown' });
  assert.deepEqual([unk.lines[0].k, unk.actions], ['아직 이 파일이 어디 있는지 물어보지 않았어요.', ['check']]);
  assert.deepEqual(C.reasonFor({ ...ctx, kind: 'unknown', stopped: true }).actions, ['resume']);
  assert.equal(C.reasonFor({ ...ctx, kind: 'kept' }), null);
});

test('앱 안 확인: 따라잡는 중·노드 꺼짐은 「없음」이라 하지 않고 「확인 못 함」', () => {
  const syncing = C.verifyLines({ status: 'unknown', reason: 'syncing' });
  assert.equal(syncing.headline.tone, 'unknown');
  assert.ok(syncing.headline.msg.k.includes('없다는 뜻이 아니에요'));
  assert.equal(syncing.web, true, '이때만 웹 확인 페이지를 안내');
  assert.ok(!syncing.headline.msg.k.includes('찾지 못했어요'), '따라잡는 중에 「찾지 못했어요」라 하지 않는다');
  assert.ok(C.verifyLines({ status: 'unknown', reason: 'node_down' }).headline.msg.k.includes('꺼져'));
  const nf = C.verifyLines({ status: 'not_found' });
  assert.equal(nf.headline.tone, 'bad');
  assert.ok(nf.headline.msg.k.includes('찾지 못했어요'));
});

test('앱 안 확인: 전부 맞아야 초록, 색인 꺼짐·파일 없음·동기화 중이면 초록이라 하지 않는다', () => {
  const ok = { status: 'found', unique: true, amount: 1, reissuable: false, has_ipfs: true, index: 'on', owner_count: 1, holders: 1, local: 'pinned', caught_up: true, height: 3500000, at: 1 };
  const good = C.verifyLines(ok);
  assert.equal(good.headline.tone, 'ok');
  assert.ok(good.lines.some((l) => l.msg.k === '이 컴퓨터가 가진 파일은 장부에 적힌 주소와 같아요.'));
  assert.ok(good.lines.some((l) => l.msg.k.includes('받는 사람·제목은 공개 장부에 없어요')), '장부에 없는 것을 말한다');
  assert.ok(good.lines.some((l) => l.msg.k.includes('현실에서 누구인지')));
  const off = C.verifyLines({ ...ok, index: 'off' });
  assert.ok(off.lines.some((l) => l.tone === 'unknown' && l.msg.k.includes('자산 색인')));
  const nofile = C.verifyLines({ ...ok, local: 'unknown' });
  assert.equal(nofile.headline.tone, 'warn');
  const lag = C.verifyLines({ ...ok, caught_up: false });
  assert.equal(lag.headline.tone, 'warn');
  assert.ok(lag.lines.some((l) => l.msg.k.includes('따라잡는 중')));
  assert.equal(C.verifyLines({ ...ok, reissuable: true }).lines.find((l) => l.msg.k.includes('더 찍거나')).tone, 'warn');
  assert.equal(C.verifyLines({ ...ok, has_ipfs: false, local: 'none' }).lines.some((l) => l.msg.k.includes('파일 주소가 새겨져 있지 않아요')), true);
});

test('끌어놓은 파일: 같음 두 가지는 초록, 다름은 노랑이고 위조라 단정하지 않는다', () => {
  assert.equal(C.fileMatchLine({ match_kind: 'fingerprint' }).tone, 'ok');
  assert.equal(C.fileMatchLine({ match_kind: 'ipfs' }).tone, 'ok');
  const none = C.fileMatchLine({ match_kind: 'none', ipfs_checked: true });
  assert.equal(none.tone, 'warn');
  assert.ok(none.msg.k.includes('위조라고 단정할 수는 없어요'));
  const big = C.fileMatchLine({ match_kind: 'none', ipfs_too_big: true });
  assert.ok(big.msg.k.includes('위조라고 단정할 수는 없어요') && big.msg.k.includes('커서'));
});

test('모든 새 문구 열쇠는 한국어 원문이고 번역 사전(desktop-copy · asset-keep-copy)에 있다', async () => {
  const bundle = async (entry) => {
    const src = (await build({ stdin: { contents: entry, resolveDir: root, loader: 'ts' }, bundle: true, write: false, platform: 'node', format: 'cjs', logLevel: 'silent' })).outputFiles[0].text;
    const m = { exports: {} }; new Function('require', 'exports', 'module', src)(createRequire(import.meta.url), m.exports, m);
    return m.exports;
  };
  const a = (await bundle("export { DESKTOP_COPY } from './src/desktop-copy.ts';")).DESKTOP_COPY;
  const b = (await bundle("export { ASSET_KEEP_COPY } from './src/asset-keep-copy.ts';")).ASSET_KEEP_COPY;
  const dict = { ...b, ...a };
  const fs = await import('node:fs');
  const code = fs.readFileSync(resolve(root, 'src/asset-keep-core.ts'), 'utf8');
  const keys = [...code.matchAll(/\bk:\s*"([^"]+)"/g)].map((x) => x[1]);
  assert.ok(keys.length > 30);
  for (const k of keys) assert.ok(dict[k], `사전에 없음: ${k}`);
  // 화면 코드의 t("…")·tf("…") 열쇠도 전부
  const ui = fs.readFileSync(resolve(root, 'src/asset-keep.ts'), 'utf8') + code;
  const used = [...ui.matchAll(/\bt[f]?\(\s*"([^"]*[가-힣][^"]*)"/g)].map((x) => x[1]);
  const { runtimeDict } = await import('./i18n/runtime-keys.mjs');
  const base = (await runtimeDict()).en;
  for (const k of used) assert.ok(dict[k] || base[k], `사전에 없음: ${k}`);
  // 새 문구 목록 파일과 사전이 같다(유럽어 칸은 비어 있다 = 영어 폴백)
  const list = JSON.parse(fs.readFileSync(resolve(root, 'docs/i18n-0.8.8a-newstrings.json'), 'utf8')).strings;
  assert.ok(list.length >= 100);
  for (const s of list) { assert.deepEqual(dict[s.ko], [s.en, s.ja, s.zh], s.ko); assert.deepEqual(Object.keys(s.euro), ['it', 'es', 'fr', 'pt-BR', 'de', 'ru']); }
});
