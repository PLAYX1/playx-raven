//! 예약 — 손님이 **언제** 받을지 고른다.
//!
//! ## 재고와 다른 점
//!
//! 재고는 팔리면 사라진다. **자리는 지나가면 사라지고 취소하면 돌아온다.**
//! 그래서 같은 그릇에 담을 수 없다 — `stock.rs` 와 나란히 두는 이유다.
//!
//! ## 왜 이것이 있어야 하나
//!
//! 미용실에서 펌은 두 시간이다. 그 두 시간에 다른 손님을 또 받으면 한 사람은
//! 기다리다 간다. 카페도 "30분 뒤에 갈게요" 가 되면 줄을 안 선다.
//!
//! ## 저장하지 않는 것
//!
//! 손님 이름도 전화번호도 받지 않는다. **주문 주소가 곧 그 사람**이고, 연락은
//! 주문 화면이 한다. 이름과 번호를 받으면 그 순간 개인정보를 보관하는 일이
//! 되고, 그건 가게 컴퓨터 한 대가 감당할 일이 아니다.

use serde_json::{json, Value};

/// 하루에 열어 두는 자리의 간격(분). 15분보다 잘게 쪼개면 화면에 버튼이
/// 너무 많아지고, 30분보다 굵으면 커트 한 번에 자리 하나가 낭비된다.
const SLOT_MINUTES: i64 = 15;

/// 얼마나 앞까지 예약을 받나. 이보다 멀면 가게가 그날 뭘 할지 모른다.
const DAYS_AHEAD: i64 = 7;

/// 주문에서 이 주문이 몇 분 걸리는지.
///
/// 메뉴에 `minutes` 를 적은 품목만 시간을 쓴다. 안 적었으면 0 이고,
/// 그건 "바로 되는 것" 이라는 뜻이다 — 커피는 자리를 잡지 않는다.
pub fn minutes_for(menu: &Value, items: &Value) -> i64 {
    let mut m: std::collections::HashMap<String, i64> = std::collections::HashMap::new();
    for it in menu.as_array().cloned().unwrap_or_default() {
        if let Some(n) = it.get("name").and_then(Value::as_str) {
            m.insert(n.to_string(), it.get("minutes").and_then(Value::as_i64).unwrap_or(0));
        }
    }
    let mut total = 0;
    for it in items.as_array().cloned().unwrap_or_default() {
        let n = it.get("name").and_then(Value::as_str).unwrap_or("");
        let q = it.get("qty").and_then(Value::as_i64).unwrap_or(0).max(0);
        total += m.get(n).copied().unwrap_or(0) * q;
    }
    total
}

/// 고를 수 있는 시각들.
///
/// 영업시간 안에서, 지금보다 뒤로, 이미 잡힌 것과 겹치지 않게.
/// **가게 시계**를 쓴다 — 손님 폰 시간대를 쓰면 여행 온 손님에게만 엉뚱한
/// 시각이 뜬다.
#[tauri::command]
pub fn booking_slots(
    shop: Value,
    taken: Value,
    minutes: i64,
    now_unix: i64,
    tz_offset_min: i64,
) -> Value {
    let need = minutes.max(SLOT_MINUTES);
    let busy: Vec<(i64, i64)> = taken
        .as_array()
        .cloned()
        .unwrap_or_default()
        .iter()
        .filter_map(|b| {
            Some((
                b.get("at").and_then(Value::as_i64)?,
                b.get("minutes").and_then(Value::as_i64).unwrap_or(SLOT_MINUTES),
            ))
        })
        .collect();

    let mut days = Vec::new();
    for d in 0..DAYS_AHEAD {
        let day_start = now_unix + d * 86_400;
        let mut slots = Vec::new();
        // 15분마다 훑는다. 하루 96칸이라 세는 값이 싸다.
        for k in 0..(24 * 60 / SLOT_MINUTES) {
            let at = floor_day(day_start, tz_offset_min) + k * SLOT_MINUTES * 60;
            // 지금보다 앞은 못 고른다. 5분 여유를 둔다 — 지금 시각이 딱
            // 걸리면 누르는 사이에 지나간다.
            if at < now_unix + 300 {
                continue;
            }
            // 시작도 끝도 영업시간 안이어야 한다. 문 닫는 시각에 걸치는
            // 두 시간짜리 펌을 받아 두면 아무도 안 남아 있다.
            if !crate::shop::open_at(&shop, at, tz_offset_min)["open"]
                .as_bool()
                .unwrap_or(false)
                || !crate::shop::open_at(&shop, at + need * 60 - 60, tz_offset_min)["open"]
                    .as_bool()
                    .unwrap_or(false)
            {
                continue;
            }
            let clash = busy.iter().any(|(b_at, b_min)| {
                at < b_at + b_min * 60 && b_at < &(at + need * 60)
            });
            if clash {
                continue;
            }
            slots.push(at);
        }
        if !slots.is_empty() {
            days.push(json!({ "day": floor_day(day_start, tz_offset_min), "slots": slots }));
        }
    }
    json!({ "minutes": need, "days": days })
}

