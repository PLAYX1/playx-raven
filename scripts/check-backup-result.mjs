import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { transform } from 'esbuild';
let source = readFileSync(new URL('../src/backup-result.ts', import.meta.url), 'utf8');
if (process.argv.includes('--mutant-omission')) source = source.replace('result.wallet_included !== true', 'false');
const code = (await transform(source, { loader: 'ts', format: 'esm' })).code;
const { requireWalletBackup, restoreIsComplete } = await import('data:text/javascript;base64,' + Buffer.from(code).toString('base64'));
const good = { wallet_included: true, locked: true, verified: true, inside: [{ name: 'wallet.dat', size: 42 }], name: 'synthetic.zip.pxlock' };
assert.equal(requireWalletBackup(good).name, good.name);
for (const bad of [null, {}, { ...good, wallet_included: false }, { ...good, verified: false }, { ...good, locked: false }, { ...good, inside: [] }, { ...good, inside: [{ name: 'wallet.dat', size: 0 }] }]) {
  assert.throws(() => requireWalletBackup(bad), /지갑이 포함된 백업/);
}
console.log('PASS actual UI boundary rejects omitted, empty, unverified and unencrypted wallet backups');

assert.equal(restoreIsComplete({ok:true,status:'complete',done:[{what:'fixture'}],failed:[]}), true);
for (const value of [null, {}, {ok:true,status:'complete',done:[{}],failed:[{changed:true}]}, {ok:false,status:'partial',done:[{}],failed:[]}, {ok:true,status:'complete',done:[],failed:[]}]) assert.equal(restoreIsComplete(value), false);
console.log('PASS partial, failed and empty restores are never complete');
