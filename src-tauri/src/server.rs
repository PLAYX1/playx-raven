//! The phone server.
//!
//! One HTTP server on the local network serving two completely different
//! audiences from two completely different permission sets:
//!
//! - **`/` — the customer.** No login. Sees the shop, the menu, and can ask a
//!   question. Can obtain an address to pay to. Cannot see the wallet, cannot
//!   spend, cannot learn what else this node holds.
//! - **`/admin` — the owner.** Requires a token. Can do the things the desktop
//!   app can do, from a phone, anywhere on the same network.
//!
//! ## Why the split is enforced here and not in the UI
//!
//! This binds to 0.0.0.0, because a server on 127.0.0.1 cannot be reached by a
//! phone. That means everyone on the café's wifi can reach it — the staff, the
//! customers, and whoever is sitting outside with a laptop. So "the customer
//! page has no wallet buttons" is not a security property; only "the customer
//! routes cannot call wallet code" is. They are separate routers, and the
//! customer router has no access to a spend path at all.
//!
//! ## The token
//!
//! Generated fresh on every start from the OS random source, never written to
//! disk, and shown as a QR code in the desktop app. Restarting the app
//! invalidates every phone that was logged in, which is the correct behaviour
//! for a device that lives on a counter.

use axum::{
    extract::{Query, State},
    http::{header, HeaderMap, StatusCode},
    response::{Html, IntoResponse},
    routing::{get, post},
    Json, Router,
};
use serde_json::{json, Value};
use std::sync::{Arc, Mutex};

pub const PORT: u16 = 8790;

#[derive(Clone)]
pub struct ServerState {
    /// Owner token. Compared in constant time; see `token_ok`.
    /// The owner's own token.
    ///
    /// Mutable on purpose. It used to be an immutable `Arc<String>`, which meant
    /// a lost owner phone could only be cut off by restarting the whole app —
    /// and nobody standing in a shop with a missing phone knows that. Losing a
    /// phone is the ordinary emergency here; it must have a button.
    token: Arc<Mutex<String>>,
    /// One token per role. A staff phone that leaves with an employee is
    /// revoked by rotating that one entry, without stopping the counter.
    role_tokens: Arc<Mutex<std::collections::HashMap<String, String>>>,
    /// What the customer page shows. Published by the desktop app rather than
    /// read from the chain per request — a phone refresh must not be able to
    /// make this node do RPC work on demand.
    shop: Arc<Mutex<Value>>,
    /// Which provider answers customer questions, empty for none.
    ai: Arc<Mutex<String>>,
    /// (fetched_at, shop list). Keeps a phone refresh from re-walking the
    /// chain on a machine that is also running a shop.
    shops_cache: Arc<Mutex<Option<(i64, Value)>>>,
    /// (day_start_unix, asked_today, last_ask_unix) for the customer question
    /// box. See `ASK_PER_DAY`.
    ask_budget: Arc<Mutex<(i64, u32, i64)>>,
    /// Public listings by id, as the sale page shows them.
    offers: Arc<Mutex<std::collections::HashMap<String, Value>>>,
    /// pay address → (listing id, where the buyer wants it delivered)
    claims: Arc<Mutex<std::collections::HashMap<String, (String, String)>>>,
    /// Pay addresses whose asset has already gone out.
    ///
    /// **Never pruned by size.** It is tempting — the set only grows — but this
    /// is an idempotency guard, and forgetting an entry means sending an asset
    /// twice for one payment. A few hundred kilobytes of addresses is a much
    /// cheaper problem than that. The durable copy lives in `fills.json`.
    sent: Arc<Mutex<std::collections::HashSet<String>>>,
    /// Order state by pay address: (state, changed_at, ticket number).
    ///
    /// A shop needs more than "paid". A customer standing there needs to know
    /// whether their coffee is being made or waiting on the counter, and the
    /// only way they find out today is by asking.
    order_state: Arc<Mutex<std::collections::HashMap<String, (String, i64, u32)>>>,
    /// 주문을 만든 시각들. 스팸을 막는 유일한 근거다.
    ///
    /// 🔴 이 자물쇠가 없으면 낯선 사람이 와이파이만 잡고 `/api/order` 를
    /// 두드려 **지갑 주소를 무한히 만들 수 있다.** 실측: 0.16초에 한 개,
    /// 시간당 2만 개. 주소는 wallet.dat 에 영원히 남아 파일이 붓고 복구
    /// 스캔이 느려진다. 터널을 켜면 인터넷 어디서나 할 수 있다.
    ///
    /// 손님 경로라 열쇠를 요구할 수 없다 — 카운터에서 QR 찍은 사람에게
    /// 로그인을 시킬 수는 없다. 그래서 **속도**로 막는다.
    order_times: Arc<Mutex<Vec<i64>>>,
    /// 주문 주소 → 테이블 번호.
    ///
    /// `order_state` 튜플에 끼워 넣지 않는다. 그 튜플은 여섯 군데에서 풀어
    /// 쓰이는데, 자리를 하나 늘리면 여섯 군데를 다 고쳐야 하고 그중 하나를
    /// 빠뜨리면 컴파일은 되면서 값만 어긋난다.
    order_table: Arc<Mutex<std::collections::HashMap<String, String>>>,
    /// 이 주소로 **얼마가 들어와야** 이 주문이 결제된 것인가.
    ///
    /// 🔴 여태 이 값이 없었다. `sweep_payments` 는 "그 주소로 돈이 왔는가" 만
    /// 보고 금액을 대조하지 않아서, 1,183 RVN 짜리 커피에 1 RVN 을 보내도
    /// 「결제 확인됨」이 떴다. 체인은 보낸 만큼만 보내 준다 — 모자란 것을
    /// 알아채는 것은 우리 몫이다.
    ///
    /// 수수료를 떼는 가게에서는 이 값이 총액이 아니라 **가게 몫**이다.
    order_expect: Arc<Mutex<std::collections::HashMap<String, f64>>>,
    /// 이 주문의 견적이 언제까지인가.
    ///
    /// 🔴 화면은 "5분 안에 보내세요, 지나면 다시 주문해 주세요" 라고 적어
    /// 두는데 `sweep_payments` 는 그걸 보지 않았다. 만료된 QR 로 **옛 금액**을
    /// 보내도 결제가 됐다 — 시세가 오르면 가게가 그만큼 덜 받는다.
    order_until: Arc<Mutex<std::collections::HashMap<String, i64>>>,
    /// Next ticket number. Customers cannot read an address; they can read 14.
    next_ticket: Arc<Mutex<u32>>,
    /// 번호가 어느 날짜의 것인가. 날이 바뀌면 1번부터 다시 센다.
    ticket_day: Arc<Mutex<i64>>,
    /// Has the owner opened the till and staff screens to the internet?
    ///
    /// False by default. A tunnel forwards the whole port, and three of the
    /// four screens behind it are not for strangers. See `outside_blocked`.
    remote_admin: Arc<Mutex<bool>>,
    /// When the chain was last swept for arriving payments.
    ///
    /// Every waiting phone asks this node "has my money landed yet" every few
    /// seconds. Asking the chain once per phone means ten customers make ten
    /// times the RPC load, and the node answers on four HTTP threads. One sweep
    /// answers all of them, because the sweep is not per-address — it reads the
    /// wallet's recent receives once and updates every order at the same time.
    last_sweep: Arc<Mutex<i64>>,
}

/// The states an order actually passes through in a shop.
///
/// Deliberately short. Every extra state is one more thing a busy person has to
/// press, and an order flow nobody updates is worse than none — the customer
/// learns the screen lies.
const STATES: [&str; 4] = ["paid", "making", "ready", "done"];

/// Before any of them: the order exists, the money does not.
///
/// Not in `STATES` on purpose. A shop can move an order forward, but nobody
/// gets to *declare* that money arrived — only the chain does that, in
/// `sweep_payments`. Leaving this out of the settable set is what keeps a
/// mis-tap on the counter screen from confirming a payment nobody made.
const WAITING: &str = "waiting";
/// 돈은 왔는데 모자란다. 조용히 기다리게 두면 손님은 낸 줄 알고 서 있고,
/// 가게는 안 온 줄 알고 안 만든다 — 둘 다 상대가 잘못했다고 생각한다.
const SHORT: &str = "short";
/// 견적이 지난 뒤에 온 돈. 시세가 움직였을 수 있어 사장이 보고 정한다.
const EXPIRED: &str = "expired";

/// 1분에 이만큼까지만 새 주문을 만든다.
///
/// 바쁜 카운터도 분당 20건을 넘지 않는다 — 3초에 한 명씩 결제하는 속도다.
/// 넘으면 사람이 아니라 기계다.
const ORDERS_PER_MIN: usize = 20;
/// 하루 상한. 분당 제한만 두면 하루 종일 천천히 두드려 2만 개를 만든다.
const ORDERS_PER_DAY: usize = 2_000;

/// The customer question box answers without the owner pressing anything, and
/// every answer is billed to the owner's own API key. Left uncapped it is a
/// card terminal someone left switched on: one bored person with a phone can
/// spend more in an evening than the shop makes.
///
/// So it is capped by day and spaced by seconds. When the cap is hit, the box
/// says the shop is not answering right now rather than failing silently —
/// a customer who gets no reply thinks the shop is broken.
const ASK_PER_DAY: u32 = 200;
const ASK_MIN_GAP_SECS: i64 = 3;

fn now_unix() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// Consumes one question from today's budget, or explains why not.
fn take_ask_budget(state: &ServerState) -> Result<u32, String> {
    let now = now_unix();
    let day = now - (now % 86_400);
    let mut b = state
        .ask_budget
        .lock()
        .map_err(|_| "잠금 실패".to_string())?;

    if b.0 != day {
        *b = (day, 0, 0);
    }
    if now - b.2 < ASK_MIN_GAP_SECS {
        return Err("잠시 후 다시 물어봐 주세요.".into());
    }
    if b.1 >= ASK_PER_DAY {
        return Err("오늘은 자동 응대를 더 할 수 없습니다. 가게에 직접 물어봐 주세요.".into());
    }
    b.1 += 1;
    b.2 = now;
    Ok(ASK_PER_DAY - b.1)
}

/// 32 bytes from the OS. Not a timestamp, not a counter: this is the only thing
/// standing between a stranger on the same wifi and the owner's controls.
/// Where the phone tokens live between runs.
///
/// ## Why they must survive a restart
///
/// This program is meant for a Mac mini on a shelf with no monitor. Generating
/// fresh tokens at every start means a power cut invalidates every phone in the
/// shop — and there is no screen on which to show the new QR codes. The shop
/// locks itself and the only way back in is to plug in a monitor.
///
/// So the tokens are written once and reused. Rotating them stays deliberate:
/// `logout_all_phones` is the button, and it is the only thing that changes
/// them.
fn tokens_path() -> std::path::PathBuf {
    crate::paths::app_file("tokens.json")
}

fn load_tokens() -> Option<(String, std::collections::HashMap<String, String>)> {
    let v: Value = serde_json::from_str(&std::fs::read_to_string(tokens_path()).ok()?).ok()?;
    let owner = v.get("owner")?.as_str()?.to_string();
    if owner.len() < 32 {
        return None;
    }
    let mut roles = std::collections::HashMap::new();
    for r in ["staff", "scanner"] {
        roles.insert(
            r.to_string(),
            v.get(r).and_then(Value::as_str).unwrap_or("").to_string(),
        );
    }
    if roles.values().any(|t| t.len() < 32) {
        return None;
    }
    Some((owner, roles))
}

fn save_tokens(owner: &str, roles: &std::collections::HashMap<String, String>) {
    let path = tokens_path();
    if let Some(d) = path.parent() {
        let _ = std::fs::create_dir_all(d);
    }
    let doc = json!({
        "owner": owner,
        "staff": roles.get("staff").cloned().unwrap_or_default(),
        "scanner": roles.get("scanner").cloned().unwrap_or_default(),
    });
    let tmp = path.with_extension("json.tmp");
    if serde_json::to_vec_pretty(&doc)
        .ok()
        .and_then(|b| std::fs::write(&tmp, b).ok())
        .is_some()
    {
        let _ = std::fs::rename(&tmp, &path);
        // 이 파일은 가게 화면을 여는 열쇠다. 노드의 .cookie 와 같은 급으로 잠근다.
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
        }
    }
}

fn random_token() -> String {
    let mut buf = [0u8; 32];
    if std::fs::File::open("/dev/urandom")
        .and_then(|mut f| {
            use std::io::Read;
            f.read_exact(&mut buf)
        })
        .is_err()
    {
        // Refuse rather than fall back to something guessable. A weak token
        // that looks like a token is worse than no remote access.
        return String::new();
    }
    buf.iter().map(|b| format!("{b:02x}")).collect()
}

/// Constant-time comparison.
///
/// A short-circuiting `==` leaks how many leading characters were right, and
/// over a local network that is enough to recover a token byte by byte.
fn token_ok(expected: &str, given: &str) -> bool {
    if expected.is_empty() || expected.len() != given.len() {
        return false;
    }
    expected
        .bytes()
        .zip(given.bytes())
        .fold(0u8, |acc, (a, b)| acc | (a ^ b))
        == 0
}

/// Which role this request is carrying, if any.
///
/// Returns the role rather than a boolean so the caller can apply the right
/// rule — "authenticated" is not a permission, and treating it as one is how a
/// staff token ends up spending money.
fn role_of(state: &ServerState, headers: &HeaderMap, q: &Value) -> Option<String> {
    let given = headers
        .get("x-playx-token")
        .and_then(|v| v.to_str().ok())
        .map(str::to_string)
        .or_else(|| q.get("t").and_then(Value::as_str).map(str::to_string))
        .unwrap_or_default();
    if given.is_empty() {
        return None;
    }
    let owner = state.token.lock().map(|t| t.clone()).unwrap_or_default();
    if token_ok(&owner, &given) {
        return Some("owner".to_string());
    }
    state.role_tokens.lock().ok().and_then(|m| {
        m.iter()
            .find(|(_, t)| token_ok(t, &given))
            .map(|(r, _)| r.clone())
    })
}

/// Did this request come from the internet rather than the shop's own network?
///
/// The tunnel forwards to `127.0.0.1:8790`, so the source address is useless —
/// everything looks local. What survives is the **Host header**: a phone on the
/// shop wifi asks for `192.168.x.x:8790`, and a stranger asks for the tunnel's
/// public hostname. That difference is the only thing distinguishing the two,
/// and it is enough because a request that lies about Host cannot then be
/// answered at the address it claimed.
fn from_outside(headers: &HeaderMap) -> bool {
    let host = headers
        .get("host")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .split(':')
        .next()
        .unwrap_or("")
        .to_lowercase();

    if host.is_empty() {
        // Host 없는 요청은 브라우저가 보낸 것이 아니다. 안전한 쪽으로 센다.
        return true;
    }
    let local = host == "localhost"
        || host == "127.0.0.1"
        || host.ends_with(".local")
        || host.starts_with("192.168.")
        || host.starts_with("10.")
        || host.starts_with("169.254.")
        // 172.16.0.0 – 172.31.255.255
        || host
            .strip_prefix("172.")
            .and_then(|r| r.split('.').next())
            .and_then(|o| o.parse::<u8>().ok())
            .map(|o| (16..=31).contains(&o))
            .unwrap_or(false);
    !local
}

