//! 노드가 **켜지는 중**에 지금 어디까지 왔는지 — `debug.log` 끝부분을 읽어 사람 말 한 줄로.
//!
//! ## 🔴 왜 생겼나 (11-12 신고 두 건, 윈도우 0.9.35 · 0.9.32)
//!
//! 느린 디스크에서 ravend 는 「블록 목록 읽기」 하나에 100초를 썼다(로그 07:16:01 → 07:17:41).
//! 그 뒤로 장부 열기·최근 블록 확인·지갑 열기가 몇 분씩 더 걸린다. 그런데 화면은
//! **60초가 지나면 무조건** 「노드가 안 켜졌어요. 기록과 함께 알리기」를 내밀었고,
//! 지갑 화면은 그냥 「안 열린다」만 말했다. 멀쩡히 켜지는 중인 노드를 고장으로 보고한 것이다.
//!
//! 이제 노드가 스스로 적는 줄(`init message: …`, `Opening LevelDB in …`, `Verifying …`,
//! `Loading wallet…`, `Rescanning…`, `UpdateTip … progress=`)을 읽어 **지금 단계**를 말하고,
//! 「알리기」는 **기록이 5분 넘게 안 늘었을 때** 또는 **노드가 오류를 남기고 멈췄을 때**만 낸다.
//!
//! 판단은 순수 함수(`parse_boot`)가 하고 시험이 지킨다. 파일 읽기는 끝 256KB 만.

use serde_json::{json, Value};

/// 이만큼 기록이 안 늘면 「멈춘 것 같다」고 말한다. 느린 디스크의 「블록 목록 읽기」가 100초였다 —
/// 넉넉히 세 배 넘게 잡는다.
pub const STALL_SECS: i64 = 5 * 60;

/// 끝에서 읽는 양. 켜지는 동안의 줄은 수백 줄이라 충분하다(파일 전체는 수백 MB 가 되기도 한다).
const TAIL_BYTES: u64 = 256 * 1024;

#[derive(Debug, Clone, PartialEq)]
pub struct BootRead {
    /// 단계 열쇠(시험·화면 분기용). `unknown` = 읽을 줄이 없다.
    pub phase: &'static str,
    /// 단계의 사람 말(한국어).
    pub say: String,
    /// 마지막으로 켜기 시작한 시각(UTC 초). 기록에 시작 줄이 없으면 `None`.
    pub started_at: Option<i64>,
    /// 시작 뒤 마지막 줄의 시각(UTC 초).
    pub last_at: Option<i64>,
    /// `UpdateTip … progress=` / `Loaded best chain … progress=` 에서 읽은 0~1.
    pub progress: Option<f64>,
    /// 켜기 시작했고, 아직 다 켜지지도(Done Loading) 꺼지지도 않았다.
    pub booting: bool,
    /// 켜기를 마쳤다(`Done Loading`).
    pub done: bool,
    /// 시작 뒤에 꺼졌다(`Shutdown: done` · `… Exiting.`).
    pub exited: bool,
    /// 시작 뒤(다 켜지기 전이거나 꺼졌을 때) 남긴 마지막 오류 줄 — 가린 뒤.
    pub error: Option<String>,
}

