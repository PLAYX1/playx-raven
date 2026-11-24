// 0.9.46 흐름 시험(영구) — 실제 dist 를 가짜 IPC(desktop-fixture)로 띄워 **진짜로 눌러** 본다.
//   A) confirm()/alert() → 앱 안 확인 창 sure() 로 바꾼 곳: 누르면 창이 뜨고, 「취소」면 IPC 가 안 불리고, 「예」면 불린다.
//   B) 게임 페이지 「다른 판매자 게임 함께 보관하기 (돕기)」 카드 → 「모든 게임」 저장 = arcade_share_set {mode:'all'}.
//   C) 첫 화면 라비 한 줄(#v2-ravi-say)을 누르면 대화칸이 열리고 글자를 칠 수 있다(대표 신고, 0.9.45).
// 노드·지갑·네트워크 없음. 보내기·잠금 해제 계열은 desktop-fixture 가 거절한다.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve, join, extname, sep } from 'node:path';
import { tmpdir } from 'node:os';
import puppeteer from 'puppeteer-core';
import { installFixture } from './desktop-fixture.mjs';

const root = resolve(process.env.RV_FLOWS_ROOT || resolve(import.meta.dirname, '..'));
let work, dist, browser, server, origin;

before(async () => {
  work = mkdtempSync(join(tmpdir(), 'rv-flows-0946-'));
  dist = join(work, 'dist');
  execFileSync(process.execPath, [resolve(root, 'node_modules/vite/bin/vite.js'), 'build', '--outDir', dist, '--emptyOutDir', '--logLevel', 'error'], { cwd: root, stdio: ['ignore', 'ignore', 'inherit'] });
  const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.webp': 'image/webp', '.jpg': 'image/jpeg', '.json': 'application/json', '.wasm': 'application/wasm' };
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 앱을 띄운다. extra = {명령: 응답} 덧붙이기(그 밖은 desktop-fixture), start = rv-ravi-start-off 값(none=지움). 모든 IPC 이름·인자는 window.__args 에. */
async function openApp({ seller = false, sales = false, extra = {}, start, width = 1280, height = 900 } = {}) {
  const page = await browser.newPage();
  await page.setViewport({ width, height });
  await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
  await page.setRequestInterception(true);
  page.on('request', (r) => ((new URL(r.url()).origin === origin && r.method() === 'GET') ? r.continue() : r.abort()));
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e?.message || e)));
  page.on('dialog', async (d) => { errors.push(`native dialog: ${d.type()} ${d.message()}`); await d.dismiss(); });
  await page.evaluateOnNewDocument(installFixture, { theme: 'light', sales, seller });
  await page.evaluateOnNewDocument((extraJson, startMode) => {
    localStorage.setItem('rv-v2-backup-reminded', '1');
    if (startMode === 'none') localStorage.removeItem('rv-ravi-start-off');
    else if (startMode) localStorage.setItem('rv-ravi-start-off', startMode);
    const extra = JSON.parse(extraJson);
    const log = window.__args = [];
    const real = window.__TAURI_INTERNALS__.invoke;
    window.__TAURI_INTERNALS__.invoke = async (cmd, args) => {
      if (!String(cmd).startsWith('plugin:')) log.push({ cmd, args: args ? JSON.parse(JSON.stringify(args)) : null });
      if (Object.hasOwn(extra, cmd)) return structuredClone(extra[cmd]);
      return real(cmd, args);
    };
  }, JSON.stringify(extra), start ?? null);
  await page.goto(origin + '/', { waitUntil: 'networkidle0' });
  await page.waitForFunction(() => document.querySelector('#page-home.on'), { timeout: 20000 });
  page.errors = errors;
  return page;
}

const called = (page, cmd) => page.evaluate((c) => window.__args.filter((x) => x.cmd === c), cmd);
const askOpen = (page) => page.evaluate(() => {
  const w = document.getElementById('askwrap');
  return w.classList.contains('on') && !!w.getClientRects().length && getComputedStyle(w).display !== 'none' ? document.getElementById('ask-title').textContent : null;
});
async function waitAsk(page) {
  await page.waitForFunction(() => document.getElementById('askwrap').classList.contains('on'), { timeout: 5000 });
  return askOpen(page);
}

