//! 이 프로그램을 **무엇으로 쓸 것인가**.
//!
//! 🔴 사용자가 둘인데 화면이 하나였다. 레이븐코인을 돕고 싶어서 켜 둔 사람은
//! 「내 가게」·「메뉴판」을 보며 *이건 뭐지* 하고, 장사하는 사장은 「채굴」을
//! 보며 똑같이 생각한다. 둘 다 자기 것이 아닌 화면을 절반씩 보고 있었다.
//!
//! 첫 실행에서 **한 번만** 묻는다. 기능을 빼는 것이 아니라 처음 온 사람에게
//! 안 보여 주는 것이고, 언제든 바꿀 수 있다 — 돕던 사람이 가게를 열 수도 있다.
//!
//! ## 0.4.8 — 셋째 사람: 지갑만 쓰려는 사람(`wallet`)
//!
//! 🔴 RV3 처음 쓰는 사람 과제 T01 에서 첫 질문이 「돕기 / 장사」 둘뿐이었다.
//! 레이븐코인을 **받고 보내고 보관만** 하려는 사람이 고를 자리가 없어서
//! 「돕기」를 누르고, 설정이 끝나면 가게 화면에 떨어졌다.
//!
//! 지갑 모드는 **노드만 켠다**(지갑이 노드 안에 있다). 파일창고·바깥 연결·
//! 손님 서버(릴레이가 그 안에 있다)는 알아서 켜지 않는다 — 그 사람의
//! 컴퓨터와 배터리는 남의 사진과 공지를 나르려고 있는 것이 아니다.
//! 무엇을 알아서 켤지는 [`autostart_for`] **한 곳**에서 정한다.

use serde_json::{json, Value};

/// 고를 수 있는 것. 돕기(`help`)·지갑(`wallet`)·장사(`shop`).
/// 아직 안 고른 상태(`""`)가 첫 실행이다.
const MODES: [&str; 3] = ["help", "wallet", "shop"];

fn path() -> std::path::PathBuf {
    crate::paths::app_file("mode.json")
}

fn read() -> Value {
    std::fs::read_to_string(path())
        .ok()
        .and_then(|s| serde_json::from_str::<Value>(&s).ok())
        .unwrap_or_else(|| json!({}))
}

/// 고른 것을 그대로 돌려준다.
///
/// 🔴 **모르면 모른다고 답한다.** 안 고른 사람에게 「장사」를 기본으로 주면
/// 돕겠다고 켠 사람이 계산대 화면을 만나고, 그 순간 이 프로그램은 자기
/// 것이 아니게 된다.
#[tauri::command]
pub fn mode_get() -> Value {
    let m = read();
    let chosen = m["mode"].as_str().unwrap_or("");
    if !chosen.is_empty() {
        return json!({ "mode": chosen, "chosen": true, "inferred": false });
    }
    // 🔴 **쓰던 사람에게 처음 온 사람처럼 묻지 않는다.**
    //    가게를 이미 차려 둔 사람에게 "무엇으로 쓰실 건가요"를 띄우면,
    //    자기가 만든 것이 없어졌나 싶어진다. 증거가 있으면 그걸 읽는다.
    let shop = crate::shop::shop_load();
    let has_shop = shop
        .get("name")
        .and_then(Value::as_str)
        .map(|n| !n.trim().is_empty())
        .unwrap_or(false)
        || shop.get("asset").and_then(Value::as_str).map(|a| !a.trim().is_empty()).unwrap_or(false)
        || shop.get("menu").and_then(Value::as_array).map(|m| !m.is_empty()).unwrap_or(false);
    if has_shop {
        // 적어 두지는 않는다 — 사장이 「이 컴퓨터」에서 직접 고르면 그게 이긴다.
        return json!({ "mode": "shop", "chosen": true, "inferred": true });
    }
    json!({ "mode": "", "chosen": false, "inferred": false })
}

#[tauri::command]
pub fn mode_set(mode: String) -> Result<Value, String> {
    let m = mode.trim();
    if !MODES.contains(&m) {
        return Err("고를 수 있는 것은 「돕기」·「지갑」·「장사」 셋뿐입니다.".into());
    }
    // 고른 것만 적는다. 가게 정보·지갑·표는 건드리지 않는다 — 「돕기」로
    // 바꿨다고 가게가 지워지면 아무도 바꿔 보지 못한다.
    let mut v = read();
    v["mode"] = json!(m);
    let dir = path();
    if let Some(d) = dir.parent() {
        let _ = std::fs::create_dir_all(d);
    }
    std::fs::write(&dir, serde_json::to_string_pretty(&v).unwrap_or_default())
        .map_err(|e| format!("고르신 것을 저장하지 못했습니다: {e}"))?;
    // 🔴 여기서 안 부르면, 「장사」→「돕기」로 바꾼 뒤에도 컴퓨터를 계속
    //    깨워 둔다. 다음에 앱을 켤 때까지 배터리가 탄다.
    crate::awake::sync_with_mode();
    // 🔴 첫 실행에서는 **고르기 전에** 켤 때 할 일(`boot.rs`)이 이미 돌았다 —
    //    그때는 모드가 비어 있어 파일창고·바깥 연결까지 켠다. 지갑을 고른
    //    사람에게 그것을 그대로 두면 「안 켠다」는 약속이 첫날부터 거짓이 된다.
    //    **우리가 켠 것만** 끈다. 사람이 따로 켜 둔 것은 우리 것이 아니다.
    if !autostart_for(m).files {
        crate::services::stop_ours("ipfs");
    }
    if !autostart_for(m).outside && crate::tunnel::ours_running() {
        let _ = crate::tunnel::tunnel_stop();
    }
    Ok(mode_get())
}

