// 11-13 가게 링크 두 갈래 — 화면 찍기(사람 눈 검사용, 시험 아님). 합성 자료 · 노드·지갑·네트워크 없음.
//   RV_DIST=<dist> RV_SHOTS=<폴더> node scripts/shop-link-shots.mjs
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { mkdirSync } from 'node:fs';
import { resolve, join, extname, sep } from 'node:path';
import puppeteer from 'puppeteer-core';
import { installFixture } from './desktop-fixture.mjs';

const dist = resolve(process.env.RV_DIST || 'dist');
const SHOTS = resolve(process.env.RV_SHOTS || 'artifacts/shop-link');
mkdirSync(SHOTS, { recursive: true });
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.webp': 'image/webp', '.json': 'application/json' };
const server = createServer(async (req, res) => {
  try {
    const path = resolve(dist, '.' + decodeURIComponent(new URL(req.url, 'http://x').pathname));
    if (path !== dist && !path.startsWith(dist + sep)) throw Error('path');
    const file = path === dist ? join(dist, 'index.html') : path;
    if (!(await stat(file)).isFile()) throw Error('file');
    res.writeHead(200, { 'Content-Type': types[extname(file)] || 'application/octet-stream' }); res.end(await readFile(file));
  } catch { res.writeHead(404); res.end(); }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true, args: ['--no-first-run', '--disable-background-networking'] });
const FREE = 'https://ravenvault.ex.erci.se/s/homefit-shop-ymr3qhcu';
const TUNNEL = 'https://quiet-river-1234.trycloudflare.com';

async function open(width, height, { registered = false, saved = '' } = {}) {
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.log('pageerror', String(e)));
  await page.setViewport({ width, height });
  await page.setRequestInterception(true);
  page.on('request', (r) => ((new URL(r.url()).origin === origin && r.method() === 'GET') ? r.continue() : r.abort()));
  await page.evaluateOnNewDocument(installFixture, { theme: process.env.RV_THEME || 'light', sales: true, seller: true });
  await page.evaluateOnNewDocument((d) => {
    localStorage.setItem('rv-v2-backup-reminded', '1'); localStorage.setItem('playx-raven-lang', 'ko');
    localStorage.setItem('rv.tailscale.suggest.dismissed', '1');
    const real = window.__TAURI_INTERNALS__.invoke;
    window.__TAURI_INTERNALS__.invoke = async (cmd, args) => {
      if (cmd === 'map_load') return { registered: d.registered, name: '동네 가게', category: 'cafe', area: 'wydk9', shop_url: d.saved || d.FREE, free_link: d.FREE, tunnel_url: d.TUNNEL, issuer: 'RMem8GvhCRTBMi7Gr1ZaC4xfEr1RFCRBbR', areas: [], categories: [] };
      if (cmd === 'map_check') { const u = (args?.draft?.shop_url || '').trim(); return { problems: [], preview: { name: args.draft.name, category: args.draft.category, area: args.draft.area, shopUrl: u || undefined }, temporary_url: u.includes('.trycloudflare.com'), free_link: u === d.FREE, no_url: !u }; }
      if (cmd === 'map_status') return { registered: d.registered, closed: false, beat_ok_at: d.registered ? Math.floor(Date.now() / 1000) - 120 : 0, card_ok_at: 0, last_error: '', free_link: true };
      return real(cmd, args);
    };
  }, { FREE, TUNNEL, registered, saved });
  await page.goto(origin + '/', { waitUntil: 'networkidle0' });
  await page.waitForFunction(() => document.querySelector('#page-home.on'), { timeout: 20000 });
  await page.evaluate(() => document.querySelector('nav a[data-page="shop"]')?.click());
  await page.evaluate(() => document.querySelector('[data-shoptab="mine"]')?.click());
  await page.waitForFunction(() => document.getElementById('mp-free-url')?.textContent.includes('/s/'), { timeout: 15000 });
  await new Promise((r) => setTimeout(r, 500));
  return page;
}
const settle = (ms = 400) => new Promise((r) => setTimeout(r, ms));
async function shotCard(page, name, anchor = 'mp-url') {
  // 카드가 안쪽 굴림 칸에 있어 요소 찍기는 잘린다 — 「가게 링크」 칸을 화면 위로 올려 화면을 찍는다.
  await page.evaluate((id) => { const lab = document.querySelector('label[for="mp-url"]'); (id === 'mp-url' ? lab : document.getElementById(id))?.scrollIntoView({ block: 'start' }); }, anchor);
  await settle(300);
  await page.screenshot({ path: join(SHOTS, `${name}.png`) });
}
const W = Number(process.env.RV_WIDTH || 1120), H = 780;
{
  const page = await open(W, H);
  await shotCard(page, `free-${W}`);
  await page.evaluate(() => { document.getElementById('mp-opt-paid').open = true; });
  await settle();
  await shotCard(page, `paid-open-${W}`);
  await shotCard(page, `paid-open-tail-${W}`, 'mp-ts');
  const note = await page.$eval('#mp-urlnote', (e) => e.textContent);
  console.log('free note:', note);
  await page.close();
}
{
  const page = await open(W, H, { saved: TUNNEL });
  await settle(600);
  await shotCard(page, `temporary-${W}`);
  console.log('temporary note:', await page.$eval('#mp-urlnote', (e) => e.textContent));
  await page.evaluate(() => document.getElementById('mp-free-use').click());
  await settle(800);
  await shotCard(page, `after-use-${W}`);
  console.log('after use note:', await page.$eval('#mp-urlnote', (e) => e.textContent), '| url:', await page.$eval('#mp-url', (e) => e.value));
  await page.close();
}
await browser.close(); server.close();
