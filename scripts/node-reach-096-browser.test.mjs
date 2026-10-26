// 0.9.6 — 서버 화면의 「바깥 접속」 줄: 받는 중/아직 못 받음/확인 중, 못 받을 때만 안내 카드. 실제 Chrome, 빌드된 dist, 합성 자료.
//   node --test scripts/node-reach-096-browser.test.mjs      (RV_DIST=<dist> 면 그 dist 를 쓴다)
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

async function open(reach) {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.setViewport({ width: 1440, height: 900 });
  await page.setRequestInterception(true);
  page.on('request', (r) => ((new URL(r.url()).origin === origin && r.method() === 'GET') ? r.continue() : r.abort()));
  await page.evaluateOnNewDocument(installFixture, { theme: 'light', sales: true, seller: false });
  await page.evaluateOnNewDocument((reach) => {
    localStorage.setItem('rv-v2-backup-reminded', '1'); localStorage.setItem('playx-raven-lang', 'ko');
    const real = window.__TAURI_INTERNALS__.invoke;
    window.__TAURI_INTERNALS__.invoke = async (cmd, args) => {
      if (cmd === 'node_status') return { running: true, peers: 8, blocks: 4600000, headers: 4600000, progress: 1, behind_honest: true };
      if (cmd === 'node_reachability') { if (reach === 'throw') throw 'rpc'; return reach; }
      return real(cmd, args);
    };
  }, reach);
  await page.goto(origin + '/', { waitUntil: 'networkidle0' });
  await page.waitForFunction(() => document.querySelector('#page-home.on'), { timeout: 20000 });
  await page.evaluate(() => document.querySelector('nav a[data-page="parts"], [data-part="node"]')?.click());
  await page.waitForFunction(() => /연결/.test(document.getElementById('pt-body')?.textContent || ''), { timeout: 15000 });
  return { page, errors };
}
const rowOf = (page, label) => page.$eval('#pt-body', (b, l) => [...b.querySelectorAll('.kv')].find((r) => r.querySelector('b').textContent.trim() === l)?.querySelector('span').textContent.trim() ?? null, label);

test('바깥 접속을 받는 중이면 숫자와 함께 보이고 안내 카드는 없다', async () => {
  const { page, errors } = await open({ state: 'receiving', inbound: 3, total: 8 });
  try {
    assert.match(await rowOf(page, '바깥 접속'), /^받는 중 \(3곳\)$/);
    assert.equal(await page.$eval('#pt-body', (b) => /바깥 접속을 아직 못 받고 있어요/.test(b.textContent)), false);
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

test('들어오는 연결이 없으면 「아직 못 받음」과 고장이 아니라는 안내(8767·하루쯤)가 뜬다', async () => {
  const { page, errors } = await open({ state: 'not_seen', inbound: 0, total: 8 });
  try {
    assert.equal(await rowOf(page, '바깥 접속'), '아직 못 받음');
    const text = await page.$eval('#pt-body', (b) => b.textContent.replace(/\s+/g, ' '));
    assert.match(text, /바깥 접속을 아직 못 받고 있어요/);
    assert.match(text, /고장이 아닙니다/);
    assert.match(text, /TCP 8767/);
    assert.match(text, /하루쯤/);
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

test('모르면 「확인 중」이고 안내는 없다(모르는 것을 막혔다고 하지 않는다)', async () => {
  for (const reach of [{ state: 'unknown' }, 'throw']) {
    const { page, errors } = await open(reach);
    try {
      assert.equal(await rowOf(page, '바깥 접속'), '확인 중');
      assert.equal(await page.$eval('#pt-body', (b) => /바깥 접속을 아직 못 받고 있어요/.test(b.textContent)), false);
      assert.deepEqual(errors, []);
    } finally { await page.close(); }
  }
});
