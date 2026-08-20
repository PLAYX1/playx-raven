//! Asset issuance.
//!
//! Issuing burns RVN and cannot be undone. Nothing here decides anything on the
//! user's behalf: the checks answer "would this work and what would it cost",
//! and the actual issue call happens only after the UI has made the user type
//! the name back.

use crate::raven::call_rpc;
use serde_json::{json, Value};

/// Burn amounts, from chainparams.cpp. Hard-coded because the node offers no RPC
/// to ask, and because showing the wrong figure before an irreversible action
/// would be worse than showing none.
pub const BURN_ROOT: f64 = 500.0;
pub const BURN_SUB: f64 = 100.0;
pub const BURN_UNIQUE: f64 = 5.0;

#[derive(PartialEq, Debug)]
enum Kind {
    Root,
    Sub,
    Unique,
}

fn classify(name: &str) -> Kind {
    if name.contains('#') {
        Kind::Unique
    } else if name.contains('/') {
        Kind::Sub
    } else {
        Kind::Root
    }
}

/// Checks a name against the consensus rules before any RVN is spent.
///
/// The rules come from assets/assets.cpp. They are ASCII-only, which is not our
/// choice to make — a Korean or Japanese asset name cannot exist on this chain,
/// and telling the user that early is kinder than letting them find out after
/// a failed transaction.
#[tauri::command]
pub fn validate_name(name: String) -> Value {
    let kind = classify(&name);
    let mut problems: Vec<String> = Vec::new();

    let root = name
        .split(['/', '#'])
        .next()
        .unwrap_or("")
        .trim_start_matches(['$', '#'])
        .to_string();

    if root.len() < 3 {
        problems.push("루트 이름은 3글자 이상이어야 합니다".into());
    }
    if !root
        .chars()
        .all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == '.' || c == '_')
    {
        problems.push("루트 이름에는 영문 대문자·숫자·점·밑줄만 쓸 수 있습니다".into());
    }

    if kind == Kind::Sub {
        let sub = name.split('/').nth(1).unwrap_or("");
        if sub.is_empty() {
            problems.push("/ 뒤에 하위 이름이 필요합니다".into());
        } else if !sub
            .chars()
            .all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == '.' || c == '_')
        {
            problems.push("하위 이름에는 영문 대문자·숫자·점·밑줄만 쓸 수 있습니다".into());
        }
    }

    if kind == Kind::Unique {
        let tag = name.split('#').nth(1).unwrap_or("");
        if tag.is_empty() {
            problems.push("# 뒤에 고유 태그가 필요합니다".into());
        }
        // Unique tags allow lower case and more punctuation than root names do.
    }

    if name.len() > 31 {
        problems.push("이름은 31자를 넘을 수 없습니다".into());
    }

    json!({
        "valid": problems.is_empty(),
        "problems": problems,
        "kind": match kind {
            Kind::Root => "root",
            Kind::Sub => "sub",
            Kind::Unique => "unique",
        },
        "burn": match classify(&name) {
            Kind::Root => BURN_ROOT,
            Kind::Sub => BURN_SUB,
            Kind::Unique => BURN_UNIQUE,
        },
    })
}

/// Has someone already taken this name?
///
/// Asset names are permanent and global. A name that exists cannot be issued
/// again by anyone, so this has to be checked against the chain rather than
/// guessed.
#[tauri::command]
pub async fn name_taken(name: String) -> Result<bool, String> {
    match call_rpc("getassetdata", json!([name])).await {
        // A result means the asset exists.
        Ok(v) => Ok(!v.is_null()),
        // The node answers with an error for names it has never seen, which is
        // the answer we want rather than a failure.
        Err(e) if e.contains("not found") || e.contains("Invalid") => Ok(false),
        Err(e) => Err(e),
    }
}

/// Issues the asset. Burns RVN. Cannot be undone.
///
/// `reissuable` defaults to true at the call site for a reason: false is the
/// door that locks behind you, and a default should never be the irreversible
/// option.
#[tauri::command]
pub async fn issue_asset(
    name: String,
    qty: f64,
    units: u8,
    reissuable: bool,
    ipfs_hash: Option<String>,
    to_address: Option<String>,
) -> Result<String, String> {
    let check = validate_name(name.clone());
    if !check["valid"].as_bool().unwrap_or(false) {
        return Err(format!(
            "이름 규칙에 맞지 않습니다: {}",
            check["problems"]
                .as_array()
                .map(|a| a
                    .iter()
                    .filter_map(Value::as_str)
                    .collect::<Vec<_>>()
                    .join(", "))
                .unwrap_or_default()
        ));
    }

    if name_taken(name.clone()).await.unwrap_or(false) {
        return Err("이미 존재하는 이름입니다. 자산 이름은 영구적이라 다시 쓸 수 없습니다.".into());
    }

    // issue "name" qty "to_address" "change_address" units reissuable has_ipfs "ipfs_hash"
    let params = json!([
        name,
        qty,
        to_address.unwrap_or_default(),
        "",
        units,
        reissuable,
        ipfs_hash.is_some(),
        ipfs_hash.unwrap_or_default(),
    ]);

    let result = call_rpc("issue", params).await?;
    let txid = result
        .as_array()
        .and_then(|a| a.first())
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    crate::refund::remember_ours(&txid);
    Ok(txid)
}
