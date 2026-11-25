// 11-25 0.9.48 다듬기 — 주요 화면을 「여러 상태가 한꺼번에 참」인 합성 자료로 찍고, 한 화면에 같은 글이 두 번 보이는지 센다(사람 눈 검사용, 시험 아님).
//   RV_DIST=<dist> RV_SHOTS=<폴더> node scripts/desk-polish-shots.mjs [tag]
// 상태: 백업 안 됨 · 노드 꺼짐 · 새 주문(두 번째 바퀴) · 안 읽은 이야기 글(두 번째 바퀴) · 들어오는 중인 돈.
// 노드·지갑·네트워크 없음. 보내기·잠금 해제 계열은 desktop-fixture 가 거절한다.
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join, extname, sep } from 'node:path';
import puppeteer from 'puppeteer-core';
import { installFixture } from './desktop-fixture.mjs';

const dist = resolve(process.env.RV_DIST || 'dist');
const SHOTS = resolve(process.env.RV_SHOTS || 'artifacts/desk-polish');
const tag = process.argv[2] || 'after';
mkdirSync(SHOTS, { recursive: true });
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.webp': 'image/webp', '.json': 'application/json', '.wasm': 'application/wasm' };
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
const settle = (ms = 500) => new Promise((r) => setTimeout(r, ms));
const ONLY = process.env.RV_ONLY ? new Set(process.env.RV_ONLY.split(',')) : null;

function busyStub(o) {
  localStorage.setItem('ravenvault-text-size', 'normal'); localStorage.setItem('ravenvault-text-size-asked', '1');
  if (o.healthy) localStorage.setItem('rv-v2-backup-reminded', '1');
  const real = window.__TAURI_INTERNALS__.invoke; const n = {};
  const other = 'f'.repeat(64);
  window.__TAURI_INTERNALS__.invoke = async (cmd, args) => {
    n[cmd] = (n[cmd] || 0) + 1;
    if (!o.healthy) {
      if (cmd === 'node_status') throw Error('connection refused');
      if (cmd === 'node_boot' || cmd === 'node_boot_state') return { booting: false, stalled: false };
      if (cmd === 'backup_survey') return { automatic: { local_complete: false }, items: [] };
      if (cmd === 'backup_pass_state') return { configured: false };
      if (cmd === 'incoming_payments') return { payments: n[cmd] > 1 ? [{ address: 'RPublicFixtureOrder1', settled: false }, { address: 'RPublicFixtureOrder2', settled: false }] : [] };
      if (cmd === 'talk_read') return n[cmd] > 2 ? [{ id: 'n1', pubkey: other, content: '안녕하세요', created_at: 1791500000 }, { id: 'n2', pubkey: other, content: '오늘 영업하세요?', created_at: 1791500100 }] : [];
    }
    if (cmd === 'node_status' && o.healthy) return { progress: 1, blocks: 4000000, headers: 4000000, connections: 8, chain: 'main' };
    if (cmd === 'miner_running') return { running: false };
    return real(cmd, args);
  };
}

async function open({ W, H, theme = 'light', healthy = false }) {
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.log('pageerror', String(e).slice(0, 200)));
  await page.setViewport({ width: W, height: H });
  await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: theme }, { name: 'prefers-reduced-motion', value: 'reduce' }]);
  await page.setRequestInterception(true);
  page.on('request', (r) => ((new URL(r.url()).origin === origin && r.method() === 'GET') ? r.continue() : r.abort()));
  await page.evaluateOnNewDocument(installFixture, { theme, sales: true, seller: true });
  await page.evaluateOnNewDocument(busyStub, { healthy });
  await page.goto(origin + '/', { waitUntil: 'networkidle0' });
  await page.waitForFunction(() => document.querySelector('#page-home.on'), { timeout: 20000 });
  // 주문(10초 주기)·이야기 글 두 번째 바퀴까지 기다린다.
  if (!healthy) await page.waitForFunction(() => !document.getElementById('nav-orderbadge')?.hidden, { timeout: 30000 }).catch(() => console.log('  (새 주문 배지 안 뜸)'));
  await settle(1500);
  return page;
}

