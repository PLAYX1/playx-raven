//! 체인 POS ③ — 본점으로 매출 보내기 + 합계 + 꺼짐 알림 (docs/CHAIN-POS.md).
//!
//! **매장 PC** (chain/store.json 이 있는 곳)
//! * 10분마다(그리고 「지금 보내기」) 본점이 마지막으로 받았다고 한 번호(ack) 다음 줄부터 매출 로그 줄을 묶어 보낸다.
//!   줄은 이미 매장 열쇠로 서명돼 있다(pos_pay). 묶음은 **데이터 열쇠**로 봉한다 — 터널·릴레이는 읽지 못한다.
//! * 본점 주소 = 매장 PC 의 설정 칸(`chain/head.json`). 모양만 본다(https 공개 이름 · http 는 사설 IPv4/`.local` 만).
//!   주소가 틀리거나 남의 서버여도 새는 것은 없다 — 봉한 묶음은 본점(체인 열쇠)만 열고, 가짜 「받았어요」는 봉함 확인에서 걸린다.
//!
//! **본점 PC** (chain/issued.json 이 있는 곳)
//! * `POST /lan/push/chain` (폰 서버 8790, 같은 와이파이 또는 터널). 터널로 와도 받는다 — 단 **올바른 매장 증서**가 있을 때만:
//!   본점 자신의 끊기 목록으로 판정(`verify_store_cert`) — 끊김·만료·모양·서명이 틀리면 거절하고 `chain/sales/rejects.jsonl` 에 적는다.
//! * 받은 줄은 `chain/sales/<매장>/<logId>/<YYYYMM>.jsonl`. `verify_records_from(줄, Some(증서 storeKey), 이어 받기)` 로 확인 —
//!   번호 건너뜀(gap)·고친 줄(prev)·서명 틀림은 **앞부분만 받고** 경고를 남긴다. 다시 보내도 같은 줄은 한 번만(ack = 끊김 없이 받은 마지막 번호).
//! * 합계는 본점이 줄에서 **직접** 센다(매장이 보낸 합계는 없다 — 받지도 않는다). 취소 줄은 음수라 그대로 빠진다.
//! * 꺼짐: 3번 연속(30분) 안 오면 「○○점 꺼짐」 + 사장 자신의 이야기 이름으로 **자기에게** 쪽지 1통(NIP-17). 다시 오면 지운다.
//!
//! **열쇠·암호** (새 크레이트 없음 — secp256k1·hkdf·chacha20poly1305 는 이미 쓴다)
//! * 데이터 열쇠 = HKDF-SHA256(salt `ravenvault-chain-sales-v1`, ikm = secp256k1 ECDH(매장 비밀, 본점 공개키) = ECDH(본점 비밀, 매장 공개키),
//!   info = `<본점 공개키>\n<매장 공개키>`). 매장마다 다르다. 봉함 = XChaCha20-Poly1305(무작위 24바이트 nonce), AAD = 머리 정본 JSON.
//! * 본점은 받을 때마다 12단어를 꺼낼 수 없다 → 매장 열쇠를 만들 때(그때는 체인 열쇠가 손에 있다) 그 매장의 데이터 열쇠만
//!   `chain/sales-keys.json`(0600)에 둔다. ③ 이전에 만든 매장은 「받을 준비」(12단어 한 번)로 채운다. 체인 열쇠 자체는 디스크에 두지 않는다.
//!
//! 🔴 열쇠·비밀은 오류·로그에 싣지 않는다(고정 코드만). 다 쓰면 지운다(DataKey Drop · words::wipe*).

use crate::chain_store as cs;
use crate::lan_cert::{is_public_key, CertReason};
use crate::lan_proof::canonical_string;
use crate::pos_pay::{record_hash, verify_records_from, METHODS};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use chacha20poly1305::aead::{Aead, KeyInit, Payload};
use chacha20poly1305::{XChaCha20Poly1305, XNonce};
use serde_json::{json, Map, Value};
use sha2::Digest;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

pub const SALES_PATH: &str = "/lan/push/chain";
pub const PUSH_EVERY_MS: i64 = 10 * 60_000;
pub const MISS_LIMIT: i64 = 3;
pub const MAX_BATCH_LINES: usize = 200;
pub const MAX_BATCH_BYTES: usize = 512 * 1024;
pub const MAX_REQUEST_BYTES: usize = 800 * 1024;
pub const DEFAULT_PORT: u16 = 8790;
/// 본점 답 상한(④ 되찾기·백업 조각이 실린다).
pub const MAX_REPLY_BYTES: usize = 1024 * 1024;
const KDF_SALT: &[u8] = b"ravenvault-chain-sales-v1";
const AAD_REQ: &str = "ravenvault-chain-sales-v1/req\n";
const AAD_RES: &str = "ravenvault-chain-sales-v1/res\n";
const ZERO: &str = "0000000000000000000000000000000000000000000000000000000000000000";
const MAX_ROUNDS: usize = 20;
const REJECTS_KEEP: usize = 200;

pub const ERR_LOCKED: &str = crate::storesign::ERR_LOCKED;
pub const ERR_HEAD_URL: &str = "본점 주소 모양이 맞지 않아요. 본점 화면에 보이는 주소(https://… 또는 http://192.168.…:8790)를 그대로 적어 주세요.";
pub const ERR_NOT_STORE: &str = "이 컴퓨터는 체인 매장이 아니에요.";
pub const ERR_NOT_OWNER: &str = "이 컴퓨터는 본점이 아니에요.";
pub const ERR_SAVE: &str = "이 컴퓨터에 저장하지 못했어요. 디스크 공간과 권한을 확인해 주세요.";
pub const ERR_KEY: &str = "매출을 봉할 열쇠를 만들지 못했어요. 본점에 연락해 주세요.";

fn now_ms() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_millis() as i64)
}

fn read_json(p: &Path) -> Option<Value> {
    serde_json::from_slice(&std::fs::read(p).ok()?).ok()
}
fn write_json(p: &Path, v: &Value) -> Result<(), &'static str> {
    if let Some(d) = p.parent() {
        std::fs::create_dir_all(d).map_err(|_| ERR_SAVE)?;
    }
    let bytes = serde_json::to_vec_pretty(v).map_err(|_| ERR_SAVE)?;
    crate::server::atomic_write_0600(p, &bytes).map_err(|_| ERR_SAVE)
}
fn is_hex(s: &str, n: usize) -> bool {
    s.len() == n && s.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
fn month_of(at_ms: i64) -> u32 {
    (crate::ledger::local_ymd(at_ms.div_euclid(1000), 0) / 100) as u32
}

// ── 데이터 열쇠 · 봉함 ─────────────────────────────────────────────

/// 32바이트 데이터 열쇠. 떨어질 때 지운다.
pub struct DataKey([u8; 32]);
impl Drop for DataKey {
    fn drop(&mut self) {
        crate::words::wipe_bytes(&mut self.0);
    }
}

/// HKDF-SHA256(salt, ikm, info) → 32바이트 열쇠(④ 백업 열쇠 = 체인 비밀에서).
pub(crate) fn hkdf_key(salt: &[u8], ikm: &[u8], info: &[u8]) -> Option<DataKey> {
    let hk = hkdf::Hkdf::<sha2::Sha256>::new(Some(salt), ikm);
    let mut out = [0u8; 32];
    let ok = hk.expand(info, &mut out).is_ok();
    let key = DataKey(out);
    crate::words::wipe_bytes(&mut out);
    ok.then_some(key)
}
/// 열쇠 ↔ 16진 글자(0600 파일에 둘 때만 — 부르는 쪽이 글자를 지운다).
pub(crate) fn key_hex(k: &DataKey) -> String {
    hex::encode(k.0)
}
pub(crate) fn key_from_hex(s: &str) -> Option<DataKey> {
    let mut raw = hex::decode(s).ok()?;
    let arr: Option<[u8; 32]> = raw.as_slice().try_into().ok();
    crate::words::wipe_bytes(&mut raw);
    arr.map(DataKey)
}

/// ECDH(내 비밀, 상대 공개키) → HKDF. 매장은 (매장 비밀, 본점 공개키), 본점은 (본점 비밀, 매장 공개키) — 같은 값이 나온다.
pub fn data_key(my_sk: &[u8; 32], peer_pub: &str, chain: &str, store_key: &str) -> Option<DataKey> {
    if !is_public_key(chain) || !is_public_key(store_key) {
        return None;
    }
    derive_key(KDF_SALT, my_sk, peer_pub, format!("{chain}\n{store_key}").as_bytes())
}

/// secp256k1 ECDH(내 비밀, 상대 공개키) → HKDF-SHA256(salt, info). 쓰임마다 salt 를 다르게(③ 매출 · ④ 백업).
fn derive_key(salt: &[u8], my_sk: &[u8; 32], peer_pub: &str, info: &[u8]) -> Option<DataKey> {
    if !is_public_key(peer_pub) {
        return None;
    }
    let pk = secp256k1::PublicKey::from_slice(&hex::decode(peer_pub).ok()?).ok()?;
    let mut sk = secp256k1::SecretKey::from_byte_array(my_sk).ok()?;
    let shared = secp256k1::ecdh::SharedSecret::new(&pk, &sk);
    sk.non_secure_erase();
    let mut ikm = shared.secret_bytes();
    let hk = hkdf::Hkdf::<sha2::Sha256>::new(Some(salt), &ikm);
    crate::words::wipe_bytes(&mut ikm);
    let mut out = [0u8; 32];
    let ok = hk.expand(info, &mut out).is_ok();
    let key = DataKey(out);
    crate::words::wipe_bytes(&mut out);
    ok.then_some(key)
}

/// 봉함(바이트): nonce 24 + 암호문.
pub(crate) fn seal_raw(key: &DataKey, aad: &[u8], plain: &[u8]) -> Option<Vec<u8>> {
    use rand::RngCore;
    let mut nonce = [0u8; 24];
    rand::rngs::OsRng.fill_bytes(&mut nonce);
    let ct = XChaCha20Poly1305::new((&key.0).into()).encrypt(XNonce::from_slice(&nonce), Payload { msg: plain, aad }).ok()?;
    let mut all = Vec::with_capacity(24 + ct.len());
    all.extend_from_slice(&nonce);
    all.extend_from_slice(&ct);
    Some(all)
}

pub(crate) fn open_raw(key: &DataKey, aad: &[u8], raw: &[u8]) -> Option<Vec<u8>> {
    if raw.len() < 24 + 16 {
        return None;
    }
    XChaCha20Poly1305::new((&key.0).into()).decrypt(XNonce::from_slice(&raw[..24]), Payload { msg: &raw[24..], aad }).ok()
}

fn seal(key: &DataKey, aad: &[u8], plain: &[u8]) -> Option<String> {
    seal_raw(key, aad, plain).map(|b| URL_SAFE_NO_PAD.encode(b))
}

fn open(key: &DataKey, aad: &[u8], text: &str) -> Option<Vec<u8>> {
    open_raw(key, aad, &URL_SAFE_NO_PAD.decode(text).ok()?)
}

const HEADER_KEYS: [&str; 9] = ["v", "chain", "store", "serial", "logId", "from", "count", "sentAt", "nonce"];

fn aad_of(prefix: &str, v: &Value) -> Vec<u8> {
    let mut a = prefix.as_bytes().to_vec();
    a.extend_from_slice(canonical_string(v).unwrap_or_default().as_bytes());
    a
}

// ── 본점: 데이터 열쇠 보관 (chain/sales-keys.json) ──────────────────

fn keys_file(dir: &Path) -> PathBuf {
    dir.join("sales-keys.json")
}

/// 본점: 체인 열쇠가 손에 있을 때(매장 열쇠 만들기·받을 준비) 그 매장의 데이터 열쇠를 적어 둔다.
pub fn remember_key_in(dir: &Path, chain_sk: &[u8; 32], store_pub: &str) -> Result<(), &'static str> {
    let chain = cs::pubkey(chain_sk).map_err(|_| ERR_KEY)?;
    let k = data_key(chain_sk, store_pub, &chain, store_pub).ok_or(ERR_KEY)?;
    let mut all = read_json(&keys_file(dir)).filter(|v| v.get("chain").and_then(Value::as_str) == Some(chain.as_str()))
        .unwrap_or_else(|| json!({ "v": 1, "chain": chain, "keys": {} }));
    let mut hexk = hex::encode(k.0);
    if !all["keys"].is_object() {
        all["keys"] = json!({});
    }
    all["keys"][store_pub] = json!(hexk);
    crate::words::wipe(&mut hexk);
    let r = write_json(&keys_file(dir), &all);
    wipe_json_strings(&mut all);
    r
}

fn wipe_json_strings(v: &mut Value) {
    if let Some(o) = v.get_mut("keys").and_then(Value::as_object_mut) {
        for (_, s) in o.iter_mut() {
            if let Value::String(s) = s {
                crate::words::wipe(s);
            }
        }
    }
}

fn load_key(dir: &Path, chain: &str, store_key: &str) -> Option<DataKey> {
    let mut all = read_json(&keys_file(dir))?;
    let out = (|| {
        if all.get("chain").and_then(Value::as_str) != Some(chain) {
            return None;
        }
        let raw = hex::decode(all.pointer(&format!("/keys/{store_key}"))?.as_str()?).ok()?;
        let arr: [u8; 32] = raw.as_slice().try_into().ok()?;
        let mut raw = raw;
        crate::words::wipe_bytes(&mut raw);
        Some(DataKey(arr))
    })();
    wipe_json_strings(&mut all);
    out
}

/// 데이터 열쇠가 아직 없는(끊기지 않은) 매장 공개키들.
fn missing_keys(dir: &Path) -> Vec<String> {
    let Some((chain, certs)) = cs::load_history(dir) else { return Vec::new() };
    let have: Vec<String> = read_json(&keys_file(dir))
        .filter(|v| v.get("chain").and_then(Value::as_str) == Some(chain.as_str()))
        .and_then(|v| v.get("keys").and_then(Value::as_object).map(|o| o.keys().cloned().collect()))
        .unwrap_or_default();
    let burned = cs::burned_keys(dir);
    let mut out: Vec<String> = certs.iter().filter_map(|c| c.get("storeKey").and_then(Value::as_str).map(String::from))
        .filter(|k| !have.contains(k) && !burned.contains(k)).collect();
    out.sort();
    out.dedup();
    out
}

// ── 꺼짐 알림 (순수 상태 기계) ───────────────────────────────────────

/// 매장 하나의 꺼짐 상태. `seen` = 올바른 push 를 받음, `tick` = 시계가 흐름.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Watch {
    pub last_seen: Option<i64>,
    pub alerted: bool,
}
impl Watch {
    /// push 를 받았다. 돌려주는 값 = 꺼져 있다가 돌아왔는가(알림 지우기).
    pub fn seen(&mut self, now: i64) -> bool {
        let back = self.alerted;
        self.last_seen = Some(self.last_seen.map_or(now, |t| t.max(now)));
        self.alerted = false;
        back
    }
    /// 놓친 창 수(10분 단위).
    pub fn misses(&self, now: i64) -> i64 {
        self.last_seen.map_or(0, |t| (now - t).max(0) / PUSH_EVERY_MS)
    }
    /// 돌려주는 값 = 지금 막 꺼짐으로 바뀌었는가(이번 끊김에 한 번만 true).
    pub fn tick(&mut self, now: i64) -> bool {
        if self.alerted || self.last_seen.is_none() || self.misses(now) < MISS_LIMIT {
            return false;
        }
        self.alerted = true;
        true
    }
}

// ── 본점: 받기 ───────────────────────────────────────────────────────

fn sales_dir(dir: &Path) -> PathBuf {
    dir.join("sales")
}
fn store_dir(dir: &Path, n: u32) -> PathBuf {
    sales_dir(dir).join(n.to_string())
}

/// 본점이 매장마다 들고 있는 상태(`chain/sales/<n>/state.json`).
fn load_state(dir: &Path, n: u32) -> Value {
    read_json(&store_dir(dir, n).join("state.json")).filter(Value::is_object).unwrap_or_else(|| json!({ "v": 1, "logs": {} }))
}
fn watch_of(st: &Value) -> Watch {
    Watch { last_seen: st.get("lastSeen").and_then(Value::as_i64), alerted: st.get("alerted").and_then(Value::as_bool).unwrap_or(false) }
}
fn put_watch(st: &mut Value, w: Watch) {
    st["lastSeen"] = json!(w.last_seen);
    st["alerted"] = json!(w.alerted);
}

static RECEIVE: Mutex<()> = Mutex::new(());
/// 프로그램 사이 잠금(`chain/sales/.lock`) — 레이븐볼트가 두 번 켜져도 받기·꺼짐 확인이 같은 state.json 을 겹쳐 쓰지 않게.
/// 받기 한 번은 짧으니 잠깐 기다린다. 못 잡으면 503 busy(매장은 다음 순번에 다시 보낸다).
#[cfg(not(test))]
const OS_LOCK_WAIT_MS: u64 = 2_000;
#[cfg(test)]
const OS_LOCK_WAIT_MS: u64 = 50;
fn receive_os_lock(dir: &Path) -> Option<std::fs::File> {
    crate::pos_pay::os_lock_wait(&sales_dir(dir).join(".lock"), OS_LOCK_WAIT_MS)
}

/// 받기와 겹치지 않게(같은 프로그램·다른 프로그램 모두) `f` 를 돌린다 — ④ 백업 묶기가 반쯤 쓴 줄을 담지 않게.
pub(crate) fn with_receive_lock<R>(dir: &Path, f: impl FnOnce() -> R) -> Option<R> {
    let _g = RECEIVE.lock().unwrap_or_else(|e| e.into_inner());
    let _os = receive_os_lock(dir)?;
    Some(f())
}

/// 1분 창 버킷(열쇠 → (창 시작, 횟수)). 열쇠 수는 상한이 있다 — 넘치면 낯선 열쇠는 「overflow」 한 칸을 같이 쓴다.
struct Buckets {
    map: std::collections::HashMap<String, (i64, u32)>,
}
static PRE: Mutex<Option<Buckets>> = Mutex::new(None);
static POST: Mutex<Option<Buckets>> = Mutex::new(None);
const BUCKET_KEYS: usize = 256;

fn bucket_key(b: &mut Buckets, key: &str, now: i64) -> String {
    if b.map.contains_key(key) || b.map.len() < BUCKET_KEYS {
        return key.to_string();
    }
    b.map.retain(|_, (t, _)| now - *t < 60_000 && now >= *t);
    if b.map.len() < BUCKET_KEYS { key.to_string() } else { "overflow".into() }
}
/// 지금 창의 횟수(늘리지 않음).
fn bucket_count(m: &Mutex<Option<Buckets>>, key: &str, now: i64) -> u32 {
    let mut g = m.lock().unwrap_or_else(|e| e.into_inner());
    let b = g.get_or_insert_with(|| Buckets { map: Default::default() });
    let k = bucket_key(b, key, now);
    match b.map.get(&k) {
        Some((t, n)) if now - *t < 60_000 && now >= *t => *n,
        _ => 0,
    }
}
/// 하나 늘리고 늘린 뒤의 횟수.
fn bucket_hit(m: &Mutex<Option<Buckets>>, key: &str, now: i64) -> u32 {
    let mut g = m.lock().unwrap_or_else(|e| e.into_inner());
    let b = g.get_or_insert_with(|| Buckets { map: Default::default() });
    let k = bucket_key(b, key, now);
    let e = b.map.entry(k).or_insert((now, 0));
    if now - e.0 >= 60_000 || now < e.0 {
        *e = (now, 0);
    }
    e.1 += 1;
    e.1
}

