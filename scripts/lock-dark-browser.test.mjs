// 잠금(대기화면 진입 즉시)·매장용 읽기 전용·다크 돈 카드·복구 단어 민감 화면 — 실제 Chrome, 빌드된 dist.
// 가짜 Tauri: 노드·지갑·네트워크 없음, 자료는 합성(주소·단어·암호는 가짜). Rust 문지기는 cargo test 가 잰다.
// 여기서는 화면 쪽을 잰다:
//   ① 잠긴 큰 창: 덮개가 뜨고 나머지는 inert · 금액은 가림 · 보내기 단추를 눌러도 아무 명령도 안 나간다
//      · 가짜 IPC 가 Rust 허용 목록(app_lock.rs LOCKED_ALLOWED)을 흉내 내 「잠긴 동안 허용 밖 명령 0」을 확인
//      · 틀린 암호 → 오류·칸 비움, 맞는 암호 → 풀림(inert 해제)
//   ② 대기화면 → 아무 키 → standby_exit → 큰 창은 「잠금 바뀜」 이벤트로 잠긴 화면(인증 없이 복귀, 지갑은 잠김)
//   ③ 매장용 읽기 전용: 설정 단추 → app_lock_now{store} → 금액이 와도 •••• · 잠금 풀기 칸은 「관리자」 뒤
//   ④ 다크 돈 카드(지갑 잔액·보내기 검토·복구 단어): 흰 섬 아님 · 글자 4.5:1 · 경계·입력 3:1 · 라이트는 흰 카드 그대로
//   ⑤ 복구 단어: 재인증 전 단어 없음 · 민감 화면 표시 · 캡처 보호 켬 · 복사 막음 · 자동 가림(시계 당김)
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
const shots = join(root, 'artifacts/lock-dark');
mkdirSync(shots, { recursive: true });
const work = mkdtempSync(join(tmpdir(), 'rv-lockdark-ui-'));
const dist = join(work, 'dist');
execFileSync(process.execPath, [resolve(root, 'node_modules/vite/bin/vite.js'), 'build', '--outDir', dist, '--emptyOutDir', '--logLevel', 'error'], { cwd: root, stdio: ['ignore', 'ignore', 'inherit'] });

// Rust 허용 목록을 소스에서 그대로 읽는다(가짜 IPC 가 같은 목록으로 거절한다).
const lockSrc = readFileSync(join(root, 'src-tauri/src/app_lock.rs'), 'utf8');
const listSrc = lockSrc.slice(lockSrc.indexOf('pub const LOCKED_ALLOWED'), lockSrc.indexOf('];', lockSrc.indexOf('pub const LOCKED_ALLOWED')));
const ALLOWED = [...listSrc.matchAll(/"([a-z_0-9]+)"/g)].map((m) => m[1]);
assert.ok(ALLOWED.length > 50 && ALLOWED.includes('app_unlock') && !ALLOWED.includes('send_rvn'), `허용 목록 읽기 ${ALLOWED.length}`);

