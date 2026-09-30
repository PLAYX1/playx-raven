//! 공동구매 · 대기 신청 · 가게 사정 환불 · 송장 조회 — 0.6.0 (설계서 RV7 §16·§17·§18·§22).
//!
//! ## 한 줄로
//!
//! 공동구매 상품은 **메뉴의 한 품목**이다. 품목에 `group` 칸(수령일·마감일·최소 수량)을
//! 붙이고, 최대 수량은 원래 있던 `stock` 을 쓴다. 그래서 「마지막 하나를 두 사람이
//! 같이 사는」 문제는 이미 있는 재고 잡기(`stock.rs`)가 그대로 막는다.
//!
//! ## 대표 결정(2026-09-30)을 코드로 옮긴 것
//!
//! - **결제한 사람이 먼저 확정된다.** 자리는 결제로만 잡힌다(§22).
//! - 결제 없이 줄만 서는 것은 **「대기 신청」**. 돈이 없으므로 마감 전 언제든 취소된다.
//! - **결제한 예약은 손님이 취소·환불을 신청할 수 없다**(§18). 그런 단추를 만들지 않는다.
//! - 환불은 **가게 사정**일 때만: 마감까지 최소 수량이 안 모이면 「환불 대기」에 뜨고,
//!   사장이 미리보기 → 확인으로 보낸다. 자동으로 돈을 보내지 않는다.
//! - 자리가 나면(재고를 늘렸거나 가게 사정 환불로 빠졌거나) **대기 순서대로** 결제 차례가
//!   간다. 정해진 시간(기본 24시간) 안에 결제하지 않으면 다음 사람에게 넘어간다.
//! - 송장번호는 **택배사 조회 링크로 끝낸다**(§17.3-20). 자동 배송 추적은 하지 않는다.
//!
//! ## 🔴 대기 신청의 연락처
//!
//! 알림 서버가 없어서(§23) 결제 차례가 온 것을 사장이 직접 알려야 한다. 그래서 대기
//! 신청에만 연락처를 받는다. **이 파일은 가게 컴퓨터 밖으로 나가지 않는다** — 손님 화면에는
//! 순번과 상태만 돌려준다(남의 연락처가 새지 않게).

use serde_json::{json, Value};
use std::sync::Mutex;

/// 결제 차례가 온 뒤 기다려 주는 시간(시간). 사장이 바꿀 수 있다.
pub const DEFAULT_WINDOW_H: i64 = 24;
/// 한 품목의 대기 신청 상한. 장난으로 수천 줄을 쌓지 못하게.
const MAX_WAIT_PER_ITEM: usize = 500;

static LOCK: Mutex<()> = Mutex::new(());

// ── 날짜 ──────────────────────────────────────────────────────────────

/// "2026-11-05" → 20261105. 모양이 틀리면 None.
pub fn parse_ymd(s: &str) -> Option<i64> {
    let s = s.trim();
    let b = s.as_bytes();
    if b.len() != 10 || b[4] != b'-' || b[7] != b'-' {
        return None;
    }
    let y: i64 = s[0..4].parse().ok()?;
    let m: i64 = s[5..7].parse().ok()?;
    let d: i64 = s[8..10].parse().ok()?;
    if !(2000..=2999).contains(&y) || !(1..=12).contains(&m) || !(1..=31).contains(&d) {
        return None;
    }
    Some(y * 10_000 + m * 100 + d)
}

/// 공동구매 품목의 약속.
#[derive(Debug, Clone, PartialEq)]
pub struct Spec {
    pub pickup: i64,
    pub deadline: i64,
    pub min: i64,
}

/// 메뉴 품목에서 공동구매 약속을 읽는다. 공동구매가 아니면 None.
///
/// 🔴 마감일이 수령일보다 늦으면 약속이 성립하지 않는다 — 그런 품목은 공동구매로 보지
/// 않고, 화면이 사장에게 고치라고 말한다(`spec_problem`).
pub fn spec_of(item: &Value) -> Option<Spec> {
    let g = item.get("group")?;
    let pickup = parse_ymd(g.get("pickup")?.as_str()?)?;
    let deadline = parse_ymd(g.get("deadline")?.as_str()?)?;
    let min = g.get("min").and_then(Value::as_i64).unwrap_or(1).max(1);
    if deadline > pickup {
        return None;
    }
    Some(Spec { pickup, deadline, min })
}

