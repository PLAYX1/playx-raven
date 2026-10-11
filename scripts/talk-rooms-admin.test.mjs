// 이야기 방 운영(0.9.0 레인 C) — 화면 없이 도는 규칙들. esbuild 로 TS 를 묶어 Node 에서 바로 부른다(DOM 없음).
//  - 숨긴 방 저장·되돌리기·지켜보기 명단에서 빼기 · 목록 거르기(보고 있는 방은 남김) · 방금 바꾼 이름 반영과 내려놓기
//  - 「방 설정」 권한(내 방만) · 공식 방 알아보기 · 이름·설명 검사(러스트 clean_room_meta 와 같은 선)
import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const store = new Map();
globalThis.localStorage = {
  getItem: k => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: k => store.delete(k),
  clear: () => store.clear(),
};
store.set('playx-raven-lang', 'ko');

const built = await build({
  stdin: { contents: `export * from './src/talk-rooms-admin.ts'; export { checkRoomMeta } from './src/talk-rooms-admin-sheet.ts';`, resolveDir: root, sourcefile: 'entry.ts', loader: 'ts' },
  bundle: true, write: false, platform: 'node', format: 'esm', logLevel: 'silent', loader: { '.css': 'empty', '.json': 'json', '.txt': 'text' },
});
const M = await import('data:text/javascript;base64,' + Buffer.from(built.outputFiles[0].text).toString('base64'));

const ME = 'a'.repeat(64), OTHER = 'b'.repeat(64);
const room = (id, name, pubkey, extra = {}) => ({ id, name, about: '', asset: '', pubkey, meta_at: null, ...extra });

test('숨긴 방 — 저장·되돌리기, 지켜보기 명단에서도 뺀다, 깨진 값은 무시', () => {
  store.clear();
  store.set('playx-raven-talk-watch', JSON.stringify(['r1', 'r2']));
  M.hideRoom('r1', '동네 소식');
  assert.deepEqual(Object.keys(M.loadHidden()), ['r1']);
  assert.equal(M.loadHidden().r1.name, '동네 소식');
  assert.deepEqual(JSON.parse(store.get('playx-raven-talk-watch')), ['r2'], '숨긴 방 알림이 계속 울린다');
  M.hideRoom('', '레이븐 이야기');
  assert.equal(Object.keys(M.loadHidden()).length, 1, '「레이븐 이야기」(방 아님)를 숨겼다');
  M.unhideRoom('r1');
  assert.deepEqual(M.loadHidden(), {});
  store.set(M.HIDDEN_KEY, '{깨짐');
  assert.deepEqual(M.loadHidden(), {}, '깨진 값에 이야기 화면이 죽는다');
  store.set(M.HIDDEN_KEY, '[1,2]');
  assert.deepEqual(M.loadHidden(), {});
});

test('「방 설정」 권한 — 서명 확인된 만든 사람이 나일 때만', () => {
  assert.equal(M.canEditRoom(room('r', '방', ME), ME), true);
  assert.equal(M.canEditRoom(room('r', '방', OTHER), ME), false, '남의 방');
  assert.equal(M.canEditRoom(room('r', '방', ''), ME), false, '만든 사람을 확인 못 한 방');
  assert.equal(M.canEditRoom(room('r', '방', ME), ''), false, '내가 누구인지 아직 모름');
  assert.equal(M.canEditRoom(room('', '레이븐 이야기', ME), ME), false);
  assert.equal(M.canEditRoom(undefined, ME), false);
});

test('공식 방 알아보기 — 이름(띄어쓰기·대소문자 무시)으로, 비슷한 다른 이름은 아님', () => {
  assert.equal(M.isOfficialRoom({ id: 'x', name: 'RavenVault 레이븐볼트' }), true);
  assert.equal(M.isOfficialRoom({ id: 'x', name: 'raven vault' }), true);
  assert.equal(M.isOfficialRoom({ id: 'x', name: '레이븐 볼트 공지' }), true);
  assert.equal(M.isOfficialRoom({ id: 'x', name: '서울 주짓수 모임' }), false);
  assert.equal(M.isOfficialRoom(undefined), false);
});

test('목록 거르기 — 숨긴 방은 빼되 지금 보는 방은 남긴다', () => {
  store.clear();
  let current = '';
  const api = M.wireTalkRoomsAdmin({ call: async () => null, me: () => ME, current: () => current, sure: async () => true, unlock: async () => true, errText: String, reload() {}, leave() {} });
  const list = [room('r1', '내 방', ME), room('r2', '남의 방', OTHER), room('r3', '셋째', OTHER)];
  M.hideRoom('r2', '남의 방');
  assert.deepEqual(api.rooms(list).map(r => r.id), ['r1', 'r3']);
  current = 'r2';
  assert.deepEqual(api.rooms(list).map(r => r.id), ['r1', 'r2', 'r3'], '보고 있는 방이 목록에서 사라졌다 — 길을 잃는다');
});

test('이름·설명 검사 — 러스트와 같은 선(빈 이름·40/80자·제어 문자·숨은 방향 문자), 좋은 입력은 통과', () => {
  assert.equal(M.checkRoomMeta('서울 주짓수 모임', '매주 목요일 스파링'), null);
  assert.equal(M.checkRoomMeta('가'.repeat(40), '나'.repeat(80)), null, '딱 맞는 것이 막혔다');
  assert.equal(M.checkRoomMeta('가족 👨‍👩‍👧', 'Café · 東京'), null, '이모지·여러 나라 글자가 막혔다');
  assert.match(M.checkRoomMeta('  ', ''), /필요해요/);
  assert.match(M.checkRoomMeta('가'.repeat(41), ''), /40자까지.*41자/);
  assert.match(M.checkRoomMeta('이름', '나'.repeat(81)), /80자까지.*81자/);
  for (const bad of ['줄\n바꿈', '탭\t이름', 'RavenVault\u202Etlua', '숨은\u2066방향', '폭\u200B없음', '앞\uFEFF뒤']) {
    assert.ok(M.checkRoomMeta(bad, ''), `${JSON.stringify(bad)} 가 지나갔다`);
    assert.ok(M.checkRoomMeta('이름', bad), `설명 ${JSON.stringify(bad)} 가 지나갔다`);
  }
  // 글자 수는 화면 글자 기준(이모지 하나 = 1) — 러스트 chars().count() 와 같다.
  assert.equal(M.checkRoomMeta('😀'.repeat(40), ''), null);
});
