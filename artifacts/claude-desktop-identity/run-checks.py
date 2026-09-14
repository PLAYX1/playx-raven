import subprocess,os,json,time,sys
from pathlib import Path
out=Path('artifacts/claude-desktop-identity');results=[]
commands=[('tsc',['npx','tsc','--noEmit','-p','tsconfig.json']),('build',['npm','run','build'])]
commands += [(name,['node','scripts/'+name+'.mjs']) for name in ['check-desktop-integration','check-desktop-ux','check-backup-ui','check-backup-safety','verify-backup-storage','check-phone-transaction','desktop-installer-identity.test','release-manifest.test','verify-published-release.test','check-desktop-languages']]
commands += [('cargo-check',['cargo','check','--tests','--offline','--manifest-path','src-tauri/Cargo.toml'])]
commands += [('cargo-'+name,['cargo','test','--offline','--manifest-path','src-tauri/Cargo.toml',name+'::','--','--test-threads=1']) for name in ['backup','recover','autostart','companion','services','report','electrum','awake','devfee','prep','knowledge']]
if '--final' in sys.argv:
 results=json.loads((out/'checks.json').read_text())
 commands=[(name,cmd) for name,cmd in commands if name in ['tsc','build','check-desktop-integration','check-desktop-ux','check-backup-ui','desktop-installer-identity.test','release-manifest.test','verify-published-release.test','check-desktop-languages']]
for name,cmd in commands:
 results=[r for r in results if r['command']!=' '.join(cmd)]
 env=os.environ.copy();env['NODE_OPTIONS']='--max-old-space-size=8192';env['CARGO_NET_OFFLINE']='true';env['TMPDIR']=str(out.resolve()/'tmp');Path(env['TMPDIR']).mkdir(exist_ok=True)
 env['PLAYX_RAVEN_HOME']=str(out.resolve()/'synthetic-app');Path(env['PLAYX_RAVEN_HOME']).mkdir(exist_ok=True)
 started=time.time()
 with (out/(name+'.log')).open('w') as f:
  r=subprocess.run(cmd,stdout=f,stderr=subprocess.STDOUT,env=env)
 results.append({'command':' '.join(cmd),'exit':r.returncode,'seconds':round(time.time()-started,2),'log':name+'.log'})
 (out/'checks.json').write_text(json.dumps(results,indent=2)+'\n');print(name,r.returncode,flush=True)
