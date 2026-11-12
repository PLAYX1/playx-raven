//! 오락실 「일반 판매자」 올리기 — Nostr 알림 쪽지 rv.arcade-listing/1 (kind 31405). 체인 거래 없음, 0 RVN. (2026-11-13, 대표 승인)
//!
//! 형식 정본 = 지갑 저장소 `core/creator/arcade-listing.ts`(이 저장소에도 같은 파일). 여기 러스트는 **겉봉투만** 싼다:
//!   · 안쪽 서명(판매자 주소의 레이븐 메시지 서명)은 화면이 노드 `signmessage`(walletx::sign_message)로 받아 content 에 넣어 온다.
//!   · 겉봉투 열쇠 = 가게 열쇠에서 표식을 붙여 따로 뽑은 열쇠(지도 열쇠와 같은 방식, 표식만 다르다). 12단어에서 나오므로 다시 깔아도 같다.
//!     같은 열쇠라 같은 d 의 쪽지가 릴레이에서 교체된다(고치기·내리기).
//! 🔴 content 를 그대로 믿지 않는다 — 모양을 다시 보고, 키 순서를 core 와 같게 다시 짜서 싼다(다른 칸은 버려진다).
//! 🔴 안쪽 서명이 맞는지는 TS(core recoverArcadeSigner)가 서명 직후 확인하고, 읽는 쪽(폰·웹·데스크탑)이 다시 확인한다.
use serde_json::{json, Map, Value};

pub const ARCADE_LISTING_KIND: i64 = 31405;
pub const ARCADE_LISTING_TAG: &str = "ravenvault-arcade";
pub const ARCADE_LISTING_FORMAT: &str = "rv.arcade-listing/1";
/// ⚠️ 표식 문자열은 바꾸지 마라 — 바꾸면 겉봉투 열쇠가 바뀌어 이미 올린 쪽지를 고치거나 내리지 못한다.
pub const ARCADE_NOSTR_TAG: &str = "PLAYX-RAVEN-ARCADENOSTR-v1";
const DELETE_KIND: i64 = 5;

fn now() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0)
}

/// 겉봉투 비밀값 — 가게 열쇠 + 표식의 sha256. 밖으로 나가지 않는다.
pub fn derive_arcade_key(shop_secret: &[u8; 32]) -> [u8; 32] {
    use sha2::{Digest, Sha256};
    let mut h = Sha256::new();
    h.update(ARCADE_NOSTR_TAG.as_bytes());
    h.update(shop_secret);
    h.finalize().into()
}
fn key() -> Result<[u8; 32], String> {
    Ok(derive_arcade_key(&crate::shopkey::secret_for_derivation()?))
}

fn is_seller(s: &str) -> bool {
    s.len() == 34 && s.starts_with('R') && s.bytes().all(|b| b.is_ascii_alphanumeric() && !matches!(b, b'0' | b'O' | b'I' | b'l'))
}
fn is_id(s: &str) -> bool {
    let b = s.as_bytes();
    (3..=40).contains(&b.len())
        && b.iter().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || *c == b'-')
        && b[0] != b'-' && b[b.len() - 1] != b'-'
}
fn is_cid(s: &str) -> bool {
    let v0 = s.len() == 46 && s.starts_with("Qm") && s.bytes().all(|b| b.is_ascii_alphanumeric() && !matches!(b, b'0' | b'O' | b'I' | b'l'));
    let v1 = s.len() == 59 && s.starts_with('b') && s.bytes().skip(1).all(|b| b.is_ascii_lowercase() || (b'2'..=b'7').contains(&b));
    v0 || v1
}
fn is_hex64(s: &str) -> bool { s.len() == 64 && s.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)) }
fn is_sig(s: &str) -> bool { s.len() == 88 && s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'+' || b == b'/' || b == b'=') }

