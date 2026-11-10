// 11-10 라비가 화면 설정을 바꾸는 말(ravi-settings.ts) — 불편을 말해도 알아듣고, 다른 질문은 건드리지 않는다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
const root = resolve(import.meta.dirname, '..');
const js = ts.transpileModule(readFileSync(resolve(root, 'src/ravi-settings.ts'), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const mod = { exports: {} }; vm.runInNewContext(js, { module: mod, exports: mod.exports });
const run = (qs) => qs.map((q) => JSON.parse(JSON.stringify(mod.exports.raviSettingIntent(q))));
test('불편·명령을 알아듣는다', () => {
  const [a, b, c, d, e, f, g, h] = run(['글씨가 너무 작아', '잘 안 보여요', '글자 작게', '눈부셔', '밝게', '알림 소리 꺼 줘', '영어로 바꿔 줘', 'make text bigger']);
  assert.deepEqual(a, { kind: 'text', dir: 'up' }); assert.deepEqual(b, { kind: 'text', dir: 'up' }); assert.deepEqual(c, { kind: 'text', dir: 'down' });
  assert.deepEqual(d, { kind: 'theme', to: 'dark' }); assert.deepEqual(e, { kind: 'theme', to: 'light' }); assert.deepEqual(f, { kind: 'sound', on: false });
  assert.deepEqual(g, { kind: 'lang', to: 'en' }); assert.deepEqual(h, { kind: 'text', dir: 'up' });
});
test('다른 질문은 건드리지 않는다', () => {
  for (const r of run(['잔액이 안 보여요', '사진이 너무 작아', '영어 단어 뭐야', '보내기 어떻게 해', '가게 화면 보여줘'])) assert.equal(r, null);
});
