//! **우체국 다리** — 핵심 우체국이 겉봉(kind 1059)을 새로 맡은 순간, 알림 서버(rv-talk)에 「이 사람 앞 이 번호」만 알린다.
//!
//! 11-29 대표: 「비밀은 적을수록 좋다.」 → 공유 비밀 없이, 이 컴퓨터 **이야기 열쇠**로 서명한 요청(NIP-98 모양 kind 27235)으로 인증한다.
//! 서버는 `/api/post-offices` 에 `role: core` 로 적힌 그 `pubkey` 만 믿는다(목록에 채우기 전에는 403 — 그동안은 1분 확인이 받친다).
//!
//! ## 약속(서버 rv-talk/bridge · ravenvault docs/handoff/PUSH-CORE-AND-DEVICE-LOCK-1129.md)
//! - 몸통 `{"event": <kind 27235>}` — 태그 `u` = [`BRIDGE_URL`], `method` = POST, 60초 안, content = `{"items":[{"p","id"}…]}`(20줄까지).
//! - 같은 서명은 한 번만 쓰인다(서버 used_auth) — 보낼 때마다 새로 서명한다.
//! - 서버 상한: 우체국당 분당 600 요청 · 3000 줄. 여기서는 그 절반 아래로 스스로 묶는다.
//!
//! ## 🔴 지키는 것
//! - **핵심 우체국일 때만** 일한다(역할 Core + 우체국 켜짐). 사용자 데스크탑(도우미)은 아무것도 보내지 않는다.
//! - **원본 글·평문은 보내지 않는다** — 받는 사람 공개키(p)와 겉봉 번호(id)뿐. 서버가 직접 가져와 서명을 검사한다.
//! - 실패는 버린다(1분 확인이 받친다). 403·429 면 잠시 쉰다.
//! - 끄기: 환경 변수 `RV_TALK_BRIDGE=off`.

use serde_json::{json, Value};
use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

pub const BRIDGE_URL: &str = "https://mygroanhychotipukfzt.supabase.co/functions/v1/rv-talk/bridge";
/// 모으는 시간 — 첫 겉봉부터 이만큼 기다렸다 한꺼번에.
pub const BATCH_MS: u64 = 200;
/// 한 요청의 줄 수(서버 BRIDGE_MAX_ITEMS).
pub const MAX_ITEMS: usize = 20;
/// 기다리는 줄의 상한(넘치면 버린다).
pub const QUEUE_CAP: usize = 2_000;
/// 이 컴퓨터가 스스로 묶는 분당 상한(서버 600 요청 · 3000 줄의 절반 아래).
pub const PER_MIN_REQ: usize = 240;
pub const PER_MIN_ITEMS: usize = 1_200;
/// 서버가 「모르는 우체국」(403)이라 하면 쉬는 시간 — N100 pubkey 가 목록에 아직 없을 때.
pub const FORBIDDEN_PAUSE_SECS: i64 = 10 * 60;
/// 429(너무 빠름)·연결 실패가 이어질 때 쉬는 시간.
pub const SLOW_PAUSE_SECS: i64 = 60;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Item {
    pub p: String,
    pub id: String,
}

fn now_secs() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0)
}

fn is_hex64(s: &str) -> bool {
    s.len() == 64 && s.bytes().all(|b| b.is_ascii_hexdigit())
}

/// 다리가 일하는가: 핵심 + 우체국 켜짐 + 끄기 스위치 아님.
pub fn active() -> bool {
    if std::env::var("RV_TALK_BRIDGE").map(|v| v.eq_ignore_ascii_case("off")).unwrap_or(false) {
        return false;
    }
    let s = crate::post_office::setting();
    s.on && s.role == crate::post_office::Role::Core
}

/// 겉봉에서 (p, id) 를 뽑는다 — kind 1059 · 둘 다 64자 hex 일 때만.
pub fn item_of(e: &Value) -> Option<Item> {
    if e.get("kind").and_then(Value::as_i64) != Some(crate::post_office::KIND_WRAP) {
        return None;
    }
    let id = e.get("id").and_then(Value::as_str)?.to_ascii_lowercase();
    let p = crate::post_office::wrap_recipient(e)?.to_ascii_lowercase();
    (is_hex64(&id) && is_hex64(&p)).then_some(Item { p, id })
}

