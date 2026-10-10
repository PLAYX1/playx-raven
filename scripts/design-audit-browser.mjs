// 디자인 전수 점검 — 실제 Chrome 에서 **빌드된 dist** 를 합성 자료(desktop-fixture)로 띄워
// 화면마다 3폭(390·1024·1440) × 라이트·다크로 스크린샷을 찍고 숫자로 잰다.
//
//   · 모든 보이는 글자의 대비(알파 합성한 실제 배경 기준, 4.5:1 / 큰 글자 3:1)
//   · ghost 단추 :hover 강제(CDP forcePseudoState) 대비 — 이미 알려진 전역 문제를 잰다
//   · 가로 넘침(문서·요소가 화면 밖), 단추 글자 잘림(scrollWidth > clientWidth)
//   · 12px 미만 글자, 24px 미만 누름 대상
//   · 긴 말 흉내(독일어·러시아어 의사 번역)로 단추·탭·제목 글자를 늘려 넘침을 다시 잼
//   · 키릴 글자가 번들 글꼴(IBM Plex Sans KR)로 그려지는지(CDP getPlatformFontsForNode)
//
// 쓰지 않는 것: 노드·지갑·네트워크(가짜 IPC 가 보내기·잠금 해제 계열을 거절한다).
// 결과: artifacts/design-audit/{report.json, *.png}
//
// 돌리는 법: node scripts/design-audit-browser.mjs  (npm run audit:design)
// 고치기 전 숫자는 git 기록의 report.json(첫 실행)과 비교한다 — 빌드가 CSS 주석을 지워 고침 블록만 끄는 것은 안 된다.
import { createServer } from 'node:http';
import { readFile, stat, mkdir, writeFile } from 'node:fs/promises';
import { mkdtempSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve, join, extname, sep } from 'node:path';
import { tmpdir } from 'node:os';
import puppeteer from 'puppeteer-core';
import { installFixture } from './desktop-fixture.mjs';

const root = resolve(import.meta.dirname, '..');
const OUT = resolve(process.env.RV_AUDIT_OUT || join(root, 'artifacts/design-audit'));
const VIEWPORTS = (process.env.RV_AUDIT_VIEWPORTS || '390x844,720x560,1024x640,1440x900').split(',').map((s) => s.split('x').map(Number));
const THEMES = ['light', 'dark'];
const SHOTS = process.env.RV_AUDIT_SHOTS !== '0';

// 화면 = 페이지 + (선택) 들어가는 동작. 동작은 앱처럼 $eval click.
const SCREENS = [
  { id: 'home', page: 'page-home' },
  { id: 'wallet', page: 'page-wallet' },
  { id: 'wallet-receive', page: 'page-wallet', click: '#w-receive' },
  { id: 'wallet-send', page: 'page-wallet', click: '#w-send-rvn' },
  { id: 'wallet-restore', page: 'page-wallet', click: '#w-restore-words' },
  { id: 'assets', page: 'page-assets' },
  { id: 'sales', page: 'page-sales' },
  { id: 'games', page: 'page-games' },
  { id: 'market', page: 'page-market' },
  { id: 'creator', page: 'page-creator' },
  { id: 'ravi', page: 'page-ravi' },
  { id: 'settings', page: 'page-settings' },
  { id: 'shop', page: 'page-shop' },
  { id: 'dialog-backup', page: 'page-home', reminder: true },
];

