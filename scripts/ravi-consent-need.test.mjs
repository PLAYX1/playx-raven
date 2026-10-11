import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import vm from 'node:vm';
const r = await build({ entryPoints: ['src/ravi-consent-need.ts'], bundle: true, platform: 'node', format: 'cjs', write: false });
const c = { module: { exports: {} } }; vm.runInNewContext(r.outputFiles[0].text, c);
const need = c.module.exports.questionNeedsPersonalData;
test('일반 질문에는 동의 카드가 필요 없다', () => {
  for (const q of ['몇살이야?', '안녕', '너 누구야', '레이븐코인은 언제 만들어졌어?', '채굴은 어떻게 해?', 'How old are you?', 'Wie alt bist du?', 'Quel âge as-tu ?', '你几岁', '何歳ですか', '', '   ']) assert.equal(need(q), false, q);
});
test('내 데이터 질문에는 필요하다', () => {
  for (const q of ['내 잔액 얼마야?', '최근 거래 내역 보여줘', '이번 달 가게 매출은?', '주문 몇 건이야', 'What is my balance?', 'show my recent transactions', 'my shop sales this week', '残高を教えて', '我的余额是多少', '最近的交易', 'Qual é o meu saldo?', 'Wie ist mein Kontostand?', 'Quel est mon solde ?', '¿Cuál es mi saldo?', 'Qual è il mio saldo?', 'Какой у меня баланс?']) assert.equal(need(q), true, q);
});
