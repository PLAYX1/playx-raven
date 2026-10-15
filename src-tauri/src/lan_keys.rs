//! LAN 동기화 v2 — 열쇠 나누기(세션 열쇠·봉인 열쇠·확인값 열쇠)와 열쇠 기록·회전 관문. 데스크탑(서버) 쪽.
//!
//! 규격 정본 = `docs/LAN-REQUEST-SIGNING.md`(레인 J) §3·§4, 폰/코어 구현 `core/device/lan-auth.ts`·`data-key.ts`.
//! 같은 바이트가 나오는지는 `testdata/rv-lan-v2-vectors.json`(폰 코드가 만든 값, 합성 열쇠)으로 시험한다.
//!
//!   shared     = 압축 점 33바이트 = ECDH(eph 개인키, devicePubKey)            ※ x 좌표 32바이트만이 아니다
//!   sessionKey = HKDF-SHA256(ikm=shared, salt=eph(33)‖devicePubKey(33), info="RAVENVAULT-LAN-SESSION-V1", 32)
//!   sealKey    = HKDF-SHA256(ikm=dataKey, salt=sessionKey, info=정본JSON["RAVENVAULT-LAN-KEY-V2","seal",가게,증서,판], 32)
//!   proofKey   = 같은 식, 용도 "proof"
//!
//! 열쇠 기록(앱 폴더 `lan/keys.json`, 0600)은 데이터 열쇠 판·기기별 세션 열쇠·회전 때의 철회 목록(seq·revoked·서명된 목록 본문)을
//! **한 파일**에 담는다 — 회전 결과(새 열쇠 + 새 철회 목록)를 원자적으로 한 번에 저장하기 위해서다(§4.1 ②).
//!
//! 🔴 이 파일은 열쇠를 만들지도 나눠 주지도 않는다(데이터 열쇠 생성·봉투 전달은 결정 대기 — 결정 표 참고).
//!    12단어·지갑·.env 를 열지 않는다. 세션 열쇠·데이터 열쇠 바이트는 떨어질 때 지운다.

#![allow(dead_code)] // 봉투를 만드는 쪽(Rust 발급·회전)은 아직 없다

use crate::lan_cert::{verify_revocation_list, ListInfo, MAX_REVOKED};
use crate::lan_proof::canonical_string;
use crate::lan_seal::DataKey;
use hkdf::Hkdf;
use secp256k1::{PublicKey, Scalar, Secp256k1, SecretKey};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;

pub const LAN_KEY_DOMAIN: &str = "RAVENVAULT-LAN-KEY-V2";
pub const DEVICE_SESSION_DOMAIN: &str = "RAVENVAULT-LAN-SESSION-V1";
pub const DEVICE_DATA_KEY_DOMAIN: &str = "RAVENVAULT-DEVICE-DATA-KEY-V1";
/// 열쇠 기록 하나에 담는 세션(기기) 수 상한 — 철회 목록 상한과 같은 크기.
pub const MAX_SESSIONS: usize = MAX_REVOKED;
const MAX_SAFE: u64 = 9_007_199_254_740_991;

