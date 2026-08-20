//! Classes, sessions, and anything sold by the seat.
//!
//! ## A seat is not an item
//!
//! A coffee shop sells ten coffees; a library runs a knitting class twice, ten
//! seats each. Those look alike in a spreadsheet and behave nothing alike:
//!
//! - Stock runs out. **Capacity fills** — and empties again when someone
//!   cancels, which stock never does.
//! - Stock is fungible. **A seat belongs to a session** — the 19th at 7:30, not
//!   "one of twenty".
//! - When stock returns you sell it to whoever asks next. When a seat returns,
//!   **the waiting list has a claim on it**, and selling past them is how a
//!   shop gets a complaint it deserves.
//!
//! So sessions are their own thing here, with a waiting list built in rather
//! than bolted on.
//!
//! ## Free classes are the common case
//!
//! The poster that prompted this was a free library class. A booking system
//! that assumes payment cannot express it, and the owner goes back to counting
//! comments under a notice. Price zero is a first-class case: the seat is still
//! reserved, still confirmed, still cancellable.

use serde_json::{json, Value};
use std::path::PathBuf;

fn store() -> PathBuf {
    crate::paths::app_file("sessions.json")
}

fn load() -> Vec<Value> {
    std::fs::read_to_string(store())
        .ok()
        .and_then(|r| serde_json::from_str::<Value>(&r).ok())
        .and_then(|v| v.get("sessions").and_then(Value::as_array).cloned())
        .unwrap_or_default()
}

fn save(rows: &[Value]) -> Result<(), String> {
    let path = store();
    if let Some(d) = path.parent() {
        let _ = std::fs::create_dir_all(d);
    }
    // 원자적으로. 이 파일을 잃으면 신청자 명단이 사라지고, 그건 사람들이
    // 시간을 비워 두고 나타나는 일이라 재고보다 무겁다.
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, serde_json::to_vec_pretty(&json!({ "sessions": rows })).map_err(|e| e.to_string())?)
        .map_err(|e| format!("저장하지 못했습니다: {e}"))?;
    std::fs::rename(&tmp, &path).map_err(|e| format!("저장하지 못했습니다: {e}"))
}

/// Creates or replaces a session.
///
/// `starts` is an ISO local datetime string, kept as the shop wrote it. Sessions
/// are local by nature — nobody attends a knitting class from another timezone —
/// and converting to UTC only creates a chance to be an hour wrong.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn session_save(
    id: String,
    title: String,
    starts: String,
    minutes: i64,
    seats: i64,
    price: f64,
    currency: String,
    place: String,
    note: String,
    now_unix: i64,
) -> Result<Value, String> {
    if title.trim().is_empty() {
        return Err("이름이 필요합니다.".into());
    }
    if seats < 1 {
        return Err("자리는 1개 이상이어야 합니다.".into());
    }

    let mut rows = load();
    let existing = rows
        .iter()
        .find(|r| r.get("id").and_then(Value::as_str) == Some(id.as_str()))
        .cloned();
    // 이미 신청한 사람은 건드리지 않는다. 정원을 고치다 명단이 날아가면
    // 그 사람들은 그날 문 앞에서 알게 된다.
    let booked = existing
        .as_ref()
        .and_then(|r| r.get("booked").cloned())
        .unwrap_or(json!([]));
    let waiting = existing
        .as_ref()
        .and_then(|r| r.get("waiting").cloned())
        .unwrap_or(json!([]));

    rows.retain(|r| r.get("id").and_then(Value::as_str) != Some(id.as_str()));
    let row = json!({
        "id": id,
        "title": title.trim(),
        "starts": starts,
        "minutes": minutes,
        "seats": seats,
        "price": price,
        "currency": currency,
        "place": place.trim(),
        "note": note.trim(),
        "booked": booked,
        "waiting": waiting,
        "updated": now_unix,
    });
    rows.push(row.clone());
    save(&rows)?;
    Ok(decorate(&row))
}

fn decorate(r: &Value) -> Value {
    let seats = r.get("seats").and_then(Value::as_i64).unwrap_or(0);
    let booked = r
        .get("booked")
        .and_then(Value::as_array)
        .map(|a| a.len() as i64)
        .unwrap_or(0);
    let waiting = r
        .get("waiting")
        .and_then(Value::as_array)
        .map(|a| a.len() as i64)
        .unwrap_or(0);

    let mut o = r.clone();
    if let Some(m) = o.as_object_mut() {
        m.insert("taken".into(), json!(booked));
        m.insert("left".into(), json!((seats - booked).max(0)));
        m.insert("waiting_count".into(), json!(waiting));
        // "품절"이 아니라 "마감"이다. 재고는 다시 안 생기고 자리는 생긴다.
        m.insert("full".into(), json!(booked >= seats));
        m.insert(
            "free".into(),
            json!(r.get("price").and_then(Value::as_f64).unwrap_or(0.0) <= 0.0),
        );
    }
    o
}

