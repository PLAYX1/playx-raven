//! **우체국** — 이 컴퓨터가 다른 사람의 **잠긴 글**을 잠깐 맡았다가 전해 준다.
//!
//! 대표(11-23): 「레이븐볼트를 돌리는 게 서로 우체국이 되어야지.」 설계는 페이블 판정(우체국 1라운드 A·E·F·I).
//!
//! ## 무엇을 맡나 — 셋뿐(글자 이벤트만 · 사진·파일은 안 맡는다)
//!
//! - kind 1059 겉봉(NIP-17 쪽지) — 이 컴퓨터 주인에게 온 것이 **아닌** 것. 받는 사람(`p`)마다 500개.
//! - kind 4470 「나만·친구만」 글 — 주인이 쓴 것이 **아닌** 것. 글쓴이마다 300개.
//! - kind 30078 `d=ravenvault/circle-keys/v1` 열쇠 꾸러미 — 사람마다 하나(새 것이 덮는다).
//!
//! 셋 다 **암호문**이다(NIP-44). 이 컴퓨터는 풀지 않는다 — 풀 열쇠도 없다.
//! 주인 글·주인에게 온 겉봉은 여기가 아니라 relay.rs 의 「내 글 지키기」(MINE_KINDS)가 맡는다(그대로).
//!
//! ## 🔴 「보관」이 아니라 「배달」이다
//!
//! - 기간: 겉봉은 **받은 때부터** 30일(NIP-59 는 겉봉 시각을 이틀까지 앞당기므로 받은 시각으로 잰다 — 제미나이 E5),
//!   「나만·친구만」 글은 쓴 때부터 90일, 꾸러미는 주인이 덮을 때까지.
//! - 컴퓨터 전체 2만 개 또는 200MB 까지. 넘으면 오래 맡은 것부터 보낸다(꾸러미는 맨 나중).
//! - 글 하나 32KB(relay.rs MAX_EVENT_BYTES 와 같다).
//! - 끄면 맡은 글을 **모두 지운다.** 내 글은 그대로 지킨다.
//!
//! ## 🔴 누구에게 내주나
//!
//! 넓은 물음(「요즘 글 다 줘」)·넓은 구독에는 **절대 안 섞는다.**
//! 4470·꾸러미는 `authors` 를 적어 물은 때에만, 1059 는 `#p` 를 적어 물은 때에만 준다.
//! 그렇게 사람을 적은 열린 구독에는 새로 맡은 글을 곧바로 밀어 준다(relay.rs POST_LIVE · 11-23 결정 4 — 폰이 「내 우체국」을 들을 때).
//! 릴레이끼리 퍼뜨리지 않는다(gossip 없음) — 보내는 쪽이 받는 사람의 우체국에 직접 넣고, 받는 쪽이 꺼낸다.
//!
//! ## 디스크 (제미나이 E2)
//!
//! 5초마다 통째로 다시 쓰지 않는다. 바뀐 것만 `post-office.log` 끝에 한 줄씩 덧붙이고,
//! 지운 줄이 쌓이면(맡은 수의 두 배 + 1000 줄을 넘으면) 한 번 새로 쓴다(압축).

use serde_json::{json, Value};
use std::collections::{BTreeSet, HashMap};
use std::io::Write;
use std::sync::Mutex;

/// 능력 표 — 우체국을 켠 컴퓨터만 자기 10002 에 단다(docs/RELAY-SHARE.md §1).
pub const POST_TAG: &str = "rv-post-1";
pub const KIND_WRAP: i64 = 1059;
pub const PER_P_WRAPS: usize = 500;
pub const PER_AUTHOR_NOTES: usize = 300;
pub const MAX_TOTAL: usize = 20_000;
pub const MAX_BYTES: usize = 200 * 1024 * 1024;
pub const WRAP_KEEP_SECS: i64 = 30 * 86_400;
pub const NOTE_KEEP_SECS: i64 = 90 * 86_400;
/// 한 물음에서 찾아 주는 사람(authors·#p) 수 상한.
const MAX_LOOKUP_KEYS: usize = 64;
/// 한 IP 가 한 시간에 맡길 수 있는 겉봉 수. 겉봉 글쓴이는 1회용 열쇠라 열쇠당 예산(relay.rs AUTHOR_PER_HOUR)이 안 든다.
pub const WRAPS_PER_IP_HOUR: u32 = 300;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum Kind {
    Wrap,
    Note,
    Circle,
}

impl Kind {
    fn tag(self) -> &'static str {
        match self { Kind::Wrap => "w", Kind::Note => "n", Kind::Circle => "c" }
    }
    fn from_tag(s: &str) -> Option<Kind> {
        match s { "w" => Some(Kind::Wrap), "n" => Some(Kind::Note), "c" => Some(Kind::Circle), _ => None }
    }
}

