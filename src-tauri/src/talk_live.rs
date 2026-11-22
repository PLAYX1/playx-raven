//! **이야기 실시간 받기** — 새 쪽지·방 글·나에게 단 답이 오면 화면에 곧바로 알린다(제미나이 D1).
//!
//! 예전에는 화면이 몇 초마다 물었다(방 5초/45초 · 쪽지 15초/60초 · 알림 30초). 카톡처럼 느끼려면
//! 「보낸 쪽 즉시 · 상대가 열어 둔 화면 2초」가 목표다(페이블 D). 그래서 바깥 기본 릴레이마다 구독 하나를
//! 열어 두고(연결 풀 relay_pool — 이미 미리 붙어 있다), 새 글이 오면 Tauri 사건 `talk-live` 로 알린다.
//! 화면은 받은 즉시 원래의 읽기 함수를 부른다(그리는 길은 그대로). 묻기 바퀴는 끊겼을 때 대비로만 길게 남는다.
//!
//! 지켜보는 것(지금 이후만): 나에게 온 겉봉(1059 #p=나) · 레이븐 이야기 방 글(42 #t) · 나를 부른 글·반응(1·7 #p=나).
//! 받은 글은 이 컴퓨터 릴레이에도 둔다(absorb — 받는 규칙은 손님이 올릴 때와 같다) — 다음 「먼저 그리기」가 바로 그린다.
//! 🔴 남에게 아무것도 보내지 않는다. 묻기만 한다(내 공개키가 물음에 들어가는 것은 이미 하던 쪽지 묻기와 같다).

use serde_json::{json, Value};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;
use tauri::Emitter;

static UP: AtomicUsize = AtomicUsize::new(0);

/// 지켜볼 물음.
pub(crate) fn live_req(me: &str, since: i64) -> String {
    json!(["REQ", "lv",
        { "kinds": [1059], "#p": [me], "since": since - 2 * 86_400, "limit": 0 },
        { "kinds": [42], "#t": [crate::talk::TALK_TAG], "since": since, "limit": 0 },
        { "kinds": [1, 7], "#p": [me], "since": since, "limit": 0 }
    ]).to_string()
}

/// 화면에 알릴 것: (종류, 방 번호). 서명이 맞고 지켜보는 종류일 때만.
pub(crate) fn notice_of(e: &Value, me: &str) -> Option<Value> {
    let kind = e.get("kind").and_then(Value::as_i64)?;
    let tag = |name: &str| -> Vec<String> {
        e.get("tags").and_then(Value::as_array).map(|t| t.iter()
            .filter(|x| x.get(0).and_then(Value::as_str) == Some(name))
            .filter_map(|x| x.get(1).and_then(Value::as_str).map(str::to_string)).collect()).unwrap_or_default()
    };
    let ok = match kind {
        1059 | 1 | 7 => tag("p").iter().any(|p| p == me),
        42 => tag("t").iter().any(|t| t == crate::talk::TALK_TAG),
        _ => false,
    };
    if !ok || !crate::relay::verify(e) { return None; }
    let room = if kind == 42 { tag("e").into_iter().next() } else { None };
    Some(json!({ "kind": kind, "id": e.get("id"), "room": room }))
}

fn now() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0)
}

fn set_up(app: &tauri::AppHandle, delta: isize) {
    let n = if delta > 0 { UP.fetch_add(1, Ordering::SeqCst) + 1 } else { UP.fetch_sub(1, Ordering::SeqCst).saturating_sub(1) };
    let _ = app.emit("talk-live-state", json!({ "up": n > 0 }));
}

/// 지금 바깥 구독이 하나라도 살아 있나(화면이 묻기 바퀴를 길게 할지 고른다).
#[tauri::command]
pub fn talk_live_status() -> Value { json!({ "up": UP.load(Ordering::SeqCst) > 0 }) }

