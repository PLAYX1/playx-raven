//! 직원·검표 폰 ↔ 이 컴퓨터 사이의 **봉함** (RV shop LAN seal v1).
//!
//! 규격: RavenVault `docs/RV-shop-lan-seal-v1.md`. 바이트 규칙의 기준은 폰
//! `core/shop-remote/seal.ts` 이고, 폰이 만든 시험 벡터(`testdata/rv-shop-seal-vectors.json`)를
//! 이 파일의 시험이 **바이트까지** 다시 만든다.
//!
//! ## 왜
//!
//! 폰은 가게 와이파이에서 `http://192.168.x.x:8790` 으로 붙는다. 여태 회원 등록(이름·전화·
//! 메모)·회원 보기·표 확인이 평문으로 오갔고, 역할 토큰이 **요청마다** `x-playx-token` 에 실렸다.
//! 같은 와이파이의 누구든 한 번 엿들으면 손님 정보를 읽고, 그 토큰으로 계속 들어올 수 있었다.
//!
//! ## 어떻게
//!
//! ```text
//! shared  = X25519(eph_sk, K)                     (전부 0 이면 거부)
//! key     = HKDF-SHA256(ikm=shared, salt=SHA256(utf8(token)), info="rv-shop-seal-v1", L=32)
//! aad_req = "rv-shop-seal-v1/req" ‖ eph_pub ‖ K
//! aad_res = "rv-shop-seal-v1/res" ‖ eph_pub ‖ n_req
//! ```
//!
//! - K 는 이 컴퓨터의 **가게 봉함 키**(`shop-seal-key.json`, 0600). QR 의 `k` 로만 폰에 간다.
//!   RV6 기기 키를 다시 쓰지 않는다 — 다른 규약의 키를 섞으면 두 규약의 안전이 엮인다.
//! - 토큰은 선에 실리지 않는다. 열쇠의 salt 로만 쓰인다. 그래서 이 컴퓨터는 역할 토큰 셋을
//!   **모두** 시도해 보고(시간으로 어느 역할인지 새지 않게 항상 셋 다) 열리는 것을 고른다.
//! - 열린 요청은 기존 처리기로 그대로 들어간다(`server::api_scan_sealed`). 역할·동의·정책 검사는
//!   원래 자리에서 돈다 — 여기서 새로 만들지 않는다.
//!
//! 🔴 직접 만든 암호는 없다. x25519-dalek · chacha20poly1305(XChaCha) · hkdf+sha2 만 부른다
//!    (RV6 연결과 같은 것들).

use crate::pairing::proto::{derive_shared, is_hex, safe_int, sha256, unhex, wipe};
use chacha20poly1305::aead::{Aead, KeyInit, Payload};
use chacha20poly1305::{XChaCha20Poly1305, XNonce};
use hkdf::Hkdf;
use serde_json::{json, Map, Value};
use sha2::Sha256;
use std::collections::HashMap;

pub const SEAL_PATH: &str = "/api/scan/sealed";
pub const INFO: &str = "rv-shop-seal-v1";
/// 봉함 평문의 최대 크기. 회원 등록 한 건은 1 KB 도 안 된다.
pub const MAX_PLAIN: usize = 64 * 1024;
/// 봉투(JSON) 전체의 최대 크기 — hex 로 두 배가 되고 머리 몇 글자가 붙는다.
pub const MAX_ENVELOPE: usize = 200_000;
/// 폰과 이 컴퓨터의 시계 차이를 얼마까지 봐 주나(초).
pub const TS_WINDOW: i64 = 300;
/// 본 nonce 를 얼마 동안 기억하나(초). 창(±5분)보다 길어야 창 안의 재전송이 반드시 걸린다.
pub const REPLAY_TTL: i64 = 600;