#[derive(Clone)]
struct Item {
    ev: Value,
    kind: Kind,
    /// 1059 = 받는 사람(p) · 4470·꾸러미 = 글쓴이.
    key: String,
    /// 받은 시각(초).
    got: i64,
    size: usize,
}

impl Item {
    fn id(&self) -> &str { self.ev.get("id").and_then(Value::as_str).unwrap_or("") }
    fn at(&self) -> i64 { self.ev.get("created_at").and_then(Value::as_i64).unwrap_or(0) }
    /// 언제 보내나(None = 덮일 때까지).
    fn expires(&self) -> Option<i64> {
        match self.kind {
            Kind::Wrap => Some(self.got + WRAP_KEEP_SECS),
            Kind::Note => Some(self.at() + NOTE_KEEP_SECS),
            Kind::Circle => None,
        }
    }
}

/// 맡은 글 칸. 모든 찾기는 색인으로 한다 — 맡은 수에 비례해 느려지지 않게.
#[derive(Default)]
struct Bag {
    items: HashMap<String, Item>,
    /// (종류, 사람) → (받은 시각, id). 겉봉은 p, 글·꾸러미는 글쓴이.
    by_key: HashMap<(Kind, String), BTreeSet<(i64, String)>>,
    /// 꾸러미 아닌 것 / 꾸러미 — 받은 순(넘칠 때 오래된 것부터, 꾸러미는 맨 나중).
    fifo: BTreeSet<(i64, String)>,
    fifo_circle: BTreeSet<(i64, String)>,
    /// (보낼 시각, id).
    expiry: BTreeSet<(i64, String)>,
    bytes: usize,
    /// 아직 디스크에 안 쓴 줄.
    pending: Vec<String>,
    /// 지금 로그 파일의 줄 수(압축 판단용).
    log_lines: usize,
    loaded: bool,
}

impl Bag {
    fn insert(&mut self, it: Item, log: bool) {
        let id = it.id().to_string();
        if self.items.contains_key(&id) { return; }
        self.by_key.entry((it.kind, it.key.clone())).or_default().insert((it.got, id.clone()));
        if it.kind == Kind::Circle { self.fifo_circle.insert((it.got, id.clone())); } else { self.fifo.insert((it.got, id.clone())); }
        if let Some(t) = it.expires() { self.expiry.insert((t, id.clone())); }
        self.bytes += it.size;
        if log {
            self.pending.push(json!({ "a": it.ev, "k": it.kind.tag(), "g": it.got }).to_string());
        }
        self.items.insert(id, it);
    }

    fn remove(&mut self, id: &str, log: bool) -> bool {
        let Some(it) = self.items.remove(id) else { return false };
        let k = (it.kind, it.key.clone());
        if let Some(s) = self.by_key.get_mut(&k) {
            s.remove(&(it.got, id.to_string()));
            if s.is_empty() { self.by_key.remove(&k); }
        }
        self.fifo.remove(&(it.got, id.to_string()));
        self.fifo_circle.remove(&(it.got, id.to_string()));
        if let Some(t) = it.expires() { self.expiry.remove(&(t, id.to_string())); }
        self.bytes = self.bytes.saturating_sub(it.size);
        if log { self.pending.push(json!({ "d": id }).to_string()); }
        true
    }

    fn sweep(&mut self, now: i64) {
        while let Some((t, id)) = self.expiry.iter().next().cloned() {
            if t > now { break; }
            self.remove(&id, true);
            self.expiry.remove(&(t, id));
        }
    }

    /// 한 사람 칸이 넘치면 그 사람 칸의 오래된 것부터.
    fn trim_key(&mut self, k: &(Kind, String), cap: usize) {
        loop {
            let over = self.by_key.get(k).map(|s| s.len() > cap).unwrap_or(false);
            if !over { break; }
            let Some((_, id)) = self.by_key.get(k).and_then(|s| s.iter().next().cloned()) else { break };
            self.remove(&id, true);
        }
    }

    /// 컴퓨터 전체가 넘치면 오래 맡은 것부터(꾸러미는 맨 나중).
    fn trim_total(&mut self) {
        while self.items.len() > MAX_TOTAL || self.bytes > MAX_BYTES {
            let next = self.fifo.iter().next().cloned().or_else(|| self.fifo_circle.iter().next().cloned());
            let Some((_, id)) = next else { break };
            self.remove(&id, true);
        }
    }

    fn clear(&mut self) {
        *self = Bag { loaded: true, ..Bag::default() };
    }
}

static BAG: Mutex<Option<Bag>> = Mutex::new(None);

