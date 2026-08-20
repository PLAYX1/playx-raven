//! Receiving mining rewards. Not mining.
//!
//! ## Why this app does not mine
//!
//! Ravencoin uses KAWPOW, a GPU algorithm. Against a live network of roughly
//! 694 TH/s, a single card is a rounding error and a laptop is less than that.
//!
//! Apple Silicon *can* mine it — Thinminerpro and MacMiner implement KAWPOW in
//! Metal — but at 0.5–2 MH/s against 45 MH/s for a mid-range NVIDIA card. That
//! gap is not the hardware; KAWPOW has years of CUDA and OpenCL tuning behind
//! it and the Metal ports have not had the same attention. Worth stating
//! precisely, because "Macs cannot mine" is wrong and "Macs can mine" without
//! the number is misleading in the other direction.
//!
//! And the machine matters more than the maths: a counter PC that is mining is
//! a counter PC with a saturated GPU, a loud fan, and an order screen that
//! stutters. The node and IPFS are meant to sit quietly and run a shop. Mining
//! takes the whole machine. They are opposite kinds of program.
//!
//! ## What this does instead
//!
//! If the owner already has a mining rig, the only thing they need from this
//! app is an address and a line to paste into their miner. Pool software sends
//! the reward wherever it is told; nothing here has to run, and nothing here
//! can go wrong.
//!
//! Solo mining against this node is possible in principle — `getblocktemplate`
//! and `submitblock` exist — but it needs a stratum proxy between the miner and
//! the node, and at this difficulty a single rig would expect to find a block
//! roughly never. The screen says so rather than offering a button that quietly
//! wastes someone's month.

use crate::raven::call_rpc;
use serde_json::{json, Value};

/// What mining at this difficulty would actually be worth on one machine.
///
/// Computed rather than asserted, because the honest answer changes with the
/// network and the price, and a hard-coded "it is not worth it" stops being
/// true if either moves far enough.
#[tauri::command]
pub async fn mining_reality(hashrate_mh: f64, watts: f64, krw_per_kwh: f64) -> Result<Value, String> {
    let info = call_rpc("getmininginfo", json!([])).await?;
    let network_hps = info
        .get("networkhashps")
        .and_then(Value::as_f64)
        .unwrap_or(0.0);
    if network_hps <= 0.0 {
        return Err("네트워크 해시레이트를 읽지 못했습니다.".into());
    }

    let mine_hps = hashrate_mh * 1_000_000.0;
    let share = mine_hps / network_hps;

    // 보상은 상수가 아니다. 2,100,000 블록마다 반으로 준다(validation.cpp).
    // 여기 2500 이 박혀 있어서, 반감기를 두 번 지난 지금 이 앱은 채굴 수입을
    // 두 배로 말하고 있었다. 높이를 보고 계산한다.
    let height = call_rpc("getblockchaininfo", json!([]))
        .await
        .ok()
        .and_then(|v| v.get("blocks").and_then(Value::as_i64))
        .unwrap_or(0);
    let halvings = (height / 2_100_000).clamp(0, 63) as u32;
    let reward = 5000.0_f64 / 2f64.powi(halvings as i32);

    const BLOCKS_PER_DAY: f64 = 1440.0;
    let rvn_day = BLOCKS_PER_DAY * reward * share;

    let krw_per_rvn = crate::price::rvn_rate(crate::shop::currency())
        .await
        .ok()
        .and_then(|r| r["rate"].as_f64())
        .unwrap_or(0.0);

    let income = rvn_day * krw_per_rvn;
    let power_cost = watts / 1000.0 * 24.0 * krw_per_kwh;

    Ok(json!({
        "height": height,
        "halvings": halvings,
        "block_reward": reward,
        "network_hps": network_hps,
        "share": share,
        // 기여도는 백분율로는 0.00에 붙어 버린다. 백만분율이 읽히는 단위다.
        "share_ppm": share * 1_000_000.0,
        "rvn_per_day": rvn_day,
        "income_krw": income,
        "power_krw": power_cost,
        "net_krw": income - power_cost,
        "profitable": income > power_cost,

        // ── 돈이 목적이 아닌 사람에게 필요한 것들 ──────────────────────
        //
        // 레이븐은 프리마인 없이 보통 사람이 캘 수 있게 만든 체인이고, 소량이라도
        // 보태려는 사람이 실제로 많다. 그 사람에게 "적자입니다"만 보여 주고 끝내면
        // 그건 답이 아니라 거절이다. 비용은 정직하게 적되, 무엇에 기여하는지도
        // 같은 크기로 적는다.
        "contribution": {
            // 이미 하고 있는 것. 이 문장이 먼저 와야 한다 — 노드는 이미 켜져
            // 있고, 검증하고 전파하는 것 자체가 채굴과 별개인 기여다.
            "already": "노드를 켜 두신 것만으로 이미 기여하고 계십니다. 거래를 스스로 검증하고 이웃에게 전파합니다.",
            "hash_note": format!(
                "채굴을 켜면 네트워크 해시의 약 {:.1} 백만분율을 보탭니다.",
                share * 1_000_000.0
            ),
            // 여기가 진짜 갈림길이다.
            "solo_vs_pool": "풀에 붙으면 해시는 보태지만 블록에 어떤 거래를 담을지는 풀이 정합니다. 탈중앙에 온전히 보태려면 자기 노드에 대고 캐는 솔로여야 합니다.",
            "solo_days_per_block": if share > 0.0 { 1.0 / (BLOCKS_PER_DAY * share) } else { f64::INFINITY },
            "solo_block_krw": reward * krw_per_rvn,
        },
    }))
}