const NONCE = 'rvlocktest';
const conf = JSON.parse(readFileSync(join(root, 'src-tauri/tauri.conf.json'), 'utf8'));
const csp = Object.entries({ ...conf.app.security.csp, 'style-src': `${conf.app.security.csp['style-src']} 'nonce-${NONCE}'` }).map(([k, v]) => `${k} ${v}`).join('; ');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.png': 'image/png', '.webp': 'image/webp' };
const SECRET = /1,234|12\.5|88\.5|TICKET/;
const SNAP = (masked) => ({
  masked, locale: 'ko', status: 'ok', node: { state: 'ok', blocks: 3512345, peers: 8, behind: 0 },
  balance: { known: true, confirmed: masked ? null : '1,234.56789', pending: masked ? null : '12.5', has_pending: true },
  recent: [
    { dir: 'in', sale: true, amount: masked ? null : '+88.5', unit: masked ? null : 'RVN', conf: 0, done: false, ago: 20 },
    { dir: 'in', sale: false, amount: masked ? null : '+3', unit: masked ? null : 'RV.T.TICKET', conf: 2, done: true, ago: 400 },
  ],
  lock: 'locked', awake: { holding: false, note: '' }, seller: null, unseen: 0, need: 1,
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

/** 가짜 Rust: 잠금 상태 + 허용 목록 문지기 + 이벤트. 인자는 남기지 않는다(암호가 기록에 남지 않게). */
function lockStub({ allowed, locked, reason, snap, encrypted = true, backupPass = true, fastHide = false }) {
  if (fastHide) {
    // 복구 단어 자동 가림(180초)을 0.4초로 당긴다 — 다른 타이머는 그대로.
    const real = window.setTimeout.bind(window);
    window.setTimeout = (fn, ms, ...a) => real(fn, ms === 180000 ? 400 : ms, ...a);
  }
  const T = window.__TAURI_INTERNALS__;
  const base = T.invoke;
  // 잠금 상태는 「Rust 쪽」이라 새로고침에도 남는다(window.name 으로 흉내 — 픽스처가 저장소를 비운다).
  let saved = null; try { saved = JSON.parse(window.name || 'null'); } catch { /* 처음 */ }
  const lock = new Proxy(saved?.rvLock || { locked, reason }, { set(t, k, v) { t[k] = v; window.name = JSON.stringify({ rvLock: t }); return true; } });
  window.name = JSON.stringify({ rvLock: { ...lock } });
  const listeners = {};
  window.__lock = { calls: [], denied: [], protect: [], lock };
  window.__emit = (event, payload) => (listeners[event] || []).forEach((h) => T.runCallback(h, { event, id: h, payload }));
  T.invoke = async (cmd, args) => {
    window.__lock.calls.push(cmd);
    if (cmd === 'plugin:event|listen') { (listeners[args.event] ||= []).push(args.handler); return args.handler; }
    if (cmd === 'plugin:window|set_content_protected') { window.__lock.protect.push(args?.protected ?? args?.value); return null; }
    if (cmd.startsWith('plugin:')) return base(cmd, args);
    // Rust lib.rs 문지기와 같은 판단: 잠겼으면 허용 목록만.
    if (lock.locked && !allowed.includes(cmd)) { window.__lock.denied.push(cmd); throw '지갑이 잠겨 있어요. 잠금을 푼 뒤 다시 해 주세요.'; }
    if (cmd === 'app_lock_state') return { locked: lock.locked, reason: lock.locked ? lock.reason : null, since: 1, wallet_encrypted: encrypted, backup_pass: backupPass };
    if (cmd === 'app_lock_now') { lock.locked = true; lock.reason = args.reason; return { locked: true, reason: args.reason }; }
    if (cmd === 'app_unlock') {
      if (encrypted && args.passphrase !== 'synthetic-correct-pass') throw '암호가 맞지 않습니다.';
      lock.locked = false; lock.reason = null; return { locked: false };
    }
    if (cmd === 'mini_state') return { settings: { mask: snap.masked }, snapshot: snap };
    if (cmd === 'standby_open') { lock.locked = true; lock.reason = 'standby'; return null; }
    if (cmd === 'wallet_lock_state') return { encrypted: true, unlocked: false };
    if (cmd === 'reveal_seed') {
      if (args.passphrase !== 'synthetic-correct-pass') throw '암호가 맞지 않습니다.';
      return { words: 'zulu yankee xray whiskey victor uniform tango sierra romeo quebec papa oscar'.split(' '), count: 12, has_extra_passphrase: false };
    }
    return base(cmd, args);
  };
}

async function openMain({ dark, w = 1280, h = 860, stub }) {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.setViewport({ width: w, height: h, deviceScaleFactor: 1 });
  await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: dark ? 'dark' : 'light' }]);
  await page.evaluateOnNewDocument(installFixture, { theme: dark ? 'dark' : 'light', sales: true, seller: false });
  await page.evaluateOnNewDocument(() => { localStorage.setItem('rv-v2-backup-reminded', '1'); });
  await page.evaluateOnNewDocument(lockStub, { allowed: ALLOWED, ...stub });
  await page.goto(origin + '/', { waitUntil: 'networkidle0' });
  return { page, errors };
}

