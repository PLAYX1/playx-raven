//! Messaging.
//!
//! Two different things share this file because they look the same to a user
//! and are nothing alike underneath.
//!
//! ## Broadcast — one way, on the chain, permanent
//!
//! Ravencoin's RIP-5 messaging: the holder of an asset's ownership token
//! (`ASSET!`) publishes a message, and **everyone holding that asset sees it**.
//! Holding the asset is the subscription — give someone a membership token and
//! they are subscribed; they sell it and they are not.
//!
//! Three consequences the UI has to state plainly:
//!
//! - **It is one way.** Nobody can reply on the chain. Presenting it as a
//!   conversation would be a lie.
//! - **It is permanent and public.** The message body lives in IPFS and the
//!   pointer is in a transaction forever. "Sorry, wrong price" cannot be
//!   deleted, only followed by a correction.
//! - **It costs a transaction fee**, paid by the sender, every time.
//!
//! ## Direct — two ways, off the chain, ephemeral
//!
//! IPFS PubSub. Both sides run this app, both run IPFS, and messages pass
//! directly between the two machines with no server and no fee. libp2p handles
//! the NAT traversal that would otherwise make two home computers unreachable.
//!
//! This is for shop-to-shop and artist-to-artist — the wholesale order, the
//! collaboration. It does **not** reach a customer with only a phone, and it
//! keeps nothing: a message sent while the other side is offline is gone.

use crate::raven::call_rpc;
use serde_json::{json, Value};

// ── 온체인 공지 ────────────────────────────────────────────────────────────

/// Channels this wallet can broadcast on — the assets whose ownership token we
/// hold. Anything else, we can receive on but not send.
#[tauri::command]
pub async fn my_channels() -> Result<Value, String> {
    let owned = call_rpc("listmyassets", json!([])).await?;
    let channels: Vec<String> = owned
        .as_object()
        .map(|m| {
            m.keys()
                .filter(|n| n.ends_with('!'))
                .map(|n| n.trim_end_matches('!').to_string())
                .collect()
        })
        .unwrap_or_default();
    Ok(json!({ "channels": channels }))
}

/// Publishes a notice to everyone holding the asset.
///
/// The text is uploaded to IPFS first because the chain carries only a hash.
/// That upload is pinned here, which matters more than it sounds: if the only
/// copy is on this machine and this machine goes away, subscribers see a
/// pointer to nothing.
#[tauri::command]
pub async fn broadcast(
    channel: String,
    title: String,
    body: String,
    image_cid: Option<String>,
) -> Result<Value, String> {
    if title.trim().is_empty() && body.trim().is_empty() {
        return Err("내용이 비어 있습니다.".into());
    }

    // 사진은 **따로 올린 CID 를 가리키기만** 한다. 공지 문서 안에 그림을
    // 통째로 넣으면 그 문서가 몇 MB 가 되고, 공지 목록을 여는 사람은 안 볼
    // 사진까지 전부 받게 된다. 가리키면 볼 때만 받는다.
    let img = image_cid
        .as_deref()
        .map(str::trim)
        .filter(|c| c.starts_with("Qm") && c.len() >= 46);

    let doc = json!({
        "playx_notice": {
            "version": 1,
            "title": title.trim(),
            "body": body.trim(),
            "image": img,
        }
    });
    let bytes = serde_json::to_vec_pretty(&doc).map_err(|e| e.to_string())?;

    let part = reqwest::multipart::Part::bytes(bytes).file_name("notice.json".to_string());
    let form = reqwest::multipart::Form::new().part("file", part);
    let response = reqwest::Client::new()
        // CIDv0: the chain validates a 34-byte hash that re-encodes to `Qm…`,
        // and a CIDv1 does not fit.
        .post("http://127.0.0.1:5001/api/v0/add?pin=true&cid-version=0")
        .multipart(form)
        .timeout(std::time::Duration::from_secs(60))
        .send()
        .await
        .map_err(|e| format!("IPFS에 올리지 못했습니다: {e}"))?;

    let text = response.text().await.map_err(|e| e.to_string())?;
    let cid = text
        .lines()
        .filter_map(|l| serde_json::from_str::<Value>(l).ok())
        .filter_map(|v| v.get("Hash").and_then(Value::as_str).map(str::to_string))
        .next_back()
        .ok_or_else(|| "IPFS가 해시를 돌려주지 않았습니다".to_string())?;

    // `sendmessage` takes the asset name; the node appends `!` itself if the
    // administrator token is what is needed.
    let result = call_rpc("sendmessage", json!([channel, cid])).await?;
    let txid = result
        .as_array()
        .and_then(|a| a.first())
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    crate::refund::remember_ours(&txid);

    Ok(json!({ "txid": txid, "cid": cid }))
}