/// Paths a stranger on the internet may reach when the shop has not opened up.
///
/// The customer side only. Everything else — the till, the staff screen, the
/// door scanner — stays on the shop's own network unless the owner deliberately
/// says otherwise.
fn customer_path(path: &str) -> bool {
    matches!(
        path,
        "/" | "/wallet"
            | "/wallet.bundle.js"
            | "/buy"
            | "/shops"
            | "/api/shop"
            | "/api/shops"
            | "/api/shop-profile"
            | "/api/ipfs-kind"
            | "/api/chain/asset"
            | "/api/notices"
            | "/i18n.js"
            | "/ravi.js"
            | "/api/ai-status"
            | "/api/shop-history"
            | "/api/nostr/publish"
            | "/api/nostr/query"
            | "/api/directions"
            | "/api/ask"
            | "/api/order"
            | "/api/order-state"
            | "/api/qr"
            | "/api/offer"
            | "/api/check-address"
            | "/api/claim"
            | "/api/paid"
            | "/api/chain/address"
            | "/api/chain/send"
    ) || path.starts_with("/ipfs/")
        // 캐릭터 그림. 이걸 막으면 밖에서 연 손님 화면만 그림이 빠진다.
        || (path.starts_with("/raven-") && (path.ends_with(".webp") || path.ends_with(".png")))
}

/// Would opening a tunnel put this path on the internet, and should it be?
///
/// Turning the tunnel on forwards the **whole port**, which is four screens:
/// customer, till, staff, and door scanner. The owner asked to manage nodes
/// from a phone anywhere, so this is not simply forbidden — it is a choice,
/// and the default is the safe half of it. The token is 32 random bytes and is
/// not guessable; what this limits is the amount of surface a stranger can
/// reach at all.
fn outside_blocked(state: &ServerState, headers: &HeaderMap, path: &str) -> bool {
    if !from_outside(headers) || customer_path(path) {
        return false;
    }
    !state.remote_admin.lock().map(|v| *v).unwrap_or(false)
}

/// Is this request allowed to reach this path?
fn authed_for(state: &ServerState, headers: &HeaderMap, q: &Value, path: &str) -> bool {
    if outside_blocked(state, headers, path) {
        return false;
    }
    match role_of(state, headers, q) {
        Some(r) => crate::roles::allowed(&r, path),
        None => false,
    }
}

fn admin_authed(state: &ServerState, headers: &HeaderMap, q: &Value) -> bool {
    // 사장 경로는 손님 경로가 아니므로, 바깥에서 오면 이 한 줄이 전부 막는다.
    // 관리까지 열기로 한 가게만 통과한다.
    if outside_blocked(state, headers, "/admin") {
        return false;
    }
    let given = headers
        .get("x-playx-token")
        .and_then(|v| v.to_str().ok())
        .map(str::to_string)
        // The first load comes from a scanned QR, which can only carry the
        // token in the URL. Everything after that uses the header.
        .or_else(|| q.get("t").and_then(Value::as_str).map(str::to_string))
        .unwrap_or_default();
    let owner = state.token.lock().map(|t| t.clone()).unwrap_or_default();
    token_ok(&owner, &given)
}

// ── 손님 ──────────────────────────────────────────────────────────────────

async fn customer_page() -> Html<&'static str> {
    Html(include_str!("../../web/customer.html"))
}

async fn buy_page() -> Html<&'static str> {
    Html(include_str!("../../web/buy.html"))
}

/// One listing, for the public sale page.
async fn api_offer(
    State(state): State<ServerState>,
    Query(q): Query<std::collections::HashMap<String, String>>,
) -> impl IntoResponse {
    let id = q.get("id").cloned().unwrap_or_default();
    let found = state
        .offers
        .lock()
        .ok()
        .and_then(|m| m.get(&id).cloned());
    match found {
        Some(v) => (StatusCode::OK, Json(v)),
        None => (
            StatusCode::NOT_FOUND,
            Json(json!({ "error": "지금은 팔지 않는 물건입니다." })),
        ),
    }
}

/// Is this an address that can hold assets?
///
/// The buyer types it and cannot check it themselves — an address that looks
/// right and is not is how an asset disappears with nobody at fault.
async fn api_check_address(
    Query(q): Query<std::collections::HashMap<String, String>>,
) -> impl IntoResponse {
    let a = q.get("a").cloned().unwrap_or_default();
    if a.len() < 20 || a.len() > 80 {
        return (StatusCode::OK, Json(json!({ "valid": false })));
    }
    match crate::send::check_address(a).await {
        Ok(v) => (StatusCode::OK, Json(v)),
        Err(_) => (StatusCode::OK, Json(json!({ "valid": false }))),
    }
}

#[derive(serde::Deserialize)]
struct ClaimBody {
    id: String,
    deliver_to: String,
}

/// The buyer says where the asset should go, and gets an address to pay.
///
/// A fresh address per buyer, not per listing: two people buying the same item
/// send the same amount, and the address is the only thing that tells them
/// apart. Without this the second buyer's payment looks like a duplicate of the
/// first and one of them gets nothing.
async fn api_claim(
    State(state): State<ServerState>,
    Json(body): Json<ClaimBody>,
) -> impl IntoResponse {
    let ok = crate::send::check_address(body.deliver_to.clone())
        .await
        .map(|v| v["valid"].as_bool().unwrap_or(false))
        .unwrap_or(false);
    if !ok {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "받을 주소가 올바르지 않습니다." })),
        );
    }

    // 이 물건이 얼마인지. 손님이 보낸 값이 아니라 **가게가 정한 값**이다 —
    // 커피 주문에서 배운 것이 여기도 그대로 적용된다.
    let offer_rvn = state
        .offers
        .lock()
        .ok()
        .and_then(|m| m.get(&body.id).and_then(|o| o.get("rvn")).and_then(Value::as_f64))
        .unwrap_or(0.0);

    let address = match crate::raven::new_address(format!("sell:{}", body.id)).await {
        Ok(a) => a,
        Err(e) => return (StatusCode::BAD_GATEWAY, Json(json!({ "error": e }))),
    };

    if let Ok(mut m) = state.claims.lock() {
        m.insert(address.clone(), (body.id.clone(), body.deliver_to.clone()));
    }
    // 즉시 디스크에. 손님이 주소를 적은 직후 앱이 죽으면, 그 손님은 돈을 내고도
    // "모르는 주문"이 된다.
    persist_orders(&state);
    // 🔴 벤딩머신에는 수수료 배선이 없었다. 커피 주문에는 넣었는데 여기는
    // 다른 길이라 빠졌다 — 온라인으로 자산을 파는 것도 똑같이 우리 프로그램이
    // 하는 일이다.
    //
    // 손님이 내는 값은 그대로다. 가게가 조금 덜 받는다.
    let fee_cfg = crate::shop::fee_config();
    let split = crate::shop::split_payment(offer_rvn, fee_cfg.0, fee_cfg.1);
    (
        StatusCode::OK,
        Json(json!({ "address": address, "fee": split })),
    )
}

/// The shop moves an order along. Called from the desktop and the owner's phone.
#[derive(serde::Deserialize)]
struct StateBody {
    address: String,
    state: String,
}

async fn admin_set_state(
    State(st): State<ServerState>,
    headers: HeaderMap,
    Json(body): Json<StateBody>,
) -> impl IntoResponse {
    // 주문 상태를 넘기는 것은 직원의 본업이다. 여기서 사장 토큰만 받으면 직원
    // 화면은 로그인에 성공한 뒤 아무것도 못 하는 화면이 된다 — 실제로 그랬다.
    if !authed_for(&st, &headers, &json!({}), "/api/admin/state") {
        return (StatusCode::UNAUTHORIZED, Json(json!({ "error": "권한 없음" })));
    }
    if !STATES.contains(&body.state.as_str()) {
        return (StatusCode::BAD_REQUEST, Json(json!({ "error": "알 수 없는 상태" })));
    }

    let mut m = match st.order_state.lock() {
        Ok(m) => m,
        Err(_) => return (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "error": "잠금 실패" }))),
    };
    let ticket = m.get(&body.address).map(|(_, _, t)| *t).unwrap_or_else(|| next_ticket(&st));
    m.insert(body.address.clone(), (body.state.clone(), now_unix(), ticket));

    // 하루 200건짜리 가게면 이 표는 1년에 7만 줄이 된다. 아무도 지우지 않아서
    // 그랬다. 어제 끝난 주문을 계산대가 들고 있을 이유가 없다.
    prune_old(&mut m, 500);

    (StatusCode::OK, Json(json!({ "ok": true, "ticket": ticket })))
}

/// Drops the oldest entries once the table grows past `keep`.
///
/// Time-ordered rather than insertion-ordered: a HashMap has no order of its
/// own, and the useful thing to keep is *recent*, not *whatever hashed last*.
fn prune_old(m: &mut std::collections::HashMap<String, (String, i64, u32)>, keep: usize) {
    if m.len() <= keep {
        return;
    }
    let mut times: Vec<i64> = m.values().map(|(_, t, _)| *t).collect();
    times.sort_unstable();
    let cutoff = times[m.len() - keep];
    m.retain(|_, (_, t, _)| *t >= cutoff);
}

/// Every order with a state, for the shop screen.
async fn admin_states(State(st): State<ServerState>, headers: HeaderMap) -> impl IntoResponse {
    if !authed_for(&st, &headers, &json!({}), "/api/admin/states") {
        return (StatusCode::UNAUTHORIZED, Json(json!({ "error": "권한 없음" })));
    }
    let m = st.order_state.lock().map(|m| m.clone()).unwrap_or_default();
    let tables = st.order_table.lock().map(|t| t.clone()).unwrap_or_default();
    let rows: Vec<Value> = m
        .iter()
        .map(|(addr, (s, at, t))| {
            json!({
                "address": addr, "state": s, "at": at, "ticket": t,
                // 자리로 가져다주는 가게는 번호를 부르지 않는다.
                "table": tables.get(addr),
            })
        })
        .collect();
    (StatusCode::OK, Json(json!({ "orders": rows })))
}

/// Not more than one chain read every this many seconds, however many phones ask.
const SWEEP_GAP_SECS: i64 = 4;

/// Moves every waiting order whose money has landed to `paid`, in one read.
///
/// ## Why the chain decides and not the counter
///
/// The shop screen can mark an order 만드는 중, but it must never be the thing
/// that says 결제됨 — that sentence is a claim about money, and the only honest
/// source for it is the wallet. Keeping the transition here means a busy shop
/// pressing buttons cannot accidentally confirm a payment that never arrived.
///
/// ## Why a sweep rather than a per-address check
///
/// `incoming_payments("")` already returns every order payment the wallet has
/// seen. Asking it once per polling phone would multiply RPC load by the number
/// of customers, against a node with four HTTP threads. One read updates every
/// waiting order at once, so ten customers cost exactly what one costs.

/// 다음 주문번호.
///
/// 🔴 여태 999 를 넘으면 1 로 돌아갔고, **날짜가 바뀌어도 안 돌아갔다.**
/// 둘 다 카운터에서 사고가 난다:
///  · 하루에 999 를 넘기는 가게(마트·구내식당)는 같은 날 1번이 두 명이 된다
///  · 어제 500번까지 갔으면 오늘 첫 손님이 "501번" 을 듣는다
///
/// 그래서 **날이 바뀌면 1번부터**, 그리고 넘어가도 1 로 안 돌아간다.
/// 999번을 넘긴 가게는 네 자리를 부르면 된다 — 부르기 불편한 것이
/// 같은 번호 두 명보다 낫다.
fn next_ticket(st: &ServerState) -> u32 {
    let now = now_unix();
    let day = (now + local_tz_offset_min() * 60) / 86_400;
    let mut g = st.ticket_day.lock().unwrap_or_else(|e| e.into_inner());
    let mut n = st.next_ticket.lock().unwrap_or_else(|e| e.into_inner());
    if *g != day {
        *g = day;
        *n = 1;
    }
    let t = *n;
    // 상한은 사장이 정한다. 자릿수가 늘수록 **불러도 안 들린다** — 실제 가게가
    // 세 자리를 쓰는 이유다. 그래도 하루에 그만큼 파는 곳이 있으니 막지 않는다.
    let cap = crate::shop::ticket_cap();
    *n = if t >= cap { 1 } else { t + 1 };
    t
}

async fn sweep_payments(st: &ServerState) {
    {
        // 창구를 먼저 닫고 조회한다. 열어 둔 채 기다리면 그 사이 도착한 요청이
        // 전부 같은 조회를 또 시작한다 — 아끼려던 부하가 그대로 돌아온다.
        let mut last = match st.last_sweep.lock() {
            Ok(l) => l,
            Err(_) => return,
        };
        let now = now_unix();
        if now - *last < SWEEP_GAP_SECS {
            return;
        }
        *last = now;
    }

    let has_waiting = st
        .order_state
        .lock()
        .map(|m| m.values().any(|(s, _, _)| s == WAITING || s == SHORT || s == EXPIRED))
        .unwrap_or(false);
    if !has_waiting {
        return;
    }

    let Ok(v) = crate::shop::incoming_payments(String::new(), 1).await else {
        return;
    };
    let payments = v["payments"].as_array().cloned().unwrap_or_default();

    let mut m = match st.order_state.lock() {
        Ok(m) => m,
        Err(_) => return,
    };
    for p in payments {
        // 지금 내줘도 되는 돈만 확인으로 친다. 충돌이 있거나 노드가 끊겨 있으면
        // accept_now 가 false 고, 그때는 손님 화면도 기다린다고 말해야 한다.
        if !p["accept_now"].as_bool().unwrap_or(false) {
            continue;
        }
        let Some(addr) = p["address"].as_str() else {
            continue;
        };
        let Some(slot) = m.get(addr) else { continue };
        if slot.0 != WAITING && slot.0 != SHORT && slot.0 != EXPIRED {
            continue;
        }

        // 🔴 여태 금액을 대조하지 않았다. 그 주소로 **뭐라도** 들어오면
        // 「결제 확인됨」이었다 — 1,183 RVN 짜리 커피에 1 RVN 을 보내도.
        // 체인은 보낸 만큼만 보내 준다. 모자란 것을 알아채는 것은 우리 몫이다.
        //
        // 기대값은 총액이 아니라 **가게 몫**이다(수수료를 뗀 뒤). 다른 지갑으로
        // 전액이 오면 그건 기대값보다 많으니 당연히 통과한다.
        // 만료된 견적으로 온 돈은 자동으로 확인하지 않는다. 시세가 움직인
        // 뒤라 그 금액이 지금 얼마인지 모른다 — 사장이 보고 정할 일이다.
        // 돈을 돌려보내지도 않는다. 지갑에 들어와 있고, 화면이 말해 준다.
        let until = st
            .order_until
            .lock()
            .ok()
            .and_then(|u| u.get(addr).copied())
            .unwrap_or(0);
        // 블록이 늦게 잡히는 것까지 만료로 치면 정상 결제가 막힌다. 2분 봐준다.
        if until > 0 && now_unix() > until + 120 {
            m.insert(addr.to_string(), (EXPIRED.into(), now_unix(), 0));
            continue;
        }

        let got = p["amount"].as_f64().unwrap_or(0.0).abs();
        let want = st
            .order_expect
            .lock()
            .ok()
            .and_then(|e| e.get(addr).copied())
            .unwrap_or(0.0);
        // 1사토시 오차는 봐준다. 8자리 반올림이 양쪽에서 일어난다.
        if want > 0.0 && got + 1e-8 < want {
            // 한 푼도 안 왔으면 아직 기다리는 것이고, 왔는데 모자라면 말해 준다.
            if got > 0.0 {
                m.insert(addr.to_string(), (SHORT.into(), now_unix(), 0));
            }
            continue;
        }
        // 번호는 돈이 들어온 순간에 준다. 주문할 때 주면 결제하지 않고 떠난
        // 사람들이 번호를 가져가서, 카운터에서 부르는 번호가 띄엄띄엄해진다.
        let ticket = next_ticket(st);
        m.insert(addr.to_string(), ("paid".into(), now_unix(), ticket));

        // 여기가 매출이 생기는 순간이고, 장부에 적히는 유일한 순간이다.
        // 주문했을 때가 아니라 돈이 들어왔을 때 — 결제하지 않고 떠난 주문까지
        // 매출로 적으면 그건 장부가 아니라 희망사항이다.
        crate::ledger::settle(
            addr,
            p["txid"].as_str().unwrap_or(""),
            now_unix(),
            p["confirmations"].as_i64().unwrap_or(0),
        );

        // 잡아 둔 것을 진짜로 뺀다. 여기서 빼야 손님 화면의 "남은 수량" 이
        // 실제와 맞는다. 주문할 때 빼면 결제 안 한 사람 때문에 품절이 된다.
        if let Ok(mut sh) = st.shop.lock() {
            if let Some(menu) = sh.get_mut("menu") {
                crate::stock::commit(addr, menu);
            }
        }
    }
}

