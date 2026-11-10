//! 체인 POS ① — 매장 열쇠 발급·끊기 (docs/CHAIN-POS.md).
//!
//! * 본점(12단어가 있는 PC 한 곳)이 매장 n 의 열쇠(`identity::PATH_CHAIN_STORE_PREFIX/<n>'/<세대>'`)를 뽑고,
//!   본점(체인) 열쇠(`identity::PATH_CHAIN_KEY` — 간판 열쇠와 **따로**)로 **매장 증서**에 서명한다.
//! * 끊긴 열쇠는 다시 주지 않는다: 같은 번호를 다시 발급하면 끊긴 세대를 건너뛴 새 열쇠가 나온다.
//! * 릴레이에 올리는 겉봉투도 체인 열쇠로 서명한다(사장의 이야기 이름과 체인을 묶지 않는다). 공개 명부에 사업자 번호는 싣지 않는다.
//! * 증서·끊기 목록은 `lan_cert` 모양 그대로(정본 JSON·signmessage 해시·65바이트 복구형·낮은 S),
//!   도메인만 `ravenvault-chain-v1`. 증서와 끊기 목록은 칸 이름이 서로 달라 같은 도메인이어도 섞이지 않는다.
//! * 매장 PC 로는 **설치 꾸러미** 하나만 건너간다 = {매장 비밀 열쇠, 증서} 를 일회용 6단어 설치 암호로 봉함
//!   (Argon2id 기본값 → XChaCha20-Poly1305). 꾸러미에 12단어·본점 열쇠는 **없다**(시험이 글자로 찾는다).
//! * 판정 순서(lan_cert 와 같음): 시각(bad-clock) → 모양(shape) → 서명(signature) → not-yet → expired → 끊기 목록.
//!
//! 🔴 12단어·열쇠·설치 암호는 오류·로그에 한 글자도 싣지 않는다(고정 문장만). 다 쓰면 `words::wipe*` 로 지운다.

use crate::lan_cert::{is_public_key, sign_doc, signed_by, verify_revocation_list_in, CertReason, ListInfo};
use crate::lan_proof::canonical_string;
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use chacha20poly1305::aead::{Aead, KeyInit, Payload};
use chacha20poly1305::{XChaCha20Poly1305, XNonce};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};

pub const CHAIN_DOMAIN: &str = "ravenvault-chain-v1";
pub const CERT_LIFE_MS: i64 = 365 * 24 * 3600_000;
pub const CLOCK_SKEW_MS: i64 = 30_000;
pub const MAX_CERT_BYTES: usize = 4096;
pub const STORE_SCOPES: [&str; 3] = ["pos", "talk", "shop-read"];
pub const NAME_MAX: usize = 40;
pub const D_REVOCATIONS: &str = "ravenvault-chain-revocations";
pub const D_ROSTER: &str = "ravenvault-chain-roster";
const BUNDLE_PREFIX: &str = "rvchain1-";
const BUNDLE_AAD: &[u8] = b"ravenvault-chain-v1/install";
const INSTALL_WORDS: usize = 6;
const MAX_BUNDLE_CHARS: usize = 16 * 1024;
const MIN_NOW_MS: i64 = crate::lan_cert::MIN_NOW_MS;
const MAX_TIME_MS: i64 = crate::lan_cert::MAX_TIME_MS;

/// 화면에 내보내는 고정 문장 — 입력값을 되풀이하지 않는다.
pub const ERR_NUMBER: &str = "매장 번호는 1부터 9999 사이의 숫자로 적어 주세요.";
pub const ERR_NAME: &str = "매장 이름은 1~40자로 적어 주세요(줄바꿈 없이).";
pub const ERR_BIZ: &str = "사업자등록번호는 숫자 10자리예요(빼기표는 빼도 돼요).";
pub const ERR_BIZ_SUB: &str = "종사업장 번호는 숫자 4자리예요. 없으면 비워 두세요.";
pub const ERR_KEY: &str = "매장 열쇠를 만들지 못했어요.";
pub const ERR_SIGN: &str = "증서에 서명하지 못했어요.";
pub const ERR_SAVE: &str = "이 컴퓨터에 저장하지 못했어요. 디스크 공간과 권한을 확인해 주세요.";
pub const ERR_OTHER_CHAIN: &str = "이 컴퓨터의 발급 기록은 다른 12단어(다른 본점)로 만든 것이에요. 지갑이 바뀌었는지 확인해 주세요.";
pub const ERR_BUNDLE: &str = "꾸러미 글자가 맞지 않아요. 본점에서 받은 글자를 처음부터 끝까지 그대로 붙여 넣어 주세요.";
pub const ERR_INSTALL_WORDS: &str = "설치 암호가 맞지 않아요. 본점 화면에 보인 6단어를 순서대로 적어 주세요.";
pub const ERR_CERT: &str = "꾸러미 안의 매장 증서가 올바르지 않아요. 본점에서 새로 만들어 주세요.";
pub const ERR_JOINED_OTHER: &str = "이 컴퓨터는 이미 다른 본점의 매장으로 연결되어 있어요.";
pub const ERR_IS_OWNER: &str = "이 컴퓨터는 본점이에요. 본점 컴퓨터는 매장으로 연결할 수 없어요.";
pub const ERR_NO_SERIAL: &str = "그 매장 증서를 발급 기록에서 찾지 못했어요.";
pub const ERR_DECLINED: &str = "사장님이 매장 열쇠 만들기를 허락하지 않았어요.";
pub const ERR_REVOKE_DECLINED: &str = "사장님이 매장 끊기를 허락하지 않았어요.";
pub const ERR_OLD_BUNDLE: &str = "이 꾸러미는 이 컴퓨터에 이미 있는 증서보다 옛것이에요. 본점에서 새로 받은 꾸러미를 써 주세요.";
pub const ERR_NO_GEN: &str = "이 매장 번호는 너무 여러 번 끊겼어요. 새 번호로 만들어 주세요.";
pub const ERR_LOCKED: &str = crate::storesign::ERR_LOCKED;

fn chain_dir() -> PathBuf {
    crate::paths::app_file("chain")
}

fn now_ms() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_millis() as i64)
}

// ── 입력 다듬기 ─────────────────────────────────────────────────────

pub fn clean_name(s: &str) -> Result<String, &'static str> {
    let t = s.trim();
    let n = t.chars().count();
    if n == 0 || n > NAME_MAX || t.chars().any(|c| c.is_control() || matches!(c, '\u{200b}'..='\u{200f}' | '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}')) {
        return Err(ERR_NAME);
    }
    Ok(t.to_string())
}

/// 사업자등록번호(10자리) + 종사업장 번호(4자리, 선택). 빼기표·공백은 빼고 숫자만 남긴다.
pub fn clean_biz(no: &str, sub: Option<&str>) -> Result<Value, &'static str> {
    let digits = |s: &str| -> Option<String> {
        let d: String = s.chars().filter(|c| !matches!(c, '-' | ' ')).collect();
        d.bytes().all(|b| b.is_ascii_digit()).then_some(d)
    };
    let no = digits(no).filter(|d| d.len() == 10).ok_or(ERR_BIZ)?;
    let mut o = Map::new();
    o.insert("no".into(), Value::from(no));
    if let Some(s) = sub.map(str::trim).filter(|s| !s.is_empty()) {
        let s = digits(s).filter(|d| d.len() == 4).ok_or(ERR_BIZ_SUB)?;
        o.insert("sub".into(), Value::from(s));
    }
    Ok(Value::Object(o))
}

