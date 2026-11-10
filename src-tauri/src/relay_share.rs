//! 「릴레이 나누기」 — 레이븐볼트 데스크탑끼리 서로 릴레이가 되어 준다. 규약 정본: docs/RELAY-SHARE.md
//!
//! ## 하는 일 (켠 사람만 · 기본 꺼짐)
//!
//! 1. **내 주소 알리기**(§1): 바깥 주소(「바깥에서 열기」 터널)가 있고, 그 주소로 스스로 들어와 REQ→EOSE 가
//!    되는 것을 확인한 때에만 이야기 열쇠로 kind 10002 를 올린다. 주소가 바뀌면 다시, 끄면 내 주소를 뺀 것을 다시.
//! 2. **이웃 찾기**(§3): 6시간마다 `#t ravenvault-relay` 10002 를 묻고, 검사(§2)·접속 시험을 통과한 곳 중 최대 8곳.
//!    내 이야기 글(0·1·5·40·41·42)을 올릴 때 이웃에도 같이 보내고(기다리지 않음), 읽을 때 이웃도 묻는다.
//! 3. **글쓴이 릴레이에서 읽기**(§4, 기본 켬): 화면에 보이는 글쓴이의 10002 에 적힌 주소(사람당 ≤ 2)에서도 그 사람 글을 묻는다.
//! 4. **내 글 다시 올리기**(§5, 기본 켬): 6시간마다 내 최근 30일 글이 기본 릴레이에 있는지 보고 빠진 것만 다시 보낸다.
//!
//! ## 🔴 지키는 것
//!
//! - 접속 전에 모든 주소를 §2 로 검사한다(wss 만 · IP 숫자 주소·localhost·사설 이름 금지 · 포트 443 · 길이 제한).
//!   이름이 사설 주소로 풀리는 것(DNS 로 속이기)도 접속 직전에 한 번 더 막는다.
//! - 이웃 8곳 · 글쓴이 릴레이 동시 6곳 · 모든 추가 연결 5초. 느린 곳은 기다리지 않는다.
//! - 내가 지운 글(내 kind 5 가 가리키는 id)은 절대 다시 올리지 않는다. 한 번에 50개까지.
//! - 지갑 정보는 어디로도 보내지 않는다. 오가는 것은 이미 공개된 서명된 이야기 글과 10002 뿐이다.
//! - 배경에서 이야기 열쇠를 새로 만들지 않는다(`talk::key_on_disk`).

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

/// 레이븐볼트 데스크탑 릴레이라는 표(찾기용).
pub const SHARE_TAG: &str = "ravenvault-relay";
pub const LIST_KIND: i64 = 10002;
/// 10002 에 같이 적는 기본 릴레이(§1 순서 그대로).
pub const DEFAULT_RELAYS: [&str; 4] = [
    "wss://playx.taile277f6.ts.net/relay",
    "wss://relay.primal.net",
    "wss://nos.lol",
    "wss://relay.damus.io",
];
/// 이웃으로 두는 최대 수(§3).
pub const MAX_PEERS: usize = 8;
/// 한 사람의 10002 에서 쓰는 최대 주소 수(§2).
pub const PER_PERSON: usize = 3;
/// 글쓴이 릴레이(§4): 사람당 2곳 · 동시 6곳 · 6시간 기억.
pub const OUTBOX_PER_PERSON: usize = 2;
pub const OUTBOX_MAX_CONNS: usize = 6;
pub const OUTBOX_TTL_SECS: i64 = 6 * 3600;
/// 모든 추가 연결의 제한 시간(접속 시험·이웃 읽기·글쓴이 릴레이).
pub const EXTRA_SECS: u64 = 5;
/// 한 번 이웃을 고를 때 접속 시험을 해 보는 최대 후보 수.
pub const MAX_PROBES: usize = 24;
/// 사용자가 「고급」에서 더할 수 있는 주소 수.
pub const MAX_EXTRA: usize = 8;
/// 다시 올리기(§5): 최근 30일 · 한 번에 50개.
pub const REPUBLISH_DAYS: i64 = 30;
pub const REPUBLISH_MAX: usize = 50;
const REPUBLISH_KINDS: [i64; 5] = [0, 1, 40, 41, 42];
/// 이웃에도 같이 보내는 내 이야기 글 종류(§3).
pub const SHARE_KINDS: [i64; 6] = [0, 1, 5, 40, 41, 42];
/// 이웃 찾기에서 보는 10002 의 나이(§3).
pub const DISCOVER_DAYS: i64 = 14;
/// 박동 — 10분마다 주소가 바뀌었는지 보고, 6시간마다 이웃 찾기·다시 올리기.
const TICK_SECS: u64 = 10 * 60;
pub const FULL_SECS: i64 = 6 * 3600;
/// 주소가 그대로여도 이만큼 지나면 10002 를 다시 올린다(이웃 찾기의 14일 창 안에 머물게).
const REANNOUNCE_SECS: i64 = 24 * 3600;
const FIRST_DELAY_SECS: u64 = 60;

static RUNNING: AtomicBool = AtomicBool::new(false);
static BUSY: AtomicBool = AtomicBool::new(false);
static OUTBOX_FETCHING: AtomicBool = AtomicBool::new(false);
/// 이웃(·사용자가 더한 곳)으로 나가는 연결 수 상한.
static PEER_SEM: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(MAX_PEERS);
/// 글쓴이 릴레이로 나가는 연결 수 상한(§4: 동시에 ≤ 6곳).
static OUTBOX_SEM: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(OUTBOX_MAX_CONNS);

