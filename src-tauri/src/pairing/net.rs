//! 통로 — 이벤트가 어디서 들어오고 어디로 나가나.
//!
//! * **이 컴퓨터의 릴레이**(`relay.rs`, `/api/relay`, 같은 Wi-Fi 와 「바깥에서 열기」 터널 둘 다):
//!   연결 방의 이벤트는 같은 프로그램 안에서 바로 여기로 온다(자기 자신에게 웹소켓을 걸지 않는다).
//!   🔴 연결 방 이벤트는 `relay-events.json` 에 **안 쓴다** — 메모리에만, 24시간.
//! * **바깥 릴레이**(대표가 정한 서버, 공개 Nostr 예비 — 기본 끔): 여기서 손님으로 붙어
//!   연결된 폰의 방과 지금 QR 의 방을 듣고, 답도 거기에 올린다.
//!   터널 주소는 이 컴퓨터 자신이라 손님으로 붙지 않는다.

use super::desk::*;
use super::proto::*;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, RwLock};

static DESK: Mutex<Option<Desk>> = Mutex::new(None);
static ROOMS: RwLock<Option<HashSet<String>>> = RwLock::new(None);
static STARTED: AtomicBool = AtomicBool::new(false);
static CLIENTS: Mutex<Option<HashMap<String, tokio::sync::mpsc::UnboundedSender<Cmd>>>> = Mutex::new(None);

enum Cmd {
    Publish(Value),
    Rooms(Vec<String>),
}

pub fn dir() -> std::path::PathBuf {
    crate::paths::app_dir().join("pairing")
}

/// 연결 기능을 켠 적이 있나(기기 키 파일이 있나). 없으면 아무것도 만들지 않는다.
pub fn ever_enabled() -> bool {
    dir().join("device.json").exists()
}

/// Desk 를 잠깐 잡는다. `create` 가 거짓이면 연결 기능을 켠 적 없을 때 None.
pub fn with_desk<T>(create: bool, f: impl FnOnce(&mut Desk) -> T) -> Result<Option<T>, String> {
    let mut g = DESK.lock().unwrap_or_else(|e| e.into_inner());
    if g.is_none() {
        if !create && !ever_enabled() {
            return Ok(None);
        }
        *g = Some(Desk::open(&dir())?);
    }
    let d = g.as_mut().expect("desk");
    let out = f(d);
    refresh_rooms(d);
    Ok(Some(out))
}
/// 이미 열려 있을 때만(시험·릴레이가 앱 자료 폴더를 건드리지 않게).
fn with_open_desk(f: &mut dyn FnMut(&mut Desk)) {
    let mut g = DESK.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(d) = g.as_mut() {
        f(d);
        refresh_rooms(d);
    }
}

fn refresh_rooms(d: &mut Desk) {
    let rooms: HashSet<String> = d.rooms(super::now_ms()).into_iter().collect();
    let mut g = ROOMS.write().unwrap_or_else(|e| e.into_inner());
    *g = Some(rooms);
}

/// 릴레이가 묻는다 — 이 방은 연결 방인가(→ 디스크에 안 쓰고 여기로 넘긴다).
pub fn is_pairing_room(room: &str) -> bool {
    ROOMS.read().map(|g| g.as_ref().map(|s| s.contains(room)).unwrap_or(false)).unwrap_or(false)
}
#[cfg(test)]
pub fn test_mark_room(room: &str) {
    let mut g = ROOMS.write().unwrap();
    g.get_or_insert_with(HashSet::new).insert(room.to_string());
}

/// 연결 방 이벤트 하나가 들어왔다(이 컴퓨터 릴레이 또는 바깥 릴레이에서).
pub fn on_event(v: Value) {
    tauri::async_runtime::spawn(async move {
        let mut works = Vec::new();
        with_open_desk(&mut |d| works = d.handle_event(&v, super::now_ms()));
        process(works).await;
    });
}

