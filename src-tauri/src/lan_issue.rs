//! LAN 동기화 ⑥ — 기기 증서(DeviceCert) 발급. 가게 키 PC 쪽.
//!
//! 규격 정본 = 통합 브랜치 `core/device/cert.ts` `issueDeviceCert`·`deviceIdOf`·`DEVICE_ROLE_SCOPES`.
//! 같은 순서: 본문 모양 → 이력(같은 가게·가게 키 서명·일련번호 중복 금지) → 서명(`lan_cert::sign_doc`) → 방금 만든 증서를 철회 목록으로 다시 확인.
//! 폰이 합성 키(0x11)로 만든 시험 벡터와 **바이트까지 같은** 증서가 나온다(RFC6979 결정적 서명).
//!
//! 🔴 열쇠는 이 파일에 없다. 서명은 `sign` 콜백(32바이트 다이제스트 → compact 64바이트)으로만.
//!    운영 흐름 `issue_with_store_key` 는 `storesign::sign_flow` 와 같은 순서(잠금 → 모양 → 사장 확인 → 12단어 → 서명 → 지우기)다.
//!    이 레인은 그 흐름을 **실행하지 않았다**(시험은 합성 단어·합성 키만). 부르는 명령도 만들지 않았다 — 화면 쪽 발급(`device-connect.ts issueFor`)이 이미 있다.
//!
//! RV6 페어링과의 연결(조사 결과, 결정 표 ④): RV6 v1 HELLO 에는 증서에 넣을 **압축 secp256k1 공개키가 없다**
//! (`phone_sign` = BIP340 x-only 32바이트 · `phone_dh` = X25519). 그대로는 발급을 붙일 수 없고, 규격 확장(v2 또는 새 메시지 종류)이 필요하다.

#![allow(dead_code)]

use crate::lan_cert::{
    role_scopes, sign_doc, signed_by, validate_cert_with, verify_device_cert, CertReason, SignError, DEVICE_CERT_DOMAIN, DEVICE_CERT_MAX_MS,
    MAX_TIME_MS,
};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

/// 잠정 기본 수명 7일(core `DEVICE_CERT_DEFAULT_DAYS`, 대표 결정 대기).
pub const DEVICE_CERT_DEFAULT_MS: i64 = 7 * 24 * 3600_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum IssueError {
    /// 본문 모양이 틀렸다(core `shape`).
    Shape,
    /// 이력 안의 증서가 틀렸거나 다른 가게 것(core `cert:history`).
    History,
    /// 같은 일련번호가 이미 있다(core `cert:duplicate-serial`).
    DuplicateSerial,
    Sign(SignError),
    /// 방금 만든 증서가 확인을 못 넘었다(core `cert:<사유>`) — 낡은 철회 목록 등.
    Verify(CertReason),
}

/// core `deviceIdOf` = sha256(공개키 바이트) hex.
pub fn device_id_of(device_pub_key: &str) -> Option<String> {
    crate::lan_cert::is_public_key(device_pub_key).then(|| hex::encode(Sha256::digest(hex::decode(device_pub_key).unwrap_or_default())))
}

/// 발급 본문 — 역할의 기본 맡김 전부(core DEVICE_ROLE_SCOPES 순서), 수명은 1ms~30일.
pub fn cert_body(store_id: &str, device_pub_key: &str, role: &str, issued_at: i64, ttl_ms: i64, serial: u64) -> Result<Value, IssueError> {
    let device_id = device_id_of(device_pub_key).ok_or(IssueError::Shape)?;
    let scopes = role_scopes(role).ok_or(IssueError::Shape)?;
    if !(1..=DEVICE_CERT_MAX_MS).contains(&ttl_ms) || issued_at < 1 || issued_at.checked_add(ttl_ms).map_or(true, |t| t > MAX_TIME_MS) {
        return Err(IssueError::Shape);
    }
    let body = json!({
        "v": 1, "storeId": store_id, "deviceId": device_id, "devicePubKey": device_pub_key, "role": role,
        "scopes": scopes, "issuedAt": issued_at, "notAfter": issued_at + ttl_ms, "serial": serial,
    });
    validate_cert_with(&body, false).map_err(|_| IssueError::Shape)?;
    Ok(body)
}

