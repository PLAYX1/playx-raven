//! Shops.
//!
//! A shop is an asset. Its profile — name, location, payment address, menu —
//! lives in IPFS at the hash that asset points at. There is no shop database
//! anywhere: the node already holds every asset on the chain, so the directory
//! is a query, not a service. Nothing we run can take it down.
//!
//! ## The naming convention
//!
//! Anyone can register without asking us. But "anyone can pick any name" and
//! "customers can find you" pull against each other: `listassets` filters by
//! *prefix* only (assets.cpp — a partial name followed by `*`), so with no
//! shared prefix, finding shops would mean walking every asset on the chain.
//!
//! So shops use a root asset named `SHOP.<something>`. It is a convention, not
//! a permission — we do not own the prefix and cannot refuse anyone, because
//! `SHOP.X` is a root asset that any wallet issues directly. The ~500 RVN burn
//! is the only barrier, which is small (about ₩2,000) but not nothing.

use crate::raven::call_rpc;
use serde_json::{json, Value};

/// Every shop registered on the chain.
///
/// Loads the asset list first and profiles second, because the asset list is
/// one cheap query while each profile is an IPFS fetch that may not resolve —
/// a shop whose profile has been garbage collected still exists and should
/// still be listed, marked as unreachable rather than silently dropped.
#[tauri::command]
pub async fn list_shops(count: i64, start: i64) -> Result<Value, String> {
    let raw = call_rpc("listassets", json!(["SHOP.*", true, count, start])).await?;
    let map = raw
        .as_object()
        .ok_or_else(|| "listassets did not return an object".to_string())?;

    let mut shops = Vec::with_capacity(map.len());
    for (name, data) in map {
        shops.push(json!({
            "asset": name,
            "ipfs_hash": data.get("ipfs_hash").and_then(Value::as_str).filter(|h| !h.is_empty()),
            "units": data.get("units"),
            "reissuable": data.get("reissuable"),
            // The block the shop registered in. Older is not better, but it is
            // the one durable fact about a shop that cannot be typed in.
            "block": data.get("block_height"),
        }));
    }

    shops.sort_by(|a, b| {
        a["asset"]
            .as_str()
            .unwrap_or("")
            .cmp(b["asset"].as_str().unwrap_or(""))
    });
    Ok(json!({ "shops": shops, "count": shops.len() }))
}

/// Is this shop name still free?
#[tauri::command]
pub async fn shop_name_free(name: String) -> Result<bool, String> {
    let full = normalize_shop_name(&name);
    match call_rpc("getassetdata", json!([full])).await {
        Ok(v) => Ok(v.is_null()),
        Err(e) if e.contains("not found") || e.contains("Invalid") => Ok(true),
        Err(e) => Err(e),
    }
}

/// Turns what the owner typed into the asset name the chain will accept.
///
/// Shop names are ASCII-only and upper case because the chain says so. The name
/// customers actually read is in the profile, in their own language — this
/// string is an identifier, and the UI has to say so plainly or the owner will
/// think their shop is called SHOP.GANGNAM_CAFE.
pub fn normalize_shop_name(input: &str) -> String {
    let cleaned: String = input
        .trim()
        .to_uppercase()
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '.' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect();

    if cleaned.starts_with("SHOP.") {
        cleaned
    } else {
        format!("SHOP.{cleaned}")
    }
}

#[tauri::command]
pub fn shop_asset_name(input: String) -> String {
    normalize_shop_name(&input)
}

/// Builds the profile document that lives in IPFS behind a shop asset.
///
/// Built as RIP-0014 with shop fields in `other_data`, so a wallet that knows
/// nothing about shops still shows the name, description and icon rather than
/// a blob of JSON.
///
/// `payment_address` is the one field that decides where money goes. It is
/// taken from this wallet rather than typed, so a shop cannot be set up to pay
/// someone else by a typo — and cannot be tricked into it by a bad paste.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn build_shop_profile(
    display_names: Value,
    descriptions: Value,
    payment_address: String,
    location: Option<String>,
    lat: Option<f64>,
    lon: Option<f64>,
    phone: Option<String>,
    delivery: bool,
    pickup: bool,
    menu_cid: Option<String>,
    icon: Option<String>,
    order_url: Option<String>,
) -> Value {
    let primary = display_names
        .get("en")
        .or_else(|| display_names.get("ko"))
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let primary_desc = descriptions
        .get("en")
        .or_else(|| descriptions.get("ko"))
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();

    let mut other = serde_json::Map::new();
    for (lang, v) in display_names.as_object().cloned().unwrap_or_default() {
        if let Some(s) = v.as_str().filter(|s| !s.trim().is_empty()) {
            other.insert(format!("name_{lang}"), json!(s));
        }
    }
    for (lang, v) in descriptions.as_object().cloned().unwrap_or_default() {
        if let Some(s) = v.as_str().filter(|s| !s.trim().is_empty()) {
            other.insert(format!("description_{lang}"), json!(s));
        }
    }

    other.insert("playx_shop".into(), json!(true));
    other.insert("payment_address".into(), json!(payment_address));
    other.insert("delivery".into(), json!(delivery));
    other.insert("pickup".into(), json!(pickup));
    if let Some(l) = location.filter(|s| !s.trim().is_empty()) {
        other.insert("location".into(), json!(l));
    }
    // 좌표는 손님이 거리를 보고 길을 찾는 유일한 근거다. 주소 텍스트로는
    // 그 계산을 할 수 없고, 텍스트를 좌표로 바꾸는 것은 유료 API다.
    if let (Some(la), Some(lo)) = (lat, lon) {
        other.insert("lat".into(), json!(la));
        other.insert("lon".into(), json!(lo));
    }
    if let Some(p) = phone.filter(|s| !s.trim().is_empty()) {
        other.insert("phone".into(), json!(p));
    }
    if let Some(m) = menu_cid.filter(|s| !s.trim().is_empty()) {
        other.insert("menu_cid".into(), json!(m));
    }
    // 손님이 밖에서 주문하러 갈 주소.
    //
    // 이게 없으면 가게 목록에서 가게를 찾아도 갈 데가 없다 — 이름과 좌표만
    // 보이고 주문은 못 한다. 체인에 올라가는 값이므로 자주 바뀌면 곤란한데,
    // 빠른 터널은 켤 때마다 주소가 바뀐다. 그래서 화면이 그 사실을 먼저
    // 말하고, 고정 주소가 있는 가게만 넣게 한다.
    if let Some(u) = order_url.filter(|s| {
        let t = s.trim();
        !t.is_empty() && (t.starts_with("https://") || t.starts_with("http://"))
    }) {
        other.insert("order_url".into(), json!(u.trim()));
    }

    let mut asset_data = serde_json::Map::new();
    asset_data.insert("name".into(), json!(primary));
    asset_data.insert("description".into(), json!(primary_desc));
    asset_data.insert("type".into(), json!("shop"));
    if let Some(i) = icon.filter(|s| !s.trim().is_empty()) {
        asset_data.insert("icon".into(), json!(i));
    }

    json!({
        "rip0014": {
            "metadata": {
                "asset_data": Value::Object(asset_data),
                "other_data": Value::Object(other),
            }
        }
    })
}

