//! 릴레이 장터 — 원자 교환(`swap.rs`) 반쪽을 **kind 30402 글**로 올리고 읽는다.
//!
//! ## 왜 필요한가
//!
//! 반쪽짜리 제안(hex)은 여태 문자·쪽지로 손으로 날랐다. 아는 사람끼리만
//! 팔 수 있었다. 이 파일은 그 글자를 릴레이에 「물건」으로 올려, 모르는
//! 사람도 찾아서 살 수 있게 한다. **우리 서버를 지나지 않는다** — 글은
//! 릴레이에, 돈과 자산은 체인에 있다.
//!
//! ## 🔴 글을 믿지 않는다. 체인을 믿는다.
//!
//! 글(이벤트)에 적힌 제목·값·자산 이름은 누구나 지어낼 수 있다. 서명은
//! 「누가 썼나」만 말해 준다. 그래서 사는 쪽은 반드시:
//!
//! ① swap hex 를 열어 입력 1개·출력 1개인지,
//! ② 입력 0번이 글의 `outpoint` 와 같은지,
//! ③ 출력 0번이 글의 `price` 값으로 글의 `pay` 주소에 가는지(자산이 안 붙은 RVN),
//! ④ 체인(`gettxout`)에 그 동전이 **아직 안 쓰였고**, 글이 말하는 자산·수량이
//!    **딱 그만큼** 들어 있는지
//!
//! 를 확인한다. 하나라도 어긋나면 한국어 이유를 달고 거절한다.
//!
//! ## 🔴 돈 규칙
//!
//! - 아무것도 저절로 서명·방송하지 않는다. 사는 것(`swap_take_listing`
//!   broadcast=true)·내리기(`market_cancel_listing`)는 사람이 누른 단추에서만 온다.
//! - 지갑 암호·12단어는 어디에도 적지 않고 밖으로 보내지 않는다. 릴레이에
//!   나가는 것은 이미 공개될 값(주소·hex·제목)뿐이다.
//! - 1% 개발비는 기존 맞교환 규칙 그대로 **사는 쪽이 얹는다**(`swap_take`).
//!   글의 `price` 는 파는 사람이 받는 값이다.
//!
//! ## 글 모양 (kind 30402, 이야기와 같은 사람 열쇠로 서명)
//!
//! ```text
//! ["d","rvswap:<txid>:<vout>"] ["title",..] ["summary",..] ["published_at",초]
//! ["price","<RVN 8자리>","RVN"] ["t","playx"] ["t","ravencoin"] ["t","rv-swap"]
//! ["t",<분류>] ["status","active"|"sold"|"cancelled"] ["asset",이름,"<수량>"]
//! ["outpoint",txid,"<vout>"] ["pay",<0번 출력 주소>] ["swap",<hex>,"v1"] ["image",url]?
//! content = 설명(글자 그대로)
//! ```
//!
//! 웹 장터(`web/shops.src.ts`)·지갑(`web/wallet.src.ts`)이 읽는 `d,title,price,
//! published_at,t,status,image` 를 그대로 쓰므로, 그쪽 목록에도 「RVN 값의
//! 물건」으로 뜬다. 값 하나는 1024자를 넘기지 않는다.

use crate::raven::call_rpc;
use serde_json::{json, Value};

const KIND_LISTING: i64 = 30402;
const KIND_DELETE: i64 = 5;
const KIND_NOTE: i64 = 1;
/// 이 표가 있어야 「맞교환 물건」으로 찾는다. 릴레이 물음도 이 표로 좁힌다.
const SWAP_TAG: &str = "rv-swap";
const D_PREFIX: &str = "rvswap:";
const SWAP_VERSION: &str = "v1";
/// 고를 수 있는 분류. 이 밖의 것은 안 받는다 — 화면이 모르는 분류는 길을 잃는다.
pub(crate) const CATEGORIES: [&str; 7] = ["music", "game", "image", "book", "ticket", "work", "other"];
/// 웹 쪽 읽는 곳과 맞춘 한도. 태그 값 하나가 이보다 길면 안 올리고 안 읽는다.
const MAX_VALUE: usize = 1024;
const MAX_TITLE_CHARS: usize = 100;
const MAX_SUMMARY_CHARS: usize = 300;
/// 체인에 물어보는 개수 상한. 한 번 둘러볼 때 노드에 RPC 가 60번 넘게 가지 않게.
const MAX_CHECK: usize = 30;

fn now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// RVN(소수) → 사토시. 값 비교는 늘 사토시 정수로 한다.
fn sats(x: f64) -> i64 {
    (x * 1e8).round() as i64
}

/// "12.5" · "12.50000000" → 사토시. 부호·지수·9자리 이상 소수는 안 받는다.
fn parse_rvn(s: &str) -> Option<i64> {
    let s = s.trim();
    if s.is_empty() || s.len() > 20 {
        return None;
    }
    let (whole, frac) = match s.split_once('.') {
        Some((w, f)) => (w, f),
        None => (s, ""),
    };
    if whole.is_empty() || !whole.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    if frac.len() > 8 || !frac.bytes().all(|b| b.is_ascii_digit()) || (s.contains('.') && frac.is_empty()) {
        return None;
    }
    let w: i64 = whole.parse().ok()?;
    // 레이븐 총량(210억)을 넘는 값은 글자 장난이다.
    if w > 21_000_000_000 {
        return None;
    }
    let mut f = frac.to_string();
    while f.len() < 8 {
        f.push('0');
    }
    let f: i64 = f.parse().ok()?;
    w.checked_mul(100_000_000)?.checked_add(f)
}

fn fmt_rvn(s: i64) -> String {
    format!("{}.{:08}", s / 100_000_000, s % 100_000_000)
}

/// 자산 수량 글자. 뒤의 0 은 지운다("5" · "0.25").
fn fmt_amount(a: f64) -> String {
    let t = format!("{a:.8}");
    let t = t.trim_end_matches('0').trim_end_matches('.');
    t.to_string()
}

fn same_amount(a: f64, b: f64) -> bool {
    (a - b).abs() < 1e-8
}

fn is_hex(s: &str) -> bool {
    !s.is_empty() && s.len() % 2 == 0 && s.bytes().all(|b| b.is_ascii_hexdigit())
}

fn is_txid(s: &str) -> bool {
    s.len() == 64 && s.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// 제목·요약을 다듬는다. 제어 글자(줄바꿈 포함)는 안 받는다 — 화면을 깨뜨린다.
fn clean_line(s: &str, what: &str, max_chars: usize, required: bool) -> Result<String, String> {
    let t = s.trim().to_string();
    if required && t.is_empty() {
        return Err(format!("{what}을(를) 적어 주세요."));
    }
    if t.chars().any(|c| c.is_control()) {
        return Err(format!("{what}에 쓸 수 없는 글자(줄바꿈·제어 글자)가 있습니다."));
    }
    if t.chars().count() > max_chars || t.len() > MAX_VALUE {
        return Err(format!("{what}이(가) 너무 깁니다. {max_chars}자 아래로 줄여 주세요."));
    }
    Ok(t)
}

/// 사진 주소. `https://` · `ipfs://` 만 받는다 — `javascript:`·`data:` 는 여는 화면에서 돈다.
fn clean_image(image: Option<String>) -> Result<Option<String>, String> {
    let Some(u) = image.map(|s| s.trim().to_string()).filter(|s| !s.is_empty()) else {
        return Ok(None);
    };
    if u.len() > MAX_VALUE {
        return Err("사진 주소가 너무 깁니다.".into());
    }
    if !(u.starts_with("https://") || u.starts_with("ipfs://")) {
        return Err("사진 주소는 https:// 또는 ipfs:// 로 시작해야 합니다.".into());
    }
    if u.chars().any(|c| c.is_whitespace() || c.is_control() || c == '"' || c == '<' || c == '>') {
        return Err("사진 주소에 쓸 수 없는 글자가 있습니다.".into());
    }
    Ok(Some(u))
}

fn clean_category(c: &str) -> Result<String, String> {
    let c = c.trim().to_ascii_lowercase();
    if CATEGORIES.contains(&c.as_str()) {
        Ok(c)
    } else {
        Err(format!("분류는 {} 중 하나여야 합니다.", CATEGORIES.join("·")))
    }
}

fn d_of(txid: &str, vout: u64) -> String {
    format!("{D_PREFIX}{txid}:{vout}")
}

/// 장터 물건 하나. 글에서 읽었든 내가 만들었든 같은 모양이다.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct Listing {
    pub d: String,
    pub pubkey: String,
    pub event_id: String,
    pub title: String,
    pub summary: String,
    pub content: String,
    pub category: String,
    pub asset: String,
    pub amount: f64,
    pub price_sats: i64,
    pub pay: String,
    pub txid: String,
    pub vout: u64,
    pub swap: String,
    pub image: Option<String>,
    pub published_at: i64,
    pub created_at: i64,
    pub status: String,
}

