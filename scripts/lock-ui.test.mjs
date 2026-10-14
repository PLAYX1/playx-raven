// RV-LOCK v1 desktop wiring (node, no Chrome, no network, throwaway keys): product key lifecycle, preview-clip split, publish with the locked input,
// copy words, Rust command registration / locked-window deny list. DOM flows are in scripts/lock-ui-browser.test.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { build } from 'esbuild';

async function moduleAt(path) {
  const built = await build({ entryPoints: [path], bundle: true, write: false, platform: 'node', format: 'cjs', logLevel: 'silent' });
  const mod = { exports: {} };
  new Function('require', 'exports', 'module', built.outputFiles[0].text)(createRequire(import.meta.url), mod.exports, mod);
  return mod.exports;
}
const ui = await moduleAt('src/lock-ui.ts');
const core = await moduleAt('scripts/fixtures/lock-entry.ts');
// 매니페스트 조립은 시험 고정물 legacyManifestForTest(옛 RV. 이름 재현 — 체인에 아무것도 안 함)로 한다. 새 발행(publishContent)은 옛 이름을 막고, 화면의 올리기는 잠겨 있다(src/creator-pause.ts).
const enc = s => new TextEncoder().encode(s);
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 73, 72, 68, 82]);
const MP3 = n => { const b = Uint8Array.from({ length: n }, (_, i) => (i * 29 + 11) & 255); b.set([0x49, 0x44, 0x33, 3, 0, 0, 0, 0, 0, 0, 0xff, 0xfb]); return b; };
const WAV = n => { const b = Uint8Array.from({ length: n }, (_, i) => (i * 13 + 5) & 255); b.set(enc('RIFF')); b.set(enc('WAVE'), 8); new DataView(b.buffer).setUint32(28, 16000, true); new DataView(b.buffer).setUint32(40, 32000, true); return b; };
const PDF = s => enc(`%PDF-1.7\n${s}\n%%EOF`);
const KEY = core.randomKey(); const ADDRESS = core.addressOf(KEY); const RECEIVING = 'RCJPGkCQi5NpBgtj8qkjGcSugfWRa3iQiS';
const sign = async (_a, m) => core.signMessageForTest(m, KEY);
const NOW = new Date('2026-10-13T00:00:00.000Z');

/** Rust 열쇠 보관을 흉내 낸다: 같은 이름에 다른 값은 거절(EXISTS). */
function fakeInvoke(opts = {}) {
  const secrets = new Map(); const calls = [];
  const invoke = async (cmd, args) => {
    calls.push(cmd);
    if (cmd === 'lock_secret_get') return { hex: secrets.get(args.name) ?? null };
    if (cmd === 'lock_secret_put') {
      if (opts.failPut) throw new Error('디스크가 가득 찼어요');
      if (secrets.has(args.name) && secrets.get(args.name) !== args.hex) throw new Error('EXISTS:덮어쓰지 않았어요');
      secrets.set(args.name, args.hex); return { ok: true };
    }
    if (cmd === 'lock_key_export') return { path: args.dest + '/k.pxlock', verified: opts.unverified ? false : true };
    throw new Error('unexpected ' + cmd);
  };
  return { invoke, secrets, calls };
}
const music = (over = {}) => ({ type: 'music', asset: 'RV.M.LOCK_UI', title: '노래', description: '', priceAtoms: '2000000000',
  files: [{ path: 'song.mp3', bytes: MP3(150_000), mime: 'audio/mpeg' }, { path: 'cover.png', bytes: PNG, mime: 'image/png', role: 'cover' }],
  creatorAddress: ADDRESS, receivingAddress: RECEIVING, details: { previewFile: 'song.mp3', previewStartMs: 5000, previewEndMs: 35000 }, now: NOW, ...over });

test('상품 열쇠: 처음엔 만들어 이 컴퓨터에 저장하고, 다시 부르면 같은 열쇠 · 저장이 안 되면 올리지 않는다', async () => {
  const f = fakeInvoke();
  const k1 = await ui.ensureProductKey(f.invoke, 'RV.M.A');
  assert.equal(k1.length, 32); assert.equal(f.secrets.size, 1);
  const k2 = await ui.ensureProductKey(f.invoke, 'RV.M.A');
  assert.equal(Buffer.from(k1).toString('hex'), Buffer.from(k2).toString('hex'));
  const k3 = await ui.ensureProductKey(f.invoke, 'RV.M.B');
  assert.notEqual(Buffer.from(k1).toString('hex'), Buffer.from(k3).toString('hex'));
  await assert.rejects(() => ui.ensureProductKey(fakeInvoke({ failPut: true }).invoke, 'RV.M.C'), /디스크/);
});

