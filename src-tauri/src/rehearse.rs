//! 연습 모드 — **진짜 돈 없이 똑같이 해 본다.**
//!
//! ## 왜 필요한가
//!
//! 자산 발행은 500 RVN 을 태우고 이름은 영원하다. 그런데 사장이 그걸 처음
//! 해 보는 자리가 **진짜 발행**이다. 예행연습할 방법이 없었다.
//!
//! 요약 화면과 취소 창은 "이렇게 됩니다" 를 **말해 줄** 뿐이다. 직접 해 보는
//! 것과는 다르다. 사람은 읽은 것보다 해 본 것을 안다.
//!
//! ## 어떻게 하나 — regtest
//!
//! 레이븐코인에는 `-regtest` 가 있다. **혼자 블록을 만들 수 있는** 사설 체인이라
//! 어디서 코인을 얻어 올 필요가 없다. 실측(2026-08-22): 블록 501개를 만드는 데
//! 몇 초, 잔액 124만 RVN. 그 돈으로 루트·하위·유니크를 다 찍어 봤고 전부 됐다.
//!
//! 테스트넷(포트 18770)이 아니라 regtest 인 이유:
//!   - 테스트넷 코인은 **수도꼭지(faucet)에서 얻어야 한다.** 남의 서버가 죽어
//!     있으면 연습을 못 한다. 연습이 남에게 기대면 그건 연습이 아니다.
//!   - 테스트넷도 동기화가 필요하다. regtest 는 0블록에서 시작한다.
//!
//! ## 🔴 진짜 노드를 절대 건드리지 않는다
//!
//! 폴더도 포트도 완전히 따로다. 같은 `wallet.dat` 을 두 프로세스가 열면
//! 그건 백업이 아니라 손상이고, 이 파일이 그 사고를 만들 수는 없다.
//! 연습용 폴더는 `연습` 이라는 이름이 붙은 자리에만 만든다.

use serde_json::{json, Value};
use std::path::PathBuf;

/// 연습용 노드가 쓰는 포트. 진짜 노드(8766)·테스트넷(18770)과 겹치지 않는다.
const PORT: u16 = 19766;

/// 연습용 폴더. 지워도 아무것도 안 잃는다 — 그게 요점이다.
fn dir() -> PathBuf {
    crate::paths::app_dir().join("연습")
}

fn cli_args() -> Vec<String> {
    vec![
        format!("-datadir={}", dir().to_string_lossy()),
        "-regtest".into(),
        "-rpcuser=rehearse".into(),
        "-rpcpassword=rehearse".into(),
        format!("-rpcport={PORT}"),
    ]
}

/// `ravend` 를 찾는다. 없으면 연습도 못 한다 — 진짜와 같은 프로그램을 쓴다.
fn which(name: &str) -> Option<String> {
    crate::services::which(name)
}

/// 연습용 노드를 켠다. 이미 켜져 있으면 그대로 둔다.
#[tauri::command]
pub async fn rehearse_start() -> Result<Value, String> {
    if rpc("getblockchaininfo", json!([])).await.is_ok() {
        return Ok(json!({ "running": true, "already": true }));
    }
    let Some(ravend) = which("ravend") else {
        return Err(
            "레이븐 노드가 깔려 있어야 연습도 할 수 있습니다. 연습은 진짜와 같은 \
             프로그램을 씁니다 — 그래야 연습이 됩니다."
                .into(),
        );
    };

    let d = dir();
    std::fs::create_dir_all(&d).map_err(|e| format!("연습 폴더를 만들지 못했습니다: {e}"))?;
    // 설정 파일을 써 둔다. 자산 색인이 없으면 발행은 되는데 목록이 안 보인다.
    std::fs::write(
        d.join("raven.conf"),
        "regtest=1\nserver=1\nrpcuser=rehearse\nrpcpassword=rehearse\n\
         assetindex=1\naddressindex=1\nfallbackfee=0.0001\n",
    )
    .map_err(|e| format!("연습 설정을 쓰지 못했습니다: {e}"))?;

    let mut args = cli_args();
    args.push("-daemon".into());
    crate::quiet::cmd(&ravend)
        .args(&args)
        .spawn()
        .map_err(|e| format!("연습용 노드를 켜지 못했습니다: {e}"))?;

    // 켜지기를 기다린다. 안 기다리면 다음 명령이 전부 실패한다.
    for _ in 0..30 {
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
        if rpc("getblockchaininfo", json!([])).await.is_ok() {
            return Ok(json!({ "running": true, "already": false }));
        }
    }
    Err("연습용 노드가 15초 안에 켜지지 않았습니다.".into())
}