/// Every session, soonest first.
#[tauri::command]
pub fn session_list() -> Result<Value, String> {
    let mut rows = load();
    rows.sort_by(|a, b| {
        a.get("starts")
            .and_then(Value::as_str)
            .unwrap_or("")
            .cmp(b.get("starts").and_then(Value::as_str).unwrap_or(""))
    });
    Ok(json!({
        "sessions": rows.iter().map(decorate).collect::<Vec<_>>()
    }))
}

/// Books a seat, or joins the waiting list when it is full.
///
/// Returns which of the two happened rather than failing on a full session —
/// the person is standing there either way, and "마감입니다" with no next step
/// is where a paper sign-up sheet beats us.
#[tauri::command]
pub fn session_book(
    id: String,
    name: String,
    phone: String,
    people: i64,
    now_unix: i64,
) -> Result<Value, String> {
    if name.trim().is_empty() {
        return Err("이름이 필요합니다.".into());
    }
    let n = people.max(1);

    let mut rows = load();
    let Some(idx) = rows
        .iter()
        .position(|r| r.get("id").and_then(Value::as_str) == Some(id.as_str()))
    else {
        return Err("없는 회차입니다.".into());
    };

    let seats = rows[idx].get("seats").and_then(Value::as_i64).unwrap_or(0);
    let taken: i64 = rows[idx]
        .get("booked")
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .map(|b| b.get("people").and_then(Value::as_i64).unwrap_or(1))
                .sum()
        })
        .unwrap_or(0);

    let entry = json!({
        "name": name.trim(),
        "phone": phone.trim(),
        "people": n,
        "at": now_unix,
    });

    let waitlisted = taken + n > seats;
    if let Some(m) = rows[idx].as_object_mut() {
        let key = if waitlisted { "waiting" } else { "booked" };
        let mut list = m.get(key).and_then(Value::as_array).cloned().unwrap_or_default();
        list.push(entry);
        m.insert(key.into(), json!(list));
        m.insert("updated".into(), json!(now_unix));
    }

    save(&rows)?;
    Ok(json!({
        "waitlisted": waitlisted,
        "session": decorate(&rows[idx]),
        "message": if waitlisted {
            "자리가 찼습니다. 대기자로 올려 두었고, 자리가 나면 순서대로 연락드립니다."
        } else {
            "예약됐습니다."
        },
    }))
}

/// Cancels a booking and promotes the first person waiting.
///
/// The promotion is the point. A seat that opens and sits empty while somebody
/// waits is the failure this whole structure exists to avoid — and doing it by
/// hand means it happens when the owner remembers, which is not most days.
#[tauri::command]
pub fn session_cancel(id: String, name: String, now_unix: i64) -> Result<Value, String> {
    let mut rows = load();
    let Some(idx) = rows
        .iter()
        .position(|r| r.get("id").and_then(Value::as_str) == Some(id.as_str()))
    else {
        return Err("없는 회차입니다.".into());
    };

    let mut promoted: Option<Value> = None;
    if let Some(m) = rows[idx].as_object_mut() {
        let mut booked = m.get("booked").and_then(Value::as_array).cloned().unwrap_or_default();
        let before = booked.len();
        booked.retain(|b| b.get("name").and_then(Value::as_str) != Some(name.trim()));
        if booked.len() == before {
            return Err("그 이름으로 예약된 것이 없습니다.".into());
        }

        // 자리가 났으니 기다리던 사람이 먼저다. 새로 온 사람이 새치기하면
        // 그건 항의를 받아 마땅한 일이다.
        let mut waiting = m.get("waiting").and_then(Value::as_array).cloned().unwrap_or_default();
        if !waiting.is_empty() {
            let first = waiting.remove(0);
            promoted = Some(first.clone());
            booked.push(first);
        }

        m.insert("booked".into(), json!(booked));
        m.insert("waiting".into(), json!(waiting));
        m.insert("updated".into(), json!(now_unix));
    }

    save(&rows)?;
    Ok(json!({
        "session": decorate(&rows[idx]),
        "promoted": promoted,
        "message": match &promoted {
            Some(p) => format!(
                "취소했습니다. 대기 1번 {}님이 자동으로 들어갔습니다 — 연락해 주세요.",
                p.get("name").and_then(Value::as_str).unwrap_or("")
            ),
            None => "취소했습니다.".to_string(),
        },
    }))
}

/// Removes a session entirely.
#[tauri::command]
pub fn session_remove(id: String) -> Result<(), String> {
    let mut rows = load();
    rows.retain(|r| r.get("id").and_then(Value::as_str) != Some(id.as_str()));
    save(&rows)
}
