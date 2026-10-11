// 유럽어 6개(it·es·fr·pt-BR·de·ru) 화면 시험 — 진짜 Chrome + 가짜 Tauri(앱을 켜지 않는다. 키체인·노드·지갑·네트워크 없음).
//  · 언어 선택 목록 10개 · 「AI 번역입니다 · 오류 신고」 안내 · 선택하면 바뀌고 다시 켜도 기억
//  · 저장된 말이 유럽어여도 사전이 올 때까지 영어, 오면 그 말 · 사전을 못 읽으면 영어(한국어 아님), 바꾸기 거절
//  · 화면 글자(번역 안 하는 칸 제외)에 한글이 남지 않는다 · 가로 넘침 없음
// 화면 캡처: RV_I18N_SHOTS=<폴더> 를 주면 it·de·ru 의 홈·설정·언어 메뉴를 저장한다.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, stat, mkdir } from 'node:fs/promises';
import { mkdtempSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve, join, extname, sep } from 'node:path';
import { tmpdir } from 'node:os';
import puppeteer from 'puppeteer-core';
import { installFixture } from './desktop-fixture.mjs';

const root = resolve(import.meta.dirname, '..');
const LANGS = ['it', 'es', 'fr', 'pt-BR', 'de', 'ru'];
const SHOTS = process.env.RV_I18N_SHOTS ? resolve(process.env.RV_I18N_SHOTS) : null;
let work, dist, browser, server, origin, blockPack = new Set();

before(async () => {
  work = mkdtempSync(join(tmpdir(), 'rv-i18n-ui-'));
  dist = join(work, 'dist');
  execFileSync(process.execPath, [resolve(root, 'node_modules/vite/bin/vite.js'), 'build', '--outDir', dist, '--emptyOutDir', '--logLevel', 'error'], { cwd: root, stdio: ['ignore', 'ignore', 'inherit'] });
  const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.json': 'application/json' };
  server = createServer(async (req, res) => {
    try {
      const pathname = decodeURIComponent(new URL(req.url, 'http://x').pathname);
      const m = /^\/i18n\/(.+)\.json$/.exec(pathname);
      if (m && blockPack.has(m[1])) { res.writeHead(404); res.end(); return; }
      const path = resolve(dist, '.' + pathname);
      if (path !== dist && !path.startsWith(dist + sep)) throw Error('path');
      const file = path === dist ? join(dist, 'index.html') : path;
      if (!(await stat(file)).isFile()) throw Error('file');
      res.writeHead(200, { 'Content-Type': types[extname(file)] || 'application/octet-stream' }); res.end(await readFile(file));
    } catch { res.writeHead(404); res.end(); }
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  origin = `http://127.0.0.1:${server.address().port}`;
  browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true, userDataDir: join(work, 'profile'), args: ['--no-first-run', '--disable-gpu'] });
  if (SHOTS) await mkdir(SHOTS, { recursive: true });
});
after(async () => { await browser?.close(); server?.close(); if (work) rmSync(work, { recursive: true, force: true }); });

async function open({ lang, width = 1280, height = 800 }) {
  const page = await browser.newPage();
  await page.setViewport({ width, height });
  await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
  await page.setRequestInterception(true);
  const seen = [];
  page.on('request', r => {
    const u = new URL(r.url());
    const m = /^\/i18n\/(.+)\.json$/.exec(u.pathname);
    if (m && blockPack.has(decodeURIComponent(m[1]))) { r.respond({ status: 404, body: '' }); return; }
    if (u.origin === origin && r.method() === 'GET') { seen.push(u.pathname); r.continue(); } else r.abort();
  });
  page.on('pageerror', e => (page.__errors ||= []).push(String(e.message || e)));
  // installFixture 는 저장소를 비우고 'ko' 를 넣는다. 한 스크립트 안에서 ① 지금 고른 말을 창 이름에 적어 두고 ② 가짜 Tauri 를 깔고 ③ 고른 말을 되살린다
  // (다시 불러도 선택이 이어진다 — 앱이 저장소에 쓴 것을 시험이 지우지 않게).
  await page.evaluateOnNewDocument((lang, fixtureSource) => {
    const cur = localStorage.getItem('playx-raven-lang'); 
    const chosen = window.name.startsWith('i18n:') ? (cur || window.name.slice(5)) : lang;
    window.name = 'i18n:' + chosen;
    (0, eval)('(' + fixtureSource + ')')({ theme: 'light', sales: true, seller: false });
    localStorage.setItem('playx-raven-lang', chosen);
  }, lang, installFixture.toString());
  await page.goto(origin + '/', { waitUntil: 'networkidle0' });
  await page.waitForFunction(() => document.querySelector('#page-home.on') && !document.documentElement.hasAttribute('data-ravi-arriving'), { timeout: 20000 });
  page.__seen = seen;
  return page;
}
const hangulIn = page => page.evaluate(() => {
  const re = /[ᄀ-ᇿ㄰-㆏가-힯]/;
  const out = [];
  const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n; (n = w.nextNode());) {
    const p = n.parentElement; if (!p || p.closest('script,style,textarea,input,[translate="no"],[hidden]')) continue;
    const s = getComputedStyle(p); const r = p.getBoundingClientRect();
    if (s.display === 'none' || s.visibility === 'hidden' || !r.width || !r.height) continue;
    if (re.test(n.nodeValue)) out.push(n.nodeValue.trim().slice(0, 600));
  }
  return out;
});
const overflow = page => page.evaluate(() => ({ x: document.documentElement.scrollWidth - document.documentElement.clientWidth }));

