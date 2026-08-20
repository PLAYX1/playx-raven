//! 남은 수량.
//!
//! ## 왜 "주문할 때 빼기" 가 틀렸나
//!
//! 마지막 한 개를 두 손님이 동시에 담을 수 있다. 결제할 때 빼면 **둘 다
//! 결제에 성공**하고, 하나는 못 받는다 — 그리고 그 돈은 체인에 들어가 있어
//! 되돌릴 수 없다. 가게가 사과하고 환불을 보내야 한다.
//!
//! 그래서 **주문하는 순간 잡아 둔다(hold).** 결제가 확인되면 진짜로 빼고,
//! 결제하지 않고 떠나면 시간이 지나 풀린다. 카페에서 "결제 안 하고 자리를
//! 뜬 손님" 은 흔하고, 그 사이 물건이 묶여 있으면 안 된다.
//!
//! ## 무제한이 기본이다
//!
//! 아메리카노에 재고를 세는 가게는 없다. 수량을 **적은 품목만** 센다 —
//! 적지 않으면 무제한이고, 그게 대부분이다. 모든 품목에 숫자를 넣게 하면
//! 아무도 이 기능을 안 켠다.

use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::Mutex;

/// 결제하지 않은 주문이 물건을 붙잡고 있는 시간.
///
/// 짧으면 결제 중인 손님의 물건이 풀려 남에게 팔린다. 길면 마지막 하나가
/// 오래 묶인다. 결제는 보통 1분 안에 끝나고, 안 하는 사람은 바로 떠난다.
const HOLD_SECS: i64 = 8 * 60;

/// (주문 주소, 품목이름 → 개수, 언제 잡았나)
static HOLDS: Mutex<Option<Vec<(String, HashMap<String, i64>, i64)>>> = Mutex::new(None);

fn with<T>(f: impl FnOnce(&mut Vec<(String, HashMap<String, i64>, i64)>) -> T) -> T {
    let mut g = HOLDS.lock().unwrap_or_else(|e| e.into_inner());
    f(g.get_or_insert_with(Vec::new))
}

/// 지금 잡혀 있는 개수. 지난 것은 세지 않고 지운다.
fn held(now: i64) -> HashMap<String, i64> {
    with(|v| {
        v.retain(|(_, _, at)| now - *at < HOLD_SECS);
        let mut m: HashMap<String, i64> = HashMap::new();
        for (_, items, _) in v.iter() {
            for (k, n) in items {
                *m.entry(k.clone()).or_insert(0) += n;
            }
        }
        m
    })
}

/// 메뉴에 적힌 수량. 없으면 무제한(None).
fn declared(menu: &Value) -> HashMap<String, Option<i64>> {
    let mut m = HashMap::new();
    for it in menu.as_array().cloned().unwrap_or_default() {
        let name = it.get("name").and_then(Value::as_str).unwrap_or("").to_string();
        if name.is_empty() {
            continue;
        }
        // `stock` 이 없거나 null 이면 무제한. 0 은 품절이라 다르다.
        let s = it.get("stock").and_then(Value::as_i64);
        m.insert(name, s);
    }
    m
}

/// 손님 화면이 보여 줄 "지금 몇 개 남았나".
///
/// 무제한은 `null` 로 답한다 — 0 으로 답하면 화면이 품절로 그린다.
#[tauri::command]
pub fn stock_left(menu: Value, now_unix: i64) -> Value {
    let d = declared(&menu);
    let h = held(now_unix);
    let mut out = serde_json::Map::new();
    for (name, s) in d {
        match s {
            None => {
                out.insert(name, Value::Null);
            }
            Some(total) => {
                let left = (total - h.get(&name).copied().unwrap_or(0)).max(0);
                out.insert(name, json!(left));
            }
        }
    }
    Value::Object(out)
}

/// 주문이 들어올 때 잡는다. 모자라면 무엇이 모자란지 말한다.
pub fn hold(address: &str, menu: &Value, want: &Value, now: i64) -> Result<(), String> {
    let d = declared(menu);
    let h = held(now);
    let mut take: HashMap<String, i64> = HashMap::new();

    for it in want.as_array().cloned().unwrap_or_default() {
        let name = it.get("name").and_then(Value::as_str).unwrap_or("").to_string();
        let qty = it.get("qty").and_then(Value::as_i64).unwrap_or(0);
        if name.is_empty() || qty <= 0 {
            continue;
        }
        // 메뉴에 없는 이름은 여기서 막지 않는다 — 금액 대조가 따로 막는다.
        let Some(Some(total)) = d.get(&name) else {
            continue;
        };
        let left = total - h.get(&name).copied().unwrap_or(0);
        if qty > left {
            return Err(if left <= 0 {
                format!("「{name}」이 방금 다 나갔습니다. 다른 것을 골라 주세요.")
            } else {
                format!("「{name}」은 {left}개까지 됩니다.")
            });
        }
        *take.entry(name).or_insert(0) += qty;
    }

    if !take.is_empty() {
        with(|v| {
            // 같은 주소로 두 번 오면 앞의 것을 대체한다. 손님이 뒤로 갔다가
            // 다시 주문하면 두 번 잡혀 재고가 두 배로 준다.
            v.retain(|(a, _, _)| a != address);
            v.push((address.to_string(), take, now));
        });
    }
    Ok(())
}