/// 글의 태그를 만든다. 순서도 계약이다(`preserve_order`).
pub(crate) fn build_tags(l: &Listing) -> Value {
    let mut tags = vec![
        json!(["d", l.d]),
        json!(["title", l.title]),
        json!(["summary", l.summary]),
        json!(["published_at", l.published_at.to_string()]),
        json!(["price", fmt_rvn(l.price_sats), "RVN"]),
        json!(["t", "playx"]),
        json!(["t", "ravencoin"]),
        json!(["t", SWAP_TAG]),
        json!(["t", l.category]),
        json!(["status", l.status]),
        json!(["asset", l.asset, fmt_amount(l.amount)]),
        json!(["outpoint", l.txid, l.vout.to_string()]),
        json!(["pay", l.pay]),
        json!(["swap", l.swap, SWAP_VERSION]),
    ];
    if let Some(img) = &l.image {
        tags.push(json!(["image", img]));
    }
    Value::Array(tags)
}

fn tag_row<'a>(tags: &'a [Value], name: &str) -> Option<&'a Vec<Value>> {
    tags.iter()
        .filter_map(Value::as_array)
        .find(|t| t.first().and_then(Value::as_str) == Some(name))
}

fn tag_at<'a>(tags: &'a [Value], name: &str, i: usize) -> Option<&'a str> {
    tag_row(tags, name).and_then(|t| t.get(i)).and_then(Value::as_str)
}

/// 글 → 물건. **서명은 여기서 안 본다**(부르는 쪽이 `relay::verify`).
/// 모양이 하나라도 틀리면 이유를 단 `Err`.
pub(crate) fn parse_listing(ev: &Value) -> Result<Listing, String> {
    if ev.get("kind").and_then(Value::as_i64) != Some(KIND_LISTING) {
        return Err("장터 물건 글이 아닙니다.".into());
    }
    let tags = ev.get("tags").and_then(Value::as_array).ok_or("태그가 없습니다.")?;
    // 값 길이 — 웹 쪽 읽는 곳과 같은 1024자.
    for t in tags {
        let row = t.as_array().ok_or("태그 모양이 다릅니다.")?;
        if row.iter().any(|x| x.as_str().map(|s| s.len() > MAX_VALUE).unwrap_or(true)) {
            return Err("태그 값이 너무 길거나 글자가 아닙니다.".into());
        }
    }
    let ts: Vec<&str> = tags
        .iter()
        .filter_map(Value::as_array)
        .filter(|t| t.first().and_then(Value::as_str) == Some("t"))
        .filter_map(|t| t.get(1).and_then(Value::as_str))
        .collect();
    if !ts.contains(&SWAP_TAG) {
        return Err("맞교환 물건 표(rv-swap)가 없습니다.".into());
    }
    let category = ts
        .iter()
        .find(|t| CATEGORIES.contains(t))
        .map(|s| s.to_string())
        .ok_or("분류가 없거나 모르는 분류입니다.")?;

    let d = tag_at(tags, "d", 1).ok_or("물건 이름(d)이 없습니다.")?.to_string();
    let title = tag_at(tags, "title", 1).unwrap_or("").to_string();
    if title.trim().is_empty() {
        return Err("제목이 없습니다.".into());
    }
    let summary = tag_at(tags, "summary", 1).unwrap_or("").to_string();
    let status = tag_at(tags, "status", 1).unwrap_or("").to_string();
    if !["active", "sold", "cancelled"].contains(&status.as_str()) {
        return Err("상태가 올바르지 않습니다.".into());
    }
    if tag_at(tags, "price", 2) != Some("RVN") {
        return Err("값이 RVN 이 아닙니다.".into());
    }
    let price_sats = tag_at(tags, "price", 1)
        .and_then(parse_rvn)
        .filter(|v| *v > 0)
        .ok_or("값을 읽을 수 없습니다.")?;
    let asset = tag_at(tags, "asset", 1).unwrap_or("").to_string();
    if asset.is_empty() || asset.len() > 64 {
        return Err("자산 이름이 올바르지 않습니다.".into());
    }
    let amount: f64 = tag_at(tags, "asset", 2)
        .and_then(|s| s.parse::<f64>().ok())
        .filter(|a| a.is_finite() && *a > 0.0)
        .ok_or("자산 수량을 읽을 수 없습니다.")?;
    let txid = tag_at(tags, "outpoint", 1).unwrap_or("").to_string();
    if !is_txid(&txid) {
        return Err("동전 번호(outpoint)가 올바르지 않습니다.".into());
    }
    let vout: u64 = tag_at(tags, "outpoint", 2)
        .filter(|s| !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit()))
        .and_then(|s| s.parse().ok())
        .ok_or("동전 번호(outpoint)가 올바르지 않습니다.")?;
    if d != d_of(&txid, vout) {
        return Err("물건 이름(d)이 동전 번호와 다릅니다.".into());
    }
    let pay = tag_at(tags, "pay", 1).unwrap_or("").to_string();
    if pay.is_empty() || pay.len() > 64 || !pay.bytes().all(|b| b.is_ascii_alphanumeric()) {
        return Err("받는 주소(pay)가 올바르지 않습니다.".into());
    }
    let swap = tag_at(tags, "swap", 1).unwrap_or("").to_string();
    if !is_hex(&swap) {
        return Err("교환 글자(swap)가 올바르지 않습니다.".into());
    }
    if tag_at(tags, "swap", 2) != Some(SWAP_VERSION) {
        return Err("모르는 교환 글자 판입니다.".into());
    }
    let image = match tag_at(tags, "image", 1) {
        Some(u) => clean_image(Some(u.to_string())).ok().flatten(),
        None => None,
    };
    let created_at = ev.get("created_at").and_then(Value::as_i64).unwrap_or(0);
    let published_at = tag_at(tags, "published_at", 1)
        .and_then(|s| s.parse::<i64>().ok())
        .unwrap_or(created_at);
    Ok(Listing {
        d,
        pubkey: ev.get("pubkey").and_then(Value::as_str).unwrap_or("").to_string(),
        event_id: ev.get("id").and_then(Value::as_str).unwrap_or("").to_string(),
        title,
        summary,
        content: ev.get("content").and_then(Value::as_str).unwrap_or("").to_string(),
        category,
        asset,
        amount,
        price_sats,
        pay,
        txid,
        vout,
        swap,
        image,
        published_at,
        created_at,
        status,
    })
}

/// 열어 본 swap hex 가 글과 같은가. **체인에 묻기 전의 확인** (①②③).
pub(crate) fn check_decoded(l: &Listing, dec: &Value) -> Result<(), String> {
    let vin = dec["vin"].as_array().cloned().unwrap_or_default();
    let vout = dec["vout"].as_array().cloned().unwrap_or_default();
    if vin.len() != 1 || vout.len() != 1 {
        return Err("교환 글자의 모양이 다릅니다(입력 1개·출력 1개여야 합니다). 사지 마세요.".into());
    }
    if vin[0]["txid"].as_str() != Some(l.txid.as_str()) || vin[0]["vout"].as_u64() != Some(l.vout) {
        return Err("교환 글자가 쓰는 동전이 글에 적힌 동전과 다릅니다. 사지 마세요.".into());
    }
    let first = &vout[0];
    if sats(first["value"].as_f64().unwrap_or(-1.0)) != l.price_sats {
        return Err(format!(
            "글에는 {} RVN 이라 적혀 있는데 교환 글자의 값은 {} RVN 입니다. 사지 마세요.",
            fmt_rvn(l.price_sats),
            fmt_rvn(sats(first["value"].as_f64().unwrap_or(0.0)))
        ));
    }
    let spk = &first["scriptPubKey"];
    if !spk["asset"].is_null() {
        return Err("파는 사람이 받는 출력에 자산이 붙어 있습니다. 사지 마세요.".into());
    }
    let addrs = spk["addresses"].as_array().cloned().unwrap_or_default();
    if addrs.len() != 1 || addrs[0].as_str() != Some(l.pay.as_str()) {
        return Err("교환 글자가 돈을 보내는 주소가 글에 적힌 주소와 다릅니다. 사지 마세요.".into());
    }
    Ok(())
}

/// `swap::swap_check_at` 의 답이 글과 같은가 (④).
pub(crate) fn check_chain_info(l: &Listing, info: &Value) -> Result<(), String> {
    if !info["ok"].as_bool().unwrap_or(false) {
        return Err(info["why"].as_str().unwrap_or("쓸 수 없는 제안입니다.").to_string());
    }
    if info["txid"].as_str() != Some(l.txid.as_str()) || info["vout"].as_u64() != Some(l.vout) {
        return Err("체인이 말하는 동전이 글과 다릅니다. 사지 마세요.".into());
    }
    if info["asset"].as_str() != Some(l.asset.as_str()) {
        return Err(format!(
            "글에는 {} 이라 적혀 있는데 체인에는 {} 이 들어 있습니다. 사지 마세요.",
            l.asset,
            info["asset"].as_str().unwrap_or("?")
        ));
    }
    if !same_amount(info["amount"].as_f64().unwrap_or(0.0), l.amount) {
        return Err(format!(
            "글에는 {}개라 적혀 있는데 체인에는 {}개가 들어 있습니다. 사지 마세요.",
            fmt_amount(l.amount),
            fmt_amount(info["amount"].as_f64().unwrap_or(0.0))
        ));
    }
    if sats(info["price"].as_f64().unwrap_or(-1.0)) != l.price_sats || info["seller"].as_str() != Some(l.pay.as_str()) {
        return Err("체인 확인 결과의 값·주소가 글과 다릅니다. 사지 마세요.".into());
    }
    Ok(())
}

