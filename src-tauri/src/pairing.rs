//! RV6 — 폰 ↔ 데스크톱 QR 연결 (데스크톱 쪽).
//!
//! 「카카오톡 PC 로그인」처럼: 설정 › 「폰 연결」에 QR(2분·1회용)을 띄우고, 폰이 찍으면
//! 양쪽에 같은 6자리가 뜨고, 사장이 여기서 「허락」한다. 그 뒤 폰은 **이 컴퓨터의 지갑을
//! 보고**(보기), **요청을 보낸다**(요청). 돈이 나가는 일은 기본이 **이 화면에서 확인**이다.
//!
//! 규격: ravenvault docs/RV6-pairing-protocol.md v1 (§11 확정 세부). 폰 core/pairing/*.ts 와
//! 바이트까지 같다 — `pairing/tests_vectors.rs` 가 폰 시험 벡터 전부를 다시 만든다.
//!
//! 🔴 개인키·복구 단어·지갑 암호는 어떤 연결 메시지·기록·파일에도 실리지 않는다.
//!    폰의 지갑과 이 컴퓨터의 지갑은 섞이지 않는다 — 서명은 언제나 이 컴퓨터가 한다.
//!
//! 나눈 파일:
//!   proto.rs — 바이트 규칙(순수 함수)      host.rs — 1회용 코드·HELLO·§5 받기 규칙
//!   desk.rs  — 상태·파일·「폰 요청」·할 일  net.rs  — 이 컴퓨터 릴레이·바깥 릴레이·진짜 노드

pub mod desk;
pub mod host;
pub mod net;
pub mod proto;

#[cfg(test)]
mod tests_attack;
#[cfg(test)]
mod tests_vectors;

use proto::Perms;
use serde_json::{json, Value};

pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn shop_name() -> Option<String> {
    crate::shop::shop_load()["name"].as_str().map(|s| s.trim().chars().take(20).collect::<String>())
}

fn ago_text(ms: i64, now: i64) -> Value {
    json!({ "at": ms, "secs": ((now - ms) / 1000).max(0) })
}

/// 화면이 읽는 전부. 연결 기능을 켠 적이 없으면 `ready:false` 만(아무것도 만들지 않는다).
#[tauri::command]
pub fn pairing_state(tz_offset_min: Option<i64>) -> Result<Value, String> {
    let now = now_ms();
    let out = net::with_desk(false, |d| {
        if let Some(tz) = tz_offset_min.filter(|t| (-720..=840).contains(t)) {
            if d.settings.tz_offset_min != Some(tz) {
                d.settings.tz_offset_min = Some(tz);
                let _ = d.save_settings();
            }
        }
        let pending = d.host.pending(now).map(|p| {
            json!({ "name": p.phone_name, "sas": p.sas, "fingerprint": p.fingerprint, "want": p.want,
                    "left_secs": ((host::PENDING_APPROVAL_MS - (now - p.received_at)) / 1000).max(0) })
        });
        let devices: Vec<Value> = d
            .book
            .peers
            .iter()
            .map(|p| {
                json!({ "sign": p.sign, "name": p.name, "fingerprint": p.fingerprint, "perms": p.perms,
                        "paired": ago_text(p.paired_at, now), "last_used": ago_text(p.last_used, now),
                        "limit_left_rvn": d.limit_left_rvn(&p.sign, now) })
            })
            .collect();
        let requests: Vec<Value> = d
            .requests
            .iter()
            .filter(|r| matches!(r.status.as_str(), "waiting" | "waiting_unlock" | "opened"))
            .map(|r| {
                json!({ "id": r.id, "t": r.t, "peer_name": r.peer_name, "body": r.body, "status": r.status,
                        "received": ago_text(r.received_at, now), "left_secs": ((r.expires_at - now) / 1000).max(0) })
            })
            .collect();
        let recent: Vec<Value> = d
            .requests
            .iter()
            .rev()
            .filter(|r| !matches!(r.status.as_str(), "waiting" | "waiting_unlock" | "opened"))
            .take(5)
            .map(|r| json!({ "id": r.id, "t": r.t, "peer_name": r.peer_name, "status": r.status, "txid": r.txid }))
            .collect();
        json!({
            "ready": true,
            "fingerprint": d.keys.fingerprint(),
            "desk_name": d.desk_name(shop_name().as_deref()),
            "qr_live_until": d.host.qr_live(now),
            "pending": pending,
            "devices": devices,
            "requests": requests,
            "recent": recent,
            "public_backup": d.settings.public_backup,
            "server_running": crate::server::relay_live(),
        })
    })?;
    Ok(out.unwrap_or_else(|| json!({ "ready": false, "server_running": crate::server::relay_live(), "devices": [], "requests": [] })))
}

