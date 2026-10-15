//! LAN 동기화 ④ — `/lan/push`·`/lan/pull` 처리기. 데스크탑(서버) 쪽. **와이어 v2**(검수 H1).
//!
//! 규격 정본 = `docs/LAN-REQUEST-SIGNING.md`(레인 J) · 폰/코어 `core/device/lan-auth.ts verifyLanRequest`.
//!   push 요청 { v:2, cert, keyVersion, ts, nonce, chunkId, count, sealed, sig } → 200/409 { chunkId, count, duplicate, proof }
//!   pull 요청 { v:2, cert, keyVersion, ts, nonce, cursor, sig }                → 200 { from, next, more, chunkId, sealed, proof }
//!   거절 { reason } (확인값 없음 — 폰은 확인값 없는 응답을 성공으로 믿지 않는다). 판 없는(v1) 요청은 400 old-protocol.
//!
//! 처리 순서(앞 단계가 막으면 뒤는 하지 않는다)
//!   동시 처리 상한 → ⓪ 회전 관문(철회만 되고 열쇠 회전이 없으면 503 rotation-required, 본문도 읽지 않음) → 크기 제한 → JSON 객체
//!   → 전체 속도 → ① 판·모양(v:2 아니면 old-protocol, 칸이 정확히 같아야) → ② 증서(서명·만료·철회·맡김·**이 가게 번호**)
//!   → ③ 기기 서명(도메인 RAVENVAULT-LAN-REQ-V2, 기대 키 = 증서 devicePubKey, low-S) → ④ 시각 창 ±5분 → ⑤ 이미 쓴 nonce 인지 보기만
//!   → ⑥ 열쇠 판(keyVersion = 서버 판, 아니면 410) → ⑦ 이 증서의 세션 열쇠(증서 서명 바이트까지 일치, 없으면 410) → 기기 속도
//!   → (push) 봉인 열기(그 기기의 **봉인 열쇠**, 평문 ≤ 64KiB) → 조각 번호·개수·출처·종류별 맡김·재직렬화 크기 대조
//!   → 저장소 잠금(가게가 바뀌는 중이면 503, 고장 상태면 500) → 충돌 422 → nonce 기록(상한 429) → 저장(성공해야 다음)
//!   → 응답에 그 기기의 **확인값 열쇠**로 만든 v2 확인값 부착
//!   nonce 는 서명·시각 확인 **뒤**, 그리고 (push) 봉인 확인까지 끝난 뒤에야 디스크에 적는다 — 증서만 주운 사람(서명 못 함)이나
//!   서명은 했어도 봉인이 틀린 요청이 로그를 키우지 못하게. 속도·동시성·nonce 개수 상한은 레인 I 그대로.
//!
//! 🔴 서버는 기본 꺼짐: `LanConfig::default().enabled == false` 이면 `router()` 는 None 이다. 이 파일은 포트를 열지 않는다
//!    (listen 은 하지 않으며, 켜는 곳은 설정을 읽는 호출자 몫). 외부 노출·새 서버 없음 — 기존 axum 라우터에 붙일 조각만 만든다.
//! 🔴 가게 키·열쇠 기록·철회 목록은 호출자가 준다. 이 파일은 12단어·지갑·.env 를 열지 않는다.

#![allow(dead_code)] // 켜는 쪽(server.rs 장착)은 이 레인 밖

use crate::lan_cert::{signed_by, verify_device_cert_prechecked, verify_revocation_list, CertReason, ListInfo, VerifiedCert, MAX_TIME_MS, MIN_NOW_MS};
use crate::lan_keys::{derive_lan_keys, rotation_gate_ok, LanDerivedKeys, LanKeyRecord};
use crate::lan_proof::{canonical_string, is_lan_nonce, pull_proof_v2, push_proof_v2, ProofBinding};
use crate::lan_seal::{chunk_id_of, open_chunk, seal_chunk, ChunkBinding, SealError, CHUNK_MAX_BYTES, CHUNK_MAX_ENTRIES};
use crate::lan_store::{Applied, LanStore, StoreError};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, RwLock};

/// 요청 본문 상한 — 봉인 조각(≤ 64KiB 평문 → base64 ≈ 87KB) + 증서(≤ 4KiB) + 여유.
pub const MAX_REQUEST_BYTES: usize = 128 * 1024;
/// 와이어 판. 이 서버는 이 판만 받는다(v1 은 안전하지 않아 함께 받지 않는다 — 규격 §1).
pub const LAN_WIRE_VERSION: u64 = 2;
/// 요청 서명 도메인(규격 §2.3).
pub const LAN_REQUEST_DOMAIN: &str = "RAVENVAULT-LAN-REQ-V2";
/// 요청 시각 허용 창: 서버 시계 기준 ±5분(lan-auth.ts LAN_REQUEST_WINDOW_MS). nonce 는 증서 끝까지 기억하므로(lan_store) 창의 두 배보다 길다.
pub const LAN_REQUEST_WINDOW_MS: i64 = 5 * 60_000;
const MAX_SAFE: u64 = 9_007_199_254_740_991;
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

