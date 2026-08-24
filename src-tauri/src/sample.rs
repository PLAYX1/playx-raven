//! A shop that already exists, so the screens can be walked through.
//!
//! ## Why a seeder and not "just try it"
//!
//! Empty screens all look the same: no members, no menu, no sessions, no
//! orders. A first walk-through cannot tell "this feature is broken" from
//! "there is nothing here yet", and every layout bug hides in an empty list.
//!
//! ## Rules this follows
//!
//! - **Never touches the chain and never touches the wallet.** Only local JSON.
//!   A sample must not cost 500 RVN or move an asset.
//! - **Everything is labelled 샘플.** A shop that forgets to clear this must be
//!   able to see it at a glance rather than discovering "김샘플" in a real
//!   member list next month.
//! - **Refuses to overwrite real work.** If a menu or a member list already
//!   exists, it stops and says so — losing a real member list to a demo button
//!   is exactly the accident this file could cause.
//! - **The photos are real.** They are IPFS hashes this node already pins, so
//!   the customer screen shows actual images and the gateway path gets tested
//!   rather than mocked.

use serde_json::{json, Value};
use std::path::PathBuf;

fn dir() -> PathBuf {
    crate::paths::app_dir()
}

fn write(name: &str, v: &Value) -> Result<(), String> {
    let _ = std::fs::create_dir_all(dir());
    let path = dir().join(name);
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, serde_json::to_vec_pretty(v).map_err(|e| e.to_string())?)
        .map_err(|e| format!("{name}: {e}"))?;
    std::fs::rename(&tmp, &path).map_err(|e| format!("{name}: {e}"))
}

fn count(name: &str, key: &str) -> usize {
    std::fs::read_to_string(dir().join(name))
        .ok()
        .and_then(|t| serde_json::from_str::<Value>(&t).ok())
        .and_then(|v| v.get(key).and_then(Value::as_array).map(|a| a.len()))
        .unwrap_or(0)
}

/// Is there anything here that a sample would destroy?
#[tauri::command]
pub fn sample_check() -> Value {
    let menu = crate::shop::shop_load()
        .get("menu")
        .and_then(Value::as_array)
        .map(|a| a.len())
        .unwrap_or(0);
    let members = count("passes.json", "passes");
    let sessions = count("sessions.json", "sessions");

    json!({
        "menu": menu,
        "members": members,
        "sessions": sessions,
        "has_real_work": menu > 0 || members > 0 || sessions > 0,
    })
}

