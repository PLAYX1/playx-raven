//! Public, non-signing chain adapter used by RavenVault PWA. No arbitrary RPC,
//! wallet calls, keys, remote index fallback, node startup, or tunnel startup.
use axum::{
    extract::{Query, Request},
    http::{HeaderValue, Method, StatusCode},
    middleware::Next,
    response::{IntoResponse, Response},
    routing::get,
    Json, Router,
};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, HashSet},
    future::Future,
    pin::Pin,
    sync::OnceLock,
};

mod network;
mod phone;
#[tauri::command]
pub(crate) async fn phone_transaction_review(code: String) -> Result<Value, String> {
    phone::phone_transaction_review(code).await
}
#[tauri::command]
pub(crate) async fn phone_transaction_send(
    code: String,
    expected_txid: String,
    confirmed: bool,
) -> Result<Value, String> {
    phone::phone_transaction_send(code, expected_txid, confirmed).await
}

const MAX_COINS: usize = 200;
const MAX_RAW_BYTES: usize = 1_000_000;
const MAX_SAFE: u64 = 9_007_199_254_740_991;
const SOURCE: &str = "RavenVault Desktop";
type Answer = Result<Value, &'static str>;
type RpcFuture<'a> =
    Pin<Box<dyn Future<Output = Result<Value, crate::raven::RpcFailure>> + Send + 'a>>;
