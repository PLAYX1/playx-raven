// 장터 「바로 해 보는 게임」 실제 Chrome 시험(운영 빌드 · 가짜 노드 · 던져 버리는 키로 서명한 시험 문서만 — 네트워크·노드·실제 결제 없음).
// ① 실제 상황 그대로(체인에 RVLT 게임 0개) → 「아직 올라온 게임이 없어요」, 예시 게임 없음.
// ② 시험 문서 3개 → 줄·장르 칩·값이 가장 큰 글·「확인 판매자」 글 · 더 보기 · 게임 페이지 · 확인 칸(「읽었어요」 전에는 「정말 내기」 잠김) · 앱 창 안 iframe(sandbox).
// 1120·1440 × 밝게/어둡게 · 단추 글자 한 줄 · 가로 넘침 없음. 사진은 RV_ARCADE_SHOTS 폴더에.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { resolve, join, extname, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { build } from 'esbuild';
import puppeteer from 'puppeteer-core';
import { installFixture } from './desktop-fixture.mjs';

const root = resolve(import.meta.dirname, '..');
const built = await build({ entryPoints: [join(root, 'scripts/fixtures/arcade-entry.ts')], bundle: true, write: false, platform: 'node', format: 'cjs', logLevel: 'silent' });
const mod = { exports: {} };
new Function('require', 'exports', 'module', built.outputFiles[0].text)(createRequire(import.meta.url), mod.exports, mod);
const A = mod.exports;

const key = A.secp256k1.utils.randomPrivateKey();
const seller = A.addressOfPublicKey(A.secp256k1.getPublicKey(key, true));
const cidOf = n => 'Qm' + String(n).padStart(44, '1').replace(/0/g, 'A');
const doc = (id, title, priceSats, genre, assetName) => Buffer.from(A.encodeArcadeProduct(A.signArcadeProductForTest({
  format: 'rv-arcade-product', v: 1, kind: 'arcade-game', id, version: 1, title, description: 'Test document signed with a throwaway key.',
  priceSats, seller, payTo: seller, feeBps: A.ARCADE_FEE_BPS, entry: 'index.html', cid: cidOf(9),
  files: [{ path: 'index.html', sha256: A.sha256Hex(A.utf8('h')), size: 1 }], x: { arcade: { mode: 'solo', network: 'none', minutes: 3, genre } }, assetName,
}, key))).toString('base64');
const FULL = {
  assets: [
    { name: 'RVLT/TESTARCADE', ipfsHash: null },
    { name: 'RVLT/TESTARCADE#STAR_RUN', ipfsHash: cidOf(1) },
    { name: 'RVLT/TESTARCADE#BLOCK_DROP', ipfsHash: cidOf(2) },
    { name: 'RVLT/TESTARCADE#TAP_TAP', ipfsHash: cidOf(3) },
  ],
  docs: {
    [cidOf(1)]: doc('star-run', 'Star Run', '100000000', 'action', 'RVLT/TESTARCADE#STAR_RUN'),
    [cidOf(2)]: doc('block-drop', 'Block Drop', '25000000', 'puzzle', 'RVLT/TESTARCADE#BLOCK_DROP'),
    [cidOf(3)]: doc('tap-tap', 'Tap Tap', '0', 'casual', 'RVLT/TESTARCADE#TAP_TAP'),
  },
};
const GAME_HTML = '<!doctype html><meta charset="utf-8"><body style="margin:0;display:grid;place-items:center;height:100vh;font:24px system-ui;background:#223;color:#fff">TEST GAME (sandboxed iframe)</body>';

let work, dist, browser, server, origin, shotDir;
before(async () => {
  work = mkdtempSync(join(tmpdir(), 'rv-arcade-ui-'));
  shotDir = process.env.RV_ARCADE_SHOTS || join(work, 'shots'); mkdirSync(shotDir, { recursive: true });
  dist = join(work, 'dist');
  execFileSync(process.execPath, [resolve(root, 'node_modules/vite/bin/vite.js'), 'build', '--outDir', dist, '--emptyOutDir', '--logLevel', 'error'], { cwd: root, stdio: ['ignore', 'ignore', 'inherit'] });
  const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.json': 'application/json' };
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
  browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true, userDataDir: join(work, 'profile'), args: ['--no-sandbox', '--disable-gpu'] });
});
after(async () => { await browser?.close(); server?.close(); if (work && !process.env.RV_KEEP_WORK) rmSync(work, { recursive: true, force: true }); });

