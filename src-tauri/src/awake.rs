//! 가게 컴퓨터가 잠들지 않게 붙잡는다.
//!
//! ## 왜 이게 필요한가
//!
//! 노드를 앱에서 떼어 놓는 일은 끝냈다(`services.rs`). 그런데 **프로세스를
//! 아무리 잘 떼어 놔도 컴퓨터가 잠들면 노드가 멈춘다.** 맥은 기본이 몇 분 뒤
//! 잠자기고, 윈도우 노트북은 뚜껑을 덮으면 잔다.
//!
//! 사장님이 밤에 문 닫고 가면, 아침까지 들어온 입금이 확인되지 않는다.
//! 손님은 보냈는데 가게는 못 받은 것으로 안다. 그게 이 파일이 있는 이유다.
//!
//! ## 🔴 늘 막지는 않는다
//!
//! 이 프로그램은 장사를 안 하는 사람도 돌린다 — 그냥 노드를 하나 더 세워
//! 주는 사람이다. 그 사람의 노트북까지 못 자게 만들면 **밤새 배터리가 닳는다.**
//! 넘치는 참견이고, 그런 프로그램은 지워진다.
//!
//! 그래서 **「장사」 모드일 때만** 붙잡는다(`mode.rs`). 그리고 붙잡고 있으면
//! 화면에 그렇게 적는다 — 전기를 쓰는 일을 몰래 하지 않는다.
//!
//! ## 세 시스템이 다 다르다
//!
//! | | 방법 | 화면은 |
//! |---|---|---|
//! | 맥 | `caffeinate -s` 를 자식으로 띄워 둔다 | 꺼져도 된다 |
//! | 윈도우 | `SetThreadExecutionState` | 꺼져도 된다 |
//! | 리눅스 | `systemd-inhibit` | 꺼져도 된다 |
//!
//! 셋 다 **화면은 꺼지되 시스템은 안 자게** 한다. 화면까지 켜 두면 가게가
//! 밤새 밝고, 그건 아무도 원하지 않는다.
//!
//! 윈도우는 크레이트를 안 들인다. 필요한 것은 `kernel32` 함수 하나뿐이고,
//! 12단어가 있는 프로그램에 공급망을 하나 더 들일 이유가 없다.

use serde_json::{json, Value};
use std::sync::Mutex;

/// 지금 붙잡고 있는 것. 맥·리눅스는 자식 프로세스, 윈도우는 표시만.
static HOLD: Mutex<Option<std::process::Child>> = Mutex::new(None);
/// 윈도우는 프로세스가 아니라 상태라, 따로 기억해야 화면에 말할 수 있다.
static ON: Mutex<bool> = Mutex::new(false);
/// 윈도우에서 붙잡는 스레드에게 「계속할까」를 알린다.
#[cfg(target_os = "windows")]
static WANT: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// 이 모드에서 컴퓨터를 붙잡아야 하나.
///
/// 갈림은 하나뿐이라 함수로 뺄 것도 없어 보이지만, **이 판단이 틀리면
/// 남의 노트북 배터리를 밤새 태운다.** 시험할 수 있게 떼어 둔다.
pub fn should_hold(mode: &str) -> bool {
    mode == "shop"
}

/// 「장사」면 붙잡고, 아니면 놓는다. 몇 번을 불러도 결과가 같다.
pub fn sync_with_mode() {
    let m = crate::mode::mode_get();
    let mode = m["mode"].as_str().unwrap_or("");
    if should_hold(mode) {
        hold();
    } else {
        release();
    }
}

