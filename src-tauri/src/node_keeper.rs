//! 「노드 지킴이」 — 내 컴퓨터의 레이븐코인 노드가 네트워크를 돕고 있다는 표시.
//!
//! ## 흐름
//!
//! 1. 이 컴퓨터가 이야기 열쇠로 짧은 확인 요청(Nostr kind 27235, 120초 안)에 서명한다.
//! 2. `POST https://ravenvault.ex.erci.se/api/node-check` 로 `{pubkey, port, event}` 를 보낸다.
//! 3. 확인 서버가 **요청을 보낸 공인 IP:port** 로 레이븐코인 P2P 접속을 해 오래된 블록 하나를 받아 본다.
//! 4. 맞으면 서버가 자기 열쇠로 NIP-58 표시(kind 8)를 이야기 릴레이에 올린다.
//!    최근 30일 중 25일 확인되면 이야기에서 이름 옆에 「노드 지킴이」가 붙는다.
//!
//! ## 🔴 지키는 것
//!
//! - **켠 사람만.** 기본은 꺼져 있다. 켜지 않으면 바깥으로 아무것도 안 나간다.
//! - **하루 한 번.** 같은 UTC 날에 이미 확인됐으면 다시 묻지 않는다. 실패했으면 6시간 뒤에야 다시 해 본다.
//! - **IP 를 우리가 적지 않는다.** 요청에는 열쇠·포트·서명만 실린다. 서버가 보는 IP 는 접속에서 저절로 보이는 것뿐이다.
//! - **배경에서는 열쇠를 새로 만들지 않는다.** 확인을 위해 사람이 하나 태어나면 안 된다(`talk::key_on_disk`).
//! - **raven.conf 기본값을 안 바꾼다.** 이 앱은 노드를 `-listen=0` 으로 켜지 않는다(services.rs). 사용자가 직접
//!   `listen=0` 을 적어 둔 경우에만, 그 사람이 단추를 눌렀을 때 `listen=1` 로 바꾼다(사본을 남긴다).

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};

/// 확인 서버의 표시 열쇠(x-only). 이 열쇠가 서명한 kind 8 만 표시로 센다.
pub const NODE_KEEPER_PUB: &str = "7f57c47eccfc0e5b792624595bcbc040a3c7165d3a8829e119dacbfc6d979b72";
pub const AWARD_A: &str = "rv-node-keeper";
pub const CHECK_URL: &str = "https://ravenvault.ex.erci.se/api/node-check";
pub const DEFAULT_PORT: u16 = 8767;
pub const EVENT_KIND: i64 = 27235;
pub const EVENT_CONTENT: &str = "rv-node-check";
/// 배경 박동 — 6시간. 하루 한 번만 묻고, 실패했을 때 다시 해 보는 간격도 이것이다.
pub const TICK_SECS: u64 = 6 * 60 * 60;
pub const RETRY_AFTER_SECS: i64 = 6 * 60 * 60;
/// 앱을 켜고 노드가 일어날 시간을 준다.
const FIRST_DELAY_SECS: u64 = 90;
/// 화면에 보이는 「최근 30일」 · 표시가 붙는 기준.
pub const WINDOW_DAYS: i64 = 30;
pub const NEEDED_DAYS: usize = 25;
/// 기록은 이만큼만 남긴다.
const KEEP_DAYS: i64 = 40;

static RUNNING: AtomicBool = AtomicBool::new(false);
static BUSY: AtomicBool = AtomicBool::new(false);

/// 서버가 돌려주는 이유 + 이 컴퓨터에서 미리 걸러 낸 이유. 알 수 없는 말은 `server` 로 모은다.
pub const REASONS: [&str; 12] = [
    "port-closed", "timeout", "wrong-network", "bad-block", "auth", "not-configured",
    "node-off", "not-synced", "no-key", "network", "server", "busy",
];

