//! 「만들기」 — 증명서·티켓·작품.
//!
//! 사람은 무엇을 몇 장 만들지만 고른다. 체인 이름과 비용은 화면
//! (`src/easy-create.ts`)이 정하고, 여기서는 **그 모양이 약속한 세 가지 중
//! 하나인지 다시 본 뒤** 이 컴퓨터의 노드 지갑으로 발행한다.
//!
//! | 단계 | 노드 명령 | 모양 |
//! |---|---|---|
//! | brand | `issue` | `BRAND` · 1개 · 소수 0 · 재발행 가능 |
//! | ticket | `issue` | `BRAND/SLUG` · N장 · 소수 0 · 재발행 가능(추가 판매) |
//! | uniques | `issueunique` | `BRAND#TAG` × N (한 거래), 파일 지문은 장마다 같은 것 |
//!
//! 🔴 화면이 무엇을 보내든 이 셋 밖의 발행은 여기서 나가지 않는다. 자유 발행은
//!    「새 자산 만들기」(issue.rs)가 맡는다.

use crate::raven::call_rpc;
use serde_json::{json, Value};

pub const MAX_COPIES: usize = 50;
pub const MAX_TICKETS: u64 = 1_000_000;

fn is_brand(s: &str) -> bool {
    (3..=12).contains(&s.len())
        && s.bytes().all(|b| b.is_ascii_uppercase() || b.is_ascii_digit())
        && !matches!(s, "RVN" | "RAVEN" | "RAVENCOIN")
}

fn is_slug(s: &str) -> bool {
    // 하위 이름: 영문 대문자·숫자만 (화면이 만드는 모양 그대로).
    !s.is_empty() && s.len() <= 17 && s.bytes().all(|b| b.is_ascii_uppercase() || b.is_ascii_digit())
}

fn is_tag(s: &str) -> bool {
    // 화면이 만드는 고유 태그: SLUG + YYMMDD + 차례 글자 + "-" + 번호.
    !s.is_empty()
        && s.len() <= 18
        && s.bytes().all(|b| b.is_ascii_uppercase() || b.is_ascii_digit() || b == b'-')
        && !s.starts_with('-')
        && !s.ends_with('-')
}

fn is_cid(s: &str) -> bool {
    const B58: &str = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
    s.len() == 46 && s.starts_with("Qm") && s.chars().all(|c| B58.contains(c))
}

/// 약속한 모양인지 보고, 부를 노드 명령과 인자를 돌려준다. 노드는 부르지 않는다.
pub fn plan_call(
    step: &str,
    brand: &str,
    names: &[String],
    quantity: u64,
    ipfs_hash: Option<&str>,
) -> Result<(&'static str, Value), String> {
    if !is_brand(brand) {
        return Err("브랜드 이름을 확인해 주세요.".into());
    }
    if let Some(cid) = ipfs_hash {
        if !is_cid(cid) {
            return Err("파일 지문 모양이 올바르지 않습니다.".into());
        }
    }
    match step {
        "brand" => {
            if !names.is_empty() || ipfs_hash.is_some() {
                return Err("이름 등록에는 다른 것을 붙이지 않습니다.".into());
            }
            Ok(("issue", json!([brand, 1, "", "", 0, true, false, ""])))
        }
        "ticket" => {
            let [name] = names else { return Err("티켓 이름은 하나여야 합니다.".into()) };
            let slug = name
                .strip_prefix(brand)
                .and_then(|rest| rest.strip_prefix('/'))
                .ok_or("티켓 이름이 브랜드 아래에 있지 않습니다.")?;
            if !is_slug(slug) || name.len() > 30 {
                return Err("티켓 이름 모양을 확인해 주세요.".into());
            }
            if !(1..=MAX_TICKETS).contains(&quantity) {
                return Err(format!("티켓은 1~{MAX_TICKETS}장까지 만들 수 있습니다."));
            }
            Ok((
                "issue",
                json!([name, quantity, "", "", 0, true, ipfs_hash.is_some(), ipfs_hash.unwrap_or("")]),
            ))
        }
        "uniques" => {
            if names.is_empty() || names.len() > MAX_COPIES {
                return Err(format!("한 번에 1~{MAX_COPIES}장까지 만들 수 있습니다."));
            }
            let mut tags: Vec<String> = Vec::with_capacity(names.len());
            for name in names {
                let tag = name
                    .strip_prefix(brand)
                    .and_then(|rest| rest.strip_prefix('#'))
                    .ok_or("작품 이름이 브랜드 아래에 있지 않습니다.")?;
                if !is_tag(tag) || name.len() > 31 {
                    return Err("작품 이름 모양을 확인해 주세요.".into());
                }
                if tags.iter().any(|t| t == tag) {
                    return Err("같은 이름이 두 번 들어 있습니다.".into());
                }
                tags.push(tag.to_string());
            }
            let hashes = match ipfs_hash {
                Some(cid) => json!(vec![cid; tags.len()]),
                None => Value::Null,
            };
            Ok(("issueunique", json!([brand, tags, hashes, "", ""])))
        }
        _ => Err("알 수 없는 만들기 단계입니다.".into()),
    }
}

