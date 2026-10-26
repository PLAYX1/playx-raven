//! 앱 자료 폴더 이름을 옛 `PlayXRaven` 에서 `RavenVault` 로 옮기는 장치.
//!
//! 🔴 원칙: **가게 자료를 지우거나 덮어쓰는 길이 없다.** 이 파일에는 폴더 통째 재귀 삭제도,
//! 복사 후 삭제도 없다. 하는 일은 딱 둘 — ① 같은 부모 안에서 폴더 이름 바꾸기
//! (`rename`, 원자적), ② 아무것도 안 들어 있는 **빈** 폴더를 `remove_dir` 로 치우기
//! (비어 있지 않으면 OS 가 거절한다). 이름 바꾸기가 안 되면 옛 폴더를 그대로 쓴다.
//!
//! 판정(`decide`)은 디스크를 보지 않는 순수 함수라 맥에서 모든 경우를 시험한다.
//! 윈도우에서 `ravend.exe`·`ipfs.exe` 가 폴더 안 파일을 잡고 있으면 `rename` 이
//! 거절되는데, 그것도 같은 "옛 폴더 그대로 쓰기" 길로 간다(실기 시험은 미실시).

use std::path::{Path, PathBuf};

pub const NEW_FOLDER: &str = "RavenVault";
pub const LEGACY_FOLDER: &str = "PlayXRaven";

/// 이 파일이 하나라도 있으면 「가게 자료가 있는 폴더」로 본다.
/// backup.rs 의 manifest 10개 + 열쇠·장부·설정 파일.
pub const DATA_MARKERS: &[&str] = &[
    "shop.json", "shopkey.json", "passes.json", "tickets.json", "bookings.json",
    "sessions.json", "orders.json", "fills.json", "sweep.json", "create_history.json",
    "shop-seal-key.json", "shop-seal-settings.json", "cloud-backup.key", "backup-key-envelope",
    "lock-keys", "talkkey.json", "devfee.json", "tokens.json", "member_groups.json",
    "groupbuy.json", "map.json", "peers.json", "order-state.json", "raven-datadir.txt",
    "backups", "create-photos", "payouts", "remote-sales", "pairing",
];

