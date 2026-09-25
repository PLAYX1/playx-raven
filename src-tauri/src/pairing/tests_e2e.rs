//! RV6 e2e 시험용 데스크톱 — **진짜** 릴레이(`relay::serve`) + **진짜** 연결 코드(`pairing_*` 명령,
//! `net`·`desk`·`host`)를 127.0.0.1 에 띄우고, 폰 코어(TS)의 진짜 코드가 붙어 보게 한다.
//! 폰 쪽 운전사: ravenvault `scripts/e2e-desktop-pairing.mjs`.
//!
//! 🔴 시험 전용(`cfg(test)` + `#[ignore]`) — 앱 묶음에 안 들어간다. 평소 `cargo test` 에서도 안 돈다.
//! 🔴 노드는 **가짜**(`FakeNode`) — 진짜 ravend·진짜 RVN·주인의 앱 자료 폴더에 절대 안 닿는다.
//!    `RV6_E2E_HOME` 이 임시 폴더가 아니면 시작하지 않는다.
//!
//! 같은 Wi-Fi 통로 주소는 `ws://10.66.66.66:<port>/api/relay` 로 알린다(사설 IP 모양이라
//! 운영 검사를 **그대로** 통과한다). 폰 운전사의 소켓 공장이 그 주소 하나만 127.0.0.1 로 돌린다.
//!
//! 실행(운전사가 대신 한다):
//!   RV6_E2E_HOME=/tmp/.../app [RV6_E2E_PORT=nnnn] <lib 시험 바이너리> \
//!     pairing::tests_e2e::e2e_host --exact --ignored --nocapture --test-threads=1
//! stdin 한 줄 = 명령 하나, stdout `E2E {json}` 한 줄 = 답/알림 하나.
//!   state · qr · approve <view> <request> <desktop|phone> <limit> · reject · unpair <sign>
//!   drops · requests · sends · quit

use super::desk::{Backend, BoxFut};
use super::net;
use serde_json::{json, Value};
use std::io::Write;
use std::sync::Mutex;

/// 가짜 지갑의 「비밀」— 절대 밖으로 나가면 안 되는 값. 운전사가 모든 파일·기록에서 이 글자를 찾는다.
pub const FAKE_MNEMONIC: &str = "zebra quartz umbrella violin walnut xenon yodel zipper amber bishop cobalt dolphin";
pub const FAKE_WIF: &str = "L1e2eFakeWifDoNotLeak9QmZ8xYwVuTsRqPoNmLkJiHgFeDcBa";
pub const FAKE_PASSPHRASE: &str = "e2e-fake-wallet-passphrase-7731";

static SENDS: Mutex<Vec<Value>> = Mutex::new(Vec::new());
static OUT: Mutex<()> = Mutex::new(());

fn say(v: Value) {
    let _g = OUT.lock().unwrap_or_else(|e| e.into_inner());
    let mut o = std::io::stdout().lock();
    let _ = writeln!(o, "E2E {v}");
    let _ = o.flush();
}

/// 가짜 노드. 잔액·자산·증명서·매출은 고정값, 보내기는 **기록만** 하고 가짜 거래 번호를 준다.
struct FakeNode {
    /// 들고만 있다(어느 메서드도 이것을 돌려주지 않는다) — 새면 운전사의 찾기에 걸린다.
    #[allow(dead_code)]
    secrets: [&'static str; 3],
}

impl Backend for FakeNode {
    fn wallet(&self) -> BoxFut<'_, Result<Value, String>> {
        Box::pin(async {
            Ok(json!({ "balance_rvn": 1234.5678, "assets": [
                { "name": "E2E.COFFEE", "amount": 12.0 },
                { "name": "E2E.TICKET", "amount": 3.0 }
            ] }))
        })
    }
    fn certs(&self) -> Result<Vec<Value>, String> {
        Ok(vec![
            json!({ "id": "cert-e2e-1", "name": "E2E 수료증", "date": 1_790_000_000_000i64, "count": 5 }),
            json!({ "id": "cert-e2e-2", "name": "E2E 참가증", "date": 1_790_100_000_000i64, "count": 1 }),
        ])
    }
    fn sales(&self, _now: i64, _tz: i64) -> Result<Value, String> {
        Ok(json!({ "today": { "rvn": 42.5, "count": 3 }, "month": { "rvn": 777.25, "count": 31 } }))
    }
    fn wallet_locked(&self) -> BoxFut<'_, Result<bool, String>> {
        Box::pin(async { Ok(false) })
    }
    fn send_rvn<'a>(&'a self, to: &'a str, amount_rvn: f64) -> BoxFut<'a, Result<String, String>> {
        Box::pin(async move {
            let n = {
                let mut g = SENDS.lock().unwrap_or_else(|e| e.into_inner());
                g.push(json!({ "to": to, "amount_rvn": amount_rvn }));
                g.len()
            };
            let txid = format!("{:064x}", 0xe2e0_0000u64 + n as u64);
            say(json!({ "ev": "fake_send", "n": n, "to": to, "amount_rvn": amount_rvn, "txid": txid }));
            Ok(txid)
        })
    }
}

