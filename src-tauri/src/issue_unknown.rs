//! 발행 창(자산 마법사)의 「보냈는지 모름」 — **앱을 다시 켜도** 기억한다.
//!
//! 🔴 검수: 창 안의 기억(30분)만으로는 앱을 다시 켜면 같은 「더 찍기」(100 RVN)가
//!    또 나갔다. 그래서 작은 파일에 (이름, 종류, 시각)을 적는다.
//!
//! - 보내기 **직전**에 `sending` 으로 적는다 — 최대 3분 기다리는 동안 앱이 꺼져도 남는다.
//! - 분명히 끝나면(성공·거절) 지운다. 시간 초과면 `unknown` 으로 둔다.
//! - 다시 보내기 전에 지갑 거래(확인 0 포함)를 본다. 더 찍기는 이름이 이미 있어서
//!   「이름이 있나」로는 못 가린다 — 그 자산의 새 발행·재발행 기록이 지갑에 보이는지 본다.
//!   자산 줄은 `listsinceblock` 의 `asset_transactions` 에만 있다(`raven::wallet_asset_txs`).
//! - 한 시간 넘게 지갑 어디에도 안 보이면 안 나간 것으로 보고 지운다(만들기와 같은 기준).

use serde_json::{json, Value};
use std::collections::HashSet;
use std::sync::Mutex;

const FILE: &str = "issue_unknown.json";
const MAX_ROWS: usize = 50;
/// 지갑 시계와 이 컴퓨터 시계가 조금 달라도 놓치지 않게.
const CLOCK_SLACK_SECS: i64 = 600;

static LOCK: Mutex<()> = Mutex::new(());
/// 이 앱이 **지금** 보내는 중인 이름. 앱을 다시 켜면 비어 있다 — 그때 남은 `sending` 은
/// 보내다가 꺼진 것이다.
static SENDING: Mutex<Option<HashSet<String>>> = Mutex::new(None);

const KINDS: [&str; 7] = ["root", "sub", "unique", "bulk", "qualifier", "restricted", "reissue"];

fn path() -> std::path::PathBuf {
    crate::paths::app_file(FILE)
}

fn now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// 읽는다. 망가졌으면 옆으로 옮기고 빈 목록 — 쓸 때 자리를 바꿔 쓰므로(rename) 반쪽
/// 파일이 생길 일은 거의 없다.
fn load() -> Vec<Value> {
    let Ok(bytes) = std::fs::read(path()) else { return Vec::new() };
    match serde_json::from_slice::<Value>(&bytes) {
        Ok(Value::Array(rows)) => rows,
        _ => {
            let kept = path().with_file_name(format!("issue_unknown.corrupt-{}.json", now()));
            let _ = std::fs::rename(path(), kept);
            Vec::new()
        }
    }
}

fn save(rows: &[Value]) -> Result<(), String> {
    let bytes = serde_json::to_vec_pretty(rows).map_err(|e| e.to_string())?;
    crate::create_history::write_private(&path(), &bytes)
}

fn check_name(name: &str) -> Result<String, String> {
    let n = name.trim();
    if n.is_empty() || n.chars().count() > 64 || n.chars().any(|c| c.is_control() || c.is_whitespace()) {
        return Err("자산 이름을 확인해 주세요.".into());
    }
    Ok(n.to_string())
}

fn sending_set<T>(f: impl FnOnce(&mut HashSet<String>) -> T) -> T {
    let mut g = SENDING.lock().unwrap_or_else(|e| e.into_inner());
    f(g.get_or_insert_with(HashSet::new))
}

