//! Talks to a local ravend over JSON-RPC.
//!
//! Authentication uses the .cookie file the node writes on startup rather than a
//! username and password in a config file. The cookie is regenerated every run
//! and is readable only by the user, so nothing has to be stored anywhere and
//! there is no credential to leak.

use serde::Deserialize;
use serde_json::{json, Value};
use std::path::PathBuf;

const RPC_URL: &str = "http://127.0.0.1:8766";

/// One asset the wallet holds, with whatever IPFS content it points at.
#[derive(Debug, Clone, serde::Serialize)]
pub struct AssetEntry {
    pub name: String,
    pub amount: f64,
    pub ipfs_hash: Option<String>,
    /// Did this wallet issue it?
    ///
    /// Ravencoin answers this exactly: issuing mints an owner token named
    /// `ASSET!`, and only the issuer holds it. So holding `PLAYX!` means PLAYX
    /// is ours; holding only `PLAYX` means somebody sent it to us. This matters
    /// because anyone can send anything to any address — a wallet fills up with
    /// tokens nobody asked for, and they should not sit in the same list as the
    /// things the owner made.
    pub mine: bool,
    /// The part before the first `/` — what groups a family of assets together.
    pub root: String,
}

fn data_dir() -> PathBuf {
    // Only macOS for now; Windows and Linux use different conventions and are
    // added when those builds happen.
    crate::paths::raven_dir()
}

fn read_cookie() -> Result<String, String> {
    let path = data_dir().join(".cookie");
    std::fs::read_to_string(&path).map_err(|_| {
        format!(
            "Could not read {}. The node is probably not running, or was started \
             without server=1 in raven.conf.",
            path.display()
        )
    })
}

/// Shared JSON-RPC entry point. Public so sibling modules (issue, shop) do not
/// each grow their own copy of the cookie handling.
/// How long to wait for the node before giving up.
///
/// Long enough for the slow honest calls — `listtransactions` on a big wallet,
/// `listassets` with a wide prefix — and short enough that a wedged node shows
/// an error instead of a screen that says "확인 중…" until someone force-quits.
const RPC_TIMEOUT_SECS: u64 = 20;

/// One HTTP client for the whole app.
///
/// `Client::new()` per call built a fresh connection pool every time and threw
/// it away, so nothing was ever reused and every call paid for a new socket.
static CLIENT: std::sync::OnceLock<reqwest::Client> = std::sync::OnceLock::new();

fn client() -> &'static reqwest::Client {
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(RPC_TIMEOUT_SECS))
            .pool_idle_timeout(std::time::Duration::from_secs(90))
            .build()
            .unwrap_or_default()
    })
}

/// Caps how many requests are in flight at once, to the node's own thread count.
static GATE: std::sync::OnceLock<tokio::sync::Semaphore> = std::sync::OnceLock::new();

fn rpc_gate() -> &'static tokio::sync::Semaphore {
    GATE.get_or_init(|| tokio::sync::Semaphore::new(4))
}

pub async fn call_rpc(method: &str, params: Value) -> Result<Value, String> {
    let cookie = read_cookie()?;
    let (user, pass) = cookie
        .split_once(':')
        .ok_or_else(|| "Malformed .cookie file".to_string())?;

    let body = json!({
        "jsonrpc": "1.0",
        "id": "raven-studio",
        "method": method,
        "params": params,
    });

    // 노드는 RPC 스레드 4개, 대기열 16개로 돈다(httpserver.h). 그보다 많이
    // 쏘면 노드가 500으로 버리고, 우리는 그것을 "노드가 죽었다"로 읽는다.
    // 그래서 동시에 4개까지만 보낸다 — 줄 서는 쪽이 우리가 되게 한다.
    let _permit = rpc_gate().acquire().await.map_err(|e| e.to_string())?;

    let response = client()
        .post(RPC_URL)
        .basic_auth(user, Some(pass))
        .json(&body)
        .send()
        .await
        .map_err(|e| {
            if e.is_timeout() {
                // 타임아웃이 없던 시절, 노드가 한 번 늦으면 화면이 "확인 중…"에서
                // 영영 멈췄다. 멈춘 화면은 고장난 화면과 구별되지 않는다.
                format!("노드가 {RPC_TIMEOUT_SECS}초 안에 답하지 않았습니다 ({method}). 따라잡는 중이거나 바쁠 수 있습니다.")
            } else {
                format!("노드에 닿지 못했습니다 ({RPC_URL}): {e}")
            }
        })?;

    let parsed: Value = response
        .json()
        .await
        .map_err(|e| format!("Node returned something that is not JSON: {e}"))?;

    // A JSON-RPC error arrives with HTTP 500 and a populated "error" field, so
    // surface the node's own message instead of a status code.
    if let Some(err) = parsed.get("error") {
        if !err.is_null() {
            let msg = err
                .get("message")
                .and_then(Value::as_str)
                .unwrap_or("unknown error");
            return Err(format!("{method}: {msg}"));
        }
    }

    parsed
        .get("result")
        .cloned()
        .ok_or_else(|| format!("{method}: response had no result"))
}

