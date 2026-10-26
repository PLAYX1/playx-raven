// 0.9.0 백업과 복구(레인 B) — 실제 Chrome, 빌드된 dist, 가짜 Tauri(노드·지갑·파일 없음).
// 가짜 Rust 는 restore_drop.rs / walletfile.rs 의 순서(읽기만 → 재인증+열어 보기 → 확인 뒤 되살리기 · 지갑 암호 없으면 거절)를
// 흉내 낸다 — 진짜 판단은 cargo test 가 잰다. 열쇠·암호·경로는 전부 가짜 값이다.
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
const work = mkdtempSync(join(tmpdir(), 'rv-backupdrop-ui-'));
const dist = join(work, 'dist');
execFileSync(process.execPath, [resolve(root, 'node_modules/vite/bin/vite.js'), 'build', '--outDir', dist, '--emptyOutDir', '--logLevel', 'error'], { cwd: root, stdio: ['ignore', 'ignore', 'inherit'] });
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.png': 'image/png', '.webp': 'image/webp' };

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

function stub({ encrypted = true, lang = 'ko', nodeRunning = false, weak = false, pick = '/Volumes/SYNTHETIC-USB/RavenVault-wallet-20261012.rvwallet' }) {
  localStorage.setItem('playx-raven-lang', lang);
  const T = window.__TAURI_INTERNALS__;
  const base = T.invoke;
  const log = window.__bd = { calls: [], args: {}, events: {} };
  let ticket = null;
  const wrap = async (cmd, args) => {
    log.calls.push(cmd);
    log.args[cmd] = args ? JSON.parse(JSON.stringify(args)) : null;
    if (cmd === 'plugin:event|listen') { log.events[args.event] = args.handler; return base(cmd, args); }
    if (cmd === 'plugin:dialog|open') return args?.options?.directory ? '/Volumes/SYNTHETIC-USB' : pick;
    if (cmd.startsWith('plugin:')) return base(cmd, args);
    if (cmd === 'wallet_file_status') return { node_up: true, wallet_encrypted: encrypted, backup_pass: false };
    if (cmd === 'backup_pass_state') return { set: false, min: 10 };
    if (cmd === 'restore_drop_inspect') {
      const name = args.path.split('/').pop();
      const kind = /\.rvwallet$/i.test(name) ? 'wallet' : 'full';
      return { kind, name, path: args.path, size: 5_242_880, modified: 1_791_700_000, day: '2026-10-11', scope: kind === 'full' ? 'wallet_and_shop' : 'wallet_only' };
    }
    if (cmd === 'restore_drop_open') {
      if (args.walletPass !== 'synthetic-wallet-pass') throw '지갑 암호가 맞지 않습니다.';
      if (/\.rvwallet$/.test(args.path) && args.secret !== 'synthetic-paper-key') throw '열쇠가 맞지 않습니다.';
      ticket = 'f'.repeat(32);
      return /\.rvwallet$/.test(args.path)
        ? { ticket, kind: 'wallet', fingerprint: 'deadbeef', same_as_current: false, items: [{ key: 'wallet', what: '지갑', why: '잔액과 자산의 열쇠입니다' }] }
        : { ticket, kind: 'full', items: [{ key: 'wallet', what: '지갑', detail: '0.1 MB', why: '잔액과 자산의 열쇠입니다' }, { key: 'passes', what: '회원', detail: '12명', why: '이름·기간·남은 횟수' }] };
    }
    if (cmd === 'restore_drop_apply') {
      if (!args.confirmed) throw '되살리기 전에 확인이 필요해요.';
      if (args.ticket !== ticket) throw '되살리기 준비가 없어요.';
      if (nodeRunning) throw '레이븐 노드가 아직 켜져 있어요. 노드를 완전히 끈 뒤 다시 눌러 주세요. 아직 아무것도 바꾸지 않았어요.';
      ticket = null;
      return { ok: true, status: 'complete', done: [{ what: '지갑', previous: '/Users/synthetic/Raven/wallet.dat.before-restore-1' }], failed: [], restart_app: true };
    }
    if (cmd === 'restore_drop_cancel') { ticket = null; return { ok: true }; }
    if (cmd === 'wallet_core_export') {
      if (!encrypted) throw 'NEEDS_WALLET_PASS:지갑 암호가 아직 없어요.';
      if (args.walletPass !== 'synthetic-wallet-pass') throw '지갑 암호가 맞지 않습니다.';
      return { ok: true, path: args.dest + '/wallet-for-ravencoin-core-20261012-120000.dat', folder: args.dest, size: 98_304, format: 'bdb', verified: true, weak_pass: weak, locked_with_backup_key: false };
    }
    return base(cmd, args);
  };
  T.invoke = wrap; if (window.__TAURI__?.core) window.__TAURI__.core.invoke = wrap;
}