/// A menu: items with prices, translations, and pictures already in IPFS.
///
/// Pictures are referenced by CID, not embedded. A menu with ten photos inlined
/// is a document nobody can load on a phone; a menu of ten CIDs is a few
/// kilobytes and each picture arrives when it is looked at.
#[tauri::command]
pub fn build_menu(items: Value, currency: String) -> Value {
    json!({
        "playx_menu": {
            "version": 1,
            "currency": currency,
            "items": items,
        }
    })
}

/// Payments for orders.
///
/// Every order gets its own address, so the address *is* the order number —
/// two customers ordering the same coffee send identical amounts, and a shop
/// that tells them apart by price hands one of them the wrong bag.
///
/// Which means a shop cannot be watched through one address. What identifies an
/// order payment is the **label**: every order address is created with the
/// label `order`, and the wallet reports that label back on the incoming
/// transaction. So this filters by label, not by a single address.
///
/// `address`, when given, narrows to one specific order. Empty means "every
/// order", which is what the shop screen wants.
#[tauri::command]
pub async fn incoming_payments(address: String, min_conf: u32) -> Result<Value, String> {
    let txs = call_rpc("listtransactions", json!(["*", 100, 0, true])).await?;

    // 끊긴 노드는 이중지불을 못 본다. 그때는 금액과 무관하게 기다린다.
    let online = call_rpc("getconnectioncount", json!([]))
        .await
        .ok()
        .and_then(|v| v.as_i64())
        .map(|n| n > 0)
        .unwrap_or(false);
    // 소액 기준을 RVN 으로 환산해 둔다. 시세는 캐시되어 있어 값이 싸다.
    let small_rvn = crate::price::rvn_rate(crate::shop::currency())
        .await
        .ok()
        .and_then(|r| r["rate"].as_f64())
        .filter(|r| *r > 0.0)
        .map(|r| 30_000.0 / r)
        .unwrap_or(0.0);
    let list = txs.as_array().cloned().unwrap_or_default();

    let mut received = Vec::new();
    for tx in list {
        if tx.get("category").and_then(Value::as_str) != Some("receive") {
            continue;
        }
        if address.is_empty() {
            // No address given: show order payments only. Without this, four
            // years of old wallet activity appears as today's orders.
            let label = tx.get("label").and_then(Value::as_str).unwrap_or("");
            if label != "order" && !label.starts_with("sell:") {
                continue;
            }
        } else if tx.get("address").and_then(Value::as_str) != Some(address.as_str()) {
            continue;
        }

        let confirmations = tx.get("confirmations").and_then(Value::as_i64).unwrap_or(0);
        let rvn = tx.get("amount").and_then(Value::as_f64).unwrap_or(0.0).abs();
        let _ = small_rvn;
        // 같은 돈을 쓴 다른 거래를 우리 지갑이 본 적 있는가. 0회 확인을 받아도
        // 되는지의 유일한 실제 근거다.
        //
        // `bip125-replaceable` 은 쓰지 않는다 — rpcwallet.cpp 에서 판정 코드가
        // 주석 처리되어 있고 언제나 "no" 를 돌려준다. 믿으면 바꿔치기 가능한
        // 거래도 안전하다고 답한다.
        let conflicts = tx
            .get("walletconflicts")
            .and_then(Value::as_array)
            .map(|a| a.len())
            .unwrap_or(0);
        received.push(json!({
            "txid": tx.get("txid"),
            "address": tx.get("address"),
            "amount": tx.get("amount"),
            "asset_name": tx.get("asset_name"),
            // 어떤 주문인지 — 주소가 곧 주문번호다.
            "label": tx.get("label"),
            "time": tx.get("time"),
            "confirmations": confirmations,
            // Below the shop's own threshold this is a promise, not a payment.
            // Zero-confirmation money can be spent again by the sender.
            "settled": confirmations >= min_conf as i64,
            "conflicts": conflicts,
            // 0회로 받아도 되는 상태인가 — 멤풀에 있고, 충돌이 없다.
            "clean_unconfirmed": confirmations == 0 && conflicts == 0,
            // 지금 커피를 내줘도 되는가.
            //
            // 장사는 속도가 생명인데, 여기가 1회 확인으로 못 박혀 있어서 4,500원
            // 커피에도 블록을 기다렸다 — 평균 60초, 열에 하나는 2.3분. 카운터에
            // 줄이 서는 시간이다.
            //
            // 레이븐은 RBF 가 꺼져 있어(validation.h:163) 수수료로 바꿔치기하는
            // 공격이 안 통한다. 남는 위험은 채굴자에게 다른 거래를 직접 밀어넣는
            // 레이스뿐이고, 그건 커피값에 할 짓이 아니다. 대신 조건 셋을 모두
            // 만족해야 한다 — 소액이고, 충돌이 없고, 노드가 네트워크를 보고 있다.
            "accept_now": confirmations > 0
                || (online && conflicts == 0 && small_rvn > 0.0 && rvn <= small_rvn),
            // RIP-5 lets a transfer carry an IPFS hash, which is how a remote
            // order arrives attached to its own payment.
            "message": tx.get("message"),
        }));
    }

    Ok(json!({ "payments": received }))
}

/// Below this, an output costs more in fees than it is worth and some nodes
/// will not relay it at all. A platform fee smaller than dust is not collected
/// — sending it would make the whole payment fail.
const DUST_RVN: f64 = 0.00000546;

/// Splits a payment between the shop and the platform in one transaction.
///
/// One transaction, not two: `sendmany` either pays both or pays neither. Two
/// separate sends could leave the shop paid and the fee unsent, or worse, the
/// fee sent for an order that then failed.
///
/// The fee comes *out of* the total rather than being added on top, matching
/// how card processing already works — the customer pays the menu price, the
/// shop nets slightly less. Presenting it any other way would make our fee look
/// like a surcharge on the customer, which it is not.
#[tauri::command]
pub fn split_payment(total: f64, fee_rate: f64, fee_address: String) -> Value {
    let raw_fee = total * fee_rate;
    // RVN carries 8 decimals; anything finer is not representable and would be
    // silently rounded by the node.
    let fee = (raw_fee * 1e8).round() / 1e8;
    let collect = !fee_address.trim().is_empty() && fee >= DUST_RVN;
    let fee = if collect { fee } else { 0.0 };
    let shop = ((total - fee) * 1e8).round() / 1e8;

    json!({
        "total": total,
        "shop_gets": shop,
        "fee": fee,
        "fee_rate": fee_rate,
        "collected": collect,
        // Why nothing was taken, so the UI never shows a silent zero.
        "skip_reason": if fee_address.trim().is_empty() {
            "수수료 주소가 설정되지 않았습니다"
        } else if !collect {
            "수수료가 너무 작아 보내지 않습니다"
        } else { "" },
    })
}

