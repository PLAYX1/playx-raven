// 11-27 「라비가 다 해 줄게요」 순수 시험 — 이름·장르 짐작 · 빈 그림 알아보기 · 표지/미리보기 길 · 「첫 판 무료」 알약. 노드·IPFS·화면 없음.
//   실행: node --test scripts/arcade-maker.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { build } from 'esbuild';

// i18n.ts 는 브라우저 값을 읽는다 — 한국어로 고정한 가짜(시험 안에서만).
globalThis.localStorage = { getItem: () => 'ko', setItem() {}, removeItem() {} };
if (!globalThis.navigator) Object.defineProperty(globalThis, 'navigator', { value: { language: 'ko-KR' }, configurable: true });
const built = await build({ entryPoints: ['scripts/fixtures/arcade-maker-entry.ts'], bundle: true, write: false, platform: 'node', format: 'cjs', logLevel: 'silent', loader: { '.css': 'empty' } });
const mod = { exports: {} };
new Function('require', 'exports', 'module', built.outputFiles[0].text)(createRequire(import.meta.url), mod.exports, mod);
const M = mod.exports;

const cid = 'Qm' + 'A'.repeat(44);
const doc = (paths, extra = {}) => ({ files: paths.map((path) => ({ path, sha256: '0'.repeat(64), size: 1 })), ...extra });

test('미리보기 영상 길: 맨 위 preview.mp4 먼저 · webm · 잠긴 파일·하위 폴더·이상한 CID 는 null · 표지 규칙은 그대로', () => {
  assert.equal(M.previewUrl({ docCid: cid, doc: doc(['preview.webm', 'preview.mp4', 'index.html']) }), `${M.ARCADE_LINK_BASE}${cid}/preview.mp4`);
  assert.equal(M.previewUrl({ docCid: cid, doc: doc(['preview.webm']) }), `${M.ARCADE_LINK_BASE}${cid}/preview.webm`);
  assert.equal(M.previewUrl({ docCid: cid, doc: doc(['index.html']) }), null);
  assert.equal(M.previewUrl({ docCid: cid, doc: doc(['media/preview.mp4']) }), null, '맨 위 폴더만');
  assert.equal(M.previewUrl({ docCid: cid, doc: doc(['preview.mp4'], { lock: { paths: ['preview.mp4'] } }) }), null, '잠긴 파일은 안 보인다');
  assert.equal(M.previewUrl({ docCid: cid, doc: doc(['preview.mp4', 'preview.webm'], { lock: { paths: ['preview.mp4'] } }) }), `${M.ARCADE_LINK_BASE}${cid}/preview.webm`);
  assert.equal(M.previewUrl({ docCid: '../x', doc: doc(['preview.mp4']) }), null);
  assert.equal(M.previewUrl({ docCid: cid, doc: {} }), null);
  assert.equal(M.coverUrl({ docCid: cid, doc: doc(['cover.jpg']) }), `${M.ARCADE_LINK_BASE}${cid}/cover.jpg`);
  assert.equal(M.coverUrl({ docCid: cid, doc: doc(['cover.jpg', 'cover.png']) }), `${M.ARCADE_LINK_BASE}${cid}/cover.png`, '판매자 png 가 라비 jpg 보다 먼저');
  assert.deepEqual([...M.PREVIEW_FILES], ['preview.mp4', 'preview.webm']);
});

const product = (over = {}) => ({
  id: 'R1:star', title: 'Star', description: '', priceSats: 50_000_000, sellerName: 'R1…', sellerAddress: 'R1', verified: false, listing: 'open',
  minutes: 3, genre: 'arcade', docCid: cid, entry: 'index.html', locked: false,
  doc: { priceSats: '50000000', files: [], x: { arcade: { mode: 'solo', network: 'none', minutes: 3, firstFree: true } } }, ...over,
});

test('「첫 판 무료」 알약: 유료 + firstFree 일 때만 카드·페이지에 · 무료·끔·틀린 문서면 없음', () => {
  assert.equal(M.firstFreeOf(product()), true);
  assert.match(M.cardHtml(product()), /class="ar-ff"><span data-desktop-copy="첫 판 무료">첫 판 무료</);
  assert.equal(M.firstFreeOf(product({ doc: { priceSats: '0', files: [], x: { arcade: { firstFree: true } } } })), false, '무료 게임은 뜻이 없다');
  assert.equal(M.firstFreeOf(product({ doc: { priceSats: '1', files: [], x: { arcade: {} } } })), false);
  assert.equal(M.firstFreeOf(product({ doc: {} })), false, '틀린 문서는 거짓(던지지 않는다)');
  assert.doesNotMatch(M.cardHtml(product({ doc: { priceSats: '1', files: [], x: { arcade: {} } } })), /ar-ff/);
  // 카드는 영상을 틀지 않는다 · 페이지만 영상(표지 위)
  const withPv = product({ doc: { priceSats: '1', files: [{ path: 'cover.jpg' }, { path: 'preview.mp4' }], x: { arcade: {} } } });
  assert.doesNotMatch(M.cardHtml(withPv), /<video/);
  const hero = M.heroHtml(withPv);
  assert.match(hero, /<img class="ar-cover-img" src="[^"]+\/cover\.jpg"/);
  assert.match(hero, /<video class="ar-hero-video" data-ar-preview="1" muted loop playsinline autoplay preload="metadata" poster="[^"]+\/cover\.jpg" src="[^"]+\/preview\.mp4"/);
  assert.doesNotMatch(M.heroHtml(product()), /<video/, '영상 없으면 표지만');
});

