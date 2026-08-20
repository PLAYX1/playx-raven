//! The rest of Ravencoin's asset system.
//!
//! `issue.rs` covers the three kinds most people need — root, sub, unique. This
//! file covers what a full node can do that a simplified wallet usually hides,
//! because hiding it is what makes people go back to Ravencoin Core:
//!
//! | what | name | burns |
//! |---|---|---|
//! | reissue more of an existing asset | — | ~100 RVN |
//! | many uniques in one transaction | `ROOT#a`, `ROOT#b`… | 5 each |
//! | qualifier (a permission tag) | `#KYC` | 1,000 RVN |
//! | restricted asset (only tagged addresses may hold it) | `$SHARES` | 1,500 RVN |
//! | tag an address with a qualifier | — | 0.1 RVN |
//! | freeze one address, or a whole restricted asset | — | fee only |
//!
//! ## Why the last three exist at all
//!
//! A restricted asset can only be held by an address carrying the right
//! qualifier tag. That is how a regulated share, a members-only token, or
//! anything with a legal holder requirement works on this chain — the rule is
//! enforced by consensus, not by an app being polite.
//!
//! It is also the sharpest tool here. `freezerestrictedasset` stops the whole
//! asset moving, for everyone, until the issuer unfreezes it. Every screen that
//! touches these says who can be affected before it does anything.

use crate::raven::call_rpc;
use serde_json::{json, Value};

pub const BURN_QUALIFIER: f64 = 1000.0;
pub const BURN_RESTRICTED: f64 = 1500.0;
pub const BURN_TAG: f64 = 0.1;
pub const BURN_REISSUE: f64 = 100.0;

