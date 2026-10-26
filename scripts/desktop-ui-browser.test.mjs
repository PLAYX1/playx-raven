// Production-dist UI checks in real Chrome. (1) Contrast sweep: every visible button-like control on every page, text colour vs. the
// alpha-composited background actually behind it. Catches rules that change only a background
// (e.g. `.card` over the global white-text `button`). Builds its own dist; no network, synthetic data.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, stat, mkdir, writeFile } from 'node:fs/promises';
import { mkdtempSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve, join, extname, sep } from 'node:path';
import { tmpdir } from 'node:os';
import puppeteer from 'puppeteer-core';
import { installFixture } from './desktop-fixture.mjs';

const root = resolve(import.meta.dirname, '..');
const MIN = 4.5;
const VIEWPORTS = [[1024, 640], [1440, 900]];
const THEMES = ['light', 'dark'];

// Runs inside the page. Pure measurement; does not change styles (only which .page is on).
function sweep(pageId) {
  document.querySelectorAll('section.page').forEach(p => p.classList.toggle('on', p.id === pageId));
  // rgb()/rgba() are 0-255; color(srgb ...) (what color-mix() computes to) is 0-1.
  const parse = c => { const v = c.match(/[\d.]+/g)?.map(Number); if (!v || v.length < 3) return [0, 0, 0, 0];
    return c.startsWith('color(') ? [v[0], v[1], v[2], v[3] ?? 1] : [v[0] / 255, v[1] / 255, v[2] / 255, v[3] ?? 1]; };
  // Inherited opacity (e.g. a dimmed tile) fades the text toward what is behind it.
  const opacityOf = el => { let o = 1; for (let p = el; p; p = p.parentElement) o *= parseFloat(getComputedStyle(p).opacity); return o; };
  const over = (a, b) => [...a.slice(0, 3).map((x, i) => x * a[3] + b[i] * (1 - a[3])), 1];
  const lum = c => { const f = x => x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]); };
  const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m); return (x + 0.05) / (y + 0.05); };
  const shown = el => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility === 'visible' && s.display !== 'none'; };
  const describe = el => el.id ? `#${el.id}` : el.tagName.toLowerCase() + (el.classList.length ? '.' + [...el.classList].join('.') : '') + (el.textContent.trim() ? `「${el.textContent.trim().replace(/\s+/g, ' ').slice(0, 24)}」` : '');
  const bgOf = el => { const chain = []; for (let p = el; p; p = p.parentElement) chain.unshift(p); let gradient = false;
    const c = chain.reduce((acc, p) => { const s = getComputedStyle(p); if (s.backgroundImage !== 'none' && p !== document.documentElement && p !== document.body) gradient = true; return over(parse(s.backgroundColor), acc); }, [1, 1, 1, 1]);
    return { c, gradient }; };
  const out = [];
  const scope = pageId === '__chrome__' ? document.querySelectorAll('nav button, nav a, header button, .desktop-header button') : document.querySelectorAll(`#${pageId} :is(button, [role="button"], a.btn, summary)`);
  for (const el of scope) {
    if (!shown(el) || el.disabled || el.closest('[hidden],[inert],[aria-hidden="true"]')) continue;
    const owners = [el, ...el.querySelectorAll('*')].filter(n => [...n.childNodes].some(t => t.nodeType === 3 && t.textContent.trim()) && shown(n));
    for (const n of owners) {
      const s = getComputedStyle(n); if (parseFloat(s.opacity) === 0) continue;
      const { c, gradient } = bgOf(n);
      const raw = parse(s.color); const fg = over([raw[0], raw[1], raw[2], raw[3] * opacityOf(n)], c);
      out.push({ control: describe(el), text: n === el ? null : describe(n), ratio: Math.round(ratio(fg, c) * 100) / 100, fg: s.color, gradient });
    }
  }
  return out;
}

