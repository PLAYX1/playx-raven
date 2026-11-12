// 짝 맺은 폰에서 보낸 게임 — 데스크탑 일꾼(src/arcade-phone-upload.ts). 가짜 invoke 만(노드·IPFS·릴레이·체인 없음, 던져 버리는 키만).
// 러스트 쪽(받기·조각·zip-slip·봉인 통로 인증)은 src-tauri arcade_phone.rs · server.rs arcade_phone_route_tests 가 본다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { build } from 'esbuild';

const load = async (entry) => {
  const b = await build({ entryPoints: [entry], bundle: true, write: false, platform: 'node', format: 'cjs', logLevel: 'silent', loader: { '.css': 'empty' } });
  const mod = { exports: {} };
  new Function('require', 'exports', 'module', b.outputFiles[0].text)(createRequire(import.meta.url), mod.exports, mod);
  return mod.exports;
};
const A = await load('scripts/fixtures/arcade-entry.ts');
const P = await load('src/arcade-phone-upload.ts');
const hex = b => Buffer.from(b).toString('hex');
const sha = s => A.sha256Hex(A.utf8(s));
const rvn = A.secp256k1.utils.randomPrivateKey(), seller = A.addressOfPublicKey(A.secp256k1.getPublicKey(rvn, true));
const nos = A.schnorr.utils.randomPrivateKey(), npub = hex(A.schnorr.getPublicKey(nos));
const files = [{ path: 'index.html', sha256: sha('i'), size: 100 }, { path: 'game.js', sha256: sha('g'), size: 200 }];
const html = '<!doctype html><html><head><script src="game.js"></script></head><body></body></html>';
const scan = { folder: 'phone-1', files, skipped: [], badNames: [], htmlTexts: { 'index.html': html } };
const meta = { title: 'Star Run', description: '', genre: 'arcade', priceSats: '50000000', minutes: 3, tag: 'STAR_RUN', mode: 'open' };

function fakeDesk({ locked = false, jobs = [] } = {}) {
  const calls = [], reports = [], published = [];
  const invoke = async (cmd, args = {}) => {
    calls.push(cmd);
    if (cmd === 'arcade_phone_jobs') return jobs.splice(0);
    if (cmd === 'arcade_phone_report') { reports.push(args); return null; }
    if (cmd === 'arcade_phone_take') return null;
    if (cmd === 'wallet_lock_state') return { encrypted: true, unlocked: !locked };
    if (cmd === 'new_address') return seller;
    if (cmd === 'arcade_pin_folder') { assert.deepEqual(args.expect, files); return { cid: 'Qm' + 'F'.repeat(44) }; }
    if (cmd === 'sign_message') return { signature: A.signMessageWithKeyForTest(args.message, rvn) };
    if (cmd === 'ipfs_add_file') return { cid: 'Qm' + 'D'.repeat(44) };
    if (cmd === 'arcade_listing_pubkey') return npub;
    if (cmd === 'arcade_listing_publish') { published.push(args.content); return { published: 1 }; }
    throw new Error('unexpected command ' + cmd);
  };
  let saved = '';
  return { invoke, calls, reports, published, store: { get: () => saved, set: v => { saved = v; } } };
}

test('일반 판매자 일감: 받은 폴더를 붙잡고 화면과 같은 길로 올린다 · 체인 명령 없음 · 결과를 폰에 알린다', async () => {
  const d = fakeDesk();
  const st = await P.processPhoneJob({ invoke: d.invoke, sellerStore: d.store }, { id: 'j1', status: 'queued', meta, scan });
  assert.equal(st, 'done');
  assert.deepEqual(d.calls.filter(c => c !== 'arcade_phone_report'),
    ['wallet_lock_state', 'arcade_phone_take', 'new_address', 'arcade_pin_folder', 'sign_message', 'ipfs_add_file', 'arcade_listing_pubkey', 'sign_message', 'arcade_listing_publish']);
  for (const bad of ['issue_asset', 'reissue', 'send', 'arcade_pay']) assert.ok(!d.calls.includes(bad));
  const last = d.reports.at(-1);
  assert.equal(last.status, 'done'); assert.equal(last.result.docCid, 'Qm' + 'D'.repeat(44)); assert.equal(last.result.id, 'star-run');
  assert.deepEqual(d.reports.map(r => r.step), ['start', 'pin', 'sign', 'doc', 'listing', 'done']);
  const c = JSON.parse(d.published[0]);
  assert.equal(c.seller, seller); assert.equal(c.state, 'open'); assert.equal(c.id, 'star-run');
  assert.equal(d.store.get(), seller, '판매 주소를 기억한다(화면과 같은 칸)');
});

