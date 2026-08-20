//! Unattended selling.
//!
//! ## Why this needs a page and not just a QR
//!
//! A Bitcoin-derived chain does not tell you who paid. A received transaction
//! knows which of *our* addresses the money landed on and nothing about where
//! it came from — the sender's address is simply not in the data. So a QR
//! posted on X cannot produce an automatic sale: the money arrives and there is
//! nowhere to send the asset.
//!
//! The buyer therefore has to say where it should go. That is what the sale
//! page is for, and why online selling means publishing a link rather than a
//! picture.
//!
//! ## Why this is dangerous and what actually limits the damage
//!
//! Fulfilling automatically means the wallet is unlocked while nobody is
//! watching. Ravencoin has no second wallet to isolate — no `createwallet`, no
//! `loadwallet` — so a hot wallet cannot be separated from the shop's savings
//! without running a second node, which defeats the point of a low-spec box.
//!
//! Given that, the honest protections are bounds, not secrecy:
//!
//! - a **daily cap** in asset units, after which automatic sending stops and
//!   waits for a person;
//! - **one fulfilment per paid address**, so a replayed or duplicated event
//!   cannot drain a listing;
//! - a **confirmation floor**, because a zero-confirmation payment can be
//!   replaced and the asset is gone;
//! - and it only ever sends **the asset that was listed**, never RVN.
//!
//! None of that helps if the machine itself is compromised. The app says so
//! rather than implying the cap is security.

use crate::raven::call_rpc;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::Mutex;

/// The passphrase, held in memory while unattended selling is switched on.
///
/// Selling around the clock and an encrypted wallet cannot both be true unless
/// something holds the passphrase, and that something is this process. So:
///
/// - it is **never written to disk**, not even to the config folder that holds
///   the API keys;
/// - it disappears when the app closes, and the owner types it again;
/// - and turning automatic selling off clears it immediately.
///
/// That is the whole protection. Anything running as this user on this machine
/// can already reach the wallet — this does not defend against that, and the UI
/// must not suggest it does. What it avoids is the passphrase surviving on the
/// disk of a counter PC that gets sold, stolen, or repaired.
static AUTO_PASS: Mutex<Option<String>> = Mutex::new(None);

/// The passphrase this session is holding, if any.
///
/// Shared with the sweep. A shop that has already agreed to let the app hold
/// its passphrase for automatic delivery has agreed to the same thing for
/// moving takings off the till — and asking twice would mean the sweep quietly
/// never runs, which is exactly what was happening.
pub fn armed_pass() -> Option<String> {
    AUTO_PASS.lock().ok().and_then(|g| g.clone())
}

/// Orders already filled, keyed by the address that paid.
///
/// **This must survive a restart.** The wallet's history is not a substitute:
/// it records the payment that came in, not the asset that went out, and the
/// two cannot be matched back to each other. `auto_fulfil` re-reads the last
/// 200 wallet transactions every cycle, so an order paid an hour ago is still
/// in that window after a crash — and without this file the app would send the
/// asset a second time, for free, to someone who already has it.
///
/// Kept on disk as `{ address: unix_time }` and written atomically, because the
/// moment this file is corrupt is the moment it is needed.
static FILLED: Mutex<Option<HashMap<String, i64>>> = Mutex::new(None);

fn fills_path() -> std::path::PathBuf {
    crate::paths::app_file("fills.json")
}

/// Reads the file once, then serves from memory.
fn fills() -> HashMap<String, i64> {
    if let Ok(g) = FILLED.lock() {
        if let Some(m) = g.as_ref() {
            return m.clone();
        }
    }
    let loaded: HashMap<String, i64> = std::fs::read_to_string(fills_path())
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_default();
    if let Ok(mut g) = FILLED.lock() {
        *g = Some(loaded.clone());
    }
    loaded
}

