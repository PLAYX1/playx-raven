//! 「릴레이 지킴이」 — 내 컴퓨터 릴레이를 모두에게 내어 주고 있다는 표시. 규약 정본: docs/KEEPER-THANKS.md §1
//!
//! ## 흐름
//!
//! 1. 「릴레이 나누기」가 켜져 있고 내 주소를 알린 때(relay_share::sharing_url — 스스로 들어와 보기 통과)만.
//! 2. 하루 한 번(또는 「지금 확인하기」) 이야기 열쇠로 kind 27235 에 서명해
//!    `POST https://ravenvault.ex.erci.se/api/relay-check` 로 `{pubkey, relay, event}` 를 보낸다.
//! 3. 확인 서버가 그 릴레이에서 내 10002 를 읽어 보고, 맞으면 그날 수여(kind 8, d=rv-relay-keeper)를 올린다.
//!    최근 30일 중 25일이면 이야기에서 이름 옆에 「릴레이 지킴이」가 붙는다(셈은 badges.rs).
//!
//! ## 🔴 지키는 것
//!
//! - 노드 지킴이(node_keeper.rs)와 같은 기록·같은 하루 규칙을 쓴다(실패하면 6시간 뒤에).
//! - 배경에서도, 단추로도 이야기 열쇠를 새로 만들지 않는다 — 릴레이 나누기가 이미 그 열쇠로 주소를 알렸다.
//! - 요청에는 열쇠·릴레이 주소·서명만 실린다. 지갑 정보는 안 나간다.
//! - 확인 서버가 아직 없을 수 있다(404) — 「확인 서버가 아직 준비 중이에요」로 조용히 둔다.

use crate::node_keeper::{self, Keeper};
use serde_json::{json, Value};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};

pub const AWARD_A: &str = "rv-relay-keeper";
pub const CHECK_URL: &str = "https://ravenvault.ex.erci.se/api/relay-check";
pub const EVENT_KIND: i64 = 27235;
pub const EVENT_CONTENT: &str = "rv-relay-check";
/// 증서 쪽 주소(docs/KEEPER-THANKS.md §2).
pub const CERT_BASE: &str = "https://ravenvault.ex.erci.se/b/";
const TICK_SECS: u64 = node_keeper::TICK_SECS;
/// 릴레이 나누기가 주소를 알릴 시간을 준다(relay_share 첫 박동 60초 뒤 + 스스로 들어와 보기).
const FIRST_DELAY_SECS: u64 = 5 * 60;

static RUNNING: AtomicBool = AtomicBool::new(false);
static BUSY: AtomicBool = AtomicBool::new(false);

/// 서버가 돌려주는 이유(§1) + 이 컴퓨터에서 미리 걸러 낸 이유. 알 수 없는 말은 `server` 로 모은다.
pub const REASONS: [&str; 12] = [
    "bad-url", "unreachable", "no-list", "mismatch", "auth", "not-configured", "unavailable",
    "not-sharing", "no-key", "network", "server", "busy",
];

pub fn reason_code(raw: &str) -> &'static str {
    let r = raw.trim().to_ascii_lowercase();
    REASONS.iter().copied().find(|k| *k == r).unwrap_or("server")
}

fn file() -> PathBuf {
    crate::paths::app_file("relay-keeper.json")
}

fn now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// 확인 요청에 실을 서명 이벤트.
pub fn build_event(sk: &[u8; 32], relay: &str, created_at: i64) -> Result<Value, String> {
    let tags = json!([["relay", relay], ["t", "ravencoin"]]);
    crate::shopkey::sign_with(sk, EVENT_KIND, tags, EVENT_CONTENT, created_at)
}

pub fn request_body(event: &Value, relay: &str) -> Value {
    json!({
        "pubkey": event.get("pubkey").cloned().unwrap_or(Value::Null),
        "relay": relay,
        "event": event,
    })
}

