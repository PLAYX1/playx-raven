// 「만들기」 이름·비용 규칙 — RavenVault 폰(core/easy-create/plan.ts)과 같은 답을 내는지.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { build } from 'esbuild';
const bundle = await build({ entryPoints: [new URL('../src/easy-create.ts', import.meta.url).pathname], bundle: true, write: false, platform: 'node', format: 'esm' });
const m = await import('data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].text).toString('base64'));
const DAY = new Date(2026, 8, 17, 23, 59);

assert.deepEqual(m.romanPieces('홍길동'), ['HONG', 'GIL', 'DONG']);
assert.equal(m.brandFrom('홍길동'), 'HONGGILDONG');
assert.equal(m.brandFrom('3D 스튜디오'), '3DSEUTYUDIO');
assert.equal(m.brandFrom('Raven'), '');
assert.equal(m.brandFrom('아'), '');
assert.deepEqual(m.brandCandidates('ABCDEFGHIJKL').slice(0, 2), ['ABCDEFGHIJKL', 'ABCDEFGHIJK2']);
assert.equal(m.slugFrom('수료증', 'certificate'), 'SURYO');
assert.equal(m.slugFrom('바다 그림', 'work'), 'BADAGEU');
assert.equal(m.slugFrom('!!!', 'ticket'), 'TICKET');
assert.deepEqual(m.itemNames({ kind: 'work', brand: 'HANBIT', title: '바다 그림', date: DAY, count: 3, run: 0 }),
  ['HANBIT#BADAGEU260917-1', 'HANBIT#BADAGEU260917-2', 'HANBIT#BADAGEU260917-3']);
assert.deepEqual(m.itemNames({ kind: 'ticket', brand: 'HANBIT', title: '공연', date: DAY, count: 300, run: 2 }), ['HANBIT/GONGYEON260917C']);
const longest = m.itemNames({ kind: 'work', brand: 'ABCDEFGHIJKL', title: 'ABCDEFGHIJ', date: DAY, count: 50, run: 23 });
assert.equal(longest[49], 'ABCDEFGHIJKL#ABCDEFGH260917Z-50');
assert.ok(longest[49].length <= 31);
assert.throws(() => m.itemNames({ kind: 'work', brand: 'HANBIT', title: 'a', date: DAY, count: 51, run: 0 }));
assert.throws(() => m.itemNames({ kind: 'work', brand: 'HANBIT', title: 'a', date: DAY, count: 1, run: 24 }));
assert.equal(m.totalRvn('work', 10, true), 500 + 50 + 0.1);
assert.equal(m.totalRvn('work', 50, false), 250 + 0.16);
assert.equal(m.totalRvn('ticket', 1, false), 100 + 0.05);

// 첫 이름이 이미 있으면 다음 차례(B)로.
const asked = [];
const found = await m.findFreeRun(run => m.itemNames({ kind: 'work', brand: 'HANBIT', title: 'a', date: DAY, count: 3, run }),
  async names => { asked.push(...names); return names.map(n => n === 'HANBIT#A260917-1'); });
assert.equal(found.run, 1);
assert.deepEqual(asked.slice(0, 2), ['HANBIT#A260917-1', 'HANBIT#A260917-3']);
// 한 묶음 안에서 방금 쓴 차례(0·1)는 체인에 아직 안 보여도 건너뛴다 — 두 번째 50장이 같은 이름을 고르지 않게.
const next = await m.findFreeRun(run => m.itemNames({ kind: 'certificate', brand: 'HANBIT', title: 'a', date: DAY, count: 50, run }),
  async names => names.map(() => false), new Set([0, 1]));
assert.equal(next.run, 2);
assert.equal(next.names[49], 'HANBIT#A260917C-50');
assert.equal(m.runOf(next.names[49]), 2);
assert.equal(m.runOf('HANBIT#A260917-3'), 0);
assert.equal(m.runOf('HANBIT#A260917I-3'), -1, 'I 는 차례 글자가 아니다');

// 지문 — 폰·확인 페이지와 같은 CIDv0 (원본 SHA-256).
const bytes = Buffer.from('synthetic artwork bytes for RavenVault create test\n');
assert.equal(m.fingerprintOf(new Uint8Array(createHash('sha256').update(bytes).digest())), 'QmcwUFCZ8saJgoE6D9LEgVqtteCbVcdzWFcGzuhe7VTeW7');
assert.equal(await m.fileFingerprint(new Blob([bytes])), 'QmcwUFCZ8saJgoE6D9LEgVqtteCbVcdzWFcGzuhe7VTeW7');
assert.equal(m.verifyLink('HANBIT#A-1'), 'https://ravenvault.ex.erci.se/verify/?a=HANBIT%23A-1');

// 이어하기 기록 — 손상은 버린다.
const draft = { version: 1, kind: 'work', title: '그림', count: 3, brand: 'HANBIT', stage: 'brand-sent', txid: 'ab'.repeat(32), updatedAt: 1 };
assert.deepEqual(m.parseDraft(JSON.stringify(draft)), draft);
assert.equal(m.parseDraft('{broken'), null);
assert.equal(m.parseDraft(JSON.stringify({ ...draft, brand: 'RVN' })), null);
assert.equal(m.parseDraft(JSON.stringify({ ...draft, count: 51 })), null);
assert.equal(m.parseDraft(JSON.stringify({ ...draft, fingerprint: 'nope' })), null);
// 보냈는지 모름 — 거래 번호를 모르고, 무엇을 보냈는지(step)는 꼭 있어야 다시 확인할 수 있다.
const unknown = { ...draft, stage: 'sent-unknown', step: 'uniques', txid: '', names: ['HANBIT#A260917-1'] };
assert.deepEqual(m.parseDraft(JSON.stringify(unknown)), unknown);
assert.equal(m.parseDraft(JSON.stringify({ ...unknown, step: undefined })), null);
assert.equal(m.parseDraft(JSON.stringify({ ...unknown, step: 'mint' })), null);
assert.equal(m.parseDraft(JSON.stringify({ ...draft, txid: 'xyz' })), null);
console.log('PASS easy-create: 이름·비용·지문·이어하기 (폰과 같은 규칙)');