/// 사장이 적은 공동구매 칸에 무엇이 틀렸나. 맞으면 None.
pub fn spec_problem(item: &Value) -> Option<&'static str> {
    let g = item.get("group")?;
    let p = g.get("pickup").and_then(Value::as_str).and_then(parse_ymd);
    let d = g.get("deadline").and_then(Value::as_str).and_then(parse_ymd);
    match (p, d) {
        (None, _) => Some("수령일을 2026-11-05 모양으로 적어 주세요."),
        (_, None) => Some("마감일을 2026-10-25 모양으로 적어 주세요."),
        (Some(p), Some(d)) if d > p => Some("마감일이 수령일보다 늦어요."),
        _ => {
            if item.get("stock").and_then(Value::as_i64).is_none() {
                Some("공동구매는 최대 수량(남은 수량)을 적어야 해요.")
            } else {
                None
            }
        }
    }
}

fn name_of(item: &Value) -> &str {
    item.get("name").and_then(Value::as_str).unwrap_or("")
}

fn find<'a>(menu: &'a Value, name: &str) -> Option<&'a Value> {
    menu.as_array()?.iter().find(|x| name_of(x) == name)
}

/// 주문을 받아도 되나. 마감일이 지난 공동구매 품목이 섞여 있으면 거절한다.
///
/// 🔴 화면만 막으면 이미 열어 둔 탭에서 그대로 주문이 들어온다. 서버에서 막는다.
pub fn can_order(menu: &Value, items: &Value, today: i64) -> Result<(), String> {
    for it in items.as_array().cloned().unwrap_or_default() {
        let name = name_of(&it).to_string();
        if let Some(spec) = find(menu, &name).and_then(spec_of) {
            if today > spec.deadline {
                return Err(format!("「{name}」 공동구매는 마감됐어요."));
            }
        }
    }
    Ok(())
}

// ── 장부(groupbuy.json) ───────────────────────────────────────────────

fn file() -> std::path::PathBuf {
    crate::paths::app_file("groupbuy.json")
}

fn empty() -> Value {
    json!({ "paid": [], "wait": [], "ship": {}, "window_h": DEFAULT_WINDOW_H, "next_id": 1 })
}

fn load() -> Value {
    std::fs::read_to_string(file())
        .ok()
        .and_then(|t| serde_json::from_str::<Value>(&t).ok())
        .filter(Value::is_object)
        .unwrap_or_else(empty)
}

fn save(v: &Value) -> Result<(), String> {
    let p = file();
    if let Some(d) = p.parent() {
        std::fs::create_dir_all(d).map_err(|e| e.to_string())?;
    }
    let tmp = p.with_extension("json.tmp");
    std::fs::write(&tmp, serde_json::to_vec_pretty(v).unwrap_or_default()).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &p).map_err(|e| e.to_string())
}

fn with_db<T>(f: impl FnOnce(&mut Value) -> Result<T, String>) -> Result<T, String> {
    let _g = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut db = load();
    let out = f(&mut db)?;
    save(&db)?;
    Ok(out)
}

fn arr<'a>(db: &'a mut Value, key: &str) -> &'a mut Vec<Value> {
    if !db[key].is_array() {
        db[key] = json!([]);
    }
    db[key].as_array_mut().unwrap()
}

// ── 결제 확정 ─────────────────────────────────────────────────────────

/// 장부에 결제가 적힌 순간 부른다(`server.rs` 가 `ledger::settle` 결과로).
/// 공동구매 품목이 들어 있으면 확정자 명단에 적는다. 같은 주문은 두 번 안 적는다.
pub fn paid_rows(db: &mut Value, menu: &Value, row: &Value) {
    let order = row.get("address").and_then(Value::as_str).unwrap_or("").to_string();
    if order.is_empty() {
        return;
    }
    let at = row.get("at").and_then(Value::as_i64).unwrap_or(0);
    let rvn = row.get("rvn").and_then(Value::as_f64).unwrap_or(0.0);
    let items = row.get("items").and_then(Value::as_array).cloned().unwrap_or_default();
    let total_qty: i64 = items.iter().map(|i| i.get("qty").and_then(Value::as_i64).unwrap_or(1).max(0)).sum();
    for it in &items {
        let name = name_of(it).to_string();
        if find(menu, &name).and_then(spec_of).is_none() {
            continue;
        }
        let qty = it.get("qty").and_then(Value::as_i64).unwrap_or(1).max(0);
        let paid = arr(db, "paid");
        if paid.iter().any(|p| p["order"] == order.as_str() && p["item"] == name.as_str()) {
            continue;
        }
        // 한 주문에 여러 품목이 섞였으면 RVN 은 수량 비율로 나눠 적는다(환불 미리보기용 어림).
        let share = if total_qty > 0 { rvn * qty as f64 / total_qty as f64 } else { 0.0 };
        paid.push(json!({ "order": order, "item": name, "qty": qty, "rvn": (share * 1e8).round() / 1e8, "at": at, "refunded": false }));
    }
    // 이 결제가 대기 신청의 결제 차례였다면 그 줄을 「결제함」으로 닫는다.
    // 주문할 때 대기 번호·열쇠를 붙여 왔으면(`link_order`) 정확히 그 줄을 닫는다.
    let linked = row.get("wait_id").and_then(Value::as_i64).or_else(|| db["links"].get(order.as_str()).and_then(Value::as_i64));
    if let Some(wid) = linked {
        for w in arr(db, "wait").iter_mut() {
            if w["id"] == wid && w["state"] == "offered" {
                w["state"] = json!("paid");
                w["order"] = json!(order);
            }
        }
    }
}

