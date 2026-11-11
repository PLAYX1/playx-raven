//! **알림 지킴이**(11-12 대표 승인) — 바깥 릴레이에 새로 올라오는 쪽지 겉봉(1059)·방 글(42)을 곧바로 알림 서버에 넘긴다.
//!
//! ## 왜
//!
//! 폰 알림은 서버(rv-talk 함수)가 1분마다 릴레이를 확인해서 보낸다 — 카톡처럼 「보내자마자 울림」이 안 된다.
//! 늘 켜 둔 컴퓨터 하나(대표 N100)가 릴레이에 **구독을 열어 두고**, 새 글이 오면 그 원본을 서버의 「즉시 알림」 입구에 넘긴다.
//!
//! ## 지키는 것
//!
//! - **기본 꺼짐.** 설정 › 릴레이 나누기 카드의 스위치로만 켠다(talk-push.json). 켠 컴퓨터만 이 일을 한다.
//! - 넘기는 것은 **서명된 원본 이벤트 그대로**다. 서명이 맞는 것만 넘긴다(relay::verify). 겉봉(1059)은 풀지 않는다 — 풀 열쇠도 없다.
//! - **비밀 열쇠는 이 컴퓨터에 두지 않는다**(공개 저장소). 서버가 원본 서명을 다시 보고 받는 사람을 스스로 가린다.
//! - 연결은 연결 풀(relay_pool.rs)을 다시 쓴다. 200ms 모아 최대 50개씩 POST. **실패는 조용히 버린다** — 서버의 1분 확인이 예비다.
//! - 방 글은 레이븐 이야기 표(`#t ravencoin`)가 달린 것만 묻는다(세상의 모든 방 글을 받지 않게). 겉봉은 받는 이를 모르므로 종류로만 묻는다.

use serde_json::{json, Value};
use std::collections::{HashSet, VecDeque};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

/// 알림 서버의 「즉시 알림」 입구. 몸통 `{"events":[…]}`(최대 50개).
pub(crate) const NOTIFY_URL: &str = "https://mygroanhychotipukfzt.supabase.co/functions/v1/rv-talk/now";
/// 지켜볼 바깥 릴레이.
const WATCH: [&str; 3] = ["wss://playx.taile277f6.ts.net/relay", "wss://nos.lol", "wss://relay.primal.net"];
const BATCH_MAX: usize = 50;
const BATCH_WAIT: Duration = Duration::from_millis(200);
/// 끊긴 뒤 다시 붙기 전 기다림(늘어나다 1분에서 멈춘다).
const RETRY_MIN: Duration = Duration::from_secs(2);
const RETRY_MAX: Duration = Duration::from_secs(60);
/// 같은 글을 두 번 넘기지 않게 기억하는 수(세 릴레이가 같은 글을 준다).
const SEEN_MAX: usize = 4096;

static ON: AtomicBool = AtomicBool::new(false);

fn file() -> std::path::PathBuf {
    crate::paths::app_file("talk-push.json")
}

fn load_on() -> bool {
    std::fs::read_to_string(file())
        .ok()
        .and_then(|t| serde_json::from_str::<Value>(&t).ok())
        .and_then(|v| v.get("enabled").and_then(Value::as_bool))
        .unwrap_or(false)
}

/// 설정 읽기. `{ enabled, url }`
#[tauri::command]
pub fn talk_push_get() -> Value {
    json!({ "enabled": ON.load(Ordering::Relaxed) || load_on(), "url": NOTIFY_URL })
}

/// 켜기·끄기(디스크에 남긴다).
#[tauri::command]
pub fn talk_push_set(enabled: bool) -> Result<Value, String> {
    std::fs::write(file(), serde_json::to_vec(&json!({ "enabled": enabled })).unwrap_or_default())
        .map_err(|e| format!("설정을 저장하지 못했습니다: {e}"))?;
    ON.store(enabled, Ordering::Relaxed);
    if enabled {
        start();
    }
    Ok(talk_push_get())
}

/// 앱 시작 때 부른다. 꺼져 있으면 아무것도 안 한다. 켜면 릴레이마다 지키는 일꾼 하나 + 넘기는 일꾼 하나(프로세스에 한 번).
pub fn start() {
    if !(ON.load(Ordering::Relaxed) || load_on()) {
        return;
    }
    ON.store(true, Ordering::Relaxed);
    static STARTED: std::sync::Once = std::sync::Once::new();
    STARTED.call_once(|| {
        let (tx, rx) = tokio::sync::mpsc::unbounded_channel::<Value>();
        tauri::async_runtime::spawn(forward(rx));
        for url in WATCH {
            let tx = tx.clone();
            tauri::async_runtime::spawn(watch(url.to_string(), tx));
        }
    });
}

/// 지켜볼 물음: 지금 이후의 겉봉(1059) · 레이븐 이야기 방 글(42).
pub(crate) fn watch_req(since: i64) -> String {
    json!(["REQ", "np", { "kinds": [1059], "since": since }, { "kinds": [42], "#t": [crate::talk::TALK_TAG], "since": since }]).to_string()
}

/// 넘길 만한 글인가: 서명이 맞고, 지켜보는 종류이고, 방 글이면 우리 표가 있다.
pub(crate) fn worth_forwarding(e: &Value) -> bool {
    let kind = e.get("kind").and_then(Value::as_i64).unwrap_or(-1);
    let ours = e.get("tags").and_then(Value::as_array).is_some_and(|t| {
        t.iter().any(|x| x.get(0).and_then(Value::as_str) == Some("t") && x.get(1).and_then(Value::as_str) == Some(crate::talk::TALK_TAG))
    });
    (kind == 1059 || (kind == 42 && ours)) && crate::relay::verify(e)
}

