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
import { resolve, join, extname, sep, dirname } from 'node:path';
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
// 시험 게임: 「한 판 넣기 v1」을 말한다 — 열리면 ask, credit 오면 PLAYING + playId, 「끝」을 누르면 over.
const GAME_HTML = `<!doctype html><meta charset="utf-8"><body style="margin:0;display:grid;place-items:center;height:100vh;font:22px system-ui;background:#223;color:#fff">
<div><p id="s">TEST GAME · INSERT COIN</p><button id="end">end</button></div><script>
let play=null;const ask=()=>parent.postMessage({type:'rv-arcade',v:1,ask:'credit'},'*');
addEventListener('message',e=>{const m=e.data;if(m&&m.type==='rv-arcade'&&m.credit===true){play=m.playId;document.getElementById('s').textContent='PLAYING '+play.slice(0,8);}
else if(m&&m.type==='rv-arcade'&&m.credit===false){document.getElementById('s').textContent='NO CREDIT '+m.reason;}});
document.getElementById('end').onclick=()=>{if(play){parent.postMessage({type:'rv-arcade',v:1,event:'over',playId:play,score:42},'*');play=null;document.getElementById('s').textContent='GAME OVER';setTimeout(ask,1600);}};
setTimeout(ask,300);</script></body>`;

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

const UP_KEY = A.secp256k1.utils.randomPrivateKey();
const UP_SELLER = A.addressOfPublicKey(A.secp256k1.getPublicKey(UP_KEY, true));
const UP_SCAN = { folder: 'star-run', files: [{ path: 'index.html', sha256: A.sha256Hex(A.utf8('i')), size: 812 }, { path: 'js/game.js', sha256: A.sha256Hex(A.utf8('g')), size: 20480 }],
  skipped: ['.DS_Store'], badNames: [], htmlTexts: { 'index.html': '<!doctype html><canvas></canvas><script src="js/game.js"></script>' } };
const UP_BAD = { ...UP_SCAN, folder: 'cdn-game', htmlTexts: { 'index.html': '<script src="https://cdn.example.com/phaser.js"></script><script>start()</script>' } };

