// Open-seller wizard + open market in real Chrome (production dist, synthetic fixture, MOCK chain only).
// IPFS adds, cid_alive, signing, balance, issuance are answered by this harness (exposeFunction + a wrapped Tauri invoke);
// nothing reaches a real node, IPFS daemon or network. Keys are throwaway. Covers: every wizard step at 390/1440 × light/dark
// (screenshot + text contrast >= 4.5:1 + no horizontal overflow), resume after a failed upload, name conflict / official-looking
// warnings, cost shortfall, mainnet lock, seller switch off, and the buyer screens (list → detail → auto-check → preview →
// confirm with fee split → mock purchase → purchase list) with the sales switch off in production and on only in a test re-wire.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { resolve, join, extname, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { build } from 'esbuild';
import puppeteer from 'puppeteer-core';
import { installFixture } from './desktop-fixture.mjs';
import { SW } from './mainnet-switch-state.mjs';

const root = resolve(import.meta.dirname, '..');
const built = await build({ entryPoints: [join(root, 'scripts/fixtures/creator-core-entry.ts')], bundle: true, write: false, platform: 'node', format: 'cjs', logLevel: 'silent' });
const core = { exports: {} };
new Function('require', 'exports', 'module', built.outputFiles[0].text)(createRequire(import.meta.url), core.exports, core);
// 장터 쪽 시험 상품(이미 체인에 있는 옛 RV. 상품)은 시험 고정물 legacyManifestForTest 로 재현한다 — 새 발행(publishContent)은 옛 이름을 막는다.
const { mockCid, signMessageForTest, randomKey, addressOf, verifyManifest, legacyManifestForTest, MockPinAdapter, CREATOR_PUBLISH_PAUSED, CREATOR_PAUSE_SAY } = core.exports;
// 🔒 옛 이름 발행 화면 흐름 시험은 잠금(CREATOR_PUBLISH_PAUSED)이 풀릴 때만 돈다(지우지 않는다). 지갑 core 가 옛 RV. 새 발행을 늘 막으므로 풀 때 새 이름 규칙으로 다시 쓴다.
const PAUSED_SKIP = CREATOR_PUBLISH_PAUSED ? '「내 상품 올리기」 임시 잠금 중(src/creator-pause.ts) — 옛 RV. 이름으로 올리고 등록하는 화면 흐름. 잠금 해제 때 새 이름 규칙으로 다시 쓴다' : false;
const marketBundle = (await build({ stdin: { contents: "import { wireOpenMarket } from './src/open-market.ts'; import { policySchedule } from './core/creator/fee-schedule.ts'; window.__wireOpenMarket = wireOpenMarket; window.__policySchedule = policySchedule;", resolveDir: root, loader: 'ts' },
  bundle: true, write: false, platform: 'browser', format: 'iife', logLevel: 'silent' })).outputFiles[0].text;
// 수수료 일정 화면 시험: 같은 화면 모듈(마법사)을 서명된 일정이 있는 상태로 다시 연결한다(출하 데스크탑은 일정을 받는 길·키가 없어 늘 「아직 못 받음」).
const wizardBundle = (await build({ stdin: { contents: "import { wireCreatorPublish } from './src/creator-publish.ts'; import { policySchedule } from './core/creator/fee-schedule.ts'; window.__wireCreatorPublish = wireCreatorPublish; window.__policySchedule = policySchedule;", resolveDir: root, loader: 'ts' },
  bundle: true, write: false, platform: 'browser', format: 'iife', logLevel: 'silent' })).outputFiles[0].text;
// 시험 일정: 시작 높이 3,999,000(안내 시각 2026-10-01), 무료 183일 = 263,520 블록 → 4,262,520 부터 5%. 장터 구매 시험은 그 뒤 높이(5%).
const SCHED_ARGS = { launchHeight: 3_999_000, launchTimeNote: '2026-10-01T00:00:00Z' };
const PAID_TIP = 3_999_000 + 263_520 + 10;
const KEY = randomKey();
const ADDRESS = addressOf(KEY);
const RECEIVING = 'RCJPGkCQi5NpBgtj8qkjGcSugfWRa3iQiS';

let work, dist, browser, server, origin, shotDir;
const enc = s => new TextEncoder().encode(s);
const PNG = n => Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 73, 72, 68, 82, n]);
const PDF = s => enc(`%PDF-1.7\n${s}\n%%EOF`);
const EPUB = () => { const h = new Uint8Array(30); h.set([0x50, 0x4b, 0x03, 0x04]); return Uint8Array.from([...h, ...enc('mimetypeapplication/epub+zip rest')]); };
const MP3 = Uint8Array.from([0x49, 0x44, 0x33, 3, 0, 0, 0, 0, 0, 0, 0xff, 0xfb, 0x90, 0x64]);
const FILES = {
  book: [{ name: 'sea.epub', type: 'application/epub+zip', bytes: EPUB() }, { name: 'sea-preview.pdf', type: 'application/pdf', bytes: PDF('preview') }, { name: 'cover.png', type: 'image/png', bytes: PNG(2) }],
  game: [{ name: 'index.html', type: 'text/html', bytes: enc('<!doctype html><script src="game.js"></script>') }, { name: 'game.js', type: '', bytes: enc('console.log(1)') }],
  exe: [{ name: 'evil.pdf', type: 'application/pdf', bytes: enc('MZ not a pdf') }],
};

before(async () => {
  work = mkdtempSync(join(tmpdir(), 'rv-open-seller-ui-'));
  shotDir = process.env.RV_CREATOR_SHOTS || join(work, 'shots'); mkdirSync(shotDir, { recursive: true });
  dist = join(work, 'dist');
  execFileSync(process.execPath, [resolve(root, 'node_modules/vite/bin/vite.js'), 'build', '--outDir', dist, '--emptyOutDir', '--logLevel', 'error'], { cwd: root, stdio: ['ignore', 'ignore', 'inherit'] });
  const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.jpg': 'image/jpeg', '.webp': 'image/webp' };
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
});
after(async () => { await browser?.close(); server?.close(); if (work && !process.env.RV_KEEP_WORK) rmSync(work, { recursive: true, force: true }); });

/** Harness answers for the commands the wizard uses; everything else falls through to the shared fixture. */
function installCreatorHarness({ chain, balance, taken, failPinAt, dead, nameUnknown }) {
  window.__nameUnknown = !!nameUnknown;
  const base = window.__TAURI_INTERNALS__.invoke;
  const calls = window.__creatorCalls = [];
  const pinned = window.__pinnedCids = new Map();
  let adds = 0;
  const wrap = async (cmd, args) => {
    if (cmd === 'ipfs_add_file') {
      adds++; calls.push({ cmd, name: args.file.name, size: args.file.bytes.length });
      if (failPinAt && adds === failPinAt) throw new Error('IPFS 가 응답하지 않아요(시험)');
      const cid = await window.__mockCid(args.file.bytes); pinned.set(cid, args.file.name); return { cid, name: args.file.name, size: args.file.bytes.length };
    }
    if (cmd === 'cid_alive') { calls.push({ cmd, cid: args.cid }); return pinned.has(args.cid) && !(dead ?? []).includes(pinned.get(args.cid)); }
    if (cmd === 'sign_message') { calls.push({ cmd, address: args.address, withPassword: 'passphrase' in args }); return { address: args.address, message: args.message, signature: await window.__testSign(args.address, args.message) }; }
    if (cmd === 'name_taken') { calls.push({ cmd, name: args.name }); if (window.__nameUnknown) throw new Error('노드가 응답하지 않아요(시험)'); return (taken ?? []).includes(args.name); }
    if (cmd === 'node_status') { const s = await base(cmd, args); return { ...s, chain }; }
    if (cmd === 'wallet_balance') return { confirmed: balance, unconfirmed: 0 };
    if (cmd === 'receive_address') return { address: window.__testAddress, reused: true, mine: true };
    if (cmd === 'issue_asset') { calls.push({ cmd, args }); return { txid: 'cd'.repeat(32), owner_token: args.name + '!' }; }
    if (cmd === 'new_address') return window.__testAddress;
    if (cmd === 'market_list_assets') { calls.push({ cmd, pattern: args.pattern }); return []; } // 0.9.2: 장터가 노드 목록을 부른다 — 모의 노드는 빈 목록
    if (cmd === 'market_chain_tip') return { chain, height: null, synced: false };
    return base(cmd, args);
  };
  window.__TAURI_INTERNALS__.invoke = wrap; window.__TAURI__.core.invoke = wrap;
}