// ── 증서 ───────────────────────────────────────────────────────────

/// 끊기 식별자 = sha256Hex(정본JSON[도메인, 본점 공개키, 일련번호]) — lan_cert `device_cert_id` 와 같은 꼴.
pub fn store_cert_id(chain: &str, serial: u64) -> String {
    let v = json!([CHAIN_DOMAIN, chain, serial]);
    hex::encode(Sha256::digest(canonical_string(&v).unwrap_or_default().as_bytes()))
}

/// 끊기 목록의 `storeId` 칸 = 본점 공개키 바이트의 SHA-256 hex(lan_cert 목록은 64자리 hex 를 요구한다).
pub fn chain_list_id(chain: &str) -> String {
    crate::storesign::fingerprint(chain)
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StoreCert {
    pub chain: String,
    pub store: u32,
    pub name: String,
    pub store_key: String,
    pub serial: u64,
    pub issued_at: i64,
    pub not_after: i64,
    pub cert_id: String,
}

fn int(v: &Value, min: i64, max: i64) -> Option<i64> {
    v.as_i64().filter(|n| (min..=max).contains(n))
}

/// 모양만 본다(서명 전 본문이면 `with_sig=false`).
fn validate(raw: &Value, with_sig: bool) -> Result<(&Map<String, Value>, StoreCert), ()> {
    let o = raw.as_object().ok_or(())?;
    if canonical_string(raw).map_err(|_| ())?.len() > MAX_CERT_BYTES {
        return Err(());
    }
    const BODY: [&str; 12] = ["v", "chain", "store", "name", "storeKey", "biz", "role", "scope", "serial", "issuedAt", "notAfter", "sig"];
    let want = if with_sig { &BODY[..] } else { &BODY[..11] };
    if o.len() != want.len() || !want.iter().all(|k| o.contains_key(*k)) {
        return Err(());
    }
    let chain = o["chain"].as_str().filter(|k| is_public_key(k)).ok_or(())?;
    let store_key = o["storeKey"].as_str().filter(|k| is_public_key(k)).ok_or(())?;
    if o["v"].as_u64() != Some(1) || o["role"].as_str() != Some("store") || chain == store_key {
        return Err(());
    }
    let store = int(&o["store"], 1, 9999).ok_or(())? as u32;
    let name = o["name"].as_str().ok_or(())?;
    if clean_name(name).ok().as_deref() != Some(name) {
        return Err(());
    }
    let biz = o["biz"].as_object().ok_or(())?;
    let biz_ok = match (biz.get("no").and_then(Value::as_str), biz.get("sub").map(|s| s.as_str())) {
        (Some(no), None) if biz.len() == 1 => clean_biz(no, None).ok() == Some(Value::Object(biz.clone())),
        (Some(no), Some(Some(sub))) if biz.len() == 2 => clean_biz(no, Some(sub)).ok() == Some(Value::Object(biz.clone())),
        _ => false,
    };
    let scope_ok = o["scope"].as_array().is_some_and(|a| a.len() == STORE_SCOPES.len() && a.iter().zip(STORE_SCOPES).all(|(x, s)| x.as_str() == Some(s)));
    if !biz_ok || !scope_ok {
        return Err(());
    }
    let serial = int(&o["serial"], 1, 9_007_199_254_740_991).ok_or(())? as u64;
    let issued_at = int(&o["issuedAt"], 1, MAX_TIME_MS).ok_or(())?;
    let not_after = int(&o["notAfter"], 1, MAX_TIME_MS).ok_or(())?;
    if not_after <= issued_at || not_after - issued_at > CERT_LIFE_MS || (with_sig && !o["sig"].is_string()) {
        return Err(());
    }
    let cert_id = store_cert_id(chain, serial);
    Ok((o, StoreCert { chain: chain.into(), store, name: name.into(), store_key: store_key.into(), serial, issued_at, not_after, cert_id }))
}

/// 서명 전 본문. 만료 = 발급 + 365일.
pub fn cert_body(chain: &str, store: u32, name: &str, store_key: &str, biz: &Value, serial: u64, issued_at: i64) -> Result<Value, &'static str> {
    let body = json!({
        "v": 1, "chain": chain, "store": store, "name": name, "storeKey": store_key, "biz": biz,
        "role": "store", "scope": STORE_SCOPES, "serial": serial, "issuedAt": issued_at, "notAfter": issued_at + CERT_LIFE_MS,
    });
    validate(&body, false).map_err(|_| ERR_CERT)?;
    Ok(body)
}

/// 시각 → 모양 → 서명 → not-yet → expired. 끊기 목록은 보지 않는다(합류할 때·목록 확인 전 단계).
pub fn verify_store_cert_body(raw: &Value, chain_key: &str, now_ms: i64) -> Result<StoreCert, CertReason> {
    if !(MIN_NOW_MS..=MAX_TIME_MS).contains(&now_ms) {
        return Err(CertReason::BadClock);
    }
    let (o, c) = validate(raw, true).map_err(|_| CertReason::Shape)?;
    if !is_public_key(chain_key) || c.chain != chain_key || !signed_by(CHAIN_DOMAIN, o, chain_key) {
        return Err(CertReason::Signature);
    }
    if now_ms + CLOCK_SKEW_MS < c.issued_at {
        return Err(CertReason::NotYet);
    }
    if now_ms >= c.not_after {
        return Err(CertReason::Expired);
    }
    Ok(c)
}

/// 매장 증서 확인 — lan_cert `verify_device_cert` 와 같은 순서·같은 사유 이름. 끊기 목록이 없으면 닫힌 실패(no-revocation-list).
/// 🔸 lan_cert 와 다른 점 하나: 끊기 목록의 **신선도(24시간)는 보지 않는다** — 목록은 끊을 때만 새로 서명되고,
///    매장은 인터넷이 끊겨도 돌아야 한다(원칙 2). 대신 목록의 not-yet(미래 시각)은 본다.
#[allow(dead_code)] // ③ 매출 받기(/lan/push)가 쓴다 — ①에서는 시험만
pub fn verify_store_cert(raw: &Value, chain_key: &str, now_ms: i64, revocation: Option<&Value>) -> Result<StoreCert, CertReason> {
    let c = verify_store_cert_body(raw, chain_key, now_ms)?;
    let list = match revocation {
        None | Some(Value::Null) => return Err(CertReason::NoRevocationList),
        Some(r) => verify_revocation_list_in(CHAIN_DOMAIN, r, chain_key, &chain_list_id(chain_key))?,
    };
    if now_ms + CLOCK_SKEW_MS < list.issued_at {
        return Err(CertReason::NotYet);
    }
    if c.not_after <= list.pruned_before || list.revoked.iter().any(|r| r == &c.cert_id) {
        return Err(CertReason::Revoked);
    }
    Ok(c)
}

