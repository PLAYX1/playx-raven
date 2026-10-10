// Drop-to-publish in real Chrome (production dist, synthetic fixture, MOCK chain only — nothing reaches a node, IPFS daemon or network).
// Covers: HTML5 drag-and-drop with DataTransfer (window-wide veil), click selection (file input), the desktop path (Tauri
// `drop-files` event → creator_dropped_list/read), IPFS address paste (manifest → issue only; file → product; dead CID refused),
// keyboard-only flow, safety locks (taken / unknown name, mainnet), template × theme rendering (trust strip always on top,
// text never parsed as HTML), and a layout matrix: widths 320·390·768·1024·1440 × light/dark × ko·de·ru·pseudo +60%·+100%
// (no horizontal overflow, no clipped text, no overlapping controls, hit targets ≥ 44px, text contrast ≥ 4.5:1).
// Screenshots go to RV_DROP_SHOTS (the gallery uses them). Keys are throwaway.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { resolve, join, extname, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { build } from 'esbuild';
import zlib from 'node:zlib';
import puppeteer from 'puppeteer-core';
import { installFixture } from './desktop-fixture.mjs';

const root = resolve(import.meta.dirname, '..');
const built = await build({ entryPoints: [join(root, 'scripts/fixtures/drop-entry.ts')], bundle: true, write: false, platform: 'node', format: 'cjs', logLevel: 'silent' });
const D = { exports: {} };
new Function('require', 'exports', 'module', built.outputFiles[0].text)(createRequire(import.meta.url), D.exports, D);
const C = D.exports;
const uiBundle = (await build({ stdin: { contents: "import { wireDropPublish } from './src/drop-publish.ts'; import { renderStorefront, TEMPLATE_IDS, THEME_IDS } from './src/drop-look.ts'; Object.assign(window, { __wireDropPublish: wireDropPublish, __renderStorefront: renderStorefront, __TEMPLATE_IDS: TEMPLATE_IDS, __THEME_IDS: THEME_IDS });", resolveDir: root, loader: 'ts' },
  bundle: true, write: false, platform: 'browser', format: 'iife', logLevel: 'silent' })).outputFiles[0].text;
const KEY = C.randomKey(), ADDRESS = C.addressOf(KEY);

const enc = s => new TextEncoder().encode(s);
const PNG = n => Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 73, 72, 68, 82, n]);
const PDF = s => enc(`%PDF-1.7\n${s}\n%%EOF`);
const EPUB = () => { const h = new Uint8Array(30); h.set([0x50, 0x4b, 0x03, 0x04]); return Uint8Array.from([...h, ...enc('mimetypeapplication/epub+zip rest')]); };
const MP3 = n => Uint8Array.from([0x49, 0x44, 0x33, 3, 0, 0, 0, 0, 0, 0, 0xff, 0xfb, 0x90, 0x64, n]);
const ALBUM = [
  { name: '01 - 숲의 노래.mp3', type: 'audio/mpeg', bytes: MP3(1) }, { name: '02 - 바다.mp3', type: 'audio/mpeg', bytes: MP3(2) },
  { name: '03 - 하늘.mp3', type: 'audio/mpeg', bytes: MP3(3) }, { name: 'cover.png', type: 'image/png', bytes: PNG(4) },
];
/** A real (decodable) 96×96 PNG so screenshots show a cover, not a broken image. */
function realPng(r, g, b) {
  const { deflateSync, crc32 } = zlib;
  const w = 96, h = 96, raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const o = y * (w * 3 + 1) + 1 + x * 3, t = (x + y) / (w + h); raw[o] = r * (1 - t) + 40 * t; raw[o + 1] = g * (1 - t) + 30 * t; raw[o + 2] = b * (1 - t) + 90 * t; }
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td)); return Buffer.concat([len, td, crc]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return new Uint8Array(Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]));
}
ALBUM[3] = { name: 'cover.png', type: 'image/png', bytes: realPng(226, 112, 42) };
const BOOK = [{ name: 'sea.epub', type: 'application/epub+zip', bytes: EPUB() }, { name: 'sea-sample.pdf', type: 'application/pdf', bytes: PDF('p') }, { name: 'cover.png', type: 'image/png', bytes: realPng(40, 110, 160) }];
const b64 = u8 => Buffer.from(u8).toString('base64');

