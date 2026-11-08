//! 기여 표시 — 이름표에 걸린 레이븐코인 주소가 **체인에 남긴 사실**만 보여 준다.
//!
//! ## 무엇을 보나 (폰·웹과 같은 규칙, 11-08)
//!
//! - 채굴 지킴이(`miner`): 그 주소가 최근 90일 안에 블록 보상(coinbase)을 직접 받았다.
//! - 창작자(`creator`): 그 주소가 자산의 주인 토큰(이름 끝 `!`)을 하나 이상 가졌다.
//! - 노드 지킴이(`node`): 확인 서버 열쇠(`NODE_KEEPER_PUB`)가 그 사람(공개키)에게 준 NIP-58 표시(kind 8)가
//!   최근 30일 중 25일 이상(UTC 날짜 기준, 서명 확인한 것만).
//! - 릴레이 지킴이(`relay`): 같은 열쇠가 준 d=`rv-relay-keeper` 표시가 같은 규칙으로(docs/KEEPER-THANKS.md §1).
//!
//! ## 🔴 지키는 것
//!
//! - 주소는 **서명으로 확인된 것**(`talk::verified_rvn_address`)만 넣는다. 화면이 묻는 주소도
//!   `talk_profiles` 가 준 그것뿐이다.
//! - **모르면 표시하지 않는다.** 길이 끊기거나 답이 이상하면 `ok:false, unknown:true` 다.
//!   표시를 「있다」고 말하는 건 `ok == true` 일 때뿐이다.
//! - 신원 확인이 아니다. 체인 기록으로 누구나 확인할 수 있는 사실만이다.
//! - 풀 채굴 보상은 아직 못 본다(풀 주소에서 나눠 받는 건 coinbase 가 아니다).
//!
//! 채굴·창작 자료는 레이븐볼트 공개 길(`/api/chain/badges`, gateway route=badges)에서 온다 — 폰·웹과 같은 답을 보게.
//! 노드 지킴이는 이야기 릴레이의 kind 8 을 직접 읽는다.
//! 같은 주소는 6시간 기억하고, 한 번에 셋까지만 묻는다.

use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

const BADGES_URL: &str = "https://ravenvault.ex.erci.se/api/chain/badges";
const CACHE_FOR: Duration = Duration::from_secs(6 * 60 * 60);
/// 실패는 짧게만 기억한다 — 잠깐 끊긴 것 때문에 6시간 동안 표시가 안 뜨면 안 된다.
const FAIL_FOR: Duration = Duration::from_secs(5 * 60);
const MAX_AT_ONCE: usize = 3;
/// 한 번에 묻는 주소 수 한계(화면 한 장에 보이는 사람 수 정도).
const MAX_ADDRESSES: usize = 60;

/// 확인 서버의 표시 열쇠(x-only). 이 열쇠가 서명한 kind 8 만 노드 지킴이로 센다.
/// (node_keeper.rs 와 같은 값 — 합칠 때 하나로 줄인다.)
pub use crate::node_keeper::NODE_KEEPER_PUB;
pub const NODE_NEEDED_DAYS: usize = 25;

fn cache() -> &'static Mutex<HashMap<String, (Instant, Value)>> {
    static C: OnceLock<Mutex<HashMap<String, (Instant, Value)>>> = OnceLock::new();
    C.get_or_init(|| Mutex::new(HashMap::new()))
}

fn gate() -> &'static tokio::sync::Semaphore {
    static S: OnceLock<tokio::sync::Semaphore> = OnceLock::new();
    S.get_or_init(|| tokio::sync::Semaphore::new(MAX_AT_ONCE))
}

/// 메인넷 P2PKH 주소 모양(게이트웨이와 같은 검사).
pub(crate) fn valid_address(a: &str) -> bool {
    (26..=40).contains(&a.len())
        && a.starts_with('R')
        && a.chars().skip(1).all(|c| c.is_ascii_alphanumeric() && !"0OIl".contains(c))
}

fn unknown() -> Value {
    json!({ "ok": false, "unknown": true })
}