/// 미리 보여 준 값(자산·개수·값·개발비·합계)과 지금 체인 확인 값이 사토시까지 같은가. 다르면 보내지 않는다.
fn same_as_previewed(expect: &Value, info: &Value) -> Result<(), String> {
    const DIFF: &str = "미리 본 값과 지금 값이 달라 보내지 않았어요. 다시 「사기」를 눌러 확인해 주세요.";
    if expect["asset"].as_str().unwrap_or_default() != info["asset"].as_str().unwrap_or_default() {
        return Err(DIFF.into());
    }
    for k in ["amount", "price", "fee", "total"] {
        let (Some(a), Some(b)) = (expect[k].as_f64(), info[k].as_f64()) else {
            // 미리 보기에 없던 칸은 비교할 수 없다 — 값(price)·개수(amount)는 반드시 있어야 한다.
            if k == "price" || k == "amount" { return Err(DIFF.into()); }
            continue;
        };
        if sats(a) != sats(b) {
            return Err(DIFF.into());
        }
    }
    Ok(())
}

/// 글 → 체인. 열어 보고(①②③), 노드에 묻는다(④). 노드가 답을 못 하면 그것도 실패다.
async fn chain_check(l: &Listing) -> Result<Value, String> {
    let dec = call_rpc("decoderawtransaction", json!([l.swap.clone()]))
        .await
        .map_err(|_| "교환 글자를 열지 못했습니다(노드가 답하지 않거나 글자가 깨졌습니다).".to_string())?;
    check_decoded(l, &dec)?;
    let info = crate::swap::swap_check_at(l.swap.clone(), None).await?;
    check_chain_info(l, &info)?;
    Ok(info)
}

/// regtest 통합 시험(`tests/market_regtest.rs`)이 사는 쪽 확인을 그대로 부르는 입구. 기본 빌드에는 없다.
#[cfg(feature = "regtest-harness")]
pub(crate) async fn chain_check_for_harness(l: &Listing) -> Result<Value, String> {
    chain_check(l).await
}

/// 화면에 넘기는 모양(ListingView).
pub(crate) fn view(l: &Listing, me: Option<&str>, check: Option<Result<(), String>>) -> Value {
    let (ok, reason) = match check {
        Some(Ok(())) => (json!(true), Value::Null),
        Some(Err(e)) => (json!(false), json!(e)),
        None => (json!(false), json!("아직 체인에 확인하지 않았습니다.")),
    };
    json!({
        "d": l.d,
        "pubkey": l.pubkey,
        "eventId": l.event_id,
        "title": l.title,
        "summary": l.summary,
        "category": l.category,
        "asset": l.asset,
        "amount": l.amount,
        "priceRvn": l.price_sats as f64 / 1e8,
        "pay": l.pay,
        "outpoint": { "txid": l.txid, "vout": l.vout },
        "swap": l.swap,
        "image": l.image,
        "publishedAt": l.published_at,
        "status": l.status,
        "mine": me.is_some_and(|m| m == l.pubkey),
        "check": { "ok": ok, "reason": reason },
    })
}

/// 화면이 돌려준 ListingView → 물건. 서명이 없으니 **체인 확인 없이는 쓰지 않는다.**
fn listing_from_view(v: &Value) -> Result<Listing, String> {
    let s = |k: &str| v.get(k).and_then(Value::as_str).unwrap_or("").to_string();
    let txid = v["outpoint"]["txid"].as_str().unwrap_or("").to_string();
    let vout = v["outpoint"]["vout"].as_u64().ok_or("동전 번호가 없습니다.")?;
    if !is_txid(&txid) {
        return Err("동전 번호가 올바르지 않습니다.".into());
    }
    let price = v.get("priceRvn").and_then(Value::as_f64).filter(|p| p.is_finite() && *p > 0.0).ok_or("값이 없습니다.")?;
    let amount = v.get("amount").and_then(Value::as_f64).filter(|a| a.is_finite() && *a > 0.0).ok_or("수량이 없습니다.")?;
    let swap = s("swap");
    if !is_hex(&swap) || swap.len() > MAX_VALUE {
        return Err("교환 글자가 올바르지 않습니다.".into());
    }
    let asset = s("asset");
    let pay = s("pay");
    if asset.is_empty() || pay.is_empty() {
        return Err("자산 이름이나 받는 주소가 없습니다.".into());
    }
    Ok(Listing {
        d: d_of(&txid, vout),
        pubkey: s("pubkey"),
        event_id: s("eventId"),
        title: s("title"),
        summary: s("summary"),
        content: String::new(),
        category: s("category"),
        asset,
        amount,
        price_sats: sats(price),
        pay,
        txid,
        vout,
        swap,
        image: None,
        published_at: v.get("publishedAt").and_then(Value::as_i64).unwrap_or(0),
        created_at: 0,
        status: s("status"),
    })
}

/// (글쓴이, d) 마다 **가장 새 글 하나**. 같은 시각이면 id 가 작은 쪽(NIP-01).
///
/// 🔴 가장 새 글이 「취소」면 그 물건은 취소다. 옛 「판매 중」 글로 되돌아가지 않는다.
pub(crate) fn newest_per_d(events: Vec<Value>) -> Vec<Value> {
    let mut best: std::collections::HashMap<(String, String), Value> = std::collections::HashMap::new();
    for e in events {
        let pk = e.get("pubkey").and_then(Value::as_str).unwrap_or("").to_string();
        let Some(d) = e
            .get("tags")
            .and_then(Value::as_array)
            .and_then(|t| tag_at(t, "d", 1))
            .map(str::to_string)
        else {
            continue;
        };
        let at = e.get("created_at").and_then(Value::as_i64).unwrap_or(0);
        let id = e.get("id").and_then(Value::as_str).unwrap_or("").to_string();
        let key = (pk, d);
        let replace = match best.get(&key) {
            None => true,
            Some(o) => {
                let oat = o.get("created_at").and_then(Value::as_i64).unwrap_or(0);
                let oid = o.get("id").and_then(Value::as_str).unwrap_or("");
                at > oat || (at == oat && id.as_str() < oid)
            }
        };
        if replace {
            best.insert(key, e);
        }
    }
    let mut out: Vec<Value> = best.into_values().collect();
    out.sort_by_key(|e| -e.get("created_at").and_then(Value::as_i64).unwrap_or(0));
    out
}

/// 글쓴이 **자신이** 지워 달라고 한 글인가(NIP-09). 남이 보낸 지움 요청은 무시한다.
pub(crate) fn is_deleted(ev: &Value, deletions: &[Value]) -> bool {
    let id = ev.get("id").and_then(Value::as_str).unwrap_or("");
    let pk = ev.get("pubkey").and_then(Value::as_str).unwrap_or("");
    let at = ev.get("created_at").and_then(Value::as_i64).unwrap_or(0);
    let d = ev.get("tags").and_then(Value::as_array).and_then(|t| tag_at(t, "d", 1)).unwrap_or("");
    let a = format!("{KIND_LISTING}:{pk}:{d}");
    deletions.iter().any(|del| {
        del.get("kind").and_then(Value::as_i64) == Some(KIND_DELETE)
            && del.get("pubkey").and_then(Value::as_str) == Some(pk)
            && del.get("tags").and_then(Value::as_array).is_some_and(|tags| {
                tags.iter().filter_map(Value::as_array).any(|t| {
                    let name = t.first().and_then(Value::as_str);
                    let val = t.get(1).and_then(Value::as_str);
                    (name == Some("e") && val == Some(id))
                        || (name == Some("a")
                            && val == Some(a.as_str())
                            && del.get("created_at").and_then(Value::as_i64).unwrap_or(0) >= at)
                })
            })
    })
}

/// 둘러보기 목록 고르기(체인 확인 전). 서명 확인 → 가장 새 글 → 지움·비활성 제외 → 분류.
pub(crate) fn select_browse(events: Vec<Value>, deletions: &[Value], category: Option<&str>, limit: usize) -> Vec<Listing> {
    let verified: Vec<Value> = events.into_iter().filter(crate::relay::verify).collect();
    newest_per_d(verified)
        .into_iter()
        .filter(|e| !is_deleted(e, deletions))
        .filter_map(|e| parse_listing(&e).ok())
        .filter(|l| l.status == "active")
        .filter(|l| category.is_none_or(|c| l.category == c))
        .take(limit)
        .collect()
}

fn my_pubkey_on_disk() -> Option<String> {
    crate::talk::key_on_disk().and_then(|(sk, _, _)| crate::shopkey::pubkey_of(&sk).ok())
}

async fn validate_address_mine(addr: &str) -> Result<(), String> {
    let v = call_rpc("validateaddress", json!([addr])).await?;
    if v["isvalid"].as_bool() != Some(true) || v["ismine"].as_bool() != Some(true) {
        return Err("이 주소는 내 지갑의 주소가 아닙니다.".into());
    }
    Ok(())
}

/// 그 동전이 **내 지갑의** 자산 묶음인가.
async fn outpoint_is_mine(asset: &str, txid: &str, vout: u64) -> Result<bool, String> {
    let v = call_rpc("listmyassets", json!([asset, true])).await?;
    Ok(v.get(asset)
        .and_then(|e| e.get("outpoints"))
        .and_then(Value::as_array)
        .is_some_and(|outs| outs.iter().any(|o| o["txid"].as_str() == Some(txid) && o["vout"].as_u64() == Some(vout))))
}

