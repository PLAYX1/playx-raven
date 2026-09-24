// 증명서 「한 번에 여러 장」 화면 검사 — 합성 브라우저 렌더링만.
// Tauri·노드·지갑·IPFS 는 켜지 않는다. 모든 러스트 부름은 페이지를 열기 전에 가짜로 바꾼다.
// 🔴 진짜 RVN 은 한 푼도 안 쓴다(create_issue 는 가짜가 txid 만 돌려준다).
//
// 보는 것:
//   · 50줄 엑셀 올리기 → 사진 50장 짝짓기 → 확인 → 합계·잔액 → 만들기 → 결과, 걸린 시간(8초 취소 창 빼고)
//   · 잔액이 모자라면 만들기 단추가 없다
//   · 120줄 = 50·50·20 세 조각, 조각마다 다른 차례(run) 이름 — 방금 보낸 이름을 다시 고르지 않는다
//   · 중간 조각이 분명히 실패 → 그 기록은 지우고 멈춤 → 「나머지 이어서」로 남은 조각만
//   · 보냈는지 모름 → 그 화면으로 가고 더 보내지 않는다
//   · 붙여넣기(탭) · 열 맞추기 · 샘플 표 · 번호 목록 표 · 전체/한 사람 인쇄 · 라비(문구·명단 사진)
//   · 🔴 받는 사람 이름이 AI 문구 부름에 섞이지 않는다
//   · 캡처: 세 양식 × (짧은 이름 · 20자 · 영문) × 데스크톱·폰(390px)
//
// 먼저 `npx vite build` 로 dist 를 만든다. 캡처는 RV_CERT_SHOTS(기본 artifacts/claude-cert-bulk)에.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';
import * as XLSX from 'xlsx';

const root = fileURLToPath(new URL('../', import.meta.url));
const dist = path.join(root, 'dist');
const shots = path.resolve(root, process.env.RV_CERT_SHOTS || 'artifacts/claude-cert-bulk');
assert.ok(fs.existsSync(path.join(dist, 'index.html')), 'dist 가 없다 — 먼저 npx vite build');
fs.mkdirSync(shots, { recursive: true });
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'rv-cert-bulk-'));
const samples = path.join(work, 'samples'), assets = path.join(work, 'assets'), photos = path.join(work, 'photos');
for (const d of [samples, assets, photos]) fs.mkdirSync(d);

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'rv-cert-bulk-chrome-'));
const browser = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true, userDataDir: profile });
let failed = 0, passed = 0;
const timings = {};
const ok = async (name, fn) => {
  try { await fn(); passed++; console.log(`PASS ${name}`); } catch (e) { failed++; console.log(`FAIL ${name}\n${e.stack || e}`); }
};

// ── 견본 그림: 로고 · 도장 · 증명사진 50장(이름이 파일 이름) ──
const PEOPLE = Array.from({ length: 120 }, (_, i) => `수강생${String(i + 1).padStart(3, '0')}`);
{
  const p = await browser.newPage();
  const drawn = await p.evaluate((people) => {
    const url = (w, h, draw, type = 'image/png') => { const c = document.createElement('canvas'); c.width = w; c.height = h; draw(c.getContext('2d')); return c.toDataURL(type, 0.9); };
    const logo = url(600, 200, (g) => {
      g.fillStyle = '#1d3557'; g.beginPath(); g.arc(100, 100, 80, 0, Math.PI * 2); g.fill();
      g.fillStyle = '#fff'; g.font = 'bold 70px sans-serif'; g.textAlign = 'center'; g.fillText('HB', 100, 125);
      g.fillStyle = '#1d3557'; g.textAlign = 'left'; g.font = 'bold 64px sans-serif'; g.fillText('HANBIT', 210, 125);
    });
    const stamp = url(300, 300, (g) => {
      g.strokeStyle = '#c0392b'; g.lineWidth = 16; g.strokeRect(20, 20, 260, 260);
      g.fillStyle = '#c0392b'; g.font = 'bold 96px serif'; g.textAlign = 'center'; g.fillText('한빛', 150, 130); g.fillText('之印', 150, 245);
    });
    const face = (hue) => url(600, 800, (g) => {
      g.fillStyle = `hsl(${hue},35%,86%)`; g.fillRect(0, 0, 600, 800);
      g.fillStyle = `hsl(${hue},25%,40%)`; g.beginPath(); g.arc(300, 300, 150, 0, Math.PI * 2); g.fill();
      g.beginPath(); g.ellipse(300, 760, 280, 260, 0, Math.PI, 0); g.fill();
    }, 'image/jpeg');
    return { logo, stamp, faces: people.slice(0, 50).map((_, i) => face((i * 37) % 360)) };
  }, PEOPLE);
  await p.close();
  const bytes = (u) => Buffer.from(u.split(',')[1], 'base64');
  fs.writeFileSync(path.join(assets, 'logo.png'), bytes(drawn.logo));
  fs.writeFileSync(path.join(assets, 'stamp.png'), bytes(drawn.stamp));
  fs.writeFileSync(path.join(assets, 'photo.jpg'), bytes(drawn.faces[0]));
  drawn.faces.forEach((f, i) => fs.writeFileSync(path.join(photos, `${PEOPLE[i]}.jpg`), bytes(f)));
}
const cargo = spawnSync('cargo', ['test', '--lib', 'certificate::tests::견본_쓰기', '--', '--exact'], {
  cwd: path.join(root, 'src-tauri'), env: { ...process.env, RV_CERT_SAMPLE_DIR: samples, RV_CERT_SAMPLE_ASSETS: assets }, encoding: 'utf8',
});
assert.equal(cargo.status, 0, cargo.stderr.slice(-2000));
const sample = (name) => fs.readFileSync(path.join(samples, name), 'utf8');
const SAMPLES = {};
for (const t of ['course', 'proof', 'thanks']) for (const v of ['short', 'long', 'latin', 'brand']) SAMPLES[`${t}-${v}`] = sample(`preview-${t}-${v}.txt`);
const FONTS = sample('fonts.css');
const dataUrl = (file, mime) => `data:${mime};base64,${fs.readFileSync(file).toString('base64')}`;
const MARKS = { logo: dataUrl(path.join(assets, 'logo.png'), 'image/png'), stamp: dataUrl(path.join(assets, 'stamp.png'), 'image/png') };