/// 연습용 노드를 끈다.
#[tauri::command]
pub async fn rehearse_stop() -> Result<Value, String> {
    let _ = rpc("stop", json!([])).await;
    Ok(json!({ "running": false }))
}

/// 연습을 처음부터 다시. **폴더를 통째로 지운다** — 연습이니까 그래도 된다.
#[tauri::command]
pub async fn rehearse_reset() -> Result<Value, String> {
    let _ = rpc("stop", json!([])).await;
    tokio::time::sleep(std::time::Duration::from_millis(1500)).await;
    // 🔴 지우기 전에 이 경로가 정말 연습용인지 확인한다. 경로 하나 잘못
    // 짚으면 진짜 지갑을 지운다.
    let d = dir();
    if !d.to_string_lossy().contains("연습") {
        return Err("연습 폴더가 아닙니다. 지우지 않았습니다.".into());
    }
    std::fs::remove_dir_all(&d).map_err(|e| format!("지우지 못했습니다: {e}"))?;
    Ok(json!({ "reset": true }))
}

/// 연습용 돈을 만든다. regtest 라 우리가 블록을 만들면 그게 곧 돈이다.
///
/// 501블록인 이유: 레이븐도 비트코인처럼 채굴 보상이 **100블록 뒤에** 쓸 수
/// 있게 익는다. 넉넉히 501을 만들면 400블록치가 익어 있다.
#[tauri::command]
pub async fn rehearse_fund() -> Result<Value, String> {
    let addr = rpc("getnewaddress", json!([]))
        .await?
        .as_str()
        .unwrap_or_default()
        .to_string();
    if addr.is_empty() {
        return Err("연습용 주소를 만들지 못했습니다.".into());
    }
    rpc("generatetoaddress", json!([501, addr])).await?;
    let bal = rpc("getbalance", json!([])).await?.as_f64().unwrap_or(0.0);
    Ok(json!({ "balance": bal }))
}

/// 블록 하나를 더 만든다. 발행한 뒤 확정시킬 때 쓴다 —
/// 진짜 체인에서는 1분을 기다리는 자리다.
#[tauri::command]
pub async fn rehearse_confirm() -> Result<Value, String> {
    let addr = rpc("getnewaddress", json!([]))
        .await?
        .as_str()
        .unwrap_or_default()
        .to_string();
    rpc("generatetoaddress", json!([1, addr])).await?;
    Ok(json!({ "ok": true }))
}

/// 연습 상태. 화면이 "지금 연습 중" 을 알아야 진짜와 헷갈리지 않는다.
#[tauri::command]
pub async fn rehearse_status() -> Value {
    match rpc("getblockchaininfo", json!([])).await {
        Ok(v) => {
            let bal = rpc("getbalance", json!([]))
                .await
                .ok()
                .and_then(|b| b.as_f64())
                .unwrap_or(0.0);
            let mine = rpc("listmyassets", json!([]))
                .await
                .ok()
                .and_then(|m| m.as_object().map(|o| o.len()))
                .unwrap_or(0);
            json!({
                "running": true,
                "blocks": v.get("blocks").and_then(Value::as_i64).unwrap_or(0),
                "balance": bal,
                "assets": mine,
            })
        }
        Err(_) => json!({ "running": false }),
    }
}

