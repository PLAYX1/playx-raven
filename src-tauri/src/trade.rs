//! 업종 템플릿 — 같은 그릇에 다른 이름표.
//!
//! ## 왜 ERP 를 가져오지 않았나
//!
//! Odoo·ERPNext 는 **서버에 설치하는 다중 사용자 ERP** 다. 우리는 가게 컴퓨터
//! 한 대에서 도는 단일 바이너리이고, "우리 서버를 안 지나간다" 가 유일한
//! 방어선이다. 그 위에 서버 제품을 얹으면 그 방어선이 사라진다.
//!
//! ## 업종이 다른 것은 이름과 기본값뿐이다
//!
//! 카페의 「메뉴」, 미용실의 「시술」, 병원의 「진료 항목」은 **같은 데이터**다 —
//! 이름 · 값 · 걸리는 시간 · 남은 수량. 다른 것은 부르는 말과 처음에 채워
//! 넣는 목록뿐이다. 그래서 새 기능을 만들지 않고 **이름표를 씌운다.**
//!
//! ⚠️ 병원에 **진료 기록(EMR)은 만들지 않는다.** 의료법·개인정보보호법이
//! 걸리고 우리가 감당할 규제가 아니다. 접수와 수납까지만 한다.

use serde_json::{json, Value};

/// 업종 하나.
///
/// `sample` 은 **지우고 시작하라고 넣는 것**이다. 빈 화면은 무엇을 적어야
/// 할지 알려 주지 않고, 예시가 있으면 고쳐 쓰면 된다.
fn trades() -> Value {
    json!([
      {
        "id": "cafe", "name": "카페 · 커피",
        "item_word": "메뉴", "item_one": "메뉴 하나",
        "uses_table": true, "uses_stock": true, "uses_booking": false,
        "why": "테이블 QR 로 자리에서 주문받습니다.",
        "sample": [
          { "name": "아메리카노", "price": 4000 },
          { "name": "카페라떼", "price": 4500 },
          { "name": "오늘의 드립", "price": 6000 },
          { "name": "치즈케이크", "price": 6500, "stock": 8 }
        ]
      },
      {
        "id": "restaurant", "name": "식당 · 술집",
        "item_word": "메뉴", "item_one": "메뉴 하나",
        "uses_table": true, "uses_stock": true, "uses_booking": false,
        "why": "테이블마다 QR 을 붙이면 번호를 부르지 않아도 됩니다.",
        "sample": [
          { "name": "김치찌개", "price": 9000 },
          { "name": "제육볶음", "price": 11000 },
          { "name": "공기밥", "price": 1000 },
          { "name": "오늘의 반찬", "price": 3000, "stock": 20 }
        ]
      },
      {
        "id": "mart", "name": "마트 · 편의점",
        "item_word": "상품", "item_one": "상품 하나",
        // 마트는 자리에서 주문하지 않는다. 계산대에서 QR 을 보여 준다.
        "uses_table": false, "uses_stock": true, "uses_booking": false,
        "why": "남은 수량이 중요합니다. 다 팔리면 손님 화면에서 바로 「품절」이 됩니다.",
        "sample": [
          { "name": "생수 2L", "price": 1200, "stock": 40 },
          { "name": "우유 1L", "price": 2900, "stock": 12 },
          { "name": "라면 5입", "price": 4500, "stock": 25 }
        ]
      },
      {
        "id": "gym", "name": "체육관 · 필라테스",
        "item_word": "이용권", "item_one": "이용권 하나",
        "uses_table": false, "uses_stock": false, "uses_booking": true,
        // 회원권·출입은 이미 만들어져 있다. 새로 지을 것이 없다.
        "why": "회원권과 출입 확인이 이미 들어 있습니다. 「내 가게 → 회원」 에서 씁니다.",
        "sample": [
          { "name": "1개월 자유이용", "price": 120000 },
          { "name": "3개월 자유이용", "price": 330000 },
          { "name": "10회 수업", "price": 250000 }
        ]
      },
      {
        "id": "salon", "name": "미용실 · 네일 · 마사지",
        "item_word": "시술", "item_one": "시술 하나",
        "uses_table": false, "uses_stock": false, "uses_booking": true,
        "why": "시술마다 걸리는 시간이 다릅니다. 손님이 시간을 골라 예약합니다.",
        "sample": [
          { "name": "커트", "price": 20000, "minutes": 30 },
          { "name": "펌", "price": 90000, "minutes": 120 },
          { "name": "염색", "price": 80000, "minutes": 90 }
        ]
      },
      {
        "id": "clinic", "name": "병원 · 한의원",
        "item_word": "진료 항목", "item_one": "진료 항목 하나",
        "uses_table": false, "uses_stock": false, "uses_booking": true,
        // ⚠️ 접수·수납까지다. 진료 기록은 만들지 않는다.
        "why": "접수와 수납만 합니다. 진료 기록은 다루지 않습니다 — 의료법이 따로 있습니다.",
        "sample": [
          { "name": "초진", "price": 15000, "minutes": 20 },
          { "name": "재진", "price": 10000, "minutes": 10 }
        ]
      },
      {
        "id": "etc", "name": "그 밖에",
        "item_word": "품목", "item_one": "품목 하나",
        "uses_table": false, "uses_stock": true, "uses_booking": false,
        "why": "무엇을 파시든 품목과 값만 있으면 됩니다.",
        "sample": []
      }
    ])
}

