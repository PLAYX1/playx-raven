// RV-LOCK v1 in real Chrome (production dist, synthetic fixture, MOCK chain/IPFS/key store only; nothing reaches a node, IPFS daemon, wallet or network).
// Covers: wizard with encryption on (key stored BEFORE pinning, ciphertext pinned, short clip separate, issuing blocked until the key file is saved),
// seller panel (valid request → grant; forged / non-payer / unconfirmed / garbage refused), buyer panel (request → grant → decrypt → play;
// wrong grant, tampered ciphertext, cancel mid-way leave nothing), and 390/1440 × light/dark contrast + overflow of the new screens.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { mkdtempSync, rmSync, mkdirSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { resolve, join, extname, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { build } from 'esbuild';
import puppeteer from 'puppeteer-core';
import { installFixture } from './desktop-fixture.mjs';

const root = resolve(import.meta.dirname, '..');
const built = await build({ entryPoints: [join(root, 'scripts/fixtures/lock-entry.ts')], bundle: true, write: false, platform: 'node', format: 'cjs', logLevel: 'silent' });
const mod = { exports: {} };
new Function('require', 'exports', 'module', built.outputFiles[0].text)(createRequire(import.meta.url), mod.exports, mod);
const L = mod.exports;
// 🔒 옛 이름 발행 화면 흐름 시험은 잠금(CREATOR_PUBLISH_PAUSED)이 풀릴 때만 돈다(지우지 않는다). 지갑 core 가 옛 RV. 새 발행을 늘 막으므로 풀 때 새 이름 규칙으로 다시 쓴다.
const PAUSED_SKIP = L.CREATOR_PUBLISH_PAUSED ? '「내 상품 올리기」 임시 잠금 중(src/creator-pause.ts) — 옛 RV. 이름으로 올리고 등록하는 화면 흐름. 잠금 해제 때 새 이름 규칙으로 다시 쓴다' : false;

const RECEIVING = 'RCJPGkCQi5NpBgtj8qkjGcSugfWRa3iQiS';
const SELLER_KEY = L.randomKey(), SELLER = L.addressOf(SELLER_KEY);
const PAYER_KEY = L.randomKey(), PAYER = L.addressOf(PAYER_KEY);
const OTHER_KEY = L.randomKey(), FEE_ADDR = L.addressOf(L.randomKey());
const TXID = 'ab'.repeat(32);
const OWNER = '11111111-1111-4111-8111-111111111111';
const ASSET = 'RV.M.LOCK_E2E';
const enc = s => new TextEncoder().encode(s);
const hex = b => Buffer.from(b).toString('hex');
const RVN = n => String(n * 100_000_000);
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 73, 72, 68, 82]);
/** A real, decodable mono 16-bit WAV (sine) so the wizard's real clip maker (AudioContext) can cut it. */
function wav(seconds, rate = 8000) {
  const n = seconds * rate, b = new Uint8Array(44 + n * 2), dv = new DataView(b.buffer);
  b.set(enc('RIFF')); dv.setUint32(4, 36 + n * 2, true); b.set(enc('WAVEfmt '), 8); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
  dv.setUint32(24, rate, true); dv.setUint32(28, rate * 2, true); dv.setUint16(32, 2, true); dv.setUint16(34, 16, true); b.set(enc('data'), 36); dv.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) dv.setInt16(44 + i * 2, Math.round(Math.sin(i / 12) * 12000), true);
  return b;
}
const TRACK = wav(3);

let work, dist, browser, server, origin, shotDir;
before(async () => {
  work = mkdtempSync(join(tmpdir(), 'rv-lock-ui-'));
  shotDir = process.env.RV_LOCK_SHOTS || join(work, 'shots'); mkdirSync(shotDir, { recursive: true });
  dist = join(work, 'dist');
  execFileSync(process.execPath, [resolve(root, 'node_modules/vite/bin/vite.js'), 'build', '--outDir', dist, '--emptyOutDir', '--logLevel', 'error'], { cwd: root, stdio: ['ignore', 'ignore', 'inherit'] });
  const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.json': 'application/json' };
  server = createServer(async (req, res) => {
    try {
      const path = resolve(dist, '.' + decodeURIComponent(new URL(req.url, 'http://x').pathname));
      if (path !== dist && !path.startsWith(dist + sep)) throw Error('path');
      const file = path === dist ? join(dist, 'index.html') : path;
      if (!(await stat(file)).isFile()) throw Error('file');
      res.writeHead(200, { 'Content-Type': types[extname(file)] || 'application/octet-stream' }); res.end(await readFile(file));
    } catch { res.writeHead(404); res.end(); }
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  origin = `http://127.0.0.1:${server.address().port}`;
  browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true, userDataDir: join(work, 'profile'),
    args: ['--no-sandbox', '--disable-gpu', '--autoplay-policy=no-user-gesture-required'] });
});
after(async () => { await browser?.close(); server?.close(); if (work && !process.env.RV_KEEP_WORK) rmSync(work, { recursive: true, force: true }); });

