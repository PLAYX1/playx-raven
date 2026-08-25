//! Where this app keeps its data — decided in one place.
//!
//! Ten modules used to spell out `Library/Application Support/PlayXRaven`
//! independently, and only `ledger` honoured `PLAYX_RAVEN_HOME`. That meant a
//! test could isolate the ledger but nothing else: running the suite wrote API
//! keys, member records and door secrets into the owner's real folder.
//!
//! It also meant the identifier lived in ten string literals. Changing it would
//! have been ten edits, and the one that got missed would not fail to compile —
//! it would quietly read an empty folder and look like a shop with no data.
//!
//! ⚠️ The folder name is load-bearing. It is paired with the bundle identifier
//! `se.erci.ex.playx.raven`, and renaming it orphans every shop's settings,
//! members and ledger. Nothing here should ever be "tidied up".

use std::path::PathBuf;

/// The application data folder.
///
/// `PLAYX_RAVEN_HOME` overrides it, which is how tests stay out of the owner's
/// real data. It is read every call rather than cached: a cached value set
/// before a test changed the variable would send that test to the real folder,
/// which is exactly the failure this module exists to prevent.
pub fn app_dir() -> PathBuf {
    if let Ok(p) = std::env::var("PLAYX_RAVEN_HOME") {
        if !p.trim().is_empty() {
            return PathBuf::from(p);
        }
    }
    base().join(APP_FOLDER)
}

/// 폴더 이름. 번들 identifier 와 짝이라 절대 바꾸지 않는다.
const APP_FOLDER: &str = "PlayXRaven";

/// 이 컴퓨터가 프로그램 데이터를 두는 자리.
///
/// 🔴 여태 macOS 만 알고 있었다 — `HOME` 과 `Library/Application Support`.
/// 윈도우에는 `HOME` 이 없다. 빈 문자열이 되어 경로가 **지금 있는 폴더 기준
/// 상대 경로**로 떨어지고, 바로가기를 어디서 실행하느냐에 따라 가게 메뉴·
/// 회원 장부·주문이 매번 다른 자리에 생긴다. 사장은 "어제 것이 없어졌다" 고
/// 겪는다.
fn base() -> PathBuf {
    #[cfg(target_os = "macos")]
    {
        return home().join("Library/Application Support");
    }
    #[cfg(target_os = "windows")]
    {
        // 로밍이 아니라 Local 이다. 지갑과 34GB 체인은 서버로 따라다니면 안 된다.
        if let Ok(p) = std::env::var("LOCALAPPDATA") {
            if !p.is_empty() {
                return PathBuf::from(p);
            }
        }
        return home().join("AppData").join("Local");
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        if let Ok(p) = std::env::var("XDG_DATA_HOME") {
            if !p.is_empty() {
                return PathBuf::from(p);
            }
        }
        return home().join(".local").join("share");
    }
}

/// 홈 폴더. 윈도우는 `HOME` 이 없고 `USERPROFILE` 이다.
///
/// 어느 쪽도 없으면 **현재 폴더로 떨어뜨리지 않는다.** 상대 경로에 지갑
/// 백업을 쓰면 실행 위치에 따라 파일이 흩어지고, 그건 없는 것보다 나쁘다.
pub fn home() -> PathBuf {
    for k in ["HOME", "USERPROFILE"] {
        if let Ok(p) = std::env::var(k) {
            if !p.trim().is_empty() {
                return PathBuf::from(p);
            }
        }
    }
    // 마지막 수단. 임시 폴더는 지워질 수 있지만 **어디인지는 안다.**
    std::env::temp_dir()
}

/// 레이븐 코어가 쓰는 **기본** 폴더. 우리가 만든 것이 아니라 코어의 규칙이다.
///
/// macOS `~/Library/Application Support/Raven` · 윈도우 `%APPDATA%\Raven`
/// · 리눅스 `~/.raven`. 리눅스만 숨김 폴더인 것은 코어가 그렇게 정했기
/// 때문이고, 우리가 바꾸면 코어 지갑과 서로 다른 지갑을 보게 된다.
pub fn default_raven_dir() -> PathBuf {
    #[cfg(target_os = "macos")]
    {
        return home().join("Library/Application Support/Raven");
    }
    #[cfg(target_os = "windows")]
    {
        if let Ok(p) = std::env::var("APPDATA") {
            if !p.is_empty() {
                return PathBuf::from(p).join("Raven");
            }
        }
        return home().join("AppData").join("Roaming").join("Raven");
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        return home().join(".raven");
    }
}

/// 이 앱이 **실제로** 붙는 레이븐 폴더.
///
/// 🔴 윈도우 0.1.0 은 코어 기본(`%APPDATA%\Raven`)이 아니라 `~\.raven` 을
/// 열어, 원래 지갑이 있는데 빈 지갑으로 시작하는 것처럼 보였다.
/// 코어가 쓰는 폴더에 `wallet.dat` 이 있으면 그걸 그대로 쓴다.
pub fn raven_dir() -> PathBuf {
    active_datadir()
}

