//! First run: look at the machine, then propose a setup that fits it.
//!
//! ## Why the app decides and the owner confirms
//!
//! Every setting this app exposes has a right answer for a given machine, and
//! the owner has no way to know it — `dbcache`, `maxconnections`, IPFS peer
//! counts. Those are measured, not asked.
//!
//! ## The one question that is not the app's to answer
//!
//! How much of this computer the owner is willing to give up. A laptop with
//! 187 GB free looks like it can hold the whole 45 GB chain, and the disk check
//! says yes — but if that laptop is also where they work, handing over 45 GB
//! that grows forever is a decision they would have refused if anyone had asked.
//!
//! So exactly one question is asked, in words with no jargon in them: is this
//! computer only the till, or does it do other things too? Everything else is
//! measured and applied.
//!
//! Asking those questions produces a shop owner staring at `dbcache`. Deciding
//! silently produces an app that did something to their computer. So: measure,
//! propose in plain words, show what it will change, and let them press once.
//!
//! ## What it refuses to propose
//!
//! Mining on a laptop. It is not a close call — the machine throttles, the fan
//! runs, the till stutters, and the return is a rounding error. The option is
//! hidden rather than shown-and-discouraged, because a switch that exists gets
//! flipped.

use serde_json::{json, Value};

fn sysctl(key: &str) -> Option<String> {
    std::process::Command::new("sysctl")
        .args(["-n", key])
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
}

/// Everything about this machine that changes what we should recommend.
#[tauri::command]
pub fn inspect_machine() -> Value {
    let model = sysctl("hw.model").unwrap_or_default();
    let cores = sysctl("hw.ncpu")
        .and_then(|v| v.parse::<u32>().ok())
        .unwrap_or(4);
    let mem_gb = sysctl("hw.memsize")
        .and_then(|v| v.parse::<u64>().ok())
        .map(|b| b / 1_073_741_824)
        .unwrap_or(8);

    // A battery is the honest way to tell a laptop from a desktop; the model
    // string varies by year and by locale, and Mac mini vs MacBook is exactly
    // the distinction that decides mining and connection limits.
    let laptop = std::process::Command::new("pmset")
        .args(["-g", "batt"])
        .output()
        .ok()
        .map(|o| String::from_utf8_lossy(&o.stdout).contains("InternalBattery"))
        .unwrap_or(false)
        || model.contains("MacBook");

    let free_gb = std::process::Command::new("df")
        .args(["-g", "/"])
        .output()
        .ok()
        .and_then(|o| {
            String::from_utf8_lossy(&o.stdout)
                .lines()
                .nth(1)?
                .split_whitespace()
                .nth(3)?
                .parse::<u64>()
                .ok()
        })
        .unwrap_or(0);

    let gpu = crate::mining::detect_gpu();

    json!({
        "model": model,
        "cores": cores,
        "memory_gb": mem_gb,
        "free_disk_gb": free_gb,
        "laptop": laptop,
        "gpu": gpu,
    })
}

