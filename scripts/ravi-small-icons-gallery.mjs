// 라비 작은 얼굴(16~32px) 전후 갤러리 — 실제 Chrome(puppeteer-core)으로 그려 PNG 로 남긴다.
// 합성 데이터만(지갑·노드·네트워크 없음). 앱 실행 없음.
// 사용: node scripts/ravi-small-icons-gallery.mjs → artifacts/small-icons/
//   sheet-{before,after}-{light,dark}-{1x,2x}.png · emotions-{light,dark}.png · big-{before,after}.png · cells.json
//   이어서 python3 scripts/ravi-small-icons-metrics.py 가 수치·갤러리 HTML 을 만든다.
import { createServer } from 'node:http';
import { readFileSync, mkdirSync, writeFileSync, rmSync, mkdtempSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { build } from 'esbuild';
import puppeteer from 'puppeteer-core';

const root = resolve(import.meta.dirname, '..');
const outDir = resolve(root, process.env.RV_SMALL_OUT || 'artifacts/small-icons');
const indexHtml = readFileSync(resolve(root, 'index.html'), 'utf8');
const pick = re => (indexHtml.match(re) || [''])[0];
const tokens = [pick(/:root \{ color-scheme: light; --bg:#F7F6F3[^\n]*/), pick(/@media \(prefers-color-scheme: dark\) \{ :root:not\(\[data-theme="light"\]\) \{ color-scheme: dark; --bg:#0F1016[^\n]*/), pick(/:root\[data-theme="dark"\] \{ color-scheme: dark; --bg:#0F1016[^\n]*/)].join('\n');
const faceCss = indexHtml.split('\n').filter(l => /\.ravi-face|rvblink|\.rv-lid|rvz|\.rv-z|rvpop|\.rv-pop|rvbob|\.rv-bob|rvthink|\.rv-t1|prefers-reduced-motion: reduce\) \{ \.rv-lid/.test(l)).join('\n');
if (!faceCss.includes('.ravi-face')) throw new Error('index.html 에서 얼굴 스타일을 못 찾음');

const work = mkdtempSync(join(tmpdir(), 'rv-small-'));
const js = await build({ entryPoints: [resolve(root, 'scripts/fixtures/ravi-small-harness.ts')], bundle: true, write: false, format: 'esm', outdir: work, loader: { '.txt': 'text' }, logLevel: 'silent' });
const files = Object.fromEntries(js.outputFiles.map(f => [f.path.endsWith('.css') ? 'app.css' : 'app.js', f.text]));
const page = `<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>Ravi small icons</title>
<style>${tokens}\n${faceCss}
body{margin:0;padding:12px;background:var(--bg);color:var(--text);font:11px system-ui,-apple-system,sans-serif}
.rv-bob{animation:none!important}
#root{display:inline-block;padding:10px;background:var(--bg)}
.sheet{display:grid;gap:8px 8px;align-items:center;justify-items:center}
.sheet small{color:var(--muted);font-size:10px}.sheet b{font-size:14px}
.cell{display:inline-block;line-height:0}
.bigrow{display:flex;gap:10px;align-items:flex-end;flex-wrap:wrap;width:1100px}
</style><link rel="stylesheet" href="app.css"></head><body><div id="root"></div><script type="module" src="app.js"></script></body></html>`;
const server = createServer((req, res) => {
  const url = req.url.split('?')[0];
  if (url === '/') { res.setHeader('content-type', 'text/html'); return res.end(page); }
  if (url === '/app.js') { res.setHeader('content-type', 'text/javascript'); return res.end(files['app.js']); }
  if (url === '/app.css') { res.setHeader('content-type', 'text/css'); return res.end(files['app.css'] || ''); }
  if (url === '/ravi/face.webp') { res.setHeader('content-type', 'image/webp'); return res.end(readFileSync(resolve(root, 'public/ravi/face.webp'))); }
  res.statusCode = 404; res.end();
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}/`;
const browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true, userDataDir: join(work, 'profile'), args: ['--no-first-run', '--disable-background-networking'] });
mkdirSync(outDir, { recursive: true });
const report = { generatedAt: new Date().toISOString(), cells: {}, bigSame: null, bigPixelSame: null };
const settle = p => p.evaluate(() => Promise.all([...document.images].map(i => i.complete ? i.decode().catch(() => 0) : new Promise(r => { i.onload = i.onerror = r; })))).then(() => new Promise(r => setTimeout(r, 120)));
const cellsOf = p => p.evaluate(() => {
  const r0 = document.getElementById('root').getBoundingClientRect();
  return [...document.querySelectorAll('.cell')].map(c => { const r = c.firstElementChild.getBoundingClientRect(); return { which: c.dataset.which, size: +c.dataset.size, mood: c.dataset.mood, x: r.left - r0.left, y: r.top - r0.top, w: r.width }; });
});
try {
  for (const theme of ['light', 'dark']) {
    for (const dpr of [1, 2]) {
      const p = await browser.newPage();
      await p.setViewport({ width: 1200, height: 900, deviceScaleFactor: dpr });
      await p.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: theme }, { name: 'prefers-reduced-motion', value: 'reduce' }]);
      await p.goto(base, { waitUntil: 'load' });
      await p.evaluate(t => { document.documentElement.dataset.theme = t; }, theme);
      await p.waitForFunction(() => typeof window.sheet === 'function');
      for (const which of ['before', 'after']) {
        await p.evaluate(w => window.sheet(document.getElementById('root'), { which: w }), which);
        await settle(p);
        await (await p.$('#root')).screenshot({ path: join(outDir, `sheet-${which}-${theme}-${dpr}x.png`) });
        report.cells[`${which}-${theme}-${dpr}x`] = await cellsOf(p);
      }
      if (dpr === 2) {
        await p.evaluate(() => window.emotions(document.getElementById('root')));
        await settle(p);
        await (await p.$('#root')).screenshot({ path: join(outDir, `emotions-${theme}.png`) });
      }
      if (theme === 'light' && dpr === 1) {
        report.bigSame = await p.evaluate(() => window.bigSame());
        report.smallApi = await p.evaluate(() => window.smallApiSame());
        // 픽셀 비교: 33px 이상 큰 얼굴을 전·후로 그려 스크린샷 바이트 비교
        const shots = {};
        for (const which of ['before', 'after']) {
          await p.evaluate(w => {
            const root = document.getElementById('root'); root.replaceChildren();
            const row = document.createElement('div'); row.className = 'bigrow';
            for (const m of ['normal', 'happy', 'worried', 'sleep', 'surprised', 'love']) for (const s of [33, 40, 56, 96, 120]) {
              const c = document.createElement('span'); c.className = 'cell'; c.dataset.which = w;
              c.append((w === 'before' ? window.__before : window.__after)(m, s, { round: s < 60 })); row.append(c);
            }
            root.append(row);
          }, which);
          await settle(p);
          shots[which] = await (await p.$('#root')).screenshot({ path: join(outDir, `big-${which}.png`) });
        }
        report.bigPixelSame = Buffer.compare(shots.before, shots.after) === 0;
      }
      if (theme === 'light' && dpr === 1) {
        // 색 트레이(윈도우·리눅스) v2 — 기존 ravi-tray-{16,32}.rgba 와 같은 형식(RGBA 8bit). 기존 파일은 덮지 않는다.
        for (const n of [16, 32]) for (const v of ['normal', 'alert', 'sleep']) {
          const px = Buffer.from(await p.evaluate((n, v) => window.trayRgba(n, v), n, v));
          const name = `ravi-tray-v2-${n}${v === 'normal' ? '' : '-' + v}`;
          const trayDir = resolve(root, process.env.RV_TRAY_DIR || 'src-tauri/icons'); mkdirSync(trayDir, { recursive: true });
          writeFileSync(join(trayDir, `${name}.rgba`), px);
          report.colorTray = [...(report.colorTray || []), name];
        }
      }
      await p.close();
    }
  }
} finally {
  await browser.close(); server.close(); rmSync(work, { recursive: true, force: true });
}
writeFileSync(join(outDir, 'cells.json'), JSON.stringify(report, null, 1));
const bad = [...report.bigSame, ...report.smallApi].filter(r => !r.same);
if (bad.length) console.error(bad.slice(0, 5));
console.log('cells', Object.keys(report.cells).length, 'smallApi', report.smallApi.filter(r => r.same).length, '/', report.smallApi.length, 'bigSame', report.bigSame.length - bad.length, '/', report.bigSame.length, 'bigPixelSame', report.bigPixelSame);
if (bad.length || !report.bigPixelSame) process.exitCode = 1;
