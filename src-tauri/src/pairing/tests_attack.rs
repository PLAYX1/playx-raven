//! 「릴레이를 공격자가 잡았다」고 가정한 시험. 릴레이는 글을 바꾸고·다시 보내고·
//! 가짜 연결 요청을 넣을 수 있다. 그래도 돈·키·내용은 못 가져가야 한다.

use super::desk::*;
use super::host::*;
use super::proto::*;
use serde_json::{json, Value};
use std::sync::Mutex;

const T0: i64 = 1_800_000_000_000;
const CODE: [u8; 16] = [7u8; 16];

/// 시험용 폰 — 폰 코어(TS)가 하는 일을 규격대로 흉내 낸다.
struct Phone {
    keys: DeviceKeys,
    room: Option<Room>,
    seq: i64,
}
impl Phone {
    fn new() -> Self {
        Self { keys: DeviceKeys::generate().unwrap(), room: None, seq: 0 }
    }
    fn hello(&mut self, desk: &DeviceKeys, code: &[u8; 16], name: &str, now: i64) -> Value {
        let shared = derive_shared(self.keys.dh_secret(), &desk.dh_pub).unwrap();
        let th = derive_transcript(code, &TranscriptKeys { desk_sign: &desk.sign_pub, desk_dh: &desk.dh_pub, phone_sign: &self.keys.sign_pub, phone_dh: &self.keys.dh_pub }).unwrap();
        let ch = derive_channel_from_shared(&shared, &th);
        self.room = Some(Room { key: ch.ch_key, id: ch.ch_room.clone() });
        let h = build_hello(&Hello { phone_sign: self.keys.sign_pub.clone(), phone_dh: self.keys.dh_pub.clone(), name: name.into(), want: vec!["view".into()], ts: now }).unwrap();
        seal_message(&hello_room(code), &self.keys, &h, now, SealOpts::default()).unwrap().0.to_value()
    }
    fn sas(&self, desk: &DeviceKeys, code: &[u8; 16]) -> String {
        let shared = derive_shared(self.keys.dh_secret(), &desk.dh_pub).unwrap();
        let th = derive_transcript(code, &TranscriptKeys { desk_sign: &desk.sign_pub, desk_dh: &desk.dh_pub, phone_sign: &self.keys.sign_pub, phone_dh: &self.keys.dh_pub }).unwrap();
        derive_channel_from_shared(&shared, &th).sas.clone()
    }
    fn msg_with(&mut self, t: &str, body: Value, now: i64, id: Option<&str>, seq: Option<i64>) -> Value {
        self.seq += 1;
        let id = id.map(String::from).unwrap_or_else(new_request_id);
        let m = build_channel_message(t, &id, seq.unwrap_or(self.seq), now, body).unwrap();
        seal_message(self.room.as_ref().unwrap(), &self.keys, &m, now, SealOpts::default()).unwrap().0.to_value()
    }
    fn msg(&mut self, t: &str, body: Value, now: i64) -> Value {
        self.msg_with(t, body, now, None, None)
    }
    fn open(&self, ev: &ChatEvent) -> Value {
        open_message(self.room.as_ref().unwrap(), &ev.to_value()).unwrap().1
    }
}

fn tmpdir(tag: &str) -> std::path::PathBuf {
    let d = std::env::temp_dir().join(format!("rv6-pair-{tag}-{}-{}", std::process::id(), new_request_id()));
    let _ = std::fs::remove_dir_all(&d);
    d
}

/// 데스크톱 + 연결된 폰 하나.
fn paired(perms: Perms) -> (Desk, Phone, std::path::PathBuf) {
    let dir = tmpdir("desk");
    let mut d = Desk::open(&dir).unwrap();
    let mut p = Phone::new();
    d.host.show_qr(&d.keys, "Office Mac", None, &[], T0, CODE).unwrap();
    let hello = p.hello(&d.keys, &CODE, "Pixel 8", T0 + 1000);
    let w = d.handle_event(&hello, T0 + 1000);
    assert!(matches!(w.as_slice(), [Work::Changed]), "{w:?}");
    let (ev, _) = d.host.approve(&d.keys, &mut d.book, &perms, "Office Mac", None, &[], T0 + 2000, SealOpts::default()).unwrap();
    let acc = p.open(&ev);
    assert_eq!(acc["t"], "accept");
    assert_eq!(acc["seq"], 1);
    (d, p, dir)
}
fn full() -> Perms {
    Perms { view: true, request: true, money: "phone".into(), daily_limit_rvn: 100 }
}
fn published(w: &[Work]) -> Vec<ChatEvent> {
    w.iter().filter_map(|x| if let Work::Publish(e) = x { Some(e.clone()) } else { None }).collect()
}
fn drops(d: &Desk, reason: &str) -> u64 {
    d.drops.get(reason).copied().unwrap_or(0)
}

