//! LAN 동기화 ⑧ — 「기기 끊기」 = 철회 + 데이터 열쇠 회전을 **한 동작으로**. 데스크탑(가게 키 PC) 쪽, Rust 가 직접 한다(열쇠가 웹뷰를 지나지 않는다).
//!
//! 규격 = 통합 브랜치 `docs/LAN-REQUEST-SIGNING.md` §4·§7.5, 폰/코어 `core/device/data-key.ts rotateDataKey`(같은 순서·같은 거절).
//!   ① 끊는 기기의 **모든** 증서를 철회한 새 목록(seq+1) ② 새 데이터 열쇠(OS 난수, 판+1) ③ 남은 유효 기기마다 새 봉투·세션
//!   ④ 서명은 목록 1 + 봉투 N — `lan_pair::with_store_key_bundle` 로 **사장 확인 1번**에 묶는다 ⑤ `lan_mount::save_rotation` 이 원자 저장
//!   (열쇠 기록 임시 파일 → fsync → 이름 바꾸기 → 폴더 fsync → 목록) 하고 켜져 있으면 재료를 한 번에 바꾼다(옛 열쇠·세션은 지워진다).
//!   열쇠 기록이 아직 없으면(같은 와이파이 복사를 한 번도 안 씀 = 나눠 준 열쇠가 없음) 회전할 것이 없다 → 목록만(`ListOnly`).
//!
//! 🔴 철회만 하는 다른 길은 막는다: `lan_mount::update_revocation` 은 열쇠 기록이 덮지 않는 새 철회가 든 목록을 `rotation-required` 로 거절한다.
//!    (그 길로 목록만 바뀌어도 처리기 관문이 503 으로 멈춘다 — 이중 안전.)
//! 🔴 12단어·지갑·.env 는 여기서 열지 않는다(서명은 `sign` 콜백). 시험은 합성 가게 키(0x11)·합성 단어만.

#![allow(dead_code)]

use crate::lan_cert::{sign_doc, signed_by, validate_cert_with, verify_device_cert, verify_revocation_list, CertReason, DEVICE_CERT_DOMAIN, DEVICE_CLOCK_SKEW_MS, DEVICE_REVOKE_DOMAIN, MAX_REVOKED};
use crate::lan_keys::{create_data_key, seal_data_key_os, LanKeyRecord, SessionEntry};
use crate::lan_pair::BundleSign;
use crate::lan_proof::canonical_string;
use serde_json::{json, Value};
use std::collections::BTreeMap;

fn is_sha(s: &str) -> bool {
    s.len() == 64 && s.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// 회전에 필요한 것. `history` = 이 가게가 낸 증서 전부(Rust 기록 + 화면이 넘긴 것). 공개 서명 문서라 비밀이 아니다 — 하나하나 가게 서명을 다시 본다.
pub struct RotateInput<'a> {
    pub store_key: &'a str,
    pub store_id: &'a str,
    /// 지금 열쇠 기록(없으면 목록만).
    pub current: Option<&'a LanKeyRecord>,
    /// 지금 철회 목록(가게 키 서명).
    pub list: &'a Value,
    pub history: &'a [Value],
    pub lost_device_id: &'a str,
    pub now: i64,
}

/// 회전 결과(아직 저장 전).
pub enum RotatePlan {
    /// 새 열쇠 기록(새 목록 동봉) — `save_rotation` 으로 저장.
    Rotated { record: LanKeyRecord, revoked_certs: usize, sealed: usize },
    /// 나눠 준 열쇠가 없어 목록만 — `update_revocation` 으로 저장.
    ListOnly { list: Value, revoked_certs: usize },
}

/// 이력 정리: 모양·가게 서명·같은 가게, 같은 일련번호는 같은 문서만(다르면 거절), 같은 문서 중복은 하나로.
pub fn clean_history(history: &[Value], store_key: &str, store_id: &str) -> Result<Vec<Value>, &'static str> {
    let mut by_serial: BTreeMap<u64, Value> = BTreeMap::new();
    for c in history {
        let (o, v) = validate_cert_with(c, true).map_err(|_| "history")?;
        if v.store_id != store_id || !signed_by(DEVICE_CERT_DOMAIN, o, store_key) {
            return Err("history");
        }
        match by_serial.get(&v.serial) {
            Some(prev) if canonical_string(prev).ok() != canonical_string(c).ok() => return Err("history"),
            Some(_) => {}
            None => {
                by_serial.insert(v.serial, c.clone());
            }
        }
    }
    Ok(by_serial.into_values().collect())
}

