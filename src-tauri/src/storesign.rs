//! 가게 서명 — 기기 증서·철회 목록·상품 문서·가게 문서에 쓰는 **가게 전용 열쇠**로 서명한다.
//!
//! 🔴 11-11: 화면이 준 「아무 32바이트」에 서명하던 `store_sign_digest` 를 없앴다. 화면이 뚫리면 사유 글만 그럴듯하게 쓰고
//! 다른 문서(예: 기기 증서)의 다이제스트를 내밀 수 있었다. 이제 `store_sign_doc(kind, body)` — Rust 가 **본문**을 받아
//! 종류별 도메인으로 서명 문구를 직접 만들고(`<도메인>\nsha256:<정본 JSON 해시>` → signmessage 해시), 확인 창에는 화면 글이 아니라
//! 본문 안의 실제 값(기기 열쇠·기한, 상품 이름·가격, 가게 이름)을 보인다. 서명 바이트는 예전과 같다(검증하는 폰·웹은 그대로).
//!
//! ## 🔴 규칙
//! * 열쇠는 이 파일 안에만 있다. 12단어는 서명할 때마다 노드에서 받아 → 열쇠를 뽑고 → 서명하고 → **바로 지운다**(저장·캐시 없음).
//!   화면(JS)에는 공개키와 서명만 나간다. 오류·로그에는 다이제스트·사유·열쇠·단어를 **한 글자도** 싣지 않는다(고정 문장만).
//! * 앱 잠금이 걸려 있으면 거절한다. lib.rs 문지기가 먼저 막고(`app_lock::MUST_DENY` 시험), 여기서도 한 번 더 본다.
//! * 서명 직전에 **사장에게 사유를 보여 주고 확인**을 받는다(Rust 대화상자 — 화면이 뚫려도 우회 불가).
//! * 열쇠 경로는 `identity::PATH_SHOP`(`m/44'/175'/7'/1'/0'`) — 돈 열쇠(`m/44'/175'/0'/…`)와 다른 값. 서명 형식은 코어 `signMessageWith`
//!   가 마무리한다(낮은 S · 복구번호 확정 · 자기 검증). 여기서는 RFC6979 결정적 ECDSA 의 64바이트 compact 만 낸다(낮은 S 는 libsecp 기본).
//! ⚠️ 폰의 가게 열쇠는 지갑 주소 열쇠(코어/폰 `walletMessageSigner`, 기본 경로 account0/change0/index0)라 이 열쇠와 **같지 않다** — 보고서 참고.

use secp256k1::{ecdsa, Message, PublicKey, Secp256k1, SecretKey};
use serde_json::{json, Value};


/// 화면에 내보내는 고정 오류 문장 — 입력값을 되풀이하지 않는다.
pub const ERR_LOCKED: &str = "지갑이 잠겨 있어요. 잠금을 푼 뒤 다시 해 주세요.";
pub const ERR_DOC: &str = "서명할 내용의 모양이 맞지 않아요.";
pub const ERR_SELLER: &str = "이 가게 열쇠의 문서가 아니에요.";
pub const ERR_DECLINED: &str = "사장님이 서명을 허락하지 않았어요.";
pub const ERR_KEY: &str = "가게 열쇠를 만들지 못했어요.";
pub const ERR_SIGN: &str = "서명하지 못했어요.";

/// 다른 확인 창(lan_pair·lan_rotate)이 같이 쓰는 사유 규칙: 앞뒤 공백 제거 후 1~80자, 줄바꿈·제어문자 없음.
pub const REASON_MAX_CHARS: usize = 80;
pub const ERR_REASON: &str = "서명 사유가 비었거나 맞지 않아요.";
pub fn clean_reason(s: &str) -> Result<String, &'static str> {
    let t = s.trim();
    let n = t.chars().count();
    if n == 0 || n > REASON_MAX_CHARS || t.chars().any(|c| c.is_control()) { return Err(ERR_REASON); }
    Ok(t.to_string())
}

/// 12단어에서 가게 전용 열쇠. 경로는 `identity::PATH_SHOP`.
pub fn store_secret(words: &str, pass: &str) -> Option<[u8; 32]> {
    crate::identity::shop_key_from(words, pass)
}

