//! 지갑 화면 「받기」 — 누르면 바로 주소가 나오게(0.4.8-B · RV3 🔴5).
//!
//! ## 🔴 왜 생겼나
//!
//! 「받기」를 눌러도 주소가 안 나오고 「주소 만들기」를 또 눌러야 했고, 누를 때마다
//! **새 주소**가 나왔다(RV3 T03). 친구에게 주소를 알려 준 뒤 다시 들어와 보면 다른
//! 주소가 떠 있으니, 처음 쓰는 사람은 「아까 준 주소가 틀렸나」 한다.
//!
//! 그래서: 「받기」 전용으로 만든 주소 중 **아직 한 번도 받은 적 없는 것**을 다시 쓰고,
//! 없을 때만 새로 만든다. 「새 주소 만들기」는 따로 누를 때만.
//!
//! ## 🔴 왜 이름표(`rv-receive`)를 붙이나
//!
//! 이 지갑에는 이름 없이 만든 주소가 여럿 있다 — 맞교환 판매 대금(`swap.rs`),
//! 재발행 받을 곳(`issue2.rs`·`shopmove.rs`)… 아직 돈이 안 들어온 그 주소를 「받기」가
//! 집어 들면, 친구가 보낸 돈이 **팔린 값처럼** 보인다. 주문마다 만드는 `order`·`sell:`
//! 주소도 마찬가지다(주소가 곧 주문 번호다). 그래서 「받기」가 만든 주소에만 이름표를
//! 달고, **그 이름표가 붙은 것만** 다시 쓴다. 옛 판에서 이름 없이 만든 주소는 건드리지
//! 않는다 — 처음 한 번 새 주소가 하나 생길 뿐이다.
//!
//! ## 🔴 내 주소인지는 노드가 확인한 것만
//!
//! 보여 주기 직전에 `validateaddress` 로 **이 지갑이 쓸 수 있는 주소**(감시 주소 아님)인지
//! 다시 묻는다. 아니면 주소를 보여 주지 않고 오류를 낸다 — 남의 주소를 「내 받는
//! 주소」라고 보여 주는 것이 이 화면에서 제일 비싼 실수다.
//!
//! 여기서 부르는 노드 명령은 `listreceivedbyaddress`·`validateaddress`·`getnewaddress` 뿐이다.
//! 보내는 명령은 없다.

use serde_json::{json, Value};
use std::future::Future;

/// 「받기」가 만든 주소의 이름표. 사람이 붙일 리 없는 모양으로(주소록에서 숨긴다 — `addrbook.rs`).
pub const RECEIVE_LABEL: &str = "rv-receive";

/// 다시 쓸 후보를 이만큼만 확인한다. 보통 하나다.
const MAX_CANDIDATES: usize = 20;

/// 이 파일이 노드에 부르는 명령.
pub(crate) const CALLS: &[&str] = &["listreceivedbyaddress", "validateaddress", "getnewaddress"];

/// `listreceivedbyaddress 0 true` 에서 「받기」 이름표가 붙었고 **한 번도 안 받은** 주소.
///
/// 자산만 받은 주소는 RVN 금액이 0 이어도 `txids` 가 있다 — 그것도 「받은 것」이다.
pub fn unused_receive(list: &Value) -> Vec<String> {
    let mut out: Vec<String> = list
        .as_array()
        .map(|rows| {
            rows.iter()
                .filter(|r| {
                    let label = r.get("label").or_else(|| r.get("account")).and_then(Value::as_str).unwrap_or("");
                    let amount = r.get("amount").and_then(Value::as_f64).unwrap_or(1.0);
                    let txids = r.get("txids").and_then(Value::as_array).map(|t| t.len()).unwrap_or(1);
                    label == RECEIVE_LABEL && amount == 0.0 && txids == 0
                })
                .filter_map(|r| r.get("address").and_then(Value::as_str))
                .map(|a| a.trim().to_string())
                .filter(|a| !a.is_empty())
                .collect()
        })
        .unwrap_or_default();
    out.sort();
    out.dedup();
    out.truncate(MAX_CANDIDATES);
    out
}

