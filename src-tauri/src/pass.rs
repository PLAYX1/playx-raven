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

const MEMO_MAX_CHARS: usize = 300;
const MEMO_MAX_COUNT: usize = 50;

// Serialize ledger read-modify-write operations with the daily privacy cleanup.
static STORE_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

fn dir() -> PathBuf {
    crate::paths::app_dir()
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

// 삭제된 개인정보가 이전 장부 사본에 남지 않게 원자적으로 덮어쓴다.
fn rewrite_backup(rows: &[Value]) -> Result<(), String> {
    let tmp = dir().join("passes.json.bak.tmp");
    std::fs::write(&tmp, serde_json::to_vec_pretty(&json!({ "passes": rows }))
        .map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    std::fs::rename(tmp, dir().join("passes.json.bak")).map_err(|e| e.to_string())
}

pub fn clean_memo(text: &str) -> Result<String, String> {
    let text = text.replace("\r\n", " ").replace(['\r', '\n'], " ");
    if text.chars().any(char::is_control) {
        return Err("MEMO_INVALID: 메모에는 제어문자를 넣을 수 없습니다.".into());
    }
    let text = text.trim();
    if !(1..=MEMO_MAX_CHARS).contains(&text.chars().count()) {
        return Err("MEMO_INVALID: 메모는 1~300자 한 줄로 적어 주세요.".into());
    }
    Ok(text.to_string())
}

pub fn append_memo(asset: &str, by: &str, text: &str, now_unix: i64) -> Result<Vec<Value>, String> {
    if !matches!(by, "owner" | "staff" | "scanner") {
        return Err("MEMO_INVALID: 메모 작성 권한을 확인해 주세요.".into());
    }
    let text = clean_memo(text)?;
    let _guard = STORE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut rows = load();
    let row = rows.iter_mut().find(|r| r["asset"].as_str() == Some(asset))
        .ok_or_else(|| "NOT_MEMBER: 회원이 아닌 표입니다.".to_string())?;
    if row["redacted"] == true {
        return Err("MEMBER_REDACTED: 이미 정보가 지워진 회원입니다.".into());
    }
    let mut memos = row["memos"].as_array().cloned().unwrap_or_default();
    if memos.len() >= MEMO_MAX_COUNT {
        return Err("MEMO_LIMIT: 메모는 한 회원에 50개까지 적을 수 있습니다.".into());
    }
    memos.push(json!({ "at": now_unix, "by": by, "text": text }));
    row["memos"] = json!(memos);
    save(&rows)?;
    Ok(memos)
}

pub fn member_info(asset: &str, _now_unix: i64) -> Result<Value, String> {
    let _guard = STORE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let rows = load();
    let row = rows.iter().find(|r| r["asset"].as_str() == Some(asset))
        .ok_or_else(|| "NOT_MEMBER: 회원이 아닌 표입니다.".to_string())?;
    let redacted = row["redacted"] == true;
    let kind = row["kind"].as_str().unwrap_or("period");
    let visits_left = if kind == "punch" {
        Some(row["visits_total"].as_i64().unwrap_or(0)
            .saturating_sub(row["visits_used"].as_i64().unwrap_or(0)).max(0))
    } else { None };
    Ok(json!({ "code": asset, "name": if redacted { "" } else { row["name"].as_str().unwrap_or("") },
        "until": row["expires"].as_i64().unwrap_or(0), "kind": kind, "visits_left": visits_left,
        "memos": if redacted { Vec::new() } else { row["memos"].as_array().cloned().unwrap_or_default() },
        "groups": row_groups(row), "redacted": redacted }))
}

fn row_groups(row: &Value) -> Vec<String> {
    if row["redacted"] == true { return Vec::new(); }
    row["groups"].as_array().map(|values| values.iter()
        .filter_map(Value::as_str).map(str::to_string).collect()).unwrap_or_default()
}

pub fn assign_groups(asset: &str, groups: Vec<String>, _now_unix: i64) -> Result<Value, String> {
    crate::member_privacy::with_member_groups(|allowed| {
        let groups = crate::member_privacy::clean_member_groups(&groups, allowed)?;
        let _guard = STORE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let mut rows = load();
        let row = rows.iter_mut().find(|r| r["asset"].as_str() == Some(asset))
            .ok_or_else(|| "NOT_MEMBER: 회원이 아닌 표입니다.".to_string())?;
        if row["redacted"] == true {
            return Err("MEMBER_REDACTED: 이미 정보가 지워진 회원입니다.".into());
        }
        row["groups"] = json!(groups);
        // Like append_memo, do not change updated: administrative classification
        // must not extend retention, whose activity calculation includes updated.
        save(&rows)?;
        Ok(json!({ "code": asset, "groups": groups }))
    })
}

#[tauri::command]
pub fn member_groups_assign(asset: String, groups: Vec<String>, now_unix: i64) -> Result<Value, String> {
    assign_groups(&asset, groups, now_unix)
}

// Caller holds GROUPS_LOCK. Acquire STORE_LOCK second and save the whole ledger once.
pub(crate) fn reconcile_member_groups(
    allowed: &[String], renames: &[(String, String)], persist_groups: impl FnOnce() -> Result<(), String>,
) -> Result<(), String> {
    let _guard = STORE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    // Refuse to replace a corrupt ledger with an empty roster.
    let mut rows = match std::fs::read(store_path()) {
        Ok(bytes) => serde_json::from_slice::<Value>(&bytes).ok()
            .and_then(|v| v["passes"].as_array().cloned())
            .ok_or_else(|| "회원 장부를 읽지 못했습니다.".to_string())?,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Vec::new(),
        Err(_) => return Err("회원 장부를 읽지 못했습니다.".into()),
    };
    for row in &mut rows {
        let mut groups = Vec::new();
        for old in row_groups(row) {
            let new = renames.iter().find(|(from, _)| from == &old).map(|(_, to)| to).unwrap_or(&old);
            if allowed.contains(new) && !groups.contains(new) { groups.push(new.clone()); }
        }
        row["groups"] = json!(groups);
    }
    // 장부를 먼저, 분류 목록을 나중에. 분류 목록 저장이 실패해도 같은 바꾸기를
    // 다시 하면 옛 이름이 목록에 남아 있어 통과하고, 장부는 이미 새 이름이라
    // 그대로 남는다. 반대 순서면 재시도가 GROUP_INVALID 로 막혀 옛 이름이 영영 남는다.
    save(&rows)?;
    persist_groups()
}

#[tauri::command]
pub fn member_memo_add(asset: String, text: String, now_unix: i64) -> Result<Value, String> {
    let memos = append_memo(&asset, "owner", &text, now_unix)?;
    Ok(json!({ "code": asset, "memos": memos }))
}

#[tauri::command]
pub fn member_memo_delete(asset: String, at: i64, index: usize) -> Result<Value, String> {
    let _guard = STORE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut rows = load();
    let row = rows.iter_mut().find(|r| r["asset"].as_str() == Some(asset.as_str()))
        .ok_or_else(|| "NOT_MEMBER: 회원이 아닌 표입니다.".to_string())?;
    let mut memos = row["memos"].as_array().cloned().unwrap_or_default();
    if memos.get(index).and_then(|m| m["at"].as_i64()) != Some(at) {
        return Err("메모가 바뀌었습니다. 다시 열어 주세요.".into());
    }
    memos.remove(index);
    row["memos"] = json!(memos);
    save(&rows)?;
    // save 는 지우기 전 판을 .bak 로 남긴다. 손님이 지워 달라 해서 지운 메모가
    // 백업에 남으면 지운 것이 아니다 — 회원 한 명 지우기와 같은 방식으로 덮는다.
    rewrite_backup(&rows)?;
    Ok(json!({ "code": asset, "memos": memos }))
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
    // 체육관마다 더 받는 것들 — 생년·성별·비상연락처 같은 것.
    //
    // 🔴 칸을 고정으로 박지 않는다. 필라테스는 생년을 받고, 복싱은
    // 비상연락처를 받고, 어린이 체육관은 보호자 이름을 받는다. 우리가
    // 정해 주면 안 쓰는 칸이 늘 비어 있거나, 필요한 칸이 없다.
    extra: Option<Value>,
) -> Result<(), String> {
    let _guard = STORE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut rows = load();
    put_member(&mut rows, asset, name, phone, kind, expires, visits_total, note, now_unix, extra)?;
    save(&rows)
}

#[allow(clippy::too_many_arguments)]
pub fn insert_member_if_absent(
    asset: String, name: String, phone: String, kind: String, expires: i64,
    visits_total: i64, note: String, now_unix: i64, extra: Option<Value>,
    first_memo: Option<(String, String)>, groups: Option<Vec<String>>,
) -> Result<(), String> {
    crate::member_privacy::with_member_groups(|allowed| {
        let groups = crate::member_privacy::clean_member_groups(&groups.unwrap_or_default(), allowed)?;
        // Never take STORE_LOCK while holding the ticket lock: cleanup uses STORE -> ticket.
        let _guard = STORE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let mut rows = load();
        if rows.iter().any(|row| row["asset"].as_str() == Some(asset.as_str())) {
            return Err("이미 회원으로 등록된 표입니다.".into());
        }
        put_member(&mut rows, asset, name, phone, kind, expires, visits_total, note, now_unix, extra)?;
        if let Some((by, text)) = first_memo {
            rows.last_mut().unwrap()["memos"] = json!([{ "at": now_unix, "by": by, "text": text }]);
        }
        rows.last_mut().unwrap()["groups"] = json!(groups);
        save(&rows)
    })
}

#[allow(clippy::too_many_arguments)]
fn put_member(
    rows: &mut Vec<Value>, asset: String, name: String, phone: String, kind: String,
    expires: i64, visits_total: i64, note: String, now_unix: i64, extra: Option<Value>,
) -> Result<(), String> {
    if name.trim().is_empty() {
        return Err("이름이 필요합니다.".into());
    }

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

    // 🔴 **출석 기록을 지키고 들어간다.** 아래에서 같은 회원 줄을 지우고 새로
    // 넣는데, `visits` 를 안 들고 오면 이름 한 글자 고칠 때마다 그 사람이
    // 여태 몇 번 왔는지가 통째로 사라진다.
    let old_visits = existing
        .as_ref()
        .and_then(|r| r.get("visits").cloned())
        .unwrap_or_else(|| json!([]));
    // 회원 정보를 고쳐도 직원들이 남긴 메모는 보존한다.
    let old_memos = existing.as_ref().and_then(|r| r.get("memos").cloned())
        .unwrap_or_else(|| json!([]));
    // 이번에 안 보낸 항목은 예전 것을 지킨다. 전화번호만 고치러 왔다가
    // 생년월일이 지워지면 안 된다.
    let mut merged = existing
        .as_ref()
        .and_then(|r| r.get("extra").cloned())
        .and_then(|v| v.as_object().cloned())
        .unwrap_or_default();
    if let Some(add) = extra.as_ref().and_then(Value::as_object) {
        for (k, v) in add {
            merged.insert(k.clone(), v.clone());
        }
    }

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
        // 체육관마다 다른 것들. 사장이 고른 항목만 온다.
        "extra": Value::Object(merged),
        // 언제 왔는지. 없으면 정보를 한 번 고칠 때마다 출석이 사라진다.
        "visits": old_visits,
        "memos": old_memos,
        "groups": existing.as_ref().map(row_groups).unwrap_or_default(),
        "issued": issued,
        "updated": now_unix,
    }));
    Ok(())
}

