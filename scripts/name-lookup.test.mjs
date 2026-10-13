// 체인 이름 조회의 세 상태(있음·없음·확인 불가) — 화면 쪽. Rust 쪽은 src-tauri/src/issue.rs name_lookup_tests.
// 오류·불리언이 아닌 답은 전부 「확인 불가(null)」이고, 확인 불가면 발행 계획(planIssue)이 등록을 막는다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve, join } from 'node:path';
import { build } from 'esbuild';

const root = resolve(import.meta.dirname, '..');
const built = await build({ stdin: { contents: "export * from './src/name-lookup.ts'; export { planIssue } from './core/creator/publish.ts';", resolveDir: root, loader: 'ts' },
  bundle: true, write: false, platform: 'node', format: 'cjs', logLevel: 'silent' });
const mod = { exports: {} };
new Function('require', 'exports', 'module', built.outputFiles[0].text)(createRequire(import.meta.url), mod.exports, mod);
const { nameTakenFrom, askNameTaken, nameTakenSettled, strictBool, planIssue } = mod.exports;

test('정확한 true/false 만 믿고 나머지는 확인 불가', () => {
  assert.equal(nameTakenFrom(true), true);
  assert.equal(nameTakenFrom(false), false);
  for (const v of [undefined, null, 'false', 'true', 0, 1, '', {}, [], { taken: false }]) assert.equal(nameTakenFrom(v), null, JSON.stringify(v));
  assert.equal(strictBool, nameTakenFrom);
});

test('invoke 오류(노드 문구가 무엇이든)·이상한 답 → 확인 불가', async () => {
  for (const msg of ['getassetdata: Invalid asset name', 'Asset not found', 'not found', '확인 불가: …', '']) {
    assert.equal(await askNameTaken(async () => { throw new Error(msg); }, 'RV.M.FOREST'), null, msg);
  }
  assert.equal(await askNameTaken(async () => 'false', 'RV.M.FOREST'), null);
  assert.equal(await askNameTaken(async () => undefined, 'RV.M.FOREST'), null);
  assert.equal(await askNameTaken(async () => false, 'RV.M.FOREST'), false);
  assert.equal(await askNameTaken(async () => true, 'RV.M.FOREST'), true);
  assert.equal(nameTakenSettled({ status: 'rejected', reason: new Error('x') }), null);
  assert.equal(nameTakenSettled({ status: 'fulfilled', value: 'no' }), null);
  assert.equal(nameTakenSettled({ status: 'fulfilled', value: false }), false);
});

test('확인 불가면 발행 계획이 막힌다(planIssue nameTaken: null)', () => {
  // 2026-10-14 동기화 뒤: 옛 RV. 이름 새 발행은 core 가 늘 막고(legacyIssueGuard) 「내 상품 올리기」도 잠겨 있다 — 어떤 답이든 canIssue 는 false.
  //   여기서 지키는 것은 그대로: 「확인 불가(null)」는 그 자체로 막힘 한 줄을 더하고, 없음(false)은 그 줄을 더하지 않는다.
  const base = { asset: 'RV.M.FOREST', manifestCid: 'QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG', chain: null, ownedAssets: [], chainBurnRvn: null, typedName: 'RV.M.FOREST', type: 'music' };
  const free = planIssue({ ...base, nameTaken: false });
  assert.equal(free.canIssue, false);
  assert.ok(free.blockers.some(b => b.includes('옛 이름 규칙')), 'legacy guard');
  assert.ok(!free.blockers.some(b => b.includes('확인 불가')), 'a clear 「없음」 adds no unknown-duplicate blocker');
  const unknown = planIssue({ ...base, nameTaken: nameTakenFrom('weird') });
  assert.equal(unknown.canIssue, false);
  assert.ok(unknown.blockers.some(b => b.includes('확인 불가')));
  const taken = planIssue({ ...base, nameTaken: true });
  assert.equal(taken.canIssue, false);
  assert.ok(taken.blockers.some(b => b.includes('이미 있는 이름')));
});

test('화면 코드에 「오류를 삼켜 없음으로」 넘기는 옛 모양이 없다', () => {
  const main = readFileSync(join(root, 'src/main.ts'), 'utf8');
  const creator = readFileSync(join(root, 'src/creator-publish.ts'), 'utf8');
  assert.doesNotMatch(main, /invoke<boolean>\("name_taken"[^\n]*\} catch \{\}/, 'main.ts: name_taken 오류를 삼킨다');
  assert.doesNotMatch(main, /let free = true;\s*try \{\s*free = await invoke<boolean>\("shop_name_free"/, 'main.ts: shop_name_free 오류를 「비어 있음」으로');
  assert.match(main, /let taken: boolean \| null = null;/);
  assert.match(main, /let free: boolean \| null = null;/);
  assert.doesNotMatch(creator, /'name_taken'[^\n]*=== true/, 'creator-publish.ts: 불리언이 아닌 답을 없음으로 읽는다');
});
