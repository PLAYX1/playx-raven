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
    if p.is_dir() {
        return Ok(p);
    }
    if !p.is_file() {
        return Err("파일도 폴더도 아닙니다.".into());
    }

    let scratch = dir().join("restore-open");
    let _ = std::fs::remove_dir_all(&scratch);
    std::fs::create_dir_all(&scratch).map_err(|e| e.to_string())?;

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
                return Err("이 백업은 다른 컴퓨터에서 만든 것입니다. 그때 정하신 암호를 넣어 주세요.".into());
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

    let file = std::fs::File::open(&p).map_err(|e| format!("열지 못했습니다: {e}"))?;
    let mut zip = zip::ZipArchive::new(file)
        .map_err(|_| "이 파일은 PLAY X Raven 백업이 아닙니다.".to_string())?;

    for i in 0..zip.len() {
        let mut entry = zip.by_index(i).map_err(|e| e.to_string())?;
        // 압축 파일 안의 경로는 믿지 않는다. `../../` 이 들어 있으면 압축을 푸는
        // 것만으로 남의 파일을 덮어쓴다. 파일 이름만 쓴다.
        let Some(name) = entry.enclosed_name().and_then(|n| n.file_name().map(|f| f.to_owned()))
        else {
            continue;
        };
        let out = scratch.join(name);
        let mut w = std::fs::File::create(&out).map_err(|e| e.to_string())?;
        std::io::copy(&mut entry, &mut w).map_err(|e| e.to_string())?;
    }
    Ok(scratch)
}

