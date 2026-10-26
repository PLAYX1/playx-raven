// 창 모드(칩·대기화면·설정 「표시 방식」 칸) — 실제 Chrome 에서 빌드된 dist 를 Tauri 와 같은 CSP(style-src nonce)로.
// 가짜 Tauri: 노드·지갑·네트워크 없음, 자료는 합성. 확인:
//   칩 160×40: 라이트·다크 대비 4.5:1 · 넘침 0 · 가림 규칙 · 누르면 S 로 펼침 · 부른 명령은 mini_* 만
//   대기화면 768·1024·1440·1920: 대비 · 넘침 0 · 가림 · 판매자 규칙 · 아무 키/클릭 → standby_exit · 부른 명령은 standby_* 둘뿐
//     · 밤 시간 흐림(data-dim) · 번인 이동(--sx/--sy 가 범위 안) · style 속성 0 · CSP 위반 0
//   설정 칸: 모드 고르면 display_mode_set{mode}, 대기화면 단추 → standby_open, 실패하면 원래 모드로 되돌림
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync, mkdtempSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { resolve, join, extname, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import puppeteer from 'puppeteer-core';
import { installFixture } from './desktop-fixture.mjs';

const root = resolve(import.meta.dirname, '..');
const shots = join(root, 'artifacts/window-modes');
mkdirSync(shots, { recursive: true });
const work = mkdtempSync(join(tmpdir(), 'rv-modes-ui-'));
const dist = join(work, 'dist');
execFileSync(process.execPath, [resolve(root, 'node_modules/vite/bin/vite.js'), 'build', '--outDir', dist, '--emptyOutDir', '--logLevel', 'error'], { cwd: root, stdio: ['ignore', 'ignore', 'inherit'] });
assert.ok(existsSync(join(dist, 'standby.html')));

const NONCE = 'rvmodestest';
const conf = JSON.parse(readFileSync(join(root, 'src-tauri/tauri.conf.json'), 'utf8'));
const csp = Object.entries({ ...conf.app.security.csp, 'style-src': `${conf.app.security.csp['style-src']} 'nonce-${NONCE}'` }).map(([k, v]) => `${k} ${v}`).join('; ');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.png': 'image/png', '.webp': 'image/webp' };
const SECRET = /1,234|12\.5|250\.25|TICKET|88\.5|15\.5|0\.00000001/;

const SNAP = (masked, seller) => ({
  masked, locale: 'ko', status: 'ok', node: { state: 'ok', blocks: 3512345, peers: 8, behind: 0 },
  balance: { known: true, confirmed: masked ? null : '1,234.56789', pending: masked ? null : '12.5', has_pending: true },
  recent: [
    { dir: 'in', sale: seller, amount: masked ? null : '+12.5', unit: masked ? null : 'RVN', conf: 0, done: false, ago: 20 },
    { dir: 'in', sale: false, amount: masked ? null : '+3', unit: masked ? null : 'RV.T.TICKET_LONG_NAME', conf: 2, done: true, ago: 400 },
    { dir: 'out', sale: false, amount: masked ? null : '−250.25', unit: masked ? null : 'RVN', conf: 30, done: true, ago: 7200 },
  ],
  lock: 'locked', awake: { holding: seller, note: '' },
  seller: seller ? { sales: 4, sales_rvn: masked ? null : '88.5', deposits: 2, deposits_rvn: masked ? null : '15.5', pending: 1 } : null,
  unseen: 0, need: 1, watching: true, notice: null,
});

let server, origin, browser;
before(async () => {
  server = createServer((req, res) => {
    const path = resolve(dist, '.' + decodeURIComponent(new URL(req.url, 'http://x').pathname));
    const file = path === dist ? join(dist, 'index.html') : path;
    if ((file !== dist && !file.startsWith(dist + sep)) || !existsSync(file)) { res.writeHead(404); res.end(); return; }
    let body = readFileSync(file);
    const csp1 = extname(file) === '.html' && !file.endsWith('index.html');
    if (csp1) body = Buffer.from(String(body).replace(/<style>/g, `<style nonce="${NONCE}">`));
    res.writeHead(200, { 'Content-Type': TYPES[extname(file)] || 'application/octet-stream', ...(csp1 ? { 'Content-Security-Policy': csp } : {}) });
    res.end(body);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  origin = `http://127.0.0.1:${server.address().port}`;
  browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true, userDataDir: join(work, 'profile'), args: ['--no-first-run', '--disable-background-networking'] });
});
after(async () => { await browser?.close(); server?.close(); rmSync(work, { recursive: true, force: true }); });

function stub(initial) {
  window.__calls = [];
  const cbs = {}, listeners = {}; let n = 0; const state = JSON.parse(initial);
  window.__state = state;
  window.__emit = (event, payload) => (listeners[event] || []).forEach((id) => cbs[id]({ event, id, payload }));
  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
  window.__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label: state.label }, currentWebview: { windowLabel: state.label, label: state.label } },
    transformCallback(cb) { const id = ++n; cbs[id] = cb; return id; }, unregisterCallback(id) { delete cbs[id]; },
    async invoke(cmd, args) {
      window.__calls.push(cmd);
      if (cmd === 'plugin:event|listen') { (listeners[args.event] ||= []).push(args.handler); return args.handler; }
      if (cmd === 'plugin:window|start_dragging') return null;
      if (cmd === 'mini_state') return { settings: state.settings, snapshot: state.snapshot };
      if (cmd === 'mini_set') { Object.assign(state.settings, args.prefs); return { settings: state.settings }; }
      if (cmd === 'standby_state') return { snapshot: state.snapshot, settings: state.standby };
      if (cmd === 'standby_exit' || cmd === 'mini_seen' || cmd === 'mini_open_main' || cmd === 'mini_show') return null;
      throw new Error(`not allowed: ${cmd}`);
    },
  };
}

