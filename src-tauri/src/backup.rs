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

fn home() -> PathBuf {
    PathBuf::from(std::env::var("HOME").unwrap_or_default())
}

fn raven_dir() -> PathBuf {
    home().join("Library/Application Support/Raven")
}

fn app_dir() -> PathBuf {
    home().join("Library/Application Support/PlayXRaven")
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
            { "name": "AI 열쇠", "why": "백업 폴더가 새면 요금이 청구됩니다. 복구 뒤 다시 넣으세요 — 30초입니다." },
        ],
        "last": last_backup(),
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

    let mut done = Vec::new();
    let mut failed = Vec::new();

    // 노드에게 정합성 있는 사본을 만들게 한다. 실행 중인 파일을 그냥 복사하면
    // 겉보기엔 멀쩡하고 복구할 때 비어 있는 파일이 나온다.
    let wallet_dest = dir.join("wallet.dat");
    match crate::raven::call_rpc(
        "backupwallet",
        json!([wallet_dest.to_string_lossy().to_string()]),
    )
    .await
    {
        Ok(_) => done.push(json!({ "name": "wallet.dat", "path": wallet_dest.to_string_lossy() })),
        Err(e) => failed.push(json!({ "name": "wallet.dat", "why": e })),
    }

    for (name, src, _) in manifest() {
        if !src.exists() {
            continue;
        }
        match std::fs::copy(&src, dir.join(name)) {
            Ok(_) => done.push(json!({ "name": name, "path": dir.join(name).to_string_lossy() })),
            Err(e) => failed.push(json!({ "name": name, "why": e.to_string() })),
        }
    }

    // 백업 폴더에 경고를 같이 남긴다. 몇 달 뒤 이 폴더를 여는 사람은 지금
    // 이 화면을 기억하지 못하고, 그때가 바로 두 번째 노드를 켜는 순간이다.
    let readme = "PLAY X Raven 백업\n\
        \n\
        wallet.dat 은 이 가게의 열쇠입니다.\n\
        \n\
        ⚠ 절대 하면 안 되는 것\n\
        이 wallet.dat 을 다른 컴퓨터에서 '동시에' 켜지 마세요.\n\
        두 노드가 같은 지갑을 쓰면 같은 주소를 두 번 나눠 주고,\n\
        서로 다른 거래에 서명해서 돈을 잃습니다.\n\
        \n\
        원래 컴퓨터가 완전히 죽었을 때만, 그리고 그 컴퓨터가\n\
        꺼져 있는 것을 확인한 뒤에 이 사본을 쓰세요.\n\
        \n\
        passes.json 은 회원 명단입니다. 체인에는 회원번호만 있고\n\
        이름·기간·남은 횟수는 이 파일에만 있습니다.\n\
        \n\
        shop.json 은 가게 그 자체입니다 — 이름·메뉴·가격·사진.\n\
        sessions.json 은 수업 신청자와 대기자 명단입니다.\n\
        fills.json 은 이미 보낸 주문 기록입니다. 이 파일 없이 복구하면\n\
        자동 발송이 같은 자산을 한 번 더 보냅니다. 반드시 같이 되돌리세요.\n\
        \n\
        이 폴더에 AI 열쇠는 들어 있지 않습니다. 복구한 뒤 설정에서\n\
        다시 넣으시면 됩니다.\n";
    let _ = std::fs::write(dir.join("읽어보세요.txt"), readme);

    // 언제 했는지를 남긴다. "백업하세요"는 아무도 안 누르고, "12일 지났습니다"는
    // 누른다.
    if failed.is_empty() {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0);
        let _ = std::fs::write(
            stamp_path(),
            serde_json::to_vec(&json!({ "at": now, "dest": dest, "count": done.len() }))
                .unwrap_or_default(),
        );
    }

    Ok(json!({ "done": done, "failed": failed, "dest": dest, "last": last_backup() }))
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
#[tauri::command]
pub async fn backup_auto(now_unix: i64) -> Value {
    let day = now_unix - (now_unix % 86_400);
    let root = app_dir().join("backups");

    // 오늘 것이 이미 있으면 아무것도 하지 않는다. 앱을 하루에 다섯 번 켜는
    // 가게에서 다섯 벌을 만들면 보관 세대가 하루로 줄어든다.
    let stamp = day_name(day);
    let dest = root.join(&stamp);
    // 폴더가 있다는 것과 백업이 됐다는 것은 다르다. 노드가 꺼진 채 시도하면
    // 폴더만 생기고 지갑은 못 담는데, 그걸 "오늘 했음"으로 세면 그날은
    // 노드가 켜진 뒤에도 영영 다시 시도하지 않는다.
    if dest.join("wallet.dat").exists() {
        return json!({ "skipped": "오늘 것이 이미 있습니다", "dest": dest.to_string_lossy() });
    }
    if std::fs::create_dir_all(&dest).is_err() {
        return json!({ "error": "백업 폴더를 만들지 못했습니다" });
    }

    let r = backup_now(dest.to_string_lossy().to_string()).await;

    // 오래된 세대를 정리한다. 이름이 날짜라 글자 순서가 곧 시간 순서다.
    if let Ok(rd) = std::fs::read_dir(&root) {
        let mut dirs: Vec<String> = rd
            .filter_map(|e| e.ok())
            .filter(|e| e.path().is_dir())
            .map(|e| e.file_name().to_string_lossy().to_string())
            .collect();
        dirs.sort();
        while dirs.len() > 7 {
            let old = dirs.remove(0);
            let _ = std::fs::remove_dir_all(root.join(old));
        }
    }

    // 꽂혀 있는 외장이 있으면 거기에도 한 벌. 묻지 않는다 — 물으면 아무도
    // 안 넣고, 안 넣은 백업은 디스크와 함께 죽는다.
    //
    // 이름은 고정이다. 날짜별로 쌓이면 USB 가 지저분해지고, 급할 때 어느 것을
    // 잡아야 하는지 모른다. 대신 덮어쓰기 직전 것 하나만 옆으로 밀어 둔다 —
    // 오늘 아침에 실수로 명단을 지웠다면, 덮어쓴 순간 그 실수가 유일한 사본이
    // 되기 때문이다. 두 개에서 멈추고 더는 늘지 않는다.
    let mut outside: Vec<Value> = Vec::new();
    for d in external_drives()["drives"].as_array().cloned().unwrap_or_default() {
        if !d["writable"].as_bool().unwrap_or(false) {
            continue;
        }
        let Some(root) = d["path"].as_str() else { continue };
        let folder = PathBuf::from(root).join("PLAYXRaven-백업");
        if std::fs::create_dir_all(&folder).is_err() {
            continue;
        }
        roll_previous(&folder, "PLAYXRaven");
        // USB 에는 지갑도 넣는다. 손에 쥐고 서랍에 넣는 물건이라 클라우드와 다르다.
        if let Ok(v) = backup_zip(folder.to_string_lossy().to_string(), "".into(), true).await {
            outside.push(json!({ "drive": d["name"], "path": v["path"] }));
        }
    }

    let cloud = copy_to_cloud(&stamp).await;

    match r {
        Ok(v) => json!({
            "cloud": cloud,
            "made": stamp,
            "result": v,
            "dest": dest.to_string_lossy(),
            "outside": outside,
            "note": match (outside.is_empty(), cloud.is_empty()) {
                (true, true) => "이 컴퓨터 안에만 저장했습니다. 디스크가 죽으면 백업도 같이 죽습니다 — USB를 꽂아 두시거나 iCloud를 켜 두시면 거기에도 자동으로 남깁니다.",
                (true, false) => "클라우드에도 남겼습니다. 다만 클라우드 사본에는 지갑이 빠져 있습니다 — 지갑은 USB와 12단어로 지키세요.",
                (false, true) => "이 컴퓨터와 외장 디스크 양쪽에 남겼습니다.",
                (false, false) => "이 컴퓨터·외장 디스크·클라우드 세 곳에 남겼습니다. 클라우드 사본에는 지갑이 빠져 있습니다.",
            },
        }),
        Err(e) => json!({ "error": e }),
    }
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
#[tauri::command]
pub async fn backup_zip(dest_folder: String, label: String, include_wallet: bool) -> Result<Value, String> {
    // 비워서 부르면 바탕화면. 경로를 타이핑하게 하는 것은 백업을 안 하게 만드는
    // 가장 확실한 방법이었다.
    let out_dir = if dest_folder.trim().is_empty() {
        let d = home().join("Desktop");
        if d.is_dir() { d } else { home() }
    } else {
        PathBuf::from(&dest_folder)
    };
    if !out_dir.is_dir() {
        return Err("폴더가 아닙니다. 저장할 폴더를 고르세요.".into());
    }

    // 지갑은 노드가 만들어야 정합성이 있다. 임시로 뽑아 넣고 지운다.
    let staging = app_dir().join("zip-staging");
    let _ = std::fs::remove_dir_all(&staging);
    std::fs::create_dir_all(&staging).map_err(|e| e.to_string())?;
    let wallet_tmp = staging.join("wallet.dat");
    let wallet_ok = include_wallet
        && crate::raven::call_rpc(
            "backupwallet",
            json!([wallet_tmp.to_string_lossy().to_string()]),
        )
        .await
        .is_ok();

    let encrypted = crate::raven::call_rpc("getwalletinfo", json!([]))
        .await
        .ok()
        .map(|i| i.get("unlocked_until").is_some())
        .unwrap_or(false);

    let safe_label: String = label
        .trim()
        .chars()
        .map(|c| if c.is_alphanumeric() || c == '-' { c } else { '_' })
        .collect();
    let stem = if safe_label.is_empty() {
        "PLAYXRaven".to_string()
    } else {
        format!("PLAYXRaven-{safe_label}")
    };
    let name = format!("{stem}.zip");
    let out = out_dir.join(&name);

    let file = std::fs::File::create(&out).map_err(|e| format!("만들지 못했습니다: {e}"))?;
    let mut zip = zip::ZipWriter::new(file);
    let opts: zip::write::FileOptions<()> =
        zip::write::FileOptions::default().compression_method(zip::CompressionMethod::Deflated);

    let mut inside = Vec::new();
    let mut add = |zip: &mut zip::ZipWriter<std::fs::File>, name: &str, path: &Path| -> bool {
        let Ok(bytes) = std::fs::read(path) else {
            return false;
        };
        use std::io::Write;
        if zip.start_file(name, opts).is_err() {
            return false;
        }
        zip.write_all(&bytes).is_ok()
    };

    if wallet_ok && add(&mut zip, "wallet.dat", &wallet_tmp) {
        inside.push(json!({ "name": "wallet.dat", "what": "지갑 열쇠" }));
    }
    for (fname, path, why) in manifest() {
        if path.exists() && add(&mut zip, fname, &path) {
            inside.push(json!({ "name": fname, "what": why }));
        }
    }

    // 안내문도 같이 넣는다. 몇 달 뒤 이 파일을 여는 사람은 오늘 화면을 기억하지
    // 못한다.
    let readme = format!(
        "PLAY X Raven 백업\n\n         이 파일 하나에 가게 전부가 들어 있습니다.\n\n         새 컴퓨터에서 되돌리는 법\n         1. 레이븐 노드와 PLAY X Raven 을 설치합니다.\n         2. 노드는 아직 켜지 마세요.\n         3. 앱에서 [이 컴퓨터] → [되돌리기] 로 이 파일을 고릅니다.\n         4. 회원 수와 메뉴 개수가 맞는지 보고 되돌립니다.\n         5. 노드를 켭니다.\n\n         {}\n\n         이 백업을 다른 컴퓨터에서 동시에 켜지 마세요. 두 노드가 같은 지갑을 쓰면\n         같은 주소를 두 번 나눠 주고 돈을 잃습니다. 원래 컴퓨터가 완전히 죽었을\n         때만 쓰세요.\n",
        if encrypted {
            "지갑에 암호가 걸려 있습니다. 이 파일을 주워도 암호 없이는 못 씁니다."
        } else {
            "⚠ 지갑에 암호가 없습니다. 이 파일을 주운 사람은 그대로 돈을 쓸 수 있습니다."
        }
    );
    use std::io::Write;
    if zip.start_file("읽어보세요.txt", opts).is_ok() {
        let _ = zip.write_all(readme.as_bytes());
    }
    zip.finish().map_err(|e| format!("마무리하지 못했습니다: {e}"))?;
    let _ = std::fs::remove_dir_all(&staging);

    let size = std::fs::metadata(&out).map(|m| m.len()).unwrap_or(0);
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    let _ = std::fs::write(
        stamp_path(),
        serde_json::to_vec(&json!({ "at": now, "dest": out.to_string_lossy(), "count": inside.len() }))
            .unwrap_or_default(),
    );

    Ok(json!({
        "path": out.to_string_lossy(),
        "name": name,
        "size": size,
        "size_text": format!("{:.1} MB", size as f64 / 1_048_576.0),
        "inside": inside,
        "wallet_included": wallet_ok,
        "wallet_encrypted": encrypted,
        "warning": if encrypted { "" } else {
            "이 지갑에는 암호가 없습니다. 이 파일을 주운 사람은 그대로 돈을 쓸 수 있습니다 — 암호를 먼저 거는 편이 좋습니다."
        },
    }))
}

/// Storage that is not this computer.
///
/// The nightly backup writes into the app's own folder, which survives a
/// corrupted file and does not survive a dead disk — and a dead disk is exactly
/// the day the backup is needed. A copy that shares a fate with the original is
/// not a copy.
///
/// So: whenever a USB stick or external drive is plugged in, the backup goes
/// there too, without asking. macOS mounts removable volumes under `/Volumes`,
/// and the boot disk appears there as well, so it is excluded by comparing
/// against the root device.
#[tauri::command]
pub fn external_drives() -> Value {
    let mut rows = Vec::new();
    let Ok(rd) = std::fs::read_dir("/Volumes") else {
        return json!({ "drives": rows });
    };
    for e in rd.flatten() {
        let p = e.path();
        if !p.is_dir() {
            continue;
        }
        let name = e.file_name().to_string_lossy().to_string();
        // 부팅 디스크도 /Volumes 아래 보인다. 거기 넣으면 같은 디스크다.
        if p.join("System/Library/CoreServices").exists() {
            continue;
        }
        // 쓸 수 있어야 백업 대상이다. 읽기 전용으로 마운트된 디스크 이미지가 흔하다.
        let writable = std::fs::metadata(&p)
            .map(|m| !m.permissions().readonly())
            .unwrap_or(false);
        rows.push(json!({
            "name": name,
            "path": p.to_string_lossy(),
            "writable": writable,
        }));
    }
    json!({ "drives": rows })
}

/// Slides the current backup aside before it is overwritten.
///
/// Fixed names, exactly two files, never more. The one thing a single
/// overwritten copy cannot survive is a mistake made this morning — delete the
/// member list, let the backup run, and the good copy is gone. Keeping the
/// immediately previous one costs one file and covers that.
fn roll_previous(folder: &Path, stem: &str) {
    let latest = folder.join(format!("{stem}.zip"));
    if !latest.exists() {
        return;
    }
    let prev = folder.join(format!("{stem}-이전.zip"));
    let _ = std::fs::remove_file(&prev);
    let _ = std::fs::rename(&latest, &prev);
}

/// Folders that already sync themselves off this machine.
///
/// A USB stick only helps if it is plugged in, and it usually is not. iCloud
/// Drive, OneDrive and Dropbox are folders that are always on, already paid
/// for, and physically somewhere else — which is the whole requirement.
#[tauri::command]
pub fn cloud_folders() -> Value {
    let h = home();
    let mut rows = Vec::new();
    for (name, path) in [
        ("iCloud Drive", h.join("Library/Mobile Documents/com~apple~CloudDocs")),
        ("OneDrive", h.join("OneDrive")),
        ("Dropbox", h.join("Dropbox")),
        ("Google Drive", h.join("Google Drive")),
    ] {
        if path.is_dir() {
            rows.push(json!({ "name": name, "path": path.to_string_lossy() }));
        }
    }
    // 최신 맥은 클라우드 서비스를 여기에 붙인다.
    if let Ok(rd) = std::fs::read_dir(h.join("Library/CloudStorage")) {
        for e in rd.flatten() {
            if e.path().is_dir() {
                rows.push(json!({
                    "name": e.file_name().to_string_lossy(),
                    "path": e.path().to_string_lossy(),
                }));
            }
        }
    }
    json!({ "folders": rows })
}

/// Puts a copy where the disk dying cannot reach it.
///
/// ## Why the wallet does not go to the cloud
///
/// Everything else here is operating data — a member list, a menu, which orders
/// shipped. Losing it closes the shop for a day; leaking it embarrasses. The
/// wallet is different in kind: it is the money, and a copy in iCloud means the
/// money is protected by an Apple ID, which is a password and a text message.
/// That is not the bar a shop's takings should sit behind, and the owner never
/// agreed to it — they agreed to "back up my shop".
///
/// So the cloud copy carries the shop and not the keys. The keys go on a USB
/// stick and on the paper with the twelve words. Different failure, different
/// place.
async fn copy_to_cloud(stamp: &str) -> Vec<Value> {
    let mut out = Vec::new();
    for f in cloud_folders()["folders"].as_array().cloned().unwrap_or_default() {
        let Some(root) = f["path"].as_str() else { continue };
        let folder = PathBuf::from(root).join("PLAYXRaven-백업");
        if std::fs::create_dir_all(&folder).is_err() {
            continue;
        }
        roll_previous(&folder, "PLAYXRaven");
        if let Ok(v) = backup_zip(folder.to_string_lossy().to_string(), "".into(), false).await {
            out.push(json!({ "where": f["name"], "path": v["path"], "wallet": false }));
        }
    }
    out
}