#[derive(Deserialize)]
struct ChainInfo {
    blocks: u64,
    headers: u64,
    verificationprogress: f64,
    mediantime: Option<i64>,
}

/// Height, sync progress, and whether the node is reachable at all.
#[tauri::command]
pub async fn node_status() -> Result<Value, String> {
    let raw = call_rpc("getblockchaininfo", json!([])).await?;
    let info: ChainInfo =
        serde_json::from_value(raw).map_err(|e| format!("Unexpected chain info: {e}"))?;

    // The tip's timestamp is what actually answers "is this node alive right
    // now" — a height is just a number to anyone who is not a node operator.
    // getblockchaininfo gives a median-of-11 time, which lags a few minutes, so
    // ask the tip itself.
    let tip_time = match call_rpc("getbestblockhash", json!([])).await {
        Ok(hash) => match hash.as_str() {
            Some(h) => call_rpc("getblockheader", json!([h]))
                .await
                .ok()
                .and_then(|hdr| hdr.get("time").and_then(Value::as_i64)),
            None => None,
        },
        Err(_) => None,
    }
    .or(info.mediantime);

    // 🔴 **연결 수를 같이 준다.** 「지금 얼마나 이어져 있나」가 사장이 진짜
    // 묻는 것이다 — 블록 수만 보면 멈춘 노드와 도는 노드를 구별 못 한다.
    // 못 읽어도 나머지는 보여야 하므로 실패는 `null` 이다.
    let peers = call_rpc("getconnectioncount", json!([]))
        .await
        .ok()
        .and_then(|v| v.as_i64());

    Ok(json!({
        "peers": peers,
        "blocks": info.blocks,
        "headers": info.headers,
        "progress": info.verificationprogress,
        "behind": info.headers.saturating_sub(info.blocks),
        "tip_time": tip_time,
        // Treat "within a couple of blocks of the tip" as synced; an exact match
        // flickers every time a new block arrives.
        "synced": info.headers.saturating_sub(info.blocks) <= 2,
    }))
}

/// Every asset the wallet holds, paired with its IPFS hash where there is one.
///
/// listmyassets gives names and amounts but not the IPFS hash, so each asset
/// needs a second lookup. Assets are queried one at a time deliberately —
/// firing 200 concurrent RPCs at a node that is also validating blocks is a
/// good way to make the wallet unresponsive.
#[tauri::command]
pub async fn list_assets() -> Result<Vec<AssetEntry>, String> {
    let owned = call_rpc("listmyassets", json!([])).await?;
    let map = owned
        .as_object()
        .ok_or_else(|| "listmyassets did not return an object".to_string())?;

    // Owner tokens are held like any other asset, so they arrive in the same
    // list. Collect them first, then use them to label everything else.
    let owned_roots: std::collections::HashSet<String> = map
        .keys()
        .filter(|n| n.ends_with('!'))
        .map(|n| n.trim_end_matches('!').to_string())
        .collect();

    let mut out = Vec::with_capacity(map.len());
    for (name, amount) in map {
        // The owner token itself is bookkeeping, not a holding. Showing `PLAYX`
        // and `PLAYX!` as two rows doubles the list and explains nothing.
        if name.ends_with('!') {
            continue;
        }
        let ipfs_hash = match call_rpc("getassetdata", json!([name])).await {
            Ok(data) => data
                .get("ipfs_hash")
                .and_then(Value::as_str)
                .filter(|h| !h.is_empty())
                .map(str::to_string),
            // A missing lookup should not drop the asset from the list — the
            // holding is still real, it just has no content to preserve.
            Err(_) => None,
        };

        // A unique asset PLAYX#tag and a sub-asset PLAYX/MUSIC both belong to
        // the PLAYX family, and both are ours if we hold PLAYX!.
        let root = name
            .split(['/', '#'])
            .next()
            .unwrap_or(&name)
            .trim_start_matches('$')
            .to_string();

        out.push(AssetEntry {
            name: name.clone(),
            amount: amount.as_f64().unwrap_or(0.0),
            ipfs_hash,
            mine: owned_roots.contains(root.as_str()) || owned_roots.contains(name.as_str()),
            root,
        });
    }

    out.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    Ok(out)
}

/// Spendable balance, plus anything still waiting for confirmations.
///
/// Unconfirmed funds are reported separately rather than folded into one number:
/// a shop that treats a zero-confirmation payment as settled is a shop that can
/// be paid with a transaction that never confirms.
#[tauri::command]
pub async fn wallet_balance() -> Result<Value, String> {
    let confirmed = call_rpc("getbalance", json!([])).await?;
    let unconfirmed = call_rpc("getunconfirmedbalance", json!([]))
        .await
        .unwrap_or(json!(0.0));

    Ok(json!({
        "confirmed": confirmed.as_f64().unwrap_or(0.0),
        "unconfirmed": unconfirmed.as_f64().unwrap_or(0.0),
    }))
}

