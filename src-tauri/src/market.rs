//! 열린 장터(구매자 쪽)의 노드·IPFS·서명된 목록 길 — 0.9.2.
//!
//! 화면(`src/open-market.ts`)이 쓰는 명령 다섯 개:
//!
//! | 명령 | 하는 일 | 돈이 움직이나 |
//! |---|---|---|
//! | `market_list_assets` | 노드 `listassets "RV.*"` 로 자산 이름·매니페스트 CID 목록 | 아니오(읽기) |
//! | `market_chain_tip` | 체인 이름·높이·따라잡았는지 (수수료 요율은 체인 높이로 정해진다) | 아니오 |
//! | `market_http_get` | 서명된 목록 묶음 한 곳(고정 주소)만 받아 온다 — 웹뷰 CSP 때문에 러스트가 대신 | 아니오 |
//! | `market_purchase_prepare` | 구매 거래를 **만들기만** 한다(서명·전파 없음) + 노드가 채운 거래를 다시 검사해 화면에 보여 줄 출력 | 아니오 |
//! | `market_purchase_send` | 방금 **그 거래만** 서명·전파. 화면에서 사람이 「이 금액으로 사기」를 눌러야 불린다 | **예** |
//!
//! 매니페스트·파일 읽기는 이미 있는 `creator_cid_read`(이 컴퓨터 IPFS)를 쓴다.
//!
//! ## 🔴 돈 규칙
//! - 판매 스위치(`core/creator/mainnet-switch.json` 의 `sales`)가 꺼져 있으면 **메인넷**에서는 준비도 전송도 거절한다.
//!   시험망·연습 모드(test·regtest)는 허용. 체인을 모르면 메인넷으로 간주해 거절(발행 문과 같은 규칙).
//! - 준비한 거래(hex)는 **러스트가 들고 있고** 화면은 받지 않는다. 보내기는 준비 번호만 받는다 → 화면이 다른 거래를 끼워 넣을 수 없다.
//! - 준비 때 노드가 채운 거래를 `decoderawtransaction` 으로 다시 읽어 **받는 곳 정확히 일치**(판매자 1·수수료 0~1·메모 1) +
//!   나머지는 이 지갑 소유 거스름 한 개뿐인지 검사한다. 어긋나면 거절하고 아무것도 보관하지 않는다.
//! - 준비는 5분 안에 한 번만 보낼 수 있다(보낸 뒤·시간이 지난 뒤엔 사라진다).
//! - 구매는 자산을 옮기지 않는다 — 출력은 RVN 뿐이다(자산 출력이 끼면 거절).

use crate::issue::OPEN_MARKET_SALES_ENABLED;
use crate::raven::call_rpc;
use serde_json::{json, Value};
use std::sync::Mutex;
use std::time::{Duration, Instant};

const MAINNET_SALES_OFF_SAY: &str = "판매(장터 구매 결제)는 메인넷에서 지금 꺼져 있어요(안전 잠금). 돈은 나가지 않았어요.";
const CHAIN_UNKNOWN_SAY: &str = "지금 연결된 네트워크(메인넷/테스트넷)를 확인하지 못해서 거래를 만들지 않았어요. 노드가 켜져 있는지 확인해 주세요. 돈은 나가지 않았어요.";
const PENDING_TTL: Duration = Duration::from_secs(300);
/// 이보다 큰 네트워크 수수료는 거절한다(실수·이상한 입력 방어). 1 RVN.
const MAX_NETWORK_FEE_ATOMS: u64 = 100_000_000;
const MAX_LIST_PAGES: i64 = 5;
const LIST_PAGE: i64 = 200;
/// 서명된 목록 묶음을 받는 유일한 곳(지갑 core 의 SIGNED_LISTS_URL 과 같다).
pub const SIGNED_LISTS_URL: &str = "https://ravenvault.ex.erci.se/lists/signed-lists.json";
const SIGNED_LISTS_MAX_BYTES: usize = 8 * 1024 * 1024;

