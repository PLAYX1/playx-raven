// 미니 창 — 실제 Chrome(puppeteer-core)에서 **빌드된 dist/mini.html**(vite) 을 Tauri 와 같은 CSP(style-src nonce)로 띄운다.
// Tauri 는 가짜(__TAURI_INTERNALS__): 노드·지갑·네트워크 없음. 자료는 전부 합성.
// 확인: 크기 3단계 × 실제 창 크기(220×60·300×140·360×260) + 390 폭 × 라이트·다크
//   · 가로 넘침 0 · 세로 잘림 0 · 글자 대비 4.5:1 이상 · style 속성 0 · CSP 위반 0
//   · 가림 켬이면 금액·자산 이름 글자가 화면에 없음 / 끄면 보임
//   · 판매자 모드 꺼짐 → 판매 요약 없음 / 켬 → 보임
//   · 합성 입금 알림 주입 → 띠 표시(S 는 머리줄 강조) · 두 번 누르면 크기 순환
//   · 창이 부른 명령은 mini_* 다섯 + 이벤트 듣기 + 창 끌기뿐
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync, mkdtempSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, join, extname } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import puppeteer from 'puppeteer-core';

const root = resolve(import.meta.dirname, '..');
const shots = join(root, 'artifacts/claude-mini');
mkdirSync(shots, { recursive: true });
const work = mkdtempSync(join(tmpdir(), 'rv-mini-ui-'));
const dist = join(work, 'dist');
execFileSync(join(root, 'node_modules/.bin/vite'), ['build', '--outDir', dist, '--emptyOutDir', '--logLevel', 'error'], { cwd: root, stdio: 'inherit' });
assert.ok(existsSync(join(dist, 'mini.html')));

const NONCE = 'rvminitest';
const conf = JSON.parse(readFileSync(join(root, 'src-tauri/tauri.conf.json'), 'utf8'));
const cspObj = { ...conf.app.security.csp, 'style-src': `${conf.app.security.csp['style-src']} 'nonce-${NONCE}'` };
const csp = Object.entries(cspObj).map(([k, v]) => `${k} ${v}`).join('; ');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' };

const SNAP = (masked, seller, extra = {}) => ({
  masked, locale: 'ko', status: 'ok',
  node: { state: 'ok', blocks: 3512345, peers: 8, behind: 0 },
  balance: { known: true, confirmed: masked ? null : '1,234.56789', pending: masked ? null : '12.5', has_pending: true },
  recent: [
    { dir: 'in', sale: seller, amount: masked ? null : '+12.5', unit: masked ? null : 'RVN', conf: 0, done: false, ago: 20 },
    { dir: 'in', sale: false, amount: masked ? null : '+3', unit: masked ? null : 'RV.T.TICKET_LONG_NAME', conf: 2, done: true, ago: 400 },
    { dir: 'out', sale: false, amount: masked ? null : '−250.25', unit: masked ? null : 'RVN', conf: 30, done: true, ago: 7200 },
    { dir: 'in', sale: false, amount: masked ? null : '+0.00000001', unit: masked ? null : 'RVN', conf: 90, done: true, ago: 90000 },
  ],
  lock: 'locked', awake: { holding: seller, note: '' },
  seller: seller ? { sales: 4, sales_rvn: masked ? null : '88.5', deposits: 2, deposits_rvn: masked ? null : '15.5', pending: 1 } : null,
  unseen: 0, need: 1, watching: true, notice: null, ...extra,
});
const SECRET_TEXT = /1,234|12\.5|250\.25|TICKET|88\.5|15\.5|0\.00000001/;

let server, origin, browser;
before(async () => {
  server = createServer((req, res) => {
    const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    const file = join(dist, path === '/' ? 'mini.html' : path);
    if (!file.startsWith(dist) || !existsSync(file)) { res.writeHead(404); res.end(); return; }
    let body = readFileSync(file);
    if (extname(file) === '.html') body = Buffer.from(String(body).replace(/<style>/g, `<style nonce="${NONCE}">`));
    res.writeHead(200, { 'Content-Type': TYPES[extname(file)] || 'application/octet-stream', 'Content-Security-Policy': csp });
    res.end(body);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  origin = `http://127.0.0.1:${server.address().port}`;
  browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: true, userDataDir: join(work, 'profile'), args: ['--no-first-run', '--disable-background-networking'] });
});
after(async () => { await browser?.close(); server?.close(); });

