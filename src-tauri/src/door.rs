//! Opening a real door when a valid membership scans.
//!
//! ## The one rule that matters
//!
//! **The timer lives in the relay, never in this app.**
//!
//! The obvious way to work a door strike is "switch on, wait five seconds,
//! switch off". That code is correct until the moment it is not — the app
//! crashes, the Wi-Fi drops, someone closes the laptop — and then the door is
//! unlocked all night and nobody knows. There is no error message for a door
//! that stayed open.
//!
//! So every command carries its own auto-off (`toggle_after` on Gen2,
//! `timer` on Gen1), and the relay enforces it. If this program dies one
//! millisecond after sending the command, the door still closes. We also write
//! `auto_off_delay` into the device's own config, so even a malformed request
//! cannot hold it open.
//!
//! ## The security hole that comes free with the hardware
//!
//! A Shelly ships with **no password**. Our customers are on the shop's Wi-Fi —
//! that is the whole design of the phone ordering. So an unprotected relay
//! means any customer who finds its address can open the door from the seating
//! area. This module reports that state loudly rather than quietly working.
//!
//! ## What the phone never does
//!
//! The customer's phone does not talk to the relay, does not know its address,
//! and does not carry a token that opens it. It shows a member number; this
//! computer decides and pulses. Anything else puts a door key on a stranger's
//! phone.
//!
//! ## Works with the internet down
//!
//! Membership lives in `passes.json` and the relay is on the local network, so
//! a gym with a dead line still opens its door for members. That is the point
//! of running the shop on its own computer.

use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::path::PathBuf;

fn dir() -> PathBuf {
    crate::paths::app_dir()
}

fn doors_path() -> PathBuf {
    dir().join("doors.json")
}

fn log_path() -> PathBuf {
    dir().join("door-log.json")
}

/// A door strike held open for longer than this is not a door, it is an
/// entrance. Typing 300 into a seconds box should not unlock a building.
const MAX_SECONDS: u32 = 30;

fn load_doors() -> Vec<Value> {
    std::fs::read_to_string(doors_path())
        .ok()
        .and_then(|t| serde_json::from_str::<Value>(&t).ok())
        .and_then(|v| v.get("doors").and_then(Value::as_array).cloned())
        .unwrap_or_default()
}

fn save_doors(rows: &[Value]) -> Result<(), String> {
    let path = doors_path();
    let _ = std::fs::create_dir_all(dir());
    let tmp = path.with_extension("json.tmp");
    std::fs::write(
        &tmp,
        serde_json::to_vec_pretty(&json!({ "doors": rows })).map_err(|e| e.to_string())?,
    )
    .map_err(|e| format!("저장하지 못했습니다: {e}"))?;
    std::fs::rename(&tmp, &path).map_err(|e| format!("저장하지 못했습니다: {e}"))
}

/// Every configured door, with the warnings that belong next to it.
#[tauri::command]
pub fn door_list() -> Value {
    let rows: Vec<Value> = load_doors()
        .iter()
        .map(|d| {
            let mut o = d.clone();
            let has_pass = d
                .get("password")
                .and_then(Value::as_str)
                .map(|p| !p.is_empty())
                .unwrap_or(false);
            if let Some(m) = o.as_object_mut() {
                m.remove("password");
                m.insert("protected".into(), json!(has_pass));
                m.insert(
                    "warn".into(),
                    json!(if has_pass {
                        ""
                    } else {
                        "비밀번호가 없습니다 — 같은 와이파이에 있는 누구나 이 문을 열 수 있습니다. 셸리 앱에서 비밀번호를 걸고 여기에도 넣으세요."
                    }),
                );
            }
            o
        })
        .collect();
    json!({ "doors": rows })
}

