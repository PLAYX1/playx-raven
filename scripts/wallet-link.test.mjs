// 데스크탑 지갑 연결 — 폰 core 에서 바이트 그대로 가져온 규격(core/wallet-link · core/talk)과
// 러스트(src-tauri/src/wallet_link.rs)가 같은 답을 내는지 묶는 공용 벡터.
//   node --test scripts/wallet-link.test.mjs                  검사
//   node scripts/wallet-link.test.mjs --write-vectors         벡터 다시 쓰기(서명은 매번 달라진다 — 바꿀 때만)
// 벡터의 비밀값은 시험 전용 고정 키(7 로 채운 32바이트)다. 지갑 단어·seed 는 기존 공개 fixture 순번만 적는다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createHash, pbkdf2Sync } from 'node:crypto';
import { build } from 'esbuild';

async function moduleAt(path) {
  const built = await build({ entryPoints: [path], bundle: true, write: false, platform: 'node', format: 'cjs', logLevel: 'silent' });
  const mod = { exports: {} };
  new Function('require', 'exports', 'module', built.outputFiles[0].text)(createRequire(import.meta.url), mod.exports, mod);
  return mod.exports;
}
const sha = p => createHash('sha256').update(readFileSync(p)).digest('hex');
const hex = b => Buffer.from(b).toString('hex');
const unhex = h => Uint8Array.from(Buffer.from(h, 'hex'));
const secret = n => Uint8Array.from({ length: 32 }, (_, i) => (i === 31 ? n : 7));

const link = await moduleAt('core/wallet-link/link.ts');
const transport = await moduleAt('core/wallet-link/transport.ts');
const nip44 = await moduleAt('core/talk/nip44.ts');
const event = await moduleAt('core/talk/event.ts');
const keys = await moduleAt('core/wallet-keys/derive.ts');
const bytes = await moduleAt('core/creator/bytes.ts');
const { sha256 } = createRequire(import.meta.url)('@noble/hashes/sha256');

const VECTORS = 'scripts/fixtures/wallet-link-vectors.json';
const restore = JSON.parse(readFileSync('scripts/fixtures/restore-vectors.json', 'utf8')).vectors;
const seedOf = v => pbkdf2Sync(v.mnemonic.normalize('NFKD'), `mnemonic${v.passphrase.normalize('NFKD')}`, 2048, 64, 'sha512');
const digest = (tag, body) => hex(sha256(new TextEncoder().encode(`${link.LINK_DOMAIN}|${tag}|${bytes.canonicalJson(body)}`)));

function deterministic(now) {
  const desk = secret(1), phone = secret(2);
  const deskKey = event.publicKeyOf(desk), phoneKey = event.publicKeyOf(phone);
  const seed = seedOf(restore[0]);
  let account;
  try { account = keys.deriveAccount(seed, 0); } finally { seed.fill(0); }
  const offer = { v: 1, chain: 'rvn-main', account: 0, desktopKey: deskKey, name: '맥 지갑', xpub: account.xpub,
    firstAddress: account.deriveAddress({ change: 0, index: 0 }).address, nonce: 'ab'.repeat(32), expires: now + 60_000 };
  const phoneAddress = account.deriveAddress({ change: 0, index: 7 }).address; // 아무 공개 주소 — 「폰 주소」 역할
  const id = link.linkId(offer, phoneKey);
  const convKey = hex(nip44.conversationKey(desk, phoneKey));
  const nonce = '01'.repeat(32);
  const plain = '{"rvwl1":"result","s":{"x":"연결"}}';
  return {
    deskSecret: hex(desk), phoneSecret: hex(phone), deskKey, phoneKey, seedFixtureIndex: 0, now,
    xpub: account.xpub, addresses: [0, 1, 3].map(index => ({ index, address: account.deriveAddress({ change: 0, index }).address })),
    offer, offerText: link.encodeLinkOffer(offer), linkId: id, code: link.linkConfirmCode(offer, phoneKey), phoneAddress,
    nip44: { convKey, nonce, plain, payload: nip44.encrypt(plain, unhex(convKey), unhex(nonce)), paddedLengths: [1, 32, 33, 64, 65, 100, 255, 256, 257, 1000, 65535].map(n => [n, nip44.paddedLength(n)]) },
  };
}