/// 켤 때 **알아서** 켜는 것. 사람이 「이 컴퓨터」에서 켜는 것은 모드와 상관없이 된다.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Autostart {
    /// 레이븐 노드 — 지갑이 이 안에 있다. 늘 켠다.
    pub node: bool,
    /// 파일창고(IPFS) — 사진·파일을 나눠 갖는다.
    pub files: bool,
    /// 바깥 연결(터널) — 가게 화면을 인터넷에 연다.
    pub outside: bool,
    /// 손님 서버(8790) — 손님 화면과 **릴레이**가 이 안에 있다.
    pub phone: bool,
}

/// 모드마다 무엇을 알아서 켜나 — **이 판단은 여기 한 곳에만 있다.**
///
/// 🔴 채굴은 여기에 없다. 어느 모드에서도 알아서 켜지 않는다(`boot.rs` 시험).
///
/// 돕기·장사·아직 안 고름은 **예전 그대로** 다 켠다. 지갑만 노드 하나다 —
/// 받고 보내고 보관하는 데 필요한 것은 노드뿐이고, 나머지는 남을 위한 일이다.
pub fn autostart_for(mode: &str) -> Autostart {
    let wallet = mode == "wallet";
    Autostart { node: true, files: !wallet, outside: !wallet, phone: !wallet }
}

/// 지금 고른 것으로.
pub fn autostart_now() -> Autostart {
    autostart_for(mode_get()["mode"].as_str().unwrap_or(""))
}

#[cfg(test)]
mod tests {
    use super::*;

    // 🔴 자물쇠를 따로 만들면 안 된다. `PLAYX_RAVEN_HOME` 은 프로세스
    // 전역이라 **모든 모듈이 같은 자물쇠**를 잡아야 한다. 따로 만들었더니
    // paths 시험과 엇갈려 값이 지워졌다 — `paths.rs` 에 적힌 그 사고다.
    use crate::paths::TEST_ENV as LOCK;