/// 이 지갑이 쥔 브랜드(루트 관리권, 기록 끝난 것만)와 쓸 수 있는 RVN, 잠김 여부.
#[tauri::command]
pub async fn create_status() -> Result<Value, String> {
    let confirmed = root_owner_tokens(&call_rpc("listmyassets", json!(["*", false, 100000, 0, 1])).await?);
    // 🔴 발행할 때마다 BRAND! 가 쓰였다가 다시 나온다 — 한 블록 동안은 「기록 전」이다.
    //    그 사이에 「새 브랜드」로 보면 BRAND2 를 500 RVN 에 또 만든다. 따로 알려 준다.
    let all = root_owner_tokens(&call_rpc("listmyassets", json!(["*", false, 100000, 0, 0])).await?);
    let pending: Vec<String> = all.iter().filter(|b| !confirmed.contains(b)).cloned().collect();
    let spendable = call_rpc("getbalance", json!([])).await?.as_f64().unwrap_or(0.0);
    let locked = matches!(
        call_rpc("getwalletinfo", json!([]))
            .await
            .ok()
            .and_then(|i| i.get("unlocked_until").and_then(Value::as_i64)),
        Some(0)
    );
    Ok(json!({ "brands": confirmed, "pending": pending, "spendable": spendable, "locked": locked }))
}

