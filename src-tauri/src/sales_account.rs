//! Sales account 100. Secrets never cross IPC; no signing, importing or sending.
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use crate::{identity::hmac_sha512, words::{wipe, wipe_bytes}};
const AUTH_ERROR: &str = "판매 계정을 열지 못했어요. 암호가 설정된 12단어 지갑과 서버 상태를 확인해 주세요.";
const READ_ERROR: &str = "금액을 확인하지 못했어요. 메인넷 동기화와 주소 색인을 확인해 주세요. 확인 실패는 잔액 0이 아니에요.";
static GATE: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
struct Secret<const N: usize>([u8; N]);
impl<const N: usize> Drop for Secret<N> { fn drop(&mut self) { wipe_bytes(&mut self.0); } }
struct Text(String);
impl Drop for Text { fn drop(&mut self) { wipe(&mut self.0); } }
struct SecretJson(Value);
impl Drop for SecretJson { fn drop(&mut self) {
    fn clear(v: &mut Value) { match v {
        Value::String(s) => wipe(s), Value::Array(a) => a.iter_mut().for_each(clear),
        Value::Object(o) => o.values_mut().for_each(clear), _ => {}
    } }
    clear(&mut self.0);
} }

/// Native counterpart of the vendored phone core deriveAccount(seed, 100).
/// Only the account-level public serialization is returned (BIP32 xpub version).
pub(crate) fn account_xpub(seed: &[u8; 64]) -> Option<String> {
    use secp256k1::{PublicKey, SecretKey, Scalar, Secp256k1};
    let secp = Secp256k1::new();
    let mut node = Secret(hmac_sha512(b"Bitcoin seed", &[seed]));
    let mut fingerprint = [0u8; 4];
    for index in [44u32, 175, 100] {
        let key = Secret::<32>(node.0[..32].try_into().ok()?);
        let mut sk = SecretKey::from_byte_array(&key.0).ok()?;
        let public = PublicKey::from_secret_key(&secp, &sk).serialize();
        fingerprint.copy_from_slice(&crate::words::ripemd160(&Sha256::digest(public))[..4]);
        let mut data = Secret([0u8; 37]);
        data.0[1..33].copy_from_slice(&key.0);
        data.0[33..].copy_from_slice(&(index | 0x80000000).to_be_bytes());
        let child = Secret(hmac_sha512(&node.0[32..], &[&data.0]));
        let tweak = Secret::<32>(child.0[..32].try_into().ok()?);
        let scalar = Scalar::from_be_bytes(tweak.0).ok()?;
        let next = sk.add_tweak(&scalar);
        sk.non_secure_erase();
        let mut next = next.ok()?;
        node.0[..32].copy_from_slice(&next.secret_bytes());
        next.non_secure_erase();
        node.0[32..].copy_from_slice(&child.0[32..]);
    }
    let key = Secret::<32>(node.0[..32].try_into().ok()?);
    let mut sk = SecretKey::from_byte_array(&key.0).ok()?;
    let public = PublicKey::from_secret_key(&secp, &sk).serialize();
    sk.non_secure_erase();
    // base58check prepends one byte; remainder includes the final 3 version bytes.
    let mut payload = vec![0x88, 0xb2, 0x1e, 3];
    payload.extend_from_slice(&fingerprint);
    payload.extend_from_slice(&(0x80000000u32 + 100).to_be_bytes());
    payload.extend_from_slice(&node.0[32..]);
    payload.extend_from_slice(&public);
    Some(crate::words::base58check(0x04, &payload))
}