pub async fn process(works: Vec<Work>) {
    if works.is_empty() {
        return;
    }
    let lock = |f: &mut dyn FnMut(&mut Desk)| with_open_desk(f);
    run_work(works, &lock, backend(), &publish, &super::now_ms).await;
}

/// 시험(e2e)만 가짜 노드로 바꿔 끼운다. 🔴 `cfg(test)` 밖에서는 언제나 진짜 노드다.
#[cfg(test)]
pub static TEST_BACKEND: std::sync::OnceLock<Box<dyn Backend>> = std::sync::OnceLock::new();
/// 시험(e2e)만: 같은 Wi-Fi 통로 주소를 이것으로 알린다(사설 IP 모양 그대로 — 검사는 안 푼다).
#[cfg(test)]
pub static TEST_LAN: Mutex<Option<String>> = Mutex::new(None);

fn backend() -> &'static dyn Backend {
    #[cfg(test)]
    if let Some(b) = TEST_BACKEND.get() {
        return b.as_ref();
    }
    &RealBackend
}

/// 데스크톱이 봉한 답을 내보낸다 — 이 컴퓨터 릴레이(메모리, 열린 구독에 바로) + 바깥 릴레이.
pub fn publish(ev: ChatEvent) {
    let v = ev.to_value();
    crate::relay::publish_ephemeral(v.clone());
    let g = CLIENTS.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(m) = g.as_ref() {
        for tx in m.values() {
            let _ = tx.send(Cmd::Publish(v.clone()));
        }
    }
}

/// 폰에게 알려 줄 통로: 같은 Wi-Fi(`l`) + 바깥(`r`, 최대 3).
pub fn routes(extra: &[String]) -> (Option<String>, Vec<String>) {
    #[cfg(test)]
    let test_lan = TEST_LAN.lock().unwrap_or_else(|e| e.into_inner()).clone().filter(|u| is_lan_relay_url(u));
    #[cfg(not(test))]
    let test_lan: Option<String> = None;
    let lan = if test_lan.is_some() {
        test_lan
    } else if crate::server::relay_live() {
        crate::server::lan_ip().map(|ip| format!("ws://{ip}:{}/api/relay", crate::server::PORT)).filter(|u| is_lan_relay_url(u))
    } else {
        None
    };
    let mut relays = Vec::new();
    if let Some(u) = crate::tunnel::tunnel_status()["url"].as_str() {
        let w = format!("{}/api/relay", u.trim_end_matches('/').replacen("https://", "wss://", 1));
        if is_remote_relay_url(&w) {
            relays.push(w);
        }
    }
    for e in extra {
        if relays.len() < MAX_RELAYS && is_remote_relay_url(e) && !relays.contains(e) {
            relays.push(e.clone());
        }
    }
    (lan, relays)
}

/// 한 번만 켠다. 5초마다: 허락 시간·요청 만료·잠금 풀린 보내기 다시·통로 바뀜 알림·바깥 릴레이 맞추기.
pub fn start() {
    if STARTED.swap(true, Ordering::SeqCst) {
        return;
    }
    // 연결한 적이 있으면 장부를 연다(없으면 아무것도 만들지 않는다).
    let _ = with_desk(false, |_| ());
    tauri::async_runtime::spawn(async {
        let mut n: u64 = 0;
        loop {
            tokio::time::sleep(std::time::Duration::from_secs(5)).await;
            n += 1;
            let now = super::now_ms();
            let mut works = Vec::new();
            with_open_desk(&mut |d| works = d.tick(now));
            // 지갑이 풀렸으면 기다리던 폰 승인 보내기를 다시(30초마다 본다).
            if n.is_multiple_of(6) {
                let has = { let mut h = false; with_open_desk(&mut |d| h = d.requests.iter().any(|r| r.status == "waiting_unlock")); h };
                if has && !backend().wallet_locked().await.unwrap_or(true) {
                    with_open_desk(&mut |d| works.extend(d.retry_unlock(now)));
                }
            }
            if n.is_multiple_of(2) {
                let mut extra = Vec::new();
                let mut any = false;
                with_open_desk(&mut |d| {
                    extra = d.settings.extra_relays.clone();
                    any = !d.book.peers.is_empty();
                });
                if any {
                    let (lan, relays) = tokio::task::spawn_blocking(move || routes(&extra)).await.unwrap_or((None, Vec::new()));
                    with_open_desk(&mut |d| works.extend(d.routes_changed(lan.as_deref(), &relays, now)));
                }
                reconcile_clients();
            }
            process(works).await;
        }
    });
}