async function openMarket({ width, theme = 'light', sources, scan = UP_SCAN }) {
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
  await page.exposeFunction('__signTest', message => A.signMessageWithKeyForTest(message, UP_KEY));
  await page.evaluateOnNewDocument((src, scan, upSeller) => {
    const inner = window.__TAURI_INTERNALS__.invoke;
    const pays = window.__arcadePays = [];
    const up = window.__upCalls = [];
    const extra = async (command, args) => {
      // 「게임 올리기」 — 가짜만(실제 IPFS·서명·발행 없음).
      if (command === 'owner_tokens') return ['RVLT/TESTARCADE!', 'RVLT!'];
      if (command === 'arcade_pick_folder') { up.push([command]); return structuredClone(scan); }
      if (command === 'new_address') { up.push([command]); return upSeller; }
      if (command === 'arcade_pin_folder') { up.push([command, args.expect.length]); return { cid: 'Qm' + '3'.repeat(44), files: args.expect.length }; }
      if (command === 'sign_message') { up.push([command, args.address]); return { address: args.address, message: args.message, signature: await window.__signTest(args.message) }; }
      if (command === 'ipfs_add_file') { up.push([command, args.file.name]); return { cid: 'Qm' + '4'.repeat(44), name: args.file.name, size: args.file.bytes.length }; }
      if (command === 'issue_asset') { up.push([command, args]); return { txid: 'cd'.repeat(32) }; }
      if (command === 'arcade_listing_pubkey') { up.push([command]); return 'e'.repeat(64); }
      if (command === 'arcade_listing_publish') { up.push([command, JSON.parse(args.content)]); return { published: 1 }; }
      if (command === 'report_send') { up.push([command, args]); return { sent: true }; }
      if (command === 'arcade_catalog_sources') return structuredClone(src);
      if (command === 'arcade_entry_reachable') return true;
      if (command === 'market_browse') return [];
      if (command === 'arcade_pay') { pays.push(args); return { txid: 'ab'.repeat(32) }; }
      if (command === 'arcade_ack') return null;
      return inner(command, args);
    };
    window.__TAURI_INTERNALS__.invoke = extra;
    window.__TAURI__.core.invoke = extra;
  }, sources, scan, UP_SELLER);
  await page.goto(origin + '/', { waitUntil: 'networkidle0' });
  await page.waitForFunction(() => document.querySelector('#page-home.on') && !document.documentElement.hasAttribute('data-ravi-arriving'), { timeout: 20000 });
  await page.evaluate(() => { document.querySelector('nav')?.classList.add('more-open'); document.querySelector('nav a[data-page="trade"]').click(); });
  await page.waitForFunction(() => document.querySelector('#page-trade.on') && document.querySelector('#ar-host .ar-head'));
  await page.waitForFunction(() => !/가져오는 중/.test(document.querySelector('#ar-host').textContent), { timeout: 10000 });
  return page;
}
const shot = (page, name) => { mkdirSync(dirname(join(shotDir, name)), { recursive: true }); return page.screenshot({ path: join(shotDir, name), fullPage: false }); };
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
      await page.waitForSelector('#ar-host [data-ar-play]');
      // 게임 페이지에서도 값이 가장 큰 글(제목보다 크다)
      const [big, h] = await page.$eval('#ar-host .ar-page', e => [parseFloat(getComputedStyle(e.querySelector('.ar-big')).fontSize), parseFloat(getComputedStyle(e.querySelector('h3')).fontSize)]);
      assert.ok(big >= 28 && big > h, `값 ${big}px · 제목 ${h}px`);
      assert.deepEqual(await noWrapButtons(page), []);
      await shot(page, `arcade-game-${width}.png`);
      await page.click('#ar-host [data-ar-play]');
      await page.waitForSelector('#ar-host iframe.ar-frame');
      const frame = await page.$eval('#ar-host iframe.ar-frame', f => ({ sandbox: f.getAttribute('sandbox'), src: f.src, ref: f.getAttribute('referrerpolicy') }));
      assert.equal(frame.sandbox, 'allow-scripts'); assert.equal(frame.ref, 'no-referrer');
      assert.ok(frame.src.startsWith(A.ARCADE_LINK_BASE + cidOf(1) + '/'));
      // 게임이 「한 판 넣기」를 묻는다 → 작은 확인 칸(아직 보내지 않음)
      await page.waitForSelector('#ar-host [data-ar-coin]:not([hidden]) [data-ar-go]', { timeout: 8000 });
      const coin = await page.$eval('#ar-host [data-ar-coin]', e => e.textContent);
      assert.match(coin, /한 판 1\sRVN 넣기/); assert.match(coin, /0\.99/); assert.match(coin, /0\.01/); assert.ok(coin.includes(seller));
      assert.deepEqual(await page.evaluate(() => window.__arcadePays), [], '묻기만 하고 보내지 않았다');
      // 창 자신(게임 iframe 아님)이 보낸 ask 는 무시된다
      await page.evaluate(() => window.postMessage({ type: 'rv-arcade', v: 1, ask: 'credit' }, '*'));
      assert.deepEqual(await noWrapButtons(page), []);
      await page.$eval('#ar-host [data-ar-stage]', e => e.scrollIntoView());
      await shot(page, `arcade-coin-${width}.png`);
      await page.click('#ar-host [data-ar-coin] [data-ar-go]');
      const gameFrame = await (await page.$('#ar-host iframe.ar-frame')).contentFrame();
      await gameFrame.waitForFunction(() => /^PLAYING /.test(document.getElementById('s').textContent), { timeout: 8000 });
      let pays = await page.evaluate(() => window.__arcadePays);
      assert.equal(pays.length, 1);
      assert.deepEqual([pays[0].payTo, pays[0].sellerAtoms, pays[0].feeAtoms, pays[0].priceAtoms], [seller, 99_000_000, 1_000_000, 100_000_000]);
      await page.$eval('#ar-host [data-ar-stage]', e => e.scrollIntoView());
      await shot(page, `arcade-playing-${width}.png`);
      // 한 판 끝 → 「한 판 더」 ask → 다시 사람에게 묻는다(자동 결제 없음). 그만두면 게임에 declined.
      await gameFrame.click('#end');
      await page.waitForSelector('#ar-host [data-ar-coin]:not([hidden]) [data-ar-stop]', { timeout: 8000 });
      assert.equal((await page.evaluate(() => window.__arcadePays)).length, 1, '두 번째 판은 아직 안 보냈다');
      await page.click('#ar-host [data-ar-coin] [data-ar-stop]');
      await gameFrame.waitForFunction(() => /NO CREDIT declined/.test(document.getElementById('s').textContent), { timeout: 5000 });
      assert.equal((await page.evaluate(() => window.__arcadePays)).length, 1);
      assert.deepEqual(page.__errors ?? [], []);
      await page.close();
    }
  });
}

