//! 지갑 출생 기록 — 「이 지갑은 어디서·언제·어떤 판으로 태어났나」(0.9.60).
//!
//! ## 왜
//!
//! 디센트 지갑 사고(2026-09)에서 배운 것: 약하게 만들어진 복구 단어는 앱을 올려도 안 고쳐진다.
//! 그런 일이 생기면 「어느 판에서 만든 지갑인가」로 범위를 정해야 한다(docs/INCIDENT-SEED-NOTICE.md 1절).
//! 데스크탑은 단어를 **스스로 만들지 않는다** — 번들 ravend(레이븐코인 코어)가 지갑을 처음 만들 때
//! 만든다. 그래서 여기 적는 것은 「앱이 노드에게 새 지갑을 만들게 했나」와 그때의 노드·앱 판이다.
//!
//! ## 🔴 지키는 것
//!
//! - **이 컴퓨터 안에만.** 앱 자료 폴더의 `wallet-origin.json` 한 장. 서버·Nostr·신고서로 안 나간다.
//! - **지갑 파일은 건드리지 않는다.** `wallet.dat` 이 **있나 없나**만 본다(열지도 읽지도 않는다).
//! - **단어·주소·잔액은 안 적는다.** 출생 방식·노드 판·앱 판·시각뿐이다.
//!
//! ## 판별 (순수 함수 `next_record`)
//!
//! | 때 | 기록 없음 | 기록 있음 |
//! |---|---|---|
//! | 노드를 켤 때 지갑 자리가 **비어 있음** | `created` | `created`(새 지갑이 태어난다 — 덮어쓴다) |
//! | 노드를 켤 때 지갑이 **이미 있음** | `unknown`(이 기능 전부터 있던 지갑) | 그대로 |
//! | 복구 단어로 되살림이 확인됨 | `imported` | `imported`(앞 기록은 옆에 둔다) |
//! | 화면이 읽을 때 지갑이 있음 | `unknown` | 그대로 |
//! | 화면이 읽을 때 지갑이 없음 | 아무것도 안 씀 | 그대로 |

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};

pub const FILE: &str = "wallet-origin.json";
/// 되살리기 전 기록. 「옛 지갑으로 되돌리기」를 누르면 이것을 다시 편다.
pub const BEFORE_WORDS: &str = "wallet-origin.before-words.json";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Birth {
    /// `created` · `imported` · `unknown`
    pub origin: String,
    /// 데스크탑은 늘 `desktop-node` — 단어를 만든 것은 이 컴퓨터의 노드다.
    pub platform: String,
    /// `getnetworkinfo.subversion` 에서 뽑은 판(예: `4.8.0`). 모르면 비어 있다.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub node_version: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub app_version: Option<String>,
    /// 기록한 시각(유닉스 밀리초). `unknown` 은 「처음 알아챈 때」다 — 지갑이 태어난 때가 아니다.
    pub created_at: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Event {
    /// 앱이 노드를 켜기 직전. `wallet_present` = 그 순간 `wallet.dat` 이 있었나.
    NodeStart { wallet_present: bool },
    /// 복구 단어로 만든 지갑이 노드에 정말 들어갔다(주소 대조까지 끝).
    Restored,
    /// 화면이 기록을 읽는다.
    Read { wallet_present: bool },
}

pub const PLATFORM: &str = "desktop-node";

/// 🔴 판별의 전부. 새로 적어야 하면 `Some`, 그대로 두면 `None`.
pub fn next_record(existing: Option<&Birth>, ev: Event, app_version: &str, node_version: Option<&str>, now: u64) -> Option<Birth> {
    let make = |origin: &str, node: Option<&str>| Birth {
        origin: origin.into(),
        platform: PLATFORM.into(),
        node_version: node.map(str::to_string).filter(|s| !s.is_empty()),
        app_version: Some(app_version.to_string()).filter(|s| !s.is_empty()),
        created_at: now,
    };
    match ev {
        Event::Restored => Some(make("imported", node_version)),
        // 빈 자리에서 노드가 켜지면 노드가 새 지갑(새 단어)을 만든다. 앞 기록이 있어도 그 지갑은 이제 여기 없다.
        Event::NodeStart { wallet_present: false } => Some(make("created", node_version)),
        Event::NodeStart { wallet_present: true } | Event::Read { wallet_present: true } => {
            if existing.is_some() { None } else { Some(make("unknown", None)) }
        }
        Event::Read { wallet_present: false } => None,
    }
}

/// `/Ravencoin:4.8.0/` → `4.8.0`. 숫자.숫자… 첫 덩어리. 못 읽으면 `None`.
pub fn node_version_from_subversion(s: &str) -> Option<String> {
    let start = s.find(|c: char| c.is_ascii_digit())?;
    let v: String = s[start..].chars().take_while(|c| c.is_ascii_digit() || *c == '.').collect();
    let v = v.trim_end_matches('.').to_string();
    if v.contains('.') { Some(v) } else { None }
}

fn now_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

pub fn app_version() -> &'static str {
    env!("CARGO_PKG_VERSION")
}

