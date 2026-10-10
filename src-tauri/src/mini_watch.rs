//! 미니 창 지켜보기 — 노드에게 **읽기만** 묻는다(listsinceblock·getbalance·getwalletinfo·
//! getblockchaininfo·getconnectioncount). 보내기·잠금 풀기 같은 부름은 여기 없다.
//!
//! ## 왜 큰 창(main.ts 지갑감시)과 따로 도나
//!
//! 큰 창의 감시는 **웹뷰 타이머**다. 창을 닫으면(트레이로 숨기면) 운영체제가 숨은 웹뷰의
//! 타이머를 늦추거나 멈출 수 있다 — 바로 그때가 미니 창이 떠 있는 때다. 그래서 Rust 에서 돈다.
//!
//! ## 언제 묻나 — 쓸 때만
//!
//! 미니 창이 보이거나, 미니 창을 한 번 써 본 사람이 OS 알림을 켜 두었을 때만 묻는다
//! (`mini::watch_wanted`). 안 써 본 사람의 노드에는 질문이 하나도 늘지 않는다.
//!
//! | 무엇 | 주기 | 노드 부담 |
//! |---|---|---|
//! | 지갑 변화(listsinceblock, 마지막 지점 이후만) | 15초 | 작음 — 새 줄만 온다 |
//! | 잔액·잠금 | 60초(변화가 있으면 즉시) | 작음 |
//! | 노드 높이·연결 | 60초 | 작음 |
//!
//! 🔴 지갑이 잠겨 있어도(비밀번호가 필요한 상태) 위 질문은 모두 답한다 — 잠금은 **쓰기**(서명)만
//! 막는다. 그래서 잠긴 채로도 입금 **감지**는 된다(docs/mini-window.md 「한계」).

use crate::mini::{self, Mini};
use crate::mini_feed::{self, Event, Kind};
use crate::raven::call_rpc;
use serde_json::json;
use tauri::Manager;

pub const TICK_SECS: u64 = 15;
/// 처음 기준선을 잡을 때 거슬러 올라가는 블록 수(약 하루 + 여유). 「오늘 요약」에 필요하다.
const BASELINE_BLOCKS: u64 = 1600;

pub fn start(app: tauri::AppHandle) {
    tauri::async_runtime::spawn(async move {
        let mut n: u64 = 0;
        loop {
            if mini::watch_wanted(&app) {
                tick(&app, n).await;
                n = n.wrapping_add(1);
            }
            tokio::time::sleep(std::time::Duration::from_secs(TICK_SECS)).await;
        }
    });
}

async fn wallet_rows(cursor: Option<String>, need: i64) -> Result<serde_json::Value, String> {
    let from = match cursor {
        Some(c) => c,
        None => {
            let h = call_rpc("getblockcount", json!([])).await?.as_u64().unwrap_or(0);
            call_rpc("getblockhash", json!([h.saturating_sub(BASELINE_BLOCKS)]))
                .await?
                .as_str()
                .unwrap_or("")
                .to_string()
        }
    };
    if from.is_empty() {
        return Err("no block".into());
    }
    call_rpc("listsinceblock", json!([from, need, true])).await
}

async fn tick(app: &tauri::AppHandle, n: u64) {
    let s = mini::settings(app);
    let need = s.need as i64;
    let now = mini::now();
    let cursor = app.state::<Mini>().feed.lock().unwrap_or_else(|e| e.into_inner()).cursor.clone();
    let rows = wallet_rows(cursor, need).await;
    let mut changed = false;
    let mut events: Vec<Event> = Vec::new();
    {
        let mini = app.state::<Mini>();
        let mut f = mini.feed.lock().unwrap_or_else(|e| e.into_inner());
        match &rows {
            Ok(v) => {
                let list = mini_feed::rows_from_listsinceblock(v);
                changed = !list.is_empty() || !f.tracker.has_baseline();
                events.extend(f.tracker.ingest(list, need, now));
                if let Some(lb) = v["lastblock"].as_str().filter(|s| s.len() == 64) {
                    f.cursor = Some(lb.to_string());
                }
            }
            Err(e) if e == crate::words_restore::RESCANNING_SAY => events.extend(f.health.rescanning(now)),
            Err(_) => events.extend(f.health.error(now)),
        }
    }
    // 잔액·잠금·노드는 1분마다, 지갑에 변화가 있으면 바로.
    if rows.is_ok() && (changed || n % 4 == 0) {
        let bal = match (call_rpc("getbalance", json!([])).await, call_rpc("getunconfirmedbalance", json!([])).await) {
            (Ok(c), u) => Some((c.as_f64().unwrap_or(0.0), u.ok().and_then(|u| u.as_f64()).unwrap_or(0.0))),
            _ => None,
        };
        let lock = match crate::raven::wallet_lock_state().await {
            Ok(v) if v["encrypted"] == false => "none",
            Ok(v) if v["unlocked"] == false => "locked",
            Ok(_) => "open",
            Err(_) => "unknown",
        };
        let mini = app.state::<Mini>();
        let mut f = mini.feed.lock().unwrap_or_else(|e| e.into_inner());
        f.balance = bal.or(f.balance);
        f.lock = lock.into();
    }
    if rows.is_ok() && n % 4 == 0 {
        let info = call_rpc("getblockchaininfo", json!([])).await;
        let peers = call_rpc("getconnectioncount", json!([])).await;
        let mini = app.state::<Mini>();
        let mut f = mini.feed.lock().unwrap_or_else(|e| e.into_inner());
        match (info, peers) {
            (Ok(i), Ok(p)) => events.extend(f.health.observe(
                i["blocks"].as_u64().unwrap_or(0),
                i["headers"].as_u64().unwrap_or(0),
                p.as_i64().unwrap_or(0),
                now,
            )),
            _ => events.extend(f.health.error(now)),
        }
    }
    // 장사 모드인데 잠들지 않게 못 붙잡고 있으면 한 번 알린다.
    let awake = crate::awake::awake_status();
    // why 가 비어 있지 않다 = 붙잡아야 하는 상태(장사·재색인). 그런데 holding 이 거짓이면 실패다.
    let lost = awake["why"] != "" && !awake["holding"].as_bool().unwrap_or(false);
    {
        let mini = app.state::<Mini>();
        let mut f = mini.feed.lock().unwrap_or_else(|e| e.into_inner());
        if lost && !f.awake_lost {
            events.push(Event::node(Kind::AwakeLost, now));
        }
        f.awake_lost = lost;
        for e in events {
            f.bundler.push(e);
        }
    }
    mini::deliver(app);
    mini::push_snapshot(app);
}
