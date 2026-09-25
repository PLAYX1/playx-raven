//! 데스크톱 쪽 상태 기계 — 폰 `session.ts` 의 `DesktopPairingHost`·`PeerBook`·
//! `ChannelEndpoint`(데스크톱 역할)를 그대로 옮겼다. 시계는 밖에서 받는다(`now` ms).

use super::proto::*;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::VecDeque;

pub const TS_MAX_AGE_MS: i64 = 24 * 60 * 60 * 1000;
pub const TS_MAX_FUTURE_MS: i64 = 5 * 60 * 1000;
pub const SEEN_TTL_MS: i64 = 24 * 60 * 60 * 1000;
pub const SEEN_MAX: usize = 5000;
pub const SEQ_WINDOW: i64 = 64;
/// HELLO 가 온 뒤 사장이 「허락」을 누를 수 있는 시간.
pub const PENDING_APPROVAL_MS: i64 = 5 * 60 * 1000;
/// 만료 뒤 늦게 온 HELLO 에 reject/expired 로 답하려고만 코드를 이만큼 더 쥔다.
pub const CODE_GRACE_MS: i64 = 5 * 60 * 1000;

// ── 연결된 기기 ─────────────────────────────────────────────────────────────

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Peer {
    /// 폰 BIP340 공개키(이벤트 pubkey) — 찾는 열쇠
    pub sign: String,
    pub dh: String,
    pub name: String,
    pub fingerprint: String,
    /// 통로 열쇠(hex). 이 컴퓨터의 pairing 폴더(0600)에만 있다.
    pub ch_key: String,
    pub ch_room: String,
    /// 🔴 데스크톱이 정한 **진짜** 권한. 폰이 뭐라고 하든 이것으로 판정한다.
    pub perms: Perms,
    pub paired_at: i64,
    pub last_used: i64,
    pub tx_seq: i64,
    pub rx_last_seq: i64,
    /// (요청 id, 받은 시각 ms) — 오래된 것이 앞. 24시간·최대 5000개.
    pub rx_seen: VecDeque<(String, i64)>,
}
impl Peer {
    pub fn room(&self) -> R<Room> {
        Ok(Room { key: unhex(&self.ch_key, "bad_store")?, id: self.ch_room.clone() })
    }
}

#[derive(Default, Clone, Debug, Serialize, Deserialize)]
pub struct PeerBook {
    pub peers: Vec<Peer>,
}
impl PeerBook {
    pub fn get(&self, sign: &str) -> Option<&Peer> {
        self.peers.iter().find(|p| p.sign == sign)
    }
    pub fn get_mut(&mut self, sign: &str) -> Option<&mut Peer> {
        self.peers.iter_mut().find(|p| p.sign == sign)
    }
    pub fn add(&mut self, p: Peer) {
        self.remove(&p.sign);
        self.peers.push(p);
    }
    /// 즉시: 다음 이벤트부터 `unknown_device`. 통로 열쇠도 지운다.
    pub fn remove(&mut self, sign: &str) -> bool {
        let n = self.peers.len();
        for p in self.peers.iter_mut().filter(|p| p.sign == sign) {
            // SAFETY: 같은 길이의 ASCII 로 덮어쓰니 UTF-8 이 깨지지 않는다.
            unsafe { wipe(p.ch_key.as_bytes_mut()) };
        }
        self.peers.retain(|p| p.sign != sign);
        n != self.peers.len()
    }
    pub fn rooms(&self) -> Vec<String> {
        self.peers.iter().map(|p| p.ch_room.clone()).collect()
    }
}

// ── §5 받기 규칙 ────────────────────────────────────────────────────────────