pub fn read_in(app_dir: &Path) -> Option<Birth> {
    let bytes = std::fs::read(app_dir.join(FILE)).ok()?;
    serde_json::from_slice(&bytes).ok()
}

fn write_in(app_dir: &Path, b: &Birth) {
    if let Ok(bytes) = serde_json::to_vec_pretty(b) {
        if let Err(e) = crate::server::atomic_write_0600(&app_dir.join(FILE), &bytes) {
            // 기록을 못 남겨도 지갑·노드는 그대로 간다 — 이 기록은 안내용이다.
            eprintln!("지갑 출생 기록 저장 실패: {e}");
        }
    }
}

/// 사건 하나를 반영한다. 바뀐 기록을 돌려준다(그대로면 `None`).
pub fn apply_in(app_dir: &Path, ev: Event, node_version: Option<&str>) -> Option<Birth> {
    let cur = read_in(app_dir);
    let next = next_record(cur.as_ref(), ev, app_version(), node_version, now_ms())?;
    if ev == Event::Restored {
        // 되돌리기에 대비해 앞 기록을 옆에 둔다(없으면 옆 기록도 지운다 — 되돌리면 「모름」이 맞다).
        let side = app_dir.join(BEFORE_WORDS);
        match &cur {
            Some(b) => { if let Ok(bytes) = serde_json::to_vec_pretty(b) { let _ = crate::server::atomic_write_0600(&side, &bytes); } }
            None => { let _ = std::fs::remove_file(&side); }
        }
    }
    write_in(app_dir, &next);
    Some(next)
}

/// 「옛 지갑으로 되돌리기」 — 되살리기 전 기록을 다시 편다. 옆 기록이 없으면 지운다(다음에 읽을 때 `unknown`).
pub fn undo_restore_in(app_dir: &Path) {
    let side = app_dir.join(BEFORE_WORDS);
    match std::fs::read(&side) {
        Ok(bytes) if serde_json::from_slice::<Birth>(&bytes).is_ok() => {
            let _ = crate::server::atomic_write_0600(&app_dir.join(FILE), &bytes);
        }
        _ => { let _ = std::fs::remove_file(app_dir.join(FILE)); }
    }
    let _ = std::fs::remove_file(&side);
}

pub fn wallet_present_in(datadir: &Path) -> bool {
    std::fs::symlink_metadata(datadir.join("wallet.dat")).is_ok()
}

fn datadir() -> PathBuf {
    crate::paths::raven_dir()
}

/// 앱이 노드를 켜기 직전에 부른다(`services::start_parts`·`reindex_run`).
pub fn note_node_start() {
    let present = wallet_present_in(&datadir());
    let _ = apply_in(&crate::paths::app_dir(), Event::NodeStart { wallet_present: present }, None);
}

/// 노드에게 판을 묻는다(짧게). 못 물으면 `None`.
async fn ask_node_version() -> Option<String> {
    let v = tokio::time::timeout(std::time::Duration::from_secs(5), crate::raven::call_rpc("getnetworkinfo", json!([])))
        .await
        .ok()?
        .ok()?;
    node_version_from_subversion(v.get("subversion").and_then(Value::as_str)?)
}

/// 화면이 읽는다 — 「만든 곳」 한 줄. 기록이 없으면 `null`.
/// `created` 인데 노드 판을 아직 모르면(지갑은 노드가 켜진 뒤에야 판을 답한다) 이때 채운다.
#[tauri::command]
pub async fn wallet_origin() -> Value {
    let app = crate::paths::app_dir();
    let present = wallet_present_in(&datadir());
    let _ = apply_in(&app, Event::Read { wallet_present: present }, None);
    let Some(mut b) = read_in(&app) else { return Value::Null };
    if b.origin == "created" && b.node_version.is_none() {
        if let Some(v) = ask_node_version().await {
            b.node_version = Some(v);
            write_in(&app, &b);
        }
    }
    serde_json::to_value(&b).unwrap_or(Value::Null)
}