fn yes() -> bool {
    true
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Share {
    /// 릴레이 나누기(§1·§3). 기본 꺼짐.
    #[serde(default)]
    pub enabled: bool,
    /// 내 글 다시 올리기(§5). 기본 켬.
    #[serde(default = "yes")]
    pub republish: bool,
    /// 이웃 릴레이에서도 읽기(§4). 기본 켬.
    #[serde(default = "yes")]
    pub outbox_read: bool,
    /// 고른 이웃(검사·접속 시험 통과).
    #[serde(default)]
    pub peers: Vec<String>,
    /// 사람이 「지우기」를 누른 이웃 — 다시 고르지 않는다.
    #[serde(default)]
    pub blocked: Vec<String>,
    /// 사람이 「고급」에서 더한 주소.
    #[serde(default)]
    pub extra: Vec<String>,
    /// 마지막으로 10002 에 적어 올린 내 주소(없으면 내 주소 없이 올렸거나 안 올림).
    #[serde(default)]
    pub announced_url: Option<String>,
    #[serde(default)]
    pub announced_at: i64,
    /// 지금 나누지 못하는 까닭: `no-outside` · `self-test` · `no-key` · `publish`.
    #[serde(default)]
    pub problem: Option<String>,
    #[serde(default)]
    pub full_at: i64,
    #[serde(default)]
    pub republish_at: i64,
    #[serde(default)]
    pub republish_count: usize,
    #[serde(default)]
    pub republish_ok: bool,
    /// 사람이 「고급」에 직접 적은 내 바깥 주소(테일스케일 등). 「바깥 접속」(클라우드플레어)이 꺼져 있을 때만 쓴다.
    #[serde(default)]
    pub own_url: Option<String>,
}

impl Default for Share {
    fn default() -> Self {
        Share {
            enabled: false,
            republish: true,
            outbox_read: true,
            peers: vec![],
            blocked: vec![],
            extra: vec![],
            announced_url: None,
            announced_at: 0,
            problem: None,
            full_at: 0,
            republish_at: 0,
            republish_count: 0,
            republish_ok: false,
            own_url: None,
        }
    }
}

fn file() -> PathBuf {
    crate::paths::app_file("relay-share.json")
}

pub fn load_from(p: &Path) -> Share {
    std::fs::read_to_string(p).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default()
}

pub fn save_to(p: &Path, s: &Share) -> Result<(), String> {
    if let Some(d) = p.parent() {
        let _ = std::fs::create_dir_all(d);
    }
    let tmp = p.with_extension("json.tmp");
    std::fs::write(&tmp, serde_json::to_vec_pretty(s).unwrap_or_default())
        .and_then(|_| std::fs::rename(&tmp, p))
        .map_err(|e| format!("릴레이 나누기 설정을 저장하지 못했습니다: {e}"))
}

/// 설정 파일을 읽어 고친 뒤 저장한다. 파일 하나를 여러 곳(박동·화면)이 고치므로 늘 이 길로.
static FILE_LOCK: Mutex<()> = Mutex::new(());
fn update<T>(f: impl FnOnce(&mut Share) -> T) -> T {
    let _g = FILE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let p = file();
    let mut s = load_from(&p);
    let out = f(&mut s);
    let _ = save_to(&p, &s);
    out
}
fn current() -> Share {
    let _g = FILE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    load_from(&file())
}

fn now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

// ── §2 주소 검사 ─────────────────────────────────────────────────────────────

/// 이 주소에 접속해도 되는가 — 되면 고른 모양(소문자 호스트·끝 `/` 없음)으로 돌려준다.
///
/// `wss://` 만 · 호스트는 DNS 이름(IP 숫자 주소 금지) · localhost·*.local·*.internal·*.lan 금지 ·
/// 포트는 없거나 443 · 전체 ≤ 200 · 경로 ≤ 64. 사용자 이름·물음표·`#`·역슬래시·공백은 받지 않는다.
pub fn clean_relay_url(raw: &str) -> Option<String> {
    let s = raw.trim();
    if s.is_empty() || s.len() > 200 || !s.is_ascii() {
        return None;
    }
    if s.len() < 6 || !s[..6].eq_ignore_ascii_case("wss://") {
        return None;
    }
    let rest = &s[6..];
    if rest.chars().any(|c| c.is_ascii_control() || matches!(c, ' ' | '@' | '?' | '#' | '\\' | '[' | ']')) {
        return None;
    }
    let (hostport, path) = match rest.find('/') {
        Some(i) => (&rest[..i], &rest[i..]),
        None => (rest, ""),
    };
    if path.len() > 64
        || !path.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '/' | '-' | '.' | '_' | '~'))
        || path.split('/').any(|seg| seg == ".." || seg == ".")
        || path.contains("//")
    {
        return None;
    }
    let (host, port) = match hostport.split_once(':') {
        Some((h, p)) => (h, Some(p)),
        None => (hostport, None),
    };
    if port.is_some_and(|p| p != "443") {
        return None;
    }
    let host = host.to_ascii_lowercase();
    let host = host.strip_suffix('.').unwrap_or(&host).to_string();
    if host.is_empty() || host.len() > 253 || host.parse::<std::net::IpAddr>().is_ok() {
        return None;
    }
    let labels: Vec<&str> = host.split('.').collect();
    if labels.len() < 2
        || labels.iter().any(|l| {
            l.is_empty() || l.len() > 63 || l.starts_with('-') || l.ends_with('-') || !l.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
        })
    {
        return None;
    }
    // 마지막 칸이 숫자뿐이면 IP 숫자 주소(`1.2.3.4`·`0x7f.1` 같은 변형)다.
    if !labels.last().is_some_and(|l| l.chars().any(|c| c.is_ascii_alphabetic())) {
        return None;
    }
    const PRIVATE: [&str; 6] = ["localhost", "local", "internal", "lan", "home.arpa", "localdomain"];
    if PRIVATE.iter().any(|p| host == *p || host.ends_with(&format!(".{p}"))) {
        return None;
    }
    let path = path.trim_end_matches('/');
    Some(format!("wss://{host}{path}"))
}

fn host_of(url: &str) -> &str {
    let rest = url.strip_prefix("wss://").unwrap_or(url);
    rest.split(['/', ':']).next().unwrap_or("")
}

/// 공개 인터넷 주소인가(사설·루프백·링크로컬·CGNAT·문서용 등은 아니다).
pub fn ip_is_public(ip: std::net::IpAddr) -> bool {
    use std::net::IpAddr;
    match ip {
        IpAddr::V4(v) => {
            let o = v.octets();
            !(v.is_private()
                || v.is_loopback()
                || v.is_link_local()
                || v.is_unspecified()
                || v.is_broadcast()
                || v.is_multicast()
                || v.is_documentation()
                || o[0] == 0
                || (o[0] == 100 && (64..128).contains(&o[1]))
                || (o[0] == 198 && (o[1] == 18 || o[1] == 19))
                || o[0] >= 240)
        }
        IpAddr::V6(v) => {
            if let Some(m) = v.to_ipv4_mapped() {
                return ip_is_public(IpAddr::V4(m));
            }
            let s = v.segments();
            !(v.is_loopback() || v.is_unspecified() || v.is_multicast() || (s[0] & 0xfe00) == 0xfc00 || (s[0] & 0xffc0) == 0xfe80 || s[0] == 0x2001 && s[1] == 0x0db8)
        }
    }
}

/// 이름이 공개 주소로만 풀리는가 — DNS 로 사설 주소를 가리키는 속임을 접속 직전에 막는다.
async fn resolves_public(url: &str) -> bool {
    let target = format!("{}:443", host_of(url));
    let found = tokio::net::lookup_host(target).await;
    match found {
        Ok(addrs) => {
            let v: Vec<std::net::SocketAddr> = addrs.collect();
            !v.is_empty() && v.iter().all(|a| ip_is_public(a.ip()))
        }
        Err(_) => false,
    }
}

fn is_default(url: &str) -> bool {
    DEFAULT_RELAYS.iter().any(|d| clean_relay_url(d).as_deref() == Some(url))
}

// ── §1 10002 만들기·읽기 ──────────────────────────────────────────────────────

/// 내 릴레이 목록(kind 10002) 의 태그. 내 주소가 있으면 맨 앞 + `ravenvault-relay` 표.
pub fn list_tags(my_url: Option<&str>) -> Value {
    let mut tags: Vec<Value> = Vec::new();
    if let Some(u) = my_url {
        tags.push(json!(["r", u]));
    }
    for d in DEFAULT_RELAYS {
        tags.push(json!(["r", d]));
    }
    if my_url.is_some() {
        tags.push(json!(["t", SHARE_TAG]));
    }
    // 우리 릴레이(relay.rs)의 사람 글 규칙에 걸리지 않게 — 내 주소를 뺀 목록도 남는다.
    tags.push(json!(["t", "ravencoin"]));
    json!(tags)
}

pub fn build_list(sk: &[u8; 32], my_url: Option<&str>, at: i64) -> Result<Value, String> {
    crate::shopkey::sign_with(sk, LIST_KIND, list_tags(my_url), "", at)
}

