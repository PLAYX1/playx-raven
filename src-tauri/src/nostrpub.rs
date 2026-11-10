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

const RELAYS: [&str; 4] = [
    // PLAY X 가 늘 켜 두는 릴레이(N100). 새 사용자 글을 지우지 않고 남긴다 —
    // damus·nos.lol 은 새 열쇠의 글을 OK 라 답하고 버리는 일이 있었다(11-05 실측).
    "wss://playx.taile277f6.ts.net/relay",
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
    // regtest 시험 전용(기본 빌드에는 없다): 공개 릴레이에 가짜 사슬 글을 올리지 않게 한 곳만 쓴다.
    #[cfg(feature = "regtest-harness")]
    if let Some(u) = std::env::var("RV_HARNESS_RELAY").ok().filter(|u| !u.is_empty()) {
        return vec![u];
    }
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
    validate_publish_event(&event)?;
    // 릴레이 나누기(docs/RELAY-SHARE.md §3): 내 이야기 글이면 이웃에도 같이 보낸다 — 기다리지 않고, 실패는 무시한다.
    crate::relay_share::forward(&event);
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
    //
    //    🔴 그리고 **전부 끝날 때까지 기다리지도 않는다.** 내 컴퓨터 안 릴레이와
    //    바깥 한 곳이 받으면 바로 "올렸어요" 다. 나머지는 뒤에서 계속 올린다
    //    (폰·웹과 같은 규칙). 느린 한 곳 때문에 글쓰기가 6초씩 멈추지 않는다.
    use futures_util::stream::{FuturesUnordered, StreamExt};
    let local = targets().into_iter().next().unwrap_or_default();
    let mut runs: FuturesUnordered<_> = targets()
        .into_iter()
        .map(|url| {
            let msg = msg.clone();
            async move { let r = send_one(&url, &msg).await; (url, r) }
        })
        .collect();
    let mut outside_ok = false;
    while let Some((url, r)) = runs.next().await {
        match r {
            Ok(()) => {
                if url != local { outside_ok = true; }
                ok.push(url);
            }
            Err(e) => failed.push(json!({ "relay": url, "why": e })),
        }
        if outside_ok { break; }
    }
    if !runs.is_empty() {
        let left = runs.len();
        tokio::spawn(async move { while runs.next().await.is_some() {} });
        failed.push(json!({ "relay": format!("나머지 {left}곳"), "why": "아직 답이 없어요(뒤에서 계속 올리는 중)." }));
    }
    if ok.is_empty() {
        return Err(format!(
            "{}곳 모두 받지 않았습니다. 인터넷이 되는지 확인해 주세요. 마지막 이유: {}",
            RELAYS.len() + 1,
            failed
                .last()
                .and_then(|f| f["why"].as_str())
                .unwrap_or("알 수 없음")
        ));
    }
    Ok(json!({ "ok": ok, "failed": failed }))
}

