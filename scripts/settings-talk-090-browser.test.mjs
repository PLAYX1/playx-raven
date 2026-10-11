// 0.9.0 레인A — 설정 B(왼쪽 목록 + 한 주제)·이야기 이름표 시험. 실제 Chrome, 빌드된 dist, 합성 자료(desktop-fixture).
// 노드·지갑·네트워크·Tauri 없음. talk_profile_set 은 가짜(성공=서명 이벤트 id, 실패=오류, 확인 불가=null).
//   node --test scripts/settings-talk-090-browser.test.mjs      (RV_DIST=<dist> 면 그 dist 를 쓴다)
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve, join, extname, sep } from 'node:path';
import { tmpdir } from 'node:os';
import puppeteer from 'puppeteer-core';
import { installFixture } from './desktop-fixture.mjs';

const root = resolve(import.meta.dirname, '..');
let work, dist, server, origin, browser;
before(async () => {
  work = mkdtempSync(join(tmpdir(), 'rv-090-ui-'));
  if (process.env.RV_DIST && existsSync(join(process.env.RV_DIST, 'index.html'))) dist = process.env.RV_DIST;
  else {
    dist = join(work, 'dist');
    execFileSync(process.execPath, [resolve(root, 'node_modules/vite/bin/vite.js'), 'build', '--outDir', dist, '--emptyOutDir', '--logLevel', 'error'], { cwd: root, stdio: ['ignore', 'ignore', 'inherit'] });
  }
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

const ME = 'public-home-fixture';
const now = 1791500400;
const talk = (profiles) => ({
  talk_me: { pubkey: ME, recoverable: true },
  talk_profiles: profiles,
  talk_rooms: [],
  talk_read: [
    { id: 'm1', pubkey: 'pk-kim', created_at: now - 3000, content: '안녕하세요' },
    { id: 'm2', pubkey: ME, created_at: now - 2600, content: '네, 오세요.' },
    { id: 'm3', pubkey: ME, created_at: now - 2590, content: '도복은 빌려 드려요.' },
  ],
});

/** save: 'ok' | 'throw' | 'null' — talk_profile_set 의 가짜 답. profiles: 'throw' 면 릴레이에서 이름표를 못 읽음. */
async function open({ width = 1440, height = 900, profiles = {}, save = 'ok', lang = 'ko', keep = {} } = {}) {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.setViewport({ width, height });
  await page.setRequestInterception(true);
  page.on('request', (r) => ((new URL(r.url()).origin === origin && r.method() === 'GET') ? r.continue() : r.abort()));
  await page.evaluateOnNewDocument(installFixture, { theme: 'light', sales: true, seller: false });
  await page.evaluateOnNewDocument((extra, save, profilesThrow, lang, keep) => {
    localStorage.setItem('rv-v2-backup-reminded', '1'); localStorage.setItem('playx-raven-lang', lang);
    // ⚠️ desktop-fixture 는 문서(iframe 포함)마다 localStorage 를 비운다 — 그래서 심을 값도 문서마다 다시 심는다.
    for (const [k, v] of Object.entries(keep)) localStorage.setItem(k, v);
    // 앱이 지운 열쇠를 적어 둔다(맨 위 창만) — 「옛 rv-profile-color 를 지운다」를 저장소 상태가 아니라 지운 행동으로 본다.
    if (window.top === window) { window.__removed = []; const rm = Storage.prototype.removeItem; Storage.prototype.removeItem = function (k) { window.__removed.push(k); return rm.call(this, k); }; }
    window.__saves = [];
    const real = window.__TAURI_INTERNALS__.invoke;
    window.__TAURI_INTERNALS__.invoke = async (cmd, args) => {
      if (cmd === 'talk_profiles' && profilesThrow) throw 'relay down';
      if (cmd === 'talk_profile_set') {
        window.__saves.push(args.name);
        if (save === 'throw') throw '4곳 모두 받지 않았습니다. 인터넷이 되는지 확인해 주세요. 마지막 이유: synthetic';
        if (save === 'null') return null;
        // 러스트처럼 서명한 이름표 그대로(내용에 실제로 들어간 이름). 'mismatch' 는 다른 이름이 들어간 경우.
        const name = save === 'mismatch' ? '다른 이름' : String(args.name).trim();
        return { id: 'synthetic-event-id', pubkey: 'public-home-fixture', kind: 0, content: JSON.stringify({ name, about: args.about ?? '', picture: '' }) };
      }
      return Object.hasOwn(extra, cmd) ? structuredClone(extra[cmd]) : real(cmd, args);
    };
  }, talk(profiles === 'throw' ? {} : profiles), save, profiles === 'throw', lang, keep);
  await page.goto(origin + '/', { waitUntil: 'networkidle0' });
  await page.waitForFunction(() => document.querySelector('#page-home.on') && document.querySelector('#page-settings .sx')?.classList.contains('sx-b'), { timeout: 20000 });
  return { page, errors };
}
const go = (page, name) => page.evaluate((n) => document.querySelector(`nav a[data-page="${n}"]`).click(), name);
const visiblePanes = (page) => page.$$eval('#page-settings section[data-sx-pane]', (s) => s.filter((x) => !x.hidden && x.checkVisibility()).map((x) => x.dataset.sxPane));
const settle = (ms = 300) => new Promise((r) => setTimeout(r, ms));

test('설정 B: 주제 여덟 개 · 한 번에 한 주제 · 누른 주제 표시 · 기존 id 그대로', async () => {
  const { page, errors } = await open();
  try {
    await go(page, 'settings'); await settle();
    const topics = await page.$$eval('.sx-list .sx-it', (b) => b.map((x) => x.dataset.sxGo));
    assert.deepEqual(topics, ['general', 'alerts', 'backup', 'identity', 'shop', 'ravi', 'about', 'advanced']);
    assert.deepEqual(await visiblePanes(page), ['general']);
    for (const t of topics) {
      await page.click(`.sx-list .sx-it[data-sx-go="${t}"]`); await settle(120);
      assert.deepEqual(await visiblePanes(page), [t], `주제 ${t}`);
      assert.equal(await page.$eval(`.sx-list .sx-it[data-sx-go="${t}"]`, (b) => b.getAttribute('aria-current')), 'true');
    }
    // 「고급」은 들어오면 접힌 상자를 열어 둔다.
    assert.equal(await page.$eval('#page-settings details.advanced', (d) => d.open), true);
    // 다른 파일이 붙이는 칸이 제 주제로 옮겨졌다.
    const where = await page.evaluate(() => Object.fromEntries(['display-mode-card', 'ravi-agent-settings', 'companion-preferences', 'rvp-card', 'firstrun-setup', 'seller-mode', 'easy-setup', 'bk-go', 'sec-node', 'about-notice', 'ravi-voice-revoke', 'mn-gpu', 'key-note']
      .map((id) => [id, document.getElementById(id)?.closest('section[data-sx-pane]')?.dataset.sxPane || null])));
    assert.deepEqual(where, { 'display-mode-card': 'general', 'ravi-agent-settings': 'ravi', 'companion-preferences': 'ravi', 'rvp-card': 'identity', 'firstrun-setup': 'general', 'seller-mode': 'general', 'easy-setup': 'general', 'bk-go': 'backup', 'sec-node': 'shop', 'about-notice': 'about', 'ravi-voice-revoke': 'ravi', 'mn-gpu': 'advanced', 'key-note': 'advanced' });
    // 한 주제에 주황 주 단추는 하나뿐(백업 = 백업 만들기).
    await page.click('.sx-list .sx-it[data-sx-go="backup"]'); await settle(120);
    const orange = await page.$$eval('#page-settings button', (b) => b.filter((x) => x.checkVisibility() && getComputedStyle(x).backgroundColor === 'rgb(180, 83, 28)').map((x) => x.id));
    assert.deepEqual(orange, ['bk-go']);
    // 키보드 ↓ 로 다음 주제.
    await page.focus('.sx-list .sx-it[data-sx-go="backup"]'); await page.keyboard.press('ArrowDown'); await settle(120);
    assert.deepEqual(await visiblePanes(page), ['identity']);
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

test('설정 B: 찾기 — 주제를 거르고 Enter 는 맞는 칸으로 · 없으면 「찾는 설정이 없어요」', async () => {
  const { page } = await open();
  try {
    await go(page, 'settings'); await settle();
    await page.type('#sx-search', '대화 알림'); await settle(150);
    const shown = await page.$$eval('.sx-list .sx-it', (b) => b.filter((x) => !x.parentElement.hidden).map((x) => x.dataset.sxGo));
    assert.ok(shown.includes('alerts') && !shown.includes('advanced'), shown.join(','));
    assert.deepEqual(await visiblePanes(page), ['alerts'], '찾은 첫 주제로 넘어간다');
    await page.keyboard.press('Enter'); await settle(200);
    assert.ok(await page.$eval('#tksnd-card', (c) => c.checkVisibility()));
    // 포커스도 찾은 칸으로 간다(찾기 칸에 남지 않는다).
    assert.ok(await page.evaluate(() => document.activeElement?.id !== 'sx-search' && !!document.activeElement?.closest('section[data-sx-pane="alerts"]')));
    await page.$eval('#sx-search', (i) => { i.value = ''; }); await page.type('#sx-search', 'zzzz없는말'); await settle(150);
    assert.equal(await page.$eval('#sx-none', (p) => p.hidden), false);
    assert.equal(await page.$eval('#sx-none', (p) => p.parentElement.getAttribute('role')), 'status', '알림 자리는 늘 있고 글만 나타난다');
    await page.keyboard.press('Escape'); await settle(100);
    assert.equal(await page.$eval('#sx-none', (p) => p.hidden), true);
    assert.equal((await page.$$eval('.sx-list .sx-it', (b) => b.filter((x) => !x.parentElement.hidden))).length, 8);
  } finally { await page.close(); }
});

test('설정 B: 바로 가기 — 다른 화면에서 숨은 주제 속 칸으로 가면 그 주제가 열린다', async () => {
  const { page } = await open();
  try {
    await go(page, 'settings'); await settle();
    // 라비 안내 사전(page:"settings", el:"bk-go")·pageTiles jump·사이드바 표시등(#sec-node)·새 버전(#up-box)·폰 연결(#rvp-card)·채굴(#mn-gpu)
    for (const [id, pane] of [['bk-go', 'backup'], ['sec-node', 'shop'], ['up-check', 'about'], ['rvp-card', 'identity'], ['mn-gpu', 'advanced'], ['key-note', 'advanced'], ['easy-setup', 'general'], ['snd-on', 'alerts']]) {
      await page.click('.sx-list .sx-it[data-sx-go="ravi"]'); await settle(80);
      await page.evaluate((id) => { const el = document.getElementById(id); for (let u = el; u; u = u.parentElement) if (u instanceof HTMLDetailsElement) u.open = true; el.scrollIntoView({ block: 'center' }); }, id);
      await settle(80);
      assert.deepEqual(await visiblePanes(page), [pane], id);
    }
    // 이야기 → 「친구 추가」 → 설정의 폰 연결 칸(내 이름과 열쇠).
    await page.click('.sx-list .sx-it[data-sx-go="alerts"]');
    await go(page, 'talk'); await settle(400);
    await page.evaluate(() => document.getElementById('rv-add-friend').click()); await settle(300);
    assert.equal(await page.$eval('#page-settings', (p) => p.classList.contains('on')), true);
    assert.deepEqual(await visiblePanes(page), ['identity']);
    // 설정 「이야기에서 쓰는 이름」 → 내 소개.
    await page.evaluate(() => document.getElementById('sx-talkname').click()); await settle(300);
    assert.equal(await page.$eval('#page-profile', (p) => p.classList.contains('on')), true);
  } finally { await page.close(); }
});

test('이야기: 내 글에도 내 이름 · 「나」 · 라비 아이콘(이어 쓴 글은 생략) · 이름 카드는 안 뜬다', async () => {
  const { page } = await open({ profiles: { [ME]: { name: '김무송' }, 'pk-kim': { name: '김민수' } } });
  try {
    await go(page, 'talk');
    await page.waitForFunction(() => document.querySelector('#tk-list .who.me'));
    const heads = await page.$$eval('#tk-list .who.me', (w) => w.map((x) => ({ text: x.textContent.replace(/\s+/g, ' ').trim(), face: !!x.querySelector('.rv-myface img') })));
    assert.equal(heads.length, 1, '이어 쓴 두 번째 글에는 머리가 없다');
    assert.match(heads[0].text, /김무송\s*·\s*나/);
    assert.equal(heads[0].face, true);
    assert.equal(await page.$eval('#tk-namecard', (c) => c.hidden), true);
    assert.equal(await page.$eval('#sx-talkname-v', (v) => v.textContent), '김무송');
  } finally { await page.close(); }
});

test('이야기 첫 진입: 이름 카드 → 저장 성공은 확인된 뒤에만 「저장했어요」 + 내 글 머리에 새 이름', async () => {
  const { page } = await open({ profiles: { 'pk-kim': { name: '김민수' } }, save: 'ok' });
  try {
    await go(page, 'talk');
    await page.waitForFunction(() => !document.getElementById('tk-namecard').hidden);
    assert.equal(await page.$eval('#tk-first', (f) => f.hidden), true, '규칙 띠는 카드와 겹치지 않는다');
    assert.equal(await page.$$eval('#tk-namecard .tk-rules li', (l) => l.length), 3);
    await page.type('#tk-nc-name', '동네 꽃집');
    await page.click('#tk-nc-save');
    await page.waitForFunction(() => document.getElementById('tk-nc-msg').classList.contains('ok'));
    assert.match(await page.$eval('#tk-nc-msg', (m) => m.textContent), /이름을 저장했어요.*동네 꽃집/);
    assert.deepEqual(await page.evaluate(() => window.__saves), ['동네 꽃집']);
    await page.waitForFunction(() => /동네 꽃집/.test(document.querySelector('#tk-list .who.me')?.textContent || ''));
  } finally { await page.close(); }
});

test('이야기 첫 진입: 저장 실패(릴레이 거절)와 결과 확인 불가(null)는 실패로 적고 카드를 닫지 않는다', async () => {
  for (const save of ['throw', 'null']) {
    const { page } = await open({ profiles: {}, save });
    try {
      await go(page, 'talk');
      await page.waitForFunction(() => !document.getElementById('tk-namecard').hidden);
      // 빈 이름은 보내지 않는다.
      await page.click('#tk-nc-save');
      await page.waitForFunction(() => document.getElementById('tk-nc-msg').classList.contains('bad'));
      assert.deepEqual(await page.evaluate(() => window.__saves), []);
      await page.type('#tk-nc-name', '동네 꽃집');
      await page.click('#tk-nc-save');
      await page.waitForFunction(() => window.__saves.length === 1 && document.getElementById('tk-nc-msg').classList.contains('bad') && !document.getElementById('tk-nc-save').disabled);
      const msg = await page.$eval('#tk-nc-msg', (m) => ({ text: m.textContent, role: m.getAttribute('role') }));
      assert.equal(msg.role, 'alert');
      assert.match(msg.text, save === 'throw' ? /이름을 저장하지 못했어요.*모두 받지 않았습니다/ : /이름을 저장하지 못했어요.*확인하지 못했어요/);
      assert.equal(await page.$eval('#tk-namecard', (c) => c.hidden), false);
      assert.equal(await page.$eval('#tk-nc-save', (b) => b.hidden), false);
      assert.equal(await page.$('#tk-list .who.me span[translate="no"]'), null, '저장 안 된 이름을 내 글에 달지 않는다');
    } finally { await page.close(); }
  }
});

test('이야기 첫 진입: 「나중에 할게요」는 다시 안 뜨고, 이름표를 못 읽었으면(릴레이 끊김) 카드를 띄우지 않는다', async () => {
  let { page } = await open({ profiles: {} });
  try {
    await go(page, 'talk');
    await page.waitForFunction(() => !document.getElementById('tk-namecard').hidden);
    await page.click('#tk-nc-later');
    assert.equal(await page.$eval('#tk-namecard', (c) => c.hidden), true);
    assert.equal(await page.evaluate(() => localStorage.getItem('rv-talk-name-later')), '1');
  } finally { await page.close(); }
  ({ page } = await open({ profiles: {}, keep: { 'rv-talk-name-later': '1' } }));
  try { await go(page, 'talk'); await settle(1200); assert.equal(await page.$eval('#tk-namecard', (c) => c.hidden), true); } finally { await page.close(); }
  ({ page } = await open({ profiles: 'throw' }));
  try { await go(page, 'talk'); await settle(1200); assert.equal(await page.$eval('#tk-namecard', (c) => c.hidden), true); } finally { await page.close(); }
});

test('내 소개: 「내 색」 없음 · 같은 이름표 안내 · 저장 실패를 그대로 적는다 · 옛 rv-profile-color 지움', async () => {
  const { page } = await open({ profiles: {}, save: 'null', keep: { 'rv-profile-color': '#ff0000' } });
  try {
    await go(page, 'profile'); await settle(500);
    assert.equal(await page.$('#rv-profile-color'), null);
    assert.match(await page.$eval('#page-profile', (p) => p.textContent), /「이야기」에서 보이는 이름과 같은 이름표/);
    assert.ok((await page.evaluate(() => window.__removed)).includes('rv-profile-color'), '옛 「내 색」 저장값을 지운다');
    await page.type('#rv-profile-name', '동네 꽃집');
    await page.click('#rv-profile-save');
    await page.waitForFunction(() => document.getElementById('rv-profile-note').textContent);
    assert.equal(await page.$eval('#rv-profile-note', (n) => n.className), 'danger');
    assert.doesNotMatch(await page.$eval('#rv-profile-note', (n) => n.textContent), /저장했습니다/);
  } finally { await page.close(); }
});

test('이름 저장: 서명된 이름표의 이름이 입력과 다르면 「저장했습니다」라고 하지 않는다', async () => {
  const { page } = await open({ profiles: {}, save: 'mismatch' });
  try {
    await go(page, 'profile'); await settle(500);
    await page.type('#rv-profile-name', '동네 꽃집');
    await page.click('#rv-profile-save');
    await page.waitForFunction(() => document.getElementById('rv-profile-note').textContent);
    assert.equal(await page.$eval('#rv-profile-note', (n) => n.className), 'danger');
    assert.doesNotMatch(await page.$eval('#rv-profile-note', (n) => n.textContent), /저장했습니다/);
  } finally { await page.close(); }
});

test('영어 화면: 새 설정 목록·이름 카드에 한국어가 남지 않는다', async () => {
  const { page } = await open({ lang: 'en', profiles: {} });
  try {
    await go(page, 'settings'); await settle(500);
    const hangul = await page.$$eval('.sx-list *, #page-settings .sx-ptitle, #page-settings .sx-lede', (els) => els.filter((e) => [...e.childNodes].some((n) => n.nodeType === 3 && /[가-힣]/.test(n.textContent)) && !e.closest('[translate="no"]')).map((e) => e.textContent.trim()));
    assert.deepEqual(hangul, []);
    assert.equal(await page.$eval('#sx-search', (i) => i.placeholder), 'Search settings');
    await go(page, 'talk');
    await page.waitForFunction(() => !document.getElementById('tk-namecard').hidden);
    assert.doesNotMatch(await page.$eval('#tk-namecard', (c) => c.innerText), /[가-힣]/);
  } finally { await page.close(); }
});