/// 되살리기 흐름이 쓰는 판 묻기(그 흐름의 노드에게 직접 묻는다).
pub fn version_from_networkinfo(v: &Value) -> Option<String> {
    node_version_from_subversion(v.get("subversion").and_then(Value::as_str)?)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn b(origin: &str) -> Birth {
        Birth { origin: origin.into(), platform: PLATFORM.into(), node_version: Some("4.8.0".into()), app_version: Some("0.9.59".into()), created_at: 1 }
    }

    #[test]
    fn 빈_자리에서_노드를_켜면_created() {
        let r = next_record(None, Event::NodeStart { wallet_present: false }, "0.9.60", None, 5).unwrap();
        assert_eq!(r.origin, "created");
        assert_eq!(r.platform, "desktop-node");
        assert_eq!(r.app_version.as_deref(), Some("0.9.60"));
        assert_eq!(r.node_version, None, "노드 판은 켜진 뒤 채운다");
        assert_eq!(r.created_at, 5);
        // 앞 기록이 있어도 지갑 자리가 비었으면 새 지갑이 태어난다.
        assert_eq!(next_record(Some(&b("imported")), Event::NodeStart { wallet_present: false }, "0.9.60", None, 6).unwrap().origin, "created");
    }

    #[test]
    fn 이미_있던_지갑은_unknown_한_번만() {
        let r = next_record(None, Event::NodeStart { wallet_present: true }, "0.9.60", Some("4.8.0"), 5).unwrap();
        assert_eq!(r.origin, "unknown");
        assert_eq!(r.node_version, None, "모르는 지갑에 지금 노드 판을 붙이면 거짓이 된다");
        assert_eq!(next_record(None, Event::Read { wallet_present: true }, "0.9.60", None, 5).unwrap().origin, "unknown");
        for o in ["created", "imported", "unknown"] {
            assert_eq!(next_record(Some(&b(o)), Event::NodeStart { wallet_present: true }, "0.9.60", None, 9), None, "{o} 는 그대로");
            assert_eq!(next_record(Some(&b(o)), Event::Read { wallet_present: true }, "0.9.60", None, 9), None);
        }
    }

    #[test]
    fn 지갑이_없을_때_읽기만_하면_아무것도_안_쓴다() {
        assert_eq!(next_record(None, Event::Read { wallet_present: false }, "0.9.60", None, 5), None);
        assert_eq!(next_record(Some(&b("created")), Event::Read { wallet_present: false }, "0.9.60", None, 5), None);
    }

    #[test]
    fn 복구_단어로_되살리면_imported() {
        for prev in [None, Some(b("created")), Some(b("unknown"))] {
            let r = next_record(prev.as_ref(), Event::Restored, "0.9.60", Some("4.8.0"), 7).unwrap();
            assert_eq!(r.origin, "imported");
            assert_eq!(r.node_version.as_deref(), Some("4.8.0"));
        }
    }

    #[test]
    fn 노드_판_읽기() {
        assert_eq!(node_version_from_subversion("/Ravencoin:4.8.0/").as_deref(), Some("4.8.0"));
        assert_eq!(node_version_from_subversion("/Ravencoin:4.8.0(custom)/").as_deref(), Some("4.8.0"));
        assert_eq!(node_version_from_subversion("/Ravencoin:4.10.1.2/").as_deref(), Some("4.10.1.2"));
        assert_eq!(node_version_from_subversion("/Ravencoin/"), None);
        assert_eq!(node_version_from_subversion(""), None);
        assert_eq!(version_from_networkinfo(&json!({"subversion": "/Ravencoin:4.8.0/"})).as_deref(), Some("4.8.0"));
        assert_eq!(version_from_networkinfo(&json!({})), None);
    }

    #[test]
    fn 파일로_쓰고_되돌리기() {
        let dir = crate::paths::test_fixture_root().join(format!("wallet-origin-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let data = dir.join("raven");
        std::fs::create_dir_all(&data).unwrap();

        // 첫 실행: 지갑 자리 비어 있음 → created.
        assert!(!wallet_present_in(&data));
        assert_eq!(apply_in(&dir, Event::NodeStart { wallet_present: wallet_present_in(&data) }, None).unwrap().origin, "created");
        std::fs::write(data.join("wallet.dat"), b"x").unwrap();
        // 다음 켜기: 지갑 있음 → 그대로.
        assert_eq!(apply_in(&dir, Event::NodeStart { wallet_present: wallet_present_in(&data) }, None), None);
        assert_eq!(read_in(&dir).unwrap().origin, "created");
        // 🔴 지갑 파일은 건드리지 않는다.
        assert_eq!(std::fs::read(data.join("wallet.dat")).unwrap(), b"x");

        // 되살리기 → imported, 앞 기록은 옆에.
        assert_eq!(apply_in(&dir, Event::Restored, Some("4.8.0")).unwrap().origin, "imported");
        assert_eq!(read_in(&dir).unwrap().node_version.as_deref(), Some("4.8.0"));
        assert!(dir.join(BEFORE_WORDS).exists());
        // 되돌리기 → created 로 돌아간다.
        undo_restore_in(&dir);
        assert_eq!(read_in(&dir).unwrap().origin, "created");
        assert!(!dir.join(BEFORE_WORDS).exists());

        // 기록 없이 되살렸다가 되돌리면 기록이 없어지고, 다음 읽기는 unknown.
        std::fs::remove_file(dir.join(FILE)).unwrap();
        apply_in(&dir, Event::Restored, None);
        undo_restore_in(&dir);
        assert!(read_in(&dir).is_none());
        assert_eq!(apply_in(&dir, Event::Read { wallet_present: true }, None).unwrap().origin, "unknown");

        // 🔴 기록에 단어·주소가 들어갈 칸이 없다.
        let text = std::fs::read_to_string(dir.join(FILE)).unwrap();
        let v: Value = serde_json::from_str(&text).unwrap();
        let keys: Vec<_> = v.as_object().unwrap().keys().cloned().collect();
        for k in &keys { assert!(["origin", "platform", "nodeVersion", "appVersion", "createdAt"].contains(&k.as_str()), "{k}"); }
        let _ = std::fs::remove_dir_all(&dir);
    }
}