async function openMarket({ width, theme = 'light', sources }) {
  const page = await browser.newPage();
  page.on('pageerror', e => { page.__errors = [...(page.__errors ?? []), e.message]; });
  await page.setViewport({ width, height: 900 });
  await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: theme }, { name: 'prefers-reduced-motion', value: 'reduce' }]);
  await page.setRequestInterception(true);
  page.on('request', r => {
    const u = new URL(r.url());
    if (u.origin === origin && r.method() === 'GET') return r.continue();
    // 게임 길(확인된 사이트 길)만 시험 게임 한 장으로 답한다 — 실제 사이트에는 닿지 않는다.
    if (r.url().startsWith(A.ARCADE_LINK_BASE)) return r.respond({ status: 200, contentType: 'text/html', body: GAME_HTML });
    return r.abort();
  });
  await page.evaluateOnNewDocument(installFixture, { theme, sales: true, seller: true });
  await page.evaluateOnNewDocument(src => {
    const inner = window.__TAURI_INTERNALS__.invoke;
    const pays = window.__arcadePays = [];
    const extra = async (command, args) => {
      if (command === 'arcade_catalog_sources') return structuredClone(src);
      if (command === 'arcade_entry_reachable') return true;
      if (command === 'market_browse') return [];
      if (command === 'arcade_pay') { pays.push(args); return { txid: 'ab'.repeat(32) }; }
      if (command === 'arcade_ack') return null;
      return inner(command, args);
    };
    window.__TAURI_INTERNALS__.invoke = extra;
    window.__TAURI__.core.invoke = extra;
  }, sources);
  await page.goto(origin + '/', { waitUntil: 'networkidle0' });
  await page.waitForFunction(() => document.querySelector('#page-home.on') && !document.documentElement.hasAttribute('data-ravi-arriving'), { timeout: 20000 });
  await page.evaluate(() => { document.querySelector('nav')?.classList.add('more-open'); document.querySelector('nav a[data-page="trade"]').click(); });
  await page.waitForFunction(() => document.querySelector('#page-trade.on') && document.querySelector('#ar-host .ar-head'));
  await page.waitForFunction(() => !/가져오는 중/.test(document.querySelector('#ar-host').textContent), { timeout: 10000 });
  return page;
}
const shot = (page, name) => page.screenshot({ path: join(shotDir, name), fullPage: false });
/** 보이는 단추 중 글자가 두 줄 이상인 것(줄 상자 윗선이 둘 이상) · nowrap 이 아닌 것. */
async function noWrapButtons(page) {
  return page.evaluate(() => [...document.querySelectorAll('#ar-host button:not(.ar-card)')].filter(b => b.offsetParent)
    .filter(b => { const r = document.createRange(); r.selectNodeContents(b); const tops = new Set([...r.getClientRects()].map(x => Math.round(x.top)));
      return tops.size > 1 || getComputedStyle(b).whiteSpace !== 'nowrap'; })
    .map(b => b.textContent.trim()));
}
const overflowX = page => page.evaluate(() => document.querySelector('#page-trade').scrollWidth - document.querySelector('#page-trade').clientWidth);

