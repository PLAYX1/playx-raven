// Compile the production backup/crypto modules with fake path and RPC adapters.
// No Tauri application, real node, wallet, home discovery, or private data is used.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const baseline = process.argv.includes('--baseline');
const mutant = process.argv.includes('--mutant-omission');
const out = resolve(root, 'artifacts/backup-safety', baseline ? 'baseline' : mutant ? 'mutant' : 'current');
mkdirSync(resolve(out, 'src'), { recursive: true });
for (const name of ['backup', 'lockbox', 'backup_storage']) {
  const path = `src-tauri/src/${name}.rs`;
  if (baseline && name === 'backup_storage') continue;
  if (!existsSync(resolve(root, path))) continue;
  let code = baseline ? execFileSync('git', ['show', '46c10d0:' + path], { cwd: root, encoding: 'utf8' }) : readFileSync(resolve(root, path), 'utf8');
  code = code.replaceAll('#[tauri::command]', '');
  if (mutant && name === 'backup') {
    const original = code;
    code = code.replace('prepare_backup(include_wallet).await?', 'prepare_backup(false).await?');
    assert.notEqual(code, original, 'The mutation must reach the production preparation call');
  }
  if (!baseline && name === 'backup') code += readFileSync(resolve(root, 'scripts/fixtures/backup-safety.rs'), 'utf8');
  writeFileSync(resolve(out, `src/${name}.rs`), code);
}
writeFileSync(resolve(out, 'Cargo.toml'), `[package]
name = "ravenvault-backup-safety"
version = "0.0.0"
edition = "2021"
[dependencies]
serde_json = { version = "1", features = ["preserve_order"] }
zip = { version = "2", default-features = false, features = ["deflate"] }
sha2 = "0.10"
rand = "0.8"
aes-gcm = "0.10"
argon2 = "0.5"
hex = "0.4"
tokio = { version = "1", features = ["rt-multi-thread", "net", "macros", "sync"] }
`);
writeFileSync(resolve(out, 'src/main.rs'), `#![allow(dead_code,unused_mut,unused_variables)]
mod backup;
mod lockbox;
${baseline ? '' : 'mod backup_storage;'}
mod paths {
    use std::path::PathBuf;
    pub static TEST_ENV: std::sync::Mutex<()> = std::sync::Mutex::new(());
    pub fn home() -> PathBuf { PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("synthetic") }
    pub fn app_dir() -> PathBuf { home().join("app") }
    pub fn app_file(name: &str) -> PathBuf { app_dir().join(name) }
    pub fn raven_dir() -> PathBuf { home().join("node") }
}
mod raven {
    use serde_json::{json, Value};
    use std::sync::atomic::{AtomicUsize, Ordering};
    pub static MODE: AtomicUsize = AtomicUsize::new(0);
    pub async fn call_rpc(method: &str, args: Value) -> Result<Value,String> {
        if method == "backupwallet" {
            let path = std::path::Path::new(args[0].as_str().unwrap());
            assert!(path.parent().unwrap().canonicalize().unwrap().starts_with(crate::paths::home().canonicalize().unwrap()), "Fixture path escaped isolated root");
            match MODE.load(Ordering::SeqCst) {
                1 => std::fs::write(path, b"synthetic wallet bytes, never a real wallet").unwrap(),
                2 => (),
                3 => std::fs::write(path, b"").unwrap(),
                _ => return Err("synthetic node unavailable".into()),
            }
            return Ok(Value::Null);
        }
        if method == "getwalletinfo" { return Ok(json!({"unlocked_until":0})); }
        Err("Synthetic adapter refuses non-backup RPC".into())
    }
    pub async fn wallet_lock_state() -> Result<Value,String> { Ok(json!({"encrypted":true})) }
    pub async fn new_address(_: String) -> Result<String,String> { Err("Disabled in fixture".into()) }
}
#[tokio::main]
async fn main() {
    let root = paths::home();
    assert!(root.starts_with(env!("CARGO_MANIFEST_DIR")));
    let _ = std::fs::remove_dir_all(&root);
    std::fs::create_dir_all(paths::app_dir()).unwrap();
    let dest = root.join("destination");
    std::fs::create_dir_all(&dest).unwrap();
    let result = backup::backup_zip(dest.to_string_lossy().into(), String::new(), true).await;
    assert!(result.is_err(), "A required wallet was omitted but backup reported success: {result:?}");
    println!("PASS production command rejects omitted wallet");
}
`);
const env = { ...process.env, CARGO_TARGET_DIR: resolve(root, 'artifacts/backup-safety/target') };
const args = ['run', '--quiet', '--manifest-path', resolve(out, 'Cargo.toml')];
let result = spawnSync('cargo', args, { cwd: root, env, stdio: 'inherit' });
if (result.status !== 0) process.exit(1);
if (!baseline && !mutant) {
  result = spawnSync('cargo', ['test', '--quiet', '--manifest-path', resolve(out, 'Cargo.toml'), 'backup::safety_tests', '--', '--test-threads=1'], { cwd: root, env, stdio: 'inherit' });
  if (result.status !== 0) process.exit(1);
}