function measure({ pageId, pseudo }) {
  const parse = (c) => { const v = c.match(/[\d.]+/g)?.map(Number); if (!v || v.length < 3) return [0, 0, 0, 0];
    return c.startsWith('color(') ? [v[0], v[1], v[2], v[3] ?? 1] : [v[0] / 255, v[1] / 255, v[2] / 255, v[3] ?? 1]; };
  const opacityOf = (el) => { let o = 1; for (let p = el; p; p = p.parentElement) o *= parseFloat(getComputedStyle(p).opacity); return o; };
  const over = (a, b) => [...a.slice(0, 3).map((x, i) => x * a[3] + b[i] * (1 - a[3])), 1];
  const lum = (c) => { const f = (x) => (x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4); return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]); };
  const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m); return (x + 0.05) / (y + 0.05); };
  const shown = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility === 'visible' && s.display !== 'none' && !el.closest('[hidden],[inert],[aria-hidden="true"]') && (el.checkVisibility ? el.checkVisibility({ contentVisibilityAuto: true }) : true); };
  const describe = (el) => (el.id ? `#${el.id}` : el.tagName.toLowerCase() + (el.classList.length ? '.' + [...el.classList].slice(0, 2).join('.') : '')) + (el.textContent.trim() ? `「${el.textContent.trim().replace(/\s+/g, ' ').slice(0, 22)}」` : '');
  const bgOf = (el) => { const chain = []; for (let p = el; p; p = p.parentElement) chain.unshift(p); let gradient = false;
    const c = chain.reduce((acc, p) => { const s = getComputedStyle(p); if (s.backgroundImage !== 'none' && p !== document.documentElement && p !== document.body) gradient = true; return over(parse(s.backgroundColor), acc); }, [1, 1, 1, 1]);
    return { c, gradient }; };
  const scope = document.getElementById(pageId);
  const roots = [scope, document.querySelector('nav'), ...document.querySelectorAll('dialog[open]')].filter(Boolean);
  const vw = document.documentElement.clientWidth;
  const out = { contrast: [], overflow: [], clipped: [], tiny: [], small: [], docOverflow: document.documentElement.scrollWidth - vw, texts: 0 };
  const seen = new Set();
  for (const r of roots) for (const n of r.querySelectorAll('*')) {
    if (!shown(n)) continue;
    const s = getComputedStyle(n);
    const own = [...n.childNodes].some((t) => t.nodeType === 3 && t.textContent.trim());
    if (own && parseFloat(s.opacity) !== 0) {
      out.texts++;
      const { c, gradient } = bgOf(n);
      const raw = parse(s.color); const fg = over([raw[0], raw[1], raw[2], raw[3] * opacityOf(n)], c);
      const size = parseFloat(s.fontSize), bold = parseInt(s.fontWeight, 10) >= 700;
      const need = size >= 24 || (bold && size >= 18.66) ? 3 : 4.5;
      const rt = Math.round(ratio(fg, c) * 100) / 100;
      const disabled = n.closest('button:disabled,[aria-disabled="true"],input:disabled');
      if (!gradient && !disabled && rt < need) out.contrast.push({ el: describe(n), ratio: rt, need });
      if (size < 12 && !seen.has(n)) out.tiny.push({ el: describe(n), px: size });
    }
    const rect = n.getBoundingClientRect();
    if (rect.right > vw + 1 && !n.closest('[style*="overflow"]') && s.position !== 'fixed') {
      // 가로 스크롤 상자 안은 의도된 넘침
      let scrollable = false; for (let p = n.parentElement; p && p !== document.body; p = p.parentElement) { const ps = getComputedStyle(p); if (/(auto|scroll)/.test(ps.overflowX)) { scrollable = true; break; } }
      if (!scrollable) out.overflow.push({ el: describe(n), right: Math.round(rect.right), vw });
    }
    if (n.matches('button, a[data-page], [role="button"], summary, label.check')) {
      if (n.scrollWidth > n.clientWidth + 1 && s.overflow !== 'visible') out.clipped.push({ el: describe(n), sw: n.scrollWidth, cw: n.clientWidth });
      else if (n.scrollWidth > n.clientWidth + 1 && n.clientWidth > 0) out.clipped.push({ el: describe(n), sw: n.scrollWidth, cw: n.clientWidth, spill: true });
      if ((rect.height < 24 || rect.width < 24) && !n.disabled) out.small.push({ el: describe(n), w: Math.round(rect.width), h: Math.round(rect.height) });
    }
  }
  if (pseudo) out.pseudo = pseudo;
  return out;
}

// 긴 말 흉내 — 단추·탭·제목·라벨 글자를 독일어/러시아어 길이로. 한 낱말이 길어 줄바꿈이 안 되는 것까지.
function pseudoLocalize(lang) {
  const DE = ['Wiederherstellungsschlüssel', 'Kontostandsübersicht', 'Bestätigungen', 'Einstellungen', 'Sicherungskopie', 'Empfangsadresse', 'Überweisung', 'Verkäufermodus'];
  const RU = ['Восстановление', 'Подтверждение', 'Настройки', 'Резервная копия', 'Адрес получения', 'Отправить', 'Синхронизируется', 'Режим продавца'];
  const words = lang === 'de' ? DE : RU;
  let i = 0, changed = 0;
  for (const el of document.querySelectorAll('button, nav a span, h1, h2, h3, label, summary, .meta, th, .tab, [role="tab"]')) {
    for (const t of el.childNodes) {
      if (t.nodeType !== 3 || !t.textContent.trim()) continue;
      const korean = t.textContent.trim();
      // 한글 1자 ≈ 라틴 2.4자(영어 1.8 × 독일어 1.3). 최소 한 낱말은 긴 합성어.
      const target = Math.max(8, Math.round(korean.length * 2.4));
      let s = words[i++ % words.length];
      while (s.length < target) s += ' ' + words[i++ % words.length].toLowerCase();
      t.textContent = s; changed++;
    }
  }
  return changed;
}

