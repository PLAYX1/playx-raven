// 라비 작은 한국어 목소리(ko-v2) 앱 화면 시험 — 큰 목소리(Supertonic)가 없는 컴퓨터에서 한국어 답이 앱 안 19MB 모델(22050Hz)로 나오는지.
// check-ravi-tts-browser.mjs 의 가짜 장치를 그대로 쓰고 큰 모델은 필요 없다. 먼저 npm run build.
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
  // 웹 오디오(조각 줄): 조각마다 기록(선언 샘플레이트·길이) — 첫 조각 시각이 첫 소리 시각.
  const start = AudioBufferSourceNode.prototype.start;
  AudioBufferSourceNode.prototype.start = function (when = 0, ...rest) {
    const b = this.buffer; if (b && b.duration > 0.2) { window.__PLAYED.push({ src: 'webaudio', duration: b.duration }); window.__WAVS.push({ rate: b.sampleRate, seconds: b.duration, peak: 0 }); }
    return start.call(this, when, ...rest);
  };
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
    await settle(page); await page.$eval('#rv-header-ravi', el => el.click()); await settle(page);
    try { await body(page); } catch (e) { console.log('FAIL', name, 'errors=', errors.slice(0, 5), 'log=', await page.$eval('#chat-log', x => x.textContent.slice(0, 300)).catch(() => '?'), 'lic=', await page.evaluate(() => document.getElementById('about-supertonic-license-text')?.textContent.slice(0, 60) + '|' + document.getElementById('about-supertonic-license')?.open + '|' + window.__CALLS.filter(c => c === 'ravi_tts_read').length), 'dbg=', await page.evaluate(() => JSON.stringify(window.__ttsdbg)), 'state=', await page.evaluate(() => JSON.stringify({ hidden: document.hidden, focus: document.hasFocus(), panel: [document.getElementById('ravi-panel').hidden, getComputedStyle(document.getElementById('ravi-panel')).display, document.getElementById('ravi-panel').getClientRects().length], approval: Array.from(document.querySelectorAll('.ravi-lifecycle[open], .sheet:not(.hidden), #askwrap.on, #rpwrap, #onboard:not(.hidden), #hello, #send-review, #qrwrap, #phone-tx-send:not([hidden])')).filter(e => e.getClientRects().length).map(e => e.id || e.className) })), 'worker=', await page.evaluate(() => JSON.stringify(window.__WLOG)), 'tts-calls=', await page.evaluate(() => window.__CALLS.filter(c => c.startsWith('ravi_tts')).length).catch(() => '?')); throw e; }
    const r = { name, errors }; report.push(r);
    assert.deepEqual(errors, [], name + ' 오류 없음'); await context.close();
  }
  const ask = async page => {
    await page.$eval('#chat-q', el => { el.value = '레이븐코인은 언제 만들어졌어?'; });
    await page.$eval('#chat-go', el => el.click());
    await page.waitForFunction(() => [...document.querySelectorAll('#chat-log .msg.ai .msgtxt')].some(e => e.textContent.includes('무엇을 도와 드릴까요')), { timeout: 8000 });
  };

  // 큰 목소리(Supertonic)가 없는 컴퓨터: 한국어 답은 앱 안 작은 목소리(ko-v2, 22050Hz)로 나와야 한다(기기 목소리 아님).
  await scenario('K 작은 한국어 목소리', { missing: true }, async page => {
    await page.$eval('#ravi-read', el => el.click()); await new Promise(r => setTimeout(r, 300));
    const t0 = Date.now(); await ask(page);
    await page.waitForFunction(() => window.__PLAYED.length >= 1 || window.__DEVICE.length >= 1, { timeout: 30000 });
    const first = Date.now() - t0;
    await page.waitForFunction(() => document.getElementById('ravi-ai-voice').hidden, { timeout: 60000 });
    const r = await page.evaluate(() => ({ played: window.__PLAYED, wavs: window.__WAVS, device: window.__DEVICE, wlog: window.__WLOG, reads: window.__CALLS.filter(c => c === 'ravi_tts_read').length }));
    console.log('first-sound-ms', first, JSON.stringify(r).slice(0, 600));
    assert.deepEqual(r.device, [], '기기 목소리로 안 넘어감');
    assert.ok(r.wavs.length >= 2 && r.wavs.every(w => w.rate === 22050), '작은 목소리 22050Hz 조각들');
    assert.equal(r.reads, 0, '큰 모델 안 읽음');
  });
  // 11-29 앱이 켜지고 한가할 때 ko-v2 를 미리 올린다(ravi-home.ts) → 첫 소리 목표 ≤ 0.5초(헤드리스 맥 참고값, 실제 기기 아님).
  //   여기서는 「글로 물어도 읽기」를 켜지 않고 미리 올라오기를 기다린 뒤 켠다 — 켜는 순간의 warm 은 이미 올라와 있으면 시간만 늘린다.
  await scenario('K2 미리 올린 뒤 첫 소리', { missing: true }, async page => {
    await new Promise(r => setTimeout(r, 9000));   // 4초 뒤 + 한가할 때 미리 올리기
    await page.$eval('#ravi-read', el => el.click());
    const t0 = Date.now(); await ask(page);
    const answered = Date.now() - t0;
    await page.waitForFunction(() => window.__PLAYED.length >= 1 || window.__DEVICE.length >= 1, { timeout: 30000 });
    const first = Date.now() - t0;
    const r = await page.evaluate(() => ({ device: window.__DEVICE.length, played: window.__PLAYED.length }));
    console.log('prewarmed first-sound-ms', first, 'answer-ms', answered, 'voice-after-answer-ms', first - answered, JSON.stringify(r));
    assert.equal(r.device, 0, '기기 목소리로 안 넘어감');
    assert.ok(first - answered <= 500, `미리 올린 뒤 답→첫 소리 ${first - answered}ms ≤ 500ms`);
  });
} finally { await browser?.close(); server.close(); }