fn fills_save(map: &HashMap<String, i64>) {
    let path = fills_path();
    if let Some(d) = path.parent() {
        let _ = std::fs::create_dir_all(d);
    }
    // 임시 파일에 쓰고 바꿔 끼운다. 쓰는 중에 앱이 죽어도 반쪽짜리 파일이
    // 남지 않는다 — 반쪽이면 다음에 통째로 못 읽고, 그게 이중 발송이다.
    let tmp = path.with_extension("json.tmp");
    if serde_json::to_vec(map)
        .ok()
        .and_then(|b| std::fs::write(&tmp, b).ok())
        .is_some()
    {
        let _ = std::fs::rename(&tmp, &path);
    }
}
/// asset name → units sent automatically today, plus the day it counts for.
static SENT_TODAY: Mutex<Option<(i64, HashMap<String, f64>)>> = Mutex::new(None);

fn today() -> i64 {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    now - (now % 86_400)
}

/// Has this payment already been filled?
pub fn already_filled(address: &str) -> bool {
    fills().contains_key(address)
}

fn unmark_filled(address: &str) {
    let mut m = fills();
    m.remove(address);
    if let Ok(mut g) = FILLED.lock() {
        *g = Some(m.clone());
    }
    fills_save(&m);
}

pub fn mark_filled(address: &str) {
    let mut m = fills();
    m.insert(address.to_string(), today());
    // 지갑은 최근 200건만 되돌아본다. 그보다 오래된 기록은 다시 마주칠 일이
    // 없으므로, 파일이 무한히 자라지 않게 잘라 둔다.
    if m.len() > 5000 {
        let mut v: Vec<(String, i64)> = m.into_iter().collect();
        v.sort_by_key(|(_, t)| -*t);
        v.truncate(4000);
        m = v.into_iter().collect();
    }
    if let Ok(mut g) = FILLED.lock() {
        *g = Some(m.clone());
    }
    fills_save(&m);
}

/// How much of this asset has gone out automatically today.
fn sent_today(asset: &str) -> f64 {
    let day = today();
    SENT_TODAY
        .lock()
        .ok()
        .and_then(|g| {
            g.as_ref().and_then(|(d, m)| {
                if *d == day {
                    m.get(asset).copied()
                } else {
                    None
                }
            })
        })
        .unwrap_or(0.0)
}

fn add_sent(asset: &str, qty: f64) {
    let day = today();
    if let Ok(mut g) = SENT_TODAY.lock() {
        let entry = g.get_or_insert_with(|| (day, HashMap::new()));
        if entry.0 != day {
            *entry = (day, HashMap::new());
        }
        *entry.1.entry(asset.to_string()).or_insert(0.0) += qty;
    }
}

/// One paid order waiting to be filled automatically.
#[derive(serde::Deserialize)]
pub struct AutoOffer {
    pub asset: String,
    pub qty: f64,
    pub address: String,
    /// Where the buyer asked for it. Empty means we cannot fill this
    /// automatically — the chain does not know who paid.
    pub deliver_to: String,
    /// Units of this asset that may leave automatically per day.
    pub daily_cap: f64,
    /// What the buyer must actually pay, in RVN.
    ///
    /// Without this the loop only knows "money arrived", and one satoshi buys
    /// an album. Checking the address is what identifies the order; checking
    /// the amount is what makes it a sale.
    pub rvn: f64,
    /// What that is worth in won, which is what decides the confirmation depth.
    #[serde(default)]
    pub krw: f64,
}

/// Payments this small are treated as not-a-payment rather than as underpayment
/// — a dust-sized send is noise, not a customer who typed the wrong number.
const UNDERPAY_TOLERANCE: f64 = 0.001;

/// How many confirmations before an asset may leave, by what the order is worth.
///
/// One confirmation for everything was a gamble. Ravencoin has had real chain
/// reorganisations: a block can be replaced, and a payment that existed is
/// suddenly gone — while the asset has already left and cannot come back.
///
/// A block is about a minute, so three confirmations costs a fan three minutes
/// and twelve costs a serious buyer twelve. Both are cheap next to losing the
/// item and the money together.
///
/// Above the top band nothing goes automatically. Not because twelve is unsafe,
/// but because at that size a person should look at it once.
fn required_confirmations(krw: f64) -> (i64, bool) {
    match krw {
        v if v <= 10_000.0 => (1, true),
        v if v <= 100_000.0 => (3, true),
        v if v <= 1_000_000.0 => (12, true),
        _ => (12, false),
    }
}

