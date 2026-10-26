// 라비 목소리(Supertonic 3) 화면 시험 — 맥 headless Chrome. 가짜 invoke 만, 외부 네트워크·지갑 없음.
//   A. 모델 정상: 「AI 음성」 표시가 말하는 동안·말풍선 옆에 보이고, 소리가 실제로 만들어져 재생된다(실제 모델 사용)
//   B. 리소스 없음: 기기 목소리(speechSynthesis)로 자동 폴백, 「AI 음성」 표시는 꺼진다
//   C. 설정 「기기 목소리」: 라비 목소리 명령을 아예 부르지 않는다
//   E. 모델이 설치 파일에 없다 → 「받기」(가짜 진행) → 완료되면 자동으로 라비 목소리 → 「지우기」 → 기기 목소리
//   F. 받기 실패(가짜 끊김) → 쉬운 안내 + 기기 목소리 폴백
// 모델 파일 위치: 앱에서는 앱 자료 폴더 ravi-voice/. 이 시험은 RV_MODEL_DIR(없으면 src-tauri/resources/ravi-voice)의 파일을 "받은 것처럼" 조각으로 준다.
// 앱의 CSP(tauri.conf.json)를 그대로 씌워서 wasm·워커가 막히지 않는지도 같이 본다.
import assert from 'node:assert/strict';
import { readFileSync, existsSync, mkdtempSync, statSync, openSync, readSync, closeSync } from 'node:fs';
import { resolve, extname } from 'node:path';
import { tmpdir } from 'node:os';
import puppeteer from 'puppeteer-core';
import http from 'node:http';
const root = resolve(import.meta.dirname, '..'), dist = resolve(root, 'dist');
const modelDir = process.env.RV_MODEL_DIR ? resolve(process.env.RV_MODEL_DIR) : resolve(root, 'src-tauri/resources/ravi-voice');
const profile = mkdtempSync(resolve(tmpdir(), 'rv-tts-'));
const FILES = { dp: 'onnx/duration_predictor.onnx', enc: 'onnx/text_encoder.onnx', vec: 'onnx/vector_estimator.onnx', voc: 'onnx/vocoder.onnx', cfg: 'onnx/tts.json', indexer: 'onnx/unicode_indexer.json', style: 'voice_styles/F1.json', license: 'LICENSE' };
const hasModel = Object.values(FILES).every(f => existsSync(resolve(modelDir, f)));
if (!hasModel) { console.log('SKIP: 모델 파일이 없어 시험을 건너뜁니다(scripts/fetch-ravi-voice.mjs 로 채운 뒤 다시).'); process.exit(0); }
const conf = JSON.parse(readFileSync(resolve(root, 'src-tauri/tauri.conf.json'), 'utf8')).app.security.csp;
const types = { '.html': 'text/html', '.js': 'application/javascript', '.mjs': 'application/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.webp': 'image/webp', '.png': 'image/png', '.wasm': 'application/wasm' };
// 앱 화면(dist)과 모델 조각을 같은 로컬 서버에서 준다(요청 가로채기로 380MB 를 넘기면 너무 느리다). 실제 앱은 Rust 명령이 조각을 준다.
let origin = '';
let csp = '';
const server = http.createServer((q, r) => {
  const u = new URL(q.url, 'http://x'), path = u.pathname;
  if (path.startsWith('/__tts/')) {
    const rel = FILES[path.slice(7)]; if (!rel) { r.statusCode = 404; return r.end(); }
    const o = Number(u.searchParams.get('o')), l = Number(u.searchParams.get('l')), fd = openSync(resolve(modelDir, rel), 'r'), buf = Buffer.alloc(l); readSync(fd, buf, 0, l, o); closeSync(fd);
    r.setHeader('content-type', 'application/octet-stream'); return r.end(buf);
  }
  if (path.startsWith('/api/')) { r.setHeader('content-type', 'application/json'); return r.end('{}'); }
  const file = resolve(dist, '.' + (path === '/' ? '/index.html' : path));
  if (!file.startsWith(dist + '/') || !existsSync(file) || statSync(file).isDirectory()) { r.statusCode = 404; return r.end(); }
  if (path === '/' || path.endsWith('.html')) r.setHeader('content-security-policy', csp);
  r.setHeader('content-type', types[extname(file)] || 'application/octet-stream'); r.end(readFileSync(file));
});
await new Promise(ok => server.listen(0, 'localhost', ok));
origin = `http://localhost:${server.address().port}`;
csp = Object.entries(conf).map(([k, v]) => `${k} ${v}`).join('; ').replace('ws://localhost:1420', '').replace(/(connect-src[^;]*)/, `$1 ${origin}`);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const settle = page => page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));

