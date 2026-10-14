//! 가게 서명 — 기기 증서·철회 목록·상품 문서에 쓰는 **가게 전용 열쇠**로 32바이트 다이제스트에 서명한다.
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

pub const REASON_MAX_CHARS: usize = 80;

/// 화면에 내보내는 고정 오류 문장 — 입력값을 되풀이하지 않는다.
pub const ERR_LOCKED: &str = "지갑이 잠겨 있어요. 잠금을 푼 뒤 다시 해 주세요.";
pub const ERR_DIGEST: &str = "서명할 내용의 모양이 맞지 않아요.";
pub const ERR_REASON: &str = "서명 사유가 비었거나 맞지 않아요.";
pub const ERR_DECLINED: &str = "사장님이 서명을 허락하지 않았어요.";
pub const ERR_KEY: &str = "가게 열쇠를 만들지 못했어요.";
pub const ERR_SIGN: &str = "서명하지 못했어요.";

/// 64자리 16진수(대소문자 허용) → 32바이트.
pub fn parse_digest(s: &str) -> Result<[u8; 32], &'static str> {
    if s.len() != 64 || !s.bytes().all(|b| b.is_ascii_hexdigit()) { return Err(ERR_DIGEST); }
    let v = hex::decode(s).map_err(|_| ERR_DIGEST)?;
    let mut out = [0u8; 32];
    out.copy_from_slice(&v);
    Ok(out)
}

/// 사유: 앞뒤 공백 제거 후 1~80자, 줄바꿈·제어문자 없음(확인 창에 그대로 보인다).
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

