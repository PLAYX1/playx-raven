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
    let home = crate::paths::home().to_string_lossy().to_string();
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
    json!({
        "home": crate::paths::home().to_string_lossy(),
        "data_dir": crate::paths::raven_dir().to_string_lossy(),
        "ravend": crate::services::which("ravend"),
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
    // 🔴 이 아래는 전부 맥의 launchd 다. 윈도우에서는 **아무 일도 안 일어났고**,
    //    그래서 재부팅하면 가게가 안 돌아왔다. 계산대 컴퓨터는 정전 한 번이면
    //    끝인 셈이다.
    //
    //    윈도우에서는 **앱 자체를** 자동시작에 넣는다. 앱이 켜지면 노드도
    //    조용히 켠다(`services_start`). 노드만 따로 넣으면 검은 창이 뜬다.
    #[cfg(target_os = "windows")]
    {
        let _ = (&ravend_path, &data_dir);
        let exe = std::env::current_exe()
            .map_err(|e| format!("이 프로그램의 자리를 찾지 못했습니다: {e}"))?;
        let out = crate::quiet::cmd("reg")
            .args([
                "add",
                r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run",
                "/v",
                "PLAY X Raven",
                "/t",
                "REG_SZ",
                "/d",
                &exe.to_string_lossy(),
                "/f",
            ])
            .output()
            .map_err(|e| format!("자동시작을 켜지 못했습니다: {e}"))?;
        if !out.status.success() {
            return Err("자동시작을 켜지 못했습니다.".into());
        }
        return Ok(());
    }
    #[allow(unreachable_code)]
    {
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
    let _ = crate::quiet::cmd("launchctl")
        .args(["load", "-w"])
        .arg(plist_path())
        .status();
    Ok(())
    }
}

#[tauri::command]
pub fn autostart_disable() -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        // 없는 것을 지우려 해도 오류가 아니다 — 끄는 것이 목적이다.
        let _ = crate::quiet::cmd("reg")
            .args([
                "delete",
                r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run",
                "/v",
                "PLAY X Raven",
                "/f",
            ])
            .output();
        return Ok(());
    }
    #[allow(unreachable_code)]
    {
    let _ = crate::quiet::cmd("launchctl")
        .args(["unload", "-w"])
        .arg(plist_path())
        .status();
    let _ = std::fs::remove_file(plist_path());
    Ok(())
    }
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
            // 🔴 **거짓말이었다.** 여기는 「몇 분」이라고 했는데, 같은 저장소의
            //    실측 주석(main.ts)에는 초당 1.25블록·남은 320만 블록이면
            //    **한 달**이라고 적혀 있다. 첫 실행 사장이 정확히 이 상태다.
            //
            //    ⚠️ 며칠 걸릴 일을 「몇 분」이라고 하면, 사장은 몇 분 뒤
            //       고장 났다고 판단하고 프로그램을 지운다. 모르면 모른다고
            //       하는 편이 낫다.
            "얼마나 걸리는지는 「이 컴퓨터 → RVN 노드」에서 남은 시간을 보실 수 있습니다. \
처음이면 며칠 걸릴 수 있습니다 — 그동안에도 메뉴·QR·가게 정보는 쓰실 수 있습니다.",
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

/// **돈이 도는지 한눈에.**
///
/// 🔴 왜 필요한가 — 이 저장소의 병은 「만들었는데 조용히 안 도는 것」이다.
/// 2026-09-06 하루에만 여섯 개를 찾았고, 그중 하나는 **개발비 1% 가 한 푼도
/// 안 걷히던 것**이었다. 화면에는 「1%」라고 떠 있었고 계산 코드도 있었는데
/// 부르는 줄이 없었다. 대표가 물어봐야 알 수 있는 상태였다.
///
/// 그래서 **묻지 않아도 보이게** 한다. 각 줄은 「살았나/죽었나」와
/// **그게 무슨 뜻인지**를 같이 말한다. 숫자만 던지면 사장은 판단을 못 한다.
#[tauri::command]
pub async fn money_status() -> Value {
    // ── 노드 ──────────────────────────────────────────────
    let node = call_rpc("getblockchaininfo", json!([])).await;
    let (blocks, behind) = node
        .as_ref()
        .ok()
        .map(|v| {
            let b = v.get("blocks").and_then(|x| x.as_u64()).unwrap_or(0);
            let h = v.get("headers").and_then(|x| x.as_u64()).unwrap_or(0);
            (b, h.saturating_sub(b))
        })
        .unwrap_or((0, 0));

    // ── 지갑 ──────────────────────────────────────────────
    let w = call_rpc("getwalletinfo", json!([])).await.ok();
    let balance = w.as_ref().and_then(|v| v.get("balance")?.as_f64()).unwrap_or(0.0);
    // `unlocked_until` 이 없으면 **암호가 안 걸린 지갑**이다. 0 이면 잠김.
    let unlocked_until = w.as_ref().and_then(|v| v.get("unlocked_until")?.as_i64());
    let wallet_state = match unlocked_until {
        None => "no_passphrase",
        Some(0) => "locked",
        Some(_) => "unlocked",
    };

    // ── 우리 몫 장부 ───────────────────────────────────────
    let ledger = crate::devfee::snapshot();

    // ── 자산 ──────────────────────────────────────────────
    // 곡을 냈는지, 몇 장 남았는지. `listmyassets` 는 색인 없이도 된다.
    let mine = call_rpc("listmyassets", json!([])).await.ok();
    let mut songs: Vec<Value> = Vec::new();
    if let Some(m) = mine.as_ref().and_then(|v| v.as_object()) {
        for (name, qty) in m {
            if name.starts_with("PLAYX/SONG/") && !name.ends_with('!') {
                songs.push(json!({ "name": name, "left": qty.as_f64().unwrap_or(0.0) }));
            }
        }
    }
    songs.sort_by(|a, b| a["name"].as_str().cmp(&b["name"].as_str()));

    json!({
        "node": {
            "ok": node.is_ok(),
            "blocks": blocks,
            "behind": behind,
            "why": if node.is_err() { "노드가 꺼져 있습니다. 결제 확인이 안 됩니다." }
                   else if behind > 20 { "따라잡는 중입니다. 방금 들어온 결제가 아직 안 보일 수 있습니다." }
                   else { "정상입니다." },
        },
        "wallet": {
            "state": wallet_state,
            "rvn": balance,
            "why": match wallet_state {
                "locked" => "잠겨 있습니다. 자산을 보내려면 잠깐 열어야 합니다.",
                "unlocked" => "열려 있습니다. 볼일이 끝나면 잠그는 편이 안전합니다.",
                _ => "암호가 걸려 있지 않습니다. 걸어 두시는 편이 안전합니다.",
            },
        },
        // 🔴 여기가 핵심이다. 「쌓인 것 0 · 보낸 것 0」이 오래 이어지면
        //    걷는 길이 어딘가 끊어진 것이다.
        "our_share": ledger,
        "songs": songs,
    })
}