fn datadir_save_file() -> PathBuf {
    app_file("raven-datadir.txt")
}

/// 이 폴더에 코어 지갑이 있는가.
pub fn has_wallet(dir: &std::path::Path) -> bool {
    if dir.join("wallet.dat").is_file() {
        return true;
    }
    let wallets = dir.join("wallets");
    if wallets.join("wallet.dat").is_file() {
        return true;
    }
    if let Ok(rd) = std::fs::read_dir(&wallets) {
        for e in rd.flatten() {
            if e.path().join("wallet.dat").is_file() {
                return true;
            }
        }
    }
    false
}

fn saved_datadir() -> Option<PathBuf> {
    let t = std::fs::read_to_string(datadir_save_file()).ok()?;
    let p = PathBuf::from(t.trim());
    if p.is_absolute() && p.is_dir() {
        Some(p)
    } else {
        None
    }
}

/// 코어가 예전에 썼을 법한 자리. 기본 한 곳만 보면 옛 판·직접 고른 폴더를 놓친다.
fn datadir_candidates() -> Vec<PathBuf> {
    let mut out = Vec::new();
    let push = |v: &mut Vec<PathBuf>, p: PathBuf| {
        if p.is_absolute() && !v.iter().any(|x| x == &p) {
            v.push(p);
        }
    };
    push(&mut out, default_raven_dir());
    // 0.1.0 윈도우가 잘못 연 자리. 거기에 지갑이 생겼으면 그것도 후보.
    push(&mut out, home().join(".raven"));
    #[cfg(target_os = "windows")]
    {
        if let Ok(p) = std::env::var("LOCALAPPDATA") {
            if !p.is_empty() {
                push(&mut out, PathBuf::from(p).join("Raven"));
            }
        }
        push(&mut out, home().join("AppData").join("Roaming").join("RavenCore"));
        if let Some(p) = windows_qt_datadir() {
            push(&mut out, p);
        }
    }
    out
}

#[cfg(target_os = "windows")]
fn windows_qt_datadir() -> Option<PathBuf> {
    // Raven-Qt 가 데이터 폴더를 옮겼으면 레지스트리에 남는다.
    let out = crate::quiet::cmd("reg")
        .args([
            "query",
            r"HKCU\Software\Raven\Raven-Qt",
            "/v",
            "strDataDir",
        ])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&out.stdout);
    for line in text.lines() {
        if let Some(i) = line.find("REG_SZ") {
            let p = PathBuf::from(line[i + 6..].trim());
            if p.is_absolute() {
                return Some(p);
            }
        }
    }
    None
}

fn active_datadir() -> PathBuf {
    if let Some(p) = saved_datadir() {
        return p;
    }
    datadir_candidates()
        .into_iter()
        .find(|p| has_wallet(p))
        .unwrap_or_else(default_raven_dir)
}

/// 지금 붙는 폴더가 어디인지, 기존 지갑이 있는지.
#[tauri::command]
pub fn datadir_status() -> serde_json::Value {
    let path = raven_dir();
    let saved = saved_datadir().is_some();
    let found = has_wallet(&path);
    let source = if saved {
        "saved"
    } else if found {
        "found"
    } else {
        "default"
    };
    let note = if found {
        "기존 레이븐 코어 지갑을 찾았습니다. 이 폴더를 그대로 씁니다."
    } else {
        "이 폴더에 wallet.dat 이 없습니다. 코어가 쓰는 폴더를 골라 주세요."
    };
    serde_json::json!({
        "path": path.to_string_lossy(),
        "has_wallet": found,
        "source": source,
        "note": note,
        "candidates": datadir_candidates().iter().map(|p| p.to_string_lossy().to_string()).collect::<Vec<_>>(),
    })
}

/// 사장이 코어 폴더를 직접 고른다.
#[tauri::command]
pub fn datadir_set(path: String) -> Result<serde_json::Value, String> {
    let p = PathBuf::from(path.trim());
    if !p.is_absolute() {
        return Err("폴더 주소가 올바르지 않습니다.".into());
    }
    if !p.is_dir() {
        return Err("그런 폴더가 없습니다.".into());
    }
    if !has_wallet(&p) {
        return Err("이 폴더에 wallet.dat 이 없습니다. 레이븐 코어의 데이터 폴더를 골라 주세요.".into());
    }
    let f = datadir_save_file();
    if let Some(d) = f.parent() {
        let _ = std::fs::create_dir_all(d);
    }
    std::fs::write(&f, p.to_string_lossy().as_bytes())
        .map_err(|e| format!("폴더를 기억하지 못했습니다: {e}"))?;
    Ok(datadir_status())
}

