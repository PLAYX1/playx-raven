//! 앱 안 「진짜인지 확인」 (0.8.8a).
//!
//! 웹 확인 페이지(`/verify/`)는 우리 서버(`/api/chain/verify`)가 대신 장부를 읽어 준다. 앱은 **내 노드**가
//! 있으므로 서버 없이 직접 읽는다 — 웹은 서버를 믿어야 하지만 앱은 내 노드를 믿는다.
//!
//! ## 할 수 있는 것
//! - `getassetdata` — 장부에 이 이름이 있는지 · 수량 · 다시 찍을 수 있는지 · 적힌 파일 주소.
//! - `listaddressesbyasset` — 주인 표(`이름!`)를 가진 주소 · 보유 주소 수 (**자산 색인이 켜져 있을 때만**).
//! - `pin_list` — 이 컴퓨터가 그 파일 주소를 붙잡고 있는가(붙잡은 파일은 주소와 같을 수밖에 없다: 받을 때 검증된다).
//! - 끌어놓은 파일의 지문 대조 — SHA-256 지문(≤512MB)과 IPFS 방식 주소(≤64MB, 내 파일창고로 계산만 한다).
//!
//! ## 🔴 거짓 「안전」·거짓 「없음」을 말하지 않는다
//! - 노드가 따라잡는 중이거나 꺼져 있으면 「없음」을 믿지 않는다 — `unknown`(확인 못 함)이다.
//!   「없음」은 노드가 다 따라잡았고(`issue::chain_caught_up`) 정상 응답 `null` 일 때만이다.
//! - 오류 문구가 무엇이든(「Invalid」「not found」 포함) 오류는 모름이다.
//! - 색인이 꺼진 노드는 오류 문장을 **정상 응답**으로 돌려준다 → `index:"off"` 로 구분한다.
//! - 파일이 다르다고 위조라고 단정하지 않는다(다른 파일을 놓았거나 올린 방식이 다를 수 있다).
//! - 앱은 이 확인에서 시드·키·비밀번호를 읽지 않는다. 지갑을 열지 않는다.

use serde_json::{json, Value};

const MAX_IPFS_STYLE_BYTES: u64 = 64 * 1024 * 1024;

/// 장부 조회 결과를 셋 중 하나로. 순수 함수 — 시험이 여기를 본다.
///
/// - 결과가 객체이고 `name` 이 **정확히** 같다 → `found` (동기화와 무관: 있다는 것은 확실하다).
/// - `null` 이고 노드가 다 따라잡았다 → `not_found`.
/// - 그 밖의 전부 → `unknown`, 이유는 `node_down`(장부 상태를 못 읽음) · `syncing`(따라잡는 중) · `error`.
pub(crate) fn classify(name: &str, chain: Result<&Value, &str>, data: Result<&Value, &str>) -> (&'static str, Option<&'static str>) {
    if let Ok(Value::Object(o)) = data {
        if o.get("name").and_then(Value::as_str) == Some(name) {
            return ("found", None);
        }
    }
    let reason = match chain {
        Err(_) => "node_down",
        Ok(info) if !crate::issue::chain_caught_up(info) => "syncing",
        Ok(_) => "error",
    };
    if let (Ok(Value::Null), Ok(info)) = (data, chain) {
        if crate::issue::chain_caught_up(info) {
            return ("not_found", None);
        }
    }
    ("unknown", Some(reason))
}

/// 이 자산의 「주인 표」 이름. 고유(`#`)·채널(`~`) 자산은 부모의 주인 표가 발급 권한이다.
pub(crate) fn owner_token_for(name: &str) -> String {
    if let Some(i) = name.rfind(['#', '~']) {
        return format!("{}!", &name[..i]);
    }
    format!("{}!", name.trim_end_matches('!'))
}

