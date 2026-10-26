// 0.9.6 — 라비가 서버·설정을 「준비」하면 확인 단추가 뜨고, 단추를 눌러야만 실행된다. 실제 Chrome, 빌드된 dist, 합성 자료.
//   node --test scripts/ravi-confirm-096-browser.test.mjs      (RV_DIST=<dist> 면 그 dist 를 쓴다)
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


async function open(prepared) {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.setViewport({ width: 1440, height: 900 });
  await page.setRequestInterception(true);
  page.on('request', (r) => ((new URL(r.url()).origin === origin && r.method() === 'GET') ? r.continue() : r.abort()));
  await page.evaluateOnNewDocument(installFixture, { theme: 'light', sales: true, seller: false });
  await page.evaluateOnNewDocument((prepared) => {
    localStorage.setItem('rv-v2-backup-reminded', '1'); localStorage.setItem('playx-raven-lang', 'ko'); localStorage.setItem('rv-ravi-start-off', '1');
    window.__CALLS = []; window.__WRITES = [];
    const real = window.__TAURI_INTERNALS__.invoke;
    window.__TAURI_INTERNALS__.invoke = async (cmd, args) => {
      window.__CALLS.push(cmd);
      if (cmd === 'api_key_status') return { platform: 'macos', available: { anthropic: true }, last4: { anthropic: 'abcd' } };
      if (cmd === 'ravi_consent') return { reviewed: true, balance: false, transactions: false, shop: false };
      if (cmd === 'ravi_audit') return [];
      if (cmd === 'ravi_today') return { wallet: 'locked' };
      if (cmd === 'ravi_agent_chat') return { reply: '확인할 화면을 준비했어요. 최종 실행은 직접 확인해 주세요.', prepared };
      if (cmd === 'services_stop' || cmd === 'services_start') { window.__WRITES.push([cmd]); return { started: [], skipped: [] }; }
      if (cmd === 'conf_read') return { values: { dbcache: 450, maxconnections: 40, server: 1 }, others: [] };
      if (cmd === 'conf_write') { window.__WRITES.push([cmd, args.values]); return { wrote: [], needs_restart: true }; }
      return real(cmd, args);
    };
  }, prepared);
  await page.goto(origin + '/', { waitUntil: 'networkidle0' });
  await page.waitForFunction(() => document.querySelector('#page-home.on'), { timeout: 20000 });
  await page.evaluate(() => document.getElementById('ravi-open')?.click());
  await page.waitForSelector('#chat-q', { visible: true, timeout: 10000 });
  await page.$eval('#chat-q', (el) => { el.value = '서버 켜 줘'; });
  await page.click('#chat-go');
  await page.waitForSelector('[data-ravi-confirm]', { timeout: 10000 });
  return { page, errors };
}

test('서버 켜기: 카드만 뜨고 아직 아무것도 실행하지 않는다 → 단추를 눌러야 켠다', async () => {
  const { page, errors } = await open([{ name: 'prepare_node', args: { action: 'start' } }]);
  assert.deepEqual(await page.evaluate(() => window.__WRITES), [], '단추 전에는 실행 없음');
  await page.click('[data-ravi-confirm]');
  await page.waitForFunction(() => window.__WRITES.length > 0, { timeout: 5000 });
  assert.deepEqual(await page.evaluate(() => window.__WRITES), [['services_start']]);
  assert.deepEqual(errors, []);
  await page.close();
});

test('서버 다시 시작: 끄고 켠다', async () => {
  const { page } = await open([{ name: 'prepare_node', args: { action: 'restart' } }]);
  await page.click('[data-ravi-confirm]');
  await page.waitForFunction(() => window.__WRITES.length > 1, { timeout: 5000 });
  assert.deepEqual(await page.evaluate(() => window.__WRITES.map((w) => w[0])), ['services_stop', 'services_start']);
  await page.close();
});

test('바깥 접속 켜기: 지금 값을 다 읽어 한 칸만 바꿔 쓴다(다른 줄은 지우지 않는다)', async () => {
  const { page, errors } = await open([{ name: 'prepare_setting', args: { key: 'upnp', value: 1 } }]);
  assert.deepEqual(await page.evaluate(() => window.__WRITES), []);
  await page.click('[data-ravi-confirm]');
  await page.waitForFunction(() => window.__WRITES.length > 0, { timeout: 5000 });
  assert.deepEqual(await page.evaluate(() => window.__WRITES), [['conf_write', { dbcache: 450, maxconnections: 40, server: 1, upnp: 1 }]]);
  assert.deepEqual(errors, []);
  await page.close();
});