/** Mock Tauri side. Everything the lock screens touch is answered here; nothing else is reachable. */
function installHarness({ chain }) {
  const base = window.__TAURI_INTERNALS__.invoke;
  const calls = window.__calls = [];
  const pinned = window.__pinned = new Map();          // cid -> Uint8Array
  const names = window.__names = new Map();            // cid -> file name
  const secrets = window.__secrets = new Map();        // lock-keys/<name>.key
  window.__txConf = 8; window.__flip = false; window.__delay = 0; window.__rangeCalls = 0; window.__urlCount = 0;
  const realCreate = URL.createObjectURL.bind(URL);
  URL.createObjectURL = b => { window.__urlCount++; return realCreate(b); };
  const b64 = bytes => { let s = ''; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000)); return btoa(s); };
  const wrap = async (cmd, args) => {
    if (cmd === 'ipfs_add_file') { const bytes = Uint8Array.from(args.file.bytes); const cid = await window.__mockCid(Array.from(bytes)); pinned.set(cid, bytes); names.set(cid, args.file.name); calls.push({ cmd, name: args.file.name, size: bytes.length }); return { cid, name: args.file.name, size: bytes.length }; }
    if (cmd === 'cid_alive') return pinned.has(args.cid);
    if (cmd === 'sign_message') { calls.push({ cmd, address: args.address }); return { address: args.address, message: args.message, signature: await window.__sign(args.address, args.message) }; }
    if (cmd === 'name_taken') return false;
    if (cmd === 'node_status') { const s = await base(cmd, args); return { ...s, chain }; }
    if (cmd === 'wallet_balance') return { confirmed: 600, unconfirmed: 0 };
    if (cmd === 'receive_address') return { address: window.__sellerAddress, reused: true, mine: true };
    if (cmd === 'new_address') return window.__sellerAddress;
    if (cmd === 'issue_asset') { calls.push({ cmd }); return { txid: 'cd'.repeat(32), owner_token: args.name + '!' }; }
    if (cmd === 'market_list_assets') return [];
    if (cmd === 'market_chain_tip') return { chain, height: null, synced: false };
    if (cmd === 'plugin:dialog|open') { calls.push({ cmd }); return window.__pickedFolder ?? null; }
    if (cmd === 'lock_secret_get') { calls.push({ cmd, name: args.name }); return { hex: secrets.get(args.name) ?? null }; }
    if (cmd === 'lock_secret_put') { calls.push({ cmd, name: args.name }); if (secrets.has(args.name) && secrets.get(args.name) !== args.hex) throw new Error('EXISTS:덮어쓰지 않았어요'); secrets.set(args.name, args.hex); return { ok: true, created: true }; }
    if (cmd === 'lock_key_export') { calls.push({ cmd, asset: args.asset, dest: args.dest }); if (window.__exportFail) throw new Error('쓸 수 없는 폴더예요'); return { ok: true, path: args.dest + '/lockkey-' + args.asset + '.pxlock', verified: true, size: 300 }; }
    if (cmd === 'lock_tx_info') { calls.push({ cmd, txid: args.txid }); if (!window.__tx) throw new Error('없음'); return { ...window.__tx, confirmations: window.__txConf }; }
    if (cmd === 'creator_cid_read') { const b = pinned.get(args.cid); if (!b) throw new Error('없음'); return { size: b.length, data: b64(b) }; }
    if (cmd === 'lock_cid_range') {
      window.__rangeCalls++;
      const b = pinned.get(args.cid); if (!b) throw new Error('없음');
      if (window.__delay) await new Promise(r => setTimeout(r, window.__delay));
      const part = b.slice(args.offset, args.offset + args.length);
      if (window.__flip && part.length > 100) part[100] ^= 1;
      return { size: part.length, data: b64(part) };
    }
    return base(cmd, args);
  };
  window.__TAURI_INTERNALS__.invoke = wrap; window.__TAURI__.core.invoke = wrap;
}

async function openApp({ width = 1440, height = 900, theme = 'light', chain = 'regtest', extra = null } = {}) {
  const page = await browser.newPage();
  page.on('pageerror', e => { page.__errors = [...(page.__errors ?? []), e.message]; });
  await page.setViewport({ width, height });
  await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: theme }, { name: 'prefers-reduced-motion', value: 'reduce' }]);
  await page.setRequestInterception(true);
  page.on('request', r => (new URL(r.url()).origin === origin && r.method() === 'GET') ? r.continue() : r.abort());
  await page.exposeFunction('__mockCid', bytes => L.mockCid(Uint8Array.from(bytes)));
  await page.exposeFunction('__sign', (address, message) => {
    const key = address === SELLER ? SELLER_KEY : address === PAYER ? PAYER_KEY : null;
    if (!key) throw Error('wrong address ' + address);
    return L.signMessageForTest(message, key);
  });
  await page.evaluateOnNewDocument(installFixture, { theme, sales: true, seller: true });
  await page.evaluateOnNewDocument(installHarness, { chain });
  await page.evaluateOnNewDocument(a => { window.__sellerAddress = a; window.__pickedFolder = '/tmp/lock-keys-folder'; }, SELLER);
  if (extra) await page.evaluateOnNewDocument(extra.fn, extra.arg);
  await page.goto(origin + '/', { waitUntil: 'networkidle0' });
  await page.waitForFunction(() => document.querySelector('#page-home.on') && !document.documentElement.hasAttribute('data-ravi-arriving'), { timeout: 20000 });
  await page.evaluate(() => document.querySelector('nav')?.classList.add('more-open'));
  await page.click('nav a[data-page="games"]');
  await page.waitForFunction(() => document.querySelector('#page-games.on'));
  return page;
}
const text = (page, sel) => page.$eval(sel, e => e.tagName === 'TEXTAREA' ? e.value : e.textContent.replace(/\s+/g, ' ').trim());
const stepNow = page => page.evaluate(() => Number([...document.querySelectorAll('#page-creator .cw-panel')].find(p => !p.hidden)?.dataset.step));
async function next(page, want) { await page.click('#cw-next'); await page.waitForFunction(w => Number([...document.querySelectorAll('#page-creator .cw-panel')].find(p => !p.hidden)?.dataset.step) === w, { timeout: 10000 }, want); }
async function dropFiles(page, files) {
  await page.evaluate(list => {
    const dt = new DataTransfer();
    for (const f of list) dt.items.add(new File([Uint8Array.from(f.bytes)], f.name, { type: f.type }));
    document.querySelector('#cw-drop').dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
  }, files.map(f => ({ name: f.name, type: f.type, bytes: Array.from(f.bytes) })));
}
const setValue = (page, sel, v) => page.$eval(sel, (e, val) => { e.value = val; e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true })); }, v);