async function openApp({ width = 1440, height = 900, theme = 'light', chain = 'regtest', balance = 600, taken = [], failPinAt = 0, dead = [], seller = true, draft = null, nameUnknown = false } = {}) {
  const page = await browser.newPage();
  page.on('pageerror', e => { page.__errors = [...(page.__errors ?? []), e.message]; });
  await page.setViewport({ width, height });
  await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: theme }, { name: 'prefers-reduced-motion', value: 'reduce' }]);
  await page.setRequestInterception(true);
  page.on('request', r => (new URL(r.url()).origin === origin && r.method() === 'GET') ? r.continue() : r.abort());
  await page.exposeFunction('__mockCid', bytes => mockCid(Uint8Array.from(bytes)));
  await page.exposeFunction('__testSign', (address, message) => { if (address !== ADDRESS) throw Error('wrong address'); return signMessageForTest(message, KEY); });
  await page.evaluateOnNewDocument(installFixture, { theme, sales: true, seller });
  await page.evaluateOnNewDocument(installCreatorHarness, { chain, balance, taken, failPinAt, dead, nameUnknown });
  await page.evaluateOnNewDocument(a => { window.__testAddress = a; }, ADDRESS);
  if (draft) await page.evaluateOnNewDocument(d => { localStorage.setItem('rv-creator-draft-v2', d); }, draft);
  await page.goto(origin + '/', { waitUntil: 'networkidle0' });
  await page.waitForFunction(() => document.querySelector('#page-home.on') && !document.documentElement.hasAttribute('data-ravi-arriving'), { timeout: 20000 });
  await page.evaluate(() => document.querySelector('nav')?.classList.add('more-open'));
  await page.click('nav a[data-page="games"]');
  await page.waitForFunction(() => document.querySelector('#page-games.on'));
  return page;
}
async function openCreator(opts) {
  const page = await openApp(opts);
  await page.click('#creator-open');
  await page.waitForFunction(() => document.querySelector('#page-creator.on'));
  // 「내 상품 올리기」는 이제 끌어놓기 화면(drop-publish.ts)으로 열린다. 이 시험은 9단계 마법사 = 「자세히(단계별로)」.
  await page.click('#dp-detail');
  await page.waitForFunction(() => document.querySelector('#page-creator').dataset.mode === 'wizard');
  // 2026-10-13 열람권(RV-LOCK v1): 음악·책·디지털은 암호화가 기본값(켜짐)이다. 이 파일의 시험은 옛(평문) 올리기 규칙을 보는 것이라 끄고 시작한다.
  // 암호화 켜짐 흐름은 scripts/lock-ui-browser.test.mjs 가 본다.
  await page.$eval('#cw-lock-on', e => { e.checked = false; });
  return page;
}
const text = (page, sel) => page.$eval(sel, e => e.tagName === 'TEXTAREA' ? e.value : e.textContent.replace(/\s+/g, ' ').trim());
const stepNow = page => page.evaluate(() => Number([...document.querySelectorAll('#page-creator .cw-panel')].find(p => !p.hidden)?.dataset.step));
const disabled = (page, sel) => page.$eval(sel, b => b.disabled);
async function next(page, want) { await page.click('#cw-next'); await page.waitForFunction(w => Number([...document.querySelectorAll('#page-creator .cw-panel')].find(p => !p.hidden)?.dataset.step) === w, { timeout: 10000 }, want); }
async function dropFiles(page, files) {
  await page.evaluate(list => {
    const dt = new DataTransfer();
    for (const f of list) dt.items.add(new File([Uint8Array.from(f.bytes)], f.name, { type: f.type }));
    document.querySelector('#cw-drop').dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
  }, files.map(f => ({ name: f.name, type: f.type, bytes: Array.from(f.bytes) })));
}
const setValue = (page, sel, v) => page.$eval(sel, (e, val) => { e.value = val; e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true })); }, v);

// All visible text inside `scope` against the alpha-composited background behind it.
function textContrast(scope) {
  const parse = c => { const v = c.match(/[\d.]+/g)?.map(Number); if (!v || v.length < 3) return [0, 0, 0, 0];
    return c.startsWith('color(') ? [v[0], v[1], v[2], v[3] ?? 1] : [v[0] / 255, v[1] / 255, v[2] / 255, v[3] ?? 1]; };
  const over = (a, b) => [...a.slice(0, 3).map((x, i) => x * a[3] + b[i] * (1 - a[3])), 1];
  const lum = c => { const f = x => x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]); };
  const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m); return (x + 0.05) / (y + 0.05); };
  const opacityOf = el => { let o = 1; for (let p = el; p; p = p.parentElement) o *= parseFloat(getComputedStyle(p).opacity); return o; };
  const out = [];
  for (const n of document.querySelectorAll(scope + ' *')) {
    if (![...n.childNodes].some(t => t.nodeType === 3 && t.textContent.trim())) continue;
    const r = n.getBoundingClientRect(), s = getComputedStyle(n);
    if (!r.width || !r.height || s.visibility !== 'visible' || n.closest('[hidden]') || (n.disabled && n.tagName === 'BUTTON')) continue;
    const chain = []; for (let p = n; p; p = p.parentElement) chain.unshift(p);
    let gradient = false;
    const bg = chain.reduce((acc, p) => { const st = getComputedStyle(p); if (st.backgroundImage !== 'none' && p !== document.documentElement && p !== document.body) gradient = true; return over(parse(st.backgroundColor), acc); }, [1, 1, 1, 1]);
    const raw = parse(s.color); const fg = over([raw[0], raw[1], raw[2], raw[3] * opacityOf(n)], bg);
    out.push({ el: (n.id ? '#' + n.id : n.tagName.toLowerCase()) + '「' + n.textContent.trim().slice(0, 20) + '」', ratio: Math.round(ratio(fg, bg) * 100) / 100, gradient });
  }
  return out;
}
const overflow = (page, scope) => page.evaluate(sc => {
  const vw = document.documentElement.clientWidth;
  // 화면 밖으로 나간 상자 + 자기 상자·카드 오른쪽 끝을 넘은 「글자」(텍스트 노드의 실제 그려진 범위로 잰다 — 상자는 좁은데 글자만 삐져나가는 경우).
  const out = [];
  for (const e of document.querySelectorAll(sc + ' *')) {
    const r = e.getBoundingClientRect(); if (!r.width || e.closest('[hidden]')) continue;
    const card = e.closest('.card'); const limit = Math.min(vw, card && card !== e ? card.getBoundingClientRect().right : vw);
    let right = r.right;
    for (const t of e.childNodes) if (t.nodeType === 3 && t.textContent.trim()) { const range = document.createRange(); range.selectNodeContents(t); for (const q of range.getClientRects()) right = Math.max(right, q.right); }
    if (right > limit + 1) out.push((e.id ? '#' + e.id : e.tagName.toLowerCase()) + ':' + Math.round(right) + '>' + Math.round(limit));
  }
  return out.slice(0, 10);
}, scope);
async function audit(page, scope, label, report) {
  // 방금 누른 단추 위에 마우스가 남아 hover 전환이 도는 중이면 중간 색을 재게 된다 — 마우스를 치우고 애니메이션이 끝날 때까지 기다린다.
  await page.mouse.move(1, 1);
  await page.waitForFunction(() => document.getAnimations().filter(a => a.playState === 'running' && !(a.effect?.getComputedTiming?.().iterations === Infinity)).length === 0, { timeout: 5000 }).catch(() => {});
  const all = await page.evaluate(textContrast, scope);
  await page.evaluate(sc => (document.querySelector(`${sc} .cw-panel:not([hidden])`) ?? document.querySelector(`${sc} .card:not([hidden])`))?.scrollIntoView({ block: 'start' }), scope);
  const file = join(shotDir, `${label}.png`);
  await page.screenshot({ path: file, fullPage: true });
  report[label] = { measured: all.length, low: all.filter(r => !r.gradient && r.ratio < 4.5), overflow: await overflow(page, scope), shot: statSync(file).size };
}