test('언어 선택: 10개 + AI 번역 안내 + 오류 신고 단추(설정·머리 메뉴 둘 다)', async () => {
  const page = await open({ lang: 'ko' });
  const menu = await page.$$eval('#desktop-language-menu [data-language]', b => b.map(x => x.dataset.language));
  const card = await page.$$eval('.desktop-language-settings [data-language]', b => b.map(x => x.dataset.language));
  const want = ['ko', 'en', 'ja', 'zh', 'it', 'es', 'fr', 'pt-BR', 'de', 'ru'];
  assert.deepEqual(menu, want); assert.deepEqual(card, want);
  assert.equal(await page.$$eval('[data-report-translation]', b => b.length), 2);
  assert.match(await page.$eval('.lang-ai-note', n => n.textContent), /AI 번역입니다.*오류 신고/);
  assert.match(await page.$eval('.desktop-language-settings .meta', n => n.textContent), /이탈리아어.*러시아어.*AI가 번역/);
  await page.close();
});

// 영어 화면에도 원래 한국어로 남는 문구(영어 번역이 없는 것)가 있다 — 유럽어는 그보다 더 남기면 안 된다.
let enBaseline;
// 한 문장 안에서 일부만 번역된 것(영어 화면도 같다)은 한글 낱말 덩어리로 견준다.
const runs = s => s.match(/[\uAC00-\uD7AF]+/g) || [];
const runsOk = s => runs(s).every(r => enBaseline.some(b => runs(b).includes(r)));
async function hangulPages(page) {
  const out = [];
  for (const id of ['home', 'wallet', 'settings']) {
    await page.evaluate(i => document.querySelector(`nav [data-page="${i}"]`)?.click(), id);
    await new Promise(r => setTimeout(r, 450));
    out.push(...(await hangulIn(page)).map(s => `${id}: ${s}`));
    assert.ok((await overflow(page)).x <= 1, `${id} 가로 넘침`);
  }
  return out;
}
test('기준: 영어 화면의 한글 잔존', { timeout: 120_000 }, async () => {
  const page = await open({ lang: 'en' });
  enBaseline = await hangulPages(page);
  await page.close();
});
for (const lang of LANGS) {
  test(`${lang}: 저장된 말로 켜면 사전을 읽고 그 말로 나온다 · 한글 남지 않음 · 가로 넘침 없음`, { timeout: 120_000 }, async () => {
    const page = await open({ lang });
    assert.equal(await page.evaluate(() => document.documentElement.lang), lang);
    assert.ok(page.__seen.includes(`/i18n/${lang}.json`), '사전 파일을 읽었다');
    assert.equal(page.__seen.filter(p => p.startsWith('/i18n/')).length, 1, '고른 말 하나만 읽는다');
    const bad = (await hangulPages(page)).filter(s => !runsOk(s));
    assert.deepEqual(bad, [], `영어 화면보다 더 한글이 남은 곳:\n${bad.join('\n')}`);
    await page.close();
  });
}

