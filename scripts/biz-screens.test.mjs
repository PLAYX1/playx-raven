// 데스크탑 「기기 연결」 · 「상품 대량 등록」 규칙 시험 — 가짜 키·가짜 CSV 만. 네트워크·실제 지갑·노드 없음.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import { pbkdf2Sync } from 'node:crypto';
import { HDKey } from '@scure/bip32';
import { secp256k1 } from '@noble/curves/secp256k1';

globalThis.navigator ??= { language: 'ko' }; // node 20 에는 없다(i18n.ts 가 켤 때 읽는다)
const built = await build({ entryPoints: ['scripts/fixtures/biz-entry.ts'], bundle: true, write: false, platform: 'node', format: 'cjs', logLevel: 'silent', loader: { '.css': 'empty', '.txt': 'text' } });
const mod = { exports: {} };
new Function('require', 'exports', 'module', built.outputFiles[0].text)(createRequire(import.meta.url), mod.exports, mod);
const B = mod.exports;

const NOW = 1_790_000_000_000, DAY = 86_400_000;
const STORE_PRIV = B.fakePriv(7), STORE_KEY = B.pubOf(STORE_PRIV), STORE_ID = 'ab'.repeat(32);
const K = { storeId: STORE_ID, storeKey: STORE_KEY, sign: B.signerOf(STORE_PRIV) };
const dev = n => B.pubOf(B.fakePriv(n));
const input = (n, over = {}) => ({ devicePubKey: dev(n), role: 'remote', ttlMs: 7 * DAY, name: '직원 폰 ' + n, ...over });

test('기기 증서 발급: 서명 확인 · 기본 7일 · 역할별 권한 · 일련번호 증가 · 철회 목록 자동 생성', async () => {
  assert.equal(B.DEVICE_CERT_DEFAULT_DAYS, 7);
  const r1 = await B.issueFor(B.emptyState(), K, input(11), NOW);
  assert.equal(r1.cert.notAfter - r1.cert.issuedAt, 7 * DAY);
  assert.deepEqual(r1.cert.scopes, [...B.DEVICE_ROLE_SCOPES.remote]);
  assert.equal(r1.cert.serial, 1);
  assert.equal(r1.state.list.seq, 1);
  assert.equal(B.verifyDeviceCert(r1.cert, STORE_KEY, NOW, r1.state.list).ok, true);
  const r2 = await B.issueFor(r1.state, K, input(12, { role: 'scanner' }), NOW + 1000);
  assert.equal(r2.cert.serial, 2);
  assert.equal(r2.state.history.length, 2);
  assert.deepEqual(r2.cert.scopes, [...B.DEVICE_ROLE_SCOPES.scanner]);
  // 같은 기기를 다시 발급해도 번호는 새것(중복 번호 금지)
  const r3 = await B.issueFor(r2.state, K, input(11), NOW + 2000);
  assert.equal(r3.cert.serial, 3);
  assert.equal(B.deviceRows(r3.state, NOW + 3000).length, 2, '기기당 한 줄(가장 최근 증서)');
});

test('발급 입력 거절: 공개키 모양 · 역할 · 기간 범위(1~30일) · 대문자 키', async () => {
  const bad = async over => B.issueFor(B.emptyState(), K, input(11, over), NOW);
  await assert.rejects(() => bad({ devicePubKey: 'zz' }), /device-key/);
  await assert.rejects(() => bad({ devicePubKey: dev(11).toUpperCase() }), /device-key/);
  await assert.rejects(() => bad({ devicePubKey: '04' + 'ab'.repeat(32) }), /device-key/);
  await assert.rejects(() => bad({ role: 'admin' }), /device-role/);
  await assert.rejects(() => bad({ ttlMs: 1000 }), /device-ttl/);
  await assert.rejects(() => bad({ ttlMs: 31 * DAY }), /device-ttl/);
  assert.equal(B.isDevicePublicKey(dev(11)), true);
});

test('가게 키 연결 전(Null)에는 서명이 거절된다 — 키 노출·가짜 서명 없음', async () => {
  assert.equal(await B.nullStoreKey.info(), null);
  await assert.rejects(() => B.nullStoreKey.signDigest(new Uint8Array(32)), /store-key-not-connected/);
  await assert.rejects(() => B.issueFor(B.emptyState(), { storeId: STORE_ID, storeKey: STORE_KEY, sign: B.nullStoreKey.signDigest }, input(11), NOW));
  assert.equal(await B.nullDeviceLink.receiveKey(), null);
  assert.equal(await B.nullDeviceLink.deliverCert({}), false);
  assert.equal(B.nullDeviceLink.connected, false);
  assert.equal(await B.nullDeviceQr.show(), null);
});

