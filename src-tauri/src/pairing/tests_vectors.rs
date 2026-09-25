//! 폰(TS)이 만든 시험 벡터를 Rust 가 **바이트까지** 똑같이 만드는가.
//! 파일: `testdata/rv6-pairing-vectors.json` (폰 `core/pairing/vectors.json` 복사본, 합성 키만).

use super::host::*;
use super::proto::*;
use serde_json::{json, Value};

pub(crate) fn vectors() -> Value {
    serde_json::from_str(include_str!("../../testdata/rv6-pairing-vectors.json")).unwrap()
}
fn h32(v: &Value) -> [u8; 32] {
    unhex(v.as_str().unwrap(), "t").unwrap()
}
fn h24(v: &Value) -> [u8; 24] {
    unhex(v.as_str().unwrap(), "t").unwrap()
}
fn h16(v: &Value) -> [u8; 16] {
    unhex(v.as_str().unwrap(), "t").unwrap()
}
fn opts(s: &Value) -> SealOpts {
    SealOpts { nonce: Some(h24(&s["nonce"])), aux: Some(h32(&s["aux"])) }
}

#[test]
fn every_vector_value_matches_the_phone() {
    let v = vectors();
    let sets = v["sets"].as_array().unwrap();
    assert_eq!(sets.len(), 3);
    let mut checked = 0;
    for s in sets {
        let i = &s["inputs"];
        let desk = DeviceKeys::from_secrets(&h32(&i["desk_sign_sk"]), &h32(&i["desk_dh_sk"])).unwrap();
        let phone = DeviceKeys::from_secrets(&h32(&i["phone_sign_sk"]), &h32(&i["phone_dh_sk"])).unwrap();
        let label = s["label"].as_str().unwrap();
        assert_eq!(desk.sign_pub, s["desk"]["sign_pub"], "{label}");
        assert_eq!(desk.dh_pub, s["desk"]["dh_pub"], "{label}");
        assert_eq!(desk.fingerprint(), s["desk"]["fingerprint"], "{label}");
        assert_eq!(phone.sign_pub, s["phone"]["sign_pub"], "{label}");
        assert_eq!(phone.dh_pub, s["phone"]["dh_pub"], "{label}");
        assert_eq!(phone.fingerprint(), s["phone"]["fingerprint"], "{label}");
        checked += 6;

        let code = h16(&i["code"]);
        let relays: Vec<String> = serde_json::from_value(i["relays"].clone()).unwrap();
        let qr = build_pair_qr(&QrInput {
            desk_sign: &desk.sign_pub,
            desk_dh: &desk.dh_pub,
            code_hex: i["code"].as_str().unwrap(),
            expires_at: i["expires_at"].as_i64().unwrap(),
            name: i["desk_name"].as_str().unwrap(),
            lan: i["lan"].as_str(),
            relays: &relays,
        })
        .unwrap();
        assert_eq!(qr, s["qr"], "{label} qr");
        assert_eq!(hex::encode(derive_code_key(&code)), s["code_key"], "{label}");
        assert_eq!(derive_pair_room(&code), s["pair_room"], "{label}");
        let shared_d = derive_shared(desk.dh_secret(), &phone.dh_pub).unwrap();
        let shared_p = derive_shared(phone.dh_secret(), &desk.dh_pub).unwrap();
        assert_eq!(shared_d, shared_p);
        assert_eq!(hex::encode(shared_d), s["shared"], "{label}");
        let tk = TranscriptKeys { desk_sign: &desk.sign_pub, desk_dh: &desk.dh_pub, phone_sign: &phone.sign_pub, phone_dh: &phone.dh_pub };
        let th = derive_transcript(&code, &tk).unwrap();
        assert_eq!(hex::encode(th), s["th"], "{label}");
        let ch = derive_channel_desktop(desk.dh_secret(), &code, &tk).unwrap();
        assert_eq!(hex::encode(ch.ch_key), s["ch_key"], "{label}");
        assert_eq!(ch.ch_room, s["ch_room"], "{label}");
        assert_eq!(ch.sas, s["sas"], "{label}");
        checked += 8;

        let hr = hello_room(&code);
        let cr = Room { key: ch.ch_key, id: ch.ch_room.clone() };
        let perms = Perms::from_value(&i["perms"]).unwrap();

        // HELLO — 폰이 봉한 것. 우리 만들기로 같은 평문 → 같은 이벤트.
        let hs = &s["hello"];
        let hello = build_hello(&Hello {
            phone_sign: phone.sign_pub.clone(),
            phone_dh: phone.dh_pub.clone(),
            name: i["phone_name"].as_str().unwrap().into(),
            want: serde_json::from_value(i["want"].clone()).unwrap(),
            ts: hs["ts"].as_i64().unwrap(),
        })
        .unwrap();
        let (ev, text) = seal_message(&hr, &phone, &hello, hs["ts"].as_i64().unwrap(), opts(hs)).unwrap();
        assert_eq!(text, hs["plaintext"], "{label} hello plaintext");
        assert_eq!(ev.to_value(), hs["event"], "{label} hello event");

        // ACCEPT — 데스크톱이 봉한다.
        let a = &s["accept"];
        let accept = build_accept(&perms, i["desk_name"].as_str().unwrap(), i["lan"].as_str(), &relays, a["ts"].as_i64().unwrap(), 1).unwrap();
        let (ev, text) = seal_message(&cr, &desk, &accept, a["ts"].as_i64().unwrap(), opts(a)).unwrap();
        assert_eq!(text, a["plaintext"], "{label} accept plaintext");
        assert_eq!(ev.to_value(), a["event"], "{label} accept event");

        // REJECT
        let r = &s["reject"];
        let rej = build_reject(hs["event"]["id"].as_str(), Some("code_used")).unwrap();
        let (ev, text) = seal_message(&hr, &desk, &rej, r["ts"].as_i64().unwrap(), opts(r)).unwrap();
        assert_eq!(text, r["plaintext"], "{label} reject plaintext");
        assert_eq!(ev.to_value(), r["event"], "{label} reject event");

        // 요청(폰) — 평문 문자열 그대로 봉해도, 파싱해 다시 만들어도 같아야 한다.
        let q = &s["request"];
        let parsed: Value = serde_json::from_str(q["plaintext"].as_str().unwrap()).unwrap();
        assert_eq!(serde_json::to_string(&parsed).unwrap(), q["plaintext"], "{label} request order kept");
        let msg = parse_channel_message(&parsed, Direction::ToDesktop).unwrap();
        let (ev, _) = seal_message(&cr, &phone, &msg, q["ts"].as_i64().unwrap(), opts(q)).unwrap();
        assert_eq!(ev.to_value(), q["event"], "{label} request event");
        // 그리고 열린다.
        let (_, back) = open_message(&cr, &q["event"]).unwrap();
        assert_eq!(back, parsed);

        // 판정
        let d = authorize(&i["perms"], parsed["t"].as_str().unwrap(), &parsed["body"], 0.0);
        assert_eq!(d.to_value(), s["decision"], "{label} decision");

        // 답(데스크톱)
        let w = &s["answer"];
        let ap: Value = serde_json::from_str(w["plaintext"].as_str().unwrap()).unwrap();
        let built = build_channel_message(ap["t"].as_str().unwrap(), ap["id"].as_str().unwrap(), ap["seq"].as_i64().unwrap(), ap["ts"].as_i64().unwrap(), ap["body"].clone()).unwrap();
        let (ev, text) = seal_message(&cr, &desk, &built, w["ts"].as_i64().unwrap(), opts(w)).unwrap();
        assert_eq!(text, w["plaintext"], "{label} answer plaintext");
        assert_eq!(ev.to_value(), w["event"], "{label} answer event");
        checked += 12;

        // 데스크톱 호스트가 벡터 HELLO 를 받으면 같은 6자리가 뜬다.
        let mut host = Host::default();
        let now = (i["expires_at"].as_i64().unwrap() - QR_TTL_SECONDS) * 1000;
        host.show_qr(&desk, i["desk_name"].as_str().unwrap(), i["lan"].as_str(), &relays, now, code).unwrap();
        match host.receive_hello(&desk, &hs["event"], hs["ts"].as_i64().unwrap(), SealOpts::default()) {
            HelloOutcome::Pending(p) => {
                assert_eq!(p.sas, s["sas"]);
                assert_eq!(p.phone_name, i["phone_name"]);
                assert_eq!(p.fingerprint, s["phone"]["fingerprint"]);
            }
            other => panic!("{label}: {other:?}"),
        }
        // 허락 → 받은 ACCEPT 가 벡터와 같다(고정 nonce/aux).
        let mut book = PeerBook::default();
        let (ev, peer) = host.approve(&desk, &mut book, &perms, i["desk_name"].as_str().unwrap(), i["lan"].as_str(), &relays, a["ts"].as_i64().unwrap(), opts(a)).unwrap();
        assert_eq!(ev.to_value(), a["event"], "{label} host accept event");
        assert_eq!(peer.ch_room, s["ch_room"]);
        // 벡터 요청을 받아 같은 판정.
        let got = receive(&mut book, &desk, &q["event"], q["ts"].as_i64().unwrap(), &|_| 0.0);
        match (&got, s["decision"]["allow"].as_bool().unwrap()) {
            (Received::Accepted { mode, .. }, true) => assert_eq!(*mode, s["decision"]["mode"]),
            (Received::Denied { reason, .. }, false) => assert_eq!(*reason, s["decision"]["reason"]),
            _ => panic!("{label}: {got:?}"),
        }
        checked += 4;
    }
    assert_eq!(checked, 90);
}