/// 열쇠로 다이제스트에 서명(RFC6979 결정적 ECDSA, compact 64바이트).
fn ecdsa_signer(sk: &[u8; 32]) -> impl FnOnce(&[u8; 32]) -> Result<[u8; 64], ()> + '_ {
    move |d| {
        let k = secp256k1::SecretKey::from_byte_array(sk).map_err(|_| ())?;
        Ok(secp256k1::Secp256k1::new().sign_ecdsa(&secp256k1::Message::from_digest(*d), &k).serialize_compact())
    }
}

fn pubkey(sk: &[u8; 32]) -> Result<String, &'static str> {
    crate::storesign::pubkey_hex(sk).map_err(|_| ERR_KEY)
}

/// 끊기 목록 본문을 만들어 서명한다(번호·시각은 뒤로 가지 않는다 — lan_cert accept 규칙).
fn sign_list(chain_sk: &[u8; 32], chain: &str, prev: Option<&ListInfo>, add: &[String], now: i64) -> Result<Value, &'static str> {
    let mut revoked: Vec<String> = prev.map(|p| p.revoked.clone()).unwrap_or_default();
    for id in add {
        if !revoked.iter().any(|r| r == id) {
            revoked.push(id.clone());
        }
    }
    revoked.sort();
    let body = json!({
        "v": 1, "storeId": chain_list_id(chain), "seq": prev.map_or(1, |p| p.seq + 1), "revoked": revoked,
        "issuedAt": prev.map_or(now, |p| now.max(p.issued_at)), "prunedBefore": prev.map_or(0, |p| p.pruned_before),
    });
    sign_doc(CHAIN_DOMAIN, &body, chain, ecdsa_signer(chain_sk)).map_err(|_| ERR_SIGN)
}

// ── 설치 꾸러미 ────────────────────────────────────────────────────

/// 6단어 설치 암호(BIP39 영어 단어표, OsRng). 2048^6 ≈ 2^66.
pub fn new_install_words() -> String {
    use rand::RngCore;
    let list: Vec<&str> = crate::words::WORDLIST_TXT.split_whitespace().collect();
    debug_assert_eq!(list.len(), 2048);
    let mut out = Vec::with_capacity(INSTALL_WORDS);
    for _ in 0..INSTALL_WORDS {
        out.push(list[(rand::rngs::OsRng.next_u32() as usize) % list.len()]);
    }
    out.join(" ")
}

fn norm_words(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ").to_lowercase()
}

fn install_key(words: &str, salt: &[u8]) -> Result<[u8; 32], &'static str> {
    let mut w = norm_words(words);
    let mut k = [0u8; 32];
    let r = argon2::Argon2::default().hash_password_into(w.as_bytes(), salt, &mut k);
    crate::words::wipe(&mut w);
    r.map_err(|_| ERR_INSTALL_WORDS)?;
    Ok(k)
}

/// {매장 비밀 열쇠, 증서} → `rvchain1-<base64url(salt16‖nonce24‖봉함)>`.
pub fn seal_bundle(store_sk: &[u8; 32], cert: &Value, words: &str) -> Result<String, &'static str> {
    use rand::RngCore;
    let mut salt = [0u8; 16];
    let mut nonce = [0u8; 24];
    rand::rngs::OsRng.fill_bytes(&mut salt);
    rand::rngs::OsRng.fill_bytes(&mut nonce);
    let mut sk_hex = hex::encode(store_sk);
    let mut plain = serde_json::to_vec(&json!({ "v": 1, "storeSecret": sk_hex, "cert": cert })).map_err(|_| ERR_KEY)?;
    crate::words::wipe(&mut sk_hex);
    let mut key = install_key(words, &salt)?;
    let ct = XChaCha20Poly1305::new((&key).into()).encrypt(XNonce::from_slice(&nonce), Payload { msg: &plain, aad: BUNDLE_AAD });
    crate::words::wipe_bytes(&mut key);
    crate::words::wipe_bytes(&mut plain);
    let ct = ct.map_err(|_| ERR_KEY)?;
    let mut all = Vec::with_capacity(40 + ct.len());
    all.extend_from_slice(&salt);
    all.extend_from_slice(&nonce);
    all.extend_from_slice(&ct);
    Ok(format!("{BUNDLE_PREFIX}{}", URL_SAFE_NO_PAD.encode(all)))
}

/// 꾸러미를 연다 → (매장 비밀 열쇠, 증서). 증서 확인은 부르는 쪽이 한다.
pub fn open_bundle(text: &str, words: &str) -> Result<([u8; 32], Value), &'static str> {
    let t: String = text.chars().filter(|c| !c.is_whitespace()).collect();
    if t.len() > MAX_BUNDLE_CHARS {
        return Err(ERR_BUNDLE);
    }
    let body = t.strip_prefix(BUNDLE_PREFIX).ok_or(ERR_BUNDLE)?;
    let raw = URL_SAFE_NO_PAD.decode(body).map_err(|_| ERR_BUNDLE)?;
    if raw.len() < 16 + 24 + 16 {
        return Err(ERR_BUNDLE);
    }
    if norm_words(words).split(' ').count() != INSTALL_WORDS {
        return Err(ERR_INSTALL_WORDS);
    }
    let mut key = install_key(words, &raw[..16])?;
    let plain = XChaCha20Poly1305::new((&key).into()).decrypt(XNonce::from_slice(&raw[16..40]), Payload { msg: &raw[40..], aad: BUNDLE_AAD });
    crate::words::wipe_bytes(&mut key);
    let mut plain = plain.map_err(|_| ERR_INSTALL_WORDS)?;
    let parsed: Result<Value, _> = serde_json::from_slice(&plain);
    crate::words::wipe_bytes(&mut plain);
    let mut v = parsed.map_err(|_| ERR_BUNDLE)?;
    let out = (|| {
        let o = v.as_object().filter(|o| o.len() == 3 && o.get("v").and_then(Value::as_u64) == Some(1))?;
        let sk = hex::decode(o.get("storeSecret")?.as_str()?).ok()?;
        let sk: [u8; 32] = sk.try_into().ok()?;
        Some((sk, o.get("cert")?.clone()))
    })();
    if let Some(Value::String(s)) = v.get_mut("storeSecret") {
        crate::words::wipe(s);
    }
    out.ok_or(ERR_BUNDLE)
}

// ── 이 컴퓨터의 파일 (chain/) ──────────────────────────────────────

fn read_json(path: &Path) -> Option<Value> {
    serde_json::from_slice(&std::fs::read(path).ok()?).ok()
}
fn write_json(path: &Path, v: &Value) -> Result<(), &'static str> {
    let bytes = serde_json::to_vec_pretty(v).map_err(|_| ERR_SAVE)?;
    crate::server::atomic_write_0600(path, &bytes).map_err(|_| ERR_SAVE)
}

/// 본점 발급 기록 `chain/issued.json` = {v, chain, certs:[증서…]} — 비밀 없음.
fn load_history(dir: &Path) -> Option<(String, Vec<Value>)> {
    let v = read_json(&dir.join("issued.json"))?;
    let chain = v.get("chain")?.as_str()?.to_string();
    let certs = v.get("certs")?.as_array()?.clone();
    Some((chain, certs))
}

fn load_list(dir: &Path, chain: &str) -> Option<(Value, ListInfo)> {
    let v = read_json(&dir.join("revocations.json"))?;
    let info = verify_revocation_list_in(CHAIN_DOMAIN, &v, chain, &chain_list_id(chain)).ok()?;
    Some((v, info))
}

