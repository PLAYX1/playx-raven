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
    let home = crate::paths::home();
    // 리눅스 데스크톱은 freedesktop 규칙을 쓴다. 맥과 자리도 파일 모양도 다르다.
    #[cfg(target_os = "linux")]
    {
        return home.join(".config/autostart");
    }
    #[allow(unreachable_code)]
    {
        home.join("Library/LaunchAgents")
    }
}

fn agent_path() -> PathBuf {
    #[cfg(target_os = "linux")]
    {
        return agents_dir().join("playx-raven.desktop");
    }
    #[allow(unreachable_code)]
    {
        agents_dir().join(format!("{LABEL}.plist"))
    }
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
    #[cfg(target_os = "windows")]
    {
        return win_key_present();
    }
    #[allow(unreachable_code)]
    {
        agent_path().is_file()
    }
}

/// 윈도우의 자동 시작 목록에 우리가 적혀 있나.
#[cfg(target_os = "windows")]
fn win_key_present() -> bool {
    crate::quiet::cmd("reg")
        .args([
            "query",
            r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run",
            "/v",
            LABEL_WIN,
        ])
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

#[cfg(target_os = "windows")]
const LABEL_WIN: &str = "PLAY X Raven";

/// 켜고 끈다.
///
/// ## 🔴 여태 **맥에서만** 됐다
///
/// 이 함수 첫 줄이 `if !cfg!(target_os = "macos") { return Err(...) }` 였다.
/// 그래서 윈도우·리눅스 사장이 설정에서 스위치를 켜면 「이 컴퓨터에서는
/// 아직 자동 시작을 켤 수 없습니다」가 떴다.
///
/// **그런데 윈도우 구현은 이미 있었다** — `health.rs::autostart_enable` 에
/// 레지스트리에 넣는 코드가 멀쩡히 들어 있고, 다른 화면에서 부르고 있었다.
/// 같은 일을 하는 함수가 두 벌이고, 설정 스위치는 **못 하는 쪽**을 불렀다.
///
/// 재부팅하면 안 돌아오는 프로그램은 **켜 둘 수가 없다.** 계산대 컴퓨터는
/// 정전 한 번이면 끝이고, 그날 밤 입금은 아무도 확인하지 않는다.
#[tauri::command]
pub fn autostart_set(on: bool) -> Result<bool, String> {
    #[cfg(target_os = "windows")]
    {
        let exe = std::env::current_exe()
            .map_err(|e| format!("이 프로그램의 자리를 찾지 못했습니다: {e}"))?;
        let mut c = crate::quiet::cmd("reg");
        if on {
            c.args([
                "add",
                r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run",
                "/v",
                LABEL_WIN,
                "/t",
                "REG_SZ",
                "/d",
                &exe.to_string_lossy(),
                "/f",
            ]);
        } else {
            c.args([
                "delete",
                r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run",
                "/v",
                LABEL_WIN,
                "/f",
            ]);
        }
        let out = c.output().map_err(|e| format!("자동 시작을 바꾸지 못했습니다: {e}"))?;
        // 끌 때 「없다」는 실패가 아니다. 이미 꺼져 있는 것뿐이다.
        if !out.status.success() && on {
            return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
        }
        return Ok(autostart_get());
    }

    #[cfg(target_os = "linux")]
    {
        // 리눅스 데스크톱의 공통 규칙(freedesktop). 파일 하나면 된다.
        let path = agent_path();
        if on {
            let exe = std::env::current_exe()
                .map_err(|e| format!("이 프로그램의 자리를 찾지 못했습니다: {e}"))?;
            if let Some(dir) = path.parent() {
                std::fs::create_dir_all(dir)
                    .map_err(|e| format!("자동 시작 폴더를 만들지 못했습니다: {e}"))?;
            }
            let body = format!(
                "[Desktop Entry]\nType=Application\nName=PLAY X Raven\n\
                 Exec={}\nX-GNOME-Autostart-enabled=true\nTerminal=false\n",
                exe.to_string_lossy()
            );
            std::fs::write(&path, body)
                .map_err(|e| format!("자동 시작을 켜지 못했습니다: {e}"))?;
        } else if path.exists() {
            std::fs::remove_file(&path).map_err(|e| format!("자동 시작을 끄지 못했습니다: {e}"))?;
        }
        return Ok(autostart_get());
    }

    #[cfg(target_os = "macos")]
    {
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
        return Ok(autostart_get());
    }

    #[allow(unreachable_code)]
    {
        let _ = on;
        Err("이 컴퓨터에서는 아직 자동 시작을 켤 수 없습니다.".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 🔴 여태 이 함수 첫 줄이 `if !cfg!(target_os = "macos") { return Err }`
    ///    였다. 윈도우·리눅스 사장이 스위치를 켜면 「이 컴퓨터에서는 아직
    ///    안 됩니다」가 떴다 — **윈도우 구현은 health.rs 에 멀쩡히 있었는데도.**
    ///
    ///    재부팅하면 안 돌아오는 프로그램은 켜 둘 수가 없다. 대표님이 원한
    ///    「카톡처럼 그냥 켜 두는 것」이 여기서 막혀 있었다.
    #[test]
    fn 세_운영체제에_다_길이_있다() {
        let src = include_str!("autostart.rs");
        let i = src.find("pub fn autostart_set").expect("함수가 있어야 한다");
        let end = src[i..].find("#[cfg(test)]").unwrap_or(src.len() - i);
        let body = &src[i..i + end];
        for os in ["windows", "linux", "macos"] {
            assert!(
                body.contains(&format!("target_os = \"{os}\"")),
                "{os} 에 자동 시작 길이 없다 — 그 컴퓨터는 재부팅하면 안 돌아온다"
            );
        }
        assert!(
            !body.starts_with("pub fn autostart_set(on: bool) -> Result<bool, String> {\n    if !cfg!"),
            "맥이 아니면 곧바로 거절하는 옛 모양으로 돌아갔다"
        );
    }

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