/// Notices this wallet has received, newest first, with bodies fetched.
#[tauri::command]
pub async fn inbox() -> Result<Value, String> {
    let raw = call_rpc("viewallmessages", json!([])).await?;
    let list = raw.as_array().cloned().unwrap_or_default();

    let mut out = Vec::new();
    for m in list.iter().take(40) {
        let cid = m
            .get("IPFS Hash")
            .or_else(|| m.get("ipfs_hash"))
            .and_then(Value::as_str)
            .unwrap_or("");

        // Fetched from this machine's own gateway. Asking a public gateway
        // would tell it which channels this wallet subscribes to.
        // 이 컴퓨터의 게이트웨이로만 읽는다. 공개 게이트웨이에 물으면 이 지갑이
        // 어떤 채널을 구독하는지 그쪽이 알게 된다.
        let mut body: Option<Value> = None;
        if !cid.is_empty() {
            if let Ok(r) = reqwest::Client::new()
                .get(format!("http://127.0.0.1:8080/ipfs/{cid}"))
                .timeout(std::time::Duration::from_secs(12))
                .send()
                .await
            {
                body = r.json::<Value>().await.ok();
            }
        }

        out.push(json!({
            "channel": m.get("Asset Name").or_else(|| m.get("asset_name")),
            "cid": cid,
            "time": m.get("Time").or_else(|| m.get("time")),
            "expires": m.get("Expire Time").or_else(|| m.get("expire_time")),
            "notice": body,
        }));
    }
    Ok(json!({ "messages": out }))
}

/// Subscribes to a channel we do not own, so its notices arrive.
#[tauri::command]
pub async fn subscribe(channel: String) -> Result<(), String> {
    call_rpc("subscribetochannel", json!([format!("{channel}!")])).await?;
    Ok(())
}

// ── 노드끼리 직접 ──────────────────────────────────────────────────────────

const IPFS_API: &str = "http://127.0.0.1:5001/api/v0";

/// Is PubSub switched on?
///
/// Off by default in kubo, and turning it on needs a daemon restart — which the
/// owner has to do, since this app does not manage their IPFS process. So this
/// reports the state and the UI explains the one command, rather than failing
/// with a raw error from the API.
#[tauri::command]
pub async fn pubsub_ready() -> Value {
    let ok = reqwest::Client::new()
        .post(format!("{IPFS_API}/pubsub/ls"))
        .timeout(std::time::Duration::from_secs(8))
        .send()
        .await
        .ok();

    match ok {
        Some(r) => {
            let text = r.text().await.unwrap_or_default();
            let enabled = !text.contains("experimental pubsub feature not enabled");
            json!({
                "ready": enabled,
                "how": if enabled { "" } else {
                    "IPFS를 --enable-pubsub-experiment 로 다시 시작하면 켜집니다."
                },
            })
        }
        None => json!({ "ready": false, "how": "IPFS가 꺼져 있습니다." }),
    }
}

