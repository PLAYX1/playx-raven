//! 미니 창의 **판단**만 모은 곳 — 창·노드·OS 를 모른다(그래서 전부 시험할 수 있다).
//!
//! 대표님: "레이븐볼트 데스크탑을 애플 뮤직 미니 플레이어처럼 화면에 아주 작게 띄울 수
//! 있으면 좋겠다. 크기별로 보여 주고, 입금이나 변화가 있으면 실시간으로 알려 줘."
//!
//! 여기서 정하는 것:
//!   · 지갑 거래 줄 → 「입금 감지(0확인)」·「입금 확인됨(N확인)」·「입금이 사라짐(충돌)」
//!   · 노드 숫자 → 「응답 없음」·「연결 끊김」·「동기화 멈춤」·「다시 정상」(한 번 흔들림은 무시)
//!   · 알림 묶기·속도 제한(폭주 방지)
//!   · 🔴 **가리기** — 금액·자산 이름은 가림이 켜져 있으면 이 파일 밖으로 **나가지 않는다.**
//!     창(webview)도 OS 알림도 가려진 값만 받는다. 화면 공유·어깨너머·잠금 화면 알림 보호.
//!
//! 비밀(복구 단어·암호·열쇠)은 여기 들어오지도 나가지도 않는다 — 다루는 것은 공개 장부의
//! 거래 줄(listsinceblock)과 노드 숫자뿐이다.

use serde::Serialize;
use serde_json::{json, Value};
use std::collections::{HashMap, VecDeque};

/// 한 번에 기억하는 거래 줄 상한. 커다란 지갑이 메모리를 먹지 않게.
const MAX_TRACKED: usize = 4096;
/// 노드 블록 높이가 이만큼 그대로면 「동기화 멈춤」. 레이븐 블록은 약 1분 —
/// 15분 동안 블록이 없을 확률은 e^-15 ≈ 3×10⁻⁷ 이라 거짓 경보가 사실상 없다.
pub const STALL_SECS: i64 = 15 * 60;
/// OS 알림 사이 최소 간격(초). 그 사이 생긴 일은 다음 알림 한 장에 묶인다.
pub const NOTIFY_GAP_SECS: i64 = 60;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Kind {
    /// 들어온 거래를 처음 봄(0확인 또는 확인 수 미달).
    DepositSeen,
    /// 확인 수가 기준(need)에 닿음.
    DepositConfirmed,
    /// 확인 수가 음수 — 같은 돈을 쓴 다른 거래가 블록에 들어갔다(입금 취소 가능성).
    DepositDropped,
    /// 판매자 모드: 손님 주문이 들어옴(돈은 아직일 수 있음).
    Order,
    NodeDown,
    NodeDisconnected,
    NodeStalled,
    NodeRecovered,
    /// 잠들지 않게 붙잡아야 하는데 못 붙잡고 있음(장사 모드).
    AwakeLost,
}

