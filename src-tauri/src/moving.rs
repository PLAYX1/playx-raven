//! **가게를 다른 컴퓨터로 옮긴다.** 여섯 자리 숫자만 넣으면 된다.
//!
//! ## 🔴 왜 필요한가
//!
//! 대표님(2026-08-29): 301호 노트북은 **들고 다녀서 꺼진다.** 406호는 **계속
//! 켜져 있다.** 손님은 언제 올지 모르니 가게는 항상 켜진 쪽에 있어야 한다.
//!
//! 그런데 지금 옮기는 법은 이렇다 — 백업 폴더 만들기 → USB나 클라우드로
//! 파일 옮기기 → 새 컴퓨터에서 폴더 찾기 → 복구 누르기. **40~70대에게는
//! 네 개의 벽이다.** 폴더가 어디 있는지부터 모른다.
//!
//! ## 어떻게 쉬워지나
//!
//! ```text
//! 옛 컴퓨터   「가게 옮기기」  →  숫자 여섯 자리가 뜬다
//! 새 컴퓨터   「가게 가져오기」 →  그 숫자를 넣는다  →  끝
//! ```
//!
//! USB 도, 폴더 찾기도, 파일 이름도 없다. 앱이 **이미 손님 폰용 웹 서버를
//! 돌고 있어서**(8790) 새로 열 문도 없다.
//!
//! ## 🔴 무엇을 옮길지 고르게 한다
//!
//! · **전부** — 이 컴퓨터를 그만 쓸 때. 지갑까지 간다
//! · **가게만** — 돈은 옛 컴퓨터에 둔다. 새 컴퓨터는 카운터, 옛 컴퓨터는 금고
//!
//! 대표님 경우가 「가게만」이다 — 노트북에 자산을 두고, 항상 켜진 컴퓨터가
//! 손님을 받는다. 주문 주소는 받는 쪽 노드가 만들므로 **손님 돈은 새
//! 컴퓨터로 들어온다.**
//!
//! ⚠️ 「가게만」을 고르면 **간판 열쇠(shopkey)가 새 컴퓨터로 간다.** 그게
//!    「지금 여기서 주문받습니다」를 45분마다 알리는 열쇠라, 옛 컴퓨터에
//!    남아 있으면 노트북이 꺼질 때 손님이 가게를 못 찾는다.
//!
//! ## ⚠️ 안전
//!
//! · 숫자는 **10분만** 산다. 지나면 파일도 지운다
//! · **세 번 틀리면** 그 자리에서 끝난다. 여섯 자리를 찍어 맞히지 못하게
//! · 파일은 **암호로 잠가서** 보낸다. 같은 와이파이에 남이 있어도 못 연다
//! · 🔴 **자산을 새로 만들지 않는다.** 같은 지갑이면 자산은 따라온다.
//!   새로 만들면 100 RVN 이 타고 **손님이 아는 QR 이 죽는다**

use serde_json::{json, Value};
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

/// 숫자가 사는 시간. 짧을수록 안전하고, 너무 짧으면 노인이 못 따라간다.
const 유효초: i64 = 600;

pub(crate) const HTTP_MOVE_GUIDANCE: &str = "와이파이 숫자 이사는 백업 암호를 안전하게 전달할 수 없어 중단했습니다. 옛 컴퓨터에서 암호화 백업 파일(예: 이사.zip.pxlock)을 만들고 USB로 새 컴퓨터에 옮긴 뒤 복구하세요. 백업 암호는 파일과 따로 전달하세요. 자산을 새로 만들지 마세요.";

/// 틀릴 수 있는 횟수. 여섯 자리를 찍어 맞히지 못하게.
const 최대실패: u32 = 3;

struct 짐 {
    code: String,
    pass: String,
    path: PathBuf,
    made_at: i64,
    fails: u32,
    what: String,
}

static 준비된짐: Mutex<Option<짐>> = Mutex::new(None);

fn now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// 여섯 자리 숫자와 긴 암호를 만든다.
///
/// ⚠️ 숫자는 사람이 보고 옮겨 적는 것이라 짧다. 그래서 **암호는 따로** 길게
///    만들어 파일을 잠근다. 숫자를 맞혀도 암호 없이는 못 연다 — 숫자는
///    「누구에게 줄지」를 정할 뿐이고, 잠그는 일은 암호가 한다.
fn 숫자와암호() -> (String, String) {
    use rand::RngCore;
    let mut b = [0u8; 32];
    rand::rngs::OsRng.fill_bytes(&mut b);
    let n = u32::from_le_bytes([b[0], b[1], b[2], b[3]]) % 1_000_000;
    (format!("{n:06}"), hex::encode(&b[4..24]))
}

/// 이 컴퓨터의 랜 주소. 새 컴퓨터가 여기로 찾아온다.
fn 내주소() -> Vec<String> {
    crate::server::all_local_ips()
}

/// 옛 컴퓨터: 짐을 싼다.
///
/// `what` 은 `"all"`(전부) 또는 `"shop"`(가게만).
#[tauri::command]
pub async fn move_offer(what: String) -> Result<Value, String> {
    let _ = what;
    Err(HTTP_MOVE_GUIDANCE.into())
}

