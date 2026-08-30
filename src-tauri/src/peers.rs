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
    crate::paths::app_file("peers.json")
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
    let cids: Vec<String> = assets
        .into_iter()
        .filter(|a| !a.name.ends_with('!'))
        .filter_map(|a| {
            let cid = a.ipfs_hash.filter(|h| h.starts_with("Qm"))?;
            Some(format!("{}\u{1}{}", a.name, cid))
        })
        .collect();
    pin_these(cids).await
}

/// 이름과 주소가 붙은 목록을 받아 **그것들을 이 컴퓨터가 들고 있게** 한다.
///
/// 🔴 내 것만 들어 주면 「서로 보완」이 아니다. 대표님: "내 406호 컴퓨터와
///    내 맥북이 서로를 보완해 줄수도 있으면 좋지 않나?"
///
///    맞다. 그리고 이게 **오늘 난 사고를 근본적으로 막는다** — 가게 사진이
///    사라진 것은 그 파일을 **한 대만** 들고 있었기 때문이다. 노트북이 닫히면
///    세상에서 사라진다. 계산대는 하루 종일 켜져 있다.
async fn pin_these(items: Vec<String>) -> Result<Value, String> {
    let assets: Vec<(String, String)> = items
        .into_iter()
        .filter_map(|s| {
            let (n, c) = s.split_once('\u{1}')?;
            Some((n.to_string(), c.to_string()))
        })
        .collect();

    let mut pinned = Vec::new();
    let mut failed = Vec::new();
    let skipped = 0;

    for (name, cid) in assets {
        match crate::ipfs::pin_add(cid.clone()).await {
            Ok(true) => pinned.push(json!({ "asset": name, "cid": cid })),
            Ok(false) | Err(_) => failed.push(json!({ "asset": name, "cid": cid })),
        }
    }

    Ok(json!({
        "pinned": pinned,
        "failed": failed,
        "no_file": skipped,
        "note": "이 컴퓨터가 이 파일들을 계속 갖고 있습니다. 발행한 컴퓨터가 꺼져 있어도 손님 화면에서 열립니다.",
    }))
}

/// 이 컴퓨터가 들고 있는 자산 파일 목록. **다른 노드가 물어보는 자리다.**
///
/// 🔴 숨길 것이 없다. 자산 이름도 IPFS 주소도 **이미 체인에 공개**돼 있다.
///    여기서 새로 새는 것은 없고, 다만 「이 목록을 한 번에 받는 길」이
///    없어서 서로 도울 수가 없었을 뿐이다.
pub async fn my_cids() -> Value {
    let assets = match crate::raven::list_assets().await {
        Ok(v) => v,
        Err(e) => return json!({ "error": e, "items": [] }),
    };
    let items: Vec<Value> = assets
        .into_iter()
        .filter(|a| !a.name.ends_with('!'))
        .filter_map(|a| {
            let cid = a.ipfs_hash.filter(|h| h.starts_with("Qm"))?;
            Some(json!({ "asset": a.name, "cid": cid }))
        })
        .collect();
    json!({ "items": items })
}

/// **저쪽 컴퓨터의 파일을 이쪽이 들어 준다.**
///
/// 대표님: "탈중앙인데 서로가 보완해 가면서 가는 구조가 좋은데 말야."
///
/// 맞다. 그리고 이건 겉멋이 아니라 **오늘 난 사고의 근본 처방**이다 —
/// 가게 사진이 사라진 것은 그 파일을 **한 대만** 들고 있었기 때문이다.
/// 발행하는 노트북은 닫혀 있는 게 맞고(소유권 토큰이 사는 자리다), 계산대는
/// 하루 종일 켜져 있다. 그러면 **켜져 있는 쪽이 들고 있어야** 한다.
///
/// ⚠️ **저쪽이 꺼져 있으면 그냥 넘어간다.** 도우려다 이쪽이 멈추면 안 된다.
#[tauri::command]
pub async fn peer_help(url: String) -> Result<Value, String> {
    let base = url.trim().trim_end_matches('/').to_string();
    if !base.starts_with("http://") && !base.starts_with("https://") {
        return Err("주소는 http:// 나 https:// 로 시작해야 합니다.".into());
    }
    let r = reqwest::Client::new()
        .get(format!("{base}/api/pins"))
        .timeout(std::time::Duration::from_secs(20))
        .send()
        .await
        .map_err(|e| format!("그 컴퓨터에 못 닿았습니다 — {e}"))?;
    let body: Value = r
        .json()
        .await
        .map_err(|e| format!("답을 못 읽었습니다 — {e}"))?;
    let items: Vec<String> = body
        .get("items")
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .filter_map(|x| {
                    let n = x.get("asset").and_then(Value::as_str)?;
                    let c = x.get("cid").and_then(Value::as_str)?;
                    Some(format!("{n}\u{1}{c}"))
                })
                .collect()
        })
        .unwrap_or_default();
    if items.is_empty() {
        return Ok(json!({
            "pinned": [], "failed": [], "skipped": 0,
            "note": "그 컴퓨터에는 파일이 붙은 자산이 없습니다."
        }));
    }
    pin_these(items).await
}

/// **켜 두면 알아서 지킨다.**
///
/// 🔴 대표님: "사람들은 블록체인이면 인공지능처럼 자동으로 되는걸 원할걸."
///
///    「내 파일 지키기」를 단추로 만들어 놨는데, 단추는 누가 눌러야 한다.
///    그런데 이 일은 **되돌릴 수 있고 돈이 안 든다** — 자동이 맞는 자리다.
///    (발행·재발행·보내기는 절대 자동이면 안 된다. 그건 되돌릴 수 없다.)
///
///    오늘 가게 사진이 사라진 것은 그 파일을 **한 대만** 들고 있었기
///    때문이다. 사장이 누르는 것을 잊으면 같은 일이 또 난다.
///
/// ⚠️ **지갑을 안 연다.** 핀은 파일창고의 일이라 개인키가 필요 없다 —
///    그래서 자동으로 돌려도 안전하다. 개발비 자동송금과 다른 점이 이것이다.
///
/// ⚠️ 실패해도 조용히 넘어간다. 파일창고가 잠깐 꺼져 있다고 앱이 멈추면 안 된다.
pub fn start_auto_pin() {
    tauri::async_runtime::spawn(async {
        // 처음 한 번은 조금 기다린다. 앱이 켜지는 동안 파일창고도 올라온다.
        tokio::time::sleep(std::time::Duration::from_secs(90)).await;
        loop {
            let _ = pin_my_assets().await;
            // 30분마다. 자산이 자주 바뀌는 물건이 아니라 이보다 잦을 이유가 없다.
            tokio::time::sleep(std::time::Duration::from_secs(1800)).await;
        }
    });
}

