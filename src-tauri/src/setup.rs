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
/// 이 컴퓨터 이름. 못 읽으면 빈 문자열 — 지어내지 않는다.
fn machine_model() -> String {
    #[cfg(target_os = "macos")]
    {
        return sysctl("hw.model").unwrap_or_default();
    }
    #[cfg(target_os = "windows")]
    {
        return crate::quiet::cmd("powershell")
            .args(["-NoProfile", "-Command", "(Get-CimInstance Win32_ComputerSystem).Model"])
            .output()
            .ok()
            .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
            .unwrap_or_default();
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        return std::fs::read_to_string("/sys/devices/virtual/dmi/id/product_name")
            .map(|s| s.trim().to_string())
            .unwrap_or_default();
    }
}

/// 메모리 몇 GB인가.
fn memory_gb() -> Option<u64> {
    #[cfg(target_os = "macos")]
    {
        return sysctl("hw.memsize")
            .and_then(|v| v.parse::<u64>().ok())
            .map(|b| b / 1_073_741_824);
    }
    #[cfg(target_os = "windows")]
    {
        let out = crate::quiet::cmd("powershell")
            .args([
                "-NoProfile",
                "-Command",
                "(Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory",
            ])
            .output()
            .ok()?;
        let b: u64 = String::from_utf8_lossy(&out.stdout).trim().parse().ok()?;
        return Some(b / 1_073_741_824);
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let txt = std::fs::read_to_string("/proc/meminfo").ok()?;
        let kb: u64 = txt
            .lines()
            .find(|l| l.starts_with("MemTotal:"))?
            .split_whitespace()
            .nth(1)?
            .parse()
            .ok()?;
        return Some(kb / 1_048_576);
    }
}

/// 배터리가 있나 = 노트북인가. 채굴·연결 수를 정하는 데 쓴다.
fn has_battery() -> bool {
    #[cfg(target_os = "macos")]
    {
        return crate::quiet::cmd("pmset")
            .args(["-g", "batt"])
            .output()
            .ok()
            .map(|o| String::from_utf8_lossy(&o.stdout).contains("InternalBattery"))
            .unwrap_or(false);
    }
    #[cfg(target_os = "windows")]
    {
        // 배터리가 없는 데스크톱은 이 조회가 빈 값을 준다.
        return crate::quiet::cmd("powershell")
            .args([
                "-NoProfile",
                "-Command",
                "if (Get-CimInstance Win32_Battery) { 'yes' } else { 'no' }",
            ])
            .output()
            .ok()
            .map(|o| String::from_utf8_lossy(&o.stdout).trim() == "yes")
            .unwrap_or(false);
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        return std::path::Path::new("/sys/class/power_supply/BAT0").exists()
            || std::path::Path::new("/sys/class/power_supply/BAT1").exists();
    }
}

/// 빈 공간이 몇 GB인가. **세 시스템 다 다르게 물어야 한다.**
///
/// 🔴 여기가 `df -g /` 하나였다. 윈도우에는 `df` 도 `/` 도 없어서 **늘 0**이
/// 나왔고, 그래서 첫 화면의 「가게에만 씁니다」가 **「빈 공간이 0 GB뿐이라
/// 고를 수 없습니다」로 잠겨** 있었다. 34GB 짜리 체인이 이미 들어 있는
/// 컴퓨터에서도 그랬다.
///
/// 사장은 자기 컴퓨터가 멀쩡한데 왜 못 고르는지 알 길이 없다. 그리고 이건
/// 이 프로그램의 **첫 화면**이라, 여기서 막히면 그다음이 없다.
///
/// 오늘만 같은 병을 셋 봤다 — `df`, `sha256sum`, `brew install ipfs`.
/// 전부 「맥에서 짜고 맥에서만 시험한」 자리다.
fn free_space_gb() -> Option<u64> {
    #[cfg(target_os = "windows")]
    {
        // 앱이 실제로 쓸 드라이브를 본다. C: 가 꽉 차 있어도 자료는 D: 에
        // 있을 수 있다.
        let dir = crate::paths::app_dir();
        let drive = dir
            .to_string_lossy()
            .chars()
            .take(2)
            .collect::<String>();
        let drive = if drive.len() == 2 && drive.ends_with(':') {
            drive
        } else {
            "C:".to_string()
        };
        // `wmic` 은 최신 윈도우에서 빠지는 중이라 PowerShell 을 쓴다.
        let out = crate::quiet::cmd("powershell")
            .args([
                "-NoProfile",
                "-Command",
                &format!(
                    "(Get-PSDrive -Name {} ).Free",
                    drive.trim_end_matches(':')
                ),
            ])
            .output()
            .ok()?;
        let bytes: u64 = String::from_utf8_lossy(&out.stdout).trim().parse().ok()?;
        return Some(bytes / 1_073_741_824);
    }
    #[cfg(not(target_os = "windows"))]
    {
        // `-g` 는 맥의 GB 단위. 리눅스 coreutils 에는 없어서 `-BG` 를 쓴다.
        for args in [["-g", "/"], ["-BG", "/"]] {
            let out = match crate::quiet::cmd("df").args(args).output() {
                Ok(o) => o,
                Err(_) => continue,
            };
            let txt = String::from_utf8_lossy(&out.stdout);
            let n = txt
                .lines()
                .nth(1)
                .and_then(|l| l.split_whitespace().nth(3).map(|s| s.trim_end_matches('G').to_string()))
                .and_then(|s| s.parse::<u64>().ok());
            if let Some(v) = n {
                return Some(v);
            }
        }
        None
    }
}