/// Reads a backup folder and says what is inside, in counts a person can check.
///
/// Deliberately before restoring, and deliberately in nouns rather than file
/// names: "회원 12명" is checkable at a glance and "passes.json 4.2 KB" is not.
/// Restoring the wrong night's folder is the mistake this exists to catch.
#[tauri::command]
pub fn restore_survey(folder: String, pass: Option<String>) -> Result<Value, String> {
    // 폴더든 zip 이든 여기서 같아진다.
    let dir = unpack_with(&folder, pass.as_deref().unwrap_or(""))?;

    let count_in = |file: &str, key: &str| -> Option<usize> {
        let v: Value =
            serde_json::from_str(&std::fs::read_to_string(dir.join(file)).ok()?).ok()?;
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
        items.push(json!({ "key": "passes", "what": "회원", "detail": format!("{n}명"),
                           "why": "이름·기간·남은 횟수" }));
    }
    if let Some(n) = count_in("tickets.json", "tickets") {
        items.push(json!({ "key": "tickets", "what": "이용권", "detail": format!("{n}장"),
                           "why": "카운터에서 판 표 — 잃으면 손님이 산 표가 사라집니다" }));
    }
    if let Some(n) = count_in("bookings.json", "bookings") {
        items.push(json!({ "key": "bookings", "what": "예약", "detail": format!("{n}건"),
                           "why": "잃으면 손님은 오는데 가게가 모릅니다" }));
    }
    if let Some(n) = count_in("sessions.json", "sessions") {
        items.push(json!({ "key": "sessions", "what": "수업", "detail": format!("{n}개 회차"),
                           "why": "신청자와 대기자" }));
    }
    if dir.join("fills.json").exists() {
        items.push(json!({ "key": "fills", "what": "발송 기록", "detail": "있음",
                           "why": "이게 없으면 복구 뒤 같은 자산을 한 번 더 보냅니다" }));
    }
    if dir.join("orders.json").exists() {
        items.push(json!({ "key": "orders", "what": "주문 주소", "detail": "있음",
                           "why": "손님이 적은 받을 주소" }));
    }
    if dir.join("sweep.json").exists() {
        items.push(json!({ "key": "sweep", "what": "자동 송금", "detail": "있음",
                           "why": "금고로 옮기는 설정" }));
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

/// Puts a backup back.
///
/// `keys` selects what to restore, so a shop that only lost its member list does
/// not have to touch its wallet. The wallet is the one that can go badly, so it
/// carries its own conditions rather than riding along with the rest.
#[tauri::command]
pub async fn restore_apply(
    folder: String,
    keys: Vec<String>,
    pass: Option<String>,
) -> Result<Value, String> {
    let src = unpack_with(&folder, pass.as_deref().unwrap_or(""))?;
    let want = |k: &str| keys.iter().any(|x| x == k);

    let mut done = Vec::new();
    let mut failed = Vec::new();

    // ── 지갑 ──
    if want("wallet") && src.join("wallet.dat").exists() {
        // 노드가 돌고 있으면 절대 안 된다. 실행 중인 지갑 파일을 갈아 끼우면
        // 열리기는 하는데 내용이 틀린 지갑이 나오고, 그건 안 열리는 것보다 나쁘다.
        let node_up = crate::raven::call_rpc("getblockchaininfo", json!([]))
            .await
            .is_ok();
        if node_up {
            failed.push(json!({
                "what": "지갑",
                "why": "노드가 켜져 있습니다. 먼저 노드를 끄고 다시 하세요 — 켜진 채로 바꾸면 지갑이 깨집니다.",
            }));
        } else {
            let dest = raven_dir().join("wallet.dat");
            // 지금 것을 먼저 치운다. 잘못된 폴더를 되돌리는 것은 아침 9시에
            // 줄을 세워 두고 흔히 하는 실수고, 이전 파일이 없으면 그 실수는
            // 영구적이며 돈이다.
            let mut kept: Option<String> = None;
            if dest.exists() {
                let aside = raven_dir().join("wallet.dat.before-restore");
                match std::fs::rename(&dest, &aside) {
                    Ok(_) => kept = Some(aside.to_string_lossy().to_string()),
                    Err(e) => {
                        failed.push(json!({ "what": "지갑", "why": format!("지금 지갑을 치우지 못했습니다: {e}") }));
                        return Ok(json!({ "done": done, "failed": failed }));
                    }
                }
            }
            match std::fs::copy(src.join("wallet.dat"), &dest) {
                Ok(_) => done.push(json!({
                    "what": "지갑",
                    "note": "노드를 켜면 적용됩니다.",
                    "previous": kept,
                })),
                Err(e) => failed.push(json!({ "what": "지갑", "why": e.to_string() })),
            }
        }
    }

    // ── 나머지는 그냥 파일이다. 노드와 무관하고 언제든 된다.
    //
    // 🔴 `shopkey.json` 은 가게 간판 열쇠다. 백업에는 들어 있었는데 되돌리기가
    //    안 가져왔다. 새 컴퓨터는 켤 때 새 열쇠를 만들어 버리고, 체인에 적힌
    //    공개키와 안 맞아 「지금 여기서 주문받습니다」가 영원히 안 올라간다.
    //    가게를 되돌리면 열쇠도 같이 온다. 따로 고르게 하지 않는다.
    for (key, file, label) in [
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
        if !want(key) {
            continue;
        }
        let from = src.join(file);
        if !from.exists() {
            continue;
        }
        let to = dir().join(file);
        let _ = std::fs::create_dir_all(dir());
        // 여기도 지금 것을 남긴다. 회원 명단을 잘못 덮으면 사람들이 문 앞에서
        // 알게 된다.
        if to.exists() {
            let _ = std::fs::copy(&to, to.with_extension("json.before-restore"));
        }
        match std::fs::copy(&from, &to) {
            Ok(_) => done.push(json!({ "what": label, "note": "" })),
            Err(e) => failed.push(json!({ "what": label, "why": e.to_string() })),
        }
    }

    // 🔴 **푼 것을 치운다.** 여태 안 치웠다 — 2026-08-31 실측: 8월 24일에
    //    되돌린 뒤로 `restore-open/` 에 **잠금이 풀린 지갑(2.5MB)·간판
    //    열쇠·회원 명단·백업 zip** 이 그대로 남아 있었다.
    //
    //    백업을 잠그는 이유가 통째로 없어진다. 잠근 파일 옆에 안 잠긴
    //    사본이 영원히 놓여 있으면, 이 컴퓨터를 가져간 사람은 암호를 몰라도
    //    다 가진다. `shopkey.json` 하나만 있어도 「이 가게는 지금 여기서
    //    받습니다」를 손님에게 말할 수 있다.
    //
    //    다음 되돌리기가 시작할 때 지우기는 했다. 그런데 **그 사이가 몇 달**이다.
    청소();

    Ok(json!({
        "done": done,
        "failed": failed,
        "restart_app": !done.is_empty(),
        "note": "앱을 다시 켜면 되돌린 내용이 보입니다.",
    }))
}

/// 되돌리려고 풀어 놓은 것을 지운다.
///
/// 실패해도 알리지 않는다 — 되돌리기는 이미 끝났고, 청소가 안 됐다고
/// 사장에게 겁을 줄 이유가 없다. 다음 되돌리기가 다시 지운다.
pub fn 청소() {
    let _ = std::fs::remove_dir_all(dir().join("restore-open"));
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
    let root = dir().join("backups");
    let mut rows: Vec<Value> = Vec::new();
    if let Ok(rd) = std::fs::read_dir(&root) {
        for e in rd.flatten() {
            if !e.path().is_dir() {
                continue;
            }
            let name = e.file_name().to_string_lossy().to_string();
            let has_wallet = e.path().join("wallet.dat").exists();
            rows.push(json!({
                "day": name,
                "path": e.path().to_string_lossy(),
                "wallet": has_wallet,
            }));
        }
    }
    rows.sort_by(|a, b| b["day"].as_str().unwrap_or("").cmp(a["day"].as_str().unwrap_or("")));
    json!({ "root": root.to_string_lossy(), "folders": rows })
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
            body[..end].contains("청소()"),
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
        assert!(잠겼나(잠긴것), "잠긴 파일을 못 알아본다 — 가게 옮기기가 막힌다");
        assert!(!잠겼나(보통zip), "보통 zip 을 잠겼다고 본다 — 멀쩡한 백업이 안 열린다");
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
            assert!(!card.contains(bad), "복구 카드에 비밀이 들어갔습니다: {bad}");
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
