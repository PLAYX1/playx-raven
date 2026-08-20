//! IPFS settings, and how the two systems depend on each other.
//!
//! ## The relationship nobody explains
//!
//! A Ravencoin asset stores a 34-byte IPFS hash. That is all it stores — the
//! picture, the document, the metadata are not on the chain and never were.
//! The chain says "this asset points at Qm…", and whether anything is actually
//! there is a separate question with a separate answer.
//!
//! IPFS answers that question, and by default it answers it badly. A node
//! keeps what it has been asked to keep (**pinned**) and treats everything else
//! as cache. Garbage collection then deletes the cache — on this machine, every
//! hour. So an asset whose file was merely *seen* rather than *pinned* points
//! at nothing within the hour, and the owner finds out months later when a
//! buyer asks why the artwork is gone.
//!
//! That is the single most important thing this app does, and it is invisible
//! unless the two sides are shown together: how many assets have files, how
//! many of those files are pinned here, and what the garbage collector is about
//! to remove.
//!
//! ## Why the settings matter
//!
//! - **StorageMax** — when the repo hits this, GC runs harder. Too small and
//!   pinned data has no room; pins are never deleted, so the node just fails to
//!   add new things.
//! - **GCPeriod** — how often unpinned data is swept. Shorter is not safer, it
//!   is only faster to lose what was never pinned.
//! - **ConnMgr HighWater/LowWater** — how many peers. This is the setting that
//!   makes IPFS heavy on an old machine.
//! - **Pubsub** — off by default; needed for node-to-node messaging.

use serde_json::{json, Value};

const API: &str = "http://127.0.0.1:5001/api/v0";

async fn get_cfg(key: &str) -> Option<Value> {
    let v: Value = reqwest::Client::new()
        .post(format!("{API}/config?arg={key}"))
        .timeout(std::time::Duration::from_secs(8))
        .send()
        .await
        .ok()?
        .json()
        .await
        .ok()?;
    v.get("Value").cloned()
}

/// The handful of settings worth exposing, with what each one costs.
#[tauri::command]
pub fn ipfs_options() -> Value {
    json!([
        {
            "key": "Datastore.StorageMax", "label": "저장 한도", "type": "size",
            "what": "IPFS가 이 컴퓨터에서 쓸 수 있는 최대 용량입니다.",
            "cost": "보존한 자산 파일이 여기 들어갑니다. 꽉 차면 새 파일을 못 받습니다.",
            "warn": "보존(핀)한 것은 한도를 넘어도 지워지지 않습니다. 대신 새로 못 받습니다."
        },
        {
            "key": "Datastore.GCPeriod", "label": "정리 주기", "type": "duration",
            "what": "보존하지 않은 파일을 얼마마다 지울지.",
            "cost": "짧게 잡는다고 안전해지지 않습니다. 보존 안 한 것을 더 빨리 잃을 뿐입니다.",
            "warn": "보존한 파일은 이 청소에 걸리지 않습니다."
        },
        {
            "key": "Swarm.ConnMgr.HighWater", "label": "최대 연결", "type": "number",
            "what": "다른 IPFS 노드와 몇 개까지 연결할지.",
            "cost": "오래된 컴퓨터는 낮추세요 (40 정도). 기본은 96입니다.",
            "warn": ""
        },
        {
            "key": "Swarm.ConnMgr.LowWater", "label": "최소 연결", "type": "number",
            "what": "이 아래로 떨어지면 다시 연결을 찾습니다.",
            "cost": "최대의 절반쯤이 적당합니다.",
            "warn": ""
        },
        {
            "key": "Pubsub.Enabled", "label": "노드끼리 대화", "type": "switch",
            "what": "다른 가게와 직접 메시지를 주고받는 기능입니다.",
            "cost": "",
            "warn": "실험 기능입니다. 켜려면 IPFS를 다시 시작해야 합니다."
        }
    ])
}

