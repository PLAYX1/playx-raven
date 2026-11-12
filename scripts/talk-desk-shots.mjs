// 11-12 이야기 카톡 PC 결 — 화면 찍기(사람 눈 검사용, 시험 아님). 합성 자료 · 노드·지갑·네트워크 없음.
//   RV_DIST=<dist> RV_SHOTS=<폴더> node scripts/talk-desk-shots.mjs [before]
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { mkdirSync } from 'node:fs';
import { resolve, join, extname, sep } from 'node:path';
import puppeteer from 'puppeteer-core';
import { installFixture } from './desktop-fixture.mjs';

const dist = resolve(process.env.RV_DIST || 'dist');
const SHOTS = resolve(process.env.RV_SHOTS || 'artifacts/talk-desk');
const tag = (process.argv[2] || 'after') + (process.env.RV_THEME === 'dark' ? '-dark' : '');
mkdirSync(SHOTS, { recursive: true });
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.webp': 'image/webp', '.json': 'application/json' };
const server = createServer(async (req, res) => {
  try {
    const path = resolve(dist, '.' + decodeURIComponent(new URL(req.url, 'http://x').pathname));
    if (path !== dist && !path.startsWith(dist + sep)) throw Error('path');
    const file = path === dist ? join(dist, 'index.html') : path;
    if (!(await stat(file)).isFile()) throw Error('file');
    res.writeHead(200, { 'Content-Type': types[extname(file)] || 'application/octet-stream' }); res.end(await readFile(file));
  } catch { res.writeHead(404); res.end(); }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true, args: ['--no-first-run', '--disable-background-networking'] });

const h = (c) => c.repeat(64);
const ME = h('a'), KIM = h('b'), LEE = h('c'), PARK = h('d'), ROOM = h('e');
const now = Math.floor(Date.now() / 1000);
const GROUP = 'g:0123456789abcdef0123456789abcdef';
const members = [ME, KIM, LEE].sort();
let n = 0; const id = () => String(++n).padStart(64, '0');
const m = (from, ago, text, extra = {}) => ({ id: id(), from, to: from === ME ? KIM : ME, at: now - ago, text, wrap: 'w', ...extra });
const MSGS = {
  [KIM]: [
    m(KIM, 90000, '관장님 안녕하세요'), m(KIM, 89990, '어제 수업 정말 좋았어요. 하체 연결 동작이 처음엔 어려웠는데 마지막엔 조금 감이 왔어요!'),
    m(ME, 89000, '고생 많았어요 :ravi_ok:'), m(ME, 88990, '다음 주에는 그 동작에서 이어지는 스윕까지 해 볼게요'),
    m(KIM, 3600, '관장님, 내일 수업 몇 시예요?'), m(ME, 3500, '저녁 7시예요'), m(ME, 3490, '도복은 꼭 챙겨 오세요. 띠는 제가 하나 더 가져갈게요.'),
    m(KIM, 700, '감사합니다!'), m(KIM, 690, '도복 챙겨 갈게요'), m(KIM, 600, '혹시 주차는 어디에 하면 될까요? 건물 뒤쪽에 자리가 있다고 들었는데 맞나요?'),
  ],
  [GROUP]: [
    m(LEE, 400, '주말 모임 장소 정했어요', { members, subject: '주말 모임' }), m(LEE, 395, '역 앞 카페 2층이에요', { members }),
    m(KIM, 200, '좋아요 :ravi_cheer:', { members }), m(ME, 100, '저도 갈게요', { members }),
  ],
};
const THREADS = [
  { key: GROUP, kind: 'group', members, subject: '주말 모임', last: MSGS[GROUP].at(-1), count: 4, unread: 2 },
  { key: KIM, kind: 'dm', with: KIM, last: MSGS[KIM].at(-1), count: MSGS[KIM].length, unread: 3 },
];
const NOTES = [
  { id: h('1'), pubkey: LEE, created_at: now - 3000, content: '이번 주 토요일 오픈매트 합니다', tags: [] },
  { id: h('2'), pubkey: LEE, created_at: now - 2990, content: '10시부터 12시까지요', tags: [] },
  { id: h('3'), pubkey: ME, created_at: now - 2000, content: '좋아요, 갈게요!', tags: [] },
  { id: h('4'), pubkey: PARK, created_at: now - 1000, content: '저도 참석합니다. 처음인데 괜찮을까요?', tags: [] },
];

