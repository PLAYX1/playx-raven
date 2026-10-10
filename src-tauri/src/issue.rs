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

    // 🔴 31 이 아니라 **30** 이다. 코어의 `MAX_NAME_LENGTH = 31` 은 주석에
    //    "excluding owner tag ('!')" 라 적혀 있고, 검사는
    //    `assets.cpp:370` 의 `name.size() > MAX_NAME_LENGTH - 1` 이다 —
    //    "Assets and sub-assets need to leave one extra char for OWNER indicator".
    //    31 로 적혀 있던 동안, 정확히 31자인 이름은 이 검사를 통과한 뒤
    //    노드가 영어로 거절했다. 사람은 왜 안 되는지 알 수 없었다.
    if name.len() > 30 {
        problems.push("이름은 30자를 넘을 수 없습니다 (주인 표시 `!` 자리를 한 칸 비웁니다)".into());
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

/// 이름 조회의 세 가지 답. **「비어 있음」은 노드가 정상으로 「없다」고 답했을 때만이다.**
///
/// 🔴 예전에는 노드 오류 문구에 `Invalid` 나 `not found` 가 들어 있으면 「비어 있음」으로
///    답했다. 그런데 노드 오류는 「없음」이 아니라 **「모름」**이다 — 동기화 중·색인 꺼짐·
///    시간 초과·이상한 이름 모두 오류로 온다. 모름이 「비어 있음」으로 새면 이미 있는
///    이름으로 발행을 시도하는 문이 열린다(소각만 하고 실패하거나, 화면이 「써도 된다」고 거짓말).
///    그래서 셋으로 나눈다: 있음(`Taken`)·없음(`Free`)·모름(`Unknown`). 모름이면 발행을 막는다.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NameLookup {
    Taken,
    Free,
    Unknown,
}

/// 「모름」일 때 화면에 보이는 한 줄(원인 → 다음 행동). 노드 원문 오류는 싣지 않는다.
pub const NAME_UNKNOWN_SAY: &str =
    "확인 불가: 이 이름이 체인에 이미 있는지 노드에 묻지 못했어요. 노드가 다 따라잡았는지 확인한 뒤 「다시 조회」를 눌러 주세요.";

/// 노드가 장부를 끝까지 따라잡았나 — 「없음」을 믿어도 되는 조건.
///
/// `getassetdata` 는 노드가 **지금까지 읽은 블록**만 안다. 따라잡는 중인 노드의 「없음」은
/// 「아직 못 읽었음」일 수 있다. 첫 동기화가 끝났고(`initialblockdownload == false`),
/// 받은 머리글까지 블록을 다 읽었을 때(`blocks == headers`)만 믿는다.
pub(crate) fn chain_caught_up(info: &Value) -> bool {
    info.get("initialblockdownload") == Some(&Value::Bool(false))
        && info["blocks"].as_u64().is_some_and(|b| b > 0)
        && info["blocks"].as_u64() == info["headers"].as_u64()
}

/// 노드 답 두 개(장부 상태·`getassetdata`)를 셋 중 하나로 엄격히 나눈다. 순수 함수 — 시험이 여기만 본다.
///
/// - 결과가 객체이고 `name` 이 묻는 이름과 **정확히** 같다 → `Taken`(동기화와 무관: 있다는 것은 확실하다).
/// - 결과가 `null` 이고 노드가 다 따라잡았다 → `Free`. 이것만이 「알려진 정상 없음 응답」이다.
/// - 그 밖의 전부(오류 문구가 무엇이든·빈 답·다른 이름·숫자/문자열/배열·동기화 중·장부 상태를 못 읽음) → `Unknown`.
pub(crate) fn classify_name_answer(
    name: &str,
    chain: Result<&Value, &str>,
    answer: Result<&Value, &str>,
) -> NameLookup {
    match answer {
        Ok(Value::Object(o)) => match o.get("name").and_then(Value::as_str) {
            Some(n) if n == name => NameLookup::Taken,
            _ => NameLookup::Unknown,
        },
        Ok(Value::Null) => match chain {
            Ok(info) if chain_caught_up(info) => NameLookup::Free,
            _ => NameLookup::Unknown,
        },
        Ok(_) | Err(_) => NameLookup::Unknown,
    }
}

/// 노드에 묻는다: 장부 상태(`getblockchaininfo`) + 자산 자료(`getassetdata`).
pub async fn lookup_name(name: &str) -> NameLookup {
    if name.is_empty() || name.len() > 64 {
        return NameLookup::Unknown;
    }
    let chain = call_rpc("getblockchaininfo", json!([])).await;
    let answer = call_rpc("getassetdata", json!([name])).await;
    classify_name_answer(
        name,
        chain.as_ref().map_err(String::as_str),
        answer.as_ref().map_err(String::as_str),
    )
}