/// macOS KAWPOW miners, for someone who wants to try it anyway.
#[tauri::command]
pub fn mac_miners() -> Value {
    json!([
        { "name": "Thinminerpro", "what": "Swift + Metal. 애플 실리콘 전용으로 새로 썼습니다.",
          "url": "https://github.com/rezahussain/thinminerpro" },
        { "name": "MacMiner", "what": "v0.4.0부터 KAWPOW. M1 Max에서 25W 정도 씁니다.",
          "url": "https://xcreate.com/macminer/" },
        { "name": "kawpowminer", "what": "공식 구현. macOS 실행 파일이 있습니다.",
          "url": "https://github.com/RavenCommunity/kawpowminer" }
    ])
}

/// Rough hash rates so someone can pick their card instead of looking it up.
///
/// Approximate on purpose — real numbers move with drivers, power limits and
/// memory timings. Close enough to answer "is this worth it", which is the only
/// question this screen exists for.
#[tauri::command]
pub fn gpu_presets() -> Value {
    json!([
        { "name": "RTX 3060",     "mh": 22.0, "watts": 115.0 },
        { "name": "RTX 3060 Ti",  "mh": 27.0, "watts": 130.0 },
        { "name": "RTX 3070",     "mh": 30.0, "watts": 135.0 },
        { "name": "RTX 3080",     "mh": 45.0, "watts": 230.0 },
        { "name": "RTX 3090",     "mh": 55.0, "watts": 280.0 },
        { "name": "RTX 4070",     "mh": 38.0, "watts": 145.0 },
        { "name": "RTX 4080",     "mh": 58.0, "watts": 230.0 },
        { "name": "RTX 4090",     "mh": 68.0, "watts": 300.0 },
        { "name": "RX 6700 XT",   "mh": 25.0, "watts": 145.0 },
        { "name": "RX 6800 XT",   "mh": 35.0, "watts": 200.0 },
        { "name": "맥 M1 Max (Metal)", "mh": 1.5,  "watts": 25.0 },
        { "name": "직접 입력",         "mh": 0.0,  "watts": 0.0 }
    ])
}