let work, dist, browser, server, origin, shotDir, fileDir;
before(async () => {
  work = mkdtempSync(join(tmpdir(), 'rv-drop-ui-'));
  shotDir = process.env.RV_DROP_SHOTS || join(work, 'shots'); mkdirSync(shotDir, { recursive: true });
  fileDir = join(work, 'files'); mkdirSync(fileDir);
  for (const f of BOOK) writeFileSync(join(fileDir, f.name), f.bytes);
  dist = join(work, 'dist');
  execFileSync(process.execPath, [resolve(root, 'node_modules/vite/bin/vite.js'), 'build', '--outDir', dist, '--emptyOutDir', '--logLevel', 'error'], { cwd: root, stdio: ['ignore', 'ignore', 'inherit'] });
  const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.jpg': 'image/jpeg', '.webp': 'image/webp' };
  server = createServer(async (req, res) => {
    try {
      const path = resolve(dist, '.' + decodeURIComponent(new URL(req.url, 'http://x').pathname));
      if (path !== dist && !path.startsWith(dist + sep)) throw Error('path');
      const file = path === dist ? join(dist, 'index.html') : path;
      if (!(await stat(file)).isFile()) throw Error('file');
      res.writeHead(200, { 'Content-Type': types[extname(file)] || 'application/octet-stream' }); res.end(await readFile(file));
    } catch { res.writeHead(404); res.end(); }
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  origin = `http://127.0.0.1:${server.address().port}`;
  browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true, userDataDir: join(work, 'profile'), args: ['--no-first-run', '--disable-background-networking'] });
});
after(async () => { await browser?.close(); server?.close(); if (work && !process.env.RV_KEEP_WORK) rmSync(work, { recursive: true, force: true }); });

/** Harness answers for drop-publish commands; everything else falls through to the shared fixture. */
function installDropHarness({ chain, balance, taken, nameUnknown, cidStore, fakeFs }) {
  const base = window.__TAURI_INTERNALS__.invoke;
  const calls = window.__dropCalls = [];
  const pinned = window.__pinned = new Map(Object.entries(cidStore ?? {}));
  window.__events = {};
  const wrap = async (cmd, args) => {
    if (cmd === 'plugin:event|listen') { window.__events[args.event] = args.handler; return base(cmd, args); }
    if (cmd === 'ipfs_add_file') { calls.push({ cmd, name: args.file.name }); const cid = await window.__mockCid(args.file.bytes); pinned.set(cid, await window.__b64(args.file.bytes)); return { cid, name: args.file.name, size: args.file.bytes.length }; }
    if (cmd === 'cid_alive') { calls.push({ cmd, cid: args.cid }); return pinned.has(args.cid); }
    if (cmd === 'creator_cid_read') { calls.push({ cmd, cid: args.cid }); if (!pinned.has(args.cid)) throw new Error('이 CID 를 지금 받을 수 없어요.'); return { size: 0, data: pinned.get(args.cid) }; }
    if (cmd === 'creator_dropped_list') { calls.push({ cmd, path: args.path }); const e = fakeFs?.[args.path]; if (!e) throw new Error('방금 창에 놓은 파일·폴더만 읽을 수 있어요.'); return { folder: e.folder, name: args.path.split('/').pop(), files: e.files.map(f => ({ rel: f.rel, size: 1 })), skipped: 0 }; }
    if (cmd === 'creator_dropped_read') { calls.push({ cmd, rel: args.rel }); const f = fakeFs?.[args.root]?.files.find(x => x.rel === args.rel); if (!f) throw new Error('파일을 찾지 못했어요.'); return { size: 1, data: f.data }; }
    if (cmd === 'sign_message') { calls.push({ cmd }); return { address: args.address, message: args.message, signature: await window.__testSign(args.address, args.message) }; }
    if (cmd === 'name_taken') { calls.push({ cmd, name: args.name }); if (nameUnknown && !window.__nameKnown) throw new Error('노드가 응답하지 않아요(시험)'); return (taken ?? []).includes(args.name); }
    if (cmd === 'node_status') { const s = await base(cmd, args); return { ...s, chain }; }
    if (cmd === 'wallet_balance') return { confirmed: balance, unconfirmed: 0 };
    if (cmd === 'issue_asset') { calls.push({ cmd, args }); return { txid: 'cd'.repeat(32), owner_token: args.name + '!' }; }
    if (cmd === 'new_address') return window.__testAddress;
    return base(cmd, args);
  };
  window.__TAURI_INTERNALS__.invoke = wrap; window.__TAURI__.core.invoke = wrap;
}