/// Fills the local files with a shop that looks lived-in.
#[tauri::command]
pub fn sample_fill(now_unix: i64, force: bool) -> Result<Value, String> {
    let existing = sample_check();
    if existing["has_real_work"].as_bool().unwrap_or(false) && !force {
        return Err(format!(
            "이미 메뉴 {}개, 회원 {}명, 수업 {}개가 있습니다. 샘플을 넣으면 덮어씁니다.",
            existing["menu"], existing["members"], existing["sessions"]
        ));
    }

    // 🔴 **덮기 전에 한 부 만든다.** 여기까지 왔다는 것은 사장이 「그래도
    //    넣겠다」를 눌렀다는 뜻인데, 그때 날아가는 것은 **회원 명단과 수업
    //    신청자**다. 체인에는 회원 번호만 있고 이름도 기간도 여기에만 있다 —
    //    잘못 누르면 그 가게는 오늘 문 앞에서 그걸 알게 된다.
    //
    //    확인 한 번으로 되돌릴 수 없는 일을 하게 두지 않는다.
    if existing["has_real_work"].as_bool().unwrap_or(false) {
        for name in ["shop.json", "passes.json", "sessions.json", "tickets.json", "bookings.json"] {
            let from = crate::paths::app_file(name);
            if from.is_file() {
                let to = crate::paths::app_file(&format!("{name}.덮기전"));
                let _ = std::fs::copy(&from, &to);
            }
        }
    }

    // 이 노드가 실제로 핀하고 있는 사진들이다. 가짜 URL 을 넣으면 손님 화면의
    // 사진 경로가 시험되지 않는다.
    let (shop_pic, iced, latte, cake) = (
        "QmZYRLyTXskYN89TSrhELMm5CCHRi3RyXCjSyABz8tRbvK",
        "Qmd23gcQWAZTKZrstpnXTPyUo4VsbtVL5bcuXmks4JQuCC",
        "QmbibWRDaWKyJKQPKjAr7N83ckz3eAyU34vKdWss1eUQF6",
        "QmZ7vS5KRg9AT3ZkBMCo6TH8AV8gLauokonW3PbMuv1XHd",
    );

    crate::shop::shop_save(json!({
        "name": "샘플 로스터리",
        "name_en": "Sample Roastery",
        "description": "샘플입니다 — 실제 가게가 아닙니다",
        "location": "서울 어딘가 1층",
        "phone": "",
        "pickup": true,
        "delivery": false,
        "payment_address": "",
        "lat": 37.498095,
        "lon": 127.02761,
        "icon": shop_pic,
        "currency": "KRW",
        "menu": [
            { "name": "샘플 아메리카노", "price": 4500, "image": iced },
            { "name": "샘플 카페라떼",   "price": 5000, "image": latte },
            { "name": "샘플 치즈케이크", "price": 6500, "image": cake },
            // 가격이 없는 줄. 목록이 이걸 어떻게 그리는지 봐야 한다.
            { "name": "샘플 오늘의 원두", "price": null, "image": null },
        ],
    }))?;

    let day = |d: i64| (now_unix + d * 86_400) as f64;
    let ymd = |t: f64| {
        // sample 은 화면 확인용이라 날짜는 사람이 읽는 형식이면 된다.
        let secs = t as i64;
        let z = secs / 86_400 + 719_468;
        let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
        let doe = z - era * 146_097;
        let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
        let y = yoe + era * 400;
        let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
        let mp = (5 * doy + 2) / 153;
        let d = doy - (153 * mp + 2) / 5 + 1;
        let m = if mp < 10 { mp + 3 } else { mp - 9 };
        let y = if m <= 2 { y + 1 } else { y };
        y * 10_000 + m * 100 + d
    };

    write(
        "passes.json",
        &json!({ "passes": [
            // 정상 · 곧 만료 · 정지 · 횟수제 — 화면이 네 상태를 다 그려야 한다.
            { "asset": "GYM/M#SAMPLE1", "name": "김샘플", "phone": "", "kind": "period",
              "expires": ymd(day(40)), "visits_total": 0, "visits_used": 0, "visits": [],
              "frozen_at": 0, "note": "샘플", "issued": now_unix, "updated": now_unix },
            { "asset": "GYM/M#SAMPLE2", "name": "이곧만료", "phone": "", "kind": "period",
              "expires": ymd(day(3)), "visits_total": 0, "visits_used": 0, "visits": [],
              "frozen_at": 0, "note": "샘플", "issued": now_unix, "updated": now_unix },
            { "asset": "GYM/M#SAMPLE3", "name": "박정지", "phone": "", "kind": "period",
              "expires": ymd(day(60)), "visits_total": 0, "visits_used": 0, "visits": [],
              "frozen_at": now_unix, "note": "샘플", "issued": now_unix, "updated": now_unix },
            { "asset": "GYM/M#SAMPLE4", "name": "최횟수", "phone": "", "kind": "punch",
              "expires": 0, "visits_total": 10, "visits_used": 8, "visits": [],
              "frozen_at": 0, "note": "샘플", "issued": now_unix, "updated": now_unix },
        ] }),
    )?;

    write(
        "sessions.json",
        &json!({ "sessions": [
            // 자리가 남은 것과 마감된 것 둘 다. 대기자 승격은 마감된 쪽에서만 보인다.
            { "id": "s-sample-1", "title": "샘플 무료 뜨개질 교실", "starts": "2026-08-25T19:30",
              "minutes": 90, "seats": 10, "price": 0, "currency": "KRW",
              "place": "2층", "note": "샘플",
              "booked": [ { "name": "김샘플", "phone": "", "people": 1, "at": now_unix } ],
              "waiting": [], "updated": now_unix },
            { "id": "s-sample-2", "title": "샘플 원두 클래스", "starts": "2026-08-27T14:00",
              "minutes": 60, "seats": 2, "price": 20000, "currency": "KRW",
              "place": "1층", "note": "샘플",
              "booked": [ { "name": "이곧만료", "phone": "", "people": 2, "at": now_unix } ],
              "waiting": [ { "name": "박대기", "phone": "", "people": 1, "at": now_unix } ],
              "updated": now_unix },
        ] }),
    )?;

    Ok(json!({
        "filled": true,
        "menu": 4,
        "members": 4,
        "sessions": 2,
        "note": "체인과 지갑은 건드리지 않았습니다. 전부 이 컴퓨터의 파일뿐입니다.",
        "walk": [
            "내 가게 → 메뉴판: 가격 없는 줄이 어떻게 보이나",
            "내 가게 → 가게 정보: 좌표가 들어갔으니 지도에서 확인이 열리나",
            "출입·회원: 정상·곧만료·정지·횟수 네 가지가 다르게 보이나",
            "수업: 마감된 회차에서 취소하면 대기자가 올라오나",
            "손님 폰 QR: 사진 네 장이 실제로 뜨나",
        ],
    }))
}