// ── 1회용 코드 ──────────────────────────────────────────────────────────────

#[test]
fn forged_hello_shows_a_different_sas_and_the_real_phone_gets_code_used() {
    let desk = DeviceKeys::generate().unwrap();
    let mut host = Host::default();
    host.show_qr(&desk, "Office Mac", None, &[], T0, CODE).unwrap();
    // 코드를 엿본 사람이 먼저 보낸다.
    let mut thief = Phone::new();
    let mut real = Phone::new();
    let h = thief.hello(&desk, &CODE, "Pixel 8", T0 + 500);
    let HelloOutcome::Pending(p) = host.receive_hello(&desk, &h, T0 + 500, SealOpts::default()) else { panic!() };
    // 데스크톱에 뜨는 6자리 = 도둑 폰의 6자리, 진짜 폰의 6자리와 다르다 → 사장은 거절한다.
    assert_eq!(p.sas, thief.sas(&desk, &CODE));
    assert_ne!(p.sas, real.sas(&desk, &CODE));
    let rh = real.hello(&desk, &CODE, "Pixel 8", T0 + 900);
    match host.receive_hello(&desk, &rh, T0 + 900, SealOpts::default()) {
        HelloOutcome::Rejected { reason, reply } => {
            assert_eq!(reason, "code_used");
            let (_, v) = open_message(&hello_room(&CODE), &reply.to_value()).unwrap();
            assert_eq!(v["reason"], "code_used");
            assert_eq!(v["re"], rh["id"]);
            assert_eq!(reply.pubkey, desk.sign_pub, "phone only obeys the QR key");
        }
        o => panic!("{o:?}"),
    }
    // 같은 HELLO 를 다시 → replay (코드는 이미 그 HELLO 의 것)
    assert!(matches!(host.receive_hello(&desk, &h, T0 + 950, SealOpts::default()), HelloOutcome::Drop("replay")));
}

#[test]
fn garbage_does_not_burn_the_code() {
    let desk = DeviceKeys::generate().unwrap();
    let mut host = Host::default();
    host.show_qr(&desk, "Office Mac", None, &[], T0, CODE).unwrap();
    let pair_room = derive_pair_room(&CODE);
    let junk = Phone::new();
    // 방은 맞는데 열쇠가 틀린 것(코드를 모르는 사람)
    let wrong = Room { key: [9u8; 32], id: pair_room.clone() };
    let h = build_hello(&Hello { phone_sign: junk.keys.sign_pub.clone(), phone_dh: junk.keys.dh_pub.clone(), name: "x".into(), want: vec![], ts: T0 }).unwrap();
    let ev = seal_message(&wrong, &junk.keys, &h, T0, SealOpts::default()).unwrap().0.to_value();
    assert!(matches!(host.receive_hello(&desk, &ev, T0, SealOpts::default()), HelloOutcome::Drop("decrypt_failed")));
    // 열쇠는 맞는데 HELLO 모양이 아닌 것
    let ev = seal_message(&hello_room(&CODE), &junk.keys, &json!({ "v": 1, "t": "hello" }), T0, SealOpts::default()).unwrap().0.to_value();
    assert!(matches!(host.receive_hello(&desk, &ev, T0, SealOpts::default()), HelloOutcome::Drop("bad_hello")));
    // 보낸 키 ≠ phone_sign
    let other = Phone::new();
    let h = build_hello(&Hello { phone_sign: other.keys.sign_pub.clone(), phone_dh: other.keys.dh_pub.clone(), name: "x".into(), want: vec![], ts: T0 }).unwrap();
    let ev = seal_message(&hello_room(&CODE), &junk.keys, &h, T0, SealOpts::default()).unwrap().0.to_value();
    assert!(matches!(host.receive_hello(&desk, &ev, T0, SealOpts::default()), HelloOutcome::Drop("sender_mismatch")));
    // 저차수 X25519 키를 든 HELLO
    let h = build_hello(&Hello { phone_sign: junk.keys.sign_pub.clone(), phone_dh: "00".repeat(32), name: "x".into(), want: vec![], ts: T0 }).unwrap();
    let ev = seal_message(&hello_room(&CODE), &junk.keys, &h, T0, SealOpts::default()).unwrap().0.to_value();
    assert!(matches!(host.receive_hello(&desk, &ev, T0, SealOpts::default()), HelloOutcome::Drop("bad_peer_key")));
    // 서명 틀린 것
    let mut bad = ev.clone();
    bad["sig"] = json!("0".repeat(128));
    assert!(matches!(host.receive_hello(&desk, &bad, T0, SealOpts::default()), HelloOutcome::Drop("bad_event")));
    // 그래도 진짜 폰은 아직 연결된다.
    let mut real = Phone::new();
    let rh = real.hello(&desk, &CODE, "Pixel 8", T0 + 1);
    assert!(matches!(host.receive_hello(&desk, &rh, T0 + 1, SealOpts::default()), HelloOutcome::Pending(_)));
}