test('기억: 언어를 고르면 바뀌고 다시 켜도 그 말 · 한국어로 되돌리면 사전 파일 없이 동작', { timeout: 120_000 }, async () => {
  const page = await open({ lang: 'ko' });
  await page.click('#desktop-preferences');
  await page.click('#desktop-language-menu [data-language="it"]');
  await page.waitForFunction(() => document.documentElement.lang === 'it', { timeout: 10000 });
  assert.equal(await page.evaluate(() => localStorage.getItem('playx-raven-lang')), 'it');
  assert.equal(await page.$eval('#desktop-language-name', n => n.textContent), 'Italiano');
  assert.equal(await page.$eval('#desktop-language-menu [data-language="it"]', b => b.getAttribute('aria-pressed')), 'true');
  // 설정 화면 안내도 이탈리아어로
  await page.evaluate(() => document.querySelector('nav [data-page="settings"]').click());
  await new Promise(r => setTimeout(r, 300));
  assert.match(await page.$eval('.desktop-language-settings .meta', n => n.textContent), /Italiano, spagnolo/);
  assert.equal(await page.$eval('.lang-ai-note span', n => n.textContent), 'Traduzione AI');
  // 다시 켰을 때 이어지는 것은 위의 lang 별 시험(저장된 말로 켜기)이 본다 — 이 가짜 환경은 불러올 때마다 저장소를 비운다.
  await page.click('#desktop-preferences');
  await page.click('#desktop-language-menu [data-language="ko"]');
  await page.waitForFunction(() => document.documentElement.lang === 'ko');
  await page.close();
});

test('사전을 못 읽으면: 바꾸기는 거절(지금 말 그대로) · 켤 때 못 읽으면 영어(한국어 아님)', { timeout: 120_000 }, async () => {
  blockPack.add('ru');
  try {
    const page = await open({ lang: 'ko' });
    await page.click('#desktop-preferences');
    await page.click('#desktop-language-menu [data-language="ru"]');
    await new Promise(r => setTimeout(r, 800));
    assert.equal(await page.evaluate(() => document.documentElement.lang), 'ko', '거절돼야 한다');
    assert.equal(await page.evaluate(() => localStorage.getItem('playx-raven-lang')), 'ko');
    await page.close();
    const boot = await open({ lang: 'ru' });
    assert.equal(await boot.evaluate(() => document.documentElement.lang), 'en');
    assert.equal(await boot.evaluate(() => localStorage.getItem('playx-raven-lang')), 'ru', '선택값은 지우지 않는다');
    const left = (await hangulIn(boot)).filter(s => !runsOk(s));
    assert.deepEqual(left, [], '한국어가 아니라 영어(영어 화면에도 원래 없는 번역은 제외)');
    await boot.close();
  } finally { blockPack.delete('ru'); }
});

test('시스템 언어가 이탈리아어여도 저절로 고르지 않는다(AI 번역은 사람이 직접 고른 것만)', async () => {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });
  await page.setRequestInterception(true);
  page.on('request', r => (new URL(r.url()).origin === origin && r.method() === 'GET') ? r.continue() : r.abort());
  await page.evaluateOnNewDocument(installFixture, { theme: 'light', sales: true, seller: false });
  await page.evaluateOnNewDocument(() => { localStorage.removeItem('playx-raven-lang'); Object.defineProperty(navigator, 'language', { get: () => 'it-IT' }); });
  await page.goto(origin + '/', { waitUntil: 'networkidle0' });
  await page.waitForFunction(() => document.querySelector('#page-home.on'));
  assert.equal(await page.evaluate(() => document.documentElement.lang), 'en');
  await page.close();
});

if (SHOTS) {
  test('화면 캡처 (it·de·ru): 홈 · 설정 · 언어 메뉴, 1440 + 1120', { timeout: 300_000 }, async () => {
    for (const lang of ['it', 'de', 'ru']) for (const [w, h] of [[1440, 900], [1120, 780]]) {
      const page = await open({ lang, width: w, height: h });
      await page.screenshot({ path: join(SHOTS, `${lang}-${w}-home.png`) });
      await page.click('#desktop-preferences'); await new Promise(r => setTimeout(r, 200));
      await page.screenshot({ path: join(SHOTS, `${lang}-${w}-menu.png`) });
      await page.click('#desktop-preferences');
      await page.evaluate(() => document.querySelector('nav [data-page="settings"]').click());
      await new Promise(r => setTimeout(r, 500));
      await page.evaluate(() => document.querySelector('.desktop-language-settings').scrollIntoView());
      await page.screenshot({ path: join(SHOTS, `${lang}-${w}-settings.png`) });
      await page.close();
    }
  });
}