fn log_file() -> std::path::PathBuf {
    if cfg!(test) {
        return std::env::temp_dir().join(format!("rv-test-post-office-{}.log", std::process::id()));
    }
    crate::paths::app_file("post-office.log")
}

fn now_secs() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0)
}

fn load_into(b: &mut Bag) {
    b.loaded = true;
    let Ok(text) = std::fs::read_to_string(log_file()) else { return };
    for line in text.lines() {
        b.log_lines += 1;
        let Ok(v) = serde_json::from_str::<Value>(line) else { continue };
        if let Some(id) = v.get("d").and_then(Value::as_str) {
            b.remove(id, false);
            continue;
        }
        let (Some(ev), Some(kind), Some(got)) = (v.get("a"), v.get("k").and_then(Value::as_str).and_then(Kind::from_tag), v.get("g").and_then(Value::as_i64)) else { continue };
        let Some(key) = key_of(ev, kind) else { continue };
        let size = serde_json::to_vec(ev).map(|x| x.len()).unwrap_or(0);
        if kind == Kind::Circle {
            // 같은 사람 꾸러미는 하나만 — 로그 뒤쪽(새 것)이 이긴다.
            let old: Vec<String> = b.by_key.get(&(kind, key.clone())).map(|s| s.iter().map(|(_, i)| i.clone()).collect()).unwrap_or_default();
            for id in old { b.remove(&id, false); }
        }
        b.insert(Item { ev: ev.clone(), kind, key, got, size }, false);
    }
    b.sweep(now_secs());
}

fn with<T>(f: impl FnOnce(&mut Bag) -> T) -> T {
    let mut g = BAG.lock().unwrap_or_else(|e| e.into_inner());
    let b = g.get_or_insert_with(Bag::default);
    if !b.loaded { load_into(b); }
    f(b)
}

/// 밀린 줄을 디스크에 덧붙인다. 지운 줄이 많이 쌓였으면 새로 쓴다. relay.rs 의 5초 저장 고리가 부른다.
pub(crate) fn flush() {
    let (lines, compact) = {
        let mut g = BAG.lock().unwrap_or_else(|e| e.into_inner());
        let Some(b) = g.as_mut() else { return };
        b.sweep(now_secs());
        if b.pending.is_empty() { return; }
        let lines = std::mem::take(&mut b.pending);
        let compact = b.log_lines + lines.len() > b.items.len() * 2 + 1000;
        if compact {
            let all: Vec<String> = b.items.values().map(|it| json!({ "a": it.ev, "k": it.kind.tag(), "g": it.got }).to_string()).collect();
            b.log_lines = all.len();
            (all, true)
        } else {
            b.log_lines += lines.len();
            (lines, false)
        }
    };
    let mut body = lines.join("\n");
    if !body.is_empty() { body.push('\n'); }
    let path = log_file();
    if let Some(d) = path.parent() { let _ = std::fs::create_dir_all(d); }
    if compact {
        let tmp = path.with_extension("log.tmp");
        if std::fs::write(&tmp, body).is_ok() { let _ = std::fs::rename(&tmp, &path); }
    } else if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&path) {
        let _ = f.write_all(body.as_bytes());
    }
}

// ── 켜기·끄기 ────────────────────────────────────────────────────────────────

// 시험은 실 단위로 켠다 — 기존 시험(우체국 꺼짐 동작)이 다른 시험의 「켬」에 흔들리지 않게.
#[cfg(test)]
thread_local! { pub(crate) static TEST_ON: std::cell::Cell<bool> = const { std::cell::Cell::new(false) }; }

#[derive(Clone, Debug, PartialEq)]
pub struct Setting {
    pub on: bool,
    /// 기존 설치에 「우체국」을 한 번 알려야 하나(알리기 전에는 꺼 둔다).
    pub notice: bool,
}

fn setting_file() -> std::path::PathBuf {
    crate::paths::app_file("post-office.json")
}

/// 설정 파일이 없을 때: 새 설치면 켠 채 시작, 기존 설치면 알리기 전까지 꺼 둔다(페이블 E · I 「말없이 켜기」 금지).
pub fn first_setting(existing_install: bool) -> Setting {
    if existing_install { Setting { on: false, notice: true } } else { Setting { on: true, notice: false } }
}

static SETTING: Mutex<Option<Setting>> = Mutex::new(None);

