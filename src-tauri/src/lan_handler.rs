//! LAN 동기화 ④ — `/lan/push`·`/lan/pull` 처리기. 데스크탑(서버) 쪽.
//!
//! 경로·본문 모양의 정본 = 폰 `phone/network/real/lan/client.ts`·`transport.ts`(통합 브랜치).
//!   push 요청 { cert, chunkId, count, sealed, nonce } → 200/409 { chunkId, count, duplicate, proof }
//!   pull 요청 { cert, cursor, nonce }                → 200 { from, next, more, chunkId, sealed, proof }
//!   거절 { reason } (확인값 없음 — 폰은 확인값 없는 응답을 성공으로 믿지 않는다)
//!
//! 처리 순서(앞 단계가 막으면 뒤는 하지 않는다)
//!   동시 처리 상한 → 크기 제한 → JSON 객체 → nonce 모양 → 전체 속도 → ① 증서 확인(서명·만료·철회·맡김·**이 가게 번호**) → 기기 속도
//!   → (push) 이미 쓴 nonce 인지 보기만 → ② 봉인 열기(평문 ≤ 64KiB) → 조각 번호·개수·출처·종류별 맡김·재직렬화 크기 대조
//!   → 저장소 잠금(가게가 바뀌는 중이면 503, 고장 상태면 500) → 충돌(같은 id 다른 내용) 422 → nonce 기록(상한 429)
//!   → ③ 저장(성공해야 다음) → 응답에 lan_proof 확인값 부착
//!   nonce 는 봉인 확인이 끝난 뒤에야 디스크에 적는다 — 증서만 베낀 사람(데이터 열쇠 없음)이 로그를 키우지 못하게.
//!
//! 🔴 H1(요청마다 기기 개인키 서명·응답 확인값 열쇠 분리)은 아직 없다 — 폰과 와이어 규격을 먼저 맞추는 별도 레인. 그 전까지 증서는
//!    베낄 수 있으므로 pull 은 증서만으로 nonce 를 쓰게 된다: 그래서 속도·동시성·nonce 개수 상한이 있다.
//! 🔴 서버는 기본 꺼짐: `LanConfig::default().enabled == false` 이면 `router()` 는 None 이다. 이 파일은 포트를 열지 않는다
//!    (listen 은 하지 않으며, 켜는 곳은 설정을 읽는 호출자 몫). 외부 노출·새 서버 없음 — 기존 axum 라우터에 붙일 조각만 만든다.
//! 🔴 가게 키·데이터 열쇠·철회 목록은 호출자가 준다. 이 파일은 12단어·지갑·.env 를 열지 않는다.

#![allow(dead_code)] // 켜는 쪽(server.rs 장착)은 이 레인 밖

use crate::lan_cert::{verify_device_cert_prechecked, verify_revocation_list, CertReason, ListInfo, VerifiedCert};
use crate::lan_proof::{canonical_string, pull_proof, push_proof, require_nonce, ProofBinding};
use crate::lan_seal::{chunk_id_of, open_chunk, seal_chunk, ChunkBinding, DataKey, SealError, CHUNK_MAX_BYTES, CHUNK_MAX_ENTRIES};
use crate::lan_store::{Applied, LanStore, StoreError};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, RwLock};

/// 요청 본문 상한 — 봉인 조각(≤ 64KiB 평문 → base64 ≈ 87KB) + 증서(≤ 4KiB) + 여유.
pub const MAX_REQUEST_BYTES: usize = 128 * 1024;
pub const PUSH_SCOPES: [&str; 4] = ["draft", "ticket-check", "key-request", "notice-write"];
pub const PULL_SCOPES: [&str; 2] = ["read", "replicate"];
/// 동시에 처리하는 요청 수 상한(넘으면 503 busy — 폰은 source-down 으로 알고 나중에 다시).
pub const MAX_INFLIGHT: usize = 4;
/// 1분 창 요청 수 상한 — 전체(증서 확인 전, 서명 복구 비용을 막는다) / 기기별(증서 확인 뒤).
pub const MAX_PER_MIN_TOTAL: u32 = 600;
pub const MAX_PER_MIN_DEVICE: u32 = 120;
const RATE_WINDOW_MS: i64 = 60_000;

/// 항목 `kind` → 그 항목을 **보낼** 때 필요한 맡김. 정본 맡김 이름(core/device/cert.ts DEVICE_SCOPES)과 같은 낱말을 종류 이름으로 쓴다.
/// core/sync 의 나머지 종류(product·quote·order-status·receipt·refund·resolve·staff-*·seller-notice 등)는 원본(가게 키 PC)만
/// 쓸 수 있다(core/sync/log.ts: draft 가 아니면 `original && role === 'staff-pc'`) — 다른 기기가 보내는 길은 없으므로 표에 없다(거절).
/// 표에 없는 종류(폰 시험의 'note' 포함)는 보수적으로 거절한다(사유 kind-scope).
pub const KIND_SCOPES: [(&str, &str); 4] = [("draft", "draft"), ("ticket-check", "ticket-check"), ("key-request", "key-request"), ("notice-write", "notice-write")];