/// 요청 서명(kind 27235). content 는 서버가 그대로 JSON 으로 읽는 `{"items":[…]}`.
pub fn auth_event(sk: &[u8; 32], items: &[Item], now: i64) -> Result<Value, String> {
    let content = json!({ "items": items.iter().map(|i| json!({ "p": i.p, "id": i.id })).collect::<Vec<_>>() }).to_string();
    crate::shopkey::sign_with(sk, 27235, json!([["u", BRIDGE_URL], ["method", "POST"]]), &content, now)
}

/// 보낼 몸통.
pub fn body(sk: &[u8; 32], items: &[Item], now: i64) -> Result<String, String> {
    Ok(json!({ "event": auth_event(sk, items, now)? }).to_string())
}

/// 분당 창(요청 수·줄 수).
struct Window {
    start: Option<Instant>,
    req: usize,
    items: usize,
}

impl Window {
    const fn new() -> Self {
        Window { start: None, req: 0, items: 0 }
    }
    /// 이 요청을 보내도 되나(되면 센다).
    fn take(&mut self, n: usize, at: Instant) -> bool {
        if self.start.is_none_or(|s| at.duration_since(s) >= Duration::from_secs(60)) {
            *self = Window { start: Some(at), req: 0, items: 0 };
        }
        if self.req + 1 > PER_MIN_REQ || self.items + n > PER_MIN_ITEMS {
            return false;
        }
        self.req += 1;
        self.items += n;
        true
    }
}

struct Queue {
    items: Vec<Item>,
    dropped: u64,
}

static QUEUE: Mutex<Queue> = Mutex::new(Queue { items: Vec::new(), dropped: 0 });
static WINDOW: Mutex<Window> = Mutex::new(Window::new());
static FLUSH_PENDING: AtomicBool = AtomicBool::new(false);
static PAUSED_UNTIL: AtomicI64 = AtomicI64::new(0);

/// 줄에 넣는다. 처음 넣은 것이면 true(그때 모으기 시계를 건다).
fn enqueue(it: Item) -> bool {
    let mut q = QUEUE.lock().unwrap_or_else(|e| e.into_inner());
    if q.items.iter().any(|x| x == &it) {
        return false;
    }
    if q.items.len() >= QUEUE_CAP {
        q.dropped += 1;
        return false;
    }
    q.items.push(it);
    true
}

fn drain() -> Vec<Item> {
    std::mem::take(&mut QUEUE.lock().unwrap_or_else(|e| e.into_inner()).items)
}

/// 핵심 우체국이 손님·폰에게서 새 겉봉을 맡았을 때 부른다(relay.rs). 핵심이 아니면 아무것도 안 한다.
pub fn note(e: &Value) {
    if !active() {
        return;
    }
    let Some(it) = item_of(e) else { return };
    if now_secs() < PAUSED_UNTIL.load(Ordering::Relaxed) {
        return;
    }
    if !enqueue(it) || cfg!(test) {
        return;
    }
    if FLUSH_PENDING.swap(true, Ordering::SeqCst) {
        return;
    }
    tauri::async_runtime::spawn(async {
        tokio::time::sleep(Duration::from_millis(BATCH_MS)).await;
        FLUSH_PENDING.store(false, Ordering::SeqCst);
        flush().await;
    });
}

async fn flush() {
    let all = drain();
    if all.is_empty() {
        return;
    }
    let Some((sk, _, _)) = crate::talk::key_on_disk() else { return };
    let Ok(client) = reqwest::Client::builder().timeout(Duration::from_secs(5)).build() else { return };
    for chunk in all.chunks(MAX_ITEMS) {
        if now_secs() < PAUSED_UNTIL.load(Ordering::Relaxed) {
            return;
        }
        if !WINDOW.lock().unwrap_or_else(|e| e.into_inner()).take(chunk.len(), Instant::now()) {
            return; // 이번 분은 넘쳤다 — 나머지는 버린다(1분 확인이 받친다).
        }
        let Ok(b) = body(&sk, chunk, now_secs()) else { return };
        let r = client.post(BRIDGE_URL).header("content-type", "application/json").body(b).send().await;
        match r.map(|r| r.status().as_u16()) {
            Ok(200..=299) => {}
            Ok(403) => {
                PAUSED_UNTIL.store(now_secs() + FORBIDDEN_PAUSE_SECS, Ordering::Relaxed);
                return;
            }
            Ok(429) | Ok(500..=599) | Err(_) => {
                PAUSED_UNTIL.store(now_secs() + SLOW_PAUSE_SECS, Ordering::Relaxed);
                return;
            }
            Ok(_) => {}
        }
    }
}

