// 홈 「입금 대기」 줄 → 주문 목록 시트. 가짜 invoke 만 쓴다(ledger_pending 2건/0건/오류). 지갑·외부 네트워크 없음.
import assert from 'node:assert/strict';
import { readFileSync, existsSync, mkdtempSync } from 'node:fs';
import { resolve, extname } from 'node:path';
import { tmpdir } from 'node:os';
import puppeteer from 'puppeteer-core';
const root = resolve(import.meta.dirname, '..'), dist = resolve(root, 'dist');
const origin = 'http://rv-home-pending-fixture.test';
const types = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const now = Math.floor(Date.now() / 1000);
const ORDERS = [
  { address: 'Raaa', items: [{ name: '아메리카노, 아이스', price: 4500, qty: 2 }], krw: 9000, currency: 'KRW', rvn: 1234.5, quoted_at: now - 300, table: '3', shop: '본점' },
  { address: 'Rbbb', items: [{ name: '케이크', price: 6000, qty: 1 }], krw: 6000, currency: 'KRW', rvn: 800, quoted_at: now - 90000, table: null, shop: '본점' },
];
let browser, fails = 0;
async function scenario(mode, run) {
  const profile = mkdtempSync(resolve(tmpdir(), 'rv-pend-'));
  const ctx = await browser.createBrowserContext(); const page = await ctx.newPage(); const errors = []; if (process.env.DBG) page.on('console', m => console.log('console:', m.text().slice(0, 200)));
  page.on('pageerror', e => { errors.push(e.message); if (process.env.DBG) console.log(e.stack); });
  await page.setViewport({ width: 1440, height: 900 });
  await page.setRequestInterception(true);
  page.on('request', request => {
    const url = request.url();
    if (url.startsWith('data:')) return void request.continue();
    if (!url.startsWith(origin + '/')) return void request.abort();
    const path = new URL(url).pathname;
    if (path.startsWith('/api/')) return void request.respond({ status: 200, contentType: 'application/json', body: '{}' });
    const file = resolve(dist, '.' + (path === '/' ? '/index.html' : path));
    if (!file.startsWith(dist + '/') || !existsSync(file)) return void request.respond({ status: 404, body: '' });
    void request.respond({ status: 200, contentType: types[extname(file)] || 'application/octet-stream', body: readFileSync(file) });
  });
  await page.evaluateOnNewDocument((mode, orders) => {
    localStorage.setItem('playx-raven-lang', 'ko');
    window.__TAURI_INTERNALS__ = { invoke: async (c) => {
      if (c === 'shop_load') return { name: '테스트가게' };
      if (c === 'ledger_range') return { total: 9000, currency: 'KRW', sales: 3, rows: [] };
      if (c === 'ledger_pending') {
        if (mode === 'error') throw new Error('boom');
        return mode === 'zero' ? { count: 0, orders: [] } : { count: orders.length, orders };
      }
      if (c === 'node_status') return { blocks: 1, headers: 1, progress: 1, peers: 1 };
      if (c === 'plugin:app|version') return '0.9.5';
      if (['list_assets', 'pin_list', 'my_channels', 'recent_transactions'].includes(c)) return [];
      return null;
    }, transformCallback: f => f, metadata: {} };
  }, mode, ORDERS);
  await page.goto(origin, { waitUntil: 'networkidle0' });
  await page.addStyleTag({ content: '#onboard,#hello{display:none!important}' });
  for (let i = 0; i < 100 && await page.evaluate(() => document.documentElement.hasAttribute('data-ravi-arriving')); i++) await sleep(100); // 라비 첫 도착 장벽이 걷힐 때까지(그 전 클릭은 보류된다)
  assert.equal(await page.evaluate(() => document.documentElement.hasAttribute('data-ravi-arriving')), false, '라비 도착 장벽이 안 걷힘');
  for (let i = 0; i < 100 && !(await page.$('#rv-home-today-body .rv-home-entry')); i++) await sleep(100);
  try { if (process.env.DBG) console.log('BODY', mode, await page.$eval('#rv-home-today-body', e => e.innerHTML.slice(0, 200)), await page.$eval('#rv-home-today', e => e.hidden)); await run(page); console.log('ok  ', mode); }
  catch (e) { fails++; console.log('FAIL', mode, e.message, '| errors:', errors.join(' // ')); }
  const real = errors.filter(m => !/reading 'node'/.test(m)); if (errors.length !== real.length) console.log('  (가짜 invoke 가 null 을 준 기존 화면의 무관한 오류 무시)'); assert.deepEqual(real, [], 'pageerror: ' + real.join('|'));
  await ctx.close();
}
const sheetOpen = p => p.$eval('#pendsheet', e => !e.classList.contains('hidden'));
try {
  browser = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true, userDataDir: mkdtempSync(resolve(tmpdir(), 'rv-pend-prof-')) });
  await scenario('two', async page => {
    const btn = await page.$('#rv-home-today-body button[data-pend="list"]');
    assert.ok(btn, '입금 대기 줄이 버튼');
    assert.match(await page.$eval('#rv-home-today-body button[data-pend="list"]', e => e.textContent), /입금 대기\s*2/);
    assert.equal(await sheetOpen(page), false);
    await page.focus('#rv-home-today-body button[data-pend="list"]'); await page.keyboard.press('Enter'); // 키보드
    for (let i = 0; i < 30 && !(await sheetOpen(page)); i++) await sleep(100);
    assert.equal(await sheetOpen(page), true, '시트 열림');
    const txt = await page.$eval('#ps-list', e => e.innerText);
    assert.match(txt, /아메리카노, 아이스 × 2/); assert.match(txt, /케이크/);
    assert.match(txt, /5분 전/); assert.match(txt, /9,000 KRW/); assert.match(txt, /1,234\.5 RVN/);
    assert.match(txt, /아직 확인되지 않았습니다/); assert.match(txt, /테이블 3/);
    assert.equal((txt.match(/오래 기다림/g) || []).length, 1, '24시간 넘은 1건만 표시');
    assert.ok(txt.indexOf('아메리카노') < txt.indexOf('케이크'), '최근 것 먼저');
    await page.keyboard.press('Escape');
    for (let i = 0; i < 30 && (await sheetOpen(page)); i++) await sleep(100);
    assert.equal(await sheetOpen(page), false, 'Esc 로 닫힘');
    await page.click('#rv-home-today-body button[data-pend="list"]'); await sleep(200);
    await page.evaluate(() => document.getElementById('hp-go').click());
    await sleep(300);
    assert.equal(await sheetOpen(page), false);
    assert.equal(await page.$eval('#page-shop', e => e.classList.contains('on')), true, '매출(가게) 화면으로 이동');
  });
  await scenario('zero', async page => {
    assert.equal(await page.$('#rv-home-today-body button[data-pend]'), null, '0건은 누를 수 없음');
    assert.match(await page.$eval('#rv-home-today-body', e => e.innerText), /입금 대기\s*0/);
  });
  await scenario('error', async page => {
    const b = await page.$('#rv-home-today-body button[data-pend="sales"]');
    assert.ok(b); assert.match(await page.$eval('#rv-home-today-body button[data-pend="sales"]', e => e.textContent), /확인 못 함/);
    await page.evaluate(() => document.querySelector('#rv-home-today-body button[data-pend="sales"]').click()); await sleep(300);
    assert.equal(await sheetOpen(page), false, '시트 안 열림');
    assert.equal(await page.$eval('#page-shop', e => e.classList.contains('on')), true, '매출 화면으로');
  });
} finally { await browser?.close(); }
if (fails) { console.log(`${fails}개 실패`); process.exit(1); }
console.log('홈 입금 대기 목록 시험 통과');