pub fn push_scope_for(kind: &str) -> Option<&'static str> {
    KIND_SCOPES.iter().find(|(k, _)| *k == kind).map(|(_, s)| *s)
}
/// pull 에서 이 기기가 이 종류의 항목을 받아도 되나: `replicate`(장부 복사본) 는 아는 종류 전부,
/// 그 밖에는 그 종류를 쓰는 맡김을 가진 기기만, 공지(notice-write)는 `read` 로도. 모르는 종류는 아무에게도 주지 않는다.
pub fn pull_visible(kind: &str, scopes: &[String]) -> bool {
    let Some(need) = push_scope_for(kind) else { return false };
    let has = |s: &str| scopes.iter().any(|x| x == s);
    has("replicate") || has(need) || (kind == "notice-write" && has("read"))
}

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

/// 인증 재료 한 벌(가게 공개키·가게 번호·데이터 열쇠·철회 목록). 켜기/다시 켜기 때 디스크에서 새로 만들어 통째로 바꾼다.
/// 철회 목록 서명 확인은 목록이 들어올 때 **한 번만** 하고 결과를 담아 둔다(요청마다 ECDSA 복구를 다시 하지 않는다 — L7).
pub struct LanAuth {
    /// 가게 공개키(압축 hex) — 호출자가 12단어에서 뽑은 값.
    pub store_key: String,
    /// 가게 번호(64 hex). 증서의 가게 번호가 이것과 같아야 받는다.
    pub store_id: String,
    pub data_key: DataKey,
    revocation: Option<Value>,
    rev_checked: Option<Result<ListInfo, CertReason>>,
}
impl LanAuth {
    pub fn new(store_key: String, store_id: String, data_key: DataKey, revocation: Option<Value>) -> Self {
        let rev_checked = revocation.as_ref().map(|l| verify_revocation_list(l, &store_key, &store_id));
        LanAuth { store_key, store_id, data_key, revocation, rev_checked }
    }
    pub fn revocation(&self) -> Option<&Value> {
        self.revocation.as_ref()
    }
    /// 확인을 통과한 목록 요약(없거나 못 넘었으면 None).
    pub fn revocation_info(&self) -> Option<&ListInfo> {
        self.rev_checked.as_ref().and_then(|r| r.as_ref().ok())
    }
    fn with_revocation(&self, list: Option<Value>) -> Self {
        LanAuth::new(self.store_key.clone(), self.store_id.clone(), self.data_key.clone(), list)
    }
    /// 재료 지문 — 디스크에서 다시 읽은 것과 같으면 바꿀 것이 없다. (열쇠 바이트는 해시로만 들어간다.)
    pub fn fingerprint(&self) -> [u8; 32] {
        let mut h = Sha256::new();
        h.update(b"RAVENVAULT-LAN-AUTH-FP-V1\0");
        h.update(self.store_key.as_bytes());
        h.update(b"\0");
        h.update(self.store_id.as_bytes());
        h.update(b"\0");
        h.update(self.data_key.version.to_be_bytes());
        h.update(self.data_key.key);
        h.update(self.revocation.as_ref().and_then(|l| canonical_string(l).ok()).unwrap_or_default().as_bytes());
        h.finalize().into()
    }
}

/// 저장소 + 그것이 어느 가게 것인지. 가게가 바뀌면 통째로 바뀐다(로그는 가게별 폴더).
pub struct StoreSlot {
    pub store_id: String,
    pub log: LanStore,
}
impl std::ops::Deref for StoreSlot {
    type Target = LanStore;
    fn deref(&self) -> &LanStore {
        &self.log
    }
}
impl std::ops::DerefMut for StoreSlot {
    fn deref_mut(&mut self) -> &mut LanStore {
        &mut self.log
    }
}

#[derive(Default)]
struct RateWindow {
    start: i64,
    total: u32,
    per_device: HashMap<String, u32>,
}

/// 건너뛰고 기록한 것(화면·문제 알리기용 숫자 — 내용은 담지 않는다).
#[derive(Default)]
pub struct LanCounters {
    /// pull 에서 64KiB 를 넘어 건너뛴 저장된 항목(이 수정 전에 들어온 것 — 복구 경로).
    pub oversize_skipped: AtomicU64,
    /// pull 에서 이 기기에 줄 수 없는 종류라 건너뛴 항목.
    pub kind_skipped: AtomicU64,
    /// push 에서 종류·맡김이 맞지 않아 거절한 조각.
    pub kind_refused: AtomicU64,
    /// 속도·동시성·nonce 상한으로 거절한 요청.
    pub limited: AtomicU64,
}

