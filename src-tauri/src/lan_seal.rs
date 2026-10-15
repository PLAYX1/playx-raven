//! LAN 동기화 ② — 변경 로그 조각 봉인 열기/닫기. 데스크탑(서버) 쪽.
//!
//! 규격 정본 = 폰 `phone/network/real/lan/seal.ts`(통합 브랜치). XChaCha20-Poly1305, 열쇠 = 데이터 열쇠(32바이트) 그대로,
//! 24바이트 nonce 는 봉투에 hex 로 둔다. AAD = 정본JSON[도메인, 가게, 증서, 기기, 방향, 조각 번호, 커서(from), 열쇠 판] 이라
//! 다른 기기·다른 조각·반대 방향으로 옮겨 붙인 봉투는 열리지 않는다. 같은 값이 나오는지는 `testdata/rv-lan-seal-vectors.json`
//! (폰 코드가 만든 값, 합성 열쇠)으로 시험한다.
//!
//!   봉투 = { v:1, keyVersion, nonce:<hex 48>, ct:<base64> }, 평문 = JSON 배열(항목 ≤ 50개, ≤ 64KiB)
//!   열기 오류: 모양 틀림 → Malformed, 열쇠 판 다름 → Stale(새 열쇠 필요), 열리지 않음 → Forbidden(bad-seal)

#![allow(dead_code)] // 처리기(lan_handler)가 쓴다

use crate::lan_proof::canonical_string;
use base64::{engine::general_purpose::STANDARD, Engine as _};
use chacha20poly1305::aead::{Aead, KeyInit, Payload};
use chacha20poly1305::{XChaCha20Poly1305, XNonce};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

pub const LAN_SEAL_DOMAIN: &str = "RAVENVAULT-LAN-CHUNK-V1";
pub const CHUNK_MAX_ENTRIES: usize = 50;
pub const CHUNK_MAX_BYTES: usize = 64 * 1024;
/// 봉투 ct(base64) 글자 수 상한 — 폰 SEALED_MAX_CHARS 와 같다.
pub const SEALED_MAX_CHARS: usize = ((CHUNK_MAX_BYTES + 64) * 4).div_ceil(3) + 16;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SealError {
    Malformed(&'static str),
    Stale,
    Forbidden,
    OutOfRange(&'static str),
}

/// 데이터 열쇠 — 판 번호와 32바이트.
#[derive(Clone)]
pub struct DataKey {
    pub version: u64,
    pub key: [u8; 32],
}

pub struct ChunkBinding<'a> {
    pub store_id: &'a str,
    pub cert_id: &'a str,
    pub device_id: &'a str,
    /// "push" 또는 "pull"
    pub dir: &'a str,
    pub chunk_id: &'a str,
    pub from: u64,
}

fn aad_of(b: &ChunkBinding, key_version: u64) -> Result<Vec<u8>, SealError> {
    let v = json!([LAN_SEAL_DOMAIN, b.store_id, b.cert_id, b.device_id, b.dir, b.chunk_id, b.from, key_version]);
    canonical_string(&v).map(String::into_bytes).map_err(|_| SealError::Malformed("aad"))
}

/// 항목 id 목록이 같으면 같은 조각 번호 — 폰 `chunkIdOf`.
pub fn chunk_id_of(device_id: &str, ids: &[&str]) -> String {
    let v = json!([LAN_SEAL_DOMAIN, device_id, ids]);
    hex::encode(Sha256::digest(canonical_string(&v).unwrap_or_default().as_bytes()))
}

fn is_hex_id(v: &Value) -> bool {
    v.as_str().map_or(false, |s| (16..=64).contains(&s.len()) && s.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)))
}
fn safe_nonneg(v: &Value) -> bool {
    v.as_u64().map_or(false, |n| n <= 9_007_199_254_740_991) // 정수만(소수는 as_u64 가 None)
}

/// 폰 `isLogEntry` 와 같은 모양 검사.
pub fn is_log_entry(v: &Value) -> bool {
    let Some(o) = v.as_object() else { return false };
    o.len() == 6
        && ["data", "id", "kind", "origin", "seq", "ts"].iter().all(|k| o.contains_key(*k))
        && is_hex_id(&o["id"])
        && is_hex_id(&o["origin"])
        && safe_nonneg(&o["seq"])
        && safe_nonneg(&o["ts"])
        && o["kind"].as_str().map_or(false, |k| {
            let n = k.encode_utf16().count();
            n > 0 && n <= 32
        })
}

