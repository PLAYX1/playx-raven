import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
const root=process.cwd(),out=path.join(root,'docs/handoff-1006');
const files=fs.readdirSync('scripts').filter(n=>n.endsWith('.test.mjs') || (n.startsWith('check-') && n.endsWith('.mjs') && !n.includes('mutation'))).map(n=>'scripts/'+n).concat(['web/wallet.test.mjs','web/customer-mine.test.mjs']);
const results=[];
for(const file of files){
 let code=fs.readFileSync(file,'utf8');
 // Test-only path adapter in memory: all generated artifacts/profiles stay here.
 code=code.replaceAll('import.meta.url',JSON.stringify(pathToFileURL(path.join(root,file)).href))
   .replaceAll('artifacts/', 'docs/handoff-1006/legacy-artifacts/')
   .replaceAll('/Users/gimmusong/rv-test-fixture',path.join(out,'fixtures'))
   .replace(/(from\s*["'])(\.\.?\/[^"']+)(["'])/g,(_,a,b,c)=>a+pathToFileURL(path.resolve(path.dirname(file),b)).href+c);
 const result=spawnSync(process.execPath,['--input-type=module'],{input:code,encoding:'utf8',timeout:90000,maxBuffer:16*1024*1024,env:{...process.env,RV_BACKUP_FIXTURE_ROOT:path.join(out,'fixtures'),TMPDIR:path.join(out,'tmp'),CARGO_TARGET_DIR:path.join(out,'cargo-target')}});
 const output=(result.stdout||'')+(result.stderr||'');
 const reason=result.status===0?'passed': /EPERM|Operation not permitted|PermissionDenied/.test(output)?'sandbox-permission':/Timed out|ETIMEDOUT/.test(output)||result.error?.code==='ETIMEDOUT'?'timeout':/AssertionError/.test(output)?'assertion':/ENOENT|ERR_MODULE_NOT_FOUND|Cannot find/.test(output)?'missing-fixture-or-dependency':'runtime-error';
 // Never persist assertion value dumps or test key/word fixtures in logs.
 const locations=[...output.matchAll(/(?:scripts|web)\/[a-zA-Z0-9_.-]+\.mjs:\d+/g)].map(m=>m[0]);
 const row={file,exit:result.status,signal:result.signal,reason,locations:[...new Set(locations)].slice(0,3)};
 results.push(row);fs.writeFileSync(path.join(out,'existing-tests.json'),JSON.stringify(results,null,2)+'\n');
 console.log(`${file}: ${result.status===0?'PASS':reason}`);
}