/// What the customer's phone polls. No login — the pay address is the secret.
async fn api_order_state(
    State(st): State<ServerState>,
    Query(q): Query<std::collections::HashMap<String, String>>,
) -> impl IntoResponse {
    let addr = q.get("a").cloned().unwrap_or_default();
    let peek = |s: &ServerState| {
        s.order_state
            .lock()
            .ok()
            .and_then(|m| m.get(&addr).cloned())
    };

    let mut found = peek(&st);
    // 아직 입금을 기다리는 주문이면, 답하기 전에 체인을 한 번 본다. 그래야
    // 손님이 결제한 뒤 몇 초 안에 화면이 저절로 바뀐다.
    if matches!(&found, Some((s, _, _)) if s == WAITING) {
        sweep_payments(&st).await;
        found = peek(&st);
    }

    match found {
        Some((s, at, t)) => (
            StatusCode::OK,
            Json(json!({ "state": s, "at": at, "ticket": t })),
        ),
        // 모르는 주소다. 예전에는 여기서 "paid" 라고 답했고, 그건 한 푼도 내지
        // 않은 화면에 「결제 확인됨」을 띄웠다 — 이 프로그램이 낼 수 있었던
        // 가장 비싼 거짓말이다.
        None => (
            StatusCode::OK,
            Json(json!({ "state": "unknown", "ticket": 0 })),
        ),
    }
}

/// Has this buyer's payment arrived, and has the asset gone out?
async fn api_paid(
    State(state): State<ServerState>,
    Query(q): Query<std::collections::HashMap<String, String>>,
) -> impl IntoResponse {
    let addr = q.get("a").cloned().unwrap_or_default();
    if addr.is_empty() {
        return (StatusCode::BAD_REQUEST, Json(json!({ "error": "주소 없음" })));
    }
    let known = state.claims.lock().map(|m| m.contains_key(&addr)).unwrap_or(false);
    if !known {
        return (StatusCode::NOT_FOUND, Json(json!({ "error": "모르는 주문" })));
    }

    match crate::shop::incoming_payments(addr.clone(), 1).await {
        Ok(v) => {
            let p = v["payments"].as_array().and_then(|a| a.first()).cloned();
            let sent = state
                .sent
                .lock()
                .map(|s| s.contains(&addr))
                .unwrap_or(false);
            (
                StatusCode::OK,
                Json(json!({
                    "paid": p.is_some(),
                    "confirmations": p.as_ref().and_then(|x| x["confirmations"].as_i64()).unwrap_or(0),
                    "sent": sent,
                })),
            )
        }
        Err(e) => (StatusCode::BAD_GATEWAY, Json(json!({ "error": e }))),
    }
}

/// Everything the owner needs to judge the machine, without a monitor.
///
/// Deliberately one call. A phone on shop wifi checking six endpoints to answer
/// "is my shop alive" is six chances to look broken.
async fn admin_machine(State(st): State<ServerState>, headers: HeaderMap) -> impl IntoResponse {
    if !admin_authed(&st, &headers, &json!({})) {
        return (StatusCode::UNAUTHORIZED, Json(json!({ "error": "권한 없음" })));
    }
    let services = crate::services::services_status().await;
    let net = crate::raven::network_state().await;
    let disk = crate::setup::disk_now();
    let node = crate::recover::node_identity();
    let backup = crate::backup::backup_survey();

    (
        StatusCode::OK,
        Json(json!({
            "node_name": node.get("name").cloned().unwrap_or(json!("")),
            "services": services,
            "network": net,
            "disk": disk,
            "backup": backup,
        })),
    )
}

/// Starts whatever is down, from the owner's phone.
///
/// Never stops anything. A phone in a pocket must not be able to close the shop
/// by accident, and `services.rs` already refuses to touch processes it did not
/// start.
async fn admin_machine_start(State(st): State<ServerState>, headers: HeaderMap) -> impl IntoResponse {
    if !admin_authed(&st, &headers, &json!({})) {
        return (StatusCode::UNAUTHORIZED, Json(json!({ "error": "권한 없음" })));
    }
    match crate::services::open_shop().await {
        Ok(v) => (StatusCode::OK, Json(v)),
        Err(e) => (StatusCode::BAD_GATEWAY, Json(json!({ "error": e }))),
    }
}

/// Makes a backup from the phone.
///
/// The owner of a headless machine has no other way to do this, and a backup
/// nobody can trigger is a backup that does not happen.
async fn admin_backup(State(st): State<ServerState>, headers: HeaderMap) -> impl IntoResponse {
    if !admin_authed(&st, &headers, &json!({})) {
        return (StatusCode::UNAUTHORIZED, Json(json!({ "error": "권한 없음" })));
    }
    match crate::backup::backup_zip(String::new(), String::new(), true).await {
        Ok(v) => (StatusCode::OK, Json(v)),
        Err(e) => (StatusCode::BAD_REQUEST, Json(json!({ "error": e }))),
    }
}

async fn staff_refund_limits_route(
    State(st): State<ServerState>,
    headers: HeaderMap,
) -> impl IntoResponse {
    if !authed_for(&st, &headers, &json!({}), "/api/staff/refund/limits") {
        return (StatusCode::UNAUTHORIZED, Json(json!({ "error": "권한 없음" })));
    }
    (StatusCode::OK, Json(crate::refund::staff_refund_limits(now_unix()).await))
}

#[derive(serde::Deserialize)]
struct StaffRefundBody {
    to: String,
    krw: f64,
    reason: String,
    passphrase: Option<String>,
}

/// A refund initiated from the staff screen.
///
/// The passphrase travels only if the wallet is locked and the staff member was
/// given it — which is a shop decision, not ours. Either way the amount limit
/// applies first, so the worst case is bounded before any key is touched.
async fn staff_refund_route(
    State(st): State<ServerState>,
    headers: HeaderMap,
    Json(b): Json<StaffRefundBody>,
) -> impl IntoResponse {
    if !authed_for(&st, &headers, &json!({}), "/api/staff/refund") {
        return (StatusCode::UNAUTHORIZED, Json(json!({ "error": "권한 없음" })));
    }
    match crate::refund::staff_refund(b.to, b.krw, b.reason, now_unix(), b.passphrase).await {
        Ok(v) => (StatusCode::OK, Json(v)),
        Err(e) => (StatusCode::BAD_REQUEST, Json(json!({ "error": e }))),
    }
}

async fn wallet_page() -> Html<&'static str> {
    Html(include_str!("../../web/wallet.html"))
}

/// The wallet's code, served as JavaScript.
///
/// The content type matters: a browser handed `text/plain` refuses to run it,
/// and the page then shows a wallet that renders nothing with no error anyone
/// can see.
async fn wallet_bundle() -> impl IntoResponse {
    (
        StatusCode::OK,
        [(header::CONTENT_TYPE, "application/javascript; charset=utf-8")],
        include_str!("../../web/wallet.bundle.js"),
    )
}

#[derive(serde::Deserialize)]
struct AddrQuery {
    address: String,
}

/// What one address owns. Read-only, and it is somebody else's address.
async fn chain_address_route(
    axum::extract::Query(q): axum::extract::Query<AddrQuery>,
) -> impl IntoResponse {
    match crate::electrum::chain_address(q.address).await {
        Ok(v) => (StatusCode::OK, Json(v)),
        Err(e) => (StatusCode::BAD_GATEWAY, Json(json!({ "error": e }))),
    }
}

#[derive(serde::Deserialize)]
struct SendBody {
    hex: String,
}

/// Relays a transaction the customer's browser already signed.
///
/// The node validates before relaying, so a malformed or unfunded transaction
/// is rejected here rather than becoming this shop's problem. Nothing about
/// this endpoint can move the shop's own money — it only forwards bytes that
/// were signed by keys we do not have.
async fn chain_send_route(Json(b): Json<SendBody>) -> impl IntoResponse {
    if b.hex.len() > 200_000 {
        return (StatusCode::BAD_REQUEST, Json(json!({ "error": "거래가 너무 큽니다" })));
    }
    match crate::raven::call_rpc("sendrawtransaction", json!([b.hex])).await {
        Ok(v) => (StatusCode::OK, Json(json!({ "txid": v.as_str().unwrap_or_default() }))),
        Err(e) => (StatusCode::BAD_REQUEST, Json(json!({ "error": e }))),
    }
}

/// Fetches one file from the local IPFS gateway and hands it on.
async fn ipfs_relay(axum::extract::Path(path): axum::extract::Path<String>) -> impl IntoResponse {
    // 경로에 .. 이 들어오면 게이트웨이 밖을 가리킬 수 있다. CID 는 그런 글자를
    // 쓰지 않으므로 그냥 거절한다.
    if path.contains("..") {
        return (StatusCode::BAD_REQUEST, [(header::CONTENT_TYPE, "text/plain".to_string())], Vec::new());
    }

    let url = format!("http://127.0.0.1:8080/ipfs/{path}");
    let client = reqwest::Client::builder()
        // 사진 한 장에 손님을 오래 세워 두지 않는다.
        .timeout(std::time::Duration::from_secs(20))
        .build()
        .unwrap_or_default();

    match client.get(&url).send().await {
        Ok(r) if r.status().is_success() => {
            let kind = r
                .headers()
                .get(reqwest::header::CONTENT_TYPE)
                .and_then(|v| v.to_str().ok())
                .unwrap_or("application/octet-stream")
                .to_string();
            match r.bytes().await {
                Ok(b) => (
                    StatusCode::OK,
                    [(header::CONTENT_TYPE, kind)],
                    b.to_vec(),
                ),
                Err(_) => (
                    StatusCode::BAD_GATEWAY,
                    [(header::CONTENT_TYPE, "text/plain".to_string())],
                    Vec::new(),
                ),
            }
        }
        _ => (
            StatusCode::NOT_FOUND,
            [(header::CONTENT_TYPE, "text/plain".to_string())],
            Vec::new(),
        ),
    }
}

async fn shops_page() -> Html<&'static str> {
    Html(include_str!("../../web/shops.html"))
}

/// Every shop on the chain, for a phone that has no node of its own.
///
/// This is the part that makes the whole thing a platform rather than a set of
/// isolated shops: a customer who scanned one shop's QR can see every other
/// shop, because this node already holds the entire chain and is willing to
/// answer.
///
/// Cached for a minute. Without it, one customer pulling to refresh makes the
/// node walk its asset database on every gesture — and on the low-spec PC this
/// app is meant to run on, that is the whole machine.
async fn api_shops(State(state): State<ServerState>) -> impl IntoResponse {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);

    if let Ok(cache) = state.shops_cache.lock() {
        if let Some((at, ref value)) = *cache {
            if now - at < 60 {
                return (StatusCode::OK, Json(value.clone()));
            }
        }
    }

    match crate::shop::list_shops(200, 0).await {
        Ok(v) => {
            if let Ok(mut cache) = state.shops_cache.lock() {
                *cache = Some((now, v.clone()));
            }
            (StatusCode::OK, Json(v))
        }
        Err(e) => (StatusCode::BAD_GATEWAY, Json(json!({ "error": e }))),
    }
}

/// Map-app links for one destination.
///
/// Built here rather than in the page so the URL formats live in one place —
/// TMAP takes x as longitude and y as latitude, and that kind of detail should
/// not be duplicated into JavaScript where it will be got wrong once.
async fn api_directions(
    Query(q): Query<std::collections::HashMap<String, String>>,
) -> impl IntoResponse {
    let lat = q.get("lat").and_then(|v| v.parse::<f64>().ok()).unwrap_or(0.0);
    let lon = q.get("lon").and_then(|v| v.parse::<f64>().ok()).unwrap_or(0.0);
    let label = q.get("label").cloned().unwrap_or_default();
    if lat == 0.0 && lon == 0.0 {
        return (StatusCode::BAD_REQUEST, Json(json!([])));
    }
    (StatusCode::OK, Json(crate::place::directions_links(lat, lon, label)))
}

/// 이 가게가 붙인 공지. 손님 폰이 주문 화면에서 부른다.
///
/// 🔴 공지는 온체인으로 잘 만들어져 있었는데 **손님이 볼 길이 없었다.**
/// 사장은 보냈다고 여기고 손님은 온 적이 없다 — 그런 기능은 없는 것보다
/// 나쁘다. "오늘 재료 떨어졌습니다" 를 못 보면 손님은 헛걸음한다.
async fn api_notices(State(state): State<ServerState>) -> impl IntoResponse {
    let asset = state
        .shop
        .lock()
        .ok()
        .and_then(|s| s.get("asset").and_then(Value::as_str).map(str::to_string))
        .unwrap_or_default();
    match crate::msg::shop_notices(asset).await {
        Ok(v) => (StatusCode::OK, Json(v)),
        // 공지를 못 읽는 것이 주문을 막을 이유는 없다. 빈 목록으로 답한다.
        Err(_) => (StatusCode::OK, Json(json!({ "notices": [] }))),
    }
}

/// 자산 하나에 딸린 것. 지갑이 "내 회원권" 을 열어 볼 때 부른다.
///
/// 🔴 손님 폰도 부르는 경로다. `getassetdata` 는 체인에 이미 공개된 값만
/// 주므로 숨길 것이 없지만, **이름을 그대로 넘기지 않는다** — 레이븐 자산
/// 이름은 대문자·숫자·`._/` 뿐이고, 그 밖의 글자가 RPC 로 들어가면 안 된다.
async fn api_chain_asset(
    Query(q): Query<std::collections::HashMap<String, String>>,
) -> impl IntoResponse {
    let name = q.get("name").cloned().unwrap_or_default();
    let ok = !name.is_empty()
        && name.len() <= 64
        && name
            .chars()
            .all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || "._/#!".contains(c));
    if !ok {
        return (StatusCode::BAD_REQUEST, Json(json!({ "error": "자산 이름이 아닙니다" })));
    }
    match crate::raven::call_rpc("getassetdata", json!([name])).await {
        Ok(v) => (
            StatusCode::OK,
            Json(json!({
                "name": v.get("name").and_then(Value::as_str).unwrap_or_default(),
                "ipfs_hash": v.get("ipfs_hash").and_then(Value::as_str).unwrap_or_default(),
                "units": v.get("units").and_then(Value::as_i64).unwrap_or(0),
                "reissuable": v.get("reissuable").and_then(Value::as_i64).unwrap_or(0) == 1,
            })),
        ),
        // 없는 자산과 노드가 죽은 것은 다르지만, 화면이 할 일은 같다 —
        // 딸린 것이 없다고 보여 준다.
        Err(_) => (StatusCode::OK, Json(json!({ "name": name, "ipfs_hash": "" }))),
    }
}

/// 손님 폰이 "이게 그림이냐 음악이냐" 를 묻는 자리.
///
/// 🔴 파일 이름으로 짐작하지 않는다 — **CID 에는 이름이 없다.** 게이트웨이에
/// HEAD 한 번 보내 실제 Content-Type 을 보는 것이 유일하게 맞는 방법이다.
///
/// 여태 판매 페이지는 무엇이든 `<img>` 로 그렸다. 그림은 보였지만 음악은
/// **깨진 그림 아이콘 하나**였고, 사는 사람은 들어보지도 못하고 사야 했다.
///
/// 답은 `image | audio | video | other` 한 낱말뿐이다. 손님 폰도 부르는
/// 경로라 안쪽 사정을 더 얹지 않는다.
/// 지갑이 「내가 올린 것」을 채우려고 부르는 자리.
///
/// 개인키는 오지 않는다 — 공개키만 온다. 누가 썼는지는 원래 릴레이에 공개된 값이다.
#[derive(serde::Deserialize)]
struct QueryBody {
    filter: QueryFilter,
}