/// 적는다. `state` 는 `sending`(보내기 직전) 또는 `unknown`(시간 초과).
/// 🔴 `sending` 을 못 적으면 화면은 보내지 않는다.
#[tauri::command]
pub fn issue_unknown_mark(name: String, kind: String, probe: Option<String>, state: String) -> Result<(), String> {
    let name = check_name(&name)?;
    if !KINDS.contains(&kind.as_str()) {
        return Err("무엇을 발행하는지 다시 골라 주세요.".into());
    }
    if !matches!(state.as_str(), "sending" | "unknown") {
        return Err("상태가 올바르지 않아요.".into());
    }
    let probe = match probe.as_deref().map(str::trim).filter(|p| !p.is_empty()) {
        Some(p) => check_name(p)?,
        None => name.clone(),
    };
    let _g = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut rows = load();
    let at = rows
        .iter()
        .find(|r| r["name"] == name.as_str())
        .and_then(|r| r["at"].as_i64())
        .filter(|_| state == "unknown")
        .unwrap_or_else(now);
    rows.retain(|r| r["name"] != name.as_str());
    rows.push(json!({ "name": name, "kind": kind, "probe": probe, "state": state, "at": at }));
    if rows.len() > MAX_ROWS {
        let extra = rows.len() - MAX_ROWS;
        rows.drain(..extra);
    }
    save(&rows)?;
    sending_set(|s| {
        if state == "sending" {
            s.insert(name.clone());
        } else {
            s.remove(&name);
        }
    });
    Ok(())
}

/// 분명히 끝났다(성공했거나 노드가 거절했다) — 지운다.
#[tauri::command]
pub fn issue_unknown_clear(name: String) -> Result<(), String> {
    let name = check_name(&name)?;
    sending_set(|s| s.remove(&name));
    let _g = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut rows = load();
    let before = rows.len();
    rows.retain(|r| r["name"] != name.as_str());
    if rows.len() != before {
        save(&rows)?;
    }
    Ok(())
}

/// 지갑 거래 기록에서 이 자산의 발행(또는 재발행)을 찾는다.
/// 돌려주는 것: (확인 0 인 것이 있나, `since` 뒤의 것이 있나)
fn wallet_sees(txs: &Value, probe: &str, kind: &str, since: Option<i64>) -> (bool, bool) {
    let want = if kind == "reissue" { "reissue_asset" } else { "new_asset" };
    let mut pending = false;
    let mut after = false;
    for tx in txs.as_array().into_iter().flatten() {
        if tx["asset_name"].as_str() != Some(probe) || tx["asset_type"].as_str() != Some(want) {
            continue;
        }
        if tx["abandoned"].as_bool() == Some(true) {
            continue;
        }
        let conf = tx["confirmations"].as_i64().unwrap_or(0);
        if conf == 0 {
            pending = true;
        }
        let t = tx["time"].as_i64().unwrap_or(0).max(tx["timereceived"].as_i64().unwrap_or(0));
        if let Some(s) = since {
            if conf >= 0 && t >= s - CLOCK_SLACK_SECS {
                after = true;
            }
        }
    }
    (pending, after)
}

/// 판정만 한다(시험할 수 있게 노드 없이).
fn decide(row: Option<&Value>, sending_now: bool, txs: &Value, probe: &str, kind: &str, now_unix: i64) -> &'static str {
    match row {
        Some(r) => {
            if r["state"] == "sending" && sending_now {
                return "sending";
            }
            let at = r["at"].as_i64().unwrap_or(0);
            let (_, after) = wallet_sees(txs, probe, kind, Some(at));
            if after {
                return "landed";
            }
            if now_unix - at >= crate::create_history::UNKNOWN_GIVE_UP_SECS {
                let (pending, _) = wallet_sees(txs, probe, kind, None);
                return if pending { "pending" } else { "gave-up" };
            }
            "unknown"
        }
        None => {
            let (pending, _) = wallet_sees(txs, probe, kind, None);
            if pending {
                "pending"
            } else {
                "none"
            }
        }
    }
}