pub fn reason_code(raw: &str) -> &'static str {
    let r = raw.trim().to_ascii_lowercase();
    REASONS.iter().copied().find(|k| *k == r).unwrap_or("server")
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct DayResult {
    /// UTC 날짜 `YYYY-MM-DD`.
    pub day: String,
    pub ok: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    /// 마지막으로 해 본 시각(유닉스 초).
    pub at: i64,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Keeper {
    #[serde(default)]
    pub enabled: bool,
    /// 날마다 한 줄. 같은 날 다시 하면 그 줄을 바꾼다(한 번이라도 통과했으면 통과로 남긴다).
    #[serde(default)]
    pub history: Vec<DayResult>,
    #[serde(default)]
    pub last_attempt_at: i64,
}

fn file() -> PathBuf {
    crate::paths::app_file("node-keeper.json")
}

pub fn load_from(p: &Path) -> Keeper {
    std::fs::read_to_string(p).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default()
}

pub fn save_to(p: &Path, k: &Keeper) -> Result<(), String> {
    if let Some(d) = p.parent() {
        let _ = std::fs::create_dir_all(d);
    }
    let tmp = p.with_extension("json.tmp");
    std::fs::write(&tmp, serde_json::to_vec_pretty(k).unwrap_or_default())
        .and_then(|_| std::fs::rename(&tmp, p))
        .map_err(|e| format!("노드 지킴이 설정을 저장하지 못했습니다: {e}"))
}

fn now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// 유닉스 초 → UTC `YYYY-MM-DD` (Howard Hinnant 의 civil_from_days).
pub fn utc_day(secs: i64) -> String {
    let z = secs.div_euclid(86_400) + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + if m <= 2 { 1 } else { 0 };
    format!("{y:04}-{m:02}-{d:02}")
}

/// 최근 `WINDOW_DAYS` 일(오늘 포함) 중 확인된 날 수.
pub fn days_ok_in_window(k: &Keeper, now: i64) -> usize {
    let days: Vec<String> = (0..WINDOW_DAYS).map(|i| utc_day(now - i * 86_400)).collect();
    let mut seen = std::collections::HashSet::new();
    k.history.iter().filter(|h| h.ok && days.contains(&h.day) && seen.insert(h.day.clone())).count()
}

/// 릴레이에서 받은 NIP-58 표시(kind 8) 중 **확인 서버 열쇠가 나에게 준 것**의 UTC 날짜들(최근 30일).
/// 서명 검사는 `verify` 로 한 번 더 한다(릴레이가 아무거나 줄 수 있다).
pub fn award_days(events: &[Value], me: &str, now: i64, verify: impl Fn(&Value) -> bool) -> std::collections::BTreeSet<String> {
    award_days_for(events, AWARD_A, me, now, verify)
}

/// `award_days` 를 표시 이름(d)으로 — 노드 지킴이(`rv-node-keeper`)·릴레이 지킴이(`rv-relay-keeper`)가 같은 규칙을 쓴다.
pub fn award_days_for(events: &[Value], d: &str, me: &str, now: i64, verify: impl Fn(&Value) -> bool) -> std::collections::BTreeSet<String> {
    let window: Vec<String> = (0..WINDOW_DAYS).map(|i| utc_day(now - i * 86_400)).collect();
    let a_want = format!("30009:{NODE_KEEPER_PUB}:{d}");
    let mut out = std::collections::BTreeSet::new();
    for e in events {
        if e.get("kind").and_then(Value::as_i64) != Some(8) || e.get("pubkey").and_then(Value::as_str) != Some(NODE_KEEPER_PUB) {
            continue;
        }
        let tags = e.get("tags").and_then(Value::as_array).cloned().unwrap_or_default();
        let tag = |name: &str| -> Vec<String> {
            tags.iter()
                .filter_map(|t| t.as_array())
                .filter(|t| t.first().and_then(Value::as_str) == Some(name))
                .filter_map(|t| t.get(1).and_then(Value::as_str).map(str::to_string))
                .collect()
        };
        if !tag("a").contains(&a_want) || !tag("p").iter().any(|p| p == me) || !tag("t").iter().any(|t| t == "ravencoin") {
            continue;
        }
        let Some(day) = tag("day").into_iter().next() else { continue };
        if !window.contains(&day) || !verify(e) {
            continue;
        }
        out.insert(day);
    }
    out
}

/// 지금 배경에서 확인할 차례인가.
pub fn should_auto_check(k: &Keeper, synced: bool, now: i64) -> bool {
    if !k.enabled || !synced {
        return false;
    }
    let today = utc_day(now);
    if k.history.iter().any(|h| h.day == today && h.ok) {
        return false;
    }
    now - k.last_attempt_at >= RETRY_AFTER_SECS
}

/// 결과를 기록에 넣는다. 같은 날 이미 통과했으면 실패로 덮지 않는다.
pub fn record(k: &mut Keeper, day: &str, ok: bool, reason: Option<&str>, at: i64) {
    k.last_attempt_at = at;
    if let Some(h) = k.history.iter_mut().find(|h| h.day == day) {
        if h.ok && !ok {
            h.at = at;
            return;
        }
        h.ok = ok;
        h.reason = reason.map(str::to_string);
        h.at = at;
    } else {
        k.history.push(DayResult { day: day.to_string(), ok, reason: reason.map(str::to_string), at });
    }
    let oldest = utc_day(at - KEEP_DAYS * 86_400);
    k.history.retain(|h| h.day.as_str() > oldest.as_str());
    k.history.sort_by(|a, b| a.day.cmp(&b.day));
}

/// raven.conf 에서 P2P 포트와 「바깥 연결을 받는가」를 읽는다.
///
/// 레이븐 코어(비트코인 코어와 같은 규칙): `listen=0` 이면 안 받는다.
/// `connect=` 이나 `proxy=` 를 적으면 `listen` 을 따로 안 적은 한 기본이 「안 받음」이 된다.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct ConfView {
    pub port: u16,
    /// 안 받는 까닭: `listen0` · `connect` · `proxy`. 받으면 `None`.
    pub inbound_off: Option<&'static str>,
}

