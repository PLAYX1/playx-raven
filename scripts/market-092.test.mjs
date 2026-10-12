// 0.9.2 열린 장터: 노드 목록·서명된 목록 어댑터·결제 준비/승인 분리·메모 바이트·1단계 제한·스위치 연동·문구 금지어·소각 상수 교차 확인.
// 모의 노드(주입한 invoke)만 쓴다 — 시험망·메인넷·실제 IPFS·키·지갑 접근 없음.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import { SW } from './mainnet-switch-state.mjs';

async function moduleAt(path) {
  const built = await build({ entryPoints: [path], bundle: true, write: false, platform: 'node', format: 'cjs', logLevel: 'silent' });
  const mod = { exports: {} };
  new Function('require', 'exports', 'module', built.outputFiles[0].text)(createRequire(import.meta.url), mod.exports, mod);
  return mod.exports;
}
const node = await moduleAt('src/market-node.ts');
const copy = await moduleAt('src/market-copy.ts');
const lists = await moduleAt('src/market-lists.ts');
const envelope = await moduleAt('core/signed-lists/envelope.ts');
const read = p => readFileSync(p, 'utf8');

test('RVDP 메모: 데스크탑 계정형 메모가 지갑 core encodeMemoScript 의 출력과 바이트까지 같다(지갑 구현에서 뽑은 벡터)', () => {
  // 벡터 출처: 지갑 저장소 core/game-pay/direct-pay.ts encodeMemoScript 를 그대로 실행한 값(2026-10-12, wt-rv-wallet-final13).
  assert.equal(node.memoScriptAccount({ gameIndex: 0xfffe, itemId: 'A0123456789ab', ownerId: '12345678-1234-4234-8234-1234567890ab', priceVersion: 1, nonce: 7 }),
    '6a305256445003fffe010d41303132333435363738396162123456781234423482341234567890ab000100000007baf7f81a');
  assert.equal(node.memoScriptAccount({ gameIndex: 12, itemId: 'C1', ownerId: 'aaaaaaaa-bbbb-4ccc-9ddd-eeeeeeeeeeee', priceVersion: 1, nonce: 4294967295 }),
    '6a255256445003000c01024331aaaaaaaabbbb4ccc9dddeeeeeeeeeeee0001ffffffff96e464e7');
  for (const bad of [{ gameIndex: -1 }, { gameIndex: 65536 }, { itemId: 'bad id' }, { itemId: '' }, { ownerId: 'x' }, { nonce: -1 }, { nonce: 2 ** 32 }, { priceVersion: 0 }])
    assert.throws(() => node.memoScriptAccount({ gameIndex: 1, itemId: 'C1', ownerId: 'aaaaaaaa-bbbb-4ccc-9ddd-eeeeeeeeeeee', nonce: 1, ...bad }), /memo-invalid/);
  // 검증됨은 허용 목록 번호 + C1, 보증은 예약 번호 + 자산에서 만든 아이템 번호.
  assert.deepEqual(node.memoTerms({ asset: 'RV.M.A', tier: 'verified', gameIndex: 12 }), { gameIndex: 12, itemId: 'C1' });
  const b = node.memoTerms({ asset: 'RV.M.A', tier: 'bonded' });
  assert.equal(b.gameIndex, 0xfffe); assert.match(b.itemId, /^A[0-9a-f]{12}$/);
});

test('결제 기록용 주인 번호: UUIDv4 모양, 저장해서 다시 쓴다, 저장소가 없어도 동작', () => {
  const mem = new Map(); const st = { getItem: k => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, v) };
  const a = node.marketOwnerId(st, n => Uint8Array.from({ length: n }, (_, i) => i + 1));
  assert.match(a, /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
  assert.equal(node.marketOwnerId(st, n => new Uint8Array(n)), a, '저장된 값을 다시 쓴다');
  assert.match(node.marketOwnerId(null, n => Uint8Array.from({ length: n }, () => 9)), /^[a-f0-9]{8}-/);
});

