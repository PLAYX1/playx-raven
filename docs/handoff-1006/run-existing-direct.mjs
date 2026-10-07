import fs from'node:fs';import{spawnSync}from'node:child_process';import path from'node:path';
const out=path.resolve('docs/handoff-1006');
const prior=JSON.parse(fs.readFileSync(path.join(out,'existing-tests.json'),'utf8'));
const rows=[];
for(const row of prior){
 if(row.reason==='passed'){rows.push(row);continue;}
 const args=['--require',path.join(out,'test-paths.cjs'),row.file];
 if(row.file.includes('restore-vectors'))args.push('--no-core');
 const r=spawnSync(process.execPath,args,{encoding:'utf8',timeout:120000,maxBuffer:32*1024*1024,env:{...process.env,CARGO_NET_OFFLINE:'true',RV_BACKUP_FIXTURE_ROOT:path.join(out,'fixtures'),TMPDIR:path.join(out,'tmp'),CARGO_TARGET_DIR:path.join(out,'cargo-target')}});
 const output=(r.stdout||'')+(r.stderr||'');
 const reason=r.status===0?'passed':/EPERM|Operation not permitted|PermissionDenied/.test(output)?'sandbox-permission':/Timed out|ETIMEDOUT/.test(output)||r.error?.code==='ETIMEDOUT'?'timeout':/AssertionError/.test(output)?'assertion':/ENOENT|ERR_MODULE_NOT_FOUND|Cannot find|no matching package/.test(output)?'missing-fixture-or-dependency':'runtime-error';
 rows.push({file:row.file,exit:r.status,signal:r.signal,reason});
 fs.writeFileSync(path.join(out,'existing-final.json'),JSON.stringify(rows,null,2)+'\n');
 console.log(`${row.file}: ${r.status===0?'PASS':reason}`);
}
fs.writeFileSync(path.join(out,'existing-final.json'),JSON.stringify(rows,null,2)+'\n');
