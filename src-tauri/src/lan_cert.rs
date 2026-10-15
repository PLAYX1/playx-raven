//! LAN 동기화 ① — 기기 증서 확인(서명·만료·철회·권한). 데스크탑(서버) 쪽.
//!
//! 규격 정본 = 통합 브랜치 `core/device/cert.ts`(`verifyDeviceCert`)·`revoke.ts`(`checkDeviceRevocations`)·`core/shop-order/signed.ts`.
//! 여기서 새 규칙을 만들지 않고 같은 순서·같은 사유 이름으로 계산한다. 폰 코드가 만든 증서/철회 목록(합성 열쇠)으로
//! `testdata/rv-lan-cert-vectors.json` 시험을 한다.
//!
//!   서명 문구 = `<도메인>\nsha256:<sig 뺀 본문 정본JSON의 SHA-256>` → 레이븐 signmessage 해시(sha256d, "\x16Raven Signed Message:\n"+길이+문구)
//!   서명 = 65바이트 복구형(머리 31..34 = 압축키) base64(정본), 낮은 S 만. 복구한 공개키가 가게 키와 바이트까지 같아야 한다.
//!   판정 순서: 시각(bad-clock) → 모양(shape) → 서명(signature) → not-yet → expired → 맡김(scope) → 철회 목록(검사 순서는 revoke.ts 와 같다)
//!
//! 가게 키는 호출자가 준다(이 파일은 열쇠·12단어를 열지 않는다).

#![allow(dead_code)] // 처리기(lan_handler)가 쓴다

use crate::lan_proof::canonical_string;
use base64::{engine::general_purpose::STANDARD, Engine as _};
use secp256k1::ecdsa::{RecoverableSignature, RecoveryId, Signature};
use secp256k1::{Message, PublicKey, Secp256k1};
use serde_json::Value;
use sha2::{Digest, Sha256};

pub const DEVICE_CERT_DOMAIN: &str = "RAVENVAULT-DEVICE-CERT-V1";
pub const DEVICE_REVOKE_DOMAIN: &str = "RAVENVAULT-DEVICE-REVOKE-V1";
pub const DEVICE_CERT_MAX_MS: i64 = 30 * 24 * 3600_000;
pub const DEVICE_CLOCK_SKEW_MS: i64 = 30_000;
pub const MAX_DEVICE_CERT_BYTES: usize = 4096;
pub const MAX_REVOKE_BYTES: usize = 64 * 1024;
pub const MAX_REVOKED: usize = 900;
pub const REVOCATION_LIST_MAX_AGE_MS: i64 = 24 * 3600_000;
pub const MIN_NOW_MS: i64 = 1_000_000_000_000;
pub const MAX_TIME_MS: i64 = 253_402_300_799_000;
const MAX_SAFE: i64 = 9_007_199_254_740_991;

pub const DEVICE_SCOPES: [&str; 6] = ["read", "replicate", "draft", "ticket-check", "key-request", "notice-write"];

/// 역할별 허용 맡김(core DEVICE_ROLE_SCOPES 와 같은 표).
pub fn role_scopes(role: &str) -> Option<&'static [&'static str]> {
    Some(match role {
        "replica" => &["read", "replicate"],
        "remote" => &["read", "draft", "ticket-check", "key-request", "notice-write"],
        "staff-pc" => &DEVICE_SCOPES,
        "scanner" => &["read", "ticket-check"],
        _ => return None,
    })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CertReason {
    Shape,
    Signature,
    OtherStore,
    BadClock,
    NotYet,
    Expired,
    Scope,
    Revoked,
    NoRevocationList,
    StaleRevocationList,
}
impl CertReason {
    /// core 의 DeviceCertReason 문자열과 같다.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Shape => "shape",
            Self::Signature => "signature",
            Self::OtherStore => "other-store",
            Self::BadClock => "bad-clock",
            Self::NotYet => "not-yet",
            Self::Expired => "expired",
            Self::Scope => "scope",
            Self::Revoked => "revoked",
            Self::NoRevocationList => "no-revocation-list",
            Self::StaleRevocationList => "stale-revocation-list",
        }
    }
}

/// 확인을 통과한 증서.
#[derive(Debug, Clone)]
pub struct VerifiedCert {
    pub store_id: String,
    pub device_id: String,
    pub device_pub_key: String,
    pub cert_id: String,
    pub scopes: Vec<String>,
    pub serial: u64,
}