const mocks = ({ tts }) => {
  localStorage.setItem('playx-raven-lang', 'ko'); localStorage.setItem('rv-ravi-start-off', '1');
  window.__CALLS = []; window.__PLAYED = []; window.__DEVICE = []; window.__AIFLAGS = [];
  if (tts.pref) localStorage.setItem('rv-ravi-voice', tts.pref);
  const sizes = [['dp', 3700147], ['enc', 36416150], ['vec', 256534781], ['voc', 101424195], ['cfg', 8253], ['indexer', 277676], ['style', 292046], ['license', 15007]];
  // 기기 목소리 가짜(한국어 목소리 하나)
  const fake = { getVoices: () => [{ lang: 'ko-KR', name: 'Yuna' }], speak(u) { window.__DEVICE.push(u.text); setTimeout(() => u.onend && u.onend(), 30); }, cancel() {} };
  Object.defineProperty(window, 'speechSynthesis', { value: fake, configurable: true });
  Object.defineProperty(window, 'SpeechSynthesisUtterance', { value: class { constructor(t) { this.text = t; } }, configurable: true });
  const W = window.Worker; window.Worker = function (...a) { const w = new W(...a); w.addEventListener('message', e => { window.__WLOG = (window.__WLOG || []).concat([String(e.data && e.data.type) + (e.data && e.data.message ? ':' + e.data.message : '')]); }); w.addEventListener('error', e => { window.__WLOG = (window.__WLOG || []).concat(['worker-error:' + e.message]); }); return w; };
  window.__WAVS = []; const cou = URL.createObjectURL.bind(URL);
  URL.createObjectURL = b => { if (b && b.type === 'audio/wav') b.slice(0, 44).arrayBuffer().then(h => { const v = new DataView(h); window.__WAVS.push({ rate: v.getUint32(24, true), seconds: (b.size - 44) / 2 / v.getUint32(24, true), peak: 0 }); }); return cou(b); };
  const play = HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play = function () {
    window.__PLAYED.push({ src: String(this.src).slice(0, 5) });
    this.addEventListener('loadedmetadata', () => { window.__PLAYED.at(-1).duration = this.duration; });
    return play.call(this);
  };
  const flag = () => window.__AIFLAGS.push(!document.getElementById('ravi-ai-voice').hidden);
  setInterval(() => { try { flag(); } catch { /* 아직 없음 */ } }, 100);
  // 가짜 「라비 목소리 받기」: 상태를 물을 때마다 4분의 1씩 진행 → 끝나면 설치됨(또는 실패). 진짜 받기는 Rust(ravi_voice_pack.rs, cargo test 로 시험).
  let installed = !tts.missing && !tts.download, dl = null, last = null;
  window.__TAURI_INTERNALS__ = { invoke: async (c, a) => {
    window.__CALLS.push(c);
    if (c === 'ravi_tts_status') return installed ? { ok: true, sizes } : { ok: false, missing: ['vec'] };
    if (c === 'ravi_voice_pack_status') {
      if (dl) { dl.done += dl.total / 4; if (dl.done >= dl.total) { if (tts.fail) last = { ok: false, reason: 'network' }; else { installed = true; last = { ok: true }; } dl = null; } }
      return { installed, removable: installed, downloading: !!dl, done: dl ? dl.done : 0, total: dl ? dl.total : 401301114, last };
    }
    if (c === 'ravi_voice_download') { if (installed) return { ok: true, already: true }; last = null; dl = { done: 0, total: 401301114 }; return { ok: true, started: true }; }
    if (c === 'ravi_voice_cancel') { dl = null; last = { ok: false, reason: 'cancelled' }; return { ok: true }; }
    if (c === 'ravi_voice_remove') { installed = false; last = null; return { ok: true }; }
    if (c === 'ravi_tts_read') { const r = await fetch(`/__tts/${a.key}?o=${a.offset}&l=${a.len}`); return await r.arrayBuffer(); }
    if (c === 'node_status') return { blocks: 1000, headers: 1000, progress: 1, peers: 3 };
    if (c === 'wallet_balance') return { confirmed: 12.5, unconfirmed: 0 };
    if (c === 'api_key_status') return { platform: 'macos', available: { anthropic: true }, last4: { anthropic: 'TEST' } };
    if (c === 'plugin:app|version') return '0.9.5';
    if (c === 'ravi_consent') return { reviewed: true, balance: false, transactions: false, shop: false };
    if (c === 'ravi_audit' || ['list_assets', 'pin_list', 'my_channels'].includes(c)) return [];
    if (c === 'ravi_today') return { wallet: 'locked' };
    if (c === 'ravi_agent_chat') return { reply: '안녕하세요, 저는 라비예요. 오늘 레이븐볼트에서 무엇을 도와 드릴까요?', prepared: [] };
    return null;
  }, transformCallback: f => f, metadata: {} };
};

