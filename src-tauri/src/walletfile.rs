//! 지갑 파일 내보내기 · 가져오기 (0.8.7).
//!
//! 사용자가 폴더 선택창으로 직접 고른 곳(iCloud 폴더·USB 등)에 지갑 사본 **한 파일**을 둔다.
//!
//! ## 🔴 규칙
//!
//! - **평문 내보내기는 없다.** 내보낸 파일은 항상 `lockbox`(AES-256-GCM, 백업 열쇠 52글자)로 한 번 더
//!   잠근 `.rvwallet` 뿐이다. 코어의 `wallet.dat` 은 지갑 암호가 있을 때만 개인키가 암호화돼 있으므로,
//!   **지갑 암호가 없으면 내보내기를 막고** 암호부터 걸라고 안내한다.
//! - **지갑 암호로 다시 인증한다.** 자리를 비운 사이 누가 지갑을 통째로 USB 에 담아 가는 것을 막는다.
//!   틀리면 연달아 5번까지 바로, 그 뒤로 기다리게 한다(`app_lock::backoff_secs`). 암호는 어디에도 남기지 않는다.
//! - **잠긴 동안(대기화면·매장용 읽기 전용) 이 명령들은 거부된다.** `app_lock::LOCKED_ALLOWED` 에 넣지 않는다 —
//!   새 명령은 기본 거부이고, 시험(`not_in_locked_allowlist`)이 이를 지킨다.
//! - **쓰기 전에** 폴더·빈 공간을 보고, **쓴 뒤에** 다시 읽어 열쇠로 풀어 원본과 지문(SHA-256)이 같은지 확인한다.
//!   다르면 만든 파일을 지우고 실패로 답한다. 평문 사본은 앱 전용 비공개 작업 폴더에만 잠깐 있고 곧 지운다.
//! - **가져오기는 현재 지갑을 덮어쓰지 않는다.** 1단계(`wallet_import_prepare`)는 풀어서 앱 전용 임시 폴더에
//!   두기만 하고 현재 지갑에 손대지 않는다. 2단계(`wallet_import_apply`)는 사용자가 확인한 뒤에만, 기존
//!   「백업 되돌리기」 문(`recover::restore_apply`)을 그대로 쓴다 — 노드가 꺼져 있어야 하고, 현재 `wallet.dat`
//!   은 **먼저 따로 보관**(`before-restore`)한 뒤에 바뀐다.
//! - 열쇠·암호·지갑 암호·복구 단어는 로그·오류 문구·반환값에 넣지 않는다.

use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicI64, AtomicU32, Ordering};

/// 내보낸 파일 확장자.
pub const EXT: &str = "rvwallet";
/// 화면이 알아보는 접두어 — 지갑 암호가 없어서 막혔다.
pub const NEEDS_WALLET_PASS: &str = "NEEDS_WALLET_PASS:";
const NEEDS_WALLET_PASS_SAY: &str = "지갑 암호가 아직 없어요. 암호가 없는 지갑은 파일로 꺼내면 그 파일을 주운 사람이 돈을 쓸 수 있어요. 먼저 「지갑 화면 → 암호 걸기」에서 10글자 이상 암호를 정한 뒤 다시 해 주세요.";
const NODE_DOWN_SAY: &str = "노드가 응답하지 않아 지갑 암호가 있는지 확인할 수 없어요. 노드를 켠 뒤 다시 해 주세요.";
const WRONG_PASS_SAY: &str = "지갑 암호가 맞지 않습니다.";
const MAX_IMPORT_BYTES: u64 = 256 * 1024 * 1024;

static BUSY: AtomicBool = AtomicBool::new(false);
static FAILS: AtomicU32 = AtomicU32::new(0);
static NEXT_TRY: AtomicI64 = AtomicI64::new(0);

struct Busy;
impl Busy {
    fn take() -> Result<Self, String> {
        BUSY.compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .map_err(|_| "다른 지갑 파일 작업이 진행 중이에요. 끝난 뒤 다시 해 주세요.".to_string())?;
        Ok(Busy)
    }
}
impl Drop for Busy {
    fn drop(&mut self) {
        BUSY.store(false, Ordering::Release);
    }
}

fn now() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0)
}

/// 유닉스 초 → `YYYYMMDD-HHMMSS`(UTC). 파일 이름용.
pub fn stamp_name(secs: i64) -> String {
    let days = secs.div_euclid(86_400);
    let rem = secs.rem_euclid(86_400);
    // civil_from_days (Howard Hinnant)
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    format!("{y:04}{m:02}{d:02}-{:02}{:02}{:02}", rem / 3600, rem % 3600 / 60, rem % 60)
}

fn digest(path: &Path) -> Result<(u64, String), String> {
    use sha2::{Digest, Sha256};
    use std::io::Read;
    let mut f = std::fs::File::open(path).map_err(|_| "파일을 읽지 못했어요. 권한을 확인해 주세요.".to_string())?;
    let mut h = Sha256::new();
    let mut n = 0u64;
    let mut buf = [0u8; 65536];
    loop {
        let c = f.read(&mut buf).map_err(|_| "파일을 끝까지 읽지 못했어요.".to_string())?;
        if c == 0 {
            break;
        }
        h.update(&buf[..c]);
        n += c as u64;
    }
    Ok((n, hex::encode(h.finalize())))
}