/// 서명 한 번의 전 과정. `words` = 노드에서 12단어를 받는 함수, `confirm` = 사장 확인(사유를 받는다).
/// 순서: 잠금 → 형식 → 확인 → 단어 → 열쇠 → 서명 → 지우기. 어느 단계든 실패하면 고정 문장만 돌려준다.
pub fn sign_flow<W, C>(locked: bool, digest_hex: &str, reason: &str, confirm: C, words: W) -> Result<Value, String>
where W: FnOnce() -> Result<(String, String), String>, C: FnOnce(&str) -> bool {
    if locked { return Err(ERR_LOCKED.into()); }
    let digest = parse_digest(digest_hex).map_err(String::from)?;
    let reason = clean_reason(reason).map_err(String::from)?;
    if !confirm(&reason) { return Err(ERR_DECLINED.into()); }
    let (mut w, mut p) = words()?;
    let sk = store_secret(&w, &p);
    crate::words::wipe(&mut w);
    crate::words::wipe(&mut p);
    let mut sk = sk.ok_or_else(|| ERR_KEY.to_string())?;
    let out = (|| Ok::<_, &'static str>((pubkey_hex(&sk)?, sign_compact_hex(&sk, &digest)?)))();
    crate::words::wipe_bytes(&mut sk);
    let (pk, sig) = out.map_err(String::from)?;
    Ok(json!({ "store_key": pk, "sig": sig }))
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

/// 다이제스트에 가게 키로 서명한다. 사유는 확인 창에 그대로 보인다(80자 이하). 단어는 사장이 확인한 **뒤에** 받는다.
#[tauri::command]
pub async fn store_sign_digest(app: tauri::AppHandle, digest: String, reason: String) -> Result<Value, String> {
    use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};
    tokio::task::spawn_blocking(move || {
        sign_flow(
            crate::app_lock::is_locked(), &digest, &reason,
            |r| app.dialog().message(format!("가게 열쇠로 서명합니다.\n\n사유: {r}\n\n맞으면 「확인」을 눌러 주세요."))
                .title("가게 서명 확인").buttons(MessageDialogButtons::OkCancel).blocking_show(),
            || crate::identity::words_from_node().map_err(crate::identity::SeedFailure::public_error),
        )
    }).await.map_err(|_| ERR_SIGN.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;
    const WORDS: &str = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
    const DIGEST: &str = "0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20";
    // core(TS, @scure/bip32)로 같은 가짜 12단어·passphrase "" 에서 m/44'/175'/7'/1'/0' 를 뽑은 값 — @scure/bip32 + node pbkdf2 로 독립 계산한 값(scripts/biz-screens.test.mjs 도 같은 숫자를 쓴다).
    const TS_PUBKEY: &str = "037821115dd0aa762d3a393fa861ce8e784403b9e0ec578bc37e72e6e9e70a1c09";
    const TS_SIG: &str = "2e638d02c47357cba4160021eb21e518bfbbf5201c87c7f5c2e70c48c72ba10032ee07c72c73826d9cfe997b1a61412d37c8420f3033640bb36b732b0d18dd37";

    fn words() -> Result<(String, String), String> { Ok((WORDS.to_string(), String::new())) }

    #[test]
    fn same_key_and_signature_as_core_ts() {
        let out = sign_flow(false, DIGEST, "기기 증서 발급", |_| true, words).unwrap();
        assert_eq!(out["store_key"], TS_PUBKEY, "공개키가 코어(TS) 파생과 다르다");
        assert_eq!(out["sig"], TS_SIG, "서명이 코어(TS, RFC6979 lowS)와 다르다");
    }
    #[test]
    fn signature_verifies_and_is_low_s() {
        let sk = store_secret(WORDS, "").unwrap();
        let sig = sign_compact_hex(&sk, &parse_digest(DIGEST).unwrap()).unwrap();
        let s = ecdsa::Signature::from_compact(&hex::decode(&sig).unwrap()).unwrap();
        let pk = PublicKey::from_secret_key(&Secp256k1::new(), &SecretKey::from_byte_array(&sk).unwrap());
        Secp256k1::new().verify_ecdsa(&Message::from_digest(parse_digest(DIGEST).unwrap()), &s, &pk).unwrap();
        let mut n = s; n.normalize_s();
        assert_eq!(n, s, "낮은 S 가 아니다");
    }
    #[test]
    fn locked_refuses_before_anything_else() {
        let asked = Cell::new(false);
        let r = sign_flow(true, DIGEST, "x", |_| { asked.set(true); true }, || { asked.set(true); words() });
        assert_eq!(r.unwrap_err(), ERR_LOCKED);
        assert!(!asked.get(), "잠금 중에는 확인 창도 단어 요청도 없어야 한다");
    }
    #[test]
    fn malformed_requests_refused_without_echo() {
        let secret_looking = "zz-SECRET-zz";
        for bad in ["", "abcd", &"g".repeat(64), &"a".repeat(63), &"a".repeat(65), secret_looking] {
            let e = sign_flow(false, bad, "사유", |_| true, words).unwrap_err();
            assert_eq!(e, ERR_DIGEST);
            assert!(!e.contains(bad) || bad.is_empty());
        }
        for bad in ["", "   ", "줄\n바꿈", &"가".repeat(81)] {
            assert_eq!(sign_flow(false, DIGEST, bad, |_| true, words).unwrap_err(), ERR_REASON);
        }
        assert!(sign_flow(false, DIGEST, &"가".repeat(80), |_| true, words).is_ok());
    }
    #[test]
    fn declined_never_reads_words() {
        let read = Cell::new(false);
        let r = sign_flow(false, DIGEST, "사유", |_| false, || { read.set(true); words() });
        assert_eq!(r.unwrap_err(), ERR_DECLINED);
        assert!(!read.get());
    }
    #[test]
    fn errors_never_carry_key_words_or_digest() {
        let sk_hex = hex::encode(store_secret(WORDS, "").unwrap());
        let weird = sign_flow(false, DIGEST, "사유", |_| true, || Ok(("not twelve".into(), String::new()))).unwrap_err();
        assert_eq!(weird, ERR_KEY);
        for e in [weird, ERR_LOCKED.into(), ERR_DIGEST.into(), ERR_REASON.into(), ERR_DECLINED.into(), ERR_SIGN.into()] {
            assert!(!e.contains(&sk_hex) && !e.contains(WORDS) && !e.contains(DIGEST) && !e.contains("abandon"));
        }
        // 노드 오류 문장은 그대로 통과하지만 단어가 아닌 고정 문장이다(identity::SeedFailure::public_error).
        let node = sign_flow(false, DIGEST, "사유", |_| true, || Err(crate::identity::SeedFailure::Locked.public_error())).unwrap_err();
        assert!(node.starts_with("[SEED_LOCKED]"));
    }
    #[test]
    fn no_key_logging_in_source() {
        let src = include_str!("storesign.rs");
        let body = &src[..src.find("#[cfg(test)]").unwrap()];
        for bad in ["println!", "eprintln!", " log::", "(log::", "tracing::", "dbg!", "format!(\"{sk", "{e:?}"] {
            assert!(!body.contains(bad), "{bad}");
        }
    }
    #[test]
    fn commands_are_denied_while_locked() {
        for c in ["store_key_info", "store_sign_digest"] { assert!(!crate::app_lock::allowed_while_locked(c), "{c}"); }
    }
}