/// 내 물건 글 전부(어떤 상태든). 서명이 맞고 내 열쇠가 쓴 것만.
async fn my_listing_events(me: &str) -> Result<Vec<Value>, String> {
    let r = crate::nostrpub::nostr_query(vec![KIND_LISTING], vec![me.to_string()], vec![]).await?;
    Ok(r["events"]
        .as_array()
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .filter(|e| e.get("pubkey").and_then(Value::as_str) == Some(me) && crate::relay::verify(e))
        .collect())
}

// ─────────────────────────────────────────────────────────────────────
// 명령
// ─────────────────────────────────────────────────────────────────────

/// 판매 글 올리기. `swap_offer` 가 돌려준 hex 를 받는다. **사람이 누를 때만.**
///
/// 올리기 전에 사는 쪽과 **같은 확인**을 다 하고, 더해서 받는 주소·동전이
/// 내 지갑의 것인지 본다. 그 뒤 서명 → `validate_publish_event` → 올리기.
#[tauri::command]
pub async fn market_publish_listing(
    offer_hex: String,
    title: String,
    summary: String,
    category: String,
    image: Option<String>,
) -> Result<Value, String> {
    let offer_hex = offer_hex.trim().to_ascii_lowercase();
    if !is_hex(&offer_hex) || offer_hex.len() > MAX_VALUE {
        return Err("교환 글자가 올바르지 않거나 너무 깁니다.".into());
    }
    let title = clean_line(&title, "제목", MAX_TITLE_CHARS, true)?;
    let summary = clean_line(&summary, "설명", MAX_SUMMARY_CHARS, false)?;
    let category = clean_category(&category)?;
    let image = clean_image(image)?;

    // 체인에 묻는다 — 내 글이라도 글자를 믿지 않는다.
    let dec = call_rpc("decoderawtransaction", json!([offer_hex.clone()])).await?;
    let info = crate::swap::swap_check_at(offer_hex.clone(), None).await?;
    if !info["ok"].as_bool().unwrap_or(false) {
        return Err(info["why"].as_str().unwrap_or("쓸 수 없는 제안입니다.").to_string());
    }
    let pay = info["seller"].as_str().unwrap_or("").to_string();
    let price = info["price"].as_f64().unwrap_or(0.0);
    // 🔴 0번 출력이 내 주소·내 값인가 — swap_offer 가 서명 전에 한 확인을 한 번 더.
    crate::swap::offer_shape_ok(&dec, &pay, price)?;
    validate_address_mine(&pay).await?;
    let txid = info["txid"].as_str().unwrap_or("").to_string();
    let vout = info["vout"].as_u64().unwrap_or(0);
    let asset = info["asset"].as_str().unwrap_or("").to_string();
    let amount = info["amount"].as_f64().unwrap_or(0.0);
    if !outpoint_is_mine(&asset, &txid, vout).await? {
        return Err("이 교환 글자가 쓰는 동전은 내 지갑의 것이 아닙니다.".into());
    }

    let sk = crate::talk::signing_key()?;
    let me = crate::shopkey::pubkey_of(&sk)?;
    let at = now();
    let mut l = Listing {
        d: d_of(&txid, vout),
        pubkey: me.clone(),
        event_id: String::new(),
        title,
        summary: summary.clone(),
        content: summary,
        category,
        asset,
        amount,
        price_sats: sats(price),
        pay,
        txid,
        vout,
        swap: offer_hex,
        image,
        published_at: at,
        created_at: at,
        status: "active".into(),
    };
    // 사는 쪽이 할 확인을 내 글에도 똑같이 — 글로 만든 뒤 다시 읽어 맞춰 본다.
    check_decoded(&l, &dec)?;
    check_chain_info(&l, &info)?;

    let ev = crate::shopkey::sign_with(&sk, KIND_LISTING, build_tags(&l), &l.content, at)?;
    let back = parse_listing(&ev)?;
    check_decoded(&back, &dec)?;
    crate::nostrpub::validate_publish_event(&ev)?;
    crate::nostrpub::nostr_publish(ev.clone()).await?;
    l.event_id = ev["id"].as_str().unwrap_or("").to_string();
    Ok(json!({
        "eventId": l.event_id,
        "d": l.d,
        "listing": view(&l, Some(&me), Some(Ok(()))),
    }))
}

/// 장터 둘러보기. 판매 중인 것만, 글쓴이·물건마다 가장 새 글 하나, 지운 것 제외.
///
/// 체인 확인은 **최대 30개**만 한다(그 이상은 안 돌려준다). 확인에 실패한 것도
/// `check.ok=false` + 이유를 달아 **돌려준다** — 화면이 흐리게 보여 주고 사기
/// 단추를 끈다. 사라지면 「왜 없지」가 되고, 흐리면 「팔렸구나」가 된다.
#[tauri::command]
pub async fn market_browse(category: Option<String>, limit: Option<u32>) -> Result<Value, String> {
    let category = match category.map(|c| c.trim().to_string()).filter(|c| !c.is_empty()) {
        Some(c) => Some(clean_category(&c)?),
        None => None,
    };
    let limit = limit.unwrap_or(MAX_CHECK as u32).clamp(1, MAX_CHECK as u32) as usize;
    let events = crate::nostrpub::nostr_query_tag(vec![KIND_LISTING], "t".into(), vec![SWAP_TAG.into()], 200).await?;

    // 지움 요청은 글쓴이별로 묻는다(한 번에 10명씩, 최대 30명).
    let mut authors: Vec<String> = Vec::new();
    for e in &events {
        if let Some(pk) = e.get("pubkey").and_then(Value::as_str) {
            if !authors.iter().any(|a| a == pk) && authors.len() < 30 {
                authors.push(pk.to_string());
            }
        }
    }
    use futures_util::future::join_all;
    let dels = join_all(
        authors
            .chunks(10)
            .map(|c| crate::nostrpub::nostr_query(vec![KIND_DELETE], c.to_vec(), vec![])),
    )
    .await;
    let deletions: Vec<Value> = dels
        .into_iter()
        .filter_map(Result::ok)
        .flat_map(|v| v["events"].as_array().cloned().unwrap_or_default())
        .filter(crate::relay::verify)
        .collect();

    let picked = select_browse(events, &deletions, category.as_deref(), limit);
    let me = my_pubkey_on_disk();
    let checks = join_all(picked.iter().map(chain_check)).await;
    let out: Vec<Value> = picked
        .iter()
        .zip(checks)
        .map(|(l, c)| view(l, me.as_deref(), Some(c.map(|_| ()))))
        .collect();
    Ok(json!(out))
}

/// 내가 올린 물건 전부(판매 중·팔림·취소). 판매 중인 것만 체인에 확인한다.
#[tauri::command]
pub async fn market_my_listings() -> Result<Value, String> {
    let Some(me) = my_pubkey_on_disk() else {
        return Ok(json!([]));
    };
    let events = my_listing_events(&me).await?;
    let mine: Vec<Listing> = newest_per_d(events)
        .into_iter()
        .filter_map(|e| parse_listing(&e).ok())
        .take(MAX_CHECK)
        .collect();
    use futures_util::future::join_all;
    let checks = join_all(mine.iter().map(|l| async move {
        if l.status == "active" {
            Some(chain_check(l).await.map(|_| ()))
        } else {
            None
        }
    }))
    .await;
    // 판매 중인데 체인 확인이 안 되는 글: 그 동전을 쓴 거래가 값을 pay 로 냈으면 「팔렸음」 글로 바꾼다(글만 — 돈은 안 움직인다).
    let mut sold: Vec<String> = Vec::new();
    for (l, c) in mine.iter().zip(checks.iter()) {
        if matches!(c, Some(Err(_))) && settle_if_sold(l).await.unwrap_or(false) {
            sold.push(l.d.clone());
        }
    }
    let mut out: Vec<Value> = Vec::new();
    for (l, c) in mine.iter().zip(checks) {
        let mut v = view(l, Some(&me), c.clone());
        if sold.contains(&l.d) {
            v["status"] = json!("sold");
            crate::wallet_link::note_sold(&l.d).await;
        }
        if c.is_none() || sold.contains(&l.d) {
            v["check"] = json!({ "ok": false, "reason": "판매 중이 아닙니다." });
        }
        out.push(v);
    }
    Ok(json!(out))
}

// ── 팔렸음(파는 쪽이 저절로 — 돈은 안 움직이고 내 글만 다시 올린다) ─────────────

/// 팔린 거래인가: 글의 동전을 쓰고, 글의 값을 자산 없이 글의 pay 주소 하나로 낸다.
pub(crate) fn sold_by(dec: &Value, l: &Listing) -> bool {
    let spends = dec["vin"].as_array().is_some_and(|v| {
        v.iter().any(|i| i["txid"].as_str() == Some(l.txid.as_str()) && i["vout"].as_u64() == Some(l.vout))
    });
    let pays = dec["vout"].as_array().is_some_and(|v| {
        v.iter().any(|o| {
            let sp = &o["scriptPubKey"];
            sats(o["value"].as_f64().unwrap_or(-1.0)) == l.price_sats
                && sp["asset"].is_null()
                && sp["addresses"].as_array().is_some_and(|a| a.len() == 1 && a[0].as_str() == Some(l.pay.as_str()))
        })
    });
    spends && pays
}