impl Kind {
    fn rank(self) -> u8 {
        match self {
            Kind::DepositDropped => 0,
            Kind::NodeDown | Kind::NodeDisconnected | Kind::NodeStalled | Kind::AwakeLost => 1,
            Kind::DepositConfirmed => 2,
            Kind::DepositSeen => 3,
            Kind::Order => 4,
            Kind::NodeRecovered => 5,
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct Event {
    pub kind: Kind,
    /// 금액(절댓값). 노드 이벤트는 None.
    pub amount: Option<f64>,
    /// 자산 이름. RVN 이면 None.
    pub asset: Option<String>,
    /// 판매 입금(주문 주소로 들어온 돈)인가.
    pub sale: bool,
    pub at: i64,
}

impl Event {
    pub fn node(kind: Kind, at: i64) -> Self {
        Self { kind, amount: None, asset: None, sale: false, at }
    }
}

/// 지갑 거래 한 줄에서 쓰는 것만. 주소·txid 는 화면으로 내보내지 않는다.
#[derive(Clone, Debug, PartialEq)]
pub struct Row {
    pub key: String,
    pub incoming: bool,
    pub amount: f64,
    pub asset: Option<String>,
    pub confirmations: i64,
    pub time: i64,
    pub sale: bool,
}

/// listsinceblock 답(`transactions` + `asset_transactions`)을 줄로. 모양이 다르면 빈 목록.
pub fn rows_from_listsinceblock(v: &Value) -> Vec<Row> {
    ["transactions", "asset_transactions"]
        .iter()
        .flat_map(|k| v[*k].as_array().into_iter().flatten())
        .take(MAX_TRACKED)
        .filter_map(row_from)
        .collect()
}

fn row_from(t: &Value) -> Option<Row> {
    let category = t["category"].as_str()?;
    let incoming = match category {
        "receive" => true,
        "send" => false,
        // generate/immature(채굴)·orphan 등은 미니 창 「변화」로 세지 않는다.
        _ => return None,
    };
    let txid = t["txid"].as_str().filter(|s| !s.is_empty() && s.len() <= 128)?;
    let asset = t["asset_name"].as_str().filter(|s| !s.is_empty() && *s != "RVN").map(str::to_string);
    let vout = t["vout"].as_i64().unwrap_or(-1);
    let label = t["label"].as_str().unwrap_or("");
    Some(Row {
        key: format!("{txid}:{vout}:{}:{}", asset.as_deref().unwrap_or("RVN"), if incoming { "in" } else { "out" }),
        incoming,
        amount: t["amount"].as_f64().unwrap_or(0.0).abs(),
        asset,
        confirmations: t["confirmations"].as_i64().unwrap_or(0),
        time: t["time"].as_i64().or_else(|| t["timereceived"].as_i64()).unwrap_or(0),
        // shop.rs incoming_payments 와 같은 판정: 주문 주소 표(label)가 곧 주문번호다.
        sale: incoming && (label == "order" || label.starts_with("sell:")),
    })
}

/// 들어온 돈의 상태를 따라간다. 처음 한 바퀴(기준선)는 알리지 않는다 — 켤 때 이미 있던
/// 입금을 「새 입금」이라 하면 거짓말이다(main.ts 지갑감시와 같은 규칙).
#[derive(Default)]
pub struct Tracker {
    rows: HashMap<String, Row>,
    order: VecDeque<String>,
    /// 이미 「확인됨」을 알린 열쇠.
    confirmed: std::collections::HashSet<String>,
    /// 이미 「감지」를 알린 열쇠.
    seen: std::collections::HashSet<String>,
    baseline: bool,
}

impl Tracker {
    pub fn has_baseline(&self) -> bool {
        self.baseline
    }

    /// 새로 읽은 줄을 넣고, 알릴 일을 돌려준다.
    pub fn ingest(&mut self, rows: Vec<Row>, need: i64, now: i64) -> Vec<Event> {
        let need = need.max(1);
        let first = !self.baseline;
        let mut out = Vec::new();
        for r in rows {
            let key = r.key.clone();
            if r.incoming && !first {
                let ev = |kind| Event { kind, amount: Some(r.amount), asset: r.asset.clone(), sale: r.sale, at: now };
                if r.confirmations < 0 {
                    // 한 번 감지를 알렸던 것만 「사라짐」을 알린다.
                    if self.seen.contains(&key) && !self.confirmed.contains(&key) && self.rows.get(&key).map(|o| o.confirmations >= 0).unwrap_or(false) {
                        out.push(ev(Kind::DepositDropped));
                    }
                } else if r.confirmations >= need {
                    if !self.confirmed.contains(&key) {
                        self.confirmed.insert(key.clone());
                        self.seen.insert(key.clone());
                        out.push(ev(Kind::DepositConfirmed));
                    }
                } else if !self.seen.contains(&key) {
                    self.seen.insert(key.clone());
                    out.push(ev(Kind::DepositSeen));
                }
            } else if r.incoming && first {
                self.seen.insert(key.clone());
                if r.confirmations >= need {
                    self.confirmed.insert(key.clone());
                }
            }
            if !self.rows.contains_key(&key) {
                self.order.push_back(key.clone());
            }
            self.rows.insert(key, r);
        }
        while self.order.len() > MAX_TRACKED {
            if let Some(k) = self.order.pop_front() {
                self.rows.remove(&k);
                self.confirmed.remove(&k);
                self.seen.remove(&k);
            }
        }
        self.baseline = true;
        out
    }

    /// 최근 변화 n건(새것부터). 확인 0 짜리는 시간이 없을 수 있어 받은 순서로 보탠다.
    pub fn recent(&self, n: usize) -> Vec<&Row> {
        let mut v: Vec<(usize, &Row)> = self
            .order
            .iter()
            .enumerate()
            .filter_map(|(i, k)| self.rows.get(k).map(|r| (i, r)))
            .filter(|(_, r)| r.confirmations >= 0)
            .collect();
        v.sort_by(|a, b| b.1.time.cmp(&a.1.time).then(b.0.cmp(&a.0)));
        v.into_iter().take(n).map(|(_, r)| r).collect()
    }

    /// 오늘(현지 날짜 — tz 분 오프셋) 판매·입금 요약. RVN 만 합한다(자산은 건수만).
    pub fn today(&self, now: i64, tz_minutes: i32) -> Today {
        let day = |t: i64| (t + tz_minutes as i64 * 60).div_euclid(86_400);
        let today = day(now);
        let mut s = Today::default();
        for r in self.rows.values() {
            if !r.incoming || r.confirmations < 0 {
                continue;
            }
            // 0확인 줄은 time 이 비어 있을 수 있다 — 지금 들어온 것으로 본다.
            let t = if r.time > 0 { r.time } else { now };
            if day(t) != today {
                continue;
            }
            if r.sale {
                s.sales += 1;
                if r.asset.is_none() {
                    s.sales_rvn += r.amount;
                }
            } else {
                s.deposits += 1;
                if r.asset.is_none() {
                    s.deposits_rvn += r.amount;
                }
            }
            if r.confirmations == 0 {
                s.pending += 1;
            }
        }
        s
    }
}

#[derive(Default, Debug, PartialEq, Clone)]
pub struct Today {
    pub sales: u32,
    pub sales_rvn: f64,
    pub deposits: u32,
    pub deposits_rvn: f64,
    pub pending: u32,
}

/// 노드 상태. 한 번 흔들림(타임아웃 하나)은 무시하고 두 번 연속일 때만 알린다.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum NodeState {
    Unknown,
    Ok,
    Syncing,
    Rescanning,
    Down,
    Disconnected,
    Stalled,
}

#[derive(Default)]
pub struct Health {
    pub state: Option<NodeState>,
    errors: u8,
    zero_peers: u8,
    last_height: Option<u64>,
    height_since: i64,
    pub blocks: Option<u64>,
    pub peers: Option<i64>,
    pub behind: Option<u64>,
    /// 한 번이라도 정상(또는 따라잡는 중)으로 답했나. 그 전의 나쁨은 알리지 않는다.
    ever_ok: bool,
    last_obs: i64,
}

impl Health {
    pub fn current(&self) -> NodeState {
        self.state.unwrap_or(NodeState::Unknown)
    }

    fn set(&mut self, next: NodeState, now: i64) -> Option<Event> {
        let prev = self.current();
        self.state = Some(next);
        let bad = |s: NodeState| matches!(s, NodeState::Down | NodeState::Disconnected | NodeState::Stalled);
        if prev == next {
            return None;
        }
        // 켤 때는 노드가 아직 뜨는 중이다(boot.rs). 한 번도 제대로 답한 적 없는 노드의 「응답 없음」
        // 「연결 0」은 알리지 않고 화면 상태로만 둔다 — 켤 때마다 경보가 울리면 아무도 안 믿는다.
        let was_ok = self.ever_ok;
        if matches!(next, NodeState::Ok | NodeState::Syncing) {
            self.ever_ok = true;
        }
        if !was_ok {
            return None;
        }
        match next {
            NodeState::Down => Some(Event::node(Kind::NodeDown, now)),
            NodeState::Disconnected => Some(Event::node(Kind::NodeDisconnected, now)),
            NodeState::Stalled => Some(Event::node(Kind::NodeStalled, now)),
            NodeState::Ok | NodeState::Syncing if bad(prev) => Some(Event::node(Kind::NodeRecovered, now)),
            _ => None,
        }
    }

    /// 노드가 「되살리는 중(rescan)」이라 답을 미룸 — 고장이 아니다.
    pub fn rescanning(&mut self, now: i64) -> Option<Event> {
        self.errors = 0;
        self.set(NodeState::Rescanning, now)
    }

    pub fn error(&mut self, now: i64) -> Option<Event> {
        self.errors = self.errors.saturating_add(1);
        if self.errors >= 2 {
            self.blocks = None;
            self.peers = None;
            return self.set(NodeState::Down, now);
        }
        None
    }

    pub fn observe(&mut self, blocks: u64, headers: u64, peers: i64, now: i64) -> Option<Event> {
        self.errors = 0;
        self.blocks = Some(blocks);
        self.peers = Some(peers);
        let behind = headers.saturating_sub(blocks);
        self.behind = Some(behind);
        // 컴퓨터가 잠들었다 깨면(관찰 사이가 5분 넘게 빔) 그 사이는 노드 잘못이 아니다 — 시계를 다시 잰다.
        if self.last_height != Some(blocks) || now - self.last_obs > 300 {
            self.last_height = Some(blocks);
            self.height_since = now;
        }
        self.last_obs = now;
        if peers <= 0 {
            self.zero_peers = self.zero_peers.saturating_add(1);
            if self.zero_peers >= 2 {
                return self.set(NodeState::Disconnected, now);
            }
            return None;
        }
        self.zero_peers = 0;
        if now - self.height_since >= STALL_SECS {
            return self.set(NodeState::Stalled, now);
        }
        self.set(if behind > 2 { NodeState::Syncing } else { NodeState::Ok }, now)
    }
}

/// 알림 묶음. 이벤트를 모았다가 `flush` 때 한 장으로. OS 알림은 `NOTIFY_GAP_SECS` 에 한 번까지.
#[derive(Default)]
pub struct Bundler {
    queue: Vec<Event>,
    last_sent: Option<i64>,
}

impl Bundler {
    pub fn push(&mut self, e: Event) {
        // 폭주 방지: 아무리 쌓여도 200개까지만 들고 있는다(세는 것은 묶음에서 한다).
        if self.queue.len() < 200 {
            self.queue.push(e);
        }
    }
    #[cfg_attr(not(test), allow(dead_code))]
    pub fn pending(&self) -> usize {
        self.queue.len()
    }
    /// 보낼 때가 됐으면 묶음 하나를 꺼낸다. 아니면 그대로 들고 있는다.
    pub fn flush(&mut self, now: i64) -> Option<Vec<Event>> {
        if self.queue.is_empty() {
            return None;
        }
        if let Some(t) = self.last_sent {
            if now - t < NOTIFY_GAP_SECS {
                return None;
            }
        }
        self.last_sent = Some(now);
        Some(std::mem::take(&mut self.queue))
    }
}

/// 알림 한 장의 글. 🔴 `masked` 면 금액·자산 이름이 **절대** 들어가지 않는다.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Notice {
    pub kind: Kind,
    pub count: usize,
    pub title: String,
    pub body: String,
}

pub fn ko(locale: &str) -> bool {
    !locale.starts_with("en")
}

pub fn fmt_amount(v: f64) -> String {
    let s = format!("{:.8}", v);
    let s = s.trim_end_matches('0').trim_end_matches('.');
    // 세 자리마다 쉼표(정수부만).
    let (int, frac) = s.split_once('.').map(|(a, b)| (a, Some(b))).unwrap_or((s, None));
    let mut out = String::new();
    for (i, c) in int.chars().enumerate() {
        if i > 0 && (int.len() - i) % 3 == 0 {
            out.push(',');
        }
        out.push(c);
    }
    match frac {
        Some(f) => format!("{out}.{f}"),
        None => out,
    }
}

fn what(e: &Event) -> String {
    let n = e.amount.map(fmt_amount).unwrap_or_default();
    format!("{n} {}", e.asset.as_deref().unwrap_or("RVN"))
}

/// 묶인 이벤트 → 알림 한 장. 가장 급한 종류가 제목이 되고, 나머지는 「외 N건」.
pub fn notice(events: &[Event], masked: bool, locale: &str) -> Option<Notice> {
    let top = events.iter().min_by_key(|e| e.kind.rank())?;
    let same: Vec<&Event> = events.iter().filter(|e| e.kind == top.kind).collect();
    let others = events.len() - same.len();
    let k = ko(locale);
    let n = same.len();
    let sale = same.iter().all(|e| e.sale);
    let (title, body) = match top.kind {
        Kind::DepositSeen | Kind::DepositConfirmed | Kind::DepositDropped => {
            let (t_ko, t_en) = match (top.kind, sale) {
                (Kind::DepositSeen, false) => ("입금 감지", "Incoming payment"),
                (Kind::DepositSeen, true) => ("판매 입금 감지", "Sale payment incoming"),
                (Kind::DepositConfirmed, false) => ("입금 확인됨", "Payment confirmed"),
                (Kind::DepositConfirmed, true) => ("판매 입금 확인됨", "Sale payment confirmed"),
                _ => ("입금이 취소됐을 수 있어요", "A payment may have been reversed"),
            };
            let body = if masked {
                match (top.kind, k, n) {
                    (Kind::DepositDropped, true, _) => "큰 화면에서 확인해 주세요.".to_string(),
                    (Kind::DepositDropped, false, _) => "Please check in the main window.".to_string(),
                    (Kind::DepositConfirmed, true, 1) => "입금이 확인됐어요.".to_string(),
                    (Kind::DepositConfirmed, true, n) => format!("입금 {n}건이 확인됐어요."),
                    (Kind::DepositConfirmed, false, 1) => "A payment was confirmed.".to_string(),
                    (Kind::DepositConfirmed, false, n) => format!("{n} payments were confirmed."),
                    (_, true, 1) => "입금이 있어요.".to_string(),
                    (_, true, n) => format!("입금 {n}건이 있어요."),
                    (_, false, 1) => "You have an incoming payment.".to_string(),
                    (_, false, n) => format!("You have {n} incoming payments."),
                }
            } else {
                let first = what(same[0]);
                match (k, n) {
                    (_, 1) => first,
                    (true, n) => format!("{first} 외 {}건", n - 1),
                    (false, n) => format!("{first} and {} more", n - 1),
                }
            };
            (if k { t_ko } else { t_en }.to_string(), body)
        }
        Kind::Order => (
            if k { "새 주문" } else { "New order" }.to_string(),
            match (k, n) {
                (true, 1) => "손님 주문이 들어왔어요.".to_string(),
                (true, n) => format!("손님 주문 {n}건이 들어왔어요."),
                (false, 1) => "A customer placed an order.".to_string(),
                (false, n) => format!("Customers placed {n} orders."),
            },
        ),
        Kind::NodeDown => tr(k, "노드가 답하지 않아요", "Node not responding", "입금 감지가 멈췄어요. 큰 화면에서 확인해 주세요.", "Payment detection has paused. Check the main window."),
        Kind::NodeDisconnected => tr(k, "인터넷 연결이 끊겼어요", "Disconnected from network", "0확인 입금은 믿지 마세요. 확인될 때까지 기다리세요.", "Do not trust unconfirmed payments until it reconnects."),
        Kind::NodeStalled => tr(k, "동기화가 멈췄어요", "Sync has stalled", "15분 넘게 새 블록이 없어요.", "No new block for over 15 minutes."),
        Kind::NodeRecovered => tr(k, "노드가 다시 정상이에요", "Node is back", "입금 감지를 다시 하고 있어요.", "Payment detection resumed."),
        Kind::AwakeLost => tr(k, "컴퓨터가 잠들 수 있어요", "This computer may sleep", "잠들면 밤사이 입금 확인이 멈춰요.", "If it sleeps, overnight payments won't be checked."),
    };
    let body = if others > 0 {
        if k { format!("{body} (다른 소식 {others}건)") } else { format!("{body} (+{others} other)") }
    } else {
        body
    };
    Some(Notice { kind: top.kind, count: events.len(), title, body })
}

fn tr(k: bool, t_ko: &str, t_en: &str, b_ko: &str, b_en: &str) -> (String, String) {
    if k { (t_ko.into(), b_ko.into()) } else { (t_en.into(), b_en.into()) }
}

/// 미니 창으로 보내는 한 장. 🔴 가림이 켜져 있으면 금액·자산 이름 자리는 `null`.
pub struct SnapshotIn<'a> {
    pub masked: bool,
    pub locale: &'a str,
    pub now: i64,
    pub tz: i32,
    pub balance: Option<(f64, f64)>,
    pub tracker: &'a Tracker,
    pub health: &'a Health,
    pub lock: &'a str,
    pub awake_holding: bool,
    pub awake_note: &'a str,
    pub seller: bool,
    pub unseen: u32,
    pub need: i64,
}