/// core `issueDeviceCert`. `history` = 이 가게가 낸 증서 전부(철회·만료 포함 — 일련번호 중복 금지의 근거).
pub fn issue_device_cert<F>(body: &Value, store_key: &str, sign: F, now_ms: i64, revocation: Option<&Value>, history: &[Value]) -> Result<Value, IssueError>
where
    F: FnOnce(&[u8; 32]) -> Result<[u8; 64], ()>,
{
    let (_, b) = validate_cert_with(body, false).map_err(|_| IssueError::Shape)?;
    for prev in history {
        let (po, p) = validate_cert_with(prev, true).map_err(|_| IssueError::History)?;
        if p.store_id != b.store_id || !signed_by(DEVICE_CERT_DOMAIN, po, store_key) {
            return Err(IssueError::History);
        }
        if p.serial == b.serial {
            return Err(IssueError::DuplicateSerial);
        }
    }
    let cert = sign_doc(DEVICE_CERT_DOMAIN, body, store_key, sign).map_err(IssueError::Sign)?;
    verify_device_cert(&cert, store_key, now_ms, revocation, None).map_err(IssueError::Verify)?;
    Ok(cert)
}

/// 운영 흐름(코드만, 이 레인에서 실행 안 함): 잠금 → 모양 → 사장 확인 → 12단어 → 가게 열쇠 → 발급 → 지우기.
/// `storesign::sign_flow` 와 같은 순서·같은 고정 오류 문장. 열쇠는 이 함수 밖으로 나가지 않는다.
pub fn issue_with_store_key<W, C>(
    locked: bool,
    body: &Value,
    store_key: &str,
    now_ms: i64,
    revocation: Option<&Value>,
    history: &[Value],
    confirm: C,
    words: W,
) -> Result<Value, String>
where
    W: FnOnce() -> Result<(String, String), String>,
    C: FnOnce(&str) -> bool,
{
    use crate::storesign::{ERR_DECLINED, ERR_KEY, ERR_LOCKED, ERR_SIGN};
    if locked {
        return Err(ERR_LOCKED.into());
    }
    validate_cert_with(body, false).map_err(|_| "증서 내용의 모양이 맞지 않아요.".to_string())?;
    if !confirm("새 기기 연결 증서") {
        return Err(ERR_DECLINED.into());
    }
    let (mut w, mut p) = words()?;
    let sk = crate::storesign::store_secret(&w, &p);
    crate::words::wipe(&mut w);
    crate::words::wipe(&mut p);
    let mut sk = sk.ok_or_else(|| ERR_KEY.to_string())?;
    let out = issue_device_cert(
        body,
        store_key,
        |d| {
            let k = secp256k1::SecretKey::from_byte_array(&sk).map_err(|_| ())?;
            Ok(secp256k1::Secp256k1::new().sign_ecdsa(&secp256k1::Message::from_digest(*d), &k).serialize_compact())
        },
        now_ms,
        revocation,
        history,
    );
    crate::words::wipe_bytes(&mut sk);
    out.map_err(|e| match e {
        IssueError::Sign(SignError::KeyMismatch) => ERR_KEY.to_string(),
        IssueError::Verify(r) => format!("증서를 확인하지 못했어요({}).", r.as_str()),
        IssueError::DuplicateSerial => "같은 번호의 증서가 이미 있어요.".to_string(),
        _ => ERR_SIGN.to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::lan_cert::tests::synth_signer;

    fn v() -> Value {
        serde_json::from_str(include_str!("../testdata/rv-lan-cert-vectors.json")).unwrap()
    }
    fn body_of(c: &Value) -> Value {
        let mut b = c.clone();
        b.as_object_mut().unwrap().shift_remove("sig");
        b
    }
    fn canon(v: &Value) -> String {
        crate::lan_proof::canonical_string(v).unwrap()
    }

    #[test]
    fn issues_byte_identical_certs_to_the_phone() {
        let v = v();
        let (sk, now) = (v["storeKey"].as_str().unwrap(), v["now"].as_i64().unwrap());
        let list = &v["lists"]["empty"];
        // 폰 core 가 0x11 합성 키로 낸 증서 — 일련번호 순서대로 이력을 쌓으며 다시 발급한다.
        let mut history: Vec<Value> = Vec::new();
        for name in ["remote", "replica", "revokedCert"] {
            let want = &v["certs"][name];
            let got = issue_device_cert(&body_of(want), sk, synth_signer, now, Some(list), &history).unwrap();
            assert_eq!(canon(&got), canon(want), "{name} 증서가 폰과 바이트까지 같아야 한다");
            history.push(got);
        }
        // deviceIdOf 도 폰과 같다.
        let c = &v["certs"]["remote"];
        assert_eq!(device_id_of(c["devicePubKey"].as_str().unwrap()).unwrap(), c["deviceId"].as_str().unwrap());
    }

    #[test]
    fn cert_body_uses_the_role_table_and_limits() {
        let v = v();
        let pk = v["certs"]["replica"]["devicePubKey"].as_str().unwrap();
        let sid = v["storeId"].as_str().unwrap();
        let t = v["now"].as_i64().unwrap();
        let b = cert_body(sid, pk, "replica", t, DEVICE_CERT_DEFAULT_MS, 9).unwrap();
        assert_eq!(b["scopes"], json!(["read", "replicate"]));
        assert_eq!(b["notAfter"], t + DEVICE_CERT_DEFAULT_MS);
        let staff = cert_body(sid, pk, "staff-pc", t, DEVICE_CERT_DEFAULT_MS, 9).unwrap();
        assert_eq!(staff["scopes"], json!(["read", "replicate", "draft", "ticket-check", "key-request", "notice-write"]));
        assert_eq!(cert_body(sid, pk, "owner", t, 1, 1), Err(IssueError::Shape), "모르는 역할");
        assert_eq!(cert_body(sid, pk, "remote", t, DEVICE_CERT_MAX_MS + 1, 1), Err(IssueError::Shape), "30일 초과");
        assert_eq!(cert_body(sid, pk, "remote", t, 0, 1), Err(IssueError::Shape));
        assert_eq!(cert_body(sid, &pk.to_uppercase(), "remote", t, 1, 1), Err(IssueError::Shape));
        assert_eq!(cert_body("XX", pk, "remote", t, 1, 1), Err(IssueError::Shape));
        assert_eq!(cert_body(sid, pk, "remote", t, 1, 0), Err(IssueError::Shape), "일련번호는 1부터");
        // 만든 본문을 발급하면 확인을 통과한다.
        let cert = issue_device_cert(&b, v["storeKey"].as_str().unwrap(), synth_signer, t, Some(&v["lists"]["empty"]), &[]).unwrap();
        let ok = verify_device_cert(&cert, v["storeKey"].as_str().unwrap(), t, Some(&v["lists"]["empty"]), Some("replicate")).unwrap();
        assert_eq!(ok.serial, 9);
    }

    #[test]
    fn history_duplicate_serial_and_stale_lists_are_refused() {
        let v = v();
        let (sk, now) = (v["storeKey"].as_str().unwrap(), v["now"].as_i64().unwrap());
        let empty = &v["lists"]["empty"];
        let remote = v["certs"]["remote"].clone();
        let body = body_of(&v["certs"]["replica"]);
        assert_eq!(issue_device_cert(&body_of(&remote), sk, synth_signer, now, Some(empty), &[remote.clone()]), Err(IssueError::DuplicateSerial));
        let mut other_store = remote.clone();
        other_store["storeId"] = json!("cd".repeat(32));
        assert_eq!(issue_device_cert(&body, sk, synth_signer, now, Some(empty), &[other_store]), Err(IssueError::History));
        let mut forged = remote.clone();
        forged["role"] = json!("staff-pc");
        forged["scopes"] = json!(["read"]);
        assert_eq!(issue_device_cert(&body, sk, synth_signer, now, Some(empty), &[forged]), Err(IssueError::History), "가게 키 서명이 없는 이력");
        assert_eq!(issue_device_cert(&body, sk, synth_signer, now, Some(&v["lists"]["stale"]), &[]), Err(IssueError::Verify(CertReason::StaleRevocationList)));
        assert_eq!(issue_device_cert(&body, sk, synth_signer, now, None, &[]), Err(IssueError::Verify(CertReason::NoRevocationList)));
        assert_eq!(issue_device_cert(&remote, sk, synth_signer, now, Some(empty), &[]), Err(IssueError::Shape), "서명 칸이 있는 본문은 받지 않는다");
        // 다른 열쇠로 서명하는 콜백은 가게 키와 안 맞아 거절.
        let wrong = |d: &[u8; 32]| -> Result<[u8; 64], ()> {
            let k = secp256k1::SecretKey::from_byte_array(&[0x33u8; 32]).unwrap();
            Ok(secp256k1::Secp256k1::new().sign_ecdsa(&secp256k1::Message::from_digest(*d), &k).serialize_compact())
        };
        assert_eq!(issue_device_cert(&body, sk, wrong, now, Some(empty), &[]), Err(IssueError::Sign(SignError::KeyMismatch)));
    }

    #[test]
    fn the_owner_flow_locks_confirms_and_wipes() {
        // 공개 BIP39 시험 단어(합성). 이 단어의 가게 키로 만든 합성 가게에서만 시험한다.
        const WORDS: &str = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
        let mut w = WORDS.to_string();
        let id = crate::lan_mount::store_identity_from_words(&mut w, &mut String::new(), &"ab".repeat(32)).unwrap();
        let now = 1_800_000_000_000i64;
        let sk_secret = crate::storesign::store_secret(WORDS, "").unwrap();
        let list = sign_doc(
            crate::lan_cert::DEVICE_REVOKE_DOMAIN,
            &json!({ "v": 1, "storeId": id.store_id, "seq": 1, "revoked": [], "issuedAt": now, "prunedBefore": 0 }),
            &id.store_key,
            |d| Ok(secp256k1::Secp256k1::new().sign_ecdsa(&secp256k1::Message::from_digest(*d), &secp256k1::SecretKey::from_byte_array(&sk_secret).unwrap()).serialize_compact()),
        )
        .unwrap();
        let pk = v()["certs"]["remote"]["devicePubKey"].as_str().unwrap().to_string();
        let body = cert_body(&id.store_id, &pk, "remote", now, DEVICE_CERT_DEFAULT_MS, 1).unwrap();
        let words = || Ok((WORDS.to_string(), String::new()));
        let asked = std::cell::Cell::new(false);
        assert_eq!(
            issue_with_store_key(true, &body, &id.store_key, now, Some(&list), &[], |_| { asked.set(true); true }, words).unwrap_err(),
            crate::storesign::ERR_LOCKED
        );
        assert!(!asked.get(), "잠금 중에는 확인창도 없다");
        let read = std::cell::Cell::new(false);
        let declined = issue_with_store_key(false, &body, &id.store_key, now, Some(&list), &[], |_| false, || { read.set(true); words() });
        assert_eq!(declined.unwrap_err(), crate::storesign::ERR_DECLINED);
        assert!(!read.get(), "거절하면 단어를 읽지 않는다");
        let cert = issue_with_store_key(false, &body, &id.store_key, now, Some(&list), &[], |_| true, words).unwrap();
        assert!(verify_device_cert(&cert, &id.store_key, now, Some(&list), Some("draft")).is_ok());
        let e = issue_with_store_key(false, &body, &id.store_key, now, Some(&list), &[cert.clone()], |_| true, words).unwrap_err();
        assert!(!e.contains("abandon") && !e.contains(&hex::encode(sk_secret)));
    }
}
