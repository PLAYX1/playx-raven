//! 원자 교환 — **아무도 먼저 보내지 않는다.**
//!
//! ## 왜 이게 필요한가
//!
//! 여태 자산을 파는 길은 하나뿐이었다(`vending.rs`): 손님이 주소로 돈을
//! 보내고, 가게가 자산을 보낸다. 손님이 **먼저** 보낸다. 가게를 믿어야 한다.
//! 아는 가게라면 괜찮다. 모르는 사람과는 못 한다.
//!
//! 원자 교환은 **한 거래 안에서 동시에** 일어난다. 돈과 자산이 같은
//! 트랜잭션에 들어가므로, 둘 다 되거나 둘 다 안 된다. 중간이 없다.
//! 이게 있어야 「내가 산 자산을 남에게 되판다」가 가능해진다.
//!
//! ## 어떻게 도는가
//!
//! ```text
//! 파는 쪽 :  입력0 = 내 자산      출력0 = 내가 받을 RVN
//!            여기까지만 서명한다 (SIGHASH_SINGLE | ANYONECANPAY)
//!            = 「이 입력은 내 것이고, 0번 출력은 나에게 온다.
//!               나머지 입력·출력은 누가 붙여도 좋다」
//!
//! 사는 쪽 :  그 반쪽에 붙인다
//!            입력1.. = 내 RVN     출력1 = 자산을 나에게 · 출력2 = 거스름돈
//!            내 입력만 서명하고, 둘을 합쳐서 방송한다
//! ```
//!
//! 반쪽짜리 제안은 그냥 글자(hex)다. 릴레이로 나르든 문자로 보내든 상관없다.
//! **우리 서버를 지나지 않는다.**
//!
//! ## 🔴 돈이 새는 자리 셋 — 전부 여기서 막는다
//!
//! ① **거스름돈 자산.** `SIGHASH_SINGLE` 은 **0번 출력 하나만** 붙잡는다.
//!    파는 사람의 자산 UTXO 에 파는 양보다 **많이** 들어 있으면, 사는 쪽이
//!    남는 양을 안 돌려주고 통째로 가져갈 수 있다. 그래서 제안을 만들기 전에
//!    **파는 양과 딱 맞는 UTXO** 를 반드시 먼저 만든다. 없으면 만들라고 하고
//!    멈춘다. 이 확인을 빼먹은 구현이 실제로 돈을 잃는다.
//!
//! ② **출력 순서.** 0번 입력은 0번 출력과 묶인다. 우리 JSON 이 키를
//!    알파벳순으로 정렬하면 그 짝이 어긋난다. `Cargo.toml` 에서
//!    `preserve_order` 를 켰고, 여기서 조립한 뒤에 **다시 열어 확인한다.**
//!    한 겹으로는 안 된다 — 조용히 틀리는 것이라 눈에 안 보인다.
//!
//! ③ **사는 쪽이 받을 것을 못 받는 경우.** 제안이 말하는 자산·수량이 진짜
//!    그 UTXO 에 들어 있는지 **체인에 물어서** 확인한다. 제안서 글자를
//!    믿지 않는다. 그리고 아직 안 쓴 것인지도 같이 본다.

use crate::raven::call_rpc;
use serde_json::{json, Value};

/// 수수료. 자산 거래는 평범한 송금보다 크다(스크립트가 붙는다).
///
/// 노드의 최소 중계 수수료가 0.01 RVN 이라 그보다 넉넉히 잡는다. RVN 값에서
/// 이건 무시할 수 있는 돈이고, 모자라서 안 나가는 쪽이 훨씬 비싸다.
const FEE: f64 = 0.1;