fn is_sha(v: &Value) -> bool {
    v.as_str().map_or(false, |s| s.len() == 64 && s.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)))
}
fn int_in(v: &Value, min: i64, max: i64) -> Option<i64> {
    let n = v.as_i64().or_else(|| v.as_u64().and_then(|u| i64::try_from(u).ok()))?;
    (n >= min && n <= max && n.abs() <= MAX_SAFE).then_some(n)
}
fn time(v: &Value) -> Option<i64> {
    int_in(v, 1, MAX_TIME_MS)
}
fn keys_are(o: &serde_json::Map<String, Value>, want: &[&str]) -> bool {
    o.len() == want.len() && want.iter().all(|k| o.contains_key(*k))
}

/// 압축 공개키 66자리 소문자 hex 이고 곡선 위의 점인가.
pub fn is_public_key(k: &str) -> bool {
    k.len() == 66
        && (k.starts_with("02") || k.starts_with("03"))
        && k.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        && hex::decode(k).ok().and_then(|b| PublicKey::from_slice(&b).ok()).is_some()
}

/// readDoc: 객체이고 정본 JSON 으로 만들 수 있고 크기 제한 안.
fn read_doc(raw: &Value, max_bytes: usize) -> Result<&serde_json::Map<String, Value>, ()> {
    let o = raw.as_object().ok_or(())?;
    let text = canonical_string(raw).map_err(|_| ())?;
    if text.len() > max_bytes {
        return Err(());
    }
    Ok(o)
}

/// 레이븐 signmessage 해시 — core `messageHash` 와 같은 바이트.
pub fn message_hash(message: &str) -> [u8; 32] {
    let msg = message.as_bytes();
    let mut all: Vec<u8> = Vec::with_capacity(msg.len() + 32);
    all.extend_from_slice(b"\x16Raven Signed Message:\n");
    let n = msg.len();
    if n < 0xfd {
        all.push(n as u8);
    } else if n <= 0xffff {
        all.extend_from_slice(&[0xfd, (n & 255) as u8, (n >> 8) as u8]);
    } else {
        all.extend_from_slice(&[0xfe, (n & 255) as u8, ((n >> 8) & 255) as u8, ((n >> 16) & 255) as u8, ((n >> 24) & 255) as u8]);
    }
    all.extend_from_slice(msg);
    Sha256::digest(Sha256::digest(&all)).into()
}

/// sig 뺀 본문의 정본 JSON 해시.
fn body_hash(doc: &serde_json::Map<String, Value>) -> Option<String> {
    let mut m = doc.clone();
    m.shift_remove("sig");
    let text = canonical_string(&Value::Object(m)).ok()?;
    Some(hex::encode(Sha256::digest(text.as_bytes())))
}

/// 서명이 이 공개키(압축)에서 나왔나 — core `deviceSignedBy`(= low-S·압축 머리·정본 base64 + signedBy).
pub fn signed_by(domain: &str, doc: &serde_json::Map<String, Value>, pub_hex: &str) -> bool {
    let Some(sig) = doc.get("sig").and_then(Value::as_str) else { return false };
    if sig.len() > 200 {
        return false;
    }
    let Ok(bytes) = STANDARD.decode(sig) else { return false };
    if bytes.len() != 65 || STANDARD.encode(&bytes) != sig || !(31..=34).contains(&bytes[0]) {
        return false;
    }
    let Some(bh) = body_hash(doc) else { return false };
    let hash = message_hash(&format!("{domain}\nsha256:{bh}"));
    let Ok(parsed) = Signature::from_compact(&bytes[1..]) else { return false };
    let mut norm = parsed;
    norm.normalize_s();
    if norm.serialize_compact() != parsed.serialize_compact() {
        return false; // 높은 S
    }
    let Ok(rid) = RecoveryId::try_from(((bytes[0] - 27) & 3) as i32) else { return false };
    let Ok(rsig) = RecoverableSignature::from_compact(&bytes[1..], rid) else { return false };
    let Ok(key) = Secp256k1::verification_only().recover_ecdsa(&Message::from_digest(hash), &rsig) else { return false };
    hex::encode(key.serialize()) == pub_hex
}

/// 철회 식별자 = sha256Hex(정본JSON[도메인, 가게, 일련번호]) — core `deviceCertId`.
pub fn device_cert_id(store_id: &str, serial: u64) -> String {
    let v = Value::Array(vec![Value::from(DEVICE_CERT_DOMAIN), Value::from(store_id), Value::from(serial)]);
    hex::encode(Sha256::digest(canonical_string(&v).unwrap_or_default().as_bytes()))
}