fn now() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0)
}

/// 릴레이 한 곳을 계속 지켜본다. 끊기면(또는 릴레이가 닫으면) 조금 기다렸다 다시 — 마지막으로 본 시각부터.
async fn watch(url: String, tx: tokio::sync::mpsc::UnboundedSender<Value>) {
    use crate::relay_pool::Incoming;
    let mut since = now();
    let mut wait = RETRY_MIN;
    loop {
        if !ON.load(Ordering::Relaxed) {
            tokio::time::sleep(Duration::from_secs(10)).await;
            since = now();
            continue;
        }
        // 구독은 오래 열어 둔다 — 풀의 기한은 자리(구독 수)가 날 때까지만 쓴다.
        let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
        if let Ok(mut sub) = crate::relay_pool::subscribe(&url, &watch_req(since), deadline).await {
            wait = RETRY_MIN;
            while let Some(m) = sub.rx.recv().await {
                if !ON.load(Ordering::Relaxed) {
                    break;
                }
                match m {
                    Incoming::Event(e) => {
                        if let Some(at) = e.get("created_at").and_then(Value::as_i64) {
                            // 겉봉 시각은 이틀까지 앞당겨진다(NIP-59) — 다시 붙을 때는 「지금」 기준으로 잡는다.
                            since = since.max(at.min(now()));
                        }
                        if worth_forwarding(&e) {
                            let _ = tx.send(e);
                        }
                    }
                    Incoming::Eose => {}
                    Incoming::Closed(_) | Incoming::Gone(_) => break,
                }
            }
        }
        tokio::time::sleep(wait).await;
        wait = (wait * 2).min(RETRY_MAX);
        // 끊긴 동안 온 것은 서버의 1분 확인이 잡는다. 다시 붙을 때 조금 겹쳐 묻는다(같은 글은 넘기는 쪽이 거른다).
        since = since.min(now()) - 5;
    }
}

/// 모아서 넘긴다: 첫 글이 오고 200ms 동안 더 모으거나 50개가 차면 POST. 실패는 버린다.
async fn forward(mut rx: tokio::sync::mpsc::UnboundedReceiver<Value>) {
    let client = reqwest::Client::builder().timeout(Duration::from_secs(5)).build().unwrap_or_default();
    let mut seen: HashSet<String> = HashSet::new();
    let mut order: VecDeque<String> = VecDeque::new();
    while let Some(first) = rx.recv().await {
        let mut batch = vec![first];
        let until = tokio::time::Instant::now() + BATCH_WAIT;
        while batch.len() < BATCH_MAX {
            match tokio::time::timeout_at(until, rx.recv()).await {
                Ok(Some(e)) => batch.push(e),
                _ => break,
            }
        }
        let batch = take_new(batch, &mut seen, &mut order);
        if batch.is_empty() {
            continue;
        }
        let _ = client.post(NOTIFY_URL).json(&json!({ "events": batch })).send().await;
    }
}

/// 처음 보는 글만 남긴다(기억은 SEEN_MAX 개까지 — 오래된 것부터 잊는다).
pub(crate) fn take_new(batch: Vec<Value>, seen: &mut HashSet<String>, order: &mut VecDeque<String>) -> Vec<Value> {
    let mut out = Vec::new();
    for e in batch {
        let Some(id) = e.get("id").and_then(Value::as_str).map(str::to_string) else { continue };
        if !seen.insert(id.clone()) {
            continue;
        }
        order.push_back(id);
        while order.len() > SEEN_MAX {
            if let Some(old) = order.pop_front() {
                seen.remove(&old);
            }
        }
        out.push(e);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 서명된_겉봉과_우리_방_글만_넘기고_같은_글은_한_번만() {
        let wrap = crate::nostrpub::synthetic_signed_event(1059, json!([["p", "a".repeat(64)]]), "sealed", 51);
        let room = crate::nostrpub::synthetic_signed_event(42, json!([["e", "b".repeat(64), "", "root"], ["t", "ravencoin"]]), "안녕", 52);
        let other_room = crate::nostrpub::synthetic_signed_event(42, json!([["e", "b".repeat(64), "", "root"]]), "남의 앱", 53);
        let note = crate::nostrpub::synthetic_signed_event(1, json!([["t", "ravencoin"]]), "글", 54);
        let mut forged = wrap.clone();
        forged["content"] = json!("changed");
        assert!(worth_forwarding(&wrap) && worth_forwarding(&room));
        assert!(!worth_forwarding(&other_room) && !worth_forwarding(&note) && !worth_forwarding(&forged));
        let (mut seen, mut order) = (HashSet::new(), VecDeque::new());
        assert_eq!(take_new(vec![wrap.clone(), room.clone(), wrap.clone()], &mut seen, &mut order).len(), 2);
        assert!(take_new(vec![room], &mut seen, &mut order).is_empty(), "다른 릴레이가 준 같은 글");
        let req: Value = serde_json::from_str(&watch_req(100)).unwrap();
        assert_eq!(req[2]["kinds"], json!([1059]));
        assert_eq!(req[3]["#t"], json!(["ravencoin"]));
        assert_eq!(req[2]["since"], json!(100));
        assert!(NOTIFY_URL.starts_with("https://") && NOTIFY_URL.ends_with("/rv-talk/now"));
    }

    #[test]
    fn 기본은_꺼짐() {
        assert!(!ON.load(Ordering::Relaxed));
        assert!(!include_str!("talk_push.rs").contains(concat!("service", "_role")), "비밀 열쇠를 두지 않는다");
    }
}