/** 글자 대비(4.5:1, 굵은 큰 글자 3:1) + 경계 대비(지정한 요소의 테두리 vs 바깥 배경 3:1). */
function contrast(scopeSels, edgeSels = []) {
  const parse = (c) => { const m = c.match(/rgba?\(([^)]+)\)/); if (!m) return null; const [r, g, b, a = 1] = m[1].split(/[ ,/]+/).filter(Boolean).map(Number); return { r, g, b, a }; };
  const lum = ({ r, g, b }) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
  const blend = (t, u) => ({ r: t.r * t.a + u.r * (1 - t.a), g: t.g * t.a + u.g * (1 - t.a), b: t.b * t.a + u.b * (1 - t.a), a: 1 });
  const bgOf = (el) => { const st = []; for (let e = el; e; e = e.parentElement) st.push(parse(getComputedStyle(e).backgroundColor)); let c = { r: 255, g: 255, b: 255, a: 1 }; for (const l of st.reverse()) if (l && l.a > 0) c = blend(l, c); return c; };
  const ratio = (a, b) => { const L1 = lum(a), L2 = lum(b); return (Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05); };
  const low = [], edges = [], surfaces = {};
  for (const sel of scopeSels) {
    const scope = document.querySelector(sel);
    if (!scope) { low.push(`${sel} 없음`); continue; }
    surfaces[sel] = +lum(bgOf(scope)).toFixed(3);
    for (const el of [scope, ...scope.querySelectorAll('*')]) {
      const r = el.getBoundingClientRect(), cs = getComputedStyle(el);
      if (!(r.width > 0 && r.height > 0) || cs.display === 'none' || cs.visibility === 'hidden' || el.closest('[hidden]')) continue;
      if (![...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim())) continue;
      const fg0 = parse(cs.color), bg = bgOf(el); const fg = blend(fg0, bg);
      const big = parseFloat(cs.fontSize) >= 24 || (parseFloat(cs.fontSize) >= 18.66 && Number(cs.fontWeight) >= 700);
      const k = ratio(fg, bg);
      if (k < (big ? 3 : 4.5)) low.push(`${sel} ${el.id || el.className}「${el.textContent.trim().slice(0, 16)}」 ${k.toFixed(2)}`);
    }
  }
  for (const sel of edgeSels) {
    const el = document.querySelector(sel);
    if (!el || !el.getClientRects().length) { edges.push(`${sel} 없음`); continue; }
    const cs = getComputedStyle(el);
    const border = parse(cs.borderTopColor);
    const outside = bgOf(el.parentElement);
    const k = ratio(blend(border, outside), outside);
    if (k < 3) edges.push(`${sel} 경계 ${k.toFixed(2)}`);
  }
  return { low, edges, surfaces };
}

