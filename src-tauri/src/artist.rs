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
const NAME_MAX: usize = 40;
const ABOUT_MAX: usize = 300;
const LINK_MAX: usize = 300;

/// 손님이 누르는 주소. `https` 만 받는다.
///
/// 🔴 이 글자는 **남의 화면에서 눌린다.** `javascript:` 나 `data:` 가
///    들어오면 우리가 뿌리는 공격이 된다. `http` 도 안 받는다 — 얼굴·이름이
///    실린 페이지에서 중간자 한 번이면 링크가 바뀐다.
fn check_website(raw: &str) -> Result<String, String> {
    let l = raw.trim();
    if l.is_empty() {
        return Ok(String::new());
    }
    if l.chars().count() > LINK_MAX {
        return Err("링크가 너무 깁니다.".into());
    }
    if l.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return Err("링크에 띄어쓰기나 줄바꿈이 들어 있습니다. 주소만 붙여넣어 주세요.".into());
    }
    let low = l.to_ascii_lowercase();
    if !low.starts_with("https://") {
        return Err("링크는 https:// 로 시작해야 합니다.".into());
    }
    Ok(l.to_string())
}

/// 얼굴 주소. 비워도 된다. 있으면 `https` 만.
fn check_picture(raw: &str) -> Result<String, String> {
    let p = raw.trim();
    if p.is_empty() {
        return Ok(String::new());
    }
    if p.chars().count() > 400 {
        return Err("사진 주소가 너무 깁니다.".into());
    }
    if p.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return Err("사진 주소에 띄어쓰기가 들어 있습니다.".into());
    }
    let low = p.to_ascii_lowercase();
    if !low.starts_with("https://") {
        return Err("사진 주소는 https:// 로 시작해야 합니다.".into());
    }
    Ok(p.to_string())
}

