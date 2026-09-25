//! 데스크톱이 들고 있는 연결 상태 전부 — 기기 키·연결된 폰·「폰 요청」·설정 —
//! 와, 들어온 이벤트 하나를 「할 일」로 바꾸는 규칙.
//!
//! 파일은 앱 자료 폴더 `pairing/` 아래(폴더 0700, 파일 0600):
//!   device.json   — 이 컴퓨터의 **기기** 키(지갑 키 아님)
//!   peers.json    — 연결된 폰(통로 열쇠·권한·본 요청 id·seq — 재시작해도 재전송 차단 유지)
//!   requests.json — 「폰 요청」(24시간)
//!   settings.json — 공개 중계 예비 켜기 등
//! 🔴 1회용 코드 `c` 는 **어느 파일에도** 안 쓴다(host.rs 의 메모리에만).
//! 🔴 지갑 개인키·복구 단어·지갑 암호는 이 폴더 어디에도, 어떤 메시지에도 없다.

use super::host::*;
use super::proto::*;
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::collections::HashMap;
use std::future::Future;
use std::path::{Path, PathBuf};
use std::pin::Pin;

pub const REQUEST_TTL_MS: i64 = 24 * 60 * 60 * 1000;
/// 폰 승인 한도를 세는 창 — 「하루」를 **최근 24시간**으로 센다(자정을 끼고 두 배가 나가지 않게).
pub const LIMIT_WINDOW_MS: i64 = 24 * 60 * 60 * 1000;
/// 같은 이벤트가 두 길(같은 Wi-Fi·바깥)로 거의 동시에 오면 한 번만 처리한다.
const EVENT_DEDUP_MS: i64 = 60 * 1000;
/// 재전송(같은 요청 id)에 캐시한 답을 다시 보내는 간격 하한.
const RESEND_MIN_MS: i64 = 30 * 1000;
const MAX_REQUESTS: usize = 500;
/// 평문 4096B 안에 들게 몸통을 이만큼으로 줄인다(봉투 몫을 남긴다).
const BODY_BUDGET: usize = 3600;
pub const DEFAULT_DESK_NAME: &str = "RavenVault Desktop";
/// 공개 Nostr 예비(설정에서 켤 때만). 기존 nostrpub.rs 와 같은 세 곳.
pub const PUBLIC_RELAYS: [&str; 3] = ["wss://relay.damus.io", "wss://nos.lol", "wss://relay.primal.net"];

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct Settings {
    /// 공개 Nostr 예비 — 기본 끔.
    pub public_backup: bool,
    /// 대표가 정한 바깥 릴레이(wss://…/relay 또는 /api/relay). 최대 2개.
    pub extra_relays: Vec<String>,
    /// 마지막으로 폰에 알린 통로 목록(바뀌면 `relays` 를 보낸다).
    pub last_routes: Option<Value>,
    /// 화면이 알려 준 시간대(분). 매출 「오늘·이번 달」에만 쓴다. 기본 한국.
    pub tz_offset_min: Option<i64>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct PhoneRequest {
    pub id: String,
    pub peer: String,
    pub peer_name: String,
    pub t: String,
    pub body: Value,
    /// "desktop_confirm" | "process" | "auto"
    pub mode: String,
    /// waiting · waiting_unlock · sending · done · opened · declined · expired · failed · unknown
    pub status: String,
    pub received_at: i64,
    pub expires_at: i64,
    #[serde(default)]
    pub amount_sats: Option<u64>,
    #[serde(default)]
    pub txid: Option<String>,
    #[serde(default)]
    pub note: Option<String>,
}

/// 들어온 이벤트가 낳은 일. 돈·노드가 걸린 것은 잠금 밖에서(비동기로) 한다.
#[derive(Debug)]
pub enum Work {
    Publish(ChatEvent),
    View { peer: String, re: String, t: String },
    AutoSend { req: String },
    Changed,
}

pub struct Desk {
    dir: PathBuf,
    pub keys: DeviceKeys,
    pub host: Host,
    pub book: PeerBook,
    pub requests: Vec<PhoneRequest>,
    pub settings: Settings,
    /// (폰, 요청 id) → (답 이벤트, 마지막으로 보낸 때)
    replies: HashMap<(String, String), (ChatEvent, i64)>,
    recent_events: HashMap<String, i64>,
    /// 지난 QR 의 방(24시간) — 늦게 온 HELLO 도 디스크에 안 남게 릴레이가 알아본다.
    recent_pair_rooms: Vec<(String, i64)>,
    /// 버린 것의 **이유만** 센다(평문·열쇠는 안 남김).
    pub drops: HashMap<&'static str, u64>,
    /// 지금 보내는 중인 요청 — 두 길에서 같은 요청을 두 번 보내지 않게.
    pub in_flight: std::collections::HashSet<String>,
}

// ── 파일 ────────────────────────────────────────────────────────────────────

fn write_private(path: &Path, text: &str) -> Result<(), String> {
    use std::io::Write;
    let tmp = path.with_extension("tmp");
    let mut o = std::fs::OpenOptions::new();
    o.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        o.mode(0o600);
    }
    let mut f = o.open(&tmp).map_err(|e| format!("연결 기록을 쓰지 못했어요: {e}"))?;
    f.write_all(text.as_bytes()).map_err(|e| format!("연결 기록을 쓰지 못했어요: {e}"))?;
    f.sync_all().ok();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o600));
    }
    std::fs::rename(&tmp, path).map_err(|e| format!("연결 기록을 쓰지 못했어요: {e}"))
}
fn read_json<T: serde::de::DeserializeOwned + Default>(path: &Path) -> T {
    std::fs::read_to_string(path).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default()
}

