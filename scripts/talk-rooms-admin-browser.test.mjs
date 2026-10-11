// 이야기 방 운영(0.9.0 레인 C) — 실제 Chrome 에서 빌드된 dist 를 합성 자료(desktop-fixture)로 띄워 본다.
// ① 「방 설정」은 내가 만든 방에서만 보인다(남의 방·레이븐 이야기에서는 숨김).
// ② 방 설정 시트: 이름·설명 고치기 · 화면 검사(빈 이름·너무 김·숨은 방향 문자) · 지갑 잠김이면 「지갑 열기」 먼저 → 다시 시도 → 몇 곳이 받았는지.
// ③ 이 방 숨기기 → 목록에서 사라짐 → 「숨긴 방」에서 되돌리기. 공식 방은 한 번 묻는다.
// 노드·지갑·릴레이·체인은 부르지 않는다. talk_* · wallet_lock_state · unlock_for 는 이 하네스가 답한다(가짜).
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve, join, extname, sep } from 'node:path';
import { tmpdir } from 'node:os';
import puppeteer from 'puppeteer-core';
import { installFixture } from './desktop-fixture.mjs';

const root = resolve(import.meta.dirname, '..');
const SHOTS = process.env.RV_TALK_ROOMS_SHOTS; // 캡처를 남길 폴더(없으면 안 남긴다)
let work, dist, browser, server, origin;

before(async () => {
  work = mkdtempSync(join(tmpdir(), 'rv-talk-rooms-ui-'));
  dist = join(work, 'dist');
  execFileSync(process.execPath, [resolve(root, 'node_modules/vite/bin/vite.js'), 'build', '--outDir', dist, '--emptyOutDir', '--logLevel', 'error'], { cwd: root, stdio: ['ignore', 'ignore', 'inherit'] });
  const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.json': 'application/json' };
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
  if (SHOTS) mkdirSync(SHOTS, { recursive: true });
});
after(async () => { await browser?.close(); server?.close(); if (work) rmSync(work, { recursive: true, force: true }); });

const ME = 'a'.repeat(64), OTHER = 'b'.repeat(64);
const MINE = '1'.repeat(64), THEIRS = '2'.repeat(64), OFFICIAL = '3'.repeat(64);

/** 합성 이야기 하네스. 비밀(암호·열쇠·12단어)은 받지도 남기지도 않는다 — 암호는 「불렸다」만 적는다. */
function installTalkHarness({ me, mine, theirs, official, other, locked }) {
  const base = window.__TAURI_INTERNALS__.invoke;
  const rooms = [
    { id: mine, name: '내 방', about: '처음 설명', asset: '', pubkey: me, meta_at: null },
    { id: theirs, name: '남의 방', about: '', asset: '', pubkey: other, meta_at: null },
    { id: official, name: 'RavenVault 레이븐볼트', about: '공식', asset: '', pubkey: other, meta_at: null },
  ];
  const log = window.__talkLog = [];
  let unlocked = !locked;
  window.__TAURI_INTERNALS__.invoke = async (cmd, args) => {
    if (cmd === 'talk_me') return { pubkey: me, recoverable: true, path: '', same_as_wallet: true, why: '' };
    if (cmd === 'talk_rooms') { log.push('talk_rooms'); return structuredClone(rooms); }
    if (cmd === 'talk_read') return [];
    if (cmd === 'talk_profiles') return {};
    if (cmd === 'wallet_lock_state') return { encrypted: true, unlocked };
    if (cmd === 'unlock_for') { log.push('unlock_for'); unlocked = true; return null; } // 암호 값은 적지 않는다
    if (cmd === 'talk_room_meta_set') {
      log.push(['talk_room_meta_set', args.room, args.name, args.about]);
      if (!unlocked) throw '[SEED_LOCKED] 지갑이 잠겨 있어 12단어를 읽을 수 없습니다. 「지갑 열기」를 눌러 주세요.';
      const r = rooms.find(x => x.id === args.room);
      if (!r || r.pubkey !== me) throw '이 방을 만든 열쇠로 확인되지 않았습니다.';
      Object.assign(r, { name: args.name, about: args.about, meta_at: Math.floor(Date.now() / 1000) });
      return { name: args.name, about: args.about, public_ok: 2, public_total: 3, local_ok: true, event: {}, sent: {} };
    }
    return base(cmd, args);
  };
  window.__TAURI__.core.invoke = window.__TAURI_INTERNALS__.invoke;
}

