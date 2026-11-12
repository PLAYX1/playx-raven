//! 장터 「바로 해 보는 게임」(오락실) — 데스크탑 쪽 길 셋. (2026-11-12)
//!
//! 폰·웹과 **같은 자료 모양·같은 확인**을 쓴다(지갑 저장소 `core/creator/arcade-product.ts` · `arcade-catalog.ts`).
//! 여기 러스트는 **바이트를 가져오고 돈을 보내는 일만** 한다. 무엇을 믿을지는 화면 쪽 TS 가 서명으로 가린다.
//!
//! ① `arcade_catalog_sources` — 체인 `listassets RVLT/*` 의 자산 이름 + IPFS 해시, 그리고 그 해시의 문서 바이트.
//!    문서는 이 컴퓨터의 IPFS(127.0.0.1:8080)에서 먼저, 없으면 레이븐볼트 공유 사이트(`/g/<CID>/doc`)에서 받는다.
//!    🔴 어디서 받든 믿지 않는다 — TS 가 판매자 서명(verifyArcadeProduct)과 「문서의 assetName = 그 자산」을 다시 확인한다.
//! ② `arcade_entry_reachable` — 게임 시작 파일을 지금 받을 수 있나(돈을 내고 못 하는 일이 없게, 폰 gameEntryReachable 과 같은 뜻).
//! ③ `arcade_pay` — 한 판 결제: **한 거래**(`sendmany`) 안에 판매자 99% + 레이븐볼트 수수료 1%.
//!    🔴 화면이 보낸 나누기를 그대로 믿지 않는다 — 게임값으로 여기서 다시 나눠(`split_price`, 지갑 platform-fee.ts 와 같은 규칙)
//!       같을 때만 보낸다. 수수료 주소는 코드 고정. 사람이 「정말 내기」를 누를 때만 불린다(자동 결제 없음).
//!    🔴 우리가 돈을 들고 있지 않는다: 손님 지갑이 판매자에게 직접 보낸다(noncustody.rs 의 선).
use serde_json::{json, Value};

use crate::raven::call_rpc;

/// 레이븐볼트 장터 수수료 주소 — `core/creator/trade-primitives.ts` MARKET_FEE_ADDRESS 와 같은 값(시험이 맞춘다).
pub const ARCADE_FEE_ADDRESS: &str = "RLFnbkjmf1VCVq7D9TZvRp7fv6W97rm2cB";
/// 1% (100 bps) — `core/creator/arcade-product.ts` ARCADE_FEE_BPS.
pub const ARCADE_FEE_BPS: u64 = 100;
/// 출력 하나의 먼지 한계 — `core/game-registry/platform-fee.ts` OUTPUT_DUST_ATOMS.
const DUST_ATOMS: u64 = 1000;
/// 상품 문서 크기 상한 — ARCADE_LIMITS.docBytes.
const DOC_MAX: usize = 512 * 1024;
/// 한 번에 살펴볼 자산 수 · 문서를 받아 볼 자산 수.
const LIST_MAX: usize = 500;
const DOCS_MAX: usize = 60;
const SITE: &str = "https://ravenvault.ex.erci.se";
const LOCAL_GATEWAY: &str = "http://127.0.0.1:8080";
/// 21억 RVN 상한(atoms) — MAX_PRICE_ATOMS 보다 넉넉하지 않게.
const MAX_ATOMS: u64 = 21_000_000_000 * 100_000_000;

static CLIENT: std::sync::OnceLock<reqwest::Client> = std::sync::OnceLock::new();
fn client() -> &'static reqwest::Client {
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(6))
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .unwrap_or_default()
    })
}

/// CID 모양(v0 `Qm…` · v1 `b…`). 경로에 붙이기 전 거른다.
pub(crate) fn cid_ok(c: &str) -> bool {
    let v0 = c.len() == 46 && c.starts_with("Qm") && c.bytes().all(|b| b.is_ascii_alphanumeric() && b != b'0' && b != b'O' && b != b'I' && b != b'l');
    let v1 = c.len() >= 59 && c.len() <= 101 && c.starts_with('b') && c.bytes().skip(1).all(|b| b.is_ascii_lowercase() || (b'2'..=b'7').contains(&b));
    v0 || v1
}
/// 게임 파일 경로(문서 entry) — 폰 product.ts 와 같은 모양만.
fn entry_ok(p: &str) -> bool {
    !p.is_empty() && p.len() <= 200 && p.split('/').all(|seg| {
        !seg.is_empty() && seg != "." && seg != ".." && !seg.starts_with('.')
            && seg.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'_' || b == b'-')
    })
}
/// 문서를 받아 볼 만한 이름인가: `RVLT/<가게>/<상품>` 또는 `RVLT/<가게>#<이름>` (가게 이름만은 상품이 아니다).
pub(crate) fn product_like(name: &str) -> bool {
    name.starts_with("RVLT/") && (name.matches('/').count() >= 2 || name.contains('#'))
}