fn validate_cert(raw: &Value) -> Result<(&serde_json::Map<String, Value>, VerifiedCert), ()> {
    let o = read_doc(raw, MAX_DEVICE_CERT_BYTES)?;
    if !keys_are(o, &["v", "storeId", "deviceId", "devicePubKey", "role", "scopes", "issuedAt", "notAfter", "serial", "sig"]) {
        return Err(());
    }
    let pk = o["devicePubKey"].as_str().filter(|k| is_public_key(k)).ok_or(())?;
    let device_id = hex::encode(Sha256::digest(hex::decode(pk).map_err(|_| ())?));
    if o["v"].as_u64() != Some(1) || !is_sha(&o["storeId"]) || o["deviceId"].as_str() != Some(device_id.as_str()) {
        return Err(());
    }
    let serial = int_in(&o["serial"], 1, MAX_SAFE).ok_or(())? as u64;
    let allowed = role_scopes(o["role"].as_str().ok_or(())?).ok_or(())?;
    let scopes = o["scopes"].as_array().ok_or(())?;
    let mut names: Vec<String> = Vec::new();
    for s in scopes {
        let s = s.as_str().ok_or(())?;
        if !allowed.contains(&s) || names.iter().any(|n| n == s) {
            return Err(());
        }
        names.push(s.to_string());
    }
    if names.is_empty() || names.len() > allowed.len() {
        return Err(());
    }
    let (issued, not_after) = (time(&o["issuedAt"]).ok_or(())?, time(&o["notAfter"]).ok_or(())?);
    if not_after <= issued || not_after - issued > DEVICE_CERT_MAX_MS || !o["sig"].is_string() {
        return Err(());
    }
    let store_id = o["storeId"].as_str().ok_or(())?.to_string();
    let cert_id = device_cert_id(&store_id, serial);
    Ok((o, VerifiedCert { store_id, device_id, device_pub_key: pk.to_string(), cert_id, scopes: names, serial }))
}

/// 철회 목록 확인 — core `checkDeviceRevocations`. 통과하면 None, 아니면 사유.
fn check_revocations(cert: &VerifiedCert, not_after: i64, store_key: &str, now: i64, raw: Option<&Value>) -> Option<CertReason> {
    let raw = match raw {
        None | Some(Value::Null) => return Some(CertReason::NoRevocationList),
        Some(r) => r,
    };
    let Ok(o) = read_doc(raw, MAX_REVOKE_BYTES) else { return Some(CertReason::Shape) };
    let well_formed = keys_are(o, &["v", "storeId", "seq", "revoked", "issuedAt", "prunedBefore", "sig"])
        && o["v"].as_u64() == Some(1)
        && is_sha(&o["storeId"])
        && int_in(&o["seq"], 1, MAX_SAFE).is_some()
        && time(&o["issuedAt"]).is_some()
        && o["sig"].is_string();
    if !well_formed {
        return Some(CertReason::Shape); // 칸이 빠진 목록에서 아래 o["…"] 가 패닉하지 않게 먼저 끊는다
    }
    let issued_at = time(&o["issuedAt"]);
    let pruned = int_in(&o["prunedBefore"], 0, issued_at.unwrap_or(-1));
    let revoked: Option<Vec<&str>> = o["revoked"].as_array().and_then(|a| {
        if a.len() > MAX_REVOKED {
            return None;
        }
        a.iter().map(|x| is_sha(x).then(|| x.as_str()).flatten()).collect::<Option<Vec<_>>>()
    });
    let (Some(issued_at), Some(pruned), Some(revoked)) = (issued_at, pruned, revoked) else { return Some(CertReason::Shape) };
    if !well_formed || !revoked.windows(2).all(|w| w[0] < w[1]) {
        return Some(CertReason::Shape);
    }
    if o["storeId"].as_str() != Some(cert.store_id.as_str()) {
        return Some(CertReason::OtherStore);
    }
    if !signed_by(DEVICE_REVOKE_DOMAIN, o, store_key) {
        return Some(CertReason::Signature);
    }
    if now + DEVICE_CLOCK_SKEW_MS < issued_at {
        return Some(CertReason::NotYet);
    }
    if now - issued_at > REVOCATION_LIST_MAX_AGE_MS {
        return Some(CertReason::StaleRevocationList);
    }
    if not_after <= pruned || revoked.contains(&cert.cert_id.as_str()) {
        return Some(CertReason::Revoked);
    }
    None
}