/// 한 사람의 10002 에서 쓸 주소들. 검사(§2) 통과 · 기본 릴레이와 겹치는 것 빼기 · 중복 빼기 · 최대 `max`.
/// `peer_only` 면 표지 없는 것(읽기·쓰기 둘 다)만, 아니면 표지 없음·`write` 를 받는다(글쓴이가 쓰는 곳).
pub fn relays_from_list(e: &Value, max: usize, peer_only: bool) -> Vec<String> {
    if e.get("kind").and_then(Value::as_i64) != Some(LIST_KIND) {
        return vec![];
    }
    let mut out: Vec<String> = Vec::new();
    for t in e.get("tags").and_then(Value::as_array).into_iter().flatten() {
        let Some(t) = t.as_array() else { continue };
        if t.first().and_then(Value::as_str) != Some("r") {
            continue;
        }
        let marker = t.get(2).and_then(Value::as_str).unwrap_or("");
        let ok_marker = if peer_only { marker.is_empty() } else { marker.is_empty() || marker == "write" };
        if !ok_marker {
            continue;
        }
        let Some(u) = t.get(1).and_then(Value::as_str).and_then(clean_relay_url) else { continue };
        if is_default(&u) || out.contains(&u) {
            continue;
        }
        out.push(u);
        if out.len() >= max {
            break;
        }
    }
    out
}

/// 사람마다 가장 새 10002 하나만(같은 시각이면 id 가 작은 것 — NIP-01).
fn newest_per_author(events: &[Value]) -> Vec<Value> {
    let mut best: HashMap<String, Value> = HashMap::new();
    for e in events {
        if e.get("kind").and_then(Value::as_i64) != Some(LIST_KIND) {
            continue;
        }
        let Some(pk) = e.get("pubkey").and_then(Value::as_str) else { continue };
        let at = e.get("created_at").and_then(Value::as_i64).unwrap_or(0);
        let id = e.get("id").and_then(Value::as_str).unwrap_or("");
        let wins = best.get(pk).is_none_or(|o| {
            let oa = o.get("created_at").and_then(Value::as_i64).unwrap_or(0);
            at > oa || (at == oa && id < o.get("id").and_then(Value::as_str).unwrap_or(""))
        });
        if wins {
            best.insert(pk.to_string(), e.clone());
        }
    }
    let mut v: Vec<Value> = best.into_values().collect();
    v.sort_by_key(|e| std::cmp::Reverse(e.get("created_at").and_then(Value::as_i64).unwrap_or(0)));
    v
}

// ── §3 이웃 고르기 ──────────────────────────────────────────────────────────

/// 이웃 후보. 내 열쇠·내 주소·지운 이웃은 뺀다. `ravenvault-relay` 표가 있는 10002 만.
pub fn peer_candidates(events: &[Value], me: Option<&str>, my_url: Option<&str>, blocked: &[String]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for e in newest_per_author(events) {
        if me.is_some_and(|m| e.get("pubkey").and_then(Value::as_str) == Some(m)) {
            continue;
        }
        let tagged = e.get("tags").and_then(Value::as_array).is_some_and(|t| {
            t.iter().any(|x| x.get(0).and_then(Value::as_str) == Some("t") && x.get(1).and_then(Value::as_str) == Some(SHARE_TAG))
        });
        if !tagged {
            continue;
        }
        for u in relays_from_list(&e, PER_PERSON, true) {
            if my_url == Some(u.as_str()) || blocked.contains(&u) || out.contains(&u) {
                continue;
            }
            out.push(u);
        }
    }
    out
}

/// 후보를 섞어 접속 시험을 해 보고 통과한 것 중 최대 `MAX_PEERS` 곳. 시험은 최대 `MAX_PROBES` 번, 한 번에 6곳씩.
pub async fn pick_peers<F, Fut>(mut cands: Vec<String>, probe: F) -> Vec<String>
where
    F: Fn(String) -> Fut,
    Fut: std::future::Future<Output = bool>,
{
    use rand::seq::SliceRandom;
    cands.shuffle(&mut rand::thread_rng());
    cands.truncate(MAX_PROBES);
    let mut out = Vec::new();
    for chunk in cands.chunks(6) {
        let results = futures_util::future::join_all(chunk.iter().map(|u| probe(u.clone()))).await;
        for (u, ok) in chunk.iter().zip(results) {
            if ok && out.len() < MAX_PEERS {
                out.push(u.clone());
            }
        }
        if out.len() >= MAX_PEERS {
            break;
        }
    }
    out
}

/// 접속 시험: 5초 안에 REQ → EOSE 가 오는가.
pub async fn probe(url: String) -> bool {
    probe_inner(&url, true).await
}

async fn probe_inner(url: &str, check_dns: bool) -> bool {
    let run = async {
        if check_dns && !resolves_public(url).await {
            return false;
        }
        use futures_util::{SinkExt, StreamExt};
        use tokio_tungstenite::tungstenite::Message;
        let Ok((mut ws, _)) = tokio_tungstenite::connect_async(url).await else { return false };
        let sub = "rvprobe";
        let req = json!(["REQ", sub, { "kinds": [LIST_KIND], "limit": 1 }]).to_string();
        if ws.send(Message::Text(req.into())).await.is_err() {
            return false;
        }
        let mut seen = 0;
        while let Some(Ok(m)) = ws.next().await {
            seen += 1;
            if seen > 50 {
                break;
            }
            let Message::Text(t) = m else { continue };
            let Ok(v) = serde_json::from_str::<Value>(&t) else { continue };
            if v.get(0).and_then(Value::as_str) == Some("EOSE") && v.get(1).and_then(Value::as_str) == Some(sub) {
                let _ = ws.close(None).await;
                return true;
            }
        }
        false
    };
    tokio::time::timeout(std::time::Duration::from_secs(EXTRA_SECS), run).await.unwrap_or(false)
}

// ── nostrpub 이 부르는 길: 이웃에도 보내기 · 이웃에서도 읽기 ─────────────────────

/// 지금 읽고 보낼 추가 주소(이웃 — 켰을 때만 · 사용자가 더한 곳). 기본 릴레이와 겹치는 것은 없다.
pub(crate) fn extra_relays() -> Vec<String> {
    // 시험·regtest 에서는 바깥 이웃에 나가지 않는다.
    if cfg!(test) || (cfg!(feature = "regtest-harness") && std::env::var("RV_HARNESS_RELAY").ok().is_some_and(|u| !u.is_empty())) {
        return vec![];
    }
    {
        let s = current();
        let mut out: Vec<String> = Vec::new();
        let peers = if s.enabled { s.peers.clone() } else { vec![] };
        for u in peers.into_iter().chain(s.extra.clone()) {
            if let Some(c) = clean_relay_url(&u) {
                if !is_default(&c) && !out.contains(&c) && s.announced_url.as_deref() != Some(c.as_str()) {
                    out.push(c);
                }
            }
        }
        out
    }
}

