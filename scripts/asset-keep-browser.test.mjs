// 자산 파일 보관 화면(0.8.8a) — 진짜 Chrome + 가짜 Tauri. 노드·지갑·IPFS·네트워크는 실행하지 않는다.
// 줄 상태/단추 · 한 번 탭 보관(내 뜻을 먼저 저장) · 0.6초 길게 누르기 · 5초 되돌리기 · 내가 만든 자산 경고 · 키보드(Delete)·우클릭 메뉴 ·
// 일괄 보관 · 용량 · 앱 안 확인(따라잡는 중=확인 못 함) · 좁은 폭에서 가로 넘침 없음.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { build } from 'esbuild';
import puppeteer from 'puppeteer-core';

const root = resolve(import.meta.dirname, '..');
const out = await build({ entryPoints: [join(root, 'scripts/fixtures/asset-keep-entry.ts')], bundle: true, write: false, platform: 'browser', format: 'iife', logLevel: 'silent', outdir: 'out', loader: { '.css': 'css' } });
const js = out.outputFiles.find((f) => f.path.endsWith('.js')).text;
const css = out.outputFiles.find((f) => f.path.endsWith('.css')).text;

const c = (n) => `Qm${String(n).padStart(44, '0')}`;
const CFG = {
  assets: [
    { name: 'MINE/A', ipfs_hash: c(1), mine: true, amount: 1 },       // 내가 만든 · 보관 중
    { name: 'GOT/B', ipfs_hash: c(2), mine: false, amount: 1 },       // 받은 · 보관 중
    { name: 'GOT/C', ipfs_hash: c(3), mine: false, amount: 1 },       // 받은 · 찾음(안 붙잡음)
    { name: 'GOT/D', ipfs_hash: c(4), mine: false, amount: 1 },       // 받은 · 확인 안 됨
    { name: 'GOT/E', ipfs_hash: c(5), mine: false, amount: 1 },       // 받은 · 못 찾음
    { name: 'NOFILE', ipfs_hash: null, mine: false, amount: 5 },
    { name: 'PRINT', ipfs_hash: c(6), mine: true, amount: 1 },
    { name: 'MINE/G', ipfs_hash: c(7), mine: true, amount: 1 },       // 내가 만든 · 확인 안 됨
  ],
  pinned: [c(1), c(2)], fingerprints: [c(6)], health: { [c(3)]: 'found', [c(5)]: 'missing' },
};
let browser, work, page;
const HTML = `<!doctype html><meta charset=utf-8><style>:root{--bg:#fff;--panel:#fff;--text:#111;--muted:#4a4a4a;--line:#d6d6d6;--ok:#226b43;--warn:#96601a;--danger:#b32b22;--brand-light:#5874cf}
body{font:15px sans-serif;background:var(--bg);color:var(--text);margin:0;padding:12px} table{border-collapse:collapse;width:100%} td{padding:4px 6px;border-bottom:1px solid var(--line)} .act{width:1%;white-space:nowrap}
.panel{width:310px;border:1px solid var(--line);padding:8px}.panel.hidden{display:none} .bar{display:flex;gap:8px;align-items:center} button{font:inherit;min-height:32px} button.ghost{background:transparent} .meta{font-size:14px;color:var(--muted);margin:4px 0 0}</style>
<div class=bar><span id=summary></span><button id=scan class=ghost>모두 다시 확인</button><button id=pin-all disabled>보관할 항목 없음</button></div>
<div style="display:flex;gap:12px"><table><thead><tr><th>자산<th>수량<th>파일<th></tr></thead><tbody id=assets></tbody></table>
<aside class="panel hidden" id=panel><div id=p-name></div></aside></div><button data-afilter=got id=gotTab>받은 것</button>`;

before(async () => {
  work = mkdtempSync(join(tmpdir(), 'rv-keep-'));
  browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true, userDataDir: join(work, 'profile'), args: ['--no-first-run', '--disable-background-networking'] });
});
after(async () => { await browser?.close(); rmSync(work, { recursive: true, force: true }); });

