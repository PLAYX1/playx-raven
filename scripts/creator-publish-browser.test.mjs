// Creator publish in real Chrome (production dist, synthetic fixture). Upload → sign → confirm → issue on a MOCK chain.
// IPFS adds, signing and issuance are answered by this harness (exposeFunction + a wrapped Tauri invoke); nothing reaches
// a real node, IPFS daemon or network. Keys are throwaway. Also: mainnet stays locked, owner token gate, bad files,
// music flow, text contrast >= 4.5:1 (light/dark, 390 and 1440 wide) and no horizontal overflow at 390.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { resolve, join, extname, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { build } from 'esbuild';
import puppeteer from 'puppeteer-core';
import { installFixture } from './desktop-fixture.mjs';

const root = resolve(import.meta.dirname, '..');
const built = await build({ entryPoints: [join(root, 'scripts/fixtures/creator-core-entry.ts')], bundle: true, write: false, platform: 'node', format: 'cjs', logLevel: 'silent' });
const core = { exports: {} };
new Function('require', 'exports', 'module', built.outputFiles[0].text)(createRequire(import.meta.url), core.exports, core);
const { mockCid, signMessageForTest, randomKey, addressOf, verifyManifest } = core.exports;
const KEY = randomKey();
const ADDRESS = addressOf(KEY);

let work, dist, browser, server, origin, files;
before(async () => {
  work = mkdtempSync(join(tmpdir(), 'rv-creator-ui-'));
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
  // Test files on disk (uploadFile needs real paths).
  const png = n => Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 73, 72, 68, 82, n]);
  files = {
    index: join(work, 'index.html'), js: join(work, 'game.js'), hero: join(work, 'hero.png'), cover: join(work, 'cover.png'),
    exe: join(work, 'evil.exe'), mp3: join(work, 'song.mp3'), fake: join(work, 'fake.mp3'),
  };
  writeFileSync(files.index, '<!doctype html><html><body><script src="game.js"></script></body></html>');
  writeFileSync(files.js, 'console.log("star run")');
  writeFileSync(files.hero, png(1)); writeFileSync(files.cover, png(2));
  writeFileSync(files.exe, 'MZ not allowed');
  writeFileSync(files.mp3, Buffer.from([0x49, 0x44, 0x33, 3, 0, 0, 0, 0, 0, 0, 0xff, 0xfb, 0x90, 0x64]));
  writeFileSync(files.fake, png(3)); // a PNG named .mp3
});
after(async () => { await browser?.close(); server?.close(); if (work) rmSync(work, { recursive: true, force: true }); });

/** Harness answers for the five commands this page uses; everything else falls through to the shared fixture. */
function installCreatorHarness({ chain, ownerTokens }) {
  const base = window.__TAURI_INTERNALS__.invoke;
  const calls = window.__creatorCalls = [];
  const wrap = async (cmd, args) => {
    if (cmd === 'ipfs_add_file') { calls.push({ cmd, name: args.file.name, size: args.file.bytes.length }); return { cid: await window.__mockCid(args.file.bytes), name: args.file.name, size: args.file.bytes.length }; }
    if (cmd === 'sign_message') { calls.push({ cmd, address: args.address, withPassword: 'passphrase' in args }); return { address: args.address, message: args.message, signature: await window.__testSign(args.address, args.message) }; }
    if (cmd === 'owner_tokens') return ownerTokens;
    if (cmd === 'name_taken') { calls.push({ cmd, name: args.name }); return false; }
    if (cmd === 'node_status') { const s = await base(cmd, args); return { ...s, chain }; }
    if (cmd === 'issue_asset') { calls.push({ cmd, args }); return { txid: 'cd'.repeat(32), owner_token: 'PLAYXG/STAR_RUN!' }; }
    if (cmd === 'new_address') return window.__testAddress;
    return base(cmd, args);
  };
  window.__TAURI_INTERNALS__.invoke = wrap; window.__TAURI__.core.invoke = wrap;
}