pub(crate) async fn send_one(url: &str, msg: &str) -> Result<(), String> {
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
    let expected_id = serde_json::from_str::<Value>(msg).ok().and_then(|v| v[1]["id"].as_str().map(str::to_string)).ok_or("이벤트 ID가 없습니다.")?;
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
                if v.get(0).and_then(Value::as_str) == Some("OK") && v.get(1).and_then(Value::as_str) == Some(expected_id.as_str()) {
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

    fn synthetic(n: i64, at: i64) -> Value { json!({ "id": format!("{n:064x}"), "created_at": at }) }
    /// 가짜 릴레이: until 이하를 새것부터 limit 개.
    fn pager(all: Vec<Value>, eose_from: usize) -> impl FnMut(Option<i64>) -> std::future::Ready<Result<(Vec<Value>, bool), String>> {
        let mut calls = 0usize;
        move |until| {
            calls += 1;
            let mut v: Vec<Value> = all.iter().filter(|e| until.is_none_or(|u| e["created_at"].as_i64().unwrap() <= u)).cloned().collect();
            v.sort_by_key(|e| -e["created_at"].as_i64().unwrap());
            v.truncate(INBOX_PAGE);
            std::future::ready(Ok((v, calls < eose_from)))
        }
    }
    #[tokio::test]
    async fn inbox_pages_past_a_flood_and_reports_incomplete_reads() {
        // 450장(그중 가장 오래된 한 장이 진짜 끊기라고 치자) — 첫 쪽 200장만 읽으면 안 보인다.
        let flood: Vec<Value> = (0..450).map(|i| synthetic(i, 1_000_000 + i)).collect();
        let (got, done) = page_all(pager(flood.clone(), usize::MAX), 50).await.unwrap();
        assert!(done && got.len() == 450 && got.iter().any(|e| e["created_at"] == 1_000_000));
        // 둘째 쪽에서 EOSE 없이 끊김 → 다 읽은 것이 아니다.
        let (_, done) = page_all(pager(flood.clone(), 2), 50).await.unwrap();
        assert!(!done);
        // 쪽 수 상한에 닿아도 다 읽은 것이 아니다.
        let (_, done) = page_all(pager(flood, usize::MAX), 2).await.unwrap();
        assert!(!done);
        // 한 초에 한 쪽 넘게 몰려 더 나아갈 수 없으면 다 읽은 것이 아니다.
        let same: Vec<Value> = (0..300).map(|i| synthetic(i, 5)).collect();
        let (_, done) = page_all(pager(same, usize::MAX), 50).await.unwrap();
        assert!(!done);
        let (got, done) = page_all(pager((0..10).map(|i| synthetic(i, i)).collect(), usize::MAX), 50).await.unwrap();
        assert!(done && got.len() == 10);
    }

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
    // 한 곳이 죽어도 나머지에서 읽는다. 릴레이는 늘 하나씩 죽는다.
    let got = read_everywhere(&req, sub).await;
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
    let got = read_everywhere(&req, sub).await;
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
    let (got, extra) = read_split(&req, sub).await;
    // 11-07: 한 곳도 답하지 않았으면 「없음」이 아니라 「모름」이다 — 고치기 전에 읽는 쪽(이름표·북마크·팔로우)이 빈 목록으로 덮어쓰지 않게.
    if !got.iter().any(|r| r.is_ok()) {
        return Err("릴레이에 하나도 닿지 못했습니다. 인터넷 연결을 확인해 주세요.".into());
    }
    // 이웃 릴레이는 기본 릴레이가 하나라도 답한 뒤에만 더한다 — 이웃은 글이 덜 있을 수 있어 「없음」의 근거가 되면 안 된다.
    for r in got.into_iter().chain(extra) {
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

/// **내 글 지키기**용: 바깥 릴레이 목록(이 컴퓨터 릴레이는 뺀다 — 거기에 채우려고 읽는다).
pub(crate) fn outside_relays() -> Vec<String> {
    RELAYS.iter().map(|s| s.to_string()).collect()
}

/// **내 글 지키기**용: 릴레이 **한 곳**에서 나(author)의 글 한 쪽(최대 200개)을 읽는다.
/// 반환 (글, EOSE 까지 받았나). 서명은 `read_one_eose` 가 확인한다. 쪽 넘기기는 relay.rs 가 릴레이마다 따로 한다.
pub(crate) async fn read_mine_page(url: &str, author: &str, kinds: &[i64], since: Option<i64>, until: Option<i64>) -> Result<(Vec<Value>, bool), String> {
    if author.len() != 64 || !author.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)) {
        return Ok((vec![], true));
    }
    let sub = "m1";
    let mut f = json!({ "kinds": kinds, "authors": [author], "limit": INBOX_PAGE });
    if let Some(t) = since { f["since"] = json!(t.max(0)); }
    if let Some(t) = until { f["until"] = json!(t.max(0)); }
    let req = serde_json::to_string(&json!(["REQ", sub, f])).map_err(|e| format!("보낼 것을 만들지 못했습니다: {e}"))?;
    let (events, eose) = read_one_eose(url, &req, sub).await?;
    Ok((events.into_iter().filter(|e| e.get("pubkey").and_then(Value::as_str) == Some(author)).collect(), eose))
}

/// **쪽지 보관**용(docs/SYNC-ARCHIVE.md §1): 릴레이 **한 곳**에서 나(`#p`)에게 온 겉봉(1059) 한 쪽을 읽는다. 풀지 않는다.
/// 받는 이 태그가 정말 나인 것만 남긴다(릴레이가 엉뚱한 것을 섞어 줘도 저장하지 않게). 서명은 `read_one_eose` 가 본다.
pub(crate) async fn read_wraps_page(url: &str, to: &str, since: Option<i64>, until: Option<i64>) -> Result<(Vec<Value>, bool), String> {
    if to.len() != 64 || !to.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)) {
        return Ok((vec![], true));
    }
    let sub = "w1";
    let mut f = json!({ "kinds": [1059], "#p": [to], "limit": INBOX_PAGE });
    if let Some(t) = since { f["since"] = json!(t.max(0)); }
    if let Some(t) = until { f["until"] = json!(t.max(0)); }
    let req = serde_json::to_string(&json!(["REQ", sub, f])).map_err(|e| format!("보낼 것을 만들지 못했습니다: {e}"))?;
    let (events, eose) = read_one_eose(url, &req, sub).await?;
    let to_me = |e: &Value| e.get("kind").and_then(Value::as_i64) == Some(1059)
        && e.get("tags").and_then(Value::as_array).is_some_and(|t| t.iter().any(|x| x.get(0).and_then(Value::as_str) == Some("p") && x.get(1).and_then(Value::as_str) == Some(to)));
    Ok((events.into_iter().filter(to_me).collect(), eose))
}

