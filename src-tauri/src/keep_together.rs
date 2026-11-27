//! 「서로 지켜 주기」 1단계 — 게임·가게·곡 파일을 데스크탑 **여러 대가 나눠** 지킨다. (2026-11-28)
//!
//! ## 무엇이 문제였나 (11-25 감사)
//!
//! - 돕기(`arcade_keep` ②)를 켠 컴퓨터가 **전부 같은 순서**(확인 판매자 → 이름 순)로 골랐다.
//!   돕는 사람이 열이어도 다 같은 게임 몇 개에 몰리고, 이름이 뒤쪽인 게임은 아무도 안 지켰다.
//! - 「몇 대가 지키고 있나」를 아무도 세지 않았다. 판매자는 자기 게임이 한 대(자기 컴퓨터)에만 있는지 몰랐다.
//! - 못 받은 파일은 바퀴마다(붙잡기 한 번에 최대 900초) 똑같이 다시 시도했다.
//! - 곡 파일은 매니페스트 JSON 안에 글자로만 적혀 있어서 **아무도 붙잡지 않았다**(매니페스트만 붙잡혔다).
//!
//! ## 하는 일
//!
//! 1. **HRW(랑데부) 고르기** — CID 마다 `sha256(CID ‖ 돕는 사람 id)` 점수가 큰 순서로 돕는 사람을 줄 세우고 **위 3명**이 지킨다.
//!    모두가 같은 계산을 하므로 서로 묻지 않아도 같은 답이 나온다. 돕는 사람이 하나 들어오거나 나가도
//!    그 사람 몫만 옮겨 간다(나머지는 그대로 — 이름 순처럼 전부 밀리지 않는다).
//! 2. **돕는 사람 목록** — 돕기를 「모든 게임」으로 켠 컴퓨터가 6시간마다 이야기 열쇠로 서명한 짧은 알림
//!    (kind 30078 · d=`ravenvault/keeper/v1` · t=`ravenvault-keeper`)을 올린다. 48시간 안에 온 것만 센다.
//!    다른 출처(판매자 상태 알림 `claude/seller-status`)는 `HelperDirectory` 로 나중에 그대로 붙인다.
//! 3. **세기** — 판매자 컴퓨터는 내 게임 폴더를 `routing/findprovs` 로 물어 「○대가 지키는 중」을 센다.
//!    3대보다 적으면 다시 알린다(provide).
//! 4. **물러서기(backoff)** — 못 받은 CID 는 10분 → 20분 → 40분 … 최대 24시간 쉬었다가 다시 본다.
//! 5. **곡·책 파일** — `rv-creator-manifest` 의 `files[].cid`·`cover.cid`·`look.images[].cid` 도 매니페스트처럼 붙잡는다.
//!
//! ## 🔴 지키는 것
//!
//! - 돕기는 **기본 꺼짐** 그대로다. 이 파일은 켜는 곳이 없다. 꺼져 있으면 알림도 안 올린다(끌 때 「꺼짐」 한 번).
//! - 이야기 열쇠는 **만들지 않는다**(`talk::key_on_disk`). 없으면 알리지 않고, 나는 목록 밖의 한 사람으로만 계산한다.
//! - 알림에는 파일창고 peer id·「꽉 참」 여부만 적는다. 지갑 주소·잔액·가게 정보는 없다.
//! - 목록을 못 읽은 바퀴(빈 목록)에서는 내가 모든 CID 의 1등이 된다 — 예전처럼 다 지키고, **아무것도 풀지 않는다**.
//!
//! ## 아직 아닌 것(2단계 메모)
//!
//! - NAT 뒤 컴퓨터는 지켜도 바깥에서 못 받는다 — 알림에 바깥 주소(gw)를 넣는 것은 다음 단계.
//! - 아무나 알림을 올려 순위를 차지할 수 있다(시빌). 지금은 「알림만 올리고 안 지키는」 사람이 있어도
//!   판매자의 세기가 3대 미만을 보여 주고, 돕는 쪽은 여유(`KEEP_SLACK`)로 버틴다. 서명된 지킴이 명단·보관 증명은 다음 단계.
//! - 3대 미만일 때 「지켜 주세요」 부탁 알림은 아직 없다(다시 알리기만).

use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::sync::Mutex;

const API: &str = "http://127.0.0.1:5001/api/v0";

/// 한 CID 를 지키는 목표 대수(판매자 자신 포함해서 센다).
pub const KEEP_TARGET: usize = 3;
/// 이미 지키던 것은 순위가 조금 밀려도(새 돕는 사람이 들어옴) 바로 풀지 않는다 — 새 사람이 받기 전에 사본이 줄지 않게.
pub const KEEP_SLACK: usize = 2;

pub const HEARTBEAT_KIND: i64 = 30078;
pub const KEEPER_D: &str = "ravenvault/keeper/v1";
pub const KEEPER_TAG: &str = "ravenvault-keeper";
/// 이보다 오래된 알림은 「지금 돕는 사람」이 아니다.
pub const HEARTBEAT_FRESH_SECS: i64 = 48 * 3600;
/// 같은 상태면 이 간격으로만 다시 알린다.
pub const HEARTBEAT_EVERY_SECS: i64 = 6 * 3600;
/// 돕는 사람 목록을 다시 읽는 간격.
const DIR_CACHE_SECS: i64 = 30 * 60;
/// 알림 한 개 크기 상한(릴레이 검사와 같은 값).
pub const HEARTBEAT_MAX_BYTES: usize = 1024;

/// 같은 CID 를 다시 세기까지.
pub const VERIFY_EVERY_SECS: i64 = 2 * 3600;
/// 세기 한 번에 기다리는 시간. DHT 는 느리다 — 다 모으지 못해도 그때까지 모인 것으로 센다.
const FINDPROVS_SECS: u64 = 45;
/// 세기에서 물어보는 최대 수(3대만 보면 되지만 넉넉히).
const FINDPROVS_MAX: usize = 20;