test('기기 끊기: 철회 목록 seq+1 · 그 증서만 거절 · 다른 기기 영향 없음 · 모르는 기기는 거절', async () => {
  let s = (await B.issueFor(B.emptyState(), K, input(11), NOW)).state;
  const second = await B.issueFor(s, K, input(12), NOW + 10);
  s = second.state;
  const id = B.deviceIdOf(dev(11));
  const after = await B.revokeFor(s, K, id, NOW + 20);
  assert.equal(after.list.seq, s.list.seq + 1);
  assert.equal(B.verifyDeviceRevocationList(after.list, STORE_KEY, STORE_ID).revoked.length, 1);
  const c11 = s.history.find(c => c.deviceId === id), c12 = second.cert;
  assert.deepEqual(B.verifyDeviceCert(c11, STORE_KEY, NOW + 30, after.list), { ok: false, reason: 'revoked' });
  assert.equal(B.verifyDeviceCert(c12, STORE_KEY, NOW + 30, after.list).ok, true);
  const rows = B.deviceRows(after, NOW + 30);
  assert.equal(rows.find(r => r.deviceId === id).status, 'revoked');
  assert.equal(rows.find(r => r.deviceId === c12.deviceId).status, 'active');
  await assert.rejects(() => B.revokeFor(after, K, 'cd'.repeat(32), NOW + 40), /device-unknown/);
});

test('레인 Y 끊기 단추: Rust 회전 한 길만 · 열쇠 없음일 때만 목록 서명 · 그 기기를 빼먹은 목록·옛 목록은 거절', async () => {
  let s = (await B.issueFor(B.emptyState(), K, input(11), NOW)).state;
  s = (await B.issueFor(s, K, input(12), NOW + 10)).state;
  const id = B.deviceIdOf(dev(11));
  const certId = B.deviceRows(s, NOW + 20).find(r => r.deviceId === id).certId;
  // ① 나눠 준 열쇠가 있음 → Rust 가 서명한 새 목록을 그대로 받는다(화면은 서명하지 않는다).
  const signed = [];
  const K2 = { ...K, sign: async d => { signed.push(d); return K.sign(d); } };
  const calls = [];
  const rustList = await B.resignList(s, K, NOW + 20, [certId]);
  const port = { disconnect: async (...args) => { calls.push(args); return { rotated: true, list: rustList }; } };
  const r = await B.disconnectFor(s, K2, port, id, NOW + 20);
  assert.equal(r.rotated, true); assert.equal(r.state.list.seq, rustList.seq);
  assert.equal(signed.length, 0, '화면은 가게 키 서명을 하지 않는다(Rust 묶음 서명)');
  assert.equal(calls.length, 1); assert.equal(calls[0][0], id); assert.equal(calls[0][2].length, 2, '이력(공개 증서)을 넘긴다');
  // ② 열쇠 없음 → 그때만 화면이 목록을 서명(옛 동작).
  const r2 = await B.disconnectFor(s, K2, B.nullDisconnect, id, NOW + 20);
  assert.equal(r2.rotated, false); assert.ok(r2.state.list.revoked.includes(certId)); assert.equal(signed.length, 1);
  // ③ 그 기기를 빼먹은 목록 · 다른 가게 키 목록 · 모르는 기기는 거절.
  const wrong = await B.resignList(s, K, NOW + 20, []);
  await assert.rejects(() => B.disconnectFor(s, K, { disconnect: async () => ({ rotated: true, list: wrong }) }, id, NOW + 20), /device-disconnect/);
  const other = { storeId: STORE_ID, storeKey: B.pubOf(B.fakePriv(9)), sign: B.signerOf(B.fakePriv(9)) };
  const foreign = await B.resignList({ ...s, list: null }, other, NOW + 20, [certId]);
  await assert.rejects(() => B.disconnectFor(s, K, { disconnect: async () => ({ rotated: true, list: foreign }) }, id, NOW + 20));
  await assert.rejects(() => B.disconnectFor(s, K, port, 'cd'.repeat(32), NOW + 20), /device-unknown/);
  // ④ tauri 자리: 명령 이름·인자 모양, 열쇠 없음 응답.
  const seen = [];
  const inv = async (cmd, args) => { seen.push({ cmd, args }); return { ok: true, noDataKey: true }; };
  assert.deepEqual(await B.tauriDisconnect(inv).disconnect(id, '직원 폰', s.history, s.list), { noDataKey: true });
  assert.equal(seen[0].cmd, 'lan_device_disconnect'); assert.deepEqual(Object.keys(seen[0].args).sort(), ['deviceId', 'deviceName', 'knownCerts', 'knownList']);
  await assert.rejects(() => B.tauriDisconnect(async () => ({ ok: false })).disconnect(id, 'x', [], null), /device-disconnect/);
});

