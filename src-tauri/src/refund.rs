//! Refunds, and watching for spends we did not make.
//!
//! ## A refund is a new payment, not an undo
//!
//! Nothing on a blockchain can be reversed. What a shop calls a refund is the
//! shop sending money back, which means it needs three things the original
//! payment did not require: the customer's address, the shop's own RVN, and a
//! decision by a person.
//!
//! The address is the hard part. A received transaction does not record who
//! sent it, so for a café order there is nobody to send it back to unless the
//! customer told us — which they only did if they bought an asset through the
//! sale page. For everything else the shop has to ask. The UI must say that
//! plainly instead of showing a refund button that fails.
//!
//! ## Watching
//!
//! We cannot stop a compromised machine from spending. The daily cap, the
//! confirmation floor, the one-fulfilment-per-address rule — all of that lives
//! inside our loop, and malware calling the node's RPC directly walks past every
//! one of them.
//!
//! What is left is noticing quickly. This records the txid of everything we
//! send, and anything else leaving the wallet is reported as a spend nobody
//! here asked for. It is not prevention and the UI does not call it security.

use crate::raven::call_rpc;
use serde_json::{json, Value};
use std::collections::HashSet;
use std::sync::Mutex;

/// Every txid this app created. Anything else that spends is not ours.
static OURS: Mutex<Option<HashSet<String>>> = Mutex::new(None);

/// Records a txid we produced, so the watcher does not flag our own work.
pub fn remember_ours(txid: &str) {
    if txid.is_empty() {
        return;
    }
    if let Ok(mut g) = OURS.lock() {
        g.get_or_insert_with(HashSet::new).insert(txid.to_string());
    }
}

#[tauri::command]
pub fn note_our_tx(txid: String) {
    remember_ours(&txid);
}

/// Sends money back to a customer.
///
/// The amount is stated rather than derived from the original payment, because
/// partial refunds are the common case — a missing item, a late delivery, a
/// three-day credit. Deriving it would make the frequent case impossible and
/// the rare case automatic.
#[tauri::command]
pub async fn refund(
    to_address: String,
    amount: f64,
    reason: String,
    passphrase: Option<String>,
) -> Result<Value, String> {
    if amount <= 0.0 {
        return Err("환불 금액이 0보다 커야 합니다.".into());
    }
    let check = crate::send::check_address(to_address.clone()).await?;
    if !check["valid"].as_bool().unwrap_or(false) {
        return Err("환불받을 주소가 올바르지 않습니다.".into());
    }

    let balance = call_rpc("getbalance", json!([]))
        .await
        .ok()
        .and_then(|v| v.as_f64())
        .unwrap_or(0.0);
    if balance < amount {
        return Err(format!(
            "지갑에 {balance} RVN 있습니다. {amount} RVN을 보낼 수 없습니다. \
             환불은 새로 보내는 것이라 잔액이 있어야 합니다."
        ));
    }

    let locked = matches!(
        call_rpc("getwalletinfo", json!([]))
            .await
            .ok()
            .and_then(|i| i.get("unlocked_until").and_then(Value::as_i64)),
        Some(0)
    );
    if locked {
        let pass = passphrase.ok_or_else(|| "지갑이 잠겨 있습니다. 암호가 필요합니다.".to_string())?;
        call_rpc("walletpassphrase", json!([pass, 30])).await?;
    }

    // The reason is a wallet-local comment; it never goes on chain. Said out
    // loud in the UI, because a shop owner writing an apology into a box that
    // the customer will never see is being misled.
    let result = call_rpc(
        "sendtoaddress",
        json!([to_address, amount, format!("환불: {reason}"), "", false]),
    )
    .await;

    if locked {
        let _ = call_rpc("walletlock", json!([])).await;
    }

    let txid = result?
        .as_str()
        .map(str::to_string)
        .ok_or_else(|| "sendtoaddress did not return a txid".to_string())?;
    remember_ours(&txid);

    // 🔴 **여기를 안 부르면 함수만 있고 안 도는 코드가 된다.** 환불한 만큼
    //    우리 몫도 되돌린다 — 취소된 장사에서 개발비를 받으면 안 된다.
    let back = crate::devfee::refund_credit(amount);

    Ok(json!({
        "txid": txid,
        "amount": amount,
        "to": to_address,
        // 얼마를 깎았는지 화면이 말할 수 있게 돌려준다. 0 이면 이미 체인으로
        // 나간 몫이라 못 되돌린 것이고, 그것도 사실대로 적어야 한다.
        "dev_fee_back": back,
    }))
}