#[test]
fn all_18_authorize_cases_match() {
    let v = vectors();
    let cases = v["authorize"].as_array().unwrap();
    assert_eq!(cases.len(), 18);
    for (n, c) in cases.iter().enumerate() {
        let spent = c["spent_today_rvn"].as_f64().unwrap();
        let d = authorize(&c["perms"], c["t"].as_str().unwrap(), &c["body"], spent);
        assert_eq!(d.to_value(), c["expect"], "authorize case {n}: {c}");
    }
}

#[test]
fn low_order_x25519_peers_are_refused() {
    let v = vectors();
    let list = v["x25519_reject_peer_pubs"].as_array().unwrap();
    assert_eq!(list.len(), 5);
    let me = DeviceKeys::generate().unwrap();
    for p in list {
        assert_eq!(derive_shared(me.dh_secret(), p.as_str().unwrap()), Err(PairingError("bad_peer_key")), "{p}");
    }
    // 대문자 hex 는 모양부터 틀렸다.
    assert!(derive_shared(me.dh_secret(), &"AB".repeat(32)).is_err());
    let _ = json!(null);
}

#[test]
fn rvn_to_sats_mirrors_js_tofixed() {
    assert_eq!(rvn_to_sats(40.0), Some(4_000_000_000));
    assert_eq!(rvn_to_sats(40.00000001), Some(4_000_000_001));
    assert_eq!(rvn_to_sats(1e-8), Some(1));
    assert_eq!(rvn_to_sats(0.123456789), None);
    assert_eq!(rvn_to_sats(12.5), Some(1_250_000_000));
    assert_eq!(rvn_to_sats(21e9), Some(2_100_000_000_000_000_000));
    assert_eq!(rvn_to_sats(21e9 + 1.0), None);
    assert_eq!(rvn_to_sats(-1.0), None);
    assert_eq!(rvn_to_sats(0.001953125), None, "exact tie still has 9 decimals");
}