test('노드 목록 어댑터: listassets 명령 + IPFS 읽기(creator_cid_read) · 못 받으면 null', async () => {
  const calls = [];
  const invoke = async (cmd, args) => {
    calls.push([cmd, args]);
    if (cmd === 'market_list_assets') return [{ name: 'RV.M.A', ipfs_hash: 'Qm' + '1'.repeat(44) }];
    if (cmd === 'creator_cid_read') { if (args.cid.endsWith('9')) throw new Error('없음'); return { size: 3, data: Buffer.from([1, 2, 3]).toString('base64') }; }
    throw new Error('unexpected ' + cmd);
  };
  const src = node.nodeMarketSource(invoke);
  assert.deepEqual(await src.assets('RV.M.*'), [{ name: 'RV.M.A', ipfs_hash: 'Qm' + '1'.repeat(44) }]);
  assert.deepEqual(Array.from(await src.fetch('Qm' + '1'.repeat(44))), [1, 2, 3]);
  assert.equal(await src.fetch('Qm' + '9'.repeat(44)), null);
  assert.deepEqual(calls.map(c => c[0]), ['market_list_assets', 'creator_cid_read', 'creator_cid_read']);
  assert.equal(calls[1][1].maxBytes, 25 * 1024 * 1024);
});

test('서명된 목록 받기(C3): 지갑 core httpSource 를 그대로 쓰는 어댑터 · 믿는 키가 비어 있으면 받지도 않는다 · 주소는 지갑 core 와 러스트가 같다', async () => {
  assert.equal(envelope.SIGNED_LISTS_PUBLIC_KEYS.length, 0, '운영 공개키 자리는 비어 있어야 한다(대표가 만든다) — 개발 키를 박지 않는다');
  const asked = [];
  const invoke = async (cmd, args) => { asked.push([cmd, args.url]); return { ok: true, status: 200, text: 'TEXT' }; };
  const [source] = node.marketListSources(invoke);
  assert.equal(await source.get(), 'TEXT');
  assert.deepEqual(asked, [['market_http_get', node.SIGNED_LISTS_URL]]);
  // 키가 비어 있으면 소스가 있어도 refresh 가 없다 → 네트워크에 묻지 않는다.
  const ml = lists.marketLists({ storage: null, sources: node.marketListSources(invoke) });
  assert.equal(ml.refresh, undefined);
  assert.equal(ml.current().allowlist, null);
  asked.length = 0; assert.deepEqual(asked, []);
  // 주소 일치: TS 어댑터 = 러스트 중계가 허용하는 유일한 주소 = 지갑 core 의 주소.
  const rust = read('src-tauri/src/market.rs');
  assert.ok(rust.includes(`pub const SIGNED_LISTS_URL: &str = "${node.SIGNED_LISTS_URL}";`));
  assert.equal(node.SIGNED_LISTS_URL, 'https://ravenvault.ex.erci.se/lists/signed-lists.json');
  // 장터 쪽 제작자 키 자리(허용 목록 서명 키)도 비어 있다.
  assert.doesNotMatch(read('core/creator/listing.ts'), /CREATOR_ALLOWLIST_PUBLIC_KEYS[^=]*=\s*(Object\.freeze\()?\[\s*\{/);
});

test('결제 어댑터: 준비는 거래만 만들고(서명·전파 명령 없음), 보내기는 준비 번호만, 잠김일 때만 암호를 한 번 묻는다', async () => {
  const calls = [];
  let locked = true;
  const invoke = async (cmd, args) => {
    calls.push([cmd, args]);
    if (cmd === 'market_purchase_prepare') return { id: 'abc', asset: args.asset, outputs: [{ role: 'seller', address: args.sellerAddress, atoms: args.sellerAtoms }], network_fee_atoms: '226000', total_atoms: '30000226000', seller_atoms: args.sellerAtoms, fee_atoms: args.feeAtoms, chain: 'regtest' };
    if (cmd === 'market_purchase_send') { if (!args.passphrase && locked) throw new Error('지갑이 잠겨 있습니다. 암호가 필요합니다.'); return { txid: 'ab'.repeat(32) }; }
    return null;
  };
  let asked = 0;
  const buy = node.nodePurchase(invoke, async () => { asked++; return 'pw-fixture'; }, { storage: null, nonce: () => 5 });
  const req = { asset: 'RV.M.A', sellerAddress: 'RSeller', priceAtoms: '30000000000', sellerAtoms: '28500000000', feeAtoms: '1500000000', feeBps: 500, tier: 'bonded' };
  const p = await buy.prepare(req);
  assert.deepEqual(calls.map(c => c[0]), ['market_purchase_prepare']);
  assert.match(calls[0][1].memoScript, /^6a[0-9a-f]+$/);
  assert.equal(calls[0][1].feeAddress, 'RLFnbkjmf1VCVq7D9TZvRp7fv6W97rm2cB', '수수료 주소는 코드 고정값');
  assert.deepEqual(Object.keys(calls[0][1]).sort(), ['asset', 'feeAddress', 'feeAtoms', 'memoScript', 'sellerAddress', 'sellerAtoms']);
  assert.equal(p.id, 'abc'); assert.equal(p.networkFeeAtoms, '226000');
  assert.equal(calls.some(c => /sign|sendraw/i.test(c[0])), false);
  const sent = await buy.send(p);
  assert.equal(sent.txid, 'ab'.repeat(32)); assert.equal(asked, 1);
  assert.deepEqual(calls.slice(1).map(c => [c[0], Object.keys(c[1]).sort().join()]), [['market_purchase_send', 'id'], ['market_purchase_send', 'id,passphrase']]);
  // 잠겨 있지 않으면 암호를 묻지 않는다 / 다른 오류는 그대로 던진다.
  locked = false; asked = 0; assert.equal((await buy.send(p)).txid.length, 64); assert.equal(asked, 0);
  await assert.rejects(() => node.nodePurchase(async () => { throw new Error('SENT_UNKNOWN: x'); }, async () => 'pw').send(p), /SENT_UNKNOWN/);
  await assert.rejects(() => node.nodePurchase(async () => { throw new Error('지갑이 잠겨 있습니다.'); }, async () => null).send(p), /비밀번호가 필요/);
  // 수수료 0 이면 수수료 주소를 보내지 않는다.
  calls.length = 0; await buy.prepare({ ...req, sellerAtoms: '30000000000', feeAtoms: '0' });
  assert.equal(calls[0][1].feeAddress, null);
});

test('화면 코드는 서명·전파·잠금 해제를 직접 부르지 않는다(돈 길은 러스트 두 단계 명령뿐)', () => {
  for (const f of ['src/open-market.ts', 'src/market-node.ts']) {
    const t = read(f);
    for (const bad of ['signrawtransaction', 'sendrawtransaction', 'sendtoaddress', 'walletpassphrase', 'send_rvn', 'send_asset']) assert.ok(!t.includes(bad), `${f} 가 ${bad} 를 부른다`);
  }
  const m = read('src/open-market.ts');
  // purchase.send 는 「승인하고 보내기」 단추 핸들러 안에서, 준비된 거래가 있을 때만 불린다.
  assert.equal((m.match(/purchase\.send\(/g) ?? []).length, 1);
  const handler = m.slice(m.indexOf('payBtn().onclick'));
  assert.ok(handler.indexOf('purchase.send(') > handler.indexOf('if (deps.purchase && !prepared) return;'));
  assert.ok(m.slice(0, m.indexOf('payBtn().onclick')).indexOf('purchase.send(') === -1);
});

test('문구: 새 장터 문구에 금지어가 없고, 사실 문구 세 가지(자산을 받지 않음 · 공개 IPFS · 환불 불가)가 모두 들어 있다', () => {
  const all = copy.allMarketCopy().join('\n');
  const banned = ['소유권', '독점', '영구 보관', '영구보관', '보장', '수익', '투자', '안전하게', '암호화', '구매자 전용', '지켜져', '100%', '반드시 오릅', '무료로 받', '정품', '인증된', '공식 판매'];
  for (const w of banned) assert.ok(!all.includes(w), `금지어 「${w}」`);
  assert.match(all, /내 지갑으로 오지 않고, 내 지갑에 새 자산이 생기지 않아요/);
  assert.match(all, /공개 IPFS.*누구나 받을 수 있어서.*권한을 만들어 주지는 않아요/);
  assert.match(all, /되돌릴 수 없어요.*대신 돌려줄 수 없고/);
  assert.match(all, /시험 단계예요.*아직 정해지지 않았어요/);
  // 확인 화면 단추는 「구매」「사기」가 아니라 하는 일 그대로.
  assert.equal(copy.BUTTON_APPROVE, '승인하고 보내기'); assert.equal(copy.BUTTON_DETAIL, '결제 내용 보기');
  const html = read('index.html');
  const market = html.slice(html.indexOf('id="page-market"'), html.indexOf('id="page-ravi"'));
  for (const w of banned) assert.ok(!market.includes(w), `장터 화면 금지어 「${w}」`);
  assert.ok(market.includes(copy.BUTTON_APPROVE) && market.includes(copy.BUTTON_DETAIL) && market.includes(copy.PURCHASES_TITLE));
  assert.doesNotMatch(market, /구매하기|이 금액으로 사기/);
  // 신고 안내는 처리 정책을 약속하지 않는다.
  assert.match(copy.REPORT_NOTE, /정해지는 중이라 지금은 약속할 수 없어요/);
});

test('1단계 제한·스위치 기본값: 커밋된 verifiedOnly 는 true, 그 값이 장터 코드에 연결돼 있다', () => {
  assert.equal(SW.verifiedOnly, true, '1단계 제한(검증됨 전용)이 풀린 채 커밋됐다');
  assert.ok(read('src/open-market.ts').includes("deps.verifiedOnly ?? MAINNET_SWITCH.verifiedOnly"));
  assert.ok(read('src/open-market.ts').includes('!payGate(l).ok'), '결제 단추 핸들러가 게이트를 다시 본다');
});

test('C8 소각액: 러스트 상수(issue.rs·issue2.rs)와 TS BURN_RVN 이 서로 같다 · 체인과는 대조하지 못했음이 화면에 남는다', async () => {
  const rust = read('src-tauri/src/issue.rs') + read('src-tauri/src/issue2.rs');
  const num = name => Number(rust.match(new RegExp(`pub const ${name}: f64 = ([0-9.]+);`))?.[1]);
  const asset = await moduleAt('core/creator/asset-name.ts');
  assert.deepEqual({ root: num('BURN_ROOT'), sub: num('BURN_SUB'), unique: num('BURN_UNIQUE'), reissue: num('BURN_REISSUE') }, { ...asset.BURN_RVN });
  assert.deepEqual([num('BURN_ROOT'), num('BURN_SUB'), num('BURN_UNIQUE'), num('BURN_REISSUE'), num('BURN_QUALIFIER'), num('BURN_RESTRICTED')], [500, 100, 5, 100, 1000, 1500]);
  const ui = read('src/creator-publish.ts');
  assert.match(ui, /시험망 대조 필요/);
  assert.match(ui, /cw-c-total/);
  assert.match(read('index.html'), /id="cw-c-total"/);
  const b = asset.burnCheck('root', null);
  assert.equal(b.status, 'unverifiable'); assert.equal(b.rvn, 500);
});

test('신고·숨김: 신고는 메일(자리표시 정책), 숨김은 이 컴퓨터 목록만 · 서명된 차단 목록 장치는 그대로', () => {
  const m = read('src/open-market.ts');
  assert.ok(m.includes('mailto:${T.REPORT_CONTACT}'));
  assert.ok(m.includes("HIDDEN_KEY = 'rv-market-hidden-v1'"));
  assert.ok(read('core/creator/listing.ts').includes("reason: 'denied'"), '서명된 차단 목록(denylist)이 목록을 숨기는 기존 장치');
  assert.equal(copy.REPORT_CONTACT, 'playx@ex.erci.se');
});