impl Desk {
    /// 폴더를 열고(없으면 만들고) 기기 키를 읽는다. 키가 없으면 **지금** 만든다.
    pub fn open(dir: &Path) -> Result<Self, String> {
        std::fs::create_dir_all(dir).map_err(|e| format!("연결 폴더를 만들지 못했어요: {e}"))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700));
        }
        let dev = dir.join("device.json");
        let keys = match std::fs::read_to_string(&dev) {
            Ok(t) => DeviceKeys::decode_local(&t).map_err(|_| "이 컴퓨터의 연결 열쇠 파일이 망가졌어요. 「연결 다시 시작」으로 새로 만들 수 있어요.".to_string())?,
            Err(_) => {
                let k = DeviceKeys::generate().map_err(|_| "안전한 무작위 값을 만들지 못했어요.".to_string())?;
                write_private(&dev, &k.encode_local())?;
                k
            }
        };
        let book: PeerBook = read_json(&dir.join("peers.json"));
        let mut requests: Vec<PhoneRequest> = read_json(&dir.join("requests.json"));
        // 보내다가 앱이 꺼졌다 — 나갔는지 모른다. 다시 보내지 않고 「모름」으로 둔다.
        for r in requests.iter_mut().filter(|r| r.status == "sending") {
            r.status = "unknown".into();
        }
        let settings: Settings = read_json(&dir.join("settings.json"));
        Ok(Self {
            dir: dir.to_path_buf(),
            keys,
            host: Host::default(),
            book,
            requests,
            settings,
            replies: HashMap::new(),
            recent_events: HashMap::new(),
            recent_pair_rooms: Vec::new(),
            drops: HashMap::new(),
            in_flight: Default::default(),
        })
    }
    pub fn save_peers(&self) -> Result<(), String> {
        write_private(&self.dir.join("peers.json"), &serde_json::to_string(&self.book).unwrap_or_default())
    }
    pub fn save_requests(&self) -> Result<(), String> {
        write_private(&self.dir.join("requests.json"), &serde_json::to_string(&self.requests).unwrap_or_default())
    }
    pub fn save_settings(&self) -> Result<(), String> {
        write_private(&self.dir.join("settings.json"), &serde_json::to_string(&self.settings).unwrap_or_default())
    }

    // ── 방 ─────────────────────────────────────────────────────────────────

    /// 릴레이가 「이건 연결 방이라 디스크에 안 쓴다」를 판단할 방 목록.
    pub fn rooms(&mut self, now: i64) -> Vec<String> {
        self.recent_pair_rooms.retain(|(_, at)| now - at < 24 * 3600 * 1000);
        let mut r = self.book.rooms();
        if let Some(p) = self.host.pair_room(now) {
            r.push(p);
        }
        r.extend(self.recent_pair_rooms.iter().map(|(x, _)| x.clone()));
        r.sort();
        r.dedup();
        r
    }
    /// 바깥 릴레이에서 **들어야** 하는 방(지난 QR 방 제외).
    pub fn live_rooms(&mut self, now: i64) -> Vec<String> {
        let mut r = self.book.rooms();
        if let Some(p) = self.host.pair_room(now) {
            r.push(p);
        }
        r
    }

    pub fn desk_name(&self, shop_name: Option<&str>) -> String {
        shop_name.filter(|n| is_valid_name(n)).unwrap_or(DEFAULT_DESK_NAME).to_string()
    }

    pub fn show_qr(&mut self, name: &str, lan: Option<&str>, relays: &[String], now: i64) -> R<(String, i64, String)> {
        use rand::RngCore;
        if let Some(old) = self.host.pair_room(now) {
            self.recent_pair_rooms.push((old, now));
        }
        let mut code = [0u8; 16];
        rand::rngs::OsRng.fill_bytes(&mut code);
        let out = self.host.show_qr(&self.keys, name, lan, relays, now, code);
        wipe(&mut code);
        if let Ok((_, _, room)) = &out {
            self.recent_pair_rooms.push((room.clone(), now));
        }
        out
    }

    // ── 한도 ───────────────────────────────────────────────────────────────

    /// 이 폰이 「폰 승인」으로 최근 24시간에 쓴 것(나가는 중·잠금 풀리길 기다리는 것 포함), 사토시.
    pub fn spent_sats(&self, peer: &str, now: i64) -> u64 {
        self.requests
            .iter()
            .filter(|r| r.peer == peer && r.mode == "auto" && now - r.received_at < LIMIT_WINDOW_MS)
            .filter(|r| matches!(r.status.as_str(), "waiting_unlock" | "sending" | "done" | "unknown"))
            .filter_map(|r| r.amount_sats)
            .sum()
    }
    pub fn limit_left_rvn(&self, peer: &str, now: i64) -> f64 {
        let Some(p) = self.book.get(peer) else { return 0.0 };
        if p.perms.money != "phone" {
            return 0.0;
        }
        let limit = p.perms.daily_limit_rvn.saturating_mul(100_000_000);
        limit.saturating_sub(self.spent_sats(peer, now)) as f64 / 1e8
    }

    // ── 들어온 이벤트 ─────────────────────────────────────────────────────

    pub fn handle_event(&mut self, v: &Value, now: i64) -> Vec<Work> {
        let mut out = Vec::new();
        self.recent_events.retain(|_, at| now - *at < EVENT_DEDUP_MS);
        // 🔴 서명이 맞는 것만 「이미 봤음」에 적는다. 안 그러면 릴레이가 진짜 id 를 단 가짜를
        //    먼저 밀어 넣어 진짜 이벤트를 1분 동안 막을 수 있다.
        let Ok(ev) = verify_chat_event(v) else {
            self.count("bad_event");
            return out;
        };
        if self.recent_events.contains_key(&ev.id) {
            return out; // 같은 이벤트가 다른 길로 또 왔다
        }
        self.recent_events.insert(ev.id.clone(), now);
        let room = v.get("tags").and_then(|t| t.get(0)).and_then(|t| t.get(1)).and_then(Value::as_str).unwrap_or("");
        if self.host.pair_room(now).as_deref() == Some(room) {
            match self.host.receive_hello(&self.keys, v, now, SealOpts::default()) {
                HelloOutcome::Pending(_) => out.push(Work::Changed),
                HelloOutcome::Rejected { reply, .. } => out.push(Work::Publish(reply)),
                HelloOutcome::Drop(r) => self.count(r),
            }
            return out;
        }
        let spent: HashMap<String, f64> = self.book.peers.iter().map(|p| (p.sign.clone(), self.spent_sats(&p.sign, now) as f64 / 1e8)).collect();
        let got = receive(&mut self.book, &self.keys, v, now, &|s| spent.get(s).copied().unwrap_or(0.0));
        match got {
            Received::Drop { reason, re, peer } => {
                self.count(reason);
                // 재전송: 캐시한 답이 있으면(30초에 한 번까지) 다시 보낸다.
                if let (Some(re), Some(peer)) = (re, peer) {
                    if let Some((ev, last)) = self.replies.get_mut(&(peer, re)) {
                        if now - *last >= RESEND_MIN_MS {
                            *last = now;
                            out.push(Work::Publish(ev.clone()));
                        }
                    }
                }
                return out;
            }
            Received::Unpaired { peer, room, .. } => {
                self.recent_pair_rooms.push((room, now));
                self.forget_peer(&peer);
                out.push(Work::Changed);
            }
            Received::Denied { peer, message, reply, .. } => {
                let re = message["id"].as_str().unwrap_or("").to_string();
                self.replies.insert((peer, re), (reply.clone(), now));
                out.push(Work::Publish(reply));
            }
            Received::Accepted { peer, message, mode } => self.accepted(&peer, &message, mode, now, &mut out),
        }
        let _ = self.save_peers();
        out
    }

    fn count(&mut self, reason: &'static str) {
        *self.drops.entry(reason).or_default() += 1;
    }

    fn accepted(&mut self, peer: &str, m: &Value, mode: &'static str, now: i64, out: &mut Vec<Work>) {
        let t = m["t"].as_str().unwrap_or("").to_string();
        let re = m["id"].as_str().unwrap_or("").to_string();
        match t.as_str() {
            "ping" => {
                if let Ok((ev, _)) = send(&mut self.book, &self.keys, peer, "pong", json!({}), now, None, SealOpts::default()) {
                    out.push(Work::Publish(ev));
                }
            }
            "pong" => {}
            "view.wallet" | "view.certs" | "view.sales" => out.push(Work::View { peer: peer.into(), re, t }),
            "req.cert" | "req.guestqr" | "req.send" => {
                // 🔴 폰이 비밀 이름의 칸을 실어 보내면 받지 않는다(폰 쪽 버그라도 여기 쌓이면 안 된다).
                if assert_no_secret_fields(&m["body"], 0).is_err() {
                    self.reply(peer, &re, "denied", json!({ "re": re, "reason": "bad_request" }), now, out);
                    return;
                }
                if self.requests.iter().any(|r| r.id == re && r.peer == peer) {
                    return;
                }
                let name = self.book.get(peer).map(|p| p.name.clone()).unwrap_or_default();
                let amount_sats = m["body"]["amount_rvn"].as_f64().and_then(rvn_to_sats);
                let status = if mode == "auto" { "sending" } else { "waiting" };
                self.requests.push(PhoneRequest {
                    id: re.clone(),
                    peer: peer.into(),
                    peer_name: name,
                    t: t.clone(),
                    body: clean_body(&m["body"]),
                    mode: mode.into(),
                    status: status.into(),
                    received_at: now,
                    expires_at: now + REQUEST_TTL_MS,
                    amount_sats: if mode == "auto" { amount_sats } else { None },
                    txid: None,
                    note: None,
                });
                self.trim_requests(now);
                let _ = self.save_requests();
                out.push(Work::Changed);
                if mode == "auto" {
                    out.push(Work::AutoSend { req: re });
                } else {
                    let status = if t == "req.guestqr" { "queued" } else { "desktop_confirm" };
                    self.reply(peer, &re, "req.status", json!({ "re": re, "status": status }), now, out);
                }
            }
            _ => {}
        }
    }

    /// 답을 봉해 내보내고, 재전송에 대비해 기억한다.
    pub fn reply(&mut self, peer: &str, re: &str, t: &str, body: Value, now: i64, out: &mut Vec<Work>) {
        match send(&mut self.book, &self.keys, peer, t, body, now, None, SealOpts::default()) {
            Ok((ev, _)) => {
                self.replies.retain(|_, (_, at)| now - *at < REQUEST_TTL_MS);
                if self.replies.len() > 2000 {
                    self.replies.clear();
                }
                self.replies.insert((peer.to_string(), re.to_string()), (ev.clone(), now));
                out.push(Work::Publish(ev));
                let _ = self.save_peers();
            }
            Err(e) => self.count(e.0),
        }
    }

    fn trim_requests(&mut self, now: i64) {
        self.requests.retain(|r| now - r.received_at < REQUEST_TTL_MS * 2);
        while self.requests.len() > MAX_REQUESTS {
            self.requests.remove(0);
        }
    }

    /// 사장의 「허락」. 같은 폰을 다시 연결하면 옛 통로 방이 빠지는데, 끊기와 같이 하루 동안
    /// 「연결 방」으로 기억해야 그 방으로 늦게 오는 글이 가게 글처럼 디스크에 남지 않는다.
    #[allow(clippy::too_many_arguments)]
    pub fn approve(&mut self, perms: &Perms, desk_name: &str, lan: Option<&str>, relays: &[String], now: i64, opts: SealOpts) -> R<(ChatEvent, Peer)> {
        let before = self.book.rooms();
        let r = self.host.approve(&self.keys, &mut self.book, perms, desk_name, lan, relays, now, opts);
        let after = self.book.rooms();
        self.recent_pair_rooms.extend(before.into_iter().filter(|x| !after.contains(x)).map(|x| (x, now)));
        r
    }

    pub fn forget_peer(&mut self, peer: &str) {
        // 끊은 뒤에 그 방으로 오는 글도 디스크에 남지 않게 하루 동안 「연결 방」으로 기억한다.
        if let Some(p) = self.book.get(peer) {
            self.recent_pair_rooms.push((p.ch_room.clone(), crate::pairing::now_ms()));
        }
        self.book.remove(peer);
        self.replies.retain(|(p, _), _| p != peer);
        for r in self.requests.iter_mut().filter(|r| r.peer == peer && matches!(r.status.as_str(), "waiting" | "waiting_unlock")) {
            r.status = "declined".into();
            r.note = Some("unpaired".into());
        }
        let _ = self.save_peers();
        let _ = self.save_requests();
    }

    /// 사장이 「연결 끊기」. 여기서는 **즉시** 끊기고, 폰에게는 알림을 보낸다.
    pub fn unpair(&mut self, peer: &str, now: i64) -> Option<ChatEvent> {
        if let Some(p) = self.book.get(peer) {
            self.recent_pair_rooms.push((p.ch_room.clone(), now));
        }
        let ev = unpair(&mut self.book, &self.keys, peer, now);
        self.forget_peer(peer);
        ev
    }

    // ── 주기적으로 ─────────────────────────────────────────────────────────

    /// 허락 시간 초과 → reject/expired, 24시간 지난 요청 → 만료 알림.
    pub fn tick(&mut self, now: i64) -> Vec<Work> {
        let mut out = Vec::new();
        if let Some(ev) = self.host.expire_pending(&self.keys, now) {
            out.push(Work::Publish(ev));
            out.push(Work::Changed);
        }
        self.host.gc(now);
        let mut expired = Vec::new();
        for r in self.requests.iter_mut() {
            if matches!(r.status.as_str(), "waiting" | "waiting_unlock" | "opened") && now > r.expires_at {
                r.status = "expired".into();
                expired.push((r.peer.clone(), r.id.clone()));
            }
        }
        if !expired.is_empty() {
            for (peer, re) in expired {
                if self.book.get(&peer).is_some() {
                    self.reply(&peer, &re, "req.status", json!({ "re": re, "status": "rejected", "note": "expired" }), now, &mut out);
                }
            }
            let _ = self.save_requests();
            out.push(Work::Changed);
        }
        self.trim_requests(now);
        out
    }

    /// 통로 목록이 바뀌었으면 연결된 폰 전부에게 `relays` 를 보낸다.
    pub fn routes_changed(&mut self, lan: Option<&str>, relays: &[String], now: i64) -> Vec<Work> {
        let routes = json!({ "lan": lan, "relays": relays });
        if self.settings.last_routes.as_ref() == Some(&routes) {
            return Vec::new();
        }
        self.settings.last_routes = Some(routes.clone());
        let _ = self.save_settings();
        let mut out = Vec::new();
        let signs: Vec<String> = self.book.peers.iter().map(|p| p.sign.clone()).collect();
        for s in signs {
            if let Ok((ev, _)) = send(&mut self.book, &self.keys, &s, "relays", routes.clone(), now, None, SealOpts::default()) {
                out.push(Work::Publish(ev));
            }
        }
        let _ = self.save_peers();
        out
    }

    /// 지갑이 잠겨서 기다리던 폰 승인 보내기를 다시 본다. 🔴 **지금의** 권한·한도로 다시 판정한다
    /// (그 사이 사장이 「데스크톱 확인」으로 바꿨으면 데스크톱 확인으로 넘긴다).
    pub fn retry_unlock(&mut self, now: i64) -> Vec<Work> {
        let mut out = Vec::new();
        let ids: Vec<(String, String)> = self.requests.iter().filter(|r| r.status == "waiting_unlock").map(|r| (r.id.clone(), r.peer.clone())).collect();
        for (id, peer) in ids {
            let ok = match self.book.get(&peer) {
                Some(p) => {
                    let limit = p.perms.daily_limit_rvn.saturating_mul(100_000_000);
                    p.perms.request && p.perms.money == "phone" && self.spent_sats(&peer, now) <= limit
                }
                None => false,
            };
            if ok {
                out.push(Work::AutoSend { req: id });
            } else if let Some(r) = self.request_mut(&id) {
                r.status = "waiting".into();
                r.mode = "desktop_confirm".into();
                r.amount_sats = None;
                let _ = self.save_requests();
                if self.book.get(&peer).is_some() {
                    self.reply(&peer, &id, "req.status", json!({ "re": id, "status": "desktop_confirm" }), now, &mut out);
                }
                out.push(Work::Changed);
            }
        }
        out
    }

    pub fn request_mut(&mut self, id: &str) -> Option<&mut PhoneRequest> {
        self.requests.iter_mut().find(|r| r.id == id)
    }
}

