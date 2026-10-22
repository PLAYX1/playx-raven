//! **켜기 전 점검** — 디스크 남은 공간, 빈 메모리.
//!
//! 새 윈도우 PC 에서 노드가 블록 0 에서 멈춘 일이 있었다. 원인은 기록을 봐야 알지만,
//! 원인과 무관하게 「공간이 모자란다」「메모리를 너무 많이 잡았다」는 미리 알 수 있다.
//!
//! 🔴 못 재면 **아무 말도 안 한다.** 모르는 것을 「부족합니다」로 겁주지 않는다.
//! 🔴 켜기를 **막지 않는다.** 사장이 알고도 강행할 수 있어야 한다.

use serde_json::{json, Value};
use std::path::Path;

/// 장부에 들어가는 공간(GB). 「진행이 멈춰 있습니다」 안내의 「40GB 넘게 듭니다」와 같은 기준.
pub const NEED_DISK_GB: u64 = 40;
/// 메모리 자동 조절 범위(MB). 빈 메모리의 1/4 을 이 사이로 맞춘다.
pub const DBCACHE_MIN_MB: i64 = 450;
pub const DBCACHE_MAX_MB: i64 = 4096;

#[derive(Debug, PartialEq, Eq)]
pub enum DiskVerdict {
    Enough,
    Short,
    /// 재지 못함 — 말하지 않는다.
    Unknown,
}

/// 순수 판정. 필요한 양과 **같거나 많으면** 충분.
pub fn disk_verdict(free_gb: Option<u64>, need_gb: u64) -> DiskVerdict {
    match free_gb {
        None => DiskVerdict::Unknown,
        Some(f) if f >= need_gb => DiskVerdict::Enough,
        Some(_) => DiskVerdict::Short,
    }
}

/// 사장에게 보여 줄 문장. 부족할 때만 있다.
pub fn disk_message(free_gb: u64, need_gb: u64) -> String {
    format!("남은 공간이 부족합니다(현재 {free_gb}GB, 필요 약 {need_gb}GB)")
}

/// 순수 계산 — 빈 메모리(MB)로 dbcache(MB) 를 정한다.
/// 빈 메모리의 1/4, 최소 450, 최대 4096. 못 읽으면 `fallback` 그대로.
pub fn dbcache_for_free(free_mb: Option<u64>, fallback: i64) -> i64 {
    match free_mb {
        None => fallback,
        Some(f) => ((f / 4) as i64).clamp(DBCACHE_MIN_MB, DBCACHE_MAX_MB),
    }
}

/// `vm_stat` 글자에서 빈 메모리(MB). free + inactive + speculative 쪽수 × 쪽 크기.
pub fn parse_vm_stat(txt: &str) -> Option<u64> {
    let page: u64 = txt
        .lines()
        .next()?
        .split("page size of")
        .nth(1)?
        .split_whitespace()
        .next()?
        .parse()
        .ok()?;
    let get = |key: &str| -> u64 {
        txt.lines()
            .find(|l| l.starts_with(key))
            .and_then(|l| l.split(':').nth(1))
            .and_then(|v| v.trim().trim_end_matches('.').parse::<u64>().ok())
            .unwrap_or(0)
    };
    let pages = get("Pages free") + get("Pages inactive") + get("Pages speculative");
    if pages == 0 {
        return None;
    }
    Some(pages * page / 1_048_576)
}

/// `/proc/meminfo` 에서 MemAvailable(MB).
pub fn parse_meminfo_available(txt: &str) -> Option<u64> {
    let kb: u64 = txt
        .lines()
        .find(|l| l.starts_with("MemAvailable:"))?
        .split_whitespace()
        .nth(1)?
        .parse()
        .ok()?;
    Some(kb / 1024)
}

/// 윈도우 `FreePhysicalMemory`(KB) 글자에서 MB.
pub fn parse_free_kb(txt: &str) -> Option<u64> {
    let kb: u64 = txt.trim().trim_start_matches('\u{feff}').parse().ok()?;
    Some(kb / 1024)
}

/// 지금 시스템의 **빈 메모리**(MB). 못 읽으면 None.
pub fn free_memory_mb() -> Option<u64> {
    #[cfg(target_os = "macos")]
    {
        let out = crate::quiet::cmd("vm_stat").output().ok()?;
        return parse_vm_stat(&String::from_utf8_lossy(&out.stdout));
    }
    #[cfg(target_os = "windows")]
    {
        let out = crate::quiet::cmd("powershell")
            .args([
                "-NoProfile",
                "-Command",
                "(Get-CimInstance Win32_OperatingSystem).FreePhysicalMemory",
            ])
            .output()
            .ok()?;
        return parse_free_kb(&String::from_utf8_lossy(&out.stdout));
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        return parse_meminfo_available(&std::fs::read_to_string("/proc/meminfo").ok()?);
    }
}