test('철회 목록 후퇴 금지: 옛 판(seq 낮음)을 다시 올려도 현재 판이 그대로다', async () => {
  let s = (await B.issueFor(B.emptyState(), K, input(11), NOW)).state;
  const old = s.list;
  const id = B.deviceIdOf(dev(11));
  s = await B.revokeFor(s, K, id, NOW + 20);
  // 옛 판을 새 판 위에 다시 올리면 core 는 현재 판을 그대로 둔다(seq 낮음).
  const { acceptDeviceRevocationList } = await build({ entryPoints: ['core/device/revoke.ts'], bundle: true, write: false, platform: 'node', format: 'cjs', logLevel: 'silent' })
    .then(b => { const m = { exports: {} }; new Function('require', 'exports', 'module', b.outputFiles[0].text)(createRequire(import.meta.url), m.exports, m); return m.exports; });
  assert.equal(acceptDeviceRevocationList(s.list, old, STORE_KEY, STORE_ID).seq, s.list.seq);
});

test('철회 목록이 하루 지나면 stale — 발급 전에 저절로 새로 서명한다 · 끊은 기기는 유지', async () => {
  let s = (await B.issueFor(B.emptyState(), K, input(11), NOW)).state;
  s = await B.revokeFor(s, K, B.deviceIdOf(dev(11)), NOW + 5);
  assert.equal(B.listIsStale(s.list, NOW + 5 + 23 * 3600_000), false);
  assert.equal(B.listIsStale(s.list, NOW + 5 + 25 * 3600_000), true);
  assert.equal(B.listIsStale(null, NOW), true);
  const later = NOW + 3 * DAY;
  const r = await B.issueFor(s, K, input(12), later);
  assert.equal(r.state.list.seq, s.list.seq + 1);
  assert.equal(r.state.list.issuedAt, later);
  assert.deepEqual(r.state.list.revoked, s.list.revoked);
  assert.equal(B.verifyDeviceCert(r.cert, STORE_KEY, later, r.state.list).ok, true);
});

test('기기 목록 상태: 만료 · 끊음 · 쓰는 중, 마지막 확인은 없으면 null', async () => {
  const s = (await B.issueFor(B.emptyState(), K, input(11, { ttlMs: DAY }), NOW)).state;
  assert.equal(B.deviceRows(s, NOW + 1000)[0].status, 'active');
  assert.equal(B.deviceRows(s, NOW + 2 * DAY)[0].status, 'expired');
  assert.equal(B.deviceRows(s, NOW)[0].lastSeen, null);
  assert.equal(B.deviceRows({ ...s, lastSeen: { [B.deviceIdOf(dev(11))]: NOW } }, NOW)[0].lastSeen, NOW);
});

test('저장소: 왕복 · 깨진 증서/목록은 건너뛴다 · 저장소 없음에도 죽지 않는다', async () => {
  const s = (await B.issueFor(B.emptyState(), K, input(11), NOW)).state;
  const mem = new Map();
  const storage = { getItem: k => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, v) };
  const store = B.localDeviceStore(storage);
  store.save(s);
  assert.equal(store.load().history.length, 1);
  assert.equal(store.load().list.seq, s.list.seq);
  mem.set(B.DEVICE_STORE_KEY, JSON.stringify({ history: [{ x: 1 }, s.history[0]], list: { bad: true }, names: { a: 5, b: '이름' }, lastSeen: { a: 'x', b: 3 } }));
  const loaded = store.load();
  assert.equal(loaded.history.length, 1); assert.equal(loaded.list, null);
  assert.deepEqual(loaded.names, { b: '이름' }); assert.deepEqual(loaded.lastSeen, { b: 3 });
  mem.set(B.DEVICE_STORE_KEY, '{깨짐'); assert.deepEqual(B.localDeviceStore(storage).load(), B.emptyState());
  assert.deepEqual(B.localDeviceStore(null).load(), B.emptyState());
  B.localDeviceStore(null).save(s);
});

/* ── 대량 등록 ── */
const HEAD = '제목,종류,가격,설명,파일 URL,파일 SHA256,파일 크기,다운로드 기간 일수,재고';
const sha = 'a'.repeat(64);
const csv = rows => [HEAD, ...rows].join('\n');
const ctx = B.placeholderContext();

test('대량 등록: 정상 줄은 초안, 오류 줄은 줄 번호와 쉬운 한국어 이유 · 아무것도 자동으로 올리지 않는다', () => {
  const r = B.parseBulkProducts(csv([
    `여름 사진집,digital,1.5,좋아요,https://files.example.com/a.zip,${sha},1000,30,10`,
    `,digital,1,,,,,,`,
    `음악,music,-3,,,,,,`,
  ]), ctx);
  assert.equal(r.reviewOnly, true); assert.equal(r.autoPublish, false);
  assert.equal(r.drafts.length, 1); assert.equal(r.ok, false);
  const lines = r.rowErrors.map(e => e.line);
  assert.ok(lines.includes(3) && lines.includes(4));
  for (const e of r.rowErrors) assert.match(e.say, /[가-힣]/);
  const rows = B.draftRows(r);
  assert.equal(rows[0].priceText, '1.5');
  assert.equal(B.atomsToRvnText('100000000'), '1'); assert.equal(B.atomsToRvnText('150000'), '0.0015');
});

