// 「기기 연결」 · 「상품 대량 등록」 실제 Chrome 시험 (운영 빌드, 가짜 키·가짜 CSV 만 — 노드·IPFS·지갑·네트워크 접근 없음).
// 1440/390 × 밝게/어둡게 넘침, 기기 목록 상태(쓰는 중·기간 지남·끊음), 연결 전 표시, 대량 등록 오류 표, 올리기 잠금(CREATOR_PUBLISH_PAUSED)이 단추를 막는지.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { resolve, join, extname, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { build } from 'esbuild';
import puppeteer from 'puppeteer-core';
import { secp256k1 } from '@noble/curves/secp256k1';
import { installFixture } from './desktop-fixture.mjs';

globalThis.navigator ??= { language: 'ko' };
const root = resolve(import.meta.dirname, '..');
const built = await build({ entryPoints: [join(root, 'scripts/fixtures/biz-entry.ts')], bundle: true, write: false, platform: 'node', format: 'cjs', logLevel: 'silent', loader: { '.css': 'empty' } });
const mod = { exports: {} };
new Function('require', 'exports', 'module', built.outputFiles[0].text)(createRequire(import.meta.url), mod.exports, mod);
const B = mod.exports;

const DAY = 86_400_000;
const STORE_PRIV = B.fakePriv(7), STORE_KEY = B.pubOf(STORE_PRIV);
const K = { storeId: 'ab'.repeat(32), storeKey: STORE_KEY, sign: B.signerOf(STORE_PRIV) };
const dev = n => B.pubOf(B.fakePriv(n));

/** 지금 시각 기준 가짜 기기 셋: 쓰는 중 · 기간 지남 · 끊음. 목록은 방금 서명(하루 안). */
async function seed() {
  const now = Date.now();
  let s = B.emptyState();
  // 오래된 것부터(철회 목록 시각이 뒤로 가면 증서가 「아직 아님」이 된다)
  let r = await B.issueFor(s, K, { devicePubKey: dev(12), role: 'staff-pc', ttlMs: 1 * DAY, name: '직원 컴퓨터' }, now - 5 * DAY); s = r.state;
  r = await B.issueFor(s, K, { devicePubKey: dev(11), role: 'remote', ttlMs: 7 * DAY, name: '매장 폰' }, now - 2 * DAY); s = r.state;
  r = await B.issueFor(s, K, { devicePubKey: dev(13), role: 'scanner', ttlMs: 14 * DAY, name: '입구 확인 단말' }, now - 1 * DAY); s = r.state;
  s = await B.revokeFor(s, K, B.deviceIdOf(dev(13)), now - 3600_000);
  s.lastSeen = { [B.deviceIdOf(dev(11))]: now - 5 * 60_000 };
  return s;
}

let work, dist, browser, server, origin, shotDir;
before(async () => {
  work = mkdtempSync(join(tmpdir(), 'rv-biz-ui-'));
  shotDir = process.env.RV_BIZ_SHOTS || join(work, 'shots'); mkdirSync(shotDir, { recursive: true });
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
  browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true, userDataDir: join(work, 'profile'), args: ['--no-sandbox', '--disable-gpu'] });
});
after(async () => { await browser?.close(); server?.close(); if (work && !process.env.RV_KEEP_WORK) rmSync(work, { recursive: true, force: true }); });

async function openApp({ width = 1440, height = 900, theme = 'light', state = null, prepare = null } = {}) {
  const page = await browser.newPage();
  page.on('pageerror', e => { page.__errors = [...(page.__errors ?? []), e.message]; });
  await page.setViewport({ width, height });
  await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: theme }, { name: 'prefers-reduced-motion', value: 'reduce' }]);
  await page.setRequestInterception(true);
  page.on('request', r => (new URL(r.url()).origin === origin && r.method() === 'GET') ? r.continue() : r.abort());
  await page.evaluateOnNewDocument(installFixture, { theme, sales: true, seller: true });
  if (prepare) await prepare(page);
  if (state) await page.evaluateOnNewDocument(s => localStorage.setItem('rv-devices-v1', s), JSON.stringify(state));
  await page.goto(origin + '/', { waitUntil: 'networkidle0' });
  await page.waitForFunction(() => document.querySelector('#page-home.on') && !document.documentElement.hasAttribute('data-ravi-arriving'), { timeout: 20000 });
  await page.evaluate(() => document.querySelector('nav')?.classList.add('more-open'));
  await page.click('nav a[data-page="games"]');
  await page.waitForFunction(() => document.querySelector('#page-games.on'));
  return page;
}
const overflow = page => page.evaluate(() => ({ doc: document.documentElement.scrollWidth - innerWidth, body: document.body.scrollWidth - innerWidth,
  wide: [...document.querySelectorAll('.page.on *')].filter(e => { const r = e.getBoundingClientRect(); return r.width > 0 && r.right > innerWidth + 1 && !e.closest('.dv-tablewrap, .bk-tablewrap, .bk-example, pre, textarea'); }).slice(0, 5).map(e => e.tagName + '.' + e.className) }));