test('이름 짐작: <title> → 폴더 이름(앞 번호 칸은 뺀다) · 엔티티 · 80자', () => {
  const scan = (folder, html) => ({ folder, files: [], htmlTexts: html == null ? {} : { 'index.html': html } });
  assert.equal(M.guessTitle(scan('land-grab', '<title>보라 주황 땅따먹기</title>'), 'index.html'), '보라 주황 땅따먹기');
  assert.equal(M.guessTitle(scan('land-grab', '<title> Tom &amp; Jerry&#39;s </title>'), 'index.html'), "Tom & Jerry's");
  assert.equal(M.guessTitle(scan('land-grab', '<title></title>'), 'index.html'), 'Land Grab');
  assert.equal(M.guessTitle(scan('game-7-beat-tap'), 'index.html'), 'Beat Tap');
  assert.equal(M.prettifyFolder('core_break'), 'Core Break');
  assert.equal(M.prettifyFolder('2048'), '2048', '번호만이면 그대로');
  assert.equal(M.prettifyFolder('별빛-달리기'), '별빛 달리기');
  assert.equal([...M.titleFromHtml(`<title>${'가'.repeat(200)}</title>`)].length, 80);
});

test('장르 짐작: 이름·폴더가 먼저 · 소리 파일 이름은 무시 · 모르면 null(지금 값 그대로)', () => {
  const s = (folder, paths = []) => ({ folder, files: paths.map((path) => ({ path, sha256: '', size: 1 })) });
  assert.equal(M.guessGenre(s('game-7-beat-tap'), 'Beat Tap'), 'rhythm');
  assert.equal(M.guessGenre(s('kart'), ''), 'racing');
  assert.equal(M.guessGenre(s('x'), '스페이스 슈팅'), 'shooting');
  assert.equal(M.guessGenre(s('game-5-coin-slice'), 'Coin Slice'), 'action');
  assert.equal(M.guessGenre(s('land-grab', ['index.html', 'music.js', 'rv-kit.js', 'rv-arcade-bridge.js']), '보라 주황 땅따먹기'), null, 'music.js 로 리듬이라 하지 않는다');
  assert.equal(M.guessGenre(s('mygame', ['js/tetris.js']), ''), 'puzzle', '파일 이름도 약하게 본다');
  assert.equal(M.guessGenre(s('scar'), 'Oscar'), null, '낱말 경계(car ≠ Oscar)');
});

test('빈 그림 알아보기: 한 색·투명 = 빈 것 · 그림·글자가 있으면 아님', () => {
  const W = 64, H = 36;
  const fill = (r, g, b, a = 255) => { const d = new Uint8ClampedArray(W * H * 4); for (let i = 0; i < W * H; i++) d.set([r, g, b, a], i * 4); return d; };
  assert.equal(M.isBlankImage(fill(0, 0, 0), W, H), true, '검은 화면');
  assert.equal(M.isBlankImage(fill(14, 13, 38), W, H), true, '배경색 한 가지');
  assert.equal(M.isBlankImage(fill(0, 0, 0, 0), W, H), true, '투명(WebGL 비운 버퍼)');
  const noisy = fill(14, 13, 38); for (let i = 0; i < W * H; i += 3) noisy.set([200, 120, 40, 255], i * 4);
  assert.equal(M.isBlankImage(noisy, W, H), false, '그림이 있다');
  const box = fill(14, 13, 38); for (let y = 10; y < 26; y++) for (let x = 20; x < 44; x++) box.set([240, 140, 60, 255], (y * W + x) * 4);
  assert.equal(M.isBlankImage(box, W, H), false, '가운데 네모 하나도 그림이다');
  const tiny = fill(14, 13, 38); tiny.set([15, 14, 39, 255], 0); tiny.set([16, 13, 37, 255], 8);
  assert.equal(M.isBlankImage(tiny, W, H), true, '압축 잡티 정도는 빈 것');
  assert.equal(M.isBlankImage(new Uint8ClampedArray(0), 0, 0), true);
});