/// 서버 답 → (통과, 이유, 날짜).
///
/// - 404(아직 없는 길)는 `not-configured`, JSON 이 아닌 5xx 는 `unavailable`, 그 밖에 JSON 이 아니면 `server`.
/// - 날짜가 없거나 모양이 다르면 이 컴퓨터의 UTC 날짜.
pub fn parse_response(status: u16, body: Option<&Value>, now: i64) -> (bool, Option<&'static str>, String) {
    let today = node_keeper::utc_day(now);
    if status == 404 {
        return (false, Some("not-configured"), today);
    }
    let Some(v) = body.filter(|v| v.is_object()) else {
        return (false, Some(if status >= 500 { "unavailable" } else { "server" }), today);
    };
    let (ok, reason, day) = node_keeper::parse_response(v, now);
    // 2xx 가 아닌데 ok:true 라고 하면 믿지 않는다.
    if ok && !(200..300).contains(&status) {
        return (false, Some("server"), day);
    }
    let reason = reason.map(|_| reason_code(v.get("reason").and_then(Value::as_str).unwrap_or("")));
    (ok, reason, day)
}

async fn post(body: &Value) -> Result<(u16, Option<Value>), &'static str> {
    let client = reqwest::Client::builder()
        // 서버가 내 릴레이에 접속해 10002 를 읽는 시간(8초) + 여유.
        .timeout(std::time::Duration::from_secs(30))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| "network")?;
    let r = client.post(CHECK_URL).json(body).send().await.map_err(|_| "network")?;
    let status = r.status().as_u16();
    Ok((status, r.json::<Value>().await.ok()))
}

async fn run_check() -> Value {
    if BUSY.swap(true, Ordering::SeqCst) {
        return json!({"ok": false, "reason": "busy"});
    }
    let out = run_check_inner().await;
    BUSY.store(false, Ordering::SeqCst);
    out
}

async fn run_check_inner() -> Value {
    let at = now();
    let today = node_keeper::utc_day(at);
    let finish = |ok: bool, reason: Option<&'static str>, day: String| {
        let p = file();
        let mut k = node_keeper::load_from(&p);
        node_keeper::record(&mut k, &day, ok, reason, at);
        let _ = node_keeper::save_to(&p, &k);
        json!({"ok": ok, "reason": reason, "day": day})
    };
    // 알리지 않은 주소는 확인을 부탁하지 않는다 — 기록도 남기지 않는다(꺼 둔 것은 실패가 아니다).
    let Some(relay) = crate::relay_share::sharing_url() else {
        return json!({"ok": false, "reason": "not-sharing", "day": today});
    };
    let Some((sk, _, _)) = crate::talk::key_on_disk() else { return finish(false, Some("no-key"), today) };
    let ev = match build_event(&sk, &relay, at) {
        Ok(e) => e,
        Err(_) => return finish(false, Some("no-key"), today),
    };
    match post(&request_body(&ev, &relay)).await {
        Ok((status, v)) => {
            let (ok, reason, day) = parse_response(status, v.as_ref(), at);
            finish(ok, reason, day)
        }
        Err(reason) => finish(false, Some(reason), today),
    }
}

/// 배경에서 확인할 차례인가 — 노드 지킴이와 같은 하루 규칙(켜짐 = 지금 내 주소를 알리고 있음).
pub fn should_auto_check(k: &Keeper, sharing: bool, at: i64) -> bool {
    let k = Keeper { enabled: sharing, ..k.clone() };
    node_keeper::should_auto_check(&k, true, at)
}