/// 그 폴더가 있는 드라이브의 남은 공간(GB). 못 재면 None.
pub fn free_gb_at(dir: &Path) -> Option<u64> {
    #[cfg(target_os = "windows")]
    {
        let s = dir.to_string_lossy().to_string();
        let letter: String = s.chars().take(2).collect();
        if !(letter.len() == 2 && letter.ends_with(':')) {
            return None;
        }
        let out = crate::quiet::cmd("powershell")
            .args([
                "-NoProfile",
                "-Command",
                &format!("(Get-PSDrive -Name {}).Free", letter.trim_end_matches(':')),
            ])
            .output()
            .ok()?;
        let bytes: u64 = String::from_utf8_lossy(&out.stdout).trim().parse().ok()?;
        return Some(bytes / 1_073_741_824);
    }
    #[cfg(not(target_os = "windows"))]
    {
        // 폴더가 아직 없으면 있는 가장 가까운 윗 폴더를 잰다.
        let mut p = dir.to_path_buf();
        while !p.exists() {
            if !p.pop() {
                return None;
            }
        }
        let out = crate::quiet::cmd("df").arg("-k").arg(&p).output().ok()?;
        let txt = String::from_utf8_lossy(&out.stdout);
        let kb: u64 = txt.lines().nth(1)?.split_whitespace().nth(3)?.parse().ok()?;
        Some(kb / 1_048_576)
    }
}

/// 켜기 전 디스크 점검. 막지 않고 알려만 준다.
#[tauri::command]
pub async fn start_disk_check() -> Value {
    tauri::async_runtime::spawn_blocking(|| {
        let free = free_gb_at(&crate::paths::raven_dir());
        match disk_verdict(free, NEED_DISK_GB) {
            DiskVerdict::Short => {
                let f = free.unwrap_or(0);
                json!({ "known": true, "short": true, "free_gb": f, "need_gb": NEED_DISK_GB,
                        "message": disk_message(f, NEED_DISK_GB) })
            }
            DiskVerdict::Enough => json!({ "known": true, "short": false, "free_gb": free, "need_gb": NEED_DISK_GB }),
            DiskVerdict::Unknown => json!({ "known": false, "short": false }),
        }
    })
    .await
    .unwrap_or(json!({ "known": false, "short": false }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 디스크_충분_부족_모름() {
        assert_eq!(disk_verdict(Some(120), 40), DiskVerdict::Enough);
        assert_eq!(disk_verdict(Some(40), 40), DiskVerdict::Enough);
        assert_eq!(disk_verdict(Some(39), 40), DiskVerdict::Short);
        assert_eq!(disk_verdict(Some(0), 40), DiskVerdict::Short);
        assert_eq!(disk_verdict(None, 40), DiskVerdict::Unknown, "못 재면 말하지 않는다");
        assert_eq!(disk_message(12, 40), "남은 공간이 부족합니다(현재 12GB, 필요 약 40GB)");
    }

    #[test]
    fn 메모리_큰_PC_작은_PC_못_읽음() {
        assert_eq!(dbcache_for_free(Some(64_000), 2048), 4096, "큰 PC 는 최대 4096");
        assert_eq!(dbcache_for_free(Some(8_000), 2048), 2000);
        assert_eq!(dbcache_for_free(Some(1_000), 2048), 450, "작으면 최소 450");
        assert_eq!(dbcache_for_free(Some(0), 2048), 450);
        assert_eq!(dbcache_for_free(None, 2048), 2048, "못 읽으면 기존 값");
    }

    #[test]
    fn 빈_메모리_글자_읽기() {
        let vm = "Mach Virtual Memory Statistics: (page size of 16384 bytes)\n\
                  Pages free:                               1000.\n\
                  Pages inactive:                           2000.\n\
                  Pages speculative:                        1000.\n";
        assert_eq!(parse_vm_stat(vm), Some(4000 * 16384 / 1_048_576));
        assert_eq!(parse_vm_stat("엉뚱한 글자"), None);
        assert_eq!(parse_meminfo_available("MemTotal: 1 kB\nMemAvailable:    2097152 kB\n"), Some(2048));
        assert_eq!(parse_meminfo_available("MemTotal: 1 kB\n"), None);
        assert_eq!(parse_free_kb("\u{feff}1048576\r\n"), Some(1024));
        assert_eq!(parse_free_kb(""), None);
    }

    #[test]
    fn 안내_문구의_40GB_기준이_같다() {
        assert_eq!(NEED_DISK_GB, 40);
    }
}
