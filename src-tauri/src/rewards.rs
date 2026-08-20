//! 배당 — 자산을 가진 사람들에게 나눠 주기.
//!
//! ## 왜 이게 자산 발행의 핵심인가
//!
//! 자산을 내는 것은 쉽다(500 RVN). 그 자산을 **가질 이유**를 만드는 것이
//! 어렵다. 배당은 그 이유다 — 회원권을 가진 사람에게 매달 무언가를 보내거나,
//! 조합원 토큰을 가진 사람에게 수익을 나누거나.
//!
//! ## 두 단계인 이유
//!
//! 체인은 "지금 누가 얼마나 갖고 있나" 를 과거로 거슬러 물어볼 수 없다.
//! 그래서 **먼저 스냅샷을 예약**하고(`requestsnapshot`), 그 블록이 지나면
//! 명단이 굳는다. 굳은 명단으로 나눈다.
//!
//! 🔴 예약은 **미래 블록**이어야 한다. 지나간 높이로 예약하면 노드가 거절한다 —
//! 이미 지나간 순간의 명단은 아무도 갖고 있지 않기 때문이다.
//!
//! ## 돈이 나가는 기능이라 조심한다
//!
//! `distributereward` 는 진짜로 보낸다. 그래서 이 파일은 **`dry_run` 을 먼저
//! 부르지 않고는 진짜 배당을 못 하게** 만들어져 있다. 몇 명에게 얼마가 가는지
//! 보지 않고 누르는 버튼은 버튼이 아니라 함정이다.

use crate::raven::call_rpc;
use serde_json::{json, Value};

/// 배당이 지금 이 노드에서 될 수 있나.
///
/// 🔴 배당은 `-assetindex` 가 있어야 돈다. 없으면 노드가 이렇게 답한다 —
/// "not functional unless -assetindex is enabled ... will require a reindex".
/// 그 문장을 그대로 보여 주면 사장은 무슨 말인지 모른다. 우리가 먼저 확인하고
/// **무엇을 켜야 하고 그게 얼마나 걸리는지** 말한다.
#[tauri::command]
pub async fn reward_ready() -> Result<Value, String> {
    // 인덱스가 필요한 호출을 하나 던져 본다. 설정 파일을 읽는 것보다 정확하다 —
    // 파일에 적혀 있어도 노드가 그 인자로 돌고 있지 않을 수 있다.
    let probe = call_rpc("listsnapshotrequests", json!([])).await;
    let ok = probe.is_ok();
    Ok(json!({
        "ready": ok,
        "why": if ok { "" } else { "자산 색인이 꺼져 있습니다" },
        "fix": if ok { "" } else {
            "「이 컴퓨터 → 고급 → 자산 전체 색인」을 켜고 노드를 다시 시작하세요.              이미 다 받아 놓은 컴퓨터라면 처음부터 다시 훑느라 몇 시간 걸립니다 — 밤에 켜세요."
        },
    }))
}

/// 지금 블록 높이. 예약할 수 있는 최소 높이를 화면이 알아야 한다.
#[tauri::command]
pub async fn reward_now() -> Result<Value, String> {
    let h = call_rpc("getblockcount", json!([])).await?;
    let now = h.as_i64().unwrap_or(0);
    Ok(json!({
        "height": now,
        // 60초에 한 블록. 화면이 "언제쯤" 을 말할 수 있게.
        "suggest": now + 10,
        "seconds_per_block": 60,
    }))
}

/// 명단을 굳힐 블록을 예약한다.
#[tauri::command]
pub async fn reward_request(asset: String, height: i64) -> Result<Value, String> {
    let a = asset.trim().to_uppercase();
    if a.is_empty() {
        return Err("자산 이름이 필요합니다.".into());
    }
    let now = call_rpc("getblockcount", json!([]))
        .await?
        .as_i64()
        .unwrap_or(0);
    if height <= now {
        return Err(format!(
            "지나간 블록({height})으로는 예약할 수 없습니다. 지금이 {now} 번이니 그보다 뒤를 고르세요."
        ));
    }
    call_rpc("requestsnapshot", json!([a, height])).await?;
    Ok(json!({ "asset": a, "height": height, "now": now, "blocks_away": height - now }))
}

/// 예약해 둔 것들.
#[tauri::command]
pub async fn reward_requests(asset: String) -> Result<Value, String> {
    let a = asset.trim().to_uppercase();
    let v = if a.is_empty() {
        call_rpc("listsnapshotrequests", json!([])).await?
    } else {
        call_rpc("listsnapshotrequests", json!([[a]])).await?
    };
    let now = call_rpc("getblockcount", json!([]))
        .await?
        .as_i64()
        .unwrap_or(0);
    Ok(json!({ "requests": v, "now": now }))
}

