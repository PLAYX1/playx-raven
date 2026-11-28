//! **핵심 우체국 · 도우미 우체국 운영** — 알리기 판단, 건강 상태(/relay/health), NIP-11, 핵심끼리 겉봉 맞추기.
//!
//! 11-28 대표: 「컴퓨터를 한 대씩 더하면 그게 저절로 우체국이 되어 짐을 나눠 지고, 사용자 데스크탑은 보조 우체국이 된다.」
//!
//! ## 두 역할 (post_office::Role)
//!
//! - **도우미**(기본 · 모든 데스크탑): 우체국이 켜져 있고, 바깥 주소가 있고, 스스로 들어와 보는 시험을 통과하고,
//!   **배터리로 돌지 않고 · 종량제 네트워크가 아니고 · 디스크 여유가 있을 때만** 알린다(`advertise_pause`).
//!   조건이 깨지면 다음 박동(10분)에 알림에서 우체국 표를 뺀다. 꺼진 컴퓨터는 스스로 못 빼므로 알림을 12시간마다 새로 올리고,
//!   앱은 36시간 넘은 알림을 버린다(앱 쪽 약속 · docs/RELAY-SHARE.md §9).
//! - **핵심**(운영자 컴퓨터): 고정 주소(테일스케일 퍼널 `*.ts.net` · 이름 있는 터널)가 있어야 알린다 — 임시 trycloudflare 주소로는 안 알린다.
//!   배터리·종량제로는 쉬지 않는다. 상한이 크다(post_office::CORE_CAPS). 다른 핵심 우체국과 **겉봉을 맞춘다**:
//!   - 새로 맡은 겉봉은 곧바로 다른 핵심에도 보낸다(`forward_new` · 상대마다 줄 2만 · 분당 32MB 까지).
//!   - 5분마다 NIP-77(negentropy)로 최근 3일치를 맞춘다 — 빠진 것만 받고 보낸다(끊겼다 돌아온 핵심도 메워진다).
//!   - 맞추기는 **인증한 상대만**(NIP-42 AUTH · 상대 열쇠는 운영자 설정 + 웹 목록 C1). 도우미·손님은 넓은 겉봉 목록을 못 본다.
//!
//! ## 🔴 내주지 않는 것
//!
//! - 건강 상태(/relay/health)·NIP-11 에는 사람 정보가 없다: 개수·바이트·연결 수·판·역할·지역뿐.

use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tokio_tungstenite::tungstenite::Message;

/// 운영자 웹 목록(C1). 모양: `{"offices":[{"url":"wss://…","role":"core","pubkey":"<hex64>","region":"kr"}]}`(배열만 와도 받는다).
pub const CORE_LIST_URL: &str = "https://ravenvault.ex.erci.se/api/post-offices";
/// 맞추기 창 — 최근 3일(겉봉 시각은 이틀까지 앞당겨지므로 그보다 넉넉히).
pub const SYNC_WINDOW_SECS: i64 = 3 * 86_400;
/// 맞추기 주기.
pub const SYNC_EVERY_SECS: u64 = 5 * 60;
/// 상대마다 보내는 줄(넘치면 버리고 다음 맞추기가 메운다).
pub const FORWARD_QUEUE: usize = 20_000;
/// 상대마다 1분에 내보내는 바이트 상한(대역폭 묶기).
pub const PEER_BYTES_PER_MIN: usize = 32 * 1024 * 1024;
/// 한 번 맞추기에서 받아 오는 최대 수(넘으면 다음 차례에).
pub const SYNC_MAX_FETCH: usize = 50_000;
/// 맞추기 메시지 한 장의 크기(hex 로 두 배가 되어도 웹소켓 512KB 한도 안).
pub const NEG_FRAME: u64 = 100_000;
/// 한 맞추기 재료의 최대 수(넘으면 거절 — 창을 줄여 다시).
pub const NEG_MAX_ITEMS: usize = 2_000_000;

fn now_secs() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0)
}

static START: std::sync::OnceLock<Instant> = std::sync::OnceLock::new();

/// 서버가 켜질 때 부른다(가동 시간 기준점).
pub fn mark_start() {
    let _ = START.set(Instant::now());
}

/// 손님 서버가 켜질 때(server.rs) — 가동 시간 기준 · 겉봉 창고 미리 읽기 · 핵심끼리 맞추기 고리(핵심일 때만 일한다).
pub fn on_server_start() {
    mark_start();
    tauri::async_runtime::spawn_blocking(crate::post_wraps::warm);
    start();
}

pub fn uptime_secs() -> u64 {
    START.get_or_init(Instant::now).elapsed().as_secs()
}

// ── 이 컴퓨터 형편(배터리·종량제·디스크) ──────────────────────────────────

struct Cached<T> {
    at: Option<Instant>,
    val: T,
}

fn cached<T: Clone>(slot: &Mutex<Cached<T>>, every: Duration, f: impl FnOnce() -> T) -> T {
    let mut g = slot.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(at) = g.at {
        if at.elapsed() < every {
            return g.val.clone();
        }
    }
    let v = f();
    g.at = Some(Instant::now());
    g.val = v.clone();
    v
}

/// (여유, 전체) 바이트 — 앱 자료 폴더가 있는 디스크. 1분 기억.
pub fn disk_free_total() -> Option<(u64, u64)> {
    static C: Mutex<Cached<Option<(u64, u64)>>> = Mutex::new(Cached { at: None, val: None });
    cached(&C, Duration::from_secs(60), || free_total(&crate::paths::app_dir()))
}