/// 빈 공간(바이트). 못 재면 `None`(그래도 쓰기 자체가 실패하면 멈춘다).
fn free_bytes(dir: &Path) -> Option<u64> {
    #[cfg(unix)]
    {
        let out = std::process::Command::new("df").args(["-k"]).arg(dir).output().ok()?;
        let text = String::from_utf8_lossy(&out.stdout);
        let kb: u64 = text.lines().nth(1)?.split_whitespace().nth(3)?.parse().ok()?;
        return Some(kb.saturating_mul(1024));
    }
    #[cfg(windows)]
    {
        let drive = dir.to_string_lossy().chars().take(1).collect::<String>();
        if !drive.chars().all(|c| c.is_ascii_alphabetic()) {
            return None;
        }
        let out = std::process::Command::new("powershell")
            .args(["-NoProfile", "-Command", &format!("(Get-PSDrive {drive}).Free")])
            .output()
            .ok()?;
        return String::from_utf8_lossy(&out.stdout).trim().parse().ok();
    }
    #[allow(unreachable_code)]
    None
}

/// 폴더 선택창에서 받은 경로를 확인한다 — 절대 경로·폴더·앱/노드 자기 폴더 아님.
pub fn check_dest(dest: &str) -> Result<PathBuf, String> {
    let p = PathBuf::from(dest.trim());
    if dest.trim().is_empty() || !p.is_absolute() {
        return Err("저장할 폴더를 폴더 선택창에서 골라 주세요.".into());
    }
    let meta = std::fs::metadata(&p).map_err(|_| "그 폴더를 열 수 없어요. 폴더를 다시 골라 주세요(USB 가 빠졌을 수 있어요).".to_string())?;
    if !meta.is_dir() {
        return Err("폴더가 아니에요. 저장할 폴더를 골라 주세요.".into());
    }
    let canon = std::fs::canonicalize(&p).map_err(|_| "폴더를 확인하지 못했어요. 다시 골라 주세요.".to_string())?;
    for mine in [crate::paths::app_dir(), crate::paths::raven_dir()] {
        if let Ok(m) = std::fs::canonicalize(&mine) {
            if canon.starts_with(&m) {
                return Err("이 프로그램이 쓰는 폴더 안에는 내보낼 수 없어요. iCloud·USB 처럼 다른 곳을 골라 주세요.".into());
            }
        }
    }
    Ok(canon)
}

/// 잠근 사본을 폴더에 쓰고, 다시 읽어 열쇠로 풀어 원본과 같은지 확인한다. 돌려주는 것: (파일 경로, 크기).
///
/// `work` 는 앱 전용 비공개 작업 폴더(평문 사본이 있는 곳). 실패하면 만들던 파일을 지운다.
pub fn seal_into(plain: &Path, dest_dir: &Path, key: &[u8; 32], work: &Path, stamp: &str) -> Result<(PathBuf, u64), String> {
    use std::io::Write;
    let (plain_len, plain_sha) = digest(plain)?;
    if plain_len == 0 {
        return Err("지갑 사본이 비어 있어요. 노드 상태를 확인한 뒤 다시 해 주세요.".into());
    }
    // 잠근 파일은 원본보다 조금 크다(머리 + 인증 꼬리 + 백업 암호 봉투 약 100바이트). 넉넉히 2배 + 4MiB.
    let need = plain_len.saturating_mul(2).saturating_add(4 * 1024 * 1024);
    if let Some(free) = free_bytes(dest_dir) {
        if free < need {
            return Err(format!(
                "저장할 곳의 빈 공간이 모자라요. 필요한 공간은 약 {}MB, 남은 공간은 {}MB 예요.",
                need / 1_048_576 + 1,
                free / 1_048_576
            ));
        }
    }
    let sealed = work.join("sealed.tmp");
    crate::lockbox::lock_file(plain, &sealed, key)?;
    let bytes = std::fs::read(&sealed).map_err(|_| "잠근 사본을 읽지 못했어요.".to_string())?;
    let (sealed_len, sealed_sha) = digest(&sealed)?;
    let _ = std::fs::remove_file(&sealed);

    // 이름이 겹치면 번호를 붙인다 — 이미 있는 파일을 덮어쓰지 않는다(create_new).
    let mut chosen: Option<(PathBuf, PathBuf, std::fs::File)> = None;
    for n in 0..100 {
        let base = if n == 0 { format!("RavenVault-wallet-{stamp}") } else { format!("RavenVault-wallet-{stamp}-{}", n + 1) };
        let fin = dest_dir.join(format!("{base}.{EXT}"));
        let part = dest_dir.join(format!(".{base}.{EXT}.part"));
        if std::fs::symlink_metadata(&fin).is_ok() {
            continue;
        }
        let mut o = std::fs::OpenOptions::new();
        o.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            o.mode(0o600);
        }
        match o.open(&part) {
            Ok(f) => {
                chosen = Some((fin, part, f));
                break;
            }
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(e) if e.kind() == std::io::ErrorKind::PermissionDenied => {
                return Err("이 폴더에 쓸 권한이 없어요. 다른 폴더를 고르거나 폴더 권한을 확인해 주세요.".into())
            }
            Err(_) => return Err("이 폴더에 파일을 만들지 못했어요. 다른 폴더를 골라 주세요.".into()),
        }
    }
    let (fin, part, mut file) = chosen.ok_or_else(|| "같은 이름의 파일이 너무 많아요. 다른 폴더를 골라 주세요.".to_string())?;
    let written = (|| -> Result<(), String> {
        file.write_all(&bytes).map_err(|_| "파일을 끝까지 쓰지 못했어요. 빈 공간과 연결(USB)을 확인해 주세요.".to_string())?;
        file.sync_all().map_err(|_| "파일을 저장소에 확정하지 못했어요.".to_string())?;
        drop(file);
        std::fs::rename(&part, &fin).map_err(|_| "파일 이름을 확정하지 못했어요.".to_string())
    })();
    if let Err(e) = written {
        let _ = std::fs::remove_file(&part);
        return Err(e);
    }

    // 쓴 뒤에 다시 읽어서 확인 — 지문이 같고, 열쇠로 풀면 원본과 지문이 같아야 한다.
    let verified = (|| -> Result<(), String> {
        let (len, sha) = digest(&fin)?;
        if len != sealed_len || sha != sealed_sha {
            return Err("쓴 파일을 다시 읽었더니 내용이 달라요. 저장 장치에 문제가 있을 수 있어요.".into());
        }
        let back = work.join("verify.tmp");
        let r = crate::lockbox::unlock_file(&fin, &back, key);
        let r = r.and_then(|_| digest(&back));
        let _ = std::fs::remove_file(&back);
        let (blen, bsha) = r.map_err(|_| "쓴 파일을 열쇠로 다시 풀어 보지 못했어요.".to_string())?;
        if blen != plain_len || bsha != plain_sha {
            return Err("쓴 파일을 풀었더니 원본과 달라요.".into());
        }
        Ok(())
    })();
    if let Err(e) = verified {
        let _ = std::fs::remove_file(&fin);
        return Err(format!("{e} 만든 파일은 지웠어요. 다시 해 주세요."));
    }
    Ok((fin, sealed_len))
}

