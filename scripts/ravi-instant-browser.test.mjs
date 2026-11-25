// 11-25 라비 「키 없이 바로 답」 흐름 시험 — 실제 dist 를 가짜 IPC(desktop-fixture)로 띄워 라비 대화칸에 **직접 쳐서** 본다.
//   키 없음: 잔액·오늘 매출·새 주문·장터 열기·받기 주소(복사)·보내기 준비(칸만 채움)·모르는 말 칩.
//   키 있음: 규칙이 맞는 말은 그대로 바로 답(ravi_agent_chat 안 부름), 모르는 말은 AI 로 넘어간다.
// 노드·지갑·네트워크 없음. 보내기·잠금 해제 계열은 desktop-fixture 가 거절한다(불리면 시험 실패).
//   node --test scripts/ravi-instant-browser.test.mjs      (RV_INSTANT_SHOTS=<폴더> 면 그림을 남긴다)
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
const shots = process.env.RV_INSTANT_SHOTS ? resolve(process.env.RV_INSTANT_SHOTS) : null;
if (shots) mkdirSync(shots, { recursive: true });
const ADDR = 'RPubxicFixtureAddressRaviNstantAbc';   // 모양만 맞는 합성 주소(실제 지갑 아님)
const PAYEE = 'RPubxicFixturePayeeChuxsooAddrXyz1';
let work, dist, browser, server, origin;