/// 압축 공개키 66 hex(소문자).
pub fn pubkey_hex(sk: &[u8; 32]) -> Result<String, &'static str> {
    let k = SecretKey::from_byte_array(sk).map_err(|_| ERR_KEY)?;
    Ok(hex::encode(PublicKey::from_secret_key(&Secp256k1::new(), &k).serialize()))
}

/// 다이제스트 서명(RFC6979 결정적, 낮은 S) → compact 64바이트 hex(r‖s).
pub fn sign_compact_hex(sk: &[u8; 32], digest: &[u8; 32]) -> Result<String, &'static str> {
    let k = SecretKey::from_byte_array(sk).map_err(|_| ERR_KEY)?;
    let sig: ecdsa::Signature = Secp256k1::new().sign_ecdsa(&Message::from_digest(*digest), &k);
    Ok(hex::encode(sig.serialize_compact()))
}

/// 서명할 수 있는 문서 종류 — 도메인은 여기서만 정한다(화면이 도메인을 고르지 못한다).
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum DocKind { DeviceCert, DeviceRevoke, Product, Store }
impl DocKind {
    pub fn parse(s: &str) -> Option<Self> {
        match s { "device-cert" => Some(Self::DeviceCert), "device-revoke" => Some(Self::DeviceRevoke), "product" => Some(Self::Product), "store" => Some(Self::Store), _ => None }
    }
    /// 코어 `DEVICE_CERT_DOMAIN`·`DEVICE_REVOKE_DOMAIN`·`PRODUCT_SIGN_DOMAIN`·`STORE_SIGN_DOMAIN` 과 같은 글.
    pub fn domain(self) -> &'static str {
        match self {
            Self::DeviceCert => crate::lan_cert::DEVICE_CERT_DOMAIN,
            Self::DeviceRevoke => crate::lan_cert::DEVICE_REVOKE_DOMAIN,
            Self::Product => "RAVENVAULT-PRODUCT-V1",
            Self::Store => "RAVENVAULT-STORE-V1",
        }
    }
}
pub const DOC_MAX_BYTES: usize = 64 * 1024;

/// 확인 창에 보일 글: 제어·방향 바꾸기 문자를 빼고 60자까지.
fn shown(s: &str) -> String {
    let t: String = s.chars().filter(|c| !c.is_control() && !matches!(*c as u32, 0x200E | 0x200F | 0x202A..=0x202E | 0x2066..=0x2069)).collect();
    let t = t.trim();
    if t.chars().count() > 60 { format!("{}…", t.chars().take(60).collect::<String>()) } else { t.to_string() }
}
/// 1970-01-01 부터의 ms → 「YYYY-MM-DD」(UTC). 날짜 크레이트 없이.
fn ymd(ms: i64) -> String {
    let z = ms.div_euclid(86_400_000) + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    format!("{y:04}-{m:02}-{d:02}")
}
/// 원자 단위 글(1e-8 RVN) → 「1.5」.
fn rvn_text(atoms: &str) -> Option<String> {
    if atoms.is_empty() || atoms.len() > 18 || !atoms.bytes().all(|b| b.is_ascii_digit()) { return None; }
    let n: u64 = atoms.parse().ok()?;
    let (i, f) = (n / 100_000_000, n % 100_000_000);
    Some(if f == 0 { i.to_string() } else { format!("{i}.{}", format!("{f:08}").trim_end_matches('0')) })
}