/// What each kind costs and what its name has to look like.
///
/// Returned rather than hard-coded in the UI so one place stays authoritative:
/// a wrong burn figure shown before an irreversible action is worse than none.
/// Every kind of asset, with what it is actually for.
///
/// Ravencoin's asset system is powerful and almost undocumented for normal
/// people. "Qualifier — 1,000 RVN" tells a gym owner nothing; "this is how you
/// mark which addresses passed identity checks, and it does nothing on its own"
/// tells them whether to keep reading.
///
/// So each kind carries three things a price tag cannot: a real example from a
/// small business, the case where it is the wrong tool, and what it costs.
/// The last one matters most — nobody should discover the 1,500 RVN after
/// deciding.
#[tauri::command]
pub fn asset_kinds() -> Value {
    json!([
        {
            "id": "root", "name": "루트 자산", "burn": crate::issue::BURN_ROOT,
            "form": "PLAYX", "one_line": "새 이름 하나. 이 아래로 모든 것이 갈라집니다.",
            "when": [
                "가게·브랜드 이름을 체인에 잡을 때",
                "앞으로 하위·고유를 만들 계획이 있을 때"
            ],
            "examples": [
                { "case": "체육관", "name": "PLAYXGYM", "why": "회원권·수업권이 전부 이 아래로 들어갑니다" },
                { "case": "카페",   "name": "GANGNAMCAFE", "why": "쿠폰·굿즈를 하위로 붙입니다" },
                { "case": "음악",   "name": "PLAYX", "why": "앨범마다 하위 자산을 냅니다" }
            ],
            "not_for": "한 번 쓰고 말 것. 500 RVN은 이름값이지 물건값이 아닙니다."
        },
        {
            "id": "sub", "name": "하위 자산", "burn": crate::issue::BURN_SUB,
            "form": "PLAYX/MUSIC", "one_line": "내 루트 아래 갈래. 루트를 가진 사람만 만듭니다.",
            "when": ["상품군·지점·앨범처럼 묶어야 할 때", "이름을 계속 늘려갈 때"],
            "examples": [
                { "case": "체육관", "name": "PLAYXGYM/PT", "why": "개인수업권을 회원권과 따로 셉니다" },
                { "case": "카페",   "name": "GANGNAMCAFE/COFFEE10", "why": "커피 10잔 쿠폰" },
                { "case": "음악",   "name": "PLAYX/ALBUM1", "why": "앨범 한 장" }
            ],
            "not_for": "하나뿐인 물건. 그건 고유 자산이 5 RVN으로 훨씬 쌉니다."
        },
        {
            "id": "unique", "name": "고유 자산", "burn": crate::issue::BURN_UNIQUE,
            "form": "PLAYX#001", "one_line": "세상에 한 장뿐. 수량이 언제나 1입니다.",
            "when": ["사람마다·물건마다 다른 것", "번호를 붙여야 하는 것"],
            "examples": [
                { "case": "체육관", "name": "PLAYXGYM/M#A7K2", "why": "회원 한 명의 회원번호. 17원" },
                { "case": "공연",   "name": "PLAYX/SHOW#B12", "why": "좌석 하나짜리 티켓" },
                { "case": "작가",   "name": "ART/PIECE#0007", "why": "그림 한 점" }
            ],
            "not_for": "10회권처럼 수량이 필요한 것. 고유는 1로 고정입니다."
        },
        {
            "id": "reissue", "name": "더 찍기 (재발행)", "burn": BURN_REISSUE,
            "form": "이미 있는 자산", "one_line": "다 팔렸을 때 다음 배치를 만듭니다.",
            "when": ["재고가 떨어졌을 때", "발행할 때 '재발행 가능'을 켜 두었을 때"],
            "examples": [
                { "case": "음악", "name": "PLAYX/ALBUM1", "why": "50장 팔리면 50장 더" },
                { "case": "카페", "name": "CAFE/COUPON", "why": "쿠폰 소진 시 보충" }
            ],
            "not_for": "재발행 불가로 발행한 자산. 그건 영원히 더 못 찍습니다."
        },
        {
            "id": "bulk", "name": "고유 여러 개", "burn": crate::issue::BURN_UNIQUE,
            "form": "ROOT#a, ROOT#b …", "one_line": "고유 자산을 한 트랜잭션에 여러 개.",
            "when": ["회원번호·좌석·일련번호를 한꺼번에 만들 때"],
            "examples": [
                { "case": "체육관", "name": "회원번호 50개", "why": "하나씩 만들면 수수료가 50번 듭니다" },
                { "case": "공연",   "name": "좌석 A1~A30", "why": "한 번에" }
            ],
            "not_for": "60개 초과. 한 트랜잭션이 너무 커지면 통째로 거부됩니다."
        },
        {
            "id": "qualifier", "name": "자격 증명", "burn": BURN_QUALIFIER,
            "form": "#KYC", "one_line": "주소에 붙이는 도장. 이것만으로는 아무 일도 안 합니다.",
            "when": [
                "제한 자산을 만들 계획이 있을 때만",
                "'신원 확인된 사람'을 체인에 표시해야 할 때"
            ],
            "examples": [
                { "case": "규제 지분", "name": "#KYC", "why": "신분 확인을 마친 주소에만 붙입니다" },
                { "case": "지역 한정", "name": "#KR", "why": "국내 거주자만 살 수 있는 것을 만들 때" }
            ],
            "not_for": "회원 관리. 회원권은 고유 자산 5 RVN이면 되고, 자격 증명은 1,000 RVN입니다."
        },
        {
            "id": "restricted", "name": "제한 자산", "burn": BURN_RESTRICTED,
            "form": "$SHARES", "one_line": "자격 있는 주소만 가질 수 있습니다. 체인이 막습니다.",
            "when": [
                "법적으로 보유자를 가려야 할 때 (지분·증권형)",
                "아무나 되팔면 안 되는 것"
            ],
            "examples": [
                { "case": "회사 지분", "name": "$PLAYXSHARE", "why": "#KYC 있는 주소만 보유. 앱이 아니라 합의 규칙이 강제합니다" },
                { "case": "회원 전용", "name": "$MEMBERONLY", "why": "회원 자격이 없으면 받을 수조차 없습니다" }
            ],
            "not_for": "일반 상품·쿠폰. 1,500 RVN이고, 자격 증명(1,000)도 따로 있어야 하며, 손님이 자격을 못 받으면 아예 못 삽니다."
        }
    ])
}

