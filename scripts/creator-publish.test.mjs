// Creator publish (desktop): vendored core is byte-pinned; adapters call only the expected existing commands;
// the pure rules work in the desktop bundle. No network, no real IPFS, no node, no real issuance. Throwaway keys only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { build } from 'esbuild';

async function moduleAt(path) {
  const built = await build({ entryPoints: [path], bundle: true, write: false, platform: 'node', format: 'cjs', logLevel: 'silent' });
  const mod = { exports: {} };
  new Function('require', 'exports', 'module', built.outputFiles[0].text)(createRequire(import.meta.url), mod.exports, mod);
  return mod.exports;
}
const digest = p => createHash('sha256').update(readFileSync(p)).digest('hex');
const pins = JSON.parse(readFileSync('core/creator/vendor-sha256.json', 'utf8'));
const ui = await moduleAt('src/creator-publish.ts');
const core = await moduleAt('scripts/fixtures/creator-core-entry.ts');
const enc = s => new TextEncoder().encode(s);
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 73, 72, 68, 82]);

test('vendored creator core is byte-identical to the pinned copy (and to the wallet source when present)', t => {
  const files = Object.keys(pins.files);
  assert.equal(files.length, 12);
  for (const f of files) assert.equal(digest(f), pins.files[f], `vendored drift: ${f}`);
  const root = process.env.RV_WALLET_CORE || '/Users/gimmusong/wt-rv-signed-lists-core';
  if (!existsSync(`${root}/core/creator/manifest.ts`)) { t.skip('wallet checkout absent; pinned hashes still checked'); return; }
  for (const f of files) assert.equal(digest(f), digest(`${root}/${f}`), `differs from wallet source: ${f}`);
});

test('kubo pin adapter = existing ipfs_add_file (CIDv0, pinned); signer = sign_message, password only after a lock error', async () => {
  const calls = [];
  const invoke = async (cmd, args) => {
    calls.push([cmd, Object.keys(args ?? {}).sort().join()]);
    if (cmd === 'ipfs_add_file') return { cid: core.mockCid(Uint8Array.from(args.file.bytes)), name: args.file.name, size: args.file.bytes.length };
    if (cmd === 'sign_message') { if (!args.passphrase) throw new Error('지갑이 잠겨 있습니다. 암호가 필요합니다.'); return { signature: 'sig' }; }
    if (cmd === 'issue_asset') return { txid: 'ab'.repeat(32), owner_token: 'X!' };
    throw new Error('unexpected ' + cmd);
  };
  const pin = ui.kuboPinAdapter(invoke);
  assert.equal(pin.real, true); assert.match(pin.holder, /이 컴퓨터/);
  const r = await pin.add('img/hero.png', PNG);
  assert.equal(r.size, PNG.length); assert.match(r.cid, /^Qm[1-9A-HJ-NP-Za-km-z]{44}$/);
  assert.deepEqual(calls.shift(), ['ipfs_add_file', 'file']);
  let asked = 0;
  const sig = await ui.nodeSigner(invoke, async () => { asked++; return 'pw-fixture'; })('RAddr', 'msg');
  assert.equal(sig, 'sig'); assert.equal(asked, 1);
  assert.deepEqual(calls.splice(0), [['sign_message', 'address,message'], ['sign_message', 'address,message,passphrase']]);
  await assert.rejects(() => ui.nodeSigner(invoke, async () => null)('RAddr', 'msg'), /비밀번호/);
  calls.splice(0);
  const issued = await ui.nodeIssuer(invoke).issue({ name: 'RV.G.STAR_RUN', qty: 1, units: 0, reissuable: true, ipfsHash: 'Qm' + '1'.repeat(44) });
  assert.equal(issued.txid, 'ab'.repeat(32));
  assert.deepEqual(calls, [['issue_asset', 'ipfsHash,name,qty,reissuable,toAddress,units']]);
  await assert.rejects(() => ui.nodeIssuer(async () => ({})).issue({ name: 'X', qty: 1, units: 0, reissuable: true, ipfsHash: 'x' }), /거래 번호/);
});