/// 체인 이름 → 판매 거래를 만들어도 되나. 순수 함수 — 시험. 모르는 값은 메인넷으로 간주(거절).
pub fn sales_allowed_on(chain: Option<&str>, enabled: bool) -> Result<(), String> {
    match chain {
        Some("test") | Some("regtest") => Ok(()),
        Some("main") if enabled => Ok(()),
        Some("main") => Err(MAINNET_SALES_OFF_SAY.into()),
        _ if enabled => Ok(()),
        _ => Err(CHAIN_UNKNOWN_SAY.into()),
    }
}

async fn ensure_sales_allowed() -> Result<String, String> {
    #[cfg(test)]
    {
        return Err(CHAIN_UNKNOWN_SAY.into());
    }
    #[cfg(not(test))]
    {
        let chain = call_rpc("getblockchaininfo", json!([])).await.ok().and_then(|v| v["chain"].as_str().map(str::to_string));
        sales_allowed_on(chain.as_deref(), OPEN_MARKET_SALES_ENABLED)?;
        Ok(chain.unwrap_or_default())
    }
}

/* ── 목록 ─────────────────────────────────────────────────────────── */

/// 검색어: `RV.*` · `RV.M.*` 처럼 `RV.` 로 시작해 `*` 로 끝나고 가운데는 이름 글자뿐.
pub fn valid_pattern(p: &str) -> bool {
    p.len() <= 40
        && p.starts_with("RV.")
        && p.ends_with('*')
        && p.matches('*').count() == 1
        && p[..p.len() - 1].bytes().all(|b| b.is_ascii_uppercase() || b.is_ascii_digit() || b == b'.' || b == b'_')
}

/// `listassets` 답(이름 → 자료) 여러 쪽을 `[{name, ipfs_hash}]` 로. 매니페스트 주소가 없는 것은 뺀다.
/// 주인 표(`!`)는 빼고 CIDv0(`Qm…` 46자) 모양이 아닌 주소는 `ipfs_hash: null`(화면의 판정이 숨김 처리).
pub fn assets_from_pages(pages: &[Value]) -> Result<Vec<Value>, String> {
    let mut seen = std::collections::BTreeSet::new();
    let mut out = Vec::new();
    for page in pages {
        let map = page.as_object().ok_or_else(|| "listassets did not return an object".to_string())?;
        for (name, data) in map {
            if name.ends_with('!') || !seen.insert(name.clone()) {
                continue;
            }
            let hash = data
                .get("ipfs_hash")
                .and_then(Value::as_str)
                .filter(|h| h.len() == 46 && h.starts_with("Qm") && h.bytes().all(|b| b.is_ascii_alphanumeric()));
            out.push(json!({ "name": name, "ipfs_hash": hash }));
        }
    }
    Ok(out)
}

#[tauri::command]
pub async fn market_list_assets(pattern: String) -> Result<Value, String> {
    if !valid_pattern(&pattern) {
        return Err("찾는 이름 모양이 올바르지 않아요.".into());
    }
    let mut pages = Vec::new();
    for i in 0..MAX_LIST_PAGES {
        let page = call_rpc("listassets", json!([pattern, true, LIST_PAGE, i * LIST_PAGE])).await?;
        let n = page.as_object().map(|m| m.len() as i64).unwrap_or(0);
        pages.push(page);
        if n < LIST_PAGE {
            break;
        }
    }
    Ok(Value::Array(assets_from_pages(&pages)?))
}

/// 체인 이름·높이·따라잡았는지. 따라잡지 못하면 `height` 는 null — 화면이 「예상」으로 표시한다.
pub fn tip_from(info: &Value) -> Value {
    let chain = info.get("chain").and_then(Value::as_str).unwrap_or("");
    let blocks = info.get("blocks").and_then(Value::as_u64);
    let headers = info.get("headers").and_then(Value::as_u64);
    let ibd = info.get("initialblockdownload").and_then(Value::as_bool).unwrap_or(false);
    let synced = matches!((blocks, headers), (Some(b), Some(h)) if b > 0 && b + 1 >= h) && !ibd;
    json!({ "chain": chain, "height": if synced { blocks } else { None }, "synced": synced })
}