/// 인증 전 거절 셈(줄로 남기지 않는다 — 쓰레기 요청이 거절 기록 창(20줄)의 고친 흔적을 밀어내지 못하게).
static JUNK: Mutex<Option<(PathBuf, Map<String, Value>, i64)>> = Mutex::new(None);
fn junk_file(dir: &Path) -> PathBuf {
    sales_dir(dir).join("junk.json")
}
fn count_junk(dir: &Path, why: &str, now: i64) {
    let mut g = JUNK.lock().unwrap_or_else(|e| e.into_inner());
    if g.as_ref().is_none_or(|(d, _, _)| d != dir) {
        let c = read_json(&junk_file(dir)).and_then(|v| v.get("counts").and_then(Value::as_object).cloned()).unwrap_or_default();
        *g = Some((dir.to_path_buf(), c, 0));
    }
    let Some((_, counts, saved)) = g.as_mut() else { return };
    let n = counts.get(why).and_then(Value::as_u64).unwrap_or(0) + 1;
    counts.insert(why.into(), json!(n));
    if now - *saved >= 60_000 || now < *saved || cfg!(test) {
        *saved = now;
        let _ = write_json(&junk_file(dir), &json!({ "v": 1, "counts": counts, "lastAt": now }));
    }
}
fn junk_counts(dir: &Path) -> Value {
    if let Some((d, c, _)) = JUNK.lock().unwrap_or_else(|e| e.into_inner()).as_ref() {
        if d == dir {
            return Value::Object(c.clone());
        }
    }
    read_json(&junk_file(dir)).and_then(|v| v.get("counts").cloned()).unwrap_or_else(|| json!({}))
}

/// 거절 기록(비밀 없음 — 매장 번호·serial·사유 코드·시각만). 증서 서명이 맞은 뒤의 거절만 적는다.
/// 같은 (serial, 사유)는 한 시간에 한 줄 — 주운 증서를 되풀이해 보내도 기록이 불어나지 않는다. 오래된 것은 버린다.
fn log_reject(dir: &Path, store: Option<u64>, serial: Option<u64>, why: &str, now: i64) {
    let p = sales_dir(dir).join("rejects.jsonl");
    let recent = rejects(dir, 40).iter().any(|r| r["serial"].as_u64() == serial && r["why"].as_str() == Some(why)
        && r["at"].as_i64().is_some_and(|t| now >= t && now - t < 3_600_000));
    if recent {
        return;
    }
    let _ = std::fs::create_dir_all(sales_dir(dir));
    let line = json!({ "at": now, "store": store, "serial": serial, "why": why }).to_string();
    let mut oo = std::fs::OpenOptions::new();
    oo.append(true).create(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        oo.mode(0o600);
    }
    if let Ok(mut f) = oo.open(&p) {
        let _ = f.write_all(format!("{line}\n").as_bytes());
    }
    if let Ok(text) = std::fs::read_to_string(&p) {
        let lines: Vec<&str> = text.lines().collect();
        if lines.len() > REJECTS_KEEP * 2 {
            let keep = lines[lines.len() - REJECTS_KEEP..].join("\n") + "\n";
            let _ = crate::server::atomic_write_0600(&p, keep.as_bytes());
        }
    }
}

fn rejects(dir: &Path, limit: usize) -> Vec<Value> {
    let text = std::fs::read_to_string(sales_dir(dir).join("rejects.jsonl")).unwrap_or_default();
    let mut v: Vec<Value> = text.lines().filter_map(|l| serde_json::from_str(l).ok()).collect();
    v.reverse();
    v.truncate(limit);
    v
}

fn deny(code: u16, why: &str) -> (u16, Value) {
    (code, json!({ "reason": why }))
}

fn append_lines(dir: &Path, month: u32, lines: &[&Value]) -> std::io::Result<()> {
    std::fs::create_dir_all(dir)?;
    let mut oo = std::fs::OpenOptions::new();
    oo.append(true).create(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        oo.mode(0o600);
    }
    let mut f = oo.open(dir.join(format!("{month:06}.jsonl")))?;
    let mut buf = Vec::new();
    for l in lines {
        buf.extend_from_slice(canonical_string(l).map_err(|_| std::io::Error::other("json"))?.as_bytes());
        buf.push(b'\n');
    }
    f.write_all(&buf)?;
    f.sync_data()
}

/// 로그마다의 취소 판정표(`<logId>/index.json`): 매출 seq → (금액, 수단), 취소된 seq, 받지 않을(합계에서 뺄) 취소 줄.
fn load_index(ldir: &Path) -> Value {
    read_json(&ldir.join("index.json")).filter(Value::is_object).unwrap_or_else(|| json!({ "sales": {}, "voided": [], "badVoids": [] }))
}

/// 취소 줄이 맞는가: 같은 로그의 매출을 가리키고, 수단이 같고, |금액| ≤ 그 매출, 한 번만.
fn check_void(idx: &mut Value, l: &Value) -> bool {
    let seq = l.get("seq").and_then(Value::as_u64).unwrap_or(0);
    match l.get("kind").and_then(Value::as_str) {
        Some("sale") => {
            idx["sales"][seq.to_string()] = json!([l.get("amount"), l.get("method")]);
            true
        }
        Some("void") => {
            let r = l.get("ref").and_then(Value::as_u64).unwrap_or(u64::MAX);
            let sale = idx["sales"].get(r.to_string()).cloned();
            let amt = l.get("amount").and_then(Value::as_i64).unwrap_or(0);
            let already = idx["voided"].as_array().is_some_and(|a| a.iter().any(|x| x.as_u64() == Some(r)));
            let ok = sale.is_some_and(|s| s[0].as_i64().is_some_and(|a| amt.unsigned_abs() <= a.unsigned_abs()) && s[1] == l["method"]) && !already;
            if ok {
                if let Some(a) = idx["voided"].as_array_mut() {
                    a.push(json!(r));
                }
            } else if let Some(a) = idx["badVoids"].as_array_mut() {
                a.push(json!(seq));
            }
            ok
        }
        _ => true,
    }
}

pub const MAX_LOGS_PER_STORE: usize = 8;
pub const SENT_AT_WINDOW_MS: i64 = 3_600_000;
const PRE_PER_MIN: u32 = 60;
const POST_PER_MIN: u32 = 30;

/// `POST /lan/push/chain` 본문 하나를 처리한다 → (상태 코드, 응답 JSON).
/// `client` = 요청한 곳(터널이면 cf-connecting-ip, 아니면 "lan") — 인증 전 거절 버킷 열쇠.
/// 🔴 증서 서명이 맞기 전의 실패는 모두 404 not-head — 본점 PC 인지 알려 주지 않는다.
pub fn receive_in(dir: &Path, body: &[u8], now: i64, client: &str) -> (u16, Value) {
    let not_head = || deny(404, "not-head");
    if !dir.join("issued.json").exists() {
        return not_head();
    }
    let pre_key = format!("{}|{client}", dir.display());
    // 인증 전 버킷은 **실패만** 센다 — 올바른 매장의 요청은 이 버킷을 줄이지 않는다.
    if bucket_count(&PRE, &pre_key, now) >= PRE_PER_MIN {
        count_junk(dir, "rate", now);
        return not_head();
    }
    let junk = |why: &str| {
        bucket_hit(&PRE, &pre_key, now);
        count_junk(dir, why, now);
        not_head()
    };
    if body.len() > MAX_REQUEST_BYTES {
        return junk("too-big");
    }
    let Some(req) = serde_json::from_slice::<Value>(body).ok().and_then(|v| v.as_object().cloned()) else { return junk("shape") };
    let want: Vec<&str> = HEADER_KEYS.iter().copied().chain(["cert", "box"]).collect();
    if req.len() != want.len() || !want.iter().all(|k| req.contains_key(*k)) || req["v"].as_u64() != Some(1) {
        return junk("shape");
    }
    let Some((chain, certs)) = cs::load_history(dir) else { return not_head() };
    let store_hdr = req["store"].as_u64();
    let serial_hdr = req["serial"].as_u64();
    if req["chain"].as_str() != Some(chain.as_str()) {
        return junk("other-chain");
    }
    // 판정은 본점 자신의 끊기 목록으로(신선도 문제 없음).
    let list = cs::load_list(dir, &chain).map(|(v, _)| v);
    let c = match cs::verify_store_cert(&req["cert"], &chain, now, list.as_ref()) {
        Ok(c) => c,
        Err(r @ (CertReason::BadClock | CertReason::Shape | CertReason::Signature)) => return junk(r.as_str()),
        Err(r) => {
            // 서명은 맞았다(진짜 증서) — 끊김·만료는 거절 기록에 남긴다(같은 serial·사유는 한 시간에 한 줄).
            bucket_hit(&PRE, &pre_key, now);
            log_reject(dir, store_hdr, serial_hdr, r.as_str(), now);
            return deny(403, r.as_str());
        }
    };
    let issued = certs.iter().any(|x| x.get("serial").and_then(Value::as_u64) == Some(c.serial) && x.get("storeKey").and_then(Value::as_str) == Some(c.store_key.as_str()));
    if !issued || store_hdr != Some(c.store as u64) || serial_hdr != Some(c.serial) {
        bucket_hit(&PRE, &pre_key, now);
        log_reject(dir, Some(c.store as u64), Some(c.serial), "unknown-cert", now);
        return deny(403, "unknown-cert");
    }
    let log_id = req["logId"].as_str().unwrap_or("");
    let nonce = req["nonce"].as_str().unwrap_or("");
    let (Some(from), Some(count), Some(sent_at)) = (req["from"].as_u64(), req["count"].as_u64(), req["sentAt"].as_i64()) else { return junk("shape") };
    // count 0 = 살아 있다는 신호(보낼 줄이 없을 때도 10분마다 온다 — 조용한 가게가 「꺼짐」으로 보이지 않게).
    if !is_hex(log_id, 32) || !is_hex(nonce, 32) || count as usize > MAX_BATCH_LINES {
        return junk("shape");
    }
    let Some(key) = load_key(dir, &chain, &c.store_key) else { return deny(503, "need-prepare") };
    let header: Map<String, Value> = HEADER_KEYS.iter().map(|k| (k.to_string(), req[*k].clone())).collect();
    let header = Value::Object(header);
    let plain = req["box"].as_str().and_then(|b| open(&key, &aad_of(AAD_REQ, &header), b));
    // 증서는 선 위에 평문이라 주울 수 있다 — 진짜 인증은 봉함이 열리는 것. 못 열면 쓰레기로 센다(기록 줄 없음).
    let Some(plain) = plain else {
        bucket_hit(&PRE, &pre_key, now);
        count_junk(dir, "bad-box", now);
        return deny(400, "bad-box");
    };
    // 인증 뒤 버킷: 매장(serial)마다 1분 30번.
    if bucket_hit(&POST, &format!("{}|{}", dir.display(), c.serial), now) > POST_PER_MIN {
        return deny(429, "rate");
    }
    // 봉함 안 = 줄 배열(③ 보내기) 또는 {op:…}(④ 되찾기·백업 조각 · ⑤ 이웃 — 줄 없이 count 0).
    let (lines, op): (Vec<Value>, Option<Map<String, Value>>) = match serde_json::from_slice::<Value>(&plain) {
        Ok(Value::Array(a)) if a.len() as u64 == count && (count == 0 || a.first().and_then(|l| l.get("seq")).and_then(Value::as_u64) == Some(from)) => (a, None),
        Ok(Value::Object(o)) if count == 0 && o.get("op").and_then(Value::as_str).is_some() => (Vec::new(), Some(o)),
        _ => return deny(400, "shape"),
    };

    let _g = RECEIVE.lock().unwrap_or_else(|e| e.into_inner());
    let Some(_os) = receive_os_lock(dir) else { return deny(503, "busy") };
    let sdir = store_dir(dir, c.store);
    let mut st = load_state(dir, c.store);
    // 되풀이 막기: 봉함 머리의 sentAt 은 매장마다 늘기만 해야 하고, 본점 시계와 한 시간 안이어야 한다.
    // (주운 신호를 다시 보내 꺼진 매장을 살아 있는 척하게 하는 길을 막는다.) 꺼짐 판정(seen) 전에 본다.
    if (now - sent_at).abs() > SENT_AT_WINDOW_MS {
        return deny(400, "bad-clock");
    }
    if st.get("lastSentAt").and_then(Value::as_i64).is_some_and(|l| sent_at <= l) {
        return deny(409, "replay");
    }
    let entry = st.pointer(&format!("/logs/{log_id}")).cloned();
    if entry.is_none() && count > 0 && st["logs"].as_object().is_some_and(|o| o.len() >= MAX_LOGS_PER_STORE) {
        log_reject(dir, Some(c.store as u64), Some(c.serial), "too-many-logs", now);
        return deny(409, "too-many-logs");
    }
    // 다음 번호 = 받은 마지막 줄 다음(`resume` 줄이면 건너뛴 번호 뒤 · pos_pay::next_after).
    let last_ack = entry.as_ref().and_then(|e| e["ack"].as_u64());
    let (next, prev) = match &entry {
        Some(e) => (e["next"].as_u64().or(last_ack.map(|a| a + 1)).unwrap_or(0), e["hash"].as_str().unwrap_or(ZERO).to_string()),
        None => (0, ZERO.to_string()),
    };
    let mut warn: Option<(u64, String)> = None;
    // 이미 받은 줄은 건너뛴다(다시 보내도 한 번만). 받은 마지막 줄이 다르게 오면 고친 흔적.
    if let Some(a) = last_ack {
        if let Some(l) = lines.iter().find(|l| l.get("seq").and_then(Value::as_u64) == Some(a)) {
            if record_hash(l).as_deref() != Some(prev.as_str()) {
                warn = Some((next - 1, "prev".into()));
            }
        }
    }
    let fresh: Vec<Value> = lines.into_iter().filter(|l| l.get("seq").and_then(Value::as_u64).is_none_or(|s| s >= next)).collect();
    let mut good: usize = 0;
    if let Some(first) = fresh.first() {
        let fseq = first.get("seq").and_then(Value::as_u64).unwrap_or(u64::MAX);
        if fseq > next {
            warn = Some((next, "gap".into()));
        } else {
            let check = verify_records_from(&fresh, Some(&c.store_key), Some((next, &prev)));
            good = check.ok_prefix;
            // 뜻 확인: 0번은 이 본점·이 매장의 시작 줄, 그 뒤엔 시작 줄 없음, 매출·취소 줄의 매장 번호 = 증서.
            for (i, l) in fresh[..good].iter().enumerate() {
                let kind = l.get("kind").and_then(Value::as_str).unwrap_or("");
                let seq = l.get("seq").and_then(Value::as_u64).unwrap_or(0);
                let ok = if seq == 0 {
                    kind == "open" && l.get("chain").and_then(Value::as_str) == Some(chain.as_str())
                        && l.get("store").and_then(Value::as_u64) == Some(c.store as u64) && l.get("logId").and_then(Value::as_str) == Some(log_id)
                } else {
                    kind != "open" && l.get("store").and_then(Value::as_u64) == Some(c.store as u64)
                };
                if !ok {
                    good = i;
                    warn = Some((seq, "shape".into()));
                    break;
                }
            }
            if good < fresh.len() && warn.is_none() {
                let (s, b) = check.broken.clone().unwrap_or((0, crate::pos_pay::Break::Shape));
                warn = Some((s, b.code().into()));
            }
        }
    }
    let mut ack = entry.as_ref().and_then(|e| e["ack"].as_u64());
    if good > 0 {
        let take = &fresh[..good];
        let mut month = entry.as_ref().and_then(|e| e["month"].as_u64()).unwrap_or(0) as u32;
        // 먼 미래 시각(`at`)이 여섯 자리가 아닌 파일 이름(→ 영영 안 읽힘)을 만들지 못하게 본점 시계 + 2일로 자른다.
        let cap = month_of(now + 2 * 86_400_000);
        let ldir = sdir.join(log_id);
        let mut idx = load_index(&ldir);
        // 줄마다 달(파일)을 정한다 — 시계가 뒤로 가도 파일 순서는 뒤로 가지 않는다.
        let mut groups: Vec<(u32, Vec<&Value>)> = Vec::new();
        for l in take {
            month = month.max(month_of(l.get("at").and_then(Value::as_i64).unwrap_or(0)).min(cap));
            if !check_void(&mut idx, l) && warn.is_none() {
                warn = Some((l.get("seq").and_then(Value::as_u64).unwrap_or(0), "void".into()));
            }
            match groups.last_mut() {
                Some((m, g)) if *m == month => g.push(l),
                _ => groups.push((month, vec![l])),
            }
        }
        for (m, g) in &groups {
            if append_lines(&ldir, *m, g).is_err() {
                return deny(500, "save");
            }
        }
        if write_json(&ldir.join("index.json"), &idx).is_err() {
            return deny(500, "save");
        }
        let last = take.last().unwrap_or(&Value::Null);
        ack = last.get("seq").and_then(Value::as_u64);
        if !st["logs"].is_object() {
            st["logs"] = json!({});
        }
        st["logs"][log_id] = json!({ "ack": ack, "next": crate::pos_pay::next_after(last), "hash": record_hash(last), "month": month, "key": c.store_key, "at": now });
    }
    if let Some((s, why)) = &warn {
        st["warn"] = json!({ "logId": log_id, "at": s, "why": why, "when": now });
        log_reject(dir, Some(c.store as u64), Some(c.serial), &format!("lines-{why}"), now);
    } else if st.pointer("/warn/why").and_then(Value::as_str) == Some("gap") && good > 0 {
        // 건너뜀은 매장이 다시 보내면 풀린다. 고친 흔적(prev·signature·shape·void)은 사장이 볼 때까지 남긴다.
        st["warn"] = Value::Null;
    }
    st["lastSentAt"] = json!(sent_at);
    let mut w = watch_of(&st);
    w.seen(now);
    put_watch(&mut st, w);
    st["dmSent"] = json!(false);
    st["serial"] = json!(c.serial);
    if write_json(&sdir.join("state.json"), &st).is_err() {
        return deny(500, "save");
    }
    let mut inner = json!({ "logId": log_id, "ack": ack, "warn": warn.as_ref().map(|w| json!({ "at": w.0, "why": w.1 })) });
    if let Some(o) = op {
        // 일 답에는 그 일의 답만(끊기 목록·요약을 싣지 않는다) — 답 크기 상한(MAX_REPLY_BYTES)을 지키려고.
        inner["op"] = handle_op(dir, &c, &o, now);
    } else {
        inner["revocations"] = list.unwrap_or(Value::Null);
        // ④ 맡는 매장에게만: 본점 백업 요약(해시·크기·때). 다르면 매장이 조각을 달라고 한다.
        if let Some(offer) = crate::chain_backup::offer_for(dir, c.store) {
            inner["backup"] = offer;
        }
        // ⑤ 같은 체인 릴레이 이웃 묶음의 해시 — 매장이 가진 것과 다르면 `{op:"peers"}` 로 받아 간다.
        if let Some(h) = peers_bundle(dir, c.store).as_ref().and_then(bundle_hash) {
            inner["peers"] = json!(h);
        }
    }
    let sealed = seal(&key, &aad_of(AAD_RES, &json!(nonce)), inner.to_string().as_bytes());
    match sealed {
        Some(b) => (200, json!({ "v": 1, "box": b })),
        None => deny(500, "seal"),
    }
}

/// 되찾기 한 번에 돌려주는 줄 상한.
pub const PULL_LINES: usize = 2000;
const PULL_BYTES: usize = 512 * 1024;