/** The whole book flow, auditing every step. Returns the page at step 8. */
async function bookFlow(page, report, tag) {
  const shot = async n => report && audit(page, '#page-creator', `wizard-${tag}-step${n}`, report);
  assert.equal(await stepNow(page), 0);
  assert.match(await text(page, '#cw-guide'), /보증.*수수료가 아니에요.*수수료 일정을 아직 받지 못했어요.*300 RVN 에 팔리면 → 무료 기간에는 나 300 RVN · 수수료 0 RVN, 그 뒤 나 285 RVN · 수수료 15 RVN.*규칙: 시작 뒤 약 6개월 수수료 0%, 그 뒤 5%.*최대 500 RVN.*파일 보관은 내 책임.*환불 책임은 판매자.*전문가 확인/);
  assert.doesNotMatch(await text(page, '#cw-guide'), /15%/, 'no hard-coded 15% draft');
  assert.match(await text(page, '#cw-switch-note'), new RegExp(`메인넷 등록은 ${SW.issue ? '열려' : '꺼져'}.*판매\\(구매 결제\\)는 ${SW.sales ? '열려' : '꺼져'}`));
  assert.equal(await disabled(page, '#cw-start'), true, 'must tick 「읽었어요」');
  await shot(0);
  await page.click('#cw-guide-ok'); await page.click('#cw-start');
  await page.waitForFunction(() => !document.querySelector('.cw-panel[data-step="1"]').hidden);
  assert.equal(await disabled(page, '#cw-next'), true, 'choose a kind first');
  assert.deepEqual(await page.$$eval('input[name="cw-type"]', r => r.map(x => x.value)), ['game', 'music', 'book', 'ticket', 'digital']);
  assert.match(await text(page, '#cw-kinds'), /게임.*검증된 뒤에만 지갑 결제.*책.*전자책\(PDF·EPUB\)/);
  await page.click('input[name="cw-type"][value="book"]');
  await shot(1);
  await next(page, 2);
  assert.match(await text(page, '#cw-drop-say'), /PDF·EPUB/);
  assert.equal(await disabled(page, '#cw-next'), true, 'no files yet');
  await dropFiles(page, FILES.book);
  await page.waitForFunction(() => /2개 파일 · 표지 1장/.test(document.querySelector('#cw-files-say').textContent));
  await shot(2);
  await next(page, 3);
  await page.type('#cw-title', '바다 이야기');
  await page.waitForFunction(() => /RV\.B\.BOOK/.test(document.querySelector('#cw-suggest').textContent));
  assert.equal(await page.$eval('#cw-asset', e => e.value), 'BOOK', 'Korean-only title → fallback name proposal');
  assert.equal(await text(page, '#cw-prefix'), 'RV.B.', 'book → fixed RV.B. prefix (kind letter from the chosen kind)');
  assert.match(await text(page, '#cw-kind-letter'), /RV\.B\.」의 B 는 책 칸/);
  await setValue(page, '#cw-asset', 'SEA_BOOK');
  await page.type('#cw-price', '300');
  assert.match(await text(page, '#cw-fee'), /수수료 일정을 아직 받지 못했어요.*내 받는 주소로 바로.*내 가격 300 RVN 이면 → 무료 기간에는 나 300 RVN · 수수료 0 RVN, 그 뒤 나 285 RVN · 수수료 15 RVN.*보증 500 RVN 과는 다른 돈/);
  await page.click('#cw-new-address');
  await page.waitForFunction(a => document.querySelector('#cw-address').value === a, {}, ADDRESS);
  await page.waitForFunction(() => /RV\.B\.SEA_BOOK \(13\/30자\)/.test(document.querySelector('#cw-name-say').textContent));
  await page.waitForFunction(() => /비어 있어요/.test(document.querySelector('#cw-dup').textContent));
  assert.equal(await page.$eval('#cw-dup', e => e.className), 'creator-good');
  assert.equal(await page.$eval('#cw-book-file', s => s.value), 'sea.epub'); assert.equal(await page.$eval('#cw-book-preview', s => s.value), 'sea-preview.pdf');
  await shot(3);
  await next(page, 4);
  assert.match(await text(page, '#cw-check'), /올릴 수 있어요 · 파일 3개 .*주의 1개.*EPUB.*레이븐볼트는 열지 않고/);
  await shot(4);
  await next(page, 5);
  await page.waitForFunction(() => /합계/.test(document.querySelector('#cw-cost').textContent));
  assert.match(await text(page, '#cw-cost'), /보증\(소각\) 500 RVN — 수수료가 아니에요.*네트워크 수수료 약 0\.01 RVN\(추정\).*합계 500\.01 RVN.*잔액이 충분해요.*600 RVN/);
  assert.match(await text(page, '#cw-cost-fee'), /지금 내는 돈 아님.*그 뒤 나 285 RVN · 수수료 15 RVN.*그 뒤 5%.*1,000,000 RVN/);
  await shot(5);
  await next(page, 6);
  assert.match(await text(page, '#cw-pin-holder'), /이 컴퓨터의 IPFS/);
  await shot(6);
  await page.click('#cw-upload');
  await page.waitForFunction(() => /다 올렸어요/.test(document.querySelector('#cw-upload-say').textContent), { timeout: 20000 });
  assert.equal(await page.$eval('#cw-progress', e => e.getAttribute('aria-valuenow')), '100');
  await page.click('#cw-pin-check');
  await page.waitForFunction(() => /받아져요|못 찾아요/.test(document.querySelector('#cw-pin-say').textContent));
  await next(page, 7);
  await page.waitForFunction(() => document.querySelector('#cw-c-name').textContent === 'RV.B.SEA_BOOK');
  await page.waitForFunction(() => /비어 있어요/.test(document.querySelector('#cw-c-dup').textContent));
  assert.match(await text(page, '#cw-c-burn'), /500 RVN — 수수료가 아니라 보증/);
  assert.match(await text(page, '#cw-c-burn-check'), /확인 불가/);
  assert.match(await text(page, '#cw-c-fee'), /수수료 일정을 아직 받지 못했어요.*그 뒤 나 285 RVN · 수수료 15 RVN/);
  assert.match(await text(page, '#cw-c-irreversible'), /영영 돌아오지 않아요.*보증.*영구예요.*되돌릴 수 없어요.*판매 책임은 제작자/);
  assert.equal(await disabled(page, '#cw-issue'), true);
  await page.type('#cw-typed', 'RV.B.SEA_BOOK');
  await page.waitForFunction(() => !document.querySelector('#cw-issue').disabled);
  await shot(7);
  await page.click('#cw-issue');
  await page.waitForFunction(() => !document.querySelector('.cw-panel[data-step="8"]').hidden, { timeout: 10000 });
  await page.waitForFunction(() => /판매/.test(document.querySelector('#cw-sales').textContent));
  await shot(8);
  return page;
}

test('book: guide → ①…⑧ on the mock chain; every step audited at 390/1440 × light/dark (screenshot, contrast ≥ 4.5:1, no overflow)', { timeout: 600_000, skip: PAUSED_SKIP }, async () => {
  const report = {};
  for (const width of [390, 1440]) for (const theme of ['light', 'dark']) {
    const page = await openCreator({ width, height: 844, theme });
    await bookFlow(page, report, `${width}-${theme}`);
    if (width === 1440 && theme === 'light') {
      const calls = await page.evaluate(() => window.__creatorCalls);
      assert.deepEqual(calls.filter(c => c.cmd === 'ipfs_add_file').map(c => c.name), ['sea.epub', 'sea-preview.pdf', 'cover.png', 'manifest.json']);
      assert.deepEqual(calls.filter(c => c.cmd === 'sign_message'), [{ cmd: 'sign_message', address: ADDRESS, withPassword: false }]);
      const issued = calls.filter(c => c.cmd === 'issue_asset').map(c => c.args);
      assert.equal(issued.length, 1); assert.equal(issued[0].name, 'RV.B.SEA_BOOK'); assert.deepEqual([issued[0].qty, issued[0].units, issued[0].reissuable], [1, 0, true]);
      assert.equal(await text(page, '#cw-txid'), 'cd'.repeat(32));
      assert.match(await text(page, '#cw-mine'), /바다 이야기 · RV\.B\.SEA_BOOK · 책/);
      assert.match(await page.$eval('#cw-share', t => t.value), /RV\.B\.SEA_BOOK[\s\S]*열린 장터[\s\S]*ipfs:\/\/Qm/);
      const asked = calls.filter(c => c.cmd === 'name_taken').map(c => c.name);
      assert.ok(asked.length >= 2 && asked.every(n => /^RV\.B\./.test(n)) && asked.at(-1) === 'RV.B.SEA_BOOK', `chain duplicate lookups: ${asked}`);
      assert.match(await text(page, '#cw-sales'), SW.sales ? /판매 현황을 읽지 못했어요/ : /판매 기능이 아직 꺼져 있어 판매가 없어요/);
      const req = JSON.parse(await page.$eval('#cw-request', t => t.value));
      assert.deepEqual([req.status, req.asset, req.type, req.issueTxid], ['unverified', 'RV.B.SEA_BOOK', 'book', 'cd'.repeat(32)]);
      assert.equal(await page.evaluate(() => localStorage.getItem('rv-creator-draft-v2')), null, 'draft cleared after issuing');
      assert.deepEqual(await page.evaluate(() => window.__homeFixture.forbidden), [], 'no reveal/unlock/send command');
    }
    await page.close();
  }
  if (process.env.RV_CREATOR_REPORT) await writeFile(process.env.RV_CREATOR_REPORT, JSON.stringify(report, null, 2));
  assert.equal(Object.keys(report).length, 36, '9 steps × 4 environments');
  for (const [k, v] of Object.entries(report)) {
    assert.ok(v.measured > 10, `${k}: measured too little (${v.measured})`);
    assert.ok(v.shot > 5000, `${k}: screenshot missing`);
    assert.deepEqual(v.low, [], `${k} low contrast: ${JSON.stringify(v.low)}`);
    assert.deepEqual(v.overflow, [], `${k} overflow: ${JSON.stringify(v.overflow)}`);
  }
});

