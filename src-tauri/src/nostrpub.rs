//! 릴레이에 글 올리기 — **노드가 대신 나간다.**
//!
//! ## 왜 브라우저가 직접 안 하나
//!
//! 지갑 화면은 `connect-src 'self'` 다. 12단어가 그 페이지의 localStorage 에
//! 있어서, 실수로도 밖으로 새지 못하게 **바깥으로 나가는 길을 아예 막아** 뒀다.
//! 릴레이에 직접 올리려면 그 문을 셋 열어야 하고, 그 순간 이 지갑의 제일 강한
//! 방어가 사라진다. 실제로 그래서 "어느 릴레이도 받지 못했습니다" 가 났다.
//!
//! 그래서 브라우저는 **이미 서명된 글**만 넘기고, 바깥으로 나가는 일은 노드가
//! 한다. 서명은 브라우저에서 끝나므로 **개인키는 여기까지 오지 않는다.**

use serde_json::{json, Value};

const RELAYS: [&str; 3] = [
    "wss://relay.damus.io",
    "wss://nos.lol",
    "wss://relay.primal.net",
];

/// 서명된 이벤트 하나를 여러 릴레이에 올린다.
///
/// 한 곳이라도 받으면 성공으로 친다 — 릴레이는 언제든 하나씩 죽고, 그때마다
/// 사장에게 실패라고 말하면 아무도 안 쓴다.
#[tauri::command]
pub async fn nostr_publish(event: Value) -> Result<Value, String> {
    // 서명이 없는 것을 넘기면 릴레이가 조용히 버린다 — 올린 줄 알고 기다리게 된다.
    for k in ["id", "sig", "pubkey", "kind", "created_at", "content", "tags"] {
        if event.get(k).is_none() {
            return Err(format!("이벤트에 {k} 가 없습니다."));
        }
    }
    let msg = serde_json::to_string(&json!(["EVENT", event]))
        .map_err(|e| format!("보낼 것을 만들지 못했습니다: {e}"))?;

    let mut ok: Vec<String> = Vec::new();
    let mut failed: Vec<Value> = Vec::new();
    for url in RELAYS {
        match send_one(url, &msg).await {
            Ok(()) => ok.push(url.to_string()),
            Err(e) => failed.push(json!({ "relay": url, "why": e })),
        }
    }
    if ok.is_empty() {
        return Err(format!(
            "{}곳 모두 받지 않았습니다. 인터넷이 되는지 확인해 주세요. 마지막 이유: {}",
            RELAYS.len(),
            failed
                .last()
                .and_then(|f| f["why"].as_str())
                .unwrap_or("알 수 없음")
        ));
    }
    Ok(json!({ "ok": ok, "failed": failed }))
}

async fn send_one(url: &str, msg: &str) -> Result<(), String> {
    use futures_util::{SinkExt, StreamExt};
    use tokio_tungstenite::tungstenite::Message;

    // 릴레이 하나가 응답을 안 하면 거기서 멈춘다. 카운터에서 기다릴 시간이 아니다.
    let connect = tokio::time::timeout(
        std::time::Duration::from_secs(6),
        tokio_tungstenite::connect_async(url),
    )
    .await
    .map_err(|_| "연결이 오래 걸립니다".to_string())?
    .map_err(|e| format!("연결 실패: {e}"))?;

    let (mut ws, _) = connect;
    ws.send(Message::Text(msg.to_string().into()))
        .await
        .map_err(|e| format!("보내지 못했습니다: {e}"))?;

    // 릴레이는 ["OK", <id>, true|false, "이유"] 로 답한다. 그 답을 안 기다리면
    // "보냈다" 와 "받아졌다" 를 구별할 수 없다 — 받아지지 않은 글은 없는 글이다.
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(6);
    loop {
        let left = deadline.saturating_duration_since(tokio::time::Instant::now());
        if left.is_zero() {
            return Err("답이 없습니다".into());
        }
        match tokio::time::timeout(left, ws.next()).await {
            Err(_) => return Err("답이 없습니다".into()),
            Ok(None) => return Err("연결이 끊겼습니다".into()),
            Ok(Some(Err(e))) => return Err(format!("받는 중 오류: {e}")),
            Ok(Some(Ok(Message::Text(t)))) => {
                let v: Value = match serde_json::from_str(&t) {
                    Ok(v) => v,
                    Err(_) => continue,
                };
                if v.get(0).and_then(Value::as_str) == Some("OK") {
                    return if v.get(2).and_then(Value::as_bool).unwrap_or(false) {
                        Ok(())
                    } else {
                        Err(v.get(3).and_then(Value::as_str).unwrap_or("거절됨").to_string())
                    };
                }
            }
            Ok(Some(Ok(_))) => continue,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 서명이 빠진 것을 넘기면 릴레이가 조용히 버린다 — 사람은 올린 줄 알고
    /// 기다린다. 나가기 전에 우리가 막는다.
    #[tokio::test]
    async fn an_unsigned_event_is_refused_before_it_leaves() {
        let e = json!({ "kind": 30402, "content": "x" });
        let r = nostr_publish(e).await;
        assert!(r.is_err());
        assert!(r.unwrap_err().contains("id"), "무엇이 빠졌는지 안 알려준다");
    }
}