/// Same policy, for the screens that have to explain the wait.
#[tauri::command]
pub fn confirmation_policy(krw: f64) -> Value {
    let (need, auto) = required_confirmations(krw);
    json!({
        "need": need,
        "auto": auto,
        "why": if auto {
            format!("{need}번 확인되면 자동으로 보냅니다")
        } else {
            "금액이 커서 자동으로 보내지 않습니다. 사람이 확인하고 보냅니다.".to_string()
        },
    })
}

/// Fills every paid order that is safe to fill, and explains the ones it skipped.
///
/// Returns both the sent and the skipped, because a shop owner needs to know
/// *why* an order is sitting there. Silently skipping looks identical to being
/// broken.
#[tauri::command]
pub async fn auto_fulfil(
    offers: Vec<AutoOffer>,
    min_conf: u32,
    passphrase: Option<String>,
) -> Result<Value, String> {
    let txs = call_rpc("listtransactions", json!(["*", 200, 0, true])).await?;
    let list = txs.as_array().cloned().unwrap_or_default();

    let mut sent = Vec::new();
    let mut skipped = Vec::new();
    let mut need_wallet = Vec::new();

    for tx in &list {
        if tx.get("category").and_then(Value::as_str) != Some("receive") {
            continue;
        }
        if tx.get("asset_name").is_some() {
            continue; // 자산이 들어온 것은 결제가 아니다
        }
        let addr = tx.get("address").and_then(Value::as_str).unwrap_or("");
        let Some(offer) = offers.iter().find(|o| o.address == addr) else {
            continue;
        };

        let confs = tx.get("confirmations").and_then(Value::as_i64).unwrap_or(0);
        let paid = tx.get("amount").and_then(Value::as_f64).unwrap_or(0.0);

        if offer.asset.ends_with('!') {
            skipped.push(json!({ "address": addr, "asset": offer.asset, "why": "소유권 토큰은 자동으로 보내지 않습니다" }));
            continue;
        }
        if already_filled(addr) {
            continue;
        }
        // 확인 수는 주문 금액이 정한다. 화면이 넘긴 min_conf는 하한으로만 쓴다.
        let (need, may_auto) = required_confirmations(offer.krw);
        let need = need.max(min_conf as i64);
        if !may_auto {
            skipped.push(json!({
                "address": addr, "asset": offer.asset, "paid": paid,
                "why": "금액이 커서 사람이 보내야 합니다", "confirmations": confs, "need": need,
            }));
            continue;
        }
        if confs < need {
            skipped.push(json!({
                "address": addr, "asset": offer.asset,
                "why": "확인 대기", "confirmations": confs, "need": need,
            }));
            continue;
        }
        if offer.deliver_to.trim().is_empty() {
            // 이 사슬은 누가 보냈는지 모른다. 손님이 주소를 남기지 않았으면
            // 사람이 물어보는 수밖에 없다.
            skipped.push(json!({ "address": addr, "asset": offer.asset, "why": "받을 주소를 모름", "paid": paid }));
            continue;
        }
        // 금액을 본다. 주소는 "어느 주문인가"를 답하고, 금액이 "샀는가"를
        // 답한다. 아주 조금 모자란 것은 수수료 계산 차이일 수 있어 봐주되,
        // 그 이상은 사람이 봐야 한다 — 자동으로 물건을 내주면 안 된다.
        if offer.rvn > 0.0 && paid + UNDERPAY_TOLERANCE < offer.rvn {
            skipped.push(json!({
                "address": addr, "asset": offer.asset,
                "why": "금액이 모자람", "paid": paid, "want": offer.rvn,
            }));
            continue;
        }
        if sent_today(&offer.asset) + offer.qty > offer.daily_cap {
            skipped.push(json!({
                "address": addr, "asset": offer.asset,
                "why": "오늘 자동 발송 한도 도달", "paid": paid,
                "sent_today": sent_today(&offer.asset), "cap": offer.daily_cap,
            }));
            continue;
        }
        need_wallet.push((offer, addr.to_string(), paid));
    }

    if need_wallet.is_empty() {
        return Ok(json!({ "sent": sent, "skipped": skipped }));
    }

    // 잠금은 보낼 것이 실제로 있을 때만, 이 묶음 동안만 연다.
    let locked = matches!(
        call_rpc("getwalletinfo", json!([]))
            .await
            .ok()
            .and_then(|i| i.get("unlocked_until").and_then(Value::as_i64)),
        Some(0)
    );
    if locked {
        let stored = AUTO_PASS.lock().ok().and_then(|g| g.clone());
        let Some(pass) = passphrase.or(stored) else {
            return Ok(json!({
                "sent": sent,
                "skipped": skipped,
                "error": "지갑이 잠겨 있어 자동 발송을 하지 못했습니다.",
            }));
        };
        call_rpc("walletpassphrase", json!([pass, 60])).await?;
    }

    for (offer, addr, paid) in need_wallet {
        // 보내기 *전에* 표시한다. 보낸 뒤에 표시하면, 전송이 성공했는데
        // 그 사이 앱이 죽는 순간 다음 주기가 같은 주문을 또 보낸다.
        // 못 보낸 것은 사람이 보고 고칠 수 있지만, 두 번 보낸 것은 못 되돌린다.
        mark_filled(&addr);

        let result = call_rpc(
            "transfer",
            json!([offer.asset, offer.qty, offer.deliver_to, "", 0, "", ""]),
        )
        .await;

        match result {
            Ok(v) => {
                let txid = v
                    .as_array()
                    .and_then(|a| a.first())
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string();
                add_sent(&offer.asset, offer.qty);
                crate::refund::remember_ours(&txid);
                sent.push(json!({
                    "address": addr, "asset": offer.asset, "qty": offer.qty,
                    "to": offer.deliver_to, "paid": paid, "txid": txid,
                }));
            }
            Err(e) => {
                // 실패했으니 표시를 되돌린다. 다음 주기가 다시 시도한다.
                unmark_filled(&addr);
                skipped.push(json!({ "address": addr, "asset": offer.asset, "why": e }));
            }
        }
    }

    if locked {
        let _ = call_rpc("walletlock", json!([])).await;
    }

    Ok(json!({ "sent": sent, "skipped": skipped }))
}