/* ── C) 라비 한 줄 ──────────────────────────────────────────────── */
async function raviSayTypes(page) {
  await page.click('#v2-ravi-say');
  await page.waitForFunction(() => !document.getElementById('ravi-panel').hidden && document.activeElement?.id === 'chat-q', { timeout: 6000 })
    .catch(() => {});
  const st = await page.evaluate(() => ({
    hidden: document.getElementById('ravi-panel').hidden,
    shown: !!document.getElementById('ravi-panel').getClientRects().length,
    focus: document.activeElement?.id || document.activeElement?.tagName,
    arriving: document.documentElement.hasAttribute('data-ravi-arriving'),
  }));
  await page.keyboard.type('안녕 라비');
  st.value = await page.$eval('#chat-q', (e) => e.value);
  return st;
}

for (const [label, start] of [['(1) 인사 설정 없음(0.9.46 기본)', 'none'], ['(2) 인사 켬 rv-ravi-start-off=0(0.9.45 기존 사용자)', '0'], ['(2b) 인사 끔 =1', '1']]) {
  test(`C 라비 한 줄 → 대화칸 열림·입력 ${label}`, { timeout: 60000 }, async () => {
    const page = await openApp({ start });
    // 인사가 있으면 끝날 때까지 기다린다(사람이 인사를 다 본 뒤 누르는 경우).
    await page.waitForFunction(() => !document.documentElement.hasAttribute('data-ravi-arriving'), { timeout: 20000 }).catch(() => {});
    await sleep(300);
    const st = await raviSayTypes(page);
    await page.close();
    assert.equal(st.hidden, false, `#ravi-panel 이 열려야 한다 ${JSON.stringify(st)}`);
    assert.equal(st.shown, true, `#ravi-panel 이 보여야 한다 ${JSON.stringify(st)}`);
    assert.equal(st.focus, 'chat-q', `#chat-q 에 포커스 ${JSON.stringify(st)}`);
    assert.equal(st.value, '안녕 라비', `글자가 들어가야 한다 ${JSON.stringify(st)}`);
  });
}

test('C 라비 한 줄 → 인사(짜잔!) 진행 중에 눌러도 인사가 끝나면 대화칸이 열리고 입력된다 (3)', { timeout: 60000 }, async () => {
  const page = await openApp({ start: '0' });
  const during = await page.evaluate(() => document.documentElement.hasAttribute('data-ravi-arriving') || !!document.querySelector('.ravi-arrival'));
  // 인사 덮개 밖을 누르면 인사는 비킨다(11-14) — 그 누름이 라비 한 줄이면 대화칸이 열려야 한다.
  await page.evaluate(() => document.getElementById('v2-ravi-say').scrollIntoView());
  await page.click('#v2-ravi-say');
  await page.waitForFunction(() => !document.documentElement.hasAttribute('data-ravi-arriving'), { timeout: 20000 }).catch(() => {});
  await page.waitForFunction(() => document.activeElement?.id === 'chat-q', { timeout: 8000 }).catch(() => {});
  const st = await page.evaluate(() => ({ during: null, hidden: document.getElementById('ravi-panel').hidden, shown: !!document.getElementById('ravi-panel').getClientRects().length, focus: document.activeElement?.id || document.activeElement?.tagName, arriving: document.documentElement.hasAttribute('data-ravi-arriving') }));
  st.during = during;
  await page.keyboard.type('안녕 라비');
  st.value = await page.$eval('#chat-q', (e) => e.value);
  await page.close();
  assert.equal(st.shown, true, `#ravi-panel 이 보여야 한다 ${JSON.stringify(st)}`);
  assert.equal(st.focus, 'chat-q', `#chat-q 포커스 ${JSON.stringify(st)}`);
  assert.equal(st.value, '안녕 라비', `글자 입력 ${JSON.stringify(st)}`);
});