/** 가짜 Tauri. 창이 부른 명령을 모두 적고, 이벤트를 밀어 넣을 수 있다. */
function stub(initial) {
  window.__calls = [];
  const cbs = {}, listeners = {};
  let n = 0;
  const state = JSON.parse(initial);
  window.__state = state;
  window.__emit = (event, payload) => (listeners[event] || []).forEach((id) => cbs[id]({ event, id, payload }));
  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
  window.__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label: 'mini' }, currentWebview: { windowLabel: 'mini', label: 'mini' } },
    transformCallback(cb) { const id = ++n; cbs[id] = cb; return id; },
    unregisterCallback(id) { delete cbs[id]; },
    async invoke(cmd, args) {
      window.__calls.push(cmd);
      switch (cmd) {
        case 'plugin:event|listen': (listeners[args.event] ||= []).push(args.handler); return args.handler;
        case 'plugin:window|start_dragging': return null;
        case 'mini_state': return { settings: state.settings, snapshot: state.snapshots[state.settings.mask ? 'masked' : 'open'] };
        case 'mini_set': {
          const p = args.prefs; const s = state.settings;
          for (const k of ['size', 'on_top', 'mask', 'sound', 'os_notify']) if (k in p) s[k] = p[k];
          if ('mask' in p) setTimeout(() => window.__emit('mini-snapshot', state.snapshots[s.mask ? 'masked' : 'open']), 0);
          return { settings: s };
        }
        case 'mini_seen': case 'mini_open_main': case 'mini_show': return null;
        default: throw new Error(`not allowed: ${cmd}`);
      }
    },
  };
}

const ALLOWED = new Set(['mini_state', 'mini_set', 'mini_show', 'mini_open_main', 'mini_seen', 'plugin:event|listen', 'plugin:window|start_dragging']);

async function open({ size, w, h, dark, masked = true, seller = false }) {
  const page = await browser.newPage();
  const violations = [];
  page.on('console', (m) => { if (/Content Security Policy|Refused/.test(m.text())) violations.push(m.text()); });
  page.on('pageerror', (e) => violations.push(String(e)));
  await page.setViewport({ width: w, height: h, deviceScaleFactor: 2 });
  await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: dark ? 'dark' : 'light' }]);
  const initial = JSON.stringify({
    settings: { size, on_top: true, mask: masked, capture_guard: true, sound: false, os_notify: true, need: 1, locale: 'ko', os_notify_supported: true },
    snapshots: { masked: SNAP(true, seller), open: SNAP(false, seller) },
  });
  await page.evaluateOnNewDocument(stub, initial);
  await page.goto(`${origin}/mini.html`, { waitUntil: 'load' });
  await page.waitForFunction(() => document.getElementById('headline').textContent !== '…');
  return { page, violations };
}

/** 화면 측정: 넘침·잘림·대비·style 속성. */
async function measure(page) {
  return page.evaluate(() => {
    const parse = (c) => { const m = c.match(/rgba?\(([^)]+)\)/); if (!m) return null; const [r, g, b, a = 1] = m[1].split(/[ ,/]+/).filter(Boolean).map(Number); return { r, g, b, a }; };
    const lum = ({ r, g, b }) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
    const blend = (top, under) => ({ r: top.r * top.a + under.r * (1 - top.a), g: top.g * top.a + under.g * (1 - top.a), b: top.b * top.a + under.b * (1 - top.a), a: 1 });
    const bgOf = (el) => {
      const stack = []; for (let e = el; e; e = e.parentElement) stack.push(parse(getComputedStyle(e).backgroundColor));
      let c = { r: 255, g: 255, b: 255, a: 1 };
      for (const layer of stack.reverse()) if (layer && layer.a > 0) c = blend(layer, c);
      return c;
    };
    const vw = innerWidth, vh = innerHeight;
    const visible = (el) => { const r = el.getBoundingClientRect(); const cs = getComputedStyle(el); return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none'; };
    const bad = [], low = [];
    for (const el of document.querySelectorAll('#mini *')) {
      if (!visible(el)) continue;
      const r = el.getBoundingClientRect();
      if (r.right > vw + 0.5 || r.left < -0.5) bad.push(`가로 ${el.id || el.className} ${r.left.toFixed(1)}~${r.right.toFixed(1)}/${vw}`);
      if (r.bottom > vh + 0.5) bad.push(`세로 ${el.id || el.className} ${r.bottom.toFixed(1)}/${vh}`);
      const own = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
      if (own) {
        const fg = parse(getComputedStyle(el).color), bg = bgOf(el);
        const L1 = lum(blend(fg, bg)), L2 = lum(bg);
        const ratio = (Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05);
        if (ratio < 4.5) low.push(`${el.id || el.className}「${el.textContent.trim().slice(0, 16)}」 ${ratio.toFixed(2)}`);
      }
    }
    const mini = document.getElementById('mini');
    return {
      bad, low,
      docOverflowX: document.documentElement.scrollWidth - vw,
      miniOverflowX: mini.scrollWidth - mini.clientWidth,
      styleAttrs: document.querySelectorAll('[style]').length,
      text: mini.innerText,
      sellerVisible: visible(document.getElementById('seller')),
      noticeVisible: visible(document.getElementById('notice')),
      hasNotice: document.body.classList.contains('has-notice'),
      calls: window.__calls,
    };
  });
}

const CASES = [
  { size: 's', w: 220, h: 60 },
  { size: 'm', w: 300, h: 140 },
  { size: 'l', w: 360, h: 260 },
  { size: 'l', w: 390, h: 260 },
];