/// 그 동전이 쓰였으면, pay 주소로 들어온 **확인된** 거래 중 그것을 판 거래를 찾는다(내 지갑 기록만 읽는다).
async fn find_sale(l: &Listing) -> Result<Option<String>, String> {
    if !call_rpc("gettxout", json!([l.txid.clone(), l.vout, true])).await?.is_null() {
        return Ok(None);
    }
    let rows = call_rpc("listreceivedbyaddress", json!([1, false, true])).await?;
    let txids: Vec<String> = rows
        .as_array()
        .and_then(|r| r.iter().find(|x| x["address"].as_str() == Some(l.pay.as_str())))
        .and_then(|x| x["txids"].as_array())
        .map(|t| t.iter().filter_map(Value::as_str).filter(|t| is_txid(t)).take(20).map(str::to_string).collect())
        .unwrap_or_default();
    for t in txids {
        let Ok(tx) = call_rpc("gettransaction", json!([t.clone()])).await else { continue };
        let Some(hex) = tx["hex"].as_str() else { continue };
        let Ok(dec) = call_rpc("decoderawtransaction", json!([hex])).await else { continue };
        if sold_by(&dec, l) {
            return Ok(Some(t));
        }
    }
    Ok(None)
}

/// 판매 중 글이 실제로 팔렸으면 같은 이야기 열쇠로 「sold」 글을 다시 올린다. 돌려주는 값 = 팔렸나.
/// 🔴 서명하는 것은 내 글(공개)뿐이다. 지갑을 열지 않고, 거래를 만들거나 보내지 않는다.
pub(crate) async fn settle_if_sold(l: &Listing) -> Result<bool, String> {
    if l.status == "sold" {
        return Ok(true);
    }
    if l.status != "active" || find_sale(l).await?.is_none() {
        return Ok(false);
    }
    let sk = crate::talk::signing_key()?;
    if crate::shopkey::pubkey_of(&sk)? != l.pubkey {
        return Err("내 글이 아니라 「팔렸음」으로 바꾸지 않았습니다.".into());
    }
    let mut x = l.clone();
    x.status = "sold".into();
    let at = now().max(l.created_at + 1);
    let ev = crate::shopkey::sign_with(&sk, KIND_LISTING, build_tags(&x), &x.content, at)?;
    crate::nostrpub::validate_publish_event(&ev)?;
    crate::nostrpub::nostr_publish(ev).await?;
    Ok(true)
}

/// 폰 판매 일(`wallet_link/sell.rs`)이 묻는 입구: 내 그 물건(d)의 지금 상태. 팔렸으면 「sold」 글로 바꾼 뒤 "sold".
/// None = 릴레이에서 그 글을 못 찾음.
pub(crate) async fn settle_d(d: &str) -> Result<Option<String>, String> {
    let Some(me) = my_pubkey_on_disk() else {
        return Ok(None);
    };
    let events = my_listing_events(&me).await?;
    let same: Vec<Value> = events
        .into_iter()
        .filter(|e| e.get("tags").and_then(Value::as_array).and_then(|t| tag_at(t, "d", 1)) == Some(d))
        .collect();
    let Some(l) = newest_per_d(same).into_iter().next().and_then(|e| parse_listing(&e).ok()) else {
        return Ok(None);
    };
    if l.status == "active" && settle_if_sold(&l).await? {
        return Ok(Some("sold".into()));
    }
    Ok(Some(l.status))
}

/// 판매 내리기. **동전을 내 새 주소로 옮겨** 남이 가진 교환 글자를 못 쓰게 만든 뒤,
/// 「취소」 글을 다시 올리고 옛 글의 지움 요청(kind 5)을 보낸다.
///
/// 🔴 글만 내리면 안 된다. 교환 글자는 이미 누군가 받아 갔을 수 있고, 그 글자는
///    동전이 그 자리에 있는 한 **언제든 완성된다.** 동전을 옮겨야 진짜로 내려간다.
///
/// ⚠️ `swap_make_lot` 처럼 정확한 수량을 내 새 주소로 보내되, `transfer` 는 어느
///    동전을 쓸지 노드가 고르므로 **이 동전을 콕 집어** 쓰는 raw 거래로 만든다.
///    이미 쓰인 동전이면 체인 일은 건너뛰고 「취소」 글만 올린다.
#[tauri::command]
pub async fn market_cancel_listing(d: String, passphrase: Option<String>) -> Result<Value, String> {
    let d = d.trim().to_string();
    if !d.starts_with(D_PREFIX) || d.len() > MAX_VALUE {
        return Err("물건 이름이 올바르지 않습니다.".into());
    }
    let sk = crate::talk::signing_key()?;
    let me = crate::shopkey::pubkey_of(&sk)?;
    let events = my_listing_events(&me).await?;
    let same_d: Vec<Value> = events
        .into_iter()
        .filter(|e| e.get("tags").and_then(Value::as_array).and_then(|t| tag_at(t, "d", 1)) == Some(d.as_str()))
        .collect();
    let latest = newest_per_d(same_d.clone())
        .into_iter()
        .next()
        .ok_or("내가 올린 그 물건 글을 릴레이에서 찾지 못했습니다.")?;
    let mut l = parse_listing(&latest)?;

    // ── 체인: 동전 옮기기 ────────────────────────────────────────
    let utxo = call_rpc("gettxout", json!([l.txid.clone(), l.vout, true])).await?;
    let txid = if utxo.is_null() {
        None
    } else {
        Some(move_lot_home(&l, &utxo, passphrase).await?)
    };

    // ── 릴레이: 취소 글 + 옛 글 지움 요청 ───────────────────────────
    l.status = "cancelled".into();
    let at = now().max(l.created_at + 1);
    let ev = crate::shopkey::sign_with(&sk, KIND_LISTING, build_tags(&l), &l.content, at)?;
    crate::nostrpub::validate_publish_event(&ev)?;
    let mut warn: Vec<String> = Vec::new();
    let event_id = match crate::nostrpub::nostr_publish(ev.clone()).await {
        Ok(_) => Some(ev["id"].as_str().unwrap_or("").to_string()),
        Err(e) => {
            warn.push(format!("취소 글을 올리지 못했습니다: {e}"));
            None
        }
    };
    // 옛 「판매 중」 글들만 지워 달라고 한다(e 태그). a 태그를 쓰면 방금 올린 취소 글까지 지워진다.
    let mut tags: Vec<Value> = same_d
        .iter()
        .filter(|e| parse_listing(e).map(|x| x.status != "cancelled").unwrap_or(true))
        .filter_map(|e| e.get("id").and_then(Value::as_str))
        .take(8)
        .map(|id| json!(["e", id]))
        .collect();
    let mut delete_id = Value::Null;
    if !tags.is_empty() {
        tags.push(json!(["t", "ravencoin"]));
        let del = crate::shopkey::sign_with(&sk, KIND_DELETE, Value::Array(tags), "", at)?;
        match crate::nostrpub::nostr_publish(del.clone()).await {
            Ok(_) => delete_id = del["id"].clone(),
            Err(e) => warn.push(format!("지움 요청을 보내지 못했습니다: {e}")),
        }
    }
    Ok(json!({
        "txid": txid,
        "eventId": event_id,
        "deleteId": delete_id,
        "alreadySpent": txid.is_none(),
        "warn": if warn.is_empty() { Value::Null } else { json!(warn.join(" ")) },
    }))
}

/// 그 동전 하나를 콕 집어 내 새 주소로 옮긴다(수량 그대로). 수수료는 내 RVN 에서.
async fn move_lot_home(l: &Listing, utxo: &Value, passphrase: Option<String>) -> Result<String, String> {
    let spk = &utxo["scriptPubKey"];
    let asset = spk["asset"]["name"].as_str().or_else(|| spk["asset"]["asset_name"].as_str()).unwrap_or("");
    let amount = spk["asset"]["amount"].as_f64().unwrap_or(0.0);
    if asset != l.asset || !same_amount(amount, l.amount) {
        return Err("체인의 동전이 글과 다릅니다. 아무것도 옮기지 않았습니다.".into());
    }
    if !outpoint_is_mine(&l.asset, &l.txid, l.vout).await? {
        return Err("이 동전은 내 지갑의 것이 아닙니다. 아무것도 옮기지 않았습니다.".into());
    }
    let was = crate::swap::unlock_for(passphrase).await?;
    let r = move_lot_inner(l).await;
    crate::swap::relock_for(was).await;
    r
}

