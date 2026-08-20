//! Gym passes — membership, punch cards, and the door.
//!
//! ## The door screen is the product. The chain is the receipt behind it.
//!
//! What replaces paper at a gym is not a token. It is the twenty seconds at
//! 7am when someone walks in and staff has to answer "can they come in".
//! Everything here is arranged around that moment.
//!
//! ## Why the token is only a member number
//!
//! The obvious design — put the expiry in the asset name, `GYM/PASS#20260918-HONG`
//! — is wrong in three separate ways, and each one alone would disqualify it:
//!
//! 1. **It publishes the member roster.** One `listassets GYM/PASS#*` returns
//!    every member's name and the day they stop paying, permanently, to anyone
//!    including a competing gym. In Korea a name plus contract end date is
//!    personal data, and a blockchain cannot delete it.
//! 2. **A gym contract changes constantly.** Injury freezes, extensions,
//!    transfers between spouses, partial refunds, three days credited because
//!    the air conditioning broke. A date burned into a permanent name cannot be
//!    edited — you would issue a new token each time, leave a wrong date on the
//!    chain forever, and end up keeping the freeze list on paper anyway. The
//!    system built to remove paper would add a sheet.
//! 3. **Korean names vanish.** Asset names are ASCII, so 홍길동 filters to an
//!    empty string and every pass issued that day collides on one name.
//!
//! So the unique asset is a **member number** with a random tag — `GYM/M#A7K2`
//! — issued once per member, ~5 RVN, never reissued on renewal. Name, phone,
//! expiry, freezes and visits live in the ledger here. Renewal edits a date; it
//! does not mint anything.
//!
//! ## Why the member does not send anything at the door
//!
//! Requiring a transfer per visit fails before it reaches the chain: the phone
//! is locked, the wallet has no RVN for the fee, they send ten instead of one,
//! and everyone waits for a confirmation while a queue forms. Staff waves them
//! through "just this once" and within three days the punch card is paper again.
//!
//! Staff presses the button. The member only has to be identified.
//!
//! ## What this file is NOT
//!
//! It is not the authority on who holds a token — we cannot know that without
//! `-assetindex`, and pretending otherwise in a comment would be worse than the
//! gap itself. A member who sells their token still gets in, exactly as a member
//! who lends their card does today. That leak is survivable. **Losing this file
//! is not**: thirty people who paid get locked out at 7am. So it is written
//! atomically and can be rebuilt from the wallet.

use crate::raven::call_rpc;
use serde_json::{json, Value};
use std::path::PathBuf;

fn dir() -> PathBuf {
    let home = std::env::var("HOME").unwrap_or_default();
    PathBuf::from(home).join("Library/Application Support/PlayXRaven")
}

fn store_path() -> PathBuf {
    dir().join("passes.json")
}

fn load() -> Vec<Value> {
    std::fs::read_to_string(store_path())
        .ok()
        .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
        .and_then(|v| v.get("passes").and_then(Value::as_array).cloned())
        .unwrap_or_default()
}

/// Writes to a temporary file and renames over the real one.
///
/// A plain write that dies halfway leaves an empty or half-written file — and
/// this file is the difference between the gym opening and the gym not opening.
/// Rename is atomic on the same filesystem, so the old copy survives until the
/// new one is complete. The previous version is kept as `.bak` for the same
/// reason.
fn save(rows: &[Value]) -> Result<(), String> {
    let _ = std::fs::create_dir_all(dir());
    let path = store_path();
    let tmp = dir().join("passes.json.tmp");

    let bytes = serde_json::to_vec_pretty(&json!({ "passes": rows })).map_err(|e| e.to_string())?;
    std::fs::write(&tmp, &bytes).map_err(|e| format!("저장하지 못했습니다: {e}"))?;

    if path.exists() {
        let _ = std::fs::copy(&path, dir().join("passes.json.bak"));
    }
    std::fs::rename(&tmp, &path).map_err(|e| format!("저장하지 못했습니다: {e}"))
}

/// Local calendar day as YYYYMMDD.
///
/// Only ever compared against other days, never used for arithmetic, so a full
/// date library is not warranted. Algorithm is Howard Hinnant's civil_from_days.
fn ymd(now_unix: i64) -> i64 {
    let z = now_unix / 86_400 + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    y * 10_000 + m * 100 + d
}

#[tauri::command]
pub fn today_ymd(now_unix: i64) -> i64 {
    ymd(now_unix)
}