/// A file inside the application data folder.
pub fn app_file(name: &str) -> PathBuf {
    app_dir().join(name)
}

/// 시험 전용 자물쇠.
///
/// 🔴 `PLAYX_RAVEN_HOME` 은 프로세스 전역이다. 이걸 세우는 시험 둘이 동시에
/// 돌면 한쪽이 다른 쪽의 값을 지운다 — 실제로 수수료 시험이 그렇게 깨졌다.
/// 파일을 건드리는 시험은 전부 이 자물쇠를 잡고 들어간다.
#[cfg(test)]
pub static TEST_ENV: std::sync::Mutex<()> = std::sync::Mutex::new(());

#[cfg(test)]
mod tests {
    use super::*;

    /// 🔴 여태 macOS 경로가 **여덟 파일에** 흩어져 있었다. 윈도우에는 `HOME`
    /// 이 없어 빈 문자열이 되고, 경로가 **지금 있는 폴더 기준 상대 경로**로
    /// 떨어진다 — 바로가기를 어디서 실행하느냐에 따라 가게 메뉴·회원 장부·
    /// 주문이 매번 다른 자리에 생기고, 사장은 "어제 것이 없어졌다" 고 겪는다.
    #[test]
    fn no_path_is_ever_relative() {
        let _g = super::TEST_ENV.lock().unwrap_or_else(|e| e.into_inner());
        for k in ["HOME", "USERPROFILE", "LOCALAPPDATA", "APPDATA", "XDG_DATA_HOME", "PLAYX_RAVEN_HOME"] {
            std::env::remove_var(k);
        }
        // 환경변수가 하나도 없어도 절대 경로여야 한다. 상대 경로에 지갑
        // 백업을 쓰면 실행 위치에 따라 파일이 흩어진다 — 없는 것보다 나쁘다.
        assert!(app_dir().is_absolute(), "앱 폴더가 상대 경로다: {:?}", app_dir());
        assert!(raven_dir().is_absolute(), "레이븐 폴더가 상대 경로다: {:?}", raven_dir());
        assert!(home().is_absolute(), "홈이 상대 경로다: {:?}", home());
    }

    /// 코어 폴더 이름을 우리가 바꾸면 **코어 지갑과 서로 다른 지갑을 본다.**
    #[test]
    fn the_core_folder_matches_what_ravencoin_uses() {
        let _g = super::TEST_ENV.lock().unwrap_or_else(|e| e.into_inner());
        let d = default_raven_dir().to_string_lossy().to_string();
        if cfg!(target_os = "macos") {
            assert!(d.ends_with("Library/Application Support/Raven"), "{d}");
        } else if cfg!(target_os = "windows") {
            assert!(d.ends_with("Raven"), "{d}");
        } else {
            assert!(d.ends_with(".raven"), "{d}");
        }
    }

    /// 소스에 macOS 경로가 다시 박히면 윈도우가 또 깨진다.
    #[test]
    fn mac_paths_live_only_in_this_file() {
        for (name, src) in [
            ("conf.rs", include_str!("conf.rs")),
            ("raven.rs", include_str!("raven.rs")),
            ("recover.rs", include_str!("recover.rs")),
            ("services.rs", include_str!("services.rs")),
            ("health.rs", include_str!("health.rs")),
            ("setup.rs", include_str!("setup.rs")),
            ("backup.rs", include_str!("backup.rs")),
        ] {
            assert!(
                !src.contains("Library/Application Support"),
                "{name} 에 macOS 전용 경로가 박혀 있다 — 윈도우에서 데이터가 미아가 된다",
            );
        }
    }

    #[test]
    fn a_folder_without_wallet_dat_is_not_a_wallet() {
        let tmp = std::env::temp_dir().join("playx-raven-nowallet");
        let _ = std::fs::create_dir_all(&tmp);
        assert!(!has_wallet(&tmp));
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn the_override_wins_and_an_empty_one_does_not() {
        let _g = super::TEST_ENV.lock().unwrap_or_else(|e| e.into_inner());
        // 빈 값으로 덮어쓰는 사고를 막는다. 빈 문자열을 경로로 받아들이면
        // 앱 데이터가 파일시스템 루트로 향한다.
        std::env::set_var("PLAYX_RAVEN_HOME", "/tmp/playx-raven-paths-test");
        assert_eq!(app_dir(), PathBuf::from("/tmp/playx-raven-paths-test"));
        std::env::set_var("PLAYX_RAVEN_HOME", "   ");
        assert!(
            app_dir().to_string_lossy().contains("PlayXRaven"),
            "빈 값이 진짜 폴더를 가려서는 안 된다"
        );
        std::env::remove_var("PLAYX_RAVEN_HOME");
        assert!(app_dir().to_string_lossy().contains("PlayXRaven"));
    }
}
