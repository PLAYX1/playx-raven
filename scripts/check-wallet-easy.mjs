// 0.4.8-B — 지갑 첫 배치 · 받기 · 보내기(수수료·받을 사람·결과) · 열쇠 없는 라비(안내·열쇠 넣기)를 잰다.
//
// 앱 CSP 를 Tauri 식(style-src nonce)으로 씌운 합성 화면만: Tauri·노드·지갑·네트워크 없음.
// 모든 invoke 는 가짜, 바깥 요청은 막는다. 진짜 RVN·진짜 주소·진짜 API 키 없음(열쇠는 누가 봐도 가짜).
// 🔴 열쇠 칸이 보이는 화면은 캡처하지 않는다(가짜라도 — 습관을 지킨다).
//
// 쓰는 법: node scripts/check-wallet-easy.mjs [dist]   → artifacts/claude-wallet-easy/*.png · result.json
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const root = fileURLToPath(new URL('../', import.meta.url));
const dist = resolve(process.argv[2] || resolve(root, 'dist'));
const out = resolve(root, 'artifacts/claude-wallet-easy');
mkdirSync(out, { recursive: true });
assert.ok(existsSync(resolve(dist, 'index.html')), `dist 가 없다: ${dist} — 먼저 npx vite build`);

const NONCE = 'walleteasy';
const conf = JSON.parse(readFileSync(resolve(root, 'src-tauri/tauri.conf.json'), 'utf8'));
const cspObj = { ...conf.app.security.csp };
cspObj['style-src'] = `${cspObj['style-src']} 'nonce-${NONCE}'`;
const csp = Object.entries(cspObj).map(([k, v]) => `${k} ${v}`).join('; ');
const mime = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript', '.css': 'text/css', '.webp': 'image/webp', '.png': 'image/png', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' };
const server = createServer((q, r) => {
  const p = new URL(q.url, 'http://x').pathname, f = resolve(dist, '.' + (p === '/' ? '/index.html' : p));
  if (!f.startsWith(dist + '/') || !existsSync(f)) { r.writeHead(404).end(); return; }
  const h = { 'content-type': mime[extname(f)] || 'application/octet-stream' };
  let b = readFileSync(f);
  if (f.endsWith('.html')) { h['content-security-policy'] = csp; b = Buffer.from(b.toString().replace(/<style(?=[\s>])/g, `<style nonce="${NONCE}"`)); }
  r.writeHead(200, h); r.end(b);
}).listen(0, '127.0.0.1');
await new Promise((r) => server.once('listening', r));
const origin = `http://127.0.0.1:${server.address().port}`;

// 누가 봐도 가짜인 주소(base58 글자만).
const RECV1 = 'RTestWa11etEasyReceiveAAAAAAAAAAAA';
const RECV2 = 'RTestWa11etEasyReceiveBBBBBBBBBBBB';
const FRIEND = 'RTestWa11etEasyFriendCCCCCCCCCCCCC';
const OLDPAL = 'RTestWa11etEasyPrevPa1DDDDDDDDDDDD';
const FAKE_KEY = 'sk-ant-FAKE-KEY-FOR-CHECK-ONLY-0000';