#[test]
fn expired_code_and_new_qr_void_the_old_one() {
    let desk = DeviceKeys::generate().unwrap();
    let mut host = Host::default();
    host.show_qr(&desk, "Office Mac", None, &[], T0, CODE).unwrap();
    let mut p = Phone::new();
    let late = T0 + (QR_TTL_SECONDS * 1000) + 1000;
    let h = p.hello(&desk, &CODE, "Pixel 8", late);
    match host.receive_hello(&desk, &h, late, SealOpts::default()) {
        HelloOutcome::Rejected { reason, .. } => assert_eq!(reason, "expired"),
        o => panic!("{o:?}"),
    }
    // 만료 + 5분이 지나면 코드 자체를 지운다 → 방도 모른다.
    let gone = T0 + QR_TTL_SECONDS * 1000 + CODE_GRACE_MS + 1;
    assert_eq!(host.pair_room(gone), None);
    // 새 QR 이 옛 코드를 없앤다.
    host.show_qr(&desk, "Office Mac", None, &[], T0, CODE).unwrap();
    host.show_qr(&desk, "Office Mac", None, &[], T0, [8u8; 16]).unwrap();
    let h = p.hello(&desk, &CODE, "Pixel 8", T0 + 10);
    assert!(matches!(host.receive_hello(&desk, &h, T0 + 10, SealOpts::default()), HelloOutcome::Drop("unknown_room")));
    // 허락 대기 5분이 지나면 허락할 수 없고 reject/expired 가 나간다.
    let mut host = Host::default();
    host.show_qr(&desk, "Office Mac", None, &[], T0, CODE).unwrap();
    let h = p.hello(&desk, &CODE, "Pixel 8", T0 + 10);
    assert!(matches!(host.receive_hello(&desk, &h, T0 + 10, SealOpts::default()), HelloOutcome::Pending(_)));
    let mut book = PeerBook::default();
    let late = T0 + 10 + PENDING_APPROVAL_MS + 1;
    assert_eq!(host.approve(&desk, &mut book, &Perms::default(), "Office Mac", None, &[], late, SealOpts::default()).unwrap_err().0, "pending_expired");
    let ev = host.expire_pending(&desk, late).expect("reject/expired");
    let (_, v) = open_message(&hello_room(&CODE), &ev.to_value()).unwrap();
    assert_eq!(v["reason"], "expired");
    assert!(book.peers.is_empty());
}

// ── 통로 ────────────────────────────────────────────────────────────────────

#[test]
fn tampered_ciphertext_room_and_tags_are_dropped() {
    let (mut d, mut p, _) = paired(full());
    let now = T0 + 10_000;
    let ev = p.msg("ping", json!({}), now);
    // 암호문 한 글자 바꿈 → id·서명부터 안 맞다
    let mut a = ev.clone();
    let c = a["content"].as_str().unwrap().to_string();
    let flip = if c.ends_with('0') { '1' } else { '0' };
    a["content"] = json!(format!("{}{}", &c[..c.len() - 1], flip));
    assert!(d.handle_event(&a, now).is_empty());
    assert_eq!(drops(&d, "bad_event"), 1);
    // 릴레이가 암호문을 바꾸고 **자기 키로 다시 서명** → 모르는 기기
    let thief = DeviceKeys::generate().unwrap();
    let forged = seal_text(p.room.as_ref().unwrap(), &thief, "{\"v\":1}", now / 1000, SealOpts::default()).unwrap();
    assert!(d.handle_event(&forged.to_value(), now).is_empty());
    assert_eq!(drops(&d, "unknown_device"), 1);
    // 방(태그)을 바꿈 → 서명이 안 맞다
    let mut b = ev.clone();
    b["tags"] = json!([["e", "ab".repeat(32)], ["t", "ravenvault"]]);
    assert!(d.handle_event(&b, now).is_empty());
    // 태그를 하나 더 붙임
    let mut b2 = ev.clone();
    b2["tags"] = json!([["e", ev["tags"][0][1]], ["t", "ravenvault"], ["p", "x"]]);
    assert!(d.handle_event(&b2, now).is_empty());
    assert_eq!(drops(&d, "bad_event"), 3);
    // 폰 키로 서명됐지만 다른 방(= 폰이 다른 방에 쓴 것을 릴레이가 옮김)
    let other = Room { key: [3u8; 32], id: "cd".repeat(32) };
    let m = build_channel_message("ping", &new_request_id(), 9, now, json!({})).unwrap();
    let ev2 = seal_message(&other, &p.keys, &m, now, SealOpts::default()).unwrap().0.to_value();
    assert!(d.handle_event(&ev2, now).is_empty());
    assert_eq!(drops(&d, "wrong_room"), 1);
    // 원본은 여전히 통한다
    let w = d.handle_event(&ev, now);
    let pong = p.open(&published(&w)[0]);
    assert_eq!(pong["t"], "pong");
}