/// 차례를 받은 손님의 주문 주소를 그 대기 줄에 묶어 둔다. 열쇠가 맞고 차례(offered)일 때만.
pub fn link_rows(db: &mut Value, order: &str, id: i64, key: &str) -> bool {
    let ok = db["wait"].as_array().map(|w| w.iter().any(|x| x["id"] == id && x["key"].as_str() == Some(key) && x["state"] == "offered")).unwrap_or(false);
    if ok {
        if !db["links"].is_object() {
            db["links"] = json!({});
        }
        db["links"][order] = json!(id);
    }
    ok
}

pub fn link_order(order: &str, id: i64, key: &str) {
    let _ = with_db(|db| Ok(link_rows(db, order, id, key)));
}

pub fn record_paid(menu: &Value, row: &Value) {
    let _ = with_db(|db| {
        paid_rows(db, menu, row);
        Ok(())
    });
}

// ── 대기 신청 ─────────────────────────────────────────────────────────

/// 대기 신청을 받는다. 결제가 없으니 자리를 잡지 않는다.
pub fn wait_add(db: &mut Value, menu: &Value, item: &str, qty: i64, name: &str, contact: &str, today: i64, now: i64) -> Result<Value, String> {
    let spec = find(menu, item).and_then(spec_of).ok_or("공동구매 품목이 아니에요.")?;
    if today > spec.deadline {
        return Err("마감된 공동구매예요.".into());
    }
    if !(1..=99).contains(&qty) {
        return Err("수량을 1~99 사이로 적어 주세요.".into());
    }
    let contact = contact.trim();
    if contact.chars().count() < 3 || contact.chars().count() > 60 || contact.chars().any(char::is_control) {
        return Err("결제 차례를 알려 드릴 연락처를 적어 주세요.".into());
    }
    let name: String = name.trim().chars().filter(|c| !c.is_control()).take(30).collect();
    let live = db["wait"].as_array().map(|w| w.iter().filter(|x| x["item"] == item && (x["state"] == "waiting" || x["state"] == "offered")).count()).unwrap_or(0);
    if live >= MAX_WAIT_PER_ITEM {
        return Err("대기 신청이 너무 많아요. 가게에 직접 물어봐 주세요.".into());
    }
    let id = db["next_id"].as_i64().unwrap_or(1).max(1);
    db["next_id"] = json!(id + 1);
    // 손님이 제 신청을 다시 보거나 취소할 때 쓰는 열쇠. 순번(id)만으로는 남의 것을 취소할 수 있다.
    let key = token();
    arr(db, "wait").push(json!({ "id": id, "key": key, "item": item, "qty": qty, "name": name, "contact": contact, "at": now, "state": "waiting" }));
    Ok(json!({ "id": id, "key": key }))
}

/// 대기 순번(1부터). 기다리는 중이 아니면 None.
pub fn position(db: &Value, id: i64) -> Option<usize> {
    let list = db["wait"].as_array()?;
    let me = list.iter().find(|w| w["id"] == id)?;
    if me["state"] != "waiting" && me["state"] != "offered" {
        return None;
    }
    let item = me["item"].clone();
    Some(list.iter().filter(|w| w["item"] == item && (w["state"] == "waiting" || w["state"] == "offered")).take_while(|w| w["id"] != id).count() + 1)
}

/// 손님이 제 대기를 취소한다. **열쇠가 맞아야 한다.** 결제한 예약은 이 길로 못 없앤다.
pub fn wait_cancel(db: &mut Value, id: i64, key: Option<&str>) -> Result<(), String> {
    let w = arr(db, "wait").iter_mut().find(|w| w["id"] == id).ok_or("그런 대기 신청이 없어요.")?;
    if let Some(k) = key {
        if w["key"].as_str() != Some(k) {
            return Err("그런 대기 신청이 없어요.".into());
        }
    }
    match w["state"].as_str() {
        Some("waiting") | Some("offered") => {
            w["state"] = json!("cancelled");
            Ok(())
        }
        Some("paid") => Err("결제한 예약은 취소할 수 없어요. 못 가시면 다른 분께 넘길 수 있어요.".into()),
        _ => Ok(()),
    }
}