/// 건강 상태·설정 화면용(사람 정보 없음).
pub fn state_json() -> Value {
    let q = QUEUE.lock().unwrap_or_else(|e| e.into_inner());
    json!({
        "active": active(),
        "waiting": q.items.len(),
        "dropped": q.dropped,
        "paused_until": PAUSED_UNTIL.load(Ordering::Relaxed),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sk(b: u8) -> [u8; 32] {
        let mut k = [0u8; 32];
        k[31] = b.max(1);
        k
    }

    fn wrap_to(p: &str, n: u8) -> Value {
        crate::shopkey::sign_with(&sk(n.wrapping_add(50)), 1059, json!([["p", p]]), "봉투", now_secs()).unwrap()
    }

    #[test]
    fn auth_event_matches_server_contract() {
        let p = crate::shopkey::pubkey_of(&sk(2)).unwrap();
        let items = vec![Item { p: p.clone(), id: "a".repeat(64) }];
        let e = auth_event(&sk(9), &items, 1_000).unwrap();
        assert_eq!(e["kind"], 27235);
        assert!(crate::relay::verify(&e), "서명이 맞아야 한다");
        let tags = e["tags"].as_array().unwrap();
        assert!(tags.iter().any(|t| t[0] == "u" && t[1] == BRIDGE_URL));
        assert!(tags.iter().any(|t| t[0] == "method" && t[1] == "POST"));
        let c: Value = serde_json::from_str(e["content"].as_str().unwrap()).unwrap();
        assert_eq!(c, json!({ "items": [{ "p": p, "id": "a".repeat(64) }] }));
        let b: Value = serde_json::from_str(&body(&sk(9), &items, 1_000).unwrap()).unwrap();
        assert_eq!(b["event"]["pubkey"], crate::shopkey::pubkey_of(&sk(9)).unwrap());
        // 평문·원본 겉봉은 몸통에 없다.
        assert!(!b.to_string().contains("봉투"));
    }

    #[test]
    fn item_only_from_wraps() {
        let p = crate::shopkey::pubkey_of(&sk(3)).unwrap();
        let w = wrap_to(&p, 1);
        assert_eq!(item_of(&w), Some(Item { p: p.clone(), id: w["id"].as_str().unwrap().to_string() }));
        let note = crate::shopkey::sign_with(&sk(4), 1, json!([["p", p]]), "x", now_secs()).unwrap();
        assert_eq!(item_of(&note), None);
    }

    #[test]
    fn only_core_queues() {
        let p = crate::shopkey::pubkey_of(&sk(5)).unwrap();
        crate::post_office::set_role(crate::post_office::Role::Helper, None, None);
        crate::post_office::TEST_ON.with(|c| c.set(true));
        // 줄은 프로세스 전체라 다른 시험이 섞일 수 있다 — 이 시험의 p 만 센다.
        let mine = |v: Vec<Item>| v.into_iter().filter(|i| i.p == p).count();
        note(&wrap_to(&p, 7));
        assert_eq!(mine(drain()), 0, "도우미는 아무것도 안 보낸다");
        crate::post_office::set_role(crate::post_office::Role::Core, None, None);
        crate::post_office::TEST_ON.with(|c| c.set(false));
        note(&wrap_to(&p, 8));
        assert_eq!(mine(drain()), 0, "우체국이 꺼져 있으면 안 보낸다");
        crate::post_office::TEST_ON.with(|c| c.set(true));
        let w = wrap_to(&p, 9);
        note(&w);
        note(&w); // 같은 겉봉은 한 줄
        assert_eq!(mine(drain()), 1);
        crate::post_office::set_role(crate::post_office::Role::Helper, None, None);
        crate::post_office::TEST_ON.with(|c| c.set(false));
    }

    #[test]
    fn window_limits_requests_and_items() {
        let mut w = Window::new();
        let t = Instant::now();
        assert!(w.take(MAX_ITEMS, t));
        let mut n = 1;
        while w.take(MAX_ITEMS, t) {
            n += 1;
        }
        assert_eq!(n, PER_MIN_ITEMS / MAX_ITEMS, "줄 상한에서 멈춘다");
        assert!(w.take(1, t + Duration::from_secs(61)), "1분 뒤에는 다시");
    }
}