#[test]
fn envelope_rules_version_type_extra_keys_time() {
    let (mut d, p, _) = paired(full());
    let now = T0 + 10_000;
    let room = p.room.as_ref().unwrap();
    let send_raw = |d: &mut Desk, m: Value| {
        let ev = seal_message(room, &p.keys, &m, now, SealOpts::default()).unwrap().0.to_value();
        d.handle_event(&ev, now)
    };
    let id = || new_request_id();
    assert!(send_raw(&mut d, json!({ "v": 2, "t": "ping", "id": id(), "seq": 1, "ts": now, "body": {} })).is_empty());
    assert_eq!(drops(&d, "bad_version"), 1);
    // 데스크톱이 받지 않는 종류(데스크톱→폰 종류, 모르는 종류)
    assert!(send_raw(&mut d, json!({ "v": 1, "t": "relays", "id": id(), "seq": 2, "ts": now, "body": { "lan": null, "relays": [] } })).is_empty());
    assert!(send_raw(&mut d, json!({ "v": 1, "t": "wallet.drain", "id": id(), "seq": 3, "ts": now, "body": {} })).is_empty());
    assert_eq!(drops(&d, "unknown_type"), 2);
    // 봉투 키가 더 있음
    assert!(send_raw(&mut d, json!({ "v": 1, "t": "ping", "id": id(), "seq": 4, "ts": now, "body": {}, "perms": { "money": "phone" } })).is_empty());
    assert_eq!(drops(&d, "bad_message"), 1);
    // 시각: 24시간 넘게 옛것 / 5분 넘게 미래
    assert!(send_raw(&mut d, json!({ "v": 1, "t": "ping", "id": id(), "seq": 5, "ts": now - TS_MAX_AGE_MS - 1, "body": {} })).is_empty());
    assert!(send_raw(&mut d, json!({ "v": 1, "t": "ping", "id": id(), "seq": 6, "ts": now + TS_MAX_FUTURE_MS + 1, "body": {} })).is_empty());
    assert_eq!(drops(&d, "stale"), 1);
    assert_eq!(drops(&d, "future"), 1);
}

#[test]
fn replay_and_old_seq_are_dropped_and_survive_restart() {
    let (mut d, mut p, dir) = paired(full());
    let now = T0 + 10_000;
    let first = p.msg("view.wallet", json!({}), now);
    let w = d.handle_event(&first, now);
    assert!(matches!(w.as_slice(), [Work::View { .. }]));
    // 같은 이벤트를 1분 안에 다시(다른 길로 온 사본) → 조용히 무시
    assert!(d.handle_event(&first, now + 5).is_empty());
    // 1분 뒤 같은 이벤트 → replay 로 버림
    assert!(d.handle_event(&first, now + 61_000).is_empty());
    assert_eq!(drops(&d, "replay"), 1);
    // seq 를 100 까지 올린 뒤 옛 seq(≤ 100-64) → old_seq
    let hi = p.msg_with("ping", json!({}), now, None, Some(100));
    assert!(!d.handle_event(&hi, now).is_empty());
    let old = p.msg_with("ping", json!({}), now, None, Some(36));
    assert!(d.handle_event(&old, now + 100).is_empty());
    assert_eq!(drops(&d, "old_seq"), 1);
    // 창 안(37)은 받는다
    let ok = p.msg_with("ping", json!({}), now, None, Some(37));
    assert!(!d.handle_event(&ok, now + 200).is_empty());
    // 🔴 재시작해도 본 id 가 남아 있다 → 같은 요청은 여전히 replay
    drop(d);
    let mut d2 = Desk::open(&dir).unwrap();
    assert!(d2.handle_event(&first, now + 120_000).is_empty());
    assert_eq!(drops(&d2, "replay"), 1);
    assert!(d2.handle_event(&old, now + 120_000).is_empty());
    assert_eq!(drops(&d2, "old_seq"), 1);
    // 파일 권한 0600, 폴더 0700 — 그리고 1회용 코드는 어디에도 없다.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        for f in ["device.json", "peers.json"] {
            let m = std::fs::metadata(dir.join(f)).unwrap().permissions().mode() & 0o777;
            assert_eq!(m, 0o600, "{f}");
        }
        assert_eq!(std::fs::metadata(&dir).unwrap().permissions().mode() & 0o777, 0o700);
    }
    for e in std::fs::read_dir(&dir).unwrap() {
        let t = std::fs::read_to_string(e.unwrap().path()).unwrap_or_default();
        assert!(!t.contains(&hex::encode(CODE)), "one-time code must never be written");
        assert!(!t.contains(&hex::encode(derive_code_key(&CODE))));
    }
}

