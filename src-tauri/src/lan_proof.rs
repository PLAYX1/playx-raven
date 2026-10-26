//! LAN 응답 확인값(보안 감사 F05) — 데스크탑(서버) 쪽.
//!
//! 같은 와이파이의 가짜 서버가 「보냈어요」·「여기까지 받았어요(커서)」 응답을 지어내지 못하게,
//! 서버는 응답마다 데이터 열쇠로 만든 확인값(proof)을 붙인다. 폰(클라이언트)이 같은 값을 계산해 맞을 때만 믿는다.
//!
//! 규격 정본 = 폰 저장소 `phone/network/real/lan/proof.ts` (통합 브랜치 claude/rv-real-integ). 여기서 다시 정의하지 않고
//! 똑같이 계산한다. 같은 값인지는 `testdata/rv-lan-proof-vectors.json`(폰 코드가 만든 값, 합성 열쇠)으로 시험한다.
//!
//!   proof = HMAC-SHA256(데이터 열쇠, 정본JSON[도메인, 방향, 열쇠 판, 가게, 증서, 기기, 요청 nonce, 응답 칸들...])
//!   push 칸: 조각 번호, 개수
//!   pull 칸: 요청 커서(from), next, more, 조각 번호(없으면 null), 봉인 조각의 SHA-256 해시(없으면 null)
//!
//! 🔴 이 파일은 계산만 한다. 지금 데스크탑 Rust 서버에는 `/lan/push`·`/lan/pull` 처리기가 아직 없어(폰 쪽 가짜 서버만 있다),
//!    처리기를 만들 때 반드시 이 함수로 proof 를 붙이고 `require_nonce` 로 nonce 없는 요청을 거절해야 한다.

#![allow(dead_code)] // 처리기가 생길 때까지 쓰는 곳이 없다(위 설명)

use hmac::{Hmac, Mac};
use serde_json::Value;
use sha2::{Digest, Sha256};

pub const LAN_PROOF_DOMAIN: &str = "RAVENVAULT-LAN-PROOF-V1";
/// LAN v2(docs/LAN-REQUEST-SIGNING.md §3.2): 같은 칸, 도메인만 V2, 열쇠는 기기별 확인값 열쇠(`lan_keys::derive_lan_key(.., Proof, ..)`).
pub const LAN_PROOF_V2_DOMAIN: &str = "RAVENVAULT-LAN-PROOF-V2";

/// 어느 가게·증서·기기에 대한 응답인지.
pub struct ProofBinding<'a> {
    pub store_id: &'a str,
    pub cert_id: &'a str,
    pub device_id: &'a str,
}

/// 요청 nonce 모양: 소문자 16진수 32자.
pub fn is_lan_nonce(s: &str) -> bool {
    s.len() == 32 && s.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// 요청 본문에서 nonce 를 꺼낸다. 없거나 모양이 틀리면 거절 사유를 돌려준다
/// (nonce 없이는 재전송을 막는 확인값을 만들 수 없다 — 확인값 없는 응답을 폰은 믿지 않는다).
pub fn require_nonce(body: &Value) -> Result<&str, &'static str> {
    match body.get("nonce").and_then(Value::as_str) {
        Some(n) if is_lan_nonce(n) => Ok(n),
        _ => Err("bad-nonce"),
    }
}

/// 폰 canonicalJson 과 같은 규칙: 객체 키는 UTF-16 코드 유닛 순, 공백 없음, 숫자는 정수만.
pub(crate) fn canonical(v: &Value, out: &mut String) -> Result<(), &'static str> {
    match v {
        Value::Null => out.push_str("null"),
        Value::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
        Value::Number(n) => {
            // 폰 canonicalJson 은 안전 정수(±2^53-1)만 받는다. 소수·그보다 큰 정수는 거절.
            const MAX_SAFE: i64 = 9_007_199_254_740_991;
            match (n.as_i64(), n.as_u64()) {
                (Some(i), _) if i.abs() <= MAX_SAFE => {}
                (None, Some(u)) if u <= MAX_SAFE as u64 => {}
                _ => return Err("canonical"),
            }
            out.push_str(&n.to_string());
        }
        Value::String(s) => out.push_str(&serde_json::to_string(s).map_err(|_| "canonical")?),
        Value::Array(a) => {
            out.push('[');
            for (i, x) in a.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                canonical(x, out)?;
            }
            out.push(']');
        }
        Value::Object(m) => {
            let mut keys: Vec<&String> = m.keys().collect();
            keys.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
            out.push('{');
            for (i, k) in keys.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                out.push_str(&serde_json::to_string(k).map_err(|_| "canonical")?);
                out.push(':');
                canonical(&m[*k], out)?;
            }
            out.push('}');
        }
    }
    Ok(())
}

pub(crate) fn canonical_string(v: &Value) -> Result<String, &'static str> {
    let mut s = String::new();
    canonical(v, &mut s)?;
    Ok(s)
}