/// 앱을 켤 때 한 번. 이야기 이름(열쇠)이 생길 때까지 기다렸다가 기본 릴레이마다 지켜본다.
pub fn start(app: tauri::AppHandle) {
    static STARTED: std::sync::Once = std::sync::Once::new();
    STARTED.call_once(|| {
        let seen = std::sync::Arc::new(std::sync::Mutex::new(std::collections::VecDeque::<String>::new()));
        for url in crate::nostrpub::outside_relays() {
            let app = app.clone();
            let seen = seen.clone();
            tauri::async_runtime::spawn(watch(url, app, seen));
        }
    });
}

async fn watch(url: String, app: tauri::AppHandle, seen: std::sync::Arc<std::sync::Mutex<std::collections::VecDeque<String>>>) {
    use crate::relay_pool::Incoming;
    tokio::time::sleep(Duration::from_secs(8)).await;
    let mut wait = Duration::from_secs(5);
    let mut since = now();
    loop {
        let Some(me) = crate::relay::owner_pub() else {
            tokio::time::sleep(Duration::from_secs(30)).await;
            since = now();
            continue;
        };
        let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
        if let Ok(mut sub) = crate::relay_pool::subscribe(&url, &live_req(&me, since), deadline).await {
            wait = Duration::from_secs(5);
            set_up(&app, 1);
            while let Some(m) = sub.rx.recv().await {
                match m {
                    Incoming::Event(e) => {
                        if let Some(at) = e.get("created_at").and_then(Value::as_i64) { since = since.max(at.min(now())); }
                        // 이야기 이름을 바꿨으면 새 이름으로 다시 묻는다.
                        if crate::relay::owner_pub().as_deref() != Some(me.as_str()) { break; }
                        let Some(n) = notice_of(&e, &me) else { continue };
                        let id = n["id"].as_str().unwrap_or("").to_string();
                        {
                            let mut s = seen.lock().unwrap_or_else(|x| x.into_inner());
                            if s.contains(&id) { continue; } // 세 릴레이가 같은 글을 준다
                            s.push_back(id);
                            while s.len() > 2048 { s.pop_front(); }
                        }
                        crate::relay::absorb(vec![e]);
                        let _ = app.emit("talk-live", n);
                    }
                    Incoming::Eose => {}
                    Incoming::Closed(_) | Incoming::Gone(_) => break,
                }
            }
            set_up(&app, -1);
        }
        tokio::time::sleep(wait).await;
        wait = (wait * 2).min(Duration::from_secs(120));
        // 끊긴 사이 온 글은 화면의 긴 묻기 바퀴가 줍는다. 조금 겹쳐 묻는다.
        since = since.min(now()) - 5;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_my_mail_raven_rooms_and_mentions_are_announced() {
        let me = crate::shopkey::pubkey_of(&[7u8; 32]).unwrap();
        let t = now();
        let sign = |kind: i64, tags: Value| crate::shopkey::sign_with(&[9u8; 32], kind, tags, "x", t).unwrap();
        let room = "a".repeat(64);
        let n = notice_of(&sign(42, json!([["e", room, "", "root"], ["t", "ravencoin"]])), &me).unwrap();
        assert_eq!((n["kind"].as_i64(), n["room"].as_str()), (Some(42), Some(room.as_str())));
        assert!(notice_of(&sign(42, json!([["e", "b".repeat(64)]])), &me).is_none(), "레이븐 표 없는 방 글");
        assert!(notice_of(&sign(1059, json!([["p", me.clone()]])), &me).is_some());
        assert!(notice_of(&sign(1059, json!([["p", "c".repeat(64)]])), &me).is_none(), "남에게 간 겉봉");
        assert!(notice_of(&sign(1, json!([["p", me.clone()]])), &me).is_some());
        assert!(notice_of(&sign(1, json!([["t", "ravencoin"]])), &me).is_none(), "나를 안 부른 글은 화면 바퀴가 줍는다");
        let mut bad = sign(1059, json!([["p", me.clone()]]));
        bad["content"] = json!("y");
        assert!(notice_of(&bad, &me).is_none(), "서명이 틀린 것");
        let req: Value = serde_json::from_str(&live_req(&me, t)).unwrap();
        assert_eq!(req[2]["#p"][0], me);
        assert_eq!(req[2]["since"], t - 2 * 86_400, "겉봉 시각은 이틀 앞당겨진다");
    }
}