/// 게이트웨이 답 → 우리 모양. 🔴 `ok` 가 정확히 `true` 일 때만 표시가 있다.
pub(crate) fn normalize(address: &str, v: &Value) -> Value {
    if v.get("address").and_then(Value::as_str) != Some(address) {
        return json!({ "address": address, "miner": unknown(), "creator": unknown() });
    }
    let miner = match v.get("miner") {
        // 블록 수가 1 이상일 때만 「받았다」(폰 parseBadgeResponse 와 같은 규칙).
        Some(m) if m.get("ok") == Some(&Value::Bool(true)) && m.get("unknown") != Some(&Value::Bool(true)) => {
            let blocks = m.get("blocks").and_then(Value::as_u64).unwrap_or(0);
            if blocks > 0 {
                json!({ "ok": true, "blocks": blocks, "lastAt": m.get("lastAt").and_then(Value::as_i64) })
            } else {
                json!({ "ok": false })
            }
        }
        Some(m) if m.get("ok") == Some(&Value::Bool(false)) && m.get("unknown") != Some(&Value::Bool(true)) => {
            json!({ "ok": false })
        }
        _ => unknown(),
    };
    let creator = match v.get("creator") {
        Some(c) if c.get("ok") == Some(&Value::Bool(true)) && c.get("unknown") != Some(&Value::Bool(true)) => {
            let assets: Vec<String> = c
                .get("assets")
                .and_then(Value::as_array)
                .map(|a| {
                    a.iter()
                        .filter_map(Value::as_str)
                        .map(|s| s.trim_end_matches('!').to_string())
                        .filter(|s| !s.is_empty() && s.len() <= 32 && s.chars().all(|ch| ch.is_ascii_uppercase() || ch.is_ascii_digit() || "._/#~".contains(ch)))
                        .take(20)
                        .collect()
                })
                .unwrap_or_default();
            // 주인 토큰 이름이 하나도 안 남으면 표시하지 않는다.
            if assets.is_empty() { json!({ "ok": false }) } else { json!({ "ok": true, "assets": assets }) }
        }
        Some(c) if c.get("ok") == Some(&Value::Bool(false)) && c.get("unknown") != Some(&Value::Bool(true)) => {
            json!({ "ok": false })
        }
        _ => unknown(),
    };
    json!({ "address": address, "miner": miner, "creator": creator, "checkedAt": v.get("checkedAt") })
}

/// 이 답이 그 표시를 「확실히 가졌다」고 하나.
#[cfg_attr(not(test), allow(dead_code))]
pub(crate) fn has_badge(b: &Value, which: &str) -> bool {
    b.get(which).and_then(|x| x.get("ok")) == Some(&Value::Bool(true))
}

/// 이 답이 그 표시를 「확실히 없다」고 하나(모를 때는 false).
pub(crate) fn surely_lacks(b: &Value, which: &str) -> bool {
    let x = b.get(which);
    x.and_then(|x| x.get("ok")) == Some(&Value::Bool(false)) && x.and_then(|x| x.get("unknown")) != Some(&Value::Bool(true))
}

async fn fetch(address: &str) -> Result<Value, String> {
    let _permit = gate().acquire().await.map_err(|e| e.to_string())?;
    let r = reqwest::Client::new()
        .get(BADGES_URL)
        .query(&[("address", address)])
        .timeout(Duration::from_secs(15))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !r.status().is_success() {
        return Err(format!("HTTP {}", r.status()));
    }
    r.json::<Value>().await.map_err(|e| e.to_string())
}

/// 한 주소의 기여 표시(기억해 둔 것이 있으면 그것).
pub(crate) async fn badges_of(address: &str) -> Value {
    if !valid_address(address) {
        return json!({ "address": address, "miner": unknown(), "creator": unknown() });
    }
    if let Some((at, v)) = cache().lock().ok().and_then(|c| c.get(address).cloned()) {
        let fresh_for = if has_unknown(&v) { FAIL_FOR } else { CACHE_FOR };
        if at.elapsed() < fresh_for {
            return v;
        }
    }
    let v = match fetch(address).await {
        Ok(raw) => normalize(address, &raw),
        Err(_) => json!({ "address": address, "miner": unknown(), "creator": unknown() }),
    };
    if let Ok(mut c) = cache().lock() {
        if c.len() > 2000 {
            c.clear();
        }
        c.insert(address.to_string(), (Instant::now(), v.clone()));
    }
    v
}

fn has_unknown(v: &Value) -> bool {
    ["miner", "creator"].iter().any(|k| v.get(*k).and_then(|x| x.get("unknown")) == Some(&Value::Bool(true)))
}