pub fn read_conf_text(text: &str) -> ConfView {
    let mut port = DEFAULT_PORT;
    let mut listen: Option<bool> = None;
    let mut connect = false;
    let mut proxy = false;
    let mut section_main = true;
    for line in text.lines() {
        let t = line.trim();
        if t.is_empty() || t.starts_with('#') {
            continue;
        }
        if t.starts_with('[') {
            // `[test]` · `[regtest]` 아래 줄은 본 네트워크 것이 아니다.
            section_main = t == "[main]";
            continue;
        }
        if !section_main {
            continue;
        }
        let Some((k, v)) = t.split_once('=') else { continue };
        let (k, v) = (k.trim().trim_start_matches('-'), v.trim());
        match k {
            "port" => {
                if let Ok(p) = v.parse::<u16>() {
                    if p > 0 {
                        port = p;
                    }
                }
            }
            "listen" => listen = Some(!matches!(v, "0" | "false")),
            "nolisten" => listen = Some(matches!(v, "0" | "false")),
            "connect" => connect = connect || !(v.is_empty() || v == "0"),
            "proxy" | "onion" => proxy = proxy || !(v.is_empty() || v == "0"),
            _ => {}
        }
    }
    let inbound_off = match listen {
        Some(true) => None,
        Some(false) => Some("listen0"),
        None if connect => Some("connect"),
        None if proxy => Some("proxy"),
        None => None,
    };
    ConfView { port, inbound_off }
}

fn conf_path() -> PathBuf {
    crate::paths::raven_dir().join("raven.conf")
}

fn conf_view() -> ConfView {
    read_conf_text(&std::fs::read_to_string(conf_path()).unwrap_or_default())
}

/// 확인 요청에 실을 서명 이벤트.
pub fn build_event(sk: &[u8; 32], port: u16, created_at: i64) -> Result<Value, String> {
    let tags = json!([["port", port.to_string()], ["t", "ravencoin"]]);
    crate::shopkey::sign_with(sk, EVENT_KIND, tags, EVENT_CONTENT, created_at)
}