function write() {
  const now = 1_793_600_000_000;
  const d = deterministic(now);
  const phone = unhex(d.phoneSecret), desk = unhex(d.deskSecret);
  const req = (over = {}) => ({ v: 1, chain: 'rvn-main', account: 0, linkId: d.linkId, id: '11'.repeat(32), to: d.phoneAddress, sats: '20000000000', created: now, expires: now + 600_000, ...over });
  const accept = link.signLinkAccept({ v: 1, linkId: d.linkId, phoneKey: d.phoneKey, phoneAddresses: [d.phoneAddress] }, phone);
  const requestFill = link.signLinkRequest(req(), phone);
  const requestSend = link.signLinkRequest(req({ id: '22'.repeat(32), to: d.addresses[1].address }), phone);
  const revoke = link.signLinkRevoke({ v: 1, linkId: d.linkId, at: now + 5 }, phone);
  const result = link.signLinkResult({ v: 1, linkId: d.linkId, id: '11'.repeat(32), txid: 'aa'.repeat(32) }, desk);
  const refused = link.signLinkResult({ v: 1, linkId: d.linkId, id: '22'.repeat(32), refused: 'refused' }, desk);
  const seen = link.signLinkSeen({ v: 1, linkId: d.linkId, id: '11'.repeat(32), at: now + 2000, dailySats: '100000000000', spentToday: '0' }, desk);
  // 0.9.18 팔아 줘 · 내리기 · 판매 결과. 자산·값은 시험용 이름.
  const sellBody = { v: 1, linkId: d.linkId, id: '33'.repeat(32), asset: 'PLAYX/ALBUM1', amount: '1', priceRvn: '25.00000000', title: '첫 앨범',
    summary: '한정판 · 1번', category: 'music', image: 'https://example.com/a.png', created: now, expires: now + 600_000 };
  const sell = link.signLinkSell(sellBody, phone);
  const { image: _drop, ...plainBody } = sellBody;
  const sellPlain = link.signLinkSell({ ...plainBody, id: '55'.repeat(32), asset: 'RVTESTGAME', amount: '0.5', priceRvn: '1.00000000', category: 'game' }, phone);
  const unsell = link.signLinkUnsell({ v: 1, linkId: d.linkId, id: '44'.repeat(32), d: `rvswap:${'cc'.repeat(32)}:1`, created: now, expires: now + 600_000 }, phone);
  const sellResult = link.signLinkSellResult({ v: 1, linkId: d.linkId, id: '33'.repeat(32), status: 'published', eventId: 'dd'.repeat(32),
    d: `rvswap:${'cc'.repeat(32)}:1`, outpoint: { txid: 'cc'.repeat(32), vout: 1 }, at: now + 3000 }, desk);
  const sellRefused = link.signLinkSellResult({ v: 1, linkId: d.linkId, id: '55'.repeat(32), status: 'refused', reason: 'sell-off', at: now + 3000 }, desk);
  const bodies = [['accept', accept.body], ['request', requestFill.body], ['revoke', revoke.body], ['result', result.body], ['result', refused.body], ['seen', seen.body],
    ['sell', sell.body], ['sell', sellPlain.body], ['unsell', unsell.body], ['sellresult', sellResult.body], ['sellresult', sellRefused.body]];
  const gifts = [['accept', accept], ['request', requestFill], ['request', requestSend], ['revoke', revoke], ['sell', sell], ['sell', sellPlain], ['unsell', unsell]]
    .map(([t, s]) => ({ t, event: transport.packLinkMessage(phone, d.deskKey, { t, s }) }));
  const out = { ...d, accept, requestFill, requestSend, revoke, result, refused, seen, sell, sellPlain, unsell, sellResult, sellRefused,
    digests: bodies.map(([tag, body]) => ({ tag, body, hex: digest(tag, body) })), gifts };
  writeFileSync(VECTORS, JSON.stringify(out, null, 2) + '\n');
}
if (process.argv.includes('--write-vectors')) { write(); console.log('wrote', VECTORS); }