for (const dark of [false, true]) {
  test(`① 잠긴 큰 창 ${dark ? '다크' : '라이트'}: 덮개·inert·가림·허용 밖 명령 0·틀린/맞는 암호`, async () => {
    const { page, errors } = await openMain({ dark, stub: { locked: true, reason: 'standby', snap: SNAP(true) } });
    try {
      await page.waitForFunction(() => { const r = document.getElementById('app-lock'); return r && !r.hidden; });
      await page.waitForFunction(() => document.getElementById('rv-lock-node').textContent.length > 0);
      const s = await page.evaluate(() => ({
        title: document.getElementById('rv-lock-title').textContent,
        text: document.getElementById('app-lock').innerText,
        inert: [...document.body.children].filter((n) => n.id !== 'app-lock' && n.tagName !== 'SCRIPT').every((n) => n.hasAttribute('inert')),
        modal: document.getElementById('app-lock').getAttribute('aria-modal'),
        focus: document.activeElement?.id,
        buttons: [...document.querySelectorAll('#app-lock button')].filter((b) => !b.hidden && b.getClientRects().length).map((b) => b.textContent),
      }));
      assert.equal(s.title, '지갑이 잠겨 있어요');
      assert.ok(s.inert, '덮개 밖은 전부 inert');
      assert.equal(s.modal, 'true');
      assert.equal(s.focus, 'rv-lock-pass', '암호 칸에 초점');
      assert.doesNotMatch(s.text, SECRET, '가림 켬이면 금액이 없다');
      assert.match(s.text, /읽기 전용/);
      assert.ok(!s.buttons.some((b) => /보내기|서명|복구 단어/.test(b)), `덮개 단추: ${s.buttons}`);
      // 덮개 밑 「보내기」 단추를 눌러도(좌표 클릭) 아무 일도 안 일어난다.
      const before = await page.evaluate(() => window.__lock.calls.length);
      const box = await page.evaluate(() => { const r = document.getElementById('w-send-rvn').getBoundingClientRect(); return { x: r.x + 5, y: r.y + 5 }; });
      await page.mouse.click(Math.max(1, box.x), Math.max(1, box.y));
      await page.evaluate(() => document.getElementById('w-send-rvn').click()); // inert 여도 스크립트 클릭은 간다 — 그래도 Rust 가 거절
      const after1 = await page.evaluate(() => window.__lock.calls.slice());
      assert.deepEqual(after1.slice(before).filter((c) => /^send_|unlock_for|reveal|preview_send/.test(c)), [], '덮개 밑 보내기 단추는 아무 명령도 안 낸다');
      // 인증 없이 서명·보내기·복구 단어 IPC 를 직접 불러도 거절(가짜 문지기 = Rust 허용 목록과 같은 목록).
      const direct = await page.evaluate(async () => {
        const out = [];
        for (const c of ['send_rvn', 'sign_message', 'wallet_send_signed', 'reveal_seed', 'unlock_for', 'backup_zip', 'cloud_key_show', 'sales_account_reveal']) {
          try { await window.__TAURI_INTERNALS__.invoke(c, {}); out.push(`${c}:통과`); } catch (e) { out.push(`${c}:${String(e).includes('잠겨') ? '거절' : e}`); }
        }
        return out;
      });
      assert.ok(direct.every((d) => d.endsWith(':거절')), direct.join(' '));
      // 큰 창이 잠긴 동안 저절로 부른 명령 중 허용 목록 밖(=Rust 가 거절할 것) — 직접 부른 8개를 빼면 화면 흐름은 그대로 돌아야 한다.
      const auto = await page.evaluate(() => window.__lock.denied.filter((c) => !['send_rvn', 'sign_message', 'wallet_send_signed', 'reveal_seed', 'unlock_for', 'backup_zip', 'cloud_key_show', 'sales_account_reveal'].includes(c)));
      assert.ok(!auto.some((c) => /^send_|sign|reveal|unlock_for/.test(c)), `잠긴 동안 저절로 돈 명령: ${auto}`);
      if (!dark) console.log(`# 잠긴 동안 큰 창이 저절로 불렀다가 거절된 명령(화면 뒤 갱신): ${[...new Set(auto)].join(' ') || '없음'}`);
      // 대비
      const k = await page.evaluate(contrast, ['#app-lock'], ['#rv-lock-pass', '.rv-lock-feed', '.rv-lock-ico']);
      assert.deepEqual(k.low, []); assert.deepEqual(k.edges, []);
      await page.screenshot({ path: join(shots, `locked-${dark ? 'dark' : 'light'}.png`) });
      // 틀린 암호
      await page.type('#rv-lock-pass', 'synthetic-wrong-pass');
      await page.click('#rv-lock-go');
      await page.waitForFunction(() => document.getElementById('rv-lock-err').textContent.length > 0);
      assert.equal(await page.$eval('#rv-lock-err', (n) => n.textContent), '암호가 맞지 않습니다.');
      assert.equal(await page.$eval('#rv-lock-pass', (n) => n.value), '', '틀려도 칸은 비운다');
      assert.equal(await page.$eval('#app-lock', (n) => n.hidden), false);
      // 맞는 암호
      await page.type('#rv-lock-pass', 'synthetic-correct-pass');
      await page.keyboard.press('Enter');
      // 잠긴 채 켜진 창은 풀린 뒤 한 번 다시 불러 첫 준비를 정상으로 돌린다.
      await page.waitForNavigation({ waitUntil: 'networkidle0' });
      await page.waitForFunction(() => document.getElementById('app-lock')?.hidden === true);
      assert.equal(await page.evaluate(() => [...document.body.children].some((n) => n.hasAttribute('inert') && n.id !== 'app-lock' && !n.matches('[inert-keep]'))), false, '풀리면 inert 해제');
      assert.equal(await page.evaluate(() => document.documentElement.hasAttribute('data-app-locked')), false);
      assert.deepEqual(errors, []);
    } finally { await page.close(); }
  });
}