/// 봉함으로 부를 수 있는 길 — **폰이 부르는 길만**. 물음표 앞 부분으로 비교한다.
/// `/api/scan/sealed` 자신은 없다(재귀 금지). 입장 처리(`/api/scan/in`)는 폰이 안 부른다.
pub const SEALED_PATHS: &[&str] = &[
    "/api/admin/ai",
    "/api/admin/assets",
    "/api/admin/backup",
    "/api/admin/issue",
    "/api/admin/machine",
    "/api/admin/machine/start",
    "/api/admin/orders",
    "/api/admin/publish",
    "/api/admin/shop",
    "/api/admin/state",
    "/api/admin/states",
    "/api/admin/status",
    "/api/ai-status",
    "/api/keepphoto",
    "/api/nostr/publish",
    "/api/owner-ask",
    "/api/scan/check",
    "/api/scan/in",
    "/api/scan/member",
    "/api/scan/member-groups",
    "/api/scan/member-info",
    "/api/scan/member-memo",
    "/api/scan/member-policy",
    "/api/scan/member-search",
    "/api/staff/refund",
    "/api/staff/refund/limits",
];

/// 평문으로 오면 **손님 정보가 선에 실리는** 길. 옛 폰(vc4)·브라우저 화면이 여기로 평문을
/// 보내면 세고, 사장이 「옛 폰의 암호 없는 연결 막기」를 켜면 막는다.
/// 표 확인·입장은 답에 회원 이름이 섞이고, 이름·전화 뒷자리로도 찾으므로 여기 든다.
/// 주문(`/api/admin/states`·`state`)은 손님 신원이 없어 넣지 않는다.
pub const PERSONAL_PLAIN_PATHS: [&str; 7] = [
    "/api/scan/check",
    "/api/scan/in",
    "/api/scan/member",
    "/api/scan/member-info",
    "/api/scan/member-memo",
    "/api/scan/member-groups",
    "/api/scan/member-search",
];

/// 봉함을 연 뒤 안쪽으로 다시 넣는 요청에 붙는 표시. 요청 **확장값**이라 네트워크에서는
/// 절대 만들 수 없다(머리글이었다면 옛 폰이 흉내 내 「막기」를 피해 갔을 것이다).
#[derive(Clone, Copy, Debug)]
pub struct SealedInner;

pub fn path_allowed(path: &str) -> bool {
    if !path.starts_with('/') || path.len() > 512 || path.bytes().any(|b| !(0x21..=0x7e).contains(&b) || b == b'#') {
        return false;
    }
    let base = path.split('?').next().unwrap_or("");
    SEALED_PATHS.contains(&base)
}

pub fn derive_key(shared: &[u8; 32], token: &str) -> [u8; 32] {
    let salt = sha256(&[token.as_bytes()]);
    let hk = Hkdf::<Sha256>::new(Some(&salt), shared);
    let mut out = [0u8; 32];
    hk.expand(INFO.as_bytes(), &mut out).expect("hkdf 32 bytes");
    out
}
fn aad_req(eph: &[u8; 32], desk: &[u8; 32]) -> Vec<u8> {
    [b"rv-shop-seal-v1/req".as_slice(), eph, desk].concat()
}
fn aad_res(eph: &[u8; 32], n_req: &[u8; 24]) -> Vec<u8> {
    [b"rv-shop-seal-v1/res".as_slice(), eph, n_req].concat()
}
fn is_lower_hex(s: &str) -> bool {
    s.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}
fn exact_keys(o: &Map<String, Value>, keys: &[&str]) -> bool {
    o.len() == keys.len() && keys.iter().all(|k| o.contains_key(*k))
}

/// 한 요청을 열고 답을 봉할 때까지 들고 있는 것. `key` 는 선에 절대 안 나간다.
pub struct Ctx {
    key: [u8; 32],
    pub eph: [u8; 32],
    pub n: [u8; 24],
}
impl Drop for Ctx {
    fn drop(&mut self) {
        wipe(&mut self.key);
    }
}
impl Ctx {
    #[cfg(test)]
    pub fn from_parts(key: [u8; 32], eph: [u8; 32], n: [u8; 24]) -> Self {
        Self { key, eph, n }
    }
    #[cfg(test)]
    pub fn key(&self) -> &[u8; 32] {
        &self.key
    }
}