/// NIP-01 이름표 본문. 우리만 아는 칸을 넣지 않는다 — 넣으면 damus·primal
/// 에서 안 보인다.
fn profile_body(name: &str, about: &str, picture: &str, website: &str) -> Result<String, String> {
    if name.chars().count() > NAME_MAX {
        return Err("이름이 너무 깁니다. 40자 아래로 줄여 주세요.".into());
    }
    if about.chars().count() > ABOUT_MAX {
        return Err("소개가 너무 깁니다. 300자 아래로 줄여 주세요.".into());
    }
    let website = check_website(website)?;
    let picture = check_picture(picture)?;
    Ok(json!({
        "name": name,
        "about": about,
        "picture": picture,
        "website": website,
    })
    .to_string())
}

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
    let body = profile_body(name.trim(), about.trim(), picture.trim(), website.trim())?;

    let sk = key()?;
    // ⚠️ 이름표에는 표(`t`)를 안 붙인다. 개인 이름표(`talk_profile_set`)와
    //    같은 이유 — 붙이면 이야기 목록에 이름표가 섞여 나온다.
    let ev = crate::shopkey::sign_with(&sk, KIND_PROFILE, json!([]), &body, now())?;

    // 🔴 **어디에 올라갔는지를 버리지 않는다.** 여태 결과를 통째로 흘렸고,
    //    화면은 한 곳만 받아도 「올렸습니다」라고 똑같이 말했다. damus 는
    //    실측 다섯 번 중 한두 번만 붙는다(2026-08-31) — 한 곳만 받았으면
    //    팬 대부분은 아직 옛 이름표를 본다. 그건 사장이 알아야 한다.
    let sent = crate::nostrpub::nostr_publish(ev.clone()).await?;
    Ok(json!({
        "event": ev,
        "ok": sent.get("ok").cloned().unwrap_or_else(|| json!([])),
        "failed": sent.get("failed").cloned().unwrap_or_else(|| json!([])),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 🔴 **사진은 주소만 받는다 — 사진 자체를 담으면 안 된다.**
    ///    담으면 이름표가 32KB 를 넘어 릴레이가 **조용히 버린다**. 그래서
    ///    화면은 파일창고에 올리고 `https://` 주소만 넣는다. 이 문이 열리면
    ///    그 약속이 조용히 깨진다.
    ///
    ///    ⚠️ 같이 잰다 — **정상 주소는 반드시 통과해야 한다.** 막기만 하는
    ///       검사는 사장이 사진을 아예 못 올리게 만든다.
    #[test]
    fn picture_takes_a_link_not_the_photo_itself() {
        assert!(check_picture("data:image/jpeg;base64,AAAA").is_err(), "사진을 담는 길이 열렸다");
        assert!(check_picture("http://ipfs.io/ipfs/Qm123").is_err(), "https 가 아닌데 통과했다");
        assert_eq!(
            check_picture("https://ipfs.io/ipfs/QmcBEcFJ2YsS13vbBWg8ZMjPEmqegGeYDxb88JeTx6gcYT").unwrap(),
            "https://ipfs.io/ipfs/QmcBEcFJ2YsS13vbBWg8ZMjPEmqegGeYDxb88JeTx6gcYT",
            "화면이 실제로 만드는 주소가 막힌다"
        );
        assert_eq!(check_picture("").unwrap(), "", "비우는 것도 사람이 할 수 있어야 한다");
    }

    /// 🔴 **개인 열쇠와 같아지면 안 된다.** 같아지는 날 개인 대화와
    ///    아티스트가 한 사람으로 묶이고, 그건 되돌릴 수 없다(체인에 박혀 있다).
    #[test]
    fn artist_key_is_not_the_person_key() {
        let m = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
        let a = crate::identity::artist_key_from(m, "").unwrap();
        let p = crate::identity::person_key_from(m, "").unwrap();
        assert_ne!(a, p, "아티스트와 사람 열쇠가 같으면 정체성이 묶인다");
    }

    #[test]
    fn empty_name_is_allowed() {
        let b = profile_body("", "한 줄", "", "").unwrap();
        let v: Value = serde_json::from_str(&b).unwrap();
        assert_eq!(v["name"], json!(""));
        assert_eq!(v["about"], json!("한 줄"));
    }

    #[test]
    fn nip01_field_names_only() {
        let b = profile_body("PLAY X", "소개", "https://ipfs.io/ipfs/Qm1", "https://x.com/playx").unwrap();
        let v: Value = serde_json::from_str(&b).unwrap();
        assert_eq!(v["name"], json!("PLAY X"));
        assert_eq!(v["about"], json!("소개"));
        assert_eq!(v["picture"], json!("https://ipfs.io/ipfs/Qm1"));
        assert_eq!(v["website"], json!("https://x.com/playx"));
        let obj = v.as_object().unwrap();
        assert_eq!(obj.len(), 4, "우리만 아는 칸을 넣으면 남의 앱에서 안 보인다");
    }

    #[test]
    fn name_too_long_is_refused() {
        let long = "가".repeat(NAME_MAX + 1);
        assert!(profile_body(&long, "", "", "").is_err());
    }

    #[test]
    fn about_too_long_is_refused() {
        let long = "가".repeat(ABOUT_MAX + 1);
        assert!(profile_body("", &long, "", "").is_err());
    }

    #[test]
    fn website_must_be_https() {
        assert!(check_website("").unwrap().is_empty());
        assert_eq!(
            check_website("https://instagram.com/playx").unwrap(),
            "https://instagram.com/playx"
        );
        assert!(check_website("http://instagram.com/playx").is_err());
        assert!(check_website("javascript:alert(1)").is_err());
        assert!(check_website("data:text/html,x").is_err());
        assert!(check_website("https://x.com/a b").is_err());
        assert!(check_website("ftp://x.com").is_err());
    }

    #[test]
    fn picture_must_be_https() {
        assert!(check_picture("").unwrap().is_empty());
        assert!(check_picture("https://ipfs.io/ipfs/Qm1").is_ok());
        assert!(check_picture("http://127.0.0.1:8080/ipfs/Qm1").is_err());
        assert!(check_picture("javascript:alert(1)").is_err());
        assert!(check_picture("data:image/png;base64,xx").is_err());
    }

    /// 올리는 함수가 **아티스트 열쇠**로 서명하는가. 개인 대화 열쇠로
    /// 바꾸면 체인에 박힌 공개키와 안 맞고, 손님 화면은 이름표를 못 붙인다.
    #[test]
    fn 올리는_손은_아티스트_열쇠다() {
        let src = include_str!("artist.rs");
        let i = src
            .find("fn key()")
            .expect("아티스트 열쇠를 고르는 곳이 있어야 한다");
        let rest = &src[i..];
        let end = rest.find("\n///").or_else(|| rest.find("\n#[")).unwrap_or(280);
        let body = &rest[..end];
        assert!(
            body.contains("artist_key"),
            "아티스트 열쇠를 안 고른다 — 올리면 체인이 가리키는 사람과 다른 사람이 된다"
        );
        assert!(
            !body.contains("person_key"),
            "사람 열쇠로 고르고 있다 — 개인 대화와 아티스트가 한 사람으로 묶인다"
        );
        assert!(
            !body.contains("talk::"),
            "이야기 열쇠로 고르고 있다"
        );
    }

    /// 이름표에 표(`t`)를 붙이면 이야기 목록에 섞여 나온다.
    #[test]
    fn 이름표에는_표를_안_붙인다() {
        let src = include_str!("artist.rs");
        let i = src
            .find("pub async fn artist_profile_set")
            .expect("올리는 함수가 있어야 한다");
        let rest = &src[i..];
        let end = rest.find("\n#[cfg(test)]").unwrap_or(rest.len());
        let body = &rest[..end];
        assert!(
            body.contains("json!([])"),
            "이름표 태그가 비어 있어야 한다"
        );
        assert!(
            !body.contains("TALK_TAG") && !body.contains("\"t\""),
            "이름표에 이야기 표를 붙이고 있다"
        );
        assert!(
            body.contains("KIND_PROFILE"),
            "kind 0 이 아니면 damus·primal 이 이름표로 안 읽는다"
        );
    }

    /// 나눠주기를 자산 단추로 내렸다가 못 찾으셨다. 같은 실수를 여기서
    /// 반복하면 안 된다 — 1차 메뉴에 「내 소개」가 있어야 한다.
    #[test]
    fn 화면이_1차_메뉴에_있다() {
        let html = include_str!("../../index.html");
        assert!(
            html.contains("data-page=\"artist\""),
            "1차 메뉴에 「내 소개」가 없다"
        );
        assert!(
            html.contains("id=\"page-artist\""),
            "내 소개 화면이 없다"
        );
        let nav = html
            .split("<nav>")
            .nth(1)
            .and_then(|r| r.split("</nav>").next())
            .unwrap_or("");
        assert!(
            nav.contains(">내 소개</span>"),
            "사이드바에 「내 소개」 글자가 없다 — 아이콘만 있으면 40~70대가 못 읽는다"
        );
    }
}