// 0.9.45 의 원인: 창을 가리거나 90초 쉬면 「잠시 쉬고 있어요」(ravi-lifecycle) 가 덮고, 돌아온 직후(650ms)의 누름을 삼켰다.
// 돌아오자마자 라비 한 줄을 누르면 대화칸이 열리지 않았다. 0.9.46 은 자동 쉬기 꺼짐 + 삼키기 제거 — 첫 누름이 바로 먹어야 한다.
test('C 라비 한 줄 → 창을 가렸다 돌아온 직후 첫 누름도 대화칸을 연다 (4, 0.9.45 재현 경로)', { timeout: 60000 }, async () => {
  const page = await openApp({});
  await sleep(800);
  const hide = (on) => page.evaluate((on) => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => on });
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (on ? 'hidden' : 'visible') });
    document.dispatchEvent(new Event('visibilitychange'));
  }, on);
  await hide(true); await sleep(300); await hide(false);
  await page.mouse.move(400, 300);
  await page.click('#v2-ravi-say');
  await page.waitForFunction(() => document.activeElement?.id === 'chat-q', { timeout: 4000 }).catch(() => {});
  const st = await page.evaluate(() => ({ rest: !!document.querySelector('.ravi-lifecycle[open]'), shown: !!document.getElementById('ravi-panel').getClientRects().length, focus: document.activeElement?.id || document.activeElement?.tagName }));
  await page.keyboard.type('abc'); st.value = await page.$eval('#chat-q', (e) => e.value);
  await page.close();
  assert.deepEqual(st, { rest: false, shown: true, focus: 'chat-q', value: 'abc' });
});

/* ── A) confirm()/alert() → 앱 안 확인 창 ──────────────────────────── */
async function go(page, name) {
  await page.evaluate((n) => document.querySelector(`[data-page="${n}"]`)?.click(), name);
  await page.waitForFunction((n) => document.getElementById(`page-${n}`)?.classList.contains('on'), { timeout: 8000 }, name);
  await sleep(300);
}
async function pane(page, p) {
  await page.evaluate((p) => document.querySelector(`#page-settings .sx-it[data-sx-go="${p}"]`)?.click(), p);
  await sleep(300);
}
/** 보이면 진짜 마우스로, 안 보이면(펼친 칸 밖) 그 요소의 click() 으로 누른다. 어느 쪽이었는지 돌려준다. */
async function press(page, selector) {
  await page.waitForSelector(selector, { timeout: 8000 });
  // 눈에 보이고 그 자리 맨 위가 그 단추일 때만 마우스로 — 아니면 같은 손잡이를 click() 으로.
  const visible = await page.$eval(selector, (e) => {
    e.scrollIntoView({ block: 'center' });
    const r = e.getBoundingClientRect();
    if (!(r.width > 0 && r.height > 0) || getComputedStyle(e).visibility === 'hidden') return false;
    const top = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
    return !!top && (top === e || e.contains(top) || top.contains(e) && top.tagName === 'LABEL');
  });
  if (visible) await page.click(selector); else await page.$eval(selector, (e) => e.click());
  return visible ? 'mouse' : 'el.click';
}
/** 누름 → 앱 안 창 → 「취소」면 cmd 0번 → 다시 누름 → 「예」면 cmd 1번. native confirm 은 0번이어야 한다. */
async function confirmFlow(page, selector, cmd, { before } = {}) {
  if (before) await before();
  const how = await press(page, selector);
  const title = await waitAsk(page);
  assert.ok(title, `${selector}: 앱 안 확인 창이 떠야 한다`);
  await page.click('#ask-no');
  await sleep(400);
  assert.equal((await called(page, cmd)).length, 0, `${selector}: 「취소」인데 ${cmd} 가 불렸다`);
  assert.equal(await askOpen(page), null, '취소하면 창이 닫혀야 한다');
  if (before) await before();
  await press(page, selector);
  await waitAsk(page);
  await page.click('#ask-yes');
  await page.waitForFunction((c) => window.__args.some((x) => x.cmd === c), { timeout: 5000 }, cmd).catch(() => {});
  const calls = await called(page, cmd);
  assert.equal(calls.length, 1, `${selector}: 「예」면 ${cmd} 가 한 번 불려야 한다`);
  assert.deepEqual(page.errors.filter((e) => e.startsWith('native dialog')), [], 'window.confirm/alert 이 뜨면 안 된다');
  return { title, how, args: calls[0].args };
}

const MEMBER = { valid: true, asset: 'HOMEFIT/M1', name: '김회원', phone: '01000000000', kind: 'month', expires: '20271231', visits_total: 10, note: '', memos: [{ at: 1791500000, text: '첫 메모' }], extra: {} };