/// 글 번호로 글을 읽는다(북마크 화면). 번호는 64자리 16진수만, 50개까지. 릴레이는 한꺼번에 묻는다.
pub(crate) async fn nostr_query_ids(kinds: Vec<i64>, ids: Vec<String>) -> Result<Vec<Value>, String> {
    let ids: Vec<String> = ids
        .into_iter()
        .filter(|a| a.len() == 64 && a.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)))
        .take(50)
        .collect();
    if ids.is_empty() || kinds.is_empty() {
        return Ok(vec![]);
    }
    let sub = "i1";
    let req = serde_json::to_string(&json!(["REQ", sub, { "ids": ids, "kinds": kinds, "limit": ids.len() }]))
        .map_err(|e| format!("보낼 것을 만들지 못했습니다: {e}"))?;
    let got = read_everywhere(&req, sub).await;
    let mut seen: std::collections::HashMap<String, Value> = std::collections::HashMap::new();
    for events in got.into_iter().flatten() {
        for e in events {
            if let Some(id) = e.get("id").and_then(Value::as_str) {
                if ids.iter().any(|i| i == id) {
                    seen.entry(id.to_string()).or_insert(e);
                }
            }
        }
    }
    Ok(seen.into_values().collect())
}

/// 한 열쇠에게 온 겉봉(NIP-17 kind 1059)만 읽는다 — 지갑 연결의 받은 쪽지함(wallet_link.rs).
/// 겉봉 시각은 최대 이틀 앞당겨지므로 `since` 는 부르는 쪽이 이미 이틀 뺀 값을 준다.
///
/// 🔴 끝까지 넘겨 읽는다. 연결 공개키는 공개돼 있어 누구나 그 키로 겉봉 수백 장을 쌓을 수 있다 —
///    한 번 200장만 읽으면 진짜 「끊기」가 밀려나 안 보인다. 그래서 `until` 로 페이지를 넘기고,
///    어느 릴레이에서든 끝(EOSE)까지 못 읽었으면 「다 읽음」이 아니라고 돌려준다(부르는 쪽은 커서를 안 옮긴다).
/// 돌려주는 값: (겉봉들, 끝까지 읽은 릴레이가 있나). 한 곳도 안 닿으면 Err.
pub(crate) async fn nostr_query_inbox(pubkey: &str, since: i64) -> Result<(Vec<Value>, bool), String> {
    if pubkey.len() != 64 || !pubkey.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)) {
        return Err("받는 열쇠가 올바르지 않습니다.".into());
    }
    let pubkey = pubkey.to_string();
    use futures_util::stream::{FuturesUnordered, StreamExt};
    let mut runs: FuturesUnordered<_> = targets().into_iter().map(|url| {
        let pubkey = pubkey.clone();
        async move {
            page_all(|until| {
                let mut f = json!({ "kinds": [1059], "#p": [pubkey], "since": since.max(0), "limit": INBOX_PAGE });
                if let Some(u) = until { f["until"] = json!(u); }
                let req = serde_json::to_string(&json!(["REQ", "wl1", f])).unwrap_or_default();
                let url = url.clone();
                async move { read_one_eose(&url, &req, "wl1").await }
            }, INBOX_MAX_PAGES).await
        }
    }).collect();
    // 11-03 감사 B1: 가장 느린 릴레이(연결 7초+읽기 10초)까지 기다리지 않는다. 한 곳이라도 끝(EOSE)까지 다 읽으면
    // 짧은 유예(INBOX_GRACE) 동안 들어온 것만 더 합치고 돌려준다. 늦은 곳의 겉봉은 다음 확인(이틀 창을 다시 읽는다)에서 잡힌다.
    // 「다 읽음」(커서 이동)은 끝까지 읽은 릴레이가 하나라도 있을 때만 — 그 곳이 본 범위는 빠짐없이 읽은 것이다.
    let (mut any, mut complete) = (false, false);
    let mut seen: std::collections::HashMap<String, Value> = std::collections::HashMap::new();
    let mut take = |r: Result<(Vec<Value>, bool), String>, any: &mut bool, complete: &mut bool| {
        let Ok((events, done)) = r else { return };
        *any = true;
        *complete |= done;
        for e in events {
            if let Some(id) = e.get("id").and_then(Value::as_str) { seen.entry(id.to_string()).or_insert(e); }
        }
    };
    while let Some(r) = runs.next().await {
        take(r, &mut any, &mut complete);
        if complete { break; }
    }
    if complete {
        let grace = tokio::time::Instant::now() + INBOX_GRACE;
        while let Ok(Some(r)) = tokio::time::timeout_at(grace, runs.next()).await { take(r, &mut any, &mut complete); }
    }
    if !any {
        return Err("릴레이에 닿지 못했습니다. 인터넷을 확인해 주세요.".into());
    }
    Ok((seen.into_values().collect(), complete))
}
const INBOX_GRACE: std::time::Duration = std::time::Duration::from_millis(800);
pub(crate) const INBOX_PAGE: usize = 200;
const INBOX_MAX_PAGES: usize = 50;