pub struct Opened {
    /// 어느 역할의 토큰으로 열렸나. 권한은 안쪽 처리기가 토큰으로 다시 판단한다(여기는 기록·시험용).
    #[cfg_attr(not(test), allow(dead_code))]
    pub role: String,
    pub token: String,
    pub method: String,
    pub path: String,
    pub ts: i64,
    pub nonce: String,
    pub body: Value,
    pub ctx: Ctx,
}

pub enum OpenFail {
    /// 봉투 모양이 틀렸다. 평문 400.
    Malformed,
    /// 어느 토큰으로도 안 열린다(틀린 토큰·바꾼 토큰·변조·다른 컴퓨터의 키). 평문 401 BAD_TOKEN.
    NoToken,
    /// 열리긴 했는데 안의 모양이 틀렸다. 이유는 **봉해서** 답한다.
    BadPlain(Ctx),
}

/// `tokens` = (역할, 토큰). 빈 토큰은 건너뛴다 — 빈 글자를 salt 로 쓰지 않는다.
pub fn open_request(desk_sk: &[u8; 32], tokens: &[(String, String)], env: &Value) -> Result<Opened, OpenFail> {
    let Some(o) = env.as_object() else { return Err(OpenFail::Malformed) };
    if !exact_keys(o, &["v", "eph", "n", "ct"]) || o["v"].as_i64() != Some(1) || !o["v"].is_i64() {
        return Err(OpenFail::Malformed);
    }
    let (Some(eph_hex), Some(n_hex), Some(ct_hex)) = (o["eph"].as_str(), o["n"].as_str(), o["ct"].as_str()) else {
        return Err(OpenFail::Malformed);
    };
    if !is_hex(eph_hex, 32) || !is_hex(n_hex, 24) || ct_hex.len() < 32 || ct_hex.len() > (MAX_PLAIN + 16) * 2 || ct_hex.len() % 2 != 0 || !is_lower_hex(ct_hex) {
        return Err(OpenFail::Malformed);
    }
    let eph: [u8; 32] = unhex(eph_hex, "bad").map_err(|_| OpenFail::Malformed)?;
    let n: [u8; 24] = unhex(n_hex, "bad").map_err(|_| OpenFail::Malformed)?;
    let ct = hex::decode(ct_hex).map_err(|_| OpenFail::Malformed)?;
    let mut shared = derive_shared(desk_sk, eph_hex).map_err(|_| OpenFail::Malformed)?;
    let desk_pub = x25519_dalek::PublicKey::from(&x25519_dalek::StaticSecret::from(*desk_sk)).to_bytes();
    let aad = aad_req(&eph, &desk_pub);
    let mut found: Option<(String, String, [u8; 32], Vec<u8>)> = None;
    // 🔴 항상 전부 시도한다. 맞는 것을 찾자마자 멈추면 걸린 시간으로 역할이 샌다.
    for (role, token) in tokens {
        if token.is_empty() {
            continue;
        }
        let mut key = derive_key(&shared, token);
        let got = XChaCha20Poly1305::new((&key).into()).decrypt(XNonce::from_slice(&n), Payload { msg: &ct, aad: &aad });
        if let (Ok(plain), true) = (got, found.is_none()) {
            found = Some((role.clone(), token.clone(), key, plain));
        }
        wipe(&mut key);
    }
    wipe(&mut shared);
    let Some((role, token, mut key, mut plain)) = found else { return Err(OpenFail::NoToken) };
    let ctx = Ctx { key, eph, n };
    wipe(&mut key);
    let parsed: Option<Value> = std::str::from_utf8(&plain).ok().and_then(|t| serde_json::from_str(t).ok());
    wipe(&mut plain);
    let Some(p) = parsed.as_ref().and_then(Value::as_object) else { return Err(OpenFail::BadPlain(ctx)) };
    let ok_shape = exact_keys(p, &["v", "m", "path", "ts", "nonce", "body"])
        && p["v"].is_i64()
        && p["v"].as_i64() == Some(1)
        && matches!(p["m"].as_str(), Some("GET") | Some("POST"))
        && p["path"].is_string()
        && safe_int(&p["ts"]).is_some()
        && p["nonce"].as_str().map(|s| is_hex(s, 16)).unwrap_or(false)
        && if p["m"] == "GET" { p["body"].is_null() } else { p["body"].is_object() };
    if !ok_shape {
        return Err(OpenFail::BadPlain(ctx));
    }
    Ok(Opened {
        role,
        token,
        method: p["m"].as_str().unwrap_or_default().to_string(),
        path: p["path"].as_str().unwrap_or_default().to_string(),
        ts: safe_int(&p["ts"]).unwrap_or_default(),
        nonce: p["nonce"].as_str().unwrap_or_default().to_string(),
        body: p["body"].clone(),
        ctx,
    })
}