fn safe_home() -> std::path::PathBuf {
    let home = std::env::var("RV6_E2E_HOME").expect("RV6_E2E_HOME 이 필요해요(임시 폴더)");
    let p = std::path::PathBuf::from(&home);
    let s = home.replace('\\', "/");
    let tmp = s.starts_with("/tmp/") || s.starts_with("/private/tmp/") || s.starts_with("/var/folders/") || s.starts_with("/private/var/folders/");
    assert!(tmp && !s.contains("Application Support") && !s.contains("/Raven"), "RV6_E2E_HOME 은 임시 폴더여야 해요: {home}");
    std::fs::create_dir_all(&p).unwrap();
    p
}

async fn run(line: &str) -> Value {
    let a: Vec<&str> = line.split_whitespace().collect();
    let now = super::now_ms();
    match a.first().copied().unwrap_or("") {
        "state" => super::pairing_state(None).map(|v| json!({ "state": v })).unwrap_or_else(|e| json!({ "error": e })),
        // pairing_show_qr 과 같은 길(통로 → Desk::show_qr → 켜기). 화면 SVG 대신 QR 글자를 준다.
        "qr" => {
            let extra = net::with_desk(true, |d| d.settings.extra_relays.clone()).ok().flatten().unwrap_or_default();
            let (lan, relays) = net::routes(&extra);
            let r = net::with_desk(true, |d| {
                let name = d.desk_name(None);
                d.show_qr(&name, lan.as_deref(), &relays, now).map(|(qr, exp, _)| (qr, exp, d.keys.fingerprint()))
            });
            net::start();
            net::reconcile_clients();
            match r {
                Ok(Some(Ok((qr, exp, fp)))) => {
                    let svg_ok = crate::server::qr_svg(qr.clone()).is_ok();
                    json!({ "qr": qr, "expires_at": exp, "fingerprint": fp, "svg_ok": svg_ok })
                }
                other => json!({ "error": format!("{other:?}") }),
            }
        }
        "approve" if a.len() == 5 => {
            let limit = a[4].parse::<u64>().unwrap_or(0);
            match super::pairing_approve(a[1] == "true", a[2] == "true", a[3].to_string(), limit).await {
                Ok(v) => json!({ "ok": v }),
                Err(e) => json!({ "error": e }),
            }
        }
        "reject" => super::pairing_reject().map(|_| json!({ "ok": true })).unwrap_or_else(|e| json!({ "error": e })),
        "unpair" if a.len() == 2 => super::pairing_unpair(a[1].to_string()).map(|_| json!({ "ok": true })).unwrap_or_else(|e| json!({ "error": e })),
        "drops" => {
            let d = net::with_desk(false, |d| d.drops.iter().map(|(k, v)| (k.to_string(), json!(v))).collect::<serde_json::Map<String, Value>>());
            json!({ "drops": d.ok().flatten().map(Value::Object).unwrap_or(Value::Null) })
        }
        "requests" => {
            let r = net::with_desk(false, |d| serde_json::to_value(&d.requests).unwrap_or(Value::Null));
            json!({ "requests": r.ok().flatten().unwrap_or(Value::Null) })
        }
        "sends" => json!({ "sends": SENDS.lock().unwrap_or_else(|e| e.into_inner()).clone() }),
        "quit" => {
            say(json!({ "cmd": "quit", "ok": true }));
            std::process::exit(0);
        }
        _ => json!({ "error": "unknown command" }),
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "e2e 시험용 데스크톱 — 폰 운전사(scripts/e2e-desktop-pairing.mjs)가 켠다"]
async fn e2e_host() {
    let home = safe_home();
    std::env::set_var("PLAYX_RAVEN_HOME", &home);
    assert!(net::TEST_BACKEND.set(Box::new(FakeNode { secrets: [FAKE_MNEMONIC, FAKE_WIF, FAKE_PASSPHRASE] })).is_ok());

    let port: u16 = std::env::var("RV6_E2E_PORT").ok().and_then(|p| p.parse().ok()).unwrap_or(0);
    let app = axum::Router::new().route(
        "/api/relay",
        axum::routing::get(|ws: axum::extract::ws::WebSocketUpgrade| async { ws.on_upgrade(crate::relay::serve) }),
    );
    let l = tokio::net::TcpListener::bind(("127.0.0.1", port)).await.expect("bind 127.0.0.1");
    let port = l.local_addr().unwrap().port();
    tokio::spawn(async move { axum::serve(l, app).await.unwrap() });
    *net::TEST_LAN.lock().unwrap() = Some(format!("ws://10.66.66.66:{port}/api/relay"));

    // 앱이 켜질 때처럼: 연결한 적이 있으면 장부를 열고 5초 도는 일을 시작한다.
    net::start();
    net::reconcile_clients();
    say(json!({ "ev": "ready", "port": port, "home": home, "ever_enabled": net::ever_enabled() }));

    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<String>();
    std::thread::spawn(move || {
        let stdin = std::io::stdin();
        let mut line = String::new();
        loop {
            line.clear();
            match stdin.read_line(&mut line) {
                Ok(0) | Err(_) => std::process::exit(0), // 운전사가 사라지면 같이 끝난다
                Ok(_) => {
                    if tx.send(line.trim().to_string()).is_err() {
                        return;
                    }
                }
            }
        }
    });
    while let Some(line) = rx.recv().await {
        let (id, cmd) = line.split_once(' ').unwrap_or((line.as_str(), ""));
        let mut out = run(cmd).await;
        out["id"] = json!(id);
        say(out);
    }
}