test('vendored phone protocol files are byte-identical to the pinned copies', () => {
  const pin = JSON.parse(readFileSync('core/wallet-link/vendor-sha256.json', 'utf8'));
  for (const [path, want] of Object.entries(pin.files)) assert.equal(sha(path), want, path);
});

test('vendored self-tests pass on the desktop crypto adapter', async () => {
  await moduleAt('core/wallet-link/link.test.ts');
  await moduleAt('core/wallet-link/transport.test.ts');
});

test('shared vectors still match the vendored TypeScript (Rust reads the same file)', () => {
  const v = JSON.parse(readFileSync(VECTORS, 'utf8'));
  const d = deterministic(v.now);
  for (const k of ['deskKey', 'phoneKey', 'xpub', 'addresses', 'offer', 'offerText', 'linkId', 'code', 'phoneAddress', 'nip44']) assert.deepEqual(v[k], d[k], k);
  assert.equal(link.parseLinkOffer(v.offerText, v.now).firstAddress, v.addresses[0].address);
  for (const x of v.digests) assert.equal(digest(x.tag, x.body), x.hex);
  assert.equal(link.verifyLinkAccept(v.accept, v.offer).phoneKey, v.phoneKey);
  const record = { linkId: v.linkId, phoneKey: v.phoneKey, phoneAddresses: [v.phoneAddress], revoked: false, dailySats: link.LINK_DAILY_SATS };
  const fill = link.checkLinkRequest(v.requestFill, record, v.now, new Set(), []);
  const send = link.checkLinkRequest(v.requestSend, record, v.now, new Set(), []);
  assert.ok(fill.ok && fill.kind === 'fill');
  assert.ok(send.ok && send.kind === 'send');
  assert.equal(link.verifyLinkRevoke(v.revoke, v.phoneKey, v.linkId).at, v.now + 5);
  assert.equal(link.verifyLinkResult(v.result, v.deskKey, v.linkId).txid, 'aa'.repeat(32));
  assert.equal(link.verifyLinkResult(v.refused, v.deskKey, v.linkId).refused, 'refused');
  assert.equal(link.verifyLinkSeen(v.seen, v.deskKey, v.linkId).dailySats, '100000000000');
  assert.throws(() => link.verifyLinkSeen(v.seen, v.phoneKey, v.linkId));
  // 0.9.18 팔아 줘: 폰이 서명한 것이 폰 규격 검사를 통과하고(허용 켠 연결), 데스크탑이 서명한 결과가 폰에서 열린다.
  const sellRec = { ...record, sell: { enabled: true, daily: 3 } };
  for (const k of ['sell', 'sellPlain']) assert.ok(link.checkLinkSell(v[k], sellRec, v.now, new Set(), 0).ok, k);
  assert.equal(link.checkLinkSell(v.sell, record, v.now, new Set(), 0).reason, 'sell-off');
  assert.equal(link.verifyLinkUnsell(v.unsell, v.phoneKey, v.linkId).d, `rvswap:${'cc'.repeat(32)}:1`);
  assert.equal(link.verifyLinkSellResult(v.sellResult, v.deskKey, v.linkId).outpoint.vout, 1);
  assert.equal(link.verifyLinkSellResult(v.sellRefused, v.deskKey, v.linkId).reason, 'sell-off');
  assert.throws(() => link.verifyLinkSellResult(v.sellResult, v.phoneKey, v.linkId));
  const desk = unhex(v.deskSecret);
  for (const g of v.gifts) {
    const got = transport.openLinkMessage(desk, g.event, v.phoneKey);
    assert.ok(got && got.msg.t === g.t, g.t);
  }
  assert.equal(nip44.decrypt(v.nip44.payload, unhex(v.nip44.convKey)), v.nip44.plain);
});
