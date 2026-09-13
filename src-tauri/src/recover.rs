//! Getting back on your feet — a lost phone, a dead computer, a new machine.
//!
//! ## Why this is not optional
//!
//! Backups were being written and there was no way to read them back. That is
//! not a backup system, it is a habit. The day a counter PC dies, a shop with
//! no restore path loses its member list, its menu and its takings history, and
//! it does not come back to this app — nor should it.
//!
//! ## The two orders that must not be swapped
//!
//! **Never overwrite `wallet.dat` while the node is running.** The node holds it
//! open in a Berkeley DB environment; replacing the file underneath produces a
//! wallet that opens and is wrong, which is worse than one that refuses to open.
//!
//! **Never overwrite `wallet.dat` without first setting the current one aside.**
//! Restoring the wrong folder is a normal mistake at 9am with a queue waiting.
//! If the previous file is gone, that mistake is permanent and it is money.
//!
//! ## What a phone loss actually is
//!
//! Not a wallet problem — the phone holds no keys. It holds a **role token** in
//! a URL, and whoever finds the phone can open the shop screen with it. So the
//! fix is to change the tokens, which invalidates every phone at once, and to
//! print fresh QR codes. Thirty seconds, no chain involved.

use serde_json::{json, Value};
use std::path::PathBuf;

#[path = "restore_lock.rs"]
mod restore_lock;

// Serializes unpack/restore/cleanup without holding a non-Send MutexGuard
// across the RPC await. DataDirGuard separately excludes other node processes.
static RESTORE_BUSY: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
struct RestoreOperation {
    session: Option<restore_lock::RestoreSessionGuard>,
}
impl RestoreOperation {
    fn begin() -> Result<Self, String> {
        use std::sync::atomic::Ordering;
        RESTORE_BUSY
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .map_err(|_| "다른 복원이 진행 중입니다. 끝난 뒤 다시 시도해 주세요.".to_string())?;
        match restore_lock::RestoreSessionGuard::acquire(&dir()) {
            Ok(session) => Ok(Self {
                session: Some(session),
            }),
            Err(error) => {
                RESTORE_BUSY.store(false, Ordering::Release);
                Err(error)
            }
        }
    }
    fn check(&self) -> Result<(), String> {
        self.session
            .as_ref()
            .ok_or("복원 잠금을 다시 확인해 주세요.")?
            .check()
    }
}
impl Drop for RestoreOperation {
    fn drop(&mut self) {
        // Close the POSIX record-lock FD BEFORE allowing another local opener.
        drop(self.session.take());
        RESTORE_BUSY.store(false, std::sync::atomic::Ordering::Release);
    }
}

fn dir() -> PathBuf {
    crate::paths::app_dir()
}

fn raven_dir() -> PathBuf {
    crate::paths::raven_dir()
}

fn node_path() -> PathBuf {
    dir().join("node.json")
}

/// This machine's name and id.
///
/// A shop with three branches ends up with three of these programs, and every
/// screen that says "이 컴퓨터" is ambiguous the moment there are two. The id is
/// generated once and never changes; the name is whatever the owner calls the
/// place out loud — 강남지점, 2층 계산대.
#[tauri::command]
pub fn node_identity() -> Value {
    if let Some(v) = std::fs::read_to_string(node_path())
        .ok()
        .and_then(|t| serde_json::from_str::<Value>(&t).ok())
    {
        return v;
    }
    // 아직 없으면 지금 만든다. id 는 기계에서 뽑는다 — 난수를 저장하기 전에
    // 앱이 죽으면 다음 실행에서 다른 id 가 나오고, 그러면 같은 가게가 두 곳이
    // 된다.
    // 🔴 여기가 `sysctl kern.uuid` 와 `$HOME` 이었다. 윈도우에는 **둘 다
    //    없다** — `sysctl` 이 없고 집 폴더 변수는 `USERPROFILE` 이다.
    //    그래서 씨앗이 모든 윈도우 컴퓨터에서 같아지고, **모든 윈도우
    //    노드가 같은 고유번호**를 갖게 된다. 같은 가게가 두 곳으로 보이는
    //    것을 막으려고 만든 자리인데 정반대가 된다.
    let seed = format!("{}-{}", machine_uuid(), crate::paths::home().to_string_lossy());
    let mut h = sha2::Sha256::new();
    use sha2::Digest;
    h.update(seed.as_bytes());
    let id = hex::encode(h.finalize())[..12].to_string();

    let v = json!({ "id": id, "name": "" });
    let _ = std::fs::create_dir_all(dir());
    let _ = std::fs::write(node_path(), serde_json::to_vec_pretty(&v).unwrap_or_default());
    v
}

/// 이 기계의 고유번호. 다시 켜도 같은 값이 나와야 한다.
fn machine_uuid() -> String {
    #[cfg(target_os = "macos")]
    {
        return crate::quiet::cmd("sysctl")
            .args(["-n", "kern.uuid"])
            .output()
            .ok()
            .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
            .unwrap_or_default();
    }
    #[cfg(target_os = "windows")]
    {
        // 윈도우를 깔 때 한 번 정해지고 안 바뀐다.
        return crate::quiet::cmd("reg")
            .args([
                "query",
                r"HKLM\SOFTWARE\Microsoft\Cryptography",
                "/v",
                "MachineGuid",
            ])
            .output()
            .ok()
            .map(|o| String::from_utf8_lossy(&o.stdout).to_string())
            .and_then(|t| {
                t.lines()
                    .find(|l| l.contains("MachineGuid"))
                    .and_then(|l| l.split_whitespace().last().map(|s| s.to_string()))
            })
            .unwrap_or_default();
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        return std::fs::read_to_string("/etc/machine-id")
            .or_else(|_| std::fs::read_to_string("/var/lib/dbus/machine-id"))
            .map(|s| s.trim().to_string())
            .unwrap_or_default();
    }
}

/// Names this machine.
#[tauri::command]
pub fn node_rename(name: String) -> Result<Value, String> {
    let mut v = node_identity();
    if let Some(m) = v.as_object_mut() {
        m.insert("name".into(), json!(name.trim()));
    }
    std::fs::write(
        node_path(),
        serde_json::to_vec_pretty(&v).map_err(|e| e.to_string())?,
    )
    .map_err(|e| format!("저장하지 못했습니다: {e}"))?;
    Ok(v)
}