async function openDrop({ width = 1440, height = 900, theme = 'light', chain = 'regtest', balance = 600, taken = [], nameUnknown = false, cidStore = {}, fakeFs = null, reduced = true } = {}) {
  const page = await browser.newPage();
  page.on('pageerror', e => { page.__errors = [...(page.__errors ?? []), e.message]; });
  await page.setViewport({ width, height });
  await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: theme }, { name: 'prefers-reduced-motion', value: reduced ? 'reduce' : 'no-preference' }]);
  await page.setRequestInterception(true);
  page.on('request', r => (new URL(r.url()).origin === origin && r.method() === 'GET') || r.url().startsWith('blob:') || r.url().startsWith('data:') ? r.continue() : r.abort());
  await page.exposeFunction('__mockCid', bytes => C.mockCid(Uint8Array.from(bytes)));
  await page.exposeFunction('__b64', bytes => b64(Uint8Array.from(bytes)));
  await page.exposeFunction('__testSign', (address, message) => { if (address !== ADDRESS) throw Error('wrong address'); return C.signMessageForTest(message, KEY); });
  await page.evaluateOnNewDocument(installFixture, { theme, sales: true, seller: true });
  await page.evaluateOnNewDocument(installDropHarness, { chain, balance, taken, nameUnknown, cidStore, fakeFs });
  await page.evaluateOnNewDocument(a => { window.__testAddress = a; }, ADDRESS);
  await page.goto(origin + '/', { waitUntil: 'networkidle0' });
  await page.waitForFunction(() => document.querySelector('#page-home.on') && !document.documentElement.hasAttribute('data-ravi-arriving'), { timeout: 20000 });
  await page.evaluate(() => document.querySelector('nav')?.classList.add('more-open'));
  await page.click('nav a[data-page="games"]');
  await page.waitForFunction(() => document.querySelector('#page-games.on'));
  await page.click('#creator-open');
  await page.waitForFunction(() => document.querySelector('#page-creator.on') && document.querySelector('#dp'));
  return page;
}
const state = page => page.$eval('#dp', e => e.dataset.state);
const txt = (page, sel) => page.$eval(sel, e => e.tagName === 'TEXTAREA' ? e.value : e.textContent.replace(/\s+/g, ' ').trim());
const waitState = (page, s, timeout = 15000) => page.waitForFunction(w => document.querySelector('#dp')?.dataset.state === w || (Array.isArray(w) && w.includes(document.querySelector('#dp')?.dataset.state)), { timeout }, s);
async function htmlDrop(page, files, { target = 'body', folder = false } = {}) {
  return page.evaluate(async (list, target) => {
    const dt = new DataTransfer();
    for (const f of list) dt.items.add(new File([Uint8Array.from(f.bytes)], f.name, { type: f.type }));
    const el = document.querySelector(target);
    el.dispatchEvent(new DragEvent('dragenter', { dataTransfer: dt, bubbles: true, cancelable: true }));
    el.dispatchEvent(new DragEvent('dragover', { dataTransfer: dt, bubbles: true, cancelable: true }));
    const veil = document.querySelector('#dp-veil').classList.contains('on');
    const veilText = document.querySelector('#dp-veil').textContent;
    el.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
    return { veil, veilText };
  }, files.map(f => ({ name: f.name, type: f.type, bytes: Array.from(f.bytes) })), target);
}
const waitPublishable = page => page.waitForFunction(() => { const b = document.querySelector('#dp-publish'); return b && !b.disabled; }, { timeout: 15000 });

async function publishFlow(page) {
  await waitPublishable(page);
  await page.click('#dp-publish');
  await page.waitForFunction(() => document.querySelector('#dp-confirm')?.open);
  await page.click('#dp-confirm-go');
  await waitState(page, 'done', 20000);
}

test('drag & drop anywhere: veil appears, album detected (EP, cover, track order), preview → one confirm → mock issue', { timeout: 180_000 }, async () => {
  const page = await openDrop();
  assert.equal(await state(page), 'idle');
  assert.match(await txt(page, '#dp-zone'), /여기에 놓으면 상품이 만들어져요/);
  const r = await htmlDrop(page, ALBUM, { target: '.app, body' });
  assert.equal(r.veil, true, 'window-wide drop veil shows while dragging'); assert.match(r.veilText, /여기에 놓으면 상품이 만들어져요/);
  await waitState(page, ['preview', 'blocked']);
  assert.equal(await page.$eval('#dp-veil', v => v.classList.contains('on')), false, 'veil hides after drop');
  assert.equal(await page.$eval('#dp-card', c => c.dataset.template), 'album');
  assert.match(await txt(page, '#dp-card'), /보증 · 미검증.*음악 · EP.*15 RVN.*RV\.M\..*숲의 노래.*바다.*하늘/);
  assert.equal(await page.$eval('#dp-card', c => c.firstElementChild.classList.contains('rvs-trust')), true, 'trust strip first');
  assert.match(await txt(page, '#dp-cost'), /보증\(소각\) 500 RVN.*네트워크 수수료 약 0\.01 RVN.*15%\(초안\)/);
  await waitPublishable(page);
  assert.match(await txt(page, '#dp-chips'), /파일 4개 모두 통과/);
  assert.match(await txt(page, '#dp-chips'), /소각액 500 RVN — 체인과 대조 확인 불가/);
  await page.click('#dp-publish');
  await page.waitForFunction(() => document.querySelector('#dp-confirm')?.open);
  assert.match(await txt(page, '#dp-confirm'), /되돌릴 수 없어요.*RV\.M\..*보증\(소각\) 500 RVN.*영영 돌아오지 않아요.*영구예요/);
  assert.equal(await page.evaluate(() => document.activeElement?.id), 'dp-confirm-cancel', 'focus starts on the safe choice');
  await page.click('#dp-confirm-cancel');
  await waitState(page, ['preview', 'blocked']);
  assert.equal((await page.evaluate(() => window.__dropCalls)).filter(c => c.cmd === 'ipfs_add_file').length, 0, 'nothing uploaded before confirming');
  await publishFlow(page);
  const calls = await page.evaluate(() => window.__dropCalls);
  const adds = calls.filter(c => c.cmd === 'ipfs_add_file').map(c => c.name);
  assert.equal(adds.length, 5, `3 tracks + cover + manifest: ${adds}`); assert.equal(adds.at(-1), 'manifest.json');
  const issued = calls.filter(c => c.cmd === 'issue_asset').map(c => c.args);
  assert.equal(issued.length, 1); assert.match(issued[0].name, /^RV\.M\.[A-Z0-9_]+$/); assert.deepEqual([issued[0].qty, issued[0].units, issued[0].reissuable], [1, 0, true]);
  const manifestB64 = await page.evaluate(cid => window.__pinned.get(cid), issued[0].ipfsHash);
  const v = C.verifyManifest(Buffer.from(manifestB64, 'base64'), { expectedAsset: issued[0].name });
  assert.equal(v.signedBy, ADDRESS); assert.deepEqual(v.manifest.files.map(f => f.path).length, 3);
  assert.equal(v.manifest.details.previewFile, v.manifest.files[0].path, 'preview = first track');
  assert.match(await txt(page, '#dp-done-h'), /발행했어요/);
  assert.equal(await page.evaluate(() => localStorage.getItem('rv-drop-draft-v1')), null, 'draft cleared');
  assert.ok(JSON.parse(await page.evaluate(() => localStorage.getItem('rv-creator-mine-v1'))).some(m => m.asset === issued[0].name), 'shared 「내 상품」 list');
  assert.deepEqual(await page.evaluate(() => window.__homeFixture.forbidden), []);
  assert.deepEqual(page.__errors ?? [], []);
  await page.close();
});