/// What graphics hardware this machine has, and whether it can mine Ravencoin.
///
/// The two questions are not the same, and conflating them is how somebody with
/// a fast Mac spends an evening looking for a miner that does not exist.
///
/// KAWPOW miners — T-Rex, NBMiner, GMiner — are built on CUDA and OpenCL for
/// NVIDIA and AMD cards. Apple Silicon has a capable GPU and no maintained
/// KAWPOW implementation for it: the hardware is fine, the software was never
/// written. So an M-series Mac is reported as "cannot mine" with that reason
/// attached, rather than being left to look like a configuration problem.
/// Graphics hardware does not change while the app is running, and asking macOS
/// about it costs **0.84 seconds** — `system_profiler` walks the whole display
/// subsystem every time. The setup screen, the mining screen and the machine
/// report all ask, so the counter froze for most of a second on each visit.
///
/// Measured once, then remembered.
static GPU: std::sync::OnceLock<Value> = std::sync::OnceLock::new();

#[tauri::command]
pub fn detect_gpu() -> Value {
    GPU.get_or_init(detect_gpu_uncached).clone()
}

fn detect_gpu_uncached() -> Value {
    #[cfg(target_os = "macos")]
    {
        let out = std::process::Command::new("system_profiler")
            .arg("SPDisplaysDataType")
            .output()
            .ok()
            .map(|o| String::from_utf8_lossy(&o.stdout).to_string())
            .unwrap_or_default();

        let chipset = out
            .lines()
            .find(|l| l.trim().starts_with("Chipset Model:"))
            .map(|l| l.split(':').nth(1).unwrap_or("").trim().to_string())
            .unwrap_or_else(|| "알 수 없음".into());

        let apple_silicon = chipset.starts_with("Apple M");
        let nvidia = chipset.to_lowercase().contains("nvidia")
            || chipset.to_lowercase().contains("geforce");
        let amd = chipset.to_lowercase().contains("radeon") || chipset.to_lowercase().contains("amd");

        let (can, why) = if apple_silicon {
            (
                false,
                "애플 실리콘은 그래픽 성능은 좋지만, 레이븐(KAWPOW)을 캘 프로그램이 없습니다.                  T-Rex·NBMiner·GMiner는 전부 NVIDIA·AMD 전용입니다. 하드웨어가 아니라                  소프트웨어가 없는 것이라, 설정을 바꾼다고 되지 않습니다.",
            )
        } else if nvidia || amd {
            (
                true,
                "이 카드로 캘 수 있습니다. 다만 이 컴퓨터가 노드도 돌리고 있으면                  가게 화면이 느려집니다 — 채굴은 다른 기계에서 하세요.",
            )
        } else {
            (
                false,
                "레이븐 채굴에는 NVIDIA나 AMD 그래픽카드가 필요합니다.                  소형 PC·노트북 내장 그래픽으로는 안 됩니다.",
            )
        };

        return json!({
            "chipset": chipset,
            "can_mine": can,
            "why": why,
            "apple_silicon": apple_silicon,
        });
    }

    #[cfg(not(target_os = "macos"))]
    {
        json!({
            "chipset": "알 수 없음",
            "can_mine": true,
            "why": "NVIDIA나 AMD 그래픽카드가 있으면 캘 수 있습니다.",
            "apple_silicon": false,
        })
    }
}

/// Pools that list Ravencoin. Not an endorsement — a starting point.
#[tauri::command]
pub fn known_pools() -> Value {
    json!([
        { "name": "2Miners",    "url": "rvn.2miners.com:6060" },
        { "name": "WoolyPooly", "url": "pool.woolypooly.com:55555" },
        { "name": "HeroMiners", "url": "rvn.hero-miners.com:1145" },
        { "name": "Nanopool",   "url": "rvn-asia1.nanopool.org:12433" }
    ])
}

/// An address dedicated to mining payouts, so rewards are distinguishable.
///
/// The label is what separates "this came from the rig" from shop takings later
/// — the chain does not record who sent anything, so without a separate address
/// mining income and customer payments are the same undifferentiated deposits.
#[tauri::command]
pub async fn mining_address() -> Result<String, String> {
    crate::raven::new_address("mining".into()).await
}