/// 기기 증서 확인 — core `verifyDeviceCert` 와 같은 순서. `scope` 가 있으면 그 맡김이 있어야 한다.
/// `store_key` = 검증된 가게 문서의 판매자 키(압축 hex). 철회 목록은 없거나 낡으면 거절(닫힌 실패).
pub fn verify_device_cert(raw: &Value, store_key: &str, now_ms: i64, revocation: Option<&Value>, scope: Option<&str>) -> Result<VerifiedCert, CertReason> {
    verify_device_cert_any(raw, store_key, now_ms, revocation, scope.as_slice())
}

/// `any_scope` 중 하나라도 있으면 통과(여러 맡김 중 하나가 필요한 /lan/push·/lan/pull 용). 비어 있으면 맡김 검사 없음.
pub fn verify_device_cert_any(raw: &Value, store_key: &str, now_ms: i64, revocation: Option<&Value>, any_scope: &[&str]) -> Result<VerifiedCert, CertReason> {
    if !(MIN_NOW_MS..=MAX_TIME_MS).contains(&now_ms) {
        return Err(CertReason::BadClock);
    }
    let (o, c) = validate_cert(raw).map_err(|_| CertReason::Shape)?;
    if !is_public_key(store_key) || !signed_by(DEVICE_CERT_DOMAIN, o, store_key) {
        return Err(CertReason::Signature);
    }
    let (issued, not_after) = (time(&o["issuedAt"]).unwrap_or(0), time(&o["notAfter"]).unwrap_or(0));
    if now_ms + DEVICE_CLOCK_SKEW_MS < issued {
        return Err(CertReason::NotYet);
    }
    if now_ms >= not_after {
        return Err(CertReason::Expired);
    }
    if !any_scope.is_empty() && !any_scope.iter().any(|s| c.scopes.iter().any(|x| x == s)) {
        return Err(CertReason::Scope);
    }
    match check_revocations(&c, not_after, store_key, now_ms, revocation) {
        Some(r) => Err(r),
        None => Ok(c),
    }
}

// ── 철회 목록 받기(갱신 경로) · 문서 서명 ─────────────────────────

/// 확인을 통과한 철회 목록의 요약.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ListInfo {
    pub seq: u64,
    pub issued_at: i64,
    pub pruned_before: i64,
    pub revoked: Vec<String>,
}

/// core `verifyDeviceRevocationList` — 모양 → 같은 가게 → 가게 키 서명. 시각(신선도)은 보지 않는다(증서 확인 때 본다).
pub fn verify_revocation_list(raw: &Value, store_key: &str, store_id: &str) -> Result<ListInfo, CertReason> {
    let o = read_doc(raw, MAX_REVOKE_BYTES).map_err(|_| CertReason::Shape)?;
    let well_formed = keys_are(o, &["v", "storeId", "seq", "revoked", "issuedAt", "prunedBefore", "sig"])
        && o["v"].as_u64() == Some(1)
        && is_sha(&o["storeId"])
        && o["sig"].is_string();
    if !well_formed {
        return Err(CertReason::Shape);
    }
    let seq = int_in(&o["seq"], 1, MAX_SAFE);
    let issued_at = time(&o["issuedAt"]);
    let pruned = int_in(&o["prunedBefore"], 0, issued_at.unwrap_or(-1));
    let revoked: Option<Vec<String>> = o["revoked"].as_array().and_then(|a| {
        if a.len() > MAX_REVOKED {
            return None;
        }
        a.iter().map(|x| is_sha(x).then(|| x.as_str().unwrap_or_default().to_string())).collect()
    });
    let (Some(seq), Some(issued_at), Some(pruned_before), Some(revoked)) = (seq, issued_at, pruned, revoked) else {
        return Err(CertReason::Shape);
    };
    if !revoked.windows(2).all(|w| w[0] < w[1]) {
        return Err(CertReason::Shape);
    }
    if o["storeId"].as_str() != Some(store_id) {
        return Err(CertReason::OtherStore);
    }
    if !is_public_key(store_key) || !signed_by(DEVICE_REVOKE_DOMAIN, o, store_key) {
        return Err(CertReason::Signature);
    }
    Ok(ListInfo { seq: seq as u64, issued_at, pruned_before, revoked })
}