/// 결제가 확인됐다. 메뉴에서 진짜로 뺀다.
///
/// 잡아 둔 것을 푸는 것과 다르다 — 여기서 `stock` 숫자 자체가 줄어든다.
pub fn commit(address: &str, menu: &mut Value) {
    let taken = with(|v| {
        let i = v.iter().position(|(a, _, _)| a == address)?;
        Some(v.remove(i).1)
    });
    let Some(taken) = taken else { return };
    let Some(arr) = menu.as_array_mut() else { return };
    for it in arr.iter_mut() {
        let Some(name) = it.get("name").and_then(Value::as_str).map(str::to_string) else {
            continue;
        };
        let Some(n) = taken.get(&name) else { continue };
        if let Some(s) = it.get("stock").and_then(Value::as_i64) {
            it["stock"] = json!((s - n).max(0));
        }
    }
}

/// 주문이 취소되거나 오래됐다. 잡은 것을 푼다.
pub fn release(address: &str) {
    with(|v| v.retain(|(a, _, _)| a != address));
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 🔴 `HOLDS` 는 프로세스 전역이다. 시험이 병렬로 돌면 한쪽이 잡아 둔 것을
    /// 다른 쪽이 세어 버린다 — `paths::TEST_ENV` 와 같은 함정이고, 실제로
    /// 「같은 손님이 두 번」 시험이 그렇게 빨갛게 났다.
    static LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
    fn alone() -> std::sync::MutexGuard<'static, ()> {
        let g = LOCK.lock().unwrap_or_else(|e| e.into_inner());
        // 앞 시험이 남긴 것을 지우고 시작한다.
        with(|v| v.clear());
        g
    }

    fn menu(pairs: &[(&str, Option<i64>)]) -> Value {
        json!(pairs
            .iter()
            .map(|(n, s)| match s {
                Some(x) => json!({ "name": n, "price": 1000, "stock": x }),
                None => json!({ "name": n, "price": 1000 }),
            })
            .collect::<Vec<_>>())
    }
    fn want(pairs: &[(&str, i64)]) -> Value {
        json!(pairs.iter().map(|(n, q)| json!({ "name": n, "qty": q })).collect::<Vec<_>>())
    }

    /// 수량을 안 적은 품목은 무제한이다. 대부분의 메뉴가 이것이다 —
    /// 아메리카노에 재고를 세는 가게는 없다.
    #[test]
    fn an_item_without_a_number_is_unlimited() {
        let _g = alone();
        release("a");
        let m = menu(&[("아메리카노", None)]);
        assert!(hold("a", &m, &want(&[("아메리카노", 9_999)]), 0).is_ok());
        assert_eq!(stock_left(m, 0)["아메리카노"], Value::Null);
        release("a");
    }

    /// 🔴 마지막 하나를 두 손님이 담으면, 결제할 때 빼는 방식은 **둘 다
    /// 성공시킨다.** 그러면 하나는 못 받고 그 돈은 이미 체인에 들어가 있다.
    #[test]
    fn the_last_one_cannot_be_taken_twice() {
        let _g = alone();
        release("a");
        release("b");
        let m = menu(&[("케이크", Some(1))]);
        assert!(hold("a", &m, &want(&[("케이크", 1)]), 100).is_ok());
        let second = hold("b", &m, &want(&[("케이크", 1)]), 100);
        assert!(second.is_err(), "두 번째 손님이 같은 것을 또 잡았다");
        assert!(second.unwrap_err().contains("다 나갔습니다"));
        release("a");
        release("b");
    }

    /// 결제하지 않고 떠난 손님이 물건을 영원히 붙잡고 있으면 안 된다.
    #[test]
    fn an_abandoned_order_lets_go() {
        let _g = alone();
        release("a");
        let m = menu(&[("케이크", Some(1))]);
        hold("a", &m, &want(&[("케이크", 1)]), 0).unwrap();
        // 8분이 지나면 풀린다.
        assert!(hold("b", &m, &want(&[("케이크", 1)]), 9 * 60).is_ok());
        release("a");
        release("b");
    }

    /// 손님이 뒤로 갔다가 다시 주문하면 두 번 잡혀 재고가 두 배로 준다.
    #[test]
    fn ordering_twice_from_one_phone_does_not_double_count() {
        let _g = alone();
        release("a");
        let m = menu(&[("케이크", Some(2))]);
        hold("a", &m, &want(&[("케이크", 1)]), 10).unwrap();
        hold("a", &m, &want(&[("케이크", 1)]), 20).unwrap();
        assert_eq!(stock_left(m, 20)["케이크"], json!(1), "같은 손님이 두 번 세어졌다");
        release("a");
    }

    /// 결제가 확인되면 숫자 자체가 준다. 잡아 둔 것을 푸는 것과 다르다.
    #[test]
    fn paying_actually_reduces_the_number() {
        let _g = alone();
        release("a");
        let mut m = menu(&[("케이크", Some(3))]);
        hold("a", &m, &want(&[("케이크", 2)]), 0).unwrap();
        commit("a", &mut m);
        assert_eq!(m[0]["stock"], json!(1));
        // 잡은 것도 같이 풀려야 한다 — 안 그러면 두 번 빠진다.
        assert_eq!(stock_left(m, 0)["케이크"], json!(1));
        release("a");
    }

    /// 0 은 품절이고 "적지 않음" 과 다르다. 이걸 섞으면 품절인 것이
    /// 무제한으로 팔린다.
    #[test]
    fn zero_is_sold_out_not_unlimited() {
        let _g = alone();
        release("a");
        let m = menu(&[("케이크", Some(0))]);
        assert_eq!(stock_left(m.clone(), 0)["케이크"], json!(0));
        assert!(hold("a", &m, &want(&[("케이크", 1)]), 0).is_err());
        release("a");
    }
}
