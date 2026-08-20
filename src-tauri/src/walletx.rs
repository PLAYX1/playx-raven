//! 코어에는 있는데 우리에게 없던 지갑 기능들.
//!
//! ⚠️ `bumpfee` 는 만들지 않았다. 코어가 직접 답한다 —
//! "bumpfee has been deprecated on the RVN Wallet." 없는 것을 화면에 그리면
//! 눌렀을 때 오류가 나고, 그건 우리 잘못이 아니라 우리 거짓말이 된다.

use crate::raven::call_rpc;
use serde_json::{json, Value};

// ── 주소로 서명하기 ────────────────────────────────────────────────────────
//
// "이 주소가 내 것이다" 를 개인키 없이 증명한다. 거래소에 주소를 등록하거나,
// 분쟁에서 소유를 밝히거나, 남에게 "이 주소로 보내라" 를 확인시킬 때 쓴다.
// 개인키가 밖으로 나가지 않는다는 점이 중요하다 — 서명만 나간다.

#[tauri::command]
pub async fn sign_message(
    address: String,
    message: String,
    passphrase: Option<String>,
) -> Result<Value, String> {
    let a = address.trim();
    if a.is_empty() || message.trim().is_empty() {
        return Err("주소와 문장이 모두 필요합니다.".into());
    }
    let v = call_rpc("validateaddress", json!([a])).await?;
    if !v["ismine"].as_bool().unwrap_or(false) {
        return Err("이 지갑의 주소가 아닙니다. 내 주소로만 서명할 수 있습니다.".into());
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
        call_rpc("walletpassphrase", json!([pass, 20])).await?;
    }
    let sig = call_rpc("signmessage", json!([a, message])).await;
    if locked {
        let _ = call_rpc("walletlock", json!([])).await;
    }
    Ok(json!({ "address": a, "message": message, "signature": sig? }))
}

/// 남이 준 서명을 확인한다. 지갑이 잠겨 있어도 된다 — 개인키가 필요 없다.
#[tauri::command]
pub async fn verify_message(
    address: String,
    signature: String,
    message: String,
) -> Result<Value, String> {
    let ok = call_rpc(
        "verifymessage",
        json!([address.trim(), signature.trim(), message]),
    )
    .await?;
    Ok(json!({ "valid": ok.as_bool().unwrap_or(false) }))
}

// ── 막힌 거래 ──────────────────────────────────────────────────────────────

/// 영영 안 들어가는 거래를 포기한다.
///
/// 🔴 이건 **거래를 취소하지 않는다.** 취소할 방법은 없다 — 체인은 되돌리지
/// 않는다. 이 명령은 "이 거래는 확인 안 될 것 같으니 그 돈을 다시 쓸 수 있게
/// 해 달라" 는 뜻이고, 만에 하나 나중에 그 거래가 확인되면 **두 번 쓴 것이
/// 되어 둘 중 하나가 무효가 된다.** 그래서 화면은 이 말을 그대로 해야 한다.
#[tauri::command]
pub async fn abandon_tx(txid: String) -> Result<Value, String> {
    let t = txid.trim();
    if t.len() != 64 {
        return Err("거래 번호(txid)는 64글자입니다.".into());
    }
    let tx = call_rpc("gettransaction", json!([t])).await?;
    let confs = tx.get("confirmations").and_then(Value::as_i64).unwrap_or(0);
    if confs > 0 {
        return Err(format!(
            "이미 {confs}번 확인된 거래입니다. 확인된 거래는 포기할 수 없습니다."
        ));
    }
    call_rpc("abandontransaction", json!([t])).await?;
    Ok(json!({ "abandoned": true, "txid": t }))
}

/// 거래 하나를 자세히.
#[tauri::command]
pub async fn tx_detail(txid: String) -> Result<Value, String> {
    call_rpc("gettransaction", json!([txid.trim()])).await
}

// ── 수수료 ────────────────────────────────────────────────────────────────

/// 1kB 당 수수료. 올리면 빨리 들어가고 내리면 싸다.
///
/// ⚠️ 이 값은 **다음에 보내는 것부터 전부** 바뀐다. 한 번만 빨리 보내려고
/// 올려 두고 잊으면 그 뒤 모든 거래가 비싸진다. 화면이 지금 값을 늘 보여야 한다.
#[tauri::command]
pub async fn fee_rate_set(per_kb: f64) -> Result<Value, String> {
    if !(0.0..=1.0).contains(&per_kb) {
        return Err("1 RVN/kB 를 넘는 값은 실수로 봅니다.".into());
    }
    call_rpc("settxfee", json!([per_kb])).await?;
    fee_rate_get().await
}

