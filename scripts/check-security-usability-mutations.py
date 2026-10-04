#!/usr/bin/env python3
from pathlib import Path
import os,subprocess,sys
root=Path(__file__).resolve().parent.parent;art=root/'artifacts/desktop-security';env=dict(os.environ);env['RV_BACKUP_FIXTURE_ROOT']=str(Path.home()/'rv-test-fixture')
files={n:root/'src-tauri/src'/n for n in ['server.rs','nostrpub.rs','paths.rs']};original={n:p.read_bytes() for n,p in files.items()}
cases=[('product-json','nostrpub.rs','0 | 40 | 30078 =>','0 | 40 | 30078 | 30402 =>',['signed_wallet_product_plain_text','supported_wallet_event_scopes']),('local-disabled','server.rs','&& trusted_loopback_request(&req,true)','&& false && trusted_loopback_request(&req,true)',['same_origin_loopback_wallet','actual_loopback_listener']),('quota','nostrpub.rs','if self.times.len() >= 20 || self.times.iter().filter(|(_,key)| key == pubkey).count() >= 4','if false && (self.times.len() >= 20 || self.times.iter().filter(|(_,key)| key == pubkey).count() >= 4)',['local_wallet_validates_signature_size_and_quota']),('renewal-write','server.rs','    save_tokens_until(&fresh,&next,until).map_err','    Ok::<(),std::io::Error>(()).map_err',['expired_native_renewal_persists','failed_native_renewal_keeps']),('platform-escape','paths.rs','{ let _=&env; return synthetic_base(platform); }','{ return env("LOCALAPPDATA").map(PathBuf::from).unwrap_or_else(||synthetic_base(platform)); }',['every_platform_test_path'])]
# Remove the real peer/origin boundary, using only synthetic owned router requests.
source=original['server.rs'].decode();start=source.index('fn trusted_loopback_request(');end=source.index('\n#[derive(Clone)]\nstruct LocalWalletPublish',start)
cases.insert(2,('loopback-bypass','server.rs',source[start:end],'fn trusted_loopback_request(req: &axum::extract::Request, require_origin: bool) -> bool { let _=(req,require_origin); true }',['local_wallet_boundary_rejects']))
results=[]
for label,name,before,after,filters in cases:
    current=original[name].decode();assert current.count(before)==1,(label,current.count(before));mutated=current.replace(before,after,1).encode()
    try:
        assert files[name].read_bytes()==original[name],f'{name} changed; refusing mutation'
        files[name].write_bytes(mutated)
        for test in filters:
            r=subprocess.run(['cargo','test','--lib',test,'--','--nocapture'],cwd=root/'src-tauri',env=env,text=True,stdout=subprocess.PIPE,stderr=subprocess.STDOUT)
            (art/f'followup-mutation-{test}.log').write_text(r.stdout)
            assert r.returncode==101 and 'could not compile' not in r.stdout and '0 passed; 1 failed;' in r.stdout and ('assertion `' in r.stdout or 'assertion failed:' in r.stdout),r.stdout[-5000:]
            line=f'{label}/{test}: actual assertion failure, cargo101';results.append(line);print(line,flush=True)
    finally:
        if files[name].read_bytes()!=mutated:raise RuntimeError(f'{name} changed concurrently; refusing restore')
        files[name].write_bytes(original[name])
# A real adapter defect: disable the bounded loopback path, leaving crypto intact.
p=root/'web/shop-seal.src.ts';initial=p.read_bytes();before=b"return window.isSecureContext && ['/wallet','/legacy-wallet']";assert initial.count(before)==1
mutated=initial.replace(before,b"return false && window.isSecureContext && ['/wallet','/legacy-wallet']",1)
try:
    p.write_bytes(mutated);r=subprocess.run(['node','scripts/check-local-wallet-publish.mjs'],cwd=root,text=True,stdout=subprocess.PIPE,stderr=subprocess.STDOUT)
    (art/'followup-browser-mutation.log').write_text(r.stdout);assert r.returncode==1 and 'AssertionError' in r.stdout and 'supported loopback wallet must publish' in r.stdout,r.stdout
    results.append('local-wallet-adapter: actual AssertionError, node1')
finally:
    if p.read_bytes()!=mutated:raise RuntimeError('adapter changed concurrently; refusing restore')
    p.write_bytes(initial)
for n,p in files.items(): assert p.read_bytes()==original[n]
r=subprocess.run(['node','scripts/check-local-wallet-publish.mjs'],cwd=root,text=True,stdout=subprocess.PIPE,stderr=subprocess.STDOUT);(art/'followup-browser-green.log').write_text(r.stdout);assert r.returncode==0,r.stdout
summary='\n'.join(results)+'\nExact-byte source restored; browser green0; normalized behavioral-red runner1.\n';(art/'followup-mutation-summary.log').write_text(summary);print(summary,end='');sys.exit(1)