/// 그 시각이 속한 날의 0시(가게 시계 기준).
fn floor_day(t: i64, tz_offset_min: i64) -> i64 {
    let shifted = t + tz_offset_min * 60;
    shifted - shifted.rem_euclid(86_400) - tz_offset_min * 60
}

#[cfg(test)]
mod tests {
    use super::*;

    fn shop_open_all_day() -> Value {
        json!({ "hours": {} })
    }

    /// `minutes` 를 안 적은 품목은 시간을 안 쓴다. 커피는 자리를 잡지 않는다.
    #[test]
    fn an_item_without_minutes_takes_no_time() {
        let menu = json!([{ "name": "아메리카노", "price": 4000 }]);
        let items = json!([{ "name": "아메리카노", "qty": 3 }]);
        assert_eq!(minutes_for(&menu, &items), 0);
    }

    /// 펌 두 개면 네 시간이다. 수량을 무시하면 두 번째 손님이 기다린다.
    #[test]
    fn quantity_multiplies_the_time() {
        let menu = json!([{ "name": "펌", "price": 90000, "minutes": 120 }]);
        let items = json!([{ "name": "펌", "qty": 2 }]);
        assert_eq!(minutes_for(&menu, &items), 240);
    }

    /// 🔴 이미 잡힌 시간과 겹치면 안 된다. 겹치게 두면 한 사람은 기다리다 간다.
    #[test]
    fn a_taken_slot_is_not_offered_again() {
        let now = 1_800_000_000;
        let taken = json!([{ "at": now + 3600, "minutes": 60 }]);
        let v = booking_slots(shop_open_all_day(), taken, 60, now, 540);
        let all: Vec<i64> = v["days"]
            .as_array()
            .unwrap()
            .iter()
            .flat_map(|d| d["slots"].as_array().unwrap().iter().map(|x| x.as_i64().unwrap()))
            .collect();
        for s in &all {
            assert!(
                !(*s < now + 3600 + 3600 && now + 3600 < *s + 3600),
                "잡힌 시간과 겹치는 자리를 내줬다: {s}",
            );
        }
    }

    /// 지나간 시각을 고르게 두면 안 된다.
    #[test]
    fn the_past_is_never_offered() {
        let now = 1_800_000_000;
        let v = booking_slots(shop_open_all_day(), json!([]), 30, now, 540);
        for d in v["days"].as_array().unwrap() {
            for s in d["slots"].as_array().unwrap() {
                assert!(s.as_i64().unwrap() >= now, "지나간 시각을 내줬다");
            }
        }
    }

    /// 걸리는 시간이 0 이어도 자리는 한 칸을 쓴다 — 0분짜리 예약은 없다.
    #[test]
    fn a_zero_minute_job_still_takes_one_slot() {
        let v = booking_slots(shop_open_all_day(), json!([]), 0, 1_800_000_000, 540);
        assert_eq!(v["minutes"], json!(SLOT_MINUTES));
    }
}

