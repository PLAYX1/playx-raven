//! LAN 동기화 ④ — `/lan/push`·`/lan/pull` 처리기. 데스크탑(서버) 쪽.
//!
//! 경로·본문 모양의 정본 = 폰 `phone/network/real/lan/client.ts`·`transport.ts`(통합 브랜치).
//!   push 요청 { cert, chunkId, count, sealed, nonce } → 200/409 { chunkId, count, duplicate, proof }
//!   pull 요청 { cert, cursor, nonce }                → 200 { from, next, more, chunkId, sealed, proof }
//!   거절 { reason } (확인값 없음 — 폰은 확인값 없는 응답을 성공으로 믿지 않는다)
//!
//! 처리 순서(앞 단계가 막으면 뒤는 하지 않는다)
//!   크기 제한 → JSON 객체 → nonce 모양 → ① 증서 확인(서명·만료·철회·맡김) → nonce 재사용 기록 → ② 봉인 열기 → 조각 번호·개수·출처 대조 →
//!   ③ 저장(성공해야 다음) → 응답에 lan_proof 확인값 부착
//!
//! 🔴 서버는 기본 꺼짐: `LanConfig::default().enabled == false` 이면 `router()` 는 None 이다. 이 파일은 포트를 열지 않는다
//!    (listen 은 하지 않으며, 켜는 곳은 설정을 읽는 호출자 몫). 외부 노출·새 서버 없음 — 기존 axum 라우터에 붙일 조각만 만든다.
//! 🔴 가게 키·데이터 열쇠·철회 목록은 호출자가 준다. 이 파일은 12단어·지갑·.env 를 열지 않는다.

#![allow(dead_code)] // 켜는 쪽(server.rs 장착)은 이 레인 밖

use crate::lan_cert::{verify_device_cert_any, CertReason, VerifiedCert};
use crate::lan_proof::{canonical_string, pull_proof, push_proof, require_nonce, ProofBinding};
use crate::lan_seal::{chunk_id_of, open_chunk, seal_chunk, ChunkBinding, DataKey, SealError, CHUNK_MAX_BYTES, CHUNK_MAX_ENTRIES};
use crate::lan_store::{Applied, LanStore, StoreError};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::sync::{Arc, Mutex};

/// 요청 본문 상한 — 봉인 조각(≤ 64KiB 평문 → base64 ≈ 87KB) + 증서(≤ 4KiB) + 여유.
pub const MAX_REQUEST_BYTES: usize = 128 * 1024;
pub const PUSH_SCOPES: [&str; 4] = ["draft", "ticket-check", "key-request", "notice-write"];
pub const PULL_SCOPES: [&str; 2] = ["read", "replicate"];

/// 설정. 기본은 꺼짐.
#[derive(Debug, Clone, Copy, Default)]
pub struct LanConfig {
    pub enabled: bool,
}
impl LanConfig {
    /// 설정 JSON 에서 `lanSync: true` 일 때만 켠다(문자열 "true"·1 같은 값은 꺼짐).
    pub fn from_json(v: &Value) -> Self {
        LanConfig { enabled: v.get("lanSync") == Some(&Value::Bool(true)) }
    }
}

pub struct LanResponse {
    pub status: u16,
    pub body: Value,
}
fn deny(status: u16, reason: &str) -> LanResponse {
    LanResponse { status, body: json!({ "reason": reason }) }
}

pub struct LanServerState {
    /// 가게 공개키(압축 hex) — 호출자가 검증된 가게 문서에서 준다.
    pub store_key: String,
    pub data_key: DataKey,
    /// 최신 서명된 철회 목록. 없으면 모든 증서를 거절한다(닫힌 실패).
    pub revocation: Mutex<Option<Value>>,
    pub store: Mutex<LanStore>,
    pub clock: Box<dyn Fn() -> i64 + Send + Sync>,
    /// 봉인 nonce(24바이트) 공급 — 기본은 OS 난수.
    pub seal_nonce: Box<dyn Fn() -> [u8; 24] + Send + Sync>,
}
impl LanServerState {
    pub fn new(store_key: String, data_key: DataKey, revocation: Option<Value>, store: LanStore) -> Self {
        LanServerState {
            store_key,
            data_key,
            revocation: Mutex::new(revocation),
            store: Mutex::new(store),
            clock: Box::new(|| std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_millis() as i64)),
            seal_nonce: Box::new(|| rand::random::<[u8; 24]>()),
        }
    }
}