/// Removes everything the sampler wrote, and only that.
#[tauri::command]
pub fn sample_clear() -> Result<Value, String> {
    let mut removed = Vec::new();

    // 샘플 표시가 붙은 것만 지운다. 그 사이에 진짜 회원을 넣었을 수 있다.
    for (file, key, marker) in [
        ("passes.json", "passes", "GYM/M#SAMPLE"),
        ("sessions.json", "sessions", "s-sample-"),
    ] {
        let Ok(text) = std::fs::read_to_string(dir().join(file)) else {
            continue;
        };
        let Ok(v) = serde_json::from_str::<Value>(&text) else {
            continue;
        };
        let rows: Vec<Value> = v
            .get(key)
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let before = rows.len();
        let kept: Vec<Value> = rows
            .into_iter()
            .filter(|r| {
                let id = r
                    .get("asset")
                    .or_else(|| r.get("id"))
                    .and_then(Value::as_str)
                    .unwrap_or("");
                !id.starts_with(marker)
            })
            .collect();
        let gone = before - kept.len();
        if gone > 0 {
            write(file, &json!({ key: kept }))?;
            removed.push(json!({ "what": file, "count": gone }));
        }
    }

    // 가게는 이름으로 확인한다. 이름을 바꿔 진짜로 쓰기 시작했다면 안 지운다.
    let shop = crate::shop::shop_load();
    if shop.get("name").and_then(Value::as_str) == Some("샘플 로스터리") {
        crate::shop::shop_save(json!({}))?;
        removed.push(json!({ "what": "shop.json", "count": 1 }));
    }

    Ok(json!({ "removed": removed }))
}

#[cfg(test)]
mod overwrite_tests {
    /// 🔴 「시험용 가게 만들기」는 확인 한 번이면 **회원 명단과 수업 신청자를
    /// 통째로 갈아엎는다**(병합이 아니라 덮어쓰기). 체인에는 회원 번호만 있고
    /// 이름도 기간도 이 파일에만 있어서, 잘못 누르면 되돌릴 데가 없다.
    #[test]
    fn 덮기_전에_한_부_남긴다() {
        let src = include_str!("sample.rs");
        assert!(src.contains("덮기전"), "덮기 전 사본을 안 만든다");
        // 사본은 **실제 데이터가 있을 때만** 만든다. 빈 컴퓨터에 쓰레기를
        // 남기면 다음 사람이 그게 뭔지 몰라 지우지도 못한다.
        let i = src.find("덮기전").unwrap();
        let before: String = src[..i].chars().rev().take(400).collect::<String>().chars().rev().collect();
        assert!(before.contains("has_real_work"), "빈 컴퓨터에도 사본을 만들고 있다");
    }
}

#[cfg(test)]
mod tests {
    use super::sample_check;

    #[test]
    fn check_reports_shape() {
        let v = sample_check();
        // 실제 파일 상태와 무관하게 세 열쇠가 늘 있어야 화면이 안 깨진다.
        for k in ["menu", "members", "sessions", "has_real_work"] {
            assert!(v.get(k).is_some(), "{k} 가 없습니다");
        }
    }
}