function textContrast(scope) {
  const parse = c => { const v = c.match(/[\d.]+/g)?.map(Number); if (!v || v.length < 3) return [0, 0, 0, 0]; return c.startsWith('color(') ? [v[0], v[1], v[2], v[3] ?? 1] : [v[0] / 255, v[1] / 255, v[2] / 255, v[3] ?? 1]; };
  const over = (a, b) => [...a.slice(0, 3).map((x, i) => x * a[3] + b[i] * (1 - a[3])), 1];
  const lum = c => { const f = x => x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]); };
  const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m); return (x + 0.05) / (y + 0.05); };
  const opacityOf = el => { let o = 1; for (let p = el; p; p = p.parentElement) o *= parseFloat(getComputedStyle(p).opacity); return o; };
  const out = [];
  for (const n of document.querySelectorAll(scope + ' *')) {
    if (![...n.childNodes].some(t => t.nodeType === 3 && t.textContent.trim())) continue;
    const r = n.getBoundingClientRect(), s = getComputedStyle(n);
    if (!r.width || !r.height || s.visibility !== 'visible' || n.closest('[hidden]') || (n.disabled && n.tagName === 'BUTTON')) continue;
    const chain = []; for (let p = n; p; p = p.parentElement) chain.unshift(p);
    let gradient = false;
    const bg = chain.reduce((acc, p) => { const st = getComputedStyle(p); if (st.backgroundImage !== 'none' && p !== document.documentElement && p !== document.body) gradient = true; return over(parse(st.backgroundColor), acc); }, [1, 1, 1, 1]);
    const raw = parse(s.color); const fg = over([raw[0], raw[1], raw[2], raw[3] * opacityOf(n)], bg);
    out.push({ el: (n.id ? '#' + n.id : n.tagName.toLowerCase()) + '「' + n.textContent.trim().slice(0, 20) + '」', ratio: Math.round(ratio(fg, bg) * 100) / 100, gradient });
  }
  return out;
}
const overflow = (page, scope) => page.evaluate(sc => {
  const vw = document.documentElement.clientWidth, out = [];
  for (const e of document.querySelectorAll(sc + ' *')) {
    const r = e.getBoundingClientRect(); if (!r.width || e.closest('[hidden]')) continue;
    const card = e.closest('.card'); const limit = Math.min(vw, card && card !== e ? card.getBoundingClientRect().right : vw);
    let right = r.right;
    for (const t of e.childNodes) if (t.nodeType === 3 && t.textContent.trim()) { const range = document.createRange(); range.selectNodeContents(t); for (const q of range.getClientRects()) right = Math.max(right, q.right); }
    if (right > limit + 1) out.push((e.id ? '#' + e.id : e.tagName.toLowerCase()) + ':' + Math.round(right) + '>' + Math.round(limit));
  }
  return out.slice(0, 10);
}, scope);
async function audit(page, scope, label) {
  await page.mouse.move(1, 1);
  await page.waitForFunction(() => document.getAnimations().filter(a => a.playState === 'running' && !(a.effect?.getComputedTiming?.().iterations === Infinity)).length === 0, { timeout: 5000 }).catch(() => {});
  const all = await page.evaluate(textContrast, scope);
  await page.screenshot({ path: join(shotDir, `${label}.png`), fullPage: true });
  const low = all.filter(r => !r.gradient && r.ratio < 4.5), over = await overflow(page, scope);
  assert.ok(all.length > 5, `${label}: nothing measured`);
  assert.deepEqual(low, [], `${label} low contrast`); assert.deepEqual(over, [], `${label} overflow`);
}

/* ── fixtures for the buyer/seller screens (a locked product published in node, its bytes preloaded into the page's mock IPFS) ── */
async function product() {
  const K = L.newProductKey();
  const pin = new L.MockPinAdapter();
  const clip = wav(2);
  const r = await L.legacyManifestForTest({ type: 'music', asset: ASSET, title: '잠긴 노래', description: '', priceAtoms: RVN(20), creatorAddress: SELLER, receivingAddress: RECEIVING,
    files: [{ path: 'song.wav', bytes: TRACK, mime: 'audio/wav' }, { path: 'cover.png', bytes: PNG, mime: 'image/png', role: 'cover' }],
    details: { previewFile: 'preview-clip.wav', previewStartMs: 0, previewEndMs: 2000 }, now: new Date('2026-10-13T00:00:00Z'),
    lock: { key: K, previewClip: { path: 'preview-clip.wav', bytes: clip, mime: 'audio/wav' } } }, pin, async (_a, m) => L.signMessageForTest(m, SELLER_KEY));
  r.pinned = [...pin.stored.entries()].map(([cid, b]) => [cid, Array.from(b)]);
  r.key = K;
  r.tx = { txid: TXID, blockHeight: 2000, inputAddresses: [PAYER], outputs: [
    { atoms: RVN(19), scriptHex: L.p2pkhScriptHex(RECEIVING) },
    { atoms: RVN(1), scriptHex: L.p2pkhScriptHex(FEE_ADDR) },
    { atoms: '0', scriptHex: L.memoScriptAccount({ gameIndex: L.OPEN_MARKET_GAME_INDEX, itemId: L.bondedItemId(ASSET), ownerId: OWNER, nonce: 1 }) }] };
  return r;
}
const prep = ({ r, sellerHasKey, purchase }) => ({ fn: (a) => {
  const w = window; const set = () => {
    w.__tx = a.tx;
    for (const [cid, arr] of a.pinned) w.__pinned.set(cid, Uint8Array.from(arr));
    if (a.sellerHasKey) w.__secrets.set('s.' + a.asset, a.keyHex);
    localStorage.setItem('rv-creator-mine-v1', JSON.stringify([{ asset: a.asset, title: '잠긴 노래', type: 'music', manifestCid: a.manifestCid, txid: 'cd'.repeat(32), receivingAddress: a.receiving, at: '2026-10-13T00:00:00.000Z' }]));
    if (a.purchase) localStorage.setItem('rv-market-purchases-v1', JSON.stringify([{ asset: a.asset, title: '잠긴 노래', txid: a.tx.txid, sellerRvn: '19', feeRvn: '1', at: '2026-10-13T00:00:00.000Z', manifestCid: a.manifestCid, assetReceived: false }]));
  };
  // installHarness runs first (same document, earlier script); defer until it exists.
  const t = setInterval(() => { if (w.__pinned) { clearInterval(t); set(); } }, 1);
}, arg: { pinned: r.pinned, tx: r.tx, asset: ASSET, manifestCid: r.manifestCid, keyHex: hex(r.key), receiving: RECEIVING, sellerHasKey, purchase } });