#[tauri::command]
pub async fn market_chain_tip() -> Result<Value, String> {
    Ok(tip_from(&call_rpc("getblockchaininfo", json!([])).await?))
}

/// 서명된 목록 묶음 주소 검사 — 고정 주소 하나만.
pub fn signed_lists_url_ok(url: &str) -> bool {
    url == SIGNED_LISTS_URL
}

#[tauri::command]
pub async fn market_http_get(url: String) -> Result<Value, String> {
    if !signed_lists_url_ok(&url) {
        return Err("허용된 주소가 아니에요.".into());
    }
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(20))
        .build()
        .map_err(|_| "연결을 준비하지 못했어요.")?;
    let r = client.get(&url).send().await.map_err(|_| "목록 주소에 닿지 못했어요.")?;
    let status = r.status().as_u16();
    if !r.status().is_success() {
        return Ok(json!({ "ok": false, "status": status, "text": "" }));
    }
    if r.content_length().map(|n| n as usize > SIGNED_LISTS_MAX_BYTES).unwrap_or(false) {
        return Err("목록이 너무 커요.".into());
    }
    let bytes = r.bytes().await.map_err(|_| "받는 중에 끊겼어요.")?;
    if bytes.len() > SIGNED_LISTS_MAX_BYTES {
        return Err("목록이 너무 커요.".into());
    }
    Ok(json!({ "ok": true, "status": status, "text": String::from_utf8_lossy(&bytes) }))
}

/* ── 구매 거래 ────────────────────────────────────────────────────── */

#[derive(Clone, Debug, PartialEq)]
pub struct Expected {
    pub seller: String,
    pub seller_atoms: u64,
    pub fee_address: Option<String>,
    pub fee_atoms: u64,
    /// `6a…` 전체 스크립트 hex.
    pub memo_script: String,
}

struct Pending {
    id: String,
    hex: String,
    made: Instant,
    chain: String,
    summary: Value,
}
static PENDING: Mutex<Option<Pending>> = Mutex::new(None);

fn atoms_of(v: &Value) -> Option<u64> {
    let f = v.as_f64()?;
    if !f.is_finite() || f < 0.0 {
        return None;
    }
    Some((f * 1e8).round() as u64)
}
fn rvn_text(atoms: u64) -> String {
    format!("{}.{:08}", atoms / 100_000_000, atoms % 100_000_000)
}
fn parse_atoms(s: &str, allow_zero: bool) -> Result<u64, String> {
    let n: u64 = s.trim().parse().map_err(|_| "금액이 올바르지 않아요.".to_string())?;
    if n > 21_000_000_000u64 * 100_000_000 || (!allow_zero && n == 0) {
        return Err("금액이 올바르지 않아요.".into());
    }
    Ok(n)
}
fn memo_ok(script: &str) -> bool {
    script.len() >= 8
        && script.len() <= 2 + 2 + 75 * 2
        && script.starts_with("6a")
        && script.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        && usize::from_str_radix(&script[2..4], 16).map(|n| n * 2 + 4 == script.len()).unwrap_or(false)
}

