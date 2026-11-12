// 「일반 판매자」 0 RVN 올리기 — 두 출처 목록 · 올리기 길(가짜 invoke: 노드·IPFS·릴레이·체인 없음, 던져 버리는 키만) · 문구 표.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { build } from 'esbuild';

const built = await build({ entryPoints: ['scripts/fixtures/arcade-entry.ts'], bundle: true, write: false, platform: 'node', format: 'cjs', logLevel: 'silent' });
const mod = { exports: {} };
new Function('require', 'exports', 'module', built.outputFiles[0].text)(createRequire(import.meta.url), mod.exports, mod);
const A = mod.exports;
const hex = b => Buffer.from(b).toString('hex');
const sha = s => A.sha256Hex(A.utf8(s));
const rvn = A.secp256k1.utils.randomPrivateKey(), seller = A.addressOfPublicKey(A.secp256k1.getPublicKey(rvn, true));
const nos = A.schnorr.utils.randomPrivateKey(), npub = hex(A.schnorr.getPublicKey(nos));
const files = [{ path: 'index.html', sha256: sha('i'), size: 100 }, { path: 'js/game.js', sha256: sha('g'), size: 200 }];
const wrap = content => { const u = { pubkey: npub, created_at: JSON.parse(content).at, kind: 31405, tags: A.arcadeListingTags(JSON.parse(content).seller, JSON.parse(content).id), content }; const id = A.nostrEventIdOf(u); return { ...u, id, sig: hex(A.schnorr.sign(Buffer.from(id, 'hex'), nos)) }; };

/** 가짜 데스크탑: 노드 signmessage = 시험 키 · IPFS = 바이트 보관 · 러스트 겉봉투 = 시험 Nostr 키. 부른 명령을 적는다. */
function fakeDesk({ signKey = rvn } = {}) {
  const calls = [], published = [], ipfs = {};
  const invoke = async (cmd, args = {}) => {
    calls.push(cmd);
    if (cmd === 'arcade_pin_folder') { assert.deepEqual(args.expect, files); return { cid: 'Qm' + 'F'.repeat(44), files: 2 }; }
    if (cmd === 'sign_message') { assert.equal(args.address, seller); return { signature: A.signMessageWithKeyForTest(args.message, signKey) }; }
    if (cmd === 'ipfs_add_file') { const cid = 'Qm' + 'D'.repeat(44); ipfs[cid] = Uint8Array.from(args.file.bytes); return { cid }; }
    if (cmd === 'arcade_listing_pubkey') return npub;
    if (cmd === 'arcade_listing_publish') { published.push(wrap(args.content)); return { published: 1 }; }
    throw new Error('unexpected command ' + cmd);
  };
  return { invoke, calls, published, ipfs };
}
const input = { files, id: 'star-run', version: 1, title: 'Star Run', description: '', priceSats: '50000000', seller, payTo: seller, entry: 'index.html', minutes: 3, genre: 'arcade' };

test('올리기 길: 폴더 → 문서 서명 → 문서 IPFS → 알림 쪽지(두 겹 서명) · 체인 명령은 하나도 없다(0 RVN)', async () => {
  const d = fakeDesk(), steps = [];
  const r = await A.runOpenUpload(d.invoke, input, s => steps.push(s));
  assert.deepEqual(d.calls, ['arcade_pin_folder', 'sign_message', 'ipfs_add_file', 'arcade_listing_pubkey', 'sign_message', 'arcade_listing_publish']);
  assert.deepEqual(steps, ['pin', 'sign', 'doc', 'listing', 'done']);
  for (const bad of ['issue_asset', 'reissue', 'arcade_pay', 'send', 'sendmany']) assert.ok(!d.calls.includes(bad), bad);
  const doc = A.verifyArcadeProduct(d.ipfs[r.docCid]);
  assert.equal(doc.doc.assetName, undefined, '일반 판매자 문서 = assetName 없음'); assert.equal(doc.doc.cid, 'Qm' + 'F'.repeat(44));
  const l = A.parseArcadeListingEvent(d.published[0], Math.floor(Date.now() / 1000));
  assert.ok(l && l.state === 'open' && l.docCid === r.docCid && l.docHash === doc.docHash && l.key === `${seller}/star-run`);
  // 그 결과가 곧바로 목록에 「일반 판매자」로(러스트 arcade_catalog_sources 답 모양)
  const got = A.productsFromSources({ assets: [], docs: {}, open: { events: d.published, docs: { [r.docCid]: Buffer.from(d.ipfs[r.docCid]).toString('base64') }, hidden: null } });
  assert.deepEqual(got.items.map(p => [p.title, p.verified, p.listing, p.docCid]), [['Star Run', false, 'open', r.docCid]]);
  assert.equal(A.gameUrl(got.items[0]), `https://ravenvault.ex.erci.se/arcade/ipfs/${r.docCid}/index.html`);
});

test('다른 주소로 서명되면 쪽지를 보내지 않는다 · 내리기 = removed 쪽지 · 고치기 = 더 높은 판', async () => {
  const other = A.secp256k1.utils.randomPrivateKey();
  const d = fakeDesk({ signKey: other });
  await assert.rejects(A.runOpenUpload(d.invoke, input), /signature/);
  assert.ok(!d.calls.includes('arcade_listing_publish') && !d.calls.includes('ipfs_add_file'), '문서 서명부터 막힌다');
  const ok = fakeDesk();
  const r1 = await A.runOpenUpload(ok.invoke, input);
  const r2 = await A.runOpenUpload(ok.invoke, { ...input, version: 2, priceSats: '0' });
  await A.publishListing(ok.invoke, { seller, id: 'star-run', version: 2, docCid: r2.docCid, docHash: r2.docHash, state: 'removed', at: r2.listing.at + 1 });
  const now = Math.floor(Date.now() / 1000) + 5;
  const pick = A.pickArcadeListings(ok.published, now);
  assert.equal(pick.length, 1); assert.equal(pick[0].state, 'removed');
  assert.ok(r1.docHash !== r2.docHash);
  const list = A.productsFromSources({ assets: [], open: { events: ok.published, docs: {} } });
  assert.equal(list.items.length, 0, '내린 게임은 목록에 없다');
});

