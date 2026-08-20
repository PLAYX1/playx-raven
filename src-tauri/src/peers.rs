//! The other machines that are also mine.
//!
//! ## Why a list and not a discovery protocol
//!
//! Two computers running this program need to move assets between them — the
//! laptop issues a release, the counter sells it. Doing that by copying a
//! 34-character address every time is how an asset ends up at an address
//! nobody owns, and there is no undo on a chain.
//!
//! Nodes could find each other over PubSub and exchange addresses automatically.
//! They should not. An address arriving over the network still has to be
//! *believed*, and believing it is exactly the step that must be a person
//! looking at their own screen. So: register once, deliberately, and after that
//! send by name.
//!
//! ## What this refuses
//!
//! An address belonging to this same wallet. Sending assets to yourself and
//! calling it "moved to the shop" is the same failure as a sweep that pays into
//! its own pocket — it looks done and nothing happened.

use serde_json::{json, Value};
use std::path::PathBuf;

fn store() -> PathBuf {
    let home = std::env::var("HOME").unwrap_or_default();
    PathBuf::from(home).join("Library/Application Support/PlayXRaven/peers.json")
}

fn load() -> Vec<Value> {
    std::fs::read_to_string(store())
        .ok()
        .and_then(|t| serde_json::from_str::<Value>(&t).ok())
        .and_then(|v| v.get("peers").and_then(Value::as_array).cloned())
        .unwrap_or_default()
}

fn save(rows: &[Value]) -> Result<(), String> {
    let path = store();
    if let Some(d) = path.parent() {
        let _ = std::fs::create_dir_all(d);
    }
    let tmp = path.with_extension("json.tmp");
    std::fs::write(
        &tmp,
        serde_json::to_vec_pretty(&json!({ "peers": rows })).map_err(|e| e.to_string())?,
    )
    .map_err(|e| format!("저장하지 못했습니다: {e}"))?;
    std::fs::rename(&tmp, &path).map_err(|e| format!("저장하지 못했습니다: {e}"))
}

/// Every machine registered here.
#[tauri::command]
pub fn peer_list() -> Value {
    json!({ "peers": load() })
}

/// Registers another machine by the address it wants to receive on.
///
/// The address is checked against the chain's own validator and against this
/// wallet. Both matter: a typo produces a valid-looking string that nobody can
/// spend from, and an address of our own produces a transfer that succeeds and
/// achieves nothing.
#[tauri::command]
pub async fn peer_add(name: String, address: String, note: String, now_unix: i64) -> Result<Value, String> {
    let name = name.trim().to_string();
    if name.is_empty() {
        return Err("이름이 필요합니다 — 강남지점, 매장 계산대처럼요.".into());
    }

    let check = crate::send::check_address(address.trim().to_string()).await?;
    if !check["valid"].as_bool().unwrap_or(false) {
        return Err("주소가 올바르지 않습니다. 한 글자만 틀려도 자산이 사라집니다.".into());
    }
    if check["is_mine"].as_bool().unwrap_or(false) {
        return Err(
            "이 지갑의 주소입니다. 다른 컴퓨터의 [받을 주소 만들기]에서 나온 주소를 넣으세요."
                .into(),
        );
    }

    let mut rows = load();
    if rows
        .iter()
        .any(|r| r.get("address").and_then(Value::as_str) == Some(address.trim()))
    {
        return Err("이미 등록된 주소입니다.".into());
    }

    rows.push(json!({
        "name": name,
        "address": address.trim(),
        "note": note.trim(),
        "added": now_unix,
    }));
    save(&rows)?;
    Ok(peer_list())
}

#[tauri::command]
pub fn peer_remove(address: String) -> Result<Value, String> {
    let mut rows = load();
    rows.retain(|r| r.get("address").and_then(Value::as_str) != Some(address.as_str()));
    save(&rows)?;
    Ok(peer_list())
}

/// Keeps a copy of every file the assets in this wallet point at.
///
/// ## Why the counter pins what the laptop issued
///
/// An asset carries one IPFS hash and nothing else — the cover, the audio, the
/// lyrics all live behind that hash, on whichever machines happen to be holding
/// it. Measured on this network, that is exactly one machine: ours. A public
/// gateway fetched a shop photo in 13 seconds through a relay and a second
/// gateway gave up entirely.
///
/// So when the issuing laptop is closed — and it is closed most of the time,
/// which is the correct place for an owner token to live — the cover art of
/// every release stops loading. The counter machine is on all day and already
/// runs IPFS. It should hold the files.
///
/// Returns what it pinned rather than a count, because "12개 보관 중" is not
/// checkable and a list of names is.
#[tauri::command]
pub async fn pin_my_assets() -> Result<Value, String> {
    let assets = crate::raven::list_assets().await?;

    let mut pinned = Vec::new();
    let mut failed = Vec::new();
    let mut skipped = 0;

    for a in assets {
        // 오너 토큰은 파일을 갖고 있지 않다.
        if a.name.ends_with('!') {
            continue;
        }
        let Some(cid) = a.ipfs_hash.as_deref().filter(|h| h.starts_with("Qm")) else {
            skipped += 1;
            continue;
        };

        match crate::ipfs::pin_add(cid.to_string()).await {
            Ok(true) => pinned.push(json!({ "asset": a.name, "cid": cid })),
            Ok(false) | Err(_) => failed.push(json!({ "asset": a.name, "cid": cid })),
        }
    }

    Ok(json!({
        "pinned": pinned,
        "failed": failed,
        "no_file": skipped,
        "note": "이 컴퓨터가 이 파일들을 계속 갖고 있습니다. 발행한 컴퓨터가 꺼져 있어도 손님 화면에서 열립니다.",
    }))
}