/// 줄 앞의 시각 `2026-11-12 07:16:01` (또는 `2026-11-12T07:16:01Z`) → UTC 초. 코어는 UTC 로 적는다.
pub fn line_time(line: &str) -> Option<i64> {
    let b = line.as_bytes();
    if b.len() < 19 {
        return None;
    }
    let num = |r: std::ops::Range<usize>| -> Option<i64> {
        let s = line.get(r)?;
        if s.bytes().all(|c| c.is_ascii_digit()) { s.parse().ok() } else { None }
    };
    if b[4] != b'-' || b[7] != b'-' || !(b[10] == b' ' || b[10] == b'T') || b[13] != b':' || b[16] != b':' {
        return None;
    }
    let (y, mo, d) = (num(0..4)?, num(5..7)?, num(8..10)?);
    let (h, mi, s) = (num(11..13)?, num(14..16)?, num(17..19)?);
    if !(1..=12).contains(&mo) || !(1..=31).contains(&d) || h > 23 || mi > 59 || s > 60 {
        return None;
    }
    // 그레고리력 날짜 → 1970-01-01 부터의 날 수(Howard Hinnant 의 days_from_civil).
    let y2 = if mo <= 2 { y - 1 } else { y };
    let era = if y2 >= 0 { y2 } else { y2 - 399 } / 400;
    let yoe = y2 - era * 400;
    let mp = (mo + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    Some(days * 86_400 + h * 3600 + mi * 60 + s)
}

/// `progress=0.999123` 의 숫자.
fn progress_of(line: &str) -> Option<f64> {
    let i = line.find("progress=")? + "progress=".len();
    let rest = &line[i..];
    let end = rest.find(|c: char| !(c.is_ascii_digit() || c == '.')).unwrap_or(rest.len());
    rest[..end].parse::<f64>().ok().filter(|p| p.is_finite() && (0.0..=1.0).contains(p))
}

/// 이 줄이 무슨 단계를 알리나. 모르는 줄이면 `None`(앞 단계를 그대로 둔다).
fn phase_of(line: &str) -> Option<(&'static str, &'static str)> {
    let has = |s: &str| line.contains(s);
    if has("Loading block index") {
        return Some(("block_index", "블록 목록 읽는 중"));
    }
    if has("Opening LevelDB in") {
        let low = line.to_ascii_lowercase();
        if low.contains("chainstate") {
            return Some(("chainstate", "장부(코인 상태) 여는 중"));
        }
        if ["assets", "messages", "restricted", "rewards", "myrestricted"].iter().any(|k| low.contains(k)) {
            return Some(("assets", "자산 장부 여는 중"));
        }
        return Some(("block_index", "블록 목록 읽는 중"));
    }
    if has("Rewinding blocks") {
        return Some(("rewinding", "장부를 정리하는 중"));
    }
    if has("Verifying blocks") || has("Verifying last") {
        return Some(("verifying", "최근 블록 확인하는 중"));
    }
    if has("Verifying wallet") {
        return Some(("wallet_check", "지갑 파일 확인하는 중"));
    }
    if has("Rescanning") {
        return Some(("rescan", "지갑 기록 다시 훑는 중"));
    }
    if has("Loading wallet") || has("Zapping all transactions") {
        return Some(("wallet", "지갑 여는 중"));
    }
    if has("Pruning blockstore") {
        return Some(("pruning", "오래된 블록 정리하는 중"));
    }
    if has("Loading P2P addresses") || has("Loading banlist") || has("Starting network threads") {
        return Some(("network", "네트워크 연결 준비하는 중"));
    }
    if has("Scanning Asset Transactions") {
        return Some(("channels", "메시지 채널 훑는 중"));
    }
    None
}

/// 노드가 「오류」라고 적은 줄인가. (타임스탬프 뒤의 첫 낱말로 본다.)
fn is_error_line(line: &str) -> bool {
    let body = if line_time(line).is_some() { line.get(19..).unwrap_or("") } else { line };
    let body = body.trim_start_matches(|c: char| c.is_ascii_digit() || c == '.' || c == 'Z').trim_start();
    body.starts_with("Error:") || body.starts_with("ERROR:") || body.starts_with("EXCEPTION:")
        || body.contains("Corrupted block database") || body.contains("Fatal LevelDB error")
}

/// 기록 끝부분을 읽어 지금 어디까지 왔는지 판단한다. 순수 함수.
pub fn parse_boot(tail: &str) -> BootRead {
    let lines: Vec<&str> = tail.lines().collect();
    // 마지막 시작 줄. 그 앞은 지난번 켜기의 일이다.
    let start = lines.iter().rposition(|l| l.contains("Raven version") || l.contains("Raven Core version"));
    let mut r = BootRead {
        phase: "unknown",
        say: String::new(),
        started_at: None,
        last_at: None,
        progress: None,
        booting: false,
        done: false,
        exited: false,
        error: None,
    };
    let from = start.unwrap_or(0);
    if let Some(i) = start {
        r.started_at = line_time(lines[i]);
        r.phase = "starting";
        r.say = "켜기 시작".into();
        r.booting = true;
    }
    let mut stopping = false;
    for l in &lines[from..] {
        if let Some(t) = line_time(l) {
            r.last_at = Some(t);
        }
        if let Some(p) = progress_of(l) {
            if l.contains("UpdateTip") || l.contains("Loaded best chain") {
                r.progress = Some(p);
            }
        }
        if start.is_none() {
            continue; // 시작 줄이 없으면 시각·진행률만 본다
        }
        if is_error_line(l) {
            r.error = Some(l.trim().to_string());
        }
        if l.contains("Done Loading") {
            r.done = true;
            r.booting = false;
            r.phase = "catching_up";
            r.say = "따라잡는 중".into();
            continue;
        }
        if l.contains("PrepareShutdown: In progress") || l.contains("Shutdown requested") {
            stopping = true;
        }
        if l.contains("Shutdown: done") || l.trim_end().ends_with("Exiting.") {
            r.exited = true;
            r.booting = false;
            r.phase = "exited";
            r.say = "꺼짐".into();
            continue;
        }
        if r.exited || r.done {
            continue;
        }
        if let Some((k, s)) = phase_of(l) {
            r.phase = k;
            r.say = s.into();
        }
    }
    if stopping && !r.exited {
        r.booting = false;
        r.phase = "stopping";
        r.say = "꺼지는 중".into();
    }
    if r.phase == "catching_up" {
        if let Some(p) = r.progress {
            r.say = format!("따라잡는 중 {:.1}%", p * 100.0);
        }
    }
    // 다 켜진 뒤의 「ERROR: AcceptToMemoryPool …」 같은 줄은 평소에도 나온다 — 그건 말하지 않는다.
    if r.done && !r.exited {
        r.error = None;
    }
    r
}

/// 노드가 남긴 오류 줄을 사장이 알아들을 말로. 모르는 것은 지어내지 않는다.
pub fn error_say(line: &str) -> &'static str {
    let low = line.to_ascii_lowercase();
    if low.contains("disk space") {
        return "디스크 공간이 모자라서 노드가 멈췄어요. 공간을 비운 뒤 다시 켜 주세요.";
    }
    if low.contains("corrupted block database") || low.contains("irrecoverable inconsistency") {
        return "장부가 깨져서 노드가 멈췄어요. 노드 화면의 「장부 고치기」로 고칠 수 있어요.";
    }
    if low.contains("out of memory") || low.contains("bad_alloc") {
        return "메모리가 모자라서 노드가 멈췄어요. 다른 프로그램을 닫고 다시 켜 주세요.";
    }
    if low.contains("error opening block database") || low.contains("error loading block database") || low.contains("fatal leveldb") {
        return "블록 장부 파일을 열지 못해서 노드가 멈췄어요. 디스크 상태를 확인해 주세요.";
    }
    if low.contains("rebuild the database") || low.contains("-reindex") {
        return "장부를 다시 만들어야 해서 노드가 멈췄어요. 노드 화면에서 안내를 따라 주세요.";
    }
    "노드가 오류를 남기고 멈췄어요."
}

