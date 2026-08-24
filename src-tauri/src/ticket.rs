//! 기간 이용권 — **카운터에서 사서 그 자리에서 받는 표.**
//!
//! ## 회원권(`pass.rs`)과 무엇이 다른가
//!
//! 회원권은 **사장이 등록**한다. 이름·전화번호를 받고 자산을 만들어 준다.
//! 한 달 이상 다니는 사람에게 맞는 방식이고, 그건 이미 돌아간다.
//!
//! 여기는 **손님이 사는** 쪽이다. 하루권·2일권처럼 그 자리에서 사서 그
//! 자리에서 쓰는 것. 이름을 묻지 않고, 등록 화면을 거치지 않는다.
//!
//! ## 🔴 자산으로 안 만드는 이유
//!
//! 자산으로 만들면 다른 지갑에서도 보이고 넘길 수도 있다. 좋아 보이지만
//! 카운터에서는 셋 다 걸린다:
//!
//!   1. **지갑을 열어야 한다.** 자산을 보내려면 잠금을 풀어야 하고, 그러려면
//!      가게 컴퓨터의 지갑 암호가 하루 종일 풀려 있어야 한다.
//!   2. **손님이 받을 주소를 적어야 한다.** 커피 사는 사람에게 지갑 주소를
//!      치라고 할 수 없다. 줄이 선다.
//!   3. **한 장마다 5 RVN 이 탄다.** 하루권 50장이면 250 RVN 이다.
//!
//! 그래서 기본은 **번호표**다. 소각 0, 지갑 안 열어도 되고, 결제 확인과 동시에
//! 손님 폰에 뜬다. 한 달 이상 다닐 사람은 회원권(`pass.rs`)으로 넘긴다 —
//! 그쪽은 자산이 맞다.
//!
//! ## 🔴 3개월은 90일이 아니다
//!
//! 2월이 낀 3개월과 여름 3개월은 날 수가 다르다. 회원은 「같은 날짜」를
//! 기대하고, 카운터에서 「90일이라 8월 21일까지입니다」를 설명할 수는 없다.
//! 그래서 **개월은 달력으로 센다** — `pass.rs` 의 `period_end` 가 이미 그
//! 계산을 하고 있고, 회원권과 이용권이 다른 날짜를 내놓으면 안 된다.
//!
//! 날짜로 들고 있는 것도 그 이유다. 유닉스 초로 들고 있으면 「어느 날
//! 자정인가」가 시간대에 따라 흔들린다. 가게는 한 곳에 있고 손님은 날짜로
//! 이야기한다.
//!
//! ## 표 번호는 추측할 수 없어야 한다
//!
//! 번호가 순서대로면 남의 표를 하나 보고 앞뒤를 찍어 들어올 수 있다.
//! 무작위 8글자를 쓴다. 헷갈리는 글자(0·O·1·I·L)는 뺀다 — 손님이 화면을
//! 못 읽고 불러 줘야 할 때가 반드시 온다.

use serde_json::{json, Value};

/// 표에 쓰는 글자. 헷갈리는 것은 뺐다.
const ALPHABET: &[u8] = b"23456789ABCDEFGHJKMNPQRSTUVWXYZ";

fn file() -> std::path::PathBuf {
    crate::paths::app_file("tickets.json")
}

/// 🔴 표 파일을 읽고 고쳐 쓰는 동안 잡는 자물쇠.
///
/// 이게 없으면 **기록이 조용히 사라진다.** 결제 확인(`sweep_payments`)과
/// 검표기(`ticket_use`)는 서로 다른 실타래에서 돌고, 둘 다 「파일 전체를
/// 읽어서 → 고치고 → 파일 전체를 다시 쓴다」. 두 개가 겹치면 나중에 쓴
/// 쪽이 먼저 쓴 쪽의 변경을 통째로 덮는다.
///
/// 가게에서 이게 언제 터지는가: 손님이 결제하는 순간 다른 손님이 문에서
/// QR 을 찍을 때. 드물어 보이지만 하루에 백 번 일어나는 두 일이고, 겹치면
/// 방금 판 표가 없어지거나 방금 들어온 기록이 없어진다. 둘 다 그 자리에서
/// 싸움이 된다.
///
/// 시험에서 먼저 잡혔다 — 시험 두 개가 동시에 돌면서 서로의 표를 지웠다.
static LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// 자물쇠를 잡은 채 읽고 → 고치고 → 쓴다. **읽고 쓰는 코드는 전부 이 문을
/// 지나야 한다.** 하나라도 빠져나가면 자물쇠가 있으나 마나다.
fn with_rows<T>(f: impl FnOnce(&mut Vec<Value>) -> T) -> T {
    let _g = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut rows = load();
    let out = f(&mut rows);
    let _ = save(&rows);
    out
}

