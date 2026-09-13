//! Backups, and the one thing that must never happen.
//!
//! ## Two nodes on one wallet is not redundancy
//!
//! It is corruption. Both hand out the same receiving addresses, both think
//! they own the same coins, and the first time each signs a spend the network
//! sees a double-spend — one of which is the shop's own money, gone.
//!
//! Ravencoin already refuses to open a `wallet.dat` that another process holds,
//! but that protection only covers the same machine. Copying the file to a
//! second computer and starting it there defeats it entirely, and that is
//! exactly what someone does when they are trying to be careful about backups.
//!
//! So a backup here is written as a **cold copy**: a file plus a note saying it
//! must not be running anywhere else. What makes it safe is procedure, and
//! procedure only holds if the app states it every time rather than once in a
//! manual.
//!
//! ## What a backup actually saves
//!
//! - `wallet.dat` — the keys. Without it, the assets are unreachable even
//!   though they still exist on the chain.
//! - `passes.json` — the member ledger. The chain knows the member numbers; it
//!   does not know anyone's name, expiry, or remaining sessions.
//! - `orders.json` — where buyers asked for their assets to be delivered.
//!
//! The chain itself is not backed up, because thousands of other machines
//! already hold it. Re-downloading takes hours; losing `wallet.dat` takes
//! everything.

use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::io::{Read, Write};
use crate::backup_storage::{Workspace, publish_file};

// Manual, automatic and phone-triggered backups must not publish concurrently.
static BACKUP_GATE: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
const COMPLETE_FILE: &str = ".backup-complete.json";

fn backup_gate() -> Result<tokio::sync::MutexGuard<'static, ()>, String> {
    BACKUP_GATE.try_lock().map_err(|_| "다른 백업이 진행 중입니다. 끝난 뒤 다시 눌러 주세요.".into())
}


fn home() -> PathBuf {
    crate::paths::home()
}

fn raven_dir() -> PathBuf {
    crate::paths::raven_dir()
}

fn app_dir() -> PathBuf {
    crate::paths::app_dir()
}

/// Everything this app keeps that the chain does not.
///
/// ## Why this is one list and not three
///
/// Backup coverage was written by hand in two places and drifted: `sessions.json`
/// (people who signed up for a class) and `fills.json` (which orders were already
/// shipped) both existed and neither was copied. A backup that silently omits a
/// file is worse than none — the owner believes they are covered.
///
/// So the list lives here once, and both the survey and the copy read it.
///
/// ## What is deliberately left out
///
/// API keys. They sit in `google.key` and `models.json`, they are re-enterable
/// in thirty seconds, and a backup folder on a USB stick that also carries
/// somebody's paid API keys is a bill waiting to happen. Backups get copied to
/// places nobody thinks about; secrets should not ride along.
fn manifest() -> Vec<(&'static str, PathBuf, &'static str)> {
    vec![
        ("shop.json", app_dir().join("shop.json"),
         "가게 이름·메뉴·사진·영업 정보 — 이 파일이 곧 가게입니다"),
        // 🔴 가게 간판 열쇠. 이걸 잃으면 **체인에 적힌 공개키와 짝이 안 맞아**
        // 다시는 「지금 여기서 주문받습니다」를 못 올린다. 고치려면 자산을
        // 재발행해야 하고 RVN 이 또 탄다. 컴퓨터를 바꿀 때 같이 가야 한다.
        ("shopkey.json", app_dir().join("shopkey.json"),
         "가게 간판 열쇠 — 잃으면 손님이 가게를 못 찾습니다. 남에게 보여주지 마세요"),
        // 🔴 카운터에서 판 이용권. 잃으면 **손님이 산 표가 없어진다** —
        // 돈은 받았는데 못 들어오는 상황이고, 그건 그 자리에서 싸움이 된다.
        ("tickets.json", app_dir().join("tickets.json"),
         "카운터에서 판 이용권 — 잃으면 손님이 산 표가 사라집니다"),
        // 🔴 잡힌 예약. 잃으면 **손님은 오는데 가게는 모른다.** 그리고 그
        // 시간에 다른 예약을 받는다.
        ("bookings.json", app_dir().join("bookings.json"),
         "잡힌 예약 — 잃으면 손님은 오는데 가게가 모릅니다"),
        ("passes.json", app_dir().join("passes.json"),
         "회원 명단 — 체인은 회원번호만 알고 이름도 기간도 모릅니다"),
        ("sessions.json", app_dir().join("sessions.json"),
         "수업 신청자와 대기자 — 잃으면 그날 문 앞에서 알게 됩니다"),
        ("orders.json", app_dir().join("orders.json"),
         "손님이 적은 받을 주소"),
        ("fills.json", app_dir().join("fills.json"),
         "이미 보낸 주문 — 없으면 복구한 뒤 같은 자산을 한 번 더 보냅니다"),
        ("sweep.json", app_dir().join("sweep.json"),
         "자동 송금 설정"),
    ]
}

/// What exists to be backed up, and how big it is.
#[tauri::command]
pub fn backup_survey() -> Value {
    let mut rows: Vec<Value> = vec![{
        let p = raven_dir().join("wallet.dat");
        let meta = std::fs::metadata(&p).ok();
        json!({
            "name": "wallet.dat",
            "path": p.to_string_lossy(),
            "exists": meta.is_some(),
            "size": meta.as_ref().map(|m| m.len()).unwrap_or(0),
            "why": "지갑 열쇠 — 이게 없으면 자산에 손도 못 댑니다",
        })
    }];

    rows.extend(manifest().iter().map(|(name, path, why)| {
        let meta = std::fs::metadata(path).ok();
        json!({
            "name": name,
            "path": path.to_string_lossy(),
            "exists": meta.is_some(),
            "size": meta.as_ref().map(|m| m.len()).unwrap_or(0),
            "why": why,
        })
    }));

    json!({
        "items": rows,
        // 안 담는 것도 화면에 보여야 한다. 안 보이면 담긴 줄 안다.
        "excluded": [
            { "name": "AI 열쇠", "why": "복구 뒤 설정에서 다시 입력하세요." },
            { "name": "브라우저·PWA 지갑과 파일", "why": "해당 웹앱에서 별도로 내보내세요." },
            { "name": "IPFS 원본·블록체인", "why": "IPFS 원본은 별도로 보관하고, 블록체인은 노드에서 다시 동기화하세요." },
        ],
        "last": last_backup(),
        "automatic": std::fs::read(app_dir().join("backup-auto-status.json")).ok().and_then(|b| serde_json::from_slice::<Value>(&b).ok()),
    })
}

/// When a backup last succeeded, so the screen can say how stale it is.
fn stamp_path() -> PathBuf {
    app_dir().join("backup-last.json")
}

fn last_backup() -> Value {
    std::fs::read_to_string(stamp_path())
        .ok()
        .and_then(|t| serde_json::from_str::<Value>(&t).ok())
        .unwrap_or(Value::Null)
}

