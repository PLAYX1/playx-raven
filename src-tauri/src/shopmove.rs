//! 간판 열쇠를 **12단어에서 나온 것으로 옮긴다.**
//!
//! ## 무엇을 푸는가
//!
//! 대표님: "레이븐코인 seed 만 입력해서 복구하면 기존에 사용하던 모든 게
//! 복구되었으면 좋겠는데."
//!
//! 0.1.32 부터 **새로 만드는** 가게의 간판 열쇠는 12단어에서 나온다. 그런데
//! 그전에 만들어진 가게는 무작위 열쇠를 쓰고, 그 공개키가 체인의 가게 정보에
//! `nostr_pubkey` 로 박혀 있다. 열쇠만 바꾸면 **손님이 가게를 못 찾는다** —
//! 체인이 가리키는 공개키와 실제로 글을 쓰는 열쇠가 어긋나기 때문이다.
//!
//! 그래서 둘을 **같이** 해야 한다: 새 열쇠를 뽑고, 그 공개키를 체인에 다시
//! 새긴다. 후자가 재발행이고 100 RVN 이 든다.
//!
//! ## 🔴 순서가 곧 안전이다
//!
//! **체인이 먼저, 열쇠 파일이 나중.** 파일을 먼저 바꿔 놓고 재발행이 실패하면
//! 그 가게는 그 순간부터 죽는다 — 새 열쇠로 글을 쓰는데 체인은 옛 공개키를
//! 가리킨다. 손님 화면에서 주문 단추가 사라지고, 사장은 왜인지 모른다.
//!
//! 그래서 재발행이 **성공한 것을 보고 나서** 파일을 바꾼다. 옛 열쇠는 지우지
//! 않고 옆에 남긴다.
//!
//! ## 가게 정보를 **새로 만들지 않는다**
//!
//! 체인이 가리키는 지금 정보를 그대로 받아 와서 `nostr_pubkey` 한 줄만
//! 갈아 끼운다. 새로 만들면 화면에 안 뜨는 항목(좌표·번역된 설명·사진
//! 폴더 주소)을 조용히 잃는다. 한 줄만 바꾸는 쪽이 잃을 것이 없다.

use serde_json::{json, Value};

/// 자산 하나가 가질 수 있는 최대 수량(`amount.h:27`).
const MAX_UNITS: f64 = 21_000_000_000.0;

/// 지금 가게 정보를 체인에서 읽어 온다.
async fn chain_profile(asset: &str) -> Result<(Value, String, f64, bool), String> {
    let d = crate::raven::call_rpc("getassetdata", json!([asset])).await?;
    let cid = d["ipfs_hash"].as_str().unwrap_or("").to_string();
    let amount = d["amount"].as_f64().unwrap_or(0.0);
    let reissuable = d["reissuable"].as_i64().unwrap_or(0) == 1;
    if cid.is_empty() {
        return Err("이 가게에는 아직 정보가 붙어 있지 않습니다.".into());
    }
    // 우리 파일창고에서 먼저 본다. 없으면 공개 문을 쓴다 — 우리 것이 아직
    // 안 따라잡았을 수 있고, 그때 못 읽는다고 멈추면 아무것도 못 한다.
    let mut last = String::new();
    for url in [
        format!("http://127.0.0.1:8080/ipfs/{cid}"),
        format!("https://rvn.ex.erci.se/ipfs/{cid}"),
        format!("https://ipfs.io/ipfs/{cid}"),
    ] {
        match reqwest::Client::new()
            .get(&url)
            .timeout(std::time::Duration::from_secs(12))
            .send()
            .await
        {
            Ok(r) if r.status().is_success() => match r.json::<Value>().await {
                Ok(v) => return Ok((v, cid, amount, reissuable)),
                Err(e) => last = e.to_string(),
            },
            Ok(r) => last = format!("{}", r.status()),
            Err(e) => last = e.to_string(),
        }
    }
    Err(format!("가게 정보를 읽지 못했습니다({cid}): {last}"))
}