// ── 잡힌 예약을 어디에 두나 ─────────────────────────────────────────────
//
// `booking_slots` 는 규칙이고, 여기는 **장부**다. 규칙만 있고 장부가 없어서
// 이 파일은 여태 부르는 곳이 한 곳도 없었다 — `taken` 을 채워 줄 데가
// 없었기 때문이다. 그 상태로 화면만 붙이면 **겹치는 예약을 받는 화면**이
// 되고, 그건 안 만드느니만 못하다.
//
// ## 언제 자리를 잡는가
//
// 🔴 **결제할 때가 아니라 고를 때** 잡는다. 재고에서 배운 것과 같다 —
// 마지막 3시 자리를 두 손님이 동시에 고를 수 있고, 결제할 때 잡으면 둘 다
// 성공한다. 그리고 그 돈은 체인에 들어와 있어서 되돌릴 수 없다.
//
// 안 낸 사람의 자리는 견적이 만료되면 저절로 풀린다. 카페에서 "고르고 안
// 내고 떠나는 손님" 은 흔하고, 그 사이 자리가 묶여 있으면 안 된다.

use std::sync::Mutex;

/// 🔴 읽고-고치고-쓰는 동안 잡는 자물쇠. 없으면 두 손님이 같은 순간에
/// 예약할 때 나중에 쓴 쪽이 먼저 쓴 쪽을 통째로 덮는다 — 한 사람의 예약이
/// 조용히 사라지고, 그 사람은 예약한 줄 알고 가게에 온다.
static LOCK: Mutex<()> = Mutex::new(());

fn file() -> std::path::PathBuf {
    crate::paths::app_file("bookings.json")
}

fn load() -> Vec<Value> {
    std::fs::read_to_string(file())
        .ok()
        .and_then(|t| serde_json::from_str::<Value>(&t).ok())
        .and_then(|v| v.get("bookings").and_then(Value::as_array).cloned())
        .unwrap_or_default()
}

fn store(rows: &[Value]) -> Result<(), String> {
    let p = file();
    if let Some(dir) = p.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    std::fs::write(
        &p,
        serde_json::to_vec_pretty(&json!({ "bookings": rows })).unwrap_or_default(),
    )
    .map_err(|e| format!("예약을 저장하지 못했습니다: {e}"))
}

fn with_rows<T>(f: impl FnOnce(&mut Vec<Value>) -> T) -> T {
    let _g = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut rows = load();
    let out = f(&mut rows);
    let _ = store(&rows);
    out
}

fn read_rows() -> Vec<Value> {
    let _g = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    load()
}

/// 이 예약이 지금 자리를 차지하고 있나.
///
/// 낸 것은 끝날 때까지 차지한다. 안 낸 것은 **견적이 살아 있는 동안만** —
/// 그래야 결제 안 하고 떠난 손님 때문에 자리가 하루 종일 묶이지 않는다.
fn holds_a_slot(b: &Value, now: i64) -> bool {
    match b.get("state").and_then(Value::as_str).unwrap_or("") {
        "paid" => true,
        "hold" => b.get("until").and_then(Value::as_i64).unwrap_or(0) > now,
        _ => false, // 취소됐거나 지난 것
    }
}

/// `booking_slots` 에 넘길 「이미 잡힌 것」.
pub fn taken(now: i64) -> Value {
    let rows = read_rows();
    let list: Vec<Value> = rows
        .iter()
        .filter(|b| holds_a_slot(b, now))
        .map(|b| json!({ "at": b.get("at"), "minutes": b.get("minutes") }))
        .collect();
    json!(list)
}