#[derive(Debug)]
#[allow(dead_code)] // reason 은 시험·기록용
pub enum Received {
    Accepted { peer: String, message: Value, mode: &'static str },
    Denied { peer: String, message: Value, reason: &'static str, reply: ChatEvent },
    Unpaired { peer: String, room: String },
    /// 조용히 버림. `re` 는 이미 본 요청 id(재전송) — 캐시한 답을 다시 보낼 수 있게.
    Drop { reason: &'static str, re: Option<String>, peer: Option<String> },
}

fn drop_(reason: &'static str, peer: Option<&str>) -> Received {
    Received::Drop { reason, re: None, peer: peer.map(String::from) }
}

/// 폰 → 데스크톱 이벤트 하나. `spent_today_rvn(sign)` 은 폰 승인으로 오늘 이미 나간 RVN.
pub fn receive(book: &mut PeerBook, keys: &DeviceKeys, v: &Value, now: i64, spent_today_rvn: &dyn Fn(&str) -> f64) -> Received {
    let Ok(event) = verify_chat_event(v) else { return drop_("bad_event", None) };
    let Some(peer) = book.get(&event.pubkey) else { return drop_("unknown_device", None) };
    let sign = peer.sign.clone();
    if event.room() != peer.ch_room {
        return drop_("wrong_room", Some(&sign));
    }
    let Ok(room) = peer.room() else { return drop_("decrypt_failed", Some(&sign)) };
    let Ok((_, opened)) = open_message(&room, v) else { return drop_("decrypt_failed", Some(&sign)) };
    let message = match parse_channel_message(&opened, Direction::ToDesktop) {
        Ok(m) => m,
        Err(e) => return drop_(e.0, Some(&sign)),
    };
    let ts = safe_int(&message["ts"]).unwrap_or(0);
    let seq = safe_int(&message["seq"]).unwrap_or(0);
    let id = message["id"].as_str().unwrap_or("").to_string();
    let t = message["t"].as_str().unwrap_or("").to_string();
    if ts < now - TS_MAX_AGE_MS {
        return drop_("stale", Some(&sign));
    }
    if ts > now + TS_MAX_FUTURE_MS {
        return drop_("future", Some(&sign));
    }
    let peer = book.get_mut(&sign).expect("peer");
    while let Some((_, at)) = peer.rx_seen.front() {
        if now - *at > SEEN_TTL_MS {
            peer.rx_seen.pop_front();
        } else {
            break;
        }
    }
    if peer.rx_seen.iter().any(|(x, _)| *x == id) {
        return Received::Drop { reason: "replay", re: Some(id), peer: Some(sign) };
    }
    if seq <= peer.rx_last_seq - SEQ_WINDOW {
        return drop_("old_seq", Some(&sign));
    }
    peer.rx_seen.push_back((id.clone(), now));
    while peer.rx_seen.len() > SEEN_MAX {
        peer.rx_seen.pop_front();
    }
    peer.rx_last_seq = peer.rx_last_seq.max(seq);
    peer.last_used = now;

    if t == "unpair" {
        let room = peer.ch_room.clone();
        book.remove(&sign);
        return Received::Unpaired { peer: sign, room };
    }
    let perms = peer.perms.to_value();
    match authorize(&perms, &t, &message["body"], spent_today_rvn(&sign)) {
        Decision::Allow(mode) => Received::Accepted { peer: sign, message, mode },
        Decision::Deny(reason) => match send(book, keys, &sign, "denied", json!({ "re": id, "reason": reason }), now, None, SealOpts::default()) {
            Ok((reply, _)) => Received::Denied { peer: sign, message, reason, reply },
            Err(_) => drop_("seal_failed", Some(&sign)),
        },
    }
}

/// 연결된 폰에게 봉해서 보낸다. `id` 를 안 주면 새 무작위 요청 id.
#[allow(clippy::too_many_arguments)]
pub fn send(book: &mut PeerBook, keys: &DeviceKeys, sign: &str, t: &str, body: Value, now: i64, id: Option<&str>, opts: SealOpts) -> R<(ChatEvent, Value)> {
    let peer = book.get_mut(sign).ok_or(PairingError("unknown_device"))?;
    let id = id.map(String::from).unwrap_or_else(new_request_id);
    let message = build_channel_message(t, &id, peer.tx_seq + 1, now, body)?;
    parse_channel_message(&message, Direction::ToPhone)?;
    let (event, _) = seal_message(&peer.room()?, keys, &message, now, opts)?;
    peer.tx_seq += 1;
    Ok((event, message))
}

/// 지금 끊고(즉시) 폰에게 알릴 `unpair` 를 만든다(닿으면 좋고, 못 닿아도 여기서는 이미 끊겼다).
pub fn unpair(book: &mut PeerBook, keys: &DeviceKeys, sign: &str, now: i64) -> Option<ChatEvent> {
    let ev = send(book, keys, sign, "unpair", json!({}), now, None, SealOpts::default()).ok().map(|x| x.0);
    book.remove(sign);
    ev
}

// ── 1회용 코드 + HELLO ─────────────────────────────────────────────────────

#[derive(Clone, Debug, Serialize)]
pub struct PendingApproval {
    pub hello_id: String,
    pub phone_sign: String,
    pub phone_dh: String,
    pub phone_name: String,
    pub fingerprint: String,
    pub want: Vec<String>,
    pub sas: String,
    pub received_at: i64,
}
struct PendingSlot {
    view: PendingApproval,
    ch_key: [u8; 32],
    ch_room: String,
}
impl Drop for PendingSlot {
    fn drop(&mut self) {
        wipe(&mut self.ch_key);
    }
}
struct Slot {
    /// 🔴 메모리에만. 디스크에 절대 안 쓴다(HELLO 복호에 `c` 자체가 필요하다).
    code: [u8; 16],
    room: Room,
    expires_at_ms: i64,
    consumed_by: Option<String>,
    pending: Option<PendingSlot>,
}
impl Drop for Slot {
    fn drop(&mut self) {
        wipe(&mut self.code);
    }
}

#[derive(Debug)]
#[allow(dead_code)] // reason 은 시험·기록용
pub enum HelloOutcome {
    Pending(PendingApproval),
    Rejected { reason: &'static str, reply: ChatEvent },
    Drop(&'static str),
}

#[derive(Default)]
pub struct Host {
    slot: Option<Slot>,
}
impl Host {
    /// 새 QR(2분). 옛 코드와 대기 중인 허락은 **즉시** 지운다.
    pub fn show_qr(&mut self, keys: &DeviceKeys, name: &str, lan: Option<&str>, relays: &[String], now: i64, code: [u8; 16]) -> R<(String, i64, String)> {
        self.slot = None;
        let expires_at = now.div_euclid(1000) + QR_TTL_SECONDS;
        let qr = build_pair_qr(&QrInput {
            desk_sign: &keys.sign_pub,
            desk_dh: &keys.dh_pub,
            code_hex: &hex::encode(code),
            expires_at,
            name,
            lan,
            relays,
        })?;
        let room = hello_room(&code);
        let pair_room = room.id.clone();
        self.slot = Some(Slot { code, room, expires_at_ms: expires_at * 1000, consumed_by: None, pending: None });
        Ok((qr, expires_at, pair_room))
    }
    pub fn cancel(&mut self) {
        self.slot = None;
    }
    /// 만료+5분이 지났고 기다리는 허락이 없으면 코드를 지운다.
    pub fn gc(&mut self, now: i64) {
        if let Some(s) = &self.slot {
            if now > s.expires_at_ms + CODE_GRACE_MS && s.pending.is_none() {
                self.slot = None;
            }
        }
    }
    pub fn pair_room(&mut self, now: i64) -> Option<String> {
        self.gc(now);
        self.slot.as_ref().map(|s| s.room.id.clone())
    }
    pub fn qr_live(&self, now: i64) -> Option<i64> {
        self.slot.as_ref().filter(|s| now <= s.expires_at_ms && s.consumed_by.is_none()).map(|s| s.expires_at_ms)
    }
    pub fn pending(&mut self, now: i64) -> Option<PendingApproval> {
        self.gc(now);
        let p = self.slot.as_ref()?.pending.as_ref()?;
        (now - p.view.received_at <= PENDING_APPROVAL_MS).then(|| p.view.clone())
    }
    /// 허락 대기 5분이 지났으면 reject/expired 를 만들어 준다(한 번만).
    pub fn expire_pending(&mut self, keys: &DeviceKeys, now: i64) -> Option<ChatEvent> {
        let late = self.slot.as_ref()?.pending.as_ref().map(|p| now - p.view.received_at > PENDING_APPROVAL_MS)?;
        if late {
            return self.deny(keys, "expired", now, SealOpts::default());
        }
        None
    }

    pub fn receive_hello(&mut self, keys: &DeviceKeys, v: &Value, now: i64, opts: SealOpts) -> HelloOutcome {
        self.gc(now);
        let Ok(event) = verify_chat_event(v) else { return HelloOutcome::Drop("bad_event") };
        let Some(slot) = self.slot.as_mut() else { return HelloOutcome::Drop("unknown_room") };
        if event.room() != slot.room.id {
            return HelloOutcome::Drop("unknown_room");
        }
        // 🔴 쓰레기(복호 실패·모양 틀림)는 코드를 태우지 않는다.
        let hello = match open_message(&slot.room, v) {
            Err(_) => return HelloOutcome::Drop("decrypt_failed"),
            Ok((_, val)) => match parse_hello(&val) {
                Ok(h) => h,
                Err(_) => return HelloOutcome::Drop("bad_hello"),
            },
        };
        if event.pubkey != hello.phone_sign {
            return HelloOutcome::Drop("sender_mismatch");
        }
        if slot.consumed_by.as_deref() == Some(event.id.as_str()) {
            return HelloOutcome::Drop("replay");
        }
        if now > slot.expires_at_ms {
            return match reject_in(slot, keys, &event.id, "expired", now, opts) {
                Ok(reply) => HelloOutcome::Rejected { reason: "expired", reply },
                Err(_) => HelloOutcome::Drop("seal_failed"),
            };
        }
        if slot.consumed_by.is_some() {
            return match reject_in(slot, keys, &event.id, "code_used", now, opts) {
                Ok(reply) => HelloOutcome::Rejected { reason: "code_used", reply },
                Err(_) => HelloOutcome::Drop("seal_failed"),
            };
        }
        let ch = match derive_channel_desktop(
            keys.dh_secret(),
            &slot.code,
            &TranscriptKeys { desk_sign: &keys.sign_pub, desk_dh: &keys.dh_pub, phone_sign: &hello.phone_sign, phone_dh: &hello.phone_dh },
        ) {
            Ok(c) => c,
            Err(_) => return HelloOutcome::Drop("bad_peer_key"),
        };
        // 처음 온 올바른 HELLO 가 코드를 쓴다 — 사장이 나중에 뭐라고 하든.
        slot.consumed_by = Some(event.id.clone());
        let view = PendingApproval {
            hello_id: event.id.clone(),
            phone_sign: hello.phone_sign.clone(),
            phone_dh: hello.phone_dh.clone(),
            phone_name: hello.name.clone(),
            fingerprint: fingerprint(&hello.phone_sign, &hello.phone_dh).unwrap_or_default(),
            want: hello.want.clone(),
            sas: ch.sas.clone(),
            received_at: now,
        };
        slot.pending = Some(PendingSlot { view: view.clone(), ch_key: ch.ch_key, ch_room: ch.ch_room.clone() });
        HelloOutcome::Pending(view)
    }

    /// 사장이 「허락」. **이** 권한으로 등록하고 ACCEPT(seq 1)를 봉한다.
    #[allow(clippy::too_many_arguments)]
    pub fn approve(&mut self, keys: &DeviceKeys, book: &mut PeerBook, perms: &Perms, desk_name: &str, lan: Option<&str>, relays: &[String], now: i64, opts: SealOpts) -> R<(ChatEvent, Peer)> {
        self.gc(now);
        let slot = self.slot.as_mut().ok_or(PairingError("no_pending"))?;
        let pending = slot.pending.as_ref().ok_or(PairingError("no_pending"))?;
        if now - pending.view.received_at > PENDING_APPROVAL_MS {
            return fail("pending_expired");
        }
        let message = build_accept(perms, desk_name, lan, relays, now, 1)?;
        let room = Room { key: pending.ch_key, id: pending.ch_room.clone() };
        let (event, _) = seal_message(&room, keys, &message, now, opts)?;
        let v = &pending.view;
        let peer = Peer {
            sign: v.phone_sign.clone(),
            dh: v.phone_dh.clone(),
            name: v.phone_name.clone(),
            fingerprint: v.fingerprint.clone(),
            ch_key: hex::encode(pending.ch_key),
            ch_room: pending.ch_room.clone(),
            perms: perms.clone(),
            paired_at: now,
            last_used: now,
            tx_seq: 1,
            rx_last_seq: 0,
            rx_seen: VecDeque::new(),
        };
        book.add(peer.clone());
        slot.pending = None;
        Ok((event, peer))
    }

    /// 사장이 「거절」(또는 허락 시간이 지남).
    pub fn deny(&mut self, keys: &DeviceKeys, reason: &'static str, now: i64, opts: SealOpts) -> Option<ChatEvent> {
        let slot = self.slot.as_mut()?;
        let hello_id = slot.pending.as_ref()?.view.hello_id.clone();
        let reply = reject_in(slot, keys, &hello_id, reason, now, opts).ok();
        slot.pending = None;
        reply
    }
}

fn reject_in(slot: &Slot, keys: &DeviceKeys, re: &str, reason: &str, now: i64, opts: SealOpts) -> R<ChatEvent> {
    Ok(seal_message(&slot.room, keys, &build_reject(Some(re), Some(reason))?, now, opts)?.0)
}