// ── 바깥 릴레이에 손님으로 붙기 ────────────────────────────────────────────

fn wanted_outside() -> (Vec<String>, Vec<String>) {
    let mut urls = Vec::new();
    let mut rooms = Vec::new();
    with_open_desk(&mut |d| {
        rooms = d.live_rooms(super::now_ms());
        urls.extend(d.settings.extra_relays.iter().filter(|u| is_remote_relay_url(u)).cloned());
        if d.settings.public_backup {
            urls.extend(PUBLIC_RELAYS.iter().map(|s| s.to_string()));
        }
    });
    if rooms.is_empty() {
        urls.clear();
    }
    (urls, rooms)
}

/// 원하는 바깥 릴레이만 붙어 있게 하고, 듣는 방 목록을 알려 준다.
pub fn reconcile_clients() {
    let (urls, rooms) = wanted_outside();
    let mut g = CLIENTS.lock().unwrap_or_else(|e| e.into_inner());
    let m = g.get_or_insert_with(HashMap::new);
    m.retain(|u, _| urls.contains(u)); // 보내는 쪽을 버리면 그 작업이 끝난다
    for u in urls {
        if let Some(tx) = m.get(&u) {
            let _ = tx.send(Cmd::Rooms(rooms.clone()));
            continue;
        }
        let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
        let _ = tx.send(Cmd::Rooms(rooms.clone()));
        m.insert(u.clone(), tx);
        tauri::async_runtime::spawn(client(u, rx));
    }
}

fn req_for(rooms: &[String]) -> String {
    json!(["REQ", "rv6", { "kinds": [42], "#e": rooms, "since": super::now_ms() / 1000 - 86_400, "limit": 200 }]).to_string()
}

async fn client(url: String, mut rx: tokio::sync::mpsc::UnboundedReceiver<Cmd>) {
    use futures_util::{SinkExt, StreamExt};
    use tokio_tungstenite::tungstenite::Message;
    let mut rooms: Vec<String> = Vec::new();
    let mut outbox: VecDeque<Value> = VecDeque::new();
    let mut backoff = 2u64;
    loop {
        let conn = tokio::time::timeout(std::time::Duration::from_secs(8), tokio_tungstenite::connect_async(url.as_str())).await;
        let mut ws = match conn {
            Ok(Ok((ws, _))) => {
                backoff = 2;
                ws
            }
            _ => {
                // 기다리는 동안에도 명령은 받는다. 보내는 쪽이 사라지면 끝.
                let until = tokio::time::Instant::now() + std::time::Duration::from_secs(backoff);
                backoff = (backoff * 2).min(120);
                loop {
                    tokio::select! {
                        _ = tokio::time::sleep_until(until) => break,
                        c = rx.recv() => match c {
                            None => return,
                            Some(Cmd::Publish(v)) => { outbox.push_back(v); while outbox.len() > 100 { outbox.pop_front(); } }
                            Some(Cmd::Rooms(r)) => rooms = r,
                        },
                    }
                }
                continue;
            }
        };
        if !rooms.is_empty() && ws.send(Message::Text(req_for(&rooms))).await.is_err() {
            continue;
        }
        while let Some(v) = outbox.pop_front() {
            let _ = ws.send(Message::Text(json!(["EVENT", v]).to_string())).await;
        }
        loop {
            tokio::select! {
                m = ws.next() => match m {
                    Some(Ok(Message::Text(t))) => {
                        if t.len() > 64 * 1024 { continue; }
                        let Ok(a) = serde_json::from_str::<Value>(&t) else { continue };
                        if a.get(0).and_then(Value::as_str) == Some("EVENT") {
                            if let Some(e) = a.get(2) {
                                let room = e.get("tags").and_then(|t| t.get(0)).and_then(|t| t.get(1)).and_then(Value::as_str).unwrap_or("");
                                // 우리 방 것만. 바깥 릴레이가 엉뚱한 것을 밀어 넣어도 여기서 끝난다.
                                if rooms.iter().any(|r| r == room) {
                                    on_event(e.clone());
                                }
                            }
                        }
                    }
                    Some(Ok(_)) => {}
                    _ => break,
                },
                c = rx.recv() => match c {
                    None => { let _ = ws.close(None).await; return; }
                    Some(Cmd::Publish(v)) => { let _ = ws.send(Message::Text(json!(["EVENT", v]).to_string())).await; }
                    Some(Cmd::Rooms(r)) => {
                        if r != rooms {
                            rooms = r;
                            let _ = ws.send(Message::Text(json!(["CLOSE", "rv6"]).to_string())).await;
                            if !rooms.is_empty() { let _ = ws.send(Message::Text(req_for(&rooms))).await; }
                        }
                    }
                },
            }
        }
    }
}