let work, dist, browser, server, origin;
async function start() {
  work = mkdtempSync(join(tmpdir(), 'rv-design-audit-'));
  dist = join(work, 'dist');
  execFileSync(process.execPath, [resolve(root, 'node_modules/vite/bin/vite.js'), 'build', '--outDir', dist, '--emptyOutDir', '--logLevel', 'error'], { cwd: root, stdio: ['ignore', 'ignore', 'inherit'], env: { ...process.env } });
  const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.jpg': 'image/jpeg', '.webp': 'image/webp' };
  server = createServer(async (req, res) => {
    try {
      const path = resolve(dist, '.' + decodeURIComponent(new URL(req.url, 'http://x').pathname));
      if (path !== dist && !path.startsWith(dist + sep)) throw Error('path');
      const file = path === dist ? join(dist, 'index.html') : path;
      if (!(await stat(file)).isFile()) throw Error('file');
      const body = await readFile(file);
      res.writeHead(200, { 'Content-Type': types[extname(file)] || 'application/octet-stream' }); res.end(body);
    } catch { res.writeHead(404); res.end(); }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  origin = `http://127.0.0.1:${server.address().port}`;
  browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true, userDataDir: join(work, 'profile'), args: ['--no-first-run', '--disable-background-networking'] });
}

async function open({ width, height, theme, reminder = false }) {
  const page = await browser.newPage();
  await page.setViewport({ width, height });
  await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: theme }, { name: 'prefers-reduced-motion', value: 'reduce' }]);
  await page.setRequestInterception(true);
  page.on('request', (r) => ((new URL(r.url()).origin === origin && r.method() === 'GET') ? r.continue() : r.abort()));
  await page.evaluateOnNewDocument(installFixture, { theme, sales: true, seller: true });
  if (!reminder) await page.evaluateOnNewDocument(() => localStorage.setItem('rv-v2-backup-reminded', '1'));
  await page.goto(origin + '/', { waitUntil: 'networkidle0' });
  await page.waitForFunction(() => document.querySelector('#page-home.on') && !document.documentElement.hasAttribute('data-ravi-arriving'), { timeout: 20000 });
  return page;
}

async function goScreen(page, sc) {
  await page.evaluate((id) => { document.querySelectorAll('section.page').forEach((p) => p.classList.toggle('on', p.id === id)); window.scrollTo(0, 0); }, sc.page);
  if (sc.click) await page.evaluate((sel) => document.querySelector(sel)?.click(), sc.click).catch(() => {});
  await new Promise((r) => setTimeout(r, 250));
}

async function hoverGhosts(page, pageId) {
  // :hover 를 CDP 로 강제하고 대비를 잰다(ghost 단추 = 알려진 전역 문제).
  const cdp = await page.target().createCDPSession();
  await cdp.send('DOM.enable'); await cdp.send('CSS.enable');
  const { root: doc } = await cdp.send('DOM.getDocument', { depth: -1 });
  const { nodeIds } = await cdp.send('DOM.querySelectorAll', { nodeId: doc.nodeId, selector: `#${pageId} button.ghost` });
  const res = [];
  for (const id of nodeIds) {
    await cdp.send('CSS.forcePseudoState', { nodeId: id, forcedPseudoClasses: ['hover'] });
    const { object } = await cdp.send('DOM.resolveNode', { nodeId: id });
    const { result } = await cdp.send('Runtime.callFunctionOn', { objectId: object.objectId, returnByValue: true, functionDeclaration: `function(){
      const el=this; const r=el.getBoundingClientRect(); const s=getComputedStyle(el);
      if(!(r.width>0&&r.height>0)||s.display==='none'||el.disabled||el.closest('[hidden],[inert]')||!el.textContent.trim()) return null;
      const parse=c=>{const v=c.match(/[\\d.]+/g)?.map(Number);if(!v||v.length<3)return[0,0,0,0];return c.startsWith('color(')?[v[0],v[1],v[2],v[3]??1]:[v[0]/255,v[1]/255,v[2]/255,v[3]??1];};
      const over=(a,b)=>[...a.slice(0,3).map((x,i)=>x*a[3]+b[i]*(1-a[3])),1];
      const lum=c=>{const f=x=>x<=0.03928?x/12.92:((x+0.055)/1.055)**2.4;return 0.2126*f(c[0])+0.7152*f(c[1])+0.0722*f(c[2]);};
      const chain=[];for(let p=el;p;p=p.parentElement)chain.unshift(p);
      const bg=chain.reduce((acc,p)=>over(parse(getComputedStyle(p).backgroundColor),acc),[1,1,1,1]);
      const fg=over(parse(s.color),bg);const [x,y]=[lum(fg),lum(bg)].sort((m,n)=>n-m);
      return {el:(el.id?'#'+el.id:'button.ghost')+'「'+el.textContent.trim().slice(0,18)+'」',ratio:Math.round((x+0.05)/(y+0.05)*100)/100,bg:getComputedStyle(el).backgroundColor,fg:s.color};}` });
    await cdp.send('CSS.forcePseudoState', { nodeId: id, forcedPseudoClasses: [] });
    if (result.value) res.push(result.value);
  }
  await cdp.detach();
  return res;
}