/// core `rotateDataKey` 와 같은 순서. 서명은 `sign` 으로 1 + N 번(묶음). 저장은 호출자.
/// 다른 점(결정 Y-5): 지금 목록이 24시간을 넘었어도 거절하지 않는다(미래 시각만 거절) — 잃어버린 폰을 끊는 급한 일에 「먼저 목록을 새로」 단계를
/// 더하지 않으려고. 새 목록은 지금 시각으로 같은 묶음에서 서명되고, 남은 증서 확인은 그 새 목록으로 한다.
pub fn rotate_plan(input: &RotateInput, sign: BundleSign<'_>) -> Result<RotatePlan, &'static str> {
    if !is_sha(input.lost_device_id) || !is_sha(input.store_id) {
        return Err("rotation");
    }
    let info = verify_revocation_list(input.list, input.store_key, input.store_id).map_err(|_| "list")?;
    if info.issued_at > input.now + DEVICE_CLOCK_SKEW_MS {
        return Err("list-time");
    }
    let history = clean_history(input.history, input.store_key, input.store_id)?;
    let lost: Vec<String> = history
        .iter()
        .filter_map(|c| validate_cert_with(c, true).ok().map(|(_, v)| v))
        .filter(|v| v.device_id == input.lost_device_id)
        .map(|v| v.cert_id)
        .collect();
    if lost.is_empty() {
        return Err("unknown-device");
    }
    let mut revoked: Vec<String> = info.revoked.iter().cloned().chain(lost.iter().cloned()).collect();
    revoked.sort();
    revoked.dedup();
    if revoked.len() > MAX_REVOKED {
        return Err("prune-required");
    }
    let body = json!({ "v": 1, "storeId": input.store_id, "seq": info.seq + 1, "revoked": revoked, "issuedAt": input.now, "prunedBefore": info.pruned_before });
    let new_list = sign_doc(DEVICE_REVOKE_DOMAIN, &body, input.store_key, |d| sign(d)).map_err(|_| "sign")?;
    let Some(cur) = input.current else {
        return Ok(RotatePlan::ListOnly { list: new_list, revoked_certs: lost.len() });
    };
    let data_key = create_data_key(cur.key_version() + 1)?;
    if data_key.key == cur.data_key.key {
        return Err("repeated-rng");
    }
    let mut sessions = BTreeMap::new();
    for cert in &history {
        let Ok((_, v)) = validate_cert_with(cert, true) else { continue };
        if v.device_id == input.lost_device_id {
            continue;
        }
        match verify_device_cert(cert, input.store_key, input.now, Some(&new_list), None) {
            Ok(_) => {}
            Err(CertReason::Revoked | CertReason::Expired) => continue,
            Err(r) => return Err(r.as_str()),
        }
        let (env, session) = seal_data_key_os(&data_key, cert, input.store_key, |d| sign(d)).map_err(|_| "seal")?;
        sessions.insert(v.cert_id.clone(), SessionEntry { key: session, device_id: v.device_id, cert_sig: cert["sig"].as_str().unwrap_or_default().to_string(), envelope: Some(env) });
    }
    let sealed = sessions.len();
    let record = LanKeyRecord { data_key, sessions, revocation_seq: info.seq + 1, revoked_at_rotation: revoked, revocations: new_list };
    // 저장 전 자기 확인(§4.2 ③④ + 봉투 묶임). 못 넘으면 저장하지 않는다.
    record.check(input.store_key, input.store_id).map_err(|e| e.code())?;
    Ok(RotatePlan::Rotated { record, revoked_certs: lost.len(), sealed })
}

// ── 사장 화면 문구(쉬운 한국어 — 내부 용어 금지) ───────────────────

/// 확인창 사유(80자 이하): 무엇을 하는지·서명 몇 번을 한 번에 하는지.
pub fn disconnect_reason(device_name: &str, remaining: usize) -> String {
    let n: String = device_name.chars().take(16).collect();
    if remaining == 0 {
        format!("「{n}」 연결 끊기 — 남은 기기가 없어요 (서명 2번을 한 번에 해요)")
    } else {
        format!("「{n}」 연결 끊기 — 남은 기기 {remaining}대에 새 열쇠를 나눠요 (서명 {}번을 한 번에 해요)", remaining + 1)
    }
}

/// 끊기 화면 안내(초안 — 법적 확인 전, `DATA_KEY_NOTES` 와 같은 뜻).
pub const DISCONNECT_COPY: &[(&str, &str)] = &[
    ("confirm-title", "이 기기를 끊을까요?"),
    ("confirm-body", "끊으면 그 기기는 바로 멈춰요. 남은 기기에는 새 열쇠를 나눠 줘요. 확인은 한 번만 하면 돼요."),
    ("done", "기기를 끊고 새 열쇠로 바꿨어요. 남은 기기는 같은 와이파이에서 앱을 열면 새 열쇠를 받아요."),
    ("done-list-only", "기기를 끊었어요. 아직 기기끼리 나눈 열쇠가 없어서 열쇠는 바꿀 필요가 없어요."),
    ("past-data", "이미 그 기기에 복사된 지난 기록은 되돌릴 수 없어요."),
    ("declined", "끊지 않았어요. 사장님이 허락하지 않았어요."),
    ("failed", "끊지 못했어요. 아무것도 바뀌지 않았어요. 다시 해 주세요."),
    ("unknown-device", "이 컴퓨터가 연결해 준 기기가 아니에요. 기기 목록을 다시 확인해 주세요."),
    ("rotation-required", "끊은 기기가 있는데 열쇠를 아직 바꾸지 않아 자동 복사를 멈췄어요. 「끊기」를 다시 눌러 열쇠를 바꿔 주세요."),
    ("list-only-blocked", "기기 끊기는 「끊기」 단추로만 해요. 그래야 남은 기기의 열쇠도 함께 바뀌어요."),
];

/// 오류 코드 → 사장 화면 문장(내부 용어 없이).
pub fn disconnect_say(code: &str) -> &'static str {
    let get = |k: &str| DISCONNECT_COPY.iter().find(|(x, _)| *x == k).map(|(_, v)| *v).unwrap_or("");
    match code {
        "unknown-device" => get("unknown-device"),
        "rotation-required" => get("rotation-required"),
        "declined" => get("declined"),
        _ => get("failed"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::lan_testkit as kit;

    fn synth(d: &[u8; 32]) -> Result<[u8; 64], ()> {
        crate::lan_cert::tests::synth_signer(d)
    }

    #[test]
    fn y_rotation_revokes_every_cert_of_the_device_and_reseals_the_rest() {
        let list = kit::list(1, &[]);
        let (a, b) = (kit::remote(), kit::replica());
        let a2 = kit::dev(0x41, "remote", &["read"], 7); // 같은 기기(0x41)의 두 번째 증서
        let cur = kit::record(3, &[a.clone(), b.clone(), a2.clone()], &list);
        let history = vec![a.cert.clone(), b.cert.clone(), a2.cert.clone(), kit::expired().cert, b.cert.clone()];
        let mut n = 0;
        let mut sign = |d: &[u8; 32]| {
            n += 1;
            synth(d)
        };
        let input = RotateInput { store_key: kit::STORE_KEY, store_id: &kit::store_id(), current: Some(&cur), list: &list, history: &history, lost_device_id: &a.device_id, now: kit::NOW };
        let RotatePlan::Rotated { record, revoked_certs, sealed } = rotate_plan(&input, &mut sign).unwrap() else { panic!("회전이어야") };
        assert_eq!((revoked_certs, sealed), (2, 1), "0x41 의 증서 2개 철회, 남은 유효 기기 1대(만료 기기는 건너뜀)");
        assert_eq!(n, 2, "사장 확인 1번 안에서 서명 2번(목록 1 + 봉투 1)");
        assert_eq!(record.key_version(), 4);
        assert_ne!(record.data_key.key, cur.data_key.key);
        assert_eq!(record.revocation_seq, 2);
        let mut want = vec![a.cert_id.clone(), a2.cert_id.clone()];
        want.sort();
        assert_eq!(record.revoked_at_rotation, want);
        assert_eq!(record.sessions.keys().cloned().collect::<Vec<_>>(), vec![b.cert_id.clone()]);
        // 남은 기기(0x42)가 자기 키로 봉투를 열면 새 데이터 열쇠·같은 세션 열쇠.
        let e = &record.sessions[&b.cert_id];
        let env = e.envelope.as_ref().unwrap();
        let eph: [u8; 33] = hex::decode(env["eph"].as_str().unwrap()).unwrap().try_into().unwrap();
        let bpub: [u8; 33] = hex::decode(&b.pub_hex).unwrap().try_into().unwrap();
        let shared = crate::lan_keys::ecdh_compressed(&b.sk, &eph).unwrap();
        assert_eq!(crate::lan_keys::session_key_of(&shared, &eph, &bpub), e.key);
        // 저장 조건(§4.2) — 지금 기록보다 새 판, 관문 열림.
        record.check(kit::STORE_KEY, &kit::store_id()).unwrap();
        assert!(record.check_against(&cur).is_ok());
        let info = verify_revocation_list(&record.revocations, kit::STORE_KEY, &kit::store_id()).unwrap();
        assert!(crate::lan_keys::rotation_gate_ok(record.revocation_seq, &record.revoked_at_rotation, &info));
    }

    #[test]
    fn y_rotation_refuses_what_core_refuses() {
        let list = kit::list(1, &[]);
        let a = kit::remote();
        let cur = kit::record(3, &[a.clone()], &list);
        let base = RotateInput { store_key: kit::STORE_KEY, store_id: &kit::store_id(), current: Some(&cur), list: &list, history: &[], lost_device_id: &a.device_id, now: kit::NOW };
        let h = [a.cert.clone()];
        let run = |i: &RotateInput| rotate_plan(i, &mut |d| synth(d)).err();
        assert_eq!(run(&RotateInput { history: &h, lost_device_id: &"cd".repeat(32), ..base }), Some("unknown-device"));
        assert_eq!(run(&RotateInput { history: &h, lost_device_id: "x", ..base }), Some("rotation"));
        let future = kit::list_at(1, kit::NOW + 120_000, &[]);
        assert_eq!(run(&RotateInput { history: &h, list: &future, ..base }), Some("list-time"), "미래 목록 = 시계 문제");
        let mut forged = a.cert.clone();
        forged["role"] = json!("staff-pc");
        assert_eq!(run(&RotateInput { history: &[forged], ..base }), Some("history"), "가게 서명이 깨진 이력");
        let same_serial = kit::dev(0x49, "remote", &["read"], 1).cert;
        assert_eq!(run(&RotateInput { history: &[a.cert.clone(), same_serial], ..base }), Some("history"), "같은 번호 다른 문서");
        let mut bad_list = list.clone();
        bad_list["seq"] = json!(5);
        assert_eq!(run(&RotateInput { history: &h, list: &bad_list, ..base }), Some("list"));
        let wrong = |d: &[u8; 32]| -> Result<[u8; 64], ()> {
            let k = secp256k1::SecretKey::from_byte_array(&[0x33u8; 32]).unwrap();
            Ok(secp256k1::Secp256k1::new().sign_ecdsa(&secp256k1::Message::from_digest(*d), &k).serialize_compact())
        };
        let mut wrong = wrong;
        assert_eq!(rotate_plan(&RotateInput { history: &h, ..base }, &mut wrong).err(), Some("sign"));
        // 하루 지난 목록은 받는다(결정 Y-5) — 새 목록은 지금 시각.
        let stale = kit::list_at(1, kit::NOW - 25 * 3600_000, &[]);
        let RotatePlan::Rotated { record, .. } = rotate_plan(&RotateInput { history: &h, list: &stale, ..base }, &mut |d| synth(d)).unwrap() else { panic!() };
        assert_eq!(verify_revocation_list(&record.revocations, kit::STORE_KEY, &kit::store_id()).unwrap().issued_at, kit::NOW);
    }

    #[test]
    fn y_without_a_key_record_it_signs_the_list_only() {
        let list = kit::list(4, &[]);
        let a = kit::remote();
        let mut n = 0;
        let mut sign = |d: &[u8; 32]| {
            n += 1;
            synth(d)
        };
        let input = RotateInput { store_key: kit::STORE_KEY, store_id: &kit::store_id(), current: None, list: &list, history: &[a.cert.clone()], lost_device_id: &a.device_id, now: kit::NOW };
        let RotatePlan::ListOnly { list: l, revoked_certs } = rotate_plan(&input, &mut sign).unwrap() else { panic!("목록만이어야") };
        assert_eq!((n, revoked_certs), (1, 1));
        let info = verify_revocation_list(&l, kit::STORE_KEY, &kit::store_id()).unwrap();
        assert_eq!((info.seq, info.revoked.clone()), (5, vec![a.cert_id.clone()]));
    }

    #[test]
    fn y_owner_copy_is_plain_and_short() {
        for (_, text) in DISCONNECT_COPY {
            for word in ["증서", "봉투", "세션", "회전", "철회", "nonce", "키 판", "rotation"] {
                assert!(!text.contains(word), "내부 용어 「{word}」: {text}");
            }
        }
        for n in [0, 1, 3, 40] {
            let r = disconnect_reason("아주아주아주아주아주아주 긴 이름의 폰", n);
            assert!(r.chars().count() <= crate::storesign::REASON_MAX_CHARS, "{r}");
            assert!(crate::storesign::clean_reason(&r).is_ok());
        }
        assert_eq!(disconnect_say("unknown-device"), DISCONNECT_COPY[7].1);
        assert_eq!(disconnect_say("zzz"), DISCONNECT_COPY[6].1);
    }
}