async fn move_lot_inner(l: &Listing) -> Result<String, String> {
    let fee = crate::swap::FEE;
    let new_addr = || async {
        call_rpc("getnewaddress", json!([]))
            .await
            .map(|v| v.as_str().unwrap_or_default().to_string())
    };
    let to = new_addr().await?;
    let change_to = new_addr().await?;
    if to.is_empty() || change_to.is_empty() {
        return Err("받을 주소를 만들지 못했습니다.".into());
    }
    validate_address_mine(&to).await?;
    validate_address_mine(&change_to).await?;

    let unspent = call_rpc("listunspent", json!([1])).await?;
    let mut rvn: Vec<Value> = unspent
        .as_array()
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .filter(|u| u["assetName"].is_null() || u["assetName"].as_str() == Some("RVN"))
        .collect();
    rvn.sort_by(|a, b| {
        b["amount"].as_f64().unwrap_or(0.0).partial_cmp(&a["amount"].as_f64().unwrap_or(0.0)).unwrap_or(std::cmp::Ordering::Equal)
    });
    let mut picked: Vec<Value> = Vec::new();
    let mut got = 0.0;
    for u in rvn {
        got += u["amount"].as_f64().unwrap_or(0.0);
        picked.push(u);
        if got >= fee {
            break;
        }
    }
    if got < fee {
        return Err(format!("수수료로 쓸 RVN 이 모자랍니다({fee} RVN 필요)."));
    }
    let mut ins = vec![json!({ "txid": l.txid, "vout": l.vout })];
    for u in &picked {
        ins.push(json!({ "txid": u["txid"], "vout": u["vout"] }));
    }
    let change = ((got - fee) * 1e8).round() / 1e8;
    let mut outs = serde_json::Map::new();
    outs.insert(to.clone(), json!({ "transfer": { l.asset.clone(): l.amount } }));
    if change > 0.0001 {
        outs.insert(change_to.clone(), json!(change));
    }
    let raw = call_rpc("createrawtransaction", json!([ins, Value::Object(outs)])).await?;
    let raw = raw.as_str().unwrap_or_default().to_string();
    let dec = call_rpc("decoderawtransaction", json!([raw.clone()])).await?;
    check_cancel_shape(&dec, l, &to, &change_to)?;
    let signed = call_rpc("signrawtransaction", json!([raw])).await?;
    if signed["complete"].as_bool() != Some(true) {
        return Err("서명을 끝내지 못했습니다. 지갑이 잠겨 있는지 확인해 주세요.".into());
    }
    let hex = signed["hex"].as_str().unwrap_or_default().to_string();
    let txid = call_rpc("sendrawtransaction", json!([hex])).await?;
    let txid = txid.as_str().unwrap_or_default().to_string();
    crate::refund::remember_ours(&txid);
    Ok(txid)
}

/// 내리기 거래가 그 동전을 쓰고, 자산을 **딱 그 수량** 내 새 주소로, 나머지는 거스름돈으로만 보내는가.
pub(crate) fn check_cancel_shape(dec: &Value, l: &Listing, to: &str, change_to: &str) -> Result<(), String> {
    let vin = dec["vin"].as_array().cloned().unwrap_or_default();
    if !vin.iter().any(|i| i["txid"].as_str() == Some(l.txid.as_str()) && i["vout"].as_u64() == Some(l.vout)) {
        return Err("내리기 거래가 그 동전을 쓰지 않습니다 — 보내지 않았습니다.".into());
    }
    let vout = dec["vout"].as_array().cloned().unwrap_or_default();
    let mut asset_ok = false;
    for o in &vout {
        let sp = &o["scriptPubKey"];
        let addrs: Vec<&str> = sp["addresses"].as_array().map(|a| a.iter().filter_map(Value::as_str).collect()).unwrap_or_default();
        if addrs.is_empty() || addrs.iter().any(|a| *a != to && *a != change_to) {
            return Err("내리기 거래에 내 주소가 아닌 출력이 있습니다 — 보내지 않았습니다.".into());
        }
        if !sp["asset"].is_null() {
            let name = sp["asset"]["name"].as_str().or_else(|| sp["asset"]["asset_name"].as_str());
            if name == Some(l.asset.as_str()) && same_amount(sp["asset"]["amount"].as_f64().unwrap_or(0.0), l.amount) && addrs == [to] {
                asset_ok = true;
            } else {
                return Err("내리기 거래의 자산 출력이 다릅니다 — 보내지 않았습니다.".into());
            }
        }
    }
    if !asset_ok {
        return Err("내리기 거래에 자산 출력이 없습니다 — 보내지 않았습니다.".into());
    }
    Ok(())
}

/// 장터 물건 사기. 다시 확인한 뒤 **기존 `swap_take` 를 그대로** 부른다.
///
/// `listing` 은 ListingView(둘러보기 결과) 또는 릴레이 원본 글이다. 원본 글이면
/// 서명까지 본다. 어느 쪽이든 체인 확인을 다시 한다 — 화면이 넘긴 숫자를 믿지 않는다.
/// broadcast=false 는 미리보기(보내지 않음), true 는 사람이 누른 단추에서만.
#[tauri::command]
pub async fn swap_take_listing(listing: Value, broadcast: bool, passphrase: Option<String>, expect: Option<Value>) -> Result<Value, String> {
    let l = if listing.get("tags").is_some() {
        if !crate::relay::verify(&listing) {
            return Err("글의 서명이 맞지 않습니다. 사지 마세요.".into());
        }
        let l = parse_listing(&listing)?;
        if l.status != "active" {
            return Err("판매 중인 물건이 아닙니다.".into());
        }
        l
    } else {
        listing_from_view(&listing)?
    };
    if my_pubkey_on_disk().is_some_and(|m| m == l.pubkey) {
        return Err("내가 올린 물건입니다. 내리려면 「판매 내리기」를 눌러 주세요.".into());
    }
    let info = chain_check(&l).await?;
    // 11-10 점검 R3: 「정말 사기」는 미리 본 거래를 새로 만든다 — 그래서 **미리 보여 준 값과 지금 값이 같을 때만** 보낸다.
    if broadcast {
        let Some(e) = expect.as_ref() else {
            return Err("미리 본 값이 없어 보내지 않았어요. 다시 「사기」를 눌러 확인해 주세요.".into());
        };
        same_as_previewed(e, &info)?;
    }
    let take = crate::swap::swap_take(l.swap.clone(), broadcast, passphrase, None).await?;
    Ok(json!({
        "listing": view(&l, None, Some(Ok(()))),
        "check": info,
        "take": take,
        "sent": take["sent"].as_bool().unwrap_or(false),
        "txid": take.get("txid").cloned().unwrap_or(Value::Null),
    }))
}