/// 길·시계·재전송 검사. 거절이면 봉해서 돌려줄 (상태, 코드).
///
/// `seen` 에는 복호화에 성공한 요청만 들어간다 — 토큰 없는 사람은 이 표를 채울 수 없다.
pub fn admit(opened: &Opened, now: i64, seen: &mut HashMap<String, i64>) -> Result<(), (u16, &'static str)> {
    if !path_allowed(&opened.path) {
        return Err((404, "SEAL_PATH"));
    }
    if now.abs_diff(opened.ts) > TS_WINDOW as u64 {
        return Err((401, "SEAL_CLOCK"));
    }
    seen.retain(|_, at| now.saturating_sub(*at) <= REPLAY_TTL);
    if seen.contains_key(&opened.nonce) {
        return Err((409, "SEAL_REPLAY"));
    }
    if seen.len() >= 4096 { return Err((429, "SEAL_BUSY")); }
    seen.insert(opened.nonce.clone(), now);
    Ok(())
}

/// 답을 봉한다. `body` 가 None 이면(안쪽 답이 JSON 이 아니면) `body` 칸을 뺀다.
/// `n` 은 시험 벡터 전용 — 실제로는 None(무작위).
pub fn seal_response(ctx: &Ctx, status: u16, body: Option<&Value>, n: Option<[u8; 24]>) -> Value {
    let n = n.unwrap_or_else(|| {
        use rand::RngCore;
        let mut b = [0u8; 24];
        loop {
            rand::rngs::OsRng.fill_bytes(&mut b);
            if b != ctx.n {
                break b;
            }
        }
    });
    let plain = match body {
        Some(b) => json!({ "v": 1, "status": status, "body": b }),
        None => json!({ "v": 1, "status": status }),
    };
    let mut text = serde_json::to_vec(&plain).unwrap_or_default();
    let ct = XChaCha20Poly1305::new((&ctx.key).into())
        .encrypt(XNonce::from_slice(&n), Payload { msg: &text, aad: &aad_res(&ctx.eph, &ctx.n) })
        .unwrap_or_default();
    wipe(&mut text);
    json!({ "v": 1, "n": hex::encode(n), "ct": hex::encode(ct) })
}

/// 폰 쪽 `openShopResponse` 의 거울 — 시험에서 답을 열어 보는 데만 쓴다.
#[cfg(test)]
pub fn open_response(ctx: &Ctx, v: &Value) -> Option<Value> {
    let o = v.as_object()?;
    if !exact_keys(o, &["v", "n", "ct"]) || o["v"].as_i64() != Some(1) {
        return None;
    }
    let n: [u8; 24] = unhex(o["n"].as_str()?, "bad").ok()?;
    let ct = hex::decode(o["ct"].as_str()?).ok()?;
    let plain = XChaCha20Poly1305::new((&ctx.key).into())
        .decrypt(XNonce::from_slice(&n), Payload { msg: &ct, aad: &aad_res(&ctx.eph, &ctx.n) })
        .ok()?;
    serde_json::from_slice(&plain).ok()
}