/// Has someone already taken this name?
///
/// Asset names are permanent and global. A name that exists cannot be issued
/// again by anyone, so this has to be checked against the chain rather than
/// guessed.
///
/// 화면 약속(바꾸지 않음): `true` = 있음, `false` = 없음, **오류 = 확인 불가**.
/// 확인 불가를 `false` 로 바꾸어 넘기지 않는다(`lookup_name` 참고).
#[tauri::command]
pub async fn name_taken(name: String) -> Result<bool, String> {
    match lookup_name(&name).await {
        NameLookup::Taken => Ok(true),
        NameLookup::Free => Ok(false),
        NameLookup::Unknown => Err(NAME_UNKNOWN_SAY.into()),
    }
}

/// Issues the asset. Burns RVN. Cannot be undone.
///
/// `reissuable` defaults to true at the call site for a reason: false is the
/// door that locks behind you, and a default should never be the irreversible
/// option.
///
/// 돌려주는 것: `{ txid, owner_token, owner_pinned, … }`(`whose::issued`).
/// 하위·고유 발행은 부모 주인 표를 쓰고 돌려받는다 — 그 표가 **지금 있는 주소**를
/// 거스름 자리에 넣어 제자리로 돌아오게 한다(0.4.6). 루트는 새 표를 만드므로 해당 없음.
#[tauri::command]
pub async fn issue_asset(
    name: String,
    qty: f64,
    units: u8,
    reissuable: bool,
    ipfs_hash: Option<String>,
    to_address: Option<String>,
) -> Result<Value, String> {
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

    // 🔴 「모름」을 「없음」으로 넘기지 않는다(예전 `.unwrap_or(false)`). 모르면 발행하지 않는다.
    match lookup_name(&name).await {
        NameLookup::Free => {}
        NameLookup::Taken => {
            return Err("이미 존재하는 이름입니다. 자산 이름은 영구적이라 다시 쓸 수 없습니다.".into())
        }
        NameLookup::Unknown => return Err(NAME_UNKNOWN_SAY.into()),
    }

    // 🔴 주인 표 자리는 보내기 **전에** 읽는다(읽기만, 실패해도 막지 않는다).
    let pin = crate::whose::owner_pin("issue", &name).await;

    // issue "name" qty "to_address" "change_address" units reissuable has_ipfs "ipfs_hash"
    let params = crate::whose::with_change(
        "issue",
        json!([
            name,
            qty,
            to_address.unwrap_or_default(),
            "",
            units,
            reissuable,
            ipfs_hash.is_some(),
            ipfs_hash.unwrap_or_default(),
        ]),
        pin.change(),
    );

    let result = call_rpc("issue", params).await?;
    let txid = result
        .as_array()
        .and_then(|a| a.first())
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    crate::refund::remember_ours(&txid);
    Ok(crate::whose::issued(txid, &pin))
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

    /// 🔴 하위·고유 발행은 부모 주인 표를 **지금 있는 주소**로 돌려보낸다.
    ///    거스름 자리(`change_address`)가 늘 `""` 이면 노드가 표를 새 주소로 옮긴다.
    #[test]
    fn 하위_발행은_주인_표를_제자리로() {
        let src = include_str!("issue.rs");
        let i = src.find("pub async fn issue_asset").unwrap();
        let body = &src[i..i + src[i..].find("#[cfg(test)]").unwrap()];
        let pin = body.find("whose::owner_pin(\"issue\"").expect("주인 표 자리를 읽어야 한다");
        let send = body.find("call_rpc(\"issue\"").unwrap();
        assert!(pin < send, "보내기 전에 읽어야 한다");
        assert!(body.contains("whose::with_change(\n        \"issue\"") && body.contains("pin.change()"), "읽은 자리를 거스름 자리에 넣어야 한다");
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

#[cfg(test)]
mod name_lookup_tests {
    use super::{chain_caught_up, classify_name_answer, NameLookup};
    use serde_json::{json, Value};

    fn synced() -> Value {
        json!({"chain":"main","initialblockdownload":false,"blocks":3_500_000,"headers":3_500_000})
    }

    /// 🔴 고친 결함: 오류 문구에 「Invalid」「not found」가 들어 있으면 「비어 있음」이었다.
    ///    어떤 문구든 오류는 **모름**이다.
    #[test]
    fn 오류_문구는_무엇이든_모름이다() {
        let info = synced();
        for e in [
            "getassetdata: Invalid asset name",
            "getassetdata: Asset not found",
            "not found",
            "Invalid",
            "INVALID",
            "getassetdata: invalid parameter",
            "서버가 20초 안에 답하지 않았습니다 (getassetdata). 따라잡는 중이거나 바쁠 수 있습니다.",
            "서버에 닿지 못했습니다 (http://127.0.0.1:8766): connection refused",
            "Node returned something that is not JSON: EOF",
            "getassetdata: response had no result",
            "자산 색인이 꺼져 있습니다.",
            "",
        ] {
            assert_eq!(
                classify_name_answer("RV.M.FOREST", Ok(&info), Err(e)),
                NameLookup::Unknown,
                "{e:?} 를 모름으로 보지 않았다"
            );
        }
    }

    #[test]
    fn 정상_없음만_비어_있음이다() {
        assert_eq!(classify_name_answer("RV.M.FOREST", Ok(&synced()), Ok(&Value::Null)), NameLookup::Free);
    }

    #[test]
    fn 이름이_같은_자료면_있음이다() {
        let data = json!({"name":"RV.M.FOREST","amount":1,"units":0,"reissuable":1,"has_ipfs":1,"ipfs_hash":"Qm"});
        assert_eq!(classify_name_answer("RV.M.FOREST", Ok(&synced()), Ok(&data)), NameLookup::Taken);
        // 있다는 것은 동기화 중이어도 확실하다.
        let syncing = json!({"initialblockdownload":true,"blocks":10,"headers":3_500_000});
        assert_eq!(classify_name_answer("RV.M.FOREST", Ok(&syncing), Ok(&data)), NameLookup::Taken);
        assert_eq!(classify_name_answer("RV.M.FOREST", Err("down"), Ok(&data)), NameLookup::Taken);
    }

    /// 빈 답·형식 이상·다른 이름은 「있음」도 「없음」도 아니다.
    #[test]
    fn 형식_이상과_빈_답은_모름이다() {
        let info = synced();
        for v in [
            json!({}),
            json!({"name":"RV.M.FORES"}),
            json!({"name":"rv.m.forest"}),
            json!({"name":null}),
            json!({"name":7}),
            json!(""),
            json!("RV.M.FOREST"),
            json!(0),
            json!(false),
            json!([]),
            json!([{"name":"RV.M.FOREST"}]),
        ] {
            assert_eq!(classify_name_answer("RV.M.FOREST", Ok(&info), Ok(&v)), NameLookup::Unknown, "{v} 를 모름으로 보지 않았다");
        }
    }

    /// 따라잡는 중인 노드의 「없음」은 「아직 못 읽음」일 수 있다.
    #[test]
    fn 노드가_덜_따라잡았으면_없음도_모름이다() {
        for info in [
            json!({"initialblockdownload":true,"blocks":3_500_000,"headers":3_500_000}),
            json!({"initialblockdownload":false,"blocks":3_499_999,"headers":3_500_000}),
            json!({"initialblockdownload":false,"blocks":0,"headers":0}),
            json!({"initialblockdownload":"false","blocks":5,"headers":5}),
            json!({"blocks":5,"headers":5}),
            json!({"initialblockdownload":false,"blocks":5}),
            json!({"initialblockdownload":false,"blocks":"5","headers":"5"}),
            json!(null),
        ] {
            assert!(!chain_caught_up(&info), "{info} 를 다 따라잡았다고 봤다");
            assert_eq!(classify_name_answer("RV.M.FOREST", Ok(&info), Ok(&Value::Null)), NameLookup::Unknown, "{info}");
        }
        // 장부 상태를 못 읽었으면(오류·시간 초과) 「없음」을 믿지 않는다.
        assert_eq!(classify_name_answer("RV.M.FOREST", Err("timeout"), Ok(&Value::Null)), NameLookup::Unknown);
    }

    /// 시험 빌드의 RPC 는 늘 실패한다 — 그때 명령이 「없음(false)」이 아니라 오류(확인 불가)를 돌려줘야 한다.
    #[tokio::test]
    async fn 노드에_못_닿으면_명령은_오류를_돌려준다() {
        let r = super::name_taken("RV.M.FOREST".into()).await;
        assert_eq!(r, Err(super::NAME_UNKNOWN_SAY.to_string()));
        let shop = crate::shop::shop_name_free("GANGNAM".into()).await;
        assert!(shop.is_err(), "가게 이름 확인이 모름을 「비어 있음」으로 넘겼다");
        assert_eq!(super::lookup_name("").await, NameLookup::Unknown);
    }

    /// 발행 문·가게 문에 옛 우회(문구 포함 → 없음, unwrap_or(false))가 다시 생기지 않게.
    #[test]
    fn 옛_우회가_돌아오지_않는다() {
        for (file, src) in [("issue.rs", include_str!("issue.rs")), ("shop.rs", include_str!("shop.rs"))] {
            let code: String = src.lines().filter(|l| !l.trim_start().starts_with("//")).collect::<Vec<_>>().join("\n");
            let body = &code[..code.find("#[cfg(test)]").unwrap_or(code.len())];
            assert!(!body.contains("e.contains(\"Invalid\")"), "{file}: 오류 문구로 「없음」을 판단한다");
            assert!(!body.contains("e.contains(\"not found\")"), "{file}: 오류 문구로 「없음」을 판단한다");
            assert!(!body.contains("name_taken(name.clone()).await.unwrap_or(false)"), "{file}: 모름을 없음으로 넘긴다");
        }
    }
}
