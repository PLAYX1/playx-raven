//! 보내기 확인 화면의 **수수료 한 줄**(0.4.8-B · RV3 🔴6).
//!
//! ## 🔴 왜 생겼나
//!
//! 보내기 확인 화면에 수수료가 없었다. `preview_send` 는 누구에게·무엇을·얼마만
//! 돌려주고, 수수료는 보낸 뒤 거래 목록에서야 보였다. 처음 쓰는 사람은 「10 RVN
//! 보냈는데 왜 10.002 가 빠졌지」를 겪는다(RV3 T05).
//!
//! ## 어떻게 — 노드에게 「이대로 보내면 수수료가 얼마냐」만 묻는다
//!
//! `createrawtransaction`(받는 곳·금액만 적은 빈 거래) → `fundrawtransaction`
//! (노드 지갑이 동전을 고르고 수수료를 계산해 채운 거래). 여기서 **수수료 숫자만**
//! 가져오고 거래는 버린다.
//!
//! 🔴 **서명하지 않고 퍼뜨리지 않는다.** `signrawtransaction`·`sendrawtransaction`·
//!    `walletpassphrase` 를 부르는 줄이 이 파일에 없고, 아래 시험이 그걸 못 박는다.
//!    채운 거래(hex)는 화면으로도 돌려주지 않는다 — 누가 그걸 이어서 서명·전파할
//!    길을 아예 만들지 않는다.
//! 🔴 **지갑을 열지 않는다.** `fundrawtransaction` 은 서명을 안 하므로 잠긴 지갑에서도
//!    된다. 거스름 자리에는 이 지갑의 받기 주소 하나를 넣는다 — 안 넣으면 노드가
//!    키풀에서 새 열쇠를 하나 「써 버린다」(돈은 안 움직이지만 확인할 때마다 주소 번호가
//!    하나씩 넘어간다). 서명도 전파도 안 하는 거래라 어느 주소든 크기(=수수료)는 같다.
//! 🔴 **동전을 잠그지 않는다**(`lockUnspents: false`). 잠그면 확인만 하고 그만둔 사람의
//!    돈이 노드를 다시 켤 때까지 안 쓰인다.
//!
//! ## 정직하게
//!
//! 실제로 보낼 때(`sendtoaddress`) 노드는 동전을 **다시** 고른다. 같은 계산이라 대개
//! 같지만 동전이 여럿이면 아주 조금 다를 수 있다 — 화면이 그렇게 말한다. 못 구하면
//! 지어내지 않고 「노드가 정해요(보통 0.01 RVN 안팎)」로 물러선다(화면 쪽).
//!
//! 자산 보내기의 수수료는 여기서 묻지 않는다(자산 출력은 `fundrawtransaction` 으로
//! 채울 수 없다). 화면이 「노드가 정해요」로 말한다.

use serde_json::{json, Value};
use std::future::Future;

/// 이 파일이 노드에 부르는 명령 — **전부 읽기(또는 서명 없는 조립)**다.
pub(crate) const CALLS: &[&str] = &["listreceivedbyaddress", "createrawtransaction", "fundrawtransaction"];

/// 1억분의 1 RVN 자리에서 자른다. 노드도 그 아래는 없다.
fn round8(v: f64) -> f64 {
    (v * 1e8).round() / 1e8
}

/// 거스름 자리에 넣을 이 지갑의 주소 하나. 노드가 준 목록에서 첫 줄.
///
/// `listreceivedbyaddress` 는 감시 주소를 빼고(include_watchonly 기본 끔) 이 지갑이
/// 쓸 수 있는 주소만 준다. 없으면 `None` — 그때는 노드가 키풀에서 고른다.
pub fn change_from(list: &Value) -> Option<String> {
    list.as_array()?
        .iter()
        .filter_map(|r| r.get("address").and_then(Value::as_str))
        .map(str::trim)
        .find(|a| !a.is_empty())
        .map(str::to_string)
}

/// 노드의 「모자라요」를 알아본다. 그때는 수수료 대신 「모자람」을 알린다.
fn is_short(e: &str) -> bool {
    let l = e.to_lowercase();
    l.contains("insufficient funds") || l.contains("insufficient balance")
}

