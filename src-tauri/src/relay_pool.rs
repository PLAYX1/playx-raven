//! **릴레이 연결 풀** — 릴레이마다 열린 웹소켓 하나를 앱 전체가 나눠 쓴다(11-12 「카톡처럼 평소에 쓸 만큼 빠르게」).
//!
//! ## 왜
//!
//! 예전에는 묻기·올리기마다 `connect_async` 로 새로 붙고 끊었다. 서울에서 바깥 릴레이 한 곳에 붙는 데만
//! 0.5~0.9초(TCP·TLS·웹소켓 손잡기)다. 이야기 화면은 글·이름표·방 목록·수정 글·지우기 요청을 따로 묻고,
//! 그때마다 다섯 곳에 새로 붙었다. 실측(talk_bench.rs): 광장 열기 → 첫 글 2.8~4.3초.
//! 폰은 같은 병을 연결 풀로 고쳤다(core/talk/socket-pool.ts, 7.9초 → 1.0초). 이것이 데스크탑 판이다.
//!
//! ## 어떻게
//!
//! - 주소마다 연결 하나를 맡는 일꾼(task)이 있다. 묻는 쪽은 명령(REQ·CLOSE·EVENT)만 넘긴다.
//! - **구독 번호는 풀이 새로 붙인다**(`q1-17`). 여러 물음이 같은 연결에서 섞여도 EVENT·EOSE·CLOSED 가 제 주인에게 간다.
//!   올리기는 글 번호로 OK 를 찾아 준다.
//! - 묻는 쪽이 끝나거나 **도중에 버려져도**(read_split 이 늦은 곳을 버린다) 구독을 CLOSE 한다(SubGuard).
//! - 한 연결에 동시에 열린 구독은 8개까지 — 넘으면 줄을 선다(릴레이마다 구독 수 한도가 있다).
//! - 20초마다 ping. 45초 동안 아무것도(pong 포함) 안 오면 죽은 연결로 보고 버린다 — 잠자고 깬 노트북이
//!   죽은 연결에 물음을 보내고 7초를 기다리지 않게, 물을 때도 같은 잣대로 본다.
//! - 구독·올리기가 하나도 없이 120초가 지나면 닫는다(폰과 같다).
//! - 붙지 못한 곳은 5초 동안 곧바로 실패를 돌려준다 — 죽은 릴레이 때문에 매번 7초를 기다리지 않는다.
//! - 끊기면 그 연결에 걸린 물음은 곧바로 끝나고, 다음 물음이 새로 붙는다.
//!
//! 🔴 서명 검사는 여기서 하지 않는다 — 받은 글은 그대로 넘기고, 읽는 쪽(`nostrpub::read_*`)이 예전처럼 본다.

use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};
use tokio::sync::{mpsc, oneshot, OwnedSemaphorePermit, Semaphore};

const CONNECT_TIMEOUT: Duration = Duration::from_secs(7);
const PING_EVERY: Duration = Duration::from_secs(20);
/// 이만큼 아무것도 안 들어왔으면 죽은 연결이다(ping 이 20초마다 가므로 산 연결은 늘 이보다 짧다).
const STALE: Duration = Duration::from_secs(45);
/// 구독도 올리기도 없이 이만큼 지나면 닫는다.
pub(crate) const IDLE_CLOSE: Duration = Duration::from_secs(120);
/// 붙지 못한 곳은 이 동안 곧바로 실패.
const DOWN_FOR: Duration = Duration::from_secs(5);
/// 한 연결에 동시에 열어 두는 구독 수.
const MAX_SUBS: usize = 8;

/// 구독 하나에 오는 것.
#[derive(Debug)]
pub(crate) enum Incoming {
    Event(Value),
    Eose,
    #[allow(dead_code)] // 까닭(auth-required 등)은 지금 읽는 쪽이 안 쓴다 — 진단 때 본다
    Closed(String),
    /// 연결이 끊겼거나 붙지 못했다.
    Gone(String),
}

enum Cmd {
    Req { sub: String, text: String, tx: mpsc::UnboundedSender<Incoming> },
    Close { sub: String },
    Publish { id: String, text: String, tx: oneshot::Sender<Result<(), String>> },
}

struct Conn {
    id: u64,
    tx: mpsc::UnboundedSender<Cmd>,
    open: AtomicBool,
    dead: AtomicBool,
    /// 마지막으로 무엇이든 받은 때(풀이 생긴 뒤 ms).
    last_rx: AtomicU64,
    subs: Arc<Semaphore>,
}

fn clock() -> u64 {
    static START: OnceLock<Instant> = OnceLock::new();
    START.get_or_init(Instant::now).elapsed().as_millis() as u64
}