test('resume: an upload that fails half-way is continued later without re-uploading finished files; pin check finds a missing file', { timeout: 300_000, skip: PAUSED_SKIP }, async () => {
  let page = await openCreator({ failPinAt: 3 });
  await page.click('#cw-guide-ok'); await page.click('#cw-start');
  await page.click('input[name="cw-type"][value="book"]');
  await next(page, 2);
  await dropFiles(page, FILES.book);
  await page.waitForFunction(() => /2개 파일/.test(document.querySelector('#cw-files-say').textContent));
  await next(page, 3);
  await page.type('#cw-title', 'Sea Book'); await setValue(page, '#cw-asset', 'SEA_BOOK'); await page.type('#cw-price', '20');
  await page.click('#cw-new-address'); await page.waitForFunction(a => document.querySelector('#cw-address').value === a, {}, ADDRESS);
  await page.waitForFunction(() => !document.querySelector('#cw-next').disabled);
  await next(page, 4); await next(page, 5); await next(page, 6);
  await page.click('#cw-upload');
  await page.waitForFunction(() => /올리지 못했어요.*다시 눌러/.test(document.querySelector('#cw-error').textContent), { timeout: 20000 });
  const draft = await page.evaluate(() => localStorage.getItem('rv-creator-draft-v2'));
  const saved = JSON.parse(draft);
  assert.equal(saved.cache.length, 2, 'two files were pinned before the failure'); assert.equal(saved.published, null);
  assert.doesNotMatch(draft, /"bytes"|passphrase|mnemonic/, 'draft holds no bytes or secrets');
  await page.close();
  // Reopen later: banner → continue → re-pick the same files → only the remaining file + manifest are uploaded.
  page = await openCreator({ draft, dead: ['cover.png'] });
  await page.waitForFunction(() => !document.querySelector('#cw-resume').hidden);
  assert.match(await text(page, '#cw-resume-say'), /지난번 올리던 것이 있어요/);
  await page.click('#cw-resume-go');
  assert.equal(await stepNow(page), 2);
  assert.equal(await page.$eval('#cw-title', e => e.value), 'Sea Book');
  await dropFiles(page, FILES.book);
  await page.waitForFunction(() => /2개 파일/.test(document.querySelector('#cw-files-say').textContent));
  await next(page, 3); await page.waitForFunction(() => !document.querySelector('#cw-next').disabled);
  await next(page, 4); await next(page, 5); await next(page, 6);
  assert.match(await text(page, '#cw-upload-say'), /이미 올린 파일 2개는 건너뛰어요/);
  await page.click('#cw-upload');
  await page.waitForFunction(() => /다 올렸어요/.test(document.querySelector('#cw-upload-say').textContent), { timeout: 20000 });
  assert.deepEqual((await page.evaluate(() => window.__creatorCalls)).filter(c => c.cmd === 'ipfs_add_file').map(c => c.name), ['cover.png', 'manifest.json']);
  await page.click('#cw-pin-check');
  await page.waitForFunction(() => /못 찾아요/.test(document.querySelector('#cw-pin-say').textContent));
  assert.match(await text(page, '#cw-pin-say'), /cover\.png/, 'the file this computer no longer serves is named');
  await page.close();
});

test('name: taken on chain blocks, official-looking and lookalike warn; ticket details reach a verifiable manifest', { timeout: 300_000, skip: PAUSED_SKIP }, async () => {
  const page = await openCreator({ taken: ['RV.T.AUTUMN_LIVE'] });
  await page.click('#cw-guide-ok'); await page.click('#cw-start');
  await page.click('input[name="cw-type"][value="ticket"]'); await next(page, 2);
  assert.equal(await disabled(page, '#cw-next'), false, 'a ticket needs no files');
  await next(page, 3);
  assert.match(await text(page, '#cw-fields-ticket'), /서버 없이.*서명한 입장 코드.*「이미 사용」이 기기끼리 공유되지 않아요.*재판매·환불·행사 취소 책임은 판매자.*전문가 확인/);
  await page.type('#cw-title', 'Autumn Live'); await setValue(page, '#cw-asset', 'AUTUMN_LIVE');
  await page.click('#cw-new-address'); await page.waitForFunction(a => document.querySelector('#cw-address').value === a, {}, ADDRESS);
  await page.waitForFunction(() => /이미 체인에 있어요/.test(document.querySelector('#cw-name-warn').textContent));
  assert.match(await text(page, '#cw-dup'), /이미 있어요/); assert.equal(await text(page, '#cw-prefix'), 'RV.T.');
  assert.equal(await disabled(page, '#cw-next'), true, 'taken name blocks');
  // 작품 이름 칸에 예약어 → 규칙 위반으로 막힘, 조회하지 않음.
  await setValue(page, '#cw-asset', 'RVN');
  await page.waitForFunction(() => /쓸 수 없어요/.test(document.querySelector('#cw-name-say').textContent));
  assert.match(await text(page, '#cw-dup'), /규칙에 맞게 고치면 조회/); assert.equal(await disabled(page, '#cw-next'), true, 'reserved word blocks');
  await setValue(page, '#cw-asset', 'PLAYX_OFFICIAL_LIVE');
  await page.waitForFunction(() => /공식/.test(document.querySelector('#cw-name-warn').textContent));
  await setValue(page, '#cw-asset', 'AUTUMN_LIVE_2026');
  await page.type('#cw-price', '40');
  await page.type('#cw-t-event', '가을 작은 음악회'); await setValue(page, '#cw-t-start', '2027-11-20T19:00'); await setValue(page, '#cw-t-end', '2027-11-20T21:00');
  await page.type('#cw-t-venue', '서울 작은 홀'); await setValue(page, '#cw-t-qty', '50');
  await page.type('#cw-t-refund', '행사 7일 전까지 환불'); await page.type('#cw-t-contact', 'hello@example.com');
  await page.waitForFunction(() => !document.querySelector('#cw-next').disabled);
  await next(page, 4); await next(page, 5); await next(page, 6);
  await page.evaluate(() => { const base = window.__TAURI_INTERNALS__.invoke; window.__pinned = {}; const wrap = async (c, a) => { if (c === 'ipfs_add_file' && a.file.name === 'manifest.json') window.__pinned.manifest = a.file.bytes; return base(c, a); }; window.__TAURI_INTERNALS__.invoke = wrap; window.__TAURI__.core.invoke = wrap; });
  await page.click('#cw-upload');
  await page.waitForFunction(() => /다 올렸어요/.test(document.querySelector('#cw-upload-say').textContent), { timeout: 20000 });
  const v = verifyManifest(Uint8Array.from(await page.evaluate(() => window.__pinned.manifest)), { expectedAsset: 'RV.T.AUTUMN_LIVE_2026' });
  assert.equal(v.signedBy, ADDRESS); assert.equal(v.manifest.type, 'ticket'); assert.equal(v.manifest.files.length, 0);
  assert.deepEqual([v.manifest.details.eventName, v.manifest.details.quantity, v.manifest.details.redemption.checkerAddress], ['가을 작은 음악회', 50, ADDRESS]);
  await page.close();
});

test('chain duplicate lookup: 「확인 불가」 is shown on ③ and ⑦ and blocks issuing until a re-check answers', { timeout: 300_000, skip: PAUSED_SKIP }, async () => {
  const page = await openCreator({ nameUnknown: true });
  await page.click('#cw-guide-ok'); await page.click('#cw-start');
  await page.click('input[name="cw-type"][value="game"]'); await next(page, 2);
  await dropFiles(page, FILES.game);
  await page.waitForFunction(() => /2개 파일/.test(document.querySelector('#cw-files-say').textContent));
  await next(page, 3);
  assert.equal(await text(page, '#cw-prefix'), 'RV.G.');
  await page.type('#cw-title', 'Star Run'); await setValue(page, '#cw-asset', 'STAR_RUN');
  await page.click('#cw-new-address'); await page.waitForFunction(a => document.querySelector('#cw-address').value === a, {}, ADDRESS);
  await page.waitForFunction(() => /확인 불가/.test(document.querySelector('#cw-dup').textContent));
  assert.equal(await page.$eval('#cw-dup', e => e.className), 'creator-bad');
  assert.match(await text(page, '#cw-name-warn'), /체인에 이미 있는지 확인 불가/);
  const report = {};
  for (const width of [390, 1440]) for (const theme of ['light', 'dark']) {
    await page.setViewport({ width, height: 844 }); await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: theme }]); await page.evaluate(t => { document.documentElement.dataset.theme = t; }, theme);
    await audit(page, '#page-creator', `wizard-dup-unknown-step3-${width}-${theme}`, report);
  }
  await page.setViewport({ width: 1440, height: 900 }); await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'light' }]); await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
  await page.waitForFunction(() => !document.querySelector('#cw-next').disabled);
  await next(page, 4); await next(page, 5); await next(page, 6);
  await page.click('#cw-upload');
  await page.waitForFunction(() => /다 올렸어요/.test(document.querySelector('#cw-upload-say').textContent), { timeout: 20000 });
  await next(page, 7);
  await page.waitForFunction(() => /확인 불가/.test(document.querySelector('#cw-c-dup').textContent));
  await page.type('#cw-typed', 'RV.G.STAR_RUN');
  await page.waitForFunction(() => /확인 불가/.test(document.querySelector('#cw-c-blockers').textContent));
  assert.equal(await disabled(page, '#cw-issue'), true, 'unknown availability blocks issuing');
  for (const width of [390, 1440]) for (const theme of ['light', 'dark']) {
    await page.setViewport({ width, height: 844 }); await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: theme }]); await page.evaluate(t => { document.documentElement.dataset.theme = t; }, theme);
    await audit(page, '#page-creator', `wizard-dup-unknown-step7-${width}-${theme}`, report);
  }
  await page.setViewport({ width: 1440, height: 900 }); await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'light' }]); await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
  for (const [k, v] of Object.entries(report)) {
    assert.ok(v.measured > 10, `${k}: measured too little`);
    assert.deepEqual(v.low, [], `${k} low contrast: ${JSON.stringify(v.low)}`);
    assert.deepEqual(v.overflow, [], `${k} overflow: ${JSON.stringify(v.overflow)}`);
  }
  // 노드가 돌아오면 「다시 조회」 → 비어 있음 → 등록 가능.
  await page.evaluate(() => { window.__nameUnknown = false; });
  await page.click('#cw-c-dup-recheck');
  await page.waitForFunction(() => /비어 있어요/.test(document.querySelector('#cw-c-dup').textContent));
  await page.waitForFunction(() => !document.querySelector('#cw-issue').disabled);
  assert.doesNotMatch(await text(page, '#cw-c-blockers'), /확인 불가/);
  assert.equal((await page.evaluate(() => window.__creatorCalls)).filter(c => c.cmd === 'issue_asset').length, 0, 'nothing issued by the re-check');
  await page.close();
});