for (const width of [1120, 1440]) {
  test(`실제 상황(체인에 게임 0개) ${width}: 정직한 빈 화면 · 예시 게임 없음`, async () => {
    for (const theme of ['light', 'dark']) {
      const page = await openMarket({ width, theme, sources: { assets: [], docs: {} } });
      const text = await page.$eval('#ar-host', e => e.textContent);
      assert.match(text, /아직 올라온 게임이 없어요/);
      assert.doesNotMatch(text, /Raven Runner|Copper Tetra|Moon Dodge/);
      assert.equal(await page.$$eval('#ar-host .ar-row, #ar-host .ar-grid', l => l.length), 0);
      assert.equal(await page.$$eval('#ar-host .ar-card', l => l.length), 0);
      await shot(page, `arcade-empty-${width}-${theme}.png`);
      assert.deepEqual(page.__errors ?? [], []);
      await page.close();
    }
  });

  test(`시험 문서 3개 ${width}: 줄 → 더 보기 → 게임 페이지 → 확인 칸 → 앱 창 안 게임`, async () => {
    for (const theme of ['light', 'dark']) {
      const page = await openMarket({ width, theme, sources: FULL });
      assert.equal(await page.$$eval('#ar-host .ar-row .ar-card', l => l.length), 3);
      // 값이 카드에서 가장 큰 글
      const sizes = await page.$eval('#ar-host .ar-card', c => [...c.querySelectorAll('.ar-cbody > span')].map(s => parseFloat(getComputedStyle(s).fontSize)));
      assert.equal(Math.max(...sizes), sizes[0], `값 글자 크기 ${sizes}`);
      assert.match(await page.$eval('#ar-host .ar-row', e => e.textContent), /확인 판매자/);
      assert.equal(await page.$$eval('#ar-host .ar-chips button', l => l.length), 4, '전체 + 장르 3');
      assert.deepEqual(await noWrapButtons(page), []);
      assert.ok(await overflowX(page) <= 1);
      await shot(page, `arcade-row-${width}-${theme}.png`);
      if (theme === 'dark') { await page.close(); continue; }

      await page.click('#ar-host [data-ar-more]');
      await page.waitForSelector('#ar-host [data-ar-all] .ar-grid');
      assert.equal(await page.$eval('#page-trade', p => getComputedStyle(p.querySelector('.lm-bar')).display), 'none', '목록을 보는 동안 맞교환 줄은 접는다');
      await shot(page, `arcade-all-${width}.png`);

      await page.click('#ar-host [data-ar-open$="/star-run"]');
      await page.waitForSelector('#ar-host [data-ar-buy]');
      // 게임 페이지에서도 값이 가장 큰 글(제목보다 크다)
      const [big, h] = await page.$eval('#ar-host .ar-page', e => [parseFloat(getComputedStyle(e.querySelector('.ar-big')).fontSize), parseFloat(getComputedStyle(e.querySelector('h3')).fontSize)]);
      assert.ok(big >= 28 && big > h, `값 ${big}px · 제목 ${h}px`);
      assert.deepEqual(await noWrapButtons(page), []);
      await page.click('#ar-host [data-ar-buy]');
      await page.waitForSelector('#ar-host [data-ar-go]');
      assert.equal(await page.$eval('#ar-host [data-ar-go]', b => b.disabled), true, '「읽었어요」 전에는 잠김');
      const confirm = await page.$eval('#ar-host .ar-confirm', e => e.textContent);
      assert.match(confirm, /0\.99/); assert.match(confirm, /0\.01/); assert.ok(confirm.includes(seller));
      assert.deepEqual(await page.evaluate(() => window.__arcadePays), [], '확인 칸만 열고 보내지 않았다');
      await shot(page, `arcade-confirm-${width}.png`);
      await page.click('#ar-host [data-ar-agree]');
      await page.click('#ar-host [data-ar-go]');
      await page.waitForSelector('#ar-host iframe.ar-frame');
      const pays = await page.evaluate(() => window.__arcadePays);
      assert.equal(pays.length, 1);
      assert.deepEqual([pays[0].payTo, pays[0].sellerAtoms, pays[0].feeAtoms, pays[0].priceAtoms], [seller, 99_000_000, 1_000_000, 100_000_000]);
      const frame = await page.$eval('#ar-host iframe.ar-frame', f => ({ sandbox: f.getAttribute('sandbox'), src: f.src, ref: f.getAttribute('referrerpolicy') }));
      assert.equal(frame.sandbox, 'allow-scripts'); assert.equal(frame.ref, 'no-referrer');
      assert.ok(frame.src.startsWith(A.ARCADE_LINK_BASE + cidOf(1) + '/'));
      await new Promise(r => setTimeout(r, 400));
      await page.$eval('#ar-host .ar-page', e => e.scrollIntoView());
      await shot(page, `arcade-game-${width}.png`);
      await page.$eval('#ar-host [data-ar-stage]', e => e.scrollIntoView());
      await shot(page, `arcade-playing-${width}.png`);
      assert.deepEqual(page.__errors ?? [], []);
      await page.close();
    }
  });
}