#[tauri::command]
pub async fn fee_rate_get() -> Result<Value, String> {
    let w = call_rpc("getwalletinfo", json!([])).await?;
    let net = call_rpc("getnetworkinfo", json!([])).await.ok();
    Ok(json!({
        "paytxfee": w.get("paytxfee").and_then(Value::as_f64).unwrap_or(0.0),
        "relayfee": net.and_then(|n| n.get("relayfee").and_then(Value::as_f64)).unwrap_or(0.0),
    }))
}

// ── 주소 재고 ─────────────────────────────────────────────────────────────

/// 미리 만들어 둔 주소를 채운다.
///
/// 잠긴 지갑은 **있는 재고만** 쓴다. 다 쓰면 주문 주소 발급이 멈추고, 그때는
/// 카운터에서 결제가 안 된다. 실측: 이 지갑은 998개 남아 있었다.
#[tauri::command]
pub async fn keypool_fill(size: Option<u32>, passphrase: Option<String>) -> Result<Value, String> {
    let locked = matches!(
        call_rpc("getwalletinfo", json!([]))
            .await
            .ok()
            .and_then(|i| i.get("unlocked_until").and_then(Value::as_i64)),
        Some(0)
    );
    if locked {
        let pass = passphrase
            .ok_or_else(|| "채우려면 지갑을 열어야 합니다. 암호가 필요합니다.".to_string())?;
        call_rpc("walletpassphrase", json!([pass, 60])).await?;
    }
    let r = call_rpc("keypoolrefill", json!([size.unwrap_or(1000)])).await;
    if locked {
        let _ = call_rpc("walletlock", json!([])).await;
    }
    r?;
    let w = call_rpc("getwalletinfo", json!([])).await?;
    Ok(json!({ "keypoolsize": w.get("keypoolsize") }))
}

// ── 특정 주소에서 보내기 ───────────────────────────────────────────────────

/// 어느 주소의 돈으로 보낼지 고른다.
///
/// 보통은 지갑이 알아서 고른다. 그런데 매출 주소와 개인 주소를 갈라 두었다면
/// **어느 쪽에서 나갔는지가 세무에서 갈린다.** 거스름돈도 보낸 주소로 돌아온다.
#[tauri::command]
pub async fn send_from(
    from: String,
    to: String,
    amount: f64,
    comment: Option<String>,
    passphrase: Option<String>,
) -> Result<Value, String> {
    if amount <= 0.0 {
        return Err("보낼 금액이 0보다 커야 합니다.".into());
    }
    let v = call_rpc("validateaddress", json!([to.trim()])).await?;
    if !v["isvalid"].as_bool().unwrap_or(false) {
        return Err("받을 주소가 올바르지 않습니다.".into());
    }
    let f = call_rpc("validateaddress", json!([from.trim()])).await?;
    if !f["ismine"].as_bool().unwrap_or(false) {
        return Err("보낼 주소가 이 지갑의 것이 아닙니다.".into());
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
    let r = call_rpc(
        "sendfromaddress",
        json!([from.trim(), to.trim(), amount, comment.unwrap_or_default()]),
    )
    .await;
    if locked {
        let _ = call_rpc("walletlock", json!([])).await;
    }
    Ok(json!({ "txid": r? }))
}

// ── 메시지 채널 ───────────────────────────────────────────────────────────

#[tauri::command]
pub async fn channels_mine() -> Result<Value, String> {
    let v = call_rpc("viewallmessagechannels", json!([])).await?;
    Ok(json!({ "channels": v }))
}

#[tauri::command]
pub async fn channel_leave(channel: String) -> Result<Value, String> {
    call_rpc("unsubscribefromchannel", json!([channel.trim()])).await?;
    Ok(json!({ "left": channel.trim() }))
}

#[cfg(test)]
mod tests {
    /// 포기는 취소가 아니다. 화면이 이걸 "취소" 라고 부르면, 사람은 돈이
    /// 돌아온다고 믿고 상대에게 물건을 안 보낸다.
    #[test]
    fn abandon_is_not_cancel() {
        let src = include_str!("walletx.rs");
        let doc = &src[src.find("pub async fn abandon_tx").unwrap_or(0).saturating_sub(900)..];
        assert!(
            doc.contains("취소하지 않는다"),
            "포기와 취소를 구별하는 설명이 없다",
        );
    }

    /// 폐기된 RPC 를 화면에 그리면 눌렀을 때 오류가 난다. 그건 우리 거짓말이다.
    #[test]
    fn we_do_not_offer_bumpfee() {
        let src = include_str!("walletx.rs");
        assert!(
            !src.contains("\"bumpfee\""),
            "레이븐이 폐기한 bumpfee 를 부르고 있다",
        );
    }
}