/// 잠긴 지갑을 잠깐 연다. 연 것은 **끝나면 반드시 다시 잠근다.**
///
/// 계산대에 열린 채로 놓인 지갑은 그 방에 있는 누구든 비울 수 있다 —
/// 직원도, 손님도, 그 컴퓨터의 다른 프로그램도.
async fn unlock(passphrase: Option<String>) -> Result<bool, String> {
    let locked = matches!(
        call_rpc("getwalletinfo", json!([]))
            .await
            .ok()
            .and_then(|i| i.get("unlocked_until").and_then(Value::as_i64)),
        Some(0)
    );
    if locked {
        let pass =
            passphrase.ok_or_else(|| "지갑이 잠겨 있습니다. 암호가 필요합니다.".to_string())?;
        call_rpc("walletpassphrase", json!([pass, 60])).await?;
    }
    Ok(locked)
}

async fn relock(was: bool) {
    if was {
        let _ = call_rpc("walletlock", json!([])).await;
    }
}

fn f(v: &Value) -> f64 {
    v.as_f64().unwrap_or(0.0)
}

/// 두 수가 사실상 같은가. 부동소수점을 그대로 비교하면 안 된다.
/// 레이븐의 최소 단위는 1사토시(0.00000001)다.
fn same(a: f64, b: f64) -> bool {
    (a - b).abs() < 1e-8
}

/// 파는 양과 **딱 맞는** 자산 UTXO 가 있나.
///
/// 위 ① 때문에 이게 전부다. 딱 맞는 것이 없으면 제안을 만들면 안 된다.
async fn exact_outpoint(asset: &str, amount: f64) -> Result<Option<Value>, String> {
    let v = call_rpc("listmyassets", json!([asset, true])).await?;
    let entry = v.get(asset).cloned().unwrap_or(Value::Null);
    let outs = entry
        .get("outpoints")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    Ok(outs.into_iter().find(|o| same(f(&o["amount"]), amount)))
}

/// 팔 준비가 됐나. 안 됐으면 **무엇을 해야 하는지** 말한다.
#[tauri::command]
pub async fn swap_ready(asset: String, amount: f64) -> Result<Value, String> {
    let hit = exact_outpoint(&asset, amount).await?;
    let total = call_rpc("listmyassets", json!([asset.clone(), false]))
        .await
        .ok()
        .and_then(|v| v.get(&asset).and_then(Value::as_f64))
        .unwrap_or(0.0);

    if total < amount {
        return Ok(json!({
            "ready": false,
            "have": total,
            "why": format!("가진 것이 {total} 개뿐입니다."),
        }));
    }
    Ok(json!({
        "ready": hit.is_some(),
        "have": total,
        "why": if hit.is_some() {
            String::new()
        } else {
            // 왜 한 번 더 보내야 하는지 적는다. 안 적으면 「왜 이런 걸
            // 시키지」 하고 그만둔다.
            format!(
                "{amount}개짜리 묶음을 먼저 만들어야 합니다. 지금은 다른 크기로 뭉쳐 있어서, \
                 그대로 팔면 사는 쪽이 남는 것까지 가져갈 수 있습니다. \
                 「묶음 만들기」를 누르면 자기 지갑으로 {amount}개를 보내 묶음을 만듭니다."
            )
        },
    }))
}

/// 파는 양과 딱 맞는 묶음을 만든다. 자기 지갑 안에서 도는 일이다.
///
/// 확인되기까지 몇 분 걸린다 — 그동안은 제안을 못 만든다. 그걸 미리 말한다.
#[tauri::command]
pub async fn swap_make_lot(
    asset: String,
    amount: f64,
    passphrase: Option<String>,
) -> Result<Value, String> {
    if exact_outpoint(&asset, amount).await?.is_some() {
        return Ok(json!({ "already": true }));
    }
    let was = unlock(passphrase).await?;
    let to = call_rpc("getnewaddress", json!([])).await?;
    let to = to.as_str().unwrap_or_default().to_string();
    if to.is_empty() {
        return Err("받을 주소를 만들지 못했습니다.".into());
    }
    let r = call_rpc("transfer", json!([asset, amount, to])).await;
    relock(was).await;
    let r = r?;
    let txid = r
        .as_array()
        .and_then(|a| a.first())
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    crate::refund::remember_ours(&txid);
    Ok(json!({
        "already": false,
        "txid": txid,
        "note": "묶음을 만드는 중입니다. 체인에 들어가면(보통 1~2분) 제안을 만들 수 있습니다.",
    }))
}