impl Conn {
    fn touch(&self) {
        self.last_rx.store(clock(), Ordering::Relaxed);
    }
    fn stale(&self) -> bool {
        self.open.load(Ordering::Relaxed) && clock().saturating_sub(self.last_rx.load(Ordering::Relaxed)) > STALE.as_millis() as u64
    }
    fn usable(&self) -> bool {
        !self.dead.load(Ordering::Relaxed) && !self.tx.is_closed() && !self.stale()
    }
}

#[derive(Default)]
struct Pool {
    conns: HashMap<String, Arc<Conn>>,
    down: HashMap<String, Instant>,
}

fn pool() -> &'static Mutex<Pool> {
    static P: OnceLock<Mutex<Pool>> = OnceLock::new();
    P.get_or_init(Default::default)
}

static NEXT: AtomicU64 = AtomicU64::new(1);

/// 이 주소의 연결(없거나 죽었으면 새로 붙기 시작한다 — 붙는 동안 들어온 명령은 줄을 서 있다가 나간다).
fn get(url: &str) -> Result<Arc<Conn>, String> {
    let mut p = pool().lock().unwrap_or_else(|e| e.into_inner());
    if let Some(c) = p.conns.get(url) {
        if c.usable() {
            return Ok(c.clone());
        }
        c.dead.store(true, Ordering::Relaxed);
        p.conns.remove(url);
    }
    if let Some(at) = p.down.get(url) {
        if at.elapsed() < DOWN_FOR {
            return Err("연결 실패(조금 전에도 붙지 못했습니다)".into());
        }
        p.down.remove(url);
    }
    let (tx, rx) = mpsc::unbounded_channel();
    let conn = Arc::new(Conn {
        id: NEXT.fetch_add(1, Ordering::Relaxed),
        tx,
        open: AtomicBool::new(false),
        dead: AtomicBool::new(false),
        last_rx: AtomicU64::new(clock()),
        subs: Arc::new(Semaphore::new(MAX_SUBS)),
    });
    p.conns.insert(url.to_string(), conn.clone());
    let (u, c) = (url.to_string(), conn.clone());
    tokio::spawn(run(u, rx, c));
    Ok(conn)
}

fn forget(url: &str, id: u64) {
    let mut p = pool().lock().unwrap_or_else(|e| e.into_inner());
    if p.conns.get(url).is_some_and(|c| c.id == id) {
        p.conns.remove(url);
    }
}

/// 이 주소에 지금 **열린** 연결이 있나(붙는 중이면 false). read_split 이 짧게 기다릴지 정할 때 쓴다.
pub(crate) fn is_open(url: &str) -> bool {
    let p = pool().lock().unwrap_or_else(|e| e.into_inner());
    p.conns.get(url).is_some_and(|c| c.open.load(Ordering::Relaxed) && c.usable())
}

/// 미리 붙어 둔다(앱 시작·이야기 화면 열기). 안 쓰면 IDLE_CLOSE 뒤에 저절로 닫힌다.
pub(crate) fn warm(urls: &[String]) {
    for u in urls {
        let _ = get(u);
    }
}