/// 매니페스트 상한(core/creator MAX_MANIFEST_BYTES).
pub const MAX_MANIFEST_BYTES: usize = 64 * 1024;
/// 한 매니페스트에서 따라가는 파일 수(앨범 20곡 + 표지 + 꾸밈 그림 8 + 여유).
pub const MAX_MANIFEST_FILES: usize = 60;

fn now() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0)
}

fn cid_v0(s: &str) -> bool {
    s.len() == 46 && s.starts_with("Qm") && s.bytes().all(|b| b.is_ascii_alphanumeric() && !matches!(b, b'0' | b'O' | b'I' | b'l'))
}

/* ── ① HRW(랑데부) 고르기 ─────────────────────────────────────────── */

/// CID 와 돕는 사람 하나의 점수. 앞에 영역 글자를 붙여 다른 해시 쓰임과 섞이지 않게 한다.
pub fn hrw_score(cid: &str, id: &str) -> u64 {
    let mut h = Sha256::new();
    h.update(b"rv-keep-hrw/v1\0");
    h.update(cid.as_bytes());
    h.update([0u8]);
    h.update(id.as_bytes());
    let d = h.finalize();
    let mut b = [0u8; 8];
    b.copy_from_slice(&d[..8]);
    u64::from_be_bytes(b)
}

/// 이 CID 를 지킬 순서(점수 큰 순 · 같으면 id 순). 겹친 id 는 한 번만.
pub fn ranked(cid: &str, ids: &[String]) -> Vec<String> {
    let mut v: Vec<(u64, &String)> = Vec::new();
    let mut seen = HashSet::new();
    for id in ids {
        if !id.is_empty() && seen.insert(id.as_str()) {
            v.push((hrw_score(cid, id), id));
        }
    }
    v.sort_by(|a, b| b.0.cmp(&a.0).then(a.1.cmp(b.1)));
    v.into_iter().map(|(_, id)| id.clone()).collect()
}

/// 이 CID 를 지킬 위 `n` 명. (2단계: 판매자 화면이 「누가 맡았나」를 보여 줄 때 쓴다 — 지금은 시험만.)
#[allow(dead_code)]
pub fn top_keepers(cid: &str, ids: &[String], n: usize) -> Vec<String> {
    ranked(cid, ids).into_iter().take(n).collect()
}

/// 한 바퀴 동안 쓰는 고르기 재료: 나 + 지금 돕는 사람들.
#[derive(Clone, Debug, PartialEq)]
pub struct Hrw {
    pub me: String,
    pub helpers: Vec<String>,
}
impl Hrw {
    pub fn new(me: String, helpers: Vec<String>) -> Self {
        Hrw { me, helpers }
    }
    /// 이 CID 에서 내 순위(0 = 1등). 나는 늘 목록 안에 있다.
    pub fn rank(&self, cid: &str) -> usize {
        let mut ids = self.helpers.clone();
        ids.push(self.me.clone());
        ranked(cid, &ids).iter().position(|x| *x == self.me).unwrap_or(0)
    }
    /// 새로 붙잡을까 — 위 3명 안이면.
    pub fn wants_new(&self, cid: &str) -> bool {
        self.rank(cid) < KEEP_TARGET
    }
    /// 이미 지키던 것을 계속 둘까 — 여유(`KEEP_SLACK`)까지는 둔다.
    pub fn wants_kept(&self, cid: &str) -> bool {
        self.rank(cid) < KEEP_TARGET + KEEP_SLACK
    }
}

/* ── ② 돕는 사람 목록 ─────────────────────────────────────────────── */

/// 어디서 알게 된 돕는 사람인가.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum HelperSource {
    /// 이 파일의 kind 30078 알림.
    Heartbeat,
    /// 판매자 상태 알림(`claude/seller-status` 브랜치) — 붙일 자리만 만들어 둔다.
    #[allow(dead_code)]
    SellerStatus,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Helper {
    /// HRW 에 쓰는 id = 알림에 서명한 이야기 열쇠(x-only 16진수 64자).
    pub id: String,
    /// 파일창고 peer id(세기 결과와 맞춰 볼 때).
    pub peer: Option<String>,
    pub seen_at: i64,
    /// 고른 용량이 다 찼다 — 새 CID 를 맡기지 않는다.
    pub full: bool,
    pub source: HelperSource,
}

/// 돕는 사람을 알려 주는 곳. 새 출처(판매자 상태 알림 등)는 이것만 구현하면 `merge_helpers` 에 그대로 들어간다.
pub trait HelperDirectory {
    fn helpers(&self, now: i64) -> Vec<Helper>;
}

/// 릴레이에서 읽은 알림 묶음. `verify` 는 서명 확인(본 코드는 `relay::verify`, 시험은 대신 넣는다).
pub struct HeartbeatEvents<'a> {
    pub events: &'a [Value],
    pub verify: fn(&Value) -> bool,
}
impl HelperDirectory for HeartbeatEvents<'_> {
    fn helpers(&self, now: i64) -> Vec<Helper> {
        self.events.iter().filter(|e| (self.verify)(e)).filter_map(|e| helper_from_event(e, now)).collect()
    }
}

fn tag_is(e: &Value, name: &str, val: &str) -> bool {
    e.get("tags").and_then(Value::as_array).is_some_and(|t| {
        t.iter().any(|x| x.get(0).and_then(Value::as_str) == Some(name) && x.get(1).and_then(Value::as_str) == Some(val))
    })
}

fn peer_ok(p: &str) -> bool {
    (30..=80).contains(&p.len()) && p.bytes().all(|b| b.is_ascii_alphanumeric())
}

