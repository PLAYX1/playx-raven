// 0.4.9 — 「12단어로 지갑 되살리기」 화면 검사 + 단어가 남지 않는지(누출) 검사.
//
// 합성 화면만: Tauri·노드·지갑·네트워크 없음. 모든 invoke 는 가짜, 바깥 요청은 막는다. 진짜 RVN 없음.
// 앱 CSP 를 Tauri 식(style-src nonce)으로 씌운다 — style 속성은 무시되므로 새 화면이 style 에 기대면 여기서 드러난다.
// 🔴 공개 시험 벡터 단어만 쓴다. 그리고 **캡처·DOM 덤프를 남기지 않는다**(09-25 사고: 가져오기 화면 캡처에 단어가
//    찍혔다). 이 스크립트는 파일을 하나도 쓰지 않는다 — 판정은 숫자·참거짓으로만 출력한다.
//
// 쓰는 법: node scripts/check-words-restore.mjs [dist]   (먼저 npx vite build)
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const root = fileURLToPath(new URL('../', import.meta.url));
const dist = resolve(process.argv[2] || resolve(root, 'dist'));
const read = (p) => readFileSync(resolve(root, p), 'utf8');
let pass = 0;
const ok = (c, label) => { assert.ok(c, label); pass++; };

// ── 1. 소스 검사(정적) ─────────────────────────────────────────────
// 주석은 빼고 본다(주석이 「localStorage 에 안 둔다」고 적고 있다).
const ts = read('src/words-restore.ts').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, ''), html = read('index.html'), main = read('src/main.ts');
const rs = read('src-tauri/src/words_restore.rs'), rsBody = rs.slice(0, rs.indexOf('#[cfg(test)]'));
ok(/id="hello-restore-words"/.test(html) && /id="w-restore-words"/.test(html) && /id="rs-words"/.test(html), '입구 셋(첫 질문 · 지갑 화면 · 이 컴퓨터 › 백업)');
ok(/\$\("hello-restore-words"\)[\s\S]{0,80}wordsRestore\.open/.test(main) && /\$\("w-restore-words"\)[\s\S]{0,80}wordsRestore\.open/.test(main) && /\$\("rs-words"\)[\s\S]{0,80}wordsRestore\.open/.test(main), '입구 셋이 시트를 연다');
ok(!/localStorage|sessionStorage|indexedDB/.test(ts), '화면이 브라우저 저장소를 안 쓴다');
ok(!/clipboard\.read/.test(ts), '클립보드를 읽지 않는다(붙여넣기 이벤트 글자만)');
ok(!/console\.(log|error|warn|info)/.test(ts), '콘솔에 안 찍는다');
ok(/protectScreen\(true\)/.test(ts) && /protectScreen\(false\)/.test(ts), '열 때 캡처 방지 켜고 닫을 때 끈다');
ok(!/type="password"/.test(ts.slice(ts.indexOf('function cellHtml'), ts.indexOf('function paintWords'))), '단어 칸은 type=password 가 아니다(암호 관리자 저장 제안 안 뜨게)');
for (const a of ['autocomplete="off"', 'autocorrect="off"', 'autocapitalize="off"', 'spellcheck="false"']) ok(ts.includes(a), `단어 칸 속성 ${a}`);
{
  const s = ts.slice(ts.indexOf('startBtn.addEventListener("click"'));
  ok(s.indexOf('wipeInputs()') > 0 && s.indexOf('wipeInputs()') < s.indexOf('"words_restore_start"'), '시작을 누르면 노드에 넘기기 **전에** 칸부터 비운다');
}
ok(!/style="/.test(ts) && !/style="/.test(html.slice(html.indexOf('<div id="wrs"'), html.indexOf('<div id="wrs"') + 800)), '새 화면에 style 속성 없음(CSP)');
ok(!/"-mnemonic/.test(rsBody) && !/arg\([^)]*mnemonic/.test(rsBody), '러스트: 명령줄에 -mnemonic 을 안 붙인다');
ok(!/\.arg\("-rescan"\)/.test(rsBody), '러스트: 시작 옵션 -rescan 금지(생일 함정)');
ok(/Stdio::null\(\)\)\s*;?/.test(rsBody) && !/stderr\(std::process::Stdio::piped/.test(rsBody), '러스트: 단어를 받은 노드의 stderr 를 읽지 않는다');
ok(read('src-tauri/src/words.rs').includes('include_str!("../../src/bip39-english.txt")') && /from "\.\/bip39-english\.txt\?raw"/.test(ts), '화면과 러스트가 같은 단어 목록 파일 하나');
ok(/words_restore::mask_line/.test(read('src-tauri/src/reindex_run.rs')) && /words_restore::log_hidden/.test(read('src-tauri/src/reindex_run.rs')), '노드 기록 보기·복사가 가림을 거친다');
ok(/words_restore::masks_node_error/.test(read('src-tauri/src/services.rs')), 'node_why 가 mnemonic 줄을 가린다');

// ── 2. 합성 화면(동적) ─────────────────────────────────────────────
assert.ok(existsSync(resolve(dist, 'index.html')), `dist 가 없다: ${dist} — 먼저 npx vite build`);
const NONCE = 'wrscheck';
const conf = JSON.parse(read('src-tauri/tauri.conf.json'));
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

// 공개 BIP39 시험 벡터(Trezor). 「sausage」 처럼 흔치 않은 단어로 DOM·저장소를 뒤진다.
const VEC = 'legal winner thank year wave sausage worth useful legal winner thank yellow';
const RARE = ['sausage', 'yellow', 'winner', 'legal'];

function mock(lang, scenario) {
  return `(() => {
    localStorage.setItem('playx-raven-lang', ${JSON.stringify(lang)});
    const S = window.__S = { calls: [], protect: [], startOk: null, startCount: 0, statusN: 0, checkArgs: null };
    const EXPECT = ${JSON.stringify(VEC)};
    window.__TAURI_INTERNALS__ = { transformCallback: (f) => f, metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main' } }, invoke: async (c, a) => {
      S.calls.push(c);
      if (/content_protected/.test(c)) { S.protect.push(!!(a && a.value)); return null; }
      switch (c) {
        case 'plugin:app|version': return '0.4.8';
        case 'mode_get': return { chosen: false };
        case 'node_status': throw 'Could not connect to the server (connection refused)';
        case 'money_status': throw 'Synthetic status unavailable';
        case 'words_restore_preflight': return ${JSON.stringify(scenario)};
        case 'words_restore_check': {
          const w = String(a.words).split(' ');
          S.checkArgs = { count: w.length, same: a.words === EXPECT };
          if (a.words !== EXPECT) return { ok: false, kind: 'checksum', message: '단어 하나가 틀렸거나 순서가 바뀌었습니다.' };
          return { ok: true, count: 12, first: 'RXjfKKWn31FQPaLmjnS6nhEGmfmKNZNVTP', same_wallet: null, history: 'unknown' };
        }
        // 부르는 동안이 화면이 찍힐 수 있는 틈이다 — 일부러 1.5초 붙잡아 그 사이 문서를 본다.
        case 'words_restore_start': S.startCount++; S.startOk = a.words === EXPECT && a.passphrase === ''; S.startConfirm = a.confirm; S.startRescan = a.rescan;
          await new Promise((r) => setTimeout(r, 1500)); return { started: true };
        case 'words_restore_status': S.statusN++;
          if (S.statusN < 2) return { busy: true, state: { stage: 'creating' } };
          return { busy: false, state: { stage: 'done', branch: 'new', aside: null, result: { balance: 0, assets: 0, certs: 0, txcount: 0, encrypted: false } } };
        case 'words_restore_close': return { closed: true };
        default: return null;
      }
    } };
  })();`;
}
const NEW = { running: false, brand_new: true, wallet_file: false, wallet: null, has_value: false, need_confirm: false, branch: 'new', blocked: null, state: null, busy: false, rescanning: false, shop: false };
const RICH = { running: true, brand_new: false, wallet_file: true, wallet: { txcount: 37, balance: 12.5, unconfirmed: 0, assets: 3, encrypted: false, bip44: true }, has_value: true, need_confirm: true, branch: 'full', blocked: null, state: null, busy: false, rescanning: false, shop: false };

const browser = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
async function page(lang, scenario) {
  const ctx = await browser.createBrowserContext();
  const p = await ctx.newPage();
  const errors = [];
  p.on('pageerror', (e) => errors.push(e.message));
  await p.setViewport({ width: 1120, height: 780 });
  await p.setRequestInterception(true);
  p.on('request', (q) => (q.url().startsWith(origin + '/') || q.url().startsWith('data:') || q.url().startsWith('blob:') ? q.continue() : q.abort()));
  await p.evaluateOnNewDocument(mock(lang, scenario));
  await p.goto(origin + '/', { waitUntil: 'networkidle0' });
  await new Promise((r) => setTimeout(r, 500));
  return { p, ctx, errors };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** 문서 전체(값 포함)·저장소에 드문 단어가 있나. 🔴 결과는 참거짓만 — 내용을 밖으로 꺼내지 않는다. */
const leaks = (p) => p.evaluate((rare) => {
  const vals = [...document.querySelectorAll('input,textarea')].map((i) => i.value).join(' ');
  const hay = document.documentElement.outerHTML + ' ' + vals + ' ' + JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage }) + location.href;
  return rare.filter((w) => new RegExp('\\b' + w + '\\b').test(hay)).length;
}, RARE);

