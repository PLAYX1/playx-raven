// 11-29 라비 창 배치 시험(페이블 판정 1묶음) — 진짜 빌드(dist) + 가짜 Tauri·가짜 음성. 바깥 요청 0, 지갑 데이터 없음.
// 창 400×800 · 1440×900 에서:
//  - 페이지·라비 창 가로 넘침 0 · 라비 창이 화면 안
//  - 머리 상태 글(「말하는 중 · 라비의 목소리」)·제목·단추 글자 한 줄(두 줄 금지)
//  - 대화 기록 칸 ≥ 창 높이 65%(빈 대화는 시작 칩 포함 칸, 질문 뒤는 기록 칸 자체)
//  - 시작 칩 ≤ 3 · 빈 대화에서만 · 「답 읽어 주기」 칩이 창에 늘 떠 있지 않음 · 위쪽 두 줄(홍보·묻기 방식) 없음
//  - 마이크는 그림 글자(🎙)가 아니라 선 아이콘, 키 없으면 흐리게 + 이유 한 줄(숨기지 않음)
//  - 라비 입구 한 곳(왼쪽 막대) · 첫 화면 라비 얼굴 하나 · 글로 물은 답은 읽지 않고 스피커 단추, 「말하는 중」 없음
// RV_RAVI_SHOTS=<폴더> 면 그 폴더에 db1-*.png 를 남긴다.
import assert from 'node:assert/strict';
import { readFileSync, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { resolve, extname } from 'node:path';
import { tmpdir } from 'node:os';
import puppeteer from 'puppeteer-core';
const root = resolve(import.meta.dirname, '..'), dist = resolve(root, 'dist');
const shots = process.env.RV_RAVI_SHOTS || resolve(root, 'artifacts/desktop-ravi-layout'); mkdirSync(shots, { recursive: true });
const profile = mkdtempSync(resolve(tmpdir(), 'rv-ravi-layout-'));
const origin = 'http://rv-ravi-layout.test';
const settle = page => page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
let browser;
async function open(width, height, keyed) {
  const context = await browser.createBrowserContext(), page = await context.newPage(), errors = [];
  page.on('pageerror', e => errors.push(e.message + (process.env.RV_DEBUG ? ' | ' + String(e.stack).slice(0, 500) : ''))); await page.setViewport({ width, height, deviceScaleFactor: 2 });
  await page.setRequestInterception(true);
  page.on('request', request => {
    const url = request.url();
    if (url.startsWith('data:') || url.startsWith('blob:')) { void request.continue(); return; }
    if (!url.startsWith(origin + '/')) { void request.abort(); return; }
    const path = new URL(url).pathname;
    if (path.startsWith('/api/')) { void request.respond({ status: 200, contentType: 'application/json', body: '{}' }); return; }
    const file = resolve(dist, '.' + (path === '/' ? '/index.html' : path));
    if (!file.startsWith(dist + '/') || !existsSync(file)) { void request.respond({ status: 404, body: '' }); return; }
    void request.respond({ status: 200, contentType: ({ '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.webp': 'image/webp', '.json': 'application/json' })[extname(file)] || 'application/octet-stream', body: readFileSync(file) });
  });
  await page.evaluateOnNewDocument(keyed => {
    localStorage.setItem('playx-raven-lang', 'ko'); localStorage.setItem('rv-ravi-start-off', '1'); window.__CALLS = []; window.__SPOKEN = 0;
    class Recognition { start() {} abort() {} }
    window.SpeechRecognition = Recognition;
    window.SpeechSynthesisUtterance = class { constructor(text) { this.text = text; } };
    Object.defineProperty(window, 'speechSynthesis', { value: { getVoices: () => [{ name: 'Yuna', lang: 'ko-KR' }], cancel() {}, speak() { window.__SPOKEN++; } } });
    window.__TAURI_INTERNALS__ = { invoke: async (command) => {
      window.__CALLS.push(command);
      if (command === 'node_status') return { blocks: 1000, headers: 1000, progress: 1, peers: 3 };
      if (command === 'wallet_balance') return { confirmed: 42.125, unconfirmed: 3.5 };
      if (command === 'api_key_status') return keyed ? { available: { openai: true }, has_key: { openai: true }, last4: { openai: 'TEST' } } : {};
      if (command === 'money_status') throw 'Synthetic unavailable status';
      if (command === 'model_settings') return {};
      if (command === 'plugin:app|version') return '0.9.59';
      if (['list_assets', 'pin_list', 'my_channels'].includes(command)) return [];
      if (command === 'backup_survey') return { items: [], automatic: null };
      if (command === 'artist_profile_get') return { name: '', about: '', picture: '', website: '' };
      if (command.startsWith('ravi_tts')) throw 'synthetic: no voice model';
      return null;
    }, transformCallback: f => f, metadata: {} };
  }, keyed);
  await page.goto(origin, { waitUntil: 'networkidle0' });
  await page.addStyleTag({ content: '#onboard,#hello{display:none!important}' });
  await page.waitForFunction(() => !document.documentElement.hasAttribute('data-ravi-arriving'), { timeout: 20000 }).catch(() => {});
  await settle(page);
  return { page, context, errors };
}
const measure = page => page.evaluate(() => {
  const panel = document.getElementById('ravi-panel'), p = panel.getBoundingClientRect();
  const h = sel => document.querySelector(sel)?.getBoundingClientRect().height || 0;
  const lines = el => { const r = document.createRange(); r.selectNodeContents(el); return new Set([...r.getClientRects()].filter(x => x.width > 1).map(x => Math.round(x.top / 4))).size; };
  const shown = el => !!el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden';
  const wrapped = [...panel.querySelectorAll('button, .ravi-panel-title strong, #ravi-panel-state, .ravi-mic-why')].filter(shown).filter(el => el.textContent.trim() && lines(el) > 1).map(el => el.id || el.className || el.textContent.trim());
  return {
    pageOverflow: document.documentElement.scrollWidth - innerWidth,
    panelOverflow: panel.scrollWidth - panel.clientWidth,
    inside: p.left >= 0 && p.right <= innerWidth + .5 && p.top >= 0 && p.bottom <= innerHeight + .5,
    width: p.width, height: p.height,
    history: h('#ravi-panel .ravi-history') / p.height, log: h('#chat-log') / p.height,
    stateLines: lines(document.getElementById('ravi-panel-state')),
    wrapped,
    chips: [...document.querySelectorAll('#ravi-panel .rv-quick button')].filter(shown).map(b => b.textContent.trim()),
    readChipShown: shown(document.getElementById('ravi-read')),
    promoShown: shown(document.getElementById('ravi-promo-open')), modeShown: [...document.querySelectorAll('#chat-mode button')].some(shown),
    mic: { shown: shown(document.getElementById('rv-voice')), emoji: /🎙/.test(document.getElementById('rv-voice').textContent), svg: !!document.querySelector('#rv-voice svg'), disabled: document.getElementById('rv-voice').getAttribute('aria-disabled'), why: shown(document.getElementById('ravi-mic-why')) ? document.getElementById('ravi-mic-why').textContent : '' },
  };
});
const entries = page => page.evaluate(() => {
  const shown = el => !!el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden' && getComputedStyle(el).display !== 'none';
  const ids = ['rv-header-ravi', 'ravi-launcher', 'v2-ravi-say', 'v2-ravi-mic', 'ravi-open', 'rv-room-ravi'];
  return { entries: ids.filter(id => { const el = document.getElementById(id); return el && shown(el); }), homeFaces: [...document.querySelectorAll('#page-home .ravi-face, #page-home [id$="ravi-face"]')].filter(shown).length };
});
async function ask(page, text) {
  const n = await page.$$eval('#chat-log .msg.ai', l => l.length);
  await page.focus('#chat-q'); await page.keyboard.type(text); await page.click('#chat-go');
  await page.waitForFunction(k => document.querySelectorAll('#chat-log .msg.ai').length > k, { timeout: 8000 }, n);
  await settle(page);
}
try {
  browser = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true, userDataDir: profile, args: ['--autoplay-policy=no-user-gesture-required', '--mute-audio'] });
  for (const [width, height] of [[400, 800], [1440, 900]]) {
    const { page, context, errors } = await open(width, height, false);
    const home = await entries(page);
    assert.deepEqual(home.entries, ['rv-header-ravi'], `${width}: Ravi has exactly one visible entry ${JSON.stringify(home)}`);
    await page.click('#rv-header-ravi'); await settle(page);
    await page.waitForFunction(() => !document.getElementById('ravi-panel').hidden);
    // 가장 긴 상태 글을 넣어 한 줄인지 본다(400 창에서 「라비의 목소 / 리」로 꺾이던 것).
    const realState = await page.$eval('#ravi-panel-state', el => el.textContent);
    await page.$eval('#ravi-panel-state', el => { el.textContent = '말하는 중 · 라비의 목소리'; }); await settle(page);
    const empty = await measure(page);
    assert.equal(empty.pageOverflow, 0, `${width}: page has no horizontal overflow`);
    assert.ok(empty.panelOverflow <= 0, `${width}: panel has no horizontal overflow ${empty.panelOverflow}`);
    assert.ok(empty.inside, `${width}: panel stays inside the window`);
    assert.equal(empty.stateLines, 1, `${width}: header status is one line`);
    assert.deepEqual(empty.wrapped, [], `${width}: no wrapped button/header text`);
    assert.ok(empty.history >= .65, `${width}: history area ${Math.round(empty.history * 100)}% ≥ 65% on the empty conversation`);
    assert.ok(empty.chips.length >= 1 && empty.chips.length <= 3, `${width}: 1..3 starter chips ${empty.chips}`);
    assert.ok(!empty.chips.includes('주문 보기'), `${width}: seller chip hidden without a shop`);
    assert.ok(!empty.chips.some(c => /읽어 주기|도움말|보내기 요청/.test(c)), `${width}: read/help/send live in the ⋯ menu`);
    assert.equal(empty.readChipShown, false); assert.equal(empty.promoShown, false); assert.equal(empty.modeShown, false, 'mode row is not at the top');
    assert.deepEqual({ shown: empty.mic.shown, emoji: empty.mic.emoji, svg: empty.mic.svg, disabled: empty.mic.disabled }, { shown: true, emoji: false, svg: true, disabled: 'true' }, `${width}: mic visible, line icon, disabled without a key`);
    assert.ok(empty.mic.why.length > 5, `${width}: one-line reason for the disabled mic`);
    await page.$eval('#ravi-panel-state', (el, v) => { el.textContent = v; }, realState); await settle(page);
    await page.screenshot({ path: resolve(shots, `db1-${width}-panel.png`) });
    // 「더 보기」 메뉴: 읽어 주기 스위치·도움말·보내기 요청. 판매자 단추는 가게 없으면 안 보인다. 창 밖으로 안 나간다.
    await page.click('#ravi-more'); await settle(page);
    const menu = await page.evaluate(() => { const m = document.getElementById('ravi-menu').getBoundingClientRect(), p = document.getElementById('ravi-panel').getBoundingClientRect(); return { inside: m.left >= p.left - .5 && m.right <= p.right + .5, read: !!document.getElementById('ravi-read').getClientRects().length, promo: !!document.getElementById('ravi-promo-open').getClientRects().length, overflow: document.documentElement.scrollWidth - innerWidth }; });
    assert.deepEqual(menu, { inside: true, read: true, promo: false, overflow: 0 }, `${width}: menu`);
    assert.deepEqual((await measure(page)).wrapped, [], `${width}: menu rows are one line`);
    await page.screenshot({ path: resolve(shots, `db1-${width}-menu.png`) });
    await page.keyboard.press('Escape'); await settle(page);
    assert.equal(await page.$eval('#ravi-menu', el => el.hidden), true, 'Escape closes the menu first');
    assert.equal(await page.$eval('#ravi-panel', el => el.hidden), false, '…and keeps the panel open');
    // 글로 물은 질문: 읽지 않는다 · 「말하는 중」 없음 · 스피커 단추 · 칩은 숨는다 · 기록 칸 65% 이상.
    await ask(page, '내 잔액 얼마야');
    const after = await measure(page);
    const state = await page.$eval('#ravi-panel-state', el => el.textContent);
    assert.ok(!/말하는 중/.test(state), `${width}: no false speaking status after a typed answer (${state})`);
    assert.equal(await page.evaluate(() => window.__SPOKEN), 0, 'typed question is not read aloud');
    assert.equal(await page.$$eval('#chat-log .msg.ai', l => !!l.at(-1).querySelector('.ravi-say')), true, 'typed answer offers a speaker button');
    assert.deepEqual(after.chips, [], `${width}: starter chips leave once the conversation starts`);
    assert.ok(after.log >= .65, `${width}: conversation history ${Math.round(after.log * 100)}% ≥ 65%`);
    assert.equal(after.pageOverflow, 0); assert.ok(after.panelOverflow <= 0); assert.deepEqual(after.wrapped, [], `${width}: no wrapped text after an answer`);
    await page.screenshot({ path: resolve(shots, `db1-${width}-answer.png`) });
    // 스피커를 누르면 그 답만 읽는다 — 빌드에 든 작은 라비 목소리(ko-v2)가 진짜로 만든다(앱 시작 때 미리 올려 둠).
    //   소리가 나기 시작하면 말풍선에 「AI 음성」이 붙는다(못 하면 기기 목소리 → __SPOKEN). 첫 소리까지 걸린 시간을 잰다(헤드리스 맥, 참고값).
    const firstSound = await page.evaluate(() => new Promise(done => {
      const bubble = [...document.querySelectorAll('#chat-log .msg.ai')].at(-1), t0 = performance.now();
      bubble.querySelector('.ravi-say').click();
      // 소리가 난 표시(말풍선 「AI 음성」·기기 목소리) — 헤드리스에서 소리 장치가 늦으면 「AI 음성 만드는 중」 배지(#ravi-ai-voice)도 읽기 시작으로 본다.
      const making = () => !document.getElementById('ravi-ai-voice').hidden;
      const tick = () => (bubble.querySelector('.ai-voice-tag') || window.__SPOKEN || making()) ? done({ ms: Math.round(performance.now() - t0), ravi: !!bubble.querySelector('.ai-voice-tag'), making: making() }) : performance.now() - t0 > 15000 ? done(null) : setTimeout(tick, 10);
      tick();
    }));
    assert.ok(firstSound, 'speaker button reads that answer');
    console.log(`  ${width}: speaker → reading started ${firstSound.ms}ms ${JSON.stringify(firstSound)}`);
    assert.equal(await page.evaluate(() => window.__CALLS.some(c => c === 'send_rvn' || c === 'send_asset')), false);
    assert.deepEqual(errors, []);
    await context.close();
    console.log(`PASS ${width}×${height}: one entry, panel inside/no overflow, one-line header ${JSON.stringify({ history: +empty.history.toFixed(2), log: +after.log.toFixed(2), chips: empty.chips })}, ⋯ menu, line-icon mic disabled with reason, typed answers silent + speaker`);
  }
  // 키가 있으면 마이크가 켜진다(흐림·이유 없음).
  const { page, context } = await open(1440, 900, true);
  await page.click('#rv-header-ravi'); await settle(page);
  await page.waitForFunction(() => document.getElementById('rv-voice').getAttribute('aria-disabled') === 'false', { timeout: 8000 });
  assert.equal((await measure(page)).mic.why, '');
  await context.close();
  console.log('PASS keyed: mic enabled, no reason line');
} finally { await browser?.close(); rmSync(profile, { recursive: true, force: true }); }
