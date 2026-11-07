import { assert } from '../test-assert';
import { matchSymbols } from './match-symbols';

// 1:1 — 서로 다른 숫자는 서로 다른 그림 4개.
const seen = new Map<string, string>();
for (let n = 0; n < 1_000_000; n += 7) {
  const code = String(n).padStart(6, '0');
  const key = matchSymbols(code)!.map(s => `${s.color}-${s.shape}`).join('|');
  assert(!seen.has(key), `collision ${code} vs ${seen.get(key)}`);
  seen.set(key, code);
}
// 고정 값: 폰과 데스크탑이 같은 답을 내는지 두 저장소 시험이 같은 값을 본다.
assert(matchSymbols('000000')!.map(s => s.name).join(',') === '주황 별,주황 별,주황 별,주황 별', 'zero');
assert(matchSymbols('999999')!.map(s => s.name).join(',') === '파랑 해,초록 별,초록 달,파랑 세모', `999999 ${matchSymbols('999999')!.map(s => s.name).join(',')}`);
assert(matchSymbols('12345') === null && matchSymbols('12a456') === null, 'non-code');
console.log('match-symbols ok');
