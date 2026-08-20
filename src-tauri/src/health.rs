//! Staying up, and knowing when you are not.
//!
//! ## What "decentralised" does and does not buy
//!
//! The chain is decentralised: thousands of nodes hold it, so a shop's assets,
//! payments and ownership survive this computer being unplugged, stolen, or
//! thrown away. That is the part that matters and it is genuinely different
//! from a bank going under.
//!
//! The *service* is not decentralised. The sale page, the order board, the door
//! check and automatic fulfilment all run on this one machine. Nobody else's
//! node can serve them, because they are this shop's software holding this
//! shop's keys — Ravencoin peers relay transactions to each other, not web
//! pages.
//!
//! So the honest position is: **money does not go missing, the shop closes.**
//! What this file can do about that is narrow and worth doing anyway — start
//! again by itself, and tell someone when it did not.
//!
//! ## Why not run a second node
//!
//! Two nodes on one `wallet.dat` is not redundancy, it is corruption: both
//! would hand out the same addresses and could sign conflicting spends. Two
//! nodes with two wallets are two different shops. There is no configuration
//! of this that produces a hot spare.

use crate::raven::call_rpc;
use serde_json::{json, Value};
use std::path::PathBuf;

fn agents_dir() -> PathBuf {
    let home = std::env::var("HOME").unwrap_or_default();
    PathBuf::from(home).join("Library/LaunchAgents")
}

fn plist_path() -> PathBuf {
    agents_dir().join("se.erci.playx.raven.node.plist")
}

/// Where this user's things live. Asked from the OS rather than assumed.
///
/// A path with a developer's username in it is a path that works on exactly one
/// machine. This app is meant to run in shops that are not ours.
#[tauri::command]
pub fn default_paths() -> Value {
    let home = std::env::var("HOME").unwrap_or_default();
    let candidates = [
        format!("{home}/RavencoinBuilds-4.8.0/macos-arm64/ravend"),
        "/Applications/Raven-Qt.app/Contents/MacOS/ravend".to_string(),
        format!("{home}/Applications/Raven-Qt.app/Contents/MacOS/ravend"),
        "/usr/local/bin/ravend".to_string(),
        "/opt/homebrew/bin/ravend".to_string(),
    ];
    let found = candidates
        .iter()
        .find(|p| std::path::Path::new(p).exists())
        .cloned();

    json!({
        "home": home.clone(),
        "data_dir": crate::paths::raven_dir().to_string_lossy(),
        "ravend": found,
        "searched": candidates,
    })
}

/// Is the node set to come back by itself after a restart or a crash?
#[tauri::command]
pub fn autostart_status() -> Value {
    let installed = plist_path().exists();
    json!({
        "installed": installed,
        "path": plist_path().to_string_lossy(),
    })
}

/// Makes the node start with the machine and restart if it dies.
///
/// This covers the ordinary failures — a power cut, an update reboot, the node
/// exiting on its own overnight. It does not cover the disk failing or the
/// machine being stolen; nothing running on that machine can.
///
/// Deliberately only the node, not this app. A node that is up means payments
/// keep being recorded and nothing is missed while the shop is closed; an app
/// launching itself into an empty room and unlocking a wallet is not a service,
/// it is an exposure.
#[tauri::command]
pub fn autostart_enable(ravend_path: String, data_dir: String) -> Result<(), String> {
    if !std::path::Path::new(&ravend_path).exists() {
        return Err(format!("{ravend_path} 를 찾지 못했습니다."));
    }
    std::fs::create_dir_all(agents_dir()).map_err(|e| e.to_string())?;

    let plist = format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>se.erci.playx.raven.node</string>
  <key>ProgramArguments</key>
  <array>
    <string>{ravend_path}</string>
    <string>-datadir={data_dir}</string>
    <string>-server=1</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>30</integer>
</dict>
</plist>
"#
    );

    std::fs::write(plist_path(), plist).map_err(|e| format!("설정을 쓰지 못했습니다: {e}"))?;

    // launchctl load 는 실패해도 파일은 남는다 — 다음 로그인에 뜬다.
    let _ = std::process::Command::new("launchctl")
        .args(["load", "-w"])
        .arg(plist_path())
        .status();
    Ok(())
}

#[tauri::command]
pub fn autostart_disable() -> Result<(), String> {
    let _ = std::process::Command::new("launchctl")
        .args(["unload", "-w"])
        .arg(plist_path())
        .status();
    let _ = std::fs::remove_file(plist_path());
    Ok(())
}

/// One answer to "can this shop take an order right now".
///
/// Every part is checked separately because they fail separately, and a shop
/// owner needs to know which one — "노드가 꺼졌다" and "인터넷이 끊겼다" have
/// different fixes and only one of them is theirs to make.
#[tauri::command]
pub async fn service_health(phone_on: bool, tunnel_on: bool) -> Value {
    let node = call_rpc("getblockchaininfo", json!([])).await;
    let node_ok = node.is_ok();
    let behind = node
        .as_ref()
        .ok()
        .and_then(|v| {
            let h = v.get("headers")?.as_u64()?;
            let b = v.get("blocks")?.as_u64()?;
            Some(h.saturating_sub(b))
        })
        .unwrap_or(0);

    let ipfs_ok = reqwest::Client::new()
        .post("http://127.0.0.1:5001/api/v0/id")
        .timeout(std::time::Duration::from_secs(5))
        .send()
        .await
        .map(|r| r.status().is_success())
        .unwrap_or(false);

    // 순서가 곧 답이다. 노드가 죽으면 나머지는 물어볼 필요도 없다.
    let (state, why, fix) = if !node_ok {
        (
            "down",
            "노드가 꺼져 있습니다. 주문도 결제 확인도 안 됩니다.",
            "레이븐 노드를 다시 켜세요. 그동안 들어온 돈은 사라지지 않고, 켜면 전부 보입니다.",
        )
    } else if behind > 20 {
        (
            "catching_up",
            "노드가 따라잡는 중입니다. 방금 들어온 결제가 아직 안 보일 수 있습니다.",
            "몇 분 기다리세요.",
        )
    } else if !phone_on {
        (
            "no_orders",
            "폰 연결이 꺼져 있어 손님이 주문할 곳이 없습니다.",
            "이 컴퓨터 → 폰 연결 켜기.",
        )
    } else if !ipfs_ok {
        (
            "no_photos",
            "IPFS가 꺼져 있습니다. 메뉴 사진이 손님에게 안 보입니다.",
            "IPFS를 켜세요. 주문 자체는 됩니다.",
        )
    } else if !tunnel_on {
        (
            "local_only",
            "매장 안에서만 주문할 수 있습니다.",
            "밖에서도 받으려면 바깥 주소를 켜세요.",
        )
    } else {
        ("ok", "주문 받을 수 있습니다.", "")
    };

    json!({
        "state": state,
        "why": why,
        "fix": fix,
        "node": node_ok,
        "behind": behind,
        "ipfs": ipfs_ok,
        "phone": phone_on,
        "tunnel": tunnel_on,
    })
}
