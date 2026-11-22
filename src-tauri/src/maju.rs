//! 장터 「이번 주 공동구매 · 마주가 고른 상품」 — 데스크탑 쪽 길 둘. (2026-11-16, 대표 「레이븐볼트 데스크탑도 상품 살 수 있어야지」)
//!
//! 폰·웹(playx-raven 지갑 저장소 phone/screens/majuSession.ts · phone/ui/maju-pay.ts)과 **같은 서버·같은 확인**을 쓴다.
//!
//! ① `maju_call` — 마주 서버 함수(maju-rv) 부르기. 화면 fetch 는 CSP connect-src 가 막아서 여기서 부른다.
//!    🔴 길은 코드에 박힌 몇 개뿐(상품·잡기·확정·반납·주문 보기·받은 뒤·주소 찾기). 리다이렉트 안 따라감 · 시간 제한 · 답 크기 상한.
//! ② `maju_pay` — 한 주문 결제: **한 거래**(`sendmany`) 안에 마주 판매 대금 99% + 레이븐볼트 1%.
//!    🔴 서버 견적(payTo)을 그대로 믿지 않는다: 받는 주소는 코드에 박힌 MAJU_PAY_TO 안에 있어야 하고(폰과 같은 목록),
//!       수수료 주소는 오락실과 같은 고정값(ARCADE_FEE_ADDRESS = MARKET_FEE_ADDRESS)이어야 하며,
//!       합계는 잡을 때 받은 견적 rvnAtoms 와 같고, 나누기는 여기서 다시 계산한 것(arcade::split_price)과 같아야 보낸다.
//!    🔴 같은 잡기(reservationId)로 두 번 보내지 않는다(payout_guard — 같은 내용이면 처음 txid 를 돌려준다).
//!    🔴 사람이 확인 칸에서 「RVN 보내고 주문하기」를 누를 때만 불린다. 우리가 돈을 들고 있지 않는다(손님 지갑 → 받는 곳 직접).
use serde_json::{json, Value};

use crate::arcade::{split_price, ARCADE_FEE_ADDRESS};
use crate::raven::call_rpc;

/// 마주 서버 함수 — phone/screens/majuSession.ts MAJU_FUNCTION 과 같은 값.
const MAJU_FUNCTION: &str = "https://mygroanhychotipukfzt.supabase.co/functions/v1/maju-rv";
/// 마주 판매 대금을 받을 수 있는 주소 — phone/ui/maju-pay.ts MAJU_PAY_TO 와 같은 값(대표 맥 레이븐볼트 가게 주소, 11-14).
/// 바꾸려면 앱을 새로 낸다(서버가 털려도 돈이 딴 데로 가지 않게).
pub const MAJU_PAY_TO: &[&str] = &["RQD1AgwcS5DGDGnYBKXnjuJZpvUw52rMSt"];
const BODY_MAX: usize = 16 * 1024;
const ANSWER_MAX: usize = 512 * 1024;

static CLIENT: std::sync::OnceLock<reqwest::Client> = std::sync::OnceLock::new();
fn client() -> &'static reqwest::Client {
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(15))
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .unwrap_or_default()
    })
}