function mock(state) {
  return `(() => {
    const S = ${JSON.stringify(state)};
    window.__S = S; S.calls = []; S.args = {};
    localStorage.setItem('playx-onboarded', '1');
    localStorage.setItem('playx-raven-lang', S.lang);
    window.__TAURI_INTERNALS__ = { transformCallback: (f) => f, metadata: {}, invoke: async (c, a) => {
      S.calls.push(c); (S.args[c] = S.args[c] || []).push(a);
      switch (c) {
        case 'plugin:app|version': return '0.4.8';
        case 'mode_get': return { chosen: true, mode: 'shop' };
        case 'node_status': return { blocks: 1000, headers: 1000, progress: 1, peers: 3 };
        case 'money_status': throw 'Synthetic status unavailable';
        case 'wallet_balance': return { confirmed: S.confirmed, unconfirmed: S.unconfirmed };
        case 'wallet_lock_state': return { encrypted: false, unlocked: false };
        case 'receive_address':
          if (a && a.fresh) { S.made++; return { address: S.made > 1 ? ${JSON.stringify(RECV2)} : ${JSON.stringify(RECV1)}, reused: false, mine: true }; }
          return S.made ? { address: S.made > 1 ? ${JSON.stringify(RECV2)} : ${JSON.stringify(RECV1)}, reused: true, mine: true } : (S.made = 1, { address: ${JSON.stringify(RECV1)}, reused: false, mine: true });
        case 'qr_svg': return '<svg viewBox="0 0 10 10"><rect width="10" height="10"/></svg>';
        case 'receive_qr_save': return { path: a.path };
        case 'plugin:dialog|save': return '/synthetic/RVN-qr.svg';
        case 'recent_transactions': return S.txs;
        case 'wallet_since': return { lastblock: 'b1', transactions: [], asset_transactions: [] };
        case 'preview_send': return { valid: true, address: a.address, asset: a.asset || null, amount: Number(a.amount), enough: true, held: S.confirmed, is_mine: false, history: { known: a.address === ${JSON.stringify(OLDPAL)}, label: null } };
        case 'send_fee': if (S.feeMode === 'fail') throw 'Synthetic fee unavailable';
          if (S.feeMode === 'short') return { fee: null, short: true, amount: Number(a.amount) };
          return { fee: 0.00226, amount: Number(a.amount), total: Math.round((Number(a.amount) + 0.00226) * 1e8) / 1e8, short: false };
        case 'send_rvn': S.sent++; return 'cd'.repeat(32);
        case 'api_key_status': return S.keys;
        case 'model_settings': return {};
        case 'save_api_key': S.keys[a.provider] = true; S.savedProvider = a.provider; S.savedLen = String(a.key).length; return null;
        case 'open_external': S.opened.push(a.url); return null;
        case 'list_assets': case 'pin_list': case 'my_channels': return [];
        case 'addr_book': return { rows: [] };
        case 'owner_tokens_where': return { tokens: [] };
        case 'artist_profile_get': return { name: '', about: '', picture: '', website: '' };
        default: return null;
      }
    } };
  })();`;
}
const base = (lang) => ({ lang, confirmed: 50, unconfirmed: 10, made: 0, txs: [
  { category: 'send', address: OLDPAL, amount: -2, time: 1700000100, label: '' },
  { category: 'send', address: OLDPAL, amount: -1, time: 1700000000, label: '' },
  { category: 'receive', address: RECV1, amount: 5, time: 1700000200 },
], feeMode: 'ok', sent: 0, keys: {}, opened: [] });

const browser = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
const result = { dist, languages: {} };

/** 사람처럼 단추 한가운데를 누른다 — 덮여 있으면 실패. */
async function tap(page, sel) {
  const el = await page.waitForSelector(sel, { visible: true, timeout: 6000 });
  await el.evaluate((e) => e.scrollIntoView({ block: 'center' }));
  const hit = await el.evaluate((e) => { const b = e.getBoundingClientRect(); const x = b.left + b.width / 2, y = b.top + b.height / 2;
    const h = document.elementFromPoint(x, y); return { ok: !!h && (h === e || e.contains(h)), x, y, by: h ? (h.id || h.className || h.tagName) : '' }; });
  assert.ok(hit.ok, `${sel} 를 다른 것(${hit.by})이 덮고 있다`);
  await page.mouse.click(hit.x, hit.y);
  await new Promise((r) => setTimeout(r, 300));
}
/** 보이는 한글(번역 안 된 앱 글자). 사용자 글(translate=no)은 뺀다.
 *  번역기는 화면이 바뀐 뒤 60ms 에 몰아서 돈다(i18n.ts) — 늦게 그려지는 칸(잠금·거래)까지 기다린 뒤 잰다. */
const hangul = async (page, sel) => { await new Promise((r) => setTimeout(r, 500)); return page.$eval(sel, (box) => {
  const found = []; const w = document.createTreeWalker(box, NodeFilter.SHOW_TEXT);
  while (w.nextNode()) { const n = w.currentNode, e = n.parentElement;
    if (!e || e.closest('script,style,[translate="no"]') || !/[가-힣]/.test(n.textContent) || !e.checkVisibility()) continue; found.push(n.textContent.trim()); }
  for (const e of box.querySelectorAll('[placeholder]')) if (e.checkVisibility() && /[가-힣]/.test(e.getAttribute('placeholder'))) found.push(e.getAttribute('placeholder'));
  return found;
}); };
/** 새로 그린 자리에 style 속성이 있는가(앱 CSP 가 막는다 — 새 코드는 클래스로). */
const styleAttrs = (page, sel) => page.$$eval(`${sel} [style], ${sel}[style]`, (es) => es.map((e) => e.id || e.className || e.tagName));