/// 화면에 줄 모양. `now` 는 UTC 초, `mtime` 은 기록 파일이 마지막으로 바뀐 시각(UTC 초).
pub fn view(r: &BootRead, now: i64, mtime: Option<i64>, hide_lines: bool) -> Value {
    // 마지막으로 노드가 무언가를 적은 때 — 줄의 시각과 파일 시각 중 늦은 쪽(시계가 틀려도 버틴다).
    let last = match (r.last_at, mtime) {
        (Some(a), Some(b)) => Some(a.max(b)),
        (a, b) => a.or(b),
    };
    let quiet = last.map(|t| (now - t).max(0));
    let elapsed = r.started_at.map(|t| (now - t).max(0));
    let stalled = r.booting && quiet.is_some_and(|q| q >= STALL_SECS);
    let error = if hide_lines { None } else { r.error.as_deref().map(|l| crate::report_log::redact_line(&crate::words_restore::mask_line(l))) };
    json!({
        "phase": r.phase,
        "say": r.say,
        "booting": r.booting,
        "done": r.done,
        "exited": r.exited,
        "progress": r.progress,
        "elapsed_secs": elapsed,
        "quiet_secs": quiet,
        "stalled": stalled,
        "stall_secs": STALL_SECS,
        "error": error,
        "error_say": r.error.as_deref().map(error_say),
    })
}

fn read_tail(p: &std::path::Path) -> Option<(String, Option<i64>)> {
    use std::io::{Read, Seek, SeekFrom};
    let meta = std::fs::metadata(p).ok()?;
    let mtime = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs() as i64);
    let mut f = std::fs::File::open(p).ok()?;
    f.seek(SeekFrom::Start(meta.len().saturating_sub(TAIL_BYTES))).ok()?;
    let mut buf = Vec::new();
    f.take(TAIL_BYTES).read_to_end(&mut buf).ok()?;
    Some((String::from_utf8_lossy(&buf).into_owned(), mtime))
}