/// 화면이 보낸 content → core 와 같은 키 순서로 다시 짠 content + d. 틀리면 첫 문제.
pub fn normalize_content(raw: &str, now: i64) -> Result<(String, String, i64, String), String> {
    let v: Value = serde_json::from_str(raw).map_err(|_| "쪽지 내용을 읽지 못했습니다.".to_string())?;
    let o = v.as_object().ok_or("쪽지 내용이 객체가 아닙니다.")?;
    let s = |k: &str| o.get(k).and_then(Value::as_str).unwrap_or("");
    let i = |k: &str| o.get(k).and_then(Value::as_i64).unwrap_or(-1);
    if s("kind") != ARCADE_LISTING_FORMAT { return Err("쪽지 형식이 다릅니다.".into()); }
    let (seller, id, cid, hash, state, sig) = (s("seller"), s("id"), s("docCid"), s("docHash"), s("state"), s("signature"));
    let (version, at) = (i("version"), i("at"));
    if !is_seller(seller) { return Err("판매자 주소가 올바르지 않습니다.".into()); }
    if !is_id(id) { return Err("게임 id 가 올바르지 않습니다.".into()); }
    if !(1..=1_000_000_000).contains(&version) { return Err("판(version)이 올바르지 않습니다.".into()); }
    if !is_cid(cid) || !is_hex64(hash) { return Err("상품 문서 주소·해시가 올바르지 않습니다.".into()); }
    if state != "open" && state != "removed" { return Err("올림/내림 상태가 올바르지 않습니다.".into()); }
    if (at - now).abs() > 600 { return Err("시각이 올바르지 않습니다. 컴퓨터 시계를 확인해 주세요.".into()); }
    if !is_sig(sig) { return Err("판매자 서명 모양이 올바르지 않습니다.".into()); }
    let mut m = Map::new();
    m.insert("kind".into(), json!(ARCADE_LISTING_FORMAT));
    m.insert("seller".into(), json!(seller));
    m.insert("id".into(), json!(id));
    m.insert("version".into(), json!(version));
    m.insert("docCid".into(), json!(cid));
    m.insert("docHash".into(), json!(hash));
    m.insert("at".into(), json!(at));
    m.insert("state".into(), json!(state));
    m.insert("signature".into(), json!(sig));
    Ok((serde_json::to_string(&Value::Object(m)).unwrap_or_default(), format!("{seller}/{id}"), at, state.to_string()))
}

/// 알림 쪽지 이벤트(겉봉투 서명까지). 내림이면 NIP-09 지우기도 하나 더(지우기를 지키는 릴레이에서는 바로 사라진다).
pub fn build_events(nostr_sk: &[u8; 32], raw_content: &str, now: i64) -> Result<Vec<Value>, String> {
    let (content, d, at, state) = normalize_content(raw_content, now)?;
    let tags = json!([["d", d], ["t", ARCADE_LISTING_TAG]]);
    let ev = crate::shopkey::sign_with(nostr_sk, ARCADE_LISTING_KIND, tags, &content, at)?;
    let mut out = vec![ev];
    if state == "removed" {
        let pk = crate::shopkey::pubkey_of(nostr_sk)?;
        let del_tags = json!([["a", format!("{ARCADE_LISTING_KIND}:{pk}:{d}")], ["k", ARCADE_LISTING_KIND.to_string()]]);
        out.push(crate::shopkey::sign_with(nostr_sk, DELETE_KIND, del_tags, "", at)?);
    }
    Ok(out)
}

/// 겉봉투 공개키(x-only 64 hex) — 화면이 안쪽 서명 문구에 넣는다.
#[tauri::command(async)]
pub fn arcade_listing_pubkey() -> Result<String, String> {
    crate::shopkey::pubkey_of(&key()?)
}

/// 알림 쪽지 올리기(올림·고치기·내리기). 사람이 「올리기」·「내리기」를 누른 뒤에만 불린다.
#[tauri::command]
pub async fn arcade_listing_publish(content: String) -> Result<Value, String> {
    if crate::app_lock::is_locked() { return Err("앱이 잠겨 있습니다.".into()); }
    let events = build_events(&key()?, &content, now())?;
    let mut answers = Vec::new();
    for ev in events {
        answers.push(crate::nostrpub::nostr_publish(ev).await?);
    }
    Ok(json!({ "published": answers.len(), "answers": answers }))
}

