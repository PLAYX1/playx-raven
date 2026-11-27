//! 오락실 「아무 RVN 지갑으로 한 판」 — 판매자 데스크탑이 한 판마다 **새 받는 주소(청구서)** 를 낸다. (2026-11-28)
//!
//! 여태 한 판 결제는 손님의 레이븐볼트 지갑만 할 수 있었다(한 거래에 판매자 99% + 수수료 1% · arcade.rs `arcade_pay`).
//! 판매자 쪽은 돈을 보지 않았다. 이제 어떤 RVN 지갑이든 QR 하나(`raven:<주소>?amount=<값>`)로 낼 수 있게,
//! 판매자 게이트웨이(arcade_gw — 바깥에 이미 열린 그 문)에 길 둘을 더한다:
//!
//! - `POST /arcade/invoice {cid}` — **이 컴퓨터가 지금 내주는 내 게임 문서**(arcade_gw::price_of)만. 값은 내가 서명해 올린 문서의
//!   priceSats 에서만 온다(요청이 값을 정하지 못한다). 새 주소 `getnewaddress "arcade:<cid>"`(지갑이 잠겨 있어도 된다) · 15분.
//! - `GET /arcade/invoice/<주소>` — pending · paid · short · expired. 「지금 내줘도 되는 돈」은 가게 주문과 같은 규칙(shop::accept_now).
//!   15분이 지난 뒤 들어온 돈도 버리지 않는다 — paid(늦게)로 적고 매출에도 적는다.
//!
//! 🔴 수수료 1% 는 **판마다 그 자리에서 따로 한 거래로** 보낸다(대표 11-28 「그때그때 보내야 보람이 있지」).
//!    지갑을 쓸 수 있을 때만 — 암호 없는 지갑 · 지금 풀려 있음 · 자동 판매가 이번 실행 동안 암호를 들고 있음(auto.rs, 30초만 연다).
//!    못 쓰면 개발비 장부(devfee)에 적고, 장부의 자동 송금이 오락실 몫이 밀린 동안 15초마다 보다가 쓸 수 있게 되는 그 순간 보낸다.
//!    잠금을 풀라고 조르지 않는다. 손님 거래에 이미 우리 주소 출력이 있으면(fee_in_tx 와 같은 판정) 아무것도 보내지 않는다.
//!    같은 판에 두 번 나가지 않게: devfee 송금 깃발(PayGuard) + 지급 기록(payout_guard, 청구서마다) + 청구서의 `fee` 표시.
//!
//! 🔴 우리가 돈을 들고 있지 않는다: 손님 돈은 **판매자 자신의 지갑 주소**로 곧바로 들어온다(noncustody.rs 의 선).
//! 사이트(release-site)는 이 답을 믿지 않는다 — 두 체인 출처로 그 주소가 값 이상 받았는지 따로 본 뒤에만 한 판을 넣는다.
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

/// 청구서가 열려 있는 시간.
pub const INVOICE_SECS: i64 = 15 * 60;
/// 블록이 늦게 잡히는 것까지 만료로 치지 않는다(가게 주문 sweep 과 같은 2분).
pub const LATE_GRACE_SECS: i64 = 120;
/// 만료된 청구서도 이만큼은 계속 본다(늦게 온 돈을 놓치지 않게).
pub const WATCH_SECS: i64 = 7 * 24 * 3600;
/// 한 손님(열쇠)이 동시에 열어 둘 수 있는 안 낸 청구서.
pub const MAX_OPEN_PER_KEY: usize = 3;
/// 이 컴퓨터 전체가 한 시간에 새로 내는 청구서.
pub const MAX_NEW_PER_HOUR: usize = 60;
/// 파일에 남기는 청구서 수 상한(오래된 끝난 것부터 버린다).
const KEEP_MAX: usize = 2000;
const FILE: &str = "arcade-invoices.json";
/// 지급 기록 칸 이름(payout_guard — 글자·숫자·`-` 만).
const LANE: &str = "arcadefee";
/// 같은 것을 짧게 여러 번 묻지 않는다(손님 화면이 몇 초마다 묻는다).
const SWEEP_GAP_SECS: i64 = 4;

fn now() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum Status { Pending, Paid, Short, Expired }
impl Status {
    fn as_str(self) -> &'static str {
        match self { Status::Pending => "pending", Status::Paid => "paid", Status::Short => "short", Status::Expired => "expired" }
    }
}

/// 수수료 1% 를 어떻게 했나. `None` = 아직(낸 뒤 다음 바퀴가 다시 본다).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub(crate) enum FeeMark {
    #[default]
    None,
    /// 그 자리에서 우리 주소로 따로 보냈다(fee_txid).
    Sent,
    /// 손님 거래 안에 이미 우리 몫 출력이 있었다 — 보낼 것이 없다.
    OnChain,
    /// 지갑을 쓸 수 없어 개발비 장부에 적었다 — 장부의 자동 송금이 보낸다.
    Ledger,
    /// 보냈는지 모른다(노드가 답하다 끊겼다) — 지급 기록이 남아 있어 다시 보내지 않는다. 사람이 볼 일.
    Unsure,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub(crate) struct Invoice {
    pub addr: String,
    pub cid: String,
    /// 한 판 값(atoms) — 내 서명 문서의 priceSats.
    pub price: u64,
    #[serde(default)]
    pub title: String,
    /// 한도용 손님 열쇠(사이트가 준 짧은 표 또는 바깥 IP). 화면에 내지 않는다.
    #[serde(default)]
    pub key: String,
    pub created: i64,
    pub until: i64,
    pub status: Status,
    #[serde(default)]
    pub txid: Option<String>,
    #[serde(default)]
    pub received: u64,
    #[serde(default)]
    pub confirmations: i64,
    #[serde(default)]
    pub paid_at: Option<i64>,
    /// 15분(+2분)이 지난 뒤 들어온 돈으로 낸 판.
    #[serde(default)]
    pub late: bool,
    #[serde(default)]
    pub fee: FeeMark,
    #[serde(default)]
    pub fee_txid: Option<String>,
    /// 매출장부(ledger)에 적었나.
    #[serde(default)]
    pub recorded: bool,
}