/// 지갑 암호 재인증(성공하면 지갑은 하기 전 상태로 돌아간다). 암호는 반환·로그에 남지 않는다.
async fn reauth(pass: &str) -> Result<(), String> {
    let wait = NEXT_TRY.load(Ordering::Acquire) - now();
    if wait > 0 {
        return Err(format!("여러 번 틀려서 잠시 기다려야 해요. {wait}초 뒤에 다시 해 주세요."));
    }
    if pass.is_empty() {
        return Err("지갑 암호를 넣어 주세요.".into());
    }
    let before = crate::raven::call_rpc("getwalletinfo", json!([])).await.ok().and_then(|v| v.get("unlocked_until").and_then(Value::as_i64)).unwrap_or(0);
    match crate::raven::call_rpc_detailed("walletpassphrase", json!([pass, 2])).await {
        Ok(_) => {
            FAILS.store(0, Ordering::Release);
            let remain = before - now();
            if before > 0 && remain > 1 {
                // 이미 열려 있던 지갑은 남은 시간만큼 그대로 둔다.
                let _ = crate::raven::call_rpc("walletpassphrase", json!([pass, remain])).await;
            } else {
                let _ = crate::raven::call_rpc("walletlock", json!([])).await;
            }
            Ok(())
        }
        Err(e) if e.code == Some(-14) => {
            let f = FAILS.fetch_add(1, Ordering::AcqRel) + 1;
            NEXT_TRY.store(now() + crate::app_lock::backoff_secs(f), Ordering::Release);
            Err(WRONG_PASS_SAY.into())
        }
        Err(_) => Err("지갑 잠금을 확인하지 못했어요. 노드 연결을 확인한 뒤 다시 해 주세요.".into()),
    }
}

/// 내보내기 화면이 먼저 묻는 것 — 막힐 이유가 있으면 미리 알린다. 비밀은 없다.
#[tauri::command]
pub async fn wallet_file_status() -> Value {
    let enc = crate::raven::wallet_lock_state().await.ok().and_then(|v| v["encrypted"].as_bool());
    json!({
        "node_up": enc.is_some(),
        "wallet_encrypted": enc,
        "backup_pass": crate::lockbox::backup_pass_state()["set"].as_bool().unwrap_or(false),
    })
}

/// 지갑 파일 내보내기 — 백업 열쇠로 한 번 더 잠근 파일만 만든다.
#[tauri::command]
pub async fn wallet_export(dest: String, wallet_pass: String) -> Result<Value, String> {
    let _busy = Busy::take()?;
    let dest_dir = check_dest(&dest)?;
    // 1) 지갑 암호가 있어야 한다.
    match crate::raven::wallet_lock_state().await {
        Ok(st) if st["encrypted"].as_bool() == Some(true) => {}
        Ok(_) => return Err(format!("{NEEDS_WALLET_PASS}{NEEDS_WALLET_PASS_SAY}")),
        Err(_) => return Err(NODE_DOWN_SAY.into()),
    }
    // 2) 지갑 암호로 다시 인증.
    reauth(&wallet_pass).await?;
    drop(wallet_pass);
    // 3) 노드에게 일관된 사본을 받는다(앱 전용 비공개 작업 폴더).
    let work = crate::backup_storage::Workspace::new(&crate::paths::app_dir())?;
    let plain = work.path().join("wallet.dat");
    crate::raven::call_rpc("backupwallet", json!([plain.to_string_lossy()]))
        .await
        .map_err(|_| "지갑 사본을 만들지 못했어요. 노드가 켜져 있는지 확인한 뒤 다시 해 주세요.".to_string())?;
    // 4) 이 컴퓨터의 백업 열쇠로 잠가 쓰고 다시 읽어 확인.
    let key = crate::lockbox::key_get_or_make()?;
    let (path, size) = seal_into(&plain, &dest_dir, &key, work.path(), &stamp_name(now()))?;
    let _ = std::fs::remove_file(&plain);
    Ok(json!({
        "ok": true,
        "path": path.to_string_lossy(),
        "folder": dest_dir.to_string_lossy(),
        "size": size,
        "verified": true,
        "backup_pass": crate::lockbox::backup_pass_state()["set"].as_bool().unwrap_or(false),
    }))
}