/// 내 이야기 글이면 이웃·더한 곳에도 보낸다. 기다리지 않고, 실패는 무시한다.
pub(crate) fn forward(event: &Value) {
    let kind = event.get("kind").and_then(Value::as_i64).unwrap_or(-1);
    if !SHARE_KINDS.contains(&kind) || crate::relay::in_deleted_room(event) {
        return;
    }
    let targets = extra_relays();
    if targets.is_empty() {
        return;
    }
    let Ok(msg) = serde_json::to_string(&json!(["EVENT", event])) else { return };
    tauri::async_runtime::spawn(async move {
        let runs = targets.into_iter().map(|u| {
            let msg = msg.clone();
            async move {
                let Ok(_permit) = PEER_SEM.acquire().await else { return };
                let go = async {
                    if resolves_public(&u).await {
                        let _ = crate::nostrpub::send_one(&u, &msg).await;
                    }
                };
                let _ = tokio::time::timeout(std::time::Duration::from_secs(EXTRA_SECS * 2), go).await;
            }
        });
        futures_util::future::join_all(runs).await;
    });
}

/// 이웃·더한 곳 한 곳에서 읽는다. 자리가 꽉 찼으면 기다리지 않고 건너뛴다. 5초 제한.
pub(crate) async fn read_extra(url: &str, req: &str, sub: &str) -> Result<Vec<Value>, String> {
    let _permit = PEER_SEM.try_acquire().map_err(|_| "이웃 연결이 꽉 찼습니다".to_string())?;
    let run = async {
        if !resolves_public(url).await {
            return Err("공개 주소가 아닙니다".to_string());
        }
        crate::nostrpub::read_one(url, req, sub).await
    };
    tokio::time::timeout(std::time::Duration::from_secs(EXTRA_SECS), run)
        .await
        .map_err(|_| "답이 늦습니다".to_string())?
}

// ── §4 글쓴이 릴레이에서 읽기 ────────────────────────────────────────────────

/// 글쓴이 → (그 사람이 쓰는 주소, 알아본 시각). 6시간 기억.
static OUTBOX: Mutex<Option<HashMap<String, (Vec<String>, i64)>>> = Mutex::new(None);

/// 주소별로 그 주소를 쓰는 글쓴이를 묶는다. 많이 겹치는 주소부터 최대 `OUTBOX_MAX_CONNS` 곳.
pub fn outbox_plan(lists: &HashMap<String, Vec<String>>, authors: &[String]) -> Vec<(String, Vec<String>)> {
    let mut by_url: HashMap<String, Vec<String>> = HashMap::new();
    for a in authors {
        for u in lists.get(a).into_iter().flatten().take(OUTBOX_PER_PERSON) {
            let v = by_url.entry(u.clone()).or_default();
            if !v.contains(a) {
                v.push(a.clone());
            }
        }
    }
    let mut v: Vec<(String, Vec<String>)> = by_url.into_iter().collect();
    v.sort_by(|a, b| b.1.len().cmp(&a.1.len()).then(a.0.cmp(&b.0)));
    v.truncate(OUTBOX_MAX_CONNS);
    v
}

fn outbox_known(authors: &[String], at: i64) -> (HashMap<String, Vec<String>>, Vec<String>) {
    let g = OUTBOX.lock().unwrap_or_else(|e| e.into_inner());
    let mut known = HashMap::new();
    let mut missing = Vec::new();
    for a in authors {
        match g.as_ref().and_then(|m| m.get(a)) {
            Some((urls, t)) if at - t < OUTBOX_TTL_SECS => {
                known.insert(a.clone(), urls.clone());
            }
            _ => missing.push(a.clone()),
        }
    }
    (known, missing)
}

/// 모르는 글쓴이들의 10002 를 뒤에서 알아 둔다(이번 읽기는 기다리지 않는다 — 다음 읽기부터 쓴다).
fn outbox_learn(missing: Vec<String>) {
    if missing.is_empty() || OUTBOX_FETCHING.swap(true, Ordering::SeqCst) {
        return;
    }
    tauri::async_runtime::spawn(async move {
        let at = now();
        if let Ok(got) = crate::nostrpub::nostr_query_authors(vec![LIST_KIND], missing.clone(), 60).await {
            let mut g = OUTBOX.lock().unwrap_or_else(|e| e.into_inner());
            let m = g.get_or_insert_with(HashMap::new);
            if m.len() > 5_000 {
                m.retain(|_, (_, t)| at - *t < OUTBOX_TTL_SECS);
            }
            let mut found: HashMap<String, Vec<String>> = HashMap::new();
            for e in got.iter().filter(|e| crate::relay::verify(e)) {
                if let Some(pk) = e.get("pubkey").and_then(Value::as_str) {
                    found.insert(pk.to_string(), relays_from_list(e, OUTBOX_PER_PERSON, false));
                }
            }
            // 10002 가 없는 사람도 「없음」으로 6시간 기억한다(매번 묻지 않게).
            for a in missing {
                let urls = found.remove(&a).unwrap_or_default();
                m.insert(a, (urls, at));
            }
        }
        OUTBOX_FETCHING.store(false, Ordering::SeqCst);
    });
}

/// 방·피드 읽기에 덧붙이는 글쓴이 릴레이 글. `filter` 는 원래 물음(종류·표), 여기에 그 사람들만(`authors`)을 더해 묻는다.
pub(crate) async fn outbox_extra(filter: Value, authors: Vec<String>) -> Vec<Value> {
    if cfg!(test) {
        return vec![];
    }
    {
        if !current().outbox_read {
            return vec![];
        }
        let mut uniq: Vec<String> = Vec::new();
        for a in authors {
            if a.len() == 64 && a.bytes().all(|b| b.is_ascii_hexdigit()) && !uniq.contains(&a) {
                uniq.push(a);
            }
            if uniq.len() >= 50 {
                break;
            }
        }
        let (known, missing) = outbox_known(&uniq, now());
        outbox_learn(missing);
        let plan = outbox_plan(&known, &uniq);
        if plan.is_empty() {
            return vec![];
        }
        let runs = plan.into_iter().map(|(url, who)| {
            let mut f = filter.clone();
            f["authors"] = json!(who);
            async move {
                let Ok(_permit) = OUTBOX_SEM.try_acquire() else { return vec![] };
                let req = json!(["REQ", "ob1", f]).to_string();
                let run = async {
                    if !resolves_public(&url).await {
                        return vec![];
                    }
                    crate::nostrpub::read_one(&url, &req, "ob1").await.unwrap_or_default()
                };
                let got = tokio::time::timeout(std::time::Duration::from_secs(EXTRA_SECS), run).await.unwrap_or_default();
                // 그 사람들 글만(릴레이가 아무거나 줄 수 있다). 서명은 read_one 이 봤다.
                got.into_iter().filter(|e| e.get("pubkey").and_then(Value::as_str).is_some_and(|p| who.iter().any(|w| w == p))).collect::<Vec<_>>()
            }
        });
        futures_util::future::join_all(runs).await.into_iter().flatten().collect()
    }
}

// ── §5 내 글 다시 올리기 ────────────────────────────────────────────────────