trait SalesRpc {
    async fn call(&self, method: &str, params: Value) -> Result<Value, String>;
}
struct NativeRpc;
impl SalesRpc for NativeRpc {
    async fn call(&self, method: &str, params: Value) -> Result<Value, String> {
        if matches!(method, "walletpassphrase" | "getmywords") {
            crate::raven::sales_secret_rpc(method, params).await
        } else {
            crate::raven::call_rpc(method, params).await
        }
    }
}
#[tauri::command]
pub async fn sales_account_reveal(passphrase: String) -> Result<String, String> {
    let passphrase = Text(passphrase);
    let _gate = GATE.lock().await;
    reveal_with(&NativeRpc, passphrase).await
}
async fn reveal_with(rpc: &impl SalesRpc, passphrase: Text) -> Result<String, String> {
    let state = rpc.call("getwalletinfo", json!([])).await.map_err(|_| AUTH_ERROR)?;
    if state["unlocked_until"].as_i64().is_none() || passphrase.0.is_empty() { return Err(AUTH_ERROR.into()); }
    // Relock even an already-open wallet: an existing unlocked session is not reauthentication.
    rpc.call("walletlock", json!([])).await.map_err(|_| AUTH_ERROR)?;
    let unlock = rpc.call("walletpassphrase", json!([passphrase.0, 20])).await;
    drop(passphrase);
    if unlock.is_err() { let _ = rpc.call("walletlock", json!([])).await; return Err(AUTH_ERROR.into()); }
    let result = async {
        let raw = SecretJson(rpc.call("getmywords", json!([])).await?);
        let phrase = raw.0["word_list"].as_str().ok_or(AUTH_ERROR)?;
        let extra = raw.0["passphrase"].as_str().unwrap_or("");
        // Refuse incompatible Unicode normalization in the existing native BIP39.
        if !extra.is_ascii() { return Err(AUTH_ERROR.to_string()); }
        let checked = crate::words::check(phrase).map_err(|_| AUTH_ERROR)?;
        let seed = Secret(crate::identity::seed_from_words(checked.expose(), extra).ok_or(AUTH_ERROR)?);
        account_xpub(&seed.0).ok_or(AUTH_ERROR.to_string())
    }.await;
    let locked = rpc.call("walletlock", json!([])).await;
    if locked.is_err() { return Err(AUTH_ERROR.into()); }
    result.map_err(|_| AUTH_ERROR.into())
}