#[derive(serde::Deserialize)]
struct QueryFilter {
    #[serde(default)]
    kinds: Vec<i64>,
    #[serde(default)]
    authors: Vec<String>,
}

async fn api_nostr_query(Json(body): Json<QueryBody>) -> impl IntoResponse {
    match crate::nostrpub::nostr_query(body.filter.kinds, body.filter.authors).await {
        Ok(v) => (StatusCode::OK, Json(v)),
        Err(e) => (StatusCode::BAD_GATEWAY, Json(json!({ "error": e }))),
    }
}

async fn api_ipfs_kind(
    Query(q): Query<std::collections::HashMap<String, String>>,
) -> impl IntoResponse {
    let cid = q.get("cid").cloned().unwrap_or_default();
    // CID 는 영숫자다. 딴 글자가 섞이면 우리 게이트웨이 주소를 벗어나는
    // 요청이 될 수 있다.
    if cid.is_empty() || cid.len() > 80 || !cid.chars().all(|c| c.is_ascii_alphanumeric()) {
        return (StatusCode::BAD_REQUEST, Json(json!({ "error": "cid 없음" })));
    }
    let kind = match crate::ipfs::content_kind(cid).await {
        Ok(v) => {
            if v["is_audio"].as_bool() == Some(true) {
                "audio"
            } else if v["is_video"].as_bool() == Some(true) {
                "video"
            } else if v["is_image"].as_bool() == Some(true) {
                "image"
            } else if v["is_pdf"].as_bool() == Some(true) {
                // 책. 새 창에서 연다 — 이 페이지 안에 띄우면 12단어와 같은
                // 창을 쓰게 되고, PDF 뷰어는 남의 파일을 실행하는 자리다.
                "book"
            } else if v["mime"].as_str() == Some("text/html")
                && v["is_dir"].as_bool() != Some(true)
            {
                // 게임·읽을거리. 🔴 이건 **남이 만든 스크립트**다.
                // 화면 쪽에서 반드시 `sandbox` 안에 가둬야 한다.
                "web"
            } else {
                "other"
            }
        }
        // IPFS 가 안 돌아도 판매는 계속돼야 한다. 미리보기는 덤이다.
        Err(_) => "image",
    };
    (StatusCode::OK, Json(json!({ "kind": kind })))
}

/// One shop's published profile, read from IPFS by this node.
async fn api_shop_profile(
    Query(q): Query<std::collections::HashMap<String, String>>,
) -> impl IntoResponse {
    let cid = q.get("cid").cloned().unwrap_or_default();
    if cid.is_empty() || cid.len() > 80 {
        return (StatusCode::BAD_REQUEST, Json(json!({ "error": "cid 없음" })));
    }
    match crate::ipfs::content_kind(cid).await {
        Ok(v) => (StatusCode::OK, Json(v)),
        Err(e) => (StatusCode::BAD_GATEWAY, Json(json!({ "error": e }))),
    }
}

async fn api_shop(State(state): State<ServerState>) -> impl IntoResponse {
    let shop = state.shop.lock().map(|s| s.clone()).unwrap_or(json!({}));
    let ai_on = state.ai.lock().map(|a| !a.is_empty()).unwrap_or(false);
    // 영업시간 **그리고** 노드가 받을 수 있는 상태. 둘 중 하나라도 아니면
    // 닫힌 것이다 — 받아 놓고 확인 못 하는 것이 제일 나쁘다.
    let open_state = {
        let mut o = crate::shop::open_at(&shop, now_unix(), local_tz_offset_min());
        let (ready, why) = node_can_take_orders().await;
        if !ready {
            o["open"] = json!(false);
            o["say"] = json!(why);
        }
        o
    };

    Json(json!({
        "shop": shop,
        "ai": ai_on,
        // 지금 몇 개 남았나. 수량을 안 적은 품목은 null(무제한)로 온다 —
        // 0 으로 보내면 화면이 전부 품절로 그린다.
        // 사장이 고른 색. 손님 화면이 :root 에 얹는다 — CSS 파일을 바꾸지
        // 않으므로 다음 판올림에도 살아남는다.
        "theme": crate::shop::theme_read(),
        "left": crate::stock::stock_left(
            shop.get("menu").cloned().unwrap_or(json!([])),
            now_unix(),
        ),
        // 영업 여부는 **가게 시계**로 판정한다. 손님 폰의 시간대를 쓰면,
        // 여행 온 손님 폰에만 이 가게가 닫혀 보인다.
        "open": open_state,
    }))
}

/// This machine's offset from UTC, in minutes.
///
/// Read from the OS every time rather than stored, because a shop that moves —
/// or a laptop that travels — should not have to remember to change a setting
/// for its opening hours to keep meaning what they say.
fn local_tz_offset_min() -> i64 {
    // 표준 라이브러리에는 시간대가 없다. `date` 는 어느 유닉스에나 있고,
    // 실패하면 UTC 로 떨어진다 — 그때는 시간표가 어긋날 뿐 화면은 산다.
    std::process::Command::new("date")
        .arg("+%z")
        .output()
        .ok()
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .and_then(|s| {
            let s = s.trim();
            let sign = if s.starts_with('-') { -1 } else { 1 };
            let d = s.trim_start_matches(['+', '-']);
            if d.len() < 4 {
                return None;
            }
            let h: i64 = d[..2].parse().ok()?;
            let m: i64 = d[2..4].parse().ok()?;
            Some(sign * (h * 60 + m))
        })
        .unwrap_or(0)
}

#[derive(serde::Deserialize)]
struct AskBody {
    question: String,
}

/// Customer asks a question; the shop's own AI key answers from the shop's own
/// published information.
///
/// Rate-limited by nothing yet, which is a real gap: the shop pays per call.
/// Left visible rather than hidden behind a silent cap so it is fixed rather
/// than forgotten.
/// 라비가 깨어 있는지. **폰이 누르기 전에** 알 수 있어야 한다.
///
/// 이게 없으면 폰은 눌러 봐야 안다. 손님이 눌러서 "이 가게는 자동 응대를 켜지
/// 않았습니다" 를 받는 것은 안내가 아니라 실패다 — 손님이 할 수 있는 게 없다.
///
/// 🔴 **어느 회사 키인지, 키 자체는 절대 내보내지 않는다.** 여기 답은 예/아니오
/// 하나뿐이다. 손님 폰도 부를 수 있는 경로라, 무엇이든 더 얹으면 그게 새는 것이다.
/// 사장·직원이 자기 폰에서 라비에게 묻는 자리.
///
/// 🔴 `/api/ask` 와 무엇이 다른가 — **답하는 자세가 다르다.**
/// 손님용은 가게를 대신해 응대하고, 우리 이야기를 하지 않는다. 사장용은 사장
/// 편에 서서 이 프로그램의 기능까지 같이 본다(`knowledge::owner_brief`).
/// 두 자세가 섞이면 손님 화면에 우리 광고가 새거나, 사장이 물었는데 "저는 이
/// 가게 직원입니다" 라고 답한다.
///
/// 🔴 이 경로는 `customer_path` 에 **넣지 않았다.** 바깥에서 들어온 요청은
/// 관리자 잠금에 걸린다 — 남의 가게 노드에 대고 사장 자세로 물을 수 없다.
///
/// 열쇠는 **노드에만** 있다. 폰은 묻기만 하고, 답은 가게 컴퓨터가 만든다.
/// 폰에 키를 넣지 않는 이유는 `web/ravi.js` 첫 주석에 적어 뒀다.
async fn api_owner_ask(
    State(state): State<ServerState>,
    Json(body): Json<AskBody>,
) -> impl IntoResponse {
    let provider = state.ai.lock().map(|a| a.clone()).unwrap_or_default();
    if provider.is_empty() {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({
                "error": "라비가 아직 자고 있어요. 가게 컴퓨터의 PLAY X Raven → 설정 → AI 에서 한 번만 넣어 주세요."
            })),
        );
    }
    if body.question.chars().count() > 500 {
        return (StatusCode::BAD_REQUEST, Json(json!({ "error": "질문이 너무 깁니다." })));
    }
    // 예산은 손님 응대와 **같은 지갑**에서 나간다. 사장이 폰으로 길게 놀다가
    // 손님 응대가 멈추면 그건 장사 사고다 — 같이 세는 편이 정직하다.
    let left = match take_ask_budget(&state) {
        Ok(n) => n,
        Err(e) => return (StatusCode::TOO_MANY_REQUESTS, Json(json!({ "error": e }))),
    };

    let shop = state.shop.lock().map(|s| s.clone()).unwrap_or(json!({}));
    let q = format!("{}\n\n{}", crate::knowledge::owner_brief(), body.question);
    match crate::ai::ai_answer_any(provider, q, shop).await {
        Ok(v) => (
            StatusCode::OK,
            Json(json!({
                "answer": v.get("text").and_then(Value::as_str).unwrap_or_default(),
                "left": left,
            })),
        ),
        Err(e) => (StatusCode::BAD_GATEWAY, Json(json!({ "error": e }))),
    }
}

async fn api_ai_status(State(state): State<ServerState>) -> impl IntoResponse {
    let awake = state.ai.lock().map(|a| !a.is_empty()).unwrap_or(false);
    Json(json!({ "awake": awake }))
}

/// 폰에 그리는 라비. 사장 폰·직원 폰·손님 폰이 같은 파일을 쓴다.
async fn api_ravi_js() -> impl IntoResponse {
    (
        [(axum::http::header::CONTENT_TYPE, "application/javascript; charset=utf-8")],
        include_str!("../../web/ravi.js"),
    )
}

async fn api_ask(State(state): State<ServerState>, Json(body): Json<AskBody>) -> impl IntoResponse {
    let provider = state.ai.lock().map(|a| a.clone()).unwrap_or_default();
    if provider.is_empty() {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({ "error": "이 가게는 자동 응대를 켜지 않았습니다." })),
        );
    }
    if body.question.chars().count() > 500 {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "질문이 너무 깁니다." })),
        );
    }

    // 예산을 먼저 깎는다. 호출 뒤에 깎으면 실패한 호출이 공짜가 되어
    // 재시도만으로 한도를 넘길 수 있다.
    let left = match take_ask_budget(&state) {
        Ok(n) => n,
        Err(e) => return (StatusCode::TOO_MANY_REQUESTS, Json(json!({ "error": e }))),
    };

    let shop = state.shop.lock().map(|s| s.clone()).unwrap_or(json!({}));
    // 한 곳이 할당량을 넘겼다고 손님이 가게 안에서 오류 화면을 볼 이유는
    // 없다. 키가 있는 다른 곳으로 넘어간다 — 싸고 빠른 것부터.
    match crate::ai::ai_answer_any(provider, body.question, shop).await {
        Ok(v) => (
            StatusCode::OK,
            Json(json!({
                "answer": v.get("text").and_then(Value::as_str).unwrap_or_default(),
                "left": left,
            })),
        ),
        Err(e) => (StatusCode::BAD_GATEWAY, Json(json!({ "error": e }))),
    }
}

#[derive(serde::Deserialize)]
struct OrderBody {
    items: Value,
    total: f64,
    currency: String,
    note: Option<String>,
    /// 몇 번 테이블에서 온 주문인가. 손님 QR 이 `?table=3` 을 달고 있으면
    /// 화면이 그대로 실어 보낸다.
    ///
    /// 이게 없으면 직원은 "아메리카노 나왔습니다" 를 외치고 손님이 일어나
    /// 받으러 와야 한다. 자리로 가져다주는 가게에서는 그게 안 된다.
    table: Option<String>,
}

