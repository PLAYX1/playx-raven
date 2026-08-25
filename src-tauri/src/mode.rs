//! 이 프로그램을 **무엇으로 쓸 것인가**.
//!
//! 🔴 사용자가 둘인데 화면이 하나였다. 레이븐코인을 돕고 싶어서 켜 둔 사람은
//! 「내 가게」·「메뉴판」을 보며 *이건 뭐지* 하고, 장사하는 사장은 「채굴」을
//! 보며 똑같이 생각한다. 둘 다 자기 것이 아닌 화면을 절반씩 보고 있었다.
//!
//! 첫 실행에서 **한 번만** 묻는다. 기능을 빼는 것이 아니라 처음 온 사람에게
//! 안 보여 주는 것이고, 언제든 바꿀 수 있다 — 돕던 사람이 가게를 열 수도 있다.

use serde_json::{json, Value};

/// 돕기(`help`) 인가 장사(`shop`) 인가. 아직 안 고른 상태(`""`)가 첫 실행이다.
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
    if m != "help" && m != "shop" {
        return Err("고를 수 있는 것은 「돕기」와 「장사」 둘뿐입니다.".into());
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
    Ok(mode_get())
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

    #[test]
    fn 엉뚱한_값은_안_받는다() {
        let _g = LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let d = sandbox("bad");
        assert!(mode_set("어쩌구".into()).is_err());
        assert_eq!(mode_get()["chosen"], false, "거절했으면 안 고른 그대로여야 한다");
        let _ = std::fs::remove_dir_all(&d);
        std::env::remove_var("PLAYX_RAVEN_HOME");
    }
}