test('desktop bundle: publish → verify → plan (root RV.<kind>., anyone, 500 RVN bond, kind letter = type, mainnet off, burn 「확인 불가」, unknown duplicate blocks)', async () => {
  const key = core.randomKey();
  const address = core.addressOf(key);
  const pin = new core.MockPinAdapter();
  const result = await core.publishContent({
    type: 'game', asset: 'RV.G.STAR_RUN', title: '별 달리기', description: '', creatorAddress: address, receivingAddress: address,
    files: [{ path: 'index.html', bytes: enc('<!doctype html><script src="a.js"></script>'), mime: 'text/html' }, { path: 'a.js', bytes: enc('1'), mime: '' },
      { path: 'cover.png', bytes: PNG, mime: 'image/png', role: 'cover' }],
    priceAtoms: '30000000000', declaredFeeBps: 1500, details: { entry: 'index.html', origin: null, capabilities: { identity: false, payment: false } }, now: new Date('2026-10-10T00:00:00Z'),
  }, pin, async (_a, m) => core.signMessageForTest(m, key));
  const v = core.verifyManifest(result.manifestBytes, { expectedAsset: 'RV.G.STAR_RUN' });
  assert.equal(v.signedBy, address);
  const base = { asset: 'RV.G.STAR_RUN', manifestCid: result.manifestCid, ownedAssets: [], nameTaken: false, chainBurnRvn: null, typedName: 'RV.G.STAR_RUN', type: 'game' };
  assert.equal(core.planIssue({ ...base, chain: 'regtest' }).canIssue, true, 'no owner token needed');
  assert.ok(core.planIssue({ ...base, chain: 'regtest', type: 'music' }).blockers.some(b => b.includes('종류 글자')), 'kind letter must match the manifest type');
  assert.ok(core.planIssue({ ...base, chain: 'regtest', nameTaken: null }).blockers.some(b => b.includes('확인 불가')), 'unknown duplicate blocks');
  const main = core.planIssue({ ...base, chain: 'main' });
  assert.equal(main.canIssue, false); assert.ok(main.blockers.some(b => b.includes('실제 발행은 아직 꺼져 있어요')));
  assert.equal(core.REAL_MAINNET_ISSUE_ENABLED, false); assert.equal(core.OPEN_MARKET_SALES_ENABLED, false);
  assert.equal(main.burn.status, 'unverifiable'); assert.equal(main.burn.rvn, 500);
});

test('cid_alive probe adapter uses the existing command with a bounded timeout', async () => {
  const calls = [];
  const probe = ui.nodeProbe(async (cmd, args) => { calls.push([cmd, args]); return args.cid.endsWith('A'); });
  assert.equal(await probe('Qm' + 'A'.repeat(44)), true); assert.equal(await probe('Qm' + 'B'.repeat(44)), false);
  assert.deepEqual(calls[0], ['cid_alive', { cid: 'Qm' + 'A'.repeat(44), timeoutSecs: 20 }]);
});

test('creator page is seller-only and route-guarded in source (same pattern as the sales page)', () => {
  const html = readFileSync('index.html', 'utf8'), main = readFileSync('src/main.ts', 'utf8');
  assert.match(html, /<section class="page" id="page-creator" data-seller-only hidden inert>/);
  assert.match(html, /<button type="button" id="creator-open" data-seller-only hidden inert>/);
  assert.match(html, /<section class="page" id="page-market" data-seller-only hidden inert>/);
  assert.match(html, /<button type="button" id="market-open" data-seller-only hidden inert>/);
  assert.match(main, /if \(\(id === "sales" \|\| id === "creator" \|\| id === "market"\) && !sellerModeOn\(\)\) return;/);
  assert.match(main, /currentPage === "sales" \|\| currentPage === "creator" \|\| currentPage === "market"\)\) showPage\("settings"\)/);
  // The UI modules never log and never read the seed; signing goes through the node only.
  for (const f of ['src/creator-publish.ts', 'src/open-market.ts']) {
    const src = readFileSync(f, 'utf8');
    assert.doesNotMatch(src, /console\.|mnemonic|reveal_seed/);
    assert.doesNotMatch(src, /signMessageForTest|MockPinAdapter|MockIssuer/, 'no test doubles in the product module');
  }
  // The draft saved for 「이어하기」 holds only public data: field values, CIDs, the signed manifest. Never file bytes or the password.
  const wizard = readFileSync('src/creator-publish.ts', 'utf8');
  const draftType = wizard.slice(wizard.indexOf('type Draft ='), wizard.indexOf('export type MineItem'));
  assert.doesNotMatch(draftType, /bytes|pass|seed|key/i);
  assert.doesNotMatch(wizard.slice(wizard.indexOf('const FIELD_IDS'), wizard.indexOf('const el =')), /pass|seed/i, 'no secret field is saved');
});