pub fn setting() -> Setting {
    #[cfg(test)]
    {
        return Setting { on: TEST_ON.with(|c| c.get()), notice: false };
    }
    #[allow(unreachable_code)]
    {
        let mut g = SETTING.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(s) = g.clone() { return s; }
        let p = setting_file();
        let s = match std::fs::read_to_string(&p).ok().and_then(|t| serde_json::from_str::<Value>(&t).ok()) {
            Some(v) => Setting { on: v["on"].as_bool().unwrap_or(false), notice: v["notice"].as_bool().unwrap_or(false) },
            None => {
                // 이미 쓰던 컴퓨터인가 — 릴레이 저장분이나 릴레이 나누기 설정이 있으면 기존 설치.
                let existing = crate::paths::app_file("relay-events.json").exists() || crate::paths::app_file("relay-share.json").exists();
                let s = first_setting(existing);
                save_setting(&s);
                s
            }
        };
        *g = Some(s.clone());
        s
    }
}

fn save_setting(s: &Setting) {
    let p = setting_file();
    if let Some(d) = p.parent() { let _ = std::fs::create_dir_all(d); }
    let tmp = p.with_extension("json.tmp");
    if std::fs::write(&tmp, json!({ "on": s.on, "notice": s.notice }).to_string()).is_ok() {
        let _ = std::fs::rename(&tmp, &p);
    }
}

/// 우체국이 켜져 있나.
pub fn on() -> bool { setting().on }

/// 켜고 끈다. 끄면 맡은 글을 **모두 지운다**(파일까지). 알림은 끝난 것으로 친다.
pub fn set_on(v: bool) {
    #[cfg(test)]
    TEST_ON.with(|c| c.set(v));
    if !cfg!(test) {
        let s = Setting { on: v, notice: false };
        save_setting(&s);
        *SETTING.lock().unwrap_or_else(|e| e.into_inner()) = Some(s);
    }
    if !v { clear(); }
}

/// 맡은 글을 모두 지운다.
pub fn clear() {
    with(|b| b.clear());
    let _ = std::fs::remove_file(log_file());
}

// ── 받기 ─────────────────────────────────────────────────────────────────────

fn tag_vals<'a>(e: &'a Value, name: &str) -> Vec<&'a str> {
    e.get("tags").and_then(Value::as_array).map(|t| t.iter()
        .filter(|x| x.get(0).and_then(Value::as_str) == Some(name))
        .filter_map(|x| x.get(1).and_then(Value::as_str)).collect()).unwrap_or_default()
}

fn hex64(s: &str) -> bool { s.len() == 64 && s.bytes().all(|b| b.is_ascii_hexdigit()) }

fn key_of(e: &Value, kind: Kind) -> Option<String> {
    match kind {
        Kind::Wrap => {
            let ps = tag_vals(e, "p");
            // 받는 사람은 꼭 하나(NIP-17) — 여럿이면 한 사람 칸 상한을 비껴 간다.
            (ps.len() == 1 && hex64(ps[0])).then(|| ps[0].to_ascii_lowercase())
        }
        Kind::Note | Kind::Circle => e.get("pubkey").and_then(Value::as_str).filter(|p| hex64(p)).map(str::to_string),
    }
}

/// 우체국이 맡을 종류인가 — 주인 것(주인 글·주인에게 온 겉봉)은 아니다(그건 relay.rs 「내 글 지키기」).
pub fn classify(e: &Value, me: Option<&str>) -> Option<Kind> {
    let kind = e.get("kind").and_then(Value::as_i64)?;
    let author = e.get("pubkey").and_then(Value::as_str);
    let mine = |x: Option<&str>| me.is_some() && x == me;
    match kind {
        KIND_WRAP => {
            let to_me = me.is_some_and(|m| tag_vals(e, "p").contains(&m));
            (!to_me).then_some(Kind::Wrap)
        }
        crate::relay::KIND_PRIVATE_NOTE => (!mine(author)).then_some(Kind::Note),
        30078 if tag_vals(e, "d").contains(&crate::relay::CIRCLE_KEYS_D) => (!mine(author)).then_some(Kind::Circle),
        _ => None,
    }
}

/// 받은 것이 우체국 것이면 이 답이 붙는다(OK true). 「새로 저장」과 달리 열린 구독에 밀지 않는다.
pub const TOOK: &str = "post: 맡았습니다";