/// `until` 을 오래된 쪽으로 옮기며 끝까지 읽는다. `page(until)` = (그 쪽 글, EOSE 를 받았나).
/// 다 읽었으면 true. 첫 쪽부터 실패하면 Err, 중간에 끊기거나·EOSE 없이 끝나거나·더 못 나아가면(같은 초에 한 쪽 넘게) false.
pub(crate) async fn page_all<F, Fut>(mut page: F, max_pages: usize) -> Result<(Vec<Value>, bool), String>
where
    F: FnMut(Option<i64>) -> Fut,
    Fut: std::future::Future<Output = Result<(Vec<Value>, bool), String>>,
{
    let mut all: std::collections::HashMap<String, Value> = std::collections::HashMap::new();
    let mut until: Option<i64> = None;
    for n in 0..max_pages {
        let (events, eose) = match page(until).await {
            Ok(v) => v,
            Err(e) if n == 0 => return Err(e),
            Err(_) => return Ok((all.into_values().collect(), false)),
        };
        let count = events.len();
        let oldest = events.iter().filter_map(|e| e.get("created_at").and_then(Value::as_i64)).min();
        let mut fresh = 0;
        for e in events {
            if let Some(id) = e.get("id").and_then(Value::as_str).map(str::to_string) {
                if !all.contains_key(&id) { all.insert(id, e); fresh += 1; }
            }
        }
        if !eose { return Ok((all.into_values().collect(), false)); }
        if count < INBOX_PAGE { return Ok((all.into_values().collect(), true)); }
        match oldest {
            // until 은 그 초를 포함한다 — 새 글이 하나도 없으면 더 나아갈 수 없다.
            Some(o) if fresh > 0 => until = Some(o),
            _ => return Ok((all.into_values().collect(), false)),
        }
    }
    Ok((all.into_values().collect(), false))
}

