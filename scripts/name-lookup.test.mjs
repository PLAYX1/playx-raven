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
  const base = { asset: 'RV.M.FOREST', manifestCid: 'QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG', chain: 'regtest', ownedAssets: [], chainBurnRvn: null, typedName: 'RV.M.FOREST', type: 'music' };
  assert.equal(planIssue({ ...base, nameTaken: false }).canIssue, true);
  const unknown = planIssue({ ...base, nameTaken: nameTakenFrom('weird') });
  assert.equal(unknown.canIssue, false);
  assert.ok(unknown.blockers.some(b => b.includes('확인 불가')));
  assert.equal(planIssue({ ...base, nameTaken: true }).canIssue, false);
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
