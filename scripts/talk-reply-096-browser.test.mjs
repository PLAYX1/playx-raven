// 0.9.6 — 이야기 「답장」: 말풍선을 누르고 「답장」→ 입력칸 위에 누구에게인지 → 보내면 reply_to/reply_pub 가 간다.
// 답글은 인용 한 줄이 붙고, 내게 온 답은 표시된다. 실제 Chrome, 빌드된 dist, 합성 자료. 노드·지갑·네트워크 없음.
//   node --test scripts/talk-reply-096-browser.test.mjs      (RV_DIST=<dist> 면 그 dist 를 쓴다)
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve, join, extname, sep } from 'node:path';
import { tmpdir } from 'node:os';
import puppeteer from 'puppeteer-core';
import { installFixture } from './desktop-fixture.mjs';

const root = resolve(import.meta.dirname, '..');
let work, dist, server, origin, browser;
before(async () => {
  work = mkdtempSync(join(tmpdir(), 'rv-090-ui-'));
  if (process.env.RV_DIST && existsSync(join(process.env.RV_DIST, 'index.html'))) dist = process.env.RV_DIST;
  else {
    dist = join(work, 'dist');
    execFileSync(process.execPath, [resolve(root, 'node_modules/vite/bin/vite.js'), 'build', '--outDir', dist, '--emptyOutDir', '--logLevel', 'error'], { cwd: root, stdio: ['ignore', 'ignore', 'inherit'] });
  }
  const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.webp': 'image/webp', '.json': 'application/json' };
  server = createServer(async (req, res) => {
    try {
      const path = resolve(dist, '.' + decodeURIComponent(new URL(req.url, 'http://x').pathname));
      if (path !== dist && !path.startsWith(dist + sep)) throw Error('path');
      const file = path === dist ? join(dist, 'index.html') : path;
      if (!(await stat(file)).isFile()) throw Error('file');
      res.writeHead(200, { 'Content-Type': types[extname(file)] || 'application/octet-stream' }); res.end(await readFile(file));
    } catch { res.writeHead(404); res.end(); }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  origin = `http://127.0.0.1:${server.address().port}`;
  browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true, userDataDir: join(work, 'profile'), args: ['--no-first-run', '--disable-background-networking'] });
});
after(async () => { await browser?.close(); server?.close(); if (work) rmSync(work, { recursive: true, force: true }); });

const ME = 'public-home-fixture';
const now = 1791500400;
const EVENTS = [
  { id: 'm1', pubkey: 'pk-kim', created_at: now - 3000, content: '안녕하세요, 도복은 빌릴 수 있나요?', tags: [['t', 'ravencoin']] },
  { id: 'm2', pubkey: ME, created_at: now - 2600, content: '네, 오세요.', tags: [['t', 'ravencoin']] },
  { id: 'm3', pubkey: 'pk-kim', created_at: now - 2000, content: '감사합니다', tags: [['e', 'm2', '', 'reply'], ['t', 'ravencoin'], ['p', ME]] },
  { id: 'm4', pubkey: 'pk-lee', created_at: now - 1000, content: '저도요', tags: [['e', 'gone-id', '', 'reply'], ['t', 'ravencoin']] },
];

async function open() {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.setViewport({ width: 1440, height: 900 });
  await page.setRequestInterception(true);
  page.on('request', (r) => ((new URL(r.url()).origin === origin && r.method() === 'GET') ? r.continue() : r.abort()));
  await page.evaluateOnNewDocument(installFixture, { theme: 'light', sales: true, seller: false });
  await page.evaluateOnNewDocument((events) => {
    localStorage.setItem('rv-v2-backup-reminded', '1'); localStorage.setItem('playx-raven-lang', 'ko');
    window.__posts = [];
    const real = window.__TAURI_INTERNALS__.invoke;
    window.__TAURI_INTERNALS__.invoke = async (cmd, args) => {
      if (cmd === 'talk_me') return { pubkey: 'public-home-fixture', recoverable: true };
      if (cmd === 'talk_profiles') return { 'pk-kim': { name: '김무송' }, 'pk-lee': { name: '이영희' }, 'public-home-fixture': { name: '나' } };
      if (cmd === 'talk_rooms') return [];
      if (cmd === 'talk_read') return structuredClone(events);
      if (cmd === 'talk_post') { window.__posts.push(JSON.parse(JSON.stringify(args))); return { event: {}, sent: {} }; }
      return real(cmd, args);
    };
  }, EVENTS);
  await page.goto(origin + '/', { waitUntil: 'networkidle0' });
  await page.waitForFunction(() => document.querySelector('#page-home.on'), { timeout: 20000 });
  return { page, errors };
}
const go = (page, name) => page.evaluate((n) => document.querySelector(`nav a[data-page="${n}"]`).click(), name);
const settle = (ms = 300) => new Promise((r) => setTimeout(r, ms));