pub fn request_body(event: &Value, port: u16) -> Value {
    json!({
        "pubkey": event.get("pubkey").cloned().unwrap_or(Value::Null),
        "port": port,
        "event": event,
    })
}

/// 서버 답 → (통과, 이유, 날짜). 날짜가 없거나 모양이 다르면 이 컴퓨터의 UTC 날짜.
pub fn parse_response(v: &Value, now: i64) -> (bool, Option<&'static str>, String) {
    let ok = v.get("ok").and_then(Value::as_bool).unwrap_or(false);
    let day = v
        .get("day")
        .and_then(Value::as_str)
        .filter(|d| d.len() == 10 && d.as_bytes()[4] == b'-' && d.as_bytes()[7] == b'-')
        .map(str::to_string)
        .unwrap_or_else(|| utc_day(now));
    let reason = if ok { None } else { Some(reason_code(v.get("reason").and_then(Value::as_str).unwrap_or(""))) };
    (ok, reason, day)
}

struct NodeView {
    running: bool,
    synced: bool,
}

async fn node_view() -> NodeView {
    match crate::raven::node_status().await {
        Ok(v) => NodeView { running: true, synced: v.get("synced").and_then(Value::as_bool).unwrap_or(false) },
        Err(_) => NodeView { running: false, synced: false },
    }
}

async fn post(body: &Value) -> Result<Value, &'static str> {
    let client = reqwest::Client::builder()
        // 서버가 이 컴퓨터로 되돌아 접속해 블록을 받는 시간까지 기다린다.
        .timeout(std::time::Duration::from_secs(60))
        .build()
        .map_err(|_| "network")?;
    let r = client.post(CHECK_URL).json(body).send().await.map_err(|_| "network")?;
    // 실패 답(4xx·5xx)도 JSON 이면 이유를 읽는다.
    r.json::<Value>().await.map_err(|_| "server")
}

/// 한 번 확인한다. `allow_new_key` 가 거짓이면(배경) 이야기 열쇠를 새로 만들지 않는다.
async fn run_check(allow_new_key: bool) -> Value {
    if BUSY.swap(true, Ordering::SeqCst) {
        return json!({"ok": false, "reason": "busy"});
    }
    let out = run_check_inner(allow_new_key).await;
    BUSY.store(false, Ordering::SeqCst);
    out
}

async fn run_check_inner(allow_new_key: bool) -> Value {
    let at = now();
    let today = utc_day(at);
    let view = conf_view();
    let finish = |ok: bool, reason: Option<&'static str>, day: String| {
        let p = file();
        let mut k = load_from(&p);
        record(&mut k, &day, ok, reason, at);
        let _ = save_to(&p, &k);
        json!({"ok": ok, "reason": reason, "day": day})
    };

    let node = node_view().await;
    if !node.running {
        return finish(false, Some("node-off"), today);
    }
    if !node.synced {
        return finish(false, Some("not-synced"), today);
    }
    let sk = if allow_new_key {
        crate::talk::signing_key().ok()
    } else {
        crate::talk::key_on_disk().map(|(sk, _, _)| sk)
    };
    let Some(sk) = sk else { return finish(false, Some("no-key"), today) };
    let ev = match build_event(&sk, view.port, at) {
        Ok(e) => e,
        Err(_) => return finish(false, Some("no-key"), today),
    };
    match post(&request_body(&ev, view.port)).await {
        Ok(v) => {
            let (ok, reason, day) = parse_response(&v, at);
            finish(ok, reason, day)
        }
        Err(reason) => finish(false, Some(reason), today),
    }
}

fn state_json(k: &Keeper, view: &ConfView, at: i64) -> Value {
    let today = utc_day(at);
    let today_row = k.history.iter().find(|h| h.day == today);
    let last = k.history.iter().max_by_key(|h| h.at);
    let days = days_ok_in_window(k, at);
    json!({
        "enabled": k.enabled,
        "port": view.port,
        "inbound_off": view.inbound_off,
        "today": today,
        "today_ok": today_row.map(|h| h.ok).unwrap_or(false),
        "today_tried": today_row.is_some(),
        "last": last,
        "days_ok": days,
        "window_days": WINDOW_DAYS,
        "needed_days": NEEDED_DAYS,
        "eligible": days >= NEEDED_DAYS,
        "busy": BUSY.load(Ordering::SeqCst),
    })
}