fn load() -> Vec<Value> {
    std::fs::read_to_string(file())
        .ok()
        .and_then(|t| serde_json::from_str::<Value>(&t).ok())
        .and_then(|v| v.get("tickets").and_then(Value::as_array).cloned())
        .unwrap_or_default()
}

/// 읽기만 한다. 자물쇠는 잡되 파일은 안 건드린다.
fn read_rows() -> Vec<Value> {
    let _g = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    load()
}

fn save(rows: &[Value]) -> Result<(), String> {
    let p = file();
    if let Some(dir) = p.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    std::fs::write(
        &p,
        serde_json::to_vec_pretty(&json!({ "tickets": rows })).unwrap_or_default(),
    )
    .map_err(|e| format!("표를 저장하지 못했습니다: {e}"))
}

/// 이 이용권이 언제까지인가. **달력으로** 센다.
///
/// 산 날이 1일째다. 그래서 하루권은 그날 하루, 한달권은 다음 달 같은 날의
/// 전날까지다 — 8월 23일에 산 한 달권은 9월 22일까지.
///
/// 🔴 개월과 일수를 둘 다 받는다. 「3개월 + 7일」 같은 것을 파는 가게가
/// 실제로 있고(등록 사은품), 둘 중 하나만 받으면 그건 못 판다.
fn ends_on(start_ymd: i64, months: i64, days: i64) -> i64 {
    // 아무것도 안 적혔으면 하루짜리로 본다. 0 이면 산 순간 끝난 표가 된다.
    let d = if months <= 0 && days <= 0 { 1 } else { days };
    crate::pass::period_end(start_ymd, months, d)["end"]
        .as_i64()
        .unwrap_or(start_ymd)
}

fn code(seed: &str) -> String {
    use sha2::{Digest, Sha256};
    // 주문 주소는 주문마다 다르고 남이 미리 알 수 없다. 거기에 무작위를
    // 한 번 더 섞는다 — 주소만 알면 표 번호가 나오면 안 된다.
    let mut salt = [0u8; 16];
    {
        use rand::RngCore;
        rand::thread_rng().fill_bytes(&mut salt);
    }
    let mut h = Sha256::new();
    h.update(seed.as_bytes());
    h.update(salt);
    let d = h.finalize();
    d.iter()
        .take(8)
        .map(|b| ALPHABET[*b as usize % ALPHABET.len()] as char)
        .collect()
}