/// 목록 읽기용: 릴레이에서 kind 31405 · #t ravenvault-arcade (고정 물음, 300개까지). 실패는 빈 목록.
pub async fn read_listings() -> Vec<Value> {
    crate::nostrpub::nostr_query_tag(vec![ARCADE_LISTING_KIND], "t".into(), vec![ARCADE_LISTING_TAG.into()], 200)
        .await
        .unwrap_or_default()
        .into_iter()
        .filter(|e| e.get("kind").and_then(Value::as_i64) == Some(ARCADE_LISTING_KIND) && e.get("content").and_then(Value::as_str).is_some_and(|c| c.len() <= 4096))
        .take(300)
        .collect()
}

/// 쪽지 content 의 문서 CID(모양만 — 믿는 것은 TS 가 서명을 본 뒤).
pub fn doc_cid_of(e: &Value) -> Option<String> {
    let c: Value = serde_json::from_str(e.get("content")?.as_str()?).ok()?;
    if c.get("state")?.as_str()? != "open" { return None; }
    let cid = c.get("docCid")?.as_str()?;
    is_cid(cid).then(|| cid.to_string())
}

/// 이 컴퓨터가 올린 일반 판매자 게임(「내 게임 보관」용): 내 겉봉투 열쇠(my_pk)로 서명이 맞는 쪽지만, 같은 d 는 가장 새것 하나,
/// 그것이 open 일 때만 (d, 문서 CID). 내린 게임(removed)은 빠진다.
pub fn my_open_docs(events: &[Value], my_pk: &str) -> Vec<(String, String)> {
    let mut best: std::collections::BTreeMap<String, (i64, &Value)> = std::collections::BTreeMap::new();
    for e in events {
        if e.get("pubkey").and_then(Value::as_str) != Some(my_pk) || !crate::relay::verify(e) { continue; }
        let Some(d) = e.get("tags").and_then(Value::as_array).and_then(|t| t.iter().find(|x| x.get(0).and_then(Value::as_str) == Some("d"))).and_then(|x| x.get(1)).and_then(Value::as_str) else { continue };
        let at = e.get("created_at").and_then(Value::as_i64).unwrap_or(0);
        if best.get(d).map_or(true, |(a, _)| at > *a) { best.insert(d.to_string(), (at, e)); }
    }
    best.into_iter().filter_map(|(d, (_, e))| doc_cid_of(e).map(|c| (d, c))).collect()
}
/// 내 겉봉투 공개키(가게 열쇠가 없으면 None).
pub fn my_pubkey() -> Option<String> { arcade_listing_pubkey().ok() }

#[cfg(test)]
mod tests {
    use super::*;

    const SELLER: &str = "RHMKPy3Ana5NyzTgo6qWXXMiHAxzPyMgG1";
    fn content(state: &str, at: i64) -> String {
        json!({ "signature": "A".repeat(87) + "=", "state": state, "at": at, "docHash": "a".repeat(64), "docCid": format!("Qm{}", "W".repeat(44)),
            "version": 2, "id": "star-run", "seller": SELLER, "kind": ARCADE_LISTING_FORMAT, "extra": "dropped" }).to_string()
    }

    #[test]
    fn 쪽지는_core_와_같은_키_순서로_다시_짜서_싼다() {
        let evs = build_events(&[7u8; 32], &content("open", 1_790_000_000), 1_790_000_100).unwrap();
        assert_eq!(evs.len(), 1);
        let e = &evs[0];
        assert_eq!(e["kind"], 31405);
        assert_eq!(e["tags"], json!([["d", format!("{SELLER}/star-run")], ["t", "ravenvault-arcade"]]));
        assert_eq!(e["created_at"], 1_790_000_000);
        let c = e["content"].as_str().unwrap();
        assert!(c.starts_with(&format!("{{\"kind\":\"rv.arcade-listing/1\",\"seller\":\"{SELLER}\",\"id\":\"star-run\",\"version\":2,")), "{c}");
        assert!(!c.contains("extra"));
        assert!(crate::relay::verify(e), "겉봉투 id·BIP340 가 맞다");
    }

