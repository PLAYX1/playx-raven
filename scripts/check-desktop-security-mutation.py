#!/usr/bin/env python3
"""Synthetic production-defect injection. Restore exact bytes without Git writes."""
from pathlib import Path
import os, re, subprocess, sys
root = Path(__file__).resolve().parent.parent
files = {name: root / 'src-tauri/src' / name for name in ['server.rs','upload.rs','refund.rs','nostrpub.rs']}
original = {name: path.read_text() for name, path in files.items()}
mutated = dict(original)
def replace(name, before, after):
    assert mutated[name].count(before) == 1, (name, before, mutated[name].count(before))
    mutated[name] = mutated[name].replace(before, after, 1)
replace('server.rs', 'if !inner && (private_api || req.headers().contains_key("x-playx-token") || secret_query)', 'if false && !inner && (private_api || req.headers().contains_key("x-playx-token") || secret_query)')
replace('server.rs', 'authed_for_reason(&st, &headers, &json!({}), "/api/keepphoto")', 'Ok::<String, AuthFail>("owner".into())')
replace('server.rs', '(StatusCode::FORBIDDEN, crate::moving::HTTP_MOVE_GUIDANCE)', '(StatusCode::OK, crate::moving::HTTP_MOVE_GUIDANCE)')
a=mutated['server.rs'].index('    if !local_host || !peer.is_some_and');b=mutated['server.rs'].index(' {\n        return',a)
mutated['server.rs']=mutated['server.rs'][:a]+'    if false'+mutated['server.rs'][b:]
replace('upload.rs','            !(v.is_private() || v.is_loopback() || v.is_link_local() || v.is_multicast()', '            true || !(v.is_private() || v.is_loopback() || v.is_link_local() || v.is_multicast()')
# Make a previously accepted ordinary media URL fail the public-IP regression,
# and remove the streaming size limit; both are observable assertion defects.
replace('upload.rs','if chunk.len() > MAX_PHOTO_BYTES.saturating_sub(bytes.len())', 'if false && chunk.len() > MAX_PHOTO_BYTES.saturating_sub(bytes.len())')
replace('nostrpub.rs','if !crate::relay::verify(event)', 'if false && !crate::relay::verify(event)')
replace('nostrpub.rs','if self.times.len() >= 20 || self.times.iter().filter(|(_,key)| key == pubkey).count() >= 4', 'if false && (self.times.len() >= 20 || self.times.iter().filter(|(_,key)| key == pubkey).count() >= 4)')
replace('refund.rs','    store.save(&journal)?; // Never call even a read RPC before durable admission.', '    // INJECTED DEFECT: omit durable reservation before RPC.')
replace('refund.rs','if used+usd>STAFF_DAY_USD+1e-9', 'if false && used+usd>STAFF_DAY_USD+1e-9')
replace('refund.rs','if let Some(r)=journal.reservations.iter().find(|r|r.request_id==id)', 'if let Some(r)=journal.reservations.iter().find(|_|false)')
replace('refund.rs','if addresses.len()!=1 || addresses[0]!=to', 'if false && (addresses.len()!=1 || addresses[0]!=to)')
replace('refund.rs','if spent.checked_add(refund_sats).is_none_or(|n|n>total_sats) || paid.iter().map(|r|r.amount).sum::<f64>()+amount>total+1e-8', 'if false && (spent.checked_add(refund_sats).is_none_or(|n|n>total_sats) || paid.iter().map(|r|r.amount).sum::<f64>()+amount>total+1e-8)')
artifact=root/'artifacts/desktop-security';artifact.mkdir(parents=True,exist_ok=True)
results=[]
try:
    for name,path in files.items(): path.write_text(mutated[name])
    for module,expected in [('desktop_security_tests',4),('photo_security_tests',2),('staff_security_tests',4),('publish_security_tests',2)]:
        env=dict(os.environ);env['RV_BACKUP_FIXTURE_ROOT']=str(Path.home()/'rv-test-fixture')
        command=['cargo','test','--lib',module,'--','--nocapture']
        result=subprocess.run(command,cwd=root/'src-tauri',env=env,text=True,stdout=subprocess.PIPE,stderr=subprocess.STDOUT)
        (artifact/f'mutation-{module}.log').write_text(result.stdout)
        failures=result.stdout.count('assertion `') + result.stdout.count('assertion failed:')
        assert result.returncode==101 and 'could not compile' not in result.stdout, result.stdout[-4000:]
        summary=re.search(r'test result: FAILED\. (\d+) passed; (\d+) failed;',result.stdout)
        assert summary and int(summary[2])>=expected,result.stdout[-4000:]
        assert failures>=expected, (module,failures,expected)
        results.append(f'{module}: {expected} assertion failures, cargo exit {result.returncode}')
finally:
    for name,path in files.items():
        if path.read_text()!=mutated[name]: raise RuntimeError(f'{name} changed during mutation; refusing to overwrite another edit')
        path.write_text(original[name])
summary='\n'.join(results)+'\nRestored exact source bytes; normalized behavioral-red harness exit 1.\n'
(artifact/'mutation-summary.log').write_text(summary)
print(summary,end='');sys.exit(1)