let work, dist, browser, server, origin;
before(async () => {
  work = mkdtempSync(join(tmpdir(), 'rv-desktop-ui-'));
  dist = join(work, 'dist');
  execFileSync(process.execPath, [resolve(root, 'node_modules/vite/bin/vite.js'), 'build', '--outDir', dist, '--emptyOutDir', '--logLevel', 'error'], { cwd: root, stdio: ['ignore', 'ignore', 'inherit'] });
  const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.jpg': 'image/jpeg', '.webp': 'image/webp' };
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
});
after(async () => { await browser?.close(); server?.close(); if (work) rmSync(work, { recursive: true, force: true }); });
async function open({ width, height, theme, seller, sales = true }) {
  const page = await browser.newPage();
  await page.setViewport({ width, height });
  await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: theme }, { name: 'prefers-reduced-motion', value: 'reduce' }]);
  await page.setRequestInterception(true);
  page.on('request', r => (new URL(r.url()).origin === origin && r.method() === 'GET') ? r.continue() : r.abort());
  await page.evaluateOnNewDocument(installFixture, { theme, sales, seller });
  await page.goto(origin + '/', { waitUntil: 'networkidle0' });
  await page.waitForFunction(() => document.querySelector('#page-home.on') && !document.documentElement.hasAttribute('data-ravi-arriving'), { timeout: 20000 });
  return page;
}

test('button text contrast >= 4.5:1 on every page (1024x640, 1440x900; light/dark; seller mode on)', { timeout: 600_000 }, async () => {
  const failures = [], gradients = new Set(); let measured = 0;
  for (const [width, height] of VIEWPORTS) for (const theme of THEMES) {
    const page = await open({ width, height, theme, seller: true });
    await page.evaluate(() => { document.querySelector('nav')?.classList.add('more-open'); document.querySelector('#rv-home-extras')?.setAttribute('open', ''); });
    const ids = await page.$$eval('section.page[id]', els => els.map(e => e.id));
    for (const id of [...ids, '__chrome__']) {
      const rows = await page.evaluate(sweep, id);
      measured += rows.length;
      for (const r of rows) {
        if (r.gradient) { gradients.add(`${id} ${r.control}`); continue; }
        if (r.ratio < MIN) failures.push({ viewport: `${width}x${height}`, theme, page: id, ...r });
      }
    }
    await page.close();
  }
  const report = { measured, min: MIN, failures, skippedGradientBackgrounds: [...gradients].sort() };
  if (process.env.RV_CONTRAST_REPORT) { await mkdir(resolve(process.env.RV_CONTRAST_REPORT, '..'), { recursive: true }); await writeFile(process.env.RV_CONTRAST_REPORT, JSON.stringify(report, null, 2)); }
  assert.ok(measured > 100, `sweep measured too little (${measured})`);
  assert.deepEqual(failures, [], `low-contrast controls:\n${failures.map(f => `${f.viewport} ${f.theme} ${f.page} ${f.control}${f.text ? ' > ' + f.text : ''} ${f.ratio}:1`).join('\n')}`);
});

// (2) Seller mode: the three sales entrances are absent for ordinary users (layout, Tab order,
// accessibility tree and programmatic navigation) and appear only after the settings switch.
const SELLER = ['nav a[data-page="sales"]', '#rv-home-sales', '#game-sales-open', '#creator-open', '#page-creator'];
const sellerState = page => page.evaluate(sels => sels.map(sel => { const el = document.querySelector(sel);
  return { sel, exists: !!el, hidden: !!el?.hidden, inert: !!el?.inert, rendered: !!el?.getClientRects().length }; }), SELLER);
async function tabStops(page) {
  await page.evaluate(() => { document.activeElement?.blur(); window.scrollTo(0, 0); });
  const seen = [];
  for (let i = 0; i < 400; i++) { await page.keyboard.press('Tab'); const id = await page.evaluate(() => { const a = document.activeElement; return a ? (a.id || a.getAttribute('data-page') || a.tagName) : null; }); if (!id || id === 'BODY') break; seen.push(id); }
  return seen;
}
const axNames = async page => { const names = []; const walk = n => { if (!n) return; if (n.name) names.push(n.name); (n.children || []).forEach(walk); }; walk(await page.accessibility.snapshot({ interestingOnly: false })); return names; };