/// 이 주소로 들어온 돈 한 건(listtransactions 의 receive 한 줄).
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Rx {
    pub txid: String,
    pub atoms: u64,
    pub confirmations: i64,
    /// shop::accept_now — 지금 내줘도 되는 돈인가.
    pub accept_now: bool,
}

/* ── 순수 규칙(시험이 본다) ─────────────────────────────────────────── */

#[derive(Debug, PartialEq)]
pub(crate) enum Create {
    /// 같은 손님·같은 게임의 열린 안 낸 청구서를 다시 준다.
    Reuse(Invoice),
    New,
    /// 이 손님이 이미 3장을 열어 두었다.
    TooManyForKey,
    /// 이 컴퓨터가 한 시간에 낼 수 있는 60장을 다 냈다.
    HourFull,
}

/// 열린 안 낸 청구서 — 아직 15분 안이고 돈이 한 푼도 안 왔다.
fn open_unpaid(i: &Invoice, now: i64) -> bool {
    i.status == Status::Pending && i.received == 0 && now < i.until
}

pub(crate) fn decide_create(list: &[Invoice], key: &str, cid: &str, now: i64) -> Create {
    if let Some(i) = list.iter().filter(|i| i.key == key && i.cid == cid && open_unpaid(i, now)).max_by_key(|i| i.created) {
        return Create::Reuse(i.clone());
    }
    if list.iter().filter(|i| i.key == key && open_unpaid(i, now)).count() >= MAX_OPEN_PER_KEY {
        return Create::TooManyForKey;
    }
    if list.iter().filter(|i| now - i.created < 3600).count() >= MAX_NEW_PER_HOUR {
        return Create::HourFull;
    }
    Create::New
}

/// 들어온 돈으로 상태를 고친다. 바뀌었으면 true. 낸 판(paid)은 끝 — 다시 바뀌지 않는다.
pub(crate) fn apply(inv: &mut Invoice, rx: &[Rx], now: i64) -> bool {
    if inv.status == Status::Paid {
        // 확인 수만 따라간다(사이트가 「몇 번 확인」을 보인다).
        let conf = inv.txid.as_ref().and_then(|t| rx.iter().find(|r| &r.txid == t)).map(|r| r.confirmations);
        if let Some(c) = conf { if c != inv.confirmations { inv.confirmations = c; return true; } }
        return false;
    }
    let before = (inv.status, inv.received, inv.confirmations, inv.txid.clone());
    let ok: Vec<&Rx> = rx.iter().filter(|r| r.accept_now).collect();
    let ok_sum: u64 = ok.iter().map(|r| r.atoms).fold(0u64, u64::saturating_add);
    let any_sum: u64 = rx.iter().map(|r| r.atoms).fold(0u64, u64::saturating_add);
    inv.received = any_sum;
    if ok_sum >= inv.price && inv.price > 0 {
        // 여러 번 나눠 냈으면 가장 큰 거래를 표로 둔다(사이트는 표가 아니라 주소가 받은 합으로 다시 본다).
        let last = ok.iter().max_by_key(|r| (r.atoms, r.txid.clone())).map(|r| r.txid.clone());
        inv.status = Status::Paid;
        inv.txid = last;
        inv.confirmations = ok.iter().map(|r| r.confirmations).min().unwrap_or(0);
        inv.paid_at = Some(now);
        inv.late = now > inv.until + LATE_GRACE_SECS;
    } else if ok_sum > 0 {
        // 왔는데 모자란다 — 말해 준다(만료 뒤에도 「모자람」이 더 쓸모 있는 말이다).
        inv.status = Status::Short;
        inv.confirmations = ok.iter().map(|r| r.confirmations).min().unwrap_or(0);
    } else if now > inv.until + LATE_GRACE_SECS {
        inv.status = Status::Expired;
    } else {
        inv.status = Status::Pending;
    }
    before != (inv.status, inv.received, inv.confirmations, inv.txid.clone())
}

/// 지갑 receive 줄들 → 이 주소의 돈. 금액은 atoms 로(8자리 반올림).
pub(crate) fn receipts_for(txs: &[Value], addr: &str, online: bool, small_rvn: f64) -> Vec<Rx> {
    let mut out: Vec<Rx> = Vec::new();
    for tx in txs {
        if tx.get("category").and_then(Value::as_str) != Some("receive") || tx.get("address").and_then(Value::as_str) != Some(addr) {
            continue;
        }
        // 자산 이동(transfer)은 RVN 값이 아니다.
        if tx.get("asset_name").and_then(Value::as_str).is_some_and(|a| !a.is_empty() && a != "RVN") {
            continue;
        }
        let Some(txid) = tx.get("txid").and_then(Value::as_str).filter(|t| t.len() == 64 && t.bytes().all(|b| b.is_ascii_hexdigit())) else { continue };
        let rvn = tx.get("amount").and_then(Value::as_f64).unwrap_or(0.0).abs();
        if !rvn.is_finite() || rvn <= 0.0 { continue; }
        let atoms = (rvn * 1e8).round() as u64;
        let confirmations = tx.get("confirmations").and_then(Value::as_i64).unwrap_or(0);
        // 이 지갑이 보기에 같은 돈을 쓴 다른 거래가 있나 — 0회 확인 판단의 유일한 실제 근거(shop.rs 설명).
        let conflicts = tx.get("walletconflicts").and_then(Value::as_array).map(|a| a.len()).unwrap_or(0);
        // 확인 수가 음수 = 갈라진 사슬에서 밀려난 거래. 돈으로 치지 않는다.
        if confirmations < 0 { continue; }
        let accept_now = crate::shop::accept_now(confirmations, conflicts, online, rvn, small_rvn);
        // 같은 거래가 두 줄로 오면(같은 주소로 출력 둘) 합친다.
        if let Some(r) = out.iter_mut().find(|r| r.txid == txid) {
            r.atoms = r.atoms.saturating_add(atoms);
            r.accept_now &= accept_now;
            continue;
        }
        out.push(Rx { txid: txid.to_string(), atoms, confirmations, accept_now });
    }
    out
}

