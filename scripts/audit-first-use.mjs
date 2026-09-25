// RV3 — 처음 쓰는 사람 과제 12개를 데스크톱에서 돌려 잰다(누른 횟수 · 입력 칸 · 시간 · 막힌 곳 · 전문용어).
//
// 실제 앱처럼 앱 CSP 를 Tauri 식(style-src nonce)으로 씌우고, 사람처럼 **단추 한가운데를 마우스로**
// 누른다 — 다른 것이 덮고 있으면 누르지 못한 것으로 적는다(「가림」).
// 합성 화면만: Tauri·노드·지갑·네트워크 없음. 모든 invoke 는 가짜, 바깥 요청은 막는다. 진짜 RVN 없음.
// 복구 단어는 가짜 단어(시험용)만 쓰고, 그 화면은 캡처하지 않는다.
//
// 쓰는 법: node scripts/audit-first-use.mjs [dist] [이름]   → artifacts/claude-rv3-audit/<이름>.json · 캡처
import { createServer } from 'node:http';
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const root = fileURLToPath(new URL('../', import.meta.url));
const [distArg, nameArg] = process.argv.slice(2);
const dist = resolve(distArg || resolve(root, 'dist'));
const runName = nameArg || 'desktop';
const out = resolve(root, 'artifacts/claude-rv3-audit');
mkdirSync(out, { recursive: true });

const NONCE = 'rv3audit';
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

// 보통 사람이 모를 말. 화면에 보인 적이 있으면 과제마다 센다.
const JARGON = ['UTXO', '소각', '태워', '태웁', '주인 표', '거스름', '노드', '동기화', '블록', '지문', 'txid', '트랜잭션', '거래 ID', 'IPFS', '파일창고',
  '장부', '체인', '해시', 'SHA', 'RPC', 'xpub', '서명', '출력', '발행', '자산', '색인', '확인 수', 'prune', '재발행', '맞교환', '릴레이', '채굴', 'wallet.dat', '로마자'];

const FAKE_WORDS = ['apple', 'river', 'stone', 'cloud', 'tiger', 'lemon', 'piano', 'ocean', 'candle', 'forest', 'rocket', 'silver'];
const VALID_ADDR = 'RLFnbkSQ9LGSHhEEBcbAZGfK4tVDXmqzTR'.slice(0, 34);

