// 지갑 파일 내보내기·가져오기 + 백업 열쇠 종이 단계 + 지갑 암호 없을 때 잠금 거절 안내 — 실제 Chrome, 빌드된 dist.
// 가짜 Tauri: 노드·지갑·파일 없음. 가짜 Rust 는 walletfile.rs / app_lock.rs 의 판단(지갑 암호 없음 거절·재인증·확인 전 전환 거절)을
// 같은 순서로 흉내 낸다 — 진짜 판단은 cargo test 가 잰다. 열쇠·암호는 전부 가짜 값이다.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync, mkdtempSync, existsSync, rmSync } from 'node:fs';
import { resolve, join, extname, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import puppeteer from 'puppeteer-core';
import { installFixture } from './desktop-fixture.mjs';

const root = resolve(import.meta.dirname, '..');
const work = mkdtempSync(join(tmpdir(), 'rv-walletfile-ui-'));
const dist = join(work, 'dist');
execFileSync(process.execPath, [resolve(root, 'node_modules/vite/bin/vite.js'), 'build', '--outDir', dist, '--emptyOutDir', '--logLevel', 'error'], { cwd: root, stdio: ['ignore', 'ignore', 'inherit'] });
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.png': 'image/png', '.webp': 'image/webp' };
const FAKE_KEY = 'zz00-aaaa-bbbb-cccc-dddd-eeee-ffff-gggg-hhhh-jjjj-kkkk-mmmm-nnnn';

let server, origin, browser;
before(async () => {
  server = createServer((req, res) => {
    const path = resolve(dist, '.' + decodeURIComponent(new URL(req.url, 'http://x').pathname));
    const file = path === dist ? join(dist, 'index.html') : path;
    if ((file !== dist && !file.startsWith(dist + sep)) || !existsSync(file)) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'Content-Type': TYPES[extname(file)] || 'application/octet-stream' });
    res.end(readFileSync(file));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  origin = `http://127.0.0.1:${server.address().port}`;
  browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true, userDataDir: join(work, 'profile'), args: ['--no-first-run', '--disable-background-networking'] });
});
after(async () => { await browser?.close(); server?.close(); rmSync(work, { recursive: true, force: true }); });

function walletStub({ encrypted, nodeUp = true, lang = 'ko', fakeKey, standbyRefuse = false, nodeRunning = true }) {
  localStorage.setItem('playx-raven-lang', lang);
  const T = window.__TAURI_INTERNALS__;
  const base = T.invoke;
  const log = { calls: [], args: {} };
  window.__wf = log;
  let prepared = null;
  T.invoke = async (cmd, args) => {
    log.calls.push(cmd);
    log.args[cmd] = args ? JSON.parse(JSON.stringify(args)) : null;
    if (cmd === 'plugin:dialog|open') return args?.options?.directory ? '/Users/synthetic/iCloud/RavenVault' : '/Users/synthetic/iCloud/RavenVault/RavenVault-wallet-20261011.rvwallet';
    if (cmd.startsWith('plugin:')) return base(cmd, args);
    if (cmd === 'wallet_file_status') return { node_up: nodeUp, wallet_encrypted: nodeUp ? encrypted : null, backup_pass: false };
    if (cmd === 'backup_pass_state') return { set: false, min: 10 };
    if (cmd === 'cloud_key_show') return { key: fakeKey, where: '/synthetic' };
    if (cmd === 'wallet_export') {
      if (!encrypted) throw 'NEEDS_WALLET_PASS:지갑 암호가 아직 없어요.';
      if (args.walletPass !== 'synthetic-correct-pass') throw '지갑 암호가 맞지 않습니다.';
      return { ok: true, path: args.dest + '/RavenVault-wallet-20261011-120000.rvwallet', folder: args.dest, size: 4300, verified: true };
    }
    if (cmd === 'key_sheet_print') return { ok: true, deletes_in_minutes: 10 };
    if (cmd === 'wallet_import_prepare') {
      if (args.secret !== 'synthetic-correct-key') throw '열쇠가 맞지 않습니다. 종이에 적힌 것을 다시 봐 주세요.';
      prepared = { id: 'a'.repeat(32), size: 4096, fingerprint: 'deadbeef', same_as_current: false };
      return { ok: true, ...prepared, current_exists: true };
    }
    if (cmd === 'wallet_import_apply') {
      if (!args.confirmed) throw '전환하기 전에 확인이 필요해요.';
      if (nodeRunning) return { ok: false, status: 'failed', previous: null, why: '서버가 응답하고 있습니다. 서버를 완전히 종료한 뒤 다시 시도해 주세요.' };
      return { ok: true, status: 'complete', previous: '/Users/synthetic/Raven/wallet.dat.before-restore-1', why: null, restart_app: true };
    }
    if (cmd === 'wallet_import_cancel') return { ok: true };
    if (cmd === 'standby_open' || cmd === 'app_lock_now') { if (standbyRefuse) throw 'NEEDS_WALLET_PASS:지갑 암호가 아직 없어요.'; return null; }
    return base(cmd, args);
  };
}