/// 설정과 이 컴퓨터에 남은 기록.
#[tauri::command]
pub fn node_keeper_settings_get() -> Value {
    state_json(&load_from(&file()), &conf_view(), now())
}

/// 참여하기 켜기·끄기. 켜면 곧바로 한 번 확인해 본다(기다리지 않는다).
#[tauri::command]
pub fn node_keeper_settings_set(enabled: bool) -> Result<Value, String> {
    let p = file();
    let mut k = load_from(&p);
    k.enabled = enabled;
    save_to(&p, &k)?;
    if enabled {
        kick();
    }
    Ok(state_json(&k, &conf_view(), now()))
}

/// 지금 확인하기 — 사람이 눌렀으니 이야기 열쇠가 없으면 만든다(이야기 화면과 같은 열쇠).
#[tauri::command]
pub async fn node_keeper_check() -> Value {
    let r = run_check(true).await;
    let mut s = state_json(&load_from(&file()), &conf_view(), now());
    s["result"] = r;
    s
}

/// 릴레이의 표시와 이 컴퓨터 기록을 합쳐 최근 30일 중 확인된 날을 센다.
/// 릴레이를 못 읽으면 이 컴퓨터 기록만(`relay_ok: false`).
#[tauri::command]
pub async fn node_keeper_awards() -> Value {
    let at = now();
    let local = load_from(&file());
    let window: Vec<String> = (0..WINDOW_DAYS).map(|i| utc_day(at - i * 86_400)).collect();
    let mut days: std::collections::BTreeSet<String> =
        local.history.iter().filter(|h| h.ok && window.contains(&h.day)).map(|h| h.day.clone()).collect();
    let me = crate::talk::key_on_disk().and_then(|(sk, _, _)| build_event(&sk, DEFAULT_PORT, at).ok()).and_then(|e| e["pubkey"].as_str().map(str::to_string));
    let mut relay_ok = false;
    let mut relay_days = 0;
    if let Some(me) = me {
        if let Ok(v) = crate::nostrpub::nostr_query(vec![8], vec![NODE_KEEPER_PUB.into()], vec![me.clone()]).await {
            relay_ok = true;
            let events = v["events"].as_array().cloned().unwrap_or_default();
            let got = award_days(&events, &me, at, crate::relay::verify);
            relay_days = got.len();
            days.extend(got);
        }
    }
    json!({"days_ok": days.len(), "relay_ok": relay_ok, "relay_days": relay_days, "eligible": days.len() >= NEEDED_DAYS})
}

/// 사용자가 raven.conf 에 직접 `listen=0` 을 적어 둔 경우에만 — 단추를 눌렀을 때 `listen=1` 로 바꾼다.
/// 사본(`raven.conf.bak`)을 남기고, 노드를 다시 켜야 적용된다고 알린다.
#[tauri::command]
pub fn node_keeper_allow_inbound() -> Result<Value, String> {
    let path = conf_path();
    let text = std::fs::read_to_string(&path).unwrap_or_default();
    let (body, changed) = allow_inbound_text(&text);
    if !changed {
        return Ok(json!({"changed": false, "needs_restart": false}));
    }
    if path.exists() {
        let _ = std::fs::copy(&path, path.with_extension("conf.bak"));
    }
    let tmp = path.with_extension("conf.tmp");
    std::fs::write(&tmp, body).and_then(|_| std::fs::rename(&tmp, &path)).map_err(|e| format!("쓰지 못했습니다: {e}"))?;
    Ok(json!({"changed": true, "needs_restart": true}))
}

