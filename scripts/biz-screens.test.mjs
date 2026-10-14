// 데스크탑 「기기 연결」 · 「상품 대량 등록」 규칙 시험 — 가짜 키·가짜 CSV 만. 네트워크·실제 지갑·노드 없음.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { build } from 'esbuild';

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