/// 맡는다. 돌려주는 값은 relay.rs `store` 와 같다(받았나, 까닭).
pub fn take(e: Value, kind: Kind) -> (bool, String) {
    if !on() {
        return (false, "이 릴레이는 가게 글만 받습니다".into());
    }
    if !crate::relay::verify(&e) {
        return (false, "invalid: 서명이 맞지 않습니다".into());
    }
    if kind == Kind::Note && crate::relay::is_gone(&e) {
        return (false, "blocked: 지운 글입니다".into());
    }
    // 서명이 덮는 일곱 칸만(relay.rs 와 같다).
    let e = json!({
        "id": e["id"], "pubkey": e["pubkey"], "created_at": e["created_at"], "kind": e["kind"],
        "tags": e.get("tags").cloned().unwrap_or(json!([])), "content": e.get("content").cloned().unwrap_or(json!("")), "sig": e["sig"],
    });
    let size = serde_json::to_vec(&e).map(|b| b.len()).unwrap_or(usize::MAX);
    if size > crate::relay::MAX_EVENT_BYTES {
        return (false, "invalid: 글이 너무 큽니다".into());
    }
    let Some(key) = key_of(&e, kind) else {
        return (false, "invalid: 받는 사람이 하나 적혀 있어야 합니다".into());
    };
    let now = now_secs();
    let at = e.get("created_at").and_then(Value::as_i64).unwrap_or(0);
    if at > now + 900 {
        return (false, "invalid: 시각이 미래입니다".into());
    }
    // 겉봉 시각은 이틀까지 앞당겨진다 — 그만큼 너그럽게.
    let too_old = match kind {
        Kind::Wrap => at < now - WRAP_KEEP_SECS - 2 * 86_400,
        Kind::Note => at < now - NOTE_KEEP_SECS,
        Kind::Circle => false,
    };
    if too_old {
        return (false, "invalid: 너무 오래된 글입니다".into());
    }
    let id = e.get("id").and_then(Value::as_str).unwrap_or("").to_string();
    with(|b| {
        b.sweep(now);
        if b.items.contains_key(&id) {
            return (true, "duplicate: 이미 맡았습니다".into());
        }
        let k = (kind, key.clone());
        if kind == Kind::Circle {
            // 사람마다 하나 — 더 새 것(늦은 시각, 같으면 id 가 작은 것)이 이긴다(NIP-01).
            let olds: Vec<String> = b.by_key.get(&k).map(|s| s.iter().map(|(_, i)| i.clone()).collect()).unwrap_or_default();
            for old in &olds {
                if let Some(x) = b.items.get(old) {
                    if x.at() > at || (x.at() == at && x.id() < id.as_str()) {
                        return (true, "옛 글입니다".into());
                    }
                }
            }
            for old in olds { b.remove(&old, true); }
        }
        b.insert(Item { ev: e, kind, key, got: now, size }, true);
        match kind {
            Kind::Wrap => b.trim_key(&k, PER_P_WRAPS),
            Kind::Note => b.trim_key(&k, PER_AUTHOR_NOTES),
            Kind::Circle => {}
        }
        b.trim_total();
        (true, TOOK.to_string())
    })
}

/// 글쓴이가 지우기를 요청한 「나만·친구만」 글을 맡은 칸에서도 뺀다(relay.rs note_deletions 가 부른다). 꾸러미는 덮어쓰기로만 바뀐다.
pub(crate) fn forget(pairs: &[(String, String)]) {
    if pairs.is_empty() { return; }
    let mut g = BAG.lock().unwrap_or_else(|e| e.into_inner());
    let Some(b) = g.as_mut() else { return };
    for (id, who) in pairs {
        let hit = b.items.get(id).is_some_and(|it| it.kind == Kind::Note && it.key == *who);
        if hit { b.remove(id, true); }
    }
}

// ── 내주기 ───────────────────────────────────────────────────────────────────

fn list<'a>(f: &'a Value, key: &str) -> Vec<&'a str> {
    f.get(key).and_then(Value::as_array).map(|a| a.iter().filter_map(Value::as_str).take(MAX_LOOKUP_KEYS).collect()).unwrap_or_default()
}

/// 이 물음에 맞는 맡은 글. `authors` 를 적은 물음에만 4470·꾸러미를, `#p` 를 적은 물음에만 1059 를 준다.
/// 넓은 물음(사람을 안 적은 것)에는 아무것도 안 준다. 새것이 먼저, `cap` 개까지.
pub fn answer(filters: &[Value], cap: usize) -> Vec<Value> {
    if cap == 0 { return vec![]; }
    let mut out: Vec<Value> = Vec::new();
    let mut seen = std::collections::HashSet::new();
    with(|b| {
        b.sweep(now_secs());
        if b.items.is_empty() { return; }
        for f in filters {
            let kinds: Option<Vec<i64>> = f.get("kinds").and_then(Value::as_array).map(|a| a.iter().filter_map(Value::as_i64).collect());
            let want = |k: i64| kinds.as_ref().is_none_or(|ks| ks.contains(&k));
            let mut keys: Vec<(Kind, String)> = Vec::new();
            for a in list(f, "authors") {
                if want(crate::relay::KIND_PRIVATE_NOTE) { keys.push((Kind::Note, a.to_string())); }
                if want(30078) { keys.push((Kind::Circle, a.to_string())); }
            }
            if want(KIND_WRAP) {
                for p in list(f, "#p") { keys.push((Kind::Wrap, p.to_ascii_lowercase())); }
            }
            for k in keys {
                let Some(set) = b.by_key.get(&k) else { continue };
                for (_, id) in set.iter().rev() {
                    let Some(it) = b.items.get(id) else { continue };
                    if crate::relay::filter_matches(&it.ev, f) && seen.insert(id.clone()) {
                        out.push(it.ev.clone());
                    }
                }
            }
        }
    });
    out.sort_by_key(|e| std::cmp::Reverse(e.get("created_at").and_then(Value::as_i64).unwrap_or(0)));
    out.truncate(cap);
    out
}