// ── 명단 표 ──
const HEAD = ['받는 사람', '과정', '등급', '발급일', '번호', '사진 파일명', '비고'];
function rosterXlsx(n, extra = []) {
  const rows = PEOPLE.slice(0, n).map((p, i) => [p, '필라테스 지도자 과정', i % 2 ? '1급' : '2급', '2026-09-24', `HB-2026-${String(i + 1).padStart(4, '0')}`, `${p}.jpg`, '']);
  const ws = XLSX.utils.aoa_to_sheet([HEAD, ...rows, ...extra]);
  const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, '명단');
  const file = path.join(work, `roster-${n}.xlsx`);
  fs.writeFileSync(file, XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }));
  return file;
}
const R50 = rosterXlsx(50, [['', '빈 이름 줄', '', '', '', '', ''], ['날짜틀림', '필라테스 지도자 과정', '', '2026-13-45', '', '', '']]);
const R120 = rosterXlsx(120);

// ── 가짜 러스트 ──
const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css', '.webp': 'image/webp', '.png': 'image/png', '.svg': 'image/svg+xml' };
const server = http.createServer((q, r) => {
  const p = path.resolve(dist, '.' + (new URL(q.url, 'http://x').pathname === '/' ? '/index.html' : new URL(q.url, 'http://x').pathname));
  if (!p.startsWith(dist + path.sep) || !fs.existsSync(p)) { r.writeHead(404).end(); return; }
  r.writeHead(200, { 'content-type': mime[path.extname(p)] || 'application/octet-stream' }); r.end(fs.readFileSync(p));
});
await new Promise((done) => server.listen(0, '127.0.0.1', done));
const origin = `http://127.0.0.1:${server.address().port}`;

async function openApp({ width = 1280, height = 900, language = 'ko', spendable = 300, brands = ['HANBIT'], keys = { anthropic: true } } = {}) {
  // 화면마다 새 저장소 — 앞 시험의 이어하기 표(localStorage)가 다음 시험을 막지 않게.
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('dialog', (d) => d.dismiss());
  await page.setViewport({ width, height });
  await page.setRequestInterception(true);
  page.on('request', (q) => (q.url().startsWith(origin + '/') || q.url().startsWith('data:') || q.url().startsWith('blob:') ? q.continue() : q.abort()));
  await page.evaluateOnNewDocument((cfg) => {
    localStorage.setItem('playx-raven-lang', cfg.language);
    window.__S = { spendable: cfg.spendable, brands: cfg.brands, calls: [], history: [], issueFail: null, marks: { logo: null, stamp: null } };
    const S = window.__S;
    const id = () => Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    window.__TAURI_INTERNALS__ = {
      invoke: async (command, args) => {
        S.calls.push({ command, args: JSON.parse(JSON.stringify(args ?? null)), at: performance.now() });
        switch (command) {
          case 'plugin:app|version': return '0.4.7';
          case 'money_status': throw 'Synthetic status unavailable';
          case 'node_status': return { blocks: 1000, headers: 1000, progress: 1, peers: 3 };
          case 'api_key_status': return cfg.keys;
          case 'model_settings': return {};
          case 'list_assets': case 'pin_list': case 'my_channels': return [];
          case 'artist_profile_get': return { name: '', about: '', picture: '', website: '' };
          case 'create_status': return { brands: S.brands, pending: [], spendable: S.spendable, locked: false };
          case 'create_names_taken': return args.names.map(() => false);
          case 'create_unresolved': return null;
          case 'create_history_list': return S.history;
          case 'certificate_font_css': return cfg.fonts;
          case 'certificate_marks': return S.marks;
          case 'certificate_mark_save': S.marks[args.kind] = args.image; return S.marks;
          case 'certificate_mark_clear': S.marks[args.kind] = null; return S.marks;
          case 'create_certificate_preview': {
            const d = args.entry.details, who = d.recipients[0] || '';
            const v = args.entry.preview_photo && d.photo_slot ? 'brand' : /^[\x20-\x7e]+$/.test(who) ? 'latin' : [...who].length > 10 ? 'long' : 'short';
            return cfg.samples[`${d.template}-${v}`];
          }
          case 'create_history_begin': {
            const e = { id: id(), status: 'started', kind: args.entry.kind, title: args.entry.title, brand: args.entry.brand, count: args.entry.count, ...args.entry.details, names: [] };
            S.history.push(e); return e.id;
          }
          case 'create_photos_save': return args.photos.filter(Boolean).length;
          case 'create_history_forget': S.history = S.history.filter((e) => e.id !== args.id); return null;
          case 'create_history_get': return S.history.find((e) => e.id === args.id) ?? null;
          case 'create_issue': {
            await wait(S.issueWait ?? 250);
            const n = S.calls.filter((c) => c.command === 'create_issue').length;
            if (S.issueFail && S.issueFail.at === n) { const f = S.issueFail; S.issueFail = null; throw f.error; }
            const e = S.history.find((x) => x.id === args.historyId);
            if (e) { e.status = 'done'; e.names = args.names; e.done_at = Math.floor(Date.now() / 1000); }
            return { txid: 'ab'.repeat(32), owner_pinned: true };
          }
          case 'create_resolve': return { state: S.resolveState ?? 'sending' };
          case 'qr_svg': return '<svg viewBox="0 0 10 10"><rect width="10" height="10"/></svg>';
          case 'create_print': case 'create_print_many': return { path: '/synthetic/print.html' };
          case 'certificate_file_save': return { path: `/Users/x/Downloads/${args.name}`, where: '/Users/x/Downloads' };
          case 'ai_fill':
            if (args.task === 'cert_phrases') return { phrases: ['위 사람은 「{과정}」을 마쳤습니다.', '{이름} 님의 수료를 축하합니다.', '위 과정을 모두 이수하였음을 증명합니다.'] };
            return {};
          case 'ai_read_image': return { rows: [{ recipient: '홍길동', course: '', grade: '', date: '', number: '', note: '' }, { recipient: '김철수?', course: '', grade: '', date: '', number: '', note: '' }], unsure: [1], why: '' };
          default: return null;
        }
      }, transformCallback: (f) => f, metadata: {},
    };
  }, { language, spendable, brands, keys, samples: SAMPLES, fonts: FONTS });
  await page.goto(origin + '/', { waitUntil: 'networkidle0' });
  await page.addStyleTag({ content: '#onboard,#hello{display:none!important}' });
  await page.$eval('nav [data-page="assets"]', (e) => e.click());
  // 자산 화면 「지금 할 일」 첫 칸 = 만들기(말과 상관없이).
  await page.waitForSelector('#pt-assets [data-pt="0"]', { visible: true });
  await page.$eval('#pt-assets [data-pt="0"]', (e) => e.click());
  await page.waitForSelector('#page-create.on #cr-kinds [data-kind="certificate"]', { visible: true });
  await page.$eval('#cr-kinds [data-kind="certificate"]', (e) => e.click());
  await page.waitForSelector('#cr-form:not([hidden])');
  page.errors = errors;
  return page;
}
const calls = (page, command) => page.evaluate((c) => window.__S.calls.filter((x) => x.command === c), command);
const text = (page, sel) => page.$eval(sel, (e) => e.innerText);
async function type(page, sel, value) { await page.$eval(sel, (e) => { e.value = ''; }); await page.type(sel, value); }
async function upload(page, sel, files) { const h = await page.$(sel); await h.uploadFile(...files); }
async function hold(page) {
  // 8초 취소 창 — 기다린다(그만두기를 누르지 않는다).
  await page.waitForSelector('.holdbox', { visible: true });
  await page.waitForFunction(() => !document.querySelector('.holdbox'), { timeout: 15000 });
}
const photoFiles = PEOPLE.slice(0, 50).map((p) => path.join(photos, `${p}.jpg`));