test('click to choose (file input) = same result; book detected; 「자세히」 hands the same files to the 9-step wizard', { timeout: 120_000 }, async () => {
  const page = await openDrop();
  const input = await page.$('#dp-files');
  await input.uploadFile(...BOOK.map(f => join(fileDir, f.name)));
  await waitState(page, ['preview', 'blocked']);
  assert.equal(await page.$eval('#dp-card', c => c.dataset.template), 'book');
  assert.match(await txt(page, '#dp-card'), /책.*20 RVN.*RV\.B\..*EPUB.*미리보기 10쪽/);
  await page.click('#dp-detail');
  await page.waitForFunction(() => document.querySelector('#page-creator').dataset.mode === 'wizard' && !document.querySelector('.cw-panel[data-step="3"]').hidden);
  assert.equal(await page.$eval('#cw-book-file', s => s.value), 'sea.epub'); assert.equal(await page.$eval('#cw-book-preview', s => s.value), 'sea-sample.pdf');
  assert.match(await page.$eval('#cw-asset', e => e.value), /^[A-Z0-9_]+$/);
  await page.click('#dp-to-drop');
  await page.waitForFunction(() => document.querySelector('#page-creator').dataset.mode === 'drop');
  await page.close();
});

test('desktop path: Tauri drop-files event with a folder → creator_dropped_list/read → game detected (index.html), runs-code warning', { timeout: 120_000 }, async () => {
  const fakeFs = { '/drop/StarRun': { folder: true, files: [
    { rel: 'index.html', data: b64(enc('<!doctype html><script src="game.js"></script>')) }, { rel: 'game.js', data: b64(enc('console.log(1)')) }, { rel: 'img/shot.png', data: b64(PNG(5)) }] } };
  const page = await openDrop({ fakeFs });
  const id = await page.evaluate(() => window.__events['drop-files']);
  assert.ok(id, 'main.ts listens to drop-files');
  await page.evaluate(id => window.__TAURI_INTERNALS__.runCallback(id, { event: 'drop-files', id: 1, payload: { paths: ['/drop/StarRun'] } }), id);
  await waitState(page, ['preview', 'blocked']);
  assert.equal(await page.$eval('#dp-card', c => c.dataset.template), 'gallery');
  assert.match(await txt(page, '#dp-card'), /게임.*StarRun|StarRun.*게임/);
  assert.match(await txt(page, '#dp-chips'), /코드를 실행|검증 전에는/);
  const calls = await page.evaluate(() => window.__dropCalls);
  assert.deepEqual(calls.filter(c => c.cmd === 'creator_dropped_read').map(c => c.rel).sort(), ['game.js', 'img/shot.png', 'index.html']);
  await page.close();
});