/// 다시 올릴 후보: 내 열쇠 · 최근 30일 · kind 0·1·40·41·42 · 지운 글 빼기 · 이름표는 가장 새 것 하나 · 새것부터 50개.
pub fn republish_candidates(mine: &[Value], deleted: &HashSet<String>, me: &str, at: i64) -> Vec<Value> {
    let cut = at - REPUBLISH_DAYS * 86_400;
    let mut v: Vec<Value> = mine
        .iter()
        .filter(|e| e.get("pubkey").and_then(Value::as_str) == Some(me))
        .filter(|e| e.get("kind").and_then(Value::as_i64).is_some_and(|k| REPUBLISH_KINDS.contains(&k)))
        .filter(|e| e.get("created_at").and_then(Value::as_i64).is_some_and(|t| t >= cut && t <= at + 900))
        .filter(|e| e.get("id").and_then(Value::as_str).is_some_and(|id| !deleted.contains(id)))
        .cloned()
        .collect();
    v.sort_by_key(|e| std::cmp::Reverse(e.get("created_at").and_then(Value::as_i64).unwrap_or(0)));
    let mut profile_seen = false;
    v.retain(|e| {
        if e.get("kind").and_then(Value::as_i64) == Some(0) {
            if profile_seen {
                return false;
            }
            profile_seen = true;
        }
        true
    });
    let mut ids = HashSet::new();
    v.retain(|e| ids.insert(e.get("id").and_then(Value::as_str).unwrap_or("").to_string()));
    v.truncate(REPUBLISH_MAX);
    v
}

/// 한 릴레이에 없는 것만.
pub fn missing_from(cands: &[Value], present: &HashSet<String>) -> Vec<Value> {
    cands.iter().filter(|e| e.get("id").and_then(Value::as_str).is_some_and(|id| !present.contains(id))).cloned().collect()
}

/// 내 kind 5 가 가리키는 글 번호들.
pub fn deleted_ids(mine: &[Value], me: &str) -> HashSet<String> {
    mine.iter()
        .filter(|x| x.get("kind").and_then(Value::as_i64) == Some(5) && x.get("pubkey").and_then(Value::as_str) == Some(me))
        .flat_map(|x| x.get("tags").and_then(Value::as_array).cloned().unwrap_or_default())
        .filter(|t| t.get(0).and_then(Value::as_str) == Some("e"))
        .filter_map(|t| t.get(1).and_then(Value::as_str).map(str::to_string))
        .collect()
}

/// 한 번 다시 올리기. 돌려주는 값: (다시 보낸 글 수(서로 다른 글), 한 곳이라도 물어볼 수 있었나).
async fn republish_once() -> (usize, bool) {
    let Some(me) = crate::relay::owner_pub() else { return (0, false) };
    let (events, mut deleted) = crate::relay::events_of(&me, &[0, 1, 5, 40, 41, 42]);
    deleted.extend(deleted_ids(&events, &me));
    let deleted: HashSet<String> = deleted.into_iter().collect();
    let cands = republish_candidates(&events, &deleted, &me, now());
    if cands.is_empty() {
        return (0, true);
    }
    let ids: Vec<String> = cands.iter().filter_map(|e| e.get("id").and_then(Value::as_str).map(str::to_string)).collect();
    let req = json!(["REQ", "rp1", { "ids": ids, "limit": ids.len() }]).to_string();
    let mut sent: HashSet<String> = HashSet::new();
    let mut reached = false;
    for url in crate::nostrpub::outside_relays() {
        // 물어보지 못한 곳에는 무작정 보내지 않는다(없는지 모른다).
        let Ok(got) = crate::nostrpub::read_one(&url, &req, "rp1").await else { continue };
        reached = true;
        let present: HashSet<String> = got.iter().filter_map(|e| e.get("id").and_then(Value::as_str).map(str::to_string)).collect();
        for e in missing_from(&cands, &present) {
            let Ok(msg) = serde_json::to_string(&json!(["EVENT", e])) else { continue };
            if crate::nostrpub::send_one(&url, &msg).await.is_ok() {
                if let Some(id) = e.get("id").and_then(Value::as_str) {
                    sent.insert(id.to_string());
                }
            }
        }
    }
    (sent.len(), reached)
}

// ── §1 내 주소 알리기 ────────────────────────────────────────────────────────

/// 지금 바깥에서 붙을 수 있는 내 릴레이 주소(`wss://…/api/relay`). 터널이 살아 있을 때만.
fn outside_url() -> Option<String> {
    let st = crate::tunnel::tunnel_status();
    if st["running"].as_bool().unwrap_or(false) {
        if let Some(u) = st["url"].as_str() {
            return clean_relay_url(&format!("{}/api/relay", u.replacen("https://", "wss://", 1)));
        }
    }
    // 기본은 클라우드플레어(「바깥 접속」). 그게 꺼져 있으면 사람이 직접 적은 주소(테일스케일 등).
    // 직접 적은 주소도 알리기 전에 스스로 들어와 보는 시험(TryWith)을 똑같이 거친다.
    current().own_url.as_deref().and_then(clean_relay_url)
}

/// 무엇을 해야 하나 — 순수 판단(시험용).
#[derive(Debug, PartialEq)]
pub enum Announce {
    /// 아무것도 안 한다.
    Nothing,
    /// 이 주소로 스스로 들어와 보고, 되면 그 주소를 넣어 올린다.
    TryWith(String),
    /// 내 주소를 뺀 목록을 올린다(끔·주소 없어짐).
    Withdraw,
}

pub fn announce_plan(s: &Share, outside: Option<&str>, at: i64) -> Announce {
    match (s.enabled, outside) {
        (true, Some(u)) => {
            if s.announced_url.as_deref() != Some(u) || at - s.announced_at >= REANNOUNCE_SECS || s.problem.is_some() {
                Announce::TryWith(u.to_string())
            } else {
                Announce::Nothing
            }
        }
        _ if s.announced_url.is_some() => Announce::Withdraw,
        _ => Announce::Nothing,
    }
}

/// 10002 를 이 컴퓨터 릴레이 + 기본 릴레이에 올린다. 바깥 한 곳이라도 받으면 성공.
async fn publish_list(sk: &[u8; 32], my_url: Option<&str>) -> bool {
    let Ok(ev) = build_list(sk, my_url, now()) else { return false };
    let Ok(msg) = serde_json::to_string(&json!(["EVENT", ev])) else { return false };
    let local = format!("ws://127.0.0.1:{}/api/relay", crate::server::PORT);
    let mut urls = vec![local.clone()];
    urls.extend(crate::nostrpub::outside_relays());
    let got = futures_util::future::join_all(urls.iter().map(|u| crate::nostrpub::send_one(u, &msg))).await;
    let ok = urls.iter().zip(&got).any(|(u, r)| *u != local && r.is_ok());
    if ok {
        // 이웃에게도(켜져 있을 때) — 이웃 릴레이에서 나를 찾는 사람도 있다.
        forward_list(&msg);
    }
    ok
}

fn forward_list(msg: &str) {
    let targets = extra_relays();
    if targets.is_empty() {
        return;
    }
    let msg = msg.to_string();
    tauri::async_runtime::spawn(async move {
        let runs = targets.into_iter().map(|u| {
            let msg = msg.clone();
            async move {
                let Ok(_permit) = PEER_SEM.acquire().await else { return };
                let _ = tokio::time::timeout(std::time::Duration::from_secs(EXTRA_SECS * 2), crate::nostrpub::send_one(&u, &msg)).await;
            }
        });
        futures_util::future::join_all(runs).await;
    });
}