/// Issues more of an asset that was marked reissuable.
///
/// The one operation a shop actually repeats: sold out, mint the next batch.
/// `new_ipfs` is optional — passing it rewrites what every existing holder's
/// token points at, which is powerful and easy to do by accident, so the UI
/// asks separately rather than bundling it into "reissue".
#[tauri::command]
pub async fn reissue(
    asset: String,
    qty: f64,
    to_address: Option<String>,
    keep_reissuable: bool,
    new_ipfs: Option<String>,
    passphrase: Option<String>,
) -> Result<String, String> {
    if qty <= 0.0 {
        return Err("수량은 0보다 커야 합니다.".into());
    }
    if asset.ends_with('!') {
        return Err("소유권 토큰은 재발행할 수 없습니다.".into());
    }

    // Ask the chain rather than trusting the screen: an asset issued as
    // non-reissuable can never be topped up, and finding that out from a failed
    // transaction costs the fee.
    let data = call_rpc("getassetdata", json!([asset])).await?;
    if data.get("reissuable").and_then(Value::as_i64) == Some(0) {
        return Err("이 자산은 재발행 불가로 발행되었습니다. 더 찍을 수 없습니다.".into());
    }

    let to = match to_address {
        Some(a) if !a.trim().is_empty() => a,
        _ => call_rpc("getnewaddress", json!([""]))
            .await?
            .as_str()
            .unwrap_or_default()
            .to_string(),
    };

    with_wallet(passphrase, || async {
        // reissue "asset_name" qty "to_address" "change_address"
        //         ( reissuable ) ( new_units ) "( new_ipfs )"
        let params = json!([
            asset,
            qty,
            to,
            "",
            keep_reissuable,
            -1, // units unchanged
            new_ipfs.clone().unwrap_or_default(),
        ]);
        let r = call_rpc("reissue", params).await?;
        Ok(first_txid(r))
    })
    .await
}

/// Issues many uniques at once — `ROOT#a`, `ROOT#b`, …
///
/// One transaction instead of N, which matters at 5 RVN each plus a fee each:
/// a hundred membership numbers issued singly is a hundred fees and a hundred
/// chances for one to fail halfway.
#[tauri::command]
pub async fn issue_many_unique(
    root: String,
    tags: Vec<String>,
    to_address: Option<String>,
    passphrase: Option<String>,
) -> Result<String, String> {
    if tags.is_empty() {
        return Err("만들 태그가 없습니다.".into());
    }
    if tags.len() > 60 {
        // The node accepts more, but one oversized transaction that gets
        // rejected wastes the whole batch. Splitting is the caller's job.
        return Err("한 번에 60개까지만 만들 수 있습니다. 나눠서 하세요.".into());
    }

    let to = to_address.unwrap_or_default();
    with_wallet(passphrase, || async {
        let r = call_rpc("issueunique", json!([root, tags, Value::Null, to, ""])).await?;
        Ok(first_txid(r))
    })
    .await
}

/// Creates a qualifier — a tag that can be put on addresses.
///
/// On its own it does nothing. It becomes meaningful when a restricted asset
/// names it as a requirement, and the UI should never present it as a
/// standalone product.
#[tauri::command]
pub async fn issue_qualifier(
    name: String,
    qty: f64,
    passphrase: Option<String>,
) -> Result<String, String> {
    let n = if name.starts_with('#') {
        name
    } else {
        format!("#{name}")
    };
    with_wallet(passphrase, || async {
        let r = call_rpc("issuequalifierasset", json!([n, qty, "", "", false, ""])).await?;
        Ok(first_txid(r))
    })
    .await
}

/// Puts a qualifier tag on an address, so it can hold the matching restricted
/// asset.
#[tauri::command]
pub async fn tag_address(
    tag: String,
    address: String,
    passphrase: Option<String>,
) -> Result<String, String> {
    let t = if tag.starts_with('#') { tag } else { format!("#{tag}") };
    let check = crate::send::check_address(address.clone()).await?;
    if !check["valid"].as_bool().unwrap_or(false) {
        return Err("주소가 올바르지 않습니다.".into());
    }
    with_wallet(passphrase, || async {
        let r = call_rpc("addtagtoaddress", json!([t, address, "", ""])).await?;
        Ok(first_txid(r))
    })
    .await
}

