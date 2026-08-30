//! 아티스트 이름표 — **체인이 가리키는 그 열쇠로** 얼굴과 이름을 올린다.
//!
//! ## 왜 개인 이름표와 따로인가
//!
//! 체인 자산(`PLAYX`)에 **아티스트 전용 열쇠**(`m/44'/175'/7'/2'/0'`)의
//! 공개키가 박혀 있다. 그러니 손님이 「이게 진짜 그 아티스트인가」를 물으면
//! 답은 하나다 — **그 열쇠가 서명했는가.**
//!
//! 개인 열쇠(`7'/0/0`)로 올리면 그 검증이 통과하지 않는다. 그리고 통과하게
//! 만들려고 개인 열쇠를 체인에 박으면, 방에서 한 잡담·1:1 문의·중고로 판
//! 자전거가 전부 「그 아티스트」와 한 사람이 된다. **경로를 나눈 이유가
//! 그것이다.** 여기서 섞으면 그 값이 헛것이 된다.
//!
//! ## 무엇이 어디에 있나
//!
//! | 어디 | 무엇 | 고치는 값 |
//! |---|---|---|
//! | 체인 자산 | 열쇠 · 받을 주소 | 재발행 100 RVN |
//! | **여기(Nostr kind 0)** | **얼굴 · 이름 · 소개 · 링크** | **공짜 · 즉시 · 무제한** |
//!
//! 대표님이 「언제든 수정」하고 싶어 하신 것은 전부 아래쪽이다.
//!
//! ## ⚠️ 릴레이가 지울 수 있다
//!
//! 이 글은 우리 서버에 안 남는다. 릴레이가 들고 있다가 지울 수 있다.
//! 다만 **12단어만 있으면 똑같이 다시 올린다** — 열쇠가 같으면 같은
//! 아티스트다. 체인 이름과 달리 영영 잃는 것이 아니다.

use serde_json::{json, Value};

/// 프로필 글의 종류(NIP-01 kind 0). 개인 이름표와 **같은 종류**다 —
/// 다른 것은 **어느 열쇠가 서명했나**뿐이고, 그게 전부여야 한다.
const KIND_PROFILE: i64 = 0;

fn now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

fn key() -> Result<[u8; 32], String> {
    crate::identity::artist_key()
        .ok_or_else(|| "12단어를 읽지 못했습니다. 지갑이 잠겨 있으면 먼저 열어 주세요.".to_string())
}

/// 이 컴퓨터의 아티스트 공개키. **체인에 박힌 것과 같아야 한다.**
#[tauri::command]
pub fn artist_pubkey() -> Result<Value, String> {
    let sk = key()?;
    let pk = crate::shopkey::pubkey_of(&sk)?;
    Ok(json!({ "pubkey": pk }))
}

/// 체인의 자산이 가리키는 공개키와 **이 컴퓨터의 것이 같은가.**
///
/// 🔴 다르면 올려 봐야 소용이 없다. 손님 화면은 체인이 가리키는 열쇠만
///    믿으므로, 다른 열쇠로 올린 이름표는 **아무 데도 안 붙는다.**
///    올리기 전에 말해 준다 — 올린 뒤에 알면 왜 안 보이는지 모른다.
#[tauri::command]
pub async fn artist_check(asset: String) -> Result<Value, String> {
    let mine = crate::shopkey::pubkey_of(&key()?)?;
    let d = crate::raven::call_rpc("getassetdata", json!([asset.trim()])).await?;
    let cid = d
        .get("ipfs_hash")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    if cid.is_empty() {
        return Ok(json!({
            "ok": false, "mine": mine, "chain": "",
            "why": "이 자산에는 아직 프로필이 안 붙어 있습니다.",
        }));
    }
    // 🔴 `ipfs::read_json` 은 **내가 지어낸 이름**이었다. 이 저장소에는 없다.
    //    없는 함수를 부르면 컴파일이 막아 주지만, 이름을 짐작하는 버릇 자체가
    //    위험하다 — 화면 쪽이었으면 조용히 안 돌았을 것이다.
    //    게이트웨이로 직접 읽는다(`ipfs.rs` 가 쓰는 것과 같은 자리).
    let url = format!("http://127.0.0.1:8080/ipfs/{cid}/metadata.json");
    let doc: Value = reqwest::Client::new()
        .get(&url)
        .timeout(std::time::Duration::from_secs(15))
        .send()
        .await
        .map_err(|e| format!("프로필을 못 읽었습니다 — {e}"))?
        .json()
        .await
        .map_err(|e| format!("프로필이 JSON 이 아닙니다 — {e}"))?;
    let chain = doc
        .pointer("/rip0014/metadata/other_data/nostr_pubkey")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let ok = !chain.is_empty() && chain == mine;
    Ok(json!({
        "ok": ok,
        "mine": mine,
        "chain": chain,
        "why": if ok { "" } else if chain.is_empty() {
            "체인 프로필에 열쇠가 안 적혀 있습니다."
        } else {
            "체인이 가리키는 열쇠와 이 컴퓨터의 열쇠가 다릅니다. 12단어가 같은지 확인해 주세요."
        },
    }))
}