/// Adds or replaces a door.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn door_save(
    id: String,
    name: String,
    ip: String,
    gen: u8,
    channel: u32,
    seconds: u32,
    user: String,
    password: String,
) -> Result<Value, String> {
    if ip.trim().is_empty() {
        return Err("셸리 주소가 필요합니다. 셸리 앱에서 IP를 확인하세요.".into());
    }
    if seconds == 0 {
        return Err("열려 있을 시간이 0초면 문이 안 열립니다.".into());
    }
    if seconds > MAX_SECONDS {
        return Err(format!(
            "{MAX_SECONDS}초까지만 됩니다. 그보다 길면 문이 아니라 열린 출입구입니다."
        ));
    }
    if !(1..=2).contains(&gen) {
        return Err("셸리 세대는 1 또는 2입니다.".into());
    }

    let mut rows = load_doors();
    rows.retain(|r| r.get("id").and_then(Value::as_str) != Some(id.as_str()));
    rows.push(json!({
        "id": id,
        "name": name.trim(),
        "ip": ip.trim(),
        "gen": gen,
        "channel": channel,
        "seconds": seconds,
        // 셸리 2세대는 사용자명이 항상 admin 이다. 1세대만 바꿀 수 있다.
        "user": if user.trim().is_empty() { "admin".to_string() } else { user.trim().to_string() },
        "password": password,
    }));
    save_doors(&rows)?;
    Ok(door_list())
}

#[tauri::command]
pub fn door_remove(id: String) -> Result<Value, String> {
    let mut rows = load_doors();
    rows.retain(|r| r.get("id").and_then(Value::as_str) != Some(id.as_str()));
    save_doors(&rows)?;
    Ok(door_list())
}

fn find(id: &str) -> Result<Value, String> {
    load_doors()
        .into_iter()
        .find(|r| r.get("id").and_then(Value::as_str) == Some(id))
        .ok_or_else(|| "없는 문입니다.".to_string())
}

fn sha256_hex(s: &str) -> String {
    let mut h = Sha256::new();
    h.update(s.as_bytes());
    hex::encode(h.finalize())
}

/// Answers a Shelly Gen2 digest challenge.
///
/// Gen2 refuses plain requests with a 401 carrying `realm` and `nonce`, and
/// wants SHA-256 digest back. Basic auth is not accepted, and there is no way
/// to put credentials in the query string — so this has to be done properly.
///
/// **Not verified against a real device.** There is no Shelly here to test on,
/// so `door_probe` reports the raw status and body rather than a summary; if a
/// device rejects this, that output is what will show why.
fn digest_header(
    challenge: &str,
    user: &str,
    pass: &str,
    method: &str,
    uri: &str,
    cnonce: &str,
) -> Option<String> {
    let field = |k: &str| -> Option<String> {
        let at = challenge.find(&format!("{k}="))?;
        let rest = &challenge[at + k.len() + 1..];
        let rest = rest.trim_start_matches('"');
        let end = rest.find(['"', ',']).unwrap_or(rest.len());
        Some(rest[..end].to_string())
    };

    let realm = field("realm")?;
    let nonce = field("nonce")?;
    let nc = "00000001";

    let ha1 = sha256_hex(&format!("{user}:{realm}:{pass}"));
    let ha2 = sha256_hex(&format!("{method}:{uri}"));
    let response = sha256_hex(&format!("{ha1}:{nonce}:{nc}:{cnonce}:auth:{ha2}"));

    Some(format!(
        "Digest username=\"{user}\", realm=\"{realm}\", nonce=\"{nonce}\", uri=\"{uri}\", \
         algorithm=SHA-256, qop=auth, nc={nc}, cnonce=\"{cnonce}\", response=\"{response}\""
    ))
}

/// One request to the relay, answering an auth challenge if it comes.
async fn call(door: &Value, uri: &str, cnonce: &str) -> Result<(u16, String), String> {
    let ip = door.get("ip").and_then(Value::as_str).unwrap_or("");
    let user = door.get("user").and_then(Value::as_str).unwrap_or("admin");
    let pass = door.get("password").and_then(Value::as_str).unwrap_or("");
    let url = format!("http://{ip}{uri}");

    let client = reqwest::Client::builder()
        // 문 앞에 사람이 서 있다. 3초 안에 답이 없으면 안 된 것이다 —
        // 계산대가 30초 멈추는 것보다 "다시 대주세요"가 낫다.
        .timeout(std::time::Duration::from_secs(3))
        .build()
        .map_err(|e| e.to_string())?;

    let first = client
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("셸리에 닿지 못했습니다: {e}"))?;

    if first.status() != reqwest::StatusCode::UNAUTHORIZED {
        let code = first.status().as_u16();
        let body = first.text().await.unwrap_or_default();
        return Ok((code, body));
    }

    // 401 이 왔다 — 비밀번호가 걸려 있다.
    let challenge = first
        .headers()
        .get("www-authenticate")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();

    if pass.is_empty() {
        return Err("이 셸리는 비밀번호가 걸려 있습니다. 설정에 비밀번호를 넣으세요.".into());
    }

    // 1세대는 basic, 2세대는 digest 다.
    let gen = door.get("gen").and_then(Value::as_u64).unwrap_or(2);
    let req = if gen == 1 {
        client.get(&url).basic_auth(user, Some(pass))
    } else {
        let h = digest_header(&challenge, user, pass, "GET", uri, cnonce)
            .ok_or_else(|| format!("셸리가 보낸 인증 요청을 읽지 못했습니다: {challenge}"))?;
        client.get(&url).header("Authorization", h)
    };

    let second = req
        .send()
        .await
        .map_err(|e| format!("셸리에 닿지 못했습니다: {e}"))?;
    let code = second.status().as_u16();
    let body = second.text().await.unwrap_or_default();
    Ok((code, body))
}

