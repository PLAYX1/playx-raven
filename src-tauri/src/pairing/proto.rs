//! RV6 규격 v1 의 **바이트 규칙** — 폰 `core/pairing/*.ts` 를 한 줄씩 옮긴 것.
//!
//! 여기 있는 것은 전부 순수 함수다(파일·네트워크·시계 없음). 그래서 폰이 만든
//! `vectors.json` 의 값을 **바이트까지** 그대로 다시 만들 수 있고, 시험이 그것을
//! 확인한다(`pairing/tests.rs`).
//!
//! 🔴 직접 만든 암호는 없다. x25519-dalek · chacha20poly1305(XChaCha20Poly1305) ·
//!    hkdf+sha2 · secp256k1(BIP340) 만 부른다.
//! 🔴 지갑과 무관하다. 이 파일은 지갑 키·복구 단어·지갑 암호를 읽는 코드를 부르지
//!    않고, 그런 이름의 칸이 든 메시지는 봉하지 않는다(`assert_no_secret_fields`).

use chacha20poly1305::aead::{Aead, KeyInit, Payload};
use chacha20poly1305::{XChaCha20Poly1305, XNonce};
use hkdf::Hkdf;
use secp256k1::{schnorr::Signature, Keypair, Secp256k1, XOnlyPublicKey};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};

/// 기계가 읽는 짧은 이유. 화면은 이 코드를 한국어 문장으로 바꾼다.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PairingError(pub &'static str);
impl std::fmt::Display for PairingError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.0)
    }
}
pub type R<T> = Result<T, PairingError>;
pub fn fail<T>(code: &'static str) -> R<T> {
    Err(PairingError(code))
}

// ── util ────────────────────────────────────────────────────────────────────

/// 소문자 hex, 정확히 `bytes` 바이트. 대문자는 거부 — 양쪽 표기를 하나로.
pub fn is_hex(v: &str, bytes: usize) -> bool {
    v.len() == bytes * 2 && v.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}
pub fn is_hex_value(v: &Value, bytes: usize) -> bool {
    v.as_str().map(|s| is_hex(s, bytes)).unwrap_or(false)
}
pub fn unhex<const N: usize>(v: &str, code: &'static str) -> R<[u8; N]> {
    if !is_hex(v, N) {
        return fail(code);
    }
    let mut out = [0u8; N];
    hex::decode_to_slice(v, &mut out).map_err(|_| PairingError(code))?;
    Ok(out)
}

/// 비밀 바이트를 지운다. 컴파일러가 「안 쓰는 쓰기」로 보고 빼지 못하게 volatile 로.
pub fn wipe(b: &mut [u8]) {
    for x in b.iter_mut() {
        // SAFETY: `x` 는 살아 있는 &mut u8 이다.
        unsafe { std::ptr::write_volatile(x, 0) };
    }
}

pub fn sha256(parts: &[&[u8]]) -> [u8; 32] {
    let mut h = Sha256::new();
    for p in parts {
        h.update(p);
    }
    h.finalize().into()
}

/// JS `Number.isSafeInteger(v)` — 정수 모양 소수(1.0)도 받는다.
pub fn safe_int(v: &Value) -> Option<i64> {
    const MAX: i64 = 9_007_199_254_740_991;
    if let Some(i) = v.as_i64() {
        return (-MAX..=MAX).contains(&i).then_some(i);
    }
    if v.is_u64() {
        return None; // i64 를 넘는 u64 는 안전 정수가 아니다
    }
    let f = v.as_f64()?;
    (f.is_finite() && f.fract() == 0.0 && f.abs() <= MAX as f64).then_some(f as i64)
}
fn is_one(v: &Value) -> bool {
    v.as_f64() == Some(1.0)
}
fn exact_keys(o: &Map<String, Value>, keys: &[&str], optional: &[&str]) -> bool {
    keys.iter().all(|k| o.contains_key(*k)) && o.keys().all(|k| keys.contains(&k.as_str()) || optional.contains(&k.as_str()))
}

pub const MAX_NAME_BYTES: usize = 40;
/// 사장이 허락을 판단할 때 보는 글자라서, 모습을 감출 수 있는 글자는 거부한다
/// (제어 문자·양방향 제어·폭 0). 폰 `isValidName` 과 같다.
pub fn is_valid_name(s: &str) -> bool {
    if s.is_empty() || s.trim().is_empty() || s != s.trim() || s.len() > MAX_NAME_BYTES {
        return false;
    }
    !s.chars().any(|c| {
        let u = c as u32;
        u <= 0x1f
            || (0x7f..=0x9f).contains(&u)
            || (0x200b..=0x200f).contains(&u)
            || (0x202a..=0x202e).contains(&u)
            || (0x2066..=0x2069).contains(&u)
            || u == 0xfeff
    })
}