/// 정해진 물음(필터 여럿) 그대로 읽는다 — **이야기 SNS**(talk_social.rs: 팔로우 피드·알림·해시태그)가 쓴다.
/// 필터는 우리 코드가 만든 것만 넘긴다(종류·개수가 늘 있다). 기본 릴레이가 한 곳도 답하지 않으면 「없음」이 아니라 Err.
/// 돌려줌 (글들 — id 로 하나씩 · 최신이 앞, 답한 기본 릴레이 수).
pub(crate) async fn query_filters(filters: Vec<Value>) -> Result<(Vec<Value>, usize), String> {
    if filters.is_empty() || filters.iter().any(|f| f.get("kinds").and_then(Value::as_array).is_none_or(|k| k.is_empty())) {
        return Err("무엇을 읽을지 알려 주세요.".into());
    }
    let sub = "f1";
    let mut req = vec![json!("REQ"), json!(sub)];
    req.extend(filters);
    let req = serde_json::to_string(&Value::Array(req)).map_err(|e| format!("보낼 것을 만들지 못했습니다: {e}"))?;
    let (base, extra) = read_split(&req, sub).await;
    let reached = base.iter().filter(|r| r.is_ok()).count();
    if reached == 0 {
        return Err("릴레이에 하나도 닿지 못했습니다. 인터넷 연결을 확인해 주세요.".into());
    }
    let mut seen: std::collections::HashMap<String, Value> = std::collections::HashMap::new();
    for events in base.into_iter().chain(extra).flatten() {
        for e in events {
            if let Some(id) = e.get("id").and_then(Value::as_str) {
                seen.entry(id.to_string()).or_insert(e);
            }
        }
    }
    let mut out: Vec<Value> = seen.into_values().collect();
    out.sort_by_key(|e| -(e.get("created_at").and_then(Value::as_i64).unwrap_or(0)));
    Ok((out, reached))
}

/// 바깥 기본 릴레이 하나가 답한 뒤, 나머지를 더 기다리는 시간.
///
/// 11-10 「레이븐볼트가 빠른가?」: 여태 **가장 느린 릴레이까지** 기다렸다(한 곳이 막히면 매번 7초).
/// 바깥 릴레이는 같은 글을 서로 나눠 가지므로, 한 곳이 답하면 나머지는 잠깐만 더 기다리고 있는 것만 쓴다.
const GRACE_AFTER_FIRST: std::time::Duration = std::time::Duration::from_millis(1500);
const LATE: &str = "늦어서 기다리지 않았습니다";

/// 기본 릴레이(+이 컴퓨터) 와 릴레이 나누기 이웃·더한 곳을 **한꺼번에** 묻는다.
/// 이웃은 5초 제한이라(relay_share::read_extra) 기본 릴레이(최대 7초)보다 늦게 붙잡지 않는다.
/// **바깥** 기본 릴레이(0번 = 이 컴퓨터 릴레이는 빼고) 하나가 답하면 그때부터 GRACE_AFTER_FIRST 만 더 기다린다 —
/// 이 컴퓨터 릴레이는 곧바로 (거의 빈) 답을 주므로 그걸 신호로 삼으면 바깥 글을 놓친다.
async fn read_split(req: &str, sub: &str) -> (Vec<Result<Vec<Value>, String>>, Vec<Result<Vec<Value>, String>>) {
    use futures_util::future::FutureExt;
    use futures_util::stream::{FuturesUnordered, StreamExt};
    let base = targets();
    let extra = crate::relay_share::extra_relays();
    let n_base = base.len();
    let mut futs = FuturesUnordered::new();
    for (i, u) in base.iter().enumerate() {
        futs.push(async move { (i, read_one(u, req, sub).await) }.boxed());
    }
    for (j, u) in extra.iter().enumerate() {
        futs.push(async move { (n_base + j, crate::relay_share::read_extra(u, req, sub).await) }.boxed());
    }
    let mut slots: Vec<Option<Result<Vec<Value>, String>>> = (0..n_base + extra.len()).map(|_| None).collect();
    let mut cutoff: Option<tokio::time::Instant> = None;
    loop {
        let next = match cutoff {
            None => futs.next().await,
            Some(c) => match tokio::time::timeout_at(c, futs.next()).await {
                Ok(x) => x,
                Err(_) => break,
            },
        };
        let Some((i, r)) = next else { break };
        if cutoff.is_none() && is_outside_base(i, n_base) && r.is_ok() {
            cutoff = Some(tokio::time::Instant::now() + GRACE_AFTER_FIRST);
        }
        slots[i] = Some(r);
    }
    let mut all: Vec<Result<Vec<Value>, String>> = slots.into_iter().map(|s| s.unwrap_or_else(|| Err(LATE.into()))).collect();
    let extra_out = all.split_off(n_base);
    (all, extra_out)
}