// 글자 길이 넘침: 모든 화면(section.page)의 단추·라벨·제목 중 글자가 칸 밖으로 잘리거나(가로) 칸 높이를 넘는 것을 센다.
// 영어 화면에서도 그런 칸은 제외한다(원래 있던 것). 유럽어에서 새로 생긴 것만 실패.
const clipScan = page => page.evaluate(() => {
  const out = [];
  const shown = el => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility === 'visible' && s.display !== 'none'; };
  for (const sec of document.querySelectorAll('section.page[id]')) {
    document.querySelectorAll('section.page').forEach(p => p.classList.toggle('on', p === sec));
    for (const el of sec.querySelectorAll('button, .btn, label, h1, h2, h3, th, summary, .chip, [role="tab"]')) {
      if (!shown(el) || el.closest('[hidden],[inert],[translate="no"]') || !/\S/.test(el.textContent)) continue;
      const s = getComputedStyle(el);
      const clipX = el.scrollWidth > el.clientWidth + 1 && s.overflowX !== 'visible';
      const nowrapOut = s.whiteSpace === 'nowrap' && el.scrollWidth > el.clientWidth + 1;
      const parent = el.parentElement.getBoundingClientRect(), r = el.getBoundingClientRect();
      const outside = r.right > parent.right + 2 && ['hidden', 'clip'].includes(getComputedStyle(el.parentElement).overflowX); // 옆으로 밀리는 줄(auto·scroll)은 잘린 것이 아니다
      if (clipX || nowrapOut || outside) out.push(`${sec.id}: ${el.id ? '#' + el.id : el.tagName.toLowerCase()} 「${el.textContent.trim().replace(/\s+/g, ' ').slice(0, 40)}」`);
    }
  }
  return out;
});
const SIZES = [[1024, 640], [1440, 900]];
const clipBase = {};
test('길이: 영어 화면 기준 넘침 수집', { timeout: 300_000 }, async () => {
  for (const [w, h] of SIZES) { const page = await open({ lang: 'en', width: w, height: h }); clipBase[`${w}`] = new Set((await clipScan(page)).map(s => s.replace(/「.*」/, ''))); await page.close(); }
});
for (const lang of LANGS) {
  test(`길이: ${lang} — 영어에 없던 글자 잘림·칸 밖으로 나감이 없다`, { timeout: 300_000 }, async () => {
    const found = [];
    for (const [w, h] of SIZES) {
      const page = await open({ lang, width: w, height: h });
      for (const s of await clipScan(page)) if (!clipBase[`${w}`].has(s.replace(/「.*」/, ''))) found.push(`${w}px ${s}`);
      await page.close();
    }
    if (process.env.RV_I18N_CLIP_REPORT) { const { appendFileSync } = await import('node:fs'); appendFileSync(process.env.RV_I18N_CLIP_REPORT, `## ${lang}\n${found.join('\n')}\n`); }
    assert.deepEqual(found, [], `${lang} 넘침:\n${found.join('\n')}`);
  });
}

// 암호 걸기 확인 문구: 사용자가 화면에 보이는 문구를 그대로 쳐야 열린다 — 비교 대상은 화면에 보이는 그 말이어야 하고, 언어를 바꾸면 다시 쳐야 한다.
for (const lang of ['it', 'de', 'ru']) {
  test(`${lang}: 암호 확인 문구는 보이는 말과 같아야 열리고, 언어를 바꾸면 비워진다`, { timeout: 120_000 }, async () => {
    const page = await open({ lang });
    await page.evaluate(() => document.querySelector('nav [data-page="wallet"]').click());
    await page.evaluate(() => document.getElementById('w-enc').click());
    await page.waitForFunction(() => document.getElementById('encbox').style.display !== 'none');
    await new Promise(r => setTimeout(r, 400));
    const shown = await page.$eval('#enc-phrase', n => n.textContent.trim());
    assert.ok(shown && !/[\uAC00-\uD7AF]/.test(shown) || lang === 'x', '번역(또는 영어)이 보여야 한다: ' + shown);
    const type = async (id, v) => { await page.$eval('#' + id, (el, v) => { el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); }, v); };
    await page.$eval('#enc-old', el => { el.value = 'x'; });
    await type('enc-new', 'abcdefghij12'); await type('enc-new2', 'abcdefghij12');
    await type('enc-confirm', '암호를 잊으면 되돌릴 수 없다');  // 한국어 원문은 번역 화면에서 통하면 안 된다
    assert.equal(await page.$eval('#enc-go', b => b.disabled), true, '원문(한국어)으로는 안 열린다');
    await type('enc-confirm', shown);
    assert.equal(await page.$eval('#enc-go', b => b.disabled), false, '보이는 문구를 그대로 치면 열린다');
    // 언어를 바꾸면 확인 글이 비워지고 다시 잠긴다
    await page.evaluate(l => document.querySelector(`#desktop-language-menu [data-language="${l}"]`).click(), lang === 'it' ? 'de' : 'it');
    await page.waitForFunction(l => document.documentElement.lang === l, { timeout: 10000 }, lang === 'it' ? 'de' : 'it');
    await new Promise(r => setTimeout(r, 500));
    assert.equal(await page.$eval('#enc-confirm', i => i.value), '');
    assert.equal(await page.$eval('#enc-go', b => b.disabled), true);
    await page.close();
  });
}