async fn get_capped(url: &str) -> Option<Vec<u8>> {
    let r = client().get(url).send().await.ok()?;
    if !r.status().is_success() {
        return None;
    }
    if r.content_length().map(|n| n as usize > DOC_MAX).unwrap_or(false) {
        return None;
    }
    let b = r.bytes().await.ok()?;
    (b.len() <= DOC_MAX).then(|| b.to_vec())
}

pub(crate) async fn fetch_doc(cid: &str) -> Option<Vec<u8>> {
    if let Some(b) = get_capped(&format!("{LOCAL_GATEWAY}/ipfs/{cid}")).await {
        return Some(b);
    }
    get_capped(&format!("{SITE}/g/{cid}/doc")).await
}

/// 공개 연결의 목록 답(`GET {SITE}/api/chain/arcade-assets` → `{assets:[{name, ipfs_hash}]}`) 크기 상한.
const PUBLIC_LIST_MAX_BYTES: usize = 600_000;

/// 노드 `listassets` 답(이름 → 정보) → (이름, 해시) 목록.
fn assets_from_node(raw: &Value) -> Option<Vec<(String, Option<String>)>> {
    let map = raw.as_object()?;
    Some(map.iter().take(LIST_MAX).map(|(name, info)| {
        (name.clone(), info.get("ipfs_hash").and_then(Value::as_str).filter(|c| cid_ok(c)).map(str::to_string))
    }).collect())
}
/// 공개 연결 답 → (이름, 해시) 목록. 모양이 틀리면 None. 이 답도 믿지 않는다(TS 가 문서 서명·assetName 을 다시 본다).
fn assets_from_public(raw: &Value) -> Option<Vec<(String, Option<String>)>> {
    let list = raw.get("assets")?.as_array()?;
    let mut out = Vec::new();
    for a in list.iter().take(LIST_MAX) {
        let name = a.get("name")?.as_str()?;
        if !name.starts_with("RVLT/") || name.len() > 32 {
            continue;
        }
        out.push((name.to_string(), a.get("ipfs_hash").and_then(Value::as_str).filter(|c| cid_ok(c)).map(str::to_string)));
    }
    Some(out)
}
async fn public_list() -> Option<Vec<(String, Option<String>)>> {
    let r = client().get(format!("{SITE}/api/chain/arcade-assets")).send().await.ok()?;
    if !r.status().is_success() || r.content_length().map(|n| n as usize > PUBLIC_LIST_MAX_BYTES).unwrap_or(false) {
        return None;
    }
    let b = r.bytes().await.ok()?;
    if b.len() > PUBLIC_LIST_MAX_BYTES {
        return None;
    }
    assets_from_public(&serde_json::from_slice(&b).ok()?)
}

/// 체인의 `RVLT/*` 자산 목록 — 이 컴퓨터의 노드가 먼저, 노드가 못 답하면 레이븐볼트 공개 연결의 목록.
pub(crate) async fn chain_list() -> Result<(Vec<(String, Option<String>)>, &'static str), String> {
    match call_rpc("listassets", json!(["RVLT/*", true, LIST_MAX, 0])).await.ok().as_ref().and_then(assets_from_node) {
        Some(l) => Ok((l, "node")),
        None => Ok((public_list().await.ok_or("공개 장부가 목록을 주지 않았습니다.")?, "public")),
    }
}

/// 상품처럼 생긴 자산의 문서 해시(겹침 없이 · 최대 `max`)와 그 문서 바이트. 오락실 화면과 「오락실 게임 지키기」가 같이 쓴다.
pub(crate) async fn docs_for(list: &[(String, Option<String>)], max: usize) -> Vec<(String, Vec<u8>)> {
    let mut want: Vec<String> = Vec::new();
    for (name, hash) in list {
        if let Some(h) = hash {
            if product_like(name) && want.len() < max && !want.contains(h) {
                want.push(h.clone());
            }
        }
    }
    let jobs = want.iter().map(|cid| async move { (cid.clone(), fetch_doc(cid).await) });
    futures_util::future::join_all(jobs).await.into_iter().filter_map(|(c, b)| b.map(|b| (c, b))).collect()
}

/// 화면에 주는 모양 `{ assets:[{name, ipfsHash}], docs:{cid: base64}, source }`.
pub(crate) fn sources_json(list: &[(String, Option<String>)], docs: &[(String, Vec<u8>)], source: &str) -> Value {
    use base64::Engine as _;
    let assets: Vec<Value> = list.iter().map(|(name, hash)| json!({ "name": name, "ipfsHash": hash })).collect();
    let mut map = serde_json::Map::new();
    for (cid, b) in docs {
        map.insert(cid.clone(), json!(base64::engine::general_purpose::STANDARD.encode(b)));
    }
    json!({ "assets": assets, "docs": map, "source": source })
}

