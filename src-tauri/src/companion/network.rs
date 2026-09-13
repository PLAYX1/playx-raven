//! Read-only network snapshot, matching the phone's version-1 validator.
use super::*;

pub(super) async fn snapshot(r: &impl ChainRpc) -> Answer {
    let info = rpc(r, "getblockchaininfo", json!([])).await?;
    let valid = ["main", "test", "regtest"].contains(&info["chain"].as_str().unwrap_or_default())
        && info["blocks"].as_u64().is_some_and(|n| n <= MAX_SAFE)
        && info["headers"]
            .as_u64()
            .is_some_and(|n| n <= MAX_SAFE && n >= info["blocks"].as_u64().unwrap_or(u64::MAX))
        && id(info["bestblockhash"].as_str().unwrap_or_default())
        && info["initialblockdownload"].is_boolean()
        && info["verificationprogress"]
            .as_f64()
            .is_some_and(|n| n.is_finite() && (0.0..=1.0).contains(&n));
    if !valid {
        return Err(
            "The local node returned an incomplete network status; retry when it is ready.",
        );
    }
    // Optional measurements are null when unavailable, never invented zeroes.
    let raw_peers = r.call("getpeerinfo", json!([])).await.ok();
    let mut peers = Value::Null;
    if let Some(rows) = raw_peers
        .as_ref()
        .and_then(Value::as_array)
        .filter(|a| a.len() <= 10000 && a.iter().all(|p| p["inbound"].is_boolean()))
    {
        let mut counts = std::collections::BTreeMap::<&str, usize>::new();
        for peer in rows {
            *counts.entry(transport(peer)).or_default() += 1;
        }
        let inbound = rows.iter().filter(|p| p["inbound"] == true).count();
        peers = json!({"total":rows.len(),"inbound":inbound,"outbound":rows.len()-inbound,
            "transports":counts.into_iter().map(|(network,count)| json!({"network":network,"count":count})).collect::<Vec<_>>()});
    }
    let mining = r.call("getmininginfo", json!([])).await.ok();
    let hashrate = mining
        .as_ref()
        .and_then(|v| v["networkhashps"].as_f64())
        .filter(|n| n.is_finite() && *n >= 0.0);
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64;
    Ok(
        json!({"version":1,"chain":info["chain"],"height":info["blocks"],"headers":info["headers"],
        "bestBlockHash":info["bestblockhash"],"syncing":info["initialblockdownload"],"progress":info["verificationprogress"],
        "hashrate":hashrate,"peers":peers,"observedAt":stamp,"scope":"local-node-peers"}),
    )
}
fn transport(p: &Value) -> &str {
    let explicit = p["network"].as_str().unwrap_or_default();
    if ["ipv4", "ipv6", "onion", "i2p", "unknown"].contains(&explicit) {
        return explicit;
    }
    let addr = p["addr"].as_str().unwrap_or_default();
    let host = addr.rsplit_once(':').map(|(h, _)| h).unwrap_or(addr);
    if host.ends_with(".onion") || addr.ends_with(".onion") {
        "onion"
    } else if host.ends_with(".b32.i2p") || addr.ends_with(".b32.i2p") {
        "i2p"
    } else if addr
        .parse::<std::net::SocketAddr>()
        .is_ok_and(|a| a.is_ipv6())
    {
        "ipv6"
    } else if addr
        .parse::<std::net::SocketAddr>()
        .is_ok_and(|a| a.is_ipv4())
    {
        "ipv4"
    } else {
        "unknown"
    }
}