async function openTalk({ lang = 'ko', locked = false, width = 1440, height = 900 } = {}) {
  const page = await browser.newPage();
  page.__errors = [];
  page.on('pageerror', e => page.__errors.push(e.message));
  await page.setViewport({ width, height });
  // 시트 위치를 재므로 움직임 줄이기(시트가 미끄러져 들어오는 0.32초 동안 재면 어긋난다).
  await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
  await page.setRequestInterception(true);
  page.on('request', r => (new URL(r.url()).origin === origin && r.method() === 'GET') ? r.continue() : r.abort());
  await page.evaluateOnNewDocument(installFixture, { theme: 'light', sales: false });
  await page.evaluateOnNewDocument(installTalkHarness, { me: ME, mine: MINE, theirs: THEIRS, official: OFFICIAL, other: OTHER, locked });
  if (lang !== 'ko') await page.evaluateOnNewDocument(l => localStorage.setItem('playx-raven-lang', l), lang);
  await page.goto(origin + '/', { waitUntil: 'networkidle0' });
  await page.waitForFunction(() => document.querySelector('#page-home.on') && !document.documentElement.hasAttribute('data-ravi-arriving'), { timeout: 20000 });
  await page.evaluate(() => document.querySelector('nav')?.classList.add('more-open'));
  await page.evaluate(() => document.querySelector('nav a[data-page="talk"]').click());
  await page.waitForFunction(id => document.querySelector('#page-talk.on') && document.querySelector(`#tk-rooms [data-room="${id}"]`), { timeout: 15000 }, MINE);
  return page;
}
const pick = (page, id) => page.evaluate(id => document.querySelector(`#tk-rooms [data-room="${id}"]`).click(), id);
const visible = (page, sel) => page.evaluate(sel => { const e = document.querySelector(sel); return !!e && !e.hidden && !!e.offsetParent || (!!e && getComputedStyle(e).position === 'fixed' && !e.hidden); }, sel);
const text = (page, sel) => page.$eval(sel, el => el.textContent.trim());
const shot = async (page, name) => { if (SHOTS) await page.screenshot({ path: join(SHOTS, name + '.png') }); };

test('「방 설정」은 내가 만든 방에서만 — 남의 방·레이븐 이야기에서는 숨김', async () => {
  const page = await openTalk();
  await page.waitForFunction(() => document.getElementById('tk-room-settings'));
  assert.equal(await visible(page, '#tk-room-settings'), false, '레이븐 이야기(전체 글)에서 방 설정이 보인다');
  assert.equal(await page.$eval('#tk-hideroom', e => e.hidden), true, '레이븐 이야기는 방이 아니라 숨길 수 없다');
  await pick(page, THEIRS);
  await page.waitForFunction(() => document.getElementById('tk-room-settings').hidden === true);
  assert.equal(await page.$eval('#tk-hideroom', e => e.hidden), false, '남의 방도 내 화면에서는 숨길 수 있어야 한다');
  await pick(page, MINE);
  await page.waitForFunction(() => document.getElementById('tk-room-settings').hidden === false);
  assert.equal(await text(page, '#tk-room-settings'), '방 설정');
  // 자리: 시안처럼 「초대하기」 바로 뒤.
  assert.equal(await page.$eval('#tk-room-settings', e => e.previousElementSibling?.id), 'tk-invite');
  // 병합(0.9.0): 레인 A 자리 하나만 쓴다 — 머리줄에 「방 설정」 단추가 둘이 되면 안 된다.
  assert.equal(await page.$$eval('#page-talk .chathead button', bs => bs.filter(b => b.textContent.trim() === '방 설정').length), 1, '「방 설정」 단추가 둘');
  assert.equal(await page.$eval('#tk-room-settings', e => e.disabled), false, '연결 뒤에도 disabled');
  assert.deepEqual(page.__errors, []);
  await page.close();
});