/// A member number: `GYM/M#A7K2`.
///
/// The tag is random, not derived from the member — a derived tag would leak
/// the name it came from, and the whole point is that the chain learns nothing
/// about who this is. Four characters from an unambiguous alphabet gives about
/// a million combinations, which is more members than any gym has, and no
/// `0/O` or `1/I` confusion when someone reads it aloud.
#[tauri::command]
pub fn member_number(root: String, seed: String) -> String {
    const ALPHABET: &[u8] = b"ACDEFGHJKLMNPQRTUVWXY34679";
    // Seeded from the caller so this stays a pure function — the frontend
    // supplies randomness, and the same seed reproduces the same tag if a
    // retry is needed.
    let mut h: u64 = 1469598103934665603;
    for b in seed.bytes() {
        h ^= b as u64;
        h = h.wrapping_mul(1099511628211);
    }
    let tag: String = (0..4)
        .map(|i| {
            let idx = ((h >> (i * 8)) as usize) % ALPHABET.len();
            ALPHABET[idx] as char
        })
        .collect();

    let root = root.trim().trim_end_matches('/').to_uppercase();
    format!("{root}/M#{tag}")
}

/// Adds or replaces a member.
///
/// `expires` and `visits_total` are the contract, and they live here precisely
/// because they change: a freeze moves the date, a refund shortens it, a
/// promotion adds visits. None of that touches the chain.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn save_member(
    asset: String,
    name: String,
    phone: String,
    kind: String,
    expires: i64,
    visits_total: i64,
    note: String,
    now_unix: i64,
) -> Result<(), String> {
    if name.trim().is_empty() {
        return Err("이름이 필요합니다.".into());
    }
    let mut rows = load();

    // Keep whatever is already known — visits used, freezes — so editing a
    // phone number cannot silently reset someone's remaining sessions.
    let existing = rows
        .iter()
        .find(|r| r.get("asset").and_then(Value::as_str) == Some(asset.as_str()))
        .cloned();
    let used = existing
        .as_ref()
        .and_then(|r| r.get("visits_used").and_then(Value::as_i64))
        .unwrap_or(0);
    let frozen = existing
        .as_ref()
        .and_then(|r| r.get("frozen_at").and_then(Value::as_i64))
        .unwrap_or(0);
    let issued = existing
        .as_ref()
        .and_then(|r| r.get("issued").and_then(Value::as_i64))
        .unwrap_or(now_unix);

    rows.retain(|r| r.get("asset").and_then(Value::as_str) != Some(asset.as_str()));
    rows.push(json!({
        "asset": asset,
        "name": name.trim(),
        "phone": phone.trim(),
        "kind": kind,                 // "period" | "punch"
        "expires": expires,           // YYYYMMDD
        "visits_total": visits_total,
        "visits_used": used,
        "frozen_at": frozen,          // 0 = not frozen, else YYYYMMDD
        "note": note.trim(),
        "issued": issued,
        "updated": now_unix,
    }));
    save(&rows)
}

/// Everyone, with validity worked out for today.
#[tauri::command]
pub fn list_members(now_unix: i64) -> Result<Value, String> {
    let today = ymd(now_unix);
    let mut rows = load();
    rows.sort_by_key(|r| -r.get("updated").and_then(Value::as_i64).unwrap_or(0));

    let out: Vec<Value> = rows.iter().map(|r| decorate(r, today)).collect();
    Ok(json!({ "members": out, "today": today }))
}

fn decorate(r: &Value, today: i64) -> Value {
    let kind = r.get("kind").and_then(Value::as_str).unwrap_or("period");
    let expires = r.get("expires").and_then(Value::as_i64).unwrap_or(0);
    let frozen = r.get("frozen_at").and_then(Value::as_i64).unwrap_or(0) > 0;
    let total = r.get("visits_total").and_then(Value::as_i64).unwrap_or(0);
    let used = r.get("visits_used").and_then(Value::as_i64).unwrap_or(0);

    let (ok, why) = if frozen {
        (false, "정지 중")
    } else if kind == "punch" {
        if used < total {
            (true, "")
        } else {
            (false, "횟수를 다 썼습니다")
        }
    } else if expires >= today {
        (true, "")
    } else {
        (false, "기한이 지났습니다")
    };

    let mut o = r.clone();
    if let Some(m) = o.as_object_mut() {
        m.insert("valid".into(), json!(ok));
        m.insert("why".into(), json!(why));
        m.insert("left".into(), json!((total - used).max(0)));
        // 만료가 가까우면 문 화면이 먼저 말해 준다 — 회원이 카운터에 있을 때
        // 말하는 것이 문자 보내는 것보다 갱신으로 이어진다.
        m.insert("days_left".into(), json!(if kind == "period" { expires - today } else { 0 }));
    }
    o
}