fn uuid_ok(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() == 36
        && b.iter().enumerate().all(|(i, c)| if [8, 13, 18, 23].contains(&i) { *c == b'-' } else { c.is_ascii_hexdigit() })
}
fn token_ok(s: &str) -> bool {
    (20..=80).contains(&s.len()) && s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

/// 부를 수 있는 길인가 — (방법, 길). 모르는 길은 부르지 않는다.
pub(crate) fn path_ok(method: &str, path: &str) -> bool {
    match (method, path) {
        ("GET", "/products") | ("GET", "/address") => true,
        ("POST", "/reserve") | ("POST", "/confirm") | ("POST", "/release") => true,
        _ => {
            let Some(rest) = path.strip_prefix("/order/") else { return false };
            let mut it = rest.splitn(2, '/');
            let id = it.next().unwrap_or("");
            if !uuid_ok(id) { return false; }
            match (method, it.next()) {
                ("GET", None) => true,
                ("POST", Some("received" | "ask" | "problem" | "praise")) => true,
                _ => false,
            }
        }
    }
}
/// 물음표 뒤에 붙일 수 있는 것 — test=1 · 주소 찾기 q·page 만.
fn query_ok(path: &str, k: &str, v: &str) -> bool {
    match (path, k) {
        ("/products", "test") => v == "1",
        ("/address", "q") => !v.is_empty() && v.chars().count() <= 80,
        ("/address", "page") => !v.is_empty() && v.len() <= 3 && v.bytes().all(|b| b.is_ascii_digit()),
        _ => false,
    }
}

/// 마주 서버 부르기. 답은 `{ status, body }` — 오류 모양(`{error, detail}`)은 화면이 마주 문구로 바꾼다.
#[tauri::command]
pub async fn maju_call(method: String, path: String, query: Option<Value>, body: Option<Value>, token: Option<String>) -> Result<Value, String> {
    let method = method.to_ascii_uppercase();
    if !path_ok(&method, &path) {
        return Err("PLAY X 장터에 부를 수 없는 길이에요.".into());
    }
    let mut url = reqwest::Url::parse(&format!("{MAJU_FUNCTION}{path}")).map_err(|_| "PLAY X 장터 주소 오류")?;
    if let Some(Value::Object(q)) = &query {
        let mut pairs = url.query_pairs_mut();
        for (k, v) in q {
            let v = v.as_str().ok_or("PLAY X 장터 물음 오류")?;
            if !query_ok(&path, k, v) { return Err("PLAY X 장터 물음 오류".into()); }
            pairs.append_pair(k, v);
        }
    }
    if url.query() == Some("") { url.set_query(None); }
    let mut req = if method == "GET" { client().get(url) } else { client().post(url) };
    if let Some(t) = token {
        if !token_ok(&t) { return Err("주문 표가 맞지 않아요.".into()); }
        req = req.header("x-rv-token", t);
    }
    if method == "POST" {
        let bytes = serde_json::to_vec(&body.unwrap_or_else(|| json!({}))).map_err(|_| "PLAY X 장터 보낼 내용 오류")?;
        if bytes.len() > BODY_MAX { return Err("보낼 내용이 너무 길어요.".into()); }
        req = req.header("content-type", "application/json").body(bytes);
    }
    let r = req.send().await.map_err(|_| "network".to_string())?;
    let status = r.status().as_u16();
    if r.content_length().map(|n| n as usize > ANSWER_MAX).unwrap_or(false) {
        return Err("PLAY X 장터 답이 너무 커요.".into());
    }
    let b = r.bytes().await.map_err(|_| "network".to_string())?;
    if b.len() > ANSWER_MAX { return Err("PLAY X 장터 답이 너무 커요.".into()); }
    let body: Value = serde_json::from_slice(&b).unwrap_or(Value::Null);
    Ok(json!({ "status": status, "body": body }))
}

/// 검사를 지난 「보낼 곳」.
#[derive(Debug, PartialEq, Eq)]
pub struct MajuPayment { pub address: String, pub seller: u64, pub fee: u64, pub total: u64 }

fn atoms(v: &Value) -> Option<u64> {
    let s = v.as_str()?;
    if s.is_empty() || s.len() > 16 || s.starts_with('0') || !s.bytes().all(|b| b.is_ascii_digit()) { return None; }
    s.parse().ok()
}

/// 서버 견적의 payTo 를 다시 대조한다(폰 checkMajuPayTo 와 같은 규칙). 하나라도 어긋나면 보내지 않는다.
/// quote_atoms = 잡을 때 서버가 정한 합계(견적 rvnAtoms) — payTo.totalAtoms 와 같아야 한다.
pub fn check_pay_to(pay_to: &Value, quote_atoms: &str) -> Result<MajuPayment, String> {
    let bad = || "받는 곳이 확인되지 않아 보내지 않았어요.".to_string();
    let address = pay_to.get("address").and_then(Value::as_str).ok_or_else(bad)?;
    let fee_address = pay_to.get("feeAddress").and_then(Value::as_str).ok_or_else(bad)?;
    if !MAJU_PAY_TO.contains(&address) { return Err(bad()); }
    if fee_address != ARCADE_FEE_ADDRESS || address == ARCADE_FEE_ADDRESS { return Err(bad()); }
    let total = pay_to.get("totalAtoms").and_then(atoms).ok_or_else(bad)?;
    let seller = pay_to.get("sellerAtoms").and_then(atoms).ok_or_else(bad)?;
    let fee = pay_to.get("feeAtoms").and_then(atoms).ok_or_else(bad)?;
    if pay_to.get("totalAtoms").and_then(Value::as_str) != Some(quote_atoms) { return Err(bad()); }
    let (s, f) = split_price(total).map_err(|_| bad())?;
    if s != seller || f != fee || seller.checked_add(fee) != Some(total) {
        return Err("나눈 값이 맞지 않아 보내지 않았어요.".into());
    }
    Ok(MajuPayment { address: address.to_string(), seller, fee, total })
}

/// 지급 기록에 남기는 내용 — 같은 잡기로 다른 내용을 보내려 하면 payout_guard 가 막는다.
fn intent_for(reservation_id: &str, p: &MajuPayment) -> Result<Vec<u8>, String> {
    serde_json::to_vec(&json!(["maju", reservation_id, p.address, p.seller, ARCADE_FEE_ADDRESS, p.fee])).map_err(|_| "지급 내용 오류".into())
}

fn atoms_json(a: u64) -> Value {
    json!(format!("{}.{:08}", a / 100_000_000, a % 100_000_000))
}

/// 마주 주문 결제. 사람이 확인 칸에서 「RVN 보내고 주문하기」를 누른 뒤에만 불린다. 같은 잡기(reservationId)는 한 번만.
#[tauri::command]
pub async fn maju_pay(reservation_id: String, pay_to: Value, quote_atoms: String, passphrase: Option<String>) -> Result<Value, String> {
    if !uuid_ok(&reservation_id) {
        return Err("잡아 둔 주문 번호가 맞지 않습니다.".into());
    }
    let pay = check_pay_to(&pay_to, &quote_atoms)?;
    let addr = crate::send::check_address(pay.address.clone()).await?;
    if !addr["valid"].as_bool().unwrap_or(false) {
        return Err("받는 곳이 확인되지 않아 보내지 않았어요.".into());
    }
    let intent = intent_for(&reservation_id, &pay)?;
    crate::send::with_unlocked(passphrase, || async {
        let guard = match crate::payout_guard::begin(&crate::paths::app_file("payouts"), "maju", &reservation_id, &intent)? {
            crate::payout_guard::Begin::Done(txid) => return Ok(json!({ "txid": txid, "replayed": true })),
            crate::payout_guard::Begin::New(guard) => guard,
        };
        let mut outs = serde_json::Map::new();
        outs.insert(pay.address.clone(), atoms_json(pay.seller));
        outs.insert(ARCADE_FEE_ADDRESS.to_string(), atoms_json(pay.fee));
        let result = call_rpc("sendmany", json!(["", Value::Object(outs)])).await?;
        let txid = result.as_str().map(str::to_string).ok_or_else(|| "sendmany did not return a txid".to_string())?;
        guard.complete_waiting_ack(&txid)?;
        crate::refund::remember_ours(&txid);
        Ok(json!({ "txid": txid, "sellerAtoms": pay.seller, "feeAtoms": pay.fee }))
    })
    .await
}

/// 결과를 화면이 받았다 — 결제 칸의 「미확인」 표시를 푼다(arcade_ack 와 같은 일).
#[tauri::command(async)]
pub fn maju_ack(reservation_id: String) -> Result<(), String> {
    crate::payout_guard::acknowledge(&crate::paths::app_file("payouts"), "maju", &reservation_id)
}

#[cfg(test)]
mod tests {
    use super::*;

    const RID: &str = "43009271-8a03-4fbb-bd2b-64ce71945371";
    fn good() -> Value {
        json!({ "address": MAJU_PAY_TO[0], "sellerAtoms": "69300000", "feeAddress": ARCADE_FEE_ADDRESS, "feeAtoms": "700000", "totalAtoms": "70000000" })
    }

    #[test]
    fn 맞는_견적은_지난다() {
        let p = check_pay_to(&good(), "70000000").unwrap();
        assert_eq!(p, MajuPayment { address: MAJU_PAY_TO[0].into(), seller: 69_300_000, fee: 700_000, total: 70_000_000 });
    }

    #[test]
    fn 나누기가_다르면_안_보낸다() {
        let mut v = good();
        v["sellerAtoms"] = json!("69400000");
        v["feeAtoms"] = json!("600000");
        assert!(check_pay_to(&v, "70000000").is_err());
        // 합은 맞아도 1% 규칙과 다르면 거절
        let mut v = good();
        v["sellerAtoms"] = json!("70000000");
        v["feeAtoms"] = json!("0");
        assert!(check_pay_to(&v, "70000000").is_err());
        // 견적 합계와 다르면 거절
        assert!(check_pay_to(&good(), "71000000").is_err());
        // 숫자 모양
        let mut v = good();
        v["totalAtoms"] = json!(70000000);
        assert!(check_pay_to(&v, "70000000").is_err());
        let mut v = good();
        v["feeAtoms"] = json!("0700000");
        assert!(check_pay_to(&v, "70000000").is_err());
    }

    #[test]
    fn 주소가_다르면_안_보낸다() {
        let mut v = good();
        v["feeAddress"] = json!("RQD1AgwcS5DGDGnYBKXnjuJZpvUw52rMSt");
        assert!(check_pay_to(&v, "70000000").is_err(), "수수료 주소는 코드 고정값만");
        let mut v = good();
        v["feeAddress"] = json!("RXissuePLAYXxxxxxxxxxxxxxxxxxxxxxx");
        assert!(check_pay_to(&v, "70000000").is_err());
        let mut v = good();
        v["address"] = json!("RAttackerAddressxxxxxxxxxxxxxxxxxx");
        assert!(check_pay_to(&v, "70000000").is_err(), "받는 곳은 박힌 목록만");
        let mut v = good();
        v["address"] = json!(ARCADE_FEE_ADDRESS);
        assert!(check_pay_to(&v, "70000000").is_err());
        assert!(check_pay_to(&Value::Null, "70000000").is_err(), "0원(payTo=null)은 보내지 않는다");
    }

    #[test]
    fn 같은_잡기는_한_번만_보낸다() {
        let dir = std::env::temp_dir().join(format!("rv-maju-guard-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let pay = check_pay_to(&good(), "70000000").unwrap();
        let intent = intent_for(RID, &pay).unwrap();
        let txid = "a".repeat(64);
        match crate::payout_guard::begin(&dir, "maju", RID, &intent).unwrap() {
            crate::payout_guard::Begin::New(g) => g.complete_waiting_ack(&txid).unwrap(),
            crate::payout_guard::Begin::Done(_) => panic!("처음엔 새 지급"),
        }
        // 같은 요청 다시 → 보내지 않고 처음 txid
        match crate::payout_guard::begin(&dir, "maju", RID, &intent).unwrap() {
            crate::payout_guard::Begin::Done(t) => assert_eq!(t, txid),
            crate::payout_guard::Begin::New(_) => panic!("두 번 보내면 안 된다"),
        }
        // 같은 잡기 · 다른 내용 → 거절
        let mut other = pay;
        other.seller += 1;
        assert!(crate::payout_guard::begin(&dir, "maju", RID, &intent_for(RID, &other).unwrap()).is_err());
        // 화면이 결과를 받기 전(미확인)에는 다른 주문 결제도 막힌다
        let rid2 = "53009271-8a03-4fbb-bd2b-64ce71945371";
        assert!(crate::payout_guard::begin(&dir, "maju", rid2, &intent).is_err());
        crate::payout_guard::acknowledge(&dir, "maju", RID).unwrap();
        assert!(matches!(crate::payout_guard::begin(&dir, "maju", rid2, &intent).unwrap(), crate::payout_guard::Begin::New(_)));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn 부를_수_있는_길만() {
        assert!(path_ok("GET", "/products"));
        assert!(path_ok("POST", "/reserve") && path_ok("POST", "/confirm") && path_ok("POST", "/release"));
        assert!(path_ok("GET", &format!("/order/{RID}")));
        assert!(path_ok("POST", &format!("/order/{RID}/ask")) && path_ok("POST", &format!("/order/{RID}/praise")));
        assert!(!path_ok("GET", "/admin"));
        assert!(!path_ok("POST", "/products"));
        assert!(!path_ok("GET", "/order/../admin"));
        assert!(!path_ok("POST", &format!("/order/{RID}/refund")));
        assert!(!path_ok("GET", &format!("/order/{RID}/ask")));
        assert!(query_ok("/products", "test", "1") && !query_ok("/products", "test", "0") && !query_ok("/products", "x", "1"));
        assert!(token_ok("abcdefghijklmnopqrstuvwxyz_-01") && !token_ok("short") && !token_ok("abc def ghi jkl mno pqr"));
    }

    #[test]
    fn 돈은_사람이_누를_때만_한_거래로() {
        let src = include_str!("maju.rs");
        let body = &src[..src.find("#[cfg(test)]").unwrap()];
        assert_eq!(body.matches("call_rpc(\"sendmany\"").count(), 1, "결제 부름은 maju_pay 한 곳뿐");
        assert!(!body.contains("sendtoaddress"), "판매 대금·수수료를 두 거래로 나누지 않는다");
        assert!(body.contains("redirect::Policy::none()"));
    }
}