#[test]
fn unpaired_device_is_blocked_immediately_both_directions() {
    // 데스크톱이 끊는다
    let (mut d, mut p, _) = paired(full());
    let now = T0 + 10_000;
    let sign = p.keys.sign_pub.clone();
    let notice = d.unpair(&sign, now).expect("unpair notice for the phone");
    assert_eq!(p.open(&notice)["t"], "unpair");
    let ev = p.msg("view.wallet", json!({}), now + 1);
    assert!(d.handle_event(&ev, now + 1).is_empty());
    assert_eq!(drops(&d, "unknown_device"), 1);
    // 폰이 끊는다
    let (mut d, mut p, _) = paired(full());
    let bye = p.msg("unpair", json!({}), now);
    let w = d.handle_event(&bye, now);
    assert!(matches!(w.as_slice(), [Work::Changed]));
    assert!(d.book.peers.is_empty());
    let ev = p.msg("ping", json!({}), now + 1);
    assert!(d.handle_event(&ev, now + 1).is_empty());
    assert_eq!(drops(&d, "unknown_device"), 1);
    // 끊은 방은 하루 동안 「연결 방」으로 남아 릴레이가 디스크에 안 쓴다
    assert!(d.rooms(now).contains(&p.room.as_ref().unwrap().id));
}

#[test]
fn re_pairing_the_same_phone_remembers_the_old_room() {
    // 같은 폰을 다시 연결(권한 바꾸기)하면 옛 통로 방은 빠지지만, 하루 동안 「연결 방」으로 남아
    // 그 방으로 늦게 온 글을 릴레이가 디스크에 쓰지 않는다.
    let (mut d, mut p, _) = paired(full());
    let old = p.room.as_ref().unwrap().id.clone();
    let now = T0 + 10_000;
    let code2 = [9u8; 16];
    d.host.show_qr(&d.keys, "Office Mac", None, &[], now, code2).unwrap();
    let hello = p.hello(&d.keys, &code2, "Pixel 8", now + 1000);
    let w = d.handle_event(&hello, now + 1000);
    assert!(matches!(w.as_slice(), [Work::Changed]), "{w:?}");
    let (ev, _) = d.approve(&full(), "Office Mac", None, &[], now + 2000, SealOpts::default()).unwrap();
    assert_eq!(p.open(&ev)["t"], "accept");
    let new = p.room.as_ref().unwrap().id.clone();
    assert_ne!(old, new);
    assert_eq!(d.book.peers.len(), 1);
    assert!(!d.live_rooms(now + 2000).contains(&old), "옛 방은 더 듣지 않는다");
    let rooms = d.rooms(now + 2000);
    assert!(rooms.contains(&old) && rooms.contains(&new), "옛 방도 하루 동안 연결 방");
}

// ── 권한 ────────────────────────────────────────────────────────────────────

fn denied_reason(p: &Phone, w: &[Work]) -> String {
    let ev = published(w).into_iter().next().expect("denied reply");
    let v = p.open(&ev);
    assert_eq!(v["t"], "denied");
    v["body"]["reason"].as_str().unwrap().to_string()
}

#[test]
fn view_only_phone_cannot_escalate() {
    let (mut d, mut p, _) = paired(Perms::default());
    let now = T0 + 10_000;
    // 보내기 요청 — 폰 승인이라고 우겨도
    let ev = p.msg("req.send", json!({ "to": "RXissueAssetXXXXXXXXXXXXXXXXXhhZGt", "amount_rvn": 1, "approved_on_phone": true }), now);
    assert_eq!(denied_reason(&p, &d.handle_event(&ev, now)), "not_permitted");
    let ev = p.msg("req.cert", json!({ "kind": "one", "title": "수료증" }), now);
    assert_eq!(denied_reason(&p, &d.handle_event(&ev, now)), "not_permitted");
    assert!(d.requests.is_empty(), "nothing queued");
    // 폰은 권한을 바꿀 메시지가 없다(accept 는 데스크톱→폰 · 모르는 종류)
    let fake_accept = p.msg("ping", json!({ "perms": { "view": true, "request": true, "money": "phone", "daily_limit_rvn": 999999 } }), now);
    d.handle_event(&fake_accept, now);
    assert_eq!(d.book.peers[0].perms, Perms::default(), "phone claims are ignored");
}