/* ═════════════ A. wizard with encryption on ═════════════ */
test('wizard (music, encryption on by default): key saved on this computer BEFORE anything is pinned · ciphertext pinned · short clip separate · issuing blocked until the key file is saved', { timeout: 300_000, skip: PAUSED_SKIP }, async () => {
  const page = await openApp();
  await page.click('#creator-open');
  await page.waitForFunction(() => document.querySelector('#page-creator.on'));
  await page.click('#dp-detail');
  await page.waitForFunction(() => document.querySelector('#page-creator').dataset.mode === 'wizard');
  assert.match(await text(page, '#cw-guide'), /암호화를 켜면.*열람 요청.*직접 전달.*남에게 주는 것은 기술로 막을 수 없어요.*암호화를 끄면 올린 파일은 공개돼요.*상품 열쇠를 잃으면 복구할 수 없어요/);
  await page.click('#cw-guide-ok'); await page.click('#cw-start');
  await page.waitForFunction(() => !document.querySelector('.cw-panel[data-step="1"]').hidden);
  await page.click('input[name="cw-type"][value="music"]');
  await next(page, 2);
  await dropFiles(page, [{ name: 'song.wav', type: 'audio/wav', bytes: TRACK }, { name: 'cover.png', type: 'image/png', bytes: PNG }]);
  await page.waitForFunction(() => /1개 파일 · 표지 1장/.test(document.querySelector('#cw-files-say').textContent));
  await next(page, 3);
  assert.equal(await page.$eval('#cw-lock-box', e => e.hidden), false); assert.equal(await page.$eval('#cw-lock-on', e => e.checked), true, 'encryption defaults on');
  assert.match(await text(page, '#cw-lock-say'), /암호문으로 올라가요.*구매하면 열람 키가 전달돼요.*파일 공유는 기술로 막을 수 없어요.*잃으면 복구할 수 없어서.*따로 잘라 만든 짧은 파일만 공개돼요.*컴퓨터가 꺼져 있으면/);
  await page.type('#cw-title', '잠긴 노래');
  await setValue(page, '#cw-asset', 'LOCK_WIZ');
  await page.type('#cw-price', '20');
  await page.click('#cw-new-address');
  await page.waitForFunction(a => document.querySelector('#cw-address').value === a, {}, SELLER);
  assert.equal(await page.$eval('#cw-preview-file', s => s.value), 'song.wav');
  await setValue(page, '#cw-preview-start', '0'); await setValue(page, '#cw-preview-end', '2');
  await page.waitForFunction(() => /비어 있어요/.test(document.querySelector('#cw-dup').textContent));
  await next(page, 4);
  await next(page, 5);
  await page.waitForFunction(() => /합계/.test(document.querySelector('#cw-cost').textContent));
  await next(page, 6);
  await audit(page, '#page-creator', 'wizard-lock-step6-before');
  await page.click('#cw-upload');
  await page.waitForFunction(() => /암호화해서 다 올렸어요/.test(document.querySelector('#cw-upload-say').textContent), { timeout: 30000 });
  const calls = await page.evaluate(() => window.__calls);
  const firstPut = calls.findIndex(c => c.cmd === 'lock_secret_put'), firstAdd = calls.findIndex(c => c.cmd === 'ipfs_add_file');
  assert.ok(firstPut >= 0 && firstPut < firstAdd, 'the product key is saved on this computer before the first file is pinned');
  assert.equal(calls.filter(c => c.cmd === 'lock_secret_put').length, 1);
  const pinned = await page.evaluate(() => [...window.__pinned.entries()].map(([cid, b]) => ({ name: window.__names.get(cid), size: b.length, head: Array.from(b.slice(0, 12)) })));
  const song = pinned.find(p => p.name === 'song.wav'), clip = pinned.find(p => p.name === 'preview-clip.wav');
  assert.ok(song && song.size === TRACK.length + 40, 'song.wav pinned as ciphertext (plain + 40 bytes for one chunk)');
  assert.notDeepEqual(song.head, Array.from(TRACK.slice(0, 12)), 'ciphertext does not start with the RIFF header');
  assert.ok(clip && clip.size <= 8 * 1024 * 1024 && String.fromCharCode(...clip.head.slice(0, 4)) === 'RIFF', 'the short clip is a separate plain WAV');
  const lock = await page.evaluate(() => { const m = JSON.parse(localStorage.getItem('rv-creator-draft-v2')).published.manifest; return { files: m.lock.files.map(f => f.path), preview: m.details.previewFile, start: m.details.previewStartMs, end: m.details.previewEndMs, deliver: m.lock.deliver }; });
  assert.deepEqual(lock.files, ['song.wav']); assert.equal(lock.preview, 'preview-clip.wav'); assert.deepEqual([lock.start, lock.end], [0, 2000]); assert.deepEqual(lock.deliver, ['manual']);
  // 백업 전에는 다음으로 못 간다
  assert.equal(await page.$eval('#cw-lock-backup', e => e.hidden), false);
  assert.equal(await page.$eval('#cw-next', b => b.disabled), true);
  assert.match(await page.$eval('#cw-next', b => b.title), /열쇠 파일을 아직 저장하지 않았어요/);
  assert.match(await text(page, '#cw-lock-backup'), /열쇠를 잃으면 나도 이 상품의 파일을 열 수 없고.*복구할 방법이 없어요.*백업 열쇠\(52글자\)/);
  await audit(page, '#page-creator', 'wizard-lock-step6-after');
  // 폴더 선택 취소 → 저장 안 됨
  await page.evaluate(() => { window.__pickedFolder = null; });
  await page.click('#cw-lock-save');
  await page.waitForFunction(() => /폴더를 고르지 않았어요/.test(document.querySelector('#cw-lock-save-say').textContent));
  assert.equal(await page.$eval('#cw-next', b => b.disabled), true);
  // 쓰기 실패 → 저장 안 됨
  await page.evaluate(() => { window.__pickedFolder = '/tmp/lock-keys-folder'; window.__exportFail = true; });
  await page.click('#cw-lock-save');
  await page.waitForFunction(() => /저장하지 못했어요/.test(document.querySelector('#cw-lock-save-say').textContent));
  assert.equal(await page.$eval('#cw-next', b => b.disabled), true);
  // 성공
  await page.evaluate(() => { window.__exportFail = false; });
  await page.click('#cw-lock-save');
  await page.waitForFunction(() => /열쇠 파일을 저장했어요/.test(document.querySelector('#cw-lock-save-say').textContent));
  assert.equal(await page.$eval('#cw-next', b => b.disabled), false);
  const exp = (await page.evaluate(() => window.__calls)).filter(c => c.cmd === 'lock_key_export').pop();
  assert.deepEqual([exp.asset, exp.dest], ['RV.M.LOCK_WIZ', '/tmp/lock-keys-folder']);
  await next(page, 7);
  await page.waitForFunction(() => document.querySelector('#cw-c-name').textContent === 'RV.M.LOCK_WIZ');
  await page.type('#cw-typed', 'RV.M.LOCK_WIZ');
  await page.waitForFunction(() => !document.querySelector('#cw-issue').disabled);
  await page.click('#cw-issue');
  await page.waitForFunction(() => !document.querySelector('.cw-panel[data-step="8"]').hidden, { timeout: 10000 });
  assert.equal(await page.$eval('#cw-lock-done', e => e.hidden), false);
  assert.match(await text(page, '#cw-lock-done'), /암호화돼 있어요.*열람 요청 글을 보내오면.*구매자 열람 요청 처리/);
  assert.deepEqual(page.__errors ?? [], []);
  await page.close();
});