test('방 설정 시트 — 화면 검사 · 지갑 잠김이면 「지갑 열기」 먼저 → 다시 시도 → 몇 곳이 받았는지', async () => {
  const page = await openTalk({ locked: true, width: 1024, height: 768 });
  await pick(page, MINE);
  await page.waitForFunction(() => document.getElementById('tk-room-settings').hidden === false);
  // 1024 폭 머리줄: 「초대하기」·「방 설정」·「더 보기」가 한 줄, 같은 높이.
  const heights = await page.$$eval('#page-talk .chathead :is(#tk-inv, #tk-room-settings, #tk-more)', bs => bs.map(b => [Math.round(b.getBoundingClientRect().height), Math.round(b.getBoundingClientRect().top)]));
  assert.equal(new Set(heights.map(h => h.join())).size, 1, `머리줄 단추가 어긋난다: ${JSON.stringify(heights)}`);
  await shot(page, 'head-1024');
  await page.click('#tk-room-settings');
  await page.waitForFunction(() => document.querySelector('#info') && !document.querySelector('#info').hidden);
  // 시트는 레인 A 가 비워 둔 자리 #tk-room-sheet 안에 붙고, 자리 상자도 같이 보인다.
  assert.equal(await page.$eval('#info', e => e.parentElement?.id), 'tk-room-sheet');
  assert.equal(await page.$eval('#tk-room-sheet', e => e.hidden), false);
  assert.equal(await page.$eval('#tk-room-settings', e => e.getAttribute('aria-expanded')), 'true');
  assert.match(await text(page, '#info-nodelete'), /완전히 지울 수 없어요/);
  assert.equal(await page.$$eval('#info button', bs => bs.some(b => /지우기|삭제|나가기/.test(b.textContent))), false, '지우기·나가기 단추가 있다');
  // 1024 폭에서는 대화 위를 덮는 시트다.
  const box = await page.$eval('#info', e => { const r = e.getBoundingClientRect(); return { pos: getComputedStyle(e).position, right: Math.round(innerWidth - r.right), w: Math.round(r.width) }; });
  assert.deepEqual(box, { pos: 'fixed', right: 0, w: 380 });
  await shot(page, 'sheet-1024');

  await page.click('#info-edit-name');
  await page.waitForFunction(() => !document.getElementById('info-form').hidden);
  const setVal = (sel, v) => page.$eval(sel, (el, v) => { el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); }, v);
  const calls = () => page.evaluate(() => window.__talkLog.filter(x => Array.isArray(x)).length);

  await setVal('#info-name', '   ');
  await page.click('#info-save');
  assert.match(await text(page, '#info-say'), /방 이름이 필요해요/);
  await setVal('#info-name', 'RavenVault‮tlua');
  await page.click('#info-save');
  assert.match(await text(page, '#info-say'), /보이지 않는 특수 문자/);
  await page.$eval('#info-name', el => el.removeAttribute('maxlength')); // 붙여넣기 등으로 넘어온 경우
  await setVal('#info-name', '가'.repeat(41));
  await page.click('#info-save');
  assert.match(await text(page, '#info-say'), /40자까지.*41자/);
  assert.equal(await calls(), 0, '화면 검사에 걸린 것을 러스트로 보냈다');

  await setVal('#info-name', '서울 주짓수 모임');
  await setVal('#info-about', '매주 목요일 스파링');
  assert.equal(await text(page, '#info-name-n'), '9/40');
  await page.click('#info-save');
  // 잠김: 시트 안에 이유 + 「지갑 열기」. 페이지 맨 아래 경고 상자는 붙지 않는다.
  await page.waitForFunction(() => !document.getElementById('info-lock').hidden);
  assert.match(await text(page, '#info-lock'), /지갑이 잠겨 있어요.*복구 단어는 묻지 않아요/);
  assert.doesNotMatch(await text(page, '#info-lock'), /12단어/, '「12단어」라는 낱말로 겁주지 않는다');
  assert.equal(await page.$$eval('.seed-recovery', l => l.length), 0, '빨간 경고 상자가 페이지 맨 아래에 붙었다');
  assert.equal(await calls(), 1);
  await shot(page, 'sheet-locked');

  await page.click('#info-unlock');
  await page.waitForFunction(() => document.getElementById('askwrap').classList.contains('on'));
  assert.equal(await page.$eval('#ask-input', e => e.type), 'password', '기존 「지갑 열기」(암호 칸)를 쓰지 않는다');
  await page.type('#ask-input', 'synthetic-not-a-password');
  await page.click('#ask-yes');
  await page.waitForFunction(() => /공개 릴레이 3곳 중 2곳/.test(document.getElementById('info-say')?.textContent || ''), { timeout: 8000 });
  assert.match(await text(page, '#info-say'), /이 컴퓨터의 릴레이에도 저장했어요/);
  const log = await page.evaluate(() => window.__talkLog.filter(x => x !== 'talk_rooms'));
  assert.deepEqual(log, [
    ['talk_room_meta_set', '1'.repeat(64), '서울 주짓수 모임', '매주 목요일 스파링'],
    'unlock_for',
    ['talk_room_meta_set', '1'.repeat(64), '서울 주짓수 모임', '매주 목요일 스파링'],
  ]);
  // 목록·머리줄·시트 제목이 새 이름으로.
  assert.equal(await text(page, `#tk-rooms [data-room="${MINE}"]`), '서울 주짓수 모임');
  assert.equal(await text(page, '#tk-title'), '서울 주짓수 모임');
  assert.equal(await text(page, '#info-h'), '서울 주짓수 모임');
  assert.equal(await page.$eval('#info-h', e => e.getAttribute('translate')), 'no', '사용자가 적은 방 이름을 번역한다');
  await shot(page, 'sheet-saved');

  // Esc 로 닫고 초점은 「방 설정」으로 돌아간다.
  await page.focus('#closeinfo');
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => document.getElementById('info').hidden);
  assert.equal(await page.evaluate(() => document.activeElement?.id), 'tk-room-settings');
  // 바뀐 것이 없으면 보내지 않는다.
  await page.click('#tk-room-settings');
  await page.click('#info-edit-about');
  await page.click('#info-save');
  assert.match(await text(page, '#info-say'), /바뀐 것이 없어요/);
  assert.equal(await calls(), 2);
  assert.deepEqual(page.__errors, []);
  await page.close();
});