pub struct Issued {
    pub bundle: String,
    pub install_words: String,
    pub store_pubkey: String,
    pub serial: u64,
    #[allow(dead_code)]
    pub cert: Value,
}

/// 발급 한 번(열쇠는 부르는 쪽이 뽑아 넘기고, 끝나면 지운다). 기록·첫 끊기 목록을 `dir` 에 남긴다.
pub fn issue_in(dir: &Path, chain_sk: &[u8; 32], store_sk: &[u8; 32], n: u32, name: &str, biz: &Value, now: i64) -> Result<Issued, String> {
    let chain = pubkey(chain_sk)?;
    let store_pub = pubkey(store_sk)?;
    let (hist_chain, mut certs) = load_history(dir).unwrap_or_else(|| (chain.clone(), Vec::new()));
    if hist_chain != chain {
        return Err(ERR_OTHER_CHAIN.into());
    }
    let serial = certs.iter().filter_map(|c| c.get("serial").and_then(Value::as_u64)).max().unwrap_or(0) + 1;
    let body = cert_body(&chain, n, name, &store_pub, biz, serial, now)?;
    let cert = sign_doc(CHAIN_DOMAIN, &body, &chain, ecdsa_signer(chain_sk)).map_err(|_| ERR_SIGN.to_string())?;
    verify_store_cert_body(&cert, &chain, now).map_err(|_| ERR_SIGN.to_string())?;
    let mut install_words = new_install_words();
    let bundle = seal_bundle(store_sk, &cert, &install_words);
    let bundle = match bundle {
        Ok(b) => b,
        Err(e) => {
            crate::words::wipe(&mut install_words);
            return Err(e.into());
        }
    };
    // 첫 발급이면 빈 끊기 목록(seq 1)을 같이 만든다 — 확인이 「목록 없음」으로 닫히지 않게.
    if load_list(dir, &chain).is_none() {
        let list = sign_list(chain_sk, &chain, None, &[], now)?;
        write_json(&dir.join("revocations.json"), &list)?;
    }
    certs.push(cert.clone());
    write_json(&dir.join("issued.json"), &json!({ "v": 1, "chain": chain, "certs": certs }))?;
    Ok(Issued { bundle, install_words, store_pubkey: store_pub, serial, cert })
}

/// 매장 PC 합류. 본점 PC(발급 기록이 있는 곳)·다른 본점에 이미 붙은 PC 는 거절. 같은 본점이면 새 증서로 바꾼다.
pub fn join_in(dir: &Path, bundle: &str, words: &str, now: i64) -> Result<StoreCert, String> {
    if dir.join("issued.json").exists() {
        return Err(ERR_IS_OWNER.into());
    }
    let (mut sk, cert) = open_bundle(bundle, words)?;
    let checked = (|| {
        let chain = cert.get("chain").and_then(Value::as_str).ok_or(ERR_CERT)?.to_string();
        let c = verify_store_cert_body(&cert, &chain, now).map_err(|_| ERR_CERT)?;
        if pubkey(&sk)? != c.store_key {
            return Err(ERR_CERT);
        }
        if let Some(old) = read_json(&dir.join("store.json")) {
            if old.pointer("/cert/chain").and_then(Value::as_str) != Some(chain.as_str()) {
                return Err(ERR_JOINED_OTHER);
            }
            if old.pointer("/cert/serial").and_then(Value::as_u64).is_some_and(|s| c.serial < s) {
                return Err(ERR_OLD_BUNDLE);
            }
        }
        Ok(c)
    })();
    let out = match checked {
        Ok(c) => {
            let mut sk_hex = hex::encode(sk);
            let r = write_json(&dir.join("store.json"), &json!({ "v": 1, "secret": sk_hex, "cert": cert }));
            crate::words::wipe(&mut sk_hex);
            r.map(|_| c).map_err(String::from)
        }
        Err(e) => Err(e.to_string()),
    };
    crate::words::wipe_bytes(&mut sk);
    out
}

/// 이 컴퓨터가 체인 매장이면 그 증서의 내용(비밀 없음). 증서 모양·본점 서명만 본다 —
/// 만료·끊김은 보지 않는다(인터넷이 끊기거나 증서가 지나도 결제 기록은 계속 쌓여야 한다 · 원칙 2. 판정은 ③ 본점이 한다).
pub struct StoreSelf {
    pub chain: String,
    pub store: u32,
    pub name: String,
    pub store_key: String,
    pub biz: Value,
}

pub(crate) fn chain_dir_path() -> PathBuf {
    chain_dir()
}

pub fn store_self_in(dir: &Path) -> Option<StoreSelf> {
    if dir.join("issued.json").exists() {
        return None; // 본점 PC 는 매장이 아니다
    }
    let mut v = read_json(&dir.join("store.json"))?;
    if let Some(Value::String(s)) = v.get_mut("secret") {
        crate::words::wipe(s);
    }
    let cert = v.get("cert")?;
    let (o, c) = validate(cert, true).ok()?;
    if !signed_by(CHAIN_DOMAIN, o, &c.chain) {
        return None;
    }
    Some(StoreSelf { biz: o.get("biz").cloned().unwrap_or(Value::Null), chain: c.chain, store: c.store, name: c.name, store_key: c.store_key })
}

/// 매장 열쇠(`chain/store.json`)로 문서에 서명한다(lan_cert 서명 꼴, 부르는 쪽이 도메인을 정한다).
/// 🔴 열쇠는 증서의 storeKey 와 맞을 때만 쓰고, 다 쓰면 지운다. 오류는 고정 문장.
pub fn sign_as_store_in(dir: &Path, domain: &str, body: &Value) -> Result<Value, &'static str> {
    if domain == CHAIN_DOMAIN {
        return Err(ERR_SIGN); // 매장 열쇠가 증서·끊기 목록 도메인에 서명하는 길을 만들지 않는다
    }
    let me = store_self_in(dir).ok_or(ERR_SIGN)?;
    let mut v = read_json(&dir.join("store.json")).ok_or(ERR_SIGN)?;
    let decoded = v.get("secret").and_then(Value::as_str).and_then(|s| hex::decode(s).ok());
    if let Some(Value::String(s)) = v.get_mut("secret") {
        crate::words::wipe(s);
    }
    let mut raw = decoded.ok_or(ERR_SIGN)?;
    let sk: Option<[u8; 32]> = raw.as_slice().try_into().ok();
    crate::words::wipe_bytes(&mut raw);
    let mut sk = sk.ok_or(ERR_SIGN)?;
    let out = match pubkey(&sk) {
        Ok(pk) if pk == me.store_key => sign_doc(domain, body, &pk, ecdsa_signer(&sk)).map_err(|_| ERR_SIGN),
        _ => Err(ERR_SIGN),
    };
    crate::words::wipe_bytes(&mut sk);
    out
}

fn store_row(c: &Value, revoked: &[String]) -> Value {
    let chain = c.get("chain").and_then(Value::as_str).unwrap_or("");
    let serial = c.get("serial").and_then(Value::as_u64).unwrap_or(0);
    json!({
        "serial": serial, "store": c.get("store"), "name": c.get("name"), "storeKey": c.get("storeKey"), "biz": c.get("biz"),
        "issuedAt": c.get("issuedAt"), "notAfter": c.get("notAfter"),
        "revoked": revoked.contains(&store_cert_id(chain, serial)),
    })
}