test('음악: 고른 구간을 별도 클립으로 · 못 자르면 미리듣기를 끈다 (곡 전체를 「미리듣기」로 올리지 않는다)', async () => {
  const f = fakeInvoke();
  const clip = WAV(64_000);
  const prep = await ui.lockedInputFor(f.invoke, music(), { makeClip: async (bytes, mime, s, e) => { assert.deepEqual([mime, s, e], ['audio/mpeg', 5000, 35000]); return clip; } });
  assert.equal(prep.previewOff, false);
  assert.equal(prep.input.lock.previewClip.path, 'preview-clip.wav');
  assert.deepEqual(prep.input.details, { previewFile: 'preview-clip.wav', previewStartMs: 0, previewEndMs: 2000 });
  assert(prep.input.files.some(x => x.path === 'song.mp3'), 'the full track stays in the encrypted set');
  const pin = new core.MockPinAdapter();
  const r = await core.legacyManifestForTest(prep.input, pin, sign);
  assert.equal(r.manifest.lock.files.length, 1); assert.equal(r.manifest.lock.files[0].path, 'song.mp3');
  const stored = [...pin.stored.values()];
  const full = Buffer.from(music().files[0].bytes);
  assert(!stored.some(b => Buffer.from(b).includes(full.subarray(1000, 1064))), 'full track plaintext was pinned');
  assert(stored.some(b => Buffer.from(b).equals(Buffer.from(clip))), 'the clip is pinned in the clear');
  // 못 자름 → 끔
  const off = await ui.lockedInputFor(fakeInvoke().invoke, music(), { makeClip: async () => null });
  assert.equal(off.previewOff, true); assert.equal(off.notes[0], ui.LOCK_COPY.noClip);
  assert.deepEqual(off.input.details, { previewFile: null, previewStartMs: null, previewEndMs: null }); assert.equal(off.input.lock.previewClip, null);
  const r2 = await core.legacyManifestForTest(off.input, new core.MockPinAdapter(), sign);
  assert.equal(r2.manifest.details.previewFile, null); assert.equal(r2.manifest.files.filter(x => x.mime.startsWith('audio')).length, 1);
  // 미리듣기를 아예 안 고른 경우도 끔
  const none = await ui.lockedInputFor(fakeInvoke().invoke, music({ details: { previewFile: null, previewStartMs: null, previewEndMs: null } }), { makeClip: async () => { throw new Error('must not be called'); } });
  assert.equal(none.previewOff, true); assert.deepEqual(none.notes, []);
  // 이 컴퓨터가 소리를 못 읽는 환경(AudioContext 없음)이면 기본 클립 만들기도 null
  assert.equal(await ui.webAudioClip(MP3(1000), 'audio/mpeg', 0, 30000), null);
  assert.equal(await ui.webAudioClip(new Uint8Array(ui.MAX_DECODE_BYTES + 1), 'audio/mpeg', 0, 30000), null);
});

test('책·디지털: 미리보기 PDF 는 암호화에서 빼 클립으로, 책 파일은 암호화 · 디지털은 전부 암호화', async () => {
  const book = { type: 'book', asset: 'RV.B.LOCK_UI', title: '책', description: '', priceAtoms: '1000000000', creatorAddress: ADDRESS, receivingAddress: RECEIVING, now: NOW,
    files: [{ path: 'sea.pdf', bytes: PDF('full '.repeat(500)), mime: 'application/pdf' }, { path: 'sea-preview.pdf', bytes: PDF('preview'), mime: 'application/pdf' }],
    details: { bookFile: 'sea.pdf', format: 'pdf', previewFile: 'sea-preview.pdf', previewPages: 5, pageCount: 80 } };
  const p = await ui.lockedInputFor(fakeInvoke().invoke, book);
  assert.equal(p.input.lock.previewClip.path, 'sea-preview.pdf'); assert.deepEqual(p.input.files.map(f => f.path), ['sea.pdf']);
  const r = await core.legacyManifestForTest(p.input, new core.MockPinAdapter(), sign);
  assert.deepEqual(r.manifest.lock.files.map(f => f.path), ['sea.pdf']); assert.equal(r.manifest.details.previewFile, 'sea-preview.pdf');
  const noPv = await ui.lockedInputFor(fakeInvoke().invoke, { ...book, details: { ...book.details, previewFile: null, previewPages: 0 }, files: [book.files[0]] });
  const r2 = await core.legacyManifestForTest(noPv.input, new core.MockPinAdapter(), sign);
  assert.equal(r2.manifest.details.previewFile, null);
  const digital = { type: 'digital', asset: 'RV.X.LOCK_UI', title: '그림', description: '', priceAtoms: null, creatorAddress: ADDRESS, receivingAddress: RECEIVING, now: NOW,
    files: [{ path: 'a.png', bytes: PNG, mime: 'image/png' }, { path: 'b.pdf', bytes: PDF('x'), mime: 'application/pdf' }], details: { label: '모음' } };
  const d = await ui.lockedInputFor(fakeInvoke().invoke, digital);
  const rd = await core.legacyManifestForTest(d.input, new core.MockPinAdapter(), sign);
  assert.deepEqual(rd.manifest.lock.files.map(f => f.path).sort(), ['a.png', 'b.pdf']);
  assert.equal(ui.lockableType('game'), false); assert.equal(ui.lockableType('ticket'), false); assert.equal(ui.lockableType('music'), true);
});