fn parse(body: &[u8]) -> Result<serde_json::Map<String, Value>, LanResponse> {
    if body.len() > MAX_REQUEST_BYTES {
        return Err(deny(413, "too-large"));
    }
    match serde_json::from_slice::<Value>(body) {
        Ok(Value::Object(m)) => Ok(m),
        _ => Err(deny(400, "bad-json")),
    }
}

/// 증서 확인 거절 사유 → 폰이 이해하는 짧은 코드.
fn cert_reason(r: CertReason) -> &'static str {
    match r {
        CertReason::Revoked => "revoked",
        CertReason::Expired => "expired",
        CertReason::Scope => "scope",
        _ => "bad-cert",
    }
}

fn authenticate(st: &LanServerState, req: &serde_json::Map<String, Value>, scopes: &[&str], now: i64) -> Result<VerifiedCert, LanResponse> {
    let cert = match req.get("cert") {
        None | Some(Value::Null) => return Err(deny(403, "no-cert")),
        Some(c) => c,
    };
    let list = st.revocation.lock().map_err(|_| deny(500, "internal"))?.clone();
    verify_device_cert_any(cert, &st.store_key, now, list.as_ref(), scopes).map_err(|r| deny(403, cert_reason(r)))
}

fn binding(c: &VerifiedCert) -> ProofBinding<'_> {
    ProofBinding { store_id: &c.store_id, cert_id: &c.cert_id, device_id: &c.device_id }
}
fn is_chunk_id(s: &str) -> bool {
    s.len() == 64 && s.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

fn store_err(e: StoreError) -> LanResponse {
    match e {
        StoreError::NonceReplay => deny(403, "replay"),
        _ => deny(500, "store-failed"),
    }
}

pub fn handle_push(st: &LanServerState, body: &[u8]) -> LanResponse {
    let req = match parse(body) {
        Ok(r) => r,
        Err(e) => return e,
    };
    let Ok(nonce) = require_nonce(&Value::Object(req.clone())).map(str::to_string) else { return deny(400, "bad-nonce") };
    let now = (st.clock)();
    let cert = match authenticate(st, &req, &PUSH_SCOPES, now) {
        Ok(c) => c,
        Err(e) => return e,
    };
    let chunk_id = match req.get("chunkId").and_then(Value::as_str) {
        Some(c) if is_chunk_id(c) => c.to_string(),
        _ => return deny(400, "bad-chunk-id"),
    };
    let mut store = match st.store.lock() {
        Ok(s) => s,
        Err(_) => return deny(500, "internal"),
    };
    if let Err(e) = store.use_nonce(&nonce, now) {
        return store_err(e);
    }
    let sealed = req.get("sealed").cloned().unwrap_or(Value::Null);
    let bind = ChunkBinding { store_id: &cert.store_id, cert_id: &cert.cert_id, device_id: &cert.device_id, dir: "push", chunk_id: &chunk_id, from: 0 };
    let entries = match open_chunk(&sealed, &st.data_key, &bind) {
        Ok(e) => e,
        Err(SealError::Stale) => return deny(410, "key-version"),
        Err(SealError::Forbidden) => return deny(403, "bad-seal"),
        Err(_) => return deny(400, "bad-sealed"),
    };
    let ids: Vec<&str> = entries.iter().filter_map(|e| e.get("id").and_then(Value::as_str)).collect();
    if chunk_id != chunk_id_of(&cert.device_id, &ids) || req.get("count").and_then(Value::as_u64) != Some(entries.len() as u64) {
        return deny(400, "chunk-mismatch");
    }
    if entries.iter().any(|e| e.get("origin").and_then(Value::as_str) != Some(cert.device_id.as_str())) {
        return deny(403, "bad-origin");
    }
    // 저장(디스크까지)이 성공해야만 아래 확인값을 만든다.
    let duplicate = if store.has_chunk(&chunk_id) {
        true
    } else {
        match store.append_chunk(&chunk_id, &cert.device_id, &entries) {
            Ok(Applied::DuplicateChunk) => true,
            Ok(Applied::New { .. }) => false,
            Err(e) => return store_err(e),
        }
    };
    drop(store);
    let count = entries.len() as u64;
    let Ok(proof) = push_proof(&st.data_key.key, st.data_key.version, &binding(&cert), &nonce, &chunk_id, count) else { return deny(500, "internal") };
    LanResponse { status: if duplicate { 409 } else { 200 }, body: json!({ "chunkId": chunk_id, "count": count, "duplicate": duplicate, "proof": proof }) }
}

pub fn handle_pull(st: &LanServerState, body: &[u8]) -> LanResponse {
    let req = match parse(body) {
        Ok(r) => r,
        Err(e) => return e,
    };
    let Ok(nonce) = require_nonce(&Value::Object(req.clone())).map(str::to_string) else { return deny(400, "bad-nonce") };
    let now = (st.clock)();
    let cert = match authenticate(st, &req, &PULL_SCOPES, now) {
        Ok(c) => c,
        Err(e) => return e,
    };
    let mut store = match st.store.lock() {
        Ok(s) => s,
        Err(_) => return deny(500, "internal"),
    };
    let from = match req.get("cursor").and_then(Value::as_u64) {
        Some(c) if c <= 9_007_199_254_740_991 && c as usize <= store.len() => c as usize,
        _ => return deny(416, "cursor"),
    };
    if let Err(e) = store.use_nonce(&nonce, now) {
        return store_err(e);
    }
    // 커서부터 내 것이 아닌 항목을 한 조각(≤ 50개, ≤ 64KiB)만. 내 것은 건너뛰며 커서만 앞으로 간다.
    let mut out: Vec<Value> = Vec::new();
    let mut bytes = 2usize;
    let mut i = from;
    while i < store.len() && out.len() < CHUNK_MAX_ENTRIES {
        let e = store.entry(i).cloned().unwrap_or(Value::Null);
        if e.get("origin").and_then(Value::as_str) == Some(cert.device_id.as_str()) {
            i += 1;
            continue;
        }
        let n = serde_json::to_string(&e).map_or(CHUNK_MAX_BYTES + 1, |s| s.len() + 1);
        if !out.is_empty() && bytes + n > CHUNK_MAX_BYTES {
            break;
        }
        out.push(e);
        bytes += n;
        i += 1;
    }
    let more = i < store.len();
    drop(store);
    let chunk_id = {
        let v = json!(["pull", cert.device_id, from, i]);
        hex::encode(Sha256::digest(canonical_string(&v).unwrap_or_default().as_bytes()))
    };
    let sealed = if out.is_empty() {
        Value::Null
    } else {
        let bind = ChunkBinding { store_id: &cert.store_id, cert_id: &cert.cert_id, device_id: &cert.device_id, dir: "pull", chunk_id: &chunk_id, from: from as u64 };
        match seal_chunk(&out, &st.data_key, &bind, &(st.seal_nonce)()) {
            Ok(s) => s,
            Err(_) => return deny(500, "internal"),
        }
    };
    let Ok(proof) = pull_proof(&st.data_key.key, st.data_key.version, &binding(&cert), &nonce, from as u64, i as u64, more, Some(&chunk_id), Some(&sealed)) else {
        return deny(500, "internal");
    };
    LanResponse { status: 200, body: json!({ "from": from, "next": i, "more": more, "chunkId": chunk_id, "sealed": sealed, "proof": proof }) }
}

/// axum 조각. 꺼짐(기본)이면 None — 아무 경로도 만들지 않는다. 호출자가 기존 라우터에 `merge` 한다(이 파일은 listen 하지 않음).
pub fn router(cfg: &LanConfig, st: Arc<LanServerState>) -> Option<axum::Router> {
    use axum::{body::Bytes, extract::DefaultBodyLimit, http::StatusCode, routing::post, Json, Router};
    if !cfg.enabled {
        return None;
    }
    async fn run(st: Arc<LanServerState>, body: Bytes, push: bool) -> (StatusCode, Json<Value>) {
        let res = tokio::task::spawn_blocking(move || if push { handle_push(&st, &body) } else { handle_pull(&st, &body) }).await;
        match res {
            Ok(r) => (StatusCode::from_u16(r.status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR), Json(r.body)),
            Err(_) => (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "reason": "internal" }))),
        }
    }
    let (a, b) = (st.clone(), st);
    Some(
        Router::new()
            .route("/lan/push", post(move |body: Bytes| run(a.clone(), body, true)))
            .route("/lan/pull", post(move |body: Bytes| run(b.clone(), body, false)))
            .layer(DefaultBodyLimit::max(MAX_REQUEST_BYTES)),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::lan_proof::proof_equals;
    use std::path::PathBuf;

    fn vec() -> Value {
        serde_json::from_str(include_str!("../testdata/rv-lan-cert-vectors.json")).unwrap()
    }
    fn data_key() -> DataKey {
        let mut k = [0u8; 32];
        for (i, b) in k.iter_mut().enumerate() {
            *b = i as u8 + 1;
        }
        DataKey { version: 3, key: k }
    }
    fn dir(name: &str) -> PathBuf {
        use std::sync::atomic::{AtomicU32, Ordering};
        static N: AtomicU32 = AtomicU32::new(0);
        let base = std::env::var_os("RV_BACKUP_FIXTURE_ROOT").map(PathBuf::from).unwrap_or_else(std::env::temp_dir);
        let d = base.join(format!("lan-h-{}-{}-{}", name, std::process::id(), N.fetch_add(1, Ordering::SeqCst)));
        let _ = std::fs::remove_dir_all(&d);
        d
    }
    fn state_with(name: &str, list_name: &str) -> (LanServerState, Value, PathBuf) {
        let v = vec();
        let d = dir(name);
        let now = v["now"].as_i64().unwrap();
        let store = LanStore::open(&d, now).unwrap();
        let mut st = LanServerState::new(v["storeKey"].as_str().unwrap().to_string(), data_key(), Some(v["lists"][list_name].clone()), store);
        st.clock = Box::new(move || now);
        st.seal_nonce = Box::new(|| [9u8; 24]);
        (st, v, d)
    }
    fn state(name: &str) -> (LanServerState, Value, PathBuf) {
        state_with(name, "empty")
    }
    fn nonce(i: u8) -> String {
        format!("{:02x}", i).repeat(16)
    }
    fn entry(origin: &str, i: u8) -> Value {
        json!({ "id": format!("{:02x}", i).repeat(16), "origin": origin, "seq": i, "ts": 1, "kind": "note", "data": { "n": i } })
    }
    /// 폰 client.ts 와 같은 방식으로 push 요청을 만든다.
    fn push_req(v: &Value, cert_name: &str, entries: &[Value], n: &str) -> (Value, String, String) {
        let cert = &v["certs"][cert_name];
        let device = cert["deviceId"].as_str().unwrap();
        let ids: Vec<&str> = entries.iter().map(|e| e["id"].as_str().unwrap()).collect();
        let chunk_id = chunk_id_of(device, &ids);
        let cert_id = crate::lan_cert::device_cert_id(cert["storeId"].as_str().unwrap(), cert["serial"].as_u64().unwrap());
        let bind = ChunkBinding { store_id: cert["storeId"].as_str().unwrap(), cert_id: &cert_id, device_id: device, dir: "push", chunk_id: &chunk_id, from: 0 };
        let sealed = seal_chunk(entries, &data_key(), &bind, &[5u8; 24]).unwrap();
        (json!({ "cert": cert, "chunkId": chunk_id, "count": entries.len(), "sealed": sealed, "nonce": n }), chunk_id, cert_id)
    }
    fn expected_push_proof(v: &Value, cert_name: &str, n: &str, chunk_id: &str, count: u64) -> String {
        let c = &v["certs"][cert_name];
        let cert_id = crate::lan_cert::device_cert_id(c["storeId"].as_str().unwrap(), c["serial"].as_u64().unwrap());
        let b = ProofBinding { store_id: c["storeId"].as_str().unwrap(), cert_id: &cert_id, device_id: c["deviceId"].as_str().unwrap() };
        push_proof(&data_key().key, 3, &b, n, chunk_id, count).unwrap()
    }
    fn post(st: &LanServerState, push: bool, req: &Value) -> LanResponse {
        let b = serde_json::to_vec(req).unwrap();
        if push { handle_push(st, &b) } else { handle_pull(st, &b) }
    }

    #[test]
    fn push_stores_then_answers_with_the_proof() {
        let (st, v, _d) = state("push");
        let dev = v["certs"]["remote"]["deviceId"].as_str().unwrap();
        let es = vec![entry(dev, 1), entry(dev, 2)];
        let (req, chunk_id, _) = push_req(&v, "remote", &es, &nonce(1));
        let r = post(&st, true, &req);
        assert_eq!(r.status, 200, "{}", r.body);
        assert_eq!(r.body["duplicate"], false);
        assert_eq!(r.body["count"], 2);
        let want = expected_push_proof(&v, "remote", &nonce(1), &chunk_id, 2);
        assert!(proof_equals(&want, r.body["proof"].as_str().unwrap()));
        assert_eq!(st.store.lock().unwrap().len(), 2);
    }

    #[test]
    fn the_same_chunk_with_a_new_nonce_is_409_with_a_proof_and_not_applied_twice() {
        let (st, v, _d) = state("dup");
        let dev = v["certs"]["remote"]["deviceId"].as_str().unwrap();
        let es = vec![entry(dev, 1)];
        assert_eq!(post(&st, true, &push_req(&v, "remote", &es, &nonce(1)).0).status, 200);
        let (req, chunk_id, _) = push_req(&v, "remote", &es, &nonce(2));
        let r = post(&st, true, &req);
        assert_eq!(r.status, 409);
        assert_eq!(r.body["duplicate"], true);
        assert!(proof_equals(&expected_push_proof(&v, "remote", &nonce(2), &chunk_id, 1), r.body["proof"].as_str().unwrap()));
        assert_eq!(st.store.lock().unwrap().len(), 1);
    }

    #[test]
    fn a_replayed_request_is_refused_even_with_a_valid_cert_and_seal() {
        let (st, v, _d) = state("replay");
        let dev = v["certs"]["remote"]["deviceId"].as_str().unwrap();
        let (req, _, _) = push_req(&v, "remote", &[entry(dev, 1)], &nonce(1));
        assert_eq!(post(&st, true, &req).status, 200);
        let r = post(&st, true, &req);
        assert_eq!((r.status, r.body["reason"].as_str()), (403, Some("replay")));
        assert!(r.body.get("proof").is_none());
    }

    #[test]
    fn devices_without_a_good_cert_are_refused_and_nothing_is_stored() {
        let (st, v, _d) = state("deny");
        let dev = v["certs"]["remote"]["deviceId"].as_str().unwrap();
        let (mut req, _, _) = push_req(&v, "remote", &[entry(dev, 1)], &nonce(1));
        // 증서 없음
        let mut no = req.clone();
        no.as_object_mut().unwrap().remove("cert");
        assert_eq!(post(&st, true, &no).body["reason"], "no-cert");
        // 서명 훼손(맡김 늘리기)
        let mut forged = req.clone();
        forged["cert"]["scopes"] = json!(["read", "draft", "ticket-check"]);
        assert_eq!(post(&st, true, &forged).body["reason"], "bad-cert");
        // 만료
        let mut exp = req.clone();
        exp["cert"] = v["certs"]["expired"].clone();
        let r = post(&st, true, &exp);
        assert_eq!((r.status, r.body["reason"].as_str()), (403, Some("expired")));
        // 아직 효력 전
        let mut fut = req.clone();
        fut["cert"] = v["certs"]["future"].clone();
        assert_eq!(post(&st, true, &fut).body["reason"], "bad-cert");
        // 맡김 없음(replica 는 read·replicate 뿐 — 보내기 불가)
        let dev2 = v["certs"]["replica"]["deviceId"].as_str().unwrap();
        let (rep, _, _) = push_req(&v, "replica", &[entry(dev2, 3)], &nonce(2));
        assert_eq!(post(&st, true, &rep).body["reason"], "scope");
        req["nonce"] = json!("short");
        assert_eq!(post(&st, true, &req).body["reason"], "bad-nonce");
        assert_eq!(st.store.lock().unwrap().len(), 0);
        assert!(!st.store.lock().unwrap().has_chunk(&"00".repeat(32)));
    }

    #[test]
    fn a_revoked_device_is_refused_for_push_and_pull() {
        let (st, v, _d) = state_with("revoked", "revoked");
        let dev = v["certs"]["revokedCert"]["deviceId"].as_str().unwrap();
        let (req, _, _) = push_req(&v, "revokedCert", &[entry(dev, 1)], &nonce(1));
        let r = post(&st, true, &req);
        assert_eq!((r.status, r.body["reason"].as_str()), (403, Some("revoked")));
        let r = post(&st, false, &json!({ "cert": v["certs"]["revokedCert"], "cursor": 0, "nonce": nonce(2) }));
        assert_eq!((r.status, r.body["reason"].as_str()), (403, Some("revoked")));
        // 같은 목록에서도 철회되지 않은 기기는 통과
        let dev = v["certs"]["remote"]["deviceId"].as_str().unwrap();
        assert_eq!(post(&st, true, &push_req(&v, "remote", &[entry(dev, 1)], &nonce(3)).0).status, 200);
        assert_eq!(st.store.lock().unwrap().len(), 1);
    }

    #[test]
    fn no_or_stale_revocation_list_closes_the_door() {
        let (st, v, _d) = state_with("stale", "stale");
        let dev = v["certs"]["remote"]["deviceId"].as_str().unwrap();
        let (req, _, _) = push_req(&v, "remote", &[entry(dev, 1)], &nonce(1));
        assert_eq!(post(&st, true, &req).body["reason"], "bad-cert");
        *st.revocation.lock().unwrap() = None;
        assert_eq!(post(&st, true, &req).body["reason"], "bad-cert");
        assert_eq!(st.store.lock().unwrap().len(), 0);
    }

    #[test]
    fn a_bad_seal_stale_key_or_mismatched_chunk_is_refused() {
        let (st, v, _d) = state("seal");
        let dev = v["certs"]["remote"]["deviceId"].as_str().unwrap();
        let es = vec![entry(dev, 1)];
        let (req, _, _) = push_req(&v, "remote", &es, &nonce(1));
        let mut bad = req.clone();
        bad["chunkId"] = json!("ab".repeat(32)); // 봉인은 다른 조각 번호로 닫혔다
        assert_eq!(post(&st, true, &bad).body["reason"], "bad-seal");
        let mut bad = push_req(&v, "remote", &es, &nonce(2)).0;
        bad["count"] = json!(5);
        assert_eq!(post(&st, true, &bad).body["reason"], "chunk-mismatch");
        let mut bad = push_req(&v, "remote", &es, &nonce(3)).0;
        bad["sealed"]["keyVersion"] = json!(2);
        let r = post(&st, true, &bad);
        assert_eq!((r.status, r.body["reason"].as_str()), (410, Some("key-version")));
        let mut bad = push_req(&v, "remote", &es, &nonce(4)).0;
        bad["sealed"] = json!("nope");
        assert_eq!(post(&st, true, &bad).body["reason"], "bad-sealed");
        // 남의 항목(origin 이 이 기기가 아님)은 안 받는다
        let (other, _, _) = push_req(&v, "remote", &[entry(&"11".repeat(16), 9)], &nonce(5));
        assert_eq!(post(&st, true, &other).body["reason"], "bad-origin");
        assert_eq!(st.store.lock().unwrap().len(), 0);
    }

    #[test]
    fn request_size_and_shape_limits() {
        let (st, _v, _d) = state("limits");
        let big = vec![b' '; MAX_REQUEST_BYTES + 1];
        assert_eq!(handle_push(&st, &big).status, 413);
        assert_eq!(handle_pull(&st, &big).status, 413);
        assert_eq!(handle_push(&st, b"not json").body["reason"], "bad-json");
        assert_eq!(handle_push(&st, b"[1]").body["reason"], "bad-json");
        assert_eq!(handle_pull(&st, b"{}").body["reason"], "bad-nonce");
    }

    #[test]
    fn a_failed_save_never_gets_a_success_or_a_proof() {
        let (st, v, _d) = state("savefail");
        let dev = v["certs"]["remote"]["deviceId"].as_str().unwrap();
        let es = vec![entry(dev, 1)];
        // 1번째 쓰기 = nonce 기록, 2번째 = 조각. 조각 쓰기를 실패시킨다.
        let (req, _, _) = push_req(&v, "remote", &es, &nonce(1));
        // nonce 기록 실패
        st.store.lock().unwrap().fail_next_write = true;
        let r = post(&st, true, &req);
        assert_eq!((r.status, r.body["reason"].as_str()), (500, Some("store-failed")));
        assert!(r.body.get("proof").is_none());
        assert_eq!(st.store.lock().unwrap().len(), 0);
        // 다시 보내면(같은 nonce, 실패가 nonce 를 태우지 않았다) 정상 저장
        assert_eq!(post(&st, true, &req).status, 200);
        assert_eq!(st.store.lock().unwrap().len(), 1);
    }

    #[test]
    fn pull_hands_over_other_devices_entries_sealed_and_proved() {
        let (st, v, _d) = state("pull");
        let me = v["certs"]["replica"]["deviceId"].as_str().unwrap().to_string();
        let other = v["certs"]["remote"]["deviceId"].as_str().unwrap().to_string();
        {
            let mut s = st.store.lock().unwrap();
            s.append_chunk(&"01".repeat(32), &other, &[entry(&other, 1), entry(&me, 2), entry(&other, 3)]).unwrap();
        }
        let cert = &v["certs"]["replica"];
        let cert_id = crate::lan_cert::device_cert_id(cert["storeId"].as_str().unwrap(), cert["serial"].as_u64().unwrap());
        let r = post(&st, false, &json!({ "cert": cert, "cursor": 0, "nonce": nonce(1) }));
        assert_eq!(r.status, 200, "{}", r.body);
        assert_eq!((r.body["from"].as_u64(), r.body["next"].as_u64(), r.body["more"].as_bool()), (Some(0), Some(3), Some(false)));
        // 확인값은 폰 pullProof 와 같은 규칙으로 맞는다
        let b = ProofBinding { store_id: cert["storeId"].as_str().unwrap(), cert_id: &cert_id, device_id: &me };
        let want = pull_proof(&data_key().key, 3, &b, &nonce(1), 0, 3, false, r.body["chunkId"].as_str(), Some(&r.body["sealed"])).unwrap();
        assert!(proof_equals(&want, r.body["proof"].as_str().unwrap()));
        // 봉인을 열면 내 항목은 빠져 있다
        let cb = ChunkBinding { store_id: cert["storeId"].as_str().unwrap(), cert_id: &cert_id, device_id: &me, dir: "pull", chunk_id: r.body["chunkId"].as_str().unwrap(), from: 0 };
        let got = open_chunk(&r.body["sealed"], &data_key(), &cb).unwrap();
        assert_eq!(got, vec![entry(&other, 1), entry(&other, 3)]);
        // 끝에서 다시 물으면 빈 응답도 인증된다
        let r = post(&st, false, &json!({ "cert": cert, "cursor": 3, "nonce": nonce(2) }));
        assert_eq!((r.body["sealed"].is_null(), r.body["next"].as_u64(), r.body["more"].as_bool()), (true, Some(3), Some(false)));
        let want = pull_proof(&data_key().key, 3, &b, &nonce(2), 3, 3, false, r.body["chunkId"].as_str(), None).unwrap();
        assert!(proof_equals(&want, r.body["proof"].as_str().unwrap()));
        // 범위 밖 커서
        assert_eq!(post(&st, false, &json!({ "cert": cert, "cursor": 4, "nonce": nonce(3) })).status, 416);
        // 같은 nonce 재사용 거절
        assert_eq!(post(&st, false, &json!({ "cert": cert, "cursor": 0, "nonce": nonce(1) })).body["reason"], "replay");
    }

    #[test]
    fn pull_is_chunked_by_fifty_entries() {
        let (st, v, _d) = state("chunks");
        let me = v["certs"]["replica"]["deviceId"].as_str().unwrap().to_string();
        let other = v["certs"]["remote"]["deviceId"].as_str().unwrap().to_string();
        let es: Vec<Value> = (0..60u8).map(|i| entry(&other, i)).collect();
        {
            let mut s = st.store.lock().unwrap();
            s.append_chunk(&"01".repeat(32), &other, &es[..30]).unwrap();
            s.append_chunk(&"02".repeat(32), &other, &es[30..]).unwrap();
        }
        let cert = &v["certs"]["replica"];
        let r = post(&st, false, &json!({ "cert": cert, "cursor": 0, "nonce": nonce(1) }));
        assert_eq!((r.body["next"].as_u64(), r.body["more"].as_bool()), (Some(50), Some(true)));
        let r = post(&st, false, &json!({ "cert": cert, "cursor": 50, "nonce": nonce(2) }));
        assert_eq!((r.body["next"].as_u64(), r.body["more"].as_bool()), (Some(60), Some(false)));
        let _ = me;
    }

    #[test]
    fn pull_needs_a_read_scope() {
        let (st, v, _d) = state("pullscope");
        let r = post(&st, false, &json!({ "cert": v["certs"]["draftOnly"], "cursor": 0, "nonce": nonce(1) }));
        assert_eq!((r.status, r.body["reason"].as_str()), (403, Some("scope")));
        let r = post(&st, false, &json!({ "cert": v["certs"]["expired"], "cursor": 0, "nonce": nonce(2) }));
        assert_eq!(r.body["reason"], "expired");
    }

    #[test]
    fn the_server_is_off_by_default() {
        let (st, _v, _d) = state("off");
        let st = Arc::new(st);
        assert!(!LanConfig::default().enabled);
        assert!(router(&LanConfig::default(), st.clone()).is_none());
        assert!(!LanConfig::from_json(&json!({})).enabled);
        assert!(!LanConfig::from_json(&json!({ "lanSync": "true" })).enabled);
        assert!(!LanConfig::from_json(&json!({ "lanSync": 1 })).enabled);
        assert!(router(&LanConfig::from_json(&json!({ "lanSync": true })), st).is_some());
    }

    #[tokio::test]
    async fn the_router_answers_push_and_cuts_off_big_bodies() {
        use axum::body::Body;
        use axum::http::Request;
        use tower::ServiceExt;
        let (st, v, _d) = state("router");
        let st = Arc::new(st);
        let app = router(&LanConfig { enabled: true }, st.clone()).unwrap();
        let dev = v["certs"]["remote"]["deviceId"].as_str().unwrap();
        let (req, _, _) = push_req(&v, "remote", &[entry(dev, 1)], &nonce(1));
        let res = app.clone().oneshot(Request::post("/lan/push").body(Body::from(serde_json::to_vec(&req).unwrap())).unwrap()).await.unwrap();
        assert_eq!(res.status(), 200);
        assert_eq!(st.store.lock().unwrap().len(), 1);
        let res = app.clone().oneshot(Request::post("/lan/push").body(Body::from(vec![b'x'; MAX_REQUEST_BYTES + 10])).unwrap()).await.unwrap();
        assert_eq!(res.status(), 413);
        let res = app.oneshot(Request::get("/lan/push").body(Body::empty()).unwrap()).await.unwrap();
        assert_eq!(res.status(), 405);
    }
}