/// 비밀 없는 상태.
pub fn status_in(dir: &Path) -> Value {
    if let Some((chain, certs)) = load_history(dir) {
        let revoked = load_list(dir, &chain).map(|(_, i)| i.revoked).unwrap_or_default();
        return json!({ "role": "owner", "chain": chain, "stores": certs.len(),
            "active": certs.iter().filter(|c| !store_row(c, &revoked)["revoked"].as_bool().unwrap_or(false)).count() });
    }
    if let Some(v) = read_json(&dir.join("store.json")) {
        let cert = v.get("cert").cloned().unwrap_or(Value::Null);
        // 매장 PC 는 본점이 올린 끊기 목록을 가지고 있을 때만 끊김을 안다(②③에서 받아 온다).
        let chain = cert.get("chain").and_then(Value::as_str).unwrap_or("");
        let revoked = load_list(dir, chain).map(|(_, i)| i.revoked).unwrap_or_default();
        let mut row = store_row(&cert, &revoked);
        row["role"] = json!("store");
        row["chain"] = json!(chain);
        return row;
    }
    json!({ "role": "none" })
}

pub fn list_in(dir: &Path) -> Value {
    let Some((chain, certs)) = load_history(dir) else { return json!({ "chain": null, "stores": [] }) };
    let revoked = load_list(dir, &chain).map(|(_, i)| i.revoked).unwrap_or_default();
    let mut rows: Vec<Value> = certs.iter().map(|c| store_row(c, &revoked)).collect();
    rows.sort_by_key(|r| std::cmp::Reverse(r["serial"].as_u64().unwrap_or(0)));
    json!({ "chain": chain, "stores": rows })
}

/// 끊기 → (서명한 끊기 목록, 서명한 명부). 로컬에 먼저 저장한다(올리기 실패로 되돌리지 않는다).
pub fn revoke_in(dir: &Path, chain_sk: &[u8; 32], serial: u64, now: i64) -> Result<(Value, Value), String> {
    let chain = pubkey(chain_sk)?;
    let (hist_chain, certs) = load_history(dir).ok_or(ERR_NO_SERIAL)?;
    if hist_chain != chain {
        return Err(ERR_OTHER_CHAIN.into());
    }
    let target = certs.iter().find(|c| c.get("serial").and_then(Value::as_u64) == Some(serial)).ok_or(ERR_NO_SERIAL)?;
    let key = target.get("storeKey").and_then(Value::as_str).unwrap_or("").to_string();
    // 같은 열쇠로 나간 증서는 모두 끊는다 — serial 하나만 끊으면 같은 열쇠의 다른 증서가 살아 있다.
    let ids: Vec<String> = certs.iter()
        .filter(|c| c.get("storeKey").and_then(Value::as_str) == Some(key.as_str()))
        .filter_map(|c| c.get("serial").and_then(Value::as_u64))
        .map(|s| store_cert_id(&chain, s)).collect();
    let prev = load_list(dir, &chain).map(|(_, i)| i);
    let list = sign_list(chain_sk, &chain, prev.as_ref(), &ids, now)?;
    write_json(&dir.join("revocations.json"), &list)?;
    let roster = roster_doc(chain_sk, &chain, &certs, &list, now)?;
    Ok((list, roster))
}

/// 명부(캐시일 뿐 — 판정은 증서·끊기 목록). 매장 번호·이름·매장 공개키·끊김. 본점 키 서명.
/// 사업자 번호는 공개 릴레이에 올리지 않는다(본점 issued.json 과 매장 증서 안에만).
fn roster_doc(chain_sk: &[u8; 32], chain: &str, certs: &[Value], list: &Value, now: i64) -> Result<Value, &'static str> {
    let revoked: Vec<String> = list.get("revoked").and_then(Value::as_array).map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect()).unwrap_or_default();
    let stores: Vec<Value> = certs.iter().map(|c| {
        let r = store_row(c, &revoked);
        json!({ "serial": r["serial"], "store": r["store"], "name": r["name"], "storeKey": r["storeKey"], "revoked": r["revoked"] })
    }).collect();
    let body = json!({ "v": 1, "kind": "roster", "chain": chain, "issuedAt": now, "stores": stores });
    sign_doc(CHAIN_DOMAIN, &body, chain, ecdsa_signer(chain_sk)).map_err(|_| ERR_SIGN)
}

// ── 12단어 → 열쇠 (본점) ───────────────────────────────────────────

/// 이 본점이 끊은 매장 공개키들(비밀 없음). 다시 발급할 때 이 열쇠들은 건너뛴다.
pub fn burned_keys(dir: &Path) -> Vec<String> {
    let Some((chain, certs)) = load_history(dir) else { return Vec::new() };
    let revoked = load_list(dir, &chain).map(|(_, i)| i.revoked).unwrap_or_default();
    certs.iter().filter(|c| store_row(c, &revoked)["revoked"].as_bool().unwrap_or(false))
        .filter_map(|c| c.get("storeKey").and_then(Value::as_str).map(String::from)).collect()
}

/// 매장 n 의 첫 「끊기지 않은」 세대 열쇠.
pub fn fresh_store_key(words: &str, pass: &str, n: u32, burned: &[String]) -> Result<[u8; 32], &'static str> {
    for gen in 0..crate::identity::CHAIN_STORE_GENS {
        let mut sk = crate::identity::chain_store_key_from(words, pass, n, gen).ok_or(ERR_KEY)?;
        match pubkey(&sk) {
            Ok(pk) if !burned.contains(&pk) => return Ok(sk),
            _ => crate::words::wipe_bytes(&mut sk),
        }
    }
    Err(ERR_NO_GEN)
}

async fn owner_keys(n: Option<u32>, burned: Vec<String>) -> Result<([u8; 32], Option<[u8; 32]>), String> {
    if crate::app_lock::is_locked() {
        return Err(ERR_LOCKED.into());
    }
    let (mut w, mut p) = crate::identity::words_async().await.map_err(crate::identity::SeedFailure::public_error)?;
    let chain = crate::identity::chain_key_from(&w, &p);
    let store = n.map(|n| fresh_store_key(&w, &p, n, &burned));
    crate::words::wipe(&mut w);
    crate::words::wipe(&mut p);
    let mut chain = chain.ok_or_else(|| ERR_KEY.to_string())?;
    match store {
        None => Ok((chain, None)),
        Some(Ok(s)) => Ok((chain, Some(s))),
        Some(Err(e)) => {
            crate::words::wipe_bytes(&mut chain);
            Err(e.into())
        }
    }
}

/// 체인 열쇠로 Nostr 겉봉투에 서명해 올린다 — 사장의 이야기(사람) 이름과 체인을 공개적으로 묶지 않는다.
/// 겉봉투 서명은 지금 만들어 두고(열쇠는 부르는 쪽이 지운다) 올리기만 나중에 한다.
fn envelope(chain_sk: &[u8; 32], d: &str, doc: &Value) -> Option<Value> {
    let content = serde_json::to_string(doc).ok()?;
    crate::shopkey::sign_with(chain_sk, 30078, json!([["d", d]]), &content, now_ms() / 1000).ok()
}