async function open(width, height) {
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.log('pageerror', String(e)));
  await page.setViewport({ width, height });
  await page.setRequestInterception(true);
  page.on('request', (r) => ((new URL(r.url()).origin === origin && r.method() === 'GET') ? r.continue() : r.abort()));
  await page.evaluateOnNewDocument(installFixture, { theme: process.env.RV_THEME || 'light', sales: true, seller: false });
  await page.evaluateOnNewDocument((d) => {
    localStorage.setItem('rv-v2-backup-reminded', '1'); localStorage.setItem('playx-raven-lang', 'ko');
    localStorage.setItem('rv.talk.side', JSON.stringify('chats'));
    const real = window.__TAURI_INTERNALS__.invoke;
    window.__TAURI_INTERNALS__.invoke = async (cmd, args) => {
      if (cmd === 'talk_me') return { pubkey: d.ME, recoverable: true, same_as_wallet: true };
      if (cmd === 'talk_profiles') return { [d.ME]: { name: '김무송' }, [d.KIM]: { name: '김민수' }, [d.LEE]: { name: '이영희' }, [d.PARK]: { name: '박철수' } };
      if (cmd === 'talk_rooms') return [{ id: d.ROOM, name: '서울 주짓수 모임', about: '', pubkey: d.LEE }];
      if (cmd === 'talk_view') return { notes: args?.room ? structuredClone(d.NOTES) : [{ id: '9'.repeat(64), pubkey: d.LEE, created_at: d.now - 50, content: '광장 글입니다', tags: [['t', 'ravencoin']] }], gone: [], oldest: 0 };
      if (cmd === 'talk_read') return structuredClone(d.NOTES);
      if (cmd === 'talk_follows') return { ids: [d.PARK, d.KIM] };
      if (cmd === 'talk_dm_threads') return { me: d.ME, same_as_wallet: true, reached: true, threads: structuredClone(d.THREADS), rooms_last: { [d.ROOM]: { at: d.now - 1000, from: d.PARK, text: '저도 참석합니다. 처음인데 괜찮을까요?' } } };
      if (cmd === 'talk_dm_read') return { me: d.ME, same_as_wallet: true, reached: true, messages: structuredClone([...(d.MSGS[args.key] || []), ...((window.__extra || {})[args.key] || [])]) };
      if (cmd === 'talk_os_notify') return false;
      return real(cmd, args);
    };
  }, { ME, KIM, LEE, PARK, ROOM, GROUP, now, THREADS, MSGS, NOTES });
  await page.goto(origin + '/', { waitUntil: 'networkidle0' });
  await page.waitForFunction(() => document.querySelector('#page-home.on'), { timeout: 20000 });
  await page.evaluate(() => document.querySelector('nav a[data-page="talk"]').click());
  await page.waitForFunction(() => document.querySelectorAll('#tk-chats .tkc-row').length >= 3, { timeout: 15000 });
  await new Promise((r) => setTimeout(r, 400));
  return page;
}
const settle = (ms = 400) => new Promise((r) => setTimeout(r, ms));
const shot = (page, name) => page.screenshot({ path: join(SHOTS, `${tag}-${name}.png`) });