test('② 대기화면 → 아무 키 → standby_exit, 큰 창은 잠긴 채(인증 없이 복귀) · 대기화면은 standby_* 만', async () => {
  // 대기화면 창
  const sb = await browser.newPage();
  await sb.setViewport({ width: 1024, height: 640 });
  await sb.evaluateOnNewDocument((snap) => {
    window.__calls = []; const cbs = {}; let n = 0;
    window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
    window.__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: 'standby' }, currentWebview: { windowLabel: 'standby', label: 'standby' } },
      transformCallback(cb) { const id = ++n; cbs[id] = cb; return id; }, unregisterCallback(id) { delete cbs[id]; },
      async invoke(cmd) {
        window.__calls.push(cmd);
        if (cmd === 'plugin:event|listen') return 1;
        if (cmd === 'standby_state') return { snapshot: snap, settings: { dim_from: 0, dim_to: 0, shift: false, locale: 'ko' } };
        if (cmd === 'standby_exit') return null;
        throw new Error(`not allowed: ${cmd}`);
      },
    };
  }, SNAP(true));
  await sb.goto(origin + '/standby.html', { waitUntil: 'load' });
  await sb.waitForFunction(() => document.getElementById('sb-node-text').textContent.includes('노드'));
  await sb.keyboard.press('Space');
  await sb.waitForFunction(() => window.__calls.includes('standby_exit'));
  assert.deepEqual([...new Set(await sb.evaluate(() => window.__calls))].sort(), ['plugin:event|listen', 'standby_exit', 'standby_state']);
  await sb.close();
  // 큰 창: 처음엔 열림 → (Rust 가 대기화면 진입 때 잠그고 이벤트) → 잠긴 화면. 복귀 때 암호를 묻지 않고 그 화면이 그대로 있다.
  const { page } = await openMain({ dark: true, stub: { locked: false, reason: null, snap: SNAP(true) } });
  try {
    await page.waitForFunction(() => document.getElementById('app-lock'));
    assert.equal(await page.$eval('#app-lock', (n) => n.hidden), true);
    await page.evaluate(() => { window.__lock.lock.locked = true; window.__lock.lock.reason = 'standby'; window.__emit('app-lock-changed', { locked: true, reason: 'standby' }); });
    await page.waitForFunction(() => !document.getElementById('app-lock').hidden);
    assert.equal(await page.$eval('#rv-lock-title', (n) => n.textContent), '지갑이 잠겨 있어요');
    // 읽기 전용 입금 표시가 이벤트로 흐른다(가림 한 장).
    await page.evaluate((snap) => window.__emit('app-lock-snapshot', snap), SNAP(true));
    assert.match(await page.$eval('#rv-lock-recent', (n) => n.textContent), /판매/);
    // 다시 대기화면 켜기 단추 → standby_open(허용 목록 안)
    await page.click('#rv-lock-standby');
    await page.waitForFunction(() => window.__lock.calls.includes('standby_open'));
    // 시간이 지나도 저절로 안 풀린다(화면에 시계가 없다 — 30초 흉내 뒤에도 잠김)
    await page.evaluate(() => new Promise((r) => setTimeout(r, 300)));
    assert.equal(await page.$eval('#app-lock', (n) => n.hidden), false);
    assert.equal(await page.evaluate(() => window.__lock.calls.includes('app_unlock')), false, '복귀는 인증 없이 — 풀기 시도도 없다');
  } finally { await page.close(); }
});