/// `listen=0`(·`nolisten=1`) 줄만 `listen=1` 로 바꾼다. 다른 줄은 순서까지 그대로.
pub fn allow_inbound_text(text: &str) -> (String, bool) {
    let mut changed = false;
    let mut section_main = true;
    let mut out: Vec<String> = Vec::new();
    for line in text.lines() {
        let t = line.trim();
        if t.starts_with('[') {
            section_main = t == "[main]";
        }
        let off = section_main
            && !t.starts_with('#')
            && t.split_once('=').is_some_and(|(k, v)| {
                let (k, v) = (k.trim().trim_start_matches('-'), v.trim());
                (k == "listen" && matches!(v, "0" | "false")) || (k == "nolisten" && !matches!(v, "0" | "false"))
            });
        if off {
            changed = true;
            out.push("listen=1".to_string());
        } else {
            out.push(line.to_string());
        }
    }
    let mut body = out.join("\n");
    if !body.is_empty() {
        body.push('\n');
    }
    (body, changed)
}

fn kick() {
    tauri::async_runtime::spawn(async {
        tick().await;
    });
}

async fn tick() {
    let k = load_from(&file());
    if !k.enabled {
        return;
    }
    let node = node_view().await;
    if should_auto_check(&k, node.synced, now()) {
        let _ = run_check(false).await;
    }
}

/// 앱을 켤 때 한 번 — 그 뒤 6시간마다. 꺼져 있으면 아무것도 안 나간다.
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

#[cfg(test)]
mod tests {
    use super::*;

    const SK: [u8; 32] = [0x11; 32];
    // 2026-11-08 12:00:00 UTC
    const NOW: i64 = 1_794_139_200;

    #[test]
    fn utc_day_matches_calendar() {
        assert_eq!(utc_day(0), "1970-01-01");
        assert_eq!(utc_day(951_782_400), "2000-02-29");
        assert_eq!(utc_day(NOW), "2026-11-08");
        assert_eq!(utc_day(NOW - 12 * 3600 - 1), "2026-11-07");
    }

    #[test]
    fn event_is_signed_kind_27235_with_port_and_topic() {
        let ev = build_event(&SK, 8767, NOW).unwrap();
        assert_eq!(ev["kind"], 27235);
        assert_eq!(ev["content"], "rv-node-check");
        assert_eq!(ev["created_at"], NOW);
        assert_eq!(ev["tags"], json!([["port", "8767"], ["t", "ravencoin"]]));
        assert_eq!(ev["pubkey"].as_str().unwrap().len(), 64);
        assert_eq!(ev["sig"].as_str().unwrap().len(), 128);
        // id = sha256 of the NIP-01 serialization
        use sha2::{Digest, Sha256};
        let pre = serde_json::to_string(&json!([0, ev["pubkey"], NOW, 27235, ev["tags"], "rv-node-check"])).unwrap();
        assert_eq!(ev["id"].as_str().unwrap(), hex::encode(Sha256::digest(pre.as_bytes())));
        // schnorr signature verifies against the event pubkey (same check the relay code uses)
        assert!(crate::relay::verify(&ev));
        let mut bad = ev.clone();
        bad["tags"][0][1] = json!("1");
        assert!(!crate::relay::verify(&bad));

        let body = request_body(&ev, 8767);
        assert_eq!(body["pubkey"], ev["pubkey"]);
        assert_eq!(body["port"], 8767);
        assert_eq!(body["event"], ev);
        // 🔴 IP·위치를 우리가 싣지 않는다.
        assert_eq!(body.as_object().unwrap().len(), 3);
    }

    #[test]
    fn custom_port_goes_into_the_tag() {
        let ev = build_event(&SK, 18767, NOW).unwrap();
        assert_eq!(ev["tags"][0], json!(["port", "18767"]));
    }

