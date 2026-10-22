//! 문제 알리기에 붙이는 **노드 기록(debug.log)** — 읽기와 가리기.
//!
//! 🔴 원칙: 기록은 **보내기 전에 가려서** 화면에 그대로 보여 주고, 사장이 체크했을 때만 간다.
//! 가린 결과가 곧 보내는 글자다. (미리보기와 전송이 같은 함수를 쓴다.)
//!
//! 가리는 것: 사용자 이름이 든 경로 · IP 주소 · 지갑 주소처럼 생긴 글자 · 긴 hex/영숫자 ·
//! 12단어 이상 이어진 영어 낱말 · 열쇠/암호/단어와 관련된 낱말이 든 줄 전체.
//! 완벽하지 않다. 못 잡는 것은 보고서에 적어 둔다.

use std::io::{Read, Seek, SeekFrom};

/// 가린 자리에 쓰는 글자.
pub const MASK: &str = "<가림>";
const IP: &str = "<ip>";
const USER: &str = "<사용자>";

/// 마지막 몇 줄 / 몇 바이트까지 보내는가.
pub const MAX_LINES: usize = 100;
pub const MAX_BYTES: usize = 20 * 1024;
/// 한 줄이 이보다 길면 자른다(가린 뒤에 자른다 — 먼저 자르면 반쪽 주소가 남는다).
const MAX_LINE_CHARS: usize = 400;
/// 파일 끝에서 이만큼만 읽는다. 이 파일은 수백 MB 가 되기도 한다.
const READ_TAIL_BYTES: u64 = 160 * 1024;

/// 이 낱말이 든 줄은 통째로 가린다.
const SENSITIVE: &[&str] = &[
    "rpcpassword", "rpcauth", "rpcuser", "token", "key", "seed", "mnemonic", "passw", "secret",
    "cookie", "wif", "xprv", "bearer", "authorization",
];

fn is_base58(c: char) -> bool {
    c.is_ascii_alphanumeric() && !matches!(c, '0' | 'O' | 'I' | 'l')
}

/// 사용자 이름 자리를 `<사용자>` 로. `C:\Users\이름\…` · `/Users/이름/…` · `/home/이름/…`.
fn redact_paths(line: &str) -> String {
    let mut s = line.to_string();
    for marker in ["\\Users\\", "/Users/", "/home/", "\\users\\", "/users/", "\\home\\"] {
        let mut out = String::with_capacity(s.len());
        let mut rest = s.as_str();
        while let Some(i) = rest.find(marker) {
            let after = i + marker.len();
            out.push_str(&rest[..after]);
            let tail = &rest[after..];
            // 이름은 다음 구분자(\ / 따옴표)나 줄 끝까지.
            let end = tail
                .find(|c: char| matches!(c, '\\' | '/' | '"' | '\''))
                .unwrap_or(tail.len());
            if end == 0 {
                rest = tail;
                continue;
            }
            out.push_str(USER);
            rest = &tail[end..];
        }
        out.push_str(rest);
        s = out;
    }
    s
}

/// 소문자 영어 낱말(3~8자)이 12개 이상 공백으로 이어지면 시드처럼 보아 가린다.
fn redact_word_runs(line: &str) -> String {
    let toks: Vec<&str> = line.split(' ').collect();
    let is_w = |t: &str| (3..=8).contains(&t.len()) && t.bytes().all(|b| b.is_ascii_lowercase());
    let mut out: Vec<String> = Vec::new();
    let mut i = 0;
    while i < toks.len() {
        if is_w(toks[i]) {
            let mut j = i;
            while j < toks.len() && is_w(toks[j]) {
                j += 1;
            }
            if j - i >= 12 {
                out.push(MASK.to_string());
            } else {
                out.extend(toks[i..j].iter().map(|t| t.to_string()));
            }
            i = j;
        } else {
            out.push(toks[i].to_string());
            i += 1;
        }
    }
    out.join(" ")
}

fn is_ipv4(s: &str) -> bool {
    let host = s.split(':').next().unwrap_or("");
    let parts: Vec<&str> = host.split('.').collect();
    parts.len() == 4
        && parts
            .iter()
            .all(|p| !p.is_empty() && p.len() <= 3 && p.bytes().all(|b| b.is_ascii_digit()) && p.parse::<u16>().map_or(false, |n| n <= 255))
        && (s.matches(':').count() <= 1)
}

fn is_ipv6(s: &str) -> bool {
    let colons = s.matches(':').count();
    // 시각(09:12:33)과 헷갈리지 않게 「::」 이 있거나 완전한 8묶음일 때만.
    if !(s.contains("::") || colons == 7) || colons < 2 {
        return false;
    }
    s.split(':').all(|g| g.len() <= 4 && g.bytes().all(|b| b.is_ascii_hexdigit()))
}