test('③ 매장용 읽기 전용: 설정 단추 → app_lock_now{store} · 금액이 와도 •••• · 잠금 풀기는 관리자 뒤', async () => {
  const { page } = await openMain({ dark: false, stub: { locked: false, reason: null, snap: SNAP(false) } });
  try {
    await page.waitForFunction(() => document.getElementById('dm-store'));
    await page.evaluate(() => document.getElementById('dm-store').click());
    await page.waitForFunction(() => !document.getElementById('app-lock').hidden);
    assert.ok(await page.evaluate(() => window.__lock.calls.includes('app_lock_now')));
    const s = await page.evaluate(() => ({
      title: document.getElementById('rv-lock-title').textContent,
      text: document.getElementById('app-lock').innerText,
      formHidden: document.getElementById('rv-lock-form').hidden,
      admin: !document.getElementById('rv-lock-admin').hidden,
    }));
    assert.equal(s.title, '매장용 읽기 전용');
    assert.doesNotMatch(s.text, SECRET, '가림이 꺼져 있어도 매장 모드는 금액·자산 이름을 가린다');
    assert.doesNotMatch(s.text, /R[1-9A-HJ-NP-Za-km-z]{25,}|[0-9a-f]{64}/, '주소·txid 없음');
    assert.ok(s.formHidden && s.admin, '암호 칸은 관리자 단추 뒤');
    await page.screenshot({ path: join(shots, 'store-light.png') });
    await page.click('#rv-lock-admin');
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'rv-lock-pass');
    await page.type('#rv-lock-pass', 'synthetic-correct-pass');
    await page.click('#rv-lock-go');
    await page.waitForFunction(() => document.getElementById('app-lock').hidden);
  } finally { await page.close(); }
});

for (const dark of [true, false]) {
  test(`④ 돈 카드 ${dark ? '다크(흰색 강제 폐지)' : '라이트(흰 카드 유지)'}: 지갑 잔액·보내기 검토 대비`, async () => {
    const { page } = await openMain({ dark, stub: { locked: false, reason: null, snap: SNAP(true) } });
    try {
      await page.evaluate(() => {
        document.querySelectorAll('section.page').forEach((p) => p.classList.toggle('on', p.id === 'page-wallet'));
        document.getElementById('send-review').style.display = '';
        for (const [id, v] of [['r-who', '합성 받는 분'], ['r-addr', 'RSyntheticPublicFixtureAddrXXXXXXX'], ['r-what', 'RVN'], ['r-amount', '1.5 RVN'], ['r-fee', '0.01 RVN'], ['r-total', '1.51 RVN']]) document.getElementById(id).textContent = v;
        document.getElementById('r-passbox').style.display = '';
      });
      await page.evaluate(() => Promise.allSettled(document.getAnimations().map((a) => a.finished)));
      const k = await page.evaluate(contrast, ['#w-balance', '#send-review'], dark ? ['#w-balance', '#send-review', '#s-pass'] : []);
      assert.deepEqual(k.low, []);
      assert.deepEqual(k.edges, []);
      for (const [sel, L] of Object.entries(k.surfaces)) {
        if (dark) assert.ok(L < 0.05, `${sel} 다크인데 밝은 표면(휘도 ${L})`);
        else assert.equal(L, 1, `${sel} 라이트는 흰 카드 그대로(휘도 ${L})`);
      }
      // 「보내기 검토」·통화·주소·수수료·상태를 글자로
      const txt = await page.$eval('#send-review', (n) => n.innerText);
      for (const w of ['보내기 전 확인', '누구에게', '수수료', '합계', 'RVN', '아직 보내지 않았어요']) assert.ok(txt.includes(w), w);
      await page.screenshot({ path: join(shots, `money-${dark ? 'dark' : 'light'}.png`), fullPage: false });
    } finally { await page.close(); }
  });
}