test('cost shortfall and mainnet lock block issuing; bad files are refused; game kind warns that code runs', { timeout: 300_000, skip: PAUSED_SKIP }, async () => {
  for (const [opts, expectCost, expectBlock] of [[{ balance: 100 }, /400\.01 RVN 이 모자라요/, /모자라요/], [{ chain: 'main' }, /잔액이 충분해요/, /실제 발행은 아직 꺼져 있어요/]]) {
    if (opts.chain === 'main' && SW.issue) continue; // 메인넷 스위치가 켜진 빌드(enable 커밋)에서는 이 잠금 항목이 없다 — 나머지 잠금(소각액·잔액·이름)은 위 경우가 지킨다
    const page = await openCreator(opts);
    await page.click('#cw-guide-ok'); await page.click('#cw-start');
    await page.click('input[name="cw-type"][value="game"]'); await next(page, 2);
    await dropFiles(page, FILES.game);
    await page.waitForFunction(() => /2개 파일/.test(document.querySelector('#cw-files-say').textContent));
    await next(page, 3);
    await page.type('#cw-title', 'Star Run'); await setValue(page, '#cw-asset', 'STAR_RUN');
    await page.click('#cw-new-address'); await page.waitForFunction(a => document.querySelector('#cw-address').value === a, {}, ADDRESS);
    await page.waitForFunction(() => !document.querySelector('#cw-next').disabled);
    await next(page, 4);
    assert.match(await text(page, '#cw-check'), /코드를 실행해요.*나쁜 코드를 다 찾아내지 못해요/);
    await next(page, 5);
    await page.waitForFunction(() => /합계/.test(document.querySelector('#cw-cost').textContent));
    assert.match(await text(page, '#cw-cost'), expectCost);
    if (opts.balance) assert.match(await text(page, '#cw-receive'), new RegExp(ADDRESS));
    await next(page, 6); await page.click('#cw-upload');
    await page.waitForFunction(() => /다 올렸어요/.test(document.querySelector('#cw-upload-say').textContent), { timeout: 20000 });
    await next(page, 7);
    await page.type('#cw-typed', 'RV.G.STAR_RUN');
    await page.waitForFunction(() => document.querySelector('#cw-c-blockers').textContent.length > 0);
    assert.match(await text(page, '#cw-c-blockers'), expectBlock);
    assert.equal(await disabled(page, '#cw-issue'), true);
    await page.evaluate(() => document.querySelector('#cw-issue').click());
    assert.equal((await page.evaluate(() => window.__creatorCalls)).filter(c => c.cmd === 'issue_asset').length, 0, 'nothing issued');
    await page.close();
  }
  const page = await openCreator();
  await page.click('#cw-guide-ok'); await page.click('#cw-start');
  await page.click('input[name="cw-type"][value="digital"]'); await next(page, 2);
  await dropFiles(page, FILES.exe);
  await next(page, 3);
  await page.type('#cw-title', 'Brushes'); await setValue(page, '#cw-asset', 'BRUSH_PACK'); await page.type('#cw-d-label', '그림 모음');
  await page.click('#cw-new-address'); await page.waitForFunction(a => document.querySelector('#cw-address').value === a, {}, ADDRESS);
  await page.waitForFunction(() => !document.querySelector('#cw-next').disabled);
  await next(page, 4);
  assert.match(await text(page, '#cw-check'), /고칠 곳 .*evil\.pdf.*실행 파일.*→ 파일을 바꾸거나 빼고/);
  assert.equal(await disabled(page, '#cw-next'), true);
  assert.equal((await page.evaluate(() => window.__creatorCalls)).filter(c => c.cmd === 'ipfs_add_file').length, 0);
  await page.close();
});

test('잠금 상태(출하 연결): 「내 상품 올리기」 마법사는 쉬운 안내 한 줄 · 시작·올리기·등록이 막히고 억지로 눌러도 아무것도 올리거나 서명·등록하지 않는다 · 이어하기도 등록에서 막힌다 · 390/1440 × light/dark', { timeout: 300_000 }, async () => {
  assert.equal(CREATOR_PUBLISH_PAUSED, true);
  const report = {};
  for (const width of [390, 1440]) for (const theme of ['light', 'dark']) {
    const page = await openCreator({ width, height: 844, theme });
    assert.equal(await text(page, '#cw-paused'), CREATOR_PAUSE_SAY + ' 준비가 끝나면 다시 열려요.');
    assert.equal(await page.$eval('#cw-paused', e => e.getAttribute('role')), 'status');
    assert.equal(await page.$eval('#dp-paused', e => e.textContent.includes('새 발행 방식으로 옮기는 중')), true, 'drop screen says the same');
    await page.click('#cw-guide-ok');
    assert.equal(await disabled(page, '#cw-start'), true, 'start stays locked even after 「읽었어요」');
    await page.evaluate(() => { const b = document.querySelector('#cw-start'); b.disabled = false; b.click(); }); // 단추를 우회해도 함수 입구가 막는다
    assert.equal(await stepNow(page), 0);
    assert.match(await text(page, '#cw-error'), /새 발행 방식으로 옮기는 중/);
    assert.equal(await disabled(page, '#cw-upload'), true);
    await page.evaluate(() => { document.querySelector('#cw-upload').disabled = false; document.querySelector('#cw-upload').click(); document.querySelector('#cw-issue').disabled = false; document.querySelector('#cw-issue').click(); });
    await new Promise(r => setTimeout(r, 300));
    const touched = (await page.evaluate(() => window.__creatorCalls)).filter(c => ['ipfs_add_file', 'sign_message', 'issue_asset'].includes(c.cmd));
    assert.deepEqual(touched, [], 'nothing pinned, signed or issued');
    await audit(page, '#page-creator', `paused-${width}-${theme}`, report);
    await page.close();
  }
  for (const [k, v] of Object.entries(report)) {
    assert.ok(v.measured > 3, `${k}: measured too little`);
    assert.deepEqual(v.low, [], `${k} low contrast: ${JSON.stringify(v.low)}`);
    assert.deepEqual(v.overflow, [], `${k} overflow: ${JSON.stringify(v.overflow)}`);
  }
  // 지난번에 다 올려 둔 초안(옛 RV. 상품)을 이어서 열어도 ⑦에서 등록은 막히고 막힌 이유 맨 앞에 안내가 있다.
  const pub = await legacyManifestForTest({ type: 'book', asset: 'RV.B.SEA_BOOK', title: '바다 이야기', description: '', creatorAddress: ADDRESS, receivingAddress: ADDRESS, priceAtoms: null,
    files: [{ path: 'sea.pdf', bytes: new TextEncoder().encode('%PDF-1.7\nx\n%%EOF'), mime: 'application/pdf' }],
    details: { bookFile: 'sea.pdf', format: 'pdf', previewFile: null, previewPages: 0, pageCount: null }, now: new Date('2026-10-10T00:00:00Z') }, new MockPinAdapter(), async (_a, m) => signMessageForTest(m, KEY));
  const draft = JSON.stringify({ step: 7, type: 'book', fields: { 'cw-title': '바다 이야기', 'cw-address': ADDRESS, 'cw-asset': 'SEA_BOOK' }, cache: [],
    published: { manifestCid: pub.manifestCid, manifestSha256: pub.manifestSha256, manifest: pub.manifest, pinnedBy: 'test' }, savedAt: '2026-10-10T00:00:00Z' });
  const page = await openCreator({ draft });
  await page.click('#cw-resume-go');
  await page.waitForFunction(() => Number([...document.querySelectorAll('#page-creator .cw-panel')].find(p => !p.hidden)?.dataset.step) === 7);
  await page.waitForFunction(() => document.querySelector('#cw-c-blockers li'));
  assert.match(await page.$eval('#cw-c-blockers li', e => e.textContent), /새 발행 방식으로 옮기는 중/);
  await page.type('#cw-typed', 'RV.B.SEA_BOOK');
  assert.equal(await disabled(page, '#cw-issue'), true);
  await page.evaluate(() => { document.querySelector('#cw-issue').disabled = false; document.querySelector('#cw-issue').click(); });
  await new Promise(r => setTimeout(r, 300));
  assert.match(await text(page, '#cw-issue-say'), /새 발행 방식으로 옮기는 중/);
  assert.equal((await page.evaluate(() => window.__creatorCalls)).filter(c => c.cmd === 'issue_asset').length, 0, 'nothing issued from a resumed draft');
  assert.deepEqual(page.__errors ?? [], []);
  await page.close();
});

test('seller switch off: creator and market entries are hidden, inert and route-blocked', { timeout: 120_000 }, async () => {
  const page = await openApp({ seller: false });
  for (const id of ['#creator-open', '#market-open', '#page-creator', '#page-market']) {
    assert.deepEqual(await page.$eval(id, e => [e.hidden, e.hasAttribute('inert')]), [true, true], id);
  }
  await page.evaluate(() => { document.querySelector('#creator-open').click(); document.querySelector('#market-open').click(); });
  assert.equal(await page.$eval('#page-creator', e => e.classList.contains('on')), false);
  assert.equal(await page.$eval('#page-market', e => e.classList.contains('on')), false);
  assert.equal(await page.$eval('#page-games', e => e.classList.contains('on')), true);
  await page.close();
});