/// Copies the irreplaceable files to a folder the owner chose.
///
/// Copies rather than exports: `wallet.dat` is a live database, and a partial
/// read produces a file that looks fine and restores to nothing. The node is
/// asked to flush first via `backupwallet`, which is the only supported way to
/// get a consistent copy while it is running.
#[tauri::command]
pub async fn backup_now(dest: String) -> Result<Value, String> {
    let dir = PathBuf::from(&dest);
    if !dir.is_dir() {
        return Err("폴더가 아닙니다. 저장할 폴더를 고르세요.".into());
    }

    let _gate = backup_gate()?;
    let prepared = prepare_backup(true).await?;
    // A folder export is a complete new generation, never a merge over an old one.
    let dest = unique_generation(&dir, "RavenVault");
    store_folder(&prepared, &dest)
}

/// Is another Ravencoin node already using this wallet?
///
/// Checked before anything that assumes exclusive use. The node's own lock
/// covers this machine; what it cannot see is the same file opened on a laptop
/// in the back office, which is why the answer here is a warning rather than a
/// guarantee.
#[tauri::command]
pub async fn exclusive_check() -> Value {
    let lock = raven_dir().join(".lock");
    let running = crate::raven::call_rpc("getblockchaininfo", json!([]))
        .await
        .is_ok();

    json!({
        "lock_present": lock.exists(),
        "node_responding": running,
        // 같은 기계 밖은 확인할 방법이 없다. 그래서 단언하지 않는다.
        "note": "다른 컴퓨터에서 같은 지갑을 켰는지는 이 앱이 알 수 없습니다. \
                 백업본은 원래 컴퓨터가 꺼진 것을 확인한 뒤에만 켜세요.",
    })
}

/// Pre-generates receiving addresses for a counter machine that holds no keys.
///
/// This is the arrangement that actually survives a break-in: the wallet stays
/// on a machine that is usually off, and the always-on counter machine holds
/// only a list of addresses. It can take orders and watch for payments; it
/// cannot spend, because it has nothing to sign with.
///
/// Fulfilment still needs the wallet, so assets go out when the owner brings
/// that machine up — which is a real limitation and the reason this is offered
/// rather than made the default.
#[tauri::command]
pub async fn address_pool(count: u32, label: String) -> Result<Value, String> {
    if !(1..=500).contains(&count) {
        return Err("1개에서 500개 사이로 만들어 주세요.".into());
    }
    let mut out = Vec::with_capacity(count as usize);
    for _ in 0..count {
        match crate::raven::new_address(label.clone()).await {
            Ok(a) => out.push(a),
            Err(e) => return Err(format!("{}개까지 만들고 멈췄습니다: {e}", out.len())),
        }
    }
    Ok(json!({ "addresses": out, "count": out.len() }))
}


/// The wallet's recovery words.
///
/// Ravencoin does have them — `dumpwallet` writes `# mnemonic:` into its output
/// — but only through that file, which is the problem: the same file contains
/// every private key in the wallet, in plain text, on disk.
///
/// So this writes to a path only this user can read, extracts the one line it
/// needs, then overwrites the file with random bytes before deleting it.
/// Overwriting is not a guarantee on an SSD — wear levelling can leave the old
/// blocks intact — and the UI says so rather than implying the file is gone.
///
/// Returned as words to display once. No clipboard: anything on this machine
/// can read the clipboard, and a recovery phrase that has been copied is a
/// recovery phrase that has been shared.
#[tauri::command]
pub async fn reveal_seed(passphrase: String) -> Result<Value, String> {
    if passphrase.trim().is_empty() {
        return Err("지갑 암호가 필요합니다.".into());
    }
    // 🔴 암호를 **아직 안 건** 지갑에서는 `walletpassphrase` 가 노드의 영문
    //    오류로 튕긴다. 하필 처음 켠 사람이 제일 먼저 눌러 보는 단추가
    //    이것이라, 그 사람은 알아들을 수 없는 영어를 만나고 앱이 고장 난
    //    줄 안다. 무엇을 하라는 말로 바꾼다.
    if let Ok(st) = crate::raven::wallet_lock_state().await {
        if !st["encrypted"].as_bool().unwrap_or(true) {
            return Err(
                "이 지갑에는 아직 암호가 없습니다. 「지갑」 화면에서 암호를 먼저 걸어 주세요 — \
                 복구 단어는 암호로 잠긴 지갑에서만 꺼낼 수 있습니다."
                    .into(),
            );
        }
    }

    // 30초면 충분하고, 그 이상 열어 둘 이유가 없다.
    crate::raven::call_rpc("walletpassphrase", json!([passphrase, 30]))
        .await
        .map_err(|e| {
            if e.contains("incorrect") {
                "암호가 맞지 않습니다.".to_string()
            } else {
                e
            }
        })?;

    let tmp = app_dir().join(".seed.tmp");
    let _ = std::fs::create_dir_all(app_dir());
    let dump = crate::raven::call_rpc(
        "dumpwallet",
        json!([tmp.to_string_lossy().to_string()]),
    )
    .await;
    let _ = crate::raven::call_rpc("walletlock", json!([])).await;
    dump?;

    let text = std::fs::read_to_string(&tmp).unwrap_or_default();
    let mnemonic = text
        .lines()
        .find(|l| l.starts_with("# mnemonic:"))
        .map(|l| l.trim_start_matches("# mnemonic:").trim().to_string());
    let has_passphrase = text
        .lines()
        .any(|l| l.starts_with("# mnemonic passphrase:") && l.split(':').nth(1).map(|v| !v.trim().is_empty()).unwrap_or(false));

    shred(&tmp);

    match mnemonic.filter(|m| !m.is_empty()) {
        Some(m) => {
            let words: Vec<&str> = m.split_whitespace().collect();
            Ok(json!({
                "words": words,
                "count": words.len(),
                // 시드 뒤에 추가 암호가 걸려 있으면 단어만으로는 복구가 안 된다.
                // 이걸 모르고 단어만 적어 두면 나중에 아무것도 못 연다.
                "has_extra_passphrase": has_passphrase,
            }))
        }
        None => Err(
            "이 지갑에는 복구 단어가 없습니다. 예전 방식으로 만들어진 지갑이면 \
             wallet.dat 파일 자체를 백업해야 합니다."
                .into(),
        ),
    }
}

/// Overwrites a file before removing it.
fn shred(path: &std::path::Path) {
    if let Ok(meta) = std::fs::metadata(path) {
        let len = meta.len() as usize;
        // 같은 길이의 난수로 덮는다. SSD에서는 원본 블록이 남을 수 있어
        // 완전한 삭제는 아니고, 화면에서도 그렇게 말한다.
        let junk: Vec<u8> = (0..len).map(|i| (i * 31 + 7) as u8).collect();
        let _ = std::fs::write(path, junk);
    }
    let _ = std::fs::remove_file(path);
}