/// Everything about this machine that changes what we should recommend.
#[tauri::command]
pub fn inspect_machine() -> Value {
    // 🔴 여기가 전부 맥 명령이었다(`sysctl`·`pmset`). 윈도우·리눅스에서는
    //    빈 값이 되어 **코어 4개·메모리 8GB·데스크톱**으로 넘어갔다. 실제
    //    기계가 무엇이든 같은 답이 나온 것이다. 첫 화면의 권유가 이 값으로
    //    정해지는데, 그러면 그 권유는 그냥 짐작이다.
    let model = machine_model();
    // 코어 수는 표준 라이브러리가 안다. 명령을 부를 이유가 없었다.
    let cores = std::thread::available_parallelism()
        .map(|n| n.get() as u32)
        .unwrap_or(4);
    let mem_gb = memory_gb().unwrap_or(8);
    // 배터리가 있으면 노트북이다. 모델 이름은 해마다 바뀌고 나라마다 다르다.
    let laptop = has_battery() || model.contains("MacBook") || model.contains("Laptop");

    let free_gb = free_space_gb()
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
    let home = crate::paths::home().to_string_lossy().to_string();
    let dir = crate::paths::raven_dir().to_string_lossy().to_string();

    let gb = |p: &str| -> u64 {
        // 🔴 `du` 는 윈도우에 없다. 거기서는 늘 0 이 나와서 화면이 「체인이
        //    0GB」 라고 말했다 — 34GB 가 들어 있는 컴퓨터에서도.
        #[cfg(target_os = "windows")]
            {
                // 🔴 처음엔 PowerShell 로 **재귀로** 훑게 했다. 44GB 짜리
                //    폴더에서 그게 몇 십 초가 걸리고, 이 명령은 async 가
                //    아니라 **화면 스레드에서 돈다** — 창이 통째로
                //    「응답하지 않습니다」가 된다. 실측으로 그랬다.
                //
                //    체인은 `blocks/` 에 blk*.dat 이 평평하게 깔린다.
                //    한 겹만 세면 충분하고, 그건 눈 깜짝할 사이다.
                let one = |d: &std::path::Path| -> u64 {
                    std::fs::read_dir(d)
                        .map(|rd| {
                            rd.flatten()
                                .filter_map(|e| e.metadata().ok())
                                .filter(|m| m.is_file())
                                .map(|m| m.len())
                                .sum::<u64>()
                        })
                        .unwrap_or(0)
                };
                let base = std::path::Path::new(p);
                return (one(base) + one(&base.join("blocks")) + one(&base.join("chainstate")))
                    / 1_073_741_824;
            }
            #[allow(unreachable_code)]
        crate::quiet::cmd("du")
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

#[cfg(test)]
mod space_tests {
    /// 🔴 이 값이 0 이면 첫 화면의 「가게에만 씁니다」가 잠긴다. 사장은
    ///    자기 컴퓨터가 멀쩡한데 왜 못 고르는지 알 길이 없고, 그게 이
    ///    프로그램의 **첫 화면**이라 거기서 끝난다. 윈도우에서 실제로 그랬다.
    #[test]
    fn 빈_공간이_0_이_아니다() {
        let v = super::free_space_gb();
        assert!(v.is_some(), "빈 공간을 아예 못 읽었다");
        assert!(v.unwrap() > 0, "0 GB 로 읽혔다 — 첫 화면이 잠긴다");
    }
}