/// 수수료를 어떻게 할까(낸 판 하나). 이미 손을 댔으면 None.
#[derive(Debug, PartialEq)]
pub(crate) enum FeeStep { OnChain, Send, Ledger }
pub(crate) fn fee_step(mark: FeeMark, already_in_tx: Option<bool>, spendable: bool) -> Option<FeeStep> {
    if mark != FeeMark::None {
        return None;
    }
    if already_in_tx == Some(true) {
        return Some(FeeStep::OnChain);
    }
    Some(if spendable { FeeStep::Send } else { FeeStep::Ledger })
}

/// 한 판 값 → 우리 몫(atoms) — 손님 지갑 결제와 같은 나누기(arcade::split_price: 1% 올림 · 먼지 한계 1000).
pub(crate) fn fee_atoms(price: u64) -> Option<u64> {
    crate::arcade::split_price(price).ok().map(|(_, fee)| fee)
}

/// 화면(사이트)에 주는 모양 — 손님 열쇠는 내지 않는다.
pub(crate) fn public_view(i: &Invoice) -> Value {
    let rvn = crate::arcade::atoms_json(i.price);
    let amount = rvn.as_str().unwrap_or("0").to_string();
    json!({
        "addr": i.addr,
        "amount": amount,
        "amountAtoms": i.price,
        "uri": format!("raven:{}?amount={}", i.addr, amount),
        "until": i.until,
        "cid": i.cid,
    })
}
pub(crate) fn status_view(i: &Invoice) -> Value {
    let mut v = json!({ "status": i.status.as_str(), "confirmations": i.confirmations, "until": i.until, "amountAtoms": i.price, "receivedAtoms": i.received });
    if let Some(t) = &i.txid { if i.status == Status::Paid { v["txid"] = json!(t); } }
    if i.late { v["late"] = json!(true); }
    v
}

/// 한도용 손님 열쇠. 사이트가 주는 `x-rv-client`(16진 16~64자 — 사이트가 손님 IP 를 섞어 만든 표)를 먼저,
/// 없으면 바깥 IP(cf-connecting-ip → x-forwarded-for 첫 칸), 그것도 없으면 "lan".
/// 🔴 누구나 이 머리를 지어낼 수 있다 — 그래서 한 시간 60장 상한은 열쇠와 상관없이 컴퓨터 전체에 건다.
pub(crate) fn client_key(headers: &axum::http::HeaderMap) -> String {
    let get = |k: &str| headers.get(k).and_then(|v| v.to_str().ok()).map(str::trim).filter(|v| !v.is_empty());
    if let Some(c) = get("x-rv-client").filter(|c| (16..=64).contains(&c.len()) && c.bytes().all(|b| b.is_ascii_hexdigit())) {
        return format!("rv:{}", c.to_ascii_lowercase());
    }
    let ip = get("cf-connecting-ip").or_else(|| get("x-forwarded-for").and_then(|x| x.split(',').next()).map(str::trim));
    match ip.and_then(|s| s.parse::<std::net::IpAddr>().ok()) {
        Some(ip) => format!("ip:{ip}"),
        None => "lan".into(),
    }
}

/* ── 저장 ───────────────────────────────────────────────────────────── */

static STORE: Mutex<Option<Vec<Invoice>>> = Mutex::new(None);

fn file() -> std::path::PathBuf {
    crate::paths::app_file(FILE)
}
fn load_disk() -> Vec<Invoice> {
    std::fs::read(file()).ok().and_then(|b| serde_json::from_slice::<Vec<Invoice>>(&b).ok()).unwrap_or_default()
}
/// 끝난 것(낸 판·만료 뒤 7일)과 오래된 것을 줄인다. 아직 수수료·장부 일이 남은 낸 판은 남긴다.
fn trim(list: &mut Vec<Invoice>, now: i64) {
    list.retain(|i| {
        let done = i.status == Status::Paid && i.fee != FeeMark::None && i.recorded;
        let age = now - i.created;
        if i.status == Status::Paid { !(done && age > 30 * 24 * 3600) } else { age <= WATCH_SECS }
    });
    if list.len() > KEEP_MAX {
        list.sort_by_key(|i| i.created);
        let cut = list.len() - KEEP_MAX;
        list.drain(0..cut);
    }
}
fn with_store<T>(f: impl FnOnce(&mut Vec<Invoice>) -> T) -> T {
    let mut g = STORE.lock().unwrap_or_else(|e| e.into_inner());
    let list = g.get_or_insert_with(load_disk);
    f(list)
}
fn save() {
    let snapshot = with_store(|l| { trim(l, now()); l.clone() });
    match serde_json::to_vec(&snapshot) {
        Ok(bytes) => { if crate::payout_guard::atomic_write(&file(), &bytes).is_err() { eprintln!("오락실 청구서 저장 실패"); } }
        Err(_) => eprintln!("오락실 청구서 형식 오류"),
    }
}
#[cfg(test)]
fn reset_for_test() {
    *STORE.lock().unwrap_or_else(|e| e.into_inner()) = Some(Vec::new());
}

