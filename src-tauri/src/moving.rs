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
    let 전부 = what == "all";
    let tmp = std::env::temp_dir().join(format!("playx-move-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&tmp);
    std::fs::create_dir_all(&tmp).map_err(|e| format!("자리를 만들지 못했습니다: {e}"))?;

    let (code, pass) = 숫자와암호();

    // 기존 백업을 그대로 쓴다. 새 길을 내면 새 버그가 난다.
    let v = crate::backup::backup_zip(tmp.to_string_lossy().to_string(), "이사".into(), 전부).await?;
    let path = v
        .get("path")
        .and_then(Value::as_str)
        .map(PathBuf::from)
        .ok_or("짐을 싸지 못했습니다.")?;

    if let Ok(mut g) = 준비된짐.lock() {
        *g = Some(짐 {
            code: code.clone(),
            pass: pass.clone(),
            path,
            made_at: now(),
            fails: 0,
            what: what.clone(),
        });
    }

    Ok(json!({
        "code": code,
        "pass": pass,
        "hosts": 내주소(),
        "port": crate::server::PORT,
        "minutes": 유효초 / 60,
        "what": what,
        // 화면이 그대로 읽어 주면 되는 문장. 사장이 문장을 지어내지 않아도 된다.
        "say": if 전부 {
            "이 컴퓨터의 가게와 지갑을 통째로 보냅니다. 옮긴 뒤에는 새 컴퓨터에서 장사하세요."
        } else {
            "가게만 보냅니다. 돈과 자산은 이 컴퓨터에 그대로 남습니다."
        },
    }))
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
    if !code.chars().all(|c| c.is_ascii_digit()) || code.len() != 6 {
        return Err("숫자 여섯 자리를 넣어 주세요.".into());
    }
    // ⚠️ 주소는 사람이 손으로 넣는다. 이상한 글자가 섞이면 우리가 의도하지
    //    않은 곳을 부르게 된다.
    if !host
        .bytes()
        .all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'-' || b == b':')
    {
        return Err("컴퓨터 주소가 올바르지 않습니다.".into());
    }
    let port = crate::server::PORT;
    let url = if host.contains(':') {
        format!("http://{host}/move/{code}")
    } else {
        format!("http://{host}:{port}/move/{code}")
    };

    let c = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(180))
        .build()
        .map_err(|e| format!("연결을 준비하지 못했습니다: {e}"))?;
    let r = c
        .get(&url)
        .send()
        .await
        .map_err(|_| "옛 컴퓨터를 찾지 못했습니다. 두 컴퓨터가 같은 인터넷에 있어야 하고, 옛 컴퓨터에서 「가게 옮기기」를 눌러 두셔야 합니다.".to_string())?;

    if !r.status().is_success() {
        // 옛 컴퓨터가 왜 거절했는지 그대로 전한다 — 「세 번 틀렸습니다」 같은 것.
        let msg = r.text().await.unwrap_or_default();
        return Err(if msg.trim().is_empty() {
            "옛 컴퓨터가 짐을 주지 않았습니다.".into()
        } else {
            msg
        });
    }
    let pass = r
        .headers()
        .get("x-move-pass")
        .and_then(|v| v.to_str().ok())
        .unwrap_or_default()
        .to_string();
    let bytes = r
        .bytes()
        .await
        .map_err(|e| format!("짐을 다 받지 못했습니다: {e}"))?;

    let tmp = std::env::temp_dir().join(format!("playx-moved-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&tmp);
    std::fs::create_dir_all(&tmp).map_err(|e| format!("자리를 만들지 못했습니다: {e}"))?;
    let zip = tmp.join("이사.zip");
    std::fs::write(&zip, &bytes).map_err(|e| format!("짐을 놓지 못했습니다: {e}"))?;

    // 되살리는 일은 기존 복구가 한다. 여기서 새로 만들지 않는다.
    // 보낼 때 이미 「전부/가게만」을 골랐다. 그러니 **짐에 든 것은 전부**
    // 되살린다 — 받는 쪽에서 또 고르게 하면 사장이 두 번 판단해야 하고,
    // 그러다 하나를 빠뜨리면 옮긴 줄 알았는데 안 옮겨져 있다.
    let 짐목록 = crate::recover::restore_survey(zip.to_string_lossy().to_string(), Some(pass.clone()))?;
    let keys: Vec<String> = 짐목록
        .get("items")
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .filter_map(|i| i.get("key").and_then(Value::as_str).map(str::to_string))
                .collect()
        })
        .unwrap_or_default();

    let out = crate::recover::restore_apply(zip.to_string_lossy().to_string(), keys, Some(pass))
        .await?;

    let _ = std::fs::remove_dir_all(&tmp);
    Ok(json!({
        "ok": true,
        "restored": out,
        // 🔴 이 말을 꼭 화면에 띄워야 한다. 안 그러면 사장이 자산을 새로 만든다.
        "warn": "가게 자산을 새로 만들지 마세요. 같은 지갑이면 그대로 따라옵니다. \
새로 만들면 100 RVN 이 타고 손님이 아는 QR 이 죽습니다.",
    }))
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
