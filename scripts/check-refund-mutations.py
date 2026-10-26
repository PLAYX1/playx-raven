#!/usr/bin/env python3
"""Focused behavioral defects; owned synthetic fixtures and exact-byte restore."""
from pathlib import Path
import os, subprocess, sys
root=Path(__file__).resolve().parent.parent
art=root/'artifacts/desktop-security'
env=dict(os.environ);env['RV_BACKUP_FIXTURE_ROOT']=str(Path.home()/'rv-test-fixture')
cases=[
 ('original-rate','src-tauri/src/refund.rs','let refund_sats=sats(amount/rate)?;','let refund_sats=sats(amount/total*(total_sats as f64/1e8))?;',['cargo','test','--lib','current_quote_preserves_entered_fiat','--','--nocapture']),
 ('audit-original-rate','src-tauri/src/refund.rs','backend.audit(to,amount,cur,rvn,rate,reason,txid,now)','backend.audit(to,amount,cur,rvn,total/(total_sats as f64/1e8),reason,txid,now)',['cargo','test','--lib','current_quote_preserves_entered_fiat','--','--nocapture']),
 ('prior-not-sent','src-tauri/src/refund.rs','if r.state=="cancelled" && r.order_address==order','if r.order_address==order',['cargo','test','--lib','sealed_refund_outcome_is_bound','--','--nocapture']),
 ('pending-priority','src-tauri/src/refund.rs','    prior_request(&journal,request_id,sale["address"].as_str().unwrap_or(""),to,amount,reason)?;','    // INJECTED: lose prior-state priority before edited input validation.',['cargo','test','--lib','uncertain_or_unreadable_prior_id','--','--nocapture']),
 ('browser-clear-unknown','web/staff.html','if (r.refund_outcome === "not_sent" && p && r.request_id === p.id && intent','if (true || (r.refund_outcome === "not_sent" && p && r.request_id === p.id && intent',['node','scripts/check-staff-refund.mjs','--case=uncertain']),
 ('browser-overwrite-intent','web/staff.html','          sessionStorage.setItem(refundPendingKey, JSON.stringify(refundPending));','          refundPending = {id:refundRequestId,order:$("rf-order").value.trim(),to,krw,reason:$("rf-why").value};\n          sessionStorage.setItem(refundPendingKey, JSON.stringify(refundPending));',['node','scripts/check-staff-refund.mjs','--case=edited'])
]
results=[]
for label,name,before,after,command in cases:
    p=root/name;original=p.read_bytes();assert original.count(before.encode())==1,(label,'anchor')
    mutated=original.replace(before.encode(),after.encode(),1)
    if label=='browser-clear-unknown':
        anchor=b'&& (intent.reason == null || intent.reason === p.reason)) {'
        assert mutated.count(anchor)==1
        mutated=mutated.replace(anchor,b'&& (intent.reason == null || intent.reason === p.reason))) {',1)
    try:
        assert p.read_bytes()==original
        p.write_bytes(mutated)
        r=subprocess.run(command,cwd=root/'src-tauri' if command[0]=='cargo' else root,env=env,text=True,stdout=subprocess.PIPE,stderr=subprocess.STDOUT)
        (art/f'refund-mutation-{label}.log').write_text(r.stdout)
        if command[0]=='cargo':
            assert r.returncode==101 and 'could not compile' not in r.stdout and '0 passed; 1 failed;' in r.stdout and ('assertion `' in r.stdout or 'assertion failed:' in r.stdout),r.stdout[-4500:]
        else:
            assert r.returncode==1 and 'AssertionError' in r.stdout and 'SyntaxError' not in r.stdout,r.stdout[-4500:]
        line=f'{label}: actual assertion failure, exit {r.returncode}'
        results.append(line);print(line,flush=True)
    finally:
        if p.read_bytes()!=mutated:raise RuntimeError(f'{name} changed; refusing overwrite')
        p.write_bytes(original)
        assert p.read_bytes()==original
summary='\n'.join(results)+'\nAll exact source bytes restored. Behavioral-red harness exit 1.\n'
(art/'refund-mutation-summary.log').write_text(summary)
print(summary,end='');sys.exit(1)