/// 알림 모양만 본다(서명은 따로). 릴레이도 이 잣대로 받는다(`relay::smells_bad`).
pub fn heartbeat_shape(e: &Value) -> Result<(), String> {
    if e.get("kind").and_then(Value::as_i64) != Some(HEARTBEAT_KIND) || !tag_is(e, "d", KEEPER_D) {
        return Err("지킴이 알림이 아닙니다".into());
    }
    let size = serde_json::to_string(e).map(|s| s.len()).unwrap_or(usize::MAX);
    if size > HEARTBEAT_MAX_BYTES {
        return Err(format!("지킴이 알림이 너무 큽니다({size}바이트)"));
    }
    let c: Value = serde_json::from_str(e.get("content").and_then(Value::as_str).unwrap_or("")).map_err(|_| "지킴이 알림 모양이 아닙니다")?;
    if c.get("v").and_then(Value::as_i64) != Some(1) {
        return Err("지킴이 알림 판이 다릅니다".into());
    }
    match c.get("mode").and_then(Value::as_str) {
        Some("all" | "off") => {}
        _ => return Err("지킴이 알림 방식이 이상합니다".into()),
    }
    if c.get("peer").and_then(Value::as_str).is_some_and(|p| !peer_ok(p)) {
        return Err("파일창고 id 모양이 이상합니다".into());
    }
    Ok(())
}

/// 알림 하나 → 지금 돕는 사람(아니면 None). 「모든 게임」으로 켠 사람만 — 「이 가게만」은 고른 가게만 지키므로 HRW 에 넣지 않는다.
pub fn helper_from_event(e: &Value, now: i64) -> Option<Helper> {
    heartbeat_shape(e).ok()?;
    if !tag_is(e, "t", KEEPER_TAG) {
        return None;
    }
    let id = e.get("pubkey").and_then(Value::as_str)?;
    if id.len() != 64 || !id.bytes().all(|b| b.is_ascii_hexdigit()) {
        return None;
    }
    let at = e.get("created_at").and_then(Value::as_i64)?;
    if at < now - HEARTBEAT_FRESH_SECS || at > now + 600 {
        return None;
    }
    let c: Value = serde_json::from_str(e.get("content").and_then(Value::as_str)?).ok()?;
    if c.get("mode").and_then(Value::as_str) != Some("all") {
        return None;
    }
    Some(Helper {
        id: id.to_ascii_lowercase(),
        peer: c.get("peer").and_then(Value::as_str).map(str::to_string),
        seen_at: at,
        full: c.get("full").and_then(Value::as_bool).unwrap_or(false),
        source: HelperSource::Heartbeat,
    })
}

/// 여러 출처를 합친다 — 같은 id 는 가장 최근 것만(「꺼짐」 알림이 더 최근이면 빠진다: 아래 `latest_off`).
pub fn merge_helpers(sources: &[&dyn HelperDirectory], now: i64) -> Vec<Helper> {
    let mut m: HashMap<String, Helper> = HashMap::new();
    for s in sources {
        for h in s.helpers(now) {
            match m.get(&h.id) {
                Some(old) if old.seen_at >= h.seen_at => {}
                _ => {
                    m.insert(h.id.clone(), h);
                }
            }
        }
    }
    let mut v: Vec<Helper> = m.into_values().collect();
    v.sort_by(|a, b| a.id.cmp(&b.id));
    v
}

/// 사람마다 가장 최근 알림이 「꺼짐」이면 그 사람은 뺀다(예전 「켜짐」 알림이 아직 남아 있어도).
pub fn drop_withdrawn(helpers: Vec<Helper>, events: &[Value], verify: fn(&Value) -> bool) -> Vec<Helper> {
    let mut latest: HashMap<&str, (i64, bool)> = HashMap::new();
    for e in events.iter().filter(|e| heartbeat_shape(e).is_ok() && verify(e)) {
        let (Some(pk), Some(at)) = (e.get("pubkey").and_then(Value::as_str), e.get("created_at").and_then(Value::as_i64)) else { continue };
        let off = e.get("content").and_then(Value::as_str).and_then(|c| serde_json::from_str::<Value>(c).ok())
            .and_then(|c| c.get("mode").and_then(Value::as_str).map(|m| m == "off")).unwrap_or(false);
        if latest.get(pk).is_none_or(|(t, _)| at > *t) {
            latest.insert(pk, (at, off));
        }
    }
    helpers.into_iter().filter(|h| !latest.get(h.id.as_str()).is_some_and(|(_, off)| *off)).collect()
}

/// HRW 에 넣을 id — 꽉 찬 사람·나 자신은 뺀다(나는 `Hrw.me` 로 따로 들어간다).
pub fn hrw_ids(helpers: &[Helper], me: &str) -> Vec<String> {
    helpers.iter().filter(|h| !h.full && h.id != me).map(|h| h.id.clone()).collect()
}

/// 알림 내용(서명 전).
pub fn heartbeat_content(on: bool, peer: Option<&str>, full: bool) -> String {
    let mut c = json!({ "v": 1, "mode": if on { "all" } else { "off" } });
    if on {
        if let Some(p) = peer.filter(|p| peer_ok(p)) {
            c["peer"] = json!(p);
        }
        c["full"] = json!(full);
    }
    c.to_string()
}

pub fn heartbeat_tags() -> Value {
    json!([["d", KEEPER_D], ["t", KEEPER_TAG]])
}

/// 다시 알릴 때인가 — 상태가 바뀌었거나 6시간이 지났을 때. 꺼진 채로 한 번도 안 알렸으면 알리지 않는다.
pub fn heartbeat_due(last: Option<&(i64, String)>, state: &str, on: bool, now: i64) -> bool {
    match last {
        None => on,
        Some((at, s)) => s != state || (on && now - at >= HEARTBEAT_EVERY_SECS),
    }
}

