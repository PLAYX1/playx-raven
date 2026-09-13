import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
process.chdir(root);
process.env.RV_BACKUP_FIXTURE_ROOT=path.join(root,'artifacts/backup-storage-fixtures');
fs.mkdirSync(process.env.RV_BACKUP_FIXTURE_ROOT,{recursive:true});
const artifacts=path.join(root,'artifacts');
const harness=path.join(artifacts,'backup-storage-harness');
// Git's Windows checkout can use CRLF. Mutate normalized fixture copies only;
// keep the checked-in production sources untouched on every host.
const helper=fs.readFileSync('src-tauri/src/backup_storage.rs','utf8').replaceAll('\r\n','\n');
const current=fs.readFileSync('src-tauri/src/lockbox.rs','utf8').replaceAll('\r\n','\n');
const legacyKeyFunction="pub fn key_get_or_make() -> Result<[u8; 32], String> {\n    let p = key_path();\n    if let Ok(raw) = std::fs::read_to_string(&p) {\n        let bytes = from_paper(raw.trim())?;\n        return Ok(bytes);\n    }\n    // 새로 만든다.\n    use rand::RngCore;\n    let mut k = [0u8; 32];\n    rand::thread_rng().fill_bytes(&mut k);\n    if let Some(d) = p.parent() {\n        let _ = std::fs::create_dir_all(d);\n    }\n    std::fs::write(&p, to_paper(&k)).map_err(|e| format!(\"열쇠를 두지 못했습니다: {e}\"))?;\n    lock_down(&p);\n    Ok(k)\n}\n\n/// 파일 권한을 주인만 읽게 좁힌다.\nfn lock_down(p: &std::path::Path) {\n    #[cfg(unix)]\n    {\n        use std::os::unix::fs::PermissionsExt;\n        let _ = std::fs::set_permissions(p, std::fs::Permissions::from_mode(0o600));\n    }\n    #[cfg(not(unix))]\n    {\n        let _ = p; // 윈도우는 사용자 폴더 권한을 그대로 따른다.\n    }\n}\n\n";
fs.mkdirSync(path.join(harness,'src'),{recursive:true});
fs.writeFileSync(path.join(harness,'Cargo.toml'),"[package]\nname = \"ravenvault-backup-synthetic-tests\"\nversion = \"0.0.0\"\nedition = \"2021\"\n[workspace]\n[dependencies]\naes-gcm = \"0.10\"\nargon2 = \"0.5\"\nrand = \"0.8\"\nhex = \"0.4\"\nserde_json = \"1\"\n");
fs.writeFileSync(path.join(harness,'src/lib.rs'),"#![allow(dead_code)]\nmod paths {\n    pub static TEST_ENV: std::sync::Mutex<()> = std::sync::Mutex::new(());\n    pub fn app_file(name: &str) -> std::path::PathBuf {\n        let root = std::path::PathBuf::from(std::env::var(\"PLAYX_RAVEN_HOME\").expect(\"Synthetic test path required\"));\n        let allowed = std::path::Path::new(env!(\"CARGO_MANIFEST_DIR\")).parent().unwrap().join(\"backup-storage-fixtures\");\n        assert!(root.starts_with(allowed), \"Real application paths are forbidden in this harness\");\n        root.join(name)\n    }\n}\nmod raven {\n    pub async fn wallet_lock_state() -> Result<serde_json::Value, String> { panic!(\"RPC forbidden in synthetic storage tests\") }\n    pub async fn call_rpc(_: &str, _: serde_json::Value) -> Result<serde_json::Value, String> { panic!(\"RPC forbidden in synthetic storage tests\") }\n}\nmod lockbox;\n");
function run(cmd,args,name,expected=0) {
  if (expected !== 0) {
    // Rust's test runner uses 101; the verification command exposes exit 1.
    const wrapper = 'import {spawnSync} from "node:child_process"; const [cmd,...args]=process.argv.slice(1); const r=spawnSync(cmd,args,{encoding:"utf8"}); process.stdout.write(r.stdout||""); process.stderr.write(r.stderr||String(r.error||"")); process.exit(r.status===0?0:1);';
    args=['--input-type=module','-e',wrapper,cmd,...args]; cmd=process.execPath;
    expected=1;
  }
  const result=spawnSync(cmd,args,{encoding:'utf8',timeout:180000});
  const log=(result.stdout||'')+(result.stderr||'');
  fs.writeFileSync(path.join(artifacts,`${name}.txt`),log);
  assert.equal(result.status,expected,`${name}: expected ${expected}, got ${result.status}\n${result.error||''}\n${log}`);
  if(expected!==0)assert.match(log,/test result: FAILED/,'Failure must come from an executed assertion, not compilation/setup');
  console.log(`${name}: ${expected===0?'PASS':'expected assertion failure; verification exit 1'}`);
  return log;
}
function helperTest(text,name,expected=0,filter='') {
  const file=path.join(artifacts,`${name}.rs`), binary=path.join(artifacts,name+(process.platform==='win32'?'.exe':''));
  fs.writeFileSync(file,text);
  run('rustc',['--edition=2021','--test',file,'-o',binary],`${name}-compile`);
  return run(binary,[filter,'--nocapture'],name,expected);
}
function cryptoTest(text,name,expected=0,filter='backup_safety_tests') {
  fs.writeFileSync(path.join(harness,'src/lockbox.rs'),text.replaceAll('#[tauri::command]',''));
  return run('cargo',['test','--manifest-path',path.join(harness,'Cargo.toml'),filter,'--','--nocapture'],name,expected);
}
helperTest(helper,'backup-storage-green');
const unsafe=helper.replace('        copy_verified(staged, &new, "new", hook)?;', '        fs::write(&latest, b"deliberate destructive overwrite")?;\n        copy_verified(staged, &new, "new", hook)?;');
assert.notEqual(unsafe,helper);
helperTest(unsafe,'backup-storage-overwrite-mutant',101,'every_publication_failure_restores_both_original_names');
cryptoTest(current,'lockbox-green');
const oldKey=legacyKeyFunction;
const start=current.indexOf('pub fn key_get_or_make()'),end=current.indexOf('/// 사람이 종이에');
assert.ok(start>=0&&end>start&&oldKey.includes('lock_down'));
cryptoTest(current.slice(0,start)+oldKey+current.slice(end),'lockbox-original-key-red',101,'key_read_failure_preserves_existing_bytes');
const guard=/    if raw\.len\(\) < 8 \+ 16 \+ 12 \+ 16 \|\| &raw\[\.\.8\] != MAGIC \{\n        return Err\([^\n]*\);\n    \}\n/;
assert.match(current,guard);
cryptoTest(current.replace(guard,''),'lockbox-original-envelope-red',101,'malformed_envelope_returns_error_without_panic_or_destination_change');
const noEnvelopeCheck=current.replace('let wrap = pass_read_checked()?;', 'let wrap = pass_read();');
assert.notEqual(noEnvelopeCheck,current);
cryptoTest(noEnvelopeCheck,'lockbox-envelope-read-mutant',101,'unreadable_or_malformed_password_envelope_preserves_existing_backup');
const noOrphanCheck=current.replace('    ensure_no_existing_envelope()?;\n', '');
assert.notEqual(noOrphanCheck,current);
cryptoTest(noOrphanCheck,'lockbox-orphaned-envelope-mutant',101,'missing_key_with_existing_envelope_never_creates_a_mismatched_key');
const brokenFormat=current.replace('b"PXRLOCK1";', 'b"PXRLOCK2";');
assert.notEqual(brokenFormat,current);
cryptoTest(brokenFormat,'lockbox-format-mutant',101,'released_plain_and_password_envelope_formats_still_open');
fs.writeFileSync(path.join(harness,'src/lockbox.rs'),current.replaceAll('#[tauri::command]',''));
assert.deepEqual(fs.readdirSync(process.env.RV_BACKUP_FIXTURE_ROOT),[],'All synthetic fixture directories must be removed');
console.log('PASS: production source remained unchanged; all deliberate regressions were rejected; fixture directory is empty');