fn is_sha(s: &str) -> bool {
    s.len() == 64 && s.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

// ── ECDH · HKDF ─────────────────────────────────────────────

/// ECDH 공유값 = (상대 공개키 × 내 스칼라) 의 **압축 점 33바이트 전체**. noble `getSharedSecret(priv, pub, true)` 와 같은 바이트.
/// (k256/secp256k1 의 「공유 비밀」 32바이트 x 좌표·해시가 아니다 — 규격 §6.3.)
pub fn ecdh_compressed(secret: &[u8; 32], public: &[u8; 33]) -> Option<[u8; 33]> {
    let sk = SecretKey::from_byte_array(secret).ok()?;
    let pk = PublicKey::from_slice(public).ok()?;
    let point = pk.mul_tweak(&Secp256k1::verification_only(), &Scalar::from(sk)).ok()?;
    Some(point.serialize())
}

fn hkdf32(ikm: &[u8], salt: &[u8], info: &[u8]) -> [u8; 32] {
    let mut out = [0u8; 32];
    // 32바이트 출력은 HKDF-SHA256 상한(8160바이트) 안이라 실패하지 않는다.
    let _ = Hkdf::<Sha256>::new(Some(salt), ikm).expand(info, &mut out);
    out
}

fn eph_salt(eph: &[u8; 33], recipient: &[u8; 33]) -> [u8; 66] {
    let mut salt = [0u8; 66];
    salt[..33].copy_from_slice(eph);
    salt[33..].copy_from_slice(recipient);
    salt
}

/// 떨어질 때 바이트를 지우는 32바이트 비밀(세션 열쇠).
#[derive(Clone, PartialEq, Eq)]
pub struct Secret32(pub [u8; 32]);
impl Drop for Secret32 {
    fn drop(&mut self) {
        crate::words::wipe_bytes(&mut self.0);
    }
}
impl std::fmt::Debug for Secret32 {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Secret32(…)")
    }
}

/// 기기별 세션 열쇠(§3.1) — 봉투 열쇠와 같은 ECDH 공유값에서 다른 info 로.
pub fn session_key_of(shared: &[u8; 33], eph: &[u8; 33], recipient: &[u8; 33]) -> Secret32 {
    Secret32(hkdf32(shared, &eph_salt(eph, recipient), DEVICE_SESSION_DOMAIN.as_bytes()))
}

/// 봉투(데이터 열쇠) 감싸는 열쇠 — data-key.ts `wrapKey`. 지금은 시험 벡터 대조에만 쓴다(봉투 만들기·열기는 이 레인 밖).
pub(crate) fn wrap_key_of(shared: &[u8; 33], eph: &[u8; 33], recipient: &[u8; 33]) -> Secret32 {
    Secret32(hkdf32(shared, &eph_salt(eph, recipient), DEVICE_DATA_KEY_DOMAIN.as_bytes()))
}

/// 봉투를 만드는 PC 쪽: eph 개인키와 기기 공개키로 세션 열쇠를 얻는다(공유값은 바로 지운다).
pub fn session_key_for_device(eph_secret: &[u8; 32], device_pub: &[u8; 33]) -> Option<Secret32> {
    let eph_pub = SecretKey::from_byte_array(eph_secret).ok()?.public_key(&Secp256k1::signing_only()).serialize();
    let mut shared = ecdh_compressed(eph_secret, device_pub)?;
    let out = session_key_of(&shared, &eph_pub, device_pub);
    crate::words::wipe_bytes(&mut shared);
    Some(out)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LanPurpose {
    Seal,
    Proof,
}
impl LanPurpose {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Seal => "seal",
            Self::Proof => "proof",
        }
    }
}

/// info(용도) = utf8(정본JSON[LAN_KEY_DOMAIN, 용도, 가게, 증서, 열쇠 판]).
pub fn lan_key_info(purpose: LanPurpose, store_id: &str, cert_id: &str, version: u64) -> Result<String, &'static str> {
    canonical_string(&json!([LAN_KEY_DOMAIN, purpose.as_str(), store_id, cert_id, version]))
}

/// lan-auth.ts `deriveLanKey` — HKDF(ikm=데이터 열쇠, salt=세션 열쇠, info=용도). 판은 데이터 열쇠 판 그대로.
pub fn derive_lan_key(data_key: &DataKey, session: &[u8; 32], purpose: LanPurpose, store_id: &str, cert_id: &str) -> Result<DataKey, &'static str> {
    if !(1..=MAX_SAFE).contains(&data_key.version) || data_key.key.iter().all(|b| *b == 0) || session.iter().all(|b| *b == 0) {
        return Err("lan-key: key");
    }
    if !is_sha(store_id) || !is_sha(cert_id) {
        return Err("lan-key: bind");
    }
    let info = lan_key_info(purpose, store_id, cert_id, data_key.version)?;
    Ok(DataKey { version: data_key.version, key: hkdf32(&data_key.key, session, info.as_bytes()) })
}