test('seller mode: off by default (not rendered, not focusable, not in a11y tree, not navigable); settings switch reveals and persists', { timeout: 300_000 }, async () => {
  const page = await open({ width: 1024, height: 640, theme: 'light', seller: false });
  const ev = { off: await sellerState(page) };
  assert.ok(ev.off.every(e => e.exists && e.hidden && e.inert && !e.rendered), JSON.stringify(ev.off));
  await page.evaluate(() => { document.querySelector('nav')?.classList.add('more-open'); document.querySelector('#rv-home-extras')?.setAttribute('open', ''); });
  const stops = await tabStops(page);
  assert.ok(stops.length > 5, 'tab walk reached controls');
  assert.ok(!stops.includes('sales') && !stops.includes('rv-home-sales') && !stops.includes('game-sales-open') && !stops.includes('creator-open') && !stops.some(s => String(s).startsWith('creator-')), stops.join(','));
  const names = await axNames(page);
  assert.ok(!names.some(n => /판매 대금 받기|판매 계정|게임·음악 올리기/.test(n)), 'seller entrances leaked into accessibility tree');
  // Programmatic attempts (old saved page, scripted click) must not open the page.
  await page.evaluate(() => document.querySelector('nav a[data-page="sales"]').click());
  assert.equal(await page.$eval('#page-sales', p => p.classList.contains('on')), false);
  await page.evaluate(() => document.querySelector('#creator-open').click());
  assert.equal(await page.$eval('#page-creator', p => p.classList.contains('on')), false, 'creator page opened while seller mode is off');
  // Turn it on from settings.
  await page.click('nav a[data-page="settings"]');
  await page.waitForFunction(() => document.querySelector('#page-settings.on'));
  assert.equal(await page.$eval('#seller-mode', b => b.checked), false);
  assert.match(await page.$eval('#seller-mode-card', c => c.textContent), /내 게임을 팔 때만 켜세요/);
  await page.click('#seller-mode');
  ev.on = await sellerState(page);
  assert.ok(ev.on.every(e => e.exists && !e.hidden && !e.inert), JSON.stringify(ev.on));
  assert.equal(await page.evaluate(() => localStorage.getItem('rv-seller-mode')), '1');
  await page.evaluate(() => document.querySelector('nav').classList.add('more-open'));
  await page.click('nav a[data-page="sales"]');
  await page.waitForFunction(() => document.querySelector('#page-sales.on'));
  assert.equal(await page.$eval('#sales-public', el => el.children.length), 0, 'no disclosure without re-authentication');
  assert.deepEqual(await page.evaluate(() => window.__homeFixture.forbidden), [], 'no reveal/unlock command was sent');
  // Next start with the stored key (the fixture wipes storage on every load, so a fresh page
  // starting with exactly the key the switch wrote stands in for a restart).
  const restarted = await open({ width: 1024, height: 640, theme: 'light', seller: true });
  ev.restart = await sellerState(restarted);
  assert.ok(ev.restart.every(e => !e.hidden && !e.inert), JSON.stringify(ev.restart));
  assert.equal(await restarted.$eval('#seller-mode', b => b.checked), true);
  await restarted.close();
  // Turning it off while on the sales page leaves the page and hides everything again.
  await page.evaluate(() => document.querySelector('nav').classList.add('more-open'));
  await page.click('nav a[data-page="sales"]');
  await page.waitForFunction(() => document.querySelector('#page-sales.on'));
  await page.evaluate(() => { const b = document.querySelector('#seller-mode'); b.checked = false; b.dispatchEvent(new Event('change')); });
  assert.equal(await page.$eval('#page-sales', p => p.classList.contains('on')), false);
  ev.offAgain = await sellerState(page);
  assert.ok(ev.offAgain.every(e => e.hidden && e.inert && !e.rendered), JSON.stringify(ev.offAgain));
  assert.equal(await page.evaluate(() => localStorage.getItem('rv-seller-mode')), null);
  if (process.env.RV_SELLER_REPORT) await writeFile(process.env.RV_SELLER_REPORT, JSON.stringify({ ...ev, tabStops: stops }, null, 2));
  await page.close();
});
