// 라비 작은 목소리(ko-v2) 앞단 — 앱 쪽 TS 가 학습 쪽 파이썬(normalize_ko.py·ravi_g2p.py)과 똑같이 읽는지.
// 기준 = 파이썬이 만든 결과(학습 문장 300줄 + 숫자·약어·기호 예외 21줄). 11-27 전체 6,672줄도 0건 차이로 맞춤.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, statSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
const exports = {};
vm.runInNewContext(ts.transpileModule(readFileSync('src/ravi-ko-g2p.ts', 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText, { exports });
const g = exports;

test('파이썬과 같은 읽는 말·음소 번호', () => {
  const rows = JSON.parse(readFileSync('scripts/fixtures/ravi-ko-g2p.json', 'utf8'));
  for (const [text, spoken, ids] of rows) {
    assert.equal(g.normalizeKo(text), spoken, text);
    assert.equal(g.koIds(spoken).join(), ids.join(), text);   // vm 안 배열은 다른 realm 이라 글로 비교
  }
});
test('번호 표 크기·대표 예', () => {
  assert.equal(g.KO_PHONEME_COUNT, 84);
  assert.equal(g.normalizeKo('10.5 RVN 보냈어요'), '십 점 오 알브이엔 보냈어요');
  assert.equal(g.normalizeKo('3개 남았어요'), '세 개 남았어요');
});
test('한국어 판별: 한글 있으면 작은 목소리, 가나·한자 섞이면 기존 목소리', () => {
  assert.equal(g.isKoreanText('안녕하세요, 라비예요.'), true);
  assert.equal(g.isKoreanText('Hello Ravi'), false);
  assert.equal(g.isKoreanText('こんにちは 라비'), false);
});
test('모델 파일이 앱 안에 있다(약 19MB)', () => {
  const size = statSync('public/ravi-tts/ravi-ko-v2.int8.onnx').size;
  assert.ok(size > 15e6 && size < 25e6, String(size));
});