/// Unpacks a `.zip` backup to a scratch folder so the rest of this module can
/// treat it like any other folder.
///
/// The one-file backup and the nightly folder backup should not need two
/// restore paths — two paths means one of them is the tested one and the other
/// is where the bug lives.
#[cfg(test)]
mod lock_tests {
    /// 🔴 **암호를 만들어 놓고 쓸 길이 없었다.** 새 컴퓨터에는 열쇠 파일이
    /// 없으니 「다른 컴퓨터의 자물쇠」라고 답하고 끝났다 — 정확히 백업이
    /// 필요한 그 상황에서 막힌다.
    #[test]
    fn 새_컴퓨터에서_암호로_되돌릴_수_있다() {
        let src = include_str!("recover.rs");
        assert!(src.contains("unwrap_key"), "암호로 여는 줄이 없다");
        assert!(src.contains("strip_wrap"), "봉투를 떼는 줄이 없다");
        // 두 명령 다 암호를 받아야 한다. 하나만 받으면 살펴보기는 되고
        // 되돌리기가 안 되는, 더 나쁜 상태가 된다.
        // 🔴 그냥 이름으로 찾으면 **이 시험 자신**을 읽는다(같은 함정 세 번째).
        //    선언부만 본다.
        for decl in [
            format!("pub fn restore_{}(", "survey"),
            format!("pub async fn restore_{}(", "apply"),
        ] {
            let decl = decl.as_str();
            let i = src.find(decl).unwrap_or_else(|| panic!("{decl} 이 없다"));
            let sig: String = src[i..].chars().take(140).collect();
            assert!(sig.contains("pass"), "{decl} 가 암호를 안 받는다");
        }
    }