function mockScript(state) {
  return `(() => {
    const S = ${JSON.stringify(state)};
    window.__S = S; S.calls = [];
    if (S.onboarded) localStorage.setItem('playx-onboarded', '1');
    localStorage.setItem('playx-raven-lang', 'ko');
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    window.__TAURI_INTERNALS__ = { transformCallback: (f) => f, metadata: {}, invoke: async (c, a) => {
      S.calls.push(c);
      switch (c) {
        case 'plugin:app|version': return '0.4.7';
        case 'mode_get': return S.mode ? { chosen: true, mode: S.mode } : { chosen: false };
        case 'mode_set': S.mode = (a && a.mode) || 'help'; return null;
        case 'inspect_machine': return { free_disk_gb: 200, laptop: true, ram_gb: 16, cores: 8 };
        case 'disk_now': return { chain_gb: 0 };
        case 'recommend_setup_for': return { conf: { prune: a && a.shopOnly ? null : 5000, dbcache: 300 }, disk_use_gb: a && a.shopOnly ? 47 : 6,
          irreversible: !(a && a.shopOnly), reasons: ['노트북으로 보여 공간을 아낍니다'], machine: { free_disk_gb: 200 }, ipfs_profile: 'lowpower' };
        case 'conf_read': return { values: {} };
        case 'apply_setup': case 'open_shop': return null;
        // 암호를 걸면 진짜 노드는 스스로 꺼진다 — 다시 켤 때까지 연결이 안 된다(0.4.8-A2 흐름이 이걸 기다린다).
        case 'node_status': if (S.nodeDown) throw 'Could not connect to the server (connection refused)'; return { blocks: 1000, headers: 1000, progress: 1, peers: 3 };
        case 'money_status': throw 'Synthetic status unavailable';
        case 'wallet_balance': return { confirmed: S.confirmed, unconfirmed: S.unconfirmed };
        case 'wallet_lock_state': if (S.nodeDown) throw 'Could not connect to the server (connection refused)'; return { encrypted: S.encrypted, unlocked: S.unlocked };
        case 'encrypt_wallet': S.encrypted = true; S.nodeDown = true; return { encrypted: true, node_stopped: true, sure: true };
        case 'services_start': S.nodeDown = false; S.started = (S.started || 0) + 1; return { started: [{ what: '노드' }], skipped: [] };
        case 'reveal_seed':
          if (!S.encrypted) throw '이 지갑에는 아직 암호가 없습니다. 「지갑」 화면에서 암호를 먼저 걸어 주세요 — 암호를 건 뒤 복구 단어를 볼 수 있습니다.';
          return { words: ${JSON.stringify(FAKE_WORDS)}, has_extra_passphrase: false };
        case 'new_address': S.addrN++; return 'RGz' + String(S.addrN).padStart(3, '0') + 'fakeAddrForAuditOnlyXyzAb';
        // 0.4.8-B 받기 — 안 받은 「받기」 주소가 있으면 그것, 없거나 새로 만들라면 새 주소(노드가 내 것이라 확인).
        //   진짜 주소처럼 base58 글자만(0·O·I·l 없음) — 화면이 주소 모양을 한 번 더 본다.
        case 'receive_address': if (!(a && a.fresh) && S.recv) return { address: S.recv, reused: true, mine: true };
          S.addrN++; S.recv = 'RGz' + String(S.addrN).padStart(3, '1') + 'fakeAddrForAuditXyzAbcdef'; return { address: S.recv, reused: false, mine: true };
        case 'receive_qr_save': return { path: a.path };
        case 'plugin:dialog|save': return null;
        // 0.4.8-B 수수료 — 노드가 읽기로 계산한 값(가짜). 서명·전파 없음.
        case 'send_fee': return { fee: 0.00226, amount: Number(a.amount), total: Math.round((Number(a.amount) + 0.00226) * 1e8) / 1e8, short: false };
        case 'wallet_since': return { lastblock: 'b' + S.block, transactions: S.txs, asset_transactions: [] };
        case 'recent_transactions': return S.txs;
        case 'addr_book': return { rows: [] };
        case 'owner_tokens_where': return { tokens: [] };
        case 'preview_send': return { valid: true, address: a.address, asset: a.asset || null, amount: Number(a.amount), enough: S.confirmed >= Number(a.amount), held: S.confirmed, is_mine: false, history: { known: false } };
        case 'send_rvn': case 'send_asset': S.sent++; return 'cd'.repeat(32);
        case 'list_assets': return S.assets;
        case 'pin_list': case 'my_channels': case 'create_fingerprints': return [];
        case 'cid_alive': return 'found';
        case 'api_key_status': return S.keys;
        case 'model_settings': return {};
        case 'artist_profile_get': return { name: '', about: '', picture: '', website: '' };
        case 'create_status': return { brands: S.brands, pending: S.pending, spendable: S.confirmed, locked: false };
        case 'create_names_taken': return a.names.map(() => false);
        case 'create_unresolved': return null;
        case 'create_history_list': return S.history;
        case 'create_history_get': return S.history.find((e) => e.id === a.id) || null;
        case 'create_history_begin': { const id = Math.random().toString(16).slice(2).padEnd(32, '0').slice(0, 32);
          S.history.push({ id, status: 'started', kind: a.entry.kind, title: a.entry.title, brand: a.entry.brand, count: a.entry.count, ...a.entry.details, names: [] }); return id; }
        case 'create_history_forget': return null;
        case 'create_photos_save': return 0;
        case 'create_certificate_preview': return '<!doctype html><html><body><section class="sheet">견본</section></body></html>';
        case 'certificate_font_css': return '';
        case 'certificate_marks': return { logo: null, stamp: null };
        case 'create_issue': { await wait(400); const e = S.history.find((x) => x.id === a.historyId);
          if (a.step === 'brand') { S.pending = [a.brand + '!']; S.brandTx = 'ef'.repeat(32); if (e) { e.status = 'brand-sent'; } return { txid: S.brandTx, owner_pinned: true }; }
          if (e) { e.status = 'done'; e.names = a.names; e.done_at = Math.floor(Date.now() / 1000); } S.issued++; return { txid: 'ab'.repeat(32), owner_pinned: true }; }
        case 'create_tx_state': S.brands = S.pending.length ? S.pending.map((b) => b.replace(/!$/, '')) : S.brands; S.pending = []; return { state: 'confirmed', confirmations: 1 };
        case 'create_resolve': return { state: 'sending' };
        case 'create_print': return { path: '/synthetic/print.html' };
        case 'qr_svg': return '<svg viewBox="0 0 10 10"><rect width="10" height="10"/></svg>';
        case 'plugin:opener|open_url': case 'open_external': S.opened.push(a.url || a); return null;
        case 'plugin:dialog|open': return '/synthetic/backup.zip.pxlock';
        // 0.4.9 12단어 되살리기 — 새 컴퓨터(지갑·장부 없음). 단어는 공개 BIP39 시험 벡터, 러스트 대신 같은지 한 번만 본다.
        case 'words_restore_preflight': return { running: false, brand_new: true, wallet_file: false, wallet: null, has_value: false, need_confirm: false, branch: 'new', blocked: null, state: null, busy: false, rescanning: false, shop: false };
        case 'words_restore_check': return a.words === S.vec ? { ok: true, count: 12, first: 'RXjfKKWn31FQPaLmjnS6nhEGmfmKNZNVTP', same_wallet: null, history: 'unknown' } : { ok: false, kind: 'checksum', message: '' };
        case 'words_restore_start': S.restored = a.words === S.vec; return { started: true };
        case 'words_restore_status': S.wn = (S.wn || 0) + 1; return S.wn < 2 ? { busy: true, state: { stage: 'creating' } }
          : { busy: false, state: { stage: 'done', branch: 'new', aside: null, result: { balance: 0, assets: 0, certs: 0, txcount: 0, encrypted: false } } };
        case 'words_restore_close': return { closed: true };
        case 'restore_survey': return { day: '2026-09-20', items: [{ key: 'wallet', what: '지갑', detail: '', why: '' }], empty: false, note: '' };
        case 'restore_apply': return { ok: true, status: 'complete', done: [{ what: '지갑' }], failed: [], note: '' };
        case 'backup_survey': return { items: [], automatic: null };
        case 'ai_chat': case 'ai_ask_owner': case 'ai_debate': if (!Object.keys(S.keys).length) throw 'AI 열쇠가 없습니다.'; return { answer: '견본 답' };
        default: return null;
      }
    } };
  })();`;
}

