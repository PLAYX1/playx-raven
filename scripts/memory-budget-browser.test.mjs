// Memory budget for the desktop frontend (real headless Chrome, production dist, synthetic data).
// Fails when a screen, window or timer goes over scripts/memory-budget.json:
//   main window heap / DOM nodes / listeners / decoded images, 100-navigation leak trend,
//   hidden-window activity (no animation frames, no drawing IPC, no DOM-walking loop),
//   companion window, mini window (when the build has mini.html), bundle sizes.
// Writes the full measurement to artifacts/memory-budget/frontend.json (or $RV_MEMORY_REPORT).
// See docs/memory-budget.md for why each number is what it is.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { measureFrontend } from './measure-memory.mjs';
import { root } from './memory-budget-lib.mjs';

const B = JSON.parse(readFileSync(resolve(root, 'scripts/memory-budget.json'), 'utf8'));
let r;

test('frontend memory budget (scripts/memory-budget.json)', { timeout: 900_000 }, async t => {
  r = await measureFrontend({ navRounds: B.leak.navigations, hiddenSeconds: B.hidden.seconds });
  const out = process.env.RV_MEMORY_REPORT || resolve(root, 'artifacts/memory-budget/frontend.json');
  await mkdir(resolve(out, '..'), { recursive: true });
  await writeFile(out, JSON.stringify(r, null, 2));

  await t.test('synthetic fixture only: no forbidden command was sent', () => {
    assert.deepEqual(r.forbiddenCommands, []);
  });

  await t.test('every main-window screen stays within heap / DOM / listener / image budget', () => {
    const over = [];
    for (const [id, s] of Object.entries({ startup: r.startup, ...r.pages })) {
      if (s.heapUsedMB > B.mainWindow.heapUsedMB) over.push(`${id} heap ${s.heapUsedMB}MB > ${B.mainWindow.heapUsedMB}`);
      if (s.nodes > B.mainWindow.domNodes) over.push(`${id} DOM ${s.nodes} > ${B.mainWindow.domNodes}`);
      if (s.listeners > B.mainWindow.listeners) over.push(`${id} listeners ${s.listeners} > ${B.mainWindow.listeners}`);
      if (s.imageDecodedMB > B.mainWindow.decodedImageMB) over.push(`${id} images ${s.imageDecodedMB}MB > ${B.mainWindow.decodedImageMB}`);
    }
    assert.deepEqual(over, []);
  });

  await t.test(`no leak across ${B.leak.navigations} screen changes`, () => {
    const L = r.leak;
    assert.ok(L.heapSlopeKBPerNav <= B.leak.heapSlopeKBPerNav, `heap grows ${L.heapSlopeKBPerNav}KB per navigation`);
    assert.ok(L.nodeSlopePerNav <= B.leak.nodeSlopePerNav, `DOM grows ${L.nodeSlopePerNav} nodes per navigation`);
    assert.ok(L.listenerSlopePerNav <= B.leak.listenerSlopePerNav, `listeners grow ${L.listenerSlopePerNav} per navigation`);
    assert.ok(L.heapGrowthMB <= B.leak.heapGrowthMB, `heap grew ${L.heapGrowthMB}MB after warm-up`);
    assert.ok(L.intervalsAlive <= B.leak.intervalsAlive, `${L.intervalsAlive} setInterval timers alive (screens must clear theirs)`);
  });

  await t.test('hidden window: no animation frames, no drawing IPC, no DOM-walking loop', () => {
    const H = r.hidden;
    assert.equal(H.fired.raf, B.hidden.raf, `${H.fired.raf} animation frames ran while hidden`);
    const timeoutsPerMinute = H.fired.timeout * 60 / H.seconds;
    assert.ok(timeoutsPerMinute <= B.hidden.timeoutsPerMinute, `${Math.round(timeoutsPerMinute)} setTimeout callbacks/min while hidden (a re-render loop?)`);
    assert.ok(H.invokesPerMinute <= B.hidden.invokesPerMinute, `${H.invokesPerMinute} IPC calls/min while hidden`);
    const drawing = Object.keys(H.invokesByCommand).filter(c => !B.hidden.allowedInvokes.includes(c));
    assert.deepEqual(drawing, [], `drawing-only IPC while hidden: ${drawing.join(', ')}`);
    assert.equal(r.motion.rafPerSecondHidden, 0, 'Ravi animation keeps running while hidden');
  });

  await t.test('Ravi animation does not get more expensive', () => {
    assert.ok(r.rafPerSecondHomeReduced <= B.motion.rafPerSecondHomeReduced, `${r.rafPerSecondHomeReduced} frames/s on home with reduced motion`);
  });

  await t.test('companion window stays small and fully idle when hidden', () => {
    const C = r.companion;
    assert.ok(C.heapUsedMB <= B.companion.heapUsedMB, `companion heap ${C.heapUsedMB}MB`);
    assert.ok(C.nodes <= B.companion.domNodes, `companion DOM ${C.nodes}`);
    assert.ok(C.listeners <= B.companion.listeners, `companion listeners ${C.listeners}`);
    assert.equal(C.hiddenFired.raf, B.companion.hiddenRaf);
    assert.equal(C.hiddenInvokes, B.companion.hiddenInvokes);
  });

  await t.test('mini window (when built) stays tiny and timer-free', { skip: !r.mini && 'this build has no mini.html' }, () => {
    const M = r.mini;
    assert.ok(M.heapUsedMB <= B.mini.heapUsedMB, `mini heap ${M.heapUsedMB}MB`);
    assert.ok(M.nodes <= B.mini.domNodes, `mini DOM ${M.nodes}`);
    assert.ok(M.listeners <= B.mini.listeners, `mini listeners ${M.listeners}`);
    assert.equal(M.timersFiredIn5s, B.mini.timersFiredIn5s, 'mini window should be event-driven (no polling timers)');
  });

  await t.test('bundle size budget', () => {
    const b = r.bundle, kb = n => Math.round(n / 1024);
    assert.ok(kb(b.js) <= B.bundle.jsTotalKB, `JS total ${kb(b.js)}KB`);
    assert.ok(kb(b.largestJs.size) <= B.bundle.largestJsKB, `largest chunk ${b.largestJs.file} ${kb(b.largestJs.size)}KB`);
    assert.ok(kb(b.files['index.html']) <= B.bundle.indexHtmlKB, `index.html ${kb(b.files['index.html'])}KB`);
    assert.ok(kb(b.css) <= B.bundle.cssTotalKB, `CSS total ${kb(b.css)}KB`);
  });
});