test('답글에는 어느 글에 대한 답인지 인용 한 줄이 붙고, 내게 온 답은 표시된다', async () => {
  const { page, errors } = await open();
  try {
    await go(page, 'talk');
    await page.waitForFunction(() => document.querySelectorAll('#tk-list .bub').length >= 4, { timeout: 15000 });
    const quotes = await page.$$eval('#tk-list .replyquote', (q) => q.map((x) => ({ text: x.textContent.replace(/\s+/g, ' ').trim(), tome: x.classList.contains('tome') })));
    assert.equal(quotes.length, 2, '답글 둘에만 인용');
    assert.match(quotes[0].text, /^↪ 나 · 네, 오세요\./);
    assert.equal(quotes[0].tome, true, '내 글에 온 답');
    assert.match(quotes[1].text, /^↪ .*이전 글/, '가리키는 글이 목록에 없으면 이름 없이 말만');
    assert.equal(quotes[1].tome, false);
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

test('답장: 누르면 입력칸 위에 누구에게인지 뜨고, 보내면 글에 붙어 나가고 줄은 사라진다', async () => {
  const { page, errors } = await open();
  try {
    await go(page, 'talk');
    await page.waitForFunction(() => document.querySelectorAll('#tk-list .bub').length >= 4, { timeout: 15000 });
    assert.equal(await page.$eval('#tk-replybar', (b) => b.hidden), true, '처음엔 숨김');
    await page.evaluate(() => document.querySelector('#tk-list [data-say="m1"]').click());
    await page.evaluate(() => document.querySelector('#tk-list [data-reply="m1"]').click());
    assert.equal(await page.$eval('#tk-replybar', (b) => b.hidden), false);
    const label = await page.$eval('#tk-replytext', (e) => e.textContent);
    assert.match(label, /김무송에게 답장 · 안녕하세요/);
    await page.type('#tk-text', '네 빌려 드려요');
    await page.click('#tk-send');
    await page.waitForFunction(() => window.__posts.length === 1);
    const sent = await page.evaluate(() => window.__posts[0]);
    assert.equal(sent.text, '네 빌려 드려요');
    assert.equal(sent.replyTo, 'm1');
    assert.equal(sent.replyPub, 'pk-kim');
    await settle(200);
    assert.equal(await page.$eval('#tk-replybar', (b) => b.hidden), true, '보낸 뒤 줄이 사라진다');
    // 그 다음 글은 답장이 아니다.
    await page.type('#tk-text', '그냥 글');
    await page.click('#tk-send');
    await page.waitForFunction(() => window.__posts.length === 2);
    const plain = await page.evaluate(() => window.__posts[1]);
    assert.equal(plain.replyTo, null);
    assert.equal(plain.replyPub, null);
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

test('답장 줄의 ✕ 로 취소하면 일반 글로 나간다', async () => {
  const { page, errors } = await open();
  try {
    await go(page, 'talk');
    await page.waitForFunction(() => document.querySelectorAll('#tk-list .bub').length >= 4, { timeout: 15000 });
    await page.evaluate(() => document.querySelector('#tk-list [data-say="m3"]').click());
    await page.evaluate(() => document.querySelector('#tk-list [data-reply="m3"]').click());
    assert.equal(await page.$eval('#tk-replybar', (b) => b.hidden), false);
    await page.click('#tk-replyx');
    assert.equal(await page.$eval('#tk-replybar', (b) => b.hidden), true);
    await page.type('#tk-text', '취소 후 글');
    await page.click('#tk-send');
    await page.waitForFunction(() => window.__posts.length === 1);
    assert.equal(await page.evaluate(() => window.__posts[0].replyTo), null);
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});
