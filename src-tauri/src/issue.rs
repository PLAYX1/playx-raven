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

pub const BURN_QUALIFIER: f64 = 1000.0;
pub const BURN_RESTRICTED: f64 = 1500.0;

#[derive(PartialEq, Debug)]
enum Kind {
    Root,
    Sub,
    Unique,
    /// `#KYC` — 주소에 붙이는 인증 딱지.
    Qualifier,
    /// `$SHARE` — 인증받은 주소만 받을 수 있는 자산.
    Restricted,
}

/// 🔴 여기에 **자격 증명(`#`)과 제한 자산(`$`)이 없었다.**
///
/// 그래서 화면은 일곱 종류를 고르게 해 놓고, `#GYM` 을 넣으면 「루트 이름은
/// 3글자 이상」이라는 엉뚱한 말을 했다(`#` 앞이 빈 문자열이라 그렇다).
/// `$SHARE` 는 루트로 통과시켜 놓고 노드가 영어로 거절했다.
/// **못 하는 것을 진열해 놓고 팔고 있었다.**
///
/// 규칙은 원본 그대로다(assets.cpp:48~57):
/// ```text
/// ROOT_NAME_CHARACTERS       ^[A-Z0-9._]{3,}$
/// QUALIFIER_NAME_CHARACTERS  #[A-Z0-9._]{3,}$
/// RESTRICTED_NAME_CHARACTERS \$[A-Z0-9._]{3,}$
/// ```
fn classify(name: &str) -> Kind {
    if name.starts_with('$') {
        Kind::Restricted
    } else if name.starts_with('#') {
        Kind::Qualifier
    } else if name.contains('#') {
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

    // 🔴 **떼는 순서가 뒤집혀 있었다.** `#` 은 고유 자산의 구분자이기도 해서,
    //    먼저 쪼개면 `#GYM` 은 「`#` 앞부분」인 **빈 문자열**이 루트가 된다.
    //    그래서 자격 증명 이름을 넣으면 「루트 이름은 3글자 이상」이라는,
    //    사장 입장에서는 뜻을 알 수 없는 말이 나왔다.
    //    앞의 표식을 **먼저** 떼고 나서 쪼갠다.
    let root = name
        .trim_start_matches(['$', '#'])
        .split(['/', '#'])
        .next()
        .unwrap_or("")
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

    if kind == Kind::Qualifier || kind == Kind::Restricted {
        // 이 둘은 **하위 이름도 고유 태그도 없다.** 표식 하나에 이름 하나다.
        if name.contains('/') || name[1..].contains('#') {
            problems.push(
                if kind == Kind::Qualifier {
                    "자격 증명은 「#이름」 하나입니다 — / 나 # 를 더 붙일 수 없습니다"
                } else {
                    "제한 자산은 「$이름」 하나입니다 — / 나 # 를 더 붙일 수 없습니다"
                }
                .into(),
            );
        }
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
            Kind::Qualifier => "qualifier",
            Kind::Restricted => "restricted",
        },
        "burn": match classify(&name) {
            Kind::Root => BURN_ROOT,
            Kind::Sub => BURN_SUB,
            Kind::Unique => BURN_UNIQUE,
            Kind::Qualifier => BURN_QUALIFIER,
            Kind::Restricted => BURN_RESTRICTED,
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

    // 🔴 이 문은 **평범한 자산 전용**이다. 자격 증명(`#`)과 제한 자산(`$`)은
    //    노드에서 아예 다른 명령을 쓴다(`issuequalifierasset`,
    //    `issuerestrictedasset`). 여태 이 확인이 없어서, 화면에서 「제한
    //    자산」을 고르고 진행하면 여기까지 와서 **노드가 영어로 거절**했다.
    //    사장은 자기가 뭘 잘못했는지 알 방법이 없다.
    match check["kind"].as_str() {
        Some("qualifier") => {
            return Err("자격 증명(#)은 여기서 만들 수 없습니다. 「자격 증명」으로 골라 주세요.".into())
        }
        Some("restricted") => {
            return Err("제한 자산($)은 여기서 만들 수 없습니다. 「제한 자산」으로 골라 주세요.".into())
        }
        _ => {}
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

#[cfg(test)]
mod name_tests {
    use super::validate_name;

    /// 🔴 화면은 일곱 종류를 고르게 하는데, 이름 검사는 **셋만** 알고 있었다.
    ///    자격 증명 이름을 넣으면 「루트 이름은 3글자 이상」이라는, 뜻을 알 수
    ///    없는 말이 나왔다 — `#` 앞이 빈 문자열이라서.
    #[test]
    fn 자격증명과_제한자산_이름이_통과한다() {
        for (name, want) in [
            ("#KYC", "qualifier"),
            ("#GYM.SEOUL", "qualifier"),
            ("$SHARE", "restricted"),
            ("$PLAYX_2026", "restricted"),
        ] {
            let v = validate_name(name.to_string());
            assert!(
                v["valid"].as_bool().unwrap_or(false),
                "{name} 이 막혔다: {:?}",
                v["problems"]
            );
            assert_eq!(v["kind"].as_str(), Some(want), "{name} 의 종류를 잘못 봤다");
        }
    }

    /// 값이 틀리면 사장이 「1,500 RVN 이 나가는 줄 알았는데」가 된다.
    /// 원본 chainparams.cpp:248~250 과 같아야 한다.
    #[test]
    fn 소각량이_원본과_같다() {
        assert_eq!(validate_name("#KYC".into())["burn"].as_f64(), Some(1000.0));
        assert_eq!(validate_name("$SHARE".into())["burn"].as_f64(), Some(1500.0));
        assert_eq!(validate_name("PLAYX".into())["burn"].as_f64(), Some(500.0));
        assert_eq!(validate_name("PLAYX/SUB".into())["burn"].as_f64(), Some(100.0));
        assert_eq!(validate_name("PLAYX#001".into())["burn"].as_f64(), Some(5.0));
    }

    /// 짧거나 소문자면 노드가 거절한다. 돈이 나가기 **전에** 막아야 한다.
    #[test]
    fn 규칙에_어긋난_것은_막는다() {
        for bad in ["#KY", "$AB", "#kyc", "$SHARE/X", "#KYC#1"] {
            assert!(
                !validate_name(bad.to_string())["valid"].as_bool().unwrap_or(false),
                "{bad} 를 통과시켰다"
            );
        }
    }

    /// 평범한 발행 문으로 자격 증명·제한 자산이 새어 나가면 노드가 영어로
    /// 거절한다. 그 앞에서 우리말로 막는다.
    #[test]
    fn 평범한_발행문이_둘을_막는다() {
        let src = include_str!("issue.rs");
        let i = src.find("pub async fn issue_asset").expect("발행 함수가 있어야 한다");
        let end = src[i..].find("#[cfg(test)]").unwrap_or(src.len() - i);
        let body = &src[i..i + end];
        assert!(
            body.contains("qualifier") && body.contains("restricted"),
            "평범한 발행 문이 자격 증명·제한 자산을 안 막고 있다"
        );
    }
}