/// Pays an order: the shop and, when there is one, the platform fee.
#[tauri::command]
pub async fn pay_order(
    shop_address: String,
    total: f64,
    fee_rate: f64,
    fee_address: String,
    passphrase: Option<String>,
) -> Result<Value, String> {
    if total <= 0.0 {
        return Err("결제 금액이 0보다 커야 합니다.".into());
    }
    if shop_address.trim() == fee_address.trim() {
        // sendmany keys by address, so the same address twice would silently
        // collapse into one output and lose money.
        return Err("가게 주소와 수수료 주소가 같습니다.".into());
    }

    let split = split_payment(total, fee_rate, fee_address.clone());
    let shop_gets = split["shop_gets"].as_f64().unwrap_or(0.0);
    let fee = split["fee"].as_f64().unwrap_or(0.0);

    let mut outputs = serde_json::Map::new();
    outputs.insert(shop_address.clone(), json!(shop_gets));
    if fee > 0.0 {
        outputs.insert(fee_address.clone(), json!(fee));
    }

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

    let result = call_rpc("sendmany", json!(["", Value::Object(outputs)])).await;

    if locked {
        let _ = call_rpc("walletlock", json!([])).await;
    }

    let txid = result?
        .as_str()
        .map(str::to_string)
        .ok_or_else(|| "sendmany did not return a txid".to_string())?;

    Ok(json!({ "txid": txid, "split": split }))
}

/// Broadcasts a message to everyone holding this shop's asset.
///
/// This is one-way by design of the chain: only the channel owner can send.
/// Useful for "your order is ready" and for announcements; useless for a
/// conversation, and the UI must not present it as one.
#[tauri::command]
pub async fn broadcast_message(channel: String, ipfs_hash: String) -> Result<String, String> {
    let result = call_rpc("sendmessage", json!([channel, ipfs_hash])).await?;
    Ok(result
        .as_array()
        .and_then(|a| a.first())
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string())
}

/// Where the shop's own description lives — name, menu, hours, currency.
///
/// ## Why this is a file and not a variable
///
/// The menu was held in a JavaScript array and in one `Mutex` inside the phone
/// server. Both die when the app closes. A shop that sets up its menu on
/// Monday evening and opens on Tuesday morning to an empty till is not a shop
/// that keeps using this — and there is no error to see, which is worse: it
/// looks like the app forgot on purpose.
///
/// The chain is not the answer here either. Editing a menu should never cost
/// RVN, and a price change three times a week would be three burns a week.
/// Local file, backed up with everything else.
fn shop_path() -> std::path::PathBuf {
    crate::paths::app_file("shop.json")
}

/// Reads the saved shop, or an empty one on a machine that has never sold.
#[tauri::command]
pub fn shop_load() -> Value {
    std::fs::read_to_string(shop_path())
        .ok()
        .and_then(|t| serde_json::from_str::<Value>(&t).ok())
        .unwrap_or_else(|| json!({}))
}

/// The money this shop counts in.
///
/// Every place that needs a fiat figure asks here rather than assuming. It used
/// to say KRW in six different files, which meant a shop in Osaka would have
/// had its small-payment threshold, its refund limits and its mining income all
/// computed in won — silently, and wrongly, with no screen ever saying so.
pub fn currency() -> String {
    shop_load()
        .get("currency")
        .and_then(Value::as_str)
        .map(str::to_uppercase)
        .filter(|c| c.len() == 3)
        .unwrap_or_else(|| "KRW".into())
}

/// Writes it, atomically, keeping the previous copy.
#[tauri::command]
pub fn shop_save(shop: Value) -> Result<(), String> {
    let path = shop_path();
    if let Some(d) = path.parent() {
        let _ = std::fs::create_dir_all(d);
    }
    // 덮어쓰기 전에 사본. 메뉴를 통째로 날리는 사고는 대개 저장 중이 아니라
    // 저장한 다음에 "아까 것이 나았다"에서 온다.
    if path.exists() {
        let _ = std::fs::copy(&path, path.with_extension("json.bak"));
    }
    let tmp = path.with_extension("json.tmp");
    std::fs::write(
        &tmp,
        serde_json::to_vec_pretty(&shop).map_err(|e| e.to_string())?,
    )
    .map_err(|e| format!("저장하지 못했습니다: {e}"))?;
    std::fs::rename(&tmp, &path).map_err(|e| format!("저장하지 못했습니다: {e}"))
}

/// How long the counter should make someone wait.
///
/// ## Why this is not the same table the vending machine uses
///
/// Two situations that look identical on a screen and are not:
///
/// - **At the counter** the customer is standing there. The shop hands over a
///   coffee, sees a face, has a camera, and the prize for a successful
///   double-spend is one coffee. Making that person wait a minute is a real
///   cost paid on every single sale.
/// - **Automatic delivery** ships an asset to a stranger with no face and no
///   recourse, and the same trick can be repeated all night.
///
/// So the counter may accept zero confirmations and the vending machine may
/// not.
///
/// ## Why zero is defensible on this chain specifically
///
/// `DEFAULT_ENABLE_REPLACEMENT = false` — Ravencoin ships with replace-by-fee
/// **off**, so the cheap attack that makes zero-conf reckless on Bitcoin does
/// not work against a default node. What remains is a race: broadcasting two
/// conflicting transactions and hoping miners take the other one. That needs
/// direct miner access and it is not worth building for the price of lunch.
///
/// A block is 60 seconds (`nPowTargetSpacing = 1 * 60`), but blocks arrive at
/// random: half land inside 42 s, one in ten takes over 2.3 minutes, one in a
/// hundred over 4.6. "약 1분"이 아니라 가끔 4분이라는 뜻이고, 카운터에서 4분은
/// 줄이 선다.
///
/// Amounts are in the shop's own currency as entered on the menu; the
/// thresholds below are written for KRW and a shop on another currency should
/// set its own in 설정.
#[tauri::command]
pub fn counter_confirmations(krw: f64, online: bool) -> Value {
    // 인터넷이 끊긴 노드는 결제를 검증할 수 없다. 0회 확인은 "네트워크가 이
    // 거래만 알고 있다"는 뜻인데, 네트워크와 말을 안 하고 있으면 그 문장이
    // 성립하지 않는다. 이때 이중지불은 막을 방법이 없다.
    if !online {
        return json!({
            "confirmations": -1,
            "why": "인터넷이 끊겨 결제를 확인할 수 없습니다. 현금으로 받으세요.",
            "seconds": 0,
            "zero_ok": false,
            "offline": true,
        });
    }
    let (n, why) = match krw {
        v if v <= 30_000.0 => (
            0,
            "손님 앞에서 파는 소액입니다. 멤풀에 뜨고 충돌이 없으면 바로 받으세요.",
        ),
        v if v <= 300_000.0 => (1, "평균 1분입니다. 가끔 2~3분 걸립니다."),
        v if v <= 3_000_000.0 => (6, "약 6분입니다. 이 금액은 기다릴 값어치가 있습니다."),
        _ => (12, "약 12분. 큰 금액은 사람이 한 번 더 확인하세요."),
    };
    json!({
        "confirmations": n,
        "why": why,
        // 몇 초쯤 걸리는지. 확인 수보다 이 숫자가 카운터에서 쓸모 있다.
        "seconds": n * 60,
        "zero_ok": n == 0,
        "offline": false,
    })
}