/// 인증 재료 한 벌(가게 공개키·가게 번호·열쇠 기록·철회 목록). 켜기/다시 켜기·회전 저장 때 통째로 바꾼다 —
/// 데이터 열쇠·세션 표·철회 목록·회전 메타가 한 `Arc` 안에 있어 한 번에 바뀐다(규격 §4.1 ③).
/// 철회 목록 서명 확인은 목록이 들어올 때 **한 번만** 하고 결과를 담아 둔다(요청마다 ECDSA 복구를 다시 하지 않는다 — L7).
/// 회전 관문(§4.3)도 그때 한 번 계산한다.
pub struct LanAuth {
    /// 가게 공개키(압축 hex) — 호출자가 12단어에서 뽑은 값.
    pub store_key: String,
    /// 가게 번호(64 hex). 증서의 가게 번호가 이것과 같아야 받는다.
    pub store_id: String,
    /// 데이터 열쇠 판·기기별 세션 열쇠·회전 메타(`lan_keys`). 떨어질 때 열쇠 바이트를 지운다.
    pub keys: LanKeyRecord,
    revocation: Option<Value>,
    rev_checked: Option<Result<ListInfo, CertReason>>,
    gate_ok: bool,
}
impl LanAuth {
    pub fn new(store_key: String, store_id: String, keys: LanKeyRecord, revocation: Option<Value>) -> Self {
        let rev_checked = revocation.as_ref().map(|l| verify_revocation_list(l, &store_key, &store_id));
        // 관문: 확인을 통과한 목록이 있을 때만 의미가 있다. 목록이 없거나 깨졌으면 증서 확인이 모두 거절한다(닫힌 실패 — 그대로 403).
        let gate_ok = match &rev_checked {
            Some(Ok(info)) => rotation_gate_ok(keys.revocation_seq, &keys.revoked_at_rotation, info),
            _ => true,
        };
        LanAuth { store_key, store_id, keys, revocation, rev_checked, gate_ok }
    }
    pub fn revocation(&self) -> Option<&Value> {
        self.revocation.as_ref()
    }
    /// 확인을 통과한 목록 요약(없거나 못 넘었으면 None).
    pub fn revocation_info(&self) -> Option<&ListInfo> {
        self.rev_checked.as_ref().and_then(|r| r.as_ref().ok())
    }
    /// 서버 현재 데이터 열쇠 판.
    pub fn key_version(&self) -> u64 {
        self.keys.data_key.version
    }
    /// 회전 관문 — false 면 LAN 동기화 전체가 503 rotation-required.
    pub fn gate_ok(&self) -> bool {
        self.gate_ok
    }
    fn with_revocation(&self, list: Option<Value>) -> Self {
        LanAuth::new(self.store_key.clone(), self.store_id.clone(), self.keys.clone(), list)
    }
    /// 재료 지문 — 디스크에서 다시 읽은 것과 같으면 바꿀 것이 없다. (열쇠 바이트는 해시로만 들어간다.)
    pub fn fingerprint(&self) -> [u8; 32] {
        let mut h = Sha256::new();
        h.update(b"RAVENVAULT-LAN-AUTH-FP-V2\0");
        h.update(self.store_key.as_bytes());
        h.update(b"\0");
        h.update(self.store_id.as_bytes());
        h.update(b"\0");
        h.update(self.keys.digest());
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
    /// 철회 목록만 바꾼다(확인·회전 관문 계산은 여기서 한 번). 가게·열쇠는 그대로 — 회전 없이 새로 철회된 증서가 있으면 관문이 닫힌다.
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

fn parse(body: &[u8]) -> Result<Map<String, Value>, LanResponse> {
    if body.len() > MAX_REQUEST_BYTES {
        return Err(deny(413, "too-large"));
    }
    match serde_json::from_slice::<Value>(body) {
        Ok(Value::Object(m)) => Ok(m),
        _ => Err(deny(400, "bad-json")),
    }
}

/// 증서 확인 거절 사유 → 폰이 이해하는 짧은 코드(lan-auth.ts certReason + 이 서버의 other-store).
fn cert_reason(r: CertReason) -> &'static str {
    match r {
        CertReason::Revoked => "revoked",
        CertReason::Expired => "expired",
        CertReason::Scope => "scope",
        CertReason::OtherStore => "other-store",
        _ => "bad-cert",
    }
}

/// 거절 사유 → HTTP 상태(규격 §5 · lan-auth.ts LAN_REASON_STATUS).
pub fn reason_status(reason: &str) -> u16 {
    match reason {
        "old-protocol" | "shape" => 400,
        "key-version" => 410,
        "rotation-required" => 503,
        _ => 403,
    }
}
fn deny_reason(reason: &'static str) -> LanResponse {
    deny(reason_status(reason), reason)
}

/// 요청별 칸.
#[derive(Debug, Clone, PartialEq)]
pub enum LanFields {
    Push { chunk_id: String, count: u64, sealed: Value },
    Pull { cursor: u64 },
}

/// 확인을 통과한 요청(⓪~⑥). 세션 열쇠(⑦)는 호출자가 `session_keys` 로.
#[derive(Debug, Clone)]
pub struct LanVerified {
    pub cert: VerifiedCert,
    /// 증서 `sig`(세션 표 대조용).
    pub cert_sig: String,
    /// 증서 끝 시각(nonce 를 그때까지 기억한다).
    pub not_after: i64,
    pub nonce: String,
    pub ts: i64,
    pub key_version: u64,
    pub fields: LanFields,
}

fn int_in(v: &Value, min: u64, max: u64) -> Option<u64> {
    v.as_u64().filter(|n| (min..=max).contains(n)) // 소수·음수는 as_u64 가 None
}
fn is_chunk_id(s: &str) -> bool {
    s.len() == 64 && s.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// 서명되는 본문(규격 §2.2) — 와이어에는 실리지 않고 양쪽이 요청 칸에서 다시 만든다. `sig` 칸은 넣지 않는다.
pub(crate) fn request_sig_body(push: bool, c: &VerifiedCert, key_version: u64, nonce: &str, ts: i64, fields: &LanFields) -> Result<Map<String, Value>, &'static str> {
    let (chunk_id, count, cursor, sealed_hash) = match fields {
        LanFields::Push { chunk_id, count, sealed } if push => {
            let h = hex::encode(Sha256::digest(canonical_string(sealed)?.as_bytes()));
            (Value::from(chunk_id.as_str()), Value::from(*count), Value::Null, Value::from(h))
        }
        LanFields::Pull { cursor } if !push => (Value::Null, Value::Null, Value::from(*cursor), Value::Null),
        _ => return Err("shape"),
    };
    let v = json!({
        "v": LAN_WIRE_VERSION, "dir": if push { "push" } else { "pull" }, "storeId": c.store_id, "certId": c.cert_id, "deviceId": c.device_id,
        "keyVersion": key_version, "nonce": nonce, "ts": ts, "chunkId": chunk_id, "count": count, "cursor": cursor, "sealedHash": sealed_hash,
    });
    match v {
        Value::Object(m) => Ok(m),
        _ => Err("shape"),
    }
}

/// 서버 요청 확인 — lan-auth.ts `verifyLanRequest` 와 같은 순서·같은 사유(⓪ 회전 관문은 호출자가 먼저 본다).
/// 판·모양 → 증서(가게 서명·기한·철회·맡김·가게 번호) → 기기 서명 → 시각 창 → nonce(보기만) → 열쇠 판.
/// `seen(certId, nonce)` 는 이미 쓴 nonce 면 true — **기록하지 않는다**(기록은 봉인 확인까지 끝난 뒤 저장소 잠금 안에서).
pub fn verify_lan_request(auth: &LanAuth, raw: &Value, push: bool, now: i64, seen: &dyn Fn(&str, &str) -> bool) -> Result<LanVerified, &'static str> {
    let Some(o) = raw.as_object() else { return Err("shape") };
    if o.get("v").and_then(Value::as_u64) != Some(LAN_WIRE_VERSION) {
        return Err("old-protocol");
    }
    if matches!(o.get("cert"), None | Some(Value::Null)) {
        return Err("no-cert");
    }
    let want: &[&str] = if push {
        &["v", "cert", "keyVersion", "ts", "nonce", "chunkId", "count", "sealed", "sig"]
    } else {
        &["v", "cert", "keyVersion", "ts", "nonce", "cursor", "sig"]
    };
    let nonce = o.get("nonce").and_then(Value::as_str).filter(|n| is_lan_nonce(n));
    let ts = o.get("ts").and_then(|t| int_in(t, 1, MAX_TIME_MS as u64));
    let key_version = o.get("keyVersion").and_then(|k| int_in(k, 1, MAX_SAFE));
    let sig = o.get("sig").and_then(Value::as_str).filter(|s| s.len() <= 200);
    let shape_ok = o.len() == want.len() && want.iter().all(|k| o.contains_key(*k));
    let (true, Some(nonce), Some(ts), Some(key_version), Some(sig)) = (shape_ok, nonce, ts, key_version, sig) else { return Err("shape") };
    let fields = if push {
        let chunk_id = o["chunkId"].as_str().filter(|c| is_chunk_id(c)).ok_or("shape")?;
        let count = int_in(&o["count"], 1, 1000).ok_or("shape")?;
        if !o["sealed"].is_object() {
            return Err("shape");
        }
        LanFields::Push { chunk_id: chunk_id.to_string(), count, sealed: o["sealed"].clone() }
    } else {
        LanFields::Pull { cursor: int_in(&o["cursor"], 0, MAX_SAFE).ok_or("shape")? }
    };
    if !(MIN_NOW_MS..=MAX_TIME_MS).contains(&now) {
        return Err("request-time");
    }
    let scopes: &[&str] = if push { &PUSH_SCOPES } else { &PULL_SCOPES };
    let cert = verify_device_cert_prechecked(&o["cert"], &auth.store_key, now, auth.rev_checked.as_ref(), &auth.store_id, scopes).map_err(cert_reason)?;
    // 증서는 이 가게 것이어야 한다(같은 가게 키를 쓰는 다른 가게 번호의 증서를 받지 않는다).
    if cert.store_id != auth.store_id {
        return Err("other-store");
    }
    let mut body = request_sig_body(push, &cert, key_version, nonce, ts as i64, &fields)?;
    body.insert("sig".into(), Value::from(sig));
    if !signed_by(LAN_REQUEST_DOMAIN, &body, &cert.device_pub_key) {
        return Err("bad-request-sig");
    }
    if (now - ts as i64).abs() > LAN_REQUEST_WINDOW_MS {
        return Err("request-time");
    }
    if seen(&cert.cert_id, nonce) {
        return Err("replay");
    }
    if key_version != auth.key_version() {
        return Err("key-version");
    }
    let cert_sig = o["cert"]["sig"].as_str().unwrap_or_default().to_string();
    let not_after = o["cert"]["notAfter"].as_i64().unwrap_or(now);
    Ok(LanVerified { cert, cert_sig, not_after, nonce: nonce.to_string(), ts: ts as i64, key_version, fields })
}

/// ⑦ 이 서버가 그 증서(같은 certId·같은 기기·**같은 증서 서명**)에 세션 열쇠를 줬는지 → 그 기기의 봉인·확인값 열쇠.
/// 없으면 None(= 410 key-version: 폰은 「열쇠 필요」).
pub fn session_keys(auth: &LanAuth, v: &LanVerified) -> Option<LanDerivedKeys> {
    let e = auth.keys.sessions.get(&v.cert.cert_id)?;
    if e.device_id != v.cert.device_id || e.cert_sig != v.cert_sig {
        return None;
    }
    derive_lan_keys(&auth.keys.data_key, &e.key.0, &v.cert.store_id, &v.cert.cert_id).ok()
}

fn binding(c: &VerifiedCert) -> ProofBinding<'_> {
    ProofBinding { store_id: &c.store_id, cert_id: &c.cert_id, device_id: &c.device_id }
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

/// ⓪~⑦ 공통: 관문 → 본문 → 전체 속도 → 확인 → 세션 열쇠 → 기기 속도.
fn admit(st: &LanServerState, push: bool, body: &[u8]) -> Result<(Arc<LanAuth>, LanVerified, LanDerivedKeys, i64), LanResponse> {
    let auth = st.auth();
    if !auth.gate_ok() {
        return Err(deny_reason("rotation-required"));
    }
    let req = Value::Object(parse(body)?);
    let now = (st.clock)();
    if !st.rate_ok(now, None) {
        return Err(st.limited("rate"));
    }
    let seen = |_cert_id: &str, nonce: &str| st.store.lock().map(|s| s.nonce_seen(nonce)).unwrap_or(false);
    let v = verify_lan_request(&auth, &req, push, now, &seen).map_err(deny_reason)?;
    let keys = session_keys(&auth, &v).ok_or_else(|| deny_reason("key-version"))?;
    if !st.rate_ok(now, Some(&v.cert.device_id)) {
        return Err(st.limited("rate"));
    }
    Ok((auth, v, keys, now))
}