/// 자리가 나면 대기 순서대로 결제 차례를 준다. 시간이 지난 차례는 다음 사람에게 넘어간다.
///
/// `left` 는 지금 살 수 있는 수(메뉴의 `stock`). 이미 차례를 받은 사람 몫만큼 빼고 준다 —
/// 그래야 자리 하나에 두 사람이 동시에 결제하러 오지 않는다.
pub fn tick(db: &mut Value, menu: &Value, today: i64, now: i64) -> Vec<Value> {
    let window = db["window_h"].as_i64().unwrap_or(DEFAULT_WINDOW_H).clamp(1, 24 * 14) * 3600;
    let mut newly = Vec::new();
    for w in arr(db, "wait").iter_mut() {
        if w["state"] == "offered" && w["until"].as_i64().unwrap_or(0) <= now {
            w["state"] = json!("expired");
        }
    }
    for item in menu.as_array().cloned().unwrap_or_default() {
        let Some(spec) = spec_of(&item) else { continue };
        if today > spec.deadline {
            continue;
        }
        let name = name_of(&item).to_string();
        let left = item.get("stock").and_then(Value::as_i64).unwrap_or(0).max(0);
        let list = arr(db, "wait");
        let offered: i64 = list.iter().filter(|w| w["item"] == name.as_str() && w["state"] == "offered").map(|w| w["qty"].as_i64().unwrap_or(1)).sum();
        let mut free = left - offered;
        for w in list.iter_mut() {
            if free <= 0 {
                break;
            }
            if w["item"] != name.as_str() || w["state"] != "waiting" {
                continue;
            }
            let q = w["qty"].as_i64().unwrap_or(1);
            if q > free {
                // 순서를 건너뛰지 않는다. 앞사람 몫이 안 되면 뒷사람도 기다린다.
                break;
            }
            w["state"] = json!("offered");
            w["until"] = json!(now + window);
            free -= q;
            newly.push(w.clone());
        }
    }
    newly
}

// ── 마감 뒤: 성사·미달·환불 대기 ───────────────────────────────────────

/// 품목 하나의 지금 모습. 사장 화면 한 칸.
pub fn item_view(db: &Value, item: &Value, today: i64) -> Option<Value> {
    let spec = spec_of(item)?;
    let name = name_of(item);
    let paid: Vec<&Value> = db["paid"].as_array().map(|p| p.iter().filter(|x| x["item"] == name).collect()).unwrap_or_default();
    let paid_qty: i64 = paid.iter().map(|p| p["qty"].as_i64().unwrap_or(0)).sum();
    let left = item.get("stock").and_then(Value::as_i64).unwrap_or(0).max(0);
    let closed = today > spec.deadline;
    let state = match (closed, paid_qty >= spec.min, left == 0) {
        (false, _, true) => "full",
        (false, _, false) => "open",
        (true, true, _) => "done",
        (true, false, _) => "short",
    };
    // 🔴 가게 사정 환불은 **미달일 때만** 목록에 오른다. 결제한 손님이 마음을 바꾼 것은
    //    여기 오지 않는다(§18) — 그 단추는 어디에도 없다.
    let refund_due: Vec<Value> = if state == "short" {
        paid.iter().filter(|p| p["refunded"] != true).map(|p| json!({ "order": p["order"], "qty": p["qty"], "rvn": p["rvn"] })).collect()
    } else {
        Vec::new()
    };
    let waiting: Vec<Value> = db["wait"].as_array().map(|w| {
        w.iter().filter(|x| x["item"] == name && (x["state"] == "waiting" || x["state"] == "offered"))
            .map(|x| json!({ "id": x["id"], "qty": x["qty"], "name": x["name"], "contact": x["contact"], "state": x["state"], "until": x["until"] }))
            .collect()
    }).unwrap_or_default();
    let orders: Vec<Value> = paid.iter().map(|p| {
        let o = p["order"].as_str().unwrap_or("");
        json!({ "order": o, "qty": p["qty"], "rvn": p["rvn"], "refunded": p["refunded"], "ship": db["ship"].get(o).cloned().unwrap_or(Value::Null) })
    }).collect();
    Some(json!({
        "item": name, "pickup": spec.pickup, "deadline": spec.deadline, "min": spec.min,
        "paid_qty": paid_qty, "left": left, "state": state,
        "waiting": waiting, "refund_due": refund_due, "orders": orders,
    }))
}