/// Remove identifying data after calendar-month retention; keep the contract and visits.
/// The UTC calendar agrees with the existing pass expiry helpers. The deadline day
/// itself is included. Period passes use expiry; other passes use the latest activity.
pub fn redact_expired_members(now_unix: i64, retention_months: u32) -> Result<usize, String> {
    if !matches!(retention_months, 3 | 6 | 12) {
        return Err("회원 정보 보관 개월 수가 올바르지 않습니다.".into());
    }
    let _guard = STORE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    // Do not turn an unreadable/corrupt ledger into an empty one during cleanup.
    let bytes = match std::fs::read(store_path()) {
        Ok(bytes) => bytes,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(0),
        Err(_) => return Err("회원 장부를 읽지 못했습니다.".into()),
    };
    let data: Value = serde_json::from_slice(&bytes).map_err(|_| "회원 장부를 읽지 못했습니다.".to_string())?;
    let mut rows = data.get("passes").and_then(Value::as_array).cloned()
        .ok_or_else(|| "회원 장부를 읽지 못했습니다.".to_string())?;
    let today = ymd(now_unix);
    let mut count = 0;
    for row in &mut rows {
        if row["redacted"] == true { continue; }
        // 정지 중인 회원은 아직 계약 중이다(장기 부상 정지 등). 만료일이
        // 오래전이어도 지우지 않는다 — 정지를 풀면 그때부터 다시 센다.
        if row["frozen_at"].as_i64().unwrap_or(0) > 0 { continue; }
        let expires = row["expires"].as_i64().unwrap_or(0);
        let base = if row["kind"] == "period" && expires > 0 {
            expires
        } else {
            let visit = row["visits"].as_array().and_then(|v| v.last())
                .and_then(Value::as_i64).unwrap_or(0);
            let activity = visit.max(row["updated"].as_i64().unwrap_or(0))
                .max(row["issued"].as_i64().unwrap_or(0));
            // No usable date means we cannot safely decide that retention has elapsed.
            if activity <= 0 { continue; }
            ymd(activity)
        };
        if add_months(base, retention_months as i64) > today { continue; }
        row["name"] = json!("");
        row["phone"] = json!("");
        row["note"] = json!("");
        row["memos"] = json!([]);
        row["groups"] = json!([]);
        // Extra is owner-defined free text. Keep only consent evidence, not
        // guessed field names: emergency contacts and birthdays also identify people.
        let mut extra = serde_json::Map::new();
        for key in ["consent_at", "consent_version"] {
            if let Some(value) = row.get("extra").and_then(|e| e.get(key)) {
                extra.insert(key.into(), value.clone());
            }
        }
        row["extra"] = Value::Object(extra);
        row["redacted"] = json!(true);
        row["redacted_at"] = json!(now_unix);
        count += 1;
    }
    let assets: Vec<String> = rows.iter().filter(|r| r["redacted"] == true)
        .filter_map(|r| r["asset"].as_str().map(str::to_string)).collect();
    if count > 0 { save(&rows)?; }
    if !assets.is_empty() {
        // The normal .bak contains the previous (identifying) version. Replace
        // it atomically with the sanitized snapshot, also on retry after failure.
        rewrite_backup(&rows)?;
        crate::ticket::redact_member_names(&assets)?;
    }
    Ok(count)
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

fn member_validity(r: &Value, today: i64) -> (bool, &'static str) {
    let kind = r.get("kind").and_then(Value::as_str).unwrap_or("period");
    let expires = r.get("expires").and_then(Value::as_i64).unwrap_or(0);
    let frozen = r.get("frozen_at").and_then(Value::as_i64).unwrap_or(0) > 0;
    let total = r.get("visits_total").and_then(Value::as_i64).unwrap_or(0);
    let used = r.get("visits_used").and_then(Value::as_i64).unwrap_or(0);

    if frozen {
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
    }
}

// Same buckets as the owner roster: invalid (including frozen/exhausted) = over;
// valid period passes with <= 7 calendar days left (expiry day included) = ending;
// all other valid passes, including punch cards with remaining visits = active.
fn member_status(r: &Value, today: i64) -> &'static str {
    if !member_validity(r, today).0 { "over" }
    else if r["kind"] == "period"
        && days_from_ymd(r["expires"].as_i64().unwrap_or(0)) - days_from_ymd(today) <= 7 { "ending" }
    else { "active" }
}