test('wizard with encryption switched off says the files are public (honest legacy path) and shows no key screen', { timeout: 120_000, skip: PAUSED_SKIP }, async () => {
  const page = await openApp();
  await page.click('#creator-open'); await page.waitForFunction(() => document.querySelector('#page-creator.on'));
  await page.click('#dp-detail'); await page.waitForFunction(() => document.querySelector('#page-creator').dataset.mode === 'wizard');
  await page.click('#cw-guide-ok'); await page.click('#cw-start');
  await page.waitForFunction(() => !document.querySelector('.cw-panel[data-step="1"]').hidden);
  await page.click('input[name="cw-type"][value="digital"]'); await next(page, 2);
  await dropFiles(page, [{ name: 'a.png', type: 'image/png', bytes: PNG }]);
  await page.waitForFunction(() => /1개 파일/.test(document.querySelector('#cw-files-say').textContent));
  await next(page, 3);
  assert.equal(await page.$eval('#cw-lock-box', e => e.hidden), false);
  await page.click('#cw-lock-on');
  assert.match(await text(page, '#cw-lock-say'), /암호화하지 않으면 올린 파일은 주소\(CID\)를 아는 누구나 받을 수 있어요/);
  await page.close();
  // game / ticket have no encryption choice
  const p2 = await openApp();
  await p2.click('#creator-open'); await p2.waitForFunction(() => document.querySelector('#page-creator.on'));
  await p2.click('#dp-detail'); await p2.waitForFunction(() => document.querySelector('#page-creator').dataset.mode === 'wizard');
  await p2.click('#cw-guide-ok'); await p2.click('#cw-start');
  await p2.waitForFunction(() => !document.querySelector('.cw-panel[data-step="1"]').hidden);
  await p2.click('input[name="cw-type"][value="ticket"]'); await next(p2, 2); await dropFiles(p2, [{ name: 'a.png', type: 'image/png', bytes: PNG }]);
  await p2.waitForFunction(() => /1개 파일/.test(document.querySelector('#cw-files-say').textContent)); await next(p2, 3);
  assert.equal(await p2.$eval('#cw-lock-box', e => e.hidden), true, 'tickets are not encrypted');
  await p2.close();
});