/// Current values, plus what the repo actually holds.
#[tauri::command]
pub async fn ipfs_config_read() -> Result<Value, String> {
    let mut values = serde_json::Map::new();
    for k in [
        "Datastore.StorageMax",
        "Datastore.GCPeriod",
        "Swarm.ConnMgr.HighWater",
        "Swarm.ConnMgr.LowWater",
        "Pubsub.Enabled",
    ] {
        if let Some(v) = get_cfg(k).await {
            values.insert(k.to_string(), v);
        }
    }

    let stat: Value = reqwest::Client::new()
        .post(format!("{API}/repo/stat"))
        .timeout(std::time::Duration::from_secs(12))
        .send()
        .await
        .map_err(|e| format!("IPFS에 연결하지 못했습니다: {e}"))?
        .json()
        .await
        .map_err(|e| e.to_string())?;

    Ok(json!({
        "values": values,
        "repo_size": stat.get("RepoSize"),
        "storage_max": stat.get("StorageMax"),
        "objects": stat.get("NumObjects"),
    }))
}

/// Writes one setting.
///
/// Values go through `--json` where they are not strings, because kubo stores
/// numbers and booleans as their own types and a quoted `"96"` silently becomes
/// a string the connection manager then ignores.
#[tauri::command]
pub async fn ipfs_config_write(key: String, value: String, is_json: bool) -> Result<(), String> {
    let mut url = format!("{API}/config?arg={}&arg={}", urlenc(&key), urlenc(&value));
    if is_json {
        url.push_str("&json=true");
    }

    let r = reqwest::Client::new()
        .post(url)
        .timeout(std::time::Duration::from_secs(15))
        .send()
        .await
        .map_err(|e| format!("바꾸지 못했습니다: {e}"))?;

    if !r.status().is_success() {
        let body = r.text().await.unwrap_or_default();
        return Err(format!("IPFS가 거부했습니다: {}", body.chars().take(160).collect::<String>()));
    }
    Ok(())
}

/// Applies one of kubo's own profiles.
///
/// `lowpower` is the one that matters here: it cuts connections and background
/// work on an old machine. It does not touch pins, so nothing preserved is at
/// risk — worth saying, because "low power" sounds like it might drop things.
#[tauri::command]
pub async fn ipfs_apply_profile(name: String) -> Result<Value, String> {
    if !["lowpower", "server", "default-networking"].contains(&name.as_str()) {
        return Err("알 수 없는 프로파일입니다.".into());
    }
    let r = reqwest::Client::new()
        .post(format!("{API}/config/profile/apply?arg={}", urlenc(&name)))
        .timeout(std::time::Duration::from_secs(30))
        .send()
        .await
        .map_err(|e| format!("적용하지 못했습니다: {e}"))?;

    if !r.status().is_success() {
        return Err(format!("IPFS가 거부했습니다: {}", r.status()));
    }
    Ok(json!({ "applied": name, "needs_restart": true }))
}

/// How the chain and IPFS line up on this machine.
///
/// This is the number that decides whether an asset survives. The chain will
/// hold the pointer forever; the file behind it lives only as long as somebody
/// keeps it, and by default this node keeps nothing it was not told to keep.
#[tauri::command]
pub async fn chain_ipfs_link() -> Result<Value, String> {
    let assets = crate::raven::list_assets().await.unwrap_or_default();
    let pinned = crate::ipfs::pin_list().await.unwrap_or_default();

    let with_file: Vec<&crate::raven::AssetEntry> =
        assets.iter().filter(|a| a.ipfs_hash.is_some()).collect();
    let kept = with_file
        .iter()
        .filter(|a| pinned.contains(a.ipfs_hash.as_ref().unwrap()))
        .count();
    let at_risk: Vec<String> = with_file
        .iter()
        .filter(|a| !pinned.contains(a.ipfs_hash.as_ref().unwrap()))
        .map(|a| a.name.clone())
        .collect();

    let gc = get_cfg("Datastore.GCPeriod")
        .await
        .and_then(|v| v.as_str().map(str::to_string))
        .unwrap_or_else(|| "알 수 없음".into());

    Ok(json!({
        "assets": assets.len(),
        "with_file": with_file.len(),
        "kept": kept,
        "at_risk": at_risk.len(),
        "at_risk_names": at_risk.iter().take(8).collect::<Vec<_>>(),
        "gc_period": gc,
        // 체인은 가리키기만 하고, 파일을 지키는 것은 이쪽이다. 이 한 문장이
        // 이 앱이 존재하는 이유다.
        "meaning": "체인은 '이 자산이 저 파일을 가리킨다'만 기록합니다. \
                    파일 자체는 누군가 보관해야 남고, 보존하지 않은 것은 \
                    청소 때 이 컴퓨터에서 사라집니다.",
    }))
}

fn urlenc(s: &str) -> String {
    crate::tunnel::urlencode(s)
}