/* ── 길 둘 ──────────────────────────────────────────────────────────── */

/// 한 번에 하나만 새 주소를 만든다(같은 손님의 두 요청이 동시에 와서 두 장이 나지 않게).
static CREATING: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// `POST /arcade/invoice {cid}` 의 몸통. 실패는 (상태 번호, 까닭 글자).
pub(crate) async fn create(cid: &str, key: &str) -> Result<Value, (u16, &'static str)> {
    if !crate::arcade::cid_ok(cid) {
        return Err((400, "bad-cid"));
    }
    // 이 컴퓨터가 지금 내주는 내 게임 문서만 · 값은 그 문서의 priceSats 에서만.
    let Some((price, title)) = crate::arcade_gw::price_of(cid) else { return Err((404, "not-served")) };
    if price == 0 {
        return Err((409, "free"));
    }
    if fee_atoms(price).is_none() {
        return Err((409, "bad-price"));
    }
    let _one = CREATING.lock().await;
    let t = now();
    match with_store(|l| decide_create(l, key, cid, t)) {
        Create::Reuse(i) => return Ok(public_view(&i)),
        Create::TooManyForKey => return Err((429, "too-many-open")),
        Create::HourFull => return Err((429, "busy")),
        Create::New => {}
    }
    // 주문과 같은 길(raven::new_address) — 지갑이 잠겨 있어도 미리 만든 열쇠 묶음에서 나온다.
    let label = format!("arcade:{cid}");
    let addr = crate::raven::new_address(label).await.map_err(|_| (503, "node"))?;
    if !crate::devfee::looks_like_address(&addr) {
        return Err((503, "node"));
    }
    let inv = Invoice {
        addr, cid: cid.to_string(), price, title, key: key.to_string(), created: t, until: t + INVOICE_SECS,
        status: Status::Pending, txid: None, received: 0, confirmations: 0, paid_at: None, late: false,
        fee: FeeMark::None, fee_txid: None, recorded: false,
    };
    let view = public_view(&inv);
    with_store(|l| l.push(inv));
    save();
    start();
    Ok(view)
}

/// `GET /arcade/invoice/<주소>` 의 몸통.
pub(crate) async fn status(addr: &str) -> Result<Value, (u16, &'static str)> {
    if !crate::devfee::looks_like_address(addr) {
        return Err((400, "bad-address"));
    }
    if with_store(|l| l.iter().all(|i| i.addr != addr)) {
        return Err((404, "unknown"));
    }
    sweep().await;
    with_store(|l| l.iter().find(|i| i.addr == addr).map(status_view)).ok_or((404, "unknown"))
}

/* ── 돈 보기 · 수수료 · 장부 ────────────────────────────────────────── */

static SWEEPING: AtomicBool = AtomicBool::new(false);
static LAST_SWEEP: Mutex<i64> = Mutex::new(0);

/// 아직 볼 것이 있나(안 낸 청구서 · 수수료·장부 일이 남은 낸 판).
fn has_work(list: &[Invoice]) -> bool {
    list.iter().any(|i| i.status != Status::Paid || i.fee == FeeMark::None || !i.recorded)
}

pub(crate) async fn sweep() {
    {
        let mut last = LAST_SWEEP.lock().unwrap_or_else(|e| e.into_inner());
        let t = now();
        if t - *last < SWEEP_GAP_SECS { return; }
        *last = t;
    }
    if SWEEPING.swap(true, Ordering::AcqRel) { return; }
    struct Done;
    impl Drop for Done { fn drop(&mut self) { SWEEPING.store(false, Ordering::Release); } }
    let _done = Done;

    if !with_store(|l| has_work(l)) { return; }
    // 지갑의 최근 거래(손님 판·가게 주문이 섞여도 주소로 가른다). 못 읽으면 다음 바퀴.
    let Ok(txs) = crate::raven::call_rpc("listtransactions", json!(["*", 500, 0, true])).await else { return };
    let txs = txs.as_array().cloned().unwrap_or_default();
    let (online, small_rvn) = crate::shop::accept_context().await;
    let t = now();
    let changed = with_store(|l| {
        let mut changed = false;
        for inv in l.iter_mut() {
            let rx = receipts_for(&txs, &inv.addr, online, small_rvn);
            changed |= apply(inv, &rx, t);
        }
        changed
    });
    if changed { save(); }

    // 낸 판의 남은 일 — 수수료 · 매출장부. 자물쇠 밖에서(노드를 기다린다).
    let work: Vec<Invoice> = with_store(|l| l.iter().filter(|i| i.status == Status::Paid && (i.fee == FeeMark::None || !i.recorded)).cloned().collect());
    for inv in work {
        if inv.fee == FeeMark::None {
            if let Some((mark, fee_txid)) = settle_fee(&inv).await {
                with_store(|l| if let Some(i) = l.iter_mut().find(|i| i.addr == inv.addr) { i.fee = mark; i.fee_txid = fee_txid; });
                save();
            }
        }
        if !inv.recorded {
            if record_sale(&inv).await {
                with_store(|l| if let Some(i) = l.iter_mut().find(|i| i.addr == inv.addr) { i.recorded = true; });
                save();
            }
        }
    }
}