fn free_total(p: &std::path::Path) -> Option<(u64, u64)> {
    #[cfg(unix)]
    {
        use std::os::unix::ffi::OsStrExt;
        let c = std::ffi::CString::new(p.as_os_str().as_bytes()).ok()?;
        let mut s: libc::statvfs = unsafe { std::mem::zeroed() };
        if unsafe { libc::statvfs(c.as_ptr(), &mut s) } != 0 {
            return None;
        }
        let fr = s.f_frsize as u64;
        Some(((s.f_bavail as u64).saturating_mul(fr), (s.f_blocks as u64).saturating_mul(fr)))
    }
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        let w: Vec<u16> = p.as_os_str().encode_wide().chain(std::iter::once(0)).collect();
        let (mut free, mut total): (u64, u64) = (0, 0);
        let ok = unsafe { windows_sys::Win32::Storage::FileSystem::GetDiskFreeSpaceExW(w.as_ptr(), &mut free, &mut total, std::ptr::null_mut()) };
        if ok != 0 { Some((free, total)) } else { None }
    }
    #[cfg(not(any(unix, windows)))]
    {
        let _ = p;
        None
    }
}

/// 지금 배터리로 돌고 있나(노트북 전원선이 빠짐). 모르면 false. 5분 기억.
pub fn on_battery() -> bool {
    static C: Mutex<Cached<bool>> = Mutex::new(Cached { at: None, val: false });
    cached(&C, Duration::from_secs(300), battery_now)
}

/// `pmset -g batt` 첫 줄 — 「Now drawing from 'Battery Power'」.
pub fn parse_pmset(out: &str) -> bool {
    out.lines().next().is_some_and(|l| l.contains("'Battery Power'"))
}

/// 윈도우 Win32_Battery.BatteryStatus — 1 = 방전 중(전원선 없음). 여러 개면 하나라도.
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
pub fn parse_win_battery(out: &str) -> bool {
    out.split_whitespace().any(|w| w.trim() == "1")
}

fn battery_now() -> bool {
    #[cfg(target_os = "macos")]
    {
        return crate::quiet::cmd("pmset").args(["-g", "batt"]).output().ok().map(|o| parse_pmset(&String::from_utf8_lossy(&o.stdout))).unwrap_or(false);
    }
    #[cfg(target_os = "windows")]
    {
        return crate::quiet::cmd("powershell")
            .args(["-NoProfile", "-Command", "(Get-CimInstance Win32_Battery).BatteryStatus"])
            .output()
            .ok()
            .map(|o| parse_win_battery(&String::from_utf8_lossy(&o.stdout)))
            .unwrap_or(false);
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let Ok(rd) = std::fs::read_dir("/sys/class/power_supply") else { return false };
        return rd.flatten().any(|e| std::fs::read_to_string(e.path().join("status")).map(|s| s.trim() == "Discharging").unwrap_or(false));
    }
    #[allow(unreachable_code)]
    false
}

/// 종량제(데이터 요금) 네트워크인가. 윈도우(연결 비용) · 리눅스(NetworkManager)만 안다 — 맥은 물을 길이 없어 false. 10분 기억.
pub fn metered() -> bool {
    static C: Mutex<Cached<bool>> = Mutex::new(Cached { at: None, val: false });
    cached(&C, Duration::from_secs(600), metered_now)
}

/// 윈도우 NetworkCostType: Unrestricted(무제한) 말고(Fixed·Variable)는 종량제.
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
pub fn parse_win_cost(out: &str) -> bool {
    let t = out.trim();
    t.eq_ignore_ascii_case("Fixed") || t.eq_ignore_ascii_case("Variable")
}

/// `nmcli -t -f GENERAL.METERED dev show` — 「yes」·「yes (guessed)」.
#[cfg_attr(any(target_os = "windows", target_os = "macos"), allow(dead_code))]
pub fn parse_nmcli_metered(out: &str) -> bool {
    out.lines().any(|l| l.split(':').nth(1).is_some_and(|v| v.trim().starts_with("yes")))
}

fn metered_now() -> bool {
    #[cfg(target_os = "windows")]
    {
        return crate::quiet::cmd("powershell")
            .args(["-NoProfile", "-Command", "[void][Windows.Networking.Connectivity.NetworkInformation,Windows.Networking.Connectivity,ContentType=WindowsRuntime]; $p=[Windows.Networking.Connectivity.NetworkInformation]::GetInternetConnectionProfile(); if ($p) { $p.GetConnectionCost().NetworkCostType }"])
            .output()
            .ok()
            .map(|o| parse_win_cost(&String::from_utf8_lossy(&o.stdout)))
            .unwrap_or(false);
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        return crate::quiet::cmd("nmcli")
            .args(["-t", "-f", "GENERAL.METERED", "dev", "show"])
            .output()
            .ok()
            .map(|o| parse_nmcli_metered(&String::from_utf8_lossy(&o.stdout)))
            .unwrap_or(false);
    }
    #[allow(unreachable_code)]
    false
}

// ── 알리기 판단 ──────────────────────────────────────────────────────────

/// 바뀌지 않는 바깥 주소(`wss://…/api/relay`)인가 — 임시 trycloudflare 는 아니다.
pub fn is_stable_url(u: &str) -> bool {
    let host = u.split("://").nth(1).unwrap_or("").split(['/', ':']).next().unwrap_or("").to_ascii_lowercase();
    !host.is_empty() && !host.ends_with(".trycloudflare.com")
}