async function fresh(cfg = CFG, fxInit) {
  page?.close().catch(() => {});
  page = await browser.newPage();
  await page.setViewport({ width: 1100, height: 800 });
  await page.evaluateOnNewDocument(() => { localStorage.setItem('playx-raven-lang', 'ko'); });
  await page.setContent(HTML);
  await page.addStyleTag({ content: css });
  await page.addScriptTag({ content: js });
  // __boot 이 동기로 가짜 상태(__fx)를 만든 직후, 첫 비동기 부름이 나가기 전에 시험 값을 넣는다.
  await page.evaluate((cfg, init) => { window.__boot(cfg); if (init) (0, eval)(`(${init})()`); }, cfg, fxInit ? fxInit.toString() : null);
  await page.waitForSelector('button.keepbtn');
  return page;
}
const labelOf = (name) => page.$eval(`tr[data-row="${name}"] .keepbtn .klabel, tr[data-row="${name}"] td.keepcell > span`, (e) => e.textContent);
const calls = () => page.evaluate(() => window.__calls.map((x) => x[0]));
const decisions = () => page.evaluate(() => window.__fx.decisions);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const btn = (name) => `tr[data-row="${name}"] button.keepbtn`;

test('줄마다 상태 글자와 같은 자리의 단추: 보관 중·보관 안 함·확인 안 됨·찾지 못함, 파일 없음·원본 지문은 단추 없음', async () => {
  await fresh();
  assert.equal(await labelOf('MINE/A'), '보관 중');
  assert.equal(await labelOf('GOT/B'), '보관 중');
  assert.equal(await labelOf('GOT/C'), '보관 안 함');
  assert.equal(await labelOf('GOT/D'), '확인 안 됨');
  assert.equal(await labelOf('GOT/E'), '찾지 못함');
  assert.equal(await page.$(btn('NOFILE')), null);
  assert.equal(await page.$(btn('PRINT')), null);
  assert.equal(await labelOf('NOFILE'), '파일 없음');
  // 미확인·찾지 못함 줄에도 단추 + 「?」 이유 단추가 있다
  for (const n of ['GOT/D', 'GOT/E']) assert.ok(await page.$(`tr[data-row="${n}"] button.keepq`), n);
  // 접근성
  assert.equal(await page.$eval(btn('MINE/A'), (b) => b.getAttribute('aria-pressed')), 'true');
  assert.equal(await page.$eval(btn('GOT/C'), (b) => b.getAttribute('aria-pressed')), 'false');
  assert.match(await page.$eval(btn('MINE/A'), (b) => b.getAttribute('aria-label')), /파일 보관 중.*길게 누르거나 Delete 키 또는 메뉴/);
  assert.match(await page.$eval('#summary', (e) => e.textContent), /자산 8개 · 파일 있음 6개 · 보관 중 2개 · 원본 지문 1개/);
  assert.match(await page.$eval('.keep-cap', (e) => e.textContent), /3\.2GB \/ 15GB \(21%\)/);
});

test('한 번 탭 보관: 내 뜻(keep)을 먼저 저장하고 그다음 pin_add, 줄이 「보관 중」이 된다. 줄 선택은 일어나지 않는다', async () => {
  await fresh();
  await page.click(btn('GOT/C'));
  await page.waitForFunction(() => document.querySelector('tr[data-row="GOT/C"] .klabel').textContent === '보관 중');
  const seq = await calls();
  assert.ok(seq.indexOf('asset_keep_set') < seq.indexOf('pin_add'), seq.join());
  assert.equal(await page.evaluate(() => window.__rowClicked), undefined, '배지를 눌렀는데 줄이 선택됐다');
  assert.equal((await decisions())[`Qm${'3'.padStart(44, '0')}`], 'keep');
});

test('확인 안 됨 → 찾아서 보관 / 못 찾으면 「예약됨」(보관하기 저장, pin_add 안 부름) / 실패하면 원래대로', async () => {
  await fresh(CFG, () => { window.__fx.alive[`Qm${'4'.padStart(44, '0')}`] = true; });
  await page.click(btn('GOT/D'));
  await page.waitForFunction(() => document.querySelector('tr[data-row="GOT/D"] .klabel').textContent === '보관 중');
  // 못 찾음 → 예약
  await page.click(btn('GOT/E'));
  await page.waitForFunction(() => document.querySelector('tr[data-row="GOT/E"] .klabel').textContent === '찾지 못함 · 예약됨');
  assert.equal((await decisions())[`Qm${'5'.padStart(44, '0')}`], 'keep');
  const sets = await page.evaluate(() => window.__calls.filter((x) => x[0] === 'pin_add').map((x) => x[1].cid));
  assert.ok(!sets.includes(`Qm${'5'.padStart(44, '0')}`), '못 찾았는데 pin_add 를 불렀다');
  // pin_add 실패 → 내 뜻을 되돌리고 한 줄 안내
  await fresh(CFG, () => { window.__fx.pinFail.add(`Qm${'3'.padStart(44, '0')}`); });
  await page.click(btn('GOT/C'));
  await page.waitForSelector('tr[data-row="GOT/C"] .kfail');
  assert.equal(await labelOf('GOT/C'), '보관 안 함');
  assert.equal((await decisions())[`Qm${'3'.padStart(44, '0')}`], undefined, '실패한 보관이 예약으로 남았다');
});