/** 지금 화면에 보이는 글 조각 중 같은 글이 둘 이상인 것(단추·제목·문단 단위). */
function dupes() {
  const vis = (el) => { const r = el.getBoundingClientRect(); if (r.width < 1 || r.height < 1 || r.bottom < 0 || r.top > innerHeight || r.right < 0 || r.left > innerWidth) return false; const s = getComputedStyle(el); return s.visibility !== 'hidden' && s.opacity !== '0'; };
  const els = [...document.querySelectorAll('button, a, h1, h2, h3, p, b, strong, span, small, label, summary, li')].filter((el) => {
    if (!vis(el) || el.closest('body > nav')) return false; // 왼쪽 메뉴 이름 = 화면 제목은 중복이 아니다
    // 가장 안쪽 글 단위만(자식에 같은 종류가 있으면 건너뜀)
    return ![...el.children].some((c) => c.textContent.trim() === el.textContent.trim());
  });
  const seen = new Map();
  for (const el of els) {
    const t = el.textContent.replace(/\s+/g, ' ').trim();
    if (t.length < 2 || /^[\d.,:·\s+−-]+$/.test(t)) continue;
    const id = el.id || el.className?.toString().split(' ')[0] || el.tagName;
    (seen.get(t) || seen.set(t, []).get(t)).push(id);
  }
  return [...seen].filter(([, v]) => v.length > 1).map(([k, v]) => `${k} ×${v.length} [${v.join(', ')}]`);
}
/** 줄바꿈된 단추·말줄임된 글. */
function wraps() {
  const out = [];
  for (const b of document.querySelectorAll('button, a, [role=tab], .ordbadge')) {
    const r = b.getBoundingClientRect(); if (r.width < 1 || r.bottom < 0 || r.top > innerHeight || r.right < 0 || r.left > innerWidth) continue;
    if (getComputedStyle(b).visibility === 'hidden') continue;
    // 글 줄 수 = 글자 조각 상자들의 서로 다른 윗줄 수(단추 안 여러 줄 구조 b/small 은 줄마다 따로 센다)
    const leaves = [...b.querySelectorAll('*')].filter((x) => !x.children.length && x.textContent.trim()); if (!leaves.length) leaves.push(b);
    for (const leaf of leaves) {
      const rg = document.createRange(); rg.selectNodeContents(leaf);
      const tops = new Set([...rg.getClientRects()].filter((q) => q.width > 0).map((q) => Math.round(q.top / 4)));
      if (tops.size > 1) { out.push(`wrap: ${b.textContent.replace(/\s+/g, ' ').trim().slice(0, 40)}`); break; }
    }
  }
  for (const el of document.querySelectorAll('*')) {
    if (el.children.length || el.closest('body > nav')) continue; // 레일 이름 12px 는 설계(FINAL 2) const r = el.getBoundingClientRect(); if (r.width < 1 || r.bottom < 0 || r.top > innerHeight) continue;
    if (el.scrollWidth > el.clientWidth + 1 && getComputedStyle(el).textOverflow === 'ellipsis') out.push(`ellipsis: ${el.textContent.trim().slice(0, 40)}`);
    const fs = parseFloat(getComputedStyle(el).fontSize); if (fs < 13 && el.textContent.trim()) out.push(`small ${fs}px: ${el.textContent.trim().slice(0, 30)}`);
  }
  return [...new Set(out)];
}

const SIZES = [['400', 400, 640, 'light'], ['873', 873, 770, 'light'], ['1440', 1440, 900, 'light'], ['400d', 400, 640, 'dark']];
const SCREENS = [
  ['home', null], ['wallet', 'wallet'], ['talk', 'talk'], ['plaza', 'plaza'], ['room', 'room'], ['trade', 'trade'], ['market', 'market'], ['games', 'games'], ['shop', 'shop'], ['settings', 'settings'], ['ravi', 'ravi'], ['panel', 'panel'],
];
const report = {};
for (const [sz, W, H, theme] of SIZES) {
  for (const healthy of [false, true]) {
    if (healthy && sz !== '400') continue;
    const page = await open({ W, H, theme, healthy });
    for (const [name, go] of SCREENS) {
      if (ONLY && !ONLY.has(name)) continue;
      if (healthy && name !== 'home') continue;
      if (go === 'plaza') await page.evaluate(() => { document.querySelector('nav a[data-page="talk"]')?.click(); });
      else if (go === 'room') await page.evaluate(() => { document.querySelector('nav a[data-page="talk"]')?.click(); });
      else if (go === 'panel') await page.evaluate(() => { document.querySelector('nav a[data-page="home"]')?.click(); document.getElementById('rv-header-ravi')?.click(); });
      else if (go) await page.evaluate((p) => { const a = document.querySelector(`nav a[data-page="${p}"]`); if (a && !a.hidden) a.click(); else window.__rvShow?.(p); }, go);
      else await page.evaluate(() => document.querySelector('nav a[data-page="home"]')?.click());
      await settle(900);
      if (go === 'plaza') { await page.evaluate(() => { const b = [...document.querySelectorAll('#page-talk [role=tab], #page-talk button')].find((x) => /광장/.test(x.textContent) && x.offsetParent); b?.click(); }); await settle(700); }
      if (go === 'room') { await page.evaluate(() => { const b = document.querySelector('#page-talk .tk-room, #page-talk [data-room]'); b?.click(); }); await settle(700); }
      await page.evaluate(() => window.scrollTo(0, 0));
      const key = `${name}-${sz}${healthy ? '-ok' : ''}`;
      await page.screenshot({ path: join(SHOTS, `${tag}-${key}.png`) });
      if (name === 'home') await page.screenshot({ path: join(SHOTS, `${tag}-${key}-full.png`), fullPage: true });
      const on = await page.evaluate(() => document.querySelector('section.page.on')?.id);
      report[key] = { on, dupes: await page.evaluate(dupes), wraps: await page.evaluate(wraps) };
    }
    await page.close();
  }
}
writeFileSync(join(SHOTS, `${tag}-report.json`), JSON.stringify(report, null, 1));
for (const [k, v] of Object.entries(report)) console.log(k, v.on, '\n  dupes:', v.dupes.join(' | ') || '-', '\n  wraps:', v.wraps.slice(0, 12).join(' | ') || '-');
await browser.close(); server.close();
console.log('shots →', SHOTS);
