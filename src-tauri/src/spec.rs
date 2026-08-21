//! 이 컴퓨터가 무엇을 감당할 수 있는가 — **묻지 말고 우리가 본다.**
//!
//! 사장에게 "IPFS 저장 용량을 몇 GB 로 하시겠습니까" 를 물으면 안 된다.
//! 그건 답을 아는 사람에게만 질문이고, 모르는 사람에게는 벽이다. 실제로
//! 설정 화면에 입력칸 24개·단추 31개가 쌓인 이유가 그것이다 — 판단을 하나씩
//! 사장에게 떠넘긴 결과다.
//!
//! 복잡함은 사라지지 않는다. 사장에게서 걷어내면 **여기서 우리가 떠안는다.**
//! 이 파일이 그 자리다.
//!
//! ## 왜 남의 라이브러리를 안 쓰나
//!
//! 사양 하나 읽자고 무거운 크레이트를 들이면 빌드가 느려지고 의존성이 는다.
//! 필요한 것은 세 가지뿐이고, 셋 다 OS 가 이미 알려준다.
//!
//! ## ⚠️ 읽지 못하면 `None` 이다
//!
//! **모르는 것을 0 으로 적지 않는다.** 메모리를 못 읽었는데 0 으로 두면
//! "메모리가 부족합니다" 가 되고, 멀쩡한 컴퓨터에서 사장이 겁먹는다.
//! 못 읽었으면 그 항목은 제안에서 빠지고, 안전한 쪽 기본값이 쓰인다.

use serde_json::{json, Value};

/// 코어 개수. 못 읽으면 `None`.
fn cores() -> Option<usize> {
    std::thread::available_parallelism().ok().map(|n| n.get())
}

/// 메모리 총량(GB). 못 읽으면 `None`.
fn memory_gb() -> Option<f64> {
    #[cfg(target_os = "macos")]
    {
        let out = std::process::Command::new("/usr/sbin/sysctl")
            .args(["-n", "hw.memsize"])
            .output()
            .ok()?;
        let bytes: u64 = String::from_utf8_lossy(&out.stdout).trim().parse().ok()?;
        return Some(bytes as f64 / 1_073_741_824.0);
    }
    #[cfg(target_os = "linux")]
    {
        let t = std::fs::read_to_string("/proc/meminfo").ok()?;
        let kb: f64 = t
            .lines()
            .find(|l| l.starts_with("MemTotal:"))?
            .split_whitespace()
            .nth(1)?
            .parse()
            .ok()?;
        return Some(kb / 1_048_576.0);
    }
    #[cfg(target_os = "windows")]
    {
        // wmic 은 최신 윈도우에서 빠지는 중이라 PowerShell 로 묻는다.
        let out = std::process::Command::new("powershell")
            .args([
                "-NoProfile",
                "-Command",
                "(Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory",
            ])
            .output()
            .ok()?;
        let bytes: u64 = String::from_utf8_lossy(&out.stdout).trim().parse().ok()?;
        return Some(bytes as f64 / 1_073_741_824.0);
    }
    #[allow(unreachable_code)]
    None
}

/// 데이터를 둘 곳의 남은 공간(GB). 못 읽으면 `None`.
///
/// 🔴 **`/` 가 아니라 우리가 실제로 쓸 폴더**를 본다. 외장 디스크에 두었는데
/// 시스템 디스크를 재면, 넉넉하다고 해 놓고 도중에 꽉 찬다. 체인 34GB 를
/// 받다가 멈추면 그 노드는 장사를 못 한다.
fn free_gb() -> Option<f64> {
    let dir = crate::paths::raven_dir();
    // 아직 없는 폴더면 그 위를 본다. 없는 경로를 재면 실패한다.
    let probe = if dir.exists() {
        dir
    } else {
        crate::paths::home()
    };

    #[cfg(unix)]
    {
        let out = std::process::Command::new("df")
            .args(["-k", &probe.to_string_lossy()])
            .output()
            .ok()?;
        let text = String::from_utf8_lossy(&out.stdout);
        // 헤더 다음 줄의 네 번째 칸이 남은 용량(KB)이다.
        let kb: f64 = text.lines().nth(1)?.split_whitespace().nth(3)?.parse().ok()?;
        return Some(kb / 1_048_576.0);
    }
    #[cfg(windows)]
    {
        let drive = probe.to_string_lossy().chars().take(2).collect::<String>();
        let out = std::process::Command::new("powershell")
            .args([
                "-NoProfile",
                "-Command",
                &format!("(Get-PSDrive {}).Free", drive.trim_end_matches(':')),
            ])
            .output()
            .ok()?;
        let bytes: f64 = String::from_utf8_lossy(&out.stdout).trim().parse().ok()?;
        return Some(bytes / 1_073_741_824.0);
    }
    #[allow(unreachable_code)]
    None
}