fn hold() {
    if let Ok(g) = ON.lock() {
        // 이미 붙잡고 있으면 또 붙잡지 않는다. `caffeinate` 가 겹쳐 쌓이면
        // 놓을 때 하나만 죽어서 컴퓨터가 영영 안 잔다.
        if *g {
            return;
        }
    }
    #[cfg(target_os = "macos")]
    {
        // -s: 시스템이 자는 것만 막는다. -d(화면)는 안 쓴다 — 가게가 밤새
        //     밝으면 그건 고장으로 보인다.
        if let Ok(c) = std::process::Command::new("caffeinate")
            .arg("-s")
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
        {
            if let Ok(mut g) = HOLD.lock() {
                *g = Some(c);
            }
            mark(true);
        }
    }
    #[cfg(target_os = "windows")]
    {
        // 🔴 이 상태는 **부른 스레드에 붙는다.** 그 스레드가 끝나면 윈도우가
        //    바로 풀어 버린다. Tauri 명령은 스레드 풀에서 도니까, 거기서
        //    한 번 부르고 마는 코드는 **불렀지만 안 걸린다** — 화면에는
        //    「깨워 두는 중」이 뜨고 컴퓨터는 그냥 잔다.
        //
        //    그래서 붙잡는 동안 **살아 있는 스레드**를 하나 세운다. 그 스레드가
        //    상태를 걸고, 놓으라고 할 때까지 자다 깨다 하며 버틴다.
        WANT.store(true, std::sync::atomic::Ordering::SeqCst);
        std::thread::spawn(|| {
            // ES_CONTINUOUS(0x8000_0000) | ES_SYSTEM_REQUIRED(0x0000_0001)
            if !win_set(0x8000_0000 | 0x0000_0001) {
                mark(false);
                return;
            }
            mark(true);
            while WANT.load(std::sync::atomic::Ordering::SeqCst) {
                std::thread::sleep(std::time::Duration::from_secs(20));
            }
            // 이 스레드가 끝나면 어차피 풀리지만, 명시해 둔다.
            win_set(0x8000_0000);
            mark(false);
        });
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        // `sleep infinity` 를 붙잡고 있는 동안만 억제된다. 그 자식을 죽이면 풀린다.
        if let Ok(c) = std::process::Command::new("systemd-inhibit")
            .args([
                "--what=idle:sleep",
                "--who=PLAY X Raven",
                "--why=가게가 입금을 기다립니다",
                "sleep",
                "infinity",
            ])
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
        {
            if let Ok(mut g) = HOLD.lock() {
                *g = Some(c);
            }
            mark(true);
        }
    }
}

fn release() {
    if let Ok(mut g) = HOLD.lock() {
        if let Some(c) = g.as_mut() {
            let _ = c.kill();
            let _ = c.wait();
        }
        *g = None;
    }
    #[cfg(target_os = "windows")]
    {
        // 붙잡고 있는 스레드에게 그만하라고 말한다. 그 스레드가 상태를 푼다 —
        // 다른 스레드에서 풀어 봤자 **그 스레드 것만** 풀린다.
        WANT.store(false, std::sync::atomic::Ordering::SeqCst);
    }
    mark(false);
}

fn mark(v: bool) {
    if let Ok(mut g) = ON.lock() {
        *g = v;
    }
}

#[cfg(target_os = "windows")]
fn win_set(flags: u32) -> bool {
    // 크레이트를 들이지 않는다. 필요한 것은 이 함수 하나다.
    #[link(name = "kernel32")]
    extern "system" {
        fn SetThreadExecutionState(es_flags: u32) -> u32;
    }
    // 0 이면 실패다. 실패를 성공이라 적지 않는다 — 그 거짓말이 이 저장소에서
    // 가장 자주 나온 병이다.
    unsafe { SetThreadExecutionState(flags) != 0 }
}

/// 화면에 뭐라고 적을지. 전기를 쓰는 일을 몰래 하지 않는다.
#[tauri::command]
pub fn awake_status() -> Value {
    let on = ON.lock().map(|g| *g).unwrap_or(false);
    let mode = crate::mode::mode_get()["mode"].as_str().unwrap_or("").to_string();
    json!({
        "holding": on,
        "mode": mode,
        "note": if on {
            "이 컴퓨터가 잠들지 않게 하고 있습니다 — 밤새 들어온 입금을 받으려면 필요합니다."
        } else if should_hold(&mode) {
            "이 컴퓨터를 깨워 둘 수 없습니다. 잠들면 밤사이 입금 확인이 멈춥니다."
        } else {
            // 「돕기」인 사람에게 굳이 할 말이 아니다. 배터리는 그 사람 것이다.
            ""
        },
    })
}

#[cfg(test)]
mod tests {
    use super::should_hold;

    #[test]
    fn 장사만_붙잡는다() {
        assert!(should_hold("shop"));
    }

    /// 🔴 이게 이 파일에서 제일 중요한 시험이다. 여기가 틀리면 장사를 안
    ///    하는 사람의 노트북 배터리가 밤새 탄다.
    #[test]
    fn 돕기와_안_고른_사람은_안_건드린다() {
        assert!(!should_hold("help"), "돕는 사람의 배터리는 그 사람 것이다");
        assert!(!should_hold(""), "아직 안 고른 사람도 건드리지 않는다");
        assert!(!should_hold("SHOP"), "모르는 값에 기대서 켜지 않는다");
        assert!(!should_hold("shop "), "공백이 붙은 값도 아니다");
    }
}
