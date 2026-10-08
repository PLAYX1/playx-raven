import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createHash, pbkdf2Sync } from 'node:crypto';
import { build } from 'esbuild';
import vm from 'node:vm';
import ts from 'typescript';

async function moduleAt(path) {
  const built = await build({ entryPoints: [path], bundle: true, write: false, platform: 'node', format: 'cjs', logLevel: 'silent' });
  const mod = { exports: {} };
  new Function('require', 'exports', 'module', built.outputFiles[0].text)(createRequire(import.meta.url), mod.exports, mod);
  return mod.exports;
}
const keys = await moduleAt('core/wallet-keys/derive.ts');
const publicKeys = await moduleAt('core/official-sales/xpub.ts');
const fixtures = JSON.parse(readFileSync('scripts/fixtures/restore-vectors.json', 'utf8')).vectors;
const vectorPath = 'scripts/fixtures/sales-public-vectors.json';
function seedOf(v) { return pbkdf2Sync(v.mnemonic.normalize('NFKD'), `mnemonic${v.passphrase.normalize('NFKD')}`, 2048, 64, 'sha512'); }
if (process.argv.includes('--write-public-vectors')) {
  const output = fixtures.map((v, fixtureIndex) => {
    const seed = seedOf(v);
    try { const account = keys.deriveAccount(seed, 100); return { fixtureIndex, xpub: account.xpub,
      addresses: [0, 1, 2, 99, 100, 9999].map(index => ({ index, address: account.deriveAddress({ change: 0, index }).address })) }; }
    finally { seed.fill(0); }
  });
  writeFileSync(vectorPath, JSON.stringify(output, null, 2) + '\n');
}
const vectors = JSON.parse(readFileSync(vectorPath, 'utf8'));

test('phone/web core public vectors: account 100, both derivation paths, boundary addresses', async () => {
  for (const row of vectors) {
    const seed = seedOf(fixtures[row.fixtureIndex]);
    try {
      const account = keys.deriveAccount(seed, 100);
      assert.ok(account.xpub === row.xpub, 'account mismatch');
      for (const v of row.addresses) {
        assert.ok(account.deriveAddress({ change: 0, index: v.index }).address === v.address, 'phone address mismatch');
        assert.ok(await publicKeys.deriveSalesAddress(row.xpub, 100, v.index) === v.address, 'desktop address mismatch');
      }
    } finally { seed.fill(0); }
  }
  for (const [account, index] of [[0, 0], [100, -1], [100, 1.5], [100, 1000001]]) {
    await assert.rejects(() => publicKeys.deriveSalesAddress(vectors[0].xpub, account, index));
  }
  await assert.rejects(() => publicKeys.deriveSalesAddress('invalid', 100, 0));
});

test('vendored phone sources remain byte-identical; reference cross-check when available', async t => {
  const root = '/Users/gimmusong/wt-rv-web1008';
  if (!existsSync(`${root}/core/wallet-keys/derive.ts`)) { t.skip('reference checkout absent; committed vectors still tested'); return; }
  for (const path of ['core/wallet-keys/derive.ts', 'core/wallet-keys/sales-account.ts', 'core/official-sales/xpub.ts', 'core/wallet-offline/base58check.ts']) {
    const digest = p => createHash('sha256').update(readFileSync(p)).digest('hex');
    assert.ok(digest(path) === digest(`${root}/${path}`), 'vendored source drift');
  }
  const phone = await moduleAt(`${root}/core/wallet-keys/derive.ts`);
  for (const row of vectors) {
    const seed = seedOf(fixtures[row.fixtureIndex]);
    try { assert.ok(phone.deriveAccount(seed, 100).xpub === row.xpub, 'original phone xpub mismatch'); }
    finally { seed.fill(0); }
  }
});

test('disclosure expires at exactly one minute and rejects late/cancelled auth', async () => {
  const { salesDisclosure, SALES_TTL } = await moduleAt('src/sales-account.ts');
  let now = 0; const state = salesDisclosure(() => now); const data = { xpub: 'public fixture', addresses: [] };
  let at = state.begin(); state.hide(); assert.equal(state.publish(at, data), false);
  at = state.begin(); assert.equal(state.publish(at, data), true);
  now = SALES_TTL - 1; assert.ok(state.read()); now++; assert.equal(state.read(), null);
  at = state.begin(); const newer = state.begin(); assert.equal(state.publish(at, data), false);
  assert.equal(state.publish(newer, data), true); state.hide(); assert.equal(state.read(), null);
});