const calls = page => page.evaluate(() => window.__homeFixture.calls.slice());
const FORBIDDEN = /sign_message|issue_asset|ipfs_add_file|send_rvn|send_asset|creator_/;

for (const [width, theme] of [[1440, 'light'], [1440, 'dark'], [390, 'light']]) {
  test(`기기 연결 ${width} ${theme}: 목록 3줄 · 상태 · 연결 전 표시 · 발급/끊기 닫힘 · 넘침 없음`, async () => {
    const page = await openApp({ width, height: width === 390 ? 844 : 900, theme, state: await seed() });
    const base = await overflow(page); // 이 앱 화면이 원래 좁은 창에서 얼마나 넘치는지(기준) — 새 화면은 기준보다 더 넘치면 안 된다
    await page.click('#devices-open');
    await page.waitForFunction(() => document.querySelector('#page-devices.on #dv-rows tr'), { timeout: 15000 });
    const rows = await page.$$eval('#dv-rows tr', trs => trs.map(tr => ({ status: tr.dataset.status, text: tr.innerText.replace(/\s+/g, ' ').trim() })));
    assert.equal(rows.length, 3);
    assert.deepEqual(rows.map(r => r.status).sort(), ['active', 'expired', 'revoked']);
    const phone = rows.find(r => r.text.includes('매장 폰')); assert.match(phone.text, /원격 폰/); assert.match(phone.text, /\d{4}-\d{2}-\d{2}/); assert.match(phone.text, /5분 전/); assert.match(phone.text, /쓰는 중/);
    assert.match(rows.find(r => r.status === 'expired').text, /기간 지남/); assert.match(rows.find(r => r.status === 'revoked').text, /끊음/);
    assert.equal((await page.$$('#dv-rows [data-revoke]')).length, 1, '끊기는 쓰는 중인 기기에만');
    const txt = await page.$eval('#page-devices', e => e.innerText.replace(/\s+/g, ' '));
    for (const need of ['가게 키 서명이 아직 연결되지 않았어요', '연결 전', '이미 복사된 지난 데이터는 되돌릴 수 없어요', '(기본 · 잠정)', '철회 목록']) assert.ok(txt.includes(need), need);
    assert.equal(await page.$eval('#dv-issue', b => b.disabled), true, '가게 키 연결 전에는 발급 단추가 닫힘');
    assert.equal(await page.$eval('#dv-resign', b => b.disabled), true);
    // QR: 이 시험 환경에는 pairing_show_qr 가 없다 → 실패를 정직하게 말한다(가짜 QR 없음)
    await page.click('#dv-qr');
    await page.waitForFunction(() => /QR 을 만들지 못했어요/.test(document.getElementById('dv-say').textContent), { timeout: 5000 });
    assert.equal(await page.$eval('#dv-qrbox', e => e.hidden), true);
    // 끊기 단추: 가게 키가 없으므로 확인창 전에 막힌다
    await page.click('#dv-rows [data-revoke]');
    await page.waitForFunction(() => /서명이 아직 연결되지 않았어요/.test(document.getElementById('dv-say').textContent), { timeout: 5000 });
    assert.equal(await page.$eval('#askwrap', e => e.classList.contains('on')), false);
    const o = await overflow(page); assert.ok(o.doc <= Math.max(0, base.doc) && o.body <= Math.max(0, base.body) && o.wide.length === 0, JSON.stringify({ o, base }));
    assert.deepEqual((await calls(page)).filter(c => FORBIDDEN.test(c)), []);
    assert.deepEqual(page.__errors ?? [], []);
    await page.screenshot({ path: join(shotDir, `devices-${width}-${theme}.png`), fullPage: true });
    await page.close();
  });
}