for (const [w, hh] of process.env.RV_THEME === 'dark' ? [[1440, 900]] : [[1440, 900], [1120, 780]]) {
  const page = await open(w, hh);
  await page.evaluate((k) => document.querySelector(`#tk-chats [data-chat-key="${k}"]`).click(), KIM);
  await page.waitForFunction(() => document.querySelectorAll('#tk-list .bub').length >= 10);
  await settle();
  await shot(page, `dm-${w}`);
  await page.evaluate((k) => document.querySelector(`#tk-chats [data-chat-key="${k}"]`).click(), GROUP);
  await page.waitForFunction(() => document.querySelectorAll('#tk-list .bub').length === 4);
  await settle();
  await shot(page, `group-${w}`);
  await page.evaluate((r) => document.querySelector(`#tk-chats [data-chat-room="${r}"]`).click(), ROOM);
  await page.waitForFunction(() => /서울 주짓수/.test(document.getElementById('tk-title').textContent) && document.querySelectorAll('#tk-list .bub').length >= 4, { timeout: 15000 }).catch(() => {});
  await settle(600);
  await shot(page, `room-${w}`);
  if (tag !== 'before') {
    // 말풍선 오른쪽 클릭 메뉴
    const r = await page.$$eval('#tk-list .line:not(.me) .bub', (bs) => { const b = bs[bs.length - 1]; const x = b.getBoundingClientRect(); return { x: x.left + 20, y: x.top + 10 }; });
    await page.mouse.click(r.x, r.y, { button: 'right' });
    await settle(200);
    await shot(page, `room-menu-${w}`);
    // 신고: 메뉴 맨 아래 「신고」 → 이유 고르기 창
    await page.evaluate(() => [...document.querySelectorAll('#tk-ctx button')].find((b) => /신고/.test(b.textContent))?.click());
    await settle(200);
    await page.evaluate(() => document.querySelector('#tk-report [data-rep="scam"]')?.click());
    await settle(150);
    await shot(page, `report-${w}`);
    await page.keyboard.press('Escape');
    // 1:1 다시 → Esc 로 닫기 → 빈 가운데
    await page.evaluate((k) => document.querySelector(`#tk-chats [data-chat-key="${k}"]`).click(), KIM);
    await page.waitForFunction(() => document.querySelectorAll('#tk-list .bub').length >= 10);
    await settle();
    const r2 = await page.$$eval('#tk-list .line:not(.me) .bub', (bs) => { const b = bs[bs.length - 1]; const x = b.getBoundingClientRect(); return { x: x.left + 20, y: x.top + 10 }; });
    await page.mouse.click(r2.x, r2.y, { button: 'right' });
    await settle(200);
    await shot(page, `dm-menu-${w}`);
    await page.keyboard.press('Escape');
    // 새 메시지 알약: 위로 굴린 뒤 새 말이 오면(15초마다 다시 읽기)
    await page.evaluate(() => { const l = document.getElementById('tk-list'); l.scrollTop = 0; });
    await page.evaluate((d) => { const t = Math.floor(Date.now() / 1000); window.__extra = { [d.KIM]: [{ id: 'x1'.padEnd(64, '0'), from: d.KIM, to: d.ME, at: t, text: '관장님 혹시 보셨어요?', wrap: 'w' }, { id: 'x2'.padEnd(64, '0'), from: d.KIM, to: d.ME, at: t + 1, text: '주차 자리요!', wrap: 'w' }] }; }, { KIM, ME });
    await page.waitForFunction(() => !document.getElementById('tk-new-messages').hidden, { timeout: 40000 }).catch(() => console.log('알약 안 뜸'));
    await page.evaluate(() => { document.getElementById('tk-text').value = '네 알겠습니다'; document.getElementById('tk-text').dispatchEvent(new Event('input')); });
    await settle(500);
    await shot(page, `dm-typing-${w}`);
    await page.evaluate(() => { const t = document.getElementById('tk-text'); t.value = ''; t.dispatchEvent(new Event('input')); document.getElementById('tk-text').blur(); });
    await page.keyboard.down(process.platform === 'darwin' ? 'Meta' : 'Control'); await page.keyboard.press('KeyF'); await page.keyboard.up(process.platform === 'darwin' ? 'Meta' : 'Control');
    await page.keyboard.type('주말');
    await settle(200);
    await shot(page, `filter-${w}`);
    await page.keyboard.press('Escape'); await page.keyboard.press('Escape');
    await page.evaluate(() => document.getElementById('tk-text').focus());
    await page.keyboard.press('Escape');
    await settle(300);
    await shot(page, `idle-${w}`);
    await page.click('#tk-side-friends');
    await settle(500);
    await shot(page, `friends-${w}`);
    await page.click('#tk-side-square');
    await settle(800);
    await shot(page, `square-${w}`);
  }
  await page.close();
}
await browser.close(); server.close();
console.log('shots →', SHOTS);