    #[test]
    fn reasons_map_to_known_codes_only() {
        for r in ["port-closed", "timeout", "wrong-network", "bad-block", "auth", "not-configured"] {
            assert_eq!(reason_code(r), r);
        }
        assert_eq!(reason_code(" Port-Closed "), "port-closed");
        assert_eq!(reason_code(""), "server");
        assert_eq!(reason_code("<script>"), "server");

        let (ok, reason, day) = parse_response(&json!({"ok": true, "day": "2026-11-08"}), NOW);
        assert!(ok && reason.is_none() && day == "2026-11-08");
        let (ok, reason, day) = parse_response(&json!({"ok": false, "reason": "port-closed", "day": "2026-11-08"}), NOW);
        assert!(!ok && reason == Some("port-closed") && day == "2026-11-08");
        // 모양이 다른 날짜·답은 이 컴퓨터 날짜로, 이유 없는 실패는 server.
        let (ok, reason, day) = parse_response(&json!({"ok": false, "day": 20261108}), NOW);
        assert!(!ok && reason == Some("server") && day == "2026-11-08");
        let (ok, _, _) = parse_response(&json!({"error": "x"}), NOW);
        assert!(!ok);
    }

    #[test]
    fn scheduling_runs_once_a_day_and_retries_after_six_hours() {
        let mut k = Keeper::default();
        // 꺼져 있거나 동기화 전이면 안 묻는다.
        assert!(!should_auto_check(&k, true, NOW));
        k.enabled = true;
        assert!(!should_auto_check(&k, false, NOW));
        assert!(should_auto_check(&k, true, NOW));

        // 오늘 통과 → 오늘은 더 안 묻는다.
        record(&mut k, "2026-11-08", true, None, NOW);
        assert!(!should_auto_check(&k, true, NOW + 7 * 3600));
        // 다음 UTC 날 → 다시 묻는다.
        assert!(should_auto_check(&k, true, NOW + 13 * 3600));

        // 실패 → 6시간 안에는 안 묻고, 지나면 묻는다.
        let mut f = Keeper { enabled: true, ..Default::default() };
        record(&mut f, "2026-11-08", false, Some("port-closed"), NOW);
        assert!(!should_auto_check(&f, true, NOW + 3600));
        assert!(should_auto_check(&f, true, NOW + RETRY_AFTER_SECS));
    }

    #[test]
    fn a_pass_is_not_overwritten_by_a_later_failure_and_window_counts_30_days() {
        let mut k = Keeper { enabled: true, ..Default::default() };
        record(&mut k, "2026-11-08", true, None, NOW);
        record(&mut k, "2026-11-08", false, Some("timeout"), NOW + 60);
        assert_eq!(k.history.len(), 1);
        assert!(k.history[0].ok && k.history[0].reason.is_none());
        assert_eq!(k.last_attempt_at, NOW + 60);
        // 실패 뒤 통과는 통과로 바뀐다.
        record(&mut k, "2026-11-07", false, Some("timeout"), NOW - 86_400);
        record(&mut k, "2026-11-07", true, None, NOW - 86_000);
        assert!(k.history.iter().find(|h| h.day == "2026-11-07").unwrap().ok);

        let mut w = Keeper::default();
        for i in 0..35 {
            record(&mut w, &utc_day(NOW - i * 86_400), true, None, NOW - i * 86_400);
        }
        // 마지막 기록 시각(가장 옛날) 기준으로 40일 넘은 것만 지우므로 35개가 남는다.
        assert_eq!(w.history.len(), 35);
        assert_eq!(days_ok_in_window(&w, NOW), 30);
        record(&mut w, &utc_day(NOW), true, None, NOW);
        assert_eq!(days_ok_in_window(&w, NOW), 30);
        let st = state_json(&w, &read_conf_text(""), NOW);
        assert_eq!(st["days_ok"], 30);
        assert_eq!(st["eligible"], true);
        assert_eq!(st["today_ok"], true);
        // 오래된 것은 지워진다.
        record(&mut w, &utc_day(NOW + 30 * 86_400), false, Some("timeout"), NOW + 30 * 86_400);
        assert!(w.history.iter().all(|h| h.day.as_str() > utc_day(NOW - 10 * 86_400).as_str()));
    }