static DIR: Mutex<Option<(i64, Vec<Helper>)>> = Mutex::new(None);
static BEAT: Mutex<Option<(i64, String)>> = Mutex::new(None);

/// 이 컴퓨터의 HRW id — 이야기 열쇠(만들지 않는다). 없으면 파일창고 peer id 를 빌려 「anon:」 을 붙인다(목록 밖 한 사람).
pub async fn my_id() -> String {
    if let Some(pk) = crate::talk::key_on_disk().and_then(|(sk, _, _)| crate::shopkey::pubkey_of(&sk).ok()) {
        return pk;
    }
    format!("anon:{}", my_peer_id().await.unwrap_or_default())
}

/// 지금 돕는 사람들(30분 기억). 못 읽으면 지난 목록, 그것도 없으면 빈 목록.
pub async fn helpers_now() -> Vec<Helper> {
    let at = now();
    if let Some((t, v)) = DIR.lock().ok().and_then(|g| g.clone()) {
        if at - t < DIR_CACHE_SECS {
            return v;
        }
    }
    let events = crate::nostrpub::nostr_query_tag(vec![HEARTBEAT_KIND], "t".into(), vec![KEEPER_TAG.into()], 200).await.unwrap_or_default();
    if events.is_empty() {
        return DIR.lock().ok().and_then(|g| g.as_ref().map(|(_, v)| v.clone())).unwrap_or_default();
    }
    let hb = HeartbeatEvents { events: &events, verify: crate::relay::verify };
    let v = drop_withdrawn(merge_helpers(&[&hb], at), &events, crate::relay::verify);
    if let Ok(mut g) = DIR.lock() {
        *g = Some((at, v.clone()));
    }
    v
}

/// 한 바퀴 고르기 재료.
pub async fn hrw_now() -> Hrw {
    let me = my_id().await;
    let helpers = helpers_now().await;
    Hrw::new(me.clone(), hrw_ids(&helpers, &me))
}

/// 돕기 상태를 알린다. 켜짐(「모든 게임」)이면 6시간마다, 바뀌면 바로. 끄면 「꺼짐」 한 번. 열쇠가 없으면 조용히 건너뛴다.
pub async fn heartbeat_step(on: bool, full: bool) {
    let state = format!("{}/{}", if on { "all" } else { "off" }, full);
    let at = now();
    let last = BEAT.lock().ok().and_then(|g| g.clone());
    if !heartbeat_due(last.as_ref(), &state, on, at) {
        return;
    }
    let Some((sk, _, _)) = crate::talk::key_on_disk() else { return };
    let peer = if on { my_peer_id().await } else { None };
    let Ok(ev) = crate::shopkey::sign_with(&sk, HEARTBEAT_KIND, heartbeat_tags(), &heartbeat_content(on, peer.as_deref(), full), at) else { return };
    let Ok(msg) = serde_json::to_string(&json!(["EVENT", ev])) else { return };
    let urls = crate::nostrpub::outside_relays();
    let got = futures_util::future::join_all(urls.iter().map(|u| crate::nostrpub::send_one(u, &msg))).await;
    if got.iter().any(Result::is_ok) {
        if let Ok(mut g) = BEAT.lock() {
            *g = Some((at, state));
        }
    }
}

/// 「꺼짐」을 바로 알린다(설정에서 끌 때). 지난 상태를 잊고 한 번 보낸다.
pub async fn heartbeat_withdraw() {
    if let Ok(mut g) = BEAT.lock() {
        // 한 번도 안 알렸어도(앱을 다시 켠 뒤) 옛 「켜짐」이 릴레이에 남아 있을 수 있다 — 꺼짐을 꼭 보낸다.
        *g = Some((0, "all/?".into()));
    }
    heartbeat_step(false, false).await;
}

/* ── ③ 몇 대가 지키나 ─────────────────────────────────────────────── */

/// 이 파일창고의 peer id.
pub async fn my_peer_id() -> Option<String> {
    let r = reqwest::Client::new().post(format!("{API}/id")).timeout(std::time::Duration::from_secs(5)).send().await.ok()?;
    let v: Value = r.json().await.ok()?;
    v.get("ID").and_then(Value::as_str).filter(|p| peer_ok(p)).map(str::to_string)
}

/// `routing/findprovs` 답(줄마다 JSON) → 가진 곳 peer id 들. Type 4 = 「가진 곳」.
pub fn parse_findprovs(text: &str) -> HashSet<String> {
    let mut out = HashSet::new();
    for line in text.lines() {
        let Ok(v) = serde_json::from_str::<Value>(line.trim()) else { continue };
        if v.get("Type").and_then(Value::as_i64) != Some(4) {
            continue;
        }
        for r in v.get("Responses").and_then(Value::as_array).into_iter().flatten() {
            if let Some(id) = r.get("ID").and_then(Value::as_str).filter(|p| peer_ok(p)) {
                out.insert(id.to_string());
            }
        }
    }
    out
}

/// 가진 곳을 DHT 에 묻는다. 새 kubo 는 `routing/findprovs`, 옛 kubo 는 `dht/findprovs`.
/// 답이 줄줄이 흘러오므로 조각씩 읽고, 시간이 다 되면 그때까지 모인 것으로 센다. 못 물으면 None.
pub async fn provider_ids(cid: &str) -> Option<HashSet<String>> {
    for path in ["routing/findprovs", "dht/findprovs"] {
        let url = format!("{API}/{path}?arg={cid}&num-providers={FINDPROVS_MAX}");
        let Ok(mut r) = reqwest::Client::new().post(&url).timeout(std::time::Duration::from_secs(FINDPROVS_SECS + 5)).send().await else { continue };
        if !r.status().is_success() {
            continue;
        }
        let mut buf: Vec<u8> = Vec::new();
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(FINDPROVS_SECS);
        loop {
            match tokio::time::timeout_at(deadline, r.chunk()).await {
                Ok(Ok(Some(c))) => {
                    buf.extend_from_slice(&c);
                    if buf.len() > 1024 * 1024 {
                        break;
                    }
                }
                _ => break,
            }
        }
        return Some(parse_findprovs(&String::from_utf8_lossy(&buf)));
    }
    None
}