/// 수수료를 계산한다. `rpc` 는 노드 부름(시험에서는 가짜).
pub async fn estimate_with<R, F>(rpc: R, address: &str, amount: f64) -> Result<Value, String>
where
    R: Fn(&'static str, Value) -> F,
    F: Future<Output = Result<Value, String>>,
{
    let address = address.trim();
    if address.is_empty() || address.len() > 120 || address.chars().any(char::is_whitespace) {
        return Err("받는 주소를 확인해 주세요.".into());
    }
    if !amount.is_finite() || amount <= 0.0 {
        return Err("금액은 0보다 커야 합니다.".into());
    }
    // 숫자 대신 글자로 넘긴다 — 0.1 같은 값이 0.1000000000000000055… 로 번지지 않게.
    let amt = format!("{:.8}", round8(amount));

    let change = rpc("listreceivedbyaddress", json!([0, true])).await.ok().as_ref().and_then(change_from);

    let mut outs = serde_json::Map::new();
    outs.insert(address.to_string(), json!(amt));
    let raw = rpc("createrawtransaction", json!([[], Value::Object(outs)])).await?;
    let raw = raw.as_str().unwrap_or_default().to_string();
    if raw.is_empty() {
        return Err("노드가 거래를 조립하지 못했어요.".into());
    }

    let mut opts = json!({ "lockUnspents": false });
    if let Some(c) = change {
        opts["changeAddress"] = json!(c);
    }
    let funded = match rpc("fundrawtransaction", json!([raw, opts])).await {
        Ok(v) => v,
        // 모자라면 오류가 아니라 **답**이다 — 화면이 「수수료까지 합치면 모자라요」라고 말한다.
        Err(e) if is_short(&e) => return Ok(json!({ "fee": null, "short": true, "amount": round8(amount) })),
        Err(e) => return Err(e),
    };
    let fee = funded
        .get("fee")
        .and_then(Value::as_f64)
        .filter(|f| f.is_finite() && *f >= 0.0)
        .ok_or_else(|| "노드가 수수료를 알려 주지 않았어요.".to_string())?;
    // 🔴 채운 거래(hex)는 돌려주지 않는다. 수수료 숫자만.
    Ok(json!({
        "fee": round8(fee),
        "amount": round8(amount),
        "total": round8(amount + fee),
        "short": false,
    }))
}

/// RVN 보내기의 수수료만 노드에 묻는다. **서명·전파·잠금 해제 없음.**
#[tauri::command]
pub async fn send_fee(address: String, amount: f64) -> Result<Value, String> {
    estimate_with(|m, p| crate::raven::call_rpc(m, p), &address, amount).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};

    // 🔴 시험 주소는 누가 봐도 가짜다. 진짜 지갑의 주소를 넣지 않는다.
    const TO: &str = "RTestRecipientAAAAAAAAAAAAAAAAAAAA";
    const MINE: &str = "RTestMineBBBBBBBBBBBBBBBBBBBBBBBBB";

    /// 부른 명령을 적어 두는 가짜 노드. 보내는·서명하는·여는 명령이 오면 그 자리에서 실패한다.
    fn fake(log: Arc<Mutex<Vec<(String, Value)>>>, fund: Result<Value, String>) -> impl Fn(&'static str, Value) -> std::future::Ready<Result<Value, String>> {
        move |m, p| {
            log.lock().unwrap().push((m.to_string(), p.clone()));
            assert!(
                !["signrawtransaction", "signrawtransactionwithwallet", "sendrawtransaction", "sendtoaddress",
                  "sendmany", "walletpassphrase", "lockunspent", "transfer"].contains(&m),
                "수수료 계산이 {m} 를 불렀다"
            );
            std::future::ready(match m {
                "listreceivedbyaddress" => Ok(json!([{ "address": MINE, "account": "", "amount": 0.0, "confirmations": 0, "txids": [] }])),
                "createrawtransaction" => Ok(json!("0200000000010000000000")),
                "fundrawtransaction" => fund.clone(),
                other => panic!("모르는 부름: {other}"),
            })
        }
    }

    #[tokio::test]
    async fn 수수료만_가져오고_서명도_전파도_안_한다() {
        let log = Arc::new(Mutex::new(Vec::new()));
        let rpc = fake(log.clone(), Ok(json!({ "hex": "02000000fundedhex", "fee": 0.00226, "changepos": 1 })));
        let v = estimate_with(rpc, TO, 1.0).await.unwrap();
        assert_eq!(v["fee"], json!(0.00226));
        assert_eq!(v["total"], json!(1.00226));
        assert_eq!(v["short"], json!(false));
        // 채운 거래는 화면으로 안 간다.
        assert!(v.get("hex").is_none(), "채운 거래가 새어 나갔다");
        assert!(!v.to_string().contains("fundedhex"));

        let calls = log.lock().unwrap().clone();
        let names: Vec<&str> = calls.iter().map(|(m, _)| m.as_str()).collect();
        assert_eq!(names, ["listreceivedbyaddress", "createrawtransaction", "fundrawtransaction"]);
        for (m, _) in &calls {
            assert!(!crate::raven::is_send_method(m), "{m} 는 보내는 명령이다");
        }
        // 빈 입력 · 받는 곳 하나 · 금액은 8자리 글자.
        assert_eq!(calls[1].1, json!([[], { TO: "1.00000000" }]));
        // 동전을 잠그지 않고, 거스름은 이 지갑 주소(키풀을 쓰지 않게).
        assert_eq!(calls[2].1[0], json!("0200000000010000000000"));
        assert_eq!(calls[2].1[1]["lockUnspents"], json!(false));
        assert_eq!(calls[2].1[1]["changeAddress"], json!(MINE));
    }

    #[tokio::test]
    async fn 모자라면_수수료_대신_모자람을_알린다() {
        let log = Arc::new(Mutex::new(Vec::new()));
        let rpc = fake(log, Err("Insufficient funds".into()));
        let v = estimate_with(rpc, TO, 50.0).await.unwrap();
        assert_eq!(v["short"], json!(true));
        assert!(v["fee"].is_null());
    }

    #[tokio::test]
    async fn 다른_오류는_지어내지_않고_그대로_돌려준다() {
        let log = Arc::new(Mutex::new(Vec::new()));
        let rpc = fake(log, Err("Invalid Raven address".into()));
        assert!(estimate_with(rpc, TO, 1.0).await.is_err());
        let log = Arc::new(Mutex::new(Vec::new()));
        let rpc = fake(log, Ok(json!({ "hex": "02" })));
        assert!(estimate_with(rpc, TO, 1.0).await.is_err(), "수수료가 없는 답을 0 으로 읽으면 안 된다");
    }

    #[tokio::test]
    async fn 빈_주소와_0_이하_금액은_노드에_묻지도_않는다() {
        for (addr, amt) in [("", 1.0), ("R a", 1.0), (TO, 0.0), (TO, -1.0), (TO, f64::NAN)] {
            let log = Arc::new(Mutex::new(Vec::new()));
            let rpc = fake(log.clone(), Ok(json!({ "fee": 0.001 })));
            assert!(estimate_with(rpc, addr, amt).await.is_err());
            assert!(log.lock().unwrap().is_empty(), "{addr} {amt}");
        }
    }

    #[test]
    fn 거스름은_이_지갑_주소_하나() {
        assert_eq!(change_from(&json!([{ "address": "" }, { "address": MINE }])), Some(MINE.into()));
        assert_eq!(change_from(&json!([])), None);
        assert_eq!(change_from(&json!(null)), None);
    }

    /// 🔴 이 파일은 서명·전파·잠금 해제를 하지 않는다. 누가 나중에 한 줄 끼워 넣으면 여기서 깨진다.
    #[test]
    fn 서명_전파_잠금해제_부름이_없다() {
        let src = include_str!("sendfee.rs");
        let body = &src[..src.find("#[cfg(test)]").unwrap()];
        for (i, _) in body.match_indices("rpc(\"") {
            let m = &body[i + 5..];
            let m = &m[..m.find('"').unwrap()];
            assert!(CALLS.contains(&m), "허락하지 않은 부름: {m}");
        }
        for m in CALLS {
            assert!(!crate::raven::is_send_method(m), "{m}");
        }
        let code: String = body.lines().filter(|l| !l.trim_start().starts_with("//")).collect::<Vec<_>>().join("\n");
        for bad in ["signrawtransaction", "sendrawtransaction", "sendtoaddress", "walletpassphrase", "lockunspent", "\"transfer\""] {
            assert!(!code.contains(bad), "{bad} 가 코드에 있다");
        }
    }
}