#[cfg(test)]
mod tests {
    use super::counter_confirmations;

    #[test]
    fn counter_lets_small_sales_through() {
        assert_eq!(counter_confirmations(4_500.0, true)["confirmations"], 0);
        assert_eq!(counter_confirmations(30_000.0, true)["confirmations"], 0);
        // 경계 바로 위는 기다린다.
        assert_eq!(counter_confirmations(30_001.0, true)["confirmations"], 1);
        assert_eq!(counter_confirmations(5_000_000.0, true)["confirmations"], 12);
    }

    #[test]
    fn offline_never_accepts_zero_conf() {
        // 인터넷이 끊기면 금액과 무관하게 받지 않는다. 커피 한 잔도 마찬가지 —
        // 확인할 방법이 없다는 사실은 금액에 따라 달라지지 않는다.
        for amount in [1_000.0, 30_000.0, 5_000_000.0] {
            let v = counter_confirmations(amount, false);
            assert_eq!(v["zero_ok"], false);
            assert_eq!(v["offline"], true);
        }
    }
}

// ── 영업 중인가 ───────────────────────────────────────────────────────────
//
// 노드가 켜져 있다는 것과 가게가 열려 있다는 것은 다른 말이다. 새벽 세 시에도
// 노드는 채굴하고 IPFS 를 붙들고 있어야 하므로 계속 돈다. 그때 손님 화면이
// 메뉴를 그대로 보여 주고 주문 버튼을 열어 두면, 아무도 만들지 않는 커피값이
// 결제된다 — 그건 환불로 끝나는 일이고, 환불은 우리가 되돌릴 수 없다.
//
// 그래서 영업 여부는 **가게가 직접 말해야 하는 사실**이고, 손님 화면 맨 위에
// 있어야 한다.
//
// ## 왜 체인이나 IPNS 에 두지 않는가
//
// 체인의 프로필을 고치려면 자산을 재발행해야 하고 RVN 이 탄다. 하루에 두 번
// 여닫는 값으로는 말이 안 된다. IPNS 는 공짜지만 이 노드에서 실측 **48초**가
// 걸렸고, 「지금 닫기」를 누른 사장이 48초를 기다리는 화면은 고장으로 읽힌다.
// 손님 화면은 어차피 이 노드가 그려 주므로, 이 노드가 답하면 그게 가장 빠르고
// 아무 데도 의존하지 않는다.

/// "HH:MM" → 자정부터의 분. 형식이 틀리면 None.
fn hhmm(s: &str) -> Option<i64> {
    let (h, m) = s.split_once(':')?;
    let h: i64 = h.trim().parse().ok()?;
    let m: i64 = m.trim().parse().ok()?;
    if !(0..=23).contains(&h) || !(0..=59).contains(&m) {
        return None;
    }
    Some(h * 60 + m)
}

fn two(mins: i64) -> String {
    format!("{:02}:{:02}", mins / 60 % 24, mins % 60)
}

const DAYS: [&str; 7] = ["일", "월", "화", "수", "목", "금", "토"];

/// Is the shop open at this moment, and if not, when does it open?
///
/// `hours` is seven entries keyed `0`(일)..`6`(토), each `{"open":"09:00",
/// "close":"18:00"}` or absent for a closed day. A close earlier than the open
/// means the shop runs past midnight — a bar closing at 02:00 is the ordinary
/// case, not an edge case, and treating it as bad data closes the shop at
/// exactly the hour it does its business.
pub fn open_at(shop: &Value, now_unix: i64, tz_offset_min: i64) -> Value {
    // 사장이 손으로 닫아 둔 것이 시간표를 이긴다. 재료가 떨어진 날에
    // 시간표를 고치게 만들면 아무도 안 고친다.
    if shop.get("closed_now").and_then(Value::as_bool).unwrap_or(false) {
        return json!({
            "open": false,
            "why": "closed_now",
            "say": shop.get("closed_note").and_then(Value::as_str)
                .filter(|s| !s.trim().is_empty())
                .unwrap_or("지금은 주문을 받지 않습니다"),
        });
    }

    // 시간표를 안 적은 가게는 늘 열린 것으로 본다. 안 적었다는 이유로 문을
    // 닫아 버리면, 어제까지 팔던 가게가 오늘 갑자기 안 팔린다.
    //
    // **빈 객체도 안 적은 것이다.** 화면은 채워진 요일만 모아 보내므로, 한 칸도
    // 안 채우면 `{}` 가 온다. 예전에는 그걸 "일곱 요일 모두 휴업"으로 읽어서,
    // 가게 정보를 한 번 저장한 것만으로 주문이 서버에서 막혔다.
    let hours = shop
        .get("hours")
        .and_then(Value::as_object)
        .filter(|m| !m.is_empty());
    let Some(hours) = hours else {
        return json!({ "open": true, "why": "no_hours", "say": "" });
    };

    let local = now_unix + tz_offset_min * 60;
    let mins = local.rem_euclid(86_400) / 60;
    let dow = (local.div_euclid(86_400) + 4).rem_euclid(7); // 1970-01-01 = 목

    let slot = |d: i64| -> Option<(i64, i64)> {
        let v = hours.get(&d.to_string())?;
        Some((hhmm(v.get("open")?.as_str()?)?, hhmm(v.get("close")?.as_str()?)?))
    };

    // 어제 열어서 자정을 넘겨 아직 안 닫은 경우를 먼저 본다.
    let yesterday = (dow + 6) % 7;
    if let Some((o, c)) = slot(yesterday) {
        if c <= o && mins < c {
            return json!({
                "open": true, "why": "overnight",
                "say": format!("오늘 {}에 닫습니다", two(c)),
            });
        }
    }

    if let Some((o, c)) = slot(dow) {
        let open = if c > o { mins >= o && mins < c } else { mins >= o };
        if open {
            return json!({
                "open": true, "why": "hours",
                "say": format!("{}에 닫습니다", two(c)),
            });
        }
        if mins < o {
            return json!({
                "open": false, "why": "before_open",
                "say": format!("오늘 {}에 엽니다", two(o)),
            });
        }
    }

    // 오늘은 끝났다. 다음으로 여는 날을 찾아 말해 준다 — "닫혔습니다" 만
    // 보여 주면 손님은 다시 올 날을 모른다.
    for step in 1..=7 {
        let d = (dow + step) % 7;
        if let Some((o, _)) = slot(d) {
            let when = if step == 1 { "내일".to_string() } else { format!("{}요일", DAYS[d as usize]) };
            return json!({
                "open": false, "why": "closed",
                "say": format!("{when} {}에 엽니다", two(o)),
            });
        }
    }

    json!({ "open": false, "why": "closed", "say": "영업시간이 정해져 있지 않습니다" })
}