trait ChainRpc: Sync {
    fn call<'a>(&'a self, method: &'a str, args: Value) -> RpcFuture<'a>;
}
struct Local;
impl ChainRpc for Local {
    fn call<'a>(&'a self, method: &'a str, args: Value) -> RpcFuture<'a> {
        Box::pin(crate::raven::call_rpc_detailed(method, args))
    }
}
async fn rpc(r: &impl ChainRpc, method: &str, args: Value) -> Answer {
    r.call(method, args).await.map_err(|_| {
        "Start the local node and check its address, asset and transaction indexes, then retry."
    })
}
fn id(s: &str) -> bool {
    s.len() == 64
        && s.bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
fn address(s: &str) -> bool {
    s.len() >= 26
        && s.len() <= 35
        && crate::electrum::base58check(s).is_ok_and(|v| v.len() == 21 && v[0] == 60)
}
fn asset_name(name: &str) -> bool {
    // Preserve legacy metadata for restricted/qualifier/channel assets as well
    // as root/sub/unique. Core remains authoritative about valid asset names.
    !name.is_empty()
        && name.len() <= 64
        && name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._/#!~$-@$%&*()[]{}?:".contains(&b))
}
async fn synced(r: &impl ChainRpc) -> Result<String, &'static str> {
    let v = rpc(r, "getblockchaininfo", json!([])).await?;
    if v["chain"] != "main"
        || v["initialblockdownload"] != false
        || v["blocks"].as_u64().is_none()
        || !id(v["bestblockhash"].as_str().unwrap_or_default())
    {
        return Err("Wait for the mainnet node to finish synchronizing, then refresh.");
    }
    Ok(v["bestblockhash"].as_str().unwrap().to_string())
}
fn txid(raw: &str) -> Result<String, &'static str> {
    if raw.len() < 20 || raw.len() > MAX_RAW_BYTES * 2 || raw.len() % 2 != 0 {
        return Err("Invalid transaction bytes; refresh the chain record.");
    }
    let bytes =
        hex::decode(raw).map_err(|_| "Invalid transaction bytes; refresh the chain record.")?;
    let mut digest = Sha256::digest(Sha256::digest(bytes)).to_vec();
    digest.reverse();
    Ok(hex::encode(digest))
}
struct Reader<'a> {
    bytes: &'a [u8],
    at: usize,
}
impl<'a> Reader<'a> {
    fn take(&mut self, n: usize) -> Result<&'a [u8], &'static str> {
        let end = self
            .at
            .checked_add(n)
            .filter(|end| *end <= self.bytes.len())
            .ok_or("Truncated transaction; refresh the chain record.")?;
        let result = &self.bytes[self.at..end];
        self.at = end;
        Ok(result)
    }
    fn var(&mut self) -> Result<usize, &'static str> {
        let mark = self.take(1)?[0];
        let v = match mark {
            0..=252 => mark as u64,
            253 => u16::from_le_bytes(self.take(2)?.try_into().unwrap()) as u64,
            254 => u32::from_le_bytes(self.take(4)?.try_into().unwrap()) as u64,
            _ => u64::from_le_bytes(self.take(8)?.try_into().unwrap()),
        };
        if (mark == 253 && v < 253)
            || (mark == 254 && v <= u16::MAX as u64)
            || (mark == 255 && v <= u32::MAX as u64)
            || v > 10_000
        {
            return Err("Unsupported transaction size; use the Desktop wallet.");
        }
        Ok(v as usize)
    }
}
fn outputs(raw: &str) -> Result<Vec<(u64, Vec<u8>)>, &'static str> {
    txid(raw)?;
    let bytes = hex::decode(raw).map_err(|_| "Invalid transaction bytes.")?;
    let mut r = Reader {
        bytes: &bytes,
        at: 0,
    };
    r.take(4)?;
    let inputs = r.var()?;
    if inputs == 0 {
        return Err("A transaction needs inputs.");
    }
    for _ in 0..inputs {
        r.take(36)?;
        let size = r.var()?;
        r.take(size)?;
        r.take(4)?;
    }
    let count = r.var()?;
    if count == 0 {
        return Err("A transaction needs outputs.");
    }
    let mut out = Vec::with_capacity(count);
    for _ in 0..count {
        let sats = u64::from_le_bytes(r.take(8)?.try_into().unwrap());
        if sats > MAX_SAFE {
            return Err("Transaction amount exceeds the supported range.");
        }
        let size = r.var()?;
        out.push((sats, r.take(size)?.to_vec()));
    }
    r.take(4)?;
    if r.at != bytes.len() {
        return Err("Unexpected transaction bytes; refresh the chain record.");
    }
    Ok(out)
}
fn base58_address(payload: &[u8]) -> String {
    const ALPHABET: &[u8] = b"123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
    let mut bytes = vec![60];
    bytes.extend_from_slice(payload);
    let hash = Sha256::digest(Sha256::digest(&bytes));
    bytes.extend_from_slice(&hash[..4]);
    let mut digits = vec![0u8];
    for b in bytes {
        let mut carry = b as u32;
        for d in &mut digits {
            carry += *d as u32 * 256;
            *d = (carry % 58) as u8;
            carry /= 58;
        }
        while carry > 0 {
            digits.push((carry % 58) as u8);
            carry /= 58;
        }
    }
    digits
        .into_iter()
        .rev()
        .map(|d| ALPHABET[d as usize] as char)
        .collect()
}
fn script_asset(script: &[u8]) -> Result<Option<(String, f64)>, &'static str> {
    let bad = "Unsupported previous output; use the Desktop wallet for this asset type.";
    if script.len() < 25 || script[..3] != [0x76, 0xa9, 0x14] || script[23..25] != [0x88, 0xac] {
        return Err(bad);
    }
    if script.len() == 25 {
        return Ok(None);
    }
    if script.len() < 32 || script[25] != 0xc0 || script.last() != Some(&0x75) {
        return Err(bad);
    }
    let mut at = 27;
    let mut size = script[26] as usize;
    if size == 0x4c {
        size = script[27] as usize;
        at = 28;
        if size < 0x4c {
            return Err(bad);
        }
    } else if size > 0x4b {
        return Err(bad);
    }
    if at + size != script.len() - 1 || size < 6 {
        return Err(bad);
    }
    let body = &script[at..at + size];
    let kind = &body[..4];
    let count = body[4] as usize;
    if (kind != b"rvnt" && kind != b"rvnq" && kind != b"rvno" && kind != b"rvnr")
        || count == 0
        || count > 31
        || 5 + count > body.len()
    {
        return Err(bad);
    }
    let name = std::str::from_utf8(&body[5..5 + count]).map_err(|_| bad)?;
    if !asset_name(name) {
        return Err(bad);
    }
    at = 5 + count;
    let amount = if kind == b"rvno" {
        if !name.ends_with('!') || at != body.len() {
            return Err(bad);
        }
        1.0
    } else {
        if at + 8 > body.len() {
            return Err(bad);
        }
        let units = u64::from_le_bytes(body[at..at + 8].try_into().unwrap());
        if name.ends_with('!') && units != 100_000_000 {
            return Err(bad);
        }
        units as f64 / 100_000_000.0
    };
    Ok(Some((name.to_string(), amount)))
}
async fn coin(r: &impl ChainRpc, hash: &str, vout: u32) -> Answer {
    let output = rpc(r, "gettxout", json!([hash, vout, true])).await?;
    if output.is_null() {
        return Ok(Value::Null);
    }
    let confirmations = output["confirmations"]
        .as_u64()
        .ok_or("Missing confirmation count; refresh the chain record.")?;
    if confirmations < if output["coinbase"] == true { 100 } else { 1 } {
        return Err("Wait for this output to mature, then refresh.");
    }
    let raw_value = rpc(r, "getrawtransaction", json!([hash, false])).await?;
    let raw = raw_value
        .as_str()
        .ok_or("Previous transaction is unavailable; check the transaction index.")?;
    if txid(raw)? != hash {
        return Err("Previous transaction hash does not match; refresh the chain record.");
    }
    let values = outputs(raw)?;
    let (sats, script) = values
        .get(vout as usize)
        .ok_or("Previous output is missing; refresh the chain record.")?;
    if output["scriptPubKey"]["hex"] != hex::encode(script) {
        return Err("Previous output script does not match; refresh the chain record.");
    }
    let asset = script_asset(script)?;
    let mut value = json!({ "txid": hash, "vout": vout, "address": base58_address(&script[3..23]), "satoshis": sats, "scriptPubKey": hex::encode(script), "confirmations": confirmations, "rawTransaction": raw });
    if let Some((name, amount)) = asset {
        value["assetName"] = json!(name);
        value["assetAmount"] = json!(amount);
    }
    Ok(value)
}
async fn public_coins(r: &impl ChainRpc, addr: &str) -> Answer {
    let tip = synced(r).await?;
    let balances = rpc(
        r,
        "getaddressbalance",
        json!([{ "addresses": [addr] }, true]),
    )
    .await?;
    let balances = balances
        .as_array()
        .filter(|v| v.len() <= MAX_COINS)
        .ok_or("Enable the address and asset indexes, then refresh.")?;
    let mut names = vec!["RVN".to_string()];
    for b in balances {
        let name = b["assetName"]
            .as_str()
            .filter(|v| asset_name(v))
            .ok_or("Invalid asset index response; refresh.")?;
        let balance = b["balance"]
            .as_f64()
            .filter(|v| v.is_finite() && *v >= 0.0)
            .ok_or("Invalid asset index balance; refresh.")?;
        if name != "RVN" && name != "*" && balance > 0.0 && !names.iter().any(|v| v == name) {
            names.push(name.to_string());
        }
        if name == "*" || names.len() > MAX_COINS {
            return Err("Too many assets for one lookup; use the Desktop wallet.");
        }
    }
    let mut values = Vec::new();
    let mut seen = HashSet::new();
    let mut examined = 0;
    let mut bytes = 0;
    for name in names {
        let mut query = json!({ "addresses": [addr] });
        if name != "RVN" {
            query["assetName"] = json!(name);
        }
        let rows = rpc(r, "getaddressutxos", json!([query])).await?;
        let rows = rows
            .as_array()
            .ok_or("Enable the address index, then refresh.")?;
        examined += rows.len();
        if examined > MAX_COINS {
            return Err("Too many inputs for one lookup; use the Desktop wallet.");
        }
        for row in rows {
            let hash = row["txid"]
                .as_str()
                .filter(|v| id(v))
                .ok_or("Invalid index transaction; refresh.")?;
            let vout = row["outputIndex"]
                .as_u64()
                .filter(|v| *v <= u32::MAX as u64)
                .ok_or("Invalid index output; refresh.")? as u32;
            if row["address"] != addr || !seen.insert((hash.to_string(), vout)) {
                return Err("Duplicate or mismatched address index output; refresh.");
            }
            if row
                .get("height")
                .is_some_and(|v| v.as_i64().unwrap_or(0) <= 0)
            {
                continue;
            }
            let value = coin(r, hash, vout).await?;
            if !value.is_null() {
                if value["address"] != addr {
                    return Err("Indexed output belongs to another address; refresh.");
                }
                bytes += value.to_string().len();
                if bytes > 3_800_000 {
                    return Err(
                        "Transaction proofs are too large for one lookup; use the Desktop wallet.",
                    );
                }
                values.push(value);
            }
        }
    }
    if synced(r).await? != tip {
        return Err("A block changed during lookup; refresh again.");
    }
    Ok(json!({ "address": addr, "coins": values }))
}
async fn history(r: &impl ChainRpc, addr: &str) -> Answer {
    let tip = synced(r).await?;
    // true includes asset-only history; a spent asset address must remain used.
    let rows = rpc(r, "getaddresstxids", json!([{ "addresses": [addr] }, true])).await?;
    let rows = rows
        .as_array()
        .filter(|a| a.iter().all(|v| v.as_str().is_some_and(id)))
        .ok_or("Enable the address history index, then retry.")?;
    if synced(r).await? != tip {
        return Err("A block changed during lookup; refresh again.");
    }
    Ok(json!({ "address": addr, "used": !rows.is_empty(), "synced": true }))
}
async fn transaction(r: &impl ChainRpc, hash: &str) -> Answer {
    synced(r).await?;
    let value = match r.call("getrawtransaction", json!([hash, true])).await {
        Ok(v) => v,
        Err(e) if e.code == Some(-5) => Value::Null,
        Err(_) => return Err("Check the local node and transaction index, then retry."),
    };
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64;
    if value.is_null() {
        return Ok(
            json!({ "txid": hash, "state": "unknown", "confirmations": 0, "checkedAt": stamp, "source": SOURCE }),
        );
    }
    if value["txid"] != hash || txid(value["hex"].as_str().unwrap_or_default())? != hash {
        return Err("Transaction hash does not match; refresh.");
    }
    let confirmations = value
        .get("confirmations")
        .unwrap_or(&Value::Null)
        .as_u64()
        .or_else(|| value.get("confirmations").is_none().then_some(0))
        .ok_or("Transaction conflict; recheck the chain.")?;
    if confirmations > 0 && !id(value["blockhash"].as_str().unwrap_or_default()) {
        return Err("Block hash is missing; refresh.");
    }
    let mut answer = json!({ "txid": hash, "state": if confirmations > 0 { "confirmed" } else { "mempool" }, "confirmations": confirmations, "checkedAt": stamp, "source": SOURCE });
    if confirmations > 0 {
        answer["blockhash"] = value["blockhash"].clone();
    }
    Ok(answer)
}
async fn asset(r: &impl ChainRpc, name: &str) -> Answer {
    synced(r).await?;
    let v = rpc(r, "getassetdata", json!([name])).await?;
    if v.is_null() {
        return Ok(v);
    }
    let units = v["units"]
        .as_u64()
        .filter(|u| *u <= 8)
        .ok_or("Asset units unavailable; refresh.")?;
    let amount = v["amount"]
        .as_f64()
        .filter(|u| u.is_finite() && *u >= 0.0)
        .ok_or("Asset amount unavailable; refresh.")?;
    let ipfs = v
        .get("ipfs_hash")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if v["name"] != name
        || ipfs.len() > 80
        || !(v["reissuable"].is_boolean() || v["reissuable"] == 0 || v["reissuable"] == 1)
    {
        return Err("Asset metadata does not match; refresh.");
    }
    Ok(
        json!({ "name": name, "units": units, "amount": amount, "reissuable": v["reissuable"] == true || v["reissuable"] == 1, "ipfs_hash": ipfs }),
    )
}

