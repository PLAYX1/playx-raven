import os,subprocess
from pathlib import Path
root=Path.cwd()
env={**os.environ,'CARGO_TARGET_DIR':'/private/tmp/secfix2-cargo','RV_BACKUP_FIXTURE_ROOT':'/tmp/secfix2-backup-fixtures'}
p=subprocess.run(['cargo','test','--offline','--manifest-path','src-tauri/Cargo.toml','--lib'],env=env,capture_output=True,text=True)
lines=[line for line in (p.stdout+'\n'+p.stderr).splitlines() if line.startswith(('test ','test result:','error[','error:','failures:')) or 'Operation not permitted' in line or 'PermissionDenied' in line]
(root/'docs/handoff-1006/secfix2-rust-all.txt').write_text('exit='+str(p.returncode)+'\n'+'\n'.join(lines)+'\n')
print('rust exit',p.returncode)
print('\n'.join(line for line in lines if 'FAILED' in line or 'test result:' in line))
raise SystemExit(p.returncode)
