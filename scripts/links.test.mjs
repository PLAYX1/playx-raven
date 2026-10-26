// 사람이 열거나 공유하는 링크 — 정본 주소·인코딩·방 번호 외 정보 미포함. 순수 함수.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { build } from 'esbuild';

async function moduleAt(path) {
  const built = await build({ entryPoints: [path], bundle: true, write: false, platform: 'node', format: 'cjs', logLevel: 'silent' });
  const mod = { exports: {} };
  new Function('require', 'exports', 'module', built.outputFiles[0].text)(createRequire(import.meta.url), mod.exports, mod);
  return mod.exports;
}
const L = await moduleAt('src/links.ts');

test('초대 링크는 정본 주소의 새 지갑으로 간다', () => {
  assert.equal(L.inviteLink('42'), 'https://ravenvault.ex.erci.se/wallet/?room=42');
  assert.equal(L.inviteLink(42), 'https://ravenvault.ex.erci.se/wallet/?room=42');
});
test('방 번호는 인코딩되고 다른 정보는 담기지 않는다', () => {
  const u = new URL(L.inviteLink('a b&c=d#x?y/z'));
  assert.equal(u.origin, 'https://ravenvault.ex.erci.se');
  assert.equal(u.pathname, '/wallet/');
  assert.deepEqual([...u.searchParams.keys()], ['room']);
  assert.equal(u.searchParams.get('room'), 'a b&c=d#x?y/z');
  assert.equal(u.hash, '');
});
test('방이 없으면 방 번호 없이 새 지갑 입구', () => {
  for (const r of ['', '  ', null, undefined]) assert.equal(L.inviteLink(r), 'https://ravenvault.ex.erci.se/wallet/');
});
test('초대하기 코드는 옛 주소(rvn.ex.erci.se/talk)를 쓰지 않는다', () => {
  const main = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(main, /rvn\.ex\.erci\.se\/talk/);
  assert.match(main, /const url = inviteLink\(tkRoom\)/);
});