/// JS `String.prototype.trim()` 이 지우는 공백인가(Rust `char::is_whitespace` + U+FEFF).
fn js_space(c: char) -> bool {
    c.is_whitespace() || c == '\u{feff}'
}

// ── §1 기기 키 ──────────────────────────────────────────────────────────────

/// 연결 기능을 처음 켤 때 한 번 만드는 **기기** 키. 지갑과 무관한 무작위 값이다.
pub struct DeviceKeys {
    sign: Keypair,
    pub sign_pub: String,
    dh: [u8; 32],
    pub dh_pub: String,
}
impl Drop for DeviceKeys {
    fn drop(&mut self) {
        wipe(&mut self.dh);
    }
}
impl DeviceKeys {
    pub fn from_secrets(sign_sk: &[u8; 32], dh_sk: &[u8; 32]) -> R<Self> {
        let secp = Secp256k1::new();
        let sign = Keypair::from_seckey_slice(&secp, sign_sk).map_err(|_| PairingError("bad_device_key"))?;
        let (x, _) = sign.x_only_public_key();
        let dh_pub = x25519_dalek::PublicKey::from(&x25519_dalek::StaticSecret::from(*dh_sk));
        Ok(Self { sign, sign_pub: hex::encode(x.serialize()), dh: *dh_sk, dh_pub: hex::encode(dh_pub.as_bytes()) })
    }
    pub fn generate() -> R<Self> {
        use rand::RngCore;
        for _ in 0..16 {
            let (mut a, mut b) = ([0u8; 32], [0u8; 32]);
            rand::rngs::OsRng.fill_bytes(&mut a);
            rand::rngs::OsRng.fill_bytes(&mut b);
            let k = Self::from_secrets(&a, &b);
            wipe(&mut a);
            wipe(&mut b);
            if let Ok(k) = k {
                return Ok(k);
            }
        }
        fail("random_failed")
    }
    pub fn dh_secret(&self) -> &[u8; 32] {
        &self.dh
    }
    /// 이 컴퓨터 안(`pairing/device.json`, 0600)에만 두는 모양. 메시지에는 절대 안 실린다.
    pub fn encode_local(&self) -> String {
        let mut s = self.sign.secret_bytes();
        let out = json!({ "v": 1, "sign_sk": hex::encode(s), "dh_sk": hex::encode(self.dh) }).to_string();
        wipe(&mut s);
        out
    }
    pub fn decode_local(text: &str) -> R<Self> {
        let v: Value = serde_json::from_str(text).map_err(|_| PairingError("bad_device_key"))?;
        if !is_one(&v["v"]) {
            return fail("bad_device_key");
        }
        let mut a: [u8; 32] = unhex(v["sign_sk"].as_str().unwrap_or(""), "bad_device_key")?;
        let mut b: [u8; 32] = unhex(v["dh_sk"].as_str().unwrap_or(""), "bad_device_key")?;
        let k = Self::from_secrets(&a, &b);
        wipe(&mut a);
        wipe(&mut b);
        k
    }
    pub fn fingerprint(&self) -> String {
        fingerprint(&self.sign_pub, &self.dh_pub).unwrap_or_default()
    }
}

/// `fp = sha256("rv-pair-fp-v1" ‖ sign_pub ‖ dh_pub)[0..5]` → `XXXX-XXXX-XX`
pub fn fingerprint(sign_pub: &str, dh_pub: &str) -> R<String> {
    let s: [u8; 32] = unhex(sign_pub, "bad_hex")?;
    let d: [u8; 32] = unhex(dh_pub, "bad_hex")?;
    let h = hex::encode_upper(&sha256(&[b"rv-pair-fp-v1", &s, &d])[..5]);
    Ok(format!("{}-{}-{}", &h[0..4], &h[4..8], &h[8..10]))
}

// ── §3 키 만들기 ────────────────────────────────────────────────────────────