/// 본점: 봉함이 열린(=진짜 그 매장) 요청의 일. 받기 잠금 안에서 부른다.
fn handle_op(dir: &Path, c: &cs::StoreCert, o: &Map<String, Value>, now: i64) -> Value {
    let store = c.store;
    match o.get("op").and_then(Value::as_str) {
        Some("pull") => pull_reply(dir, store, o.get("logId").and_then(Value::as_str), o.get("from").and_then(Value::as_u64).unwrap_or(0)),
        Some("backup") => crate::chain_backup::chunk_reply(dir, store, o.get("offset").and_then(Value::as_u64).unwrap_or(0), now),
        Some("relay") => match o.get("binding").filter(|b| binding_ok(b, &c.chain, store, &c.store_key)) {
            Some(b) => {
                let mut st = load_state(dir, store);
                st["relay"] = b.clone();
                match write_json(&store_dir(dir, store).join("state.json"), &st) {
                    Ok(()) => json!({ "ok": true }),
                    Err(_) => json!({ "none": true }),
                }
            }
            None => json!({ "none": true }),
        },
        Some("peers") => peers_bundle(dir, store).unwrap_or_else(|| json!({ "none": true })),
        _ => json!({ "none": true }),
    }
}

// ── ⑤ 같은 체인 매장끼리 릴레이 이웃 우선 ─────────────────────────────
//
// 릴레이 이웃(relay_share)은 10002 를 올린 **이야기 공개키**로 찾는다. 매장 열쇠와는 다른 열쇠라, 매장이 매장 열쇠로
// 「내 이야기 공개키는 이것」(binding, RELAY_DOMAIN)을 서명해 본점에 보낸다(봉함 안). 본점은 체인 열쇠로 서명한
// 릴레이 명부(relay-roster.json: 끊기지 않은 매장 공개키 + 본점 이야기 공개키)와 매장들의 binding 을 묶어 매장에 준다.
// 매장은 명부 서명(체인 열쇠)·자기 끊기 목록·binding 서명(명부의 매장 공개키)을 모두 확인한 것만 「같은 체인」으로 친다.
// 🔴 이 묶음은 공개 릴레이에 올리지 않는다(체인 ↔ 이야기 이름 연결이 퍼지지 않게). 안전 검사(§2 주소·접속 시험)는 그대로.

fn is_talk_pub(s: &str) -> bool {
    s.len() == 64 && s.bytes().all(|b| b.is_ascii_hexdigit())
}

/// binding 이 이 체인·이 매장·이 매장 열쇠가 서명한 것인가.
fn binding_ok(b: &Value, chain: &str, store: u32, store_key: &str) -> bool {
    let Some(o) = b.as_object() else { return false };
    o.get("v").and_then(Value::as_u64) == Some(1) && o.get("kind").and_then(Value::as_str) == Some("relay")
        && o.get("chain").and_then(Value::as_str) == Some(chain) && o.get("store").and_then(Value::as_u64) == Some(store as u64)
        && o.get("storeKey").and_then(Value::as_str) == Some(store_key)
        && o.get("talk").and_then(Value::as_str).is_some_and(is_talk_pub)
        && canonical_string(b).map(|t| t.len()).unwrap_or(usize::MAX) <= 1024
        && crate::lan_cert::signed_by(cs::RELAY_DOMAIN, o, store_key)
}

/// 본점: 매장 `except` 에게 줄 묶음 = {roster(체인 서명), relays:[다른 매장 binding…]}. 명부가 없으면 None.
fn peers_bundle(dir: &Path, except: u32) -> Option<Value> {
    let roster = read_json(&dir.join("relay-roster.json"))?;
    let (chain, _) = cs::load_history(dir)?;
    let (_, live, _) = cs::verify_relay_roster(&roster, &chain)?;
    let mut relays = Vec::new();
    for e in std::fs::read_dir(sales_dir(dir)).into_iter().flatten().flatten() {
        let Some(n) = e.file_name().to_str().and_then(|s| s.parse::<u32>().ok()) else { continue };
        if n == except {
            continue;
        }
        let st = load_state(dir, n);
        let Some(b) = st.get("relay") else { continue };
        let key = b.get("storeKey").and_then(Value::as_str).unwrap_or("");
        if live.iter().any(|(_, k)| k == key) && binding_ok(b, &chain, n, key) {
            relays.push(b.clone());
        }
    }
    relays.sort_by_key(|b| b.get("store").and_then(Value::as_u64).unwrap_or(0));
    Some(json!({ "roster": roster, "relays": relays }))
}

fn bundle_hash(v: &Value) -> Option<String> {
    Some(hex::encode(sha2::Sha256::digest(canonical_string(v).ok()?.as_bytes())))
}

/// 매장: 본점이 준 묶음을 확인한다 → 같은 체인 이야기 공개키들. 명부 서명·끊기 목록·binding 서명 모두.
fn friends_from_bundle(chain_dir: &Path, chain: &str, bundle: &Value) -> Option<(i64, Vec<String>)> {
    let (at, live, head_talk) = cs::verify_relay_roster(bundle.get("roster")?, chain)?;
    let revoked = cs::load_list(chain_dir, chain).map(|(_, i)| i.revoked).unwrap_or_default();
    let live: Vec<&(u64, String)> = live.iter().filter(|(serial, _)| !revoked.contains(&cs::store_cert_id(chain, *serial))).collect();
    let mut out: Vec<String> = head_talk.into_iter().collect();
    for b in bundle.get("relays")?.as_array()? {
        let key = b.get("storeKey").and_then(Value::as_str).unwrap_or("");
        let n = b.get("store").and_then(Value::as_u64).unwrap_or(0) as u32;
        if live.iter().any(|(_, k)| k == key) && binding_ok(b, chain, n, key) {
            if let Some(t) = b.get("talk").and_then(Value::as_str) {
                out.push(t.to_lowercase());
            }
        }
    }
    out.sort();
    out.dedup();
    Some((at, out))
}

fn peers_file(chain_dir: &Path) -> PathBuf {
    chain_dir.join("peers.json")
}

/// 매장: 받은 묶음을 확인하고 둔다. 명부 시각이 뒤로 가면(옛 묶음 되풀이) 두지 않는다.
pub fn accept_peers_in(chain_dir: &Path, bundle: &Value) -> bool {
    let Some(me) = cs::store_self_in(chain_dir) else { return false };
    let Some((at, _)) = friends_from_bundle(chain_dir, &me.chain, bundle) else { return false };
    let old_at = read_json(&peers_file(chain_dir)).and_then(|old| friends_from_bundle(chain_dir, &me.chain, &old)).map(|(a, _)| a);
    if old_at.is_some_and(|o| at < o) {
        return false;
    }
    write_json(&peers_file(chain_dir), bundle).is_ok()
}

/// 이 컴퓨터가 체인 매장·본점이면 같은 체인 이야기 공개키들(확인한 것만). 아니면 비어 있다. 내 것은 뺀다.
pub fn relay_friends_in(chain_dir: &Path, me_talk: Option<&str>) -> std::collections::HashSet<String> {
    let mut out: Vec<String> = Vec::new();
    if let Some(me) = cs::store_self_in(chain_dir) {
        if let Some(b) = read_json(&peers_file(chain_dir)) {
            out = friends_from_bundle(chain_dir, &me.chain, &b).map(|(_, f)| f).unwrap_or_default();
        }
    } else if let Some((chain, certs)) = cs::load_history(chain_dir) {
        let revoked = cs::load_list(chain_dir, &chain).map(|(_, i)| i.revoked).unwrap_or_default();
        for e in std::fs::read_dir(sales_dir(chain_dir)).into_iter().flatten().flatten() {
            let Some(n) = e.file_name().to_str().and_then(|s| s.parse::<u32>().ok()) else { continue };
            let st = load_state(chain_dir, n);
            let Some(b) = st.get("relay") else { continue };
            let key = b.get("storeKey").and_then(Value::as_str).unwrap_or("");
            // 본점 자신의 발급 기록 — 그 번호 매장에 끊기지 않은 증서로 나간 열쇠일 때만.
            let live = certs.iter().any(|c| c.get("store").and_then(Value::as_u64) == Some(n as u64)
                && c.get("storeKey").and_then(Value::as_str) == Some(key)
                && !c.get("serial").and_then(Value::as_u64).is_some_and(|s| revoked.contains(&cs::store_cert_id(&chain, s))));
            if live && binding_ok(b, &chain, n, key) {
                if let Some(t) = b.get("talk").and_then(Value::as_str) {
                    out.push(t.to_lowercase());
                }
            }
        }
    }
    out.into_iter().filter(|t| me_talk.is_none_or(|m| !m.eq_ignore_ascii_case(t))).collect()
}

/// 이 컴퓨터의 이야기 공개키(만들지 않는다). 비밀은 바로 지운다.
pub(crate) fn my_talk_pub() -> Option<String> {
    let (mut sk, _, _) = crate::talk::key_on_disk()?;
    let p = crate::shopkey::pubkey_of(&sk).ok();
    crate::words::wipe_bytes(&mut sk);
    p
}

/// 매장: 하루에 한 번(또는 이야기 공개키가 바뀌면) 매장 열쇠로 서명한 binding 을 보낼 차례인가.
pub fn relay_op_due(chain_dir: &Path, talk: Option<&str>, now: i64) -> Option<Value> {
    let talk = talk.filter(|t| is_talk_pub(t))?.to_lowercase();
    let ps = push_state(chain_dir);
    let same = ps.get("relayTalk").and_then(Value::as_str) == Some(talk.as_str());
    let at = ps.get("relayAt").and_then(Value::as_i64).unwrap_or(0);
    if same && now - at < 86_400_000 && now >= at {
        return None;
    }
    let me = cs::store_self_in(chain_dir)?;
    let body = json!({ "v": 1, "kind": "relay", "chain": me.chain, "store": me.store, "storeKey": me.store_key, "talk": talk, "at": now });
    let b = cs::sign_as_store_in(chain_dir, cs::RELAY_DOMAIN, &body).ok()?;
    Some(json!({ "op": "relay", "binding": b }))
}

/// 매장: 본점 묶음 해시가 내 것과 다르면 받을 차례.
pub fn peers_op_due(chain_dir: &Path) -> Option<Value> {
    let want = push_state(chain_dir).get("peersOffer").and_then(Value::as_str).map(String::from)?;
    let have = read_json(&peers_file(chain_dir)).as_ref().and_then(bundle_hash);
    (have.as_deref() != Some(want.as_str())).then(|| json!({ "op": "peers" }))
}

/// 매장: ⑤ binding 보내기 + 묶음 받기(보내기가 된 뒤에 — 본점이 답을 봉해 준 때).
pub async fn sync_relay_with<F, Fut>(chain_dir: &Path, talk: Option<&str>, mut send: F, now: impl Fn() -> i64)
where
    F: FnMut(Vec<u8>) -> Fut,
    Fut: std::future::Future<Output = Option<(u16, Vec<u8>)>>,
{
    if let Some(op) = relay_op_due(chain_dir, talk, now()) {
        if let Ok(o) = prepare_op_in(chain_dir, None, &op, now()) {
            let r = send(o.body.clone()).await;
            if let Ok(rep) = apply_op_in(chain_dir, &o, r.as_ref().map(|r| r.0), r.as_ref().map_or(&[][..], |r| &r.1), now()) {
                if rep.get("ok").and_then(Value::as_bool) == Some(true) {
                    let t = op.pointer("/binding/talk").cloned().unwrap_or(Value::Null);
                    note_try(chain_dir, now(), |ps| {
                        ps["relayTalk"] = t;
                        ps["relayAt"] = json!(now());
                    });
                }
            }
        }
    }
    if let Some(op) = peers_op_due(chain_dir) {
        if let Ok(o) = prepare_op_in(chain_dir, None, &op, now()) {
            let r = send(o.body.clone()).await;
            if let Ok(rep) = apply_op_in(chain_dir, &o, r.as_ref().map(|r| r.0), r.as_ref().map_or(&[][..], |r| &r.1), now()) {
                if rep.get("none").is_none() {
                    let _ = accept_peers_in(chain_dir, &rep);
                }
            }
        }
    }
}

/// ④ 매장 PC 를 바꿨을 때: 본점이 받아 둔 그 매장의 로그(가장 최근에 받은 logId) 줄을 `from` 번부터.
fn pull_reply(dir: &Path, store: u32, want: Option<&str>, from: u64) -> Value {
    let st = load_state(dir, store);
    let logs = st.get("logs").and_then(Value::as_object).cloned().unwrap_or_default();
    let pick = match want.filter(|w| logs.contains_key(*w)) {
        Some(w) => Some(w.to_string()),
        None => logs.iter().max_by_key(|(_, e)| (e.get("at").and_then(Value::as_i64).unwrap_or(0), e.get("ack").and_then(Value::as_u64).unwrap_or(0)))
            .map(|(k, _)| k.clone()),
    };
    let Some(log_id) = pick.filter(|l| is_hex(l, 32)) else { return json!({ "none": true }) };
    let ack = logs.get(&log_id).and_then(|e| e.get("ack")).and_then(Value::as_u64);
    let mut out = Vec::new();
    let mut bytes = 0usize;
    let mut more = false;
    'files: for (_, f) in month_files(&store_dir(dir, store).join(&log_id)) {
        for l in std::fs::read_to_string(&f).unwrap_or_default().lines() {
            let Ok(v) = serde_json::from_str::<Value>(l) else { continue };
            if v.get("seq").and_then(Value::as_u64).is_none_or(|s| s < from || ack.is_none_or(|a| s > a)) {
                continue;
            }
            if out.len() >= PULL_LINES || bytes + l.len() > PULL_BYTES {
                more = true;
                break 'files;
            }
            bytes += l.len() + 1;
            out.push(v);
        }
    }
    json!({ "logId": log_id, "ack": ack, "lines": out, "more": more })
}

/// 서버 처리기가 부른다(본점 PC 의 chain 폴더). `client` = 터널이면 cf-connecting-ip, 아니면 "lan".
pub fn receive(body: &[u8], client: &str) -> (u16, Value) {
    receive_in(&cs::chain_dir_path(), body, now_ms(), client)
}

// ── 본점: 합계 ───────────────────────────────────────────────────────

#[derive(Default, Clone)]
struct Sum {
    net: i64,
    count: u64,
    methods: Vec<(String, i64)>,
}
impl Sum {
    fn add(&mut self, method: &str, amt: i64, sale: bool) {
        self.net += amt;
        if sale {
            self.count += 1;
        }
        let m = if METHODS.contains(&method) { method } else { "other" };
        match self.methods.iter_mut().find(|(k, _)| k == m) {
            Some((_, v)) => *v += amt,
            None => self.methods.push((m.to_string(), amt)),
        }
    }
    fn merge(&mut self, o: &Sum) {
        self.net += o.net;
        self.count += o.count;
        for (m, v) in &o.methods {
            match self.methods.iter_mut().find(|(k, _)| k == m) {
                Some((_, x)) => *x += v,
                None => self.methods.push((m.clone(), *v)),
            }
        }
    }
    fn json(&self) -> Value {
        let mut methods: Map<String, Value> = METHODS.iter().map(|m| (m.to_string(), json!(0))).collect();
        for (m, v) in &self.methods {
            methods.insert(m.clone(), json!(v));
        }
        json!({ "net": self.net, "count": self.count, "methods": methods })
    }
}

fn month_files(dir: &Path) -> Vec<(u32, PathBuf)> {
    let mut out: Vec<(u32, PathBuf)> = std::fs::read_dir(dir).into_iter().flatten().flatten()
        .filter_map(|e| {
            let p = e.path();
            let stem = p.file_stem()?.to_str()?.to_string();
            (p.extension()? == "jsonl" && stem.len() == 6).then(|| stem.parse::<u32>().ok().map(|m| (m, p.clone())))?
        })
        .collect();
    out.sort();
    out
}

/// 본점이 받은 매장 n 의 줄들(받을 때 확인을 통과한 것만 있다) 중 `from_ms` 가 속한 달(앞 달 포함) 이후 것.
/// 받을 때 맞지 않는 취소(남의 로그·없는 매출·금액 초과·두 번째 취소)로 판정한 줄은 빼고 돌려준다(합계에 안 들어간다).
fn received_lines(dir: &Path, n: u32, from_ms: i64) -> Vec<Value> {
    let first = month_of(from_ms - 2 * 86_400_000);
    let mut out = Vec::new();
    for e in std::fs::read_dir(store_dir(dir, n)).into_iter().flatten().flatten() {
        let p = e.path();
        if !p.is_dir() || !p.file_name().and_then(|f| f.to_str()).is_some_and(|f| is_hex(f, 32)) {
            continue;
        }
        let bad: Vec<u64> = load_index(&p)["badVoids"].as_array().map(|a| a.iter().filter_map(Value::as_u64).collect()).unwrap_or_default();
        for (m, f) in month_files(&p) {
            if m < first {
                continue;
            }
            let text = std::fs::read_to_string(&f).unwrap_or_default();
            out.extend(text.lines().filter_map(|l| serde_json::from_str::<Value>(l).ok())
                .filter(|l| !(l.get("kind").and_then(Value::as_str) == Some("void") && l.get("seq").and_then(Value::as_u64).is_some_and(|s| bad.contains(&s)))));
        }
    }
    out
}

/// 매장별 · 체인 전체 · 사업자별(종사업장은 같은 사업자 아래) 합계. 오늘·이번 달, 결제수단별. 취소 줄(음수)은 빠진다.
/// 매장 이름·사업자 번호는 본점 발급 기록(issued.json)의 그 매장 마지막 증서에서 — 줄에 적힌 값을 믿지 않는다.
pub fn totals_in(dir: &Path, day: (i64, i64), month: (i64, i64), now: i64) -> Value {
    let Some((chain, certs)) = cs::load_history(dir) else { return json!({ "chain": null, "stores": [] }) };
    let revoked = cs::load_list(dir, &chain).map(|(_, i)| i.revoked).unwrap_or_default();
    let mut latest: Vec<(u32, Value)> = Vec::new();
    for c in &certs {
        let Some(n) = c.get("store").and_then(Value::as_u64).map(|n| n as u32) else { continue };
        let serial = c.get("serial").and_then(Value::as_u64).unwrap_or(0);
        match latest.iter_mut().find(|(k, _)| *k == n) {
            Some((_, old)) if old.get("serial").and_then(Value::as_u64).unwrap_or(0) < serial => *old = c.clone(),
            Some(_) => {}
            None => latest.push((n, c.clone())),
        }
    }
    latest.sort_by_key(|(n, _)| *n);
    let (mut chain_day, mut chain_month) = (Sum::default(), Sum::default());
    let mut biz: Vec<(String, Vec<Value>, Vec<u32>, Sum, Sum)> = Vec::new();
    let mut stores = Vec::new();
    let from = day.0.min(month.0);
    for (n, cert) in &latest {
        let (mut sd, mut sm) = (Sum::default(), Sum::default());
        for l in received_lines(dir, *n, from) {
            let kind = l.get("kind").and_then(Value::as_str).unwrap_or("");
            if !matches!(kind, "sale" | "void") {
                continue;
            }
            let at = l.get("at").and_then(Value::as_i64).unwrap_or(0);
            let amt = l.get("amount").and_then(Value::as_i64).unwrap_or(0);
            let m = l.get("method").and_then(Value::as_str).unwrap_or("other");
            if (day.0..day.1).contains(&at) {
                sd.add(m, amt, kind == "sale");
            }
            if (month.0..month.1).contains(&at) {
                sm.add(m, amt, kind == "sale");
            }
        }
        chain_day.merge(&sd);
        chain_month.merge(&sm);
        let b = cert.get("biz").cloned().unwrap_or(Value::Null);
        let no = b.get("no").and_then(Value::as_str).unwrap_or("").to_string();
        match biz.iter_mut().find(|x| x.0 == no) {
            Some(x) => {
                if let Some(s) = b.get("sub") {
                    x.1.push(s.clone());
                }
                x.2.push(*n);
                x.3.merge(&sd);
                x.4.merge(&sm);
            }
            None => biz.push((no, b.get("sub").cloned().into_iter().collect(), vec![*n], sd.clone(), sm.clone())),
        }
        let st = load_state(dir, *n);
        let w = watch_of(&st);
        let serial = cert.get("serial").and_then(Value::as_u64).unwrap_or(0);
        stores.push(json!({
            "store": n, "name": cert.get("name"), "biz": b,
            "revoked": revoked.contains(&cs::store_cert_id(&chain, serial)),
            "today": sd.json(), "month": sm.json(),
            "lastSeen": w.last_seen, "offline": w.alerted, "misses": w.misses(now),
            "warn": st.get("warn").cloned().unwrap_or(Value::Null),
        }));
    }
    let biz: Vec<Value> = biz.into_iter().map(|(no, subs, ns, d, m)| json!({ "no": no, "subs": subs, "stores": ns, "today": d.json(), "month": m.json() })).collect();
    json!({ "chain": chain, "stores": stores, "all": { "today": chain_day.json(), "month": chain_month.json() }, "biz": biz })
}

