// 「게임 올리기」 규칙 · 「한 판 넣기」 통로(arcade-credit v1) — 순수 시험. 노드·IPFS·체인 없음, 던져 버리는 키만.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { build } from 'esbuild';

const built = await build({ entryPoints: ['scripts/fixtures/arcade-entry.ts'], bundle: true, write: false, platform: 'node', format: 'cjs', logLevel: 'silent' });
const mod = { exports: {} };
new Function('require', 'exports', 'module', built.outputFiles[0].text)(createRequire(import.meta.url), mod.exports, mod);
const A = mod.exports;
const sha = s => A.sha256Hex(A.utf8(s));
const scan = (over = {}) => A.scanOf({ folder: 'star', files: [{ path: 'index.html', sha256: sha('i'), size: 100 }, { path: 'js/game.js', sha256: sha('g'), size: 200 }],
  skipped: ['.DS_Store'], badNames: [], htmlTexts: { 'index.html': '<!doctype html><canvas></canvas><script src="js/game.js"></script>' }, ...over });

test('폴더 검사: 깨끗한 게임은 통과 · 시작 파일 후보는 index.html 먼저', () => {
  const s = scan();
  assert.deepEqual(A.entryCandidates(s.files), ['index.html']);
  const c = A.checkFolder(s, 'index.html');
  assert.deepEqual(c.problems, []); assert.equal(c.warnings.length, 1);
});

test('공유 사이트 게임 CSP 가 막을 것은 올리기 전에 막는다', () => {
  const bad = { 'index.html': '<script src="https://cdn.example.com/x.js"></script><script>alert(1)</script><button onclick="go()">x</button><iframe src="a.html"></iframe><img src="//evil/x.png">' };
  const codes = A.checkFolder(scan({ htmlTexts: bad }), 'index.html').problems.map(p => p.code);
  for (const c of ['external', 'inline-script', 'inline-handler', 'iframe']) assert.ok(codes.includes(c), c);
  // JSON 데이터 블록은 스크립트가 아니다
  assert.deepEqual(A.cspProblems('a.html', '<script type="application/json">{"a":1}</script>'), []);
});

test('한도: 파일 4MB(사이트) · 이름 규칙 · 시작 파일 없음', () => {
  const big = A.checkFolder(scan({ files: [{ path: 'index.html', sha256: sha('i'), size: 100 }, { path: 'a.bin', sha256: sha('a'), size: A.SITE_FILE_MAX + 1 }] }), 'index.html');
  assert.ok(big.problems.some(p => p.code === 'file-size'));
  assert.ok(A.checkFolder(scan({ badNames: ['내 그림.png'] }), 'index.html').problems.some(p => p.code === 'name'));
  assert.ok(A.checkFolder(scan({ files: [{ path: 'a.js', sha256: sha('a'), size: 1 }], htmlTexts: {} }), null).problems.some(p => p.code === 'entry'));
});

test('자산 이름 · 소각액 · 가게 찾기 · 값', () => {
  assert.deepEqual(A.targetName({ mode: 'new', shop: 'PLAYX', tag: 'STAR_RUN' }), { name: 'RVLT/PLAYX#STAR_RUN', burnRvn: 5, problems: [] });
  assert.equal(A.targetName({ mode: 'update', asset: 'RVLT/PLAYX/STAR' }).burnRvn, 100);
  assert.ok(A.targetName({ mode: 'update', asset: 'RVLT/PLAYX#STAR' }).problems.length > 0, '고유 자산은 재발행 불가');
  assert.ok(A.targetName({ mode: 'new', shop: 'PLAYX', tag: '' }).problems.length > 0);
  assert.deepEqual(A.sellerPlaces(['RVLT/PLAYX!', 'RVLT/PLAYX/STAR!', 'OTHER!', 'RVLT!']), { shops: ['PLAYX'], products: ['RVLT/PLAYX/STAR'] });
  assert.equal(A.atomsOfRvnText('0.5'), '50000000'); assert.equal(A.atomsOfRvnText('0'), '0'); assert.equal(A.atomsOfRvnText('1.123456789'), null); assert.equal(A.atomsOfRvnText('abc'), null);
  assert.equal(A.suggestTag('Star Run!'), 'STAR_RUN'); assert.equal(A.idFromTag('STAR_RUN'), 'star-run');
});

