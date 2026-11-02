//! 폰과 지갑 연결 — 데스크탑 쪽.
//!
//! 폰은 이 컴퓨터 주 지갑(계정 0, m/44'/175'/0')의 **받기 전용 번호(xpub)** 만 받는다. 복구 단어·개인키는
//! 이 컴퓨터를 떠나지 않는다. 폰이 「채우기·보내기」를 **요청**하면 여기서 사람이 확인하고 승인해야만 보낸다.
//!
//! 규격은 폰 core 를 바이트 그대로 가져온 `core/wallet-link/link.ts`·`transport.ts`(NIP-17 겉봉)와 같다.
//! `scripts/fixtures/wallet-link-vectors.json`(TS 가 만든 공용 벡터)으로 아래 시험이 같은 답을 확인한다.
//!
//! ## 연결 열쇠는 어디에 사나
//! - 이야기 열쇠(talk.rs)처럼 **러스트 안에서만** 쓴다. 화면(TS)으로 비밀이 건너가지 않는다 —
//!   서명·봉인·개봉은 여기서 하고, 화면은 공개 값(제안·확인 숫자·요청 내용)만 받는다.
//! - 보관은 데스크탑에서 가장 강한 방식(라비 AI 열쇠와 같은 것): 맥 키체인·윈도 자격 증명 관리자,
//!   리눅스는 0600 파일. 지갑 열쇠·기기(판매 리모컨) 열쇠·이야기 열쇠와 **다른 무작위 열쇠**다.
//!
//! ## 두 번 보내지 않는다
//! - 요청이 오면 서명과 상관없이 먼저 요청 id 를 디스크에 적는다(`state.json`의 seen·requests).
//! - 승인 때는 `payout_guard`(보내기와 같은 지급 기록)가 서명 **전에** id 를 적는다. 같은 id 는 같은 txid 만 돌려준다.
//! - 같은 요청이 다시 오면 다시 서명하지 않고, 이미 낸 결과를 그대로 다시 보낸다.
//!
//! 🔴 자동 승인은 없다. 이 파일에서 돈이 나가는 길은 `wallet_link_approve` 하나이고, 그것은 사람이 누른다.
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};

use crate::sales_account::{SalesRpc, Text};

const DOMAIN: &str = "ravenvault-wallet-link-v1";
const CHAIN: &str = "rvn-main";
const PATH0: &str = "m/44'/175'/0'";
const OFFER_TTL_MS: i64 = 60_000;
/// QR 을 찍고 폰에서 확인 숫자를 보고 누르는 데 걸리는 시간.
const ACCEPT_GRACE_MS: i64 = 5 * 60_000;
/// 한 번 인증한 뒤 QR 을 새로 만들 수 있는 시간(그 뒤에는 다시 인증).
const SESSION_MS: i64 = 5 * 60_000;
const REQUEST_TTL_MS: i64 = 10 * 60_000;
const SEEN_RETAIN_MS: i64 = 86_400_000;
const WRAP_RETAIN_MS: i64 = 3 * 86_400_000;
const WRAP_SKEW_SEC: i64 = 2 * 86_400;
const DAY_MS: i64 = 86_400_000;
/// 하루 한도의 최대 = RVN 총발행량(21,000,000,000 RVN). 이 값이면 「한도 없음」(11-03 대표). 폰 core 의 LINK_DAILY_SATS 와 같은 값.
/// 한도가 없어도 돈은 언제나 여기서 사람이 승인해야 나간다(자동 승인 없음).
pub(crate) const DAILY_MAX_SATS: u64 = 21_000_000_000 * 100_000_000;
/// 새 연결의 기본 하루 한도(11-03 대표 결정: 1,000 RVN). 칸을 비워 두면 이 값.
pub(crate) const DAILY_DEFAULT_SATS: u64 = 1_000 * 100_000_000;
const FEE_CAP_SATS: u64 = 100_000_000;
const MAX_PHONE_ADDRESSES: usize = 8;
const LANE: &str = "wallet-link";
const AUTH_ERROR: &str = "지갑을 열지 못했어요. 암호가 설정된 12단어 지갑인지, 노드가 켜져 있는지 확인해 주세요.";
const NOT_MINE: &str = "이 지갑의 받는 주소를 확인하지 못해 연결하지 않았어요. 12단어(BIP44)로 만든 지갑에서만 연결할 수 있어요.";
const PHONE_CANCELLED: &str = "폰에서 연결을 취소했어요. 연결하지 않았어요. 처음부터 다시 해 주세요.";
const APP_LOCKED: &str = "앱이 잠겨 보내지 않았어요. 잠금을 푼 뒤 다시 확인하고 승인해 주세요.";
const OVER_LIMIT: &str = "수수료까지 합치면 오늘 한도를 넘어요.";
const LIMIT_BAD: &str = "하루 한도는 0보다 큰 RVN 수로 적어 주세요. 제한을 두지 않으려면 「한도 없음」을 고르세요.";
const CHANGED: &str = "확인한 거래가 바뀌었어요(동전이 이미 쓰였거나 내용이 달라졌어요). 다시 확인한 뒤 승인해 주세요.";

// ── 작은 검사 ───────────────────────────────────────────────────────
fn hex_n(s: &str, n: usize) -> bool {
    s.len() == n && s.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
fn hex64(s: &str) -> bool { hex_n(s, 64) }
fn address_ok(s: &str) -> bool {
    const A: &[u8] = b"123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
    s.starts_with('R') && (26..=35).contains(&s.len()) && s.bytes().all(|b| A.contains(&b))
}
fn sats_of(s: &str) -> Option<u64> {
    (!s.is_empty() && s.len() <= 18 && !s.starts_with('0') && s.bytes().all(|b| b.is_ascii_digit())).then(|| s.parse().ok()).flatten()
}
fn safe_int(v: &Value, min: i64) -> Option<i64> {
    let n = v.as_i64()?;
    (n >= min && n <= 9_007_199_254_740_991).then_some(n)
}
fn now_ms() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}
fn rvn_text(sats: u64) -> String { format!("{}.{:08}", sats / 100_000_000, sats % 100_000_000) }
fn to_sats(v: f64) -> Option<u64> { (v.is_finite() && v >= 0.0 && v < 21e15).then(|| (v * 1e8).round() as u64) }

// ── 정규 JSON · 서명(link.ts 의 digest/sign/verify 와 같은 바이트) ─────────
pub(crate) fn canonical(v: &Value) -> Option<String> {
    Some(match v {
        Value::Null => "null".into(),
        Value::Bool(b) => b.to_string(),
        Value::Number(n) => {
            let i = n.as_i64().or_else(|| n.as_u64().and_then(|u| i64::try_from(u).ok()))?;
            if i.unsigned_abs() > 9_007_199_254_740_991 { return None; }
            i.to_string()
        }
        Value::String(s) => serde_json::to_string(s).ok()?,
        Value::Array(a) => format!("[{}]", a.iter().map(canonical).collect::<Option<Vec<_>>>()?.join(",")),
        Value::Object(o) => {
            let mut keys: Vec<&String> = o.keys().collect();
            keys.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
            let parts = keys.into_iter().map(|k| Some(format!("{}:{}", serde_json::to_string(k).ok()?, canonical(&o[k])?))).collect::<Option<Vec<_>>>()?;
            format!("{{{}}}", parts.join(","))
        }
    })
}
fn digest(tag: &str, body: &Value) -> Option<[u8; 32]> {
    Some(Sha256::digest(format!("{DOMAIN}|{tag}|{}", canonical(body)?).as_bytes()).into())
}
fn sign_body(tag: &str, body: Value, sk: &[u8; 32]) -> Result<Value, String> {
    use secp256k1::{Keypair, Secp256k1};
    let d = digest(tag, &body).ok_or("서명할 내용이 올바르지 않습니다.")?;
    let secp = Secp256k1::new();
    let kp = Keypair::from_seckey_slice(&secp, sk).map_err(|_| "연결 열쇠가 올바르지 않습니다.")?;
    let sig = secp.sign_schnorr_no_aux_rand(&d, &kp);
    Ok(json!({ "body": body, "sig": hex::encode(sig.to_byte_array()) }))
}
fn verify_body(tag: &str, s: &Value, pub_hex: &str) -> bool {
    use secp256k1::{schnorr::Signature, Secp256k1, XOnlyPublicKey};
    let (Some(sig), Some(body)) = (s.get("sig").and_then(Value::as_str), s.get("body")) else { return false };
    if !hex_n(sig, 128) || !hex64(pub_hex) { return false; }
    let Some(d) = digest(tag, body) else { return false };
    let (Ok(pk), Ok(sb)) = (hex::decode(pub_hex), hex::decode(sig)) else { return false };
    let (Ok(xpk), Ok(sg)) = (XOnlyPublicKey::from_slice(&pk), Signature::from_slice(&sb)) else { return false };
    Secp256k1::verification_only().verify_schnorr(&sg, &d, &xpk).is_ok()
}
pub(crate) fn pubkey_of(sk: &[u8; 32]) -> Result<String, String> {
    let kp = secp256k1::Keypair::from_seckey_slice(&secp256k1::Secp256k1::new(), sk).map_err(|_| "연결 열쇠가 올바르지 않습니다.")?;
    Ok(hex::encode(kp.x_only_public_key().0.serialize()))
}

// ── 규격(link.ts 를 옮긴 것) ─────────────────────────────────────────
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Offer {
    pub v: u8,
    pub chain: String,
    pub account: u32,
    pub desktop_key: String,
    pub name: String,
    pub xpub: String,
    pub first_address: String,
    pub nonce: String,
    pub expires: i64,
}
fn link_id(desktop_key: &str, phone_key: &str, nonce: &str) -> String {
    hex::encode(digest("id", &json!({"desktopKey": desktop_key, "phoneKey": phone_key, "nonce": nonce})).unwrap_or_default())
}
pub(crate) fn confirm_code(o: &Offer, phone_key: &str) -> Option<String> {
    if !hex64(phone_key) { return None; }
    let d = digest("code", &json!({"desktopKey": o.desktop_key, "phoneKey": phone_key, "xpub": o.xpub, "path": PATH0,
        "firstAddress": o.first_address, "chain": o.chain, "nonce": o.nonce}))?;
    Some(format!("{:06}", u32::from_be_bytes([d[0], d[1], d[2], d[3]]) % 1_000_000))
}
#[derive(Clone, Debug)]
struct Accept { link_id: String, phone_key: String, phone_addresses: Vec<String> }
fn verify_accept(s: &Value, o: &Offer) -> Option<Accept> {
    let b = s.get("body")?;
    let phone_key = b.get("phoneKey")?.as_str()?;
    let addrs = b.get("phoneAddresses")?.as_array()?;
    if b.get("v")? != 1 || !hex64(phone_key) || b.get("linkId")?.as_str()? != link_id(&o.desktop_key, phone_key, &o.nonce)
        || addrs.is_empty() || addrs.len() > MAX_PHONE_ADDRESSES || !addrs.iter().all(|a| a.as_str().is_some_and(address_ok))
        || !verify_body("accept", s, phone_key) { return None; }
    Some(Accept { link_id: link_id(&o.desktop_key, phone_key, &o.nonce), phone_key: phone_key.into(),
        phone_addresses: addrs.iter().filter_map(|a| a.as_str().map(str::to_string)).collect() })
}
#[derive(Clone, Debug)]
struct Request { link_id: String, id: String, to: String, sats: u64, created: i64, expires: i64 }
fn request_shape(b: &Value) -> Option<Request> {
    let (created, expires) = (safe_int(b.get("created")?, 1)?, safe_int(b.get("expires")?, 1)?);
    let r = Request { link_id: b.get("linkId")?.as_str()?.into(), id: b.get("id")?.as_str()?.into(), to: b.get("to")?.as_str()?.into(),
        sats: sats_of(b.get("sats")?.as_str()?)?, created, expires };
    (b.get("v")? == 1 && b.get("chain")? == CHAIN && b.get("account")? == 0 && hex64(&r.link_id) && hex64(&r.id) && address_ok(&r.to)
        && expires > created && expires - created <= REQUEST_TTL_MS).then_some(r)
}
#[derive(Debug, PartialEq)]
enum Check { Ok(&'static str), No(&'static str) }
/// checkLinkRequest 와 같은 순서. seen 은 서명 전에 기록돼 있어야 한다. spent = 지난 24시간 이 연결의 합.
fn check_request(s: &Value, link: &Link, now: i64, seen: bool, spent: u64) -> (Check, Option<Request>) {
    let Some(r) = s.get("body").and_then(request_shape) else { return (Check::No("shape"), None) };
    if link.revoked { return (Check::No("revoked"), Some(r)); }
    if r.link_id != link.link_id { return (Check::No("other-link"), Some(r)); }
    if !verify_body("request", s, &link.phone_key) { return (Check::No("signature"), Some(r)); }
    if r.created > now + 120_000 { return (Check::No("future"), Some(r)); }
    if r.expires < now { return (Check::No("expired"), Some(r)); }
    if seen { return (Check::No("seen"), Some(r)); }
    if spent.saturating_add(r.sats) > link.daily_sats { return (Check::No("daily-limit"), Some(r)); }
    let kind = if link.phone_addresses.contains(&r.to) { "fill" } else { "send" };
    (Check::Ok(kind), Some(r))
}
fn verify_revoke(s: &Value, signer: &str, link_id_here: &str) -> bool {
    s.get("body").is_some_and(|b| b.get("v") == Some(&json!(1)) && b.get("linkId").and_then(Value::as_str) == Some(link_id_here)
        && b.get("at").and_then(|a| safe_int(a, 1)).is_some()) && verify_body("revoke", s, signer)
}