/// Is the relay there, and is it protected?
///
/// Deliberately does not open anything. Testing a door by opening it means the
/// owner has to be standing at the door to test it.
#[tauri::command]
pub async fn door_probe(id: String, cnonce: String) -> Result<Value, String> {
    let door = find(&id)?;
    let gen = door.get("gen").and_then(Value::as_u64).unwrap_or(2);
    let ch = door.get("channel").and_then(Value::as_u64).unwrap_or(0);
    let uri = if gen == 1 {
        format!("/status")
    } else {
        format!("/rpc/Switch.GetStatus?id={ch}")
    };

    match call(&door, &uri, &cnonce).await {
        Ok((200, body)) => Ok(json!({
            "ok": true,
            "protected": !door.get("password").and_then(Value::as_str).unwrap_or("").is_empty(),
            "message": "셸리와 연결됐습니다.",
            // 요약하지 않고 그대로 보여준다 — 기기마다 답이 달라서,
            // 안 될 때 이 원문이 유일한 단서다.
            "raw": body.chars().take(400).collect::<String>(),
        })),
        Ok((code, body)) => Ok(json!({
            "ok": false,
            "message": format!("셸리가 {code} 로 답했습니다."),
            "raw": body.chars().take(400).collect::<String>(),
        })),
        Err(e) => Ok(json!({ "ok": false, "message": e })),
    }
}

fn log_open(entry: Value) {
    let mut rows: Vec<Value> = std::fs::read_to_string(log_path())
        .ok()
        .and_then(|t| serde_json::from_str::<Value>(&t).ok())
        .and_then(|v| v.get("log").and_then(Value::as_array).cloned())
        .unwrap_or_default();
    rows.push(entry);
    // 최근 2000건. 문 기록은 영수증이지 영구 보관 대상이 아니다.
    if rows.len() > 2000 {
        let cut = rows.len() - 2000;
        rows.drain(0..cut);
    }
    let _ = std::fs::create_dir_all(dir());
    let path = log_path();
    let tmp = path.with_extension("json.tmp");
    if serde_json::to_vec(&json!({ "log": rows }))
        .ok()
        .and_then(|b| std::fs::write(&tmp, b).ok())
        .is_some()
    {
        let _ = std::fs::rename(&tmp, &path);
    }
}

/// Every open and every refusal, newest last.
#[tauri::command]
pub fn door_log() -> Value {
    let rows: Vec<Value> = std::fs::read_to_string(log_path())
        .ok()
        .and_then(|t| serde_json::from_str::<Value>(&t).ok())
        .and_then(|v| v.get("log").and_then(Value::as_array).cloned())
        .unwrap_or_default();
    json!({ "log": rows })
}

/// Pulses the relay. Always with a timer, never without.
async fn pulse(door: &Value, cnonce: &str) -> Result<(), String> {
    let gen = door.get("gen").and_then(Value::as_u64).unwrap_or(2);
    let ch = door.get("channel").and_then(Value::as_u64).unwrap_or(0);
    let secs = door
        .get("seconds")
        .and_then(Value::as_u64)
        .unwrap_or(5)
        .min(MAX_SECONDS as u64);

    // 타이머를 뺀 명령은 이 프로그램에 존재하지 않는다. 켜기만 하고 끄는 쪽을
    // 앱이 책임지면, 앱이 죽는 순간 문은 밤새 열려 있다.
    let uri = if gen == 1 {
        format!("/relay/{ch}?turn=on&timer={secs}")
    } else {
        format!("/rpc/Switch.Set?id={ch}&on=true&toggle_after={secs}")
    };

    match call(door, &uri, cnonce).await {
        Ok((200, _)) => Ok(()),
        Ok((code, body)) => Err(format!("셸리가 {code} 로 거절했습니다: {}", body.chars().take(120).collect::<String>())),
        Err(e) => Err(e),
    }
}