// ── 진짜 노드·장부 ─────────────────────────────────────────────────────────

pub struct RealBackend;

impl Backend for RealBackend {
    fn wallet(&self) -> BoxFut<'_, Result<Value, String>> {
        Box::pin(async {
            let bal = crate::raven::call_rpc("getbalance", json!([])).await?;
            let mine = crate::raven::call_rpc("listmyassets", json!([])).await.unwrap_or(json!({}));
            let mut assets: Vec<Value> = mine
                .as_object()
                .map(|m| m.iter().filter(|(n, _)| !n.ends_with('!')).map(|(n, a)| json!({ "name": n, "amount": a.as_f64().unwrap_or(0.0) })).collect())
                .unwrap_or_default();
            assets.sort_by(|a, b| a["name"].as_str().cmp(&b["name"].as_str()));
            Ok(json!({ "balance_rvn": bal.as_f64().unwrap_or(0.0), "assets": assets }))
        })
    }
    fn certs(&self) -> Result<Vec<Value>, String> {
        Ok(crate::create_history::create_history_list()?
            .into_iter()
            .filter(|e| e["kind"] == "certificate")
            .map(|e| {
                json!({
                    "id": e["id"], "name": e["title"],
                    "date": e["done_at"].as_i64().unwrap_or(0) * 1000,
                    "count": e["count"],
                })
            })
            .collect())
    }
    fn sales(&self, now_ms: i64, tz: i64) -> Result<Value, String> {
        let today = crate::ledger::local_ymd(now_ms / 1000, tz);
        let month_start = today / 100 * 100 + 1;
        let d = crate::ledger::ledger_range(today, today, tz, None);
        let m = crate::ledger::ledger_range(month_start, today, tz, None);
        let pick = |v: &Value| json!({ "rvn": v["total_rvn"].as_f64().unwrap_or(0.0), "count": v["sales"].as_i64().unwrap_or(0) });
        Ok(json!({ "today": pick(&d), "month": pick(&m) }))
    }
    fn wallet_locked(&self) -> BoxFut<'_, Result<bool, String>> {
        Box::pin(async {
            let s = crate::raven::wallet_lock_state().await?;
            Ok(!s["unlocked"].as_bool().unwrap_or(false))
        })
    }
    fn send_rvn<'a>(&'a self, to: &'a str, amount_rvn: f64) -> BoxFut<'a, Result<String, String>> {
        // 🔴 기존 보내기 길 그대로(주소 확인·잠금 확인·refund 기록). 암호는 넘기지 않는다 —
        //    잠겨 있으면 여기서 실패하고, 부르는 쪽은 그 전에 잠금을 확인해 대기열에 둔다.
        Box::pin(crate::send::send_rvn(to.to_string(), amount_rvn, Some("폰 요청 (RV6 폰 승인)".into()), None))
    }
}
