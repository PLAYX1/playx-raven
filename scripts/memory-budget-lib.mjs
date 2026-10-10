// Memory-budget measurement helpers (real Chrome via puppeteer-core, production dist, synthetic data).
// Used by scripts/memory-budget-browser.test.mjs and scripts/measure-memory.mjs.
// No network, no real wallet/app data: every IPC call goes to the synthetic fixture
// in desktop-fixture.mjs (which never answers reveal/unlock/send commands).
import { createServer } from 'node:http';
import { readFile, stat, readdir } from 'node:fs/promises';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve, join, extname, sep } from 'node:path';
import { tmpdir } from 'node:os';
import puppeteer from 'puppeteer-core';
import { installFixture } from './desktop-fixture.mjs';

export const root = resolve(import.meta.dirname, '..');
export const MB = 1024 * 1024;
export const round = (n, d = 2) => Math.round(n * 10 ** d) / 10 ** d;

// Runs before any production code: counts timer/rAF callbacks that actually FIRE, split by
// whether the page claims to be hidden, plus IPC commands sent while hidden. It also lets the
// harness flip document.hidden / visibilityState (headless Chrome pages are always visible).
export function installProbe() {
  const probe = { hidden: false, fired: { interval: 0, timeout: 0, raf: 0 }, hiddenFired: { interval: 0, timeout: 0, raf: 0 }, hiddenInvokes: [], liveIntervals: 0 };
  window.__memProbe = probe;
  Object.defineProperty(Document.prototype, 'hidden', { configurable: true, get: () => probe.hidden });
  Object.defineProperty(Document.prototype, 'visibilityState', { configurable: true, get: () => probe.hidden ? 'hidden' : 'visible' });
  const count = kind => { probe.fired[kind]++; if (probe.hidden) probe.hiddenFired[kind]++; };
  const si = window.setInterval.bind(window), ci = window.clearInterval.bind(window), st = window.setTimeout.bind(window), raf = window.requestAnimationFrame.bind(window);
  const live = new Set();
  window.setInterval = (fn, ms, ...a) => { const id = si((...x) => { count('interval'); return typeof fn === 'function' ? fn(...x) : undefined; }, ms, ...a); live.add(id); probe.liveIntervals = live.size; return id; };
  window.clearInterval = id => { live.delete(id); probe.liveIntervals = live.size; return ci(id); };
  window.setTimeout = (fn, ms, ...a) => st((...x) => { count('timeout'); return typeof fn === 'function' ? fn(...x) : undefined; }, ms, ...a);
  window.requestAnimationFrame = fn => raf(t => { count('raf'); fn(t); });
  // Wrap the fixture's invoke lazily (the fixture installs __TAURI_INTERNALS__ in the same tick).
  queueMicrotask(() => {
    const ti = window.__TAURI_INTERNALS__; if (!ti) return;
    const inv = ti.invoke;
    ti.invoke = (cmd, ...rest) => { if (probe.hidden) probe.hiddenInvokes.push(cmd); return inv(cmd, ...rest); };
  });
  probe.setHidden = h => { probe.hidden = h; document.dispatchEvent(new Event('visibilitychange')); window.dispatchEvent(new Event(h ? 'blur' : 'focus')); };
}

export async function buildDist() {
  if (process.env.RV_DIST && existsSync(join(process.env.RV_DIST, 'index.html'))) return { dist: process.env.RV_DIST, cleanup() {} };
  const work = mkdtempSync(join(tmpdir(), 'rv-memory-'));
  const dist = join(work, 'dist');
  execFileSync(process.execPath, [resolve(root, 'node_modules/vite/bin/vite.js'), 'build', '--outDir', dist, '--emptyOutDir', '--logLevel', 'error'], { cwd: root, stdio: ['ignore', 'ignore', 'inherit'] });
  return { dist, cleanup() { rmSync(work, { recursive: true, force: true }); } };
}

export async function bundleSizes(dist) {
  const out = { files: {}, js: 0, css: 0, html: 0 };
  const walk = async d => { for (const e of await readdir(d, { withFileTypes: true })) { const p = join(d, e.name); if (e.isDirectory()) await walk(p); else { const s = (await stat(p)).size; const rel = p.slice(dist.length + 1); out.files[rel] = s; const x = extname(p); if (x === '.js') out.js += s; else if (x === '.css') out.css += s; else if (x === '.html') out.html += s; } } };
  await walk(dist);
  const js = Object.entries(out.files).filter(([f]) => f.endsWith('.js'));
  out.largestJs = js.reduce((a, [f, s]) => s > a.size ? { file: f, size: s } : a, { file: '', size: 0 });
  return out;
}