/// Creates an order: its own address, and a price frozen at this moment.
///
/// A fresh address per order is what makes payments identifiable. Two customers
/// ordering the same coffee produce identical amounts, so amount cannot be the
/// key — a shop matching on price hands one of them the wrong bag.
///
/// This is the one customer route that touches the wallet, and it touches only
/// `getnewaddress`. Deriving a receiving address cannot spend anything.
async fn api_order(
    State(state): State<ServerState>,
    Json(mut body): Json<OrderBody>,
) -> impl IntoResponse {
    // 🔴 손님이 보낸 `total` 을 그대로 믿고 있었다. 메뉴에 10잔을 담고
    // `total: 1` 을 보내면 1원짜리 주소가 나오고, 1원만 넣어도 결제로 올라갔다.
    // **값은 손님이 정하는 것이 아니라 가게 메뉴가 정한다.**
    //
    // 메뉴에 없는 품목은 값이 0 이라 합계에 안 들어간다 — 지어낸 품목으로
    // 총액을 부풀릴 수 없고, 실제로 못 주는 것을 팔 수도 없다.
    {
        let menu = state
            .shop
            .lock()
            .map(|sh| sh.get("menu").cloned().unwrap_or(json!([])))
            .unwrap_or(json!([]));
        let real = crate::shop::price_of(&menu, &body.items);
        // 1원 오차는 반올림이다. 그 이상 어긋나면 우리가 아는 값으로 간다.
        if (real - body.total).abs() > 1.0 {
            body.total = real;
        }
    }

    if body.total <= 0.0 {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "금액이 올바르지 않습니다." })),
        );
    }

    // 🔴 속도 제한이 먼저다. 주소를 만든 다음에 세면 이미 만들어진 뒤다.
    {
        let mut t = match state.order_times.lock() {
            Ok(t) => t,
            Err(_) => return (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "error": "잠금 실패" }))),
        };
        let now = now_unix();
        t.retain(|x| now - x < 86_400);
        let last_min = t.iter().filter(|x| now - **x < 60).count();
        if last_min >= ORDERS_PER_MIN || t.len() >= ORDERS_PER_DAY {
            return (
                StatusCode::TOO_MANY_REQUESTS,
                Json(json!({
                    "error": "주문이 너무 몰렸습니다. 잠시 뒤에 다시 눌러 주세요.",
                    "busy": true,
                })),
            );
        }
        t.push(now);
    }

    // 닫힌 가게는 주문을 받지 않는다. 화면에서 버튼만 감추면, 먼저 열어 둔
    // 탭이나 새로고침하지 않은 폰에서 그대로 주문이 들어온다 — 아무도 만들지
    // 않을 커피값이 결제되고, 그건 환불로만 끝나고 환불은 되돌릴 수 없다.
    {
        let shop = state.shop.lock().map(|s| s.clone()).unwrap_or(json!({}));
        let st = crate::shop::open_at(&shop, now_unix(), local_tz_offset_min());
        if !st["open"].as_bool().unwrap_or(true) {
            let say = st["say"].as_str().unwrap_or("");
            return (
                StatusCode::CONFLICT,
                Json(json!({
                    "error": if say.is_empty() {
                        "지금은 주문을 받지 않습니다.".to_string()
                    } else {
                        format!("지금은 주문을 받지 않습니다. {say}")
                    },
                    "closed": true,
                })),
            );
        }
    }

    let address = match crate::raven::new_address("order".into()).await {
        Ok(a) => a,
        Err(e) => return (StatusCode::BAD_GATEWAY, Json(json!({ "error": e }))),
    };

    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);

    let quote = if body.currency.eq_ignore_ascii_case("RVN") {
        json!({ "rvn": body.total, "currency": "RVN", "expires_at": now + 300 })
    } else {
        match crate::price::quote_price(body.total, body.currency.clone(), now).await {
            Ok(q) => q,
            Err(e) => return (StatusCode::BAD_GATEWAY, Json(json!({ "error": e }))),
        }
    };

    let shop_name = state
        .shop
        .lock()
        .ok()
        .and_then(|s| s.get("name").and_then(Value::as_str).map(str::to_string))
        .unwrap_or_default();

    // 주문을 기록한다. 이 한 줄이 없어서 주문은 만들어지되 어디에도 남지 않았고,
    // 손님 폰이 상태를 물으면 서버가 모르는 주소라며 「결제 확인됨」을 답했다.
    // 기다리는 상태로 넣어 두면 `sweep_payments` 가 돈이 들어온 순간 올려 준다.
    // 테이블 번호는 사람이 적은 글자다. 길거나 이상한 것이 들어와도 화면이
    // 깨지지 않게 여기서 자른다.
    let table = body
        .table
        .as_deref()
        .map(str::trim)
        .filter(|t| !t.is_empty())
        .map(|t| t.chars().take(12).collect::<String>());

    if let Some(t) = table.as_deref() {
        if let Ok(mut m) = state.order_table.lock() {
            m.insert(address.clone(), t.to_string());
            // 주문 표와 같은 크기로 유지한다. 안 지우면 이 표만 계속 자란다.
            if m.len() > 500 {
                m.clear();
            }
        }
    }

    if let Ok(mut m) = state.order_state.lock() {
        m.insert(address.clone(), (WAITING.into(), now, 0));
        // 결제하지 않고 떠난 주문이 계속 쌓인다. 오래된 것부터 버린다.
        prune_old(&mut m, 500);
    }

    // 시세와 그 출처를 여기서 붙잡아 둔다. 이 견적은 손님에게 보여 준 뒤
    // 버려지고 있었는데, 나중에 "그때 레이븐이 얼마였느냐" 에 답할 수 있는
    // 유일한 기록이다. 재구성할 방법이 없다 — 지나간 분 단위 시세는 아무도
    // 되돌려주지 않는다.
    // 🔴 서버에서도 막는다. 화면만 막으면 이미 열어 둔 탭에서 그대로 주문이
    // 들어오고, 그 돈은 확인되지 않는다.
    {
        let (ready, why) = node_can_take_orders().await;
        if !ready {
            return (StatusCode::SERVICE_UNAVAILABLE, Json(json!({ "error": why })));
        }
    }

    // 재고를 잡는다. 🔴 결제할 때 빼면 마지막 하나를 두 손님이 **둘 다**
    // 결제하고, 하나는 못 받는다 — 그 돈은 체인에 들어가 있어 못 되돌린다.
    {
        let menu = state
            .shop
            .lock()
            .map(|s| s.get("menu").cloned().unwrap_or(json!([])))
            .unwrap_or(json!([]));
        if let Err(e) = crate::stock::hold(&address, &menu, &body.items, now) {
            return (StatusCode::CONFLICT, Json(json!({ "error": e })));
        }
    }

    let _ = crate::ledger::open_order(&address, &body.items, &quote, now, table.as_deref());

    // 얼마가 들어와야 결제인가. 손님은 메뉴 가격을 그대로 내고, 가게가 조금
    // 덜 받는다 — 카드가 이미 그렇게 돈다. 그래서 **기대값은 총액이 아니라
    // 가게 몫**이다. 이걸 총액으로 두면 수수료를 뗀 결제가 전부 미달로 보인다.
    let total_rvn = quote.get("rvn").and_then(Value::as_f64).unwrap_or(0.0);
    let fee_cfg = crate::shop::fee_config();
    let split = crate::shop::split_payment(
        total_rvn,
        fee_cfg.0,
        fee_cfg.1.clone(),
    );
    let expect = split["shop_gets"].as_f64().unwrap_or(total_rvn);
    if let Ok(mut u) = state.order_until.lock() {
        let until = quote
            .get("expires_at")
            .and_then(Value::as_i64)
            .unwrap_or(now + 300);
        u.insert(address.clone(), until);
        if u.len() > 500 {
            u.retain(|_, t| *t > now);
        }
    }
    if let Ok(mut e) = state.order_expect.lock() {
        e.insert(address.clone(), expect);
        // 🔴 여기서 표를 **통째로 비우고** 있었다. 501번째 주문이 들어오면 **지금
        // 입금을 기다리는 주문의 기대 금액까지 전부** 사라지고, 그 뒤로는
        // `want = 0` 이라 **얼마가 들어와도 결제 확인**이 된다.
        // 하루 500건을 넘기는 가게에서 그날 오후가 전부 그 상태가 된다.
        //
        // 살아 있는 주문은 절대 안 지운다. 넘치면 **끝난 주문부터** 지운다.
        if e.len() > 500 {
            let alive: std::collections::HashSet<String> = state
                .order_state
                .lock()
                .map(|m| {
                    m.iter()
                        .filter(|(_, (st, _, _))| st == WAITING || st == SHORT)
                        .map(|(k, _)| k.clone())
                        .collect()
                })
                .unwrap_or_default();
            e.retain(|k, _| alive.contains(k));
        }
    }

    (
        StatusCode::OK,
        Json(json!({
            "address": address,
            "quote": quote,
            // 손님 지갑이 한 거래로 둘에게 나눠 보낼 수 있게 알려 준다.
            // 다른 지갑은 모르는 값이라 무시하고 전액을 가게로 보낸다 —
            // 그때는 수수료가 안 걷히지만 **주문은 정상 처리된다**(아래 대조가
            // 가게 몫 이상이면 통과시키므로).
            "fee": split,
            "items": body.items,
            "note": body.note,
            "shop": shop_name,
            "table": table,
            "created": now,
        })),
    )
}

/// Renders a QR on this machine rather than making the customer's phone fetch
/// a script from a CDN — which would also tell that CDN which shop they are
/// standing in.
async fn api_qr(Query(q): Query<std::collections::HashMap<String, String>>) -> impl IntoResponse {
    let text = q.get("text").cloned().unwrap_or_default();
    // Anything longer is not a payment URI, and rendering arbitrary length here
    // is free work for whoever asks.
    if text.is_empty() || text.len() > 512 {
        return (StatusCode::BAD_REQUEST, [("content-type", "text/plain")], String::new());
    }
    match qr_svg(text) {
        Ok(svg) => (
            StatusCode::OK,
            [("content-type", "image/svg+xml")],
            svg,
        ),
        Err(_) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            [("content-type", "text/plain")],
            String::new(),
        ),
    }
}



/// 가게가 언제부터 있는지. 손님 폰이 직접 확인할 수 있어야 우리를 믿을 필요가 없다.
async fn api_shop_history(
    Query(q): Query<std::collections::HashMap<String, String>>,
) -> impl IntoResponse {
    let asset = q.get("a").cloned().unwrap_or_default();
    if asset.is_empty() || asset.len() > 40 {
        return (StatusCode::BAD_REQUEST, Json(json!({ "error": "가게 이름이 없습니다." })));
    }
    match crate::shop::shop_history(asset).await {
        Ok(v) => (StatusCode::OK, Json(v)),
        Err(e) => (StatusCode::BAD_GATEWAY, Json(json!({ "error": e }))),
    }
}


/// 지갑이 서명한 글을 릴레이로 넘긴다.
///
/// 🔴 지갑 화면은 `connect-src 'self'` 라 릴레이로 직접 못 나간다 — 12단어가
/// 그 페이지에 있어서 일부러 막아 둔 것이다. 서명은 브라우저가 끝내고,
/// **바깥으로 나가는 일만** 여기서 한다. 개인키는 여기까지 오지 않는다.
async fn api_nostr_publish(Json(body): Json<Value>) -> impl IntoResponse {
    match crate::nostrpub::nostr_publish(body).await {
        Ok(v) => (StatusCode::OK, Json(v)),
        Err(e) => (StatusCode::BAD_GATEWAY, Json(json!({ "error": e }))),
    }
}


/// 지금 주문을 받아도 되는가.
///
/// 🔴 여태 **영업시간만** 봤다. 재색인 중이거나 노드가 뒤처져 있으면 손님이
/// 낸 돈을 **볼 수가 없다** — 돈은 체인에 들어가고, 손님 화면은 "입금을
/// 기다립니다" 에서 멈추고, 가게는 주문이 온 줄도 모른다. 둘 다 상대를 탓한다.
///
/// 자산 색인을 켜면 34GB 를 몇 시간 다시 훑는다. 그동안 이 문이 열려 있으면
/// 안 된다.
async fn node_can_take_orders() -> (bool, String) {
    match crate::raven::node_status().await {
        Err(_) => (
            false,
            "가게 컴퓨터가 준비 중입니다. 잠시 뒤에 다시 열어 주세요.".into(),
        ),
        Ok(v) => {
            let p = v.get("progress").and_then(Value::as_f64).unwrap_or(0.0);
            // 0.9999 미만이면 아직 따라잡는 중이다. 그 상태로 받은 결제는
            // 확인이 늦거나 아예 안 보인다.
            if p < 0.9999 {
                (
                    false,
                    format!(
                        "가게 컴퓨터가 정리 중입니다({}%). 조금 뒤에 다시 열어 주세요.",
                        (p * 100.0).floor() as i64
                    ),
                )
            } else {
                (true, String::new())
            }
        }
    }
}

// ── 캐릭터 ────────────────────────────────────────────────────────────────
//
// 손님 화면은 `/raven-head.png` 을 부르고 있었는데 이 서버엔 그 경로가 없었다.
// 가게에서 QR 로 연 손님은 **깨진 그림**을 봤다. rvn.ex.erci.se 로 열면
// 나왔기 때문에 우리 눈에는 멀쩡해 보였다.
//
// 화면과 같이 바이너리에 굽는다(`include_bytes!`). 가게 노드는 폴더를 들고
// 다니지 않는다 — 파일로 두면 옮길 때 그림만 빠진다.
//
// webp 다. 같은 그림이 png 로 263KB, webp 로 16KB — 가게 와이파이에서 이건
// 취향이 아니라 조건이다. webp 는 2020년 이후 모든 폰에서 열린다.
const FACES: [(&str, &[u8]); 6] = [
    ("head", include_bytes!("../../web/raven-head.webp")),
    ("hello", include_bytes!("../../web/raven-hello.webp")),
    ("wait", include_bytes!("../../web/raven-wait.webp")),
    ("happy", include_bytes!("../../web/raven-happy.webp")),
    ("worry", include_bytes!("../../web/raven-worry.webp")),
    ("sleep", include_bytes!("../../web/raven-sleep.webp")),
];

/// 손님 화면의 4개 국어 사전. 화면과 같이 바이너리에 굽는다 —
/// 가게 노드는 폴더를 들고 다니지 않는다.
async fn api_i18n() -> impl IntoResponse {
    (
        StatusCode::OK,
        [
            ("content-type", "application/javascript; charset=utf-8"),
            ("cache-control", "public, max-age=3600"),
        ],
        include_str!("../../web/i18n.js"),
    )
}

async fn raven_face(axum::extract::Path(name): axum::extract::Path<String>) -> impl IntoResponse {
    // `raven-happy.webp` 도 `happy` 도 받는다. 예전 화면이 부르던 `.png` 이름도
    // 같은 그림으로 답한다 — 옛 화면이 캐시에 남아 있어도 깨지지 않게.
    let key = name
        .trim_start_matches("raven-")
        .trim_end_matches(".webp")
        .trim_end_matches(".png")
        .to_string();
    match FACES.iter().find(|(k, _)| *k == key) {
        Some((_, bytes)) => (
            StatusCode::OK,
            [
                ("content-type", "image/webp"),
                // 그림은 바뀌지 않는다. 손님이 두 번째 화면을 열 때 다시 받게
                // 하면 느린 와이파이에서 그 값을 그대로 치른다.
                ("cache-control", "public, max-age=604800, immutable"),
            ],
            bytes.to_vec(),
        ),
        None => (
            StatusCode::NOT_FOUND,
            [("content-type", "text/plain"), ("cache-control", "no-store")],
            Vec::new(),
        ),
    }
}

// ── 사장 ──────────────────────────────────────────────────────────────────

async fn admin_page(
    State(state): State<ServerState>,
    headers: HeaderMap,
    Query(q): Query<std::collections::HashMap<String, String>>,
) -> impl IntoResponse {
    let qv = json!(q);
    // 🔴 여기에 빈 HeaderMap 을 넘기면 안 된다. 토큰은 QR 이 실어 준 URL 에서
    // 오지만, 이 요청이 가게 안에서 온 것인지 바깥에서 온 것인지는 **Host
    // 헤더에만** 있다. 빈 것을 넘기면 안전한 쪽으로 "바깥" 이 되어, 사장이
    // 자기 가게 wifi 에서 자기 QR 을 찍어도 문이 안 열린다.
    if !admin_authed(&state, &headers, &qv) {
        return (
            StatusCode::UNAUTHORIZED,
            Html("<h1>접근 권한이 없습니다</h1><p>앱 화면의 QR을 다시 찍어 주세요.</p>"),
        );
    }
    (StatusCode::OK, Html(include_str!("../../web/admin.html")))
}

async fn admin_status(State(state): State<ServerState>, headers: HeaderMap) -> impl IntoResponse {
    if !admin_authed(&state, &headers, &json!({})) {
        return (StatusCode::UNAUTHORIZED, Json(json!({ "error": "권한 없음" })));
    }

    let asked = state.ask_budget.lock().map(|b| b.1).unwrap_or(0);
    let node = crate::raven::node_status().await.unwrap_or(json!({}));
    let balance = crate::raven::wallet_balance().await.unwrap_or(json!({}));
    let lock = crate::raven::wallet_lock_state().await.unwrap_or(json!({}));

    (
        StatusCode::OK,
        Json(json!({
            "node": node, "balance": balance, "lock": lock,
            "ai": { "asked_today": asked, "limit": ASK_PER_DAY },
        })),
    )
}

async fn admin_orders(State(state): State<ServerState>, headers: HeaderMap) -> impl IntoResponse {
    if !authed_for(&state, &headers, &json!({}), "/api/admin/orders") {
        return (StatusCode::UNAUTHORIZED, Json(json!({ "error": "권한 없음" })));
    }
    // 주문마다 주소가 다르므로 가게 주소 하나로는 못 찾는다. 빈 문자열을
    // 넘기면 주문 라벨이 붙은 입금 전부를 가져온다.
    match crate::shop::incoming_payments(String::new(), 1).await {
        Ok(v) => (StatusCode::OK, Json(v)),
        Err(e) => (StatusCode::BAD_GATEWAY, Json(json!({ "error": e }))),
    }
}

#[derive(serde::Deserialize)]
struct PublishBody {
    shop: Value,
    ai_provider: Option<String>,
}

/// The owner edits the shop from their phone.
///
/// This only changes what the customer page serves — it does not touch the
/// chain. Editing a menu should never cost RVN, and it does not.
async fn admin_publish(
    State(state): State<ServerState>,
    headers: HeaderMap,
    Json(body): Json<PublishBody>,
) -> impl IntoResponse {
    if !admin_authed(&state, &headers, &json!({})) {
        return (StatusCode::UNAUTHORIZED, Json(json!({ "error": "권한 없음" })));
    }
    if let Ok(mut s) = state.shop.lock() {
        *s = body.shop.clone();
    }
    // 폰에서 고친 것도 디스크에 남긴다. 사장이 카운터 PC 앞에 없을 때 고친
    // 메뉴가 다음 날 사라지면, 그건 앱이 고장난 것과 구별되지 않는다.
    let _ = crate::shop::shop_save(body.shop);
    if let Some(p) = body.ai_provider {
        if let Ok(mut a) = state.ai.lock() {
            *a = p;
        }
    }
    (StatusCode::OK, Json(json!({ "ok": true })))
}