/// 새 목록을 받을지.
#[derive(Debug, Clone, PartialEq)]
pub enum ListAccept {
    /// 새 목록으로 바꾼다.
    Newer(Value, ListInfo),
    /// 같거나 옛 번호라 지금 것을 그대로 둔다(core 도 이전 것을 돌려준다).
    KeptCurrent,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ListReject {
    Bad(CertReason),
    /// 시각·가지치기가 뒤로 갔다.
    Rollback,
    /// 같은 가지치기인데 철회된 번호가 빠졌다(되살리기 시도).
    Shrunk,
}
impl ListReject {
    pub fn code(self) -> &'static str {
        match self {
            Self::Bad(r) => r.as_str(),
            Self::Rollback => "rollback",
            Self::Shrunk => "shrunk",
        }
    }
}

/// core `acceptDeviceRevocationList` — 번호·시각·가지치기 후퇴 금지, 철회 번호를 빼서 되살리기 금지.
/// 지금 것(`current`)이 확인을 못 넘으면(망가졌으면) 새 목록만으로 판단한다.
pub fn accept_revocation_list(current: Option<&Value>, raw: &Value, store_key: &str, store_id: &str) -> Result<ListAccept, ListReject> {
    let next = verify_revocation_list(raw, store_key, store_id).map_err(ListReject::Bad)?;
    let Some(prev) = current.and_then(|c| verify_revocation_list(c, store_key, store_id).ok()) else {
        return Ok(ListAccept::Newer(raw.clone(), next));
    };
    if next.seq <= prev.seq {
        return Ok(ListAccept::KeptCurrent);
    }
    if next.issued_at < prev.issued_at || next.pruned_before < prev.pruned_before {
        return Err(ListReject::Rollback);
    }
    if next.pruned_before == prev.pruned_before && prev.revoked.iter().any(|id| !next.revoked.contains(id)) {
        return Err(ListReject::Shrunk);
    }
    Ok(ListAccept::Newer(raw.clone(), next))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SignError {
    Shape,
    Signer,
    KeyMismatch,
    SelfVerify,
}

/// core `signShopDoc` + `finishSignature` — sig 를 뺀 본문의 정본 해시로 문구를 만들고, `sign`(32바이트 다이제스트 →
/// compact 64바이트 r‖s)으로 서명한 뒤 낮은 S 로 맞추고, 복구 번호를 가게 키로 확정해 65바이트 base64 를 붙인다.
/// 🔴 `sign` 은 열쇠를 가진 쪽(운영 = `storesign` 의 사장 확인 흐름)이다. 이 함수는 열쇠를 보지 않는다.
pub fn sign_doc<F>(domain: &str, body: &Value, store_key: &str, sign: F) -> Result<Value, SignError>
where
    F: FnOnce(&[u8; 32]) -> Result<[u8; 64], ()>,
{
    let mut o = body.as_object().cloned().ok_or(SignError::Shape)?;
    o.shift_remove("sig");
    if !is_public_key(store_key) {
        return Err(SignError::Shape);
    }
    let bh = body_hash(&o).ok_or(SignError::Shape)?;
    let hash = message_hash(&format!("{domain}\nsha256:{bh}"));
    let raw = sign(&hash).map_err(|_| SignError::Signer)?;
    let mut sig = Signature::from_compact(&raw).map_err(|_| SignError::Signer)?;
    sig.normalize_s();
    let compact = sig.serialize_compact();
    let msg = Message::from_digest(hash);
    let secp = Secp256k1::verification_only();
    let mut found = None;
    for i in 0..4 {
        let Ok(rid) = RecoveryId::try_from(i) else { continue };
        let Ok(rs) = RecoverableSignature::from_compact(&compact, rid) else { continue };
        if secp.recover_ecdsa(&msg, &rs).map(|k| hex::encode(k.serialize())).ok().as_deref() == Some(store_key) {
            found = Some(i as u8);
            break;
        }
    }
    let rid = found.ok_or(SignError::KeyMismatch)?;
    let mut out = [0u8; 65];
    out[0] = 31 + rid;
    out[1..].copy_from_slice(&compact);
    o.insert("sig".into(), Value::from(STANDARD.encode(out)));
    if !signed_by(domain, &o, store_key) {
        return Err(SignError::SelfVerify);
    }
    Ok(Value::Object(o))
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use serde_json::json;

    fn v() -> Value {
        serde_json::from_str(include_str!("../testdata/rv-lan-cert-vectors.json")).unwrap()
    }
    fn now(v: &Value) -> i64 {
        v["now"].as_i64().unwrap()
    }
    fn sk(v: &Value) -> String {
        v["storeKey"].as_str().unwrap().to_string()
    }
    fn expect_ts(v: &Value, name: &str, got: Result<VerifiedCert, CertReason>) {
        let want = &v["ts"][name];
        match got {
            Ok(c) => {
                assert_eq!(want["ok"], true, "{name}");
                assert_eq!(want["certId"].as_str().unwrap(), c.cert_id, "{name}: certId");
            }
            Err(r) => {
                assert_eq!(want["ok"], false, "{name}");
                assert_eq!(want["reason"].as_str().unwrap(), r.as_str(), "{name}");
            }
        }
    }

    #[test]
    fn same_answers_as_the_phone_code() {
        let v = v();
        let (n, k) = (now(&v), sk(&v));
        let c = &v["certs"];
        let l = &v["lists"];
        expect_ts(&v, "remote_ok", verify_device_cert(&c["remote"], &k, n, Some(&l["empty"]), None));
        expect_ts(&v, "remote_scope_draft", verify_device_cert(&c["remote"], &k, n, Some(&l["empty"]), Some("draft")));
        expect_ts(&v, "remote_scope_replicate", verify_device_cert(&c["remote"], &k, n, Some(&l["empty"]), Some("replicate")));
        expect_ts(&v, "revoked", verify_device_cert(&c["revokedCert"], &k, n, Some(&l["revoked"]), None));
        expect_ts(&v, "expired", verify_device_cert(&c["expired"], &k, n, Some(&l["empty"]), None));
        expect_ts(&v, "future", verify_device_cert(&c["future"], &k, n, Some(&l["empty"]), None));
        expect_ts(&v, "stale", verify_device_cert(&c["remote"], &k, n, Some(&l["stale"]), None));
        expect_ts(&v, "nolist", verify_device_cert(&c["remote"], &k, n, None, None));
    }

    #[test]
    fn cert_id_matches_the_phone() {
        let v = v();
        let c = &v["certs"]["remote"];
        assert_eq!(device_cert_id(c["storeId"].as_str().unwrap(), c["serial"].as_u64().unwrap()), v["certIds"]["remote"].as_str().unwrap());
    }

    #[test]
    fn a_revoked_cert_is_refused_but_other_certs_pass_the_same_list() {
        let v = v();
        let (n, k) = (now(&v), sk(&v));
        let l = &v["lists"]["revoked"];
        assert_eq!(verify_device_cert(&v["certs"]["revokedCert"], &k, n, Some(l), None).unwrap_err(), CertReason::Revoked);
        assert!(verify_device_cert(&v["certs"]["remote"], &k, n, Some(l), None).is_ok());
    }

    #[test]
    fn missing_expired_and_future_certs_are_refused() {
        let v = v();
        let (n, k) = (now(&v), sk(&v));
        let l = &v["lists"]["empty"];
        assert_eq!(verify_device_cert(&Value::Null, &k, n, Some(l), None).unwrap_err(), CertReason::Shape);
        assert_eq!(verify_device_cert(&json!({}), &k, n, Some(l), None).unwrap_err(), CertReason::Shape);
        assert_eq!(verify_device_cert(&v["certs"]["expired"], &k, n, Some(l), None).unwrap_err(), CertReason::Expired);
        assert_eq!(verify_device_cert(&v["certs"]["future"], &k, n, Some(l), None).unwrap_err(), CertReason::NotYet);
        // 만료 직전·직후 경계: notAfter 와 같은 시각은 이미 만료
        let na = v["certs"]["remote"]["notAfter"].as_i64().unwrap();
        assert!(verify_device_cert(&v["certs"]["remote"], &k, na - 1, Some(&json!(null)), None).is_err()); // 목록 시각이 어긋나도 닫힘
        assert_eq!(verify_device_cert(&v["certs"]["remote"], &k, na, Some(l), None).unwrap_err(), CertReason::Expired);
    }

    #[test]
    fn tampering_or_a_wrong_store_key_breaks_the_signature() {
        let v = v();
        let (n, k) = (now(&v), sk(&v));
        let l = &v["lists"]["empty"];
        let mut c = v["certs"]["remote"].clone();
        c["scopes"] = json!(["read", "draft", "ticket-check"]); // 맡김 늘리기
        assert_eq!(verify_device_cert(&c, &k, n, Some(l), None).unwrap_err(), CertReason::Signature);
        let mut c = v["certs"]["remote"].clone();
        c["notAfter"] = json!(c["notAfter"].as_i64().unwrap() + 1000);
        assert_eq!(verify_device_cert(&c, &k, n, Some(l), None).unwrap_err(), CertReason::Signature);
        let other = v["wrongStoreKey"].as_str().unwrap();
        assert_eq!(verify_device_cert(&v["certs"]["remote"], other, n, Some(l), None).unwrap_err(), CertReason::Signature);
        // 서명이 다른 증서의 것이면 거절
        let mut c = v["certs"]["remote"].clone();
        c["sig"] = v["certs"]["replica"]["sig"].clone();
        assert_eq!(verify_device_cert(&c, &k, n, Some(l), None).unwrap_err(), CertReason::Signature);
        // 서명 칸 훼손(base64·길이)
        let mut c = v["certs"]["remote"].clone();
        c["sig"] = json!("AAAA");
        assert_eq!(verify_device_cert(&c, &k, n, Some(l), None).unwrap_err(), CertReason::Signature);
    }

    #[test]
    fn bad_shapes_and_clocks_are_refused() {
        let v = v();
        let (n, k) = (now(&v), sk(&v));
        let l = &v["lists"]["empty"];
        let mut c = v["certs"]["remote"].clone();
        c["extra"] = json!(1);
        assert_eq!(verify_device_cert(&c, &k, n, Some(l), None).unwrap_err(), CertReason::Shape);
        let mut c = v["certs"]["remote"].clone();
        c["role"] = json!("admin");
        assert_eq!(verify_device_cert(&c, &k, n, Some(l), None).unwrap_err(), CertReason::Shape);
        let mut c = v["certs"]["remote"].clone();
        c["scopes"] = json!(["read", "price-change"]);
        assert_eq!(verify_device_cert(&c, &k, n, Some(l), None).unwrap_err(), CertReason::Shape);
        let mut c = v["certs"]["remote"].clone();
        c["deviceId"] = json!("00".repeat(32));
        assert_eq!(verify_device_cert(&c, &k, n, Some(l), None).unwrap_err(), CertReason::Shape);
        for bad in [0i64, 1_700_000, 1_799_999_999] {
            assert_eq!(verify_device_cert(&v["certs"]["remote"], &k, bad, Some(l), None).unwrap_err(), CertReason::BadClock);
        }
    }

    #[test]
    fn a_list_for_another_store_or_with_a_bad_signature_does_not_count() {
        let v = v();
        let (n, k) = (now(&v), sk(&v));
        let mut l = v["lists"]["empty"].clone();
        l["storeId"] = json!("cd".repeat(32));
        assert_eq!(verify_device_cert(&v["certs"]["remote"], &k, n, Some(&l), None).unwrap_err(), CertReason::OtherStore);
        let mut l = v["lists"]["empty"].clone();
        l["revoked"] = json!([]);
        l["seq"] = json!(9); // 본문을 바꾸면 서명 불일치
        assert_eq!(verify_device_cert(&v["certs"]["remote"], &k, n, Some(&l), None).unwrap_err(), CertReason::Signature);
        let mut l = v["lists"]["revoked"].clone();
        l["revoked"] = json!([]); // 철회를 지워 보려 해도 서명이 깨진다
        assert_eq!(verify_device_cert(&v["certs"]["revokedCert"], &k, n, Some(&l), None).unwrap_err(), CertReason::Signature);
    }

    #[test]
    fn one_of_several_scopes_is_enough() {
        let v = v();
        let (n, k) = (now(&v), sk(&v));
        let l = &v["lists"]["empty"];
        assert!(verify_device_cert_any(&v["certs"]["remote"], &k, n, Some(l), &["replicate", "read"]).is_ok());
        assert_eq!(verify_device_cert_any(&v["certs"]["remote"], &k, n, Some(l), &["replicate"]).unwrap_err(), CertReason::Scope);
    }

    /// 시험 전용 합성 가게 개인키(0x11 반복) — 폰 시험 벡터를 만든 그 값. 실제 키 아님.
    pub(crate) fn synth_signer(d: &[u8; 32]) -> Result<[u8; 64], ()> {
        let sk = secp256k1::SecretKey::from_byte_array(&[0x11u8; 32]).map_err(|_| ())?;
        Ok(Secp256k1::new().sign_ecdsa(&Message::from_digest(*d), &sk).serialize_compact())
    }

    #[test]
    fn signing_gives_the_same_bytes_as_the_phone() {
        let v = v();
        for name in ["empty", "revoked", "stale"] {
            let l = &v["lists"][name];
            let again = sign_doc(DEVICE_REVOKE_DOMAIN, l, &sk(&v), synth_signer).unwrap();
            assert_eq!(&again, l, "목록 {name} 서명이 폰과 다르다");
        }
        for (name, c) in v["certs"].as_object().unwrap() {
            let again = sign_doc(DEVICE_CERT_DOMAIN, c, &sk(&v), synth_signer).unwrap();
            assert_eq!(&again, c, "증서 {name} 서명이 폰과 다르다");
        }
        // 다른 키로 서명하면 가게 키와 맞지 않아 거절(복구 번호를 못 찾음).
        let other = |d: &[u8; 32]| -> Result<[u8; 64], ()> {
            let k = secp256k1::SecretKey::from_byte_array(&[0x22u8; 32]).unwrap();
            Ok(Secp256k1::new().sign_ecdsa(&Message::from_digest(*d), &k).serialize_compact())
        };
        assert_eq!(sign_doc(DEVICE_REVOKE_DOMAIN, &v["lists"]["empty"], &sk(&v), other), Err(SignError::KeyMismatch));
        assert_eq!(sign_doc(DEVICE_REVOKE_DOMAIN, &v["lists"]["empty"], &sk(&v), |_| Err(())), Err(SignError::Signer));
        assert_eq!(sign_doc(DEVICE_REVOKE_DOMAIN, &json!([1]), &sk(&v), synth_signer), Err(SignError::Shape));
    }

    fn list(v: &Value, seq: u64, issued: i64, revoked: &[&str], pruned: i64) -> Value {
        let body = json!({ "v": 1, "storeId": v["storeId"], "seq": seq, "revoked": revoked, "issuedAt": issued, "prunedBefore": pruned });
        sign_doc(DEVICE_REVOKE_DOMAIN, &body, &sk(v), synth_signer).unwrap()
    }

    #[test]
    fn a_list_is_accepted_only_forward() {
        let v = v();
        let (k, id, t) = (sk(&v), v["storeId"].as_str().unwrap().to_string(), now(&v));
        let a = "aa".repeat(32);
        let b = "bb".repeat(32);
        let l1 = list(&v, 1, t, &[a.as_str()], 0);
        assert!(matches!(accept_revocation_list(None, &l1, &k, &id), Ok(ListAccept::Newer(_, ListInfo { seq: 1, .. }))));
        let l2 = list(&v, 2, t + 1000, &[a.as_str(), b.as_str()], 0);
        assert!(matches!(accept_revocation_list(Some(&l1), &l2, &k, &id), Ok(ListAccept::Newer(_, _))));
        assert_eq!(accept_revocation_list(Some(&l2), &l1, &k, &id), Ok(ListAccept::KeptCurrent), "옛 번호는 무시");
        assert_eq!(accept_revocation_list(Some(&l2), &l2, &k, &id), Ok(ListAccept::KeptCurrent));
        let back = list(&v, 3, t - 1000, &[a.as_str(), b.as_str()], 0);
        assert_eq!(accept_revocation_list(Some(&l2), &back, &k, &id), Err(ListReject::Rollback));
        let shrunk = list(&v, 3, t + 2000, &[b.as_str()], 0);
        assert_eq!(accept_revocation_list(Some(&l2), &shrunk, &k, &id), Err(ListReject::Shrunk), "철회한 기기를 되살릴 수 없다");
        let pruned = list(&v, 3, t + 2000, &[b.as_str()], 5);
        assert!(matches!(accept_revocation_list(Some(&l2), &pruned, &k, &id), Ok(ListAccept::Newer(_, _))), "가지치기를 올리면 뺄 수 있다");
        let mut forged = l2.clone();
        forged["seq"] = json!(9);
        assert_eq!(accept_revocation_list(Some(&l1), &forged, &k, &id), Err(ListReject::Bad(CertReason::Signature)));
        assert_eq!(accept_revocation_list(None, &l1, &k, &"cd".repeat(32)), Err(ListReject::Bad(CertReason::OtherStore)));
        assert_eq!(accept_revocation_list(None, &json!({}), &k, &id), Err(ListReject::Bad(CertReason::Shape)));
    }

    #[test]
    fn a_list_missing_fields_is_shape_not_a_panic() {
        let v = v();
        let c = &v["certs"]["remote"];
        for bad in [json!({}), json!({ "v": 1 }), json!({ "v": 1, "storeId": v["storeId"], "seq": 1, "sig": "x" })] {
            assert_eq!(verify_device_cert(c, &sk(&v), now(&v), Some(&bad), None).err(), Some(CertReason::Shape), "{bad}");
        }
    }
}