/* ═════════════ B. seller panel ═════════════ */
test('seller panel: a payer-signed request becomes a grant the buyer can open; forged / non-payer / unconfirmed / garbage requests are refused with the reason', { timeout: 300_000 }, async () => {
  const r = await product();
  const page = await openApp({ extra: prep({ r, sellerHasKey: true, purchase: false }) });
  await page.click('#creator-open'); await page.waitForFunction(() => document.querySelector('#page-creator.on'));
  assert.equal(await page.$eval('#lk-seller', e => e.hidden), true);
  await page.click('#lk-s-toggle');
  assert.equal(await page.$eval('#lk-seller', e => e.hidden), false);
  await page.waitForFunction(() => /열쇠: 이 컴퓨터에 있어요/.test(document.querySelector('#lk-s-key').textContent));
  const buyer = L.newLockKeypair();
  const reqText = await L.createLockRequest({ asset: ASSET, txid: TXID, lockPub: buyer.pub, at: 1790000000, sign: async m => L.signMessageForTest(m, PAYER_KEY) });
  const run = async (t) => { await setValue(page, '#lk-s-request', t); await page.click('#lk-s-go'); await page.waitForFunction(() => !/확인하는 중/.test(document.querySelector('#lk-s-say').textContent), { timeout: 10000 }); return text(page, '#lk-s-say'); };
  // 확인 수 미달
  await page.evaluate(() => { window.__txConf = 3; });
  assert.match(await run(reqText), /결제 확인이 아직 모자라요\(3\/6\).*기다리면 되는 경우/);
  assert.equal(await page.$eval('#lk-s-grant-wrap', e => e.hidden), true);
  await page.evaluate(() => { window.__txConf = 8; });
  // 서명한 주소가 결제 주소가 아님
  const outsider = await L.createLockRequest({ asset: ASSET, txid: TXID, lockPub: buyer.pub, at: 1790000000, sign: async m => L.signMessageForTest(m, OTHER_KEY) });
  assert.match(await run(outsider), /서명한 주소가 이 결제를 보낸 주소가 아니에요/);
  // 위조(서명 없음/깨짐)·형식 아님
  assert.match(await run('RVLQ1.!!!'), /열람 요청 글이 아니에요/);
  assert.match(await run('hello'), /열람 요청 글이 아니에요/);
  const body = JSON.parse(Buffer.from(reqText.slice(6), 'base64url').toString());
  const broken = 'RVLQ1.' + Buffer.from(JSON.stringify({ ...body, sig: 'AAAA' })).toString('base64url');
  assert.match(await run(broken), /서명이 맞지 않아요/);
  // 다른 상품의 글
  const other = 'RVLQ1.' + Buffer.from(JSON.stringify({ ...body, asset: 'RV.M.OTHER' })).toString('base64url');
  assert.match(await run(other), /내가 올린 상품의 요청이 아니에요/);
  // 결제가 모자란 거래
  await page.evaluate(() => { const t = structuredClone(window.__tx); t.outputs[0].atoms = '100000000'; window.__tx = t; });
  assert.match(await run(reqText), /정당한 결제로 확인되지 않아요/);
  await page.evaluate(a => { const t = structuredClone(window.__tx); t.outputs[0].atoms = a; window.__tx = t; }, RVN(19));
  // 정상
  const good = await run(reqText);
  assert.match(good, /확인했어요.*서명했고, 결제도 맞아요.*열람 허가 글을 구매자에게 직접 보내 주세요.*남에게 주는 것은 막을 수 없어요/);
  assert.equal(await page.$eval('#lk-s-grant-wrap', e => e.hidden), false);
  const grant = await text(page, '#lk-s-grant');
  assert.ok(grant.startsWith('RVLG1.'));
  assert.equal(hex(L.openLockGrant({ grantText: grant, manifest: r.manifest, txid: TXID, lockPriv: buyer.priv })), hex(r.key), 'buyer opens the grant');
  assert.notEqual(grant.includes(hex(r.key)), true, 'the grant does not contain the key in the clear');
  // 같은 요청이 다시 오면 다시 내준다 · 서로 다른 열람 공개키는 3개까지
  assert.match(await run(reqText), /같은 요청이라 다시 만들어 드렸어요/);
  for (let i = 0; i < 2; i++) { const kp = L.newLockKeypair(); assert.match(await run(await L.createLockRequest({ asset: ASSET, txid: TXID, lockPub: kp.pub, at: 1790000001 + i, sign: async m => L.signMessageForTest(m, PAYER_KEY) })), /확인했어요/); }
  const fourth = L.newLockKeypair();
  assert.match(await run(await L.createLockRequest({ asset: ASSET, txid: TXID, lockPub: fourth.pub, at: 1790000009, sign: async m => L.signMessageForTest(m, PAYER_KEY) })), /이미 허가를 여러 번 내줬어요/);
  assert.deepEqual(page.__errors ?? [], []);
  await page.close();
});

test('seller panel: without the product key on this computer nothing is granted (and it says how to restore)', { timeout: 120_000 }, async () => {
  const r = await product();
  const page = await openApp({ extra: prep({ r, sellerHasKey: false, purchase: false }) });
  await page.click('#creator-open'); await page.waitForFunction(() => document.querySelector('#page-creator.on'));
  await page.click('#lk-s-toggle');
  await page.waitForFunction(() => /이 컴퓨터에 이 상품의 열쇠가 없어요/.test(document.querySelector('#lk-s-key').textContent));
  const buyer = L.newLockKeypair();
  await setValue(page, '#lk-s-request', await L.createLockRequest({ asset: ASSET, txid: TXID, lockPub: buyer.pub, at: 1790000000, sign: async m => L.signMessageForTest(m, PAYER_KEY) }));
  await page.click('#lk-s-go');
  await page.waitForFunction(() => /이 컴퓨터에 이 상품의 열쇠가 없어요/.test(document.querySelector('#lk-s-say').textContent));
  assert.equal(await page.$eval('#lk-s-grant-wrap', e => e.hidden), true);
  await page.click('#lk-s-restore-toggle');
  assert.equal(await page.$eval('#lk-s-restore-box', e => e.hidden), false);
  await page.click('#lk-s-restore');
  assert.match(await text(page, '#lk-s-restore-say'), /먼저 열쇠 파일을 골라 주세요/);
  await page.close();
});