/// 12단어에서 나온 간판 열쇠의 공개키. 읽을 수 없으면 `None`.
///
/// 🔴 **`block_on` 을 쓰면 안 된다.** 이 함수를 부르는 곳이 이미 tokio 런타임
///    위에 있어서, 런타임 안에서 런타임을 시작하려다 그 자리에서 터진다
///    (`Cannot start a runtime from within a runtime`). 그러면 사장은
///    「가게 옮기기」를 눌렀는데 아무 말도 없이 앱이 죽는 것을 본다.
///
/// ⚠️ 검사로는 안 잡혔다 — 시험은 런타임 밖에서 도니까 통과한다.
///    **통과가 작동의 증거가 아닌** 또 하나의 자리다.
async fn seed_pubkey() -> Option<String> {
    let v = crate::raven::call_rpc("getmywords", json!([])).await.ok()?;
    let words = v.get("word_list").and_then(Value::as_str)?;
    let pass = v.get("passphrase").and_then(Value::as_str).unwrap_or("");
    let sk = crate::shopkey::derive_tagged(crate::shopkey::SEED_TAG, words, pass)?;
    crate::shopkey::pubkey_of(&sk).ok()
}

/// **무슨 일이 일어날지 먼저 보여 준다.** 100 RVN 이 타는 일이라 미리보기가 없으면 안 된다.
#[tauri::command]
pub async fn shop_key_move_plan() -> Result<Value, String> {
    let det = crate::shop::shop_detect_asset().await?;
    let asset = det["asset"]
        .as_str()
        .ok_or("이 지갑에 가게 자산이 없습니다.")?
        .to_string();

    let (profile, cid, amount, reissuable) = chain_profile(&asset).await?;
    let now_pk = profile["nostr_pubkey"].as_str().unwrap_or("").to_string();
    let new_pk = seed_pubkey().await;

    // 🔴 이미 넣을 수 있는 최대치가 얼마인지 **우리가 계산해서 준다.**
    //    상한(210억)을 그대로 넣으면 이미 있는 수량만큼 넘쳐서 거래가
    //    통째로 실패한다(`assets.cpp:5484`). 사장이 그 계산을 하게 두면 안 된다.
    let room = (MAX_UNITS - amount).max(0.0);

    let blocked = if !reissuable {
        Some("이 자산은 재발행이 잠겨 있습니다. 간판 열쇠를 바꿀 수 없습니다.".to_string())
    } else if new_pk.is_none() {
        Some(
            "12단어를 읽지 못했습니다. 지갑이 잠겨 있으면 열어 주시고, \
             12단어로 만든 지갑이 아니면 이 길은 쓸 수 없습니다."
                .into(),
        )
    } else if new_pk.as_deref() == Some(now_pk.as_str()) {
        Some("이미 12단어에서 나온 열쇠를 쓰고 있습니다. 바꿀 것이 없습니다.".into())
    } else {
        None
    };

    Ok(json!({
        "asset": asset,
        "cid": cid,
        "amount": amount,
        "reissuable": reissuable,
        "max_add": room,
        "now_pubkey": now_pk,
        "new_pubkey": new_pk,
        "blocked": blocked,
        "burn": 100.0,
        "note": "수량은 안 늘려도 됩니다(0). 늘리면 그만큼 단골에게 나눠 줄 수 있습니다 — 값은 어느 쪽이든 100 RVN 한 번입니다.",
    }))
}