/// 지금 이 컴퓨터가 알릴 수 있는 고정 바깥 주소.
pub fn stable_outside_url() -> Option<String> {
    crate::relay_share::current_outside_url().filter(|u| is_stable_url(u))
}

/// 순수 판단 — 알리기를 쉬는 까닭(없으면 None = 알려도 된다).
#[allow(clippy::too_many_arguments)]
pub fn pause_reason(on: bool, role: crate::post_office::Role, outside: Option<&str>, battery: bool, metered: bool, disk_low: bool, healthy: bool) -> Option<&'static str> {
    use crate::post_office::Role;
    if !on {
        return Some("off");
    }
    if !healthy {
        return Some("unhealthy");
    }
    let Some(u) = outside else { return Some("no-outside") };
    if role == Role::Core && !is_stable_url(u) {
        return Some("core-needs-fixed");
    }
    if disk_low {
        return Some("disk");
    }
    if role == Role::Helper {
        if battery {
            return Some("battery");
        }
        if metered {
            return Some("metered");
        }
    }
    None
}

/// 디스크 여유가 상한을 거의 다 깎았나(남은 겉봉 자리가 64MB 아래).
fn disk_low() -> bool {
    crate::post_office::effective_wrap_bytes() < 64 * 1024 * 1024
}

/// 지금 알리기를 쉬어야 하나(relay_share 의 10분 박동·설정 화면이 읽는다).
pub fn advertise_pause() -> Option<&'static str> {
    let s = crate::post_office::setting();
    let outside = crate::relay_share::current_outside_url();
    pause_reason(s.on, s.role, outside.as_deref(), on_battery(), metered(), disk_low(), crate::server::relay_live())
}

// ── 건강 상태 · NIP-11 ─────────────────────────────────────────────────────

pub fn health_json() -> Value {
    let s = crate::post_office::setting();
    let (held, held_bytes) = crate::post_office::counts();
    let (free, total) = disk_free_total().unwrap_or((0, 0));
    let pause = advertise_pause();
    json!({
        "ok": crate::server::relay_live(),
        "version": env!("CARGO_PKG_VERSION"),
        "role": s.role.as_str(),
        "region": s.region,
        "post_office": s.on,
        "advertising": s.on && pause.is_none(),
        "pause": pause,
        "uptime_secs": uptime_secs(),
        "connections": crate::relay::open_conns(),
        "max_connections": crate::relay::conn_limits().0,
        "events_stored": crate::relay::stored_count(),
        "held": held,
        "held_bytes": held_bytes,
        "held_max_bytes": crate::post_office::effective_wrap_bytes(),
        "disk_free": free,
        "disk_total": total,
        "nip77": true,
        "core_peers": peer_stats_public(),
    })
}

pub fn nip11_json() -> Value {
    let s = crate::post_office::setting();
    let pk = crate::talk::key_on_disk().and_then(|(sk, _, _)| crate::shopkey::pubkey_of(&sk).ok());
    let mut v = json!({
        "name": if s.role == crate::post_office::Role::Core { "RavenVault post office (core)" } else { "RavenVault post office" },
        "description": "RavenVault desktop relay: shop notes, RavenVault talk rooms, and NIP-17 gift wraps (kind 1059) held for recipients.",
        "software": "https://github.com/PLAYX1/playx-raven",
        "version": env!("CARGO_PKG_VERSION"),
        "supported_nips": [1, 9, 11, 17, 40, 42, 59, 77],
        "limitation": {
            "max_message_length": 512 * 1024,
            "max_subscriptions": 16,
            "max_limit": 500,
            "max_event_tags": 2000,
            "max_content_length": crate::relay::MAX_EVENT_BYTES,
            "auth_required": false,
            "payment_required": false,
            "restricted_writes": true,
        },
        "retention": [
            { "kinds": [1059], "time": crate::post_office::WRAP_KEEP_SECS, "count": crate::post_office::caps().wrap_items },
        ],
        "rv_post_office": {
            "v": 1,
            "role": s.role.as_str(),
            "region": s.region,
            "nip77": true,
            "on": s.on,
        },
    });
    if let Some(pk) = pk {
        v["pubkey"] = json!(pk);
    }
    v
}

// ── NIP-42 인증(핵심끼리) ──────────────────────────────────────────────────

pub fn new_challenge() -> String {
    hex::encode(rand::random::<[u8; 16]>())
}

/// AUTH 이벤트를 검사하고 맞으면 공개키를 준다: kind 22242 · challenge 태그 일치 · 10분 안 · 서명.
pub fn check_auth(e: &Value, challenge: &str) -> Option<String> {
    if e.get("kind").and_then(Value::as_i64) != Some(22242) {
        return None;
    }
    let at = e.get("created_at").and_then(Value::as_i64)?;
    if (now_secs() - at).abs() > 600 {
        return None;
    }
    let tag_ok = e.get("tags").and_then(Value::as_array).is_some_and(|t| {
        t.iter().any(|x| x.get(0).and_then(Value::as_str) == Some("challenge") && x.get(1).and_then(Value::as_str) == Some(challenge))
    });
    if !tag_ok || !crate::relay::verify(e) {
        return None;
    }
    e.get("pubkey").and_then(Value::as_str).map(str::to_string)
}