const CSV = [
  '제목,종류,가격,설명,파일 URL,파일 SHA256,파일 크기,다운로드 기간 일수,재고',
  `여름 사진집,digital,1.5,고화질 사진,https://files.example.com/a.zip,${'a'.repeat(64)},52428800,30,100`,
  `=HYPERLINK("http://x"),digital,2,수식 같은 제목,,,,,`,
  `,digital,1,,,,,,`,
  `연습 음악,music,-3,,,,,,`,
  `사진집 둘째,digital,0.0015,,http://insecure.example.com/b.zip,${'b'.repeat(64)},100,,`,
].join('\n');

for (const [width, theme] of [[1440, 'light'], [1440, 'dark'], [390, 'light']]) {
  test(`상품 대량 등록 ${width} ${theme}: 줄 번호 오류 · 수식 경고 · 초안 · 올리기 잠금 · 넘침 없음`, async () => {
    const page = await openApp({ width, height: width === 390 ? 844 : 900, theme });
    const base = await overflow(page);
    await page.click('#bulk-open');
    await page.waitForFunction(() => document.querySelector('#page-bulk.on #bk-file'), { timeout: 15000 });
    let txt = await page.$eval('#page-bulk', e => e.innerText.replace(/\s+/g, ' '));
    for (const need of ['지금은 올리기를 잠가 두었어요', '수식으로 실행할 수 있어요', '여름 사진집,digital,1.5']) assert.ok(txt.includes(need), need);
    const file = join(work, `bulk-${width}-${theme}.csv`); await writeFile(file, CSV);
    await (await page.$('#bk-file')).uploadFile(file);
    await page.waitForFunction(() => document.querySelectorAll('#bk-draftrows tr').length > 0, { timeout: 15000 });
    assert.equal(await page.$$eval('#bk-draftrows tr', t => t.length), 2, '정상 줄 + 수식 제목(경고) 줄은 초안');
    const errs = await page.$$eval('#bk-errrows tr', trs => trs.map(tr => [...tr.children].map(td => td.innerText.trim())));
    assert.ok(errs.some(([line, col, why]) => line === '4' && col === '제목' && /비어/.test(why)), JSON.stringify(errs));
    assert.ok(errs.some(([line, , why]) => line === '5' && /가격/.test(why)), JSON.stringify(errs));
    assert.ok(errs.some(([line, , why]) => line === '6' && /https/.test(why)), JSON.stringify(errs));
    const warns = await page.$$eval('#bk-warnrows tr', trs => trs.map(tr => tr.innerText.replace(/\s+/g, ' ')));
    assert.ok(warns.some(w => w.startsWith('3') && /수식/.test(w)), JSON.stringify(warns));
    txt = await page.$eval('#page-bulk', e => e.innerText.replace(/\s+/g, ' '));
    assert.ok(txt.includes('판매자 정보가 아직 연결되지 않아'), '임시 값 표시');
    // 확인해도 올리기는 잠겨 있다
    await page.click('#bk-draftrows [data-confirm]');
    assert.equal(await page.$$eval('#bk-draftrows [data-sign]', bs => bs.every(b => b.disabled)), true);
    assert.match(await page.$eval('#bk-draftrows tr .bk-gate', e => e.innerText), /잠가 두었어요/);
    await page.evaluate(() => document.querySelector('#bk-draftrows [data-sign]').click()); // 닫힌 단추를 강제로 눌러도
    assert.deepEqual((await calls(page)).filter(c => FORBIDDEN.test(c)), []);
    assert.equal(await page.$$eval('#bk-draftrows tr[data-done="true"]', t => t.length), 0);
    const o = await overflow(page); assert.ok(o.doc <= Math.max(0, base.doc) && o.body <= Math.max(0, base.body) && o.wide.length === 0, JSON.stringify({ o, base }));
    assert.deepEqual(page.__errors ?? [], []);
    await page.screenshot({ path: join(shotDir, `bulk-${width}-${theme}.png`), fullPage: true });
    await page.close();
  });
}