fn now_secs() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0)
}

pub(crate) use crate::node_keeper::utc_day;

fn valid_pubkey(p: &str) -> bool {
    p.len() == 64 && p.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// 확인 서버가 `who` 에게 준 노드 지킴이 표시(kind 8)의 서로 다른 UTC 날짜 수(최근 30일, 오늘 포함).
/// 🔴 서명은 `verify` 로 한 번 더 본다 — 릴레이는 아무 글이나 줄 수 있다.
#[cfg_attr(not(test), allow(dead_code))]
pub(crate) fn node_award_days(events: &[Value], who: &str, now: i64, verify: impl Fn(&Value) -> bool) -> usize {
    keeper_award_days(events, crate::node_keeper::AWARD_A, who, now, verify)
}

/// 지킴이 표시를 표시 이름(d)으로 센다 — `rv-node-keeper`(노드)·`rv-relay-keeper`(릴레이). 규칙은 같다.
pub(crate) fn keeper_award_days(events: &[Value], d: &str, who: &str, now: i64, verify: impl Fn(&Value) -> bool) -> usize {
    crate::node_keeper::award_days_for(events, d, who, now, verify).len()
}

/// 한 번 읽은 kind 8 묶음 → `{node, relay}` 각각 `{ok, days}`.
pub(crate) fn keepers_from(events: &[Value], who: &str, now: i64, verify: impl Fn(&Value) -> bool) -> Value {
    let one = |d: &str| {
        let n = keeper_award_days(events, d, who, now, &verify);
        json!({ "ok": n >= NODE_NEEDED_DAYS, "days": n })
    };
    json!({ "node": one(crate::node_keeper::AWARD_A), "relay": one(crate::relay_keeper::AWARD_A) })
}

fn node_cache() -> &'static Mutex<HashMap<String, (Instant, Value)>> {
    static C: OnceLock<Mutex<HashMap<String, (Instant, Value)>>> = OnceLock::new();
    C.get_or_init(|| Mutex::new(HashMap::new()))
}

/// 한 사람(공개키)의 지킴이 표시 둘 — `{node, relay}`. 하나를 읽으면 둘 다 안다(같은 열쇠의 kind 8).
/// 모르면 둘 다 `{ok:false, unknown:true}`.
pub(crate) async fn keepers_of(pubkey: &str) -> Value {
    if !valid_pubkey(pubkey) {
        return json!({ "node": unknown(), "relay": unknown() });
    }
    if let Some((at, v)) = node_cache().lock().ok().and_then(|c| c.get(pubkey).cloned()) {
        let fresh_for = if v["node"].get("unknown") == Some(&Value::Bool(true)) { FAIL_FOR } else { CACHE_FOR };
        if at.elapsed() < fresh_for {
            return v;
        }
    }
    let got = {
        let _permit = gate().acquire().await;
        crate::nostrpub::nostr_query(vec![8], vec![NODE_KEEPER_PUB.to_string()], vec![pubkey.to_string()]).await
    };
    let v = match got {
        Ok(r) => {
            let events = r.get("events").and_then(Value::as_array).cloned().unwrap_or_default();
            keepers_from(&events, pubkey, now_secs(), crate::relay::verify)
        }
        Err(_) => json!({ "node": unknown(), "relay": unknown() }),
    };
    if let Ok(mut c) = node_cache().lock() {
        if c.len() > 2000 {
            c.clear();
        }
        c.insert(pubkey.to_string(), (Instant::now(), v.clone()));
    }
    v
}

/// 한 사람의 지킴이 표시 하나(`node` 또는 `relay`). `{ok, days}` 또는 모르면 `{ok:false, unknown:true}`.
pub(crate) async fn keeper_of(pubkey: &str, which: &str) -> Value {
    keepers_of(pubkey).await.get(which).cloned().unwrap_or_else(unknown)
}

#[derive(serde::Deserialize)]
pub struct BadgePerson {
    pubkey: String,
    #[serde(default)]
    address: String,
}