/// 지갑 주소·긴 hex·긴 영숫자.
fn mask_alnum_run(run: &str) -> bool {
    let n = run.len();
    if n >= 32 {
        return true; // 긴 hex · 개인키(WIF 51~52자) · 기타
    }
    if (26..=35).contains(&n) && run.starts_with('R') && run.chars().all(is_base58) {
        return true; // 레이븐 주소
    }
    if n >= 26 && run.chars().all(|c| c.is_ascii_alphanumeric()) {
        let l = run.to_ascii_lowercase();
        if l.starts_with("bc1") || l.starts_with("tb1") || l.starts_with("rvn1") {
            return true;
        }
    }
    if n == 42 && (run.starts_with("0x") || run.starts_with("0X")) {
        return true;
    }
    false
}

fn redact_tokens(line: &str) -> String {
    // 1) IP: [0-9A-Fa-f:.] 덩어리 단위로 본다.
    let mut out = String::with_capacity(line.len());
    let chars: Vec<char> = line.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        if c.is_ascii_hexdigit() || c == ':' || c == '.' {
            let mut j = i;
            while j < chars.len() && (chars[j].is_ascii_hexdigit() || chars[j] == ':' || chars[j] == '.') {
                j += 1;
            }
            let run: String = chars[i..j].iter().collect();
            let core = run.trim_end_matches(|c| c == '.' || c == ':');
            let trail = &run[core.len()..];
            if is_ipv4(core) || is_ipv6(core) {
                out.push_str(IP);
                out.push_str(trail);
            } else {
                out.push_str(&run);
            }
            i = j;
        } else {
            out.push(c);
            i += 1;
        }
    }
    // 2) 영숫자 덩어리: 주소·긴 hex.
    let mut res = String::with_capacity(out.len());
    let mut run = String::new();
    let flush = |run: &mut String, res: &mut String| {
        if !run.is_empty() {
            if mask_alnum_run(run) {
                res.push_str(MASK);
            } else {
                res.push_str(run);
            }
            run.clear();
        }
    };
    for c in out.chars() {
        if c.is_ascii_alphanumeric() {
            run.push(c);
        } else {
            flush(&mut run, &mut res);
            res.push(c);
        }
    }
    flush(&mut run, &mut res);
    res
}

/// 한 줄을 가린다.
pub fn redact_line(line: &str) -> String {
    let low = line.to_ascii_lowercase();
    if SENSITIVE.iter().any(|w| low.contains(w)) {
        return MASK.to_string();
    }
    let s = redact_paths(line);
    let s = redact_word_runs(&s);
    redact_tokens(&s)
}

fn clip_line(s: &str) -> String {
    if s.chars().count() > MAX_LINE_CHARS {
        let mut t: String = s.chars().take(MAX_LINE_CHARS).collect();
        t.push('…');
        t
    } else {
        s.to_string()
    }
}

/// 글 전체에서 **마지막 `max_lines` 줄**을 가려 돌려준다. 합이 `max_bytes` 를 넘으면
/// 오래된 줄부터 버린다(최신 줄이 중요하다).
pub fn redact_tail(text: &str, max_lines: usize, max_bytes: usize) -> String {
    let lines: Vec<&str> = text.lines().collect();
    let start = lines.len().saturating_sub(max_lines);
    let mut kept: Vec<String> = Vec::new();
    let mut total = 0usize;
    for l in lines[start..].iter().rev() {
        let r = clip_line(&crate::words_restore::mask_line(&redact_line(l)));
        let add = r.len() + 1;
        if total + add > max_bytes {
            break;
        }
        total += add;
        kept.push(r);
    }
    kept.reverse();
    kept.join("\n")
}

/// 파일 끝에서 읽어 가린다. 못 읽거나 비었으면 조용히 `None`.
pub fn read_redacted_from(path: &std::path::Path) -> Option<String> {
    let meta = std::fs::metadata(path).ok()?;
    let from = meta.len().saturating_sub(READ_TAIL_BYTES);
    let mut f = std::fs::File::open(path).ok()?;
    f.seek(SeekFrom::Start(from)).ok()?;
    let mut buf = Vec::new();
    f.read_to_end(&mut buf).ok()?;
    let mut text = String::from_utf8_lossy(&buf).into_owned();
    if from > 0 {
        // 가운데서 잘린 첫 줄은 버린다.
        if let Some(i) = text.find('\n') {
            text = text[i + 1..].to_string();
        }
    }
    let out = redact_tail(&text, MAX_LINES, MAX_BYTES);
    if out.trim().is_empty() {
        None
    } else {
        Some(out)
    }
}