/// 지키는 대수 = DHT 가 아는 곳 ∪ (내가 붙잡고 있으면) 나.
pub fn keeper_count(providers: &HashSet<String>, me: Option<&str>, i_hold: bool) -> usize {
    let mut all: HashSet<&str> = providers.iter().map(String::as_str).collect();
    if let (Some(m), true) = (me, i_hold) {
        all.insert(m);
    }
    all.len()
}

static COUNTS: Mutex<Option<HashMap<String, (usize, i64)>>> = Mutex::new(None);

/// 마지막으로 센 값(대수, 센 시각).
pub fn keepers_of(cid: &str) -> Option<(usize, i64)> {
    COUNTS.lock().ok().and_then(|g| g.as_ref().and_then(|m| m.get(cid).copied()))
}

pub fn verify_due(cid: &str, now: i64) -> bool {
    keepers_of(cid).is_none_or(|(_, at)| now - at >= VERIFY_EVERY_SECS)
}

/// 세고 적어 둔다. 못 물으면 적지 않는다(None).
pub async fn count_keepers(cid: &str, i_hold: bool) -> Option<usize> {
    let providers = provider_ids(cid).await?;
    let me = my_peer_id().await;
    let n = keeper_count(&providers, me.as_deref(), i_hold);
    if let Ok(mut g) = COUNTS.lock() {
        let m = g.get_or_insert_with(HashMap::new);
        if m.len() > 2_000 {
            m.clear();
        }
        m.insert(cid.to_string(), (n, now()));
    }
    Some(n)
}

/* ── ④ 물러서기(backoff) ──────────────────────────────────────────── */

/// 실패 `fails` 번째 뒤 쉬는 시간: base × 2^(fails-1), 최대 max. 0 번이면 쉬지 않는다.
pub fn backoff_delay(fails: u32, base: i64, max: i64) -> i64 {
    if fails == 0 {
        return 0;
    }
    let shift = (fails - 1).min(30);
    base.saturating_mul(1i64 << shift).min(max)
}

/// CID 별 실패 기록. 성공하면 지운다.
#[derive(Clone, Debug)]
pub struct Backoff {
    base: i64,
    max: i64,
    m: HashMap<String, (u32, i64)>,
}
impl Backoff {
    pub fn new(base: i64, max: i64) -> Self {
        Backoff { base, max, m: HashMap::new() }
    }
    /// 지금 다시 해 봐도 되나.
    pub fn ready(&self, cid: &str, now: i64) -> bool {
        self.m.get(cid).is_none_or(|(_, next)| now >= *next)
    }
    /// 실패를 적고 다음 시도 시각을 돌려준다.
    pub fn fail(&mut self, cid: &str, now: i64) -> i64 {
        if self.m.len() > 5_000 {
            self.m.clear();
        }
        let fails = self.m.get(cid).map(|(f, _)| f + 1).unwrap_or(1);
        let next = now + backoff_delay(fails, self.base, self.max);
        self.m.insert(cid.to_string(), (fails, next));
        next
    }
    pub fn ok(&mut self, cid: &str) {
        self.m.remove(cid);
    }
    #[allow(dead_code)]
    pub fn fails(&self, cid: &str) -> u32 {
        self.m.get(cid).map(|(f, _)| *f).unwrap_or(0)
    }
}

/// 게임·곡 붙잡기 실패: 10분부터 두 배씩 · 최대 하루.
pub const FETCH_BACKOFF_BASE_SECS: i64 = 10 * 60;
pub const FETCH_BACKOFF_MAX_SECS: i64 = 24 * 3600;
static FETCH_BACKOFF: Mutex<Option<Backoff>> = Mutex::new(None);

fn with_fetch<R>(f: impl FnOnce(&mut Backoff) -> R) -> Option<R> {
    let mut g = FETCH_BACKOFF.lock().ok()?;
    Some(f(g.get_or_insert_with(|| Backoff::new(FETCH_BACKOFF_BASE_SECS, FETCH_BACKOFF_MAX_SECS))))
}
pub fn fetch_ready(cid: &str) -> bool {
    with_fetch(|b| b.ready(cid, now())).unwrap_or(true)
}
pub fn fetch_failed(cid: &str) {
    with_fetch(|b| b.fail(cid, now()));
}
pub fn fetch_ok(cid: &str) {
    with_fetch(|b| b.ok(cid));
}

/* ── ⑤ 곡·책 파일(매니페스트 안의 CID) ─────────────────────────────── */

/// `rv-creator-manifest`(v2·v3) → 안에 적힌 파일 CID 들(곡·책·표지·꾸밈 그림). 모양이 아니면 빈 목록.
/// 서명은 여기서 보지 않는다 — 이 매니페스트는 체인 자산이 가리키는 것만 들어온다(`peers::pin_these` 가 체인 대조 뒤 부른다).
pub fn manifest_file_cids(bytes: &[u8]) -> Vec<String> {
    if bytes.len() > MAX_MANIFEST_BYTES {
        return vec![];
    }
    let Ok(v) = serde_json::from_slice::<Value>(bytes) else { return vec![] };
    if v.get("format").and_then(Value::as_str) != Some("rv-creator-manifest") {
        return vec![];
    }
    let mut out: Vec<String> = Vec::new();
    let mut push = |e: Option<&Value>| {
        if let Some(c) = e.and_then(|e| e.get("cid")).and_then(Value::as_str) {
            if cid_v0(c) && !out.iter().any(|x| x == c) && out.len() < MAX_MANIFEST_FILES {
                out.push(c.to_string());
            }
        }
    };
    for f in v.get("files").and_then(Value::as_array).into_iter().flatten() {
        push(Some(f));
    }
    push(v.get("cover"));
    for f in v.get("look").and_then(|l| l.get("images")).and_then(Value::as_array).into_iter().flatten() {
        push(Some(f));
    }
    out
}