/// Spends this app did not make.
///
/// Called on a timer while the shop screen is open. Ignores everything we sent,
/// so a busy day of automatic fulfilment produces no noise — an alert that
/// fires forty times on the first night is an alert the owner turns off.
///
/// 🔴 **주인 표가 나가도 경보를 못 했다(0.4.6 에서 고침).** 예전에는
///    `listtransactions` 만 봤는데, 레이븐 4.8 의 그 명령은 자산 줄을 만들어 놓고
///    **버린다**(rpcwallet.cpp:1790). 그래서 이 목록의 「소유권 토큰이 나갔습니다」는
///    한 번도 켜질 수 없었다. 자산 줄은 `listsinceblock` 의 `asset_transactions` 에
///    있고, 받는 주소는 `address` 가 아니라 `destination` 이다.
///
///    타이머로 불리므로 지갑 전체를 읽지 않는다 — `since_hours` 앞쯤의 블록부터만
///    (`listsinceblock <그 블록>`). 우리가 보낸 거래(`OURS`)는 예전처럼 뺀다.
#[tauri::command]
pub async fn foreign_spends(since_hours: i64) -> Result<Value, String> {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    let hours = since_hours.clamp(0, MAX_WATCH_HOURS);
    let cutoff = now - hours * 3600;

    let tip = call_rpc("getblockcount", json!([])).await?.as_u64().unwrap_or(0);
    let args = match start_height(tip, hours) {
        Some(h) => json!([call_rpc("getblockhash", json!([h])).await?, 1, true]),
        // 체인이 짧다(연습 체인 등) — 처음부터 읽어도 얼마 안 된다.
        None => json!([]),
    };
    let since = call_rpc("listsinceblock", args).await?;

    let ours = OURS.lock().ok().and_then(|g| g.clone()).unwrap_or_default();
    let found = spends_not_ours(&since, cutoff, &ours)?;

    // 앱을 껐다 켜면 우리가 보낸 것도 "남이 보낸 것"으로 보인다. 그걸 침입으로
    // 읽으면 안 되므로, 목록이 신뢰할 만한 구간을 함께 알려 준다.
    let known = !ours.is_empty();
    Ok(json!({
        "spends": found,
        "trustworthy": known,
        "note": if known { "" } else {
            "앱을 켠 뒤 이 앱이 보낸 기록이 아직 없어, 아래 목록에 정상 출금이 섞일 수 있습니다."
        },
    }))
}

/// 한 달보다 길게는 안 본다. 타이머가 지갑 전체를 읽는 길이 되면 안 된다.
const MAX_WATCH_HOURS: i64 = 24 * 31;

/// `hours` 시간 전쯤의 블록 높이. 레이븐은 1분에 한 블록이 목표지만 빨리 나올 때가
/// 있어 넉넉히(1.25배 + 30블록) 거슬러 간다 — 넘치는 것은 아래에서 시각으로 거른다.
/// 체인이 그보다 짧으면 `None`(처음부터).
fn start_height(tip: u64, hours: i64) -> Option<u64> {
    let back = (hours.max(0) as u64) * 60 * 5 / 4 + 30;
    tip.checked_sub(back)
}