/// 지금 올라가 있는 아티스트 이름표.
#[tauri::command]
pub async fn artist_profile_get() -> Result<Value, String> {
    let pk = crate::shopkey::pubkey_of(&key()?)?;
    let got = crate::nostrpub::nostr_query_authors(vec![KIND_PROFILE], vec![pk.clone()], 30).await?;
    let body = got
        .first()
        .and_then(|e| e.get("content").and_then(Value::as_str))
        .and_then(|c| serde_json::from_str::<Value>(c).ok())
        .unwrap_or_else(|| json!({}));
    Ok(json!({
        "pubkey": pk,
        "name": body.get("name").and_then(Value::as_str).unwrap_or(""),
        "about": body.get("about").and_then(Value::as_str).unwrap_or(""),
        "picture": body.get("picture").and_then(Value::as_str).unwrap_or(""),
        "website": body.get("website").and_then(Value::as_str).unwrap_or(""),
    }))
}

/// 아티스트 이름표를 올린다.
///
/// ⚠️ 이름을 **비울 수 있게** 둔다. 「이름을 지웠다」도 사람이 할 수 있어야
///    하는 일이고, 개인 이름표도 같은 규칙이다.
#[tauri::command]
pub async fn artist_profile_set(
    name: String,
    about: String,
    picture: String,
    website: String,
) -> Result<Value, String> {
    let name = name.trim();
    if name.chars().count() > 40 {
        return Err("이름이 너무 깁니다. 40자 아래로 줄여 주세요.".into());
    }
    let about = about.trim();
    if about.chars().count() > 300 {
        return Err("소개가 너무 깁니다. 300자 아래로 줄여 주세요.".into());
    }
    // 🔴 링크는 남이 누르는 값이다. `https` 만 받는다 — `javascript:` 가
    //    들어오면 그건 우리가 뿌리는 공격이 된다.
    let website = website.trim();
    if !website.is_empty() && !website.starts_with("https://") {
        return Err("링크는 https:// 로 시작해야 합니다.".into());
    }
    if website.chars().count() > 300 {
        return Err("링크가 너무 깁니다.".into());
    }

    let sk = key()?;
    // NIP-01 의 표준 이름들만 쓴다. 우리만 아는 이름을 지어내면 damus·primal
    // 같은 남의 앱에서 안 보인다 — 아티스트 이름표는 밖에서도 보여야 한다.
    let body = json!({
        "name": name,
        "about": about,
        "picture": picture.trim(),
        "website": website,
    })
    .to_string();
    let ev = crate::shopkey::sign_with(&sk, KIND_PROFILE, json!([]), &body, now())?;
    crate::nostrpub::nostr_publish(ev.clone()).await?;
    Ok(ev)
}

#[cfg(test)]
mod tests {
    /// 🔴 **개인 열쇠와 같아지면 안 된다.** 같아지는 날 개인 대화와
    ///    아티스트가 한 사람으로 묶이고, 그건 되돌릴 수 없다(체인에 박혀 있다).
    #[test]
    fn artist_key_is_not_the_person_key() {
        let m = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
        let a = crate::identity::artist_key_from(m, "").unwrap();
        let p = crate::identity::person_key_from(m, "").unwrap();
        assert_ne!(a, p, "아티스트와 사람 열쇠가 같으면 정체성이 묶인다");
    }
}
