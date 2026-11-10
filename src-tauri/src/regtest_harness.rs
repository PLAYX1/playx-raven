//! regtest(가짜 사슬) 통합 시험 전용 입구 — `--features regtest-harness` 일 때만 들어간다.
//!
//! 출시 빌드에는 이 파일이 없다. 하는 일은 crate 안 함수를 **그대로** 부르는 얇은 껍데기뿐이고,
//! 동작을 바꾸는 것은 없다. 시험은 `tests/market_regtest.rs` 를 본다.
//!
//! 누구로 부르나(파는 쪽/사는 쪽)는 부르기 전에 `PLAYX_RAVEN_HOME` 을 바꿔 정한다 —
//! 그 폴더의 `raven-datadir.txt` 가 노드 폴더(쿠키·rpcport), `talkkey.json` 이 글 열쇠다.

use serde_json::Value;

pub async fn rpc(method: &str, params: Value) -> Result<Value, String> {
    crate::raven::call_rpc(method, params).await
}

pub async fn swap_make_lot(asset: String, amount: f64, passphrase: Option<String>) -> Result<Value, String> {
    crate::swap::swap_make_lot(asset, amount, passphrase).await
}
pub async fn swap_offer(asset: String, amount: f64, price: f64, passphrase: Option<String>) -> Result<Value, String> {
    crate::swap::swap_offer(asset, amount, price, passphrase).await
}
pub async fn swap_take(hex: String, broadcast: bool, passphrase: Option<String>) -> Result<Value, String> {
    crate::swap::swap_take(hex, broadcast, passphrase, None).await
}
pub async fn market_publish_listing(offer_hex: String, title: String, summary: String, category: String) -> Result<Value, String> {
    crate::market_listing::market_publish_listing(offer_hex, title, summary, category, None).await
}
pub async fn market_browse(category: Option<String>) -> Result<Value, String> {
    crate::market_listing::market_browse(category, None).await
}
pub async fn market_my_listings() -> Result<Value, String> {
    crate::market_listing::market_my_listings().await
}
pub async fn market_cancel_listing(d: String, passphrase: Option<String>) -> Result<Value, String> {
    crate::market_listing::market_cancel_listing(d, passphrase).await
}
pub async fn swap_take_listing(listing: Value, broadcast: bool, passphrase: Option<String>) -> Result<Value, String> {
    // 앱과 같은 길: 보내기 전에 미리 보고, 그 값(check)을 넘긴다.
    let expect = if broadcast {
        Some(crate::market_listing::swap_take_listing(listing.clone(), false, passphrase.clone(), None).await?["check"].clone())
    } else {
        None
    };
    crate::market_listing::swap_take_listing(listing, broadcast, passphrase, expect).await
}

/// 사는 쪽이 하는 확인 그대로(서명 → 모양 → 체인). 통과하면 Ok, 아니면 한국어 이유.
pub async fn check_event(ev: &Value) -> Result<(), String> {
    if !crate::relay::verify(ev) {
        return Err("글의 서명이 맞지 않습니다.".into());
    }
    let l = crate::market_listing::parse_listing(ev)?;
    crate::market_listing::chain_check_for_harness(&l).await.map(|_| ())
}

/// 릴레이에서 그 글쓴이의 장터 글(서명 확인된 것)을 읽는다.
pub async fn listing_events(pubkey: &str) -> Result<Vec<Value>, String> {
    let r = crate::nostrpub::nostr_query(vec![30402], vec![pubkey.to_string()], vec![]).await?;
    Ok(r["events"].as_array().cloned().unwrap_or_default().into_iter().filter(crate::relay::verify).collect())
}

/// 글 하나를 그 열쇠로 **다시 서명**한다(태그를 고친 위조 글 만들기 — 서명은 맞고 내용은 거짓).
pub fn resign(sk_hex: &str, ev: &Value) -> Result<Value, String> {
    let b = hex::decode(sk_hex).map_err(|e| e.to_string())?;
    let mut sk = [0u8; 32];
    sk.copy_from_slice(&b);
    crate::shopkey::sign_with(
        &sk,
        ev["kind"].as_i64().unwrap_or(0),
        ev["tags"].clone(),
        ev["content"].as_str().unwrap_or(""),
        ev["created_at"].as_i64().unwrap_or(0),
    )
}

pub fn pubkey_of(sk_hex: &str) -> Result<String, String> {
    let b = hex::decode(sk_hex).map_err(|e| e.to_string())?;
    let mut sk = [0u8; 32];
    sk.copy_from_slice(&b);
    crate::shopkey::pubkey_of(&sk)
}

/// 앱 안 릴레이(`relay::serve`)를 임의 포트에 띄운다. 돌려주는 값은 `ws://…/api/relay`.
pub async fn start_relay() -> String {
    let app = axum::Router::new().route(
        "/api/relay",
        axum::routing::get(|ws: axum::extract::ws::WebSocketUpgrade| async {
            ws.max_message_size(512 * 1024).max_frame_size(512 * 1024).on_upgrade(crate::relay::serve)
        }),
    );
    let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.expect("relay bind");
    let addr = l.local_addr().expect("relay addr");
    tokio::spawn(async move {
        let _ = axum::serve(l, app).await;
    });
    format!("ws://{addr}/api/relay")
}

// ── 0.9.18 폰에서 판매: 폰은 시험 열쇠로 흉내(서명만), 데스크탑 쪽은 앱 함수 그대로 ──────────────
pub fn wl_link_phone(desk_sk: &str, phone_sk: &str, daily: u32) -> Result<(String, String), String> {
    crate::wallet_link::harness::link_phone(desk_sk, phone_sk, daily)
}
pub fn wl_phone_sign(phone_sk: &str, tag: &str, body: Value) -> Result<Value, String> {
    crate::wallet_link::harness::phone_sign(phone_sk, tag, body)
}
pub fn wl_deliver(desk_sk: &str, phone_sk: &str, t: &str, s: &Value) -> Result<(), String> {
    crate::wallet_link::harness::deliver_from_phone(desk_sk, phone_sk, t, s)
}
pub async fn wl_tick(desk_sk: &str) -> Result<Value, String> {
    crate::wallet_link::harness::tick(desk_sk).await
}
pub async fn wl_continue(desk_sk: &str, id: &str, pass: &str) -> Result<(), String> {
    crate::wallet_link::harness::continue_sell(desk_sk, id, pass).await
}
pub fn wl_job(id: &str) -> Result<Value, String> {
    crate::wallet_link::harness::job(id)
}
pub fn wl_verify(tag: &str, s: &Value, key: &str) -> bool {
    crate::wallet_link::harness::verify(tag, s, key)
}
pub fn wl_recheck_now(id: &str) -> Result<(), String> {
    crate::wallet_link::harness::recheck_now(id)
}