/// 자리를 잡는다. **이미 찬 자리면 거절한다.**
///
/// 🔴 손님이 시각을 고르고 결제 화면으로 넘어오는 사이에 남이 그 자리를
/// 가져갈 수 있다. 화면이 보여 줄 때 비어 있었다는 것은 아무 보장이 아니다 —
/// 잡는 이 순간에 다시 본다. 이 검사가 없으면 3시에 두 사람이 온다.
pub fn hold(addr: &str, at: i64, minutes: i64, now: i64, quote_until: i64) -> Result<(), String> {
    if minutes <= 0 {
        return Err("예약 시간이 올바르지 않습니다.".into());
    }
    if at < now {
        return Err("지난 시각은 예약할 수 없습니다.".into());
    }
    with_rows(|rows| {
        let clash = rows.iter().any(|b| {
            if !holds_a_slot(b, now) {
                return false;
            }
            let b_at = b.get("at").and_then(Value::as_i64).unwrap_or(0);
            let b_min = b.get("minutes").and_then(Value::as_i64).unwrap_or(SLOT_MINUTES);
            at < b_at + b_min * 60 && b_at < at + minutes * 60
        });
        if clash {
            return Err("방금 다른 분이 그 시간을 잡았습니다. 다른 시간을 골라 주세요.".into());
        }
        rows.push(json!({
            "addr": addr,
            "at": at,
            "minutes": minutes,
            "state": "hold",
            "made": now,
            "until": quote_until,
        }));
        // 끝난 지 90일 지난 것은 지운다. 매출 기록은 장부에 따로 있다.
        rows.retain(|b| b.get("at").and_then(Value::as_i64).unwrap_or(0) > now - 90 * 86_400);
        Ok(())
    })
}

/// 돈이 들어왔다. 이 자리는 이제 확정이다.
///
/// 예약이 없는 주문이면 아무 일도 안 한다 — 커피는 자리를 안 잡는다.
pub fn confirm(addr: &str) -> Option<Value> {
    with_rows(|rows| {
        let idx = rows
            .iter()
            .position(|b| b.get("addr").and_then(Value::as_str) == Some(addr))?;
        if let Some(m) = rows[idx].as_object_mut() {
            m.insert("state".into(), json!("paid"));
        }
        Some(rows[idx].clone())
    })
}

/// 이 주문의 예약. 손님 화면이 결제 뒤에 보여 준다.
pub fn for_order(addr: &str) -> Option<Value> {
    read_rows()
        .into_iter()
        .find(|b| b.get("addr").and_then(Value::as_str) == Some(addr))
}

/// 사장이 보는 일정. 오늘부터 앞으로.
///
/// 안 낸 것도 같이 준다 — 「지금 누가 고르는 중」이 안 보이면 사장이 그
/// 시간에 다른 일을 잡는다.
#[tauri::command]
pub fn booking_list(now_unix: i64) -> Value {
    let mut rows: Vec<Value> = read_rows()
        .into_iter()
        .filter(|b| {
            let at = b.get("at").and_then(Value::as_i64).unwrap_or(0);
            at > now_unix - 12 * 3600 && holds_a_slot(b, now_unix)
        })
        .collect();
    rows.sort_by_key(|b| b.get("at").and_then(Value::as_i64).unwrap_or(0));
    json!({ "bookings": rows, "count": rows.len() })
}

/// 사장이 예약을 취소한다. 자리가 풀린다.
#[tauri::command]
pub fn booking_cancel(addr: String) -> Result<(), String> {
    with_rows(|rows| {
        let Some(idx) = rows
            .iter()
            .position(|b| b.get("addr").and_then(Value::as_str) == Some(addr.as_str()))
        else {
            return Err("그런 예약이 없습니다.".into());
        };
        if let Some(m) = rows[idx].as_object_mut() {
            // 지우지 않고 표시만 한다. 돈이 오간 예약을 흔적 없이 지우면
            // 나중에 「예약한 적 없다」와 「취소당했다」를 구별할 수 없다.
            m.insert("state".into(), json!("cancelled"));
        }
        Ok(())
    })
}

#[cfg(test)]
mod store_tests {
    use super::*;

    const NOW: i64 = 1_800_000_000;