/// (맡은 글 수, 바이트).
pub fn counts() -> (usize, usize) {
    with(|b| { b.sweep(now_secs()); (b.items.len(), b.bytes) })
}

// ── 한 IP 의 겉봉 예산 ───────────────────────────────────────────────────────

/// 이 IP 가 이번 한 시간에 겉봉을 더 맡겨도 되나(맡길 때마다 하나 센다).
pub fn ip_wrap_budget_ok(ip: std::net::IpAddr) -> bool {
    static BUDGET: Mutex<Option<HashMap<std::net::IpAddr, (std::time::Instant, u32)>>> = Mutex::new(None);
    let mut g = BUDGET.lock().unwrap_or_else(|e| e.into_inner());
    let m = g.get_or_insert_with(HashMap::new);
    let now = std::time::Instant::now();
    if m.len() > 20_000 { m.retain(|_, (at, _)| now.duration_since(*at).as_secs() < 3600); }
    let slot = m.entry(ip).or_insert((now, 0));
    if now.duration_since(slot.0).as_secs() >= 3600 { *slot = (now, 0); }
    slot.1 += 1;
    slot.1 <= WRAPS_PER_IP_HOUR
}

// ── 설정 화면 ────────────────────────────────────────────────────────────────

fn state_json() -> Value {
    let s = setting();
    let (n, bytes) = counts();
    json!({ "on": s.on, "notice": s.notice, "count": n, "bytes": bytes, "max_count": MAX_TOTAL, "max_bytes": MAX_BYTES })
}

#[tauri::command(async)]
pub fn post_office_get() -> Value { state_json() }

/// 켜기·끄기(알림의 「알겠어요」·「켜지 않기」도 이것). 끄면 맡은 글을 지운다.
#[tauri::command(async)]
pub fn post_office_set(on: bool) -> Value {
    set_on(on);
    crate::relay_share::kick_now();
    state_json()
}

#[cfg(test)]
pub(crate) static TEST_LOCK: Mutex<()> = Mutex::new(());

#[cfg(test)]
mod tests {
    use super::*;

    fn reset(on_: bool) {
        TEST_ON.with(|c| c.set(on_));
        *BAG.lock().unwrap() = Some(Bag { loaded: true, ..Bag::default() });
        let _ = std::fs::remove_file(log_file());
    }

    fn wrap(once: u8, to: &str, body: &str, at: i64) -> Value {
        crate::shopkey::sign_with(&[once; 32], KIND_WRAP, json!([["p", to]]), body, at).unwrap()
    }

    #[test]
    fn new_install_starts_on_and_existing_install_asks_first() {
        assert_eq!(first_setting(false), Setting { on: true, notice: false });
        assert_eq!(first_setting(true), Setting { on: false, notice: true });
    }

    #[test]
    fn classify_leaves_owner_things_to_the_owner_store() {
        let me = crate::shopkey::pubkey_of(&[1u8; 32]).unwrap();
        let other = crate::shopkey::pubkey_of(&[2u8; 32]).unwrap();
        let t = now_secs();
        assert_eq!(classify(&wrap(9, &me, "x", t), Some(&me)), None, "주인에게 온 겉봉");
        assert_eq!(classify(&wrap(9, &other, "x", t), Some(&me)), Some(Kind::Wrap));
        assert_eq!(classify(&wrap(9, &other, "x", t), None), Some(Kind::Wrap));
        let mine = crate::shopkey::sign_with(&[1u8; 32], 4470, json!([]), "{}", t).unwrap();
        let theirs = crate::shopkey::sign_with(&[2u8; 32], 4470, json!([]), "{}", t).unwrap();
        assert_eq!(classify(&mine, Some(&me)), None);
        assert_eq!(classify(&theirs, Some(&me)), Some(Kind::Note));
        let circle = crate::shopkey::sign_with(&[2u8; 32], 30078, json!([["d", crate::relay::CIRCLE_KEYS_D]]), "{}", t).unwrap();
        let shop = crate::shopkey::sign_with(&[2u8; 32], 30078, json!([["d", "SHOP.PLAYX"]]), "{}", t).unwrap();
        assert_eq!(classify(&circle, Some(&me)), Some(Kind::Circle));
        assert_eq!(classify(&shop, Some(&me)), None, "가게 공지는 우체국 것이 아니다");
        let public = crate::shopkey::sign_with(&[2u8; 32], 1, json!([["t", "ravencoin"]]), "공개", t).unwrap();
        assert_eq!(classify(&public, Some(&me)), None, "공개 글 범위는 넓히지 않는다");
    }