    /// 🔴 **되돌릴 수 없는 백업은 백업이 아니다.**
    ///
    /// 잠근 백업의 확장자를 `.잠김` → `.pxlock` 으로 바꿨는데, 되돌리기 쪽
    /// 코드와 파일 고르는 창이 옛 이름만 알고 있었다. 그래서 사장이 파일을
    /// 고르려 하면 **회색으로 뜨고 「열기」가 안 눌렸다.** 만드는 이름을
    /// 바꾸면 여는 쪽도 같이 바꿔야 한다.
    #[test]
    fn 되돌리기가_잠근_백업을_안다() {
        let src = include_str!("recover.rs");
        assert!(src.contains("unlock_file"), "잠근 백업을 푸는 줄이 없다");
        assert!(src.contains(r#"ext == "pxlock""#), "새 이름을 모른다");
        // 옛 이름으로 만들어 둔 백업이 이미 있다. 계속 받아야 한다.
        assert!(src.contains(r#"ext == "잠김""#), "옛 이름 백업을 버리면 안 된다");
    }

    /// 가게를 다른 컴퓨터로 옮기려면 간판 열쇠가 같이 가야 한다.
    /// 자산만 보내면 돈은 가지만 「이 가게」는 안 간다.
    #[test]
    fn 되돌리기가_간판_열쇠를_가져온다() {
        let src = include_str!("recover.rs");
        assert!(
            src.contains("shopkey.json"),
            "되돌리기가 가게 간판 열쇠를 안 가져온다"
        );
        assert!(
            src.contains("tickets.json"),
            "되돌리기가 이용권을 안 가져온다"
        );
        assert!(
            src.contains("bookings.json"),
            "되돌리기가 예약을 안 가져온다"
        );
    }
}

fn unpack_if_zip(input: &str) -> Result<PathBuf, String> {
    unpack_with(input, "")
}

/// 암호를 받아서 푼다. 빈 문자열이면 이 컴퓨터의 열쇠만 쓴다.
fn unpack_with(input: &str, pass: &str) -> Result<PathBuf, String> {
    let p = PathBuf::from(input);
    let scratch = dir().join("restore-open");
    if let (Ok(source), Ok(temporary)) =
        (std::fs::canonicalize(&p), std::fs::canonicalize(&scratch))
    {
        if source.starts_with(temporary) {
            return Err(
                "임시 복원 폴더는 백업 원본으로 사용할 수 없습니다. 원래 백업 파일을 골라 주세요."
                    .into(),
            );
        }
    }
    if p.is_dir() {
        return Ok(p);
    }
    if !p.is_file() {
        return Err("파일도 폴더도 아닙니다.".into());
    }
    cleanup_opened().map_err(|e| {
        format!("이전 임시 파일을 정리하지 못했습니다. 저장 폴더를 확인해 주세요: {e}")
    })?;
    std::fs::create_dir_all(dir()).map_err(|e| e.to_string())?;
    let mut builder = std::fs::DirBuilder::new();
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder.create(&scratch).map_err(|e| e.to_string())?;

    let result = (|| {
        // 🔴 **잠근 백업을 먼저 푼다.** 우리가 만드는 백업은 `.zip.pxlock`(옛 이름은
        //    `.zip.잠김`)이라 그대로는 zip 이 아니다. 여태 되돌리기는 zip 만 알아서,
        //    잠근 백업을 고르면 「PLAY X Raven 백업이 아닙니다」로 끝났다.
        //    **백업은 만드는 것보다 되돌리는 것이 본업이다.**
        // 🔴 **이름으로 판단하면 안 된다. 이름은 거짓말을 한다.**
        //
        //    「가게 옮기기」가 그래서 통째로 안 됐다. 보내는 쪽은 **잠긴 파일**을
        //    주는데(`backup_zip` 이 늘 잠근다), 받는 쪽 `move_fetch` 는 그걸
        //    `이사.zip` 이라는 이름으로 저장한다. 확장자가 `zip` 이라 여기서
        //    안 풀고 그대로 열려다 「이 파일은 PLAY X Raven 백업이 아닙니다」로
        //    끝났다 — 대표님이 윈도우에서 본 그 글자다(2026-08-31).
        //
        //    파일 앞 여덟 바이트가 `PXRLOCK1` 이면 잠긴 것이다. 그걸 본다.
        let 잠김 = std::fs::read(&p)
            .map(|b| b.len() >= 8 && &b[..8] == b"PXRLOCK1")
            .unwrap_or(false);
        let ext = p.extension().and_then(|e| e.to_str()).unwrap_or("");
        let p = if 잠김 || ext == "pxlock" || ext == "잠김" {
            let opened = scratch.join("backup.zip");
            // 🔴 **암호를 만들어 놓고 쓸 길이 없었다.** 새 컴퓨터에서는 이 컴퓨터의
            //    열쇠 파일이 없으니 「다른 컴퓨터의 자물쇠」라고 답하고 끝났다 —
            //    정확히 백업이 필요한 그 상황에서 막힌다. 암호를 받는다.
            //
            //    순서: ① 이 컴퓨터 열쇠 ② 사장이 친 암호. 같은 컴퓨터에서는
            //    ①에서 바로 열리므로 암호를 안 물어본다.
            let raw = std::fs::read(&p).map_err(|e| format!("읽지 못했습니다: {e}"))?;
            let mut done = false;
            if let Ok(k) = crate::lockbox::key_get_or_make() {
                if crate::lockbox::unlock_file(&p, &opened, &k).is_ok() {
                    done = true;
                }
            }
            if !done {
                if pass.trim().is_empty() {
                    return Err(
                        "이 백업은 다른 컴퓨터에서 만든 것입니다. 그때 정하신 암호를 넣어 주세요."
                            .into(),
                    );
                }
                let (_body, env) = crate::lockbox::strip_wrap(&raw);
                let env = env.ok_or_else(|| {
                "이 백업에는 암호로 여는 길이 없습니다. 만든 컴퓨터의 열쇠(9agn-…)가 있어야 합니다.".to_string()
            })?;
                let k = crate::lockbox::unwrap_key(env, pass)?;
                crate::lockbox::unlock_file(&p, &opened, &k)
                    .map_err(|_| "암호는 맞는데 파일이 손상됐습니다.".to_string())?;
            }
            opened
        } else {
            p
        };

        restore_files::extract_archive(&p, &scratch)?;
        Ok(scratch.clone())
    })();
    match result {
        Ok(path) => Ok(path),
        Err(error) => {
            if let Err(cleanup) = std::fs::remove_dir_all(&scratch) {
                return Err(format!(
                    "{error}; 임시 복원 폴더를 정리해 주세요: {cleanup}"
                ));
            }
            Err(error)
        }
    }
}

/// Reads a backup folder and says what is inside, in counts a person can check.
///
/// Deliberately before restoring, and deliberately in nouns rather than file
/// names: "회원 12명" is checkable at a glance and "passes.json 4.2 KB" is not.
/// Restoring the wrong night's folder is the mistake this exists to catch.
#[tauri::command]
pub fn restore_survey(folder: String, pass: Option<String>) -> Result<Value, String> {
    let _operation = RestoreOperation::begin()?;
    // 폴더든 zip 이든 여기서 같아진다.
    let dir = unpack_with(&folder, pass.as_deref().unwrap_or(""))?;

    let count_in = |file: &str, key: &str| -> Option<usize> {
        let v: Value = serde_json::from_str(&std::fs::read_to_string(dir.join(file)).ok()?).ok()?;
        Some(v.get(key)?.as_array()?.len())
    };

    let shop: Option<Value> = std::fs::read_to_string(dir.join("shop.json"))
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok());

    let wallet = dir.join("wallet.dat");
    let wallet_size = std::fs::metadata(&wallet).map(|m| m.len()).unwrap_or(0);

    let mut items = Vec::new();
    if wallet_size > 0 {
        items.push(json!({
            "key": "wallet",
            "what": "지갑",
            "detail": format!("{:.1} MB", wallet_size as f64 / 1_048_576.0),
            "why": "잔액과 자산의 열쇠입니다",
        }));
    }
    if let Some(s) = &shop {
        items.push(json!({
            "key": "shop",
            "what": "가게",
            "detail": format!(
                "{} · 메뉴 {}개",
                s.get("name").and_then(Value::as_str).filter(|x| !x.is_empty()).unwrap_or("(이름 없음)"),
                s.get("menu").and_then(Value::as_array).map(|a| a.len()).unwrap_or(0)
            ),
            "why": if dir.join("shopkey.json").exists() {
                "간판·메뉴·가격·사진 · 장터에 올리는 열쇠"
            } else {
                "간판·메뉴·가격·사진"
            },
        }));
    }
    if let Some(n) = count_in("passes.json", "passes") {
        items.push(
            json!({ "key": "passes", "what": "회원", "detail": format!("{n}명"),
                           "why": "이름·기간·남은 횟수" }),
        );
    }
    if let Some(n) = count_in("tickets.json", "tickets") {
        items.push(
            json!({ "key": "tickets", "what": "이용권", "detail": format!("{n}장"),
                           "why": "카운터에서 판 표 — 잃으면 손님이 산 표가 사라집니다" }),
        );
    }
    if let Some(n) = count_in("bookings.json", "bookings") {
        items.push(
            json!({ "key": "bookings", "what": "예약", "detail": format!("{n}건"),
                           "why": "잃으면 손님은 오는데 가게가 모릅니다" }),
        );
    }
    if let Some(n) = count_in("sessions.json", "sessions") {
        items.push(
            json!({ "key": "sessions", "what": "수업", "detail": format!("{n}개 회차"),
                           "why": "신청자와 대기자" }),
        );
    }
    if dir.join("fills.json").exists() {
        items.push(
            json!({ "key": "fills", "what": "발송 기록", "detail": "있음",
                           "why": "이게 없으면 복구 뒤 같은 자산을 한 번 더 보냅니다" }),
        );
    }
    if dir.join("orders.json").exists() {
        items.push(
            json!({ "key": "orders", "what": "주문 주소", "detail": "있음",
                           "why": "손님이 적은 받을 주소" }),
        );
    }
    if dir.join("sweep.json").exists() {
        items.push(
            json!({ "key": "sweep", "what": "자동 송금", "detail": "있음",
                           "why": "금고로 옮기는 설정" }),
        );
    }

    // 어느 날 것인지가 "복원해도 되나"의 절반이다. 폴더면 폴더 이름이 날짜고,
    // zip 이면 파일 이름에 들어 있다.
    let day = PathBuf::from(&folder)
        .file_stem()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();

    Ok(json!({
        "folder": folder,
        "day": day,
        "items": items,
        "empty": items.is_empty(),
        "note": if items.is_empty() {
            "이 폴더에는 되돌릴 것이 없습니다. 다른 폴더를 고르세요."
        } else {
            "되돌리기 전에 위 숫자가 맞는지 봐 주세요."
        },
    }))
}

/// Restores only after the replacement and a unique previous copy verify.
#[tauri::command]
pub async fn restore_apply(
    folder: String,
    keys: Vec<String>,
    pass: Option<String>,
) -> Result<Value, String> {
    let operation = RestoreOperation::begin()?;
    let app_target = dir();
    let wallet_target = raven_dir();
    let src = unpack_with(&folder, pass.as_deref().unwrap_or(""))?;
    if std::fs::symlink_metadata(src.join(".backup-complete.json")).is_ok() && !crate::backup::complete_snapshot(&src) {
        let _ = cleanup_opened();
        return Err("백업 내용이 완료 기록과 다릅니다. 현재 파일은 바꾸지 않았습니다. 다른 백업을 골라 주세요.".into());
    }
    // RPC failure is ambiguous (authentication, timeout, shutdown). The compatible
    // datadir lock, acquired below AFTER this await, provides exclusion instead.
    let rpc_responding = if keys.iter().any(|key| key == "wallet") {
        crate::raven::call_rpc("getblockchaininfo", json!([]))
            .await
            .is_ok()
    } else {
        false
    };
    operation.check()?;
    if dir() != app_target
        || (keys.iter().any(|key| key == "wallet") && raven_dir() != wallet_target)
    {
        let _ = cleanup_opened();
        return Err(
            "복원 중 대상 폴더 설정이 바뀌었습니다. 대상 폴더를 확인하고 다시 시도해 주세요."
                .into(),
        );
    }
    let result = restore_files::apply(&src, &app_target, &wallet_target, &keys, rpc_responding);
    // Run the internal cleanup while our operation gate is held.
    let cleanup = cleanup_opened();
    let mut result = result;
    if let Err(error) = cleanup {
        result["cleanup_warning"] = json!(format!("복원 임시 파일을 지우지 못했습니다. 이 컴퓨터를 안전하게 보관하고 다시 정리해 주세요: {error}"));
    }
    Ok(result)
}

// BEGIN RESTORE FILE SAFETY (also compiled by the standalone synthetic harness)
mod restore_files {
    use super::restore_lock::{self, DataDirGuard};
    use serde_json::{json, Value};
    use sha2::{Digest, Sha256};
    use std::fs::{self, File, OpenOptions};
    use std::io::{self, Read, Seek, SeekFrom, Write};
    use std::path::{Path, PathBuf};
    use std::sync::atomic::{AtomicU64, Ordering};

    static NEXT: AtomicU64 = AtomicU64::new(0);
    type Hook<'a> = dyn FnMut(&str, &Path) -> io::Result<()> + 'a;

    #[derive(Debug)]
    pub(super) struct RestoreError {
        pub why: String,
        pub previous: Option<PathBuf>,
        pub changed: bool,
    }

    fn error(why: impl ToString) -> RestoreError {
        RestoreError {
            why: why.to_string(),
            previous: None,
            changed: false,
        }
    }

    fn regular_file(path: &Path) -> io::Result<File> {
        let meta = fs::symlink_metadata(path)?;
        if !meta.is_file() || meta.file_type().is_symlink() {
            return Err(io::Error::other(
                "일반 파일만 되돌릴 수 있습니다. 다른 백업을 골라 주세요.",
            ));
        }
        let mut options = OpenOptions::new();
        options.read(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
        }
        #[cfg(windows)]
        {
            use std::os::windows::fs::{MetadataExt, OpenOptionsExt};
            use windows_sys::Win32::Storage::FileSystem::*;
            if meta.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
                return Err(io::Error::other(
                    "바로가기 파일 대신 원본 파일을 골라 주세요.",
                ));
            }
            options.custom_flags(FILE_FLAG_OPEN_REPARSE_POINT);
        }
        let file = options.open(path)?;
        if !file.metadata()?.is_file() || !restore_lock::same_file_at(&file, path)? {
            return Err(io::Error::other(
                "파일이 바뀌었습니다. 백업을 다시 골라 주세요.",
            ));
        }
        Ok(file)
    }

    fn hash(file: &mut File) -> io::Result<[u8; 32]> {
        file.seek(SeekFrom::Start(0))?;
        let mut digest = Sha256::new();
        let mut buffer = [0u8; 65536];
        loop {
            let count = file.read(&mut buffer)?;
            if count == 0 {
                break;
            }
            digest.update(&buffer[..count]);
        }
        Ok(digest.finalize().into())
    }

    fn new_file(destination: &Path, suffix: &str) -> io::Result<(PathBuf, File)> {
        let parent = destination
            .parent()
            .ok_or_else(|| io::Error::other("missing destination directory"))?;
        let name = destination
            .file_name()
            .ok_or_else(|| io::Error::other("missing destination name"))?
            .to_string_lossy();
        for _ in 0..64 {
            let sequence = NEXT.fetch_add(1, Ordering::Relaxed);
            let path = parent.join(format!(
                ".{name}.{suffix}-{}-{sequence}",
                std::process::id()
            ));
            let mut options = OpenOptions::new();
            options.read(true).write(true).create_new(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                options.mode(0o600);
            }
            match options.open(&path) {
                Ok(file) => return Ok((path, file)),
                Err(e) if e.kind() == io::ErrorKind::AlreadyExists => continue,
                Err(e) => return Err(e),
            }
        }
        Err(io::Error::other(
            "보존 파일 자리를 만들지 못했습니다. 저장 공간을 확인해 주세요.",
        ))
    }

    fn copy_checked(
        source: &mut File,
        destination: &Path,
        suffix: &str,
        hook: &mut Hook<'_>,
    ) -> io::Result<(PathBuf, [u8; 32])> {
        let (path, mut out) = new_file(destination, suffix)?;
        let result = (|| {
            source.seek(SeekFrom::Start(0))?;
            let mut digest = Sha256::new();
            let mut buffer = [0u8; 65536];
            loop {
                let count = source.read(&mut buffer)?;
                if count == 0 {
                    break;
                }
                out.write_all(&buffer[..count])?;
                digest.update(&buffer[..count]);
                hook(suffix, &path)?;
            }
            out.sync_all()?;
            let expected: [u8; 32] = digest.finalize().into();
            hook("verify-copy", &path)?;
            if hash(&mut out)? != expected || hash(source)? != expected {
                return Err(io::Error::other(
                    "복사한 내용이 원본과 다릅니다. 다른 백업이나 저장 장치를 확인해 주세요.",
                ));
            }
            Ok(expected)
        })();
        drop(out);
        match result {
            Ok(digest) => Ok((path, digest)),
            Err(error) => {
                // Only this create_new file; never delete a previous good copy.
                if let Err(cleanup) = fs::remove_file(&path) {
                    return Err(io::Error::other(format!(
                        "{error}; 임시 파일 정리가 필요합니다: {} ({cleanup})",
                        path.display()
                    )));
                }
                Err(error)
            }
        }
    }

    fn sync_directory(directory: &Path) -> io::Result<()> {
        #[cfg(unix)]
        {
            restore_lock::open_directory(directory)?.sync_all()
        }
        // Prepared file data is flushed on Windows. FlushFileBuffers cannot
        // flush directories; ReplaceFileW has no supported write-through flag.
        #[cfg(not(unix))]
        {
            let _ = directory;
            Ok(())
        }
    }

    fn replace(
        stage: &Path,
        destination: &Path,
        had_destination: bool,
        previous: &mut Option<PathBuf>,
        changed: &mut bool,
    ) -> io::Result<()> {
        #[cfg(unix)]
        {
            if !had_destination {
                // Atomic create-if-absent: never replace a file created by a
                // writer after the earlier metadata check.
                fs::hard_link(stage, destination)?;
                *changed = true;
                fs::remove_file(stage)?;
                return Ok(());
            }
            use std::ffi::CString;
            use std::os::unix::ffi::OsStrExt;
            let from = CString::new(stage.as_os_str().as_bytes()).map_err(io::Error::other)?;
            let to = CString::new(destination.as_os_str().as_bytes()).map_err(io::Error::other)?;
            #[cfg(target_vendor = "apple")]
            let result = unsafe { libc::renamex_np(from.as_ptr(), to.as_ptr(), libc::RENAME_SWAP) };
            #[cfg(target_os = "linux")]
            let result = unsafe {
                libc::syscall(
                    libc::SYS_renameat2,
                    libc::AT_FDCWD,
                    from.as_ptr(),
                    libc::AT_FDCWD,
                    to.as_ptr(),
                    libc::RENAME_EXCHANGE,
                ) as i32
            };
            #[cfg(not(any(target_vendor = "apple", target_os = "linux")))]
            let result = {
                return Err(io::Error::other(
                    "이 운영체제는 원본을 보존하는 원자 교환을 지원하지 않습니다.",
                ));
            };
            if result != 0 {
                return Err(io::Error::last_os_error());
            }
            // The actual overwritten inode is now at stage, including a normal
            // writer's last rename between verification and this syscall.
            *changed = true;
            *previous = Some(stage.to_path_buf());
            use std::os::unix::fs::PermissionsExt;
            regular_file(stage)?.set_permissions(fs::Permissions::from_mode(0o600))?;
            regular_file(stage)?.sync_all()?;
            Ok(())
        }
        #[cfg(windows)]
        {
            use std::os::windows::ffi::OsStrExt;
            use windows_sys::Win32::Storage::FileSystem::{
                MoveFileExW, ReplaceFileW, MOVEFILE_WRITE_THROUGH,
            };
            let wide = |path: &Path| {
                path.as_os_str()
                    .encode_wide()
                    .chain(Some(0))
                    .collect::<Vec<u16>>()
            };
            let from = wide(stage);
            let to = wide(destination);
            if !had_destination {
                // No MOVEFILE_REPLACE_EXISTING: a concurrent new file wins.
                if unsafe { MoveFileExW(from.as_ptr(), to.as_ptr(), MOVEFILE_WRITE_THROUGH) } == 0 {
                    return Err(io::Error::last_os_error());
                }
                *changed = true;
                return Ok(());
            }
            let (backup, placeholder) = new_file(destination, "before-restore-at-replace")?;
            drop(placeholder);
            fs::remove_file(&backup)?;
            let backup_wide = wide(&backup);
            // ReplaceFileW saves the file actually replaced. Do not set its
            // unsupported REPLACEFILE_WRITE_THROUGH flag or ignore ACL errors.
            let success = unsafe {
                ReplaceFileW(
                    to.as_ptr(),
                    from.as_ptr(),
                    backup_wide.as_ptr(),
                    0,
                    std::ptr::null_mut(),
                    std::ptr::null_mut(),
                )
            } != 0;
            let error = io::Error::last_os_error();
            if backup.is_file() {
                *previous = Some(backup.clone());
                *changed = true;
            }
            if !success {
                // ERROR_UNABLE_TO_MOVE_REPLACEMENT_2 can leave the old file at
                // backup. Keep it, and best-effort restore its original name
                // without overwriting any concurrent writer. Never report OK.
                if backup.is_file()
                    && matches!(fs::symlink_metadata(destination), Err(ref e) if e.kind() == io::ErrorKind::NotFound)
                {
                    let _ = fs::hard_link(&backup, destination);
                }
                return Err(error);
            }
            *changed = true;
            if !backup.is_file() {
                return Err(io::Error::other("교체한 이전 파일을 확인하지 못했습니다. 노드를 켜지 말고 보존 파일을 확인해 주세요."));
            }
            Ok(())
        }
        #[cfg(not(any(unix, windows)))]
        {
            let _ = (stage, destination, had_destination, previous, changed);
            Err(io::Error::other("unsupported atomic replacement platform"))
        }
    }

    pub(super) fn install(
        source: &Path,
        destination: &Path,
        json_file: bool,
        guard: &mut dyn FnMut() -> Result<(), String>,
        hook: &mut Hook<'_>,
    ) -> Result<Option<PathBuf>, RestoreError> {
        guard().map_err(error)?;
        let parent = destination
            .parent()
            .ok_or_else(|| error("대상 폴더를 다시 골라 주세요."))?;
        let parent = fs::canonicalize(parent).map_err(error)?;
        let directory = restore_lock::open_directory(&parent).map_err(error)?;
        let dest = parent.join(
            destination
                .file_name()
                .ok_or_else(|| error("대상 파일 이름을 확인해 주세요."))?,
        );
        let mut input = regular_file(source).map_err(error)?;
        if input.metadata().map_err(error)?.len() == 0 {
            return Err(error("백업 파일이 비어 있습니다. 다른 백업을 골라 주세요."));
        }
        let mut old = match fs::symlink_metadata(&dest) {
            Ok(_) => Some(regular_file(&dest).map_err(error)?),
            Err(e) if e.kind() == io::ErrorKind::NotFound => None,
            Err(e) => return Err(error(e)),
        };
        if restore_lock::same_file_at(&input, &dest).unwrap_or(false) {
            return Err(error(
                "백업과 현재 파일이 같습니다. 다른 백업을 골라 주세요.",
            ));
        }
        let (stage, expected) =
            copy_checked(&mut input, &dest, "restore-stage", hook).map_err(error)?;
        let mut previous: Option<PathBuf> = None;
        let mut changed = false;
        let result: Result<(), String> = (|| {
            if json_file {
                let file = regular_file(&stage).map_err(|e| e.to_string())?;
                serde_json::from_reader::<_, Value>(file).map_err(|_| {
                    "백업 문서가 올바른 JSON이 아닙니다. 다른 백업을 골라 주세요.".to_string()
                })?;
            }
            let old_hash = if let Some(file) = old.as_mut() {
                let (path, digest) =
                    copy_checked(file, &dest, "before-restore", hook).map_err(|e| e.to_string())?;
                previous = Some(path);
                sync_directory(&parent).map_err(|e| e.to_string())?;
                Some(digest)
            } else {
                None
            };
            hook("before-replace", &stage).map_err(|e| e.to_string())?;
            guard()?;
            if !restore_lock::same_file_at(&directory, &parent).unwrap_or(false)
                || fs::canonicalize(destination.parent().unwrap())
                    .ok()
                    .as_ref()
                    != Some(&parent)
                || !restore_lock::same_file_at(&input, source).unwrap_or(false)
                || hash(&mut input).map_err(|e| e.to_string())? != expected
            {
                return Err("복원 중 원본이나 대상 폴더가 바뀌었습니다. 파일을 확인하고 다시 시도해 주세요.".into());
            }
            match old.as_mut() {
                Some(file) => {
                    if !restore_lock::same_file_at(file, &dest).unwrap_or(false)
                        || Some(hash(file).map_err(|e| e.to_string())?) != old_hash
                    {
                        return Err(
                            "현재 파일이 복원 중 바뀌었습니다. 작업을 끝낸 뒤 다시 시도해 주세요."
                                .into(),
                        );
                    }
                }
                None => match fs::symlink_metadata(&dest) {
                    Err(e) if e.kind() == io::ErrorKind::NotFound => {}
                    _ => return Err(
                        "대상에 새 파일이 생겼습니다. 현재 파일을 확인한 뒤 다시 시도해 주세요."
                            .into(),
                    ),
                },
            }
            if hash(&mut regular_file(&stage).map_err(|e| e.to_string())?)
                .map_err(|e| e.to_string())?
                != expected
            {
                return Err(
                    "복원 준비본이 바뀌었습니다. 다른 저장 위치에서 다시 시도해 주세요.".into(),
                );
            }
            hook("replace", &stage).map_err(|e| e.to_string())?;
            // Atomically preserve the file actually replaced, including a
            // normal JSON writer that finishes after our last check.
            replace(&stage, &dest, old.is_some(), &mut previous, &mut changed)
                .map_err(|e| e.to_string())?;
            hook("after-replace", &dest).map_err(|e| e.to_string())?;
            sync_directory(&parent).map_err(|e| e.to_string())?;
            guard()?;
            if hash(&mut regular_file(&dest).map_err(|e| e.to_string())?)
                .map_err(|e| e.to_string())?
                != expected
            {
                return Err("교체 후 파일을 확인하지 못했습니다. 보존한 이전 파일로 확인하기 전에는 노드를 켜지 마세요.".into());
            }
            Ok(())
        })();
        if let Err(why) = result {
            let mut why = why;
            if !changed {
                if let Err(e) = fs::remove_file(&stage) {
                    if e.kind() != io::ErrorKind::NotFound {
                        why.push_str(&format!(
                            "; 임시 파일 정리가 필요합니다: {} ({e})",
                            stage.display()
                        ));
                    }
                }
            }
            return Err(RestoreError {
                why,
                previous,
                changed,
            });
        }
        Ok(previous)
    }

    pub(super) fn apply(
        source: &Path,
        app_dir: &Path,
        raven_dir: &Path,
        keys: &[String],
        rpc_responding: bool,
    ) -> Value {
        let mut done = Vec::new();
        let mut failed = Vec::new();
        let mut changed = false;
        let mut record = |label: &str, result: Result<Option<PathBuf>, RestoreError>| match result {
            Ok(previous) => {
                changed = true;
                done.push(json!({"what": label, "previous": previous,
                        "note": if label == "지갑" { "노드를 켜면 적용됩니다. 지갑의 유효성은 노드가 확인합니다." } else { "" }}));
            }
            Err(error) => {
                changed |= error.changed;
                failed.push(json!({"what": label, "why": error.why,
                        "previous": error.previous, "changed": error.changed}));
            }
        };
        if keys.iter().any(|key| key == "wallet") {
            let result = (|| {
                if rpc_responding {
                    return Err(error(
                        "노드가 응답하고 있습니다. 노드를 완전히 종료한 뒤 다시 시도해 주세요.",
                    ));
                }
                let guard = DataDirGuard::acquire(raven_dir).map_err(error)?;
                let from = source.join("wallet.dat");
                let destination = guard.directory().join("wallet.dat");
                guard
                    .check_wallet_paths(&from, &destination)
                    .map_err(error)?;
                install(
                    &from,
                    &destination,
                    false,
                    &mut || guard.check_wallet_paths(&from, &destination),
                    &mut |_, _| Ok(()),
                )
            })();
            record("지갑", result);
        }
        for (key, name, label) in [
            ("shop", "shop.json", "가게"),
            ("shop", "shopkey.json", "가게 간판 열쇠"),
            ("passes", "passes.json", "회원"),
            ("tickets", "tickets.json", "이용권"),
            ("bookings", "bookings.json", "예약"),
            ("sessions", "sessions.json", "수업"),
            ("orders", "orders.json", "주문 주소"),
            ("fills", "fills.json", "발송 기록"),
            ("sweep", "sweep.json", "자동 송금 설정"),
        ] {
            if !keys.iter().any(|requested| requested == key) {
                continue;
            }
            let from = source.join(name);
            // Older shop backups did not include a shop key. Other explicitly
            // selected missing files are failures, not silently successful skips.
            if name == "shopkey.json" && !from.exists() {
                continue;
            }
            let result = fs::create_dir_all(app_dir).map_err(error).and_then(|_| {
                install(
                    &from,
                    &app_dir.join(name),
                    true,
                    &mut || Ok(()),
                    &mut |_, _| Ok(()),
                )
            });
            record(label, result);
        }
        let ok = failed.is_empty() && !done.is_empty();
        json!({"ok": ok, "done": done, "failed": failed, "restart_app": changed,
            "status": if ok { "complete" } else if changed { "partial" } else { "failed" },
            "note": if ok { "앱을 다시 켜면 되돌린 내용이 보입니다." }
                else if changed { "일부만 되돌렸습니다. 실패한 항목과 이전 파일 위치를 확인해 주세요." }
                else { "되돌린 항목이 없습니다. 실패한 항목을 확인하고 다시 시도해 주세요." }})
    }
    pub(super) fn extract_archive(path: &Path, scratch: &Path) -> Result<(), String> {
        let mut zip = zip::ZipArchive::new(regular_file(path).map_err(|e| e.to_string())?)
            .map_err(|_| "이 파일은 PLAY X Raven 백업이 아닙니다.".to_string())?;
        if zip.len() > 1024 {
            return Err("백업 항목이 너무 많습니다. 다른 백업을 골라 주세요.".into());
        }
        let mut names = std::collections::HashSet::new();
        let mut total = 0u64;
        for i in 0..zip.len() {
            let mut entry = zip.by_index(i).map_err(|e| e.to_string())?;
            if entry.is_dir() {
                continue;
            }
            if entry
                .unix_mode()
                .is_some_and(|mode| mode & 0o170000 != 0 && mode & 0o170000 != 0o100000)
            {
                return Err(
                    "백업에 일반 파일이 아닌 항목이 있습니다. 다른 백업을 골라 주세요.".into(),
                );
            }
            let name = entry
                .enclosed_name()
                .and_then(|name| name.file_name().map(|name| name.to_owned()))
                .ok_or_else(|| {
                    "백업 경로가 올바르지 않습니다. 다른 백업을 골라 주세요.".to_string()
                })?;
            if !names.insert(name.clone()) {
                return Err(
                    "백업에 같은 이름의 파일이 둘 있습니다. 다른 백업을 골라 주세요.".into(),
                );
            }
            total = total
                .checked_add(entry.size())
                .ok_or("백업 크기를 확인하지 못했습니다.")?;
            if total > 4 * 1024 * 1024 * 1024 {
                return Err(
                    "백업 크기가 4 GB를 넘습니다. 필요한 파일만 있는 백업을 골라 주세요.".into(),
                );
            }
            let mut options = OpenOptions::new();
            options.write(true).create_new(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                options.mode(0o600);
            }
            let mut output = options
                .open(scratch.join(name))
                .map_err(|e| e.to_string())?;
            let limit = entry.size();
            let actual = io::copy(&mut entry.by_ref().take(limit + 1), &mut output)
                .map_err(|e| e.to_string())?;
            if actual != limit {
                return Err("백업 파일 크기가 맞지 않습니다. 다른 백업을 골라 주세요.".into());
            }
            output.sync_all().map_err(|e| e.to_string())?;
        }
        Ok(())
    }

    pub(super) fn backup_list(root: &Path, verify: &dyn Fn(&Path) -> bool) -> Value {
        let mut rows = Vec::new();
        if let Ok(entries) = fs::read_dir(root) {
            for entry in entries.flatten() {
                let path = entry.path();
                if !entry.file_type().map(|kind| kind.is_dir()).unwrap_or(false) {
                    continue;
                }
                let name = entry.file_name().to_string_lossy().to_string();
                let bytes = name.as_bytes();
                let date = bytes.len() >= 10
                    && bytes[4] == b'-'
                    && bytes[7] == b'-'
                    && bytes[..4].iter().all(u8::is_ascii_digit)
                    && bytes[5..7].iter().all(u8::is_ascii_digit)
                    && bytes[8..10].iter().all(u8::is_ascii_digit);
                let retry = name.get(10..).is_some_and(|suffix| {
                    suffix.is_empty()
                        || suffix.strip_prefix("-retry-").is_some_and(|hex| {
                            !hex.is_empty() && hex.bytes().all(|byte| byte.is_ascii_hexdigit())
                        })
                });
                if !date || !retry {
                    continue;
                }
                let marker = fs::symlink_metadata(path.join(".backup-complete.json")).is_ok();
                let complete = marker && verify(&path);
                rows.push(json!({
                    "day": name, "path": path, "wallet": path.join("wallet.dat").is_file(),
                    "complete": complete,
                    "verification": if complete { "complete" } else if marker { "invalid" } else { "legacy" },
                    "warning": if complete { "" } else if marker {
                        "백업 내용이 완료 기록과 다릅니다. 다른 백업을 골라 주세요."
                    } else { "이전 형식의 백업입니다. 완전한 백업인지 아직 검증되지 않았습니다." },
                }));
            }
        }
        rows.sort_by(|a, b| {
            b["day"]
                .as_str()
                .unwrap_or("")
                .cmp(a["day"].as_str().unwrap_or(""))
        });
        json!({ "root": root, "folders": rows })
    }
}
// END RESTORE FILE SAFETY

/// 되돌리려고 풀어 놓은 것을 지운다.
///
/// Active restore reports cleanup failure. Startup cleanup is best effort and
/// takes the same app/session lock so it cannot erase another active restore.
fn cleanup_opened() -> std::io::Result<()> {
    match std::fs::remove_dir_all(dir().join("restore-open")) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        result => result,
    }
}
pub fn 청소() {
    if let Ok(_operation) = RestoreOperation::begin() {
        let _ = cleanup_opened();
    }
}

/// One page to print and put in a drawer.
///
/// The information needed to rebuild this shop is scattered across screens that
/// only exist on the machine that just died. So it gets written down while the
/// machine is alive. Deliberately excludes anything secret — a page in a drawer
/// is not where a passphrase or a seed belongs.
#[tauri::command]
pub fn recovery_card() -> Value {
    let node = node_identity();
    let shop = crate::shop::shop_load();

    json!({
        "node": node,
        "shop_name": shop.get("name").cloned().unwrap_or(json!("")),
        "backup_folder": dir().join("backups").to_string_lossy(),
        "steps": [
            "새 컴퓨터에 레이븐 노드와 이 프로그램을 설치합니다.",
            "노드를 아직 켜지 마세요.",
            "이 프로그램을 열고 [이 컴퓨터] → [되돌리기]에서 백업 폴더를 고릅니다.",
            "회원 수와 메뉴 개수가 맞는지 눈으로 확인하고 되돌립니다.",
            "노드를 켭니다. 장부를 따라잡는 동안에도 주문은 받을 수 있습니다.",
            "폰 QR을 다시 뽑아 직원들에게 나눠 줍니다 — 옛 QR은 더 이상 안 됩니다.",
        ],
        "warnings": [
            "지갑 암호와 12단어는 이 종이에 적지 마세요. 따로, 다른 장소에 두세요.",
            "백업 폴더가 이 컴퓨터 안에만 있으면 컴퓨터와 함께 사라집니다. USB나 다른 컴퓨터에도 옮겨 두세요.",
        ],
    })
}

/// What to do the moment a phone goes missing.
///
/// Returns the plan rather than doing it, because rotating tokens logs out every
/// staff phone in the shop and that should happen when the owner presses it, not
/// when they open a help page.
#[tauri::command]
pub fn phone_lost_plan() -> Value {
    json!({
        "calm": "지갑은 안전합니다. 폰에는 열쇠가 들어 있지 않습니다.",
        "risk": "잃어버린 폰으로 가게 화면을 열 수 있습니다 — 주문 보기, 상태 바꾸기, 문 열기까지.",
        "steps": [
            { "do": "출입 문을 잠시 수동으로 돌립니다", "why": "가장 급한 것은 문입니다" },
            { "do": "[모든 폰 로그아웃]을 누릅니다", "why": "잃어버린 폰의 주소가 즉시 무효가 됩니다" },
            { "do": "새 QR을 뽑아 직원 폰에 다시 붙입니다", "why": "직원 폰도 같이 끊기므로 다시 연결해야 합니다" },
        ],
        "not_needed": [
            "지갑 암호를 바꿀 필요는 없습니다 — 폰은 암호를 모릅니다.",
            "자산을 옮길 필요도 없습니다.",
        ],
    })
}

/// Where the backups actually are, and how stale.
#[tauri::command]
pub fn backup_folders() -> Value {
    restore_files::backup_list(&dir().join("backups"), &crate::backup::complete_snapshot)
}

#[cfg(test)]
mod tests {
    /// 🔴 **되돌린 뒤에 푼 것을 치우는가.**
    ///
    /// 2026-08-31 실측: 8월 24일에 되돌린 뒤로 `restore-open/` 에
    /// **잠금 풀린 지갑(2.5MB)·간판 열쇠·회원 명단**이 일주일 넘게
    /// 남아 있었다. 백업을 잠그는 뜻이 통째로 없어진다 — 잠근 파일 옆에
    /// 안 잠긴 사본이 놓여 있으면 암호를 몰라도 다 가져간다.
    #[test]
    fn a_restore_cleans_up_what_it_unlocked() {
        let src = include_str!("recover.rs");
        let i = src
            .find("pub async fn restore_apply")
            .expect("되돌리는 함수가 있어야 한다");
        let body = &src[i..];
        let end = body.find("\n}\n").unwrap_or(body.len());
        assert!(
            body[..end].contains("cleanup_opened()"),
            "되돌린 뒤 푼 것을 안 치운다 — 잠금 풀린 지갑이 그대로 남는다"
        );
        // 켤 때도 쓸어야 한다. 이미 남은 사람 것도 지워야 하기 때문이다.
        assert!(
            include_str!("server.rs").contains("crate::recover::청소()"),
            "켤 때 안 쓸면, 이미 남아 있는 사람은 영영 남는다"
        );
    }

