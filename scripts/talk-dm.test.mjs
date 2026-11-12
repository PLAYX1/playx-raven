// 데스크탑 쪽지(src-tauri/src/talk_dm.rs) ↔ 폰 쪽지(core/talk/nip17.ts) 공용 벡터.
// 폰이 봉한 1:1·단톡 겉봉을 러스트가 열고, 같은 단톡 방 열쇠(groupKey)·이모티콘 표를 만드는지 묶는다.
//   node --test scripts/talk-dm.test.mjs                 검사(폰 저장소가 있으면 폰 코드로도 다시 연다)
//   node scripts/talk-dm.test.mjs --write-vectors        벡터 다시 쓰기(겉봉은 매번 달라진다 — 바꿀 때만)
// 폰 저장소 위치: RV_PHONE_REPO(기본 ~/wt-rv-buy-phone). 비밀값은 시험 전용 고정 키(7 로 채운 32바이트)다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { build } from 'esbuild';

const VECTORS = 'scripts/fixtures/talk-dm-vectors.json';
const PHONE = process.env.RV_PHONE_REPO || join(homedir(), 'wt-rv-buy-phone');
const NIP17 = join(PHONE, 'core/talk/nip17.ts');
const hex = (b) => Buffer.from(b).toString('hex');
const unhex = (h) => Uint8Array.from(Buffer.from(h, 'hex'));
const secret = (n) => Uint8Array.from({ length: 32 }, (_, i) => (i === 31 ? n : 7));

async function phoneModule(path) {
  const built = await build({ entryPoints: [path], bundle: true, write: false, platform: 'node', format: 'cjs', logLevel: 'silent', nodePaths: [join(PHONE, 'node_modules')] });
  const mod = { exports: {} };
  new Function('require', 'exports', 'module', built.outputFiles[0].text)(createRequire(join(PHONE, 'package.json')), mod.exports, mod);
  return mod.exports;
}

async function write() {
  const nip17 = await phoneModule(NIP17);
  const event = await phoneModule(join(PHONE, 'core/talk/event.ts'));
  const sticker = await phoneModule(join(PHONE, 'core/talk/sticker.ts'));
  const [a, b, c] = [secret(1), secret(2), secret(3)];
  const [alice, bob, carol] = [a, b, c].map((s) => event.publicKeyOf(s));
  const now = 1_793_600_000;
  const direct = ['안녕하세요, 도복 빌릴 수 있나요?', '네 :ravi_ok: 오세요\n두 줄도 됩니다'].map((text, i) => {
    const wraps = nip17.wrapChat(a, [bob], { text }, now + i);
    const opened = nip17.unwrap(b, wraps[0]);
    return { text, rumorId: opened.id, wrap: wraps[0], self: wraps[1] };
  });
  const gtext = '주말에 모여요 :ravi_cheer: :ravi_cheer: :ravi_love:';
  const subject = '주말 모임';
  const gw = nip17.wrapChat(a, [bob, carol], { text: gtext, subject }, now + 10);
  const members = nip17.unwrap(b, gw[0]).members;
  const commit = (() => { try { return execFileSync('git', ['-C', PHONE, 'log', '-1', '--format=%h', '--', 'core/talk/nip17.ts']).toString().trim(); } catch { return ''; } })();
  const out = {
    source: { repo: 'ravenvault(폰)', file: 'core/talk/nip17.ts', commit, sha256: createHash('sha256').update(readFileSync(NIP17)).digest('hex') },
    aliceSecret: hex(a), bobSecret: hex(b), carolSecret: hex(c), alice, bob, carol, now,
    direct: direct.map(({ text, rumorId, wrap }) => ({ text, rumorId, wrap })),
    directSelfCopy: direct[0].self,
    group: { text: gtext, subject, members, key: nip17.groupKey(members), emojiTags: sticker.stickerTags(gtext), wrapBob: gw[0], wrapCarol: gw[1], wrapAlice: gw[2] },
  };
  writeFileSync(VECTORS, JSON.stringify(out, null, 2) + '\n');
}
if (process.argv.includes('--write-vectors')) { await write(); console.log('wrote', VECTORS); }

test('벡터 모양: 1:1 둘 · 내 사본 · 단톡 셋(사람마다 + 나)', () => {
  const v = JSON.parse(readFileSync(VECTORS, 'utf8'));
  assert.equal(v.direct.length, 2);
  for (const d of v.direct) { assert.equal(d.wrap.kind, 1059); assert.deepEqual(d.wrap.tags, [['p', v.bob]]); }
  assert.deepEqual(v.directSelfCopy.tags, [['p', v.alice]]);
  assert.deepEqual(v.group.members, [v.alice, v.bob, v.carol].sort());
  assert.match(v.group.key, /^g:[0-9a-f]{32}$/);
  assert.deepEqual(v.group.emojiTags.map((t) => t[1]), ['ravi_cheer', 'ravi_love']);
});

test('폰 코드로 다시 열어도 같은 글(폰 저장소가 있을 때만)', { skip: !existsSync(NIP17) && '폰 저장소 없음' }, async () => {
  const v = JSON.parse(readFileSync(VECTORS, 'utf8'));
  const nip17 = await phoneModule(NIP17);
  for (const d of v.direct) assert.equal(nip17.unwrap(unhex(v.bobSecret), d.wrap).text, d.text);
  const g = nip17.unwrap(unhex(v.carolSecret), v.group.wrapCarol);
  assert.equal(g.subject, v.group.subject);
  assert.equal(nip17.groupKey(g.members), v.group.key);
});