fn response(value: Answer) -> Response {
    match value {
        Ok(v) => (StatusCode::OK, Json(v)).into_response(),
        Err(message) => (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({ "error": message })),
        )
            .into_response(),
    }
}
fn bad() -> Response {
    (
        StatusCode::BAD_REQUEST,
        Json(json!({ "error": "Check the address, asset name or transaction ID and retry." })),
    )
        .into_response()
}
fn param<'a>(q: &'a HashMap<String, String>, key: &str) -> &'a str {
    q.get(key).map(String::as_str).unwrap_or_default()
}
async fn history_route(Query(q): Query<HashMap<String, String>>) -> Response {
    let a = param(&q, "address");
    if !address(a) {
        return bad();
    }
    response(history(&Local, a).await)
}
async fn coins_route(Query(q): Query<HashMap<String, String>>) -> Response {
    let a = param(&q, "address");
    if !address(a) {
        return bad();
    }
    response(public_coins(&Local, a).await)
}
async fn coin_route(Query(q): Query<HashMap<String, String>>) -> Response {
    let hash = param(&q, "txid");
    let n = param(&q, "vout");
    if !id(hash) || n.is_empty() || !n.bytes().all(|b| b.is_ascii_digit()) {
        return bad();
    }
    let Ok(vout) = n.parse::<u32>() else {
        return bad();
    };
    response(
        async {
            synced(&Local).await?;
            coin(&Local, hash, vout).await
        }
        .await,
    )
}
async fn transaction_route(Query(q): Query<HashMap<String, String>>) -> Response {
    let hash = param(&q, "txid");
    if !id(hash) {
        return bad();
    }
    response(transaction(&Local, hash).await)
}
pub(crate) async fn asset_route(Query(q): Query<HashMap<String, String>>) -> Response {
    let name = param(&q, "name");
    if !asset_name(name) {
        return bad();
    }
    response(asset(&Local, name).await)
}
async fn capabilities() -> Json<Value> {
    Json(
        json!({ "version": 1, "chain": true, "discovery": true, "assets": true, "network": true, "auctions": false }),
    )
}