/// A backup nobody has to remember.
///
/// ## Why a button is not a backup system
///
/// "백업하기" gets pressed on the day it is built and never again. The shops
/// that lose a member list are not careless — they are busy, and the button is
/// on a screen they have no reason to open. So this runs on its own: once a
/// day, on the first cycle after the date changes.
///
/// ## What this does and does not protect against
///
/// It writes into the app's own folder, which means it survives the failures
/// that actually happen most — a file corrupted, a menu wiped by accident, an
/// upgrade gone wrong. It does **not** survive the disk dying, and the screen
/// says so rather than letting a local copy feel like safety. Choosing an
/// external folder is still the owner's job; this is the floor, not the ceiling.
///
/// Seven generations are kept. One generation is not a backup either: yesterday
/// overwritten by today means the corruption is now in the only copy.
/// USB 백업도 잠글 것인가. **기본은 잠근다.**
///
/// 끄는 것은 사장이 정할 일이다 — 컴퓨터가 죽은 날 열쇠 종이도 못 찾는
/// 상황을 두려워하는 사람이 있고, 그건 실제로 일어난다. 다만 끄면 그 USB 를
/// 주운 사람이 가게 돈을 가져간다는 것도 사실이라, 화면이 둘 다 말한다.
/// 디스크에 새기는 이름은 **글자 그대로 세계 어디서나 읽혀야 한다.**
///
/// 🔴 여태 폴더는 `PLAYXRaven-백업`, 잠근 파일은 `.zip.잠김`, 설명서는
/// `읽어보세요.txt` 였다. 한국어를 모르는 사람에게는 읽을 수 없는 이름이고,
/// `.잠김` 은 **확장자 자리에 한글**이라 파일을 뭘로 열지도 알 수 없다.
/// zip 안의 한글 이름은 실제로 `???????.txt` 로 깨져 있었다(실측).
///
/// 화면 글자는 네 나라 말로 옮기지만, **디스크에 새기는 이름은 안 옮긴다** —
/// 옮기면 컴퓨터 언어를 바꿨을 때 옛 백업을 못 찾는다. ASCII 하나로 고정한다.
const BACKUP_DIR: &str = "PLAYXRaven-Backup";
/// 잠근 파일. `.pxlock` 이면 무엇으로 여는 것인지 이름이 말해 준다.
const LOCKED_EXT: &str = "zip.pxlock";
/// zip 안 설명서. 어느 나라에서 풀어도 안 깨진다.
const README_NAME: &str = "READ-ME.txt";

fn usb_should_lock() -> bool {
    std::fs::read_to_string(crate::paths::app_file("backup-usb.json"))
        .ok()
        .and_then(|t| serde_json::from_str::<Value>(&t).ok())
        .and_then(|v| v.get("lock").and_then(Value::as_bool))
        .unwrap_or(true)
}

/// 사장이 보고 바꾸는 자리.
#[tauri::command]
pub fn usb_lock_read() -> Value {
    json!({ "lock": usb_should_lock() })
}

#[tauri::command]
pub fn usb_lock_set(lock: bool) -> Result<Value, String> {
    let p = crate::paths::app_file("backup-usb.json");
    if let Some(d) = p.parent() {
        let _ = std::fs::create_dir_all(d);
    }
    std::fs::write(&p, serde_json::to_vec(&json!({ "lock": lock })).unwrap_or_default())
        .map_err(|e| format!("저장하지 못했습니다: {e}"))?;
    Ok(json!({ "lock": lock }))
}

#[tauri::command]
pub async fn backup_auto(now_unix: i64) -> Value {
    let _gate = match backup_gate() {
        Ok(guard) => guard,
        Err(e) => return json!({"skipped": e}),
    };
    let external = external_drives()["drives"].as_array().cloned().unwrap_or_default();
    let clouds = cloud_folders()["folders"].as_array().cloned().unwrap_or_default();
    remember_auto_result(auto_to(now_unix, external, clouds).await)
}

fn remember_auto_result(mut result: Value) -> Value {
    // Return the current failure even when the status file itself cannot be saved.
    if std::fs::write(app_dir().join("backup-auto-status.json"), result.to_string()).is_err() {
        let warning = result["warning"].as_str().unwrap_or("");
        result["warning"] = json!(format!("{warning} 백업 상태를 저장하지 못했습니다. 설정 폴더의 여유 공간과 권한을 확인하세요.").trim());
    }
    result
}

async fn auto_to(now_unix: i64, external: Vec<Value>, clouds: Vec<Value>) -> Value {
    let stamp = day_name(now_unix - now_unix.rem_euclid(86_400));
    let root = app_dir().join("backups");
    let completed = complete_day(&root, &stamp);
    let already_complete = completed.is_some();
    let dest = completed.unwrap_or_else(|| {
        let first = root.join(&stamp);
        if first.exists() { unique_generation(&root, &format!("{stamp}-retry")) } else { first }
    });
    let external: Vec<_> = external.into_iter().filter(|d| d["writable"] == true).collect();
    if already_complete
        && external.iter().all(|d| d["path"].as_str().is_some_and(|path| daily_copy_complete(&PathBuf::from(path).join(BACKUP_DIR), usb_should_lock(), &stamp)))
        && clouds.iter().all(|d| d["path"].as_str().is_some_and(|path| daily_copy_complete(&PathBuf::from(path).join(BACKUP_DIR), true, &stamp)))
    {
        return json!({"skipped": "오늘의 검증된 백업이 있습니다", "dest": dest.to_string_lossy(), "local_complete": true});
    }
    // Finish the entire snapshot before touching any existing generation.
    let prepared = match prepare_backup(true).await {
        Ok(v) => v,
        Err(e) => return json!({"error": e, "local_complete": already_complete}),
    };
    if !already_complete {
        if let Err(e) = std::fs::create_dir_all(&root) {
            return json!({"error": format!("백업 폴더를 만들지 못했습니다. 여유 공간과 권한을 확인하세요: {e}")});
        }
        if let Err(e) = store_folder(&prepared, &dest) {
            return json!({"error": e, "local_complete": false});
        }
        prune_complete_generations(&root);
    }
    let mut outside = Vec::new();
    for drive in external {
        let Some(path) = drive["path"].as_str() else { continue };
        let folder = PathBuf::from(path).join(BACKUP_DIR);
        let result = std::fs::create_dir_all(&folder).map_err(|e| e.to_string())
            .and_then(|_| publish_daily(&prepared, &folder, usb_should_lock(), &stamp));
        outside.push(match result {
            Ok(v) => json!({"ok": true, "drive": drive["name"], "path": v["path"], "locked": v["locked"]}),
            Err(e) => json!({"ok": false, "drive": drive["name"], "why": e}),
        });
    }
    let mut cloud = Vec::new();
    for place in clouds {
        let Some(path) = place["path"].as_str() else { continue };
        let folder = PathBuf::from(path).join(BACKUP_DIR);
        let result = std::fs::create_dir_all(&folder).map_err(|e| e.to_string())
            .and_then(|_| publish_daily(&prepared, &folder, true, &stamp));
        cloud.push(match result {
            Ok(v) => json!({"ok": true, "where": place["name"], "path": v["path"], "wallet": true, "locked": true}),
            Err(e) => json!({"ok": false, "where": place["name"], "wallet": false, "why": e}),
        });
    }
    let usb_ok = outside.iter().any(|v| v["ok"] == true);
    let cloud_ok = cloud.iter().any(|v| v["ok"] == true);
    let failed = outside.iter().chain(cloud.iter()).any(|v| v["ok"] != true);
    json!({
        "made": if already_complete { Value::Null } else { json!(stamp) },
        "dest": dest.to_string_lossy(), "local_complete": true,
        "outside": outside, "cloud": cloud,
        "warning": if failed { "일부 외부 백업을 저장하지 못했습니다. 연결과 여유 공간을 확인하고 다시 백업하세요." } else { "" },
        "note": match (usb_ok, cloud_ok) {
            (false, false) => "이 컴퓨터의 백업만 확인했습니다. USB 등 별도 기기에도 백업하세요.",
            (true, false) => "이 컴퓨터와 외장 디스크에 백업을 저장했습니다.",
            (false, true) => "이 컴퓨터와 클라우드 동기화 폴더에 저장했습니다. 클라우드 업로드 완료는 동기화 앱에서 확인하세요.",
            (true, true) => "이 컴퓨터·외장 디스크·클라우드 동기화 폴더에 저장했습니다. 클라우드 업로드 완료는 동기화 앱에서 확인하세요.",
        },
    })
}