async function open(opts = {}, { settings = true } = {}) {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.setViewport({ width: 1280, height: 900, deviceScaleFactor: 1 });
  await page.evaluateOnNewDocument(installFixture, { theme: 'light', sales: true, seller: false });
  await page.evaluateOnNewDocument(() => { localStorage.setItem('rv-v2-backup-reminded', '1'); });
  await page.evaluateOnNewDocument(stub, opts);
  await page.goto(origin + '/', { waitUntil: 'networkidle0' });
  if (settings) {
    await page.evaluate(() => document.querySelector('nav a[data-page="settings"]')?.click());
    await page.waitForSelector('#wf-core');
  }
  await page.waitForFunction(() => !!window.__bd.events['drop-files']);
  return { page, errors };
}
const drop = (page, paths) => page.evaluate((p) => window.__TAURI_INTERNALS__.runCallback(window.__bd.events['drop-files'], { event: 'drop-files', id: 1, payload: { paths: p } }), paths);
const fill = (page, sel, v) => page.evaluate((s, x) => { const e = document.querySelector(s); e.value = x; e.dispatchEvent(new Event('input', { bubbles: true })); }, sel, v);
const click = (page, sel) => page.evaluate((s) => document.querySelector(s).click(), sel);
const text = (page, sel) => page.$eval(sel, (n) => n.textContent);
const calls = (page) => page.evaluate(() => window.__bd.calls.filter((c) => !c.startsWith('plugin:')));

