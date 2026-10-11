// 레이아웃 품질 관문(영구 시험) — 「글씨가 밀리고 칸이 좁은」 화면을 숫자로 막는다.
//
// 실제 Chrome 에서 빌드된 dist 를 합성 자료로 띄우고, 글자를 의사 현지화(원문 · +60% · +100% · 독일어 긴 합성어 · 러시아어)
// 로 바꿔 가며 폭 320·390·768·1024·1440 × 라이트·다크에서 잰다(scripts/layout-check.mjs):
//   가로 넘침 · 화면 밖 · 말줄임 없는 잘림 · 세로 잘림 · 누름 요소 겹침 · 버튼 안 낱말 쪼개짐 · 24px 미만 누름 영역 · 너무 좁은 칸
//   (말줄임·44px 미만은 표에만 — 관문 아님)
//
// 판정
//   · **새 화면은 반드시 0**: 미니 창(칩 포함 4 크기) · 대기화면 · 설정 「표시 방식」 칸 · 대화 부품.
//   · 기존 큰 창 화면은 scripts/layout-gate-baseline.json 에 적힌 실패만 허용(점차 줄인다). 새로 생긴 실패는 깨진다.
//     기준선 다시 쓰기: RV_LAYOUT_UPDATE=1 node --test scripts/layout-gate-browser.test.mjs (줄어든 것만 커밋할 것)
//   · 결과 표: artifacts/layout-gate/report.json, PNG 는 RV_LAYOUT_SHOTS=1 일 때.
// 노드·지갑·네트워크 없음. 가짜 IPC 는 보내기·잠금 해제 계열을 거절한다(desktop-fixture).
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, stat, mkdir, writeFile } from 'node:fs/promises';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve, join, extname, sep } from 'node:path';
import { tmpdir } from 'node:os';
import puppeteer from 'puppeteer-core';
import { build } from 'esbuild';
import { installFixture } from './desktop-fixture.mjs';
import { applyVariant, measureLayout, GATING } from './layout-check.mjs';

const root = resolve(import.meta.dirname, '..');
const OUT = join(root, 'artifacts/layout-gate');
const BASELINE = join(root, 'scripts/layout-gate-baseline.json');
const UPDATE = process.env.RV_LAYOUT_UPDATE === '1';
const SHOTS = process.env.RV_LAYOUT_SHOTS === '1';
const WIDTHS = [320, 390, 768, 1024, 1440];
const VARIANTS = ['orig', 'p60', 'p100', 'de', 'ru'];
const THEMES = ['light', 'dark'];
const NEW_SCOPE = /display-mode-card|^mini|^standby|^chat/;

const MAIN_SCREENS = [
  ['home', 'page-home'], ['wallet', 'page-wallet'], ['assets', 'page-assets'], ['sales', 'page-sales'], ['games', 'page-games'],
  ['market', 'page-market'], ['creator', 'page-creator'], ['ravi', 'page-ravi'], ['settings', 'page-settings'], ['shop', 'page-shop'],
  ['talk', 'page-talk'], ['door', 'page-door'],
];

let work, dist, browser, server, origin;
const findings = [];

before(async () => {
  await mkdir(OUT, { recursive: true });
  work = mkdtempSync(join(tmpdir(), 'rv-layout-gate-'));
  dist = join(work, 'dist');
  execFileSync(process.execPath, [resolve(root, 'node_modules/vite/bin/vite.js'), 'build', '--outDir', dist, '--emptyOutDir', '--logLevel', 'error'], { cwd: root, stdio: ['ignore', 'ignore', 'inherit'] });
  await build({ entryPoints: [join(root, 'scripts/fixtures/chat-demo.ts')], bundle: true, outdir: join(dist, '__chat'), format: 'esm', logLevel: 'silent' });
  await writeFile(join(dist, '__chat/index.html'), '<!doctype html><html lang="ko"><head><meta charset="utf-8"><link rel="stylesheet" href="/__chat/chat-demo.css"></head><body><div id="host"></div><script type="module" src="/__chat/chat-demo.js"></script></body></html>');
  const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.webp': 'image/webp', '.jpg': 'image/jpeg' };
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
after(async () => {
  await browser?.close(); server?.close(); if (work) rmSync(work, { recursive: true, force: true });
});

async function newPage(width, height, theme) {
  const page = await browser.newPage();
  await page.setViewport({ width, height });
  await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: theme }, { name: 'prefers-reduced-motion', value: 'reduce' }]);
  await page.setRequestInterception(true);
  page.on('request', (r) => ((new URL(r.url()).origin === origin && r.method() === 'GET') ? r.continue() : r.abort()));
  return page;
}