    #[test]
    fn award_days_counts_only_server_signed_awards_to_me() {
        let me = "aa".repeat(32);
        let award = |pk: &str, p: &str, day: &str, a: &str| json!({
            "kind": 8, "pubkey": pk, "created_at": NOW,
            "tags": [["a", a], ["p", p], ["t", "ravencoin"], ["day", day]], "content": ""
        });
        let a = format!("30009:{NODE_KEEPER_PUB}:rv-node-keeper");
        let evs = vec![
            award(NODE_KEEPER_PUB, &me, "2026-11-08", &a),
            award(NODE_KEEPER_PUB, &me, "2026-11-08", &a), // 같은 날 두 번 → 하루
            award(NODE_KEEPER_PUB, &me, "2026-11-01", &a),
            award(NODE_KEEPER_PUB, &me, "2026-09-01", &a), // 30일 밖
            award(&"bb".repeat(32), &me, "2026-11-02", &a), // 다른 열쇠
            award(NODE_KEEPER_PUB, &"cc".repeat(32), "2026-11-03", &a), // 남의 표시
            award(NODE_KEEPER_PUB, &me, "2026-11-04", "30009:x:other"), // 다른 배지
        ];
        let got = award_days(&evs, &me, NOW, |_| true);
        assert_eq!(got.into_iter().collect::<Vec<_>>(), vec!["2026-11-01".to_string(), "2026-11-08".to_string()]);
        // 서명이 틀리면 안 센다.
        assert!(award_days(&evs, &me, NOW, |_| false).is_empty());
    }

    #[test]
    fn settings_round_trip_through_a_file() {
        let dir = crate::paths::test_fixture_root().join("node-keeper");
        let p = dir.join("node-keeper.json");
        let _ = std::fs::remove_file(&p);
        assert_eq!(load_from(&p), Keeper::default(), "없으면 꺼짐");
        let mut k = Keeper { enabled: true, ..Default::default() };
        record(&mut k, "2026-11-08", false, Some("port-closed"), NOW);
        save_to(&p, &k).unwrap();
        assert_eq!(load_from(&p), k);
        // 망가진 파일은 꺼짐으로 읽는다(바깥으로 아무것도 안 나간다).
        std::fs::write(&p, "{not json").unwrap();
        assert!(!load_from(&p).enabled);
        std::fs::remove_file(&p).unwrap();
    }

    #[test]
    fn conf_port_and_inbound_rules() {
        assert_eq!(read_conf_text(""), ConfView { port: 8767, inbound_off: None });
        assert_eq!(read_conf_text("server=1\nport=9000\n").port, 9000);
        assert_eq!(read_conf_text("#port=9000\nport=abc\n").port, 8767);
        assert_eq!(read_conf_text("listen=0").inbound_off, Some("listen0"));
        assert_eq!(read_conf_text("listen=1\nconnect=1.2.3.4").inbound_off, None);
        assert_eq!(read_conf_text("connect=1.2.3.4").inbound_off, Some("connect"));
        assert_eq!(read_conf_text("connect=0").inbound_off, None);
        assert_eq!(read_conf_text("proxy=127.0.0.1:9050").inbound_off, Some("proxy"));
        // 테스트넷 칸의 값은 본 네트워크에 안 닿는다.
        assert_eq!(read_conf_text("[test]\nlisten=0\nport=18770\n"), ConfView { port: 8767, inbound_off: None });
        assert_eq!(read_conf_text("[test]\nport=1\n[main]\nport=8800\n").port, 8800);
    }

    #[test]
    fn allow_inbound_only_touches_listen_off_lines() {
        let (body, changed) = allow_inbound_text("server=1\n# listen=0\nlisten=0\nprune=5000\n");
        assert!(changed);
        assert_eq!(body, "server=1\n# listen=0\nlisten=1\nprune=5000\n");
        assert_eq!(read_conf_text(&body).inbound_off, None);
        let (same, changed) = allow_inbound_text("server=1\nupnp=1\n");
        assert!(!changed);
        assert_eq!(same, "server=1\nupnp=1\n");
        // connect·proxy 는 사람이 일부러 적은 것이라 안 바꾼다.
        let (_, changed) = allow_inbound_text("connect=1.2.3.4\n");
        assert!(!changed);
        let (_, changed) = allow_inbound_text("[test]\nlisten=0\n");
        assert!(!changed);
    }
}
