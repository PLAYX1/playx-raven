// 11-12 이야기 = 카톡 PC: 왼쪽 「친구 · 채팅 · 광장」, 가운데 쪽지(이 창 안 · talk_dm.rs). 실제 Chrome, 빌드된 dist, 합성 자료.
// 노드·지갑·네트워크 없음 — __TAURI_INTERNALS__.invoke 를 흉내 낸다(쪽지 글자만 오가고 열쇠는 없다).
//   node --test scripts/talk-dm-browser.test.mjs      (RV_DIST=<dist> 면 그 dist · RV_SHOTS=<폴더> 면 화면을 찍어 둔다)
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { mkdtempSync, rmSync, existsSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve, join, extname, sep } from 'node:path';
import { tmpdir } from 'node:os';
import puppeteer from 'puppeteer-core';
import { installFixture } from './desktop-fixture.mjs';

const root = resolve(import.meta.dirname, '..');
const SHOTS = process.env.RV_SHOTS || '';
let work, dist, server, origin, browser;
before(async () => {
  work = mkdtempSync(join(tmpdir(), 'rv-dm-ui-'));
  if (process.env.RV_DIST && existsSync(join(process.env.RV_DIST, 'index.html'))) dist = process.env.RV_DIST;
  else {
    dist = join(work, 'dist');
    execFileSync(process.execPath, [resolve(root, 'node_modules/vite/bin/vite.js'), 'build', '--outDir', dist, '--emptyOutDir', '--logLevel', 'error'], { cwd: root, stdio: ['ignore', 'ignore', 'inherit'] });
  }
  if (SHOTS) mkdirSync(SHOTS, { recursive: true });
  const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.webp': 'image/webp', '.json': 'application/json' };
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
after(async () => { await browser?.close(); server?.close(); if (work) rmSync(work, { recursive: true, force: true }); });

const h = (c) => c.repeat(64);
const ME = h('a'), KIM = h('b'), LEE = h('c'), PARK = h('d');
const ROOM = h('e');
const now = Math.floor(Date.now() / 1000);
const GROUP = 'g:0123456789abcdef0123456789abcdef';
const members = [ME, KIM, LEE].sort();
const MSGS = {
  [KIM]: [
    { id: '1'.repeat(64), from: KIM, to: ME, at: now - 3600, text: '관장님, 내일 수업 몇 시예요?', wrap: 'w1' },
    { id: '2'.repeat(64), from: ME, to: KIM, at: now - 3500, text: '저녁 7시예요 :ravi_ok:', wrap: 'w2' },
    { id: '3'.repeat(64), from: KIM, to: ME, at: now - 600, text: '감사합니다! 도복 챙겨 갈게요', wrap: 'w3' },
  ],
  [GROUP]: [
    { id: '4'.repeat(64), from: LEE, to: ME, at: now - 300, text: '주말 모임 장소 정했어요', wrap: 'w4', members, subject: '주말 모임' },
    { id: '5'.repeat(64), from: KIM, to: ME, at: now - 120, text: '좋아요 :ravi_cheer:', wrap: 'w5', members },
  ],
};
const THREADS = [
  { key: GROUP, kind: 'group', members, subject: '주말 모임', last: MSGS[GROUP][1], count: 2, unread: 2 },
  { key: KIM, kind: 'dm', with: KIM, last: MSGS[KIM][2], count: 3, unread: 1 },
];

async function open(width = 1440, height = 900, side = null) {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.setViewport({ width, height });
  await page.setRequestInterception(true);
  page.on('request', (r) => ((new URL(r.url()).origin === origin && r.method() === 'GET') ? r.continue() : r.abort()));
  await page.evaluateOnNewDocument(installFixture, { theme: 'light', sales: true, seller: false });
  await page.evaluateOnNewDocument((d) => {
    localStorage.setItem('rv-v2-backup-reminded', '1'); localStorage.setItem('playx-raven-lang', 'ko');
    if (d.side) localStorage.setItem('rv.talk.side', JSON.stringify(d.side));
    window.__sent = []; window.__threadsArgs = [];
    const real = window.__TAURI_INTERNALS__.invoke;
    window.__TAURI_INTERNALS__.invoke = async (cmd, args) => {
      if (cmd === 'talk_me') return { pubkey: d.ME, recoverable: true, same_as_wallet: true };
      if (cmd === 'talk_profiles') return { [d.ME]: { name: '김무송' }, [d.KIM]: { name: '김민수' }, [d.LEE]: { name: '이영희' }, [d.PARK]: { name: '박철수' } };
      if (cmd === 'talk_rooms') return [{ id: d.ROOM, name: '서울 주짓수 모임', about: '', pubkey: d.LEE }];
      if (cmd === 'talk_view') return { notes: [{ id: '9'.repeat(64), pubkey: d.LEE, created_at: d.now - 50, content: '광장 글입니다', tags: [['t', 'ravencoin']] }], gone: [], oldest: 0 };
      if (cmd === 'talk_follows') return { ids: [d.PARK, d.KIM] };
      if (cmd === 'talk_dm_threads') { window.__threadsArgs.push(args); return { me: d.ME, same_as_wallet: true, reached: true, threads: structuredClone(d.THREADS), rooms_last: { [d.ROOM]: { at: d.now - 1800, from: d.LEE, text: '이번 주 토요일 오픈매트!' } } }; }
      if (cmd === 'talk_dm_read') return { me: d.ME, same_as_wallet: true, reached: true, messages: structuredClone(d.MSGS[args.key] || []) };
      if (cmd === 'talk_dm_send') {
        window.__sent.push(JSON.parse(JSON.stringify(args)));
        const group = args.to.length > 1;
        const m = { id: 'f'.repeat(63) + String(window.__sent.length), from: d.ME, to: args.to[0], at: Math.floor(Date.now() / 1000), text: args.text, wrap: 'wx', ...(group ? { members: [d.ME, ...args.to].sort(), subject: args.subject || '' } : {}) };
        return { message: m, key: group ? d.GROUP : args.to[0], delivered: args.to.length, total: args.to.length, failed: [] };
      }
      if (cmd === 'talk_dm_peers') return args.ids.map((x) => x === 'npub1park' ? d.PARK : x);
      if (cmd === 'talk_dm_group_key') return d.GROUP;
      if (cmd === 'talk_os_notify') return false;
      return real(cmd, args);
    };
  }, { ME, KIM, LEE, PARK, ROOM, GROUP, now, THREADS, MSGS, side });
  await page.goto(origin + '/', { waitUntil: 'networkidle0' });
  await page.waitForFunction(() => document.querySelector('#page-home.on'), { timeout: 20000 });
  await page.evaluate(() => document.querySelector('nav a[data-page="talk"]').click());
  await page.waitForFunction(() => document.querySelectorAll('#tk-chats .tkc-row').length >= 3, { timeout: 15000 });
  return { page, errors };
}
const settle = (ms = 300) => new Promise((r) => setTimeout(r, ms));
const shot = async (page, name) => { if (SHOTS) await page.screenshot({ path: join(SHOTS, name) }); };

test('채팅: 쪽지·단톡·방이 마지막 글 시각순 한 목록 · 안 읽은 수 · 칸 배지', async () => {
  const { page, errors } = await open();
  try {
    const rows = await page.$$eval('#tk-chats .tkc-row', (r) => r.map((x) => ({ name: x.querySelector('.tkc-name').textContent, n: x.querySelector('.tkc-n')?.textContent || '', dot: !!x.querySelector('.tkc-dot'), last: x.querySelector('.tkc-last').textContent })));
    assert.deepEqual(rows.map((r) => r.name), ['주말 모임', '김민수', '서울 주짓수 모임'], '최근 글 먼저');
    assert.equal(rows[0].n, '2');
    assert.equal(rows[1].n, '1');
    assert.match(rows[1].last, /도복/);
    assert.match(rows[2].last, /이영희: 이번 주 토요일/);
    assert.equal(await page.$eval('#tk-side-chats-n', (b) => b.hidden ? '' : b.textContent), '2', '안 읽은 대화 2개');
    assert.equal(await page.$eval('#tk-side-chats', (b) => b.getAttribute('aria-selected')), 'true');
    assert.equal(await page.$eval('#tk-squarebox', (b) => b.hidden), true, '방 목록은 광장 칸에');
    // 단추는 두 줄로 안 접힌다.
    for (const sel of ['#tk-side-friends', '#tk-side-chats', '#tk-side-square', '#tk-newdm']) {
      assert.equal(await page.$eval(sel, (b) => getComputedStyle(b).whiteSpace), 'nowrap', sel);
    }
    await shot(page, 'chats-1440.png');
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

test('1:1 쪽지: 누르면 가운데에 말풍선 · 암호 쪽지 표시 · 보내면 talk_dm_send(to, text) · 안 읽음 사라짐', async () => {
  const { page, errors } = await open();
  try {
    await page.evaluate((k) => document.querySelector(`#tk-chats [data-chat-key="${k}"]`).click(), KIM);
    await page.waitForFunction(() => document.querySelectorAll('#tk-list .bub').length === 3);
    assert.equal(await page.$eval('#tk-title', (e) => e.textContent), '김민수');
    assert.equal(await page.$eval('#page-talk', (p) => p.classList.contains('dmon')), true);
    assert.equal(await page.$eval('#tk-dmchip', (e) => getComputedStyle(e).display !== 'none' && e.textContent), '암호 쪽지 · 두 사람만 읽어요');
    assert.equal(await page.$eval('.rv-public', (e) => getComputedStyle(e).display), 'none', '공개 방 표시는 접는다');
    assert.equal(await page.$eval('#tk-photo', (e) => getComputedStyle(e).display), 'none', '쪽지에는 사진 단추 없음(아직)');
    assert.equal(await page.$$eval('#tk-list .line.me', (l) => l.length), 1);
    assert.ok(await page.$('#tk-list .bub .tk-stk, #tk-list .bub img'), '이모티콘은 그림으로');
    assert.equal(await page.$eval(`#tk-chats [data-chat-key="${KIM}"] .tkc-n`, () => 'x').catch(() => ''), '', '연 대화는 안 읽음 0');
    await page.type('#tk-text', '네 내일 봬요');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => window.__sent.length === 1);
    assert.deepEqual(await page.evaluate(() => window.__sent[0]), { to: [KIM], text: '네 내일 봬요', subject: null });
    await page.waitForFunction(() => [...document.querySelectorAll('#tk-list .line.me .bub')].some((b) => /내일 봬요/.test(b.textContent)) && !document.querySelector('#tk-list .line.pending'));
    assert.equal(await page.$eval('#tk-text', (t) => t.value), '');
    await shot(page, 'dm-1440.png');
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

test('단톡: 사람 이름이 말풍선 위에 · 보내면 나를 뺀 멤버 + 단톡 이름', async () => {
  const { page, errors } = await open(1137, 780);
  try {
    await page.evaluate((k) => document.querySelector(`#tk-chats [data-chat-key="${k}"]`).click(), GROUP);
    await page.waitForFunction(() => document.querySelectorAll('#tk-list .bub').length === 2);
    assert.equal(await page.$eval('#tk-title', (e) => e.textContent), '주말 모임');
    assert.match(await page.$eval('#tk-dmchip', (e) => e.textContent), /3명만 읽어요/);
    const who = await page.$$eval('#tk-list .who', (w) => w.map((x) => x.textContent.trim()));
    assert.equal(who.length, 2);
    assert.match(who[0], /이영희/);
    await page.type('#tk-text', '저도 갈게요');
    await page.click('#tk-send');
    await page.waitForFunction(() => window.__sent.length === 1);
    const sent = await page.evaluate(() => window.__sent[0]);
    assert.deepEqual([...sent.to].sort(), [KIM, LEE].sort());
    assert.equal(sent.subject, '주말 모임');
    await settle();
    await shot(page, 'group-1137.png');
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

test('친구: 팔로우 + 쪽지 상대, 「쪽지」로 바로 대화 · 광장 칸은 예전 방 목록과 피드', async () => {
  const { page, errors } = await open(1137, 780);
  try {
    await page.click('#tk-side-friends');
    await page.waitForFunction(() => document.querySelectorAll('#tk-friends [data-friend-dm]').length === 2);
    const names = await page.$$eval('#tk-friends .tkc-name', (n) => n.map((x) => x.textContent));
    assert.deepEqual(names, ['김민수', '박철수']);
    assert.equal(await page.$eval('#tk-friends .tkc-dm', (b) => getComputedStyle(b).whiteSpace), 'nowrap');
    await shot(page, 'friends-1137.png');
    await page.evaluate((p) => document.querySelector(`#tk-friends [data-friend-dm="${p}"]`).click(), PARK);
    await page.waitForFunction(() => document.querySelector('#page-talk.dmon') && /박철수/.test(document.getElementById('tk-title').textContent));
    assert.equal(await page.$eval('#tk-side-chats', (b) => b.getAttribute('aria-selected')), 'true', '쪽지를 열면 채팅 칸으로');
    await page.waitForFunction(() => /아직 주고받은 쪽지가 없어요/.test(document.getElementById('tk-list').textContent));
    // 광장 칸 → 쪽지를 닫고 가운데는 광장 피드.
    await page.click('#tk-side-square');
    await page.waitForFunction(() => !document.querySelector('#page-talk.dmon') && document.querySelector('#tk-list .fcard'));
    assert.equal(await page.$eval('#tk-squarebox', (b) => b.hidden), false);
    assert.ok(await page.$(`#tk-rooms [data-room="${ROOM}"]`));
    assert.equal(await page.$eval('#tk-title', (e) => e.textContent), '광장');
    await shot(page, 'square-1137.png');
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

test('채팅에서 방을 누르면 방 대화 · 「+ 새 쪽지」는 아이디로 1:1 을 연다', async () => {
  const { page, errors } = await open(1440, 900);
  try {
    await page.evaluate((r) => document.querySelector(`#tk-chats [data-chat-room="${r}"]`).click(), ROOM);
    await page.waitForFunction(() => /서울 주짓수 모임/.test(document.getElementById('tk-title').textContent) && !document.querySelector('#page-talk.dmon'));
    await page.click('#tk-newdm');
    assert.equal(await page.$eval('#tk-dmbox', (b) => b.hidden), false);
    assert.match(await page.$eval('#tk-dmsame', (e) => e.textContent), /같은 12단어/);
    await shot(page, 'newdm-1440.png');
    await page.type('#tk-dmto', 'npub1park');
    await page.click('#tk-dmstart');
    await page.waitForFunction(() => document.querySelector('#page-talk.dmon') && /박철수/.test(document.getElementById('tk-title').textContent));
    assert.equal(await page.$eval('#tk-dmbox', (b) => b.hidden), true);
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

test('쪽지 화면 1137×780 · 1440×900: 가로 넘침 없음 · 입력칸이 화면 안', async () => {
  for (const [w, hh] of [[1137, 780], [1440, 900]]) {
    const { page, errors } = await open(w, hh);
    try {
      await page.evaluate((k) => document.querySelector(`#tk-chats [data-chat-key="${k}"]`).click(), KIM);
      await page.waitForFunction(() => document.querySelectorAll('#tk-list .bub').length === 3);
      await settle();
      const m = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth, send: document.getElementById('tk-send').getBoundingClientRect().bottom, vh: innerHeight, rows: document.getElementById('tk-chats').scrollWidth - document.getElementById('tk-chats').clientWidth }));
      assert.ok(m.sw <= m.cw + 1, `가로 넘침 ${w}`);
      assert.ok(m.rows <= 1, `채팅 목록 가로 넘침 ${w}`);
      assert.ok(m.send <= m.vh, `보내기가 화면 안 ${w}`);
      await shot(page, `dm-${w}.png`);
      assert.deepEqual(errors, []);
    } finally { await page.close(); }
  }
});

// 11-12 카톡 PC·텔레그램 결(src/talk-desk.ts): 그림 줄 · 목록 줄 크기 · 찾기 · Esc · 말풍선 메뉴 · 보내기 단추 · 말풍선 폭.
test('카톡 PC 결: 줄 64~72px · 46px 동그라미 · Ctrl/⌘+F 찾기 · 말풍선 폭 · 보내기는 글이 있을 때만 · Esc 로 닫기', async () => {
  const { page, errors } = await open(1440, 900);
  try {
    // 목록 줄: 테두리 없고 64~72px, 동그라미 44~48px, 이름 15px 굵게, 마지막 말 13px.
    const row = await page.$eval(`#tk-chats [data-chat-key="${KIM}"]`, (r) => {
      const cs = getComputedStyle(r), av = r.querySelector('.tkc-av').getBoundingClientRect();
      return { h: Math.round(r.getBoundingClientRect().height), border: cs.borderTopWidth, radius: cs.borderTopLeftRadius, av: Math.round(av.width), avr: getComputedStyle(r.querySelector('.tkc-av')).borderRadius, name: getComputedStyle(r.querySelector('.tkc-name')).fontSize, last: getComputedStyle(r.querySelector('.tkc-last')).fontSize };
    });
    assert.ok(row.h >= 64 && row.h <= 72, `줄 높이 ${row.h}`);
    assert.equal(row.border, '0px'); assert.equal(row.radius, '0px');
    assert.ok(row.av >= 44 && row.av <= 48, `동그라미 ${row.av}`); assert.equal(row.avr, '50%');
    assert.equal(row.name, '15px'); assert.equal(row.last, '13px');
    // 그림 줄: 친구·채팅·광장이 세로로, 글자는 한 줄.
    const rail = await page.$$eval('.tk-rail [role="tab"]', (b) => b.map((x) => ({ x: Math.round(x.getBoundingClientRect().left), ws: getComputedStyle(x).whiteSpace })));
    assert.equal(rail.length, 3); assert.equal(new Set(rail.map((r) => r.x)).size, 1, '세로 한 줄'); assert.ok(rail.every((r) => r.ws === 'nowrap'));
    // Ctrl/⌘+F → 목록 찾기 칸.
    const mod = process.platform === 'darwin' ? 'Meta' : 'Control';
    await page.keyboard.down(mod); await page.keyboard.press('KeyF'); await page.keyboard.up(mod);
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'tk-filter');
    await page.keyboard.type('김민');
    assert.deepEqual(await page.$$eval('#tk-chats .tkc-row', (r) => r.filter((x) => getComputedStyle(x).display !== 'none').map((x) => x.querySelector('.tkc-name').textContent)), ['김민수']);
    await page.keyboard.press('Escape');
    assert.equal(await page.$eval('#tk-filter', (i) => i.value), '', 'Esc 로 찾기 지움');
    assert.equal(await page.$$eval('#tk-chats .tk-filtered', (r) => r.length), 0);
    // 대화 열기 → 말풍선 폭 ≤ 70% · 보내기 단추는 빈 칸이면 흐림.
    await page.evaluate((k) => document.querySelector(`#tk-chats [data-chat-key="${k}"]`).click(), KIM);
    await page.waitForFunction(() => document.querySelectorAll('#tk-list .bub').length === 3);
    const geo = await page.evaluate(() => {
      const pane = document.getElementById('tk-list').getBoundingClientRect().width;
      return { pane, widest: Math.max(...[...document.querySelectorAll('#tk-list .bub')].map((b) => b.getBoundingClientRect().width)), who: document.querySelectorAll('#tk-list .who:not(.me) .rv-avatar').length };
    });
    assert.ok(geo.widest <= geo.pane * 0.7, `말풍선 ${geo.widest} / ${geo.pane}`);
    assert.ok(geo.who >= 1, '상대 말 무리에 얼굴');
    assert.equal(await page.$eval('.composer', (c) => c.classList.contains('tk-empty')), true, '빈 칸이면 보내기 흐림');
    await page.type('#tk-text', '안녕');
    assert.equal(await page.$eval('.composer', (c) => c.classList.contains('tk-empty')), false);
    // 머리 단추는 그림(글자는 화면 읽기용) · 줄바꿈 없음.
    for (const sel of ['#tk-info', '#tk-more']) {
      const b = await page.$eval(sel, (e) => ({ h: Math.round(e.getBoundingClientRect().height), w: Math.round(e.getBoundingClientRect().width), label: e.textContent.trim() }));
      assert.equal(b.h, 40, sel); assert.equal(b.w, 40, sel); assert.ok(b.label, `${sel} 화면 읽기 글자`);
    }
    // Esc: 입력칸에 있어도 대화를 닫는다 → 가운데는 「대화를 골라 주세요」.
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => document.querySelector('#page-talk.idle') && !document.querySelector('#page-talk.dmon'));
    assert.equal(await page.$eval('#tk-idle', (e) => getComputedStyle(e).display !== 'none'), true);
    // 다른 대화를 누르면 다시 열린다.
    await page.evaluate((k) => document.querySelector(`#tk-chats [data-chat-key="${k}"]`).click(), GROUP);
    await page.waitForFunction(() => !document.querySelector('#page-talk.idle') && document.querySelectorAll('#tk-list .bub').length === 2);
    await shot(page, 'desk-group-1440.png');
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

test('말풍선 오른쪽 클릭: 방은 답장·복사·내 말로…(있는 단추를 대신 누른다) · 쪽지는 복사 · Esc 로 메뉴만 닫힘', async () => {
  const { page, errors } = await open(1440, 900);
  try {
    await page.evaluate(() => { window.__copied = []; navigator.clipboard.writeText = async (s) => { window.__copied.push(s); }; });
    await page.evaluate((k) => document.querySelector(`#tk-chats [data-chat-key="${k}"]`).click(), KIM);
    await page.waitForFunction(() => document.querySelectorAll('#tk-list .bub').length === 3);
    const at = await page.$$eval('#tk-list .line:not(.me) .bub', (bs) => { const r = bs[bs.length - 1].getBoundingClientRect(); return { x: r.left + 12, y: r.top + 8 }; });
    await page.mouse.click(at.x, at.y, { button: 'right' });
    await page.waitForFunction(() => document.getElementById('tk-ctx') && !document.getElementById('tk-ctx').hidden);
    const items = await page.$$eval('#tk-ctx button', (b) => b.map((x) => x.textContent.trim()));
    assert.deepEqual(items, ['복사'], '쪽지 메뉴');
    const box = await page.$eval('#tk-ctx', (m) => { const r = m.getBoundingClientRect(); return { x: r.left, y: r.top }; });
    assert.ok(Math.abs(box.x - at.x) < 4 && Math.abs(box.y - at.y) < 4, '커서 자리에');
    await page.click('#tk-ctx button');
    await page.waitForFunction(() => window.__copied.length === 1);
    assert.equal(await page.evaluate(() => window.__copied[0]), '감사합니다! 도복 챙겨 갈게요', '받은 글자 그대로');
    // Esc 는 메뉴만 닫는다(대화는 그대로).
    await page.mouse.click(at.x, at.y, { button: 'right' });
    await page.keyboard.press('Escape');
    assert.equal(await page.$eval('#tk-ctx', (m) => m.hidden), true);
    assert.equal(await page.$eval('#page-talk', (p) => p.classList.contains('dmon')), true, '대화는 열린 채');
    // 방: 말풍선 아래 단추 줄(.bubacts)과 같은 일 — 「답장」을 누르면 답장 줄이 뜬다. Esc 는 답장부터 거둔다.
    await page.evaluate((r) => document.querySelector(`#tk-chats [data-chat-room="${r}"]`).click(), ROOM);
    await page.waitForFunction(() => !document.querySelector('#page-talk.dmon') && document.querySelector('#tk-list .bub[data-say]'));
    const at2 = await page.$eval('#tk-list .bub[data-say]', (b) => { const r = b.getBoundingClientRect(); return { x: r.left + 12, y: r.top + 8 }; });
    await page.mouse.click(at2.x, at2.y, { button: 'right' });
    await page.waitForFunction(() => !document.getElementById('tk-ctx').hidden);
    const roomItems = await page.$$eval('#tk-ctx button', (b) => b.map((x) => x.textContent.trim()));
    assert.deepEqual(roomItems.slice(0, 2), ['답장', '복사']);
    assert.ok(roomItems.includes('내 말로') && roomItems.includes('안 보기'), roomItems.join());
    await shot(page, 'desk-roommenu-1440.png');
    await page.click('#tk-ctx button');
    await page.waitForFunction(() => !document.getElementById('tk-replybar').hidden);
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => document.getElementById('tk-replybar').hidden);
    assert.match(await page.$eval('#tk-title', (e) => e.textContent), /서울 주짓수 모임/, '방은 그대로');
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});