const baseState = () => ({ onboarded: true, mode: 'help', confirmed: 50, unconfirmed: 0, encrypted: false, unlocked: false, addrN: 0, block: 1, txs: [], assets: [],
  keys: {}, brands: ['HANBIT'], pending: [], history: [], sent: 0, issued: 0, opened: [] });

const results = [];
const browser = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });

async function task(id, name, state, fn) {
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.setViewport({ width: 1120, height: 780 });
  await page.setRequestInterception(true);
  page.on('request', (q) => (q.url().startsWith(origin + '/') || q.url().startsWith('data:') || q.url().startsWith('blob:') ? q.continue() : q.abort()));
  await page.evaluateOnNewDocument(mockScript(state));
  const r = { id, name, ok: false, clicks: 0, typed: 0, secs: 0, waitedSecs: 0, stuck: [], notes: [], jargon: {}, screens: 0 };
  const seen = new Set();
  const scan = async () => {
    const txt = await page.evaluate(() => document.body.innerText);
    r.screens++;
    for (const w of JARGON) if (txt.includes(w)) { if (!seen.has(w)) seen.add(w); r.jargon[w] = (r.jargon[w] || 0) + 1; }
  };
  // 🔴 복구 단어를 치는 과제(state.noShots)는 **막혀도 캡처하지 않는다** — 09-25 사고: 가져오기 화면 캡처에 단어가 찍혔다.
  const shot = async (label) => { if (state.noShots) return; await page.screenshot({ path: resolve(out, `${runName}-${id}-${label}.png`) }); };
  const ctx = {
    page, r,
    async tap(sel, label = sel) {
      const el = await page.waitForSelector(sel, { visible: true, timeout: 6000 }).catch(() => null);
      if (!el) { r.stuck.push(`${label}: 화면에 없음`); await shot(`stuck-${r.stuck.length}`); throw new Error(`없음 ${label}`); }
      await el.evaluate((e) => e.scrollIntoView({ block: 'center' }));
      const hit = await el.evaluate((e) => { const b = e.getBoundingClientRect(); const x = b.left + b.width / 2, y = b.top + b.height / 2;
        const h = document.elementFromPoint(x, y); return { ok: !!h && (h === e || e.contains(h)), x, y, by: h ? (h.id || h.className || h.tagName) : '' }; });
      if (!hit.ok) { r.stuck.push(`${label}: 다른 것(${String(hit.by).slice(0, 40)})이 덮고 있어 못 누름`); await shot(`stuck-${r.stuck.length}`); throw new Error(`가림 ${label}`); }
      await page.mouse.click(hit.x, hit.y);
      r.clicks++;
      await new Promise((res) => setTimeout(res, 350));
      await scan();
    },
    async type(sel, text, label = sel) {
      const el = await page.waitForSelector(sel, { visible: true, timeout: 6000 }).catch(() => null);
      if (!el) { r.stuck.push(`${label}: 입력 칸이 안 보임`); throw new Error(`없음 ${label}`); }
      await el.click({ clickCount: 3 }); await el.type(text); r.typed++;
    },
    async wait(ms, why) { r.waitedSecs += ms / 1000; if (why) r.notes.push(`기다림 ${Math.round(ms / 100) / 10}초 — ${why}`); await new Promise((res) => setTimeout(res, ms)); },
    visible: (sel) => page.$eval(sel, (e) => !!e && e.getClientRects().length > 0 && getComputedStyle(e).visibility !== 'hidden').catch(() => false),
    text: (sel) => page.$eval(sel, (e) => e.innerText).catch(() => ''),
    has: async (re) => re.test(await page.evaluate(() => document.body.innerText)),
    S: () => page.evaluate(() => window.__S),
    note: (s) => r.notes.push(s), shot,
  };
  const t0 = Date.now();
  try {
    await page.goto(origin + '/', { waitUntil: 'networkidle0' });
    await new Promise((res) => setTimeout(res, 700));
    await scan();
    r.ok = await fn(ctx);
  } catch (e) {
    if (!r.stuck.length) r.stuck.push(String(e.message || e).slice(0, 160));
  }
  r.secs = Math.round((Date.now() - t0) / 100) / 10;
  r.jargonTerms = [...seen];
  r.errors = errors.slice(0, 5);
  results.push(r);
  console.log(`${id} ${r.ok ? '성공' : '실패'} · 누름 ${r.clicks} · 입력 ${r.typed} · ${r.secs}초(그중 기다림 ${r.waitedSecs}) · 막힘 ${r.stuck.length} · 용어 ${r.jargonTerms.join(',')}`);
  await context.close();
}