// ─────────────────────── 백업 열쇠 종이 출력 ───────────────────────

const SHEET: &str = "key-sheet.html";
const SHEET_LIFETIME_SECS: u64 = 600;

fn esc(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;")
}

/// 인쇄용 한 장(순수 함수 — 시험). 열쇠를 4글자씩 끊어 크게 보인다. 언어는 ko·en·ja·zh.
pub fn key_sheet_html(lang: &str, paper: &str) -> String {
    let (title, lead, how, warn, tip) = match lang {
        "en" => ("RavenVault backup key", "If this computer dies, your backup cannot be opened without these 52 characters.", "Write it on paper or print it, and keep it with your 12 recovery words. Never store it in the same cloud folder as the backup.", "Anyone who has this paper AND the backup file can open your wallet backup. Keep it private.", "To print press Ctrl/⌘+P. The app deletes this file in 10 minutes."),
        "ja" => ("RavenVault バックアップキー", "このコンピュータが壊れると、この52文字がなければバックアップを開けません。", "紙に書くか印刷して、12個の復元ワードと一緒に保管してください。バックアップと同じクラウドには置かないでください。", "この紙とバックアップファイルの両方を持つ人は、ウォレットのバックアップを開けます。人に見せないでください。", "印刷は Ctrl/⌘+P。このファイルはアプリが10分後に削除します。"),
        "zh" => ("RavenVault 备份密钥", "电脑损坏后，没有这52个字符就无法打开备份。", "请写在纸上或打印，并与12个恢复词一起保管。不要与备份放在同一个云端文件夹。", "同时拥有这张纸和备份文件的人可以打开你的钱包备份，请妥善保管。", "按 Ctrl/⌘+P 打印。应用会在10分钟后删除此文件。"),
        _ => ("레이븐볼트 백업 열쇠", "컴퓨터가 죽으면, 이 52글자가 없으면 백업을 못 엽니다.", "종이에 적거나 인쇄해서 복구 단어 12개와 같이 보관하세요. 백업 파일과 같은 클라우드에 두지 마세요.", "이 종이와 백업 파일을 둘 다 가진 사람은 지갑 백업을 열 수 있습니다. 남에게 보이지 마세요.", "인쇄는 ⌘P(윈도우는 Ctrl+P). 이 파일은 프로그램이 10분 뒤에 지웁니다."),
    };
    format!(
        "<!doctype html><html lang=\"{lang}\"><head><meta charset=\"utf-8\"><title>{t}</title><style>\
@page{{size:A4;margin:18mm}}body{{font:13pt/1.7 -apple-system,'Apple SD Gothic Neo',sans-serif;color:#000}}\
h1{{font-size:20pt;margin:0 0 4mm}}.key{{font:700 22pt/1.9 ui-monospace,Menlo,Consolas,monospace;letter-spacing:.06em;border:2px solid #000;padding:6mm 8mm;margin:6mm 0;word-break:break-all}}\
.warn{{border:2px solid #000;padding:4mm 5mm;margin-top:6mm}}.tip{{margin-top:8mm;font-size:10pt;color:#555}}@media print{{.tip{{display:none}}}}</style></head><body>\
<h1>{t}</h1><p><b>{lead}</b></p><div class=\"key\">{k}</div><p>{how}</p><div class=\"warn\">{warn}</div><div class=\"tip\">{tip}</div></body></html>",
        lang = if ["en", "ja", "zh"].contains(&lang) { lang } else { "ko" },
        t = esc(title), lead = esc(lead), k = esc(paper), how = esc(how), warn = esc(warn), tip = esc(tip)
    )
}

fn sheet_path() -> PathBuf {
    crate::paths::app_file(SHEET)
}

/// 앱을 켤 때 남아 있는 인쇄용 열쇠 파일을 지운다(10분 뒤 지우기 전에 앱이 꺼졌을 때).
pub fn sweep_key_sheet() {
    let _ = std::fs::remove_file(sheet_path());
}