/// 새 QR(2분). 옛 QR 은 이 순간 못 쓰게 된다. 처음이면 이 컴퓨터의 기기 키를 만든다.
#[tauri::command]
pub async fn pairing_show_qr() -> Result<Value, String> {
    let (extra, _) = net::with_desk(true, |d| (d.settings.extra_relays.clone(), ()))?.unwrap_or_default();
    let (lan, relays) = tokio::task::spawn_blocking(move || net::routes(&extra)).await.map_err(|e| e.to_string())?;
    let now = now_ms();
    let shown = net::with_desk(true, |d| {
        let name = d.desk_name(shop_name().as_deref());
        d.show_qr(&name, lan.as_deref(), &relays, now).map(|(qr, exp, _)| (qr, exp, d.keys.fingerprint(), name))
    })?
    .ok_or("연결 기능을 켜지 못했어요.")?
    .map_err(|e| format!("QR 을 만들지 못했어요 ({e})."))?;
    net::start();
    net::reconcile_clients();
    let (qr, expires_at, fingerprint, name) = shown;
    let svg = crate::server::qr_svg(qr)?;
    Ok(json!({ "svg": svg, "expires_at": expires_at, "fingerprint": fingerprint, "desk_name": name,
               "lan": lan, "outside": !relays.is_empty() }))
}

#[tauri::command]
pub fn pairing_cancel_qr() -> Result<(), String> {
    net::with_desk(false, |d| d.host.cancel())?;
    Ok(())
}

/// 사장이 「허락」. 권한은 **여기서** 정한다(폰이 원한 것은 참고만).
#[tauri::command]
pub async fn pairing_approve(view: bool, request: bool, money: String, daily_limit_rvn: u64) -> Result<Value, String> {
    if money != "desktop" && money != "phone" {
        return Err("돈이 나가는 일의 방식을 다시 골라 주세요.".into());
    }
    if daily_limit_rvn > 1_000_000 {
        return Err("하루 한도가 너무 커요.".into());
    }
    let perms = Perms { view, request, money, daily_limit_rvn };
    let (extra, _) = net::with_desk(false, |d| (d.settings.extra_relays.clone(), ()))?.unwrap_or_default();
    let (lan, relays) = tokio::task::spawn_blocking(move || net::routes(&extra)).await.map_err(|e| e.to_string())?;
    let now = now_ms();
    let res = net::with_desk(false, |d| {
        let name = d.desk_name(shop_name().as_deref());
        let r = d.host.approve(&d.keys, &mut d.book, &perms, &name, lan.as_deref(), &relays, now, proto::SealOpts::default());
        if r.is_ok() {
            d.settings.last_routes = Some(json!({ "lan": lan, "relays": relays }));
            let _ = d.save_settings();
            let _ = d.save_peers();
        }
        r
    })?
    .ok_or("연결 기능이 켜져 있지 않아요.")?;
    match res {
        Ok((ev, peer)) => {
            net::publish(ev);
            net::reconcile_clients();
            Ok(json!({ "name": peer.name }))
        }
        Err(e) if e.0 == "pending_expired" => Err("허락할 수 있는 5분이 지났어요. 새 QR 로 다시 연결해 주세요.".into()),
        Err(_) => Err("기다리는 연결 요청이 없어요. 새 QR 로 다시 연결해 주세요.".into()),
    }
}

#[tauri::command]
pub fn pairing_reject() -> Result<(), String> {
    let now = now_ms();
    if let Some(Some(ev)) = net::with_desk(false, |d| d.host.deny(&d.keys, "denied", now, proto::SealOpts::default()))? {
        net::publish(ev);
    }
    Ok(())
}