    /// 🔴 **잠긴 백업을 이름이 아니라 내용으로 알아본다.**
    ///
    /// 「가게 옮기기」가 통째로 안 됐다. 보내는 쪽은 잠긴 파일을 주는데
    /// 받는 쪽이 `이사.zip` 으로 저장해서, 확장자만 보던 코드가 안 풀고
    /// 「이 파일은 PLAY X Raven 백업이 아닙니다」로 끝냈다(2026-08-31 실측).
    ///
    /// ⚠️ 같이 잰다 — **안 잠긴 zip 은 그대로 통과해야 한다.** 막기만 하는
    ///    검사는 멀쩡한 백업까지 못 열게 만든다.
    #[test]
    fn a_locked_backup_is_known_by_its_first_bytes_not_its_name() {
        let 잠긴것 = b"PXRLOCK1\x00\x01\x02\x03";
        let 보통zip = b"PK\x03\x04\x00\x00\x00\x00";
        let 잠겼나 = |b: &[u8]| b.len() >= 8 && &b[..8] == b"PXRLOCK1";
        assert!(
            잠겼나(잠긴것),
            "잠긴 파일을 못 알아본다 — 가게 옮기기가 막힌다"
        );
        assert!(
            !잠겼나(보통zip),
            "보통 zip 을 잠겼다고 본다 — 멀쩡한 백업이 안 열린다"
        );
        assert!(!잠겼나(b"PXR"), "짧은 파일에서 넘치면 안 된다");

        // 받는 쪽이 파일 이름을 사실대로 적는지도 같이 본다.
        let mv = include_str!("moving.rs");
        assert!(
            mv.contains("이사.zip.pxlock"),
            "받은 짐을 안 잠긴 것처럼 이름 붙인다 — 그 거짓말을 푸는 쪽이 믿는다"
        );
    }

