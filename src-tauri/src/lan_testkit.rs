//! LAN v2 시험 도구(시험 빌드에만). **합성 값만**: 가게 개인키 0x11 반복(폰 시험 벡터와 같은 합성 가게)·기기 개인키 0x41.. 반복.
//! 실제 키·지갑·12단어 아님. 증서는 Rust 발급 경로(`lan_issue::cert_body` + `lan_cert::sign_doc`)로 만들고,
//! 요청은 폰 `signLanRequest` 와 같은 서명 본문(`lan_handler::request_sig_body`)에 기기 키로 서명한다.

use crate::lan_cert::{sign_doc, validate_cert_with, DEVICE_CERT_DOMAIN, DEVICE_REVOKE_DOMAIN};
use crate::lan_handler::{request_sig_body, LanAuth, LanFields, LanServerState, LAN_REQUEST_DOMAIN};
use crate::lan_keys::{derive_lan_keys, LanDerivedKeys, LanKeyRecord, Secret32, SessionEntry};
use crate::lan_seal::{chunk_id_of, seal_chunk, ChunkBinding, DataKey};
use crate::lan_store::LanStore;
use secp256k1::{Message, Secp256k1, SecretKey};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::path::PathBuf;

/// 시험 시각(폰 벡터와 같은 값).
pub const NOW: i64 = 1_800_000_000_000;
pub const STORE_KEY: &str = "034f355bdcb7cc0af728ef3cceb9615d90684bb5b2ca5f859ab0f0b704075871aa";
pub fn store_id() -> String {
    "ab".repeat(32)
}

/// 합성 기기 하나.
#[derive(Clone)]
pub struct Dev {
    pub sk: [u8; 32],
    pub pub_hex: String,
    pub cert: Value,
    pub cert_id: String,
    pub device_id: String,
    /// 이 기기의 합성 세션 열쇠(운영에서는 봉투 ECDH 에서 나온다).
    pub session: [u8; 32],
}

/// 기기 개인키 `[seed; 32]`, 역할 `role`, 맡김 `scopes`, 일련번호 `serial`, 발급 시각·수명.
pub fn dev_at(seed: u8, role: &str, scopes: &[&str], serial: u64, issued: i64, ttl: i64) -> Dev {
    let sk = [seed; 32];
    let secp = Secp256k1::new();
    let pub_hex = hex::encode(SecretKey::from_byte_array(&sk).unwrap().public_key(&secp).serialize());
    let mut body = crate::lan_issue::cert_body(&store_id(), &pub_hex, role, issued, ttl, serial).unwrap();
    body["scopes"] = json!(scopes);
    let cert = sign_doc(DEVICE_CERT_DOMAIN, &body, STORE_KEY, crate::lan_cert::tests::synth_signer).unwrap();
    let (_, c) = validate_cert_with(&cert, true).unwrap();
    let session: [u8; 32] = Sha256::digest(format!("synthetic-session:{}", c.cert_id)).into();
    Dev { sk, pub_hex, cert, cert_id: c.cert_id, device_id: c.device_id, session }
}
pub fn dev(seed: u8, role: &str, scopes: &[&str], serial: u64) -> Dev {
    dev_at(seed, role, scopes, serial, NOW - 1000, 24 * 3600_000)
}

/// 표준 합성 기기들.
pub fn remote() -> Dev {
    dev(0x41, "remote", &["read", "draft"], 1)
}
pub fn replica() -> Dev {
    dev(0x42, "replica", &["read", "replicate"], 2)
}
pub fn revoked() -> Dev {
    dev(0x44, "remote", &["read", "draft"], 3)
}
pub fn expired() -> Dev {
    dev_at(0x45, "remote", &["read"], 4, NOW - 5000, 4000)
}
pub fn future() -> Dev {
    dev_at(0x46, "remote", &["read"], 5, NOW + 600_000, 100_000)
}
pub fn draft_only() -> Dev {
    dev(0x43, "remote", &["draft"], 6)
}
pub fn all() -> Vec<Dev> {
    vec![remote(), replica(), revoked(), expired(), future(), draft_only()]
}

/// 가게 키로 서명한 철회 목록.
pub fn list_at(seq: u64, issued: i64, revoked: &[&str]) -> Value {
    let mut r: Vec<&str> = revoked.to_vec();
    r.sort();
    let body = json!({ "v": 1, "storeId": store_id(), "seq": seq, "revoked": r, "issuedAt": issued, "prunedBefore": 0 });
    sign_doc(DEVICE_REVOKE_DOMAIN, &body, STORE_KEY, crate::lan_cert::tests::synth_signer).unwrap()
}
pub fn list(seq: u64, revoked: &[&str]) -> Value {
    list_at(seq, NOW, revoked)
}

pub fn data_key(version: u64) -> DataKey {
    let mut k = [0u8; 32];
    for (i, b) in k.iter_mut().enumerate() {
        *b = i as u8 + 1 + version as u8;
    }
    DataKey { version, key: k }
}