before(async () => {
  work = mkdtempSync(join(tmpdir(), 'rv-ravi-instant-'));
  dist = join(work, 'dist');
  execFileSync(process.execPath, [resolve(root, 'node_modules/vite/bin/vite.js'), 'build', '--outDir', dist, '--emptyOutDir', '--logLevel', 'error'], { cwd: root, stdio: ['ignore', 'ignore', 'inherit'] });
  const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.webp': 'image/webp', '.jpg': 'image/jpeg', '.json': 'application/json', '.wasm': 'application/wasm' };
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

const NO_KEY = { api_key_status: { platform: 'macos', available: {}, has_key: {}, storage: {} } };
async function openApp({ extra = {} } = {}) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
  await page.setRequestInterception(true);
  page.on('request', (r) => ((new URL(r.url()).origin === origin && r.method() === 'GET') ? r.continue() : r.abort()));
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e?.message || e)));
  page.on('dialog', async (d) => { errors.push(`native dialog: ${d.type()} ${d.message()}`); await d.dismiss(); });
  await page.evaluateOnNewDocument(installFixture, { theme: 'light', sales: true, seller: true });
  await page.evaluateOnNewDocument((extraJson, payee) => {
    localStorage.setItem('rv-v2-backup-reminded', '1');
    // 이 컴퓨터 「받을 사람」 목록(wallet-easy.ts) — 이름 「철수」 하나.
    localStorage.setItem('playx-raven-payees', JSON.stringify([{ address: payee, name: '철수', at: 1 }]));
    const extra = JSON.parse(extraJson);
    const log = window.__args = [];
    const real = window.__TAURI_INTERNALS__.invoke;
    window.__TAURI_INTERNALS__.invoke = async (cmd, args) => {
      if (!String(cmd).startsWith('plugin:')) log.push({ cmd, args: args ? JSON.parse(JSON.stringify(args)) : null });
      if (Object.hasOwn(extra, cmd)) return structuredClone(extra[cmd]);
      return real(cmd, args);
    };
  }, JSON.stringify({ receive_address: { address: ADDR, mine: true, reused: true }, ravi_agent_chat: { reply: '(AI 답 — 합성)', prepared: [] }, ...extra }), PAYEE);
  await page.goto(origin + '/', { waitUntil: 'networkidle0' });
  await page.waitForFunction(() => document.querySelector('#page-home.on'), { timeout: 20000 });
  await page.waitForFunction(() => !document.documentElement.hasAttribute('data-ravi-arriving'), { timeout: 20000 }).catch(() => {});
  page.errors = errors;
  return page;
}
const cmds = (page) => page.evaluate(() => window.__args.map((x) => x.cmd));
/** 첫 화면 라비 한 줄(#v2-ravi-say)로 대화칸을 열고 친다. 답 말풍선이 나올 때까지의 시간도 잰다. */
async function ask(page, text) {
  if (!(await page.$eval('#ravi-panel', (e) => !e.hidden && !!e.getClientRects().length))) {
    await page.evaluate(() => document.getElementById('v2-ravi-say')?.scrollIntoView());
    await page.click('#v2-ravi-say');
    await page.waitForFunction(() => document.activeElement?.id === 'chat-q', { timeout: 8000 });
    // 그림을 남길 때만 대화칸을 「크게」로(답 말풍선이 잘리지 않게). 판정에는 영향 없다.
    if (shots) await page.click('#ravi-expand').catch(() => {});
  }
  const n = await page.$$eval('#chat-log .msg.ai', (l) => l.length);
  await page.focus('#chat-q');
  await page.keyboard.type(text);
  const t0 = Date.now();
  await page.click('#chat-go');
  await page.waitForFunction((k) => document.querySelectorAll('#chat-log .msg.ai').length > k, { timeout: 5000 }, n);
  const ms = Date.now() - t0;
  const last = await page.$eval('#chat-log', (l) => { const m = [...l.querySelectorAll('.msg.ai')].at(-1); return { html: m.innerHTML, text: m.textContent.replace(/\s+/g, ' ').trim() }; });
  return { ...last, ms };
}
/** 화면 전체 + 방금 물음·답 말풍선(크게) 두 장. */
const shot = async (page, name) => {
  if (!shots) return;
  await page.screenshot({ path: join(shots, name) });
  const tail = (await page.$$('#chat-log .msg')).slice(-2);
  await tail[0].scrollIntoView();
  const boxes = await Promise.all(tail.map((m) => m.boundingBox()));
  const top = Math.min(...boxes.map((b) => b.y)), bottom = Math.max(...boxes.map((b) => b.y + b.height));
  const left = Math.min(...boxes.map((b) => b.x)), right = Math.max(...boxes.map((b) => b.x + b.width));
  await page.screenshot({ path: join(shots, name.replace('.png', '-answer.png')), clip: { x: Math.max(0, left - 6), y: Math.max(0, top - 6), width: right - left + 12, height: bottom - top + 12 } });
};
const noSpend = async (page) => {
  const all = await cmds(page);
  const SPEND = /^(?:send_rvn|send_asset|send_many|wallet_send|preview_send|broadcast|sign_transaction|sign_and_send|phone_transaction_send)$/;
  assert.deepEqual(all.filter((c) => SPEND.test(c)), [], '보내기·검토 IPC 는 불리지 않는다');
  assert.deepEqual(await page.evaluate(() => window.__homeFixture.forbidden), []);
};