/// 노드가 채운 거래(`decoderawtransaction`)가 **정확히 약속대로**인지 본다. 노드를 부르지 않는 순수 함수 — 시험.
/// `mine` = 이 주소가 이 지갑 것인가. 통과하면 화면에 보여 줄 출력 목록을 돌려준다.
pub fn inspect_decoded(decoded: &Value, e: &Expected, mine: &dyn Fn(&str) -> bool) -> Result<Vec<Value>, String> {
    let vouts = decoded.get("vout").and_then(Value::as_array).ok_or("거래를 읽지 못했어요.")?;
    let mut seller = 0;
    let mut fee = 0;
    let mut memo = 0;
    let mut change = 0;
    let mut rows = Vec::new();
    for o in vouts {
        let spk = o.get("scriptPubKey").ok_or("거래를 읽지 못했어요.")?;
        let kind = spk.get("type").and_then(Value::as_str).unwrap_or("");
        let hex = spk.get("hex").and_then(Value::as_str).unwrap_or("");
        let atoms = atoms_of(&o["value"]).ok_or("거래 금액을 읽지 못했어요.")?;
        if kind == "nulldata" {
            if hex != e.memo_script || atoms != 0 {
                return Err("거래의 기록(메모)이 약속과 달라서 만들지 않았어요.".into());
            }
            memo += 1;
            rows.push(json!({ "role": "memo", "address": null, "atoms": "0" }));
            continue;
        }
        if kind != "pubkeyhash" {
            // 자산 전송·스크립트 해시 등 — 구매 거래에는 없어야 한다.
            return Err("거래에 예상하지 못한 출력이 있어서 만들지 않았어요.".into());
        }
        let addr = spk.get("addresses").and_then(Value::as_array).and_then(|a| if a.len() == 1 { a[0].as_str() } else { None }).ok_or("출력 주소를 읽지 못했어요.")?;
        if addr == e.seller && !(e.fee_address.as_deref() == Some(addr)) {
            if atoms != e.seller_atoms {
                return Err("판매자에게 가는 금액이 약속과 달라서 만들지 않았어요.".into());
            }
            seller += 1;
            rows.push(json!({ "role": "seller", "address": addr, "atoms": atoms.to_string() }));
        } else if e.fee_address.as_deref() == Some(addr) {
            if e.fee_atoms == 0 || atoms != e.fee_atoms {
                return Err("수수료 금액이 약속과 달라서 만들지 않았어요.".into());
            }
            fee += 1;
            rows.push(json!({ "role": "fee", "address": addr, "atoms": atoms.to_string() }));
        } else if mine(addr) {
            change += 1;
            rows.push(json!({ "role": "change", "address": addr, "atoms": atoms.to_string() }));
        } else {
            return Err("거스름이 내 지갑이 아닌 곳으로 가서 만들지 않았어요.".into());
        }
    }
    let fee_expected = if e.fee_atoms > 0 { 1 } else { 0 };
    if seller != 1 || fee != fee_expected || memo != 1 || change > 1 {
        return Err("거래의 받는 곳 구성이 약속과 달라서 만들지 않았어요.".into());
    }
    Ok(rows)
}