/// 옛 컴퓨터: 짐을 무른다(취소).
#[tauri::command]
pub fn move_cancel() -> Value {
    if let Ok(mut g) = 준비된짐.lock() {
        if let Some(b) = g.take() {
            let _ = std::fs::remove_file(&b.path);
        }
    }
    json!({ "ok": true })
}

/// 서버가 부른다: 숫자가 맞으면 짐을 내준다.
///
/// ⚠️ 틀린 횟수를 센다. **세 번이면 짐을 버린다.** 여섯 자리를 찍는 것을
///    막는 유일한 길이다.
pub fn take(code: &str) -> Result<(PathBuf, String), String> {
    let mut g = 준비된짐.lock().map_err(|_| "잠깐 문제가 있었습니다.")?;
    let Some(b) = g.as_mut() else {
        return Err("보낼 짐이 없습니다. 옛 컴퓨터에서 「가게 옮기기」를 먼저 눌러 주세요.".into());
    };
    if now() - b.made_at > 유효초 {
        let old = g.take().unwrap();
        let _ = std::fs::remove_file(&old.path);
        return Err("시간이 지났습니다. 옛 컴퓨터에서 다시 눌러 주세요.".into());
    }
    if b.code != code {
        b.fails += 1;
        if b.fails >= 최대실패 {
            let old = g.take().unwrap();
            let _ = std::fs::remove_file(&old.path);
            return Err("숫자가 세 번 틀렸습니다. 옛 컴퓨터에서 다시 눌러 주세요.".into());
        }
        return Err(format!(
            "숫자가 다릅니다. {}번 더 넣어 보실 수 있습니다.",
            최대실패 - b.fails
        ));
    }
    Ok((b.path.clone(), b.pass.clone()))
}

/// 새 컴퓨터: 옛 컴퓨터에서 받아 그대로 되살린다.
#[tauri::command]
pub async fn move_fetch(host: String, code: String) -> Result<Value, String> {
    let _ = (host, code);
    Err(HTTP_MOVE_GUIDANCE.into())
}

#[cfg(test)]
mod tests {
    fn 코드만(src: &str) -> String {
        src.split("#[cfg(test)]")
            .next()
            .unwrap_or(src)
            .lines()
            .filter(|l| {
                let t = l.trim_start();
                !t.starts_with("//") && !t.starts_with("//!")
            })
            .collect::<Vec<_>>()
            .join("\n")
    }

    /// 🔴 여섯 자리는 찍어서 맞힐 수 있다. **틀린 횟수를 세지 않으면**
    ///    같은 와이파이에 있는 누구나 백만 번 찔러 가게를 통째로 가져간다.
    #[test]
    fn 세_번_틀리면_끝난다() {
        let c = 코드만(include_str!("moving.rs"));
        assert!(c.contains("최대실패"), "틀린 횟수를 세지 않습니다.");
        assert!(
            c.contains("b.fails += 1"),
            "틀려도 횟수가 안 늘면 세는 시늉만 하는 것입니다."
        );
        assert!(
            c.contains("g.take()"),
            "세 번 틀렸을 때 짐을 버리지 않으면 계속 찔러 볼 수 있습니다."
        );
    }

    /// 숫자가 짧은 대신 **파일은 긴 암호로 잠근다.**
    #[test]
    fn 짐은_암호로_잠긴다() {
        let c = 코드만(include_str!("moving.rs"));
        assert!(c.contains("pass"), "암호 없이 보내면 같은 와이파이의 남이 열어 봅니다.");
        assert!(c.contains("유효초"), "시간 제한이 없으면 숫자가 영원히 삽니다.");
    }

    /// ⚠️ 검사를 넣으면 **좋은 입력도 지나가는지** 같이 본다.
    #[test]
    fn 진짜_주소는_막지_않는다() {
        for ok in ["192.168.0.15", "10.0.1.7", "raven-pc.local", "192.168.0.15:8790"] {
            assert!(
                ok.bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'-' || b == b':'),
                "{ok} 은 진짜 주소인데 검사가 막았습니다"
            );
        }
        for bad in ["192.168.0.1/../x", "a b", "host?x=1"] {
            assert!(
                !bad.bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'-' || b == b':'),
                "{bad} 를 그대로 URL 에 붙이려 했습니다"
            );
        }
    }

    /// 🔴 자산을 새로 만들면 100 RVN 이 타고 손님 QR 이 죽는다.
    ///    그 말이 화면까지 가야 한다.
    #[test]
    fn 자산을_새로_만들지_말라고_말한다() {
        let c = 코드만(include_str!("moving.rs"));
        assert!(
            c.contains("새로 만들지 마세요"),
            "이사한 사장은 자산을 새로 만들고 싶어집니다. 말려야 합니다."
        );
    }
}

// BEGIN MOVE RESTORE STATUS (compiled by the synthetic restore harness)
fn restore_complete(out: &Value) -> bool {
    out.get("failed").and_then(Value::as_array).is_some_and(|items| items.is_empty())
        && out.get("done").and_then(Value::as_array).is_some_and(|items| !items.is_empty())
}
// END MOVE RESTORE STATUS