/* ── 구매자 화면 ── */
async function marketFixture() {
  const pin = new MockPinAdapter();
  const sign = async (_a, m) => signMessageForTest(m, KEY);
  const common = { creatorAddress: ADDRESS, receivingAddress: RECEIVING, declaredFeeBps: 1500, now: new Date('2026-10-10T00:00:00Z'), description: '시험 상품' };
  const book = await legacyManifestForTest({ ...common, type: 'book', asset: 'RV.B.SEA_BOOK', title: '바다 이야기', priceAtoms: '30000000000',
    files: [{ path: 'sea.pdf', bytes: PDF('book'), mime: '' }, { path: 'sea-preview.pdf', bytes: PDF('pv'), mime: '' }, { path: 'cover.png', bytes: PNG(5), mime: '', role: 'cover' }],
    details: { bookFile: 'sea.pdf', format: 'pdf', previewFile: 'sea-preview.pdf', previewPages: 5, pageCount: 80 } }, pin, sign);
  const fake = await legacyManifestForTest({ ...common, type: 'book', asset: 'RV.B.SEA_B00K', title: '바다 이야기', priceAtoms: '30000000000', creatorAddress: ADDRESS,
    files: [{ path: 'sea.pdf', bytes: PDF('copy'), mime: '' }], details: { bookFile: 'sea.pdf', format: 'pdf', previewFile: null, previewPages: 0, pageCount: null } }, pin, sign);
  const music = await legacyManifestForTest({ ...common, type: 'music', asset: 'RV.M.MORNING_SONG', title: '아침 노래', priceAtoms: '2000000000',
    files: [{ path: 'song.mp3', bytes: MP3, mime: '' }], details: { previewFile: 'song.mp3', previewStartMs: 0, previewEndMs: 30000 } }, pin, sign);
  const game = await legacyManifestForTest({ ...common, type: 'game', asset: 'RV.G.STAR_RUN', title: '별 달리기', priceAtoms: '3000000000',
    files: FILES.game.map(f => ({ path: f.name, bytes: f.bytes, mime: f.type })), details: { entry: 'index.html', origin: 'https://star-run.example', capabilities: { identity: false, payment: true } } }, pin, sign);
  const assets = [book, fake, music, game].map(r => ({ name: r.manifest.asset, ipfs_hash: r.manifestCid }));
  const store = Object.fromEntries([...pin.stored.entries()].map(([k, v]) => [k, Array.from(v)]));
  return { assets, store };
}
async function openMarket(opts = {}, { salesEnabled = true, withBuy = true, verifiedOnly = false, purchaseMode = null } = {}) {
  const page = await openApp(opts);
  await page.click('#market-open');
  await page.waitForFunction(() => document.querySelector('#page-market.on'));
  await page.waitForFunction(() => /아직 올라온 상품이 없어요/.test(document.querySelector('#mk-list-say').textContent));
  assert.equal((await page.evaluate(() => window.__creatorCalls)).some(c => c.cmd === 'market_list_assets' && c.pattern === 'RV.*'), true, '앱 장터가 노드 목록 명령을 부른다');
  const fx = await marketFixture();
  await page.addScriptTag({ content: marketBundle });
  await page.evaluate((fx, salesEnabled, withBuy, args) => {
    window.__buys = []; window.__patterns = []; window.__opened = []; window.__pcalls = [];
    // 모의 결제 길(0.9.2): 준비(돈 안 나감) → 승인 → 전송. tamper = 준비된 거래의 판매자 몫이 화면과 다르다.
    const purchase = args.purchaseMode ? {
      prepare: async r => { window.__pcalls.push(['prepare', r]);
        const outputs = [{ role: 'seller', address: r.sellerAddress, atoms: r.sellerAtoms }, ...(r.feeAtoms !== '0' ? [{ role: 'fee', address: 'RLFnbkjmf1VCVq7D9TZvRp7fv6W97rm2cB', atoms: r.feeAtoms }] : []), { role: 'memo', address: null, atoms: '0' }, { role: 'change', address: 'RChangeMine', atoms: '123400000' }];
        if (args.purchaseMode === 'tamper') outputs[0] = { ...outputs[0], atoms: '1' };
        return { id: 'p1', asset: r.asset, outputs, networkFeeAtoms: '226000', totalAtoms: String(BigInt(r.sellerAtoms) + BigInt(r.feeAtoms) + 226000n), sellerAtoms: r.sellerAtoms, feeAtoms: r.feeAtoms, chain: 'regtest', memoScript: '6a0452564450', ownerId: 'owner-x' }; },
      send: async p => { window.__pcalls.push(['send', p.id]); return { txid: 'cd'.repeat(32) }; },
      cancel: () => window.__pcalls.push(['cancel']) } : undefined;
    const sched = window.__policySchedule(args.sched);
    const m = window.__wireOpenMarket({ back: () => {}, salesEnabled, verifiedOnly: args.verifiedOnly, now: () => Date.parse('2026-10-12T00:00:00Z'), feeSchedule: () => sched, chainHeight: () => args.tip,
      // 노드가 검색어를 무시하고 전부 돌려주는 최악의 경우 — 화면(discoverListings)이 종류 글자로 다시 걸러야 한다.
      source: { assets: async p => { window.__patterns.push(p); return fx.assets; }, fetch: async cid => fx.store[cid] ? Uint8Array.from(fx.store[cid]) : null },
      buy: withBuy ? async r => { window.__buys.push(r); return { txid: 'ab'.repeat(32) }; } : undefined,
      purchase, openExternal: u => { window.__opened.push(u); } });
    return m.load();
  }, fx, salesEnabled, withBuy, { sched: SCHED_ARGS, tip: PAID_TIP, verifiedOnly, purchaseMode });
  await page.waitForFunction(() => document.querySelectorAll('#mk-list .mk-item').length === 4);
  return page;
}
const openItem = async (page, asset) => { await page.click(`#mk-list .mk-item[data-asset="${asset}"]`); await page.waitForFunction(() => !document.querySelector('#mk-detail').hidden); };