const A_CASES = [
  ['USB 잠금 끄기', { extra: { usb_lock_read: { lock: true }, usb_lock_set: { lock: false } } }, async (page) => {
    await go(page, 'settings'); await pane(page, 'backup');
    return confirmFlow(page, '#bk-usblock', 'usb_lock_set', { before: () => page.$eval('#bk-usblock', (b) => { if (!b.checked) { b.checked = true; } }) });
  }],
  ['재색인 지금 시작', { extra: { reindex_state: { armed: false, running: false, done: false }, reindex_window: { kind: 'always_open' }, reindex_start: null } }, async (page) => {
    await go(page, 'parts');
    await page.waitForSelector('#rx-now', { timeout: 10000 });
    return confirmFlow(page, '#rx-now', 'reindex_start');
  }],
  ['연습 지우기', { extra: { rehearse_reset: null } }, async (page) => {
    await go(page, 'settings'); await pane(page, 'advanced');
    return confirmFlow(page, '#rh-reset', 'rehearse_reset');
  }],
  ['AI 열쇠 지우기(이 컴퓨터 › AI 열쇠)', { extra: { delete_api_key: null } }, async (page) => {
    await go(page, 'settings'); await pane(page, 'advanced');
    await page.waitForSelector('#keyrows [data-delkey]', { timeout: 10000 });
    return confirmFlow(page, '#keyrows [data-delkey]', 'delete_api_key');
  }],
  ['AI 열쇠 지우기(라비 화면)', { extra: { delete_api_key: null } }, async (page) => {
    await go(page, 'ravi');
    return confirmFlow(page, '#ravi-key-delete', 'delete_api_key');
  }],
  ['지도에서 내리기', { sales: true, seller: true, extra: { map_status: { registered: true, closed: false, beat_ok_at: 0 }, map_unpublish: null } }, async (page) => {
    await go(page, 'shop');
    await page.waitForFunction(() => !document.getElementById('mp-down').hidden, { timeout: 10000 });
    return confirmFlow(page, '#mp-down', 'map_unpublish');
  }],
  ['테일스케일 문 닫기', { sales: true, seller: true, extra: { tailscale_funnel_off: null } }, async (page) => {
    await go(page, 'shop');
    // 테일스케일 고정 주소 상태를 만들기 어렵다(가게 링크·터널 판정) — 단추만 드러내고 같은 손잡이를 누른다.
    await page.$eval('#mp-ts-off', (b) => { b.hidden = false; });
    return confirmFlow(page, '#mp-ts-off', 'tailscale_funnel_off');
  }],
  ['폰 연결 끊기', { extra: { wallet_link_list: { pending: [], links: [{ linkId: 'L1', name: '내 폰', phoneAddresses: [], dailySats: '0', spentToday: '0', created: 1791500000, revoked: false }], sells: [] }, wallet_link_inbox: { pending: [], links: [{ linkId: 'L1', name: '내 폰', phoneAddresses: [], dailySats: '0', spentToday: '0', created: 1791500000, revoked: false }], sells: [], online: true, offer: null }, wallet_link_revoke: null } }, async (page) => {
    await go(page, 'settings'); await pane(page, 'identity');
    const sel = '#wl-list button.ghost:last-of-type';
    await page.waitForFunction(() => [...document.querySelectorAll('#wl-list button')].some((b) => b.textContent.trim() === '끊기'), { timeout: 10000 });
    await page.evaluate(() => { [...document.querySelectorAll('#wl-list button')].find((b) => b.textContent.trim() === '끊기').id = 'test-cut'; });
    return confirmFlow(page, '#test-cut', 'wallet_link_revoke');
  }],
  ['회원 지우기', { sales: true, seller: true, extra: { list_members: { members: [MEMBER] }, member_groups_get: [], remove_member: null } }, async (page) => {
    await go(page, 'shop'); await press(page, '[data-goto="door"]'); await press(page, '#dr-all');
    await page.waitForSelector('[data-edit="HOMEFIT/M1"]', { timeout: 10000 });
    await press(page, '[data-edit="HOMEFIT/M1"]');
    await page.waitForFunction(() => !document.getElementById('msheet').classList.contains('hidden') && document.getElementById('ms-delete').style.display !== 'none', { timeout: 8000 });
    return confirmFlow(page, '#ms-delete', 'remove_member');
  }],
  ['메모 지우기', { sales: true, seller: true, extra: { list_members: { members: [MEMBER] }, member_groups_get: [], member_memo_delete: { memos: [] } } }, async (page) => {
    await go(page, 'shop'); await press(page, '[data-goto="door"]'); await press(page, '#dr-all');
    await page.waitForSelector('[data-edit="HOMEFIT/M1"]', { timeout: 10000 });
    await press(page, '[data-edit="HOMEFIT/M1"]');
    await page.waitForFunction(() => document.querySelector('#ms-memo-list button'), { timeout: 8000 });
    await page.evaluate(() => { document.querySelector('#ms-memo-list button').id = 'test-memo-del'; });
    return confirmFlow(page, '#test-memo-del', 'member_memo_delete');
  }],
];

