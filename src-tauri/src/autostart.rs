//! 컴퓨터를 켜면 이 프로그램이 저절로 뜨게 한다.
//!
//! 🔴 **이게 없으면 나머지가 전부 무의미해지는 날이 온다.** 가게 컴퓨터는
//! 정전으로도 꺼지고, 업데이트로도 꺼지고, 청소하다 코드를 뽑아도 꺼진다.
//! 그때 QR 이 죽는데, 70대 사장은 되살릴 방법이 없다 — 프로그램을 다시
//! 여는 것이 답인 줄 모르기 때문이다. 실측: 로그인 항목에 없었다.
//!
//! macOS 의 정식 방법은 `~/Library/LaunchAgents` 에 plist 를 두는 것이다.
//! 로그인할 때 launchd 가 이 폴더를 스스로 읽으므로 `launchctl` 을 부를
//! 필요가 없다 — 부르면 **지금 떠 있는 것 위에 하나 더** 뜬다.
//!
//! 의존성을 새로 들이지 않는다. plist 는 글자 파일이고 우리가 쓰면 된다.

use std::path::PathBuf;

/// 이 프로그램을 가리키는 이름. 지우고 켜는 것을 이 이름으로 찾는다.
const LABEL: &str = "se.erci.playxraven";

/// plist 가 들어갈 폴더.
///
/// 시험이 대표님의 진짜 로그인 항목을 건드리면 안 되므로 환경변수로
/// 갈아끼울 수 있게 둔다 — `paths.rs` 의 `PLAYX_RAVEN_HOME` 과 같은 방식이다.
fn agents_dir() -> PathBuf {
    if let Ok(p) = std::env::var("PLAYX_RAVEN_LAUNCHAGENTS") {
        if !p.trim().is_empty() {
            return PathBuf::from(p);
        }
    }
    let home = crate::paths::home().to_string_lossy().to_string();
    PathBuf::from(home).join("Library/LaunchAgents")
}

fn agent_path() -> PathBuf {
    agents_dir().join(format!("{LABEL}.plist"))
}

/// 무엇을 열 것인가.
///
/// Tauri 앱은 **묶음(.app)째로** 열어야 한다. 안쪽 실행파일을 직접 부르면
/// 아이콘도 메뉴막대도 없이 뜬다. 그래서 실행파일에서 `.app` 까지 거슬러
/// 올라가 `open -a` 로 넘긴다. 개발 중처럼 묶음 밖에서 돌고 있으면 그때는
/// 실행파일을 그대로 쓴다.
fn launch_argv() -> Vec<String> {
    let exe = std::env::current_exe().unwrap_or_else(|_| PathBuf::from("/"));
    let mut p = exe.as_path();
    while let Some(parent) = p.parent() {
        if p.extension().map(|e| e == "app").unwrap_or(false) {
            return vec![
                "/usr/bin/open".into(),
                "-a".into(),
                p.to_string_lossy().to_string(),
            ];
        }
        p = parent;
    }
    vec![exe.to_string_lossy().to_string()]
}

fn plist_text() -> String {
    let args = launch_argv()
        .into_iter()
        // plist 는 XML 이다. 경로에 `&` 나 `<` 가 있으면 파일이 깨진다.
        .map(|a| {
            format!(
                "    <string>{}</string>",
                a.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;")
            )
        })
        .collect::<Vec<_>>()
        .join("\n");
    format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>{LABEL}</string>
  <key>ProgramArguments</key>
  <array>
{args}
  </array>
  <key>RunAtLoad</key>
  <true/>
</dict>
</plist>
"#
    )
}

/// 지금 켜져 있나.
#[tauri::command]
pub fn autostart_get() -> bool {
    agent_path().is_file()
}

/// 켜고 끈다. 켜는 것은 파일을 쓰는 일이고, 끄는 것은 지우는 일이다.
#[tauri::command]
pub fn autostart_set(on: bool) -> Result<bool, String> {
    if !cfg!(target_os = "macos") {
        return Err("이 컴퓨터에서는 아직 자동 시작을 켤 수 없습니다.".into());
    }
    let path = agent_path();
    if on {
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir)
                .map_err(|e| format!("로그인 항목 폴더를 만들지 못했습니다: {e}"))?;
        }
        std::fs::write(&path, plist_text())
            .map_err(|e| format!("자동 시작을 켜지 못했습니다: {e}"))?;
    } else if path.exists() {
        std::fs::remove_file(&path).map_err(|e| format!("자동 시작을 끄지 못했습니다: {e}"))?;
    }
    Ok(autostart_get())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 🔴 환경변수는 **프로세스 전역**이다. 시험 셋이 동시에 돌면서 서로의
    /// 폴더를 덮어써서 하나가 죽었다 — `paths.rs` 에 적어 둔 그 함정이다.
    static LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    /// 시험이 대표님의 진짜 `~/Library/LaunchAgents` 를 건드리면 안 된다.
    fn sandbox(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("playx-autostart-{name}"));
        let _ = std::fs::remove_dir_all(&d);
        std::env::set_var("PLAYX_RAVEN_LAUNCHAGENTS", &d);
        d
    }

    #[test]
    fn 켜면_파일이_생기고_끄면_사라진다() {
        let _g = LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let d = sandbox("toggle");
        assert!(!autostart_get(), "처음에는 꺼져 있어야 한다");
        autostart_set(true).unwrap();
        assert!(autostart_get(), "켜면 켜져 있다고 나와야 한다");
        assert!(d.join(format!("{LABEL}.plist")).is_file());
        autostart_set(false).unwrap();
        assert!(!autostart_get(), "끄면 꺼져 있다고 나와야 한다");
        let _ = std::fs::remove_dir_all(&d);
        std::env::remove_var("PLAYX_RAVEN_LAUNCHAGENTS");
    }

    /// 🔴 이 프로그램을 가리키지 않는 plist 는 켜져 있어도 아무 소용이 없다.
    #[test]
    fn plist_가_이_프로그램을_가리킨다() {
        let text = plist_text();
        assert!(text.contains("<key>RunAtLoad</key>"), "로그인 때 뜨라는 표시가 있어야 한다");
        assert!(text.contains(LABEL));
        let argv = launch_argv();
        assert!(!argv.is_empty());
        assert!(
            argv[0].starts_with('/'),
            "PATH 에 기대면 안 된다 — 로그인 때의 PATH 는 우리가 아는 그것이 아니다"
        );
    }

    /// 이미 켜져 있는데 또 켠다고 두 개가 되지는 않는다.
    #[test]
    fn 두_번_켜도_하나다() {
        let _g = LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let d = sandbox("twice");
        autostart_set(true).unwrap();
        autostart_set(true).unwrap();
        let n = std::fs::read_dir(&d).unwrap().count();
        assert_eq!(n, 1, "plist 는 하나여야 한다");
        let _ = std::fs::remove_dir_all(&d);
        std::env::remove_var("PLAYX_RAVEN_LAUNCHAGENTS");
    }
}