test('열쇠 파일 저장: 확인(verified)이 오지 않으면 저장으로 치지 않는다 · 백업 표시는 공개 정보만', async () => {
  const f = fakeInvoke();
  assert.equal((await ui.saveKeyFile(f.invoke, 'RV.M.A', '/x')).path, '/x/k.pxlock');
  await assert.rejects(() => ui.saveKeyFile(fakeInvoke({ unverified: true }).invoke, 'RV.M.A', '/x'), /확인하지 못/);
  const mem = new Map(); const store = { getItem: k => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, v) };
  assert.deepEqual(ui.readBackups(store), {}); ui.markBackedUp(store, 'RV.M.A', '2026-10-13T00:00:00Z');
  assert.deepEqual(Object.keys(ui.readBackups(store)), ['RV.M.A']);
  assert.doesNotMatch(mem.get(ui.BACKUP_KEY), /[0-9a-f]{64}/, 'no key material in the backup flag');
});

test('문구: 사실만 — 금지어 없음 · 한계(공유는 막을 수 없음 · 판매자가 켜져 있을 때 · 열쇠 분실)를 같이 말한다', () => {
  const html = readFileSync('index.html', 'utf8');
  const all = [...ui.LOCK_COPY.onLines('music'), ...ui.LOCK_COPY.onLines('book'), ...ui.LOCK_COPY.offLines, ui.LOCK_COPY.noClip, ui.LOCK_COPY.backupHead, ui.LOCK_COPY.backupMissing,
    ui.LOCK_COPY.sellerNeedsKey, ui.LOCK_COPY.buyerNote, ui.LOCK_COPY.buyerFileFact, ui.LOCK_COPY.exchangePayer, ui.LOCK_COPY.noLock].join('\n');
  const banned = ['복사 방지', '불법 복제 방지', 'DRM', '구매자만 열람', '구매자 전용', '완전 비공개', '해킹 불가', '군사급', '즉시 열림', '24시간 자동', '영구 보관', '환불 가능', '서버 없이도 안전', '탈중앙'];
  for (const w of banned) { assert.ok(!all.includes(w), `LOCK_COPY 금지어 「${w}」`); assert.ok(!html.includes(w), `index.html 금지어 「${w}」`); }
  assert.match(all, /파일 공유는 기술로 막을 수 없/); assert.match(all, /컴퓨터가 꺼져 있으면/); assert.match(all, /잃으면 복구할 수 없/);
  assert.match(ui.LOCK_COPY.buyerNote, /구매하면 열람 키가 전달됩니다\. 파일 공유는 기술로 막을 수 없습니다\./);
  assert.match(ui.LOCK_COPY.offLines[0], /누구나 받을 수 있어요/, 'plain publish still says the files are public');
  assert.match(html, /키를 잃으면 복구할 수 없어요|열쇠를 잃으면 복구할 수 없어요/);
});

test('러스트: 열쇠·백업·거래 읽기 명령이 등록돼 있고, 잠긴 동안(대기화면·매장용)에는 거부 목록에 있다 · 허용 목록에는 없다', () => {
  const lib = readFileSync('src-tauri/src/lib.rs', 'utf8'), lock = readFileSync('src-tauri/src/app_lock.rs', 'utf8');
  const cmds = ['lock_secret_put', 'lock_secret_get', 'lock_key_export', 'lock_key_import', 'lock_tx_info', 'lock_cid_range'];
  for (const c of cmds) {
    assert.ok(lib.includes(`lockkey::${c},`), `lib.rs 에 ${c} 가 없다`);
    assert.ok(new RegExp(`"${c}"`).test(lock.slice(lock.indexOf('MUST_DENY'))), `MUST_DENY 에 ${c} 가 없다`);
    const allowed = lock.slice(lock.indexOf('pub const LOCKED_ALLOWED'), lock.indexOf('];', lock.indexOf('pub const LOCKED_ALLOWED')));
    assert.ok(!allowed.includes(`"${c}"`), `${c} 가 잠긴 동안 허용 목록에 있다`);
  }
  const rs = readFileSync('src-tauri/src/lockkey.rs', 'utf8');
  assert.match(rs, /create_new\(true\)/, '덮어쓰기 없음'); assert.match(rs, /0o600/);
  assert.ok(!/println!|eprintln!|log::|tracing::/.test(rs.replace(/\/\/.*$/gm, '')), '비밀을 로그로 남기는 호출이 없다');
});