/// A setup this machine can carry, given what the machine is FOR.
///
/// Free disk space is the wrong question on its own. A laptop with 187 GB free
/// is usually somebody's working machine, and handing 45 GB of blockchain to it
/// — growing, forever — is not something they would agree to if asked plainly.
/// They were not asked, which is how an app gets uninstalled in week two.
///
/// So the deciding input is `shop_only`: is this computer only the till, or is
/// it also the machine this person works on? Disk space then decides whether
/// "shop only" is even survivable.
#[tauri::command]
pub fn recommend_setup_for(shop_only: bool) -> Value {
    let m = inspect_machine();
    let laptop = m["laptop"].as_bool().unwrap_or(false);
    let free = m["free_disk_gb"].as_u64().unwrap_or(0);
    let mem = m["memory_gb"].as_u64().unwrap_or(8);
    let cores = m["cores"].as_u64().unwrap_or(4);
    let can_mine = m["gpu"]["can_mine"].as_bool().unwrap_or(false);

    // 가게 전용이라 해도 45 GB 가 안 들어가면 소용없다. 여유가 90 GB 는 있어야
    // 몇 달 뒤 체인이 자라도 디스크가 안 찬다.
    let can_keep_all = shop_only && free >= 90;
    let prune = !can_keep_all;

    let dbcache = if mem >= 16 && shop_only && !laptop {
        600
    } else if mem >= 16 {
        450
    } else if mem >= 8 {
        300
    } else {
        200
    };
    let conns = if !shop_only || laptop || cores <= 4 { 16 } else { 40 };

    let mut reasons: Vec<String> = Vec::new();
    if prune {
        if !shop_only {
            reasons.push(
                "다른 일도 하는 컴퓨터라, 장부를 최근 것만 남깁니다. 약 5 GB 를 씁니다."
                    .into(),
            );
        } else {
            reasons.push(format!(
                "빈 공간이 {free} GB 뿐입니다. 장부 전체는 45 GB 이고 계속 늘어나서, 최근 것만 남깁니다."
            ));
        }
        // 아껴 쓰면 장사가 반쪽이 되는 것 아니냐 — 이건 누구나 먼저 묻는다.
        // 실제로 못 하게 되는 것은 지갑 복구 하나뿐이라, 그것만 따로 말한다.
        reasons.push(
            "주문 받기·자동 발송·회원권·메시지는 그대로 됩니다. 지갑이 자기 거래를 따로 갖고 있어서입니다."
                .into(),
        );
        reasons.push(
            "못 하게 되는 것은 하나입니다 — 12단어로 지갑을 되살릴 때 옛 거래를 찾지 못합니다."
                .into(),
        );
    } else {
        reasons.push(format!(
            "가게 전용이고 빈 공간이 {free} GB 여유가 있어 장부를 전부 보관합니다."
        ));
    }
    if laptop {
        reasons.push("노트북이라 연결과 메모리를 낮췄습니다. 팬이 덜 돕니다.".into());
    }

    json!({
        "machine": m,
        "shop_only": shop_only,
        "conf": {
            "server": 1,
            "dbcache": dbcache,
            "maxconnections": conns,
            "maxmempool": if shop_only && !laptop { 300 } else { 100 },
            "prune": if prune { json!(5000) } else { Value::Null },
        },
        "ipfs_profile": if !shop_only || laptop || cores <= 4 { "lowpower" } else { "default-networking" },
        "reasons": reasons,
        // 디스크가 실제로 얼마나 갈지. 숫자가 결정을 대신한다.
        "disk_use_gb": if prune { 6 } else { 47 },
        "disk_free_after": if prune { free.saturating_sub(6) } else { free.saturating_sub(47) },
        "offer_mining": can_mine && shop_only && !laptop,
        "mining_note": if laptop && can_mine {
            "노트북이라 채굴은 권하지 않습니다. 기계가 느려지고 팬이 계속 돕니다."
        } else if !shop_only && can_mine {
            "다른 일도 하는 컴퓨터라 채굴은 권하지 않습니다."
        } else { "" },
        "irreversible": prune,
    })
}

/// Older entry point, kept for anything still calling it. Assumes the machine
/// is shared, which is the safer of the two guesses.
#[tauri::command]
pub fn recommend_setup() -> Value {
    recommend_setup_for(false)
}

/// What this machine is giving up right now, measured rather than assumed.
///
/// The recommendation screen is worthless without this. Telling someone "약 5 GB"
/// means nothing until they can see the 45 GB currently sitting there — and on a
/// machine that already synced the whole chain, the useful action is not
/// "설정하기" but "40 GB 되찾기", which is a different sentence entirely.
#[tauri::command]
pub fn disk_now() -> Value {
    let home = std::env::var("HOME").unwrap_or_default();
    let dir = format!("{home}/Library/Application Support/Raven");

    let gb = |p: &str| -> u64 {
        std::process::Command::new("du")
            .args(["-sg", p])
            .output()
            .ok()
            .and_then(|o| {
                String::from_utf8_lossy(&o.stdout)
                    .split_whitespace()
                    .next()?
                    .parse::<u64>()
                    .ok()
            })
            .unwrap_or(0)
    };

    let chain_gb = gb(&format!("{dir}/blocks")) + gb(&format!("{dir}/chainstate"));
    let ipfs_gb = gb(&format!("{home}/.ipfs"));

    // 설정 파일에 prune 이 적혀 있는지가 "지금 아껴 쓰는 중인가"의 답이다.
    let conf = std::fs::read_to_string(format!("{dir}/raven.conf")).unwrap_or_default();
    let pruned = conf
        .lines()
        .filter_map(|l| l.trim().strip_prefix("prune="))
        .filter_map(|v| v.trim().parse::<u64>().ok())
        .any(|v| v > 0);

    json!({
        "chain_gb": chain_gb,
        "ipfs_gb": ipfs_gb,
        "total_gb": chain_gb + ipfs_gb,
        "pruned": pruned,
        // 이미 다 받아 놓은 사람에게 되찾을 수 있는 양. 0 이면 제안할 것이 없다.
        "reclaimable_gb": if pruned { 0 } else { chain_gb.saturating_sub(6) },
    })
}

/// Applies the recommendation in one press.
///
/// Returns what still needs a restart rather than restarting anything itself —
/// stopping the node is the owner's call, and doing it during service is how a
/// shop loses an hour of orders.
#[tauri::command]
pub async fn apply_setup(conf: Value, ipfs_profile: String) -> Result<Value, String> {
    crate::conf::conf_write(conf)?;
    let ipfs = crate::ipfsconf::ipfs_apply_profile(ipfs_profile).await.is_ok();

    Ok(json!({
        "conf_written": true,
        "ipfs_applied": ipfs,
        "needs_node_restart": true,
        "note": "노드를 다시 켜야 적용됩니다. 영업 중이면 마감 뒤에 하세요.",
    }))
}