/// 폴더 하나를 본 사실. 판정은 이것만 본다.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub struct Facts {
    /// 그 이름으로 뭔가(링크 포함) 있다.
    pub exists: bool,
    /// 폴더로 열린다(심볼릭 링크는 따라간다).
    pub is_dir: bool,
    /// 안에 아무것도 없다.
    pub empty: bool,
    /// 가게 자료 표지 파일이 하나라도 있다.
    pub has_data: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Why {
    /// 새 이름 자리에 폴더가 아닌 것이 있다.
    NewIsNotAFolder,
    /// 새 폴더가 비어 있지 않은데 자료는 옛 폴더에만 있다.
    NewHasNoData,
    /// 노드·파일창고가 옛 폴더 안 프로그램으로 돌고 있다.
    ProgramRunning,
    /// 이름 바꾸기를 OS 가 거절했다.
    RenameFailed(String),
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Plan {
    /// 새 이름 그대로 쓴다(없으면 나중에 만들어진다).
    UseNew,
    /// 옛 폴더를 새 이름으로 바꾼다.
    Rename,
    /// 새 폴더가 완전히 비었다 — 치우고 이름을 바꾼다.
    RemoveEmptyNewThenRename,
    /// 이번엔 옛 폴더를 그대로 쓴다.
    UseLegacy(Why),
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Decision {
    pub plan: Plan,
    /// 두 폴더에 다 자료가 있다 — 합치는 일은 자동으로 하지 않는다.
    pub both_have_data: bool,
}

/// 순수 판정. 디스크를 건드리지 않는다.
pub fn decide(new: &Facts, legacy: &Facts) -> Decision {
    let d = |plan, both| Decision { plan, both_have_data: both };
    if !legacy.is_dir {
        return d(Plan::UseNew, false);
    }
    if !new.exists {
        return d(Plan::Rename, false);
    }
    if !new.is_dir {
        return d(Plan::UseLegacy(Why::NewIsNotAFolder), false);
    }
    // 둘 다 폴더.
    match (legacy.has_data, new.has_data) {
        (true, true) => d(Plan::UseNew, true),
        (false, _) => d(Plan::UseNew, false),
        (true, false) if new.empty => d(Plan::RemoveEmptyNewThenRename, false),
        (true, false) => d(Plan::UseLegacy(Why::NewHasNoData), false),
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Outcome {
    /// 새 이름을 쓴다(처음 설치·이미 옮김 포함).
    InUse,
    /// 이번 실행에서 이름을 바꿨다.
    Renamed,
    /// 옛 폴더를 그대로 쓴다.
    Legacy(Why),
    /// 두 폴더에 다 자료가 있어 새 폴더를 쓴다. 옛 폴더는 그대로 남아 있다.
    BothHaveData,
}

#[derive(Clone, Debug)]
pub struct Resolved {
    pub dir: PathBuf,
    pub legacy: PathBuf,
    pub outcome: Outcome,
}

impl Resolved {
    /// 화면에 띄울 쉬운 말. 알릴 일이 없으면 None.
    pub fn notice(&self) -> Option<serde_json::Value> {
        let (kind, message) = match &self.outcome {
            Outcome::InUse | Outcome::Renamed => return None,
            Outcome::BothHaveData => ("both-have-data", format!(
                "옛 폴더({})에도 가게 자료가 있어요. 지금은 새 폴더({})만 쓰고, 옛 폴더는 지우지도 합치지도 않고 그대로 두었어요. 어느 쪽 자료를 쓸지는 직접 정해 주세요.",
                self.legacy.display(), self.dir.display())),
            Outcome::Legacy(why) => ("using-old-folder", format!(
                "자료 폴더 이름을 {NEW_FOLDER}로 바꾸려 했지만 {} 이번에는 옛 폴더({})를 그대로 써요. 자료는 그대로 안전하고, 프로그램을 다시 켜면 한 번 더 시도해요.",
                match why {
                    Why::ProgramRunning => "노드나 파일창고가 아직 돌고 있어서".to_string(),
                    Why::RenameFailed(_) => "다른 프로그램이 폴더를 쓰고 있어서".to_string(),
                    Why::NewHasNoData => format!("새 폴더({NEW_FOLDER})에 다른 파일이 이미 있어서"),
                    Why::NewIsNotAFolder => format!("{NEW_FOLDER} 자리에 폴더가 아닌 것이 있어서"),
                },
                self.dir.display())),
        };
        Some(serde_json::json!({ "kind": kind, "message": message, "using": self.dir.to_string_lossy(), "old_folder": self.legacy.to_string_lossy() }))
    }
}

pub fn facts_of(p: &Path) -> Facts {
    let exists = std::fs::symlink_metadata(p).is_ok();
    let is_dir = std::fs::metadata(p).map(|m| m.is_dir()).unwrap_or(false);
    let (empty, has_data) = if is_dir {
        let empty = std::fs::read_dir(p).map(|mut r| r.next().is_none()).unwrap_or(false);
        let has_data = DATA_MARKERS.iter().any(|n| std::fs::symlink_metadata(p.join(n)).is_ok());
        (empty, has_data)
    } else {
        (false, false)
    };
    Facts { exists, is_dir, empty, has_data }
}

/// 판정을 실제로 한다. `rename`·`running_inside` 는 시험에서 바꿔 끼운다.
pub fn resolve_at(
    base: &Path,
    running_inside: &dyn Fn(&Path) -> bool,
    rename: &dyn Fn(&Path, &Path) -> std::io::Result<()>,
) -> Resolved {
    let new = base.join(NEW_FOLDER);
    let legacy = base.join(LEGACY_FOLDER);
    let decision = decide(&facts_of(&new), &facts_of(&legacy));
    let done = |dir: &Path, outcome| Resolved { dir: dir.to_path_buf(), legacy: legacy.clone(), outcome };
    let fallback = |why| done(&legacy, Outcome::Legacy(why));
    match decision.plan {
        Plan::UseNew => done(&new, if decision.both_have_data { Outcome::BothHaveData } else { Outcome::InUse }),
        Plan::UseLegacy(why) => fallback(why),
        Plan::Rename | Plan::RemoveEmptyNewThenRename => {
            // 자식 프로세스가 옛 폴더 안 프로그램이면 건드리지 않는다.
            if running_inside(&legacy) {
                return fallback(Why::ProgramRunning);
            }
            if decision.plan == Plan::RemoveEmptyNewThenRename {
                // remove_dir 은 비어 있지 않으면 실패한다 — 자료를 지울 수 없다.
                if std::fs::remove_dir(&new).is_err() {
                    return fallback(Why::NewHasNoData);
                }
            }
            match rename(&legacy, &new) {
                Ok(()) => done(&new, Outcome::Renamed),
                Err(e) => fallback(Why::RenameFailed(e.to_string())),
            }
        }
    }
}

/// 옛 폴더 안 실행 파일이 지금 돌고 있는가. 못 알아내면 false(윈도우는 rename 거절이 2차 방어).
pub fn processes_running_inside(dir: &Path) -> bool {
    command_lines().iter().any(|l| line_mentions_dir(l, dir))
}

/// 순수: 프로세스 명령줄이 이 폴더 **안**의 경로를 담는가("PlayXRaven2" 같은 이웃은 제외).
pub fn line_mentions_dir(line: &str, dir: &Path) -> bool {
    let d = dir.to_string_lossy();
    let mut from = 0;
    while let Some(i) = line[from..].find(d.as_ref()) {
        let end = from + i + d.len();
        match line[end..].chars().next() {
            Some('/') | Some('\\') => return true,
            _ => from = end,
        }
    }
    false
}

#[cfg(unix)]
fn command_lines() -> Vec<String> {
    std::process::Command::new("ps").args(["-axo", "command="]).output().ok()
        .map(|o| String::from_utf8_lossy(&o.stdout).lines().map(str::to_string).collect())
        .unwrap_or_default()
}

#[cfg(windows)]
fn command_lines() -> Vec<String> {
    // 미시험(윈도우 실기 필요).
    crate::quiet::cmd("powershell")
        .args(["-NoProfile", "-Command", "Get-CimInstance Win32_Process | ForEach-Object { $_.ExecutablePath; $_.CommandLine }"])
        .output().ok()
        .map(|o| String::from_utf8_lossy(&o.stdout).lines().map(str::to_string).collect())
        .unwrap_or_default()
}

/// 저장된 설정에 박힌 옛 폴더 절대 경로를 지금 폴더로 바꿔 읽는다(디스크는 안 고친다).
pub fn rebase_path_str(s: &str, legacy: &Path, current: &Path) -> String {
    if legacy == current {
        return s.to_string();
    }
    let l = legacy.to_string_lossy();
    match s.strip_prefix(l.as_ref()) {
        Some(rest) if rest.is_empty() || rest.starts_with('/') || rest.starts_with('\\') =>
            format!("{}{}", current.to_string_lossy(), rest),
        _ => s.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn f(exists: bool, is_dir: bool, empty: bool, has_data: bool) -> Facts { Facts { exists, is_dir, empty, has_data } }
    const NONE: Facts = Facts { exists: false, is_dir: false, empty: false, has_data: false };
    const DATA: Facts = Facts { exists: true, is_dir: true, empty: false, has_data: true };
    const EMPTY: Facts = Facts { exists: true, is_dir: true, empty: true, has_data: false };
    const JUNK: Facts = Facts { exists: true, is_dir: true, empty: false, has_data: false };

    #[test]
    fn decide_table() {
        assert_eq!(decide(&NONE, &NONE).plan, Plan::UseNew);
        assert_eq!(decide(&DATA, &NONE).plan, Plan::UseNew);
        assert_eq!(decide(&NONE, &DATA).plan, Plan::Rename);
        assert_eq!(decide(&NONE, &EMPTY).plan, Plan::Rename);
        assert_eq!(decide(&EMPTY, &DATA).plan, Plan::RemoveEmptyNewThenRename);
        assert_eq!(decide(&JUNK, &DATA).plan, Plan::UseLegacy(Why::NewHasNoData));
        assert_eq!(decide(&DATA, &EMPTY).plan, Plan::UseNew);
        assert_eq!(decide(&DATA, &JUNK).plan, Plan::UseNew);
        assert_eq!(decide(&EMPTY, &JUNK).plan, Plan::UseNew);
        let both = decide(&DATA, &DATA);
        assert_eq!((both.plan, both.both_have_data), (Plan::UseNew, true));
        assert_eq!(decide(&f(true, false, false, false), &DATA).plan, Plan::UseLegacy(Why::NewIsNotAFolder));
        // 끊어진 링크인 옛 이름은 없는 것으로 본다.
        assert_eq!(decide(&DATA, &f(true, false, false, false)).plan, Plan::UseNew);
    }

    fn tmp(name: &str) -> PathBuf {
        let p = crate::paths::test_fixture_root().join(format!("adm-{name}"));
        let _ = fs::remove_dir_all(&p); // 시험 전용 임시 폴더 정리
        fs::create_dir_all(&p).unwrap();
        p
    }
    fn real(base: &Path) -> Resolved { resolve_at(base, &|_| false, &|a, b| fs::rename(a, b)) }

    #[test]
    fn fresh_install_uses_new_and_creates_nothing() {
        let b = tmp("fresh");
        let r = real(&b);
        assert_eq!(r.dir, b.join(NEW_FOLDER));
        assert_eq!(r.outcome, Outcome::InUse);
        assert!(!b.join(LEGACY_FOLDER).exists());
    }

    #[test]
    fn legacy_only_is_renamed_with_content_and_mode_kept() {
        let b = tmp("legacy-only");
        let old = b.join(LEGACY_FOLDER);
        fs::create_dir_all(old.join("bin")).unwrap();
        fs::write(old.join("shop.json"), b"{\"name\":\"x\"}").unwrap();
        fs::write(old.join("bin/ravend"), b"BIN").unwrap();
        #[cfg(unix)] { use std::os::unix::fs::PermissionsExt; fs::set_permissions(&old, fs::Permissions::from_mode(0o700)).unwrap(); }
        let r = real(&b);
        assert_eq!(r.outcome, Outcome::Renamed);
        assert_eq!(r.dir, b.join(NEW_FOLDER));
        assert!(!old.exists());
        assert_eq!(fs::read(r.dir.join("shop.json")).unwrap(), b"{\"name\":\"x\"}");
        assert_eq!(fs::read(r.dir.join("bin/ravend")).unwrap(), b"BIN");
        #[cfg(unix)] { use std::os::unix::fs::PermissionsExt; assert_eq!(fs::metadata(&r.dir).unwrap().permissions().mode() & 0o777, 0o700); }
        // 두 번째 실행은 멱등.
        let r2 = real(&b);
        assert_eq!((r2.dir.clone(), r2.outcome), (b.join(NEW_FOLDER), Outcome::InUse));
        assert_eq!(fs::read(r2.dir.join("shop.json")).unwrap(), b"{\"name\":\"x\"}");
    }

    #[test]
    fn new_only_is_untouched() {
        let b = tmp("new-only");
        fs::create_dir_all(b.join(NEW_FOLDER)).unwrap();
        fs::write(b.join(NEW_FOLDER).join("shop.json"), b"n").unwrap();
        let r = real(&b);
        assert_eq!((r.dir, r.outcome), (b.join(NEW_FOLDER), Outcome::InUse));
    }

    #[test]
    fn both_with_empty_new_replaces_empty_with_legacy_data() {
        let b = tmp("both-empty-new");
        fs::create_dir_all(b.join(NEW_FOLDER)).unwrap();
        fs::create_dir_all(b.join(LEGACY_FOLDER)).unwrap();
        fs::write(b.join(LEGACY_FOLDER).join("passes.json"), b"P").unwrap();
        let r = real(&b);
        assert_eq!(r.outcome, Outcome::Renamed);
        assert_eq!(fs::read(r.dir.join("passes.json")).unwrap(), b"P");
    }

    #[test]
    fn both_with_new_holding_only_junk_keeps_legacy_as_canon_and_deletes_nothing() {
        let b = tmp("both-junk-new");
        fs::create_dir_all(b.join(NEW_FOLDER)).unwrap();
        fs::write(b.join(NEW_FOLDER).join("app-lock.json"), b"{}").unwrap();
        fs::create_dir_all(b.join(LEGACY_FOLDER)).unwrap();
        fs::write(b.join(LEGACY_FOLDER).join("tickets.json"), b"T").unwrap();
        let r = real(&b);
        assert_eq!(r.dir, b.join(LEGACY_FOLDER));
        assert_eq!(r.outcome, Outcome::Legacy(Why::NewHasNoData));
        assert!(b.join(NEW_FOLDER).join("app-lock.json").exists());
        assert_eq!(fs::read(b.join(LEGACY_FOLDER).join("tickets.json")).unwrap(), b"T");
    }

    #[test]
    fn both_with_legacy_empty_uses_new() {
        let b = tmp("both-legacy-empty");
        fs::create_dir_all(b.join(LEGACY_FOLDER)).unwrap();
        fs::create_dir_all(b.join(NEW_FOLDER)).unwrap();
        fs::write(b.join(NEW_FOLDER).join("shop.json"), b"S").unwrap();
        let r = real(&b);
        assert_eq!((r.dir, r.outcome), (b.join(NEW_FOLDER), Outcome::InUse));
        assert!(b.join(LEGACY_FOLDER).is_dir());
    }

    #[test]
    fn both_with_data_prefers_new_and_leaves_old_alone() {
        let b = tmp("both-data");
        for (n, v) in [(NEW_FOLDER, "N"), (LEGACY_FOLDER, "L")] {
            fs::create_dir_all(b.join(n)).unwrap();
            fs::write(b.join(n).join("shop.json"), v).unwrap();
        }
        let r = real(&b);
        assert_eq!((r.dir.clone(), r.outcome.clone()), (b.join(NEW_FOLDER), Outcome::BothHaveData));
        assert_eq!(fs::read_to_string(b.join(LEGACY_FOLDER).join("shop.json")).unwrap(), "L");
        assert_eq!(fs::read_to_string(b.join(NEW_FOLDER).join("shop.json")).unwrap(), "N");
        assert!(r.notice().unwrap()["message"].as_str().unwrap().contains("옛 폴더"));
        // 몇 번을 켜도 같다.
        assert_eq!(real(&b).outcome, Outcome::BothHaveData);
    }

    #[test]
    fn rename_refused_falls_back_without_touching_anything() {
        let b = tmp("rename-fail");
        let old = b.join(LEGACY_FOLDER);
        fs::create_dir_all(&old).unwrap();
        fs::write(old.join("shop.json"), b"S").unwrap();
        let denied = |_: &Path, _: &Path| Err(std::io::Error::new(std::io::ErrorKind::PermissionDenied, "in use"));
        let r = resolve_at(&b, &|_| false, &denied);
        assert_eq!(r.dir, old);
        assert!(matches!(r.outcome, Outcome::Legacy(Why::RenameFailed(_))));
        assert!(!b.join(NEW_FOLDER).exists());
        assert_eq!(fs::read(old.join("shop.json")).unwrap(), b"S");
        assert!(r.notice().is_some());
        // 다음 실행에서 거절이 풀리면 옮긴다.
        assert_eq!(real(&b).outcome, Outcome::Renamed);
    }

    #[test]
    fn rename_refused_after_removing_empty_new_still_leaves_legacy_usable() {
        let b = tmp("rename-fail-empty-new");
        fs::create_dir_all(b.join(NEW_FOLDER)).unwrap();
        fs::create_dir_all(b.join(LEGACY_FOLDER)).unwrap();
        fs::write(b.join(LEGACY_FOLDER).join("shop.json"), b"S").unwrap();
        let denied = |_: &Path, _: &Path| Err(std::io::Error::new(std::io::ErrorKind::PermissionDenied, "x"));
        let r = resolve_at(&b, &|_| false, &denied);
        assert_eq!(r.dir, b.join(LEGACY_FOLDER));
        assert_eq!(fs::read(r.dir.join("shop.json")).unwrap(), b"S");
    }

    #[test]
    fn running_program_inside_legacy_blocks_the_move() {
        let b = tmp("running");
        fs::create_dir_all(b.join(LEGACY_FOLDER)).unwrap();
        fs::write(b.join(LEGACY_FOLDER).join("shop.json"), b"S").unwrap();
        let r = resolve_at(&b, &|_| true, &|_, _| panic!("must not rename while running"));
        assert_eq!(r.outcome, Outcome::Legacy(Why::ProgramRunning));
        assert_eq!(r.dir, b.join(LEGACY_FOLDER));
    }

    #[test]
    fn process_line_matching_is_exact_about_folder_boundaries() {
        let d = Path::new("/u/Library/Application Support/PlayXRaven");
        assert!(line_mentions_dir("/u/Library/Application Support/PlayXRaven/run/ravend -x", d));
        assert!(line_mentions_dir(r"/u/Library/Application Support/PlayXRaven\run", d));
        assert!(!line_mentions_dir("/u/Library/Application Support/PlayXRaven2/run/ravend", d));
        assert!(!line_mentions_dir("/u/Library/Application Support/RavenVault/run/ravend", d));
        assert!(!line_mentions_dir("ravend", d));
    }

    #[cfg(unix)]
    #[test]
    fn symlinked_legacy_folder_is_renamed_as_a_link_and_data_stays_put() {
        let b = tmp("symlink");
        let elsewhere = tmp("symlink-target");
        fs::write(elsewhere.join("shop.json"), b"S").unwrap();
        std::os::unix::fs::symlink(&elsewhere, b.join(LEGACY_FOLDER)).unwrap();
        let r = real(&b);
        assert_eq!(r.outcome, Outcome::Renamed);
        assert_eq!(fs::read(r.dir.join("shop.json")).unwrap(), b"S");
        assert_eq!(fs::read(elsewhere.join("shop.json")).unwrap(), b"S");
    }

    #[test]
    fn stored_old_paths_are_rebased_on_read() {
        let old = Path::new("/a/PlayXRaven");
        let new = Path::new("/a/RavenVault");
        assert_eq!(rebase_path_str("/a/PlayXRaven/backups/2026", old, new), "/a/RavenVault/backups/2026");
        assert_eq!(rebase_path_str("/a/PlayXRaven2/x", old, new), "/a/PlayXRaven2/x");
        assert_eq!(rebase_path_str("/a/PlayXRaven/x", old, old), "/a/PlayXRaven/x");
        assert_eq!(rebase_path_str("/usb/RavenVault-1", old, new), "/usb/RavenVault-1");
    }

    #[test]
    fn this_module_has_no_recursive_delete() {
        let src = include_str!("app_dir_move.rs");
        let code = src.split("#[cfg(test)]").next().unwrap();
        assert!(!code.contains(concat!("remove_dir", "_all")));
    }
}