/// 본문 → (signmessage 다이제스트, 확인 창 글, 문서가 주장하는 가게 키(상품·가게 문서만)).
/// 서명 문구 = `<도메인>\nsha256:<sig 뺀 본문의 정본 JSON SHA-256>` — 코어 signingMessage·productSigningMessage·storeSigningMessage 와 같은 바이트.
pub fn doc_digest(kind: DocKind, body: &Value) -> Result<([u8; 32], String, Option<String>), &'static str> {
    use sha2::{Digest, Sha256};
    let o = body.as_object().ok_or(ERR_DOC)?;
    if o.contains_key("sig") || o.get("v").and_then(Value::as_i64) != Some(1) { return Err(ERR_DOC); }
    let text = crate::lan_proof::canonical_string(body).map_err(|_| ERR_DOC)?;
    if text.len() > DOC_MAX_BYTES { return Err(ERR_DOC); }
    let s = |k: &str| o.get(k).and_then(Value::as_str);
    let i = |k: &str| o.get(k).and_then(Value::as_i64);
    let (say, seller) = match kind {
        DocKind::DeviceCert => {
            let (role, pk, until, serial) = (s("role").ok_or(ERR_DOC)?, s("devicePubKey").ok_or(ERR_DOC)?, i("notAfter").ok_or(ERR_DOC)?, i("serial").ok_or(ERR_DOC)?);
            if !crate::lan_cert::is_public_key(pk) { return Err(ERR_DOC); }
            (format!("새 기기에 연결 증서를 줍니다.\n\n역할: {}\n기기 열쇠: {}…\n기한: {}까지\n일련번호: {serial}", shown(role), &pk[..16], ymd(until)), None)
        }
        DocKind::DeviceRevoke => {
            let n = o.get("revoked").and_then(Value::as_array).ok_or(ERR_DOC)?.len();
            (format!("기기 끊기 목록에 서명합니다.\n\n끊긴 기기: {n}대\n목록 번호: {}", i("seq").ok_or(ERR_DOC)?), None)
        }
        DocKind::Product => {
            let price = rvn_text(s("price").ok_or(ERR_DOC)?).ok_or(ERR_DOC)?;
            (format!("상품 문서에 서명합니다.\n\n상품: {}\n가격: {price} RVN\n받는 주소: {}", shown(s("title").ok_or(ERR_DOC)?), shown(s("payTo").ok_or(ERR_DOC)?)),
             Some(s("seller").ok_or(ERR_DOC)?.to_string()))
        }
        DocKind::Store => {
            let region = o.get("area").and_then(|a| a.get("region")).and_then(Value::as_str).unwrap_or("");
            (format!("가게 문서에 서명합니다.\n\n가게 이름: {}\n지역: {}", shown(s("name").ok_or(ERR_DOC)?), shown(region)), Some(s("seller").ok_or(ERR_DOC)?.to_string()))
        }
    };
    let message = format!("{}\nsha256:{}", kind.domain(), hex::encode(Sha256::digest(text.as_bytes())));
    Ok((crate::lan_cert::message_hash(&message), say, seller))
}

/// 서명 한 번의 전 과정. `words` = 노드에서 12단어를 받는 함수, `confirm` = 사장 확인(본문에서 만든 글을 받는다).
/// 순서: 잠금 → 종류·본문 → 확인 → 단어 → 열쇠 → (상품·가게: 문서의 가게 키 = 이 열쇠) → 서명 → 지우기. 실패는 고정 문장만.
pub fn sign_doc_flow<W, C>(locked: bool, kind: &str, body: &Value, confirm: C, words: W) -> Result<Value, String>
where W: FnOnce() -> Result<(String, String), String>, C: FnOnce(&str) -> bool {
    if locked { return Err(ERR_LOCKED.into()); }
    let kind = DocKind::parse(kind).ok_or(ERR_DOC)?;
    let (digest, say, seller) = doc_digest(kind, body).map_err(String::from)?;
    if !confirm(&say) { return Err(ERR_DECLINED.into()); }
    let (mut w, mut p) = words()?;
    let sk = store_secret(&w, &p);
    crate::words::wipe(&mut w);
    crate::words::wipe(&mut p);
    let mut sk = sk.ok_or_else(|| ERR_KEY.to_string())?;
    let out = (|| {
        let pk = pubkey_hex(&sk)?;
        if seller.as_deref().is_some_and(|s| s != pk) { return Err(ERR_SELLER); }
        Ok::<_, &'static str>((pk, sign_compact_hex(&sk, &digest)?))
    })();
    crate::words::wipe_bytes(&mut sk);
    let (pk, sig) = out.map_err(String::from)?;
    Ok(json!({ "store_key": pk, "sig": sig, "digest": hex::encode(digest) }))
}