    #[test]
    fn 내리기는_지우기_이벤트도_같이() {
        let evs = build_events(&[7u8; 32], &content("removed", 1_790_000_000), 1_790_000_000).unwrap();
        assert_eq!(evs.len(), 2);
        assert_eq!(evs[1]["kind"], 5);
        let pk = crate::shopkey::pubkey_of(&[7u8; 32]).unwrap();
        assert_eq!(evs[1]["tags"][0], json!(["a", format!("31405:{pk}:{SELLER}/star-run")]));
    }

    #[test]
    fn 틀린_쪽지는_싸지_않는다() {
        let base: Value = serde_json::from_str(&content("open", 1_790_000_000)).unwrap();
        let with = |k: &str, v: Value| { let mut b = base.clone(); b[k] = v; b.to_string() };
        for bad in [
            with("kind", json!("rv.shop-link/1")), with("seller", json!("not-an-address")), with("id", json!("A_B")), with("version", json!(0)),
            with("docCid", json!("../../etc")), with("docHash", json!("xyz")), with("state", json!("gone")), with("signature", json!("short")),
            with("at", json!(1_790_009_999)), "not json".into(),
        ] {
            assert!(build_events(&[7u8; 32], &bad, 1_790_000_000).is_err(), "{bad}");
        }
    }

    #[test]
    fn 겉봉투_열쇠는_따로_고정() {
        let k = derive_arcade_key(&[1u8; 32]);
        assert_eq!(k, derive_arcade_key(&[1u8; 32]));
        let (rk, nk) = crate::map_format::derive_map_keys(&[1u8; 32]);
        assert!(k != rk && k != nk && k != [1u8; 32], "지도·가게 열쇠와 다르다");
    }

    #[test]
    fn 목록용_문서_cid_는_올림_쪽지에서만() {
        let open = json!({ "content": content("open", 1) });
        let gone = json!({ "content": content("removed", 1) });
        assert_eq!(doc_cid_of(&open).as_deref(), Some(format!("Qm{}", "W".repeat(44)).as_str()));
        assert_eq!(doc_cid_of(&gone), None);
        assert_eq!(doc_cid_of(&json!({ "content": "{\"state\":\"open\",\"docCid\":\"../x\"}" })), None);
    }

    #[test]
    fn 릴레이_중계는_31405_를_받는다() {
        let evs = build_events(&[7u8; 32], &content("open", now()), now()).unwrap();
        assert!(crate::nostrpub::validate_publish_event(&evs[0]).is_ok());
        let mut no_d = evs[0].clone();
        no_d["tags"] = json!([["t", "ravenvault-arcade"]]);
        assert!(crate::nostrpub::validate_publish_event(&no_d).is_err());
    }

    #[test]
    fn 내_게임은_내_열쇠로_서명된_가장_새_쪽지만() {
        let me = [7u8; 32];
        let pk = crate::shopkey::pubkey_of(&me).unwrap();
        let other = build_events(&[8u8; 32], &content("open", 1_790_000_000), 1_790_000_000).unwrap();
        let open1 = build_events(&me, &content("open", 1_790_000_000), 1_790_000_000).unwrap();
        let got = my_open_docs(&[open1[0].clone(), other[0].clone()], &pk);
        assert_eq!(got.len(), 1, "남의 열쇠 쪽지는 내 게임이 아니다");
        // 서명을 망가뜨린 쪽지(내 공개키를 흉내)는 버린다
        let mut fake = open1[0].clone(); fake["content"] = json!(fake["content"].as_str().unwrap().replace("open", "open "));
        assert!(my_open_docs(&[fake], &pk).is_empty());
        // 더 새 내림 쪽지가 있으면 빠진다
        let removed = build_events(&me, &content("removed", 1_790_000_100), 1_790_000_100).unwrap();
        assert!(my_open_docs(&[open1[0].clone(), removed[0].clone()], &pk).is_empty());
    }
}