for (const [name, opts, run] of A_CASES) {
  test(`A 앱 안 확인 창 — ${name}`, { timeout: 60000 }, async () => {
    const page = await openApp(opts);
    try {
      const r = await run(page);
      console.log(`  A ${name}: 창 「${r.title}」 · 누름=${r.how} · 인자=${JSON.stringify(r.args)}`);
    } finally { await page.close(); }
  });
}

test('A 메뉴 전부 지우기(라비 menu_clear) — 도달 경로 확인', () => {
  // applyActions 를 부르는 곳은 send_prepare 한 곳뿐이다 — menu_clear 는 지금 화면에서 닿을 길이 없다(죽은 갈래).
  const src = readFileSync(join(root, 'src/main.ts'), 'utf8');
  const calls = [...src.matchAll(/applyActions\(\[\{ type: "([a-z_]+)"/g)].map((m) => m[1]);
  const total = (src.match(/applyActions\(/g) || []).length - 1; // 정의 한 줄 빼기
  assert.deepEqual({ total, calls }, { total: 1, calls: ['send_prepare'] }, 'menu_clear 로 가는 호출이 생겼다면 이 시험에 실제 누르기를 더할 것');
  assert.ok(!/confirm\(\s*tf?\("메뉴/.test(src), 'menu_clear 는 window.confirm 을 쓰지 않는다');
});

/* ── B) 게임 페이지 「다른 판매자 게임 함께 보관하기 (돕기)」 ─────────────── */
test('B 게임 페이지 돕기 카드 → 「모든 게임」 저장 = arcade_share_set {mode:"all", budgetMb}', { timeout: 60000 }, async () => {
  const share = { mode: 'off', picks: [], budgetMb: 512, choicesMb: [256, 512, 1024] };
  const page = await openApp({ seller: true, extra: { arcade_share_get: share, arcade_share_set: { ...share, mode: 'all', budgetMb: 1024 } } });
  try {
    await go(page, 'games');
    await page.waitForFunction(() => document.querySelector('#page-games #ar-share-box .ar-keep'), { timeout: 10000 });
    const title = await page.$eval('#ar-share-box .ar-keep > b', (b) => b.textContent.trim());
    assert.equal(title, '다른 판매자 게임 함께 보관하기 (돕기)');
    assert.equal(await page.$eval('#ar-share-box input[value="off"]', (r) => r.checked), true, '기본은 「안 하기」');
    assert.equal((await called(page, 'arcade_share_set')).length, 0, '켜기 전엔 설정을 바꾸지 않는다');
    await press(page, '#ar-share-box input[name="as-mode"][value="all"]');
    await page.select('#ar-share-box [data-as-budget]', '1024');
    await press(page, '#ar-share-box [data-as-save]');
    await page.waitForFunction(() => window.__args.some((x) => x.cmd === 'arcade_share_set'), { timeout: 5000 });
    const [set] = await called(page, 'arcade_share_set');
    assert.equal(set.args.mode, 'all');
    assert.equal(set.args.budgetMb, 1024);
    // 저장 뒤 다시 그린 카드가 「모든 게임」을 고른 채로 「지금 한 바퀴」를 보인다.
    await page.waitForFunction(() => document.querySelector('#ar-share-box input[value="all"]')?.checked && document.querySelector('#ar-share-box [data-as-now]'), { timeout: 5000 });
    console.log(`  B arcade_share_set 인자=${JSON.stringify(set.args)}`);
  } finally { await page.close(); }
});