#[test]
fn phone_approval_is_ignored_in_desktop_mode_and_limit_is_enforced() {
    let to = "RXissueAssetXXXXXXXXXXXXXXXXXhhZGt";
    // 데스크톱 확인 모드: approved_on_phone 이 있어도 「폰 요청」 칸으로
    let (mut d, mut p, _) = paired(Perms { view: true, request: true, money: "desktop".into(), daily_limit_rvn: 1000 });
    let now = T0 + 10_000;
    let ev = p.msg("req.send", json!({ "to": to, "amount_rvn": 5, "approved_on_phone": true }), now);
    let w = d.handle_event(&ev, now);
    assert!(!w.iter().any(|x| matches!(x, Work::AutoSend { .. })), "never auto in desktop mode");
    assert_eq!(d.requests[0].mode, "desktop_confirm");
    assert_eq!(d.requests[0].status, "waiting");
    let st = p.open(&published(&w)[0]);
    assert_eq!(st["t"], "req.status");
    assert_eq!(st["body"]["status"], "desktop_confirm");

    // 폰 승인 모드, 한도 100: 60 → auto, 그다음 40.00000001 → over_limit, 40 → auto(딱 한도)
    let (mut d, mut p, _) = paired(full());
    let ev = p.msg("req.send", json!({ "to": to, "amount_rvn": 60, "approved_on_phone": true }), now);
    let w = d.handle_event(&ev, now);
    assert!(w.iter().any(|x| matches!(x, Work::AutoSend { .. })));
    assert_eq!(d.spent_sats(&p.keys.sign_pub, now), 6_000_000_000, "reserved before sending");
    let ev = p.msg("req.send", json!({ "to": to, "amount_rvn": 40.00000001, "approved_on_phone": true }), now);
    assert_eq!(denied_reason(&p, &d.handle_event(&ev, now)), "over_limit");
    // 생체 인증 표시가 없으면 한도 안이어도 데스크톱 확인
    let ev = p.msg("req.send", json!({ "to": to, "amount_rvn": 1 }), now);
    let w = d.handle_event(&ev, now);
    assert!(!w.iter().any(|x| matches!(x, Work::AutoSend { .. })));
    // 자산은 언제나 데스크톱 확인
    let ev = p.msg("req.send", json!({ "to": to, "amount_rvn": 1, "approved_on_phone": true, "asset": "RAVENQA#ONE" }), now);
    let w = d.handle_event(&ev, now);
    assert!(!w.iter().any(|x| matches!(x, Work::AutoSend { .. })));
    let ev = p.msg("req.send", json!({ "to": to, "amount_rvn": 40, "approved_on_phone": true }), now);
    let w = d.handle_event(&ev, now);
    assert!(w.iter().any(|x| matches!(x, Work::AutoSend { .. })));
    // 한도를 다 썼다
    let ev = p.msg("req.send", json!({ "to": to, "amount_rvn": 0.00000001, "approved_on_phone": true }), now);
    assert_eq!(denied_reason(&p, &d.handle_event(&ev, now)), "over_limit");
    // 24시간이 지나면 다시
    let later = now + LIMIT_WINDOW_MS + 1;
    let ev = p.msg("req.send", json!({ "to": to, "amount_rvn": 1, "approved_on_phone": true }), later);
    assert!(d.handle_event(&ev, later).iter().any(|x| matches!(x, Work::AutoSend { .. })));
}