/// 이 공개키가 핵심 우체국 상대인가(운영자 설정 + 웹 목록). 이 컴퓨터가 핵심일 때만.
pub fn is_core_peer(pk: &str) -> bool {
    let s = crate::post_office::setting();
    if s.role != crate::post_office::Role::Core {
        return false;
    }
    #[cfg(test)]
    if TEST_PEERS.with(|c| c.borrow().iter().any(|p| p == pk)) || BENCH_TRUST.lock().unwrap_or_else(|e| e.into_inner()).iter().any(|p| p == pk) {
        return true;
    }
    s.peers.iter().any(|p| p.pubkey == pk) || web_peers().iter().any(|p| p.pubkey == pk)
}

/// 부하 시험 서버: 믿는 상대 열쇠 · 내 열쇠 · 맞추기 주기(프로세스 전체).
#[cfg(test)]
pub(crate) static BENCH_TRUST: Mutex<Vec<String>> = Mutex::new(Vec::new());
#[cfg(test)]
pub(crate) static BENCH_SK: std::sync::OnceLock<[u8; 32]> = std::sync::OnceLock::new();

/// 맞추기에 쓰는 이 컴퓨터 열쇠(이야기 열쇠 — 배경에서 새로 만들지 않는다).
fn my_sk() -> Option<[u8; 32]> {
    #[cfg(test)]
    if let Some(k) = BENCH_SK.get() {
        return Some(*k);
    }
    crate::talk::key_on_disk().map(|(sk, _, _)| sk)
}

fn sync_every() -> Duration {
    if cfg!(test) { Duration::from_secs(3) } else { Duration::from_secs(SYNC_EVERY_SECS) }
}

/// 부하 시험 서버: 이 상대와 맞추는 고리를 바로 돈다(주소 검사 없이 — ws://127.0.0.1 만 쓴다).
#[cfg(test)]
pub(crate) fn bench_peer(url: String) {
    let (tx, rx) = tokio::sync::mpsc::channel::<Value>(FORWARD_QUEUE);
    QUEUES.lock().unwrap_or_else(|e| e.into_inner()).get_or_insert_with(HashMap::new).insert(url.clone(), tx);
    tokio::spawn(async move { peer_loop(url, rx).await });
}

#[cfg(test)]
thread_local! { pub(crate) static TEST_PEERS: std::cell::RefCell<Vec<String>> = const { std::cell::RefCell::new(Vec::new()) }; }

// ── 웹 목록(C1) ──────────────────────────────────────────────────────────

static WEB: Mutex<(Vec<crate::post_office::CorePeer>, i64)> = Mutex::new((Vec::new(), 0));

fn web_peers() -> Vec<crate::post_office::CorePeer> {
    WEB.lock().unwrap_or_else(|e| e.into_inner()).0.clone()
}

/// 웹 목록에서 핵심 우체국만(주소 검사 · 열쇠 64자 hex).
pub fn parse_core_list(v: &Value) -> Vec<crate::post_office::CorePeer> {
    let arr = v.as_array().or_else(|| v.get("offices").and_then(Value::as_array)).or_else(|| v.get("post_offices").and_then(Value::as_array));
    let Some(arr) = arr else { return vec![] };
    arr.iter()
        .filter(|x| x.get("role").and_then(Value::as_str).unwrap_or("core") == "core")
        .filter_map(|x| {
            let url = crate::relay_share::clean_relay_url(x.get("url").or_else(|| x.get("relay")).and_then(Value::as_str)?)?;
            let pubkey = x.get("pubkey").and_then(Value::as_str)?.to_ascii_lowercase();
            (pubkey.len() == 64 && pubkey.bytes().all(|b| b.is_ascii_hexdigit())).then_some(crate::post_office::CorePeer { url, pubkey })
        })
        .take(crate::post_office::MAX_PEERS)
        .collect()
}

async fn refresh_web_list() {
    let at = WEB.lock().unwrap_or_else(|e| e.into_inner()).1;
    if now_secs() - at < 30 * 60 {
        return;
    }
    let Ok(client) = reqwest::Client::builder().timeout(Duration::from_secs(10)).build() else { return };
    let Ok(r) = client.get(CORE_LIST_URL).send().await else { return };
    if !r.status().is_success() {
        WEB.lock().unwrap_or_else(|e| e.into_inner()).1 = now_secs();
        return;
    }
    let Ok(v) = r.json::<Value>().await else { return };
    *WEB.lock().unwrap_or_else(|e| e.into_inner()) = (parse_core_list(&v), now_secs());
}

/// 맞출 상대(나 자신은 뺀다).
fn all_peers() -> Vec<crate::post_office::CorePeer> {
    let s = crate::post_office::setting();
    let me = crate::talk::key_on_disk().and_then(|(sk, _, _)| crate::shopkey::pubkey_of(&sk).ok());
    let my_url = stable_outside_url();
    let mut out: Vec<crate::post_office::CorePeer> = Vec::new();
    for p in s.peers.into_iter().chain(web_peers()) {
        if Some(&p.pubkey) == me.as_ref() || Some(&p.url) == my_url.as_ref() {
            continue;
        }
        if !out.iter().any(|x| x.url == p.url) {
            out.push(p);
        }
    }
    out.truncate(crate::post_office::MAX_PEERS);
    out
}

// ── 핵심끼리 맞추기 ──────────────────────────────────────────────────────