/* ═════════════ C. buyer panel ═════════════ */
test('buyer panel: request signed by the paying address → grant → decrypt in memory → plain hash matches · wrong grant / tampered bytes / cancel leave nothing', { timeout: 300_000 }, async () => {
  const r = await product();
  const page = await openApp({ extra: prep({ r, sellerHasKey: false, purchase: true }) });
  await page.click('#market-open'); await page.waitForFunction(() => document.querySelector('#page-market.on'));
  await page.waitForFunction(() => document.querySelector('.mk-open-lock'));
  assert.equal(await page.$eval('#lk-buyer', e => e.hidden), true);
  await page.click('.mk-open-lock');
  await page.waitForFunction(() => !document.querySelector('#lk-buyer').hidden && !document.querySelector('#lk-b-request-box').hidden);
  assert.match(await text(page, '#lk-b-note'), /구매하면 열람 키가 전달됩니다\. 파일 공유는 기술로 막을 수 없습니다\..*바로 열리지 않을 수 있어요/);
  assert.match(await text(page, '#lk-b-state'), /아직 열람 키가 없어요/);
  // 열람 요청 만들기: 결제 거래의 입력 주소(PAYER)로 서명한다
  await page.click('#lk-b-make');
  await page.waitForFunction(() => /^RVLQ1\./.test(document.querySelector('#lk-b-request').value), { timeout: 10000 });
  const req = L.decodeLockRequest(await text(page, '#lk-b-request'));
  assert.ok(req && req.asset === ASSET && req.txid === TXID);
  const signed = (await page.evaluate(() => window.__calls)).filter(c => c.cmd === 'sign_message');
  assert.deepEqual(signed.map(c => c.address), [PAYER]);
  const privHex = await page.evaluate(t => window.__secrets.get('b.' + t), TXID);
  assert.ok(/^[0-9a-f]{64}$/.test(privHex), 'buyer lock private key kept on this computer, not in the request');
  assert.ok(!(await text(page, '#lk-b-request')).includes(privHex));
  // 같은 결제로 다시 눌러도 같은 열람 공개키
  await page.click('#lk-b-make'); await page.waitForFunction(() => /^RVLQ1\./.test(document.querySelector('#lk-b-request').value));
  assert.equal(L.decodeLockRequest(await text(page, '#lk-b-request')).lockPub, req.lockPub);
  // 엉뚱한 허가(다른 사람의 열람 공개키로 싼 것) → 거절
  const stranger = L.newLockKeypair();
  const wrongGrant = L.createLockGrant({ manifest: r.manifest, key: r.key, request: { asset: ASSET, txid: TXID, lockPub: stranger.pub } });
  await setValue(page, '#lk-b-grant', wrongGrant); await page.click('#lk-b-accept');
  await page.waitForFunction(() => /허가 글을 풀지 못했어요/.test(document.querySelector('#lk-b-say').textContent));
  assert.equal(await page.$eval('#lk-b-open-box', e => e.hidden), true);
  assert.equal(await page.evaluate(() => window.__secrets.has('k.RV.M.LOCK_E2E')), false, 'no key stored from a wrong grant');
  // 가짜 열쇠를 이 사람 공개키로 싼 허가 → 거절(지문 불일치)
  const fakeKey = L.newProductKey();
  const fakeGrant = L.createLockGrant({ manifest: { ...r.manifest, lock: { ...r.manifest.lock, keyId: L.lockKeyId(ASSET, fakeKey) } }, key: fakeKey, request: { asset: ASSET, txid: TXID, lockPub: req.lockPub } });
  await setValue(page, '#lk-b-grant', fakeGrant); await page.click('#lk-b-accept');
  await page.waitForFunction(() => /허가 글을 풀지 못했어요/.test(document.querySelector('#lk-b-say').textContent));
  assert.equal(await page.evaluate(() => window.__secrets.has('k.RV.M.LOCK_E2E')), false);
  // 정상 허가
  const grant = L.createLockGrant({ manifest: r.manifest, key: r.key, request: { asset: ASSET, txid: TXID, lockPub: req.lockPub } });
  await setValue(page, '#lk-b-grant', grant); await page.click('#lk-b-accept');
  await page.waitForFunction(() => !document.querySelector('#lk-b-open-box').hidden);
  assert.match(await text(page, '#lk-b-state'), /열람 키가 이 컴퓨터에 있어요/);
  assert.equal(await page.$eval('#lk-b-request-box', e => e.hidden), true);
  await audit(page, '#lk-buyer', 'buyer-panel-open');
  // 변조된 암호문 → 열지 않는다
  await page.evaluate(() => { window.__flip = true; });
  await page.click('#lk-b-files-slot button');
  await page.waitForFunction(() => /변조됐거나 받는 중에 깨졌어요/.test(document.querySelector('#lk-b-say').textContent), { timeout: 20000 });
  assert.equal(await page.$('#lk-b-audio'), null); assert.equal(await page.evaluate(() => window.__urlCount), 0, 'no playable URL was made from tampered bytes');
  // 취소(받는 도중)
  await page.evaluate(() => { window.__flip = false; window.__delay = 1500; });
  await page.click('#lk-b-files-slot button');
  await page.waitForFunction(() => !document.querySelector('#lk-b-cancel').hidden);
  await page.click('#lk-b-cancel');
  await page.waitForFunction(() => /취소했어요/.test(document.querySelector('#lk-b-say').textContent));
  await page.waitForFunction(() => document.querySelector('#lk-b-cancel').hidden, { timeout: 10000 });
  assert.equal(await page.$('#lk-b-audio'), null); assert.equal(await page.evaluate(() => window.__urlCount), 0, 'cancel leaves no playable URL');
  // 정상 열기 → 평문 해시 일치
  await page.evaluate(() => { window.__delay = 0; });
  await page.click('#lk-b-files-slot button');
  await page.waitForFunction(() => document.querySelector('#lk-b-audio'), { timeout: 20000 });
  assert.match(await text(page, '#lk-b-say'), /풀었어요\. 파일 내용이 상품 정보의 지문과 같아요/);
  const got = await page.evaluate(async () => { const b = await (await fetch(document.querySelector('#lk-b-audio').src)).arrayBuffer(); const h = await crypto.subtle.digest('SHA-256', b); return { size: b.byteLength, sha: Array.from(new Uint8Array(h), x => x.toString(16).padStart(2, '0')).join('') }; });
  assert.deepEqual(got, { size: TRACK.length, sha: createHash('sha256').update(TRACK).digest('hex') });
  // 닫으면 재생 주소를 거둔다
  await page.click('#lk-b-close');
  assert.equal(await page.$eval('#lk-buyer', e => e.hidden), true);
  assert.equal(await page.$eval('#lk-b-media', e => e.children.length), 0);
  assert.deepEqual(page.__errors ?? [], []);
  await page.close();
});