/// `2026-08-18` from a unix day, without pulling in a date library.
///
/// Civil-from-days — the standard algorithm, shifting the year to start in March
/// so leap days land at the end and the month lengths become a simple formula.
fn day_name(day_unix: i64) -> String {
    let z = day_unix / 86_400 + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    format!("{y:04}-{m:02}-{d:02}")
}

#[cfg(test)]
mod seal_tests {
    /// 윈도우·리눅스 백업이 맥 경로만 보면, 원드라이브가 켜져 있는데
    /// "클라우드가 없습니다"가 되고 USB 도 못 찾는다.
    #[test]
    fn 윈도우_리눅스_서류함과_클라우드를_본다() {
        let src = include_str!("backup.rs");
        assert!(
            src.contains("fn default_backup_parent"),
            "기본 폴더 함수가 없다"
        );
        assert!(
            src.contains("OneDriveConsumer"),
            "윈도우 원드라이브 환경변수를 안 본다"
        );
        assert!(
            src.contains("user-dirs.dirs"),
            "리눅스 서류함 위치를 안 본다"
        );
        assert!(src.contains("/run/media"), "리눅스 USB 자리를 안 본다");
        assert!(src.contains("SystemDrive"), "윈도우 드라이브 문자를 안 본다");
        assert!(
            src.contains("iCloudDrive"),
            "윈도우 아이클라우드 자리를 안 본다"
        );
    }
}

#[cfg(test)]
mod tests {
    use super::day_name;

    #[test]
    fn dates_are_right() {
        assert_eq!(day_name(0), "1970-01-01");
        // 윤년 다음 날. 3월로 시작하는 셈법이 여기서 틀리면 하루씩 밀린다.
        assert_eq!(day_name(1_709_164_800), "2024-02-29");
        assert_eq!(day_name(1_755_475_200), "2025-08-18");
    }
}

/// One file that holds the whole shop.
///
/// ## Why everything goes in, wallet included
///
/// The obvious split is "keys here, data there" — it feels safer. It is not.
/// Reviving a shop on a new machine needs *both*, and a person carrying two
/// files to a drawer carries one of them. The failure we are designing against
/// is not a clever thief; it is a dead computer on a Tuesday and an owner who
/// grabbed the wrong thing.
///
/// So: one file, one name, one thing to copy to a USB stick.
///
/// ## What that costs, said out loud
///
/// If the wallet has no passphrase, this file *is* the money — anyone who picks
/// it up can spend. `wallet.dat` encrypts private keys when a passphrase is set
/// and does not otherwise. So the result reports which of the two you made, and
/// the screen has to say it rather than filing it under details.
/// 만든 zip 을 **우리 자물쇠로 한 번 더 잠그고 평문을 지운다.**
///
/// 🔴 자동 백업(클라우드·USB)은 이미 이렇게 했는데, **사장이 직접 누르는
/// 「백업 하기」만 이 길을 안 탔다.** 그래서 `wallet.dat` 과 `shopkey.json`
/// 이 든 zip 이 **암호 없이** 바탕화면과 iCloud 에 놓였다(실측으로 열림).
///
/// `shopkey.json` 은 가게 간판 열쇠다. 이걸 가진 사람은 「이 가게는 지금
/// 여기서 주문받습니다」를 **사장 이름으로 서명**할 수 있고, 손님 돈이 그리로
/// 간다. **소유권 토큰을 훔칠 필요조차 없다.** zip 은 옮기라고 만든 물건이라
/// "이미 이 컴퓨터에 있으니 괜찮다"는 논리가 성립하지 않는다.
struct PreparedBackup {
    workspace: Workspace,
    inside: Vec<Value>,
    encrypted: Option<bool>,
}

fn file_digest(path: &Path) -> Result<(u64, String), String> {
    use sha2::{Digest, Sha256};
    let mut file = std::fs::File::open(path).map_err(|e| format!("파일을 읽지 못했습니다. 권한을 확인하세요: {e}"))?;
    if !file.metadata().map_err(|e| e.to_string())?.is_file() {
        return Err("백업 항목이 파일이 아닙니다. 원본 파일을 확인하세요.".into());
    }
    let mut hasher = Sha256::new();
    let mut len = 0;
    let mut buffer = [0; 65536];
    loop {
        let count = file.read(&mut buffer).map_err(|e| e.to_string())?;
        if count == 0 { break; }
        hasher.update(&buffer[..count]);
        len += count as u64;
    }
    Ok((len, hex::encode(hasher.finalize())))
}

async fn prepare_backup(include_wallet: bool) -> Result<PreparedBackup, String> {
    let workspace = Workspace::new(&app_dir())?;
    let mut inside = Vec::new();
    if include_wallet {
        let wallet = workspace.path().join("wallet.dat");
        crate::raven::call_rpc("backupwallet", json!([wallet.to_string_lossy()])).await
            .map_err(|_| "지갑을 백업하지 못했습니다. 노드가 켜져 있고 연결되는지 확인한 뒤 다시 백업하세요. 기존 백업은 교체하지 않았습니다.".to_string())?;
        let (size, sha256) = file_digest(&wallet)?;
        if size == 0 { return Err("노드가 빈 지갑 사본을 만들었습니다. 노드 상태를 확인한 뒤 다시 백업하세요.".into()); }
        inside.push(json!({"name": "wallet.dat", "what": "지갑 열쇠", "size": size, "sha256": sha256}));
    }
    for (name, source, what) in manifest() {
        match std::fs::metadata(&source) {
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
            Err(e) => return Err(format!("{name}을 확인하지 못했습니다. 파일 권한을 확인하세요: {e}")),
            Ok(meta) if !meta.is_file() => return Err(format!("{name}이 파일이 아닙니다. 원본을 확인하세요.")),
            Ok(_) => (),
        }
        let target = workspace.path().join(name);
        std::fs::copy(&source, &target).map_err(|e| format!("{name}을 담지 못했습니다. 파일 권한과 여유 공간을 확인하세요: {e}"))?;
        // A partially written ledger must not silently become the newest backup.
        let file = std::fs::File::open(&target).map_err(|e| e.to_string())?;
        serde_json::from_reader::<_, Value>(file)
            .map_err(|_| format!("{name}의 내용을 읽지 못했습니다. 원본을 확인한 뒤 다시 백업하세요."))?;
        let (size, sha256) = file_digest(&target)?;
        inside.push(json!({"name": name, "what": what, "size": size, "sha256": sha256}));
    }
    let encrypted = if include_wallet {
        crate::raven::call_rpc("getwalletinfo", json!([])).await.ok().map(|v| v.get("unlocked_until").is_some())
    } else { None };
    Ok(PreparedBackup { workspace, inside, encrypted })
}