/// The door. Name, phone tail, or member number — whatever staff can type fast.
#[tauri::command]
pub fn check_in_lookup(query: String, now_unix: i64) -> Result<Value, String> {
    let today = ymd(now_unix);
    let q = query.trim().to_lowercase();
    if q.is_empty() {
        return Ok(json!({ "matches": [] }));
    }

    let rows = load();
    let matches: Vec<Value> = rows
        .iter()
        .filter(|r| {
            let name = r.get("name").and_then(Value::as_str).unwrap_or("").to_lowercase();
            let phone = r.get("phone").and_then(Value::as_str).unwrap_or("");
            let asset = r.get("asset").and_then(Value::as_str).unwrap_or("").to_lowercase();
            name.contains(&q) || phone.ends_with(q.trim()) || asset.contains(&q)
        })
        .map(|r| decorate(r, today))
        .collect();

    Ok(json!({ "matches": matches, "today": today }))
}

/// Records a visit. Staff presses this; the member does nothing.
///
/// Deliberately refuses when the pass is not valid rather than counting anyway
/// and showing a warning — a count that includes days the member should not
/// have been admitted is a count nobody can reconcile later.
#[tauri::command]
pub fn check_in(asset: String, now_unix: i64) -> Result<Value, String> {
    let today = ymd(now_unix);
    let mut rows = load();

    let Some(idx) = rows
        .iter()
        .position(|r| r.get("asset").and_then(Value::as_str) == Some(asset.as_str()))
    else {
        return Err("등록되지 않은 회원입니다.".into());
    };

    let state = decorate(&rows[idx], today);
    if !state["valid"].as_bool().unwrap_or(false) {
        return Err(state["why"].as_str().unwrap_or("들어올 수 없습니다").to_string());
    }

    if let Some(m) = rows[idx].as_object_mut() {
        if m.get("kind").and_then(Value::as_str) == Some("punch") {
            let used = m.get("visits_used").and_then(Value::as_i64).unwrap_or(0);
            m.insert("visits_used".into(), json!(used + 1));
        }
        let mut log = m
            .get("visits")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        log.push(json!(now_unix));
        // 최근 200회만 남긴다. 출입 기록은 영수증이지 영구 보관 대상이 아니고,
        // 개인 정보를 필요 이상으로 오래 들고 있을 이유가 없다.
        if log.len() > 200 {
            log.drain(0..log.len() - 200);
        }
        m.insert("visits".into(), json!(log));
        m.insert("updated".into(), json!(now_unix));
    }

    save(&rows)?;
    Ok(decorate(&rows[idx], today))
}

/// Freeze or unfreeze. A gym does this constantly; a token cannot express it.
///
/// Unfreezing pushes the expiry out by the number of days frozen, because that
/// is what a member expects and what the gym promised — the alternative is
/// arguing about dates at the counter.
#[tauri::command]
pub fn set_frozen(asset: String, frozen: bool, now_unix: i64) -> Result<Value, String> {
    let today = ymd(now_unix);
    let mut rows = load();
    let Some(idx) = rows
        .iter()
        .position(|r| r.get("asset").and_then(Value::as_str) == Some(asset.as_str()))
    else {
        return Err("등록되지 않은 회원입니다.".into());
    };

    if let Some(m) = rows[idx].as_object_mut() {
        if frozen {
            m.insert("frozen_at".into(), json!(today));
        } else {
            let since = m.get("frozen_at").and_then(Value::as_i64).unwrap_or(0);
            if since > 0 {
                // 날짜 뺄셈이 아니라 일수 차이로 센다 — 20260131과 20260201의
                // 숫자 차이는 70이지 1이 아니다.
                let days = (days_from_ymd(today) - days_from_ymd(since)).max(0);
                let exp = m.get("expires").and_then(Value::as_i64).unwrap_or(0);
                if exp > 0 {
                    m.insert("expires".into(), json!(ymd_add_days(exp, days)));
                }
            }
            m.insert("frozen_at".into(), json!(0));
        }
        m.insert("updated".into(), json!(now_unix));
    }

    save(&rows)?;
    Ok(decorate(&rows[idx], today))
}