// ── 공개 파생: xpub → 받기 줄(0) 주소 ───────────────────────────────
fn b58check_decode(s: &str) -> Option<Vec<u8>> {
    const A: &[u8] = b"123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
    let mut out: Vec<u8> = Vec::new();
    for c in s.bytes() {
        let mut carry = A.iter().position(|&x| x == c)? as u32;
        for b in out.iter_mut().rev() { carry += (*b as u32) * 58; *b = (carry & 0xff) as u8; carry >>= 8; }
        while carry > 0 { out.insert(0, (carry & 0xff) as u8); carry >>= 8; }
    }
    let mut full = vec![0u8; s.bytes().take_while(|&c| c == b'1').count()];
    full.extend(out);
    if full.len() < 5 { return None; }
    let (data, sum) = full.split_at(full.len() - 4);
    (Sha256::digest(Sha256::digest(data))[..4] == *sum).then(|| data.to_vec())
}
/// linkReceiveAddress 와 같다: 계정 0 xpub(깊이 3) → m/…/0/index.
pub(crate) fn receive_address(xpub: &str, index: u32) -> Option<String> {
    use secp256k1::{PublicKey, Scalar, Secp256k1};
    let raw = b58check_decode(xpub)?;
    if raw.len() != 78 || raw[..4] != [0x04, 0x88, 0xb2, 0x1e] || raw[4] != 3 || raw[9..13] != 0x8000_0000u32.to_be_bytes() || index >= 0x8000_0000 { return None; }
    let secp = Secp256k1::verification_only();
    let mut chain: [u8; 32] = raw[13..45].try_into().ok()?;
    let mut key = PublicKey::from_slice(&raw[45..78]).ok()?;
    for i in [0u32, index] {
        let d = crate::identity::hmac_sha512(&chain, &[&key.serialize(), &i.to_be_bytes()]);
        key = key.add_exp_tweak(&secp, &Scalar::from_be_bytes(d[..32].try_into().ok()?).ok()?).ok()?;
        chain.copy_from_slice(&d[32..]);
    }
    Some(crate::words::base58check(60, &crate::words::ripemd160(&Sha256::digest(key.serialize()))))
}

// ── NIP-44 v2 · NIP-17(core/talk/nip44.ts·nip17.ts 와 같은 바이트) ────────
fn conv_key(my: &[u8; 32], their_x: &str) -> Option<[u8; 32]> {
    let mut p = vec![2u8];
    p.extend(hex::decode(their_x).ok().filter(|b| b.len() == 32)?);
    let point = secp256k1::PublicKey::from_slice(&p).ok()?;
    let sk = secp256k1::SecretKey::from_byte_array(my).ok()?;
    let shared = secp256k1::ecdh::shared_secret_point(&point, &sk);
    let (prk, _) = hkdf::Hkdf::<Sha256>::extract(Some(b"nip44-v2"), &shared[..32]);
    Some(prk.into())
}
fn padded_len(len: usize) -> usize {
    if len <= 32 { return 32; }
    let next = 1usize << (usize::BITS - (len - 1).leading_zeros());
    let chunk = if next <= 256 { 32 } else { next / 8 };
    chunk * ((len - 1) / chunk + 1)
}
fn message_keys(conv: &[u8; 32], nonce: &[u8]) -> Option<[u8; 76]> {
    let mut k = [0u8; 76];
    hkdf::Hkdf::<Sha256>::from_prk(conv).ok()?.expand(nonce, &mut k).ok()?;
    Some(k)
}
fn chacha(k: &[u8; 76], buf: &mut [u8]) {
    use chacha20::cipher::{KeyIvInit, StreamCipher};
    let mut c = chacha20::ChaCha20::new(k[..32].into(), k[32..44].into());
    c.apply_keystream(buf);
}
fn mac(k: &[u8; 76], nonce: &[u8], ct: &[u8]) -> hmac::Hmac<Sha256> {
    use hmac::Mac;
    let mut m = <hmac::Hmac<Sha256> as Mac>::new_from_slice(&k[44..]).expect("hmac key");
    m.update(nonce);
    m.update(ct);
    m
}
fn nip44_encrypt(plain: &str, conv: &[u8; 32], nonce: [u8; 32]) -> Option<String> {
    use base64::Engine;
    use hmac::Mac;
    let b = plain.as_bytes();
    if b.is_empty() || b.len() > 65535 { return None; }
    let mut buf = vec![0u8; 2 + padded_len(b.len())];
    buf[..2].copy_from_slice(&(b.len() as u16).to_be_bytes());
    buf[2..2 + b.len()].copy_from_slice(b);
    let k = message_keys(conv, &nonce)?;
    chacha(&k, &mut buf);
    let tag = mac(&k, &nonce, &buf).finalize().into_bytes();
    let mut out = vec![2u8];
    out.extend(nonce);
    out.extend(&buf);
    out.extend(tag);
    Some(base64::engine::general_purpose::STANDARD.encode(out))
}
fn nip44_decrypt(payload: &str, conv: &[u8; 32]) -> Option<String> {
    use base64::Engine;
    use hmac::Mac;
    if payload.len() < 132 || payload.len() > 87_472 || payload.starts_with('#') { return None; }
    let raw = base64::engine::general_purpose::STANDARD.decode(payload).ok()?;
    if raw.len() < 99 || raw[0] != 2 { return None; }
    let (nonce, rest) = raw[1..].split_at(32);
    let (ct, tag) = rest.split_at(rest.len() - 32);
    let k = message_keys(conv, nonce)?;
    mac(&k, nonce, ct).verify_slice(tag).ok()?;
    let mut buf = ct.to_vec();
    chacha(&k, &mut buf);
    let len = u16::from_be_bytes([buf[0], buf[1]]) as usize;
    if len < 1 || buf.len() != 2 + padded_len(len) { return None; }
    String::from_utf8(buf[2..2 + len].to_vec()).ok()
}
fn random32() -> [u8; 32] {
    use rand::RngCore;
    let mut b = [0u8; 32];
    rand::rngs::OsRng.fill_bytes(&mut b);
    b
}
fn fuzzy(now: i64) -> i64 {
    use rand::Rng;
    now - rand::rngs::OsRng.gen_range(0..172_800)
}
fn event_id(pubkey: &str, created_at: i64, kind: i64, tags: &Value, content: &str) -> String {
    hex::encode(Sha256::digest(serde_json::to_string(&json!([0, pubkey, created_at, kind, tags, content])).unwrap_or_default().as_bytes()))
}
/// wrapFor(나, 상대, 상대, text) — 상대에게 가는 겉봉 하나(내 사본은 만들지 않는다, transport.ts 와 같음).
fn wrap_for(my: &[u8; 32], to: &str, text: &str, now: i64) -> Result<Value, String> {
    let me = pubkey_of(my)?;
    let tags = json!([["p", to]]);
    let rumor = json!({"pubkey": me, "created_at": now, "kind": 14, "tags": tags, "content": text, "id": event_id(&me, now, 14, &tags, text)});
    let ck = conv_key(my, to).ok_or("받는 열쇠가 올바르지 않습니다.")?;
    let sealed = nip44_encrypt(&rumor.to_string(), &ck, random32()).ok_or("봉인하지 못했습니다.")?;
    let seal = crate::shopkey::sign_with(my, 13, json!([]), &sealed, fuzzy(now))?;
    let mut once = random32();
    while secp256k1::SecretKey::from_byte_array(&once).is_err() { once = random32(); }
    let ck2 = conv_key(&once, to).ok_or("봉인하지 못했습니다.")?;
    let content = nip44_encrypt(&seal.to_string(), &ck2, random32()).ok_or("봉인하지 못했습니다.")?;
    let out = crate::shopkey::sign_with(&once, 1059, json!([["p", to]]), &content, fuzzy(now));
    crate::words::wipe_bytes(&mut once);
    out
}
/// unwrap 과 같은 검사. (보낸 이, 글).
fn unwrap(my: &[u8; 32], gift: &Value) -> Option<(String, String)> {
    if gift.get("kind")?.as_i64()? != 1059 || !crate::relay::verify(gift) { return None; }
    let seal: Value = serde_json::from_str(&nip44_decrypt(gift.get("content")?.as_str()?, &conv_key(my, gift.get("pubkey")?.as_str()?)?)?).ok()?;
    if seal.get("kind")?.as_i64()? != 13 || !hex64(seal.get("pubkey")?.as_str()?) || !crate::relay::verify(&seal) { return None; }
    let from = seal.get("pubkey")?.as_str()?.to_string();
    let rumor: Value = serde_json::from_str(&nip44_decrypt(seal.get("content")?.as_str()?, &conv_key(my, &from)?)?).ok()?;
    let (content, tags, at) = (rumor.get("content")?.as_str()?, rumor.get("tags")?, safe_int(rumor.get("created_at")?, 0)?);
    if rumor.get("kind")?.as_i64()? != 14 || rumor.get("pubkey")?.as_str()? != from || !tags.is_array() { return None; }
    let to = tags.as_array()?.iter().find(|t| t.get(0).and_then(Value::as_str) == Some("p"))?.get(1)?.as_str()?.to_string();
    if !hex64(&to) || rumor.get("id")?.as_str()? != event_id(&from, at, 14, tags, content) { return None; }
    let me = pubkey_of(my).ok()?;
    if to != me && from != me { return None; }
    Some((from, content.chars().take(8000).collect()))
}
fn pack(my: &[u8; 32], to: &str, t: &str, s: &Value) -> Result<Value, String> {
    wrap_for(my, to, &json!({"rvwl1": t, "s": s}).to_string(), now_ms() / 1000)
}
fn open(my: &[u8; 32], gift: &Value) -> Option<(String, String, Value)> {
    let (from, text) = unwrap(my, gift)?;
    let v: Value = serde_json::from_str(&text).ok()?;
    let t = v.get("rvwl1")?.as_str()?;
    if !["accept", "request", "result", "revoke"].contains(&t) || !v.get("s")?.is_object() { return None; }
    Some((from, t.into(), v["s"].clone()))
}