async function cyrillicFont(page) {
  const cdp = await page.target().createCDPSession();
  await cdp.send('DOM.enable'); await cdp.send('CSS.enable');
  await page.evaluate(() => { const s = document.createElement('span'); s.id = '__cyr'; s.textContent = 'Подтверждение Wiederherstellungsschlüssel'; document.querySelector('#page-home h2, h2, body').appendChild(s); });
  const { root: doc } = await cdp.send('DOM.getDocument', { depth: -1 });
  const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: doc.nodeId, selector: '#__cyr' });
  const { fonts } = await cdp.send('CSS.getPlatformFontsForNode', { nodeId });
  const family = await page.$eval('#__cyr', (e) => getComputedStyle(e).fontFamily);
  await page.evaluate(() => document.getElementById('__cyr')?.remove());
  await cdp.detach();
  return { declared: family, rendered: fonts };
}

async function main() {
  await mkdir(OUT, { recursive: true });
  await start();
  const report = { when: new Date().toISOString(), runs: [] };
  try {
    for (const [width, height] of VIEWPORTS) for (const theme of THEMES) {
      for (const sc of SCREENS) {
        const page = await open({ width, height, theme, reminder: !!sc.reminder });
        if (!report.font) report.font = await cyrillicFont(page);
        if (sc.reminder) await new Promise((r) => setTimeout(r, 1500)); else await goScreen(page, sc);
        const exists = await page.evaluate((id) => !!document.getElementById(id), sc.page);
        if (!exists) { report.runs.push({ screen: sc.id, width, theme, missing: true }); await page.close(); continue; }
        const m = await page.evaluate(measure, { pageId: sc.page });
        m.hoverGhost = (await hoverGhosts(page, sc.page)).filter((r) => r.ratio < 4.5);
        if (SHOTS) await page.screenshot({ path: join(OUT, `${sc.id}-${width}-${theme}.png`), fullPage: false });
        report.runs.push({ screen: sc.id, width, theme, ...m });
        await page.close();
      }
      // 긴 말 흉내(1024·1440 만 — 창 최소 폭이 720)
      if (width >= 1024) for (const lang of ['de', 'ru']) for (const sc of SCREENS.filter((s) => ['home', 'wallet', 'settings', 'games', 'assets'].includes(s.id))) {
        const p2 = await open({ width, height, theme });
        await goScreen(p2, sc);
        const n = await p2.evaluate(pseudoLocalize, lang);
        await new Promise((r) => setTimeout(r, 150));
        const m = await p2.evaluate(measure, { pageId: sc.page, pseudo: { lang, changed: n } });
        if (SHOTS && theme === 'light') await p2.screenshot({ path: join(OUT, `pseudo-${lang}-${sc.id}-${width}.png`) });
        report.runs.push({ screen: sc.id, width, theme, lang, docOverflow: m.docOverflow, overflow: m.overflow.length, clipped: m.clipped, pseudo: m.pseudo });
        await p2.close();
      }
    }
  } finally {
    await browser?.close(); server?.close(); if (work) rmSync(work, { recursive: true, force: true });
  }
  await writeFile(join(OUT, 'report.json'), JSON.stringify(report, null, 1));
  // 요약
  const sum = {};
  for (const r of report.runs.filter((x) => !x.lang && !x.missing)) {
    const k = `${r.screen}`; sum[k] ??= { contrast: 0, hoverGhost: 0, overflow: 0, clipped: 0, tiny: 0, small: 0, docOverflow: 0 };
    sum[k].contrast += r.contrast.length; sum[k].hoverGhost += r.hoverGhost.length; sum[k].overflow += r.overflow.length; sum[k].clipped += r.clipped.length; sum[k].tiny += r.tiny.length; sum[k].small += r.small.length; sum[k].docOverflow = Math.max(sum[k].docOverflow, r.docOverflow);
  }
  console.table(sum);
  const ps = report.runs.filter((x) => x.lang);
  console.log('pseudo-l10n:', ps.map((p) => `${p.lang}/${p.screen}/${p.width}/${p.theme}: clipped ${p.clipped.length} overflow ${p.overflow} doc+${p.docOverflow}`).join('\n'));
  console.log('font:', JSON.stringify(report.font));
}
main().catch((e) => { console.error(e); process.exit(1); });
