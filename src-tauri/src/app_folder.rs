//! 앱 자료 폴더를 **이 사용자만** 열 수 있게 만든다(0700).
//!
//! 🔴 여기에는 AI 열쇠·회원 장부·문 비밀·개발비 장부가 있다. 폴더가 0755 로
//! 만들어져 있어서 같은 컴퓨터의 다른 계정이 전부 읽을 수 있었다. 안의 파일을
//! 하나하나 고치는 것보다 폴더 한 번이 확실하다 — 폴더를 못 열면 안의 파일
//! 권한과 상관없이 아무것도 못 읽는다. 나중에 새로 생기는 파일도 같다.
//!
//! `paths.rs` 는 통합 검사가 v0.3.8 그대로인지 보므로 여기 따로 둔다.

/// 앱이 켜질 때마다 부른다. 실패해도 앱은 계속 켜진다(권한 때문에 가게가
/// 안 열리면 그게 더 큰 사고다).
pub fn harden() {
    let dir = crate::paths::app_dir();
    harden_dir(&dir);
    // 옛 판은 복구 단어를 꺼낼 때 모든 개인키를 평문으로 이 파일에 썼다.
    // 그 사이 앱이 죽었으면 남아 있다. 보이면 지운다.
    let _ = std::fs::remove_file(dir.join(".seed.tmp"));
    // 코어 폴더(.cookie = 노드 조작 열쇠, wallet.dat). 있는 경우에만 잠근다 —
    // 없는 폴더를 여기서 만들면 코어 설치 흐름이 헷갈린다.
    let core = crate::paths::raven_dir();
    if core.is_dir() {
        harden_dir(&core);
    }
}

fn harden_dir(dir: &std::path::Path) {
    if std::fs::create_dir_all(dir).is_err() {
        return;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if let Ok(meta) = std::fs::metadata(dir) {
            if meta.permissions().mode() & 0o077 != 0 {
                let _ = std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700));
            }
        }
    }
}

#[cfg(test)]
mod tests {
    /// 다른 계정이 읽을 수 있던 앱 폴더를 켤 때 본인 전용으로 잠근다.
    #[cfg(unix)]
    #[test]
    fn the_app_folder_is_closed_to_other_accounts() {
        use std::os::unix::fs::PermissionsExt;
        let dir = std::env::temp_dir().join(format!("playx-raven-perm-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o755)).unwrap();
        super::harden_dir(&dir);
        let mode = std::fs::metadata(&dir).unwrap().permissions().mode() & 0o777;
        let _ = std::fs::remove_dir_all(&dir);
        assert_eq!(mode, 0o700, "다른 계정이 앱 폴더를 열 수 있다: {mode:o}");
    }
}