async function open(path, { w, h, dark, state }) {
  const page = await browser.newPage();
  const violations = [];
  page.on('console', (m) => { if (/Content Security Policy|Refused/.test(m.text())) violations.push(m.text()); });
  page.on('pageerror', (e) => violations.push(String(e)));
  await page.setViewport({ width: w, height: h, deviceScaleFactor: 1 });
  await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: dark ? 'dark' : 'light' }]);
  await page.evaluateOnNewDocument(stub, JSON.stringify(state));
  await page.goto(`${origin}/${path}`, { waitUntil: 'load' });
  return { page, violations };
}

function measure(scopeSel) {
  const parse = (c) => { const m = c.match(/rgba?\(([^)]+)\)/); if (!m) return null; const [r, g, b, a = 1] = m[1].split(/[ ,/]+/).filter(Boolean).map(Number); return { r, g, b, a }; };
  const lum = ({ r, g, b }) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
  const blend = (t, u) => ({ r: t.r * t.a + u.r * (1 - t.a), g: t.g * t.a + u.g * (1 - t.a), b: t.b * t.a + u.b * (1 - t.a), a: 1 });
  const bgOf = (el) => { const st = []; for (let e = el; e; e = e.parentElement) st.push(parse(getComputedStyle(e).backgroundColor)); let c = { r: 255, g: 255, b: 255, a: 1 }; for (const l of st.reverse()) if (l && l.a > 0) c = blend(l, c); return c; };
  const op = (el) => { let o = 1; for (let p = el; p; p = p.parentElement) o *= parseFloat(getComputedStyle(p).opacity); return o; };
  const vw = innerWidth, vh = innerHeight, bad = [], low = [];
  const scope = document.querySelector(scopeSel);
  for (const el of scope.querySelectorAll('*')) {
    const r = el.getBoundingClientRect(), cs = getComputedStyle(el);
    if (!(r.width > 0 && r.height > 0) || cs.display === 'none' || el.closest('[hidden]')) continue;
    if (r.right > vw + 0.5 || r.left < -0.5) bad.push(`가로 ${el.id || el.className}`);
    if (r.bottom > vh + 0.5) bad.push(`세로 ${el.id || el.className}`);
    if ([...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim())) {
      const fgRaw = parse(cs.color), bg = bgOf(el); const fg = blend({ ...fgRaw, a: fgRaw.a * op(el) }, bg);
      const L1 = lum(fg), L2 = lum(bg); const ratio = (Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05);
      if (ratio < 4.5) low.push(`${el.id || el.className}「${el.textContent.trim().slice(0, 14)}」 ${ratio.toFixed(2)}`);
    }
  }
  return { bad, low, docX: document.documentElement.scrollWidth - vw, styleAttrs: document.querySelectorAll('[style]').length, text: scope.innerText, calls: window.__calls };
}