/// What the owner currently has published, so the phone can edit it rather than
/// starting from an empty form and wiping what the desktop set.
async fn admin_shop(State(state): State<ServerState>, headers: HeaderMap) -> impl IntoResponse {
    if !admin_authed(&state, &headers, &json!({})) {
        return (StatusCode::UNAUTHORIZED, Json(json!({ "error": "권한 없음" })));
    }
    let shop = state.shop.lock().map(|s| s.clone()).unwrap_or(json!({}));
    let ai = state.ai.lock().map(|a| a.clone()).unwrap_or_default();
    (StatusCode::OK, Json(json!({ "shop": shop, "ai": ai })))
}

async fn admin_assets(State(state): State<ServerState>, headers: HeaderMap) -> impl IntoResponse {
    if !admin_authed(&state, &headers, &json!({})) {
        return (StatusCode::UNAUTHORIZED, Json(json!({ "error": "권한 없음" })));
    }
    match crate::raven::list_assets().await {
        Ok(v) => (StatusCode::OK, Json(json!({ "assets": v }))),
        Err(e) => (StatusCode::BAD_GATEWAY, Json(json!({ "error": e }))),
    }
}

#[derive(serde::Deserialize)]
struct AdminAiBody {
    provider: String,
    message: String,
    state: Value,
    history: Value,
}

async fn admin_ai(
    State(st): State<ServerState>,
    headers: HeaderMap,
    Json(body): Json<AdminAiBody>,
) -> impl IntoResponse {
    if !admin_authed(&st, &headers, &json!({})) {
        return (StatusCode::UNAUTHORIZED, Json(json!({ "error": "권한 없음" })));
    }
    match crate::ai::ai_chat(body.provider, body.message, body.state, body.history).await {
        Ok(v) => (StatusCode::OK, Json(v)),
        Err(e) => (StatusCode::BAD_GATEWAY, Json(json!({ "error": e }))),
    }
}

#[derive(serde::Deserialize)]
struct IssueBody {
    name: String,
    qty: f64,
    units: u8,
    reissuable: bool,
    ipfs_hash: Option<String>,
    /// The owner types the asset name again. Same gate as the desktop.
    confirm: String,
    passphrase: Option<String>,
}

/// Issues an asset from the phone. Burns RVN. Cannot be undone.
///
/// The confirmation is checked *here*, on the server, not only in the phone's
/// JavaScript. A gate that lives only in the page is not a gate — anyone with
/// the token can skip it by calling this endpoint directly.
async fn admin_issue(
    State(state): State<ServerState>,
    headers: HeaderMap,
    Json(body): Json<IssueBody>,
) -> impl IntoResponse {
    if !admin_authed(&state, &headers, &json!({})) {
        return (StatusCode::UNAUTHORIZED, Json(json!({ "error": "권한 없음" })));
    }
    if body.confirm.trim() != body.name.trim() {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "확인용 이름이 일치하지 않습니다." })),
        );
    }

    // An encrypted wallet needs opening for exactly this one call.
    let locked = matches!(
        crate::raven::call_rpc("getwalletinfo", json!([]))
            .await
            .ok()
            .and_then(|i| i.get("unlocked_until").and_then(Value::as_i64)),
        Some(0)
    );
    if locked {
        let Some(pass) = body.passphrase.clone() else {
            return (
                StatusCode::BAD_REQUEST,
                Json(json!({ "error": "지갑이 잠겨 있습니다. 암호가 필요합니다." })),
            );
        };
        if let Err(e) = crate::raven::call_rpc("walletpassphrase", json!([pass, 30])).await {
            return (StatusCode::BAD_REQUEST, Json(json!({ "error": e })));
        }
    }

    let result = crate::issue::issue_asset(
        body.name,
        body.qty,
        body.units,
        body.reissuable,
        body.ipfs_hash,
        None,
    )
    .await;

    if locked {
        let _ = crate::raven::call_rpc("walletlock", json!([])).await;
    }

    match result {
        Ok(txid) => (StatusCode::OK, Json(json!({ "txid": txid }))),
        Err(e) => (StatusCode::BAD_GATEWAY, Json(json!({ "error": e }))),
    }
}

async fn staff_page(
    State(state): State<ServerState>,
    headers: HeaderMap,
    Query(q): Query<std::collections::HashMap<String, String>>,
) -> impl IntoResponse {
    if !authed_for(&state, &headers, &json!(q), "/staff") {
        return (StatusCode::UNAUTHORIZED, Html("<h1>접근 권한이 없습니다</h1>"));
    }
    (StatusCode::OK, Html(include_str!("../../web/staff.html")))
}

async fn scan_page(
    State(state): State<ServerState>,
    headers: HeaderMap,
    Query(q): Query<std::collections::HashMap<String, String>>,
) -> impl IntoResponse {
    if !authed_for(&state, &headers, &json!(q), "/scan") {
        return (StatusCode::UNAUTHORIZED, Html("<h1>접근 권한이 없습니다</h1>"));
    }
    (StatusCode::OK, Html(include_str!("../../web/scan.html")))
}

#[derive(serde::Deserialize)]
struct ScanBody {
    query: String,
}

/// The door tablet: one question, one answer.
///
/// Deliberately returns only what the door needs — name, in or out, why not.
/// A scanner token must not be able to enumerate the member list, because that
/// tablet sits unattended all day where anyone can pick it up.
async fn api_scan(
    State(state): State<ServerState>,
    headers: HeaderMap,
    Json(body): Json<ScanBody>,
) -> impl IntoResponse {
    if !authed_for(&state, &headers, &json!({}), "/api/scan/check") {
        return (StatusCode::UNAUTHORIZED, Json(json!({ "error": "권한 없음" })));
    }
    let now = now_unix();
    match crate::pass::check_in_lookup(body.query, now) {
        Ok(v) => {
            let first = v["matches"].as_array().and_then(|a| a.first()).cloned();
            match first {
                Some(m) => (
                    StatusCode::OK,
                    Json(json!({
                        "found": true,
                        "name": m.get("name"),
                        "valid": m.get("valid"),
                        "why": m.get("why"),
                        "left": m.get("left"),
                        "asset": m.get("asset"),
                        "kind": m.get("kind"),
                    })),
                ),
                None => (StatusCode::OK, Json(json!({ "found": false }))),
            }
        }
        Err(e) => (StatusCode::BAD_GATEWAY, Json(json!({ "error": e }))),
    }
}

#[derive(serde::Deserialize)]
struct ScanInBody {
    asset: String,
}

async fn api_scan_in(
    State(state): State<ServerState>,
    headers: HeaderMap,
    Json(body): Json<ScanInBody>,
) -> impl IntoResponse {
    if !authed_for(&state, &headers, &json!({}), "/api/scan/in") {
        return (StatusCode::UNAUTHORIZED, Json(json!({ "error": "권한 없음" })));
    }
    match crate::pass::check_in(body.asset, now_unix()) {
        Ok(v) => (StatusCode::OK, Json(v)),
        Err(e) => (StatusCode::BAD_REQUEST, Json(json!({ "error": e }))),
    }
}

/// Starts the server. Returns the token and the URLs to put on screen.
///
/// Sending from the phone is deliberately absent for now. Remote spend needs a
/// second confirmation path that does not exist yet, and shipping "approve a
/// payment from your phone" without it would put the wallet one stolen token
/// away from being emptied.
#[tauri::command]
pub async fn start_phone_server(
    state: tauri::State<'_, ServerState>,
) -> Result<Value, String> {
    let st = ServerState {
        token: state.token.clone(),
        role_tokens: state.role_tokens.clone(),
        shop: state.shop.clone(),
        ai: state.ai.clone(),
        shops_cache: state.shops_cache.clone(),
        ask_budget: state.ask_budget.clone(),
        offers: state.offers.clone(),
        claims: state.claims.clone(),
        sent: state.sent.clone(),
        order_state: state.order_state.clone(),
        next_ticket: state.next_ticket.clone(),
        ticket_day: state.ticket_day.clone(),
        last_sweep: state.last_sweep.clone(),
        remote_admin: state.remote_admin.clone(),
        order_table: state.order_table.clone(),
        order_expect: state.order_expect.clone(),
        order_until: state.order_until.clone(),
        order_times: state.order_times.clone(),
    };
    let owner_token = st.token.lock().map(|t| t.clone()).unwrap_or_default();
    if owner_token.is_empty() {
        return Err("이 컴퓨터에서 안전한 임의 값을 만들지 못해 원격 접속을 켜지 않았습니다.".into());
    }

    let customer = Router::new()
        .route("/", get(customer_page))
        // 사진을 우리가 대신 내준다.
        //
        // IPFS 게이트웨이는 기본이 127.0.0.1 에만 묶여 있어서, 손님 폰이
        // 192.168.x.x:8080 으로 가면 연결 자체가 안 된다 — 메뉴는 뜨는데
        // 사진만 깨진 화면이 그래서 나왔다.
        //
        // 손님 컴퓨터의 IPFS 설정을 바꾸게 하는 대신 우리가 중계한다. 포트가
        // 하나로 줄고, 방화벽 구멍도 하나면 되고, 무엇보다 Cloudflare 터널로
        // 밖에서 접속한 손님에게도 사진이 간다 — 터널은 이 포트만 통과한다.
        .route("/ipfs/{*path}", get(ipfs_relay))
        // 손님 지갑이 쓰는 세 가지. 노드 RPC 는 여기 없다 — RPC 는 방이 없는
        // 문 하나라, 손님 폰의 URL 뒤에 가게 지갑을 두는 셈이 된다.
        // 손님 지갑. 인증 없이 — 손님에게 토큰을 요구하면 그건 주문이 아니라
        // 로그인이다. 열쇠는 브라우저 안에만 있고 서버로 오지 않는다.
        .route("/wallet", get(wallet_page))
        .route("/wallet.bundle.js", get(wallet_bundle))
        .route("/api/chain/address", get(chain_address_route))
        .route("/api/chain/send", post(chain_send_route))
        .route("/api/shop", get(api_shop))
        .route("/api/ask", post(api_ask))
        .route("/api/owner-ask", post(api_owner_ask))
        .route("/api/order", post(api_order))
        .route("/api/qr", get(api_qr))
        .route("/i18n.js", get(api_i18n))
        .route("/ravi.js", get(api_ravi_js))
        .route("/api/ai-status", get(api_ai_status))
        .route("/api/shop-history", get(api_shop_history))
        .route("/api/nostr/publish", post(api_nostr_publish))
        .route("/api/nostr/query", post(api_nostr_query))
        .route("/{name}.webp", get(raven_face))
        .route("/{name}.png", get(raven_face))
        .route("/shops", get(shops_page))
        .route("/api/shops", get(api_shops))
        .route("/api/ipfs-kind", get(api_ipfs_kind))
        .route("/api/chain/asset", get(api_chain_asset))
        .route("/api/notices", get(api_notices))
        .route("/api/shop-profile", get(api_shop_profile))
        .route("/api/directions", get(api_directions))
        .route("/buy", get(buy_page))
        .route("/api/offer", get(api_offer))
        .route("/api/check-address", get(api_check_address))
        .route("/api/claim", post(api_claim))
        .route("/api/paid", get(api_paid))
        .route("/api/order-state", get(api_order_state));

    // A separate router, not a separate handler: there is no path from these
    // routes into wallet code, by construction rather than by discipline.
    let admin = Router::new()
        .route("/admin", get(admin_page))
        .route("/api/admin/status", get(admin_status))
        .route("/api/admin/orders", get(admin_orders))
        .route("/api/admin/shop", get(admin_shop))
        .route("/api/admin/publish", post(admin_publish))
        .route("/api/admin/assets", get(admin_assets))
        .route("/api/admin/ai", post(admin_ai))
        .route("/api/admin/issue", post(admin_issue))
        .route("/api/admin/state", post(admin_set_state))
        .route("/api/admin/states", get(admin_states))
        // 이 컴퓨터 탭 — 노드 상태·재시작·백업.
        .route("/api/admin/machine", get(admin_machine))
        .route("/api/admin/machine/start", post(admin_machine_start))
        .route("/api/admin/backup", post(admin_backup))
        // 직원 환불. 한도는 refund.rs 가 건다.
        .route("/api/staff/refund/limits", get(staff_refund_limits_route))
        .route("/api/staff/refund", post(staff_refund_route))
        .route("/staff", get(staff_page))
        .route("/scan", get(scan_page))
        .route("/api/scan/check", post(api_scan))
        .route("/api/scan/in", post(api_scan_in));

    let app = customer.merge(admin).with_state(st.clone());

    // 이미 우리가 듣고 있으면 그건 실패가 아니라 "이미 켜져 있음"이다.
    //
    // 두 번 누르거나 앱이 다시 그릴 때마다 여기로 오는데, 그때 "Address already
    // in use" 를 그대로 보여 주면 화면에는 [켜짐] 옆에 빨간 오류가 같이 뜬다.
    // 사장은 켜진 것을 고장으로 읽는다.
    match tokio::net::TcpListener::bind(("0.0.0.0", PORT)).await {
        Ok(listener) => {
            tokio::spawn(async move {
                let _ = axum::serve(listener, app).await;
            });
        }
        Err(e) if e.kind() == std::io::ErrorKind::AddrInUse => {
            // 우리가 아니라 남이 쓰고 있을 수도 있다. 우리 화면이 응답하는지
            // 물어보고, 응답하면 그대로 쓴다.
            let ours = reqwest::Client::new()
                .get(format!("http://127.0.0.1:{PORT}/api/shop"))
                .timeout(std::time::Duration::from_secs(2))
                .send()
                .await
                .map(|r| r.status().is_success())
                .unwrap_or(false);
            if !ours {
                return Err(format!(
                    "{PORT} 포트를 다른 프로그램이 쓰고 있습니다. 그 프로그램을 끄고 다시 켜세요."
                ));
            }
        }
        Err(e) => return Err(format!("{PORT} 포트를 열지 못했습니다: {e}")),
    }

    let ip = local_ip().unwrap_or_else(|| "127.0.0.1".into());
    // 역할 토큰을 먼저 꺼낸다 — json! 매크로 안에서는 블록을 쓸 수 없다.
    let (staff_t, scan_t) = st
        .role_tokens
        .lock()
        .map(|m| {
            (
                m.get("staff").cloned().unwrap_or_default(),
                m.get("scanner").cloned().unwrap_or_default(),
            )
        })
        .unwrap_or_default();

    Ok(json!({
        "running": true,
        "port": PORT,
        "customer_url": format!("http://{ip}:{PORT}/"),
        "platform_url": format!("http://{ip}:{PORT}/shops"),
        "staff_url": format!("http://{ip}:{PORT}/staff?t={staff_t}"),
        "scan_url": format!("http://{ip}:{PORT}/scan?t={scan_t}"),
        "admin_url": format!("http://{ip}:{PORT}/admin?t={owner_token}"),
        "ip": ip,
    }))
}

/// This machine's address on the local network.
///
/// Found by asking the OS which interface it would use to reach the outside
/// world, without sending anything: a connected UDP socket only records a
/// destination, it does not transmit.
fn local_ip() -> Option<String> {
    let sock = std::net::UdpSocket::bind("0.0.0.0:0").ok()?;
    sock.connect("8.8.8.8:80").ok()?;
    Some(sock.local_addr().ok()?.ip().to_string())
}

/// Publishes a listing so the sale page can serve it.
#[tauri::command]
pub fn publish_offer(
    state: tauri::State<'_, ServerState>,
    id: String,
    offer: Value,
) -> Result<(), String> {
    state
        .offers
        .lock()
        .map_err(|_| "잠금 실패")?
        .insert(id, offer);
    Ok(())
}

/// Takes a listing down. The link stops working; nothing already paid is lost.
#[tauri::command]
pub fn withdraw_offer(state: tauri::State<'_, ServerState>, id: String) -> Result<(), String> {
    state.offers.lock().map_err(|_| "잠금 실패")?.remove(&id);
    Ok(())
}

