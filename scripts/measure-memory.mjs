// Frontend memory measurement: per-screen heap/DOM/listeners, 100-navigation leak trend,
// hidden-window timer/IPC activity, companion window, bundle sizes.
//   node scripts/measure-memory.mjs            → artifacts/memory-budget/frontend.json
//   RV_DIST=<built dist> reuses a build; RV_NAV_ROUNDS / RV_HIDDEN_SECONDS shorten or lengthen runs.
// Synthetic data only (desktop-fixture.mjs); external requests are aborted.
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { buildDist, bundleSizes, startServer, launch, openEntry, snapshot, goPage, PAGES, slope, round, root, mkdtempSync, rmSync, join, tmpdir } from './memory-budget-lib.mjs';

const sleep = ms => new Promise(r => setTimeout(r, ms));

export async function measureFrontend({ navRounds = Number(process.env.RV_NAV_ROUNDS || 100), hiddenSeconds = Number(process.env.RV_HIDDEN_SECONDS || 35) } = {}) {
  const work = mkdtempSync(join(tmpdir(), 'rv-memory-run-'));
  const built = await buildDist();
  const { server, origin } = await startServer(built.dist);
  const browser = await launch(work);
  const result = { measuredAt: new Date().toISOString(), environment: { chrome: await browser.version(), node: process.version, platform: process.platform, viewport: '1120x780', note: 'Headless Chrome (V8/Blink). Tauri on macOS uses WKWebView, Windows WebView2 (Chromium) — absolute numbers differ on macOS; trends and DOM counts carry over.' } };
  try {
    result.bundle = await bundleSizes(built.dist);

    // 1) Per-screen footprint (reduced motion, as the existing UI harnesses do).
    {
      const { page, cdp } = await openEntry(browser, origin);
      await sleep(1500);
      result.startup = await snapshot(page, cdp);
      await page.evaluate(() => { window.__memProbe.fired = { interval: 0, timeout: 0, raf: 0 }; });
      await sleep(2000);
      result.rafPerSecondHomeReduced = round(await page.evaluate(() => window.__memProbe.fired.raf) / 2, 1);
      result.pages = {};
      for (const id of PAGES) { await goPage(page, id); await sleep(600); result.pages[id] = await snapshot(page, cdp); }
      result.unavailableCommands = [...new Set(await page.evaluate(() => window.__homeFixture.unavailable))].sort();
      result.forbiddenCommands = await page.evaluate(() => window.__homeFixture.forbidden);

      // 2) Leak trend: navigate round-robin navRounds times, GC-sampled every 10 navigations.
      const samples = [];
      for (let i = 1; i <= navRounds; i++) {
        await goPage(page, PAGES[i % PAGES.length]);
        if (i % 10 === 0) { const s = await snapshot(page, cdp); samples.push({ nav: i, heapUsedMB: s.heapUsedMB, nodes: s.nodes, listeners: s.listeners }); }
      }
      const warm = samples.filter(s => s.nav >= 20);
      result.leak = {
        navigations: navRounds, samples,
        heapSlopeKBPerNav: round(slope(warm.map(s => [s.nav, s.heapUsedMB])) * 1024, 1),
        nodeSlopePerNav: round(slope(warm.map(s => [s.nav, s.nodes])), 2),
        listenerSlopePerNav: round(slope(warm.map(s => [s.nav, s.listeners])), 2),
        heapGrowthMB: warm.length ? round(warm.at(-1).heapUsedMB - warm[0].heapUsedMB) : 0,
        intervalsAlive: await page.evaluate(() => window.__memProbe.liveIntervals),
      };

      // 3) Hidden window (minimized / closed-to-tray): which callbacks still fire, which IPC still goes out.
      await goPage(page, 'home');
      await page.evaluate(() => { window.__memProbe.hiddenFired = { interval: 0, timeout: 0, raf: 0 }; window.__memProbe.hiddenInvokes = []; window.__memProbe.setHidden(true); });
      await sleep(hiddenSeconds * 1000);
      const hidden = await page.evaluate(() => ({ fired: window.__memProbe.hiddenFired, invokes: window.__memProbe.hiddenInvokes.slice() }));
      await page.evaluate(() => window.__memProbe.setHidden(false));
      const byCmd = {}; for (const c of hidden.invokes) byCmd[c] = (byCmd[c] || 0) + 1;
      result.hidden = { seconds: hiddenSeconds, fired: hidden.fired, invokesTotal: hidden.invokes.length, invokesPerMinute: round(hidden.invokes.length * 60 / hiddenSeconds, 1), invokesByCommand: byCmd };
      await page.close();
    }

    // 4) Motion on (Ravi face/animation not reduced): home + ravi screen, and rAF while hidden.
    {
      const { page, cdp } = await openEntry(browser, origin, { motion: 'no-preference' });
      await sleep(1500);
      await page.evaluate(() => { window.__memProbe.fired = { interval: 0, timeout: 0, raf: 0 }; });
      await sleep(3000);
      const visibleRaf = await page.evaluate(() => window.__memProbe.fired.raf);
      await goPage(page, 'ravi'); await sleep(800);
      const raviPage = await snapshot(page, cdp);
      await goPage(page, 'home');
      await page.evaluate(() => { window.__memProbe.hiddenFired = { interval: 0, timeout: 0, raf: 0 }; window.__memProbe.setHidden(true); });
      await sleep(3000);
      const hiddenRaf = await page.evaluate(() => window.__memProbe.hiddenFired.raf);
      result.motion = { home: await snapshot(page, cdp), ravi: raviPage, rafPerSecondVisible: round(visibleRaf / 3, 1), rafPerSecondHidden: round(hiddenRaf / 3, 1) };
      await page.close();
    }

    // 5) Companion (the small always-on Ravi window) — the closest thing on this branch to a mini window.
    {
      const { page, cdp } = await openEntry(browser, origin, { entry: '/companion.html', motion: 'no-preference', waitHome: false });
      await page.setViewport({ width: 220, height: 220 });
      await sleep(2000);
      const visible = await snapshot(page, cdp);
      await page.evaluate(() => { window.__memProbe.fired = { interval: 0, timeout: 0, raf: 0 }; });
      await sleep(3000);
      const rafVisible = await page.evaluate(() => window.__memProbe.fired.raf);
      await page.evaluate(() => { window.__memProbe.hiddenFired = { interval: 0, timeout: 0, raf: 0 }; window.__memProbe.hiddenInvokes = []; window.__memProbe.setHidden(true); });
      await sleep(5000);
      const h = await page.evaluate(() => ({ fired: window.__memProbe.hiddenFired, invokes: window.__memProbe.hiddenInvokes.length }));
      result.companion = { ...visible, rafPerSecondVisible: round(rafVisible / 3, 1), hiddenFired: h.fired, hiddenInvokes: h.invokes };
      await page.close();
    }
    // 6) Mini window (mini.html) — only when this build has one (it lives on claude/rv-mini-window until merged).
    if (existsSync(join(built.dist, 'mini.html'))) {
      const { page, cdp } = await openEntry(browser, origin, { entry: '/mini.html', motion: 'no-preference', waitHome: false });
      await page.setViewport({ width: 320, height: 120 });
      await sleep(2000);
      const s = await snapshot(page, cdp);
      await page.evaluate(() => { window.__memProbe.fired = { interval: 0, timeout: 0, raf: 0 }; });
      await sleep(5000);
      const f = await page.evaluate(() => window.__memProbe.fired);
      result.mini = { ...s, timersFiredIn5s: f.interval + f.timeout + f.raf };
      await page.close();
    }
  } finally {
    await browser.close(); server.close(); built.cleanup(); rmSync(work, { recursive: true, force: true });
  }
  return result;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const r = await measureFrontend();
  const out = process.env.RV_MEMORY_REPORT || resolve(root, 'artifacts/memory-budget/frontend.json');
  await mkdir(resolve(out, '..'), { recursive: true });
  await writeFile(out, JSON.stringify(r, null, 2));
  console.log(JSON.stringify({ startup: r.startup, leak: { ...r.leak, samples: undefined }, hidden: r.hidden, motion: { rafVisible: r.motion.rafPerSecondVisible, rafHidden: r.motion.rafPerSecondHidden }, companion: r.companion, bundleJsKB: Math.round(r.bundle.js / 1024), largest: r.bundle.largestJs }, null, 1));
  console.log('pages:', Object.entries(r.pages).map(([k, v]) => `${k}:${v.heapUsedMB}MB/${v.nodes}n/${v.listeners}l`).join(' '));
  console.log('wrote', out);
}