pub fn handle_push(st: &LanServerState, body: &[u8]) -> LanResponse {
    let (auth, v, keys, now) = match admit(st, true, body) {
        Ok(x) => x,
        Err(e) => return e,
    };
    let LanFields::Push { chunk_id, count: want_count, sealed } = &v.fields else { return deny(400, "shape") };
    let cert = &v.cert;
    let bind = ChunkBinding { store_id: &cert.store_id, cert_id: &cert.cert_id, device_id: &cert.device_id, dir: "push", chunk_id, from: 0 };
    let entries = match open_chunk(sealed, &keys.seal, &bind) {
        Ok(e) => e,
        Err(SealError::Stale) => return deny(410, "key-version"),
        Err(SealError::Forbidden) => return deny(403, "bad-seal"),
        Err(SealError::OutOfRange(_)) => return deny(413, "chunk-too-big"),
        Err(_) => return deny(400, "bad-sealed"),
    };
    let ids: Vec<&str> = entries.iter().filter_map(|e| e.get("id").and_then(Value::as_str)).collect();
    if *chunk_id != chunk_id_of(&cert.device_id, &ids) || *want_count != entries.len() as u64 {
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
    let duplicate = store.has_chunk(chunk_id);
    if !duplicate {
        let clash = store.conflicts(&entries);
        if !clash.is_empty() {
            // 같은 id 인데 내용이 다르다 — 조용히 버리고 200 을 주면 폰은 반영된 줄 안다. 통째로 거절하고 알린다.
            return LanResponse { status: 422, body: json!({ "reason": "conflict", "conflicts": clash }) };
        }
    }
    // 서명·시각·봉인·종류·크기 확인이 끝난 뒤에야 nonce 를 디스크에 적는다.
    let nonce_until = v.not_after.saturating_add(crate::lan_cert::DEVICE_CLOCK_SKEW_MS);
    if let Err(e) = store.use_nonce(&v.nonce, &cert.device_id, now, nonce_until) {
        return store_err(st, e);
    }
    // 저장(디스크까지)이 성공해야만 아래 확인값을 만든다.
    let duplicate = duplicate
        || match store.append_chunk(chunk_id, &cert.device_id, &entries) {
            Ok(Applied::DuplicateChunk) => true,
            Ok(Applied::New { .. }) => false,
            Err(e) => return store_err(st, e),
        };
    drop(store);
    let count = entries.len() as u64;
    let Ok(proof) = push_proof_v2(&keys.proof.key, auth.key_version(), &binding(cert), &v.nonce, chunk_id, count) else { return deny(500, "internal") };
    LanResponse { status: if duplicate { 409 } else { 200 }, body: json!({ "chunkId": chunk_id, "count": count, "duplicate": duplicate, "proof": proof }) }
}

pub fn handle_pull(st: &LanServerState, body: &[u8]) -> LanResponse {
    let (auth, v, keys, now) = match admit(st, false, body) {
        Ok(x) => x,
        Err(e) => return e,
    };
    let LanFields::Pull { cursor } = v.fields else { return deny(400, "shape") };
    let cert = &v.cert;
    let mut store = match lock_store(st, &auth) {
        Ok(s) => s,
        Err(e) => return e,
    };
    let from = match usize::try_from(cursor) {
        Ok(c) if c <= store.len() => c,
        _ => return deny(416, "cursor"),
    };
    let nonce_until = v.not_after.saturating_add(crate::lan_cert::DEVICE_CLOCK_SKEW_MS);
    if let Err(e) = store.use_nonce(&v.nonce, &cert.device_id, now, nonce_until) {
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
        match seal_chunk(&out, &keys.seal, &bind, &(st.seal_nonce)()) {
            Ok(s) => s,
            Err(_) => return deny(500, "internal"),
        }
    };
    let Ok(proof) = pull_proof_v2(&keys.proof.key, auth.key_version(), &binding(cert), &v.nonce, from as u64, i as u64, more, Some(&chunk_id), Some(&sealed)) else {
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
    use crate::lan_testkit::{self as kit, entry, entry_kind, nonce, post, pull_req, push_req, Dev, NOW};
    use std::path::PathBuf;
    use std::sync::atomic::Ordering;

    fn expected_push_proof(d: &Dev, n: &str, chunk_id: &str, count: u64) -> String {
        let b = ProofBinding { store_id: &kit::store_id(), cert_id: &d.cert_id, device_id: &d.device_id };
        push_proof_v2(&kit::keys_of(d, 3).proof.key, 3, &b, n, chunk_id, count).unwrap()
    }
    fn log_len(d: &PathBuf) -> u64 {
        std::fs::metadata(d.join(crate::lan_store::LOG_FILE)).map_or(0, |m| m.len())
    }
    fn reason(r: &LanResponse) -> (u16, Option<&str>) {
        (r.status, r.body["reason"].as_str())
    }

    #[test]
    fn push_stores_then_answers_with_the_proof() {
        let (st, _d) = kit::state("push");
        let dev = kit::remote();
        let es = vec![entry(&dev.device_id, 1), entry(&dev.device_id, 2)];
        let (req, chunk_id) = push_req(&dev, &es, &nonce(1));
        let r = post(&st, true, &req);
        assert_eq!(r.status, 200, "{}", r.body);
        assert_eq!(r.body["duplicate"], false);
        assert_eq!(r.body["count"], 2);
        assert!(proof_equals(&expected_push_proof(&dev, &nonce(1), &chunk_id, 2), r.body["proof"].as_str().unwrap()));
        assert_eq!(st.store.lock().unwrap().len(), 2);
    }

    #[test]
    fn the_same_chunk_with_a_new_nonce_is_409_with_a_proof_and_not_applied_twice() {
        let (st, _d) = kit::state("dup");
        let dev = kit::remote();
        let es = vec![entry(&dev.device_id, 1)];
        assert_eq!(post(&st, true, &push_req(&dev, &es, &nonce(1)).0).status, 200);
        let (req, chunk_id) = push_req(&dev, &es, &nonce(2));
        let r = post(&st, true, &req);
        assert_eq!(r.status, 409);
        assert_eq!(r.body["duplicate"], true);
        assert!(proof_equals(&expected_push_proof(&dev, &nonce(2), &chunk_id, 1), r.body["proof"].as_str().unwrap()));
        assert_eq!(st.store.lock().unwrap().len(), 1);
    }

    #[test]
    fn a_replayed_request_is_refused_even_with_a_valid_cert_seal_and_signature() {
        let (st, _d) = kit::state("replay");
        let dev = kit::remote();
        let (req, _) = push_req(&dev, &[entry(&dev.device_id, 1)], &nonce(1));
        assert_eq!(post(&st, true, &req).status, 200);
        let r = post(&st, true, &req);
        assert_eq!(reason(&r), (403, Some("replay")));
        assert!(r.body.get("proof").is_none());
        // pull 도 같은 요청 두 번은 거절.
        let p = pull_req(&kit::replica(), 0, &nonce(2));
        assert_eq!(post(&st, false, &p).status, 200);
        assert_eq!(reason(&post(&st, false, &p)), (403, Some("replay")));
    }

    #[test]
    fn devices_without_a_good_cert_are_refused_and_nothing_is_stored() {
        let (st, _d) = kit::state("deny");
        let dev = kit::remote();
        let (req, _) = push_req(&dev, &[entry(&dev.device_id, 1)], &nonce(1));
        // 증서 없음
        let mut no = req.clone();
        no.as_object_mut().unwrap().remove("cert");
        assert_eq!(reason(&post(&st, true, &no)), (403, Some("no-cert")));
        // 증서 서명 훼손(맡김 늘리기)
        let mut forged = req.clone();
        forged["cert"]["scopes"] = json!(["read", "draft", "ticket-check"]);
        assert_eq!(post(&st, true, &forged).body["reason"], "bad-cert");
        // 만료 · 아직 효력 전 — 그 기기 자신이 서명해도
        let ex = kit::expired();
        let r = post(&st, false, &pull_req(&ex, 0, &nonce(2)));
        assert_eq!(reason(&r), (403, Some("expired")));
        let fu = kit::future();
        assert_eq!(post(&st, false, &pull_req(&fu, 0, &nonce(3))).body["reason"], "bad-cert");
        // 맡김 없음(replica 는 read·replicate 뿐 — 보내기 불가)
        let rep = kit::replica();
        let (rq, _) = push_req(&rep, &[entry(&rep.device_id, 3)], &nonce(4));
        assert_eq!(post(&st, true, &rq).body["reason"], "scope");
        // nonce 모양이 틀리면 shape(400)
        let mut bad = req.clone();
        bad["nonce"] = json!("short");
        assert_eq!(reason(&post(&st, true, &bad)), (400, Some("shape")));
        assert_eq!(st.store.lock().unwrap().len(), 0);
        assert_eq!(st.store.lock().unwrap().nonce_count(), 0, "거절된 요청은 nonce 를 남기지 않는다");
    }

    #[test]
    fn a_revoked_device_is_refused_for_push_and_pull() {
        let rv = kit::revoked();
        let l = kit::list(2, &[&rv.cert_id]);
        let (st, _d) = kit::state_with("revoked", kit::auth(4, &kit::all(), &l));
        let (req, _) = push_req_v(&rv, &[entry(&rv.device_id, 1)], &nonce(1), 4);
        assert_eq!(reason(&post(&st, true, &req)), (403, Some("revoked")));
        assert_eq!(reason(&post(&st, false, &kit::pull_req_v(&rv, 0, &nonce(2), 4))), (403, Some("revoked")));
        // 같은 목록에서도 철회되지 않은 기기는 통과
        let dev = kit::remote();
        assert_eq!(post(&st, true, &push_req_v(&dev, &[entry(&dev.device_id, 1)], &nonce(3), 4).0).status, 200);
        assert_eq!(st.store.lock().unwrap().len(), 1);
    }
    use kit::push_req_v;

    #[test]
    fn no_or_stale_revocation_list_closes_the_door() {
        let stale = kit::list_at(1, NOW - 25 * 3600_000, &[]);
        let (st, _d) = kit::state_with("stale", kit::auth(3, &kit::all(), &stale));
        let dev = kit::remote();
        let (req, _) = push_req(&dev, &[entry(&dev.device_id, 1)], &nonce(1));
        assert_eq!(post(&st, true, &req).body["reason"], "bad-cert");
        st.set_revocation(None);
        assert_eq!(post(&st, true, &req).body["reason"], "bad-cert");
        assert_eq!(st.store.lock().unwrap().len(), 0);
    }

    #[test]
    fn a_bad_seal_stale_key_or_mismatched_chunk_is_refused() {
        let (st, _d) = kit::state("seal");
        let dev = kit::remote();
        let es = vec![entry(&dev.device_id, 1)];
        let (req, chunk_id) = push_req(&dev, &es, &nonce(1));
        // 서명은 맞지만 봉인이 다른 조각 번호로 닫혔다
        let other = "ab".repeat(32);
        let w = kit::sign_wire(&dev.cert, &dev.sk, 3, &nonce(2), NOW, LanFields::Push { chunk_id: other, count: 1, sealed: req["sealed"].clone() });
        assert_eq!(post(&st, true, &w).body["reason"], "bad-seal");
        // 데이터 열쇠 그대로(v1 방식)로 봉인 → 열리지 않는다
        let bind = ChunkBinding { store_id: &kit::store_id(), cert_id: &dev.cert_id, device_id: &dev.device_id, dir: "push", chunk_id: &chunk_id, from: 0 };
        let v1 = seal_chunk(&es, &kit::data_key(3), &bind, &[5u8; 24]).unwrap();
        let w = kit::sign_wire(&dev.cert, &dev.sk, 3, &nonce(3), NOW, LanFields::Push { chunk_id: chunk_id.clone(), count: 1, sealed: v1 });
        assert_eq!(reason(&post(&st, true, &w)), (403, Some("bad-seal")));
        // 개수 불일치(서명은 개수 5 로)
        let w = kit::sign_wire(&dev.cert, &dev.sk, 3, &nonce(4), NOW, LanFields::Push { chunk_id: chunk_id.clone(), count: 5, sealed: req["sealed"].clone() });
        assert_eq!(post(&st, true, &w).body["reason"], "chunk-mismatch");
        // 봉투 판이 서버 판과 다르다(요청 판은 맞게) → 410
        let mut sealed = req["sealed"].clone();
        sealed["keyVersion"] = json!(2);
        let w = kit::sign_wire(&dev.cert, &dev.sk, 3, &nonce(5), NOW, LanFields::Push { chunk_id: chunk_id.clone(), count: 1, sealed });
        assert_eq!(reason(&post(&st, true, &w)), (410, Some("key-version")));
        // 봉투가 객체가 아니면 모양 거절
        let mut bad = req.clone();
        bad["sealed"] = json!("nope");
        assert_eq!(reason(&post(&st, true, &bad)), (400, Some("shape")));
        // 남의 항목(origin 이 이 기기가 아님)은 안 받는다
        let (o, _) = push_req(&dev, &[entry(&"11".repeat(16), 9)], &nonce(6));
        assert_eq!(post(&st, true, &o).body["reason"], "bad-origin");
        assert_eq!(st.store.lock().unwrap().len(), 0);
    }

    #[test]
    fn request_size_and_shape_limits() {
        let (st, _d) = kit::state("limits");
        let big = vec![b' '; MAX_REQUEST_BYTES + 1];
        assert_eq!(handle_push(&st, &big).status, 413);
        assert_eq!(handle_pull(&st, &big).status, 413);
        assert_eq!(handle_push(&st, b"not json").body["reason"], "bad-json");
        assert_eq!(handle_push(&st, b"[1]").body["reason"], "bad-json");
        assert_eq!(reason(&handle_pull(&st, b"{}")), (400, Some("old-protocol")));
    }

    #[test]
    fn v1_requests_are_old_protocol() {
        let (st, d) = kit::state("v1");
        let dev = kit::replica();
        // 레인 I 의 v1 모양 그대로(판·서명 없음) — 증서가 맞아도 받지 않는다.
        let r = post(&st, false, &json!({ "cert": dev.cert, "cursor": 0, "nonce": nonce(1) }));
        assert_eq!(reason(&r), (400, Some("old-protocol")));
        let mut v = pull_req(&dev, 0, &nonce(2));
        v["v"] = json!(1);
        assert_eq!(post(&st, false, &v).body["reason"], "old-protocol");
        v["v"] = json!("2");
        assert_eq!(post(&st, false, &v).body["reason"], "old-protocol");
        v["v"] = json!(2.5);
        assert_eq!(post(&st, false, &v).body["reason"], "old-protocol");
        assert_eq!(log_len(&d), 0);
    }

    #[test]
    fn a_failed_save_never_gets_a_success_or_a_proof() {
        let (st, _d) = kit::state("savefail");
        let dev = kit::remote();
        let (req, _) = push_req(&dev, &[entry(&dev.device_id, 1)], &nonce(1));
        // nonce 기록 실패
        st.store.lock().unwrap().fail_next_write = true;
        let r = post(&st, true, &req);
        assert_eq!(reason(&r), (500, Some("store-failed")));
        assert!(r.body.get("proof").is_none());
        assert_eq!(st.store.lock().unwrap().len(), 0);
        // 다시 보내면(같은 nonce, 실패가 nonce 를 태우지 않았다) 정상 저장
        assert_eq!(post(&st, true, &req).status, 200);
        assert_eq!(st.store.lock().unwrap().len(), 1);
    }

    #[test]
    fn pull_hands_over_other_devices_entries_sealed_and_proved() {
        let (st, _d) = kit::state("pull");
        let me = kit::replica();
        let other = kit::remote().device_id;
        st.store.lock().unwrap().append_chunk(&"01".repeat(32), &other, &[entry(&other, 1), entry(&me.device_id, 2), entry(&other, 3)]).unwrap();
        let r = post(&st, false, &pull_req(&me, 0, &nonce(1)));
        assert_eq!(r.status, 200, "{}", r.body);
        assert_eq!((r.body["from"].as_u64(), r.body["next"].as_u64(), r.body["more"].as_bool()), (Some(0), Some(3), Some(false)));
        // 확인값은 폰 pullProof(v2)와 같은 규칙, 이 기기의 확인값 열쇠로 맞는다
        let k = kit::keys_of(&me, 3);
        let sid = kit::store_id();
        let b = ProofBinding { store_id: &sid, cert_id: &me.cert_id, device_id: &me.device_id };
        let want = pull_proof_v2(&k.proof.key, 3, &b, &nonce(1), 0, 3, false, r.body["chunkId"].as_str(), Some(&r.body["sealed"])).unwrap();
        assert!(proof_equals(&want, r.body["proof"].as_str().unwrap()));
        // 이 기기의 봉인 열쇠로 열면 내 항목은 빠져 있다(데이터 열쇠 그대로는 안 열린다)
        let cb = ChunkBinding { store_id: &sid, cert_id: &me.cert_id, device_id: &me.device_id, dir: "pull", chunk_id: r.body["chunkId"].as_str().unwrap(), from: 0 };
        assert_eq!(open_chunk(&r.body["sealed"], &k.seal, &cb).unwrap(), vec![entry(&other, 1), entry(&other, 3)]);
        assert!(open_chunk(&r.body["sealed"], &kit::data_key(3), &cb).is_err());
        // 끝에서 다시 물으면 빈 응답도 인증된다
        let r = post(&st, false, &pull_req(&me, 3, &nonce(2)));
        assert_eq!((r.body["sealed"].is_null(), r.body["next"].as_u64(), r.body["more"].as_bool()), (true, Some(3), Some(false)));
        let want = pull_proof_v2(&k.proof.key, 3, &b, &nonce(2), 3, 3, false, r.body["chunkId"].as_str(), None).unwrap();
        assert!(proof_equals(&want, r.body["proof"].as_str().unwrap()));
        // 범위 밖 커서
        assert_eq!(post(&st, false, &pull_req(&me, 4, &nonce(3))).status, 416);
        // 같은 nonce 재사용 거절
        assert_eq!(post(&st, false, &pull_req(&me, 0, &nonce(1))).body["reason"], "replay");
    }

    #[test]
    fn pull_is_chunked_by_fifty_entries() {
        let (st, _d) = kit::state("chunks");
        let me = kit::replica();
        let other = kit::remote().device_id;
        let es: Vec<Value> = (0..60u8).map(|i| entry(&other, i)).collect();
        {
            let mut s = st.store.lock().unwrap();
            s.append_chunk(&"01".repeat(32), &other, &es[..30]).unwrap();
            s.append_chunk(&"02".repeat(32), &other, &es[30..]).unwrap();
        }
        let r = post(&st, false, &pull_req(&me, 0, &nonce(1)));
        assert_eq!((r.body["next"].as_u64(), r.body["more"].as_bool()), (Some(50), Some(true)));
        let r = post(&st, false, &pull_req(&me, 50, &nonce(2)));
        assert_eq!((r.body["next"].as_u64(), r.body["more"].as_bool()), (Some(60), Some(false)));
    }

    #[test]
    fn pull_needs_a_read_scope() {
        let (st, _d) = kit::state("pullscope");
        assert_eq!(reason(&post(&st, false, &pull_req(&kit::draft_only(), 0, &nonce(1)))), (403, Some("scope")));
        assert_eq!(post(&st, false, &pull_req(&kit::expired(), 0, &nonce(2))).body["reason"], "expired");
    }

    #[test]
    fn the_server_is_off_by_default() {
        let (st, _d) = kit::state("off");
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
        let (st, _d) = kit::state("router");
        let st = Arc::new(st);
        let app = router(&LanConfig { enabled: true }, st.clone()).unwrap();
        let dev = kit::remote();
        let (req, _) = push_req(&dev, &[entry(&dev.device_id, 1)], &nonce(1));
        let res = app.clone().oneshot(Request::post("/lan/push").body(Body::from(serde_json::to_vec(&req).unwrap())).unwrap()).await.unwrap();
        assert_eq!(res.status(), 200);
        assert_eq!(st.store.lock().unwrap().len(), 1);
        let res = app.clone().oneshot(Request::post("/lan/push").body(Body::from(vec![b'x'; MAX_REQUEST_BYTES + 10])).unwrap()).await.unwrap();
        assert_eq!(res.status(), 413);
        let res = app.clone().oneshot(Request::get("/lan/push").body(Body::empty()).unwrap()).await.unwrap();
        assert_eq!(res.status(), 405);
        // 스위치를 내리면 이미 붙은 경로도 아무것도 처리하지 않는다.
        st.live.store(false, std::sync::atomic::Ordering::SeqCst);
        let (req, _) = push_req(&dev, &[entry(&dev.device_id, 2)], &nonce(2));
        let res = app.oneshot(Request::post("/lan/push").body(Body::from(serde_json::to_vec(&req).unwrap())).unwrap()).await.unwrap();
        assert_eq!(res.status(), 404);
        assert_eq!(st.store.lock().unwrap().len(), 1, "꺼진 뒤에는 저장하지 않는다");
    }

    #[test]
    fn m2_an_oversize_entry_is_refused_on_push_and_skipped_on_pull() {
        let (st, d) = kit::state("oversize");
        let dev = kit::remote();
        // 평문 65,537바이트짜리 항목 하나 — 암호문 상한은 통과한다.
        let mut e = entry(&dev.device_id, 1);
        e["data"] = json!("");
        let base = serde_json::to_string(&vec![e.clone()]).unwrap().len();
        e["data"] = json!("x".repeat(CHUNK_MAX_BYTES + 1 - base));
        let chunk_id = chunk_id_of(&dev.device_id, &[e["id"].as_str().unwrap()]);
        let sid = kit::store_id();
        let plain = serde_json::to_string(&vec![e.clone()]).unwrap();
        assert_eq!(plain.len(), CHUNK_MAX_BYTES + 1);
        use chacha20poly1305::aead::{Aead, KeyInit, Payload};
        let aad = canonical_string(&json!([crate::lan_seal::LAN_SEAL_DOMAIN, sid, dev.cert_id, dev.device_id, "push", chunk_id, 0, 3])).unwrap();
        let ct = chacha20poly1305::XChaCha20Poly1305::new((&kit::keys_of(&dev, 3).seal.key).into())
            .encrypt(chacha20poly1305::XNonce::from_slice(&[5u8; 24]), Payload { msg: plain.as_bytes(), aad: aad.as_bytes() })
            .unwrap();
        use base64::Engine as _;
        let sealed = json!({ "v": 1, "keyVersion": 3, "nonce": hex::encode([5u8; 24]), "ct": base64::engine::general_purpose::STANDARD.encode(ct) });
        let w = kit::sign_wire(&dev.cert, &dev.sk, 3, &nonce(1), NOW, LanFields::Push { chunk_id, count: 1, sealed });
        assert_eq!(reason(&post(&st, true, &w)), (413, Some("chunk-too-big")));
        assert_eq!(log_len(&d), 0, "거절된 요청은 nonce 도 남기지 않는다");

        // 이 수정 전에 이미 저장된 초과 항목(복구 경로): pull 은 건너뛰고 기록하며 커서를 앞으로 보낸다.
        let other = dev.device_id.clone();
        st.store.lock().unwrap().append_chunk(&"01".repeat(32), &other, &[entry(&other, 7), e.clone(), entry(&other, 9)]).unwrap();
        let me = kit::replica();
        let r = post(&st, false, &pull_req(&me, 0, &nonce(2)));
        assert_eq!(r.status, 200, "{}", r.body);
        assert_eq!((r.body["next"].as_u64(), r.body["more"].as_bool()), (Some(3), Some(false)));
        let cb = ChunkBinding { store_id: &sid, cert_id: &me.cert_id, device_id: &me.device_id, dir: "pull", chunk_id: r.body["chunkId"].as_str().unwrap(), from: 0 };
        assert_eq!(open_chunk(&r.body["sealed"], &kit::keys_of(&me, 3).seal, &cb).unwrap(), vec![entry(&other, 7), entry(&other, 9)]);
        assert_eq!(st.counters.oversize_skipped.load(Ordering::Relaxed), 1);
    }

    #[test]
    fn m3_a_bad_seal_or_signature_never_writes_a_nonce() {
        let (st, d) = kit::state("noncelate");
        let dev = kit::remote();
        let (good, chunk_id) = push_req(&dev, &[entry(&dev.device_id, 1)], &nonce(1));
        let junk = json!({ "v": 1, "keyVersion": 3, "nonce": "00".repeat(24), "ct": "AAAA" });
        for i in 0..20u32 {
            // 서명은 맞지만 봉인이 틀림
            let w = kit::sign_wire(&dev.cert, &dev.sk, 3, &nonce(100 + i), NOW, LanFields::Push { chunk_id: chunk_id.clone(), count: 1, sealed: junk.clone() });
            assert!(matches!(post(&st, true, &w).body["reason"].as_str(), Some("bad-seal" | "bad-sealed")));
            // 증서만 주운 사람(서명 없음·남의 키) — 서명 단계에서 끝
            let mut stolen = good.clone();
            stolen["nonce"] = json!(nonce(200 + i));
            assert_eq!(post(&st, true, &stolen).body["reason"], "bad-request-sig");
            let mut pull = pull_req(&kit::replica(), 0, &nonce(300 + i));
            pull["cert"] = dev.cert.clone(); // 남의 증서 + 내 서명
            assert_eq!(post(&st, false, &pull).body["reason"], "bad-request-sig");
        }
        assert_eq!(log_len(&d), 0, "증서만 베낀 요청·서명만 맞고 봉인이 틀린 요청은 로그를 키우지 못한다");
        assert_eq!(st.store.lock().unwrap().nonce_count(), 0);
        assert_eq!(post(&st, true, &good).status, 200);
        // 한 번 쓴 nonce 는 봉인을 열기 전에 거절된다.
        assert_eq!(post(&st, true, &good).body["reason"], "replay");
    }

    #[test]
    fn m3_rate_and_concurrency_limits() {
        let (st, _d) = kit::state("rate");
        let me = kit::replica();
        let mut last = 0;
        for i in 0..(MAX_PER_MIN_DEVICE + 1) {
            let r = post(&st, false, &pull_req(&me, 0, &nonce(1000 + i)));
            last = r.status;
            if i < MAX_PER_MIN_DEVICE {
                assert_eq!(r.status, 200, "{i}");
            }
        }
        assert_eq!(last, 429, "기기별 1분 상한");
        // 다른 기기는 아직 받는다(전체 상한 전).
        let dev = kit::remote();
        assert_eq!(post(&st, true, &push_req(&dev, &[entry(&dev.device_id, 1)], &nonce(1)).0).status, 200);
        // 전체 상한: 창을 채운다.
        st.rate.lock().unwrap().total = MAX_PER_MIN_TOTAL;
        assert_eq!(post(&st, true, &push_req(&dev, &[entry(&dev.device_id, 2)], &nonce(2)).0).body["reason"], "rate");
        // 동시 처리 상한.
        st.inflight.store(MAX_INFLIGHT, Ordering::SeqCst);
        let r = handle(&st, false, &serde_json::to_vec(&pull_req(&me, 0, &nonce(3))).unwrap());
        assert_eq!(reason(&r), (503, Some("busy")));
        assert_eq!(st.inflight.load(Ordering::SeqCst), MAX_INFLIGHT, "거절한 요청은 자리를 남기지 않는다");
        st.inflight.store(0, Ordering::SeqCst);
    }

    #[test]
    fn m5_each_kind_needs_its_scope_on_push_and_on_pull() {
        let (st, _d) = kit::state("kinds");
        let dev = kit::remote(); // remote = read, draft
        for (i, kind) in ["note", "ticket-check", "key-request", "receipt", "refund"].iter().enumerate() {
            let (req, _) = push_req(&dev, &[entry_kind(&dev.device_id, i as u8 + 1, kind)], &nonce(i as u32 + 1));
            assert_eq!(reason(&post(&st, true, &req)), (403, Some("kind-scope")), "{kind}");
        }
        assert_eq!(st.store.lock().unwrap().len(), 0);
        assert_eq!(st.counters.kind_refused.load(Ordering::Relaxed), 5);
        assert_eq!(post(&st, true, &push_req(&dev, &[entry_kind(&dev.device_id, 9, "draft")], &nonce(9)).0).status, 200);
        // pull: 저장된 여러 종류 — replica(replicate)는 아는 종류 전부, 모르는 종류는 아무에게도.
        let other = "77".repeat(16);
        {
            let mut s = st.store.lock().unwrap();
            let es: Vec<Value> = ["draft", "ticket-check", "key-request", "notice-write", "note"].iter().enumerate().map(|(i, k)| entry_kind(&other, 20 + i as u8, k)).collect();
            s.append_chunk(&"02".repeat(32), &other, &es).unwrap();
        }
        let me = kit::replica();
        let r = post(&st, false, &pull_req(&me, 0, &nonce(30)));
        let sid = kit::store_id();
        let cb = ChunkBinding { store_id: &sid, cert_id: &me.cert_id, device_id: &me.device_id, dir: "pull", chunk_id: r.body["chunkId"].as_str().unwrap(), from: 0 };
        let kinds: Vec<String> = open_chunk(&r.body["sealed"], &kit::keys_of(&me, 3).seal, &cb).unwrap().iter().map(|e| e["kind"].as_str().unwrap().to_string()).collect();
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
        let (st, _d) = kit::state("conflict");
        let dev = kit::remote();
        assert_eq!(post(&st, true, &push_req(&dev, &[entry(&dev.device_id, 1)], &nonce(1)).0).status, 200);
        let mut changed = entry(&dev.device_id, 1);
        changed["data"] = json!({ "n": 99 });
        let (req, _) = push_req(&dev, &[changed, entry(&dev.device_id, 2)], &nonce(2));
        let r = post(&st, true, &req);
        assert_eq!(reason(&r), (422, Some("conflict")));
        assert_eq!(r.body["conflicts"], json!(["01".repeat(16)]));
        assert!(r.body.get("proof").is_none());
        assert_eq!(st.store.lock().unwrap().len(), 1, "충돌 조각은 아무것도 반영하지 않는다");
    }

    #[test]
    fn m1_a_cert_of_another_store_number_is_refused() {
        // 같은 가게 키, 다른 가게 번호로 켠 서버 — 이 증서(가게 ab..)를 받지 않는다.
        let l = kit::list(1, &[]);
        let a = LanAuth::new(kit::STORE_KEY.into(), "cd".repeat(32), kit::record(3, &kit::all(), &l), Some(l));
        let (st, d) = kit::state_with("otherstore", a);
        let dev = kit::remote();
        assert_eq!(reason(&post(&st, true, &push_req(&dev, &[entry(&dev.device_id, 1)], &nonce(1)).0)), (403, Some("other-store")));
        assert_eq!(post(&st, false, &pull_req(&kit::replica(), 0, &nonce(2))).body["reason"], "other-store");
        assert_eq!(log_len(&d), 0);
    }

    #[test]
    fn m1_requests_from_the_old_store_end_with_503_while_it_switches() {
        let (st, _d) = kit::state("switch");
        st.store.lock().unwrap().store_id = "cd".repeat(32); // 저장소만 먼저 바뀐 순간
        let r = post(&st, false, &pull_req(&kit::replica(), 0, &nonce(1)));
        assert_eq!(reason(&r), (503, Some("reloading")));
        assert!(r.body.get("proof").is_none());
    }

    #[test]
    fn a_failed_store_answers_nothing_successful_until_recovered() {
        let (st, _d) = kit::state("failedstore");
        let dev = kit::remote();
        let es = vec![entry(&dev.device_id, 1)];
        assert_eq!(post(&st, true, &push_req(&dev, &es, &nonce(1)).0).status, 200);
        st.store.lock().unwrap().fail_mode = Some(crate::lan_store::FailMode::WriteAndRollback);
        let r = post(&st, true, &push_req(&dev, &[entry(&dev.device_id, 2)], &nonce(2)).0);
        assert_eq!(reason(&r), (500, Some("store-failed")));
        // 이미 저장된 조각(409 + 확인값)조차 복구 전에는 답하지 않는다.
        let r = post(&st, true, &push_req(&dev, &es, &nonce(3)).0);
        assert_eq!(r.status, 500);
        assert!(r.body.get("proof").is_none());
        assert_eq!(post(&st, false, &pull_req(&kit::replica(), 0, &nonce(4))).status, 500);
        st.store.lock().unwrap().recover(NOW).unwrap();
        assert_eq!(post(&st, true, &push_req(&dev, &[entry(&dev.device_id, 2)], &nonce(5)).0).status, 200);
    }

    #[test]
    fn l7_the_list_signature_is_checked_once_not_per_request() {
        let (st, _d) = kit::state("cache");
        assert!(st.auth().revocation_info().is_some());
        // 같은 재료(Arc)가 요청마다 그대로 쓰인다 — 목록 확인 결과가 담겨 있다.
        let a = st.auth();
        let _ = post(&st, false, &pull_req(&kit::replica(), 0, &nonce(1)));
        assert!(Arc::ptr_eq(&a, &st.auth()));
        // 목록을 바꾸면 그때 한 번 다시 확인한다(망가진 목록 = 모두 거절).
        let mut bad = kit::list(1, &[]);
        bad["seq"] = json!(99);
        st.set_revocation(Some(bad));
        assert!(st.auth().revocation_info().is_none());
        assert_eq!(post(&st, false, &pull_req(&kit::replica(), 0, &nonce(2))).body["reason"], "bad-cert");
    }

    // ── H1 v2: 요청 서명 · 열쇠 나누기 · 회전 관문 ─────────────────────────

    fn vectors() -> Value {
        serde_json::from_str(include_str!("../testdata/rv-lan-v2-vectors.json")).unwrap()
    }
    fn b32(s: &str) -> [u8; 32] {
        hex::decode(s).unwrap().try_into().unwrap()
    }
    /// 벡터의 가게·기기·열쇠로 만든 재료(세션 = 벡터 sessionKeyHex).
    fn vector_auth(v: &Value, key_version: u64) -> LanAuth {
        use crate::lan_keys::{Secret32, SessionEntry};
        let cert = &v["device"]["cert"];
        let list = v["revocationList"].clone();
        let rec = LanKeyRecord {
            data_key: crate::lan_seal::DataKey { version: key_version, key: b32(v["dataKey"]["keyHex"].as_str().unwrap()) },
            sessions: [(
                v["device"]["certId"].as_str().unwrap().to_string(),
                SessionEntry { key: Secret32(b32(v["envelope"]["sessionKeyHex"].as_str().unwrap())), device_id: cert["deviceId"].as_str().unwrap().into(), cert_sig: cert["sig"].as_str().unwrap().into() },
            )]
            .into_iter()
            .collect(),
            revocation_seq: list["seq"].as_u64().unwrap(),
            revoked_at_rotation: vec![],
            revocations: list.clone(),
        };
        LanAuth::new(v["store"]["storeKey"].as_str().unwrap().into(), v["store"]["storeId"].as_str().unwrap().into(), rec, Some(list))
    }

    /// 서버 판정 14건이 TS `verifyLanRequest` 와 같다.
    #[test]
    fn v2_server_verdicts_match_the_phone_vectors() {
        let v = vectors();
        let cases = v["verify"].as_array().unwrap();
        assert_eq!(cases.len(), 14);
        for c in cases {
            let a = vector_auth(&v, c["serverKeyVersion"].as_u64().unwrap());
            let seen_list: Vec<String> = c["seenNonces"].as_array().unwrap().iter().map(|x| x.as_str().unwrap().to_string()).collect();
            let seen = |cid: &str, n: &str| seen_list.contains(&format!("{cid}:{n}"));
            let push = c["dir"] == "push";
            let got = match verify_lan_request(&a, &c["request"], push, c["now"].as_i64().unwrap(), &seen) {
                Ok(_) => "ok",
                Err(r) => r,
            };
            assert_eq!(got, c["expect"].as_str().unwrap(), "{}", c["name"]);
        }
    }

    /// 서명 본문·정본 JSON·해시·signmessage 다이제스트가 폰과 같은 바이트이고, 벡터 서명이 기기 키로 확인된다.
    #[test]
    fn v2_request_signing_bytes_match_the_phone() {
        let v = vectors();
        for dir in ["push", "pull"] {
            let r = &v["requests"][dir];
            let w = &r["wire"];
            let (_, c) = crate::lan_cert::validate_cert_with(&w["cert"], true).unwrap();
            let fields = if dir == "push" {
                LanFields::Push { chunk_id: w["chunkId"].as_str().unwrap().into(), count: w["count"].as_u64().unwrap(), sealed: w["sealed"].clone() }
            } else {
                LanFields::Pull { cursor: w["cursor"].as_u64().unwrap() }
            };
            let body = Value::Object(request_sig_body(dir == "push", &c, w["keyVersion"].as_u64().unwrap(), w["nonce"].as_str().unwrap(), w["ts"].as_i64().unwrap(), &fields).unwrap());
            assert_eq!(body, r["sigBody"], "{dir}: 서명 본문");
            let canon = canonical_string(&body).unwrap();
            assert_eq!(canon, r["sigBodyCanonical"].as_str().unwrap(), "{dir}");
            let h = hex::encode(Sha256::digest(canon.as_bytes()));
            assert_eq!(h, r["bodySha256"].as_str().unwrap(), "{dir}");
            let msg = format!("{LAN_REQUEST_DOMAIN}\nsha256:{h}");
            assert_eq!(msg, r["message"].as_str().unwrap(), "{dir}");
            assert_eq!(hex::encode(crate::lan_cert::message_hash(&msg)), r["digestHex"].as_str().unwrap(), "{dir}");
            let mut signed = match body {
                Value::Object(m) => m,
                _ => unreachable!(),
            };
            signed.insert("sig".into(), w["sig"].clone());
            assert!(signed_by(LAN_REQUEST_DOMAIN, &signed, &c.device_pub_key), "{dir}: 기기 키 서명 확인");
            assert_eq!(kit::remote().pub_hex, c.device_pub_key, "표준 합성 remote = 벡터 기기 키(0x41)");
            assert!(!signed_by(LAN_REQUEST_DOMAIN, &signed, &kit::replica().pub_hex), "{dir}: 다른 키로는 아니다");
            // Rust 가 같은 합성 기기 키로 서명해도 같은 바이트(RFC6979).
            let again = kit::sign_wire(&w["cert"], &b32(v["device"]["devicePrivHex_TEST_ONLY"].as_str().unwrap()), 3, w["nonce"].as_str().unwrap(), w["ts"].as_i64().unwrap(), fields);
            assert_eq!(&again, w, "{dir}: 와이어 전체가 같은 바이트");
        }
    }

    /// 벡터 와이어를 실제 처리기에 넣는다: push 는 봉인 열쇠로 열려 조각 대조까지 통과(종류 'note' 는 레인 I 규칙으로 kind-scope),
    /// pull 은 200 + 그 기기 확인값 열쇠로 맞는 확인값 + 그 기기 봉인 열쇠로 열리는 조각.
    #[test]
    fn v2_vector_wire_runs_through_the_handler() {
        let v = vectors();
        let (st, _d) = kit::state_with("vecwire", vector_auth(&v, 3));
        let r = post(&st, true, &v["requests"]["push"]["wire"]);
        assert_eq!(reason(&r), (403, Some("kind-scope")), "봉인이 열리고 조각 번호·개수·출처까지 맞았다");
        assert_eq!(st.counters.kind_refused.load(Ordering::Relaxed), 1);
        let other = "77".repeat(16);
        let es: Vec<Value> = (0..7u8).map(|i| entry(&other, i)).collect();
        st.store.lock().unwrap().append_chunk(&"03".repeat(32), &other, &es).unwrap();
        let w = &v["requests"]["pull"]["wire"];
        let r = post(&st, false, w);
        assert_eq!(r.status, 200, "{}", r.body);
        let cert = &v["device"]["cert"];
        let b = ProofBinding { store_id: cert["storeId"].as_str().unwrap(), cert_id: v["device"]["certId"].as_str().unwrap(), device_id: cert["deviceId"].as_str().unwrap() };
        let pk = b32(v["lanKeys"]["proofKeyHex"].as_str().unwrap());
        let want = pull_proof_v2(&pk, 3, &b, w["nonce"].as_str().unwrap(), 5, r.body["next"].as_u64().unwrap(), false, r.body["chunkId"].as_str(), Some(&r.body["sealed"])).unwrap();
        assert!(proof_equals(&want, r.body["proof"].as_str().unwrap()));
        let seal = crate::lan_seal::DataKey { version: 3, key: b32(v["lanKeys"]["sealKeyHex"].as_str().unwrap()) };
        let cb = ChunkBinding { store_id: b.store_id, cert_id: b.cert_id, device_id: b.device_id, dir: "pull", chunk_id: r.body["chunkId"].as_str().unwrap(), from: 5 };
        assert_eq!(open_chunk(&r.body["sealed"], &seal, &cb).unwrap(), es[5..].to_vec());
        // 같은 와이어를 다시 보내면 재전송.
        assert_eq!(post(&st, false, w).body["reason"], "replay");
    }

    /// 변조 9종: 서명된 칸·서명 바이트를 바꾸면 모두 bad-request-sig, 아무것도 저장·기록하지 않는다.
    #[test]
    fn v2_any_tampered_field_breaks_the_request_signature() {
        let (st, d) = kit::state("tamper");
        let dev = kit::remote();
        let (good, _) = push_req(&dev, &[entry(&dev.device_id, 1)], &nonce(1));
        let pull = pull_req(&kit::replica(), 0, &nonce(2));
        let mut cases: Vec<(&str, bool, Value)> = Vec::new();
        let mut t = good.clone();
        t["count"] = json!(2);
        cases.push(("count", true, t));
        let mut t = good.clone();
        let ct = t["sealed"]["ct"].as_str().unwrap().to_string();
        t["sealed"]["ct"] = json!(format!("{}{}", if ct.starts_with('A') { "B" } else { "A" }, &ct[1..]));
        cases.push(("sealed", true, t));
        let mut t = good.clone();
        t["chunkId"] = json!("ab".repeat(32));
        cases.push(("chunkId", true, t));
        let mut t = good.clone();
        t["nonce"] = json!(nonce(99));
        cases.push(("nonce", true, t));
        let mut t = good.clone();
        t["ts"] = json!(NOW + 1);
        cases.push(("ts", true, t));
        let mut t = pull.clone();
        t["cursor"] = json!(1);
        cases.push(("cursor", false, t));
        // 서명 바이트 한 개 바꾸기
        use base64::{engine::general_purpose::STANDARD, Engine as _};
        let mut raw = STANDARD.decode(good["sig"].as_str().unwrap()).unwrap();
        raw[40] ^= 1;
        let mut t = good.clone();
        t["sig"] = json!(STANDARD.encode(&raw));
        cases.push(("sig-byte", true, t));
        // 같은 서명의 high-S 꼴(수학적으로는 유효) — low-S 만 받는다.
        let raw = STANDARD.decode(good["sig"].as_str().unwrap()).unwrap();
        let mut sig = secp256k1::ecdsa::Signature::from_compact(&raw[1..]).unwrap();
        sig.normalize_s();
        let n = num_order_minus(&sig.serialize_compact()[32..]);
        let mut hs = raw.clone();
        hs[33..].copy_from_slice(&n);
        hs[0] = 31 + ((raw[0] - 31) ^ 1);
        let mut t = good.clone();
        t["sig"] = json!(STANDARD.encode(&hs));
        cases.push(("high-s", true, t));
        // 비정본 base64(끝 비트만 다른 같은 바이트)
        let mut t = good.clone();
        let s = good["sig"].as_str().unwrap();
        let last = s.chars().nth(s.len() - 2).unwrap();
        let alt = if last == 'A' { 'B' } else { 'A' };
        let mut b = s.to_string();
        b.replace_range(s.len() - 2..s.len() - 1, &alt.to_string());
        t["sig"] = json!(b);
        cases.push(("sig-base64", true, t));
        assert!(cases.len() >= 7);
        for (name, push, req) in &cases {
            let r = post(&st, *push, req);
            assert_eq!(reason(&r), (403, Some("bad-request-sig")), "{name}");
        }
        assert_eq!(log_len(&d), 0, "변조 요청은 nonce 를 남기지 않는다");
        assert_eq!(st.store.lock().unwrap().len(), 0);
        // 열쇠 판 변조(벡터 tampered-keyVersion 과 같은 경우)도 서명에 묶여 있다.
        let mut t = pull.clone();
        t["keyVersion"] = json!(4);
        assert_eq!(post(&st, false, &t).body["reason"], "bad-request-sig");
        // 원본은 그대로 통과한다.
        assert_eq!(post(&st, true, &good).status, 200);
        assert_eq!(post(&st, false, &pull).status, 200);
    }
    /// secp256k1 차수 n − s (32바이트 빅엔디언).
    fn num_order_minus(s: &[u8]) -> [u8; 32] {
        let n: [u8; 32] = hex::decode("fffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141").unwrap().try_into().unwrap();
        let mut out = [0u8; 32];
        let mut borrow = 0i16;
        for i in (0..32).rev() {
            let mut d = n[i] as i16 - s[i] as i16 - borrow;
            borrow = if d < 0 { d += 256; 1 } else { 0 };
            out[i] = d as u8;
        }
        out
    }

    #[test]
    fn v2_the_time_window_is_five_minutes_either_way() {
        let (st, _d) = kit::state("window");
        let me = kit::replica();
        let at = |ts: i64, n: u32| kit::sign_wire(&me.cert, &me.sk, 3, &nonce(n), ts, LanFields::Pull { cursor: 0 });
        assert_eq!(post(&st, false, &at(NOW - LAN_REQUEST_WINDOW_MS, 1)).status, 200, "창 끝(과거)");
        assert_eq!(post(&st, false, &at(NOW + LAN_REQUEST_WINDOW_MS, 2)).status, 200, "창 끝(미래)");
        assert_eq!(reason(&post(&st, false, &at(NOW - LAN_REQUEST_WINDOW_MS - 1, 3))), (403, Some("request-time")));
        assert_eq!(reason(&post(&st, false, &at(NOW + LAN_REQUEST_WINDOW_MS + 1, 4))), (403, Some("request-time")));
        // 창 밖 요청은 nonce 를 쓰지 않는다 — 시계를 맞춘 뒤 같은 nonce 로 새 요청은 받는다.
        assert_eq!(post(&st, false, &at(NOW, 3)).status, 200);
    }

    /// 남의 증서를 붙이고 자기 키로 서명 → bad-request-sig. 데이터 열쇠·자기 세션을 가진 정상 기기라도 남의 이름으로 못 들어온다.
    #[test]
    fn v2_another_devices_cert_with_my_signature_is_refused() {
        let (st, d) = kit::state("impostor");
        let victim = kit::remote();
        let thief = kit::replica();
        let es = vec![entry(&victim.device_id, 1)];
        let ids: Vec<&str> = es.iter().map(|e| e["id"].as_str().unwrap()).collect();
        let chunk_id = chunk_id_of(&victim.device_id, &ids);
        // 도둑은 데이터 열쇠를 갖고 있어도 피해자의 세션 열쇠를 모른다 — 자기 세션으로 피해자 이름의 봉인을 만들어 본다.
        let fake_keys = crate::lan_keys::derive_lan_keys(&kit::data_key(3), &thief.session, &kit::store_id(), &victim.cert_id).unwrap();
        let bind = ChunkBinding { store_id: &kit::store_id(), cert_id: &victim.cert_id, device_id: &victim.device_id, dir: "push", chunk_id: &chunk_id, from: 0 };
        let sealed = seal_chunk(&es, &fake_keys.seal, &bind, &[1u8; 24]).unwrap();
        let w = kit::sign_wire(&victim.cert, &thief.sk, 3, &nonce(1), NOW, LanFields::Push { chunk_id: chunk_id.clone(), count: 1, sealed: sealed.clone() });
        assert_eq!(reason(&post(&st, true, &w)), (403, Some("bad-request-sig")));
        let p = kit::sign_wire(&victim.cert, &thief.sk, 3, &nonce(2), NOW, LanFields::Pull { cursor: 0 });
        assert_eq!(reason(&post(&st, false, &p)), (403, Some("bad-request-sig")));
        // 서명 없이(증서만 주워) — sig 칸 비움
        let mut nosig = w.clone();
        nosig["sig"] = json!("");
        assert_eq!(post(&st, true, &nosig).body["reason"], "bad-request-sig");
        assert_eq!(log_len(&d), 0);
        // 설령 서명 단계를 넘었다고 쳐도 봉인이 피해자 열쇠로 열리지 않는다(이중 방어).
        assert!(open_chunk(&sealed, &kit::keys_of(&victim, 3).seal, &bind).is_err());
    }

    /// 서버 사칭: 데이터 열쇠와 자기 세션 열쇠를 가진 기기(철회 전이라도)가 다른 기기에게 가짜 응답을 만들어도 그 기기의 확인값·봉인과 맞지 않는다.
    #[test]
    fn v2_a_device_holding_the_data_key_cannot_impersonate_the_server() {
        let (st, _d) = kit::state("serverfake");
        let victim = kit::replica();
        let thief = kit::remote();
        let other = "77".repeat(16);
        st.store.lock().unwrap().append_chunk(&"01".repeat(32), &other, &[entry(&other, 1)]).unwrap();
        let r = post(&st, false, &pull_req(&victim, 0, &nonce(1)));
        assert_eq!(r.status, 200);
        let sid = kit::store_id();
        let b = ProofBinding { store_id: &sid, cert_id: &victim.cert_id, device_id: &victim.device_id };
        let vk = kit::keys_of(&victim, 3);
        let real = pull_proof_v2(&vk.proof.key, 3, &b, &nonce(1), 0, 1, false, r.body["chunkId"].as_str(), Some(&r.body["sealed"])).unwrap();
        assert!(proof_equals(&real, r.body["proof"].as_str().unwrap()));
        // 도둑이 만들 수 있는 것들: (1) 자기 세션으로 뽑은 「피해자용」 열쇠 (2) 데이터 열쇠 그대로 (3) v1 확인값.
        let tk = crate::lan_keys::derive_lan_keys(&kit::data_key(3), &thief.session, &sid, &victim.cert_id).unwrap();
        let skip = (0u64, 999u64, false); // 가짜 커서 건너뛰기
        let fakes = [
            pull_proof_v2(&tk.proof.key, 3, &b, &nonce(1), skip.0, skip.1, skip.2, None, None).unwrap(),
            pull_proof_v2(&kit::data_key(3).key, 3, &b, &nonce(1), skip.0, skip.1, skip.2, None, None).unwrap(),
            crate::lan_proof::pull_proof(&kit::data_key(3).key, 3, &b, &nonce(1), skip.0, skip.1, skip.2, None, None).unwrap(),
        ];
        let expect = pull_proof_v2(&vk.proof.key, 3, &b, &nonce(1), skip.0, skip.1, skip.2, None, None).unwrap();
        for (i, f) in fakes.iter().enumerate() {
            assert!(!proof_equals(&expect, f), "가짜 확인값 {i} 가 피해자 확인값과 같다");
        }
        // 가짜 「저장됨」 push ACK 도 마찬가지.
        let bp = ProofBinding { store_id: &sid, cert_id: &victim.cert_id, device_id: &victim.device_id };
        let ack = push_proof_v2(&tk.proof.key, 3, &bp, &nonce(5), &"ab".repeat(32), 1).unwrap();
        assert!(!proof_equals(&push_proof_v2(&vk.proof.key, 3, &bp, &nonce(5), &"ab".repeat(32), 1).unwrap(), &ack));
        // 가짜 조각(도둑 열쇠로 봉인)은 피해자 봉인 열쇠로 열리지 않는다.
        let cb = ChunkBinding { store_id: &sid, cert_id: &victim.cert_id, device_id: &victim.device_id, dir: "pull", chunk_id: &"ab".repeat(32), from: 0 };
        let forged = seal_chunk(&[entry(&other, 9)], &tk.seal, &cb, &[2u8; 24]).unwrap();
        assert!(open_chunk(&forged, &vk.seal, &cb).is_err());
        let forged = seal_chunk(&[entry(&other, 9)], &kit::data_key(3), &cb, &[2u8; 24]).unwrap();
        assert!(open_chunk(&forged, &vk.seal, &cb).is_err());
    }

    /// 옛 열쇠: 회전 뒤(판 4) 옛 판으로 보낸 요청은 410, 새 판인데 세션이 없는(회전 때 빠진) 기기·증서 서명이 다른 기기도 410.
    #[test]
    fn v2_old_key_version_or_missing_session_is_410() {
        let rv = kit::revoked();
        let l = kit::list(2, &[&rv.cert_id]);
        let (st, d) = kit::state_with("oldkey", kit::auth(4, &kit::all(), &l));
        let me = kit::replica();
        assert_eq!(reason(&post(&st, false, &kit::pull_req_v(&me, 0, &nonce(1), 3))), (410, Some("key-version")));
        assert_eq!(post(&st, false, &kit::pull_req_v(&me, 0, &nonce(2), 4)).status, 200);
        // 세션 표에 없는 기기(새로 낸 증서인데 봉투를 아직 못 받음)
        let newbie = kit::dev(0x51, "replica", &["read", "replicate"], 9);
        assert_eq!(reason(&post(&st, false, &kit::pull_req_v(&newbie, 0, &nonce(3), 4))), (410, Some("key-version")));
        // 같은 certId(같은 일련번호)인데 다른 증서 문서 — 세션 표의 증서 서명과 다르다.
        let twin = kit::dev(0x52, "replica", &["read", "replicate"], me.cert["serial"].as_u64().unwrap());
        assert_eq!(twin.cert_id, me.cert_id);
        assert_eq!(reason(&post(&st, false, &kit::pull_req_v(&twin, 0, &nonce(4), 4))), (410, Some("key-version")));
        // 410 이전 단계까지 통과했지만 nonce 는 기록되지 않는다(열쇠 판·세션이 맞아야 기록).
        let logged = log_len(&d);
        let _ = post(&st, false, &kit::pull_req_v(&me, 0, &nonce(5), 3));
        assert_eq!(log_len(&d), logged);
    }

    /// 회전 관문: 회전 없이 철회만 된 목록이면 모든 요청(철회되지 않은 기기 포함)이 503, 본문도 보지 않는다. 회전하면 다시 열린다.
    #[test]
    fn v2_revocation_without_rotation_stops_all_sync() {
        let (st, d) = kit::state("gate");
        let rv = kit::remote();
        let me = kit::replica();
        assert_eq!(post(&st, false, &pull_req(&me, 0, &nonce(1))).status, 200);
        // 철회 목록만 바뀌었다(열쇠 기록은 seq 1·철회 없음 그대로).
        st.set_revocation(Some(kit::list(2, &[&rv.cert_id])));
        assert!(!st.auth().gate_ok());
        let before = log_len(&d);
        assert_eq!(reason(&post(&st, false, &pull_req(&me, 0, &nonce(2)))), (503, Some("rotation-required")));
        assert_eq!(reason(&post(&st, true, &push_req(&rv, &[entry(&rv.device_id, 1)], &nonce(3)).0)), (503, Some("rotation-required")));
        assert_eq!(reason(&handle_push(&st, b"not json")), (503, Some("rotation-required")), "본문을 읽기 전에 멈춘다");
        assert_eq!(log_len(&d), before);
        // 옛 목록(열쇠 기록보다 낮은 seq)으로 되감아도 닫힘.
        let l3 = kit::list(3, &[&rv.cert_id]);
        st.replace_auth(kit::auth(4, &kit::all(), &l3)).unwrap();
        assert!(st.auth().gate_ok());
        st.set_revocation(Some(kit::list(2, &[&rv.cert_id])));
        assert!(!st.auth().gate_ok(), "목록 seq < 회전 seq");
        // 회전 결과(판 4, 메타가 철회를 덮음)로 바꾸면 다시 열리고, 철회된 기기는 revoked.
        st.replace_auth(kit::auth(4, &kit::all(), &l3)).unwrap();
        assert_eq!(post(&st, false, &kit::pull_req_v(&me, 0, &nonce(4), 4)).status, 200);
        assert_eq!(reason(&post(&st, false, &kit::pull_req_v(&rv, 0, &nonce(5), 4))), (403, Some("revoked")));
        // 가지치기로 목록에서 빠진 id 는 관문을 막지 않는다(부분집합).
        st.set_revocation(Some(kit::list(4, &[])));
        assert!(st.auth().gate_ok());
    }

    /// 철회된 기기는 자기 키로 정확히 서명해도, 옛 열쇠·옛 세션을 쥐고 있어도 들어오지 못한다.
    #[test]
    fn v2_a_revoked_device_with_old_keys_gets_nothing() {
        let rv = kit::revoked();
        let l = kit::list(2, &[&rv.cert_id]);
        let (st, d) = kit::state_with("revokedold", kit::auth(4, &kit::all(), &l));
        // 옛 판(3)·옛 세션으로 정확히 서명·봉인한 push
        let (old_push, _) = push_req_v(&rv, &[entry(&rv.device_id, 1)], &nonce(1), 3);
        assert_eq!(reason(&post(&st, true, &old_push)), (403, Some("revoked")));
        // 새 판 번호를 붙여도(봉투를 못 받았으니 열쇠는 옛것)
        assert_eq!(reason(&post(&st, false, &kit::pull_req_v(&rv, 0, &nonce(2), 4))), (403, Some("revoked")));
        assert_eq!(log_len(&d), 0);
    }
}