/// Buyers who paid and are waiting, in the shape `auto_fulfil` expects.
#[tauri::command]
pub fn pending_claims(state: tauri::State<'_, ServerState>) -> Result<Value, String> {
    let claims = state.claims.lock().map_err(|_| "잠금 실패")?;
    let offers = state.offers.lock().map_err(|_| "잠금 실패")?;
    let sent = state.sent.lock().map_err(|_| "잠금 실패")?;

    let out: Vec<Value> = claims
        .iter()
        .filter(|(addr, _)| !sent.contains(*addr))
        .filter_map(|(addr, (id, to))| {
            let o = offers.get(id)?;
            Some(json!({
                "asset": o.get("asset"),
                "qty": o.get("qty"),
                "address": addr,
                "deliver_to": to,
                "daily_cap": o.get("daily_cap").and_then(Value::as_f64).unwrap_or(0.0),
                // 금액 검증의 기준. 이게 없으면 1 사토시로 물건이 나간다.
                "rvn": o.get("rvn").and_then(Value::as_f64).unwrap_or(0.0),
            }))
        })
        .collect();
    Ok(json!({ "claims": out }))
}

/// Where the buyer's orders live between restarts.
fn orders_path() -> std::path::PathBuf {
    crate::paths::app_file("orders.json")
}

/// Saves the one thing the chain cannot tell us: where each buyer wants their
/// asset delivered.
///
/// Deliberately does NOT record "already sent". That is a claim the chain can
/// answer for itself, and a file that says it when the chain disagrees is how
/// a paying customer gets nothing — or gets served twice.
fn persist_orders(state: &ServerState) {
    let claims = match state.claims.lock() {
        Ok(c) => c,
        Err(_) => return,
    };
    let offers = state.offers.lock().ok();
    let rows: Vec<Value> = claims
        .iter()
        .map(|(addr, (id, to))| {
            let asset = offers
                .as_ref()
                .and_then(|o| o.get(id))
                .and_then(|o| o.get("asset"))
                .cloned()
                .unwrap_or(Value::Null);
            json!({ "address": addr, "id": id, "deliver_to": to, "asset": asset })
        })
        .collect();

    if let Some(dir) = orders_path().parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    if let Ok(bytes) = serde_json::to_vec_pretty(&json!({ "orders": rows })) {
        let _ = std::fs::write(orders_path(), bytes);
    }
}

/// Reads them back on startup so a buyer who paid before a restart is not lost.
#[tauri::command]
pub fn load_orders(state: tauri::State<'_, ServerState>) -> Result<Value, String> {
    let raw = match std::fs::read_to_string(orders_path()) {
        Ok(r) => r,
        Err(_) => return Ok(json!({ "orders": [] })),
    };
    let doc: Value = serde_json::from_str(&raw).unwrap_or(json!({}));
    let rows = doc.get("orders").cloned().unwrap_or(json!([]));

    if let Ok(mut claims) = state.claims.lock() {
        for r in rows.as_array().cloned().unwrap_or_default() {
            let (Some(a), Some(id), Some(to)) = (
                r.get("address").and_then(Value::as_str),
                r.get("id").and_then(Value::as_str),
                r.get("deliver_to").and_then(Value::as_str),
            ) else {
                continue;
            };
            claims.insert(a.to_string(), (id.to_string(), to.to_string()));
        }
    }
    Ok(json!({ "orders": rows }))
}

/// Records that a buyer's asset has gone out, so the page can say so and the
/// same payment is never filled twice.
#[tauri::command]
pub fn mark_sent(state: tauri::State<'_, ServerState>, addresses: Vec<String>) -> Result<(), String> {
    let mut s = state.sent.lock().map_err(|_| "잠금 실패")?;
    for a in addresses {
        // 디스크에도 남긴다. 이 집합만 있으면 앱을 다시 켤 때 기억이 사라지고,
        // 지갑에는 그 결제가 아직 최근 200건 안에 남아 있어서 같은 주문에
        // 자산이 한 번 더 나간다. 자동 발송(auto.rs)과 같은 파일을 쓴다 —
        // 중복 방지 기록이 두 벌이면 두 벌 다 맞아야 하고, 그건 한 벌만
        // 맞으면 되는 것보다 반드시 나쁘다.
        crate::auto::mark_filled(&a);
        s.insert(a);
    }
    Ok(())
}

/// Publishes what the customer page shows, and which provider answers.
#[tauri::command]
pub fn publish_shop(
    state: tauri::State<'_, ServerState>,
    shop: Value,
    ai_provider: String,
) -> Result<(), String> {
    *state.shop.lock().map_err(|_| "잠금 실패")? = shop;
    *state.ai.lock().map_err(|_| "잠금 실패")? = ai_provider;
    Ok(())
}

/// Order states, for the desktop screen.
#[tauri::command]
pub fn order_states(state: tauri::State<'_, ServerState>) -> Result<Value, String> {
    let m = state.order_state.lock().map_err(|_| "잠금 실패")?;
    let rows: Vec<Value> = m
        .iter()
        .map(|(addr, (s, at, t))| json!({ "address": addr, "state": s, "at": at, "ticket": t }))
        .collect();
    Ok(json!({ "orders": rows }))
}

/// Moves an order along from the desktop.
#[tauri::command]
pub fn set_order_state(
    state: tauri::State<'_, ServerState>,
    address: String,
    new_state: String,
) -> Result<u32, String> {
    if !STATES.contains(&new_state.as_str()) {
        return Err("알 수 없는 상태입니다.".into());
    }
    let mut m = state.order_state.lock().map_err(|_| "잠금 실패")?;
    let ticket = m.get(&address).map(|(_, _, t)| *t).unwrap_or_else(|| next_ticket(&state));
    m.insert(address, (new_state, now_unix(), ticket));
    Ok(ticket)
}

/// Issues a fresh token for one role, invalidating the old one.
///
/// This is how a staff phone that walked out of the building is dealt with:
/// rotate that role, hand the new QR to whoever is still here, and the counter
/// never stops.
#[tauri::command]
pub fn rotate_role_token(state: tauri::State<'_, ServerState>, role: String) -> Result<(), String> {
    if !["staff", "scanner"].contains(&role.as_str()) {
        return Err("이 역할은 새로 만들 수 없습니다.".into());
    }
    let mut m = state.role_tokens.lock().map_err(|_| "잠금 실패")?;
    m.insert(role, random_token());
    // 🔴 저장을 안 하고 있었다. 잃어버린 직원 폰을 끊었다고 생각한 뒤 앱을
    // 다시 켜면 **옛 토큰이 되살아나** 그 폰의 URL 이 다시 열린다.
    // 끊는 것은 지금만이 아니라 앞으로도 끊긴 것이어야 한다.
    let snapshot = m.clone();
    drop(m);
    let owner = state.token.lock().map(|t| t.clone()).unwrap_or_default();
    save_tokens(&owner, &snapshot);
    Ok(())
}

/// Whether the till and staff screens answer requests from the internet.
///
/// Split from the tunnel switch on purpose. Opening a public address and handing
/// the shop's own tools to the public are two different decisions, and merging
/// them means the second one gets made by accident while making the first.
/// Off by default; the customer side is unaffected either way.
#[tauri::command]
pub fn remote_admin_get(state: tauri::State<'_, ServerState>) -> bool {
    state.remote_admin.lock().map(|v| *v).unwrap_or(false)
}

#[tauri::command]
pub fn remote_admin_set(state: tauri::State<'_, ServerState>, on: bool) -> Result<Value, String> {
    *state.remote_admin.lock().map_err(|_| "잠금 실패")? = on;
    Ok(json!({
        "on": on,
        "note": if on {
            "이제 바깥 주소로도 계산대·직원 화면이 열립니다. 폰을 잃어버리면 「모든 폰 로그아웃」을 누르세요."
        } else {
            "바깥 주소로는 손님 화면만 열립니다. 계산대와 직원 화면은 가게 안에서만 열립니다."
        },
    }))
}

/// Cuts off every phone at once — the lost-phone button.
///
/// Rotates the owner token as well as the staff ones. A phone in a taxi carries
/// a URL that opens the shop screen: orders, states, doors. Changing the tokens
/// makes that URL dead in the time it takes to press this, and no chain
/// transaction is involved because none of it ever touched the chain.
///
/// It logs out the shop's own phones too, which is why it says so and why the
/// fresh QR codes come back in the same result.
#[tauri::command]
pub fn logout_all_phones(state: tauri::State<'_, ServerState>) -> Result<Value, String> {
    let fresh = random_token();
    if let Ok(mut t) = state.token.lock() {
        *t = fresh.clone();
    }
    let mut roles = std::collections::HashMap::new();
    if let Ok(mut m) = state.role_tokens.lock() {
        for r in ["staff", "scanner"] {
            let t = random_token();
            m.insert(r.to_string(), t.clone());
            roles.insert(r.to_string(), t);
        }
    }
    // 새 토큰도 남긴다. 안 그러면 다음 재시작에 옛 토큰이 되살아난다.
    save_tokens(&fresh, &roles);
    Ok(json!({
        "done": true,
        "message": "모든 폰이 끊겼습니다. 잃어버린 폰의 주소는 이제 열리지 않습니다.",
        "next": "직원 폰과 사장 폰에 새 QR을 다시 찍어 주세요.",
    }))
}

/// An SVG QR code for a URL, so the owner points a phone instead of typing an
/// IP address and a 64-character token.
#[tauri::command]
pub fn qr_svg(text: String) -> Result<String, String> {
    use qrcode::{render::svg, QrCode};
    let code = QrCode::new(text.as_bytes()).map_err(|e| format!("QR을 만들지 못했습니다: {e}"))?;
    Ok(code
        .render::<svg::Color>()
        .min_dimensions(220, 220)
        .dark_color(svg::Color("#111111"))
        .light_color(svg::Color("#ffffff"))
        .build())
}

impl Default for ServerState {
    fn default() -> Self {
        Self {
            // 저장된 것이 있으면 그대로 쓴다. 없을 때만 새로 만들고 남긴다.
            token: Arc::new(Mutex::new(
                load_tokens().map(|(o, _)| o).unwrap_or_else(|| {
                    let o = random_token();
                    let roles: std::collections::HashMap<String, String> = ["staff", "scanner"]
                        .iter()
                        .map(|r| (r.to_string(), random_token()))
                        .collect();
                    save_tokens(&o, &roles);
                    o
                }),
            )),
            role_tokens: Arc::new(Mutex::new(
                load_tokens().map(|(_, r)| r).unwrap_or_default(),
            )),
            // 저장된 가게로 시작한다. 빈 값으로 시작하면 손님 폰에 빈 메뉴가
            // 뜨고, 사장은 그걸 보고 서버가 죽었다고 생각한다.
            shop: Arc::new(Mutex::new(crate::shop::shop_load())),
            ai: Arc::new(Mutex::new(String::new())),
            shops_cache: Arc::new(Mutex::new(None)),
            ask_budget: Arc::new(Mutex::new((0, 0, 0))),
            offers: Arc::new(Mutex::new(std::collections::HashMap::new())),
            claims: Arc::new(Mutex::new(std::collections::HashMap::new())),
            sent: Arc::new(Mutex::new(std::collections::HashSet::new())),
            order_state: Arc::new(Mutex::new(std::collections::HashMap::new())),
            next_ticket: Arc::new(Mutex::new(1)),
            ticket_day: Arc::new(Mutex::new(0)),
            last_sweep: Arc::new(Mutex::new(0)),
            remote_admin: Arc::new(Mutex::new(false)),
            order_table: Arc::new(Mutex::new(std::collections::HashMap::new())),
            order_expect: Arc::new(Mutex::new(std::collections::HashMap::new())),
            order_until: Arc::new(Mutex::new(std::collections::HashMap::new())),
            order_times: Arc::new(Mutex::new(Vec::new())),
        }
    }
}

#[cfg(test)]
mod outside {
    use super::{customer_path, from_outside};
    use axum::http::HeaderMap;

    fn h(host: &str) -> HeaderMap {
        let mut m = HeaderMap::new();
        if !host.is_empty() {
            m.insert("host", host.parse().unwrap());
        }
        m
    }

    /// 터널은 127.0.0.1:8790 으로 넘겨주므로 출발지 주소로는 구별이 안 된다.
    /// Host 만 남고, 그게 유일한 단서다.
    #[test]
    fn the_shop_wifi_and_the_internet_are_told_apart_by_host() {
        for inside in [
            "192.168.0.42:8790",
            "10.0.1.7:8790",
            "172.16.5.1:8790",
            "172.31.255.254:8790",
            "localhost:8790",
            "127.0.0.1:8790",
            "mac-mini.local:8790",
        ] {
            assert!(!from_outside(&h(inside)), "{inside} 를 바깥으로 봤습니다");
        }
        for outside in [
            "abc-def-ghi.trycloudflare.com",
            "shop.example.com:8790",
            "203.0.113.9:8790",
            // 172.32 는 사설 대역이 아니다. 앞 세 글자만 보고 통과시키면
            // 남의 공인 IP 를 우리 집처럼 취급하게 된다.
            "172.32.0.1:8790",
            "172.15.0.1:8790",
        ] {
            assert!(from_outside(&h(outside)), "{outside} 를 안쪽으로 봤습니다");
        }
        // Host 없는 요청은 브라우저가 아니다. 안전한 쪽으로 센다.
        assert!(from_outside(&h("")));
    }

    /// 🔴 관리 화면 핸들러가 **진짜 헤더**를 넘기는지.
    ///
    /// 이 셋은 토큰을 QR 이 실어 준 URL 에서 받으므로, 예전에는 헤더가 필요
    /// 없다고 보고 `HeaderMap::new()` 를 넘겼다. 그런데 `from_outside` 가
    /// 들어오면서 Host 를 읽게 됐고, 빈 헤더는 안전한 쪽으로 "바깥" 이 된다 —
    /// 사장이 자기 가게 wifi 에서 자기 QR 을 찍어도 401 이 났다. 손님 화면만
    /// 멀쩡해서 "QR 이 잘못 나왔나" 로 보였다.
    ///
    /// 소스를 읽어 확인한다. 타입 검사도 시험도 이걸 못 잡았기 때문이다.
    #[test]
    fn the_qr_pages_pass_real_headers() {
        let src = include_str!("../src/server.rs");
        for f in ["admin_page", "staff_page", "scan_page"] {
            let at = src.find(&format!("async fn {f}(")).expect(f);
            // 바이트로 자르면 한글 한가운데를 잘라 패닉이 난다. 글자 단위로.
            let body: String = src[at..].chars().take(400).collect();
            assert!(
                !body.contains("HeaderMap::new()"),
                "{f} 가 빈 헤더를 넘깁니다 — QR 로 들어오는 화면이 전부 막힙니다"
            );
            assert!(
                body.contains("headers: HeaderMap"),
                "{f} 가 헤더를 안 받습니다"
            );
        }
    }

    /// 바깥에 열리는 것은 손님 쪽뿐이다. 여기 실수로 관리 경로가 끼면
    /// 터널을 켠 모든 가게의 계산대가 그날로 인터넷에 열린다.
    #[test]
    fn nothing_that_runs_the_shop_is_a_customer_path() {
        for open in ["/", "/buy", "/api/order", "/api/order-state", "/api/paid", "/ipfs/QmX"] {
            assert!(customer_path(open), "{open} 이 손님 경로에서 빠졌습니다");
        }
        for shut in [
            "/admin",
            "/staff",
            "/scan",
            "/api/admin/status",
            "/api/admin/orders",
            "/api/admin/issue",
            "/api/admin/backup",
            "/api/admin/machine",
            "/api/staff/refund",
            "/api/scan/check",
            "/api/scan/in",
        ] {
            assert!(!customer_path(shut), "{shut} 가 인터넷에 열려 있습니다");
        }
    }
}