fn root_owner_tokens(owned: &Value) -> Vec<String> {
    let mut out: Vec<String> = owned
        .as_object()
        .map(|m| {
            m.iter()
                .filter(|(_, v)| v.as_f64().unwrap_or(0.0) >= 1.0)
                .filter_map(|(k, _)| k.strip_suffix('!'))
                .filter(|k| !k.contains('/') && !k.contains('#'))
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default();
    out.sort();
    out
}

/// 등록 거래가 어떻게 됐나 — 확인 수. 음수면 다른 거래에 밀려 무효가 된 것이다.
#[tauri::command]
pub async fn create_tx_state(txid: String) -> Result<i64, String> {
    if txid.len() != 64 || !txid.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err("거래 번호를 확인해 주세요.".into());
    }
    let tx = call_rpc("gettransaction", json!([txid])).await?;
    Ok(tx.get("confirmations").and_then(Value::as_i64).unwrap_or(0))
}

/// 이 이름을 이미 누가 쓰나 — 체인에 있거나(`getassetdata`), **내 지갑에 기록 전
/// (확인 0)으로 들어와 있거나.**
///
/// 🔴 `getassetdata` 는 블록에 들어간 것만 안다. 방금 보낸 묶음은 한 블록 동안
///    「없는 이름」으로 보여서, 다시 확인하면 같은 이름(run 0)을 또 내거나 그
///    묶음을 다시 만들 뻔했다. 지갑은 방금 보낸 것도 확인 0 으로 바로 보인다.
pub async fn name_used(name: &str) -> Result<bool, String> {
    let mine = call_rpc("listmyassets", json!([name, false, 1, 0, 0])).await?;
    if mine.as_object().map(|m| m.contains_key(name)).unwrap_or(false) {
        return Ok(true);
    }
    crate::issue::name_taken(name.to_string()).await
}

/// 이름마다 이미 쓰이는지(체인, 또는 내 지갑의 기록 전). 모르면 오류 — 「없음」으로 넘기지 않는다.
#[tauri::command]
pub async fn create_names_taken(names: Vec<String>) -> Result<Vec<bool>, String> {
    if names.len() > 60 {
        return Err("한 번에 60개까지 확인할 수 있습니다.".into());
    }
    let mut out = Vec::with_capacity(names.len());
    for name in names {
        out.push(name_used(&name).await?);
    }
    Ok(out)
}

/// 한 단계를 발행한다. RVN 이 태워지고 되돌릴 수 없다.
///
/// `history_id` 가 있으면 끝난 뒤 그 기록에 체인 이름·거래 번호를 적는다
/// (`create_history.rs`).
///
/// 🔴 **보냈는지 모름**(부름이 시간 초과, `SENT_UNKNOWN: `)이면 실패로 치지 않는다.
///    기록을 `sent-unknown` 으로 적고, 풀릴 때까지 새 만들기를 막는다 — 예전에는
///    화면이 「실패」라고 하고 단추를 다시 열어, 같은 묶음을 두 번 태웠다.
///
/// 원본 지문은 노드가 받았거나(거래 번호) 받았을지 모를 때만 지문 목록에 적는다.
#[tauri::command]
pub async fn create_issue(
    step: String,
    brand: String,
    names: Vec<String>,
    quantity: u64,
    ipfs_hash: Option<String>,
    passphrase: Option<String>,
    history_id: Option<String>,
) -> Result<String, String> {
    let (method, params) = plan_call(&step, &brand, &names, quantity, ipfs_hash.as_deref())?;
    // 🔴 한 번에 하나만(두 번째 방어선). 화면이 막아도 두 번 부름이 겹치면 이름이
    //    다른 두 묶음이 둘 다 나갔다(검수 R5).
    let _flight = Flight::take()?;
    // 보냈는지 모르는 것이 있으면(보내다 만 것 포함) 아무것도 새로 보내지 않는다.
    crate::create_history::unknown_pending_error()?;
    let first = if step == "brand" { brand.clone() } else { names[0].clone() };
    if name_used(&first).await? {
        // 🔴 「새 이름을 받아 주세요」라고 하지 않는다 — 방금 보낸 것이 기록된 것일 수
        //    있고, 그러면 새 이름으로 같은 것을 또 만든다.
        return Err(ALREADY_THERE.into());
    }
    let sent: Vec<String> = if step == "brand" { vec![] } else { names.clone() };
    // 🔴 부르기 **직전**에 「보내는 중」을 적는다. 최대 3분 기다리는 동안 앱이 꺼져도
    //    다시 켜면 이 줄이 「보냈을 수 있다」를 기억한다. 못 적으면 보내지 않는다.
    if let Some(id) = history_id.as_deref() {
        crate::create_history::mark_sending(id, &step, &sent)?;
    }
    let remember = |cid: Option<&str>| {
        if let Some(cid) = cid {
            if let Err(e) = crate::create_history::remember_fingerprint(cid) {
                eprintln!("create: 원본 지문을 기록하지 못함 — {e}");
            }
        }
    };
    let txid = match issue_now(method, params, passphrase).await {
        Ok(txid) => txid,
        Err(e) if e.starts_with(crate::raven::SENT_UNKNOWN) => {
            remember(ipfs_hash.as_deref());
            if let Some(id) = history_id.as_deref() {
                // 못 적어도 줄은 `sending` 으로 남아 있다 — 그것도 「보냈는지 모름」으로 본다.
                if let Err(err) = crate::create_history::mark_unknown(id, &step, &sent) {
                    eprintln!("create: 보냈는지 모름을 기록하지 못함 — {err}");
                }
            }
            return Err(e);
        }
        Err(e) => {
            // 노드가 분명히 거절했다(또는 지갑을 못 열었다) — 아무것도 안 나갔다.
            if let Some(id) = history_id.as_deref() {
                if let Err(err) = crate::create_history::mark_not_sent(id) {
                    eprintln!("create: 보내기 전 상태로 되돌리지 못함 — {err}");
                }
            }
            return Err(e);
        }
    };
    remember(ipfs_hash.as_deref());
    if let Some(id) = history_id.as_deref() {
        // 발행은 이미 나갔다. 기록을 못 남겨도 거래 번호는 돌려준다(화면이 다시 적는다).
        let _ = if step == "brand" {
            crate::create_history::mark_brand_sent(id, &txid)
        } else {
            crate::create_history::mark_done(id, &names, &txid)
        };
    }
    Ok(txid)
}

/// 만들기 발행이 도는 중인가. `sending` 기록이 「보내는 중」인지 「보내다 꺼진 것」인지 가른다.
static ISSUING: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

pub fn issuing_now() -> bool {
    ISSUING.load(std::sync::atomic::Ordering::SeqCst)
}

pub const BUSY: &str = "ISSUE_BUSY: 다른 만들기를 보내는 중이에요. 끝난 뒤에 다시 해 주세요.";

/// 발행 한 번의 자리. 끝나면(오류·패닉 포함) 저절로 비운다.
struct Flight;

impl Flight {
    fn take() -> Result<Flight, String> {
        use std::sync::atomic::Ordering::SeqCst;
        ISSUING.compare_exchange(false, true, SeqCst, SeqCst).map(|_| Flight).map_err(|_| BUSY.to_string())
    }
}

impl Drop for Flight {
    fn drop(&mut self) {
        ISSUING.store(false, std::sync::atomic::Ordering::SeqCst);
    }
}

/// 🔴 화면이 이 글자를 알아본다(`create-page.ts`) — 바꾸면 거기도.
pub const ALREADY_THERE: &str = "ALREADY_THERE: 이 이름은 이미 체인이나 지갑에 있어요. 방금 보낸 것이 기록된 것일 수 있으니 다시 만들지 말고 「만든 것」과 자산 화면을 먼저 확인해 주세요.";

async fn issue_now(method: &'static str, params: Value, passphrase: Option<String>) -> Result<String, String> {
    crate::issue2::with_wallet(passphrase, || async {
        let r = call_rpc(method, params).await?;
        let txid = match &r {
            Value::String(s) => s.clone(),
            Value::Array(a) => a.first().and_then(Value::as_str).unwrap_or("").to_string(),
            _ => String::new(),
        };
        if txid.is_empty() {
            // 🔴 노드는 부름을 받았다 — 거래 번호만 없다. 「실패」로 보고 다시 열면 두 번 태울
            //    수 있으니 「보냈는지 모름」으로 돌려준다.
            return Err(format!("{}노드가 거래 번호를 돌려주지 않았어요. 보냈는지 아직 몰라요 — 기록될 때까지 기다려 주세요. 같은 것을 다시 보내지 마세요.", crate::raven::SENT_UNKNOWN));
        }
        crate::refund::remember_ours(&txid);
        Ok(txid)
    })
    .await
}

/// 창에 떨어뜨린 문서의 지문(파일 SHA-256 을 CIDv0 모양으로). **파일은 어디에도
/// 올리지 않는다** — 이 컴퓨터에서 읽고 해시만 돌려준다.
///
/// 🔴 떨어뜨린 경로만 읽는다(`dropbox.rs`). 화면이 아무 경로나 부를 수 있으면
///    화면이 뚫리는 날 `wallet.dat` 의 존재·크기를 캐묻는 길이 된다.
///
/// 🔴 512MB 를 읽는 데 몇 초가 걸린다. 화면 스레드에서 읽으면 그동안 창이 얼었다 —
///    읽기는 따로 돌린다(`spawn_blocking`).
#[tauri::command]
pub async fn create_dropped_fingerprint(path: String) -> Result<Value, String> {
    if !crate::dropbox::was_dropped(&path) {
        return Err("이 파일은 창에 떨어뜨린 것이 아닙니다.".into());
    }
    tauri::async_runtime::spawn_blocking(move || fingerprint_file(std::path::Path::new(&path)))
        .await
        .map_err(|_| "파일을 읽지 못했어요.".to_string())?
}

pub const MAX_FINGERPRINT_BYTES: u64 = 512 * 1024 * 1024;

fn fingerprint_file(p: &std::path::Path) -> Result<Value, String> {
    use sha2::{Digest, Sha256};
    use std::io::Read;
    let meta = std::fs::metadata(p).map_err(|_| "파일을 읽지 못했어요.".to_string())?;
    if !meta.is_file() {
        return Err("폴더가 아니라 파일 하나를 놓아 주세요.".into());
    }
    if meta.len() > MAX_FINGERPRINT_BYTES {
        return Err("512MB 이하 파일만 붙일 수 있어요.".into());
    }
    let mut file = std::fs::File::open(p).map_err(|_| "파일을 읽지 못했어요.".to_string())?;
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 1 << 16];
    loop {
        let n = file.read(&mut buf).map_err(|_| "파일을 읽지 못했어요.".to_string())?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    let digest = hasher.finalize();
    let mut bytes = vec![0x12u8, 0x20];
    bytes.extend_from_slice(&digest);
    let name = p.file_name().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
    Ok(json!({ "fingerprint": base58(&bytes), "name": name, "size": meta.len() }))
}

fn base58(bytes: &[u8]) -> String {
    const B58: &[u8] = b"123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
    let mut digits: Vec<u8> = Vec::new();
    for &b in bytes {
        let mut carry = b as u32;
        for d in digits.iter_mut() {
            carry += (*d as u32) << 8;
            *d = (carry % 58) as u8;
            carry /= 58;
        }
        while carry > 0 {
            digits.push((carry % 58) as u8);
            carry /= 58;
        }
    }
    let zeros = bytes.iter().take_while(|&&b| b == 0).count();
    let mut out = String::with_capacity(zeros + digits.len());
    out.extend(std::iter::repeat('1').take(zeros));
    out.extend(digits.iter().rev().map(|&d| B58[d as usize] as char));
    out
}

#[cfg(test)]
mod tests {
    use super::plan_call;
    use serde_json::json;

    const CID: &str = "QmcwUFCZ8saJgoE6D9LEgVqtteCbVcdzWFcGzuhe7VTeW7";
    fn v(names: &[&str]) -> Vec<String> {
        names.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn 브랜드는_하나_소수0_재발행가능() {
        let (m, p) = plan_call("brand", "HANBIT", &[], 0, None).unwrap();
        assert_eq!(m, "issue");
        assert_eq!(p, json!(["HANBIT", 1, "", "", 0, true, false, ""]));
        assert!(plan_call("brand", "RAVEN", &[], 0, None).is_err());
        assert!(plan_call("brand", "hanbit", &[], 0, None).is_err());
        assert!(plan_call("brand", "AB", &[], 0, None).is_err());
        assert!(plan_call("brand", "HANBIT", &v(&["X"]), 0, None).is_err());
    }

    #[test]
    fn 티켓은_브랜드_아래_하위자산() {
        let (m, p) = plan_call("ticket", "HANBIT", &v(&["HANBIT/GONGYEON260917"]), 300, Some(CID)).unwrap();
        assert_eq!(m, "issue");
        assert_eq!(p, json!(["HANBIT/GONGYEON260917", 300, "", "", 0, true, true, CID]));
        assert!(plan_call("ticket", "HANBIT", &v(&["OTHER/GONGYEON"]), 1, None).is_err());
        assert!(plan_call("ticket", "HANBIT", &v(&["HANBIT/x"]), 1, None).is_err());
        assert!(plan_call("ticket", "HANBIT", &v(&["HANBIT/A"]), 0, None).is_err());
        assert!(plan_call("ticket", "HANBIT", &v(&["HANBIT/A"]), 1_000_001, None).is_err());
        assert!(plan_call("ticket", "HANBIT", &v(&["HANBIT/A", "HANBIT/B"]), 1, None).is_err());
    }

    #[test]
    fn 여러_장은_한_거래_지문은_장마다() {
        let names = v(&["HANBIT#BADAGEU260917-1", "HANBIT#BADAGEU260917-2"]);
        let (m, p) = plan_call("uniques", "HANBIT", &names, 0, Some(CID)).unwrap();
        assert_eq!(m, "issueunique");
        assert_eq!(p, json!(["HANBIT", ["BADAGEU260917-1", "BADAGEU260917-2"], [CID, CID], "", ""]));
        let (_, p) = plan_call("uniques", "HANBIT", &names[..1], 0, None).unwrap();
        assert_eq!(p[2], json!(null));
        assert!(plan_call("uniques", "HANBIT", &v(&["HANBIT#A-1", "HANBIT#A-1"]), 0, None).is_err());
        assert!(plan_call("uniques", "HANBIT", &v(&["HANBIT/A"]), 0, None).is_err());
        assert!(plan_call("uniques", "HANBIT", &v(&["HANBIT#a b"]), 0, None).is_err());
        let many: Vec<String> = (1..=51).map(|i| format!("HANBIT#A-{i}")).collect();
        assert!(plan_call("uniques", "HANBIT", &many, 0, None).is_err());
        assert!(plan_call("uniques", "HANBIT", &v(&["HANBIT#A-1"]), 0, Some("QmBad")).is_err());
        assert!(plan_call("mint", "HANBIT", &v(&["HANBIT#A-1"]), 0, None).is_err());
    }

    /// 화면(easy-create.ts)·폰·확인 페이지와 **같은 지문**이 나와야 한다.
    #[test]
    fn 떨어뜨린_문서의_지문은_화면과_같고_떨어뜨린_것만_읽는다() {
        let dir = std::env::temp_dir().join(format!("rv-fp-{}-{:x}", std::process::id(), rand::random::<u32>()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("수료 명단.pdf");
        std::fs::write(&file, b"synthetic artwork bytes for RavenVault create test\n").unwrap();
        let path = file.to_string_lossy().to_string();
        let run = |p: String| tauri::async_runtime::block_on(super::create_dropped_fingerprint(p));
        assert!(run(path.clone()).is_err(), "떨어뜨리지 않은 경로는 안 읽는다");
        crate::dropbox::remember(&[path.clone()]);
        let fp = run(path).unwrap();
        assert_eq!(fp["fingerprint"], CID);
        assert_eq!(fp["name"], "수료 명단.pdf");
        assert!(super::fingerprint_file(&dir).is_err(), "폴더는 받지 않는다");
        assert_eq!(super::base58(&[0, 0, 1]), "112");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 검수 R5 — 두 발행이 겹치면 두 번째는 보내지 않는다. 끝나면(오류여도) 자리가 빈다.
    #[test]
    fn 만들기_발행은_한_번에_하나만() {
        // 기록 시험들이 「지금 보내는 중인가」를 본다 — 같은 자물쇠로 줄 세운다.
        let _env = crate::paths::TEST_ENV.lock().unwrap_or_else(|e| e.into_inner());
        let first = super::Flight::take().unwrap();
        assert!(super::issuing_now());
        assert_eq!(super::Flight::take().err().as_deref(), Some(super::BUSY));
        drop(first);
        assert!(!super::issuing_now());
        let again = super::Flight::take();
        assert!(again.is_ok(), "끝난 뒤에는 다시 보낼 수 있다");
    }
}