#[test]
fn secret_named_fields_are_refused_both_ways() {
    let desk = DeviceKeys::generate().unwrap();
    let room = Room { key: [1u8; 32], id: "ab".repeat(32) };
    for bad in [
        json!({ "mnemonic": "x" }),
        json!({ "body": { "Seed": "x" } }),
        json!({ "list": [{ "wallet_passphrase": "x" }] }),
        json!({ "a": { "b": { "privkey": "x" } } }),
        json!({ "wif": "x" }),
        json!({ "sign_sk": "x" }),
        json!({ "xprv": "x" }),
        json!({ "password": "x" }),
    ] {
        assert_eq!(seal_message(&room, &desk, &bad, T0, SealOpts::default()).unwrap_err(), PairingError("secret_field"), "{bad}");
    }
    // 폰이 그런 칸을 실어 보낸 요청은 받지 않는다(쌓이지도 않는다).
    let (mut d, _p, _) = paired(full());
    let now = T0 + 10_000;
    // 폰 코어는 봉하기 전에 막으므로, 공격자가 코어를 우회했다고 가정하고 직접 봉한다.
    let p2 = _p;
    let m = build_channel_message("req.cert", &new_request_id(), 1, now, json!({ "title": "x", "seed_words": "a b c" })).unwrap();
    let text = serde_json::to_string(&m).unwrap();
    let ev = seal_text(p2.room.as_ref().unwrap(), &p2.keys, &text, now / 1000, SealOpts::default()).unwrap().to_value();
    let w = d.handle_event(&ev, now);
    assert_eq!(denied_reason(&p2, &w), "bad_request");
    assert!(d.requests.is_empty());
    // 이 컴퓨터가 쓰는 연결 메시지 만들기에는 그런 칸이 없다: 모든 봉함은 seal_message 한 곳을 지난다.
    let src = [include_str!("desk.rs"), include_str!("host.rs"), include_str!("net.rs"), include_str!("../pairing.rs")].concat();
    for word in ["mnemonic", "walletpassphrase", "dumpprivkey", "passphrase:"] {
        assert!(!src.contains(word), "pairing code must not touch {word}");
    }
}

// ── 할 일 (가짜 노드) ───────────────────────────────────────────────────────

struct Fake {
    locked: Mutex<bool>,
    sent: Mutex<Vec<(String, f64)>>,
}
impl Backend for Fake {
    fn wallet(&self) -> BoxFut<'_, Result<Value, String>> {
        Box::pin(async {
            let assets: Vec<Value> = (0..300).map(|i| json!({ "name": format!("SHOP.ITEM{i:03}"), "amount": i })).collect();
            Ok(json!({ "balance_rvn": 12.5, "assets": assets }))
        })
    }
    fn certs(&self) -> Result<Vec<Value>, String> {
        Ok(vec![json!({ "id": "c1", "name": "수료증", "date": T0, "count": 50 })])
    }
    fn sales(&self, _now: i64, _tz: i64) -> Result<Value, String> {
        Ok(json!({ "today": { "rvn": 10.0, "count": 2 }, "month": { "rvn": 100.0, "count": 20 } }))
    }
    fn wallet_locked(&self) -> BoxFut<'_, Result<bool, String>> {
        let l = *self.locked.lock().unwrap();
        Box::pin(async move { Ok(l) })
    }
    fn send_rvn<'a>(&'a self, to: &'a str, amount: f64) -> BoxFut<'a, Result<String, String>> {
        self.sent.lock().unwrap().push((to.into(), amount));
        Box::pin(async { Ok("ab".repeat(32)) })
    }
}

async fn drive(d: &Mutex<Desk>, works: Vec<Work>, b: &Fake, now: i64) -> Vec<ChatEvent> {
    let out = Mutex::new(Vec::new());
    let lock = |f: &mut dyn FnMut(&mut Desk)| f(&mut d.lock().unwrap());
    let publish = |e: ChatEvent| out.lock().unwrap().push(e);
    run_work(works, &lock, b, &publish, &move || now).await;
    out.into_inner().unwrap()
}

#[tokio::test]
async fn views_answer_with_real_shapes_under_4kb() {
    let (d, mut p, _) = paired(full());
    let d = Mutex::new(d);
    let b = Fake { locked: Mutex::new(false), sent: Mutex::new(vec![]) };
    let now = T0 + 10_000;
    for (t, rt) in [("view.wallet", "view.wallet.r"), ("view.certs", "view.certs.r"), ("view.sales", "view.sales.r")] {
        let ev = p.msg(t, json!({}), now);
        let re = p.open(&verify_chat_event(&ev).unwrap())["id"].clone();
        let w = d.lock().unwrap().handle_event(&ev, now);
        let out = drive(&d, w, &b, now).await;
        assert_eq!(out.len(), 1, "{t}");
        let v = p.open(&out[0]);
        assert_eq!(v["t"], rt);
        assert_eq!(v["body"]["re"], re);
        let plain = serde_json::to_string(&v).unwrap();
        assert!(plain.len() <= MAX_CHAT_BYTES, "{t}: {}", plain.len());
        if t == "view.wallet" {
            assert_eq!(v["body"]["balance_rvn"], 12.5);
            assert!(v["body"]["more"].as_u64().unwrap() > 0, "300 assets do not fit; cut honestly");
            assert_eq!(v["body"]["locked"], false);
            assert_eq!(v["body"]["limit_left_rvn"], 100.0);
            assert_eq!(v["body"]["perms"]["money"], "phone");
        }
        if t == "view.sales" {
            assert_eq!(v["body"]["today"]["count"], 2);
        }
    }
}