/// Everything that has arrived at mining-labelled addresses.
#[tauri::command]
pub async fn mining_income(days: i64) -> Result<Value, String> {
    let txs = call_rpc("listtransactions", json!(["*", 500, 0, true])).await?;
    let list = txs.as_array().cloned().unwrap_or_default();

    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    let cutoff = now - days * 86_400;

    let mut total = 0.0;
    let mut count = 0u32;
    let mut last: Option<i64> = None;
    let mut rows = Vec::new();

    for tx in &list {
        if tx.get("category").and_then(Value::as_str) != Some("receive") {
            continue;
        }
        let label = tx.get("label").and_then(Value::as_str).unwrap_or("");
        // 풀이 보내주는 것과, 솔로로 직접 찾은 블록(generate/immature) 둘 다.
        let is_mining = label == "mining"
            || matches!(
                tx.get("category").and_then(Value::as_str),
                Some("generate") | Some("immature")
            );
        if !is_mining {
            continue;
        }
        let time = tx.get("time").and_then(Value::as_i64).unwrap_or(0);
        if time < cutoff {
            continue;
        }

        let amt = tx.get("amount").and_then(Value::as_f64).unwrap_or(0.0);
        total += amt;
        count += 1;
        if time > last.unwrap_or(0) {
            last = Some(time);
        }
        if rows.len() < 20 {
            rows.push(json!({
                "time": time,
                "amount": amt,
                "confirmations": tx.get("confirmations"),
                "address": tx.get("address"),
            }));
        }
    }

    let krw = crate::price::rvn_rate(crate::shop::currency())
        .await
        .ok()
        .and_then(|r| r["rate"].as_f64())
        .map(|r| total * r);

    Ok(json!({
        "days": days,
        "total_rvn": total,
        "total_krw": krw,
        "count": count,
        "last": last,
        "recent": rows,
    }))
}

/// A line the owner can paste into their miner.
///
/// Generated rather than written in a guide, because the address is the one
/// part that must not be typed by hand — a mistyped payout address sends a
/// month of mining to nobody, and it is not recoverable.
#[tauri::command]
pub fn miner_command(pool: String, address: String, worker: String, power: u32) -> Value {
    let w = if worker.trim().is_empty() {
        "shop".to_string()
    } else {
        worker.trim().replace(' ', "_")
    };
    let p = power.clamp(40, 100);

    // 전력 제한은 손해가 아니다. 카드를 70%로 묶으면 해시는 약 90% 남는데
    // 열과 팬 소음은 눈에 띄게 줄고, 와트당 수익은 오히려 올라간다.
    // 100%는 마지막 10%를 30% 더 쓰는 구간이라, 가게에서는 쓸 이유가 없다.
    let pl = if p >= 100 {
        String::new()
    } else {
        format!(" --pl {p}")
    };
    let nb_pl = if p >= 100 {
        String::new()
    } else {
        format!(" --power-limit {p}")
    };
    let gm_pl = if p >= 100 {
        String::new()
    } else {
        format!(" --pl {p}")
    };

    json!({
        "trex": format!("t-rex -a kawpow -o stratum+tcp://{pool} -u {address}.{w} -p x{pl}"),
        "nbminer": format!("nbminer -a kawpow -o stratum+tcp://{pool} -u {address}.{w}{nb_pl}"),
        "gminer": format!("miner --algo kawpow --server {pool} --user {address}.{w}{gm_pl}"),
        "note": "풀 주소와 포트는 쓰시는 풀의 안내를 따르세요. 주소 부분만 여기서 가져가시면 됩니다.",
        "power": p,
    })
}