fn days_from_ymd(v: i64) -> i64 {
    let (y, m, d) = (v / 10_000, (v / 100) % 100, v % 100);
    let y2 = if m <= 2 { y - 1 } else { y };
    let era = if y2 >= 0 { y2 } else { y2 - 399 } / 400;
    let yoe = y2 - era * 400;
    let mp = if m > 2 { m - 3 } else { m + 9 };
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

fn ymd_add_days(v: i64, days: i64) -> i64 {
    ymd((days_from_ymd(v) + days) * 86_400)
}

fn last_day_of(y: i64, m: i64) -> i64 {
    match m {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        // 윤년: 4로 나뉘되 100으로 나뉘면 아니고, 400으로 나뉘면 다시 맞다.
        _ => if (y % 4 == 0 && y % 100 != 0) || y % 400 == 0 { 29 } else { 28 },
    }
}

/// Adds calendar months, landing on the same day of the month.
///
/// A gym month is not thirty days — it is "the same date next month". Adding 30
/// gives a member who joined on the 1st a pass that expires on the 31st, and
/// naive date arithmetic gives someone who joined on 31 January an expiry of
/// 3 March: a thirty-two day month, sold as one.
///
/// When the target month has no such day, it lands on that month's last day.
/// 31 January plus one month is 28 February, which is what the counter would
/// say and what the member expects.
#[tauri::command]
pub fn add_months(ymd_in: i64, months: i64) -> i64 {
    let (y, m, d) = (ymd_in / 10_000, (ymd_in / 100) % 100, ymd_in % 100);
    let total = (y * 12 + (m - 1)) + months;
    let (ny, nm) = (total.div_euclid(12), total.rem_euclid(12) + 1);
    let nd = d.min(last_day_of(ny, nm));
    ny * 10_000 + nm * 100 + nd
}

/// The expiry a membership starting on `from` should have.
///
/// `from` is separate from today because gyms sell passes that start later —
/// someone paying on Friday for a course beginning Monday. Defaulting the start
/// to the payment date is right; forcing it is not.
#[tauri::command]
pub fn period_end(from_ymd: i64, months: i64, extra_days: i64) -> Value {
    // 시작일 당일도 이용일이다. 한 달권이 1일 시작이면 말일까지, 즉 다음 달
    // 같은 날의 전날이 마지막 날이다.
    let end = ymd_add_days(add_months(from_ymd, months), extra_days - 1);
    json!({
        "start": from_ymd,
        "end": end,
        "days": days_from_ymd(end) - days_from_ymd(from_ymd) + 1,
    })
}

/// Extends a membership — renewal, compensation, a promotion.
///
/// Never mints anything. The member number they already have keeps working,
/// which is the entire reason it does not carry a date.
#[tauri::command]
pub fn extend(asset: String, days: i64, months: i64, now_unix: i64) -> Result<Value, String> {
    let today = ymd(now_unix);
    let mut rows = load();
    let Some(idx) = rows
        .iter()
        .position(|r| r.get("asset").and_then(Value::as_str) == Some(asset.as_str()))
    else {
        return Err("등록되지 않은 회원입니다.".into());
    };

    if let Some(m) = rows[idx].as_object_mut() {
        let exp = m.get("expires").and_then(Value::as_i64).unwrap_or(0);
        // 이미 만료됐으면 오늘부터 센다. 지난 날짜에 더하면 갱신하자마자
        // 또 만료된 회원권이 나온다.
        let base = if exp >= today { exp } else { today };
        // 달 단위가 먼저다. "한 달 연장"은 30일이 아니라 같은 날짜다.
        let after_months = if months != 0 { add_months(base, months) } else { base };
        m.insert("expires".into(), json!(ymd_add_days(after_months, days)));
        m.insert("updated".into(), json!(now_unix));
    }
    save(&rows)?;
    Ok(decorate(&rows[idx], today))
}

/// Adds sessions to a punch card.
#[tauri::command]
pub fn add_visits(asset: String, count: i64, now_unix: i64) -> Result<Value, String> {
    let today = ymd(now_unix);
    let mut rows = load();
    let Some(idx) = rows
        .iter()
        .position(|r| r.get("asset").and_then(Value::as_str) == Some(asset.as_str()))
    else {
        return Err("등록되지 않은 회원입니다.".into());
    };
    if let Some(m) = rows[idx].as_object_mut() {
        let total = m.get("visits_total").and_then(Value::as_i64).unwrap_or(0);
        m.insert("visits_total".into(), json!(total + count));
        m.insert("updated".into(), json!(now_unix));
    }
    save(&rows)?;
    Ok(decorate(&rows[idx], today))
}

/// Member numbers that exist but nobody has been registered against.
///
/// A gym does not only sign people up at the counter. It sells a pass online,
/// the buyer receives the token, and they walk in a week later holding a number
/// that this ledger has never seen. Issuing them a *second* number would burn
/// another 5 RVN and leave them with two passes, one of which works.
///
/// So: which `ROOT/M#` assets did this wallet issue, and which of those have no
/// name attached? Those are the people waiting to be registered.
///
/// Assets that left the wallet are the sold ones — the buyer holds them now, so
/// they no longer appear in `listmyassets`. Both cases are returned, marked, and
/// the register screen offers them instead of minting.
#[tauri::command]
pub async fn unclaimed_numbers(root: String) -> Result<Value, String> {
    let prefix = format!("{}/M#", root.trim().trim_end_matches('/').to_uppercase());

    // Everything ever issued under this root — held or sold.
    let all = call_rpc("listassets", json!([format!("{prefix}*"), true, 500, 0]))
        .await
        .unwrap_or(json!({}));
    let mine = call_rpc("listmyassets", json!([])).await.unwrap_or(json!({}));

    let registered: Vec<String> = load()
        .iter()
        .filter(|r| {
            !r.get("name")
                .and_then(Value::as_str)
                .unwrap_or("")
                .trim()
                .is_empty()
        })
        .filter_map(|r| r.get("asset").and_then(Value::as_str).map(str::to_string))
        .collect();

    let held: Vec<String> = mine
        .as_object()
        .map(|m| m.keys().cloned().collect())
        .unwrap_or_default();

    let rows: Vec<Value> = all
        .as_object()
        .map(|m| {
            m.keys()
                .filter(|n| n.starts_with(&prefix) && !n.ends_with('!'))
                .filter(|n| !registered.contains(n))
                .map(|n| {
                    json!({
                        "asset": n,
                        // 팔린 것은 손님 지갑에 있다. 우리 지갑에 남아 있으면
                        // 아직 아무에게도 안 준 여분이다.
                        "sold": !held.contains(n),
                    })
                })
                .collect()
        })
        .unwrap_or_default();

    Ok(json!({ "numbers": rows, "count": rows.len() }))
}

/// Rebuilds the member list from member-number assets in the wallet.
///
/// The ledger is an index, not the original. If it is lost, every member number
/// this gym issued is still in the wallet — the names and dates are gone, but
/// nobody is locked out permanently and staff can retype what they know.
/// Recovering an empty shell beats recovering nothing.
#[tauri::command]
pub async fn rebuild_members(root: String, now_unix: i64) -> Result<Value, String> {
    let owned = call_rpc("listmyassets", json!([])).await?;
    let prefix = format!("{}/M#", root.trim().trim_end_matches('/').to_uppercase());

    let known: Vec<String> = load()
        .iter()
        .filter_map(|r| r.get("asset").and_then(Value::as_str).map(str::to_string))
        .collect();

    let found: Vec<String> = owned
        .as_object()
        .map(|m| {
            m.keys()
                .filter(|n| n.starts_with(&prefix) && !n.ends_with('!'))
                .cloned()
                .collect()
        })
        .unwrap_or_default();

    let missing: Vec<&String> = found.iter().filter(|f| !known.contains(f)).collect();

    let mut rows = load();
    for asset in &missing {
        rows.push(json!({
            "asset": asset,
            "name": "",              // 체인은 이름을 모른다 — 일부러 그렇게 만들었다
            "phone": "",
            "kind": "period",
            "expires": 0,
            "visits_total": 0,
            "visits_used": 0,
            "frozen_at": 0,
            "note": "장부 복구 — 이름과 기간을 다시 넣어 주세요",
            "issued": now_unix,
            "updated": now_unix,
        }));
    }
    if !missing.is_empty() {
        save(&rows)?;
    }

    Ok(json!({
        "found": found.len(),
        "restored": missing.len(),
        "today": ymd(now_unix),
    }))
}

/// Removes a member from this gym's ledger. Does not touch the chain.
///
/// The token stays in their wallet — we cannot take it back, and the UI must
/// not imply otherwise. This only stops this door from recognising it.
#[tauri::command]
pub fn remove_member(asset: String) -> Result<(), String> {
    let mut rows = load();
    rows.retain(|r| r.get("asset").and_then(Value::as_str) != Some(asset.as_str()));
    save(&rows)
}
