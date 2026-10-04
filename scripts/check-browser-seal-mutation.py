#!/usr/bin/env python3
"""Known-answer assertion failures after injecting real crypto parameter defects."""
from pathlib import Path
import subprocess,sys
root=Path(__file__).resolve().parent.parent
path=root/'web/shop-seal.src.ts';original=path.read_text();art=root/'artifacts/desktop-security';results=[]
for name,before,after in [('hkdf',"utf8ToBytes('rv-shop-seal-v1'), 32","utf8ToBytes('rv-shop-seal-v2'), 32"),('request-aad',"utf8ToBytes('rv-shop-seal-v1/req')","utf8ToBytes('rv-shop-seal-v2/req')")]:
    assert original.count(before)==1
    mutated=original.replace(before,after,1)
    try:
        path.write_text(mutated)
        r=subprocess.run(['node','scripts/check-shop-seal.mjs'],cwd=root,text=True,stdout=subprocess.PIPE,stderr=subprocess.STDOUT)
        (art/f'browser-mutation-{name}.log').write_text(r.stdout)
        assert r.returncode==1 and 'AssertionError' in r.stdout and 'known-answer before decrypt' in r.stdout,r.stdout
        results.append(f'{name}: actual known-answer AssertionError; node exit 1')
    finally:
        if path.read_text()!=mutated: raise RuntimeError('source changed concurrently; refusing restore')
        path.write_text(original)
staff=root/'web/staff.html';staff_original=staff.read_text();tag='    <script src="/shop-seal.bundle.js"></script>\n'
assert staff_original.count(tag)==1
staff_mutated=staff_original.replace(tag,'',1)
try:
    staff.write_text(staff_mutated)
    r=subprocess.run(['node','scripts/check-shop-seal.mjs'],cwd=root,text=True,stdout=subprocess.PIPE,stderr=subprocess.STDOUT)
    (art/'browser-mutation-staff-bootstrap.log').write_text(r.stdout)
    assert r.returncode==1 and 'AssertionError' in r.stdout and 'staff served bootstrap must load' in r.stdout,r.stdout
    results.append('staff-bootstrap: actual missing-seal-script AssertionError; node exit 1')
finally:
    if staff.read_text()!=staff_mutated: raise RuntimeError('staff source changed concurrently; refusing restore')
    staff.write_text(staff_original)
r=subprocess.run(['node','scripts/check-shop-seal.mjs'],cwd=root,text=True,stdout=subprocess.PIPE,stderr=subprocess.STDOUT)
(art/'browser-seal.log').write_text(r.stdout);assert r.returncode==0,r.stdout
summary='\n'.join(results)+'\nRestored exact source; browser vectors green exit 0.\n';(art/'browser-mutation-summary.log').write_text(summary);print(summary,end='');sys.exit(1)