    use super::*;

    #[test]
    fn a_missing_folder_is_refused() {
        assert!(restore_survey("/nope/not/here".into(), None).is_err());
    }

    #[test]
    fn the_recovery_card_has_no_secrets() {
        let card = recovery_card().to_string();
        for bad in ["passphrase", "seed", "mnemonic", "private", "암호는"] {
            assert!(
                !card.contains(bad),
                "복구 카드에 비밀이 들어갔습니다: {bad}"
            );
        }
    }
}

/// Writes the recovery card as a page a browser can print, and opens it.
///
/// ## Why not `window.print()`
///
/// Because it does nothing here. The app runs in WKWebView, which does not
/// implement `print()` — the button was there, the click landed, and nothing
/// happened, with no error anywhere. It is the same class of failure as
/// `prompt`, `alert` and `confirm`, which are also silently absent.
///
/// So the card becomes a real file and the default browser opens it. That
/// browser has a working ⌘P, and the file stays on the desktop afterwards —
/// which is better than a print dialog anyway, because the point of this card
/// is that it survives the computer it was made on.
///
/// Nothing secret goes in it. No passphrase, no twelve words. A page that
/// lives in a drawer is not where those belong, and `recovery_card` is built
/// to leave them out.
#[tauri::command]
pub fn recovery_card_print(now_ymd: String) -> Result<Value, String> {
    let c = recovery_card();

    let esc = |s: &str| {
        s.replace('&', "&amp;")
            .replace('<', "&lt;")
            .replace('>', "&gt;")
    };
    let list = |key: &str, tag: &str| {
        c[key]
            .as_array()
            .map(|a| {
                a.iter()
                    .filter_map(Value::as_str)
                    .map(|s| format!("<{tag}>{}</{tag}>", esc(s)))
                    .collect::<Vec<_>>()
                    .join("")
            })
            .unwrap_or_default()
    };

    let name = c["node"]["name"].as_str().unwrap_or("");
    let id = c["node"]["id"].as_str().unwrap_or("");
    let shop = c["shop_name"].as_str().unwrap_or("");
    let folder = c["backup_folder"].as_str().unwrap_or("");

    // 인쇄용 한 장. 화면용 색이나 그림자는 넣지 않는다 — 잉크만 먹고
    // 종이에서는 회색 얼룩으로 나온다.
    let html = format!(
        r#"<!doctype html><html lang="ko"><head><meta charset="utf-8">
<title>복구 카드 — {shop_t}</title>
<style>
  @page {{ size: A4; margin: 18mm; }}
  body {{ font: 12pt/1.75 -apple-system, "Apple SD Gothic Neo", sans-serif; color: #000; }}
  h1 {{ font-size: 18pt; margin: 0 0 2mm; }}
  .when {{ color: #555; font-size: 10pt; margin-bottom: 7mm; }}
  table {{ border-collapse: collapse; width: 100%; margin-bottom: 7mm; }}
  th, td {{ border: 1px solid #999; padding: 3mm 4mm; text-align: left; vertical-align: top;
            font-size: 11pt; word-break: break-all; }}
  th {{ width: 26mm; background: #f2f2f2; font-weight: 600; }}
  h2 {{ font-size: 13pt; margin: 0 0 3mm; }}
  ol {{ margin: 0 0 7mm 6mm; padding: 0; }}
  li {{ margin-bottom: 2.5mm; }}
  .warn {{ border: 2px solid #000; padding: 4mm 5mm; }}
  .warn li {{ margin-bottom: 2mm; }}
  .tip {{ margin-top: 8mm; font-size: 10pt; color: #555; border-top: 1px solid #ccc;
          padding-top: 3mm; }}
  @media print {{ .tip {{ display: none; }} }}
</style></head><body>
<h1>복구 카드</h1>
<div class="when">{when} 만듦 · 이 종이를 서랍에 두세요</div>
<table>
  <tr><th>노드</th><td>{name_t}<br><small>{id_t}</small></td></tr>
  <tr><th>가게</th><td>{shop_t}</td></tr>
  <tr><th>백업 위치</th><td>{folder_t}</td></tr>
</table>
<h2>컴퓨터가 죽었을 때</h2>
<ol>{steps}</ol>
<div class="warn"><h2>꼭 지킬 것</h2><ul>{warns}</ul></div>
<div class="tip">인쇄하려면 ⌘P 를 누르세요. 이 파일은 지워도 프로그램에서 다시 만들 수 있습니다.</div>
</body></html>"#,
        when = esc(&now_ymd),
        name_t = esc(if name.is_empty() { "(이름 없음)" } else { name }),
        id_t = esc(id),
        shop_t = esc(if shop.is_empty() { "-" } else { shop }),
        folder_t = esc(folder),
        steps = list("steps", "li"),
        warns = list("warnings", "li"),
    );

    // 바탕화면에 둔다. 이 카드의 존재 이유는 컴퓨터가 죽어도 남는 것인데,
    // 앱 폴더 깊숙이 넣으면 찾지 못해 인쇄도 못 한다.
    let home = crate::paths::home().to_string_lossy().to_string();
    let desktop = std::path::PathBuf::from(&home).join("Desktop");
    let out = if desktop.is_dir() { desktop } else { dir() };
    let path = out.join("복구카드.html");

    std::fs::write(&path, html.as_bytes())
        .map_err(|e| format!("파일을 쓰지 못했습니다: {e}"))?;
    open::that(&path).map_err(|e| format!("브라우저를 열지 못했습니다: {e}"))?;

    Ok(json!({
        "path": path.to_string_lossy(),
        "say": "브라우저에서 열었습니다. ⌘P 를 누르면 인쇄됩니다.",
    }))
}