/** 가게 키 PC 흉내: Rust 명령 store_key_info · store_sign_digest 만 가짜 키(fakePriv 7)로 답한다. 사장 확인창은 시험이 대신 눌렀다고 치고 사유만 기록한다. */
const fakeKeyPc = signed => async page => {
  await page.exposeFunction('__fakeStoreKey', () => STORE_KEY);
  await page.exposeFunction('__fakeStoreSign', (digestHex, reason) => {
    signed.push(reason);
    return secp256k1.sign(Uint8Array.from(digestHex.match(/../g), b => parseInt(b, 16)), STORE_PRIV, { lowS: true }).toCompactHex();
  });
  await page.evaluateOnNewDocument(() => {
    const orig = window.__TAURI_INTERNALS__.invoke;
    const inv = async (cmd, args) => {
      if (cmd === 'store_key_info') return { store_key: await window.__fakeStoreKey(), fingerprint: '' };
      if (cmd === 'store_sign_digest') return { store_key: await window.__fakeStoreKey(), sig: await window.__fakeStoreSign(args.digest, args.reason) };
      return orig(cmd, args);
    };
    window.__TAURI_INTERNALS__.invoke = inv; window.__TAURI__.core.invoke = inv;
    // 파일 내보내기는 받은 글만 기록한다(실제 다운로드 없음)
    window.__exported = [];
    const make = URL.createObjectURL.bind(URL);
    URL.createObjectURL = blob => { blob.text().then(t => window.__exported.push(t)); return make(blob); };
    HTMLAnchorElement.prototype.click = function () { window.__exportName = this.download; };
  });
};
const answer = async (page, yes) => {
  await page.waitForFunction(() => document.getElementById('askwrap')?.classList.contains('on'), { timeout: 5000 });
  const text = await page.$eval('#askwrap', e => e.innerText.replace(/\s+/g, ' '));
  await page.click(yes ? '#ask-yes' : '#ask-no');
  await page.waitForFunction(() => !document.getElementById('askwrap')?.classList.contains('on'), { timeout: 5000 });
  return text;
};