#[test]
fn names_that_disguise_themselves_are_refused() {
    for good in ["Pixel 8", "사장님 맥북", "Kim's PC (2)", "Galaxy S24 / 가게"] {
        assert!(is_valid_name(good), "{good}");
    }
    for bad in ["", " ", " lead", "trail ", "a\u{202e}b", "a\u{200b}b", "a\u{feff}", "a\nb", "a\u{85}b", &"가".repeat(14)] {
        assert!(!is_valid_name(bad), "{bad:?}");
    }
}

#[test]
fn qr_route_rules() {
    assert!(is_lan_relay_url("ws://192.168.0.10:8790/api/relay"));
    assert!(is_lan_relay_url("ws://10.0.0.5:18790/relay"));
    assert!(is_lan_relay_url("ws://172.16.5.1:8790/api/relay"));
    for bad in ["ws://8.8.8.8:8790/api/relay", "ws://192.168.0.10/api/relay", "wss://192.168.0.10:8790/api/relay", "ws://192.168.00.1:8790/relay", "ws://192.168.0.1:08790/relay", "ws://192.168.0.1:8790/x"] {
        assert!(!is_lan_relay_url(bad), "{bad}");
    }
    assert!(is_remote_relay_url("wss://quiet-owl-1234.trycloudflare.com/relay"));
    assert!(is_remote_relay_url("wss://b.example.org:8443/api/relay"));
    for bad in ["wss://relay.damus.io", "wss://relay.damus.io/", "wss://1.2.3.4/relay", "wss://A.example.com/relay", "wss://u@x.example.com/relay", "wss://x.example.com/relay?x=1", "ws://x.example.com/relay", "wss://localhost/relay"] {
        assert!(!is_remote_relay_url(bad), "{bad}");
    }
}