fn state_json(k: &Keeper, sharing: Option<&str>, at: i64) -> Value {
    let today = node_keeper::utc_day(at);
    let today_row = k.history.iter().find(|h| h.day == today);
    let last = k.history.iter().max_by_key(|h| h.at);
    let days = node_keeper::days_ok_in_window(k, at);
    json!({
        "sharing": sharing.is_some(),
        "relay": sharing,
        "today": today,
        "today_ok": today_row.map(|h| h.ok).unwrap_or(false),
        "today_tried": today_row.is_some(),
        "last": last,
        "days_ok": days,
        "window_days": node_keeper::WINDOW_DAYS,
        "needed_days": node_keeper::NEEDED_DAYS,
        "eligible": days >= node_keeper::NEEDED_DAYS,
        "busy": BUSY.load(Ordering::SeqCst),
    })
}

#[tauri::command(async)]
pub fn relay_keeper_get() -> Value {
    state_json(&node_keeper::load_from(&file()), crate::relay_share::sharing_url().as_deref(), now())
}

/// 지금 확인하기.
#[tauri::command]
pub async fn relay_keeper_check() -> Value {
    let r = run_check().await;
    let mut s = relay_keeper_get();
    s["result"] = r;
    s
}

/// 릴레이의 수여와 이 컴퓨터 기록을 합쳐 최근 30일 중 확인된 날을 센다.
#[tauri::command]
pub async fn relay_keeper_awards() -> Value {
    let at = now();
    let local = node_keeper::load_from(&file());
    let window: Vec<String> = (0..node_keeper::WINDOW_DAYS).map(|i| node_keeper::utc_day(at - i * 86_400)).collect();
    let mut days: std::collections::BTreeSet<String> =
        local.history.iter().filter(|h| h.ok && window.contains(&h.day)).map(|h| h.day.clone()).collect();
    let me = crate::talk::key_on_disk().and_then(|(sk, _, _)| crate::shopkey::pubkey_of(&sk).ok());
    let mut relay_ok = false;
    if let Some(me) = me {
        if let Ok(v) = crate::nostrpub::nostr_query(vec![8], vec![node_keeper::NODE_KEEPER_PUB.into()], vec![me.clone()]).await {
            relay_ok = true;
            let events = v["events"].as_array().cloned().unwrap_or_default();
            days.extend(node_keeper::award_days_for(&events, AWARD_A, &me, at, crate::relay::verify));
        }
    }
    json!({"days_ok": days.len(), "relay_ok": relay_ok, "eligible": days.len() >= node_keeper::NEEDED_DAYS})
}

// ── §2 증서 나누기 ────────────────────────────────────────────────────────

const BECH32: &[u8; 32] = b"qpzry9x8gf2tvdw0s3jn54khce6mua7l";

fn bech32_polymod(values: &[u8]) -> u32 {
    const GEN: [u32; 5] = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
    let mut chk: u32 = 1;
    for v in values {
        let top = chk >> 25;
        chk = ((chk & 0x1ff_ffff) << 5) ^ u32::from(*v);
        for (i, g) in GEN.iter().enumerate() {
            if (top >> i) & 1 == 1 {
                chk ^= g;
            }
        }
    }
    chk
}

/// NIP-19 `npub` — 64자 16진수 공개키를 bech32 로. 모양이 틀리면 `None`.
pub fn npub_of(hex_pub: &str) -> Option<String> {
    if hex_pub.len() != 64 || !hex_pub.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)) {
        return None;
    }
    let bytes = hex::decode(hex_pub).ok()?;
    let mut data: Vec<u8> = Vec::with_capacity(52);
    let (mut acc, mut bits) = (0u32, 0u32);
    for b in bytes {
        acc = (acc << 8) | u32::from(b);
        bits += 8;
        while bits >= 5 {
            bits -= 5;
            data.push(((acc >> bits) & 31) as u8);
        }
    }
    if bits > 0 {
        data.push(((acc << (5 - bits)) & 31) as u8);
    }
    let hrp = b"npub";
    let mut values: Vec<u8> = hrp.iter().map(|c| c >> 5).collect();
    values.push(0);
    values.extend(hrp.iter().map(|c| c & 31));
    values.extend(&data);
    values.extend([0u8; 6]);
    let pm = bech32_polymod(&values) ^ 1;
    let mut out = String::from("npub1");
    for d in &data {
        out.push(BECH32[*d as usize] as char);
    }
    for i in 0..6 {
        out.push(BECH32[((pm >> (5 * (5 - i))) & 31) as usize] as char);
    }
    Some(out)
}