async function openCreator({ width = 1440, height = 900, theme = 'light', chain = 'regtest', ownerTokens = ['PLAYXG!'] } = {}) {
  const page = await browser.newPage();
  await page.setViewport({ width, height });
  await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: theme }, { name: 'prefers-reduced-motion', value: 'reduce' }]);
  await page.setRequestInterception(true);
  page.on('request', r => (new URL(r.url()).origin === origin && r.method() === 'GET') ? r.continue() : r.abort());
  await page.exposeFunction('__mockCid', bytes => mockCid(Uint8Array.from(bytes)));
  await page.exposeFunction('__testSign', (address, message) => { if (address !== ADDRESS) throw Error('wrong address'); return signMessageForTest(message, KEY); });
  await page.evaluateOnNewDocument(installFixture, { theme, sales: true, seller: true });
  await page.evaluateOnNewDocument(installCreatorHarness, { chain, ownerTokens });
  await page.evaluateOnNewDocument(a => { window.__testAddress = a; }, ADDRESS);
  await page.goto(origin + '/', { waitUntil: 'networkidle0' });
  await page.waitForFunction(() => document.querySelector('#page-home.on') && !document.documentElement.hasAttribute('data-ravi-arriving'), { timeout: 20000 });
  await page.evaluate(() => document.querySelector('nav')?.classList.add('more-open'));
  await page.click('nav a[data-page="games"]');
  await page.waitForFunction(() => document.querySelector('#page-games.on'));
  await page.click('#creator-open');
  await page.waitForFunction(() => document.querySelector('#page-creator.on'));
  return page;
}
const text = (page, sel) => page.$eval(sel, e => e.textContent.replace(/\s+/g, ' ').trim());
const visible = (page, sel) => page.$eval(sel, e => !e.closest('[hidden]') && e.getClientRects().length > 0);

async function fillGame(page) {
  await page.type('#creator-title', '별 달리기');
  await page.type('#creator-asset', 'STAR_RUN');
  await page.type('#creator-price', '300');
  await page.click('#creator-new-address');
  await page.waitForFunction(a => document.querySelector('#creator-address').value === a, {}, ADDRESS);
  await (await page.$('#creator-files')).uploadFile(files.index, files.js, files.hero);
  await (await page.$('#creator-cover')).uploadFile(files.cover);
  await page.waitForFunction(() => /3개 파일 · 표지 1장/.test(document.querySelector('#creator-files-say').textContent));
}

// All visible text in the creator page against the alpha-composited background behind it.
function textContrast() {
  const parse = c => { const v = c.match(/[\d.]+/g)?.map(Number); if (!v || v.length < 3) return [0, 0, 0, 0];
    return c.startsWith('color(') ? [v[0], v[1], v[2], v[3] ?? 1] : [v[0] / 255, v[1] / 255, v[2] / 255, v[3] ?? 1]; };
  const over = (a, b) => [...a.slice(0, 3).map((x, i) => x * a[3] + b[i] * (1 - a[3])), 1];
  const lum = c => { const f = x => x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]); };
  const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m); return (x + 0.05) / (y + 0.05); };
  const opacityOf = el => { let o = 1; for (let p = el; p; p = p.parentElement) o *= parseFloat(getComputedStyle(p).opacity); return o; };
  const out = [];
  for (const n of document.querySelectorAll('#page-creator *')) {
    if (![...n.childNodes].some(t => t.nodeType === 3 && t.textContent.trim())) continue;
    const r = n.getBoundingClientRect(), s = getComputedStyle(n);
    if (!r.width || !r.height || s.visibility !== 'visible' || n.closest('[hidden]') || (n.disabled && n.tagName === 'BUTTON')) continue;
    const chain = []; for (let p = n; p; p = p.parentElement) chain.unshift(p);
    let gradient = false;
    const bg = chain.reduce((acc, p) => { const st = getComputedStyle(p); if (st.backgroundImage !== 'none' && p !== document.documentElement && p !== document.body) gradient = true; return over(parse(st.backgroundColor), acc); }, [1, 1, 1, 1]);
    const raw = parse(s.color); const fg = over([raw[0], raw[1], raw[2], raw[3] * opacityOf(n)], bg);
    out.push({ el: (n.id ? '#' + n.id : n.tagName.toLowerCase()) + '「' + n.textContent.trim().slice(0, 20) + '」', ratio: Math.round(ratio(fg, bg) * 100) / 100, gradient });
  }
  return out;
}
const overflow390 = page => page.evaluate(() => {
  const vw = document.documentElement.clientWidth;
  const wide = [...document.querySelectorAll('#page-creator *')].filter(e => { const r = e.getBoundingClientRect(); return r.width && r.right > vw + 1; })
    .map(e => (e.id ? '#' + e.id : e.tagName.toLowerCase()) + ':' + Math.round(e.getBoundingClientRect().right));
  return { vw, wide: wide.slice(0, 10) };
});