#[tokio::test]
async fn phone_approved_send_waits_while_locked_then_goes_through_existing_send() {
    let (d, mut p, _) = paired(full());
    let sign = p.keys.sign_pub.clone();
    let d = Mutex::new(d);
    let b = Fake { locked: Mutex::new(true), sent: Mutex::new(vec![]) };
    let now = T0 + 10_000;
    let ev = p.msg("req.send", json!({ "to": "RXissueAssetXXXXXXXXXXXXXXXXXhhZGt", "amount_rvn": 12.5, "approved_on_phone": true }), now);
    let w = d.lock().unwrap().handle_event(&ev, now);
    let out = drive(&d, w, &b, now).await;
    assert!(b.sent.lock().unwrap().is_empty(), "locked wallet: nothing leaves");
    let st = p.open(&out[0]);
    assert_eq!(st["body"]["status"], "queued");
    assert_eq!(st["body"]["note"], "wallet_locked");
    assert_eq!(d.lock().unwrap().requests[0].status, "waiting_unlock");
    assert_eq!(d.lock().unwrap().spent_sats(&sign, now), 1_250_000_000, "still reserved against the limit");
    // 풀렸다 → 다시 판정 후 보낸다
    *b.locked.lock().unwrap() = false;
    let w = d.lock().unwrap().retry_unlock(now + 30_000);
    let out = drive(&d, w, &b, now + 30_000).await;
    assert_eq!(b.sent.lock().unwrap().as_slice(), &[("RXissueAssetXXXXXXXXXXXXXXXXXhhZGt".to_string(), 12.5)]);
    let st = p.open(out.last().unwrap());
    assert_eq!(st["body"]["status"], "done");
    assert_eq!(st["body"]["txid"], "ab".repeat(32));
    assert_eq!(st["body"]["limit_left_rvn"], 87.5);
    // 같은 요청이 다시 와도(재전송) 두 번 보내지 않는다 — 캐시한 답만 다시.
    let w = d.lock().unwrap().handle_event(&ev, now + 90_000);
    let out = drive(&d, w, &b, now + 90_000).await;
    assert_eq!(b.sent.lock().unwrap().len(), 1);
    assert_eq!(p.open(&out[0])["body"]["status"], "done", "cached answer resent");

    // 잠긴 사이 사장이 「데스크톱 확인」으로 바꾸면 자동으로 안 나간다.
    let (d2, mut p2, _) = paired(full());
    let d2 = Mutex::new(d2);
    *b.locked.lock().unwrap() = true;
    let ev = p2.msg("req.send", json!({ "to": "RXissueAssetXXXXXXXXXXXXXXXXXhhZGt", "amount_rvn": 1, "approved_on_phone": true }), now);
    let w = d2.lock().unwrap().handle_event(&ev, now);
    drive(&d2, w, &b, now).await;
    d2.lock().unwrap().book.peers[0].perms.money = "desktop".into();
    *b.locked.lock().unwrap() = false;
    let w = d2.lock().unwrap().retry_unlock(now + 1000);
    let out = drive(&d2, w, &b, now + 1000).await;
    assert_eq!(b.sent.lock().unwrap().len(), 1, "no new send");
    assert_eq!(p2.open(&out[0])["body"]["status"], "desktop_confirm");
    assert_eq!(d2.lock().unwrap().requests[0].status, "waiting");
}

#[test]
fn requests_expire_after_24h_and_tell_the_phone() {
    let (mut d, mut p, _) = paired(full());
    let now = T0 + 10_000;
    let ev = p.msg("req.cert", json!({ "kind": "batch", "title": "수료증", "count": 50 }), now);
    d.handle_event(&ev, now);
    assert_eq!(d.requests.len(), 1);
    let w = d.tick(now + REQUEST_TTL_MS + 1);
    let st = p.open(&published(&w)[0]);
    assert_eq!(st["body"]["status"], "rejected");
    assert_eq!(st["body"]["note"], "expired");
    assert_eq!(d.requests[0].status, "expired");
}

#[test]
fn tunnel_change_sends_relays_to_every_phone() {
    let (mut d, p, _) = paired(full());
    let now = T0 + 10_000;
    let r1 = vec!["wss://quiet-owl-1234.trycloudflare.com/api/relay".to_string()];
    let w = d.routes_changed(Some("ws://192.168.0.10:8790/api/relay"), &r1, now);
    let v = p.open(&published(&w)[0]);
    assert_eq!(v["t"], "relays");
    assert_eq!(v["body"]["relays"], json!(r1));
    assert!(d.routes_changed(Some("ws://192.168.0.10:8790/api/relay"), &r1, now).is_empty(), "same routes → nothing");
}