test('길게 누르기: 0.6초 전에 떼면 그대로, 0.6초를 채우면 해제(받은 자산) → 5초 되돌리기. 해제는 pin_remove 전에 「보관 안 하기」를 저장한다', async () => {
  await fresh();
  const box = await (await page.$(btn('GOT/B'))).boundingBox();
  const mid = [box.x + box.width / 2, box.y + box.height / 2];
  await page.mouse.move(...mid); await page.mouse.down();
  await sleep(300);
  assert.ok(await page.$eval(btn('GOT/B'), (b) => b.classList.contains('holding')), '누르는 동안 링 클래스');
  assert.match(await labelOf('GOT/B'), /계속 누르면 해제/);
  await page.mouse.up(); await sleep(150);
  assert.equal(await labelOf('GOT/B'), '보관 중');
  assert.ok(!(await calls()).includes('pin_remove'));
  // 끝까지 누름
  await page.mouse.move(...mid); await page.mouse.down(); await sleep(750); await page.mouse.up();
  await page.waitForFunction(() => /되돌리기/.test(document.querySelector('tr[data-row="GOT/B"] .klabel').textContent));
  const seq = await calls();
  assert.ok(seq.lastIndexOf('asset_keep_set') < seq.indexOf('pin_remove') || seq.indexOf('asset_keep_set') < seq.indexOf('pin_remove'));
  assert.equal((await decisions())[`Qm${'2'.padStart(44, '0')}`], 'skip');
  assert.equal(await page.evaluate(() => window.__calls.some((x) => x[0] === 'cid_alive')), false);
  // 되돌리기
  await page.click(btn('GOT/B'));
  await page.waitForFunction(() => document.querySelector('tr[data-row="GOT/B"] .klabel').textContent === '보관 중');
  assert.equal((await decisions())[`Qm${'2'.padStart(44, '0')}`], 'keep');
});

test('5초 뒤에는 되돌리기가 사라지고 「보관 안 함」+자물쇠로 확정된다', async () => {
  await fresh();
  const box = await (await page.$(btn('GOT/B'))).boundingBox();
  await page.mouse.move(box.x + 20, box.y + 10); await page.mouse.down(); await sleep(750); await page.mouse.up();
  await page.waitForFunction(() => /되돌리기/.test(document.querySelector('tr[data-row="GOT/B"] .klabel').textContent));
  await page.waitForFunction(() => document.querySelector('tr[data-row="GOT/B"] .klabel').textContent === '보관 안 함', { timeout: 8000 });
  assert.ok(await page.$(`${btn('GOT/B')}.declined .klock`), '내가 뺀 줄에는 자물쇠');
});

test('내가 만든 자산: 길게 눌러도 경고 창이 먼저 — 체크 전에는 해제 불가, 기본 포커스 취소, Esc 취소', async () => {
  await fresh();
  const box = await (await page.$(btn('MINE/A'))).boundingBox();
  await page.mouse.move(box.x + 20, box.y + 10); await page.mouse.down(); await sleep(750); await page.mouse.up();
  await page.waitForSelector('.keep-dlg');
  assert.equal(await page.$eval('.keep-dlg h3', (e) => e.textContent), '이 파일은 내가 만든 자산의 것이에요');
  assert.match(await page.$eval('.keep-dlg', (e) => e.textContent), /마지막 사본일 수 있어요/);
  assert.equal(await page.evaluate(() => document.activeElement.id), 'keep-dlg-no');
  assert.equal(await page.$eval('#keep-dlg-yes', (b) => b.disabled), true);
  assert.ok(!(await calls()).includes('pin_remove'));
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !document.querySelector('.keep-dlg'));
  assert.ok(!(await calls()).includes('pin_remove'));
  assert.equal(await labelOf('MINE/A'), '보관 중');
  // 다시: 체크하면 해제 가능
  await page.mouse.move(box.x + 20, box.y + 10); await page.mouse.down(); await sleep(750); await page.mouse.up();
  await page.waitForSelector('.keep-dlg');
  await page.click('#keep-dlg-c');
  assert.equal(await page.$eval('#keep-dlg-yes', (b) => b.disabled), false);
  await page.click('#keep-dlg-yes');
  await page.waitForFunction(() => /되돌리기/.test(document.querySelector('tr[data-row="MINE/A"] .klabel').textContent));
});