/// 0번은 이 컴퓨터 릴레이. 시험용 단일 릴레이(regtest)는 한 곳뿐이라 0번도 바깥으로 친다.
fn is_outside_base(i: usize, n_base: usize) -> bool {
    i < n_base && (i > 0 || n_base == 1)
}

async fn read_everywhere(req: &str, sub: &str) -> Vec<Result<Vec<Value>, String>> {
    let (a, b) = read_split(req, sub).await;
    a.into_iter().chain(b).collect()
}

/// read_one 과 같되, 개수로 끊지 않고 EOSE 를 받았는지까지 돌려준다(쪽 넘기기용).
async fn read_one_eose(url: &str, req: &str, sub: &str) -> Result<(Vec<Value>, bool), String> {
    use futures_util::{SinkExt, StreamExt};
    use tokio_tungstenite::tungstenite::Message;
    let (mut ws, _) = tokio::time::timeout(std::time::Duration::from_secs(7), tokio_tungstenite::connect_async(url))
        .await
        .map_err(|_| "연결이 오래 걸립니다".to_string())?
        .map_err(|e| format!("연결 실패: {e}"))?;
    ws.send(Message::Text(req.to_string().into())).await.map_err(|e| format!("보내지 못했습니다: {e}"))?;
    let mut out = Vec::new();
    let mut eose = false;
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(10);
    while out.len() <= 4 * INBOX_PAGE {
        let left = deadline.saturating_duration_since(tokio::time::Instant::now());
        if left.is_zero() { break; }
        let Ok(Some(Ok(msg))) = tokio::time::timeout(left, ws.next()).await else { break };
        let Message::Text(t) = msg else { continue };
        let Ok(v) = serde_json::from_str::<Value>(&t) else { continue };
        let Some(a) = v.as_array() else { continue };
        if a.get(1).and_then(Value::as_str) != Some(sub) { continue; }
        match a.first().and_then(Value::as_str) {
            Some("EOSE") => { eose = true; break; }
            Some("EVENT") => if let Some(e) = a.get(2).filter(|e| crate::relay::verify(e)) { out.push(e.clone()); },
            Some("CLOSED") => break,
            _ => {}
        }
    }
    let _ = ws.close(None).await;
    Ok((out, eose))
}

pub(crate) async fn read_one(url: &str, req: &str, sub: &str) -> Result<Vec<Value>, String> {
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
            if let Some(e) = a.get(2).filter(|e| crate::relay::verify(e)) {
                out.push(e.clone());
            }
        }
    }
    let _ = ws.close(None).await;
    Ok(out)
}

