//! Selling assets the shop already holds.
//!
//! ## Why this is not RIP-15
//!
//! Ravencoin has atomic swaps (RIP-15), and on paper they are the right answer:
//! the seller pre-signs an offer, the buyer completes it, and no hot wallet
//! exists to be drained. That is genuinely better — for a counterparty who runs
//! swap-capable software.
//!
//! The customer standing at this counter has a phone wallet. They scan a QR and
//! send. They cannot complete a partial transaction, and telling them to
//! install a desktop trading tool means the sale does not happen. A swap that
//! is safe and unusable loses to a payment that works.
//!
//! So this rides the path customers already use: pay to a per-order address,
//! the shop sends the asset. RIP-15 belongs later, for unattended remote sales,
//! clearly labelled as needing swap-capable software.
//!
//! ## Why it does not send by itself
//!
//! Sending requires an unlocked wallet, and a wallet left unlocked on a counter
//! is a wallet anyone in the room can empty — staff, customers, or any other
//! program on the machine. So the default is: the payment is detected, the shop
//! is told, and a person presses send. Fully automatic exists, but as a choice
//! the owner makes with the consequence written next to it, not as a default
//! they discover later.

use crate::raven::call_rpc;
use serde_json::{json, Value};

/// One thing for sale: an asset, a price, and where the money goes.
#[derive(serde::Deserialize, serde::Serialize, Clone)]
pub struct Offer {
    pub asset: String,
    pub qty: f64,
    /// Price in the shop's currency, converted at order time.
    pub price: f64,
    pub currency: String,
    /// The address customers pay for this offer.
    pub address: String,
}

/// What the shop can actually sell right now.
///
/// Filtered to assets this wallet issued. Reselling something that merely
/// arrived is legitimate, but defaulting to it means a stranger can seed a
/// shop's storefront by sending it tokens — so the owner opts in per asset
/// rather than finding random airdrops listed for sale.
#[tauri::command]
pub async fn sellable_assets() -> Result<Value, String> {
    let all = crate::raven::list_assets().await?;
    // 오너 토큰(`ASSET!`)은 재고가 아니다. 그것을 가진 사람은 그 자산을 무한히
    // 재발행할 수 있고 IPFS 포인터도 바꿀 수 있다. 팔면 카탈로그 자체를 넘기는
    // 것이라, 목록에서 숨기는 정도가 아니라 아예 상품이 될 수 없어야 한다.
    let items: Vec<Value> = all
        .into_iter()
        .filter(|a| a.mine && a.amount > 0.0 && !a.name.ends_with('!'))
        .map(|a| json!({ "name": a.name, "amount": a.amount, "ipfs_hash": a.ipfs_hash }))
        .collect();
    Ok(json!({ "assets": items }))
}

/// Payments waiting to be filled, matched to the offer they paid for.
///
/// Matched by address, never by amount. Two customers buying the same item send
/// identical amounts; a shop that matches on price gives one of them the wrong
/// thing and has no way to tell afterward.
#[tauri::command]
pub async fn pending_sales(offers: Vec<Offer>, min_conf: u32) -> Result<Value, String> {
    let txs = call_rpc("listtransactions", json!(["*", 200, 0, true])).await?;
    let list = txs.as_array().cloned().unwrap_or_default();

    let mut out = Vec::new();
    for tx in list {
        if tx.get("category").and_then(Value::as_str) != Some("receive") {
            continue;
        }
        // An asset transfer arriving at the shop is not a payment for anything.
        if tx.get("asset_name").is_some() {
            continue;
        }
        let addr = tx.get("address").and_then(Value::as_str).unwrap_or("");
        let Some(offer) = offers.iter().find(|o| o.address == addr) else {
            continue;
        };

        let confirmations = tx.get("confirmations").and_then(Value::as_i64).unwrap_or(0);
        out.push(json!({
            "txid": tx.get("txid"),
            "address": addr,
            "paid": tx.get("amount"),
            "time": tx.get("time"),
            "confirmations": confirmations,
            // Below the threshold this is a promise. Handing over an asset for
            // a zero-confirmation payment is handing it over for nothing if the
            // sender replaces the transaction.
            "settled": confirmations >= min_conf as i64,
            "asset": offer.asset,
            "qty": offer.qty,
            "price": offer.price,
            "currency": offer.currency,
        }));
    }

    Ok(json!({ "sales": out }))
}

/// Sends the asset for one paid order.
///
/// Takes the buyer's address explicitly rather than deriving it from the
/// payment. The sending address of a transaction is not reliably the buyer's
/// receiving address — with an exchange or a shared wallet in between, sending
/// there loses the asset. So the buyer states where it should go, and this
/// refuses to guess.
#[tauri::command]
pub async fn fulfil_sale(
    asset: String,
    qty: f64,
    to_address: String,
    passphrase: Option<String>,
) -> Result<String, String> {
    if qty <= 0.0 {
        return Err("수량이 올바르지 않습니다.".into());
    }
    if asset.ends_with('!') {
        return Err("소유권 토큰은 판매로 보낼 수 없습니다. 이것을 넘기면 그 자산을 무한히 발행할 권리가 넘어갑니다.".into());
    }
    let check = crate::send::check_address(to_address.clone()).await?;
    if !check["valid"].as_bool().unwrap_or(false) {
        return Err("받는 주소가 올바르지 않습니다.".into());
    }

    let locked = matches!(
        call_rpc("getwalletinfo", json!([]))
            .await
            .ok()
            .and_then(|i| i.get("unlocked_until").and_then(Value::as_i64)),
        Some(0)
    );
    if locked {
        let pass =
            passphrase.ok_or_else(|| "지갑이 잠겨 있습니다. 암호가 필요합니다.".to_string())?;
        call_rpc("walletpassphrase", json!([pass, 30])).await?;
    }

    let result = call_rpc("transfer", json!([asset, qty, to_address, "", 0, "", ""])).await;

    if locked {
        let _ = call_rpc("walletlock", json!([])).await;
    }

    let txid = result?
        .as_array()
        .and_then(|a| a.first())
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    crate::refund::remember_ours(&txid);
    Ok(txid)
}
