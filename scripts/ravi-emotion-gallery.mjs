// 라비 감정 갤러리 + 브라우저 검사(실제 Chrome, puppeteer-core). 합성 데이터만 — 지갑·노드·네트워크 없음.
//   감정 18종 × 크기 5(큰·중간·미니 L·미니 S·칩) × 라이트/다크 × 동작 줄이기 켬/끔 → PNG 4장 + 유럽어 긴 말풍선 2장.
//   검사: 말풍선 글자 대비 ≥4.5(알파 합성), 톤 모양 ≥3, 가로 넘침 0, 독일어·러시아어 3줄 안에 들어감,
//         동작 줄이기면 움직임 0, 무한 반복 애니메이션 0(기존 얼굴의 눈 깜빡임·zZ 는 별도 집계), 스프링 끝값 0.
// 사용: node scripts/ravi-emotion-gallery.mjs  (결과: artifacts/emotion-gallery/)
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync, mkdirSync, writeFileSync, rmSync, mkdtempSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { build } from 'esbuild';
import puppeteer from 'puppeteer-core';

const root = resolve(import.meta.dirname, '..');
const outDir = resolve(root, 'artifacts/emotion-gallery');
const EMOTIONS = ['neutral', 'happy', 'celebrate', 'fond', 'surprised', 'focused', 'thinking', 'worried', 'calm', 'apologetic', 'sleepy', 'asleep', 'welcome', 'waiting', 'puzzled', 'shy', 'proud', 'relieved'];
const SIZES = ['large', 'medium', 'mini-l', 'mini-s', 'chip'];
const EU = JSON.parse(readFileSync(resolve(root, 'scripts/fixtures/ravi-emotion-eu-samples.json'), 'utf8'));