/// 이 컴퓨터의 노드 기록(가림). 복구 단어로 지갑을 되살리는 동안은 읽지 않는다.
pub fn read_node_log() -> Option<String> {
    if crate::words_restore::log_hidden() {
        return None;
    }
    read_redacted_from(&crate::paths::raven_dir().join("debug.log"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn paths_lose_the_user_name() {
        let a = redact_line(r"Using data directory C:\Users\김무송\AppData\Roaming\Raven");
        assert!(!a.contains("김무송") && a.contains(r"C:\Users\<사용자>\AppData"), "{a}");
        let b = redact_line("datadir=/Users/gimmusong/Library/Raven");
        assert!(!b.contains("gimmusong") && b.contains("/Users/<사용자>/Library"), "{b}");
        let c = redact_line("opened /home/alice/.raven/debug.log ok");
        assert!(!c.contains("alice") && c.contains("/home/<사용자>/.raven"), "{c}");
    }

    #[test]
    fn ip_addresses_are_hidden() {
        let a = redact_line("Added connection to 203.0.113.7:8767 peer");
        assert!(!a.contains("203.0.113") && a.contains("<ip>"), "{a}");
        let b = redact_line("socket bound to [2001:db8::1]:8766");
        assert!(!b.contains("2001:db8") && b.contains("<ip>"), "{b}");
        let c = redact_line("from ::1 accepted");
        assert!(c.contains("<ip>"), "{c}");
    }

    #[test]
    fn times_and_versions_survive() {
        let l = "2026-10-22T09:12:33Z UpdateTip: height=4489527 version 4.8.0 ok";
        assert_eq!(redact_line(l), l);
    }

    #[test]
    fn addresses_and_long_hex_are_hidden() {
        // 26~35자 R 로 시작하는 base58
        let addr = "RLRMJ6abcdefghjkmnpqrstuvwxyzABC";
        let b = redact_line(&format!("pay {addr} done"));
        assert!(!b.contains(addr) && b.contains(MASK), "{b}");
        let h = "00000000000000a1b2c3d4e5f60718293a4b5c6d7e8f9012345678901234abcd";
        let c = redact_line(&format!("best block {h}"));
        assert!(!c.contains(h) && c.contains(MASK), "{c}");
    }

    #[test]
    fn seed_like_word_runs_are_hidden() {
        let a = redact_line("note: abandon ability able about above absent absorb abstract absurd abuse access accident end");
        assert!(!a.contains("abandon") && a.contains(MASK), "{a}");
        // 짧은 문장은 그대로
        let s = "Loading block index finished";
        assert_eq!(redact_line(s), s);
    }

    #[test]
    fn sensitive_lines_are_hidden_whole() {
        for l in [
            "-rpcpassword=hunter2 was set",
            "config: rpcauth=user:salt$hash",
            "Authorization token expired abc",
            "importing private key for wallet",
            "seed phrase loaded",
        ] {
            assert_eq!(redact_line(l), MASK, "{l}");
        }
    }

    #[test]
    fn normal_lines_are_kept() {
        for l in [
            "2026-10-22T09:12:33Z Verifying blocks...",
            "UpdateTip: new best height=1234 progress=0.31",
            "Leaving InitialBlockDownload (latching to false)",
            "Shutdown: done",
        ] {
            assert_eq!(redact_line(l), l, "{l}");
        }
    }

    #[test]
    fn tail_is_last_100_lines() {
        let text: String = (0..250).map(|i| format!("line number {i}\n")).collect();
        let t = redact_tail(&text, MAX_LINES, MAX_BYTES);
        let n = t.lines().count();
        assert_eq!(n, 100);
        assert!(t.starts_with("line number 150") && t.ends_with("line number 249"));
    }

    #[test]
    fn tail_is_capped_at_20kb_keeping_newest() {
        let text: String = (0..100).map(|i| format!("{i:03} {}\n", "x ".repeat(190))).collect();
        let t = redact_tail(&text, MAX_LINES, MAX_BYTES);
        assert!(t.len() <= MAX_BYTES, "len {}", t.len());
        assert!(t.lines().last().unwrap().starts_with("099"));
        assert!(!t.starts_with("000"));
    }

    #[test]
    fn long_lines_are_clipped_after_redaction() {
        let l = format!("{} tail", "a b ".repeat(300));
        let t = redact_tail(&l, MAX_LINES, MAX_BYTES);
        assert!(t.chars().count() <= MAX_LINE_CHARS + 1);
    }

    #[test]
    fn missing_or_empty_file_is_none() {
        assert!(read_redacted_from(std::path::Path::new("/nonexistent/zzz/debug.log")).is_none());
        let p = std::env::temp_dir().join(format!("rv-empty-{}.log", std::process::id()));
        std::fs::write(&p, "").unwrap();
        assert!(read_redacted_from(&p).is_none());
        let _ = std::fs::remove_file(&p);
    }

    #[test]
    fn file_read_redacts_and_drops_partial_first_line() {
        let p = std::env::temp_dir().join(format!("rv-big-{}.log", std::process::id()));
        let mut s = String::new();
        for i in 0..5000 {
            s.push_str(&format!("{i} peer 198.51.100.{} C:\\Users\\bob\\x\n", i % 200));
        }
        std::fs::write(&p, &s).unwrap();
        let t = read_redacted_from(&p).unwrap();
        let _ = std::fs::remove_file(&p);
        assert!(!t.contains("198.51") && !t.contains("bob"));
        assert!(t.lines().count() <= 100 && t.len() <= MAX_BYTES);
        assert!(t.lines().next().unwrap().contains("peer"));
    }
}