/// 결제가 확인된 주문에서 이용권을 만든다.
///
/// 🔴 주문이 들어왔을 때가 아니라 **돈이 들어온 것이 확인됐을 때** 부른다.
/// 결제하지 않고 떠난 손님에게 표를 주면 그건 공짜로 내주는 것이다.
///
/// 한 주문에 하루권 세 장이 담겼으면 **세 장을 따로** 만든다. 일행이 나눠
/// 가져야 하기 때문이다 — 한 장에 3인이라고 적으면 같이 들어올 때만 쓴다.
pub fn issue_for_order(order_addr: &str, items: &Value, menu: &Value, now: i64) -> Vec<Value> {
    with_rows(|rows| {
        // 같은 주문을 두 번 발급하지 않는다. `sweep_payments` 는 주기적으로
        // 도는 함수라 같은 주소를 다시 본다 — 막지 않으면 공짜 표가 생긴다.
        let already: Vec<Value> = rows
            .iter()
            .filter(|r| r.get("order").and_then(Value::as_str) == Some(order_addr))
            .cloned()
            .collect();
        if !already.is_empty() {
            return already;
        }

        let mut made = Vec::new();
        for want in items.as_array().cloned().unwrap_or_default() {
            let name = want.get("name").and_then(Value::as_str).unwrap_or("");
            // 🔴 **가격을 세는 쪽과 똑같이 읽는다.** 예전에는 `as_i64` 로
            // 읽고 실패하면 1 로 두고 `max(1)` 을 했는데, 가격 쪽은 `as_f64`
            // 로 읽고 0 이하를 건너뛴다. 그 차이가 **공짜 표**였다:
            //   `qty: 0`      → 0원인데 표 한 장
            //   `qty: 0.0125` → 1/80 값인데 표 한 장 (as_i64 가 실패)
            //
            // 지금은 들어오는 문(`api_order`)에서 양의 정수로 만들지만,
            // 그 한 겹만 믿지 않는다. 돈이 걸린 자리에는 두 겹을 둔다.
            let q = want.get("qty").and_then(Value::as_f64).unwrap_or(0.0);
            let qty = if q.is_finite() && q >= 1.0 {
                (q.floor() as i64).min(999)
            } else {
                0
            };
            if qty <= 0 {
                continue;
            }

            // 얼마짜리 기간인지는 **메뉴에 적힌 값**이다. 손님이 보낸 주문에도
            // 이름이 들어 있지만 거기 적힌 숫자를 믿으면, 폰에서 값을 고쳐
            // 1년권을 하루권 값에 살 수 있다. 가격에서 이미 배운 것이다.
            let it = menu.as_array().and_then(|m| {
                m.iter()
                    .find(|it| it.get("name").and_then(Value::as_str) == Some(name))
            });
            let months = it
                .and_then(|it| it.get("pass_months").and_then(Value::as_i64))
                .unwrap_or(0)
                .max(0);
            let days = it
                .and_then(|it| it.get("pass_days").and_then(Value::as_i64))
                .unwrap_or(0)
                .max(0);
            if months <= 0 && days <= 0 {
                continue; // 이용권이 아닌 품목. 커피는 표가 아니다.
            }

            let start = crate::pass::today_ymd(now);
            let end = ends_on(start, months, days);
            for _ in 0..qty {
                let row = json!({
                    "code": code(order_addr),
                    "item": name,
                    "months": months,
                    "days": days,
                    "order": order_addr,
                    "issued": now,
                    // 🔴 날짜(YYYYMMDD)다. 유닉스 초가 아니다 — 「어느 날
                    //    자정인가」가 시간대에 따라 흔들리면 안 된다.
                    //    손님은 날짜로 이야기한다.
                    "from": start,
                    "until": end,
                    "visits": [],
                });
                made.push(row.clone());
                rows.push(row);
            }
        }

        if !made.is_empty() {
            // 표가 무한히 쌓이면 파일을 읽는 데만 시간이 걸린다. 끝난 지
            // 90일 지난 것은 지운다 — 그보다 오래된 표로 항의하러 오는
            // 사람은 없고, 매출 기록은 장부(`ledger`)에 따로 있다.
            let cut = crate::pass::days_from_ymd(crate::pass::today_ymd(now)) - 90;
            rows.retain(|r| {
                r.get("until")
                    .and_then(Value::as_i64)
                    .map(|u| crate::pass::days_from_ymd(u) > cut)
                    .unwrap_or(true)
            });
        }
        made
    })
}