/// 이 지갑이 쓸 수 있는 받기 주소인가(감시·거스름·남의 것은 아니다). 맞으면 받기 번호(있으면).
pub fn usable(v: &Value) -> Option<Option<u64>> {
    let verdict = crate::whose::judge(v);
    (verdict.state == "mine" && verdict.kind != Some("change")).then_some(verdict.index)
}

async fn checked<R, F>(rpc: &R, address: &str) -> Result<Option<u64>, String>
where
    R: Fn(&'static str, Value) -> F,
    F: Future<Output = Result<Value, String>>,
{
    let v = rpc("validateaddress", json!([address])).await?;
    usable(&v).ok_or_else(|| "노드가 이 주소를 이 지갑의 받는 주소로 확인해 주지 않았어요. 보여 드리지 않을게요.".to_string())
}

/// 받는 주소 하나. `fresh` 면 늘 새로 만든다.
pub async fn receive_with<R, F>(rpc: R, fresh: bool) -> Result<Value, String>
where
    R: Fn(&'static str, Value) -> F,
    F: Future<Output = Result<Value, String>>,
{
    if !fresh {
        let list = rpc("listreceivedbyaddress", json!([0, true])).await?;
        // 받기 번호가 가장 큰 것(= 가장 최근에 만든 것). 「새 주소 만들기」를 눌렀으면 그것이 나온다.
        let mut best: Option<(u64, String)> = None;
        for a in unused_receive(&list) {
            if let Ok(index) = checked(&rpc, &a).await {
                let n = index.unwrap_or(0);
                if best.as_ref().map_or(true, |(m, _)| n > *m) {
                    best = Some((n, a));
                }
            }
        }
        if let Some((_, address)) = best {
            return Ok(json!({ "address": address, "reused": true, "mine": true }));
        }
    }
    let made = rpc("getnewaddress", json!([RECEIVE_LABEL])).await?;
    let address = made.as_str().map(str::trim).unwrap_or_default().to_string();
    if address.is_empty() {
        return Err("주소를 만들지 못했습니다.".into());
    }
    checked(&rpc, &address).await?;
    Ok(json!({ "address": address, "reused": false, "mine": true }))
}

/// 지갑 화면 「받기」.
#[tauri::command]
pub async fn receive_address(fresh: Option<bool>) -> Result<Value, String> {
    receive_with(|m, p| crate::raven::call_rpc(m, p), fresh.unwrap_or(false)).await
}

/// 저장할 파일 이름을 정한다 — `.svg` 로만. 붙여서 바뀐 이름이 이미 있으면 덮어쓰지 않는다
/// (저장 창이 「덮어쓸까요」를 물은 것은 원래 이름이다).
pub fn svg_path(chosen: &str) -> Result<std::path::PathBuf, String> {
    let chosen = chosen.trim();
    if chosen.is_empty() || chosen.chars().any(char::is_control) {
        return Err("저장할 곳을 다시 골라 주세요.".into());
    }
    let p = std::path::PathBuf::from(chosen);
    let is_svg = p.extension().and_then(|e| e.to_str()).map_or(false, |e| e.eq_ignore_ascii_case("svg"));
    if is_svg {
        return Ok(p);
    }
    let with = std::path::PathBuf::from(format!("{chosen}.svg"));
    if with.exists() {
        return Err("같은 이름의 파일이 이미 있어요. 다른 이름으로 저장해 주세요.".into());
    }
    Ok(with)
}

/// 받는 주소 QR 을 그림(SVG)으로 저장한다. **이 지갑의 받는 주소만.**
///
/// 그림 내용은 화면이 주지 않는다 — 주소로 여기서 만든다. 화면이 넘기는 것은 주소와
/// 저장 창이 돌려준 자리뿐이다.
#[tauri::command]
pub async fn receive_qr_save(address: String, path: String) -> Result<Value, String> {
    let address = address.trim().to_string();
    let rpc = |m: &'static str, p: Value| crate::raven::call_rpc(m, p);
    checked(&rpc, &address).await?;
    let target = svg_path(&path)?;
    let svg = crate::server::qr_svg(address)?;
    std::fs::write(&target, svg).map_err(|e| format!("저장하지 못했습니다: {e}"))?;
    Ok(json!({ "path": target.to_string_lossy() }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};

    // 🔴 시험 주소는 누가 봐도 가짜다.
    const OLD: &str = "RTestReceiveOldAAAAAAAAAAAAAAAAAAA";
    const NEW: &str = "RTestReceiveNewBBBBBBBBBBBBBBBBBBB";
    const USED: &str = "RTestReceiveUsedCCCCCCCCCCCCCCCCCC";
    const ORDER: &str = "RTestOrderDDDDDDDDDDDDDDDDDDDDDDDD";
    const PLAIN: &str = "RTestSwapPayToEEEEEEEEEEEEEEEEEEEE";
    const ASSETONLY: &str = "RTestAssetOnlyFFFFFFFFFFFFFFFFFFFF";
    const MADE: &str = "RTestMadeNowGGGGGGGGGGGGGGGGGGGGGG";

    fn row(a: &str, label: &str, amount: f64, txids: usize) -> Value {
        json!({ "address": a, "account": label, "label": label, "amount": amount, "confirmations": 0,
                "txids": vec!["1".repeat(64); txids] })
    }
    fn book() -> Value {
        json!([
            row(OLD, RECEIVE_LABEL, 0.0, 0),
            row(NEW, RECEIVE_LABEL, 0.0, 0),
            row(USED, RECEIVE_LABEL, 10.0, 1),
            row(ASSETONLY, RECEIVE_LABEL, 0.0, 1),
            row(ORDER, "order", 0.0, 0),
            row(PLAIN, "", 0.0, 0),
        ])
    }
    fn va(path: Option<&str>, mine: bool, watch: bool) -> Value {
        let mut v = json!({ "isvalid": true, "ismine": mine, "iswatchonly": watch });
        if let Some(p) = path {
            v["hdkeypath"] = json!(p);
        }
        v
    }

    type Log = Arc<Mutex<Vec<String>>>;
    fn fake(log: Log, list: Value, valid: fn(&str) -> Value) -> impl Fn(&'static str, Value) -> std::future::Ready<Result<Value, String>> {
        move |m, p| {
            log.lock().unwrap().push(m.to_string());
            assert!(CALLS.contains(&m), "허락하지 않은 부름: {m}");
            std::future::ready(Ok(match m {
                "listreceivedbyaddress" => list.clone(),
                "validateaddress" => valid(p[0].as_str().unwrap()),
                "getnewaddress" => {
                    assert_eq!(p, json!([RECEIVE_LABEL]), "받기 주소는 이름표를 달고 만든다");
                    json!(MADE)
                }
                _ => unreachable!(),
            }))
        }
    }
    fn hd(a: &str) -> Value {
        match a {
            OLD => va(Some("m/44'/175'/0'/0/3"), true, false),
            NEW => va(Some("m/44'/175'/0'/0/9"), true, false),
            MADE => va(Some("m/44'/175'/0'/0/10"), true, false),
            _ => va(Some("m/44'/175'/0'/0/1"), true, false),
        }
    }

    #[test]
    fn 받기_이름표가_붙고_한_번도_안_받은_것만() {
        let got = unused_receive(&book());
        assert_eq!(got, vec![NEW.to_string(), OLD.to_string()]);
        for bad in [USED, ASSETONLY, ORDER, PLAIN] {
            assert!(!got.contains(&bad.to_string()), "{bad} 를 다시 쓰려 한다");
        }
    }

    #[tokio::test]
    async fn 안_받은_주소를_다시_쓰고_가장_최근_것을_고른다() {
        let log: Log = Arc::default();
        let v = receive_with(fake(log.clone(), book(), hd), false).await.unwrap();
        assert_eq!(v["address"], json!(NEW), "받기 번호 9 가 3 보다 최근이다");
        assert_eq!(v["reused"], json!(true));
        assert!(!log.lock().unwrap().contains(&"getnewaddress".to_string()), "있는데 또 만들었다");
    }

    #[tokio::test]
    async fn 없을_때만_새로_만든다() {
        let log: Log = Arc::default();
        let only_used = json!([row(USED, RECEIVE_LABEL, 10.0, 1), row(PLAIN, "", 0.0, 0), row(ORDER, "order", 0.0, 0)]);
        let v = receive_with(fake(log.clone(), only_used, hd), false).await.unwrap();
        assert_eq!(v["address"], json!(MADE));
        assert_eq!(v["reused"], json!(false));
        // 「새 주소 만들기」는 목록을 보지 않고 바로 만든다.
        let log: Log = Arc::default();
        let v = receive_with(fake(log.clone(), book(), hd), true).await.unwrap();
        assert_eq!(v["address"], json!(MADE));
        assert_eq!(*log.lock().unwrap(), ["getnewaddress", "validateaddress"]);
    }

    #[tokio::test]
    async fn 노드가_내_것이라_하지_않으면_보여_주지_않는다() {
        // 감시 주소 · 남의 주소 · 거스름 주소는 받기 주소로 쓰지 않는다.
        for valid in [
            (|_: &str| va(None, false, true)) as fn(&str) -> Value,
            |_: &str| va(None, false, false),
            |_: &str| va(Some("m/44'/175'/0'/1/33"), true, false),
            |_: &str| json!({ "isvalid": false }),
        ] {
            let log: Log = Arc::default();
            assert!(receive_with(fake(log.clone(), book(), valid), false).await.is_err());
            assert!(log.lock().unwrap().contains(&"getnewaddress".to_string()), "후보가 다 틀리면 새로 만들어 본다");
        }
        // 씨앗에서 나오지 않은 옛 지갑의 주소(hdkeypath 없음)도 이 지갑 것이면 쓴다.
        assert_eq!(usable(&va(None, true, false)), Some(None));
    }

    #[test]
    fn 그림은_svg_로만_덮어쓰지_않는다() {
        let dir = std::env::temp_dir().join(format!("rv-recv-qr-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let a = dir.join("받는주소.svg");
        assert_eq!(svg_path(a.to_str().unwrap()).unwrap(), a);
        assert_eq!(svg_path(dir.join("x.SVG").to_str().unwrap()).unwrap(), dir.join("x.SVG"));
        let bare = dir.join("qr");
        assert_eq!(svg_path(bare.to_str().unwrap()).unwrap(), dir.join("qr.svg"));
        std::fs::write(dir.join("qr.svg"), "x").unwrap();
        assert!(svg_path(bare.to_str().unwrap()).is_err(), "붙인 이름이 있는 파일을 덮어쓰려 한다");
        assert!(svg_path("").is_err());
        assert!(svg_path("a\nb.svg").is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 🔴 받기는 읽기와 새 주소 만들기뿐이다. 보내는 명령이 섞이면 안 된다.
    #[test]
    fn 보내는_부름이_없다() {
        let src = include_str!("receive.rs");
        let body = &src[..src.find("#[cfg(test)]").unwrap()];
        for (i, _) in body.match_indices("rpc(\"") {
            let m = &body[i + 5..];
            let m = &m[..m.find('"').unwrap()];
            assert!(CALLS.contains(&m), "허락하지 않은 부름: {m}");
        }
        for m in CALLS {
            assert!(!crate::raven::is_send_method(m), "{m}");
        }
    }
}
