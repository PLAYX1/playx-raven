//! Refunds, and watching for spends we did not make.
//!
//! ## A refund is a new payment, not an undo
//!
//! Nothing on a blockchain can be reversed. What a shop calls a refund is the
//! shop sending money back, which means it needs three things the original
//! payment did not require: the customer's address, the shop's own RVN, and a
//! decision by a person.
//!
//! The address is the hard part. A received transaction does not record who
//! sent it, so for a café order there is nobody to send it back to unless the
//! customer told us — which they only did if they bought an asset through the
//! sale page. For everything else the shop has to ask. The UI must say that
//! plainly instead of showing a refund button that fails.
//!
//! ## Watching
//!
//! We cannot stop a compromised machine from spending. The daily cap, the
//! confirmation floor, the one-fulfilment-per-address rule — all of that lives
//! inside our loop, and malware calling the node's RPC directly walks past every
//! one of them.
//!
//! What is left is noticing quickly. This records the txid of everything we
//! send, and anything else leaving the wallet is reported as a spend nobody
//! here asked for. It is not prevention and the UI does not call it security.

use crate::raven::call_rpc;
use serde_json::{json, Value};
use std::collections::HashSet;
use std::sync::Mutex;

/// Every txid this app created. Anything else that spends is not ours.
static OURS: Mutex<Option<HashSet<String>>> = Mutex::new(None);

/// Records a txid we produced, so the watcher does not flag our own work.
pub fn remember_ours(txid: &str) {
    if txid.is_empty() {
        return;
    }
    if let Ok(mut g) = OURS.lock() {
        g.get_or_insert_with(HashSet::new).insert(txid.to_string());
    }
}

#[tauri::command]
pub fn note_our_tx(txid: String) {
    remember_ours(&txid);
}