async function open(stub, { dark = false } = {}) {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.setViewport({ width: 1280, height: 900, deviceScaleFactor: 1 });
  await page.evaluateOnNewDocument(installFixture, { theme: dark ? 'dark' : 'light', sales: true, seller: false });
  await page.evaluateOnNewDocument(() => { localStorage.setItem('rv-v2-backup-reminded', '1'); });
  await page.evaluateOnNewDocument(walletStub, { fakeKey: FAKE_KEY, ...stub });
  await page.goto(origin + '/', { waitUntil: 'networkidle0' });
  await page.evaluate(() => document.querySelector('nav a[data-page="settings"]')?.click());
  await page.waitForSelector('#wf-card');
  return { page, errors };
}
const fill = (page, sel, v) => page.evaluate((s, x) => { const e = document.querySelector(s); e.value = x; e.dispatchEvent(new Event('input', { bubbles: true })); }, sel, v);
const click = (page, sel) => page.evaluate((s) => document.querySelector(s).click(), sel);
const text = (page, sel) => page.$eval(sel, (n) => n.textContent);

test('종이 단계: 「이 52글자가 없으면 못 엽니다」 안내 · 열쇠는 눌러야 보임 · 가림 · 확인 표시', async () => {
  const { page, errors } = await open({ encrypted: true });
  try {
    assert.match(await text(page, '#ck-need'), /컴퓨터가 죽으면, 이 52글자가 없으면 못 엽니다/);
    assert.equal(await text(page, '#wf-paper .keyshow'), '눌러서 보기');
    assert.ok(!(await page.evaluate(() => document.body.innerText)).includes(FAKE_KEY), '처음에는 열쇠가 화면에 없다');
    assert.ok(!(await page.evaluate(() => window.__wf.calls)).includes('cloud_key_show'), '눌러야 가져온다');
    await page.evaluate(() => [...document.querySelectorAll('#wf-paper button')].find((b) => b.textContent === '열쇠 보기').click());
    await page.waitForFunction((k) => document.querySelector('#wf-paper .keyshow').textContent === k, {}, FAKE_KEY);
    await page.evaluate(() => [...document.querySelectorAll('#wf-paper button')].find((b) => b.textContent === '다시 감추기').click());
    assert.equal(await text(page, '#wf-paper .keyshow'), '눌러서 보기');
    assert.match(await text(page, '#wf-paper-status'), /아직 종이에 적었다고 확인하지 않았어요/);
    await click(page, '#wf-paper-ok');
    assert.match(await text(page, '#wf-paper-status'), /종이 보관을 확인했어요/);
    // 인쇄용 파일: 지갑 암호를 보내고 칸을 비운다.
    await fill(page, '#wf-print-pass', 'synthetic-correct-pass');
    await page.evaluate(() => [...document.querySelectorAll('#wf-paper button')].find((b) => b.textContent === '인쇄용 파일 열기').click());
    await page.waitForFunction(() => window.__wf.calls.includes('key_sheet_print'));
    assert.equal(await page.$eval('#wf-print-pass', (n) => n.value), '');
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

test('지갑 암호 없음: 내보내기를 막고 암호 설정 안내 · wallet_export 는 부르지 않는다', async () => {
  const { page, errors } = await open({ encrypted: false });
  try {
    await click(page, '#wf-export');
    await page.waitForSelector('#wf-need-pass');
    assert.match(await text(page, '#wf-need-pass'), /먼저 지갑 암호를 걸어 주세요/);
    assert.ok(!(await page.evaluate(() => window.__wf.calls)).includes('wallet_export'));
    // 안내의 「지갑 화면으로」
    await page.evaluate(() => [...document.querySelectorAll('#wf-need-pass button')].find((b) => b.textContent === '지갑 화면으로').click());
    assert.equal(await page.evaluate(() => document.getElementById('wf-need-pass')), null);
    assert.equal(await page.evaluate(() => document.getElementById('page-wallet').classList.contains('on')), true);
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

test('노드가 꺼져 있으면 지갑 암호 유무를 모르므로 내보내기를 시작하지 않는다', async () => {
  const { page } = await open({ encrypted: true, nodeUp: false });
  try {
    await click(page, '#wf-export');
    await page.waitForFunction(() => document.querySelector('#wf-body').textContent.includes('노드가 응답하지 않아'));
    assert.ok(!(await page.evaluate(() => window.__wf.calls)).includes('wallet_export'));
  } finally { await page.close(); }
});

test('내보내기: 폴더 직접 고르기 → 틀린 암호 오류 → 맞는 암호 → 파일 위치 + 52글자 확인 전엔 끝낼 수 없음', async () => {
  const { page, errors } = await open({ encrypted: true });
  try {
    await click(page, '#wf-export');
    await page.waitForSelector('#wf-ex-go');
    assert.equal(await page.$eval('#wf-ex-go', (b) => b.disabled), true, '폴더를 고르기 전에는 못 누른다');
    await page.evaluate(() => [...document.querySelectorAll('#wf-body button')].find((b) => b.textContent.startsWith('저장할 폴더')).click());
    await page.waitForFunction(() => document.querySelector('#wf-ex-go').disabled === false);
    assert.match(await text(page, '#wf-body'), /iCloud\/RavenVault/);
    await fill(page, '#wf-ex-pass', 'synthetic-wrong-pass');
    await click(page, '#wf-ex-go');
    await page.waitForFunction(() => document.querySelector('#wf-body').textContent.includes('지갑 암호가 맞지 않습니다.'));
    assert.equal(await page.$eval('#wf-ex-pass', (n) => n.value), '', '틀려도 칸은 비운다');
    await fill(page, '#wf-ex-pass', 'synthetic-correct-pass');
    await click(page, '#wf-ex-go');
    await page.waitForSelector('#wf-end-ok');
    const s = await text(page, '#wf-body');
    assert.match(s, /RavenVault-wallet-20261011-120000\.rvwallet/);
    assert.match(s, /다시 읽어 열쇠로 풀어 보았고, 원본과 같았어요/);
    assert.match(s, /백업 열쇠 52글자를 종이에 적어 12단어와 같이 보관했어요/);
    assert.ok(!s.includes(FAKE_KEY), '열쇠는 눌러야 보인다');
    assert.equal(await page.$eval('#wf-end-fin', (b) => b.disabled), true, '확인 전에는 끝낼 수 없다');
    await click(page, '#wf-end-ok');
    assert.equal(await page.$eval('#wf-end-fin', (b) => b.disabled), false);
    await click(page, '#wf-end-fin');
    assert.match(await text(page, '#wf-body'), /완료했어요/);
    const sent = await page.evaluate(() => window.__wf.args.wallet_export);
    assert.equal(sent.dest, '/Users/synthetic/iCloud/RavenVault');
    assert.equal(await page.evaluate(() => document.querySelector('#wf-paper-ok').checked), true, '위쪽 종이 확인도 함께 표시');
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

test('가져오기: 틀린 열쇠 오류 → 열기 → 확인 칸 전에는 전환 못 함 → 노드가 켜져 있으면 거절 안내 → 그만두기', async () => {
  const { page, errors } = await open({ encrypted: true, nodeRunning: true });
  try {
    await click(page, '#wf-import');
    await page.waitForSelector('#wf-im-open');
    await page.evaluate(() => [...document.querySelectorAll('#wf-body button')].find((b) => b.textContent.startsWith('가져올 파일')).click());
    await page.waitForFunction(() => document.querySelector('#wf-im-open').disabled === false);
    await fill(page, '#wf-im-secret', 'synthetic-wrong-key');
    await click(page, '#wf-im-open');
    await page.waitForFunction(() => document.querySelector('#wf-body').textContent.includes('열쇠가 맞지 않습니다'));
    assert.equal(await page.$eval('#wf-im-secret', (n) => n.value), '');
    await fill(page, '#wf-im-secret', 'synthetic-correct-key');
    await click(page, '#wf-im-open');
    await page.waitForSelector('#wf-sw-ok');
    const s = await text(page, '#wf-body');
    assert.match(s, /현재 지갑은 그대로예요|아직 현재 지갑은 그대로예요/);
    assert.match(s, /지금 지갑은 먼저 따로 보관한 뒤에 바뀌어요/);
    assert.equal(await page.$eval('#wf-sw-go', (b) => b.disabled), true);
    await click(page, '#wf-sw-ok');
    assert.equal(await page.$eval('#wf-sw-go', (b) => b.disabled), false);
    await click(page, '#wf-sw-go');
    await page.waitForFunction(() => document.querySelector('#wf-body').textContent.includes('전환하지 못했어요'));
    assert.match(await text(page, '#wf-body'), /지금 지갑은 그대로예요/);
    assert.deepEqual(await page.evaluate(() => window.__wf.args.wallet_import_apply), { id: 'a'.repeat(32), confirmed: true });
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

test('가져오기: 노드가 꺼져 있으면 전환 완료 + 이전 지갑 보관 위치 표시, 그만두기는 임시 폴더를 지우라고 한다', async () => {
  const { page } = await open({ encrypted: true, nodeRunning: false });
  try {
    await click(page, '#wf-import');
    await page.waitForSelector('#wf-im-open');
    await page.evaluate(() => [...document.querySelectorAll('#wf-body button')].find((b) => b.textContent.startsWith('가져올 파일')).click());
    await page.waitForFunction(() => document.querySelector('#wf-im-open').disabled === false);
    await fill(page, '#wf-im-secret', 'synthetic-correct-key');
    await click(page, '#wf-im-open');
    await page.waitForSelector('#wf-sw-ok');
    await click(page, '#wf-sw-ok');
    await click(page, '#wf-sw-go');
    await page.waitForFunction(() => document.querySelector('#wf-body').textContent.includes('전환했어요'));
    assert.match(await text(page, '#wf-body'), /wallet\.dat\.before-restore-1/);
    // 다시 열어 그만두기
    await click(page, '#wf-import');
    await page.waitForSelector('#wf-im-open');
    await page.evaluate(() => [...document.querySelectorAll('#wf-body button')].find((b) => b.textContent.startsWith('가져올 파일')).click());
    await page.waitForFunction(() => document.querySelector('#wf-im-open').disabled === false);
    await fill(page, '#wf-im-secret', 'synthetic-correct-key');
    await click(page, '#wf-im-open');
    await page.waitForSelector('#wf-sw-ok');
    await page.evaluate(() => [...document.querySelectorAll('#wf-body button')].find((b) => b.textContent === '그만두기').click());
    await page.waitForFunction(() => window.__wf.calls.includes('wallet_import_cancel'));
    assert.match(await text(page, '#wf-body'), /그만뒀어요/);
  } finally { await page.close(); }
});

test('대기화면·매장용 읽기 전용: 지갑 암호가 없어 거절되면 암호 설정 안내(실패 문구 아님)', async () => {
  const { page } = await open({ encrypted: false, standbyRefuse: true });
  try {
    await page.waitForSelector('#dm-standby');
    await click(page, '#dm-standby');
    await page.waitForSelector('#wf-need-pass');
    await page.evaluate(() => document.getElementById('wf-need-pass').remove());
    await click(page, '#dm-store');
    await page.waitForSelector('#wf-need-pass');
    assert.match(await text(page, '#wf-need-pass'), /지갑 암호가 아직 없어요/);
  } finally { await page.close(); }
});

test('트레이 거절 안내: 큰 창이 Rust 의 app-lock-refused 이벤트를 듣고 있다', async () => {
  const { page } = await open({ encrypted: false });
  try {
    // 이벤트 등록은 가짜 invoke 의 기본 처리(plugin:event|listen → fixture)를 거친다. 핸들러가 있으면 호출해 본다.
    const hasListener = await page.evaluate(() => window.__wf.calls.includes('plugin:event|listen'));
    assert.ok(hasListener);
  } finally { await page.close(); }
});

for (const [lang, markers] of [['en', ['Export wallet file…', 'Set a wallet password first']], ['ja', ['ウォレットファイルを書き出す…', '先にウォレットのパスワードを設定してください']], ['zh', ['导出钱包文件…', '请先设置钱包密码']]]) {
  test(`네 나라 말 — ${lang}`, async () => {
    const { page } = await open({ encrypted: false, lang });
    try {
      assert.equal(await text(page, '#wf-export'), markers[0]);
      await click(page, '#wf-export');
      await page.waitForSelector('#wf-need-pass');
      assert.match(await text(page, '#wf-need-pass'), new RegExp(markers[1]));
      assert.doesNotMatch(await text(page, '#ck-need'), /[가-힣]/, `${lang}: 종이 안내에 한국어가 남음`);
    } finally { await page.close(); }
  });
}

test('정보 화면에 Ravencoin Core v4.8.0 MIT 고지(저작권 문구 포함)가 있고 번역되지 않는다', async () => {
  const { page } = await open({ encrypted: true, lang: 'en' });
  try {
    const t = await page.evaluate(() => document.getElementById('about-ravencoin-license').textContent);
    for (const line of ['The MIT License (MIT)', 'Copyright (c) 2009-2018 The Bitcoin Core developers', 'Copyright (c) 2018 The Raven Core developers', 'Copyright (c) 2009-2018 Raven Developers', 'THE SOFTWARE IS PROVIDED "AS IS"']) assert.ok(t.includes(line), line);
    assert.equal(await page.evaluate(() => document.getElementById('about-ravencoin-license').closest('[translate="no"]') !== null), true);
    assert.match(await text(page, '#about-notice h2'), /About/);
  } finally { await page.close(); }
});
