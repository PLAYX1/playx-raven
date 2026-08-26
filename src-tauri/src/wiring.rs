//! 배선 검사 — **등록만 하고 함수는 안 올린** 상태를 막는다.
//!
//! ## 🔴 왜 이 파일이 생겼나 — 하루에 두 번 같은 사고
//!
//! 이 저장소는 파일을 **골라서** 올린다(`commit-tree`). 지금 있는 파일이
//! 아니라 **내가 고른 파일만** 올라간다. 그래서 고르는 걸 빠뜨리면
//!
//! - 로컬은 멀쩡하다 — 그 파일이 여기 있으니까
//! - 올라간 것만 보면 **없는 함수를 등록하는 상태**다
//! - 그리고 그걸 **빌드가 끝날 때까지 모른다**
//!
//! 실제로 그렇게 났다:
//!
//! ```text
//! error[E0433]: cannot find `__cmd__talk_replies` in `talk`
//! error[E0433]: cannot find `__cmd__autostart_audit` in `autostart`
//! ```
//!
//! 네 기계가 전부 죽었고, 그 판은 아무도 못 받았다. 같은 날 웹에서도
//! 한 번 났다(`blockcache.ts` 를 안 올려 Vercel 이 통째로 실패).
//!
//! ## 이 시험이 잡는 것
//!
//! `lib.rs` 의 `invoke_handler` 에 적힌 이름이 **그 모듈 파일 안에 진짜로
//! 있는가.** 컴파일러도 결국 잡지만, 컴파일러는 **CI 에서** 잡는다.
//! 이 시험은 `cargo test` 에서 잡으니 **푸시 전에** 안다.
//!
//! ⚠️ 이 시험도 로컬 파일을 본다. 그러니 「올렸는가」까지는 못 잡는다 —
//!    그건 사람이 `git diff origin/main` 으로 봐야 한다. 이 시험이 잡는
//!    것은 **애초에 함수 이름을 잘못 적은 경우**와, 모듈에서 함수를
//!    지우고 등록을 안 지운 경우다.

#[cfg(test)]
mod tests {
    /// 등록한 이름이 그 모듈에 실제로 있는가.
    #[test]
    fn 등록한_명령이_전부_실재한다() {
        let lib = include_str!("lib.rs");
        let i = lib.find("invoke_handler").expect("명령 목록이 있어야 한다");
        let body = &lib[i..];

        let mut checked = 0;
        let mut missing: Vec<String> = Vec::new();
        for line in body.lines() {
            let t = line.trim().trim_end_matches(',');
            // `모듈::함수` 모양만 본다. 주석과 괄호는 건너뛴다.
            if t.starts_with("//") || !t.contains("::") || t.contains('(') {
                continue;
            }
            let Some((m, f)) = t.split_once("::") else { continue };
            if m.is_empty() || f.is_empty() || !m.chars().all(|c| c.is_ascii_lowercase() || c == '_')
            {
                continue;
            }
            // 이 파일들은 `include_str!` 로 붙여야 읽을 수 있다. 모듈이
            // 늘어날 때마다 여기 한 줄을 더한다 — 러스트는 파일 이름을
            // 변수로 읽어 오지 못한다.
            let src = match m {
                "talk" => include_str!("talk.rs"),
                "autostart" => include_str!("autostart.rs"),
                "shopkey" => include_str!("shopkey.rs"),
                "shopmove" => include_str!("shopmove.rs"),
                "swap" => include_str!("swap.rs"),
                "boot" => include_str!("boot.rs"),
                "conf" => include_str!("conf.rs"),
                "issue" => include_str!("issue.rs"),
                "issue2" => include_str!("issue2.rs"),
                "upload" => include_str!("upload.rs"),
                "nostrpub" => include_str!("nostrpub.rs"),
                _ => continue,
            };
            checked += 1;
            if !src.contains(&format!("fn {f}(")) {
                missing.push(format!("{m}::{f}"));
            }
        }
        assert!(checked > 20, "확인한 것이 {checked}개뿐이다 — 검사가 헛돌고 있다");
        assert!(
            missing.is_empty(),
            "등록은 했는데 함수가 없다: {missing:?} — 이 상태로 올리면 네 기계가 전부 죽는다"
        );
    }
}