// ── 연결 열쇠 보관 ────────────────────────────────────────────────
struct Secret([u8; 32]);
impl Drop for Secret { fn drop(&mut self) { crate::words::wipe_bytes(&mut self.0); } }
mod keystore {
    const ACCOUNT: &str = "wallet-link-key";
    #[cfg(not(test))]
    fn service() -> String {
        use sha2::{Digest, Sha256};
        let dir = crate::paths::app_dir();
        let dir = dir.canonicalize().unwrap_or(dir);
        format!("se.erci.ravenvault.desktop.wallet-link.{}", &hex::encode(Sha256::digest(dir.to_string_lossy().as_bytes()))[..16])
    }
    #[cfg(test)]
    static MEM: std::sync::Mutex<Option<String>> = std::sync::Mutex::new(None);
    #[cfg(test)]
    pub fn get() -> Result<Option<String>, String> { let _ = ACCOUNT; Ok(MEM.lock().map_err(|_| "x")?.clone()) }
    #[cfg(test)]
    pub fn set(v: &str) -> Result<(), String> { *MEM.lock().map_err(|_| "x")? = Some(v.into()); Ok(()) }
    #[cfg(all(not(test), any(target_os = "macos", target_os = "windows")))]
    pub fn get() -> Result<Option<String>, String> {
        let e = keyring::Entry::new(&service(), ACCOUNT).map_err(|_| "보안 저장소를 열지 못했어요.")?;
        match e.get_password() { Ok(v) => Ok(Some(v)), Err(keyring::Error::NoEntry) => Ok(None), Err(_) => Err("보안 저장소에서 연결 열쇠를 읽지 못했어요.".into()) }
    }
    #[cfg(all(not(test), any(target_os = "macos", target_os = "windows")))]
    pub fn set(v: &str) -> Result<(), String> {
        keyring::Entry::new(&service(), ACCOUNT).and_then(|e| e.set_password(v)).map_err(|_| "보안 저장소에 연결 열쇠를 넣지 못했어요.".into())
    }
    #[cfg(all(not(test), not(any(target_os = "macos", target_os = "windows"))))]
    fn file() -> std::path::PathBuf { crate::paths::app_file("wallet-link/link.key") }
    #[cfg(all(not(test), not(any(target_os = "macos", target_os = "windows"))))]
    pub fn get() -> Result<Option<String>, String> {
        let _ = (service, ACCOUNT);
        match std::fs::read_to_string(file()) { Ok(v) => Ok(Some(v.trim().into())), Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None), Err(_) => Err("연결 열쇠 파일을 읽지 못했어요.".into()) }
    }
    #[cfg(all(not(test), not(any(target_os = "macos", target_os = "windows"))))]
    pub fn set(v: &str) -> Result<(), String> { crate::payout_guard::atomic_write(&file(), v.as_bytes()) }
}
fn link_secret() -> Result<Secret, String> {
    if let Some(mut h) = keystore::get()? {
        let b = hex::decode(&h).ok().filter(|b| b.len() == 32);
        crate::words::wipe(&mut h);
        let mut b = b.ok_or("연결 열쇠가 깨졌어요. 연결을 끊고 다시 연결해 주세요.")?;
        let mut sk = Secret([0u8; 32]);
        sk.0.copy_from_slice(&b);
        crate::words::wipe_bytes(&mut b);
        secp256k1::SecretKey::from_byte_array(&sk.0).map_err(|_| "연결 열쇠가 깨졌어요.")?;
        return Ok(sk);
    }
    let mut sk = Secret(random32());
    while secp256k1::SecretKey::from_byte_array(&sk.0).is_err() { sk = Secret(random32()); }
    let mut h = hex::encode(sk.0);
    let r = keystore::set(&h);
    crate::words::wipe(&mut h);
    r?;
    Ok(sk)
}