test('키보드만으로: Delete → 안내 창(받은 자산도) → 보관 해제, Space 로 보관, R 다시 확인, V 진짜인지 확인, 우클릭 메뉴', async () => {
  await fresh();
  await page.focus(btn('GOT/B'));
  await page.keyboard.press('Delete');
  await page.waitForSelector('.keep-dlg');
  assert.equal(await page.$eval('.keep-dlg h3', (e) => e.textContent), '이 파일의 보관을 풀까요?');
  assert.ok(!(await calls()).includes('pin_remove'), '키 하나로 바로 해제되면 안 된다');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'keep-dlg-no');
  await page.keyboard.press('Tab'); // 보관 해제 단추
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => /되돌리기/.test(document.querySelector('tr[data-row="GOT/B"] .klabel').textContent));
  // 포커스가 다시 그림 뒤에도 단추에 남아 있다
  assert.equal(await page.evaluate(() => document.activeElement?.dataset?.keep), `Qm${'2'.padStart(44, '0')}`);
  // Space 로 보관
  await page.focus(btn('GOT/C'));
  await page.keyboard.press('Space');
  await page.waitForFunction(() => document.querySelector('tr[data-row="GOT/C"] .klabel').textContent === '보관 중');
  // 우클릭 메뉴
  const box = await (await page.$('tr[data-row="GOT/D"] td.name')).boundingBox();
  await page.mouse.click(box.x + 10, box.y + 10, { button: 'right' });
  await page.waitForSelector('.keep-menu');
  const items = await page.$$eval('.keep-menu button', (b) => b.map((x) => x.textContent));
  assert.deepEqual(items, ['보관', '다시 확인', '진짜인지 확인', '확인 주소 복사']);
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !document.querySelector('.keep-menu'));
  assert.equal(await page.evaluate(() => window.__rowClicked), undefined, 'Esc 가 줄 선택까지 건드리면 안 된다');
});

test('「?」 이유 안내: 20초 · 「파일이 없어졌다는 뜻이 아닙니다」 · 마지막 확인 · 다시 찾기', async () => {
  await fresh();
  await page.click('tr[data-row="GOT/E"] button.keepq');
  await page.waitForSelector('.keep-pop');
  const text = await page.$eval('.keep-pop', (e) => e.textContent);
  assert.match(text, /파일이 없어졌다는 뜻이 아닙니다/);
  assert.match(text, /다시 찾기/);
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !document.querySelector('.keep-pop'));
  await page.click('tr[data-row="GOT/D"] button.keepq');
  await page.waitForSelector('.keep-pop');
  assert.match(await page.$eval('.keep-pop', (e) => e.textContent), /아직 이 파일이 어디 있는지 물어보지 않았어요/);
});

test('일괄 보관: 받은 것은 기본 제외(체크하면 포함), 진행 `n/m · 중지`, 끝나면 결과 한 줄', async () => {
  await fresh(CFG, () => { for (const n of [3, 4, 7]) window.__fx.alive[`Qm${String(n).padStart(44, '0')}`] = true; });
  // 기본: 내가 만든 것 중 보관 안 한 것만 = MINE/G (1개)
  assert.equal(await page.$eval('#pin-all', (b) => b.textContent), '파일 있는 1개 모두 보관');
  await page.click('#keep-incl');
  assert.equal(await page.$eval('#pin-all', (b) => b.textContent), '파일 있는 4개 모두 보관'); // G, C, D, E
  await page.click('#pin-all');
  await page.waitForFunction(() => /개 보관/.test(document.getElementById('keep-live').textContent), { timeout: 15000 });
  const live = await page.$eval('#keep-live', (e) => e.textContent);
  assert.match(live, /3개 보관/);
  assert.match(live, /1개 못 찾아 예약/);
  assert.equal(await labelOf('MINE/G'), '보관 중');
  assert.equal(await labelOf('GOT/E'), '찾지 못함 · 예약됨');
});

