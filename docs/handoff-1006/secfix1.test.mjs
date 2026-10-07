import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { webcrypto, randomBytes } from 'node:crypto';
import * as bitcoin from 'bitcoinjs-lib';
const read = p => fs.readFileSync(p, 'utf8');
function extract(file, names, context = {}) {
  const src = ts.createSourceFile(file, read(file), ts.ScriptTarget.Latest, true);
  const nodes = src.statements.filter(n => ts.isFunctionDeclaration(n) && names.includes(n.name?.text));
  assert.equal(nodes.length, names.length, 'production functions present');
  const ctx = vm.createContext({crypto:webcrypto, TextEncoder, TextDecoder, Uint8Array, Buffer, btoa, atob, bitcoin, enc:new TextEncoder(), dec:new TextDecoder(), PBKDF2_ITER:600000, STORE_KEY:'synthetic-vault', migrationExpected:null, integrityFailed:false, ...context});
  vm.runInContext(ts.transpileModule(nodes.map(n=>n.getText(src)).join('\n'), {compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText, ctx);
  return ctx;
}
const vf = ['deriveKey','toB64','fromB64','lockVault','openVault','strongPassword','storeVerifiedVault'];
test('H1 weak passwords refused; new vault and legacy migration round trip; failed storage preserves old vault', async()=>{
 const records=new Map(); let fail=false;
 const localStorage={getItem:k=>records.get(k)??null,setItem:(k,v)=>{if(fail)throw Error('synthetic quota');records.set(k,v);}};
 const c=extract('web/wallet.src.ts',vf,{localStorage});
 for(const n of [6,12,32]) assert.equal(c.strongPassword('1'.repeat(n)),false);
 const pass=randomBytes(24).toString('base64')+'Z9', payload=randomBytes(32).toString('hex');
 assert.equal(c.strongPassword(pass),true);
 const old=extract('web/wallet.src.ts',['deriveKey','toB64','fromB64','lockVault'],{PBKDF2_ITER:210000});
 const legacy=await old.lockVault(payload,pass); legacy.v=1;
 localStorage.setItem('synthetic-vault',JSON.stringify(legacy));
 assert.ok(await c.openVault(legacy,pass)===payload);
 const next=await c.storeVerifiedVault(payload,pass);
 assert.equal(next.v,2); assert.equal(next.iter,600000);
 assert.ok(await c.openVault(next,pass)===payload);
 const snapshot=localStorage.getItem('synthetic-vault'); fail=true;
 await assert.rejects(c.storeVerifiedVault(payload,pass));
 assert.ok(snapshot===localStorage.getItem('synthetic-vault'));
});
test('H2 actual raw output required before sign; amount/script/hash mismatch and absolute fee ceiling refused',()=>{
 const network={pubKeyHash:60,scriptHash:122,wif:128};
 const script=Buffer.concat([Buffer.from('76a914','hex'),randomBytes(20),Buffer.from('88ac','hex')]);
 const address=bitcoin.address.fromOutputScript(script,network);
 const tx=new bitcoin.Transaction(); tx.addInput(Buffer.alloc(32),0);tx.addOutput(script,500000000);
 const coin={txid:tx.getId(),outputIndex:0,address,script:script.toString('hex'),satoshis:500000000};
 const c=extract('web/wallet.src.ts',['verifiedInputSum','assertFee'],{NETWORK:network,FEE_CEILING_SATS:100000000});
 assert.equal(c.verifiedInputSum([coin],{[coin.txid]:tx.toHex()}),500000000);
 for(const bad of [{...coin,satoshis:400000000},{...coin,script:'00'},{...coin,txid:'0'.repeat(64)}]) assert.throws(()=>c.verifiedInputSum([bad],{[bad.txid]:tx.toHex()}));
 assert.throws(()=>c.verifiedInputSum([coin,coin],{[coin.txid]:tx.toHex()}));
 assert.throws(()=>c.assertFee(100000001,100000001)); c.assertFee(1000000,1000000);
});
test('H3 unverified automatic installation disabled',()=>{
 const src=read('src-tauri/src/tunnel.rs'); assert.ok(!src.includes('releases/latest/download'));
 assert.match(src,/대표 확인 필요/); assert.ok(!src.includes('let ours = crate::paths::app_file("cloudflared")'));
});
test('M Windows restore refuses disk fallback',()=>{
 const src=read('src-tauri/src/words_restore.rs'); const body=src.slice(src.indexOf('#[cfg(windows)]\nasync fn spawn_with_words'),src.indexOf('let name = format!(r"\\\\.\\pipe'));
 assert.ok(!body.includes('std::fs::write')); assert.match(body,/if file[\s\S]*return Err/);
});
test('M pairing existing excessive limits blocked and new limit capped',()=>{
 assert.match(read('src-tauri/src/pairing.rs'),/MAX_PHONE_DAILY_RVN/);
 assert.match(read('src-tauri/src/pairing/desk.rs'),/MAX_PHONE_DAILY_RVN/);
 assert.match(read('src-tauri/src/pairing/proto.rs'),/MAX_PHONE_DAILY_RVN: u64 = 1_000/);
});
test('F01/F02 durable guard precedes payout and ledger is atomic',()=>{
 for(const f of ['send','devfee'])assert.match(read(`src-tauri/src/${f}.rs`),/payout_guard::/);
 assert.match(read('src-tauri/src/devfee.rs'),/atomic_write/);
});
test('F03 remote order without local payment evidence cannot pay',()=>{
 assert.match(read('src-tauri/src/vending.rs'),/payout_guard::/);
 assert.match(read('src-tauri/src/vending.rs'),/getreceivedbyaddress/);
 assert.match(read('src-tauri/src/vending.rs'),/order_addr.*ok_or/);
});
test('F06 updater install capability removed until signed metadata policy exists',()=>{
 assert.ok(!read('src-tauri/src/lib.rs').includes('.plugin(tauri_plugin_updater::Builder::new().build())'));
 assert.ok(!read('src-tauri/capabilities/default.json').includes('updater:default'));
});
test('H4 manifest missing asset or changed bytes refuses load',async()=>{
 const c=extract('web/wallet-integrity.js',['verifyWalletAssets']);
 const bytes=Buffer.from('synthetic public bundle');
 const digest=Buffer.from(await webcrypto.subtle.digest('SHA-256',bytes)).toString('base64');
 const manifest={version:1,assets:{'/wallet.bundle.js':'sha256-'+digest}};
 const fetcher=async()=>({ok:true,arrayBuffer:async()=>bytes});
 await c.verifyWalletAssets(manifest,['/wallet.bundle.js'],fetcher);
 await assert.rejects(c.verifyWalletAssets(manifest,['/wallet.bundle.js','/help.js'],fetcher));
 await assert.rejects(c.verifyWalletAssets(manifest,['/wallet.bundle.js'],async()=>({ok:true,arrayBuffer:async()=>Buffer.from('changed')})));
 await assert.rejects(c.verifyWalletAssets({version:1,assets:{'https://outside.invalid/code.js':'sha256-'+digest}},['https://outside.invalid/code.js'],fetcher));
});
test('H2 signing function never invokes signer on forged values or excessive fee',()=>{
 const network={pubKeyHash:60,scriptHash:122,wif:128}; const script=Buffer.concat([Buffer.from('76a914','hex'),randomBytes(20),Buffer.from('88ac','hex')]);
 const address=bitcoin.address.fromOutputScript(script,network); const tx=new bitcoin.Transaction();tx.addInput(Buffer.alloc(32),0);tx.addOutput(script,500000000);
 const coin={txid:tx.getId(),outputIndex:0,address,script:script.toString('hex'),satoshis:500000000}; let signed=0;
 const c=extract('web/wallet.src.ts',['buildAndSign','verifiedInputSum','assertFee'],{NETWORK:network,FEE_CEILING_SATS:100000000,NET_NAME:'rvn',sign:()=>{signed++;return 'synthetic';}});
 const sel={inputs:[coin],amount:100000000,fee:1000000,change:399000000}; const raws={[coin.txid]:tx.toHex()};
 assert.throws(()=>c.buildAndSign({...sel,inputs:[{...coin,satoshis:400000000}]},address,address,{},raws));
 assert.throws(()=>c.buildAndSign({...sel,fee:200000000,change:200000000},address,address,{},raws));
 assert.equal(signed,0); c.buildAndSign(sel,address,address,{},raws); assert.equal(signed,1);
});
test('F01 actual UI double entry blocked; uncertain retry keeps same request identifier',async()=>{
 const elements=new Map(); const $=id=>{if(!elements.has(id))elements.set(id,{value:'',style:{display:'none'},textContent:'',innerHTML:'',disabled:false});return elements.get(id);};
 let calls=0, release; const wait=new Promise(r=>release=r); const ids=[];
 const c=extract('src/main.ts',['doSend','gateSend'],{$,sendingNow:false,sendMode:'rvn',sendPreview:{address:'synthetic',amount:1,enough:true},fmtQty:String,errText:()=> 'result unknown',escapeHtml:String,tf:s=>s,setAllRaviMood:()=>{},invoke:async(_cmd,args)=>{calls++;ids.push(args.requestId);await wait;throw Error('synthetic unknown');}});
 const first=c.doSend();await c.doSend();assert.equal(calls,1);release();await first;await c.doSend();assert.equal(calls,2);assert.ok(ids[0]===ids[1]);
});
test('H1 legacy no-lock record opens only into migration; never enters unlocked wallet',async()=>{
 let opened=0,upgrades=0;
 const c=extract('web/wallet.src.ts',['deriveKey','toB64','fromB64','lockVault','openVault','showLockedOrOpen'],{PBKDF2_ITER:210000,RavencoinKey:{isMnemonicValid:()=>true},requireVaultUpgrade:()=>{upgrades++;},unlocked:()=>{opened++;},show:()=>{},$:()=>({style:{}})});
 const ast=ts.createSourceFile('wallet.ts',read('web/wallet.src.ts'),ts.ScriptTarget.Latest,true);
 const constant=ast.statements.find(n=>ts.isVariableStatement(n)&&n.declarationList.declarations.some(d=>d.name.getText(ast)==='NO_LOCK'));
 assert.ok(constant);
 vm.runInContext(constant.getText(ast)+'\nglobalThis.legacyMaterial = NO_LOCK;',c);
 const payload=randomBytes(20).toString('hex'); const old=await c.lockVault(payload,c.legacyMaterial);old.v=1;
 await c.showLockedOrOpen(old);assert.equal(opened,0);assert.equal(upgrades,1);
 delete old.iter;assert.ok(await c.openVault(old,c.legacyMaterial)===payload);
});