/// 기기 하나의 봉인 열쇠·확인값 열쇠(둘 다 떨어질 때 지워진다 — `DataKey` Drop).
pub struct LanDerivedKeys {
    pub seal: DataKey,
    pub proof: DataKey,
}
pub fn derive_lan_keys(data_key: &DataKey, session: &[u8; 32], store_id: &str, cert_id: &str) -> Result<LanDerivedKeys, &'static str> {
    Ok(LanDerivedKeys {
        seal: derive_lan_key(data_key, session, LanPurpose::Seal, store_id, cert_id)?,
        proof: derive_lan_key(data_key, session, LanPurpose::Proof, store_id, cert_id)?,
    })
}

// ── 회전 관문(§4.3) ─────────────────────────────────────────

/// lan-auth.ts `lanKeyRotationGate`: 지금 목록의 철회가 모두 회전 때 목록(`revoked_at_rotation`)에 들어 있고,
/// 목록 seq 가 회전 때 seq 보다 작지 않아야 'ok'. 가지치기로 빠진 id 는 괜찮다(부분집합 검사). 목록은 서명 확인이 끝난 것.
pub fn rotation_gate_ok(revocation_seq: u64, revoked_at_rotation: &[String], list: &ListInfo) -> bool {
    if list.seq < revocation_seq {
        return false; // 열쇠 기록보다 옛 목록 — 되감기
    }
    list.revoked.iter().all(|id| revoked_at_rotation.iter().any(|r| r == id))
}

// ── 열쇠 기록 ───────────────────────────────────────────────

/// 세션 표의 한 칸: 그 증서(certId)에 대한 세션 열쇠 + 그 증서가 이 PC 가 낸 그 증서인지 대조할 값(기기 번호·증서 서명).
#[derive(Clone, Debug)]
pub struct SessionEntry {
    pub key: Secret32,
    pub device_id: String,
    /// 증서의 `sig`(가게 키 서명, base64). 같은 certId 인데 다른 증서 문서면 받지 않는다(§2.4 ⑦ 「서명 바이트 일치」).
    pub cert_sig: String,
}

/// 열쇠 기록 v2(§4.1 ②): `{ v:2, keyVersion, dataKey, sessions:{certId:{key,deviceId,certSig}}, revocationSeq, revokedAtRotation, revocations }`.
#[derive(Clone)]
pub struct LanKeyRecord {
    pub data_key: DataKey,
    pub sessions: BTreeMap<String, SessionEntry>,
    pub revocation_seq: u64,
    pub revoked_at_rotation: Vec<String>,
    /// 회전 때 함께 서명한 철회 목록 본문(가게 키 서명). 열쇠와 한 파일에 있어야 원자적이다.
    pub revocations: Value,
}
impl std::fmt::Debug for LanKeyRecord {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("LanKeyRecord").field("keyVersion", &self.data_key.version).field("sessions", &self.sessions.len()).field("revocationSeq", &self.revocation_seq).finish()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RecordError {
    /// 기록 모양이 틀렸다.
    Shape,
    /// 함께 저장된 철회 목록이 가게 키 서명·가게 번호를 못 넘었다.
    List,
    /// revocationSeq·revokedAtRotation 이 함께 저장된 목록과 다르다.
    Meta,
    /// 철회된 증서의 세션이 남아 있다.
    RevokedSession,
    /// 지금 쓰는 것보다 옛 열쇠 판(또는 같은 판인데 다른 열쇠·세션을 바꿈).
    KeyRollback,
    /// 지금 목록보다 옛 철회 목록.
    ListRollback,
}
impl RecordError {
    pub fn code(self) -> &'static str {
        match self {
            Self::Shape => "keys-shape",
            Self::List => "keys-list",
            Self::Meta => "keys-meta",
            Self::RevokedSession => "keys-revoked-session",
            Self::KeyRollback => "keys-rollback",
            Self::ListRollback => "keys-list-rollback",
        }
    }
}