    #[test]
    fn off_refuses_and_turning_off_forgets_everything() {
        let _g = TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        reset(false);
        let p = crate::shopkey::pubkey_of(&[3u8; 32]).unwrap();
        assert!(!take(wrap(9, &p, "a", now_secs()), Kind::Wrap).0, "꺼져 있는데 맡았다");
        set_on(true);
        assert_eq!(take(wrap(9, &p, "a", now_secs()), Kind::Wrap), (true, TOOK.to_string()));
        flush();
        assert!(std::fs::metadata(log_file()).is_ok());
        assert_eq!(counts().0, 1);
        set_on(false);
        assert_eq!(counts(), (0, 0), "끄면 맡은 글을 지운다");
        assert!(std::fs::metadata(log_file()).is_err(), "끄면 파일도 지운다");
    }

    #[test]
    fn caps_per_person_and_ages() {
        let _g = TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        reset(true);
        let p = crate::shopkey::pubkey_of(&[4u8; 32]).unwrap();
        let now = now_secs();
        for i in 0..(PER_P_WRAPS + 5) {
            assert!(take(wrap((i % 250 + 1) as u8, &p, &format!("w{i}"), now - 3600 + i as i64), Kind::Wrap).0);
        }
        let n = with(|b| b.by_key.get(&(Kind::Wrap, p.clone())).map(|s| s.len()).unwrap_or(0));
        assert_eq!(n, PER_P_WRAPS, "받는 사람당 500개");
        // 받는 사람이 둘인 겉봉·없는 겉봉은 안 맡는다.
        let two = crate::shopkey::sign_with(&[5u8; 32], KIND_WRAP, json!([["p", p], ["p", "a".repeat(64)]]), "x", now).unwrap();
        assert!(!take(two, Kind::Wrap).0);
        // 글쓴이당 300개.
        for i in 0..(PER_AUTHOR_NOTES + 3) {
            let e = crate::shopkey::sign_with(&[6u8; 32], 4470, json!([]), &format!("{{\"n\":{i}}}"), now - 100 + i as i64).unwrap();
            assert!(take(e, Kind::Note).0);
        }
        let author = crate::shopkey::pubkey_of(&[6u8; 32]).unwrap();
        assert_eq!(with(|b| b.by_key[&(Kind::Note, author.clone())].len()), PER_AUTHOR_NOTES);
        // 90일 넘은 4470 · 32일 넘은 겉봉 · 미래 · 큰 글은 안 맡는다.
        let old_note = crate::shopkey::sign_with(&[6u8; 32], 4470, json!([]), "{}", now - NOTE_KEEP_SECS - 10).unwrap();
        assert!(!take(old_note, Kind::Note).0);
        assert!(!take(wrap(7, &p, "old", now - WRAP_KEEP_SECS - 3 * 86_400), Kind::Wrap).0);
        assert!(take(wrap(7, &p, "fuzzed", now - 2 * 86_400), Kind::Wrap).0, "이틀 앞당긴 겉봉은 받는다");
        assert!(!take(wrap(7, &p, "future", now + 3600), Kind::Wrap).0);
        assert!(!take(wrap(7, &p, &"x".repeat(crate::relay::MAX_EVENT_BYTES), now), Kind::Wrap).0);
        let mut forged = wrap(8, &p, "y", now);
        forged["content"] = json!("z");
        assert!(!take(forged, Kind::Wrap).0, "서명이 틀린 것");
        reset(false);
    }