/// What limiting the card actually costs and saves.
///
/// The curve is not linear: the last slice of clock speed costs far more power
/// than it returns in hash rate. Around 70% most cards keep roughly 90% of
/// their output, which is why a shop should never run at 100% — the noise and
/// heat are bought at the worst possible exchange rate.
#[tauri::command]
pub fn power_curve(power: u32) -> Value {
    let p = power.clamp(40, 100) as f64;
    // 대략적인 실측 곡선. 카드마다 다르지만 방향은 같다.
    let hash_ratio = match p as u32 {
        100 => 1.00,
        90..=99 => 0.98,
        80..=89 => 0.95,
        70..=79 => 0.90,
        60..=69 => 0.82,
        50..=59 => 0.70,
        _ => 0.55,
    };
    let noise = match p as u32 {
        90..=100 => "시끄럽습니다 — 카운터 옆에 두면 손님이 압니다",
        75..=89 => "들립니다",
        60..=74 => "조용한 편입니다",
        _ => "거의 안 들립니다",
    };

    json!({
        "power": p,
        "hash_ratio": hash_ratio,
        // 와트당 수익. 전력을 줄이면 이 값이 올라간다 — 그래서 제한이 손해가 아니다.
        "efficiency": hash_ratio / (p / 100.0),
        "noise": noise,
    })
}

/// Is anything mining into this node right now?
///
/// Solo mining needs a stratum proxy in front of the node; this reports what the
/// node itself sees so the screen can say "아무것도 연결돼 있지 않습니다"
/// instead of leaving someone waiting for a reward that was never coming.
#[tauri::command]
pub async fn mining_status() -> Result<Value, String> {
    let info = call_rpc("getmininginfo", json!([])).await?;
    Ok(json!({
        "blocks": info.get("blocks"),
        "difficulty": info.get("difficulty"),
        "network_hps": info.get("networkhashps"),
        "errors": info.get("errors"),
    }))
}

// ── 채굴기 켜고 끄기 ───────────────────────────────────────────────────────
//
// 지금까지 이 파일은 **명령어 문자열만 만들어 줬다.** 사장은 그걸 복사해
// 터미널을 열고 붙여넣어야 했고, 끄려면 그 창을 찾아 Ctrl-C 를 눌러야 했다.
// 터미널을 여는 순간 이건 더 이상 "노인도 쉬운" 프로그램이 아니다.
//
// ## 채굴기를 같이 넣지 않는 이유
//
// 채굴기 실행 파일은 각자 라이선스가 있고, 백신이 채굴기를 악성코드로 잡는
// 일이 흔하다. 우리 앱 안에 넣으면 앱 전체가 격리된다. 그래서 사장이 설치한
// 것을 **찾아서 돌린다** — 없으면 어디서 받는지 말해 준다(`mac_miners`).
//
// ## 앱을 끄면 채굴도 멈춘다
//
// 자식 프로세스로 띄우고 앱이 끝날 때 죽인다. 앱을 껐는데 전기만 계속 먹는
// 프로그램이 남아 있으면, 그건 사장이 모르는 사이 나가는 돈이다.

use std::io::{BufRead, BufReader};
use std::process::{Child, Command as ProcCommand, Stdio};
use std::sync::Mutex;

static MINER: Mutex<Option<Child>> = Mutex::new(None);
/// (시작 시각, 실행 파일, 마지막으로 읽은 줄)
static MINER_INFO: Mutex<Option<(i64, String, String)>> = Mutex::new(None);