/// 환불을 **보낸 뒤** 사장 화면이 부른다. 보내기 전에 표시하지 않는다.
pub fn mark_refunded(db: &mut Value, order: &str, item: &str) -> bool {
    let mut hit = false;
    for p in arr(db, "paid").iter_mut() {
        if p["order"] == order && p["item"] == item {
            p["refunded"] = json!(true);
            hit = true;
        }
    }
    hit
}

// ── 송장 ──────────────────────────────────────────────────────────────

/// 택배사 조회 페이지 주소. 모르는 택배사는 None — 번호만 보여 준다.
///
/// ⚠️ 택배사가 조회 주소를 바꾸면 이 표도 고쳐야 한다(링크가 깨져도 번호는 보인다).
pub fn tracking_url(carrier: &str, number: &str) -> Option<String> {
    let n: String = number.chars().filter(|c| c.is_ascii_digit()).collect();
    if n.len() < 8 || n.len() > 20 {
        return None;
    }
    let base = match carrier.trim() {
        "CJ대한통운" => "https://trace.cjlogistics.com/next/tracking.html?wblNo=",
        "우체국" => "https://service.epost.go.kr/trace.RetrieveDomRigiTraceList.comm?sid1=",
        "롯데택배" => "https://www.lotteglogis.com/home/reservation/tracking/linkView?InvNo=",
        "한진택배" => "https://www.hanjin.com/kor/CMS/DeliveryMgr/WaybillResult.do?mCode=MN038&schLang=KR&wblnumText2=",
        "로젠택배" => "https://www.ilogen.com/web/personal/trace/",
        _ => return None,
    };
    Some(format!("{base}{n}"))
}

pub const CARRIERS: [&str; 5] = ["CJ대한통운", "우체국", "롯데택배", "한진택배", "로젠택배"];

pub fn ship_set(db: &mut Value, order: &str, carrier: &str, number: &str, now: i64) -> Result<Value, String> {
    if order.trim().is_empty() {
        return Err("주문이 없어요.".into());
    }
    let digits: String = number.chars().filter(|c| c.is_ascii_digit()).collect();
    if digits.len() < 8 || digits.len() > 20 {
        return Err("송장번호는 숫자 8~20자리예요.".into());
    }
    if !db["ship"].is_object() {
        db["ship"] = json!({});
    }
    let row = json!({ "carrier": carrier.trim(), "number": digits, "at": now, "url": tracking_url(carrier, &digits) });
    db["ship"][order.trim()] = row.clone();
    Ok(row)
}

/// 손님이 제 주문 주소로 묻는다. 주문 주소가 곧 열쇠다(`api_order_state` 와 같은 규칙).
pub fn ship_for(db: &Value, order: &str) -> Option<Value> {
    db["ship"].get(order).cloned()
}

fn token() -> String {
    let b: [u8; 16] = rand::random();
    b.iter().map(|x| format!("{x:02x}")).collect()
}

/// 공동구매 품목의 **진짜 남은 수** = 적어 둔 최대 수량 − 결제로 확정된 수.
///
/// 🔴 메뉴의 `stock` 은 화면이 가게를 다시 올릴 때마다(`publish_shop`) 원래 숫자로
///    돌아가고, 앱을 다시 켜도 돌아간다. 보통 품목이면 하루 장사라 괜찮지만, 한 달짜리
///    공동구매에서는 그대로 **초과 판매**가 된다. 그래서 공동구매 품목은 재고 차감을
///    `stock.rs` 가 하지 않고(거기서 건너뛴다), 여기 결제 장부로 센다.
pub fn adjusted_menu_with(db: &Value, menu: &Value) -> Value {
    let mut out = menu.clone();
    if let Some(list) = out.as_array_mut() {
        for it in list.iter_mut() {
            if spec_of(it).is_none() {
                continue;
            }
            let name = name_of(it).to_string();
            let paid: i64 = db["paid"].as_array().map(|p| p.iter().filter(|x| x["item"] == name.as_str() && x["refunded"] != true).map(|x| x["qty"].as_i64().unwrap_or(0)).sum()).unwrap_or(0);
            if let Some(max) = it.get("stock").and_then(Value::as_i64) {
                it["stock"] = json!((max - paid).max(0));
            }
        }
    }
    out
}

pub fn adjusted_menu(menu: &Value) -> Value {
    adjusted_menu_with(&load(), menu)
}

// ── 명령 ──────────────────────────────────────────────────────────────

fn menu_now() -> Value {
    crate::shop::shop_load().get("menu").cloned().unwrap_or(json!([]))
}