try {
  // ── 1. 50줄 + 사진 50장 → 확인 → 잔액 모자람 → 채움 → 만들기 → 결과 ──
  await ok('50줄 엑셀 + 사진 50장: 확인 표 · 합계 · 잠금 · 발행 · 결과(가짜 노드)', async () => {
    const page = await openApp({ spendable: 100 });
    await type(page, '#cr-title', '필라테스 지도자 과정');
    const t0 = Date.now();
    await upload(page, '#cr-roster-in', [R50]);
    await page.waitForFunction(() => document.querySelectorAll('#cr-table tbody tr').length === 52, { timeout: 20000 });
    timings.table = Date.now() - t0;
    const t1 = Date.now();
    await upload(page, '#cr-photos-in', photoFiles);
    await page.waitForFunction(() => /사진 50장/.test(document.getElementById('cr-roster-sum').innerText), { timeout: 60000 });
    timings.photos = Date.now() - t1;
    const sum = await text(page, '#cr-roster-sum');
    assert.match(sum, /52줄 중 50장 발행/);
    assert.match(sum, /고칠 줄 2/);
    assert.ok(await page.$eval('#cr-photo-slot', (e) => e.checked), '사진을 짝지으면 사진 칸이 켜진다');
    assert.ok(await page.$eval('#cr-recipients-box', (e) => e.hidden), '표 모드에서는 받는 사람 칸이 숨는다');
    assert.ok(await page.$eval('#cr-count-wrap', (e) => e.hidden), '장수 칸이 숨는다');
    const states = await page.$$eval('#cr-table tbody tr', (rs) => rs.map((r) => ({ bad: r.classList.contains('bad'), state: r.cells[r.cells.length - 1].innerText })));
    assert.ok(states[50].bad && /받는 사람이 비어/.test(states[50].state), JSON.stringify(states[50]));
    assert.ok(states[51].bad && /발급일/.test(states[51].state), JSON.stringify(states[51]));
    // 줄을 누르면 미리보기가 그 사람으로(사진 칸 + 사진 → brand 견본)
    await page.$eval('#cr-table tbody tr:nth-child(3) td.cr-c-no', (e) => e.click());
    await page.waitForFunction(() => /3번째 줄/.test(document.getElementById('cr-preview-say').innerText));
    const pv = (await calls(page, 'create_certificate_preview')).at(-1).args.entry;
    assert.equal(pv.details.recipients[0], '수강생003');
    assert.equal(pv.details.rows[0].number, 'HB-2026-0003');
    assert.match(pv.preview_photo, /^data:image\/jpeg;base64,/);
    // 미리보기 틀 안에 글꼴이 들어갔다(생성 스타일시트 두 장: 글꼴 + 증서)
    await page.waitForFunction(() => document.getElementById('cr-preview').contentDocument?.adoptedStyleSheets?.length === 2, { timeout: 10000 });
    // 확인 — 잔액 100 < 250.16 → 만들기 단추 없음
    await page.$eval('#cr-check', (e) => e.click());
    await page.waitForSelector('#cr-review:not([hidden]) .cr-bill');
    const bill = await text(page, '#cr-review .cr-bill');
    assert.match(bill, /50장/); assert.match(bill, /250\.16 RVN/); assert.match(bill, /100 RVN/);
    assert.equal(await page.$('#cr-make'), null, '잔액이 모자라면 만들기 단추가 없다');
    assert.match(await text(page, '#cr-review'), /150\.16 RVN이 더 필요해요/);
    // 채우고 다시 확인
    await page.evaluate(() => { window.__S.spendable = 300; });
    await page.evaluate(() => [...document.querySelectorAll('#cr-review button')].find((b) => /다시 확인하기/.test(b.innerText)).click());
    await page.waitForSelector('#cr-make:not([disabled])');
    assert.match(await text(page, '#cr-make'), /50장 만들기/);
    const t2 = Date.now();
    await page.$eval('#cr-make', (e) => e.click());
    await hold(page);
    const t3 = Date.now();
    const doneAt = await (await page.waitForFunction(() => /50장을 만들었어요/.test(document.getElementById('cr-done').innerText) && performance.now(), { timeout: 30000, polling: 10 })).jsonValue();
    // 8초 취소 창이 끝난 때(첫 기록 열기) → 결과 화면까지. 가짜 노드는 발행 한 번에 250ms 를 쉰다.
    timings.issue = Math.round(doneAt - (await calls(page, 'create_history_begin'))[0].at);
    timings.holdWait = t3 - t2;
    const begin = await calls(page, 'create_history_begin');
    assert.equal(begin.length, 1);
    assert.equal(begin[0].args.entry.details.recipients.length, 50);
    assert.equal(begin[0].args.entry.details.rows.length, 50);
    assert.equal(begin[0].args.entry.details.photo_slot, true);
    const ph = await calls(page, 'create_photos_save');
    assert.equal(ph.length, 1); assert.equal(ph[0].args.photos.filter(Boolean).length, 50);
    const issue = await calls(page, 'create_issue');
    assert.equal(issue.length, 1); assert.equal(issue[0].args.names.length, 50);
    assert.equal(await page.$$eval('#cr-done .cr-list li', (l) => l.length), 50);
    // 결과: 전체 인쇄 · 한 사람 · 번호 목록 표
    await page.evaluate(() => [...document.querySelectorAll('#cr-done button')].find((b) => /전체 인쇄/.test(b.innerText)).click());
    await page.waitForFunction(() => window.__S.calls.some((c) => c.command === 'create_print_many'));
    await page.$eval('#cr-done .cr-list li:nth-child(7) .cr-one', (e) => e.click());
    await page.waitForFunction(() => window.__S.calls.some((c) => c.command === 'create_print'));
    const one = (await calls(page, 'create_print'))[0].args;
    assert.equal(one.index, 6);
    await page.evaluate(() => [...document.querySelectorAll('#cr-done button')].find((b) => /번호 목록 표/.test(b.innerText)).click());
    await page.waitForFunction(() => window.__S.calls.some((c) => c.command === 'certificate_file_save'));
    const list = (await calls(page, 'certificate_file_save'))[0].args;
    assert.equal(list.kind, 'list'); assert.ok(list.open);
    const wb = XLSX.read(Buffer.from(list.data, 'base64'), { type: 'buffer' });
    const aoa = XLSX.utils.sheet_to_json(wb.Sheets['발행 목록'], { header: 1 });
    assert.equal(aoa.length, 51);
    assert.equal(aoa[1][0], '수강생001'); assert.equal(aoa[1][4], 'HB-2026-0001');
    assert.match(aoa[1][7], /^https:\/\/ravenvault\.ex\.erci\.se\/verify\/\?a=HANBIT%23/);
    await page.screenshot({ path: path.join(shots, 'bulk-50-done.png'), fullPage: true });
    assert.deepEqual(page.errors, [], page.errors.join('\n'));
    await page.close();
  });

  // ── 2. 120줄 = 세 조각 · 조각마다 다른 차례 · 가운데 실패 → 이어서 ──
  await ok('120줄: 50·50·20 세 조각, 서로 다른 이름 차례, 가운데 실패 뒤 남은 것만 이어서', async () => {
    const page = await openApp({ spendable: 1000 });
    await type(page, '#cr-title', '필라테스 지도자 과정');
    await upload(page, '#cr-roster-in', [R120]);
    await page.waitForFunction(() => document.querySelectorAll('#cr-table tbody tr').length === 120, { timeout: 20000 });
    await page.evaluate(() => { window.__S.issueFail = { at: 2, error: '노드가 거절했어요: 합성 오류' }; });
    await page.$eval('#cr-check', (e) => e.click());
    await page.waitForSelector('#cr-make:not([disabled])');
    assert.match(await text(page, '#cr-review .cr-bill'), /120장/);
    assert.match(await text(page, '#cr-review'), /3번에 나눠 보내요/);
    await page.$eval('#cr-make', (e) => e.click());
    await hold(page);
    await page.waitForFunction(() => /120장 중 50장을 만들었어요/.test(document.getElementById('cr-done').innerText), { timeout: 30000 });
    const forgot = await calls(page, 'create_history_forget');
    assert.equal(forgot.length, 1, '실패한 조각의 기록(이름·사진)을 지운다');
    assert.match(await text(page, '#cr-done'), /합성 오류/);
    await page.evaluate(() => [...document.querySelectorAll('#cr-done button')].find((b) => /나머지 70장 이어서/.test(b.innerText)).click());
    await page.waitForSelector('#cr-make:not([disabled])');
    assert.match(await text(page, '#cr-review .cr-bill'), /70장/);
    await page.$eval('#cr-make', (e) => e.click());
    await hold(page);
    await page.waitForFunction(() => /120장을 만들었어요/.test(document.getElementById('cr-done').innerText), { timeout: 30000 });
    const issues = (await calls(page, 'create_issue')).map((c) => c.args.names);
    assert.equal(issues.length, 4, '1조각 성공 + 1조각 실패 + 이어서 2조각');
    const done = [issues[0], issues[2], issues[3]];
    assert.deepEqual(done.map((n) => n.length), [50, 50, 20]);
    const stems = done.map((n) => n[0].replace(/-\d+$/, ''));
    assert.equal(new Set(stems).size, 3, `조각마다 다른 차례여야 한다: ${stems}`);
    assert.equal(new Set(done.flat()).size, 120, '120장의 이름이 모두 다르다');
    // 조각의 받는 사람이 차례대로(두 번째 조각 첫 사람 = 51번째 줄)
    const begins = (await calls(page, 'create_history_begin')).map((c) => c.args.entry.details.recipients);
    assert.equal(begins.at(-2)[0], '수강생051');
    assert.equal(begins.at(-1)[0], '수강생101');
    // 다시 올리면 이미 발행한 줄은 저절로 빠진다(앱을 다시 켠 뒤 이어서 하는 길)
    await page.evaluate(() => [...document.querySelectorAll('#cr-done button')].find((b) => /하나 더 만들기/.test(b.innerText)).click());
    await page.$eval('#cr-kinds [data-kind="certificate"]', (e) => e.click());
    await type(page, '#cr-title', '필라테스 지도자 과정');
    await upload(page, '#cr-roster-in', [R120]);
    await page.waitForFunction(() => /이미 발행 120/.test(document.getElementById('cr-roster-sum')?.innerText || ''), { timeout: 20000 });
    assert.match(await text(page, '#cr-roster-sum'), /120줄 중 0장 발행/);
    assert.deepEqual(page.errors, [], page.errors.join('\n'));
    await page.close();
  });

  // ── 3. 보냈는지 모름 → 멈춤 ──
  await ok('보냈는지 모름: 그 화면으로 가고 다음 조각을 보내지 않는다', async () => {
    const page = await openApp({ spendable: 1000 });
    await type(page, '#cr-title', '필라테스 지도자 과정');
    await upload(page, '#cr-roster-in', [R120]);
    await page.waitForFunction(() => document.querySelectorAll('#cr-table tbody tr').length === 120, { timeout: 20000 });
    await page.evaluate(() => { window.__S.issueFail = { at: 1, error: 'SENT_UNKNOWN: 노드가 20초 안에 답하지 않았습니다' }; });
    await page.$eval('#cr-check', (e) => e.click());
    await page.waitForSelector('#cr-make:not([disabled])');
    await page.$eval('#cr-make', (e) => e.click());
    await hold(page);
    await page.waitForFunction(() => /보냈는지 아직 몰라요/.test(document.getElementById('cr-wait').innerText), { timeout: 20000 });
    await new Promise((r) => setTimeout(r, 1500));
    assert.equal((await calls(page, 'create_issue')).length, 1, '더 보내지 않는다');
    assert.equal((await calls(page, 'create_history_forget')).length, 0, '모르는 기록은 지우지 않는다');
    const draft = await page.evaluate(() => JSON.parse(localStorage.getItem('playx-raven-create-draft')));
    assert.equal(draft.stage, 'sent-unknown');
    assert.equal(JSON.stringify(draft).includes('수강생'), false, '이어하기 표(localStorage)에 받는 사람 이름을 두지 않는다');
    await page.close();
  });

  // ── 3-1. 보냈는지 모름이 「보냈다」로 풀림 → 그 묶음은 다시 안 보낸다 ──
  await ok('보냈는지 모름 → 기록됨: 그 묶음은 보냄으로 적고, 이어서는 남은 묶음만(두 번 태우지 않음)', async () => {
    const page = await openApp({ spendable: 1000 });
    await type(page, '#cr-title', '필라테스 지도자 과정');
    await upload(page, '#cr-roster-in', [R120]);
    await page.waitForFunction(() => document.querySelectorAll('#cr-table tbody tr').length === 120, { timeout: 20000 });
    await page.evaluate(() => { window.__S.issueFail = { at: 2, error: 'SENT_UNKNOWN: 노드가 20초 안에 답하지 않았습니다' }; });
    await page.$eval('#cr-check', (e) => e.click());
    await page.waitForSelector('#cr-make:not([disabled])');
    await page.$eval('#cr-make', (e) => e.click());
    await hold(page);
    await page.waitForFunction(() => /보냈는지 아직 몰라요/.test(document.getElementById('cr-wait').innerText), { timeout: 20000 });
    const unknownNames = (await calls(page, 'create_issue'))[1].args.names;
    // 노드가 따라잡았다 — 두 번째 묶음은 체인에 있다.
    await page.evaluate(() => { window.__S.resolveState = 'done'; });
    await page.$eval('#cr-resolve', (e) => e.click());
    await page.waitForFunction(() => /120장 중 100장을 만들었어요/.test(document.getElementById('cr-done').innerText), { timeout: 10000 });
    assert.match(await text(page, '#cr-done'), /나머지 20장 이어서 만들기/);
    await page.evaluate(() => [...document.querySelectorAll('#cr-done button')].find((b) => /이어서 만들기/.test(b.innerText)).click());
    await page.waitForSelector('#cr-make:not([disabled])');
    assert.match(await text(page, '#cr-review .cr-bill'), /20장/);
    await page.$eval('#cr-make', (e) => e.click());
    await hold(page);
    await page.waitForFunction(() => /120장을 만들었어요/.test(document.getElementById('cr-done').innerText), { timeout: 20000 });
    const issues = (await calls(page, 'create_issue')).map((c) => c.args.names);
    assert.equal(issues.length, 3, `보냄 + 모름(보냄) + 남은 20장 — 모름 묶음을 다시 보내면 안 된다: ${issues.map((n) => n.length)}`);
    assert.equal(issues[2].length, 20);
    const all = [...issues[0], ...unknownNames, ...issues[2]];
    assert.equal(new Set(all).size, 120);
    const begins = (await calls(page, 'create_history_begin')).map((c) => c.args.entry.details.recipients[0]);
    assert.deepEqual(begins, ['수강생001', '수강생051', '수강생101'], '모름 묶음의 사람을 다시 시작하지 않는다');
    assert.deepEqual(page.errors, [], page.errors.join('\n'));
    await page.close();
  });

  // ── 3-2. 보냈는지 모름이 「안 나갔다」로 풀림 → 그 묶음만 다시 ──
  await ok('보냈는지 모름 → 안 나감: 그 묶음만 「아직」으로, 이미 보낸 묶음은 그대로', async () => {
    const page = await openApp({ spendable: 1000 });
    await type(page, '#cr-title', '필라테스 지도자 과정');
    await upload(page, '#cr-roster-in', [R120]);
    await page.waitForFunction(() => document.querySelectorAll('#cr-table tbody tr').length === 120, { timeout: 20000 });
    await page.evaluate(() => { window.__S.issueFail = { at: 2, error: 'SENT_UNKNOWN: 노드가 20초 안에 답하지 않았습니다' }; });
    await page.$eval('#cr-check', (e) => e.click());
    await page.waitForSelector('#cr-make:not([disabled])');
    await page.$eval('#cr-make', (e) => e.click());
    await hold(page);
    await page.waitForFunction(() => /보냈는지 아직 몰라요/.test(document.getElementById('cr-wait').innerText), { timeout: 20000 });
    await page.evaluate(() => { window.__S.resolveState = 'not-sent'; });
    await page.$eval('#cr-resolve', (e) => e.click());
    await page.waitForFunction(() => [...document.querySelectorAll('#cr-wait button')].some((b) => /처음부터 다시/.test(b.innerText) && !b.hidden), { timeout: 10000 });
    await page.evaluate(() => [...document.querySelectorAll('#cr-wait button')].find((b) => /처음부터 다시/.test(b.innerText)).click());
    await page.waitForFunction(() => /120장 중 50장을 만들었어요/.test(document.getElementById('cr-done').innerText), { timeout: 10000 });
    assert.equal((await calls(page, 'create_resolve_not_sent')).length, 1);
    const draft = await page.evaluate(() => localStorage.getItem('playx-raven-create-draft'));
    assert.equal(draft, null, '풀렸으면 이어하기 표를 치운다');
    await page.evaluate(() => [...document.querySelectorAll('#cr-done button')].find((b) => /나머지 70장 이어서 만들기/.test(b.innerText)).click());
    await page.waitForSelector('#cr-make:not([disabled])');
    await page.$eval('#cr-make', (e) => e.click());
    await hold(page);
    await page.waitForFunction(() => /120장을 만들었어요/.test(document.getElementById('cr-done').innerText), { timeout: 20000 });
    const issues = (await calls(page, 'create_issue')).map((c) => c.args.names.length);
    assert.deepEqual(issues, [50, 50, 50, 20], '보냄 · 안 나감 · 다시 50 · 20');
    const begins = (await calls(page, 'create_history_begin')).map((c) => c.args.entry.details.recipients[0]);
    assert.deepEqual(begins, ['수강생001', '수강생051', '수강생051', '수강생101'], '첫 묶음은 다시 시작하지 않는다');
    assert.deepEqual(page.errors, [], page.errors.join('\n'));
    await page.close();
  });

  // ── 3-3. 확인할 때 기록을 새로 읽는다 ──
  await ok('확인하기 직전 만든 기록을 다시 읽어, 그사이 발행된 줄은 빼고 계산한다', async () => {
    const page = await openApp({ spendable: 1000 });
    await type(page, '#cr-title', '필라테스 지도자 과정');
    await upload(page, '#cr-roster-in', [R120]);
    await page.waitForFunction(() => document.querySelectorAll('#cr-table tbody tr').length === 120, { timeout: 20000 });
    await new Promise((r) => setTimeout(r, 600));
    // 다른 길(보냈는지 모름이 풀림 등)로 앞 50줄이 방금 발행됐다 — 화면은 아직 모른다.
    await page.evaluate(() => {
      const rows = [...document.querySelectorAll('#cr-table tbody tr')].slice(0, 50);
      const cell = (tr, f) => tr.querySelector(`input[data-field="${f}"]`).value;
      window.__S.history.push({
        id: 'f'.repeat(32), status: 'done', kind: 'certificate', title: '필라테스 지도자 과정', issued_on: document.getElementById('cr-date').value,
        recipients: rows.map((tr) => cell(tr, 'recipient')), rows: rows.map((tr) => ({ number: cell(tr, 'number'), date: cell(tr, 'date') })),
        names: rows.map((_, i) => `HANBIT#SURYO260924-${i + 1}`),
      });
    });
    await page.$eval('#cr-check', (e) => e.click());
    await page.waitForSelector('#cr-review:not([hidden]) .cr-bill');
    const bill = await text(page, '#cr-review .cr-bill');
    assert.match(bill, /70장/, bill);
    assert.match(await text(page, '#cr-roster-sum'), /이미 발행 50/);
    assert.deepEqual(page.errors, [], page.errors.join('\n'));
    await page.close();
  });

  // ── 4. 붙여넣기 · 열 맞추기 · 샘플 표 · 라비 ──
  await ok('붙여넣기(탭) · 머리글 없는 표 열 맞추기 · 샘플 표 두 파일 · 라비 문구(이름 안 보냄) · 명단 사진', async () => {
    const page = await openApp();
    await type(page, '#cr-title', '응급처치 기본 교육');
    // 엑셀에서 복사한 두 열(머리글 없음) → 확인 표, 열 맞추기가 열린다
    await page.$eval('#cr-recipients', (e, t) => {
      const dt = new DataTransfer(); dt.setData('text/plain', t);
      e.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    }, '김하늘\t응급처치 기본\n이바다\t응급처치 심화\n');
    await page.waitForFunction(() => document.querySelectorAll('#cr-table tbody tr').length === 2);
    assert.equal(await page.$eval('#cr-map', (e) => e.hidden), false, '머리글 없는 여러 열은 열 맞추기를 연다');
    await page.select('#cr-map select[data-field="course"]', '1');
    await page.waitForFunction(() => document.querySelector('#cr-table tbody tr:nth-child(2) td.cr-c-course input')?.value === '응급처치 심화');
    // 샘플 표 — xlsx + csv(BOM)
    await page.$eval('#cr-sample', (e) => e.click());
    await page.waitForFunction(() => window.__S.calls.filter((c) => c.command === 'certificate_file_save').length === 2);
    const saves = (await calls(page, 'certificate_file_save')).map((c) => c.args);
    assert.deepEqual(saves.map((s) => s.name).sort(), ['증서_명단_샘플.csv', '증서_명단_샘플.xlsx']);
    const csv = Buffer.from(saves.find((s) => s.name.endsWith('.csv')).data, 'base64');
    assert.deepEqual([...csv.subarray(0, 3)], [0xef, 0xbb, 0xbf], 'CSV 는 UTF-8 BOM');
    const sx = XLSX.read(Buffer.from(saves.find((s) => s.name.endsWith('.xlsx')).data, 'base64'), { type: 'buffer' });
    assert.deepEqual(XLSX.utils.sheet_to_json(sx.Sheets[sx.SheetNames[0]], { header: 1 })[0], HEAD);
    // 「엑셀로 열기」는 방금 만든 그 파일을 연다 — 다시 쓰지 않는다(채우던 것을 덮지 않게).
    await page.evaluate(() => [...document.querySelectorAll('#cr-roster-say button, #cr-rec-say button, button.link')].find((b) => /엑셀로 열기/.test(b.innerText)).click());
    await page.waitForFunction(() => window.__S.calls.some((c) => c.command === 'certificate_sample_open'));
    assert.equal((await calls(page, 'certificate_sample_open'))[0].args.path, '/Users/x/Downloads/증서_명단_샘플.xlsx');
    assert.equal((await calls(page, 'certificate_file_save')).length, 2, '열기는 다시 저장하지 않는다');
    // 라비 문구 — 받는 사람 이름을 보내지 않는다
    await page.$eval('#cr-ai-phrase', (e) => e.click());
    await page.waitForFunction(() => document.querySelectorAll('#cr-phrases button').length === 3);
    const fill = (await calls(page, 'ai_fill'))[0].args;
    assert.equal(fill.task, 'cert_phrases');
    assert.ok(!/김하늘|이바다/.test(fill.input), `AI 에 이름이 나갔다: ${fill.input}`);
    await page.$eval('#cr-phrases button:nth-of-type(2)', (e) => e.click());
    assert.equal(await page.$eval('#cr-desc', (e) => e.value), '{이름} 님의 수료를 축하합니다.');
    // 명단 사진 읽기 — 묻고, 보내고, 확인 표 끝에 붙인다(확실히 못 읽은 줄 표시)
    await upload(page, '#cr-ai-roster-in', [path.join(assets, 'photo.jpg')]);
    await page.waitForSelector('#askwrap.on');
    assert.match(await text(page, '#ask-msg'), /anthropic/);
    await page.$eval('#ask-yes', (e) => e.click());
    await page.waitForFunction(() => document.querySelectorAll('#cr-table tbody tr').length === 4, { timeout: 10000 });
    assert.match(await page.$eval('#cr-table tbody tr:nth-child(4)', (e) => e.innerText), /확실히 못 읽었어요/);
    const img = (await calls(page, 'ai_read_image'))[0].args;
    assert.equal(img.task, 'cert_roster_photo'); assert.match(img.image, /^data:image\/jpeg;base64,/);
    assert.deepEqual(page.errors, [], page.errors.join('\n'));
    await page.close();
  });

  await ok('AI 열쇠가 없으면: 기본 예문(AI 아님 표시), 명단 사진은 안내만', async () => {
    const page = await openApp({ keys: {} });
    await page.$eval('#cr-ai-phrase', (e) => e.click());
    await page.waitForFunction(() => document.querySelectorAll('#cr-phrases button').length === 3);
    assert.match(await text(page, '#cr-phrases'), /AI가 쓴 글이 아니에요/);
    await page.$eval('#cr-ai-roster', (e) => e.click());
    assert.match(await text(page, '#cr-recipients-say'), /AI 열쇠를 넣으면/);
    assert.equal((await calls(page, 'ai_fill')).length + (await calls(page, 'ai_read_image')).length, 0);
    await page.close();
  });

  await ok('처음 쓰는 이름 + 120줄: 이름 등록과 첫 50장, 나머지는 이어서라고 알린다', async () => {
    const page = await openApp({ spendable: 2000, brands: [] });
    await type(page, '#cr-title', '필라테스 지도자 과정');
    await type(page, '#cr-maker', '한빛 필라테스');
    await upload(page, '#cr-roster-in', [R120]);
    await page.waitForFunction(() => document.querySelectorAll('#cr-table tbody tr').length === 120, { timeout: 20000 });
    await page.$eval('#cr-check', (e) => e.click());
    await page.waitForSelector('#cr-review:not([hidden]) .cr-bill');
    const review = await text(page, '#cr-review');
    assert.match(review, /첫 50장을 만들고/);
    assert.match(review, /70장을 더 만들어요/);
    assert.match(await text(page, '#cr-review .cr-bill'), /1,100\.44 RVN/);
    await page.close();
  });

  // ── 4-1. 다른 말 — 확인 표·결과 화면에 한국어가 남지 않는다(사람이 적은 값·체인 이름 빼고) ──
  for (const language of ['en', 'ja', 'zh']) {
    await ok(`${language}: 확인 표 · 합계 · 결과 화면에 한국어가 남지 않는다`, async () => {
      const page = await openApp({ language, spendable: 100 });
      await type(page, '#cr-title', 'Pilates course');
      await upload(page, '#cr-roster-in', [R50]);
      await page.waitForFunction(() => document.querySelectorAll('#cr-table tbody tr').length === 52, { timeout: 20000 });
      await upload(page, '#cr-photos-in', photoFiles.slice(0, 10));
      await page.waitForFunction(() => document.querySelectorAll('#cr-table .cr-thumb:not(.none)').length === 10, { timeout: 30000 });
      await page.$eval('#cr-ai-phrase', (e) => e.click());
      await page.waitForFunction(() => document.querySelectorAll('#cr-phrases button').length === 3);
      const hangul = () => page.evaluate(() => {
        const out = [], root = document.getElementById('page-create');
        const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        while (w.nextNode()) {
          const n = w.currentNode, e = n.parentElement;
          if (!e || e.closest('[translate="no"],script,style') || !e.checkVisibility() || !/[가-힣]/.test(n.textContent)) continue;
          out.push(n.textContent.trim());
        }
        return [...new Set(out)];
      });
      const form = await hangul();
      // 표의 받는 사람(수강생001…)·과정 값은 입력 칸 값이라 글자 마디가 아니다. 남는 것은 cert-roster 의 줄 문제뿐이어야 하는데 그것도 번역한다.
      assert.deepEqual(form, [], `${language} 폼에 남은 한국어: ${form.join(' | ')}`);
      await page.$eval('#cr-check', (e) => e.click());
      await page.waitForSelector('#cr-review:not([hidden]) .cr-bill');
      const review = await hangul();
      assert.deepEqual(review, [], `${language} 확인 화면에 남은 한국어: ${review.join(' | ')}`);
      await page.evaluate(() => { window.__S.spendable = 300; });
      await page.evaluate(() => document.querySelectorAll('#cr-review .cr-actions button')[1].click());
      await page.waitForSelector('#cr-make:not([disabled])');
      // 보내는 중 화면(묶음 진행)도 본다 — 노드를 3초 붙잡아 둔다.
      await page.evaluate(() => { window.__S.issueWait = 3000; });
      await page.$eval('#cr-make', (e) => e.click());
      await hold(page);
      await page.waitForSelector('#cr-wait .cr-chunks li.now', { visible: true, timeout: 10000 });
      const sending = await hangul();
      assert.deepEqual(sending, [], `${language} 보내는 중 화면에 남은 한국어: ${sending.join(' | ')}`);
      await page.waitForFunction(() => document.querySelectorAll('#cr-done .cr-list li').length === 50, { timeout: 30000 });
      const done = (await hangul()).filter((x) => !/^수강생\d+$/.test(x));
      assert.deepEqual(done, [], `${language} 결과 화면에 남은 한국어: ${done.join(' | ')}`);
      await page.screenshot({ path: path.join(shots, `bulk-done-${language}.png`) });
      assert.deepEqual(page.errors, [], page.errors.join('\n'));
      await page.close();
    });
  }

  // ── 5. 로고·도장 올리기 ──
  await ok('로고·도장 올리기 → 미리보기에 다시 그림, 빼기', async () => {
    const page = await openApp();
    await upload(page, '#cr-logo-in', [path.join(assets, 'logo.png')]);
    await page.waitForFunction(() => window.__S.marks.logo);
    assert.match(await page.evaluate(() => window.__S.marks.logo), /^data:image\/png;base64,/);
    assert.equal(await page.$eval('#cr-logo-clear', (e) => e.hidden), false);
    await page.$eval('#cr-logo-clear', (e) => e.click());
    await page.waitForFunction(() => !window.__S.marks.logo);
    await page.close();
  });

  // ── 6. 캡처: 세 양식 × 이름 셋 × 데스크톱·폰 ──
  const NAMES = { short: '김산', long: '남궁가나다라마바사아자차카타파하거너더러', latin: 'Alexandra Montgomery-Whitfield' };
  const TITLES = { course: '필라테스 지도자 과정', proof: '응급처치 기본 교육 이수', thanks: '2026 봄 학기 봉사' };
  // 데스크톱 창은 최소 720px(tauri.conf) — 그 폭과 폰 폭(390px)에서도 만드는 칸이 위, 줄인 미리보기가 아래.
  for (const [vw, vh, tag] of [[1280, 900, 'desktop'], [720, 780, 'narrow'], [390, 844, 'phone']]) {
    await ok(`캡처 ${tag}: 세 양식 × 이름 셋 (${vw}px)`, async () => {
      const page = await openApp({ width: vw, height: vh });
      for (const t of ['course', 'proof', 'thanks']) {
        await page.$eval(`#cr-tpls [data-cr-tpl="${t}"]`, (e) => e.click());
        await type(page, '#cr-title', TITLES[t]);
        await type(page, '#cr-issuer', '한빛 필라테스 아카데미');
        await type(page, '#cr-signer', '대표 홍길동');
        for (const [v, who] of Object.entries(NAMES)) {
          await type(page, '#cr-recipients', who);
          await page.waitForFunction((w) => {
            const d = document.getElementById('cr-preview').contentDocument;
            return d?.adoptedStyleSheets?.length === 2 && d.querySelector('.name')?.textContent.includes(w.slice(0, 2));
          }, { timeout: 10000 }, who);
          await page.evaluate(() => document.fonts.ready);
          await new Promise((r) => setTimeout(r, 250));
          const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
          assert.ok(overflow <= 1, `${tag} 가로로 넘친다: ${overflow}px`);
          if (tag !== 'desktop') {
            // 좁은 창: 만드는 칸이 위, 미리보기가 아래 · 종이는 칸 폭에 맞춰 줄고 넘치지 않는다
            const pos = await page.evaluate(() => {
              const paper = document.querySelector('.cr-paper'), frame = document.getElementById('cr-preview');
              return { form: document.getElementById('cr-title').getBoundingClientRect().top, paper: paper.getBoundingClientRect().toJSON(),
                col: paper.parentElement.getBoundingClientRect().toJSON(), scale: new DOMMatrix(getComputedStyle(frame).transform).a };
            });
            assert.ok(pos.paper.top > pos.form, `미리보기가 폼 아래: ${JSON.stringify(pos)}`);
            assert.ok(pos.paper.width <= (tag === 'phone' ? 240.5 : 300.5) && pos.paper.right <= pos.col.right + 1, `미리보기가 칸을 넘친다: ${JSON.stringify(pos)}`);
            assert.ok(Math.abs(pos.scale - pos.paper.width / 794) < 0.002, `틀 배율이 종이 폭과 안 맞다: ${JSON.stringify(pos)}`);
            await page.$eval('.cr-paper', (e) => e.scrollIntoView({ block: 'center' }));
            await (await page.$('#cr-preview-wrap')).screenshot({ path: path.join(shots, `form-${t}-${v}-${tag}.png`) });
          } else {
            await page.$eval('#cr-form', (e) => e.scrollIntoView({ block: 'start' }));
            await (await page.$('#cr-form')).screenshot({ path: path.join(shots, `form-${t}-${v}-desktop.png`) });
          }
        }
      }
      if (tag !== 'desktop') await page.screenshot({ path: path.join(shots, `form-${tag}-full.png`), fullPage: true });
      assert.deepEqual(page.errors, [], page.errors.join('\n'));
      await page.close();
    });
  }
  // 인쇄 파일 그대로(러스트 render) — 한 장씩 큰 캡처
  await ok('캡처: 인쇄 파일 A4(세 양식 × 이름 셋 + 로고·도장·사진)', async () => {
    const page = await browser.newPage();
    await page.setViewport({ width: 900, height: 1200, deviceScaleFactor: 1.5 });
    for (const t of ['course', 'proof', 'thanks']) for (const v of ['short', 'long', 'latin', 'brand']) {
      await page.goto('file://' + path.join(samples, `${t}-${v}.html`), { waitUntil: 'load' });
      await page.evaluate(() => document.fonts.ready);
      const fam = await page.$eval('.name', (e) => getComputedStyle(e).fontFamily);
      assert.match(fam, /RV Cert Serif|Cormorant/);
      const loaded = await page.evaluate(() => [...document.fonts].filter((f) => f.status === 'loaded').map((f) => f.family));
      assert.ok(loaded.some((f) => /RV Cert Serif/.test(f)), `번들 글꼴이 안 불렸다: ${loaded}`);
      await (await page.$('.sheet')).screenshot({ path: path.join(shots, `print-${t}-${v}.png`) });
    }
    await page.close();
  });
} finally {
  await browser.close(); server.close();
  fs.rmSync(profile, { recursive: true, force: true }); fs.rmSync(work, { recursive: true, force: true });
}
console.log(JSON.stringify({ timings_ms: timings }, null, 1));
console.log(failed ? `${failed} failed, ${passed} passed` : `certificate bulk UI: all ${passed} passed · 캡처 ${shots}`);
process.exitCode = failed ? 1 : 0;