fn now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// Where a miner might be, given people install these by hand.
fn find_miner(name: &str) -> Option<String> {
    if name.contains('/') {
        return std::path::Path::new(name).is_file().then(|| name.to_string());
    }
    let home = std::env::var("HOME").unwrap_or_default();
    let dirs = [
        "/opt/homebrew/bin".to_string(),
        "/usr/local/bin".to_string(),
        format!("{home}/Downloads"),
        format!("{home}/Applications"),
        format!("{home}/bin"),
    ];
    for d in dirs {
        let p = std::path::Path::new(&d).join(name);
        if p.is_file() {
            return Some(p.to_string_lossy().to_string());
        }
    }
    // PATH 에 있으면 그걸로.
    ProcCommand::new("which")
        .arg(name)
        .output()
        .ok()
        .filter(|o| o.status.success())
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

/// Is a miner running, and what has it said lately?
#[tauri::command]
pub fn miner_running() -> Value {
    let up = MINER.lock().map(|g| g.is_some()).unwrap_or(false);
    let info = MINER_INFO.lock().ok().and_then(|g| g.clone());
    match (up, info) {
        (true, Some((at, bin, last))) => json!({
            "running": true,
            "since": at,
            "minutes": (now() - at) / 60,
            "binary": bin,
            "last": last,
        }),
        _ => json!({ "running": false }),
    }
}

/// Starts the miner the owner installed.
///
/// `power` is a percentage the card is limited to. Not a detail: at 70% most
/// cards keep about 90% of their hash rate while the fan noise and the heat
/// drop noticeably — and a shop is a room with people in it.
#[tauri::command]
pub fn miner_start(
    binary: String,
    pool: String,
    address: String,
    worker: String,
    power: u32,
) -> Result<Value, String> {
    if MINER.lock().map(|g| g.is_some()).unwrap_or(false) {
        return Err("이미 채굴 중입니다.".into());
    }
    if address.trim().is_empty() {
        return Err("받을 주소가 없습니다. 주소 없이 캐면 그 몫은 아무에게도 가지 않습니다.".into());
    }
    if pool.trim().is_empty() {
        return Err("풀 주소가 필요합니다.".into());
    }
    let Some(path) = find_miner(binary.trim()) else {
        return Err(format!(
            "{} 을(를) 찾지 못했습니다. 내려받아 응용 프로그램이나 다운로드 폴더에 두세요.",
            binary.trim()
        ));
    };

    let w = if worker.trim().is_empty() { "shop" } else { worker.trim() };
    let p = power.clamp(40, 100);

    let mut args = vec![
        "-a".into(), "kawpow".into(),
        "-o".into(), format!("stratum+tcp://{}", pool.trim()),
        "-u".into(), format!("{}.{}", address.trim(), w.replace(' ', "_")),
        "-p".into(), "x".into(),
    ];
    if p < 100 {
        args.push("--pl".into());
        args.push(p.to_string());
    }

    let mut child = ProcCommand::new(&path)
        .args(&args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("채굴기를 켜지 못했습니다: {e}"))?;

    // 채굴기가 뱉는 줄을 계속 읽어 마지막 한 줄만 들고 있는다. 전부 모으면
    // 하루 만에 수십 메가가 되고, 사장이 보고 싶은 것은 지금 몇 해시인지다.
    if let Some(out) = child.stdout.take() {
        std::thread::spawn(move || {
            for line in BufReader::new(out).lines().map_while(Result::ok) {
                if let Ok(mut g) = MINER_INFO.lock() {
                    if let Some(v) = g.as_mut() {
                        v.2 = line;
                    }
                }
            }
        });
    }

    if let Ok(mut g) = MINER_INFO.lock() {
        *g = Some((now(), path.clone(), "켜는 중…".into()));
    }
    if let Ok(mut g) = MINER.lock() {
        *g = Some(child);
    }

    Ok(json!({
        "running": true,
        "binary": path,
        "power": p,
        "note": "앱을 끄면 채굴도 함께 멈춥니다.",
    }))
}

#[tauri::command]
pub fn miner_stop() -> Result<Value, String> {
    let mut was = false;
    if let Ok(mut g) = MINER.lock() {
        if let Some(mut c) = g.take() {
            let _ = c.kill();
            let _ = c.wait();
            was = true;
        }
    }
    if let Ok(mut g) = MINER_INFO.lock() {
        *g = None;
    }
    Ok(json!({ "running": false, "was_running": was }))
}

/// Kills the miner on the way out. Called from the app's exit handler.
///
/// Without this the miner survives the window closing and keeps drawing power
/// with nothing on screen to show for it — money leaving a shop that nobody
/// can see.
pub fn stop_on_exit() {
    let _ = miner_stop();
}