/// 본점: 시계가 흐를 때. 지금 막 꺼진 매장 (번호, 이름) — 이번 끊김에 한 번만. 끊긴(철회된) 매장은 보지 않는다.
pub fn watch_tick_in(dir: &Path, now: i64) -> Vec<(u32, String)> {
    let Some((chain, certs)) = cs::load_history(dir) else { return Vec::new() };
    let revoked = cs::load_list(dir, &chain).map(|(_, i)| i.revoked).unwrap_or_default();
    let mut out = Vec::new();
    let _g = RECEIVE.lock().unwrap_or_else(|e| e.into_inner());
    // 다른 레이븐볼트가 쥐고 있으면 이번 틱은 건너뛴다(그쪽이 본다 — 쪽지가 두 통 가지 않게).
    let Some(_os) = receive_os_lock(dir) else { return out };
    for e in std::fs::read_dir(sales_dir(dir)).into_iter().flatten().flatten() {
        let Some(n) = e.file_name().to_str().and_then(|s| s.parse::<u32>().ok()) else { continue };
        let mut st = load_state(dir, n);
        let serial = st.get("serial").and_then(Value::as_u64).unwrap_or(0);
        if revoked.contains(&cs::store_cert_id(&chain, serial)) {
            continue;
        }
        let mut w = watch_of(&st);
        let fresh = w.tick(now);
        // 쪽지를 못 보냈으면(이야기 이름 없음·릴레이 끊김) 다음 틱에 다시 — 그래도 한 끊김에 한 통.
        if fresh || (w.alerted && st.get("dmSent").and_then(Value::as_bool) == Some(false) && st.get("alertedAt").is_some()) {
            if fresh {
                st["alertedAt"] = json!(now);
                st["dmSent"] = json!(false);
            }
            put_watch(&mut st, w);
            let _ = write_json(&store_dir(dir, n).join("state.json"), &st);
            let name = certs.iter().filter(|c| c.get("store").and_then(Value::as_u64) == Some(n as u64))
                .filter_map(|c| c.get("name").and_then(Value::as_str)).last().unwrap_or("").to_string();
            out.push((n, name));
        }
    }
    out
}

fn mark_dm_sent(dir: &Path, n: u32) {
    let _g = RECEIVE.lock().unwrap_or_else(|e| e.into_inner());
    let Some(_os) = receive_os_lock(dir) else { return };
    let mut st = load_state(dir, n);
    if st.get("alerted").and_then(Value::as_bool) == Some(true) {
        st["dmSent"] = json!(true);
        let _ = write_json(&store_dir(dir, n).join("state.json"), &st);
    }
}

/// 사장에게 알리는 글(받는 사람 = 사장 자신의 이야기 이름).
pub fn offline_text(n: u32, name: &str) -> String {
    format!("[레이븐볼트 본점] 「{name}」({n}번 매장)에서 30분째 매출이 오지 않아요. 매장 컴퓨터가 켜져 있는지, 인터넷이 되는지 확인해 주세요.")
}

/// 사장 자신에게 쪽지(NIP-17) — 제3자에게 보내지 않는다. 이야기 열쇠가 이 컴퓨터에 없으면 보내지 않는다(만들지 않는다).
async fn send_self_dm(text: &str) -> bool {
    let Some((mut sk, _, _)) = crate::talk::key_on_disk() else { return false };
    let me = crate::shopkey::pubkey_of(&sk);
    let ev = me.and_then(|me| crate::wallet_link::wrap_for(&sk, &me, text, now_ms() / 1000));
    crate::words::wipe_bytes(&mut sk);
    match ev {
        Ok(ev) => crate::nostrpub::nostr_publish(ev).await.is_ok(),
        Err(_) => false,
    }
}

// ── 매장: 본점 주소 · 보내기 ────────────────────────────────────────

/// 본점 주소 모양 확인 → 정리한 주소. https = 공개 이름(점 하나 이상, localhost 아님) · http = 사설 IPv4 또는 `<이름>.local` 만(포트 없으면 8790).
pub fn clean_head_url(s: &str) -> Result<String, &'static str> {
    let t = s.trim().trim_end_matches('/').to_ascii_lowercase();
    if t.len() > 200 {
        return Err(ERR_HEAD_URL);
    }
    let (scheme, rest) = t.split_once("://").ok_or(ERR_HEAD_URL)?;
    if rest.is_empty() || rest.bytes().any(|b| matches!(b, b'/' | b'?' | b'#' | b'@' | b'\\') || b.is_ascii_whitespace() || !b.is_ascii()) {
        return Err(ERR_HEAD_URL);
    }
    let (host, port) = match rest.rsplit_once(':') {
        Some((h, p)) => {
            let p: u16 = p.parse::<u16>().ok().filter(|p| *p > 0).ok_or(ERR_HEAD_URL)?;
            (h.to_string(), Some(p))
        }
        None => (rest.to_string(), None),
    };
    let label_ok = |l: &str| !l.is_empty() && l.len() <= 63 && l.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-') && !l.starts_with('-') && !l.ends_with('-');
    match scheme {
        "https" => {
            let labels: Vec<&str> = host.split('.').collect();
            if labels.len() < 2 || !labels.iter().all(|l| label_ok(l)) || host.parse::<std::net::Ipv4Addr>().is_ok() || host.ends_with(".local") {
                return Err(ERR_HEAD_URL);
            }
            Ok(match port {
                Some(p) => format!("https://{host}:{p}"),
                None => format!("https://{host}"),
            })
        }
        "http" => {
            let lan = match host.parse::<std::net::Ipv4Addr>() {
                Ok(ip) => ip.is_private() || ip.is_link_local(),
                Err(_) => host.strip_suffix(".local").is_some_and(|l| label_ok(l)),
            };
            if !lan {
                return Err(ERR_HEAD_URL);
            }
            Ok(format!("http://{host}:{}", port.unwrap_or(DEFAULT_PORT)))
        }
        _ => Err(ERR_HEAD_URL),
    }
}

fn head_file(dir: &Path) -> PathBuf {
    dir.join("head.json")
}
fn push_file(dir: &Path) -> PathBuf {
    dir.join("push.json")
}
pub fn head_url_in(dir: &Path) -> Option<String> {
    read_json(&head_file(dir))?.get("url")?.as_str().and_then(|u| clean_head_url(u).ok())
}
pub fn head_set_in(dir: &Path, url: &str) -> Result<String, &'static str> {
    cs::store_self_in(dir).ok_or(ERR_NOT_STORE)?;
    let u = clean_head_url(url)?;
    write_json(&head_file(dir), &json!({ "v": 1, "url": u }))?;
    Ok(u)
}
fn push_state(dir: &Path) -> Value {
    read_json(&push_file(dir)).filter(Value::is_object).unwrap_or_else(|| json!({ "v": 1 }))
}

/// 한 번 보낼 묶음.
pub struct Outgoing {
    pub body: Vec<u8>,
    nonce: String,
    log_id: String,
    local_last: u64,
    key: DataKey,
}

/// 로그가 아직 없는 매장의 살아 있다는 신호에 쓰는 logId.
const NO_LOG: &str = "00000000000000000000000000000000";

/// 보낼 것이 있으면 묶음을 만든다(본점이 받았다고 한 번호 다음부터, 최대 200줄·512KiB).
/// 보낼 줄이 없고 `heartbeat` 면 빈 묶음(살아 있다는 신호)을 만든다.
pub fn prepare_in(chain_dir: &Path, root: &Path, now: i64, heartbeat: bool) -> Result<Option<Outgoing>, &'static str> {
    cs::store_self_in(chain_dir).ok_or(ERR_NOT_STORE)?;
    let (_, log_id, lines) = crate::pos_pay::log_lines_in(root, chain_dir);
    let log_id = log_id.filter(|l| is_hex(l, 32) && l != NO_LOG).unwrap_or_else(|| NO_LOG.to_string());
    let ps = push_state(chain_dir);
    let from = if ps.get("logId").and_then(Value::as_str) == Some(log_id.as_str()) {
        ps.get("ack").and_then(Value::as_u64).map_or(0, |a| a + 1)
    } else {
        0
    };
    let local_last = lines.iter().filter_map(|l| l.get("seq").and_then(Value::as_u64)).max().unwrap_or(0);
    let mut batch: Vec<&Value> = Vec::new();
    let mut bytes = 0usize;
    for l in lines.iter().filter(|l| l.get("seq").and_then(Value::as_u64).is_some_and(|s| s >= from)) {
        let n = canonical_string(l).map(|s| s.len()).unwrap_or(0) + 1;
        if batch.len() >= MAX_BATCH_LINES || (bytes + n > MAX_BATCH_BYTES && !batch.is_empty()) {
            break;
        }
        bytes += n;
        batch.push(l);
    }
    let first = match batch.first().and_then(|l| l.get("seq")).and_then(Value::as_u64) {
        Some(f) => f,
        None if heartbeat => from,
        None => return Ok(None),
    };
    let plain = serde_json::to_vec(&batch).map_err(|_| ERR_KEY)?;
    outgoing(chain_dir, &log_id, first, batch.len(), &plain, local_last, now).map(Some)
}

/// 봉해서 보낼 묶음 하나(머리 + 증서 + 봉함). sentAt 은 여기서 늘린다.
fn outgoing(chain_dir: &Path, log_id: &str, first: u64, count: usize, plain: &[u8], local_last: u64, now: i64) -> Result<Outgoing, &'static str> {
    let me = cs::store_self_in(chain_dir).ok_or(ERR_NOT_STORE)?;
    let cert = cs::store_cert_in(chain_dir).ok_or(ERR_NOT_STORE)?;
    let serial = cert.get("serial").and_then(Value::as_u64).ok_or(ERR_NOT_STORE)?;
    let mut ps = push_state(chain_dir);
    let key = cs::with_store_secret_in(chain_dir, |sk, me| data_key(sk, &me.chain, &me.chain, &me.store_key)).map_err(|_| ERR_KEY)?.ok_or(ERR_KEY)?;
    let nonce = hex::encode(rand::random::<[u8; 16]>());
    // sentAt 은 늘기만 한다(본점이 되풀이를 막는 기준) — 같은 밀리초에 두 묶음을 보내도 겹치지 않게.
    // 시계가 한 번 크게 앞으로 갔다 돌아왔으면(한 시간 넘게 앞선 값) 지금으로 되돌린다 — 본점 창(±1h) 밖이라 어차피 못 쓴다.
    let sent_at = match ps.get("lastSentAt").and_then(Value::as_i64) {
        Some(l) if l > now + SENT_AT_WINDOW_MS => now,
        Some(l) => now.max(l + 1),
        None => now,
    };
    ps["lastSentAt"] = json!(sent_at);
    write_json(&push_file(chain_dir), &ps).map_err(|_| ERR_SAVE)?;
    let header = json!({ "v": 1, "chain": me.chain, "store": me.store, "serial": serial, "logId": log_id, "from": first,
        "count": count, "sentAt": sent_at, "nonce": nonce });
    let sealed = seal(&key, &aad_of(AAD_REQ, &header), plain).ok_or(ERR_KEY)?;
    let mut body = header;
    body["cert"] = cert;
    body["box"] = json!(sealed);
    let body = serde_json::to_vec(&body).map_err(|_| ERR_KEY)?;
    Ok(Outgoing { body, nonce, log_id: log_id.to_string(), local_last, key })
}

/// 줄 없이 일 하나를 부탁하는 묶음(④ 되찾기·백업 조각 · ⑤ 이웃). `log_id` 는 없으면 NO_LOG.
pub fn prepare_op_in(chain_dir: &Path, log_id: Option<&str>, op: &Value, now: i64) -> Result<Outgoing, &'static str> {
    let log_id = log_id.filter(|l| is_hex(l, 32)).unwrap_or(NO_LOG);
    let plain = serde_json::to_vec(op).map_err(|_| ERR_KEY)?;
    outgoing(chain_dir, log_id, 0, 0, &plain, 0, now)
}

/// 보낸 결과(무엇을 기록했는지). `progressed` = 본점 ack 가 앞으로 갔다.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Sent {
    Acked { ack: Option<u64>, progressed: bool, warn: Option<String> },
    /// 본점이 거절(봉함 없는 답 — 화면 표시만, 상태는 바꾸지 않는다).
    Refused(String),
    /// 닿지 않음·이상한 답.
    Failed(&'static str),
}

const REFUSALS: [&str; 16] = ["not-head", "rate", "shape", "bad-clock", "not-yet", "expired",
    "revoked", "no-revocation-list", "unknown-cert", "need-prepare", "bad-box", "save", "seal", "replay", "too-many-logs", "busy"];

fn note_try(chain_dir: &Path, now: i64, f: impl FnOnce(&mut Value)) {
    let mut ps = push_state(chain_dir);
    ps["lastTryAt"] = json!(now);
    f(&mut ps);
    let _ = write_json(&push_file(chain_dir), &ps);
}

/// 답을 연다. 봉함을 열 수 있는 답(본점만 만들 수 있다)만 믿는다. 거절·실패면 push.json 에 적고 `Err(Sent)`.
fn open_reply(chain_dir: &Path, out: &Outgoing, status: Option<u16>, resp: &[u8], now: i64) -> Result<Value, Sent> {
    let fail = |code: &'static str| {
        note_try(chain_dir, now, |ps| {
            ps["lastErr"] = json!(code);
            ps["fails"] = json!(ps.get("fails").and_then(Value::as_u64).unwrap_or(0) + 1);
        });
        Sent::Failed(code)
    };
    let Some(status) = status else { return Err(fail("unreachable")) };
    let v: Value = serde_json::from_slice(resp).unwrap_or(Value::Null);
    if status != 200 {
        let why = v.get("reason").and_then(Value::as_str).and_then(|r| REFUSALS.iter().find(|x| **x == r)).copied().unwrap_or("refused");
        note_try(chain_dir, now, |ps| {
            ps["lastErr"] = json!(format!("refused:{why}"));
            ps["fails"] = json!(ps.get("fails").and_then(Value::as_u64).unwrap_or(0) + 1);
        });
        return Err(Sent::Refused(why.into()));
    }
    let inner = v.get("box").and_then(Value::as_str).and_then(|b| open(&out.key, &aad_of(AAD_RES, &json!(out.nonce)), b))
        .and_then(|p| serde_json::from_slice::<Value>(&p).ok());
    let Some(inner) = inner else { return Err(fail("bad-reply")) };
    if inner.get("logId").and_then(Value::as_str) != Some(out.log_id.as_str()) {
        return Err(fail("bad-reply"));
    }
    // 본점 백업 요약(맡는 매장만 받는다) — 다음 조각 받기가 본다. 끊기 목록은 서명·seq 후퇴 금지를 넘을 때만.
    if inner.get("op").is_none() {
        note_try(chain_dir, now, |ps| {
            ps["backupOffer"] = inner.get("backup").cloned().unwrap_or(Value::Null);
            ps["peersOffer"] = inner.get("peers").cloned().filter(Value::is_string).unwrap_or(Value::Null);
        });
    }
    if let (Some(rev), Some(me)) = (inner.get("revocations").filter(|r| r.is_object()), cs::store_self_in(chain_dir)) {
        let _ = cs::accept_list_in(chain_dir, &me.chain, rev);
    }
    Ok(inner)
}

/// 답을 받아 반영한다. 봉함을 열 수 있는 답(본점만 만들 수 있다)일 때만 ack 를 믿는다.
pub fn apply_in(chain_dir: &Path, out: &Outgoing, status: Option<u16>, resp: &[u8], now: i64) -> Sent {
    let inner = match open_reply(chain_dir, out, status, resp, now) {
        Ok(i) => i,
        Err(s) => return s,
    };
    let ack = inner.get("ack").and_then(Value::as_u64);
    if ack.is_some_and(|a| a > out.local_last) {
        note_try(chain_dir, now, |ps| {
            ps["lastErr"] = json!("bad-reply");
            ps["fails"] = json!(ps.get("fails").and_then(Value::as_u64).unwrap_or(0) + 1);
        });
        return Sent::Failed("bad-reply");
    }
    let warn = inner.pointer("/warn/why").and_then(Value::as_str).map(String::from);
    let ps = push_state(chain_dir);
    let old = if ps.get("logId").and_then(Value::as_str) == Some(out.log_id.as_str()) { ps.get("ack").and_then(Value::as_u64) } else { None };
    let progressed = match (old, ack) {
        (_, None) => false,
        (None, Some(_)) => true,
        (Some(o), Some(a)) => a > o,
    };
    note_try(chain_dir, now, |ps| {
        ps["logId"] = json!(out.log_id);
        ps["ack"] = json!(ack);
        ps["lastOkAt"] = json!(now);
        ps["fails"] = json!(0);
        ps["lastErr"] = Value::Null;
        ps["warn"] = json!(warn);
    });
    Sent::Acked { ack, progressed, warn }
}

/// 일 하나의 답(봉함 안 `op`). 거절·실패면 Err.
pub fn apply_op_in(chain_dir: &Path, out: &Outgoing, status: Option<u16>, resp: &[u8], now: i64) -> Result<Value, Sent> {
    let inner = open_reply(chain_dir, out, status, resp, now)?;
    Ok(inner.get("op").cloned().unwrap_or_else(|| json!({ "none": true })))
}

/// ④ 맡는 매장: 본점 요약이 내 것과 다르면 다음에 달라고 할 조각. 없으면 None.
pub fn next_backup_op(chain_dir: &Path) -> Option<Value> {
    let offer = push_state(chain_dir).get("backupOffer").cloned().filter(Value::is_object)?;
    let offset = crate::chain_backup::want_offset(chain_dir, &offer)?;
    Some(json!({ "op": "backup", "offset": offset }))
}

/// 한 번 보낼 때 받는 백업 조각 수 상한(384KiB × 16 ≈ 6MiB / 10분).
pub const BACKUP_CHUNKS_PER_PUSH: usize = 16;

/// 시험용 동기 운전기(네트워크 없이 `send` 가 본점 처리기를 바로 부른다).
#[cfg(test)]
pub fn push_with(chain_dir: &Path, root: &Path, now: i64, send: &mut dyn FnMut(&[u8]) -> Option<(u16, Vec<u8>)>) -> Result<Vec<Sent>, &'static str> {
    let mut out = Vec::new();
    for round in 0..MAX_ROUNDS {
        let Some(o) = prepare_in(chain_dir, root, now, round == 0)? else { break };
        let r = send(&o.body);
        let s = apply_in(chain_dir, &o, r.as_ref().map(|r| r.0), r.as_ref().map_or(&[][..], |r| &r.1), now);
        let go_on = matches!(s, Sent::Acked { progressed: true, warn: None, .. });
        out.push(s);
        if !go_on {
            break;
        }
    }
    Ok(out)
}