/// 백업 열쇠 52글자를 인쇄용 파일로 만들어 브라우저로 연다(WKWebView 는 print() 가 없다).
/// 앱 전용 폴더(0600)에 두고 10분 뒤 지운다 — 바탕화면 같은 눈에 띄는 곳에 두지 않는다. 지갑 암호로 다시 인증한다.
#[tauri::command]
pub async fn key_sheet_print(lang: String, wallet_pass: String) -> Result<Value, String> {
    let _busy = Busy::take()?;
    // 지갑 암호가 있는 지갑이면 다시 인증(없는 지갑이면 인증할 비밀이 없다 — 열쇠는 어차피 화면에서 볼 수 있다).
    if let Ok(st) = crate::raven::wallet_lock_state().await {
        if st["encrypted"].as_bool() == Some(true) {
            reauth(&wallet_pass).await?;
        }
    }
    drop(wallet_pass);
    let k = crate::lockbox::key_get_or_make()?;
    let html = key_sheet_html(&lang, &crate::lockbox::to_paper(&k));
    let path = sheet_path();
    crate::server::atomic_write_0600(&path, html.as_bytes()).map_err(|_| "인쇄용 파일을 만들지 못했어요. 디스크 공간과 권한을 확인해 주세요.".to_string())?;
    // atomic_write_0600 은 임시 이름을 거쳐 옮긴다 — 같은 확장자 임시물이 남지 않았는지는 시험이 본다.
    if let Err(e) = open::that(&path) {
        let _ = std::fs::remove_file(&path);
        return Err(format!("브라우저를 열지 못했어요: {e}"));
    }
    #[cfg(not(test))]
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_secs(SHEET_LIFETIME_SECS)).await;
        let _ = std::fs::remove_file(sheet_path());
    });
    Ok(json!({ "ok": true, "deletes_in_minutes": SHEET_LIFETIME_SECS / 60 }))
}

// ─────────────────────────── 가져오기 ───────────────────────────

fn staging_root() -> PathBuf {
    crate::paths::app_file("wallet-import")
}

fn valid_id(id: &str) -> bool {
    id.len() == 32 && id.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

fn staging_dir(id: &str) -> Result<PathBuf, String> {
    if !valid_id(id) {
        return Err("가져오기 준비가 올바르지 않아요. 처음부터 다시 해 주세요.".into());
    }
    let d = staging_root().join(id);
    if !d.join("wallet.dat").is_file() {
        return Err("가져오기 준비가 끝나 있지 않아요(이미 쓰였거나 취소됐어요). 처음부터 다시 해 주세요.".into());
    }
    Ok(d)
}

/// 코어 지갑 파일처럼 생겼나(Berkeley DB 머리 또는 SQLite). 엉뚱한 파일을 지갑 자리에 놓지 않으려는 마지막 확인.
pub fn looks_like_wallet(head: &[u8]) -> bool {
    if head.len() >= 16 {
        let m = &head[12..16];
        // Berkeley DB btree 마법수 0x00053162 (리틀/빅 엔디언)
        if m == [0x62, 0x31, 0x05, 0x00] || m == [0x00, 0x05, 0x31, 0x62] {
            return true;
        }
    }
    head.starts_with(b"SQLite format 3\0")
}

#[cfg(unix)]
fn private_dir(p: &Path) -> std::io::Result<()> {
    use std::os::unix::fs::DirBuilderExt;
    std::fs::DirBuilder::new().recursive(true).mode(0o700).create(p)
}
#[cfg(not(unix))]
fn private_dir(p: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(p)
}

/// 1단계 — 파일을 열쇠(52글자) 또는 백업 암호로 풀어 임시 폴더에 둔다. **현재 지갑은 건드리지 않는다.**
///
/// `mode`: `"key"`(종이의 52글자) | `"pass"`(백업 암호). 돌려주는 것에 비밀은 없다.
#[tauri::command]
pub async fn wallet_import_prepare(file: String, mode: String, secret: String) -> Result<Value, String> {
    let _busy = Busy::take()?;
    let src = PathBuf::from(file.trim());
    if !src.is_absolute() {
        return Err("가져올 파일을 파일 선택창에서 골라 주세요.".into());
    }
    let meta = std::fs::metadata(&src).map_err(|_| "그 파일을 열 수 없어요. 다시 골라 주세요.".to_string())?;
    if !meta.is_file() || meta.len() == 0 || meta.len() > MAX_IMPORT_BYTES {
        return Err("지갑 파일이 아니에요. 「.rvwallet」 파일을 골라 주세요.".into());
    }
    let raw = std::fs::read(&src).map_err(|_| "파일을 읽지 못했어요. 권한을 확인해 주세요.".to_string())?;
    if raw.len() < 8 || &raw[..8] != b"PXRLOCK1" {
        return Err("이 프로그램이 잠근 지갑 파일이 아니에요.".into());
    }
    let key: [u8; 32] = match mode.as_str() {
        "key" => crate::lockbox::from_paper(&secret)?,
        "pass" => {
            let env = crate::lockbox::strip_wrap(&raw).1.ok_or_else(|| "이 파일에는 백업 암호로 여는 길이 없어요. 종이에 적은 52글자 열쇠로 해 주세요.".to_string())?;
            crate::lockbox::unwrap_key(env, &secret)?
        }
        _ => return Err("여는 방법이 올바르지 않아요.".into()),
    };
    drop(secret);
    // 지난 준비물은 치운다(한 번에 하나).
    let root = staging_root();
    let _ = std::fs::remove_dir_all(&root);
    private_dir(&root).map_err(|_| "임시 폴더를 만들지 못했어요. 디스크 공간과 권한을 확인해 주세요.".to_string())?;
    let id = {
        use rand::RngCore;
        let mut b = [0u8; 16];
        rand::thread_rng().fill_bytes(&mut b);
        hex::encode(b)
    };
    let dir = root.join(&id);
    private_dir(&dir).map_err(|_| "임시 폴더를 만들지 못했어요.".to_string())?;
    let out = dir.join("wallet.dat");
    let opened = crate::lockbox::unlock_file(&src, &out, &key);
    if let Err(e) = opened {
        let _ = std::fs::remove_dir_all(&root);
        return Err(e);
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&out, std::fs::Permissions::from_mode(0o600));
    }
    let head = {
        use std::io::Read;
        let mut h = [0u8; 16];
        let n = std::fs::File::open(&out).and_then(|mut f| f.read(&mut h)).unwrap_or(0);
        h[..n].to_vec()
    };
    if !looks_like_wallet(&head) {
        let _ = std::fs::remove_dir_all(&root);
        return Err("열렸지만 레이븐코인 지갑 파일처럼 보이지 않아요. 다른 파일을 골라 주세요. 현재 지갑은 그대로예요.".into());
    }
    let (size, sha) = digest(&out)?;
    let current = crate::paths::raven_dir().join("wallet.dat");
    let current_sha = digest(&current).ok().map(|d| d.1);
    Ok(json!({
        "ok": true,
        "id": id,
        "size": size,
        "fingerprint": &sha[..8],
        "current_exists": current_sha.is_some(),
        "same_as_current": current_sha.as_deref() == Some(sha.as_str()),
    }))
}