/// Recent wallet activity, newest first.
#[tauri::command]
pub async fn recent_transactions(count: u32) -> Result<Value, String> {
    call_rpc("listtransactions", json!(["*", count, 0, true])).await
}

/// What has arrived at one address, counting only confirmed payments.
///
/// This is how an order gets matched to a payment: each order has its own
/// address, so a balance here means that specific order was paid. `min_conf`
/// is the caller's decision — a coffee can ship on one confirmation, a laptop
/// should not.
#[tauri::command]
pub async fn received_by_address(address: String, min_conf: u32) -> Result<f64, String> {
    let result = call_rpc("getreceivedbyaddress", json!([address, min_conf])).await?;
    Ok(result.as_f64().unwrap_or(0.0))
}

/// Is the wallet encrypted, and is it currently unlocked?
///
/// Automatic sending needs an unlocked wallet, which means the keys are usable
/// by anything running on this machine for as long as it stays open. The UI has
/// to be able to say so plainly, so it needs to know.
#[tauri::command]
pub async fn wallet_lock_state() -> Result<Value, String> {
    let info = call_rpc("getwalletinfo", json!([])).await?;

    // unlocked_until is absent on wallets that were never encrypted, 0 when
    // locked, and a unix timestamp while temporarily unlocked.
    let until = info.get("unlocked_until").and_then(Value::as_i64);
    Ok(json!({
        "encrypted": until.is_some(),
        "unlocked": match until {
            None => true,        // no passphrase set: always spendable
            Some(0) => false,
            Some(_) => true,
        },
        "unlocked_until": until,
    }))
}

/// A fresh address, so each order can be told apart by where the money landed.
///
/// Reusing one address makes two payments of the same amount indistinguishable,
/// which is exactly the case a shop hits on a busy day.
#[tauri::command]
pub async fn new_address(label: String) -> Result<String, String> {
    let result = call_rpc("getnewaddress", json!([label])).await?;
    result
        .as_str()
        .map(str::to_string)
        .ok_or_else(|| "getnewaddress did not return an address".to_string())
}

/// Whether this node can still see the rest of the network, and what that
/// changes.
///
/// ## Why the shop has to be told
///
/// A node with zero peers keeps answering questions. It reports balances, it
/// accepts transactions into its mempool, it looks completely healthy — it just
/// stops learning anything new. So a payment that arrives during an outage is
/// shown as received, and a zero-confirmation sale is accepted, and neither
/// claim can be checked against a network nobody is talking to.
///
/// That is precisely when a double-spend works: broadcast one transaction to
/// the shop's isolated node and a different one to everybody else. So the
/// shop's connection count is not a diagnostic detail, it is a payment rule.
///
/// ## What keeps working, and it is most of it
///
/// Orders, membership scans, the class list, the menu on a customer's phone —
/// all of that is this computer talking to phones on its own Wi-Fi and reading
/// its own files. A shop with a dead internet line can still run a full day of
/// service; it just cannot *settle*.
#[tauri::command]
pub async fn network_state() -> Value {
    let peers = call_rpc("getconnectioncount", json!([]))
        .await
        .ok()
        .and_then(|v| v.as_i64())
        .unwrap_or(0);
    let online = peers > 0;

    json!({
        "peers": peers,
        "online": online,
        // 인터넷이 끊기면 0회 확인은 검증할 방법이 사라진다. 확인 수를 올려도
        // 소용없다 — 블록 자체가 안 온다. 그래서 "기다리세요"가 아니라
        // "현금으로 받으세요"가 맞는 안내다.
        "zero_conf_ok": online,
        "headline": if online {
            format!("{peers}곳과 연결됨")
        } else {
            "인터넷이 끊겼습니다".to_string()
        },
        "still_works": [
            "손님 폰 주문 (가게 와이파이만 있으면 됩니다)",
            "회원권 확인·출입 QR",
            "수업 신청과 대기자",
            "메뉴·사진 보여주기",
        ],
        "stopped": if online { json!([]) } else { json!([
            "받은 돈 확인 — 새 블록이 오지 않습니다",
            "보내기 — 받아 두었다가 인터넷이 돌아오면 나갑니다",
        ]) },
        "advice": if online {
            ""
        } else {
            "인터넷이 돌아올 때까지 큰 금액은 현금으로 받으세요. 소액도 확인이 안 된 상태입니다."
        },
        // 멤풀은 336시간(14일) 보관한다. 그 안에 인터넷이 돌아오면 저절로 나간다.
        "held_hours": 336,
    })
}