    /// 🔴 시험은 **대표님의 진짜 예약 파일에 쓰면 안 된다.**
    ///
    /// 처음엔 그러고 있었다. `cargo test` 한 번이 실제 가게의 `bookings.json`
    /// 에 시험용 줄을 남겼고, 그 찌꺼기가 다음 시험을 깨뜨렸다. 더 나쁜 것은
    /// **진짜 예약을 밀어낼 수도 있었다**는 점이다.
    ///
    /// `paths` 에 이미 이걸 막는 장치가 있었는데 안 쓰고 있었다. 파일을
    /// 건드리는 시험은 전부 이 문을 지난다 — 임시 폴더로 보내고, 자물쇠로
    /// 서로 밀어내지 않게 한다.
    fn in_sandbox<T>(f: impl FnOnce() -> T) -> T {
        let _g = crate::paths::TEST_ENV
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let dir = std::env::temp_dir().join("playx-raven-booking-test");
        let _ = std::fs::create_dir_all(&dir);
        std::env::set_var("PLAYX_RAVEN_HOME", &dir);
        // 앞선 시험이 남긴 것을 지운다. 남아 있으면 「자리가 찼다」가 되어
        // 멀쩡한 코드가 빨갛게 뜬다.
        let _ = std::fs::remove_file(dir.join("bookings.json"));
        let out = f();
        std::env::remove_var("PLAYX_RAVEN_HOME");
        out
    }

    fn slot(n: i64) -> i64 {
        NOW + n * 86_400
    }


    /// 🔴 같은 자리를 두 사람이 잡으면 3시에 두 명이 온다. 두 번째는 거절.
    #[test]
    fn the_same_slot_cannot_be_held_twice() {
        in_sandbox(|| {
            assert!(hold("Ra", slot(1), 60, NOW, NOW + 300).is_ok());
            let second = hold("Rb", slot(1), 60, NOW, NOW + 300);
            assert!(second.is_err(), "같은 시간이 두 번 잡혔다");
        });
    }

    /// 겹치기만 해도 안 된다. 한 시간짜리 뒤에 30분 뒤부터 시작하는 것.
    #[test]
    fn an_overlapping_slot_is_refused() {
        in_sandbox(|| {
            assert!(hold("Rc", slot(2), 60, NOW, NOW + 300).is_ok());
            assert!(hold("Rd", slot(2) + 1800, 60, NOW, NOW + 300).is_err());
        });
    }

    /// 안 낸 사람의 자리는 견적이 지나면 풀린다. 안 그러면 하루 종일 묶인다.
    #[test]
    fn an_unpaid_hold_expires_and_frees_the_slot() {
        in_sandbox(|| {
            assert!(hold("Re", slot(3), 60, NOW, NOW + 300).is_ok());
            // 견적이 지난 뒤
            assert!(hold("Rf", slot(3), 60, NOW + 400, NOW + 700).is_ok());
        });
    }

    /// 🔴 낸 사람의 자리는 **안 풀린다.** 풀리면 남이 그 위에 예약한다.
    #[test]
    fn a_paid_booking_keeps_its_slot_forever() {
        in_sandbox(|| {
            assert!(hold("Rg", slot(4), 60, NOW, NOW + 300).is_ok());
            assert!(confirm("Rg").is_some());
            assert!(hold("Rh", slot(4), 60, NOW + 99_999, NOW + 100_299).is_err());
        });
    }

    /// 지난 시각은 못 잡는다.
    #[test]
    fn the_past_cannot_be_booked() {
        in_sandbox(|| {
            assert!(hold("Rpast", NOW - 60, 60, NOW, NOW + 300).is_err());
        });
    }

    /// 취소하면 자리가 풀린다.
    #[test]
    fn cancelling_frees_the_slot() {
        in_sandbox(|| {
            assert!(hold("Ri", slot(5), 60, NOW, NOW + 300).is_ok());
            assert!(confirm("Ri").is_some());
            assert!(booking_cancel("Ri".into()).is_ok());
            assert!(hold("Rj", slot(5), 60, NOW, NOW + 300).is_ok());
        });
    }
}