/// 2단계 — 사용자가 확인한 뒤에만. 현재 지갑을 **먼저 따로 보관**하고(`recover::restore_apply`) 바꾼다.
/// 노드가 켜져 있으면 거절된다(앱이 켜져 있는 지갑 파일 밑을 바꾸지 않는다).
#[tauri::command]
pub async fn wallet_import_apply(id: String, confirmed: bool) -> Result<Value, String> {
    let _busy = Busy::take()?;
    if !confirmed {
        return Err("전환하기 전에 확인이 필요해요.".into());
    }
    let dir = staging_dir(&id)?;
    let r = crate::recover::restore_apply(dir.to_string_lossy().to_string(), vec!["wallet".to_string()], None).await?;
    let ok = r["ok"].as_bool().unwrap_or(false);
    if ok {
        // 쓴 임시 폴더는 지운다(전환이 안 됐을 때만 남겨 노드를 끈 뒤 다시 시도하게 한다).
        let _ = std::fs::remove_dir_all(staging_root());
    }
    let previous = r["done"].as_array().and_then(|a| a.first()).and_then(|d| d["previous"].as_str()).map(str::to_string);
    let why = r["failed"].as_array().and_then(|a| a.first()).and_then(|d| d["why"].as_str()).map(str::to_string);
    Ok(json!({ "ok": ok, "status": r["status"], "previous": previous, "why": why, "restart_app": r["restart_app"] }))
}

/// 가져오기를 그만둔다 — 임시 폴더를 지운다. 현재 지갑은 처음부터 그대로다.
#[tauri::command]
pub fn wallet_import_cancel() -> Value {
    let _ = std::fs::remove_dir_all(staging_root());
    json!({ "ok": true })
}

#[cfg(test)]
mod tests {
    use super::*;

    const NEW: [&str; 6] = ["wallet_export", "wallet_import_prepare", "wallet_import_apply", "wallet_import_cancel", "wallet_file_status", "key_sheet_print"];

    fn dir(name: &str) -> PathBuf {
        let d = crate::paths::test_fixture_root().join(name);
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn fake_wallet(path: &Path) {
        let mut b = vec![0u8; 4096];
        b[12..16].copy_from_slice(&[0x62, 0x31, 0x05, 0x00]);
        for (i, x) in b.iter_mut().enumerate().skip(16) {
            *x = (i * 31 % 251) as u8;
        }
        std::fs::write(path, b).unwrap();
    }

    #[test]
    fn stamp_is_a_calendar_date() {
        assert_eq!(stamp_name(0), "19700101-000000");
        assert_eq!(stamp_name(1_791_700_000), "20261011-062640");
        assert_eq!(stamp_name(951_782_400), "20000229-000000");
    }

    #[test]
    fn export_writes_only_a_locked_file_and_it_opens_with_the_key() {
        let work = dir("wf-work1");
        let out = dir("wf-out1");
        let plain = work.join("wallet.dat");
        fake_wallet(&plain);
        let key = [5u8; 32];
        let (path, size) = seal_into(&plain, &out, &key, &work, "20261011-000000").unwrap();
        assert!(path.extension().unwrap() == EXT && size > 4096);
        // 평문이 그대로 들어 있으면 안 된다.
        let raw = std::fs::read(&path).unwrap();
        let body = std::fs::read(&plain).unwrap();
        assert_eq!(&raw[..8], b"PXRLOCK1");
        assert!(!raw.windows(64).any(|w| w == &body[100..164]), "평문이 보인다");
        // 목적지에는 잠근 파일 하나뿐(평문 wallet.dat · 임시 파일 없음).
        let names: Vec<String> = std::fs::read_dir(&out).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().to_string()).collect();
        assert_eq!(names.len(), 1, "{names:?}");
        assert!(names[0].ends_with(".rvwallet") && !names[0].contains("part"));
        // 열쇠로 풀면 원본, 다른 열쇠로는 안 열림.
        let back = work.join("back.dat");
        crate::lockbox::unlock_file(&path, &back, &key).unwrap();
        assert_eq!(std::fs::read(&back).unwrap(), body);
        assert!(crate::lockbox::unlock_file(&path, &work.join("bad.dat"), &[6u8; 32]).is_err());
        // 작업 폴더에 잠금 임시물이 남지 않는다.
        assert!(!work.join("sealed.tmp").exists() && !work.join("verify.tmp").exists());
    }