fn hex32(v: &Value) -> Option<[u8; 32]> {
    let s = v.as_str().filter(|s| is_sha(s))?;
    let b = hex::decode(s).ok()?;
    let mut out = [0u8; 32];
    out.copy_from_slice(&b);
    (out.iter().any(|x| *x != 0)).then_some(out)
}
fn keys_are(o: &Map<String, Value>, want: &[&str]) -> bool {
    o.len() == want.len() && want.iter().all(|k| o.contains_key(*k))
}

impl LanKeyRecord {
    pub fn key_version(&self) -> u64 {
        self.data_key.version
    }

    /// 모양만 읽는다(서명·조건 확인은 `check`).
    pub fn parse(v: &Value) -> Result<Self, RecordError> {
        let o = v.as_object().ok_or(RecordError::Shape)?;
        if !keys_are(o, &["v", "keyVersion", "dataKey", "sessions", "revocationSeq", "revokedAtRotation", "revocations"]) || o["v"].as_u64() != Some(2) {
            return Err(RecordError::Shape);
        }
        let version = o["keyVersion"].as_u64().filter(|n| (1..=MAX_SAFE).contains(n)).ok_or(RecordError::Shape)?;
        let key = hex32(&o["dataKey"]).ok_or(RecordError::Shape)?;
        let data_key = DataKey { version, key };
        let revocation_seq = o["revocationSeq"].as_u64().filter(|n| (1..=MAX_SAFE).contains(n)).ok_or(RecordError::Shape)?;
        let revoked_at_rotation: Vec<String> = o["revokedAtRotation"]
            .as_array()
            .filter(|a| a.len() <= MAX_REVOKED)
            .and_then(|a| a.iter().map(|x| x.as_str().filter(|s| is_sha(s)).map(str::to_string)).collect())
            .ok_or(RecordError::Shape)?;
        let sm = o["sessions"].as_object().filter(|m| m.len() <= MAX_SESSIONS).ok_or(RecordError::Shape)?;
        let mut sessions = BTreeMap::new();
        for (cert_id, e) in sm {
            let eo = e.as_object().ok_or(RecordError::Shape)?;
            if !is_sha(cert_id) || !keys_are(eo, &["key", "deviceId", "certSig"]) {
                return Err(RecordError::Shape);
            }
            let key = hex32(&eo["key"]).ok_or(RecordError::Shape)?;
            let device_id = eo["deviceId"].as_str().filter(|s| is_sha(s)).ok_or(RecordError::Shape)?.to_string();
            let cert_sig = eo["certSig"].as_str().filter(|s| !s.is_empty() && s.len() <= 200).ok_or(RecordError::Shape)?.to_string();
            sessions.insert(cert_id.clone(), SessionEntry { key: Secret32(key), device_id, cert_sig });
        }
        if !o["revocations"].is_object() {
            return Err(RecordError::Shape);
        }
        Ok(LanKeyRecord { data_key, sessions, revocation_seq, revoked_at_rotation, revocations: o["revocations"].clone() })
    }

    /// 저장 모양(비밀 값이 들어 있다 — 0600 파일에만 쓴다. 화면·로그에 싣지 않는다).
    pub fn to_json(&self) -> Value {
        let sessions: Map<String, Value> = self
            .sessions
            .iter()
            .map(|(id, e)| (id.clone(), json!({ "key": hex::encode(e.key.0), "deviceId": e.device_id, "certSig": e.cert_sig })))
            .collect();
        json!({
            "v": 2,
            "keyVersion": self.data_key.version,
            "dataKey": hex::encode(self.data_key.key),
            "sessions": sessions,
            "revocationSeq": self.revocation_seq,
            "revokedAtRotation": self.revoked_at_rotation,
            "revocations": self.revocations,
        })
    }