const MINI_OK = new Set(['mini_state', 'mini_set', 'mini_show', 'mini_open_main', 'mini_seen', 'plugin:event|listen', 'plugin:window|start_dragging']);
const SB_OK = new Set(['standby_state', 'standby_exit', 'plugin:event|listen']);

for (const dark of [false, true]) for (const masked of [true, false]) {
  test(`칩 160×40 ${dark ? '다크' : '라이트'} ${masked ? '가림' : '보임'}`, async () => {
    const { page, violations } = await open('mini.html', { w: 160, h: 40, dark, state: { label: 'mini', snapshot: SNAP(masked, false), settings: { size: 'xs', on_top: true, mask: masked, capture_guard: true, sound: false, os_notify: true, need: 1, locale: 'ko', os_notify_supported: true } } });
    try {
      await page.waitForFunction(() => document.getElementById('headline').textContent !== '…');
      const m = await page.evaluate(measure, '#mini');
      assert.deepEqual(m.bad, []); assert.ok(m.docX <= 0); assert.deepEqual(m.low, []); assert.equal(m.styleAttrs, 0); assert.deepEqual(violations, []);
      const visible = await page.evaluate(() => [...document.querySelectorAll('#mini button')].filter((b) => b.getClientRects().length && getComputedStyle(b).display !== 'none').map((b) => b.id));
      assert.deepEqual(visible, ['headline'], '칩에는 단추가 잔액 하나뿐(누르면 펼침)');
      if (masked) assert.doesNotMatch(m.text, SECRET); else assert.match(m.text, /1,234/);
      await page.screenshot({ path: join(shots, `chip-${dark ? 'dark' : 'light'}-${masked ? 'masked' : 'open'}.png`) });
      await page.click('#headline');
      await page.waitForFunction(() => document.getElementById('mini').dataset.size === 's');
      assert.equal(await page.evaluate(() => window.__state.settings.size), 's', '칩을 누르면 mini_set{size:s}');
      for (const c of await page.evaluate(() => window.__calls)) assert.ok(MINI_OK.has(c), c);
    } finally { await page.close(); }
  });
}

for (const [w, h] of [[768, 432], [1024, 640], [1440, 900], [1920, 1080]]) for (const seller of [false, true]) for (const masked of [true, false]) {
  test(`대기화면 ${w}×${h} ${seller ? '판매자' : '일반'} ${masked ? '가림' : '보임'}`, async () => {
    const { page, violations } = await open('standby.html', { w, h, dark: true, state: { label: 'standby', snapshot: SNAP(masked, seller), standby: { dim_from: 22, dim_to: 7, shift: true, locale: 'ko' } } });
    try {
      await page.waitForFunction(() => document.getElementById('sb-clock').textContent !== '--:--' && document.getElementById('sb-node-text').textContent.includes('노드 정상'));
      await page.evaluate(() => Promise.allSettled(document.getAnimations().map((x) => x.finished)));
      const m = await page.evaluate(measure, '#sb');
      assert.deepEqual(m.bad, []); assert.ok(m.docX <= 0); assert.deepEqual(m.low, []); assert.equal(m.styleAttrs, 0); assert.deepEqual(violations, []);
      if (masked) assert.doesNotMatch(m.text, SECRET); else assert.match(m.text, /1,234\.56789 RVN/);
      assert.equal(await page.evaluate(() => !document.getElementById('sb-seller').hidden), seller, '판매 요약은 판매자 모드에서만');
      assert.doesNotMatch(m.text, /보내기|서명|복구 단어|비밀번호/, '대기화면에는 돈·열쇠 동작이 없다');
      assert.equal(await page.evaluate(() => document.querySelectorAll('button,input,textarea,select,a[href]').length), 0, '누를 것·적을 칸 0');
      const shift = await page.evaluate(() => document.getElementById('sb-stage').dataset.shift.split(',').map(Number));
      assert.ok(shift.every((v) => Math.abs(v) <= 24), `번인 이동 범위 ${shift}`);
      const dim = await page.evaluate(() => document.getElementById('sb').dataset.dim);
      const hour = new Date().getHours();
      assert.equal(dim, String(hour >= 22 || hour < 7));
      if (w === 1440) await page.screenshot({ path: join(shots, `standby-${w}-${seller ? 'seller' : 'plain'}-${masked ? 'masked' : 'open'}.png`) });
      await page.keyboard.press('a');
      await page.waitForFunction(() => window.__calls.includes('standby_exit'));
      for (const c of await page.evaluate(() => window.__calls)) assert.ok(SB_OK.has(c), `허용 밖 명령: ${c}`);
    } finally { await page.close(); }
  });
}