test('buyer: list → detail → auto-check → preview → confirm (fee split) → mock purchase → purchase list; game stays external, lookalike warned', { timeout: 300_000 }, async () => {
  const page = await openMarket();
  const items = await page.$$eval('#mk-list .mk-item', b => b.map(x => x.dataset.asset + ':' + x.querySelector('.mk-badge').textContent));
  assert.deepEqual(items, ['RV.B.SEA_B00K:미검증', 'RV.B.SEA_BOOK:미검증', 'RV.G.STAR_RUN:미검증', 'RV.M.MORNING_SONG:미검증'], 'no auto-check yet → all unverified');
  assert.match(await text(page, '#mk-list'), /바다 이야기.*비슷한 이름 있음/);
  // 종류 탭: 전체 + 다섯 종류, 탭마다 체인 검색어 RV.<글자>.* 로 찾고 그 종류만 보인다.
  assert.deepEqual(await page.$$eval('#mk-tabs button', b => b.map(x => `${x.dataset.kind}:${x.textContent}:${x.getAttribute('aria-pressed')}`)),
    ['all:전체:true', 'game:게임:false', 'music:음악:false', 'book:책:false', 'ticket:티켓:false', 'digital:그 밖의 디지털 상품:false']);
  await page.click('#mk-tabs button[data-kind="book"]');
  await page.waitForFunction(() => document.querySelectorAll('#mk-list .mk-item').length === 2);
  assert.deepEqual(await page.$$eval('#mk-list .mk-item', b => b.map(x => x.dataset.asset)), ['RV.B.SEA_B00K', 'RV.B.SEA_BOOK']);
  assert.match(await text(page, '#mk-list-say'), /책 2개/);
  await page.click('#mk-tabs button[data-kind="ticket"]');
  await page.waitForFunction(() => /아직 올라온 티켓 상품이 없어요/.test(document.querySelector('#mk-list-say').textContent));
  const tabReport = {};
  for (const width of [390, 1440]) for (const theme of ['light', 'dark']) {
    await page.setViewport({ width, height: 844 }); await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: theme }]); await page.evaluate(t => { document.documentElement.dataset.theme = t; }, theme);
    await audit(page, '#page-market', `market-tabs-${width}-${theme}`, tabReport);
  }
  await page.setViewport({ width: 1440, height: 900 }); await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'light' }]); await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
  for (const [k, v] of Object.entries(tabReport)) { assert.deepEqual(v.low, [], `${k} low contrast: ${JSON.stringify(v.low)}`); assert.deepEqual(v.overflow, [], `${k} overflow: ${JSON.stringify(v.overflow)}`); }
  await page.click('#mk-tabs button[data-kind="all"]');
  await page.waitForFunction(() => document.querySelectorAll('#mk-list .mk-item').length === 4);
  assert.deepEqual(await page.evaluate(() => window.__patterns), ['RV.*', 'RV.B.*', 'RV.T.*', 'RV.*']);
  // Game: external link only, no buy, even after an auto-check.
  await openItem(page, 'RV.G.STAR_RUN');
  await page.click('#mk-d-check'); await page.waitForFunction(() => /자동 점검:/.test(document.querySelector('#mk-d-check-say').textContent));
  assert.match(await text(page, '#mk-d-warning'), /외부 링크로만.*게임처럼 코드를 실행하는 상품은 검증된 뒤에만/);
  assert.match(await text(page, '#mk-d-preview'), /지갑 안에서 열지 않아요.*ipfs:\/\/Qm/);
  assert.equal(await disabled(page, '#mk-d-buy'), true);
  await page.click('#mk-d-back');
  // Book: auto-check → bonded → preview link → confirm → pay.
  await openItem(page, 'RV.B.SEA_BOOK');
  assert.match(await text(page, '#mk-d-alerts'), /비슷한 이름의 상품이 있어요\(RV\.B\.SEA_B00K\).*판매자 주소/);
  await page.click('#mk-d-check');
  await page.waitForFunction(() => document.querySelector('#mk-d-badge').textContent === '보증 · 미검증');
  assert.match(await text(page, '#mk-d-warning'), /검토하지 않은 판매자예요. 자동 점검과 보증만.*환불.*판매자에게.*보증 500 RVN 은 수수료가 아니에요/);
  assert.match(await text(page, '#mk-d-facts'), /RV\.B\.SEA_BOOK.*300 RVN.*미리보기5쪽.*80쪽.*공개 IPFS/);
  assert.equal(await page.$eval('#mk-d-book-preview', a => a.textContent), '미리보기 5쪽 받기(PDF)');
  assert.equal(await page.$eval('#mk-d-book-preview', a => a.href.startsWith('blob:')), true);
  assert.equal(await disabled(page, '#mk-d-buy'), false);
  await page.click('#mk-d-buy');
  await page.waitForFunction(() => !document.querySelector('#mk-confirm').hidden);
  assert.match(await text(page, '#mk-c-lines'), new RegExp(`판매자에게 285 RVN \\(받는 주소 ${RECEIVING}\\).*레이븐볼트 수수료 15 RVN \\(5%\\).*합계 300 RVN.*지금 수수료 5%.*체인 블록 높이`));
  assert.match(await text(page, '#mk-c-note'), /판매자 받는 주소로 바로.*한 거래 안에서 지갑이 나눠요/);
  const report = {};
  for (const width of [390, 1440]) for (const theme of ['light', 'dark']) {
    await page.setViewport({ width, height: 844 }); await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: theme }]); await page.evaluate(t => { document.documentElement.dataset.theme = t; }, theme);
    await audit(page, '#page-market', `market-confirm-${width}-${theme}`, report);
  }
  await page.setViewport({ width: 1440, height: 900 }); await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'light' }]); await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
  await page.click('#mk-c-pay');
  await page.waitForFunction(() => /보냈어요/.test(document.querySelector('#mk-c-say').textContent));
  assert.deepEqual(await page.evaluate(() => window.__buys), [{ asset: 'RV.B.SEA_BOOK', sellerAddress: RECEIVING, priceAtoms: '30000000000', sellerAtoms: '28500000000', feeAtoms: '1500000000', feeBps: 500, tier: 'bonded' }]);
  assert.match(await text(page, '#mk-purchases'), /바다 이야기 · RV\.B\.SEA_BOOK · 판매자 285 RVN \+ 수수료 15 RVN · 거래 abababababab….*자산은 받지 않았어요/);
  // Music: preview player limited to its window.
  await page.click('#mk-c-cancel'); await page.click('#mk-d-back');
  await openItem(page, 'RV.M.MORNING_SONG');
  await page.click('#mk-d-check');
  await page.waitForFunction(() => document.querySelector('#mk-d-audio'));
  assert.match(await text(page, '#mk-d-preview'), /미리듣기 0초~30초/);
  for (const width of [390, 1440]) for (const theme of ['light', 'dark']) {
    await page.setViewport({ width, height: 844 }); await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: theme }]); await page.evaluate(t => { document.documentElement.dataset.theme = t; }, theme);
    await audit(page, '#page-market', `market-detail-${width}-${theme}`, report);
  }
  for (const [k, v] of Object.entries(report)) {
    assert.deepEqual(v.low, [], `${k} low contrast: ${JSON.stringify(v.low)}`);
    assert.deepEqual(v.overflow, [], `${k} overflow: ${JSON.stringify(v.overflow)}`);
  }
  await page.close();
});

test('buyer with the production switch (off): confirm screen shows the split but paying is locked and nothing is sent', { timeout: 300_000 }, async () => {
  const page = await openMarket({}, { salesEnabled: false, withBuy: true });
  await openItem(page, 'RV.B.SEA_BOOK');
  await page.click('#mk-d-check');
  await page.waitForFunction(() => document.querySelector('#mk-d-badge').textContent === '보증 · 미검증');
  assert.match(await text(page, '#mk-d-buy-say'), /판매 기능은 아직 꺼져/);
  await page.click('#mk-d-buy');
  await page.waitForFunction(() => !document.querySelector('#mk-confirm').hidden);
  assert.match(await text(page, '#mk-c-lines'), /판매자에게 285 RVN.*수수료 15 RVN/);
  assert.match(await text(page, '#mk-c-blockers'), /판매 기능이 아직 꺼져 있어요/);
  assert.equal(await disabled(page, '#mk-c-pay'), true);
  await page.evaluate(() => document.querySelector('#mk-c-pay').click());
  assert.deepEqual(await page.evaluate(() => window.__buys), []);
  await page.close();
});

test('fee schedule: wizard notice reads the signed schedule (0% now → date/block of 5%, examples at both rates); market with no schedule locks the purchase; 390/1440 × light/dark', { timeout: 300_000 }, async () => {
  const report = {};
  for (const width of [390, 1440]) for (const theme of ['light', 'dark']) {
    const page = await openCreator({ width, height: 844, theme, chain: 'main' }); // 메인넷 노드가 다 따라잡음 → 체인 높이 4,000,000(픽스처)을 쓴다
    await page.addScriptTag({ content: wizardBundle });
    await page.evaluate(args => {
      const pc = document.getElementById('page-creator'); pc.replaceWith(pc.cloneNode(true)); // 출하 연결의 이벤트를 떼고 같은 모듈을 일정과 함께 다시 연결
      const sched = window.__policySchedule(args);
      // 수수료 안내만 본다(올리기·등록 없음) — 단계를 넘기려고 임시 잠금을 이 연결에서만 끈다.
      window.__wireCreatorPublish({ invoke: (c, a) => window.__TAURI__.core.invoke(c, a), back: () => {}, askPassword: async () => null, feeSchedule: () => sched, paused: false });
    }, SCHED_ARGS);
    await page.waitForFunction(() => /블록 4262520/.test(document.querySelector('#cw-guide-fee').textContent), { timeout: 10000 });
    const guide = await text(page, '#cw-guide-fee');
    assert.match(guide, /^지금 수수료 0% \(무료 기간\) → 2027년 4월 2일 무렵\(블록 4262520\)부터 5%\./, guide);
    assert.match(guide, /예: 300 RVN 에 팔리면 → 지금 나 300 RVN · 수수료 0 RVN \/ 2027년 4월 2일부터 나 285 RVN · 수수료 15 RVN/);
    assert.match(guide, /규칙: 시작 뒤 약 6개월 수수료 0%, 그 뒤 5%.*3%.*2\.5%.*최대 500 RVN.*체인 블록 높이/);
    assert.doesNotMatch(guide, /15%|예상/, 'chain height known → no 「예상」, no 15%');
    await audit(page, '#page-creator', `fee-guide-${width}-${theme}`, report);
    await page.click('#cw-guide-ok'); await page.click('#cw-start');
    await page.waitForFunction(() => !document.querySelector('.cw-panel[data-step="1"]').hidden);
    await page.click('input[name="cw-type"][value="book"]');
    await next(page, 2);
    await dropFiles(page, FILES.book);
    await page.waitForFunction(() => /2개 파일 · 표지 1장/.test(document.querySelector('#cw-files-say').textContent));
    await next(page, 3);
    await page.type('#cw-price', '20000');
    const fee = await text(page, '#cw-fee');
    assert.match(fee, /내 가격 20000 RVN 이면 → 나 20000 RVN · 수수료 0 RVN \/ 2027년 4월 2일부터 나 19500 RVN · 수수료 500 RVN/, 'cap 500 RVN applied at 20,000 RVN: ' + fee);
    await audit(page, '#page-creator', `fee-step3-${width}-${theme}`, report);
    await page.close();
  }
  for (const [k, v] of Object.entries(report)) {
    assert.ok(v.measured > 5, `${k}: measured too little`);
    assert.deepEqual(v.low, [], `${k} low contrast: ${JSON.stringify(v.low)}`);
    assert.deepEqual(v.overflow, [], `${k} overflow: ${JSON.stringify(v.overflow)}`);
  }
  // Market without a schedule (production state): confirm shows why and paying stays locked even with the switch on.
  const page = await openApp({});
  await page.click('#market-open');
  await page.waitForFunction(() => document.querySelector('#page-market.on'));
  const fx = await marketFixture();
  await page.addScriptTag({ content: marketBundle });
  await page.evaluate(fx => { window.__buys = [];
    return window.__wireOpenMarket({ back: () => {}, salesEnabled: true, verifiedOnly: false, now: () => Date.parse('2026-10-12T00:00:00Z'), feeSchedule: () => null,
      source: { assets: async () => fx.assets, fetch: async cid => fx.store[cid] ? Uint8Array.from(fx.store[cid]) : null }, buy: async r => { window.__buys.push(r); return { txid: 'ab'.repeat(32) }; } }).load(); }, fx);
  await page.waitForFunction(() => document.querySelectorAll('#mk-list .mk-item').length === 4);
  await openItem(page, 'RV.B.SEA_BOOK');
  await page.click('#mk-d-check');
  await page.waitForFunction(() => document.querySelector('#mk-d-badge').textContent === '보증 · 미검증');
  await page.click('#mk-d-buy');
  await page.waitForFunction(() => !document.querySelector('#mk-confirm').hidden);
  assert.match(await text(page, '#mk-c-blockers'), /수수료 일정을 아직 받지 못했어요/);
  assert.equal(await disabled(page, '#mk-c-pay'), true);
  await page.evaluate(() => document.querySelector('#mk-c-pay').click());
  assert.deepEqual(await page.evaluate(() => window.__buys), []);
  await page.close();
});