/// 연결 하나를 맡는 일꾼.
async fn run(url: String, mut rx: mpsc::UnboundedReceiver<Cmd>, conn: Arc<Conn>) {
    use futures_util::{SinkExt, StreamExt};
    use tokio_tungstenite::tungstenite::Message;

    let ws = match tokio::time::timeout(CONNECT_TIMEOUT, tokio_tungstenite::connect_async(url.as_str())).await {
        Err(_) => Err("연결이 오래 걸립니다".to_string()),
        Ok(Err(e)) => Err(format!("연결 실패: {e}")),
        Ok(Ok((ws, _))) => Ok(ws),
    };
    let ws = match ws {
        Ok(ws) => ws,
        Err(why) => {
            pool().lock().unwrap_or_else(|e| e.into_inner()).down.insert(url.clone(), Instant::now());
            shut(&url, &conn, &mut rx, HashMap::new(), HashMap::new(), &why);
            return;
        }
    };
    conn.touch();
    conn.open.store(true, Ordering::Relaxed);
    let (mut sink, mut stream) = ws.split();
    let mut subs: HashMap<String, mpsc::UnboundedSender<Incoming>> = HashMap::new();
    let mut oks: HashMap<String, Vec<oneshot::Sender<Result<(), String>>>> = HashMap::new();
    let mut idle_since: Option<Instant> = Some(Instant::now());
    let mut ping = tokio::time::interval(PING_EVERY);
    ping.tick().await;
    let why: String = loop {
        tokio::select! {
            cmd = rx.recv() => {
                let Some(cmd) = cmd else { break "더 쓰는 곳이 없습니다".into() };
                let text = match cmd {
                    Cmd::Req { sub, text, tx } => { subs.insert(sub, tx); Some(text) }
                    Cmd::Close { sub } => subs.remove(&sub).map(|_| json!(["CLOSE", sub]).to_string()),
                    Cmd::Publish { id, text, tx } => { oks.entry(id).or_default().push(tx); Some(text) }
                };
                if let Some(t) = text {
                    if let Err(e) = sink.send(Message::Text(t.into())).await {
                        break format!("보내지 못했습니다: {e}");
                    }
                }
            }
            msg = stream.next() => {
                match msg {
                    None => break "연결이 끊겼습니다".into(),
                    Some(Err(e)) => break format!("받는 중 오류: {e}"),
                    Some(Ok(Message::Close(_))) => break "릴레이가 연결을 닫았습니다".into(),
                    Some(Ok(Message::Text(t))) => {
                        conn.touch();
                        if let Some(close) = route(&t, &mut subs, &mut oks) {
                            let _ = sink.send(Message::Text(json!(["CLOSE", close]).to_string().into())).await;
                        }
                    }
                    Some(Ok(_)) => conn.touch(),
                }
            }
            _ = ping.tick() => {
                // 묻다가 떠난 쪽(받는 곳이 닫힌 구독·OK 기다림)을 치운다 — 안 치우면 영영 「쓰는 중」이라 닫히지 않는다.
                let gone: Vec<String> = subs.iter().filter(|(_, tx)| tx.is_closed()).map(|(s, _)| s.clone()).collect();
                for s in gone {
                    subs.remove(&s);
                    let _ = sink.send(Message::Text(json!(["CLOSE", s]).to_string().into())).await;
                }
                oks.retain(|_, w| { w.retain(|t| !t.is_closed()); !w.is_empty() });
                if conn.stale() {
                    break "답이 없어 버렸습니다".into();
                }
                if idle_since.is_some_and(|t| t.elapsed() >= IDLE_CLOSE) {
                    let _ = sink.send(Message::Close(None)).await;
                    break "한동안 안 써서 닫았습니다".into();
                }
                if sink.send(Message::Ping(Vec::new().into())).await.is_err() {
                    break "ping 을 보내지 못했습니다".into();
                }
            }
        }
        if subs.is_empty() && oks.is_empty() {
            idle_since.get_or_insert_with(Instant::now);
        } else {
            idle_since = None;
        }
    };
    let _ = sink.close().await;
    shut(&url, &conn, &mut rx, subs, oks, &why);
}

/// 받은 글 한 줄을 주인에게 보낸다. 받을 곳이 없는 구독이면 그 번호를 돌려준다(CLOSE 보내라는 뜻).
fn route(
    text: &str,
    subs: &mut HashMap<String, mpsc::UnboundedSender<Incoming>>,
    oks: &mut HashMap<String, Vec<oneshot::Sender<Result<(), String>>>>,
) -> Option<String> {
    let v: Value = serde_json::from_str(text).ok()?;
    let a = v.as_array()?;
    let kind = a.first()?.as_str()?;
    let key = a.get(1)?.as_str()?.to_string();
    match kind {
        "EVENT" => {
            let e = a.get(2)?.clone();
            match subs.get(&key) {
                Some(tx) if tx.send(Incoming::Event(e)).is_ok() => None,
                Some(_) => {
                    subs.remove(&key);
                    Some(key)
                }
                None => None,
            }
        }
        "EOSE" => {
            if let Some(tx) = subs.get(&key) {
                let _ = tx.send(Incoming::Eose);
            }
            None
        }
        "CLOSED" => {
            if let Some(tx) = subs.remove(&key) {
                let _ = tx.send(Incoming::Closed(a.get(2).and_then(Value::as_str).unwrap_or("닫힘").to_string()));
            }
            None
        }
        "OK" => {
            let r = if a.get(2).and_then(Value::as_bool).unwrap_or(false) {
                Ok(())
            } else {
                Err(a.get(3).and_then(Value::as_str).unwrap_or("거절됨").to_string())
            };
            for w in oks.remove(&key).unwrap_or_default() {
                let _ = w.send(r.clone());
            }
            None
        }
        _ => None,
    }
}