/// 이 표가 지금 쓸 수 있나. **쓰지는 않는다** — 보기만 한다.
fn judge(row: &Value, now: i64) -> Value {
    let until = row.get("until").and_then(Value::as_i64).unwrap_or(0);
    let from = row.get("from").and_then(Value::as_i64).unwrap_or(0);
    let today = crate::pass::today_ymd(now);
    // 마지막 날도 이용일이다. 그래서 `<=` 다 — `<` 로 두면 한 달권이
    // 29일이 되고, 그 하루로 카운터에서 싸움이 난다.
    let left_days =
        (crate::pass::days_from_ymd(until) - crate::pass::days_from_ymd(today) + 1).max(0);

    let (ok, why) = if today < from {
        (false, "아직 시작 안 한 표입니다")
    } else if today > until {
        (false, "기간이 지난 표입니다")
    } else {
        (true, "")
    };

    let mut out = row.clone();
    if let Some(m) = out.as_object_mut() {
        m.insert("valid".into(), json!(ok));
        m.insert("why".into(), json!(why));
        m.insert("left_days".into(), json!(left_days));
        // 오늘 이미 들어왔나. 막지는 않는다 — 하루권으로 나갔다 들어오는 것은
        // 정상이다. 직원이 알고만 있으면 된다.
        let used_today = row
            .get("visits")
            .and_then(Value::as_array)
            .map(|v| {
                v.iter()
                    .filter(|t| {
                        t.as_i64()
                            .map(|t| crate::pass::today_ymd(t) == today)
                            .unwrap_or(false)
                    })
                    .count()
            })
            .unwrap_or(0);
        m.insert("used_today".into(), json!(used_today));
    }
    out
}

/// 표 하나를 찾아 본다. 검표기가 QR 을 읽고 부른다.
#[tauri::command]
pub fn ticket_find(code: String, now_unix: i64) -> Result<Value, String> {
    let want = code.trim().to_uppercase();
    let rows = read_rows();
    rows.iter()
        // 🔴 회원으로 올라간 표는 여기서 안 찾는다. 회원 쪽이 진실이고,
        // 기간을 연장했으면 그쪽만 늘어나 있다. 두 곳이 다른 답을 하면
        // 문 앞에서 어느 쪽을 믿을지 아무도 모른다.
        .filter(|r| !r.get("promoted").and_then(Value::as_bool).unwrap_or(false))
        .find(|r| r.get("code").and_then(Value::as_str) == Some(want.as_str()))
        .map(|r| judge(r, now_unix))
        .ok_or_else(|| "그런 표가 없습니다.".to_string())
}

/// 들여보낸다. 기록이 남는다.
///
/// 🔴 못 쓰는 표는 **거절한다.** 경고만 띄우고 세어 두면, 나중에 그 숫자를
/// 아무도 맞춰 볼 수 없다.
#[tauri::command]
pub fn ticket_use(code: String, now_unix: i64) -> Result<Value, String> {
    let want = code.trim().to_uppercase();
    with_rows(|rows| {
        let Some(idx) = rows
            .iter()
            .position(|r| r.get("code").and_then(Value::as_str) == Some(want.as_str()))
        else {
            return Err("그런 표가 없습니다.".into());
        };

        let state = judge(&rows[idx], now_unix);
        if !state["valid"].as_bool().unwrap_or(false) {
            return Err(state["why"].as_str().unwrap_or("쓸 수 없습니다").to_string());
        }

        if let Some(m) = rows[idx].as_object_mut() {
            let mut log = m
                .get("visits")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            log.push(json!(now_unix));
            if log.len() > 200 {
                let n = log.len();
                log.drain(0..n - 200);
            }
            m.insert("visits".into(), json!(log));
        }
        Ok(judge(&rows[idx], now_unix))
    })
}