/// `listaddressesbyasset` 답을 읽는다. 색인이 꺼진 노드는 오류 문장을 정상 응답으로 준다.
/// (index 상태, 주소 목록 또는 개수)
pub(crate) fn read_index(answer: Result<&Value, &str>) -> (&'static str, Option<Vec<String>>, Option<u64>) {
    match answer {
        Ok(Value::String(t)) if t.contains("assetindex") || t.starts_with("_This rpc call is not functional") => ("off", None, None),
        Ok(Value::Object(o)) => ("on", Some(o.keys().cloned().collect()), Some(o.len() as u64)),
        Ok(Value::Number(n)) => ("on", None, n.as_u64()),
        Err(e) if e.contains("assetindex") => ("off", None, None),
        _ => ("unknown", None, None),
    }
}

fn flag(v: &Value, key: &str) -> Option<bool> {
    match v.get(key)? {
        Value::Bool(b) => Some(*b),
        Value::Number(n) => n.as_i64().map(|x| x != 0),
        _ => None,
    }
}

fn valid_name(name: &str) -> bool {
    let n = name.trim();
    !n.is_empty() && n.len() <= 64 && n.chars().all(|c| !c.is_control() && !c.is_whitespace())
}

fn short(a: &str) -> String {
    if a.len() <= 12 { a.to_string() } else { format!("{}…{}", &a[..4], &a[a.len() - 4..]) }
}

/// 내 노드로 이 자산을 확인한다. 읽기만 하고 아무것도 바꾸지 않는다.
#[tauri::command]
pub async fn asset_verify(name: String) -> Result<Value, String> {
    let name = name.trim().to_string();
    if !valid_name(&name) {
        return Err("자산 이름이 올바르지 않습니다.".into());
    }
    let chain = crate::raven::call_rpc("getblockchaininfo", json!([])).await;
    let data = crate::raven::call_rpc("getassetdata", json!([name.clone()])).await;
    let (status, reason) = classify(&name, chain.as_ref().map_err(String::as_str), data.as_ref().map_err(String::as_str));
    let height = chain.as_ref().ok().and_then(|c| c["blocks"].as_u64());
    let caught_up = chain.as_ref().ok().map(crate::issue::chain_caught_up);

    let mut out = json!({
        "name": name,
        "status": status,
        "reason": reason,
        "height": height,
        "caught_up": caught_up,
        "at": std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0),
    });
    if status != "found" {
        return Ok(out);
    }
    let d = data.as_ref().map_err(|e| e.clone())?;
    let hash = d.get("ipfs_hash").and_then(Value::as_str).unwrap_or("").to_string();
    let has_ipfs = flag(d, "has_ipfs").unwrap_or(!hash.is_empty()) && !hash.is_empty();
    out["unique"] = json!(name.contains('#'));
    out["amount"] = d.get("amount").cloned().unwrap_or(Value::Null);
    out["units"] = d.get("units").cloned().unwrap_or(Value::Null);
    out["reissuable"] = flag(d, "reissuable").map_or(Value::Null, Value::Bool);
    out["has_ipfs"] = json!(has_ipfs);
    out["ipfs_hash"] = json!(if has_ipfs { hash.as_str() } else { "" });

    // 주인 표 · 보유 주소 (자산 색인이 켜져 있어야 한다).
    let owner = owner_token_for(&name);
    let owners = crate::raven::call_rpc("listaddressesbyasset", json!([owner.clone()])).await;
    let (index, addrs, owner_count) = read_index(owners.as_ref().map_err(String::as_str));
    out["index"] = json!(index);
    out["owner_token"] = json!(owner);
    out["owner_count"] = json!(owner_count);
    out["owner_sample"] = json!(addrs.unwrap_or_default().iter().take(3).map(|a| short(a)).collect::<Vec<_>>());
    if index == "on" {
        let holders = crate::raven::call_rpc("listaddressesbyasset", json!([name.clone(), true])).await;
        let (_, _, count) = read_index(holders.as_ref().map_err(String::as_str));
        out["holders"] = json!(count);
    }

    // 이 컴퓨터가 파일을 붙잡고 있나. 붙잡은 파일은 주소와 같을 수밖에 없다(받을 때 검증된다).
    out["local"] = json!(if !has_ipfs {
        "none"
    } else if crate::create_history::fingerprint_set().contains(&hash) {
        "fingerprint_made_here"
    } else {
        match crate::ipfs::pin_list().await {
            Ok(pins) if pins.iter().any(|p| p == &hash) => "pinned",
            Ok(_) => "not_pinned",
            Err(_) => "unknown",
        }
    });
    Ok(out)
}