let browser; const report = [];
try {
  browser = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true, userDataDir: profile, args: ['--autoplay-policy=no-user-gesture-required', '--mute-audio', '--disable-features=PrivateNetworkAccessRespectPreflightResults,PrivateNetworkAccessSendPreflights,BlockInsecurePrivateNetworkRequests'] });
  async function scenario(name, tts, body) {
    if (process.env.RV_ONLY && !name.startsWith(process.env.RV_ONLY)) return;
    const context = await browser.createBrowserContext(), page = await context.newPage(), errors = [];
    page.on('pageerror', e => { if (/ravi-tts|onnx|wasm|ort\.wasm/i.test(e.message + (e.stack || ''))) errors.push(e.message + ' | ' + String(e.stack).slice(0, 400)); else console.log('(참고: 이 시험 밖 페이지 오류)', e.message.slice(0, 80)); }); page.on('console', m => { if (process.env.RV_DEBUG && m.type() === 'error') console.log('console:', m.text().slice(0, 300)); if (/Content Security Policy|Refused/.test(m.text())) errors.push('CSP: ' + m.text().slice(0, 200)); });
    await page.setViewport({ width: 1440, height: 900 }); await page.bringToFront(); await (await page.createCDPSession()).send('Emulation.setFocusEmulationEnabled', { enabled: true }); await page.setRequestInterception(true);
    page.on('request', request => {
      const url = request.url();
      if (url.startsWith('data:') || url.startsWith('blob:') || url.startsWith(origin + '/')) return void request.continue();
      void request.abort(); // 밖으로 나가는 요청은 모두 막는다
    });
    await page.evaluateOnNewDocument(mocks, { tts });
    await page.goto(origin, { waitUntil: 'networkidle0' });
    await page.waitForFunction(() => !document.documentElement.hasAttribute('data-ravi-arriving'));
    await page.addStyleTag({ content: '#onboard,#hello,.ravi-lifecycle{display:none!important}' });
    await settle(page); await page.click('#ravi-open'); await settle(page);
    try { await body(page); } catch (e) { console.log('FAIL', name, 'errors=', errors.slice(0, 5), 'log=', await page.$eval('#chat-log', x => x.textContent.slice(0, 300)).catch(() => '?'), 'lic=', await page.evaluate(() => document.getElementById('about-supertonic-license-text')?.textContent.slice(0, 60) + '|' + document.getElementById('about-supertonic-license')?.open + '|' + window.__CALLS.filter(c => c === 'ravi_tts_read').length), 'dbg=', await page.evaluate(() => JSON.stringify(window.__ttsdbg)), 'state=', await page.evaluate(() => JSON.stringify({ hidden: document.hidden, focus: document.hasFocus(), panel: [document.getElementById('ravi-panel').hidden, getComputedStyle(document.getElementById('ravi-panel')).display, document.getElementById('ravi-panel').getClientRects().length], approval: Array.from(document.querySelectorAll('.ravi-lifecycle[open], .sheet:not(.hidden), #askwrap.on, #rpwrap, #onboard:not(.hidden), #hello, #send-review, #qrwrap, #phone-tx-send:not([hidden])')).filter(e => e.getClientRects().length).map(e => e.id || e.className) })), 'worker=', await page.evaluate(() => JSON.stringify(window.__WLOG)), 'tts-calls=', await page.evaluate(() => window.__CALLS.filter(c => c.startsWith('ravi_tts')).length).catch(() => '?')); throw e; }
    const r = { name, errors }; report.push(r);
    assert.deepEqual(errors, [], name + ' 오류 없음'); await context.close();
  }
  const ask = async page => {
    await page.$eval('#chat-q', el => { el.value = '레이븐코인은 언제 만들어졌어?'; });
    await page.click('#chat-go');
    await page.waitForFunction(() => [...document.querySelectorAll('#chat-log .msg.ai .msgtxt')].some(e => e.textContent.includes('무엇을 도와 드릴까요')), { timeout: 8000 });
  };
  // A. 정상
  await scenario('A 라비 목소리', { }, async page => {
    await page.click('#ravi-read'); await sleep(300);
    const t0 = Date.now(); await ask(page);
    await page.waitForFunction(() => !document.getElementById('ravi-ai-voice').hidden, { timeout: 5000 });
    const shownWhileMaking = true;
    await page.screenshot({ path: resolve(process.env.RV_SHOT_DIR || tmpdir(), 'ravi-tts-ai-badge.png') }).catch(() => {});
    await page.waitForFunction(() => window.__PLAYED.length >= 1, { timeout: Number(process.env.RV_WAIT || 150000) });
    const made = Date.now() - t0;
    const played = await page.evaluate(() => window.__PLAYED[0]); assert.equal(played.src, 'blob:');
    await page.waitForFunction(() => window.__WAVS.length >= 1, { timeout: 5000 });
    const { rate, seconds: dur } = await page.evaluate(() => window.__WAVS[0]);
    assert.ok(Math.abs(rate - 50949) <= 2, `재생 샘플레이트 44100 x 1.1553 = 50949: ${rate}`);
    assert.ok(Math.abs(dur - 6.03) < 0.5, `기준 6.0초와 ±5% 안: ${dur}`);
    assert.equal(await page.evaluate(() => window.__DEVICE.length), 0, '기기 목소리는 안 썼다');
    await page.waitForFunction(() => document.querySelectorAll('#chat-log .msg.ai .ai-voice-tag').length === 1, { timeout: 5000 });
    assert.equal(await page.$eval('#chat-log .ai-voice-tag', e => e.textContent), 'AI 음성');
    assert.ok(await page.evaluate(() => window.__AIFLAGS.some(Boolean)), '말하는 동안 배지가 보였다');
    await page.waitForFunction(() => document.getElementById('ravi-ai-voice').hidden, { timeout: 15000 });
    console.log(`A: 첫 문장 읽기+만들기+재생 시작까지 ${made}ms, 재생 길이 ${dur.toFixed(2)}초, 선언 샘플레이트 ${rate}`);
    // 같은 문장 다시: 캐시(합성 명령 없이 바로)
    const t1 = Date.now(); const n0 = await page.evaluate(() => window.__PLAYED.length); await ask(page).catch(() => {});
    await page.$eval('#chat-q', el => { el.value = '레이븐코인은 언제 만들어졌어?'; }); await page.click('#chat-go');
    await page.waitForFunction(k => window.__PLAYED.length > k, { timeout: 15000 }, n0); console.log(`A: 같은 문장 캐시 재생 ${Date.now() - t1}ms`);
  });
  // B. 리소스 없음 → 기기 목소리
  await scenario('B 리소스 없음', { missing: true }, async page => {
    await page.click('#ravi-read'); await sleep(300); await ask(page);
    await page.waitForFunction(() => window.__DEVICE.length >= 1, { timeout: 8000 });
    assert.match(await page.evaluate(() => window.__DEVICE[0]), /라비예요/);
    assert.equal(await page.evaluate(() => window.__PLAYED.length), 0);
    await page.waitForFunction(() => document.getElementById('ravi-ai-voice').hidden);
    assert.equal(await page.$$eval('#chat-log .msg.ai .ai-voice-tag', e => e.length), 0, '기기 목소리 답에는 AI 음성 표시를 붙이지 않는다');
    console.log('B: 폴백 → 기기 목소리 문장 =', await page.evaluate(() => window.__DEVICE[0].slice(0, 20)));
  });
  // C. 설정 기기 목소리
  await scenario('C 기기 목소리 선택', { pref: 'device' }, async page => {
    assert.equal(await page.$eval('#ravi-voice-kind', e => e.value), 'device');
    await page.click('#ravi-read'); await sleep(300); await ask(page);
    await page.waitForFunction(() => window.__DEVICE.length >= 1, { timeout: 8000 });
    assert.ok(!(await page.evaluate(() => window.__CALLS)).some(c => c.startsWith('ravi_tts_read')), '모델을 읽지 않았다');
  });
  const cardNote = page => page.$eval('#ravi-pack-note', e => e.textContent);
  // E. 설치 파일에 모델 없음 → 받기 → 라비 목소리 → 지우기 → 기기 목소리
  await scenario('E 받기 후 라비 목소리', { download: true }, async page => {
    await page.waitForFunction(() => !document.getElementById('ravi-pack-nudge').hidden, { timeout: 5000 });
    assert.match(await page.$eval('#ravi-pack-nudge-text', e => e.textContent), /380MB/);
    assert.ok(await page.$eval('#ravi-pack-nudge-later', e => !e.hidden), '「나중에」 단추');
    await page.click('#ravi-pack-nudge-get');
    await page.waitForFunction(() => /받는 중/.test(document.getElementById('ravi-pack-note').textContent), { timeout: 5000 });
    assert.equal(await page.$eval('#ravi-pack-bar', e => e.hidden), false, '진행 막대');
    assert.equal(await page.$eval('#ravi-pack-cancel', e => e.hidden), false, '취소 단추');
    await page.waitForFunction(() => /받았어요/.test(document.getElementById('ravi-pack-note').textContent), { timeout: 15000 });
    assert.equal(await page.$eval('#ravi-pack-nudge', e => e.hidden), true, '다 받으면 안내가 사라진다');
    assert.equal(await page.$eval('#ravi-voice-kind', e => e.value), 'ravi');
    await page.click('#ravi-read'); await sleep(300); await ask(page);
    await page.waitForFunction(() => !document.getElementById('ravi-ai-voice').hidden, { timeout: 5000 });
    await page.waitForFunction(() => window.__PLAYED.length >= 1, { timeout: Number(process.env.RV_WAIT || 150000) });
    assert.equal(await page.evaluate(() => window.__DEVICE.length), 0, '받은 뒤에는 기기 목소리를 안 썼다');
    await page.waitForFunction(() => document.getElementById('ravi-ai-voice').hidden, { timeout: 15000 });
    // 지우기: 한 번은 확인, 두 번째에 지움 → 기기 목소리
    await page.evaluate(() => document.getElementById('ravi-pack-remove').click());
    assert.match(await page.$eval('#ravi-pack-remove', e => e.textContent), /정말 지울까요/);
    await page.evaluate(() => document.getElementById('ravi-pack-remove').click());
    await page.waitForFunction(() => /지웠어요/.test(document.getElementById('ravi-pack-note').textContent), { timeout: 5000 });
    await page.$eval('#chat-q', el => { el.value = '레이븐코인은 언제 만들어졌어?'; }); await page.click('#chat-go');
    await page.waitForFunction(() => window.__DEVICE.length >= 1, { timeout: 15000 });
    assert.equal(await page.$eval('#ravi-ai-voice', e => e.hidden), true, '지운 뒤에는 AI 음성 표시 없음');
    console.log('E: 받기 → 라비 목소리 재생 → 지우기 → 기기 목소리 통과');
  });
  // F. 받기 실패 → 안내 + 기기 목소리
  await scenario('F 받기 실패', { download: true, fail: true }, async page => {
    await page.waitForFunction(() => !document.getElementById('ravi-pack-nudge').hidden, { timeout: 5000 });
    await page.click('#ravi-pack-nudge-get');
    await page.waitForFunction(() => /인터넷이 끊겼/.test(document.getElementById('ravi-pack-note').textContent), { timeout: 15000 });
    assert.match(await cardNote(page), /기기 목소리/);
    assert.equal(await page.$eval('#ravi-pack-get', e => e.textContent), '다시 받기');
    await page.click('#ravi-read'); await sleep(300); await ask(page);
    await page.waitForFunction(() => window.__DEVICE.length >= 1, { timeout: 8000 });
    assert.equal(await page.evaluate(() => window.__PLAYED.length), 0);
    assert.equal(await page.$$eval('#chat-log .msg.ai .ai-voice-tag', e => e.length), 0, '폴백 답에는 AI 음성 표시 없음');
    // 「나중에」: 안내가 사라진다
    await page.evaluate(() => document.getElementById('ravi-pack-later').click());
    assert.equal(await page.$eval('#ravi-pack-nudge', e => e.hidden), true);
    assert.ok(!(await page.evaluate(() => window.__CALLS)).some(c => c === 'ravi_tts_read'), '모델을 읽지 않았다');
  });
  // D. 설정 문구·정보 화면(고지)
  await scenario('D 설정·정보', {}, async page => {
    const html = await page.content();
    assert.ok(html.includes('라비 목소리(기본)') && html.includes('기기 목소리'));
    assert.match(await page.$eval('#about-supertonic', e => e.textContent), /Supertonic 3[\s\S]*OpenRAIL-M[\s\S]*AI 가 만든 음성/);
    await page.evaluate(() => { for (let n = document.getElementById('about-supertonic-license'); n && n !== document.body; n = n.parentElement) { n.hidden = false; n.style.setProperty('display', n.tagName === 'DETAILS' ? 'block' : 'block', 'important'); } });
    await page.$eval('#about-supertonic-license summary', d => d.click());
    await page.waitForFunction(() => /OpenRAIL|Open Responsible AI|RAIL/i.test(document.getElementById('about-supertonic-license-text').textContent), { timeout: 5000 });
  });
  console.log('모두 통과', JSON.stringify(report));
} finally { await browser?.close(); server.close(); }
