// 대표가 겪은 라비 대화(「380만개면 부자순위 몇위야?」 두 번 + 「돈 보내줘」)를
// 실제 화면(dist)에서 합성 환경으로 다시 만든다. 지갑·키·AI·노드·인터넷은 쓰지 않는다.
// 모든 네이티브 명령은 아래 가짜 invoke 가 받는다. 송금 명령이 불리면 바로 실패한다.
//
//   node scripts/check-ravi-chat-flow-browser.mjs            수정 후 — 단언 + 스크린샷
//   RV_CHAT_DIST=<dir> node scripts/... --before             수정 전 빌드 — 스크린샷·기록만
import assert from 'node:assert/strict';
import { readFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { resolve, extname } from 'node:path';
import { tmpdir } from 'node:os';
import puppeteer from 'puppeteer-core';

const before = process.argv.includes('--before');
const root = resolve(import.meta.dirname, '..');
const dist = resolve(process.env.RV_CHAT_DIST || resolve(root, 'dist'));
const out = resolve(root, 'artifacts/ravi-chat-flow', before ? 'before' : 'after'); mkdirSync(out, { recursive: true });
const profile = mkdtempSync(resolve(tmpdir(), 'rv-chat-flow-'));
const origin = 'http://rv-chat-flow.test';
const SYNTHETIC_KEY_LAST4 = 'TEST';
const settle = page => page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
const SPEND = /^(send_rvn|send_asset|send_many|wallet_send|sign_and_send|phone_transaction_send|broadcast|refund_send|devfee_send)$/;

// 모든 네이티브 명령의 가짜. window.__KEYED=false 로 시작하면 열쇠 없음 상태.
const installMocks = { fn: ({ SPEND_SRC, last4 }) => {
      const SPEND = new RegExp(SPEND_SRC);
      localStorage.setItem('playx-raven-lang', 'ko'); localStorage.setItem('rv-ravi-start-off', '1');
      window.__CALLS = []; window.__PAYLOADS = []; window.__SPENT = [];
      window.__CONSENT = { reviewed: false, balance: false, transactions: false, shop: false };
      window.__TAURI_INTERNALS__ = { invoke: async (command, args) => {
        window.__CALLS.push(command);
        if (SPEND.test(command)) { window.__SPENT.push(command); throw 'Forbidden synthetic spend'; }
        if (command === 'node_status') return { blocks: 1000, headers: 1000, progress: 1, peers: 3 };
        if (command === 'wallet_balance') return { confirmed: 12.5, unconfirmed: 0 };
        if (command === 'money_status') throw 'Synthetic unavailable status';
        if (command === 'api_key_status') return window.__KEYED === false ? { platform: 'macos', available: {} } : { platform: 'macos', available: { anthropic: true }, last4: { anthropic: last4 } };
        if (command === 'save_api_key') { window.__SAVED_KEY_LEN = String(args.key || '').length; window.__KEYED = true; return null; }
        if (command === 'model_settings') return {};
        if (command === 'ai_check_connection') return null;
        if (command === 'plugin:app|version') return '0.8.7';
        if (command === 'backup_auto') return { error: 'Synthetic unavailable backup' };
        if (command === 'backup_survey') return { items: [], automatic: null };
        if (['list_assets', 'pin_list', 'my_channels'].includes(command)) return [];
        if (command === 'artist_profile_get') return { name: '', about: '', picture: '', website: '' };
        if (command === 'artist_check') return { ok: false, why: 'Synthetic unavailable profile' };
        if (command === 'ravi_consent') return { ...window.__CONSENT };
        if (command === 'ravi_consent_save') { window.__CONSENT = { ...args.consent }; return null; }
        if (command === 'ravi_audit') return [];
        if (command === 'ravi_today') return { wallet: 'locked' };
        if (command === 'ai_debate') throw '두 곳 이상의 API 키가 있어야 합니다. 설정에서 하나 더 넣어 주세요.';
        if (command === 'ravi_agent_chat' && window.__AGENT_FAIL) { window.__PAYLOADS.push({ command, message: args.message, keys: Object.keys(args).sort() }); throw window.__AGENT_FAIL; }
        if (command === 'ravi_agent_chat') {
          // 보낸 것을 그대로 남긴다(개인정보 검사용). Channel 은 직렬화하지 않는다.
          window.__PAYLOADS.push({ command, provider: args.provider, message: args.message, tz: args.tz, keys: Object.keys(args).sort() });
          const general = !window.__CONSENT.reviewed;
          return { reply: general ? '합성 AI 답: 일반 지식으로만 답했어요.' : '합성 AI 답: 고른 정보까지 보고 답했어요.', prepared: [] };
        }
        if (command === 'ravi_public_address') { window.__PAYLOADS.push({ command, args: { ...args } }); return { status: 'ok', rvn: 42.5, assets_unknown: true, source: 'blockbook.ravencoin.org' }; }
        return null;
      }, transformCallback: f => f, metadata: {} };}, args: { SPEND_SRC: SPEND.source, last4: SYNTHETIC_KEY_LAST4 } };
// WCAG 대비 — 글자색을 그 뒤 배경(알파 합성)에 대어 잰다.
const contrastProbe = () => {
  const parse = c => { const sr = c.match(/color\(srgb ([^)]+)\)/); if (sr) { const p = sr[1].split(/[ /]+/).filter(Boolean).map(Number); return [p[0] * 255, p[1] * 255, p[2] * 255, p[3] ?? 1]; } const m = c.match(/rgba?\(([^)]+)\)/); if (!m) { if (c !== 'rgba(0, 0, 0, 0)' && c !== 'transparent') window.__UNPARSED = c; return [0, 0, 0, 0]; } const p = m[1].split(/[ ,/]+/).filter(Boolean).map(Number); return [p[0], p[1], p[2], p[3] ?? 1]; };
  const over = (top, bottom) => { const a = top[3]; return [0, 1, 2].map(i => top[i] * a + bottom[i] * (1 - a)).concat(1); };
  const bgOf = el => { const chain = []; for (let n = el; n; n = n.parentElement) chain.push(getComputedStyle(n).backgroundColor); let c = [255, 255, 255, 1]; const root = getComputedStyle(document.body).backgroundColor; c = over(parse(root), [255, 255, 255, 1]); for (const s of chain.reverse()) c = over(parse(s), c); return c; };
  const lum = c => { const f = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]); };
  const bad = [];
  for (const el of document.querySelectorAll('#chat-log *, #chat-mode button')) {
    if (!el.getClientRects().length) continue;
    const own = [...el.childNodes].some(n => n.nodeType === 3 && n.textContent.trim());
    if (!own) continue;
    const s = getComputedStyle(el); if (s.visibility === 'hidden' || Number(s.opacity) === 0) continue;
    const bg = bgOf(el), fg = over(parse(s.color), bg);
    const [a, b] = [lum(fg), lum(bg)].sort((x, y) => y - x); const ratio = (a + 0.05) / (b + 0.05);
    if (ratio < 4.5) bad.push({ text: el.textContent.trim().slice(0, 40), ratio: Math.round(ratio * 100) / 100, cls: el.className, color: s.color, bg: bg.map(Math.round).join(',') });
  }
  return bad;
};