/// The public proxy supports only the event types used by this wallet/shop.
/// Reject malformed fields before hashing, and verify both NIP-01 id and BIP340.
pub(crate) const MAX_PUBLISH_BYTES: usize = 32 * 1024;
pub(crate) fn validate_publish_event(event: &Value) -> Result<(), String> {
    let o = event.as_object().ok_or("이벤트 모양이 올바르지 않습니다.")?;
    for k in ["id", "sig", "pubkey", "kind", "created_at", "content", "tags"] {
        if !o.contains_key(k) { return Err(format!("이벤트에 {k} 가 없습니다.")); }
    }
    if o.len() != 7 || serde_json::to_vec(event).map_err(|_| "이벤트를 읽지 못했습니다.")?.len() > MAX_PUBLISH_BYTES {
        return Err("이벤트가 32 KB를 넘거나 지원하지 않는 필드가 있습니다.".into());
    }
    let hex_field = |key: &str, size: usize| o[key].as_str().is_some_and(|s| s.len() == size && s.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)));
    if !hex_field("id",64) || !hex_field("pubkey",64) || !hex_field("sig",128) { return Err("이벤트 ID·공개키·서명 모양이 올바르지 않습니다.".into()); }
    let kind = o["kind"].as_u64().filter(|k| [0,1,5,40,41,42,1059,30078,30402].contains(k)).ok_or("이 가게는 프로필·레이븐 이야기(방 만들기·방 정보 수정 포함)·상품·가게 공지·쪽지·삭제 요청만 중계합니다.")?;
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_secs();
    if !o["created_at"].as_u64().is_some_and(|t| t >= now.saturating_sub(7 * 86_400) && t <= now.saturating_add(300) && t <= 9_007_199_254_740_991) { return Err("이벤트 시각이 올바르지 않습니다. 기기 시계를 확인해 주세요.".into()); }
    let content = o["content"].as_str().ok_or("이벤트 내용은 글자여야 합니다.")?;
    let tags = o["tags"].as_array().filter(|t| t.len() <= 128).ok_or("태그가 너무 많거나 모양이 다릅니다.")?;
    if tags.iter().any(|t| !t.as_array().is_some_and(|items| !items.is_empty() && items.len() <= 8 && items.iter().all(|x| x.as_str().is_some_and(|s| s.len() <= 2048)))) {
        return Err("태그는 짧은 글자 목록이어야 합니다.".into());
    }
    let tag = |name: &str| tags.iter().any(|t| t[0] == name && t.get(1).and_then(Value::as_str).is_some_and(|s| !s.is_empty()));
    match kind {
        0 | 40 | 30078 => { if !serde_json::from_str::<Value>(content).is_ok_and(|v| v.is_object()) { return Err("프로필·방·가게 내용은 JSON 객체여야 합니다.".into()); } },
        // 방 정보 수정(NIP-28): 어느 방인지(`e`)와 JSON 내용이 둘 다 있어야 한다. 누가 고칠 수 있는지는 읽는 쪽(talk.rs)이 본다.
        41 => if !tag("e") || !serde_json::from_str::<Value>(content).is_ok_and(|v| v.is_object()) { return Err("방 정보 수정에는 방 번호와 JSON 내용이 있어야 합니다.".into()); },
        5 => if !tag("e") && !tag("a") { return Err("삭제할 이벤트를 지정해 주세요.".into()); },
        42 => if !tag("e") { return Err("대화방 이벤트를 지정해 주세요.".into()); },
        1059 => if !tag("p") || content.is_empty() { return Err("쪽지의 받는 사람과 봉함 내용을 확인해 주세요.".into()); },
        _ => (),
    }
    if matches!(kind,30078|30402) && !tag("d") { return Err("가게·상품 식별자가 없습니다.".into()); }
    if !crate::relay::verify(event) { return Err("이벤트 ID 또는 서명이 맞지 않습니다. 지갑에서 다시 서명해 주세요.".into()); }
    Ok(())
}
/// Bounded process-wide budget; changing key/address cannot bypass global cap.
#[derive(Default)]
pub(crate) struct PublishBudget { times: Vec<(u64, String)> }
impl PublishBudget {
    pub(crate) fn take(&mut self, now: u64, pubkey: &str) -> Result<(), &'static str> {
        self.times.retain(|(at,_)| now.saturating_sub(*at) < 60);
        if self.times.len() >= 20 || self.times.iter().filter(|(_,key)| key == pubkey).count() >= 4 {
            return Err("릴레이 중계 요청이 많습니다. 1분 뒤 다시 올려 주세요.");
        }
        self.times.push((now,pubkey.to_string())); Ok(())
    }
}
#[cfg(test)]
mod publish_security_tests {
    /// 11-10: 이 컴퓨터 릴레이(0번)는 「첫 답」 신호가 아니다 — 바로 빈 답을 줘서 바깥 글을 놓친다.
    #[test]
    fn 첫_답_신호는_바깥_릴레이만() {
        assert!(!super::is_outside_base(0, 5));
        assert!(super::is_outside_base(1, 5));
        assert!(!super::is_outside_base(5, 5), "이웃 릴레이는 신호가 아니다");
        assert!(super::is_outside_base(0, 1), "시험용 단일 릴레이");
        assert!(super::GRACE_AFTER_FIRST.as_millis() <= 2000);
    }