test('엑셀 수식 주입: =+-@ 로 시작하는 칸은 경고(값은 안 바뀜)', () => {
  const r = B.parseBulkProducts(csv([`=HYPERLINK("x"),digital,1,,,,,,`, `+cmd,digital,1,,,,,,`]), ctx);
  assert.ok(r.warnings.some(w => w.code === 'formula-injection'));
});

test('대량 등록: 상한 · 빈 파일 · 헤더만 · 열 이름 쉬운 말', () => {
  const many = Array.from({ length: B.BULK_LIMITS.maxRows + 1 }, (_, i) => `상품${i},digital,1,,,,,,`);
  assert.equal(B.parseBulkProducts(csv(many), ctx).ok, false);
  assert.equal(B.parseBulkProducts('', ctx).fileErrors.length, 1);
  assert.equal(B.parseBulkProducts(HEAD, ctx).fileErrors[0].code, 'csv-header-only');
  assert.equal(B.columnLabel('title'), '제목'); assert.equal(B.columnLabel('col2'), '3번째 칸'); assert.equal(B.columnLabel(undefined), '');
  assert.equal(B.columnLabel('mystery'), 'mystery', '모르는 칸 이름을 지어내지 않는다');
});

test('올리기 문: 잠금 > 임시 정보 > 확인 전 > 길 없음 > 준비 — 잠금이 true 이면 무엇이 와도 막힌다', () => {
  const g = B.publishGate;
  assert.equal(g({ paused: true, real: true, confirmed: true, ready: true }), 'paused');
  assert.equal(g({ paused: false, real: false, confirmed: true, ready: true }), 'placeholder');
  assert.equal(g({ paused: false, real: true, confirmed: false, ready: true }), 'unconfirmed');
  assert.equal(g({ paused: false, real: true, confirmed: true, ready: false }), 'unplugged');
  assert.equal(g({ paused: false, real: true, confirmed: true, ready: true }), 'ready');
  assert.equal(B.CREATOR_PUBLISH_PAUSED, true, '잠금은 풀지 않았다');
  assert.equal(B.nullBulkPublisher.ready, false);
});

test('임시 판매자 정보는 공개된 고정 키(G)이고 개인키가 아니다', () => {
  assert.equal(B.REVIEW_PLACEHOLDER_SELLER.length, 66);
  assert.equal(B.placeholderContext().feeBps, 0);
  assert.equal(B.pubOf(B.fakePriv(1)), B.REVIEW_PLACEHOLDER_SELLER);
});