async function sweep(page, name, scope, width, theme, prep) {
  for (const v of VARIANTS) {
    await page.evaluate(applyVariant, v);
    if (prep) await prep(page);
    await new Promise((r) => setTimeout(r, 60));
    const rows = await page.evaluate(measureLayout, { scope, screen: name });
    for (const r of rows) findings.push({ ...r, width, theme, variant: v });
    if (SHOTS && (v === 'orig' || v === 'de')) await page.screenshot({ path: join(OUT, `${name}-${width}-${theme}-${v}.png`) });
  }
  await page.evaluate(applyVariant, 'orig');
}

// 기존 큰 창 + 새 「표시 방식」 칸(설정 화면 안)
async function mainScreens() {
  for (const width of WIDTHS) for (const theme of THEMES) {
    const page = await newPage(width, Math.round(width * 0.7) + 200, theme);
    await page.evaluateOnNewDocument(installFixture, { theme, sales: true, seller: true });
    await page.evaluateOnNewDocument(() => {
      localStorage.setItem('rv-v2-backup-reminded', '1');
      const real = window.__TAURI_INTERNALS__.invoke;
      window.__TAURI_INTERNALS__.invoke = async (cmd, args) => cmd === 'display_mode_get'
        ? { settings: { mode: 'mini', hide_dock: true, tray_text: 'alerts', dim_from: 22, dim_to: 7, shift: true, locale: 'ko' }, supports: { dock: true, tray_text: true, tray: true, tray_click_menu: true, os: 'macos' } }
        : real(cmd, args);
    });
    await page.goto(origin + '/', { waitUntil: 'networkidle0' });
    await page.waitForFunction(() => document.querySelector('#page-home.on') && document.getElementById('display-mode-card'), { timeout: 20000 });
    await page.evaluate(() => document.querySelector('#display-mode-card details')?.setAttribute('open', ''));
    for (const [name, id] of MAIN_SCREENS) {
      const ok = await page.evaluate((pid) => { const p = document.getElementById(pid); if (!p) return false; document.querySelectorAll('section.page').forEach((s) => s.classList.toggle('on', s === p)); window.scrollTo(0, 0); return true; }, id);
      if (!ok) continue;
      await sweep(page, name, `#${id}, nav`, width, theme);
      // 0.9.0 설정 B — 한 번에 한 주제만 보인다. 전에는 한 페이지에 다 보이던 칸을 계속 재도록 주제마다 따로 잰다
      // (「자세히」로 접은 설명도 펼쳐서) — 화면을 나눴다고 잴 범위가 줄면 안 된다.
      // 폭은 앱 창의 최소 폭(tauri.conf minWidth 720) 이상만 — 320·390 에서는 예전에 「한 번만 하는 일」로 접혀
      // 재지 않던 백업·가게·열쇠 칸이 이미 좁아 깨진다(0.9.0 이전부터, 접혀 있어 안 잡혔을 뿐). 그 목록은 레인 보고에 따로 적었다.
      if (name === 'settings' && width >= 720 && await page.$('#page-settings .sx-list')) {
        await page.evaluate(() => document.querySelectorAll('#page-settings details.sx-more').forEach((d) => d.setAttribute('open', '')));
        for (const pane of await page.$$eval('#page-settings .sx-list .sx-it', (b) => b.map((x) => x.dataset.sxGo).slice(1))) {
          await page.evaluate((p) => document.querySelector(`#page-settings .sx-list .sx-it[data-sx-go="${p}"]`).click(), pane);
          await sweep(page, name, `#${id}`, width, theme);
        }
        await page.evaluate(() => document.querySelector('#page-settings .sx-list .sx-it[data-sx-go="general"]').click());
      }
    }
    // 표시 방식 칸만 따로(새 화면 — 0 이어야 한다). 큰 창은 최소 폭 720(tauri.conf.json)이라 그보다 좁은 폭은 잴 대상이 아니다.
    if (width < 720) { await page.close(); continue; }
    await page.evaluate(() => { document.querySelectorAll('section.page').forEach((s) => s.classList.toggle('on', s.id === 'page-settings')); document.getElementById('display-mode-card').scrollIntoView(); });
    await sweep(page, 'display-mode-card', '#display-mode-card', width, theme);
    await page.close();
  }
}