/// 체인의 `RVLT/*` 자산과 그 문서 바이트(base64). 이 컴퓨터의 노드가 먼저, 노드가 못 답하면 레이븐볼트 공개 연결의 목록.
/// 둘 다 못 읽으면 오류 — 화면은 「읽지 못했어요」로 정직하게.
#[tauri::command]
pub async fn arcade_catalog_sources() -> Result<Value, String> {
    let (list, source) = chain_list().await?;
    let docs = docs_for(&list, DOCS_MAX).await;
    Ok(sources_json(&list, &docs, source))
}

/// 손님이 한 판 내기 전 「지금 할 수 있나」 확인의 제한 시간 — 판매자 컴퓨터가 꺼져 있으면 오래 기다리지 않는다.
const REACH_SECS: u64 = 5;

/// 게임 문서와 시작 파일을 **손님 게임 판이 쓰는 그 길**(공유 사이트 `/g/<CID>/doc` · `/arcade/ipfs/<CID>/<시작 파일>`)로
/// 지금 받을 수 있나. 둘 다 되어야 참. 사이트가 문서 CID·서명·sha256·크기를 맞춰 내주므로 200 = 진짜 받을 수 있다.
/// 🔴 게임은 판매자 컴퓨터에 산다 — 꺼져 있으면 여기서 거짓이 되고, 화면은 돈을 받지 않는다.
#[tauri::command]
pub async fn arcade_entry_reachable(doc_cid: String, entry: String) -> Result<bool, String> {
    if !cid_ok(&doc_cid) || !entry_ok(&entry) {
        return Ok(false);
    }
    let ok = |url: String| async move {
        let r = client().get(url).timeout(std::time::Duration::from_secs(REACH_SECS)).send().await;
        matches!(r, Ok(res) if res.status().is_success())
    };
    let (doc, file) = futures_util::join!(ok(format!("{SITE}/g/{doc_cid}/doc")), ok(format!("{SITE}/arcade/ipfs/{doc_cid}/{entry}")));
    Ok(doc && file)
}

/// 게임값 → (판매자, 수수료) atoms. 지갑 `splitPrice(price, 100)` 와 같은 규칙: 수수료 올림 · 먼지 한계 1000.
pub fn split_price(price: u64) -> Result<(u64, u64), String> {
    if price < 1 || price > MAX_ATOMS {
        return Err("게임값이 맞지 않습니다.".into());
    }
    let mut fee = (price * ARCADE_FEE_BPS + 9_999) / 10_000;
    if fee < DUST_ATOMS {
        fee = DUST_ATOMS;
    }
    let seller = price.checked_sub(fee).ok_or("게임값이 너무 작습니다.")?;
    if seller < DUST_ATOMS {
        return Err("게임값이 너무 작습니다.".into());
    }
    Ok((seller, fee))
}

/// atoms → RVN 글자(소수 8자리 정확히). 노드의 금액 칸은 글자도 받는다(AmountFromValue) — 부동소수 반올림이 끼지 않는다.
fn atoms_json(a: u64) -> Value {
    json!(format!("{}.{:08}", a / 100_000_000, a % 100_000_000))
}

/// 한 판 결제. 사람이 확인 창에서 「정말 내기」를 누른 뒤에만 불린다.
#[tauri::command]
pub async fn arcade_pay(
    request_id: String,
    doc_cid: String,
    pay_to: String,
    price_atoms: u64,
    seller_atoms: u64,
    fee_atoms: u64,
    passphrase: Option<String>,
) -> Result<Value, String> {
    if !cid_ok(&doc_cid) {
        return Err("게임 문서 주소가 맞지 않습니다.".into());
    }
    let (seller, fee) = split_price(price_atoms)?;
    if seller != seller_atoms || fee != fee_atoms {
        return Err("나눈 값이 맞지 않아 보내지 않았습니다.".into());
    }
    let pay_to = pay_to.trim().to_string();
    if pay_to == ARCADE_FEE_ADDRESS {
        // sendmany 는 주소로 묶는다 — 같은 주소 둘은 한 출력으로 합쳐져 나누기가 사라진다.
        return Err("판매자 주소와 수수료 주소가 같습니다.".into());
    }
    let addr = crate::send::check_address(pay_to.clone()).await?;
    if !addr["valid"].as_bool().unwrap_or(false) {
        return Err("판매자 받는 주소가 올바르지 않습니다.".into());
    }
    let intent = serde_json::to_vec(&json!(["arcade", doc_cid, pay_to, seller, ARCADE_FEE_ADDRESS, fee]))
        .map_err(|_| "지급 내용 오류")?;
    crate::send::with_unlocked(passphrase, || async {
        let guard = match crate::payout_guard::begin(&crate::paths::app_file("payouts"), "arcade", &request_id, &intent)? {
            crate::payout_guard::Begin::Done(txid) => return Ok(json!({ "txid": txid, "replayed": true })),
            crate::payout_guard::Begin::New(guard) => guard,
        };
        let mut outs = serde_json::Map::new();
        outs.insert(pay_to.clone(), atoms_json(seller));
        outs.insert(ARCADE_FEE_ADDRESS.to_string(), atoms_json(fee));
        let result = call_rpc("sendmany", json!(["", Value::Object(outs)])).await?;
        let txid = result.as_str().map(str::to_string).ok_or_else(|| "sendmany did not return a txid".to_string())?;
        guard.complete_waiting_ack(&txid)?;
        crate::refund::remember_ours(&txid);
        Ok(json!({ "txid": txid, "sellerAtoms": seller, "feeAtoms": fee }))
    })
    .await
}

