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

/// 레이븐 코어가 쓰는 폴더. 우리가 만든 것이 아니라 코어의 규칙이다.
///
/// macOS `~/Library/Application Support/Raven` · 윈도우 `%APPDATA%\Raven`
/// · 리눅스 `~/.raven`. 리눅스만 숨김 폴더인 것은 코어가 그렇게 정했기
/// 때문이고, 우리가 바꾸면 코어 지갑과 서로 다른 지갑을 보게 된다.
pub fn raven_dir() -> PathBuf {
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
        let d = raven_dir().to_string_lossy().to_string();
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