test('두 출처: 확인 판매자 먼저 · 같은 게임은 확인 판매자 하나 · 숨김 목록은 일반만 · 내가 신고한 게임(hide)은 빠진다', async () => {
  const anchoredDoc = A.signArcadeProductForTest({ format: 'rv-arcade-product', v: 1, kind: 'arcade-game', id: 'block-drop', version: 1, title: 'Block Drop', description: '', priceSats: '0',
    seller, payTo: seller, feeBps: A.ARCADE_FEE_BPS, entry: 'index.html', cid: 'Qm' + 'W'.repeat(44), files, x: { arcade: { mode: 'solo', network: 'none', minutes: 3 } }, assetName: 'RVLT/PLAYX#BLOCK_DROP' }, rvn);
  const d = fakeDesk(); const r = await A.runOpenUpload(d.invoke, input);
  const raw = { assets: [{ name: 'RVLT/PLAYX#BLOCK_DROP', ipfsHash: 'Qm' + '1'.repeat(44) }], docs: { ['Qm' + '1'.repeat(44)]: Buffer.from(A.encodeArcadeProduct(anchoredDoc)).toString('base64') },
    open: { events: [...d.published, { junk: true }], docs: { [r.docCid]: Buffer.from(d.ipfs[r.docCid]).toString('base64') }, hidden: { format: 'rv-arcade-hidden', v: 1, games: [], sellers: [], docs: [] } } };
  assert.deepEqual(A.productsFromSources(raw).items.map(p => [p.title, p.listing]), [['Block Drop', 'verified'], ['Star Run', 'open']]);
  assert.deepEqual(A.productsFromSources(raw, { hide: [`${seller}/star-run`] }).items.map(p => p.title), ['Block Drop']);
  const hiddenAll = { ...raw, open: { ...raw.open, hidden: { format: 'rv-arcade-hidden', v: 1, sellers: [seller] } } };
  assert.deepEqual(A.productsFromSources(hiddenAll).items.map(p => p.listing), ['verified'], '숨김 목록은 확인 판매자를 숨기지 않는다');
});

test('화면 규칙: 「일반 판매자」 글 · 첫 결제 전 안내 · 신고는 report_send(counterparty) · 문구 표(장터+올리기) · 올리기 화면에 체인 명령은 확인 판매자 길에만', () => {
  const market = readFileSync('src/arcade-market.ts', 'utf8'), up = readFileSync('src/arcade-upload.ts', 'utf8'), open = readFileSync('src/arcade-open.ts', 'utf8');
  assert.ok(!market.includes('판매자 미확인'), '색만이 아니라 「일반 판매자」 글로');
  assert.match(market, /needsOpenNotice\(p, readKeys\(NOTICE_KEY\)\)/);
  assert.match(market, /"report_send"[\s\S]{0,300}category: "counterparty"/);
  assert.ok(!/issue_asset|reissue|sendmany/.test(open), '일반 판매자 길에 체인 명령 없음');
  const copy = readFileSync('src/arcade-copy.ts', 'utf8');
  const keys = new Set([...copy.matchAll(/^\s*"([^"]+)": \[/gm)].map(m => m[1]));
  const dict = readFileSync('src/dict.ts', 'utf8');
  for (const src of [market, up]) for (const m of src.matchAll(/(?:copyHtml|\bt|tf|row)\("([^"]*[가-힣][^"]*)"/g)) assert.ok(keys.has(m[1]) || dict.includes(JSON.stringify(m[1])), `번역 없음: ${m[1]}`);
  for (const k of ['사기·돈만 받고 안 됨', '나쁜 내용', '남의 게임을 베낌', '알림 쪽지를 공개 릴레이에 올리는 중…']) assert.ok(keys.has(k), k);
});

test('돕기 보관 후보(keep): 일반 판매자 게임도 mergeArcadeSources 를 통과하면 verified=false · listing=open · key 를 같이 넘긴다 · 숨김 목록이면 빠진다', async () => {
  const d = fakeDesk();
  const r = await A.runOpenUpload(d.invoke, input);
  const open = { events: d.published, docs: { [r.docCid]: Buffer.from(d.ipfs[r.docCid]).toString('base64') }, hidden: null };
  assert.deepEqual(A.shareCandidates({ assets: [], docs: {}, open }), [{ docCid: r.docCid, verified: false, listing: 'open', key: `${seller}/star-run` }]);
  const hidden = { format: 'rv-arcade-hidden', v: 1, updatedAt: '2026-11-13T00:00:00Z', games: [`${seller}/star-run`], sellers: [], docs: [] };
  assert.deepEqual(A.shareCandidates({ assets: [], docs: {}, open: { ...open, hidden } }), [], '숨긴 게임은 돕지 않는다');
  // 서명이 틀린 쪽지(겉봉투 바꿔치기)는 후보가 아니다
  const bad = { ...d.published[0], content: d.published[0].content.replace('"open"', '"open" ') };
  assert.deepEqual(A.shareCandidates({ assets: [], docs: {}, open: { ...open, events: [bad] } }), []);
});