// 앱의 실제 색 토큰과 얼굴 기본 스타일을 index.html 에서 그대로 가져온다(복사본이 어긋나지 않게).
const indexHtml = readFileSync(resolve(root, 'index.html'), 'utf8');
const pick = re => (indexHtml.match(re) || [''])[0];
const tokens = [pick(/:root \{ color-scheme: light; --bg:#F7F6F3[^\n]*/), pick(/@media \(prefers-color-scheme: dark\) \{ :root:not\(\[data-theme="light"\]\) \{ color-scheme: dark; --bg:#0F1016[^\n]*/), pick(/:root\[data-theme="dark"\] \{ color-scheme: dark; --bg:#0F1016[^\n]*/)].join('\n');
const faceCss = indexHtml.split('\n').filter(l => /\.ravi-face|rvblink|\.rv-lid|rvz|\.rv-z|rvpop|\.rv-pop|rvbob|\.rv-bob|rvthink|\.rv-t1|prefers-reduced-motion: reduce\) \{ \.rv-lid/.test(l)).join('\n');

let server, browser, work, base;
before(async () => {
  assert.ok(tokens.includes('--panel'), '색 토큰을 index.html 에서 못 찾음');
  assert.ok(faceCss.includes('.ravi-face'), '얼굴 스타일을 index.html 에서 못 찾음');
  work = mkdtempSync(join(tmpdir(), 'rv-emotion-'));
  const js = await build({ entryPoints: [resolve(root, 'scripts/fixtures/ravi-emotion-harness.ts')], bundle: true, write: false, format: 'esm', outdir: work, loader: { '.txt': 'text' }, logLevel: 'silent' });
  const files = Object.fromEntries(js.outputFiles.map(f => [f.path.endsWith('.css') ? 'app.css' : 'app.js', f.text]));
  const page = `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Ravi emotion gallery</title>
<style>${tokens}\n${faceCss}
body{margin:0;padding:16px;background:var(--bg);color:var(--text);font:13px system-ui,sans-serif}
.row{display:grid;grid-template-columns:260px 300px 260px 160px 120px;gap:12px;align-items:start;padding:10px 0;border-bottom:1px solid var(--line)}
.cell{min-width:0}.cell small{display:block;color:var(--muted);margin-top:4px}
.stage{box-sizing:border-box;display:flex;gap:8px;align-items:flex-end;flex-wrap:wrap;min-width:0;padding:8px;border-radius:12px;background:var(--panel)}
.cell-mini-l .stage{flex-wrap:nowrap;width:100%;max-width:240px;height:44px;align-items:center;padding:6px 8px}
.cell-mini-l .rv-emo-bubble{min-width:0;flex:1}
.cell-mini-s .stage,.cell-chip .stage{flex-wrap:nowrap;align-items:center}
.eu .row{grid-template-columns:340px 300px 240px}
.ladder{display:flex;gap:18px;align-items:end;padding:10px 0;border-bottom:1px solid var(--line)}.ladder .tray{image-rendering:pixelated}
.faces{display:grid;grid-template-columns:repeat(6,1fr);gap:16px}.faces figure{margin:0;text-align:center}.faces figcaption{color:var(--muted);margin-top:4px}
</style><link rel="stylesheet" href="app.css"></head><body><main id="gallery"></main><script type="module" src="app.js"></script></body></html>`;
  server = createServer((req, res) => {
    const url = req.url.split('?')[0];
    if (url === '/' ) { res.setHeader('content-type', 'text/html'); return res.end(page); }
    if (url === '/app.js') { res.setHeader('content-type', 'text/javascript'); return res.end(files['app.js']); }
    if (url === '/app.css') { res.setHeader('content-type', 'text/css'); return res.end(files['app.css'] || ''); }
    if (url === '/tray.svg') { res.setHeader('content-type', 'image/svg+xml'); return res.end(readFileSync(resolve(root, 'src-tauri/icons/ravi-tray.svg'))); }
    if (url === '/ravi/face.webp') { res.setHeader('content-type', 'image/webp'); return res.end(readFileSync(resolve(root, 'public/ravi/face.webp'))); }
    res.statusCode = 404; res.end();
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}/`;
  browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true, userDataDir: join(work, 'profile'), args: ['--no-first-run', '--disable-background-networking'] });
  mkdirSync(outDir, { recursive: true });
});
after(async () => { await browser?.close(); server?.close(); if (work) rmSync(work, { recursive: true, force: true }); });

async function open(theme, reduced, width = 1240) {
  const page = await browser.newPage();
  await page.setViewport({ width, height: 900, deviceScaleFactor: 1 });
  await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: theme }, { name: 'prefers-reduced-motion', value: reduced ? 'reduce' : 'no-preference' }]);
  await page.goto(base, { waitUntil: 'load' });
  await page.evaluate(t => { document.documentElement.dataset.theme = t; }, theme);
  await page.waitForFunction(() => typeof window.renderGallery === 'function');
  return page;
}

// 페이지 안에서: 알파 합성 대비·넘침·애니메이션 집계.
function measure() {
  const parse = c => { const v = c.match(/[\d.]+/g)?.map(Number); if (!v || v.length < 3) return [0, 0, 0, 0]; return c.startsWith('color(') ? [v[0], v[1], v[2], v[3] ?? 1] : [v[0] / 255, v[1] / 255, v[2] / 255, v[3] ?? 1]; };
  const over = (a, b) => [...a.slice(0, 3).map((x, i) => x * a[3] + b[i] * (1 - a[3])), 1];
  const lum = c => { const f = x => x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]); };
  const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m); return (x + 0.05) / (y + 0.05); };
  const bgOf = el => { const chain = []; for (let p = el; p; p = p.parentElement) chain.unshift(p); return chain.reduce((acc, p) => over(parse(getComputedStyle(p).backgroundColor), acc), [1, 1, 1, 1]); };
  const out = { contrast: [], glyph: [], overflow: [], clipped: [], infinite: 0, emotionInfinite: 0, transformAnims: 0, bubbles: 0 };
  for (const b of document.querySelectorAll('.rv-emo-bubble[data-state="open"]')) {
    out.bubbles++;
    const bg = bgOf(b), fg = over(parse(getComputedStyle(b).color), bg);
    out.contrast.push({ r: +ratio(fg, bg).toFixed(2), at: b.closest('.cell')?.querySelector('small')?.textContent });
    const g = b.querySelector('.rv-emo-glyph');
    if (g) out.glyph.push({ r: +ratio(over(parse(getComputedStyle(g).color), bg), bg).toFixed(2), at: b.closest('.cell')?.querySelector('small')?.textContent });
    if (b.dataset.fit === 'full' && b.scrollHeight > b.clientHeight + 1) out.clipped.push(b.closest('.cell')?.querySelector('small')?.textContent);
    const cell = b.closest('.cell').getBoundingClientRect(), r = b.getBoundingClientRect();
    if (r.right > cell.right + 1 || r.left < cell.left - 1) out.overflow.push(b.closest('.cell')?.querySelector('small')?.textContent);
  }
  for (const d of document.querySelectorAll('.rv-emo-dot, .rv-emo-glyph')) {
    if (d.closest('.rv-emo-bubble')) continue;
    const bg = bgOf(d.parentElement); out.glyph.push({ r: +ratio(over(parse(getComputedStyle(d).color), bg), bg).toFixed(2), at: d.closest('.cell')?.querySelector('small')?.textContent });
  }
  if (document.documentElement.scrollWidth > document.documentElement.clientWidth) out.overflow.push('page');
  for (const a of document.getAnimations()) {
    const it = a.effect?.getTiming().iterations;
    if (it === Infinity) { out.infinite++; const el = a.effect.target; if (el?.closest?.('.rv-emo') || el?.classList?.contains('rv-emo-bubble')) out.emotionInfinite++; }
    if (!(a instanceof CSSAnimation) && a.effect?.getKeyframes().some(k => k.transform)) out.transformAnims++;
  }
  return out;
}

const report = { cases: [], eu: [] };
for (const theme of ['light', 'dark']) for (const reduced of [false, true]) {
  test(`갤러리 ${theme} · 동작 줄이기 ${reduced ? '켬' : '끔'}`, async () => {
    const page = await open(theme, reduced);
    await page.evaluate((e, s) => window.renderGallery({ locale: 'ko', emotions: e, sizes: s }), EMOTIONS, SIZES);
    await new Promise(r => setTimeout(r, 120));
    const early = await page.evaluate(measure); // 움직임이 도는 동안
    await new Promise(r => setTimeout(r, 1100));
    const m = await page.evaluate(measure);
    const name = `gallery-${theme}-${reduced ? 'reduced' : 'motion'}.png`;
    await page.screenshot({ path: join(outDir, name), fullPage: true });
    report.cases.push({ theme, reduced, png: name, bubbles: m.bubbles, minContrast: Math.min(...m.contrast.map(c => c.r)), minGlyph: Math.min(...m.glyph.map(c => c.r)), overflow: m.overflow, clipped: m.clipped, emotionInfinite: early.emotionInfinite, transformAnimsWhileMoving: early.transformAnims });
    assert.ok(m.bubbles >= 10, `말풍선 ${m.bubbles}`);
    for (const c of m.contrast) assert.ok(c.r >= 4.5, `대비 ${c.r} @ ${c.at}`);
    for (const c of m.glyph) assert.ok(c.r >= 3, `톤 모양 대비 ${c.r} @ ${c.at}`);
    assert.deepEqual(m.overflow, [], '가로 넘침');
    assert.deepEqual(m.clipped, [], '말풍선 잘림');
    assert.equal(early.emotionInfinite, 0, '감정 표현에 무한 반복 없음');
    if (reduced) assert.equal(early.transformAnims, 0, '동작 줄이기면 얼굴이 움직이지 않는다');
    else assert.ok(early.transformAnims > 0, '움직임이 실제로 돈다');
    await page.close();
  });
}

for (const locale of ['de', 'ru']) test(`유럽어 긴 말풍선 ${locale}`, async () => {
  const page = await open('light', false, 960);
  await page.evaluate(() => document.body.classList.add('eu'));
  const texts = EU[locale];
  await page.evaluate((e, t) => window.renderGallery({ locale: 'en', emotions: e, sizes: ['large', 'medium', 'mini-l'], texts: t }), Object.keys(texts), texts);
  await new Promise(r => setTimeout(r, 600));
  const m = await page.evaluate(measure);
  const name = `long-${locale}.png`;
  await page.screenshot({ path: join(outDir, name), fullPage: true });
  report.eu.push({ locale, png: name, overflow: m.overflow, clipped: m.clipped, minContrast: Math.min(...m.contrast.map(c => c.r)) });
  assert.deepEqual(m.overflow, []);
  assert.deepEqual(m.clipped, [], '긴 문장도 큰·중간 말풍선 4줄 안');
  await page.close();
});

for (const theme of ['light', 'dark']) test(`표정 판 ${theme}`, async () => {
  const page = await open(theme, true);
  await page.evaluate(e => window.renderFaces(176, e), EMOTIONS);
  await page.evaluate(() => Promise.all([...document.images].map(i => i.decode().catch(() => {}))));
  await new Promise(r => setTimeout(r, 500)); // 덧그림 등장(160ms)이 끝난 뒤
  const name = `faces-${theme}.png`;
  await page.screenshot({ path: join(outDir, name), fullPage: true });
  report.faces = [...(report.faces || []), name];
  const overlays = await page.evaluate(() => document.querySelectorAll('.rv-emo').length);
  assert.ok(overlays >= 7, `덧그림 ${overlays}`);
  await page.close();
});

test('크기 사다리(176→16px + 트레이)', async () => {
  const page = await open('light', true, 900);
  await page.evaluate(() => window.renderLadder([176, 96, 56, 40, 32, 24, 20, 16], ['neutral', 'happy', 'worried', 'calm', 'asleep'], '/tray.svg'));
  await page.evaluate(() => Promise.all([...document.images].map(i => i.decode().catch(() => {}))));
  await new Promise(r => setTimeout(r, 400));
  await page.screenshot({ path: join(outDir, 'ladder.png'), fullPage: true });
  report.faces = [...(report.faces || []), 'ladder.png'];
  // 작은 크기만 4배로(실제 픽셀이 어떻게 뭉개지는지)
  const page2 = await open('light', true, 400);
  await page2.setViewport({ width: 400, height: 300, deviceScaleFactor: 4 });
  await page2.evaluate(() => window.renderLadder([32, 24, 20, 16], ['neutral', 'happy', 'worried'], '/tray.svg'));
  await page2.evaluate(() => Promise.all([...document.images].map(i => i.decode().catch(() => {}))));
  await new Promise(r => setTimeout(r, 400));
  await page2.screenshot({ path: join(outDir, 'ladder-small-4x.png') });
  report.faces.push('ladder-small-4x.png');
  await page.close(); await page2.close();
});

test('폰 폭 390 에서도 넘침 없음(큰·중간 말풍선)', async () => {
  const page = await open('light', false, 390);
  await page.evaluate(() => { const s = document.createElement('style'); s.textContent = '.row{grid-template-columns:1fr !important}'; document.head.append(s); });
  await page.evaluate(e => window.renderGallery({ locale: 'ko', emotions: e, sizes: ['large', 'medium'] }), EMOTIONS);
  await new Promise(r => setTimeout(r, 500));
  const m = await page.evaluate(measure);
  assert.deepEqual(m.overflow, []);
  await page.close();
});

test('스프링: 끝값 0, 감쇠 1 은 넘침 없음, 중단하면 지금 위치에서 다시 간다', async () => {
  const page = await open('light', false);
  const r = await page.evaluate(() => {
    const crit = window.springSamples(1, .32, 520), bouncy = window.springSamples(.72, .34, 700);
    const el = document.createElement('div'); el.style.width = el.style.height = '40px'; document.body.append(el);
    window.playMotion(el, 'bounce', false);
    return { critEnd: crit.at(-1), critMin: Math.min(...crit), bouncyMin: Math.min(...bouncy), anims: el.getAnimations().length };
  });
  assert.equal(r.critEnd, 0); assert.ok(r.critMin >= 0, '감쇠 1 은 반대로 넘어가지 않는다'); assert.ok(r.bouncyMin < 0, '감쇠 .72 는 살짝 넘친다'); assert.equal(r.anims, 1);
  await page.close();
});

after(() => {
  const rows = report.cases.map(c => `<figure><img src="${c.png}" alt="${c.theme} ${c.reduced ? 'reduced motion' : 'motion'}" loading="lazy"><figcaption>${c.theme} · 동작 줄이기 ${c.reduced ? '켬' : '끔'} · 말풍선 ${c.bubbles} · 최소 대비 ${c.minContrast} · 톤 모양 ${c.minGlyph} · 넘침 ${c.overflow.length}</figcaption></figure>`).join('\n')
    + (report.faces || []).map(f => `<figure><img src="${f}" alt="faces" loading="lazy"><figcaption>표정 판(176px, 동작 줄이기) — ${f}</figcaption></figure>`).join('\n')
    + ['light', 'dark'].flatMap(t => ['happy', 'worried'].map(m => `<figure><img src="app-${t}-${m}.png" alt="app ${t} ${m}" loading="lazy"><figcaption>실제 앱(합성 데이터) ${t} · ${m} — ravi-emotion-app-browser.test.mjs 가 만든다</figcaption></figure>`)).join('\n')
    + report.eu.map(c => `<figure><img src="${c.png}" alt="${c.locale} long bubbles" loading="lazy"><figcaption>${c.locale} 긴 말풍선(초안 번역) · 최소 대비 ${c.minContrast} · 잘림 ${c.clipped.length}</figcaption></figure>`).join('\n');
  writeFileSync(join(outDir, 'index.html'), `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Ravi emotion gallery</title><style>:root{--bg:#F7F6F3;--text:#15161D}@media (prefers-color-scheme:dark){:root{--bg:#0F1016;--text:#ECEDF3}}body{margin:0;padding:16px;background:var(--bg);color:var(--text);font:14px system-ui,sans-serif}img{max-width:100%;height:auto;border:1px solid #8884}figure{margin:0 0 24px}</style></head><body><h1>라비 감정 갤러리</h1><p>감정 ${EMOTIONS.length}종 × 크기 ${SIZES.length}(큰·중간·미니 L·미니 S·칩) × 라이트/다크 × 동작 줄이기. 합성 이벤트만 사용.</p>${rows}</body></html>\n`);
  writeFileSync(join(outDir, 'report.json'), JSON.stringify(report, null, 2) + '\n');
});