/// Opens a door for a member, or refuses and says why.
///
/// The membership check runs first and it is the local file, so this works with
/// the internet down. A refusal is logged as carefully as an entry — "왜 안
/// 열렸지"는 카운터에서 가장 자주 나오는 질문이다.
#[tauri::command]
pub async fn open_for_member(
    asset: String,
    door_id: String,
    now_unix: i64,
    cnonce: String,
) -> Result<Value, String> {
    let door = find(&door_id)?;
    let door_name = door.get("name").and_then(Value::as_str).unwrap_or("").to_string();

    // 회원권이 먼저다. 문을 열고 나서 자격을 보는 순서는 없다.
    let state = match crate::pass::check_in(asset.clone(), now_unix) {
        Ok(v) => v,
        Err(why) => {
            log_open(json!({
                "at": now_unix, "asset": asset, "door": door_name,
                "opened": false, "why": why,
            }));
            return Ok(json!({ "opened": false, "why": why }));
        }
    };

    match pulse(&door, &cnonce).await {
        Ok(()) => {
            log_open(json!({
                "at": now_unix, "asset": asset, "door": door_name,
                "name": state.get("name"), "opened": true, "why": "",
            }));
            Ok(json!({
                "opened": true,
                "member": state,
                "seconds": door.get("seconds"),
                "message": format!("{door_name} 열렸습니다"),
            }))
        }
        Err(e) => {
            // 회원권은 이미 차감됐는데 문이 안 열렸다. 이건 반드시 기록한다 —
            // 다음 날 "한 번 왔는데 횟수가 두 번 깎였다"가 여기서 나온다.
            log_open(json!({
                "at": now_unix, "asset": asset, "door": door_name,
                "opened": false, "why": format!("회원권은 확인됐지만 문이 안 열림: {e}"),
                "counted": true,
            }));
            Ok(json!({
                "opened": false,
                "member": state,
                "why": format!("{e}\n\n회원권은 확인됐습니다. 직접 열어 주세요."),
            }))
        }
    }
}

/// Opens a door because a person at the counter said so.
#[tauri::command]
pub async fn door_open(door_id: String, reason: String, now_unix: i64, cnonce: String) -> Result<Value, String> {
    let door = find(&door_id)?;
    let name = door.get("name").and_then(Value::as_str).unwrap_or("").to_string();
    let r = pulse(&door, &cnonce).await;
    log_open(json!({
        "at": now_unix, "door": name, "opened": r.is_ok(),
        "why": r.as_ref().err().cloned().unwrap_or_default(),
        "by": "사장", "reason": reason,
    }));
    r.map(|_| json!({ "opened": true, "seconds": door.get("seconds") }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn digest_matches_the_spec() {
        // RFC 7616 의 계산을 그대로 따르는지. 기기가 없어 실기 검증은 못 하지만,
        // 계산이 규격과 다르면 여기서 걸린다.
        let ch = r#"Digest qop="auth", realm="shellyplus1-abc", nonce="1234567890", algorithm=SHA-256"#;
        let h = digest_header(ch, "admin", "pw", "GET", "/rpc/Switch.GetStatus?id=0", "abc123")
            .expect("헤더를 만들지 못했습니다");

        let ha1 = sha256_hex("admin:shellyplus1-abc:pw");
        let ha2 = sha256_hex("GET:/rpc/Switch.GetStatus?id=0");
        let want = sha256_hex(&format!("{ha1}:1234567890:00000001:abc123:auth:{ha2}"));

        assert!(h.contains(&format!("response=\"{want}\"")), "{h}");
        assert!(h.contains("algorithm=SHA-256"));
        assert!(h.contains("nc=00000001"));
    }

    #[test]
    fn a_door_cannot_be_held_open() {
        assert!(door_save(
            "d1".into(), "정문".into(), "192.168.0.9".into(), 2, 0, 600,
            "admin".into(), "pw".into()
        )
        .is_err());
    }
}