pub struct LanServerState {
    auth: RwLock<Arc<LanAuth>>,
    pub store: Mutex<StoreSlot>,
    pub clock: Box<dyn Fn() -> i64 + Send + Sync>,
    /// 봉인 nonce(24바이트) 공급 — 기본은 OS 난수.
    pub seal_nonce: Box<dyn Fn() -> [u8; 24] + Send + Sync>,
    /// 지금 받는가. 끄면(스위치 내림) 이미 붙은 경로도 곧바로 404 로 답한다 — 서버를 다시 켤 때까지 기다리지 않는다.
    pub live: std::sync::atomic::AtomicBool,
    pub inflight: AtomicUsize,
    rate: Mutex<RateWindow>,
    pub counters: LanCounters,
}
impl LanServerState {
    pub fn new(auth: LanAuth, store: LanStore) -> Self {
        let store_id = auth.store_id.clone();
        LanServerState {
            auth: RwLock::new(Arc::new(auth)),
            store: Mutex::new(StoreSlot { store_id, log: store }),
            clock: Box::new(|| std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_millis() as i64)),
            seal_nonce: Box::new(|| rand::random::<[u8; 24]>()),
            live: std::sync::atomic::AtomicBool::new(true),
            inflight: AtomicUsize::new(0),
            rate: Mutex::new(RateWindow::default()),
            counters: LanCounters::default(),
        }
    }
    /// 지금 인증 재료(요청 하나가 처음부터 끝까지 같은 벌을 쓴다).
    pub fn auth(&self) -> Arc<LanAuth> {
        self.auth.read().map(|a| a.clone()).unwrap_or_else(|p| p.into_inner().clone())
    }
    pub fn revocation_list(&self) -> Option<Value> {
        self.auth().revocation().cloned()
    }
    /// 철회 목록만 바꾼다(확인은 여기서 한 번). 가게·열쇠는 그대로.
    pub fn set_revocation(&self, list: Option<Value>) {
        let mut g = self.auth.write().unwrap_or_else(|p| p.into_inner());
        let next = g.with_revocation(list);
        *g = Arc::new(next);
    }
    /// 같은 가게의 재료를 바꾼다(열쇠 판·목록). 가게 번호가 다르면 `replace_store_and_auth` 를 써야 한다.
    pub fn replace_auth(&self, auth: LanAuth) -> Result<(), &'static str> {
        let store = self.store.lock().map_err(|_| "internal")?;
        if store.store_id != auth.store_id {
            return Err("other-store");
        }
        *self.auth.write().unwrap_or_else(|p| p.into_inner()) = Arc::new(auth);
        Ok(())
    }
    /// 가게가 바뀌었다: 저장소(가게별 로그)와 재료를 함께 바꾼다. 저장소 잠금을 쥔 채 바꾸므로, 옛 재료로 들어온 요청은
    /// 저장소에서 가게 번호가 안 맞아 503 으로 끝난다(두 가게가 섞이지 않는다).
    pub fn replace_store_and_auth(&self, auth: LanAuth, log: LanStore) {
        let mut store = self.store.lock().unwrap_or_else(|p| p.into_inner());
        *store = StoreSlot { store_id: auth.store_id.clone(), log };
        *self.auth.write().unwrap_or_else(|p| p.into_inner()) = Arc::new(auth);
    }

    /// 1분 창 속도 제한. `device` 가 None 이면 전체만 센다.
    fn rate_ok(&self, now: i64, device: Option<&str>) -> bool {
        let Ok(mut w) = self.rate.lock() else { return false };
        if now - w.start >= RATE_WINDOW_MS || now < w.start {
            *w = RateWindow { start: now, ..RateWindow::default() };
        }
        match device {
            None => {
                if w.total >= MAX_PER_MIN_TOTAL {
                    return false;
                }
                w.total += 1;
                true
            }
            Some(d) => {
                let c = w.per_device.entry(d.to_string()).or_insert(0);
                if *c >= MAX_PER_MIN_DEVICE {
                    return false;
                }
                *c += 1;
                true
            }
        }
    }
    fn limited(&self, reason: &str) -> LanResponse {
        self.counters.limited.fetch_add(1, Ordering::Relaxed);
        deny(429, reason)
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
        CertReason::OtherStore => "other-store",
        _ => "bad-cert",
    }
}

/// 증서 확인 + 끝 시각(nonce 를 그때까지 기억한다).
fn authenticate(auth: &LanAuth, req: &serde_json::Map<String, Value>, scopes: &[&str], now: i64) -> Result<(VerifiedCert, i64), LanResponse> {
    let cert = match req.get("cert") {
        None | Some(Value::Null) => return Err(deny(403, "no-cert")),
        Some(c) => c,
    };
    let c = verify_device_cert_prechecked(cert, &auth.store_key, now, auth.rev_checked.as_ref(), &auth.store_id, scopes).map_err(|r| deny(403, cert_reason(r)))?;
    // 증서는 이 가게 것이어야 한다(같은 가게 키를 쓰는 다른 가게 번호의 증서를 받지 않는다).
    if c.store_id != auth.store_id {
        return Err(deny(403, "other-store"));
    }
    let not_after = cert.get("notAfter").and_then(Value::as_i64).unwrap_or(now);
    Ok((c, not_after.saturating_add(crate::lan_cert::DEVICE_CLOCK_SKEW_MS)))
}

fn binding(c: &VerifiedCert) -> ProofBinding<'_> {
    ProofBinding { store_id: &c.store_id, cert_id: &c.cert_id, device_id: &c.device_id }
}
fn is_chunk_id(s: &str) -> bool {
    s.len() == 64 && s.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

fn store_err(st: &LanServerState, e: StoreError) -> LanResponse {
    match e {
        StoreError::NonceReplay => deny(403, "replay"),
        StoreError::Quota => st.limited("nonce-quota"),
        _ => deny(500, "store-failed"),
    }
}

/// 저장소를 잠그고 이 재료의 가게 것인지·고장 상태가 아닌지 본다.
fn lock_store<'a>(st: &'a LanServerState, auth: &LanAuth) -> Result<std::sync::MutexGuard<'a, StoreSlot>, LanResponse> {
    let store = st.store.lock().map_err(|_| deny(500, "internal"))?;
    if store.store_id != auth.store_id {
        return Err(deny(503, "reloading"));
    }
    if store.is_failed() {
        return Err(deny(500, "store-failed"));
    }
    Ok(store)
}