try {
  // 1) 지갑 만들기 — 처음 켠 컴퓨터(첫 안내 전 · 모드 안 고름).
  await task('T01', '지갑 만들기', { ...baseState(), onboarded: false, mode: null, confirmed: 0 }, async (x) => {
    x.note(`첫 화면 선택지: ${(await x.text('#hello')).replace(/\s+/g, ' ').slice(0, 160)}`);
    x.note(`「지갑」이라는 선택지: ${(await x.has(/지갑으로 쓸|지갑 만들기|새 지갑/)) ? '있음' : '없음'}`);
    // 0.4.8-A1: 지갑을 만들려는 사람은 「지갑으로 쓸래요」를 누른다. 그 단추가 없는 판(0.4.7)은 예전처럼 「돕기」.
    if (await x.visible('#hello-wallet')) await x.tap('#hello-wallet', '지갑으로 쓸래요');
    else await x.tap('#hello-help', '레이븐코인을 돕고 싶어요');
    await x.wait(1800, '「살펴보는 중」 1.4초');
    await x.tap('#ob-also', '다른 일도 합니다');
    await x.wait(600);
    await x.type('#ob-confirm', '오래된 것만 남김', '되돌릴 수 없는 문장 입력');
    await x.tap('#ob-apply', '이대로 켜기');
    await x.wait(800);
    await x.shot('after-setup');
    const page = await x.page.evaluate(() => document.querySelector('.page.on')?.id || '');
    x.note(`설정 뒤 떨어진 화면: ${page}`);
    x.note(`「지갑이 생겼다」는 말: ${(await x.has(/지갑이 (생겼|만들어졌|준비)/)) ? '있음' : '없음'}`);
    // 이미 지갑 화면이면 사람은 메뉴를 또 누르지 않는다(같은 규칙: 안 보이면 누른다).
    if (page !== 'page-wallet') await x.tap('nav a[data-page="wallet"]', '지갑 메뉴');
    x.note(`왼쪽 메뉴 맨 위: ${await x.page.$eval('nav a[data-page]', (a) => a.dataset.page).catch(() => '?')}`);
    x.note(`지갑 화면 잔액 칸: ${(await x.text('#w-confirmed')).trim()}`);
    return true;
  });

  // 2) 복구 단어 백업 — 암호 안 건 새 지갑.
  await task('T02', '복구 단어 백업', baseState(), async (x) => {
    await x.tap('nav a[data-page="settings"]', '이 컴퓨터');
    const tiles = await x.page.$$eval('#pt-settings [data-pt]', (b) => b.map((e) => e.innerText.replace(/\s+/g, ' ')));
    const i = tiles.findIndex((s) => /백업/.test(s));
    x.note(`「이 컴퓨터」 첫 줄 칸: ${tiles.join(' / ')}`);
    await x.tap(`#pt-settings [data-pt="${i}"]`, '백업 칸');
    await x.tap('#bk-seed', '복구 단어 보기');
    if (await x.page.waitForSelector('#sdw-body [data-step], #sdw-body:not(:empty)', { visible: true, timeout: 3000 }).catch(() => null)) {
      // 0.4.8-A2: 한 창에서 ① 암호 만들기 → 노드 다시 켜기 → ② 단어 보기 → ③ 2·6·10번째 확인.
      await x.page.waitForFunction(() => ['lock', 'reveal'].includes(document.getElementById('sdw-body')?.dataset.step || '') && !!document.querySelector('#sdw-new, #sdw-pass'), { timeout: 6000 });
      if (await x.visible('#sdw-new')) {
        x.note(`암호 만들기 안내: ${(await x.text('#sdw-body')).replace(/\s+/g, ' ').slice(0, 200)}`);
        await x.type('#sdw-new', 'Correct-Horse-9', '새 암호');
        await x.type('#sdw-new2', 'Correct-Horse-9', '새 암호 다시');
        await x.type('#sdw-confirm', (await x.text('#sdw-body pre.conf')).trim(), '문장 입력');
        await x.tap('#sdw-lock-go', '암호 걸고 계속');
        const t0 = Date.now();
        await x.page.waitForSelector('#sdw-pass', { visible: true, timeout: 30000 }).catch(() => null);
        x.r.waitedSecs += Math.round((Date.now() - t0) / 100) / 10;
        x.note(`노드 다시 켜기 기다림 ${Math.round((Date.now() - t0) / 100) / 10}초 — 가짜 노드는 곧바로(실제 1~2분) · 저절로 다음 단계: ${(await x.visible('#sdw-pass')) ? '예' : '아니오'} · services_start ${(await x.S()).started || 0}번`);
      }
      await x.type('#sdw-pass', 'Correct-Horse-9', '지갑 암호');
      await x.tap('#sdw-show', '단어 보기');
      // 가짜 단어라도 단어가 보이는 화면은 캡처하지 않는다.
      await x.tap('#sdw-written', '다 적었어요');
      const asked = await x.page.$$eval('[data-sdw-at]', (es) => es.map((e) => Number(e.dataset.sdwAt)));
      x.note(`확인 질문(몇 번째 단어 등): ${asked.length ? `있음 — ${asked.join('·')}번째` : '없음'}`);
      // 적어 둔 종이를 보고 답한다 — 이 시험에서는 가짜 단어 목록이 그 종이다.
      for (const n of asked) await x.type(`[data-sdw-at="${n}"]`, FAKE_WORDS[n - 1], `${n}번째 단어`);
      await x.tap('#sdw-check', '확인');
      const done = await x.has(/적어 두셨어요/);
      x.note(`끝: ${done ? '「적어 두셨어요」' : '확인 실패'} · 남긴 것: ${await x.page.evaluate(() => localStorage.getItem('rv-seed-checked') || '(없음)')}`);
      await x.tap('#sdw-done', '닫기');
      await x.tap('nav a[data-page="wallet"]', '지갑 메뉴(알림 줄이 사라졌나 보기)');
      x.note(`지갑 화면 「복구 단어를 아직 확인하지 않으셨어요」: ${(await x.visible('#w-seednote')) ? '남아 있음' : '사라짐'}`);
      x.r.clicks--; // 위 지갑 메뉴는 확인하려고 누른 것 — 과제 누름에서 뺀다.
      return done;
    }
    // 0.4.7 까지의 옛 흐름(비교용으로 그대로 둔다).
    await x.type('#ask-input', 'nopassword', '지갑 암호(없는데 물음)');
    await x.tap('#ask-yes', '확인');
    const msg = (await x.text('#bk-result')).trim();
    x.note(`첫 시도 결과: ${msg.slice(0, 90)}`);
    if (/암호가 없습니다/.test(msg)) x.r.stuck.push('복구 단어 보기 → 「암호를 먼저 걸어 주세요」 — 지갑 화면으로 돌아가야 함');
    await x.tap('nav a[data-page="wallet"]', '지갑 메뉴');
    await x.tap('#w-enc', '암호 걸기');
    await x.type('#enc-new', 'Correct-Horse-9', '새 암호');
    await x.type('#enc-new2', 'Correct-Horse-9', '새 암호 다시');
    await x.type('#enc-confirm', await x.text('#enc-phrase'), '문장 입력');
    x.note(`암호 걸기 안내: ${(await x.text('#encbox')).replace(/\s+/g, ' ').slice(0, 200)}`);
    await x.tap('#enc-go', '암호 걸기 실행');
    await x.wait(600);
    await x.page.evaluate(() => { window.__S.nodeDown = false; }); // 옛 흐름: 사람이 노드를 따로 다시 켰다고 친다
    await x.tap('nav a[data-page="settings"]', '이 컴퓨터');
    await x.tap(`#pt-settings [data-pt="${i}"]`, '백업 칸');
    await x.tap('#bk-seed', '복구 단어 보기');
    await x.type('#ask-input', 'Correct-Horse-9', '지갑 암호');
    await x.tap('#ask-yes', '확인');
    const shown = await x.visible('#seedsheet');
    x.note(`확인 질문(몇 번째 단어 등): ${(await x.has(/번째 단어|확인 문제|맞춰/)) ? '있음' : '없음'}`);
    // 가짜 단어라도 캡처하지 않는다.
    await x.tap('#sd-close', '닫기');
    return shown;
  });

  // 3) 친구에게 내 주소 보내기.
  //    0.4.8-B — 지갑 화면의 큰 「받기」가 바로 주소를 보여 준다(옛 판은 「받을 주소 만들기」를 또 눌렀다).
  //    옛 dist 에서도 돌도록 「받기」가 없으면 옛 길로 간다.
  await task('T03', '내 주소를 친구에게', baseState(), async (x) => {
    const first = await x.page.evaluate(() => document.querySelector('.page.on')?.id || '');
    x.note(`켠 뒤 첫 화면: ${first} · 첫 화면에 「받기」: ${(await x.visible('#overview-receive')) ? '있음' : '없음'}`);
    if (await x.visible('#overview-receive')) await x.tap('#overview-receive', '첫 화면 받기');
    else {
      await x.tap('nav a[data-page="wallet"]', '지갑 메뉴');
      if (await x.page.$('#w-receive')) await x.tap('#w-receive', '지갑 받기');
    }
    const addrBefore = await x.has(/RGz\d{3}/);
    x.note(`「받기」 누른 직후 주소가 보임: ${addrBefore ? '예' : '아니오 — 주소 만들기 단추를 또 눌러야 함'}`);
    if (!addrBefore) await x.tap('#w-newaddr', '받을 주소 만들기');
    // 「주소 옆」 = 복사 단추가 든 **같은 카드**(없으면 바로 위 칸). 0.4.8-B 는 QR 이 카드 왼쪽, 단추가 오른쪽 줄에 있다.
    const box = await x.page.evaluate(() => { const b = document.getElementById('w-copy'); const c = b?.closest('.card') || b?.closest('div'); return c ? { qr: !!c.querySelector('svg rect, canvas, img[src*="qr"], .qr'), text: c.innerText.slice(0, 120) } : null; });
    x.note(`주소 옆 QR: ${box?.qr ? '있음' : '없음'} · 공유 단추: ${(await x.has(/공유/)) ? '있음' : '없음'} · 메시지로 복사: ${(await x.page.$('#w-copymsg')) ? '있음' : '없음'} · QR 그림 저장: ${(await x.page.$('#w-qrsave')) ? '있음' : '없음'}`);
    await x.shot('address');
    const a1 = ((await x.text('#w-addr')).match(/RGz\d{3}\w+/) || [''])[0];
    await x.tap('#w-copy', '복사');
    if (await x.page.$('#w-receive')) {
      // 친구에게 준 주소가 다시 들어와도 그대로인가 — 아직 받은 적 없는 주소면 다시 쓴다.
      await x.tap('#w-receive', '받기(한 번 더)');
      const a2 = ((await x.text('#w-addr')).match(/RGz\d{3}\w+/) || [''])[0];
      x.note(`다시 「받기」: ${a1 && a1 === a2 ? '같은 주소(아직 안 받은 주소를 다시 씀)' : `주소가 바뀜 ${a1} → ${a2}`} · 새 주소는 「새 주소 만들기」를 따로 누를 때만`);
    } else {
      await x.tap('#w-newaddr', '받을 주소 만들기(한 번 더)');
      x.note(`다시 누르면 새 주소: ${(await x.has(/RGz002/)) ? '예(주소가 바뀜)' : '아니오'}`);
    }
    return true;
  });

  // 4) 받은 RVN 확인 — 켜 둔 채 10 RVN 이 들어온다(아직 확정 전).
  await task('T04', '받은 RVN 확인', { ...baseState(), confirmed: 0 }, async (x) => {
    await x.wait(1500);
    await x.page.evaluate(() => { const S = window.__S; S.block++; S.unconfirmed = 10; S.txs = [{ category: 'receive', amount: 10, confirmations: 0, time: Math.floor(Date.now() / 1000), txid: 'aa'.repeat(32), address: 'RGz001' }]; });
    await x.wait(16500, '지갑 살피기는 15초마다');
    const note = (await x.text('#live-note')).trim();
    x.note(`알림 띠: ${note || '(없음)'} · 소리/OS 알림: 앱 안 띠만`);
    x.note(`첫 화면 잔액: ${(await x.text('#overview-balance')).replace(/\s+/g, ' ').slice(0, 60)} · 들어오는 중: ${(await x.page.$eval('#overview-incoming-row', (e) => !e.hidden).catch(() => false)) ? (await x.page.$eval('#overview-incoming', (e) => e.textContent.trim())) : '(없음)'}`);
    await x.shot('toast');
    await x.tap('nav a[data-page="wallet"]', '지갑 메뉴');
    x.note(`지갑 화면: 사용 가능 ${(await x.text('#w-confirmed')).trim()} · ${(await x.text('#w-unconfirmed')).trim()}`);
    return !!note;
  });

  // 5) 보내기.
  await task('T05', 'RVN 보내기', baseState(), async (x) => {
    await x.tap('nav a[data-page="wallet"]', '지갑 메뉴');
    await x.tap('#w-send-rvn', 'RVN 보내기');
    const compose = await x.text('#send-compose');
    x.note(`QR로 주소 읽기: ${/QR|카메라/.test(compose) ? '있음' : '없음'} · 주소록·최근 보낸 사람에서 고르기: ${/주소록|최근|친구|고르기/.test(compose) ? '있음' : '없음'} · 「전부 보내기」: ${/전부|모두/.test(compose) ? '있음' : '없음'}`);
    await x.type('#s-addr', 'RDtestFriendAddressForAudit0000001', '받는 주소');
    await x.type('#s-qty', '1', '금액');
    await x.tap('#s-review', '검토');
    const review = (await x.text('#send-review')).replace(/\s+/g, ' ');
    x.note(`검토 화면에 수수료: ${/수수료/.test(review) ? '있음' : '없음'} · 원화: ${/원|₩|KRW/.test(review) ? '있음' : '없음'}`);
    if (await x.page.$('#r-fee')) x.note(`수수료 줄: ${(await x.text('#r-fee')).trim()} · 합계: ${(await x.text('#r-total')).trim()} · 보내기 전 send_rvn 부름: ${(await x.S()).calls.includes('send_rvn') ? '있음(!)' : '없음'}`);
    await x.shot('review');
    await x.tap('#s-go', '보내기');
    await x.wait(500);
    x.note(`8초 취소 창: ${(await x.S()).calls.includes('send_rvn') && !(await x.page.$('.holdbox')) ? '없음(바로 보냄)' : '있음'}`);
    x.note(`결과: ${(await x.text('#s-result')).replace(/\s+/g, ' ').slice(0, 120)}`);
    return (await x.S()).sent === 1;
  });

  // 6) 받은 자산·증서 보기.
  await task('T06', '받은 증서 보기', { ...baseState(), assets: [{ name: 'HANBIT#SURYO260924-1', amount: 1, ipfs_hash: null, mine: false, root: 'HANBIT', units: 0, reissuable: false }] }, async (x) => {
    await x.tap('nav a[data-page="assets"]', '자산 메뉴');
    await x.tap('[data-afilter="got"]', '받은 것');
    await x.tap('tr[data-row="HANBIT#SURYO260924-1"]', '증서 줄');
    const panel = (await x.text('#panel')).replace(/\s+/g, ' ');
    x.note(`패널에 사람이 읽을 제목·발급자: ${/수료|필라테스|발급/.test(panel) ? '있음' : '없음 — 체인 이름만'}`);
    x.note(`진짜인지 확인 단추: ${(await x.visible('#p-verify')) ? '있음' : '없음(파일 없는 증서)'}`);
    await x.shot('panel');
    return true;
  });

  // 7) 증서 한 장 — 처음 쓰는 이름(이름 등록부터).
  await task('T07', '증서 한 장(처음)', { ...baseState(), brands: [], confirmed: 600 }, async (x) => {
    await x.tap('nav a[data-page="assets"]', '자산 메뉴');
    await x.tap('#pt-assets [data-pt="0"]', '만들기 칸');
    await x.tap('#cr-kinds [data-kind="certificate"]', '증명서');
    await x.type('#cr-title', '필라테스 지도자 과정', '제목');
    await x.type('#cr-recipients', '김하늘', '받는 사람');
    await x.type('#cr-maker', '한빛 필라테스', '만드는 사람');
    await x.tap('#cr-check', '확인하기');
    x.note(`확인 화면: ${(await x.text('#cr-review')).replace(/\s+/g, ' ').slice(0, 220)}`);
    if (await x.visible('#cr-brand-confirm')) await x.type('#cr-brand-confirm', await x.page.$eval('#cr-review', (e) => (e.innerText.match(/[A-Z0-9]{3,}/) || [''])[0]), '이름 다시 입력');
    await x.tap('#cr-make', '이름 등록하고 만들기');
    await x.wait(9500, '8초 취소 창');
    await x.page.waitForFunction(() => /마저 만들기|기록 완료/.test(document.getElementById('cr-wait')?.innerText || ''), { timeout: 45000 });
    x.r.waitedSecs += 20; x.note('기다림 — 이름 등록 기록(실제 1~10분, 가짜 노드는 곧바로)');
    const go = await x.page.evaluateHandle(() => [...document.querySelectorAll('#cr-wait button')].find((b) => /마저 만들기/.test(b.innerText) && !b.hidden));
    await go.evaluate((b) => { b.id = 'rv3-goon'; });
    await x.tap('#rv3-goon', '마저 만들기');
    await x.wait(9500, '8초 취소 창(두 번째)');
    await x.page.waitForFunction(() => /만들었어요/.test(document.getElementById('cr-done')?.innerText || ''), { timeout: 20000 });
    await x.shot('done');
    return (await x.S()).issued === 1;
  });

  // 9) 진짜인지 확인 — 받은 증서에서.
  await task('T09', '증서 진짜인지 확인', { ...baseState(), assets: [{ name: 'HANBIT#SURYO260924-1', amount: 1, ipfs_hash: null, mine: false, root: 'HANBIT', units: 0, reissuable: false }] }, async (x) => {
    x.note(`앱 안에 「남의 증서 확인」 입력 칸: ${(await x.page.$('#verify-in, [data-verify-input]')) ? '있음' : '없음'}`);
    await x.tap('nav a[data-page="assets"]', '자산 메뉴');
    await x.tap('[data-afilter="got"]', '받은 것');
    await x.tap('tr[data-row="HANBIT#SURYO260924-1"]', '증서 줄');
    if (!(await x.visible('#p-verify'))) { x.r.stuck.push('파일 없이 만든 증서는 확인 단추가 없음'); return false; }
    await x.tap('#p-verify', '확인 페이지');
    return (await x.S()).opened.length > 0;
  });

  // 10) 다른 컴퓨터에서 되살리기 — 12단어만 적어 둔 사람. 0.4.9: 첫 질문의 「전에 쓰던 지갑이 있어요 → 복구 단어 12개로」.
  //     단어는 공개 BIP39 시험 벡터(Trezor)만. 🔴 이 과제는 캡처하지 않는다(noShots) — 막혀도.
  const T10_VEC = 'legal winner thank year wave sausage worth useful legal winner thank yellow';
  await task('T10', '다른 기기에서 복구', { ...baseState(), onboarded: false, mode: null, confirmed: 0, vec: T10_VEC, noShots: true }, async (x) => {
    x.note(`첫 화면에 「복구 단어로 되살리기」: ${(await x.has(/복구 단어 12개로|12단어로 (되살|복구)/)) ? '있음' : '없음'}`);
    await x.tap('#hello-restore-words', '전에 쓰던 지갑이 있어요 → 복구 단어 12개로');
    await x.tap('#wrs-go', '단어 넣기');
    const words = T10_VEC.split(' ');
    // 사람처럼 칸마다 친다(스페이스로 다음 칸) — 첫 칸만 누르고 나머지는 이어서.
    await x.tap('[data-wrs-at="1"]', '첫 칸');
    for (const w of words) { await x.page.keyboard.type(w); await x.page.keyboard.press('Space'); }
    x.r.typed += words.length;
    await x.tap('#wrs-check', '확인');
    await x.tap('#wrs-start', '되살리기 시작');
    await x.page.waitForFunction(() => /되살렸습니다/.test(document.getElementById('wrs-body')?.innerText || ''), { timeout: 15000 });
    const left = await x.page.evaluate((w) => [...document.querySelectorAll('input')].some((i) => i.value.includes(w)) || document.body.innerHTML.includes(w), 'sausage');
    x.note(`시작 뒤 화면·칸에 단어 남음: ${left ? '예(!)' : '아니오'} · 끝 화면 지갑 암호 권함: ${(await x.has(/지갑 암호 걸기/)) ? '있음' : '없음'}`);
    await x.tap('#wrs-finish', '닫기');
    const S = await x.S();
    if (!S.restored) x.r.stuck.push('넣은 단어가 되살리기에 그대로 가지 않음');
    if (left) x.r.stuck.push('시작 뒤에도 단어가 화면에 남음');
    return !!S.restored && !left;
  });

  // 11) 라비에게 묻기 — AI 열쇠 없는 처음 상태.
  //    0.4.8-B — 판정은 **마지막 라비 말풍선**으로 한다. 화면 어딘가에 「열쇠」라는 글자가 있는지가 아니라
  //    (열쇠 넣는 단추는 늘 있다), 물은 것에 답했는지 · 답 대신 열쇠만 요구했는지.
  await task('T11', '라비에게 질문', baseState(), async (x) => {
    if (!(await x.visible('#chat-q'))) await x.tap('nav a[data-page="ravi"]', '라비 메뉴');
    x.note(`기본 모드: ${(await x.page.$eval('[data-mode].on, [data-mode][aria-pressed="true"]', (e) => e.innerText).catch(() => '?'))}`);
    await x.type('#chat-q', '보낼 때 수수료가 얼마예요?', '질문');
    await x.tap('#chat-go', '보내기');
    await x.wait(1500);
    const last = (await x.page.evaluate(() => [...document.querySelectorAll('#chat-log .msg.ai')].pop()?.innerText || '')).replace(/\s+/g, ' ');
    const answered = /수수료/.test(last) && /RVN|노드/.test(last) && !/없는 질문/.test(last);
    const keyOnly = !answered && /열쇠|API|키를/.test(last);
    x.note(`라비 답: ${last.slice(0, 140)}`);
    x.note(`답 대신 열쇠 요구: ${keyOnly ? '예' : '아니오'} · 「AI 아님」 표시: ${/AI 아님/.test(last) ? '있음' : '없음'} · 열쇠 넣는 곳(라비 화면 안): ${(await x.page.$('#ravi-keyopen, .keyask input')) ? '있음' : '없음'}`);
    await x.shot('answer');
    if (!answered) x.r.stuck.push(keyOnly ? 'AI 열쇠(유료 계정·가입)가 없으면 질문에 답을 못 받음' : '질문에 대한 답이 없음');
    return answered;
  });

  // 12) 보내기 직전 그만두기.
  await task('T12', '보내기 전 그만두기', baseState(), async (x) => {
    await x.tap('nav a[data-page="wallet"]', '지갑 메뉴');
    await x.tap('#w-send-rvn', 'RVN 보내기');
    await x.type('#s-addr', 'RDtestFriendAddressForAudit0000001', '받는 주소');
    await x.type('#s-qty', '1', '금액');
    await x.tap('#s-review', '검토');
    x.note(`검토 화면의 그만두는 단추: ${(await x.text('#send-review .sendhead')).replace(/\s+/g, ' ')} — 「취소」는 앞 화면에만`);
    await x.tap('#s-back', '고치기');
    await x.tap('#s-cancel', '취소');
    const S = await x.S();
    x.note(`취소 뒤 보내짐: ${S.sent ? '예(!)' : '아니오'} · 보낸 뒤 되돌리기: 없음(체인은 되돌리지 않음 — 화면이 그렇게 말함)`);
    return S.sent === 0;
  });
} finally {
  await browser.close();
  server.close();
}
writeFileSync(resolve(out, `${runName}.json`), JSON.stringify({ dist, csp: true, results }, null, 1));