#[derive(Default, Clone)]
struct PeerStat {
    connected: bool,
    last_sync: i64,
    sent: u64,
    got: u64,
    dropped: u64,
    problem: Option<String>,
}

static STATS: Mutex<Option<HashMap<String, PeerStat>>> = Mutex::new(None);
static QUEUES: Mutex<Option<HashMap<String, tokio::sync::mpsc::Sender<Value>>>> = Mutex::new(None);
static RUNNING: AtomicBool = AtomicBool::new(false);
static FORWARDED: AtomicU64 = AtomicU64::new(0);

fn stat(url: &str, f: impl FnOnce(&mut PeerStat)) {
    let mut g = STATS.lock().unwrap_or_else(|e| e.into_inner());
    f(g.get_or_insert_with(HashMap::new).entry(url.to_string()).or_default());
}

/// 건강 상태용 — 주소 대신 개수만(상대 주소는 운영자 설정 화면에서만).
fn peer_stats_public() -> Value {
    let g = STATS.lock().unwrap_or_else(|e| e.into_inner());
    let m = g.as_ref();
    let n = m.map(|m| m.len()).unwrap_or(0);
    let up = m.map(|m| m.values().filter(|s| s.connected).count()).unwrap_or(0);
    json!({ "configured": n, "connected": up, "forwarded": FORWARDED.load(Ordering::Relaxed) })
}

/// 설정 화면용(운영자만 보는 이 컴퓨터 화면).
pub fn sync_state() -> Value {
    let g = STATS.lock().unwrap_or_else(|e| e.into_inner());
    let list: Vec<Value> = g.as_ref().map(|m| m.iter().map(|(u, s)| json!({
        "url": u, "connected": s.connected, "last_sync": s.last_sync, "sent": s.sent, "got": s.got, "dropped": s.dropped, "problem": s.problem,
    })).collect()).unwrap_or_default();
    json!(list)
}

/// 이 연결(손님·폰)에서 새로 맡은 겉봉을 다른 핵심에도 곧바로 보낸다. 줄이 차면 버린다(다음 맞추기가 메운다).
pub fn forward_new(e: &Value) {
    let g = QUEUES.lock().unwrap_or_else(|e| e.into_inner());
    let Some(m) = g.as_ref() else { return };
    for (url, tx) in m {
        if tx.try_send(e.clone()).is_err() {
            stat(url, |s| s.dropped += 1);
        } else {
            FORWARDED.fetch_add(1, Ordering::Relaxed);
        }
    }
}

/// 역할·상대가 바뀌었을 때 — 고리를 (다시) 돈다.
pub fn kick() {
    if cfg!(test) {
        return;
    }
    start();
}

/// 앱을 켤 때 한 번. 핵심일 때만 실제로 일한다(도우미는 1분마다 역할만 본다).
pub fn start() {
    if RUNNING.swap(true, Ordering::SeqCst) {
        return;
    }
    tauri::async_runtime::spawn(async {
        let mut tasks: HashMap<String, tokio::task::JoinHandle<()>> = HashMap::new();
        loop {
            let core = crate::post_office::setting().role == crate::post_office::Role::Core && crate::post_office::on();
            if core {
                raise_nofile();
                refresh_web_list().await;
            }
            let want: Vec<crate::post_office::CorePeer> = if core { all_peers() } else { vec![] };
            // 빠진 상대는 멈춘다.
            let gone: Vec<String> = tasks.keys().filter(|u| !want.iter().any(|p| &p.url == *u)).cloned().collect();
            for u in gone {
                if let Some(t) = tasks.remove(&u) {
                    t.abort();
                }
                QUEUES.lock().unwrap_or_else(|e| e.into_inner()).get_or_insert_with(HashMap::new).remove(&u);
                STATS.lock().unwrap_or_else(|e| e.into_inner()).get_or_insert_with(HashMap::new).remove(&u);
            }
            for p in want {
                let dead = tasks.get(&p.url).map(|t| t.is_finished()).unwrap_or(true);
                if dead {
                    let (tx, rx) = tokio::sync::mpsc::channel::<Value>(FORWARD_QUEUE);
                    QUEUES.lock().unwrap_or_else(|e| e.into_inner()).get_or_insert_with(HashMap::new).insert(p.url.clone(), tx);
                    let url = p.url.clone();
                    tasks.insert(p.url.clone(), tokio::spawn(async move { peer_loop(url, rx).await }));
                }
            }
            tokio::time::sleep(Duration::from_secs(60)).await;
        }
    });
}

/// 핵심 우체국은 연결 2만 개를 받는다 — 맥·리눅스의 열린 파일 수 상한(GUI 앱 기본 256)을 올린다.
pub fn raise_nofile() {
    #[cfg(unix)]
    {
        static DONE: std::sync::Once = std::sync::Once::new();
        DONE.call_once(|| unsafe {
            let mut r: libc::rlimit = std::mem::zeroed();
            if libc::getrlimit(libc::RLIMIT_NOFILE, &mut r) == 0 {
                let want: libc::rlim_t = 65_536;
                let hard = r.rlim_max;
                let target = if hard == libc::RLIM_INFINITY { want } else { want.min(hard) };
                if r.rlim_cur < target {
                    r.rlim_cur = target;
                    let _ = libc::setrlimit(libc::RLIMIT_NOFILE, &r);
                }
            }
        });
    }
}

