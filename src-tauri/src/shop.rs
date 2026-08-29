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
    // 🔴 가게 **안** 사진들이 든 파일창고 폴더 주소. 사진이 아니라 주소
    //    하나다 — 100장을 올려도 공지에는 60바이트만 실린다.
    photos_cid: Option<String>,
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
    // 🔴 이 가게의 간판 공개키. **체인에 남는 값 중 유일하게 「지금」을 가리키는
    // 것**이다 — 주문 주소는 하루에도 바뀌지만 이 열쇠는 안 바뀌므로, 손님은
    // 이걸 보고 최신 주소를 릴레이에서 찾는다. 없으면 장터가 그 가게의 주문
    // 버튼을 영원히 못 그린다. 자산 정보는 재발행해야 고쳐지니 **처음 등록할
    // 때 반드시 들어가야** 한다.
    if let Ok(pk) = crate::shopkey::shop_pubkey() {
        other.insert("nostr_pubkey".into(), json!(pk));
    }
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
    if let Some(p) = photos_cid.as_ref().map(|s| s.trim()).filter(|s| !s.is_empty()) {
        asset_data.insert("photos_cid".into(), json!(p));
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

/// 손님이 **실제로 보낼 수 있는** 제일 작은 금액.
///
/// 🔴 `DUST_RVN`(546사토시)은 출력 하나가 살아남는 한계지만, 레이븐 노드의
/// 기본 `relayfee` 는 **0.01 RVN** 이다. 그보다 작은 거래는 네트워크가
/// 아예 안 날라 준다.
///
/// 실제로 그 상태였다 — 커피값이 0.00000001 RVN 이라 주문은 만들어지는데
/// 손님 지갑이 보내려 하면 거부당했고, **우리 화면은 아무 말도 안 했다.**
/// 손님은 「결제가 안 된다」만 겪고, 사장은 왜인지 모른다.
///
/// 값을 여기 못 박은 이유: 노드에 물어보려면 노드가 켜져 있어야 하는데,
/// 이 검사는 **메뉴를 적는 순간**에도 돌아야 한다. 기본값이 바뀌면 여기를
/// 고친다(`raven-cli getnetworkinfo` 의 `relayfee`).
pub const MIN_SENDABLE_RVN: f64 = 0.01;

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
        // 🔴 **어디로 갔는지** 를 같이 돌려준다. 여태 금액만 있어서, 수수료가
        // 맞는 주소로 갔는지 확인할 방법이 화면에 없었다. 확인할 수 없는 돈은
        // 없는 돈과 같다. 주소는 원래 체인에 공개되므로 숨길 것이 아니다.
        "fee_address": if collect { fee_address.trim() } else { "" },
        "collected": collect,
        // Why nothing was taken, so the UI never shows a silent zero.
        "skip_reason": if fee_address.trim().is_empty() {
            "개발비 주소가 정해지지 않았습니다"
        } else if !collect {
            "개발비가 너무 작아 보내지 않습니다"
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
        return Err("가게 주소와 개발비 주소가 같습니다.".into());
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

/// **팔 수 있는 품목만 남긴다.**
///
/// 🔴 값이 없거나 1사토시보다 작은 품목이 손님 화면에 그대로 나가고 있었다.
/// 값이 없으면 `price_of` 가 0 으로 세므로 **다른 것과 같이 담으면 그 품목만
/// 공짜로 나간다.** 1사토시(0.00000001 RVN)보다 작은 값도 체인에서 0 이
/// 되어 마찬가지다.
///
/// 메뉴에서 지우지는 않는다 — 사장이 값을 아직 안 정했을 뿐이고, 그건
/// 메뉴판에 남아 있어야 다음에 채운다. **손님에게만 안 보인다.**
pub fn sellable(menu: &Value) -> Value {
    json!(menu
        .as_array()
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .filter(|it| {
            let p = it.get("price").and_then(Value::as_f64).unwrap_or(0.0);
            let named = it
                .get("name")
                .and_then(Value::as_str)
                .map(|s| !s.trim().is_empty())
                .unwrap_or(false);
            named && p >= 1e-8
        })
        .collect::<Vec<Value>>())
}

/// 값을 안 매겨 손님에게 못 보여 주는 품목. 사장 화면이 알려 준다.
///
/// 🔴 조용히 빼면 사장은 「왜 손님 화면에 커피가 없지」를 영영 못 푼다.
#[tauri::command]
pub fn unsellable(menu: Value) -> Vec<String> {
    menu.as_array()
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .filter(|it| it.get("price").and_then(Value::as_f64).unwrap_or(0.0) < 1e-8)
        .filter_map(|it| it.get("name").and_then(Value::as_str).map(str::to_string))
        .filter(|n| !n.trim().is_empty())
        .collect()
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

/// (요율, 받을 주소). **항상 1%, 항상 이 주소.**
///
/// ## 🔴 끄는 길이 없다 — 그게 결정이다
///
/// 예전에는 `fee.json` 에 `on: false` 를 적으면 걷지 않았다. 그 스위치를
/// 없앴다(2026-08-23, 대표님 지시: "무조건 1% 받을거야").
///
/// 반대 논리도 코드에 적혀 있었다 — "못 끄는 것은 개발비가 아니라 세금이고,
/// 오픈소스에서 세금은 포크 한 번으로 사라진다". 그 말은 지금도 맞다.
/// 이 파일을 고쳐 다시 빌드하면 누구든 뺄 수 있다.
///
/// 그래도 **끄는 스위치를 눈앞에 두는 것**과 **소스를 고쳐 다시 빌드해야
/// 하는 것**은 완전히 다르다. 앞의 것은 설정 화면을 여는 사람마다 한 번씩
/// 고민하게 만들고, 뒤의 것은 그럴 생각이 있는 사람만 한다.
///
/// 카드 단말기는 2~3% 를 떼고 임대료를 따로 받는다. 여기는 1% 뿐이고
/// 단말기도, 정산 대기도, 해지 위약금도 없다. 그 값은 받는 것이 맞다.
///
/// ⚠️ 여기를 다시 「끌 수 있게」 만들려는 사람에게: 화면·랜딩·라비 프롬프트
/// 세 곳이 **끌 수 없다고 적혀 있다.** 코드만 고치면 그 셋이 거짓말이 된다.
pub fn fee_config() -> (f64, String) {
    (DEFAULT_FEE_RATE, PLATFORM_ADDRESS.to_string())
}

/// 우리가 받을 주소.
///
/// 🔴 **한 글자만 틀려도 그리로 간 돈은 영원히 사라진다.** 체인은 되돌리지
/// 않고, 아무도 되돌려 줄 수 없다. 그래서 눈으로 보고 넣지 않았다 —
/// 노드에게 검사시켰다(2026-08-21):
///
/// ```text
/// $ raven-cli validateaddress RLFnbkjmf1VCVq7D9TZvRp7fv6W97rm2cB
///   "isvalid": true,  "ismine": true,
///   "account": "PLAY X 1% 수수료",
///   "hdkeypath": "m/44'/175'/0'/0/63"
/// ```
///
/// ⚠️ 이 주소의 열쇠는 대표님 지갑(`m/44'/175'/0'/0/63`)에 있다. **그 지갑의
/// 12단어를 잃으면 여기 쌓인 수수료도 같이 잃는다.** 이 값을 고치는 사람은
/// 위 명령을 다시 돌려서 `isvalid: true` 를 눈으로 확인하고 바꿀 것.
///
/// 사장은 `fee.json` 으로 이 값을 덮어쓰거나 아예 끌 수 있다. 못 끄는 것은
/// 수수료가 아니라 세금이고, 오픈소스에서 세금은 포크로 사라진다.
const PLATFORM_ADDRESS: &str = "RLFnbkjmf1VCVq7D9TZvRp7fv6W97rm2cB";

/// 사장이 보고 끄는 화면용.
#[tauri::command]
pub fn fee_read() -> Value {
    let (rate, addr) = fee_config();
    json!({
        // 항상 켜져 있다. 화면이 이 값을 보고 「내는 중」이라고만 적는다 —
        // 고르는 자리가 아니다.
        "on": true,
        "rate": rate,
        "address": addr,
        "percent": rate * 100.0,
        "default_percent": DEFAULT_FEE_RATE * 100.0,
    })
}


#[cfg(test)]
mod fee_tests {
    use super::*;

    /// 🔴 수수료 주소는 **한 글자만 틀려도 그리로 간 돈이 영원히 사라진다.**
    /// 체인은 되돌리지 않는다.
    ///
    /// 이 시험이 지키는 것 두 가지:
    ///   1. 주소가 실제로 코드를 통과해 나오는가 — 상수만 고치고 배선을
    ///      빠뜨리면 컴파일은 되고 수수료는 0원이다. 화면에는 아무 표시도
    ///      안 나서, 몇 달 뒤 "왜 한 푼도 안 들어왔지" 로 알게 된다.
    ///   2. 글자가 바뀌지 않았는가 — 리팩터링이나 자동 수정이 한 글자를
    ///      건드려도 컴파일은 통과한다. 그러면 남의 주소로 돈이 간다.
    ///
    /// 값은 `raven-cli validateaddress` 로 확인했다(isvalid: true,
    /// account "PLAY X 1% 수수료", hdkeypath m/44'/175'/0'/0/63).
    /// 여기를 고치는 사람은 그 명령을 **다시 돌려서** 확인하고 바꿀 것.
    #[test]
    fn the_fee_address_is_exactly_what_the_node_validated() {
        let _g = crate::paths::TEST_ENV.lock().unwrap_or_else(|e| e.into_inner());
        // 사장 설정 파일이 끼어들지 않는 깨끗한 자리에서 본다.
        let dir = std::env::temp_dir().join("playx-raven-test-feeaddr");
        let _ = std::fs::remove_dir_all(&dir);
        std::env::set_var("PLAYX_RAVEN_HOME", &dir);

        const EXPECTED: &str = "RLFnbkjmf1VCVq7D9TZvRp7fv6W97rm2cB";
        assert_eq!(PLATFORM_ADDRESS, EXPECTED, "수수료 주소가 바뀌었다");

        // 상수만 맞는 것으로는 부족하다. **실제로 나오는지** 본다.
        let (rate, addr) = fee_config();
        assert_eq!(addr, EXPECTED, "설정을 지나면서 주소가 바뀐다");
        assert!((rate - 0.01).abs() < 1e-9, "기본 요율이 1% 가 아니다: {rate}");

        // 그리고 그 주소로 진짜 나뉘는지. 여기까지 와야 "걷힌다" 가 사실이다.
        let s = split_payment(1000.0, rate, addr);
        assert_eq!(s["fee_address"], json!(EXPECTED));
        assert_eq!(s["fee"], json!(10.0));
        assert_eq!(s["collected"], json!(true));

        std::env::remove_var("PLAYX_RAVEN_HOME");
        let _ = std::fs::remove_dir_all(&dir);
    }

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

    /// 🔴 **끄는 길이 없어야 한다.** 예전에는 `fee.json` 에 `on: false` 를
    /// 적으면 걷히지 않았다. 그 스위치를 없앴다(대표님 지시).
    ///
    /// 이 시험이 지키는 것: 누군가 「설정으로 끌 수 있게」를 되살리면서
    /// 화면·랜딩·라비 프롬프트를 안 고치면, 그 셋이 거짓말이 된다.
    /// 여기서 먼저 빨갛게 뜬다.
    #[test]
    fn there_is_no_way_to_turn_it_off() {
        let _g = crate::paths::TEST_ENV.lock().unwrap_or_else(|e| e.into_inner());
        let dir = std::env::temp_dir().join("playx-raven-test-fee");
        let _ = std::fs::remove_dir_all(&dir);
        let _ = std::fs::create_dir_all(&dir);
        std::env::set_var("PLAYX_RAVEN_HOME", &dir);

        // 옛 설정 파일이 남아 있어도 무시해야 한다. 예전에 껐던 사장의
        // 컴퓨터가 그대로 있고, 그 파일이 아직 `on: false` 다.
        std::fs::write(
            dir.join("fee.json"),
            br#"{"on":false,"rate":0.0,"address":"RSomewhere"}"#,
        )
        .unwrap();

        let (rate, addr) = fee_config();
        assert_eq!(rate, DEFAULT_FEE_RATE, "옛 설정으로 꺼졌다");
        assert_eq!(addr, PLATFORM_ADDRESS, "옛 설정이 주소를 가로챘다");
        assert!(fee_read()["on"].as_bool().unwrap(), "화면에 꺼진 것으로 보인다");

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
/// 품목마다 다른 통화를 **RVN 으로 모아** 합계를 낸다.
///
/// ## 왜 필요한가
///
/// 한 가게가 커피와 음반과 그림을 같이 판다:
///
///   아메리카노   4,500원      — 손님이 아는 값으로 매겨야 한다
///   LP 한정반    1,200 RVN    — 코인으로 매겨야 수량이 고정된다
///   해외 굿즈       25 USD    — 달러로 매겨야 환율에 안 흔들린다
///
/// 가게 통화 하나로는 이걸 못 적는다. 그렇다고 손님이 통화를 정하게 두면
/// **4,500원짜리를 4,500동으로 사 간다** — 그 구멍은 이미 한 번 막았다.
///
/// 그래서 **통화는 메뉴에 적힌 것만** 쓴다. 손님이 보낸 값은 안 본다.
///
/// ## 🔴 합계는 RVN 에서 낸다
///
/// 원과 달러를 더할 수 없으니 각각 RVN 으로 바꿔 더한다. 그게 손님이 실제로
/// 보내는 것이기도 하다. 시세는 **한 번만** 읽는다 — 품목마다 읽으면 같은
/// 주문 안에서 서로 다른 시세가 섞인다.
pub async fn price_rvn(menu: &Value, items: &Value, now: i64) -> Result<Value, String> {
    // 품목 이름 → (값, 통화)
    let mut card: std::collections::HashMap<String, (f64, String)> =
        std::collections::HashMap::new();
    let shop_cur = currency();
    for it in menu.as_array().cloned().unwrap_or_default() {
        let Some(n) = it.get("name").and_then(Value::as_str) else { continue };
        let p = it.get("price").and_then(Value::as_f64).unwrap_or(0.0);
        // 품목에 통화가 없으면 가게 통화를 쓴다. 예전 메뉴가 그대로 돈다.
        let c = it
            .get("currency")
            .and_then(Value::as_str)
            .map(str::to_uppercase)
            .filter(|c| c.len() == 3)
            .unwrap_or_else(|| shop_cur.clone());
        card.insert(n.to_string(), (p, c));
    }

    // 이 주문에 실제로 쓰인 통화만 시세를 묻는다. 안 쓰는 통화까지 물으면
    // 느려지고, 그중 하나가 실패하면 주문이 통째로 막힌다.
    let mut need: Vec<String> = Vec::new();
    for it in items.as_array().cloned().unwrap_or_default() {
        let n = it.get("name").and_then(Value::as_str).unwrap_or("");
        if let Some((_, c)) = card.get(n) {
            if !c.eq_ignore_ascii_case("RVN") && !need.contains(c) {
                need.push(c.clone());
            }
        }
    }
    let mut rate: std::collections::HashMap<String, f64> = std::collections::HashMap::new();
    for c in need {
        let q = crate::price::quote_price(1.0, c.clone(), now).await?;
        // 1 단위가 몇 RVN 인가.
        let one = q.get("rvn").and_then(Value::as_f64).unwrap_or(0.0);
        if one <= 0.0 {
            return Err(format!("{c} 시세를 읽지 못했습니다."));
        }
        rate.insert(c, one);
    }

    let mut total = 0.0;
    let mut lines = Vec::new();
    for it in items.as_array().cloned().unwrap_or_default() {
        let n = it.get("name").and_then(Value::as_str).unwrap_or("");
        let q = it.get("qty").and_then(Value::as_f64).unwrap_or(0.0);
        if q <= 0.0 {
            continue;
        }
        let Some((p, c)) = card.get(n) else { continue };
        let rvn = if c.eq_ignore_ascii_case("RVN") {
            p * q
        } else {
            p * q * rate.get(c).copied().unwrap_or(0.0)
        };
        total += rvn;
        lines.push(json!({ "name": n, "qty": q, "price": p, "currency": c, "rvn": rvn }));
    }

    Ok(json!({
        "rvn": (total * 1e8).round() / 1e8,
        "lines": lines,
        // 어느 시세로 쟀는지 남긴다. 세무에서 이 숫자를 다시 세워야 한다.
        "rates": rate,
        "at": now,
    }))
}

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

/// 체인의 가게 목록에 **IPFS 프로필까지 합쳐서** 돌려준다.
///
/// `list_shops` 는 자산 이름과 CID 만 준다. 그것만으로 장터에 그릴 수 있는
/// 것은 `SHOP.PLAYX` 라는 글자뿐이다 — 가게 이름도, 돈 받을 주소도, 지금
/// 어디서 주문을 받는지도 전부 CID 안에 들어 있다.
///
/// 🔴 그래서 장터 가게 탭이 여태 비어 있었다. `web/shops.html` 이 부르는
/// `/api/chain/shops` 가 이 노드에 아예 없었고, 있는 `/api/shops` 는 CID 만
/// 준다. 화면은 오류를 안 내고 그냥 「가게가 없습니다」를 그렸다.
///
/// ## 왜 한꺼번에 받아 오는가
///
/// 손님 폰이 가게 하나마다 IPFS 를 따로 부르게 하면, 가게 20곳이면 요청이
/// 20번이고 그중 하나가 느리면 화면 전체가 늦는다. 노드는 IPFS 를 **옆에**
/// 두고 있으니 여기서 받는 편이 훨씬 빠르다.
///
/// ## 못 읽는 가게를 버리지 않는다
///
/// CID 가 우리 IPFS 에 아직 안 퍼졌거나 프로필이 깨졌으면 이름 없이 자산
/// 이름만 담아 **그대로 목록에 남긴다.** 조용히 빼면 사장이 「내 가게가 왜
/// 안 보이지」를 영원히 못 푼다. 이름 자리에 자산 이름이 뜨는 편이 낫다.
pub async fn shop_profiles(count: i64, start: i64) -> Result<Value, String> {
    let listed = list_shops(count, start).await?;
    let rows: Vec<Value> = listed
        .get("shops")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();

    let client = reqwest::Client::builder()
        // 가게 하나가 안 퍼진 CID 를 들고 있어도 장터 전체를 세우지 않는다.
        .timeout(std::time::Duration::from_secs(4))
        .build()
        .map_err(|e| e.to_string())?;

    let mut jobs = tokio::task::JoinSet::new();
    for row in rows {
        let client = client.clone();
        jobs.spawn(async move {
            let cid = row
                .get("ipfs_hash")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            let profile = if cid.is_empty() || cid.contains('/') || cid.contains("..") {
                None
            } else {
                fetch_profile(&client, &cid).await
            };
            merge_profile(row, profile)
        });
    }

    let mut shops = Vec::new();
    while let Some(done) = jobs.join_next().await {
        if let Ok(v) = done {
            shops.push(v);
        }
    }
    // JoinSet 은 끝난 순서로 준다 — 새로 고칠 때마다 가게 순서가 바뀌면
    // 손님이 어제 본 가게를 못 찾는다. 이름으로 다시 세운다.
    shops.sort_by(|a, b| {
        a["asset"]
            .as_str()
            .unwrap_or("")
            .cmp(b["asset"].as_str().unwrap_or(""))
    });

    Ok(json!({ "shops": shops, "count": shops.len() }))
}

/// 우리 IPFS 게이트웨이에서 프로필 JSON 하나를 읽는다.
///
/// 실패는 전부 `None` 이다 — 못 읽은 이유(안 퍼짐·깨짐·너무 큼)를 나눠 봐야
/// 손님이 할 수 있는 일이 같다.
async fn fetch_profile(client: &reqwest::Client, cid: &str) -> Option<Value> {
    let url = format!("http://127.0.0.1:8080/ipfs/{cid}");
    let r = client.get(&url).send().await.ok()?;
    if !r.status().is_success() {
        return None;
    }
    let body = r.bytes().await.ok()?;
    // 프로필은 글자 몇 줄이다. 누가 CID 자리에 영화를 넣어도 노드가 그걸
    // 통째로 메모리에 올리지는 않는다.
    if body.len() > 256 * 1024 {
        return None;
    }
    serde_json::from_slice::<Value>(&body).ok()
}

/// 체인에서 온 줄과 IPFS 프로필을 하나로 붙인다.
///
/// 🔴 **체인 쪽 값이 항상 이긴다.** 자산 이름과 블록 높이는 아무도 못 고치는
/// 사실이고, 프로필은 사장이 아무 때나 다시 올릴 수 있는 글이다. 프로필이
/// `asset` 을 덮어쓸 수 있으면 가게 하나가 남의 이름으로 목록에 앉는다.
fn merge_profile(row: Value, profile: Option<Value>) -> Value {
    let mut out = row;
    // 🔴 열쇠 이름을 웹(`app/rvn/api/chain/shops`)과 **똑같이** 맞춘다.
    // 장터 화면(`web/shops.html`)은 한 벌뿐이고 매장 노드와 웹 양쪽에서
    // 돌아간다. 한쪽만 `title` 이고 다른 쪽이 `name` 이면, 그 화면은 한 곳에서
    // 조용히 빈 이름을 그린다 — 오류는 안 난다.
    let fallback_title = out["asset"]
        .as_str()
        .unwrap_or("")
        .trim_start_matches("SHOP.")
        .replace('_', " ");

    let Some(p) = profile else {
        out["profile_ok"] = json!(false);
        out["offline"] = json!(true);
        out["title"] = json!(fallback_title);
        out["menu_count"] = json!(0);
        return out;
    };

    let meta = p.pointer("/rip0014/metadata").unwrap_or(&Value::Null);
    let asset_data = meta.get("asset_data").cloned().unwrap_or(Value::Null);
    let other = meta.get("other_data").cloned().unwrap_or(Value::Null);

    let take = |v: &Value, k: &str| -> Option<String> {
        v.get(k)
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string)
    };

    out["profile_ok"] = json!(true);
    out["offline"] = json!(false);
    out["name"] = json!(take(&asset_data, "name"));
    // 사람이 부르는 이름이 없으면 자산 이름을 읽기 좋게 다듬어 쓴다. 대문자와
    // 밑줄뿐인 `SHOP.GANGNAM_CAFE` 는 간판으로 안 읽힌다.
    out["title"] = json!(take(&asset_data, "name").unwrap_or(fallback_title));
    out["description"] = json!(take(&asset_data, "description").unwrap_or_default());
    out["icon"] = json!(take(&asset_data, "icon"));
    out["menu_count"] = json!(other
        .get("menu")
        .and_then(Value::as_array)
        .map(|m| m.len())
        .unwrap_or(0));

    for key in [
        "payment_address",
        "location",
        "phone",
        "menu_cid",
        "order_url",
        "nostr_pubkey",
    ] {
        out[key] = json!(take(&other, key));
    }
    for key in ["delivery", "pickup", "playx_shop"] {
        out[key] = json!(other.get(key).and_then(Value::as_bool).unwrap_or(false));
    }
    for key in ["lat", "lon"] {
        out[key] = json!(other.get(key).and_then(Value::as_f64));
    }
    // 사장이 네 나라 말로 적었으면 그대로 넘긴다. 고르는 것은 화면 몫이다.
    for lang in ["ko", "en", "ja", "zh"] {
        if let Some(s) = take(&other, &format!("name_{lang}")) {
            out[format!("name_{lang}")] = json!(s);
        }
        if let Some(s) = take(&other, &format!("description_{lang}")) {
            out[format!("description_{lang}")] = json!(s);
        }
    }
    out
}

#[cfg(test)]
mod profile_merge_tests {
    use super::*;

    fn chain_row() -> Value {
        json!({ "asset": "SHOP.PLAYX", "ipfs_hash": "Qm1", "block": 3_500_000 })
    }

    fn profile(other: Value) -> Value {
        json!({ "rip0014": { "metadata": {
            "asset_data": { "name": "플레이엑스", "description": "동네 가게" },
            "other_data": other,
        }}})
    }

    /// 프로필이 있으면 이름과 돈 받을 주소가 목록에 실려 나온다.
    /// 이게 안 되면 장터에 버튼이 안 생긴다.
    #[test]
    fn a_readable_profile_fills_in_the_shop() {
        let out = merge_profile(
            chain_row(),
            Some(profile(json!({
                "payment_address": "RLftw4yzCYCTvPw6foMikTjSS98yB1vvwf",
                "nostr_pubkey": "abc123",
                "pickup": true,
            }))),
        );
        assert_eq!(out["name"], json!("플레이엑스"));
        assert_eq!(out["payment_address"], json!("RLftw4yzCYCTvPw6foMikTjSS98yB1vvwf"));
        assert_eq!(out["nostr_pubkey"], json!("abc123"));
        assert_eq!(out["pickup"], json!(true));
        assert_eq!(out["delivery"], json!(false));
        assert_eq!(out["profile_ok"], json!(true));
    }

    /// 🔴 프로필이 자산 이름을 덮어쓰면 가게 하나가 남의 이름으로 앉는다.
    /// 체인에서 온 값이 이겨야 한다.
    #[test]
    fn the_profile_cannot_rename_the_asset() {
        let mut p = profile(json!({}));
        p["rip0014"]["metadata"]["other_data"]["asset"] = json!("SHOP.SOMEONEELSE");
        p["rip0014"]["metadata"]["other_data"]["block"] = json!(1);
        let out = merge_profile(chain_row(), Some(p));
        assert_eq!(out["asset"], json!("SHOP.PLAYX"));
        assert_eq!(out["block"], json!(3_500_000));
    }

    /// 못 읽은 가게도 목록에 남는다 — 조용히 빼면 사장이 원인을 못 찾는다.
    #[test]
    fn an_unreadable_shop_still_appears() {
        let out = merge_profile(chain_row(), None);
        assert_eq!(out["asset"], json!("SHOP.PLAYX"));
        assert_eq!(out["profile_ok"], json!(false));
    }

    /// 빈 문자열은 값이 아니다. 화면이 빈 칸을 그리는 것보다 없는 편이 낫다.
    #[test]
    fn blank_fields_come_back_as_nothing() {
        let out = merge_profile(chain_row(), Some(profile(json!({ "phone": "   " }))));
        assert_eq!(out["phone"], Value::Null);
    }
}

/// 이 컴퓨터가 **어느 가게의 주인인지** 지갑에 물어 알아낸다.
///
/// ## 🔴 왜 필요한가 (실측 2026-08-25)
///
/// 체인에 `SHOP.PLAYX` 가 멀쩡히 있고, 지갑에 소유권 토큰 `SHOP.PLAYX!` 도
/// 있는데, `shop.json` 의 `chain_asset` 만 비어 있었다. 값을 저장하지 않던
/// 시절의 흔적이다. 그 한 칸이 비어 있었을 뿐인데 결과가 이랬다:
///
/// - 화면은 「체인에 가게를 등록하지 않았습니다」라고 말한다 (거짓말이다)
/// - **어느 이름으로 알릴지 몰라 릴레이 공지를 못 올린다**
/// - 그래서 가게를 켜 둬도 세상에서 안 보인다
///
/// 사장에게 「체인 이름이 뭐였죠」라고 물으면 안 된다. **답은 이 컴퓨터
/// 안에 이미 있다.** 소유권 토큰은 이름 끝에 `!` 가 붙고, 그건 그 자산의
/// 주인만 가질 수 있다.
///
/// 여러 개면 `None` 이다 — 골라 주는 것은 우리 일이 아니고, 잘못 고르면
/// 남의 가게 이름으로 공지가 나간다.
#[tauri::command]
pub async fn shop_detect_asset() -> Result<Value, String> {
    let owned = crate::raven::call_rpc("listmyassets", json!(["SHOP*", false, 200, 0])).await?;
    let map = owned.as_object().ok_or("지갑이 목록을 주지 않았습니다.")?;

    let mut found: Vec<String> = map
        .keys()
        // 소유권 토큰만 본다. 수량 1개짜리 `SHOP.PLAYX` 를 갖고 있는 것은
        // 손님도 가능하다 — 주인은 `!` 를 가진 쪽이다.
        .filter_map(|k| k.strip_suffix('!'))
        // 하위 자산·유니크는 가게 자체가 아니다.
        .filter(|k| !k.contains('/') && !k.contains('#'))
        .filter(|k| k.starts_with("SHOP."))
        .map(|k| k.to_string())
        .collect();
    found.sort();
    found.dedup();

    // 🔴 여기서 파일에 쓰지 않는다. `shop.json` 을 쓰는 곳은 화면 쪽 하나뿐이고
    //    (`saveShop`), 쓰는 곳이 둘이 되면 서로 덮어써서 사장이 방금 고친 것이
    //    사라진다. 우리는 **알아낸 것만 돌려준다.**
    if found.len() == 1 {
        return Ok(json!({ "asset": found.remove(0) }));
    }
    Ok(json!({
        "asset": Value::Null,
        // 0개면 정말 등록 안 한 것이고, 여러 개면 우리가 고를 일이 아니다 —
        // 잘못 고르면 남의 가게 이름으로 공지가 나간다.
        "candidates": found,
    }))
}

#[cfg(test)]
mod 되그리기 {
    /// 🔴 **저장은 되는데 화면에 다시 안 그리는 병.**
    ///
    /// 대표님: "가게 정보 기존에 눌러놓은거 있는데 다시 눌러보면 왜 지금
    /// 입력되어 있는 내용이 없지?"
    ///
    /// 지워진 게 아니었다. 값은 `shop.json` 에 멀쩡히 있었는데 `loadShop` 이
    /// **변수에만 담고 칸에는 안 썼다** — 좌표·돈 받을 주소·간판 사진 셋.
    /// 사장 눈에는 「입력한 게 날아갔다」로 보인다. 그게 가장 불안한 화면이다.
    ///
    /// 저장하는 칸이 새로 생길 때마다 이 병이 다시 생긴다. 그래서 검사한다.
    #[test]
    fn 저장한_것은_다시_그린다() {
        let ts = include_str!("../../src/main.ts");
        // 주석은 빼고 본다 — 설명글에 이름이 적혀 있으면 늘 통과한다.
        let 코드: String = ts
            .lines()
            .filter(|l| {
                let t = l.trim_start();
                !t.starts_with("//") && !t.starts_with("*")
            })
            .collect::<Vec<_>>()
            .join("\n");
        let load = 코드
            .split("async function loadShop")
            .nth(1)
            .and_then(|r| r.split("\nasync function ").next())
            .unwrap_or("");
        assert!(load.len() > 200, "loadShop 을 못 읽었습니다");

        // 값이 있는데 화면에 안 그리면 「날아갔다」로 보이는 것들.
        for 칸 in ["sh-addr", "sh-coords", "sh-picprev"] {
            assert!(
                load.contains(칸),
                "`{칸}` 은 파일에 값이 저장되는데 `loadShop` 이 화면에 되쓰지 \
                 않습니다. 사장은 입력한 것이 날아갔다고 생각합니다."
            );
        }
    }
}