fn hkdf32(ikm: &[u8], salt: &[u8], info: &str) -> [u8; 32] {
    let hk = Hkdf::<Sha256>::new(Some(salt), ikm);
    let mut o = [0u8; 32];
    // 32 바이트는 SHA-256 HKDF 의 한도(255×32) 안이라 실패하지 않는다.
    hk.expand(info.as_bytes(), &mut o).expect("hkdf 32 bytes");
    o
}
pub fn derive_code_key(code: &[u8; 16]) -> [u8; 32] {
    hkdf32(code, &[], "rv-pair-hello-v1")
}
pub fn derive_pair_room(code: &[u8; 16]) -> String {
    hex::encode(sha256(&[b"rv-pair-room-v1", code]))
}
/// X25519. 결과가 전부 0 이면(저차수 점) 라이브러리와 무관하게 거부한다.
pub fn derive_shared(my_dh: &[u8; 32], peer_dh_pub: &str) -> R<[u8; 32]> {
    let peer: [u8; 32] = unhex(peer_dh_pub, "bad_peer_key")?;
    let s = x25519_dalek::StaticSecret::from(*my_dh).diffie_hellman(&x25519_dalek::PublicKey::from(peer));
    let out = s.to_bytes();
    if out.iter().all(|b| *b == 0) {
        return fail("bad_peer_key");
    }
    Ok(out)
}
pub struct TranscriptKeys<'a> {
    pub desk_sign: &'a str,
    pub desk_dh: &'a str,
    pub phone_sign: &'a str,
    pub phone_dh: &'a str,
}
pub fn derive_transcript(code: &[u8; 16], k: &TranscriptKeys) -> R<[u8; 32]> {
    let a: [u8; 32] = unhex(k.desk_sign, "bad_peer_key")?;
    let b: [u8; 32] = unhex(k.desk_dh, "bad_peer_key")?;
    let c: [u8; 32] = unhex(k.phone_sign, "bad_peer_key")?;
    let d: [u8; 32] = unhex(k.phone_dh, "bad_peer_key")?;
    Ok(sha256(&[b"rv-pair-th-v1", code, &a, &b, &c, &d]))
}
pub struct Channel {
    pub ch_key: [u8; 32],
    pub ch_room: String,
    pub sas: String,
}
impl Drop for Channel {
    fn drop(&mut self) {
        wipe(&mut self.ch_key);
    }
}
pub fn derive_channel_from_shared(shared: &[u8; 32], th: &[u8; 32]) -> Channel {
    let ch_key = hkdf32(shared, th, "rv-pair-channel-v1");
    let ch_room = hex::encode(sha256(&[b"rv-pair-chroom-v1", &ch_key]));
    let s = hkdf32(shared, th, "rv-pair-sas-v1");
    let u = u32::from_be_bytes([s[0], s[1], s[2], s[3]]);
    Channel { ch_key, ch_room, sas: format!("{:06}", u % 1_000_000) }
}
/// 데스크톱 쪽: 내 X25519 비밀 + 폰 공개키.
pub fn derive_channel_desktop(my_dh: &[u8; 32], code: &[u8; 16], k: &TranscriptKeys) -> R<Channel> {
    let mut shared = derive_shared(my_dh, k.phone_dh)?;
    let th = derive_transcript(code, k);
    let out = th.map(|th| derive_channel_from_shared(&shared, &th));
    wipe(&mut shared);
    out
}

// ── §4–5 봉함 (rvchat1 kind 42) ────────────────────────────────────────────

pub const MAX_CHAT_BYTES: usize = 4096;