test('game: upload → creator signature → confirm (burn 「확인 불가」, irreversible) → issue on the mock chain → unverified request', { timeout: 300_000 }, async () => {
  const page = await openCreator();
  assert.equal(await text(page, '#creator-prefix'), 'PLAYXG/');
  assert.match(await text(page, '#creator-pin-holder'), /이 컴퓨터의 IPFS/);
  await fillGame(page);
  assert.match(await text(page, '#creator-fee'), /300 RVN.*255 RVN.*45 RVN.*15%.*초안/);
  assert.match(await text(page, '#creator-name-say'), /PLAYXG\/STAR_RUN/);
  assert.equal(await page.$eval('#creator-upload', b => b.disabled), true, 'upload locked before the check');
  await page.click('#creator-check-run');
  assert.match(await text(page, '#creator-check'), /올릴 수 있어요 · 파일 4개/);
  assert.match(await text(page, '#creator-check'), /코드를 실행해요.*나쁜 코드를 다 찾아내지 못해요/);
  assert.equal(await page.$eval('#creator-upload', b => b.disabled), false);
  await page.click('#creator-upload');
  await page.waitForFunction(() => !document.querySelector('#creator-confirm').hidden, { timeout: 20000 });
  const cid = await text(page, '#creator-cid');
  assert.match(cid, /^Qm[1-9A-HJ-NP-Za-km-z]{44}$/);
  const calls = await page.evaluate(() => window.__creatorCalls);
  assert.deepEqual(calls.filter(c => c.cmd === 'ipfs_add_file').map(c => c.name), ['index.html', 'game.js', 'hero.png', 'cover.png', 'manifest.json']);
  assert.deepEqual(calls.filter(c => c.cmd === 'sign_message'), [{ cmd: 'sign_message', address: ADDRESS, withPassword: false }]);
  // Confirmation screen.
  assert.equal(await text(page, '#creator-c-name'), 'PLAYXG/STAR_RUN');
  assert.equal(await text(page, '#creator-c-cid'), cid);
  assert.match(await text(page, '#creator-c-burn'), /^100 RVN \(하위 자산\)$/);
  assert.match(await text(page, '#creator-c-burn-check'), /확인 불가/);
  assert.match(await text(page, '#creator-c-chain'), /시험망\(regtest\)/);
  assert.match(await text(page, '#creator-c-irreversible'), /영영 돌아오지 않아요.*영구예요.*되돌릴 수 없어요.*「검증됨」이 아니에요/);
  assert.equal(await page.$eval('#creator-issue', b => b.disabled), true, 'issue locked until the name is typed');
  await page.type('#creator-typed', 'PLAYXG/STAR_RU');
  assert.equal(await page.$eval('#creator-issue', b => b.disabled), true);
  await page.type('#creator-typed', 'N');
  assert.equal(await page.$eval('#creator-issue', b => b.disabled), false);
  const shots = {};
  for (const theme of ['light', 'dark']) {
    await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: theme }]);
    shots[`confirm-${theme}`] = (await page.evaluate(textContrast)).filter(r => !r.gradient && r.ratio < 4.5);
  }
  await page.click('#creator-issue');
  await page.waitForFunction(() => !document.querySelector('#creator-done').hidden, { timeout: 10000 });
  const issued = (await page.evaluate(() => window.__creatorCalls)).filter(c => c.cmd === 'issue_asset');
  assert.deepEqual(issued.map(c => c.args), [{ name: 'PLAYXG/STAR_RUN', qty: 1, units: 0, reissuable: true, ipfsHash: cid, toAddress: null }]);
  assert.equal(await text(page, '#creator-txid'), 'cd'.repeat(32));
  const req = JSON.parse(await page.$eval('#creator-request', t => t.value));
  assert.deepEqual([req.format, req.status, req.asset, req.type, req.manifestCid, req.issueTxid, req.creatorAddress], ['rv-creator-listing-request', 'unverified', 'PLAYXG/STAR_RUN', 'game', cid, 'cd'.repeat(32), ADDRESS]);
  for (const theme of ['light', 'dark']) {
    await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: theme }]);
    shots[`done-${theme}`] = (await page.evaluate(textContrast)).filter(r => !r.gradient && r.ratio < 4.5);
  }
  assert.deepEqual(await page.evaluate(() => window.__homeFixture.forbidden), [], 'no reveal/unlock/send command');
  for (const [k, v] of Object.entries(shots)) assert.deepEqual(v, [], `low contrast (${k}): ${JSON.stringify(v)}`);
  if (process.env.RV_CREATOR_SHOTS) await page.screenshot({ path: join(process.env.RV_CREATOR_SHOTS, 'creator-done-1440.png'), fullPage: true });
  await page.close();
});

