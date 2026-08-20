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

    Ok(json!({ "txid": txid, "amount": amount, "to": to_address }))
}

/// Spends this app did not make.
///
/// Called on a timer while the shop screen is open. Ignores everything we sent,
/// so a busy day of automatic fulfilment produces no noise — an alert that
/// fires forty times on the first night is an alert the owner turns off.
#[tauri::command]
pub async fn foreign_spends(since_hours: i64) -> Result<Value, String> {
    let txs = call_rpc("listtransactions", json!(["*", 200, 0, true])).await?;
    let list = txs.as_array().cloned().unwrap_or_default();

    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    let cutoff = now - since_hours * 3600;

    let ours = OURS.lock().ok().and_then(|g| g.clone()).unwrap_or_default();
    let mut found = Vec::new();

    for tx in &list {
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
        found.push(json!({
            "txid": txid,
            "time": time,
            "address": tx.get("address"),
            "amount": tx.get("amount").and_then(Value::as_f64).map(f64::abs),
            "asset": asset,
            // An ownership token leaving is the worst thing on this list: it
            // hands over the right to mint that asset forever.
            "is_owner_token": asset.map(|a| a.ends_with('!')).unwrap_or(false),
        }));
    }

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
/// 환율이 안 잡히면 한도를 열지 않고 원화 기본값으로 되돌아간다 — 한도를
/// 못 계산했다고 무제한으로 여는 것은 정반대 방향의 실수다.
async fn staff_limits() -> (f64, f64, String) {
    let cur = crate::shop::currency();
    if cur == "USD" {
        return (STAFF_ONCE_USD, STAFF_DAY_USD, cur);
    }
    match crate::price::fiat_per_usd_public(&cur).await {
        Some(fx) => (
            round_limit(STAFF_ONCE_USD * fx),
            round_limit(STAFF_DAY_USD * fx),
            cur,
        ),
        None => (30_000.0, 100_000.0, "KRW".into()),
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
    fn a_shop_that_never_set_a_currency_still_gets_won() {
        // 통화를 정하지 않은 가게가 빈 문자열로 계산에 들어가면, 시세 조회가
        // 실패하면서 환불이 통째로 막힌다.
        let c = crate::shop::currency();
        assert_eq!(c.len(), 3, "통화 코드가 세 글자가 아닙니다: {c}");
    }
}