    /// 규격 §4.2 의 ①③④ — 함께 저장된 목록이 가게 키로 서명됐고 같은 가게, 메타가 그 목록과 같고, 철회된 증서의 세션이 없다.
    /// (②열쇠 판 단조·①목록 seq 단조는 지금 상태와 비교해야 하므로 `check_against`.) 통과하면 그 목록 요약.
    pub fn check(&self, store_key: &str, store_id: &str) -> Result<ListInfo, RecordError> {
        let info = verify_revocation_list(&self.revocations, store_key, store_id).map_err(|_| RecordError::List)?;
        if info.seq != self.revocation_seq || info.revoked != self.revoked_at_rotation {
            return Err(RecordError::Meta);
        }
        if self.sessions.keys().any(|id| info.revoked.iter().any(|r| r == id)) {
            return Err(RecordError::RevokedSession);
        }
        Ok(info)
    }

    /// §4.2 ② — 지금 쓰는 기록(`current`)과 비교. 판이 크면 받는다. 같은 판이면 데이터 열쇠 바이트가 같고 지금 세션을 하나도 바꾸지
    /// 않아야 한다(새로 낸 기기의 세션을 더하는 것만 허용 — 결정 표 L-3). 작으면 되감기.
    pub fn check_against(&self, current: &LanKeyRecord) -> Result<(), RecordError> {
        let (n, c) = (self.data_key.version, current.data_key.version);
        if n > c {
            return Ok(());
        }
        if n < c || self.data_key.key != current.data_key.key {
            return Err(RecordError::KeyRollback);
        }
        let kept = current.sessions.iter().all(|(id, e)| self.sessions.get(id).is_some_and(|x| x.key == e.key && x.device_id == e.device_id && x.cert_sig == e.cert_sig));
        if !kept || self.revocation_seq < current.revocation_seq {
            return Err(RecordError::KeyRollback);
        }
        Ok(())
    }