fn mac(domain: &str, key: &[u8; 32], kind: &str, version: u64, b: &ProofBinding, nonce: &str, fields: Vec<Value>) -> Result<String, &'static str> {
    if !is_lan_nonce(nonce) {
        return Err("bad-nonce");
    }
    let mut all = vec![
        Value::from(domain),
        Value::from(kind),
        Value::from(version),
        Value::from(b.store_id),
        Value::from(b.cert_id),
        Value::from(b.device_id),
        Value::from(nonce),
    ];
    all.extend(fields);
    let text = canonical_string(&Value::Array(all))?;
    let mut m = <Hmac<Sha256> as Mac>::new_from_slice(key).map_err(|_| "key")?;
    m.update(text.as_bytes());
    Ok(hex::encode(m.finalize().into_bytes()))
}

/// push 응답의 확인값 — 조각 번호·개수. (v1 — 기존 벡터 호환 확인용으로만 남긴다. 처리기는 `push_proof_v2`.)
pub fn push_proof(key: &[u8; 32], version: u64, b: &ProofBinding, nonce: &str, chunk_id: &str, count: u64) -> Result<String, &'static str> {
    mac(LAN_PROOF_DOMAIN, key, "push", version, b, nonce, vec![Value::from(chunk_id), Value::from(count)])
}

/// v2 push 확인값 — `proof_key` = 그 기기의 확인값 열쇠(데이터 열쇠가 아니다).
pub fn push_proof_v2(proof_key: &[u8; 32], version: u64, b: &ProofBinding, nonce: &str, chunk_id: &str, count: u64) -> Result<String, &'static str> {
    mac(LAN_PROOF_V2_DOMAIN, proof_key, "push", version, b, nonce, vec![Value::from(chunk_id), Value::from(count)])
}

/// v2 pull 확인값 — 칸은 v1 과 같다.
#[allow(clippy::too_many_arguments)]
pub fn pull_proof_v2(
    proof_key: &[u8; 32],
    version: u64,
    b: &ProofBinding,
    nonce: &str,
    from: u64,
    next: u64,
    more: bool,
    chunk_id: Option<&str>,
    sealed: Option<&Value>,
) -> Result<String, &'static str> {
    mac(LAN_PROOF_V2_DOMAIN, proof_key, "pull", version, b, nonce, pull_fields(from, next, more, chunk_id, sealed)?)
}

fn pull_fields(from: u64, next: u64, more: bool, chunk_id: Option<&str>, sealed: Option<&Value>) -> Result<Vec<Value>, &'static str> {
    let sealed_hash = match sealed {
        None | Some(Value::Null) => Value::Null,
        Some(s) => Value::from(hex::encode(Sha256::digest(canonical_string(s)?.as_bytes()))),
    };
    Ok(vec![Value::from(from), Value::from(next), Value::from(more), chunk_id.map_or(Value::Null, Value::from), sealed_hash])
}

/// pull 응답의 확인값 — 요청 커서·next·more·조각 번호·봉인 조각 해시. 빈 응답(조각 없음)도 인증된다.
pub fn pull_proof(
    key: &[u8; 32],
    version: u64,
    b: &ProofBinding,
    nonce: &str,
    from: u64,
    next: u64,
    more: bool,
    chunk_id: Option<&str>,
    sealed: Option<&Value>,
) -> Result<String, &'static str> {
    mac(LAN_PROOF_DOMAIN, key, "pull", version, b, nonce, pull_fields(from, next, more, chunk_id, sealed)?)
}