fn balance_value(value: &Value) -> Option<u64> {
    let sats = value["balance"].as_u64()?;
    (sats <= 2_100_000_000_000_000_000).then_some(sats)
}
#[tauri::command]
pub async fn sales_account_balance(addresses: Vec<String>) -> Result<Value, String> {
    balance_with(&NativeRpc, addresses).await
}
async fn balance_with(rpc: &impl SalesRpc, addresses: Vec<String>) -> Result<Value, String> {
    if addresses.is_empty() || addresses.len() > 100
        || addresses.iter().collect::<std::collections::HashSet<_>>().len() != addresses.len()
        || addresses.iter().any(|a|
        !(26..=35).contains(&a.len()) || !a.starts_with('R') || !a.bytes().all(|b| b.is_ascii_alphanumeric())) {
        return Err(READ_ERROR.into());
    }
    let info = rpc.call("getblockchaininfo", json!([])).await.map_err(|_| READ_ERROR)?;
    if info["chain"] != "main" || info["initialblockdownload"] != false
        || info["blocks"].as_u64().is_none() || info["blocks"] != info["headers"] {
        return Err(READ_ERROR.into());
    }
    let tip = info["bestblockhash"].as_str().filter(|s| s.len() == 64).ok_or(READ_ERROR)?;
    let value = rpc.call("getaddressbalance", json!([{ "addresses": addresses }]))
        .await.map_err(|_| READ_ERROR)?;
    let sats = balance_value(&value).ok_or(READ_ERROR)?;
    let after = rpc.call("getbestblockhash", json!([])).await.map_err(|_| READ_ERROR)?;
    if after.as_str() != Some(tip) { return Err(READ_ERROR.into()); }
    // Decimal text avoids loss of integer precision in JavaScript.
    Ok(json!({"confirmedSats":sats.to_string(), "checked":addresses.len()}))
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn phone_cross_vectors() {
        let vectors: Value = serde_json::from_str(include_str!("../../scripts/fixtures/sales-public-vectors.json")).unwrap();
        // Existing public BIP39 fixtures are read in memory, never copied to new artifacts.
        let restore: Value = serde_json::from_str(include_str!("../../scripts/fixtures/restore-vectors.json")).unwrap();
        for row in vectors.as_array().unwrap() {
            let source = &restore["vectors"][row["fixtureIndex"].as_u64().unwrap() as usize];
            let seed = Secret(crate::identity::seed_from_words(source["mnemonic"].as_str().unwrap(), source["passphrase"].as_str().unwrap()).unwrap());
            assert!(account_xpub(&seed.0).as_deref() == row["xpub"].as_str(), "phone/native account mismatch");
        }
    }
    struct Mock {
        replies: std::cell::RefCell<std::collections::VecDeque<Result<Value, String>>>,
        calls: std::cell::RefCell<Vec<String>>,
    }
    impl SalesRpc for Mock {
        async fn call(&self, method: &str, params: Value) -> Result<Value, String> {
            let _params = SecretJson(params);
            self.calls.borrow_mut().push(method.into());
            self.replies.borrow_mut().pop_front().expect("unexpected RPC")
        }
    }
    fn mock(replies: Vec<Result<Value,String>>) -> Mock {
        Mock { replies: std::cell::RefCell::new(replies.into()), calls: std::cell::RefCell::new(vec![]) }
    }
    fn input() -> Text { Text(char::from(120).to_string()) }
    #[tokio::test]
    async fn auth_is_required_even_when_unlocked_and_failure_is_sanitized() {
        for until in [0, 9999999999i64] {
            let rpc = mock(vec![Ok(json!({"unlocked_until":until})),Ok(Value::Null),Err("synthetic-node-detail".into()),Ok(Value::Null)]);
            assert!(reveal_with(&rpc,input()).await.err().as_deref() == Some(AUTH_ERROR));
            assert!(*rpc.calls.borrow() == ["getwalletinfo","walletlock","walletpassphrase","walletlock"]);
        }
        let rpc=mock(vec![Ok(json!({}))]);
        assert!(reveal_with(&rpc,input()).await.is_err());
        assert!(rpc.calls.borrow().len()==1);
    }
    #[tokio::test]
    async fn derivation_and_relock_failures_never_disclose() {
        for response in [Err("synthetic-node-detail".into()),Ok(json!({"word_list":"invalid"}))] {
            let rpc=mock(vec![Ok(json!({"unlocked_until":0})),Ok(Value::Null),Ok(Value::Null),response,Ok(Value::Null)]);
            assert!(reveal_with(&rpc,input()).await.err().as_deref()==Some(AUTH_ERROR));
            assert!(rpc.calls.borrow().last().map(String::as_str)==Some("walletlock"));
        }
        let restore: Value=serde_json::from_str(include_str!("../../scripts/fixtures/restore-vectors.json")).unwrap();
        for lock_ok in [true,false] {
            let words=json!({"word_list":restore["vectors"][0]["mnemonic"],"passphrase":restore["vectors"][0]["passphrase"]});
            let rpc=mock(vec![Ok(json!({"unlocked_until":0})),Ok(Value::Null),Ok(Value::Null),Ok(words),if lock_ok {Ok(Value::Null)} else {Err("synthetic-node-detail".into())}]);
            assert!(reveal_with(&rpc,input()).await.is_ok()==lock_ok);
        }
    }
    #[tokio::test]
    async fn balance_requires_synced_stable_tip_and_valid_integer() {
        let fixtures: Value=serde_json::from_str(include_str!("../../scripts/fixtures/sales-public-vectors.json")).unwrap();
        let address=fixtures[0]["addresses"][0]["address"].as_str().unwrap().to_string();
        let tip="a".repeat(64);
        let info=json!({"chain":"main","initialblockdownload":false,"blocks":1,"headers":1,"bestblockhash":tip});
        for (reply,after,ok) in [(json!({"balance":0}),json!(tip),true),(json!({}),json!(tip),false),(json!({"balance":1}),json!("b".repeat(64)),false)] {
            let rpc=mock(vec![Ok(info.clone()),Ok(reply),Ok(after)]);
            assert!(balance_with(&rpc,vec![address.clone()]).await.is_ok()==ok);
            assert!(rpc.calls.borrow().iter().all(|m| ["getblockchaininfo","getaddressbalance","getbestblockhash"].contains(&m.as_str())));
        }
        let rpc=mock(vec![Ok(json!({"chain":"test"}))]);
        assert!(balance_with(&rpc,vec![address.clone()]).await.is_err());
        let rpc=mock(vec![]);
        assert!(balance_with(&rpc,vec![address.clone();101]).await.is_err());
        assert!(balance_with(&rpc,vec![address;2]).await.is_err());
        assert!(rpc.calls.borrow().is_empty());
    }
    #[test]
    fn malformed_balance_is_not_zero() {
        for value in [json!({}), json!({"balance":-1}), json!({"balance":1.5}), json!({"balance":"0"})] {
            assert!(balance_value(&value).is_none());
        }
        assert!(balance_value(&json!({"balance":0})) == Some(0));
    }
}