/// 화면에 보여 주고 저장할 몸통 — 글·숫자·참거짓만, 길이도 자른다.
fn clean_body(b: &Value) -> Value {
    let mut out = Map::new();
    if let Some(o) = b.as_object() {
        for (k, v) in o.iter().take(24) {
            let key: String = k.chars().take(40).collect();
            let val = match v {
                Value::String(s) => Value::String(s.chars().take(500).collect()),
                Value::Number(_) | Value::Bool(_) => v.clone(),
                Value::Array(a) => Value::Array(a.iter().take(60).filter_map(|x| x.as_str().map(|s| Value::String(s.chars().take(80).collect()))).collect()),
                _ => continue,
            };
            out.insert(key, val);
        }
    }
    Value::Object(out)
}

/// 목록을 4096B 평문 안에 넣는다. 잘랐으면 `more` 에 뺀 개수.
pub fn fit_list(mut body: Value, key: &str) -> Value {
    let total = body[key].as_array().map(|a| a.len()).unwrap_or(0);
    loop {
        let n = body[key].as_array().map(|a| a.len()).unwrap_or(0);
        if serde_json::to_string(&body).map(|s| s.len()).unwrap_or(0) <= BODY_BUDGET || n == 0 {
            break;
        }
        if let Some(a) = body[key].as_array_mut() {
            a.truncate(n * 3 / 4);
        }
        body["more"] = json!(total - body[key].as_array().map(|a| a.len()).unwrap_or(0));
    }
    body
}