test('IPFS address paste: dead CID refused; a manifest CID goes straight to issue (no re-upload); a file CID becomes a product', { timeout: 180_000 }, async () => {
  // A manifest made beforehand (mock pin) — the paste must verify it and only issue.
  const pin = new C.MockPinAdapter();
  const r = await C.publishContent({ type: 'book', asset: 'RV.B.SEA_PASTE', title: 'Pasted Book', description: '', files: [{ path: 'sea.pdf', bytes: PDF('x'), mime: 'application/pdf' }],
    creatorAddress: ADDRESS, receivingAddress: ADDRESS, priceAtoms: '1000000000', declaredFeeBps: 1500, details: { bookFile: 'sea.pdf', format: 'pdf', previewFile: null, previewPages: 0, pageCount: null }, now: new Date() },
  pin, async (_a, m) => C.signMessageForTest(m, KEY));
  const cidStore = Object.fromEntries([...pin.stored].map(([c, b]) => [c, b64(b)]));
  const pngCid = C.mockCid(PNG(8)); cidStore[pngCid] = b64(PNG(8));
  const page = await openDrop({ cidStore });
  await page.type('#dp-cid', 'ipfs://Qm' + 'Z'.repeat(44)); await page.keyboard.press('Enter');
  await page.waitForFunction(() => /지금 받을 수 없어요/.test(document.querySelector('#dp-error').textContent));
  assert.equal(await state(page), 'idle');
  await page.$eval('#dp-cid', e => { e.value = ''; });
  await page.type('#dp-cid', `ipfs://${r.manifestCid}`); await page.keyboard.press('Enter');
  await waitState(page, ['preview', 'blocked']);
  assert.match(await txt(page, '#dp-stage'), /파일은 이미 다 올렸어요/);
  assert.match(await txt(page, '#dp-card'), /Pasted Book.*RV\.B\.SEA_PASTE/);
  await page.waitForFunction(() => !/확인 중/.test(document.querySelector('#dp-chips').textContent));
  await publishFlow(page);
  const calls = await page.evaluate(() => window.__dropCalls);
  assert.equal(calls.filter(c => c.cmd === 'ipfs_add_file').length, 0, 'nothing re-uploaded'); assert.equal(calls.filter(c => c.cmd === 'sign_message').length, 0, 'not re-signed');
  assert.equal(calls.find(c => c.cmd === 'issue_asset').args.ipfsHash, r.manifestCid);
  await page.click('#dp-again');
  await waitState(page, 'idle');
  await page.type('#dp-cid', pngCid); await page.keyboard.press('Enter');
  await waitState(page, 'ask');
  await page.click('.dp-option[data-kind="digital"]');
  await waitState(page, ['preview', 'blocked']);
  await waitPublishable(page);
  await publishFlow(page);
  const adds = (await page.evaluate(() => window.__dropCalls)).filter(c => c.cmd === 'ipfs_add_file').map(c => c.name);
  assert.deepEqual(adds, ['manifest.json'], 'the pasted file is reused by CID, only the manifest is added');
  await page.close();
});

test('keyboard only: paste field → Enter → template by keyboard → publish → confirm → done; Escape cancels the dialog', { timeout: 120_000 }, async () => {
  const pngCid = C.mockCid(PNG(6));
  const page = await openDrop({ cidStore: { [pngCid]: b64(PNG(6)) } });
  await page.focus('#dp-title');
  const order = [];
  for (let i = 0; i < 12; i++) { await page.keyboard.press('Tab'); order.push(await page.evaluate(() => document.activeElement?.id || document.activeElement?.className)); if (order.at(-1) === 'dp-cid') break; }
  assert.ok(order.includes('dp-zone') && order.includes('dp-pick') && order.at(-1) === 'dp-cid', `tab order: ${order}`);
  await page.keyboard.type(pngCid); await page.keyboard.press('Enter');
  await waitState(page, 'ask');
  await page.focus('.dp-option[data-kind="ticket"]'); await page.keyboard.press('Enter');
  await waitState(page, ['preview', 'blocked']);
  assert.equal(await page.$eval('#dp-card', c => c.dataset.template), 'event');
  // Ticket needs details → blocked with a plain reason; switch to digital via the advanced <details> with keyboard only.
  assert.match(await txt(page, '#dp-why'), /지금은 발행할 수 없어요/);
  await page.focus('#dp-adv summary'); await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.querySelector('#dp-adv').open);
  await page.focus('#dp-kind'); await page.select('#dp-kind', 'digital');
  await page.waitForFunction(() => document.querySelector('#dp-card')?.dataset.template === 'basic' || document.querySelector('#dp-card')?.dataset.template === 'gallery');
  await page.focus('.dp-pill[data-template="gallery"]'); await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.querySelector('#dp-card').dataset.template === 'gallery');
  assert.equal(await page.evaluate(() => document.activeElement?.dataset.template), 'gallery', 'focus stays on the chosen pill');
  await page.focus('.dp-swatch[data-theme-id="night"]'); await page.keyboard.press('Space');
  await page.waitForFunction(() => document.querySelector('#dp-card').dataset.theme === 'night');
  await waitPublishable(page);
  await page.focus('#dp-publish'); await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.querySelector('#dp-confirm')?.open);
  await page.keyboard.press('Escape');
  await waitState(page, ['preview', 'blocked']);
  assert.equal(await page.$eval('#dp-confirm', d => d.open), false);
  await page.focus('#dp-publish'); await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.querySelector('#dp-confirm')?.open);
  await page.keyboard.press('Tab'); assert.equal(await page.evaluate(() => document.activeElement?.id), 'dp-confirm-go');
  await page.keyboard.press('Enter');
  await waitState(page, 'done', 20000);
  assert.equal(await page.evaluate(() => document.activeElement?.id), 'dp-done-h', 'focus moves to the result');
  await page.close();
});