test('키 없음 — 잔액·매출·주문을 IPC 숫자로 바로 답한다(지어내지 않는다)', { timeout: 90000 }, async () => {
  const page = await openApp({ extra: NO_KEY });
  const bal = await ask(page, '내 돈 얼마야');
  assert.match(bal.html, /data-guide="instant-balance"/);
  assert.match(bal.text, /42\.125/, bal.text);          // wallet_balance.confirmed
  assert.match(bal.text, /3\.5/, bal.text);             // 들어오는 중
  assert.ok(bal.ms < 1500, `바로 답해야 한다 (${bal.ms}ms)`);
  await shot(page, 'ravi-instant-1-balance.png');
  const sales = await ask(page, '오늘 매출 얼마야?');
  assert.match(sales.html, /data-guide="instant-sales"/);
  assert.match(sales.text, /32,500 KRW/, sales.text);    // ledger_range.total
  assert.match(sales.text, /4건/, sales.text);
  assert.match(sales.text, /입금되지 않은 주문 2건/, sales.text);
  const week = await page.evaluate(() => window.__args.filter((x) => x.cmd === 'ledger_range').at(-1).args);
  const orders = await ask(page, '새 주문 있어?');
  assert.match(orders.html, /data-guide="instant-orders"/);
  assert.match(orders.text, /입금 기다리는 주문 2건/, orders.text);
  await shot(page, 'ravi-instant-2-sales-orders.png');
  // 「지갑 열기」 단추는 기존 data-guide-go 길로 지갑 화면을 연다.
  await page.evaluate(() => [...document.querySelectorAll('#chat-log [data-guide="instant-balance"] [data-guide-go="wallet"]')].at(-1).click());
  await page.waitForFunction(() => document.querySelector('#page-wallet.on'), { timeout: 5000 });
  assert.equal(week.fromYmd, week.toYmd, '오늘 매출은 오늘 하루');
  const all = await cmds(page);
  assert.ok(!all.includes('ravi_agent_chat'), 'AI 를 부르지 않는다');
  await noSpend(page);
  assert.deepEqual(page.errors, []);
  await page.close();
});

test('키 없음 — 화면 열기·받기 주소 복사·보내기 준비(칸만 채움, 보내지 않음)', { timeout: 90000 }, async () => {
  const page = await openApp({ extra: NO_KEY });
  await page.evaluate(() => { window.__copied = []; navigator.clipboard.writeText = async (t) => { window.__copied.push(t); }; });
  const trade = await ask(page, '장터 열어 줘');
  assert.match(trade.html, /data-guide="instant-open"/);
  await page.waitForFunction(() => document.querySelector('#page-trade.on'), { timeout: 5000 });
  const st = await ask(page, '설정');
  assert.match(st.text, /「설정」 화면을 열었어요/);
  assert.ok(await page.$('#page-settings.on'));
  const recv = await ask(page, '받기 주소 보여 줘');
  assert.match(recv.html, /data-guide="instant-receive"/);
  assert.ok(recv.text.includes(ADDR), recv.text);
  await page.evaluate(() => [...document.querySelectorAll('#chat-log [data-instant-copy]')].at(-1).click());
  await page.waitForFunction(() => /복사했어요/.test([...document.querySelectorAll('#chat-log [data-instant-note]')].at(-1)?.textContent || ''), { timeout: 3000 });
  assert.deepEqual(await page.evaluate(() => window.__copied), [ADDR]);
  await shot(page, 'ravi-instant-3-receive.png');
  // 보내기 — 이름이 「받을 사람」 목록과 똑같으면 주소·금액을 채운다. 검토(preview_send)·보내기는 부르지 않는다.
  const sendA = await ask(page, '철수에게 10 RVN 보내 줘');
  assert.match(sendA.html, /data-guide="instant-send"/);
  await page.waitForFunction(() => document.querySelector('#page-wallet.on'), { timeout: 5000 });
  assert.equal(await page.$eval('#s-addr', (e) => e.value), PAYEE);
  assert.equal(await page.$eval('#s-qty', (e) => e.value.replace(/\s/g, '')), '10');
  assert.match(sendA.text, /받을 사람: 철수/);
  assert.equal(await page.$eval('#send-review', (e) => getComputedStyle(e).display), 'none', '확인 화면도 띄우지 않는다');
  await shot(page, 'ravi-instant-4-send-prepared.png');
  // 목록에 없는 이름이면 주소는 비운다(금액만).
  const sendB = await ask(page, '영수에게 3 RVN 보내 줘');
  assert.equal(await page.$eval('#s-addr', (e) => e.value), '');
  assert.equal(await page.$eval('#s-qty', (e) => e.value.replace(/\s/g, '')), '3');
  assert.match(sendB.text, /영수」은\(는\) 내 받을 사람 목록에 없어/);
  // 「보내지 마」는 아무것도 준비하지 않는다(기존 정해 둔 안내 길).
  const neg = await ask(page, '철수에게 보내지 마');
  assert.doesNotMatch(neg.html, /instant-send/);
  await noSpend(page);
  assert.ok(!(await cmds(page)).includes('ravi_agent_chat'));
  assert.deepEqual(page.errors, []);
  await page.close();
});