/// 파는 쪽의 반쪽. 이 글자를 남에게 주면 그 사람이 완성해서 방송한다.
///
/// 🔴 이 글자만으로는 **아무 일도 안 일어난다.** 사는 쪽이 RVN 을 붙여야
///    거래가 성립한다. 그래서 아무 데나 뿌려도 되고, 릴레이로 날라도 된다.
#[tauri::command]
pub async fn swap_offer(
    asset: String,
    amount: f64,
    price: f64,
    passphrase: Option<String>,
) -> Result<Value, String> {
    if amount <= 0.0 || price <= 0.0 {
        return Err("수량과 값은 0보다 커야 합니다.".into());
    }
    let Some(out) = exact_outpoint(&asset, amount).await? else {
        return Err(
            "파는 양과 딱 맞는 묶음이 없습니다. 「묶음 만들기」를 먼저 해 주세요 — \
             그대로 팔면 사는 쪽이 남는 것까지 가져갈 수 있습니다."
                .into(),
        );
    };
    let was = unlock(passphrase).await?;

    let pay_to = call_rpc("getnewaddress", json!([])).await?;
    let pay_to = pay_to.as_str().unwrap_or_default().to_string();
    if pay_to.is_empty() {
        return Err("받을 주소를 만들지 못했습니다.".into());
    }

    let ins = json!([{ "txid": out["txid"], "vout": out["vout"] }]);
    let outs = json!({ pay_to.clone(): price });
    let raw = call_rpc("createrawtransaction", json!([ins, outs])).await?;
    let raw = raw.as_str().unwrap_or_default().to_string();

    // ⚠️ 위 ②. 조립한 것을 **다시 열어 본다.** 0번 출력이 내 주소·내 값이
    //    아니면 서명이 엉뚱한 데 묶인다.
    let dec = call_rpc("decoderawtransaction", json!([raw.clone()])).await?;
    check_offer_shape(&dec, &pay_to, price)?;

    let signed = call_rpc(
        "signrawtransaction",
        json!([raw, Value::Null, Value::Null, "SINGLE|ANYONECANPAY"]),
    )
    .await;
    relock(was).await;
    let signed = signed?;
    let hex = signed["hex"].as_str().unwrap_or_default().to_string();
    if hex.is_empty() {
        return Err("서명하지 못했습니다. 지갑이 잠겨 있는지 확인해 주세요.".into());
    }

    Ok(json!({
        "hex": hex,
        "asset": asset,
        "amount": amount,
        "price": price,
        "pay_to": pay_to,
        "txid": out["txid"],
        "vout": out["vout"],
    }))
}