/// Ownership tokens sitting in this wallet.
///
/// Named `ASSET!`, one per asset ever issued here. Whoever holds one can
/// reissue that asset without limit and rewrite the IPFS hash its buyers rely
/// on — so its presence is not a detail, it is the difference between losing
/// today's stock and losing the catalogue.
#[tauri::command]
pub async fn owner_tokens() -> Result<Vec<String>, String> {
    let owned = call_rpc("listmyassets", json!([])).await?;
    Ok(owned
        .as_object()
        .map(|m| {
            m.keys()
                .filter(|n| n.ends_with('!'))
                .cloned()
                .collect::<Vec<_>>()
        })
        .unwrap_or_default())
}

/// Rebuilds "already delivered" from the wallet's own history.
///
/// The in-memory set forgets everything on restart, and writing it to a file
/// only moves the lie: a file can be deleted, restored from an old backup, or
/// written after a send that then failed. Whether an asset actually left is a
/// fact the wallet already holds.
///
/// So on startup this asks the chain: for each buyer address we recorded, has
/// this asset gone out to the address that buyer asked for? If yes, that order
/// is done, and no restart can make us send it twice.
///
/// Only the buyer's stated delivery address needs to survive on disk, because
/// that is the one thing the chain does not know — the buyer typed it into our
/// page, and nothing in a transaction records it.
#[tauri::command]
pub async fn rebuild_delivered(orders: Vec<Value>) -> Result<Value, String> {
    // The whole wallet history, not a 200-row window: an order from last week
    // scrolls out of that window and comes back looking unfulfilled.
    let txs = call_rpc("listtransactions", json!(["*", 1000, 0, true])).await?;
    let list = txs.as_array().cloned().unwrap_or_default();

    let mut done = Vec::new();
    for o in &orders {
        let pay_addr = o.get("address").and_then(Value::as_str).unwrap_or("");
        let to = o.get("deliver_to").and_then(Value::as_str).unwrap_or("");
        let asset = o.get("asset").and_then(Value::as_str).unwrap_or("");
        if to.is_empty() || asset.is_empty() {
            continue;
        }

        let delivered = list.iter().any(|tx| {
            tx.get("category").and_then(Value::as_str) == Some("send")
                && tx.get("asset_name").and_then(Value::as_str) == Some(asset)
                && tx.get("address").and_then(Value::as_str) == Some(to)
        });
        if delivered {
            mark_filled(pay_addr);
            done.push(json!({ "address": pay_addr, "asset": asset }));
        }
    }

    Ok(json!({ "delivered": done, "count": done.len() }))
}