let browser; const report = { mode: before ? 'before' : 'after', runs: [] };
try {
  browser = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true, userDataDir: profile });
  const sizes = before ? [[1440, 900, 'light']] : [[390, 844, 'light'], [390, 844, 'dark'], [1440, 900, 'light'], [1440, 900, 'dark']];
  for (const [width, height, scheme] of sizes) {
    const context = await browser.createBrowserContext(), page = await context.newPage(), errors = [];
    page.on('pageerror', e => errors.push(e.message)); await page.setViewport({ width, height });
    await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: scheme }, { name: 'prefers-reduced-motion', value: 'reduce' }]);
    await page.setRequestInterception(true);
    page.on('request', request => {
      const url = request.url();
      if (url.startsWith('data:')) { void request.continue(); return; }
      if (!url.startsWith(origin + '/')) { void request.abort(); return; }
      const path = new URL(url).pathname;
      if (path.startsWith('/api/')) { void request.respond({ status: 200, contentType: 'application/json', body: '{}' }); return; }
      const file = resolve(dist, '.' + (path === '/' ? '/index.html' : path));
      if (!file.startsWith(dist + '/') || !existsSync(file)) { void request.respond({ status: 404, body: '' }); return; }
      void request.respond({ status: 200, contentType: ({ '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.webp': 'image/webp', '.png': 'image/png' })[extname(file)] || 'application/octet-stream', body: readFileSync(file) });
    });
    await page.evaluateOnNewDocument(installMocks.fn, installMocks.args);
    await page.goto(origin, { waitUntil: 'networkidle0' });
    await page.waitForFunction(() => !document.documentElement.hasAttribute('data-ravi-arriving'));
    await page.addStyleTag({ content: '#onboard,#hello{display:none!important}' });
    await settle(page);
    await page.click('#ravi-open'); await settle(page);
    const ask = async q => {
      const n = await page.$$eval('#chat-log .msg', els => els.length);
      await page.$eval('#chat-q', (el, v) => { el.value = v; }, q);
      await page.click('#chat-go');
      await page.waitForFunction(k => document.querySelectorAll('#chat-log .msg').length > k && !document.querySelector('#chat-log [role=status]'), { timeout: 8000 }, n).catch(() => {});
      await new Promise(r => setTimeout(r, 150)); await settle(page);
      return page.$$eval('#chat-log .msg', (els, k) => els.slice(k).map(e => ({ who: e.className, text: e.textContent.replace(/\s+/g, ' ').trim() })), n);
    };
    const debate = await page.$('#chat-mode [data-mode="debate"]');
    const debateVisible = debate ? await debate.evaluate(el => !!el.getClientRects().length && !el.hidden) : false;
    if (debateVisible) { await debate.click(); await settle(page); }
    const turns = [];
    turns.push({ q: '380만개면 부자순위 몇위야?', a: await ask('380만개면 부자순위 몇위야?') });
    turns.push({ q: '380만개면 부자순위 몇위야?', a: await ask('380만개면 부자순위 몇위야?') });
    turns.push({ q: '돈 보내줘', a: await ask('돈 보내줘') });
    const cardShown = await page.$$eval('#chat-log .ravi-privacy', els => els.length);
    await page.screenshot({ path: resolve(out, `chat-${width}-${scheme}.png`), fullPage: false });
    await page.$eval('#chat-log', el => el.scrollTop = el.scrollHeight);
    if (before && cardShown) {
      // 대표가 「지금은 취소」를 누른 뒤의 화면 — 질문이 버려진 것을 남긴다.
      const n = await page.$$eval('#chat-log .msg', els => els.length);
      await page.$$eval('#chat-log .ravi-privacy button', bs => bs.find(b => b.textContent === '지금은 취소')?.click());
      await new Promise(r => setTimeout(r, 300)); await settle(page);
      turns.push({ q: '(지금은 취소)', a: await page.$$eval('#chat-log .msg', (els, k) => els.slice(k).map(e => ({ who: e.className, text: e.textContent.replace(/\s+/g, ' ').trim() })), n) });
      turns.push({ q: '돈 보내줘 (다시)', a: await ask('돈 보내줘') });
      await page.screenshot({ path: resolve(out, `after-cancel-${width}-${scheme}.png`) });
    }
    const run = { width, scheme, debateVisible, turns, cardShown, calls: await page.evaluate(() => window.__CALLS.filter(c => /^(ravi_|ai_)/.test(c))), payloads: await page.evaluate(() => window.__PAYLOADS), spent: await page.evaluate(() => window.__SPENT), errors };

    if (!before) {
      const all = turns.flatMap(t => t.a.map(m => m.text)).join('\n');
      assert.equal(debateVisible, false, '열쇠 하나면 「두 곳에 묻기」 단추를 보이지 않는다');
      assert.ok(!/정보 선택을 저장하지 않아/.test(all), '질문을 버리지 않는다');
      assert.ok(!/서로 다른 회사의 열쇠/.test(all), '옛 두 문장 안내가 없다');
      for (const t of turns.slice(0, 2)) {
        const ai = t.a.filter(m => /\bai\b/.test(m.who));
        assert.equal(ai.length, 1, '부자순위 질문 하나에 답 하나');
        assert.match(ai[0].text, /공개된 부자 순위표를 찾지 못해 정확한 순위는 몰라요/);
        assert.ok(!/\d[\d,.]*\s*원/.test(ai[0].text), '시세를 지어내지 않는다(원화 금액 없음)');
      }
      const send = turns[2].a.filter(m => /\bai\b/.test(m.who));
      assert.equal(send.length, 1); assert.match(send[0].text, /송금은 라비가 대신 하지 않아요/);
      assert.equal(await page.$$eval('#chat-log .msg.ai:last-child [data-guide-go="send"]', els => els.length), 1, '보내기 화면 이동 단추');
      assert.deepEqual(run.spent, [], '송금 명령이 한 번도 불리지 않았다');
      assert.ok(!run.calls.includes('ravi_agent_chat'), '부자순위·송금 요청은 AI 로 보내지 않는다(정해진 정직한 답)');
      // 일반 질문 — 동의 없이 바로 답하고, 카드는 아래에 한 번만, 저장하면 보류 질문을 다시 보낸다.
      const g1 = await ask('레이븐코인은 언제 만들어졌어?');
      assert.equal(g1.filter(m => /\bai\b/.test(m.who) && /합성 AI 답: 일반 지식/.test(m.text)).length, 1, '동의 없이도 일반 답');
      assert.equal(await page.$$eval('#chat-log .ravi-privacy', els => els.length), 0, '일반 질문에는 동의 카드를 붙이지 않는다');
      const g0 = await ask('몇살이야?');
      assert.equal(g0.filter(m => /\bai\b/.test(m.who)).length >= 1, true);
      assert.equal(await page.$$eval('#chat-log .ravi-privacy', els => els.length), 0, '「몇살이야?」에 카드 없음');
      const g2 = await ask('내 잔액 얼마야?');
      assert.equal(g2.filter(m => /합성 AI 답: 일반 지식/.test(m.text)).length, 1);
      assert.equal(await page.$$eval('#chat-log .ravi-privacy', els => els.length), 1, '내 정보 질문엔 카드 하나');
      await ask('내 거래 내역 알려줘');
      assert.equal(await page.$$eval('#chat-log .ravi-privacy', els => els.length), 1, '카드는 쌓이지 않는다');
      await page.screenshot({ path: resolve(out, `consent-offer-${width}-${scheme}.png`) });
      const nBefore = await page.evaluate(() => window.__PAYLOADS.filter(p => p.command === 'ravi_agent_chat').length);
      await page.$eval('#chat-log .ravi-privacy button', b => b.click());
      await page.waitForFunction(k => window.__PAYLOADS.filter(p => p.command === 'ravi_agent_chat').length > k, { timeout: 5000 }, nBefore);
      await new Promise(r => setTimeout(r, 200));
      const resent = await page.evaluate(() => window.__PAYLOADS.filter(p => p.command === 'ravi_agent_chat').at(-1).message);
      assert.equal(resent, '내 거래 내역 알려줘', '저장하면 보류한 마지막 질문을 다시 보낸다');
      assert.equal(await page.$$eval('#chat-log .ravi-privacy', els => els.length), 0);
      const payloads = await page.evaluate(() => window.__PAYLOADS);
      for (const p of payloads.filter(p => p.command === 'ravi_agent_chat')) {
        assert.deepEqual(p.keys, ['message', 'progress', 'provider', 'tz'], 'AI 로 가는 것은 질문·제공자·시간대뿐');
        assert.ok(!/12\.5|R[1-9A-HJ-NP-Za-km-z]{30,}/.test(p.message));
      }
      const page_ = await page.evaluate(() => document.body.innerText);
      assert.ok(!page_.includes('sk-ant') && !page_.includes(SYNTHETIC_KEY_LAST4 + 'x'), '키 노출 없음');
      // 레이아웃·대비
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      const panelOverflow = await page.$eval('#chat-log', el => el.scrollWidth - el.clientWidth);
      assert.ok(overflow <= 0 && panelOverflow <= 0, `가로 넘침 ${overflow}/${panelOverflow}`);
      const bad = await page.evaluate(contrastProbe);
      run.contrastFailures = bad;
      assert.deepEqual(bad, [], `대비 4.5:1 미만 ${JSON.stringify(bad.slice(0, 5))}`);
      assert.deepEqual(errors, []);
      await page.screenshot({ path: resolve(out, `after-consent-${width}-${scheme}.png`) });
    }
    report.runs.push(run);
    await context.close();
  }
  if (!before) for (const [width, height] of [[390, 844], [1440, 900]]) {
    // 대표 확정(10-11): 열쇠 없음 → 안내 답 → 열쇠 넣기·저장 → 보류 질문 자동 재전송 → 답. 열쇠 값은 어디에도 안 남는다.
    const SYNTH = 'sk-ant-api03-SYNTHETIC-TEST-ONLY-0000000000000000';
    const context = await browser.createBrowserContext(), page = await context.newPage(), errors = [], consoleLines = [];
    page.on('pageerror', e => errors.push(e.message)); page.on('console', m => consoleLines.push(m.text()));
    await page.setViewport({ width, height });
    await page.setRequestInterception(true);
    page.on('request', request => { const url = request.url(); if (url.startsWith('data:')) return void request.continue(); if (!url.startsWith(origin + '/')) return void request.abort(); const path = new URL(url).pathname; const file = resolve(dist, '.' + (path === '/' ? '/index.html' : path)); if (!file.startsWith(dist + '/') || !existsSync(file)) return void request.respond({ status: 404, body: '' }); void request.respond({ status: 200, contentType: ({ '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.webp': 'image/webp', '.png': 'image/png' })[extname(file)] || 'application/octet-stream', body: readFileSync(file) }); });
    await page.evaluateOnNewDocument(() => { window.__KEYED = false; });
    await page.evaluateOnNewDocument(installMocks.fn, installMocks.args);
    await page.goto(origin, { waitUntil: 'networkidle0' });
    await page.waitForFunction(() => !document.documentElement.hasAttribute('data-ravi-arriving'));
    await page.addStyleTag({ content: '#onboard,#hello{display:none!important}' });
    await page.click('#ravi-open'); await settle(page);
    const lastAi = () => page.$eval('#chat-log .msg.ai:last-child', e => e.textContent.replace(/\s+/g, ' ').trim());
    await page.$eval('#chat-q', el => { el.value = '레이븐코인은 언제 만들어졌어?'; }); await page.click('#chat-go'); await settle(page);
    assert.match(await lastAi(), /AI 열쇠를 넣으면 더 잘 답해요/, '열쇠 없음: 안내 + 한 줄');
    assert.equal(await page.evaluate(() => window.__CALLS.includes('ravi_agent_chat')), false);
    await page.$eval('#ravi-keyopen', b => b.click()); await settle(page);
    assert.ok(await page.$('#ravi-key [data-kc-where]'), '회사별 「어디서 받나요」');
    await page.type('#ravi-key-input', SYNTH);
    await page.click('#ravi-key-save');
    await page.waitForFunction(() => window.__PAYLOADS.some(p => p.command === 'ravi_agent_chat'), { timeout: 8000 });
    await new Promise(r => setTimeout(r, 400)); await settle(page);
    const resent = await page.evaluate(() => window.__PAYLOADS.filter(p => p.command === 'ravi_agent_chat').map(p => p.message));
    assert.deepEqual(resent, ['레이븐코인은 언제 만들어졌어?'], '저장하면 보류 질문을 바로 다시 보낸다');
    const log = await page.$eval('#chat-log', e => e.textContent);
    assert.match(log, /키를 저장했어요. 방금 질문을 AI로 다시 물어볼게요/); assert.match(log, /합성 AI 답: 일반 지식/, '동의 카드에 막히지 않고 답');
    assert.equal(await page.$$eval('#chat-log .ravi-privacy', els => els.length), 0, '일반 질문에는 카드 없음');
    await page.screenshot({ path: resolve(out, `key-flow-${width}.png`) });
    // 틀린 열쇠·한도·끊김 — 쉬운 문구 + 다음 행동 단추
    for (const [fail, button] of [['AI 열쇠가 맞지 않아요. 열쇠를 다시 넣어 주세요. 실행한 송금은 없어요.', 'data-guide-go="key"'], ['AI 사용 한도에 걸렸거나 AI가 바빠요. 잠시 뒤 다시 물어봐 주세요. 실행한 송금은 없어요.', 'data-ravi-ask'], ['AI에 연결하지 못했어요. 인터넷을 확인하고 잠시 뒤 다시 물어봐 주세요. 실행한 송금은 없어요.', 'data-ravi-ask']]) {
      await page.evaluate(f => { window.__AGENT_FAIL = f; }, fail);
      await page.$eval('#chat-q', el => { el.value = '채굴은 어떻게 해?'; }); await page.click('#chat-go');
      await page.waitForFunction(f => document.querySelector('#chat-log .msg.ai:last-child')?.textContent.includes(f.slice(0, 12)), { timeout: 5000 }, fail)
        .catch(async e => { console.log('DEBUG last:', await page.$$eval('#chat-log .msg', els => els.slice(-3).map(x => x.className + ': ' + x.textContent.slice(0, 120)))); throw e; });
      assert.ok(await page.$eval('#chat-log .msg.ai:last-child', (e, b) => e.innerHTML.includes(b), button), fail);
    }
    await page.screenshot({ path: resolve(out, `key-errors-${width}.png`) });
    await page.evaluate(() => { window.__AGENT_FAIL = null; });
    await page.click('#chat-log .msg.ai:last-child [data-ravi-ask]');
    await page.waitForFunction(() => [...document.querySelectorAll('#chat-log .msg.ai')].at(-1)?.textContent.includes('합성 AI 답'), { timeout: 5000 });
    // 열쇠 값은 화면·콘솔·저장 명령 밖 어떤 명령에도 없다
    const dom = await page.evaluate(() => document.documentElement.outerHTML + JSON.stringify(window.__PAYLOADS));
    assert.ok(!dom.includes(SYNTH) && !dom.includes('SYNTHETIC-TEST'), '열쇠가 화면·페이로드에 없음');
    assert.ok(!consoleLines.some(l => l.includes('SYNTHETIC')), '열쇠가 콘솔에 없음');
    assert.equal(await page.evaluate(() => window.__SAVED_KEY_LEN), SYNTH.length, '열쇠는 저장 명령으로만 갔다');
    assert.equal(await page.$eval('#ravi-key-input', e => e.value).catch(() => ''), '', '입력 칸 비움');
    assert.deepEqual(await page.evaluate(() => window.__SPENT), []);
    assert.deepEqual(errors, []);
    await context.close();
  }
} finally { await browser?.close(); rmSync(profile, { recursive: true, force: true }); }
writeFileSync(resolve(out, 'report.json'), JSON.stringify(report, null, 2) + '\n');
console.log(before ? 'RECORDED before: ' + JSON.stringify(report.runs.map(r => ({ debateVisible: r.debateVisible, cardShown: r.cardShown, turns: r.turns }))) : 'PASS ravi chat flow browser: 390/1440 light/dark, no dropped question, one answer per question, send refusal + button, no spend IPC, consent resend, contrast, no overflow; key flow (no key → guide → save → held question re-sent → answer), 401/429/offline next actions, key never in DOM/console/payloads');
