//! LAN 동기화 ⑦ — 짝 맺기(`/lan/hello`·`/lan/grant`)와 「새 기기 허락」(증서 + 데이터 열쇠 봉투), 가게 키 묶음 서명. 데스크탑(가게 키 PC) 쪽.
//!
//! 규격 = 통합 브랜치 `docs/LAN-REQUEST-SIGNING.md` §7(레인 Y). 폰 쪽 = `phone/screens/deviceSession.ts`(hello → grant → 봉투 보관).
//!   ① 사장이 「폰 연결」을 누르면 1회용 번호(OS 난수 16바이트)를 담은 연결 안내(QR 글 `RVDV1.…`)를 연다 — 10분 뒤 사라진다(메모리에만).
//!   ② 폰이 `/lan/hello` 로 공개키를 보내면 6자리 확인 번호(`pair_code` — 폰 `lanPairCode` 와 같은 값, 벡터 `pairCode`)를 두 화면에 보인다.
//!   ③ 사장이 번호를 맞춰 보고 허락하면 **한 번의 사장 확인**으로 증서 서명 + 봉투 서명(가게 키 두 번)을 묶어서 한다(`with_store_key_bundle`).
//!      데이터 열쇠가 아직 없으면 이때 판 1 을 만든다(`lan_keys::create_data_key`). 새 기기 세션은 같은 판에 **추가만**(결정 L-4).
//!   ④ 폰이 `/lan/grant` 로 증서 + 철회 목록 + 봉투를 받는다.
//!
//! 🔴 lanSync 스위치(기본 꺼짐)를 켜는 코드·화면은 없다(대표 승인 항목). 꺼져 있으면 허락 명령은 「꺼져 있어요」로 끝난다.
//! 🔴 12단어는 `with_store_key_bundle` 안에서 사장 확인 **뒤에** 한 번 읽고 바로 지운다. 데이터 열쇠·세션 열쇠는 keys.json(0600)에만.

#![allow(dead_code)]

use crate::lan_cert::{signed_by, validate_cert_with, verify_revocation_list, DEVICE_CERT_DOMAIN};
use crate::lan_keys::{create_data_key, seal_data_key_os, LanKeyRecord, SessionEntry};
use crate::lan_proof::canonical_string;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

/// 연결 안내 수명(10분).
pub const OFFER_TTL_MS: i64 = 10 * 60_000;
/// 안내 하나에 대기할 수 있는 기기 수.
pub const MAX_PENDING: usize = 8;
pub const DEVICE_NAME_MAX: usize = 40;
pub const OFFER_PREFIX: &str = "RVDV1.";

/// 서명 콜백(32바이트 다이제스트 → compact 64바이트). 여러 번 부를 수 있다(묶음 서명).
pub type BundleSign<'a> = &'a mut dyn FnMut(&[u8; 32]) -> Result<[u8; 64], ()>;

/// 짝 맺기 확인 번호 — 폰 `lanPairCode`: (sha256hex(정본JSON([nonce, 공개키])) 앞 8자리 16진) mod 1,000,000, 6자리.
pub fn pair_code(nonce: &str, device_pub_key: &str) -> String {
    let text = canonical_string(&json!([nonce, device_pub_key])).unwrap_or_default();
    let h = hex::encode(Sha256::digest(text.as_bytes()));
    let n = u32::from_str_radix(&h[..8], 16).unwrap_or(0) % 1_000_000;
    format!("{n:06}")
}

/// 폰이 읽는 연결 안내 글(`readPairOffer`): `RVDV1.` + base64url(정본JSON{v:1, storeId, storeKey, storeName, nonce}). 비밀 값 없음.
pub fn offer_text(store_id: &str, store_key: &str, store_name: &str, nonce: &str) -> Result<String, &'static str> {
    use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
    let name = clean_name(store_name).ok_or("bad-name")?;
    let text = canonical_string(&json!({ "v": 1, "storeId": store_id, "storeKey": store_key, "storeName": name, "nonce": nonce }))?;
    Ok(format!("{OFFER_PREFIX}{}", URL_SAFE_NO_PAD.encode(text.as_bytes())))
}