fn decorate(r: &Value, today: i64) -> Value {
    let kind = r["kind"].as_str().unwrap_or("period");
    let expires = r["expires"].as_i64().unwrap_or(0);
    let total = r["visits_total"].as_i64().unwrap_or(0);
    let used = r["visits_used"].as_i64().unwrap_or(0);
    let (ok, why) = member_validity(r, today);
    let mut o = r.clone();
    if let Some(m) = o.as_object_mut() {
        m.insert("groups".into(), json!(row_groups(r)));
        m.insert("status".into(), json!(member_status(r, today)));
        m.insert("valid".into(), json!(ok));
        m.insert("why".into(), json!(why));
        m.insert("left".into(), json!((total - used).max(0)));
        // 만료가 가까우면 문 화면이 먼저 말해 준다 — 회원이 카운터에 있을 때
        // 말하는 것이 문자 보내는 것보다 갱신으로 이어진다.
        // 🔴 `expires - today` 로 세고 있었다. 둘 다 `YYYYMMDD` 라 그건 **날짜
        // 뺄셈이 아니라 자릿수 뺄셈**이다:
        //
        //   20260922 - 20260823 =   99   (진짜로는 30일)
        //   20260901 - 20260831 =   70   (진짜로는 1일 — 내일 끝난다)
        //   20270822 - 20260823 = 9999   (진짜로는 364일)
        //
        // 한 달권이 「99일 남음」으로 뜨는 것보다 나쁜 것이 있다. 화면의
        // 「7일 안에 만료 — 지금 말씀하세요」가 **영영 안 뜬다.** 70 도 99 도
        // 7 보다 크기 때문이다. 내일 끝나는 회원에게 아무 말도 못 하고
        // 있었고, 갱신은 카운터에서 그 한마디로 일어난다.
        // 생년을 받은 체육관은 나이를 자동으로 센다. 손으로 적으면 해가
        // 바뀌어도 안 늘어난다.
        if let Some(y) = r
            .pointer("/extra/birth_year")
            .and_then(|v| v.as_i64().or_else(|| v.as_str().and_then(|s| s.parse().ok())))
            .filter(|y| (1900..=2100).contains(y))
        {
            m.insert("age".into(), json!(today / 10_000 - y));
        }
        // 여태 몇 번, 마지막이 언제, 최근 30일에 몇 번.
        // 🔴 전체 횟수만으로는 「요즘 안 나온다」가 안 보인다. 그게 사장이
        // 연락해야 하는 유일한 신호다.
        let visits = r.get("visits").and_then(Value::as_array).cloned().unwrap_or_default();
        let month_ago = days_from_ymd(today) * 86_400 - 30 * 86_400;
        m.insert("visit_count".into(), json!(visits.len()));
        m.insert("last_visit".into(), json!(visits.last().and_then(Value::as_i64)));
        m.insert(
            "visits_30d".into(),
            json!(visits
                .iter()
                .filter(|v| v.as_i64().map(|s| s >= month_ago).unwrap_or(false))
                .count()),
        );
        m.insert(
            "days_left".into(),
            json!(if kind == "period" {
                days_from_ymd(expires) - days_from_ymd(today)
            } else {
                0
            }),
        );
    }
    o
}