pub(crate) fn router<S: Clone + Send + Sync + 'static>() -> Router<S> {
    router_with_rpc(std::sync::Arc::new(Local))
}
fn router_with_rpc<S: Clone + Send + Sync + 'static, R: ChainRpc + Send + 'static>(
    r: std::sync::Arc<R>,
) -> Router<S> {
    Router::new()
        .route(
            "/api/network",
            get(move || {
                let r = r.clone();
                async move { response(network::snapshot(&*r).await) }
            }),
        )
        .route("/api/capabilities", get(capabilities))
        .route("/api/chain/history", get(history_route))
        .route("/api/chain/coins", get(coins_route))
        .route("/api/chain/coin", get(coin_route))
        .route("/api/chain/transaction", get(transaction_route))
        .route("/api/chain/asset", get(asset_route))
}

pub(crate) async fn broadcast_hex(raw: String) -> Response {
    if raw.len() > 200_000 || outputs(&raw).is_err() {
        return bad();
    }
    response(broadcast(&Local, &raw).await)
}
// Shared relay path for the phone HTTP adapter and the desktop confirmation action.
async fn broadcast(r: &impl ChainRpc, raw: &str) -> Answer {
    let expected = txid(raw)?;
    synced(r)
        .await
        .map_err(|_| "메인넷 노드의 연결과 동기화 상태를 확인하세요.")?;
    let result = r
        .call("sendrawtransaction", json!([raw]))
        .await
        .map_err(|e| phone::relay_error(&e))?;
    if result != expected {
        return Err("전파 결과를 확인 못 했습니다. 다시 보내기 전에 거래 ID로 확인하세요.");
    }
    Ok(json!({"txid":expected}))
}