/// 손님 거래에 이미 우리 몫 출력이 있나 — 지갑 거래 hex 를 풀어 본다(txindex 가 없어도 된다). 못 읽으면 None.
async fn fee_already_in_tx(txid: &str, fee_rvn: f64) -> Option<bool> {
    let tx = crate::raven::call_rpc("gettransaction", json!([txid, true])).await.ok()?;
    let hex = tx.get("hex")?.as_str()?.to_string();
    let decoded = crate::raven::call_rpc("decoderawtransaction", json!([hex])).await.ok()?;
    let vouts = decoded.get("vout")?.as_array()?;
    Some(crate::devfee::tx_pays_us(vouts, fee_rvn, crate::arcade::ARCADE_FEE_ADDRESS))
}

/// 지금 지갑으로 보낼 수 있나 — 암호 없음 · 지금 풀려 있음 · 자동 판매가 암호를 들고 있음.
async fn spendable_now() -> bool {
    let unlocked = crate::raven::wallet_lock_state().await.ok().and_then(|v| v["unlocked"].as_bool()).unwrap_or(false);
    unlocked || crate::auto::armed_pass().is_some()
}

/// 한 판 수수료. 손을 댔으면 (표시, 보낸 거래). 다음 바퀴로 미루면 None.
async fn settle_fee(inv: &Invoice) -> Option<(FeeMark, Option<String>)> {
    let fee = fee_atoms(inv.price)?;
    let fee_rvn = fee as f64 / 1e8;
    let order = format!("arcade:{}", inv.addr);
    let in_tx = match inv.txid.as_deref() {
        // 노드가 못 답하면 — 손님은 값 전체를 이 주소로 냈다(그래서 paid) → 우리 몫은 아직 안 나간 것으로 본다.
        Some(t) => fee_already_in_tx(t, fee_rvn).await.or(Some(false)),
        None => Some(false),
    };
    let spendable = spendable_now().await;
    match fee_step(inv.fee, in_tx, spendable)? {
        FeeStep::OnChain => Some((FeeMark::OnChain, None)),
        FeeStep::Ledger => {
            crate::devfee::accrue(&order, fee_rvn).await;
            Some((FeeMark::Ledger, None))
        }
        FeeStep::Send => send_fee(&inv.addr, fee, &order).await,
    }
}

/// 우리 몫을 따로 한 거래로. 🔴 같은 판에 두 번 나가지 않게 — 송금 깃발 + 청구서마다 지급 기록.
async fn send_fee(addr: &str, fee: u64, order: &str) -> Option<(FeeMark, Option<String>)> {
    let fee_rvn = fee as f64 / 1e8;
    // 개발비 「보내기」·자동 송금과 겹치지 않게. 이미 보내는 중이면 다음 바퀴(15초 뒤).
    let _pay = crate::devfee::PayGuard::take()?;
    let intent = serde_json::to_vec(&json!(["arcade-fee", addr, crate::arcade::ARCADE_FEE_ADDRESS, fee])).ok()?;
    let id: String = addr.chars().filter(|c| c.is_ascii_alphanumeric()).collect();
    let guard = match crate::payout_guard::begin(&crate::paths::app_file("payouts"), LANE, &id, &intent) {
        Ok(crate::payout_guard::Begin::Done(txid)) => return Some((FeeMark::Sent, Some(txid))),
        Ok(crate::payout_guard::Begin::New(g)) => g,
        // 앞선 송금이 「보냈는지 모름」으로 남아 칸이 막혔다 — 장부에 적어 두고(사람이 보고 푼다) 판마다 쌓이지 않게 여기서 끝.
        Err(_) => {
            crate::devfee::accrue(order, fee_rvn).await;
            return Some((FeeMark::Ledger, None));
        }
    };
    let amount = crate::arcade::atoms_json(fee);
    let sent = crate::send::with_unlocked(crate::auto::armed_pass(), || async {
        Ok::<_, String>(crate::raven::call_rpc_detailed("sendtoaddress", json!([crate::arcade::ARCADE_FEE_ADDRESS, amount, "RavenVault 오락실 수수료", "", false])).await)
    }).await;
    let valid = |t: &str| t.len() == 64 && t.bytes().all(|b| b.is_ascii_hexdigit());
    match sent {
        Ok(Ok(v)) => match v.as_str().filter(|t| valid(t)) {
            Some(txid) => {
                let _ = guard.complete(txid);
                crate::refund::remember_ours(txid);
                crate::devfee::record_direct(order, fee_rvn, txid);
                Some((FeeMark::Sent, Some(txid.to_string())))
            }
            // 노드가 거래 번호를 안 줬다 — 나갔는지 모른다. 기록을 남긴 채(다시 안 보낸다) 사람이 본다.
            None => Some((FeeMark::Unsure, None)),
        },
        // 노드가 거절했다(코드가 있는 답) · 닿지도 못했다 — 안 나간 것이 확실하다. 장부로.
        Ok(Err(f)) if f.code.is_some() || !f.message.starts_with(crate::raven::SENT_UNKNOWN) => {
            let _ = guard.abandon_unsent();
            crate::devfee::accrue(order, fee_rvn).await;
            Some((FeeMark::Ledger, None))
        }
        Ok(Err(_)) => Some((FeeMark::Unsure, None)),
        // 잠금을 못 열었다(암호가 바뀜 등) — 보내기 전이다. 장부로.
        Err(_) => {
            let _ = guard.abandon_unsent();
            crate::devfee::accrue(order, fee_rvn).await;
            Some((FeeMark::Ledger, None))
        }
    }
}