/// `listsinceblock` 답에서 **우리가 안 보낸** 보냄 줄 — RVN 줄과 자산 줄 둘 다.
///
/// 자산 줄을 못 읽으면 오류다. 「못 읽음」을 「없음」으로 넘기면 주인 표가 나간 날
/// 조용하다.
fn spends_not_ours(since: &Value, cutoff: i64, ours: &HashSet<String>) -> Result<Vec<Value>, String> {
    let rvn = since
        .get("transactions")
        .and_then(Value::as_array)
        .ok_or("지갑 기록을 읽지 못했어요. 노드가 따라잡은 뒤 다시 해 주세요.")?;
    let assets = crate::raven::asset_transactions_of(since.clone())?;
    let mut found = Vec::new();
    for (tx, asset_row) in rvn
        .iter()
        .map(|t| (t, false))
        .chain(assets.as_array().map(Vec::as_slice).unwrap_or(&[]).iter().map(|t| (t, true)))
    {
        if tx.get("category").and_then(Value::as_str) != Some("send") {
            continue;
        }
        let time = tx.get("time").and_then(Value::as_i64).unwrap_or(0);
        if time < cutoff {
            continue;
        }
        let txid = tx.get("txid").and_then(Value::as_str).unwrap_or("");
        if ours.contains(txid) {
            continue;
        }
        let asset = tx.get("asset_name").and_then(Value::as_str);
        // 자산 줄의 받는 주소는 `destination` 이다(RVN 줄은 `address`).
        let address = if asset_row { tx.get("destination") } else { tx.get("address") };
        found.push(json!({
            "txid": txid,
            "time": time,
            "address": address,
            "amount": tx.get("amount").and_then(Value::as_f64).map(f64::abs),
            "asset": asset,
            // An ownership token leaving is the worst thing on this list: it
            // hands over the right to mint that asset forever.
            "is_owner_token": asset.map(|a| a.ends_with('!')).unwrap_or(false),
        }));
    }
    Ok(found)
}

// ── 직원 환불 한도 ────────────────────────────────────────────────────────
//
// 커피숍에서 환불은 직원이 해야 장사가 된다. 손님이 잘못 시켰거나 우리가 잘못
// 만들었을 때 사장을 부르러 가면 그 사이 줄이 선다.
//
// 그런데 체인은 보낸 사람을 기록하지 않는다. 그래서 "그 손님에게 돌려주기"가
// 자동으로 안 되고, 직원이 주소를 받아 쳐야 한다 — 곧 **아무 주소로나 보낼 수
// 있다**는 뜻이다. 그래서 신뢰가 아니라 한도로 막는다.
//
// 한도가 곧 손실의 상한이고, 그 상한이 줄을 세우지 않는 값이다.

/// 직원 1건 한도 — 미국 달러 기준.
///
/// 통화별로 따로 적지 않는 이유: 나라가 늘 때마다 표를 고쳐야 하고, 빠뜨린
/// 나라는 조용히 원화 한도를 쓰게 된다. 한 곳에 적고 그 나라 돈으로 바꾼다.
const STAFF_ONCE_USD: f64 = 25.0;
/// 직원 하루 한도 — 미국 달러 기준.
const STAFF_DAY_USD: f64 = 80.0;

/// 사람이 읽는 자리에서 끊는다. 33,152원 짜리 한도는 아무도 기억하지 못한다.
fn round_limit(v: f64) -> f64 {
    let step = if v >= 10_000.0 {
        10_000.0
    } else if v >= 1_000.0 {
        1_000.0
    } else if v >= 100.0 {
        10.0
    } else {
        5.0
    };
    (v / step).round().max(1.0) * step
}

/// 이 가게 돈으로 환산한 한도. (1건, 하루)
///
/// 환율이 안 잡히면: 원화 가게는 원화 기본값으로, **그 밖의 가게는 직원 환불을
/// 닫는다**(한도 0).
///
/// 🔴 2026-09-23 까지는 어느 나라든 원화 숫자(30,000·100,000)로 되돌아갔다. 그런데
///    환불 금액은 가게 돈으로 센다 — 유로 가게에서 환율 조회가 한 번 실패하면
///    직원이 **3만 유로**까지 환불할 수 있었다. 한도를 못 계산했다고 여는 것은
///    정반대 방향의 실수다.
async fn staff_limits() -> (f64, f64, String) {
    let cur = crate::shop::currency();
    if cur == "USD" {
        return (STAFF_ONCE_USD, STAFF_DAY_USD, cur);
    }
    let fx = crate::price::fiat_per_usd_public(&cur).await;
    limits_from_fx(&cur, fx)
}

fn limits_from_fx(cur: &str, fx: Option<f64>) -> (f64, f64, String) {
    match fx.filter(|v| v.is_finite() && *v > 0.0) {
        Some(fx) => (
            round_limit(STAFF_ONCE_USD * fx),
            round_limit(STAFF_DAY_USD * fx),
            cur.to_string(),
        ),
        None if cur == "KRW" => (30_000.0, 100_000.0, "KRW".into()),
        None => (0.0, 0.0, cur.to_string()),
    }
}

