//! Sending RVN and sending assets.
//!
//! These are two different mistakes, so they are two different code paths and
//! two different screens. Sending RVN empties a balance; sending an asset sends
//! *a specific thing*, and picking the wrong one is the failure that matters.
//! Merging them behind a dropdown is how "PLAYX, 50" becomes "RVN, 50".
//!
//! Nothing here confirms anything. These functions answer questions and, when
//! finally told to, send. The deciding happens in the UI, which shows a review
//! screen built from `preview_send` before any of this spends.

use crate::raven::call_rpc;
use serde_json::{json, Value};

/// Is this a real address on this chain, and is it ours?
///
/// The answer is deliberately not rendered as a green tick anywhere. A checksum
/// catches a typo; it cannot catch a valid address belonging to the wrong
/// person, which is the loss that actually happens. Showing "✓ valid address"
/// tells the user the check is finished when the only check that matters —
/// is this the right *person* — has not started.
#[tauri::command]
pub async fn check_address(address: String) -> Result<Value, String> {
    let info = call_rpc("validateaddress", json!([address])).await?;
    Ok(json!({
        "valid": info.get("isvalid").and_then(Value::as_bool).unwrap_or(false),
        // Sending to yourself is not an error, but it is worth saying out loud:
        // it is almost always a misunderstanding of what the screen does.
        "is_mine": info.get("ismine").and_then(Value::as_bool).unwrap_or(false),
    }))
}

/// Have we sent to this address before, and when?
///
/// This is the check that a human can actually perform. "Never sent here" is
/// not an error — every address is new once — but it is the state in which a
/// mistake is possible, so the UI says so rather than staying silent.
#[tauri::command]
pub async fn address_history(address: String) -> Result<Value, String> {
    let txs = call_rpc("listtransactions", json!(["*", 200, 0, true])).await?;
    let list = txs.as_array().cloned().unwrap_or_default();

    let mut count = 0u32;
    let mut last_time: Option<i64> = None;
    let mut last_amount: Option<f64> = None;
    let mut label: Option<String> = None;

    for tx in &list {
        if tx.get("address").and_then(Value::as_str) != Some(address.as_str()) {
            continue;
        }
        if tx.get("category").and_then(Value::as_str) != Some("send") {
            continue;
        }
        count += 1;

        let time = tx.get("time").and_then(Value::as_i64);
        // listtransactions is newest-first, so the first match is the latest,
        // but do not depend on that ordering — compare.
        if time > last_time {
            last_time = time;
            last_amount = tx.get("amount").and_then(Value::as_f64).map(f64::abs);
        }
        if label.is_none() {
            label = tx
                .get("label")
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty())
                .map(str::to_string);
        }
    }

    Ok(json!({
        "known": count > 0,
        "count": count,
        "last_time": last_time,
        "last_amount": last_amount,
        "label": label,
    }))
}

/// Everything the review screen needs, gathered before anything is spent.
///
/// One call rather than three so the review screen cannot render half-built,
/// showing an amount while the "never sent here" warning is still loading.
#[tauri::command]
pub async fn preview_send(
    address: String,
    asset: Option<String>,
    amount: f64,
) -> Result<Value, String> {
    let addr = check_address(address.clone()).await?;
    let history = address_history(address.clone()).await.unwrap_or(json!({}));

    // What is actually available to send, so the review screen can say
    // "you hold 40" instead of letting the node reject it later.
    let held = match &asset {
        Some(name) => call_rpc("listmyassets", json!([name]))
            .await
            .ok()
            .and_then(|v| v.get(name).and_then(Value::as_f64))
            .unwrap_or(0.0),
        None => call_rpc("getbalance", json!([]))
            .await
            .ok()
            .and_then(|v| v.as_f64())
            .unwrap_or(0.0),
    };

    Ok(json!({
        "address": address,
        "asset": asset,
        "amount": amount,
        "valid": addr["valid"],
        "is_mine": addr["is_mine"],
        "history": history,
        "held": held,
        "enough": held >= amount,
        // Asset transfers still burn a little RVN in fees, so a wallet with
        // assets but no RVN cannot move them. Better said here than discovered
        // as a rejection.
        "needs_rvn_for_fee": asset.is_some(),
    }))
}

/// Runs `body` with the wallet unlocked, then locks it again.
///
/// An unlocked wallet is a wallet whose keys are usable by anything running on
/// the machine. On a shop counter that is a room full of people. So the unlock
/// is scoped to the one send that needed it and reversed immediately — not held
/// open "until the app closes", which is the same thing as not having a
/// passphrase at all.
async fn with_unlocked<F, Fut, T>(passphrase: Option<String>, body: F) -> Result<T, String>
where
    F: FnOnce() -> Fut,
    Fut: std::future::Future<Output = Result<T, String>>,
{
    let locked = matches!(
        call_rpc("getwalletinfo", json!([]))
            .await
            .ok()
            .and_then(|i| i.get("unlocked_until").and_then(Value::as_i64)),
        Some(0)
    );

    if !locked {
        return body().await;
    }

    let pass = passphrase.ok_or_else(|| "지갑이 잠겨 있습니다. 암호가 필요합니다.".to_string())?;
    // 30 seconds is enough for one transaction and not enough to be useful to
    // someone who walks up to the counter afterwards.
    call_rpc("walletpassphrase", json!([pass, 30]))
        .await
        .map_err(|e| {
            if e.contains("incorrect") {
                "암호가 맞지 않습니다.".to_string()
            } else {
                e
            }
        })?;

    let result = body().await;

    // Lock again whether or not the send worked. A failed send that leaves the
    // wallet open is worse than the failure.
    let _ = call_rpc("walletlock", json!([])).await;

    result
}