#[tauri::command]
pub async fn market_purchase_prepare(
    asset: String,
    seller_address: String,
    seller_atoms: String,
    fee_address: Option<String>,
    fee_atoms: String,
    memo_script: String,
) -> Result<Value, String> {
    let chain = ensure_sales_allowed().await?;
    if !asset.starts_with("RV.") || asset.len() > 40 {
        return Err("상품 이름이 올바르지 않아요.".into());
    }
    let seller_atoms = parse_atoms(&seller_atoms, false)?;
    let fee_atoms = parse_atoms(&fee_atoms, true)?;
    let fee_address = if fee_atoms > 0 { Some(fee_address.ok_or("수수료 주소가 없어요.")?) } else { None };
    if !memo_ok(&memo_script) {
        return Err("기록(메모) 모양이 올바르지 않아요.".into());
    }
    if fee_address.as_deref() == Some(seller_address.as_str()) {
        return Err("판매자 주소와 수수료 주소가 같아서 만들지 않았어요.".into());
    }
    for a in std::iter::once(&seller_address).chain(fee_address.iter()) {
        let v = call_rpc("validateaddress", json!([a])).await?;
        if !v["isvalid"].as_bool().unwrap_or(false) {
            return Err("주소가 올바르지 않아요.".into());
        }
    }
    let e = Expected { seller: seller_address, seller_atoms, fee_address, fee_atoms, memo_script };

    let mut outs = serde_json::Map::new();
    outs.insert(e.seller.clone(), json!(format!("{}", rvn_text(e.seller_atoms)).parse::<f64>().unwrap_or(0.0)));
    if let Some(f) = &e.fee_address {
        outs.insert(f.clone(), json!(rvn_text(e.fee_atoms).parse::<f64>().unwrap_or(0.0)));
    }
    outs.insert("data".into(), json!(e.memo_script[4..].to_string()));
    let raw = call_rpc("createrawtransaction", json!([[], Value::Object(outs)])).await?;
    let raw = raw.as_str().ok_or("거래를 만들지 못했어요.")?.to_string();
    let funded = match call_rpc("fundrawtransaction", json!([raw, { "lockUnspents": false }])).await {
        Ok(v) => v,
        Err(err) if err.to_lowercase().contains("insufficient") => return Err("잔액이 모자라요(가격과 네트워크 수수료를 합친 금액이 필요해요). 돈은 나가지 않았어요.".into()),
        Err(err) => return Err(err),
    };
    let hex = funded.get("hex").and_then(Value::as_str).ok_or("거래를 채우지 못했어요.")?.to_string();
    let net_fee = atoms_of(&funded["fee"]).ok_or("네트워크 수수료를 알 수 없어요.")?;
    if net_fee > MAX_NETWORK_FEE_ATOMS {
        return Err("네트워크 수수료가 이상하게 커서 만들지 않았어요.".into());
    }
    let decoded = call_rpc("decoderawtransaction", json!([hex])).await?;
    // 거스름 주소가 이 지갑 것인지 노드에 묻는다(한 번에 한 주소).
    let mut mine_set = std::collections::BTreeSet::new();
    for o in decoded["vout"].as_array().cloned().unwrap_or_default() {
        if let Some(a) = o["scriptPubKey"]["addresses"][0].as_str() {
            if a != e.seller && e.fee_address.as_deref() != Some(a) {
                let v = call_rpc("validateaddress", json!([a])).await?;
                if v["ismine"].as_bool().unwrap_or(false) {
                    mine_set.insert(a.to_string());
                }
            }
        }
    }
    let rows = inspect_decoded(&decoded, &e, &|a| mine_set.contains(a))?;
    let total = e.seller_atoms + e.fee_atoms + net_fee;
    let id = {
        use rand::RngCore;
        let mut b = [0u8; 12];
        rand::thread_rng().fill_bytes(&mut b);
        b.iter().map(|x| format!("{x:02x}")).collect::<String>()
    };
    let summary = json!({
        "id": id, "asset": asset, "outputs": rows, "network_fee_atoms": net_fee.to_string(), "total_atoms": total.to_string(),
        "seller_atoms": e.seller_atoms.to_string(), "fee_atoms": e.fee_atoms.to_string(), "chain": chain, "expires_secs": PENDING_TTL.as_secs(),
    });
    *PENDING.lock().map_err(|_| "내부 오류")? = Some(Pending { id: id.clone(), hex, made: Instant::now(), chain, summary: summary.clone() });
    Ok(summary)
}

/// 방금 준비한 **그 거래**만 보낸다. 번호가 다르거나 5분이 지났거나 이미 보냈으면 거절.
#[tauri::command]
pub async fn market_purchase_send(id: String, passphrase: Option<String>) -> Result<Value, String> {
    let p = {
        let mut g = PENDING.lock().map_err(|_| "내부 오류")?;
        match g.take() {
            Some(p) if p.id == id && p.made.elapsed() <= PENDING_TTL => p,
            Some(_) | None => return Err("보낼 준비가 된 거래가 없어요(시간이 지났거나 이미 보냈어요). 확인 화면부터 다시 해 주세요. 돈은 나가지 않았어요.".into()),
        }
    };
    // 스위치는 보내는 순간에 다시 본다(준비와 전송 사이에 바뀔 일은 없지만 문은 한 곳에서 두 번 지킨다).
    let chain = ensure_sales_allowed().await?;
    if chain != p.chain {
        return Err("네트워크가 바뀌어서 보내지 않았어요. 돈은 나가지 않았어요.".into());
    }
    let hex = p.hex.clone();
    let result = crate::send::with_unlocked(passphrase, || async move {
        let signed = call_rpc("signrawtransaction", json!([hex])).await?;
        if !signed["complete"].as_bool().unwrap_or(false) {
            return Err("서명을 마치지 못했어요. 돈은 나가지 않았어요.".to_string());
        }
        let signed_hex = signed["hex"].as_str().ok_or("서명한 거래를 읽지 못했어요.")?.to_string();
        let txid = call_rpc("sendrawtransaction", json!([signed_hex])).await?;
        txid.as_str().map(str::to_string).ok_or_else(|| "sendrawtransaction did not return a txid".to_string())
    })
    .await;
    match result {
        Ok(txid) => Ok(json!({ "txid": txid, "summary": p.summary })),
        Err(e) => {
            // 지갑이 잠겨 있거나 암호가 틀린 경우는 서명 전이다 — 같은 준비를 다시 쓸 수 있게 돌려 둔다(암호를 받아 다시 부르는 길).
            // 그 밖의 오류(보냈는지 모름 포함)는 준비를 버린다 — 같은 거래를 다시 보내지 않는다.
            if is_before_signing(&e) {
                if let Ok(mut g) = PENDING.lock() {
                    *g = Some(p);
                }
            }
            Err(e)
        }
    }
}