#[tauri::command]
pub fn gb_overview(today_ymd: i64, now_unix: i64) -> Result<Value, String> {
    let menu = menu_now();
    with_db(|db| {
        let live = adjusted_menu_with(db, &menu);
        let offered = tick(db, &live, today_ymd, now_unix);
        let items: Vec<Value> = live.as_array().cloned().unwrap_or_default().iter().filter_map(|i| item_view(db, i, today_ymd)).collect();
        let problems: Vec<Value> = menu.as_array().cloned().unwrap_or_default().iter()
            .filter_map(|i| spec_problem(i).map(|p| json!({ "item": name_of(i), "why": p }))).collect();
        let to_ship = db["paid"].as_array().map(|p| p.iter().filter(|x| x["refunded"] != true && db["ship"].get(x["order"].as_str().unwrap_or("")).is_none()).count()).unwrap_or(0);
        let refunds: usize = items.iter().map(|i| i["refund_due"].as_array().map(Vec::len).unwrap_or(0)).sum();
        Ok(json!({ "items": items, "problems": problems, "newly_offered": offered, "to_ship": to_ship, "refund_due": refunds, "window_h": db["window_h"], "carriers": CARRIERS }))
    })
}

#[tauri::command]
pub fn gb_window_set(hours: i64) -> Result<Value, String> {
    if !(1..=24 * 14).contains(&hours) {
        return Err("1시간에서 14일 사이로 정해 주세요.".into());
    }
    with_db(|db| { db["window_h"] = json!(hours); Ok(json!({ "window_h": hours })) })
}

#[tauri::command]
pub fn gb_wait_cancel(id: i64) -> Result<(), String> {
    with_db(|db| wait_cancel(db, id, None))
}

#[tauri::command]
pub fn gb_refund_mark(order: String, item: String) -> Result<bool, String> {
    with_db(|db| Ok(mark_refunded(db, &order, &item)))
}

#[tauri::command]
pub fn gb_ship_set(order: String, carrier: String, number: String, now_unix: i64) -> Result<Value, String> {
    with_db(|db| ship_set(db, &order, &carrier, &number, now_unix))
}

/// 손님 쪽(서버 경로)에서 쓰는 것들.
pub fn public_wait_add(menu: &Value, item: &str, qty: i64, name: &str, contact: &str, today: i64, now: i64) -> Result<Value, String> {
    with_db(|db| {
        let r = wait_add(db, menu, item, qty, name, contact, today, now)?;
        let live = adjusted_menu_with(db, menu);
        tick(db, &live, today, now);
        Ok(r)
    })
}

pub fn public_wait_state(id: i64, key: &str) -> Option<Value> {
    let db = load();
    let w = db["wait"].as_array()?.iter().find(|w| w["id"] == id && w["key"].as_str() == Some(key))?.clone();
    Some(json!({ "item": w["item"], "qty": w["qty"], "state": w["state"], "until": w["until"], "position": position(&db, id) }))
}

pub fn public_wait_cancel(id: i64, key: &str) -> Result<(), String> {
    with_db(|db| wait_cancel(db, id, Some(key)))
}