fn backup_readme(prepared: &PreparedBackup) -> String {
    let names = prepared.inside.iter().filter_map(|v| v["name"].as_str()).collect::<Vec<_>>().join("\n");
    format!("RavenVault Desktop / PLAY X Raven backup\n\nIncluded files / 포함한 파일:\n{names}\n\nNot included / 포함하지 않음: blockchain, IPFS media, browser/PWA wallet and files, AI API keys.\n블록체인, IPFS 원본, 브라우저/PWA 지갑과 파일, AI API 키는 별도로 보관하세요.\n\nRestore / 되돌리기: 앱의 [이 컴퓨터] → [되돌리기]에서 이 백업을 고르세요.\n다른 컴퓨터에서는 백업 암호 또는 백업 열쇠가 필요합니다. 지갑 복구 단어와는 다릅니다.\n지갑을 복원하기 전에 Ravencoin 노드를 완전히 종료하세요. 같은 지갑을 여러 컴퓨터에서 동시에 사용하지 마세요.\n")
}

fn write_archive(prepared: &PreparedBackup, out: &Path) -> Result<(), String> {
    let file = std::fs::File::create(out).map_err(|e| e.to_string())?;
    let mut zip = zip::ZipWriter::new(file);
    let opts: zip::write::FileOptions<()> = zip::write::FileOptions::default().compression_method(zip::CompressionMethod::Deflated);
    for entry in &prepared.inside {
        let name = entry["name"].as_str().ok_or("백업 파일 이름을 확인하지 못했습니다")?;
        let mut file = std::fs::File::open(prepared.workspace.path().join(name)).map_err(|e| format!("{name}을 읽지 못했습니다: {e}"))?;
        zip.start_file(name, opts).map_err(|e| format!("{name}을 담지 못했습니다: {e}"))?;
        let count = std::io::copy(&mut file, &mut zip).map_err(|e| format!("{name}을 끝까지 담지 못했습니다: {e}"))?;
        if Some(count) != entry["size"].as_u64() { return Err(format!("{name}의 크기가 바뀌었습니다. 다시 백업하세요.")); }
    }
    zip.start_file(README_NAME, opts).map_err(|e| e.to_string())?;
    zip.write_all(backup_readme(prepared).as_bytes()).map_err(|e| e.to_string())?;
    zip.finish().map_err(|e| format!("백업 파일을 마무리하지 못했습니다: {e}"))?.sync_all().map_err(|e| e.to_string())?;
    verify_archive(prepared, out)
}