async fn publish_doc(ev: Option<Value>) -> bool {
    match ev {
        Some(ev) => crate::nostrpub::nostr_publish(ev).await.is_ok(),
        None => false,
    }
}

// ── 명령 ───────────────────────────────────────────────────────────

/// 본점: 매장 열쇠 만들기. 사장 확인(Rust 대화상자 — 화면이 뚫려도 우회 불가) 뒤에 12단어를 받는다.
#[tauri::command]
pub async fn chain_store_issue(app: tauri::AppHandle, n: u32, name: String, biz_no: String, biz_sub: Option<String>) -> Result<Value, String> {
    use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};
    if crate::app_lock::is_locked() {
        return Err(ERR_LOCKED.into());
    }
    if !(1..=9999).contains(&n) {
        return Err(ERR_NUMBER.into());
    }
    let name = clean_name(&name).map_err(String::from)?;
    let biz = clean_biz(&biz_no, biz_sub.as_deref()).map_err(String::from)?;
    let ask = format!("{n}번 매장 「{name}」의 매장 열쇠를 만듭니다.\n\n이 열쇠가 있으면 그 매장 컴퓨터가 본점 이름으로 POS 를 켭니다. 맞으면 「확인」을 눌러 주세요.");
    let ok = tokio::task::spawn_blocking(move || {
        app.dialog().message(ask).title("매장 열쇠 만들기").buttons(MessageDialogButtons::OkCancel).blocking_show()
    }).await.unwrap_or(false);
    if !ok {
        return Err(ERR_DECLINED.into());
    }
    let dir = chain_dir();
    let (mut chain_sk, store_sk) = owner_keys(Some(n), burned_keys(&dir)).await?;
    let mut store_sk = store_sk.unwrap_or([0u8; 32]);
    let r = issue_in(&dir, &chain_sk, &store_sk, n, &name, &biz, now_ms());
    crate::words::wipe_bytes(&mut chain_sk);
    crate::words::wipe_bytes(&mut store_sk);
    let mut r = r?;
    let out = json!({ "bundle_text": r.bundle, "install_words": r.install_words, "store_pubkey": r.store_pubkey, "serial": r.serial });
    crate::words::wipe(&mut r.install_words);
    Ok(out)
}

/// 매장 PC: 본점에서 받은 꾸러미 열기.
#[tauri::command]
pub async fn chain_store_join(bundle_text: String, install_words: String) -> Result<Value, String> {
    if crate::app_lock::is_locked() {
        return Err(ERR_LOCKED.into());
    }
    let mut words = install_words;
    let r = tokio::task::spawn_blocking(move || {
        let r = join_in(&chain_dir(), &bundle_text, &words, now_ms());
        crate::words::wipe(&mut words);
        r
    }).await.map_err(|_| ERR_SAVE.to_string())?;
    let c = r?;
    Ok(json!({ "ok": true, "store": c.store, "name": c.name, "serial": c.serial, "notAfter": c.not_after }))
}

/// 꾸러미 글자 모양만 본다(열지 않는다) — 파일 저장·읽기가 아무 글자나 쓰고 읽는 길이 되지 않게.
pub fn bundle_shape_ok(text: &str) -> bool {
    let t = text.trim();
    t.len() <= MAX_BUNDLE_CHARS
        && t.strip_prefix(BUNDLE_PREFIX).is_some_and(|b| b.len() > 60 && b.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_'))
}

/// 본점: 꾸러미를 사장이 고른 파일로 저장(0600). 꾸러미 모양이 아니면 거절.
#[tauri::command(async)]
pub fn chain_store_bundle_save(path: String, bundle_text: String) -> Result<Value, String> {
    if !bundle_shape_ok(&bundle_text) {
        return Err(ERR_BUNDLE.into());
    }
    let p = PathBuf::from(&path);
    if !p.is_absolute() || !p.file_name().and_then(|f| f.to_str()).is_some_and(|f| f.ends_with(".rvchain.txt")) {
        return Err(ERR_SAVE.into());
    }
    write_text(&p, bundle_text.trim())?;
    Ok(json!({ "path": path }))
}

fn write_text(p: &Path, text: &str) -> Result<(), &'static str> {
    crate::server::atomic_write_0600(p, format!("{text}\n").as_bytes()).map_err(|_| ERR_SAVE)
}

/// 매장 PC: 고른 파일에서 꾸러미 글자를 읽는다. 꾸러미 모양이 아니면 내용을 돌려주지 않는다.
#[tauri::command(async)]
pub fn chain_store_bundle_read(path: String) -> Result<String, String> {
    let p = PathBuf::from(&path);
    let meta = std::fs::metadata(&p).map_err(|_| ERR_BUNDLE.to_string())?;
    if !meta.is_file() || meta.len() > MAX_BUNDLE_CHARS as u64 + 64 {
        return Err(ERR_BUNDLE.into());
    }
    let text = std::fs::read_to_string(&p).map_err(|_| ERR_BUNDLE.to_string())?;
    let t = text.trim();
    if !bundle_shape_ok(t) {
        return Err(ERR_BUNDLE.into());
    }
    Ok(t.to_string())
}

#[tauri::command(async)]
pub fn chain_store_status() -> Value {
    status_in(&chain_dir())
}

#[tauri::command(async)]
pub fn chain_store_list() -> Value {
    list_in(&chain_dir())
}

/// 본점: 이 매장 끊기. 로컬 저장이 먼저, 올리기는 그 뒤(실패해도 끊김은 그대로).
/// 되돌릴 수 없으니 발급과 같이 Rust 대화상자로 한 번 더 묻는다(화면이 뚫려도 전 매장 일괄 끊기 불가).
#[tauri::command]
pub async fn chain_store_revoke(app: tauri::AppHandle, serial: u64) -> Result<Value, String> {
    use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};
    if crate::app_lock::is_locked() {
        return Err(ERR_LOCKED.into());
    }
    let dir = chain_dir();
    let (_, certs) = load_history(&dir).ok_or(ERR_NO_SERIAL)?;
    let target = certs.iter().find(|c| c.get("serial").and_then(Value::as_u64) == Some(serial)).ok_or(ERR_NO_SERIAL)?;
    let label = format!("{}번 「{}」", target.get("store").and_then(Value::as_u64).unwrap_or(0), target.get("name").and_then(Value::as_str).unwrap_or(""));
    let ask = format!("{label} 매장을 끊습니다.\n\n그 매장 컴퓨터의 열쇠를 더는 믿지 않습니다. 되돌릴 수 없어요. 맞으면 「확인」을 눌러 주세요.");
    let ok = tokio::task::spawn_blocking(move || {
        app.dialog().message(ask).title("매장 끊기").buttons(MessageDialogButtons::OkCancel).blocking_show()
    }).await.unwrap_or(false);
    if !ok {
        return Err(ERR_REVOKE_DECLINED.into());
    }
    let (mut chain_sk, _) = owner_keys(None, Vec::new()).await?;
    let r = revoke_in(&dir, &chain_sk, serial, now_ms());
    let evs = r.as_ref().ok().map(|(list, roster)| (envelope(&chain_sk, D_REVOCATIONS, list), envelope(&chain_sk, D_ROSTER, roster)));
    crate::words::wipe_bytes(&mut chain_sk);
    r?;
    let (ev_list, ev_roster) = evs.unwrap_or((None, None));
    let revocations = publish_doc(ev_list).await;
    let roster_ok = publish_doc(ev_roster).await;
    Ok(json!({ "ok": true, "serial": serial, "published": { "revocations": revocations, "roster": roster_ok } }))
}

