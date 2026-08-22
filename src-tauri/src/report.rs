//! 문제 알리기 — 사장이 겪은 것을 그대로 보낸다.
//!
//! ## 왜 러스트에서 보내나
//!
//! 화면(webview)에서 바로 `fetch` 해도 되기는 한다. 그런데 두 가지가 안 된다:
//!
//! 1. **이 컴퓨터의 상태를 화면은 모른다.** 노드가 켜져 있는지, 판이 몇인지,
//!    어느 OS 인지 — 신고를 고치려면 그게 제일 필요한데 화면에는 없다.
//! 2. **인터넷이 끊기면 신고가 사라진다.** 가게 와이파이는 자주 끊긴다.
//!    그리고 신고를 하는 순간은 대개 **뭔가 잘못돼 있는 순간**이라,
//!    그때 인터넷도 같이 나가 있을 확률이 오히려 높다.
//!
//! 그래서 못 보내면 **파일에 쌓아 두고 다음에 켤 때 다시 보낸다.**
//! 한 번 보내고 마는 신고는 안 하느니만 못하다 — 사장은 보냈다고 여긴다.
//!
//! ## 🔴 절대 담지 않는 것
//!
//! **지갑 12단어·개인키·AI 열쇠·지갑 파일.** 신고 하나 편하자고 그걸 보내면
//! 이 프로그램이 여태 지켜 온 것이 한 줄로 무너진다.
//! 여기서 담는 것은 "무엇이 켜져 있나" 뿐이고, **주소도 잔액도 담지 않는다.**

use serde_json::{json, Value};
use std::path::PathBuf;

/// 신고가 가는 곳. 웹 지갑·장터와 **같은 상자**다 —
/// 상자가 둘이면 한 곳은 반드시 안 보게 된다.
const ENDPOINT: &str = "https://rvn.ex.erci.se/api/bug-reports";

/// 못 보낸 신고를 쌓아 두는 곳. 다음에 켤 때 다시 보낸다.
fn queue_file() -> PathBuf {
    crate::paths::app_dir().join("보내지못한신고.jsonl")
}

/// 이 컴퓨터의 형편. **고치는 데 필요한 것만.**
fn machine() -> Value {
    json!({
        "surface": "desktop",
        "version": env!("CARGO_PKG_VERSION"),
        "os": std::env::consts::OS,
        "arch": std::env::consts::ARCH,
    })
}

/// 한 건 보낸다. 성공하면 `true`.
async fn post_once(payload: &Value) -> bool {
    match reqwest::Client::new()
        .post(ENDPOINT)
        .json(payload)
        .timeout(std::time::Duration::from_secs(20))
        .send()
        .await
    {
        Ok(r) => r.status().is_success(),
        Err(_) => false,
    }
}

/// 못 보낸 것을 파일 끝에 한 줄로 붙인다.
fn park(payload: &Value) {
    use std::io::Write;
    let p = queue_file();
    if let Some(dir) = p.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&p) {
        let _ = writeln!(f, "{payload}");
    }
}

/// 화면이 부른다. **못 보내도 오류를 던지지 않는다** —
/// 사장 입장에서는 적어서 눌렀으면 그걸로 끝이어야 한다.
/// 다만 "지금 갔는지 / 쌓아 뒀는지" 는 정직하게 알려 준다.
#[tauri::command]
pub async fn report_send(
    title: String,
    description: String,
    category: String,
    screen: String,
    context: Option<Value>,
) -> Result<Value, String> {
    let desc = description.trim();
    if desc.is_empty() {
        return Err("무엇이 잘못됐는지 한 줄만 적어 주세요.".into());
    }

    // 화면이 보낸 것 위에 이 컴퓨터의 형편을 얹는다.
    let mut ctx = context.unwrap_or_else(|| json!({}));
    if let Some(o) = ctx.as_object_mut() {
        if let Some(m) = machine().as_object() {
            for (k, v) in m {
                o.insert(k.clone(), v.clone());
            }
        }
        o.insert("screen".into(), json!(screen));
        // 🔴 서버가 app_key 를 다시 계산한다. 이 둘이 없으면 데스크톱 신고가
        //    전부 메인 홈으로 섞여 들어간다.
        o.insert("pathname".into(), json!("/rvn"));
        o.insert("host".into(), json!("rvn.ex.erci.se"));
    }

    let payload = json!({
        // 제목을 따로 묻지 않는다. 두 칸을 채우라고 하면 안 적는다.
        "title": format!("[프로그램] {}", desc.chars().take(60).collect::<String>()),
        "description": desc,
        "category": category,
        "page_url": "https://rvn.ex.erci.se/rvn",
        "device_info": format!("PLAY X Raven {} · {} {}",
            env!("CARGO_PKG_VERSION"), std::env::consts::OS, std::env::consts::ARCH),
        "context": ctx,
    });

    if post_once(&payload).await {
        Ok(json!({ "sent": true }))
    } else {
        park(&payload);
        Ok(json!({ "sent": false, "parked": true }))
    }
}