    #[test]
    fn wrap_ttl_counts_from_receipt_and_circle_is_replaced() {
        let _g = TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        reset(true);
        let p = crate::shopkey::pubkey_of(&[4u8; 32]).unwrap();
        let now = now_secs();
        // 시각을 이틀 앞당긴 겉봉도 받은 때부터 30일 — 28일째에 사라지면 안 된다.
        let w = wrap(9, &p, "a", now - 2 * 86_400);
        assert!(take(w.clone(), Kind::Wrap).0);
        with(|b| b.sweep(now + WRAP_KEEP_SECS - 86_400));
        assert_eq!(counts().0, 1, "받은 지 29일 — 아직 맡고 있어야 한다");
        with(|b| b.sweep(now + WRAP_KEEP_SECS + 10));
        assert_eq!(counts().0, 0, "받은 지 30일이 지나면 보낸다");
        // 꾸러미는 사람마다 하나 — 새 것이 덮고, 옛 것이 뒤늦게 와도 못 덮는다.
        let c1 = crate::shopkey::sign_with(&[6u8; 32], 30078, json!([["d", crate::relay::CIRCLE_KEYS_D]]), "{\"v\":1}", now - 10).unwrap();
        let c2 = crate::shopkey::sign_with(&[6u8; 32], 30078, json!([["d", crate::relay::CIRCLE_KEYS_D]]), "{\"v\":2}", now).unwrap();
        assert!(take(c1.clone(), Kind::Circle).0 && take(c2.clone(), Kind::Circle).0);
        assert_eq!(take(c1, Kind::Circle), (true, "옛 글입니다".to_string()));
        let author = crate::shopkey::pubkey_of(&[6u8; 32]).unwrap();
        let got = answer(&[json!({ "authors": [author], "kinds": [30078] })], 10);
        assert_eq!(got.len(), 1);
        assert_eq!(got[0]["id"], c2["id"]);
        reset(false);
    }

    #[test]
    fn only_named_questions_get_held_mail() {
        let _g = TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        reset(true);
        let now = now_secs();
        let p = crate::shopkey::pubkey_of(&[4u8; 32]).unwrap();
        let author = crate::shopkey::pubkey_of(&[6u8; 32]).unwrap();
        let w = wrap(9, &p, "a", now);
        let n = crate::shopkey::sign_with(&[6u8; 32], 4470, json!([]), "{}", now).unwrap();
        assert!(take(w.clone(), Kind::Wrap).0 && take(n.clone(), Kind::Note).0);
        // 넓은 물음에는 아무것도.
        assert!(answer(&[json!({ "kinds": [1059, 4470] })], 50).is_empty());
        assert!(answer(&[json!({})], 50).is_empty());
        // 겉봉은 #p 로만(글쓴이 1회용 열쇠로는 안 준다).
        let wpk = w["pubkey"].as_str().unwrap();
        assert!(answer(&[json!({ "authors": [wpk] })], 50).is_empty());
        assert_eq!(answer(&[json!({ "#p": [p] })], 50).len(), 1);
        assert_eq!(answer(&[json!({ "kinds": [1059], "#p": [p] })], 50).len(), 1);
        assert!(answer(&[json!({ "kinds": [1], "#p": [p] })], 50).is_empty(), "종류가 다르면 안 준다");
        // 4470 은 authors 로만.
        assert!(answer(&[json!({ "#p": [author] })], 50).is_empty());
        assert_eq!(answer(&[json!({ "authors": [author] })], 50)[0]["id"], n["id"]);
        assert!(answer(&[json!({ "authors": [author], "since": now + 10 })], 50).is_empty(), "since 도 본다");
        // 글쓴이가 지우기를 요청하면 맡은 칸에서도 빠진다.
        forget(&[(n["id"].as_str().unwrap().to_string(), author.clone())]);
        assert!(answer(&[json!({ "authors": [author] })], 50).is_empty());
        reset(false);
    }

    #[test]
    fn log_survives_restart_and_compacts() {
        let _g = TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        reset(true);
        let p = crate::shopkey::pubkey_of(&[4u8; 32]).unwrap();
        let now = now_secs();
        let a = wrap(9, &p, "a", now);
        let b2 = wrap(10, &p, "b", now);
        assert!(take(a.clone(), Kind::Wrap).0 && take(b2.clone(), Kind::Wrap).0);
        flush();
        with(|b| { let id = a["id"].as_str().unwrap().to_string(); b.remove(&id, true); });
        flush();
        let lines = std::fs::read_to_string(log_file()).unwrap().lines().count();
        assert_eq!(lines, 3, "덧붙이기(새로 쓰지 않는다)");
        // 다시 켠 것처럼 읽는다.
        *BAG.lock().unwrap() = None;
        let got = answer(&[json!({ "#p": [p] })], 50);
        assert_eq!(got.len(), 1);
        assert_eq!(got[0]["id"], b2["id"]);
        // 지운 줄이 많이 쌓이면 새로 쓴다.
        for i in 0..1100u32 {
            let e = wrap((i % 200 + 1) as u8, &p, &format!("c{i}"), now - i as i64);
            let id = e["id"].as_str().unwrap().to_string();
            take(e, Kind::Wrap);
            with(|b| { b.remove(&id, true); });
        }
        flush();
        let lines = std::fs::read_to_string(log_file()).unwrap().lines().count();
        assert_eq!(lines, 1, "압축하면 남은 것만");
        reset(false);
    }
}