// ── 이 컴퓨터의 봉함 키 ─────────────────────────────────────────────────────

fn key_path() -> std::path::PathBuf {
    crate::paths::app_file("shop-seal-key.json")
}

pub struct DeskKey {
    sk: [u8; 32],
    pub public: [u8; 32],
}
impl Drop for DeskKey {
    fn drop(&mut self) {
        wipe(&mut self.sk);
    }
}
impl DeskKey {
    pub fn secret(&self) -> &[u8; 32] {
        &self.sk
    }
    pub fn public_hex(&self) -> String {
        hex::encode(self.public)
    }
    fn from_secret(sk: [u8; 32]) -> Self {
        let public = x25519_dalek::PublicKey::from(&x25519_dalek::StaticSecret::from(sk)).to_bytes();
        Self { sk, public }
    }
}

/// 키를 읽는다. **파일이 없을 때만** 새로 만든다. 읽다가 깨진 것을 발견하면 덮어쓰지 않고
/// 거절한다 — 조용히 바꾸면 모든 직원 폰이 이유도 모르고 끊긴다.
pub fn desk_key() -> Result<DeskKey, String> {
    let path = key_path();
    match std::fs::read_to_string(&path) {
        Ok(text) => {
            let v: Value = serde_json::from_str(&text).map_err(|_| "가게 봉함 키 파일이 손상됐습니다.".to_string())?;
            let sk: [u8; 32] = v
                .get("sk")
                .and_then(Value::as_str)
                .and_then(|s| unhex(s, "bad").ok())
                .ok_or_else(|| "가게 봉함 키 파일이 손상됐습니다.".to_string())?;
            Ok(DeskKey::from_secret(sk))
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            use rand::RngCore;
            let mut sk = [0u8; 32];
            rand::rngs::OsRng.fill_bytes(&mut sk);
            let key = DeskKey::from_secret(sk);
            wipe(&mut sk);
            let mut doc = serde_json::to_vec(&json!({ "v": 1, "sk": hex::encode(key.sk) })).unwrap_or_default();
            let wrote = crate::server::atomic_write_0600(&path, &doc);
            wipe(&mut doc);
            wrote.map_err(|e| format!("가게 봉함 키를 저장하지 못했습니다: {e}"))?;
            Ok(key)
        }
        Err(e) => Err(format!("가게 봉함 키를 읽지 못했습니다: {e}")),
    }
}

#[cfg(test)]
pub fn install_key_for_test(sk: [u8; 32]) {
    let doc = serde_json::to_vec(&json!({ "v": 1, "sk": hex::encode(sk) })).unwrap();
    crate::server::atomic_write_0600(&key_path(), &doc).unwrap();
}

// ── 옛 폰의 평문: 세기와 막기 ─────────────────────────────────────────────

fn settings_path() -> std::path::PathBuf {
    crate::paths::app_file("shop-seal-settings.json")
}

/// 「옛 폰의 암호 없는 연결 막기」. 기본 꺼짐 — 켜면 옛 폰과 브라우저 직원·검표 화면의
/// 표 확인·회원 기능이 멈추므로 사장이 고른다.
pub fn block_plain() -> bool {
    std::fs::read_to_string(settings_path())
        .ok()
        .and_then(|t| serde_json::from_str::<Value>(&t).ok())
        .and_then(|v| v.get("block_plain").and_then(Value::as_bool))
        .unwrap_or(false)
}

pub fn set_block_plain(on: bool) -> Result<(), String> {
    let doc = serde_json::to_vec_pretty(&json!({ "block_plain": on })).unwrap_or_default();
    crate::server::atomic_write_0600(&settings_path(), &doc).map_err(|e| format!("설정을 저장하지 못했습니다: {e}"))
}