// 미니 창(칩 포함) — 창 크기 그대로
function miniStub(initial) {
  const cbs = {}, listeners = {}; let n = 0; const state = JSON.parse(initial);
  window.__emit = (event, payload) => (listeners[event] || []).forEach((id) => cbs[id]({ event, id, payload }));
  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
  window.__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label: state.label }, currentWebview: { windowLabel: state.label, label: state.label } },
    transformCallback(cb) { const id = ++n; cbs[id] = cb; return id; }, unregisterCallback(id) { delete cbs[id]; },
    async invoke(cmd, args) {
      if (cmd === 'plugin:event|listen') { (listeners[args.event] ||= []).push(args.handler); return args.handler; }
      if (cmd === 'mini_state') return { settings: state.settings, snapshot: state.snapshot };
      if (cmd === 'mini_set') return { settings: state.settings };
      if (cmd === 'standby_state') return { snapshot: state.snapshot, settings: { dim_from: 22, dim_to: 7, shift: true, locale: 'ko' } };
      return null;
    },
  };
}
export const SNAP = (masked, seller) => ({
  masked, locale: 'ko', status: 'ok', node: { state: 'ok', blocks: 3512345, peers: 8, behind: 0 },
  balance: { known: true, confirmed: masked ? null : '1,234.56789', pending: masked ? null : '12.5', has_pending: true },
  recent: [
    { dir: 'in', sale: seller, amount: masked ? null : '+12.5', unit: masked ? null : 'RVN', conf: 0, done: false, ago: 20 },
    { dir: 'in', sale: false, amount: masked ? null : '+3', unit: masked ? null : 'RV.T.TICKET_LONG_NAME', conf: 2, done: true, ago: 400 },
    { dir: 'out', sale: false, amount: masked ? null : '−250.25', unit: masked ? null : 'RVN', conf: 30, done: true, ago: 7200 },
    { dir: 'in', sale: false, amount: masked ? null : '+0.00000001', unit: masked ? null : 'RVN', conf: 90, done: true, ago: 90000 },
  ],
  lock: 'locked', awake: { holding: seller, note: '' },
  seller: seller ? { sales: 4, sales_rvn: masked ? null : '88.5', deposits: 2, deposits_rvn: masked ? null : '15.5', pending: 1 } : null,
  unseen: 0, need: 1, watching: true, notice: null,
});

async function miniScreens() {
  for (const [size, w, h] of [['xs', 160, 40], ['s', 220, 60], ['m', 300, 140], ['l', 360, 260]]) for (const theme of THEMES) for (const seller of [false, true]) for (const masked of [true, false]) {
    const page = await newPage(w, h, theme);
    await page.evaluateOnNewDocument(miniStub, JSON.stringify({ label: 'mini', settings: { size, on_top: true, mask: masked, capture_guard: true, sound: false, os_notify: true, need: 1, locale: 'ko', os_notify_supported: true }, snapshot: SNAP(masked, seller) }));
    await page.goto(`${origin}/mini.html`, { waitUntil: 'load' });
    await page.waitForFunction(() => document.getElementById('headline').textContent !== '…');
    await sweep(page, `mini-${size}${seller ? '-seller' : ''}${masked ? '' : '-open'}`, '#mini', w, theme);
    await page.close();
  }
}