// ── 기록(state.json, 0600) ─────────────────────────────────────────
#[derive(Clone, Debug, Serialize, Deserialize)]
struct Link {
    link_id: String,
    phone_key: String,
    phone_addresses: Vec<String>,
    name: String,
    daily_sats: u64,
    created: i64,
    revoked: bool,
    #[serde(default)]
    revoked_at: Option<i64>,
    /// 우리가 서명한 끊기 — 아직 못 보냈으면 다음 확인 때 다시 보낸다.
    #[serde(default)]
    revoke_out: Option<Value>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
struct Req {
    link_id: String,
    kind: String,
    to: String,
    sats: u64,
    created: i64,
    expires: i64,
    received: i64,
    /// pending · sending · sent · refused · unknown
    status: String,
    #[serde(default)]
    txid: Option<String>,
    #[serde(default)]
    refused: Option<String>,
    #[serde(default)]
    result: Option<Value>,
    #[serde(default)]
    result_published: bool,
    /// 승인할 때 확인한 수수료. 하루 한도와 쓴 돈 기록에 금액과 함께 들어간다.
    #[serde(default)]
    fee: u64,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
struct Spend { link_id: String, at: i64, sats: u64 }
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(default)]
struct State {
    links: Vec<Link>,
    requests: BTreeMap<String, Req>,
    seen: BTreeMap<String, i64>,
    spends: BTreeMap<String, Spend>,
    wraps: BTreeMap<String, i64>,
    last_fetch: i64,
    /// 아직 연결 기록이 없는 연결 id 로 온 서명된 끊기(연결 id → 서명한 폰 키). 「같아요」 전에 폰이 취소한 경우를 막는다.
    orphan_revokes: BTreeMap<String, (String, i64)>,
}
fn state_file(dir: &Path) -> PathBuf { dir.join("state.json") }
fn load(dir: &Path) -> Result<State, String> {
    match std::fs::read(state_file(dir)) {
        Ok(b) => serde_json::from_slice(&b).map_err(|_| "연결 기록이 깨져 있어요. 덮어쓰지 않고 멈췄어요.".into()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(State::default()),
        Err(_) => Err("연결 기록을 읽지 못했어요.".into()),
    }
}
fn save(dir: &Path, s: &State) -> Result<(), String> {
    crate::payout_guard::atomic_write(&state_file(dir), &serde_json::to_vec_pretty(s).map_err(|_| "기록 오류")?)
}
fn spent_today(s: &State, link: &str, now: i64, except: &str) -> u64 {
    // 한도 없음(총발행량)이어도 넘치지 않게 모두 saturating 으로 더한다.
    let done: u64 = s.spends.iter().filter(|(id, x)| x.link_id == link && x.at > now - DAY_MS && id.as_str() != except).fold(0u64, |a, (_, x)| a.saturating_add(x.sats));
    let flying: u64 = s.requests.iter().filter(|(id, r)| r.link_id == link && id.as_str() != except && !s.spends.contains_key(id.as_str())
        && matches!(r.status.as_str(), "sending" | "unknown")).fold(0u64, |a, (_, r)| a.saturating_add(r.sats.saturating_add(r.fee)));
    done.saturating_add(flying)
}
fn prune(s: &mut State, now: i64) {
    s.seen.retain(|_, at| *at > now - SEEN_RETAIN_MS);
    // 커서가 멈춰 있으면(덜 읽음) 그 커서보다 앞의 겉봉도 다시 올 수 있다 — 그만큼 더 기억한다.
    let wrap_cut = (now - WRAP_RETAIN_MS).min(s.last_fetch.saturating_mul(1000) - WRAP_RETAIN_MS);
    s.wraps.retain(|_, at| *at > wrap_cut);
    s.orphan_revokes.retain(|_, (_, at)| *at > now - WRAP_RETAIN_MS);
    s.spends.retain(|_, x| x.at > now - 2 * DAY_MS);
    s.requests.retain(|_, r| r.status == "pending" || r.status == "sending" || r.status == "unknown" || r.received > now - 7 * DAY_MS);
}

// ── 바깥(노드·릴레이) ──────────────────────────────────────────────
pub(crate) trait Net {
    async fn publish(&self, event: Value) -> Result<(), String>;
    /// (겉봉들, 끝까지 다 읽었나). 덜 읽었으면 커서를 옮기지 않는다.
    async fn fetch(&self, pubkey: &str, since: i64) -> Result<(Vec<Value>, bool), String>;
}
struct Relays;
impl Net for Relays {
    async fn publish(&self, event: Value) -> Result<(), String> { crate::nostrpub::nostr_publish(event).await.map(|_| ()) }
    async fn fetch(&self, pubkey: &str, since: i64) -> Result<(Vec<Value>, bool), String> { crate::nostrpub::nostr_query_inbox(pubkey, since).await }
}
fn dir() -> PathBuf { crate::paths::app_file("wallet-link") }
fn payouts(dir: &Path) -> PathBuf {
    if cfg!(test) { dir.join("payouts") } else { crate::paths::app_file("payouts") }
}

// ── 화면이 들고 있지 않는 것(메모리) ────────────────────────────────
struct Session { xpub: String, first: String, name: String, authed: i64, offer: Option<Offer>, candidate: Option<Accept> }
#[derive(Clone)]
struct Review { hex: String, fingerprint: String, inputs: Vec<(String, u64)>, fee: u64, at: i64 }
static SESSION: std::sync::Mutex<Option<Session>> = std::sync::Mutex::new(None);
static REVIEWS: std::sync::LazyLock<std::sync::Mutex<HashMap<(PathBuf, String), Review>>> = std::sync::LazyLock::new(Default::default);
static GATE: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

// ── 연결 만들기 ──────────────────────────────────────────────────
/// 암호로 다시 인증(이미 열려 있어도) → 계정 0 xpub → 첫 받는 주소가 정말 이 지갑 것인지 노드에 묻는다.
async fn reveal_main_with(rpc: &impl SalesRpc, passphrase: Text) -> Result<(String, String), String> {
    let xpub = crate::sales_account::reveal_account_with(rpc, passphrase, 0).await.map_err(|_| AUTH_ERROR.to_string())?;
    let first = receive_address(&xpub, 0).ok_or(AUTH_ERROR)?;
    let v = rpc.call("validateaddress", json!([first])).await.map_err(|_| NOT_MINE.to_string())?;
    let path_ok = v.get("hdkeypath").and_then(Value::as_str).is_none_or(|p| p == "m/44'/175'/0'/0/0");
    if v.get("isvalid") != Some(&json!(true)) || v.get("ismine") != Some(&json!(true)) || !path_ok { return Err(NOT_MINE.into()); }
    Ok((xpub, first))
}
fn new_offer(sess: &mut Session, desktop_key: &str, now: i64) -> Offer {
    let o = Offer { v: 1, chain: CHAIN.into(), account: 0, desktop_key: desktop_key.into(), name: sess.name.clone(), xpub: sess.xpub.clone(),
        first_address: sess.first.clone(), nonce: hex::encode(random32()), expires: now + OFFER_TTL_MS };
    sess.offer = Some(o.clone());
    sess.candidate = None;
    o
}
fn clean_name(name: &str, fallback: &str) -> String {
    let n: String = name.trim().chars().filter(|c| !c.is_control()).take(40).collect();
    if n.is_empty() { fallback.into() } else { n }
}

#[tauri::command]
pub async fn wallet_link_offer(passphrase: String, name: String) -> Result<Value, String> {
    let passphrase = Text(passphrase);
    let _gate = GATE.lock().await;
    let (xpub, first) = reveal_main_with(&crate::sales_account::NativeRpc, passphrase).await?;
    let sk = link_secret()?;
    let key = pubkey_of(&sk.0)?;
    let mut sess = Session { xpub, first, name: clean_name(&name, "데스크탑 지갑"), authed: now_ms(), offer: None, candidate: None };
    let o = new_offer(&mut sess, &key, now_ms());
    *SESSION.lock().map_err(|_| "x")? = Some(sess);
    Ok(serde_json::to_value(o).unwrap_or_default())
}
/// 1분이 지나 QR 을 새로 만들 때. 인증 뒤 5분 안에서만(그 뒤엔 다시 인증).
#[tauri::command]
pub async fn wallet_link_offer_again() -> Result<Value, String> {
    let _gate = GATE.lock().await;
    let key = pubkey_of(&link_secret()?.0)?;
    let mut g = SESSION.lock().map_err(|_| "x")?;
    let now = now_ms();
    let sess = g.as_mut().filter(|s| now - s.authed < SESSION_MS).ok_or("인증한 지 5분이 지났어요. 다시 인증해 주세요.")?;
    Ok(serde_json::to_value(new_offer(sess, &key, now)).unwrap_or_default())
}
#[tauri::command]
pub fn wallet_link_cancel() -> Result<(), String> {
    *SESSION.lock().map_err(|_| "x")? = None;
    Ok(())
}
fn parse_rvn(text: &str) -> Option<u64> {
    let t = text.trim().replace(',', "");
    let (a, b) = t.split_once('.').unwrap_or((&t, ""));
    if a.is_empty() || a.len() > 11 || b.len() > 8 || !a.bytes().all(|c| c.is_ascii_digit()) || !b.bytes().all(|c| c.is_ascii_digit()) { return None; }
    Some(a.parse::<u64>().ok()? * 100_000_000 + format!("{b:0<8}").parse::<u64>().ok()?)
}
/// 두 화면의 숫자가 같다고 사람이 눌렀을 때만 저장한다. 하루 한도: 기본 1,000 RVN(칸이 비면) · 원하는 만큼 · 「한도 없음」=DAILY_MAX_SATS(11-03 대표).
fn confirm_in(dir: &Path, sess: &Session, daily_rvn: &str, phone_name: &str, now: i64) -> Result<Value, String> {
    let (o, a) = (sess.offer.as_ref().ok_or("연결 QR 이 없어요.")?, sess.candidate.as_ref().ok_or("폰의 응답을 아직 받지 못했어요.")?);
    if now > o.expires + ACCEPT_GRACE_MS { return Err("시간이 지났어요. QR 을 새로 만들어 주세요.".into()); }
    let daily = if daily_rvn.trim().is_empty() { Some(DAILY_DEFAULT_SATS) } else { parse_rvn(daily_rvn).filter(|d| *d >= 1 && *d <= DAILY_MAX_SATS) }
        .ok_or(LIMIT_BAD)?;
    let mut s = load(dir)?;
    if s.links.iter().any(|l| l.link_id == a.link_id) { return Err("이미 연결된 폰이에요.".into()); }
    if s.orphan_revokes.get(&a.link_id).is_some_and(|(k, _)| *k == a.phone_key) { return Err(PHONE_CANCELLED.into()); }
    s.links.push(Link { link_id: a.link_id.clone(), phone_key: a.phone_key.clone(), phone_addresses: a.phone_addresses.clone(),
        name: clean_name(phone_name, "내 폰"), daily_sats: daily, created: now, revoked: false, revoked_at: None, revoke_out: None });
    if s.last_fetch == 0 { s.last_fetch = now / 1000; }
    save(dir, &s)?;
    Ok(json!({ "linkId": a.link_id, "dailySats": daily.to_string() }))
}
#[tauri::command]
pub async fn wallet_link_confirm(daily_rvn: String, phone_name: String) -> Result<Value, String> {
    let _gate = GATE.lock().await;
    let mut g = SESSION.lock().map_err(|_| "x")?;
    let out = confirm_in(&dir(), g.as_ref().ok_or("연결 QR 이 없어요.")?, &daily_rvn, &phone_name, now_ms())?;
    *g = None;
    Ok(out)
}

// ── 받은 쪽지 처리 ────────────────────────────────────────────────
/// 겉봉들을 처리한다. 돌려주는 것 = 보낼 (상대 연결 키, 종류, 서명 묶음). 서명·지급은 하지 않는다(거절 결과만 서명).
fn process(dir: &Path, sk: &[u8; 32], gifts: &[Value], now: i64, session: Option<&mut Session>) -> Result<Vec<(String, &'static str, Value)>, String> {
    let mut s = load(dir)?;
    let mut out = Vec::new();
    let mut session = session;
    for g in gifts {
        let Some(wid) = g.get("id").and_then(Value::as_str).filter(|i| hex64(i)) else { continue };
        if s.wraps.contains_key(wid) { continue; }
        s.wraps.insert(wid.into(), now);
        let Some((from, t, msg)) = open(sk, g) else { continue };
        match t.as_str() {
            "accept" => {
                let Some(sess) = session.as_deref_mut() else { continue };
                let Some(o) = sess.offer.clone() else { continue };
                if sess.candidate.is_some() || now > o.expires + ACCEPT_GRACE_MS { continue; }
                if let Some(a) = verify_accept(&msg, &o).filter(|a| a.phone_key == from) {
                    // 이 연결을 폰이 이미 취소했다면(끊기가 먼저 도착) 후보로도 올리지 않는다.
                    if !s.orphan_revokes.get(&a.link_id).is_some_and(|(k, _)| *k == a.phone_key) { sess.candidate = Some(a); }
                }
            }
            "request" => {
                let Some(lid) = msg.get("body").and_then(|b| b.get("linkId")).and_then(Value::as_str) else { continue };
                let Some(link) = s.links.iter().find(|l| l.link_id == lid && l.phone_key == from).cloned() else { continue };
                let rid = msg["body"].get("id").and_then(Value::as_str).unwrap_or("").to_string();
                let seen = s.seen.contains_key(&rid) || s.requests.contains_key(&rid);
                let spent = spent_today(&s, &link.link_id, now, &rid);
                match check_request(&msg, &link, now, seen, spent) {
                    (Check::Ok(kind), Some(r)) => {
                        // 🔴 서명보다 먼저 기록한다. 이 저장이 실패하면 화면에 띄우지도 않는다.
                        s.seen.insert(r.id.clone(), now);
                        s.requests.insert(r.id.clone(), Req { link_id: r.link_id, kind: kind.into(), to: r.to, sats: r.sats, created: r.created,
                            expires: r.expires, received: now, status: "pending".into(), txid: None, refused: None, result: None, result_published: false, fee: 0 });
                        save(dir, &s)?;
                    }
                    (Check::No("seen"), _) => {
                        // 같은 요청이 다시 왔다: 다시 서명하지 않고 이미 낸 결과를 그대로 다시 보낸다.
                        if let Some(res) = s.requests.get(&rid).and_then(|r| r.result.clone()) { out.push((link.phone_key.clone(), "result", res)); }
                    }
                    (Check::No(why @ ("expired" | "future" | "daily-limit")), Some(r)) => {
                        s.seen.insert(r.id.clone(), now);
                        let res = sign_body("result", json!({"v": 1, "linkId": r.link_id, "id": r.id, "refused": why}), sk)?;
                        s.requests.insert(r.id.clone(), Req { link_id: r.link_id, kind: "refused".into(), to: r.to, sats: r.sats, created: r.created,
                            expires: r.expires, received: now, status: "refused".into(), txid: None, refused: Some(why.into()), result: Some(res.clone()), result_published: false, fee: 0 });
                        out.push((link.phone_key.clone(), "result", res));
                    }
                    _ => {}
                }
            }
            "revoke" => {
                let Some(lid) = msg.get("body").and_then(|b| b.get("linkId")).and_then(Value::as_str).map(str::to_string) else { continue };
                if let Some(l) = s.links.iter_mut().find(|l| l.link_id == lid && l.phone_key == from && !l.revoked) {
                    if verify_revoke(&msg, &from, &lid) {
                        l.revoked = true;
                        l.revoked_at = Some(now);
                        cancel_pending(&mut s, &lid);
                    }
                } else if !s.links.iter().any(|l| l.link_id == lid) && verify_revoke(&msg, &from, &lid) {
                    // 아직 「같아요」 전인 연결(또는 모르는 연결)의 끊기 — 버리지 않고 남긴다. 확인 단계가 이것을 보고 막는다.
                    s.orphan_revokes.insert(lid, (from.clone(), now));
                }
            }
            _ => {}
        }
    }
    // 만료된 대기 요청은 거절로 닫고 폰에 알린다.
    let expired: Vec<String> = s.requests.iter().filter(|(_, r)| r.status == "pending" && r.expires < now).map(|(k, _)| k.clone()).collect();
    for id in expired {
        let r = s.requests.get_mut(&id).expect("listed");
        let res = sign_body("result", json!({"v": 1, "linkId": r.link_id, "id": id, "refused": "expired"}), sk)?;
        r.status = "refused".into();
        r.refused = Some("expired".into());
        r.result = Some(res);
    }
    // 아직 못 보낸 결과·끊기를 다시 보낸다.
    for (_, r) in s.requests.iter() {
        if let (Some(res), false) = (&r.result, r.result_published) {
            if let Some(l) = s.links.iter().find(|l| l.link_id == r.link_id) {
                if !out.iter().any(|(_, _, v)| v == res) { out.push((l.phone_key.clone(), "result", res.clone())); }
            }
        }
    }
    for l in &s.links { if let Some(rv) = &l.revoke_out { out.push((l.phone_key.clone(), "revoke", rv.clone())); } }
    prune(&mut s, now);
    save(dir, &s)?;
    Ok(out)
}
fn cancel_pending(s: &mut State, link_id: &str) {
    for r in s.requests.values_mut().filter(|r| r.link_id == link_id && r.status == "pending") {
        r.status = "refused".into();
        r.refused = Some("revoked".into());
        r.result = None;
    }
}
/// 보낸 것을 기록에 표시한다(결과는 publish 성공 시 result_published, 끊기는 revoke_out 비움).
fn mark_sent(dir: &Path, sent: &[(&'static str, Value)]) -> Result<(), String> {
    if sent.is_empty() { return Ok(()); }
    let mut s = load(dir)?;
    for (t, v) in sent {
        if *t == "result" { for r in s.requests.values_mut() { if r.result.as_ref() == Some(v) { r.result_published = true; } } }
        if *t == "revoke" { for l in s.links.iter_mut() { if l.revoke_out.as_ref() == Some(v) { l.revoke_out = None; } } }
    }
    save(dir, &s)
}
async fn deliver(net: &impl Net, dir: &Path, sk: &[u8; 32], out: Vec<(String, &'static str, Value)>) -> Result<(), String> {
    let mut sent = Vec::new();
    for (to, t, s) in out {
        if let Ok(ev) = pack(sk, &to, t, &s) { if net.publish(ev).await.is_ok() { sent.push((t, s)); } }
    }
    mark_sent(dir, &sent)
}
fn view(dir: &Path, now: i64) -> Result<Value, String> {
    let s = load(dir)?;
    let name = |id: &str| s.links.iter().find(|l| l.link_id == id).map(|l| l.name.clone()).unwrap_or_default();
    let pending: Vec<Value> = s.requests.iter().filter(|(_, r)| r.status == "pending").map(|(id, r)| json!({
        "id": id, "linkId": r.link_id, "phoneName": name(&r.link_id), "kind": r.kind, "to": r.to, "sats": r.sats.to_string(),
        "created": r.created, "expires": r.expires })).collect();
    let links: Vec<Value> = s.links.iter().map(|l| json!({ "linkId": l.link_id, "name": l.name, "phoneAddresses": l.phone_addresses,
        "dailySats": l.daily_sats.to_string(), "spentToday": spent_today(&s, &l.link_id, now, "").to_string(), "created": l.created, "revoked": l.revoked })).collect();
    Ok(json!({ "pending": pending, "links": links }))
}
async fn inbox_with(net: &impl Net, dir: &Path, sk: &[u8; 32], now: i64) -> Result<Value, String> {
    let key = pubkey_of(sk)?;
    let since = load(dir)?.last_fetch;
    let since = if since > 0 { since } else { now / 1000 } - WRAP_SKEW_SEC;
    let fetched = net.fetch(&key, since).await;
    let gifts = fetched.as_ref().map(|(g, _)| g.as_slice()).unwrap_or(&[]);
    let (out, offer) = {
        let mut g = SESSION.lock().map_err(|_| "x")?;
        let out = process(dir, sk, gifts, now, g.as_mut())?;
        let offer = g.as_ref().and_then(|sess| {
            let o = sess.offer.as_ref()?;
            Some(match &sess.candidate {
                Some(a) if load(dir).ok()?.orphan_revokes.get(&a.link_id).is_some_and(|(k, _)| *k == a.phone_key) => json!({ "stage": "cancelled" }),
                Some(a) => json!({ "stage": "confirm", "code": confirm_code(o, &a.phone_key), "phoneKey": a.phone_key, "phoneAddresses": a.phone_addresses, "offer": o }),
                None => json!({ "stage": "waiting", "expires": o.expires }),
            })
        });
        (out, offer)
    };
    // 🔴 끝까지 읽었을 때만 커서를 옮긴다. 덜 읽었으면 다음에 같은 자리부터 다시 읽는다.
    let complete = matches!(fetched, Ok((_, true)));
    if complete { let mut s = load(dir)?; s.last_fetch = now / 1000; save(dir, &s)?; }
    deliver(net, dir, sk, out).await?;
    let mut v = view(dir, now)?;
    v["offer"] = offer.unwrap_or(Value::Null);
    v["online"] = json!(fetched.is_ok());
    v["complete"] = json!(complete);
    Ok(v)
}
/// 화면이 잠기지 않은 동안 주기적으로 부른다(앱 잠금 중에는 app_lock 이 막는다). 승인은 하지 않는다.
#[tauri::command]
pub async fn wallet_link_inbox() -> Result<Value, String> {
    let _gate = GATE.lock().await;
    let sk = link_secret()?;
    inbox_with(&Relays, &dir(), &sk.0, now_ms()).await
}
#[tauri::command]
pub fn wallet_link_list() -> Result<Value, String> { view(&dir(), now_ms()) }

// ── 승인 화면(실제 거래를 만들어 보여 준다) ───────────────────────────
fn fingerprint(hex_tx: &str) -> String { hex::encode(&Sha256::digest(hex_tx.as_bytes())[..16]) }
fn live_request(s: &State, id: &str, now: i64, fee: u64) -> Result<(Req, Link), String> {
    let r = s.requests.get(id).filter(|r| r.status == "pending").cloned().ok_or("이미 처리했거나 없는 요청이에요.")?;
    let l = s.links.iter().find(|l| l.link_id == r.link_id && !l.revoked).cloned().ok_or("연결이 끊긴 폰의 요청이에요.")?;
    if r.expires < now { return Err("요청 시간(10분)이 지났어요.".into()); }
    if spent_today(s, &l.link_id, now, id).saturating_add(r.sats).saturating_add(fee) > l.daily_sats { return Err(OVER_LIMIT.into()); }
    Ok((r, l))
}
/// 입력 동전마다 아직 안 쓰였는지 보고 금액을 더한다. 하나라도 쓰였으면 None(=거래가 바뀜).
async fn input_values(rpc: &impl SalesRpc, inputs: &[(String, u64)]) -> Option<u64> {
    let mut total = 0u64;
    for (txid, n) in inputs {
        let o = rpc.call("gettxout", json!([txid, n, true])).await.ok()?;
        total = total.checked_add(to_sats(o.get("value")?.as_f64()?)?)?;
    }
    Some(total)
}
async fn review_with(rpc: &impl SalesRpc, dir: &Path, id: &str, now: i64) -> Result<Value, String> {
    let s = load(dir)?;
    let (r, l) = live_request(&s, id, now, 0)?;
    let change = rpc.call("listreceivedbyaddress", json!([0, true])).await.ok().as_ref().and_then(crate::sendfee::change_from);
    let mut outs = serde_json::Map::new();
    outs.insert(r.to.clone(), json!(rvn_text(r.sats)));
    let raw = rpc.call("createrawtransaction", json!([[], Value::Object(outs)])).await?;
    let mut opts = json!({ "lockUnspents": false });
    if let Some(c) = &change { opts["changeAddress"] = json!(c); }
    let funded = match rpc.call("fundrawtransaction", json!([raw, opts])).await {
        Ok(v) => v,
        Err(e) if e.to_lowercase().contains("insufficient") => return Ok(json!({ "id": id, "short": true })),
        Err(e) => return Err(e),
    };
    let hex_tx = funded.get("hex").and_then(Value::as_str).ok_or("노드가 거래를 만들지 못했어요.")?.to_string();
    let tx = rpc.call("decoderawtransaction", json!([hex_tx])).await?;
    let inputs: Vec<(String, u64)> = tx.get("vin").and_then(Value::as_array).ok_or("거래를 읽지 못했어요.")?.iter()
        .map(|i| Some((i.get("txid")?.as_str().filter(|t| hex64(t))?.to_string(), i.get("vout")?.as_u64()?))).collect::<Option<_>>().ok_or("거래를 읽지 못했어요.")?;
    let vout = tx.get("vout").and_then(Value::as_array).ok_or("거래를 읽지 못했어요.")?;
    let (mut to_me, mut paid, mut out_total) = (0usize, 0usize, 0u64);
    for o in vout {
        let sats = o.get("value").and_then(Value::as_f64).and_then(to_sats).ok_or("거래를 읽지 못했어요.")?;
        let addrs = o.pointer("/scriptPubKey/addresses").and_then(Value::as_array).cloned().unwrap_or_default();
        let a = (addrs.len() == 1).then(|| addrs[0].as_str()).flatten().ok_or("알 수 없는 출력이 있어요.")?;
        out_total = out_total.checked_add(sats).ok_or("금액 오류")?;
        if a == r.to && sats == r.sats && paid == 0 { paid += 1; continue; }
        let mine = rpc.call("validateaddress", json!([a])).await.ok().and_then(|v| v.get("ismine").and_then(Value::as_bool)).unwrap_or(false);
        if !mine { return Err("거스름이 이 지갑으로 돌아오지 않는 거래라 멈췄어요.".into()); }
        to_me += 1;
    }
    if paid != 1 || to_me > 1 || inputs.is_empty() { return Err("요청과 다른 거래가 만들어져 멈췄어요.".into()); }
    let in_total = input_values(rpc, &inputs).await.ok_or(CHANGED)?;
    let fee = in_total.checked_sub(out_total).ok_or("금액 오류")?;
    let node_fee = funded.get("fee").and_then(Value::as_f64).and_then(to_sats).ok_or("노드가 수수료를 알려 주지 않았어요.")?;
    if fee.abs_diff(node_fee) > 1 || fee > FEE_CAP_SATS { return Err("수수료가 이상해서 멈췄어요.".into()); }
    live_request(&s, id, now, fee)?;
    let fp = fingerprint(&hex_tx);
    REVIEWS.lock().map_err(|_| "x")?.insert((dir.to_path_buf(), id.to_string()), Review { hex: hex_tx, fingerprint: fp.clone(), inputs, fee, at: now });
    Ok(json!({ "id": id, "short": false, "kind": r.kind, "to": r.to, "sats": r.sats.to_string(), "feeSats": fee.to_string(),
        "totalSats": (r.sats + fee).to_string(), "fingerprint": fp, "phoneName": l.name, "expires": r.expires,
        "isMine": change.as_deref() == Some(r.to.as_str()) }))
}
#[tauri::command]
pub async fn wallet_link_review(id: String) -> Result<Value, String> {
    let _gate = GATE.lock().await;
    review_with(&crate::sales_account::NativeRpc, &dir(), &id, now_ms()).await
}

// ── 승인 · 거절 · 끊기 ────────────────────────────────────────────
/// send::with_unlocked 와 같은 강도: 잠긴 지갑이면 암호로 30초만 열고, 끝나면 다시 잠근다.
async fn with_unlocked_rpc<T, F, Fut>(rpc: &impl SalesRpc, passphrase: Option<Text>, body: F) -> Result<T, String>
where F: FnOnce() -> Fut, Fut: std::future::Future<Output = Result<T, String>> {
    let info = rpc.call("getwalletinfo", json!([])).await?;
    if info.get("unlocked_until").and_then(Value::as_i64) != Some(0) { return body().await; }
    let pass = passphrase.filter(|p| !p.0.is_empty()).ok_or("지갑이 잠겨 있어요. 암호를 넣어 주세요.")?;
    rpc.call("walletpassphrase", json!([pass.0.clone(), 30])).await.map_err(|_| "암호가 맞지 않거나 지갑을 열지 못했어요.".to_string())?;
    drop(pass);
    let r = body().await;
    let _ = rpc.call("walletlock", json!([])).await;
    r
}
fn finish(dir: &Path, sk: &[u8; 32], id: &str, txid: &str, now: i64) -> Result<(String, Value), String> {
    let mut s = load(dir)?;
    let r = s.requests.get_mut(id).ok_or("요청 기록이 없어요.")?;
    let res = sign_body("result", json!({"v": 1, "linkId": r.link_id, "id": id, "txid": txid}), sk)?;
    r.status = "sent".into();
    r.txid = Some(txid.into());
    if r.result.is_none() || r.result.as_ref().and_then(|v| v.pointer("/body/txid")).and_then(Value::as_str) != Some(txid) { r.result = Some(res); r.result_published = false; }
    let (link, sats, out) = (r.link_id.clone(), r.sats.saturating_add(r.fee), r.result.clone().expect("set"));
    s.spends.entry(id.into()).or_insert(Spend { link_id: link.clone(), at: now, sats });
    let to = s.links.iter().find(|l| l.link_id == link).map(|l| l.phone_key.clone()).ok_or("연결 기록이 없어요.")?;
    save(dir, &s)?;
    Ok((to, out))
}
async fn approve_with(rpc: &impl SalesRpc, net: &impl Net, dir: &Path, sk: &[u8; 32], id: &str, fp: &str, passphrase: Option<Text>, now: i64) -> Result<Value, String> {
    // 이미 이 id 로 보낸 것이면 다시 서명하지 않고 같은 결과를 다시 보낸다.
    if let Some(txid) = load(dir)?.requests.get(id).filter(|r| r.status == "sent").and_then(|r| r.txid.clone()) {
        let (to, res) = finish(dir, sk, id, &txid, now)?;
        deliver(net, dir, sk, vec![(to, "result", res)]).await?;
        return Ok(json!({ "txid": txid, "again": true }));
    }
    // 앱 잠금은 IPC 입구에서만 보는 것이 아니다: 여기서 차례 번호를 잡고, 서명 직전·전파 직전에 다시 본다.
    let epoch = crate::app_lock::unlocked_epoch().ok_or(APP_LOCKED)?;
    let key = (dir.to_path_buf(), id.to_string());
    let review = REVIEWS.lock().map_err(|_| "x")?.get(&key).cloned().filter(|v| v.fingerprint == fp && now - v.at < 5 * 60_000).ok_or(CHANGED)?;
    let mut s = load(dir)?;
    let (r, _) = live_request(&s, id, now, review.fee)?;
    // 수수료를 먼저 기록한다 — 보내는 중·결과 모름 상태도 금액+수수료로 한도에 잡힌다.
    if let Some(x) = s.requests.get_mut(id) { x.fee = review.fee; }
    save(dir, &s)?;
    // 보여 준 뒤 동전이 쓰였으면 이 승인은 무효.
    if input_values(rpc, &review.inputs).await.is_none() { REVIEWS.lock().map_err(|_| "x")?.remove(&key); return Err(CHANGED.into()); }
    let intent = format!("link|{}|{}|{}|{}", r.link_id, r.to, r.sats, review.fingerprint).into_bytes();
    let dir_p = payouts(dir);
    let txid = with_unlocked_rpc(rpc, passphrase, || async {
        let guard = match crate::payout_guard::begin(&dir_p, LANE, id, &intent)? {
            crate::payout_guard::Begin::Done(txid) => return Ok(txid),
            crate::payout_guard::Begin::New(g) => g,
        };
        { let mut s = load(dir)?; if let Some(x) = s.requests.get_mut(id) { x.status = "sending".into(); } save(dir, &s)?; }
        let back_to_pending = || -> Result<(), String> { let mut s = load(dir)?; if let Some(x) = s.requests.get_mut(id) { x.status = "pending".into(); } save(dir, &s) };
        if !crate::app_lock::still_unlocked(epoch) { guard.abandon_unsent()?; back_to_pending()?; return Err(APP_LOCKED.to_string()); }
        let signed = match rpc.call("signrawtransaction", json!([review.hex.clone()])).await {
            Ok(v) if v.get("complete") == Some(&json!(true)) && v.get("hex").and_then(Value::as_str).is_some() => v["hex"].as_str().unwrap_or("").to_string(),
            _ => {
                // 서명조차 못 했으면 아무것도 나가지 않았다 — 기록을 풀고 대기로 되돌린다.
                guard.abandon_unsent()?;
                back_to_pending()?;
                return Err("서명하지 못했어요. 지갑 잠금과 노드 상태를 확인해 주세요.".to_string());
            }
        };
        let txid = rpc.call("decoderawtransaction", json!([signed])).await.ok().and_then(|v| v.get("txid").and_then(Value::as_str).map(str::to_string));
        // 서명한 거래는 아직 이 컴퓨터 안에만 있다. 그사이 잠겼으면 버리고 아무것도 내보내지 않는다.
        if !crate::app_lock::still_unlocked(epoch) { guard.abandon_unsent()?; back_to_pending()?; return Err(APP_LOCKED.to_string()); }
        match rpc.call("sendrawtransaction", json!([signed])).await {
            Ok(v) if v.as_str().is_some_and(hex64) => { let t = v.as_str().unwrap_or("").to_string(); guard.complete(&t)?; Ok(t) }
            other => {
                // 나갔는지 모른다면 지갑에 그 거래가 있는지 본다. 있으면 보낸 것, 없으면 기록을 잠근 채 둔다(다시 보내지 않는다).
                if let Some(t) = txid.filter(|t| hex64(t)) {
                    if rpc.call("gettransaction", json!([t])).await.is_ok() { guard.complete(&t)?; return Ok(t); }
                }
                let mut s = load(dir)?; if let Some(x) = s.requests.get_mut(id) { x.status = "unknown".into(); } save(dir, &s)?;
                Err(match other { Err(e) => format!("보냈는지 확인하지 못했어요. 다시 보내지 말고 거래 내역을 확인해 주세요. ({})", e.chars().take(120).collect::<String>()), _ => "보냈는지 확인하지 못했어요. 다시 보내지 말고 거래 내역을 확인해 주세요.".into() })
            }
        }
    }).await?;
    REVIEWS.lock().map_err(|_| "x")?.remove(&key);
    crate::refund::remember_ours(&txid);
    let (to, res) = finish(dir, sk, id, &txid, now)?;
    deliver(net, dir, sk, vec![(to, "result", res)]).await?;
    Ok(json!({ "txid": txid }))
}
#[tauri::command]
pub async fn wallet_link_approve(id: String, fingerprint: String, passphrase: Option<String>) -> Result<Value, String> {
    let passphrase = passphrase.map(Text);
    let _gate = GATE.lock().await;
    let sk = link_secret()?;
    approve_with(&crate::sales_account::NativeRpc, &Relays, &dir(), &sk.0, &id, &fingerprint, passphrase, now_ms()).await
}
async fn refuse_with(net: &impl Net, dir: &Path, sk: &[u8; 32], id: &str) -> Result<(), String> {
    let mut s = load(dir)?;
    let r = s.requests.get_mut(id).filter(|r| r.status == "pending").ok_or("이미 처리했거나 없는 요청이에요.")?;
    let res = sign_body("result", json!({"v": 1, "linkId": r.link_id, "id": id, "refused": "refused"}), sk)?;
    r.status = "refused".into();
    r.refused = Some("refused".into());
    r.result = Some(res.clone());
    let to = s.links.iter().find(|l| l.link_id == r.link_id).map(|l| l.phone_key.clone()).unwrap_or_default();
    save(dir, &s)?;
    REVIEWS.lock().map_err(|_| "x")?.remove(&(dir.to_path_buf(), id.to_string()));
    if hex64(&to) { deliver(net, dir, sk, vec![(to, "result", res)]).await?; }
    Ok(())
}
#[tauri::command]
pub async fn wallet_link_refuse(id: String) -> Result<(), String> {
    let _gate = GATE.lock().await;
    let sk = link_secret()?;
    refuse_with(&Relays, &dir(), &sk.0, &id).await
}
async fn revoke_with(net: &impl Net, dir: &Path, sk: &[u8; 32], link_id: &str, now: i64) -> Result<(), String> {
    let mut s = load(dir)?;
    let l = s.links.iter_mut().find(|l| l.link_id == link_id && !l.revoked).ok_or("이미 끊었거나 없는 연결이에요.")?;
    let rv = sign_body("revoke", json!({"v": 1, "linkId": link_id, "at": now}), sk)?;
    l.revoked = true;
    l.revoked_at = Some(now);
    l.revoke_out = Some(rv.clone());
    let to = l.phone_key.clone();
    cancel_pending(&mut s, link_id);
    // 끊었다는 기록이 먼저다. 폰에 못 알렸어도 이 컴퓨터는 더는 요청을 받지 않는다(다음 확인 때 다시 알린다).
    save(dir, &s)?;
    deliver(net, dir, sk, vec![(to, "revoke", rv)]).await
}
#[tauri::command]
pub async fn wallet_link_revoke(link_id: String) -> Result<(), String> {
    let _gate = GATE.lock().await;
    let sk = link_secret()?;
    revoke_with(&Relays, &dir(), &sk.0, &link_id, now_ms()).await
}
/// 연결을 끊지 않고 하루 한도만 바꾼다(올리기·낮추기·한도 없음). 이미 나간 오늘 몫은 그대로 센다.
fn set_limit_in(dir: &Path, link_id: &str, daily_rvn: &str, now: i64) -> Result<Value, String> {
    let daily = parse_rvn(daily_rvn).filter(|d| *d >= 1 && *d <= DAILY_MAX_SATS).ok_or(LIMIT_BAD)?;
    let mut s = load(dir)?;
    let l = s.links.iter_mut().find(|l| l.link_id == link_id && !l.revoked).ok_or("이미 끊었거나 없는 연결이에요.")?;
    l.daily_sats = daily;
    save(dir, &s)?;
    view(dir, now)
}
/// 🔴 돈이 나갈 수 있는 크기를 바꾸므로 연결 QR 을 만들 때와 같은 암호 재인증(이미 열려 있어도)을 거친다.
#[tauri::command]
pub async fn wallet_link_set_limit(link_id: String, daily_rvn: String, passphrase: String) -> Result<Value, String> {
    let passphrase = Text(passphrase);
    let _gate = GATE.lock().await;
    // 숫자가 틀렸으면 암호를 묻기 전에 바로 알린다(지갑을 열었다 잠그는 수고를 아낀다).
    parse_rvn(&daily_rvn).filter(|d| *d >= 1 && *d <= DAILY_MAX_SATS).ok_or(LIMIT_BAD)?;
    reveal_main_with(&crate::sales_account::NativeRpc, passphrase).await?;
    set_limit_in(&dir(), &link_id, &daily_rvn, now_ms())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;
    use std::collections::VecDeque;

    fn vectors() -> Value { serde_json::from_str(include_str!("../../scripts/fixtures/wallet-link-vectors.json")).unwrap() }
    fn key(v: &Value, k: &str) -> [u8; 32] { hex::decode(v[k].as_str().unwrap()).unwrap().try_into().unwrap() }
    fn tmp(name: &str) -> PathBuf {
        static N: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let d = std::env::temp_dir().join(format!("rv-wallet-link-{name}-{}-{}-{}", std::process::id(), now_ms(), N.fetch_add(1, std::sync::atomic::Ordering::SeqCst)));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }
    fn offer_of(v: &Value) -> Offer { serde_json::from_value(v["offer"].clone()).unwrap() }

    #[test]
    fn digests_signatures_ids_and_codes_match_the_phone_typescript() {
        let v = vectors();
        for d in v["digests"].as_array().unwrap() {
            assert_eq!(hex::encode(digest(d["tag"].as_str().unwrap(), &d["body"]).unwrap()), d["hex"].as_str().unwrap());
        }
        let o = offer_of(&v);
        let phone = v["phoneKey"].as_str().unwrap();
        assert_eq!(link_id(&o.desktop_key, phone, &o.nonce), v["linkId"].as_str().unwrap());
        assert_eq!(confirm_code(&o, phone).unwrap(), v["code"].as_str().unwrap());
        assert_eq!(pubkey_of(&key(&v, "deskSecret")).unwrap(), v["deskKey"].as_str().unwrap());
        let a = verify_accept(&v["accept"], &o).expect("phone accept verifies");
        assert_eq!(a.phone_addresses, vec![v["phoneAddress"].as_str().unwrap().to_string()]);
        let mut tampered = v["accept"].clone();
        tampered["body"]["phoneAddresses"] = json!([v["addresses"][0]["address"]]);
        assert!(verify_accept(&tampered, &o).is_none(), "tampered addresses");
        let mut other = o.clone();
        other.nonce = "cd".repeat(32);
        assert!(verify_accept(&v["accept"], &other).is_none(), "other offer");
        assert!(verify_body("result", &v["result"], v["deskKey"].as_str().unwrap()), "TS-signed desktop result verifies here");
        assert!(verify_revoke(&v["revoke"], phone, v["linkId"].as_str().unwrap()));
        assert!(!verify_revoke(&v["revoke"], v["deskKey"].as_str().unwrap(), v["linkId"].as_str().unwrap()));
        // 여기서 서명한 결과: 같은 다이제스트(위에서 확인)·표준 BIP340 이라 폰 verifyLinkResult 가 받는다.
        let mine = sign_body("result", v["result"]["body"].clone(), &key(&v, "deskSecret")).unwrap();
        assert!(verify_body("result", &mine, v["deskKey"].as_str().unwrap()));
    }

    #[test]
    fn requests_are_checked_like_check_link_request() {
        let v = vectors();
        let now = v["now"].as_i64().unwrap();
        let link = Link { link_id: v["linkId"].as_str().unwrap().into(), phone_key: v["phoneKey"].as_str().unwrap().into(),
            phone_addresses: vec![v["phoneAddress"].as_str().unwrap().into()], name: "폰".into(), daily_sats: DAILY_MAX_SATS,
            created: now, revoked: false, revoked_at: None, revoke_out: None };
        assert_eq!(check_request(&v["requestFill"], &link, now + 1000, false, 0).0, Check::Ok("fill"));
        assert_eq!(check_request(&v["requestSend"], &link, now, false, 0).0, Check::Ok("send"));
        let mut forged = v["requestFill"].clone();
        forged["body"]["sats"] = json!("90000000000");
        assert_eq!(check_request(&forged, &link, now, false, 0).0, Check::No("signature"));
        assert_eq!(check_request(&v["requestFill"], &link, now + 700_000, false, 0).0, Check::No("expired"));
        assert_eq!(check_request(&v["requestFill"], &link, now, true, 0).0, Check::No("seen"));
        assert_eq!(check_request(&v["requestFill"], &Link { revoked: true, ..link.clone() }, now, false, 0).0, Check::No("revoked"));
        assert_eq!(check_request(&v["requestFill"], &link, now, false, DAILY_MAX_SATS - 1).0, Check::No("daily-limit"));
        assert_eq!(check_request(&v["requestFill"], &link, now, false, u64::MAX).0, Check::No("daily-limit"), "no overflow");
    }

    #[test]
    fn nip44_and_gift_wraps_interoperate_with_the_phone() {
        let v = vectors();
        let desk = key(&v, "deskSecret");
        let n = &v["nip44"];
        let ck = conv_key(&desk, v["phoneKey"].as_str().unwrap()).unwrap();
        assert_eq!(hex::encode(ck), n["convKey"].as_str().unwrap());
        let nonce: [u8; 32] = hex::decode(n["nonce"].as_str().unwrap()).unwrap().try_into().unwrap();
        assert_eq!(nip44_encrypt(n["plain"].as_str().unwrap(), &ck, nonce).unwrap(), n["payload"].as_str().unwrap());
        assert_eq!(nip44_decrypt(n["payload"].as_str().unwrap(), &ck).unwrap(), n["plain"].as_str().unwrap());
        for p in n["paddedLengths"].as_array().unwrap() { assert_eq!(padded_len(p[0].as_u64().unwrap() as usize), p[1].as_u64().unwrap() as usize); }
        for g in v["gifts"].as_array().unwrap() {
            let (from, t, s) = open(&desk, &g["event"]).expect("phone gift opens");
            assert_eq!(from, v["phoneKey"].as_str().unwrap());
            assert_eq!(t, g["t"].as_str().unwrap());
            assert!(s.get("sig").is_some());
            assert!(open(&key(&v, "phoneSecret"), &g["event"]).is_none(), "only the recipient opens");
        }
        // 데스크탑 → 폰 겉봉: 폰 열쇠로만 열리고 보낸 이는 데스크탑 연결 키.
        let ev = pack(&desk, v["phoneKey"].as_str().unwrap(), "result", &v["result"]).unwrap();
        crate::nostrpub::validate_publish_event(&ev).expect("relay proxy accepts the wrap");
        let (from, t, s) = open(&key(&v, "phoneSecret"), &ev).unwrap();
        assert_eq!((from.as_str(), t.as_str()), (v["deskKey"].as_str().unwrap(), "result"));
        assert_eq!(s, v["result"]);
        assert!(open(&desk, &ev).is_none());
    }

    #[test]
    fn account_zero_xpub_and_receive_addresses_match_the_phone() {
        let v = vectors();
        let restore: Value = serde_json::from_str(include_str!("../../scripts/fixtures/restore-vectors.json")).unwrap();
        let src = &restore["vectors"][v["seedFixtureIndex"].as_u64().unwrap() as usize];
        let seed = crate::identity::seed_from_words(src["mnemonic"].as_str().unwrap(), src["passphrase"].as_str().unwrap()).unwrap();
        let xpub = crate::sales_account::account_xpub_at(&seed, 0).unwrap();
        assert_eq!(xpub, v["xpub"].as_str().unwrap());
        for a in v["addresses"].as_array().unwrap() { assert_eq!(receive_address(&xpub, a["index"].as_u64().unwrap() as u32).unwrap(), a["address"].as_str().unwrap()); }
        assert_eq!(crate::sales_account::account_xpub_at(&seed, 100), crate::sales_account::account_xpub(&seed), "sales account unchanged");
        assert!(receive_address(crate::sales_account::account_xpub(&seed).as_deref().unwrap(), 0).is_none(), "only account 0'");
    }

    // ── 가짜 노드·릴레이 ──
    struct Mock { replies: RefCell<HashMap<String, VecDeque<Result<Value, String>>>>, calls: RefCell<Vec<String>>, lock_on: RefCell<Option<&'static str>> }
    impl Mock {
        fn new(rows: Vec<(&str, Result<Value, String>)>) -> Self {
            let mut m: HashMap<String, VecDeque<_>> = HashMap::new();
            for (k, v) in rows { m.entry(k.into()).or_default().push_back(v); }
            Mock { replies: RefCell::new(m), calls: RefCell::new(vec![]), lock_on: RefCell::new(None) }
        }
        fn count(&self, m: &str) -> usize { self.calls.borrow().iter().filter(|c| *c == m).count() }
    }
    impl SalesRpc for Mock {
        async fn call(&self, method: &str, _p: Value) -> Result<Value, String> {
            self.calls.borrow_mut().push(method.into());
            // 이 부름이 도는 사이 앱이 잠겼다고 친다(시험 실의 메모리 잠금).
            if *self.lock_on.borrow() == Some(method) { crate::app_lock::lock_in_memory_for_test(); }
            let mut r = self.replies.borrow_mut();
            let q = r.get_mut(method).unwrap_or_else(|| panic!("unexpected RPC {method}"));
            if q.len() > 1 { q.pop_front().unwrap() } else { q.front().cloned().unwrap() }
        }
    }
    #[derive(Default)]
    struct FakeNet { inbox: Vec<Value>, sent: RefCell<Vec<Value>>, incomplete: bool }
    impl Net for FakeNet {
        async fn publish(&self, e: Value) -> Result<(), String> { self.sent.borrow_mut().push(e); Ok(()) }
        async fn fetch(&self, _p: &str, _s: i64) -> Result<(Vec<Value>, bool), String> { Ok((self.inbox.clone(), !self.incomplete)) }
    }

    #[tokio::test]
    async fn offer_requires_reauth_even_when_unlocked_and_checks_the_address_is_ours() {
        let v = vectors();
        let restore: Value = serde_json::from_str(include_str!("../../scripts/fixtures/restore-vectors.json")).unwrap();
        let words = json!({"word_list": restore["vectors"][0]["mnemonic"], "passphrase": restore["vectors"][0]["passphrase"]});
        for (mine, ok) in [(true, true), (false, false)] {
            let rpc = Mock::new(vec![("getwalletinfo", Ok(json!({"unlocked_until": 9999999999i64}))), ("walletlock", Ok(Value::Null)),
                ("walletpassphrase", Ok(Value::Null)), ("getmywords", Ok(words.clone())),
                ("validateaddress", Ok(json!({"isvalid": true, "ismine": mine, "hdkeypath": "m/44'/175'/0'/0/0"})))]);
            let r = reveal_main_with(&rpc, Text("x".into())).await;
            assert_eq!(r.is_ok(), ok);
            if ok { assert_eq!(r.unwrap(), (v["xpub"].as_str().unwrap().to_string(), v["addresses"][0]["address"].as_str().unwrap().to_string())); }
            // 이미 열려 있어도 잠그고 암호로 다시 연 뒤, 단어를 읽고 다시 잠근다 — 그다음에야 주소를 묻는다.
            assert_eq!(*rpc.calls.borrow(), ["getwalletinfo", "walletlock", "walletpassphrase", "getmywords", "walletlock", "validateaddress"]);
        }
        let rpc = Mock::new(vec![("getwalletinfo", Ok(json!({"unlocked_until": 0}))), ("walletlock", Ok(Value::Null)), ("walletpassphrase", Err("bad".into()))]);
        assert_eq!(reveal_main_with(&rpc, Text("x".into())).await.unwrap_err(), AUTH_ERROR);
        assert_eq!(rpc.calls.borrow().last().unwrap(), "walletlock", "relocked after failure");
    }

    fn linked_dir(v: &Value, name: &str) -> PathBuf {
        let d = tmp(name);
        let o = offer_of(v);
        let mut sess = Session { xpub: o.xpub.clone(), first: o.first_address.clone(), name: o.name.clone(), authed: 0, offer: Some(o), candidate: None };
        let accept = v["gifts"].as_array().unwrap().iter().find(|g| g["t"] == "accept").unwrap()["event"].clone();
        process(&d, &key(v, "deskSecret"), &[accept], v["now"].as_i64().unwrap() + 1000, Some(&mut sess)).unwrap();
        assert!(sess.candidate.is_some(), "accept arrived");
        assert!(confirm_in(&d, &sess, "21000000000.00000001", "폰", v["now"].as_i64().unwrap()).is_err(), "cannot go over the total supply");
        confirm_in(&d, &sess, "1000", "폰", v["now"].as_i64().unwrap()).unwrap();
        d
    }
    fn gift(v: &Value, t: &str, n: usize) -> Value { v["gifts"].as_array().unwrap().iter().filter(|g| g["t"] == t).nth(n).unwrap()["event"].clone() }
    fn chain_rpc(v: &Value, unlocked: bool) -> Mock {
        let to = v["phoneAddress"].as_str().unwrap();
        Mock::new(vec![
            ("listreceivedbyaddress", Ok(json!([{"address": "RChangeAddrXXXXXXXXXXXXXXXXXXXXXX"}]))),
            ("createrawtransaction", Ok(json!("00"))),
            ("fundrawtransaction", Ok(json!({"hex": "0200aa", "fee": 0.0100, "changepos": 1}))),
            ("decoderawtransaction", Ok(json!({"txid": "bb".repeat(32), "vin": [{"txid": "cc".repeat(32), "vout": 0}],
                "vout": [{"value": 200.0, "scriptPubKey": {"addresses": [to]}}, {"value": 49.99, "scriptPubKey": {"addresses": ["RChangeAddrXXXXXXXXXXXXXXXXXXXXXX"]}}]}))),
            ("validateaddress", Ok(json!({"ismine": true}))),
            ("gettxout", Ok(json!({"value": 250.0}))),
            ("getwalletinfo", Ok(json!({"unlocked_until": if unlocked { 99 } else { 0 }}))),
            ("walletpassphrase", Ok(Value::Null)), ("walletlock", Ok(Value::Null)),
            ("signrawtransaction", Ok(json!({"hex": "0200ff", "complete": true}))),
            ("sendrawtransaction", Ok(json!("bb".repeat(32)))),
        ])
    }

    #[tokio::test]
    async fn a_request_is_persisted_before_signing_and_never_signed_twice() {
        let v = vectors();
        let (now, desk) = (v["now"].as_i64().unwrap() + 2000, key(&v, "deskSecret"));
        let d = linked_dir(&v, "idem");
        let net = FakeNet { inbox: vec![gift(&v, "request", 0)], ..Default::default() };
        let view1 = inbox_with(&net, &d, &desk, now).await.unwrap();
        assert_eq!(view1["pending"].as_array().unwrap().len(), 1);
        let rid = "11".repeat(32);
        // 화면에 보이기 전에 디스크에 있다.
        let disk = load(&d).unwrap();
        assert!(disk.seen.contains_key(&rid) && disk.requests[&rid].status == "pending");
        // 같은 겉봉이 또 와도 두 번 띄우지 않는다.
        assert_eq!(inbox_with(&net, &d, &desk, now).await.unwrap()["pending"].as_array().unwrap().len(), 1);

        let rpc = chain_rpc(&v, false);
        let review = review_with(&rpc, &d, &rid, now).await.unwrap();
        assert_eq!((review["kind"].as_str(), review["feeSats"].as_str(), review["totalSats"].as_str()), (Some("fill"), Some("1000000"), Some("20001000000")));
        let fp = review["fingerprint"].as_str().unwrap().to_string();
        assert!(approve_with(&rpc, &net, &d, &desk, &rid, &fp, None, now).await.is_err(), "locked wallet needs the password like a normal send");
        assert_eq!(rpc.count("signrawtransaction"), 0);
        assert!(approve_with(&rpc, &net, &d, &desk, &rid, "00", Some(Text("x".into())), now).await.is_err(), "approval of another transaction is refused");
        let r = approve_with(&rpc, &net, &d, &desk, &rid, &fp, Some(Text("x".into())), now).await.unwrap();
        assert_eq!(r["txid"], json!("bb".repeat(32)));
        assert_eq!((rpc.count("signrawtransaction"), rpc.count("sendrawtransaction")), (1, 1));
        let s = load(&d).unwrap();
        assert_eq!(s.requests[&rid].status, "sent");
        assert_eq!(s.spends[&rid].sats, 20_001_000_000, "spent record = amount + reviewed fee");
        let phone = key(&v, "phoneSecret");
        let last = net.sent.borrow().last().cloned().unwrap();
        let (_, t, res) = open(&phone, &last).unwrap();
        assert_eq!((t.as_str(), res.pointer("/body/txid")), ("result", Some(&json!("bb".repeat(32)))));
        assert!(verify_body("result", &res, v["deskKey"].as_str().unwrap()));

        // 다시 승인을 눌러도 · 같은 요청이 새 겉봉으로 다시 와도: 서명은 그대로 1번, 같은 txid 결과만 다시 간다.
        assert_eq!(approve_with(&rpc, &net, &d, &desk, &rid, &fp, None, now).await.unwrap()["txid"], json!("bb".repeat(32)));
        let mut s = load(&d).unwrap();
        s.wraps.clear();
        save(&d, &s).unwrap();
        let before = net.sent.borrow().len();
        inbox_with(&net, &d, &desk, now).await.unwrap();
        let again = net.sent.borrow()[before..].iter().filter_map(|e| open(&phone, e)).map(|(_, _, s)| s).collect::<Vec<_>>();
        assert_eq!(again, vec![res]);
        assert_eq!(rpc.count("signrawtransaction"), 1);
        assert!(load(&d).unwrap().requests.values().filter(|r| r.status == "pending").count() == 0);
    }

    #[tokio::test]
    async fn an_existing_payout_receipt_is_replayed_without_signing() {
        let v = vectors();
        let (now, desk) = (v["now"].as_i64().unwrap() + 2000, key(&v, "deskSecret"));
        let d = linked_dir(&v, "receipt");
        let net = FakeNet { inbox: vec![gift(&v, "request", 0)], ..Default::default() };
        inbox_with(&net, &d, &desk, now).await.unwrap();
        let rid = "11".repeat(32);
        let rpc = chain_rpc(&v, true);
        let fp = review_with(&rpc, &d, &rid, now).await.unwrap()["fingerprint"].as_str().unwrap().to_string();
        // 앞선 실행이 보내고 꺼진 경우: 지급 기록에 txid 가 있다.
        let intent = format!("link|{}|{}|{}|{}", v["linkId"].as_str().unwrap(), v["phoneAddress"].as_str().unwrap(), 20_000_000_000u64, fp).into_bytes();
        match crate::payout_guard::begin(&payouts(&d), LANE, &rid, &intent).unwrap() {
            crate::payout_guard::Begin::New(g) => g.complete(&"dd".repeat(32)).unwrap(),
            _ => panic!(),
        }
        assert_eq!(approve_with(&rpc, &net, &d, &desk, &rid, &fp, None, now).await.unwrap()["txid"], json!("dd".repeat(32)));
        assert_eq!(rpc.count("signrawtransaction"), 0);
    }

    #[tokio::test]
    async fn spent_coins_invalidate_the_approval() {
        let v = vectors();
        let (now, desk) = (v["now"].as_i64().unwrap() + 2000, key(&v, "deskSecret"));
        let d = linked_dir(&v, "changed");
        let net = FakeNet { inbox: vec![gift(&v, "request", 1)], ..Default::default() };
        let pending = inbox_with(&net, &d, &desk, now).await.unwrap();
        assert_eq!(pending["pending"][0]["kind"], json!("send"), "unregistered address is a plain send");
        let rid = "22".repeat(32);
        let rpc = chain_rpc(&v, true);
        rpc.replies.borrow_mut().insert("decoderawtransaction".into(), VecDeque::from([Ok(json!({"vin": [{"txid": "cc".repeat(32), "vout": 0}],
            "vout": [{"value": 200.0, "scriptPubKey": {"addresses": [v["addresses"][1]["address"]]}}]}))]));
        rpc.replies.borrow_mut().insert("gettxout".into(), VecDeque::from([Ok(json!({"value": 200.01})), Ok(Value::Null)]));
        let fp = review_with(&rpc, &d, &rid, now).await.unwrap()["fingerprint"].as_str().unwrap().to_string();
        assert_eq!(approve_with(&rpc, &net, &d, &desk, &rid, &fp, None, now).await.unwrap_err(), CHANGED);
        assert_eq!(rpc.count("signrawtransaction"), 0);
        assert_eq!(load(&d).unwrap().requests[&rid].status, "pending");
    }

    #[tokio::test]
    async fn expiry_refusal_and_revoke_tell_the_phone_and_drop_pending() {
        let v = vectors();
        let (now, desk, phone) = (v["now"].as_i64().unwrap() + 2000, key(&v, "deskSecret"), key(&v, "phoneSecret"));
        let d = linked_dir(&v, "revoke");
        let net = FakeNet { inbox: vec![gift(&v, "request", 0), gift(&v, "request", 1)], ..Default::default() };
        inbox_with(&net, &d, &desk, now).await.unwrap();
        refuse_with(&net, &d, &desk, &"22".repeat(32)).await.unwrap();
        let (_, _, res) = open(&phone, net.sent.borrow().last().unwrap()).unwrap();
        assert_eq!(res.pointer("/body/refused"), Some(&json!("refused")));
        // 10분이 지나면 남은 요청은 「expired」로 닫힌다.
        let later = FakeNet::default();
        let view = inbox_with(&later, &d, &desk, now + 11 * 60_000).await.unwrap();
        assert!(view["pending"].as_array().unwrap().is_empty());
        let (_, _, exp) = open(&phone, later.sent.borrow().first().unwrap()).unwrap();
        assert_eq!(exp.pointer("/body/refused"), Some(&json!("expired")));
        // 폰이 보낸 끊기(서명 확인) → 끊김.
        let d2 = linked_dir(&v, "revoke2");
        let net2 = FakeNet { inbox: vec![gift(&v, "request", 0), gift(&v, "revoke", 0)], ..Default::default() };
        let view = inbox_with(&net2, &d2, &desk, now).await.unwrap();
        assert_eq!(view["links"][0]["revoked"], json!(true));
        assert!(view["pending"].as_array().unwrap().is_empty());
        // 데스크탑에서 끊기: 서명한 끊기가 폰으로 간다.
        let d3 = linked_dir(&v, "revoke3");
        let net3 = FakeNet::default();
        revoke_with(&net3, &d3, &desk, v["linkId"].as_str().unwrap(), now).await.unwrap();
        let (_, t, rv) = open(&phone, net3.sent.borrow().last().unwrap()).unwrap();
        assert!(t == "revoke" && verify_revoke(&rv, v["deskKey"].as_str().unwrap(), v["linkId"].as_str().unwrap()));
        assert!(load(&d3).unwrap().links[0].revoke_out.is_none(), "delivered");
        for d in [d, d2, d3] { let _ = std::fs::remove_dir_all(d); }
    }

    fn session_of(v: &Value) -> Session {
        let o = offer_of(v);
        Session { xpub: o.xpub.clone(), first: o.first_address.clone(), name: o.name.clone(), authed: 0, offer: Some(o), candidate: None }
    }
    #[test]
    fn a_phone_revoke_before_confirmation_blocks_the_link_in_either_order() {
        let v = vectors();
        let (now, desk) = (v["now"].as_i64().unwrap() + 1000, key(&v, "deskSecret"));
        for order in [["accept", "revoke"], ["revoke", "accept"]] {
            let d = tmp("orphan");
            let mut sess = session_of(&v);
            let gifts: Vec<Value> = order.iter().map(|t| gift(&v, t, 0)).collect();
            // 한 번에 오든, 따로따로 오든.
            for g in &gifts { process(&d, &desk, std::slice::from_ref(g), now, Some(&mut sess)).unwrap(); }
            let s = load(&d).unwrap();
            assert!(s.orphan_revokes.contains_key(v["linkId"].as_str().unwrap()), "revoke kept, not consumed");
            if let Some(_) = &sess.candidate {
                assert_eq!(confirm_in(&d, &sess, "1000", "폰", now).unwrap_err(), PHONE_CANCELLED);
            }
            assert!(load(&d).unwrap().links.is_empty(), "never activated ({order:?})");
            let _ = std::fs::remove_dir_all(d);
        }
        // 위조된 끊기(다른 열쇠 서명)는 남기지 않는다.
        let d = tmp("orphan-forged");
        let mut forged = v["revoke"].clone();
        forged["body"]["at"] = json!(1);
        let ev = pack(&key(&v, "phoneSecret"), v["deskKey"].as_str().unwrap(), "revoke", &forged).unwrap();
        process(&d, &desk, &[ev], now, None).unwrap();
        assert!(load(&d).unwrap().orphan_revokes.is_empty());
    }

    #[tokio::test]
    async fn an_incomplete_inbox_read_does_not_move_the_cursor() {
        let v = vectors();
        let (now, desk) = (v["now"].as_i64().unwrap() + 2000, key(&v, "deskSecret"));
        let d = linked_dir(&v, "cursor");
        let before = load(&d).unwrap().last_fetch;
        let net = FakeNet { incomplete: true, ..Default::default() };
        let out = inbox_with(&net, &d, &desk, now + 3_600_000).await.unwrap();
        assert_eq!((out["complete"].clone(), load(&d).unwrap().last_fetch), (json!(false), before));
        inbox_with(&FakeNet::default(), &d, &desk, now + 3_600_000).await.unwrap();
        assert_eq!(load(&d).unwrap().last_fetch, (now + 3_600_000) / 1000);
    }

    async fn ready_to_approve(v: &Value, name: &str, rpc: &Mock) -> (PathBuf, String, String) {
        let (now, desk) = (v["now"].as_i64().unwrap() + 2000, key(v, "deskSecret"));
        let d = linked_dir(v, name);
        inbox_with(&FakeNet { inbox: vec![gift(v, "request", 0)], ..Default::default() }, &d, &desk, now).await.unwrap();
        let rid = "11".repeat(32);
        let fp = review_with(rpc, &d, &rid, now).await.unwrap()["fingerprint"].as_str().unwrap().to_string();
        (d, rid, fp)
    }
    /// 앱 잠금은 실(thread)마다 따로라 바퀴마다 새 시험으로 돈다.
    async fn lock_mid_approval(when: &'static str, signs: usize) {
        let v = vectors();
        let (now, desk) = (v["now"].as_i64().unwrap() + 2000, key(&v, "deskSecret"));
        let rpc = chain_rpc(&v, true);
        let (d, rid, fp) = ready_to_approve(&v, when, &rpc).await;
        *rpc.lock_on.borrow_mut() = Some(when);
        let net = FakeNet::default();
        assert_eq!(approve_with(&rpc, &net, &d, &desk, &rid, &fp, None, now).await.unwrap_err(), APP_LOCKED);
        assert_eq!((rpc.count("signrawtransaction"), rpc.count("sendrawtransaction")), (signs, 0), "locked during {when}");
        assert_eq!(load(&d).unwrap().requests[&rid].status, "pending");
        assert!(net.sent.borrow().is_empty());
        // 아무것도 안 나갔으므로 지급 기록은 풀려 있다.
        assert!(matches!(crate::payout_guard::begin(&payouts(&d), LANE, &rid, b"x").unwrap(), crate::payout_guard::Begin::New(_)));
        // 잠긴 뒤에는 시작도 안 한다.
        assert_eq!(approve_with(&rpc, &net, &d, &desk, &rid, &fp, None, now).await.unwrap_err(), APP_LOCKED);
        assert_eq!(rpc.count("signrawtransaction"), signs);
        let _ = std::fs::remove_dir_all(d);
    }
    #[tokio::test]
    async fn locking_the_app_before_signing_stops_the_payout() { lock_mid_approval("getwalletinfo", 0).await }
    #[tokio::test]
    async fn locking_the_app_after_signing_stops_the_broadcast() { lock_mid_approval("signrawtransaction", 1).await }

    #[tokio::test]
    async fn the_daily_limit_counts_the_reviewed_fee() {
        let v = vectors();
        let now = v["now"].as_i64().unwrap() + 2000;
        let rpc = chain_rpc(&v, true);
        let d = linked_dir(&v, "feelimit");
        let mut s = load(&d).unwrap();
        s.links[0].daily_sats = 20_000_000_000; // 정확히 요청 금액(200 RVN) — 수수료 0.01 을 더하면 넘는다.
        save(&d, &s).unwrap();
        inbox_with(&FakeNet { inbox: vec![gift(&v, "request", 0)], ..Default::default() }, &d, &key(&v, "deskSecret"), now).await.unwrap();
        assert_eq!(load(&d).unwrap().requests[&"11".repeat(32)].status, "pending", "amount alone fits");
        assert_eq!(review_with(&rpc, &d, &"11".repeat(32), now).await.unwrap_err(), OVER_LIMIT);
        let _ = std::fs::remove_dir_all(d);
    }

    #[test]
    fn a_blank_daily_limit_uses_the_1000_rvn_default() {
        let v = vectors();
        let d = tmp("default-limit");
        let mut sess = session_of(&v);
        process(&d, &key(&v, "deskSecret"), &[gift(&v, "accept", 0)], v["now"].as_i64().unwrap() + 1000, Some(&mut sess)).unwrap();
        let out = confirm_in(&d, &sess, "  ", "폰", v["now"].as_i64().unwrap()).unwrap();
        assert_eq!(out["dailySats"], json!((1_000u64 * 100_000_000).to_string()));
        assert_eq!(load(&d).unwrap().links[0].daily_sats, DAILY_DEFAULT_SATS);
        let _ = std::fs::remove_dir_all(d);
    }

    #[test]
    fn the_daily_limit_can_be_changed_without_unlinking() {
        let v = vectors();
        let now = v["now"].as_i64().unwrap() + 2000;
        let d = linked_dir(&v, "setlimit");
        let lid = v["linkId"].as_str().unwrap();
        // 올리기(1,000 → 50,000) · 낮추기(→ 0.5) — 연결은 그대로 산다.
        let out = set_limit_in(&d, lid, "50,000", now).unwrap();
        assert_eq!(out["links"][0]["dailySats"], json!((50_000u64 * 100_000_000).to_string()));
        set_limit_in(&d, lid, "0.5", now).unwrap();
        assert_eq!(load(&d).unwrap().links[0].daily_sats, 50_000_000);
        assert!(!load(&d).unwrap().links[0].revoked);
        // 최대(총발행량 = 한도 없음)는 되고 넘으면·0·글자는 안 된다. 실패해도 값은 그대로.
        set_limit_in(&d, lid, "21,000,000,000", now).unwrap();
        for bad in ["21000000000.00000001", "21000000001", "99999999999", "0", "0.0", "", "abc", "-5", "1e3"] {
            assert!(set_limit_in(&d, lid, bad, now).is_err(), "{bad}");
        }
        assert_eq!(load(&d).unwrap().links[0].daily_sats, DAILY_MAX_SATS);
        assert!(set_limit_in(&d, &"ee".repeat(32), "10", now).is_err(), "unknown link");
        // 끊은 연결은 바꿀 수 없다.
        let mut s = load(&d).unwrap();
        s.links[0].revoked = true;
        save(&d, &s).unwrap();
        assert!(set_limit_in(&d, lid, "10", now).is_err(), "revoked link");
        assert_eq!(load(&d).unwrap().links[0].daily_sats, DAILY_MAX_SATS);
        let _ = std::fs::remove_dir_all(d);
    }

    #[test]
    fn daily_limit_text_and_link_key_storage() {
        assert_eq!(parse_rvn("100,000"), Some(100_000 * 100_000_000));
        assert_eq!(parse_rvn("21,000,000,000"), Some(DAILY_MAX_SATS));
        assert_eq!(parse_rvn("999999999999"), None, "12 digits");
        assert_eq!(parse_rvn("0.5"), Some(50_000_000));
        assert_eq!(parse_rvn("1.123456789"), None);
        let a = link_secret().unwrap();
        let b = link_secret().unwrap();
        assert_eq!(a.0, b.0, "one dedicated key, created once");
        assert!(pubkey_of(&a.0).is_ok());
    }
}