/// 장부의 밀린 개발비를 지금 보낸다(devfee 자동 송금이 오락실 몫이 밀렸을 때 부른다).
/// 풀려 있으면 그대로, 잠겨 있으면 자동 판매가 들고 있는 암호로 30초만 연다 — 없으면 아무것도 안 한다.
pub(crate) async fn pay_owed_now() -> Result<Value, String> {
    crate::send::with_unlocked(crate::auto::armed_pass(), || crate::devfee::fee_pay_min(crate::devfee::ARCADE_MIN_RVN)).await
}

/// 매출장부에 한 줄(받은 그때의 시세와 함께). 적었으면 true.
async fn record_sale(inv: &Invoice) -> bool {
    let quote = crate::price::rvn_rate(crate::shop::currency()).await.unwrap_or(Value::Null);
    let rvn = inv.price as f64 / 1e8;
    crate::ledger::record_arcade_play(&inv.addr, inv.txid.as_deref().unwrap_or(""), &inv.cid, &inv.title, rvn, &quote,
        inv.paid_at.unwrap_or_else(now), inv.confirmations, inv.late).is_ok()
}

/* ── 뒤에서 도는 바퀴 ──────────────────────────────────────────────── */

static STARTED: AtomicBool = AtomicBool::new(false);

/// 볼 것이 있는 동안 15초마다(손님 화면이 안 물어도 — 화면을 닫고 나중에 낸 돈도 매출·수수료가 된다). 한 번만 켠다.
pub fn start() {
    if STARTED.swap(true, Ordering::AcqRel) { return; }
    tauri::async_runtime::spawn(async {
        loop {
            tokio::time::sleep(std::time::Duration::from_secs(15)).await;
            if with_store(|l| has_work(l)) { sweep().await; }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    const ADDR: &str = "RTestArcadeAddrX1111111111111111rP";
    fn inv(key: &str, cid: &str, created: i64) -> Invoice {
        Invoice { addr: format!("R{key}{cid}{created}"), cid: cid.into(), price: 100_000_000, title: "Run".into(), key: key.into(), created, until: created + INVOICE_SECS,
            status: Status::Pending, txid: None, received: 0, confirmations: 0, paid_at: None, late: false, fee: FeeMark::None, fee_txid: None, recorded: false }
    }
    fn rx(t: char, atoms: u64, conf: i64, ok: bool) -> Rx { Rx { txid: t.to_string().repeat(64), atoms, confirmations: conf, accept_now: ok } }

    #[test]
    fn 같은_손님_같은_게임은_열린_청구서를_다시_준다() {
        let l = vec![inv("k", "A", 1000)];
        assert!(matches!(decide_create(&l, "k", "A", 1100), Create::Reuse(i) if i.created == 1000));
        assert_eq!(decide_create(&l, "k", "B", 1100), Create::New, "다른 게임은 새로");
        assert_eq!(decide_create(&l, "j", "A", 1100), Create::New, "다른 손님은 새로");
        assert_eq!(decide_create(&l, "k", "A", 1000 + INVOICE_SECS), Create::New, "15분이 지났으면 새로");
        // 돈이 조금이라도 온 청구서는 다시 주지 않는다(모자람·낸 판).
        let mut part = inv("k", "A", 1000); part.received = 5; part.status = Status::Short;
        assert_eq!(decide_create(&[part], "k", "A", 1100), Create::New);
    }

    #[test]
    fn 한_손님은_열린_청구서_셋까지() {
        let l = vec![inv("k", "A", 1000), inv("k", "B", 1001), inv("k", "C", 1002)];
        assert_eq!(decide_create(&l, "k", "D", 1100), Create::TooManyForKey);
        assert!(matches!(decide_create(&l, "k", "B", 1100), Create::Reuse(_)), "열린 것을 다시 받는 것은 된다");
        assert_eq!(decide_create(&l, "j", "D", 1100), Create::New);
        // 하나가 만료되면 다시 낼 수 있다.
        assert_eq!(decide_create(&l, "k", "D", 1000 + INVOICE_SECS + 1), Create::New);
    }

    #[test]
    fn 컴퓨터_전체는_한_시간에_60장() {
        let l: Vec<Invoice> = (0..60).map(|n| inv(&format!("k{n}"), "A", 10_000 + n)).collect();
        assert_eq!(decide_create(&l, "new", "A", 10_100), Create::HourFull);
        assert_eq!(decide_create(&l, "new", "A", 10_000 + 3600), Create::New, "가장 오래된 것이 한 시간을 넘으면 풀린다");
        // 열쇠를 바꿔 가며 와도 같은 상한.
        assert_eq!(decide_create(&l, "k0", "B", 10_100), Create::HourFull);
    }

    #[test]
    fn 상태는_받은_돈으로_바뀐다() {
        let mut i = inv("k", "A", 1000);
        assert!(!apply(&mut i, &[], 1100));
        assert_eq!(i.status, Status::Pending);
        // 0회 확인인데 지금 내줄 수 없는 돈(충돌·끊김·고액) — 기다린다.
        assert!(apply(&mut i, &[rx('a', 100_000_000, 0, false)], 1100));
        assert_eq!((i.status, i.received), (Status::Pending, 100_000_000));
        // 모자람
        let mut s = inv("k", "A", 1000);
        apply(&mut s, &[rx('a', 40_000_000, 1, true)], 1100);
        assert_eq!(s.status, Status::Short);
        // 나눠 내서 채움 → paid · 표는 값을 채운 거래
        apply(&mut s, &[rx('a', 40_000_000, 2, true), rx('b', 60_000_000, 0, true)], 1200);
        assert_eq!(s.status, Status::Paid);
        assert_eq!(s.txid.as_deref(), Some("b".repeat(64).as_str()));
        assert_eq!((s.confirmations, s.paid_at, s.late), (0, Some(1200), false));
        // 낸 판은 끝 — 돈이 빠진 것처럼 보여도(목록에서 밀림) 되돌리지 않는다. 확인 수만 따라간다.
        assert!(!apply(&mut s, &[], 1300));
        assert_eq!(s.status, Status::Paid);
        assert!(apply(&mut s, &[rx('b', 60_000_000, 3, true)], 1300));
        assert_eq!((s.status, s.confirmations), (Status::Paid, 3));
    }

    #[test]
    fn 만료_뒤에_온_돈도_낸_판으로_늦게() {
        let mut i = inv("k", "A", 1000);
        let until = i.until;
        apply(&mut i, &[], until + LATE_GRACE_SECS);
        assert_eq!(i.status, Status::Pending, "2분 봐준다");
        apply(&mut i, &[], until + LATE_GRACE_SECS + 1);
        assert_eq!(i.status, Status::Expired);
        let t = i.until + 3600;
        apply(&mut i, &[rx('c', 100_000_000, 1, true)], t);
        assert_eq!((i.status, i.late, i.paid_at), (Status::Paid, true, Some(t)));
        assert_eq!(status_view(&i)["status"], "paid");
        assert_eq!(status_view(&i)["late"], true);
        assert_eq!(status_view(&i)["txid"], "c".repeat(64));
    }

    #[test]
    fn 지갑_줄에서_이_주소의_rvn_만() {
        let t = |c: char| c.to_string().repeat(64);
        let txs = vec![
            json!({ "category": "receive", "address": ADDR, "txid": t('a'), "amount": 0.5, "confirmations": 0 }),
            json!({ "category": "receive", "address": ADDR, "txid": t('a'), "amount": 0.25, "confirmations": 0 }),
            json!({ "category": "receive", "address": "Rother", "txid": t('b'), "amount": 9.0, "confirmations": 3 }),
            json!({ "category": "send", "address": ADDR, "txid": t('c'), "amount": -1.0, "confirmations": 3 }),
            json!({ "category": "receive", "address": ADDR, "txid": t('d'), "amount": 1.0, "asset_name": "RVLT/X", "confirmations": 3 }),
            json!({ "category": "receive", "address": ADDR, "txid": "zz", "amount": 1.0, "confirmations": 3 }),
            json!({ "category": "receive", "address": ADDR, "txid": t('e'), "amount": 1.0, "confirmations": 0, "walletconflicts": [t('f')] }),
            json!({ "category": "receive", "address": ADDR, "txid": t('g'), "amount": 1.0, "confirmations": -2 }),
        ];
        let got = receipts_for(&txs, ADDR, true, 10.0);
        assert_eq!(got, vec![
            Rx { txid: t('a'), atoms: 75_000_000, confirmations: 0, accept_now: true },
            Rx { txid: t('e'), atoms: 100_000_000, confirmations: 0, accept_now: false },
        ]);
        // 노드가 끊겼으면 0회 확인은 기다린다(가게 주문과 같은 규칙).
        assert!(!receipts_for(&txs, ADDR, false, 10.0)[0].accept_now);
    }

    #[test]
    fn 수수료는_한_번만_손님_거래에_있으면_보내지_않는다() {
        assert_eq!(fee_step(FeeMark::None, Some(true), true), Some(FeeStep::OnChain), "손님 거래에 이미 우리 몫");
        assert_eq!(fee_step(FeeMark::None, Some(false), true), Some(FeeStep::Send));
        assert_eq!(fee_step(FeeMark::None, None, true), Some(FeeStep::Send));
        assert_eq!(fee_step(FeeMark::None, Some(false), false), Some(FeeStep::Ledger), "지갑을 못 쓰면 장부로 — 조르지 않는다");
        for done in [FeeMark::Sent, FeeMark::OnChain, FeeMark::Ledger, FeeMark::Unsure] {
            assert_eq!(fee_step(done, Some(false), true), None, "{done:?} 다시 손대지 않는다");
        }
        assert_eq!(fee_atoms(100_000_000), Some(1_000_000));
        assert_eq!(fee_atoms(50_000), Some(1_000), "먼지 한계");
        assert_eq!(fee_atoms(1_500), None);
    }

    /// 손님 거래에 우리 주소 출력이 값 이상 있으면 「이미 낸 것」 — devfee 와 같은 판정을 쓴다.
    #[test]
    fn 손님_거래_안의_우리_몫_판정() {
        let vout = |v: f64, a: &str| json!({ "value": v, "scriptPubKey": { "addresses": [a] } });
        let fee = crate::arcade::ARCADE_FEE_ADDRESS;
        assert!(crate::devfee::tx_pays_us(&[vout(0.99, ADDR), vout(0.01, fee)], 0.01, fee));
        assert!(!crate::devfee::tx_pays_us(&[vout(1.0, ADDR)], 0.01, fee));
        assert!(!crate::devfee::tx_pays_us(&[vout(0.99, ADDR), vout(0.001, fee)], 0.01, fee));
    }

    /// 🔴 같은 판에 수수료가 두 번 나가지 않는다 — 지급 기록이 끝난 판은 「이미 보냄」으로 돌아오고, 다른 내용이면 막힌다.
    #[test]
    fn 지급_기록은_청구서마다_한_번() {
        let _g = crate::paths::TEST_ENV.lock().unwrap_or_else(|e| e.into_inner());
        let d = crate::paths::test_fixture_root().join("playx-arcade-invoice-guard-test");
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        let intent = serde_json::to_vec(&json!(["arcade-fee", ADDR, crate::arcade::ARCADE_FEE_ADDRESS, 1000])).unwrap();
        let txid = "a".repeat(64);
        match crate::payout_guard::begin(&d, LANE, ADDR, &intent).unwrap() {
            crate::payout_guard::Begin::New(g) => g.complete(&txid).unwrap(),
            crate::payout_guard::Begin::Done(_) => panic!("처음인데 이미 보냄"),
        }
        assert!(matches!(crate::payout_guard::begin(&d, LANE, ADDR, &intent).unwrap(), crate::payout_guard::Begin::Done(t) if t == txid));
        let other = serde_json::to_vec(&json!(["arcade-fee", ADDR, crate::arcade::ARCADE_FEE_ADDRESS, 2000])).unwrap();
        assert!(crate::payout_guard::begin(&d, LANE, ADDR, &other).is_err(), "같은 판에 다른 값은 막는다");
        // 보냈는지 모르는 채로 남은 기록이 있으면 다음 판도 새로 보내지 않는다(막힘 → 장부).
        let second = "RTestArcadeAddrX2222222222222222rP";
        let pending = match crate::payout_guard::begin(&d, LANE, second, &intent).unwrap() { crate::payout_guard::Begin::New(g) => g, _ => panic!() };
        assert!(crate::payout_guard::begin(&d, LANE, "RTestArcadeAddrX3333333333333333rP", &intent).is_err());
        pending.abandon_unsent().unwrap();
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn 손님_열쇠() {
        let mut h = axum::http::HeaderMap::new();
        assert_eq!(client_key(&h), "lan");
        h.insert("x-forwarded-for", "198.51.100.7, 10.0.0.1".parse().unwrap());
        assert_eq!(client_key(&h), "ip:198.51.100.7");
        h.insert("cf-connecting-ip", "203.0.113.9".parse().unwrap());
        assert_eq!(client_key(&h), "ip:203.0.113.9");
        h.insert("x-rv-client", "ABCDEF0123456789".parse().unwrap());
        assert_eq!(client_key(&h), "rv:abcdef0123456789", "사이트가 준 표가 먼저");
        h.insert("x-rv-client", "not-hex-but-long-enough".parse().unwrap());
        assert_eq!(client_key(&h), "ip:203.0.113.9", "모양이 틀린 표는 버린다");
    }

    #[test]
    fn 화면에는_손님_열쇠를_내지_않는다() {
        let mut i = inv("secret-key", "A", 1000);
        i.addr = ADDR.into();
        let v = public_view(&i);
        assert_eq!(v["uri"], format!("raven:{ADDR}?amount=1.00000000"));
        assert_eq!(v["amount"], "1.00000000");
        assert_eq!(v["until"], 1000 + INVOICE_SECS);
        assert!(!v.to_string().contains("secret-key") && !status_view(&i).to_string().contains("secret-key"));
        assert!(status_view(&i).get("txid").is_none(), "안 낸 판은 거래 번호가 없다");
    }

    #[test]
    fn 저장_줄이기는_일이_남은_낸_판을_지킨다() {
        let t = 100 * 24 * 3600;
        let mut old_paid_done = inv("k", "A", 0); old_paid_done.status = Status::Paid; old_paid_done.fee = FeeMark::Sent; old_paid_done.recorded = true;
        let mut old_paid_todo = inv("k", "B", 0); old_paid_todo.status = Status::Paid;
        let old_pending = inv("k", "C", 0);
        let fresh = inv("k", "D", t - 10);
        let mut l = vec![old_paid_done, old_paid_todo.clone(), old_pending, fresh.clone()];
        trim(&mut l, t);
        assert_eq!(l, vec![old_paid_todo, fresh]);
    }

    #[tokio::test]
    async fn 내주지_않는_게임이면_청구서가_없다() {
        let _g = crate::arcade_gw::SERVING_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        reset_for_test();
        crate::arcade_gw::set_serving_for_test(&[]);
        let cid = format!("Qm{}", "D".repeat(44));
        assert_eq!(create(&cid, "k").await.unwrap_err(), (404, "not-served"));
        assert_eq!(create("../x", "k").await.unwrap_err(), (400, "bad-cid"));
        crate::arcade_gw::set_serving_for_test(&[&cid]);
        crate::arcade_gw::set_price_for_test(&cid, 0, "Free");
        assert_eq!(create(&cid, "k").await.unwrap_err(), (409, "free"), "무료 게임은 청구서가 없다");
        crate::arcade_gw::set_price_for_test(&cid, 1_500, "Tiny");
        assert_eq!(create(&cid, "k").await.unwrap_err(), (409, "bad-price"));
        crate::arcade_gw::set_serving_for_test(&[]);
        assert_eq!(status("nope").await.unwrap_err(), (400, "bad-address"));
        assert_eq!(status(ADDR).await.unwrap_err(), (404, "unknown"));
    }

    /// 🔴 이 길은 손님 지갑 결제(arcade_pay)를 건드리지 않는다 — 판매자 지갑에서 나가는 것은 우리 몫 1% 하나뿐, 받는 곳은 코드 고정.
    #[test]
    fn 나가는_돈은_코드_고정_수수료_주소로만() {
        let src = include_str!("arcade_invoice.rs");
        let body = &src[..src.find("#[cfg(test)]\nmod tests").unwrap()];
        assert_eq!(body.matches("\"sendtoaddress\"").count(), 1);
        assert!(body.contains("json!([crate::arcade::ARCADE_FEE_ADDRESS, amount"));
        assert!(!body.contains("sendmany") && !body.contains("\"transfer\""));
        // 암호는 이 실행의 메모리(자동 판매 armed_pass)에서만 — 직접 잠금을 풀지 않고 send::with_unlocked 에 맡긴다.
        assert!(!body.contains(&format!("wallet{}", "passphrase")));
        assert!(body.contains("crate::auto::armed_pass()"));
    }
}