/// Sends money back to a customer.
///
/// The amount is stated rather than derived from the original payment, because
/// partial refunds are the common case — a missing item, a late delivery, a
/// three-day credit. Deriving it would make the frequent case impossible and
/// the rare case automatic.
#[tauri::command]
pub async fn refund(
    to_address: String,
    amount: f64,
    reason: String,
    passphrase: Option<String>,
) -> Result<Value, String> {
    if !amount.is_finite() || amount <= 0.0 || amount > 21_000_000_000.0 {
        return Err("환불 금액이 0보다 커야 합니다.".into());
    }
    let check = crate::send::check_address(to_address.clone()).await?;
    if !check["valid"].as_bool().unwrap_or(false) {
        return Err("환불받을 주소가 올바르지 않습니다.".into());
    }

    let balance = call_rpc("getbalance", json!([]))
        .await
        .ok()
        .and_then(|v| v.as_f64())
        .unwrap_or(0.0);
    if balance < amount {
        return Err(format!(
            "지갑에 {balance} RVN 있습니다. {amount} RVN을 보낼 수 없습니다. \
             환불은 새로 보내는 것이라 잔액이 있어야 합니다."
        ));
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

    // The reason is a wallet-local comment; it never goes on chain. Said out
    // loud in the UI, because a shop owner writing an apology into a box that
    // the customer will never see is being misled.
    let result = call_rpc(
        "sendtoaddress",
        json!([to_address, amount, format!("환불: {reason}"), "", false]),
    )
    .await;

    if locked {
        let _ = call_rpc("walletlock", json!([])).await;
    }

    let txid = result?
        .as_str()
        .map(str::to_string)
        .ok_or_else(|| "sendtoaddress did not return a txid".to_string())?;
    remember_ours(&txid);

    // 🔴 **여기를 안 부르면 함수만 있고 안 도는 코드가 된다.** 환불한 만큼
    //    우리 몫도 되돌린다 — 취소된 장사에서 개발비를 받으면 안 된다.
    let back = crate::devfee::refund_credit(amount);

    Ok(json!({
        "txid": txid,
        "amount": amount,
        "to": to_address,
        // 얼마를 깎았는지 화면이 말할 수 있게 돌려준다. 0 이면 이미 체인으로
        // 나간 몫이라 못 되돌린 것이고, 그것도 사실대로 적어야 한다.
        "dev_fee_back": back,
    }))
}

/// Spends this app did not make.
///
/// Called on a timer while the shop screen is open. Ignores everything we sent,
/// so a busy day of automatic fulfilment produces no noise — an alert that
/// fires forty times on the first night is an alert the owner turns off.
///
/// 🔴 **주인 표가 나가도 경보를 못 했다(0.4.6 에서 고침).** 예전에는
///    `listtransactions` 만 봤는데, 레이븐 4.8 의 그 명령은 자산 줄을 만들어 놓고
///    **버린다**(rpcwallet.cpp:1790). 그래서 이 목록의 「소유권 토큰이 나갔습니다」는
///    한 번도 켜질 수 없었다. 자산 줄은 `listsinceblock` 의 `asset_transactions` 에
///    있고, 받는 주소는 `address` 가 아니라 `destination` 이다.
///
///    타이머로 불리므로 지갑 전체를 읽지 않는다 — `since_hours` 앞쯤의 블록부터만
///    (`listsinceblock <그 블록>`). 우리가 보낸 거래(`OURS`)는 예전처럼 뺀다.
#[tauri::command]
pub async fn foreign_spends(since_hours: i64) -> Result<Value, String> {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    let hours = since_hours.clamp(0, MAX_WATCH_HOURS);
    let cutoff = now - hours * 3600;

    let tip = call_rpc("getblockcount", json!([])).await?.as_u64().unwrap_or(0);
    let args = match start_height(tip, hours) {
        Some(h) => json!([call_rpc("getblockhash", json!([h])).await?, 1, true]),
        // 체인이 짧다(연습 체인 등) — 처음부터 읽어도 얼마 안 된다.
        None => json!([]),
    };
    let since = call_rpc("listsinceblock", args).await?;

    let ours = OURS.lock().ok().and_then(|g| g.clone()).unwrap_or_default();
    let found = spends_not_ours(&since, cutoff, &ours)?;

    // 앱을 껐다 켜면 우리가 보낸 것도 "남이 보낸 것"으로 보인다. 그걸 침입으로
    // 읽으면 안 되므로, 목록이 신뢰할 만한 구간을 함께 알려 준다.
    let known = !ours.is_empty();
    Ok(json!({
        "spends": found,
        "trustworthy": known,
        "note": if known { "" } else {
            "앱을 켠 뒤 이 앱이 보낸 기록이 아직 없어, 아래 목록에 정상 출금이 섞일 수 있습니다."
        },
    }))
}

/// 한 달보다 길게는 안 본다. 타이머가 지갑 전체를 읽는 길이 되면 안 된다.
const MAX_WATCH_HOURS: i64 = 24 * 31;

/// `hours` 시간 전쯤의 블록 높이. 레이븐은 1분에 한 블록이 목표지만 빨리 나올 때가
/// 있어 넉넉히(1.25배 + 30블록) 거슬러 간다 — 넘치는 것은 아래에서 시각으로 거른다.
/// 체인이 그보다 짧으면 `None`(처음부터).
fn start_height(tip: u64, hours: i64) -> Option<u64> {
    let back = (hours.max(0) as u64) * 60 * 5 / 4 + 30;
    tip.checked_sub(back)
}

/// `listsinceblock` 답에서 **우리가 안 보낸** 보냄 줄 — RVN 줄과 자산 줄 둘 다.
///
/// 자산 줄을 못 읽으면 오류다. 「못 읽음」을 「없음」으로 넘기면 주인 표가 나간 날
/// 조용하다.
fn spends_not_ours(since: &Value, cutoff: i64, ours: &HashSet<String>) -> Result<Vec<Value>, String> {
    let rvn = since
        .get("transactions")
        .and_then(Value::as_array)
        .ok_or("지갑 기록을 읽지 못했어요. 서버가 따라잡은 뒤 다시 해 주세요.")?;
    let assets = crate::raven::asset_transactions_of(since.clone())?;
    let mut found = Vec::new();
    for (tx, asset_row) in rvn
        .iter()
        .map(|t| (t, false))
        .chain(assets.as_array().map(Vec::as_slice).unwrap_or(&[]).iter().map(|t| (t, true)))
    {
        if tx.get("category").and_then(Value::as_str) != Some("send") {
            continue;
        }
        let time = tx.get("time").and_then(Value::as_i64).unwrap_or(0);
        if time < cutoff {
            continue;
        }
        let txid = tx.get("txid").and_then(Value::as_str).unwrap_or("");
        if ours.contains(txid) {
            continue;
        }
        let asset = tx.get("asset_name").and_then(Value::as_str);
        // 자산 줄의 받는 주소는 `destination` 이다(RVN 줄은 `address`).
        let address = if asset_row { tx.get("destination") } else { tx.get("address") };
        found.push(json!({
            "txid": txid,
            "time": time,
            "address": address,
            "amount": tx.get("amount").and_then(Value::as_f64).map(f64::abs),
            "asset": asset,
            // An ownership token leaving is the worst thing on this list: it
            // hands over the right to mint that asset forever.
            "is_owner_token": asset.map(|a| a.ends_with('!')).unwrap_or(false),
        }));
    }
    Ok(found)
}

// ── 직원 환불 한도 ────────────────────────────────────────────────────────
//
// 커피숍에서 환불은 직원이 해야 장사가 된다. 손님이 잘못 시켰거나 우리가 잘못
// 만들었을 때 사장을 부르러 가면 그 사이 줄이 선다.
//
// 그런데 체인은 보낸 사람을 기록하지 않는다. 그래서 "그 손님에게 돌려주기"가
// 자동으로 안 되고, 직원이 주소를 받아 쳐야 한다 — 곧 **아무 주소로나 보낼 수
// 있다**는 뜻이다. 그래서 신뢰가 아니라 한도로 막는다.
//
// 한도가 곧 손실의 상한이고, 그 상한이 줄을 세우지 않는 값이다.

/// 직원 1건 한도 — 미국 달러 기준.
///
/// 통화별로 따로 적지 않는 이유: 나라가 늘 때마다 표를 고쳐야 하고, 빠뜨린
/// 나라는 조용히 원화 한도를 쓰게 된다. 한 곳에 적고 그 나라 돈으로 바꾼다.
const STAFF_ONCE_USD: f64 = 25.0;
/// 직원 하루 한도 — 미국 달러 기준.
const STAFF_DAY_USD: f64 = 80.0;

/// 사람이 읽는 자리에서 끊는다. 33,152원 짜리 한도는 아무도 기억하지 못한다.
fn round_limit(v: f64) -> f64 {
    let step = if v >= 10_000.0 {
        10_000.0
    } else if v >= 1_000.0 {
        1_000.0
    } else if v >= 100.0 {
        10.0
    } else {
        5.0
    };
    (v / step).round().max(1.0) * step
}

/// 이 가게 돈으로 환산한 한도. (1건, 하루)
///
/// 환율이 안 잡히면: 원화 가게는 원화 기본값으로, **그 밖의 가게는 직원 환불을
/// 닫는다**(한도 0).
///
/// 🔴 2026-09-23 까지는 어느 나라든 원화 숫자(30,000·100,000)로 되돌아갔다. 그런데
///    환불 금액은 가게 돈으로 센다 — 유로 가게에서 환율 조회가 한 번 실패하면
///    직원이 **3만 유로**까지 환불할 수 있었다. 한도를 못 계산했다고 여는 것은
///    정반대 방향의 실수다.
async fn staff_limits() -> (f64, f64, String) {
    let cur = crate::shop::currency();
    if cur == "USD" {
        return (STAFF_ONCE_USD, STAFF_DAY_USD, cur);
    }
    let fx = crate::price::fiat_per_usd_public(&cur).await;
    limits_from_fx(&cur, fx)
}

fn limits_from_fx(cur: &str, fx: Option<f64>) -> (f64, f64, String) {
    match fx.filter(|v| v.is_finite() && *v > 0.0) {
        Some(fx) => (
            round_limit(STAFF_ONCE_USD * fx),
            round_limit(STAFF_DAY_USD * fx),
            cur.to_string(),
        ),
        None if cur == "KRW" => (30_000.0, 100_000.0, "KRW".into()),
        None => (0.0, 0.0, cur.to_string()),
    }
}

/// UTC budgets are durable and shared across role-token rotation/restarts.
static STAFF_GATE: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
fn today(now_unix: i64) -> i64 { now_unix - now_unix.rem_euclid(86_400) }
#[derive(Clone, serde::Serialize, serde::Deserialize)]
struct Reservation {
    request_id: String, payment_txid: String, order_address: String, to: String,
    day: i64, usd: f64, amount: f64, currency: String, sats: u64,
    state: String, txid: Option<String>,
    #[serde(default)] rate: Option<f64>,
    #[serde(default)] reason: Option<String>,
}
#[derive(Default, serde::Serialize, serde::Deserialize)]
struct RefundJournal { reservations: Vec<Reservation> }
trait JournalStore { fn load(&self) -> Result<RefundJournal,String>; fn save(&self,journal:&RefundJournal)->Result<(),String>; }
struct FileJournal(std::path::PathBuf);
impl JournalStore for FileJournal {
    fn load(&self)->Result<RefundJournal,String> {
        let bytes = match std::fs::read(&self.0) { Ok(b)=>b, Err(e) if e.kind()==std::io::ErrorKind::NotFound=>return Ok(Default::default()), Err(_)=>return Err("환불 기록을 읽지 못했습니다. 사장님이 저장소를 확인해 주세요.".into()) };
        if bytes.len()>8*1024*1024 { return Err("환불 기록이 너무 큽니다. 사장님이 기록을 확인해 주세요.".into()); }
        let journal: RefundJournal=serde_json::from_slice(&bytes).map_err(|_|"환불 기록이 손상되었습니다. 사장님이 기록을 확인하기 전에는 다시 보내지 마세요.")?;
        if journal.reservations.iter().any(|r| !r.usd.is_finite() || r.usd<=0.0 || !r.amount.is_finite() || r.amount<=0.0 || r.sats==0 || r.rate.is_some_and(|v|!v.is_finite()||v<=0.0) || r.reason.as_ref().is_some_and(|v|v.len()>300) || !matches!(r.state.as_str(),"reserved"|"dispatching"|"complete"|"cancelled")) {
            return Err("환불 기록을 검증하지 못했습니다. 사장님께 부탁하세요.".into());
        }
        Ok(journal)
    }
    fn save(&self,journal:&RefundJournal)->Result<(),String> {
        use std::io::Write;
        let parent=self.0.parent().ok_or("환불 기록 경로가 없습니다.")?;
        std::fs::create_dir_all(parent).map_err(|_|"환불 기록 폴더를 만들지 못했습니다.")?;
        let temp=parent.join(format!(".refund-reservation-{}-{:x}.tmp",std::process::id(),rand::random::<u64>()));
        let result=(||->std::io::Result<()> {
            let mut options=std::fs::OpenOptions::new();options.write(true).create_new(true);
            #[cfg(unix)] { use std::os::unix::fs::OpenOptionsExt;options.mode(0o600); }
            let mut file=options.open(&temp)?;
            file.write_all(&serde_json::to_vec(journal)?)?;file.sync_all()?;drop(file);
            std::fs::rename(&temp,&self.0)?;
            #[cfg(unix)] { std::fs::File::open(parent)?.sync_all()?; }
            Ok(())
        })();
        if result.is_err() { let _=std::fs::remove_file(temp); }
        result.map_err(|_|"환불 기록을 안전하게 저장하지 못했습니다. 사장님이 저장소를 확인하기 전에는 다시 보내지 마세요.".into())
    }
}
fn journal_file()->FileJournal { FileJournal(crate::paths::app_file("staff-refund-reservations.json")) }
fn active(r:&Reservation)->bool { r.state!="cancelled" }
fn used_usd(journal:&RefundJournal,day:i64)->f64 { journal.reservations.iter().filter(|r|r.day==day&&active(r)).map(|r|r.usd).sum() }
fn sats(value:f64)->Result<u64,String> {
    if !value.is_finite() || value<=0.0 || value>21_000_000_000.0 { return Err("환불 금액을 확인해 주세요.".into()); }
    let n=(value*1e8).round();if n<1.0 || n>2_100_000_000_000_000_000.0 { return Err("환불 금액이 너무 작거나 큽니다.".into()); } Ok(n as u64)
}
fn mainnet_address(address:&str)->bool { crate::electrum::base58check(address).is_ok_and(|b|b.len()==21&&b[0]==60) }
fn txid_shape(id:&str)->bool { id.len()==64&&id.bytes().all(|b|b.is_ascii_digit()||(b'a'..=b'f').contains(&b)) }
type RefundFuture<'a,T> = std::pin::Pin<Box<dyn std::future::Future<Output=Result<T,String>>+Send+'a>>;
trait StaffBackend: Sync {
    fn quote<'a>(&'a self,currency:&'a str)->RefundFuture<'a,Value>;
    #[allow(clippy::too_many_arguments)]
    fn audit(&self,to:&str,amount:f64,currency:&str,rvn:f64,rate:f64,reason:&str,txid:&str,now:i64)->Result<(),String>;
    fn verify<'a>(&'a self,sale:&'a Value,to:&'a str)->RefundFuture<'a,()>;
    fn pay<'a>(&'a self,to:&'a str,rvn:f64,reason:&'a str,passphrase:Option<String>)->RefundFuture<'a,Value>;
}
struct LocalStaffBackend;
impl StaffBackend for LocalStaffBackend {
    fn audit(&self,to:&str,amount:f64,currency:&str,rvn:f64,rate:f64,reason:&str,txid:&str,now:i64)->Result<(),String> {
        crate::ledger::record_refund(to,amount,currency,rvn,rate,reason,txid,now)
    }
    fn quote<'a>(&'a self,currency:&'a str)->RefundFuture<'a,Value> { Box::pin(async move {
        #[cfg(test)] { let _=currency;Err("Tests must inject synthetic RVN quotes".into()) }
        #[cfg(not(test))] { crate::price::rvn_rate(currency.to_string()).await }
    }) }
    fn verify<'a>(&'a self,sale:&'a Value,to:&'a str)->RefundFuture<'a,()> { Box::pin(async move {
        let id=sale["txid"].as_str().ok_or("원 결제 거래가 없습니다.")?;
        let wallet=call_rpc("gettransaction",json!([id])).await?;
        if wallet["confirmations"].as_i64().unwrap_or(0)<1 || wallet["abandoned"]==true { return Err("원 결제의 확인을 기다린 뒤 다시 환불해 주세요.".into()); }
        let received=wallet["details"].as_array().ok_or("원 결제의 수신 기록을 확인하지 못했습니다.")?.iter()
            .filter(|d|d["category"]=="receive"&&d["address"]==sale["address"])
            .filter_map(|d|d["amount"].as_f64()).sum::<f64>();
        if !received.is_finite() || received+1e-8<sale["rvn"].as_f64().unwrap_or(f64::INFINITY) { return Err("원 결제 금액을 확인하지 못했습니다. 사장님께 부탁하세요.".into()); }
        let payment=call_rpc("getrawtransaction",json!([id,1])).await?;
        let vins=payment["vin"].as_array().filter(|a|!a.is_empty()&&a.len()<=128).ok_or("원 결제의 보낸 주소를 확인하지 못했습니다.")?;
        let mut previous=std::collections::HashMap::new();
        for vin in vins {
            let prev=vin["txid"].as_str().filter(|s|txid_shape(s)).ok_or("원 결제 입력을 확인하지 못했습니다.")?;
            if !previous.contains_key(prev) { previous.insert(prev.to_string(),call_rpc("getrawtransaction",json!([prev,1])).await?); }
        }
        verify_payer(sale,&payment,&previous,to)
    }) }
    fn pay<'a>(&'a self,to:&'a str,rvn:f64,reason:&'a str,passphrase:Option<String>)->RefundFuture<'a,Value> {
        Box::pin(refund(to.to_string(),rvn,reason.to_string(),passphrase))
    }
}
fn verify_payer(sale:&Value,payment:&Value,previous:&std::collections::HashMap<String,Value>,to:&str)->Result<(),String> {
    if payment["txid"]!=sale["txid"] || !mainnet_address(to) { return Err("원 결제와 환불 주소가 맞지 않습니다. 사장님께 부탁하세요.".into()); }
    let received=payment["vout"].as_array().ok_or("원 결제 출력을 확인하지 못했습니다.")?.iter()
        .filter(|o|o["scriptPubKey"]["addresses"].as_array().is_some_and(|a|a.iter().any(|v|v==&sale["address"])))
        .filter_map(|o|o["value"].as_f64()).sum::<f64>();
    if !received.is_finite() || received+1e-8<sale["rvn"].as_f64().unwrap_or(f64::INFINITY) { return Err("원 결제가 이 주문을 지급하지 않았습니다. 사장님께 부탁하세요.".into()); }
    let vins=payment["vin"].as_array().filter(|a|!a.is_empty()&&a.len()<=128).ok_or("원 결제 입력이 없습니다.")?;
    for input in vins {
        let prev=input["txid"].as_str().and_then(|id|previous.get(id)).ok_or("원 결제 보낸 주소를 확인하지 못했습니다.")?;
        let n=input["vout"].as_u64().and_then(|n|usize::try_from(n).ok()).ok_or("원 결제 입력 번호가 올바르지 않습니다.")?;
        let output=prev["vout"].as_array().and_then(|a|a.get(n)).ok_or("원 결제 입력을 찾지 못했습니다.")?;
        let addresses=output["scriptPubKey"]["addresses"].as_array().ok_or("보낸 주소가 단일 주소가 아닙니다. 사장님께 부탁하세요.")?;
        if addresses.len()!=1 || addresses[0]!=to { return Err("직원은 확인된 원 결제의 보낸 주소로만 환불할 수 있습니다. 거래소 결제·다른 주소 환불은 사장님께 부탁하세요.".into()); }
    }
    Ok(())
}
#[tauri::command]
pub async fn staff_refund_limits(now_unix:i64)->Value {
    let _gate=STAFF_GATE.lock().await;
    let (once,per_day,cur)=staff_limits().await;
    let journal=match journal_file().load() { Ok(j)=>j,Err(e)=>return json!({"error":e,"once":0,"day":0,"left":0,"currency":cur}) };
    let used=used_usd(&journal,today(now_unix))/STAFF_DAY_USD*per_day;
    json!({"once":once,"day":per_day,"used":used,"left":(per_day-used).max(0.0),"currency":cur,
        "once_krw":once,"day_krw":per_day,"used_krw":used,"left_krw":(per_day-used).max(0.0)})
}
/// Only a durable cancelled reservation proves that this exact intent was not
/// broadcast. All other errors deliberately carry no permission to discard it.
#[derive(Clone, serde::Serialize)]
struct RefundIntent { order_address:String, to:String, amount:f64, reason:Option<String> }
pub(crate) struct RefundFailure { message:String, cancelled:Option<(String,RefundIntent)> }
impl From<String> for RefundFailure { fn from(message:String)->Self { Self{message,cancelled:None} } }
impl From<&str> for RefundFailure { fn from(message:&str)->Self { message.to_string().into() } }
impl std::fmt::Debug for RefundFailure { fn fmt(&self,f:&mut std::fmt::Formatter<'_>)->std::fmt::Result { f.debug_struct("RefundFailure").field("message",&self.message).finish() } }
impl std::ops::Deref for RefundFailure { type Target=str;fn deref(&self)->&str { &self.message } }
impl RefundFailure {
    pub(crate) fn body(&self)->Value {
        match &self.cancelled {
            Some((id,intent))=>json!({"error":self.message,"refund_outcome":"not_sent","request_id":id,"request":intent}),
            None=>json!({"error":self.message,"refund_outcome":"unresolved"}),
        }
    }
}
fn prior_request(journal:&RefundJournal,id:&str,order:&str,to:&str,amount:f64,reason:&str)->Result<(),RefundFailure> {
    if let Some(r)=journal.reservations.iter().find(|r|r.request_id==id) {
        let message="이 요청은 이미 환불 기록에 있습니다. 사장님이 거래 결과를 확인해 주세요. 같은 환불을 다시 보내지 마세요.";
        if r.state=="cancelled" && r.order_address==order && r.to==to && r.amount==amount
            && r.reason.as_ref().is_none_or(|v|v==reason) {
            return Err(RefundFailure{message:"전송 전에 환불이 취소되었습니다. 주소와 금액을 확인한 뒤 새 요청으로 다시 진행하세요.".into(),cancelled:Some((id.into(),RefundIntent{order_address:r.order_address.clone(),to:r.to.clone(),amount:r.amount,reason:r.reason.clone()}))});
        }
        return Err(message.into());
    }
    Ok(())
}
#[tauri::command]
pub async fn staff_refund(to_address:String,krw:f64,reason:String,now_unix:i64,passphrase:Option<String>,order_address:String,request_id:String)->Result<Value,String> {
    staff_refund_response(to_address,krw,reason,now_unix,passphrase,order_address,request_id).await.map_err(|e|e.message)
}
pub(crate) async fn staff_refund_response(to_address:String,krw:f64,reason:String,now_unix:i64,passphrase:Option<String>,order_address:String,request_id:String)->Result<Value,RefundFailure> {
    let _gate=STAFF_GATE.lock().await;
    let store=journal_file();let journal=store.load()?;
    // Resolve a recorded ID before lookup, quote or validation of edited input.
    prior_request(&journal,&request_id,&order_address,&to_address,krw,&reason)?;
    let sale=crate::ledger::recent_sold_index(now_unix).remove(&order_address).ok_or("이 주문의 결제 기록이 없습니다. 주문의 결제 주소를 넣거나 사장님께 부탁하세요.")?;
    let (once,per_day,cur)=staff_limits().await;
    staff_refund_locked(&store,&LocalStaffBackend,journal,&sale,&to_address,krw,&reason,now_unix,passphrase,&request_id,once,per_day,&cur).await
}
#[cfg(test)]
#[allow(clippy::too_many_arguments)]
async fn staff_refund_with(store:&impl JournalStore,backend:&impl StaffBackend,sale:&Value,to:&str,amount:f64,reason:&str,now:i64,passphrase:Option<String>,request_id:&str,once:f64,per_day:f64,cur:&str)->Result<Value,RefundFailure> {
    let _gate=STAFF_GATE.lock().await;
    staff_refund_locked(store,backend,store.load()?,sale,to,amount,reason,now,passphrase,request_id,once,per_day,cur).await
}
#[allow(clippy::too_many_arguments)]
async fn staff_refund_locked(store:&impl JournalStore,backend:&impl StaffBackend,mut journal:RefundJournal,sale:&Value,to:&str,amount:f64,reason:&str,now:i64,passphrase:Option<String>,request_id:&str,once:f64,per_day:f64,cur:&str)->Result<Value,RefundFailure> {
    prior_request(&journal,request_id,sale["address"].as_str().unwrap_or(""),to,amount,reason)?;
    if !amount.is_finite() || amount<=0.0 || !once.is_finite() || once<=0.0 || !per_day.is_finite() || per_day<=0.0 || amount>once
        || request_id.len()!=32 || !request_id.bytes().all(|b|b.is_ascii_digit()||(b'a'..=b'f').contains(&b)) || reason.len()>300 || !mainnet_address(to) {
        return Err("금액·주소·요청 번호를 확인해 주세요. 직원 한도를 넘는 환불은 사장님께 부탁하세요.".into());
    }
    let original=sale["txid"].as_str().filter(|s|txid_shape(s)).ok_or("원 결제 거래를 확인하지 못했습니다.")?;
    let total=sale["amount"].as_f64().filter(|a|a.is_finite()&&*a>0.0).ok_or("원 결제 금액이 없습니다.")?;
    if sale["currency"]!=cur || sale["kind"]!="sale" || sale["confirmations"].as_i64().unwrap_or(0)<0 { return Err("확인된 같은 통화의 원 결제만 직원이 환불할 수 있습니다. 사장님께 부탁하세요.".into()); }
    let total_sats=sats(sale["rvn"].as_f64().unwrap_or(0.0))?;
    let quote=backend.quote(cur).await?;
    let rate=quote["rate"].as_f64().filter(|r|r.is_finite()&&*r>0.0).filter(|_|quote["currency"]==cur).ok_or("시세를 읽지 못해 환불을 멈췄습니다. 사장님께 부탁하세요.")?;
    // Existing shop contract: entered fiat / current fiat-per-RVN, rounded to sats.
    let refund_sats=sats(amount/rate)?;
    let usd=amount/per_day*STAFF_DAY_USD;
    if journal.reservations.iter().any(|r|r.payment_txid==original&&matches!(r.state.as_str(),"reserved"|"dispatching")) { return Err("이 결제의 이전 환불 결과를 아직 모릅니다. 사장님이 거래를 확인하기 전에는 다시 보내지 마세요.".into()); }
    let used=used_usd(&journal,today(now));
    if used+usd>STAFF_DAY_USD+1e-9 { return Err("오늘 직원 환불 한도를 넘습니다. 사장님께 부탁하세요.".into()); }
    let paid:Vec<_>=journal.reservations.iter().filter(|r|r.payment_txid==original&&active(r)).collect();
    let spent=paid.iter().try_fold(0u64,|sum,r|sum.checked_add(r.sats)).ok_or("환불 금액 합계를 확인하지 못했습니다.")?;
    if spent.checked_add(refund_sats).is_none_or(|n|n>total_sats) || paid.iter().map(|r|r.amount).sum::<f64>()+amount>total+1e-8 { return Err("원 결제의 남은 환불 금액을 넘습니다. 사장님께 부탁하세요.".into()); }
    journal.reservations.push(Reservation{request_id:request_id.into(),payment_txid:original.into(),order_address:sale["address"].as_str().unwrap_or("").into(),to:to.into(),day:today(now),usd,amount,currency:cur.into(),sats:refund_sats,state:"reserved".into(),txid:None,rate:Some(rate),reason:Some(reason.into())});
    store.save(&journal)?; // Never call even a read RPC before durable admission.
    let index=journal.reservations.len()-1;
    if let Err(e)=backend.verify(sale,to).await {
        journal.reservations[index].state="cancelled".into();store.save(&journal)?;
        let r=&journal.reservations[index];
        return Err(RefundFailure{message:e,cancelled:Some((request_id.into(),RefundIntent{order_address:r.order_address.clone(),to:r.to.clone(),amount,reason:r.reason.clone()}))});
    }
    journal.reservations[index].state="dispatching".into();store.save(&journal)?;
    let rvn=refund_sats as f64/1e8;
    let result=backend.pay(to,rvn,reason,passphrase).await.map_err(|_|format!("{}이 환불의 전송 결과를 확인하지 못했습니다. 예약 한도는 유지됩니다. 사장님이 거래를 확인하기 전에는 다시 보내지 마세요.",crate::raven::SENT_UNKNOWN))?;
    let txid=result["txid"].as_str().filter(|s|txid_shape(s)).ok_or_else(||format!("{}환불 거래 번호를 확인하지 못했습니다. 다시 보내지 마세요.",crate::raven::SENT_UNKNOWN))?;
    journal.reservations[index].state="complete".into();journal.reservations[index].txid=Some(txid.into());
    store.save(&journal).map_err(|_|format!("{}환불 전송 뒤 기록 저장을 확인하지 못했습니다. 예약 기록은 유지됩니다. 다시 보내지 마세요.",crate::raven::SENT_UNKNOWN))?;
    // Completion is durable before the append-only audit. An uncertain audit
    // write cannot cause a retry to send or record a second time.
    backend.audit(to,amount,cur,rvn,rate,reason,txid,now).map_err(|_|format!("{}환불은 전송되었지만 매출장부 저장을 확인하지 못했습니다. 사장님이 환불 예약 기록과 거래를 확인해 주세요. 다시 보내지 마세요.",crate::raven::SENT_UNKNOWN))?;
    let left=(STAFF_DAY_USD-used-usd)/STAFF_DAY_USD*per_day;
    Ok(json!({"result":result,"amount":amount,"currency":cur,"rate":rate,"symbol":crate::price::symbol_for(cur),"rvn":rvn,"left":left.max(0.0),"krw":amount,"left_krw":left.max(0.0),"notify_owner":true}))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_day_rolls_over_at_midnight_utc() {
        let noon = 1_787_100_000_i64;
        assert_eq!(today(noon), today(noon + 3_600));
        // 하루가 지나면 한도가 새로 열려야 한다. 안 그러면 어제 쓴 만큼
        // 오늘 아침에 환불을 못 한다.
        assert_ne!(today(noon), today(noon + 86_400));
    }

    #[test]
    fn one_refund_can_never_exceed_the_day() {
        // 1건 한도가 하루 한도보다 크면 한 번에 하루치를 넘길 수 있다.
        assert!(STAFF_ONCE_USD <= STAFF_DAY_USD);
        // 그리고 하루에 최소 두 번은 되어야 쓸모가 있다 — 커피숍에서 환불이
        // 하루 한 번뿐이면 두 번째 손님은 사장을 기다린다.
        assert!(STAFF_DAY_USD >= STAFF_ONCE_USD * 2.0);
    }

    #[test]
    fn limits_stay_readable_in_every_currency() {
        // 환산한 한도가 33,152 같은 숫자로 나오면 아무도 못 외운다. 그리고
        // 반올림이 순서를 뒤집으면 1건 한도가 하루 한도를 넘을 수 있다.
        for fx in [1.0, 1_380.0, 155.0, 7.2, 0.92, 0.0079] {
            let once = round_limit(STAFF_ONCE_USD * fx);
            let day = round_limit(STAFF_DAY_USD * fx);
            assert!(once > 0.0 && day > 0.0, "fx {fx} 에서 한도가 0 이 됐습니다");
            assert!(once <= day, "fx {fx}: 1건 {once} 가 하루 {day} 보다 큽니다");
        }
    }

    #[test]
    fn unknown_rate_closes_staff_refunds_outside_won() {
        // 원화 가게만 원화 기본값. 다른 나라 가게에 원화 숫자를 한도로 주면
        // 3만 유로·3만 달러가 열린다.
        assert_eq!(limits_from_fx("KRW", None), (30_000.0, 100_000.0, "KRW".into()));
        for cur in ["EUR", "JPY", "GBP", "THB", "VND"] {
            let (once, day, c) = limits_from_fx(cur, None);
            assert_eq!((once, day), (0.0, 0.0), "{cur}");
            assert_eq!(c, cur);
            assert_eq!(limits_from_fx(cur, Some(0.0)).0, 0.0, "{cur}: 0 환율");
            assert_eq!(limits_from_fx(cur, Some(f64::NAN)).0, 0.0, "{cur}: NaN 환율");
        }
        let (once, day, c) = limits_from_fx("JPY", Some(155.0));
        assert!(once > 0.0 && once <= day && c == "JPY");
    }

    /// 레이븐 4.8 `listsinceblock <hash> 1 true` 의 모양 그대로(rpcwallet.cpp
    /// ListTransactions · WalletTxToJSON). 주소·거래 번호는 누가 봐도 가짜다.
    fn since_fixture(now: i64) -> Value {
        let tx = |c: char| c.to_string().repeat(64);
        json!({
            "transactions": [
                { "account": "", "address": "RTestSomeoneElseXXXXXXXXXXXXXXXXXX", "category": "send",
                  "amount": -12.5, "vout": 0, "fee": -0.0226, "confirmations": 3,
                  "blockhash": "00".repeat(32), "blockindex": 4, "blocktime": now - 300,
                  "txid": tx('a'), "walletconflicts": [], "time": now - 320, "timereceived": now - 320,
                  "bip125-replaceable": "no", "abandoned": false },
                { "account": "", "address": "RTestMyOwnReceiveXXXXXXXXXXXXXXXXX", "category": "receive",
                  "amount": 3.0, "label": "", "vout": 1, "confirmations": 3,
                  "blockhash": "00".repeat(32), "blockindex": 5, "blocktime": now - 300,
                  "txid": tx('b'), "walletconflicts": [], "time": now - 320, "timereceived": now - 320,
                  "bip125-replaceable": "no" }
            ],
            "asset_transactions": [
                // 🔴 주인 표가 남의 주소로 나갔다 — 이게 이 목록의 존재 이유다.
                { "asset_type": "transfer_asset", "asset_name": "TESTBRAND!", "amount": 1.0, "message": "",
                  "destination": "RTestThiefAddressXXXXXXXXXXXXXXXXX", "vout": 1, "category": "send",
                  "confirmations": 0, "trusted": true, "txid": tx('c'), "walletconflicts": [],
                  "time": now - 60, "timereceived": now - 60, "bip125-replaceable": "no", "abandoned": false },
                // 우리가 보낸 자산 — 빼야 한다.
                { "asset_type": "transfer_asset", "asset_name": "TESTBRAND/TICKET", "amount": 2.0, "message": "",
                  "destination": "RTestCustomerXXXXXXXXXXXXXXXXXXXXX", "vout": 0, "category": "send",
                  "confirmations": 1, "blockhash": "00".repeat(32), "blockindex": 2, "blocktime": now - 100,
                  "txid": tx('d'), "walletconflicts": [], "time": now - 100, "timereceived": now - 100,
                  "bip125-replaceable": "no", "abandoned": false },
                // 받은 자산은 출금이 아니다.
                { "asset_type": "transfer_asset", "asset_name": "GIFT", "amount": 5.0, "message": "",
                  "destination": "RTestMyOwnReceiveXXXXXXXXXXXXXXXXX", "vout": 0, "category": "receive",
                  "confirmations": 1, "txid": tx('e'), "walletconflicts": [], "time": now - 50,
                  "timereceived": now - 50, "bip125-replaceable": "no", "abandoned": false },
                // 창 밖(오래전) — 시각으로 거른다.
                { "asset_type": "transfer_asset", "asset_name": "OLDBRAND!", "amount": 1.0, "message": "",
                  "destination": "RTestLongAgoXXXXXXXXXXXXXXXXXXXXXX", "vout": 1, "category": "send",
                  "confirmations": 900, "txid": tx('f'), "walletconflicts": [], "time": now - 90_000,
                  "timereceived": now - 90_000, "bip125-replaceable": "no", "abandoned": false }
            ],
            "removed": [],
            "assets_removed": [],
            "lastblock": "00".repeat(32)
        })
    }

    #[test]
    fn 주인_표가_나가면_경보한다() {
        let now = 1_787_100_000_i64;
        let ours: HashSet<String> = ["d".repeat(64)].into_iter().collect();
        let got = spends_not_ours(&since_fixture(now), now - 24 * 3600, &ours).unwrap();
        assert_eq!(got.len(), 2, "{got:?}");
        assert_eq!(got[0]["asset"], Value::Null, "RVN 줄");
        assert_eq!(got[0]["amount"], 12.5);
        assert_eq!(got[0]["address"], "RTestSomeoneElseXXXXXXXXXXXXXXXXXX");
        assert_eq!(got[1]["asset"], "TESTBRAND!");
        assert_eq!(got[1]["is_owner_token"], true);
        // 자산 줄의 받는 주소는 destination 에서 온다.
        assert_eq!(got[1]["address"], "RTestThiefAddressXXXXXXXXXXXXXXXXX");
        // 우리가 보낸 것이면 조용하다.
        let ours: HashSet<String> = ["c".repeat(64), "d".repeat(64), "a".repeat(64)].into_iter().collect();
        assert!(spends_not_ours(&since_fixture(now), now - 24 * 3600, &ours).unwrap().is_empty());
    }

    #[test]
    fn 자산_줄을_못_읽으면_없다고_하지_않는다() {
        let mut v = since_fixture(1_787_100_000);
        v.as_object_mut().unwrap().remove("asset_transactions");
        assert!(spends_not_ours(&v, 0, &HashSet::new()).is_err());
        assert!(spends_not_ours(&json!({}), 0, &HashSet::new()).is_err());
    }

    #[test]
    fn 지갑_전체가_아니라_그_시간_앞쯤부터_읽는다() {
        // 24시간 ≈ 1,440블록. 넉넉히 1,830블록 앞.
        assert_eq!(start_height(3_000_000, 24), Some(3_000_000 - 1_830));
        assert_eq!(start_height(100, 24), None, "짧은 공개 장부는 처음부터");
        assert_eq!(start_height(3_000_000, -5), Some(3_000_000 - 30));
        assert!(MAX_WATCH_HOURS <= 24 * 31);
        // 타이머가 부르는 자리에 전체 읽기(`listtransactions`·빈 listsinceblock)가 없다.
        let src = include_str!("refund.rs");
        let i = src.find("pub async fn foreign_spends(").unwrap();
        let body = &src[i..i + src[i..].find("\n}\n").unwrap()];
        assert!(!body.contains("listtransactions"), "자산 줄이 빠지는 명령을 다시 쓰고 있다");
        assert!(body.contains("getblockhash"), "시작 블록을 정해야 한다");
    }

    #[test]
    fn a_shop_that_never_set_a_currency_still_gets_won() {
        // 통화를 정하지 않은 가게가 빈 문자열로 계산에 들어가면, 시세 조회가
        // 실패하면서 환불이 통째로 막힌다.
        let c = crate::shop::currency();
        assert_eq!(c.len(), 3, "통화 코드가 세 글자가 아닙니다: {c}");
    }
}

/// 환불 칸을 미리 채우기 위한 조회.
///
/// ⚠️ **노드를 먼저 묻는다.** 우리 노드가 답하면 아무도 우리가 무엇을
///    조회했는지 모른다. 공개 조회처는 그것을 본다.
#[tauri::command]
pub async fn refund_payer(address: String) -> Result<Value, String> {
    // 주문 주소로 들어온 **첫 거래**를 찾는다. 주문마다 주소가 따로 생기므로
    // 그 주소의 거래는 곧 그 주문의 결제다.
    let txid = match crate::raven::call_rpc(
        "getaddresstxids",
        json!([{ "addresses": [address.clone()] }]),
    )
    .await
    {
        Ok(v) => v
            .as_array()
            .and_then(|a| a.first())
            .and_then(Value::as_str)
            .map(str::to_string),
        Err(_) => None,
    };
    let txid = match txid {
        Some(t) => t,
        None => {
            // 노드에 주소 색인이 없다. 공개 조회처가 거래 목록을 안다.
            let v = crate::publicbook::address(&address).await?;
            match v
                .get("utxos")
                .and_then(Value::as_array)
                .and_then(|a| a.first())
                .and_then(|u| u.get("txid"))
                .and_then(Value::as_str)
            {
                Some(t) => t.to_string(),
                None => return Ok(json!({ "address": null, "source": "찾지 못함" })),
            }
        }
    };
    refund_payer_of_tx(txid).await
}

async fn refund_payer_of_tx(txid: String) -> Result<Value, String> {
    // ① 이 가게 노드에 그 거래가 있으면 거기서 읽는다.
    if let Ok(tx) = crate::raven::call_rpc("getrawtransaction", json!([txid.clone(), 1])).await {
        if let Some(vin) = tx.get("vin").and_then(Value::as_array).and_then(|v| v.first()) {
            let (Some(prev), Some(n)) = (
                vin.get("txid").and_then(Value::as_str),
                vin.get("vout").and_then(Value::as_u64),
            ) else {
                return Ok(json!({ "address": null, "source": "이 가게 서버" }));
            };
            if let Ok(p) = crate::raven::call_rpc("getrawtransaction", json!([prev, 1])).await {
                let a = p
                    .get("vout")
                    .and_then(Value::as_array)
                    .and_then(|v| v.get(n as usize))
                    .and_then(|o| o.get("scriptPubKey"))
                    .and_then(|s| s.get("addresses"))
                    .and_then(Value::as_array)
                    .and_then(|a| a.first())
                    .and_then(Value::as_str);
                if let Some(a) = a {
                    return Ok(json!({ "address": a, "source": "이 가게 서버" }));
                }
            }
        }
    }
    // ② 노드가 못 하면 공개 조회처. 프라이버시를 조금 내주고 답을 얻는다.
    let a = crate::publicbook::payer_of(&txid).await?;
    Ok(json!({ "address": a, "source": "공개 조회처" }))
}

#[cfg(test)]
mod staff_security_tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize,Ordering};
    fn address(byte:u8)->String {
        // Synthetic mainnet Base58Check fixture, no wallet or keys involved.
        use sha2::{Digest,Sha256};
        let mut bytes=vec![60];bytes.extend_from_slice(&[byte;20]);
        let hash=Sha256::digest(Sha256::digest(&bytes));bytes.extend_from_slice(&hash[..4]);
        let alphabet=b"123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
        let mut digits=vec![0u8];
        for byte in bytes {let mut carry=byte as u32;for d in &mut digits {carry+=(*d as u32)*256;*d=(carry%58) as u8;carry/=58;}while carry>0 {digits.push((carry%58) as u8);carry/=58;}}
        digits.into_iter().rev().map(|d|alphabet[d as usize] as char).collect()
    }
    fn sale(index:u8)->Value { json!({"kind":"sale","address":address(1),"txid":format!("{index:064x}"),"amount":100.0,"currency":"USD","rvn":100.0,"confirmations":1}) }
    fn store()->FileJournal { FileJournal(crate::paths::test_fixture_root().join(format!("refund-test-{:x}",rand::random::<u64>())).join("journal.json")) }
    struct Mock { verifies:AtomicUsize,pays:AtomicUsize,unknown:bool,bound:String,rate:f64,quote_currency:Option<String>,quote_missing:bool,audits:std::sync::Mutex<Vec<Value>>,audit_fail:bool,credits:AtomicUsize }
    impl Mock {fn new(unknown:bool)->Self{Self{verifies:AtomicUsize::new(0),pays:AtomicUsize::new(0),unknown,bound:address(2),rate:1.0,quote_currency:None,quote_missing:false,audits:std::sync::Mutex::new(Vec::new()),audit_fail:false,credits:AtomicUsize::new(0)}}}
    impl StaffBackend for Mock {
        fn audit(&self,to:&str,amount:f64,currency:&str,rvn:f64,rate:f64,reason:&str,txid:&str,now:i64)->Result<(),String> {
            self.audits.lock().unwrap().push(json!({"to":to,"amount":amount,"currency":currency,"rvn":rvn,"rate":rate,"reason":reason,"txid":txid,"now":now}));
            if self.audit_fail {Err("synthetic uncertain audit write".into())}else{Ok(())}
        }
        fn quote<'a>(&'a self,currency:&'a str)->RefundFuture<'a,Value>{Box::pin(async move {if self.quote_missing {return Err("synthetic missing quote".into());}Ok(json!({"rate":self.rate,"currency":self.quote_currency.as_deref().unwrap_or(currency)}))})}
        fn verify<'a>(&'a self,_sale:&'a Value,to:&'a str)->RefundFuture<'a,()> {Box::pin(async move {self.verifies.fetch_add(1,Ordering::SeqCst);if to!=self.bound {return Err("recipient mismatch".into());}Ok(())})}
        fn pay<'a>(&'a self,to:&'a str,rvn:f64,_reason:&'a str,_pass:Option<String>)->RefundFuture<'a,Value>{Box::pin(async move{
            self.pays.fetch_add(1,Ordering::SeqCst);tokio::task::yield_now().await;
            if self.unknown{return Err(format!("{}synthetic timeout",crate::raven::SENT_UNKNOWN));}
            self.credits.fetch_add(1,Ordering::SeqCst);
            Ok(json!({"txid":"a".repeat(64),"to":to,"amount":rvn}))
        })}
    }
    struct FailStore {file:FileJournal,saves:AtomicUsize,fail_at:usize}
    impl JournalStore for FailStore {
        fn load(&self)->Result<RefundJournal,String>{self.file.load()}
        fn save(&self,j:&RefundJournal)->Result<(),String>{if self.saves.fetch_add(1,Ordering::SeqCst)+1==self.fail_at{Err("synthetic storage failure".into())}else{self.file.save(j)}}
    }
    async fn send(store:&impl JournalStore,node:&Mock,sale:&Value,to:&str,amount:f64,id:u8)->Result<Value,RefundFailure>{
        staff_refund_with(store,node,sale,to,amount,"synthetic",1_800_000_000,None,&format!("{id:032x}"),25.0,80.0,"USD").await
    }
    #[tokio::test]
    async fn current_quote_preserves_entered_fiat_and_actual_sent_rvn() {
        for (rate, expected) in [(4.0, 5.0), (0.25, 80.0)] {
            let file=store();let mut node=Mock::new(false);node.rate=rate;
            let out=send(&file,&node,&sale(1),&address(2),20.0,1).await.unwrap();
            assert_eq!(out["result"]["amount"],json!(expected),"20 USD must use the current mocked USD/RVN quote");
            assert_eq!(out["rvn"],json!(expected));
            assert_eq!(out["amount"],json!(20.0));assert_eq!(out["currency"],"USD");
            assert_eq!(out["left"],json!(60.0));assert_eq!(node.pays.load(Ordering::SeqCst),1);
            assert_eq!(out["rate"],json!(rate));
            let journal=file.load().unwrap();let reservation=&journal.reservations[0];
            assert_eq!(reservation.amount,20.0);assert_eq!(reservation.currency,"USD");assert_eq!(reservation.rate,Some(rate));assert_eq!(reservation.sats,(expected*1e8) as u64);
            let audits=node.audits.lock().unwrap();assert_eq!(audits.len(),1);assert_eq!(audits[0]["amount"],20.0);assert_eq!(audits[0]["rate"],rate);assert_eq!(audits[0]["rvn"],expected);assert_eq!(audits[0]["currency"],"USD");
        }
    }
    #[tokio::test]
    async fn invalid_missing_or_wrong_currency_quote_never_sends() {
        for rate in [0.0,-1.0,f64::NAN,f64::INFINITY,f64::NEG_INFINITY] {
            let file=store();let mut node=Mock::new(false);node.rate=rate;
            assert!(send(&file,&node,&sale(1),&address(2),20.0,1).await.is_err());
            assert_eq!(node.pays.load(Ordering::SeqCst),0);assert_eq!(node.verifies.load(Ordering::SeqCst),0);
            assert!(file.load().unwrap().reservations.is_empty());
        }
        for missing in [true,false] {
            let mut node=Mock::new(false);node.quote_missing=missing;node.quote_currency=Some("KRW".into());
            assert!(send(&store(),&node,&sale(1),&address(2),20.0,1).await.is_err());assert_eq!(node.pays.load(Ordering::SeqCst),0);
        }
        assert!(LocalStaffBackend.quote("USD").await.is_err(),"lib tests must not fetch live prices");
    }
    #[tokio::test]
    async fn current_quotes_keep_both_original_payment_caps_across_price_changes() {
        // Falling prices exhaust RVN while fiat remains; rising prices exhaust
        // fiat while original RVN remains. Neither cap resets after restart.
        let file=store();let mut node=Mock::new(false);let mut original=sale(1);original["rvn"]=json!(25.0);
        node.rate=2.0;assert!(send(&file,&node,&original,&address(2),20.0,1).await.is_ok()); // 10 RVN
        node.rate=1.0;assert!(send(&FileJournal(file.0.clone()),&node,&original,&address(2),20.0,2).await.is_err()); // 30 > 25 RVN
        assert_eq!(node.pays.load(Ordering::SeqCst),1);
        let file=store();original["amount"]=json!(30.0);original["rvn"]=json!(100.0);
        node.rate=4.0;assert!(send(&file,&node,&original,&address(2),20.0,3).await.is_ok());
        node.rate=8.0;assert!(send(&FileJournal(file.0.clone()),&node,&original,&address(2),20.0,4).await.is_err()); // 40 > 30 USD
        assert!(send(&file,&node,&original,&address(2),10.0,5).await.is_ok());
        assert_eq!(node.pays.load(Ordering::SeqCst),3);
    }
    #[tokio::test]
    async fn cancelled_same_intent_can_correct_with_fresh_id_and_pay_exactly_once() {
        let file=store();let node=Mock::new(false);let original=sale(1);let wrong=address(3);let to=address(2);
        let first=send(&file,&node,&original,&wrong,20.0,1).await.unwrap_err().body();
        assert_eq!(first["refund_outcome"],"not_sent");assert_eq!(first["request_id"],format!("{:032x}",1));
        assert_eq!(first["request"]["to"],wrong);assert_eq!(first["request"]["amount"],20.0);
        assert_eq!(file.load().unwrap().reservations[0].state,"cancelled");assert_eq!(used_usd(&file.load().unwrap(),today(1_800_000_000)),0.0);
        assert_eq!(send(&FileJournal(file.0.clone()),&node,&original,&wrong,20.0,1).await.unwrap_err().body()["refund_outcome"],"not_sent");
        assert_eq!(send(&file,&node,&original,&to,20.0,1).await.unwrap_err().body()["refund_outcome"],"unresolved","edited retry is not the cancelled intent");
        assert!(send(&file,&node,&original,&to,20.0,2).await.is_ok());
        assert_eq!(send(&file,&node,&original,&to,20.0,2).await.unwrap_err().body()["refund_outcome"],"unresolved");
        assert_eq!(node.pays.load(Ordering::SeqCst),1);assert_eq!(node.credits.load(Ordering::SeqCst),1);assert_eq!(node.audits.lock().unwrap().len(),1);
    }
    #[tokio::test]
    async fn uncertain_or_unreadable_prior_id_wins_over_edited_invalid_retry() {
        let file=store();let mut node=Mock::new(true);let original=sale(1);
        assert_eq!(send(&file,&node,&original,&address(2),20.0,1).await.unwrap_err().body()["refund_outcome"],"unresolved");
        node.unknown=false;node.rate=f64::NAN;
        for (to,amount) in [(address(3),21.0),("bad".into(),f64::NAN),(address(2),-1.0)] {
            let err=send(&FileJournal(file.0.clone()),&node,&json!({}),&to,amount,1).await.unwrap_err();
            assert!(err.contains("이미 환불 기록"));assert_eq!(err.body()["refund_outcome"],"unresolved");
        }
        assert_eq!(node.pays.load(Ordering::SeqCst),1);assert_eq!(file.load().unwrap().reservations[0].state,"dispatching");
        std::fs::write(&file.0,b"synthetic unreadable journal").unwrap();
        assert_eq!(send(&file,&node,&original,&address(3),20.0,1).await.unwrap_err().body()["refund_outcome"],"unresolved");
        assert_eq!(node.pays.load(Ordering::SeqCst),1);
    }
    #[tokio::test]
    async fn cancellation_storage_and_audit_failures_never_authorize_fresh_intent() {
        for fail_at in [1,2,3] {
            let file=FailStore{file:store(),saves:AtomicUsize::new(0),fail_at};let node=Mock::new(false);
            let to=if fail_at==2{address(3)}else{address(2)};
            assert_eq!(send(&file,&node,&sale(1),&to,20.0,1).await.unwrap_err().body()["refund_outcome"],"unresolved");
            assert_eq!(node.pays.load(Ordering::SeqCst),if fail_at==3{1}else{0});
            if fail_at>1 {
                assert_eq!(send(&FileJournal(file.file.0.clone()),&node,&json!({}),"bad",f64::NAN,1).await.unwrap_err().body()["refund_outcome"],"unresolved");
            }
        }
        let file=store();let mut node=Mock::new(false);node.audit_fail=true;
        assert!(send(&file,&node,&sale(1),&address(2),20.0,1).await.unwrap_err().starts_with(crate::raven::SENT_UNKNOWN));
        assert_eq!(file.load().unwrap().reservations[0].state,"complete");
        assert_eq!(send(&file,&node,&json!({}),"bad",f64::NAN,1).await.unwrap_err().body()["refund_outcome"],"unresolved");
        assert_eq!(node.pays.load(Ordering::SeqCst),1);assert_eq!(node.credits.load(Ordering::SeqCst),1);assert_eq!(node.audits.lock().unwrap().len(),1);
    }
    #[tokio::test]
    async fn durable_budget_serializes_races_and_survives_restart() {
        let store=store();let node=Mock::new(false);let to=address(2);
        let a=sale(1);let b=sale(2);let c=sale(3);let d=sale(4);
        let results=tokio::join!(send(&store,&node,&a,&to,25.0,1),send(&store,&node,&b,&to,25.0,2),send(&store,&node,&c,&to,25.0,3),send(&store,&node,&d,&to,25.0,4));
        assert_eq!([results.0,results.1,results.2,results.3].iter().filter(|r|r.is_ok()).count(),3);
        assert_eq!(node.pays.load(Ordering::SeqCst),3);
        let restarted=FileJournal(store.0.clone());
        assert_eq!(used_usd(&restarted.load().unwrap(),today(1_800_000_000)),75.0);
        assert!(send(&restarted,&node,&sale(5),&to,10.0,5).await.is_err());
        assert_eq!(node.pays.load(Ordering::SeqCst),3);
    }
    #[tokio::test]
    async fn storage_failure_prevents_any_rpc_and_unknown_or_final_write_failure_never_retries() {
        let node=Mock::new(false);let to=address(2);let first=FailStore{file:store(),saves:AtomicUsize::new(0),fail_at:1};
        assert!(send(&first,&node,&sale(1),&to,20.0,1).await.is_err());
        assert_eq!(node.verifies.load(Ordering::SeqCst),0);assert_eq!(node.pays.load(Ordering::SeqCst),0);
        let failed_after_pay=FailStore{file:store(),saves:AtomicUsize::new(0),fail_at:3};
        assert!(send(&failed_after_pay,&node,&sale(1),&to,20.0,2).await.unwrap_err().starts_with(crate::raven::SENT_UNKNOWN));
        let restarted=FileJournal(failed_after_pay.file.0.clone());
        assert_eq!(restarted.load().unwrap().reservations[0].state,"dispatching");
        assert!(send(&restarted,&node,&sale(1),&to,20.0,3).await.is_err());assert_eq!(node.pays.load(Ordering::SeqCst),1);
        let unknown=Mock::new(true);let pending=store();
        assert!(send(&pending,&unknown,&sale(2),&to,20.0,4).await.unwrap_err().starts_with(crate::raven::SENT_UNKNOWN));
        let restarted=FileJournal(pending.0.clone());
        assert!(send(&restarted,&unknown,&sale(2),&address(3),20.0,5).await.is_err());
        assert_eq!(unknown.pays.load(Ordering::SeqCst),1);assert_eq!(used_usd(&restarted.load().unwrap(),today(1_800_000_000)),20.0);
    }
    #[tokio::test]
    async fn request_original_payment_remaining_amount_and_recipient_are_bound() {
        let store=store();let mut node=Mock::new(false);node.rate=10.0;let to=address(2);let mut original=sale(1);original["amount"]=json!(30.0);original["rvn"]=json!(3.0);
        assert!(send(&store,&node,&original,&address(3),20.0,1).await.is_err());assert_eq!(node.pays.load(Ordering::SeqCst),0);
        assert!(send(&store,&node,&original,&to,20.0,2).await.is_ok());
        assert!(send(&store,&node,&original,&to,20.0,2).await.is_err());
        assert!(send(&store,&node,&original,&to,20.0,3).await.is_err());
        assert!(send(&store,&node,&original,&to,10.0,4).await.is_ok());assert_eq!(node.pays.load(Ordering::SeqCst),2);
        assert!(send(&store,&node,&original,&to,f64::NAN,5).await.is_err());
        assert!(send(&store,&node,&original,&to,f64::INFINITY,6).await.is_err());
    }
    #[test]
    fn payer_proof_rejects_wrong_order_multi_address_and_changed_original_transaction() {
        let sale=sale(1);let to=address(2);let prev="b".repeat(64);
        let payment=json!({"txid":sale["txid"],"vin":[{"txid":prev,"vout":0}],"vout":[{"value":100.0,"scriptPubKey":{"addresses":[sale["address"]]}}]});
        let mut previous=std::collections::HashMap::from([(prev.clone(),json!({"vout":[{"scriptPubKey":{"addresses":[to]}}]}))]);
        assert!(verify_payer(&sale,&payment,&previous,&to).is_ok());
        assert!(verify_payer(&sale,&payment,&previous,&address(3)).is_err());
        previous.get_mut(&prev).unwrap()["vout"][0]["scriptPubKey"]["addresses"]=json!([to,address(3)]);
        assert!(verify_payer(&sale,&payment,&previous,&to).is_err());
        let mut bad=payment.clone();bad["txid"]=json!("c".repeat(64));assert!(verify_payer(&sale,&bad,&previous,&to).is_err());
        let mut bad=payment.clone();bad["vout"][0]["scriptPubKey"]["addresses"]=json!([address(9)]);assert!(verify_payer(&sale,&bad,&previous,&to).is_err());
    }
}