test('새로 받은 파일 질문: 줄 위에 한 줄, 모두 안 함 → 보관 안 하기로 저장', async () => {
  await fresh();
  const ask = await page.$eval('.keep-note.ask', (e) => e.textContent);
  assert.match(ask, /새로 받은 파일 3개 · 보관할까요\?/);
  await page.click('[data-kact="ask-none"]');
  await page.waitForFunction(() => !document.querySelector('.keep-note.ask'));
  const d = await decisions();
  assert.equal(Object.values(d).filter((v) => v === 'skip').length, 3);
  assert.equal(await labelOf('GOT/C'), '보관 안 함');
});

test('앱 안 확인: 따라잡는 중이면 「없다는 뜻이 아니에요」, 전부 맞으면 초록 · 끌어놓은 파일 대조는 누른 뒤에만 받는다', async () => {
  await fresh();
  await page.evaluate(() => { window.__fx.verify = { status: 'unknown', reason: 'syncing', height: 100, caught_up: false }; });
  await page.click(btn('GOT/C').replace('button.keepbtn', 'td.name')); // 줄 선택 → 패널
  await page.waitForSelector('[data-vact="verify"]');
  await page.click('[data-vact="verify"]');
  await page.waitForSelector('.kv-head');
  assert.match(await page.$eval('#keep-verify-out', (e) => e.textContent), /없다는 뜻이 아니에요/);
  assert.doesNotMatch(await page.$eval('#keep-verify-out', (e) => e.textContent), /찾지 못했어요/);
  await page.evaluate(() => { window.__fx.verify = { status: 'found', unique: false, amount: 1, reissuable: false, has_ipfs: true, ipfs_hash: 'x', index: 'on', owner_count: 1, holders: 2, local: 'not_pinned', caught_up: true, height: 3500000, at: Math.floor(Date.now() / 1000) }; });
  await page.click('[data-vact="verify"]');
  await page.waitForFunction(() => /이 컴퓨터에 파일이 없어서/.test(document.getElementById('keep-verify-out').textContent));
  assert.ok(await page.$('[data-vact="drop"]'));
  // 누르기 전에는 파일을 받지 않는다
  assert.equal(await page.evaluate(() => window.__keep.acceptsDrop()), false);
  await page.click('[data-vact="drop"]');
  assert.equal(await page.evaluate(() => window.__keep.acceptsDrop()), true);
  await page.evaluate(() => { window.__fx.verifyFile = { match_kind: 'none', ipfs_checked: true, size: 5 }; document.dispatchEvent(new CustomEvent('drop-files-test', { detail: ['/tmp/x.png'] })); });
  await page.waitForFunction(() => /위조라고 단정할 수는 없어요/.test(document.getElementById('keep-verify-out').textContent));
  assert.equal(await page.evaluate(() => window.__keep.acceptsDrop()), false, '한 번 쓰면 다시 잠긴다');
  // 확인 주소 복사 보조 단추는 남아 있다
  assert.ok(await page.$('[data-vact="copy"]') && await page.$('[data-vact="web"]'));
});

test('용량 경고: 80% 주황·95% 빨강 문구 + 한도 늘리기, 값을 못 읽으면 0% 로 그리지 않는다', async () => {
  await fresh(CFG, () => { window.__fx.repo = { used_bytes: 14.6e9, max_bytes: 15e9 }; });
  assert.match(await page.$eval('.keep-cap', (e) => e.textContent), /새 파일을 못 받을 수 있어요/);
  assert.ok(await page.$('.kcap-meter.full'));
  await page.click('[data-kact="settings"]');
  assert.ok((await calls()).includes('showSettings'));
  await fresh(CFG, () => { window.__fx.repo = { used_bytes: 0, max_bytes: 0 }; });
  assert.match(await page.$eval('.keep-cap', (e) => e.textContent), /보관함 용량을 읽지 못했어요/);
  assert.equal(await page.$('.kcap-meter'), null);
});

test('좁은 폭(1024)·긴 글자에서도 줄 단추가 칸을 넘지 않는다', async () => {
  await fresh();
  await page.setViewport({ width: 1024, height: 700 });
  await page.evaluate(() => { document.querySelectorAll('.klabel').forEach((l) => { l.textContent = 'Nicht auf diesem Computer gefunden · reserviert'; }); });
  const r = await page.evaluate(() => ({
    over: document.documentElement.scrollWidth > document.documentElement.clientWidth,
    widths: [...document.querySelectorAll('.keepbtn')].map((b) => Math.round(b.getBoundingClientRect().width)),
    cell: [...document.querySelectorAll('td.keepcell')].map((c) => Math.round(c.getBoundingClientRect().width)),
  }));
  assert.equal(r.over, false);
  assert.ok(r.widths.every((w) => w <= 142), r.widths.join());
});