/// `with_unlocked` 가 서명 전에 돌려주는 오류인가(잠김·암호 틀림).
pub fn is_before_signing(e: &str) -> bool {
    e.starts_with("지갑이 잠겨 있습니다") || e.starts_with("암호가 맞지 않습니다")
}

#[tauri::command]
pub fn market_purchase_cancel() {
    if let Ok(mut g) = PENDING.lock() {
        *g = None;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SELLER: &str = "RSellerAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    const FEE: &str = "RFeeBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
    const MINE: &str = "RMineCCCCCCCCCCCCCCCCCCCCCCCCCCCCC";
    const MEMO: &str = "6a0452564450"; // 6a 04 + 4 바이트

    fn exp() -> Expected {
        Expected { seller: SELLER.into(), seller_atoms: 28_500_000_000, fee_address: Some(FEE.into()), fee_atoms: 1_500_000_000, memo_script: MEMO.into() }
    }
    fn out(kind: &str, addr: Option<&str>, value: f64, hex: &str) -> Value {
        let mut spk = json!({ "type": kind, "hex": hex });
        if let Some(a) = addr {
            spk["addresses"] = json!([a]);
        }
        json!({ "value": value, "scriptPubKey": spk })
    }
    fn good() -> Value {
        json!({ "vout": [
            out("pubkeyhash", Some(SELLER), 285.0, "76a9"), out("pubkeyhash", Some(FEE), 15.0, "76a9"),
            out("nulldata", None, 0.0, MEMO), out("pubkeyhash", Some(MINE), 12.34, "76a9")] })
    }
    fn mine(a: &str) -> bool {
        a == MINE
    }

    #[test]
    fn 스위치_문은_발행_문과_같은_규칙() {
        assert!(sales_allowed_on(Some("main"), false).unwrap_err().contains("꺼져"));
        assert!(sales_allowed_on(Some("main"), true).is_ok());
        assert!(sales_allowed_on(Some("test"), false).is_ok() && sales_allowed_on(Some("regtest"), false).is_ok());
        for bad in [None, Some(""), Some("MAIN"), Some("mainnet")] {
            assert!(sales_allowed_on(bad, false).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn 정상_거래는_통과하고_출력_목록이_나온다() {
        let rows = inspect_decoded(&good(), &exp(), &mine).unwrap();
        let roles: Vec<&str> = rows.iter().map(|r| r["role"].as_str().unwrap()).collect();
        assert_eq!(roles, ["seller", "fee", "memo", "change"]);
        assert_eq!(rows[0]["atoms"], "28500000000");
    }

    #[test]
    fn 수수료가_0이면_수수료_출력이_없어야_한다() {
        let mut e = exp();
        e.fee_atoms = 0;
        e.fee_address = None;
        e.seller_atoms = 30_000_000_000;
        let d = json!({ "vout": [out("pubkeyhash", Some(SELLER), 300.0, "76a9"), out("nulldata", None, 0.0, MEMO)] });
        assert!(inspect_decoded(&d, &e, &mine).is_ok());
        // 수수료 주소로 가는 출력이 끼면 거절(수수료 기대 0).
        let d2 = json!({ "vout": [out("pubkeyhash", Some(SELLER), 300.0, "76a9"), out("pubkeyhash", Some(FEE), 1.0, "76a9"), out("nulldata", None, 0.0, MEMO)] });
        assert!(inspect_decoded(&d2, &e, &mine).is_err());
    }

    #[test]
    fn 약속과_다르면_모두_거절한다() {
        let e = exp();
        let swap = |i: usize, v: Value| { let mut d = good(); d["vout"][i] = v; d };
        // 판매자 금액 틀림 · 수수료 금액 틀림 · 메모 틀림 · 메모에 돈 · 낯선 주소 · 자산 출력 · 해시 출력
        assert!(inspect_decoded(&swap(0, out("pubkeyhash", Some(SELLER), 284.0, "76a9")), &e, &mine).is_err());
        assert!(inspect_decoded(&swap(1, out("pubkeyhash", Some(FEE), 14.0, "76a9")), &e, &mine).is_err());
        assert!(inspect_decoded(&swap(2, out("nulldata", None, 0.0, "6a0452564451")), &e, &mine).is_err());
        assert!(inspect_decoded(&swap(2, out("nulldata", None, 0.1, MEMO)), &e, &mine).is_err());
        assert!(inspect_decoded(&swap(3, out("pubkeyhash", Some("RStrangerDDDDDDDDDDDDDDDDDDDDDDDDDD"), 12.34, "76a9")), &e, &mine).is_err());
        assert!(inspect_decoded(&swap(3, out("transfer_asset", Some(MINE), 0.0, "c0")), &e, &mine).is_err());
        assert!(inspect_decoded(&swap(3, out("scripthash", Some(MINE), 12.34, "a9")), &e, &mine).is_err());
        // 판매자 출력이 두 개 / 거스름이 둘 / 판매자 출력 없음
        let mut d = good();
        d["vout"].as_array_mut().unwrap().push(out("pubkeyhash", Some(SELLER), 1.0, "76a9"));
        assert!(inspect_decoded(&d, &e, &mine).is_err());
        let mut d = good();
        d["vout"].as_array_mut().unwrap().push(out("pubkeyhash", Some(MINE), 1.0, "76a9"));
        assert!(inspect_decoded(&d, &e, &mine).is_err());
        let mut d = good();
        d["vout"].as_array_mut().unwrap().remove(0);
        assert!(inspect_decoded(&d, &e, &mine).is_err());
    }

    #[test]
    fn 거스름_없는_거래도_된다() {
        let mut d = good();
        d["vout"].as_array_mut().unwrap().pop();
        assert!(inspect_decoded(&d, &exp(), &mine).is_ok());
    }

    #[test]
    fn 목록_검색어와_결과_정리() {
        for ok in ["RV.*", "RV.M.*", "RV.G.*"] {
            assert!(valid_pattern(ok), "{ok}");
        }
        for bad in ["*", "RV*", "SHOP.*", "RV.*.*", "RV.m.*", "RV.M.X", "RV.A B.*", "RV.\"*", &format!("RV.{}*", "A".repeat(60))] {
            assert!(!valid_pattern(bad), "{bad}");
        }
        let cid = format!("Qm{}", "1".repeat(44));
        let page = json!({ "RV.M.A": { "ipfs_hash": cid }, "RV.M.A!": { "ipfs_hash": cid }, "RV.M.B": {}, "RV.M.C": { "ipfs_hash": "nope" } });
        let v = assets_from_pages(&[page.clone(), page]).unwrap();
        let names: Vec<&str> = v.iter().map(|x| x["name"].as_str().unwrap()).collect();
        assert_eq!(names, ["RV.M.A", "RV.M.B", "RV.M.C"]);
        assert_eq!(v[0]["ipfs_hash"], json!(cid));
        assert!(v[1]["ipfs_hash"].is_null() && v[2]["ipfs_hash"].is_null());
        assert!(assets_from_pages(&[json!([])]).is_err());
    }

    #[test]
    fn 체인_높이는_따라잡았을_때만() {
        assert_eq!(tip_from(&json!({ "chain": "main", "blocks": 4_000_000, "headers": 4_000_000 }))["height"], 4_000_000);
        assert!(tip_from(&json!({ "chain": "main", "blocks": 3_000_000, "headers": 4_000_000 }))["height"].is_null());
        assert!(tip_from(&json!({ "chain": "main", "blocks": 4_000_000, "headers": 4_000_000, "initialblockdownload": true }))["height"].is_null());
        assert!(tip_from(&json!({}))["height"].is_null());
    }

    #[test]
    fn 서명된_목록은_고정_주소만() {
        assert!(signed_lists_url_ok(SIGNED_LISTS_URL));
        for bad in ["http://ravenvault.ex.erci.se/lists/signed-lists.json", "https://evil.example/lists/signed-lists.json", "https://ravenvault.ex.erci.se/lists/signed-lists.json?x=1", "file:///etc/passwd"] {
            assert!(!signed_lists_url_ok(bad), "{bad}");
        }
    }

    #[test]
    fn 잠김_오류만_준비를_되살린다() {
        assert!(is_before_signing("지갑이 잠겨 있습니다. 암호가 필요합니다."));
        assert!(is_before_signing("암호가 맞지 않습니다."));
        assert!(!is_before_signing("SENT_UNKNOWN: 서버가 180초 안에 답하지 않았어요"));
        assert!(!is_before_signing("서명을 마치지 못했어요."));
    }

    #[test]
    fn 메모와_금액_입력_검사() {
        assert!(memo_ok(MEMO));
        for bad in ["", "6a", "6b0452564450", "6a0552564450", "6a04525644zz", "6a0452564450aa"] {
            assert!(!memo_ok(bad), "{bad}");
        }
        assert!(parse_atoms("1", false).is_ok() && parse_atoms("0", true).is_ok());
        for bad in ["0", "-1", "1.5", "abc", "99999999999999999999"] {
            assert!(parse_atoms(bad, false).is_err(), "{bad}");
        }
        assert_eq!(rvn_text(28_500_000_001), "285.00000001");
    }

    #[tokio::test]
    async fn 준비는_스위치와_체인을_모르면_거절하고_보관하지_않는다() {
        market_purchase_cancel();
        let r = market_purchase_prepare("RV.M.A".into(), SELLER.into(), "100".into(), None, "0".into(), MEMO.into()).await;
        assert!(r.is_err());
        assert!(PENDING.lock().unwrap().is_none());
        // 번호 없이·틀린 번호로는 못 보낸다.
        assert!(market_purchase_send("deadbeef".into(), None).await.unwrap_err().contains("돈은 나가지 않았어요"));
    }

    #[test]
    fn 이_파일은_서명_전파_명령과_준비_단계_분리를_지킨다() {
        let src = include_str!("market.rs");
        let prod = &src[..src.find("#[cfg(test)]\nmod tests").unwrap()];
        // 준비 함수 안에는 서명·전파·잠금 해제가 없다.
        let prep = &prod[prod.find("pub async fn market_purchase_prepare").unwrap()..prod.find("pub async fn market_purchase_send").unwrap()];
        for bad in ["signrawtransaction", "sendrawtransaction", "walletpassphrase", "with_unlocked"] {
            assert!(!prep.contains(bad), "준비 단계가 {bad} 를 부른다");
        }
        // 보내기 함수는 준비 번호만 받는다(거래 hex·주소·금액 인자 없음).
        let sig = &prod[prod.find("pub async fn market_purchase_send").unwrap()..];
        let sig = &sig[..sig.find(')').unwrap()];
        assert!(sig.contains("id: String") && !sig.contains("hex") && !sig.contains("address") && !sig.contains("atoms"));
        // 런타임으로 스위치를 켜는 길이 없다.
        assert!(!prod.contains("env::var"));
        assert!(prod.contains("OPEN_MARKET_SALES_ENABLED"));
    }
}