/// 오늘 직원이 내보낸 금액. (day, krw)
static STAFF_TODAY: std::sync::Mutex<(i64, f64)> = std::sync::Mutex::new((0, 0.0));

fn today(now_unix: i64) -> i64 {
    now_unix - (now_unix % 86_400)
}

/// What a staff refund is allowed to be right now.
///
/// Returns the verdict rather than just a bool: a screen that says "안 됩니다"
/// with no number sends the staff member to find the owner without knowing what
/// to ask for.
#[tauri::command]
pub async fn staff_refund_limits(now_unix: i64) -> Value {
    let (day, used) = STAFF_TODAY.lock().map(|g| *g).unwrap_or((0, 0.0));
    let used = if day == today(now_unix) { used } else { 0.0 };
    let (once, per_day, cur) = staff_limits().await;
    json!({
        "once": once,
        "day": per_day,
        "used": used,
        "left": (per_day - used).max(0.0),
        "currency": cur,
        // 예전 이름. 화면이 아직 이걸 읽고 있어 같이 보낸다 — 통화가 원화가
        // 아니면 이 이름은 거짓이므로, 화면을 고친 뒤 지운다.
        "once_krw": once,
        "day_krw": per_day,
        "used_krw": used,
        "left_krw": (per_day - used).max(0.0),
    })
}

