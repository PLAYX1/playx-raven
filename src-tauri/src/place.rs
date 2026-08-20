//! Where the shop is.
//!
//! ## Why there is no address parser
//!
//! A Korean address is `시 구 동 번지`. A German one needs a house number after
//! the street. A Brazilian one has a CEP and, often, a landmark. Splitting an
//! address into fields means picking one country's shape and breaking everyone
//! else's — so the address is **one free line, written by the owner in their own
//! language**, and nothing here tries to understand it.
//!
//! ## Why coordinates are separate and optional
//!
//! What a customer actually needs is distance and directions, and both come from
//! a latitude and longitude — not from text. Turning text into coordinates is
//! geocoding, which means either paying Google or running a Nominatim server,
//! and we said we would do neither.
//!
//! So the owner pastes coordinates from the map app they already have. Every
//! map app on every phone can copy them, in one of a handful of formats, and
//! parsing those formats is a small honest job. A shop that skips it still
//! appears in the list — just without a distance.

use serde_json::{json, Value};

/// Reads coordinates out of whatever the owner pasted.
///
/// Handles what map apps actually put on the clipboard:
///
/// - `37.5665, 126.9780` — Google Maps, Apple Maps
/// - `37.5665,126.9780` — no space
/// - `37.5665° N, 126.9780° E` — some share sheets
/// - a full Google Maps URL containing `@37.5665,126.9780,17z`
/// - `geo:37.5665,126.9780`
///
/// Refuses anything it is not sure about rather than guessing, because a shop
/// pinned to the wrong hemisphere sends every customer somewhere else.
#[tauri::command]
pub fn parse_coords(input: String) -> Value {
    let t = input.trim();
    if t.is_empty() {
        return json!({ "ok": false });
    }

    // Google Maps URL: …/@37.5665,126.9780,17z/…
    if let Some(at) = t.find("@") {
        let rest = &t[at + 1..];
        let nums: Vec<&str> = rest.split(',').take(2).collect();
        if nums.len() == 2 {
            if let (Ok(la), Ok(lo)) = (
                nums[0].trim().parse::<f64>(),
                nums[1].trim().parse::<f64>(),
            ) {
                return finish(la, lo);
            }
        }
    }

    // geo: URI
    let body = t.strip_prefix("geo:").unwrap_or(t);

    // Pull out numbers, keeping their sign, and note any N/S/E/W letters.
    let cleaned: String = body
        .chars()
        .map(|c| if c.is_ascii_digit() || c == '.' || c == '-' || c == '+' { c } else { ' ' })
        .collect();
    let nums: Vec<f64> = cleaned
        .split_whitespace()
        .filter_map(|s| s.parse::<f64>().ok())
        .collect();

    if nums.len() < 2 {
        return json!({ "ok": false, "why": "좌표를 찾지 못했습니다" });
    }

    let upper = body.to_uppercase();
    let mut la = nums[0];
    let mut lo = nums[1];
    // 방위 문자가 있으면 부호로 바꾼다. `37.5 N, 126.9 W` 를 그냥 양수로 두면
    // 가게가 지구 반대편에 꽂힌다.
    if upper.contains('S') && la > 0.0 {
        la = -la;
    }
    if upper.contains('W') && lo > 0.0 {
        lo = -lo;
    }

    finish(la, lo)
}

fn finish(lat: f64, lon: f64) -> Value {
    if !(-90.0..=90.0).contains(&lat) || !(-180.0..=180.0).contains(&lon) {
        return json!({ "ok": false, "why": "좌표 범위를 벗어났습니다" });
    }
    // 0,0 은 대서양 한가운데다. 붙여넣기 실패를 그럴듯한 위치로 저장하지 않는다.
    if lat.abs() < 0.0001 && lon.abs() < 0.0001 {
        return json!({ "ok": false, "why": "좌표가 비어 있습니다" });
    }

    json!({
        "ok": true,
        "lat": (lat * 1e6).round() / 1e6,
        "lon": (lon * 1e6).round() / 1e6,
        // 열어서 맞는지 눈으로 확인할 수 있게. 저장 전에 한 번 보는 것이
        // 잘못된 핀을 고치는 유일한 방법이다.
        "check_url": format!("https://www.openstreetmap.org/?mlat={lat}&mlon={lon}#map=17/{lat}/{lon}"),
    })
}

/// Straight-line distance in metres between two points.
///
/// Haversine — the great-circle distance. Not walking distance, and the UI says
/// "직선거리" rather than implying a route: a shop 200 m away across a river is
/// a twenty-minute walk, and a number that pretends otherwise is worse than no
/// number.
#[tauri::command]
pub fn distance_m(lat1: f64, lon1: f64, lat2: f64, lon2: f64) -> f64 {
    const R: f64 = 6_371_000.0;
    let (p1, p2) = (lat1.to_radians(), lat2.to_radians());
    let dp = (lat2 - lat1).to_radians();
    let dl = (lon2 - lon1).to_radians();
    let a = (dp / 2.0).sin().powi(2) + p1.cos() * p2.cos() * (dl / 2.0).sin().powi(2);
    2.0 * R * a.sqrt().asin()
}

/// Every map app worth offering, with the link that opens it.
///
/// `geo:` is the technically correct answer — the OS picks whatever the user
/// set as their default. It is also the answer that does nothing on a Korean
/// phone with no Google Maps installed, which is most of them. So the customer
/// picks once and the choice is remembered.
///
/// Each entry has an `app` scheme and a `web` fallback. The scheme opens the
/// installed app directly; the web link works in a browser when it is not
/// installed, which is what happens when a foreign visitor taps 카카오맵.
#[tauri::command]
pub fn directions_links(lat: f64, lon: f64, label: String) -> Value {
    let l = crate::tunnel::urlencode(&label);

    json!([
        {
            "id": "default", "name": "기본 지도 앱",
            "app": format!("geo:{lat},{lon}?q={lat},{lon}({l})"),
            "web": format!("https://www.openstreetmap.org/directions?to={lat},{lon}"),
            "note": "폰에 설정된 지도 앱이 열립니다"
        },
        {
            "id": "naver", "name": "네이버 지도",
            // appname 이 없으면 네이버 앱이 스킴을 거부한다.
            "app": format!("nmap://route/car?dlat={lat}&dlng={lon}&dname={l}&appname=se.erci.playx.raven"),
            "web": format!("https://map.naver.com/p/directions/-/{lon},{lat},{l}/-/car"),
            "note": ""
        },
        {
            "id": "kakao", "name": "카카오맵",
            "app": format!("kakaomap://route?ep={lat},{lon}&by=CAR"),
            "web": format!("https://map.kakao.com/link/to/{l},{lat},{lon}"),
            "note": ""
        },
        {
            "id": "tmap", "name": "티맵",
            // 티맵은 x 가 경도, y 가 위도다. 뒤집으면 엉뚱한 데로 안내한다.
            "app": format!("tmap://route?goalname={l}&goalx={lon}&goaly={lat}"),
            "web": format!("https://tmap.life/route?goalx={lon}&goaly={lat}&goalname={l}"),
            "note": ""
        },
        {
            "id": "google", "name": "구글 지도",
            "app": format!("comgooglemaps://?daddr={lat},{lon}&directionsmode=driving"),
            "web": format!("https://www.google.com/maps/dir/?api=1&destination={lat},{lon}"),
            "note": ""
        },
        {
            "id": "apple", "name": "애플 지도",
            "app": format!("maps://?daddr={lat},{lon}&q={l}"),
            "web": format!("https://maps.apple.com/?daddr={lat},{lon}&q={l}"),
            "note": ""
        }
    ])
}