/* ── 문구 ── */
const lits = file => {
  const s = readFileSync(file, 'utf8'); const out = new Set();
  for (const m of s.matchAll(/(?:copyHtml|\bt|\btf|\bsure|setCopyText\([^)]*\)\s*=>\s*t)\(\s*"((?:\\.|[^"\\])*)"/g)) if (/[가-힣]/.test(m[1])) out.add(m[1]);
  for (const m of s.matchAll(/\bt\(ROLE_(?:LABEL|HELP)\[|^\s*(?:remote|"staff-pc"|scanner|replica):\s*"([^"]+)"/gm)) if (m[1]) out.add(m[1]);
  return out;
};
test('화면 문구는 영어·일본어·중국어가 모두 있다 · 금지 문구 없음 · 이모지 없음', () => {
  for (const f of ['src/device-connect.ts', 'src/bulk-products-ui.ts']) {
    for (const k of lits(f)) for (const l of ['en', 'ja', 'zh']) assert.ok(B.hasOwnTranslation(k, l), `${f}: ${l} 번역 없음: ${k}`);
  }
  const all = ['src/device-connect.ts', 'src/bulk-products-ui.ts', 'src/device-copy.ts', 'src/bulk-copy.ts'].map(f => readFileSync(f, 'utf8')).join('\n');
  for (const bad of ['검증된', '정품 보증', '안전한 거래', '사기 방지', '최고의 암호화폐', '비트코인만큼', '비트코인보다']) assert.ok(!all.includes(bad), bad);
  const code = all.split('\n').filter(l => !/^\s*(\*|\/\*|\/\/)/.test(l)).join('\n'); // 주석의 🔴 표시는 저장소 관례 — 화면 글자만 본다
  assert.ok(!/\p{Extended_Pictographic}/u.test(code), '이모지 금지');
});

/* ── 가게 키 서명(Rust store_sign_digest 를 같은 규칙으로 흉내 낸 가짜 invoke) — 가짜 12단어만 ── */
const WORDS = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const SHOP_PATH = "m/44'/175'/7'/1'/0'"; // 데스크탑 identity.rs PATH_SHOP — src-tauri 시험이 같은 공개키·서명을 확인한다
const shopPriv = HDKey.fromMasterSeed(pbkdf2Sync(WORDS, 'mnemonic', 2048, 64, 'sha512')).derive(SHOP_PATH).privateKey;
const SHOP_PUB = Buffer.from(secp256k1.getPublicKey(shopPriv, true)).toString('hex');
const RUST_VECTOR = { pub: '037821115dd0aa762d3a393fa861ce8e784403b9e0ec578bc37e72e6e9e70a1c09',
  sig: '2e638d02c47357cba4160021eb21e518bfbbf5201c87c7f5c2e70c48c72ba10032ee07c72c73826d9cfe997b1a61412d37c8420f3033640bb36b732b0d18dd37' };
const fakeInvoke = (opts = {}) => {
  const calls = [];
  const fn = async (cmd, args) => {
    calls.push({ cmd, args });
    if (opts.locked) throw '지갑이 잠겨 있어요. 잠금을 푼 뒤 다시 해 주세요.';
    if (cmd === 'store_key_info') return { store_key: SHOP_PUB };
    if (cmd === 'store_sign_digest') {
      if (!/^[0-9a-f]{64}$/.test(args.digest) || !args.reason || args.reason.length > 80) throw '서명할 내용의 모양이 맞지 않아요.';
      if ('badReply' in opts) return opts.badReply;
      return { store_key: SHOP_PUB, sig: secp256k1.sign(Uint8Array.from(args.digest.match(/../g), b => parseInt(b, 16)), shopPriv, { lowS: true }).toCompactHex() };
    }
    throw 'unknown';
  };
  fn.calls = calls; return fn;
};

test('가게 키 서명: 파생 공개키가 Rust 시험 벡터와 같고, 기기 증서 발급·끊기가 코어 검증을 통과한다', async () => {
  assert.equal(SHOP_PUB, RUST_VECTOR.pub);
  const d = Uint8Array.from('0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20'.match(/../g), b => parseInt(b, 16));
  assert.equal(secp256k1.sign(d, shopPriv, { lowS: true }).toCompactHex(), RUST_VECTOR.sig);
  const inv = fakeInvoke();
  const port = B.tauriStoreKey(inv, async () => STORE_ID);
  const info = await port.info();
  assert.deepEqual(info, { storeId: STORE_ID, storeKey: SHOP_PUB });
  const k = { storeId: info.storeId, storeKey: info.storeKey, sign: port.signDigest };
  const r1 = await B.issueFor(B.emptyState(), k, input(21), NOW);
  assert.equal(B.verifyDeviceCert(r1.cert, SHOP_PUB, NOW, r1.state.list).ok, true);
  const s2 = await B.revokeFor(r1.state, k, r1.cert.deviceId, NOW + 1000);
  assert.equal(B.verifyDeviceRevocationList(s2.list, SHOP_PUB, STORE_ID).seq, 2);
  assert.ok(inv.calls.every(c => c.cmd !== 'store_sign_digest' || (/^[0-9a-f]{64}$/.test(c.args.digest) && c.args.reason.length <= 80)));
});

test('가게 키 서명: 앱 잠금 중 거절 · 잘못된 요청/응답 거절 · 오류에 열쇠·단어가 없다', async () => {
  const locked = B.tauriStoreKey(fakeInvoke({ locked: true }), async () => STORE_ID);
  await assert.rejects(() => locked.info());
  await assert.rejects(() => locked.signDigest(new Uint8Array(32)));
  const ok = B.tauriStoreKey(fakeInvoke(), async () => STORE_ID);
  await assert.rejects(() => ok.signDigest(new Uint8Array(31)), /store-sign-digest/);
  await assert.rejects(() => ok.signDigest('zz'), /store-sign-digest/);
  for (const bad of [null, {}, { sig: 'zz' }, { sig: 'a'.repeat(127) }, { sig: 'A'.repeat(128) }]) {
    await assert.rejects(() => B.tauriStoreKey(fakeInvoke({ badReply: bad }), async () => STORE_ID).signDigest(new Uint8Array(32)), /store-sign-reply/);
  }
  // 가게 번호가 없으면 키만 보이고 발급은 닫힌다
  assert.deepEqual(await B.tauriStoreKey(fakeInvoke(), async () => null).info(), { storeId: null, storeKey: SHOP_PUB });
  assert.deepEqual(await B.tauriStoreKey(fakeInvoke(), async () => 'zz').info(), { storeId: null, storeKey: SHOP_PUB });
  // 다른 키의 서명이 오면(키 불일치) 코어가 거절한다
  const other = secp256k1.sign(new Uint8Array(32).fill(1), B.fakePriv(9), { lowS: true }).toCompactHex();
  const mism = B.tauriStoreKey(fakeInvoke({ badReply: { sig: other } }), async () => STORE_ID);
  await assert.rejects(() => B.issueFor(B.emptyState(), { storeId: STORE_ID, storeKey: SHOP_PUB, sign: mism.signDigest }, input(22), NOW));
  const msgs = [];
  try { await locked.signDigest(new Uint8Array(32)); } catch (e) { msgs.push(String(e?.message ?? e)); }
  for (const m of msgs) assert.ok(!m.includes(Buffer.from(shopPriv).toString('hex')) && !m.includes('abandon'));
});

test('대량 등록 서명: 잠금이면 서명도 안 하고, 잠금이 풀려도 서명까지만 — 올리기는 호출하지 않는다', async () => {
  const mine = { ...ctx, seller: SHOP_PUB, payTo: B.sellerAddressOf ? B.sellerAddressOf(SHOP_PUB) : ctx.payTo };
  const r = B.parseBulkProducts(csv([`여름 사진집,digital,1.5,설명,https://files.example.com/a.zip,${sha},1000,30,10`]), mine);
  assert.equal(r.drafts.length, 1, JSON.stringify(r.rowErrors));
  const draft = r.drafts[0];
  assert.equal(B.CREATOR_PUBLISH_PAUSED, true, '잠금 상수는 풀지 않았다');
  // 잠금: 서명 요청도 없다
  const inv1 = fakeInvoke();
  const paused = B.storeKeyBulkPublisher(B.tauriStoreKey(inv1, async () => STORE_ID), true, true);
  assert.equal(paused.ready, false); assert.equal(paused.signReady, true);
  assert.equal((await paused.publish(draft)).ok, false);
  assert.equal(inv1.calls.length, 0);
  // 가상으로 잠금이 풀린 경우: 서명은 되지만 올리기는 부르지 않는다(결과는 항상 ok:false)
  const inv2 = fakeInvoke();
  const open = B.storeKeyBulkPublisher(B.tauriStoreKey(inv2, async () => STORE_ID), false, true);
  const out = await open.publish(draft);
  assert.equal(out.ok, false);
  assert.match(out.say, /올리기 길이 아직 연결되지 않았어요/);
  assert.equal(open.signed.length, 1);
  assert.equal(inv2.calls.filter(c => c.cmd !== 'store_sign_digest').length, 0);
});

/* ── 가게 문서(가게 번호) 만들기 — 가짜 12단어 ── */
const SD_NOW = 1_790_000_000_000;
const SD_INPUT = { name: '무송 체육관 스토어', intro: '직접 만든 굿즈를 팝니다.', category: 'retail', region: '서울 마포' };
const signCalls = inv => inv.calls.filter(c => c.cmd === 'store_sign_digest');

test('가게 문서: 가짜 12단어 → 서명 → core 검증 → 가게 번호(rev 0 본문 해시) · 사유는 80자 이하로 확인창에 전달', async () => {
  const inv = fakeInvoke();
  const rec = await B.createStoreDoc(B.tauriStoreKey(inv), SD_INPUT, SD_NOW);
  assert.equal(rec.doc.seller, SHOP_PUB); assert.equal(rec.doc.rev, 0); assert.equal(rec.doc.id, null); assert.equal(rec.doc.prev, null);
  assert.deepEqual(rec.doc.contacts, []); assert.deepEqual(rec.doc.photos, []); assert.equal(rec.doc.notice, 'on-request');
  assert.equal(rec.storeId, B.storeDocHash(rec.doc)); assert.equal(rec.storeId, B.storeIdOf(rec.doc)); assert.match(rec.storeId, /^[0-9a-f]{64}$/);
  // 받는 쪽(폰 core 와 같은 파일)이 바이트로 다시 확인한다
  const v = B.verifyStoreDoc(B.exportBytes(rec), { now: SD_NOW / 1000, expectedId: rec.storeId });
  assert.equal(v.idProven, true); assert.equal(v.storeId, rec.storeId);
  assert.equal(rec.doc.expiresAt - rec.doc.issuedAt, 90 * 86400);
  const calls = signCalls(inv);
  assert.equal(calls.length, 1); assert.equal(calls[0].args.reason, B.STORE_DOC_REASON); assert.ok(calls[0].args.reason.length <= 80);
  // 같은 12단어·같은 입력·같은 시각이면 같은 번호(결정적), 다른 이름이면 다른 번호
  const again = await B.createStoreDoc(B.tauriStoreKey(fakeInvoke()), SD_INPUT, SD_NOW);
  assert.equal(again.storeId, rec.storeId);
  const other = await B.createStoreDoc(B.tauriStoreKey(fakeInvoke()), { ...SD_INPUT, name: '다른 가게' }, SD_NOW);
  assert.notEqual(other.storeId, rec.storeId);
  assert.equal(B.exportName(rec), `rv-store-${rec.storeId.slice(0, 12)}.json`);
});

test('가게 문서 거절: 잘못된 입력은 서명 확인창 전에 막힌다 · 잠금 · 다른 키의 서명 · 오류에 열쇠 없음', async () => {
  const bad = [
    { ...SD_INPUT, name: '' }, { ...SD_INPUT, name: 'x'.repeat(41) }, { ...SD_INPUT, name: '공식 인증 가게' },
    { ...SD_INPUT, region: '' }, { ...SD_INPUT, region: '마포구 12-3번지' }, { ...SD_INPUT, category: '' }, { ...SD_INPUT, category: 'weapons' },
    { ...SD_INPUT, intro: '정품 보증 100%' }, { ...SD_INPUT, intro: 'x'.repeat(401) },
  ];
  for (const input of bad) {
    const inv = fakeInvoke();
    await assert.rejects(() => B.createStoreDoc(B.tauriStoreKey(inv), input, SD_NOW), /store-/, JSON.stringify(input));
    assert.equal(signCalls(inv).length, 0, '입력 오류는 사장 확인창(서명 요청) 전에 막힌다');
  }
  // 앱 잠금 중: info 부터 거절 — 서명 요청 없음
  const lockedInv = fakeInvoke({ locked: true });
  await assert.rejects(() => B.createStoreDoc(B.tauriStoreKey(lockedInv), SD_INPUT, SD_NOW));
  assert.equal(signCalls(lockedInv).length, 0);
  // 사장이 확인창에서 거절 → 고정 문장만
  const declined = async cmd => { if (cmd === 'store_key_info') return { store_key: SHOP_PUB }; throw '사장님이 서명을 허락하지 않았어요.'; };
  await assert.rejects(() => B.createStoreDoc(B.tauriStoreKey(declined), SD_INPUT, SD_NOW), /signer-failed/);
  // 연결 전
  await assert.rejects(() => B.createStoreDoc(B.nullStoreKey, SD_INPUT, SD_NOW), /store-key-not-connected/);
  // 다른 키가 서명해서 돌려주면(키 불일치) core 가 거절하고 저장할 문서가 없다
  const other = secp256k1.sign(new Uint8Array(32).fill(3), B.fakePriv(9), { lowS: true }).toCompactHex();
  await assert.rejects(() => B.createStoreDoc(B.tauriStoreKey(fakeInvoke({ badReply: { sig: other } })), SD_INPUT, SD_NOW));
  // 화면 문장에 열쇠·단어가 없다
  const msgs = [];
  for (const e of [new Error('store-text'), new Error('store-key-not-connected'), new Error('store-verify'), new Error('abandon abandon x')]) msgs.push(B.storeErrorSay(e));
  for (const m of msgs) assert.ok(!m.includes(Buffer.from(shopPriv).toString('hex')) && !m.includes('abandon'));
});

test('가게 문서 저장: 다시 읽으면 core 규칙으로 거른다(변조·rev≠0 거절) · 키가 바뀌면 번호를 내주지 않는다', async () => {
  const rec = await B.createStoreDoc(B.tauriStoreKey(fakeInvoke()), SD_INPUT, SD_NOW);
  const mem = B.memoryStoreDocStorage(); assert.equal(mem.load(), null);
  mem.save(rec); assert.equal(mem.load().storeId, rec.storeId);
  // localStorage 모양 저장소
  const data = new Map(); const st = { getItem: k => data.get(k) ?? null, setItem: (k, v) => data.set(k, v) };
  const ls = B.localStoreDocStorage(st); ls.save(rec);
  assert.equal(ls.load().storeId, rec.storeId);
  const raw = JSON.parse(data.get(B.STORE_DOC_STORAGE_KEY));
  for (const mutate of [r => { r.doc.name = '바꾼 이름'; }, r => { r.doc.sig = r.doc.sig.slice(0, -4) + 'AAAA'; }, r => { r.doc.rev = 1; r.doc.id = 'ab'.repeat(32); r.doc.prev = 'cd'.repeat(32); }, r => { r.doc.seller = '02' + '11'.repeat(32); }, r => { delete r.doc; }]) {
    const copy = structuredClone(raw); mutate(copy); data.set(B.STORE_DOC_STORAGE_KEY, JSON.stringify(copy));
    assert.equal(ls.load(), null);
  }
  data.set(B.STORE_DOC_STORAGE_KEY, '{broken'); assert.equal(ls.load(), null);
  // 번호는 지금 가게 키가 문서의 seller 와 같을 때만
  assert.equal(B.matchedStoreId(rec, SHOP_PUB), rec.storeId);
  assert.equal(B.matchedStoreId(rec, B.pubOf(B.fakePriv(9))), null);
  assert.equal(B.matchedStoreId(null, SHOP_PUB), null);
  assert.equal(B.matchedStoreId(rec, null), null);
  assert.equal(await B.savedStoreId(fakeInvoke(), mem), rec.storeId);
  assert.equal(await B.savedStoreId(async () => ({ store_key: B.pubOf(B.fakePriv(9)) }), mem), null);
  assert.equal(await B.savedStoreId(fakeInvoke(), B.memoryStoreDocStorage()), null);
  await assert.rejects(() => B.savedStoreId(fakeInvoke({ locked: true }), mem));
});

test('가게 번호가 있으면 기기 증서 발급과 끊기가 열린다 · 폰 core(verifyDeviceCert)가 확인 · 끊으면 거절 · 사유 전달', async () => {
  const inv = fakeInvoke();
  const rec = await B.createStoreDoc(B.tauriStoreKey(inv), SD_INPUT, SD_NOW);
  const mem = B.memoryStoreDocStorage(rec);
  // 번호 없음 → 키만 보이고 발급은 닫힘(info.storeId null)
  const noDoc = B.tauriStoreKey(inv, () => B.savedStoreId(inv, B.memoryStoreDocStorage()));
  assert.deepEqual(await noDoc.info(), { storeId: null, storeKey: SHOP_PUB });
  // 번호 있음 → 열림
  const port = B.tauriStoreKey(inv, () => B.savedStoreId(inv, mem));
  const info = await port.info();
  assert.equal(info.storeId, rec.storeId);
  const k = { storeId: info.storeId, storeKey: info.storeKey, sign: port.withReason('기기 증서 발급 - 시험').signDigest };
  const r1 = await B.issueFor(B.emptyState(), k, input(31), NOW);
  assert.equal(r1.cert.storeId, rec.storeId);
  const ok = B.verifyDeviceCert(r1.cert, rec.doc.seller, NOW, r1.state.list);
  assert.equal(ok.ok, true, JSON.stringify(ok));
  // 끊기 → 철회 목록에 그 증서 번호 · 이후 같은 증서는 거절
  const s2 = await B.revokeFor(r1.state, k, r1.cert.deviceId, NOW + 1000);
  assert.ok(s2.list.revoked.includes(B.deviceCertId(r1.cert)));
  assert.equal(B.verifyDeviceRevocationList(s2.list, rec.doc.seller, rec.storeId).seq, 2);
  const after = B.verifyDeviceCert(r1.cert, rec.doc.seller, NOW + 2000, s2.list);
  assert.equal(after.ok, false); assert.ok(after.reason);
  assert.equal(B.deviceRows(s2, NOW + 2000)[0].status, 'revoked');
  // 다른 가게 번호로 만든 철회 목록은 받아주지 않는다
  assert.throws(() => B.verifyDeviceRevocationList(s2.list, rec.doc.seller, 'cd'.repeat(32)));
  // 서명 요청에는 사유가 붙었다(80자 이하)
  for (const c of signCalls(inv)) assert.ok(c.args.reason && c.args.reason.length <= 80);
  assert.ok(signCalls(inv).some(c => c.args.reason === '기기 증서 발급 - 시험'));
});

test('가게 번호 카드 문구: 영·일·중 번역 있음 · 금지 문구 없음 · 올리기 길 없음', () => {
  for (const k of lits('src/store-doc-ui.ts')) for (const l of ['en', 'ja', 'zh']) assert.ok(B.hasOwnTranslation(k, l), `${l} 번역 없음: ${k}`);
  for (const k of ['음식점', '카페', '소매', '중고', '음악', '책', '게임', '서비스', '디지털', '기타']) for (const l of ['en', 'ja', 'zh']) assert.ok(B.hasOwnTranslation(k, l), `${l}: ${k}`);
  const src = readFileSync('src/store-doc-ui.ts', 'utf8') + readFileSync('src/store-doc-copy.ts', 'utf8');
  for (const bad of ['검증된', '정품 보증', '안전한 거래', '사기 방지', '최고의 암호화폐', '비트코인만큼', '비트코인보다']) assert.ok(!src.includes(bad), bad);
  const code = src.split('\n').filter(l => !/^\s*(\*|\/\*|\/\/)/.test(l)).join('\n');
  assert.ok(!/\p{Extended_Pictographic}/u.test(code), '이모지 금지');
  // 게시·업로드 길이 없다: 네트워크·게시 호출이 이 화면 코드에 없다
  assert.ok(!/fetch\(|XMLHttpRequest|WebSocket|publish|upload\(|ipfs|sendBeacon/i.test(code.replace(/올리지|publish\w*|업로드/gi, '')), '게시/업로드 호출 없음');
  assert.ok(!/rv\.store-doc-id/.test(readFileSync('src/main.ts', 'utf8')), '임시 연결점(rv.store-doc-id)은 없앴다');
});