/// A refund made by staff, inside the limits.
///
/// The amount is checked in the shop's own currency, not in RVN — a limit that
/// drifts with the exchange rate is not a limit anyone can reason about.
#[tauri::command]
pub async fn staff_refund(
    to_address: String,
    krw: f64,
    reason: String,
    now_unix: i64,
    passphrase: Option<String>,
) -> Result<Value, String> {
    if krw <= 0.0 {
        return Err("금액이 0보다 커야 합니다.".into());
    }
    let (once, per_day, cur) = staff_limits().await;
    let unit = crate::price::symbol_for(&cur);
    if once <= 0.0 {
        return Err("환율을 읽지 못해 직원 환불을 잠시 멈췄습니다. 사장님께 부탁하세요.".into());
    }
    if krw > once {
        return Err(format!(
            "직원은 한 번에 {unit}{once:.0} 까지 환불할 수 있습니다. 이 건은 사장님께 부탁하세요."
        ));
    }

    let d = today(now_unix);
    let used = {
        let g = STAFF_TODAY.lock().map_err(|_| "잠금 실패")?;
        if g.0 == d { g.1 } else { 0.0 }
    };
    if used + krw > per_day {
        return Err(format!(
            "오늘 직원 환불 한도({unit}{per_day:.0})를 넘습니다. 지금까지 {unit}{used:.0} 나갔습니다."
        ));
    }

    let rate = crate::price::rvn_rate(crate::shop::currency())
        .await
        .ok()
        .and_then(|r| r["rate"].as_f64())
        .filter(|r| *r > 0.0)
        .ok_or_else(|| "시세를 읽지 못해 환불을 멈췄습니다. 사장님께 부탁하세요.".to_string())?;
    let rvn = (krw / rate * 1e8).round() / 1e8;

    let out = refund(to_address.clone(), rvn, reason.clone(), passphrase).await?;

    // 성공한 뒤에 센다. 실패한 환불이 한도를 갉아먹으면, 직원은 되지도 않은
    // 일로 남은 하루를 못 쓴다.
    if let Ok(mut g) = STAFF_TODAY.lock() {
        *g = (d, used + krw);
    }

    // 나간 돈도 장부에 남는다. 매출만 적고 환불을 빼먹으면 합계가 실제보다
    // 크게 잡히고, 그건 세금을 더 내는 쪽으로 틀리는 실수다.
    let _ = crate::ledger::record_refund(
        &to_address,
        krw,
        &crate::shop::currency(),
        rvn,
        rate,
        &reason,
        out.get("txid").and_then(|v| v.as_str()).unwrap_or(""),
        now_unix,
    );

    Ok(json!({
        "result": out,
        "amount": krw,
        "currency": cur,
        "symbol": unit,
        "rvn": rvn,
        "left": (per_day - used - krw).max(0.0),
        // 화면이 아직 읽는 옛 이름.
        "krw": krw,
        "left_krw": (per_day - used - krw).max(0.0),
        "notify_owner": true,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_day_rolls_over_at_midnight_utc() {
        let noon = 1_787_100_000_i64;
        assert_eq!(today(noon), today(noon + 3_600));
        // 하루가 지나면 한도가 새로 열려야 한다. 안 그러면 어제 쓴 만큼
        // 오늘 아침에 환불을 못 한다.
        assert_ne!(today(noon), today(noon + 86_400));
    }

    #[test]
    fn one_refund_can_never_exceed_the_day() {
        // 1건 한도가 하루 한도보다 크면 한 번에 하루치를 넘길 수 있다.
        assert!(STAFF_ONCE_USD <= STAFF_DAY_USD);
        // 그리고 하루에 최소 두 번은 되어야 쓸모가 있다 — 커피숍에서 환불이
        // 하루 한 번뿐이면 두 번째 손님은 사장을 기다린다.
        assert!(STAFF_DAY_USD >= STAFF_ONCE_USD * 2.0);
    }

    #[test]
    fn limits_stay_readable_in_every_currency() {
        // 환산한 한도가 33,152 같은 숫자로 나오면 아무도 못 외운다. 그리고
        // 반올림이 순서를 뒤집으면 1건 한도가 하루 한도를 넘을 수 있다.
        for fx in [1.0, 1_380.0, 155.0, 7.2, 0.92, 0.0079] {
            let once = round_limit(STAFF_ONCE_USD * fx);
            let day = round_limit(STAFF_DAY_USD * fx);
            assert!(once > 0.0 && day > 0.0, "fx {fx} 에서 한도가 0 이 됐습니다");
            assert!(once <= day, "fx {fx}: 1건 {once} 가 하루 {day} 보다 큽니다");
        }
    }

    #[test]
    fn unknown_rate_closes_staff_refunds_outside_won() {
        // 원화 가게만 원화 기본값. 다른 나라 가게에 원화 숫자를 한도로 주면
        // 3만 유로·3만 달러가 열린다.
        assert_eq!(limits_from_fx("KRW", None), (30_000.0, 100_000.0, "KRW".into()));
        for cur in ["EUR", "JPY", "GBP", "THB", "VND"] {
            let (once, day, c) = limits_from_fx(cur, None);
            assert_eq!((once, day), (0.0, 0.0), "{cur}");
            assert_eq!(c, cur);
            assert_eq!(limits_from_fx(cur, Some(0.0)).0, 0.0, "{cur}: 0 환율");
            assert_eq!(limits_from_fx(cur, Some(f64::NAN)).0, 0.0, "{cur}: NaN 환율");
        }
        let (once, day, c) = limits_from_fx("JPY", Some(155.0));
        assert!(once > 0.0 && once <= day && c == "JPY");
    }

    /// 레이븐 4.8 `listsinceblock <hash> 1 true` 의 모양 그대로(rpcwallet.cpp
    /// ListTransactions · WalletTxToJSON). 주소·거래 번호는 누가 봐도 가짜다.
    fn since_fixture(now: i64) -> Value {
        let tx = |c: char| c.to_string().repeat(64);
        json!({
            "transactions": [
                { "account": "", "address": "RTestSomeoneElseXXXXXXXXXXXXXXXXXX", "category": "send",
                  "amount": -12.5, "vout": 0, "fee": -0.0226, "confirmations": 3,
                  "blockhash": "00".repeat(32), "blockindex": 4, "blocktime": now - 300,
                  "txid": tx('a'), "walletconflicts": [], "time": now - 320, "timereceived": now - 320,
                  "bip125-replaceable": "no", "abandoned": false },
                { "account": "", "address": "RTestMyOwnReceiveXXXXXXXXXXXXXXXXX", "category": "receive",
                  "amount": 3.0, "label": "", "vout": 1, "confirmations": 3,
                  "blockhash": "00".repeat(32), "blockindex": 5, "blocktime": now - 300,
                  "txid": tx('b'), "walletconflicts": [], "time": now - 320, "timereceived": now - 320,
                  "bip125-replaceable": "no" }
            ],
            "asset_transactions": [
                // 🔴 주인 표가 남의 주소로 나갔다 — 이게 이 목록의 존재 이유다.
                { "asset_type": "transfer_asset", "asset_name": "TESTBRAND!", "amount": 1.0, "message": "",
                  "destination": "RTestThiefAddressXXXXXXXXXXXXXXXXX", "vout": 1, "category": "send",
                  "confirmations": 0, "trusted": true, "txid": tx('c'), "walletconflicts": [],
                  "time": now - 60, "timereceived": now - 60, "bip125-replaceable": "no", "abandoned": false },
                // 우리가 보낸 자산 — 빼야 한다.
                { "asset_type": "transfer_asset", "asset_name": "TESTBRAND/TICKET", "amount": 2.0, "message": "",
                  "destination": "RTestCustomerXXXXXXXXXXXXXXXXXXXXX", "vout": 0, "category": "send",
                  "confirmations": 1, "blockhash": "00".repeat(32), "blockindex": 2, "blocktime": now - 100,
                  "txid": tx('d'), "walletconflicts": [], "time": now - 100, "timereceived": now - 100,
                  "bip125-replaceable": "no", "abandoned": false },
                // 받은 자산은 출금이 아니다.
                { "asset_type": "transfer_asset", "asset_name": "GIFT", "amount": 5.0, "message": "",
                  "destination": "RTestMyOwnReceiveXXXXXXXXXXXXXXXXX", "vout": 0, "category": "receive",
                  "confirmations": 1, "txid": tx('e'), "walletconflicts": [], "time": now - 50,
                  "timereceived": now - 50, "bip125-replaceable": "no", "abandoned": false },
                // 창 밖(오래전) — 시각으로 거른다.
                { "asset_type": "transfer_asset", "asset_name": "OLDBRAND!", "amount": 1.0, "message": "",
                  "destination": "RTestLongAgoXXXXXXXXXXXXXXXXXXXXXX", "vout": 1, "category": "send",
                  "confirmations": 900, "txid": tx('f'), "walletconflicts": [], "time": now - 90_000,
                  "timereceived": now - 90_000, "bip125-replaceable": "no", "abandoned": false }
            ],
            "removed": [],
            "assets_removed": [],
            "lastblock": "00".repeat(32)
        })
    }

    #[test]
    fn 주인_표가_나가면_경보한다() {
        let now = 1_787_100_000_i64;
        let ours: HashSet<String> = ["d".repeat(64)].into_iter().collect();
        let got = spends_not_ours(&since_fixture(now), now - 24 * 3600, &ours).unwrap();
        assert_eq!(got.len(), 2, "{got:?}");
        assert_eq!(got[0]["asset"], Value::Null, "RVN 줄");
        assert_eq!(got[0]["amount"], 12.5);
        assert_eq!(got[0]["address"], "RTestSomeoneElseXXXXXXXXXXXXXXXXXX");
        assert_eq!(got[1]["asset"], "TESTBRAND!");
        assert_eq!(got[1]["is_owner_token"], true);
        // 자산 줄의 받는 주소는 destination 에서 온다.
        assert_eq!(got[1]["address"], "RTestThiefAddressXXXXXXXXXXXXXXXXX");
        // 우리가 보낸 것이면 조용하다.
        let ours: HashSet<String> = ["c".repeat(64), "d".repeat(64), "a".repeat(64)].into_iter().collect();
        assert!(spends_not_ours(&since_fixture(now), now - 24 * 3600, &ours).unwrap().is_empty());
    }

    #[test]
    fn 자산_줄을_못_읽으면_없다고_하지_않는다() {
        let mut v = since_fixture(1_787_100_000);
        v.as_object_mut().unwrap().remove("asset_transactions");
        assert!(spends_not_ours(&v, 0, &HashSet::new()).is_err());
        assert!(spends_not_ours(&json!({}), 0, &HashSet::new()).is_err());
    }

    #[test]
    fn 지갑_전체가_아니라_그_시간_앞쯤부터_읽는다() {
        // 24시간 ≈ 1,440블록. 넉넉히 1,830블록 앞.
        assert_eq!(start_height(3_000_000, 24), Some(3_000_000 - 1_830));
        assert_eq!(start_height(100, 24), None, "짧은 체인은 처음부터");
        assert_eq!(start_height(3_000_000, -5), Some(3_000_000 - 30));
        assert!(MAX_WATCH_HOURS <= 24 * 31);
        // 타이머가 부르는 자리에 전체 읽기(`listtransactions`·빈 listsinceblock)가 없다.
        let src = include_str!("refund.rs");
        let i = src.find("pub async fn foreign_spends(").unwrap();
        let body = &src[i..i + src[i..].find("\n}\n").unwrap()];
        assert!(!body.contains("listtransactions"), "자산 줄이 빠지는 명령을 다시 쓰고 있다");
        assert!(body.contains("getblockhash"), "시작 블록을 정해야 한다");
    }

    #[test]
    fn a_shop_that_never_set_a_currency_still_gets_won() {
        // 통화를 정하지 않은 가게가 빈 문자열로 계산에 들어가면, 시세 조회가
        // 실패하면서 환불이 통째로 막힌다.
        let c = crate::shop::currency();
        assert_eq!(c.len(), 3, "통화 코드가 세 글자가 아닙니다: {c}");
    }
}

/// 환불 칸을 미리 채우기 위한 조회.
///
/// ⚠️ **노드를 먼저 묻는다.** 우리 노드가 답하면 아무도 우리가 무엇을
///    조회했는지 모른다. 공개 조회처는 그것을 본다.
#[tauri::command]
pub async fn refund_payer(address: String) -> Result<Value, String> {
    // 주문 주소로 들어온 **첫 거래**를 찾는다. 주문마다 주소가 따로 생기므로
    // 그 주소의 거래는 곧 그 주문의 결제다.
    let txid = match crate::raven::call_rpc(
        "getaddresstxids",
        json!([{ "addresses": [address.clone()] }]),
    )
    .await
    {
        Ok(v) => v
            .as_array()
            .and_then(|a| a.first())
            .and_then(Value::as_str)
            .map(str::to_string),
        Err(_) => None,
    };
    let txid = match txid {
        Some(t) => t,
        None => {
            // 노드에 주소 색인이 없다. 공개 조회처가 거래 목록을 안다.
            let v = crate::publicbook::address(&address).await?;
            match v
                .get("utxos")
                .and_then(Value::as_array)
                .and_then(|a| a.first())
                .and_then(|u| u.get("txid"))
                .and_then(Value::as_str)
            {
                Some(t) => t.to_string(),
                None => return Ok(json!({ "address": null, "source": "찾지 못함" })),
            }
        }
    };
    refund_payer_of_tx(txid).await
}

async fn refund_payer_of_tx(txid: String) -> Result<Value, String> {
    // ① 이 가게 노드에 그 거래가 있으면 거기서 읽는다.
    if let Ok(tx) = crate::raven::call_rpc("getrawtransaction", json!([txid.clone(), 1])).await {
        if let Some(vin) = tx.get("vin").and_then(Value::as_array).and_then(|v| v.first()) {
            let (Some(prev), Some(n)) = (
                vin.get("txid").and_then(Value::as_str),
                vin.get("vout").and_then(Value::as_u64),
            ) else {
                return Ok(json!({ "address": null, "source": "이 가게 노드" }));
            };
            if let Ok(p) = crate::raven::call_rpc("getrawtransaction", json!([prev, 1])).await {
                let a = p
                    .get("vout")
                    .and_then(Value::as_array)
                    .and_then(|v| v.get(n as usize))
                    .and_then(|o| o.get("scriptPubKey"))
                    .and_then(|s| s.get("addresses"))
                    .and_then(Value::as_array)
                    .and_then(|a| a.first())
                    .and_then(Value::as_str);
                if let Some(a) = a {
                    return Ok(json!({ "address": a, "source": "이 가게 노드" }));
                }
            }
        }
    }
    // ② 노드가 못 하면 공개 조회처. 프라이버시를 조금 내주고 답을 얻는다.
    let a = crate::publicbook::payer_of(&txid).await?;
    Ok(json!({ "address": a, "source": "공개 조회처" }))
}