test('문서 만들기 → 노드 서명 자리(시험 키) → attachArcadeSignature → 체인 자산과 함께 목록에 확인 판매자로', () => {
  const key = A.secp256k1.utils.randomPrivateKey();
  const seller = A.addressOfPublicKey(A.secp256k1.getPublicKey(key, true));
  const s = scan();
  const body = A.buildBody({ id: 'star-run', version: 1, title: 'Star Run', description: '', priceSats: '50000000', seller, payTo: seller, entry: 'index.html',
    cid: A.PLACEHOLDER_CID, files: s.files, minutes: 3, genre: 'arcade', assetName: 'RVLT/PLAYX#STAR_RUN' });
  const sig = A.signArcadeProductForTest(body, key).sig; // 앱에서는 노드 signmessage(sign_message)가 같은 문구에 서명한다
  const v = A.attachArcadeSignature(body, sig);
  assert.equal(v.doc.seller, seller);
  assert.throws(() => A.attachArcadeSignature({ ...body, priceSats: '60000000' }, sig), /signature/);
  const docCid = 'Qm' + '2'.repeat(44);
  const r = A.productsFromSources({ assets: [{ name: 'RVLT/PLAYX#STAR_RUN', ipfsHash: docCid }], docs: { [docCid]: Buffer.from(A.encodeArcadeProduct(v.doc)).toString('base64') } });
  assert.equal(r.items.length, 1); assert.equal(r.items[0].verified, true); assert.equal(r.items[0].priceSats, 50_000_000);
  assert.throws(() => A.buildBody({ id: 'star-run', version: 1, title: 'x', description: '', priceSats: '50000000', seller, payTo: A.MARKET_FEE_ADDRESS, entry: 'index.html', cid: A.PLACEHOLDER_CID, files: s.files, minutes: 3, genre: 'arcade', assetName: 'RVLT/PLAYX#STAR_RUN' }));
});

test('한 판 넣기 v1: 정확한 모양만 · 빈도 제한 · 열린 판 하나만 · 미리 넣은 돈 없음', () => {
  assert.deepEqual(A.parseGameMessage({ type: 'rv-arcade', v: 1, ask: 'credit' }), { kind: 'ask' });
  const id = 'ab'.repeat(16);
  assert.deepEqual(A.parseGameMessage({ type: 'rv-arcade', v: 1, event: 'over', playId: id, score: 12 }), { kind: 'over', playId: id, score: 12 });
  for (const bad of [null, 'x', [], { type: 'rv-arcade', v: 2, ask: 'credit' }, { type: 'rv-arcade', v: 1, ask: 'credit', amount: 5 }, { type: 'rv-arcade', v: 1, ask: 'pay' },
    { type: 'rv-arcade', v: 1, event: 'over', playId: 'xyz' }, { type: 'rv-arcade', v: 1, event: 'over', playId: id, score: Infinity }, { type: 'rv-arcade', v: 1, credit: true, playId: id }])
    assert.equal(A.parseGameMessage(bad), null, JSON.stringify(bad));
  assert.deepEqual(A.creditMessage(id), { type: 'rv-arcade', v: 1, credit: true, playId: id });
  assert.deepEqual(A.denyMessage('declined'), { type: 'rv-arcade', v: 1, credit: false, reason: 'declined' });
  const g = A.creditGate();
  assert.equal(g.ask(0), 'ok'); assert.equal(g.ask(10), 'busy'); g.settle();
  assert.equal(g.ask(100), 'too-fast'); assert.equal(g.ask(2000), 'ok'); g.settle();
  g.grant(id); assert.equal(g.over('cd'.repeat(16)), false); assert.equal(g.over(id), true); assert.equal(g.openPlay, null);
  let t = 10_000; for (let i = 0; i < 10; i++) { t += 2000; g.ask(t); g.settle(); }
  assert.equal(g.ask(t + 2000), 'too-fast', '1분에 10번까지');
  assert.match(A.newPlayId(n => new Uint8Array(n).fill(7)), /^(07){16}$/);
  const src = readFileSync('core/creator/arcade-credit.ts', 'utf8');
  assert.doesNotMatch(src, /balance|localStorage|prepaid\s*=/, '잔액·저장 없음');
});
