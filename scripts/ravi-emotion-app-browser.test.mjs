// 실제 앱(dist, 합성 fixture)에서 감정 엔진이 붙는지 — 이벤트 버스 → 얼굴·말풍선·낭독, 페이지 오류 0.
// 경고 중 들뜸 없음, 말풍선이 클릭을 막지 않음, 앱 화면 캡처(artifacts/emotion-gallery/app-*.png).
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve, join, extname, sep } from 'node:path';
import { tmpdir } from 'node:os';
import puppeteer from 'puppeteer-core';
import { installFixture } from './desktop-fixture.mjs';

const root = resolve(import.meta.dirname, '..');
const outDir = resolve(root, 'artifacts/emotion-gallery');
let work, dist, browser, server, origin;
before(async () => {
  work = mkdtempSync(join(tmpdir(), 'rv-emotion-app-'));
  dist = join(work, 'dist');
  execFileSync(process.execPath, [resolve(root, 'node_modules/vite/bin/vite.js'), 'build', '--outDir', dist, '--emptyOutDir', '--logLevel', 'error'], { cwd: root, stdio: ['ignore', 'ignore', 'inherit'] });
  const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.webp': 'image/webp' };
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
  mkdirSync(outDir, { recursive: true });
});
after(async () => { await browser?.close(); server?.close(); if (work) rmSync(work, { recursive: true, force: true }); });

async function open(theme, width = 1280, height = 800) {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  await page.setViewport({ width, height });
  await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: theme }, { name: 'prefers-reduced-motion', value: 'reduce' }]);
  await page.setRequestInterception(true);
  page.on('request', r => (new URL(r.url()).origin === origin && r.method() === 'GET') ? r.continue() : r.abort());
  await page.evaluateOnNewDocument(installFixture, { theme, sales: true, seller: false });
  await page.goto(origin + '/', { waitUntil: 'networkidle0' });
  await page.waitForFunction(() => document.querySelector('#page-home.on') && !document.documentElement.hasAttribute('data-ravi-arriving'), { timeout: 20000 });
  return { page, errors };
}
const fire = (page, name) => page.evaluate(n => window.dispatchEvent(new CustomEvent('ravi-event', { detail: n })), name);
const state = page => page.evaluate(() => {
  const b = document.querySelector('.rv-emo-float .rv-emo-bubble');
  const faces = [...document.querySelectorAll('.ravi-face')].filter(f => f.getBoundingClientRect().width >= 40);
  return { bubble: b?.dataset.state, text: b?.textContent, pe: b ? getComputedStyle(b.parentElement).pointerEvents : null,
    emotions: [...new Set(faces.map(f => f.dataset.raviEmotion || ''))], moods: [...new Set([...document.querySelectorAll('.ravi-face')].map(f => f.dataset.mood))],
    live: document.querySelector('.rv-emo-live')?.textContent || '' };
});

for (const theme of ['light', 'dark']) test(`앱 안에서 감정 표시 (${theme})`, { timeout: 120_000 }, async () => {
  const { page, errors } = await open(theme);
  await fire(page, 'deposit_confirmed');
  await new Promise(r => setTimeout(r, 400));
  let s = await state(page);
  assert.equal(s.bubble, 'open'); assert.match(s.text, /입금이 확인됐어요|deposit/i);
  assert.equal(s.pe, 'none', '말풍선이 클릭을 막지 않는다');
  assert.ok(s.moods.includes('happy'), JSON.stringify(s.moods));
  await page.screenshot({ path: join(outDir, `app-${theme}-happy.png`) });

  await fire(page, 'node_down');
  await new Promise(r => setTimeout(r, 400));
  s = await state(page);
  assert.ok(s.moods.every(m => !['happy', 'love', 'wink', 'surprised'].includes(m)), `경고 중 들뜸 없음: ${s.moods}`);
  assert.match(s.text, /노드가 응답하지 않아요|node/i);
  assert.match(s.live, /노드가 응답하지 않아요|node/i, '낭독');
  await page.screenshot({ path: join(outDir, `app-${theme}-worried.png`) });

  await fire(page, 'deposit_confirmed'); // 경고가 이긴다
  s = await state(page);
  assert.ok(!s.moods.includes('happy'));
  await fire(page, 'node_recovered');
  await fire(page, '<img src=x onerror=alert(1)>'); // 모르는 이름은 무시
  assert.deepEqual(errors, [], '페이지 오류 0');
  await page.close();
});
