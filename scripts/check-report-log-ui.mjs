// 문제 알리기 — 노드 기록 첨부 화면 점검. 가짜 invoke 만 쓴다. 지갑·외부 네트워크 없음.
import assert from 'node:assert/strict';
import { readFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { resolve, extname } from 'node:path';
import { tmpdir } from 'node:os';
import puppeteer from 'puppeteer-core';
const root = resolve(import.meta.dirname, '..'), dist = resolve(root, 'dist');
const origin = 'http://rv-report-fixture.test';
const profile = mkdtempSync(resolve(tmpdir(), 'rv-report-profile-'));
const types = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };
let browser;
try {
  browser = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true, userDataDir: profile });
  const page = await browser.newPage(); let errors = [];
  page.on('pageerror', e => errors.push(e.message));
  const SENT = []; await page.exposeFunction('__sent', a => { SENT.push(a); });
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
  await page.evaluateOnNewDocument(() => {
    localStorage.setItem('playx-raven-lang', 'ko'); window.__SENT = [];
    window.__TAURI_INTERNALS__ = { invoke: async (c, a) => {
      if (c === 'report_log_preview') return { ok: true, text: '2026 start <사용자> <ip>', lines: 1 };
      if (c === 'report_send') { window.__sent(JSON.parse(JSON.stringify(a))); return { sent: true }; }
      if (c === 'report_parked') return 0;
      if (c === 'node_status') return { blocks: 1, headers: 1, progress: 1, peers: 1 };
      if (c === 'plugin:app|version') return '0.9.4';
      if (['list_assets', 'pin_list', 'my_channels'].includes(c)) return [];
      return null;
    }, transformCallback: f => f, metadata: {} };
  });
  await page.goto(origin, { waitUntil: 'networkidle0' });
  await page.addStyleTag({ content: '#onboard,#hello{display:none!important}' });
  await page.evaluate(() => document.getElementById('rp-open').click());
  await page.waitForFunction(() => document.getElementById('rpwrap').style.display === 'flex', { polling: 100 });
  assert.equal(await page.$eval('#rp-log', e => e.checked), false, '기록 첨부는 기본 꺼짐');
  assert.match(await page.$eval('#rp-what', e => e.textContent), /기록은 보내지 않/);
  // 「프로그램이 안 켜져요」 → 켜짐 + 미리보기
  await page.evaluate(() => [...document.querySelectorAll('#rp-chips [data-rc]')].find(b => b.textContent.includes('안 켜져요')).click());
  await page.waitForFunction(() => document.getElementById('rp-log').checked, { polling: 100 });
  await page.waitForFunction(() => /<사용자>/.test(document.getElementById('rp-log-pre').textContent), { polling: 100 });
  assert.match(await page.$eval('#rp-what', e => e.textContent), /서버 기록/);
  await page.type('#rp-text', '안 켜져요');
  await page.click('#rp-send');
  while (SENT.length < 1) await new Promise(r => setTimeout(r, 100));
  let sent = SENT[0];
  assert.equal(sent.attachLog, true); assert.equal(sent.category, 'install-run');
  await page.waitForFunction(() => document.getElementById('rpwrap').style.display === 'none', { polling: 100 });
  // 끄면 안 보냄
  await page.evaluate(() => document.getElementById('rp-open').click());
  await page.waitForFunction(() => document.getElementById('rpwrap').style.display === 'flex', { polling: 100 });
  await page.type('#rp-text', '화면이 이상해요');
  await page.click('#rp-send');
  while (SENT.length < 2) await new Promise(r => setTimeout(r, 100));
  sent = SENT[1];
  assert.equal(sent.attachLog, false);
  errors = errors.filter(m => !/reading 'node'/.test(m));
  assert.deepEqual(errors, [], '화면 오류 없음: ' + errors.join('|'));
  console.log('PASS 노드 기록 첨부 화면: 기본 꺼짐·미리보기·install-run 자동 켜짐·끄면 안 보냄');
} finally { await browser?.close(); rmSync(profile, { recursive: true, force: true }); }