/// 봉투 열기. 평문은 항목 배열이어야 한다.
pub fn open_chunk(raw: &Value, key: &DataKey, bind: &ChunkBinding) -> Result<Vec<Value>, SealError> {
    let s = raw.as_object().ok_or(SealError::Malformed("sealed"))?;
    let shape_ok = s.len() == 4 && ["ct", "keyVersion", "nonce", "v"].iter().all(|k| s.contains_key(*k));
    let nonce = s.get("nonce").and_then(Value::as_str);
    let ct = s.get("ct").and_then(Value::as_str);
    let ver = s.get("keyVersion").and_then(|x| x.as_u64().filter(|n| *n <= 9_007_199_254_740_991));
    let (true, Some(nonce), Some(ct), Some(ver)) = (shape_ok && s["v"].as_u64() == Some(1), nonce, ct, ver) else {
        return Err(SealError::Malformed("sealed"));
    };
    if nonce.len() != 48 || !nonce.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)) || ct.len() > SEALED_MAX_CHARS {
        return Err(SealError::Malformed("sealed"));
    }
    if ver != key.version {
        return Err(SealError::Stale);
    }
    let nonce_bytes = hex::decode(nonce).map_err(|_| SealError::Malformed("sealed"))?;
    let ct_bytes = STANDARD.decode(ct).ok().filter(|b| STANDARD.encode(b) == ct).ok_or(SealError::Forbidden)?;
    let aad = aad_of(bind, key.version)?;
    let cipher = XChaCha20Poly1305::new((&key.key).into());
    let plain = cipher
        .decrypt(XNonce::from_slice(&nonce_bytes), Payload { msg: &ct_bytes, aad: &aad })
        .map_err(|_| SealError::Forbidden)?;
    let text = std::str::from_utf8(&plain).map_err(|_| SealError::Malformed("plain"))?;
    let list: Value = serde_json::from_str(text).map_err(|_| SealError::Malformed("plain"))?;
    let arr = list.as_array().ok_or(SealError::Malformed("entries"))?;
    if arr.len() > CHUNK_MAX_ENTRIES || !arr.iter().all(is_log_entry) {
        return Err(SealError::Malformed("entries"));
    }
    Ok(arr.clone())
}

