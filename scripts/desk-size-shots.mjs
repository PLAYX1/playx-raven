// 11-12 글자 크기 세 가지(한눈에 많이 · 보통 · 크게) + 왼쪽 연결 표시 — 화면 찍기(사람 눈 검사용, 시험 아님). 합성 자료 · 노드·지갑·네트워크 없음.
//   RV_DIST=<dist> RV_SHOTS=<폴더> node scripts/desk-size-shots.mjs [tag]
// 웹뷰 확대(set_text_zoom)는 브라우저에 없으니 「창 폭 ÷ 배율」 뷰포트 + 같은 배율 픽셀로 흉내 낸다 — 찍힌 그림은 창 1120px 그대로다.
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { mkdirSync } from 'node:fs';
import { resolve, join, extname, sep } from 'node:path';
import puppeteer from 'puppeteer-core';
import { installFixture } from './desktop-fixture.mjs';

const dist = resolve(process.env.RV_DIST || 'dist');
const SHOTS = resolve(process.env.RV_SHOTS || 'artifacts/desk-size');
const tag = process.argv[2] || 'after';
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
const ZOOM = { small: 1, normal: 1.15, large: 1.3 };
const settle = (ms = 500) => new Promise((r) => setTimeout(r, ms));

async function open(size, { W = 1120, H = 780, sync = 1, ask = false, page: where = 'home' } = {}) {
  const z = ZOOM[size];
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.log('pageerror', String(e)));
  await page.setViewport({ width: Math.round(W / z), height: Math.round(H / z), deviceScaleFactor: z });
  await page.setRequestInterception(true);
  page.on('request', (r) => ((new URL(r.url()).origin === origin && r.method() === 'GET') ? r.continue() : r.abort()));
  await page.evaluateOnNewDocument(installFixture, { theme: 'light', sales: true, seller: false });
  await page.evaluateOnNewDocument((d) => {
    localStorage.setItem('rv-v2-backup-reminded', '1'); localStorage.setItem('playx-raven-lang', 'ko');
    localStorage.setItem('rv-dots-open', '1');
    if (d.ask) localStorage.removeItem('ravenvault-text-size'); else localStorage.setItem('ravenvault-text-size', d.size);
    if (!d.ask) localStorage.setItem('ravenvault-text-size-asked', '1'); else localStorage.removeItem('rv-ravi-start-off');
    const real = window.__TAURI_INTERNALS__.invoke;
    window.__TAURI_INTERNALS__.invoke = async (cmd, args) => {
      if (cmd === 'node_status') return { progress: d.sync, blocks: 3480000, headers: 4000000, connections: 8, chain: 'main' };
      if (cmd === 'miner_running') return { running: false };
      if (cmd === 'ipfs_status') return { running: true };
      return real(cmd, args);
    };
  }, { size, sync, ask });
  await page.goto(origin + '/', { waitUntil: 'networkidle0' });
  await page.waitForFunction(() => document.querySelector('#page-home.on'), { timeout: 20000 });
  if (where !== 'home') { await page.evaluate((p) => document.querySelector(`nav a[data-page="${p}"]`)?.click(), where); }
  await settle(1500);
  return page;
}
const shot = (page, name, clip) => page.screenshot({ path: join(SHOTS, `${tag}-${name}.png`), ...(clip ? { clip } : {}) });
const railClip = async (page) => page.evaluate(() => { const n = document.querySelector('body > nav').getBoundingClientRect(); return { x: 0, y: Math.max(0, innerHeight - 340), width: n.width + 40, height: Math.min(340, innerHeight) }; });

for (const size of ['small', 'normal', 'large']) {
  for (const where of ['home', 'wallet']) {
    const page = await open(size, { page: where });
    await shot(page, `${where}-${size}-1120`);
    if (where === 'home') {
      await shot(page, `rail-${size}`, await railClip(page));
      const d = await page.evaluate(() => [...document.querySelectorAll('#d-node-row,#d-mine-row,#d-ipfs-row,#d-relay-row')].map((b) => ({ id: b.id, h: Math.round(b.getBoundingClientRect().height), text: b.textContent.trim(), title: b.title, aria: b.getAttribute('aria-label') })));
      console.log(size, JSON.stringify(d));
    }
    await page.close();
  }
}
{
  const page = await open('normal', { sync: 0.873 });
  await shot(page, 'rail-syncing', await railClip(page));
  console.log('sync bar hidden =', await page.evaluate(() => document.getElementById('d-node-bar').hidden), 'shown px =', await page.evaluate(() => document.getElementById('d-node-bar').getBoundingClientRect().height));
  await page.close();
}
{
  const page = await open('normal', { ask: true });
  await page.waitForFunction(() => { const c = document.getElementById('rv-ravi-card'); return c && !c.hidden && !document.querySelector('.ravi-arrival'); }, { timeout: 45000 }).catch(() => console.log('글씨 질문 카드 안 뜸'));
  await settle(500);
  await shot(page, 'ask-first-run');
  console.log('ask card =', await page.evaluate(() => document.getElementById('rv-ravi-card')?.textContent?.trim() || null));
  await page.evaluate(() => document.querySelector('#rv-ravi-card [data-look="small"]')?.click());
  await settle(800);
  console.log('after pick: density =', await page.evaluate(() => document.documentElement.dataset.density || null), 'asked =', await page.evaluate(() => localStorage.getItem('ravenvault-text-size-asked')));
  await shot(page, 'ask-picked-compact');
  await page.close();
}
await browser.close(); server.close();
console.log('shots →', SHOTS);