/// What the customer screen asks on every load.
#[tauri::command]
pub fn shop_open_now(now_unix: i64, tz_offset_min: i64) -> Value {
    open_at(&shop_load(), now_unix, tz_offset_min)
}

#[cfg(test)]
mod open_tests {
    use super::*;

    /// 1970-01-01 은 목요일. 여기서 요일이 하루라도 밀리면 월요일 휴무인
    /// 가게가 일요일에 닫힌다.
    fn at(dow_from_thu: i64, hh: i64, mm: i64) -> i64 {
        dow_from_thu * 86_400 + hh * 3600 + mm * 60
    }

    fn hours(pairs: &[(&str, &str, &str)]) -> Value {
        let mut m = serde_json::Map::new();
        for (d, o, c) in pairs {
            m.insert(d.to_string(), json!({ "open": o, "close": c }));
        }
        json!({ "hours": Value::Object(m) })
    }

    #[test]
    fn weekday_index_starts_on_thursday() {
        let s = hours(&[("4", "09:00", "18:00")]); // 목요일만 영업
        assert!(open_at(&s, at(0, 12, 0), 0)["open"].as_bool().unwrap(), "목요일에 닫혔습니다");
        assert!(!open_at(&s, at(1, 12, 0), 0)["open"].as_bool().unwrap(), "금요일에 열렸습니다");
    }

    #[test]
    fn a_bar_that_closes_at_two_am_is_open_at_one_am() {
        // 닫는 시각이 여는 시각보다 이르면 자정을 넘긴다는 뜻이다. 이걸
        // 잘못된 값으로 처리하면 바가 제일 장사되는 시간에 닫힌다.
        let s = hours(&[("4", "18:00", "02:00")]);
        assert!(open_at(&s, at(0, 20, 0), 0)["open"].as_bool().unwrap(), "목 20시");
        assert!(open_at(&s, at(1, 1, 0), 0)["open"].as_bool().unwrap(), "금 새벽 1시");
        assert!(!open_at(&s, at(1, 3, 0), 0)["open"].as_bool().unwrap(), "금 새벽 3시는 닫혀야");
    }

    #[test]
    fn the_owners_own_switch_beats_the_timetable() {
        let mut s = hours(&[("4", "09:00", "18:00")]);
        s["closed_now"] = json!(true);
        s["closed_note"] = json!("재료가 떨어졌습니다");
        let r = open_at(&s, at(0, 12, 0), 0);
        assert!(!r["open"].as_bool().unwrap());
        assert_eq!(r["say"], "재료가 떨어졌습니다");
    }

    #[test]
    fn a_shop_with_no_timetable_keeps_selling() {
        // 안 적었다고 문을 닫아 버리면, 어제까지 팔던 가게가 오늘 안 팔린다.
        assert!(open_at(&json!({}), at(0, 3, 0), 0)["open"].as_bool().unwrap());
    }

    #[test]
    fn a_closed_shop_says_when_it_opens_again() {
        let s = hours(&[("4", "09:00", "18:00")]);
        // 목요일 새벽 — 오늘 9시에 연다.
        assert_eq!(open_at(&s, at(0, 6, 0), 0)["say"], "오늘 09:00에 엽니다");
        // 목요일 밤 — 다음 목요일까지 없다.
        assert_eq!(open_at(&s, at(0, 20, 0), 0)["say"], "목요일 09:00에 엽니다");
    }

    #[test]
    fn the_shops_own_clock_decides() {
        // 한국 시각 10시는 UTC 01시다. 시간대를 안 넘기면 9시 개점인 가게가
        // 아침 내내 닫혀 있다.
        let s = hours(&[("4", "09:00", "18:00")]);
        let utc_1am = at(0, 1, 0);
        assert!(!open_at(&s, utc_1am, 0)["open"].as_bool().unwrap());
        assert!(open_at(&s, utc_1am, 9 * 60)["open"].as_bool().unwrap(), "한국 10시인데 닫혔습니다");
    }

    #[test]
    fn broken_times_do_not_crash_the_shop() {
        for bad in ["", "9", "25:00", "09:99", "아홉시", "09:00:00"] {
            let s = hours(&[("4", bad, "18:00")]);
            let _ = open_at(&s, at(0, 12, 0), 0); // 패닉만 안 나면 된다
        }
        assert_eq!(hhmm("24:00"), None);
        assert_eq!(hhmm("00:00"), Some(0));
        assert_eq!(hhmm("23:59"), Some(1439));
    }
}

#[cfg(test)]
mod empty_hours {
    use super::*;

    /// 시간표를 한 칸도 안 채운 가게는 **닫힌 게 아니라 안 정한 것**이다.
    ///
    /// 화면은 채워진 요일만 모아 보내므로, 아무것도 안 채우면 `{}` 가 온다.
    /// 그걸 "모든 요일이 쉬는 날"로 읽으면 가게가 영영 닫히고 주문도 서버에서
    /// 막힌다 — 어제까지 팔던 가게가 오늘 갑자기 안 팔린다.
    #[test]
    fn an_empty_timetable_is_not_a_closed_shop() {
        let noon = 12 * 3600;
        // 키가 아예 없을 때 (이건 원래 통과했다)
        assert!(open_at(&json!({}), noon, 0)["open"].as_bool().unwrap());
        // 🔴 화면이 실제로 보내는 모양 — 빈 객체
        assert!(
            open_at(&json!({ "hours": {} }), noon, 0)["open"].as_bool().unwrap(),
            "빈 시간표를 휴업으로 읽었습니다"
        );
        // 한 요일이라도 적혀 있으면 그때부터는 시간표를 따른다.
        let one = json!({ "hours": { "4": { "open": "09:00", "close": "18:00" } } });
        assert!(!open_at(&one, 3 * 3600, 0)["open"].as_bool().unwrap());
    }
}

// ── 가게 이력 ──────────────────────────────────────────────────────────────
//
// 당근의 온도는 중앙 서버가 계산한다. 그걸 흉내 내면 두 가지가 깨진다 —
// 누가 계산하나(서버가 없다), 그리고 조작을 어떻게 막나(자기가 자기한테
// 백 번 사면 온도가 오른다). 별점은 살 수 있다.
//
// 우리에게만 있는 것은 **체인에 남는다**는 사실이다. 그래서 점수를 매기지 않고
// 사실만 말한다: 언제부터 있는 가게인가. 별점은 살 수 있어도 **2년 된 이력은
// 못 산다**, 그리고 이 값은 손님 폰이 직접 확인할 수 있다 — 우리를 믿을
// 필요가 없다.
//
// ⚠️ "손님 몇 명" 은 넣지 않았다. 그러려면 가게 주소의 입금 내역을 세야 하고
// 그건 `addressindex` 가 있어야 한다. 실측: 지금 노드는 꺼져 있고, 켜려면
// 34GB 를 다시 색인해야 한다 — 몇 시간 걸린다. 없는 인덱스 위에 숫자를 지어
// 올리느니 말하지 않는 편이 낫다. 자기 가게의 손님 수는 장부(`ledger`)가
// 이미 정확히 알고 있고, 그건 사장 화면의 몫이다.