pub fn snapshot(i: &SnapshotIn) -> Value {
    let m = i.masked;
    let hide = |s: String| if m { Value::Null } else { Value::String(s) };
    let recent: Vec<Value> = i
        .tracker
        .recent(5)
        .into_iter()
        .map(|r| {
            json!({
                "dir": if r.incoming { "in" } else { "out" },
                "sale": r.sale,
                "amount": hide(format!("{}{}", if r.incoming { "+" } else { "−" }, fmt_amount(r.amount))),
                "unit": hide(r.asset.clone().unwrap_or_else(|| "RVN".into())),
                "conf": r.confirmations,
                "done": r.confirmations >= i.need.max(1),
                "ago": if r.time > 0 { (i.now - r.time).max(0) } else { 0 },
            })
        })
        .collect();
    let node = i.health.current();
    let status = match node {
        NodeState::Ok => "ok",
        NodeState::Syncing | NodeState::Rescanning | NodeState::Unknown => "warn",
        _ => "bad",
    };
    let seller = if i.seller {
        let t = i.tracker.today(i.now, i.tz);
        json!({
            "sales": t.sales,
            "sales_rvn": hide(fmt_amount(t.sales_rvn)),
            "deposits": t.deposits,
            "deposits_rvn": hide(fmt_amount(t.deposits_rvn)),
            "pending": t.pending,
        })
    } else {
        Value::Null
    };
    json!({
        "masked": m,
        "locale": i.locale,
        "status": status,
        "node": {
            "state": node,
            "blocks": i.health.blocks,
            "peers": i.health.peers,
            "behind": i.health.behind,
        },
        "balance": match i.balance {
            Some((c, u)) => json!({ "known": true, "confirmed": hide(fmt_amount(c)), "pending": hide(fmt_amount(u)), "has_pending": u > 0.0 }),
            None => json!({ "known": false, "confirmed": null, "pending": null, "has_pending": false }),
        },
        "recent": recent,
        "lock": i.lock,
        "awake": { "holding": i.awake_holding, "note": i.awake_note },
        "seller": seller,
        "unseen": i.unseen,
        "need": i.need.max(1),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tx(txid: &str, cat: &str, amount: f64, conf: i64, label: &str, asset: Option<&str>) -> Value {
        let mut v = json!({"txid": txid, "category": cat, "amount": amount, "confirmations": conf, "vout": 0, "time": 1_000, "label": label,
            "address": "RSyntheticAddressOnly0000000000000"});
        if let Some(a) = asset {
            v["asset_name"] = json!(a);
        }
        v
    }
    fn lsb(rows: Vec<Value>) -> Value {
        json!({"transactions": rows, "asset_transactions": [], "lastblock": "00"})
    }

    #[test]
    fn baseline_is_silent_then_detect_confirm_once() {
        let mut t = Tracker::default();
        let old = rows_from_listsinceblock(&lsb(vec![tx("old", "receive", 5.0, 0, "", None)]));
        assert!(t.ingest(old.clone(), 3, 10).is_empty(), "켤 때 있던 입금은 알리지 않는다");
        // 이미 있던 0확인이 나중에 확인되면 「확인됨」은 알린다(돈이 들어온 사실이 바뀐 것이므로).
        let new = rows_from_listsinceblock(&lsb(vec![tx("a", "receive", 12.5, 0, "", None)]));
        let e = t.ingest(new, 3, 20);
        assert_eq!(e.len(), 1);
        assert_eq!(e[0].kind, Kind::DepositSeen);
        assert_eq!(e[0].amount, Some(12.5));
        // 같은 줄이 다시 와도(listsinceblock target_confirmations) 두 번 알리지 않는다.
        assert!(t.ingest(rows_from_listsinceblock(&lsb(vec![tx("a", "receive", 12.5, 1, "", None)])), 3, 30).is_empty());
        let e = t.ingest(rows_from_listsinceblock(&lsb(vec![tx("a", "receive", 12.5, 3, "", None)])), 3, 40);
        assert_eq!(e.iter().map(|e| e.kind).collect::<Vec<_>>(), vec![Kind::DepositConfirmed]);
        assert!(t.ingest(rows_from_listsinceblock(&lsb(vec![tx("a", "receive", 12.5, 4, "", None)])), 3, 50).is_empty());
        let e = t.ingest(rows_from_listsinceblock(&lsb(vec![tx("old", "receive", 5.0, 3, "", None)])), 3, 60);
        assert_eq!(e[0].kind, Kind::DepositConfirmed);
    }

    #[test]
    fn arrival_already_confirmed_skips_seen_and_sends_are_not_deposits() {
        let mut t = Tracker::default();
        t.ingest(vec![], 1, 0);
        let e = t.ingest(rows_from_listsinceblock(&lsb(vec![tx("b", "receive", 1.0, 2, "", None), tx("c", "send", -3.0, 0, "", None), tx("d", "generate", 5000.0, 0, "", None)])), 1, 5);
        assert_eq!(e.iter().map(|e| e.kind).collect::<Vec<_>>(), vec![Kind::DepositConfirmed]);
    }

    #[test]
    fn conflicted_payment_is_reported_once() {
        let mut t = Tracker::default();
        t.ingest(vec![], 1, 0);
        t.ingest(rows_from_listsinceblock(&lsb(vec![tx("x", "receive", 9.0, 0, "", None)])), 1, 1);
        let e = t.ingest(rows_from_listsinceblock(&lsb(vec![tx("x", "receive", 9.0, -1, "", None)])), 1, 2);
        assert_eq!(e[0].kind, Kind::DepositDropped);
        assert!(t.ingest(rows_from_listsinceblock(&lsb(vec![tx("x", "receive", 9.0, -2, "", None)])), 1, 3).is_empty());
    }

    #[test]
    fn sale_label_and_asset_rows() {
        let v = json!({"transactions": [tx("s", "receive", 3.0, 0, "sell:RV.M.SONG", None)],
            "asset_transactions": [tx("as", "receive", 1.0, 0, "", Some("RV.T.TICKET"))]});
        let r = rows_from_listsinceblock(&v);
        assert!(r[0].sale);
        assert_eq!(r[1].asset.as_deref(), Some("RV.T.TICKET"));
        assert_ne!(r[0].key, r[1].key);
    }

    #[test]
    fn today_summary_respects_timezone_and_skips_conflicts() {
        let mut t = Tracker::default();
        // KST(+540): UTC 15:00 = 다음날 00:00.
        let day0 = 20_000 * 86_400;
        let mut rows = vec![];
        for (id, time, label, conf, amt) in [("a", day0 + 15 * 3600 + 60, "order", 1, 2.0), ("b", day0 + 14 * 3600, "order", 1, 7.0), ("c", day0 + 16 * 3600, "", 0, 4.0), ("d", day0 + 16 * 3600, "", -1, 100.0)] {
            let mut v = tx(id, "receive", amt, conf, label, None);
            v["time"] = json!(time);
            rows.push(v);
        }
        t.ingest(rows_from_listsinceblock(&lsb(rows)), 1, 0);
        let s = t.today(day0 + 17 * 3600, 540);
        assert_eq!(s, Today { sales: 1, sales_rvn: 2.0, deposits: 1, deposits_rvn: 4.0, pending: 1 });
        let utc = t.today(day0 + 17 * 3600, 0);
        assert_eq!(utc.sales, 2);
    }

    #[test]
    fn recent_newest_first_and_bounded() {
        let mut t = Tracker::default();
        let mut rows = vec![];
        for i in 0..8 {
            let mut v = tx(&format!("t{i}"), if i % 2 == 0 { "receive" } else { "send" }, i as f64, 1, "", None);
            v["time"] = json!(100 + i);
            rows.push(v);
        }
        t.ingest(rows_from_listsinceblock(&lsb(rows)), 1, 0);
        let r = t.recent(3);
        assert_eq!(r.iter().map(|r| r.time).collect::<Vec<_>>(), vec![107, 106, 105]);
    }

    #[test]
    fn tracker_memory_is_bounded() {
        let mut t = Tracker::default();
        for chunk in 0..3 {
            let rows: Vec<Value> = (0..2000).map(|i| tx(&format!("{chunk}-{i}"), "receive", 1.0, 1, "", None)).collect();
            t.ingest(rows_from_listsinceblock(&lsb(rows)), 1, 0);
        }
        assert!(t.rows.len() <= MAX_TRACKED && t.order.len() <= MAX_TRACKED && t.seen.len() <= MAX_TRACKED + 2000);
    }

    #[test]
    fn health_hysteresis_stall_disconnect_recover() {
        let mut cold = Health::default();
        assert_eq!(cold.error(0), None);
        assert_eq!(cold.error(15), None, "켤 때(아직 한 번도 답 없음)는 경보 없이 상태만");
        assert_eq!(cold.current(), NodeState::Down);
        assert_eq!(cold.observe(1, 1, 0, 20), None);
        assert_eq!(cold.observe(1, 1, 0, 80), None, "한 번도 정상이 아니었으면 연결 0 도 조용히(켜는 중)");
        assert_eq!(cold.observe(2, 2, 4, 90), None, "첫 정상은 「회복」이 아니라 시작");
        let mut h = Health::default();
        assert_eq!(h.observe(100, 100, 8, 0), None);
        assert_eq!(h.current(), NodeState::Ok);
        assert_eq!(h.error(10), None, "한 번 실패는 흔들림");
        assert_eq!(h.error(20).map(|e| e.kind), Some(Kind::NodeDown));
        assert_eq!(h.error(30), None, "같은 상태는 다시 알리지 않는다");
        assert_eq!(h.observe(101, 101, 8, 40).map(|e| e.kind), Some(Kind::NodeRecovered));
        assert_eq!(h.observe(101, 101, 0, 50), None);
        assert_eq!(h.observe(101, 101, 0, 60).map(|e| e.kind), Some(Kind::NodeDisconnected));
        assert_eq!(h.observe(102, 102, 3, 70).map(|e| e.kind), Some(Kind::NodeRecovered));
        for t in (130..70 + STALL_SECS).step_by(60) {
            assert_eq!(h.observe(102, 102, 3, t), None);
        }
        assert_eq!(h.observe(102, 102, 3, 70 + STALL_SECS).map(|e| e.kind), Some(Kind::NodeStalled));
        assert_eq!(h.observe(103, 400, 3, 71 + STALL_SECS).map(|e| e.kind), Some(Kind::NodeRecovered));
        assert_eq!(h.current(), NodeState::Syncing);
        assert_eq!(h.rescanning(72 + STALL_SECS), None, "되살리는 중은 고장 알림이 아니다");
        assert_eq!(h.current(), NodeState::Rescanning);
        // 잠들었다 깸: 20분 비었다가 같은 높이 → 멈춤 아님(다시 잰다).
        let mut z = Health::default();
        z.observe(500, 500, 5, 0);
        assert_eq!(z.observe(500, 500, 5, 20 * 60), None);
        assert_eq!(z.current(), NodeState::Ok);
    }

    #[test]
    fn bundler_rate_limits_and_bundles() {
        let mut b = Bundler::default();
        assert_eq!(b.flush(0), None);
        let dep = |at| Event { kind: Kind::DepositSeen, amount: Some(1.0), asset: None, sale: false, at };
        b.push(dep(0));
        assert_eq!(b.flush(0).map(|v| v.len()), Some(1));
        for i in 0..30 {
            b.push(dep(i));
        }
        b.push(Event::node(Kind::NodeDown, 5));
        assert_eq!(b.flush(30), None, "간격 안에서는 보내지 않는다");
        let batch = b.flush(NOTIFY_GAP_SECS).unwrap();
        assert_eq!(batch.len(), 31, "모인 것은 한 장으로");
        let n = notice(&batch, true, "ko").unwrap();
        assert_eq!(n.kind, Kind::NodeDown, "급한 것이 제목");
        assert!(n.body.contains("다른 소식 30건"));
        for _ in 0..1000 {
            b.push(dep(0));
        }
        assert_eq!(b.pending(), 200);
    }

    fn has_digit_amount(s: &str) -> bool {
        s.contains("12.5") || s.contains("RVN") || s.contains("TICKET") || s.contains("1,234")
    }

    #[test]
    fn masked_notice_never_carries_amount_or_asset() {
        let evs = vec![
            Event { kind: Kind::DepositSeen, amount: Some(12.5), asset: None, sale: false, at: 0 },
            Event { kind: Kind::DepositSeen, amount: Some(1234.0), asset: Some("RV.T.TICKET".into()), sale: false, at: 0 },
        ];
        for loc in ["ko", "en"] {
            for kind in [Kind::DepositSeen, Kind::DepositConfirmed, Kind::DepositDropped] {
                let e: Vec<Event> = evs.iter().cloned().map(|mut e| { e.kind = kind; e }).collect();
                let n = notice(&e, true, loc).unwrap();
                assert!(!has_digit_amount(&n.title) && !has_digit_amount(&n.body), "{loc} {kind:?}: {n:?}");
                let open = notice(&e, false, loc).unwrap();
                assert!(open.body.contains("12.5"), "가림을 끄면 금액이 보인다: {open:?}");
            }
        }
        let n = notice(&evs[..1], true, "ko").unwrap();
        assert_eq!((n.title.as_str(), n.body.as_str()), ("입금 감지", "입금이 있어요."));
        let n = notice(&evs, false, "ko").unwrap();
        assert_eq!(n.body, "12.5 RVN 외 1건");
    }

    #[test]
    fn masked_snapshot_has_no_amounts_anywhere() {
        let mut t = Tracker::default();
        t.ingest(vec![], 1, 0);
        t.ingest(rows_from_listsinceblock(&json!({"transactions": [tx("a", "receive", 12.5, 0, "order", None)],
            "asset_transactions": [tx("b", "receive", 1234.0, 1, "", Some("RV.T.TICKET"))]})), 1, 1);
        let h = Health::default();
        let mk = |masked, seller| snapshot(&SnapshotIn { masked, locale: "ko", now: 2000, tz: 0, balance: Some((1234.5, 12.5)), tracker: &t, health: &h,
            lock: "locked", awake_holding: true, awake_note: "", seller, unseen: 2, need: 1 });
        let s = mk(true, true).to_string();
        assert!(!has_digit_amount(&s) && !s.contains("1234"), "{s}");
        assert!(!s.contains("RSynthetic"), "주소는 어떤 경우에도 안 나간다");
        let open = mk(false, true).to_string();
        assert!(open.contains("1,234.5") && open.contains("RV.T.TICKET") && open.contains("+12.5"));
        assert!(!open.contains("RSynthetic") && !open.contains("\"txid\""));
        assert!(mk(false, false)["seller"].is_null(), "판매자 모드가 아니면 판매 요약 없음");
        assert_eq!(mk(true, true)["seller"]["sales"], 1);
    }

    #[test]
    fn amount_format() {
        assert_eq!(fmt_amount(1234567.5), "1,234,567.5");
        assert_eq!(fmt_amount(0.00000001), "0.00000001");
        assert_eq!(fmt_amount(100.0), "100");
        assert_eq!(fmt_amount(0.0), "0");
    }
}
