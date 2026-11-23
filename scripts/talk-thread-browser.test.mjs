//   node --test scripts/talk-dm-browser.test.mjs      (RV_DIST=<dist> 면 그 dist · RV_SHOTS=<폴더> 면 화면을 찍어 둔다)
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { mkdtempSync, rmSync, existsSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve, join, extname, sep } from 'node:path';
import { tmpdir } from 'node:os';
import puppeteer from 'puppeteer-core';
import { installFixture } from './desktop-fixture.mjs';

const root = resolve(import.meta.dirname, '..');
const SHOTS = process.env.RV_SHOTS || '';
let work, dist, server, origin, browser;
before(async () => {
  work = mkdtempSync(join(tmpdir(), 'rv-dm-ui-'));
  if (process.env.RV_DIST && existsSync(join(process.env.RV_DIST, 'index.html'))) dist = process.env.RV_DIST;
  else {
    dist = join(work, 'dist');
    execFileSync(process.execPath, [resolve(root, 'node_modules/vite/bin/vite.js'), 'build', '--outDir', dist, '--emptyOutDir', '--logLevel', 'error'], { cwd: root, stdio: ['ignore', 'ignore', 'inherit'] });
  }
  if (SHOTS) mkdirSync(SHOTS, { recursive: true });
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

// 11-23 대표 「피드에서 답글 쓰면 그 글 클릭해 봐도 답글이 안 보임」 → 글 바로 아래 펼침.
//   node --test scripts/talk-thread-browser.test.mjs   (RV_DIST=dist · RV_SHOTS=<폴더>)
const h = (c) => c.repeat(64);
const ME = h('a'), KIM = h('b'), LEE = h('c');
const TOP = h('1'), MID = h('2'), DEEP = h('3'), OTHER = h('4');
const now = Math.floor(Date.now() / 1000);
const NOTES = [
  { id: TOP, pubkey: ME, created_at: now - 3000, content: '이번 주 토요일 오픈매트 합니다', tags: [['t', 'ravencoin']] },
  { id: OTHER, pubkey: KIM, created_at: now - 2500, content: '도복 빌릴 수 있나요?', tags: [['t', 'ravencoin']] },
  { id: MID, pubkey: KIM, created_at: now - 2000, content: '저 갈게요!', tags: [['e', TOP, '', 'root'], ['p', ME], ['t', 'ravencoin']] },
];
// 노드(talk_replies)만 아는 깊은 답글 — 피드 목록에는 없다.
const DEEP_EV = { id: DEEP, pubkey: LEE, created_at: now - 1000, content: '저도 같이 가요', tags: [['e', TOP, '', 'root'], ['e', MID, '', 'reply'], ['t', 'ravencoin']] };

async function open() {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.setViewport({ width: 1440, height: 900 });
  await page.setRequestInterception(true);
  page.on('request', (r) => ((new URL(r.url()).origin === origin && r.method() === 'GET') ? r.continue() : r.abort()));
  await page.evaluateOnNewDocument(installFixture, { theme: 'light', sales: true, seller: false });
  await page.evaluateOnNewDocument((d) => {
    localStorage.setItem('rv-v2-backup-reminded', '1'); localStorage.setItem('playx-raven-lang', 'ko');
    window.__posts = []; window.__repliesAsked = [];
    const real = window.__TAURI_INTERNALS__.invoke;
    window.__TAURI_INTERNALS__.invoke = async (cmd, args) => {
      if (cmd === 'talk_me') return { pubkey: d.ME, recoverable: true, same_as_wallet: true };
      if (cmd === 'talk_profiles') return { [d.ME]: { name: '김무송' }, [d.KIM]: { name: '김민수' }, [d.LEE]: { name: '이영희' } };
      if (cmd === 'talk_rooms') return [];
      if (cmd === 'talk_view' || cmd === 'talk_feed') return { notes: structuredClone(d.NOTES), gone: [], oldest: 0 };
      if (cmd === 'talk_replies') {
        window.__repliesAsked.push(args.ids);
        const out = {};
        for (const id of args.ids) {
          if (id === d.TOP) out[id] = [structuredClone(d.NOTES[2]), structuredClone(d.DEEP_EV)];
          if (id === d.MID) out[id] = [structuredClone(d.DEEP_EV)];
        }
        return out;
      }
      if (cmd === 'talk_post') { window.__posts.push(JSON.parse(JSON.stringify(args))); return { event: { id: 'f'.repeat(64), pubkey: d.ME, created_at: Math.floor(Date.now() / 1000), content: args.text, tags: [['e', args.replyRoot || args.replyTo, '', 'root'], ['e', args.replyTo, '', 'reply']] } }; }
      if (cmd === 'talk_dm_threads') return { me: d.ME, same_as_wallet: true, reached: true, threads: [], rooms_last: {} };
      if (cmd === 'talk_os_notify') return false;
      return real(cmd, args);
    };
  }, { ME, KIM, LEE, TOP, MID, NOTES, DEEP_EV });
  await page.goto(origin + '/', { waitUntil: 'networkidle0' });
  await page.waitForFunction(() => document.querySelector('#page-home.on'), { timeout: 20000 });
  await page.evaluate(() => document.querySelector('nav a[data-page="talk"]').click());
  await page.click('#tk-side-square');
  await page.waitForFunction((id) => document.querySelector(`#tk-list [data-card="${id}"]`), { timeout: 15000 }, TOP);
  return { page, errors };
}

test('피드: 「답글 N」 숫자 · 글을 누르면 바로 아래에 답글(답글의 답글 포함) · 다시 누르면 접힘', async () => {
  const { page, errors } = await open();
  try {
    await page.waitForFunction((id) => /2/.test(document.querySelector(`#tk-list [data-rcount="${id}"]`)?.textContent || ''), { timeout: 8000 }, TOP);
    assert.equal(await page.$eval(`#tk-list [data-thread="${TOP}"]`, (e) => e.hidden), true, '처음엔 접힘');
    await page.evaluate((id) => document.querySelector(`#tk-list [data-say="${id}"]`).click(), TOP);
    await page.waitForFunction((id) => document.querySelectorAll(`#tk-list [data-thread="${id}"] .trow`).length === 2, { timeout: 5000 }, TOP);
    const rows = await page.$$eval(`#tk-list [data-thread="${TOP}"] .trow .ttext`, (r) => r.map((x) => x.textContent.trim()));
    assert.deepEqual(rows, ['저 갈게요!', '저도 같이 가요'], '오래된 것이 위 · 깊은 답글도');
    if (process.env.RV_SHOTS) await page.screenshot({ path: join(process.env.RV_SHOTS, 'thread-open-1440.png') });
    // 펼친 답글에 답하면 맨 위 글을 root 로.
    await page.evaluate((id) => document.querySelector(`#tk-list [data-treply="${id}"]`).click(), DEEP);
    assert.match(await page.$eval('#tk-replytext', (e) => e.textContent), /이영희에게 답장/);
    await page.type('#tk-text', '좋아요');
    await page.click('#tk-send');
    await page.waitForFunction(() => window.__posts.length === 1);
    const sent = await page.evaluate(() => window.__posts[0]);
    assert.equal(sent.replyTo, DEEP); assert.equal(sent.replyRoot, TOP);
    // 보낸 내 답글이 펼친 자리에 바로 붙는다.
    await page.waitForFunction((id) => document.querySelectorAll(`#tk-list [data-thread="${id}"] .trow`).length === 3, { timeout: 5000 }, TOP);
    await page.evaluate((id) => document.querySelector(`#tk-list [data-say="${id}"]`).click(), TOP);
    assert.equal(await page.$eval(`#tk-list [data-thread="${TOP}"]`, (e) => e.hidden), true, '다시 누르면 접힌다');
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

test('피드: 「번역」 이름 · 「공개 주소로 굳히기」는 ⋯ 맨 끝 · 내 글에만 「이 컴퓨터에 보관됨」 · 단추 한 줄', async () => {
  const { page, errors } = await open();
  try {
    const acts = await page.$eval(`#tk-list [data-acts="${OTHER}"]`, (e) => [...e.querySelectorAll('button')].map((b) => b.textContent.trim()));
    assert.equal(acts[0], '번역');
    assert.equal(acts[acts.length - 1], '공개 주소로 굳히기');
    assert.ok(!acts.includes('내 말로') && !acts.includes('간직'), acts.join());
    assert.match(await page.$eval(`#tk-list [data-card="${TOP}"] .fkept`, (e) => e.textContent), /이 컴퓨터에 보관됨/);
    assert.equal(await page.$(`#tk-list [data-card="${OTHER}"] .fkept`), null, '남의 글엔 없음');
    for (const b of await page.$$('#tk-list .facts button')) {
      const r = await b.evaluate((x) => ({ h: x.getBoundingClientRect().height, ws: getComputedStyle(x).whiteSpace }));
      assert.equal(r.ws, 'nowrap'); assert.ok(r.h <= 48, `단추 높이 ${r.h}`);
    }
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});