/// 레이븐코인 체인 전체가 차지하는 크기. 2026년 실측 기준 대략값이다.
///
/// ⚠️ 체인은 계속 자란다. 이 숫자가 낡으면 "넉넉합니다" 라고 해 놓고 반년 뒤
/// 디스크가 찬다. 그래서 아래 판단에서는 **여유분을 두 배로** 잡는다.
const CHAIN_GB: f64 = 34.0;

/// 이 컴퓨터를 보고 정한 설정.
///
/// 각 항목에 **왜 그렇게 정했는지**를 사람 말로 같이 담는다. 이유 없이
/// 정해진 값은 사장이 못 믿고, 못 믿으면 결국 고급 설정을 열어 헤맨다.
#[tauri::command]
pub fn suggest_setup() -> Value {
    let c = cores();
    let m = memory_gb();
    let f = free_gb();

    // ── 체인을 통째로 받을 것인가 ──────────────────────────────────────
    //
    // 통째로 받으면 아무에게도 안 물어보고 스스로 확인한다(그게 이 프로그램의
    // 핵심이다). 대신 34GB 와 반나절이 든다. 여유가 두 배는 있어야 권한다 —
    // 딱 맞게 권했다가 도중에 꽉 차면 그 노드는 장사를 못 한다.
    let full_chain = f.map(|g| g > CHAIN_GB * 2.0).unwrap_or(true);

    // ── 채굴 ───────────────────────────────────────────────────────────
    //
    // 🔴 **기본은 끔이다.** 채굴은 전기를 먹고 컴퓨터를 뜨겁게 한다. 장사하는
    // 컴퓨터가 느려지면 계산대가 느려지고, 그건 손님이 기다린다는 뜻이다.
    // 돈이 벌리는 것처럼 보여서 켜 두기 쉬운데, 전기값을 먼저 잃는다.
    let mining = false;

    // ── 계산대가 쓸 힘을 남긴다 ────────────────────────────────────────
    //
    // 코어를 전부 주면 주문 화면이 멈춘다. 절반만, 그리고 최소 1개.
    let spare = c.map(|n| (n / 2).max(1));

    // ── IPFS 저장 한도 ─────────────────────────────────────────────────
    //
    // 사진·메뉴판이 들어간다. 남은 공간의 10% 정도면 넘치지 않고, 가게 하나가
    // 쓰기엔 넉넉하다. 5GB 아래로는 내리지 않는다 — 그 아래면 사진 몇 장에
    // 차 버려서 "왜 사진이 안 올라가지" 가 된다.
    let ipfs_gb = f.map(|g| (g * 0.10).clamp(5.0, 50.0).round());

    let mut why: Vec<String> = Vec::new();
    match f {
        Some(g) if full_chain => why.push(format!(
            "빈 공간이 {:.0}GB 있어서, 블록체인 전부를 이 컴퓨터에 두기로 했습니다. \
             그래야 남에게 묻지 않고 스스로 결제를 확인합니다.",
            g
        )),
        Some(g) => why.push(format!(
            "빈 공간이 {:.0}GB 뿐입니다. 전부 받으면 {:.0}GB 가 필요해서 도중에 \
             꽉 찰 수 있습니다. 우선 가볍게 시작하고, 공간을 비우신 뒤에 바꾸셔도 됩니다.",
            g, CHAIN_GB
        )),
        // 못 읽었으면 못 읽었다고 한다. 아는 척하면 그게 더 나쁘다.
        None => why.push(
            "빈 공간을 읽지 못했습니다. 안전하게 전부 받는 쪽으로 두었습니다. \
             도중에 공간이 부족하면 알려 드립니다."
                .into(),
        ),
    }
    if let (Some(n), Some(s)) = (c, spare) {
        why.push(format!(
            "이 컴퓨터는 일꾼이 {n}명입니다. 그중 {s}명만 쓰고 나머지는 계산대에 \
             남겨 둡니다. 주문 화면이 느려지면 손님이 기다리게 되니까요."
        ));
    }
    if let Some(g) = m {
        if g < 8.0 {
            why.push(format!(
                "메모리가 {g:.0}GB 라 넉넉하지 않습니다. 다른 프로그램을 함께 \
                 켜 두시면 느려질 수 있습니다."
            ));
        }
    }
    why.push(
        "채굴은 꺼 두었습니다. 전기를 많이 쓰고 컴퓨터가 느려져서, 장사하는 \
         컴퓨터에는 권하지 않습니다. 나중에 고급 설정에서 켜실 수 있습니다."
            .into(),
    );

    json!({
        "seen": {
            "cores": c,
            "memory_gb": m.map(|g| (g * 10.0).round() / 10.0),
            "free_gb": f.map(|g| g.round()),
        },
        "suggest": {
            "full_chain": full_chain,
            "mining": mining,
            "miner_threads": spare,
            "ipfs_gb": ipfs_gb,
        },
        "why": why,
        // 사장이 처음에 반드시 해야 하는 일. 이 밖의 것은 나중에 해도 된다.
        "must_do": ["가게 이름", "메뉴 한 가지", "돈 받을 주소"],
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 🔴 **모르는 것을 0 으로 적지 않는다.** 메모리를 못 읽었는데 0 으로 두면
    /// "메모리가 부족합니다" 가 되고, 멀쩡한 컴퓨터에서 사장이 겁먹는다.
    #[test]
    fn unknown_is_null_never_zero() {
        let v = suggest_setup();
        for k in ["cores", "memory_gb", "free_gb"] {
            let x = &v["seen"][k];
            assert!(
                x.is_null() || x.as_f64().map(|n| n > 0.0).unwrap_or(false),
                "{k} 가 0 으로 적혔다 — 못 읽은 것과 없는 것은 다르다: {x}"
            );
        }
    }

    /// 채굴은 **꺼진 채로** 시작한다. 장사하는 컴퓨터가 뜨거워지고 느려지면
    /// 계산대가 느려지고, 그건 손님이 기다린다는 뜻이다.
    #[test]
    fn mining_never_starts_on_by_itself() {
        assert_eq!(suggest_setup()["suggest"]["mining"], json!(false));
    }

    /// 코어를 전부 채굴에 주면 주문 화면이 멈춘다. 반드시 남겨 둔다.
    #[test]
    fn the_till_always_keeps_some_cpu() {
        let v = suggest_setup();
        if let (Some(all), Some(use_)) = (
            v["seen"]["cores"].as_u64(),
            v["suggest"]["miner_threads"].as_u64(),
        ) {
            assert!(use_ >= 1, "일꾼을 0명 쓰면 아무것도 안 된다");
            assert!(use_ < all || all == 1, "코어를 전부 가져갔다: {use_}/{all}");
        }
    }

    /// 이유 없이 정해진 값은 사장이 못 믿고, 못 믿으면 고급 설정을 열어 헤맨다.
    #[test]
    fn every_suggestion_comes_with_a_reason_in_plain_korean() {
        let v = suggest_setup();
        let why = v["why"].as_array().expect("이유가 없다");
        assert!(!why.is_empty(), "제안만 있고 이유가 없다");
        for line in why {
            let t = line.as_str().unwrap_or("");
            assert!(t.len() > 10, "이유가 너무 짧다: {t}");
            // 사장이 모르는 낱말을 이유에 쓰면 이유가 아니다.
            for word in ["RPC", "assetindex", "txindex", "데몬", "포트"] {
                assert!(!t.contains(word), "이유에 어려운 낱말이 있다({word}): {t}");
            }
        }
    }

    /// 처음에 해야 할 일이 셋을 넘으면 그건 이미 어려운 설정이다.
    #[test]
    fn the_first_run_asks_for_three_things_at_most() {
        let v = suggest_setup();
        let must = v["must_do"].as_array().expect("must_do 가 없다");
        assert!(must.len() <= 3, "처음에 {}가지나 묻는다", must.len());
    }
}