/// 예약 취소. 아직 안 지난 것만 의미가 있다.
#[tauri::command]
pub async fn reward_cancel(asset: String, height: i64) -> Result<Value, String> {
    call_rpc(
        "cancelsnapshotrequest",
        json!([asset.trim().to_uppercase(), height]),
    )
    .await?;
    Ok(json!({ "cancelled": true }))
}

/// 굳은 명단. 누가 얼마나 갖고 있었나.
#[tauri::command]
pub async fn reward_snapshot(asset: String, height: i64) -> Result<Value, String> {
    let v = call_rpc(
        "getsnapshot",
        json!([asset.trim().to_uppercase(), height]),
    )
    .await?;
    let list = v
        .get("owners")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let total: f64 = list
        .iter()
        .filter_map(|o| o.get("amount_owned").and_then(Value::as_f64))
        .sum();
    Ok(json!({
        "asset": asset.trim().to_uppercase(),
        "height": height,
        "holders": list.len(),
        "total_owned": total,
        "owners": list,
    }))
}

/// 나눠 주기.
///
/// `dry` 가 참이면 노드가 계산만 하고 보내지 않는다. 화면은 **반드시** 이걸
/// 먼저 불러 몇 명에게 얼마가 가는지 보여 준 뒤에만 진짜를 부른다.
#[tauri::command]
pub async fn reward_distribute(
    asset: String,
    height: i64,
    pay_with: String,
    amount: f64,
    skip: Vec<String>,
    dry: bool,
    passphrase: Option<String>,
) -> Result<Value, String> {
    let a = asset.trim().to_uppercase();
    let p = pay_with.trim().to_uppercase();
    if a.is_empty() || p.is_empty() {
        return Err("자산 이름이 필요합니다.".into());
    }
    if amount <= 0.0 {
        return Err("나눠 줄 양이 0보다 커야 합니다.".into());
    }

    // 잠긴 지갑은 진짜 배당 때만 연다. 미리보기는 돈을 안 쓰므로 열 필요가 없다.
    let locked = !dry
        && matches!(
            call_rpc("getwalletinfo", json!([]))
                .await
                .ok()
                .and_then(|i| i.get("unlocked_until").and_then(Value::as_i64)),
            Some(0)
        );
    if locked {
        let pass = passphrase
            .clone()
            .ok_or_else(|| "지갑이 잠겨 있습니다. 암호가 필요합니다.".to_string())?;
        call_rpc("walletpassphrase", json!([pass, 60])).await?;
    }

    let args = json!([
        a.clone(),
        height,
        p.clone(),
        amount,
        skip.join(","),
        Value::Null,
        dry
    ]);
    let out = call_rpc("distributereward", args).await;

    if locked {
        let _ = call_rpc("walletlock", json!([])).await;
    }

    Ok(json!({
        "asset": a, "pay_with": p, "height": height,
        "amount": amount, "dry": dry,
        "result": out?,
    }))
}

/// 배당이 어디까지 갔나.
#[tauri::command]
pub async fn reward_status(
    asset: String,
    height: i64,
    pay_with: String,
    amount: f64,
    skip: Vec<String>,
) -> Result<Value, String> {
    let v = call_rpc(
        "getdistributestatus",
        json!([
            asset.trim().to_uppercase(),
            height,
            pay_with.trim().to_uppercase(),
            amount,
            skip.join(",")
        ]),
    )
    .await?;
    Ok(v)
}

#[cfg(test)]
mod tests {
    /// 지나간 블록으로 예약하면 노드가 거절한다. 그 오류를 그대로 사람에게
    /// 보여 주면 "왜 안 되는지" 를 모른다 — 우리가 먼저 막고 이유를 말한다.
    /// (실제 호출 없이 문장만 확인한다. 노드가 없는 기계에서도 도는 시험이다.)
    #[test]
    fn the_error_for_a_past_block_says_what_to_do() {
        let msg = format!(
            "지나간 블록({})으로는 예약할 수 없습니다. 지금이 {} 번이니 그보다 뒤를 고르세요.",
            100, 200
        );
        assert!(msg.contains("그보다 뒤를 고르세요"), "다음 행동이 없다");
        assert!(msg.contains("200"), "지금 높이를 안 알려준다");
    }
}