async fn is_pinned(cid: &str) -> bool {
    reqwest::Client::new()
        .post(format!("{API}/pin/ls?arg={cid}&type=recursive"))
        .timeout(std::time::Duration::from_secs(20))
        .send()
        .await
        .is_ok_and(|r| r.status().is_success())
}

async fn read_local(cid: &str, max: usize) -> Option<Vec<u8>> {
    let r = reqwest::Client::new()
        .post(format!("{API}/cat?arg={cid}&length={}", max + 1))
        .timeout(std::time::Duration::from_secs(20))
        .send()
        .await
        .ok()?;
    if !r.status().is_success() {
        return None;
    }
    let b = r.bytes().await.ok()?;
    (b.len() <= max).then(|| b.to_vec())
}

/// 붙잡은 매니페스트 안의 파일도 붙잡는다. (새로 붙잡음, 못 붙잡음) — 이미 붙잡힌 것은 세지 않는다.
/// 「보관 안 하기」로 정한 주소는 건드리지 않는다. 못 받은 것은 물러서기 규칙으로 쉰다.
pub async fn keep_manifest_files(manifest_cid: &str) -> (usize, usize) {
    let Some(bytes) = read_local(manifest_cid, MAX_MANIFEST_BYTES).await else { return (0, 0) };
    let (mut kept, mut failed) = (0usize, 0usize);
    for cid in manifest_file_cids(&bytes) {
        if crate::asset_keep::load().is_skipped(&cid) {
            continue;
        }
        if is_pinned(&cid).await {
            fetch_ok(&cid);
            continue;
        }
        if !fetch_ready(&cid) {
            failed += 1;
            continue;
        }
        // 살아 있는지 먼저 짧게(뿌리 블록만) — 없으면 5분씩 붙잡지 않는다.
        if !crate::peers::root_alive_at(API, &cid, 20).await {
            fetch_failed(&cid);
            failed += 1;
            continue;
        }
        match crate::ipfs::pin_add(cid.clone()).await {
            Ok(true) if crate::asset_keep::load().is_skipped(&cid) => {
                let _ = crate::ipfs::pin_remove(cid.clone()).await;
            }
            Ok(true) => {
                fetch_ok(&cid);
                kept += 1;
            }
            _ => {
                fetch_failed(&cid);
                failed += 1;
            }
        }
    }
    (kept, failed)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ids(n: usize) -> Vec<String> {
        (0..n).map(|i| format!("{:064x}", i + 1)).collect()
    }
    fn q(i: usize) -> String {
        // 46자 CIDv0 모양(시험용)
        let body: String = format!("{i:0>44}").chars().map(|c| if c == '0' { 'z' } else { c }).collect();
        format!("Qm{body}")
    }

    /// 🔴 같은 재료면 누가 계산해도 같은 답 · 순서가 바뀌어도 같은 답.
    #[test]
    fn hrw_는_누가_계산해도_같다() {
        let h = ids(10);
        let mut rev = h.clone();
        rev.reverse();
        for i in 0..50 {
            let cid = q(i);
            assert_eq!(top_keepers(&cid, &h, 3), top_keepers(&cid, &rev, 3), "순서와 무관");
            assert_eq!(top_keepers(&cid, &h, 3).len(), 3);
        }
        assert_eq!(hrw_score("QmA", "x"), hrw_score("QmA", "x"));
        assert_ne!(hrw_score("QmA", "x"), hrw_score("QmB", "x"));
        let dup = vec!["a".to_string(), "a".to_string(), "b".to_string()];
        assert_eq!(ranked("QmA", &dup).len(), 2, "겹친 id 는 한 번");
    }

    /// 🔴 돕는 사람이 하나 들어와도 그 사람 몫만 옮겨 간다 — 이름 순처럼 전부 밀리지 않는다.
    #[test]
    fn hrw_는_한_사람이_들어와도_대부분_그대로다() {
        let before = ids(10);
        let mut after = before.clone();
        after.push(format!("{:064x}", 999));
        let n = 300;
        let mut changed = 0;
        for i in 0..n {
            let cid = q(i);
            let a = top_keepers(&cid, &before, 3);
            let b = top_keepers(&cid, &after, 3);
            // 새 사람이 안 들어간 CID 는 그대로여야 한다.
            if !b.contains(&after[10]) {
                assert_eq!(a, b, "새 사람이 안 맡은 CID 는 지키는 사람이 그대로");
            } else {
                changed += 1;
                // 새 사람이 들어간 자리에서도 나머지 둘은 원래 위 3명 안에 있던 사람이다.
                assert!(b.iter().filter(|x| **x != after[10]).all(|x| a.contains(x)));
            }
        }
        // 11명 중 3명 → 약 27%. 넉넉히 10~45% 안.
        assert!(changed > n / 10 && changed < n * 45 / 100, "옮겨 간 몫: {changed}/{n}");
    }

    /// 🔴 몰리지 않는다 — 10명이 300개를 나누면 각자 대략 90개(3배 사본).
    #[test]
    fn hrw_는_고르게_나눈다() {
        let h = ids(10);
        let mut load: HashMap<String, usize> = HashMap::new();
        for i in 0..300 {
            for k in top_keepers(&q(i), &h, KEEP_TARGET) {
                *load.entry(k).or_default() += 1;
            }
        }
        assert_eq!(load.len(), 10, "모두가 몫을 받는다");
        for (k, n) in &load {
            assert!((45..=135).contains(n), "{k} 가 {n}개 — 너무 몰리거나 비었다");
        }
    }

    #[test]
    fn 내_순위와_여유() {
        // 목록이 비면(못 읽음) 나는 늘 1등 — 예전처럼 다 지킨다.
        let alone = Hrw::new("me".into(), vec![]);
        assert!((0..20).all(|i| alone.rank(&q(i)) == 0 && alone.wants_new(&q(i))));
        // 6명(나 포함)이면 위 3명만 새로 받고, 이미 지키던 것은 5등까지 둔다.
        let h = Hrw::new("me".into(), ids(5));
        let mut new_n = 0;
        for i in 0..200 {
            let r = h.rank(&q(i));
            assert_eq!(h.wants_new(&q(i)), r < 3);
            assert_eq!(h.wants_kept(&q(i)), r < 5);
            if h.wants_new(&q(i)) { new_n += 1; }
        }
        assert!(new_n > 60 && new_n < 140, "6명 중 3명 → 약 절반: {new_n}");
        // 나 자신이 목록에 있어도 두 번 세지 않는다.
        let mut with_me = ids(5);
        with_me.push("me".into());
        assert_eq!(Hrw::new("me".into(), with_me).rank(&q(1)), h.rank(&q(1)));
    }

    #[test]
    fn 물러서기는_두_배씩_하루까지() {
        let (b, m) = (FETCH_BACKOFF_BASE_SECS, FETCH_BACKOFF_MAX_SECS);
        assert_eq!(backoff_delay(0, b, m), 0);
        assert_eq!(backoff_delay(1, b, m), 600);
        assert_eq!(backoff_delay(2, b, m), 1200);
        assert_eq!(backoff_delay(3, b, m), 2400);
        assert_eq!(backoff_delay(8, b, m), 76_800, "10분 × 128 = 21시간 20분");
        assert_eq!(backoff_delay(9, b, m), 86_400, "10분 × 256 → 하루를 넘지 않게 자른다");
        assert_eq!(backoff_delay(200, b, m), 86_400, "넘침 없이");
        let mut bo = Backoff::new(b, m);
        assert!(bo.ready("Q", 0));
        assert_eq!(bo.fail("Q", 1000), 1600);
        assert!(!bo.ready("Q", 1599) && bo.ready("Q", 1600));
        assert_eq!(bo.fail("Q", 1600), 2800, "두 번째 실패는 20분");
        assert_eq!(bo.fails("Q"), 2);
        bo.ok("Q");
        assert!(bo.ready("Q", 0) && bo.fails("Q") == 0, "성공하면 잊는다");
        assert!(bo.ready("다른것", 0), "다른 CID 는 상관없다");
    }

    fn hb(pk: &str, at: i64, content: &str) -> Value {
        json!({ "kind": 30078, "pubkey": pk, "created_at": at, "tags": [["d", KEEPER_D], ["t", KEEPER_TAG]], "content": content, "id": "x", "sig": "y" })
    }
    fn yes(_: &Value) -> bool { true }
    fn no(_: &Value) -> bool { false }
    const NOW: i64 = 1_800_000_000;
    const PEER: &str = "12D3KooWLRPJAA5o6LdL8KT3TVuQ3XN1ZiHxNJ3x3VbbnmmXp5Pc";

    #[test]
    fn 돕는_사람_목록은_서명_신선함_모양을_본다() {
        let a = "a".repeat(64);
        let b = "b".repeat(64);
        let c = "c".repeat(64);
        let on = heartbeat_content(true, Some(PEER), false);
        let events = vec![
            hb(&a, NOW - 100, &on),
            hb(&b, NOW - HEARTBEAT_FRESH_SECS - 1, &on),           // 오래됨
            hb(&c, NOW - 100, r#"{"v":1,"mode":"shops"}"#),         // 방식 이상
            hb("zz", NOW - 100, &on),                               // 열쇠 모양 아님
        ];
        let got = HeartbeatEvents { events: &events, verify: yes }.helpers(NOW);
        assert_eq!(got.len(), 1);
        assert_eq!((got[0].id.as_str(), got[0].peer.as_deref(), got[0].full), (a.as_str(), Some(PEER), false));
        assert!(HeartbeatEvents { events: &events, verify: no }.helpers(NOW).is_empty(), "서명이 틀리면 하나도 안 센다");
        // 같은 사람은 최신 것만 · 최신이 「꺼짐」이면 뺀다 · 꽉 찬 사람은 HRW 에서 뺀다.
        let ev2 = vec![hb(&a, NOW - 500, &on), hb(&a, NOW - 10, &heartbeat_content(false, None, false)), hb(&b, NOW - 5, &heartbeat_content(true, None, true))];
        let hs = drop_withdrawn(merge_helpers(&[&HeartbeatEvents { events: &ev2, verify: yes }], NOW), &ev2, yes);
        assert_eq!(hs.iter().map(|h| h.id.as_str()).collect::<Vec<_>>(), vec![b.as_str()], "a 는 껐다");
        assert!(hrw_ids(&hs, "me").is_empty(), "b 는 꽉 찼다");
        // 모양 검사(릴레이도 쓴다)
        assert!(heartbeat_shape(&hb(&a, NOW, &on)).is_ok());
        assert!(heartbeat_shape(&hb(&a, NOW, "글")).is_err());
        assert!(heartbeat_shape(&hb(&a, NOW, &"x".repeat(2000))).is_err());
        assert!(heartbeat_shape(&json!({ "kind": 30078, "tags": [["d", "RV.S.SHOP"]], "content": on })).is_err(), "가게 공지는 여기 잣대가 아니다");
    }

    /// 다른 출처(판매자 상태 알림)도 같은 자리에 들어온다 — 같은 사람은 더 최근 것.
    #[test]
    fn 다른_출처도_합친다() {
        struct Fixed(Vec<Helper>);
        impl HelperDirectory for Fixed { fn helpers(&self, _: i64) -> Vec<Helper> { self.0.clone() } }
        let h = |id: &str, at: i64, s: HelperSource| Helper { id: id.into(), peer: None, seen_at: at, full: false, source: s };
        let a = Fixed(vec![h("x", 10, HelperSource::Heartbeat), h("y", 10, HelperSource::Heartbeat)]);
        let b = Fixed(vec![h("x", 20, HelperSource::SellerStatus)]);
        let m = merge_helpers(&[&a, &b], NOW);
        assert_eq!(m.len(), 2);
        assert_eq!(m.iter().find(|x| x.id == "x").unwrap().source, HelperSource::SellerStatus);
    }

    #[test]
    fn 알림_때() {
        assert!(!heartbeat_due(None, "off/false", false, NOW), "꺼진 채로는 처음부터 알리지 않는다");
        assert!(heartbeat_due(None, "all/false", true, NOW));
        let last = (NOW - 100, "all/false".to_string());
        assert!(!heartbeat_due(Some(&last), "all/false", true, NOW));
        assert!(heartbeat_due(Some(&last), "all/true", true, NOW), "꽉 차면 바로");
        assert!(heartbeat_due(Some(&last), "off/false", false, NOW), "끄면 바로");
        assert!(heartbeat_due(Some(&(NOW - HEARTBEAT_EVERY_SECS, "all/false".into())), "all/false", true, NOW), "6시간마다");
        assert!(!heartbeat_due(Some(&(NOW - 999_999, "off/false".into())), "off/false", false, NOW), "꺼짐은 한 번만");
        let off: Value = serde_json::from_str(&heartbeat_content(false, Some(PEER), true)).unwrap();
        assert!(off.get("peer").is_none() && off.get("full").is_none(), "꺼짐 알림엔 아무것도 안 적는다");
        let on: Value = serde_json::from_str(&heartbeat_content(true, Some("../x"), false)).unwrap();
        assert!(on.get("peer").is_none(), "이상한 peer id 는 안 적는다");
    }

    #[test]
    fn findprovs_답을_센다() {
        let text = format!(
            "{}\n{}\n{}\n쓰레기\n",
            json!({ "Type": 4, "Responses": [{ "ID": PEER, "Addrs": [] }] }),
            json!({ "Type": 0, "Responses": [{ "ID": "12D3KooWQueryOnlyNotAProvider00000000000000000000" }] }),
            json!({ "Type": 4, "Responses": [{ "ID": PEER }, { "ID": "QmaCpDMGvV2BGHeYERUEnRQAwe3N8SzbUtfsmvsqQLuvuJ" }] }),
        );
        let got = parse_findprovs(&text);
        assert_eq!(got.len(), 2, "가진 곳(Type 4)만 · 겹침 없이: {got:?}");
        assert_eq!(keeper_count(&got, Some(PEER), true), 2, "나는 이미 들어 있다");
        assert_eq!(keeper_count(&got, Some("12D3KooWMeMeMeMeMeMeMeMeMeMeMeMeMeMeMeMeMeMeMe"), true), 3);
        assert_eq!(keeper_count(&got, Some("12D3KooWMeMeMeMeMeMeMeMeMeMeMeMeMeMeMeMeMeMeMe"), false), 2, "안 붙잡았으면 나를 안 센다");
        assert!(parse_findprovs("").is_empty());
    }

    #[test]
    fn 매니페스트_안의_곡_파일을_꺼낸다() {
        let (a, b, c, d) = (q(1), q(2), q(3), q(4));
        let doc = json!({
            "format": "rv-creator-manifest", "version": 3, "type": "music",
            "files": [{ "path": "01.mp3", "cid": a }, { "path": "02.mp3", "cid": b }, { "path": "dup.mp3", "cid": a }],
            "cover": { "path": "cover.jpg", "cid": c },
            "look": { "images": [{ "path": "bg.png", "cid": d }, { "path": "bad", "cid": "../../etc" }] },
            "music": { "format": "ep", "tracks": [{ "title": "하나", "file": "01.mp3" }] },
        });
        assert_eq!(manifest_file_cids(doc.to_string().as_bytes()), vec![a.clone(), b, c, d]);
        assert!(manifest_file_cids(br#"{"format":"rv-arcade-product","files":[]}"#).is_empty(), "다른 문서는 안 본다");
        assert!(manifest_file_cids(b"not json").is_empty());
        let no_cover = json!({ "format": "rv-creator-manifest", "files": [{ "cid": a }], "cover": null });
        assert_eq!(manifest_file_cids(no_cover.to_string().as_bytes()), vec![a]);
        let huge = vec![b' '; MAX_MANIFEST_BYTES + 1];
        assert!(manifest_file_cids(&huge).is_empty(), "64KB 를 넘으면 매니페스트가 아니다");
    }

    /// 🔴 이 파일은 돕기를 켜지 않는다 · 열쇠를 만들지 않는다 · 돈을 보내지 않는다.
    #[test]
    fn 켜지_않고_열쇠를_만들지_않는다() {
        let src = include_str!("keep_together.rs");
        let body = &src[..src.find("#[cfg(test)]").unwrap()];
        for bad in ["signing_key()", "arcade_share_set", "sendtoaddress", "transfer", "Mode::All", "taile277f6"] {
            assert!(!body.contains(bad), "{bad} 가 있으면 안 된다");
        }
        assert!(body.contains("key_on_disk()"));
    }
}