test('폴더 검사에 걸리면 올리지 않고 rejected · 지갑이 잠겼으면 needs-desktop 에서 기다린다', async () => {
  const bad = { ...scan, htmlTexts: { 'index.html': '<script>alert(1)</script>' } };
  const d = fakeDesk();
  assert.equal(await P.processPhoneJob({ invoke: d.invoke }, { id: 'j2', status: 'queued', meta, scan: bad }), 'rejected');
  assert.equal(d.reports[0].status, 'rejected'); assert.ok(d.reports[0].message.length > 0);
  assert.ok(!d.calls.includes('arcade_pin_folder') && !d.calls.includes('sign_message'));
  const noEntry = fakeDesk();
  assert.equal(await P.processPhoneJob({ invoke: noEntry.invoke }, { id: 'j3', status: 'queued', meta, scan: { ...scan, files: [files[1]], htmlTexts: {} } }), 'rejected');
  const lk = fakeDesk({ locked: true }), why = [];
  assert.equal(await P.processPhoneJob({ invoke: lk.invoke, onNeedsDesktop: (_, w) => why.push(w) }, { id: 'j4', status: 'queued', meta, scan }), 'needs-desktop');
  assert.deepEqual(why, ['locked']); assert.equal(lk.reports[0].status, 'needs-desktop');
  assert.ok(!lk.calls.includes('sign_message') && !lk.calls.includes('arcade_phone_take'));
  // 이미 기다리는 중이면 같은 알림을 또 보내지 않는다
  const lk2 = fakeDesk({ locked: true });
  await P.processPhoneJob({ invoke: lk2.invoke }, { id: 'j4', status: 'needs-desktop', meta, scan });
  assert.equal(lk2.reports.length, 0);
});

test('🔴 가게 이름(소각) 일감은 폰 확인만으로 태우지 않는다 — 이 컴퓨터 화면의 확인 칸으로 넘긴다', async () => {
  const d = fakeDesk(), seen = [];
  const st = await P.processPhoneJob({ invoke: d.invoke, onNeedsDesktop: (j, w) => seen.push([j.id, w]) }, { id: 'j5', status: 'queued', meta: { ...meta, mode: 'shop', shop: 'PLAYX' }, scan });
  assert.equal(st, 'needs-desktop'); assert.deepEqual(seen, [['j5', 'shop']]);
  assert.equal(d.reports[0].step, 'confirm-shop');
  for (const c of ['issue_asset', 'reissue', 'sign_message', 'arcade_pin_folder', 'ipfs_add_file', 'wallet_lock_state']) assert.ok(!d.calls.includes(c), c);
  // 화면 쪽: 확인 칸(소각액·읽었어요)을 지나야 issue_asset — 폰 preset 은 칸을 채울 뿐 확인을 건너뛰지 않는다
  const up = readFileSync('src/arcade-upload.ts', 'utf8');
  assert.match(up, /fillPreset/); assert.match(up, /arcade_phone_take/);
  assert.ok(!/preset[^\n]*issue_asset/.test(up), 'preset 이 곧바로 발행하지 않는다');
});

test('일꾼: 한 바퀴에 일감을 차례로 · 할 일이 없으면 띠를 지운다 · 실패는 failed 로 알린다', async () => {
  const d = fakeDesk({ jobs: [{ id: 'a', status: 'queued', meta, scan }, { id: 'b', status: 'queued', meta: { ...meta, mode: 'shop', shop: 'PLAYX' }, scan }] });
  let cleared = 0;
  const r = P.startPhoneUploads({ invoke: d.invoke, sellerStore: d.store, onClear: () => cleared++ }, 60_000);
  await r.tick(); r.stop();
  assert.equal(cleared, 0, '가게 일감이 기다리는 중');
  assert.deepEqual([...new Set(d.reports.map(x => x.id))], ['a', 'b']);
  const e = fakeDesk({ jobs: [] });
  const r2 = P.startPhoneUploads({ invoke: e.invoke, onClear: () => cleared++ }, 60_000); await r2.tick(); r2.stop();
  assert.equal(cleared, 1);
  const f = fakeDesk();
  const boom = async (cmd, a) => { if (cmd === 'ipfs_add_file') throw new Error('ipfs down'); return f.invoke(cmd, a); };
  assert.equal(await P.processPhoneJob({ invoke: boom, sellerStore: f.store }, { id: 'c', status: 'queued', meta, scan }), 'failed');
  assert.equal(f.reports.at(-1).status, 'failed'); assert.match(f.reports.at(-1).message, /ipfs down/);
  assert.ok(!f.calls.includes('arcade_listing_publish'), '공개 쪽지는 마지막 — 앞에서 실패하면 안 나간다');
});

test('새 문구는 영·일·중이 다 있다', () => {
  const copy = readFileSync('src/arcade-copy.ts', 'utf8');
  for (const k of ['폰에서 보낸 게임을 가게 이름으로 올리려면 여기서 소각액을 확인해 주세요.', '폰에서 보낸 게임이 기다려요. 지갑을 열면 바로 올려요.', '확인하러 가기', '폰에서 보낸 게임이에요.', '폰에서 보낸 게임을 올리려면 지갑을 열어야 합니다.'])
    assert.match(copy, new RegExp(`"${k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}": \\["[^"]+", "[^"]+", "[^"]+"\\]`), k);
});