test('game uses the fixed OS external browser URL', async () => {
  const links = await moduleAt('src/desktop-links.ts'); const calls = [];
  await links.openRaviStory({ openExternal: async url => calls.push(url) });
  assert.deepEqual(calls, ['https://ravenvault.ex.erci.se/game/ravi-story']);
  await assert.rejects(() => links.openRaviStory({ openExternal: async () => { throw Error(); } }));
  const main = readFileSync('src/main.ts', 'utf8');
  assert.ok(main.includes('openRaviStory({ openExternal: openUrl })'));
  const html = readFileSync('index.html', 'utf8');
  const nav=html.slice(html.indexOf('<nav>'),html.indexOf('</nav>'));
  assert.ok(nav.includes('data-page="sales"') && nav.includes('data-page="games"'));
  assert.ok(html.trim().endsWith('</html>'));
  assert.ok(html.includes('id="ravi-story-open"')); assert.ok(!/<iframe[^>]*ravi-story/.test(html));
});

test('native boundary contains only read/auth RPCs and always relocks after derivation', () => {
  const source = readFileSync('src-tauri/src/sales_account.rs', 'utf8');
  assert.ok(!/sendrawtransaction|sendtoaddress|importprivkey|dumpprivkey|console\.|println!/.test(source));
  assert.ok(source.includes('state["unlocked_until"].as_i64().is_none()'));
  assert.ok(source.includes('let locked = rpc.call("walletlock", json!([])).await'));
  assert.ok(readFileSync('src-tauri/src/lib.rs','utf8').includes('sales_account::sales_account_reveal'));
});

// Execute the real UI controller against a minimal DOM and delayed native mocks.
test('UI: reveal/copy/QR, 100-address refresh, errors, blur and stale replies', async () => {
  class Element {
    textContent = ''; disabled = false; children = []; onclick;
    replaceChildren(...items) { this.children = items; }
  }
  const els = new Map(); const el = id => { if (!els.has(id)) els.set(id, new Element()); return els.get(id); };
  const events = {}, timers = []; let resolveAuth, failBalance = false, copied = '', calls = [];
  const doc = { hidden: false, getElementById: el, createElement: () => new Element(), addEventListener: (event, fn) => { events[event] = fn; } };
  const exports = {};
  const code = ts.transpileModule(readFileSync('src/sales-account.ts','utf8'), {compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
  vm.runInNewContext(code, { exports, require: p => p.includes('official-sales') ? publicKeys : { SALES_ACCOUNT_INDEX: 100 }, document: doc,
    window: {addEventListener:(event,fn)=>{events[event]=fn;}}, navigator: { clipboard: {writeText: async value=>{copied=value;}} },
    setTimeout: (fn, delay) => {timers.push({fn,delay}); return timers.length;}, clearTimeout: ()=>{}, Date, BigInt, encodeURIComponent });
  const invoke = async (command, args) => {
    calls.push(command);
    if (command === 'sales_account_reveal') return new Promise(resolve => {resolveAuth=resolve;});
    if (command === 'qr_svg') return '<svg></svg>';
    if (command === 'sales_account_balance') {
      assert.equal(args.addresses.length,100); assert.equal(new Set(args.addresses).size,100);
      if (failBalance) throw Error('synthetic error');
      return {confirmedSats:'123456789',checked:100};
    }
    throw Error('unexpected native command');
  };
  const screen = exports.wireSalesAccount({invoke,ask:async()=>String.fromCharCode(120),active:()=>true});
  let task=el('sales-reveal').onclick(); await new Promise(resolve=>setImmediate(resolve)); events.blur(); resolveAuth(vectors[0].xpub); await task;
  assert.equal(el('sales-public').children.length,0,'blur must discard late auth');
  task=el('sales-reveal').onclick(); await new Promise(resolve=>setImmediate(resolve)); resolveAuth(vectors[0].xpub); await task;
  assert.equal(el('sales-public').children.length,6); assert.equal(timers.at(-1).delay,60000);
  await el('sales-copy').onclick(); assert.ok(copied===vectors[0].xpub);
  await el('sales-refresh').onclick(); assert.match(el('sales-balance').textContent,/1\.23456789 RVN/);
  failBalance=true; await el('sales-refresh').onclick(); assert.match(el('sales-balance').textContent,/확인 실패/);
  timers.at(-1).fn(); assert.equal(el('sales-public').children.length,0); assert.equal(el('sales-copy').disabled,true);
  screen.hide(); assert.ok(calls.every(c=>['sales_account_reveal','qr_svg','sales_account_balance'].includes(c)));
});