test('대기화면: 클릭으로도 돌아가고, 마우스 움직임으로는 안 닫힌다 · 영어', async () => {
  const { page } = await open('standby.html', { w: 1024, h: 640, dark: true, state: { label: 'standby', snapshot: { ...SNAP(true, false), locale: 'en' }, standby: { dim_from: 0, dim_to: 0, shift: false, locale: 'en' } } });
  try {
    await page.waitForFunction(() => document.getElementById('sb-hint').textContent.includes('any key'));
    await page.mouse.move(100, 100); await page.mouse.move(400, 300);
    assert.equal(await page.evaluate(() => window.__calls.includes('standby_exit')), false);
    assert.equal(await page.evaluate(() => document.getElementById('sb').dataset.dim), 'false', '흐림 끔(from==to)');
    await page.mouse.click(500, 300);
    await page.waitForFunction(() => window.__calls.includes('standby_exit'));
  } finally { await page.close(); }
});

test('설정 「표시 방식」 칸: 고르면 display_mode_set, 대기화면 단추, 실패면 되돌림', async () => {
  const page = await browser.newPage();
  await page.setViewport({ width: 1024, height: 900 });
  await page.evaluateOnNewDocument(installFixture, { theme: 'light', sales: true, seller: false });
  await page.evaluateOnNewDocument(() => {
    localStorage.setItem('rv-v2-backup-reminded', '1');
    window.__dm = [];
    const real = window.__TAURI_INTERNALS__.invoke;
    let s = { mode: 'window', hide_dock: true, tray_text: 'alerts', dim_from: 22, dim_to: 7, shift: true, locale: 'ko' };
    const sup = { dock: true, tray_text: true, tray: true, tray_click_menu: true, os: 'macos' };
    window.__TAURI_INTERNALS__.invoke = async (cmd, args) => {
      if (cmd === 'display_mode_get') return { settings: s, supports: sup };
      if (cmd === 'display_mode_set') { window.__dm.push(args.prefs); if (args.prefs.mode === 'menubar' && window.__failMenubar) throw '이 컴퓨터에서는 트레이를 쓸 수 없어 큰 창만 쓸 수 있어요.'; s = { ...s, ...args.prefs }; return { settings: s, supports: sup }; }
      if (cmd === 'standby_open') { window.__dm.push('standby'); return null; }
      return real(cmd, args);
    };
  });
  await page.goto(origin + '/', { waitUntil: 'networkidle0' });
  try {
    await page.waitForFunction(() => document.getElementById('display-mode-card'));
    await page.evaluate(() => document.querySelectorAll('section.page').forEach((p) => p.classList.toggle('on', p.id === 'page-settings')));
    assert.equal(await page.$eval('#dm-mode-window', (i) => i.checked), true);
    await page.$eval('#display-mode-card', (c) => c.scrollIntoView());
    await page.click('label[for="dm-mode-chip"]');
    await page.waitForFunction(() => window.__dm.some((p) => p.mode === 'chip'));
    assert.match(await page.$eval('#dm-note', (n) => n.textContent), /칩/);
    await page.click('#dm-standby');
    await page.waitForFunction(() => window.__dm.includes('standby'));
    await page.evaluate(() => { window.__failMenubar = true; });
    await page.click('label[for="dm-mode-menubar"]');
    await page.waitForFunction(() => /트레이/.test(document.getElementById('dm-note').textContent));
    assert.equal(await page.$eval('#dm-mode-chip', (i) => i.checked), true, '실패하면 실제 모드(칩)로 되돌린다');
    // 키보드: 라디오는 화살표로 옮겨 다닌다
    await page.focus('#dm-mode-chip');
    await page.keyboard.press('ArrowLeft');
    await page.waitForFunction(() => window.__dm.some((p) => p.mode === 'mini'));
    assert.deepEqual(await page.evaluate(() => window.__homeFixture.forbidden), []);
    await page.screenshot({ path: join(shots, 'settings-card-1024-light.png'), clip: await page.$eval('#display-mode-card', (c) => { const r = c.getBoundingClientRect(); return { x: r.x, y: r.y + scrollY, width: r.width, height: r.height }; }) });
  } finally { await page.close(); }
});