/// 회전 결과처럼 생긴 열쇠 기록: 목록에서 철회되지 않은 기기마다 세션, 메타 = 그 목록.
pub fn record(version: u64, devs: &[Dev], list: &Value) -> LanKeyRecord {
    let revoked: Vec<String> = list["revoked"].as_array().unwrap().iter().map(|x| x.as_str().unwrap().to_string()).collect();
    LanKeyRecord {
        data_key: data_key(version),
        sessions: devs
            .iter()
            .filter(|d| !revoked.contains(&d.cert_id))
            .map(|d| (d.cert_id.clone(), SessionEntry { key: Secret32(d.session), device_id: d.device_id.clone(), cert_sig: d.cert["sig"].as_str().unwrap().to_string() }))
            .collect(),
        revocation_seq: list["seq"].as_u64().unwrap(),
        revoked_at_rotation: revoked,
        revocations: list.clone(),
    }
}
pub fn auth(version: u64, devs: &[Dev], list: &Value) -> LanAuth {
    LanAuth::new(STORE_KEY.into(), store_id(), record(version, devs, list), Some(list.clone()))
}
pub fn keys_of(d: &Dev, version: u64) -> LanDerivedKeys {
    derive_lan_keys(&data_key(version), &d.session, &store_id(), &d.cert_id).unwrap()
}

pub fn fixture(name: &str) -> PathBuf {
    use std::sync::atomic::{AtomicU32, Ordering};
    static N: AtomicU32 = AtomicU32::new(0);
    let d = crate::paths::test_fixture_root().join(format!("lan-k-{name}-{}", N.fetch_add(1, Ordering::SeqCst)));
    let _ = std::fs::remove_dir_all(&d);
    d
}
/// 서버 상태(시계 = NOW, 봉인 nonce 고정).
pub fn state_with(name: &str, a: LanAuth) -> (LanServerState, PathBuf) {
    let d = fixture(name);
    let mut st = LanServerState::new(a, LanStore::open(&d, NOW).unwrap());
    st.clock = Box::new(|| NOW);
    st.seal_nonce = Box::new(|| [9u8; 24]);
    (st, d)
}
/// 표준: 판 3, 표준 기기 전부, 빈 목록(seq 1).
pub fn state(name: &str) -> (LanServerState, PathBuf) {
    state_with(name, auth(3, &all(), &list(1, &[])))
}

pub fn nonce(i: u32) -> String {
    format!("{:032x}", i)
}
pub fn entry(origin: &str, i: u8) -> Value {
    entry_kind(origin, i, "draft")
}
pub fn entry_kind(origin: &str, i: u8, kind: &str) -> Value {
    json!({ "id": format!("{:02x}", i).repeat(16), "origin": origin, "seq": i, "ts": 1, "kind": kind, "data": { "n": i } })
}

/// 기기 키로 서명한 와이어 본문(폰 `signLanRequest`). `cert`·`signer` 를 따로 줄 수 있다(남의 증서·남의 키 시험).
pub fn sign_wire(cert: &Value, signer: &[u8; 32], key_version: u64, nonce: &str, ts: i64, fields: LanFields) -> Value {
    let (_, c) = validate_cert_with(cert, true).unwrap();
    let push = matches!(fields, LanFields::Push { .. });
    let body = Value::Object(request_sig_body(push, &c, key_version, nonce, ts, &fields).unwrap());
    let secp = Secp256k1::new();
    let sk = SecretKey::from_byte_array(signer).unwrap();
    let signer_pub = hex::encode(sk.public_key(&secp).serialize());
    let signed = sign_doc(LAN_REQUEST_DOMAIN, &body, &signer_pub, |d| Ok(secp.sign_ecdsa(&Message::from_digest(*d), &sk).serialize_compact())).unwrap();
    let mut w = json!({ "v": 2, "cert": cert, "keyVersion": key_version, "ts": ts, "nonce": nonce, "sig": signed["sig"] });
    match fields {
        LanFields::Push { chunk_id, count, sealed } => {
            w["chunkId"] = json!(chunk_id);
            w["count"] = json!(count);
            w["sealed"] = sealed;
        }
        LanFields::Pull { cursor } => w["cursor"] = json!(cursor),
    }
    w
}

/// push 요청(그 기기의 봉인 열쇠로 봉인, 판 `version`). → (요청, 조각 번호)
pub fn push_req_v(d: &Dev, entries: &[Value], n: &str, version: u64) -> (Value, String) {
    let ids: Vec<&str> = entries.iter().map(|e| e["id"].as_str().unwrap()).collect();
    let chunk_id = chunk_id_of(&d.device_id, &ids);
    let bind = ChunkBinding { store_id: &store_id(), cert_id: &d.cert_id, device_id: &d.device_id, dir: "push", chunk_id: &chunk_id, from: 0 };
    let sealed = seal_chunk(entries, &keys_of(d, version).seal, &bind, &[5u8; 24]).unwrap();
    let w = sign_wire(&d.cert, &d.sk, version, n, NOW, LanFields::Push { chunk_id: chunk_id.clone(), count: entries.len() as u64, sealed });
    (w, chunk_id)
}
pub fn push_req(d: &Dev, entries: &[Value], n: &str) -> (Value, String) {
    push_req_v(d, entries, n, 3)
}
pub fn pull_req_v(d: &Dev, cursor: u64, n: &str, version: u64) -> Value {
    sign_wire(&d.cert, &d.sk, version, n, NOW, LanFields::Pull { cursor })
}
pub fn pull_req(d: &Dev, cursor: u64, n: &str) -> Value {
    pull_req_v(d, cursor, n, 3)
}

pub fn post(st: &LanServerState, push: bool, req: &Value) -> crate::lan_handler::LanResponse {
    let b = serde_json::to_vec(req).unwrap();
    if push { crate::lan_handler::handle_push(st, &b) } else { crate::lan_handler::handle_pull(st, &b) }
}