    use super::*;
    fn signed() -> Value {
        use sha2::{Digest,Sha256};
        let secp=secp256k1::Secp256k1::new();
        let key=secp256k1::Keypair::from_seckey_slice(&secp,&[7u8;32]).unwrap();
        let pk=key.x_only_public_key().0.to_string();
        let created=std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs();
        let tags=json!([["d","synthetic-listing"]]); let content="{\"title\":\"synthetic\"}";
        let hash:[u8;32]=Sha256::digest(serde_json::to_vec(&json!([0,pk,created,30402,tags,content])).unwrap()).into();
        json!({"id":hex::encode(hash),"pubkey":pk,"sig":secp.sign_schnorr_no_aux_rand(&hash,&key).to_string(),"kind":30402,"created_at":created,"tags":tags,"content":content})
    }
    #[test]
    fn valid_signature_is_required_for_supported_bounded_event() {
        let event=signed(); assert!(validate_publish_event(&event).is_ok());
        for key in ["id","sig","pubkey"] { let mut bad=event.clone();bad[key]=json!("0".repeat(if key=="sig" {128}else{64}));assert_eq!(validate_publish_event(&bad).is_err(),true,"{key}"); }
        let mut bad=event.clone();bad["content"]=json!("changed");assert!(validate_publish_event(&bad).is_err());
        let mut bad=event.clone();bad["kind"]=json!(27235);assert!(validate_publish_event(&bad).is_err());
        let mut bad=event.clone();bad["tags"]=json!([["x",7]]);assert!(validate_publish_event(&bad).is_err());
        let mut bad=event.clone();bad["content"]=json!("x".repeat(MAX_PUBLISH_BYTES));assert!(validate_publish_event(&bad).is_err());
        let mut bad=event.clone();bad["created_at"]=json!(-1);assert!(validate_publish_event(&bad).is_err());
    }
    #[test]
    fn quota_cannot_be_bypassed_with_distinct_signers_and_recovers_after_window() {
        let mut budget=PublishBudget::default();
        for _ in 0..4 {assert!(budget.take(100,"same").is_ok());}
        assert!(budget.take(100,"same").is_err());
        for i in 0..16 {assert!(budget.take(100,&format!("key{i}")).is_ok());}
        assert!(budget.take(100,"new-key").is_err());assert_eq!(budget.times.len(),20);
        assert!(budget.take(160,"same").is_ok());assert_eq!(budget.times.len(),1);
    }
}

#[cfg(test)]
pub(crate) fn synthetic_signed_event(kind:u64, tags:Value, content:&str, key_byte:u8)->Value {
    use sha2::{Digest,Sha256};
    let secp=secp256k1::Secp256k1::new();
    let key=secp256k1::Keypair::from_seckey_slice(&secp,&[key_byte;32]).unwrap();
    let pubkey=key.x_only_public_key().0.to_string();
    let at=std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs();
    let hash:[u8;32]=Sha256::digest(serde_json::to_vec(&json!([0,pubkey,at,kind,tags,content])).unwrap()).into();
    json!({"id":hex::encode(hash),"pubkey":pubkey,"sig":secp.sign_schnorr_no_aux_rand(&hash,&key).to_string(),"kind":kind,"created_at":at,"tags":tags,"content":content})
}
#[cfg(test)]
pub(crate) fn synthetic_product(content:&str,key_byte:u8)->Value {
    let at=std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs();
    let tags=json!([["d","playx-synthetic"],["title","Synthetic bicycle"],["price","25","USD"],["published_at",at.to_string()],["t","playx"],["status","active"],["location","Synthetic town"]]);
    synthetic_signed_event(30402,tags,content,key_byte)
}
#[cfg(test)]
mod product_usability_tests {
    use super::*;
    #[test]
    fn signed_wallet_product_plain_text_and_edits_are_supported_without_weakening_checks() {
        assert!(include_str!("../../web/wallet.src.ts").contains("content: desc"));
        for content in ["A synthetic bicycle with new brakes.", "Edited: collection after 5 pm.", ""] {
            let event = synthetic_product(content, 41);
            assert_eq!(validate_publish_event(&event), Ok(()), "wallet listing descriptions are plain text");
            let mut bad = event.clone(); bad["sig"] = json!("0".repeat(128)); assert!(validate_publish_event(&bad).is_err());
            let mut bad = event.clone(); bad["id"] = json!("0".repeat(64)); assert!(validate_publish_event(&bad).is_err());
        }
        assert!(validate_publish_event(&synthetic_product(&"x".repeat(MAX_PUBLISH_BYTES),41)).is_err());
    }
}