test('safety locks stay: taken name, unknown name (「확인 불가」 + 다시 조회), mainnet switch off — publish disabled, nothing issued', { timeout: 180_000 }, async () => {
  for (const [opts, re] of [[{ taken: ['RV.B.SEA'] }, /이미 있는 이름/], [{ nameUnknown: true }, /확인 불가/], [{ chain: 'main' }, /실제 발행은 아직 꺼져/]]) {
    const page = await openDrop(opts);
    const input = await page.$('#dp-files');
    await input.uploadFile(...BOOK.map(f => join(fileDir, f.name)));
    await waitState(page, ['preview', 'blocked']);
    await page.evaluate(() => { document.querySelector('#dp-adv').open = true; });
    await page.$eval('#dp-work', e => { e.value = 'SEA'; e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true })); });
    await page.waitForFunction(r => new RegExp(r).test(document.querySelector('#dp-chips')?.textContent ?? ''), { timeout: 15000 }, re.source);
    await waitState(page, 'blocked');
    assert.equal(await page.$eval('#dp-publish', b => b.disabled), true);
    assert.match(await txt(page, '#dp-why'), re);
    if (opts.nameUnknown) {
      await page.evaluate(() => { window.__nameKnown = true; });
      await page.click('#dp-recheck');
      await waitPublishable(page);
    }
    assert.equal((await page.evaluate(() => window.__dropCalls)).filter(c => c.cmd === 'issue_asset').length, 0);
    await page.close();
  }
});

test('templates × themes: trust strip is always first and readable; user text is never HTML; unsafe image URLs are dropped', { timeout: 120_000 }, async () => {
  const page = await openDrop({ width: 1024 });
  await page.addScriptTag({ content: uiBundle });
  const res = await page.evaluate(() => {
    const out = []; const box = document.createElement('div'); box.id = 'rvs-lab'; box.style.cssText = 'display:grid;gap:12px;padding:12px;max-width:900px'; document.body.append(box);
    const kinds = { album: 'music', single: 'music', book: 'book', gallery: 'game', event: 'ticket', shop: 'shop', basic: 'digital' };
    for (const tpl of window.__TEMPLATE_IDS) for (const theme of window.__THEME_IDS) {
      const el = window.__renderStorefront({ kind: kinds[tpl], title: '<img src=x onerror="window.__pwn=1">Title', description: '<script>window.__pwn=2</script>\n\nsecond', assetName: 'RV.M.X', priceRvn: '5',
        format: 'album', tracks: [{ title: '<b>t</b>', durationMs: 61000, previewUrl: 'javascript:alert(1)' }], coverUrl: 'javascript:alert(1)', backgroundUrl: 'https://evil.example/x.png', galleryUrls: ['javascript:x'],
        book: { format: 'pdf', pageCount: 100, previewPages: 5 }, ticket: { eventName: 'E', startsAt: '2026-12-01T10:00:00Z', venue: 'Hall', quantity: 10 }, shopItems: [{ title: '제육볶음', priceRvn: '3', assetName: 'RV.X.A' }],
        trust: 'unverified', officialLooking: true, similar: ['RV.M.Y'] }, { template: tpl, theme, tagline: 'tag <i>line</i>', tags: ['a', '<b>'] });
      box.append(el);
      const trust = el.firstElementChild, r = trust.getBoundingClientRect(), body = el.querySelector('.rvs-body').getBoundingClientRect();
      out.push({ tpl, theme, first: trust.classList.contains('rvs-trust'), visible: r.height > 20 && getComputedStyle(trust).visibility === 'visible', above: r.bottom <= body.top + 1,
        text: trust.textContent, html: el.querySelectorAll('script,b,i').length, imgs: [...el.querySelectorAll('img,audio')].map(i => i.getAttribute('src')).filter(Boolean) });
    }
    return { out, pwn: window.__pwn ?? null };
  });
  assert.equal(res.pwn, null, 'no injected code ran');
  assert.equal(res.out.length, 49);
  for (const r of res.out) {
    assert.ok(r.first && r.visible && r.above, `${r.tpl}/${r.theme} trust strip`);
    assert.match(r.text, /보증 · 미검증.*검토하지 않은 판매자.*공식 상품이 아니에요.*비슷한 이름/, `${r.tpl}/${r.theme}`);
    assert.equal(r.html, 0, `${r.tpl}/${r.theme}: user text became markup`);
    assert.deepEqual(r.imgs, [], `${r.tpl}/${r.theme}: unsafe URL used ${r.imgs}`);
  }
  const low = (await page.evaluate(textContrast, '#rvs-lab')).filter(x => x.ratio < 4.5);
  assert.deepEqual(low, [], 'every template × theme text ≥ 4.5:1');
  if (process.env.RV_DROP_SHOTS) { const el = await page.$('#rvs-lab'); await el.screenshot({ path: join(shotDir, 'templates-1024-light.png') }); }
  await page.close();
});

/* ── layout matrix ── */

