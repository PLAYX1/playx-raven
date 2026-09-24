// 앱 CSP 를 Tauri 처럼 씌운 채(style-src 에 nonce · <style> 에 nonce) 화면마다 잰다.
//
// 🔴 왜 — Tauri 는 style-src 에 nonce 를 덧붙이고(tauri-utils html.rs inject_nonce_token), nonce 가
//    있으면 브라우저는 'unsafe-inline' 을 무시한다 → style="…" 속성이 전부 무시된다. 다른 화면
//    시험들은 CSP 없이 dist 를 띄워 늘 설계대로 보였고, 그래서 0.4.5 부터 실제 앱만 달랐다.
//
// 재는 것(화면마다): 적용 안 된 style 속성 수 · 숨겨야 하는데 보이는 것(style 에 display:none) ·
//   8초 취소 창 막대가 차오르는지. 캡처는 artifacts/claude-style-csp/<모드>-<화면>.png.
//
// 쓰는 법: node scripts/check-style-csp.mjs [dist 폴더] [모드 이름] [--no-csp] [--report-only]
//   기본은 ./dist · 모드 "after" · CSP 씌움 · 틀리면 실패(종료 코드 1).
//   --report-only 는 숫자만 적고 실패하지 않는다(고치기 전 dist 를 잴 때).
// 합성 화면만 — Tauri·노드·지갑·네트워크 없음(모든 invoke 는 가짜, 바깥 요청은 막음).
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const root = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith('--')));
const [distArg, modeArg] = args.filter((a) => !a.startsWith('--'));
const dist = resolve(distArg || resolve(root, 'dist'));
const mode = modeArg || 'after';
const useCsp = !flags.has('--no-csp');
const reportOnly = flags.has('--report-only');
const out = resolve(root, 'artifacts/claude-style-csp');
mkdirSync(out, { recursive: true });
assert.ok(existsSync(resolve(dist, 'index.html')), `dist 가 없다: ${dist} — 먼저 npx vite build`);

// tauri.conf.json 의 CSP + Tauri 가 하는 것(style-src 에 nonce).
const NONCE = 'rv3styletest';
const conf = JSON.parse(readFileSync(resolve(root, 'src-tauri/tauri.conf.json'), 'utf8'));
const cspObj = { ...conf.app.security.csp };
cspObj['style-src'] = `${cspObj['style-src']} 'nonce-${NONCE}'`;
// 시험 서버(127.0.0.1:임의 포트)는 'self' 다.
const csp = Object.entries(cspObj).map(([k, v]) => `${k} ${v}`).join('; ');