/// Sends an asset. Irreversible once it confirms.
#[tauri::command]
pub async fn send_asset(
    asset: String,
    qty: f64,
    to_address: String,
    passphrase: Option<String>,
) -> Result<String, String> {
    if qty <= 0.0 {
        return Err("수량은 0보다 커야 합니다.".into());
    }
    // 오너 토큰 전송은 그 자산의 발행권을 통째로 넘기는 일이다. 보통 보내기와
    // 같은 버튼으로 나가면 안 된다 — 되돌릴 수 없고, 받은 사람이 무한히 찍는다.
    if asset.ends_with('!') {
        return Err(
            "소유권 토큰은 이 화면에서 보낼 수 없습니다. 넘기면 그 자산의 발행권이 영구히 넘어갑니다."
                .into(),
        );
    }

    // Re-check rather than trusting what the review screen was built from. The
    // two are separated by however long the user spent reading it, and an
    // address can be edited after a preview in a UI that has a bug.
    let addr = check_address(to_address.clone()).await?;
    if !addr["valid"].as_bool().unwrap_or(false) {
        return Err("받는 주소가 올바르지 않습니다.".into());
    }

    with_unlocked(passphrase, || async {
        // transfer "asset_name" qty "to_address" "message" expire_time
        //          "change_address" "asset_change_address"
        let result = call_rpc(
            "transfer",
            json!([asset, qty, to_address, "", 0, "", ""]),
        )
        .await?;

        let txid = result
            .as_array()
            .and_then(|a| a.first())
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        crate::refund::remember_ours(&txid);
        Ok(txid)
    })
    .await
}

/// Sends RVN. Irreversible once it confirms.
///
/// `comment` stays in this wallet and never touches the chain — the node is
/// explicit about that, and so is the UI, because a user who thinks the
/// recipient will read it has been misled about what they sent.
#[tauri::command]
pub async fn send_rvn(
    to_address: String,
    amount: f64,
    comment: Option<String>,
    passphrase: Option<String>,
) -> Result<String, String> {
    if amount <= 0.0 {
        return Err("금액은 0보다 커야 합니다.".into());
    }

    let addr = check_address(to_address.clone()).await?;
    if !addr["valid"].as_bool().unwrap_or(false) {
        return Err("받는 주소가 올바르지 않습니다.".into());
    }

    with_unlocked(passphrase, || async {
        // subtractfeefromamount stays false: the amount typed is the amount
        // that arrives. A shop settling an invoice needs that to be true.
        let result = call_rpc(
            "sendtoaddress",
            json!([to_address, amount, comment.unwrap_or_default(), "", false]),
        )
        .await?;

        let txid = result
            .as_str()
            .map(str::to_string)
            .ok_or_else(|| "sendtoaddress did not return a txid".to_string())?;
        crate::refund::remember_ours(&txid);
        Ok(txid)
    })
    .await
}

/// Hands an asset's ownership to another wallet, on purpose.
///
/// ## Why this is a separate door
///
/// `send_asset` refuses anything ending in `!` — and it should, because an owner
/// token going out with the daily transfers is a shop losing the right to ever
/// reissue. But refusing everywhere is not safety either: the correct advice for
/// a counter machine is to keep the owner token *somewhere else*, and an app
/// that blocks that has told the owner to do something it will not let them do.
///
/// So the normal path stays shut and this one exists, with the friction on the
/// outside: the asset's full name must be typed. Not a checkbox — a checkbox
/// gets clicked. Typing `MUSIC!` is a sentence you cannot say by accident.
#[tauri::command]
pub async fn transfer_ownership(
    asset: String,
    to_address: String,
    typed: String,
    passphrase: Option<String>,
) -> Result<String, String> {
    if !asset.ends_with('!') {
        return Err("소유권 토큰(느낌표로 끝나는 것)만 여기서 넘깁니다.".into());
    }
    if typed.trim() != asset.trim() {
        return Err(format!("확인을 위해 {asset} 를 그대로 입력하세요."));
    }
    let addr = check_address(to_address.clone()).await?;
    if !addr["valid"].as_bool().unwrap_or(false) {
        return Err("받는 주소가 올바르지 않습니다.".into());
    }
    // 내 지갑 주소로 넘기는 것은 옮긴 척만 하는 것이다. 계산대에서 빼는 것이
    // 목적인데 같은 지갑 안에서 도는 것을 성공이라고 말하면 안 된다.
    if addr["is_mine"].as_bool().unwrap_or(false) {
        return Err("이 지갑의 주소입니다. 다른 지갑(코어 지갑이나 개인 지갑)의 주소를 넣으세요.".into());
    }

    with_unlocked(passphrase, || async {
        let r = crate::raven::call_rpc(
            "transfer",
            json!([asset.clone(), 1, to_address.clone(), "", 0, ""]),
        )
        .await?;
        Ok(r.as_array()
            .and_then(|a| a.first())
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string())
    })
    .await
}