test('이 방 숨기기 → 목록에서 사라짐 → 「숨긴 방」에서 되돌리기 · 공식 방은 한 번 묻는다', async () => {
  const page = await openTalk();
  await pick(page, THEIRS);
  await page.waitForFunction(() => document.getElementById('tk-hideroom')?.hidden === false);
  await page.click('#tk-more');
  await page.click('#tk-hideroom');
  await page.waitForFunction(id => !document.querySelector(`#tk-rooms [data-room="${id}"]`), {}, THEIRS);
  // 보던 방을 숨기면 레이븐 이야기로 돌아간다.
  assert.equal(await page.$eval('#tk-rooms .room.on', e => e.dataset.room), '');
  assert.match(await text(page, '#tk-hiddennote'), /남의 방.*이 컴퓨터에서만.*다른 사람 화면에는 그대로/);
  assert.equal(await page.evaluate(() => Object.keys(JSON.parse(localStorage.getItem('playx-raven-talk-hidden-rooms'))).length), 1);
  assert.equal(await text(page, '#tk-hiddenrooms'), '숨긴 방 1');
  await page.click('#tk-hiddenrooms');
  await page.waitForFunction(() => document.getElementById('tk-hiddenbox'));
  assert.match(await text(page, '#tk-hiddenbox'), /다른 사람 화면과 다른 기기에는 그대로/);
  await shot(page, 'hidden-list');
  await page.click(`#tk-hiddenbox [data-unhide="${THEIRS}"]`);
  await page.waitForFunction(id => document.querySelector(`#tk-rooms [data-room="${id}"]`), {}, THEIRS);
  await page.waitForFunction(() => document.getElementById('tk-hiddenrooms').hidden);

  // 공식 방: 숨기기 전에 한 번 묻는다. 취소하면 그대로.
  await pick(page, OFFICIAL);
  await page.waitForFunction(() => document.getElementById('tk-hideroom')?.hidden === false);
  if (await page.$eval('#tk-morebox', e => e.hidden)) await page.click('#tk-more');
  await page.click('#tk-hideroom');
  await page.waitForFunction(() => document.getElementById('askwrap').classList.contains('on'));
  assert.match(await text(page, '#ask-title'), /공식 방을 숨길까요/);
  await page.click('#ask-no');
  await new Promise(r => setTimeout(r, 300));
  assert.ok(await page.$(`#tk-rooms [data-room="${OFFICIAL}"]`), '취소했는데 숨겼다');
  await page.click('#tk-hideroom');
  await page.waitForFunction(() => document.getElementById('askwrap').classList.contains('on'));
  await page.click('#ask-yes');
  await page.waitForFunction(id => !document.querySelector(`#tk-rooms [data-room="${id}"]`), {}, OFFICIAL);
  // 되돌리기 한 줄.
  await page.click('#tk-hiddenundo');
  await page.waitForFunction(id => document.querySelector(`#tk-rooms [data-room="${id}"]`), {}, OFFICIAL);
  assert.deepEqual(page.__errors, []);
  await page.close();
});

test('영어·일본어·중국어 — 방 설정 문구가 옮겨지고 한국어가 안 남는다', async () => {
  for (const [lang, label] of [['en', 'Room settings'], ['ja', 'ルーム設定'], ['zh', '房间设置']]) {
    const page = await openTalk({ lang });
    await pick(page, MINE);
    await page.waitForFunction(() => document.getElementById('tk-room-settings')?.hidden === false);
    assert.equal(await text(page, '#tk-room-settings'), label);
    await page.click('#tk-room-settings');
    await page.waitForFunction(() => document.querySelector('#info') && !document.querySelector('#info').hidden);
    await page.click('#info-edit-name');
    const korean = await page.$eval('#info', el => {
      const out = [];
      const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      let n; while ((n = w.nextNode())) if (/[가-힯]/.test(n.nodeValue) && !n.parentElement.closest('[translate="no"]') && n.parentElement.offsetParent) out.push(n.nodeValue.trim());
      return out;
    });
    assert.deepEqual(korean, [], `${lang} 에 한국어가 남았다`);
    if (lang === 'en') await shot(page, 'sheet-en');
    await page.close();
  }
});
