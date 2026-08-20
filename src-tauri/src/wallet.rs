//! Wallet passphrase.
//!
//! The failure this is designed against is **forgetting**, not theft.
//!
//! A counter PC that gets robbed loses whatever was on it that day, and
//! splitting wallets caps that. A forgotten passphrase has no cap: the coins
//! and every asset behind them are gone permanently, and nobody — not this app,
//! not the Ravencoin developers, not anyone — can recover them. There is no
//! reset, no support line, no seed phrase to fall back on.
//!
//! So encrypting is treated like issuing an asset: an irreversible action that
//! has to be typed through, not a settings toggle. And the app refuses to help
//! anyone forget it — no storing the passphrase, no "remember me", no keeping
//! the wallet open because it is convenient.

use crate::raven::call_rpc;
use serde_json::{json, Value};

/// Is the wallet encrypted, and can it be encrypted right now?
#[tauri::command]
pub async fn encryption_state() -> Result<Value, String> {
    let info = call_rpc("getwalletinfo", json!([])).await?;
    let until = info.get("unlocked_until").and_then(Value::as_i64);

    Ok(json!({
        "encrypted": until.is_some(),
        "unlocked": matches!(until, None | Some(1..)),
        "unlocked_until": until,
    }))
}

/// Encrypts the wallet for the first time. Cannot be undone.
///
/// The node shuts down immediately afterward — that is Bitcoin-derived
/// behaviour this app cannot change, and it means the shop stops until someone
/// starts the node again. Anyone calling this mid-service loses their till.
///
/// Deliberately absent: any way to store, hint at, or recover the passphrase.
/// The moment a passphrase lives anywhere on this machine, encryption has
/// bought nothing, because the machine is exactly what an attacker already has.
#[tauri::command]
pub async fn encrypt_wallet(passphrase: String, confirm: String) -> Result<Value, String> {
    if passphrase != confirm {
        return Err("두 번 입력한 암호가 서로 다릅니다.".into());
    }
    // Not a strength meter — a floor. A shop owner in a hurry types 1111, and a
    // four-character passphrase is not encryption, it is a delay.
    if passphrase.chars().count() < 10 {
        return Err("암호는 10자 이상이어야 합니다. 잊지 않으면서 남이 못 맞출 것으로 정하세요.".into());
    }

    let state = encryption_state().await?;
    if state["encrypted"].as_bool().unwrap_or(false) {
        return Err("이미 암호가 걸려 있습니다. 바꾸려면 '암호 바꾸기'를 쓰세요.".into());
    }

    // encryptwallet answers, then the node exits. A transport error after this
    // point usually means it worked and the connection died with the node — so
    // it must not be reported as a failure the owner might retry.
    match call_rpc("encryptwallet", json!([passphrase])).await {
        Ok(_) | Err(_) => Ok(json!({
            "encrypted": true,
            "node_stopped": true,
        })),
    }
}

/// Changes an existing passphrase. Safe to retry — the old one still works if
/// this fails.
#[tauri::command]
pub async fn change_passphrase(old: String, new: String, confirm: String) -> Result<(), String> {
    if new != confirm {
        return Err("새 암호를 두 번 다르게 입력하셨습니다.".into());
    }
    if new.chars().count() < 10 {
        return Err("암호는 10자 이상이어야 합니다.".into());
    }
    call_rpc("walletpassphrasechange", json!([old, new]))
        .await
        .map_err(|e| {
            if e.contains("incorrect") {
                "지금 쓰는 암호가 맞지 않습니다.".to_string()
            } else {
                e
            }
        })?;
    Ok(())
}

/// Unlocks for a bounded number of seconds.
///
/// Capped at one hour. An owner who wants the wallet open all day is asking for
/// an unencrypted wallet with extra steps, and this refuses to pretend
/// otherwise — if that is what the shop needs, the honest answer is a separate
/// wallet holding only today's stock.
#[tauri::command]
pub async fn unlock_for(passphrase: String, seconds: i64) -> Result<(), String> {
    if !(10..=3600).contains(&seconds) {
        return Err("잠금 해제는 10초에서 1시간 사이만 됩니다.".into());
    }
    call_rpc("walletpassphrase", json!([passphrase, seconds]))
        .await
        .map_err(|e| {
            if e.contains("incorrect") {
                "암호가 맞지 않습니다.".to_string()
            } else {
                e
            }
        })?;
    Ok(())
}

/// Locks immediately.
#[tauri::command]
pub async fn lock_wallet() -> Result<(), String> {
    call_rpc("walletlock", json!([])).await?;
    Ok(())
}