#[derive(Clone)]
pub struct Room {
    pub key: [u8; 32],
    pub id: String,
}
impl Drop for Room {
    fn drop(&mut self) {
        wipe(&mut self.key);
    }
}
pub fn hello_room(code: &[u8; 16]) -> Room {
    Room { key: derive_code_key(code), id: derive_pair_room(code) }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ChatEvent {
    pub id: String,
    pub pubkey: String,
    pub created_at: i64,
    pub kind: i64,
    pub tags: Vec<Vec<String>>,
    pub content: String,
    pub sig: String,
}
impl ChatEvent {
    pub fn room(&self) -> &str {
        self.tags.first().and_then(|t| t.get(1)).map(String::as_str).unwrap_or("")
    }
    pub fn to_value(&self) -> Value {
        serde_json::to_value(self).unwrap_or(Value::Null)
    }
}

/// 시험 벡터용 고정 입력. 실제로는 둘 다 비워 두고 무작위를 쓴다.
#[derive(Default, Clone, Copy)]
pub struct SealOpts {
    pub nonce: Option<[u8; 24]>,
    pub aux: Option<[u8; 32]>,
}

/// `sha256(JSON [0,pubkey,created_at,42,tags,content])` — 공백 없음(NIP-01).
fn hash_event(pubkey: &str, created_at: i64, kind: i64, tags: &Value, content: &str) -> [u8; 32] {
    let pre = serde_json::to_string(&json!([0, pubkey, created_at, kind, tags, content])).unwrap_or_default();
    sha256(&[pre.as_bytes()])
}
fn aad(room: &str, pubkey: &str, created_at: i64) -> String {
    serde_json::to_string(&json!([1, room, pubkey, created_at])).unwrap_or_default()
}

pub fn seal_text(room: &Room, keys: &DeviceKeys, text: &str, created_at: i64, opts: SealOpts) -> R<ChatEvent> {
    if text.is_empty() || text.len() > MAX_CHAT_BYTES {
        return fail("message_too_large");
    }
    if !(0..=9_007_199_254_740_991).contains(&created_at) {
        return fail("bad_time");
    }
    let nonce = match opts.nonce {
        Some(n) => n,
        None => {
            use rand::RngCore;
            let mut n = [0u8; 24];
            rand::rngs::OsRng.fill_bytes(&mut n);
            n
        }
    };
    let pubkey = keys.sign_pub.clone();
    let cipher = XChaCha20Poly1305::new((&room.key).into());
    let ad = aad(&room.id, &pubkey, created_at);
    let ct = cipher
        .encrypt(XNonce::from_slice(&nonce), Payload { msg: text.as_bytes(), aad: ad.as_bytes() })
        .map_err(|_| PairingError("seal_failed"))?;
    let tags = vec![vec!["e".to_string(), room.id.clone()], vec!["t".to_string(), "ravenvault".to_string()]];
    let content = format!("rvchat1:{}:{}", hex::encode(nonce), hex::encode(ct));
    let hash = hash_event(&pubkey, created_at, 42, &json!(tags), &content);
    let secp = Secp256k1::new();
    let sig = match opts.aux {
        Some(aux) => secp.sign_schnorr_with_aux_rand(&hash, &keys.sign, &aux),
        None => secp.sign_schnorr(&hash, &keys.sign),
    };
    Ok(ChatEvent { id: hex::encode(hash), pubkey, created_at, kind: 42, tags, content, sig: hex::encode(sig.to_byte_array()) })
}

/// 🔴 모든 연결 메시지가 지나가는 한 자리. 여기서 비밀 이름의 칸을 막으면 모든 만들기가 막힌다.
/// `created_at = floor(ts_ms/1000)`.
pub fn seal_message(room: &Room, keys: &DeviceKeys, message: &Value, ts_ms: i64, opts: SealOpts) -> R<(ChatEvent, String)> {
    assert_no_secret_fields(message, 0)?;
    let text = serde_json::to_string(message).map_err(|_| PairingError("bad_message"))?;
    let ev = seal_text(room, keys, &text, ts_ms.div_euclid(1000), opts)?;
    Ok((ev, text))
}

fn lower_hex_re(s: &str) -> bool {
    s.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

/// 폰 `verifyChatEvent` — 모양·서명 확인. 방 열쇠는 안 쓴다(릴레이도 할 수 있는 검사).
pub fn verify_chat_event(v: &Value) -> R<ChatEvent> {
    let bad = || PairingError("bad_event");
    let o = v.as_object().ok_or_else(bad)?;
    let s = |k: &str| o.get(k).and_then(Value::as_str).ok_or_else(bad);
    let (id, pubkey, sig, content) = (s("id")?, s("pubkey")?, s("sig")?, s("content")?);
    if safe_int(o.get("kind").unwrap_or(&Value::Null)) != Some(42) || !is_hex(id, 32) || !is_hex(pubkey, 32) || !is_hex(sig, 64) {
        return fail("bad_event");
    }
    let created_at = safe_int(o.get("created_at").unwrap_or(&Value::Null)).filter(|x| *x >= 0).ok_or_else(bad)?;
    let tags_v = o.get("tags").ok_or_else(bad)?;
    let room = tags_v.get(0).and_then(|t| t.get(1)).and_then(Value::as_str).unwrap_or("");
    if !is_hex(room, 32) || *tags_v != json!([["e", room], ["t", "ravenvault"]]) || content.chars().count() > 8300 {
        return fail("bad_event");
    }
    let hash = hash_event(pubkey, created_at, 42, tags_v, content);
    if hex::encode(hash) != id {
        return fail("bad_event");
    }
    let xpk = XOnlyPublicKey::from_slice(&hex::decode(pubkey).map_err(|_| bad())?).map_err(|_| bad())?;
    let sg = Signature::from_slice(&hex::decode(sig).map_err(|_| bad())?).map_err(|_| bad())?;
    Secp256k1::verification_only().verify_schnorr(&sg, &hash, &xpk).map_err(|_| bad())?;
    let body = content.strip_prefix("rvchat1:").ok_or_else(bad)?;
    let (n, c) = body.split_once(':').ok_or_else(bad)?;
    if n.len() != 48 || !lower_hex_re(n) || c.is_empty() || !lower_hex_re(c) || c.len() % 2 != 0 || c.len() < 34 || c.len() > (MAX_CHAT_BYTES + 16) * 2 {
        return fail("bad_event");
    }
    Ok(ChatEvent {
        id: id.into(),
        pubkey: pubkey.into(),
        created_at,
        kind: 42,
        tags: vec![vec!["e".into(), room.into()], vec!["t".into(), "ravenvault".into()]],
        content: content.into(),
        sig: sig.into(),
    })
}

/// 서명·방 확인 → 복호 → UTF-8 → JSON. 무엇이 틀려도 `open_failed` 하나(조용히 버린다).
pub fn open_message(room: &Room, v: &Value) -> R<(ChatEvent, Value)> {
    let e = verify_chat_event(v).map_err(|_| PairingError("open_failed"))?;
    if e.room() != room.id {
        return fail("open_failed");
    }
    let (n, c) = e.content["rvchat1:".len()..].split_once(':').ok_or(PairingError("open_failed"))?;
    let nonce = hex::decode(n).map_err(|_| PairingError("open_failed"))?;
    let ct = hex::decode(c).map_err(|_| PairingError("open_failed"))?;
    let cipher = XChaCha20Poly1305::new((&room.key).into());
    let ad = aad(&room.id, &e.pubkey, e.created_at);
    let mut plain = cipher
        .decrypt(XNonce::from_slice(&nonce), Payload { msg: &ct, aad: ad.as_bytes() })
        .map_err(|_| PairingError("open_failed"))?;
    let parsed = match std::str::from_utf8(&plain) {
        Ok(t) if !t.trim_matches(js_space).is_empty() => serde_json::from_str::<Value>(t).map_err(|_| PairingError("open_failed")),
        _ => fail("open_failed"),
    };
    wipe(&mut plain);
    Ok((e, parsed?))
}

// ── §2 QR ───────────────────────────────────────────────────────────────────

pub const QR_TTL_SECONDS: i64 = 120;
pub const MAX_RELAYS: usize = 3;
const RELAY_PATHS: [&str; 2] = ["/relay", "/api/relay"];

fn private_ipv4(host: &str) -> bool {
    let parts: Vec<&str> = host.split('.').collect();
    if parts.len() != 4 {
        return false;
    }
    let mut o = [0u16; 4];
    for (i, p) in parts.iter().enumerate() {
        if p.is_empty() || p.len() > 3 || !p.bytes().all(|b| b.is_ascii_digit()) || (p.len() > 1 && p.starts_with('0')) {
            return false;
        }
        o[i] = p.parse().unwrap_or(999);
        if o[i] > 255 {
            return false;
        }
    }
    o[0] == 10 || (o[0] == 172 && (16..=31).contains(&o[1])) || (o[0] == 192 && o[1] == 168)
}
fn valid_port(p: &str) -> bool {
    !p.is_empty() && p.len() <= 5 && !p.starts_with('0') && p.bytes().all(|b| b.is_ascii_digit()) && p.parse::<u32>().map(|n| n <= 65535).unwrap_or(false)
}
fn relay_path(p: &str) -> bool {
    p.len() > 1 && p.starts_with('/') && p.bytes().all(|b| b.is_ascii_lowercase() || b == b'/') && RELAY_PATHS.contains(&p)
}
/// 같은 Wi-Fi 직통: `ws://` + 사설 IPv4 + 명시 포트 + `/relay`|`/api/relay`.
pub fn is_lan_relay_url(v: &str) -> bool {
    if v.len() > 64 {
        return false;
    }
    let Some(rest) = v.strip_prefix("ws://") else { return false };
    let Some(slash) = rest.find('/') else { return false };
    let (hp, path) = rest.split_at(slash);
    let Some((host, port)) = hp.split_once(':') else { return false };
    host.bytes().all(|b| b.is_ascii_digit() || b == b'.') && private_ipv4(host) && valid_port(port) && relay_path(path)
}
/// 바깥 통로: `wss://` + 소문자 DNS 이름(IP 금지) [+포트] + 릴레이 경로.
pub fn is_remote_relay_url(v: &str) -> bool {
    if v.len() > 200 {
        return false;
    }
    let Some(rest) = v.strip_prefix("wss://") else { return false };
    let Some(slash) = rest.find('/') else { return false };
    let (hp, path) = rest.split_at(slash);
    let (host, port) = match hp.split_once(':') {
        Some((h, p)) => (h, Some(p)),
        None => (hp, None),
    };
    if host.is_empty() || !host.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'.' || b == b'-') {
        return false;
    }
    if port.map(|p| !valid_port(p)).unwrap_or(false) || !relay_path(path) {
        return false;
    }
    let labels: Vec<&str> = host.split('.').collect();
    host.len() <= 253
        && labels.len() >= 2
        && labels.iter().all(|l| {
            !l.is_empty() && l.len() <= 63 && !l.starts_with('-') && !l.ends_with('-')
        })
        && labels.last().map(|l| l.bytes().any(|b| b.is_ascii_lowercase())).unwrap_or(false)
}
pub fn valid_relay_list(v: &[String]) -> bool {
    let set: std::collections::HashSet<&String> = v.iter().collect();
    v.len() <= MAX_RELAYS && v.iter().all(|r| is_remote_relay_url(r)) && set.len() == v.len()
}
fn valid_relay_value(v: &Value) -> bool {
    match v.as_array() {
        Some(a) => {
            let s: Option<Vec<String>> = a.iter().map(|x| x.as_str().map(str::to_string)).collect();
            s.map(|s| valid_relay_list(&s)).unwrap_or(false)
        }
        None => false,
    }
}
fn valid_lan_value(v: &Value) -> bool {
    v.is_null() || v.as_str().map(is_lan_relay_url).unwrap_or(false)
}

/// JS `encodeURIComponent` (UTF-8, 대문자 %XX, `A-Za-z0-9-_.!~*'()` 는 그대로).
pub fn encode_uri_component(s: &str) -> String {
    let mut out = String::new();
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&b) {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

pub struct QrInput<'a> {
    pub desk_sign: &'a str,
    pub desk_dh: &'a str,
    pub code_hex: &'a str,
    pub expires_at: i64,
    pub name: &'a str,
    pub lan: Option<&'a str>,
    pub relays: &'a [String],
}
pub fn build_pair_qr(q: &QrInput) -> R<String> {
    if !is_hex(q.desk_sign, 32) || !is_hex(q.desk_dh, 32) || !is_hex(q.code_hex, 16) || q.expires_at <= 0
        || !is_valid_name(q.name) || !q.lan.map(is_lan_relay_url).unwrap_or(true) || !valid_relay_list(q.relays)
    {
        return fail("qr_invalid");
    }
    let mut s = format!(
        "ravenvault://pair?v=1&s={}&x={}&c={}&e={}&n={}",
        q.desk_sign, q.desk_dh, q.code_hex, q.expires_at, encode_uri_component(q.name)
    );
    if let Some(l) = q.lan {
        s.push_str(&format!("&l={l}"));
    }
    for r in q.relays {
        s.push_str(&format!("&r={r}"));
    }
    Ok(s)
}

// ── §4–6 메시지 ─────────────────────────────────────────────────────────────

/// 🔴 개인키·복구 단어·WIF·지갑 암호 같은 이름의 칸이 **어느 깊이에든** 있으면 봉하지 않는다.
/// (폰 `SECRET_KEY_NAME` 과 같은 규칙)
pub fn assert_no_secret_fields(v: &Value, depth: usize) -> R<()> {
    if depth > 16 {
        return fail("message_too_deep");
    }
    match v {
        Value::Array(a) => a.iter().try_for_each(|x| assert_no_secret_fields(x, depth + 1)),
        Value::Object(o) => {
            for (k, x) in o {
                if secret_name(k) {
                    return fail("secret_field");
                }
                assert_no_secret_fields(x, depth + 1)?;
            }
            Ok(())
        }
        _ => Ok(()),
    }
}
fn secret_name(k: &str) -> bool {
    let l = k.to_lowercase();
    ["mnemonic", "seed", "priv", "wif", "password", "passphrase", "passwd", "secret", "xprv"].iter().any(|w| l.contains(w))
        || l == "sk"
        || l.ends_with("_sk")
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Perms {
    pub view: bool,
    pub request: bool,
    /// "desktop" | "phone"
    pub money: String,
    /// 정수 RVN
    pub daily_limit_rvn: u64,
}
impl Default for Perms {
    fn default() -> Self {
        Self { view: true, request: false, money: "desktop".into(), daily_limit_rvn: 0 }
    }
}
pub fn is_perms(v: &Value) -> bool {
    let Some(o) = v.as_object() else { return false };
    exact_keys(o, &["view", "request", "money", "daily_limit_rvn"], &[])
        && o["view"].is_boolean()
        && o["request"].is_boolean()
        && matches!(o["money"].as_str(), Some("desktop") | Some("phone"))
        && safe_int(&o["daily_limit_rvn"]).map(|n| n >= 0).unwrap_or(false)
}
impl Perms {
    #[allow(dead_code)] // 시험 벡터가 쓴다
    pub fn from_value(v: &Value) -> R<Self> {
        if !is_perms(v) {
            return fail("bad_perms");
        }
        Ok(Self {
            view: v["view"].as_bool().unwrap_or(false),
            request: v["request"].as_bool().unwrap_or(false),
            money: v["money"].as_str().unwrap_or("desktop").into(),
            daily_limit_rvn: safe_int(&v["daily_limit_rvn"]).unwrap_or(0) as u64,
        })
    }
    pub fn to_value(&self) -> Value {
        json!({ "view": self.view, "request": self.request, "money": self.money, "daily_limit_rvn": self.daily_limit_rvn })
    }
}

pub const BOTH_WAYS: [&str; 3] = ["ping", "pong", "unpair"];
pub const PHONE_TO_DESK: [&str; 6] = ["view.wallet", "view.certs", "view.sales", "req.cert", "req.guestqr", "req.send"];
pub const DESK_TO_PHONE: [&str; 6] = ["view.wallet.r", "view.certs.r", "view.sales.r", "req.status", "denied", "relays"];
const ANSWERS: [&str; 5] = ["view.wallet.r", "view.certs.r", "view.sales.r", "req.status", "denied"];
const WANTS: [&str; 3] = ["view", "request", "money"];

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Direction {
    ToDesktop,
    ToPhone,
    Any,
}

#[derive(Clone, Debug)]
#[allow(dead_code)] // ts·build_hello 는 폰 쪽 모양 — 시험(폰 흉내)이 쓴다
pub struct Hello {
    pub phone_sign: String,
    pub phone_dh: String,
    pub name: String,
    pub want: Vec<String>,
    pub ts: i64,
}
#[allow(dead_code)]
pub fn build_hello(h: &Hello) -> R<Value> {
    let v = json!({ "v": 1, "t": "hello", "phone_sign": h.phone_sign, "phone_dh": h.phone_dh, "name": h.name, "want": h.want, "ts": h.ts });
    parse_hello(&v)?;
    Ok(v)
}
pub fn parse_hello(v: &Value) -> R<Hello> {
    let Some(o) = v.as_object() else { return fail("bad_hello") };
    let want_ok = o.get("want").and_then(Value::as_array).map(|w| {
        let names: Vec<&str> = w.iter().filter_map(Value::as_str).collect();
        let set: std::collections::HashSet<&&str> = names.iter().collect();
        w.len() <= 3 && names.len() == w.len() && names.iter().all(|n| WANTS.contains(n)) && set.len() == names.len()
    });
    let ok = exact_keys(o, &["v", "t", "phone_sign", "phone_dh", "name", "want", "ts"], &[])
        && is_one(&o["v"])
        && o["t"] == "hello"
        && is_hex_value(&o["phone_sign"], 32)
        && is_hex_value(&o["phone_dh"], 32)
        && o["name"].as_str().map(is_valid_name).unwrap_or(false)
        && safe_int(&o["ts"]).map(|t| t >= 0).unwrap_or(false)
        && want_ok == Some(true);
    if !ok {
        return fail("bad_hello");
    }
    Ok(Hello {
        phone_sign: o["phone_sign"].as_str().unwrap_or("").into(),
        phone_dh: o["phone_dh"].as_str().unwrap_or("").into(),
        name: o["name"].as_str().unwrap_or("").into(),
        want: o["want"].as_array().map(|w| w.iter().filter_map(|x| x.as_str().map(String::from)).collect()).unwrap_or_default(),
        ts: safe_int(&o["ts"]).unwrap_or(0),
    })
}
pub fn build_accept(perms: &Perms, desk_name: &str, lan: Option<&str>, relays: &[String], ts: i64, seq: i64) -> R<Value> {
    let v = json!({
        "v": 1, "t": "accept", "perms": perms.to_value(), "desk_name": desk_name,
        "lan": lan, "relays": relays, "ts": ts, "seq": seq,
    });
    let o = v.as_object().expect("object");
    let ok = is_perms(&o["perms"]) && is_valid_name(desk_name) && valid_lan_value(&o["lan"]) && valid_relay_value(&o["relays"]) && ts >= 0 && seq >= 1;
    if !ok {
        return fail("bad_accept");
    }
    Ok(v)
}
/// reason: "denied" | "code_used" | "expired"
pub fn build_reject(re: Option<&str>, reason: Option<&str>) -> R<Value> {
    if re.map(|r| !is_hex(r, 32)).unwrap_or(false) || reason.map(|r| !matches!(r, "denied" | "code_used" | "expired")).unwrap_or(false) {
        return fail("bad_reject");
    }
    Ok(json!({ "v": 1, "t": "reject", "re": re, "reason": reason }))
}

fn valid_body(t: &str, b: &Map<String, Value>) -> bool {
    if ANSWERS.contains(&t) && !b.get("re").map(|r| is_hex_value(r, 16)).unwrap_or(false) {
        return false;
    }
    if t == "relays" {
        return exact_keys(b, &["lan", "relays"], &[]) && valid_lan_value(&b["lan"]) && valid_relay_value(&b["relays"]);
    }
    if t == "req.send" {
        let to_ok = b.get("to").and_then(Value::as_str).map(|s| {
            (25..=64).contains(&s.len()) && s.bytes().all(|c| c.is_ascii_alphanumeric() && !b"0OIl".contains(&c))
        });
        let amt_ok = b.get("amount_rvn").and_then(Value::as_f64).map(|a| a.is_finite() && a > 0.0);
        let asset_ok = match b.get("asset") {
            None => true,
            Some(Value::String(s)) => (1..=64).contains(&s.len()) && s.bytes().all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || b"._#/$~-".contains(&c)),
            _ => false,
        };
        let appr_ok = b.get("approved_on_phone").map(Value::is_boolean).unwrap_or(true);
        return to_ok == Some(true) && amt_ok == Some(true) && asset_ok && appr_ok;
    }
    true
}

/// 엄격한 §5 봉투 읽기. 실패 코드: bad_message · bad_version · unknown_type.
pub fn parse_channel_message(v: &Value, dir: Direction) -> R<Value> {
    let Some(o) = v.as_object() else { return fail("bad_message") };
    if !o.get("v").map(is_one).unwrap_or(false) {
        return fail("bad_version");
    }
    let t = o.get("t").and_then(Value::as_str).unwrap_or("\u{0}");
    let allowed = BOTH_WAYS.contains(&t)
        || (dir != Direction::ToPhone && PHONE_TO_DESK.contains(&t))
        || (dir != Direction::ToDesktop && DESK_TO_PHONE.contains(&t));
    if !allowed {
        return fail("unknown_type");
    }
    let ok = exact_keys(o, &["v", "t", "id", "seq", "ts", "body"], &[])
        && is_hex_value(&o["id"], 16)
        && safe_int(&o["seq"]).map(|s| s >= 1).unwrap_or(false)
        && safe_int(&o["ts"]).map(|s| s >= 0).unwrap_or(false)
        && o["body"].as_object().map(|b| valid_body(t, b)).unwrap_or(false);
    if !ok {
        return fail("bad_message");
    }
    Ok(v.clone())
}
pub fn build_channel_message(t: &str, id: &str, seq: i64, ts: i64, body: Value) -> R<Value> {
    let v = json!({ "v": 1, "t": t, "id": id, "seq": seq, "ts": ts, "body": body });
    parse_channel_message(&v, Direction::Any)
}
pub fn new_request_id() -> String {
    use rand::RngCore;
    let mut b = [0u8; 16];
    rand::rngs::OsRng.fill_bytes(&mut b);
    hex::encode(b)
}

// ── §6 권한 판정 (데스크톱이 한다) ──────────────────────────────────────────

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Decision {
    /// "process" | "desktop_confirm" | "auto"
    Allow(&'static str),
    /// "not_permitted" | "over_limit" | "bad_request" | "unknown_type"
    Deny(&'static str),
}
impl Decision {
    #[allow(dead_code)] // 시험 벡터 비교용
    pub fn to_value(&self) -> Value {
        match self {
            Decision::Allow(m) => json!({ "allow": true, "mode": m }),
            Decision::Deny(r) => json!({ "allow": false, "reason": r }),
        }
    }
}

/// RVN(소수 8자리까지, 0…21e9) → 사토시. 정확히 나타낼 수 없으면 None. 폰 `rvnToSats`.
pub fn rvn_to_sats(x: f64) -> Option<u64> {
    if !x.is_finite() || !(0.0..=21e9).contains(&x) {
        return None;
    }
    let s = format!("{x:.8}");
    if s.parse::<f64>().ok()? != x {
        return None;
    }
    let (i, f) = s.split_once('.')?;
    Some(i.parse::<u64>().ok()? * 100_000_000 + f.parse::<u64>().ok()?)
}

/// 폰 `authorize` 와 한 줄씩 같다. `spent_today_rvn` 은 이 폰이 「폰 승인」으로 이미 쓴 RVN.
pub fn authorize(p: &Value, t: &str, body: &Value, spent_today_rvn: f64) -> Decision {
    if !is_perms(p) {
        return Decision::Deny("not_permitted");
    }
    let empty = Map::new();
    let b = body.as_object().unwrap_or(&empty);
    let view = p["view"].as_bool() == Some(true);
    let request = p["request"].as_bool() == Some(true);
    if BOTH_WAYS.contains(&t) {
        return Decision::Allow("process");
    }
    if matches!(t, "view.wallet" | "view.certs" | "view.sales") {
        return if view { Decision::Allow("process") } else { Decision::Deny("not_permitted") };
    }
    if t == "req.cert" {
        return if request { Decision::Allow("desktop_confirm") } else { Decision::Deny("not_permitted") };
    }
    if t == "req.guestqr" {
        return if request { Decision::Allow("process") } else { Decision::Deny("not_permitted") };
    }
    if t == "req.send" {
        if !request {
            return Decision::Deny("not_permitted");
        }
        let amount = b.get("amount_rvn").and_then(|a| if a.is_number() { a.as_f64() } else { None }).and_then(rvn_to_sats);
        let Some(amount) = amount.filter(|a| *a > 0) else { return Decision::Deny("bad_request") };
        if !b.get("to").map(Value::is_string).unwrap_or(false) {
            return Decision::Deny("bad_request");
        }
        if p["money"] == "desktop" || b.get("approved_on_phone") != Some(&Value::Bool(true)) || b.contains_key("asset") {
            return Decision::Allow("desktop_confirm");
        }
        let Some(spent) = rvn_to_sats(spent_today_rvn) else { return Decision::Deny("not_permitted") };
        let limit = (safe_int(&p["daily_limit_rvn"]).unwrap_or(0) as u128) * 100_000_000;
        return if (spent as u128) + (amount as u128) <= limit { Decision::Allow("auto") } else { Decision::Deny("over_limit") };
    }
    Decision::Deny("unknown_type")
}
