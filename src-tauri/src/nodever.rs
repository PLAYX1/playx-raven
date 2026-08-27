//! **깔려 있는 노드가 쓸 수 있는 판인가.**
//!
//! ## 🔴 「깔려 있는 것을 먼저」는 그 판이 멀쩡할 때만 맞다
//!
//! `which()` 는 사장이 이미 깔아 둔 것을 먼저 쓴다. 그 판단 자체는 옳다 —
//! 잘 쓰던 것을 우리가 갈아 치우면 안 된다. 그런데 **판을 안 본다.**
//!
//! 레이븐코인은 이게 치명적이다. **4.8.0 미만은 블록 4,489,527 을 못
//! 넘는다** — 2026-08 합의 취약점 수정판이 4.8.0 이고, 그전 판은 그 구간에서
//! `bad-blk-height` 로 거부하고 멈춘다. 우리가 대표님 지갑을 그것 때문에
//! 직접 빌드해서 살렸다(7/27 높이 4,472,087 에서 멈춰 있던 것).
//!
//! 그런데 이 앱은 **판을 안 보고** 깔려 있는 것을 쓴다. 옛 판이 깔려 있으면
//! 며칠을 따라잡고 나서 그 구간에서 멈춘다. 사장은 왜인지 모른다.
//!
//! ⚠️ 우리가 같이 넣은 것은 확실히 4.8.0 이다(맥=우리 빌드, 윈도우=공식).
//!    깔린 것이 낡았으면 **우리 것을 쓰고, 왜 그랬는지 말한다.**

use serde_json::{json, Value};

/// `v4.8.0.0-…` 에서 (4, 8, 0) 을 뽑는다. 못 읽으면 `None`.
///
/// ⚠️ 못 읽었다고 **낡은 것으로 치지 않는다.** 판을 못 읽는 이유는 여럿이고
///    (권한·이상한 빌드), 멀쩡한 노드를 우리 것으로 바꿔치기하면 그게 더 나쁘다.
pub fn parse(s: &str) -> Option<(u32, u32, u32)> {
    // ⚠️ 그냥 첫 `v` 를 찾으면 **`Raven` 의 v** 를 판 번호로 잡는다.
    //    시험이 이걸 잡았다. **숫자가 뒤따르는 `v`** 만 본다.
    let b = s.as_bytes();
    let start = (0..b.len()).find(|&i| {
        b[i] == b'v' && b.get(i + 1).is_some_and(|c| c.is_ascii_digit())
    })?;
    let rest = &s[start + 1..];
    let num = rest.split(|c: char| !c.is_ascii_digit() && c != '.').next()?;
    let mut it = num.split('.');
    let a = it.next()?.parse().ok()?;
    let b2 = it.next().unwrap_or("0").parse().unwrap_or(0);
    let c = it.next().unwrap_or("0").parse().unwrap_or(0);
    Some((a, b2, c))
}

/// 이 판으로 끝까지 따라잡을 수 있나.
pub fn good_enough(v: (u32, u32, u32)) -> bool {
    v >= (4, 8, 0)
}

/// 그 실행 파일에 판을 물어본다. **장부를 안 건드린다** — `-version` 은
/// 찍고 바로 끝난다. 돌고 있는 노드와 부딪히지 않는다.
pub fn version_of(path: &str) -> Option<String> {
    let out = crate::quiet::cmd(path)
        .arg("-version")
        .output()
        .ok()?;
    let text = String::from_utf8_lossy(&out.stdout);
    text.lines()
        .find(|l| l.contains('v') && l.contains('.'))
        .map(|l| l.trim().to_string())
}

/// 화면에 보여 줄 것. **판을 숨기지 않는다.**
#[tauri::command]
pub fn node_version() -> Value {
    let Some(path) = crate::services::which("ravend") else {
        return json!({ "known": false, "why": "노드 프로그램을 찾지 못했습니다." });
    };
    let line = version_of(&path);
    let ver = line.as_deref().and_then(parse);
    let ok = ver.map(good_enough);
    json!({
        "known": true,
        "path": path,
        "line": line,
        "ok": ok,
        // 🔴 못 읽었으면 못 읽었다고 한다. 낡은 것으로 몰지 않는다.
        "say": match ok {
            Some(true) => "이 판으로 끝까지 따라잡을 수 있습니다.".to_string(),
            Some(false) => "🔴 이 판은 블록 4,489,527 에서 멈춥니다. 4.8.0 이상이 필요합니다 — \
                            이 프로그램에 4.8.0 이 같이 들어 있으니 그것으로 바꾸실 수 있습니다."
                .to_string(),
            None => "판을 읽지 못했습니다. 그대로 씁니다.".to_string(),
        },
    })
}

#[cfg(test)]
mod tests {
    use super::{good_enough, parse};

    /// 우리 빌드와 공식 빌드 둘 다 읽어야 한다. 실측한 문자열로 시험한다.
    #[test]
    fn 우리_것과_공식_것을_다_읽는다() {
        // 맥 앱 안에서 실제로 읽어 낸 것
        assert_eq!(parse("v4.8.0.0-854fc7f30-dirty-playx"), Some((4, 8, 0)));
        // 윈도우 설치본 안에서 실제로 읽어 낸 것
        assert_eq!(parse("v4.8.0.0-225491298"), Some((4, 8, 0)));
        // 🔴 대표님 컴퓨터에서 실제로 돌고 있는 것. `Raven` 의 v 가 앞에 있다.
        assert_eq!(
            parse("Raven Core Daemon version v4.8.0.0-0894f15de-playx"),
            Some((4, 8, 0))
        );
        assert_eq!(parse("Raven Core Daemon version v4.7.0.0"), Some((4, 7, 0)));
    }

    /// 🔴 4.8.0 미만은 블록 4,489,527 을 못 넘는다. 대표님 지갑이 실제로
    ///    거기서 멈춰 있었다(높이 4,472,087).
    #[test]
    fn 낡은_판을_거른다() {
        assert!(good_enough((4, 8, 0)));
        assert!(good_enough((4, 9, 1)));
        assert!(!good_enough((4, 7, 0)));
        assert!(!good_enough((4, 6, 1)));
    }

    /// ⚠️ 못 읽은 것을 **낡은 것으로 치지 않는다.** 멀쩡한 노드를 우리 것으로
    ///    바꿔치기하는 쪽이 더 나쁘다.
    #[test]
    fn 못_읽으면_모른다고_한다() {
        assert_eq!(parse("이상한 글자"), None);
        assert_eq!(parse(""), None);
        // 🔴 `Raven` 의 v 를 판 번호로 잡으면 안 된다. 시험이 실제로 잡았다.
        assert_eq!(parse("Raven Core"), None);
    }
}