function textContrast(scope) {
  const parse = c => { const v = c.match(/[\d.]+/g)?.map(Number); if (!v || v.length < 3) return [0, 0, 0, 0];
    return c.startsWith('color(') ? [v[0], v[1], v[2], v[3] ?? 1] : [v[0] / 255, v[1] / 255, v[2] / 255, v[3] ?? 1]; };
  const over = (a, b) => [...a.slice(0, 3).map((x, i) => x * a[3] + b[i] * (1 - a[3])), 1];
  const lum = c => { const f = x => x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]); };
  const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m); return (x + 0.05) / (y + 0.05); };
  const out = [];
  for (const n of document.querySelectorAll(scope + ' *')) {
    if (![...n.childNodes].some(t => t.nodeType === 3 && t.textContent.trim())) continue;
    const r = n.getBoundingClientRect(), s = getComputedStyle(n);
    if (!r.width || !r.height || s.visibility !== 'visible' || n.closest('[hidden]') || n.closest('.dp-hidden-input')) continue;
    if ((n.disabled || n.closest('button:disabled'))) continue; // WCAG 1.4.3: disabled controls exempt
    const chain = []; for (let p = n; p; p = p.parentElement) chain.unshift(p);
    if (n.closest('dialog')) { /* top layer: its own background */ }
    const bg = chain.reduce((acc, p) => over(parse(getComputedStyle(p).backgroundColor), acc), [1, 1, 1, 1]);
    let o = 1; for (let p = n; p; p = p.parentElement) o *= parseFloat(getComputedStyle(p).opacity);
    const raw = parse(s.color); const fg = over([raw[0], raw[1], raw[2], raw[3] * o], bg);
    out.push({ el: (n.id ? '#' + n.id : n.className || n.tagName.toLowerCase()) + '「' + n.textContent.trim().slice(0, 24) + '」', ratio: Math.round(ratio(fg, bg) * 100) / 100 });
  }
  return out;
}

/** 가로 넘침 · 글자 잘림 · 겹친 단추 · 작은 누를 곳. scope 들 안만 본다. */
function layoutProblems(scopes) {
  const vw = document.documentElement.clientWidth, out = [];
  if (document.documentElement.scrollWidth > vw + 1) out.push(`page scrollWidth ${document.documentElement.scrollWidth} > ${vw}`);
  const els = scopes.flatMap(s => [...document.querySelectorAll(s + ', ' + s + ' *')]);
  const name = e => (e.id ? '#' + e.id : (e.className && typeof e.className === 'string' ? '.' + e.className.split(' ')[0] : e.tagName.toLowerCase())) + '「' + (e.textContent || e.value || '').trim().slice(0, 18) + '」';
  const shown = e => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && !e.closest('[hidden]') && !e.closest('.dp-hidden-input') && getComputedStyle(e).visibility === 'visible' && !e.closest('details:not([open]) > :not(summary)'); };
  for (const e of els) {
    if (!shown(e)) continue;
    const r = e.getBoundingClientRect(), s = getComputedStyle(e);
    if (r.right > vw + 1 || r.left < -1) out.push(`off-screen ${name(e)} ${Math.round(r.left)}..${Math.round(r.right)}`);
    for (const t of e.childNodes) if (t.nodeType === 3 && t.textContent.trim()) {
      const range = document.createRange(); range.selectNodeContents(t);
      for (const q of range.getClientRects()) if (q.right > vw + 1) out.push(`text past viewport ${name(e)}`);
    }
    if (['hidden', 'clip'].includes(s.overflowX) && e.scrollWidth > e.clientWidth + 1 && !e.matches('.rvs, .dp-progress, img, input, textarea, select')) out.push(`clipped ${name(e)} ${e.scrollWidth}>${e.clientWidth}`);
    if (e.matches('button, summary, select, input:not([type=hidden]):not(.dp-hidden-input), textarea') && (r.height < 43.5 || r.width < 43.5)) out.push(`small target ${name(e)} ${Math.round(r.width)}×${Math.round(r.height)}`);
    if (e.matches('button') && e.scrollWidth > e.clientWidth + 1) out.push(`button text overflow ${name(e)}`);
  }
  const ctl = els.filter(e => e.matches('button, input:not(.dp-hidden-input), select, textarea, summary') && shown(e));
  for (let i = 0; i < ctl.length; i++) for (let j = i + 1; j < ctl.length; j++) {
    if (ctl[i].contains(ctl[j]) || ctl[j].contains(ctl[i])) continue;
    const a = ctl[i].getBoundingClientRect(), b = ctl[j].getBoundingClientRect();
    const ix = Math.min(a.right, b.right) - Math.max(a.left, b.left), iy = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
    if (ix > 2 && iy > 2) out.push(`overlap ${name(ctl[i])} × ${name(ctl[j])}`);
  }
  return [...new Set(out)].slice(0, 12);
}

async function rewire(page, { lang, stretch }) {
  await page.evaluate(() => { document.querySelector('#dp')?.remove(); document.querySelector('#dp-veil')?.remove(); document.querySelector('#dp-to-drop')?.remove(); localStorage.removeItem('rv-drop-draft-v1'); });
  await page.evaluate(({ lang, stretch }) => {
    window.__dp = window.__wireDropPublish({ invoke: (c, a) => window.__TAURI_INTERNALS__.invoke(c, a), askPassword: async () => null, back: () => {}, root: document.querySelector('#page-creator'), lang, stretch });
  }, { lang, stretch });
}