/// 가게 공개키(가게 번호의 재료). 12단어는 쓰고 바로 지운다. 서명이 아니라 앱 잠금 허용 목록 밖(잠기면 거절)이다.
#[tauri::command]
pub async fn store_key_info() -> Result<Value, String> {
    if crate::app_lock::is_locked() { return Err(ERR_LOCKED.into()); }
    let (mut w, mut p) = crate::identity::words_async().await.map_err(crate::identity::SeedFailure::public_error)?;
    let sk = store_secret(&w, &p);
    crate::words::wipe(&mut w);
    crate::words::wipe(&mut p);
    let mut sk = sk.ok_or_else(|| ERR_KEY.to_string())?;
    let pk = pubkey_hex(&sk).map_err(String::from);
    crate::words::wipe_bytes(&mut sk);
    let pk = pk?;
    Ok(json!({ "store_key": pk, "fingerprint": fingerprint(&pk) }))
}

/// 키 지문 = 공개키 바이트의 SHA-256 hex(코어 `storeKeyFingerprint` 와 같은 값).
pub fn fingerprint(pk_hex: &str) -> String {
    use sha2::{Digest, Sha256};
    hex::decode(pk_hex).map(|b| hex::encode(Sha256::digest(b))).unwrap_or_default()
}

/// 문서 본문에 가게 키로 서명한다. 확인 창 글은 Rust 가 본문에서 만든다(화면이 정하지 못한다). 단어는 사장이 확인한 **뒤에** 받는다.
#[tauri::command]
pub async fn store_sign_doc(app: tauri::AppHandle, kind: String, body: Value) -> Result<Value, String> {
    use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};
    tokio::task::spawn_blocking(move || {
        sign_doc_flow(
            crate::app_lock::is_locked(), &kind, &body,
            |say| app.dialog().message(format!("가게 열쇠로 서명합니다.\n\n{say}\n\n맞으면 「확인」을 눌러 주세요."))
                .title("가게 서명 확인").buttons(MessageDialogButtons::OkCancel).blocking_show(),
            || crate::identity::words_from_node().map_err(crate::identity::SeedFailure::public_error),
        )
    }).await.map_err(|_| ERR_SIGN.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::{Cell, RefCell};
    const WORDS: &str = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
    const DIGEST: &str = "0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20";
    // core(TS, @scure/bip32)로 같은 가짜 12단어·passphrase "" 에서 m/44'/175'/7'/1'/0' 를 뽑은 값(scripts/biz-screens.test.mjs 도 같은 숫자).
    const TS_PUBKEY: &str = "037821115dd0aa762d3a393fa861ce8e784403b9e0ec578bc37e72e6e9e70a1c09";
    const TS_SIG: &str = "2e638d02c47357cba4160021eb21e518bfbbf5201c87c7f5c2e70c48c72ba10032ee07c72c73826d9cfe997b1a61412d37c8420f3033640bb36b732b0d18dd37";
    // 코어(TS)가 같은 본문으로 만든 signmessage 다이제스트(storeSigningMessage · productSigningMessage · signingMessage(DEVICE_*)) — 11-11 tsx 로 뽑음.
    const STORE: &str = r#"{"v":1,"kind":"store","seller":"037821115dd0aa762d3a393fa861ce8e784403b9e0ec578bc37e72e6e9e70a1c09","name":"무송 체육관 스토어","intro":"직접 만든 굿즈","category":"retail","area":{"region":"서울 마포"},"contacts":[],"notice":"on-request","photos":[],"rev":0,"id":null,"prev":null,"issuedAt":1790000000,"expiresAt":1797776000}"#;
    const STORE_D: &str = "981ad4f18b4831d119d0de8e090d688cb92575355504b935d3e0883ca4da647b";
    const PRODUCT: &str = r#"{"v":1,"kind":"digital","seller":"037821115dd0aa762d3a393fa861ce8e784403b9e0ec578bc37e72e6e9e70a1c09","payTo":"RAddressExample","title":"여름 사진집","price":"150000000","media":[],"feeBps":0,"feeSchedule":"none","rev":0,"id":null,"prev":null}"#;
    const PRODUCT_D: &str = "56b832f349a2d4986db2aad6d5b2611001bb23c752cec49a83cdc1856facdd3e";
    const CERT: &str = r#"{"v":1,"storeId":"abababababababababababababababababababababababababababababababab","deviceId":"cdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd","devicePubKey":"037821115dd0aa762d3a393fa861ce8e784403b9e0ec578bc37e72e6e9e70a1c09","role":"pos","scopes":["pos"],"issuedAt":1790000000000,"notAfter":1797776000000,"serial":3}"#;
    const CERT_D: &str = "473a6f9ca84cabb386860e718392b48ac7812ae3b36dbb8fc24729cf12af255e";
    const REV: &str = r#"{"v":1,"storeId":"abababababababababababababababababababababababababababababababab","seq":2,"revoked":["cdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd"],"issuedAt":1790000000000,"prunedBefore":0}"#;
    const REV_D: &str = "8b8deab9fc3fab1167d1e26cc6cc368ef55dbae40c8ae71e2f7f99ca9930fdf1";

    fn words() -> Result<(String, String), String> { Ok((WORDS.to_string(), String::new())) }
    fn j(s: &str) -> Value { serde_json::from_str(s).unwrap() }
    fn d32(h: &str) -> [u8; 32] { hex::decode(h).unwrap().try_into().unwrap() }

    #[test]
    fn same_key_and_signature_as_core_ts() {
        let sk = store_secret(WORDS, "").unwrap();
        assert_eq!(pubkey_hex(&sk).unwrap(), TS_PUBKEY, "공개키가 코어(TS) 파생과 다르다");
        assert_eq!(sign_compact_hex(&sk, &d32(DIGEST)).unwrap(), TS_SIG, "서명이 코어(TS, RFC6979 lowS)와 다르다");
    }
    #[test]
    fn digests_match_core_for_every_kind() {
        for (kind, body, want) in [("store", STORE, STORE_D), ("product", PRODUCT, PRODUCT_D), ("device-cert", CERT, CERT_D), ("device-revoke", REV, REV_D)] {
            let out = sign_doc_flow(false, kind, &j(body), |_| true, words).unwrap();
            assert_eq!(out["digest"], want, "{kind} 다이제스트가 코어와 다르다");
            assert_eq!(out["store_key"], TS_PUBKEY);
            let s = ecdsa::Signature::from_compact(&hex::decode(out["sig"].as_str().unwrap()).unwrap()).unwrap();
            let pk = PublicKey::from_slice(&hex::decode(TS_PUBKEY).unwrap()).unwrap();
            Secp256k1::new().verify_ecdsa(&Message::from_digest(d32(want)), &s, &pk).unwrap();
            let mut n = s; n.normalize_s();
            assert_eq!(n, s, "낮은 S 가 아니다");
        }
    }
    #[test]
    fn confirm_shows_real_contents_not_screen_text() {
        let seen = RefCell::new(Vec::<String>::new());
        for (kind, body) in [("store", STORE), ("product", PRODUCT), ("device-cert", CERT), ("device-revoke", REV)] {
            sign_doc_flow(false, kind, &j(body), |t| { seen.borrow_mut().push(t.to_string()); true }, words).unwrap();
        }
        let v = seen.into_inner();
        assert!(v[0].contains("무송 체육관 스토어") && v[0].contains("서울 마포"), "{}", v[0]);
        assert!(v[1].contains("여름 사진집") && v[1].contains("1.5 RVN") && v[1].contains("RAddressExample"), "{}", v[1]);
        assert!(v[2].contains("pos") && v[2].contains("037821115dd0aa76") && v[2].contains("2026-12-20까지") && v[2].contains("일련번호: 3"), "{}", v[2]);
        assert!(v[3].contains("끊긴 기기: 1대") && v[3].contains("목록 번호: 2"), "{}", v[3]);
    }
    #[test]
    fn another_stores_document_is_refused_after_confirm() {
        let other = STORE.replace(TS_PUBKEY, "02c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5");
        assert_eq!(sign_doc_flow(false, "store", &j(&other), |_| true, words).unwrap_err(), ERR_SELLER);
        let other = PRODUCT.replace(TS_PUBKEY, "02c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5");
        assert_eq!(sign_doc_flow(false, "product", &j(&other), |_| true, words).unwrap_err(), ERR_SELLER);
    }
    #[test]
    fn locked_refuses_before_anything_else() {
        let asked = Cell::new(false);
        let r = sign_doc_flow(true, "store", &j(STORE), |_| { asked.set(true); true }, || { asked.set(true); words() });
        assert_eq!(r.unwrap_err(), ERR_LOCKED);
        assert!(!asked.get(), "잠금 중에는 확인 창도 단어 요청도 없어야 한다");
    }
    #[test]
    fn malformed_requests_refused_before_confirm() {
        let asked = Cell::new(false);
        let mut with_sig = j(STORE); with_sig["sig"] = Value::from("x");
        let mut v2 = j(STORE); v2["v"] = Value::from(2);
        let mut bad_price = j(PRODUCT); bad_price["price"] = Value::from("1.5");
        let mut bad_pk = j(CERT); bad_pk["devicePubKey"] = Value::from("02zz");
        let mut float = j(REV); float["seq"] = Value::from(1.5);
        let huge = json!({ "v": 1, "kind": "store", "seller": TS_PUBKEY, "name": "x".repeat(DOC_MAX_BYTES) });
        for (kind, body) in [("digest", j(STORE)), ("", j(STORE)), ("store", Value::from("text")), ("store", with_sig), ("store", v2), ("product", bad_price),
                             ("device-cert", bad_pk), ("device-revoke", float), ("store", huge), ("device-cert", j(REV)), ("store", json!({"v":1}))] {
            assert_eq!(sign_doc_flow(false, kind, &body, |_| { asked.set(true); true }, words).unwrap_err(), ERR_DOC, "{kind}");
        }
        assert!(!asked.get(), "모양이 틀리면 확인 창을 띄우지 않는다");
    }
    #[test]
    fn declined_never_reads_words() {
        let read = Cell::new(false);
        let r = sign_doc_flow(false, "store", &j(STORE), |_| false, || { read.set(true); words() });
        assert_eq!(r.unwrap_err(), ERR_DECLINED);
        assert!(!read.get());
    }
    #[test]
    fn shown_text_drops_control_and_direction_marks() {
        assert_eq!(shown("가\u{202E}나\n다\u{2066}"), "가나다");
        assert_eq!(shown(&"가".repeat(70)).chars().count(), 61);
        assert_eq!(rvn_text("100000000").unwrap(), "1"); assert_eq!(rvn_text("1").unwrap(), "0.00000001");
        assert!(rvn_text("").is_none() && rvn_text("1e8").is_none());
        assert_eq!(ymd(0), "1970-01-01"); assert_eq!(ymd(1_797_776_000_000), "2026-12-20");
    }
    #[test]
    fn errors_never_carry_key_words_or_body() {
        let sk_hex = hex::encode(store_secret(WORDS, "").unwrap());
        let weird = sign_doc_flow(false, "store", &j(STORE), |_| true, || Ok(("not twelve".into(), String::new()))).unwrap_err();
        assert_eq!(weird, ERR_KEY);
        for e in [weird, ERR_LOCKED.into(), ERR_DOC.into(), ERR_SELLER.into(), ERR_DECLINED.into(), ERR_SIGN.into()] {
            assert!(!e.contains(&sk_hex) && !e.contains(WORDS) && !e.contains("무송") && !e.contains("abandon"));
        }
        let node = sign_doc_flow(false, "store", &j(STORE), |_| true, || Err(crate::identity::SeedFailure::Locked.public_error())).unwrap_err();
        assert!(node.starts_with("[SEED_LOCKED]"));
    }
    #[test]
    fn no_key_logging_in_source() {
        let src = include_str!("storesign.rs");
        let body = &src[..src.find("#[cfg(test)]").unwrap()];
        for bad in ["println!", "eprintln!", " log::", "(log::", "tracing::", "dbg!", "format!(\"{sk", "{e:?}"] {
            assert!(!body.contains(bad), "{bad}");
        }
        assert!(!body.contains("pub async fn store_sign_digest"), "아무 다이제스트에 서명하는 명령은 없어야 한다");
    }
    #[test]
    fn commands_are_denied_while_locked() {
        for c in ["store_key_info", "store_sign_doc"] { assert!(!crate::app_lock::allowed_while_locked(c), "{c}"); }
    }
}