for (const width of [1120, 1440]) {
  test(`게임 올리기 ${width}: 폴더 → 검사 → 확인 칸(소각 5 RVN) → 「올리기」 뒤에만 붙잡기·서명·발행`, async () => {
    const page = await openMarket({ width, sources: { assets: [], docs: {} } });
    await page.click('#ar-host [data-ar-upload]');
    await page.waitForSelector('#ar-host [data-up-pick]');
    await page.click('#ar-host [data-up-pick]');
    await page.waitForSelector('#ar-host [data-up-review]');
    assert.match(await page.$eval('#ar-host [data-up-check]', e => e.textContent), /폴더 검사를 통과했어요/);
    // 첫 칸은 「일반 판매자(0 RVN)」 — 확인 판매자 길은 내 가게를 골라야 한다.
    assert.equal(await page.$eval('#ar-host [data-up-target]', e => e.value), 'open:new');
    await page.select('#ar-host [data-up-target]', 'new:TESTARCADE');
    await page.type('#ar-host [data-up-title]', 'Star Run');
    assert.equal(await page.$eval('#ar-host [data-up-tag]', e => e.value), 'STAR_RUN');
    await page.type('#ar-host [data-up-price]', '0.5');
    assert.deepEqual(await noWrapButtons(page), []);
    assert.ok(await overflowX(page) <= 1);
    await shot(page, `upload/upload-form-${width}.png`);
    await page.click('#ar-host [data-up-review]');
    await page.waitForSelector('#ar-host [data-up-go]');
    const box = await page.$eval('#ar-host .ar-confirm', e => e.textContent);
    assert.match(box, /RVLT\/TESTARCADE#STAR_RUN/); assert.match(box, /5 RVN/);
    assert.equal(await page.$eval('#ar-host [data-up-go]', b => b.disabled), true);
    assert.deepEqual(await page.evaluate(() => window.__upCalls.map(c => c[0])), ['arcade_pick_folder'], '확인 전에는 고르기만');
    await page.$eval('#ar-host .ar-confirm', e => e.scrollIntoView());
    await shot(page, `upload/upload-confirm-${width}.png`);
    await page.click('#ar-host [data-up-agree]');
    await page.click('#ar-host [data-up-go]');
    await page.waitForFunction(() => /올렸어요/.test(document.querySelector('#ar-host [data-up-step]').textContent), { timeout: 8000 });
    const calls = await page.evaluate(() => window.__upCalls);
    assert.deepEqual(calls.map(c => c[0]), ['arcade_pick_folder', 'new_address', 'arcade_pin_folder', 'sign_message', 'ipfs_add_file', 'issue_asset']);
    const issue = calls.at(-1)[1];
    assert.deepEqual(issue, { name: 'RVLT/TESTARCADE#STAR_RUN', qty: 1, units: 0, reissuable: false, ipfsHash: 'Qm' + '4'.repeat(44), toAddress: null });
    await page.$eval('#ar-host [data-up-step]', e => e.scrollIntoView());
    await shot(page, `upload/upload-done-${width}.png`);
    assert.deepEqual(page.__errors ?? [], []);
    await page.close();
  });

  test(`게임 올리기 ${width}: 공유 사이트에서 막힐 폴더는 올리지 않는다 · 어둡게`, async () => {
    const page = await openMarket({ width, theme: 'dark', sources: { assets: [], docs: {} }, scan: UP_BAD });
    await page.click('#ar-host [data-ar-upload]');
    await page.waitForSelector('#ar-host [data-up-pick]');
    await page.click('#ar-host [data-up-pick]');
    await page.waitForSelector('#ar-host [data-up-review]');
    const t = await page.$eval('#ar-host [data-up-check]', e => e.textContent);
    assert.match(t, /이대로는 올릴 수 없어요/); assert.match(t, /cdn\.example\.com/);
    await page.type('#ar-host [data-up-title]', 'Cdn Game');
    await page.click('#ar-host [data-up-review]');
    assert.equal(await page.$('#ar-host [data-up-go]'), null, '확인 칸이 열리지 않는다');
    await shot(page, `upload/upload-blocked-${width}-dark.png`);
    await page.close();
  });
}


// ── 11-13 일반 판매자(0 RVN) ─────────────────────────────────────────────
const OPEN_KEY = A.secp256k1.utils.randomPrivateKey(), OPEN_SELLER = A.addressOfPublicKey(A.secp256k1.getPublicKey(OPEN_KEY, true));
const OPEN_NOSTR = A.schnorr.utils.randomPrivateKey();
const openDoc = A.signArcadeProductForTest({ format: 'rv-arcade-product', v: 1, kind: 'arcade-game', id: 'apple-catch', version: 1, title: 'Apple Catch', description: 'Test document signed with a throwaway key.',
  priceSats: '10000000', seller: OPEN_SELLER, payTo: OPEN_SELLER, feeBps: A.ARCADE_FEE_BPS, entry: 'index.html', cid: cidOf(9),
  files: [{ path: 'index.html', sha256: A.sha256Hex(A.utf8('h')), size: 1 }], x: { arcade: { mode: 'solo', network: 'none', minutes: 2, genre: 'casual' } } }, OPEN_KEY);
const OPEN_CID = 'Qm' + '5'.repeat(44);
const openEvent = A.signArcadeListingForTest({ seller: OPEN_SELLER, id: 'apple-catch', version: 1, docCid: OPEN_CID, docHash: A.arcadeDocHash(openDoc), at: Math.floor(Date.now() / 1000) - 60, state: 'open' }, OPEN_KEY, OPEN_NOSTR);
const BOTH = { ...FULL, open: { events: [openEvent], docs: { [OPEN_CID]: Buffer.from(A.encodeArcadeProduct(openDoc)).toString('base64') }, hidden: { format: 'rv-arcade-hidden', v: 1, games: [], sellers: [], docs: [] } } };

for (const width of [1120, 1440]) {
  test(`일반 판매자 ${width}: 「일반 판매자」 글 · 첫 결제 전 한 번 안내 · 신고하면 곧바로 숨김`, async () => {
    for (const theme of ['light', 'dark']) {
      const page = await openMarket({ width, theme, sources: BOTH });
      assert.equal(await page.$$eval('#ar-host .ar-row .ar-card', l => l.length), 4);
      const last = await page.$eval('#ar-host .ar-row li:last-child', e => e.textContent);
      assert.match(last, /Apple Catch/); assert.match(last, /일반 판매자/);
      await page.click('#ar-host [data-ar-more]');
      await page.waitForSelector('#ar-host [data-ar-all] .ar-grid');
      const heads = await page.$$eval('#ar-host [data-ar-all] h4', l => l.map(h => h.textContent));
      assert.deepEqual(heads, ['레이븐볼트 확인 판매자', '일반 판매자 게임']);
      await shot(page, `desktop-open-all-${width}-${theme}.png`);
      await page.click('#ar-host [data-ar-open$="/apple-catch"]');
      await page.waitForSelector('#ar-host [data-ar-play]');
      assert.match(await page.$eval('#ar-host .ar-page', e => e.textContent), /누구나 0 RVN 으로 올릴 수 있는 일반 판매자 게임이에요/);
      await page.click('#ar-host [data-ar-play]');
      await page.waitForSelector('#ar-host .ar-open-notice [data-ar-notice-ok]');
      assert.equal(await page.$('#ar-host iframe.ar-frame'), null, '안내를 확인하기 전에는 게임을 열지 않는다');
      assert.deepEqual(await noWrapButtons(page), []);
      assert.ok(await overflowX(page) <= 1);
      await shot(page, `desktop-open-notice-${width}-${theme}.png`);
      await page.click('#ar-host [data-ar-notice-ok]');
      await page.waitForSelector('#ar-host iframe.ar-frame');
      assert.ok((await page.$eval('#ar-host iframe.ar-frame', f => f.src)).startsWith(A.ARCADE_LINK_BASE + OPEN_CID + '/'));
      await page.click('#ar-host [data-ar-close]');
      // 두 번째로 열면 안내 없이 바로
      await page.click('#ar-host [data-ar-play]');
      await page.waitForSelector('#ar-host iframe.ar-frame');
      await page.click('#ar-host [data-ar-close]');
      // 신고
      await page.click('#ar-host [data-ar-report]');
      await page.waitForSelector('#ar-host [data-ar-rep="scam"]');
      assert.equal(await page.$eval('#ar-host [data-ar-rep-go]', b => b.disabled), true);
      await page.click('#ar-host [data-ar-rep="scam"]');
      assert.deepEqual(await noWrapButtons(page), []);
      await page.$eval('#ar-host [data-ar-report-box]', e => e.scrollIntoView());
      await shot(page, `desktop-open-report-${width}-${theme}.png`);
      await page.click('#ar-host [data-ar-rep-go]');
      await page.waitForFunction(() => /이 게임은 내 화면에서 숨겨졌어요/.test(document.querySelector('#ar-host').textContent));
      const rep = (await page.evaluate(() => window.__upCalls)).find(c => c[0] === 'report_send')[1];
      assert.equal(rep.category, 'counterparty'); assert.equal(rep.context.game, `${OPEN_SELLER}/apple-catch`); assert.equal(rep.context.listing, 'open'); assert.equal(rep.attachLog, false);
      assert.ok(!(await page.$eval('#ar-host', e => e.textContent)).includes('Apple Catch'), '신고한 게임은 곧바로 사라진다');
      assert.deepEqual(page.__errors ?? [], []);
      await page.close();
    }
  });

  test(`일반 판매자로 올리기 ${width}: 0 RVN · 체인 명령 없음 · 알림 쪽지 · 어둡게도`, async () => {
    for (const theme of ['light', 'dark']) {
      const page = await openMarket({ width, theme, sources: { assets: [], docs: {} } });
      await page.click('#ar-host [data-ar-upload]');
      await page.waitForSelector('#ar-host [data-up-pick]');
      await page.click('#ar-host [data-up-pick]');
      await page.waitForSelector('#ar-host [data-up-review]');
      assert.equal(await page.$eval('#ar-host [data-up-target]', e => e.value), 'open:new');
      await page.type('#ar-host [data-up-title]', 'Star Run');
      await page.type('#ar-host [data-up-price]', '0.5');
      await shot(page, `desktop-open-upload-form-${width}-${theme}.png`);
      await page.click('#ar-host [data-up-review]');
      await page.waitForSelector('#ar-host [data-up-go]');
      const box = await page.$eval('#ar-host .ar-confirm', e => e.textContent);
      assert.match(box, /일반 판매자/); assert.match(box, /없음 \(0 RVN · 체인 거래 없음\)/); assert.match(box, /켜 두어야/);
      assert.equal(await page.$eval('#ar-host [data-up-go]', b => b.disabled), true, '「읽었어요」 전에는 잠김');
      assert.deepEqual(await noWrapButtons(page), []);
      assert.ok(await overflowX(page) <= 1);
      await page.$eval('#ar-host .ar-confirm', e => e.scrollIntoView());
      await shot(page, `desktop-open-upload-confirm-${width}-${theme}.png`);
      await page.click('#ar-host [data-up-agree]');
      await page.click('#ar-host [data-up-go]');
      await page.waitForFunction(() => /올렸어요/.test(document.querySelector('#ar-host [data-up-step]').textContent), { timeout: 8000 });
      const calls = await page.evaluate(() => window.__upCalls);
      assert.deepEqual(calls.map(c => c[0]).filter(c => c !== 'new_address'), ['arcade_pick_folder', 'arcade_pin_folder', 'sign_message', 'ipfs_add_file', 'arcade_listing_pubkey', 'sign_message', 'arcade_listing_publish']);
      const content = calls.find(c => c[0] === 'arcade_listing_publish')[1];
      assert.deepEqual([content.kind, content.id, content.version, content.docCid, content.state, content.seller], ['rv.arcade-listing/1', 'star-run', 1, 'Qm' + '4'.repeat(44), 'open', UP_SELLER]);
      assert.ok(!calls.some(c => ['issue_asset', 'reissue'].includes(c[0])));
      await page.$eval('#ar-host [data-up-step]', e => e.scrollIntoView());
      await shot(page, `desktop-open-upload-done-${width}-${theme}.png`);
      assert.deepEqual(page.__errors ?? [], []);
      await page.close();
    }
  });
}