fn clean_name(name: &str) -> Option<String> {
    let t = name.trim();
    (!t.is_empty() && t.chars().count() <= DEVICE_NAME_MAX && !t.chars().any(char::is_control)).then(|| t.to_string())
}
fn is_nonce(s: &str) -> bool {
    s.len() == 32 && s.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// 대기 중인 기기 하나.
#[derive(Debug, Clone)]
pub struct Pending {
    pub device_pub_key: String,
    pub name: String,
    pub code: String,
    /// 사장이 허락해 낸 증서(있으면 `/lan/grant` 가 준다).
    pub cert: Option<Value>,
}

#[derive(Debug, Clone)]
struct Offer {
    store_id: String,
    nonce: String,
    created_at: i64,
    pending: Vec<Pending>,
}

/// 연결 안내 한 장(메모리). 새로 열면 옛 안내는 사라진다.
#[derive(Debug, Default)]
pub struct PairBook {
    offer: Option<Offer>,
}

impl PairBook {
    /// 안내를 연다(OS 난수 1회용 번호). 돌려주는 번호는 QR 에만 싣는다.
    pub fn open(&mut self, store_id: &str, now: i64) -> String {
        use rand::RngCore;
        let mut b = [0u8; 16];
        rand::rngs::OsRng.fill_bytes(&mut b);
        let nonce = hex::encode(b);
        self.open_with(store_id, &nonce, now);
        nonce
    }
    pub fn open_with(&mut self, store_id: &str, nonce: &str, now: i64) {
        self.offer = Some(Offer { store_id: store_id.into(), nonce: nonce.into(), created_at: now, pending: Vec::new() });
    }
    pub fn close(&mut self) {
        self.offer = None;
    }
    fn live(&self, store_id: &str, nonce: &str, now: i64) -> Option<&Offer> {
        self.offer.as_ref().filter(|o| o.store_id == store_id && is_nonce(nonce) && o.nonce == nonce && now >= o.created_at && now - o.created_at <= OFFER_TTL_MS)
    }
    fn live_any(&self, now: i64) -> Option<&Offer> {
        self.offer.as_ref().filter(|o| now >= o.created_at && now - o.created_at <= OFFER_TTL_MS)
    }
    /// `/lan/hello`. 같은 공개키가 다시 오면 이름만 바꾸고 같은 번호.
    pub fn hello(&mut self, store_id: &str, nonce: &str, device_pub_key: &str, name: &str, now: i64) -> Result<String, &'static str> {
        if self.live(store_id, nonce, now).is_none() {
            return Err("bad-offer");
        }
        if !crate::lan_cert::is_public_key(device_pub_key) {
            return Err("bad-key");
        }
        let name = clean_name(name).ok_or("bad-name")?;
        let Some(o) = self.offer.as_mut() else { return Err("bad-offer") };
        if let Some(p) = o.pending.iter_mut().find(|p| p.device_pub_key == device_pub_key) {
            if p.cert.is_none() {
                p.name = name;
            }
            return Ok(p.code.clone());
        }
        if o.pending.len() >= MAX_PENDING {
            return Err("pair-full");
        }
        let code = pair_code(nonce, device_pub_key);
        o.pending.push(Pending { device_pub_key: device_pub_key.into(), name, code: code.clone(), cert: None });
        Ok(code)
    }
    /// `/lan/grant`: 허락했으면 Some(증서), 아직이면 None. 안내·번호·공개키가 맞지 않으면 bad-offer.
    pub fn granted(&self, store_id: &str, nonce: &str, device_pub_key: &str, now: i64) -> Result<Option<Value>, &'static str> {
        let o = self.live(store_id, nonce, now).ok_or("bad-offer")?;
        let p = o.pending.iter().find(|p| p.device_pub_key == device_pub_key).ok_or("bad-offer")?;
        Ok(p.cert.clone())
    }
    /// 사장 화면: 대기 중인 기기(공개키는 지문 8자리만, 확인 번호, 허락 여부).
    pub fn pending_view(&self, now: i64) -> Vec<Value> {
        let Some(o) = self.live_any(now) else { return Vec::new() };
        o.pending
            .iter()
            .map(|p| {
                let fp = crate::lan_issue::device_id_of(&p.device_pub_key).unwrap_or_default();
                json!({ "name": p.name, "code": p.code, "fingerprint": &fp[..fp.len().min(8)], "approved": p.cert.is_some(), "devicePubKey": p.device_pub_key })
            })
            .collect()
    }
    /// 허락할 수 있는 대기 기기인가(살아 있는 안내 + 아직 허락 전).
    pub fn waiting(&self, device_pub_key: &str, now: i64) -> Option<Pending> {
        self.live_any(now)?.pending.iter().find(|p| p.device_pub_key == device_pub_key && p.cert.is_none()).cloned()
    }
    pub fn mark_approved(&mut self, device_pub_key: &str, cert: Value) -> bool {
        let Some(o) = self.offer.as_mut() else { return false };
        match o.pending.iter_mut().find(|p| p.device_pub_key == device_pub_key) {
            Some(p) => {
                p.cert = Some(cert);
                true
            }
            None => false,
        }
    }
}