for (const c of CASES) {
  for (const dark of [false, true]) {
    for (const seller of [false, true]) {
      for (const masked of [true, false]) {
        const name = `${c.size}-${c.w}x${c.h}-${dark ? 'dark' : 'light'}-${seller ? 'seller' : 'plain'}-${masked ? 'masked' : 'open'}`;
        test(name, async () => {
          const { page, violations } = await open({ ...c, dark, seller, masked });
          try {
            const m = await measure(page);
            assert.deepEqual(m.bad, [], `넘침/잘림: ${m.bad.join(' | ')}`);
            assert.ok(m.docOverflowX <= 0 && m.miniOverflowX <= 0, `가로 스크롤 ${m.docOverflowX}/${m.miniOverflowX}`);
            assert.deepEqual(m.low, [], `대비 부족: ${m.low.join(' | ')}`);
            assert.equal(m.styleAttrs, 0, 'style 속성은 Tauri CSP 에서 무시된다');
            assert.deepEqual(violations, []);
            if (masked) assert.doesNotMatch(m.text, SECRET_TEXT, '가림 켬인데 금액/자산 이름이 보인다');
            else if (c.size !== 's') assert.match(m.text, /1,234\.56789 RVN/);
            if (c.size === 'l') assert.equal(m.sellerVisible, seller, '판매 요약은 판매자 모드에서만');
            else assert.equal(m.sellerVisible, false);
            if (seller && c.size === 'l' && !masked) assert.match(m.text, /판매 4건 · 88\.5 RVN/);
            for (const call of m.calls) assert.ok(ALLOWED.has(call), `허용 밖 명령: ${call}`);
            await page.screenshot({ path: join(shots, `${name}.png`) });
          } finally { await page.close(); }
        });
      }
    }
  }
}

test('합성 입금 알림 주입 → 띠 표시, 누르면 본 것으로(mini_seen)', async () => {
  for (const [size, w, h] of [['m', 300, 140], ['l', 360, 260], ['s', 220, 60]]) {
    for (const dark of [false, true]) {
      const { page, violations } = await open({ size, w, h, dark });
      try {
        await page.evaluate(() => {
          window.__emit('mini-snapshot', { ...window.__state.snapshots.masked, unseen: 1 });
          window.__emit('mini-notice', { kind: 'deposit_seen', count: 1, title: '입금 감지', body: '입금이 있어요.' });
        });
        await page.waitForFunction(() => document.body.classList.contains('has-notice'));
        const m = await measure(page);
        assert.deepEqual(m.bad, []);
        assert.deepEqual(m.low, [], `대비 부족(알림): ${m.low.join(' | ')}`);
        assert.doesNotMatch(m.text, SECRET_TEXT);
        if (size === 's') { assert.equal(m.noticeVisible, false); assert.match(m.text, /새 소식 1/); }
        else { assert.equal(m.noticeVisible, true); assert.match(m.text, /입금 감지/); }
        await page.screenshot({ path: join(shots, `notice-${size}-${dark ? 'dark' : 'light'}.png`) });
        if (size !== 's') {
          await page.click('#notice');
          assert.ok((await page.evaluate(() => window.__calls)).includes('mini_seen'));
          assert.equal(await page.evaluate(() => document.getElementById('notice').hidden), true);
        }
        assert.deepEqual(violations, []);
      } finally { await page.close(); }
    }
  }
});

test('가림 단추 → 금액 보임, 다시 → 숨김 / 잔액 글자 눌러도 같다', async () => {
  const { page } = await open({ size: 'm', w: 300, h: 140, dark: false });
  try {
    assert.doesNotMatch((await measure(page)).text, SECRET_TEXT);
    await page.click('#mask');
    await page.waitForFunction(() => document.getElementById('headline').textContent.includes('1,234'));
    await page.click('#headline');
    await page.waitForFunction(() => document.getElementById('headline').textContent === '••••');
    assert.doesNotMatch((await measure(page)).text, SECRET_TEXT);
  } finally { await page.close(); }
});

test('두 번 누르면 크기 순환(S→M→L→S), 크기 단추도 같다', async () => {
  const { page } = await open({ size: 's', w: 220, h: 60, dark: true });
  try {
    const size = () => page.evaluate(() => document.getElementById('mini').dataset.size);
    const dot = await page.evaluate(() => { const r = document.getElementById('dot').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
    await page.mouse.click(dot.x, dot.y, { clickCount: 1 });
    await page.mouse.click(dot.x, dot.y, { clickCount: 2 }); // 단추가 아닌 자리(상태 점)
    await page.waitForFunction(() => document.getElementById('mini').dataset.size === 'm');
    assert.ok((await page.evaluate(() => window.__calls)).includes('plugin:window|start_dragging'), '한 번 누름은 끌기');
    await page.evaluate(() => { window.__calls.length = 0; });
    const before = await size();
    await page.click('#size');
    await page.waitForFunction((b) => document.getElementById('mini').dataset.size !== b, {}, before);
    assert.equal(await size(), { s: 'm', m: 'l', l: 's' }[before]);
  } finally { await page.close(); }
});