// 시험에서만 시계를 멈춘다. 실타래마다 따로라 병렬 시험끼리 섞이지 않는다.
#[cfg(test)]
thread_local! {
    static TEST_NOW: std::cell::Cell<Option<i64>> = const { std::cell::Cell::new(None) };
}
#[cfg(test)]
pub fn set_test_now(t: Option<i64>) {
    TEST_NOW.with(|c| c.set(t));
}
pub fn now() -> i64 {
    #[cfg(test)]
    if let Some(t) = TEST_NOW.with(|c| c.get()) {
        return t;
    }
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn vectors() -> Value {
        serde_json::from_str(include_str!("../testdata/rv-shop-seal-vectors.json")).unwrap()
    }
    fn h32(v: &Value) -> [u8; 32] {
        unhex(v.as_str().unwrap(), "t").unwrap()
    }
    fn h24(v: &Value) -> [u8; 24] {
        unhex(v.as_str().unwrap(), "t").unwrap()
    }
    fn tokens(v: &Value) -> Vec<(String, String)> {
        ["owner", "staff", "scanner"].iter().map(|r| (r.to_string(), v["tokens"][r].as_str().unwrap().to_string())).collect()
    }
    fn flip(s: &str, at: usize) -> String {
        let mut b = s.as_bytes().to_vec();
        b[at] = if b[at] == b'0' { b'1' } else { b'0' };
        String::from_utf8(b).unwrap()
    }
    fn opened(r: Result<Opened, OpenFail>) -> Opened {
        match r {
            Ok(o) => o,
            Err(OpenFail::Malformed) => panic!("malformed"),
            Err(OpenFail::NoToken) => panic!("no token"),
            Err(OpenFail::BadPlain(_)) => panic!("bad plain"),
        }
    }
    fn fail_kind(r: Result<Opened, OpenFail>) -> &'static str {
        match r {
            Ok(_) => "ok",
            Err(OpenFail::Malformed) => "malformed",
            Err(OpenFail::NoToken) => "no_token",
            Err(OpenFail::BadPlain(_)) => "bad_plain",
        }
    }

    #[test]
    fn path_lists_match_the_phone() {
        let v = vectors();
        let phone: Vec<String> = serde_json::from_value(v["sealed_paths"].clone()).unwrap();
        assert!(phone.iter().all(|path| SEALED_PATHS.contains(&path.as_str())));
        assert!(SEALED_PATHS.contains(&"/api/staff/refund"));
        assert!(SEALED_PATHS.contains(&"/api/keepphoto"));
        assert_eq!(v["ts_window_s"], TS_WINDOW);
        assert_eq!(v["replay_ttl_s"], REPLAY_TTL);
        // 폰이 옛 컴퓨터에 평문으로 보내도 되는 길은 손님 정보 목록과 겹치면 안 된다.
        for p in v["legacy_plain_paths"].as_array().unwrap() {
            assert!(!PERSONAL_PLAIN_PATHS.contains(&p.as_str().unwrap()), "{p}");
        }
        assert!(!path_allowed(SEAL_PATH));
        for bad in ["/api/admin/publish-extra", "/api/scan/in-extra", "api/scan/member", "/api/scan/member#x", "/api/scan/member x", "/api/scan/memberx", "/api/scan/member-info?code=한"] {
            assert!(!path_allowed(bad), "{bad}");
        }
        assert!(path_allowed("/api/scan/member-info?code=ROOT%2FM%23ABCD"));
    }

    #[test]
    fn every_vector_matches_the_phone_byte_for_byte() {
        let v = vectors();
        let desk_sk = h32(&v["desk_sk"]);
        assert_eq!(DeskKey::from_secret(desk_sk).public_hex(), v["desk_pub"]);
        let toks = tokens(&v);
        let mut checked = 0;
        for c in v["cases"].as_array().unwrap().iter().chain(v["interop"].as_array().unwrap()) {
            let label = c["label"].as_str().unwrap();
            let shared = derive_shared(&desk_sk, c["eph_pub"].as_str().unwrap()).unwrap();
            assert_eq!(hex::encode(shared), c["shared"], "{label} shared");
            let token = v["tokens"][c["role"].as_str().unwrap()].as_str().unwrap();
            assert_eq!(hex::encode(sha256(&[token.as_bytes()])), c["token_salt"], "{label} salt");
            assert_eq!(hex::encode(derive_key(&shared, token)), c["key"], "{label} key");
            let o = opened(open_request(&desk_sk, &toks, &c["envelope"]));
            assert_eq!(o.role, c["role"], "{label} role");
            assert_eq!(hex::encode(o.ctx.key()), c["key"], "{label} ctx key");
            let p: Value = serde_json::from_str(c["plaintext"].as_str().unwrap()).unwrap();
            assert_eq!(json!({"v":1,"m":o.method,"path":o.path,"ts":o.ts,"nonce":o.nonce,"body":o.body}), p, "{label} plaintext");
            assert_eq!(o.ts, c["now_ms"].as_i64().unwrap() / 1000);
            checked += 1;
        }
        for c in v["cases"].as_array().unwrap() {
            let label = c["label"].as_str().unwrap();
            let o = opened(open_request(&desk_sk, &toks, &c["envelope"]));
            let status = c["answer"]["status"].as_u64().unwrap() as u16;
            let body = c["answer"].get("body");
            let sealed = seal_response(&o.ctx, status, body, Some(h24(&c["res_n"])));
            assert_eq!(sealed, c["response"], "{label} response envelope");
            let plain = open_response(&o.ctx, &sealed).unwrap();
            assert_eq!(plain, serde_json::from_str::<Value>(c["answer_plaintext"].as_str().unwrap()).unwrap());
            checked += 1;
        }
        assert_eq!(checked, 14);
    }

    #[test]
    fn attacker_tamper_wrong_token_other_key_malformed() {
        let v = vectors();
        let desk_sk = h32(&v["desk_sk"]);
        let toks = tokens(&v);
        let e = &v["cases"][1]["envelope"];
        let ct = e["ct"].as_str().unwrap();
        for i in (0..ct.len()).step_by(11) {
            let mut t = e.clone();
            t["ct"] = json!(flip(ct, i));
            assert_eq!(fail_kind(open_request(&desk_sk, &toks, &t)), "no_token", "ct {i}");
        }
        for i in (0..48).step_by(5) {
            let mut t = e.clone();
            t["n"] = json!(flip(e["n"].as_str().unwrap(), i));
            assert_eq!(fail_kind(open_request(&desk_sk, &toks, &t)), "no_token", "n {i}");
        }
        for i in (0..64).step_by(5) {
            let mut t = e.clone();
            t["eph"] = json!(flip(e["eph"].as_str().unwrap(), i));
            assert!(matches!(fail_kind(open_request(&desk_sk, &toks, &t)), "no_token" | "malformed"), "eph {i}");
        }
        // 토큰을 바꾸면(「모든 폰 로그아웃」) 옛 봉투는 안 열린다.
        let rotated: Vec<(String, String)> = toks.iter().map(|(r, _)| (r.clone(), format!("rotated-{r}"))).collect();
        assert_eq!(fail_kind(open_request(&desk_sk, &rotated, e)), "no_token");
        assert_eq!(fail_kind(open_request(&desk_sk, &[("staff".into(), String::new())], e)), "no_token");
        assert_eq!(fail_kind(open_request(&[7u8; 32], &toks, e)), "no_token");
        let mut bads = vec![json!(null), json!([]), json!("x"), json!({"v":1,"eph":e["eph"],"n":e["n"]})];
        for (k, val) in [("v", json!(2)), ("v", json!(1.0)), ("extra", json!(1)), ("ct", json!(ct.to_uppercase())), ("ct", json!(&ct[..20])),
            ("ct", json!(format!("{ct}a"))), ("n", json!(&e["n"].as_str().unwrap()[2..])), ("eph", json!("00".repeat(32)))] {
            let mut t = e.clone();
            t[k] = val;
            bads.push(t);
        }
        for b in &bads {
            assert_eq!(fail_kind(open_request(&desk_sk, &toks, b)), "malformed", "{b}");
        }
    }

    #[test]
    fn replay_clock_and_path_gate() {
        let v = vectors();
        let desk_sk = h32(&v["desk_sk"]);
        let toks = tokens(&v);
        let c = &v["cases"][0];
        let ts = c["now_ms"].as_i64().unwrap() / 1000;
        let mut seen = HashMap::new();
        let o = || opened(open_request(&desk_sk, &toks, &c["envelope"]));
        assert_eq!(admit(&o(), ts, &mut seen), Ok(()));
        assert_eq!(admit(&o(), ts + 1, &mut seen), Err((409, "SEAL_REPLAY")));
        assert_eq!(admit(&o(), ts + TS_WINDOW, &mut seen), Err((409, "SEAL_REPLAY")));
        assert_eq!(admit(&o(), ts + REPLAY_TTL + 1, &mut seen), Err((401, "SEAL_CLOCK")));
        for (skew, want) in [(300, Ok(())), (-300, Ok(())), (301, Err((401, "SEAL_CLOCK"))), (-301, Err((401, "SEAL_CLOCK")))] {
            assert_eq!(admit(&o(), ts + skew, &mut HashMap::new()), want, "skew {skew}");
        }
        let mut other = o();
        other.path = "/api/admin/publish-extra".into();
        assert_eq!(admit(&other, ts, &mut HashMap::new()), Err((404, "SEAL_PATH")));
        other.path = SEAL_PATH.into();
        assert_eq!(admit(&other, ts, &mut HashMap::new()), Err((404, "SEAL_PATH")));
    }

    #[test]
    fn response_is_bound_to_its_request_and_tamper_evident() {
        let v = vectors();
        let desk_sk = h32(&v["desk_sk"]);
        let toks = tokens(&v);
        let a = opened(open_request(&desk_sk, &toks, &v["cases"][0]["envelope"]));
        let b = opened(open_request(&desk_sk, &toks, &v["cases"][1]["envelope"]));
        let r = seal_response(&a.ctx, 200, Some(&json!({"name":"Synthetic"})), None);
        assert_eq!(open_response(&a.ctx, &r).unwrap()["body"]["name"], "Synthetic");
        assert!(open_response(&b.ctx, &r).is_none(), "another request's answer does not open");
        let ct = r["ct"].as_str().unwrap();
        for i in (0..ct.len()).step_by(9) {
            let mut t = r.clone();
            t["ct"] = json!(flip(ct, i));
            assert!(open_response(&a.ctx, &t).is_none());
        }
        // 무작위 응답 nonce 는 요청 nonce 와 다르다.
        assert_ne!(r["n"].as_str().unwrap(), hex::encode(a.ctx.n));
        // 답이 JSON 이 아니면 body 칸이 없다.
        assert_eq!(open_response(&a.ctx, &seal_response(&a.ctx, 500, None, None)).unwrap(), json!({"v":1,"status":500}));
    }

    #[test]
    fn desk_key_is_created_once_0600_and_never_silently_replaced() {
        let _lock = crate::paths::TEST_ENV.lock().unwrap_or_else(|e| e.into_inner());
        let dir = crate::paths::test_fixture_root().join(format!("rv-shopseal-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::env::set_var("PLAYX_RAVEN_HOME", &dir);
        let a = desk_key().unwrap();
        let b = desk_key().unwrap();
        assert_eq!(a.public, b.public, "same key after restart");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(std::fs::metadata(key_path()).unwrap().permissions().mode() & 0o777, 0o600);
        }
        std::fs::write(key_path(), "{broken").unwrap();
        assert!(desk_key().is_err(), "corrupt key is refused, not replaced");
        assert_eq!(std::fs::read_to_string(key_path()).unwrap(), "{broken");
        assert!(!block_plain(), "default off");
        set_block_plain(true).unwrap();
        assert!(block_plain());
        set_block_plain(false).unwrap();
        assert!(!block_plain());
        std::env::remove_var("PLAYX_RAVEN_HOME");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