test('mainnet stays locked; missing PLAYXG! blocks; nothing is issued', { timeout: 300_000 }, async () => {
  for (const [opts, expect] of [[{ chain: 'main' }, /실제 발행은 아직 꺼져 있어요/], [{ ownerTokens: [] }, /PLAYXG!/]]) {
    const page = await openCreator(opts);
    await fillGame(page);
    await page.click('#creator-check-run');
    await page.click('#creator-upload');
    await page.waitForFunction(() => !document.querySelector('#creator-confirm').hidden, { timeout: 20000 });
    await page.type('#creator-typed', 'PLAYXG/STAR_RUN');
    assert.equal(await page.$eval('#creator-issue', b => b.disabled), true);
    assert.match(await text(page, '#creator-c-blockers'), expect);
    await page.evaluate(() => document.querySelector('#creator-issue').click());
    assert.equal((await page.evaluate(() => window.__creatorCalls)).filter(c => c.cmd === 'issue_asset').length, 0);
    if (opts.chain === 'main') assert.match(await text(page, '#creator-c-chain'), /메인넷/);
    await page.close();
  }
});

test('bad files are refused before upload; music flow (audio + cover + preview window) reaches the confirm screen', { timeout: 300_000 }, async () => {
  const page = await openCreator();
  await fillGame(page);
  await (await page.$('#creator-files')).uploadFile(files.index, files.exe);
  await page.waitForFunction(() => /2개 파일/.test(document.querySelector('#creator-files-say').textContent));
  await page.click('#creator-check-run');
  assert.match(await text(page, '#creator-check'), /고칠 곳 .*evil\.exe/);
  assert.equal(await page.$eval('#creator-upload', b => b.disabled), true);
  assert.equal((await page.evaluate(() => window.__creatorCalls)).filter(c => c.cmd === 'ipfs_add_file').length, 0);
  // Music.
  await page.click('input[name="creator-type"][value="music"]');
  assert.equal(await visible(page, '#creator-music-fields'), true); assert.equal(await visible(page, '#creator-game-fields'), false);
  await (await page.$('#creator-files')).uploadFile(files.fake);
  await page.waitForFunction(() => /1개 파일/.test(document.querySelector('#creator-files-say').textContent));
  await page.click('#creator-check-run');
  assert.match(await text(page, '#creator-check'), /fake\.mp3: 파일 이름\(확장자\)과 실제 내용이 달라요/);
  await (await page.$('#creator-files')).uploadFile(files.mp3);
  await page.waitForFunction(() => document.querySelector('#creator-preview-file').value === 'song.mp3');
  await page.$eval('#creator-preview-end', e => { e.value = '75'; e.dispatchEvent(new Event('input')); });
  await page.click('#creator-check-run');
  assert.match(await text(page, '#creator-check'), /60초 이하/);
  await page.$eval('#creator-preview-start', e => { e.value = '15'; e.dispatchEvent(new Event('input')); });
  await page.$eval('#creator-asset', e => { e.value = 'MORNING_SONG'; e.dispatchEvent(new Event('input')); });
  await page.click('#creator-check-run');
  assert.match(await text(page, '#creator-check'), /올릴 수 있어요/);
  await page.click('#creator-upload');
  await page.waitForFunction(() => !document.querySelector('#creator-confirm').hidden, { timeout: 20000 });
  assert.equal(await text(page, '#creator-c-name'), 'PLAYXG/MORNING_SONG');
  await page.close();
});