// ── 묶음 서명(사장 확인 1회) ────────────────────────────────

/// 한 번의 사장 확인으로 가게 키 서명 여러 개(증서·봉투·목록)를 한다. 순서는 `storesign::sign_flow` 와 같다:
/// 잠금 → 사장 확인(사유) → 12단어 → 가게 비밀 열쇠 → `run`(서명 콜백을 여러 번) → 비밀 열쇠 지우기.
/// 거절하면 단어를 읽지 않는다. 오류 문장은 고정 문장이라 단어·열쇠가 새지 않는다.
pub fn with_store_key_bundle<T, W, C, G>(locked: bool, reason: &str, confirm: C, words: W, run: G) -> Result<T, String>
where
    W: FnOnce() -> Result<(String, String), String>,
    C: FnOnce(&str) -> bool,
    G: FnOnce(BundleSign<'_>) -> Result<T, String>,
{
    use crate::storesign::{ERR_DECLINED, ERR_KEY, ERR_LOCKED};
    if locked {
        return Err(ERR_LOCKED.into());
    }
    if !confirm(reason) {
        return Err(ERR_DECLINED.into());
    }
    let (mut w, mut p) = words()?;
    let sk = crate::storesign::store_secret(&w, &p);
    crate::words::wipe(&mut w);
    crate::words::wipe(&mut p);
    let mut sk = sk.ok_or_else(|| ERR_KEY.to_string())?;
    let Ok(mut secret) = secp256k1::SecretKey::from_byte_array(&sk) else {
        crate::words::wipe_bytes(&mut sk);
        return Err(ERR_KEY.into());
    };
    crate::words::wipe_bytes(&mut sk);
    let secp = secp256k1::Secp256k1::signing_only();
    let mut sign = |d: &[u8; 32]| -> Result<[u8; 64], ()> { Ok(secp.sign_ecdsa(&secp256k1::Message::from_digest(*d), &secret).serialize_compact()) };
    let out = run(&mut sign);
    secret.non_secure_erase();
    out
}

// ── 새 기기 허락 = 증서 + 봉투(같은 판에 세션 추가) ──────────────

/// 허락에 필요한 것. `history` = 이 가게가 낸 증서 전부(Rust 기록 + 화면이 넘긴 것 — 일련번호 중복 금지의 근거).
pub struct ApproveInput<'a> {
    pub store_key: &'a str,
    pub store_id: &'a str,
    /// 지금 열쇠 기록(없으면 판 1 을 새로 만든다).
    pub current: Option<&'a LanKeyRecord>,
    /// 지금 철회 목록(가게 키 서명·24시간 안 — 증서 확인에 쓴다).
    pub list: &'a Value,
    pub history: &'a [Value],
    pub device_pub_key: &'a str,
    pub role: &'a str,
    pub ttl_ms: i64,
    pub now: i64,
}