/// 내 이야기 글(kind 1). `talk_read` 와 같은 모양(원본 이벤트 배열, 최신이 위).
///
/// ⚠️ `nostr_query_authors` 는 한 사람에 **글 하나만** 남긴다(이름표용) — 그래서
///    글쓴이 전부를 돌려주는 `nostr_query` 를 쓴다(최대 200).
#[tauri::command]
pub async fn talk_my_posts(limit: Option<u32>) -> Result<Value, String> {
    let limit = limit.unwrap_or(60).clamp(1, 200) as usize;
    let Some(me) = my_pubkey_on_disk() else {
        return Ok(json!([]));
    };
    let r = crate::nostrpub::nostr_query(vec![KIND_NOTE], vec![me.clone()], vec![]).await?;
    let mut list: Vec<Value> = r["events"]
        .as_array()
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .filter(|e| {
            e.get("kind").and_then(Value::as_i64) == Some(KIND_NOTE)
                && e.get("pubkey").and_then(Value::as_str) == Some(me.as_str())
        })
        .collect();
    list.sort_by_key(|e| -e.get("created_at").and_then(Value::as_i64).unwrap_or(0));
    list.truncate(limit);
    Ok(json!(list))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::nostrpub::synthetic_signed_event;

    const TX: &str = "aa00000000000000000000000000000000000000000000000000000000000001";
    const PAY: &str = "RPayAddr1111111111111111111111111";

    fn sample() -> Listing {
        Listing {
            d: d_of(TX, 1),
            pubkey: String::new(),
            event_id: String::new(),
            title: "첫 앨범".into(),
            summary: "한정판".into(),
            content: "한정판".into(),
            category: "music".into(),
            asset: "PLAYX/ALBUM1".into(),
            amount: 1.0,
            price_sats: 250_000_000,
            pay: PAY.into(),
            txid: TX.into(),
            vout: 1,
            swap: "0200aabb".into(),
            image: Some("https://example.com/a.png".into()),
            published_at: 1_700_000_000,
            created_at: 1_700_000_000,
            status: "active".into(),
        }
    }

    fn signed(l: &Listing, key: u8) -> Value {
        synthetic_signed_event(30402, build_tags(l), &l.content, key)
    }

    fn decoded(txid: &str, vout: u64, value: f64, addr: &str) -> Value {
        json!({
            "vin": [{ "txid": txid, "vout": vout }],
            "vout": [{ "value": value, "n": 0, "scriptPubKey": { "type": "pubkeyhash", "addresses": [addr] } }],
        })
    }

    #[test]
    fn 태그를_만들고_다시_읽으면_같다() {
        let l = sample();
        let ev = signed(&l, 21);
        assert!(crate::relay::verify(&ev));
        assert_eq!(crate::nostrpub::validate_publish_event(&ev), Ok(()));
        let back = parse_listing(&ev).expect("다시 읽혀야 한다");
        assert_eq!(back.d, l.d);
        assert_eq!(back.price_sats, l.price_sats);
        assert_eq!(back.asset, l.asset);
        assert!(same_amount(back.amount, l.amount));
        assert_eq!((back.txid.as_str(), back.vout), (TX, 1));
        assert_eq!(back.pay, l.pay);
        assert_eq!(back.swap, l.swap);
        assert_eq!(back.image, l.image);
        assert_eq!(back.category, "music");
        assert_eq!(back.status, "active");
        // 웹 장터가 읽는 칸.
        let tags = ev["tags"].as_array().unwrap();
        assert_eq!(tag_at(tags, "price", 1), Some("2.50000000"));
        assert_eq!(tag_at(tags, "price", 2), Some("RVN"));
        for t in ["playx", "ravencoin", "rv-swap", "music"] {
            assert!(tags.iter().any(|x| x[0] == "t" && x[1] == t), "{t}");
        }
    }

    #[test]
    fn 값_글자() {
        assert_eq!(parse_rvn("2.5"), Some(250_000_000));
        assert_eq!(parse_rvn("2.50000000"), Some(250_000_000));
        assert_eq!(parse_rvn("0.00000001"), Some(1));
        for bad in ["", "-1", "1e3", "1.", ".5", "1.000000001", "abc", "1,5"] {
            assert_eq!(parse_rvn(bad), None, "{bad}");
        }
        assert_eq!(fmt_rvn(250_000_000), "2.50000000");
        assert_eq!(fmt_amount(5.0), "5");
        assert_eq!(fmt_amount(0.25), "0.25");
    }

    #[test]
    fn 맞는_교환_글자는_통과한다() {
        let l = sample();
        assert_eq!(check_decoded(&l, &decoded(TX, 1, 2.5, PAY)), Ok(()));
    }

    #[test]
    fn 어긋난_교환_글자는_거절한다() {
        let l = sample();
        // 값이 다르다.
        assert!(check_decoded(&l, &decoded(TX, 1, 2.4, PAY)).is_err());
        // 주소가 다르다.
        assert!(check_decoded(&l, &decoded(TX, 1, 2.5, "RSomeoneElse")).is_err());
        // 동전이 다르다(txid·vout).
        assert!(check_decoded(&l, &decoded(&TX.replace("aa", "bb"), 1, 2.5, PAY)).is_err());
        assert!(check_decoded(&l, &decoded(TX, 0, 2.5, PAY)).is_err());
        // 입력이 더 있다.
        let mut extra = decoded(TX, 1, 2.5, PAY);
        extra["vin"].as_array_mut().unwrap().push(json!({ "txid": TX, "vout": 2 }));
        assert!(check_decoded(&l, &extra).is_err());
        // 출력이 더 있다.
        let mut extra = decoded(TX, 1, 2.5, PAY);
        extra["vout"].as_array_mut().unwrap().push(json!({ "value": 1.0, "scriptPubKey": { "addresses": [PAY] } }));
        assert!(check_decoded(&l, &extra).is_err());
        // 0번 출력에 자산이 붙었다.
        let mut asset = decoded(TX, 1, 2.5, PAY);
        asset["vout"][0]["scriptPubKey"]["asset"] = json!({ "name": "X", "amount": 1 });
        assert!(check_decoded(&l, &asset).is_err());
    }

    #[test]
    fn 체인_답이_글과_다르면_거절한다() {
        let l = sample();
        let good = json!({ "ok": true, "asset": "PLAYX/ALBUM1", "amount": 1.0, "price": 2.5, "seller": PAY, "txid": TX, "vout": 1 });
        assert_eq!(check_chain_info(&l, &good), Ok(()));
        let mut b = good.clone(); b["amount"] = json!(2.0); assert!(check_chain_info(&l, &b).is_err());
        let mut b = good.clone(); b["asset"] = json!("OTHER"); assert!(check_chain_info(&l, &b).is_err());
        let mut b = good.clone(); b["price"] = json!(1.0); assert!(check_chain_info(&l, &b).is_err());
        let mut b = good.clone(); b["seller"] = json!("RX"); assert!(check_chain_info(&l, &b).is_err());
        let mut b = good.clone(); b["vout"] = json!(0); assert!(check_chain_info(&l, &b).is_err());
        let sold = json!({ "ok": false, "why": "이 제안은 이미 팔렸거나 취소됐습니다." });
        assert_eq!(check_chain_info(&l, &sold), Err("이 제안은 이미 팔렸거나 취소됐습니다.".into()));
    }

    #[test]
    fn 글_모양이_틀리면_못_읽는다() {
        let base = sample();
        let mut l = base.clone(); l.d = d_of(TX, 2); assert!(parse_listing(&signed(&l, 21)).is_err(), "d 와 outpoint 불일치");
        let mut l = base.clone(); l.swap = "zz".into(); assert!(parse_listing(&signed(&l, 21)).is_err());
        let mut l = base.clone(); l.category = "weapon".into(); assert!(parse_listing(&signed(&l, 21)).is_err());
        let mut l = base.clone(); l.status = "maybe".into(); assert!(parse_listing(&signed(&l, 21)).is_err());
        let mut l = base.clone(); l.title = "x".repeat(MAX_VALUE + 1); assert!(parse_listing(&signed(&l, 21)).is_err());
        let mut l = base.clone(); l.price_sats = 0; assert!(parse_listing(&signed(&l, 21)).is_err());
        // rv-swap 표가 없는 일반 물건.
        let plain = crate::nostrpub::synthetic_product("x", 21);
        assert!(parse_listing(&plain).is_err());
    }

    #[test]
    fn 분류는_정해진_것만() {
        for c in CATEGORIES { assert_eq!(clean_category(c), Ok(c.to_string())); }
        assert_eq!(clean_category(" Music "), Ok("music".into()));
        for bad in ["", "weapon", "musics", "음악"] { assert!(clean_category(bad).is_err(), "{bad}"); }
    }

    #[test]
    fn 글자_길이와_사진_주소() {
        assert!(clean_line(&"가".repeat(MAX_TITLE_CHARS), "제목", MAX_TITLE_CHARS, true).is_ok());
        assert!(clean_line(&"가".repeat(MAX_TITLE_CHARS + 1), "제목", MAX_TITLE_CHARS, true).is_err());
        assert!(clean_line("  ", "제목", MAX_TITLE_CHARS, true).is_err());
        assert!(clean_line("a\nb", "제목", MAX_TITLE_CHARS, true).is_err());
        // 바이트로도 1024 를 넘지 않는다(한글 3바이트 × 341 = 1023).
        assert!(clean_line(&"가".repeat(342), "x", 1000, true).is_err());
        assert_eq!(clean_image(None), Ok(None));
        assert_eq!(clean_image(Some("https://a.b/c.png".into())), Ok(Some("https://a.b/c.png".into())));
        assert!(clean_image(Some("ipfs://Qm1".into())).unwrap().is_some());
        for bad in ["javascript:alert(1)", "data:image/png;base64,AA", "http://a.b/c", "https://a b"] {
            assert!(clean_image(Some(bad.into())).is_err(), "{bad}");
        }
        assert!(clean_image(Some(format!("https://{}", "a".repeat(MAX_VALUE)))).is_err());
        // 만들어진 태그 값은 모두 1024 이하.
        let ev = signed(&sample(), 21);
        for t in ev["tags"].as_array().unwrap() {
            for x in t.as_array().unwrap() { assert!(x.as_str().unwrap().len() <= MAX_VALUE); }
        }
    }

    #[test]
    fn 가장_새_글_하나와_상태로_거른다() {
        let mut a = sample();
        let old = signed(&a, 21);
        // 같은 d 를 1초 뒤에 취소로.
        a.status = "cancelled".into();
        let mut newer = signed(&a, 21);
        // 시각만 바꾸면 서명이 깨지므로, 새 글은 created_at 을 키운 뒤 다시 서명한다.
        let at = newer["created_at"].as_i64().unwrap() + 1;
        let sk = [21u8; 32];
        newer = crate::shopkey::sign_with(&sk, 30402, build_tags(&a), &a.content, at).unwrap();
        let picked = newest_per_d(vec![old.clone(), newer.clone()]);
        assert_eq!(picked.len(), 1);
        assert_eq!(picked[0]["id"], newer["id"]);
        // 가장 새 글이 취소면 둘러보기에 안 나온다(옛 판매 중 글로 되돌아가지 않는다).
        assert!(select_browse(vec![old.clone(), newer], &[], None, 30).is_empty());
        // 판매 중 하나만 있으면 나온다. 분류가 다르면 안 나온다.
        assert_eq!(select_browse(vec![old.clone()], &[], None, 30).len(), 1);
        assert_eq!(select_browse(vec![old.clone()], &[], Some("music"), 30).len(), 1);
        assert!(select_browse(vec![old.clone()], &[], Some("game"), 30).is_empty());
        // 다른 사람의 같은 d 는 따로 센다.
        let other = signed(&sample(), 22);
        assert_eq!(newest_per_d(vec![old.clone(), other.clone()]).len(), 2);
        // 서명이 깨진 글은 버린다.
        let mut forged = other.clone(); forged["content"] = json!("바꿈");
        assert!(select_browse(vec![forged], &[], None, 30).is_empty());
        // 개수 상한.
        let many: Vec<Value> = (0..5u64).map(|i| { let mut l = sample(); l.vout = i; l.d = d_of(TX, i); signed(&l, 21) }).collect();
        assert_eq!(select_browse(many, &[], None, 3).len(), 3);
    }

    #[test]
    fn 글쓴이가_지운_글만_뺀다() {
        let ev = signed(&sample(), 21);
        let id = ev["id"].as_str().unwrap().to_string();
        let mine = synthetic_signed_event(5, json!([["e", id], ["t", "ravencoin"]]), "", 21);
        let theirs = synthetic_signed_event(5, json!([["e", id], ["t", "ravencoin"]]), "", 22);
        assert!(is_deleted(&ev, &[mine.clone()]));
        assert!(!is_deleted(&ev, &[theirs.clone()]), "남이 보낸 지움 요청은 무시한다");
        assert!(select_browse(vec![ev.clone()], &[mine], None, 30).is_empty());
        assert_eq!(select_browse(vec![ev], &[theirs], None, 30).len(), 1);
    }

    #[test]
    fn 내리기_거래_모양() {
        let l = sample();
        let good = json!({
            "vin": [{ "txid": TX, "vout": 1 }, { "txid": TX, "vout": 5 }],
            "vout": [
                { "value": 0, "scriptPubKey": { "addresses": ["RTo"], "asset": { "name": "PLAYX/ALBUM1", "amount": 1.0 } } },
                { "value": 0.9, "scriptPubKey": { "addresses": ["RChange"] } },
            ],
        });
        assert_eq!(check_cancel_shape(&good, &l, "RTo", "RChange"), Ok(()));
        let mut b = good.clone(); b["vin"][0]["vout"] = json!(0); assert!(check_cancel_shape(&b, &l, "RTo", "RChange").is_err());
        let mut b = good.clone(); b["vout"][1]["scriptPubKey"]["addresses"] = json!(["RThief"]); assert!(check_cancel_shape(&b, &l, "RTo", "RChange").is_err());
        let mut b = good.clone(); b["vout"][0]["scriptPubKey"]["asset"]["amount"] = json!(0.5); assert!(check_cancel_shape(&b, &l, "RTo", "RChange").is_err());
        let mut b = good.clone(); b["vout"][0]["scriptPubKey"]["addresses"] = json!(["RChange"]); assert!(check_cancel_shape(&b, &l, "RTo", "RChange").is_err());
    }

    #[test]
    fn 화면_모양() {
        let l = sample();
        let v = view(&l, Some("me"), Some(Err("팔렸습니다".into())));
        for k in ["d","pubkey","eventId","title","summary","category","asset","amount","priceRvn","pay","outpoint","swap","image","publishedAt","status","mine","check"] {
            assert!(v.get(k).is_some(), "{k}");
        }
        assert_eq!(v["check"]["ok"], json!(false));
        assert_eq!(v["priceRvn"], json!(2.5));
        // 화면이 돌려준 모양을 다시 물건으로 읽을 수 있다(체인 확인용).
        let back = listing_from_view(&v).unwrap();
        assert_eq!((back.price_sats, back.txid.as_str(), back.vout, back.pay.as_str()), (l.price_sats, TX, 1, PAY));
    }

    fn body_of(name: &str) -> String {
        let src = include_str!("market_listing.rs");
        let end = src.find("#[cfg(test)]").unwrap_or(src.len());
        let src = &src[..end];
        let i = src.find(name).unwrap_or_else(|| panic!("{name} 가 있어야 한다"));
        let rest = &src[i + name.len()..];
        let j = rest.find("\n#[tauri::command]").unwrap_or(rest.len());
        rest[..j].to_string()
    }

    /// 🔴 올리는 길이 **0번 출력 확인·체인 확인·중계 검사**를 다 거친다.
    #[test]
    fn 올리기는_모양_확인을_부른다() {
        let b = body_of("pub async fn market_publish_listing");
        for must in ["swap_check_at(", "offer_shape_ok(&dec", "check_decoded(", "check_chain_info(", "validate_publish_event(", "outpoint_is_mine(", "validate_address_mine("] {
            assert!(b.contains(must), "올리기에 {must} 가 없다");
        }
        assert!(!b.contains("sendrawtransaction") && !b.contains("swap_take("), "올리기는 돈을 움직이지 않는다");
    }

    /// 사기 전에 반드시 체인 확인 → 그다음에야 기존 swap_take.
    #[test]
    fn 사기는_체인_확인_뒤에_swap_take() {
        let b = body_of("pub async fn swap_take_listing");
        let c = b.find("chain_check(&l)").expect("체인 확인이 있어야 한다");
        let t = b.find("swap::swap_take(").expect("swap_take 를 불러야 한다");
        assert!(c < t, "체인 확인이 사기보다 먼저여야 한다");
        assert!(b.contains("swap_take(l.swap.clone(), broadcast, passphrase, None)"), "방송 여부는 부른 사람이 정한다");
    }

    /// 11-10: 미리 본 값과 다르면 보내지 않는다.
    #[test]
    fn 미리_본_값과_다르면_안_보낸다() {
        let info = json!({ "asset": "CAT", "amount": 1.0, "price": 10.0, "fee": 0.1, "total": 10.1 });
        assert!(same_as_previewed(&info.clone(), &info).is_ok());
        let mut e = info.clone(); e["price"] = json!(10.00000001);
        assert!(same_as_previewed(&e, &info).is_err(), "값 1사토시 차이도 막는다");
        let mut e = info.clone(); e["asset"] = json!("DOG");
        assert!(same_as_previewed(&e, &info).is_err());
        let e = json!({ "asset": "CAT", "amount": 1.0 });
        assert!(same_as_previewed(&e, &info).is_err(), "값이 없으면 막는다");
        let b = body_of("pub async fn swap_take_listing");
        assert!(b.find("same_as_previewed(").unwrap() < b.find("swap::swap_take(").unwrap(), "비교가 보내기보다 먼저");
    }

    /// 둘러보기·내 목록·내 글은 서명·방송을 하지 않는다.
    #[test]
    fn 읽는_길은_돈을_안_움직인다() {
        for f in ["pub async fn market_browse", "pub async fn market_my_listings", "pub async fn talk_my_posts"] {
            let b = body_of(f);
            let b = if f.ends_with("market_my_listings") {
                // 내 목록 끝에 붙은 「팔렸음」 정리(글만 다시 올림)는 따로 본다 — 아래 시험.
                b[..b.find("// ── 팔렸음").expect("팔렸음 정리 칸")].to_string()
            } else {
                b
            };
            for bad in ["swap_take(", "sendrawtransaction", "signrawtransaction", "unlock_for(", "sign_with(", "nostr_publish("] {
                assert!(!b.contains(bad), "{f} 에 {bad} 가 있다");
            }
        }
    }

    /// 「팔렸음」 정리는 내 글만 다시 서명해 올린다 — 지갑을 열거나 거래를 만들거나 보내지 않는다.
    #[test]
    fn 팔렸음_정리는_돈을_안_움직인다() {
        let src = include_str!("market_listing.rs");
        let i = src.find("// ── 팔렸음(").unwrap();
        let j = src.find("pub(crate) async fn settle_d").unwrap();
        let b = &src[i..j];
        for bad in ["swap_take(", "sendrawtransaction", "signrawtransaction", "unlock_for(", "walletpassphrase", "createrawtransaction", "transfer"] {
            assert!(!b.contains(bad), "팔렸음 정리에 {bad} 가 있다");
        }
        assert!(b.contains("status = \"sold\""), "sold 로만 바꾼다");
    }

    #[test]
    fn 팔린_거래를_알아본다() {
        let l = sample();
        let sale = json!({
            "vin": [{ "txid": TX, "vout": 1 }, { "txid": "bb".repeat(32), "vout": 0 }],
            "vout": [
                { "value": 2.5, "scriptPubKey": { "addresses": [PAY] } },
                { "value": 0.0, "scriptPubKey": { "addresses": ["RBuyer1111111111111111111111111111"], "asset": { "name": "PLAYX/ALBUM1", "amount": 1.0 } } },
            ],
        });
        assert!(sold_by(&sale, &l));
        let mut other_coin = sale.clone();
        other_coin["vin"][0]["vout"] = json!(0);
        assert!(!sold_by(&other_coin, &l), "다른 동전을 쓴 거래");
        let mut less = sale.clone();
        less["vout"][0]["value"] = json!(2.4);
        assert!(!sold_by(&less, &l), "값이 모자람 = 내리기·다른 거래");
        let mut elsewhere = sale.clone();
        elsewhere["vout"][0]["scriptPubKey"]["addresses"] = json!(["ROther111111111111111111111111111"]);
        assert!(!sold_by(&elsewhere, &l), "pay 가 아닌 곳");
        let mut with_asset = sale.clone();
        with_asset["vout"][0]["scriptPubKey"]["asset"] = json!({ "name": "X", "amount": 1.0 });
        assert!(!sold_by(&with_asset, &l));
    }

    /// 내리기는 잠금 길을 거치고, 동전을 콕 집어 옮긴다.
    #[test]
    fn 내리기는_잠금과_모양_확인을_거친다() {
        let src = include_str!("market_listing.rs");
        let i = src.find("async fn move_lot_home").unwrap();
        let j = src.find("pub(crate) fn check_cancel_shape").unwrap();
        let b = &src[i..j];
        assert!(b.contains("unlock_for(passphrase)") && b.contains("relock_for(was)"));
        assert!(b.contains("check_cancel_shape(&dec") && b.contains("validate_address_mine(&to)"));
        let si = b.find("check_cancel_shape(&dec").unwrap();
        let ss = b.find("signrawtransaction").unwrap();
        assert!(si < ss, "모양 확인이 서명보다 먼저여야 한다");
    }
}