pub fn public_ship(order: &str) -> Option<Value> {
    ship_for(&load(), order)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn menu(stock: i64) -> Value {
        json!([
            { "name": "샤인머스캣", "price": 35000, "stock": stock, "group": { "pickup": "2026-11-05", "deadline": "2026-10-25", "min": 3 } },
            { "name": "아메리카노", "price": 4000 }
        ])
    }
    fn paid(db: &mut Value, m: &Value, order: &str, qty: i64) {
        paid_rows(db, m, &json!({ "address": order, "at": 1, "rvn": 10.0 * qty as f64, "items": [{ "name": "샤인머스캣", "qty": qty }] }));
    }

    #[test]
    fn 날짜는_모양이_맞아야_읽는다() {
        assert_eq!(parse_ymd("2026-11-05"), Some(20261105));
        for bad in ["2026-1-5", "26-11-05", "2026/11/05", "2026-13-01", "", "2026-11-05x"] {
            assert_eq!(parse_ymd(bad), None, "{bad}");
        }
    }

    #[test]
    fn 마감이_수령보다_늦으면_공동구매가_아니다() {
        let it = json!({ "name": "x", "stock": 5, "group": { "pickup": "2026-10-01", "deadline": "2026-10-05" } });
        assert!(spec_of(&it).is_none());
        assert_eq!(spec_problem(&it), Some("마감일이 수령일보다 늦어요."));
        let no_max = json!({ "name": "x", "group": { "pickup": "2026-11-05", "deadline": "2026-10-25" } });
        assert!(spec_problem(&no_max).unwrap().contains("최대 수량"));
        assert_eq!(spec_problem(&menu(5)[0]), None);
        assert_eq!(spec_problem(&menu(5)[1]), None, "공동구매가 아닌 품목은 문제 없음");
    }

    #[test]
    fn 마감_다음날부터_주문을_거절한다() {
        let m = menu(5);
        let items = json!([{ "name": "샤인머스캣", "qty": 1 }]);
        assert!(can_order(&m, &items, 20261025).is_ok(), "마감일 당일은 받는다");
        assert!(can_order(&m, &items, 20261026).is_err());
        assert!(can_order(&m, &json!([{ "name": "아메리카노", "qty": 1 }]), 20261226).is_ok(), "보통 품목은 상관없다");
    }

    #[test]
    fn 결제는_한_번만_적히고_보통_품목은_안_적힌다() {
        let m = menu(5);
        let mut db = empty();
        paid(&mut db, &m, "Ra", 2);
        paid(&mut db, &m, "Ra", 2);
        paid_rows(&mut db, &m, &json!({ "address": "Rb", "items": [{ "name": "아메리카노", "qty": 1 }] }));
        assert_eq!(db["paid"].as_array().unwrap().len(), 1);
        assert_eq!(db["paid"][0]["qty"], 2);
    }

    #[test]
    fn 미달이면_마감_뒤에만_환불_대기에_뜬다() {
        let m = menu(5);
        let mut db = empty();
        paid(&mut db, &m, "Ra", 1);
        let before = item_view(&db, &m[0], 20261025).unwrap();
        assert_eq!(before["state"], "open");
        assert!(before["refund_due"].as_array().unwrap().is_empty(), "마감 전에는 환불 목록이 없다");
        let after = item_view(&db, &m[0], 20261026).unwrap();
        assert_eq!(after["state"], "short");
        assert_eq!(after["refund_due"].as_array().unwrap().len(), 1);
        assert!(mark_refunded(&mut db, "Ra", "샤인머스캣"));
        assert!(item_view(&db, &m[0], 20261026).unwrap()["refund_due"].as_array().unwrap().is_empty(), "보낸 뒤에는 빠진다");
    }

    #[test]
    fn 성사되면_환불_목록이_없다() {
        let m = menu(0);
        let mut db = empty();
        paid(&mut db, &m, "Ra", 2);
        paid(&mut db, &m, "Rb", 1);
        assert_eq!(item_view(&db, &m[0], 20261020).unwrap()["state"], "full");
        let v = item_view(&db, &m[0], 20261026).unwrap();
        assert_eq!(v["state"], "done");
        assert!(v["refund_due"].as_array().unwrap().is_empty());
    }

    #[test]
    fn 대기는_연락처가_있어야_하고_마감_뒤엔_안_받는다() {
        let m = menu(0);
        let mut db = empty();
        assert!(wait_add(&mut db, &m, "샤인머스캣", 1, "", "", 20261020, 0).is_err());
        assert!(wait_add(&mut db, &m, "아메리카노", 1, "", "010-1111-2222", 20261020, 0).is_err());
        assert!(wait_add(&mut db, &m, "샤인머스캣", 0, "", "010-1111-2222", 20261020, 0).is_err());
        assert!(wait_add(&mut db, &m, "샤인머스캣", 1, "", "010-1111-2222", 20261026, 0).is_err());
        let a = wait_add(&mut db, &m, "샤인머스캣", 1, "가", "010-1111-2222", 20261020, 0).unwrap();
        let b = wait_add(&mut db, &m, "샤인머스캣", 1, "나", "010-3333-4444", 20261020, 0).unwrap();
        assert_eq!(position(&db, a["id"].as_i64().unwrap()), Some(1));
        assert_eq!(position(&db, b["id"].as_i64().unwrap()), Some(2));
        assert_ne!(a["key"], b["key"]);
    }

    #[test]
    fn 남의_열쇠로는_취소가_안_되고_결제한_것은_취소가_안_된다() {
        let m = menu(0);
        let mut db = empty();
        let a = wait_add(&mut db, &m, "샤인머스캣", 1, "", "010-1111-2222", 20261020, 0).unwrap();
        let id = a["id"].as_i64().unwrap();
        assert!(wait_cancel(&mut db, id, Some("wrong")).is_err());
        assert_eq!(db["wait"][0]["state"], "waiting");
        db["wait"][0]["state"] = json!("paid");
        assert!(wait_cancel(&mut db, id, a["key"].as_str()).unwrap_err().contains("넘길 수"));
        db["wait"][0]["state"] = json!("waiting");
        wait_cancel(&mut db, id, a["key"].as_str()).unwrap();
        assert_eq!(db["wait"][0]["state"], "cancelled");
        assert_eq!(position(&db, id), None);
    }

    #[test]
    fn 자리가_나면_순서대로_차례가_가고_시간이_지나면_다음_사람() {
        let mut db = empty();
        let full = menu(0);
        let a = wait_add(&mut db, &full, "샤인머스캣", 2, "", "010-1111-2222", 20261020, 0).unwrap()["id"].as_i64().unwrap();
        let b = wait_add(&mut db, &full, "샤인머스캣", 1, "", "010-3333-4444", 20261020, 0).unwrap()["id"].as_i64().unwrap();
        assert!(tick(&mut db, &full, 20261020, 10).is_empty(), "자리가 없으면 아무도 차례가 아니다");
        // 자리가 하나 났다: 앞사람(2개)이 안 되면 뒷사람도 기다린다 — 새치기 없음.
        assert!(tick(&mut db, &menu(1), 20261020, 20).is_empty());
        // 둘 났다: 앞사람 차례.
        let got = tick(&mut db, &menu(2), 20261020, 30);
        assert_eq!(got.len(), 1);
        assert_eq!(got[0]["id"], a);
        assert_eq!(got[0]["until"], 30 + 24 * 3600);
        // 같은 두 자리로 또 부르면 이미 차례 받은 몫이 있어 아무도 추가되지 않는다.
        assert!(tick(&mut db, &menu(2), 20261020, 40).is_empty());
        // 24시간 안에 결제하지 않았다 → 만료, 뒷사람 차례.
        let got = tick(&mut db, &menu(2), 20261021, 30 + 24 * 3600);
        assert_eq!(got.len(), 1);
        assert_eq!(got[0]["id"], b);
        assert_eq!(db["wait"].as_array().unwrap().iter().find(|w| w["id"] == a).unwrap()["state"], "expired");
    }

    #[test]
    fn 차례를_받고_결제하면_그_줄이_닫힌다() {
        let mut db = empty();
        let m0 = menu(0);
        let a = wait_add(&mut db, &m0, "샤인머스캣", 1, "", "010-1111-2222", 20261020, 0).unwrap()["id"].as_i64().unwrap();
        tick(&mut db, &menu(1), 20261020, 5);
        let key = db["wait"][0]["key"].as_str().unwrap().to_string();
        assert!(!link_rows(&mut db, "Rw", a, "wrong"), "열쇠가 틀리면 묶지 않는다");
        assert!(link_rows(&mut db, "Rw", a, &key));
        paid_rows(&mut db, &m0, &json!({ "address": "Rw", "items": [{ "name": "샤인머스캣", "qty": 1 }] }));
        assert_eq!(db["wait"][0]["state"], "paid");
        assert_eq!(db["paid"][0]["order"], "Rw");
    }

    #[test]
    fn 마감된_품목은_차례를_주지_않는다() {
        let mut db = empty();
        wait_add(&mut db, &menu(0), "샤인머스캣", 1, "", "010-1111-2222", 20261020, 0).unwrap();
        assert!(tick(&mut db, &menu(5), 20261026, 5).is_empty());
    }

    #[test]
    fn 송장은_숫자만_받고_아는_택배사는_조회_링크를_준다() {
        let mut db = empty();
        assert!(ship_set(&mut db, "Ra", "CJ대한통운", "12-34", 0).is_err());
        let r = ship_set(&mut db, "Ra", "CJ대한통운", "6012-3456-7890", 0).unwrap();
        assert_eq!(r["number"], "601234567890");
        assert!(r["url"].as_str().unwrap().ends_with("601234567890"));
        assert!(r["url"].as_str().unwrap().starts_with("https://"));
        let other = ship_set(&mut db, "Rb", "동네택배", "601234567890", 0).unwrap();
        assert!(other["url"].is_null(), "모르는 택배사는 링크 없이 번호만");
        assert_eq!(ship_for(&db, "Ra").unwrap()["carrier"], "CJ대한통운");
        for c in CARRIERS { assert!(tracking_url(c, "601234567890").unwrap().starts_with("https://")); }
    }

    #[test]
    fn 남은_수는_결제_장부로_세고_환불하면_돌아온다() {
        let m = menu(5);
        let mut db = empty();
        paid(&mut db, &m, "Ra", 2);
        assert_eq!(adjusted_menu_with(&db, &m)[0]["stock"], 3);
        assert!(adjusted_menu_with(&db, &m)[1].get("stock").is_none(), "보통 품목은 그대로");
        mark_refunded(&mut db, "Ra", "샤인머스캣");
        assert_eq!(adjusted_menu_with(&db, &m)[0]["stock"], 5);
    }

    #[test]
    fn 손님_화면에는_남의_연락처가_안_나간다() {
        let src = include_str!("groupbuy.rs");
        let body = src.split("pub fn public_wait_state").nth(1).unwrap().split("\n}\n").next().unwrap();
        assert!(!body.contains("contact"), "손님 쪽 응답에 연락처가 섞였다");
    }
}