/// 0번 출력이 파는 사람에게 가는가. 위 ② 를 막는 확인.
fn check_offer_shape(dec: &Value, pay_to: &str, price: f64) -> Result<(), String> {
    let vout = dec["vout"].as_array().cloned().unwrap_or_default();
    let first = vout
        .first()
        .ok_or_else(|| "출력이 없습니다 — 조립이 잘못됐습니다.".to_string())?;
    if !same(f(&first["value"]), price) {
        return Err(format!(
            "0번 출력의 값이 {}이 아니라 {}입니다. 조립 순서가 어긋났습니다 — 이대로 서명하면 안 됩니다.",
            price,
            f(&first["value"])
        ));
    }
    let addrs = first["scriptPubKey"]["addresses"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    if !addrs.iter().any(|a| a.as_str() == Some(pay_to)) {
        return Err("0번 출력이 내 주소가 아닙니다. 조립 순서가 어긋났습니다.".into());
    }
    Ok(())
}

/// 받은 제안이 **진짜인지** 체인에 물어본다. 글자를 믿지 않는다.
///
/// 사는 사람이 이걸 보고 「살까 말까」를 정한다. 그래서 값과 수량은 물론
/// **아직 안 팔린 것인지**까지 답해야 한다.
#[tauri::command]
pub async fn swap_check(hex: String) -> Result<Value, String> {
    let dec = call_rpc("decoderawtransaction", json!([hex.clone()])).await?;
    let vin = dec["vin"].as_array().cloned().unwrap_or_default();
    let vout = dec["vout"].as_array().cloned().unwrap_or_default();
    if vin.len() != 1 || vout.len() != 1 {
        return Err(
            "제안의 모양이 다릅니다(입력 1개·출력 1개여야 합니다). 이 글자는 쓰지 마세요.".into(),
        );
    }
    let txid = vin[0]["txid"].as_str().unwrap_or_default().to_string();
    let vnum = vin[0]["vout"].as_u64().unwrap_or(0);

    // 🔴 위 ③. **아직 안 쓴 출력인가**, 그리고 **정말 그 자산이 들어 있는가.**
    //    `gettxout` 이 없다고 하면 이미 팔렸거나 없는 것이다.
    let utxo = call_rpc("gettxout", json!([txid.clone(), vnum, true])).await?;
    if utxo.is_null() {
        return Ok(json!({
            "ok": false,
            "why": "이 제안은 이미 팔렸거나 취소됐습니다.",
        }));
    }
    let spk = &utxo["scriptPubKey"];
    let asset = spk["asset"]["name"]
        .as_str()
        .or_else(|| spk["asset"]["asset_name"].as_str())
        .unwrap_or("")
        .to_string();
    let amount = spk["asset"]["amount"].as_f64().unwrap_or(0.0);
    if asset.is_empty() || amount <= 0.0 {
        return Ok(json!({
            "ok": false,
            "why": "이 제안이 가리키는 것은 자산이 아닙니다. 쓰지 마세요.",
        }));
    }

    let price = f(&vout[0]["value"]);
    let seller = vout[0]["scriptPubKey"]["addresses"][0]
        .as_str()
        .unwrap_or("")
        .to_string();

    Ok(json!({
        "ok": true,
        "asset": asset,
        "amount": amount,
        "price": price,
        "seller": seller,
        "txid": txid,
        "vout": vnum,
        // 한 개당 값. 이게 있어야 비싼지 싼지 판단이 된다.
        "each": if amount > 0.0 { price / amount } else { price },
    }))
}

/// 사는 쪽. 제안에 내 RVN 을 붙여 완성하고 방송한다.
///
/// `broadcast` 를 `false` 로 부르면 **조립만 하고 안 보낸다.** 화면이 먼저
/// 「이렇게 나갑니다」를 보여 주고 사람이 누를 때 보낸다 — 돈이 오가는 일에
/// 미리보기 없는 단추를 두지 않는다.
#[tauri::command]
pub async fn swap_take(
    hex: String,
    broadcast: bool,
    passphrase: Option<String>,
) -> Result<Value, String> {
    let info = swap_check(hex.clone()).await?;
    if !info["ok"].as_bool().unwrap_or(false) {
        return Err(info["why"].as_str().unwrap_or("쓸 수 없는 제안입니다.").to_string());
    }
    let asset = info["asset"].as_str().unwrap_or_default().to_string();
    let amount = f(&info["amount"]);
    let price = f(&info["price"]);
    let seller = info["seller"].as_str().unwrap_or_default().to_string();
    let s_txid = info["txid"].as_str().unwrap_or_default().to_string();
    let s_vout = info["vout"].as_u64().unwrap_or(0);

    let was = unlock(passphrase).await?;

    // ── 내 RVN 고르기 ────────────────────────────────────────────
    let need = price + FEE;
    let unspent = call_rpc("listunspent", json!([1])).await?;
    let mut mine: Vec<Value> = unspent.as_array().cloned().unwrap_or_default();
    // 큰 것부터 쓴다. 입력 개수가 적을수록 거래가 작고 수수료가 싸다.
    mine.sort_by(|a, b| f(&b["amount"]).partial_cmp(&f(&a["amount"])).unwrap_or(std::cmp::Ordering::Equal));
    let mut picked: Vec<Value> = Vec::new();
    let mut got = 0.0;
    for u in mine {
        // 자산이 붙은 출력은 쓰면 안 된다 — 그걸 쓰면 내 자산이 같이 나간다.
        if !u["assetName"].is_null() && u["assetName"].as_str() != Some("RVN") {
            continue;
        }
        got += f(&u["amount"]);
        picked.push(u);
        if got >= need {
            break;
        }
    }
    if got < need {
        return Err(format!(
            "RVN 이 모자랍니다. {need:.8} 이 필요한데 쓸 수 있는 것이 {got:.8} 입니다."
        ));
    }

    let get_addr = || async {
        call_rpc("getnewaddress", json!([]))
            .await
            .map(|v| v.as_str().unwrap_or_default().to_string())
    };
    let asset_to = get_addr().await?;
    let change_to = get_addr().await?;
    if asset_to.is_empty() || change_to.is_empty() {
        return Err("받을 주소를 만들지 못했습니다.".into());
    }

    // ── 조립 ─────────────────────────────────────────────────────
    // 🔴 **파는 사람의 입력이 0번, 파는 사람의 출력이 0번.** 이 짝이
    //    어긋나면 그 서명은 아무 데도 안 맞고, 최악의 경우 엉뚱한 출력에
    //    붙는다. 아래에서 조립한 뒤 다시 열어 확인한다.
    let mut ins = vec![json!({ "txid": s_txid, "vout": s_vout })];
    for u in &picked {
        ins.push(json!({ "txid": u["txid"], "vout": u["vout"] }));
    }
    let change = got - price - FEE;
    let mut outs = serde_json::Map::new();
    outs.insert(seller.clone(), json!(price));
    outs.insert(asset_to.clone(), json!({ "transfer": { asset.clone(): amount } }));
    // 거스름돈이 먼지만큼이면 넣지 않는다 — 넣으면 노드가 거절한다.
    if change > 0.0001 {
        outs.insert(change_to.clone(), json!(change));
    }

    let raw = call_rpc("createrawtransaction", json!([ins, Value::Object(outs)])).await?;
    let raw = raw.as_str().unwrap_or_default().to_string();

    let dec = call_rpc("decoderawtransaction", json!([raw.clone()])).await?;
    check_take_shape(&dec, &seller, price, &asset_to, &asset, amount)?;

    // 내 입력만 서명한다. 0번은 내 것이 아니라 비워진 채로 남는다.
    let mine_signed = call_rpc("signrawtransaction", json!([raw])).await;
    relock(was).await;
    let mine_signed = mine_signed?;
    let mine_hex = mine_signed["hex"].as_str().unwrap_or_default().to_string();
    if mine_hex.is_empty() {
        return Err("내 몫을 서명하지 못했습니다. 지갑이 잠겨 있는지 확인해 주세요.".into());
    }

    // 🔴 **내 것을 앞에 둔다.** 노드는 합칠 때 첫 번째 것을 복제해서
    //    시작한다(rawtransaction.cpp:1746). 순서를 바꾸면 입력·출력이
    //    파는 사람의 반쪽(1개·1개)으로 줄어든다.
    let combined = call_rpc("combinerawtransaction", json!([[mine_hex, hex]])).await?;
    let full = combined.as_str().unwrap_or_default().to_string();
    if full.is_empty() {
        return Err("두 서명을 합치지 못했습니다.".into());
    }

    if !broadcast {
        return Ok(json!({
            "sent": false,
            "hex": full,
            "asset": asset, "amount": amount, "price": price,
            "fee": FEE, "change": change,
            "to": asset_to,
        }));
    }
    let txid = call_rpc("sendrawtransaction", json!([full])).await?;
    let txid = txid.as_str().unwrap_or_default().to_string();
    crate::refund::remember_ours(&txid);
    Ok(json!({
        "sent": true, "txid": txid,
        "asset": asset, "amount": amount, "price": price,
    }))
}

/// 완성본이 내가 의도한 모양인가. 위 ②·③ 을 마지막으로 한 번 더 막는다.
fn check_take_shape(
    dec: &Value,
    seller: &str,
    price: f64,
    asset_to: &str,
    asset: &str,
    amount: f64,
) -> Result<(), String> {
    let vout = dec["vout"].as_array().cloned().unwrap_or_default();
    let first = vout
        .first()
        .ok_or_else(|| "출력이 없습니다.".to_string())?;
    if !same(f(&first["value"]), price)
        || !first["scriptPubKey"]["addresses"]
            .as_array()
            .map(|a| a.iter().any(|x| x.as_str() == Some(seller)))
            .unwrap_or(false)
    {
        return Err(
            "0번 출력이 파는 사람에게 가는 값이 아닙니다. 순서가 어긋났습니다 — 보내지 않았습니다."
                .into(),
        );
    }
    // 내가 받을 자산이 정말 들어 있나. 없으면 돈만 나가고 아무것도 안 온다.
    let got = vout.iter().any(|o| {
        let sp = &o["scriptPubKey"];
        let name = sp["asset"]["name"].as_str().or_else(|| sp["asset"]["asset_name"].as_str());
        name == Some(asset)
            && same(sp["asset"]["amount"].as_f64().unwrap_or(0.0), amount)
            && sp["addresses"]
                .as_array()
                .map(|a| a.iter().any(|x| x.as_str() == Some(asset_to)))
                .unwrap_or(true)
    });
    if !got {
        return Err("내가 받을 자산 출력이 없습니다 — 보내지 않았습니다.".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 사토시_아래는_같은_값으로_본다() {
        assert!(same(1.0, 1.000000001));
        assert!(!same(1.0, 1.0001));
    }

    /// 🔴 **이 확인이 이 파일의 존재 이유다.** 파는 양보다 큰 묶음을 그대로
    ///    팔면, `SIGHASH_SINGLE` 이 0번 출력만 붙잡기 때문에 사는 쪽이 남는
    ///    자산을 안 돌려주고 가져갈 수 있다. 누가 「딱 맞는 것 찾기」를
    ///    「넉넉한 것 찾기」로 바꾸면 그날 돈이 샌다.
    #[test]
    fn 딱_맞는_묶음만_판다() {
        let src = include_str!("swap.rs");
        let i = src.find("async fn exact_outpoint").expect("찾는 함수가 있어야 한다");
        let end = src[i..].find("\npub async fn swap_ready").unwrap_or(src.len() - i);
        let body = &src[i..i + end];
        assert!(
            body.contains("same(") && !body.contains(">="),
            "딱 맞는 것이 아니라 넉넉한 것을 고르고 있다 — 남는 자산을 잃는다"
        );
    }

    /// 노드는 합칠 때 **첫 번째 것을 복제**해서 시작한다
    /// (rawtransaction.cpp:1746). 순서를 바꾸면 완성본이 파는 사람의
    /// 반쪽(입력 1·출력 1)으로 줄어들어 내 RVN 입력이 통째로 사라진다.
    #[test]
    fn 합칠_때_내_것이_앞이다() {
        let src = include_str!("swap.rs");
        let i = src.find("combinerawtransaction").expect("합치는 줄이 있어야 한다");
        let line = &src[i..i + 90.min(src.len() - i)];
        assert!(
            line.contains("mine_hex, hex"),
            "합치는 순서가 뒤집혔다 — 내 입력과 출력이 사라진다"
        );
    }

    /// 조립한 것을 다시 열어 보는 확인이 없으면, 키 정렬 한 번에 조용히
    /// 돈이 샌다. 두 곳 다 있어야 한다.
    #[test]
    fn 조립한_뒤에_다시_확인한다() {
        let src = include_str!("swap.rs");
        let end = src.find("#[cfg(test)]").unwrap_or(src.len());
        let body = &src[..end];
        assert!(
            body.contains("check_offer_shape(&dec") && body.contains("check_take_shape(&dec"),
            "조립 결과를 확인하지 않고 있다"
        );
    }
}