/// 옮긴다. **체인이 먼저, 파일이 나중.**
#[tauri::command]
pub async fn shop_key_move(qty: f64, passphrase: Option<String>) -> Result<Value, String> {
    let plan = shop_key_move_plan().await?;
    if let Some(why) = plan["blocked"].as_str() {
        return Err(why.to_string());
    }
    let asset = plan["asset"].as_str().unwrap_or_default().to_string();
    let new_pk = plan["new_pubkey"].as_str().unwrap_or_default().to_string();
    let room = plan["max_add"].as_f64().unwrap_or(0.0);
    if qty < 0.0 {
        return Err("수량은 0보다 작을 수 없습니다.".into());
    }
    if qty > room {
        return Err(format!(
            "너무 많습니다. 지금 넣을 수 있는 최대는 {}개입니다 — 이미 있는 것까지 더하면 상한(210억)을 넘습니다.",
            (room as u64)
        ));
    }

    // ── 가게 정보에서 한 줄만 갈아 끼운다 ──────────────────────────
    let (mut profile, _old_cid, _amount, _re) = chain_profile(&asset).await?;
    let obj = profile
        .as_object_mut()
        .ok_or("가게 정보의 모양이 다릅니다.")?;
    obj.insert("nostr_pubkey".into(), json!(new_pk));
    let bytes = serde_json::to_vec(&profile).map_err(|e| e.to_string())?;

    let added = crate::upload::ipfs_add_file(crate::upload::Incoming {
        name: "shop.json".into(),
        bytes,
    })
    .await?;
    let new_cid = added["cid"].as_str().unwrap_or("").to_string();
    if new_cid.is_empty() {
        return Err("새 가게 정보를 파일창고에 올리지 못했습니다.".into());
    }

    // ── 체인에 새긴다 ─────────────────────────────────────────────
    let to = crate::raven::call_rpc("getnewaddress", json!([])).await?;
    let to = to.as_str().unwrap_or_default().to_string();
    let txid = crate::issue2::reissue(
        asset.clone(),
        qty,
        Some(to),
        // 🔴 반드시 켠 채로 둔다. 잠그면 다음에 결제 주소나 간판 열쇠를
        //    **영영 못 바꾼다.** 수량이 상한에 닿아도 수량 0 으로 정보만
        //    고치는 길은 남아 있어야 한다.
        true,
        Some(new_cid.clone()),
        passphrase,
    )
    .await?;

    // ── 여기까지 왔으면 체인이 새 공개키를 가리킨다. 이제 파일을 바꾼다 ──
    crate::shopkey::install_seed_key()?;

    Ok(json!({
        "txid": txid,
        "asset": asset,
        "qty": qty,
        "cid": new_cid,
        "pubkey": new_pk,
        "note": "체인에 새겼습니다. 확인되기까지 몇 분 걸리고, 그동안 손님 화면은 옛 정보를 볼 수 있습니다.",
    }))
}

#[cfg(test)]
mod tests {
    /// 🔴 **체인이 먼저, 파일이 나중.** 파일을 먼저 바꿔 놓고 재발행이
    ///    실패하면 그 순간부터 가게가 죽는다 — 새 열쇠로 글을 쓰는데 체인은
    ///    옛 공개키를 가리킨다. 손님 화면에서 주문 단추가 사라진다.
    #[test]
    fn 재발행이_성공한_뒤에_열쇠를_바꾼다() {
        let src = include_str!("shopmove.rs");
        let i = src.find("pub async fn shop_key_move(").expect("옮기는 함수가 있어야 한다");
        let end = src[i..].find("#[cfg(test)]").unwrap_or(src.len() - i);
        let body = &src[i..i + end];
        let reissue = body.find("issue2::reissue").expect("재발행하는 줄이 있어야 한다");
        let install = body.find("install_seed_key").expect("열쇠를 바꾸는 줄이 있어야 한다");
        assert!(
            reissue < install,
            "열쇠를 먼저 바꾸고 있다 — 재발행이 실패하면 가게가 죽는다"
        );
    }

    /// 재발행을 잠그면 결제 주소도 간판 열쇠도 **영영** 못 바꾼다.
    #[test]
    fn 재발행_가능을_잠그지_않는다() {
        let src = include_str!("shopmove.rs");
        let i = src.find("issue2::reissue").expect("재발행하는 줄이 있어야 한다");
        let seg = &src[i..i + 400.min(src.len() - i)];
        assert!(
            !seg.contains("false,"),
            "재발행 가능을 끄고 있다 — 다음에 정보를 못 고친다"
        );
    }

    /// 상한을 그대로 넣으면 이미 있는 수량만큼 넘쳐서 거래가 통째로 실패한다.
    /// 그 계산을 사장에게 시키면 안 된다.
    #[test]
    fn 넣을_수_있는_최대를_우리가_계산한다() {
        let src = include_str!("shopmove.rs");
        assert!(
            src.contains("MAX_UNITS - amount"),
            "남은 자리를 계산하지 않고 있다 — 상한을 넣으면 실패한다"
        );
    }
}