/// Creates a restricted asset. Only addresses satisfying `verifier` may hold it.
///
/// `verifier` is a small expression over qualifiers — `#KYC`, or
/// `#KYC&#KR`. Getting it wrong locks out everyone it was meant for, and it
/// can only be changed by reissuing, so the UI shows exactly which addresses
/// currently satisfy it before anything burns.
#[tauri::command]
pub async fn issue_restricted(
    name: String,
    qty: f64,
    verifier: String,
    to_address: String,
    units: u8,
    reissuable: bool,
    ipfs_hash: Option<String>,
    passphrase: Option<String>,
) -> Result<String, String> {
    let n = if name.starts_with('$') { name } else { format!("${name}") };
    if verifier.trim().is_empty() {
        return Err("자격 조건이 비어 있습니다. 아무도 가질 수 없는 자산이 됩니다.".into());
    }
    let check = crate::send::check_address(to_address.clone()).await?;
    if !check["valid"].as_bool().unwrap_or(false) {
        return Err("받는 주소가 올바르지 않습니다.".into());
    }

    with_wallet(passphrase, || async {
        let has_ipfs = ipfs_hash.as_ref().map(|s| !s.is_empty()).unwrap_or(false);
        let r = call_rpc(
            "issuerestrictedasset",
            json!([
                n,
                qty,
                verifier,
                to_address,
                "",
                units,
                reissuable,
                has_ipfs,
                ipfs_hash.clone().unwrap_or_default(),
            ]),
        )
        .await?;
        Ok(first_txid(r))
    })
    .await
}

/// Which addresses carry a tag.
#[tauri::command]
pub async fn addresses_with_tag(tag: String) -> Result<Value, String> {
    let t = if tag.starts_with('#') { tag } else { format!("#{tag}") };
    call_rpc("listaddressesfortag", json!([t])).await
}

/// What restrictions apply to one address.
#[tauri::command]
pub async fn address_restrictions(address: String) -> Result<Value, String> {
    call_rpc("listaddressrestrictions", json!([address])).await
}

/// Freezes one address for a restricted asset, or the whole asset.
///
/// This stops other people's tokens moving. It exists because regulated assets
/// require it, and it is the most drastic thing in this app — so it takes an
/// explicit `whole_asset` flag rather than inferring intent from an empty
/// address field.
#[tauri::command]
pub async fn freeze(
    asset: String,
    address: Option<String>,
    whole_asset: bool,
    passphrase: Option<String>,
) -> Result<String, String> {
    if !asset.starts_with('$') {
        return Err("제한 자산($로 시작하는 것)만 동결할 수 있습니다.".into());
    }
    with_wallet(passphrase, || async {
        let r = if whole_asset {
            call_rpc("freezerestrictedasset", json!([asset, "", ""])).await?
        } else {
            let a = address
                .clone()
                .ok_or_else(|| "동결할 주소가 필요합니다.".to_string())?;
            call_rpc("freezeaddress", json!([asset, a, "", ""])).await?
        };
        Ok(first_txid(r))
    })
    .await
}

fn first_txid(v: Value) -> String {
    let txid = v
        .as_array()
        .and_then(|a| a.first())
        .and_then(Value::as_str)
        .or_else(|| v.as_str())
        .unwrap_or("")
        .to_string();
    crate::refund::remember_ours(&txid);
    txid
}