async fn announce_step() {
    let at = now();
    let s = current();
    let plan = announce_plan(&s, outside_url().as_deref(), at);
    if s.enabled && outside_url().is_none() {
        update(|x| x.problem = Some("no-outside".into()));
    }
    match plan {
        Announce::Nothing => {}
        Announce::Withdraw => {
            let Some((sk, _, _)) = crate::talk::key_on_disk() else { return };
            if publish_list(&sk, None).await {
                update(|x| {
                    x.announced_url = None;
                    x.announced_at = at;
                });
            }
        }
        Announce::TryWith(url) => {
            let Some((sk, _, _)) = crate::talk::key_on_disk() else {
                update(|x| x.problem = Some("no-key".into()));
                return;
            };
            // 바깥 주소로 **스스로** 들어와 본다. 터널 주소는 cloudflare 이름이라 DNS 검사도 그대로 건다.
            if !probe_inner(&url, true).await {
                // 옛 주소를 계속 알리면 이웃이 죽은 곳에 붙는다 — 뺀 목록으로 바꿔 둔다.
                if s.announced_url.is_some() && publish_list(&sk, None).await {
                    update(|x| {
                        x.announced_url = None;
                        x.announced_at = at;
                    });
                }
                update(|x| x.problem = Some("self-test".into()));
                return;
            }
            if publish_list(&sk, Some(&url)).await {
                update(|x| {
                    x.announced_url = Some(url.clone());
                    x.announced_at = at;
                    x.problem = None;
                });
            } else {
                update(|x| x.problem = Some("publish".into()));
            }
        }
    }
}

/// 6시간마다: 이웃 찾기(켰을 때) · 다시 올리기(켰을 때).
async fn full_step() {
    let s = current();
    if s.enabled {
        let since = now() - DISCOVER_DAYS * 86_400;
        let req = json!(["REQ", "rs1", { "kinds": [LIST_KIND], "#t": [SHARE_TAG], "since": since, "limit": 200 }]).to_string();
        let mut targets = vec![format!("ws://127.0.0.1:{}/api/relay", crate::server::PORT)];
        targets.extend(crate::nostrpub::outside_relays());
        let got = futures_util::future::join_all(targets.iter().map(|u| crate::nostrpub::read_one(u, &req, "rs1"))).await;
        if got.iter().any(|r| r.is_ok()) {
            let events: Vec<Value> = got.into_iter().flatten().flatten().collect();
            let me = crate::relay::owner_pub();
            let cands = peer_candidates(&events, me.as_deref(), s.announced_url.as_deref(), &s.blocked);
            let peers = pick_peers(cands, probe).await;
            update(|x| x.peers = peers);
        }
    }
    if s.republish {
        let (n, reached) = republish_once().await;
        update(|x| {
            x.republish_at = now();
            x.republish_count = n;
            x.republish_ok = reached;
        });
    }
    update(|x| x.full_at = now());
}

async fn tick() {
    if BUSY.swap(true, Ordering::SeqCst) {
        return;
    }
    announce_step().await;
    let s = current();
    if now() - s.full_at >= FULL_SECS && (s.enabled || s.republish) {
        full_step().await;
    }
    BUSY.store(false, Ordering::SeqCst);
}

fn kick() {
    tauri::async_runtime::spawn(async {
        tick().await;
    });
}

/// 앱을 켤 때 한 번 — 1분 뒤부터 10분마다 본다. 꺼져 있으면(기본) 다시 올리기만 6시간마다.
pub fn start() {
    if RUNNING.swap(true, Ordering::SeqCst) {
        return;
    }
    tauri::async_runtime::spawn(async {
        tokio::time::sleep(std::time::Duration::from_secs(FIRST_DELAY_SECS)).await;
        loop {
            tick().await;
            tokio::time::sleep(std::time::Duration::from_secs(TICK_SECS)).await;
        }
    });
}

/// 지금 알리고 있는 내 릴레이 주소 — 켜져 있고, 지금 바깥 주소로 스스로 들어와 본 뒤 그 주소를 알린 때만.
/// 릴레이 지킴이 확인(relay_keeper.rs, docs/KEEPER-THANKS.md §1)이 이것만 쓴다.
pub(crate) fn sharing_url() -> Option<String> {
    let s = current();
    let outside = outside_url();
    (s.enabled && outside.is_some() && s.announced_url == outside).then_some(outside).flatten()
}

// ── 설정 화면 ─────────────────────────────────────────────────────────────

fn state_json(s: &Share) -> Value {
    let outside = outside_url();
    let sharing = s.enabled && outside.is_some() && s.announced_url.is_some() && s.announced_url == outside;
    let problem = if s.enabled && outside.is_none() { Some("no-outside".to_string()) } else { s.problem.clone() };
    json!({
        "enabled": s.enabled,
        "republish": s.republish,
        "outbox_read": s.outbox_read,
        "outside_url": outside,
        "sharing": sharing,
        "problem": if s.enabled { problem } else { None },
        "peers": if s.enabled { s.peers.clone() } else { vec![] },
        "extra": s.extra,
        "own_url": s.own_url,
        "defaults": DEFAULT_RELAYS,
        "republish_at": s.republish_at,
        "republish_count": s.republish_count,
        "republish_ok": s.republish_ok,
        "now": now(),
        "busy": BUSY.load(Ordering::SeqCst),
    })
}

#[tauri::command(async)]
pub fn relay_share_get() -> Value {
    state_json(&current())
}

/// 스위치 셋 중 바뀐 것만. 켜면 곧바로 한 번 해 본다(기다리지 않는다).
#[tauri::command(async)]
pub fn relay_share_set(enabled: Option<bool>, republish: Option<bool>, outbox_read: Option<bool>) -> Value {
    let s = update(|s| {
        if let Some(v) = enabled {
            if v && !s.enabled {
                // 새로 켰다 — 바로 이웃을 찾게.
                s.full_at = 0;
            }
            s.enabled = v;
            if !v {
                s.problem = None;
            }
        }
        if let Some(v) = republish {
            s.republish = v;
        }
        if let Some(v) = outbox_read {
            s.outbox_read = v;
        }
        s.clone()
    });
    kick();
    state_json(&s)
}

/// 「고급」 주소 더하기 — §2 검사를 통과해야 한다.
#[tauri::command(async)]
pub fn relay_share_add(url: String) -> Result<Value, String> {
    let Some(u) = clean_relay_url(&url) else {
        return Err("bad-url".into());
    };
    if is_default(&u) {
        return Err("already".into());
    }
    let s = update(|s| -> Result<Share, String> {
        if s.extra.contains(&u) {
            return Err("already".into());
        }
        if s.extra.len() >= MAX_EXTRA {
            return Err("too-many".into());
        }
        s.extra.push(u.clone());
        s.blocked.retain(|b| *b != u);
        Ok(s.clone())
    })?;
    Ok(state_json(&s))
}

/// 「고급」 내 바깥 주소 직접 쓰기(테일스케일 등). 빈 값이면 지운다. §2 검사를 통과해야 한다.
#[tauri::command(async)]
pub fn relay_share_set_own(url: Option<String>) -> Result<Value, String> {
    let own = match url.as_deref().map(str::trim).filter(|u| !u.is_empty()) {
        None => None,
        Some(raw) => {
            let Some(u) = clean_relay_url(raw) else { return Err("bad-url".into()) };
            if is_default(&u) {
                return Err("already".into());
            }
            Some(u)
        }
    };
    let s = update(|s| {
        s.own_url = own;
        s.problem = None;
        s.clone()
    });
    kick();
    Ok(state_json(&s))
}