/// Sends a message to a topic. Anyone subscribed to it receives it.
///
/// The topic is a shared secret in practice — anybody who knows the string can
/// listen. So the UI must not present this as private, and the topic should be
/// something the two parties agreed on, not a guessable name.
#[tauri::command]
pub async fn pubsub_send(topic: String, from: String, text: String) -> Result<(), String> {
    if text.trim().is_empty() {
        return Err("내용이 비어 있습니다.".into());
    }
    let payload = json!({ "from": from, "text": text.trim() }).to_string();

    let part = reqwest::multipart::Part::text(payload);
    let form = reqwest::multipart::Form::new().part("file", part);
    let response = reqwest::Client::new()
        .post(format!("{IPFS_API}/pubsub/pub?arg={}", urlencode(&topic)))
        .multipart(form)
        .timeout(std::time::Duration::from_secs(20))
        .send()
        .await
        .map_err(|e| format!("보내지 못했습니다: {e}"))?;

    if !response.status().is_success() {
        return Err(format!("IPFS가 거부했습니다: {}", response.status()));
    }
    Ok(())
}

use crate::tunnel::urlencode;

/// 이 가게가 보낸 공지. **손님 폰이 부르는 자리다.**
///
/// 🔴 `inbox` 와 다르다. `inbox` 는 *이 지갑이 받은* 것이고, 손님이 봐야 할
/// 것은 *이 가게가 보낸* 것이다. 그 길이 없어서 공지는 만들어 놓고 아무도
/// 못 봤다 — 사장은 보냈다고 여기고 손님은 온 적이 없다.
///
/// `listassetmessages` 가 없는 노드도 있어서, 없으면 `viewallmessages` 에서
/// 이 가게 채널만 골라 낸다. 어느 쪽이든 답은 같은 모양이다.
///
/// ⚠️ 손님 폰도 부르는 경로라 **가게 것만** 준다. 이 지갑이 구독한 남의
/// 채널이 섞이면 그건 사장의 관심사가 손님에게 새는 것이다.
pub async fn shop_notices(owner_asset: String) -> Result<Value, String> {
    let root = owner_asset.trim().trim_end_matches('!').to_uppercase();
    if root.is_empty() {
        return Ok(json!({ "notices": [] }));
    }

    let raw = call_rpc("viewallmessages", json!([])).await.unwrap_or(json!([]));
    let list = raw.as_array().cloned().unwrap_or_default();

    let mut out = Vec::new();
    for m in list.iter() {
        let ch = m
            .get("Asset Name")
            .or_else(|| m.get("asset_name"))
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_uppercase();
        // 이 가게 채널만. `SHOP!`·`SHOP~공지` 처럼 뿌리가 같은 것을 받는다.
        let mine = ch == root
            || ch == format!("{root}!")
            || ch.starts_with(&format!("{root}~"))
            || ch.starts_with(&format!("{root}/"));
        if !mine {
            continue;
        }

        let cid = m
            .get("IPFS Hash")
            .or_else(|| m.get("ipfs_hash"))
            .and_then(Value::as_str)
            .unwrap_or("");
        let mut body: Option<Value> = None;
        if !cid.is_empty() {
            if let Ok(r) = reqwest::Client::new()
                .get(format!("http://127.0.0.1:8080/ipfs/{cid}"))
                .timeout(std::time::Duration::from_secs(10))
                .send()
                .await
            {
                body = r.json::<Value>().await.ok();
            }
        }
        // 본문을 못 읽었으면 넣지 않는다. 제목 없는 빈 칸이 뜨면 손님은
        // 고장으로 읽는다.
        let Some(b) = body else { continue };
        let n = b.get("playx_notice").unwrap_or(&b);
        out.push(json!({
            "title": n.get("title").and_then(Value::as_str).unwrap_or(""),
            "body": n.get("body").and_then(Value::as_str).unwrap_or(""),
            "image": n.get("image").and_then(Value::as_str).unwrap_or(""),
            "time": m.get("Time").or_else(|| m.get("time")),
        }));
        if out.len() >= 10 {
            break;
        }
    }
    Ok(json!({ "notices": out }))
}
