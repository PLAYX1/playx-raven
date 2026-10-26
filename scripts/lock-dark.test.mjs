// 잠금·다크 돈 카드 — 화면 쪽 순수 규칙(4개 국어 문구·오류 말 바꾸기·CSS 규칙·복구 단어 자동 가림 시간).
// Rust 잠금(허용 목록·대기화면 진입 잠금·유예 없음)은 `cargo test --lib -- app_lock` 이 잰다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { build } from 'esbuild';

const root = resolve(import.meta.dirname, '..');
async function load(file) {
  const built = await build({ stdin: { contents: `export * from './src/${file}';`, resolveDir: root, loader: 'ts' },
    bundle: true, write: false, platform: 'node', format: 'cjs', logLevel: 'silent', external: ['@tauri-apps/*'], loader: { '.css': 'empty', '.txt': 'text' } });
  const mod = { exports: {} };
  new Function('require', 'exports', 'module', built.outputFiles[0].text)(createRequire(import.meta.url), mod.exports, mod);
  return mod.exports;
}
// i18n 은 불러올 때 이 컴퓨터 말을 읽는다(노드 20 에는 navigator 가 없다).
if (typeof globalThis.navigator === 'undefined') globalThis.navigator = { language: 'ko' };
const lock = await load('app-lock.ts');
const { DICT } = await load('dict.ts');
const seed = await load('seed-check.ts');

const shape = (o) => Object.entries(o).map(([k, v]) => (typeof v === 'object' ? `${k}{${shape(v)}}` : k)).sort().join(',');
const leaves = (o) => Object.values(o).flatMap((v) => (typeof v === 'object' ? leaves(v) : [v]));

test('잠금 화면 문구: 한·영·일·중 네 벌, 같은 칸, 빈 칸 없음', () => {
  const [ko, en, ja, zh] = ['ko', 'en', 'ja', 'zh'].map((l) => lock.lockCopy(l));
  for (const c of [en, ja, zh]) assert.equal(shape(c), shape(ko));
  for (const c of [ko, en, ja, zh]) for (const v of leaves(c)) assert.ok(typeof v === 'string' && v.trim().length > 0);
  assert.notEqual(ja.unlock, en.unlock); assert.notEqual(zh.unlock, en.unlock); assert.notEqual(ko.unlock, en.unlock);
  assert.equal(lock.lockCopy('fr').unlock, en.unlock, '사전에 없는 말은 영어(i18n 규칙과 같다)');
  // 잠금 화면은 「끄기」를 말하지 않는다(설정으로 잠금 끄기 없음).
  for (const c of [ko, en, ja, zh]) assert.doesNotMatch(JSON.stringify(c), /잠금 끄기|disable lock|ロックを無効|关闭锁定/);
});

test('잠금 풀기 오류: Rust 원문을 그대로 붙이지 않고 정해진 말로', () => {
  const c = lock.lockCopy('en');
  assert.equal(lock.unlockError('암호가 맞지 않습니다.', c).text, c.wrong);
  assert.equal(lock.unlockError('여러 번 틀려서 잠시 기다려야 해요. 30초 뒤에 다시 해 주세요.', c).text, c.wait);
  const down = lock.unlockError('노드가 응답하지 않아 암호를 확인할 수 없어요. 노드를 켠 뒤 다시 해 주세요.', c);
  assert.equal(down.text, c.cannotVerify); assert.equal(down.nodeDown, true);
  assert.equal(lock.unlockError('RPC error: SYNTHETIC-PASSWORD-CANARY', c).text, c.failed, '모르는 오류(노드 원문)는 일반 문구');
});

test('새 화면 문구가 en/ja/zh 사전에 있다(복구 단어·보내기 검토 상태·잠금 거절)', () => {
  for (const k of ['민감한 화면 — 복구 단어', '화면 보호 켜짐 · {0}초 뒤에 단어를 저절로 가려요', '시간이 지나 단어를 가렸어요. 다시 보려면 지갑 암호를 넣어 주세요.',
    '복사하지 마세요. 종이에 손으로 적어 주세요.', '아직 보내지 않았어요 — 받는 사람·통화(RVN 또는 자산)·금액·수수료를 확인한 뒤 「보내기」를 누르세요.',
    '지갑이 잠겨 있어요. 잠금을 푼 뒤 다시 해 주세요.', '지갑이 잠긴 동안에는 금액 가리기·캡처 보호를 끌 수 없어요.']) {
    for (const l of ['en', 'ja', 'zh']) assert.ok(DICT[l][k], `${l}: ${k}`);
    if (k.includes('{0}')) for (const l of ['en', 'ja', 'zh']) assert.ok(DICT[l][k].includes('{0}'), `${l} 자리표시`);
  }
  // Rust 쪽 거절 문구와 사전 열쇠가 같은 글자인지(어긋나면 번역이 조용히 빠진다)
  const lib = readFileSync(resolve(root, 'src-tauri/src/lib.rs'), 'utf8');
  assert.ok(lib.includes('"지갑이 잠겨 있어요. 잠금을 푼 뒤 다시 해 주세요."'));
  const mini = readFileSync(resolve(root, 'src-tauri/src/mini.rs'), 'utf8');
  assert.ok(mini.includes('"지갑이 잠긴 동안에는 금액 가리기·캡처 보호를 끌 수 없어요."'));
});

test('흰색 강제는 라이트 테마에만 — 다크 돈 카드는 money-card.css, 라이트 규칙은 그대로', () => {
  const css = readFileSync(resolve(root, 'src/ravi-home.css'), 'utf8');
  // 돈 화면 선택자에 #fff 를 거는 규칙은 전부 라이트 테마 조건 안에 있다.
  const rules = css.split('}').filter((r) => /#send-review|#w-balance|#sdw \.sheet-box/.test(r) && /background:#fff/.test(r));
  assert.equal(rules.length, 2, '라이트 두 벌(명시 light · 시스템 light)');
  for (const r of rules) assert.match(r, /data-theme="light"|prefers-color-scheme: light|not\(\[data-theme="dark"\]\)/);
  assert.ok(css.includes('@media (prefers-color-scheme: light)'));
  const dark = readFileSync(resolve(root, 'src/money-card.css'), 'utf8');
  for (const line of dark.split('\n').filter((l) => /background:/.test(l))) assert.match(line, /data-theme="dark"|data-theme="light"\]\)\)/, `다크 조건 밖 배경: ${line}`);
  assert.doesNotMatch(dark, /#fff\b|white/i, '다크 돈 카드에 흰색 없음');
  assert.match(dark, /#sdw \.sheet-box/, '복구 단어는 별도 민감 화면 규칙');
});

test('복구 단어 자동 가림: 3분, 재인증으로만 다시 보기(시간 유예 해제 없음)', () => {
  assert.equal(seed.AUTO_HIDE_MS, 180_000);
  const src = readFileSync(resolve(root, 'src/seed-check.ts'), 'utf8');
  assert.match(src, /paintReveal\(false, t\("시간이 지나 단어를 가렸어요/);
  assert.ok(src.includes('void protectScreen(true); // 단어가 뜨기 전에 가린다'), '캡처 보호 그대로');
  assert.ok(src.includes('deps.invoke<any>("reveal_seed", { passphrase: pass.value })'), '재인증(암호) 관문 그대로');
});