#[tauri::command]
pub fn trade_list() -> Value {
    trades()
}

/// 고른 업종 하나. 모르는 것을 고르면 「그 밖에」로 떨어진다 —
/// 화면이 빈손으로 멈추는 것보다 낫다.
#[tauri::command]
pub fn trade_get(id: String) -> Value {
    let all = trades();
    let arr = all.as_array().cloned().unwrap_or_default();
    arr.iter()
        .find(|t| t["id"] == json!(id))
        .cloned()
        .unwrap_or_else(|| arr.last().cloned().unwrap_or(json!({})))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 이름표만 다르고 그릇은 같아야 한다. 업종마다 다른 데이터를 만들면
    /// 그때부터 업종 수만큼 코드가 늘어난다.
    #[test]
    fn every_trade_has_the_same_shape() {
        for t in trades().as_array().unwrap() {
            for k in ["id", "name", "item_word", "uses_table", "uses_stock", "uses_booking", "why", "sample"] {
                assert!(t.get(k).is_some(), "{} 에 {k} 가 없다", t["id"]);
            }
        }
    }

    /// 예시는 **지우고 시작하라고** 넣는 것이다. 빈 화면은 무엇을 적어야
    /// 할지 알려 주지 않는다. 「그 밖에」만 예외 — 무엇을 파는지 모른다.
    #[test]
    fn each_trade_shows_what_to_type() {
        for t in trades().as_array().unwrap() {
            if t["id"] == json!("etc") {
                continue;
            }
            let n = t["sample"].as_array().map(|a| a.len()).unwrap_or(0);
            assert!(n >= 2, "{} 에 예시가 {n}개뿐이다", t["id"]);
        }
    }

    /// ⚠️ 병원에 진료 기록을 만들면 의료법·개인정보보호법이 걸린다.
    /// 화면이 "접수와 수납만" 이라고 먼저 말해야 한다.
    #[test]
    fn the_clinic_says_it_does_not_keep_records() {
        let c = trade_get("clinic".into());
        let why = c["why"].as_str().unwrap_or("");
        assert!(why.contains("진료 기록은 다루지 않습니다"), "{why}");
    }

    /// 모르는 업종을 고르면 화면이 빈손으로 멈추면 안 된다.
    #[test]
    fn an_unknown_trade_falls_back_instead_of_breaking() {
        let t = trade_get("우주선정비".into());
        assert_eq!(t["id"], json!("etc"));
    }
}
