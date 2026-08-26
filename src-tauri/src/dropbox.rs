//! 창에 떨어뜨린 파일 목록.
//!
//! ## 🔴 왜 이 파일이 따로 있나
//!
//! 끌어다 놓기를 붙이면 화면이 「이 경로를 올려 줘」라고 말하게 된다. 그
//! 명령이 **아무 경로나 받으면**, 화면이 한 번 뚫리는 날 `wallet.dat` 과
//! `shopkey.json` 이 파일창고로 올라간다. 파일창고는 공개고 지울 수 없다.
//!
//! 그래서 **사람이 방금 떨어뜨린 것만** 받는다. 이 목록은 러스트가 들고
//! 있고 화면은 여기에 못 넣는다 — 넣는 길이 창 이벤트 하나뿐이다.

use std::collections::HashSet;
use std::sync::Mutex;

static DROPPED: Mutex<Option<HashSet<String>>> = Mutex::new(None);

/// 창이 파일을 받았다. 기억해 둔다.
pub fn remember(paths: &[String]) {
    if let Ok(mut g) = DROPPED.lock() {
        let set = g.get_or_insert_with(HashSet::new);
        // 오래 들고 있을 이유가 없다. 한 번에 몇 개를 떨어뜨리든
        // 그 자리에서 쓰고 만다.
        if set.len() > 200 {
            set.clear();
        }
        for p in paths {
            set.insert(p.clone());
        }
    }
}

/// 이 경로가 방금 떨어뜨린 것인가.
pub fn was_dropped(path: &str) -> bool {
    DROPPED
        .lock()
        .ok()
        .and_then(|g| g.as_ref().map(|s| s.contains(path)))
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    /// 🔴 목록에 없는 경로는 **절대** 안 읽는다. 이게 뚫리면 지갑 파일이
    ///    공개 파일창고로 올라가고, 거기서는 지울 수가 없다.
    #[test]
    fn 떨어뜨리지_않은_것은_안_받는다() {
        assert!(!super::was_dropped("/Users/x/Library/Application Support/Raven/wallet.dat"));
        super::remember(&["/tmp/사진.jpg".to_string()]);
        assert!(super::was_dropped("/tmp/사진.jpg"));
        assert!(!super::was_dropped("/tmp/딴것.jpg"));
    }
}