/// 표를 **회원으로 올린다.** 이름과 전화번호를 받는 순간이다.
///
/// ## 왜 여기서 받나
///
/// 카운터에서 돈 낼 때 이름·전화를 물으면 **줄이 선다.** 그리고 대부분
/// 거절한다 — 커피 한 잔 사면서 연락처를 주는 사람은 없다.
///
/// 그런데 **문 앞에서 표를 찍는 순간**은 다르다. 손님은 이미 멈춰 서 있고,
/// 직원과 마주 보고 있고, 한 달을 다닐 사람이다. 그때 「연락처를 남기시면
/// 끝나기 전에 알려드립니다」는 손님에게도 이득이라 대개 준다.
///
/// 헬스장 회원 관리가 시작되는 자리가 여기다.
///
/// ## 🔴 옮기는 것이지 베끼는 것이 아니다
///
/// 회원으로 올라간 표는 `promoted` 가 붙고, 그 뒤로는 **회원 쪽이 진실**이다.
/// 두 곳에 남겨 두면 기간을 연장했을 때 한쪽만 늘어나고, 문 앞에서 어느
/// 쪽을 믿을지 아무도 모른다.
#[tauri::command]
pub fn ticket_to_member(
    code: String,
    name: String,
    phone: String,
    now_unix: i64,
) -> Result<Value, String> {
    if name.trim().is_empty() {
        return Err("이름을 적어 주세요.".into());
    }
    let want = code.trim().to_uppercase();

    let (item, until) = {
        let rows = read_rows();
        let r = rows
            .iter()
            .find(|r| r.get("code").and_then(Value::as_str) == Some(want.as_str()))
            .ok_or_else(|| "그런 표가 없습니다.".to_string())?;
        if r.get("promoted").and_then(Value::as_bool).unwrap_or(false) {
            return Err("이미 회원으로 등록된 표입니다.".into());
        }
        (
            r.get("item").and_then(Value::as_str).unwrap_or("이용권").to_string(),
            r.get("until").and_then(Value::as_i64).unwrap_or(0),
        )
    };

    // 회원 번호 자리에 **표 번호를 그대로** 쓴다. 손님이 이미 그 번호가
    // 적힌 화면을 들고 있고, 문 앞에서 찍는 QR 도 그것이다. 새 번호를 주면
    // 손님이 든 표와 명단이 어긋난다.
    crate::pass::save_member(
        want.clone(),
        name.trim().to_string(),
        phone.trim().to_string(),
        "period".into(),
        until,
        0,
        format!("카운터에서 산 {item}"),
        now_unix,
        // 문 앞에서는 이름·전화만 받는다. 나머지는 사장이 나중에 채운다 —
        // 줄이 선 자리에서 생년월일까지 물으면 손님이 돌아선다.
        None,
    )?;

    with_rows(|rows| {
        if let Some(r) = rows
            .iter_mut()
            .find(|r| r.get("code").and_then(Value::as_str) == Some(want.as_str()))
        {
            if let Some(m) = r.as_object_mut() {
                m.insert("promoted".into(), json!(true));
                m.insert("name".into(), json!(name.trim()));
            }
        }
    });

    Ok(json!({ "code": want, "name": name.trim(), "until": until }))
}

/// 이 주문으로 나온 표들. 손님 화면이 결제 직후 부른다.
pub fn for_order(order_addr: &str, now: i64) -> Value {
    let rows = read_rows();
    let mine: Vec<Value> = rows
        .iter()
        .filter(|r| r.get("order").and_then(Value::as_str) == Some(order_addr))
        .map(|r| judge(r, now))
        .collect();
    json!({ "tickets": mine })
}