/// 「고급」 지우기 — 더한 주소는 빼고, 이웃은 빼고 다시 고르지 않는다. 기본 릴레이는 지우지 않는다.
#[tauri::command(async)]
pub fn relay_share_remove(url: String) -> Value {
    let u = clean_relay_url(&url).unwrap_or(url);
    let s = update(|s| {
        s.extra.retain(|x| *x != u);
        if s.peers.contains(&u) {
            s.peers.retain(|x| *x != u);
            if !s.blocked.contains(&u) {
                s.blocked.push(u.clone());
            }
            if s.blocked.len() > 200 {
                s.blocked.remove(0);
            }
        }
        s.clone()
    });
    state_json(&s)
}

#[cfg(test)]
mod tests {
    use super::*;

    const SK: [u8; 32] = [0x21; 32];
    const NOW: i64 = 1_794_139_200;

    #[test]
    fn url_check_allows_only_public_wss_names() {
        assert_eq!(clean_relay_url("wss://abc-def.trycloudflare.com/api/relay").as_deref(), Some("wss://abc-def.trycloudflare.com/api/relay"));
        assert_eq!(clean_relay_url("  WSS://Relay.Example.COM/ ").as_deref(), Some("wss://relay.example.com"));
        assert_eq!(clean_relay_url("wss://relay.example.com:443/x").as_deref(), Some("wss://relay.example.com/x"));
        assert_eq!(clean_relay_url("wss://relay.example.com.").as_deref(), Some("wss://relay.example.com"));
        for bad in [
            "ws://relay.example.com",
            "https://relay.example.com",
            "wss://1.2.3.4",
            "wss://1.2.3.4/relay",
            "wss://0x7f.0.0.1",
            "wss://127.0.0.1:443",
            "wss://[::1]/relay",
            "wss://[2001:db8::1]",
            "wss://localhost",
            "wss://relay.localhost",
            "wss://printer.local",
            "wss://nas.internal",
            "wss://box.lan",
            "wss://router.home.arpa",
            "wss://intranet",
            "wss://relay.example.com:8080",
            "wss://relay.example.com:",
            "wss://user@relay.example.com",
            "wss://relay.example.com/?x=1",
            "wss://relay.example.com/#a",
            "wss://relay.example.com/../x",
            "wss://relay.example.com//x",
            "wss://-bad.example.com",
            "wss://bad_.example.com",
            "wss://릴레이.example.com",
            "wss:// relay.example.com",
            "",
        ] {
            assert_eq!(clean_relay_url(bad), None, "{bad} 를 받았다");
        }
        let long_path = format!("wss://relay.example.com/{}", "a".repeat(64));
        assert_eq!(clean_relay_url(&long_path), None, "경로 64 넘음");
        let ok_path = format!("wss://relay.example.com/{}", "a".repeat(63));
        assert!(clean_relay_url(&ok_path).is_some());
        let long = format!("wss://{}.example.com", "a".repeat(195));
        assert_eq!(clean_relay_url(&long), None, "전체 200 넘음");
    }

    #[test]
    fn private_addresses_are_not_public() {
        for ip in ["10.0.0.1", "192.168.1.5", "172.16.0.1", "127.0.0.1", "169.254.1.1", "100.64.0.1", "0.0.0.0", "::1", "fc00::1", "fe80::1", "::ffff:192.168.0.1"] {
            assert!(!ip_is_public(ip.parse().unwrap()), "{ip}");
        }
        for ip in ["1.1.1.1", "104.16.0.1", "2606:4700::1"] {
            assert!(ip_is_public(ip.parse().unwrap()), "{ip}");
        }
    }

    #[test]
    fn list_event_has_my_address_defaults_and_tag() {
        let my = "wss://abc.trycloudflare.com/api/relay";
        let ev = build_list(&SK, Some(my), NOW).unwrap();
        assert_eq!(ev["kind"], 10002);
        assert!(crate::relay::verify(&ev));
        assert_eq!(ev["content"], "");
        let tags = ev["tags"].as_array().unwrap();
        assert_eq!(tags[0], json!(["r", my]));
        let rs: Vec<&str> = tags.iter().filter(|t| t[0] == "r").map(|t| t[1].as_str().unwrap()).collect();
        assert_eq!(rs, vec![my, "wss://playx.taile277f6.ts.net/relay", "wss://relay.primal.net", "wss://nos.lol", "wss://relay.damus.io"]);
        assert!(tags.iter().any(|t| *t == json!(["t", "ravenvault-relay"])));
        // 표지 없음 = 읽기·쓰기 둘 다
        assert!(tags.iter().filter(|t| t[0] == "r").all(|t| t.as_array().unwrap().len() == 2));
        // 읽기: 기본 릴레이는 중복 제거되고 내 주소만 남는다.
        assert_eq!(relays_from_list(&ev, 3, true), vec![my.to_string()]);
        // 끈 목록: 내 주소·찾기 표가 없다.
        let off = build_list(&SK, None, NOW).unwrap();
        assert!(!off["tags"].as_array().unwrap().iter().any(|t| t[0] == "t" && t[1] == SHARE_TAG));
        assert!(relays_from_list(&off, 3, true).is_empty());
    }

    #[test]
    fn list_parse_checks_each_address_and_caps_per_person() {
        let ev = json!({ "kind": 10002, "pubkey": "aa".repeat(32), "tags": [
            ["r", "wss://1.2.3.4"], ["r", "wss://localhost"], ["r", "wss://nos.lol/"],
            ["r", "wss://a.example.com"], ["r", "wss://a.example.com"], ["r", "wss://b.example.com", "read"],
            ["r", "wss://c.example.com", "write"], ["r", "wss://d.example.com"], ["r", "wss://e.example.com"], ["r", "wss://f.example.com"]
        ]});
        assert_eq!(relays_from_list(&ev, PER_PERSON, true), vec!["wss://a.example.com", "wss://d.example.com", "wss://e.example.com"]);
        assert_eq!(relays_from_list(&ev, OUTBOX_PER_PERSON, false), vec!["wss://a.example.com", "wss://c.example.com"]);
        assert!(relays_from_list(&json!({ "kind": 1, "tags": [["r", "wss://a.example.com"]] }), 3, true).is_empty());
    }

    fn list(pk: &str, at: i64, urls: &[&str], tagged: bool) -> Value {
        let mut tags: Vec<Value> = urls.iter().map(|u| json!(["r", u])).collect();
        if tagged {
            tags.push(json!(["t", SHARE_TAG]));
        }
        json!({ "kind": 10002, "pubkey": pk, "created_at": at, "id": format!("{at:064x}"), "tags": tags })
    }

    #[test]
    fn candidates_skip_me_my_url_blocked_untagged_and_old_lists() {
        let me = "11".repeat(32);
        let evs = vec![
            list(&me, NOW, &["wss://me.example.com"], true),
            list(&"22".repeat(32), NOW - 100, &["wss://old.example.com"], true), // 같은 사람의 옛 목록
            list(&"22".repeat(32), NOW, &["wss://b.example.com", "wss://mine.example.com"], true),
            list(&"33".repeat(32), NOW, &["wss://c.example.com"], false), // 표 없음
            list(&"44".repeat(32), NOW, &["wss://blocked.example.com", "wss://d.example.com"], true),
            list(&"55".repeat(32), NOW, &["wss://b.example.com"], true), // 겹침
        ];
        let got = peer_candidates(&evs, Some(&me), Some("wss://mine.example.com"), &["wss://blocked.example.com".to_string()]);
        let mut sorted = got.clone();
        sorted.sort();
        assert_eq!(sorted, vec!["wss://b.example.com", "wss://d.example.com"]);
    }