/// 테이블마다 QR 한 장씩, 인쇄해서 자를 수 있는 한 장으로.
///
/// ## 왜 앱 안에서 인쇄하지 않는가
///
/// WKWebView 에는 `print()` 가 없다. 눌러도 아무 일이 안 나고 오류도 안 난다 —
/// 복구 카드에서 이미 그렇게 죽어 있었다. 그래서 진짜 파일을 만들어 기본
/// 브라우저로 연다. 거기 ⌘P 는 동작하고, 파일이 바탕화면에 남아 다음에 또
/// 뽑을 수 있다.
///
/// ## 손님 QR 에만 테이블을 붙인다
///
/// 사장·직원·검표 QR 에는 **열쇠가 들어 있다.** 그걸 인쇄해 벽에 붙이는 것은
/// 열쇠를 벽에 붙이는 것이다. 손님 주소(`http://ip:8790/`)에는 열쇠가 없어서
/// 붙여도 되고, 그래서 이 기능은 손님 것만 만든다.
#[tauri::command]
pub fn table_qr_sheet(
    state: tauri::State<'_, ServerState>,
    ip: String,
    tables: Vec<String>,
) -> Result<Value, String> {
    if tables.is_empty() {
        return Err("테이블을 하나 이상 적어 주세요.".into());
    }
    let shop = state
        .shop
        .lock()
        .ok()
        .and_then(|s| s.get("name").and_then(Value::as_str).map(str::to_string))
        .unwrap_or_default();

    let esc = |s: &str| s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;");

    let mut cards = String::new();
    for t in tables.iter().take(60) {
        let t = t.trim();
        if t.is_empty() {
            continue;
        }
        let url = format!(
            "http://{ip}:{PORT}/?table={}",
            crate::tunnel::urlencode(t)
        );
        let svg = qr_svg(url.clone())?;
        cards.push_str(&format!(
            r#"<div class="c"><div class="t">{}</div>{svg}<div class="n">{}</div></div>"#,
            esc(t),
            esc(&shop),
        ));
    }

    let html = format!(
        r#"<!doctype html><html lang="ko"><head><meta charset="utf-8">
<title>테이블 QR — {shop_t}</title>
<style>
  @page {{ size: A4; margin: 12mm; }}
  body {{ font: 12pt -apple-system,"Apple SD Gothic Neo",sans-serif; margin:0; }}
  .g {{ display: grid; grid-template-columns: repeat(3, 1fr); gap: 8mm; }}
  .c {{ border: 1px dashed #999; border-radius: 4mm; padding: 6mm 4mm; text-align: center;
        break-inside: avoid; }}
  .c svg {{ width: 100%; height: auto; max-width: 46mm; }}
  .t {{ font-size: 20pt; font-weight: 700; margin-bottom: 3mm; }}
  .n {{ font-size: 9pt; color: #555; margin-top: 3mm; }}
  .tip {{ margin-bottom: 6mm; font-size: 10pt; color: #555; }}
  @media print {{ .tip {{ display: none; }} }}
</style></head><body>
<div class="tip">인쇄하려면 ⌘P 를 누르세요. 점선을 따라 잘라 테이블에 두시면 됩니다.</div>
<div class="g">{cards}</div>
</body></html>"#,
        shop_t = esc(&shop),
    );

    let home = std::env::var("HOME").unwrap_or_default();
    let desktop = std::path::PathBuf::from(&home).join("Desktop");
    let dir = if desktop.is_dir() {
        desktop
    } else {
        std::path::PathBuf::from(&home)
    };
    let path = dir.join("테이블QR.html");
    std::fs::write(&path, html.as_bytes()).map_err(|e| format!("파일을 쓰지 못했습니다: {e}"))?;
    open::that(&path).map_err(|e| format!("브라우저를 열지 못했습니다: {e}"))?;

    Ok(json!({
        "path": path.to_string_lossy(),
        "count": tables.len(),
        "say": "브라우저에서 열었습니다. ⌘P 를 누르면 인쇄됩니다.",
    }))
}

#[cfg(test)]
mod spam {
    use super::{ORDERS_PER_DAY, ORDERS_PER_MIN};

    /// 🔴 이 한도가 사라지면 지갑이 무한히 붓는다.
    ///
    /// 실측(2026-08-20): 열쇠 없이 `/api/order` 를 0.16초에 한 번씩 부를 수
    /// 있었고, 만들어진 주소는 `ismine=true` 로 진짜 wallet.dat 에 들어갔다.
    /// 시간당 2만 개. 터널을 켜면 인터넷 어디서나 가능했다.
    #[test]
    fn the_limits_are_tight_enough_to_matter_and_loose_enough_to_sell() {
        // 바쁜 카운터도 3초에 한 명이다. 분당 20을 넘으면 사람이 아니다.
        assert!(ORDERS_PER_MIN <= 30, "분당 한도가 너무 헐겁습니다");
        assert!(ORDERS_PER_MIN >= 10, "분당 한도가 장사를 막습니다");
        // 분당만 두면 하루 종일 천천히 두드려 2만 개를 만든다.
        assert!(ORDERS_PER_DAY <= 5_000, "하루 한도가 너무 헐겁습니다");
        // 하루 종일 분당 한도로 두드리면 28,800 이다. 하루 한도가 그보다
        // 작아야 실제로 걸린다 — 크면 있으나 마나다.
        assert!(ORDERS_PER_DAY < ORDERS_PER_MIN * 60 * 24);
        // 하루 2,000건이면 12시간 영업에 분당 2.8건. 어떤 카페도 안 넘는다.
        assert!(ORDERS_PER_DAY >= 1_000, "하루 한도가 장사를 막습니다");
    }
}

#[cfg(test)]
mod face_tests {
    use super::FACES;

    /// 화면이 부르는 그림 이름이 실제로 없으면 **404 가 나고 자리만 빈다.**
    /// 실제로 그렇게 나 있었다 — customer/wallet 이 `/raven-head.png` 을 불렀는데
    /// 이 서버엔 그 경로가 없었다. rvn.ex.erci.se 로 열면 나왔기 때문에
    /// 우리 눈에는 멀쩡했고, 가게에서 QR 로 연 손님만 깨진 그림을 봤다.
    #[test]
    fn every_face_the_screens_ask_for_exists() {
        let sources: [(&str, &str); 4] = [
            ("customer.html", include_str!("../../web/customer.html")),
            ("wallet.html", include_str!("../../web/wallet.html")),
            ("shops.html", include_str!("../../web/shops.html")),
            ("admin.html", include_str!("../../web/admin.html")),
        ];
        let mut checked = 0;
        for (who, src) in sources {
            for (i, _) in src.match_indices("raven-") {
                let rest = &src[i + "raven-".len()..];
                let name: String = rest
                    .chars()
                    .take_while(|c| c.is_ascii_alphanumeric())
                    .collect();
                // `raven-${face}` 처럼 값이 실행 중에 정해지는 자리는 여기서
                // 못 본다. 그 목록은 아래 시험이 따로 대조한다.
                if name.is_empty() {
                    continue;
                }
                checked += 1;
                assert!(
                    FACES.iter().any(|(k, _)| *k == name),
                    "{who} 가 raven-{name} 을 부르는데 그런 그림이 없다"
                );
            }
        }
        assert!(checked > 0, "화면에서 캐릭터를 하나도 못 찾았다 — 시험이 헛돈다");
    }

    /// 손님 화면은 상태에 따라 이름을 조립한다(`/raven-${face}.webp`). 상태
    /// 표에 적힌 표정이 없으면 **그 상태에 도달한 손님만** 빈 자리를 본다.
    #[test]
    fn every_face_in_the_state_table_exists() {
        let src = include_str!("../../web/customer.html");
        let table = &src[src.find("const STATE_KO").expect("상태 표가 없다")..];
        let table: String = table.chars().take(600).collect();
        let mut found = 0;
        for line in table.lines() {
            // ["제목", "설명", "표정"] 의 마지막 따옴표 값.
            let quoted: Vec<&str> = line.split('"').collect();
            if quoted.len() >= 7 {
                let face = quoted[5];
                found += 1;
                assert!(
                    FACES.iter().any(|(k, _)| *k == face),
                    "상태 표가 raven-{face} 를 쓰는데 그런 그림이 없다"
                );
            }
        }
        assert!(found >= 4, "상태 표에서 표정을 {found}개밖에 못 읽었다");
    }

    /// 그림이 실제로 들어 있는지. include_bytes! 는 빈 파일도 조용히 굽는다.
    #[test]
    fn the_pictures_are_real_webp_and_small_enough() {
        for (name, bytes) in FACES {
            assert!(
                bytes.starts_with(b"RIFF") && bytes[8..12] == *b"WEBP",
                "raven-{name} 이 webp 가 아니다"
            );
            // 가게 와이파이. png 로 263KB 짜리를 다시 넣는 사고를 막는다.
            assert!(
                bytes.len() < 60_000,
                "raven-{name} 이 {}KB 다 — 손님 폰에 너무 무겁다",
                bytes.len() / 1024
            );
        }
    }
}

#[cfg(test)]
mod ticket_tests {
    /// 🔴 번호가 999 에서 1 로 돌아가면 **같은 날 1번이 두 명**이 된다.
    /// 하루 999잔을 넘기는 가게는 실제로 있다(마트·구내식당·축제).
    /// 부르기 불편한 네 자리가 같은 번호 두 명보다 낫다.
    ///
    /// ⚠️ 시험 코드 자체에 찾는 문자열이 들어 있으면 **언제나 실패한다.**
    /// 그래서 시험 모듈 앞부분만 본다 — 처음에 이걸 안 해서 두 개가 빨갛게 났다.
    fn code_only() -> &'static str {
        let src = include_str!("server.rs");
        &src[..src.find("mod ticket_tests").unwrap_or(src.len())]
    }

    #[test]
    fn the_number_does_not_wrap_at_999() {
        let src = code_only();
        assert!(
            !src.contains("t >= 999"),
            "999 에서 1 로 돌아간다 — 같은 날 같은 번호가 두 명 생긴다",
        );
        // 상한은 이제 사장이 정한다(shop::ticket_cap, 기본 9,999).
        // 코드에 박힌 숫자가 아니라 설정을 쓰는지 본다.
        assert!(
            src.contains("ticket_cap()"),
            "상한이 코드에 박혀 있다 — 하루 만 잔을 파는 가게가 못 쓴다",
        );
    }

    /// 🔴 날이 바뀌어도 안 돌아가면, 오늘 첫 손님이 "501번" 을 듣는다.
    /// 가게에서 부르는 번호는 그날 몇 번째인지를 뜻한다.
    #[test]
    fn the_number_starts_at_one_each_day() {
        let src = code_only();
        let f = &src[src.find("fn next_ticket").expect("next_ticket 이 없다")..];
        let body: String = f.chars().take(700).collect();
        assert!(body.contains("ticket_day"), "날짜를 안 본다");
        assert!(body.contains("*n = 1"), "날이 바뀌어도 1 로 안 돌아간다");
        // 가게 시계를 쓴다. UTC 로 자르면 한국은 아침 9시에 번호가 리셋된다.
        assert!(
            body.contains("local_tz_offset_min"),
            "UTC 로 날을 자르면 한국은 아침 9시에 번호가 바뀐다",
        );
    }

    /// 같은 코드가 세 곳에 복사돼 있었다. 한 곳만 고치면 나머지가 남는다.
    #[test]
    fn there_is_only_one_place_that_hands_out_numbers() {
        let src = code_only();
        assert_eq!(
            src.matches("next_ticket.lock()").count(),
            1,
            "번호를 나눠 주는 자리가 둘 이상이다",
        );
    }
}

#[cfg(test)]
mod grok_findings {
    /// 시험 코드 자체에 찾는 문자열이 있으면 언제나 실패한다.
    fn code_only() -> &'static str {
        let src = include_str!("server.rs");
        &src[..src.find("mod grok_findings").unwrap_or(src.len())]
    }

    /// 🔴 손님 폰이 보낸 금액을 그대로 믿으면, 커피 열 잔을 1원에 판다.
    /// 손님 폰의 자바스크립트는 손님이 고칠 수 있다 — 화면에서 막는 것은
    /// 막는 것이 아니다.
    #[test]
    fn the_order_total_is_recomputed_from_the_menu() {
        let src = code_only();
        let f = &src[src.find("\nasync fn api_order(").expect("api_order 가 없다")..];
        let head: String = f.chars().take(2200).collect();
        assert!(
            head.contains("price_of"),
            "손님이 보낸 total 을 그대로 쓴다 — 열 잔을 1원에 살 수 있다",
        );
    }

    /// 🔴 살아 있는 주문의 기대 금액을 지우면, 그 뒤로 **얼마가 들어와도**
    /// 결제 확인이 된다(`want = 0`). 하루 500건 넘는 가게가 오후 내내 그렇다.
    #[test]
    fn the_expected_amounts_of_live_orders_are_never_wiped() {
        let src = code_only();
        assert!(
            !src.contains("e.clear()"),
            "기대 금액 표를 통째로 지운다 — 살아 있는 주문까지 사라진다",
        );
    }

    /// 🔴 직원 폰을 끊었는데 앱을 다시 켜면 되살아나면, 끊은 것이 아니다.
    #[test]
    fn rotating_a_role_token_is_written_to_disk() {
        let src = code_only();
        let f = &src[src.find("pub fn rotate_role_token").expect("없다")..];
        let body: String = f.chars().take(700).collect();
        assert!(body.contains("save_tokens"), "회전이 저장되지 않는다 — 재시작하면 옛 토큰이 산다");
    }

    /// 🔴 화면은 "5분 안에 보내세요" 라고 하는데 확인 쪽이 그걸 안 보면,
    /// 만료된 QR 로 옛 금액을 보내도 결제가 된다.
    #[test]
    fn an_expired_quote_is_not_auto_confirmed() {
        let src = code_only();
        let f = &src[src.find("async fn sweep_payments").expect("없다")..];
        let body: String = f.chars().take(3000).collect();
        assert!(body.contains("order_until"), "만료를 보지 않는다");
        assert!(body.contains("EXPIRED"), "만료 상태가 없다");
    }
}

#[cfg(test)]
mod theme_tests {
    /// 🔴 어두운 테마 블록의 `}` **뒤에** 변수를 넣으면, 그 변수는 미디어
    /// 쿼리 밖으로 새어 나가 어두운 모드에서도 밝은 값으로 남는다.
    /// 실제로 일곱 화면이 전부 그랬다 — 어두운 배경에 밝은 주황이 얹혔다.
    ///
    /// CSS 는 문법이 틀려도 조용히 무시하고 넘어간다. 컴파일러가 없으므로
    /// 이런 것은 시험이 지킬 수밖에 없다.
    #[test]
    fn dark_theme_variables_stay_inside_the_media_query() {
        for (name, src) in [
            ("customer.html", include_str!("../../web/customer.html")),
            ("admin.html", include_str!("../../web/admin.html")),
            ("staff.html", include_str!("../../web/staff.html")),
            ("wallet.html", include_str!("../../web/wallet.html")),
            ("shops.html", include_str!("../../web/shops.html")),
            ("buy.html", include_str!("../../web/buy.html")),
            ("scan.html", include_str!("../../web/scan.html")),
            ("index.html", include_str!("../../index.html")),
        ] {
            assert!(
                !src.contains("} --ravi"),
                "{name}: 어두운 테마 블록을 닫은 뒤에 변수를 넣었다 — 밖으로 샌다",
            );
            // 어두운 모드에도 Ravi 색이 있어야 한다. 없으면 밝은 값이 그대로
            // 쓰여 같은 사고가 난다.
            if src.contains("prefers-color-scheme: dark") && src.contains("--ravi:") {
                let dark = &src[src.find("prefers-color-scheme: dark").unwrap()..];
                let block: String = dark.chars().take(400).collect();
                assert!(
                    block.contains("--ravi:"),
                    "{name}: 어두운 모드에 Ravi 색이 없다",
                );
            }
        }
    }
}