test('buyer panel: a payment from an address this wallet cannot sign for (e.g. exchange) is told why; a product without encryption says its files are public', { timeout: 200_000 }, async () => {
  const r = await product();
  const page = await openApp({ extra: prep({ r, sellerHasKey: false, purchase: true }) });
  await page.evaluate(a => { const t = structuredClone(window.__tx); t.inputAddresses = [a]; window.__tx = t; }, FEE_ADDR);
  await page.click('#market-open'); await page.waitForFunction(() => document.querySelector('.mk-open-lock'));
  await page.click('.mk-open-lock'); await page.waitForFunction(() => !document.querySelector('#lk-b-request-box').hidden);
  await page.click('#lk-b-make');
  await page.waitForFunction(() => /서명할 수 없어요.*이 지갑에서 보낸 결제만 열람 요청을 만들 수 있어요/.test(document.querySelector('#lk-b-say').textContent));
  assert.equal(await page.$eval('#lk-b-request', e => e.value), '');
  await page.close();
  // 암호화 없는 옛 상품
  const plainPin = new L.MockPinAdapter();
  const plain = await L.legacyManifestForTest({ type: 'digital', asset: 'RV.X.PLAIN_E2E', title: '평문', description: '', priceAtoms: RVN(5), creatorAddress: SELLER, receivingAddress: RECEIVING,
    files: [{ path: 'a.png', bytes: PNG, mime: 'image/png' }], details: { label: '그림' }, now: new Date('2026-10-13T00:00:00Z') }, plainPin, async (_a, m) => L.signMessageForTest(m, SELLER_KEY));
  const p2 = await openApp({ extra: { fn: a => { const t = setInterval(() => { if (window.__pinned) { clearInterval(t); for (const [cid, arr] of a.pinned) window.__pinned.set(cid, Uint8Array.from(arr)); localStorage.setItem('rv-market-purchases-v1', JSON.stringify([{ asset: a.asset, title: '평문', txid: 'ee'.repeat(32), sellerRvn: '4', feeRvn: '1', at: '2026-10-13T00:00:00.000Z', manifestCid: a.cid, assetReceived: false }])); } }, 1); },
    arg: { pinned: [...plainPin.stored.entries()].map(([c, b]) => [c, Array.from(b)]), asset: 'RV.X.PLAIN_E2E', cid: plain.manifestCid } } });
  await p2.click('#market-open'); await p2.waitForFunction(() => document.querySelector('.mk-open-lock'));
  await p2.click('.mk-open-lock');
  await p2.waitForFunction(() => /이 상품은 암호화돼 있지 않아요\. 파일은 공개 IPFS 에서 주소를 아는 누구나 받을 수 있어요/.test(document.querySelector('#lk-b-say').textContent));
  assert.equal(await p2.$eval('#lk-b-request-box', e => e.hidden), true);
  await p2.close();
});

/* ═════════════ D. new screens at 390/1440 × light/dark ═════════════ */
for (const [width, theme] of [[390, 'light'], [390, 'dark'], [1440, 'light'], [1440, 'dark']]) {
  test(`new screens: seller panel + buyer panel + purchase list at ${width} ${theme} (contrast ≥ 4.5:1, no overflow, shot)`, { timeout: 200_000 }, async () => {
    const r = await product();
    const page = await openApp({ width, theme, extra: prep({ r, sellerHasKey: true, purchase: true }) });
    await page.click('#creator-open'); await page.waitForFunction(() => document.querySelector('#page-creator.on'));
    await page.click('#lk-s-toggle'); await page.click('#lk-s-restore-toggle');
    await page.waitForFunction(() => /열쇠: 이 컴퓨터에 있어요/.test(document.querySelector('#lk-s-key').textContent));
    await audit(page, '#lk-seller', `seller-panel-${width}-${theme}`);
    await page.evaluate(() => document.querySelector('#creator-back').click());
    await page.waitForFunction(() => document.querySelector('#page-games.on'));
    await page.click('#market-open'); await page.waitForFunction(() => document.querySelector('.mk-open-lock'));
    await audit(page, '#page-market', `market-purchases-${width}-${theme}`);
    await page.click('.mk-open-lock'); await page.waitForFunction(() => !document.querySelector('#lk-b-request-box').hidden);
    await page.click('#lk-b-make'); await page.waitForFunction(() => /^RVLQ1\./.test(document.querySelector('#lk-b-request').value));
    await audit(page, '#lk-buyer', `buyer-panel-${width}-${theme}`);
    await page.close();
  });
}