/// When a shop's asset was created, straight from the chain.
///
/// Two calls: `listassets` for the block hash the issuance landed in, then
/// `getblock` for that block's time. The block time is what every node agrees
/// on, so two people looking at the same shop see the same date.
#[tauri::command]
pub async fn shop_history(asset: String) -> Result<Value, String> {
    let name = full_shop_name(&asset);
    let v = call_rpc("listassets", json!([name.clone(), true, 1, 0])).await?;
    let entry = v
        .get(&name)
        .ok_or_else(|| "체인에서 이 가게를 찾지 못했습니다.".to_string())?;

    let height = entry.get("block_height").and_then(Value::as_i64);
    let hash = entry.get("blockhash").and_then(Value::as_str).unwrap_or("");
    if hash.is_empty() {
        // 아직 블록에 안 들어갔다. "정보 없음" 과 "방금 만들어졌다" 는 다르다.
        return Ok(json!({ "asset": name, "pending": true }));
    }

    let block = call_rpc("getblock", json!([hash, 1])).await?;
    let time = block.get("time").and_then(Value::as_i64).unwrap_or(0);
    Ok(json!({
        "asset": name,
        "block": height,
        "since": time,
        "pending": false,
    }))
}

/// The name as it lives on the chain, whether or not the caller typed the prefix.
fn full_shop_name(input: &str) -> String {
    let c = input.trim().to_uppercase();
    if c.starts_with("SHOP.") {
        c
    } else {
        format!("SHOP.{c}")
    }
}

#[cfg(test)]
mod history_tests {
    use super::full_shop_name;

    /// 사장이 화면에 "GANGNAM_CAFE" 라고 적어 두면 조회가 조용히 빈손으로
    /// 돌아온다 — 가게가 없는 것처럼 보인다.
    #[test]
    fn the_prefix_is_added_only_when_missing() {
        assert_eq!(full_shop_name("gangnam_cafe"), "SHOP.GANGNAM_CAFE");
        assert_eq!(full_shop_name("SHOP.GANGNAM_CAFE"), "SHOP.GANGNAM_CAFE");
        assert_eq!(full_shop_name("  shop.playx  "), "SHOP.PLAYX");
        // 두 번 붙이면 SHOP.SHOP.X 가 되어 영영 못 찾는다.
        assert!(!full_shop_name("SHOP.PLAYX").starts_with("SHOP.SHOP"));
    }
}

// ── 플랫폼 수수료 ─────────────────────────────────────────────────────────
//
// 손님은 메뉴 가격을 그대로 낸다. 가게가 조금 덜 받는다 — 카드가 이미
// 그렇게 돈다. 우리 몫을 손님에게 더 받는 것으로 보이게 만들면 그건 거짓말이다.
//
// 🔴 우리가 돈을 들고 있지 않는다. `sendmany` 한 거래에 출력이 둘이라
// 가게 몫과 우리 몫이 **동시에** 간다. 우리를 거쳐 가지 않으므로 우리가
// 멈춰도 가게는 계속 판다. 그게 이 판을 쓰는 이유이기도 하다.
//
// 다른 지갑으로 결제하면 손님 지갑이 이 규칙을 모르므로 전액이 가게로 간다.
// 그때는 수수료가 안 걷히지만 **주문은 정상 처리된다** — 대조가 "가게 몫
// 이상" 이기 때문이다. 못 걷는 것과 손님을 막는 것 중에는 전자가 낫다.

/// 기본 요율. 카드가 2.5% 안팎이라 그 절반 아래로 잡았다.
pub const DEFAULT_FEE_RATE: f64 = 0.01;

fn fee_path() -> std::path::PathBuf {
    crate::paths::app_file("fee.json")
}

/// (요율, 받을 주소). 주소가 비면 걷지 않는다.
pub fn fee_config() -> (f64, String) {
    let v: Value = std::fs::read_to_string(fee_path())
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_else(|| json!({}));
    // 꺼 두면 0. 사장이 끌 수 있어야 한다 — 못 끄는 것은 수수료가 아니라 세금이고,
    // 오픈소스에서 세금은 포크로 사라진다.
    if !v.get("on").and_then(Value::as_bool).unwrap_or(true) {
        return (0.0, String::new());
    }
    let rate = v
        .get("rate")
        .and_then(Value::as_f64)
        .filter(|r| (0.0..=0.05).contains(r)) // 5% 넘게 적히면 오타로 본다
        .unwrap_or(DEFAULT_FEE_RATE);
    let addr = v
        .get("address")
        .and_then(Value::as_str)
        .unwrap_or(PLATFORM_ADDRESS)
        .to_string();
    (rate, addr)
}

/// 우리가 받을 주소. 비워 두면 아무것도 걷히지 않는다 — 주소를 코드에
/// 박아 두는 대신 배포할 때 채운다. 잘못된 주소를 박으면 그리로 간 돈은
/// 영원히 사라진다.
const PLATFORM_ADDRESS: &str = "";

/// 사장이 보고 끄는 화면용.
#[tauri::command]
pub fn fee_read() -> Value {
    let (rate, addr) = fee_config();
    json!({
        "on": rate > 0.0 && !addr.is_empty(),
        "rate": rate,
        "address": addr,
        "percent": rate * 100.0,
        "default_percent": DEFAULT_FEE_RATE * 100.0,
    })
}

#[tauri::command]
pub fn fee_save(on: bool, rate: Option<f64>, address: Option<String>) -> Result<Value, String> {
    let mut v: Value = std::fs::read_to_string(fee_path())
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_else(|| json!({}));
    v["on"] = json!(on);
    if let Some(r) = rate {
        if !(0.0..=0.05).contains(&r) {
            return Err("요율은 0 에서 5% 사이여야 합니다.".into());
        }
        v["rate"] = json!(r);
    }
    if let Some(a) = address {
        v["address"] = json!(a.trim());
    }
    if let Some(d) = fee_path().parent() {
        let _ = std::fs::create_dir_all(d);
    }
    std::fs::write(fee_path(), serde_json::to_vec_pretty(&v).map_err(|e| e.to_string())?)
        .map_err(|e| format!("저장하지 못했습니다: {e}"))?;
    Ok(fee_read())
}

#[cfg(test)]
mod fee_tests {
    use super::*;