for (const dark of [true, false]) {
  test(`⑤ 복구 단어 민감 화면 ${dark ? '다크' : '라이트'}: 재인증 전 단어 없음 · 캡처 보호 · 복사 막음 · 자동 가림`, async () => {
    const { page, errors } = await openMain({ dark, stub: { locked: false, reason: null, snap: SNAP(true), fastHide: true } });
    try {
      await page.evaluate(() => document.getElementById('bk-seed').click());
      await page.waitForFunction(() => document.getElementById('sdw-pass'));
      assert.deepEqual(await page.evaluate(() => window.__lock.protect), [true], '단어가 뜨기 전에 캡처 보호 켬');
      assert.doesNotMatch(await page.$eval('#sdw', (n) => n.innerText), /zulu|yankee/, '암호 전에는 단어가 없다');
      await page.type('#sdw-pass', 'synthetic-correct-pass');
      await page.click('#sdw-show');
      await page.waitForFunction(() => document.querySelector('.sdw-words'));
      const s = await page.evaluate(() => ({
        text: document.getElementById('sdw').innerText,
        sel: getComputedStyle(document.querySelector('.sdw-words')).userSelect,
        timer: document.getElementById('sdw-timer').textContent,
      }));
      assert.match(s.text, /민감한 화면/);
      assert.match(s.text, /zulu/);
      assert.equal(s.sel, 'none', '단어는 고를 수 없다');
      assert.match(s.timer, /초 뒤에 단어를 저절로 가려요/);
      const k = await page.evaluate(contrast, ['#sdw .sheet-box'], dark ? ['#sdw .sheet-box'] : []);
      assert.deepEqual(k.low, []); assert.deepEqual(k.edges, []);
      if (dark) assert.ok(Object.values(k.surfaces)[0] < 0.05, '다크 민감 화면은 어둡다');
      await page.screenshot({ path: join(shots, `seed-${dark ? 'dark' : 'light'}.png`) });
      // 복사 시도 → 막힘 + 주의 문구
      const blocked = await page.evaluate(() => {
        const ev = new ClipboardEvent('copy', { bubbles: true, cancelable: true, clipboardData: new DataTransfer() });
        document.querySelector('.seedword').dispatchEvent(ev);
        return { prevented: ev.defaultPrevented, warn: document.getElementById('sdw-copywarn').textContent };
      });
      assert.ok(blocked.prevented, '복사 막음');
      assert.match(blocked.warn, /복사하지 마세요/);
      // 자동 가림(시계 당김 0.4초) → 단어 사라지고 다시 암호 단계
      await page.waitForFunction(() => document.getElementById('sdw-pass') && !document.querySelector('.sdw-words'), { timeout: 5000 });
      assert.doesNotMatch(await page.$eval('#sdw', (n) => n.innerText), /zulu|yankee/);
      assert.match(await page.$eval('#sdw', (n) => n.innerText), /시간이 지나 단어를 가렸어요/);
      // 닫으면 캡처 보호 끔(기존 동작 유지)
      await page.click('#sdw-close');
      assert.deepEqual(await page.evaluate(() => window.__lock.protect), [true, false]);
      assert.deepEqual(errors, []);
    } finally { await page.close(); }
  });
}