pub fn cert_url(hex_pub: &str) -> Option<String> {
    npub_of(hex_pub).map(|n| format!("{CERT_BASE}{n}"))
}

/// 내 증서 주소. 열쇠를 새로 만들지 않는다 — 없으면 `{url: null}`.
#[tauri::command(async)]
pub fn keeper_cert_link() -> Value {
    let me = crate::talk::key_on_disk().and_then(|(sk, _, _)| crate::shopkey::pubkey_of(&sk).ok());
    json!({ "npub": me.as_deref().and_then(npub_of), "url": me.as_deref().and_then(cert_url) })
}

async fn tick() {
    let k = node_keeper::load_from(&file());
    let sharing = crate::relay_share::sharing_url().is_some();
    if should_auto_check(&k, sharing, now()) {
        let _ = run_check().await;
    }
}

/// 앱을 켤 때 한 번 — 그 뒤 6시간마다. 릴레이 나누기가 꺼져 있으면 아무것도 안 나간다.
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

    const SK: [u8; 32] = [0x22; 32];
    // 2026-11-08 12:00:00 UTC
    const NOW: i64 = 1_794_139_200;
    const URL: &str = "wss://abc-def.trycloudflare.com/api/relay";

    #[test]
    fn event_is_signed_kind_27235_with_relay_and_topic() {
        let ev = build_event(&SK, URL, NOW).unwrap();
        assert_eq!(ev["kind"], 27235);
        assert_eq!(ev["content"], "rv-relay-check");
        assert_eq!(ev["created_at"], NOW);
        assert_eq!(ev["tags"], json!([["relay", URL], ["t", "ravencoin"]]));
        assert!(crate::relay::verify(&ev));
        let mut bad = ev.clone();
        bad["tags"][0][1] = json!("wss://other.example/relay");
        assert!(!crate::relay::verify(&bad), "주소를 바꾸면 서명이 깨진다");

        let body = request_body(&ev, URL);
        assert_eq!(body["pubkey"], ev["pubkey"]);
        assert_eq!(body["relay"], URL);
        assert_eq!(body["event"], ev);
        // 🔴 열쇠·주소·서명만 — 지갑·IP 는 싣지 않는다.
        assert_eq!(body.as_object().unwrap().len(), 3);
    }

    #[test]
    fn server_answers_map_to_plain_reasons() {
        for r in ["bad-url", "unreachable", "no-list", "mismatch", "auth", "not-configured", "unavailable"] {
            assert_eq!(reason_code(r), r);
            let (ok, reason, _) = parse_response(400, Some(&json!({"ok": false, "reason": r})), NOW);
            assert!(!ok && reason == Some(r));
        }
        assert_eq!(reason_code(" No-List "), "no-list");
        assert_eq!(reason_code("port-closed"), "server", "노드 지킴이 이유는 여기 말이 아니다");
        assert_eq!(reason_code("<b>"), "server");

        let (ok, reason, day) = parse_response(200, Some(&json!({"ok": true, "day": "2026-11-08", "award": {"kind": 8}})), NOW);
        assert!(ok && reason.is_none() && day == "2026-11-08");
        // 아직 없는 길(404) — HTML 이든 JSON 이든 「준비 중」.
        assert_eq!(parse_response(404, None, NOW), (false, Some("not-configured"), "2026-11-08".to_string()));
        assert_eq!(parse_response(404, Some(&json!({"error": "Not Found"})), NOW).1, Some("not-configured"));
        // JSON 이 아닌 5xx 는 「잠시 안 됨」, 그 밖에는 「알 수 없는 답」.
        assert_eq!(parse_response(502, None, NOW).1, Some("unavailable"));
        assert_eq!(parse_response(200, None, NOW).1, Some("server"));
        assert_eq!(parse_response(200, Some(&json!("ok")), NOW).1, Some("server"));
        // 서버가 직접 「준비 중」이라 해도 같다.
        assert_eq!(parse_response(503, Some(&json!({"ok": false, "reason": "not-configured"})), NOW).1, Some("not-configured"));
        // 실패 상태인데 ok:true 는 안 믿는다.
        assert!(!parse_response(500, Some(&json!({"ok": true})), NOW).0);
        // 이유 없는 실패는 server.
        assert_eq!(parse_response(200, Some(&json!({"ok": false})), NOW).1, Some("server"));
    }

    #[test]
    fn checks_only_while_sharing_once_a_day() {
        let mut k = Keeper::default();
        assert!(!should_auto_check(&k, false, NOW), "알리지 않으면 안 묻는다");
        assert!(should_auto_check(&k, true, NOW));
        node_keeper::record(&mut k, "2026-11-08", true, None, NOW);
        assert!(!should_auto_check(&k, true, NOW + 3600));
        assert!(should_auto_check(&k, true, NOW + 13 * 3600), "다음 UTC 날");
        let mut f = Keeper::default();
        node_keeper::record(&mut f, "2026-11-08", false, Some("unreachable"), NOW);
        assert!(!should_auto_check(&f, true, NOW + 3600));
        assert!(should_auto_check(&f, true, NOW + node_keeper::RETRY_AFTER_SECS));
        let st = state_json(&k, Some(URL), NOW);
        assert_eq!(st["today_ok"], true);
        assert_eq!(st["sharing"], true);
        assert_eq!(st["days_ok"], 1);
        assert_eq!(state_json(&k, None, NOW)["sharing"], false);
    }

    #[test]
    fn relay_awards_count_separately_from_node_awards() {
        let me = "aa".repeat(32);
        let pk = node_keeper::NODE_KEEPER_PUB;
        let award = |d: &str, day: &str| json!({
            "kind": 8, "pubkey": pk, "created_at": NOW,
            "tags": [["a", format!("30009:{pk}:{d}")], ["p", me], ["t", "ravencoin"], ["day", day]], "content": ""
        });
        let evs = vec![
            award("rv-relay-keeper", "2026-11-08"),
            award("rv-relay-keeper", "2026-11-07"),
            award("rv-node-keeper", "2026-11-06"),
        ];
        assert_eq!(node_keeper::award_days_for(&evs, AWARD_A, &me, NOW, |_| true).len(), 2);
        assert_eq!(node_keeper::award_days(&evs, &me, NOW, |_| true).len(), 1);
    }

    #[test]
    fn npub_matches_nip19_vector() {
        // NIP-19 문서의 예.
        assert_eq!(
            npub_of("3bf0c63fcb93463407af97a5e5ee64fa883d107ef9e558472c4eb9aaaefa459d").as_deref(),
            Some("npub180cvv07tjdrrgpa0j7j7tmnyl2yr6yr7l8j4s3evf6u64th6gkwsyjh6w6")
        );
        assert_eq!(
            cert_url("7e7e9c42a91bfef19fa929e5fda1b72e0ebc1a4c1141673e2794234d86addf4e").as_deref(),
            Some("https://ravenvault.ex.erci.se/b/npub10elfcs4fr0l0r8af98jlmgdh9c8tcxjvz9qkw038js35mp4dma8qzvjptg")
        );
        assert!(npub_of("3BF0C63FCB93463407AF97A5E5EE64FA883D107EF9E558472C4EB9AAAEFA459D").is_none());
        assert!(npub_of("abc").is_none());
        assert!(npub_of(&"g".repeat(64)).is_none());
    }
}