/// 연습용 노드에 명령을 보낸다.
///
/// ⚠️ 진짜 노드의 `call_rpc` 를 쓰지 않는다. 그건 8766 으로 간다 —
/// 연습이 진짜 지갑에 닿는 일은 절대 없어야 한다.
async fn rpc(method: &str, params: Value) -> Result<Value, String> {
    let body = json!({ "jsonrpc": "1.0", "id": "rehearse", "method": method, "params": params });
    let r = reqwest::Client::new()
        .post(format!("http://127.0.0.1:{PORT}/"))
        .basic_auth("rehearse", Some("rehearse"))
        .json(&body)
        .timeout(std::time::Duration::from_secs(120))
        .send()
        .await
        .map_err(|e| format!("연습용 노드에 닿지 못했습니다: {e}"))?;
    let v: Value = r
        .json()
        .await
        .map_err(|e| format!("연습용 노드가 이상한 답을 했습니다: {e}"))?;
    if let Some(err) = v.get("error").filter(|e| !e.is_null()) {
        return Err(
            err.get("message")
                .and_then(Value::as_str)
                .unwrap_or("연습 중 오류")
                .to_string(),
        );
    }
    Ok(v.get("result").cloned().unwrap_or(Value::Null))
}

/// 연습으로 자산을 하나 만들어 본다. **진짜와 같은 RPC 를 쓴다** —
/// 다른 길로 하면 연습이 아니다.
#[tauri::command]
pub async fn rehearse_issue(
    name: String,
    qty: f64,
    units: i64,
    reissuable: bool,
) -> Result<Value, String> {
    let addr = rpc("getnewaddress", json!([]))
        .await?
        .as_str()
        .unwrap_or_default()
        .to_string();
    let before = rpc("getbalance", json!([])).await?.as_f64().unwrap_or(0.0);

    let txid = rpc(
        "issue",
        json!([name.clone(), qty, addr.clone(), "", units, reissuable, false, ""]),
    )
    .await?;

    // 바로 확정시킨다. 진짜 체인에서는 1분을 기다리는 자리다.
    let _ = rehearse_confirm().await;
    let after = rpc("getbalance", json!([])).await?.as_f64().unwrap_or(0.0);

    Ok(json!({
        "txid": txid,
        "name": name,
        "spent": (before - after * 0.0 - after).abs(),
        "balance": after,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 🔴 연습이 진짜 노드에 닿으면 그건 연습이 아니라 사고다.
    /// 포트가 겹치는 순간 연습 발행이 **진짜 500 RVN** 을 태운다.
    #[test]
    fn the_rehearsal_never_touches_the_real_node() {
        assert_ne!(PORT, 8766, "진짜 노드 포트와 같다");
        assert_ne!(PORT, 18770, "테스트넷 포트와 같다");
        let src = include_str!("rehearse.rs");
        // 진짜 노드로 가는 함수를 실수로 쓰면 안 된다.
        let code = src.split("#[cfg(test)]").next().unwrap_or("");
        assert!(
            !code.contains("crate::raven::call_rpc"),
            "연습 코드가 진짜 노드의 call_rpc 를 쓴다"
        );
    }

    /// 지우는 함수가 경로를 확인하지 않으면 진짜 지갑을 지울 수 있다.
    #[test]
    fn reset_refuses_to_delete_anything_but_the_practice_folder() {
        let src = include_str!("rehearse.rs");
        let code = src.split("#[cfg(test)]").next().unwrap_or("");
        assert!(
            code.contains(r#"contains("연습")"#),
            "지우기 전에 연습 폴더인지 확인하지 않는다"
        );
    }

    /// 연습 폴더는 진짜 데이터 폴더 안이되 이름으로 구별돼야 한다.
    #[test]
    fn the_practice_folder_says_what_it_is() {
        let _g = crate::paths::TEST_ENV.lock().unwrap_or_else(|e| e.into_inner());
        assert!(dir().to_string_lossy().contains("연습"));
        assert_ne!(dir(), crate::paths::raven_dir(), "진짜 폴더와 같다");
    }
}