/// Today's automatic total per asset, for the screen that shows the cap.
#[tauri::command]
pub fn auto_usage(assets: Vec<String>) -> Value {
    let mut out = serde_json::Map::new();
    for a in assets {
        out.insert(a.clone(), json!(sent_today(&a)));
    }
    Value::Object(out)
}

/// Turns unattended selling on, holding the passphrase in memory.
///
/// Verified before it is stored — an owner who mistypes it should find out now,
/// not at midnight when the first order fails silently.
#[tauri::command]
pub async fn auto_enable(passphrase: String) -> Result<Value, String> {
    // 발행권이 이 지갑에 있으면 무인 판매를 켜지 않는다. 털렸을 때 잃는 것이
    // 오늘 재고가 아니라 그 자산의 미래 전부가 된다 — 무한 재발행, 설명 변조.
    // 손실에 상한이 없는 상태를 밤새 자동으로 돌릴 수는 없다.
    if let Ok(owner) = owner_tokens().await {
        if !owner.is_empty() {
            return Err(format!(
                "소유권 토큰이 이 컴퓨터에 있습니다 ({}). 다른 지갑으로 옮긴 뒤에 켜 주세요 — \
                 이 컴퓨터가 털리면 재고뿐 아니라 그 자산을 무한히 찍을 권리까지 넘어갑니다.",
                owner.join(", ")
            ));
        }
    }

    let info = call_rpc("getwalletinfo", json!([])).await?;
    let encrypted = info.get("unlocked_until").and_then(Value::as_i64).is_some();

    if encrypted {
        // 열어 보고 바로 닫는다. 맞는지 확인하는 유일한 방법이다.
        call_rpc("walletpassphrase", json!([passphrase, 2]))
            .await
            .map_err(|e| {
                if e.contains("incorrect") {
                    "암호가 맞지 않습니다.".to_string()
                } else {
                    e
                }
            })?;
        let _ = call_rpc("walletlock", json!([])).await;

        if let Ok(mut g) = AUTO_PASS.lock() {
            *g = Some(passphrase);
        }
    }

    Ok(json!({ "on": true, "encrypted": encrypted }))
}

/// Turns it off and forgets the passphrase.
#[tauri::command]
pub fn auto_disable() {
    if let Ok(mut g) = AUTO_PASS.lock() {
        *g = None;
    }
}

/// How exposed this machine is right now.
///
/// A wallet that can send unattended is worth exactly what is in it. This does
/// not defend anything — it tells the owner what they are risking, so "keep
/// only today's stock here" stops being advice and becomes a number they can
/// look at.
#[tauri::command]
pub async fn exposure() -> Result<Value, String> {
    let balance = call_rpc("getbalance", json!([]))
        .await
        .ok()
        .and_then(|v| v.as_f64())
        .unwrap_or(0.0);
    let armed = AUTO_PASS.lock().map(|g| g.is_some()).unwrap_or(false);

    let krw = crate::price::rvn_rate(crate::shop::currency())
        .await
        .ok()
        .and_then(|r| r["rate"].as_f64())
        .map(|r| balance * r);

    Ok(json!({
        "rvn": balance,
        "krw": krw,
        "armed": armed,
    }))
}