async function standbyScreens() {
  for (const width of WIDTHS) for (const seller of [false, true]) for (const masked of [true, false]) {
    const page = await newPage(width, Math.round(width * 0.5625), 'dark');
    await page.evaluateOnNewDocument(miniStub, JSON.stringify({ label: 'standby', snapshot: SNAP(masked, seller) }));
    await page.goto(`${origin}/standby.html`, { waitUntil: 'load' });
    await page.waitForFunction(() => document.getElementById('sb-clock').textContent !== '--:--');
    await sweep(page, `standby${seller ? '-seller' : ''}${masked ? '' : '-open'}`, '#sb', width, 'dark');
    await page.close();
  }
}

async function chatScreens() {
  for (const width of [280, ...WIDTHS]) for (const theme of THEMES) {
    const page = await newPage(width, 560, theme);
    await page.goto(`${origin}/__chat/index.html`, { waitUntil: 'load' });
    await page.waitForFunction(() => document.querySelectorAll('.rvc-bubble').length === 5);
    await sweep(page, 'chat', '.rvc', width, theme);
    await page.close();
  }
}

const fmt = (f) => `${f.screen}|${f.check}|${f.key}`;

test('레이아웃 관문: 새 화면 0건 · 기존 화면은 기준선보다 늘지 않음', { timeout: 1_800_000 }, async () => {
  await miniScreens();
  await standbyScreens();
  await chatScreens();
  await mainScreens();
  const gating = findings.filter((f) => GATING.has(f.check));
  // 표(요약) — 화면 × 종류
  const table = {};
  for (const f of findings) { table[f.screen] ??= {}; table[f.screen][f.check] = (table[f.screen][f.check] || 0) + 1; }
  const keys = [...new Set(gating.map(fmt))].sort();
  const isNew = (k) => NEW_SCOPE.test(k.split('|')[0]) || k.includes('display-mode-card');
  await writeFile(join(OUT, 'report.json'), JSON.stringify({ when: new Date().toISOString(), table, gatingKeys: keys, findings: gating }, null, 1));
  console.log('레이아웃 관문 표(화면 × 종류, 측정 건수):'); console.table(table);
  const fresh = keys.filter(isNew);
  const sample = (k) => { const f = gating.find((x) => fmt(x) === k); return `${k} — ${f.width}px ${f.theme} ${f.variant} ${f.detail} 「${f.text}」`; };
  assert.deepEqual(fresh.map(sample), [], '새 화면(미니·칩·대기화면·표시 방식 칸·대화 부품)은 실패 0 이어야 한다');
  const legacy = keys.filter((k) => !isNew(k));
  if (UPDATE) { await writeFile(BASELINE, JSON.stringify({ note: '기존 큰 창 화면의 알려진 레이아웃 실패. 줄이기만 한다(docs/design/layout-tokens.md §관문).', keys: legacy }, null, 1) + '\n'); return; }
  const base = existsSync(BASELINE) ? new Set(JSON.parse(readFileSync(BASELINE, 'utf8')).keys) : new Set();
  const added = legacy.filter((k) => !base.has(k));
  assert.deepEqual(added.map(sample), [], '기존 화면에 새 레이아웃 실패가 생겼다(기준선에 없음)');
  const fixed = [...base].filter((k) => !legacy.includes(k));
  if (fixed.length) console.log(`기준선에서 고쳐진 것 ${fixed.length}건 — RV_LAYOUT_UPDATE=1 로 기준선을 줄여 주세요.`);
});