    #[test]
    fn export_never_overwrites_an_existing_file() {
        let work = dir("wf-work2");
        let out = dir("wf-out2");
        let plain = work.join("wallet.dat");
        fake_wallet(&plain);
        std::fs::write(out.join("RavenVault-wallet-S.rvwallet"), b"mine").unwrap();
        let (p, _) = seal_into(&plain, &out, &[1u8; 32], &work, "S").unwrap();
        assert!(p.file_name().unwrap().to_string_lossy().ends_with("S-2.rvwallet"));
        assert_eq!(std::fs::read(out.join("RavenVault-wallet-S.rvwallet")).unwrap(), b"mine");
    }

    #[test]
    fn export_refuses_an_empty_wallet_copy_and_a_missing_folder() {
        let work = dir("wf-work3");
        let plain = work.join("wallet.dat");
        std::fs::write(&plain, b"").unwrap();
        assert!(seal_into(&plain, &work, &[1u8; 32], &work, "S").is_err());
        assert!(check_dest("").is_err());
        assert!(check_dest("relative/path").is_err());
        assert!(check_dest("/definitely/not/here-rv087").is_err());
        let f = work.join("a-file");
        std::fs::write(&f, b"x").unwrap();
        assert!(check_dest(f.to_str().unwrap()).is_err(), "파일은 폴더가 아니다");
        assert!(check_dest(work.to_str().unwrap()).is_ok());
    }

    #[cfg(unix)]
    #[test]
    fn export_to_a_read_only_folder_fails_cleanly() {
        use std::os::unix::fs::PermissionsExt;
        let work = dir("wf-work4");
        let out = dir("wf-out4");
        let plain = work.join("wallet.dat");
        fake_wallet(&plain);
        std::fs::set_permissions(&out, std::fs::Permissions::from_mode(0o500)).unwrap();
        let r = seal_into(&plain, &out, &[1u8; 32], &work, "S");
        std::fs::set_permissions(&out, std::fs::Permissions::from_mode(0o700)).unwrap();
        // root 로 돌면 쓰기가 되므로, 실패일 때만 문구를 본다.
        if let Err(e) = r {
            assert!(e.contains("권한") || e.contains("만들지"), "{e}");
        }
        assert_eq!(std::fs::read_dir(&out).unwrap().filter(|e| e.as_ref().unwrap().file_name().to_string_lossy().ends_with(".part")).count(), 0);
    }

    #[test]
    fn export_refuses_the_app_and_node_folders() {
        let _g = crate::paths::TEST_ENV.lock().unwrap_or_else(|e| e.into_inner());
        let app = dir("wf-app");
        std::env::set_var("PLAYX_RAVEN_HOME", &app);
        let r = check_dest(app.to_str().unwrap());
        std::env::remove_var("PLAYX_RAVEN_HOME");
        assert!(r.is_err());
    }

    #[test]
    fn key_sheet_has_the_key_in_all_four_languages_and_escapes() {
        let paper = crate::lockbox::to_paper(&[3u8; 32]);
        assert_eq!(paper.replace('-', "").len(), 52);
        for l in ["ko", "en", "ja", "zh", "xx"] {
            let h = key_sheet_html(l, &paper);
            assert!(h.contains(&paper), "{l}");
            assert!(h.contains("52"), "{l}");
        }
        assert!(key_sheet_html("ko", "<b>&").contains("&lt;b&gt;&amp;"));
        assert!(key_sheet_html("ko", &paper).contains("52글자가 없으면 백업을 못 엽니다"));
        // 바탕화면에 두지 않고, 시작할 때 치우고, 정해진 시간 뒤 지운다.
        let src = include_str!("walletfile.rs");
        let f = &src[src.find("pub async fn key_sheet_print").unwrap()..];
        let f = &f[..f.find("\n}\n").unwrap()];
        assert!(!f.contains("Desktop") && f.contains("remove_file") && f.contains("SHEET_LIFETIME_SECS"));
        assert!(include_str!("lib.rs").contains("walletfile::sweep_key_sheet()"));
    }

    #[test]
    fn wallet_look_check_rejects_other_files() {
        let mut ok = vec![0u8; 32];
        ok[12..16].copy_from_slice(&[0x62, 0x31, 0x05, 0x00]);
        assert!(looks_like_wallet(&ok));
        assert!(looks_like_wallet(b"SQLite format 3\0rest"));
        assert!(!looks_like_wallet(&[0u8; 64]));
        assert!(!looks_like_wallet(b"%PDF-1.7 not a wallet at all"));
        assert!(!looks_like_wallet(b""));
    }

    #[test]
    fn staging_ids_cannot_escape() {
        for bad in ["", "..", "../x", "a/b", "ZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ", &"a".repeat(31), &"a".repeat(33)] {
            assert!(staging_dir(bad).is_err(), "{bad}");
        }
        assert!(valid_id(&"0123456789abcdef".repeat(2)));
    }