/// 켤 때 한 번 부른다. 쌓아 둔 것을 다시 보낸다.
///
/// ⚠️ 보낸 것만 지운다. 통째로 지우면 인터넷이 반쯤 되는 상태에서
/// 신고가 조용히 사라진다.
#[tauri::command]
pub async fn report_flush() -> Value {
    let p = queue_file();
    let Ok(text) = std::fs::read_to_string(&p) else {
        return json!({ "sent": 0, "left": 0 });
    };
    let mut sent = 0usize;
    let mut left: Vec<String> = Vec::new();
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let Ok(v) = serde_json::from_str::<Value>(line) else {
            continue; // 깨진 줄은 버린다. 되살릴 방법이 없다.
        };
        if post_once(&v).await {
            sent += 1;
        } else {
            left.push(line.to_string());
        }
    }
    if left.is_empty() {
        let _ = std::fs::remove_file(&p);
    } else {
        let _ = std::fs::write(&p, left.join("\n") + "\n");
    }
    json!({ "sent": sent, "left": left.len() })
}

/// 쌓인 것이 몇 건인지. 화면이 "아직 못 보낸 신고 N건" 을 말할 수 있게.
#[tauri::command]
pub fn report_parked() -> usize {
    std::fs::read_to_string(queue_file())
        .map(|t| t.lines().filter(|l| !l.trim().is_empty()).count())
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 🔴 신고에 열쇠나 12단어가 섞이면 그건 사고다. 이 파일이 그런 값을
    /// 읽는 코드를 아예 갖지 않게 못 박아 둔다.
    #[test]
    fn a_report_never_carries_secrets() {
        let src = include_str!("report.rs");
        let code = src.split("#[cfg(test)]").next().unwrap_or("");
        for bad in ["mnemonic", "seed", "privkey", "wallet.dat", "api_key", "dumpprivkey"] {
            assert!(!code.contains(bad), "신고 코드가 '{bad}' 를 만진다");
        }
    }

    /// 못 보낸 신고는 **남아 있어야** 한다. 사장은 보냈다고 여긴다.
    #[test]
    fn unsent_reports_are_parked_not_dropped() {
        let src = include_str!("report.rs");
        let code = src.split("#[cfg(test)]").next().unwrap_or("");
        assert!(code.contains("park(&payload)"), "못 보낸 신고를 쌓아 두지 않는다");
        assert!(code.contains("left.join"), "다시 보낼 때 실패한 것을 되돌려 놓지 않는다");
    }

    /// 서버가 app_key 를 pathname·host 로 다시 계산한다.
    /// 둘이 빠지면 데스크톱 신고가 전부 메인 홈으로 섞인다.
    #[test]
    fn the_report_says_which_app_it_came_from() {
        let src = include_str!("report.rs");
        let code = src.split("#[cfg(test)]").next().unwrap_or("");
        assert!(code.contains(r#""pathname".into(), json!("/rvn")"#));
        assert!(code.contains(r#""host".into(), json!("rvn.ex.erci.se")"#));
    }
}