/// 연결이 끝났다 — 걸려 있던 물음·올리기를 곧바로 끝내 준다(7초를 기다리게 두지 않는다).
fn shut(
    url: &str,
    conn: &Conn,
    rx: &mut mpsc::UnboundedReceiver<Cmd>,
    subs: HashMap<String, mpsc::UnboundedSender<Incoming>>,
    oks: HashMap<String, Vec<oneshot::Sender<Result<(), String>>>>,
    why: &str,
) {
    conn.dead.store(true, Ordering::Relaxed);
    forget(url, conn.id);
    rx.close();
    for (_, tx) in subs {
        let _ = tx.send(Incoming::Gone(why.to_string()));
    }
    for (_, ws) in oks {
        for w in ws {
            let _ = w.send(Err(why.to_string()));
        }
    }
    while let Ok(cmd) = rx.try_recv() {
        match cmd {
            Cmd::Req { tx, .. } => {
                let _ = tx.send(Incoming::Gone(why.to_string()));
            }
            Cmd::Publish { tx, .. } => {
                let _ = tx.send(Err(why.to_string()));
            }
            Cmd::Close { .. } => {}
        }
    }
}

/// 구독 하나. 버려지면(끝났든 도중에 버려졌든) CLOSE 를 보낸다.
pub(crate) struct Sub {
    conn: Arc<Conn>,
    sub: String,
    pub(crate) rx: mpsc::UnboundedReceiver<Incoming>,
    _permit: OwnedSemaphorePermit,
}
impl Drop for Sub {
    fn drop(&mut self) {
        let _ = self.conn.tx.send(Cmd::Close { sub: std::mem::take(&mut self.sub) });
    }
}

/// REQ 를 연다. `req` 는 `["REQ", <아무 번호>, 필터…]` — 번호는 풀이 새로 붙인다. 자리(구독 수)가 날 때까지 `deadline` 까지 기다린다.
pub(crate) async fn subscribe(url: &str, req: &str, deadline: tokio::time::Instant) -> Result<Sub, String> {
    let mut v: Value = serde_json::from_str(req).map_err(|_| "물음 모양이 올바르지 않습니다".to_string())?;
    let prefix: String = v.get(1).and_then(Value::as_str).unwrap_or("q").chars().take(8).collect();
    for attempt in 0..2 {
        let conn = get(url)?;
        let permit = tokio::time::timeout_at(deadline, conn.subs.clone().acquire_owned())
            .await
            .map_err(|_| "구독 자리가 나지 않습니다".to_string())?
            .map_err(|_| "연결이 닫혔습니다".to_string())?;
        let sub = format!("{prefix}-{}", NEXT.fetch_add(1, Ordering::Relaxed));
        if let Some(a) = v.as_array_mut() {
            if a.len() >= 2 {
                a[1] = json!(sub);
            }
        }
        let (tx, rx) = mpsc::unbounded_channel();
        if conn.tx.send(Cmd::Req { sub: sub.clone(), text: v.to_string(), tx }).is_ok() {
            return Ok(Sub { conn, sub, rx, _permit: permit });
        }
        // 일꾼이 이미 떠난 연결(시험마다 새 런타임 등) — 버리고 한 번 새로 붙는다.
        conn.dead.store(true, Ordering::Relaxed);
        forget(url, conn.id);
        if attempt == 1 {
            break;
        }
    }
    Err("연결 실패".into())
}

/// 서명된 글 하나를 올리고 그 글 번호의 OK 를 기다린다.
pub(crate) async fn publish(url: &str, msg: &str, id: &str, wait: Duration) -> Result<(), String> {
    let deadline = tokio::time::Instant::now() + wait;
    for attempt in 0..2 {
        let conn = get(url)?;
        let (tx, rx) = oneshot::channel();
        if conn.tx.send(Cmd::Publish { id: id.to_string(), text: msg.to_string(), tx }).is_err() {
            conn.dead.store(true, Ordering::Relaxed);
            forget(url, conn.id);
            if attempt == 1 {
                break;
            }
            continue;
        }
        return match tokio::time::timeout_at(deadline, rx).await {
            Err(_) => Err("답이 없습니다".into()),
            Ok(Err(_)) => Err("연결이 끊겼습니다".into()),
            Ok(Ok(r)) => r,
        };
    }
    Err("연결 실패".into())
}

/// 지금 풀에 있는 연결 수(시험·진단용).
#[cfg(test)]
pub(crate) fn open_count() -> usize {
    let p = pool().lock().unwrap_or_else(|e| e.into_inner());
    p.conns.values().filter(|c| c.open.load(Ordering::Relaxed) && c.usable()).count()
}

#[cfg(test)]
mod tests {
    use super::*;
    use futures_util::{SinkExt, StreamExt};
    use tokio_tungstenite::tungstenite::Message;