pub fn search_members(q: &str, group: Option<&str>, status: Option<&str>, now_unix: i64) -> Result<Value, String> {
    crate::member_privacy::with_member_groups(|allowed| {
        let invalid = || "QUERY_INVALID: 검색어와 분류·상태 조건을 확인해 주세요.".to_string();
        let query = q.trim();
        if q.chars().any(char::is_control)
            || (!query.is_empty() && !(2..=20).contains(&query.chars().count()))
            || (query.is_empty() && group.is_none() && status.is_none())
            || group.is_some_and(|g| !allowed.iter().any(|v| v == g))
            || status.is_some_and(|s| !matches!(s, "active" | "ending" | "over")) {
            return Err(invalid());
        }
        let _guard = STORE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let mut rows = load();
        // Match list_members' latest-updated-first order, including stable ties.
        rows.sort_by_key(|r| std::cmp::Reverse(r["updated"].as_i64().unwrap_or(0)));
        let name_query = query.to_lowercase();
        let asset_query = query.to_uppercase();
        let phone_query = query.len() == 4 && query.bytes().all(|c| c.is_ascii_digit());
        let today = ymd(now_unix);
        let mut results = Vec::new();
        for row in rows {
            if row["redacted"] == true { continue; }
            let groups = row_groups(&row);
            let row_status = member_status(&row, today);
            if group.is_some_and(|g| !groups.iter().any(|v| v == g))
                || status.is_some_and(|s| s != row_status) { continue; }
            let name = row["name"].as_str().unwrap_or("");
            let asset = row["asset"].as_str().unwrap_or("");
            let phone: String = row["phone"].as_str().unwrap_or("").chars().filter(char::is_ascii_digit).collect();
            if !query.is_empty() && !name.to_lowercase().contains(&name_query)
                && !asset.to_uppercase().contains(&asset_query)
                && !(phone_query && phone.ends_with(query)) { continue; }
            let kind = row["kind"].as_str().unwrap_or("period");
            let visits_left = if kind == "punch" {
                Some(row["visits_total"].as_i64().unwrap_or(0)
                    .saturating_sub(row["visits_used"].as_i64().unwrap_or(0)).max(0))
            } else { None };
            // Explicit allowlist: never return phone (even its tail), memos, note or extra.
            results.push(json!({ "code": asset, "name": name, "until": row["expires"].as_i64().unwrap_or(0),
                "kind": kind, "visits_left": visits_left, "groups": groups, "status": row_status }));
            if results.len() == 31 { break; }
        }
        let more = results.len() > 30;
        results.truncate(30);
        Ok(json!({ "results": results, "more": more }))
    })
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
    let _guard = STORE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
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
    let _guard = STORE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
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

pub fn days_from_ymd(v: i64) -> i64 {
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
    let _guard = STORE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
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
    let _guard = STORE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
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

    let _guard = STORE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
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
    let _guard = STORE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut rows = load();
    rows.retain(|r| r.get("asset").and_then(Value::as_str) != Some(asset.as_str()));
    save(&rows)?;
    rewrite_backup(&rows)
}


#[cfg(test)]
mod days_left_tests {
    use super::*;

    #[test]
    fn groups_survive_edits_rename_delete_and_do_not_extend_retention() {
        use crate::member_privacy::member_groups_set;
        crate::member_privacy::tests::in_sandbox(|| {
            member_groups_set(vec!["Alpha".into(), "Beta".into()], None).unwrap();
            synthetic_member("SYNTHETIC", "punch");
            assert!(assign_groups("MISSING", vec![], 99).unwrap_err().starts_with("NOT_MEMBER: "));
            assert!(assign_groups("SYNTHETIC", vec!["Unknown".into()], 99).unwrap_err().starts_with("GROUP_INVALID: "));
            let value = member_groups_assign("SYNTHETIC".into(), vec![" Alpha ".into(), "Beta".into(), "Alpha".into()], 99).unwrap();
            assert_eq!(value, json!({"code":"SYNTHETIC","groups":["Alpha","Beta"]}));
            append_memo("SYNTHETIC", "owner", "synthetic memo", 100).unwrap();
            assert_eq!(load()[0]["updated"], 42);
            save_member("SYNTHETIC".into(), "Synthetic Edited".into(), "0000".into(),
                "punch".into(), 20260101, 10, "".into(), 42, None).unwrap();
            assert_eq!(member_info("SYNTHETIC", 42).unwrap()["groups"], json!(["Alpha","Beta"]));
            member_groups_set(vec!["Gamma".into(), "Beta".into()], Some(vec![("Alpha".into(), "Gamma".into())])).unwrap();
            assert_eq!(load()[0]["groups"], json!(["Gamma", "Beta"]));
            assert_eq!(list_members(42).unwrap()["members"][0]["groups"], json!(["Gamma", "Beta"]));
            assert_eq!(check_in_lookup("Synthetic".into(), 42).unwrap()["matches"][0]["groups"], json!(["Gamma", "Beta"]));
            member_groups_set(vec!["Gamma".into()], None).unwrap();
            assert_eq!(load()[0]["groups"], json!(["Gamma"]));
            assert_eq!(load()[0]["updated"], 42);
            assert!(member_groups_set(vec!["Gamma".into()], Some(vec![("Unknown".into(), "Gamma".into())])).is_err());
        });
    }

    #[test]
    fn group_renames_are_simultaneous_and_do_not_overwrite_corrupt_ledger() {
        use crate::member_privacy::{member_groups_set, member_groups_get};
        crate::member_privacy::tests::in_sandbox(|| {
            member_groups_set(vec!["Alpha".into(), "Beta".into()], None).unwrap();
            synthetic_member("SYNTHETIC", "period");
            assign_groups("SYNTHETIC", vec!["Alpha".into(), "Beta".into()], 42).unwrap();
            member_groups_set(vec!["Alpha".into(), "Beta".into()], Some(vec![
                ("Alpha".into(), "Beta".into()), ("Beta".into(), "Alpha".into())])).unwrap();
            assert_eq!(load()[0]["groups"], json!(["Beta", "Alpha"]));
            member_groups_set(vec!["Beta".into()], Some(vec![("Alpha".into(), "Beta".into())])).unwrap();
            assert_eq!(load()[0]["groups"], json!(["Beta"]));
            std::fs::write(store_path(), b"synthetic corrupt ledger").unwrap();
            assert!(member_groups_set(vec![], None).is_err());
            assert_eq!(member_groups_get().unwrap(), vec!["Beta"]);
            assert_eq!(std::fs::read_to_string(store_path()).unwrap(), "synthetic corrupt ledger");
        });
    }

    #[test]
    fn group_cleanup_and_removal_erase_live_and_backup_data() {
        crate::member_privacy::tests::in_sandbox(|| {
            crate::member_privacy::member_groups_set(vec!["SyntheticTag".into()], None).unwrap();
            synthetic_member("SYNTHETIC", "period");
            assign_groups("SYNTHETIC", vec!["SyntheticTag".into()], 42).unwrap();
            assert_eq!(redact_expired_members(days_from_ymd(20260828) * 86400, 6).unwrap(), 1);
            assert_eq!(member_info("SYNTHETIC", 42).unwrap()["groups"], json!([]));
            assert_eq!(list_members(42).unwrap()["members"][0]["groups"], json!([]));
            assert_eq!(check_in_lookup("SYNTHETIC".into(), 42).unwrap()["matches"][0]["groups"], json!([]));
            assert!(assign_groups("SYNTHETIC", vec![], 42).unwrap_err().starts_with("MEMBER_REDACTED: "));
            for path in [store_path(), dir().join("passes.json.bak")] {
                let raw = std::fs::read_to_string(path).unwrap();
                let data: Value = serde_json::from_str(&raw).unwrap();
                assert_eq!(data["passes"][0]["groups"], json!([]));
                assert!(!raw.contains("SyntheticTag"));
            }
            synthetic_member("DELETE", "period");
            assign_groups("DELETE", vec!["SyntheticTag".into()], 42).unwrap();
            remove_member("DELETE".into()).unwrap();
            for path in [store_path(), dir().join("passes.json.bak")] {
                let raw = std::fs::read_to_string(path).unwrap();
                assert!(!raw.contains("SyntheticTag"));
                assert!(!raw.contains("DELETE"));
            }
        });
    }

    #[test]
    fn search_status_matches_roster_calendar_and_punch_boundaries() {
        let today = 20260831;
        for (kind, expires, total, used, frozen, expected) in [
            ("period", 20260830, 0, 0, 0, "over"),
            ("period", 20260831, 0, 0, 0, "ending"),
            ("period", 20260907, 0, 0, 0, "ending"),
            ("period", 20260908, 0, 0, 0, "active"),
            ("period", 20260908, 0, 0, today, "over"),
            ("period", 0, 0, 0, 0, "over"),
            ("punch", 20200101, 10, 9, 0, "active"),
            ("punch", 20990101, 10, 10, 0, "over"),
            ("punch", 20990101, 10, 9, today, "over"),
        ] {
            let row = json!({"kind":kind,"expires":expires,"visits_total":total,"visits_used":used,"frozen_at":frozen});
            let roster = decorate(&row, today);
            let existing_bucket = if roster["valid"] != true { "over" }
                else if kind == "period" && roster["days_left"].as_i64().unwrap() <= 7 { "ending" }
                else { "active" };
            assert_eq!(member_status(&row, today), expected);
            assert_eq!(roster["status"], existing_bucket);
        }
    }

    #[test]
    fn deleted_memo_leaves_no_copy_in_backup_and_frozen_members_are_kept() {
        crate::member_privacy::tests::in_sandbox(|| {
            synthetic_member("SYNTHETIC", "period");
            append_memo("SYNTHETIC", "owner", "synthetic secret memo", 100).unwrap();
            append_memo("SYNTHETIC", "owner", "synthetic keep memo", 101).unwrap();
            member_memo_delete("SYNTHETIC".into(), 100, 0).unwrap();
            for path in [store_path(), dir().join("passes.json.bak")] {
                let raw = std::fs::read_to_string(&path).unwrap();
                assert!(!raw.contains("synthetic secret memo"), "{path:?}");
                assert!(raw.contains("synthetic keep memo"), "{path:?}");
            }
            let mut rows = load();
            rows[0]["frozen_at"] = json!(20260101);
            save(&rows).unwrap();
            assert_eq!(redact_expired_members(days_from_ymd(20300101) * 86400, 6).unwrap(), 0);
            assert_eq!(load()[0]["name"], "Synthetic Member");
            let mut rows = load();
            rows[0]["frozen_at"] = json!(0);
            save(&rows).unwrap();
            assert_eq!(redact_expired_members(days_from_ymd(20300101) * 86400, 6).unwrap(), 1);
        });
    }

    #[test]
    fn memo_cleaning_counts_characters_and_rejects_controls() {
        assert_eq!(clean_memo("  synthetic\r\nmemo\rnext\nline  ").unwrap(), "synthetic memo next line");
        for text in ["", "  ", "\r\n", "memo\t", "memo\0", "memo\u{7f}"] {
            assert!(clean_memo(text).unwrap_err().starts_with("MEMO_INVALID: "));
        }
        for text in ["a".repeat(301), "가".repeat(301)] {
            assert!(clean_memo(&text).is_err());
        }
        for text in ["a".repeat(300), "가".repeat(300)] {
            assert_eq!(clean_memo(&text).unwrap(), text);
        }
    }

    fn synthetic_member(asset: &str, kind: &str) {
        save_member(asset.into(), "Synthetic Member".into(), "0000".into(), kind.into(),
            20260101, 10, "synthetic legacy note".into(), 42,
            Some(json!({"consent_version":"member-privacy-v2"}))).unwrap();
    }

    #[test]
    fn memos_survive_edits_enforce_limits_and_guard_deletion() {
        crate::member_privacy::tests::in_sandbox(|| {
            assert!(append_memo("MISSING", "staff", "synthetic", 1).unwrap_err().starts_with("NOT_MEMBER:"));
            synthetic_member("ROOT/M#ABCD", "punch");
            assert!(append_memo("ROOT/M#ABCD", "customer", "synthetic", 1).unwrap_err().starts_with("MEMO_INVALID:"));
            for i in 0..50 {
                assert_eq!(append_memo("ROOT/M#ABCD", "staff", &format!("synthetic {i}"), i).unwrap().len(), i as usize + 1);
            }
            assert!(append_memo("ROOT/M#ABCD", "staff", "synthetic overflow", 51).unwrap_err().starts_with("MEMO_LIMIT:"));
            synthetic_member("ROOT/M#ABCD", "punch");
            let info = member_info("ROOT/M#ABCD", 42).unwrap();
            assert_eq!(info["memos"].as_array().unwrap().len(), 50);
            assert_eq!(info["visits_left"], 10);
            assert_eq!(info["until"], 20260101);
            assert!(info.get("phone").is_none());
            assert_eq!(load()[0]["extra"]["consent_version"], "member-privacy-v2");
            assert_eq!(load()[0]["note"], "synthetic legacy note");
            assert!(member_memo_delete("ROOT/M#ABCD".into(), 9, 0).is_err());
            assert!(member_memo_delete("ROOT/M#ABCD".into(), 0, 50).is_err());
            let result = member_memo_delete("ROOT/M#ABCD".into(), 0, 0).unwrap();
            assert_eq!(result["memos"].as_array().unwrap().len(), 49);
            assert!(member_memo_delete("ROOT/M#ABCD".into(), 0, 0).is_err());
            let result = member_memo_add("ROOT/M#ABCD".into(), "synthetic owner memo".into(), 52).unwrap();
            assert_eq!(result["memos"][49]["by"], "owner");
            assert_eq!(result["memos"][49]["at"], 52);
        });
    }

    #[test]
    fn concurrent_memos_keep_every_append() {
        crate::member_privacy::tests::in_sandbox(|| {
            synthetic_member("SYNTHETIC", "period");
            let barrier = std::sync::Barrier::new(8);
            std::thread::scope(|scope| {
                for thread in 0..8 {
                    let barrier = &barrier;
                    scope.spawn(move || {
                        barrier.wait();
                        for i in 0..5 {
                            append_memo("SYNTHETIC", "scanner", &format!("synthetic {thread}-{i}"), 42).unwrap();
                        }
                    });
                }
            });
            let info = member_info("SYNTHETIC", 42).unwrap();
            let memos = info["memos"].as_array().unwrap();
            assert_eq!(memos.len(), 40);
            for thread in 0..8 {
                for i in 0..5 {
                    assert!(memos.iter().any(|memo| memo["text"] == format!("synthetic {thread}-{i}")));
                }
            }
            assert!(info["visits_left"].is_null());
        });
    }

    #[test]
    fn privacy_cleanup_and_removal_erase_memos_from_backup() {
        crate::member_privacy::tests::in_sandbox(|| {
            synthetic_member("SYNTHETIC", "period");
            append_memo("SYNTHETIC", "staff", "synthetic private memo", 42).unwrap();
            assert_eq!(redact_expired_members(days_from_ymd(20260828) * 86400, 6).unwrap(), 1);
            assert_eq!(load()[0]["memos"], json!([]));
            let info = member_info("SYNTHETIC", 42).unwrap();
            assert_eq!(info["name"], "");
            assert_eq!(info["memos"], json!([]));
            assert_eq!(info["redacted"], true);
            assert!(info.get("phone").is_none());
            assert!(append_memo("SYNTHETIC", "staff", "synthetic", 43).unwrap_err().starts_with("MEMBER_REDACTED:"));
            for path in [store_path(), dir().join("passes.json.bak")] {
                let raw = std::fs::read_to_string(path).unwrap();
                assert!(!raw.contains("synthetic private memo"));
                assert!(!raw.contains("Synthetic Member"));
            }
            synthetic_member("DELETE", "period");
            append_memo("DELETE", "owner", "synthetic deleted memo", 42).unwrap();
            remove_member("DELETE".into()).unwrap();
            assert!(member_info("DELETE", 42).unwrap_err().starts_with("NOT_MEMBER:"));
            for path in [store_path(), dir().join("passes.json.bak")] {
                let raw = std::fs::read_to_string(path).unwrap();
                assert!(!raw.contains("synthetic deleted memo"));
                assert!(!raw.contains("Synthetic Member"));
                assert!(!raw.contains("DELETE"));
            }
        });
    }

    /// 🔴 `YYYYMMDD` 끼리 빼면 날짜가 안 나온다. 한 달권이 「99일 남음」이 되고,
    /// 「7일 안에 만료」 안내가 **영영 안 뜬다** — 70 도 99 도 7 보다 크다.
    /// 내일 끝나는 회원에게 아무 말도 못 하고 있었다는 뜻이고, 갱신은
    /// 그 한마디에서 일어난다.
    #[test]
    fn retention_uses_latest_activity_and_inclusive_deadline() {
        crate::member_privacy::tests::in_sandbox(|| {
            let old = days_from_ymd(20260228) * 86400;
            let recent = days_from_ymd(20260801) * 86400;
            let mut rows = Vec::new();
            for kind in ["punch", "period"] {
                for (label, visit, updated, issued, due) in [
                    ("old", old, old, old, true),
                    ("recent-visit", recent, old, old, false),
                    ("recent-update", old, recent, old, false),
                    ("recent-issue", old, old, recent, false),
                    ("missing", 0, 0, 0, false),
                ] {
                    rows.push(json!({"asset":format!("{kind}-{label}"), "kind":kind, "expires":0,
                        "name":"Synthetic Member", "visits":[visit], "updated":updated, "issued":issued, "due":due}));
                }
            }
            rows.push(json!({"asset":"all-missing", "kind":"punch", "name":"Synthetic Member"}));
            save(&rows).unwrap();
            assert_eq!(redact_expired_members(days_from_ymd(20260827) * 86400, 6).unwrap(), 0);
            assert_eq!(load(), rows);
            assert_eq!(redact_expired_members(days_from_ymd(20260828) * 86400, 6).unwrap(), 2);
            for row in load() {
                assert_eq!(row["redacted"] == true, row["due"] == true);
            }
        });
    }

    #[test]
    fn retention_redacts_only_due_period_members_and_keeps_history() {
        crate::member_privacy::tests::in_sandbox(|| {
            let now = days_from_ymd(20260828) * 86400;
            let mut rows = Vec::new();
            for (asset, kind, expires) in [
                ("old", "period", 20260131), ("boundary", "period", 20260228),
                ("future", "period", 20260301), ("punch", "punch", 20200101),
                ("no-expiry", "period", 0),
            ] {
                rows.push(json!({"asset":asset, "name":"Kim", "phone":"1234", "note":"private memo",
                    "kind":kind, "expires":expires, "visits_total":10, "visits_used":2,
                    "frozen_at":0, "issued":42, "updated":43, "visits":[44,45],
                    "extra":{"emergency":"contact", "birth_year":1990, "custom_name":"Kim",
                             "consent_at":42, "consent_version":"v1"}}));
            }
            save(&rows).unwrap();
            std::fs::write(crate::paths::app_file("tickets.json"),
                serde_json::to_vec(&json!({"tickets":[{"code":"old","name":"Kim","promoted":true}]})).unwrap()).unwrap();
            assert_eq!(redact_expired_members(now, 6).unwrap(), 4);
            let after = load();
            for (before, row) in rows.iter().zip(after.iter()) {
                if before["asset"] != "future" {
                    for key in ["name", "phone", "note"] { assert_eq!(row[key], ""); }
                    assert_eq!(row["extra"], json!({"consent_at":42,"consent_version":"v1"}));
                    assert_eq!(row["redacted"], true);
                    assert_eq!(row["redacted_at"], now);
                    for key in ["asset","kind","expires","visits_total","visits_used","frozen_at","issued","updated","visits"] {
                        assert_eq!(row[key], before[key], "{key}");
                    }
                } else { assert_eq!(row, before); }
            }
            assert_eq!(redact_expired_members(now + 3600, 6).unwrap(), 0);
            assert_eq!(load(), after);
            let backup: Value = serde_json::from_slice(&std::fs::read(dir().join("passes.json.bak")).unwrap()).unwrap();
            assert_eq!(backup["passes"], json!(after));
            let tickets: Value = serde_json::from_slice(&std::fs::read(crate::paths::app_file("tickets.json")).unwrap()).unwrap();
            assert!(tickets["tickets"][0].get("name").is_none());
            assert_eq!(add_months(20260831, 6), 20270228);
        });
    }

    #[test]
    fn days_left_counts_real_days_not_digits() {
        let row = json!({ "kind": "period", "expires": 20_260_922 });
        assert_eq!(decorate(&row, 20_260_823)["days_left"], json!(30));
    }

    /// 내일 끝나는 회원. 1 이어야 화면이 갱신을 권한다.
    #[test]
    fn a_pass_ending_tomorrow_says_one_day() {
        let row = json!({ "kind": "period", "expires": 20_260_901 });
        let d = decorate(&row, 20_260_831);
        assert_eq!(d["days_left"], json!(1));
        assert!(d["valid"].as_bool().unwrap(), "하루 남았는데 막혔다");
    }

    /// 마지막 날에도 들어올 수 있어야 한다.
    #[test]
    fn the_last_day_is_still_valid() {
        let row = json!({ "kind": "period", "expires": 20_260_922 });
        let d = decorate(&row, 20_260_922);
        assert_eq!(d["days_left"], json!(0));
        assert!(d["valid"].as_bool().unwrap(), "마지막 날에 막혔다");
    }

    /// 해를 넘기는 1년권. 9999 같은 값이 나오면 안 된다.
    #[test]
    fn a_year_pass_does_not_report_thousands_of_days() {
        let row = json!({ "kind": "period", "expires": 20_270_822 });
        assert_eq!(decorate(&row, 20_260_823)["days_left"], json!(364));
    }
}
