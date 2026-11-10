// 11-10 라비가 이야기 말(연락 확인·방 열기·방 알림·초대)을 알아듣는다(ravi-talk-intents.ts). 보내라는 말은 없다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
const root = resolve(import.meta.dirname, '..');
const load = (f) => { const js = ts.transpileModule(readFileSync(resolve(root, f), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText; const m = { exports: {} }; vm.runInNewContext(js, { module: m, exports: m.exports }); return m.exports; };
const T = load('src/ravi-talk-intents.ts'), S = load('src/ravi-settings.ts');
const ask = (q) => JSON.parse(JSON.stringify(T.raviTalkIntent(q)));
test('연락·방 열기·알림·초대를 알아듣는다', () => {
  assert.deepEqual(ask('연락 왔어?'), { kind: 'notices' });
  assert.deepEqual(ask('답글 달렸어?'), { kind: 'notices' });
  assert.deepEqual(ask('광장 열어 줘'), { kind: 'open', room: '' });
  assert.deepEqual(ask('등산 모임 방 열어 줘'), { kind: 'open', room: '등산 모임' });
  assert.deepEqual(ask('시끄러워'), { kind: 'mute', off: true });
  assert.deepEqual(ask('이 방 알림 꺼'), { kind: 'mute', off: true });
  assert.deepEqual(ask('이 방 알림 다시 켜 줘'), { kind: 'mute', off: false });
  assert.deepEqual(ask('이 방 공유해 줘'), { kind: 'share' });
  assert.deepEqual(ask('친구 초대하고 싶어'), { kind: 'share' });
});
test('다른 말은 건드리지 않고, 설정 말과 겹치지 않는다', () => {
  for (const q of ['잔액 얼마야', '보내기 어떻게 해', '새 방 열어 줘', '답장 보내 줘', '글 써 줘']) assert.equal(T.raviTalkIntent(q), null, q);
  // 「알림 소리 꺼」는 설정(소리) 쪽이 먼저 잡는다 — main.ts 순서와 같다.
  assert.deepEqual(JSON.parse(JSON.stringify(S.raviSettingIntent('알림 소리 꺼 줘'))), { kind: 'sound', on: false });
  assert.equal(S.raviSettingIntent('시끄러워'), null);
  assert.equal(S.raviSettingIntent('이 방 알림 꺼'), null);
});
test('방 이름 찾기 — 같은 것·들어 있는 것 하나·여럿이면 묻기', () => {
  const m = new Map([['a', '등산 모임'], ['b', '등산 후기'], ['c', '레이븐 공지']]);
  assert.equal(T.findRoom(m, '등산모임').id, 'a');
  assert.equal(T.findRoom(m, '공지').id, 'c');
  const r = T.findRoom(m, '등산'); assert.equal(r.id, null); assert.deepEqual([...r.candidates], ['등산 모임', '등산 후기']);
  assert.equal(T.findRoom(m, '낚시').candidates.length, 0);
});