/// 상대 하나를 붙잡고 돈다 — 바로 보내기 연결 하나(늘) + 맞추기 연결(5분마다 새로). 둘을 나눈 까닭:
/// 맞추기 도중에 바로 보내기가 멈추면 그동안 쪽지가 몇 초씩 늦는다(11-28 부하 시험: 한 연결로 하니 핵심 사이 배달 p95 4초).
async fn peer_loop(url: String, mut rx: tokio::sync::mpsc::Receiver<Value>) {
    let u2 = url.clone();
    let sync = tokio::spawn(async move { sync_loop(u2).await });
    let first = if cfg!(test) { 1u64 } else { 30u64 };
    let mut backoff = first;
    loop {
        match forward_session(&url, &mut rx).await {
            Ok(()) => break,
            Err(e) => {
                stat(&url, |s| {
                    s.connected = false;
                    s.problem = Some(e.chars().take(120).collect());
                });
            }
        }
        tokio::time::sleep(Duration::from_secs(backoff)).await;
        backoff = (backoff * 2).min(300);
        if backoff > first * 4 { backoff = first * 4; }
    }
    sync.abort();
}

async fn connect_authed(url: &str) -> Result<Peer<crate::relay_share::Ws>, String> {
    let sk = my_sk().ok_or("이야기 열쇠가 없어 인증할 수 없어요")?;
    let ws = tokio::time::timeout(Duration::from_secs(15), crate::relay_share::connect_ws(url)).await.map_err(|_| "붙기 시간 끝".to_string())??;
    let mut peer = Peer { ws, budget: (Instant::now(), 0), url: url.to_string() };
    peer.auth(&sk).await?;
    Ok(peer)
}

/// 바로 보내기: 인증한 뒤 줄에 들어온 겉봉을 그대로 보낸다. 상대의 답(OK)은 따로 읽어 버린다.
async fn forward_session(url: &str, rx: &mut tokio::sync::mpsc::Receiver<Value>) -> Result<(), String> {
    let peer = connect_authed(url).await?;
    stat(url, |s| {
        s.connected = true;
        s.problem = None;
    });
    let (mut sink, mut stream) = peer.ws.split();
    let reader = tokio::spawn(async move {
        while let Some(m) = stream.next().await {
            match m {
                Ok(Message::Close(_)) | Err(_) => break,
                _ => {}
            }
        }
    });
    let mut budget = (Instant::now(), 0usize);
    let res = loop {
        let e = tokio::select! {
            e = rx.recv() => e,
            _ = tokio::time::sleep(Duration::from_secs(50)) => {
                if reader.is_finished() { break Err("상대가 연결을 닫았어요".to_string()); }
                if sink.send(Message::Ping(Vec::new().into())).await.is_err() { break Err("보내지 못했어요".into()); }
                continue;
            }
        };
        let Some(e) = e else { break Ok(()) };
        if reader.is_finished() {
            break Err("상대가 연결을 닫았어요".into());
        }
        let t = json!(["EVENT", e]).to_string();
        if budget.0.elapsed() >= Duration::from_secs(60) { budget = (Instant::now(), 0); }
        if budget.1 + t.len() > PEER_BYTES_PER_MIN {
            stat(url, |s| s.dropped += 1);
            continue; // 이번 분 몫을 다 썼다 — 맞추기가 메운다.
        }
        budget.1 += t.len();
        if sink.send(Message::Text(t.into())).await.is_err() {
            break Err("보내지 못했어요".into());
        }
        stat(url, |s| s.sent += 1);
    };
    reader.abort();
    res
}

/// 맞추기: 5분마다 새로 붙어 인증 → NIP-77 → 닫기.
async fn sync_loop(url: String) {
    loop {
        let r = async {
            let mut peer = connect_authed(&url).await?;
            let r = peer.reconcile(now_secs() - SYNC_WINDOW_SECS).await;
            let _ = peer.ws.close(None).await;
            r
        }
        .await;
        match r {
            Ok((sent, got)) => stat(&url, |s| {
                s.last_sync = now_secs();
                s.sent += sent as u64;
                s.got += got as u64;
            }),
            Err(e) => stat(&url, |s| s.problem = Some(format!("맞추기: {}", e.chars().take(100).collect::<String>()))),
        }
        tokio::time::sleep(sync_every()).await;
    }
}

/// 맞추기 상대 연결(시험이 같은 것을 쓴다).
pub(crate) struct Peer<S> {
    pub ws: S,
    budget: (Instant, usize),
    url: String,
}