// ── 노드·장부에 닿는 쪽 (가짜로 바꿔 시험한다) ─────────────────────────────

pub type BoxFut<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

pub trait Backend: Send + Sync {
    /// {balance_rvn, assets:[{name,amount}]} — 주인 자격(`NAME!`)은 뺀다.
    fn wallet(&self) -> BoxFut<'_, Result<Value, String>>;
    /// [{id,name,date(ms),count}]
    fn certs(&self) -> Result<Vec<Value>, String>;
    /// {today:{rvn,count}, month:{rvn,count}}
    fn sales(&self, now_ms: i64, tz_offset_min: i64) -> Result<Value, String>;
    fn wallet_locked(&self) -> BoxFut<'_, Result<bool, String>>;
    /// 기존 보내기 길(`send::send_rvn`, 암호 없이 — 잠겨 있으면 실패). 거래 번호.
    fn send_rvn<'a>(&'a self, to: &'a str, amount_rvn: f64) -> BoxFut<'a, Result<String, String>>;
}

/// 할 일을 한다. `lock` 은 Desk 를 잠깐씩만 잡는다(노드를 기다리는 동안 안 잡는다).
pub async fn run_work<L, P>(works: Vec<Work>, lock: &L, backend: &dyn Backend, publish: &P, now: &(dyn Fn() -> i64 + Sync))
where
    L: Fn(&mut dyn FnMut(&mut Desk)) + Sync,
    P: Fn(ChatEvent) + Sync,
{
    let mut queue = works;
    while !queue.is_empty() {
        let mut next = Vec::new();
        for w in queue {
            match w {
                Work::Publish(ev) => publish(ev),
                Work::Changed => {}
                Work::View { peer, re, t } => {
                    let body = match t.as_str() {
                        "view.wallet" => match backend.wallet().await {
                            Ok(mut b) => {
                                b["locked"] = json!(backend.wallet_locked().await.unwrap_or(true));
                                Some(b)
                            }
                            Err(_) => None,
                        },
                        "view.certs" => backend.certs().ok().map(|c| json!({ "certs": c })),
                        _ => {
                            let mut tz = 540;
                            lock(&mut |d| tz = d.settings.tz_offset_min.unwrap_or(540));
                            backend.sales(now(), tz).ok()
                        }
                    };
                    lock(&mut |d| {
                        let at = now();
                        let (rt, b) = match &body {
                            Some(b) => {
                                let mut b = b.clone();
                                b["re"] = json!(re);
                                if t == "view.wallet" {
                                    if let Some(p) = d.book.get(&peer) {
                                        b["perms"] = p.perms.to_value();
                                    }
                                    b["limit_left_rvn"] = json!(d.limit_left_rvn(&peer, at));
                                }
                                let key = if t == "view.wallet" { "assets" } else { "certs" };
                                (format!("{t}.r"), fit_list(b, key))
                            }
                            // 노드가 안 답하면 「못 읽음」을 정직하게. 없는 값을 0 으로 채우지 않는다.
                            None => ("denied".to_string(), json!({ "re": re, "reason": "unavailable" })),
                        };
                        d.reply(&peer, &re, &rt, b, at, &mut next);
                    });
                }
                Work::AutoSend { req } => {
                    let mut job: Option<(String, String, f64)> = None;
                    lock(&mut |d| {
                        if d.in_flight.contains(&req) {
                            return;
                        }
                        if let Some(r) = d.request_mut(&req) {
                            if matches!(r.status.as_str(), "sending" | "waiting_unlock") {
                                job = Some((r.peer.clone(), r.body["to"].as_str().unwrap_or("").to_string(), r.body["amount_rvn"].as_f64().unwrap_or(0.0)));
                            }
                        }
                        if job.is_some() {
                            d.in_flight.insert(req.clone());
                        }
                    });
                    let Some((peer, to, amount)) = job else { continue };
                    let locked = backend.wallet_locked().await.unwrap_or(true);
                    if locked {
                        lock(&mut |d| {
                            let at = now();
                            let first = d.request_mut(&req).map(|r| {
                                let first = r.status != "waiting_unlock";
                                r.status = "waiting_unlock".into();
                                r.note = Some("wallet_locked".into());
                                first
                            });
                            let _ = d.save_requests();
                            if first == Some(true) {
                                d.reply(&peer, &req, "req.status", json!({ "re": req, "status": "queued", "note": "wallet_locked" }), at, &mut next);
                            }
                            d.in_flight.remove(&req);
                        });
                        continue;
                    }
                    lock(&mut |d| {
                        if let Some(r) = d.request_mut(&req) {
                            r.status = "sending".into();
                        }
                        let _ = d.save_requests();
                    });
                    let result = backend.send_rvn(&to, amount).await;
                    lock(&mut |d| {
                        let at = now();
                        let (status, body) = match &result {
                            Ok(txid) => ("done", json!({ "re": req, "status": "done", "txid": txid })),
                            Err(e) if e.starts_with(crate::raven::SENT_UNKNOWN) => {
                                ("unknown", json!({ "re": req, "status": "failed", "note": "unknown" }))
                            }
                            Err(_) => ("failed", json!({ "re": req, "status": "failed", "note": "send_failed" })),
                        };
                        if let Some(r) = d.request_mut(&req) {
                            r.status = status.into();
                            r.txid = result.as_ref().ok().cloned();
                            if status == "failed" {
                                // 확실히 안 나간 것은 한도에서 뺀다(상태가 failed 라 합계에 안 잡힌다).
                                r.note = Some("send_failed".into());
                            }
                        }
                        let _ = d.save_requests();
                        d.in_flight.remove(&req);
                        let mut body = body;
                        body["limit_left_rvn"] = json!(d.limit_left_rvn(&peer, at));
                        d.reply(&peer, &req, "req.status", body, at, &mut next);
                    });
                }
            }
        }
        queue = next;
    }
}