/// 「연결 끊기」 — 이 컴퓨터에서는 **지금** 끊긴다. 폰에게도 알린다(닿으면).
#[tauri::command]
pub fn pairing_unpair(sign: String) -> Result<(), String> {
    let now = now_ms();
    if let Some(Some(ev)) = net::with_desk(false, |d| d.unpair(&sign, now))? {
        net::publish(ev);
    }
    net::reconcile_clients();
    Ok(())
}

/// 「폰 요청」 열기. 보내기면 기존 보내기 화면에 채울 값을 준다(사장이 거기서 다시 확인하고 보낸다).
#[tauri::command]
pub fn pairing_request_open(id: String) -> Result<Value, String> {
    net::with_desk(false, |d| {
        let r = d.request_mut(&id).ok_or("그 요청을 찾지 못했어요.")?;
        if !matches!(r.status.as_str(), "waiting" | "waiting_unlock" | "opened") {
            return Err("이미 처리한 요청이에요.".to_string());
        }
        r.status = "opened".into();
        let out = json!({ "id": r.id, "t": r.t, "body": r.body, "peer_name": r.peer_name });
        let _ = d.save_requests();
        Ok(out)
    })?
    .ok_or("연결 기능이 켜져 있지 않아요.")?
}

/// 사장이 연 요청을 끝냈다 — 보내기는 기존 화면에서 끝까지 보냈을 때(거래 번호),
/// 손님 QR 은 화면에 띄웠을 때. 폰에 「완료」.
#[tauri::command]
pub async fn pairing_request_done(id: String, txid: Option<String>) -> Result<(), String> {
    if let Some(t) = &txid {
        if !proto::is_hex(t, 32) {
            return Err("거래 번호 모양이 아니에요.".into());
        }
    }
    let now = now_ms();
    let mut works = Vec::new();
    net::with_desk(false, |d| {
        let peer = d
            .request_mut(&id)
            .filter(|r| r.status == "opened" && (txid.is_some() || r.t != "req.send"))
            .map(|r| {
                r.status = "done".into();
                r.txid = txid.clone();
                r.peer.clone()
            });
        let _ = d.save_requests();
        if let Some(peer) = peer {
            let mut body = json!({ "re": id, "status": "done" });
            if let Some(t) = &txid {
                body["txid"] = json!(t);
            }
            d.reply(&peer, &id, "req.status", body, now, &mut works);
        }
    })?;
    net::process(works).await;
    Ok(())
}

#[tauri::command]
pub async fn pairing_request_decline(id: String) -> Result<(), String> {
    let now = now_ms();
    let mut works = Vec::new();
    net::with_desk(false, |d| {
        let peer = d.request_mut(&id).filter(|r| matches!(r.status.as_str(), "waiting" | "waiting_unlock" | "opened")).map(|r| {
            r.status = "declined".into();
            r.peer.clone()
        });
        let _ = d.save_requests();
        if let Some(peer) = peer {
            d.reply(&peer, &id, "req.status", json!({ "re": id, "status": "rejected", "note": "declined" }), now, &mut works);
        }
    })?;
    net::process(works).await;
    Ok(())
}

/// 공개 Nostr 예비(기본 끔). 공개 중계는 내용은 못 보지만 언제 어느 기기끼리인지는 본다.
#[tauri::command]
pub fn pairing_set_public_backup(on: bool) -> Result<(), String> {
    net::with_desk(false, |d| {
        d.settings.public_backup = on;
        d.save_settings()
    })?
    .unwrap_or(Ok(()))?;
    net::reconcile_clients();
    Ok(())
}

/// 기다리는 「폰 요청」 수 — 화면 구석 알림이 10초마다 읽는다(가볍게).
#[tauri::command]
pub fn pairing_waiting() -> Value {
    let now = now_ms();
    net::with_desk(false, |d| {
        json!({ "requests": d.requests.iter().filter(|r| matches!(r.status.as_str(), "waiting" | "waiting_unlock")).count(),
                "pending": d.host.pending(now).is_some(),
                // 「손님 QR 띄우기」는 확인 없이 바로(규격 §11-8) — 화면이 보고 띄운다.
                "guestqr": d.requests.iter().filter(|r| r.t == "req.guestqr" && r.status == "waiting").map(|r| r.id.clone()).collect::<Vec<_>>() })
    })
    .ok()
    .flatten()
    .unwrap_or_else(|| json!({ "requests": 0, "pending": false, "guestqr": [] }))
}