impl<S> Peer<S>
where
    S: futures_util::Stream<Item = Result<Message, tokio_tungstenite::tungstenite::Error>> + futures_util::Sink<Message> + Unpin,
{
    #[cfg(test)]
    pub fn new(ws: S, url: &str) -> Self {
        Peer { ws, budget: (Instant::now(), 0), url: url.to_string() }
    }

    async fn send_text(&mut self, t: String) -> Result<(), String> {
        // 대역폭 묶기: 분당 PEER_BYTES_PER_MIN.
        if self.budget.0.elapsed() >= Duration::from_secs(60) {
            self.budget = (Instant::now(), 0);
        }
        if self.budget.1 + t.len() > PEER_BYTES_PER_MIN {
            let wait = Duration::from_secs(60).saturating_sub(self.budget.0.elapsed());
            tokio::time::sleep(wait).await;
            self.budget = (Instant::now(), 0);
        }
        self.budget.1 += t.len();
        self.ws.send(Message::Text(t.into())).await.map_err(|_| "보내지 못했어요".to_string())
    }

    /// 다음 글(본문) 하나 — 30초 넘으면 끝.
    async fn next_json(&mut self) -> Result<Value, String> {
        loop {
            let m = tokio::time::timeout(Duration::from_secs(30), self.ws.next()).await.map_err(|_| "답이 없어요".to_string())?;
            match m {
                Some(Ok(Message::Text(t))) => {
                    if let Ok(v) = serde_json::from_str::<Value>(&t) {
                        return Ok(v);
                    }
                }
                Some(Ok(Message::Ping(p))) => {
                    let _ = self.ws.send(Message::Pong(p)).await;
                }
                Some(Ok(Message::Close(_))) | None => return Err("끊겼어요".into()),
                Some(Err(e)) => return Err(e.to_string()),
                _ => {}
            }
        }
    }

    /// 인증: 넓은 맞추기를 한 번 열어 보고, AUTH 도전이 오면 서명해 답한다.
    pub async fn auth(&mut self, sk: &[u8; 32]) -> Result<(), String> {
        self.send_text(json!(["NEG-OPEN", "rv-auth", { "kinds": [1059], "since": now_secs() }, "61"]).to_string()).await?;
        let mut challenge = None;
        for _ in 0..8 {
            let v = self.next_json().await?;
            match v.get(0).and_then(Value::as_str) {
                Some("AUTH") => challenge = v.get(1).and_then(Value::as_str).map(str::to_string),
                Some("NEG-ERR") | Some("NEG-MSG") => break,
                _ => {}
            }
        }
        let _ = self.send_text(json!(["NEG-CLOSE", "rv-auth"]).to_string()).await;
        let challenge = challenge.ok_or("상대가 인증을 묻지 않았어요(핵심 우체국이 아니거나 옛 판)")?;
        let ev = crate::shopkey::sign_with(sk, 22242, json!([["relay", self.url], ["challenge", challenge]]), "", now_secs())?;
        let id = ev["id"].as_str().unwrap_or("").to_string();
        self.send_text(json!(["AUTH", ev]).to_string()).await?;
        for _ in 0..8 {
            let v = self.next_json().await?;
            if v.get(0).and_then(Value::as_str) == Some("OK") && v.get(1).and_then(Value::as_str) == Some(id.as_str()) {
                return if v.get(2).and_then(Value::as_bool) == Some(true) {
                    Ok(())
                } else {
                    Err(format!("상대가 인증을 거절했어요: {}", v.get(3).and_then(Value::as_str).unwrap_or("")))
                };
            }
        }
        Err("인증 답이 없어요".into())
    }

    pub async fn send_event(&mut self, e: &Value) -> Result<(), String> {
        self.send_text(json!(["EVENT", e]).to_string()).await
    }

    /// NIP-77 로 `since` 이후 겉봉을 맞춘다. (보낸 수, 받은 수).
    pub async fn reconcile(&mut self, since: i64) -> Result<(usize, usize), String> {
        use negentropy::{Id, Negentropy, NegentropyStorageVector};
        let items = crate::post_wraps::neg_items(None, since, i64::MAX, NEG_MAX_ITEMS).map_err(|n| format!("맞출 것이 너무 많아요({n})"))?;
        let mut st = NegentropyStorageVector::with_capacity(items.len());
        for (at, id) in items {
            st.insert(at, Id::from_byte_array(id)).map_err(|e| e.to_string())?;
        }
        st.seal().map_err(|e| e.to_string())?;
        let mut neg = Negentropy::owned(st, NEG_FRAME).map_err(|e| e.to_string())?;
        let first = neg.initiate().map_err(|e| e.to_string())?;
        let sub = "rv-sync";
        self.send_text(json!(["NEG-OPEN", sub, { "kinds": [1059], "since": since }, hex::encode(first)]).to_string()).await?;
        let (mut have, mut need): (Vec<Id>, Vec<Id>) = (Vec::new(), Vec::new());
        for _round in 0..64 {
            let v = self.next_json().await?;
            match v.get(0).and_then(Value::as_str) {
                Some("NEG-MSG") if v.get(1).and_then(Value::as_str) == Some(sub) => {
                    let msg = hex::decode(v.get(2).and_then(Value::as_str).unwrap_or("")).map_err(|e| e.to_string())?;
                    match neg.reconcile_with_ids(&msg, &mut have, &mut need).map_err(|e| e.to_string())? {
                        Some(next) => self.send_text(json!(["NEG-MSG", sub, hex::encode(next)]).to_string()).await?,
                        None => break,
                    }
                }
                Some("NEG-ERR") if v.get(1).and_then(Value::as_str) == Some(sub) => {
                    return Err(format!("맞추기 거절: {}", v.get(2).and_then(Value::as_str).unwrap_or("")));
                }
                _ => {}
            }
        }
        let _ = self.send_text(json!(["NEG-CLOSE", sub]).to_string()).await;
        // 보내기: 내가 가진 것.
        let have: Vec<[u8; 32]> = have.iter().filter_map(|i| <[u8; 32]>::try_from(i.as_bytes().as_slice()).ok()).collect();
        let mut sent = 0;
        for chunk in have.chunks(200) {
            for e in crate::post_wraps::by_ids(chunk) {
                self.send_event(&e).await?;
                sent += 1;
            }
        }
        // 받기: 빠진 것(100개씩).
        let need: Vec<String> = need.iter().map(|i| hex::encode(i.as_bytes())).take(SYNC_MAX_FETCH).collect();
        let mut got = 0;
        for (n, chunk) in need.chunks(100).enumerate() {
            let sub = format!("rv-fetch-{n}");
            self.send_text(json!(["REQ", sub, { "kinds": [1059], "ids": chunk, "limit": chunk.len() }]).to_string()).await?;
            loop {
                let v = self.next_json().await?;
                match v.get(0).and_then(Value::as_str) {
                    Some("EVENT") if v.get(1).and_then(Value::as_str) == Some(sub.as_str()) => {
                        if let Some(e) = v.get(2) {
                            if crate::relay::take_from_peer(e.clone()) {
                                got += 1;
                            }
                        }
                    }
                    Some("EOSE") | Some("CLOSED") if v.get(1).and_then(Value::as_str) == Some(sub.as_str()) => break,
                    _ => {}
                }
            }
            let _ = self.send_text(json!(["CLOSE", sub]).to_string()).await;
        }
        Ok((sent, got))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::post_office::Role;

    #[test]
    fn pause_reasons_protect_the_users_computer() {
        let fixed = Some("wss://n100.tail.ts.net/api/relay");
        let temp = Some("wss://abc-def.trycloudflare.com/api/relay");
        assert_eq!(pause_reason(false, Role::Helper, fixed, false, false, false, true), Some("off"));
        assert_eq!(pause_reason(true, Role::Helper, None, false, false, false, true), Some("no-outside"), "공유기 안이면 알리지 않는다");
        assert_eq!(pause_reason(true, Role::Helper, temp, false, false, false, true), None, "도우미는 임시 주소로도 알린다");
        assert_eq!(pause_reason(true, Role::Helper, fixed, true, false, false, true), Some("battery"));
        assert_eq!(pause_reason(true, Role::Helper, fixed, false, true, false, true), Some("metered"));
        assert_eq!(pause_reason(true, Role::Helper, fixed, false, false, true, true), Some("disk"));
        assert_eq!(pause_reason(true, Role::Helper, fixed, false, false, false, false), Some("unhealthy"));
        assert_eq!(pause_reason(true, Role::Core, temp, false, false, false, true), Some("core-needs-fixed"), "핵심은 임시 주소 안 됨");
        assert_eq!(pause_reason(true, Role::Core, fixed, true, true, false, true), None, "핵심은 배터리·종량제로 쉬지 않는다");
    }

    #[test]
    fn system_probes_parse() {
        assert!(parse_pmset("Now drawing from 'Battery Power'\n -InternalBattery-0 (id=1)\t80%; discharging;"));
        assert!(!parse_pmset("Now drawing from 'AC Power'\n -InternalBattery-0 (id=1)\t100%; charged;"));
        assert!(parse_win_battery("1\r\n"));
        assert!(!parse_win_battery("2\r\n"));
        assert!(!parse_win_battery(""));
        assert!(parse_win_cost("Fixed\r\n") && parse_win_cost("Variable"));
        assert!(!parse_win_cost("Unrestricted") && !parse_win_cost(""));
        assert!(parse_nmcli_metered("GENERAL.METERED:yes (guessed)\nGENERAL.METERED:no"));
        assert!(!parse_nmcli_metered("GENERAL.METERED:no\nGENERAL.METERED:unknown"));
    }

    #[test]
    fn core_list_parses_only_cores_with_keys() {
        let k = "ab".repeat(32);
        let v = json!({ "offices": [
            { "url": "wss://core1.tail.ts.net/api/relay", "role": "core", "pubkey": k, "region": "kr" },
            { "url": "wss://helper.example.com/api/relay", "role": "helper", "pubkey": k },
            { "url": "ws://insecure.example.com", "role": "core", "pubkey": k },
            { "url": "wss://core2.tail.ts.net/api/relay", "role": "core", "pubkey": "short" },
        ] });
        let got = parse_core_list(&v);
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].url, "wss://core1.tail.ts.net/api/relay");
        assert_eq!(parse_core_list(&json!([{ "relay": "wss://c.tail.ts.net/api/relay", "pubkey": k }])).len(), 1, "배열·relay 이름도 받는다");
    }

    #[test]
    fn auth_event_must_answer_this_challenge() {
        let sk = [7u8; 32];
        let ch = new_challenge();
        let ok = crate::shopkey::sign_with(&sk, 22242, json!([["relay", "wss://x"], ["challenge", ch]]), "", now_secs()).unwrap();
        assert_eq!(check_auth(&ok, &ch), Some(crate::shopkey::pubkey_of(&sk).unwrap()));
        assert_eq!(check_auth(&ok, "other"), None, "다른 연결의 도전");
        let old = crate::shopkey::sign_with(&sk, 22242, json!([["challenge", ch]]), "", now_secs() - 3600).unwrap();
        assert_eq!(check_auth(&old, &ch), None, "오래된 것");
        let wrong_kind = crate::shopkey::sign_with(&sk, 1, json!([["challenge", ch]]), "", now_secs()).unwrap();
        assert_eq!(check_auth(&wrong_kind, &ch), None);
    }

    #[test]
    fn stable_url_rules() {
        assert!(is_stable_url("wss://n100.taile277f6.ts.net/api/relay"));
        assert!(is_stable_url("wss://relay.mydomain.kr/api/relay"));
        assert!(!is_stable_url("wss://abc-def.trycloudflare.com/api/relay"));
        assert!(!is_stable_url("garbage"));
    }
}