fn origin_allowed(origin: &str, host: &str) -> bool {
    if ["https://ravenvault.ex.erci.se", "https://rvn.ex.erci.se"].contains(&origin) {
        return true;
    }
    // Legacy wallet served at a LAN/tunnel URL remains same-origin. No wildcard
    // CORS or credentials grant is added to owner/admin/AI routes.
    let Ok(url) = reqwest::Url::parse(origin) else {
        return false;
    };
    (url.scheme() == "http" || url.scheme() == "https")
        && url.origin().ascii_serialization() == origin
        && origin == format!("{}://{}", url.scheme(), host)
}
pub(crate) async fn browser_boundary(request: Request, next: Next) -> Response {
    let headers = request.headers();
    let origin = headers
        .get("origin")
        .and_then(|v| v.to_str().ok())
        .map(String::from);
    let host = headers
        .get("host")
        .and_then(|v| v.to_str().ok())
        .unwrap_or_default();
    if (headers.contains_key("origin") && origin.is_none())
        || headers.contains_key("authorization")
        || origin.as_ref().is_some_and(|o| !origin_allowed(o, host))
    {
        return (
            StatusCode::FORBIDDEN,
            Json(json!({ "error": "Open RavenVault at its configured origin and retry." })),
        )
            .into_response();
    }
    let mut out = if request.method() == Method::OPTIONS {
        let method = headers
            .get("access-control-request-method")
            .and_then(|v| v.to_str().ok())
            .unwrap_or_default();
        let fields = headers
            .get("access-control-request-headers")
            .and_then(|v| v.to_str().ok())
            .unwrap_or_default();
        if origin.is_none()
            || !["GET", "POST"].contains(&method)
            || fields
                .split(',')
                .any(|s| !s.trim().is_empty() && !s.trim().eq_ignore_ascii_case("content-type"))
        {
            return bad();
        }
        let mut r = StatusCode::NO_CONTENT.into_response();
        r.headers_mut().insert(
            "access-control-allow-methods",
            HeaderValue::from_static("GET, POST, OPTIONS"),
        );
        r.headers_mut().insert(
            "access-control-allow-headers",
            HeaderValue::from_static("content-type"),
        );
        r.headers_mut().insert(
            "access-control-allow-private-network",
            HeaderValue::from_static("true"),
        );
        r
    } else {
        static GATE: OnceLock<tokio::sync::Semaphore> = OnceLock::new();
        let permit = GATE
            .get_or_init(|| tokio::sync::Semaphore::new(8))
            .try_acquire();
        if let Ok(_permit) = permit {
            match tokio::time::timeout(std::time::Duration::from_secs(18), next.run(request)).await
            {
                Ok(r) => r,
                Err(_) => response(Err(
                    "The local node took too long; let it finish synchronizing and retry.",
                )),
            }
        } else {
            (
                StatusCode::TOO_MANY_REQUESTS,
                Json(json!({ "error": "The local node is busy; retry shortly." })),
            )
                .into_response()
        }
    };
    if let Some(origin) = origin {
        if let Ok(value) = HeaderValue::from_str(&origin) {
            out.headers_mut()
                .insert("access-control-allow-origin", value);
        }
    }
    out.headers_mut()
        .insert("vary", HeaderValue::from_static("Origin"));
    out.headers_mut()
        .insert("cache-control", HeaderValue::from_static("no-store"));
    out.headers_mut().insert(
        "x-content-type-options",
        HeaderValue::from_static("nosniff"),
    );
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{
        body::{to_bytes, Body},
        middleware,
    };
    use std::{collections::VecDeque, sync::Mutex};
    use tower::ServiceExt;
    struct Fake(Mutex<VecDeque<(&'static str, Value, Result<Value, crate::raven::RpcFailure>)>>);
    impl Fake {
        fn new(rows: Vec<(&'static str, Value, Value)>) -> Self {
            Self(Mutex::new(
                rows.into_iter().map(|(m, a, v)| (m, a, Ok(v))).collect(),
            ))
        }
        fn done(&self) {
            assert!(
                self.0.lock().unwrap().is_empty(),
                "Every expected RPC must actually be used"
            );
        }
    }
    impl ChainRpc for Fake {
        fn call<'a>(&'a self, method: &'a str, args: Value) -> RpcFuture<'a> {
            Box::pin(async move {
                let (expected, params, answer) = self
                    .0
                    .lock()
                    .unwrap()
                    .pop_front()
                    .expect("Unexpected RPC; fixtures never contact a node");
                assert_eq!(method, expected);
                assert_eq!(args, params);
                answer
            })
        }
    }
    fn chain() -> Value {
        json!({"chain":"main","initialblockdownload":false,"blocks":1000,"bestblockhash":"a".repeat(64)})
    }
    fn script() -> Vec<u8> {
        let mut v = vec![0x76, 0xa9, 0x14];
        v.extend([42; 20]);
        v.extend([0x88, 0xac]);
        v
    }
    fn raw(script: &[u8]) -> String {
        let mut bytes = vec![2, 0, 0, 0, 1];
        bytes.extend([0; 32]);
        bytes.extend([255; 4]);
        bytes.extend([1, 0]);
        bytes.extend([255; 4]);
        bytes.push(1);
        bytes.extend(12345u64.to_le_bytes());
        bytes.push(script.len() as u8);
        bytes.extend(script);
        bytes.extend([0; 4]);
        hex::encode(bytes)
    }
    fn proof(script: &[u8]) -> Value {
        json!({"scriptPubKey":{"hex":hex::encode(script)},"confirmations":10,"coinbase":false})
    }
    #[test]
    fn addresses_scripts_and_transaction_lengths_are_checked() {
        let a = base58_address(&[42; 20]);
        assert!(address(&a));
        assert!(!address(&(a + "0")));
        assert!(!address(&"1".repeat(100_000)));
        let s = script();
        let r = raw(&s);
        assert_eq!(outputs(&r).unwrap(), vec![(12345, s)]);
        assert!(outputs(&(r.clone() + "00")).is_err());
        assert!(outputs(&r[..r.len() - 2]).is_err());
        let mut bytes = hex::decode(r).unwrap();
        bytes[4] = 0;
        assert!(outputs(&hex::encode(bytes)).is_err());
        assert!(asset_name("TEST/SONG#song-v1"));
        assert!(!asset_name("TEST\ngetwalletinfo"));
    }
    #[tokio::test]
    async fn previous_transaction_is_verified_against_actual_bytes() {
        let s = script();
        let raw = raw(&s);
        let hash = txid(&raw).unwrap();
        let fixture = Fake::new(vec![
            ("gettxout", json!([hash, 0, true]), proof(&s)),
            ("getrawtransaction", json!([hash, false]), json!(raw)),
        ]);
        let value = coin(&fixture, &hash, 0).await.unwrap();
        assert_eq!(value["satoshis"], 12345);
        assert_eq!(value["address"], base58_address(&[42; 20]));
        assert!(value.get("assetName").is_none());
        fixture.done();
        let wrong = "b".repeat(64);
        assert_ne!(wrong, hash);
        let bad = Fake::new(vec![
            ("gettxout", json!([wrong, 0, true]), proof(&s)),
            ("getrawtransaction", json!([wrong, false]), json!(raw)),
        ]);
        assert!(
            coin(&bad, &wrong, 0).await.is_err(),
            "A different transaction hash must not be accepted"
        );
        bad.done();
        let mut mismatch = proof(&s);
        mismatch["scriptPubKey"]["hex"] = json!("00");
        let bad = Fake::new(vec![
            ("gettxout", json!([hash, 0, true]), mismatch),
            ("getrawtransaction", json!([hash, false]), json!(raw)),
        ]);
        assert!(coin(&bad, &hash, 0).await.is_err());
        bad.done();
    }
    #[tokio::test]
    async fn spent_and_immature_outputs_are_not_spendable() {
        let hash = "b".repeat(64);
        let spent = Fake::new(vec![("gettxout", json!([hash, 0, true]), Value::Null)]);
        assert!(coin(&spent, &hash, 0).await.unwrap().is_null());
        spent.done();
        let mut immature = proof(&script());
        immature["coinbase"] = json!(true);
        immature["confirmations"] = json!(99);
        let old = Fake::new(vec![("gettxout", json!([hash, 0, true]), immature)]);
        assert!(coin(&old, &hash, 0).await.is_err());
        old.done();
    }
    #[test]
    fn asset_amount_and_owner_right_come_from_the_script() {
        let mut s = script();
        let mut body = b"rvnt".to_vec();
        body.push(4);
        body.extend(b"TEST");
        body.extend(250_000_000u64.to_le_bytes());
        s.extend([0xc0, body.len() as u8]);
        s.extend(body);
        s.push(0x75);
        assert_eq!(script_asset(&s).unwrap(), Some(("TEST".to_string(), 2.5)));
        s.pop();
        assert!(script_asset(&s).is_err());
        let mut s = script();
        let body = b"rvno\x05TEST!";
        s.extend([0xc0, body.len() as u8]);
        s.extend(body);
        s.push(0x75);
        assert_eq!(script_asset(&s).unwrap(), Some(("TEST!".to_string(), 1.0)));
    }
    #[tokio::test]
    async fn asset_only_history_is_used_and_sync_failure_is_not_empty() {
        let a = base58_address(&[42; 20]);
        let f = Fake::new(vec![
            ("getblockchaininfo", json!([]), chain()),
            (
                "getaddresstxids",
                json!([{ "addresses":[a]},true]),
                json!(["b".repeat(64)]),
            ),
            ("getblockchaininfo", json!([]), chain()),
        ]);
        assert_eq!(history(&f, &a).await.unwrap()["used"], true);
        f.done();
        let mut syncing = chain();
        syncing["initialblockdownload"] = json!(true);
        let f = Fake::new(vec![("getblockchaininfo", json!([]), syncing)]);
        assert!(history(&f, &a).await.is_err());
        f.done();
        let mut moved = chain();
        moved["bestblockhash"] = json!("c".repeat(64));
        let f = Fake::new(vec![
            ("getblockchaininfo", json!([]), chain()),
            (
                "getaddresstxids",
                json!([{ "addresses":[a]},true]),
                json!([]),
            ),
            ("getblockchaininfo", json!([]), moved),
        ]);
        assert!(history(&f, &a).await.is_err());
        f.done();
    }
    #[tokio::test]
    async fn indexed_coins_are_bounded_and_bound_to_the_requested_address() {
        let a = base58_address(&[42; 20]);
        let s = script();
        let raw = raw(&s);
        let hash = txid(&raw).unwrap();
        let row = json!({"txid":hash,"outputIndex":0,"address":a,"height":99});
        let f = Fake::new(vec![
            ("getblockchaininfo", json!([]), chain()),
            (
                "getaddressbalance",
                json!([{ "addresses":[a]},true]),
                json!([{ "assetName":"RVN","balance":12345}]),
            ),
            ("getaddressutxos", json!([{ "addresses":[a]}]), json!([row])),
            ("gettxout", json!([hash, 0, true]), proof(&s)),
            ("getrawtransaction", json!([hash, false]), json!(raw)),
            ("getblockchaininfo", json!([]), chain()),
        ]);
        let v = public_coins(&f, &a).await.unwrap();
        assert_eq!(v["coins"][0]["txid"], hash);
        f.done();
        let f = Fake::new(vec![
            ("getblockchaininfo", json!([]), chain()),
            (
                "getaddressbalance",
                json!([{ "addresses":[a]},true]),
                json!([]),
            ),
            (
                "getaddressutxos",
                json!([{ "addresses":[a]}]),
                json!(vec![row; 201]),
            ),
        ]);
        assert!(public_coins(&f, &a).await.is_err());
        f.done();
    }
    #[tokio::test]
    async fn transaction_state_and_complete_asset_metadata_are_public() {
        let s = script();
        let raw = raw(&s);
        let hash = txid(&raw).unwrap();
        let f = Fake::new(vec![
            ("getblockchaininfo", json!([]), chain()),
            (
                "getrawtransaction",
                json!([hash, true]),
                json!({"txid":hash,"hex":raw,"confirmations":3,"blockhash":"b".repeat(64)}),
            ),
        ]);
        let result = transaction(&f, &hash).await.unwrap();
        assert_eq!(result["state"], "confirmed");
        assert_eq!(result["confirmations"], 3);
        f.done();
        let f = Fake::new(vec![
            ("getblockchaininfo", json!([]), chain()),
            (
                "getassetdata",
                json!(["TEST"]),
                json!({"name":"TEST","amount":2.5,"units":1,"reissuable":1,"ipfs_hash":""}),
            ),
        ]);
        let value = asset(&f, "TEST").await.unwrap();
        assert_eq!(value["amount"], 2.5);
        assert_eq!(value["reissuable"], true);
        f.done();
    }
    fn app() -> Router {
        router::<()>().layer(middleware::from_fn(browser_boundary))
    }
    #[tokio::test]
    async fn browser_routes_reject_bad_input_and_only_grant_public_cors() {
        for path in [
            "/api/chain/history?address=wrong",
            "/api/chain/coins?address=wrong",
            "/api/chain/coin?txid=wrong&vout=0",
            "/api/chain/transaction?txid=wrong",
            "/api/chain/asset?name=bad%0Avalue",
        ] {
            let answer = app()
                .oneshot(Request::builder().uri(path).body(Body::empty()).unwrap())
                .await
                .unwrap();
            assert_eq!(answer.status(), StatusCode::BAD_REQUEST, "{path}");
        }
        let answer = app()
            .oneshot(
                Request::builder()
                    .uri("/api/capabilities")
                    .header("origin", "https://ravenvault.ex.erci.se")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(answer.status(), StatusCode::OK);
        assert_eq!(
            answer.headers()["access-control-allow-origin"],
            "https://ravenvault.ex.erci.se"
        );
        assert!(answer
            .headers()
            .get("access-control-allow-credentials")
            .is_none());
        let body: Value =
            serde_json::from_slice(&to_bytes(answer.into_body(), 4096).await.unwrap()).unwrap();
        assert_eq!(body["auctions"], false);
        assert_eq!(body["discovery"], true);
        assert_eq!(body["network"], true);
        let answer = app()
            .oneshot(
                Request::builder()
                    .uri("/api/capabilities")
                    .header("origin", "https://attacker.example")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(answer.status(), StatusCode::FORBIDDEN);
        let answer = app()
            .oneshot(
                Request::builder()
                    .method("OPTIONS")
                    .uri("/api/chain/coins")
                    .header("origin", "https://ravenvault.ex.erci.se")
                    .header("access-control-request-method", "GET")
                    .header("access-control-request-headers", "content-type")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(answer.status(), StatusCode::NO_CONTENT);
        let answer = app()
            .oneshot(
                Request::builder()
                    .method("OPTIONS")
                    .uri("/api/chain/coins")
                    .header("origin", "https://ravenvault.ex.erci.se")
                    .header("access-control-request-method", "GET")
                    .header("access-control-request-headers", "authorization")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(answer.status(), StatusCode::BAD_REQUEST);
        assert!(!origin_allowed(
            "https://ravenvault.ex.erci.se.evil.test",
            "127.0.0.1:8790"
        ));
        assert!(origin_allowed(
            "http://192.168.1.1:8790",
            "192.168.1.1:8790"
        ));
    }
    #[tokio::test]
    async fn network_route_matches_phone_contract_and_cors_with_mock_rpc() {
        let mut info = chain();
        info["headers"] = json!(1001);
        info["verificationprogress"] = json!(0.99);
        info["initialblockdownload"] = json!(true);
        let f = std::sync::Arc::new(Fake::new(vec![
            ("getblockchaininfo", json!([]), info),
            (
                "getpeerinfo",
                json!([]),
                json!([{"inbound":true,"addr":"1.2.3.4:8767"},{"inbound":false,"addr":"[::1]:8767"},{"inbound":false,"addr":"example.onion:8767"}]),
            ),
            (
                "getmininginfo",
                json!([]),
                json!({"networkhashps":123456.0}),
            ),
        ]));
        let app = router_with_rpc::<(), _>(f.clone()).layer(middleware::from_fn(browser_boundary));
        let answer = app
            .oneshot(
                Request::builder()
                    .uri("/api/network")
                    .header("origin", "https://ravenvault.ex.erci.se")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(answer.status(), StatusCode::OK);
        assert_eq!(
            answer.headers()["access-control-allow-origin"],
            "https://ravenvault.ex.erci.se"
        );
        assert_eq!(answer.headers()["cache-control"], "no-store");
        let body: Value =
            serde_json::from_slice(&to_bytes(answer.into_body(), 4096).await.unwrap()).unwrap();
        if let Ok(folder) = std::env::var("RV_DESKTOP_UX_ARTIFACTS") {
            std::fs::write(
                std::path::Path::new(&folder).join("network-snapshot.json"),
                serde_json::to_string_pretty(&body).unwrap(),
            )
            .unwrap();
        }
        assert_eq!(body["version"], 1);
        assert_eq!(body["scope"], "local-node-peers");
        assert_eq!(body["height"], 1000);
        assert_eq!(body["headers"], 1001);
        assert_eq!(body["syncing"], true);
        assert_eq!(body["progress"], 0.99);
        assert_eq!(body["hashrate"], 123456.0);
        assert_eq!(body["peers"]["total"], 3);
        assert_eq!(body["peers"]["inbound"], 1);
        assert_eq!(body["peers"]["outbound"], 2);
        assert_eq!(
            body["peers"]["transports"],
            json!([{"network":"ipv4","count":1},{"network":"ipv6","count":1},{"network":"onion","count":1}])
        );
        assert!(body["observedAt"].as_u64().unwrap() > 0);
        f.done();
    }
    #[tokio::test]
    async fn network_unready_errors_have_json_and_cors_and_other_origins_never_call_rpc() {
        let f = std::sync::Arc::new(Fake(Mutex::new(VecDeque::from([(
            "getblockchaininfo",
            json!([]),
            Err("Synthetic node unavailable".into()),
        )]))));
        let app = router_with_rpc::<(), _>(f.clone()).layer(middleware::from_fn(browser_boundary));
        let answer = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/api/network")
                    .header("origin", "https://attacker.example")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(answer.status(), StatusCode::FORBIDDEN);
        assert!(answer
            .headers()
            .get("access-control-allow-origin")
            .is_none());
        let answer = app
            .oneshot(
                Request::builder()
                    .uri("/api/network")
                    .header("origin", "https://ravenvault.ex.erci.se")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(answer.status(), StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(
            answer.headers()["access-control-allow-origin"],
            "https://ravenvault.ex.erci.se"
        );
        let body: Value =
            serde_json::from_slice(&to_bytes(answer.into_body(), 4096).await.unwrap()).unwrap();
        assert!(body["error"].as_str().unwrap().contains("local node"));
        f.done();
    }
    #[tokio::test]
    async fn network_missing_optional_measurements_are_unknown() {
        let mut info = chain();
        info["headers"] = json!(1000);
        info["verificationprogress"] = json!(1.0);
        let f = Fake::new(vec![
            ("getblockchaininfo", json!([]), info),
            ("getpeerinfo", json!([]), json!([{"addr":"unknown"}])),
            ("getmininginfo", json!([]), json!({})),
        ]);
        let v = network::snapshot(&f).await.unwrap();
        assert!(v["peers"].is_null());
        assert!(v["hashrate"].is_null());
        f.done();
        let f = Fake::new(vec![("getblockchaininfo", json!([]), chain())]);
        assert!(network::snapshot(&f).await.is_err());
        f.done();
    }
    #[test]
    fn desktop_ux_qr_uses_existing_public_url_generator() {
        let svg = crate::server::qr_svg("https://ravenvault.ex.erci.se/wallet/".into()).unwrap();
        assert!(svg.contains("<svg"));
        if let Ok(folder) = std::env::var("RV_DESKTOP_UX_ARTIFACTS") {
            std::fs::write(std::path::Path::new(&folder).join("phone-url-qr.svg"), svg).unwrap();
        }
    }
    #[tokio::test]
    async fn network_is_get_only_and_allows_browser_preflight_without_rpc() {
        let f = std::sync::Arc::new(Fake::new(vec![]));
        let app = router_with_rpc::<(), _>(f.clone()).layer(middleware::from_fn(browser_boundary));
        let preflight = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("OPTIONS")
                    .uri("/api/network")
                    .header("origin", "https://ravenvault.ex.erci.se")
                    .header("access-control-request-method", "GET")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(preflight.status(), StatusCode::NO_CONTENT);
        assert_eq!(
            preflight.headers()["access-control-allow-private-network"],
            "true"
        );
        let denied = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/network")
                    .header("origin", "https://ravenvault.ex.erci.se")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(denied.status(), StatusCode::METHOD_NOT_ALLOWED);
        assert_eq!(
            denied.headers()["access-control-allow-origin"],
            "https://ravenvault.ex.erci.se"
        );
        f.done();
    }
}