const mime = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript', '.css': 'text/css', '.webp': 'image/webp', '.png': 'image/png', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' };
const server = createServer((request, response) => {
  const pathname = new URL(request.url, 'http://localhost').pathname;
  const path = resolve(dist, '.' + (pathname === '/' ? '/index.html' : pathname));
  if (!path.startsWith(dist + '/') || !existsSync(path)) { response.writeHead(404).end(); return; }
  const headers = { 'content-type': mime[extname(path)] || 'application/octet-stream' };
  let body = readFileSync(path);
  if (extname(path) === '.html') {
    if (useCsp) headers['content-security-policy'] = csp;
    // Tauri 처럼 <style> 마다 nonce.
    body = Buffer.from(body.toString('utf8').replace(/<style(?=[\s>])/g, `<style nonce="${NONCE}"`));
  }
  response.writeHead(200, headers); response.end(body);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${server.address().port}`;

const PAGES = ['ravi', 'wallet', 'assets', 'create', 'talk', 'shop', 'door', 'helping', 'reward', 'artist', 'settings'];
const result = { mode, csp: useCsp, dist, pages: {}, hold: null };
let browser;
try {
  browser = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.setViewport({ width: 1120, height: 780 });
  await page.setRequestInterception(true);
  page.on('request', (q) => (q.url().startsWith(origin + '/') || q.url().startsWith('data:') || q.url().startsWith('blob:') ? q.continue() : q.abort()));
  await page.evaluateOnNewDocument(() => {
    // 이미 쓰던 사람(첫 안내·모드 고르기는 지난 상태).
    localStorage.setItem('playx-onboarded', '1');
    localStorage.setItem('playx-raven-lang', 'ko');
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    window.__TAURI_INTERNALS__ = {
      invoke: async (command, args) => {
        switch (command) {
          case 'plugin:app|version': return '0.4.7';
          case 'mode_get': return { chosen: true, mode: 'help' };
          case 'money_status': throw 'Synthetic status unavailable';
          case 'node_status': return { blocks: 1000, headers: 1000, progress: 1, peers: 3 };
          case 'api_key_status': return {};
          case 'model_settings': return {};
          case 'list_assets': case 'pin_list': case 'my_channels': return [];
          case 'artist_profile_get': return { name: '', about: '', picture: '', website: '' };
          case 'create_status': return { brands: ['HANBIT'], pending: [], spendable: 300, locked: false };
          case 'create_names_taken': return args.names.map(() => false);
          case 'create_unresolved': return null;
          case 'create_history_list': return [];
          case 'create_history_begin': return 'a'.repeat(32);
          case 'create_history_forget': return null;
          case 'create_certificate_preview': return '<!doctype html><html><body><section class="sheet">견본</section></body></html>';
          case 'certificate_font_css': return '';
          case 'certificate_marks': return { logo: null, stamp: null };
          case 'create_issue': await wait(60_000); return { txid: 'ab'.repeat(32), owner_pinned: true };
          case 'qr_svg': return '<svg viewBox="0 0 10 10"><rect width="10" height="10"/></svg>';
          default: return null;
        }
      }, transformCallback: (f) => f, metadata: {},
    };
  });
  await page.goto(origin + '/', { waitUntil: 'networkidle0' });
  await new Promise((r) => setTimeout(r, 600));

  // 화면마다: 적용 안 된 style 속성 · 숨겨야 하는데 보이는 것.
  const measure = () => page.evaluate(() => {
    const all = [...document.querySelectorAll('[style]')];
    const unapplied = all.filter((el) => (el.getAttribute('style') || '').trim() && !el.style.cssText).length;
    const leaked = all.filter((el) => /display\s*:\s*none/.test(el.getAttribute('style') || '') && el.getClientRects().length > 0
      && getComputedStyle(el).display !== 'none' && !el.closest('.page:not(.on)'))
      .map((el) => el.id || el.className || el.tagName);
    return { withStyle: all.length, unapplied, leaked };
  });
  for (const p of PAGES) {
    if (p === 'create') {
      await page.$eval('nav [data-page="assets"]', (e) => e.click());
      await page.waitForSelector('#pt-assets [data-pt="0"]', { visible: true });
      await page.$eval('#pt-assets [data-pt="0"]', (e) => e.click());
    } else {
      const a = await page.$(`nav [data-page="${p}"]`);
      if (!a) { result.pages[p] = { missing: true }; continue; }
      await page.evaluate((el) => el.click(), a);
    }
    await new Promise((r) => setTimeout(r, 350));
    result.pages[p] = await measure();
    await page.screenshot({ path: resolve(out, `${mode}-${p}.png`) });
  }

  // 8초 취소 창 — 증서 한 장 만들기에서 띄운다. 2.5초 뒤 막대가 차 있어야 한다.
  await page.$eval('nav [data-page="assets"]', (e) => e.click());
  await page.$eval('#pt-assets [data-pt="0"]', (e) => e.click());
  await page.waitForSelector('#cr-kinds [data-kind="certificate"]', { visible: true });
  await page.$eval('#cr-kinds [data-kind="certificate"]', (e) => e.click());
  await page.waitForSelector('#cr-form:not([hidden])');
  await page.type('#cr-title', '필라테스 지도자 과정');
  await page.type('#cr-recipients', '김하늘');
  await page.$eval('#cr-check', (e) => e.click());
  await page.waitForSelector('#cr-make:not([disabled])', { timeout: 10000 });
  await page.$eval('#cr-make', (e) => e.click());
  await page.waitForSelector('.holdbox .hb-bar i', { visible: true });
  await new Promise((r) => setTimeout(r, 2500));
  result.hold = await page.evaluate(() => {
    const i = document.querySelector('.holdbox .hb-bar i'), bar = document.querySelector('.holdbox .hb-bar');
    return { fillPx: Math.round(i.getBoundingClientRect().width), barPx: Math.round(bar.getBoundingClientRect().width), text: document.querySelector('.holdbox .hb-left')?.textContent };
  });
  await page.screenshot({ path: resolve(out, `${mode}-hold.png`) });
  await page.$eval('.holdbox .hb-cancel', (e) => e.click());
  result.errors = errors;
} finally {
  await browser?.close();
  server.close();
}

writeFileSync(resolve(out, `${mode}.json`), JSON.stringify(result, null, 1));
const rows = Object.entries(result.pages).map(([p, m]) => `${p.padEnd(9)} ${m.missing ? '(메뉴 없음)' : `style ${String(m.withStyle).padStart(3)} · 안 먹음 ${String(m.unapplied).padStart(3)} · 숨김이 보임 ${m.leaked.length}${m.leaked.length ? ` (${m.leaked.slice(0, 6).join(', ')})` : ''}`}`);
console.log(`[${mode}] CSP ${useCsp ? '씌움' : '없음'} · ${dist}\n${rows.join('\n')}\n8초 막대: ${result.hold.fillPx}/${result.hold.barPx}px · ${result.hold.text}`);
if (!reportOnly) {
  for (const [p, m] of Object.entries(result.pages)) {
    if (m.missing) continue;
    assert.equal(m.unapplied, 0, `${p}: style 속성 ${m.unapplied}개가 안 먹는다`);
    assert.deepEqual(m.leaked, [], `${p}: 숨겨야 할 것이 보인다`);
  }
  assert.ok(result.hold.fillPx > result.hold.barPx * 0.15, `8초 막대가 안 찬다: ${result.hold.fillPx}/${result.hold.barPx}`);
  assert.deepEqual(result.errors, [], result.errors.join('\n'));
  console.log('style under CSP: all passed');
}