export async function startServer(dist) {
  const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.json': 'application/json' };
  const server = createServer(async (req, res) => {
    try {
      const path = resolve(dist, '.' + decodeURIComponent(new URL(req.url, 'http://x').pathname));
      if (path !== dist && !path.startsWith(dist + sep)) throw Error('path');
      const file = path === dist ? join(dist, 'index.html') : path;
      if (!(await stat(file)).isFile()) throw Error('file');
      res.writeHead(200, { 'Content-Type': types[extname(file)] || 'application/octet-stream' }); res.end(await readFile(file));
    } catch { res.writeHead(404); res.end(); }
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  return { server, origin: `http://127.0.0.1:${server.address().port}` };
}

export async function launch(work) {
  return puppeteer.launch({
    executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: true, userDataDir: join(work, 'profile'),
    args: ['--no-first-run', '--disable-background-networking', '--js-flags=--expose-gc'],
  });
}

/** Opens a production entry (index.html or companion.html) with the synthetic fixture + probe. */
export async function openEntry(browser, origin, { entry = '/', motion = 'reduce', theme = 'light', seller = true, waitHome = true } = {}) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1120, height: 780 });
  await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: theme }, { name: 'prefers-reduced-motion', value: motion }]);
  await page.setRequestInterception(true);
  page.on('request', r => (new URL(r.url()).origin === origin && r.method() === 'GET') ? r.continue() : r.abort());
  await page.evaluateOnNewDocument(installFixture, { theme, sales: true, seller });
  await page.evaluateOnNewDocument(installProbe);
  await page.goto(origin + entry, { waitUntil: 'networkidle0' });
  if (waitHome) await page.waitForFunction(() => document.querySelector('#page-home.on') && !document.documentElement.hasAttribute('data-ravi-arriving'), { timeout: 20000 });
  const cdp = await page.createCDPSession();
  await cdp.send('Performance.enable');
  return { page, cdp };
}

/** Heap after a forced GC, DOM counters, and an estimate of decoded image/canvas pixel memory. */
export async function snapshot(page, cdp) {
  await cdp.send('HeapProfiler.collectGarbage');
  await cdp.send('HeapProfiler.collectGarbage');
  const { metrics } = await cdp.send('Performance.getMetrics');
  const m = Object.fromEntries(metrics.map(x => [x.name, x.value]));
  const dom = await cdp.send('Memory.getDOMCounters');
  const pixels = await page.evaluate(() => {
    let img = 0, canvas = 0, imgs = 0, canvases = 0;
    // The same URL at the same size is decoded once and shared, so count each unique image once.
    const seen = new Set();
    for (const i of document.images) if (i.complete && i.naturalWidth) { const k = `${i.currentSrc || i.src}|${i.naturalWidth}x${i.naturalHeight}`; if (seen.has(k)) continue; seen.add(k); img += i.naturalWidth * i.naturalHeight * 4; imgs++; }
    for (const c of document.querySelectorAll('canvas')) { canvas += c.width * c.height * 4; canvases++; }
    return { img, canvas, imgs, canvases };
  });
  return {
    heapUsedMB: round(m.JSHeapUsedSize / MB), heapTotalMB: round(m.JSHeapTotalSize / MB),
    nodes: dom.nodes, documents: dom.documents, listeners: dom.jsEventListeners,
    layoutObjects: m.LayoutObjects, imageDecodedMB: round(pixels.img / MB), canvasMB: round(pixels.canvas / MB),
    images: pixels.imgs, canvases: pixels.canvases,
  };
}

export const PAGES = ['home', 'wallet', 'assets', 'talk', 'shop', 'door', 'profile', 'ravi', 'reward', 'artist', 'games', 'helping', 'settings', 'sales'];

export async function goPage(page, id) {
  await page.evaluate(p => document.querySelector(`nav a[data-page="${p}"]`)?.click(), id);
  await page.waitForFunction(p => document.querySelector(`#page-${p}.on`), { timeout: 5000 }, id).catch(() => {});
  await new Promise(r => setTimeout(r, 150));
}

/** Least-squares slope of y over x (MB per navigation, nodes per navigation). */
export function slope(points) {
  const n = points.length; if (n < 2) return 0;
  const mx = points.reduce((a, p) => a + p[0], 0) / n, my = points.reduce((a, p) => a + p[1], 0) / n;
  let num = 0, den = 0; for (const [x, y] of points) { num += (x - mx) * (y - my); den += (x - mx) ** 2; }
  return den ? num / den : 0;
}

export { mkdtempSync, rmSync, join, tmpdir };