/// 사람마다 기여 표시. `{ 공개키: {address, miner, creator, node, relay} }`.
///
/// 🔴 `address` 는 화면이 `talk_profiles` 에게 받은 **서명 확인된** 주소만 넘긴다(그 밖의 주소는 이름표에 없는 셈).
///    주소가 없는 사람의 채굴·창작 표시는 `{ok:false}` — 볼 주소가 없다.
#[tauri::command]
pub async fn talk_badges(people: Vec<BadgePerson>) -> Value {
    let mut want: Vec<(String, String)> = Vec::new();
    for p in people {
        let pk = p.pubkey.trim().to_string();
        if !valid_pubkey(&pk) || want.iter().any(|(k, _)| *k == pk) {
            continue;
        }
        let a = p.address.trim().to_string();
        want.push((pk, if valid_address(&a) { a } else { String::new() }));
        if want.len() >= MAX_ADDRESSES {
            break;
        }
    }
    let handles: Vec<_> = want
        .iter()
        .cloned()
        .map(|(pk, a)| {
            tokio::spawn(async move {
                let chain = if a.is_empty() {
                    json!({ "address": "", "miner": { "ok": false }, "creator": { "ok": false } })
                } else {
                    badges_of(&a).await
                };
                let k = keepers_of(&pk).await;
                let mut out = chain;
                out["node"] = k["node"].clone();
                out["relay"] = k["relay"].clone();
                out
            })
        })
        .collect();
    let mut out = serde_json::Map::new();
    for ((pk, _), h) in want.into_iter().zip(handles) {
        let v = h.await.unwrap_or_else(|_| json!({ "miner": unknown(), "creator": unknown(), "node": unknown(), "relay": unknown() }));
        out.insert(pk, v);
    }
    Value::Object(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    const A: &str = "RYJ1Jbofs42vuRygtXb1GqTFnoYzbEGsk4";

    #[test]
    fn 확실할_때만_표시가_있다() {
        let v = normalize(A, &json!({ "address": A, "miner": { "ok": true, "blocks": 3, "lastAt": 1700000000 }, "creator": { "ok": true, "assets": ["HANBIT!", "ART"] } }));
        assert!(has_badge(&v, "miner"));
        assert!(has_badge(&v, "creator"));
        assert_eq!(v["creator"]["assets"], json!(["HANBIT", "ART"]));
        assert_eq!(v["miner"]["blocks"], json!(3));
    }

    #[test]
    fn 모르면_표시하지_않고_없다고도_안_한다() {
        let v = normalize(A, &json!({ "address": A, "miner": { "ok": false, "unknown": true }, "creator": { "ok": "true" } }));
        assert!(!has_badge(&v, "miner") && !surely_lacks(&v, "miner"));
        assert!(!has_badge(&v, "creator") && !surely_lacks(&v, "creator"));
        let none = normalize(A, &json!({ "address": A, "miner": { "ok": false }, "creator": { "ok": false } }));
        assert!(surely_lacks(&none, "miner") && surely_lacks(&none, "creator"));
    }

    #[test]
    fn 다른_주소의_답은_안_믿는다() {
        let v = normalize(A, &json!({ "address": "RDtFvAbLXy1HQ1fXHDdqC3RVbYvCH6ffRo", "miner": { "ok": true }, "creator": { "ok": true } }));
        assert!(!has_badge(&v, "miner") && !has_badge(&v, "creator"));
    }

    #[test]
    fn 이상한_자산_이름은_버린다() {
        let v = normalize(A, &json!({ "address": A, "miner": { "ok": false }, "creator": { "ok": true, "assets": ["<b>x</b>!", "OK!"] } }));
        assert_eq!(v["creator"]["assets"], json!(["OK"]));
    }

    #[test]
    fn 주소_모양() {
        assert!(valid_address(A));
        assert!(!valid_address("1YJ1Jbofs42vuRygtXb1GqTFnoYzbEGsk4"));
        assert!(!valid_address("R0J1Jbofs42vuRygtXb1GqTFnoYzbEGsk4"));
        assert!(!valid_address(""));
    }
    fn award(day: &str, p: &str) -> Value {
        json!({ "kind": 8, "pubkey": NODE_KEEPER_PUB, "tags": [["a", format!("30009:{NODE_KEEPER_PUB}:rv-node-keeper")], ["p", p], ["t", "ravencoin"], ["day", day]] })
    }

    #[test]
    fn 노드_지킴이는_서로_다른_날을_센다() {
        let now = 1_762_560_000; // 2025-11-08 UTC
        let me = "a".repeat(64);
        let mut ev: Vec<Value> = (0..26).map(|i| award(&utc_day(now - i * 86_400), &me)).collect();
        ev.push(award(&utc_day(now), &me)); // 같은 날 두 번
        ev.push(award(&utc_day(now - 40 * 86_400), &me)); // 창 밖
        assert_eq!(node_award_days(&ev, &me, now, |_| true), 26);
        assert_eq!(node_award_days(&ev, &"b".repeat(64), now, |_| true), 0, "남에게 준 표시는 안 센다");
        assert_eq!(node_award_days(&ev, &me, now, |_| false), 0, "서명이 틀리면 안 센다");
        let mut fake = award(&utc_day(now), &me);
        fake["pubkey"] = json!("c".repeat(64));
        assert_eq!(node_award_days(&[fake], &me, now, |_| true), 0, "확인 서버 열쇠가 아니면 안 센다");
        let mut wrong_a = award(&utc_day(now), &me);
        wrong_a["tags"][0] = json!(["a", "30009:x:rv-node-keeper"]);
        assert_eq!(node_award_days(&[wrong_a], &me, now, |_| true), 0);
    }

    #[test]
    fn 릴레이_지킴이는_따로_센다() {
        let now = 1_762_560_000;
        let me = "a".repeat(64);
        let relay = |day: &str| json!({ "kind": 8, "pubkey": NODE_KEEPER_PUB, "tags": [["a", format!("30009:{NODE_KEEPER_PUB}:rv-relay-keeper")], ["p", me], ["t", "ravencoin"], ["day", day]] });
        let mut ev: Vec<Value> = (0..25).map(|i| relay(&utc_day(now - i * 86_400))).collect();
        ev.extend((0..3).map(|i| award(&utc_day(now - i * 86_400), &me)));
        let k = keepers_from(&ev, &me, now, |_| true);
        assert_eq!(k["relay"], json!({ "ok": true, "days": 25 }));
        assert_eq!(k["node"], json!({ "ok": false, "days": 3 }), "노드 표시는 릴레이 날을 안 센다");
        let k = keepers_from(&ev[..24], &me, now, |_| true);
        assert_eq!(k["relay"], json!({ "ok": false, "days": 24 }), "25일이 안 되면 없다");
        assert_eq!(keepers_from(&ev, &me, now, |_| false)["relay"]["days"], json!(0), "서명이 틀리면 안 센다");
        let mut fake = relay(&utc_day(now));
        fake["pubkey"] = json!("c".repeat(64));
        assert_eq!(keeper_award_days(&[fake], "rv-relay-keeper", &me, now, |_| true), 0);
    }

    #[test]
    fn 날짜_계산() {
        assert_eq!(utc_day(0), "1970-01-01");
        assert_eq!(utc_day(1_762_560_000), "2025-11-08");
        assert_eq!(utc_day(951_782_400), "2000-02-29");
    }

    #[test]
    fn 빈_표시는_없다고_본다() {
        let v = normalize(A, &json!({ "address": A, "miner": { "ok": true, "blocks": 0 }, "creator": { "ok": true, "assets": [] } }));
        assert!(!has_badge(&v, "miner") && surely_lacks(&v, "miner"));
        assert!(!has_badge(&v, "creator") && surely_lacks(&v, "creator"));
    }

    /// 서명된 진짜 kind 8 이 relay::verify 를 통과하는지(열쇠만 다르게) — 서명 검사가 실제로 걸린다.
    #[test]
    fn 진짜_서명만_통과한다() {
        let sk = [9u8; 32];
        let me = "a".repeat(64);
        let now = 1_762_560_000;
        let tags = json!([["a", format!("30009:{NODE_KEEPER_PUB}:rv-node-keeper")], ["p", me], ["t", "ravencoin"], ["day", utc_day(now)]]);
        let ev = crate::shopkey::sign_with(&sk, 8, tags, "", now).unwrap();
        assert!(crate::relay::verify(&ev));
        // 다른 열쇠가 서명했으니 확인 서버 표시로 안 센다.
        assert_eq!(node_award_days(&[ev.clone()], &me, now, crate::relay::verify), 0);
        // 서명을 그대로 두고 pubkey 만 확인 서버로 바꾸면 서명 검사에서 걸린다.
        let mut forged = ev;
        forged["pubkey"] = json!(NODE_KEEPER_PUB);
        assert_eq!(node_award_days(&[forged], &me, now, crate::relay::verify), 0);
    }
}