    #[tokio::test]
    async fn peer_selection_caps_at_eight_and_limits_probes() {
        use std::sync::atomic::AtomicUsize;
        use std::sync::Arc;
        let cands: Vec<String> = (0..40).map(|i| format!("wss://r{i}.example.com")).collect();
        let tried = Arc::new(AtomicUsize::new(0));
        let t = tried.clone();
        let got = pick_peers(cands.clone(), move |_u| {
            let t = t.clone();
            async move {
                t.fetch_add(1, Ordering::SeqCst);
                true
            }
        })
        .await;
        assert_eq!(got.len(), MAX_PEERS);
        assert!(tried.load(Ordering::SeqCst) <= 12, "8곳을 찾은 뒤에도 계속 시험했다");
        // 시험에 떨어진 곳은 안 고른다. 시험은 최대 24번.
        let tried = Arc::new(AtomicUsize::new(0));
        let t = tried.clone();
        let got = pick_peers(cands, move |u| {
            let t = t.clone();
            async move {
                t.fetch_add(1, Ordering::SeqCst);
                u.ends_with("r3.example.com")
            }
        })
        .await;
        assert!(got.len() <= 1 && got.iter().all(|u| u == "wss://r3.example.com"));
        assert_eq!(tried.load(Ordering::SeqCst), MAX_PROBES);
        assert!(pick_peers(vec![], |_u| async { true }).await.is_empty());
    }

    #[test]
    fn outbox_plan_caps_connections_and_per_person() {
        let mut lists = HashMap::new();
        for i in 0..10 {
            lists.insert(format!("p{i}"), vec![format!("wss://own{i}.example.com"), "wss://shared.example.com".into(), format!("wss://third{i}.example.com")]);
        }
        let authors: Vec<String> = (0..10).map(|i| format!("p{i}")).collect();
        let plan = outbox_plan(&lists, &authors);
        assert_eq!(plan.len(), OUTBOX_MAX_CONNS);
        assert_eq!(plan[0].0, "wss://shared.example.com");
        assert_eq!(plan[0].1.len(), 10);
        assert!(plan.iter().all(|(u, _)| !u.contains("third")), "사람당 2곳을 넘겼다");
        assert!(outbox_plan(&HashMap::new(), &authors).is_empty());
    }

    fn note(sk: &[u8; 32], kind: i64, at: i64, content: &str, tags: Value) -> Value {
        crate::shopkey::sign_with(sk, kind, tags, content, at).unwrap()
    }

    #[test]
    fn republish_skips_deleted_old_others_and_caps_at_fifty() {
        let me = crate::shopkey::pubkey_of(&SK).unwrap();
        let other = [0x22u8; 32];
        let mut mine: Vec<Value> = (0..70).map(|i| note(&SK, 1, NOW - i * 60, &format!("글 {i}"), json!([["t", "ravencoin"]]))).collect();
        let gone = mine[0]["id"].as_str().unwrap().to_string();
        let gone2 = mine[1]["id"].as_str().unwrap().to_string();
        mine.push(note(&SK, 5, NOW, "", json!([["e", gone], ["e", gone2]])));
        mine.push(note(&SK, 1, NOW - 40 * 86_400, "옛 글", json!([])));
        mine.push(note(&SK, 0, NOW - 10, "{}", json!([])));
        mine.push(note(&SK, 0, NOW - 1000, "{\"name\":\"old\"}", json!([])));
        mine.push(note(&other, 1, NOW, "남의 글", json!([])));
        mine.push(note(&SK, 30402, NOW, "{}", json!([["d", "x"]])));
        let deleted = deleted_ids(&mine, &me);
        assert!(deleted.contains(&gone) && deleted.contains(&gone2));
        let c = republish_candidates(&mine, &deleted, &me, NOW);
        assert_eq!(c.len(), REPUBLISH_MAX);
        assert!(!c.iter().any(|e| e["id"] == gone || e["id"] == gone2), "지운 글을 다시 올리려 했다");
        assert!(c.iter().all(|e| e["pubkey"] == me.as_str()));
        assert!(c.iter().all(|e| [0, 1, 40, 41, 42].contains(&e["kind"].as_i64().unwrap())));
        assert!(!c.iter().any(|e| e["content"] == "옛 글"));
        assert_eq!(c.iter().filter(|e| e["kind"] == 0).count(), 1);
        assert!(c.iter().any(|e| e["kind"] == 0 && e["content"] == "{}"), "가장 새 이름표가 아니다");
        // 있는 곳에는 안 보낸다.
        let present: HashSet<String> = c.iter().take(45).map(|e| e["id"].as_str().unwrap().to_string()).collect();
        assert_eq!(missing_from(&c, &present).len(), 5);
        // 남이 쓴 kind 5 로는 내 글이 지워진 것으로 치지 않는다.
        let fake = note(&other, 5, NOW, "", json!([["e", mine[2]["id"]]]));
        assert!(deleted_ids(&[fake], &me).is_empty());
    }

    #[test]
    fn announce_plan_follows_switch_and_address() {
        let mut s = Share { enabled: true, ..Default::default() };
        let u = "wss://a.trycloudflare.com/api/relay";
        assert_eq!(announce_plan(&s, Some(u), NOW), Announce::TryWith(u.into()));
        s.announced_url = Some(u.into());
        s.announced_at = NOW;
        assert_eq!(announce_plan(&s, Some(u), NOW + 600), Announce::Nothing);
        assert_eq!(announce_plan(&s, Some(u), NOW + REANNOUNCE_SECS), Announce::TryWith(u.into()));
        // 주소가 바뀌었다(임시 터널).
        assert_eq!(announce_plan(&s, Some("wss://b.trycloudflare.com/api/relay"), NOW + 600), Announce::TryWith("wss://b.trycloudflare.com/api/relay".into()));
        // 바깥 주소가 없어졌다 → 뺀 목록.
        assert_eq!(announce_plan(&s, None, NOW + 600), Announce::Withdraw);
        // 껐다 → 뺀 목록. 알린 적이 없으면 아무것도 안 한다.
        s.enabled = false;
        assert_eq!(announce_plan(&s, Some(u), NOW + 600), Announce::Withdraw);
        assert_eq!(announce_plan(&Share::default(), Some(u), NOW), Announce::Nothing);
        assert_eq!(announce_plan(&Share::default(), None, NOW), Announce::Nothing);
    }

    #[test]
    fn settings_default_off_with_republish_and_outbox_on() {
        let dir = crate::paths::test_fixture_root().join("relay-share");
        let p = dir.join("relay-share.json");
        let _ = std::fs::remove_file(&p);
        let d = load_from(&p);
        assert!(!d.enabled && d.republish && d.outbox_read);
        // 옛 파일(칸이 빠진 것)도 기본값으로 읽는다.
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(&p, "{\"enabled\":true}").unwrap();
        let s = load_from(&p);
        assert!(s.enabled && s.republish && s.outbox_read);
        let mut s2 = s.clone();
        s2.extra.push("wss://a.example.com".into());
        save_to(&p, &s2).unwrap();
        assert_eq!(load_from(&p), s2);
        std::fs::write(&p, "{bad").unwrap();
        assert!(!load_from(&p).enabled);
        std::fs::remove_file(&p).unwrap();
    }
}