/* ── 0.9.2: 결제 준비/승인 분리 · 1단계 제한 · 사실 문구 · 신고/숨김 ── */
async function bondedBook(page) {
  await openItem(page, 'RV.B.SEA_BOOK');
  await page.click('#mk-d-check');
  await page.waitForFunction(() => document.querySelector('#mk-d-badge').textContent === '보증 · 미검증');
}

test('purchase: the confirm screen only PREPARES (nothing sent), shows seller/fee/network/total, and sends once after explicit approval; the record says no asset was received', { timeout: 300_000 }, async () => {
  const page = await openMarket({}, { purchaseMode: 'ok' });
  await bondedBook(page);
  await page.click('#mk-d-buy');
  await page.waitForFunction(() => document.querySelectorAll('#mk-c-outputs li').length >= 5 && !document.querySelector('#mk-c-pay').disabled);
  const calls = await page.evaluate(() => window.__pcalls);
  assert.deepEqual(calls.map(c => c[0]), ['prepare'], '확인 화면에 들어온 것만으로는 아무것도 보내지 않는다');
  assert.equal(calls[0][1].tier, 'bonded'); assert.equal(calls[0][1].sellerAtoms, '28500000000'); assert.equal(calls[0][1].feeAtoms, '1500000000');
  const outs = await text(page, '#mk-c-outputs');
  assert.match(outs, new RegExp(`판매자 받는 주소 ${RECEIVING} ← 285 RVN`));
  assert.match(outs, /레이븐볼트 수수료 주소 RLFnbkjmf1VCVq7D9TZvRp7fv6W97rm2cB ← 15 RVN/);
  assert.match(outs, /체인 기록\(메모\) — 0 RVN/);
  assert.match(outs, /거스름 1\.234 RVN 은 내 지갑으로 돌아와요/);
  assert.match(outs, /네트워크 수수료 약 0\.00226 RVN.*내 지갑에서 나가는 돈\(거스름 제외\) 300\.00226 RVN/);
  const facts = await text(page, '#mk-c-facts');
  assert.match(facts, /내 지갑으로 오지 않고, 내 지갑에 새 자산이 생기지 않아요/);
  assert.match(facts, /공개 IPFS.*누구나 받을 수 있어서.*권한을 만들어 주지는 않아요/);
  assert.match(facts, /되돌릴 수 없어요.*환불은 판매자와 직접/);
  assert.equal(await page.$eval('#mk-c-pay', b => b.textContent), '승인하고 보내기');
  const prepReport = {};
  for (const width of [390, 1440]) for (const theme of ['light', 'dark']) {
    await page.setViewport({ width, height: 844 }); await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: theme }]); await page.evaluate(t => { document.documentElement.dataset.theme = t; }, theme);
    await audit(page, '#page-market', `market-prepared-${width}-${theme}`, prepReport);
  }
  await page.setViewport({ width: 1440, height: 900 }); await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'light' }]); await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
  for (const [k, v] of Object.entries(prepReport)) { assert.ok(v.measured > 5, k); assert.deepEqual(v.low, [], `${k} low contrast: ${JSON.stringify(v.low)}`); assert.deepEqual(v.overflow, [], `${k} overflow: ${JSON.stringify(v.overflow)}`); }
  await page.click('#mk-c-pay');
  await page.waitForFunction(() => /보냈어요/.test(document.querySelector('#mk-c-say').textContent));
  assert.deepEqual((await page.evaluate(() => window.__pcalls)).map(c => c[0]), ['prepare', 'send']);
  assert.match(await text(page, '#mk-purchases'), /바다 이야기 · RV\.B\.SEA_BOOK · 판매자 285 RVN \+ 수수료 15 RVN \+ 네트워크 0\.00226 RVN · 거래 cdcdcdcdcdcd….*자산은 받지 않았어요/);
  const rec = JSON.parse(await page.evaluate(() => localStorage.getItem('rv-market-purchases-v1')))[0];
  assert.equal(rec.assetReceived, false); assert.equal(rec.tier, 'bonded'); assert.equal(rec.networkFeeRvn, '0.00226'); assert.equal(rec.memoScript, '6a0452564450'); assert.equal(rec.sellerAddress, RECEIVING);
  // 두 번 눌러도 다시 보내지 않는다.
  await page.evaluate(() => document.querySelector('#mk-c-pay').click());
  assert.equal((await page.evaluate(() => window.__pcalls)).filter(c => c[0] === 'send').length, 1);
  await page.close();
});

test('purchase: cancelling before approval discards the prepared transaction and never sends; a prepared transaction that differs from the screen is refused', { timeout: 300_000 }, async () => {
  let page = await openMarket({}, { purchaseMode: 'ok' });
  await bondedBook(page);
  await page.click('#mk-d-buy');
  await page.waitForFunction(() => !document.querySelector('#mk-c-pay').disabled);
  await page.click('#mk-c-cancel');
  assert.deepEqual((await page.evaluate(() => window.__pcalls)).map(c => c[0]), ['prepare', 'cancel']);
  await page.evaluate(() => document.querySelector('#mk-c-pay').click());
  assert.equal((await page.evaluate(() => window.__pcalls)).filter(c => c[0] === 'send').length, 0);
  await page.close();
  page = await openMarket({}, { purchaseMode: 'tamper' });
  await bondedBook(page);
  await page.click('#mk-d-buy');
  await page.waitForFunction(() => /화면과 달라요/.test(document.querySelector('#mk-c-blockers').textContent));
  assert.match(await text(page, '#mk-c-blockers'), /판매자 몫이 화면과 달라요.*돈은 나가지 않았어요/);
  assert.equal(await disabled(page, '#mk-c-pay'), true);
  await page.evaluate(() => document.querySelector('#mk-c-pay').click());
  assert.deepEqual((await page.evaluate(() => window.__pcalls)).map(c => c[0]), ['prepare', 'cancel']);
  await page.close();
});

test('1단계 제한: 허용 목록이 비어 있으면(출하 상태) 판매 스위치가 켜져 있어도 아무 상품도 결제되지 않는다 — 준비도 부르지 않는다', { timeout: 300_000 }, async () => {
  const page = await openMarket({}, { purchaseMode: 'ok', verifiedOnly: true });
  await bondedBook(page);
  assert.equal(await disabled(page, '#mk-d-buy'), true);
  assert.match(await text(page, '#mk-d-buy-say'), /허용 목록에 있는 상품만 결제할 수 있어요.*허용 목록이 비어 있어서 아직 결제할 수 있는 상품이 없어요/);
  await page.evaluate(() => document.querySelector('#mk-d-buy').click());
  assert.equal(await page.$eval('#mk-confirm', e => e.hidden), true);
  assert.deepEqual(await page.evaluate(() => window.__pcalls), []);
  assert.deepEqual(await page.evaluate(() => window.__buys), []);
  await page.close();
});

test('신고·숨김: 신고는 메일 작성 창(자리표시 정책 문구), 숨김은 내 목록에서만 · 되돌릴 수 있다', { timeout: 300_000 }, async () => {
  const page = await openMarket({}, { purchaseMode: 'ok' });
  await openItem(page, 'RV.B.SEA_BOOK');
  assert.match(await text(page, '#mk-d-report-note'), /정해지는 중이라 지금은 약속할 수 없어요.*내 컴퓨터의 목록에서만 숨겨요/);
  await page.click('#mk-d-report');
  await page.waitForFunction(() => window.__opened.length === 1);
  const url = await page.evaluate(() => window.__opened[0]);
  assert.ok(url.startsWith('mailto:playx@ex.erci.se?subject='), url);
  assert.match(decodeURIComponent(url), /RV\.B\.SEA_BOOK/); assert.match(decodeURIComponent(url), /Qm[1-9A-HJ-NP-Za-km-z]{44}/); assert.match(decodeURIComponent(url), new RegExp(RECEIVING));
  assert.match(await text(page, '#mk-d-report-say'), /메일 작성 창을 열었어요/);
  await page.click('#mk-d-hide');
  await page.waitForFunction(() => document.querySelectorAll('#mk-list .mk-item').length === 3);
  assert.equal((await page.$$eval('#mk-list .mk-item', b => b.map(x => x.dataset.asset))).includes('RV.B.SEA_BOOK'), false);
  assert.match(await text(page, '#mk-hidden-say'), /내가 숨긴 상품 1개/);
  assert.equal(await page.$eval('#mk-hidden-reset', b => b.hidden), false);
  await page.click('#mk-hidden-reset');
  await page.waitForFunction(() => document.querySelectorAll('#mk-list .mk-item').length === 4);
  assert.equal(await page.$eval('#mk-hidden-reset', b => b.hidden), true);
  await page.close();
});
