//! 이야기 속도 재기(11-12 「카톡처럼 평소에 쓸 만큼 빠르게」). **진짜 릴레이**에 묻는다 — 그래서 늘 도는 시험이 아니다.
//!
//! ```text
//! cargo test --release --lib talk_bench -- --ignored --nocapture --test-threads=1
//! ```
//!
//! 잰다: 광장 열기(글 → 이름표) · 방 목록 · 방 열기 · 보내기(바깥 첫 OK).
//! 보내기는 **서명을 일부러 틀린** 글을 보낸다 — 릴레이가 「invalid」 OK 로 답하는 왕복만 재고, 세상에 글은 남지 않는다.
//! 「차가움」= 앱을 막 켠 첫 물음, 「따뜻함」= 같은 앱에서 바로 다음 물음(연결 풀이 있으면 연결을 다시 안 연다).

use serde_json::{json, Value};
use std::time::Instant;

const OUTSIDE: [&str; 3] = ["wss://playx.taile277f6.ts.net/relay", "wss://nos.lol", "wss://relay.primal.net"];

fn ms(t: Instant) -> u128 {
    t.elapsed().as_millis()
}

fn bogus_event() -> Value {
    let mut e = crate::nostrpub::synthetic_signed_event(1, json!([["t", "rv-speed-probe"]]), "speed probe (bad signature, never stored)", 99);
    e["sig"] = json!("0".repeat(128));
    e
}

/// 바깥 세 곳에 동시에 보내고, 처음 답한 곳까지의 시간.
async fn send_first_outside() -> (u128, String) {
    use futures_util::stream::{FuturesUnordered, StreamExt};
    let msg = serde_json::to_string(&json!(["EVENT", bogus_event()])).unwrap();
    let t = Instant::now();
    let mut runs: FuturesUnordered<_> = OUTSIDE
        .iter()
        .map(|u| {
            let msg = msg.clone();
            async move { (u.to_string(), crate::nostrpub::send_one(u, &msg).await) }
        })
        .collect();
    while let Some((u, r)) = runs.next().await {
        // 거절(invalid)도 답이다 — 왕복이 끝났다.
        let answered = match &r { Ok(()) => true, Err(e) => !e.contains("연결") && !e.contains("답이 없") };
        if answered {
            return (ms(t), u);
        }
    }
    (ms(t), "없음".into())
}

async fn one_round(label: &str) {
    // 광장: 글 → 이름표(화면은 이름표까지 받고 그린다).
    let t = Instant::now();
    let feed = crate::talk_social::talk_feed(false, None, Some(60)).await;
    let feed_ms = ms(t);
    let notes = feed.as_ref().ok().and_then(|v| v["notes"].as_array().cloned()).unwrap_or_default();
    let mut who: Vec<String> = notes.iter().filter_map(|e| e["pubkey"].as_str().map(str::to_string)).collect();
    who.sort();
    who.dedup();
    let t2 = Instant::now();
    let _ = crate::talk::talk_profiles(who, None).await;
    let names_ms = ms(t2);

    let t = Instant::now();
    let rooms = crate::talk::talk_rooms(None).await.unwrap_or(json!([]));
    let rooms_ms = ms(t);
    let room = rooms.as_array().and_then(|a| a.first()).and_then(|r| r["id"].as_str()).map(str::to_string);

    let (room_ms, room_n) = match &room {
        Some(id) => {
            let t = Instant::now();
            let got = crate::talk::talk_read(Some(id.clone()), Some(60)).await;
            (ms(t), got.ok().and_then(|v| v.as_array().map(|a| a.len())).unwrap_or(0))
        }
        None => (0, 0),
    };
    let (send_ms, first) = send_first_outside().await;
    #[cfg(not(feature = "bench-before"))]
    {
        // 「먼저 그리기」: 이 컴퓨터 릴레이 저장분(바깥에서 읽은 글을 둔 것)에서 곧바로.
        tokio::time::sleep(std::time::Duration::from_millis(300)).await; // absorb 가 뒤에서 끝나게
        let t = Instant::now();
        let f = crate::talk_fast::talk_view(None, Some(false), Some(60), Some(true), None, None).await.unwrap();
        let lf = t.elapsed().as_micros();
        let t = Instant::now();
        let r = crate::talk_fast::talk_view(room.clone(), None, Some(60), Some(true), None, None).await.unwrap();
        let lr = t.elapsed().as_micros();
        let t = Instant::now();
        let lrooms = crate::talk::talk_rooms(Some(true)).await.unwrap();
        let lro = t.elapsed().as_micros();
        // 새 글만(since): 방금 받은 가장 새 시각 − 120초 이후만.
        let newest = notes.iter().filter_map(|e| e["created_at"].as_i64()).max().unwrap_or(0);
        let t = Instant::now();
        let inc = crate::talk_fast::talk_view(None, Some(false), Some(60), Some(false), Some(newest - 120), None).await.unwrap();
        let inc_ms = ms(t);
        println!(
            "[{label}] 먼저 그리기(이 컴퓨터): 광장 {lf}µs({}개) · 방 {lr}µs({}개) · 방 목록 {lro}µs({}개) · 새 글만 광장 {inc_ms}ms({}개)",
            f["notes"].as_array().map(|a| a.len()).unwrap_or(0),
            r["notes"].as_array().map(|a| a.len()).unwrap_or(0),
            lrooms.as_array().map(|a| a.len()).unwrap_or(0),
            inc["notes"].as_array().map(|a| a.len()).unwrap_or(0),
        );
    }
    println!(
        "[{label}] 광장 글 {feed_ms}ms({}개) + 이름표 {names_ms}ms = 첫 글 보임 {}ms · 방 목록 {rooms_ms}ms({}개) · 방 열기 {room_ms}ms({room_n}개) · 보내기 첫 OK {send_ms}ms({first})",
        notes.len(),
        feed_ms + names_ms,
        rooms.as_array().map(|a| a.len()).unwrap_or(0),
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore]
async fn talk_speed_against_real_relays() {
    one_round("차가움 1").await;
    #[cfg(not(feature = "bench-before"))]
    {
        // 앱을 켜면 warm_all 로 미리 붙는다 — 그 뒤 처음 여는 경우.
        tokio::time::sleep(std::time::Duration::from_secs(3)).await;
        crate::nostrpub::warm_all();
        tokio::time::sleep(std::time::Duration::from_secs(2)).await;
    }
    one_round("따뜻함 1").await;
    one_round("따뜻함 2").await;
}