/// 길이가 같은 두 확인값을 시간 차 없이 비교한다.
pub fn proof_equals(expected: &str, got: &str) -> bool {
    if expected.len() != got.len() {
        return false;
    }
    expected.bytes().zip(got.bytes()).fold(0u8, |d, (a, b)| d | (a ^ b)) == 0
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn v() -> Value {
        serde_json::from_str(include_str!("../testdata/rv-lan-proof-vectors.json")).unwrap()
    }
    fn key(v: &Value) -> [u8; 32] {
        let mut k = [0u8; 32];
        k.copy_from_slice(&hex::decode(v["key_hex"].as_str().unwrap()).unwrap());
        k
    }
    fn bind(v: &Value) -> ProofBinding<'_> {
        ProofBinding {
            store_id: v["bind"]["storeId"].as_str().unwrap(),
            cert_id: v["bind"]["certId"].as_str().unwrap(),
            device_id: v["bind"]["deviceId"].as_str().unwrap(),
        }
    }

    #[test]
    fn push_matches_the_phone() {
        let v = v();
        let p = push_proof(&key(&v), 3, &bind(&v), v["nonce"].as_str().unwrap(), v["chunk_id"].as_str().unwrap(), 7).unwrap();
        assert_eq!(p, v["push"]["proof"].as_str().unwrap());
    }

    #[test]
    fn pull_matches_the_phone_with_and_without_a_chunk() {
        let v = v();
        let n = v["nonce"].as_str().unwrap();
        let a = pull_proof(&key(&v), 3, &bind(&v), n, 5, 55, true, v["chunk_id"].as_str(), Some(&v["sealed"])).unwrap();
        assert_eq!(a, v["pull_with_chunk"]["proof"].as_str().unwrap());
        let b = pull_proof(&key(&v), 3, &bind(&v), n, 9, 9, false, None, None).unwrap();
        assert_eq!(b, v["pull_empty"]["proof"].as_str().unwrap());
    }

    #[test]
    fn any_changed_field_changes_the_proof() {
        let v = v();
        let k = key(&v);
        let n = v["nonce"].as_str().unwrap();
        let c = v["chunk_id"].as_str().unwrap();
        let base = push_proof(&k, 3, &bind(&v), n, c, 7).unwrap();
        assert!(!proof_equals(&base, &push_proof(&k, 3, &bind(&v), n, c, 8).unwrap()), "count");
        assert!(!proof_equals(&base, &push_proof(&k, 4, &bind(&v), n, c, 7).unwrap()), "key version");
        assert!(!proof_equals(&base, &push_proof(&k, 3, &bind(&v), "ff".repeat(16).as_str(), c, 7).unwrap()), "nonce (replay)");
        let mut k2 = k;
        k2[0] ^= 1;
        assert!(!proof_equals(&base, &push_proof(&k2, 3, &bind(&v), n, c, 7).unwrap()), "wrong key");
        let pb = pull_proof(&k, 3, &bind(&v), n, 5, 55, true, Some(c), Some(&v["sealed"])).unwrap();
        assert!(!proof_equals(&pb, &pull_proof(&k, 3, &bind(&v), n, 5, 999999, true, Some(c), Some(&v["sealed"])).unwrap()), "cursor skip");
        assert!(!proof_equals(&pb, &pull_proof(&k, 3, &bind(&v), n, 5, 55, true, Some(c), None).unwrap()), "sealed dropped");
    }

    #[test]
    fn requests_without_a_good_nonce_are_refused() {
        assert_eq!(require_nonce(&json!({})), Err("bad-nonce"));
        assert_eq!(require_nonce(&json!({"nonce": "ABC"})), Err("bad-nonce"));
        assert_eq!(require_nonce(&json!({"nonce": 5})), Err("bad-nonce"));
        assert_eq!(require_nonce(&json!({"nonce": "0123456789abcdef0123456789abcdeF"})), Err("bad-nonce"));
        assert!(require_nonce(&json!({"nonce": "0123456789abcdef0123456789abcdef"})).is_ok());
        let v = v();
        assert_eq!(push_proof(&key(&v), 3, &bind(&v), "short", "x", 1), Err("bad-nonce"));
    }

    /// v2 확인값 3건(push · pull 조각 있음 · pull 빈 응답)이 폰과 같은 값. 열쇠 = 벡터의 proofKeyHex.
    #[test]
    fn v2_proofs_match_the_phone() {
        let v: Value = serde_json::from_str(include_str!("../testdata/rv-lan-v2-vectors.json")).unwrap();
        let mut k = [0u8; 32];
        k.copy_from_slice(&hex::decode(v["lanKeys"]["proofKeyHex"].as_str().unwrap()).unwrap());
        let c = &v["device"]["cert"];
        let b = ProofBinding { store_id: c["storeId"].as_str().unwrap(), cert_id: v["device"]["certId"].as_str().unwrap(), device_id: c["deviceId"].as_str().unwrap() };
        let p = &v["proofs"];
        let push = &p["push"];
        assert_eq!(push_proof_v2(&k, 3, &b, push["nonce"].as_str().unwrap(), push["chunkId"].as_str().unwrap(), push["count"].as_u64().unwrap()).unwrap(), push["proof"].as_str().unwrap());
        for name in ["pullWithChunk", "pullEmpty"] {
            let q = &p[name];
            let got = pull_proof_v2(&k, 3, &b, q["nonce"].as_str().unwrap(), q["from"].as_u64().unwrap(), q["next"].as_u64().unwrap(), q["more"].as_bool().unwrap(), q["chunkId"].as_str(), Some(&q["sealed"])).unwrap();
            assert_eq!(got, q["proof"].as_str().unwrap(), "{name}");
        }
        // 같은 열쇠·같은 칸이라도 v1 도메인이면 다른 값(도메인 분리).
        assert_ne!(push_proof(&k, 3, &b, push["nonce"].as_str().unwrap(), push["chunkId"].as_str().unwrap(), 1).unwrap(), push["proof"].as_str().unwrap());
    }

    #[test]
    fn proof_equals_rejects_length_and_content_differences() {
        assert!(proof_equals("abc", "abc"));
        assert!(!proof_equals("abc", "abd"));
        assert!(!proof_equals("abc", "ab"));
    }
}
