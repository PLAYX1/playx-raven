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
    PathBuf::from(std::env::var("HOME").unwrap_or_default())
        .join("Library/Application Support/PlayXRaven")
}

/// A file inside the application data folder.
pub fn app_file(name: &str) -> PathBuf {
    app_dir().join(name)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_override_wins_and_an_empty_one_does_not() {
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