/// 허락 계획: 증서 발급(일련번호 = 이력 최대 + 1) → (열쇠가 없으면 판 1 생성) → 그 증서 앞 봉투 → 세션 추가한 새 기록.
/// 서명은 `sign` 으로 두 번(증서·봉투). 저장은 호출자가(`devices.json` → `save_rotation`).
pub fn approve_plan(input: &ApproveInput, sign: BundleSign<'_>) -> Result<(Value, LanKeyRecord), &'static str> {
    let info = verify_revocation_list(input.list, input.store_key, input.store_id).map_err(|_| "list")?;
    let mut max_serial = 0u64;
    for c in input.history {
        let (o, v) = validate_cert_with(c, true).map_err(|_| "history")?;
        if v.store_id != input.store_id || !signed_by(DEVICE_CERT_DOMAIN, o, input.store_key) {
            return Err("history");
        }
        max_serial = max_serial.max(v.serial);
    }
    let body = crate::lan_issue::cert_body(input.store_id, input.device_pub_key, input.role, input.now, input.ttl_ms, max_serial + 1).map_err(|_| "cert-shape")?;
    let cert = crate::lan_issue::issue_device_cert(&body, input.store_key, |d| sign(d), input.now, Some(input.list), input.history).map_err(|e| match e {
        crate::lan_issue::IssueError::Verify(r) => r.as_str(),
        crate::lan_issue::IssueError::DuplicateSerial => "duplicate-serial",
        crate::lan_issue::IssueError::Sign(_) => "sign",
        _ => "cert",
    })?;
    let mut record = match input.current {
        Some(r) => r.clone(),
        None => LanKeyRecord {
            data_key: create_data_key(1)?,
            sessions: Default::default(),
            // 처음 만드는 열쇠: 지금 목록의 철회는 이 열쇠보다 먼저 일어난 일이라 모두 「덮였다」(관문 열림).
            revocation_seq: info.seq,
            revoked_at_rotation: info.revoked.clone(),
            revocations: input.list.clone(),
        },
    };
    let (_, c) = validate_cert_with(&cert, true).map_err(|_| "cert")?;
    let (env, session) = seal_data_key_os(&record.data_key, &cert, input.store_key, |d| sign(d)).map_err(|_| "seal")?;
    record.sessions.insert(
        c.cert_id.clone(),
        SessionEntry { key: session, device_id: c.device_id.clone(), cert_sig: cert["sig"].as_str().unwrap_or_default().to_string(), envelope: Some(env) },
    );
    Ok((cert, record))
}

/// 사장 확인창에 보이는 사유(쉬운 말, 80자 이하). 내부 용어(증서·봉투·세션)를 쓰지 않는다.
pub fn approve_reason(name: &str, code: &str) -> String {
    let n: String = name.chars().take(16).collect();
    format!("새 기기 「{n}」 연결 허락 (확인 번호 {code}) — 서명 2번을 한 번에 해요")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::lan_testkit as kit;

    fn vectors() -> Value {
        serde_json::from_str(include_str!("../testdata/rv-lan-v2-vectors.json")).unwrap()
    }

    #[test]
    fn y_pair_codes_match_the_phone() {
        let v = vectors();
        let cases = v["pairCode"].as_array().unwrap();
        assert_eq!(cases.len(), 3);
        for c in cases {
            assert_eq!(pair_code(c["nonce"].as_str().unwrap(), c["devicePubKey"].as_str().unwrap()), c["code"].as_str().unwrap());
        }
    }

    #[test]
    fn y_offer_text_is_what_the_phone_reads() {
        use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
        let t = offer_text(&kit::store_id(), kit::STORE_KEY, " 시험 가게 ", &"0f".repeat(16)).unwrap();
        assert!(t.starts_with("RVDV1."));
        let doc: Value = serde_json::from_slice(&URL_SAFE_NO_PAD.decode(&t[6..]).unwrap()).unwrap();
        assert_eq!(doc, json!({ "v": 1, "storeId": kit::store_id(), "storeKey": kit::STORE_KEY, "storeName": "시험 가게", "nonce": "0f".repeat(16) }));
        assert!(offer_text(&kit::store_id(), kit::STORE_KEY, "", &"0f".repeat(16)).is_err());
        assert!(offer_text(&kit::store_id(), kit::STORE_KEY, &"가".repeat(41), &"0f".repeat(16)).is_err());
    }

    #[test]
    fn y_pair_book_only_answers_the_live_offer() {
        let mut b = PairBook::default();
        let (sid, n) = (kit::store_id(), "0f".repeat(16));
        let pk = kit::remote().pub_hex;
        assert_eq!(b.hello(&sid, &n, &pk, "폰", kit::NOW), Err("bad-offer"), "안내를 열기 전");
        b.open_with(&sid, &n, kit::NOW);
        let code = b.hello(&sid, &n, &pk, "폰", kit::NOW).unwrap();
        assert_eq!(code, pair_code(&n, &pk));
        assert_eq!(b.hello(&sid, &n, &pk, "새 이름", kit::NOW + 1).unwrap(), code, "같은 기기 = 같은 번호");
        assert_eq!(b.hello(&sid, &"11".repeat(16), &pk, "폰", kit::NOW), Err("bad-offer"), "다른 1회용 번호");
        assert_eq!(b.hello(&"cd".repeat(32), &n, &pk, "폰", kit::NOW), Err("bad-offer"), "다른 가게");
        assert_eq!(b.hello(&sid, &n, "02zz", "폰", kit::NOW), Err("bad-key"));
        assert_eq!(b.hello(&sid, &n, &kit::replica().pub_hex, "a\u{0}b", kit::NOW), Err("bad-name"));
        assert_eq!(b.granted(&sid, &n, &pk, kit::NOW), Ok(None), "허락 전 = 대기");
        assert_eq!(b.granted(&sid, &n, &kit::replica().pub_hex, kit::NOW), Err("bad-offer"), "hello 안 한 기기");
        assert!(b.mark_approved(&pk, json!({ "x": 1 })));
        assert_eq!(b.granted(&sid, &n, &pk, kit::NOW), Ok(Some(json!({ "x": 1 }))));
        assert!(b.waiting(&pk, kit::NOW).is_none(), "이미 허락함");
        assert_eq!(b.granted(&sid, &n, &pk, kit::NOW + OFFER_TTL_MS + 1), Err("bad-offer"), "10분 뒤 사라짐");
        // 대기 상한
        let mut b = PairBook::default();
        b.open_with(&sid, &n, kit::NOW);
        for i in 0..MAX_PENDING {
            b.hello(&sid, &n, &kit::dev(0x60 + i as u8, "remote", &["read"], 50 + i as u64).pub_hex, "폰", kit::NOW).unwrap();
        }
        assert_eq!(b.hello(&sid, &n, &kit::dev(0x70, "remote", &["read"], 70).pub_hex, "폰", kit::NOW), Err("pair-full"));
        let view = b.pending_view(kit::NOW);
        assert_eq!(view.len(), MAX_PENDING);
        assert_eq!(view[0]["fingerprint"].as_str().unwrap().len(), 8);
        // OS 난수 안내는 매번 다르다.
        let mut c = PairBook::default();
        assert_ne!(c.open(&sid, kit::NOW), c.open(&sid, kit::NOW));
    }

    const WORDS: &str = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

    #[test]
    fn y_bundle_asks_once_signs_many_and_reads_words_only_after_yes() {
        let asked = std::cell::Cell::new(0);
        let read = std::cell::Cell::new(0);
        let words = || {
            read.set(read.get() + 1);
            Ok((WORDS.to_string(), String::new()))
        };
        let n = with_store_key_bundle(
            false,
            "사유",
            |_| {
                asked.set(asked.get() + 1);
                true
            },
            words,
            |sign| {
                let mut k = 0;
                for i in 0..5u8 {
                    sign(&[i + 1; 32]).map_err(|_| "x".to_string())?;
                    k += 1;
                }
                Ok(k)
            },
        )
        .unwrap();
        assert_eq!((n, asked.get(), read.get()), (5, 1, 1), "확인 1번·단어 1번으로 서명 5번");
        assert_eq!(with_store_key_bundle(true, "사유", |_| true, || Ok((WORDS.into(), String::new())), |_| Ok(())).unwrap_err(), crate::storesign::ERR_LOCKED);
        let r2 = std::cell::Cell::new(false);
        let e = with_store_key_bundle(
            false,
            "사유",
            |_| false,
            || {
                r2.set(true);
                Ok((WORDS.into(), String::new()))
            },
            |_| Ok(()),
        )
        .unwrap_err();
        assert_eq!(e, crate::storesign::ERR_DECLINED);
        assert!(!r2.get(), "거절하면 단어를 읽지 않는다");
        // 묶음 서명이 가게 키(합성 단어의 키)와 같은 서명을 낸다.
        let sk = crate::storesign::store_secret(WORDS, "").unwrap();
        let want = crate::storesign::sign_compact_hex(&sk, &[9u8; 32]).unwrap();
        let got = with_store_key_bundle(false, "사유", |_| true, || Ok((WORDS.into(), String::new())), |sign| Ok(hex::encode(sign(&[9u8; 32]).unwrap()))).unwrap();
        assert_eq!(got, want);
    }

    #[test]
    fn y_approve_issues_a_cert_and_an_envelope_with_one_confirm() {
        let list = kit::list(1, &[]);
        let dev = kit::dev(0x51, "remote", &["read"], 99);
        let history = vec![kit::remote().cert, kit::replica().cert];
        let mut signs = 0;
        let mut sign = |d: &[u8; 32]| {
            signs += 1;
            crate::lan_cert::tests::synth_signer(d)
        };
        // 열쇠가 없을 때: 판 1 을 새로 만들고 세션 하나.
        let input = ApproveInput { store_key: kit::STORE_KEY, store_id: &kit::store_id(), current: None, list: &list, history: &history, device_pub_key: &dev.pub_hex, role: "remote", ttl_ms: crate::lan_issue::DEVICE_CERT_DEFAULT_MS, now: kit::NOW };
        let (cert, rec) = approve_plan(&input, &mut sign).unwrap();
        assert_eq!(signs, 2, "증서 1 + 봉투 1");
        assert_eq!(cert["serial"], 3, "이력 최대(2) + 1");
        assert_eq!(rec.key_version(), 1);
        assert_eq!(rec.sessions.len(), 1);
        rec.check(kit::STORE_KEY, &kit::store_id()).unwrap();
        let (_, c) = validate_cert_with(&cert, true).unwrap();
        let e = &rec.sessions[&c.cert_id];
        assert!(crate::lan_keys::envelope_bound(e.envelope.as_ref().unwrap(), kit::STORE_KEY, &kit::store_id(), &c.cert_id, &c.device_id, 1));
        // 폰이 기기 키로 열면 같은 세션 열쇠·같은 데이터 열쇠(봉투 ECDH 를 기기 쪽에서).
        let env = e.envelope.as_ref().unwrap();
        let eph: [u8; 33] = hex::decode(env["eph"].as_str().unwrap()).unwrap().try_into().unwrap();
        let dpub: [u8; 33] = hex::decode(&dev.pub_hex).unwrap().try_into().unwrap();
        let shared = crate::lan_keys::ecdh_compressed(&dev.sk, &eph).unwrap();
        assert_eq!(crate::lan_keys::session_key_of(&shared, &eph, &dpub), e.key);
        // 열쇠가 있을 때: 같은 판에 세션 추가만(L-4) — 지금 기록보다 뒤로 가지 않는다.
        let cur = kit::record(3, &[kit::remote(), kit::replica()], &list);
        let input = ApproveInput { current: Some(&cur), ..input };
        let (_, rec2) = approve_plan(&input, &mut |d| crate::lan_cert::tests::synth_signer(d)).unwrap();
        assert_eq!(rec2.key_version(), 3);
        assert_eq!(rec2.sessions.len(), 3);
        assert!(rec2.check_against(&cur).is_ok(), "같은 판 추가만");
        assert_eq!(rec2.data_key.key, cur.data_key.key);
        // 낡은 목록·남의 가게 이력·서명기 키 불일치는 거절.
        let stale = kit::list_at(1, kit::NOW - 25 * 3600_000, &[]);
        assert_eq!(approve_plan(&ApproveInput { list: &stale, ..input }, &mut |d| crate::lan_cert::tests::synth_signer(d)).err(), Some("stale-revocation-list"));
        let mut forged = kit::remote().cert;
        forged["serial"] = json!(500);
        assert_eq!(approve_plan(&ApproveInput { history: &[forged], ..input }, &mut |d| crate::lan_cert::tests::synth_signer(d)).err(), Some("history"));
        let wrong = |d: &[u8; 32]| -> Result<[u8; 64], ()> {
            let k = secp256k1::SecretKey::from_byte_array(&[0x33u8; 32]).unwrap();
            Ok(secp256k1::Secp256k1::new().sign_ecdsa(&secp256k1::Message::from_digest(*d), &k).serialize_compact())
        };
        let mut wrong = wrong;
        assert_eq!(approve_plan(&input, &mut wrong).err(), Some("sign"));
        assert!(approve_reason("아주아주아주아주아주아주 긴 이름의 폰", "004205").chars().count() <= crate::storesign::REASON_MAX_CHARS);
    }
}