test('표지·미리보기 파일 이름 · 첫 바이트 모양 · 판매자 파일 알아보기', () => {
  assert.equal(M.ownCoverOf([{ path: 'index.html' }, { path: 'cover.webp' }]), 'cover.webp');
  assert.equal(M.ownCoverOf([{ path: 'img/cover.png' }]), null);
  assert.equal(M.ownPreviewOf([{ path: 'preview.webm' }]), 'preview.webm');
  assert.equal(M.previewNameFor('video/mp4;codecs=avc1'), 'preview.mp4');
  assert.equal(M.previewNameFor('video/webm'), 'preview.webm');
  assert.equal(M.previewNameFor('video/x-matroska'), null);
  assert.equal(M.bytesLookLike('cover.jpg', Uint8Array.of(0xff, 0xd8, 0xff, 0xe0)), true);
  assert.equal(M.bytesLookLike('cover.jpg', Uint8Array.of(0x89, 0x50, 0x4e, 0x47)), false);
  assert.equal(M.bytesLookLike('preview.mp4', Uint8Array.of(0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69)), true);
  assert.equal(M.bytesLookLike('preview.webm', Uint8Array.of(0x1a, 0x45, 0xdf, 0xa3, 1)), true);
  assert.equal(M.bytesLookLike('index.html', Uint8Array.of(0xff, 0xd8, 0xff, 0xe0)), false);
  assert.equal(M.DESC_TEMPLATE, '{0} — {1} 게임이에요. 한 판 약 {2}분.');
});

test('「첫 판 무료」 는 유료 게임 문서에만 들어간다(buildBody)', () => {
  const addr = M.addressOfPublicKey(M.secp256k1.getPublicKey(M.secp256k1.utils.randomPrivateKey(), true));
  const base = { id: 'star-run', version: 1, title: 'Star', description: '', seller: addr, payTo: addr, entry: 'index.html',
    cid: M.PLACEHOLDER_CID, files: [{ path: 'index.html', sha256: 'a'.repeat(64), size: 1 }], minutes: 3, genre: 'arcade', assetName: '' };
  assert.equal(M.buildBody({ ...base, priceSats: '50000000', firstFree: true }).x.arcade.firstFree, true);
  assert.equal('firstFree' in M.buildBody({ ...base, priceSats: '50000000', firstFree: false }).x.arcade, false);
  assert.equal('firstFree' in M.buildBody({ ...base, priceSats: '0', firstFree: true }).x.arcade, false, '무료 게임에는 두지 않는다');
});

test('화면 규칙: 올리기 화면에 「첫 판 무료」 칸(기본 켬)·runOpenUpload 로 넘김 · 라비 iframe 은 sandbox allow-scripts 만 · 메시지는 그 iframe 에서만', () => {
  const up = readFileSync('src/arcade-upload.ts', 'utf8');
  assert.match(up, /data-up-ff="1" checked/);
  assert.match(up, /runOpenUpload\(deps\.invoke, \{[^}]*firstFree \}/);
  assert.match(up, /assetName: tn\.name, firstFree \}\);/);
  const mk = readFileSync('src/arcade-maker.ts', 'utf8');
  assert.match(mk, /frame\.setAttribute\("sandbox", "allow-scripts"\)/);
  assert.doesNotMatch(mk, /allow-same-origin|allow-popups|allow-top-navigation|allow-forms/);
  assert.match(mk, /if \(e\.source !== frame\.contentWindow \|\| e\.origin !== "null"\) return;/);
  assert.doesNotMatch(mk, /data-up-go|runOpenUpload|issue_asset|arcade_pin_folder/, '라비는 올리지 않는다');
  const csp = JSON.parse(readFileSync('src-tauri/tauri.conf.json', 'utf8')).app.security.csp['frame-src'].split(' ');
  assert.ok(csp.includes('http://127.0.0.1:8791/arcade-preview/'), '미리보기 칸 길만 frame-src 에');
  assert.ok(!csp.includes('http://127.0.0.1:8791'), '포트 전체를 열지 않는다');
  // 새 한국어 문구는 영·일·중 번역이 있다
  const copy = readFileSync('src/arcade-copy.ts', 'utf8');
  const keys = new Set([...copy.matchAll(/^\s*"([^"]+)": \[/gm)].map((m) => m[1]));
  for (const k of [...mk.matchAll(/(?:copyHtml|\bt|tf)\("([^"]*[가-힣][^"]*)"/g)].map((m) => m[1])) assert.ok(keys.has(k), `번역 없음: ${k}`);
  for (const k of ['첫 판 무료', '첫 판 무료 (사는 사람이 먼저 한 판 해 봐요)', '이름', '표지', '미리보기', '설명', '{0} — {1} 게임이에요. 한 판 약 {2}분.']) assert.ok(keys.has(k), k);
});