test('layout matrix: 320·390·768·1024·1440 × light/dark × ko·de·ru·+60%·+100% — no overflow, clipping, overlap; targets ≥ 44px; contrast ≥ 4.5:1', { timeout: 1_200_000 }, async () => {
  const quick = !!process.env.RV_DROP_MATRIX_QUICK;
  const LANGS = [{ id: 'ko', lang: 'ko', stretch: 1 }, { id: 'de', lang: 'de', stretch: 1 }, { id: 'ru', lang: 'ru', stretch: 1 }, { id: 'ps60', lang: 'ko', stretch: 1.6 }, { id: 'ps100', lang: 'en', stretch: 2 }].slice(0, quick ? 1 : 5);
  const SHOT = process.env.RV_DROP_SHOTS;
  const report = {};
  for (const width of quick ? [390] : [320, 390, 768, 1024, 1440]) for (const theme of quick ? ['light'] : ['light', 'dark']) {
    const page = await openDrop({ width, height: 900, theme, taken: [] });
    page.on('console', m => { if (m.type() === 'error') page.__errors = [...(page.__errors ?? []), m.text()]; });
    await page.addScriptTag({ content: uiBundle });
    for (const L of LANGS) {
      await rewire(page, L);
      const tag = `${width}-${theme}-${L.id}`;
      const check = async (stateName, scopes = ['#dp']) => {
        await page.mouse.move(1, 1);
        await page.waitForFunction(() => document.getAnimations().filter(a => a.playState === 'running').length === 0, { timeout: 4000 }).catch(() => {});
        const problems = await page.evaluate(layoutProblems, scopes);
        const low = [];
        for (const s of scopes) low.push(...(await page.evaluate(textContrast, s)).filter(x => x.ratio < 4.5));
        report[`${tag}-${stateName}`] = { problems, low };
        if (SHOT && (L.id === 'ko' ? [390, 1440].includes(width) : width === 390 && theme === 'light')) {
          // The app scrolls inside its own panel — grow the viewport to the content so the shot shows the whole screen.
          const tall = await page.evaluate(() => { let n = document.querySelector('#dp'), m = document.documentElement.scrollHeight; for (; n; n = n.parentElement) m = Math.max(m, n.scrollHeight + 160); return Math.min(m, 3600); });
          await page.setViewport({ width, height: Math.max(900, tall) });
          await page.screenshot({ path: join(shotDir, `${tag}-${stateName}.png`) });
          await page.setViewport({ width, height: 900 });
        }
      };
      await check('idle');
      // overlay (drag in progress)
      await page.evaluate(() => { const dt = new DataTransfer(); dt.items.add(new File(['x'], 'a.mp3')); document.body.dispatchEvent(new DragEvent('dragenter', { dataTransfer: dt, bubbles: true, cancelable: true })); });
      await page.waitForFunction(() => document.querySelector('#dp-veil').classList.contains('on'));
      await check('overlay', ['#dp-veil']);
      await page.evaluate(() => { document.body.dispatchEvent(new DragEvent('dragleave', { bubbles: true, relatedTarget: null })); });
      // preview of an album with long title + advanced open
      await htmlDrop(page, ALBUM.map((f, i) => i === 0 ? { ...f, name: '01 - Donaudampfschifffahrtsgesellschaftskapitänsmütze und noch viel mehr Text.mp3' } : f));
      await waitState(page, ['preview', 'blocked']).catch(async e => { throw new Error(`${tag}: ${e.message} state=${await state(page)} errors=${JSON.stringify(page.__errors)} err=${await txt(page, '#dp-error')}`); });
      await page.evaluate(() => { const a = document.querySelector('#dp-adv'); a.open = true; a.dispatchEvent(new Event('toggle')); });
      await page.$eval('#dp-title-in', e => { e.value = 'Очень длинное название für Härtetest_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'.slice(0, 80); e.dispatchEvent(new Event('input', { bubbles: true })); });
      await waitPublishable(page);
      await check('preview');
      // blocked — a name that breaks the rules
      await page.$eval('#dp-work', e => { e.value = '_BAD'; e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true })); });
      await waitState(page, 'blocked');
      await check('blocked');
      await page.$eval('#dp-work', e => { e.value = 'LONG_ALBUM_NAME_2026'; e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true })); });
      await waitPublishable(page);
      await page.click('#dp-publish');
      await page.waitForFunction(() => document.querySelector('#dp-confirm')?.open);
      await check('confirm', ['#dp-confirm']);
      await page.click('#dp-confirm-go');
      await waitState(page, 'done', 20000);
      await check('done');
    }
    await page.close();
  }
  if (process.env.RV_DROP_REPORT) await writeFile(process.env.RV_DROP_REPORT, JSON.stringify(report, null, 2));
  assert.equal(Object.keys(report).length, quick ? 6 : 5 * 2 * 5 * 6);
  const bad = Object.entries(report).filter(([, v]) => v.problems.length || v.low.length);
  assert.deepEqual(bad.slice(0, 6), [], `${bad.length} layout/contrast failures`);
});