test('키 없음 — 모르는 말은 짧은 안내 + 바로 할 수 있는 일 칩(누르면 바로 답)', { timeout: 90000 }, async () => {
  const page = await openApp({ extra: NO_KEY });
  const miss = await ask(page, '오늘 날씨 어때');
  assert.match(miss.html, /data-instant-fallback/);
  assert.equal((miss.html.match(/data-ravi-ask=/g) || []).length, 5);
  assert.match(miss.text, /AI 키를 넣으면 자유롭게 대화할 수도 있어요/);
  await shot(page, 'ravi-instant-5-fallback.png');
  const n = await page.$$eval('#chat-log .msg.ai', (l) => l.length);
  await page.evaluate(() => [...document.querySelectorAll('#chat-log [data-instant-fallback] [data-ravi-ask]')][0].click());
  await page.waitForFunction((k) => document.querySelectorAll('#chat-log .msg.ai').length > k, { timeout: 5000 }, n);
  const last = await page.$eval('#chat-log', (l) => [...l.querySelectorAll('.msg.ai')].at(-1).innerHTML);
  assert.match(last, /data-guide="instant-balance"/, '칩 「내 잔액」 → 잔액 답');
  const en = await ask(page, 'what is my balance');
  assert.match(en.text, /Spendable: 42\.125/, en.text);
  assert.deepEqual(page.errors, []);
  await page.close();
});

test('키 있음(BYOK) — 규칙이 맞는 말은 바로, 모르는 말은 그대로 AI 로', { timeout: 90000 }, async () => {
  const page = await openApp();
  const bal = await ask(page, '잔액');
  assert.match(bal.html, /data-guide="instant-balance"/);
  assert.ok(!(await cmds(page)).includes('ravi_agent_chat'), '맞는 말은 AI 없이');
  await ask(page, '레이븐코인 이름은 왜 레이븐이야?');
  await page.waitForFunction(() => window.__args.some((x) => x.cmd === 'ravi_agent_chat'), { timeout: 5000 });
  const call = await page.evaluate(() => window.__args.find((x) => x.cmd === 'ravi_agent_chat').args);
  assert.equal(call.message, '레이븐코인 이름은 왜 레이븐이야?');
  await page.waitForFunction(() => /AI 답 — 합성/.test(document.getElementById('chat-log').textContent), { timeout: 5000 });
  await noSpend(page);
  assert.deepEqual(page.errors, []);
  await page.close();
});

test('잠긴 앱·못 읽은 잔액은 숫자 대신 그렇다고 말한다', { timeout: 90000 }, async () => {
  const page = await openApp({ extra: { ...NO_KEY } });
  // 잔액 IPC 가 실패하는 경우(노드 준비 중) — 0 이나 옛 숫자를 보이지 않는다.
  await page.evaluate(() => { const inv = window.__TAURI_INTERNALS__.invoke; window.__TAURI_INTERNALS__.invoke = async (c, a) => { if (c === 'wallet_balance') throw 'node starting'; return inv(c, a); }; });
  const r = await ask(page, 'RVN 얼마 있어');
  assert.match(r.text, /잔액을 아직 못 읽었어요/);
  assert.doesNotMatch(r.text, /42\.125|0 RVN/);
  await page.evaluate(() => { const inv = window.__TAURI_INTERNALS__.invoke; window.__TAURI_INTERNALS__.invoke = async (c, a) => { if (c === 'app_lock_state') return { locked: true }; return inv(c, a); }; });
  const l = await ask(page, '내 잔액');
  assert.match(l.text, /앱이 잠겨 있어 잔액을 보여 드리지 않았어요/);
  assert.match(l.html, /data-guide-go="wallet"/);
  await page.close();
});