/// Unlocks for one operation, then locks again.
async fn with_wallet<F, Fut>(passphrase: Option<String>, body: F) -> Result<String, String>
where
    F: FnOnce() -> Fut,
    Fut: std::future::Future<Output = Result<String, String>>,
{
    let locked = matches!(
        call_rpc("getwalletinfo", json!([]))
            .await
            .ok()
            .and_then(|i| i.get("unlocked_until").and_then(Value::as_i64)),
        Some(0)
    );
    if locked {
        let pass = passphrase.ok_or_else(|| "지갑이 잠겨 있습니다. 암호가 필요합니다.".to_string())?;
        call_rpc("walletpassphrase", json!([pass, 30])).await?;
    }
    let out = body().await;
    if locked {
        let _ = call_rpc("walletlock", json!([])).await;
    }
    out
}

/// Undoes a freeze.
///
/// ## Why this had to exist
///
/// This app could freeze and could not unfreeze. Every screen warned how
/// drastic freezing is, and then offered no way back — a shop that froze the
/// wrong address had to find `raven-cli` and read the RPC docs, at the counter,
/// with a member standing there.
///
/// A one-way control is not a safety feature. It is a bug that looks like one.
#[tauri::command]
pub async fn unfreeze(
    asset: String,
    address: Option<String>,
    whole_asset: bool,
    passphrase: Option<String>,
) -> Result<String, String> {
    if !asset.starts_with('$') {
        return Err("제한 자산($로 시작하는 것)만 해당됩니다.".into());
    }
    with_wallet(passphrase, || async {
        let r = if whole_asset {
            call_rpc("unfreezerestrictedasset", json!([asset, "", ""])).await?
        } else {
            let a = address
                .clone()
                .ok_or_else(|| "해제할 주소가 필요합니다.".to_string())?;
            call_rpc("unfreezeaddress", json!([asset, a, "", ""])).await?
        };
        Ok(first_txid(r))
    })
    .await
}

/// Takes a tag back off an address.
///
/// The counterpart to `tag_address`. Verification that cannot be withdrawn is
/// not verification — a shop that closes, changes hands, or turns out to be a
/// fraud has to be un-badged, and doing that with a burned qualifier is not
/// possible any other way.
#[tauri::command]
pub async fn untag_address(
    tag: String,
    address: String,
    passphrase: Option<String>,
) -> Result<String, String> {
    let t = if tag.starts_with('#') { tag } else { format!("#{tag}") };
    with_wallet(passphrase, || async {
        let r = call_rpc("removetagfromaddress", json!([t, address, "", ""])).await?;
        Ok(first_txid(r))
    })
    .await
}

/// Which tags one address carries.
///
/// The mirror of `addresses_with_tag`, and the one a customer's screen needs:
/// "is this shop verified?" is a question about an address, not about a tag.
/// Works on an ordinary node — this reads the restricted-asset database every
/// node builds, not the optional `-assetindex`.
#[tauri::command]
pub async fn tags_for_address(address: String) -> Result<Value, String> {
    call_rpc("listtagsforaddress", json!([address])).await
}

/// Can this address legally receive this restricted asset — asked *before*
/// sending.
///
/// A restricted transfer to an address that does not satisfy the verifier is
/// rejected by the chain, but only after the shop has typed everything in and
/// pressed send. Asking first turns a failed transaction into a sentence.
#[tauri::command]
pub async fn can_receive(address: String, asset: String) -> Result<Value, String> {
    let n = if asset.starts_with('$') { asset } else { format!("${asset}") };

    let allowed = call_rpc("checkaddressrestriction", json!([address, n.clone()]))
        .await
        .ok()
        .and_then(|v| v.as_bool())
        // checkaddressrestriction 은 "제한되어 있는가"를 답한다. 뒤집어야 한다.
        .map(|restricted| !restricted);

    let tags = call_rpc("listtagsforaddress", json!([address]))
        .await
        .unwrap_or(json!([]));

    Ok(json!({
        "address": address,
        "asset": n,
        "can_receive": allowed,
        "tags": tags,
        "why": match allowed {
            Some(true) => "이 주소는 받을 수 있습니다.",
            Some(false) => "이 주소는 이 자산을 받을 수 없습니다 — 자격이 없거나 동결돼 있습니다.",
            None => "확인하지 못했습니다. 보내 보면 체인이 거절할 수 있습니다.",
        },
    }))
}
