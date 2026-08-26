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

/// 올릴 곳 전부 — **우리 릴레이를 맨 앞에.**
///
/// 🔴 남의 릴레이 세 곳에만 올리면, 그 셋이 우리를 차단하는 날 모든 가게가
/// 한꺼번에 장터에서 사라진다. 우리 것에도 같이 둔다.
///
/// 공개 릴레이를 **버리지는 않는다.** 우리가 문을 닫아도 공지가 남아야
/// 하고, 그게 이 판이 탈중앙인 이유다. 우리 릴레이는 빠른 길일 뿐
/// 유일한 길이 아니다.
fn targets() -> Vec<String> {
    let mut out = vec![format!("ws://127.0.0.1:{}/api/relay", crate::server::PORT)];
    out.extend(RELAYS.iter().map(|s| s.to_string()));
    out
}

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
    // 🔴 **릴레이는 한꺼번에 묻는다. 줄 세우면 안 된다.**
    //
    //    예전에는 `for url in targets()` 안에서 `.await` 했다. 네 곳을
    //    차례로 돌면서 한 곳당 최대 7초를 기다리니 **최대 28초**다. 이야기
    //    화면은 글·이름표·방 목록을 세 번 읽으므로 **최대 84초**가 된다.
    //    그 화면은 아무도 안 쓴다.
    //
    //    한꺼번에 물으면 최대 7초다 — 제일 느린 한 곳만큼만 기다린다.
    use futures_util::future::join_all;
    let urls = targets();
    let results = join_all(urls.iter().map(|u| send_one(u, &msg))).await;
    for (url, r) in urls.into_iter().zip(results) {
        match r {
            Ok(()) => ok.push(url.clone()),
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

/// 릴레이에서 **읽어다 준다.** 올리는 길만 있고 읽는 길이 없었다.
///
/// 그래서 지갑의 「내가 올린 것」은 한 번도 채워진 적이 없다 — 화면에는 자리가
/// 있는데 채울 방법이 없어서, 자기가 올린 글을 고치지도 지우지도 못했다.
/// 이유는 위와 같다: 지갑은 `connect-src 'self'` 라 릴레이를 못 읽는다.
///
/// 개인키는 여기까지 오지 않는다. **공개키만** 온다 — 누가 썼는지는 원래
/// 릴레이에 공개돼 있는 값이다.
pub async fn nostr_query(
    kinds: Vec<i64>,
    authors: Vec<String>,
    to_me: Vec<String>,
) -> Result<Value, String> {
    // 🔴 글쓴이를 안 적으면 릴레이 전체를 긁는 셈이다. 그런 요청을 계속 보내면
    // 릴레이가 우리를 차단하고, 그러면 모든 가게가 못 쓴다.
    let authors: Vec<String> = authors
        .into_iter()
        .filter(|a| a.len() == 64 && a.chars().all(|c| c.is_ascii_hexdigit()))
        .take(10)
        .collect();
    // 🔴 1:1 문의(겉봉)는 보낸 이가 임시 열쇠라 authors 로 못 찾는다.
    // 받는 이 태그로 찾는다.
    let to_me: Vec<String> = to_me
        .into_iter()
        .filter(|a| a.len() == 64 && a.chars().all(|c| c.is_ascii_hexdigit()))
        .take(3)
        .collect();
    if authors.is_empty() && to_me.is_empty() {
        return Err("누구 글인지 알려 주세요.".into());
    }
    let kinds = if kinds.is_empty() { vec![30402] } else { kinds };

    let sub = "q1";
    let mut f = serde_json::Map::new();
    f.insert("kinds".into(), json!(kinds));
    f.insert("limit".into(), json!(200));
    if !authors.is_empty() {
        f.insert("authors".into(), json!(authors));
    }
    if !to_me.is_empty() {
        f.insert("#p".into(), json!(to_me));
    }
    let req = serde_json::to_string(&json!(["REQ", sub, Value::Object(f)]))
    .map_err(|e| format!("보낼 것을 만들지 못했습니다: {e}"))?;

    let mut seen: std::collections::HashMap<String, Value> = std::collections::HashMap::new();
    // 🔴 **릴레이는 한꺼번에 묻는다. 줄 세우면 안 된다.**
    //
    //    예전에는 `for url in targets()` 안에서 `.await` 했다. 네 곳을
    //    차례로 돌면서 한 곳당 최대 7초를 기다리니 **최대 28초**다. 이야기
    //    화면은 글·이름표·방 목록을 세 번 읽으므로 **최대 84초**가 된다.
    //    그 화면은 아무도 안 쓴다.
    //
    //    한꺼번에 물으면 최대 7초다 — 제일 느린 한 곳만큼만 기다린다.
    use futures_util::future::join_all;
    // 한 곳이 죽어도 나머지에서 읽는다. 릴레이는 늘 하나씩 죽는다.
    let got = join_all(targets().iter().map(|u| read_one(u, &req, sub))).await;
    for r in got {
        if let Ok(events) = r {
            for e in events {
                if let Some(id) = e.get("id").and_then(Value::as_str) {
                    seen.entry(id.to_string()).or_insert(e);
                }
            }
        }
    }
    let mut events: Vec<Value> = seen.into_values().collect();
    events.sort_by_key(|e| -(e.get("created_at").and_then(Value::as_i64).unwrap_or(0)));
    Ok(json!({ "events": events }))
}

/// 표(`t` 태그)로 좁혀 읽는다. **이야기 화면이 쓰는 길.**
///
/// 🔴 위 `nostr_query` 는 글쓴이를 안 적으면 거절한다 — 릴레이 전체를 긁다
///    차단당하지 않으려고 그렇게 해 뒀고, 그 걱정은 맞다. 다만 「레이븐
///    이야기를 보여 달라」는 통째로 긁는 것이 아니라 **좁은 물음**이다.
///    세상의 Nostr 앱이 다 이렇게 읽는다.
///
///    그래도 선은 지킨다: 표가 반드시 있어야 하고, 개수 상한이 있고,
///    종류를 안 적으면 안 읽는다. 「아무거나 다 줘」는 여전히 못 한다.
pub async fn nostr_query_tag(
    kinds: Vec<i64>,
    tag: String,
    tag_values: Vec<String>,
    limit: i64,
) -> Result<Vec<Value>, String> {
    if kinds.is_empty() {
        return Err("무엇을 읽을지 알려 주세요.".into());
    }
    // 한 글자짜리 태그만 쓴다(NIP-01). `t`(표)·`e`(가리키는 글) 같은 것.
    if tag.len() != 1 || !tag.chars().all(|c| c.is_ascii_alphabetic()) {
        return Err("태그가 올바르지 않습니다.".into());
    }
    let vals: Vec<String> = tag_values.into_iter().filter(|v| !v.is_empty()).take(8).collect();
    if vals.is_empty() {
        return Err("무엇으로 좁힐지 알려 주세요.".into());
    }
    let sub = "t1";
    let mut f = serde_json::Map::new();
    f.insert("kinds".into(), json!(kinds));
    f.insert(format!("#{tag}"), json!(vals));
    f.insert("limit".into(), json!(limit.clamp(1, 200)));
    let req = serde_json::to_string(&json!(["REQ", sub, Value::Object(f)]))
        .map_err(|e| format!("보낼 것을 만들지 못했습니다: {e}"))?;

    let mut seen: std::collections::HashMap<String, Value> = std::collections::HashMap::new();
    // 🔴 **릴레이는 한꺼번에 묻는다. 줄 세우면 안 된다.**
    //
    //    예전에는 `for url in targets()` 안에서 `.await` 했다. 네 곳을
    //    차례로 돌면서 한 곳당 최대 7초를 기다리니 **최대 28초**다. 이야기
    //    화면은 글·이름표·방 목록을 세 번 읽으므로 **최대 84초**가 된다.
    //    그 화면은 아무도 안 쓴다.
    //
    //    한꺼번에 물으면 최대 7초다 — 제일 느린 한 곳만큼만 기다린다.
    use futures_util::future::join_all;
    let got = join_all(targets().iter().map(|u| read_one(u, &req, sub))).await;
    for r in got {
        if let Ok(events) = r {
            for e in events {
                if let Some(id) = e.get("id").and_then(Value::as_str) {
                    seen.entry(id.to_string()).or_insert(e);
                }
            }
        }
    }
    let mut out: Vec<Value> = seen.into_values().collect();
    out.sort_by_key(|e| -(e.get("created_at").and_then(Value::as_i64).unwrap_or(0)));
    Ok(out)
}

/// 정해진 사람들의 글을 읽는다. **이름표(프로필)를 찾을 때 쓴다.**
///
/// 🔴 위 `nostr_query` 는 글쓴이를 10명까지만 본다. 대화 한 화면에 서른
///    명이 나오는데 열 명만 물으면 **나머지는 영영 16진수로 남는다.**
///    이름표는 글 하나가 몇백 바이트라 쉰 명을 물어도 가볍다.
pub async fn nostr_query_authors(
    kinds: Vec<i64>,
    authors: Vec<String>,
    limit: i64,
) -> Result<Vec<Value>, String> {
    let authors: Vec<String> = authors
        .into_iter()
        .filter(|a| a.len() == 64 && a.chars().all(|c| c.is_ascii_hexdigit()))
        .take(50)
        .collect();
    if authors.is_empty() || kinds.is_empty() {
        return Ok(vec![]);
    }
    let sub = "a1";
    let req = serde_json::to_string(&json!([
        "REQ",
        sub,
        { "kinds": kinds, "authors": authors, "limit": limit.clamp(1, 200) }
    ]))
    .map_err(|e| format!("보낼 것을 만들지 못했습니다: {e}"))?;

    let mut seen: std::collections::HashMap<String, Value> = std::collections::HashMap::new();
    // 🔴 **릴레이는 한꺼번에 묻는다. 줄 세우면 안 된다.**
    //
    //    예전에는 `for url in targets()` 안에서 `.await` 했다. 네 곳을
    //    차례로 돌면서 한 곳당 최대 7초를 기다리니 **최대 28초**다. 이야기
    //    화면은 글·이름표·방 목록을 세 번 읽으므로 **최대 84초**가 된다.
    //    그 화면은 아무도 안 쓴다.
    //
    //    한꺼번에 물으면 최대 7초다 — 제일 느린 한 곳만큼만 기다린다.
    use futures_util::future::join_all;
    let got = join_all(targets().iter().map(|u| read_one(u, &req, sub))).await;
    for r in got {
        if let Ok(events) = r {
            for e in events {
                // 이름표는 **한 사람에 하나**다. 새것만 남긴다 — 옛것이
                // 뒤에 오면 바꾼 이름이 다시 옛 이름으로 보인다.
                let (Some(pk), Some(at)) = (
                    e.get("pubkey").and_then(Value::as_str).map(str::to_string),
                    e.get("created_at").and_then(Value::as_i64),
                ) else {
                    continue;
                };
                let keep = seen
                    .get(&pk)
                    .and_then(|o| o.get("created_at").and_then(Value::as_i64))
                    .map(|old| at > old)
                    .unwrap_or(true);
                if keep {
                    seen.insert(pk, e);
                }
            }
        }
    }
    Ok(seen.into_values().collect())
}

async fn read_one(url: &str, req: &str, sub: &str) -> Result<Vec<Value>, String> {
    use futures_util::{SinkExt, StreamExt};
    use tokio_tungstenite::tungstenite::Message;

    let (mut ws, _) = tokio::time::timeout(
        std::time::Duration::from_secs(7),
        tokio_tungstenite::connect_async(url),
    )
    .await
    .map_err(|_| "연결이 오래 걸립니다".to_string())?
    .map_err(|e| format!("연결 실패: {e}"))?;

    ws.send(Message::Text(req.to_string().into()))
        .await
        .map_err(|e| format!("보내지 못했습니다: {e}"))?;

    let mut out = Vec::new();
    // 사람이 화면 앞에서 기다린다. 오래 붙잡느니 있는 것만 주고 끝낸다.
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(7);
    loop {
        let left = deadline.saturating_duration_since(tokio::time::Instant::now());
        if left.is_zero() || out.len() >= 200 {
            break;
        }
        let Ok(Some(Ok(msg))) = tokio::time::timeout(left, ws.next()).await else {
            break;
        };
        let Message::Text(t) = msg else { continue };
        let Ok(v) = serde_json::from_str::<Value>(&t) else {
            continue;
        };
        let Some(a) = v.as_array() else { continue };
        // EOSE = 이 릴레이가 가진 것을 다 보냈다는 뜻. 더 기다릴 이유가 없다.
        if a.first().and_then(Value::as_str) == Some("EOSE")
            && a.get(1).and_then(Value::as_str) == Some(sub)
        {
            break;
        }
        if a.first().and_then(Value::as_str) == Some("EVENT")
            && a.get(1).and_then(Value::as_str) == Some(sub)
        {
            if let Some(e) = a.get(2) {
                out.push(e.clone());
            }
        }
    }
    let _ = ws.close(None).await;
    Ok(out)
}