/// 읽은 바이트로 IPFS 방식 주소(CIDv0)를 **계산만** 한다 — 내 파일창고에 저장하지 않는다(`only-hash`, `pin=false`).
async fn ipfs_style_cid(path: String) -> Option<String> {
    let bytes = tauri::async_runtime::spawn_blocking(move || std::fs::read(path)).await.ok()?.ok()?;
    let part = reqwest::multipart::Part::bytes(bytes).file_name("file");
    let form = reqwest::multipart::Form::new().part("file", part);
    let r = reqwest::Client::new()
        .post("http://127.0.0.1:5001/api/v0/add?only-hash=true&pin=false&cid-version=0&quieter=true")
        .multipart(form)
        .timeout(std::time::Duration::from_secs(120))
        .send()
        .await
        .ok()?;
    if !r.status().is_success() {
        return None;
    }
    let text = r.text().await.ok()?;
    let last = text.lines().rev().find(|l| !l.trim().is_empty())?;
    let v: Value = serde_json::from_str(last).ok()?;
    v.get("Hash").and_then(Value::as_str).map(str::to_string)
}

/// 끌어놓은 파일이 장부에 적힌 원본과 같은지 대조한다. 파일은 어디에도 올리지 않는다.
///
/// 장부의 파일 주소는 이 명령이 노드에서 **다시 읽는다**(화면이 준 값을 믿지 않는다).
/// `match_kind`: `fingerprint`(SHA-256 지문이 같음) · `ipfs`(IPFS 방식 주소가 같음) · `none`(같지 않음 — 위조 단정 아님).
#[tauri::command]
pub async fn asset_verify_file(name: String, path: String) -> Result<Value, String> {
    let name = name.trim().to_string();
    if !valid_name(&name) {
        return Err("자산 이름이 올바르지 않습니다.".into());
    }
    if !crate::dropbox::was_dropped(&path) {
        return Err("이 파일은 창에 떨어뜨린 것이 아닙니다.".into());
    }
    let data = crate::raven::call_rpc("getassetdata", json!([name.clone()]))
        .await
        .map_err(|_| "내 노드에서 이 자산의 파일 주소를 읽지 못했어요.".to_string())?;
    let chain_hash = match (&data, data.get("name").and_then(Value::as_str)) {
        (Value::Object(_), Some(n)) if n == name => data.get("ipfs_hash").and_then(Value::as_str).unwrap_or("").to_string(),
        _ => return Err("내 노드에서 이 자산의 파일 주소를 읽지 못했어요.".into()),
    };
    if chain_hash.is_empty() {
        return Err("이 자산에는 파일 주소가 새겨져 있지 않아서 대조할 수 없어요.".into());
    }
    let fp = crate::create::create_dropped_fingerprint(path.clone()).await?;
    let fingerprint = fp["fingerprint"].as_str().unwrap_or("").to_string();
    let size = fp["size"].as_u64().unwrap_or(0);
    let mut ipfs_checked = false;
    let mut kind = if !fingerprint.is_empty() && fingerprint == chain_hash { "fingerprint" } else { "none" };
    if kind == "none" && size <= MAX_IPFS_STYLE_BYTES {
        let ipfs_cid = ipfs_style_cid(path).await;
        ipfs_checked = ipfs_cid.is_some();
        if ipfs_cid.as_deref() == Some(chain_hash.as_str()) {
            kind = "ipfs";
        }
    }
    Ok(json!({
        "name": name,
        "file_name": fp["name"],
        "size": size,
        "match_kind": kind,
        "ipfs_checked": ipfs_checked,
        "ipfs_too_big": size > MAX_IPFS_STYLE_BYTES,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn synced() -> Value {
        json!({"chain":"main","initialblockdownload":false,"blocks":3_500_000,"headers":3_500_000})
    }
    fn syncing() -> Value {
        json!({"chain":"main","initialblockdownload":true,"blocks":100,"headers":3_500_000})
    }

    /// 🔴 따라잡는 중인 노드의 「없음」은 「없음」이 아니다.
    #[test]
    fn 따라잡는_중이면_없음을_믿지_않는다() {
        let null = Value::Null;
        assert_eq!(classify("A", Ok(&synced()), Ok(&null)), ("not_found", None));
        assert_eq!(classify("A", Ok(&syncing()), Ok(&null)), ("unknown", Some("syncing")));
        assert_eq!(classify("A", Err("down"), Ok(&null)), ("unknown", Some("node_down")));
    }

    #[test]
    fn 오류_문구는_무엇이든_모름이다() {
        for e in ["Invalid asset name", "Asset not found", "not found", "", "서버에 닿지 못했습니다"] {
            let (s, _) = classify("A", Ok(&synced()), Err(e));
            assert_eq!(s, "unknown", "{e:?}");
        }
        // 다른 이름이 돌아오면 있다고 하지 않는다.
        let other = json!({"name":"B","amount":1});
        assert_eq!(classify("A", Ok(&synced()), Ok(&other)).0, "unknown");
        let ok = json!({"name":"A","amount":1});
        assert_eq!(classify("A", Ok(&syncing()), Ok(&ok)), ("found", None), "있다는 것은 동기화와 무관하게 확실");
    }

    #[test]
    fn 주인_표는_고유와_채널이면_부모의_것이다() {
        assert_eq!(owner_token_for("PLAYX"), "PLAYX!");
        assert_eq!(owner_token_for("PLAYX/MUSIC"), "PLAYX/MUSIC!");
        assert_eq!(owner_token_for("HANBIT#SURYO260924-1"), "HANBIT!");
        assert_eq!(owner_token_for("A/B#C"), "A/B!");
        assert_eq!(owner_token_for("ROOT~MSG"), "ROOT!");
    }

    /// 🔴 색인이 꺼진 노드는 오류 문장을 정상 응답으로 준다 — 「주소 0곳」으로 읽으면 거짓이다.
    #[test]
    fn 색인이_꺼진_답은_꺼짐으로_읽는다() {
        let off = json!("_This rpc call is not functional unless -assetindex is enabled. To enable this, please run the wallet with -assetindex");
        assert_eq!(read_index(Ok(&off)).0, "off");
        assert_eq!(read_index(Err("-assetindex is enabled")).0, "off");
        assert_eq!(read_index(Err("timeout")).0, "unknown");
        let on = json!({"RAddr1":1,"RAddr2":1});
        let (s, a, n) = read_index(Ok(&on));
        assert_eq!((s, a.map(|x| x.len()), n), ("on", Some(2), Some(2)));
        assert_eq!(read_index(Ok(&json!(7))), ("on", None, Some(7)));
        assert_eq!(read_index(Ok(&json!(null))).0, "unknown");
    }

    #[test]
    fn 이름_검사와_주소_줄임() {
        assert!(valid_name("HANBIT#SURYO260924-1"));
        assert!(!valid_name("") && !valid_name("A B") && !valid_name(&"A".repeat(65)));
        assert_eq!(short("RAddrLongLongLongAddress"), "RAdd…ress");
        assert_eq!(short("RShort"), "RShort");
    }
}