try {
  for (const lang of ['ko', 'en', 'ja', 'zh']) {
    const R = (result.languages[lang] = {});
    const context = await browser.createBrowserContext();
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.setViewport({ width: 1120, height: 780 });
    await page.setRequestInterception(true);
    page.on('request', (q) => (q.url().startsWith(origin + '/') || q.url().startsWith('data:') || q.url().startsWith('blob:') ? q.continue() : q.abort()));
    await page.evaluateOnNewDocument(mock(base(lang)));
    await page.goto(origin + '/', { waitUntil: 'networkidle0' });
    await page.addStyleTag({ content: '#onboard,#hello{display:none!important}' }).catch(() => {});
    await new Promise((r) => setTimeout(r, 500));

    // ── B1 첫 화면 「한눈에」: 확정 잔액에 섞지 않고 「들어오는 중」 따로 ──
    await page.$eval('nav a[data-page="ravi"]', (e) => e.click());
    await page.waitForFunction(() => /50/.test(document.querySelector('#overview-balance').textContent));
    assert.equal(await page.$eval('#overview-balance', (e) => e.textContent), '50 RVN');
    assert.equal(await page.$eval('#overview-incoming-row', (e) => e.hidden), false);
    assert.equal(await page.$eval('#overview-incoming', (e) => e.textContent), '10 RVN');

    // ── B1 지갑 화면: 잔액 카드가 맨 위, 큰 단추 둘, 나머지 작은 줄 ──
    await page.$eval('nav a[data-page="wallet"]', (e) => e.click());
    await page.waitForFunction(() => /50/.test(document.querySelector('#w-confirmed').textContent));
    const layout = await page.evaluate(() => {
      const top = (id) => document.getElementById(id)?.getBoundingClientRect().top ?? -1;
      return { balance: top('w-confirmed'), receive: top('w-receive'), send: top('w-send-rvn'), more: top('w-send-asset'), lock: top('w-lock'),
        tiles: !!document.getElementById('pt-wallet'), incoming: document.getElementById('w-unconfirmed').textContent,
        note: !document.getElementById('w-incoming-note').hidden };
    });
    assert.ok(layout.balance < layout.receive && layout.receive === layout.send && layout.send < layout.more && layout.more < layout.lock, `배치 순서 ${JSON.stringify(layout)}`);
    assert.equal(layout.tiles, false, '큰 타일 줄은 없어야 한다(같은 단추가 둘)');
    assert.ok(layout.note, '「들어오는 중」 설명 줄');
    R.walletHangul = lang === 'ko' ? [] : await hangul(page, '#page-wallet');
    if (lang === 'ko') await page.screenshot({ path: resolve(out, 'wallet-first-ko.png') });

    // ── B2 받기: 누르면 바로 주소 · QR · 복사 두 가지 · 다시 누르면 같은 주소 ──
    await tap(page, '#w-receive');
    await page.waitForSelector('#w-addr-text');
    assert.equal(await page.$eval('#w-addr-text', (e) => e.textContent), RECV1);
    assert.ok(await page.$('#w-qr svg rect'), 'QR');
    for (const id of ['w-copy', 'w-copymsg', 'w-qrsave', 'w-newaddr']) assert.ok(await page.$('#' + id), id);
    R.receiveHangul = lang === 'ko' ? [] : await hangul(page, '#w-addr');
    assert.deepEqual(await styleAttrs(page, '#w-addr'), [], '받기 칸에 style 속성');
    if (lang === 'ko') await page.screenshot({ path: resolve(out, 'receive-ko.png') });
    await tap(page, '#w-receive');
    await page.waitForSelector('#w-addr-text');
    assert.equal(await page.$eval('#w-addr-text', (e) => e.textContent), RECV1, '다시 눌러도 같은 주소');
    await tap(page, '#w-qrsave');
    await page.waitForFunction(() => /synthetic/.test(document.getElementById('w-recv-note').textContent));
    const S1 = await page.evaluate(() => window.__S);
    assert.deepEqual(S1.args.receive_qr_save[0], { address: RECV1, path: '/synthetic/RVN-qr.svg' }, 'QR 저장은 주소와 저장 창의 자리만 넘긴다');
    await tap(page, '#w-newaddr');
    await page.waitForFunction((a) => document.getElementById('w-addr-text')?.textContent === a, {}, RECV2);
    assert.ok(S1.calls.filter((c) => c === 'new_address').length === 0, '옛 new_address 를 부르지 않는다');

    // ── B3 보내기: 받을 사람 고르기 → 검토(수수료·합계) → 보내기 전에는 send_rvn 없음 ──
    await tap(page, '#w-send-rvn');
    assert.equal(await page.$eval('#w-addr', (e) => e.innerHTML), '', '보내기를 열면 받기 칸은 닫힌다');
    await page.waitForSelector(`#s-pick [data-payee="${OLDPAL}"]`);
    assert.equal(await page.$$eval('#s-pick [data-payee]', (es) => es.length), 1, '최근 보낸 곳은 주소마다 한 번');
    R.pickHangul = lang === 'ko' ? [] : await hangul(page, '#send-compose');
    await tap(page, `#s-pick [data-payee="${OLDPAL}"]`);
    assert.equal(await page.$eval('#s-addr', (e) => e.value), OLDPAL);
    await page.type('#s-qty', '1');
    await tap(page, '#s-review');
    await page.waitForFunction(() => /0\.00226/.test(document.getElementById('r-fee').textContent));
    assert.equal(await page.$eval('#r-total', (e) => e.textContent), '1.00226 RVN');
    let S2 = await page.evaluate(() => window.__S);
    assert.ok(S2.calls.includes('send_fee') && !S2.calls.includes('send_rvn'), '검토는 수수료만 묻고 보내지 않는다');
    assert.deepEqual(S2.args.send_fee.at(-1), { address: OLDPAL, amount: 1 });
    R.reviewHangul = lang === 'ko' ? [] : await hangul(page, '#send-review');
    assert.deepEqual(await styleAttrs(page, '#s-pick'), []);
    if (lang === 'ko') await page.screenshot({ path: resolve(out, 'review-fee-ko.png') });

    // 수수료를 못 구하면 지어내지 않는다 / 모자라면 말한다.
    for (const [mode, re] of [['fail', { ko: /노드가 정해요/, en: /node sets the fee/, ja: /ノードが決め/, zh: /由节点决定/ }], ['short', { ko: /모자라요/, en: /not enough/, ja: /足りません/, zh: /余额不足/ }]]) {
      await page.evaluate((m) => { window.__S.feeMode = m; }, mode);
      await tap(page, '#s-back');
      await tap(page, '#s-review');
      await page.waitForFunction(() => !/…/.test(document.getElementById('r-fee').textContent));
      const txt = await page.$eval('#send-review', (e) => e.innerText);
      assert.match(txt, re[lang], `수수료 ${mode}`);
      assert.doesNotMatch(await page.$eval('#r-fee', (e) => e.textContent), /0\.00226/, '못 구한 수수료를 숫자로 적지 않는다');
      assert.equal((await page.evaluate(() => window.__S)).sent, 0);
    }
    await page.evaluate(() => { window.__S.feeMode = 'ok'; });
    await tap(page, '#s-back');
    await tap(page, '#s-review');
    await page.waitForFunction(() => /0\.00226/.test(document.getElementById('r-fee').textContent));
    await tap(page, '#s-go');
    await page.waitForSelector('.wdone');
    S2 = await page.evaluate(() => window.__S);
    assert.equal(S2.sent, 1);
    const done = await page.$eval('.wdone', (e) => ({ text: e.innerText, open: e.querySelector('details').open, txid: e.querySelector('details').textContent.includes('cd'.repeat(32)) }));
    assert.equal(done.open, false, '거래 번호는 「자세히」 안에(접힌 채로)');
    assert.ok(done.txid);
    assert.ok(!done.text.includes('cd'.repeat(32)), '거래 번호가 겉에 보이지 않는다');
    R.resultHangul = lang === 'ko' ? [] : await hangul(page, '#s-result');
    await page.type('#s-savename', '민수');
    await tap(page, '#s-saveok');
    const payees = await page.evaluate(() => JSON.parse(localStorage.getItem('playx-raven-payees') || '[]'));
    assert.deepEqual(payees.map((p) => [p.address, p.name]), [[OLDPAL, '민수']]);
    if (lang === 'ko') await page.screenshot({ path: resolve(out, 'sent-ko.png') });
    // 다음 보내기에서 저장한 사람이 먼저, 이름으로.
    await tap(page, '#w-send-rvn');
    await page.waitForSelector(`#s-pick [data-payee="${OLDPAL}"] b`);
    assert.equal(await page.$eval(`#s-pick [data-payee="${OLDPAL}"] b`, (e) => e.textContent), '민수');
    await tap(page, '#s-cancel');

    // ── B4 라비: 기본 「그냥 묻기」 · 열쇠 없으면 라비 안내(AI 아님) · 열쇠 넣기 ──
    await page.$eval('nav a[data-page="ravi"]', (e) => e.click());
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(await page.$eval('#chat-mode .on', (e) => e.dataset.mode), 'ask', '기본은 그냥 묻기');
    const q = { ko: '보낼 때 수수료가 얼마예요?', en: 'How much is the fee?', ja: '手数料はいくら?', zh: '手续费多少?' }[lang];
    await page.type('#chat-q', q);
    await tap(page, '#chat-go');
    const said = await page.$eval('#chat-log .msg.ai:last-child', (e) => ({ id: e.querySelector('[data-guide]')?.dataset.guide, text: e.innerText }));
    assert.equal(said.id, 'fee', '수수료 질문 → 수수료 안내');
    assert.match(said.text, { ko: /AI 아님/, en: /not AI/, ja: /AIではありません/, zh: /非 AI/ }[lang], '「AI 아님」 표지');
    assert.equal((await page.evaluate(() => window.__S)).calls.filter((c) => /^ai_(chat|ask_owner|debate|fill)$/.test(c)).length, 0, '열쇠 없이 AI 에게 묻지 않는다');
    await page.type('#chat-q', 'zzqx');
    await tap(page, '#chat-go');
    assert.equal(await page.$eval('#chat-log .msg.ai:last-child [data-guide]', (e) => e.dataset.guide), 'miss', '모르는 질문은 모른다고');
    R.guideHangul = lang === 'ko' ? [] : await hangul(page, '#chat-log');
    if (lang === 'ko') await page.screenshot({ path: resolve(out, 'ravi-guide-ko.png') });
    // 답 아래 단추가 제자리로 데려간다.
    await tap(page, '#chat-log .msg.ai:last-child [data-guide-topic="receive"]');
    await tap(page, '#chat-log .msg.ai:last-child [data-guide-go="receive"]');
    await page.waitForSelector('#w-addr-text');
    assert.equal(await page.$eval('.page.on', (e) => e.id), 'page-wallet');

    // 열쇠 넣기 — 한 칸, 붙여 넣으면 회사를 알아보고, 저장은 기존 명령. 저장 뒤 칸은 비고 카드는 닫힌다.
    await page.$eval('nav a[data-page="ravi"]', (e) => e.click());
    await tap(page, '#ravi-keyopen');
    assert.equal(await page.$$eval('#ravi-key input', (es) => es.length), 1, '붙여 넣는 칸은 하나');
    assert.equal(await page.$$eval('#ravi-key [data-kc-where]', (es) => es.length), 5, '회사마다 「어디서 받나요」');
    R.keyHangul = lang === 'ko' ? [] : await hangul(page, '#ravi-key');
    assert.deepEqual(await styleAttrs(page, '#ravi-key'), []);
    await tap(page, '#ravi-key [data-kc-where*="groq"]');
    await tap(page, '#ravi-key [data-kc-pick="openai"]');
    await page.type('#kc-key', FAKE_KEY);
    assert.equal(await page.$eval('#ravi-key [aria-pressed="true"]', (e) => e.dataset.kcPick), 'anthropic', '붙여 넣은 열쇠의 앞머리로 회사를 알아본다');
    await tap(page, '#kc-save');
    const S3 = await page.evaluate(() => window.__S);
    assert.equal(S3.savedProvider, 'anthropic');
    assert.equal(S3.savedLen, FAKE_KEY.length);
    assert.ok(S3.opened.includes('https://console.groq.com/keys'), '「어디서 받나요」는 그 회사의 공식 콘솔');
    assert.equal(await page.$eval('#ravi-key', (e) => e.hidden), true, '저장 뒤 카드는 닫힌다');
    assert.ok(!(await page.content()).includes(FAKE_KEY), '저장한 열쇠가 화면 어디에도 남지 않는다');
    assert.equal(await page.$eval('#ravi-keyopen', (e) => e.hidden), true, '열쇠가 생기면 「AI 열쇠 넣기」는 숨는다');

    R.errors = errors;
    assert.deepEqual(errors, [], '화면 오류');
    for (const k of Object.keys(R).filter((k) => k.endsWith('Hangul'))) assert.deepEqual(R[k], [], `${lang} ${k} 에 번역 안 된 한국어`);
    console.log(`${lang} ok`);
    await context.close();
  }
} finally {
  await browser.close();
  server.close();
}
writeFileSync(resolve(out, 'result.json'), JSON.stringify(result, null, 1));
console.log('PASS 0.4.8-B 지갑 첫 배치 · 받기 · 보내기 수수료 · 받을 사람 · 라비 안내 · 열쇠 넣기 (4개 언어)');
process.exit(0);