// §38 상품 문서 새 선택 칸(2026-10-14, 지갑 claude/rv-real-integ 91aef5a): lock · lock.files[].cipher · format · downloadDays · media 객체 항목.
// 확인 결과: 데스크탑(Rust·TS)에는 상품 문서(RAVENVAULT-PRODUCT-V1) 파서가 없다 — 그래서 그 칸을 거절할 곳도 없다.
// 데스크탑이 읽는 서명 문서는 제작자 매니페스트(rv-creator-manifest v2)뿐이고, 그 lock 칸은 지갑 원본(바이트 동일 복사)처럼 정확한 키만 받는다.
// 3차 동기화(6c923e2)로 지갑 product-doc.ts 등이 core/ 에 바이트 그대로 들어왔다(bulk-products.ts 의 의존) — core/ 는 이제 검사 제외(지갑 원본 해시로 고정).
// 그래도 데스크탑 자체 코드(src · src-tauri/src)가 상품 문서 파서를 새로 짜거나 직접 쓰면 이 시험이 멈춰 세운다 — 쓰려면 지갑 원본의 새 칸 시험을 함께 붙여라(직접 짜지 말 것).
test('상품 문서 새 선택 칸: 데스크탑에는 상품 문서 파서가 없다 · 매니페스트 lock 칸은 지갑 원본과 같게 정확한 키만', async () => {
  const { readdirSync, statSync } = await import('node:fs');
  const walk = d => readdirSync(d).flatMap(n => { const p = `${d}/${n}`; return statSync(p).isDirectory() ? walk(p) : /\.(rs|ts|tsx|js|mjs)$/.test(n) ? [p] : []; });
  for (const f of [...walk('src'), ...walk('src-tauri/src')]) {
    const t = readFileSync(f, 'utf8');
    assert.ok(!/RAVENVAULT-PRODUCT-V1|product-doc['"]|productLockProblem|mediaHashItemProblem|downloadDays/.test(t), `상품 문서 파서가 생겼다(${f}) — 지갑 원본을 복사하고 §38 선택 칸 시험을 붙여라`);
  }
  const prep = await ui.lockedInputFor(fakeInvoke().invoke, music(), { makeClip: async () => WAV(64_000) });
  const r = await core.legacyManifestForTest(prep.input, new core.MockPinAdapter(), sign);
  const base = JSON.parse(new TextDecoder().decode(r.manifestBytes));
  assert.equal(core.verifyManifest(base).manifest.lock.files.length, 1, '기준: 잠긴 매니페스트는 통과');
  const mutate = f => { const m = structuredClone(base); f(m); return m; };
  const cipher = { urls: ['https://seller.example/a.bin'], sha256: 'ab'.repeat(32), size: r.manifest.lock.files[0].plainSize + 1 };
  assert.throws(() => core.verifyManifest(mutate(m => { m.lock.files[0].cipher = cipher; })), /manifest-lock: file/);
  assert.throws(() => core.verifyManifest(mutate(m => { m.lock.files[0].format = 'mp3'; })), /manifest-lock: file/);
  assert.throws(() => core.verifyManifest(mutate(m => { m.lock.downloadDays = 90; })), /manifest-lock: keys/);
  assert.throws(() => core.verifyManifest(mutate(m => { m.media = [{ sha256: 'ab'.repeat(32) }]; })), /manifest-shape: keys/);
  // 상품 문서 모양을 매니페스트로 잘못 넘겨도 받지 않는다(서로 다른 형식 — 섞이지 않는다).
  const productDoc = { v: 1, kind: 'music', seller: '02' + 'ab'.repeat(32), payTo: RECEIVING, title: '노래', price: '100000000', media: [{ sha256: 'ab'.repeat(32) }],
    feeBps: 300, feeSchedule: 'cd'.repeat(32), rev: 0, id: null, prev: null, lock: { downloadDays: 90 }, sig: '' };
  assert.throws(() => core.verifyManifest(productDoc), /manifest-shape: keys/);
});
