//! Running the node and IPFS, instead of asking someone else to.
//!
//! ## The five steps that were the real problem
//!
//! Before this, opening the shop meant: start the Ravencoin node, start IPFS,
//! start this app, switch on the phone server, switch on the tunnel. Five
//! things, in order, every time the machine reboots. Nobody does that five
//! times and keeps doing it.
//!
//! This app already knows when each of those is down — the health check says
//! so in plain words. Knowing and not acting is the gap. So it starts them.
//!
//! ## What it deliberately does not do
//!
//! **It does not install anything.** Downloading and running a binary on
//! someone's behalf is how a shop POS becomes a malware vector, and a wallet
//! that fetches its own node cannot prove what it fetched. Missing software is
//! reported with the one command to install it, and that command is run by a
//! person who can read it.
//!
//! **It does not stop what it did not start.** If the owner already has a node
//! running — from Ravencoin Core, from a launch agent, from a terminal — this
//! attaches to it and leaves it alone. Killing someone else's node mid-sync is
//! not ours to do.

use serde_json::{json, Value};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;

/// Processes this app started, so it can stop exactly those and no others.
static OURS: Mutex<Option<Vec<(String, Child)>>> = Mutex::new(None);

fn which(name: &str) -> Option<String> {
    // A GUI app on macOS inherits a minimal PATH that usually lacks /opt/homebrew,
    // so the usual places are checked directly rather than trusting `which`.
    let home = std::env::var("HOME").unwrap_or_default();
    let candidates = [
        format!("/opt/homebrew/bin/{name}"),
        format!("/usr/local/bin/{name}"),
        format!("{home}/RavencoinBuilds-4.8.0/macos-arm64/{name}"),
        format!("/Applications/Raven-Qt.app/Contents/MacOS/{name}"),
        format!("{home}/.local/bin/{name}"),
    ];
    candidates
        .iter()
        .find(|p| std::path::Path::new(p).exists())
        .cloned()
        .or_else(|| {
            Command::new("/usr/bin/which")
                .arg(name)
                .output()
                .ok()
                .filter(|o| o.status.success())
                .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
                .filter(|s| !s.is_empty())
        })
}

/// Is each piece installed, running, and did we start it?
#[tauri::command]
pub async fn services_status() -> Value {
    let node_running = crate::raven::call_rpc("getblockchaininfo", json!([]))
        .await
        .is_ok();
    let ipfs_running = reqwest::Client::new()
        .post("http://127.0.0.1:5001/api/v0/id")
        .timeout(std::time::Duration::from_secs(4))
        .send()
        .await
        .map(|r| r.status().is_success())
        .unwrap_or(false);

    let started: Vec<String> = OURS
        .lock()
        .ok()
        .and_then(|g| g.as_ref().map(|v| v.iter().map(|(n, _)| n.clone()).collect()))
        .unwrap_or_default();

    json!({
        "node": {
            "running": node_running,
            "installed": which("ravend").is_some(),
            "path": which("ravend"),
            "ours": started.contains(&"node".to_string()),
            "install": "레이븐 노드를 설치해 주세요. 이 앱은 프로그램을 대신 내려받지 않습니다.",
        },
        "ipfs": {
            "running": ipfs_running,
            "installed": which("ipfs").is_some(),
            "path": which("ipfs"),
            "ours": started.contains(&"ipfs".to_string()),
            "install": "brew install ipfs",
        },
    })
}

/// Starts whichever pieces are installed and not already running.
///
/// Attaching to something already up is the normal case and produces no output
/// — a shop that had its node running should see nothing happen, not a second
/// node fighting for the same wallet file.
#[tauri::command]
pub async fn services_start() -> Result<Value, String> {
    let status = services_status().await;
    let mut started = Vec::new();
    let mut skipped = Vec::new();

    // ── node ──
    if status["node"]["running"].as_bool().unwrap_or(false) {
        skipped.push(json!({ "what": "노드", "why": "이미 켜져 있습니다" }));
    } else if let Some(path) = which("ravend") {
        let home = std::env::var("HOME").unwrap_or_default();
        let datadir = format!("{home}/Library/Application Support/Raven");
        match Command::new(&path)
            .arg(format!("-datadir={datadir}"))
            .arg("-server=1")
            // Detached: the node keeps running if this app is closed, which is
            // what a shop wants — payments keep being recorded overnight.
            .arg("-daemon")
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
        {
            Ok(child) => {
                remember("node", child);
                started.push(json!({ "what": "노드", "note": "따라잡는 데 몇 분 걸립니다" }));
            }
            Err(e) => skipped.push(json!({ "what": "노드", "why": e.to_string() })),
        }
    } else {
        skipped.push(json!({ "what": "노드", "why": "설치되어 있지 않습니다" }));
    }

    // ── ipfs ──
    if status["ipfs"]["running"].as_bool().unwrap_or(false) {
        skipped.push(json!({ "what": "IPFS", "why": "이미 켜져 있습니다" }));
    } else if let Some(path) = which("ipfs") {
        // `--migrate` because a kubo upgrade otherwise stops at a prompt nobody
        // is watching, and the shop just sees IPFS never coming up.
        match Command::new(&path)
            .args(["daemon", "--migrate=true"])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
        {
            Ok(child) => {
                remember("ipfs", child);
                started.push(json!({ "what": "IPFS", "note": "" }));
            }
            Err(e) => skipped.push(json!({ "what": "IPFS", "why": e.to_string() })),
        }
    } else {
        skipped.push(json!({ "what": "IPFS", "why": "설치되어 있지 않습니다 — brew install ipfs" }));
    }

    Ok(json!({ "started": started, "skipped": skipped }))
}

fn remember(name: &str, child: Child) {
    if let Ok(mut g) = OURS.lock() {
        g.get_or_insert_with(Vec::new).push((name.to_string(), child));
    }
}

/// Stops only what this app started.
#[tauri::command]
pub fn services_stop() -> Result<Value, String> {
    let mut stopped = Vec::new();
    if let Ok(mut g) = OURS.lock() {
        if let Some(list) = g.as_mut() {
            for (name, child) in list.iter_mut() {
                let _ = child.kill();
                let _ = child.wait();
                stopped.push(name.clone());
            }
            list.clear();
        }
    }
    Ok(json!({ "stopped": stopped }))
}

/// Everything needed to open the shop, in one press.
///
/// Ordered by dependency: the node first, because IPFS coming up without a node
/// gives a shop that can show pictures and take no money.
#[tauri::command]
pub async fn open_shop() -> Result<Value, String> {
    let svc = services_start().await?;

    // Give the node a moment to open its RPC port before anything asks it a
    // question — the first health check otherwise reports "down" on a node that
    // is fine and starting.
    tokio::time::sleep(std::time::Duration::from_millis(1500)).await;

    let health = crate::health::service_health(false, false).await;
    Ok(json!({ "services": svc, "health": health }))
}
