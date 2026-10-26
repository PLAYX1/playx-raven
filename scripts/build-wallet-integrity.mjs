import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
const base=new URL('../web/',import.meta.url);
const html=readFileSync(new URL('wallet.html',base),'utf8');
const paths=[...html.matchAll(/data-wallet-src="([^"]+)"/g)].map(m=>m[1]);
if(!paths.includes('/wallet.bundle.js') || new Set(paths).size!==paths.length) throw Error('Missing/duplicate wallet entrypoint');
const assets={};
for(const path of paths){
 if(!/^\/[a-z0-9.-]+\.js$/.test(path))throw Error('External script refused');
 assets[path]='sha256-'+createHash('sha256').update(readFileSync(new URL(path.slice(1),base))).digest('base64');
}
const sourceDigest=createHash('sha256').update(readFileSync(new URL('wallet.src.ts',base))).digest('hex');
const expected=JSON.stringify({version:1,sourceDigest,assets},null,2)+'\n';
if(process.argv.includes('--check')){
 if(readFileSync(new URL('wallet-integrity.json',base),'utf8')!==expected)throw Error('Wallet integrity manifest is stale; run bash web/build.sh');
}else writeFileSync(new URL('wallet-integrity.json',base),expected);
console.log(`wallet integrity: ${paths.length} scripts`);