try {
  // A — 새 컴퓨터, 첫 질문에서 끝까지(한국어).
  {
    const { p, ctx, errors } = await page('ko', NEW);
    ok(await p.$eval('#hello', (e) => getComputedStyle(e).display !== 'none'), '첫 질문이 보인다');
    ok(/전에 쓰던 지갑이 있어요/.test(await p.$eval('#hello', (e) => e.innerText)), '첫 질문에 「전에 쓰던 지갑이 있어요」');
    await p.click('#hello-restore-words');
    await p.waitForSelector('#wrs-go', { visible: true, timeout: 5000 });
    ok(await p.$eval('#wrs', (e) => { const r = e.getBoundingClientRect(); const top = document.elementFromPoint(r.left + r.width / 2, 60); return !!top && e.contains(top); }), '시트가 첫 질문 위에 뜬다(가려지지 않음)');
    ok((await p.evaluate(() => window.__S.protect))[0] === true, '열자마자 캡처 방지를 켠다');
    await p.click('#wrs-go');
    await p.waitForSelector('[data-wrs-at="1"]', { visible: true });
    const attrs = await p.$eval('[data-wrs-at="1"]', (i) => [i.type, i.autocomplete, i.getAttribute('autocorrect'), i.getAttribute('autocapitalize'), i.spellcheck]);
    ok(attrs[0] === 'text' && attrs[1] === 'off' && attrs[2] === 'off' && attrs[3] === 'off' && attrs[4] === false, '단어 칸 속성(맞춤법·자동완성·자동수정 끔, text)');
    ok((await p.$$('[data-wrs-at]')).length === 12, '12칸');
    // 제안: 「saus」 → sausage 하나.
    await p.type('[data-wrs-at="6"]', 'saus');
    ok((await p.$$eval('[data-wrs-pick]', (b) => b.map((x) => x.dataset.wrsPick))).join() === 'sausage', '앞 글자 제안(목록에서)');
    await p.$eval('[data-wrs-at="6"]', (i) => { i.value = ''; });
    // 목록에 없는 단어 → 칸 표시 + 「혹시 …?」, 오류 문장은 번호로.
    await p.type('[data-wrs-at="2"]', 'winnr');
    await p.keyboard.press('Tab');
    ok(await p.$eval('[data-wrs-at="2"]', (i) => i.classList.contains('bad')), '목록에 없는 단어 칸 표시');
    ok(/2번째 단어가 목록에 없습니다\. 혹시 winner\?/.test(await p.$eval('#wrs-hint', (e) => e.innerText)), '「혹시 winner?」 제안');
    // 한글 입력 → 한/영 안내.
    await p.$eval('[data-wrs-at="2"]', (i) => { i.value = ''; i.classList.remove('bad'); });
    await p.type('[data-wrs-at="2"]', 'ㅈㅈ');
    ok(/한\/영 키/.test(await p.$eval('#wrs-hint', (e) => e.innerText)), '한글이 들어오면 한/영 안내');
    await p.$eval('[data-wrs-at="2"]', (i) => { i.value = ''; });
    // 붙여넣기: 번호·대문자·줄바꿈이 섞인 12단어를 한 칸에 → 12칸에 나눠 들어간다.
    await p.evaluate((text) => {
      const el = document.querySelector('[data-wrs-at="1"]');
      const dt = new DataTransfer(); dt.setData('text', text);
      el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    }, VEC.split(' ').map((w, i) => `${i + 1}. ${i % 3 ? w : w.toUpperCase()}`).join('\n'));
    ok(await p.$$eval('[data-wrs-at]', (a, v) => a.map((i) => i.value).join(' ') === v, VEC), '붙여넣기를 12칸에 나눠 넣는다(번호·대문자·줄바꿈 정리)');
    ok(!(await p.$eval('#wrs-clip', (e) => e.hidden)), '붙여 넣으면 「클립보드 비우기」 안내');
    // 가리기 — CSS 로.
    await p.click('#wrs-hide');
    ok(await p.$eval('[data-wrs-at="1"]', (i) => getComputedStyle(i).webkitTextSecurity === 'disc'), '가리기(CSS text-security)');
    // 24단어 전환 뒤에도 친 것은 남는다.
    await p.click('#wrs-24');
    ok((await p.$$('[data-wrs-at]')).length === 24, '「24단어예요」 → 24칸');
    await p.click('#wrs-24');
    ok((await p.$$('[data-wrs-at]')).length === 12 && await p.$$eval('[data-wrs-at]', (a, v) => a.map((i) => i.value).join(' ') === v, VEC), '다시 12칸 · 친 것 유지');
    ok(!!(await p.$('details.wrs-extra:not([open])')), '추가 암호는 접혀 있다');
    await p.click('#wrs-check');
    await p.waitForSelector('#wrs-start', { visible: true, timeout: 5000 });
    const ca = await p.evaluate(() => window.__S.checkArgs);
    ok(ca.count === 12 && ca.same, '확인: 정리된 12단어가 러스트로 간다');
    await p.click('#wrs-start');
    // 🔴 누른 직후(노드에 건네는 중): 칸·숨긴 ② 화면·DOM 어디에도 단어가 없다.
    await sleep(300);
    ok((await leaks(p)) === 0, '시작을 누른 직후 문서·입력 칸·저장소·주소에 단어 없음');
    await p.waitForFunction(() => /되살렸습니다/.test(document.getElementById('wrs-body')?.innerText || ''), { timeout: 10000 });
    const S = await p.evaluate(() => window.__S);
    ok(S.startOk === true && S.startCount === 1, '시작: 같은 단어가 한 번만 간다');
    ok(/지갑 암호 걸기/.test(await p.$eval('#wrs-body', (e) => e.innerText)), '끝 화면이 지갑 암호를 권한다');
    ok(/돈이 사라진 것이 아닙니다|장부를 따라잡으면/.test(await p.$eval('#wrs-body', (e) => e.innerText)), '거래 0건이면 사람 말로 설명');
    await p.click('#wrs-finish');
    await sleep(200);
    const protect = await p.evaluate(() => window.__S.protect);
    ok(protect[protect.length - 1] === false, '닫으면 캡처 방지를 끈다');
    ok((await leaks(p)) === 0, '닫은 뒤 단어 없음');
    ok(await p.$eval('#wrs-body', (e) => e.childElementCount === 0), '닫으면 시트 내용을 지운다');
    const styled = await p.evaluate(() => [...document.querySelectorAll('#wrs [style]')].length);
    ok(styled === 0, 'CSP 에서 무시될 style 속성 없음');
    ok(errors.length === 0, `화면 오류 없음 (${errors.map((m) => m.slice(0, 120)).join(" | ")})`);
    await ctx.close();
  }

  // B — 돈이 있는 지갑: 기본은 「백업 먼저」, 계속하면 문장 입력 전에는 시작이 안 눌린다. 체크섬 틀림은 숫자·단어 없이.
  {
    const { p, ctx } = await page('ko', RICH);
    await p.click('#hello-restore-words');
    await p.waitForSelector('#wrs-backup', { visible: true, timeout: 5000 });
    const txt = await p.$eval('#wrs-body', (e) => e.innerText);
    ok(/12\.5 RVN/.test(txt) && /자산 3종/.test(txt) && /거래 37건/.test(txt), '경고 카드: 잔액·자산·거래');
    ok(await p.$eval('#wrs-backup', (b) => !b.classList.contains('ghost')), '기본 단추는 「백업 먼저 만들기」');
    await p.click('#wrs-go');
    await p.waitForSelector('[data-wrs-at="1"]', { visible: true });
    // 체크섬이 틀린 공개 문장(abandon ×12).
    for (let i = 1; i <= 12; i++) await p.type(`[data-wrs-at="${i}"]`, 'abandon');
    await p.click('#wrs-check');
    await p.waitForSelector('#wrs-out .warnbox', { visible: true });
    ok(/순서가 바뀌었습니다/.test(await p.$eval('#wrs-out', (e) => e.innerText)), '체크섬 틀림을 알린다');
    for (let i = 1; i <= 12; i++) await p.$eval(`[data-wrs-at="${i}"]`, (el, w) => { el.value = w; }, VEC.split(' ')[i - 1]);
    await p.click('#wrs-check');
    await p.waitForSelector('#wrs-start', { visible: true });
    ok(await p.$eval('#wrs-start', (b) => b.disabled), '문장을 치기 전에는 시작이 안 눌린다');
    ok(await p.$eval('input[name="wrs-when"][value="now"]', (r) => r.checked), '가게가 아니면 「지금 바로 찾기」가 기본');
    await p.type('#wrs-confirm', '지금 지갑을 옆에 둡니다');
    ok(await p.$eval('#wrs-start', (b) => !b.disabled), '문장을 치면 시작이 눌린다');
    await p.click('#wrs-start');
    await sleep(300);
    ok((await leaks(p)) === 0, '(돈 있는 지갑) 시작 직후 단어 없음');
    const S = await p.evaluate(() => window.__S);
    ok(S.startConfirm === '지금 지갑을 옆에 둡니다', '확인 문장이 러스트로 간다(러스트가 한 번 더 본다)');
    await ctx.close();
  }

  // C — 영어 화면: 시트에 한국어가 안 남는다(번역 빈칸 없음).
  for (const lang of ['en', 'ja', 'zh']) {
    const { p, ctx } = await page(lang, { ...RICH, shop: true });
    await p.evaluate(() => { document.getElementById('hello').style.display = 'none'; });
    await p.click('#hello-restore-words').catch(() => p.evaluate(() => document.getElementById('hello-restore-words').click()));
    await p.waitForSelector('#wrs-go', { visible: true, timeout: 5000 });
    await sleep(300);
    let txt = await p.$eval('#wrs', (e) => e.innerText);
    ok(!/[가-힣]/.test(txt), `${lang}: 안내 화면에 한국어 없음`);
    await p.click('#wrs-go');
    await p.waitForSelector('[data-wrs-at="1"]', { visible: true });
    await sleep(300);
    txt = await p.$eval('#wrs', (e) => e.innerText);
    ok(!/[가-힣]/.test(txt), `${lang}: 단어 화면에 한국어 없음`);
    await ctx.close();
  }
} finally {
  await browser.close();
  server.close();
}
console.log(`PASS words restore — ${pass} checks (캡처·덤프 없음, 공개 시험 벡터만)`);