/// 동시 처리 상한을 지키며 처리한다(라우터가 부른다).
pub fn handle(st: &LanServerState, push: bool, body: &[u8]) -> LanResponse {
    struct Guard<'a>(&'a AtomicUsize);
    impl Drop for Guard<'_> {
        fn drop(&mut self) {
            self.0.fetch_sub(1, Ordering::SeqCst);
        }
    }
    if st.inflight.fetch_add(1, Ordering::SeqCst) >= MAX_INFLIGHT {
        st.inflight.fetch_sub(1, Ordering::SeqCst);
        st.counters.limited.fetch_add(1, Ordering::Relaxed);
        return deny(503, "busy");
    }
    let _g = Guard(&st.inflight);
    if push { handle_push(st, body) } else { handle_pull(st, body) }
}

pub fn handle_push(st: &LanServerState, body: &[u8]) -> LanResponse {
    let req = match parse(body) {
        Ok(r) => r,
        Err(e) => return e,
    };
    let Ok(nonce) = require_nonce(&Value::Object(req.clone())).map(str::to_string) else { return deny(400, "bad-nonce") };
    let now = (st.clock)();
    if !st.rate_ok(now, None) {
        return st.limited("rate");
    }
    let auth = st.auth();
    let (cert, nonce_until) = match authenticate(&auth, &req, &PUSH_SCOPES, now) {
        Ok(c) => c,
        Err(e) => return e,
    };
    if !st.rate_ok(now, Some(&cert.device_id)) {
        return st.limited("rate");
    }
    let chunk_id = match req.get("chunkId").and_then(Value::as_str) {
        Some(c) if is_chunk_id(c) => c.to_string(),
        _ => return deny(400, "bad-chunk-id"),
    };
    // 이미 쓴 nonce 는 봉인을 열기 전에 값싸게 거절(기록은 아직 하지 않는다).
    match st.store.lock() {
        Ok(s) if s.nonce_seen(&nonce) => return deny(403, "replay"),
        Ok(_) => {}
        Err(_) => return deny(500, "internal"),
    }
    let sealed = req.get("sealed").cloned().unwrap_or(Value::Null);
    let bind = ChunkBinding { store_id: &cert.store_id, cert_id: &cert.cert_id, device_id: &cert.device_id, dir: "push", chunk_id: &chunk_id, from: 0 };
    let entries = match open_chunk(&sealed, &auth.data_key, &bind) {
        Ok(e) => e,
        Err(SealError::Stale) => return deny(410, "key-version"),
        Err(SealError::Forbidden) => return deny(403, "bad-seal"),
        Err(SealError::OutOfRange(_)) => return deny(413, "chunk-too-big"),
        Err(_) => return deny(400, "bad-sealed"),
    };
    let ids: Vec<&str> = entries.iter().filter_map(|e| e.get("id").and_then(Value::as_str)).collect();
    if chunk_id != chunk_id_of(&cert.device_id, &ids) || req.get("count").and_then(Value::as_u64) != Some(entries.len() as u64) {
        return deny(400, "chunk-mismatch");
    }
    if entries.iter().any(|e| e.get("origin").and_then(Value::as_str) != Some(cert.device_id.as_str())) {
        return deny(403, "bad-origin");
    }
    // 종류별 맡김: 그 종류를 쓰는 맡김이 증서에 있어야 한다. 모르는 종류는 거절.
    let kind_ok = entries.iter().all(|e| {
        e.get("kind").and_then(Value::as_str).and_then(push_scope_for).is_some_and(|need| cert.scopes.iter().any(|s| s == need))
    });
    if !kind_ok {
        st.counters.kind_refused.fetch_add(1, Ordering::Relaxed);
        return deny(403, "kind-scope");
    }
    // 저장 전 재직렬화 크기: pull 이 이 항목들을 다시 봉인할 수 있어야 한다(같은 serde_json 직렬화로 64KiB 이하).
    if serde_json::to_string(&entries).map_or(true, |t| t.len() > CHUNK_MAX_BYTES) {
        return deny(413, "chunk-too-big");
    }
    let mut store = match lock_store(st, &auth) {
        Ok(s) => s,
        Err(e) => return e,
    };
    let duplicate = store.has_chunk(&chunk_id);
    if !duplicate {
        let clash = store.conflicts(&entries);
        if !clash.is_empty() {
            // 같은 id 인데 내용이 다르다 — 조용히 버리고 200 을 주면 폰은 반영된 줄 안다. 통째로 거절하고 알린다.
            return LanResponse { status: 422, body: json!({ "reason": "conflict", "conflicts": clash }) };
        }
    }
    // 봉인·종류·크기 확인이 끝난 뒤에야 nonce 를 디스크에 적는다.
    if let Err(e) = store.use_nonce(&nonce, &cert.device_id, now, nonce_until) {
        return store_err(st, e);
    }
    // 저장(디스크까지)이 성공해야만 아래 확인값을 만든다.
    let duplicate = duplicate
        || match store.append_chunk(&chunk_id, &cert.device_id, &entries) {
            Ok(Applied::DuplicateChunk) => true,
            Ok(Applied::New { .. }) => false,
            Err(e) => return store_err(st, e),
        };
    drop(store);
    let count = entries.len() as u64;
    let Ok(proof) = push_proof(&auth.data_key.key, auth.data_key.version, &binding(&cert), &nonce, &chunk_id, count) else { return deny(500, "internal") };
    LanResponse { status: if duplicate { 409 } else { 200 }, body: json!({ "chunkId": chunk_id, "count": count, "duplicate": duplicate, "proof": proof }) }
}