    /// 손님은 메뉴 가격을 낸다. 우리 몫은 **총액에서** 나온다.
    /// 이걸 반대로 하면 손님 화면의 금액이 우리 때문에 올라간다.
    #[test]
    fn the_fee_comes_out_of_the_total_not_on_top() {
        let s = split_payment(1000.0, 0.01, "RTestAddress".into());
        assert_eq!(s["total"], json!(1000.0));
        assert_eq!(s["fee"], json!(10.0));
        assert_eq!(s["shop_gets"], json!(990.0));
        // 가게 몫 + 우리 몫이 총액과 정확히 같아야 한다. 1사토시라도 새면
        // 그 거래는 잔돈이 안 맞아 실패한다.
        let sum = s["shop_gets"].as_f64().unwrap() + s["fee"].as_f64().unwrap();
        assert!((sum - 1000.0).abs() < 1e-8, "합이 총액과 다르다: {sum}");
    }

    /// 주소가 없으면 한 푼도 걷지 않는다. 빈 주소로 보내면 그 돈은 사라진다.
    #[test]
    fn no_address_means_no_fee() {
        let s = split_payment(1000.0, 0.01, "".into());
        assert_eq!(s["fee"], json!(0.0));
        assert_eq!(s["shop_gets"], json!(1000.0));
        assert_eq!(s["collected"], json!(false));
        assert!(s["skip_reason"].as_str().unwrap().contains("주소"));
    }

    /// 티끌보다 작은 수수료는 보내면 거래 전체가 릴레이되지 않는다.
    /// 커피 한 잔이 아니라 **아주 싼 것** 을 팔 때 여기에 걸린다.
    #[test]
    fn a_fee_below_dust_is_not_collected() {
        let s = split_payment(0.0001, 0.01, "RTestAddress".into());
        assert_eq!(s["fee"], json!(0.0));
        assert_eq!(s["collected"], json!(false));
        assert!(s["skip_reason"].as_str().unwrap().contains("작아"));
    }

    /// 사장이 끌 수 있어야 한다. 못 끄는 것은 수수료가 아니라 세금이고,
    /// 오픈소스에서 세금은 포크 한 번으로 사라진다.
    #[test]
    fn the_owner_can_turn_it_off() {
        let _g = crate::paths::TEST_ENV.lock().unwrap_or_else(|e| e.into_inner());
        let dir = std::env::temp_dir().join("playx-raven-test-fee");
        let _ = std::fs::remove_dir_all(&dir);
        std::env::set_var("PLAYX_RAVEN_HOME", &dir);
        fee_save(false, None, Some("RSomewhere".into())).unwrap();
        let (rate, _) = fee_config();
        assert_eq!(rate, 0.0, "껐는데 걷힌다");
        fee_save(true, Some(0.01), Some("RSomewhere".into())).unwrap();
        let (rate, addr) = fee_config();
        assert_eq!(rate, 0.01);
        assert_eq!(addr, "RSomewhere");
        std::env::remove_var("PLAYX_RAVEN_HOME");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 오타로 50% 를 적으면 가게가 반을 잃는다.
    #[test]
    fn an_absurd_rate_is_refused() {
        let _g = crate::paths::TEST_ENV.lock().unwrap_or_else(|e| e.into_inner());
        let dir = std::env::temp_dir().join("playx-raven-test-fee2");
        std::env::set_var("PLAYX_RAVEN_HOME", &dir);
        assert!(fee_save(true, Some(0.5), None).is_err());
        std::env::remove_var("PLAYX_RAVEN_HOME");
        let _ = std::fs::remove_dir_all(&dir);
    }
}

/// 주문번호가 몇까지 갔다가 1로 돌아가나.
///
/// 기본 9,999. 자릿수가 늘수록 카운터에서 **불러도 안 들린다** — 실제 가게가
/// 세 자리를 쓰는 이유다. 그래도 하루에 그만큼 파는 곳(구내식당·축제)이 있으니
/// 막지 않고 사장이 정하게 한다.
///
/// 상한을 아무리 크게 잡아도 **날이 바뀌면 1번부터**다. 그게 "그날 몇 번째"
/// 라는 번호의 뜻이다.
pub fn ticket_cap() -> u32 {
    let v: Value = std::fs::read_to_string(crate::paths::app_file("shop.json"))
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_else(|| json!({}));
    v.get("ticket_cap")
        .and_then(Value::as_u64)
        .map(|n| n as u32)
        // 100 미만은 하루에 두 번 도는 가게가 나온다. 999,999 는 여섯 자리라
        // 부를 수 없다 — 그 위는 번호가 아니라 일련번호다.
        .filter(|n| (100..=999_999).contains(n))
        .unwrap_or(9_999)
}

#[cfg(test)]
mod ticket_cap_tests {
    use super::ticket_cap;

    /// 설정이 없으면 9,999. 없다고 1 이나 0 이 되면 모든 손님이 1번이 된다.
    #[test]
    fn the_default_is_sane() {
        let _g = crate::paths::TEST_ENV.lock().unwrap_or_else(|e| e.into_inner());
        let dir = std::env::temp_dir().join("playx-raven-test-cap");
        let _ = std::fs::remove_dir_all(&dir);
        std::env::set_var("PLAYX_RAVEN_HOME", &dir);
        assert_eq!(ticket_cap(), 9_999);
        std::env::remove_var("PLAYX_RAVEN_HOME");
    }

    /// 말도 안 되는 값이 적혀 있어도 기본값으로 돌아간다.
    #[test]
    fn a_broken_value_falls_back() {
        let _g = crate::paths::TEST_ENV.lock().unwrap_or_else(|e| e.into_inner());
        let dir = std::env::temp_dir().join("playx-raven-test-cap2");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::env::set_var("PLAYX_RAVEN_HOME", &dir);
        for bad in ["0", "1", "99", "1000000"] {
            std::fs::write(dir.join("shop.json"), format!("{{\"ticket_cap\":{bad}}}")).unwrap();
            assert_eq!(ticket_cap(), 9_999, "{bad} 이 그대로 쓰인다");
        }
        std::fs::write(dir.join("shop.json"), "{\"ticket_cap\":300}").unwrap();
        assert_eq!(ticket_cap(), 300, "제대로 된 값을 안 쓴다");
        std::env::remove_var("PLAYX_RAVEN_HOME");
        let _ = std::fs::remove_dir_all(&dir);
    }
}

/// 주문의 진짜 값. **메뉴가 정한다, 손님이 아니라.**
///
/// 🔴 여태 손님 폰이 보낸 `total` 을 그대로 썼다. 메뉴에 10잔을 담고
/// `total: 1` 을 보내면 1원짜리 결제 주소가 나왔고, 1원만 넣어도 「결제
/// 확인됨」이 떴다. 손님 폰의 자바스크립트는 손님이 고칠 수 있다 — 화면에서
/// 막는 것은 막는 것이 아니다.
///
/// 메뉴에 없는 이름은 0 원으로 친다. 지어낸 품목으로 총액을 부풀릴 수도,
/// 가게가 못 주는 것을 사 갈 수도 없다.
pub fn price_of(menu: &Value, items: &Value) -> f64 {
    let mut price: std::collections::HashMap<String, f64> = std::collections::HashMap::new();
    for it in menu.as_array().cloned().unwrap_or_default() {
        if let Some(n) = it.get("name").and_then(Value::as_str) {
            price.insert(n.to_string(), it.get("price").and_then(Value::as_f64).unwrap_or(0.0));
        }
    }
    let mut sum = 0.0;
    for it in items.as_array().cloned().unwrap_or_default() {
        let n = it.get("name").and_then(Value::as_str).unwrap_or("");
        let q = it.get("qty").and_then(Value::as_f64).unwrap_or(0.0);
        if q <= 0.0 {
            continue;
        }
        sum += price.get(n).copied().unwrap_or(0.0) * q;
    }
    (sum * 1e8).round() / 1e8
}

#[cfg(test)]
mod price_tests {
    use super::*;

