// Synthetic only: no Tauri, node, wallet, or real files. backup_folders is mocked.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { resolve, extname } from 'node:path';
import puppeteer from 'puppeteer-core';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url)), dist = resolve(root, 'dist');
const out = resolve(root, 'artifacts/backup-find-ui');
const profile = resolve(out, 'profile-' + Date.now());
mkdirSync(profile, { recursive: true }); // needs `vite build` first
const mime = { '.html':'text/html', '.js':'application/javascript', '.css':'text/css', '.webp':'image/webp', '.png':'image/png', '.svg':'image/svg+xml' };
const server = createServer((q, r) => {
  const p = new URL(q.url, 'http://x').pathname; const f = resolve(dist, '.' + (p === '/' ? '/index.html' : p));
  if (!f.startsWith(dist + '/') || !existsSync(f)) { r.writeHead(404).end(); return; }
  r.writeHead(200, { 'content-type': mime[extname(f)] || 'application/octet-stream' }); r.end(readFileSync(f));
});
await new Promise(ok => server.listen(0, '127.0.0.1', ok));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true, userDataDir: profile });
const results = [];
try {
  for (const [w, h] of [[390, 844], [1440, 900]]) for (const scheme of ['light', 'dark']) {
    const page = await browser.newPage();
    await page.setViewport({ width: w, height: h });
    await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: scheme }]);
    await page.setRequestInterception(true);
    page.on('request', q => (q.url().startsWith(origin + '/') || q.url().startsWith('data:')) ? q.continue() : q.abort());
    await page.evaluateOnNewDocument(() => {
      localStorage.setItem('playx-raven-lang', 'ko');
      window.__SURVEYED = [];
      window.__TAURI_INTERNALS__ = { transformCallback: f => f, metadata: {}, invoke: async (c, a) => {
        if (c === 'plugin:app|version') return '0.0.0';
        if (c === 'backup_folders') return { folders: [], rejected: [{ path: '/synthetic/broken', why: 'x' }, { path: '/synthetic/no-receipt', why: 'y' }], items: [
          { kind: 'file', path: '/synthetic/drive/RavenVault-Backup/RavenVault.zip.pxlock', scheme: 'ravenvault', previous: false, size: 1258291, day: '2026-10-10', place: '내 서류함', verification: 'complete', at: 4 },
          { kind: 'folder', path: '/synthetic/app/backups/2026-10-09', scheme: 'app', previous: false, day: '2026-10-09', place: '이 컴퓨터', verification: 'complete', at: 3 },
          { kind: 'file', path: '/synthetic/drive/PLAYXRaven-Backup/RavenVault Desktop 백업/PLAYXRaven.zip.pxlock', scheme: 'playxraven', previous: false, size: 1048576, day: '2026-10-01', place: 'iCloud Drive', verification: 'complete', at: 2 },
          { kind: 'file', path: '/synthetic/drive/PLAYXRaven-Backup/RavenVault Desktop 백업/PLAYXRaven-이전.zip.pxlock', scheme: 'playxraven', previous: true, size: 1000000, day: '2026-09-30', place: 'SYNTHETIC-USB', verification: 'legacy', at: 1 } ] };
        if (c === 'restore_survey') { window.__SURVEYED.push(a.folder); return { day: '2026-10-10', items: [{ key: 'wallet', what: '지갑', detail: '1 MB', why: 'synthetic' }], empty: false, note: 'synthetic' }; }
        if (c === 'backup_survey') return { items: [], automatic: null };
        if (c === 'list_assets' || c === 'pin_list' || c === 'my_channels') return [];
        return null;
      } };
    });
    await page.goto(origin + '/', { waitUntil: 'networkidle0' });
    await page.addStyleTag({ content: '#onboard,#hello{display:none!important}' });
    await page.evaluate(() => document.querySelector('[data-page="settings"]').click());
    await page.waitForFunction(() => !!document.querySelector('#rs-find'));
    await page.evaluate(() => { const d = document.querySelector('#rs-find').closest('details'); if (d) d.open = true; });
    await page.waitForFunction(() => !!document.querySelector('#rs-find').offsetParent);
    await page.evaluate(() => document.querySelector('#rs-find').click());
    await page.waitForFunction(() => document.querySelectorAll('#rs-found .found-row').length === 4);
    const m = await page.evaluate(() => {
      const parse = s => { const v = s.match(/[\d.]+/g).map(Number); return [v[0], v[1], v[2], v.length > 3 ? v[3] : 1]; };
      const over = (top, bottom) => [0, 1, 2].map(i => top[i] * top[3] + bottom[i] * (1 - top[3])).concat(1);
      const bg = el => { const stack = []; for (let e = el; e; e = e.parentElement) stack.push(parse(getComputedStyle(e).backgroundColor)); let c = [255, 255, 255, 1];
        const b = parse(getComputedStyle(document.body).backgroundColor); if (b[3] > 0) c = over(b, c);
        for (const s of stack.reverse()) if (s[3] > 0) c = over(s, c); return c; };
      const lum = c => { const f = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]); };
      const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
      const worst = [];
      for (const el of document.querySelectorAll('#rs-found *')) {
        if (![...el.childNodes].some(n => n.nodeType === 3 && n.textContent.trim())) continue;
        const back = bg(el); const fg = over(parse(getComputedStyle(el).color), back);
        worst.push({ text: el.textContent.trim().slice(0, 30), r: +ratio(fg, back).toFixed(2) });
      }
      worst.sort((a, b) => a.r - b.r);
      const box = document.querySelector('#rs-found');
      return { text: box.textContent.replace(/\s+/g, " "), visible: box.innerText.length, worst: worst.slice(0, 3), overflow: document.documentElement.scrollWidth - innerWidth,
        rowsOverflow: [...box.querySelectorAll('.found-row')].some(r => r.scrollWidth > r.clientWidth + 1),
        buttons: [...box.querySelectorAll('button')].map(b => { const r = b.getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height)]; }) };
    });
    assert.ok(m.visible > 0, 'list must be visible');
    const el = await page.$('#rs-found'); await el.screenshot({ path: resolve(out, `found-${w}-${scheme}.png`) });
    await page.evaluate(() => document.querySelectorAll('#rs-found [data-found]')[2].click());
    await page.waitForFunction(() => window.__SURVEYED.length === 1);
    const surveyed = await page.evaluate(() => window.__SURVEYED[0]);
    assert.ok(m.text.includes('찾은 레이븐볼트 백업 4개'), m.text);
    assert.ok(!m.text.includes('PLAYXRaven'), 'screen must say 레이븐볼트, not PLAYXRaven');
    assert.ok(m.text.includes("옛 이름") && m.text.includes('이전 판') && m.text.includes('완료 기록 없음'));
    assert.ok(m.text.includes('뺀 파일 2개'));
    assert.equal(m.overflow, 0); assert.equal(m.rowsOverflow, false);
    assert.ok(m.worst[0].r >= 4.5, JSON.stringify(m.worst));
    assert.equal(surveyed, '/synthetic/drive/PLAYXRaven-Backup/RavenVault Desktop 백업/PLAYXRaven.zip.pxlock');
    results.push({ w, scheme, worst: m.worst[0], buttons: m.buttons[0] });
    await page.close();
  }
  console.log(JSON.stringify(results));
  console.log('PASS backup find list 390/1440 light/dark');
} finally { await browser.close(); server.close(); rmSync(profile, { recursive: true, force: true }); }
