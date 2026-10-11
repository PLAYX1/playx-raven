// 가게 토큰 이름 — 실제 Chrome 에서 빌드된 dist 를 합성 자료(desktop-fixture)로 띄워 본다.
// ① 새 가게 만들기: 이름 칸에 적은 글이 RV.S.<이름> 으로 바뀌고, 규칙 안내 한 줄이 보이고, 규칙 위반은 노드에 묻기 전에 멈춘다.
// ② 아티스트 화면 「팔로우 토큰」: SHOP.PLAYX 고정 대신 「이 가게의 토큰 이름」(shop.json chain_asset)을 읽는다 — 옛 가게·새 가게 둘 다.
// 노드·지갑·IPFS·체인은 부르지 않는다. shop_name_free·shop_load·list_assets 는 이 하네스가 답한다(발행 명령은 부르면 실패).
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { mkdtempSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve, join, extname, sep } from 'node:path';
import { tmpdir } from 'node:os';
import puppeteer from 'puppeteer-core';
import { installFixture } from './desktop-fixture.mjs';

const root = resolve(import.meta.dirname, '..');
let work, dist, browser, server, origin;

before(async () => {
  work = mkdtempSync(join(tmpdir(), 'rv-shop-token-ui-'));
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
after(async () => { await browser?.close(); server?.close(); if (work) rmSync(work, { recursive: true, force: true }); });

function installShopHarness({ chainAsset, held, detect }) {
  const base = window.__TAURI_INTERNALS__.invoke;
  const asked = window.__askedNames = [];
  window.__TAURI_INTERNALS__.invoke = async (cmd, args) => {
    if (cmd === 'shop_load') return { name: '동네 가게', chain_asset: chainAsset, currency: 'KRW', hours: [], menu: [] };
    if (cmd === 'shop_detect_asset') return { asset: detect ?? null, candidates: detect ? [detect] : [] };
    if (cmd === 'list_assets') return held.map(([name, amount]) => ({ name, root: name.split('/')[0], amount, mine: true, units: 8, reissuable: true, ipfs_hash: null }));
    if (cmd === 'shop_name_free') { asked.push(args?.name); return true; }
    if (cmd === 'artist_profile_get') return { name: '', about: '', picture: '', website: '' };
    if (cmd === 'artist_check') return { ok: true };
    if (/issue|ipfs_add/.test(cmd)) throw Error('shop-token harness: no issuing');
    return base(cmd, args);
  };
  window.__TAURI__.core.invoke = window.__TAURI_INTERNALS__.invoke;
}

async function openApp(harness, lang = 'ko') {
  const page = await browser.newPage();
  page.on('pageerror', e => { page.__errors = [...(page.__errors ?? []), e.message]; });
  await page.setViewport({ width: 1440, height: 900 });
  await page.setRequestInterception(true);
  page.on('request', r => (new URL(r.url()).origin === origin && r.method() === 'GET') ? r.continue() : r.abort());
  await page.evaluateOnNewDocument(installFixture, { theme: 'light', sales: true, seller: true });
  await page.evaluateOnNewDocument(installShopHarness, harness);
  if (lang !== 'ko') await page.evaluateOnNewDocument(l => localStorage.setItem('playx-raven-lang', l), lang);
  await page.goto(origin + '/', { waitUntil: 'networkidle0' });
  await page.waitForFunction(() => document.querySelector('#page-home.on') && !document.documentElement.hasAttribute('data-ravi-arriving'), { timeout: 20000 });
  await page.evaluate(() => document.querySelector('nav')?.classList.add('more-open'));
  return page;
}
const text = (page, sel) => page.$eval(sel, el => el.textContent.trim());

test('새 가게 만들기 — RV.S.<이름> 으로 바뀌고 규칙 안내가 보인다', async () => {
  const page = await openApp({ chainAsset: '', held: [], detect: null });
  await page.click('nav a[data-page="shop"]');
  await page.waitForFunction(() => document.querySelector('#page-shop.on'));
  assert.match(await text(page, '#sh-assetrule'), /RV\.S\.가게이름/);
  assert.equal(await page.$eval('#sh-asset', el => el.readOnly), false, '아직 등록 안 한 가게는 칸이 열려 있다');
  // 칸이 접힌 단계 안에 있을 수 있어 키보드 대신 값과 input 사건을 넣는다(화면의 실제 듣는 사건).
  const typeName = v => page.$eval('#sh-asset', (el, v) => { el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); }, v);
  await typeName('강남 카페');
  await page.waitForFunction(() => /RV\.S\.GANGNAM_KAPE/.test(document.querySelector('#sh-assetcheck').textContent), { timeout: 5000 })
    .catch(async e => { throw Error(e.message + ' · 칸=' + JSON.stringify(await page.evaluate(() => [document.querySelector('#sh-asset').value, document.querySelector('#sh-assetcheck').innerHTML, window.__askedNames]))); });
  assert.equal(await text(page, '#sh-confirmname'), 'RV.S.GANGNAM_KAPE');
  assert.deepEqual(await page.evaluate(() => window.__askedNames), ['RV.S.GANGNAM_KAPE'], '노드에는 만든 전체 이름으로 묻는다');
  // 예약어는 노드에 묻기 전에 멈춘다.
  await typeName('RVN');
  await page.waitForFunction(() => /RVN·RAVEN·RAVENCOIN/.test(document.querySelector('#sh-assetcheck').textContent), { timeout: 5000 });
  assert.equal(await page.$eval('#sh-confirmbox', el => el.style.display), 'none');
  assert.equal(await page.evaluate(() => window.__askedNames.length), 1, '예약어 이름은 노드에 안 묻는다');
  assert.deepEqual(page.__errors ?? [], []);
  await page.close();
});

for (const [label, chainAsset, other] of [['옛 가게 SHOP.PLAYX', 'SHOP.PLAYX', 'RV.S.KIMBAP'], ['새 가게 RV.S.KIMBAP', 'RV.S.KIMBAP', 'SHOP.PLAYX']]) {
  test(`팔로우 토큰 — ${label} 는 자기 토큰 수량을 본다(섞여 있어도)`, async () => {
    // 지갑에 옛 것과 새 것이 둘 다 있어도 「이 가게의 토큰」 하나만 센다.
    const page = await openApp({ chainAsset, held: [[chainAsset, 20999999990], [other, 5]], detect: null });
    await page.click('nav a[data-page="artist"]');
    await page.waitForFunction(() => document.querySelector('#page-artist.on'));
    await page.waitForFunction(c => document.querySelector('#ar-shopqty').textContent.startsWith(c), { timeout: 8000 }, chainAsset);
    const q = await text(page, '#ar-shopqty');
    assert.match(q, /개 남음$/);
    assert.ok(!q.includes(other), q);
    assert.deepEqual(page.__errors ?? [], []);
    await page.close();
  });
}

test('팔로우 토큰 — shop.json 이 비었으면 지갑 주인 표 하나로 찾고, 없으면 가게 등록으로 안내', async () => {
  const found = await openApp({ chainAsset: '', held: [['RV.S.KIMBAP', 7]], detect: 'RV.S.KIMBAP' });
  await found.click('nav a[data-page="artist"]');
  await found.waitForFunction(() => /^RV\.S\.KIMBAP\s+7개 남음/.test(document.querySelector('#ar-shopqty').textContent), { timeout: 8000 });
  await found.close();
  const none = await openApp({ chainAsset: '', held: [['SHOP.PLAYX', 3]], detect: null });
  await none.click('nav a[data-page="artist"]');
  await none.waitForFunction(() => /아직 공개 장부에 올린 가게가 없습니다/.test(document.querySelector('#ar-shopqty').textContent), { timeout: 8000 });
  assert.doesNotMatch(await text(none, '#ar-shopqty'), /SHOP\.PLAYX/, '남의(또는 고르지 못한) 가게 토큰을 지어내지 않는다');
  await none.click('#ar-give');
  await none.waitForFunction(() => document.querySelector('#page-shop.on'), { timeout: 5000 });
  await none.close();
});

test('영어 화면 — 자리표시자에 가게 토큰 이름이 들어간다', async () => {
  const page = await openApp({ chainAsset: 'RV.S.KIMBAP', held: [['RV.S.KIMBAP', 12]], detect: null }, 'en');
  await page.click('nav a[data-page="artist"]');
  await page.waitForFunction(() => /^RV\.S\.KIMBAP\s+12 left$/.test(document.querySelector('#ar-shopqty').textContent.trim()), { timeout: 8000 });
  await page.click('nav a[data-page="shop"]');
  await page.waitForFunction(() => /RV\.S\.SHOPNAME/.test(document.querySelector('#sh-assetrule').textContent), { timeout: 5000 });
  await page.close();
});

test('옛 가게 읽기 — 이미 올린 SHOP.PLAYX 는 그 이름 그대로 잠기고, 새 규칙으로 바꾸라고 하지 않는다', async () => {
  for (const [chainAsset, short] of [['SHOP.PLAYX', 'PLAYX'], ['RV.S.KIMBAP', 'KIMBAP']]) {
    const page = await openApp({ chainAsset, held: [[chainAsset, 1]], detect: null });
    await page.click('nav a[data-page="shop"]');
    await page.waitForFunction(() => document.querySelector('#page-shop.on'));
    await page.waitForFunction(() => document.querySelector('#sh-assetlocked'), { timeout: 8000 });
    assert.equal(await page.$eval('#sh-asset', el => el.value), short);
    assert.equal(await page.$eval('#sh-asset', el => el.readOnly), true);
    assert.match(await text(page, '#sh-assetlocked'), new RegExp(`이 가게의 토큰: ${chainAsset.replace(/\./g, '\\.')}$`));
    assert.deepEqual(await page.evaluate(() => window.__askedNames), [], '잠긴 가게는 이름을 다시 묻지 않는다');
    await page.close();
  }
});