#[cfg(test)]
mod tests {
    use super::*;

    const WORDS: &str = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
    const NOW: i64 = 1_790_000_000_000;

    fn dir(name: &str) -> PathBuf {
        let d = crate::paths::test_fixture_root().join(format!("chain-store-{name}"));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }
    fn keys(n: u32) -> ([u8; 32], [u8; 32]) {
        (crate::identity::chain_key_from(WORDS, "").unwrap(), crate::identity::chain_store_key_from(WORDS, "", n, 0).unwrap())
    }
    fn biz() -> Value {
        clean_biz("123-45-67890", Some("0001")).unwrap()
    }

    #[test]
    fn different_numbers_give_different_keys_and_none_match_shop_or_person() {
        let a = crate::identity::chain_store_key_from(WORDS, "", 1, 0).unwrap();
        let b = crate::identity::chain_store_key_from(WORDS, "", 2, 0).unwrap();
        assert_ne!(a, b);
        assert_eq!(a, crate::identity::chain_store_key_from(WORDS, "", 1, 0).unwrap(), "다시 뽑으면 같아야 한다");
        let shop = crate::identity::shop_key_from(WORDS, "").unwrap();
        let person = crate::identity::person_key_from(WORDS, "").unwrap();
        for k in [a, b] {
            assert_ne!(k, shop);
            assert_ne!(k, person);
        }
        assert!(crate::identity::chain_store_key_from(WORDS, "", 0, 0).is_none());
        assert!(crate::identity::chain_store_key_from(WORDS, "", 10_000, 0).is_none());
    }