fn verify_archive(prepared: &PreparedBackup, path: &Path) -> Result<(), String> {
    use sha2::{Digest, Sha256};
    let mut archive = zip::ZipArchive::new(std::fs::File::open(path).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    if archive.len() != prepared.inside.len() + 1 { return Err("백업 파일 수가 맞지 않습니다. 다시 백업하세요.".into()); }
    for entry in &prepared.inside {
        let name = entry["name"].as_str().ok_or("백업 파일 이름이 없습니다")?;
        let mut file = archive.by_name(name).map_err(|_| format!("백업에서 {name}을 찾지 못했습니다. 다시 백업하세요."))?;
        let mut hash = Sha256::new();
        let mut count = 0u64;
        let mut buffer = [0; 65536];
        loop {
            let n = file.read(&mut buffer).map_err(|e| format!("백업 파일이 손상되었습니다. 다시 백업하세요: {e}"))?;
            if n == 0 { break; }
            hash.update(&buffer[..n]); count += n as u64;
        }
        if Some(count) != entry["size"].as_u64() || entry["sha256"] != hex::encode(hash.finalize()) {
            return Err(format!("백업의 {name}이 원본 사본과 다릅니다. 다시 백업하세요."));
        }
    }
    let mut readme = String::new();
    archive.by_name(README_NAME).map_err(|e| e.to_string())?.read_to_string(&mut readme).map_err(|e| e.to_string())?;
    if readme != backup_readme(prepared) { return Err("백업 안내문을 확인하지 못했습니다. 다시 백업하세요.".into()); }
    Ok(())
}

fn record_backup(dest: &Path, count: usize) -> Option<String> {
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    std::fs::write(stamp_path(), json!({"at": now, "dest": dest.to_string_lossy(), "count": count}).to_string()).err()
        .map(|_| "백업 파일은 저장했지만 완료 시각을 기록하지 못했습니다. 설정 폴더 권한을 확인하세요.".into())
}

fn publish_archive(prepared: &PreparedBackup, picked: &Path, label: &str, locked: bool) -> Result<Value, String> {
    if !picked.is_dir() { return Err("폴더가 아닙니다. 저장할 폴더를 고르세요.".into()); }
    // Retain the existing backup folder and filename conventions.
    let out_dir = picked.join("PLAY X Raven 백업");
    let safe_label: String = label.trim().chars().take(48).map(|c| if c.is_alphanumeric() || c == '-' { c } else { '_' }).collect();
    let stem = if safe_label.is_empty() { "PLAYXRaven".to_owned() } else { format!("PLAYXRaven-{safe_label}") };
    let output_workspace = Workspace::new(prepared.workspace.path())?;
    let plain = output_workspace.path().join("archive.zip");
    write_archive(prepared, &plain)?;
    let staged = if locked {
        let key = crate::lockbox::key_get_or_make()?;
        let sealed = output_workspace.path().join("archive.zip.pxlock");
        crate::lockbox::lock_file(&plain, &sealed, &key)?;
        // Read the encrypted output back before replacing any existing backup.
        let check = output_workspace.path().join("verify.zip");
        crate::lockbox::unlock_file(&sealed, &check, &key)?;
        verify_archive(prepared, &check)?;
        std::fs::remove_file(&check).map_err(|e| e.to_string())?;
        std::fs::remove_file(&plain).map_err(|e| e.to_string())?;
        sealed
    } else { plain };
    let extension = if locked { LOCKED_EXT } else { "zip" };
    let out = out_dir.join(format!("{stem}.{extension}"));
    std::fs::create_dir_all(&out_dir).map_err(|e| format!("백업 폴더를 만들지 못했습니다: {e}"))?;
    publish_file(&staged, &out)?;
    let size = std::fs::metadata(&out).map_err(|e| e.to_string())?.len();
    let wallet_included = prepared.inside.iter().any(|v| v["name"] == "wallet.dat");
    let stamp_warning = if wallet_included { record_backup(&out, prepared.inside.len()) } else { None };
    Ok(json!({
        "path": out.to_string_lossy(), "folder": out_dir.to_string_lossy(), "pretty": pretty_place(&out_dir),
        "name": out.file_name().unwrap_or_default().to_string_lossy(), "size": size,
        "size_text": format!("{:.1} MB", size as f64 / 1_048_576.0),
        "inside": prepared.inside, "wallet_included": wallet_included, "wallet_encrypted": prepared.encrypted,
        "locked": locked, "verified": true,
        "warning": stamp_warning.unwrap_or_else(|| if !locked { "암호화하지 않은 백업입니다. 다른 사람이 열 수 없도록 보관하세요.".into() } else { String::new() }),
    }))
}

// Keep yesterday's external copy: a six-hour retry must not rotate a
// destination that already has this day's verified copy.
fn daily_archive_paths(picked: &Path, locked: bool) -> (PathBuf, PathBuf) {
    let extension = if locked { LOCKED_EXT } else { "zip" };
    let latest = picked.join("PLAY X Raven 백업").join(format!("PLAYXRaven.{extension}"));
    let receipt = latest.with_file_name(format!(".PLAYXRaven.{extension}.complete.json"));
    (latest, receipt)
}

fn daily_copy_complete(picked: &Path, locked: bool, day: &str) -> bool {
    let (latest, receipt) = daily_archive_paths(picked, locked);
    let prior = std::fs::read(&receipt).ok().and_then(|b| serde_json::from_slice::<Value>(&b).ok());
    prior.is_some_and(|v| v["day"] == day && file_digest(&latest).is_ok_and(|(size, hash)| v["size"] == size && v["sha256"] == hash))
}

fn publish_daily(prepared: &PreparedBackup, picked: &Path, locked: bool, day: &str) -> Result<Value, String> {
    let (latest, receipt) = daily_archive_paths(picked, locked);
    if daily_copy_complete(picked, locked, day) {
        return Ok(json!({"path": latest.to_string_lossy(), "locked": locked, "skipped": true}));
    }
    let result = publish_archive(prepared, picked, "", locked)?;
    let (size, sha256) = file_digest(&latest)?;
    let stage = Workspace::new(prepared.workspace.path())?;
    let record = stage.path().join("receipt.json");
    std::fs::write(&record, json!({"day": day, "size": size, "sha256": sha256}).to_string()).map_err(|e| e.to_string())?;
    publish_file(&record, &receipt)?;
    Ok(result)
}

/// The public command never returns success for an omitted requested wallet.
#[tauri::command]
pub async fn backup_zip(dest_folder: String, label: String, include_wallet: bool) -> Result<Value, String> {
    let _gate = backup_gate()?;
    let picked = if dest_folder.trim().is_empty() { default_backup_parent() } else { PathBuf::from(dest_folder) };
    if !picked.is_dir() { return Err("폴더가 아닙니다. 저장할 폴더를 고르세요.".into()); }
    let prepared = prepare_backup(include_wallet).await?;
    publish_archive(&prepared, &picked, &label, true)
}

fn unique_generation(parent: &Path, prefix: &str) -> PathBuf {
    parent.join(format!("{prefix}-{:016x}", rand::random::<u64>()))
}

fn complete_day(root: &Path, stamp: &str) -> Option<PathBuf> {
    let entries = std::fs::read_dir(root).ok()?;
    entries.flatten().map(|e| e.path()).find(|path| {
        let name = path.file_name().unwrap_or_default().to_string_lossy();
        (name == stamp || name.starts_with(&format!("{stamp}-retry-"))) && complete_snapshot(path)
    })
}

fn store_folder(prepared: &PreparedBackup, dir: &Path) -> Result<Value, String> {
    // Publish an entire directory only after every file passes readback checks.
    // Earlier complete or partial directories are never modified by a retry.
    if dir.try_exists().map_err(|e| e.to_string())? {
        return Err("이 백업 폴더에는 이미 자료가 있습니다. 새 폴더를 골라 다시 백업하세요.".into());
    }
    let parent = dir.parent().ok_or("백업 폴더를 다시 고르세요.")?;
    let staged = Workspace::new(parent)?;
    let mut done = Vec::new();
    for entry in &prepared.inside {
        let name = entry["name"].as_str().ok_or("백업 파일 이름이 없습니다")?;
        let target = staged.path().join(name);
        std::fs::copy(prepared.workspace.path().join(name), &target).map_err(|e| format!("{name}을 저장하지 못했습니다. 여유 공간을 확인하세요: {e}"))?;
        std::fs::OpenOptions::new().read(true).write(true).open(&target).and_then(|f| f.sync_all()).map_err(|e| e.to_string())?;
        done.push(json!({"name": name, "path": dir.join(name).to_string_lossy()}));
    }
    let readme = staged.path().join(README_NAME);
    std::fs::write(&readme, backup_readme(prepared)).map_err(|e| e.to_string())?;
    let marker = staged.path().join(COMPLETE_FILE);
    std::fs::write(&marker, json!({"version": 1, "files": prepared.inside}).to_string()).map_err(|e| e.to_string())?;
    for path in [&readme, &marker] { std::fs::OpenOptions::new().read(true).write(true).open(path).and_then(|f| f.sync_all()).map_err(|e| e.to_string())?; }
    if !complete_snapshot(staged.path()) { return Err("백업을 검증하지 못했습니다. 여유 공간과 파일 권한을 확인한 뒤 다시 백업하세요.".into()); }
    #[cfg(unix)]
    std::fs::File::open(staged.path()).and_then(|f| f.sync_all()).map_err(|e| e.to_string())?;
    std::fs::rename(staged.path(), dir).map_err(|e| format!("새 백업 폴더를 저장하지 못했습니다. 기존 백업은 보존했습니다. 다른 폴더를 골라 주세요: {e}"))?;
    #[cfg(unix)]
    std::fs::File::open(parent).and_then(|f| f.sync_all()).map_err(|e| e.to_string())?;
    if !complete_snapshot(dir) { return Err("저장한 백업을 확인하지 못했습니다. 기존 백업은 지우지 말고 다시 백업하세요.".into()); }
    let warning = record_backup(dir, done.len());
    Ok(json!({"done": done, "failed": [], "dest": dir.to_string_lossy(), "complete": true, "last": last_backup(), "warning": warning}))
}

pub(crate) fn complete_snapshot(dir: &Path) -> bool {
    let Some(marker) = std::fs::read(dir.join(COMPLETE_FILE)).ok().and_then(|b| serde_json::from_slice::<Value>(&b).ok()) else { return false };
    let Some(files) = marker["files"].as_array() else { return false };
    if marker["version"] != 1 || !files.iter().any(|v| v["name"] == "wallet.dat" && v["size"].as_u64().unwrap_or(0) > 0) { return false; }
    let allowed: Vec<_> = manifest().into_iter().map(|v| v.0).chain(["wallet.dat"]).collect();
    files.iter().all(|v| {
        let Some(name) = v["name"].as_str().filter(|n| allowed.contains(n)) else { return false };
        file_digest(&dir.join(name)).map(|(size, hash)| v["size"] == size && v["sha256"] == hash).unwrap_or(false)
    })
}

fn prune_complete_generations(root: &Path) {
    let Ok(entries) = std::fs::read_dir(root) else { return };
    let mut complete: Vec<_> = entries.flatten().filter(|e| {
        let name = e.file_name().to_string_lossy().to_string();
        (name.len() == 10 || name.get(10..).is_some_and(|suffix| suffix.starts_with("-retry-")))
            && name.chars().take(10).enumerate().all(|(i,c)| if i == 4 || i == 7 { c == '-' } else { c.is_ascii_digit() })
            && complete_snapshot(&e.path())
    }).collect();
    complete.sort_by_key(|e| e.file_name());
    let excess = complete.len().saturating_sub(7);
    for entry in complete.into_iter().take(excess) { let _ = std::fs::remove_dir_all(entry.path()); }
}

/// Storage that is not this computer.
///
/// The nightly backup writes into the app's own folder, which survives a
/// corrupted file and does not survive a dead disk — and a dead disk is exactly
/// the day the backup is needed. A copy that shares a fate with the original is
/// not a copy.
///
/// So: whenever a USB stick or external drive is plugged in, the backup goes
/// there too, without asking.
///
/// macOS: `/Volumes` (boot disk skipped). Windows: other drive letters.
/// Linux: `/media/$USER`, `/run/media/$USER`, `/mnt`.
#[tauri::command]
pub fn external_drives() -> Value {
    json!({ "drives": list_external() })
}

fn drive_row(name: String, path: PathBuf) -> Value {
    let writable = std::fs::metadata(&path)
        .map(|m| !m.permissions().readonly())
        .unwrap_or(false);
    json!({
        "name": name,
        "path": path.to_string_lossy(),
        "writable": writable,
    })
}

#[cfg(target_os = "macos")]
fn list_external() -> Vec<Value> {
    let mut rows = Vec::new();
    let Ok(rd) = std::fs::read_dir("/Volumes") else {
        return rows;
    };
    for e in rd.flatten() {
        let p = e.path();
        if !p.is_dir() {
            continue;
        }
        // 부팅 디스크도 /Volumes 아래 보인다. 거기 넣으면 같은 디스크다.
        if p.join("System/Library/CoreServices").exists() {
            continue;
        }
        rows.push(drive_row(e.file_name().to_string_lossy().to_string(), p));
    }
    rows
}

#[cfg(target_os = "windows")]
fn list_external() -> Vec<Value> {
    let mut rows = Vec::new();
    let system = std::env::var("SystemDrive").unwrap_or_else(|_| "C:".into());
    let clouds = cloud_folder_list();
    for letter in b'A'..=b'Z' {
        let root = PathBuf::from(format!("{}:\\", letter as char));
        if !root.is_dir() {
            continue;
        }
        let as_str = root.to_string_lossy();
        if as_str.starts_with(&system) {
            continue;
        }
        // 구글드라이브가 G:\My Drive 로 붙는 자리. USB 가 아니다.
        if clouds.iter().any(|c| c.path.starts_with(&root)) {
            continue;
        }
        rows.push(drive_row(format!("{}:", letter as char), root));
    }
    rows
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn list_external() -> Vec<Value> {
    let mut rows = Vec::new();
    let mut seen = std::collections::HashSet::new();
    let user = home()
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_default();
    let mut add_children = |base: &Path| {
        let Ok(rd) = std::fs::read_dir(base) else {
            return;
        };
        for e in rd.flatten() {
            let p = e.path();
            if !p.is_dir() {
                continue;
            }
            let name = e.file_name().to_string_lossy().to_string();
            // WSL 이 윈도우 디스크를 /mnt/c 로 붙인다. 같은 컴퓨터다.
            let lower = name.to_ascii_lowercase();
            if matches!(
                lower.as_str(),
                "c" | "d" | "wsl" | "wslg" | "wslg.localhost" | "chromeos"
            ) {
                continue;
            }
            let key = path_key(&p);
            if !seen.insert(key) {
                continue;
            }
            rows.push(drive_row(name, p));
        }
    };
    let user_media = PathBuf::from("/media").join(&user);
    let user_run = PathBuf::from("/run/media").join(&user);
    if user_media.is_dir() {
        add_children(&user_media);
    } else {
        add_children(Path::new("/media"));
    }
    if user_run.is_dir() {
        add_children(&user_run);
    } else {
        add_children(Path::new("/run/media"));
    }
    add_children(Path::new("/mnt"));
    rows
}

/// Folders that already sync themselves off this machine.
///
/// A USB stick only helps if it is plugged in, and it usually is not. iCloud
/// Drive, OneDrive, Google Drive, Dropbox and Nextcloud are folders that are
/// always on, already paid for, and physically somewhere else — which is the
/// whole requirement.
///
/// 윈도우 원드라이브는 `~/OneDrive` 가 아니라 `%OneDrive%` 다. 그 변수를
/// 안 보면 켜져 있는데도 "클라우드가 없습니다"가 된다.
#[tauri::command]
pub fn cloud_folders() -> Value {
    let folders: Vec<Value> = cloud_folder_list()
        .into_iter()
        .map(|c| json!({ "name": c.name, "path": c.path.to_string_lossy() }))
        .collect();
    let dest = default_backup_parent();
    json!({
        "folders": folders,
        "default": {
            "path": dest.to_string_lossy(),
            "label": "내 서류함",
            "via": cloud_covering(&dest),
        }
    })
}

struct CloudPlace {
    name: String,
    path: PathBuf,
}

fn path_key(p: &Path) -> String {
    p.canonicalize()
        .unwrap_or_else(|_| p.to_path_buf())
        .to_string_lossy()
        .to_lowercase()
}

fn cloud_folder_list() -> Vec<CloudPlace> {
    let mut seen = std::collections::HashSet::new();
    let mut rows = Vec::new();
    let mut add = |name: &str, path: PathBuf| {
        if !path.is_dir() {
            return;
        }
        if !seen.insert(path_key(&path)) {
            return;
        }
        rows.push(CloudPlace {
            name: name.to_string(),
            path,
        });
    };

    let h = home();

    // 윈도우가 알려 주는 원드라이브. 홈 아래 폴더 이름보다 이게 맞다.
    for (label, var) in [
        ("OneDrive", "OneDrive"),
        ("OneDrive", "OneDriveConsumer"),
        ("OneDrive 회사", "OneDriveCommercial"),
    ] {
        if let Ok(p) = std::env::var(var) {
            if !p.trim().is_empty() {
                add(label, PathBuf::from(p));
            }
        }
    }

    for p in dropbox_roots() {
        add("Dropbox", p);
    }

    for (name, rel) in [
        (
            "iCloud Drive",
            "Library/Mobile Documents/com~apple~CloudDocs",
        ),
        ("iCloud Drive", "iCloudDrive"),
        ("iCloud Drive", "iCloud Drive"),
        ("OneDrive", "OneDrive"),
        ("Dropbox", "Dropbox"),
        ("Google Drive", "Google Drive"),
        ("Google Drive", "GoogleDrive"),
        ("Google Drive", "My Drive"),
        ("Nextcloud", "Nextcloud"),
        ("pCloud", "pCloudDrive"),
        ("MEGA", "MEGA"),
        ("MEGA", "MEGAsync"),
        ("Box", "Box"),
        ("Box", "Box Sync"),
    ] {
        add(name, h.join(rel));
    }

    if let Ok(rd) = std::fs::read_dir(&h) {
        for e in rd.flatten() {
            let name = e.file_name().to_string_lossy().to_string();
            if name.starts_with("OneDrive - ") {
                add("OneDrive 회사", e.path());
            }
        }
    }

    if let Ok(rd) = std::fs::read_dir(h.join("Library/CloudStorage")) {
        for e in rd.flatten() {
            if e.path().is_dir() {
                let raw = e.file_name().to_string_lossy().to_string();
                add(&cloudstorage_label(&raw), e.path());
            }
        }
    }

    // 구글드라이브 데스크톱이 드라이브 문자로 붙는 경우 (Windows).
    #[cfg(target_os = "windows")]
    {
        let system = std::env::var("SystemDrive").unwrap_or_else(|_| "C:".into());
        for letter in b'A'..=b'Z' {
            let drive = format!("{}:\\", letter as char);
            if drive.starts_with(&system) {
                continue;
            }
            let my = PathBuf::from(&drive).join("My Drive");
            if my.is_dir() {
                add("Google Drive", my);
            }
        }
    }

    rows
}

fn cloudstorage_label(raw: &str) -> String {
    let lower = raw.to_ascii_lowercase();
    if lower.starts_with("icloud") {
        "iCloud Drive".into()
    } else if lower.starts_with("onedrive") {
        "OneDrive".into()
    } else if lower.contains("google") {
        "Google Drive".into()
    } else if lower.starts_with("dropbox") {
        "Dropbox".into()
    } else {
        raw.to_string()
    }
}

fn dropbox_roots() -> Vec<PathBuf> {
    let mut out = Vec::new();
    let mut candidates = vec![home().join(".dropbox/info.json")];
    for var in ["APPDATA", "LOCALAPPDATA"] {
        if let Ok(p) = std::env::var(var) {
            if !p.trim().is_empty() {
                candidates.push(PathBuf::from(p).join("Dropbox").join("info.json"));
            }
        }
    }
    for p in candidates {
        let Ok(text) = std::fs::read_to_string(&p) else {
            continue;
        };
        let Ok(j) = serde_json::from_str::<Value>(&text) else {
            continue;
        };
        for key in ["personal", "business"] {
            if let Some(path) = j
                .get(key)
                .and_then(|x| x.get("path"))
                .and_then(Value::as_str)
            {
                if !path.trim().is_empty() {
                    out.push(PathBuf::from(path));
                }
            }
        }
    }
    out
}

/// 사장이 폴더를 안 고르면 여기. 세 OS 모두 **서류함**.
///
/// 바탕화면은 화면 공유·수리 맡기기에 먼저 보인다. AppData / .local 은
/// 숨어서 "백업이 어디 갔지"가 된다. 서류함은 탐색기 왼쪽에 있고,
/// 윈도우 원드라이브가 「문서 폴더를 원드라이브로」 켠 컴퓨터에서는
/// 그 자리 자체가 클라우드다.
fn documents_dir() -> PathBuf {
    let h = home();

    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        if let Some(p) = xdg_user_dir("DOCUMENTS") {
            if !p.as_os_str().is_empty() {
                return p;
            }
        }
    }

    for name in ["Documents", "문서"] {
        let p = h.join(name);
        if p.is_dir() {
            return p;
        }
    }

    if let Ok(od) = std::env::var("OneDrive") {
        let p = PathBuf::from(od).join("Documents");
        if p.is_dir() {
            return p;
        }
    }

    h.join("Documents")
}

fn default_backup_parent() -> PathBuf {
    let d = documents_dir();
    if !d.is_dir() {
        let _ = std::fs::create_dir_all(&d);
    }
    if d.is_dir() {
        d
    } else {
        home()
    }
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn xdg_user_dir(kind: &str) -> Option<PathBuf> {
    let env_key = format!("XDG_{kind}_DIR");
    if let Ok(p) = std::env::var(&env_key) {
        if !p.trim().is_empty() {
            return Some(expand_home(&p));
        }
    }
    let text = std::fs::read_to_string(home().join(".config/user-dirs.dirs")).ok()?;
    let prefix = format!("XDG_{kind}_DIR=");
    for line in text.lines() {
        let line = line.trim();
        if let Some(rest) = line.strip_prefix(&prefix) {
            return Some(expand_home(rest.trim().trim_matches('"')));
        }
    }
    None
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn expand_home(p: &str) -> PathBuf {
    if let Some(rest) = p.strip_prefix("$HOME") {
        let rest = rest.trim_start_matches('/').trim_start_matches('\\');
        if rest.is_empty() {
            home()
        } else {
            home().join(rest)
        }
    } else if let Some(rest) = p.strip_prefix("~/") {
        home().join(rest)
    } else if let Some(rest) = p.strip_prefix("~\\") {
        home().join(rest)
    } else {
        PathBuf::from(p)
    }
}

fn cloud_covering(path: &Path) -> Option<String> {
    let canon = path.canonicalize().unwrap_or_else(|_| path.to_path_buf());
    for c in cloud_folder_list() {
        let root = c.path.canonicalize().unwrap_or_else(|_| c.path.clone());
        if canon.starts_with(&root) || path.starts_with(&c.path) {
            return Some(c.name);
        }
    }
    None
}

/// 화면에는 「내 서류함」처럼 읽히는 이름. 윈도우 백슬래시도 여기서 접는다.
fn pretty_place(path: &Path) -> String {
    let resolved = path.canonicalize().unwrap_or_else(|_| path.to_path_buf());
    let join_rest = |label: &str, rest: &Path| -> String {
        if rest.as_os_str().is_empty() {
            label.to_string()
        } else {
            format!("{label}/{}", rest.to_string_lossy().replace('\\', "/"))
        }
    };
    let try_strip = |base: &Path, label: &str| -> Option<String> {
        let base_r = base.canonicalize().unwrap_or_else(|_| base.to_path_buf());
        resolved
            .strip_prefix(&base_r)
            .ok()
            .map(|rest| join_rest(label, rest))
    };

    if let Some(s) = try_strip(&documents_dir(), "내 서류함") {
        return s;
    }
    let h = home();
    if let Some(s) = try_strip(&h.join("Desktop"), "바탕화면") {
        return s;
    }
    if let Some(s) = try_strip(&h.join("바탕화면"), "바탕화면") {
        return s;
    }
    for c in cloud_folder_list() {
        if let Some(s) = try_strip(&c.path, &c.name) {
            return s;
        }
    }
    if let Some(s) = try_strip(&h, "내 폴더") {
        return s;
    }
    resolved.to_string_lossy().replace('\\', "/")
}