test('설정 백업 칸 순서: 두 파일 구분표 → 52글자 종이 → .rvwallet 내보내기(잠금) → 끌어다 놓기 → 코어로 옮기기', async () => {
  const { page, errors } = await open();
  try {
    const order = await page.evaluate(() => ['bk-two-files', 'ck-key', 'wf-card', 'wf-drop', 'wf-core'].map((id) => document.getElementById(id)).map((n, i, all) => i === 0 ? 0 : (all[i - 1].compareDocumentPosition(n) & Node.DOCUMENT_POSITION_FOLLOWING ? 1 : -1)));
    assert.deepEqual(order, [0, 1, 1, 1, 1]);
    // 병합(0.9.0): 설정 B 껍데기에서는 다섯 칸이 모두 「백업과 복구」 주제 패널의 마운트 자리 안에 붙는다.
    const inMount = await page.evaluate(() => { const m = document.getElementById('sx-backup-mount'); return m ? ['bk-two-files', 'ck-key', 'wf-card', 'wf-drop', 'wf-core'].map((id) => !!document.getElementById(id) && m.contains(document.getElementById(id))) : null; });
    if (inMount) assert.deepEqual(inMount, [true, true, true, true, true], '백업 칸이 #sx-backup-mount 밖에 붙었다');
    assert.match(await text(page, '#bk-two-files'), /파일로 꺼내는 길은 두 가지예요.*wallet\.dat 백업 파일\(\.rvwallet\).*코어용 wallet\.dat/s);
    assert.match(await text(page, '#wf-export'), /wallet\.dat 백업 파일 내보내기\(잠금\)/);
    assert.match(await text(page, '#wf-import'), /wallet\.dat 백업 파일 가져오기/);
    assert.match(await text(page, '#wf-drop'), /끌어다 놓/);
    assert.match(await text(page, '#wf-core'), /레이븐 코어로 옮기기/);
    // 처음 그릴 때는 아무 명령도 부르지 않는다(코어용·복원).
    const c = await calls(page);
    for (const x of ['wallet_core_export', 'restore_drop_inspect', 'restore_drop_open', 'restore_drop_apply']) assert.ok(!c.includes(x), x);
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

test('.rvwallet 놓기: 이름·크기·날짜·「wallet.dat 하나만」 → 열쇠+지갑 암호 → 열어 보기 → 확인 체크 전에는 못 누름 → 되살리기, 비밀 칸은 비운다', async () => {
  const { page, errors } = await open();
  try {
    await drop(page, ['/Volumes/SYNTHETIC-USB/RavenVault-wallet-20261012.rvwallet']);
    await page.waitForSelector('#rd-scope');
    assert.match(await text(page, '#rd-facts'), /RavenVault-wallet-20261012\.rvwallet/);
    assert.match(await text(page, '#rd-facts'), /5\.0 MB/);
    assert.match(await text(page, '#rd-scope'), /wallet\.dat\) 하나만 바꿔요.*가게 기록과 설정은 그대로/s);
    assert.match(await text(page, '#rd-body'), /이 백업에서 되살릴까요\?/);
    assert.deepEqual((await calls(page)).filter((c) => c.startsWith('restore_drop')), ['restore_drop_inspect'], '확인 창 전에는 보기만');
    await click(page, '#rd-prepare');
    await page.waitForSelector('#rd-secret');
    await fill(page, '#rd-secret', 'synthetic-paper-key');
    await fill(page, '#rd-wallet-pass', 'synthetic-wallet-pass');
    await click(page, '#rd-open');
    await page.waitForSelector('#rd-apply');
    const a = await page.evaluate(() => window.__bd.args.restore_drop_open);
    assert.deepEqual([a.mode, a.secret, a.walletPass], ['key', 'synthetic-paper-key', 'synthetic-wallet-pass']);
    assert.equal(await page.$eval('#rd-secret', (n) => n.value), '', '.rvwallet 은 열어 본 뒤 열쇠를 비운다');
    assert.equal(await page.$eval('#rd-apply', (b) => b.disabled), true, '확인 체크 전에는 못 누른다');
    assert.ok(!(await calls(page)).includes('restore_drop_apply'));
    assert.match(await text(page, '#rd-body'), /deadbeef/);
    await click(page, '#rd-ok');
    assert.equal(await page.$eval('#rd-apply', (b) => b.disabled), false);
    await click(page, '#rd-apply');
    await page.waitForFunction(() => /되살렸어요/.test(document.querySelector('#rd-body').textContent));
    const ap = await page.evaluate(() => window.__bd.args.restore_drop_apply);
    assert.deepEqual([ap.ticket, ap.secret, ap.confirmed], ['f'.repeat(32), '', true]);
    assert.match(await text(page, '#rd-body'), /before-restore/);
    // 비밀 값이 화면 글자에 없다.
    const all = await page.evaluate(() => document.body.innerText);
    assert.ok(!all.includes('synthetic-paper-key') && !all.includes('synthetic-wallet-pass'));
    // 자산 드롭 흐름으로 가지 않았다.
    { const cs = await calls(page); assert.ok(!cs.some((c) => /dropped|asset_keep_verify|asset_keep_check/.test(c)), cs.join(",")); }
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

test('.pxlock 놓기: 「가게 전체」 범위 · 노드가 켜져 있으면 아무것도 안 바꾸고 그대로 · 되살릴 때 같은 열쇠를 다시 보낸다', async () => {
  const { page, errors } = await open({ nodeRunning: true });
  try {
    await drop(page, ['/Users/synthetic/RavenVault-Backup/RavenVault.zip.pxlock']);
    await page.waitForSelector('#rd-scope');
    assert.match(await text(page, '#rd-scope'), /가게 전체 백업\(\.pxlock\).*가게 기록/s);
    assert.equal(await page.$eval('#rd-scope', (n) => n.dataset.kind), 'full');
    await click(page, '#rd-prepare');
    await page.waitForSelector('#rd-secret');
    assert.match(await text(page, '#rd-body'), /비워 두어도 열려요/);
    await page.evaluate(() => document.querySelector('input[name="rd-mode"][value="pass"]').click());
    await fill(page, '#rd-secret', 'synthetic-backup-pass');
    await fill(page, '#rd-wallet-pass', 'synthetic-wallet-pass');
    await click(page, '#rd-open');
    await page.waitForSelector('#rd-apply');
    assert.match(await text(page, '#rd-items'), /회원 12명/);
    assert.equal(await page.evaluate(() => window.__bd.args.restore_drop_open.mode), 'pass');
    await click(page, '#rd-ok');
    await click(page, '#rd-apply');
    await page.waitForFunction(() => /노드가 아직 켜져 있어요/.test(document.querySelector('#rd-result').textContent));
    assert.equal(await page.evaluate(() => window.__bd.args.restore_drop_apply.secret), 'synthetic-backup-pass');
    assert.equal(await page.$eval('#rd-apply', (b) => b.disabled), false, '노드를 끄고 다시 누를 수 있다');
    // 닫으면 그만두기(Rust 가 표와 임시물을 치운다) + 비밀 칸 비움.
    await click(page, '#rd-close');
    await page.waitForFunction(() => !document.getElementById('rd-dialog'));
    assert.ok((await calls(page)).includes('restore_drop_cancel'));
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

test('메뉴 「백업에서 되돌리기」로 고른 잠근 백업(.pxlock·.rvwallet)도 같은 확인 창(재인증) · 옛 restore_survey/restore_apply 를 안 부른다 · zip 은 옛 길', async () => {
  for (const pick of ['/Volumes/SYNTHETIC-USB/RavenVault-2026-10-11.zip.pxlock', '/Volumes/SYNTHETIC-USB/RavenVault-wallet-20261012.rvwallet']) {
    const { page, errors } = await open({ pick });
    try {
      await click(page, '#rs-pick');
      await page.waitForSelector('#rd-dialog');
      const cs = await calls(page);
      assert.ok(cs.includes('restore_drop_inspect'), cs.join(','));
      assert.ok(!cs.includes('restore_survey') && !cs.includes('restore_apply'), '옛 길(재인증 없음)로 들어갔다: ' + cs.join(','));
      await click(page, '#rd-prepare');
      await page.waitForSelector('#rd-wallet-pass'); // 지갑 암호 재인증 칸
      assert.deepEqual(errors, []);
    } finally { await page.close(); }
  }
  const { page } = await open({ pick: '/Volumes/SYNTHETIC-USB/old-backup.zip' });
  try {
    await click(page, '#rs-pick');
    await page.waitForFunction(() => window.__bd.calls.includes('restore_survey'));
    assert.equal(await page.evaluate(() => !!document.getElementById('rd-dialog')), false);
  } finally { await page.close(); }
});

test('사진 놓기는 그대로 자산 드롭 · 사진+백업 섞어 놓기는 백업만 보고 자산 흐름으로 안 감 · 두 개는 하나씩', async () => {
  const { page, errors } = await open();
  try {
    await drop(page, ['/Users/synthetic/photo.png']);
    await new Promise((r) => setTimeout(r, 400));
    assert.equal(await page.evaluate(() => document.getElementById('rd-dialog')), null, '사진에 복원 창이 뜨면 안 된다');
    assert.ok(!(await calls(page)).includes('restore_drop_inspect'));
    // 기존 흐름의 안내(설정 화면에서는 「여기서는 받지 않습니다」 류)가 뜬다 — 닫는다.
    await page.evaluate(() => document.querySelectorAll('dialog[open] button, .modal button').forEach((b) => { if (/알겠습니다|닫기/.test(b.textContent)) b.click(); }));
    await drop(page, ['/Users/synthetic/photo.png', '/Volumes/SYNTHETIC-USB/RavenVault-wallet-20261012.rvwallet']);
    await page.waitForSelector('#rd-scope');
    assert.match(await text(page, '#rd-body'), /다른 파일과 같이 놓으셨어요|다른 파일을 같이 놓으셨어요/);
    assert.equal(await page.evaluate(() => window.__bd.args.restore_drop_inspect.path), '/Volumes/SYNTHETIC-USB/RavenVault-wallet-20261012.rvwallet');
    await click(page, '#rd-close');
    await drop(page, ['/a/RavenVault.zip.pxlock', '/b/RavenVault-wallet-1.rvwallet']);
    await page.waitForFunction(() => /하나씩/.test(document.querySelector('#rd-body')?.textContent || ''));
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

test('레이븐 코어로 옮기기: ① 안내 → ② 지갑 암호 → ③ 폴더 → ④ 코어에서 할 일 · 잠기지 않은 파일 경고 · 약한 암호 경고 · 암호 칸 비움', async () => {
  const { page, errors } = await open({ weak: true });
  try {
    await click(page, '#wf-core-start');
    await page.waitForSelector('#wf-core-guide');
    assert.match(await text(page, '#wf-core-guide'), /52글자로 잠그지 않은 wallet\.dat.*지갑 암호로 암호화.*주소와 거래 내역은 지갑 암호 없이도/s);
    assert.equal(await page.$eval('#wf-core-next1', (b) => b.disabled), true);
    await click(page, '#wf-core-read');
    await click(page, '#wf-core-next1');
    await page.waitForSelector('#wf-core-pass');
    assert.equal(await page.$eval('#wf-core-go', (b) => b.disabled), true, '폴더를 고르기 전에는 못 누른다');
    await fill(page, '#wf-core-pass', 'synthetic-wallet-pass');
    await click(page, '#wf-core-pick');
    await page.waitForFunction(() => !document.querySelector('#wf-core-go').disabled);
    await click(page, '#wf-core-go');
    await page.waitForSelector('#wf-core-todo');
    const a = await page.evaluate(() => window.__bd.args.wallet_core_export);
    assert.deepEqual([a.dest, a.walletPass], ['/Volumes/SYNTHETIC-USB', 'synthetic-wallet-pass']);
    assert.match(await text(page, '#wf-core-body'), /wallet-for-ravencoin-core-20261012-120000\.dat/);
    assert.match(await text(page, '#wf-core-unlocked'), /52글자 열쇠로 잠기지 않아요/);
    assert.match(await text(page, '#wf-core-weak'), /10글자보다 짧아요/);
    assert.match(await text(page, '#wf-core-todo'), /완전히 끈 상태.*코어 버전에 따라 다를 수 있어요.*지우지 마세요.*동시에 쓰지 마세요/s);
    assert.ok(!(await page.evaluate(() => document.body.innerText)).includes('synthetic-wallet-pass'));
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

test('레이븐 코어로 옮기기: 지갑 암호가 없으면 시작하지 않고 암호 걸기 안내 · wallet_core_export 를 부르지 않는다', async () => {
  const { page } = await open({ encrypted: false });
  try {
    await click(page, '#wf-core-start');
    await page.waitForSelector('#wf-need-pass');
    assert.ok(!(await calls(page)).includes('wallet_core_export'));
    assert.equal(await page.evaluate(() => document.getElementById('wf-core-guide')), null);
  } finally { await page.close(); }
});

for (const [lang, marker] of [['en', /Restore from this backup\?/], ['ja', /このバックアップから復元しますか/], ['zh', /要从这个备份恢复吗/], ['de', /Restore from this backup\?/]]) {
  test(`확인 창 말 — ${lang}`, async () => {
    const { page, errors } = await open({ lang }, { settings: false });
    try {
      await drop(page, ['/Volumes/SYNTHETIC-USB/RavenVault-wallet-20261012.rvwallet']);
      await page.waitForSelector('#rd-scope');
      assert.match(await text(page, '#rd-body'), marker);
      assert.doesNotMatch(await text(page, '#rd-body'), /[가-힣]/, `${lang}: 한국어가 남음`);
      assert.deepEqual(errors, []);
    } finally { await page.close(); }
  });
}