    fn menu() -> Value {
        json!([{ "name": "아메리카노", "price": 4000 }, { "name": "케이크", "price": 6500 }])
    }

    /// 🔴 손님이 보낸 값을 믿으면 커피 열 잔이 1원이 된다.
    #[test]
    fn the_menu_decides_the_price_not_the_phone() {
        let items = json!([{ "name": "아메리카노", "qty": 10 }]);
        assert_eq!(price_of(&menu(), &items), 40_000.0);
    }

    /// 메뉴에 없는 것을 지어내도 값이 안 붙는다.
    #[test]
    fn an_invented_item_is_worth_nothing() {
        let items = json!([{ "name": "황금열쇠", "qty": 1, "price": 1 }]);
        assert_eq!(price_of(&menu(), &items), 0.0);
    }

    /// 음수 수량으로 총액을 깎을 수 없다.
    #[test]
    fn a_negative_quantity_cannot_discount_the_order() {
        let items = json!([
            { "name": "케이크", "qty": 1 },
            { "name": "아메리카노", "qty": -100 }
        ]);
        assert_eq!(price_of(&menu(), &items), 6_500.0);
    }
}

// ── 가게 색 ───────────────────────────────────────────────────────────────
//
// 사장이 AI 에게 "우리 가게는 따뜻한 느낌이면 좋겠어" 라고 말하면 손님 화면의
// 색이 바뀐다. 바꿀 수 있는 것은 **둘뿐**이다 — 채운 버튼 색(accent)과 배지
// 뒤의 아주 옅은 바탕(tint).
//
// 🔴 더 열지 않는 이유: 글자색·배경색까지 AI 가 정하게 하면 **읽을 수 없는
// 화면**이 나온다. 흰 바탕에 노란 글자를 만들어 놓고 사장은 자기 폰에서만
// 확인한다. 우리가 지키는 것은 대비고, 그건 협상 대상이 아니다.

/// 흰 글자를 얹어도 읽히는가. 0.25 는 WCAG 4.5:1 을 흰 글자로 맞추는 언저리다.
fn luminance(hex: &str) -> Option<f64> {
    let h = hex.trim().trim_start_matches('#');
    if h.len() != 6 || !h.chars().all(|c| c.is_ascii_hexdigit()) {
        return None;
    }
    let v = |i: usize| u8::from_str_radix(&h[i..i + 2], 16).ok().map(|x| x as f64 / 255.0);
    let f = |c: f64| if c <= 0.03928 { c / 12.92 } else { ((c + 0.055) / 1.055).powf(2.4) };
    Some(0.2126 * f(v(0)?) + 0.7152 * f(v(2)?) + 0.0722 * f(v(4)?))
}

/// 사장이 고른 색. 없거나 못 읽으면 기본값이다 — **화면이 안 깨지는 쪽으로.**
#[tauri::command]
pub fn theme_read() -> Value {
    let v: Value = std::fs::read_to_string(crate::paths::app_file("shop.json"))
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_else(|| json!({}));
    let t = v.get("theme").cloned().unwrap_or(json!({}));
    json!({
        "accent": ok_accent(t.get("accent").and_then(Value::as_str)).unwrap_or("#3b3f8f".into()),
        "tint": ok_tint(t.get("tint").and_then(Value::as_str)).unwrap_or("#fdf1e7".into()),
    })
}

fn ok_accent(c: Option<&str>) -> Option<String> {
    let c = c?;
    // 밝은 강조색에 흰 글자를 얹으면 매장 조명 아래서 안 보인다.
    (luminance(c)? < 0.30).then(|| c.to_string())
}

fn ok_tint(c: Option<&str>) -> Option<String> {
    let c = c?;
    // 옅은 바탕이 진하면 그 위의 글자가 죽는다.
    (luminance(c)? > 0.80).then(|| c.to_string())
}

#[tauri::command]
pub fn theme_save(accent: String, tint: String) -> Result<Value, String> {
    let a = ok_accent(Some(&accent))
        .ok_or("강조색이 너무 밝습니다. 흰 글자를 얹으면 매장 조명 아래서 안 보입니다.")?;
    let t = ok_tint(Some(&tint)).ok_or("옅은 바탕이 너무 진합니다. 그 위의 글자가 죽습니다.")?;
    let path = crate::paths::app_file("shop.json");
    let mut v: Value = std::fs::read_to_string(&path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_else(|| json!({}));
    v["theme"] = json!({ "accent": a, "tint": t });
    if let Some(d) = path.parent() {
        let _ = std::fs::create_dir_all(d);
    }
    std::fs::write(&path, serde_json::to_vec_pretty(&v).map_err(|e| e.to_string())?)
        .map_err(|e| format!("저장하지 못했습니다: {e}"))?;
    Ok(theme_read())
}

#[cfg(test)]
mod theme_tests {
    use super::*;

    /// 🔴 밝은 강조색에 흰 글자를 얹으면 **매장 조명 아래서 안 보인다.**
    /// AI 가 "따뜻한 노랑" 을 골라 주면 주문 버튼이 사라진다.
    #[test]
    fn a_pale_accent_is_refused() {
        assert!(theme_save("#ffe066".into(), "#fff8e1".into()).is_err());
        assert!(ok_accent(Some("#ffffff")).is_none());
        assert!(ok_accent(Some("#3b3f8f")).is_some());
    }

    /// 옅은 바탕이 진하면 그 위 글자가 죽는다.
    #[test]
    fn a_dark_tint_is_refused() {
        assert!(ok_tint(Some("#333333")).is_none());
        assert!(ok_tint(Some("#fdf1e7")).is_some());
    }

    /// 이상한 값이 들어와도 화면은 돌아야 한다 — 기본값으로 떨어진다.
    #[test]
    fn nonsense_falls_back_instead_of_breaking_the_screen() {
        assert!(ok_accent(Some("파랑")).is_none());
        assert!(ok_accent(Some("#12")).is_none());
        assert!(ok_accent(None).is_none());
    }
}