    /// 작은 가짜 릴레이: REQ 마다 그 번호로 EVENT 하나 + EOSE, EVENT 에는 OK. 연결 수를 센다.
    async fn fake_relay() -> (String, Arc<std::sync::atomic::AtomicUsize>, Arc<Mutex<Vec<String>>>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let conns = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let seen = Arc::new(Mutex::new(Vec::<String>::new()));
        let (c2, s2) = (conns.clone(), seen.clone());
        tokio::spawn(async move {
            while let Ok((tcp, _)) = listener.accept().await {
                c2.fetch_add(1, Ordering::SeqCst);
                let s3 = s2.clone();
                tokio::spawn(async move {
                    let Ok(mut ws) = tokio_tungstenite::accept_async(tcp).await else { return };
                    while let Some(Ok(m)) = ws.next().await {
                        let Message::Text(t) = m else { continue };
                        s3.lock().unwrap().push(t.to_string());
                        let v: Value = serde_json::from_str(&t).unwrap();
                        match v[0].as_str() {
                            Some("REQ") => {
                                let sub = v[1].as_str().unwrap().to_string();
                                let _ = ws.send(Message::Text(json!(["EVENT", sub, {"id": sub}]).to_string().into())).await;
                                let _ = ws.send(Message::Text(json!(["EOSE", sub]).to_string().into())).await;
                            }
                            Some("EVENT") => {
                                let id = v[1]["id"].as_str().unwrap_or("").to_string();
                                let _ = ws.send(Message::Text(json!(["OK", id, true, ""]).to_string().into())).await;
                            }
                            _ => {}
                        }
                    }
                });
            }
        });
        (format!("ws://{addr}"), conns, seen)
    }

    async fn ask(url: &str) -> (Vec<Value>, bool) {
        let deadline = tokio::time::Instant::now() + Duration::from_secs(3);
        let mut s = subscribe(url, r#"["REQ","t1",{"kinds":[1]}]"#, deadline).await.unwrap();
        let mut out = vec![];
        loop {
            match tokio::time::timeout_at(deadline, s.rx.recv()).await {
                Ok(Some(Incoming::Event(e))) => out.push(e),
                Ok(Some(Incoming::Eose)) => return (out, true),
                _ => return (out, false),
            }
        }
    }

    #[tokio::test]
    async fn 여러_물음이_연결_하나를_나눠_쓰고_제_답만_받는다() {
        let (url, conns, seen) = fake_relay().await;
        let (a, b, c) = tokio::join!(ask(&url), ask(&url), ask(&url));
        for (got, eose) in [&a, &b, &c] {
            assert!(*eose && got.len() == 1, "제 구독의 EVENT 하나 + EOSE");
        }
        let ids: std::collections::HashSet<String> = [&a, &b, &c].iter().map(|(g, _)| g[0]["id"].as_str().unwrap().to_string()).collect();
        assert_eq!(ids.len(), 3, "구독 번호는 물음마다 다르다");
        let _ = ask(&url).await;
        assert_eq!(conns.load(Ordering::SeqCst), 1, "네 번 물어도 연결은 하나");
        // 올리기도 같은 연결.
        let msg = json!(["EVENT", {"id": "abc"}]).to_string();
        assert_eq!(publish(&url, &msg, "abc", Duration::from_secs(3)).await, Ok(()));
        assert_eq!(conns.load(Ordering::SeqCst), 1);
        // 끝난 구독은 CLOSE 된다.
        tokio::time::sleep(Duration::from_millis(100)).await;
        let closes = seen.lock().unwrap().iter().filter(|t| t.starts_with("[\"CLOSE\"")).count();
        assert!(closes >= 4, "물음이 끝나면 CLOSE 를 보낸다({closes})");
        assert!(is_open(&url));
    }

    #[tokio::test]
    async fn 붙지_못한_곳은_곧바로_실패한다() {
        // 아무도 듣지 않는 자리.
        let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("ws://{}", l.local_addr().unwrap());
        drop(l);
        let t = Instant::now();
        let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
        let mut s = subscribe(&url, r#"["REQ","t1",{"kinds":[1]}]"#, deadline).await.unwrap();
        assert!(matches!(s.rx.recv().await, Some(Incoming::Gone(_))), "붙지 못하면 걸린 물음에 곧바로 알린다");
        assert!(subscribe(&url, r#"["REQ","t1",{}]"#, deadline).await.is_err(), "조금 전에 실패한 곳은 기다리지 않는다");
        assert!(t.elapsed() < Duration::from_secs(2));
        assert!(!is_open(&url));
    }
}