/// 보내기 전에 — 이 이름으로 보냈는지 모르는 것이 있나, 지갑에 아직 기록 중(확인 0)인
/// 같은 발행이 있나.
///
/// - `none`: 보내도 된다.
/// - `sending`: 지금 보내는 중.
/// - `unknown`: 보냈는지 모름 — 보내지 않는다.
/// - `pending`: 지갑에 확인 0 인 같은 발행이 있다 — 기록된 뒤에.
/// - `landed`: 지난번 것이 지갑에 기록돼 있다(기억은 지운다) — 화면이 한 번 알린다.
///
/// 🔴 지갑을 못 읽으면 오류다 — 「모름」을 「없음」으로 넘기지 않는다.
#[tauri::command]
pub async fn issue_unknown_check(name: String, kind: String, probe: Option<String>) -> Result<Value, String> {
    let name = check_name(&name)?;
    let row = {
        let _g = LOCK.lock().unwrap_or_else(|e| e.into_inner());
        load().into_iter().find(|r| r["name"] == name.as_str())
    };
    let probe = match probe.as_deref().map(str::trim).filter(|p| !p.is_empty()) {
        Some(p) => check_name(p)?,
        None => row.as_ref().and_then(|r| r["probe"].as_str().map(str::to_string)).unwrap_or_else(|| name.clone()),
    };
    let kind = row.as_ref().and_then(|r| r["kind"].as_str().map(str::to_string)).unwrap_or(kind);
    // 🔴 `listtransactions` 가 아니다 — 거기엔 자산 줄이 없어 늘 빈손이었다(검수 R3-1).
    let txs = crate::raven::wallet_asset_txs().await?;
    let sending_now = sending_set(|s| s.contains(&name));
    let state = decide(row.as_ref(), sending_now, &txs, &probe, &kind, now());
    if matches!(state, "landed" | "gave-up") {
        issue_unknown_clear(name.clone())?;
    }
    let since = row.as_ref().and_then(|r| r["at"].as_i64());
    Ok(json!({
        "state": if state == "gave-up" { "none" } else { state },
        "since": since,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tx(name: &str, kind: &str, conf: i64, time: i64) -> Value {
        json!({ "asset_name": name, "asset_type": kind, "confirmations": conf, "time": time, "category": "receive" })
    }

    /// 검수 W3 — 더 찍기는 이름이 이미 있다. 지갑의 재발행 기록(확인 0 포함)으로 가린다.
    #[test]
    fn 더_찍기는_지갑의_재발행_기록으로_가린다() {
        let at = 1_800_000_000;
        let row = json!({ "name": "MYSHOP", "kind": "reissue", "probe": "MYSHOP", "state": "unknown", "at": at });
        let none = json!([]);
        assert_eq!(decide(Some(&row), false, &none, "MYSHOP", "reissue", at + 60), "unknown", "모르면 보내지 않는다");
        // 예전 재발행·다른 자산·새 발행 기록은 이번 것이 아니다.
        let noise = json!([tx("MYSHOP", "reissue_asset", 50, at - 86_400), tx("OTHER", "reissue_asset", 0, at + 5), tx("MYSHOP", "transfer_asset", 0, at + 5)]);
        assert_eq!(decide(Some(&row), false, &noise, "MYSHOP", "reissue", at + 60), "unknown");
        let landed = json!([tx("MYSHOP", "reissue_asset", 0, at + 2)]);
        assert_eq!(decide(Some(&row), false, &landed, "MYSHOP", "reissue", at + 60), "landed");
        // 기억이 없어도 확인 0 인 같은 재발행이 있으면 기다린다(앱이 보내다 꺼진 경우).
        assert_eq!(decide(None, false, &landed, "MYSHOP", "reissue", at + 60), "pending");
        assert_eq!(decide(None, false, &none, "MYSHOP", "reissue", at + 60), "none");
    }

    /// 검수 R3-1 — 진짜 4.8 노드는 자산 줄을 `listsinceblock` 의 `asset_transactions` 에만 준다.
    /// 그 답을 그대로 넣어 「기록됨」「기록 중」을 알아보는지 본다.
    #[test]
    fn 진짜_노드_모양에서_재발행을_알아본다() {
        let at = 1_800_000_000;
        let row = json!({ "name": "MYSHOP", "kind": "reissue", "probe": "MYSHOP", "state": "unknown", "at": at });
        let node = |conf: i64| json!({
            "transactions": [{ "category": "send", "address": "RChange", "amount": -100, "confirmations": conf, "time": at + 2 }],
            "asset_transactions": [{ "asset_type": "reissue_asset", "asset_name": "MYSHOP", "amount": 1000,
                "destination": "RMine", "vout": 2, "category": "receive", "confirmations": conf,
                "time": at + 2, "timereceived": at + 2, "abandoned": false }],
            "removed": [], "lastblock": "00"
        });
        let landed = crate::raven::asset_transactions_of(node(1)).unwrap();
        assert_eq!(decide(Some(&row), false, &landed, "MYSHOP", "reissue", at + 60), "landed");
        assert_eq!(decide(Some(&row), false, &landed, "MYSHOP", "reissue", at + 7_200), "landed", "한 시간 뒤에도 기록은 기록");
        let pending = crate::raven::asset_transactions_of(node(0)).unwrap();
        assert_eq!(decide(None, false, &pending, "MYSHOP", "reissue", at + 60), "pending");
    }

    #[test]
    fn 보내는_중과_한_시간_넘게_안_보인_것() {
        let at = 1_800_000_000;
        let sending = json!({ "name": "NEWSHOP", "kind": "root", "probe": "NEWSHOP", "state": "sending", "at": at });
        let none = json!([]);
        assert_eq!(decide(Some(&sending), true, &none, "NEWSHOP", "root", at + 5), "sending");
        // 앱을 다시 켰다 — 보내는 중이 아닌 `sending` 은 보냈는지 모름.
        assert_eq!(decide(Some(&sending), false, &none, "NEWSHOP", "root", at + 5), "unknown");
        assert_eq!(decide(Some(&sending), false, &none, "NEWSHOP", "root", at + 3_601), "gave-up");
        let landed = json!([tx("NEWSHOP", "new_asset", 1, at + 30)]);
        assert_eq!(decide(Some(&sending), false, &landed, "NEWSHOP", "root", at + 5), "landed");
        let abandoned = json!([{ "asset_name": "NEWSHOP", "asset_type": "new_asset", "confirmations": 0, "time": at + 30, "abandoned": true }]);
        assert_eq!(decide(None, false, &abandoned, "NEWSHOP", "root", at + 5), "none", "버린 거래는 기록 중이 아니다");
    }

    #[test]
    fn 앱을_다시_켜도_기억한다() {
        let _env = crate::paths::TEST_ENV.lock().unwrap_or_else(|e| e.into_inner());
        let dir = std::env::temp_dir().join(format!("rv-issue-unknown-{:x}", rand::random::<u64>()));
        std::fs::create_dir_all(&dir).unwrap();
        let old = std::env::var("PLAYX_RAVEN_HOME").ok();
        std::env::set_var("PLAYX_RAVEN_HOME", &dir);
        issue_unknown_mark("MYSHOP".into(), "reissue".into(), None, "sending".into()).unwrap();
        issue_unknown_mark("MYSHOP".into(), "reissue".into(), None, "unknown".into()).unwrap();
        // 앱을 다시 켰다: 메모리는 비고 파일만 남는다.
        sending_set(|s| s.clear());
        let rows = load();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0]["state"], "unknown");
        assert_eq!(rows[0]["kind"], "reissue");
        assert!(issue_unknown_mark("MY SHOP".into(), "reissue".into(), None, "unknown".into()).is_err());
        assert!(issue_unknown_mark("X".into(), "mint".into(), None, "unknown".into()).is_err());
        issue_unknown_clear("MYSHOP".into()).unwrap();
        assert!(load().is_empty());
        std::fs::write(path(), b"{broken").unwrap();
        assert!(load().is_empty(), "망가진 파일은 옆으로 옮기고 빈 목록");
        match old {
            Some(v) => std::env::set_var("PLAYX_RAVEN_HOME", v),
            None => std::env::remove_var("PLAYX_RAVEN_HOME"),
        }
        let _ = std::fs::remove_dir_all(&dir);
    }
}