for (const [width, theme] of [[1440, 'light'], [390, 'dark']]) {
  test(`가게 번호 ${width} ${theme}: 문서 만들기 → 번호 → 증서 발급(폰 core 확인) → 끊기 → 내보내기(한 번 더 확인) · 올리기 없음 · 넘침 없음`, async () => {
    const signed = [];
    const page = await openApp({ width, height: width === 390 ? 844 : 900, theme, prepare: fakeKeyPc(signed) });
    const base = await overflow(page);
    await page.click('#devices-open');
    await page.waitForFunction(() => document.querySelector('#page-devices.on #sd-create'), { timeout: 15000 });
    await page.waitForFunction(() => /가게 문서\(번호\)가 아직 없어/.test(document.getElementById('dv-keystate').textContent), { timeout: 5000 });
    assert.equal(await page.$eval('#dv-issue', b => b.disabled), true, '번호가 없으면 발급 닫힘');
    assert.equal(await page.$eval('#dv-resign', b => b.disabled), true);
    // 빈 이름 → 서명 확인창 전에 막힌다
    await page.type('#sd-region', '서울 마포'); await page.select('#sd-category', 'retail');
    await page.click('#sd-create');
    await page.waitForFunction(() => /가게 이름이나 소개 글/.test(document.getElementById('sd-say').textContent), { timeout: 5000 });
    assert.equal(signed.length, 0); assert.equal(await page.$eval('#askwrap', e => e.classList.contains('on')), false);
    // 만들기: 확인창에서 취소 → 아무것도 서명/저장 안 함
    await page.type('#sd-name', '무송 체육관 스토어');
    await page.click('#sd-create');
    const ask = await answer(page, false);
    assert.match(ask, /가게 문서를 만들까요/); assert.match(ask, /무송 체육관 스토어/); assert.match(ask, /어디에도 올리지 않아요/);
    assert.equal(signed.length, 0); assert.equal(await page.evaluate(() => localStorage.getItem('rv-store-doc-v1')), null);
    // 만들기: 확인 → 서명 1번(사유 전달) → 번호 표시 → 발급 열림
    await page.click('#sd-create'); await answer(page, true);
    await page.waitForFunction(() => /^[0-9a-f]{64}$/.test(document.getElementById('sd-id').textContent), { timeout: 10000 });
    const storeId = await page.$eval('#sd-id', e => e.textContent);
    assert.deepEqual(signed, [B.STORE_DOC_REASON]);
    assert.equal(storeId, B.storeIdOf(JSON.parse(await page.evaluate(() => localStorage.getItem('rv-store-doc-v1'))).doc));
    const txt = await page.$eval('#dv-storecard', e => e.innerText.replace(/\s+/g, ' '));
    for (const need of ['서명 확인됨 · 키 지문', '어디에도 올리지 않았어요', '파일로 내보내기']) assert.ok(txt.includes(need), need);
    assert.equal(await page.$eval('#sd-form', e => e.hidden), true, '한 번 만들면 다시 만드는 입력은 닫힌다');
    await page.waitForFunction(() => !document.getElementById('dv-issue').disabled, { timeout: 5000 });
    assert.equal(await page.$eval('#dv-resign', b => b.disabled), false);
    // 새로 열어도 번호가 남는다(이 기기 저장)
    // 증서 발급
    const devPub = dev(41);
    await page.type('#dv-name', '매장 폰'); await page.type('#dv-pub', devPub);
    await page.click('#dv-issue');
    await page.waitForFunction(() => document.getElementById('dv-cert').value.length > 50, { timeout: 10000 });
    const cert = JSON.parse(await page.$eval('#dv-cert', e => e.value));
    const list = JSON.parse(await page.evaluate(() => localStorage.getItem('rv-devices-v1'))).list;
    assert.equal(cert.storeId, storeId);
    assert.equal(B.verifyDeviceCert(cert, STORE_KEY, Date.now(), list).ok, true, '폰 core 가 확인');
    assert.ok(signed.some(r => /기기 증서 발급/.test(r)));
    // 끊기
    await page.click('#dv-rows [data-revoke]'); await answer(page, true);
    await page.waitForFunction(() => /기기를 끊었어요/.test(document.getElementById('dv-say').textContent), { timeout: 10000 });
    const list2 = JSON.parse(await page.evaluate(() => localStorage.getItem('rv-devices-v1'))).list;
    assert.equal(B.verifyDeviceCert(cert, STORE_KEY, Date.now(), list2).ok, false);
    assert.equal(await page.$eval('#dv-rows tr', tr => tr.dataset.status), 'revoked');
    // 내보내기: 한 번 더 확인 → 취소하면 아무것도 안 나감, 확인하면 파일(정본 JSON)만
    await page.click('#sd-export');
    const ask2 = await answer(page, false);
    assert.match(ask2, /내보내기 전에 한 번 더 확인/); assert.match(ask2, /되돌릴 수 없어요/);
    assert.equal(await page.evaluate(() => window.__exported.length), 0);
    await page.click('#sd-export'); await answer(page, true);
    await page.waitForFunction(() => window.__exported.length === 1, { timeout: 5000 });
    const fileText = await page.evaluate(() => window.__exported[0]);
    const v = B.verifyStoreDoc(new TextEncoder().encode(fileText), { now: Math.floor(Date.now() / 1000), expectedId: storeId });
    assert.equal(v.idProven, true);
    assert.equal(await page.evaluate(() => window.__exportName), `rv-store-${storeId.slice(0, 12)}.json`);
    // 올리기/네트워크 호출 없음, 옛 임시 연결점 안 씀
    assert.deepEqual((await calls(page)).filter(c => FORBIDDEN.test(c) || /^store_(doc|publish|upload)/.test(c)), []);
    assert.equal(await page.evaluate(() => localStorage.getItem('rv.store-doc-id')), null);
    const o = await overflow(page); assert.ok(o.doc <= Math.max(0, base.doc) && o.body <= Math.max(0, base.body) && o.wide.length === 0, JSON.stringify({ o, base }));
    assert.deepEqual(page.__errors ?? [], []);
    await page.screenshot({ path: join(shotDir, `store-doc-${width}-${theme}.png`), fullPage: true });
    await page.close();
  });
}