/// 사장 화면의 목록. 끝난 것은 뒤로.
#[tauri::command]
pub fn ticket_list(now_unix: i64) -> Value {
    let mut rows: Vec<Value> = read_rows().iter().map(|r| judge(r, now_unix)).collect();
    rows.sort_by_key(|r| -(r.get("issued").and_then(Value::as_i64).unwrap_or(0)));
    json!({ "tickets": rows, "count": rows.len() })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn menu() -> Value {
        json!([
            { "name": "하루권", "price": 10000, "pass_days": 1 },
            { "name": "2일권", "price": 18000, "pass_days": 2 },
            { "name": "한달권", "price": 90000, "pass_months": 1 },
            { "name": "3개월권", "price": 240000, "pass_months": 3 },
            { "name": "1년권", "price": 800000, "pass_months": 12 },
            { "name": "3개월+7일", "price": 250000, "pass_months": 3, "pass_days": 7 },
            { "name": "아메리카노", "price": 4500 },
        ])
    }

    /// 2026-08-23 정오.
    const NOON: i64 = 1_787_443_200;

    /// 🔴 시험은 **대표님의 진짜 표 파일에 쓰면 안 된다.** 예약에서 배운 것과
    /// 같다 — `cargo test` 한 번이 실제 가게 데이터를 건드렸다.
    fn in_sandbox<T>(f: impl FnOnce() -> T) -> T {
        let _g = crate::paths::TEST_ENV
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let dir = std::env::temp_dir().join("playx-raven-ticket-test");
        let _ = std::fs::create_dir_all(&dir);
        std::env::set_var("PLAYX_RAVEN_HOME", &dir);
        let _ = std::fs::remove_file(dir.join("tickets.json"));
        let out = f();
        std::env::remove_var("PLAYX_RAVEN_HOME");
        out
    }

    fn one(order: &str, item: &str, now: i64) -> Value {
        let t = issue_for_order(order, &json!([{ "name": item, "qty": 1 }]), &menu(), now);
        assert_eq!(t.len(), 1, "{item} 이 표로 안 나왔다");
        t[0].clone()
    }

    /// 🔴 밤 11시에 산 하루권이 한 시간 뒤에 끝나면 손님은 사기당한 것이다.
    /// 산 날이 1일째고 그날 하루를 다 쓴다.
    #[test]
    fn a_day_pass_bought_at_night_still_covers_that_day() {
        in_sandbox(|| {
            let late = NOON + 11 * 3600; // 같은 날 밤 11시
            let r = one("Rlate", "하루권", late);
            assert_eq!(r["from"], r["until"], "하루권인데 하루가 아니다");
            assert_eq!(judge(&r, late)["valid"], json!(true));
        });
    }

    /// 🔴 3개월을 90일로 세면 틀린다. 달력으로 세야 회원권과 같은 날짜가 나온다.
    #[test]
    fn three_months_follows_the_calendar_not_ninety_days() {
        in_sandbox(|| {
            let r = one("R3m", "3개월권", NOON);
            let start = r["from"].as_i64().unwrap();
            let end = r["until"].as_i64().unwrap();
            // 8월 23일 + 3개월 = 11월 22일 (11월 23일의 전날)
            assert_eq!(start, 20_260_823);
            assert_eq!(end, 20_261_122, "달력이 아니라 90일로 셌다");
        });
    }

    /// 1년권도 같은 규칙이다. 다음 해 같은 날의 전날까지.
    #[test]
    fn a_year_pass_ends_the_day_before_the_same_date() {
        in_sandbox(|| {
            let r = one("R1y", "1년권", NOON);
            assert_eq!(r["until"], json!(20_270_822));
        });
    }

    /// 「3개월 + 7일」 같은 것을 파는 가게가 실제로 있다. 둘 다 세야 한다.
    #[test]
    fn months_and_days_add_up() {
        in_sandbox(|| {
            let r = one("Rboth", "3개월+7일", NOON);
            assert_eq!(r["until"], json!(20_261_129), "덤 7일이 안 붙었다");
        });
    }

    /// 마지막 날도 이용일이다. `<` 로 두면 한 달권이 하루 모자란다.
    #[test]
    fn the_last_day_is_still_a_usable_day() {
        in_sandbox(|| {
            let r = one("Rlast", "한달권", NOON);
            let end = r["until"].as_i64().unwrap();
            assert_eq!(end, 20_260_922);
            // 9월 22일 정오 — 마지막 날
            let last_noon = NOON + 30 * 86_400;
            assert_eq!(crate::pass::today_ymd(last_noon), 20_260_922);
            assert_eq!(judge(&r, last_noon)["valid"], json!(true), "마지막 날에 막혔다");
            assert_eq!(judge(&r, last_noon + 86_400)["valid"], json!(false));
        });
    }

    /// 커피는 표가 아니다. 같은 주문에 섞여 있어도 표는 이용권에서만 나온다.
    #[test]
    fn only_pass_items_become_tickets() {
        in_sandbox(|| {
            let t = issue_for_order(
                "Rmixed",
                &json!([{ "name": "아메리카노", "qty": 2 }, { "name": "하루권", "qty": 1 }]),
                &menu(),
                NOON,
            );
            assert_eq!(t.len(), 1);
            assert_eq!(t[0]["item"], json!("하루권"));
        });
    }

    /// 일행이 셋이면 표도 셋이다. 한 장에 3인이라고 적으면 나눠 못 가진다.
    #[test]
    fn three_of_the_same_pass_make_three_tickets() {
        in_sandbox(|| {
            let t = issue_for_order("Rthree", &json!([{ "name": "하루권", "qty": 3 }]), &menu(), NOON);
            assert_eq!(t.len(), 3);
            let codes: std::collections::HashSet<&str> =
                t.iter().filter_map(|r| r["code"].as_str()).collect();
            assert_eq!(codes.len(), 3, "표 번호가 겹치면 한 장으로 셋이 들어온다");
        });
    }

    /// 🔴 sweep 은 같은 주소를 다시 본다. 두 번 발급하면 공짜 표가 생긴다.
    #[test]
    fn the_same_order_never_issues_twice() {
        in_sandbox(|| {
            let a = one("Rtwice", "하루권", NOON);
            let b = issue_for_order("Rtwice", &json!([{ "name": "하루권", "qty": 1 }]), &menu(), NOON);
            assert_eq!(b.len(), 1);
            assert_eq!(a["code"], b[0]["code"], "두 번째에 새 표가 나왔다");
        });
    }

    /// 🔴 손님이 보낸 주문에 기간을 적어 보내도 무시해야 한다. 안 그러면
    /// 폰에서 값을 고쳐 1년권을 하루권 값에 산다.
    #[test]
    fn the_phone_cannot_choose_how_long_the_pass_lasts() {
        in_sandbox(|| {
            let t = issue_for_order(
                "Rcheat",
                &json!([{ "name": "하루권", "qty": 1, "pass_months": 12, "pass_days": 365 }]),
                &menu(),
                NOON,
            );
            assert_eq!(t[0]["until"], json!(20_260_823), "폰이 보낸 기간이 먹혔다");
        });
    }

    /// 🔴 **공짜 표.** 가격은 `qty <= 0` 을 건너뛰어 0원인데, 표는 예전에
    /// `max(1)` 이라 한 장이 나왔다. 카운터에서 돈 안 내고 표를 받는 길이었다.
    #[test]
    fn a_zero_quantity_buys_nothing() {
        in_sandbox(|| {
            let t = issue_for_order("Rzero", &json!([{ "name": "하루권", "qty": 0 }]), &menu(), NOON);
            assert!(t.is_empty(), "0개를 시켰는데 표가 나왔다");
        });
    }

    /// 🔴 **반값 표.** 소수를 보내면 가격은 비례해 줄고 `as_i64` 는 실패했다 —
    /// 80만원짜리 1년권을 1만원에 사는 길이었다.
    #[test]
    fn a_fractional_quantity_buys_nothing() {
        in_sandbox(|| {
            for q in [json!(0.0125), json!(0.9), json!(-3), json!("1")] {
                let t = issue_for_order(
                    "Rfrac",
                    &json!([{ "name": "1년권", "qty": q }]),
                    &menu(),
                    NOON,
                );
                assert!(t.is_empty(), "{q} 로 표가 나왔다");
            }
        });
    }

    /// 소수라도 1 이상이면 **내림**한다. 덜 주는 쪽이 안전하다.
    #[test]
    fn two_and_a_half_becomes_two() {
        in_sandbox(|| {
            let t = issue_for_order("Rhalf", &json!([{ "name": "하루권", "qty": 2.5 }]), &menu(), NOON);
            assert_eq!(t.len(), 2);
        });
    }

    /// 표 번호에 헷갈리는 글자가 없어야 한다. 손님이 불러 줘야 할 때가 온다.
    #[test]
    fn codes_avoid_letters_people_misread() {
        let c = code("Rseed");
        assert_eq!(c.len(), 8);
        for ch in c.chars() {
            assert!(!"01OIL".contains(ch), "헷갈리는 글자가 들어갔다: {c}");
        }
    }

    /// 기간이 지난 표는 **거절한다.** 경고만 띄우고 세면 아무도 못 맞춘다.
    #[test]
    fn an_expired_ticket_is_refused_not_counted() {
        in_sandbox(|| {
            let r = one("Rold", "하루권", NOON);
            let c = r["code"].as_str().unwrap().to_string();
            let err = ticket_use(c, NOON + 3 * 86_400).unwrap_err();
            assert!(err.contains("지난"), "{err}");
        });
    }

}