async fn post(url: &str, body: Vec<u8>) -> Option<(u16, Vec<u8>)> {
    let client = reqwest::Client::builder().timeout(std::time::Duration::from_secs(20)).redirect(reqwest::redirect::Policy::none()).build().ok()?;
    let r = client.post(format!("{url}{SALES_PATH}")).header("content-type", "application/json").body(body).send().await.ok()?;
    let status = r.status().as_u16();
    let bytes = r.bytes().await.ok()?;
    if bytes.len() > MAX_REPLY_BYTES {
        return None;
    }
    Some((status, bytes.to_vec()))
}

async fn post_owned(url: String, body: Vec<u8>) -> Option<(u16, Vec<u8>)> {
    post(&url, body).await
}

#[cfg(not(test))]
const RATE_WAIT: std::time::Duration = std::time::Duration::from_secs(20);
#[cfg(test)]
const RATE_WAIT: std::time::Duration = std::time::Duration::from_millis(1);
const MAX_PULL_ROUNDS: usize = 500;

fn sent_code(s: &Sent) -> String {
    match s {
        Sent::Refused(w) => format!("refused:{w}"),
        Sent::Failed(w) => w.to_string(),
        Sent::Acked { .. } => "bad-reply".into(),
    }
}

/// ④ 맡는 매장: 본점 요약이 내 것과 다르면 조각을 받아 모은다(한 번에 최대 16조각). → 받은 조각 수.
pub async fn fetch_backup_with<F, Fut>(chain_dir: &Path, mut send: F, now: impl Fn() -> i64) -> usize
where
    F: FnMut(Vec<u8>) -> Fut,
    Fut: std::future::Future<Output = Option<(u16, Vec<u8>)>>,
{
    let mut got = 0;
    for _ in 0..BACKUP_CHUNKS_PER_PUSH {
        let Some(op) = next_backup_op(chain_dir) else { break };
        let Ok(o) = prepare_op_in(chain_dir, None, &op, now()) else { break };
        let r = send(o.body.clone()).await;
        let reply = match apply_op_in(chain_dir, &o, r.as_ref().map(|r| r.0), r.as_ref().map_or(&[][..], |r| &r.1), now()) {
            Ok(v) => v,
            Err(_) => break,
        };
        if reply.get("none").is_some() {
            note_try(chain_dir, now(), |ps| ps["backupOffer"] = Value::Null);
            break;
        }
        match crate::chain_backup::take_chunk_in(chain_dir, &reply, now()) {
            Ok(done) => {
                got += 1;
                if done {
                    break;
                }
            }
            Err(_) => break,
        }
    }
    got
}

/// ④ 컴퓨터를 바꾼 매장: 본점이 받아 둔 이 매장의 로그를 되찾아 깔고, 번호를 건너뛰는 `resume` 줄을 잇는다.
/// → Ok({ok:true,…}) · 닿지 않음·거절은 Ok({ok:false, why}) · 되살리기 판정 실패는 Err(한국어).
pub async fn pull_log_with<F, Fut>(chain_dir: &Path, root: &Path, mut send: F, now: impl Fn() -> i64) -> Result<Value, String>
where
    F: FnMut(Vec<u8>) -> Fut,
    Fut: std::future::Future<Output = Option<(u16, Vec<u8>)>>,
{
    cs::store_self_in(chain_dir).ok_or(ERR_NOT_STORE)?;
    if !crate::pos_pay::log_lines_in(root, chain_dir).2.is_empty() {
        return Err(crate::pos_pay::ERR_RESTORE_HAVE.into());
    }
    let mut log_id: Option<String> = None;
    let mut from = 0u64;
    let mut all: Vec<Value> = Vec::new();
    let mut ack: Option<u64> = None;
    let mut rate_waits = 0;
    let mut finished = false;
    for _ in 0..MAX_PULL_ROUNDS {
        let op = json!({ "op": "pull", "from": from, "logId": log_id });
        let o = prepare_op_in(chain_dir, log_id.as_deref(), &op, now())?;
        let r = send(o.body.clone()).await;
        let reply = match apply_op_in(chain_dir, &o, r.as_ref().map(|r| r.0), r.as_ref().map_or(&[][..], |r| &r.1), now()) {
            Ok(v) => v,
            Err(Sent::Refused(w)) if w == "rate" && rate_waits < 30 => {
                rate_waits += 1;
                tokio::time::sleep(RATE_WAIT).await;
                continue;
            }
            Err(s) => return Ok(json!({ "ok": false, "why": sent_code(&s) })),
        };
        if reply.get("none").is_some() {
            if all.is_empty() {
                return Err(crate::pos_pay::ERR_RESTORE_EMPTY.into());
            }
            return Err(crate::pos_pay::ERR_RESTORE.into());
        }
        let lid = reply.get("logId").and_then(Value::as_str).filter(|l| is_hex(l, 32)).map(String::from);
        if lid.is_none() || (log_id.is_some() && lid != log_id) {
            return Err(crate::pos_pay::ERR_RESTORE.into());
        }
        log_id = lid;
        ack = reply.get("ack").and_then(Value::as_u64);
        let lines = reply.get("lines").and_then(Value::as_array).cloned().unwrap_or_default();
        let more = reply.get("more").and_then(Value::as_bool) == Some(true);
        let Some(last) = lines.last() else {
            if more {
                return Err(crate::pos_pay::ERR_RESTORE.into());
            }
            finished = true;
            break;
        };
        from = crate::pos_pay::next_after(last);
        all.extend(lines);
        if !more {
            finished = true;
            break;
        }
    }
    if !finished || all.is_empty() {
        return Err(crate::pos_pay::ERR_RESTORE_EMPTY.into());
    }
    // 본점이 받았다고 한 마지막 번호까지 다 왔는가.
    if all.last().and_then(|l| l.get("seq")).and_then(Value::as_u64) != ack {
        return Err(crate::pos_pay::ERR_RESTORE.into());
    }
    let out = crate::pos_pay::restore_lines_in(root, chain_dir, &all, now())?;
    // 되찾은 줄은 본점에 이미 있다 — 다시 보내지 않게 ack 를 맞춘다(그 뒤 resume 줄부터 간다).
    note_try(chain_dir, now(), |ps| {
        ps["logId"] = json!(log_id);
        ps["ack"] = json!(ack);
    });
    let mut out = out;
    out["ok"] = json!(true);
    Ok(out)
}

static PUSHING: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// 매장: 지금 보낸다(보낼 것이 없을 때까지, 최대 20 묶음).
pub async fn push_now() -> Value {
    let _g = PUSHING.lock().await;
    let dir = cs::chain_dir_path();
    // 프로그램 사이 잠금 — 레이븐볼트가 두 번 켜져 있으면 한쪽만 보낸다(push.json·sentAt 이 겹치지 않게).
    let Some(_os) = crate::pos_pay::os_lock(&dir.join("push.lock")) else {
        return json!({ "ok": false, "why": "busy" });
    };
    let root = crate::pos_pay::pos_root_path();
    let Some(url) = head_url_in(&dir) else {
        note_try(&dir, now_ms(), |ps| ps["lastErr"] = json!("no-head"));
        return json!({ "ok": false, "why": "no-head" });
    };
    let mut sent = 0u32;
    let mut last: Option<Sent> = None;
    for round in 0..MAX_ROUNDS {
        let now = now_ms();
        let o = match tokio::task::spawn_blocking({
            let (d, r) = (dir.clone(), root.clone());
            move || prepare_in(&d, &r, now, round == 0)
        }).await {
            Ok(Ok(Some(o))) => o,
            Ok(Ok(None)) => break,
            Ok(Err(e)) => return json!({ "ok": false, "why": e }),
            Err(_) => return json!({ "ok": false, "why": "internal" }),
        };
        let r = post(&url, o.body.clone()).await;
        let s = apply_in(&dir, &o, r.as_ref().map(|r| r.0), r.as_ref().map_or(&[][..], |r| &r.1), now_ms());
        let go_on = matches!(s, Sent::Acked { progressed: true, warn: None, .. });
        if matches!(s, Sent::Acked { .. }) {
            sent += 1;
        }
        last = Some(s);
        if !go_on {
            break;
        }
    }
    // ④ 맡는 매장이면 본점 백업 조각도 받아 둔다(보내기가 된 때만 — 본점이 답을 봉해 준 뒤).
    if matches!(last, None | Some(Sent::Acked { .. })) {
        let u = url.clone();
        let _ = fetch_backup_with(&dir, |b| post_owned(u.clone(), b), now_ms).await;
        // ⑤ 같은 체인 릴레이 이웃: 내 이야기 공개키(있으면)를 알리고, 본점 묶음이 바뀌었으면 받아 둔다.
        let talk = my_talk_pub();
        let u = url.clone();
        sync_relay_with(&dir, talk.as_deref(), |b| post_owned(u.clone(), b), now_ms).await;
    }
    match last {
        None | Some(Sent::Acked { warn: None, .. }) => json!({ "ok": true, "batches": sent }),
        Some(Sent::Acked { warn: Some(w), .. }) => json!({ "ok": false, "why": format!("warn:{w}") }),
        Some(Sent::Refused(w)) => json!({ "ok": false, "why": format!("refused:{w}") }),
        Some(Sent::Failed(w)) => json!({ "ok": false, "why": w }),
    }
}

/// 매장 상태(금액 없음): 마지막 보낸 시각·안 보낸 줄 수·본점과 연결 여부.
pub fn store_status_in(chain_dir: &Path, root: &Path, now: i64) -> Value {
    let ps = push_state(chain_dir);
    let (_, log_id, lines) = crate::pos_pay::log_lines_in(root, chain_dir);
    let ack = if ps.get("logId").and_then(Value::as_str) == log_id.as_deref() { ps.get("ack").and_then(Value::as_u64) } else { None };
    let pending = lines.iter().filter(|l| l.get("seq").and_then(Value::as_u64).is_some_and(|s| ack.is_none_or(|a| s > a))).count();
    let last_ok = ps.get("lastOkAt").and_then(Value::as_i64);
    let fails = ps.get("fails").and_then(Value::as_u64).unwrap_or(0);
    let connected = fails == 0 && last_ok.is_some_and(|t| now - t < MISS_LIMIT * PUSH_EVERY_MS);
    json!({ "role": "store", "head": head_url_in(chain_dir), "lastOkAt": last_ok, "lastTryAt": ps.get("lastTryAt"),
        "pending": pending, "connected": connected, "lastErr": ps.get("lastErr"), "warn": ps.get("warn") })
}

/// 본점 상태(금액 없음): 받을 준비가 덜 된 매장 수·꺼진 매장.
pub fn owner_status_in(dir: &Path) -> Value {
    json!({ "role": "owner", "needPrepare": missing_keys(dir).len(), "rejects": rejects(dir, 20), "junk": junk_counts(dir), "path": SALES_PATH })
}

// ── 명령 ─────────────────────────────────────────────────────────────

fn refuse_locked() -> Result<(), String> {
    if crate::app_lock::is_locked() {
        Err(ERR_LOCKED.into())
    } else {
        Ok(())
    }
}

#[tauri::command(async)]
pub fn chain_sales_status() -> Value {
    let dir = cs::chain_dir_path();
    if cs::store_self_in(&dir).is_some() {
        let mut v = store_status_in(&dir, &crate::pos_pay::pos_root_path(), now_ms());
        v["held"] = crate::chain_backup::held_status_in(&dir);
        return v;
    }
    if dir.join("issued.json").exists() {
        let mut v = owner_status_in(&dir);
        v["backup"] = crate::chain_backup::owner_status_in(&dir);
        let t = crate::tunnel::tunnel_status();
        v["tunnel"] = if t["running"].as_bool() == Some(true) { t["url"].clone() } else { Value::Null };
        v["lan"] = json!(lan_ip().map(|ip| format!("http://{ip}:{DEFAULT_PORT}")));
        return v;
    }
    json!({ "role": "none" })
}

fn lan_ip() -> Option<String> {
    let sock = std::net::UdpSocket::bind("0.0.0.0:0").ok()?;
    sock.connect("8.8.8.8:80").ok()?;
    let ip = sock.local_addr().ok()?.ip();
    match ip {
        std::net::IpAddr::V4(v4) if v4.is_private() => Some(v4.to_string()),
        _ => None,
    }
}

#[tauri::command(async)]
pub fn chain_sales_head_set(url: String) -> Result<Value, String> {
    refuse_locked()?;
    let u = head_set_in(&cs::chain_dir_path(), &url)?;
    Ok(json!({ "head": u }))
}

#[tauri::command]
pub async fn chain_sales_push_now() -> Result<Value, String> {
    refuse_locked()?;
    if cs::store_self_in(&cs::chain_dir_path()).is_none() {
        return Err(ERR_NOT_STORE.into());
    }
    Ok(push_now().await)
}

/// 매장 PC(새 컴퓨터): 본점이 받아 둔 이 매장 기록을 되찾는다. 이 컴퓨터에 결제 기록이 한 줄도 없을 때만.
#[tauri::command]
pub async fn chain_sales_pull_log() -> Result<Value, String> {
    refuse_locked()?;
    let dir = cs::chain_dir_path();
    if cs::store_self_in(&dir).is_none() {
        return Err(ERR_NOT_STORE.into());
    }
    let _g = PUSHING.lock().await;
    let Some(_os) = crate::pos_pay::os_lock(&dir.join("push.lock")) else {
        return Ok(json!({ "ok": false, "why": "busy" }));
    };
    let Some(url) = head_url_in(&dir) else { return Ok(json!({ "ok": false, "why": "no-head" })) };
    let root = crate::pos_pay::pos_root_path();
    pull_log_with(&dir, &root, |b| post_owned(url.clone(), b), now_ms).await
}

/// 본점 합계 — 금액이 보이므로 잠김이면 거절. 구간은 화면이 지역 시각으로 넘긴다(pos_day 와 같음).
#[tauri::command(async)]
pub fn chain_sales_totals(day_from: i64, day_to: i64, month_from: i64, month_to: i64) -> Result<Value, String> {
    refuse_locked()?;
    let dir = cs::chain_dir_path();
    if !dir.join("issued.json").exists() {
        return Err(ERR_NOT_OWNER.into());
    }
    Ok(totals_in(&dir, (day_from, day_to), (month_from, month_to), now_ms()))
}

/// 본점: ③ 이전에 만든 매장들의 데이터 열쇠를 채운다(12단어 한 번 — 체인 열쇠는 쓰고 바로 지운다).
#[tauri::command]
pub async fn chain_sales_prepare() -> Result<Value, String> {
    refuse_locked()?;
    let dir = cs::chain_dir_path();
    if !dir.join("issued.json").exists() {
        return Err(ERR_NOT_OWNER.into());
    }
    let missing = missing_keys(&dir);
    let need_backup_key = crate::chain_backup::needs_key(&dir) || !dir.join("relay-roster.json").exists();
    if missing.is_empty() && !need_backup_key {
        return Ok(json!({ "ok": true, "added": 0 }));
    }
    let (mut chain_sk, _) = cs::owner_keys(None, Vec::new()).await?;
    // ④⑤ 체인 비밀이 손에 있는 김에 백업 열쇠·릴레이 이웃 명부도.
    let _ = crate::chain_backup::remember_key_in(&dir, &chain_sk);
    let _ = cs::write_relay_roster_in(&dir, &chain_sk, my_talk_pub().as_deref(), now_ms());
    let mut added = 0;
    let mut err = None;
    for k in &missing {
        match remember_key_in(&dir, &chain_sk, k) {
            Ok(()) => added += 1,
            Err(e) => err = Some(e),
        }
    }
    crate::words::wipe_bytes(&mut chain_sk);
    match err {
        Some(e) if added == 0 && !missing.is_empty() => Err(e.into()),
        _ => Ok(json!({ "ok": true, "added": added })),
    }
}