/// 봉투 닫기(pull 응답용). `nonce` 24바이트는 호출자가 OS 난수로 준다(시험은 고정값).
pub fn seal_chunk(entries: &[Value], key: &DataKey, bind: &ChunkBinding, nonce: &[u8; 24]) -> Result<Value, SealError> {
    if entries.len() > CHUNK_MAX_ENTRIES {
        return Err(SealError::OutOfRange("chunk-size"));
    }
    let plain = serde_json::to_string(entries).map_err(|_| SealError::Malformed("plain"))?;
    if plain.len() > CHUNK_MAX_BYTES {
        return Err(SealError::OutOfRange("chunk-bytes"));
    }
    let aad = aad_of(bind, key.version)?;
    let cipher = XChaCha20Poly1305::new((&key.key).into());
    let ct = cipher
        .encrypt(XNonce::from_slice(nonce), Payload { msg: plain.as_bytes(), aad: &aad })
        .map_err(|_| SealError::Malformed("seal"))?;
    Ok(json!({ "v": 1, "keyVersion": key.version, "nonce": hex::encode(nonce), "ct": STANDARD.encode(ct) }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn v() -> Value {
        serde_json::from_str(include_str!("../testdata/rv-lan-seal-vectors.json")).unwrap()
    }
    fn key(v: &Value) -> DataKey {
        let mut k = [0u8; 32];
        k.copy_from_slice(&hex::decode(v["key_hex"].as_str().unwrap()).unwrap());
        DataKey { version: v["key_version"].as_u64().unwrap(), key: k }
    }
    fn bind<'a>(b: &'a Value) -> ChunkBinding<'a> {
        ChunkBinding {
            store_id: b["storeId"].as_str().unwrap(),
            cert_id: b["certId"].as_str().unwrap(),
            device_id: b["deviceId"].as_str().unwrap(),
            dir: b["dir"].as_str().unwrap(),
            chunk_id: b["chunkId"].as_str().unwrap(),
            from: b["from"].as_u64().unwrap(),
        }
    }
    fn nonce(v: &Value) -> [u8; 24] {
        let mut n = [0u8; 24];
        n.copy_from_slice(&hex::decode(v["rng_nonce_hex"].as_str().unwrap()).unwrap());
        n
    }

    #[test]
    fn opens_what_the_phone_sealed() {
        let v = v();
        let k = key(&v);
        let got = open_chunk(&v["sealedPush"], &k, &bind(&v["bind"])).unwrap();
        assert_eq!(Value::Array(got), v["entries"]);
        let got = open_chunk(&v["sealedPull"], &k, &bind(&v["pullBind"])).unwrap();
        assert_eq!(Value::Array(got), v["pullEntries"]);
    }

    #[test]
    fn seals_the_same_bytes_as_the_phone() {
        let v = v();
        let k = key(&v);
        let entries = v["entries"].as_array().unwrap().clone();
        assert_eq!(seal_chunk(&entries, &k, &bind(&v["bind"]), &nonce(&v)).unwrap(), v["sealedPush"]);
        let one = v["pullEntries"].as_array().unwrap().clone();
        assert_eq!(seal_chunk(&one, &k, &bind(&v["pullBind"]), &nonce(&v)).unwrap(), v["sealedPull"]);
    }

    #[test]
    fn chunk_id_matches_the_phone() {
        let v = v();
        let ids: Vec<&str> = v["ids"].as_array().unwrap().iter().map(|x| x.as_str().unwrap()).collect();
        assert_eq!(chunk_id_of(v["bind"]["deviceId"].as_str().unwrap(), &ids), v["chunkId"].as_str().unwrap());
    }

    #[test]
    fn a_seal_moved_to_another_device_chunk_direction_or_cursor_does_not_open() {
        let v = v();
        let k = key(&v);
        let s = &v["sealedPush"];
        let ok = bind(&v["bind"]);
        for (name, f) in [
            ("device", ChunkBinding { device_id: "aa".repeat(16).leak(), ..bind(&v["bind"]) }),
            ("store", ChunkBinding { store_id: "cc".repeat(32).leak(), ..bind(&v["bind"]) }),
            ("cert", ChunkBinding { cert_id: "dd".repeat(32).leak(), ..bind(&v["bind"]) }),
            ("dir", ChunkBinding { dir: "pull", ..bind(&v["bind"]) }),
            ("chunk", ChunkBinding { chunk_id: "22".repeat(32).leak(), ..bind(&v["bind"]) }),
            ("from", ChunkBinding { from: 1, ..bind(&v["bind"]) }),
        ] {
            assert_eq!(open_chunk(s, &k, &f), Err(SealError::Forbidden), "{name}");
        }
        assert!(open_chunk(s, &k, &ok).is_ok());
    }

    #[test]
    fn wrong_key_version_is_stale_and_wrong_key_or_tamper_is_forbidden() {
        let v = v();
        let mut k = key(&v);
        let b = bind(&v["bind"]);
        k.version += 1;
        assert_eq!(open_chunk(&v["sealedPush"], &k, &b), Err(SealError::Stale));
        let mut k2 = key(&v);
        k2.key[0] ^= 1;
        assert_eq!(open_chunk(&v["sealedPush"], &k2, &b), Err(SealError::Forbidden));
        let mut s = v["sealedPush"].clone();
        let ct = s["ct"].as_str().unwrap().to_string();
        let mut raw = STANDARD.decode(&ct).unwrap();
        raw[3] ^= 0x40;
        s["ct"] = Value::from(STANDARD.encode(raw));
        assert_eq!(open_chunk(&s, &key(&v), &b), Err(SealError::Forbidden));
    }

    #[test]
    fn bad_envelope_shapes_are_malformed() {
        let v = v();
        let k = key(&v);
        let b = bind(&v["bind"]);
        let m = |x: Value| open_chunk(&x, &k, &b);
        assert!(matches!(m(Value::Null), Err(SealError::Malformed(_))));
        assert!(matches!(m(json!({})), Err(SealError::Malformed(_))));
        let mut s = v["sealedPush"].clone();
        s["extra"] = json!(1);
        assert!(matches!(m(s), Err(SealError::Malformed(_))));
        let mut s = v["sealedPush"].clone();
        s["nonce"] = json!("ab");
        assert!(matches!(m(s), Err(SealError::Malformed(_))));
        let mut s = v["sealedPush"].clone();
        s["ct"] = json!("A".repeat(SEALED_MAX_CHARS + 1));
        assert!(matches!(m(s), Err(SealError::Malformed(_))));
    }

    #[test]
    fn plaintext_must_be_a_list_of_log_entries() {
        let v = v();
        let k = key(&v);
        let b = bind(&v["bind"]);
        let nz = nonce(&v);
        // 모양이 틀린 항목, 항목 수 초과는 봉투가 열려도 거절한다.
        let bad = vec![json!({"id": "zz", "origin": "ab".repeat(8), "seq": 1, "ts": 1, "kind": "x", "data": null})];
        let s = seal_chunk_unchecked(&bad, &k, &b, &nz);
        assert_eq!(open_chunk(&s, &k, &b), Err(SealError::Malformed("entries")));
        let e = v["entries"][0].clone();
        let many: Vec<Value> = std::iter::repeat(e).take(CHUNK_MAX_ENTRIES + 1).collect();
        let s = seal_chunk_unchecked(&many, &k, &b, &nz);
        assert_eq!(open_chunk(&s, &k, &b), Err(SealError::Malformed("entries")));
        assert_eq!(seal_chunk(&many, &k, &b, &nz), Err(SealError::OutOfRange("chunk-size")));
        let s = seal_plain(b"not json", &k, &b, &nz);
        assert_eq!(open_chunk(&s, &k, &b), Err(SealError::Malformed("plain")));
    }

    fn seal_plain(plain: &[u8], k: &DataKey, b: &ChunkBinding, n: &[u8; 24]) -> Value {
        let aad = aad_of(b, k.version).unwrap();
        let ct = XChaCha20Poly1305::new((&k.key).into()).encrypt(XNonce::from_slice(n), Payload { msg: plain, aad: &aad }).unwrap();
        json!({ "v": 1, "keyVersion": k.version, "nonce": hex::encode(n), "ct": STANDARD.encode(ct) })
    }
    fn seal_chunk_unchecked(entries: &[Value], k: &DataKey, b: &ChunkBinding, n: &[u8; 24]) -> Value {
        seal_plain(serde_json::to_string(entries).unwrap().as_bytes(), k, b, n)
    }
}