/// 노드가 켜지는 중 지금 어디인지. 기록이 없으면 `known: false`.
#[tauri::command(async)]
pub fn node_boot_progress() -> Value {
    let p = crate::paths::raven_dir().join("debug.log");
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    match read_tail(&p) {
        Some((text, mtime)) => {
            let mut v = view(&parse_boot(&text), now, mtime, crate::words_restore::log_hidden());
            v["known"] = json!(true);
            v
        }
        None => json!({ "known": false, "booting": false, "stalled": false, "phase": "unknown", "say": "" }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 11-12 신고 그대로 — 느린 디스크에서 블록 목록 읽기에 100초, 그 뒤 장부 여는 중에 기록이 끊겼다.
    const SLOW_DISK: &str = "\
2026-11-12 07:16:01 Raven version v4.8.0.0-a1b2c3d
2026-11-12 07:16:01 init message: Verifying wallet(s)...
2026-11-12 07:16:02 Using BerkeleyDB version Berkeley DB 4.8.30
2026-11-12 07:16:02 init message: Loading block index...
2026-11-12 07:16:02 Opening LevelDB in C:\\Users\\kim\\AppData\\Roaming\\Raven\\blocks\\index
2026-11-12 07:17:41 LoadBlockIndexDB: last block file = 512
2026-11-12 07:17:41 LoadBlockIndexDB(): transaction index disabled
2026-11-12 07:17:42 Opening LevelDB in C:\\Users\\kim\\AppData\\Roaming\\Raven\\chainstate
";

    #[test]
    fn 시각을_utc_초로_읽는다() {
        assert_eq!(line_time("1970-01-01 00:00:00 x"), Some(0));
        assert_eq!(line_time("2026-11-12 07:16:01 Raven version"), Some(1_794_467_761));
        assert_eq!(line_time("2026-11-12T07:16:01Z init message"), Some(1_794_467_761));
        assert_eq!(line_time("init message: Loading"), None);
        assert_eq!(line_time("2026-13-12 07:16:01 x"), None);
    }

    #[test]
    fn 느린_디스크_장부_여는_중은_켜지는_중이다() {
        let r = parse_boot(SLOW_DISK);
        assert!(r.booting && !r.done && !r.exited);
        assert_eq!(r.phase, "chainstate");
        assert_eq!(r.say, "장부(코인 상태) 여는 중");
        assert_eq!(r.error, None);
        let start = line_time("2026-11-12 07:16:01 ").unwrap();
        let last = line_time("2026-11-12 07:17:42 ").unwrap();
        assert_eq!((r.started_at, r.last_at), (Some(start), Some(last)));
        // 2분 뒤: 아직 알리기 단추를 내지 않는다.
        let v = view(&r, last + 120, Some(last), false);
        assert_eq!(v["stalled"], false);
        assert_eq!(v["elapsed_secs"], 221);
        // 48분 뒤(신고가 온 때): 5분 넘게 기록이 없으니 「멈춘 것 같다」.
        let v = view(&r, last + 48 * 60, Some(last), false);
        assert_eq!(v["stalled"], true);
    }

    #[test]
    fn 블록_목록_읽기_100초는_멈춘_것이_아니다() {
        let tail: String = SLOW_DISK.lines().take(5).map(|l| format!("{l}\n")).collect();
        let r = parse_boot(&tail);
        assert_eq!(r.phase, "block_index");
        assert_eq!(r.say, "블록 목록 읽는 중");
        let t = line_time("2026-11-12 07:16:02 ").unwrap();
        assert_eq!(view(&r, t + 100, Some(t), false)["stalled"], false);
        // 파일 시각이 더 최근이면 그쪽을 믿는다(줄 시각이 틀린 컴퓨터).
        assert_eq!(view(&r, t + 600, Some(t + 590), false)["stalled"], false);
    }

    #[test]
    fn 단계를_차례로_따라간다() {
        let mut log = String::from(SLOW_DISK);
        log.push_str("2026-11-12 07:19:00 init message: Verifying blocks...\n");
        assert_eq!(parse_boot(&log).phase, "verifying");
        log.push_str("2026-11-12 07:19:30 init message: Loading wallet...\n");
        assert_eq!(parse_boot(&log).say, "지갑 여는 중");
        log.push_str("2026-11-12 07:20:00 init message: Rescanning...\n");
        assert_eq!(parse_boot(&log).phase, "rescan");
        log.push_str("2026-11-12 07:25:00 init message: Done Loading\n");
        log.push_str("2026-11-12 07:25:01 UpdateTip: new best=00ab height=4512345 version=0x30000000 log2_work=70.1 tx=1 date='2026-11-11 12:00:00' progress=0.998765 cache=12.0MiB(9txo)\n");
        let r = parse_boot(&log);
        assert!(r.done && !r.booting);
        assert_eq!(r.phase, "catching_up");
        assert_eq!(r.say, "따라잡는 중 99.9%");
        assert_eq!(r.progress, Some(0.998765));
        // 다 켜진 뒤에는 기록이 멎어도 「멈췄다」고 하지 않는다(켜지는 중이 아니다).
        assert_eq!(view(&r, line_time("2026-11-12 09:00:00 ").unwrap(), None, false)["stalled"], false);
    }

    #[test]
    fn 오류를_남기고_꺼졌으면_그_줄을_준다() {
        let log = format!(
            "{SLOW_DISK}2026-11-12 07:18:00 init message: Verifying blocks...\n\
             2026-11-12 07:18:05 ERROR: VerifyDB(): *** irrecoverable inconsistency at 732975\n\
             2026-11-12 07:18:05 : Corrupted block database detected.\n\
             2026-11-12 07:18:05 Aborted block database rebuild. Exiting.\n\
             2026-11-12 07:18:06 Shutdown: done\n"
        );
        let r = parse_boot(&log);
        assert!(r.exited && !r.booting);
        assert!(r.error.as_deref().unwrap().contains("Corrupted block database"));
        assert!(error_say(r.error.as_deref().unwrap()).contains("장부가 깨져서"));
        let v = view(&r, line_time("2026-11-12 08:00:00 ").unwrap(), None, false);
        assert_eq!(v["exited"], true);
        assert_eq!(v["stalled"], false);
        // 사용자 폴더 이름은 가린다.
        let disk = "2026-11-12 07:18:05 Error: Disk space is low! C:\\Users\\kim\\AppData";
        let v = view(&parse_boot(&format!("{SLOW_DISK}{disk}\n2026-11-12 07:18:06 Shutdown: done\n")), 0, None, false);
        assert!(!v["error"].as_str().unwrap().contains("kim"));
        assert!(v["error_say"].as_str().unwrap().contains("디스크 공간"));
        // 되살리는 중이면 오류 줄 자체를 내보내지 않는다.
        assert_eq!(view(&r, 0, None, true)["error"], Value::Null);
    }

    #[test]
    fn 지난번_켜기의_일은_섞지_않는다() {
        let log = format!(
            "2026-11-10 01:00:00 Raven version v4.8.0\n\
             2026-11-10 01:00:05 Error: Disk space is low!\n\
             2026-11-10 01:00:06 Shutdown: done\n{SLOW_DISK}"
        );
        let r = parse_boot(&log);
        assert!(r.booting && !r.exited);
        assert_eq!(r.error, None);
        assert_eq!(r.started_at, line_time("2026-11-12 07:16:01 "));
    }

    #[test]
    fn 다_켜진_뒤의_평소_오류는_말하지_않는다() {
        let log = format!("{SLOW_DISK}2026-11-12 07:25:00 init message: Done Loading\n2026-11-12 07:26:00 ERROR: AcceptToMemoryPool: rejected\n");
        assert_eq!(parse_boot(&log).error, None);
    }

    #[test]
    fn 꺼지는_중과_빈_기록() {
        let r = parse_boot(&format!("{SLOW_DISK}2026-11-12 07:18:00 PrepareShutdown: In progress...\n"));
        assert_eq!(r.phase, "stopping");
        assert!(!r.booting);
        let e = parse_boot("");
        assert_eq!(e.phase, "unknown");
        assert!(!e.booting);
        // 시작 줄이 끝부분에 없으면(오래 돌던 노드) 켜지는 중으로 치지 않는다.
        let old = parse_boot("2026-11-12 07:25:01 UpdateTip: new best=00 height=1 progress=1.000000 cache=1\n");
        assert!(!old.booting);
        assert_eq!(old.progress, Some(1.0));
    }
}
