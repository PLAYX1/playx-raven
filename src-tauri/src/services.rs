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
        let datadir = crate::paths::raven_dir().to_string_lossy().to_string();

        // 🔴 자산 색인을 켜면 **다시 훑어야 한다.** 그런데 코어는 자산 색인이
        // 바뀐 것을 **검사하지 않는다**(init.cpp 에 txindex·addressindex 분기는
        // 있는데 assetindex 만 없다). 그래서 설정만 바꾸고 켜면 노드는 말없이
        // 옛 상태로 돌고, 배당은 계속 "색인이 꺼져 있습니다" 를 답한다.
        //
        // 우리가 대신 붙인다. 한 번 붙이고 나면 표시를 남겨 다음부터는 안 붙인다 —
        // 켤 때마다 34GB 를 다시 훑으면 그 가게는 영영 장사를 못 한다.
        let want_asset = crate::conf::wants_assetindex();
        let stamp = crate::paths::app_file("reindexed-assetindex");
        let need_reindex = want_asset && !stamp.exists();

        let mut cmd = Command::new(&path);
        cmd.arg(format!("-datadir={datadir}")).arg("-server=1");
        if need_reindex {
            cmd.arg("-reindex");
        }
        match cmd
            // Detached: the node keeps running if this app is closed, which is
            // what a shop wants — payments keep being recorded overnight.
            .arg("-daemon")
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
        {
            Ok(child) => {
                remember("node", child);
                if need_reindex {
                    // 한 번만 붙인다. 표시를 남기지 않으면 켤 때마다 다시 훑는다.
                    let _ = std::fs::write(&stamp, "1");
                }
                started.push(json!({
                    "what": "노드",
                    "note": if need_reindex {
                        "자산 색인을 만드느라 처음부터 다시 훑습니다 — 몇 시간 걸립니다. 그동안 주문 확인이 멈춥니다."
                    } else {
                        "따라잡는 데 몇 분 걸립니다"
                    },
                    "reindexing": need_reindex,
                }));
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