    fn sandbox(name: &str) -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!("playx-mode-{name}"));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        std::env::set_var("PLAYX_RAVEN_HOME", &d);
        d
    }

    /// 🔴 안 고른 사람에게 아무거나 주면 안 된다.
    #[test]
    fn 처음에는_안_골랐다고_답한다() {
        let _g = LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let d = sandbox("fresh");
        let m = mode_get();
        assert_eq!(m["chosen"], false, "첫 실행은 안 고른 상태여야 한다");
        assert_eq!(m["mode"], "", "기본값을 몰래 주면 안 된다");
        let _ = std::fs::remove_dir_all(&d);
        std::env::remove_var("PLAYX_RAVEN_HOME");
    }

    /// 🔴 이미 가게가 있는 사람에게 「무엇으로 쓰실 건가요」를 띄우면 안 된다.
    #[test]
    fn 가게가_이미_있으면_묻지_않는다() {
        let _g = LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let d = sandbox("hasshop");
        std::fs::write(d.join("shop.json"), r#"{"name":"플레이엑스","asset":"SHOP.PLAYX"}"#).unwrap();
        let m = mode_get();
        assert_eq!(m["chosen"], true, "쓰던 사람에게 첫 화면을 띄우면 안 된다");
        assert_eq!(m["mode"], "shop");
        assert_eq!(m["inferred"], true, "짐작한 것임을 밝혀야 한다");
        let _ = std::fs::remove_dir_all(&d);
        std::env::remove_var("PLAYX_RAVEN_HOME");
    }

    #[test]
    fn 고르면_기억한다() {
        let _g = LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let d = sandbox("pick");
        mode_set("help".into()).unwrap();
        assert_eq!(mode_get()["mode"], "help");
        // 바꿀 수 있어야 한다 — 돕던 사람이 가게를 열 수도 있다.
        mode_set("shop".into()).unwrap();
        assert_eq!(mode_get()["mode"], "shop");
        let _ = std::fs::remove_dir_all(&d);
        std::env::remove_var("PLAYX_RAVEN_HOME");
    }

    /// 🔴 셋째 사람. 받고 보내고 보관만 하려는 사람이 고를 자리가 있어야 한다.
    #[test]
    fn 지갑도_고를_수_있다() {
        let _g = LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let d = sandbox("wallet");
        mode_set("wallet".into()).unwrap();
        let m = mode_get();
        assert_eq!(m["mode"], "wallet");
        assert_eq!(m["chosen"], true);
        assert_eq!(m["inferred"], false, "고른 것을 짐작한 것처럼 말하면 안 된다");
        // 지갑에서 돕기·장사로, 다시 지갑으로 — 어느 쪽으로든 바뀐다.
        mode_set("help".into()).unwrap();
        assert_eq!(mode_get()["mode"], "help");
        mode_set("wallet".into()).unwrap();
        assert_eq!(mode_get()["mode"], "wallet");
        let _ = std::fs::remove_dir_all(&d);
        std::env::remove_var("PLAYX_RAVEN_HOME");
    }

    /// 🔴 가게를 차려 둔 사람이 「지갑」을 골라도 가게 정보는 안 지운다.
    ///    그리고 고른 것이 짐작(가게가 있으니 장사)을 이긴다.
    #[test]
    fn 가게가_있어도_지갑을_고르면_지갑이다() {
        let _g = LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let d = sandbox("shop-to-wallet");
        std::fs::write(d.join("shop.json"), r#"{"name":"플레이엑스","asset":"SHOP.PLAYX"}"#).unwrap();
        mode_set("wallet".into()).unwrap();
        assert_eq!(mode_get()["mode"], "wallet");
        assert!(d.join("shop.json").exists(), "지갑으로 바꿨다고 가게가 지워지면 안 된다");
        let _ = std::fs::remove_dir_all(&d);
        std::env::remove_var("PLAYX_RAVEN_HOME");
    }

    /// 🔴 지갑만 쓰는 사람의 컴퓨터는 노드 하나만 알아서 켠다. 나머지 셋(돕기·
    ///    장사·안 고름)은 **예전 그대로** 다 켠다 — 여기가 바뀌면 이미 쓰던
    ///    사람의 가게가 다음 판에서 조용히 안 열린다.
    #[test]
    fn 지갑은_노드만_알아서_켠다() {
        let w = autostart_for("wallet");
        assert!(w.node, "지갑은 노드 안에 있다 — 노드는 켜야 한다");
        assert!(!w.files, "지갑만 쓰는 사람의 컴퓨터로 남의 사진을 나르지 않는다");
        assert!(!w.outside, "가게가 없는 컴퓨터를 인터넷에 열지 않는다");
        assert!(!w.phone, "손님 서버(릴레이)를 알아서 열지 않는다");
        let all = Autostart { node: true, files: true, outside: true, phone: true };
        for m in ["help", "shop", ""] {
            assert_eq!(autostart_for(m), all, "{m:?} 는 예전처럼 다 켜야 한다");
        }
        // 모르는 값·공백 붙은 값에 기대서 끄지 않는다 — 예전 동작이 안전한 쪽이다.
        assert_eq!(autostart_for("WALLET"), all);
        assert_eq!(autostart_for("wallet "), all);
    }

    /// 🔴 위 약속은 **켤 때 모드를 보는 줄**이 있어야 지켜진다. 누가 `boot.rs` 를
    ///    예전처럼 파일창고·바깥 연결을 그냥 켜게 되돌리면 지갑을 고른 노트북이
    ///    다시 남의 사진을 나르고 인터넷에 열린다. 손님 서버(릴레이)는 `lib.rs`.
    #[test]
    fn 켤_때_모드를_보고_켠다() {
        let boot = include_str!("boot.rs");
        let i = boot.find("pub async fn run").expect("시작 함수가 있어야 한다");
        let body = &boot[i..i + boot[i..].find("#[cfg(test)]").unwrap_or(boot.len() - i)];
        assert!(body.contains("mode::autostart_now()"), "켤 때 모드를 안 본다");
        assert!(body.contains("start_parts(parts.files)"), "파일창고를 모드와 상관없이 켠다");
        assert!(body.contains("parts.outside.then(prep_tunnel)"), "바깥 연결을 모드와 상관없이 켠다");
        let lib = include_str!("lib.rs");
        let j = lib.find("start_phone_server(state)").expect("손님 서버를 켜는 줄이 있어야 한다");
        assert!(lib[..j].contains("mode::autostart_now().phone"), "손님 서버(릴레이)를 모드와 상관없이 연다");
        assert!(lib[j..].contains("recover::청소"), "손님 서버를 안 열 때도 풀어 놓은 지갑은 치워야 한다");
    }

    #[test]
    fn 엉뚱한_값은_안_받는다() {
        let _g = LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let d = sandbox("bad");
        let why = mode_set("어쩌구".into()).unwrap_err();
        // 거절할 때 무엇을 고를 수 있는지 셋 다 말해야 한다 — 둘만 말하면 지갑이 없는 줄 안다.
        for word in ["돕기", "지갑", "장사"] {
            assert!(why.contains(word), "고를 수 있는 것에 {word} 가 빠졌다: {why}");
        }
        assert_eq!(mode_get()["chosen"], false, "거절했으면 안 고른 그대로여야 한다");
        let _ = std::fs::remove_dir_all(&d);
        std::env::remove_var("PLAYX_RAVEN_HOME");
    }
}