    #[test]
    fn issue_then_join_round_trip() {
        let (owner, store) = (dir("rt-owner"), dir("rt-store"));
        let (csk, ssk) = keys(7);
        let r = issue_in(&owner, &csk, &ssk, 7, "강남점", &biz(), NOW).unwrap();
        assert_eq!(r.serial, 1);
        assert_eq!(r.install_words.split(' ').count(), 6);
        let c = join_in(&store, &r.bundle, &r.install_words.to_uppercase(), NOW + 1000).unwrap();
        assert_eq!((c.store, c.name.as_str(), c.serial), (7, "강남점", 1));
        assert_eq!(c.store_key, r.store_pubkey);
        assert_eq!(status_in(&store)["role"], "store");
        assert_eq!(status_in(&owner)["role"], "owner");
        assert_eq!(status_in(&dir("rt-none"))["role"], "none");
        let saved = std::fs::read_to_string(store.join("store.json")).unwrap();
        assert!(saved.contains(&hex::encode(ssk)));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(std::fs::metadata(store.join("store.json")).unwrap().permissions().mode() & 0o777, 0o600);
        }
        // 다음 발급은 serial 2
        let (_, ssk2) = keys(8);
        assert_eq!(issue_in(&owner, &csk, &ssk2, 8, "역삼점", &biz(), NOW).unwrap().serial, 2);
        // 본점 PC 는 매장으로 합류 못 한다
        assert_eq!(join_in(&owner, &r.bundle, &r.install_words, NOW).unwrap_err(), ERR_IS_OWNER);
        // 다른 본점 꾸러미는 거절
        let other = dir("rt-other-owner");
        let ocsk = crate::identity::chain_key_from("zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo wrong", "").unwrap();
        let o = issue_in(&other, &ocsk, &ssk, 1, "남의 가게", &biz(), NOW).unwrap();
        assert_eq!(join_in(&store, &o.bundle, &o.install_words, NOW).unwrap_err(), ERR_JOINED_OTHER);
    }

    #[test]
    fn wrong_install_words_fail() {
        let owner = dir("ww-owner");
        let (csk, ssk) = keys(3);
        let r = issue_in(&owner, &csk, &ssk, 3, "3호점", &biz(), NOW).unwrap();
        let wrong = "abandon ability able about above absent";
        assert_eq!(open_bundle(&r.bundle, wrong).unwrap_err(), ERR_INSTALL_WORDS);
        assert_eq!(open_bundle(&r.bundle, "abandon ability").unwrap_err(), ERR_INSTALL_WORDS);
        assert!(join_in(&dir("ww-store"), &r.bundle, wrong, NOW).is_err());
        assert_eq!(open_bundle("rvchain1-AAAA", &r.install_words).unwrap_err(), ERR_BUNDLE);
        assert!(bundle_shape_ok(&r.bundle) && !bundle_shape_ok("hello") && !bundle_shape_ok("rvchain1-AAAA"));
        let f = dir("ww-file").join("b.rvchain.txt");
        assert_eq!(chain_store_bundle_save(f.to_string_lossy().into(), "secret words".into()).unwrap_err(), ERR_BUNDLE);
        chain_store_bundle_save(f.to_string_lossy().into(), r.bundle.clone()).unwrap();
        assert_eq!(chain_store_bundle_read(f.to_string_lossy().into()).unwrap(), r.bundle);
    }

    #[test]
    fn tampered_cert_fails() {
        let owner = dir("tc-owner");
        let (csk, ssk) = keys(4);
        let r = issue_in(&owner, &csk, &ssk, 4, "4호점", &biz(), NOW).unwrap();
        let chain = pubkey(&csk).unwrap();
        let list = read_json(&owner.join("revocations.json")).unwrap();
        assert!(verify_store_cert(&r.cert, &chain, NOW, Some(&list)).is_ok());
        let mut bad = r.cert.clone();
        bad["name"] = json!("가짜점");
        assert_eq!(verify_store_cert(&bad, &chain, NOW, Some(&list)).unwrap_err(), CertReason::Signature);
        let mut bad = r.cert.clone();
        bad["scope"] = json!(["pos"]);
        assert_eq!(verify_store_cert(&bad, &chain, NOW, Some(&list)).unwrap_err(), CertReason::Shape);
        assert_eq!(verify_store_cert(&r.cert, &chain, NOW + CERT_LIFE_MS, Some(&list)).unwrap_err(), CertReason::Expired);
        assert_eq!(verify_store_cert(&r.cert, &chain, NOW - 60_000, Some(&list)).unwrap_err(), CertReason::NotYet);
        assert_eq!(verify_store_cert(&r.cert, &chain, 5, Some(&list)).unwrap_err(), CertReason::BadClock);
        assert_eq!(verify_store_cert(&r.cert, &chain, NOW, None).unwrap_err(), CertReason::NoRevocationList);
        assert_eq!(verify_store_cert(&r.cert, &pubkey(&ssk).unwrap(), NOW, Some(&list)).unwrap_err(), CertReason::Signature);
        // 바꾼 증서를 넣어 다시 봉한 꾸러미는 합류 못 한다
        let forged = seal_bundle(&ssk, &bad, &r.install_words).unwrap();
        assert_eq!(join_in(&dir("tc-store"), &forged, &r.install_words, NOW).unwrap_err(), ERR_CERT);
        // 다른 매장 비밀 열쇠 + 진짜 증서도 거절
        let (_, other) = keys(5);
        let swapped = seal_bundle(&other, &r.cert, &r.install_words).unwrap();
        assert_eq!(join_in(&dir("tc-store2"), &swapped, &r.install_words, NOW).unwrap_err(), ERR_CERT);
    }

    #[test]
    fn revoked_serial_fails_verify_but_others_pass() {
        let owner = dir("rv-owner");
        let (csk, s1) = keys(1);
        let (_, s2) = keys(2);
        let a = issue_in(&owner, &csk, &s1, 1, "1호점", &biz(), NOW).unwrap();
        let b = issue_in(&owner, &csk, &s2, 2, "2호점", &biz(), NOW).unwrap();
        let chain = pubkey(&csk).unwrap();
        let (list, roster) = revoke_in(&owner, &csk, a.serial, NOW + 5000).unwrap();
        assert_eq!(verify_store_cert(&a.cert, &chain, NOW + 6000, Some(&list)).unwrap_err(), CertReason::Revoked);
        assert!(verify_store_cert(&b.cert, &chain, NOW + 6000, Some(&list)).is_ok());
        assert_eq!(list["seq"], 2);
        assert_eq!(read_json(&owner.join("revocations.json")).unwrap(), list, "로컬에 먼저 남는다");
        let rows = list_in(&owner)["stores"].as_array().unwrap().clone();
        assert!(rows.iter().any(|r| r["serial"] == 1 && r["revoked"] == true));
        assert!(rows.iter().any(|r| r["serial"] == 2 && r["revoked"] == false));
        assert!(roster.get("sig").is_some() && !serde_json::to_string(&roster).unwrap().contains(&hex::encode(s1)));
        assert_eq!(revoke_in(&owner, &csk, 99, NOW).unwrap_err(), ERR_NO_SERIAL);
        // 다른 도메인(lan_cert 기기 철회)으로는 이 목록이 통하지 않는다
        assert!(crate::lan_cert::verify_revocation_list(&list, &chain, &chain_list_id(&chain)).is_err());
    }

    #[test]
    fn bundle_and_files_never_hold_the_12_words_or_chain_secret() {
        let owner = dir("nw-owner");
        let (csk, ssk) = keys(9);
        let r = issue_in(&owner, &csk, &ssk, 9, "9호점", &biz(), NOW).unwrap();
        let store = dir("nw-store");
        join_in(&store, &r.bundle, &r.install_words, NOW).unwrap();
        let (sk, cert) = open_bundle(&r.bundle, &r.install_words).unwrap();
        let mut inside = serde_json::to_string(&cert).unwrap();
        inside.push_str(&hex::encode(sk));
        let files: Vec<String> = ["issued.json", "revocations.json"].iter().map(|f| std::fs::read_to_string(owner.join(f)).unwrap())
            .chain([std::fs::read_to_string(store.join("store.json")).unwrap()]).collect();
        for hay in [&r.bundle, &inside].into_iter().chain(files.iter()) {
            assert!(!hay.contains("abandon"), "12단어가 새어 나왔다");
            assert!(!hay.contains(&hex::encode(csk)), "본점 열쇠가 새어 나왔다");
        }
        assert!(!r.bundle.contains(&hex::encode(ssk)), "꾸러미는 봉함돼 있어야 한다");
        assert!(!files[0].contains(&hex::encode(ssk)) && !files[1].contains(&hex::encode(ssk)), "본점 기록에 매장 비밀이 남았다");
    }

    #[test]
    fn revoked_number_reissues_a_new_key_and_kills_every_cert_of_the_old_key() {
        let owner = dir("gen-owner");
        let (csk, s0) = keys(5);
        let a = issue_in(&owner, &csk, &s0, 5, "5호점", &biz(), NOW).unwrap();
        // 같은 열쇠로 한 번 더 발급(예: 이름 바꿈) → 증서 둘, 열쇠 하나
        let a2 = issue_in(&owner, &csk, &s0, 5, "5호점 새이름", &biz(), NOW).unwrap();
        let chain = pubkey(&csk).unwrap();
        let (list, roster) = revoke_in(&owner, &csk, a.serial, NOW + 1000).unwrap();
        assert_eq!(verify_store_cert(&a2.cert, &chain, NOW + 2000, Some(&list)).unwrap_err(), CertReason::Revoked, "같은 열쇠의 다른 증서도 죽어야 한다");
        assert!(!serde_json::to_string(&roster).unwrap().contains("123-45") && !serde_json::to_string(&roster).unwrap().contains("1234567890"), "공개 명부에 사업자 번호 금지");
        // 다시 발급하면 끊긴 세대를 건너뛴다
        let burned = burned_keys(&owner);
        assert_eq!(burned, vec![pubkey(&s0).unwrap(), pubkey(&s0).unwrap()]);
        let fresh = fresh_store_key(WORDS, "", 5, &burned).unwrap();
        assert_ne!(fresh, s0);
        assert_eq!(fresh, crate::identity::chain_store_key_from(WORDS, "", 5, 1).unwrap());
    }

    #[test]
    fn chain_key_is_not_the_shop_key_and_old_bundles_cannot_roll_back() {
        let chain = crate::identity::chain_key_from(WORDS, "").unwrap();
        assert_ne!(chain, crate::identity::shop_key_from(WORDS, "").unwrap(), "간판 열쇠는 아무 다이제스트에나 서명한다 — 체인 열쇠와 같으면 안 된다");
        let (owner, store) = (dir("rb-owner"), dir("rb-store"));
        let (csk, ssk) = keys(6);
        let old = issue_in(&owner, &csk, &ssk, 6, "6호점", &biz(), NOW).unwrap();
        let new = issue_in(&owner, &csk, &ssk, 6, "6호점", &biz(), NOW).unwrap();
        join_in(&store, &new.bundle, &new.install_words, NOW).unwrap();
        assert_eq!(join_in(&store, &old.bundle, &old.install_words, NOW).unwrap_err(), ERR_OLD_BUNDLE);
        let bad = dir("rb-file").join("x.txt");
        assert_eq!(chain_store_bundle_save(bad.to_string_lossy().into(), new.bundle.clone()).unwrap_err(), ERR_SAVE, "확장자는 .rvchain.txt 만");
    }

    #[test]
    fn inputs_are_checked() {
        assert!(clean_name("").is_err());
        assert!(clean_name(&"가".repeat(41)).is_err());
        assert!(clean_name("강남\n점").is_err());
        assert_eq!(clean_biz("1234567890", Some("")).unwrap(), json!({"no":"1234567890"}));
        assert!(clean_biz("12345", None).is_err());
        assert!(clean_biz("1234567890", Some("12")).is_err());
        let (csk, ssk) = keys(1);
        let chain = pubkey(&csk).unwrap();
        assert!(cert_body(&chain, 0, "x", &pubkey(&ssk).unwrap(), &biz(), 1, NOW).is_err());
        assert!(cert_body(&chain, 1, "x", &chain, &biz(), 1, NOW).is_err(), "본점 키 = 매장 키 금지");
    }
}