test('390 and 1440 wide, light and dark: no horizontal overflow, page text contrast >= 4.5:1', { timeout: 300_000 }, async () => {
  const report = {};
  for (const width of [390, 1440]) for (const theme of ['light', 'dark']) {
    const page = await openCreator({ width, height: 844, theme });
    await fillGame(page);
    await page.click('#creator-check-run');
    await page.click('#creator-upload');
    await page.waitForFunction(() => !document.querySelector('#creator-confirm').hidden, { timeout: 20000 });
    const low = (await page.evaluate(textContrast)).filter(r => !r.gradient && r.ratio < 4.5);
    const measured = (await page.evaluate(textContrast)).length;
    const of = await overflow390(page);
    report[`${width}-${theme}`] = { measured, low, overflow: of.wide };
    if (process.env.RV_CREATOR_SHOTS) await page.screenshot({ path: join(process.env.RV_CREATOR_SHOTS, `creator-${width}-${theme}.png`), fullPage: true });
    await page.close();
  }
  if (process.env.RV_CREATOR_REPORT) await writeFile(process.env.RV_CREATOR_REPORT, JSON.stringify(report, null, 2));
  for (const [k, v] of Object.entries(report)) {
    assert.ok(v.measured > 40, `${k}: measured too little (${v.measured})`);
    assert.deepEqual(v.low, [], `${k} low contrast: ${JSON.stringify(v.low)}`);
    assert.deepEqual(v.overflow, [], `${k} overflow: ${JSON.stringify(v.overflow)}`);
  }
});

test('a manifest the page produced verifies independently in node', { timeout: 120_000 }, async () => {
  // Re-run the page flow, then fetch the manifest bytes the page pinned and verify them outside the browser.
  const page = await openCreator();
  await page.evaluate(() => { const base = window.__TAURI_INTERNALS__.invoke; window.__pinned = {}; const wrap = async (c, a) => { if (c === 'ipfs_add_file' && a.file.name === 'manifest.json') window.__pinned.manifest = a.file.bytes; return base(c, a); }; window.__TAURI_INTERNALS__.invoke = wrap; window.__TAURI__.core.invoke = wrap; });
  await fillGame(page);
  await page.click('#creator-check-run');
  await page.click('#creator-upload');
  await page.waitForFunction(() => !document.querySelector('#creator-confirm').hidden, { timeout: 20000 });
  const bytes = Uint8Array.from(await page.evaluate(() => window.__pinned.manifest));
  const v = verifyManifest(bytes, { expectedAsset: 'PLAYXG/STAR_RUN' });
  assert.equal(v.signedBy, ADDRESS); assert.equal(mockCid(bytes), await text(page, '#creator-cid'));
  assert.equal(v.manifest.price.atoms, '30000000000'); assert.equal(v.manifest.files.length, 3); assert.equal(v.manifest.cover.path, 'cover.png');
  await page.close();
});
