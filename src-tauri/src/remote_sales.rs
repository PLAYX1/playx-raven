//! Remote completion is an outbox operation: it never invokes a payment RPC.
use crate::{payout_guard, raven::call_rpc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
static GATE: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
const ENDPOINT: &str = "https://rvn.ex.erci.se/api/rvn/deliveries";
#[derive(Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Order {
    pub id: String,
    pub asset: String,
    pub qty: f64,
    pub to: String,
    pub order_addr: String,
    pub paid_rvn: f64,
    pub payment_txid: String,
    pub payment_vout: u32,
}
#[derive(Serialize, Deserialize)]
struct Record {
    order: Order,
    state: String,
    txid: Option<String>,
}
fn path(root: &Path, id: &str) -> PathBuf {
    root.join(format!(
        "{}.json",
        hex::encode(Sha256::digest(id.as_bytes()))
    ))
}
fn save(root: &Path, r: &Record) -> Result<(), String> {
    payout_guard::atomic_write(
        &path(root, &r.order.id),
        &serde_json::to_vec(r).map_err(|_| "주문 기록 오류")?,
    )
}
fn load(root: &Path, id: &str) -> Result<Option<Record>, String> {
    match std::fs::read(path(root, id)) {
        Ok(b) => serde_json::from_slice(&b)
            .map(Some)
            .map_err(|_| "주문 기록 손상: 전달 중단".into()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(_) => Err("주문 기록 읽기 실패".into()),
    }
}
fn bind(root: &Path, o: &Order) -> Result<(Record, bool), String> {
    if o.id.is_empty()
        || o.id.len() > 128
        || o.asset.is_empty()
        || o.asset.ends_with('!')
        || !o.qty.is_finite()
        || o.qty <= 0.0
        || !o.paid_rvn.is_finite()
        || o.paid_rvn <= 0.0
        || o.order_addr.is_empty()
        || o.to.is_empty()
        || o.payment_txid.len() != 64
        || !o.payment_txid.bytes().all(|b| b.is_ascii_hexdigit())
    {
        return Err("주문 결제 증빙이 없습니다.".into());
    }
    if let Some(r) = load(root, &o.id)? {
        if r.order != *o {
            return Err("고정된 주문 조건과 다릅니다.".into());
        }
        return Ok((r, false));
    }
    let binding = root.join("outpoints").join(format!(
        "{}-{}.binding",
        o.payment_txid.to_lowercase(),
        o.payment_vout
    ));
    match std::fs::read(&binding) {
        Ok(id) if id == o.id.as_bytes() => {}
        Ok(_) => return Err("이미 다른 주문에 고정된 결제 출력입니다.".into()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            payout_guard::atomic_write(&binding, o.id.as_bytes())?
        }
        Err(_) => return Err("결제 출력 결합 기록 오류".into()),
    }
    let r = Record {
        order: o.clone(),
        state: "prepared".into(),
        txid: None,
    };
    save(root, &r)?;
    Ok((r, true))
}
// Exact same intent as fulfil_sale; one outpoint cannot buy twice through another order ID.
fn receipt(payouts: &Path, o: &Order) -> Result<Option<String>, String> {
    let id = format!("{}-{}", o.payment_txid.to_lowercase(), o.payment_vout);
    let intent = serde_json::to_vec(&json!([
        o.order_addr,
        o.payment_txid,
        o.payment_vout,
        o.paid_rvn,
        o.asset,
        o.qty,
        o.to
    ]))
    .map_err(|_| "주문 기록 오류")?;
    payout_guard::receipt(payouts, "sale", &id, &intent)
}
fn recover(root: &Path, payouts: &Path, r: &mut Record) -> Result<(), String> {
    if r.txid.is_none() {
        if let Some(txid) = receipt(payouts, &r.order)? {
            r.txid = Some(txid);
            r.state = "completion_pending".into();
            save(root, r)?;
        }
    }
    Ok(())
}
/// Only single-owner payment inputs are accepted. Exchange/shared-wallet or alternate
/// recipient orders need a future authenticated recipient proof, never a server assertion.
async fn verify_recipient(o: &Order) -> Result<(), String> {
    let wallet = call_rpc("gettransaction", json!([o.payment_txid])).await?;
    if wallet["confirmations"].as_i64().unwrap_or(0) < 1
        || wallet["abandoned"] == true
        || !wallet["details"].as_array().is_some_and(|rows| {
            rows.iter().any(|r| {
                r["category"] == "receive"
                    && r["address"] == o.order_addr
                    && r["vout"].as_u64() == Some(o.payment_vout as u64)
                    && r["asset_name"].is_null()
                    && r["amount"].as_f64() == Some(o.paid_rvn)
            })
        })
    {
        return Err("확정 결제 출력이 주문과 다릅니다.".into());
    }

    let tx = call_rpc("getrawtransaction", json!([o.payment_txid, 1])).await?;
    if tx["txid"] != o.payment_txid {
        return Err("결제 거래 불일치".into());
    }
    let inputs = tx["vin"]
        .as_array()
        .filter(|v| !v.is_empty() && v.len() <= 128)
        .ok_or("결제 입력 증빙 없음")?;
    for input in inputs {
        let id = input["txid"]
            .as_str()
            .filter(|s| s.len() == 64 && s.bytes().all(|b| b.is_ascii_hexdigit()))
            .ok_or("결제 입력 오류")?;
        let n = input["vout"].as_u64().ok_or("결제 입력 오류")?;
        let prev = call_rpc("getrawtransaction", json!([id, 1])).await?;
        let output = prev["vout"]
            .as_array()
            .and_then(|v| v.iter().find(|v| v["n"].as_u64() == Some(n)))
            .ok_or("결제 입력 출력 없음")?;
        if prev["txid"] != id
            || output["scriptPubKey"]["type"] != "pubkeyhash"
            || output["scriptPubKey"]["addresses"] != json!([o.to])
        {
            return Err("결제 증빙과 수취 주소가 다릅니다.".into());
        }
    }
    Ok(())
}
pub async fn deliver(o: Order, passphrase: Option<String>) -> Result<String, String> {
    let _gate = GATE.lock().await;
    let root = crate::paths::app_file("remote-sales");
    std::fs::create_dir_all(&root).map_err(|_| "주문 폴더 오류")?;
    let _disk = payout_guard::ProcessLock::take(&root, "orders")?;
    // A re-query is resolved entirely from the pinned record/receipt, without transfer.
    if load(&root, &o.id)?.is_none() {
        verify_recipient(&o).await?;
    }
    let (mut r, fresh) = bind(&root, &o)?;
    recover(&root, &crate::paths::app_file("payouts"), &mut r)?;
    if let Some(txid) = r.txid {
        return Ok(txid);
    }
    if !fresh {
        return Err(
            "이 주문의 지급 결과가 미확인입니다. 재전달 금지: 거래 기록 확인이 필요합니다.".into(),
        );
    }
    let txid = crate::vending::fulfil_sale(
        o.asset,
        o.qty,
        o.to,
        passphrase,
        Some(o.paid_rvn),
        Some(o.order_addr),
        Some(o.payment_txid),
        Some(o.payment_vout),
    )
    .await?;
    r.txid = Some(txid.clone());
    r.state = "completion_pending".into();
    save(&root, &r)?;
    Ok(txid)
}
#[tauri::command]
pub async fn deliver_remote_sale(
    order: Order,
    passphrase: Option<String>,
) -> Result<String, String> {
    deliver(order, passphrase).await
}
#[tauri::command]
pub async fn retry_remote_completions(token: String) -> Result<Value, String> {
    let _gate = GATE.lock().await;
    let root = crate::paths::app_file("remote-sales");
    std::fs::create_dir_all(&root).map_err(|_| "주문 폴더 오류")?;
    let _disk = payout_guard::ProcessLock::take(&root, "orders")?;
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| "완료 기록 연결 오류")?;
    flush(&root, &crate::paths::app_file("payouts"), |order, txid| {
        let client = &client;
        let token = &token;
        async move {
            match client
                .post(ENDPOINT)
                .header("x-rvn-delivery-token", token)
                .json(&json!({"id":order.id,"txid":txid}))
                .send()
                .await
            {
                Ok(response) if response.status().is_success() => response
                    .json::<Value>()
                    .await
                    .is_ok_and(|v| v["ok"] == true),
                _ => false,
            }
        }
    })
    .await
}
async fn flush<F, Fut>(root: &Path, payouts: &Path, mut post: F) -> Result<Value, String>
where
    F: FnMut(Order, String) -> Fut,
    Fut: std::future::Future<Output = bool>,
{
    let mut pending = 0;
    let mut completed = 0;
    for entry in std::fs::read_dir(&root).map_err(|_| "주문 목록 오류")? {
        let file = entry.map_err(|_| "주문 목록 오류")?.path();
        if file.extension().and_then(|s| s.to_str()) != Some("json") {
            continue;
        }
        let mut r: Record =
            serde_json::from_slice(&std::fs::read(file).map_err(|_| "주문 읽기 오류")?)
                .map_err(|_| "주문 기록 손상")?;
        recover(root, payouts, &mut r)?;
        if r.state == "completed" {
            continue;
        }
        let Some(ref txid) = r.txid else {
            pending += 1;
            continue;
        };
        let ok = post(r.order.clone(), txid.clone()).await;
        if ok {
            r.state = "completed".into();
            save(&root, &r)?;
            completed += 1;
        } else {
            pending += 1;
        }
    }
    Ok(json!({"pending":pending,"completed":completed}))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn order() -> Order {
        Order {
            id: "remote-1".into(),
            asset: "SYNTHETIC".into(),
            qty: 1.0,
            to: "recipient".into(),
            order_addr: "deposit".into(),
            paid_rvn: 2.0,
            payment_txid: "b".repeat(64),
            payment_vout: 0,
        }
    }
    #[tokio::test]
    async fn completion_failure_restart_requery_never_pays_again() {
        let root = std::env::temp_dir().join(format!("secfix2-outbox-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let orders = root.join("orders");
        let payouts = root.join("payouts");
        let o = order();
        let (mut r, fresh) = bind(&orders, &o).unwrap();
        assert!(fresh);
        let intent = serde_json::to_vec(&json!([
            o.order_addr,
            o.payment_txid,
            o.payment_vout,
            o.paid_rvn,
            o.asset,
            o.qty,
            o.to
        ]))
        .unwrap();
        let id = format!("{}-0", o.payment_txid);
        let payout_guard::Begin::New(g) =
            payout_guard::begin(&payouts, "sale", &id, &intent).unwrap()
        else {
            panic!()
        };
        // One accepted payment; crash before the outbox txid write.
        g.complete(&"a".repeat(64)).unwrap();
        recover(&orders, &payouts, &mut r).unwrap();
        let failed = flush(&orders, &payouts, |_, _| async { false })
            .await
            .unwrap();
        assert_eq!(failed["pending"], 1);
        drop(r);
        let (mut restarted, fresh) = bind(&orders, &o).unwrap();
        assert!(!fresh);
        recover(&orders, &payouts, &mut restarted).unwrap();
        assert!(restarted.txid.is_some());
        assert_eq!(
            flush(&orders, &payouts, |_, _| async { true })
                .await
                .unwrap()["completed"],
            1
        );
        assert_eq!(
            flush(&orders, &payouts, |_, _| async {
                panic!("completed outbox replay")
            })
            .await
            .unwrap()["completed"],
            0
        );
        let mut changed = o.clone();
        changed.to = "changed".into();
        assert!(bind(&orders, &changed).is_err());
        changed = o.clone();
        changed.payment_vout = 1;
        assert!(bind(&orders, &changed).is_err());
        changed = o.clone();
        changed.qty = 2.0;
        assert!(bind(&orders, &changed).is_err());
        changed = o;
        changed.id = "another-order".into();
        assert!(
            bind(&orders, &changed).is_err(),
            "payment outpoint cannot bind to a second order ID"
        );
        changed.to = "changed".into();
        assert!(receipt(&payouts, &changed).is_err());
        std::fs::remove_dir_all(root).unwrap();
    }
}

#[cfg(test)]
mod restart_tests {
    use super::*;
    #[test]
    fn child_stage() {
        let Ok(root) = std::env::var("SECFIX2_RESTART_ROOT") else {
            return;
        };
        let root = PathBuf::from(root);
        let orders = root.join("orders");
        let payouts = root.join("payouts");
        let _lock = payout_guard::ProcessLock::take(&orders, "orders").unwrap();
        let o = Order {
            id: "restart-order".into(),
            asset: "SYNTHETIC".into(),
            qty: 1.0,
            to: "recipient".into(),
            order_addr: "deposit".into(),
            paid_rvn: 2.0,
            payment_txid: "b".repeat(64),
            payment_vout: 0,
        };
        let (mut r, fresh) = bind(&orders, &o).unwrap();
        if std::env::var("SECFIX2_RESTART_STAGE").unwrap() == "pay" {
            assert!(fresh);
            let intent = serde_json::to_vec(&json!([
                o.order_addr,
                o.payment_txid,
                o.payment_vout,
                o.paid_rvn,
                o.asset,
                o.qty,
                o.to
            ]))
            .unwrap();
            let payout_guard::Begin::New(g) =
                payout_guard::begin(&payouts, "sale", &format!("{}-0", o.payment_txid), &intent)
                    .unwrap()
            else {
                panic!()
            };
            std::fs::write(root.join("calls.txt"), b"1").unwrap();
            g.complete(&"a".repeat(64)).unwrap();
            std::process::exit(0); // die before outbox write and without dropping the OS lock
        }
        assert!(!fresh);
        recover(&orders, &payouts, &mut r).unwrap();
        assert!(r.txid.is_some());
        let ok = std::env::var("SECFIX2_RESTART_STAGE").unwrap() == "complete";
        tokio::runtime::Runtime::new()
            .unwrap()
            .block_on(flush(&orders, &payouts, move |_, _| async move { ok }))
            .unwrap();
        assert_eq!(std::fs::read(root.join("calls.txt")).unwrap(), b"1");
    }
    #[test]
    fn process_death_then_failed_post_then_restart_and_requery() {
        let root = std::env::temp_dir().join(format!("secfix2-process-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        for stage in ["pay", "failed-post", "complete", "complete"] {
            let status = std::process::Command::new(std::env::current_exe().unwrap())
                .args(["--exact", "remote_sales::restart_tests::child_stage"])
                .env("SECFIX2_RESTART_ROOT", &root)
                .env("SECFIX2_RESTART_STAGE", stage)
                .output()
                .unwrap()
                .status;
            assert!(status.success(), "isolated restart stage failed");
        }
        std::fs::remove_dir_all(root).unwrap();
    }
}
