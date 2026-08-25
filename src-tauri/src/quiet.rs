//! 윈도우에서 **검은 창이 깜빡이지 않게** 명령을 돌린다.
//!
//! ## 무엇이 문제였나 (사장 신고 2026-08-26)
//!
//! > 「윈도우가 계속 깜빡거리면서 뭔가 프로그램을 실행시키고 있다」
//!
//! 우리 앱이었다. 윈도우에서 `Command` 로 콘솔 프로그램을 띄우면 **매번 검은
//! 창이 떴다 사라진다.** 그리고 우리는 그걸 자주 한다:
//!
//! - `services_status()` 는 한 번에 `where ravend` 를 두 번, `where ipfs` 를
//!   두 번 돌린다 (`installed` 와 `path` 를 따로 물어서 그렇다)
//! - 그 상태를 화면이 주기적으로 다시 묻는다
//!
//! 그래서 계산대 화면 위로 검은 창이 몇 초마다 번쩍였다. 사장은 「바이러스인가」
//! 하고 앱을 지운다. 기능이 멀쩡해도 그렇게 된다.
//!
//! 노드를 띄우는 자리에만 `CREATE_NO_WINDOW` 를 걸어 뒀고 **나머지는 전부
//! 맨몸이었다.** 한 곳에서만 막으면 다음에 새로 짜는 사람이 또 빠뜨린다.
//! 그래서 여기 한 군데로 모은다.

/// 창을 안 띄우는 `Command`.
///
/// 맥·리눅스에서는 그냥 `Command::new` 와 같다 — 거기서는 애초에 창이 안 뜬다.
pub fn cmd(program: impl AsRef<std::ffi::OsStr>) -> std::process::Command {
    let mut c = std::process::Command::new(program);
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        // CREATE_NO_WINDOW. 콘솔 프로그램이지만 창은 안 만든다.
        c.creation_flags(0x0800_0000);
    }
    c
}

#[cfg(test)]
mod tests {
    /// 창을 숨겨도 **결과는 그대로 와야 한다.** 숨기려다 출력을 잃으면
    /// 그게 더 나쁘다 — 노드를 못 찾는데 못 찾은 줄도 모르게 된다.
    #[test]
    fn 숨겨도_출력은_온다() {
        let out = super::cmd(if cfg!(windows) { "cmd" } else { "echo" })
            .args(if cfg!(windows) { vec!["/C", "echo", "산다"] } else { vec!["산다"] })
            .output()
            .expect("돌아야 한다");
        assert!(String::from_utf8_lossy(&out.stdout).contains("산다"));
    }
}