/// 결과를 화면이 받았다 — 결제 칸의 「미확인」 표시를 푼다(send_ack 와 같은 일).
#[tauri::command(async)]
pub fn arcade_ack(request_id: String) -> Result<(), String> {
    crate::payout_guard::acknowledge(&crate::paths::app_file("payouts"), "arcade", &request_id)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 공개_연결_목록은_이름과_해시만_받는다() {
        let q = format!("Qm{}", "W".repeat(44));
        let v = json!({ "assets": [
            { "name": "RVLT/SHOP#A", "ipfs_hash": q },
            { "name": "RVLT/SHOP/B", "ipfs_hash": "../../etc" },
            { "name": "PLAYX", "ipfs_hash": q },
        ]});
        let got = assets_from_public(&v).unwrap();
        assert_eq!(got, vec![("RVLT/SHOP#A".to_string(), Some(q.clone())), ("RVLT/SHOP/B".to_string(), None)]);
        assert!(assets_from_public(&json!({ "nope": 1 })).is_none());
        assert!(assets_from_public(&json!({ "assets": [{ "name": 3 }] })).is_none());
        let node = json!({ "RVLT/SHOP#A": { "name": "RVLT/SHOP#A", "ipfs_hash": q } });
        assert_eq!(assets_from_node(&node).unwrap().len(), 1);
        assert!(assets_from_node(&json!([])).is_none());
        // 공개 연결 길은 코드 고정(요청에서 주소를 받지 않는다).
        let src = include_str!("arcade.rs");
        assert!(src.contains("format!(\"{SITE}/api/chain/arcade-assets\")"));
    }

    #[test]
    fn 나누기는_지갑과_같다() {
        // 1 RVN → 수수료 1% = 1,000,000 · 판매자 99,000,000
        assert_eq!(split_price(100_000_000).unwrap(), (99_000_000, 1_000_000));
        // 올림
        assert_eq!(split_price(100_001).unwrap(), (99_000, 1_001));
        // 먼지 한계: 수수료는 적어도 1000
        assert_eq!(split_price(50_000).unwrap(), (49_000, 1_000));
        // 판매자 몫이 먼지보다 작으면 거절
        assert!(split_price(1_500).is_err());
        assert!(split_price(0).is_err());
    }

    #[test]
    fn 금액_글자는_소수_8자리() {
        assert_eq!(atoms_json(99_000_000), json!("0.99000000"));
        assert_eq!(atoms_json(1_000), json!("0.00001000"));
        assert_eq!(atoms_json(123_456_789_012), json!("1234.56789012"));
    }

    #[test]
    fn 이름과_경로_모양() {
        assert!(product_like("RVLT/NIGHT/RUNNER"));
        assert!(product_like("RVLT/NIGHT#RUNNER"));
        assert!(!product_like("RVLT/NIGHT"));
        assert!(!product_like("OTHER/A/B"));
        assert!(cid_ok("QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG"));
        assert!(!cid_ok("Qm../../x"));
        assert!(entry_ok("index.html") && entry_ok("game/start.html"));
        assert!(!entry_ok("../x.html") && !entry_ok("a//b") && !entry_ok(".hidden/x.html"));
    }

    #[test]
    fn 돈은_사람이_누를_때만_한_거래로() {
        let src = include_str!("arcade.rs");
        let end = src.find("#[cfg(test)]").unwrap();
        let body = &src[..end];
        assert_eq!(body.matches("call_rpc(\"sendmany\"").count(), 1, "결제 부름은 arcade_pay 한 곳뿐");
        assert!(!body.contains("sendtoaddress"), "판매자·수수료를 두 거래로 나누지 않는다");
    }
}