    /// 재료 지문에 넣는 해시(열쇠 바이트는 해시로만).
    pub fn digest(&self) -> [u8; 32] {
        let text = canonical_string(&self.to_json()).unwrap_or_default();
        let mut h = Sha256::new();
        h.update(b"RAVENVAULT-LAN-KEYS-FP-V1\0");
        h.update(text.as_bytes());
        h.finalize().into()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::lan_seal::{open_chunk, seal_chunk, ChunkBinding};

    pub(crate) fn v2() -> Value {
        serde_json::from_str(include_str!("../testdata/rv-lan-v2-vectors.json")).unwrap()
    }
    fn b32(s: &str) -> [u8; 32] {
        hex::decode(s).unwrap().try_into().unwrap()
    }
    fn b33(s: &str) -> [u8; 33] {
        hex::decode(s).unwrap().try_into().unwrap()
    }
    fn data_key(v: &Value) -> DataKey {
        DataKey { version: v["dataKey"]["version"].as_u64().unwrap(), key: b32(v["dataKey"]["keyHex"].as_str().unwrap()) }
    }

    /// 봉투 ECDH: 양쪽(eph 개인키 × 기기 공개키, 기기 개인키 × eph 공개키)이 같은 압축 점 33바이트 → 같은 세션 열쇠.
    #[test]
    fn v2_session_key_matches_the_phone_from_both_sides() {
        let v = v2();
        let env = &v["envelope"];
        let eph_sk = b32(env["ephPrivHex_TEST_ONLY"].as_str().unwrap());
        let dev_sk = b32(v["device"]["devicePrivHex_TEST_ONLY"].as_str().unwrap());
        let dev_pub = b33(v["device"]["devicePubKey"].as_str().unwrap());
        let eph_pub = b33(env["sealed"]["eph"].as_str().unwrap());
        let a = ecdh_compressed(&eph_sk, &dev_pub).unwrap();
        let b = ecdh_compressed(&dev_sk, &eph_pub).unwrap();
        assert_eq!(hex::encode(a), env["sharedCompressedHex"].as_str().unwrap());
        assert_eq!(a, b);
        assert_eq!(a.len(), 33, "압축 점 전체(머리 바이트 포함)");
        let s = session_key_of(&a, &eph_pub, &dev_pub);
        assert_eq!(hex::encode(s.0), env["sessionKeyHex"].as_str().unwrap());
        assert_eq!(session_key_for_device(&eph_sk, &dev_pub).unwrap(), s, "PC 쪽 편의 함수도 같은 값");
        // x 좌표 32바이트만 쓰면 다른 값 — 흔한 실수를 막는다.
        let wrong = Secret32(hkdf32(&a[1..], &eph_salt(&eph_pub, &dev_pub), DEVICE_SESSION_DOMAIN.as_bytes()));
        assert_ne!(wrong, s);
        // 같은 공유값의 봉투 열쇠로 봉투 ct 를 열면 벡터의 데이터 열쇠가 나온다(봉투 바이트는 v1 그대로).
        use chacha20poly1305::aead::{Aead, KeyInit, Payload};
        let sealed = env["sealed"].as_object().unwrap();
        let mut header = sealed.clone();
        header.shift_remove("ct");
        header.shift_remove("sig");
        let aad = canonical_string(&json!([DEVICE_DATA_KEY_DOMAIN, Value::Object(header)])).unwrap();
        let wrap = wrap_key_of(&a, &eph_pub, &dev_pub);
        let pt = chacha20poly1305::XChaCha20Poly1305::new((&wrap.0).into())
            .decrypt(chacha20poly1305::XNonce::from_slice(&hex::decode(sealed["nonce"].as_str().unwrap()).unwrap()), Payload { msg: &hex::decode(sealed["ct"].as_str().unwrap()).unwrap(), aad: aad.as_bytes() })
            .unwrap();
        assert_eq!(hex::encode(pt), v["dataKey"]["keyHex"].as_str().unwrap());
        assert_ne!(wrap.0, s.0, "봉투 열쇠 ≠ 세션 열쇠");
    }

    #[test]
    fn v2_seal_and_proof_keys_match_the_phone() {
        let v = v2();
        let lk = &v["lanKeys"];
        let (sid, cid) = (v["store"]["storeId"].as_str().unwrap(), v["device"]["certId"].as_str().unwrap());
        assert_eq!(lan_key_info(LanPurpose::Seal, sid, cid, 3).unwrap(), lk["sealInfo"].as_str().unwrap());
        assert_eq!(lan_key_info(LanPurpose::Proof, sid, cid, 3).unwrap(), lk["proofInfo"].as_str().unwrap());
        let sess = b32(v["envelope"]["sessionKeyHex"].as_str().unwrap());
        let k = derive_lan_keys(&data_key(&v), &sess, sid, cid).unwrap();
        assert_eq!(hex::encode(k.seal.key), lk["sealKeyHex"].as_str().unwrap());
        assert_eq!(hex::encode(k.proof.key), lk["proofKeyHex"].as_str().unwrap());
        assert_eq!((k.seal.version, k.proof.version), (3, 3));
        // 네 열쇠가 서로 다르다: 봉인 ≠ 확인값 ≠ 데이터 ≠ 세션.
        let all = [k.seal.key, k.proof.key, data_key(&v).key, sess];
        for i in 0..4 {
            for j in i + 1..4 {
                assert_ne!(all[i], all[j], "{i}/{j}");
            }
        }
        // 다른 증서·다른 판·다른 세션이면 다른 열쇠.
        assert_ne!(derive_lan_key(&data_key(&v), &sess, LanPurpose::Seal, sid, &"cd".repeat(32)).unwrap().key, k.seal.key);
        assert_ne!(derive_lan_key(&DataKey { version: 4, key: data_key(&v).key }, &sess, LanPurpose::Seal, sid, cid).unwrap().key, k.seal.key);
        assert_ne!(derive_lan_key(&data_key(&v), &[7u8; 32], LanPurpose::Seal, sid, cid).unwrap().key, k.seal.key);
        // 모양 거절
        assert!(derive_lan_key(&data_key(&v), &[0u8; 32], LanPurpose::Seal, sid, cid).is_err());
        assert!(derive_lan_key(&DataKey { version: 0, key: [1; 32] }, &sess, LanPurpose::Seal, sid, cid).is_err());
        assert!(derive_lan_key(&data_key(&v), &sess, LanPurpose::Seal, "AB", cid).is_err());
    }

    /// 조각 봉인: v1 알고리즘·모양·AAD 그대로, 열쇠만 sealKey → 폰과 같은 바이트. 데이터 열쇠 그대로는 열리지 않는다.
    #[test]
    fn v2_chunk_sealed_with_the_seal_key_is_byte_identical() {
        let v = v2();
        let c = &v["chunk"];
        let b = &c["bind"];
        let bind = ChunkBinding {
            store_id: b["storeId"].as_str().unwrap(),
            cert_id: b["certId"].as_str().unwrap(),
            device_id: b["deviceId"].as_str().unwrap(),
            dir: b["dir"].as_str().unwrap(),
            chunk_id: b["chunkId"].as_str().unwrap(),
            from: b["from"].as_u64().unwrap(),
        };
        let sess = b32(v["envelope"]["sessionKeyHex"].as_str().unwrap());
        let k = derive_lan_keys(&data_key(&v), &sess, bind.store_id, bind.cert_id).unwrap();
        let nonce: [u8; 24] = hex::decode(c["rngNonceHex"].as_str().unwrap()).unwrap().try_into().unwrap();
        let entries = c["entries"].as_array().unwrap().clone();
        assert_eq!(seal_chunk(&entries, &k.seal, &bind, &nonce).unwrap(), c["sealed"]);
        assert_eq!(c["sealed"], v["requests"]["push"]["wire"]["sealed"]);
        assert_eq!(open_chunk(&c["sealed"], &k.seal, &bind).unwrap(), entries);
        assert!(open_chunk(&c["sealed"], &data_key(&v), &bind).is_err(), "v1 열쇠(데이터 열쇠 그대로)로는 열리지 않는다");
        assert!(open_chunk(&c["sealed"], &k.proof, &bind).is_err(), "확인값 열쇠로는 열리지 않는다");
    }

    #[test]
    fn v2_rotation_gate_matches_the_phone() {
        let v = v2();
        let (key, sid) = (v["store"]["storeKey"].as_str().unwrap(), v["store"]["storeId"].as_str().unwrap());
        let cases = v["rotationGate"].as_array().unwrap();
        assert_eq!(cases.len(), 4);
        for g in cases {
            let info = verify_revocation_list(&g["list"], key, sid).unwrap();
            let m = &g["meta"];
            let rev: Vec<String> = m["revokedAtRotation"].as_array().unwrap().iter().map(|x| x.as_str().unwrap().to_string()).collect();
            let got = if rotation_gate_ok(m["revocationSeq"].as_u64().unwrap(), &rev, &info) { "ok" } else { "rotation-required" };
            assert_eq!(got, g["expect"].as_str().unwrap(), "{}", g["name"]);
        }
    }

    fn record_from(v: &Value, list: &Value, sessions: &[(&str, [u8; 32])]) -> LanKeyRecord {
        let info = verify_revocation_list(list, v["store"]["storeKey"].as_str().unwrap(), v["store"]["storeId"].as_str().unwrap()).unwrap();
        LanKeyRecord {
            data_key: data_key(v),
            sessions: sessions.iter().map(|(id, k)| (id.to_string(), SessionEntry { key: Secret32(*k), device_id: "dd".repeat(32), cert_sig: "c2ln".into() })).collect(),
            revocation_seq: info.seq,
            revoked_at_rotation: info.revoked,
            revocations: list.clone(),
        }
    }

    #[test]
    fn a_key_record_round_trips_and_checks_its_list_and_meta() {
        let v = v2();
        let (key, sid) = (v["store"]["storeKey"].as_str().unwrap(), v["store"]["storeId"].as_str().unwrap());
        let cid = v["device"]["certId"].as_str().unwrap();
        let rec = record_from(&v, &v["revocationList"], &[(cid, [5u8; 32])]);
        let again = LanKeyRecord::parse(&rec.to_json()).unwrap();
        assert_eq!(again.to_json(), rec.to_json());
        assert_eq!(again.digest(), rec.digest());
        assert_eq!(again.check(key, sid).unwrap().seq, 4);
        // 메타가 목록과 다르면 거절
        let mut bad = rec.clone();
        bad.revocation_seq = 5;
        assert_eq!(bad.check(key, sid).err(), Some(RecordError::Meta));
        // 목록 서명이 깨졌으면 거절
        let mut bad = rec.clone();
        bad.revocations["seq"] = json!(9);
        assert_eq!(bad.check(key, sid).err(), Some(RecordError::List));
        // 다른 가게 번호
        assert_eq!(rec.check(key, &"cd".repeat(32)).err(), Some(RecordError::List));
        // 철회된 증서의 세션이 남아 있으면 거절(회전 후 목록 = 이 certId 철회)
        let rotated = v["rotationGate"][2]["list"].clone();
        let bad = record_from(&v, &rotated, &[(cid, [5u8; 32])]);
        assert_eq!(bad.check(key, sid).err(), Some(RecordError::RevokedSession));
        // 모양 거절
        let muts: [fn(&mut Value); 6] = [
            |j: &mut Value| j["v"] = json!(1),
            |j: &mut Value| j["dataKey"] = json!("00".repeat(32)),
            |j: &mut Value| j["keyVersion"] = json!(0),
            |j: &mut Value| j["extra"] = json!(1),
            |j: &mut Value| j["sessions"]["AB"] = json!({}),
            |j: &mut Value| j["revokedAtRotation"] = json!(["zz"]),
        ];
        for mutate in muts {
            let mut j = rec.to_json();
            mutate(&mut j);
            assert_eq!(LanKeyRecord::parse(&j).err(), Some(RecordError::Shape), "{j}");
        }
        // Debug 에 열쇠 바이트가 없다.
        let dbg = format!("{rec:?} {:?}", rec.sessions);
        assert!(!dbg.contains(&hex::encode(rec.data_key.key)) && !dbg.contains(&"05".repeat(32)));
    }

    #[test]
    fn a_key_record_never_goes_back() {
        let v = v2();
        let cid = v["device"]["certId"].as_str().unwrap();
        let cur = record_from(&v, &v["revocationList"], &[(cid, [5u8; 32])]);
        // 같은 기록 재적용 · 같은 판에 새 기기 세션 추가는 받는다.
        assert!(cur.check_against(&cur).is_ok());
        let mut more = cur.clone();
        more.sessions.insert("ee".repeat(32), SessionEntry { key: Secret32([6; 32]), device_id: "ee".repeat(32), cert_sig: "eA==".into() });
        assert!(more.check_against(&cur).is_ok());
        // 같은 판인데 열쇠·기존 세션이 바뀌거나 빠지면 거절.
        let mut k = cur.clone();
        k.data_key.key[0] ^= 1;
        assert_eq!(k.check_against(&cur), Err(RecordError::KeyRollback));
        let mut s = cur.clone();
        s.sessions.get_mut(cid).unwrap().key = Secret32([9; 32]);
        assert_eq!(s.check_against(&cur), Err(RecordError::KeyRollback));
        let mut gone = cur.clone();
        gone.sessions.clear();
        assert_eq!(gone.check_against(&cur), Err(RecordError::KeyRollback));
        // 판이 작으면 거절, 크면 받는다.
        let mut old = cur.clone();
        old.data_key.version = 2;
        assert_eq!(old.check_against(&cur), Err(RecordError::KeyRollback));
        let mut new = cur.clone();
        new.data_key.version = 4;
        new.sessions.clear();
        assert!(new.check_against(&cur).is_ok());
    }
}
