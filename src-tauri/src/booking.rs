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