/// 켜져 있는 동안 1분마다: 매장이면 10분마다 보내기, 본점이면 꺼짐 확인 + 사장에게 쪽지(한 끊김에 한 통).
/// 🔸 잠금 화면이어도 돈다 — 이미 서명·봉한 줄을 보내고 받을 뿐이고(새 기록·서명 없음), 멈추면 본점에 「꺼짐」이 잘못 뜬다.
pub async fn run_loop() {
    loop {
        tokio::time::sleep(std::time::Duration::from_secs(60)).await;
        let dir = cs::chain_dir_path();
        let now = now_ms();
        if cs::store_self_in(&dir).is_some() {
            let ps = push_state(&dir);
            let last = ps.get("lastTryAt").and_then(Value::as_i64).unwrap_or(0);
            if head_url_in(&dir).is_some() && (now - last >= PUSH_EVERY_MS || now < last) {
                let _ = push_now().await;
            }
        } else if dir.join("issued.json").exists() {
            let d2 = dir.clone();
            let down = tokio::task::spawn_blocking(move || {
                // ④ 맡는 매장이 정해져 있으면 6시간마다 본점 백업을 다시 묶는다(backup-key.json 의 대칭 열쇠로 봉함).
                crate::chain_backup::build_if_due_in(&d2, now);
                watch_tick_in(&d2, now)
            }).await.unwrap_or_default();
            for (n, name) in down {
                if send_self_dm(&offline_text(n, &name)).await {
                    mark_dm_sent(&dir, n);
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pos_pay::{record_in, void_in, PayInput};

    const WORDS: &str = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
    const NOW: i64 = 1_790_000_000_000;

    fn fresh(name: &str) -> PathBuf {
        let d = crate::paths::test_fixture_root().join(format!("chain-sales-{name}"));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }
    fn none(_: &str) -> Option<(i64, String, String)> {
        None
    }
    fn pay(method: &str, amount: i64, number: Option<&str>) -> PayInput {
        PayInput { method: method.into(), amount: Some(amount), number: number.map(String::from), ..Default::default() }
    }
    struct World {
        owner: PathBuf,
        csk: [u8; 32],
        chain: String,
    }
    /// 본점 하나 + 매장 n(PC 하나 = (chain 폴더, pos 폴더)).
    fn world(name: &str) -> (World, PathBuf) {
        let base = fresh(name);
        let owner = base.join("owner");
        std::fs::create_dir_all(&owner).unwrap();
        let csk = crate::identity::chain_key_from(WORDS, "").unwrap();
        let chain = cs::pubkey(&csk).unwrap();
        (World { owner, csk, chain }, base)
    }
    fn add_store(w: &World, base: &Path, n: u32, store_name: &str, biz_no: &str, sub: Option<&str>, remember: bool) -> (PathBuf, PathBuf) {
        let ssk = crate::identity::chain_store_key_from(WORDS, "", n, 0).unwrap();
        let biz = cs::clean_biz(biz_no, sub).unwrap();
        let r = cs::issue_in(&w.owner, &w.csk, &ssk, n, store_name, &biz, NOW).unwrap();
        if remember {
            remember_key_in(&w.owner, &w.csk, &r.store_pubkey).unwrap();
        }
        let pc = base.join(format!("store{n}"));
        let (chain_dir, root) = (pc.join("chain"), pc.join("pos"));
        std::fs::create_dir_all(&chain_dir).unwrap();
        cs::join_in(&chain_dir, &r.bundle, &r.install_words, NOW).unwrap();
        (chain_dir, root)
    }
    fn send_to(owner: &Path, now: i64) -> impl FnMut(&[u8]) -> Option<(u16, Vec<u8>)> + '_ {
        move |b: &[u8]| {
            let (s, v) = receive_in(owner, b, now, "lan");
            Some((s, serde_json::to_vec(&v).unwrap()))
        }
    }
    fn received(owner: &Path, n: u32) -> Vec<Value> {
        received_lines(owner, n, 0)
    }

    #[test]
    fn a_second_program_on_the_head_pc_does_not_write_state_at_the_same_time() {
        let (w, base) = world("oslock");
        let (cd, root) = add_store(&w, &base, 2, "역삼점", "123-45-67890", None, true);
        record_in(&root, &cd, &pay("cash", 4500, None), &none, NOW).unwrap();
        // 다른 레이븐볼트가 본점 받기 잠금을 쥐고 있다.
        let other = crate::pos_pay::os_lock(&sales_dir(&w.owner).join(".lock")).unwrap();
        let r = push_with(&cd, &root, NOW + 10, &mut send_to(&w.owner, NOW + 10)).unwrap();
        assert_eq!(r[0], Sent::Refused("busy".into()));
        assert!(received(&w.owner, 2).is_empty(), "잠겨 있는데 받았다");
        assert!(watch_tick_in(&w.owner, NOW + 3_600_000).is_empty(), "잠겨 있는데 꺼짐을 셌다");
        drop(other);
        let r = push_with(&cd, &root, NOW + 20, &mut send_to(&w.owner, NOW + 20)).unwrap();
        assert!(matches!(r[0], Sent::Acked { progressed: true, .. }));
        assert_eq!(received(&w.owner, 2).len(), 2);
    }

    #[test]
    fn data_key_matches_both_sides_and_seal_round_trips() {
        let csk = crate::identity::chain_key_from(WORDS, "").unwrap();
        let ssk = crate::identity::chain_store_key_from(WORDS, "", 3, 0).unwrap();
        let (chain, store) = (cs::pubkey(&csk).unwrap(), cs::pubkey(&ssk).unwrap());
        let a = data_key(&ssk, &chain, &chain, &store).unwrap();
        let b = data_key(&csk, &store, &chain, &store).unwrap();
        assert_eq!(a.0, b.0, "매장·본점이 같은 열쇠를 얻는다");
        let other = crate::identity::chain_store_key_from(WORDS, "", 4, 0).unwrap();
        let c = data_key(&other, &chain, &chain, &cs::pubkey(&other).unwrap()).unwrap();
        assert_ne!(a.0, c.0, "매장마다 다르다");
        let boxed = seal(&a, b"aad", b"hello sales").unwrap();
        assert_eq!(open(&b, b"aad", &boxed).unwrap(), b"hello sales");
        assert!(open(&b, b"other aad", &boxed).is_none(), "머리를 바꾸면 못 연다");
        assert!(open(&c, b"aad", &boxed).is_none(), "다른 열쇠로는 못 연다");
        // 틀린 체인 열쇠(다른 12단어)로 만든 열쇠는 못 연다
        let wrong = crate::identity::chain_key_from("zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo wrong", "").unwrap();
        let wk = data_key(&wrong, &store, &chain, &store).unwrap();
        assert!(open(&wk, b"aad", &boxed).is_none());
        assert!(!boxed.contains("hello"));
    }

    #[test]
    fn push_round_trip_resend_is_idempotent_and_totals_are_computed_by_head() {
        let (w, base) = world("rt");
        let (cd, root) = add_store(&w, &base, 7, "강남점", "123-45-67890", Some("0001"), true);
        record_in(&root, &cd, &pay("cash", 4500, None), &none, NOW).unwrap();
        let card = record_in(&root, &cd, &pay("card", 12000, Some("30512299")), &none, NOW + 1).unwrap();
        record_in(&root, &cd, &pay("cash_receipt", 8000, Some("123456")), &none, NOW + 2).unwrap();
        void_in(&root, &cd, card["seq"].as_u64().unwrap(), None, NOW + 3).unwrap();
        // 보내기 전: 안 보낸 줄 5(open + 매출 3 + 취소 1)
        assert_eq!(store_status_in(&cd, &root, NOW)["pending"], 5);
        let mut send = send_to(&w.owner, NOW + 10);
        let r = push_with(&cd, &root, NOW + 10, &mut send).unwrap();
        assert_eq!(r[0], Sent::Acked { ack: Some(4), progressed: true, warn: None });
        let st = store_status_in(&cd, &root, NOW + 10);
        assert_eq!((st["pending"].as_u64(), st["connected"].as_bool()), (Some(0), Some(true)));
        assert_eq!(received(&w.owner, 7).len(), 5);
        // 다시 보내도(본점 ack 를 잃은 척) 한 번만 쌓인다
        std::fs::remove_file(push_file(&cd)).unwrap();
        let r = push_with(&cd, &root, NOW + 20, &mut send_to(&w.owner, NOW + 20)).unwrap();
        assert_eq!(r[0], Sent::Acked { ack: Some(4), progressed: true, warn: None });
        assert_eq!(received(&w.owner, 7).len(), 5, "같은 줄은 한 번만");
        // 새 줄 하나 → 그것만 간다
        record_in(&root, &cd, &pay("cash", 1000, None), &none, NOW + 30).unwrap();
        push_with(&cd, &root, NOW + 31, &mut send_to(&w.owner, NOW + 31)).unwrap();
        assert_eq!(received(&w.owner, 7).len(), 6);
        // 합계는 본점이 줄에서 센다: 4500 + 12000 + 8000 - 12000 + 1000
        let t = totals_in(&w.owner, (NOW - 1000, NOW + 100_000), (NOW - 10_000_000, NOW + 10_000_000), NOW + 40);
        let s = &t["stores"][0];
        assert_eq!(s["today"]["net"], 13500);
        assert_eq!(s["today"]["count"], 4);
        assert_eq!(s["today"]["methods"]["card"], 0, "취소는 빠진다");
        assert_eq!(s["today"]["methods"]["cash"], 5500);
        assert_eq!(t["all"]["month"]["net"], 13500);
        // 터널로 지나간 바이트에 줄 내용이 보이지 않는다
        let o = {
            std::fs::remove_file(push_file(&cd)).unwrap();
            prepare_in(&cd, &root, NOW + 50, false).unwrap().unwrap()
        };
        let wire = String::from_utf8(o.body.clone()).unwrap();
        assert!(!wire.contains("30512299") && !wire.contains("\"amount\""), "봉하지 않은 매출이 선에 있다");
        let ssk = crate::identity::chain_store_key_from(WORDS, "", 7, 0).unwrap();
        assert!(!wire.contains(&hex::encode(ssk)) && !wire.contains(&hex::encode(w.csk)));
    }

    #[test]
    fn revoked_expired_and_wrong_chain_are_rejected_and_logged() {
        let (w, base) = world("rv");
        let (cd, root) = add_store(&w, &base, 2, "2호점", "1234567890", None, true);
        record_in(&root, &cd, &pay("cash", 100, None), &none, NOW).unwrap();
        // 만료(1년 뒤)
        let later = NOW + cs::CERT_LIFE_MS + 1;
        let r = push_with(&cd, &root, later, &mut send_to(&w.owner, later)).unwrap();
        assert_eq!(r[0], Sent::Refused("expired".into()));
        assert!(received(&w.owner, 2).is_empty());
        assert_eq!(store_status_in(&cd, &root, later)["connected"], false);
        // 끊김
        cs::revoke_in(&w.owner, &w.csk, 1, NOW + 100).unwrap();
        let r = push_with(&cd, &root, NOW + 200, &mut send_to(&w.owner, NOW + 200)).unwrap();
        assert_eq!(r[0], Sent::Refused("revoked".into()));
        let rj = rejects(&w.owner, 10);
        assert!(rj.iter().any(|x| x["why"] == "revoked") && rj.iter().any(|x| x["why"] == "expired"));
        assert!(!std::fs::read_to_string(sales_dir(&w.owner).join("rejects.jsonl")).unwrap().contains("sig"), "거절 기록에 증서·비밀 없음");
        // 다른 본점에 보내면 거절
        let (w2, _) = world("rv-other");
        let other = w2.owner.clone();
        let wrong_csk = crate::identity::chain_key_from("zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo wrong", "").unwrap();
        let ssk = crate::identity::chain_store_key_from(WORDS, "", 9, 0).unwrap();
        cs::issue_in(&other, &wrong_csk, &ssk, 9, "남의 점", &cs::clean_biz("1234567890", None).unwrap(), NOW).unwrap();
        let r = push_with(&cd, &root, NOW + 300, &mut send_to(&other, NOW + 300)).unwrap();
        assert_eq!(r[0], Sent::Refused("not-head".into()), "다른 본점이라고 알려 주지 않는다");
        // 본점이 아닌 곳
        let (s, _) = receive_in(&cd, b"{}", NOW, "lan");
        assert_eq!(s, 404);
    }

    #[test]
    fn missing_data_key_asks_for_prepare_then_works() {
        let (w, base) = world("prep");
        let (cd, root) = add_store(&w, &base, 5, "5호점", "1234567890", None, false);
        record_in(&root, &cd, &pay("cash", 100, None), &none, NOW).unwrap();
        assert_eq!(owner_status_in(&w.owner)["needPrepare"], 1);
        let r = push_with(&cd, &root, NOW + 1, &mut send_to(&w.owner, NOW + 1)).unwrap();
        assert_eq!(r[0], Sent::Refused("need-prepare".into()));
        for k in missing_keys(&w.owner) {
            remember_key_in(&w.owner, &w.csk, &k).unwrap();
        }
        assert_eq!(owner_status_in(&w.owner)["needPrepare"], 0);
        let r = push_with(&cd, &root, NOW + 2, &mut send_to(&w.owner, NOW + 2)).unwrap();
        assert!(matches!(r[0], Sent::Acked { progressed: true, .. }));
        // 데이터 열쇠 파일에 체인 비밀·12단어 없음
        let f = std::fs::read_to_string(keys_file(&w.owner)).unwrap();
        assert!(!f.contains(&hex::encode(w.csk)) && !f.contains("abandon"));
    }

    #[test]
    fn gap_and_tamper_are_rejected_with_a_warning() {
        let (w, base) = world("tamper");
        let (cd, root) = add_store(&w, &base, 3, "3호점", "1234567890", None, true);
        for i in 0..3 {
            record_in(&root, &cd, &pay("cash", 1000 + i, None), &none, NOW + i).unwrap();
        }
        push_with(&cd, &root, NOW + 10, &mut send_to(&w.owner, NOW + 10)).unwrap();
        assert_eq!(received(&w.owner, 3).len(), 4);
        // 매장이 ack 를 잘못 앞으로 당긴다(줄 4·5 를 건너뜀) → 본점은 gap 으로 거절하고 경고
        for i in 0..3 {
            record_in(&root, &cd, &pay("cash", 2000 + i, None), &none, NOW + 20 + i).unwrap();
        }
        let mut ps = push_state(&cd);
        ps["ack"] = json!(4);
        write_json(&push_file(&cd), &ps).unwrap();
        let r = push_with(&cd, &root, NOW + 30, &mut send_to(&w.owner, NOW + 30)).unwrap();
        assert_eq!(r[0], Sent::Acked { ack: Some(3), progressed: false, warn: Some("gap".into()) });
        assert_eq!(received(&w.owner, 3).len(), 4, "건너뛴 묶음은 받지 않는다");
        let t = totals_in(&w.owner, (0, i64::MAX), (0, i64::MAX), NOW + 31);
        assert_eq!(t["stores"][0]["warn"]["why"], "gap");
        // 다음 보내기는 ack(3) 다음부터 다시 → 모두 받는다
        let r = push_with(&cd, &root, NOW + 40, &mut send_to(&w.owner, NOW + 40)).unwrap();
        assert_eq!(r[0], Sent::Acked { ack: Some(6), progressed: true, warn: None });
        assert_eq!(received(&w.owner, 3).len(), 7);

        // 매장 PC 에서 아직 안 보낸 줄의 금액을 고친다(서명이 깨진다) → 앞부분만 받고 경고
        record_in(&root, &cd, &pay("cash", 500, None), &none, NOW + 50).unwrap();
        record_in(&root, &cd, &pay("cash", 600, None), &none, NOW + 51).unwrap();
        let dir = root.join("log").join(crate::pos_pay::ctx_in(&root, &cd).scope);
        let (_, file) = month_files(&dir).pop().unwrap();
        let text = std::fs::read_to_string(&file).unwrap().replace("\"amount\":600", "\"amount\":60");
        std::fs::write(&file, text).unwrap();
        let r = push_with(&cd, &root, NOW + 60, &mut send_to(&w.owner, NOW + 60)).unwrap();
        assert_eq!(r[0], Sent::Acked { ack: Some(7), progressed: true, warn: Some("signature".into()) });
        let got = received(&w.owner, 3);
        assert_eq!(got.len(), 8, "고친 줄(No.8)은 받지 않는다");
        assert!(got.iter().all(|l| l["amount"] != 60));
        assert!(rejects(&w.owner, 5).iter().any(|x| x["why"] == "lines-signature"));
        // 받은 줄은 모두 매장 열쇠 서명·사슬이 맞다
        let store_key = cs::store_self_in(&cd).unwrap().store_key;
        let lid = push_state(&cd)["logId"].as_str().unwrap().to_string();
        let mut all = Vec::new();
        for (_, f) in month_files(&store_dir(&w.owner, 3).join(&lid)) {
            all.extend(std::fs::read_to_string(f).unwrap().lines().map(|l| serde_json::from_str::<Value>(l).unwrap()));
        }
        assert!(crate::pos_pay::verify_records(&all, Some(&store_key)).broken.is_none());
    }

    #[test]
    fn forged_reply_or_tampered_box_is_not_trusted() {
        let (w, base) = world("forge");
        let (cd, root) = add_store(&w, &base, 4, "4호점", "1234567890", None, true);
        record_in(&root, &cd, &pay("cash", 100, None), &none, NOW).unwrap();
        // 가짜 본점(터널 가로채기)이 「다 받았어요」라고 해도 봉함이 없으니 믿지 않는다
        let r = push_with(&cd, &root, NOW, &mut |_b: &[u8]| Some((200, br#"{"v":1,"box":"AAAA"}"#.to_vec()))).unwrap();
        assert_eq!(r[0], Sent::Failed("bad-reply"));
        assert!(push_state(&cd).get("ack").is_none_or(Value::is_null));
        // 묶음 바이트를 바꾸면 본점이 거절
        let o = prepare_in(&cd, &root, NOW, false).unwrap().unwrap();
        let mut v: Value = serde_json::from_slice(&o.body).unwrap();
        v["from"] = json!(1);
        let (s, body) = receive_in(&w.owner, &serde_json::to_vec(&v).unwrap(), NOW, "lan");
        assert_eq!((s, body["reason"].as_str()), (400, Some("bad-box")));
        // 닿지 않음
        let r = push_with(&cd, &root, NOW, &mut |_b: &[u8]| None).unwrap();
        assert_eq!(r[0], Sent::Failed("unreachable"));
        assert_eq!(store_status_in(&cd, &root, NOW)["connected"], false);
    }

    #[test]
    fn totals_group_by_business_with_sub_businesses_together() {
        let (w, base) = world("biz");
        let (a, ra) = add_store(&w, &base, 1, "본점앞", "111-11-11111", Some("0001"), true);
        let (b, rb) = add_store(&w, &base, 2, "역삼점", "111-11-11111", Some("0002"), true);
        let (c, rc) = add_store(&w, &base, 3, "따로점", "222-22-22222", None, true);
        record_in(&ra, &a, &pay("cash", 1000, None), &none, NOW).unwrap();
        record_in(&rb, &b, &pay("card", 2000, Some("1111")), &none, NOW).unwrap();
        let s = record_in(&rb, &b, &pay("card", 500, Some("2222")), &none, NOW + 1).unwrap();
        void_in(&rb, &b, s["seq"].as_u64().unwrap(), None, NOW + 2).unwrap();
        record_in(&rc, &c, &pay("cash", 4000, None), &none, NOW - 40 * 86_400_000).unwrap(); // 지난달
        record_in(&rc, &c, &pay("rvn", 300, Some(&"ab".repeat(32))), &none, NOW).unwrap();
        for (cd, root) in [(&a, &ra), (&b, &rb), (&c, &rc)] {
            push_with(cd, root, NOW + 5, &mut send_to(&w.owner, NOW + 5)).unwrap();
        }
        let month = (NOW - 10 * 86_400_000, NOW + 10 * 86_400_000);
        let t = totals_in(&w.owner, (NOW - 1000, NOW + 1000), month, NOW + 10);
        assert_eq!(t["all"]["today"]["net"], 1000 + 2000 + 300);
        assert_eq!(t["all"]["month"]["net"], 3300, "지난달 4000 은 이번 달에 없다");
        let biz = t["biz"].as_array().unwrap();
        assert_eq!(biz.len(), 2);
        let one = biz.iter().find(|x| x["no"] == "1111111111").unwrap();
        assert_eq!(one["stores"], json!([1, 2]));
        assert_eq!(one["subs"], json!(["0001", "0002"]));
        assert_eq!(one["today"]["net"], 3000);
        assert_eq!(one["today"]["methods"]["card"], 2000);
        let two = biz.iter().find(|x| x["no"] == "2222222222").unwrap();
        assert_eq!((two["today"]["net"].as_i64(), two["today"]["methods"]["rvn"].as_i64()), (Some(300), Some(300)));
        assert_eq!(t["stores"].as_array().unwrap().len(), 3);
    }

    #[test]
    fn offline_alert_fires_once_per_outage_and_clears() {
        let mut w = Watch::default();
        assert!(!w.tick(NOW + 99 * PUSH_EVERY_MS), "한 번도 안 온 매장은 알리지 않는다");
        w.seen(NOW);
        assert!(!w.tick(NOW + 2 * PUSH_EVERY_MS + 59_000), "두 번 놓친 것은 아직");
        assert!(w.tick(NOW + 3 * PUSH_EVERY_MS), "세 번째 창에서 알림");
        assert!(w.alerted);
        assert!(!w.tick(NOW + 4 * PUSH_EVERY_MS) && !w.tick(NOW + 30 * PUSH_EVERY_MS), "한 끊김에 한 번만");
        assert!(w.seen(NOW + 31 * PUSH_EVERY_MS), "돌아오면 지운다");
        assert!(!w.alerted);
        assert!(!w.tick(NOW + 32 * PUSH_EVERY_MS));
        assert!(w.tick(NOW + 34 * PUSH_EVERY_MS), "다음 끊김엔 다시 한 번");

        // 본점 파일 위에서도 같은 흐름: 받기 → 30분 → 꺼짐 1번 → 쪽지 보냄 표시 → 다시 받으면 지움
        let (wd, base) = world("watch");
        let (cd, root) = add_store(&wd, &base, 6, "6호점", "1234567890", None, true);
        record_in(&root, &cd, &pay("cash", 100, None), &none, NOW).unwrap();
        push_with(&cd, &root, NOW, &mut send_to(&wd.owner, NOW)).unwrap();
        assert!(watch_tick_in(&wd.owner, NOW + PUSH_EVERY_MS).is_empty());
        assert_eq!(watch_tick_in(&wd.owner, NOW + 3 * PUSH_EVERY_MS), vec![(6, "6호점".to_string())]);
        // 쪽지를 못 보냈으면 다음 틱에 다시 시도(같은 끊김) — 보냈다고 적으면 더는 없음
        assert_eq!(watch_tick_in(&wd.owner, NOW + 4 * PUSH_EVERY_MS).len(), 1);
        mark_dm_sent(&wd.owner, 6);
        assert!(watch_tick_in(&wd.owner, NOW + 5 * PUSH_EVERY_MS).is_empty());
        let t = totals_in(&wd.owner, (0, 1), (0, 1), NOW + 5 * PUSH_EVERY_MS);
        assert_eq!(t["stores"][0]["offline"], true);
        record_in(&root, &cd, &pay("cash", 100, None), &none, NOW + 6 * PUSH_EVERY_MS).unwrap();
        push_with(&cd, &root, NOW + 6 * PUSH_EVERY_MS, &mut send_to(&wd.owner, NOW + 6 * PUSH_EVERY_MS)).unwrap();
        let t = totals_in(&wd.owner, (0, 1), (0, 1), NOW + 6 * PUSH_EVERY_MS);
        assert_eq!(t["stores"][0]["offline"], false);
        // 끊긴 매장은 꺼짐 알림 대상이 아니다
        cs::revoke_in(&wd.owner, &wd.csk, 1, NOW + 7 * PUSH_EVERY_MS).unwrap();
        assert!(watch_tick_in(&wd.owner, NOW + 20 * PUSH_EVERY_MS).is_empty());
        assert!(offline_text(6, "6호점").contains("6호점"));
    }

    #[test]
    fn quiet_store_still_says_it_is_alive_so_it_is_not_marked_offline() {
        let (wd, base) = world("beat");
        let (cd, root) = add_store(&wd, &base, 8, "8호점", "1234567890", None, true);
        // 아직 결제가 하나도 없어도 신호는 간다
        let r = push_with(&cd, &root, NOW, &mut send_to(&wd.owner, NOW)).unwrap();
        assert_eq!(r, vec![Sent::Acked { ack: None, progressed: false, warn: None }]);
        assert_eq!(store_status_in(&cd, &root, NOW)["connected"], true);
        record_in(&root, &cd, &pay("cash", 100, None), &none, NOW + 1).unwrap();
        push_with(&cd, &root, NOW + 2, &mut send_to(&wd.owner, NOW + 2)).unwrap();
        // 30분 동안 손님이 없어도 10분마다 빈 신호 → 꺼짐 아님
        for k in 1..=4 {
            let t = NOW + k * PUSH_EVERY_MS;
            let r = push_with(&cd, &root, t, &mut send_to(&wd.owner, t)).unwrap();
            assert_eq!(r, vec![Sent::Acked { ack: Some(1), progressed: false, warn: None }]);
            assert!(watch_tick_in(&wd.owner, t + 1).is_empty());
        }
        assert_eq!(received(&wd.owner, 8).len(), 2, "빈 신호는 아무것도 쌓지 않는다");
        assert!(!store_dir(&wd.owner, 8).join(NO_LOG).exists());
    }

    #[test]
    fn store_keeps_revocation_list_only_when_it_moves_forward() {
        let (w, base) = world("revlist");
        let (cd, root) = add_store(&w, &base, 1, "1호점", "1234567890", None, true);
        let (_c2, _r2) = add_store(&w, &base, 2, "2호점", "1234567890", None, true);
        record_in(&root, &cd, &pay("cash", 100, None), &none, NOW).unwrap();
        let old = read_json(&w.owner.join("revocations.json")).unwrap();
        assert_eq!(old["seq"], 1);
        // 2호점을 끊은 목록(seq 2)을 1호점이 push 응답으로 받는다
        let (list2, _) = cs::revoke_in(&w.owner, &w.csk, 2, NOW + 1).unwrap();
        push_with(&cd, &root, NOW + 2, &mut send_to(&w.owner, NOW + 2)).unwrap();
        let mine = read_json(&cd.join("revocations.json")).unwrap();
        assert_eq!(mine["seq"], list2["seq"]);
        // 옛 목록(seq 1)으로 되돌릴 수 없다
        assert!(!cs::accept_list_in(&cd, &w.chain, &json!({"seq": 1})).unwrap_or(false));
        assert_eq!(cs::accept_list_in(&cd, &w.chain, &old), Ok(false));
        assert_eq!(read_json(&cd.join("revocations.json")).unwrap()["seq"], 2);
    }

    #[test]
    fn head_url_shapes() {
        assert_eq!(clean_head_url("https://abc-def.trycloudflare.com/").unwrap(), "https://abc-def.trycloudflare.com");
        assert_eq!(clean_head_url(" http://192.168.0.10 ").unwrap(), "http://192.168.0.10:8790");
        assert_eq!(clean_head_url("http://bonjeom.local:8790").unwrap(), "http://bonjeom.local:8790");
        for bad in ["http://example.com", "https://localhost", "https://1.2.3.4", "ftp://a.b", "https://a.b/x", "https://u@a.b", "http://8.8.8.8:8790",
            "https://a.b:99999", "https://a..b", "192.168.0.10", "https://a.b?x=1", "http://10.0.0.1:"] {
            assert!(clean_head_url(bad).is_err(), "{bad}");
        }
        let d = fresh("head");
        assert_eq!(head_set_in(&d, "https://a.example.com").unwrap_err(), ERR_NOT_STORE);
    }

    #[test]
    fn no_secret_reaches_errors_or_logs() {
        // 고정 문장만 — 열쇠·12단어를 끼워 넣는 format! 이 없다.
        let src = include_str!("chain_sales.rs");
        let body = &src[..src.find("#[cfg(test)]\nmod tests").unwrap()];
        for bad in ["eprintln!", "println!", "{sk", "{key", "{chain_sk", "dbg!"] {
            assert!(!body.contains(bad), "{bad}");
        }
    }

    /// 매장 PC 로그 끝에 매장 열쇠로 서명한 줄을 손으로 덧붙인다(매장 열쇠를 가진 사람이 만든 「올바르게 서명된 이상한 줄」).
    fn craft(cd: &Path, root: &Path, mut body: Map<String, Value>) -> Value {
        let (scope, _, lines) = crate::pos_pay::log_lines_in(root, cd);
        let last = lines.last().unwrap();
        let me = cs::store_self_in(cd).unwrap();
        body.insert("v".into(), json!(1));
        body.insert("seq".into(), json!(last["seq"].as_u64().unwrap() + 1));
        body.insert("prev".into(), json!(record_hash(last).unwrap()));
        body.insert("key".into(), json!(me.store_key));
        body.entry("store").or_insert(json!(me.store));
        body.entry("at").or_insert(json!(NOW + 100));
        let rec = cs::sign_as_store_in(cd, crate::pos_pay::SALE_DOMAIN, &Value::Object(body)).unwrap();
        let dir = root.join("log").join(scope);
        let (_, f) = month_files(&dir).pop().unwrap();
        std::fs::OpenOptions::new().append(true).open(f).unwrap().write_all(format!("{}\n", canonical_string(&rec).unwrap()).as_bytes()).unwrap();
        rec
    }
    fn obj(v: Value) -> Map<String, Value> {
        v.as_object().unwrap().clone()
    }

    #[test]
    fn replayed_heartbeat_does_not_mark_a_dead_store_alive_and_clock_must_be_close() {
        let (w, base) = world("replay");
        let (cd, root) = add_store(&w, &base, 11, "11호점", "1234567890", None, true);
        let beat = prepare_in(&cd, &root, NOW, true).unwrap().unwrap();
        assert_eq!(receive_in(&w.owner, &beat.body, NOW, "lan").0, 200);
        // 매장이 꺼졌다. 누군가 주운 신호를 30분 뒤에 다시 보낸다 → 되풀이 거절, 꺼짐은 그대로 뜬다.
        let t = NOW + 3 * PUSH_EVERY_MS;
        let (s, b) = receive_in(&w.owner, &beat.body, t, "cf:198.51.100.7");
        assert_eq!((s, b["reason"].as_str()), (409, Some("replay")));
        assert_eq!(watch_tick_in(&w.owner, t), vec![(11, "11호점".to_string())], "되풀이한 신호로 살아난 척하지 않는다");
        // 매장 시계가 두 시간 틀리면 받지 않는다
        let skew = prepare_in(&cd, &root, t, true).unwrap().unwrap();
        let (s, b) = receive_in(&w.owner, &skew.body, t + 2 * 3_600_000, "lan");
        assert_eq!((s, b["reason"].as_str()), (400, Some("bad-clock")));
        // 제대로 된 새 신호는 받는다 → 꺼짐이 풀린다
        let ok = prepare_in(&cd, &root, t + 1000, true).unwrap().unwrap();
        assert_eq!(receive_in(&w.owner, &ok.body, t + 1000, "lan").0, 200);
        assert_eq!(totals_in(&w.owner, (0, 1), (0, 1), t + 1000)["stores"][0]["offline"], false);
        // 매장 sentAt 은 같은 밀리초에도 늘기만 한다
        let a = prepare_in(&cd, &root, t + 5000, true).unwrap().unwrap();
        let b2 = prepare_in(&cd, &root, t + 5000, true).unwrap().unwrap();
        let sa = |o: &Outgoing| serde_json::from_slice::<Value>(&o.body).unwrap()["sentAt"].as_i64().unwrap();
        assert!(sa(&b2) > sa(&a));
    }

    #[test]
    fn junk_has_its_own_bucket_and_counters_and_legit_stores_do_not_drain_it() {
        let (w, base) = world("rate");
        let (cd, root) = add_store(&w, &base, 12, "12호점", "1234567890", None, true);
        let lines_before = rejects(&w.owner, 100).len();
        // 쓰레기 60번(같은 곳) → 그곳의 다음 요청은 올바른 것이라도 404. 다른 곳(lan)은 그대로.
        for _ in 0..PRE_PER_MIN {
            assert_eq!(receive_in(&w.owner, b"{\"junk\":1}", NOW, "cf:203.0.113.9"), deny(404, "not-head"));
        }
        let o = prepare_in(&cd, &root, NOW, true).unwrap().unwrap();
        assert_eq!(receive_in(&w.owner, &o.body, NOW, "cf:203.0.113.9").0, 404);
        assert_eq!(receive_in(&w.owner, &o.body, NOW, "lan").0, 200);
        assert_eq!(rejects(&w.owner, 100).len(), lines_before, "인증 전 거절은 줄로 남지 않는다");
        assert!(junk_counts(&w.owner)["shape"].as_u64().unwrap_or(0) >= PRE_PER_MIN as u64);
        assert!(junk_counts(&w.owner)["rate"].as_u64().unwrap_or(0) >= 1);
        // 올바른 매장의 요청은 인증 전 버킷을 줄이지 않는다 — 대신 매장별 1분 30번.
        let key = format!("{}|cf:192.0.2.1", w.owner.display());
        for i in 1..POST_PER_MIN {
            let o = prepare_in(&cd, &root, NOW + i as i64, true).unwrap().unwrap();
            assert_eq!(receive_in(&w.owner, &o.body, NOW + i as i64, "cf:192.0.2.1").0, 200, "{i}");
        }
        assert_eq!(bucket_count(&PRE, &key, NOW + 40), 0, "올바른 요청은 쓰레기 버킷을 쓰지 않는다");
        let o = prepare_in(&cd, &root, NOW + 50, true).unwrap().unwrap();
        assert_eq!(receive_in(&w.owner, &o.body, NOW + 50, "cf:192.0.2.1"), deny(429, "rate"));
        // 서명이 틀린 증서도 404(본점인지 알려 주지 않는다)
        let mut v: Value = serde_json::from_slice(&prepare_in(&cd, &root, NOW + 70_000, true).unwrap().unwrap().body).unwrap();
        v["cert"]["name"] = json!("가짜점");
        assert_eq!(receive_in(&w.owner, &serde_json::to_vec(&v).unwrap(), NOW + 70_000, "lan"), deny(404, "not-head"));
        // 버킷 열쇠 수는 상한이 있다
        for i in 0..(BUCKET_KEYS + 50) {
            bucket_hit(&PRE, &format!("{}|spoof{i}", w.owner.display()), NOW + 80_000);
        }
        assert!(PRE.lock().unwrap().as_ref().unwrap().map.len() <= BUCKET_KEYS + 1);
    }

    #[test]
    fn a_store_cannot_open_unlimited_logs() {
        let (w, base) = world("logs");
        let (cd, root) = add_store(&w, &base, 13, "13호점", "1234567890", None, true);
        record_in(&root, &cd, &pay("cash", 100, None), &none, NOW).unwrap();
        let sp = store_dir(&w.owner, 13).join("state.json");
        let mut logs = Map::new();
        for i in 0..MAX_LOGS_PER_STORE {
            logs.insert(format!("{i:032x}"), json!({ "ack": 0, "hash": ZERO, "month": 0 }));
        }
        write_json(&sp, &json!({ "v": 1, "logs": logs })).unwrap();
        let r = push_with(&cd, &root, NOW + 1, &mut send_to(&w.owner, NOW + 1)).unwrap();
        assert_eq!(r[0], Sent::Refused("too-many-logs".into()));
        assert_eq!(std::fs::read_dir(store_dir(&w.owner, 13)).unwrap().filter(|e| e.as_ref().unwrap().path().is_dir()).count(), 0);
        assert!(rejects(&w.owner, 5).iter().any(|x| x["why"] == "too-many-logs"));
    }

    #[test]
    fn bad_voids_are_kept_in_the_chain_but_left_out_of_totals_with_a_warning() {
        let (w, base) = world("voids");
        let (cd, root) = add_store(&w, &base, 14, "14호점", "1234567890", None, true);
        let s = record_in(&root, &cd, &pay("cash", 1000, None), &none, NOW).unwrap();
        let seq = s["seq"].as_u64().unwrap();
        void_in(&root, &cd, seq, None, NOW + 1).unwrap();
        // 같은 매출을 한 번 더 취소(올바르게 서명됨)
        craft(&cd, &root, obj(json!({ "kind": "void", "ref": seq, "method": "cash", "amount": -1000, "biz": null })));
        let r = push_with(&cd, &root, NOW + 10, &mut send_to(&w.owner, NOW + 10)).unwrap();
        assert!(matches!(&r[0], Sent::Acked { warn: Some(w), progressed: true, .. } if w == "void"), "{r:?}");
        assert_eq!(received(&w.owner, 14).len(), 3, "사슬은 그대로(open·sale·void), 두 번째 취소만 합계에서 뺀다");
        let t = totals_in(&w.owner, (NOW - 1000, NOW + 100_000), (0, i64::MAX), NOW + 20);
        assert_eq!(t["stores"][0]["today"]["net"], 0, "-1000 이 되면 안 된다");
        assert_eq!(t["stores"][0]["warn"]["why"], "void");
        // 판정표 단위: 없는 매출·금액 초과·수단 다름·두 번
        let mut idx = json!({ "sales": {}, "voided": [], "badVoids": [] });
        assert!(check_void(&mut idx, &json!({ "kind": "sale", "seq": 1, "amount": 500, "method": "card" })));
        assert!(!check_void(&mut idx, &json!({ "kind": "void", "seq": 2, "ref": 9, "amount": -1, "method": "card" })), "다른 로그·없는 매출");
        assert!(!check_void(&mut idx, &json!({ "kind": "void", "seq": 3, "ref": 1, "amount": -501, "method": "card" })), "금액 초과");
        assert!(!check_void(&mut idx, &json!({ "kind": "void", "seq": 4, "ref": 1, "amount": -500, "method": "cash" })), "수단 다름");
        assert!(check_void(&mut idx, &json!({ "kind": "void", "seq": 5, "ref": 1, "amount": -500, "method": "card" })));
        assert!(!check_void(&mut idx, &json!({ "kind": "void", "seq": 6, "ref": 1, "amount": -500, "method": "card" })), "두 번째");
        assert_eq!(idx["badVoids"], json!([2, 3, 4, 6]));
    }

    #[test]
    fn far_future_time_cannot_make_an_unreadable_month_file() {
        let (w, base) = world("future");
        let (cd, root) = add_store(&w, &base, 15, "15호점", "1234567890", None, true);
        record_in(&root, &cd, &pay("cash", 100, None), &none, NOW).unwrap();
        craft(&cd, &root, obj(json!({ "kind": "sale", "method": "cash", "amount": 7, "biz": null, "at": 1_000_000_000_000_000i64 })));
        push_with(&cd, &root, NOW + 1, &mut send_to(&w.owner, NOW + 1)).unwrap();
        let lid = push_state(&cd)["logId"].as_str().unwrap().to_string();
        let ldir = store_dir(&w.owner, 15).join(&lid);
        let cap = month_of(NOW + 1 + 2 * 86_400_000);
        for e in std::fs::read_dir(&ldir).unwrap() {
            let name = e.unwrap().file_name().into_string().unwrap();
            if name.ends_with(".jsonl") {
                let stem = name.trim_end_matches(".jsonl");
                assert!(stem.len() == 6 && stem.parse::<u32>().unwrap() <= cap, "{name}");
            }
        }
        assert_eq!(received(&w.owner, 15).len(), 3, "먼 미래 줄도 읽히는 파일에 있다");
    }


    // ── ④ 백업 두 곳 · 매장 기록 되찾기 ──

    fn async_send(owner: &Path, now: i64) -> impl FnMut(Vec<u8>) -> std::future::Ready<Option<(u16, Vec<u8>)>> + '_ {
        move |b: Vec<u8>| {
            let (s, v) = receive_in(owner, &b, now, "lan");
            std::future::ready(Some((s, serde_json::to_vec(&v).unwrap())))
        }
    }

    #[tokio::test]
    async fn head_backup_goes_to_one_neighbor_who_cannot_read_it_and_a_new_head_restores_it() {
        let (w, base) = world("bk");
        let (cd1, root1) = add_store(&w, &base, 1, "강남점", "123-45-67890", None, true);
        let (cd2, root2) = add_store(&w, &base, 2, "역삼점", "123-45-67890", Some("0002"), true);
        record_in(&root1, &cd1, &pay("cash", 4500, None), &none, NOW).unwrap();
        record_in(&root2, &cd2, &pay("card", 9900, Some("30512299")), &none, NOW).unwrap();
        push_with(&cd1, &root1, NOW + 10, &mut send_to(&w.owner, NOW + 10)).unwrap();
        push_with(&cd2, &root2, NOW + 10, &mut send_to(&w.owner, NOW + 10)).unwrap();
        // 맡을 매장 = 2번. 끊긴·없는 번호는 안 된다.
        assert_eq!(crate::chain_backup::set_keeper_in(&w.owner, Some(9)).unwrap_err(), crate::chain_backup::ERR_STORE_NUMBER);
        crate::chain_backup::set_keeper_in(&w.owner, Some(2)).unwrap();
        // 백업 열쇠가 없으면 묶지 않는다(12단어 한 번 — 맡기기 명령이 받는다).
        assert_eq!(crate::chain_backup::build_in(&w.owner, NOW + 20).unwrap_err(), crate::chain_backup::ERR_NEED_KEY);
        crate::chain_backup::remember_key_in(&w.owner, &w.csk).unwrap();
        let meta = crate::chain_backup::build_in(&w.owner, NOW + 20).unwrap();
        assert!(!crate::chain_backup::build_if_due_in(&w.owner, NOW + 30), "6시간 안에는 다시 묶지 않는다");

        // 1번 매장(맡지 않음)에는 요약도 조각도 가지 않는다.
        push_with(&cd1, &root1, NOW + 40, &mut send_to(&w.owner, NOW + 40)).unwrap();
        assert!(next_backup_op(&cd1).is_none());
        let o = prepare_op_in(&cd1, None, &json!({ "op": "backup", "offset": 0 }), NOW + 41).unwrap();
        let (st, v) = receive_in(&w.owner, &o.body, NOW + 41, "lan");
        let rep = apply_op_in(&cd1, &o, Some(st), &serde_json::to_vec(&v).unwrap(), NOW + 41).unwrap();
        assert_eq!(rep, json!({ "none": true }));

        // 2번 매장: 보내기 답에 요약 → 조각을 받아 맡아 둔다.
        push_with(&cd2, &root2, NOW + 50, &mut send_to(&w.owner, NOW + 50)).unwrap();
        assert!(fetch_backup_with(&cd2, async_send(&w.owner, NOW + 51), || NOW + 51).await >= 1);
        let held = crate::chain_backup::held_status_in(&cd2);
        assert_eq!(held["size"], meta["size"]);
        assert_eq!(crate::chain_backup::owner_status_in(&w.owner)["delivered"], true);
        // 같은 것을 다시 받지 않는다.
        push_with(&cd2, &root2, NOW + 60, &mut send_to(&w.owner, NOW + 60)).unwrap();
        assert!(next_backup_op(&cd2).is_none());

        // 맡은 매장은 열 수 없다: 평문 조각(매장 이름·사업자 번호·금액·데이터 열쇠)이 보이지 않고, 매장 열쇠로도 안 열린다.
        let blob = std::fs::read(cd2.join("held").join("head.rvb")).unwrap();
        for needle in ["강남점", "1234567890", "4500", "storeKey", "chain-backup"] {
            assert!(!blob.windows(needle.len()).any(|x| x == needle.as_bytes()), "맡은 백업에 {needle} 가 보인다");
        }
        let ssk = crate::identity::chain_store_key_from(WORDS, "", 2, 0).unwrap();
        assert!(crate::chain_backup::open_with_chain(&ssk, &blob).is_err());
        // 안을 열어 보면(체인 비밀) 데이터 열쇠·매장 비밀은 없다.
        let plain = String::from_utf8(crate::chain_backup::open_with_chain(&w.csk, &blob).unwrap()).unwrap();
        assert!(!plain.contains("sales-keys") && !plain.contains("backup-key") && !plain.contains("\"secret\""));
        let keys_text = std::fs::read_to_string(w.owner.join("sales-keys.json")).unwrap();
        let some_key = serde_json::from_str::<Value>(&keys_text).unwrap()["keys"].as_object().unwrap().values().next().unwrap().as_str().unwrap().to_string();
        assert!(!plain.contains(&some_key), "데이터 열쇠가 백업에 들어갔다");
        let bk: Value = serde_json::from_str(&std::fs::read_to_string(w.owner.join("backup-key.json")).unwrap()).unwrap();
        assert!(!plain.contains(bk["key"].as_str().unwrap()), "백업 열쇠가 백업에 들어갔다");

        // 새 본점 PC: 맡은 매장이 저장한 파일 → 12단어(체인 비밀)로 되살린다.
        let text = crate::chain_backup::held_text_in(&cd2).unwrap();
        let new_head = base.join("newhead");
        let other = crate::identity::chain_key_from("zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo wrong", "").unwrap();
        let blob2 = crate::chain_backup::from_text(&text).unwrap();
        let at = meta["at"].as_i64().unwrap();
        assert!(crate::chain_backup::restore_in(&new_head, &other, &blob2, at).is_err());
        assert!(!new_head.join("issued.json").exists(), "틀린 12단어인데 본점이 되었다");
        // 되살리기 전에 만든 때를 보여 주고, 사장이 확인한 시각과 다르면 되살리지 않는다.
        let pv = crate::chain_backup::preview_in(&w.csk, &blob2).unwrap();
        assert_eq!((pv["at"].as_i64(), pv["stores"].as_u64()), (Some(at), Some(2)));
        assert!(!new_head.join("issued.json").exists(), "미리 보기가 무언가를 썼다");
        assert_eq!(crate::chain_backup::restore_in(&new_head, &w.csk, &blob2, at - 1).unwrap_err(), crate::chain_backup::ERR_CONFIRM);
        assert!(!new_head.join("issued.json").exists());
        let r = crate::chain_backup::restore_in(&new_head, &w.csk, &blob2, at).unwrap();
        assert_eq!((r["stores"].as_u64(), r["keys"].as_u64()), (Some(2), Some(2)));
        assert_eq!(std::fs::read(new_head.join("issued.json")).unwrap(), std::fs::read(w.owner.join("issued.json")).unwrap());
        assert_eq!(received(&new_head, 1).len(), received(&w.owner, 1).len());
        // 이미 본점인 컴퓨터에는 덮어쓰지 않는다.
        assert_eq!(crate::chain_backup::restore_in(&new_head, &w.csk, &blob2, at).unwrap_err(), crate::chain_backup::ERR_HAVE_HEAD);
        // 새 본점이 바로 받는다(데이터 열쇠를 다시 만들었다 · 번호는 이어진다).
        record_in(&root1, &cd1, &pay("cash", 1000, None), &none, NOW + 70).unwrap();
        let rr = push_with(&cd1, &root1, NOW + 71, &mut send_to(&new_head, NOW + 71)).unwrap();
        assert!(matches!(rr[0], Sent::Acked { warn: None, .. }), "{rr:?}");
        assert_eq!(received(&new_head, 1).len(), 3);
    }

    #[tokio::test]
    async fn a_replaced_store_pc_gets_its_log_back_and_never_reuses_a_receipt_number() {
        let (w, base) = world("pull");
        let (cd, root) = add_store(&w, &base, 5, "선릉점", "123-45-67890", None, true);
        for i in 0..5 {
            record_in(&root, &cd, &pay("cash", 1000 + i, None), &none, NOW + i as i64).unwrap();
        }
        push_with(&cd, &root, NOW + 10, &mut send_to(&w.owner, NOW + 10)).unwrap();
        // 옛 컴퓨터가 본점에 못 보낸 영수증(번호 6)이 손님 손에 있다 — 그리고 컴퓨터가 고장 났다.
        let lost = record_in(&root, &cd, &pay("cash", 7777, None), &none, NOW + 11).unwrap();
        assert_eq!(lost["seq"], 6);
        // 새 컴퓨터: 같은 번호로 다시 받은 꾸러미(새 증서) → 합류.
        let ssk = crate::identity::chain_store_key_from(WORDS, "", 5, 0).unwrap();
        let r = cs::issue_in(&w.owner, &w.csk, &ssk, 5, "선릉점", &cs::clean_biz("123-45-67890", None).unwrap(), NOW + 20).unwrap();
        let pc = base.join("store5-new");
        let (cd2, root2) = (pc.join("chain"), pc.join("pos"));
        std::fs::create_dir_all(&cd2).unwrap();
        cs::join_in(&cd2, &r.bundle, &r.install_words, NOW + 20).unwrap();
        std::fs::write(cd2.join("head.json"), std::fs::read(cd.join("head.json")).unwrap_or_else(|_| b"{}".to_vec())).ok();
        let out = pull_log_with(&cd2, &root2, async_send(&w.owner, NOW + 30), || NOW + 30).await.unwrap();
        assert_eq!(out["ok"], true, "{out}");
        assert_eq!((out["restored"].as_u64(), out["lastSeq"].as_u64(), out["resumeSeq"].as_u64()), (Some(6), Some(5), Some(6)));
        // 다음 영수증 번호는 건너뛴 뒤 — 손님 손의 6번과 겹치지 않는다.
        let next = record_in(&root2, &cd2, &pay("card", 5000, Some("11112222")), &none, NOW + 40).unwrap();
        assert_eq!(next["seq"].as_u64(), Some(7 + crate::pos_pay::RESUME_SKIP));
        let day = crate::pos_pay::day_in(&root2, &cd2, 0, i64::MAX);
        assert_eq!((day["count"].as_u64(), day["check"]["ok"].as_bool()), (Some(6), Some(true)), "되찾은 5건 + 새 1건, 사슬 이어짐");
        // 되찾은 줄은 다시 보내지 않고, resume·새 줄만 본점에 간다 — 본점은 건너뛴 번호를 받아들인다.
        let rr = push_with(&cd2, &root2, NOW + 50, &mut send_to(&w.owner, NOW + 50)).unwrap();
        assert_eq!(rr[0], Sent::Acked { ack: Some(7 + crate::pos_pay::RESUME_SKIP), progressed: true, warn: None });
        assert_eq!(received(&w.owner, 5).len(), 8);
        // 이미 기록이 있으면 되찾기를 거절한다(덮어쓰지 않는다).
        assert_eq!(pull_log_with(&cd2, &root2, async_send(&w.owner, NOW + 60), || NOW + 60).await.unwrap_err(), crate::pos_pay::ERR_RESTORE_HAVE);
        // 본점에 기록이 없는 매장은 「아직 없어요」.
        let (cd3, root3) = add_store(&w, &base, 6, "삼성점", "123-45-67890", None, true);
        assert_eq!(pull_log_with(&cd3, &root3, async_send(&w.owner, NOW + 70), || NOW + 70).await.unwrap_err(), crate::pos_pay::ERR_RESTORE_EMPTY);
    }

    // ── ⑤ 같은 체인 릴레이 이웃 ──

    #[tokio::test]
    async fn same_chain_relay_friends_are_signed_end_to_end_and_cut_stores_drop_out() {
        let (w, base) = world("relay");
        let (cd1, root1) = add_store(&w, &base, 1, "강남점", "123-45-67890", None, true);
        let (cd2, root2) = add_store(&w, &base, 2, "역삼점", "123-45-67890", None, true);
        let (cd3, root3) = add_store(&w, &base, 3, "삼성점", "123-45-67890", None, true);
        let (head_t, t1, t2, t3) = ("a1".repeat(32), "b1".repeat(32), "b2".repeat(32), "b3".repeat(32));
        cs::write_relay_roster_in(&w.owner, &w.csk, Some(&head_t), NOW).unwrap();
        // 공개 명부에는 이야기 공개키가 없다(릴레이 명부는 봉함 안으로만).
        for (cd, root, t, n) in [(&cd1, &root1, &t1, 1u32), (&cd2, &root2, &t2, 2), (&cd3, &root3, &t3, 3)] {
            push_with(cd, root, NOW + n as i64, &mut send_to(&w.owner, NOW + n as i64)).unwrap();
            sync_relay_with(cd, Some(t), async_send(&w.owner, NOW + 10), || NOW + 10).await;
        }
        // 1번이 다시 보내면 묶음이 바뀐 것을 알고 받아 간다(2·3번 binding 이 그 뒤에 왔다).
        push_with(&cd1, &root1, NOW + 20, &mut send_to(&w.owner, NOW + 20)).unwrap();
        sync_relay_with(&cd1, Some(&t1), async_send(&w.owner, NOW + 21), || NOW + 21).await;
        let f1 = relay_friends_in(&cd1, Some(&t1));
        assert_eq!(f1, [head_t.clone(), t2.clone(), t3.clone()].into_iter().collect(), "본점 + 다른 매장, 나는 빼고");
        let fh = relay_friends_in(&w.owner, Some(&head_t));
        assert_eq!(fh, [t1.clone(), t2.clone(), t3.clone()].into_iter().collect());
        // 묶음을 고치면(가짜 이야기 공개키 끼우기) 서명이 안 맞아 빠진다.
        let mut b: Value = read_json(&peers_file(&cd1)).unwrap();
        b["relays"][0]["talk"] = json!("ee".repeat(32));
        std::fs::write(peers_file(&cd1), serde_json::to_vec(&b).unwrap()).unwrap();
        assert!(!relay_friends_in(&cd1, Some(&t1)).contains(&"ee".repeat(32)));
        // 매장 열쇠가 아닌 열쇠로 서명한 binding 은 본점이 받지 않는다.
        let fake = json!({ "v": 1, "kind": "relay", "chain": w.chain, "store": 2, "storeKey": cs::pubkey(&crate::identity::chain_store_key_from(WORDS, "", 2, 0).unwrap()).unwrap(), "talk": "ff".repeat(32), "at": NOW });
        let wrong = crate::lan_cert::sign_doc(cs::RELAY_DOMAIN, &fake, &w.chain, |d| {
            let k = secp256k1::SecretKey::from_byte_array(&w.csk).map_err(|_| ())?;
            Ok(secp256k1::Secp256k1::new().sign_ecdsa(&secp256k1::Message::from_digest(*d), &k).serialize_compact())
        }).unwrap();
        assert!(!binding_ok(&wrong, &w.chain, 2, fake["storeKey"].as_str().unwrap()));
        // 3번을 끊는다 → 본점 명부 다시 서명 → 1번이 끊기 목록·새 묶음을 받으면 3번은 빠진다. 본점 쪽도 바로 빠진다.
        let serial3 = cs::load_history(&w.owner).unwrap().1.iter().find(|c| c["store"] == 3).unwrap()["serial"].as_u64().unwrap();
        cs::revoke_in(&w.owner, &w.csk, serial3, NOW + 30).unwrap();
        cs::write_relay_roster_in(&w.owner, &w.csk, Some(&head_t), NOW + 30).unwrap();
        assert!(!relay_friends_in(&w.owner, None).contains(&t3));
        std::fs::remove_file(peers_file(&cd1)).unwrap();
        push_with(&cd1, &root1, NOW + 40, &mut send_to(&w.owner, NOW + 40)).unwrap();
        sync_relay_with(&cd1, Some(&t1), async_send(&w.owner, NOW + 41), || NOW + 41).await;
        let f1 = relay_friends_in(&cd1, Some(&t1));
        assert!(f1.contains(&t2) && !f1.contains(&t3), "{f1:?}");
        // 옛 묶음(끊기 전 명부)을 되풀이해 넣어도 받지 않는다.
        assert!(!accept_peers_in(&cd1, &b));
        // 체인 매장도 본점도 아닌 컴퓨터는 친구가 없다.
        assert!(relay_friends_in(&base.join("nobody"), None).is_empty());
    }

    // ── 보안 검토 반영: 되찾기 열쇠 묶기 · 답 크기 상한 ──

    #[tokio::test]
    async fn pulled_lines_must_be_signed_by_this_store_key_or_the_one_just_before() {
        let (w, base) = world("keybind");
        let (cd0, root0) = add_store(&w, &base, 5, "선릉점", "123-45-67890", None, true);
        for i in 0..3 {
            record_in(&root0, &cd0, &pay("cash", 1000 + i, None), &none, NOW + i as i64).unwrap();
        }
        push_with(&cd0, &root0, NOW + 10, &mut send_to(&w.owner, NOW + 10)).unwrap();
        let biz = cs::clean_biz("123-45-67890", None).unwrap();
        let serial_of = |key: &str| cs::load_history(&w.owner).unwrap().1.iter().rev().find(|c| c["storeKey"] == json!(key)).unwrap()["serial"].as_u64().unwrap();
        // 옛 PC 를 도난당해 끊고(세대 0) 새 세대로 다시 발급 → 증서에 prevStoreKey = 세대 0
        let k0 = cs::pubkey(&crate::identity::chain_store_key_from(WORDS, "", 5, 0).unwrap()).unwrap();
        cs::revoke_in(&w.owner, &w.csk, serial_of(&k0), NOW + 20).unwrap();
        let s1 = crate::identity::chain_store_key_from(WORDS, "", 5, 1).unwrap();
        let r1 = cs::issue_in(&w.owner, &w.csk, &s1, 5, "선릉점", &biz, NOW + 21).unwrap();
        remember_key_in(&w.owner, &w.csk, &r1.store_pubkey).unwrap();
        assert_eq!(r1.cert["prevStoreKey"], json!(k0));
        let join = |name: &str, r: &cs::Issued| {
            let pc = base.join(name);
            let (cd, root) = (pc.join("chain"), pc.join("pos"));
            std::fs::create_dir_all(&cd).unwrap();
            cs::join_in(&cd, &r.bundle, &r.install_words, NOW + 22).unwrap();
            (cd, root)
        };
        // 세대 1 PC 는 세대 0 줄을 되찾을 수 있다.
        let (cd1, root1) = join("gen1", &r1);
        let ok = pull_log_with(&cd1, &root1, async_send(&w.owner, NOW + 30), || NOW + 30).await.unwrap();
        assert_eq!(ok["ok"], true, "{ok}");
        // 세대 1 도 끊고 세대 2 로: 이제 세대 0 줄만 있는 기록은 「바로 앞 열쇠」가 아니라 거절.
        let (_, lines0, _) = { let (a, b, c) = crate::pos_pay::log_lines_in(&root0, &cd0); (a, c, b) };
        cs::revoke_in(&w.owner, &w.csk, serial_of(&r1.store_pubkey), NOW + 40).unwrap();
        let s2 = crate::identity::chain_store_key_from(WORDS, "", 5, 2).unwrap();
        let r2 = cs::issue_in(&w.owner, &w.csk, &s2, 5, "선릉점", &biz, NOW + 41).unwrap();
        let (cd2, root2) = join("gen2", &r2);
        assert_eq!(crate::pos_pay::restore_lines_in(&root2, &cd2, &lines0, NOW + 50).unwrap_err(), crate::pos_pay::ERR_RESTORE_KEY);
        // 세대 1 PC 가 되찾고 이은 기록(세대 0 줄 + 세대 1 resume, prevKey = 세대 0)은 세대 2 PC 가 받을 수 있다.
        let lines1 = crate::pos_pay::log_lines_in(&root1, &cd1).2;
        assert!(crate::pos_pay::restore_lines_in(&root2, &cd2, &lines1, NOW + 51).is_ok());
        // 남의 열쇠로 서명한 줄(같은 번호인 척)은 사슬을 다시 이어 붙여도 받지 않는다.
        let (cdx, rootx) = add_store(&w, &base, 6, "가짜", "123-45-67890", None, true);
        record_in(&rootx, &cdx, &pay("cash", 9999, None), &none, NOW).unwrap();
        let mut forged = crate::pos_pay::log_lines_in(&rootx, &cdx).2;
        for l in forged.iter_mut() {
            l["store"] = json!(5);
        }
        let (cd3, root3) = join("gen2b", &r2);
        assert!(crate::pos_pay::restore_lines_in(&root3, &cd3, &forged, NOW + 60).is_err());
    }

    #[test]
    fn worst_case_op_replies_fit_under_the_reply_cap() {
        let (w, base) = world("cap");
        let (cd, _root) = add_store(&w, &base, 8, "큰점", "123-45-67890", None, true);
        let me = cs::store_self_in(&cd).unwrap();
        let key = data_key(&w.csk, &me.store_key, &w.chain, &me.store_key).unwrap();
        let wrap = |inner: &Value| -> usize {
            let sealed = seal(&key, &aad_of(AAD_RES, &json!("00".repeat(16))), inner.to_string().as_bytes()).unwrap();
            serde_json::to_vec(&json!({ "v": 1, "box": sealed })).unwrap().len()
        };
        // 되찾기: 한 줄이 아주 긴(MAX_LINE 근처) 기록이 잔뜩 있어도 PULL_BYTES 에서 자른다.
        let log_id = "ab".repeat(16);
        let ldir = store_dir(&w.owner, 8).join(&log_id);
        std::fs::create_dir_all(&ldir).unwrap();
        let pad = "가".repeat(2600); // 7.8KB
        let text: String = (0..400).map(|i| format!("{}\n", json!({ "seq": i, "pad": pad }))).collect();
        std::fs::write(ldir.join("202611.jsonl"), text).unwrap();
        let mut st = load_state(&w.owner, 8);
        st["logs"] = json!({ log_id.clone(): { "ack": 399, "at": NOW } });
        write_json(&store_dir(&w.owner, 8).join("state.json"), &st).unwrap();
        let rep = pull_reply(&w.owner, 8, None, 0);
        assert_eq!(rep["more"], true);
        let inner = json!({ "logId": log_id, "ack": 399, "warn": null, "op": rep });
        let n = wrap(&inner);
        assert!(n < MAX_REPLY_BYTES, "되찾기 답 {n} 바이트가 상한을 넘는다");
        // 백업 조각: 꽉 찬 조각 하나.
        let inner = json!({ "logId": NO_LOG, "ack": null, "warn": null,
            "op": { "hash": "00".repeat(32), "size": crate::chain_backup::MAX_BLOB, "at": NOW, "offset": 0,
                    "data": base64::engine::general_purpose::STANDARD.encode(vec![0xffu8; crate::chain_backup::CHUNK]) } });
        let n = wrap(&inner);
        assert!(n < MAX_REPLY_BYTES, "백업 조각 답 {n} 바이트가 상한을 넘는다");
    }
}