    #[test]
    fn the_new_commands_are_not_in_the_locked_allowlist_and_are_refused_while_locked() {
        for c in NEW {
            assert!(!crate::app_lock::allowed_while_locked(c), "{c} 가 잠긴 동안 허용 목록에 있다");
        }
        // 실제 문지기: 잠그면 거부, 풀면 통과(app_lock 의 시험용 실별 상태).
        crate::app_lock::lock("standby").unwrap();
        for c in NEW {
            assert!(!crate::app_lock::command_allowed(c), "잠긴 동안 {c} 가 통과한다");
        }
        crate::app_lock::lock("store").unwrap();
        for c in NEW {
            assert!(!crate::app_lock::command_allowed(c), "매장용 읽기 전용에서 {c} 가 통과한다");
        }
    }

    #[test]
    fn the_new_commands_are_registered_behind_the_lock_gate() {
        let lib = include_str!("lib.rs");
        let gate = lib.find("app_lock::command_allowed").unwrap();
        let handler = lib.find("generate_handler!").unwrap();
        assert!(gate < handler);
        for c in NEW {
            assert!(lib.contains(&format!("walletfile::{c},")), "{c} 등록");
        }
        // 폰·직원 HTTP 로는 열려 있지 않다.
        let server = include_str!("server.rs");
        assert!(!server.contains("wallet_export") && !server.contains("walletfile::"));
    }

    #[test]
    fn export_checks_password_first_then_reauths_then_writes() {
        let src = include_str!("walletfile.rs");
        let f = &src[src.find("pub async fn wallet_export").unwrap()..];
        let f = &f[..f.find("\n// ──").unwrap()];
        let enc = f.find("wallet_lock_state").expect("지갑 암호 유무 확인");
        let re = f.find("reauth(").expect("재인증");
        let backup = f.find("backupwallet").unwrap();
        let seal = f.find("seal_into(").unwrap();
        assert!(enc < re && re < backup && backup < seal, "순서: 암호 유무 → 재인증 → 사본 → 잠가 쓰기");
        assert!(f.contains("NEEDS_WALLET_PASS"), "지갑 암호가 없으면 안내 접두어로 막는다");
        // 평문 내보내기 길이 없다: dest 에 plain 을 복사하거나 쓰는 코드가 없다.
        assert!(!f.contains("fs::copy") && !f.contains("dest_dir.join(\"wallet.dat\")"));
    }

    #[test]
    fn import_never_touches_the_current_wallet_before_confirmation() {
        let src = include_str!("walletfile.rs");
        let prep = &src[src.find("pub async fn wallet_import_prepare").unwrap()..];
        let prep = &prep[..prep.find("/// 2단계").unwrap()];
        assert!(!prep.contains("restore_apply") && !prep.contains("raven_dir().join(\"wallet.dat\"),") , "1단계가 현재 지갑을 바꾼다");
        let apply = &src[src.find("pub async fn wallet_import_apply").unwrap()..];
        let confirm = apply.find("if !confirmed").unwrap();
        let restore = apply.find("restore_apply").unwrap();
        assert!(confirm < restore, "확인 전에 바꾸면 안 된다");
    }

    #[test]
    fn import_round_trip_with_key_and_wrong_key() {
        // 내보낸 파일을 풀어 임시 폴더에 두기까지(현재 지갑은 건드리지 않는다).
        let _g = crate::paths::TEST_ENV.lock().unwrap_or_else(|e| e.into_inner());
        let app = dir("wf-app2");
        std::env::set_var("PLAYX_RAVEN_HOME", &app);
        let work = dir("wf-work5");
        let out = dir("wf-out5");
        let plain = work.join("wallet.dat");
        fake_wallet(&plain);
        let key = [8u8; 32];
        let (p, _) = seal_into(&plain, &out, &key, &work, "S").unwrap();
        let paper = {
            // 종이 글자: 52글자 + 줄표
            let mut s = String::new();
            let mut bits = 0u32;
            let mut n = 0;
            const A: &[u8] = b"0123456789abcdefghjkmnpqrstvwxyz";
            for b in key {
                bits = (bits << 8) | b as u32;
                n += 8;
                while n >= 5 {
                    n -= 5;
                    s.push(A[((bits >> n) & 0x1f) as usize] as char);
                }
            }
            if n > 0 {
                s.push(A[((bits << (5 - n)) & 0x1f) as usize] as char);
            }
            s
        };
        assert_eq!(paper.len(), 52);
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        let bad = rt.block_on(wallet_import_prepare(p.to_string_lossy().to_string(), "key".into(), "0".repeat(52)));
        assert!(bad.is_err(), "틀린 열쇠로 열렸다");
        assert!(!staging_root().join("x").exists());
        let ok = rt.block_on(wallet_import_prepare(p.to_string_lossy().to_string(), "key".into(), paper)).unwrap();
        let id = ok["id"].as_str().unwrap().to_string();
        assert!(staging_dir(&id).unwrap().join("wallet.dat").is_file());
        assert_eq!(ok["same_as_current"], json!(false));
        assert!(rt.block_on(wallet_import_apply(id.clone(), false)).is_err(), "확인 없이 전환됐다");
        wallet_import_cancel();
        assert!(staging_dir(&id).is_err());
        // 암호로 여는 길이 없는 파일에 pass 모드는 막힌다.
        let nopass = rt.block_on(wallet_import_prepare(p.to_string_lossy().to_string(), "pass".into(), "아무암호아무암호아무".into()));
        assert!(nopass.is_err());
        std::env::remove_var("PLAYX_RAVEN_HOME");
    }
}