pub fn handle_pull(st: &LanServerState, body: &[u8]) -> LanResponse {
    let req = match parse(body) {
        Ok(r) => r,
        Err(e) => return e,
    };
    let Ok(nonce) = require_nonce(&Value::Object(req.clone())).map(str::to_string) else { return deny(400, "bad-nonce") };
    let now = (st.clock)();
    if !st.rate_ok(now, None) {
        return st.limited("rate");
    }
    let auth = st.auth();
    let (cert, nonce_until) = match authenticate(&auth, &req, &PULL_SCOPES, now) {
        Ok(c) => c,
        Err(e) => return e,
    };
    if !st.rate_ok(now, Some(&cert.device_id)) {
        return st.limited("rate");
    }
    let mut store = match lock_store(st, &auth) {
        Ok(s) => s,
        Err(e) => return e,
    };
    let from = match req.get("cursor").and_then(Value::as_u64) {
        Some(c) if c <= 9_007_199_254_740_991 && c as usize <= store.len() => c as usize,
        _ => return deny(416, "cursor"),
    };
    if let Err(e) = store.use_nonce(&nonce, &cert.device_id, now, nonce_until) {
        return store_err(st, e);
    }
    // 커서부터 내 것이 아닌 항목을 한 조각(≤ 50개, ≤ 64KiB)만. 내 것·줄 수 없는 종류·혼자서도 64KiB 를 넘는 옛 항목은
    // 건너뛰며 커서만 앞으로 간다(건너뛴 수는 counters 에 기록 — 넘는 항목 하나가 pull 을 영영 막지 않게).
    let mut out: Vec<Value> = Vec::new();
    let mut bytes = 2usize;
    let mut i = from;
    while i < store.len() && out.len() < CHUNK_MAX_ENTRIES {
        let e = store.entry(i).cloned().unwrap_or(Value::Null);
        if e.get("origin").and_then(Value::as_str) == Some(cert.device_id.as_str()) {
            i += 1;
            continue;
        }
        if !e.get("kind").and_then(Value::as_str).is_some_and(|k| pull_visible(k, &cert.scopes)) {
            st.counters.kind_skipped.fetch_add(1, Ordering::Relaxed);
            i += 1;
            continue;
        }
        let len = serde_json::to_string(&e).map_or(CHUNK_MAX_BYTES + 1, |s| s.len());
        if len + 2 > CHUNK_MAX_BYTES {
            st.counters.oversize_skipped.fetch_add(1, Ordering::Relaxed);
            eprintln!("[lan] 64KiB 를 넘는 저장 항목을 건너뜀: 위치 {i}, {len}바이트");
            i += 1;
            continue;
        }
        let n = len + 1;
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
        match seal_chunk(&out, &auth.data_key, &bind, &(st.seal_nonce)()) {
            Ok(s) => s,
            Err(_) => return deny(500, "internal"),
        }
    };
    let Ok(proof) = pull_proof(&auth.data_key.key, auth.data_key.version, &binding(&cert), &nonce, from as u64, i as u64, more, Some(&chunk_id), Some(&sealed)) else {
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
        if !st.live.load(std::sync::atomic::Ordering::SeqCst) {
            return (StatusCode::NOT_FOUND, Json(json!({ "reason": "off" })));
        }
        let res = tokio::task::spawn_blocking(move || handle(&st, push, &body)).await;
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
    use std::sync::atomic::Ordering;
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
        let auth = LanAuth::new(v["storeKey"].as_str().unwrap().to_string(), v["storeId"].as_str().unwrap().to_string(), data_key(), Some(v["lists"][list_name].clone()));
        let mut st = LanServerState::new(auth, store);
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
        json!({ "id": format!("{:02x}", i).repeat(16), "origin": origin, "seq": i, "ts": 1, "kind": "draft", "data": { "n": i } })
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
        st.set_revocation(None);
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
        let res = app.clone().oneshot(Request::get("/lan/push").body(Body::empty()).unwrap()).await.unwrap();
        assert_eq!(res.status(), 405);
        // 스위치를 내리면 이미 붙은 경로도 아무것도 처리하지 않는다.
        st.live.store(false, std::sync::atomic::Ordering::SeqCst);
        let (req, _, _) = push_req(&v, "remote", &[entry(dev, 2)], &nonce(2));
        let res = app.oneshot(Request::post("/lan/push").body(Body::from(serde_json::to_vec(&req).unwrap())).unwrap()).await.unwrap();
        assert_eq!(res.status(), 404);
        assert_eq!(st.store.lock().unwrap().len(), 1, "꺼진 뒤에는 저장하지 않는다");
    }

    fn entry_kind(origin: &str, i: u8, kind: &str) -> Value {
        json!({ "id": format!("{:02x}", i).repeat(16), "origin": origin, "seq": i, "ts": 1, "kind": kind, "data": { "n": i } })
    }
    fn log_len(d: &PathBuf) -> u64 {
        std::fs::metadata(d.join(crate::lan_store::LOG_FILE)).map_or(0, |m| m.len())
    }

    #[test]
    fn m2_an_oversize_entry_is_refused_on_push_and_skipped_on_pull() {
        let (st, v, d) = state("oversize");
        let dev = v["certs"]["remote"]["deviceId"].as_str().unwrap().to_string();
        // 평문 65,537바이트짜리 항목 하나 — 암호문 상한은 통과한다.
        let mut e = entry(&dev, 1);
        e["data"] = json!("");
        let base = serde_json::to_string(&vec![e.clone()]).unwrap().len();
        e["data"] = json!("x".repeat(CHUNK_MAX_BYTES + 1 - base));
        let cert = &v["certs"]["remote"];
        let chunk_id = chunk_id_of(&dev, &[e["id"].as_str().unwrap()]);
        let cert_id = crate::lan_cert::device_cert_id(cert["storeId"].as_str().unwrap(), cert["serial"].as_u64().unwrap());
        let bind = ChunkBinding { store_id: cert["storeId"].as_str().unwrap(), cert_id: &cert_id, device_id: &dev, dir: "push", chunk_id: &chunk_id, from: 0 };
        let plain = serde_json::to_string(&vec![e.clone()]).unwrap();
        assert_eq!(plain.len(), CHUNK_MAX_BYTES + 1);
        use chacha20poly1305::aead::{Aead, KeyInit, Payload};
        let aad = canonical_string(&json!([crate::lan_seal::LAN_SEAL_DOMAIN, bind.store_id, bind.cert_id, bind.device_id, "push", chunk_id, 0, 3])).unwrap();
        let ct = chacha20poly1305::XChaCha20Poly1305::new((&data_key().key).into())
            .encrypt(chacha20poly1305::XNonce::from_slice(&[5u8; 24]), Payload { msg: plain.as_bytes(), aad: aad.as_bytes() })
            .unwrap();
        use base64::Engine as _;
        let sealed = json!({ "v": 1, "keyVersion": 3, "nonce": hex::encode([5u8; 24]), "ct": base64::engine::general_purpose::STANDARD.encode(ct) });
        let r = post(&st, true, &json!({ "cert": cert, "chunkId": chunk_id, "count": 1, "sealed": sealed, "nonce": nonce(1) }));
        assert_eq!((r.status, r.body["reason"].as_str()), (413, Some("chunk-too-big")));
        assert_eq!(log_len(&d), 0, "거절된 요청은 nonce 도 남기지 않는다");

        // 이 수정 전에 이미 저장된 초과 항목(복구 경로): pull 은 건너뛰고 기록하며 커서를 앞으로 보낸다.
        let other = v["certs"]["remote"]["deviceId"].as_str().unwrap().to_string();
        {
            let mut s = st.store.lock().unwrap();
            s.append_chunk(&"01".repeat(32), &other, &[entry(&other, 7), e.clone(), entry(&other, 9)]).unwrap();
        }
        let r = post(&st, false, &json!({ "cert": v["certs"]["replica"], "cursor": 0, "nonce": nonce(2) }));
        assert_eq!(r.status, 200, "{}", r.body);
        assert_eq!((r.body["next"].as_u64(), r.body["more"].as_bool()), (Some(3), Some(false)));
        let me = v["certs"]["replica"]["deviceId"].as_str().unwrap();
        let rc = &v["certs"]["replica"];
        let rid = crate::lan_cert::device_cert_id(rc["storeId"].as_str().unwrap(), rc["serial"].as_u64().unwrap());
        let cb = ChunkBinding { store_id: rc["storeId"].as_str().unwrap(), cert_id: &rid, device_id: me, dir: "pull", chunk_id: r.body["chunkId"].as_str().unwrap(), from: 0 };
        let got = open_chunk(&r.body["sealed"], &data_key(), &cb).unwrap();
        assert_eq!(got, vec![entry(&other, 7), entry(&other, 9)]);
        assert_eq!(st.counters.oversize_skipped.load(Ordering::Relaxed), 1);
    }

    #[test]
    fn m3_a_bad_seal_never_writes_a_nonce() {
        let (st, v, d) = state("noncelate");
        let dev = v["certs"]["remote"]["deviceId"].as_str().unwrap();
        let (good, _, _) = push_req(&v, "remote", &[entry(dev, 1)], &nonce(1));
        for i in 0..20u8 {
            let mut bad = good.clone();
            bad["nonce"] = json!(nonce(100 + i));
            bad["sealed"] = Value::Null;
            assert_eq!(post(&st, true, &bad).body["reason"], "bad-sealed");
        }
        assert_eq!(log_len(&d), 0, "증서만 베낀 요청은 로그를 키우지 못한다");
        assert_eq!(st.store.lock().unwrap().nonce_count(), 0);
        assert_eq!(post(&st, true, &good).status, 200);
        // 한 번 쓴 nonce 는 봉인을 열기 전에 거절된다.
        assert_eq!(post(&st, true, &good).body["reason"], "replay");
    }

    #[test]
    fn m3_rate_and_concurrency_limits() {
        let (st, v, _d) = state("rate");
        let cert = &v["certs"]["replica"];
        let mut last = 0;
        for i in 0..(MAX_PER_MIN_DEVICE + 1) {
            let r = post(&st, false, &json!({ "cert": cert, "cursor": 0, "nonce": format!("{:032x}", i) }));
            last = r.status;
            if i < MAX_PER_MIN_DEVICE {
                assert_eq!(r.status, 200, "{i}");
            }
        }
        assert_eq!(last, 429, "기기별 1분 상한");
        // 다른 기기는 아직 받는다(전체 상한 전).
        let dev = v["certs"]["remote"]["deviceId"].as_str().unwrap();
        assert_eq!(post(&st, true, &push_req(&v, "remote", &[entry(dev, 1)], &"ee".repeat(16)).0).status, 200);
        // 전체 상한: 창을 채운다.
        st.rate.lock().unwrap().total = MAX_PER_MIN_TOTAL;
        assert_eq!(post(&st, true, &push_req(&v, "remote", &[entry(dev, 2)], &"ef".repeat(16)).0).body["reason"], "rate");
        // 동시 처리 상한.
        st.inflight.store(MAX_INFLIGHT, Ordering::SeqCst);
        let r = handle(&st, false, &serde_json::to_vec(&json!({ "cert": cert, "cursor": 0, "nonce": "dd".repeat(16) })).unwrap());
        assert_eq!((r.status, r.body["reason"].as_str()), (503, Some("busy")));
        assert_eq!(st.inflight.load(Ordering::SeqCst), MAX_INFLIGHT, "거절한 요청은 자리를 남기지 않는다");
        st.inflight.store(0, Ordering::SeqCst);
    }

    #[test]
    fn m5_each_kind_needs_its_scope_on_push_and_on_pull() {
        let (st, v, _d) = state("kinds");
        let dev = v["certs"]["remote"]["deviceId"].as_str().unwrap().to_string(); // remote = read, draft
        for (i, kind) in ["note", "ticket-check", "key-request", "receipt", "refund"].iter().enumerate() {
            let (req, _, _) = push_req(&v, "remote", &[entry_kind(&dev, i as u8 + 1, kind)], &nonce(i as u8 + 1));
            let r = post(&st, true, &req);
            assert_eq!((r.status, r.body["reason"].as_str()), (403, Some("kind-scope")), "{kind}");
        }
        assert_eq!(st.store.lock().unwrap().len(), 0);
        assert_eq!(st.counters.kind_refused.load(Ordering::Relaxed), 5);
        assert_eq!(post(&st, true, &push_req(&v, "remote", &[entry_kind(&dev, 9, "draft")], &nonce(9)).0).status, 200);
        // pull: 저장된 여러 종류 — replica(replicate)는 아는 종류 전부, 모르는 종류는 아무에게도.
        let other = "77".repeat(16);
        {
            let mut s = st.store.lock().unwrap();
            let es: Vec<Value> = ["draft", "ticket-check", "key-request", "notice-write", "note"].iter().enumerate().map(|(i, k)| entry_kind(&other, 20 + i as u8, k)).collect();
            s.append_chunk(&"02".repeat(32), &other, &es).unwrap();
        }
        let rc = &v["certs"]["replica"];
        let me = rc["deviceId"].as_str().unwrap();
        let rid = crate::lan_cert::device_cert_id(rc["storeId"].as_str().unwrap(), rc["serial"].as_u64().unwrap());
        let r = post(&st, false, &json!({ "cert": rc, "cursor": 0, "nonce": nonce(30) }));
        let cb = ChunkBinding { store_id: rc["storeId"].as_str().unwrap(), cert_id: &rid, device_id: me, dir: "pull", chunk_id: r.body["chunkId"].as_str().unwrap(), from: 0 };
        let kinds: Vec<String> = open_chunk(&r.body["sealed"], &data_key(), &cb).unwrap().iter().map(|e| e["kind"].as_str().unwrap().to_string()).collect();
        assert_eq!(kinds, vec!["draft", "draft", "ticket-check", "key-request", "notice-write"]);
        // 맡김 표만 따로: read+draft 는 초안·공지만, read+ticket-check(검표기)는 검표·공지만.
        let sc = |x: &[&str]| x.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        let rd = sc(&["read", "draft"]);
        assert!(pull_visible("draft", &rd) && pull_visible("notice-write", &rd));
        assert!(!pull_visible("ticket-check", &rd) && !pull_visible("key-request", &rd) && !pull_visible("note", &rd));
        let scan = sc(&["read", "ticket-check"]);
        assert!(pull_visible("ticket-check", &scan) && pull_visible("notice-write", &scan) && !pull_visible("draft", &scan));
        assert!(!pull_visible("note", &sc(&["read", "replicate"])));
        // 폰 core/device 의 맡김 이름과 같은 낱말인지(표가 엇나가지 않게).
        for (k, need) in KIND_SCOPES {
            assert!(crate::lan_cert::DEVICE_SCOPES.contains(&need), "{k}");
            assert!(PUSH_SCOPES.contains(&need), "{k}");
        }
    }

    #[test]
    fn l2_same_id_different_content_is_a_conflict_answer() {
        let (st, v, _d) = state("conflict");
        let dev = v["certs"]["remote"]["deviceId"].as_str().unwrap();
        assert_eq!(post(&st, true, &push_req(&v, "remote", &[entry(dev, 1)], &nonce(1)).0).status, 200);
        let mut changed = entry(dev, 1);
        changed["data"] = json!({ "n": 99 });
        let (req, _, _) = push_req(&v, "remote", &[changed, entry(dev, 2)], &nonce(2));
        let r = post(&st, true, &req);
        assert_eq!((r.status, r.body["reason"].as_str()), (422, Some("conflict")));
        assert_eq!(r.body["conflicts"], json!(["01".repeat(16)]));
        assert!(r.body.get("proof").is_none());
        assert_eq!(st.store.lock().unwrap().len(), 1, "충돌 조각은 아무것도 반영하지 않는다");
    }

    #[test]
    fn m1_a_cert_of_another_store_number_is_refused() {
        // 같은 가게 키, 다른 가게 번호로 켠 서버 — 이 증서(가게 ab..)를 받지 않는다.
        let v = vec();
        let d = dir("otherstore");
        let now = v["now"].as_i64().unwrap();
        let auth = LanAuth::new(v["storeKey"].as_str().unwrap().into(), "cd".repeat(32), data_key(), Some(v["lists"]["empty"].clone()));
        let mut st = LanServerState::new(auth, LanStore::open(&d, now).unwrap());
        st.clock = Box::new(move || now);
        let dev = v["certs"]["remote"]["deviceId"].as_str().unwrap();
        let r = post(&st, true, &push_req(&v, "remote", &[entry(dev, 1)], &nonce(1)).0);
        assert_eq!((r.status, r.body["reason"].as_str()), (403, Some("other-store")));
        let r = post(&st, false, &json!({ "cert": v["certs"]["replica"], "cursor": 0, "nonce": nonce(2) }));
        assert_eq!(r.body["reason"], "other-store");
        assert_eq!(log_len(&d), 0);
    }

    #[test]
    fn m1_requests_from_the_old_store_end_with_503_while_it_switches() {
        let (st, v, _d) = state("switch");
        st.store.lock().unwrap().store_id = "cd".repeat(32); // 저장소만 먼저 바뀐 순간
        let r = post(&st, false, &json!({ "cert": v["certs"]["replica"], "cursor": 0, "nonce": nonce(1) }));
        assert_eq!((r.status, r.body["reason"].as_str()), (503, Some("reloading")));
        assert!(r.body.get("proof").is_none());
    }

    #[test]
    fn a_failed_store_answers_nothing_successful_until_recovered() {
        let (st, v, _d) = state("failedstore");
        let dev = v["certs"]["remote"]["deviceId"].as_str().unwrap();
        let es = vec![entry(dev, 1)];
        assert_eq!(post(&st, true, &push_req(&v, "remote", &es, &nonce(1)).0).status, 200);
        st.store.lock().unwrap().fail_mode = Some(crate::lan_store::FailMode::WriteAndRollback);
        let r = post(&st, true, &push_req(&v, "remote", &[entry(dev, 2)], &nonce(2)).0);
        assert_eq!((r.status, r.body["reason"].as_str()), (500, Some("store-failed")));
        // 이미 저장된 조각(409 + 확인값)조차 복구 전에는 답하지 않는다.
        let r = post(&st, true, &push_req(&v, "remote", &es, &nonce(3)).0);
        assert_eq!(r.status, 500);
        assert!(r.body.get("proof").is_none());
        assert_eq!(post(&st, false, &json!({ "cert": v["certs"]["replica"], "cursor": 0, "nonce": nonce(4) })).status, 500);
        st.store.lock().unwrap().recover(v["now"].as_i64().unwrap()).unwrap();
        assert_eq!(post(&st, true, &push_req(&v, "remote", &[entry(dev, 2)], &nonce(5)).0).status, 200);
    }

    #[test]
    fn l7_the_list_signature_is_checked_once_not_per_request() {
        let (st, v, _d) = state("cache");
        assert!(st.auth().revocation_info().is_some());
        // 같은 재료(Arc)가 요청마다 그대로 쓰인다 — 목록 확인 결과가 담겨 있다.
        let a = st.auth();
        let _ = post(&st, false, &json!({ "cert": v["certs"]["replica"], "cursor": 0, "nonce": nonce(1) }));
        assert!(Arc::ptr_eq(&a, &st.auth()));
        // 목록을 바꾸면 그때 한 번 다시 확인한다(망가진 목록 = 모두 거절).
        let mut bad = v["lists"]["empty"].clone();
        bad["seq"] = json!(99);
        st.set_revocation(Some(bad));
        assert!(st.auth().revocation_info().is_none());
        assert_eq!(post(&st, false, &json!({ "cert": v["certs"]["replica"], "cursor": 0, "nonce": nonce(2) })).body["reason"], "bad-cert");
    }
}
