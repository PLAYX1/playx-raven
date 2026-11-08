//! 폰에서 판매(0.9.18) — 폰이 서명한 「팔아 줘」로 **이 컴퓨터 지갑의 자산**을 장터에 올린다.
//!
//! ## 무엇이 저절로 돌고 무엇이 안 도나
//! - 저절로 도는 것은 **파는 쪽 일**뿐이다: 딱 맞는 묶음 만들기(내 지갑 → 내 새 주소) · 반쪽 제안 서명
//!   (SIGHASH_SINGLE|ANYONECANPAY — 사는 사람이 돈을 붙이기 전에는 아무 일도 안 일어난다) · 장터 글 올리기 · 내리기.
//! - 사는 쪽 일(남에게 돈을 보내는 것)은 여기에 **없다**. 다른 돈 나가기는 지금처럼 사람이 승인한다.
//! - 돌게 하는 조건: 그 연결에 「폰에서 판매 허용」이 켜져 있고(기본 꺼짐, 켤 때 지갑 암호 재인증),
//!   폰 연결 키 서명이 맞고(폰은 보내기 전에 생체 인증), 앱이 잠기지 않았을 때.
//! - 노드 지갑이 암호로 잠겨 있으면 일은 `pending_human` 에서 멈추고 승인 창에 뜬다. 사람이 그 창에서 암호를
//!   넣어야 이어 간다(암호는 저장하지 않는다 — 그 차례에만 쓰고 버린다). 묶음이 새로 필요하면 확인을 기다린 뒤
//!   제안 서명 때 한 번 더 물을 수 있다.
//!
//! ## 거절 순서 (`check_sell`, 시험 `sell_checks_run_in_the_documented_order`)
//! shape → revoked → other-link → signature → future → expired → seen → sell-off → daily-count → asset →
//! owner-token → price → (노드에 물어) not-held. 폰 core `checkLinkSell` 와 같은 순서다(not-held 는 노드라 여기만).
//!
//! ## 일의 차례 (`SellJob.status`, state.json 에 남는다)
//! queued → (묶음이 없으면 만든다) lot → (확인 1개 이상) lot_ready → (반쪽 서명) offered → (글) published → sold
//! · 잠긴 지갑이면 어디서든 pending_human(다시 할 곳은 resume) · 폰의 내리기면 published → cancelling → cancelled
//! · 2시간 안에 올리지 못하면 failed(timeout) · 허용을 끄거나 연결을 끊으면 올리기 전 일은 cancelled.
//! 묶음 만들기는 일마다 따로인 지급 기록(`payout_guard`, 길 `wl-sell-<id>`)을 거친다 — 같은 일이 두 번 보내지 않고,
//! 보냈는지 모르면 그 일만 막힌다(다른 판매는 그대로).
use super::*;

pub(super) const SELL_TTL_MS: i64 = 10 * 60_000;
/// 받아들인 뒤 글을 올리기까지 기다리는 시간(묶음 확인·사람 암호 포함). 요청 만료(10분)와 따로다.
pub(super) const JOB_TTL_MS: i64 = 2 * 3_600_000;
const SOLD_CHECK_MS: i64 = 60_000;
pub(super) const DAILY_MIN: u32 = 1;
pub(super) const DAILY_MAX: u32 = 20;
pub(super) const DAILY_DEFAULT: u32 = 3;
const MIN_PRICE_SATS: u64 = 100_000_000;
/// 폰에 알리는 상태(폰 core LINK_SELL_STATUSES 와 같다).
const REPORTED: [&str; 6] = ["published", "pending_human", "refused", "failed", "cancelled", "sold"];
/// 아직 손이 가는 일(올리기 전 + 내리는 중 + 사람 대기).
const BEFORE_PUBLISH: [&str; 5] = ["queued", "lot", "lot_ready", "offered", "pending_human"];
/// 동전을 붙잡고 있는 일 — 그 동전은 다른 판매가 쓰지 않는다.
const HOLDS_COIN: [&str; 5] = ["lot_ready", "offered", "published", "cancelling", "pending_human"];
const NOT_YOURS: &str = "이미 처리했거나 없는 판매예요.";
const WALLET_LOCKED: &str = "지갑이 잠겨 있어요. 암호를 넣어 주세요.";

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub(crate) struct SellPolicy { pub enabled: bool, pub daily: u32 }
impl Default for SellPolicy { fn default() -> Self { Self { enabled: false, daily: DAILY_DEFAULT } } }

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(default)]
pub(crate) struct SellJob {
    pub link_id: String,
    pub asset: String,
    pub amount: String,
    pub price_sats: u64,
    pub title: String,
    pub summary: String,
    pub category: String,
    pub image: Option<String>,
    pub created: i64,
    pub expires: i64,
    pub received: i64,
    pub updated: i64,
    /// queued · lot · lot_ready · offered · published · cancelling · pending_human · refused · failed · cancelled · sold
    pub status: String,
    pub resume: Option<String>,
    pub reason: Option<String>,
    pub lot_txid: Option<String>,
    pub outpoint: Option<(String, u64)>,
    pub offer_hex: Option<String>,
    pub pay: Option<String>,
    pub event_id: Option<String>,
    pub d: Option<String>,
    /// 폰이 보낸 내리기의 id(결과를 그 id 로도 알린다).
    pub unsell_id: Option<String>,
    /// 이 일의 마지막 판매 결과(같은 「팔아 줘」가 또 오면 그대로 다시 보낸다).
    pub result: Option<Value>,
    pub checked: i64,
}
/// 아직 폰에 못 보낸 판매 결과. 보내면 지운다.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub(crate) struct SellOut { pub link_id: String, pub at: i64, pub value: Value }

// ── 모양(폰 core sellShapeOk·unsellShapeOk 와 같은 규칙) ─────────────────
#[derive(Clone, Debug)]
#[allow(dead_code)] // units 는 시험과 화면 값 확인에서 읽는다
pub(super) struct Sell {
    pub link_id: String, pub id: String, pub asset: String, pub amount: String, pub units: u64, pub price_sats: u64,
    pub title: String, pub summary: String, pub category: String, pub image: Option<String>, pub created: i64, pub expires: i64,
}
#[derive(Clone, Debug)]
pub(super) struct Unsell { pub link_id: String, pub id: String, pub d: String }

fn keys_are(o: &serde_json::Map<String, Value>, need: &[&str], may: &[&str]) -> bool {
    o.keys().all(|k| need.contains(&k.as_str()) || may.contains(&k.as_str())) && need.iter().all(|k| o.contains_key(*k))
}
fn line_ok(s: &str, max: usize, required: bool) -> bool {
    !s.chars().any(char::is_control) && s.chars().count() <= max && s.len() <= 1024 && (!required || !s.trim().is_empty())
}
fn decimal(t: &str, exact8: bool) -> Option<u64> {
    let (w, f) = match t.split_once('.') { Some((w, f)) => (w, Some(f)), None => (t, None) };
    if w.is_empty() || w.len() > 11 || !w.bytes().all(|b| b.is_ascii_digit()) || (w.len() > 1 && w.starts_with('0')) { return None; }
    match f {
        None if exact8 => return None,
        Some(f) if f.is_empty() || f.len() > 8 || (exact8 && f.len() != 8) || !f.bytes().all(|b| b.is_ascii_digit()) => return None,
        _ => {}
    }
    let n = w.parse::<u64>().ok()?.checked_mul(100_000_000)?.checked_add(format!("{:0<8}", f.unwrap_or("")).parse::<u64>().ok()?)?;
    (n <= DAILY_MAX_SATS && (exact8 || n > 0)).then_some(n)
}
/// 수량 글자 → 1e-8 단위(0 은 안 받는다).
pub(super) fn amount_units(a: &str) -> Option<u64> { decimal(a, false) }
/// 값 글자(소수 정확히 8자리) → 사토시.
pub(super) fn price_sats(p: &str) -> Option<u64> { decimal(p, true) }
/// 폰 core linkSellAssetOk 와 같다.
pub(super) fn asset_ok(name: &str) -> bool {
    let b = name.as_bytes();
    if !(3..=64).contains(&b.len()) || !(b[0].is_ascii_uppercase() || b[0].is_ascii_digit() || b[0] == b'$') { return false; }
    let hash = name.find('#');
    b.iter().enumerate().all(|(i, &c)| {
        c.is_ascii_uppercase() || c.is_ascii_digit() || b"._/#~$".contains(&c)
            || (c == b'!' && i == b.len() - 1)
            || (hash.is_some_and(|h| i > h) && (c.is_ascii_lowercase() || b"@%&*()[]{}?:-".contains(&c)))
    })
}
fn image_ok(u: &str) -> bool {
    u.len() <= 1024 && (u.starts_with("https://") || u.starts_with("ipfs://")) && !u.chars().any(|c| c.is_whitespace() || c.is_control() || c == '"' || c == '<' || c == '>')
}
pub(super) fn d_ok(d: &str) -> bool {
    let Some(rest) = d.strip_prefix("rvswap:") else { return false };
    let Some((t, v)) = rest.split_once(':') else { return false };
    hex64(t) && (1..=6).contains(&v.len()) && v.bytes().all(|b| b.is_ascii_digit())
}
fn times_ok(b: &Value) -> Option<(i64, i64)> {
    let (c, e) = (safe_int(b.get("created")?, 1)?, safe_int(b.get("expires")?, 1)?);
    (e > c && e - c <= SELL_TTL_MS).then_some((c, e))
}
pub(super) fn sell_shape(b: &Value) -> Option<Sell> {
    let o = b.as_object()?;
    if !keys_are(o, &["v", "linkId", "id", "asset", "amount", "priceRvn", "title", "summary", "category", "created", "expires"], &["image"]) { return None; }
    let st = |k: &str| o.get(k).and_then(Value::as_str);
    let (link_id, id, asset, amount, price) = (st("linkId")?, st("id")?, st("asset")?, st("amount")?, st("priceRvn")?);
    let (title, summary, category) = (st("title")?, st("summary")?, st("category")?);
    let image = match o.get("image") { None => None, Some(v) => Some(v.as_str().filter(|u| image_ok(u))?.to_string()) };
    let (created, expires) = times_ok(b)?;
    let units = amount_units(amount)?;
    let price_sats = price_sats(price)?;
    (o.get("v")? == 1 && hex64(link_id) && hex64(id) && (1..=64).contains(&asset.len()) && line_ok(title, 100, true) && line_ok(summary, 300, false)
        && crate::market_listing::CATEGORIES.contains(&category))
        .then(|| Sell { link_id: link_id.into(), id: id.into(), asset: asset.into(), amount: amount.into(), units, price_sats,
            title: title.into(), summary: summary.into(), category: category.into(), image, created, expires })
}
pub(super) fn unsell_shape(b: &Value) -> Option<Unsell> {
    let o = b.as_object()?;
    if !keys_are(o, &["v", "linkId", "id", "d", "created", "expires"], &[]) { return None; }
    let st = |k: &str| o.get(k).and_then(Value::as_str);
    let (link_id, id, d) = (st("linkId")?, st("id")?, st("d")?);
    times_ok(b)?;
    (o.get("v")? == 1 && hex64(link_id) && hex64(id) && d_ok(d)).then(|| Unsell { link_id: link_id.into(), id: id.into(), d: d.into() })
}

/// checkLinkSell 과 같은 순서(맨 위 문서). seen = 이미 받은 id. count = 지난 24시간 이 연결에서 받아들인 판매 수.
pub(super) fn check_sell(s: &Value, link: &Link, now: i64, seen: bool, count: u32) -> (Check, Option<Sell>) {
    let Some(x) = s.get("body").and_then(sell_shape) else { return (Check::No("shape"), None) };
    if link.revoked { return (Check::No("revoked"), Some(x)); }
    if x.link_id != link.link_id { return (Check::No("other-link"), Some(x)); }
    if !verify_body("sell", s, &link.phone_key) { return (Check::No("signature"), Some(x)); }
    if x.created > now + 120_000 { return (Check::No("future"), Some(x)); }
    if x.expires < now { return (Check::No("expired"), Some(x)); }
    if seen { return (Check::No("seen"), Some(x)); }
    if !link.sell.enabled { return (Check::No("sell-off"), Some(x)); }
    if count >= link.sell.daily { return (Check::No("daily-count"), Some(x)); }
    if !asset_ok(&x.asset) { return (Check::No("asset"), Some(x)); }
    if x.asset.ends_with('!') { return (Check::No("owner-token"), Some(x)); }
    if x.price_sats < MIN_PRICE_SATS { return (Check::No("price"), Some(x)); }
    (Check::Ok("sell"), Some(x))
}
/// 마지막 거절: 노드에 물어본 쓸 수 있는 수량(다른 판매 글이 붙잡은 것은 뺀 값)이 모자라면 not-held.
pub(super) fn check_held(need: u64, available: u64) -> Check {
    if available < need { Check::No("not-held") } else { Check::Ok("held") }
}
pub(super) fn check_unsell(s: &Value, link: &Link, now: i64, seen: bool) -> (Check, Option<Unsell>) {
    let Some(x) = s.get("body").and_then(unsell_shape) else { return (Check::No("shape"), None) };
    if link.revoked { return (Check::No("revoked"), Some(x)); }
    if x.link_id != link.link_id { return (Check::No("other-link"), Some(x)); }
    if !verify_body("unsell", s, &link.phone_key) { return (Check::No("signature"), Some(x)); }
    let b = &s["body"];
    if b["created"].as_i64().unwrap_or(0) > now + 120_000 { return (Check::No("future"), Some(x)); }
    if b["expires"].as_i64().unwrap_or(0) < now { return (Check::No("expired"), Some(x)); }
    if seen { return (Check::No("seen"), Some(x)); }
    (Check::Ok("unsell"), Some(x))
}

pub(super) fn count_today(s: &State, link_id: &str, now: i64) -> u32 {
    s.sells.values().filter(|j| j.link_id == link_id && j.received > now - DAY_MS && j.status != "refused").count() as u32
}

// ── 결과(데스크탑 → 폰, 꼬리표 sellresult) ─────────────────────────────
fn clip(r: &str) -> Option<String> {
    let t: String = r.chars().filter(|c| !c.is_control()).take(300).collect();
    (!t.trim().is_empty()).then_some(t)
}
pub(super) fn result_body(link_id: &str, id: &str, status: &str, reason: Option<&str>, j: Option<&SellJob>, now: i64) -> Value {
    let mut b = json!({"v": 1, "linkId": link_id, "id": id, "status": status, "at": now});
    if let Some(r) = reason.and_then(clip) { b["reason"] = json!(r); }
    if let Some(j) = j {
        if let Some(e) = j.event_id.as_deref().filter(|e| hex64(e)) { b["eventId"] = json!(e); }
        if let Some(d) = j.d.as_deref().filter(|d| d_ok(d)) {
            b["d"] = json!(d);
            if let Some((t, v)) = j.outpoint.as_ref().filter(|(t, _)| hex64(t)) { b["outpoint"] = json!({"txid": t, "vout": v}); }
        }
    }
    b
}
/// 서명해서 보낼 곳(outbox)에 넣는다. 보낼 값을 돌려준다.
fn emit(s: &mut State, sk: &[u8; 32], link_id: &str, id: &str, status: &str, reason: Option<&str>, j: Option<&SellJob>, now: i64) -> Result<Value, String> {
    let v = sign_body("sellresult", result_body(link_id, id, status, reason, j, now), sk)?;
    let key = v["sig"].as_str().unwrap_or_default().to_string();
    s.sell_outbox.insert(key, SellOut { link_id: link_id.into(), at: now, value: v.clone() });
    Ok(v)
}
/// 일의 상태를 바꾸고, 폰에 알릴 상태면 결과를 서명해 둔다.
fn set_status(s: &mut State, sk: &[u8; 32], id: &str, status: &str, reason: Option<&str>, now: i64) -> Result<(), String> {
    let Some(j) = s.sells.get_mut(id) else { return Ok(()) };
    j.status = status.into();
    j.reason = reason.map(str::to_string);
    j.updated = now;
    if status != "pending_human" { j.resume = None; }
    let snap = j.clone();
    if REPORTED.contains(&status) {
        let v = emit(s, sk, &snap.link_id, id, status, reason, Some(&snap), now)?;
        if let Some(j) = s.sells.get_mut(id) { j.result = Some(v); }
        if let (Some(uid), "cancelled" | "sold") = (snap.unsell_id.as_deref(), status) { emit(s, sk, &snap.link_id, uid, status, reason, Some(&snap), now)?; }
    }
    Ok(())
}
fn job_of(x: &Sell, now: i64, status: &str) -> SellJob {
    SellJob { link_id: x.link_id.clone(), asset: x.asset.clone(), amount: x.amount.clone(), price_sats: x.price_sats, title: x.title.clone(),
        summary: x.summary.clone(), category: x.category.clone(), image: x.image.clone(), created: x.created, expires: x.expires,
        received: now, updated: now, status: status.into(), ..Default::default() }
}

// ── 받은 쪽지(process 안에서, 동기) ──────────────────────────────────
pub(super) fn on_sell(s: &mut State, sk: &[u8; 32], msg: &Value, from: &str, now: i64, out: &mut Vec<(String, &'static str, Value)>) -> Result<(), String> {
    let Some(lid) = msg.pointer("/body/linkId").and_then(Value::as_str) else { return Ok(()) };
    let Some(link) = s.links.iter().find(|l| l.link_id == lid && l.phone_key == from).cloned() else { return Ok(()) };
    let sid = msg.pointer("/body/id").and_then(Value::as_str).unwrap_or("").to_string();
    // 같은 「팔아 줘」가 다시 왔다: 다시 하지 않고 마지막 결과만 다시 보낸다.
    if let Some(j) = s.sells.get(&sid) {
        if let Some(r) = &j.result { out.push((link.phone_key.clone(), "sellresult", r.clone())); }
        return Ok(());
    }
    let seen = s.seen.contains_key(&sid) || s.requests.contains_key(&sid);
    let count = count_today(s, &link.link_id, now);
    match check_sell(msg, &link, now, seen, count) {
        (Check::Ok(_), Some(x)) => {
            s.seen.insert(x.id.clone(), now);
            s.sells.insert(x.id.clone(), job_of(&x, now, "queued"));
        }
        (Check::No(why @ ("expired" | "future" | "sell-off" | "daily-count" | "asset" | "owner-token" | "price")), Some(x)) => {
            s.seen.insert(x.id.clone(), now);
            s.sells.insert(x.id.clone(), job_of(&x, now, "refused"));
            set_status(s, sk, &x.id, "refused", Some(why), now)?;
        }
        _ => {}
    }
    Ok(())
}
pub(super) fn on_unsell(s: &mut State, sk: &[u8; 32], msg: &Value, from: &str, now: i64) -> Result<(), String> {
    let Some(lid) = msg.pointer("/body/linkId").and_then(Value::as_str) else { return Ok(()) };
    let Some(link) = s.links.iter().find(|l| l.link_id == lid && l.phone_key == from).cloned() else { return Ok(()) };
    let uid = msg.pointer("/body/id").and_then(Value::as_str).unwrap_or("").to_string();
    let seen = s.seen.contains_key(&uid) || s.sells.contains_key(&uid) || s.requests.contains_key(&uid);
    match check_unsell(msg, &link, now, seen) {
        (Check::Ok(_), Some(u)) => {
            s.seen.insert(u.id.clone(), now);
            let hit = s.sells.iter().find(|(_, j)| j.link_id == link.link_id && j.d.as_deref() == Some(u.d.as_str())).map(|(k, j)| (k.clone(), j.clone()));
            match hit {
                None => { emit(s, sk, &link.link_id, &u.id, "refused", Some("unknown-listing"), None, now)?; }
                Some((jid, j)) => match j.status.as_str() {
                    "published" => { if let Some(x) = s.sells.get_mut(&jid) { x.status = "cancelling".into(); x.unsell_id = Some(u.id.clone()); x.updated = now; } }
                    "cancelling" | "pending_human" => { if let Some(x) = s.sells.get_mut(&jid) { x.unsell_id = Some(u.id.clone()); } }
                    st @ ("cancelled" | "sold") => { emit(s, sk, &link.link_id, &u.id, st, None, Some(&j), now)?; }
                    _ => { emit(s, sk, &link.link_id, &u.id, "refused", Some("not-published"), Some(&j), now)?; }
                },
            }
        }
        (Check::No(why @ ("expired" | "future")), Some(u)) => {
            s.seen.insert(u.id.clone(), now);
            emit(s, sk, &link.link_id, &u.id, "refused", Some(why), None, now)?;
        }
        _ => {}
    }
    Ok(())
}
/// 연결을 끊거나 판매 허용을 끄면: 허용을 끄고, 올리기 전 일은 멈춘다(올라간 글은 그대로 — 화면이 내리기를 권한다).
pub(super) fn stop_link(s: &mut State, sk: Option<&[u8; 32]>, link_id: &str, why: &str, now: i64) -> Result<(), String> {
    if let Some(l) = s.links.iter_mut().find(|l| l.link_id == link_id) { l.sell.enabled = false; }
    let ids: Vec<String> = s.sells.iter().filter(|(_, j)| j.link_id == link_id && BEFORE_PUBLISH.contains(&j.status.as_str())
        && j.resume.as_deref() != Some("cancelling")).map(|(k, _)| k.clone()).collect();
    for id in ids {
        match sk {
            Some(sk) => set_status(s, sk, &id, "cancelled", Some(why), now)?,
            None => if let Some(j) = s.sells.get_mut(&id) { j.status = "cancelled".into(); j.reason = Some(why.into()); j.resume = None; j.updated = now; },
        }
    }
    Ok(())
}
/// 아직 못 보낸 판매 결과(끊긴 연결 몫은 보내지 않는다).
pub(super) fn outbox(s: &State) -> Vec<(String, &'static str, Value)> {
    s.sell_outbox.values().filter_map(|o| s.links.iter().find(|l| l.link_id == o.link_id && !l.revoked).map(|l| (l.phone_key.clone(), "sellresult", o.value.clone()))).collect()
}
pub(super) fn prune(s: &mut State, now: i64) {
    s.sell_outbox.retain(|_, o| o.at > now - WRAP_RETAIN_MS);
    s.sells.retain(|_, j| !matches!(j.status.as_str(), "refused" | "failed" | "cancelled" | "sold") || j.updated > now - 30 * DAY_MS);
}
pub(super) fn has_work(s: &State) -> bool {
    s.sells.values().any(|j| !matches!(j.status.as_str(), "refused" | "failed" | "cancelled" | "sold"))
}
pub(super) fn policy_view(s: &State, l: &Link, now: i64) -> Value {
    json!({ "enabled": l.sell.enabled, "daily": l.sell.daily, "today": count_today(s, &l.link_id, now) })
}
pub(super) fn jobs_view(s: &State) -> Vec<Value> {
    let name = |id: &str| s.links.iter().find(|l| l.link_id == id).map(|l| l.name.clone()).unwrap_or_default();
    let mut v: Vec<(&String, &SellJob)> = s.sells.iter().collect();
    v.sort_by_key(|(_, j)| -j.received);
    v.into_iter().take(60).map(|(id, j)| json!({
        "id": id, "linkId": j.link_id, "phoneName": name(&j.link_id), "status": j.status, "resume": j.resume, "reason": j.reason,
        "asset": j.asset, "amount": j.amount, "priceSats": j.price_sats.to_string(), "title": j.title, "category": j.category,
        "d": j.d, "eventId": j.event_id, "outpoint": j.outpoint.as_ref().map(|(t, v)| json!({"txid": t, "vout": v})),
        "received": j.received, "updated": j.updated })).collect()
}

// ── 노드·장터 일(시험에서는 가짜) ──────────────────────────────────────
pub(crate) enum LotErr { NotSent(String), Unknown(String) }
pub(crate) trait SellOps {
    /// 노드 지갑이 암호로 잠겨 있나(암호화 안 됐거나 잠깐 열려 있으면 false).
    async fn wallet_locked(&self) -> Result<bool, String>;
    /// 그 자산을 몇 개 가졌나(1e-8 단위).
    async fn held(&self, asset: &str) -> Result<u64, String>;
    /// 그 수량과 딱 맞는 내 묶음들 (txid, vout, 확인 수). 이미 쓰인 동전은 빠진다.
    async fn exact_lots(&self, asset: &str, amount: f64) -> Result<Vec<(String, u64, i64)>, String>;
    /// 딱 맞는 묶음을 새로 만든다(내 지갑 → 내 새 주소). keep = 다른 판매 글이 쓰는 동전(건드리지 않게).
    async fn make_lot(&self, asset: &str, amount: f64, pass: Option<String>, keep: &[(String, u64)]) -> Result<String, LotErr>;
    /// 고른 동전으로 반쪽 제안(파는 쪽 서명만). {hex, pay_to, txid, vout}
    async fn offer(&self, asset: &str, amount: f64, price: f64, at: (String, u64), pass: Option<String>) -> Result<Value, String>;
    /// 장터 글 올리기. {eventId, d}
    async fn publish(&self, hex: &str, title: &str, summary: &str, category: &str, image: Option<String>) -> Result<Value, String>;
    /// 내리기(동전을 내 새 주소로 옮기고 취소 글).
    async fn cancel(&self, d: &str, pass: Option<String>) -> Result<Value, String>;
    /// 글의 지금 상태: Some("sold"|"cancelled"|"active") · None = 아직 모름. 동전이 그대로면 묻지도 않는다.
    async fn listing_state(&self, d: &str, at: &(String, u64)) -> Result<Option<String>, String>;
}
pub(crate) struct ProdOps;
impl SellOps for ProdOps {
    async fn wallet_locked(&self) -> Result<bool, String> {
        let i = crate::raven::call_rpc("getwalletinfo", json!([])).await?;
        Ok(i.get("unlocked_until").and_then(Value::as_i64) == Some(0))
    }
    async fn held(&self, asset: &str) -> Result<u64, String> {
        let v = crate::raven::call_rpc("listmyassets", json!([asset, false])).await?;
        Ok(v.get(asset).and_then(Value::as_f64).and_then(to_sats).unwrap_or(0))
    }
    async fn exact_lots(&self, asset: &str, amount: f64) -> Result<Vec<(String, u64, i64)>, String> {
        let mut out = Vec::new();
        for o in crate::swap::exact_outpoints(asset, amount).await?.into_iter().take(20) {
            let (Some(t), Some(v)) = (o["txid"].as_str().filter(|t| hex64(t)), o["vout"].as_u64()) else { continue };
            let u = crate::raven::call_rpc("gettxout", json!([t, v, true])).await?;
            if u.is_null() { continue; }
            out.push((t.to_string(), v, u["confirmations"].as_i64().unwrap_or(0)));
        }
        Ok(out)
    }
    async fn make_lot(&self, asset: &str, amount: f64, pass: Option<String>, keep: &[(String, u64)]) -> Result<String, LotErr> {
        // 여는 것(암호)이 틀리면 아무것도 안 나갔다. 그다음 보내기의 오류는 「모름」으로 친다(그 일만 막는다).
        let was = crate::swap::unlock_for(pass).await.map_err(LotErr::NotSent)?;
        let r = crate::swap::make_lot_keeping(asset, amount, None, keep).await;
        crate::swap::relock_for(was).await;
        let v = r.map_err(LotErr::Unknown)?;
        Ok(v["txid"].as_str().unwrap_or_default().to_string())
    }
    async fn offer(&self, asset: &str, amount: f64, price: f64, at: (String, u64), pass: Option<String>) -> Result<Value, String> {
        crate::swap::swap_offer_at(asset.into(), amount, price, at, pass).await
    }
    async fn publish(&self, hex: &str, title: &str, summary: &str, category: &str, image: Option<String>) -> Result<Value, String> {
        crate::market_listing::market_publish_listing(hex.into(), title.into(), summary.into(), category.into(), image).await
    }
    async fn cancel(&self, d: &str, pass: Option<String>) -> Result<Value, String> {
        crate::market_listing::market_cancel_listing(d.into(), pass).await
    }
    async fn listing_state(&self, d: &str, at: &(String, u64)) -> Result<Option<String>, String> {
        let u = crate::raven::call_rpc("gettxout", json!([at.0, at.1, true])).await?;
        if !u.is_null() { return Ok(Some("active".into())); }
        crate::market_listing::settle_d(d).await
    }
}

// ── 일 돌리기 ──────────────────────────────────────────────────────
fn lane(id: &str) -> String { format!("wl-sell-{id}") }
fn holds(s: &State, except: &str) -> Vec<(String, u64)> {
    s.sells.iter().filter(|(k, j)| k.as_str() != except && HOLDS_COIN.contains(&j.status.as_str())).filter_map(|(_, j)| j.outpoint.clone()).collect()
}
fn held_by_others(s: &State, asset: &str, except: &str) -> u64 {
    s.sells.iter().filter(|(k, j)| k.as_str() != except && j.asset == asset && HOLDS_COIN.contains(&j.status.as_str()) && j.outpoint.is_some())
        .fold(0u64, |a, (_, j)| a.saturating_add(amount_units(&j.amount).unwrap_or(0)))
}
fn update(dir: &Path, id: &str, f: impl FnOnce(&mut SellJob)) -> Result<(), String> {
    let mut s = load(dir)?;
    if let Some(j) = s.sells.get_mut(id) { f(j); }
    save(dir, &s)
}
fn finish(dir: &Path, sk: &[u8; 32], id: &str, status: &str, reason: Option<&str>, now: i64, f: impl FnOnce(&mut SellJob)) -> Result<(), String> {
    let mut s = load(dir)?;
    if let Some(j) = s.sells.get_mut(id) { f(j); }
    set_status(&mut s, sk, id, status, reason, now)?;
    save(dir, &s)
}
fn to_human(dir: &Path, sk: &[u8; 32], id: &str, resume: &str, now: i64) -> Result<(), String> {
    finish(dir, sk, id, "pending_human", None, now, |j| j.resume = Some(resume.into()))
}
fn short(e: &str) -> String { e.chars().filter(|c| !c.is_control()).take(200).collect() }

/// 일 하나를 한 걸음. Ok(true) = 바로 다음 걸음을 해도 된다. pass 가 있으면 사람이 승인 창에서 넣은 암호(이 차례에만).
/// 🔴 서명·보내기 직전마다 앱 잠금 차례 번호를 다시 본다.
pub(super) async fn step(ops: &impl SellOps, dir: &Path, sk: &[u8; 32], id: &str, now: i64, pass: Option<&Text>, epoch: u64) -> Result<bool, String> {
    let s = load(dir)?;
    let Some(j) = s.sells.get(id).cloned() else { return Ok(false) };
    let units = amount_units(&j.amount).unwrap_or(0);
    let (amount, price) = (units as f64 / 1e8, j.price_sats as f64 / 1e8);
    let keep = holds(&s, id);
    let pw = || pass.map(|p| p.0.clone());
    let need_human = |resume: &'static str| async move {
        if pass.is_none() && ops.wallet_locked().await? { to_human(dir, sk, id, resume, now)?; return Ok::<bool, String>(true); }
        Ok(false)
    };
    match j.status.as_str() {
        "queued" => {
            let held = ops.held(&j.asset).await?;
            if let Check::No(why) = check_held(units, held.saturating_sub(held_by_others(&s, &j.asset, id))) {
                finish(dir, sk, id, "refused", Some(why), now, |_| {})?;
                return Ok(false);
            }
            let lots: Vec<_> = ops.exact_lots(&j.asset, amount).await?.into_iter().filter(|(t, v, _)| !keep.iter().any(|(a, b)| a == t && b == v)).collect();
            if let Some((t, v, _)) = lots.iter().find(|x| x.2 >= 1) {
                let at = (t.clone(), *v);
                update(dir, id, |j| { j.status = "lot_ready".into(); j.outpoint = Some(at); j.updated = now; })?;
                return Ok(true);
            }
            if !lots.is_empty() { update(dir, id, |j| { j.status = "lot".into(); j.updated = now; })?; return Ok(false); }
            if need_human("queued").await? { return Ok(false); }
            if !crate::app_lock::still_unlocked(epoch) { return Ok(false); }
            let intent = format!("sell-lot|{}|{}|{}", j.link_id, j.asset, j.amount).into_bytes();
            match crate::payout_guard::begin(&payouts(dir), &lane(id), "lot", &intent) {
                Err(e) => { finish(dir, sk, id, "failed", Some(&short(&e)), now, |_| {})?; Ok(false) }
                Ok(crate::payout_guard::Begin::Done(txid)) => { update(dir, id, |j| { j.status = "lot".into(); j.lot_txid = Some(txid); j.updated = now; })?; Ok(false) }
                Ok(crate::payout_guard::Begin::New(g)) => match ops.make_lot(&j.asset, amount, pw(), &keep).await {
                    Ok(txid) => {
                        // txid 를 못 읽었으면 기록을 잠근 채 둔다(다시 보내지 않는다) — 묶음이 보이면 그대로 이어 간다.
                        if hex64(&txid) { g.complete(&txid)?; crate::refund::remember_ours(&txid); } else { drop(g); }
                        update(dir, id, |j| { j.status = "lot".into(); j.lot_txid = hex64(&txid).then_some(txid); j.updated = now; })?;
                        Ok(false)
                    }
                    Err(LotErr::NotSent(e)) => { g.abandon_unsent()?; if pass.is_some() { Err(e) } else { update(dir, id, |j| j.reason = Some(short(&e)))?; Ok(false) } }
                    Err(LotErr::Unknown(e)) => {
                        drop(g);
                        finish(dir, sk, id, "failed", Some(&format!("묶음을 만들었는지 확인하지 못했어요. 다시 보내지 않았어요. ({})", short(&e))), now, |_| {})?;
                        Ok(false)
                    }
                },
            }
        }
        "lot" => {
            let lots = ops.exact_lots(&j.asset, amount).await?;
            match lots.into_iter().find(|(t, v, c)| *c >= 1 && !keep.iter().any(|(a, b)| a == t && b == v)) {
                Some((t, v, _)) => { update(dir, id, |j| { j.status = "lot_ready".into(); j.outpoint = Some((t, v)); j.updated = now; })?; Ok(true) }
                None => Ok(false),
            }
        }
        "lot_ready" => {
            let Some(at) = j.outpoint.clone() else { update(dir, id, |j| j.status = "queued".into())?; return Ok(false) };
            if need_human("lot_ready").await? { return Ok(false); }
            if !crate::app_lock::still_unlocked(epoch) { return Ok(false); }
            match ops.offer(&j.asset, amount, price, at.clone(), pw()).await {
                Ok(v) => {
                    let (hex, pay) = (v["hex"].as_str().unwrap_or_default().to_string(), v["pay_to"].as_str().unwrap_or_default().to_string());
                    let same_coin = v["txid"].as_str() == Some(at.0.as_str()) && v["vout"].as_u64() == Some(at.1);
                    if hex.is_empty() || pay.is_empty() || !same_coin { update(dir, id, |j| j.reason = Some("제안을 만들지 못했어요.".into()))?; return Ok(false); }
                    update(dir, id, |j| { j.status = "offered".into(); j.offer_hex = Some(hex); j.pay = Some(pay); j.reason = None; j.updated = now; })?;
                    Ok(true)
                }
                Err(e) => { if pass.is_some() { return Err(e); } update(dir, id, |j| j.reason = Some(short(&e)))?; Ok(false) }
            }
        }
        "offered" => {
            if !crate::app_lock::still_unlocked(epoch) { return Ok(false); }
            let hex = j.offer_hex.clone().unwrap_or_default();
            match ops.publish(&hex, &j.title, &j.summary, &j.category, j.image.clone()).await {
                Ok(v) => {
                    let (ev, d) = (v["eventId"].as_str().map(str::to_string), v["d"].as_str().map(str::to_string));
                    finish(dir, sk, id, "published", None, now, |j| { j.event_id = ev; j.d = d; j.checked = now; })?;
                    Ok(false)
                }
                Err(e) => { update(dir, id, |j| j.reason = Some(short(&e)))?; Ok(false) }
            }
        }
        "published" => {
            let (Some(d), Some(at)) = (j.d.clone(), j.outpoint.clone()) else { return Ok(false) };
            if now - j.checked < SOLD_CHECK_MS { return Ok(false); }
            update(dir, id, |j| j.checked = now)?;
            match ops.listing_state(&d, &at).await {
                Ok(Some(st)) if st == "sold" => finish(dir, sk, id, "sold", None, now, |_| {})?,
                Ok(Some(st)) if st == "cancelled" => finish(dir, sk, id, "cancelled", None, now, |_| {})?,
                _ => {}
            }
            Ok(false)
        }
        "cancelling" => {
            let Some(d) = j.d.clone() else { return Ok(false) };
            if need_human("cancelling").await? { return Ok(false); }
            if !crate::app_lock::still_unlocked(epoch) { return Ok(false); }
            match ops.cancel(&d, pw()).await {
                Ok(_) => { finish(dir, sk, id, "cancelled", None, now, |_| {})?; Ok(false) }
                Err(e) => { if pass.is_some() { return Err(e); } update(dir, id, |j| j.reason = Some(short(&e)))?; Ok(false) }
            }
        }
        _ => Ok(false),
    }
}
/// 시간 초과·끊긴 연결·꺼진 허용을 정리한다.
fn housekeeping(s: &mut State, sk: &[u8; 32], now: i64) -> Result<(), String> {
    let ids: Vec<String> = s.sells.keys().cloned().collect();
    for id in ids {
        let j = s.sells[&id].clone();
        let link = s.links.iter().find(|l| l.link_id == j.link_id).cloned();
        let cancelling = j.status == "cancelling" || j.resume.as_deref() == Some("cancelling");
        if cancelling {
            if j.status == "pending_human" && now > j.updated + JOB_TTL_MS {
                // 사람이 2시간 동안 암호를 넣지 않았다: 글은 그대로 판매 중으로 두고 그 내리기만 실패로 알린다.
                if let Some(x) = s.sells.get_mut(&id) { x.status = "published".into(); x.resume = None; x.updated = now; }
                if let Some(uid) = j.unsell_id.as_deref() { emit(s, sk, &j.link_id, uid, "failed", Some("timeout"), Some(&j), now)?; }
            }
            continue;
        }
        if !BEFORE_PUBLISH.contains(&j.status.as_str()) { continue; }
        match link {
            None => set_status(s, sk, &id, "cancelled", Some("revoked"), now)?,
            Some(l) if l.revoked => set_status(s, sk, &id, "cancelled", Some("revoked"), now)?,
            Some(l) if !l.sell.enabled => set_status(s, sk, &id, "cancelled", Some("sell-off"), now)?,
            _ if now > j.received + JOB_TTL_MS => set_status(s, sk, &id, "failed", Some("timeout"), now)?,
            _ => {}
        }
    }
    Ok(())
}
/// 받은 쪽지를 처리한 뒤 부른다(앱이 안 잠겼을 때만). 일마다 몇 걸음씩.
pub(super) async fn tick(ops: &impl SellOps, dir: &Path, sk: &[u8; 32], now: i64) -> Result<(), String> {
    let Some(epoch) = crate::app_lock::unlocked_epoch() else { return Ok(()) };
    let mut s = load(dir)?;
    housekeeping(&mut s, sk, now)?;
    save(dir, &s)?;
    let ids: Vec<String> = s.sells.iter().filter(|(_, j)| matches!(j.status.as_str(), "queued" | "lot" | "lot_ready" | "offered" | "published" | "cancelling")).map(|(k, _)| k.clone()).collect();
    for id in ids {
        for _ in 0..4 {
            match step(ops, dir, sk, &id, now, None, epoch).await { Ok(true) => continue, _ => break }
        }
    }
    Ok(())
}
/// 승인 창에서 사람이 암호를 넣고 「이어서 하기」를 눌렀을 때. 틀리면 다시 사람 대기로 둔다.
pub(super) async fn continue_with(ops: &impl SellOps, dir: &Path, sk: &[u8; 32], id: &str, pass: &Text, now: i64) -> Result<(), String> {
    let epoch = crate::app_lock::unlocked_epoch().ok_or(APP_LOCKED)?;
    let mut s = load(dir)?;
    let j = s.sells.get(id).filter(|j| j.status == "pending_human").cloned().ok_or(NOT_YOURS)?;
    let resume = j.resume.clone().unwrap_or_else(|| "queued".into());
    if resume != "cancelling" {
        let l = s.links.iter().find(|l| l.link_id == j.link_id && !l.revoked).ok_or("연결이 끊긴 폰의 판매예요.")?;
        if !l.sell.enabled { return Err("「폰에서 판매 허용」이 꺼져 있어요.".into()); }
    }
    if let Some(x) = s.sells.get_mut(id) { x.status = resume.clone(); }
    save(dir, &s)?;
    for _ in 0..4 {
        match step(ops, dir, sk, id, now, Some(pass), epoch).await {
            Ok(true) => continue,
            Ok(false) => break,
            Err(e) => {
                update(dir, id, |x| if x.status == resume { x.status = "pending_human".into(); })?;
                return Err(e);
            }
        }
    }
    Ok(())
}
/// 사람이 거절. 내리기를 거절하면 글은 판매 중으로 남는다.
pub(super) fn refuse_in(dir: &Path, sk: &[u8; 32], id: &str, now: i64) -> Result<(), String> {
    let mut s = load(dir)?;
    let j = s.sells.get(id).filter(|j| BEFORE_PUBLISH.contains(&j.status.as_str())).cloned().ok_or(NOT_YOURS)?;
    if j.resume.as_deref() == Some("cancelling") {
        if let Some(x) = s.sells.get_mut(id) { x.status = "published".into(); x.resume = None; x.updated = now; }
        if let Some(uid) = j.unsell_id.as_deref() { emit(&mut s, sk, &j.link_id, uid, "refused", Some("refused"), Some(&j), now)?; }
    } else {
        set_status(&mut s, sk, id, "refused", Some("refused"), now)?;
    }
    save(dir, &s)
}
/// 이 컴퓨터에서 「내리기」(끊긴 연결의 글도). 잠긴 지갑이면 암호가 있어야 한다.
pub(super) async fn cancel_with(ops: &impl SellOps, dir: &Path, sk: &[u8; 32], id: &str, pass: Option<&Text>, now: i64) -> Result<(), String> {
    let epoch = crate::app_lock::unlocked_epoch().ok_or(APP_LOCKED)?;
    let s = load(dir)?;
    let j = s.sells.get(id).filter(|j| matches!(j.status.as_str(), "published" | "cancelling") || j.resume.as_deref() == Some("cancelling")).cloned().ok_or(NOT_YOURS)?;
    let d = j.d.clone().ok_or(NOT_YOURS)?;
    if pass.is_none() && ops.wallet_locked().await? { return Err(WALLET_LOCKED.into()); }
    if !crate::app_lock::still_unlocked(epoch) { return Err(APP_LOCKED.into()); }
    ops.cancel(&d, pass.map(|p| p.0.clone())).await?;
    finish(dir, sk, id, "cancelled", None, now, |_| {})
}
/// 「폰에서 판매 허용」·하루 건수. 끄면 올리기 전 일은 멈춘다.
pub(super) fn set_sell_in(dir: &Path, sk: &[u8; 32], link_id: &str, enabled: bool, daily: u32, now: i64) -> Result<(), String> {
    if !(DAILY_MIN..=DAILY_MAX).contains(&daily) { return Err(format!("하루 최대 건수는 {DAILY_MIN}~{DAILY_MAX} 사이로 골라 주세요.")); }
    let mut s = load(dir)?;
    let l = s.links.iter_mut().find(|l| l.link_id == link_id && !l.revoked).ok_or("이미 끊었거나 없는 연결이에요.")?;
    l.sell = SellPolicy { enabled, daily };
    if !enabled { stop_link(&mut s, Some(sk), link_id, "sell-off", now)?; }
    save(dir, &s)
}
/// 장터 화면이 「팔렸음」을 확인했을 때: 그 글이 폰 판매에서 왔으면 폰에 알릴 결과를 남긴다(다음 확인 때 간다).
pub(super) fn mark_sold_in(dir: &Path, sk: &[u8; 32], d: &str, now: i64) -> Result<bool, String> {
    let mut s = load(dir)?;
    let Some(id) = s.sells.iter().find(|(_, j)| j.d.as_deref() == Some(d) && j.status == "published").map(|(k, _)| k.clone()) else { return Ok(false) };
    set_status(&mut s, sk, &id, "sold", None, now)?;
    save(dir, &s)?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    fn vectors() -> Value { serde_json::from_str(include_str!("../../../scripts/fixtures/wallet-link-vectors.json")).unwrap() }
    fn key(v: &Value, k: &str) -> [u8; 32] { hex::decode(v[k].as_str().unwrap()).unwrap().try_into().unwrap() }
    fn tmp(name: &str) -> PathBuf {
        static N: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let d = std::env::temp_dir().join(format!("rv-wl-sell-{name}-{}-{}-{}", std::process::id(), now_ms(), N.fetch_add(1, std::sync::atomic::Ordering::SeqCst)));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }
    fn link_of(v: &Value, enabled: bool) -> Link {
        Link { link_id: v["linkId"].as_str().unwrap().into(), phone_key: v["phoneKey"].as_str().unwrap().into(), phone_addresses: vec![v["phoneAddress"].as_str().unwrap().into()],
            name: "폰".into(), daily_sats: DAILY_DEFAULT_SATS, created: v["now"].as_i64().unwrap(), revoked: false, revoked_at: None, revoke_out: None,
            sell: SellPolicy { enabled, daily: 3 }, phone_talk_pub: None, talk_out: None }
    }
    fn linked(v: &Value, name: &str, enabled: bool) -> PathBuf {
        let d = tmp(name);
        save(&d, &State { links: vec![link_of(v, enabled)], ..Default::default() }).unwrap();
        d
    }
    fn gift(v: &Value, t: &str, n: usize) -> Value { v["gifts"].as_array().unwrap().iter().filter(|g| g["t"] == t).nth(n).unwrap()["event"].clone() }
    fn phone_sign(v: &Value, tag: &str, body: Value) -> Value { sign_body(tag, body, &key(v, "phoneSecret")).unwrap() }
    fn sell_body(v: &Value, id: &str) -> Value {
        let mut b = v["sell"]["body"].clone();
        b["id"] = json!(id);
        b
    }
    fn results(s: &State) -> Vec<Value> { s.sell_outbox.values().map(|o| o.value["body"].clone()).collect() }

    #[test]
    fn sell_vectors_verify_and_digests_match_the_phone() {
        let v = vectors();
        for d in v["digests"].as_array().unwrap() {
            assert_eq!(hex::encode(digest(d["tag"].as_str().unwrap(), &d["body"]).unwrap()), d["hex"].as_str().unwrap(), "{}", d["tag"]);
        }
        let (phone, desk) = (v["phoneKey"].as_str().unwrap(), v["deskKey"].as_str().unwrap());
        assert!(verify_body("sell", &v["sell"], phone) && verify_body("sell", &v["sellPlain"], phone));
        assert!(verify_body("unsell", &v["unsell"], phone));
        assert!(!verify_body("request", &v["sell"], phone), "tag separates sell from request");
        assert!(verify_body("sellresult", &v["sellResult"], desk) && verify_body("sellresult", &v["sellRefused"], desk));
        assert!(!verify_body("result", &v["sellResult"], desk));
        let x = sell_shape(&v["sell"]["body"]).unwrap();
        assert_eq!((x.units, x.price_sats, x.image.as_deref()), (100_000_000, 2_500_000_000, Some("https://example.com/a.png")));
        let p = sell_shape(&v["sellPlain"]["body"]).unwrap();
        assert_eq!((p.units, p.price_sats, p.image), (50_000_000, 100_000_000, None));
        assert!(unsell_shape(&v["unsell"]["body"]).is_some());
        // 같은 몸통을 여기서 서명해도 같은 다이제스트(폰 verifyLinkSellResult 가 받는다).
        let body = &v["sellResult"]["body"];
        let me = sign_body("sellresult", result_body(body["linkId"].as_str().unwrap(), body["id"].as_str().unwrap(), "published", None,
            Some(&SellJob { event_id: Some("dd".repeat(32)), d: body["d"].as_str().map(str::to_string), outpoint: Some(("cc".repeat(32), 1)), ..Default::default() }),
            body["at"].as_i64().unwrap()), &key(&v, "deskSecret")).unwrap();
        assert_eq!(me["body"], *body, "Rust result body is byte-identical to the TS one");
        assert!(verify_body("sellresult", &me, desk));
        let refused = result_body(v["linkId"].as_str().unwrap(), &"55".repeat(32), "refused", Some("sell-off"), None, body["at"].as_i64().unwrap());
        assert_eq!(refused, v["sellRefused"]["body"]);
    }

    #[test]
    fn sell_checks_run_in_the_documented_order() {
        let v = vectors();
        let now = v["now"].as_i64().unwrap() + 1000;
        let on = link_of(&v, true);
        let s = &v["sell"];
        assert_eq!(check_sell(s, &on, now, false, 0).0, Check::Ok("sell"));
        let mut extra = s.clone();
        extra["body"]["x"] = json!(1);
        assert_eq!(check_sell(&extra, &on, now, false, 0).0, Check::No("shape"));
        // 여러 가지가 동시에 틀려도 앞의 것이 이긴다.
        assert_eq!(check_sell(s, &Link { revoked: true, sell: SellPolicy::default(), ..on.clone() }, now + 3_600_000, true, 99).0, Check::No("revoked"));
        assert_eq!(check_sell(s, &Link { link_id: "ee".repeat(32), ..on.clone() }, now, false, 0).0, Check::No("other-link"));
        let mut forged = s.clone();
        forged["body"]["priceRvn"] = json!("99999.00000000");
        assert_eq!(check_sell(&forged, &on, now + 3_600_000, true, 99).0, Check::No("signature"), "signature before time/seen/policy");
        assert_eq!(check_sell(s, &on, now - 300_000, true, 99).0, Check::No("future"));
        assert_eq!(check_sell(s, &on, now + 700_000, true, 99).0, Check::No("expired"));
        assert_eq!(check_sell(s, &link_of(&v, false), now, true, 99).0, Check::No("seen"), "seen before sell-off");
        assert_eq!(check_sell(s, &link_of(&v, false), now, false, 99).0, Check::No("sell-off"));
        assert_eq!(check_sell(s, &on, now, false, 3).0, Check::No("daily-count"));
        let signed = |over: Value| { let mut b = sell_body(&v, &"66".repeat(32)); for (k, x) in over.as_object().unwrap() { b[k.as_str()] = x.clone(); } phone_sign(&v, "sell", b) };
        assert_eq!(check_sell(&signed(json!({"asset": "bad name", "priceRvn": "0.50000000"})), &on, now, false, 0).0, Check::No("asset"));
        assert_eq!(check_sell(&signed(json!({"asset": "PLAYX!", "priceRvn": "0.50000000"})), &on, now, false, 0).0, Check::No("owner-token"));
        assert_eq!(check_sell(&signed(json!({"priceRvn": "0.99999999"})), &on, now, false, 0).0, Check::No("price"));
        assert_eq!(check_sell(&signed(json!({"priceRvn": "1.00000000"})), &on, now, false, 0).0, Check::Ok("sell"));
        assert_eq!(check_sell(&signed(json!({"priceRvn": "25"})), &on, now, false, 0).0, Check::No("shape"), "8 decimals");
        assert_eq!(check_sell(&signed(json!({"amount": "0"})), &on, now, false, 0).0, Check::No("shape"));
        assert_eq!(check_sell(&signed(json!({"category": "car"})), &on, now, false, 0).0, Check::No("shape"));
        assert_eq!(check_sell(&signed(json!({"image": "javascript:x"})), &on, now, false, 0).0, Check::No("shape"));
        assert_eq!(check_sell(&signed(json!({"expires": v["now"].as_i64().unwrap() + 3_600_000})), &on, now, false, 0).0, Check::No("shape"));
        assert_eq!(check_held(100_000_000, 99_999_999), Check::No("not-held"));
        assert_eq!(check_held(100_000_000, 100_000_000), Check::Ok("held"));
        for (n, ok) in [("ART#Tag_1", true), ("$RESTRICT", true), ("PLAYX/ALBUM1", true), ("ab", false), ("A!B", false), ("lower", false), ("ABC!", true)] { assert_eq!(asset_ok(n), ok, "{n}"); }
        assert_eq!(decimal("01", false), None);
        assert_eq!(amount_units("0.00000001"), Some(1));
        assert_eq!(price_sats("21000000000.00000000"), Some(DAILY_MAX_SATS));
        assert_eq!(price_sats("21000000000.00000001"), None);
    }

    #[test]
    fn old_state_without_sell_fields_loads_with_selling_off() {
        let v = vectors();
        let d = tmp("serde");
        // 0.9.17 이 쓴 state.json 모양(sell·sells·sell_outbox 없음).
        let old = json!({"links": [{"link_id": v["linkId"], "phone_key": v["phoneKey"], "phone_addresses": [v["phoneAddress"]], "name": "폰",
            "daily_sats": 100000000000u64, "created": 1, "revoked": false}], "requests": {}, "seen": {}, "spends": {}, "wraps": {}, "last_fetch": 0, "orphan_revokes": {}});
        std::fs::write(d.join("state.json"), serde_json::to_vec(&old).unwrap()).unwrap();
        let s = load(&d).unwrap();
        assert_eq!(s.links[0].sell, SellPolicy { enabled: false, daily: 3 });
        assert!(s.sells.is_empty() && s.sell_outbox.is_empty());
        let _ = std::fs::remove_dir_all(d);
    }

    #[test]
    fn the_daily_count_counts_accepted_sells_from_that_link_in_24_hours() {
        let v = vectors();
        let (now, desk) = (v["now"].as_i64().unwrap() + 1000, key(&v, "deskSecret"));
        let d = linked(&v, "count", true);
        let gifts: Vec<Value> = (0..5).map(|i| {
            let s = phone_sign(&v, "sell", sell_body(&v, &format!("{:02x}", 0x70 + i).repeat(32)));
            pack(&key(&v, "phoneSecret"), v["deskKey"].as_str().unwrap(), "sell", &s).unwrap()
        }).collect();
        process(&d, &desk, &gifts, now, None).unwrap();
        let s = load(&d).unwrap();
        let queued = s.sells.values().filter(|j| j.status == "queued").count();
        let refused: Vec<&SellJob> = s.sells.values().filter(|j| j.status == "refused").collect();
        assert_eq!((queued, refused.len()), (3, 2));
        assert!(refused.iter().all(|j| j.reason.as_deref() == Some("daily-count")));
        assert_eq!(count_today(&s, v["linkId"].as_str().unwrap(), now), 3, "refusals do not count");
        assert_eq!(count_today(&s, v["linkId"].as_str().unwrap(), now + DAY_MS + 1), 0, "yesterday does not count");
        // 거절은 폰에 서명된 결과로 간다.
        let res = results(&s);
        assert_eq!(res.iter().filter(|b| b["status"] == "refused" && b["reason"] == "daily-count").count(), 2);
        let _ = std::fs::remove_dir_all(d);
    }

    // ── 가짜 노드 ──
    #[derive(Default)]
    struct Fake {
        locked: RefCell<bool>, held: u64, lots: RefCell<Vec<(String, u64, i64)>>, calls: RefCell<Vec<String>>,
        wrong_pass: bool, state: RefCell<Option<String>>, lot_fails: bool,
    }
    impl Fake {
        fn n(&self, m: &str) -> usize { self.calls.borrow().iter().filter(|c| *c == m).count() }
        fn unlock(&self, pass: &Option<String>) -> Result<(), String> {
            if *self.locked.borrow() { match pass { None => return Err("지갑이 잠겨 있습니다. 암호가 필요합니다.".into()), Some(_) if self.wrong_pass => return Err("암호가 틀렸습니다.".into()), _ => {} } }
            Ok(())
        }
    }
    impl SellOps for Fake {
        async fn wallet_locked(&self) -> Result<bool, String> { Ok(*self.locked.borrow()) }
        async fn held(&self, _a: &str) -> Result<u64, String> { Ok(self.held) }
        async fn exact_lots(&self, _a: &str, _m: f64) -> Result<Vec<(String, u64, i64)>, String> { Ok(self.lots.borrow().clone()) }
        async fn make_lot(&self, _a: &str, _m: f64, pass: Option<String>, _k: &[(String, u64)]) -> Result<String, LotErr> {
            self.calls.borrow_mut().push("make_lot".into());
            self.unlock(&pass).map_err(LotErr::NotSent)?;
            if self.lot_fails { return Err(LotErr::Unknown("timeout".into())); }
            self.lots.borrow_mut().push(("ab".repeat(32), 0, 0));
            Ok("ab".repeat(32))
        }
        async fn offer(&self, _a: &str, _m: f64, _p: f64, at: (String, u64), pass: Option<String>) -> Result<Value, String> {
            self.calls.borrow_mut().push("offer".into());
            self.unlock(&pass)?;
            Ok(json!({"hex": "0200aa", "pay_to": "RPayAddr1111111111111111111111111", "txid": at.0, "vout": at.1}))
        }
        async fn publish(&self, _h: &str, _t: &str, _s: &str, _c: &str, _i: Option<String>) -> Result<Value, String> {
            self.calls.borrow_mut().push("publish".into());
            Ok(json!({"eventId": "ee".repeat(32), "d": format!("rvswap:{}:0", "ab".repeat(32))}))
        }
        async fn cancel(&self, _d: &str, pass: Option<String>) -> Result<Value, String> {
            self.calls.borrow_mut().push("cancel".into());
            self.unlock(&pass)?;
            Ok(json!({"txid": "cd".repeat(32)}))
        }
        async fn listing_state(&self, _d: &str, _at: &(String, u64)) -> Result<Option<String>, String> {
            self.calls.borrow_mut().push("listing_state".into());
            Ok(self.state.borrow().clone())
        }
    }
    struct Null;
    impl Net for Null {
        async fn publish(&self, _e: Value) -> Result<(), String> { Ok(()) }
        async fn fetch(&self, _p: &str, _s: i64) -> Result<(Vec<Value>, bool), String> { Ok((vec![], true)) }
    }
    #[derive(Default)]
    struct Rec { sent: RefCell<Vec<Value>> }
    impl Net for Rec {
        async fn publish(&self, e: Value) -> Result<(), String> { self.sent.borrow_mut().push(e); Ok(()) }
        async fn fetch(&self, _p: &str, _s: i64) -> Result<(Vec<Value>, bool), String> { Ok((vec![], true)) }
    }
    async fn queued(v: &Value, name: &str) -> (PathBuf, String) {
        let d = linked(v, name, true);
        process(&d, &key(v, "deskSecret"), &[gift(v, "sell", 0)], v["now"].as_i64().unwrap() + 1000, None).unwrap();
        (d, "33".repeat(32))
    }
    fn status(d: &Path, id: &str) -> String { load(d).unwrap().sells[id].status.clone() }

    #[tokio::test]
    async fn an_unlocked_wallet_runs_lot_wait_offer_publish_then_sold() {
        let v = vectors();
        let (now, desk) = (v["now"].as_i64().unwrap() + 2000, key(&v, "deskSecret"));
        let (d, id) = queued(&v, "flow").await;
        let ops = Fake { held: 100_000_000, ..Default::default() };
        tick(&ops, &d, &desk, now).await.unwrap();
        assert_eq!((status(&d, &id), ops.n("make_lot")), ("lot".into(), 1), "lot made, waiting for a confirmation");
        tick(&ops, &d, &desk, now + 3000).await.unwrap();
        assert_eq!((status(&d, &id), ops.n("make_lot"), ops.n("offer")), ("lot".into(), 1, 0), "no offer before 1 confirmation · never a second lot");
        ops.lots.borrow_mut()[0].2 = 1;
        tick(&ops, &d, &desk, now + 60_000).await.unwrap();
        let s = load(&d).unwrap();
        let j = &s.sells[&id];
        assert_eq!((j.status.as_str(), ops.n("offer"), ops.n("publish")), ("published", 1, 1));
        assert_eq!(j.outpoint, Some(("ab".repeat(32), 0)));
        let pub_res = results(&s).into_iter().find(|b| b["status"] == "published").unwrap();
        assert_eq!(pub_res["eventId"], json!("ee".repeat(32)));
        assert_eq!(pub_res["outpoint"], json!({"txid": "ab".repeat(32), "vout": 0}));
        // 같은 「팔아 줘」가 또 와도 다시 하지 않는다(마지막 결과만 다시 간다).
        let mut s = load(&d).unwrap();
        s.wraps.clear();
        save(&d, &s).unwrap();
        let out = process(&d, &desk, &[gift(&v, "sell", 0)], now + 61_000, None).unwrap();
        assert!(out.iter().any(|(_, t, x)| *t == "sellresult" && x["body"]["status"] == "published"));
        // 팔렸는지는 1분마다만 묻는다.
        tick(&ops, &d, &desk, now + 61_000).await.unwrap();
        assert_eq!(ops.n("listing_state"), 0);
        *ops.state.borrow_mut() = Some("sold".into());
        tick(&ops, &d, &desk, now + 200_000).await.unwrap();
        assert_eq!(status(&d, &id), "sold");
        assert!(results(&load(&d).unwrap()).iter().any(|b| b["status"] == "sold"));
        assert_eq!(ops.n("make_lot"), 1);
        let _ = std::fs::remove_dir_all(d);
    }

    #[tokio::test]
    async fn results_reach_the_phone_signed_and_a_locked_app_does_nothing() {
        let v = vectors();
        let (now, desk, phone) = (v["now"].as_i64().unwrap() + 2000, key(&v, "deskSecret"), key(&v, "phoneSecret"));
        let (d, id) = queued(&v, "deliver").await;
        let (net, ops) = (Rec::default(), Fake { held: 100_000_000, lots: RefCell::new(vec![("ab".repeat(32), 0, 2)]), ..Default::default() });
        let view = inbox_and_sell(&net, &ops, &d, &desk, now).await.unwrap();
        assert_eq!(view["sells"][0]["status"], json!("published"));
        assert_eq!(view["links"][0]["sell"], json!({"enabled": true, "daily": 3, "today": 1}));
        let got: Vec<Value> = net.sent.borrow().iter().filter_map(|e| unwrap(&phone, e)).filter_map(|(_, t)| serde_json::from_str::<Value>(&t).ok()).collect();
        let r = got.iter().find(|m| m["rvwl1"] == "sellresult").expect("the phone gets a sellresult");
        assert!(verify_body("sellresult", &r["s"], v["deskKey"].as_str().unwrap()));
        assert_eq!((r["s"]["body"]["id"].as_str(), r["s"]["body"]["status"].as_str()), (Some(id.as_str()), Some("published")));
        assert!(load(&d).unwrap().sell_outbox.is_empty(), "delivered results leave the outbox");
        // 앱이 잠기면 판매 일은 한 걸음도 안 간다.
        let (d2, id2) = queued(&v, "applock").await;
        crate::app_lock::lock_in_memory_for_test();
        let ops2 = Fake { held: 100_000_000, ..Default::default() };
        tick(&ops2, &d2, &desk, now).await.unwrap();
        assert!(ops2.calls.borrow().is_empty());
        assert_eq!(status(&d2, &id2), "queued");
        assert!(continue_with(&ops2, &d2, &desk, &id2, &Text("x".into()), now).await.is_err());
        for x in [d, d2] { let _ = std::fs::remove_dir_all(x); }
    }

    #[tokio::test]
    async fn a_locked_wallet_waits_for_a_human_and_never_stores_the_password() {
        let v = vectors();
        let (now, desk) = (v["now"].as_i64().unwrap() + 2000, key(&v, "deskSecret"));
        let (d, id) = queued(&v, "locked").await;
        let ops = Fake { held: 100_000_000, locked: RefCell::new(true), ..Default::default() };
        tick(&ops, &d, &desk, now).await.unwrap();
        let s = load(&d).unwrap();
        assert_eq!((s.sells[&id].status.as_str(), s.sells[&id].resume.as_deref(), ops.n("make_lot")), ("pending_human", Some("queued"), 0));
        assert!(results(&s).iter().any(|b| b["status"] == "pending_human"), "the phone hears it waits for the computer");
        tick(&ops, &d, &desk, now + 5000).await.unwrap();
        assert_eq!(ops.n("make_lot"), 0, "a waiting job does nothing by itself");
        // 틀린 암호 → 다시 사람 대기, 아무것도 안 나감(지급 기록도 풀림).
        let bad = Fake { wrong_pass: true, ..Fake { held: 100_000_000, locked: RefCell::new(true), ..Default::default() } };
        assert!(continue_with(&bad, &d, &desk, &id, &Text("x".into()), now + 6000).await.is_err());
        assert_eq!(status(&d, &id), "pending_human");
        match crate::payout_guard::begin(&payouts(&d), &lane(&id), "probe", b"x").unwrap() {
            crate::payout_guard::Begin::New(g) => g.abandon_unsent().unwrap(),
            _ => panic!("nothing was sent"),
        }
        // 맞는 암호 → 묶음을 만들고 확인을 기다린다.
        continue_with(&ops, &d, &desk, &id, &Text("pass".into()), now + 7000).await.unwrap();
        assert_eq!((status(&d, &id), ops.n("make_lot")), ("lot".into(), 1));
        ops.lots.borrow_mut()[0].2 = 1;
        tick(&ops, &d, &desk, now + 60_000).await.unwrap();
        assert_eq!((status(&d, &id), load(&d).unwrap().sells[&id].resume.as_deref()), ("pending_human".into(), Some("lot_ready")), "signing the offer asks again");
        continue_with(&ops, &d, &desk, &id, &Text("pass".into()), now + 61_000).await.unwrap();
        assert_eq!(status(&d, &id), "published");
        let disk = std::fs::read_to_string(d.join("state.json")).unwrap();
        assert!(!disk.contains("\"pass\""), "the password is never written");
        let _ = std::fs::remove_dir_all(d);
    }

    #[tokio::test]
    async fn not_held_off_revoked_timeouts_and_unknown_lots_stop_cleanly() {
        let v = vectors();
        let (now, desk) = (v["now"].as_i64().unwrap() + 2000, key(&v, "deskSecret"));
        let (d, id) = queued(&v, "notheld").await;
        tick(&Fake { held: 99_999_999, ..Default::default() }, &d, &desk, now).await.unwrap();
        assert_eq!((status(&d, &id), load(&d).unwrap().sells[&id].reason.clone()), ("refused".into(), Some("not-held".into())));
        // 허용을 끄면 올리기 전 일은 멈춘다.
        let (d2, id2) = queued(&v, "off").await;
        set_sell_in(&d2, &desk, v["linkId"].as_str().unwrap(), false, 3, now).unwrap();
        assert_eq!((status(&d2, &id2), load(&d2).unwrap().sells[&id2].reason.clone()), ("cancelled".into(), Some("sell-off".into())));
        assert!(set_sell_in(&d2, &desk, v["linkId"].as_str().unwrap(), true, 21, now).is_err(), "1..20");
        // 2시간이 지나면 실패로 닫힌다.
        let (d3, id3) = queued(&v, "ttl").await;
        let slow = Fake { held: 100_000_000, ..Default::default() };
        tick(&slow, &d3, &desk, now).await.unwrap();
        tick(&slow, &d3, &desk, now + JOB_TTL_MS + 5000).await.unwrap();
        assert_eq!((status(&d3, &id3), load(&d3).unwrap().sells[&id3].reason.clone()), ("failed".into(), Some("timeout".into())));
        // 묶음을 보냈는지 모르면 그 일만 막힌다(다시 보내지 않는다).
        let (d4, id4) = queued(&v, "unknown").await;
        let bad = Fake { held: 100_000_000, lot_fails: true, ..Default::default() };
        tick(&bad, &d4, &desk, now).await.unwrap();
        assert_eq!(status(&d4, &id4), "failed");
        assert!(crate::payout_guard::begin(&payouts(&d4), &lane(&id4), "lot", b"x").is_err(), "this job's lane stays blocked");
        assert_eq!(bad.n("make_lot"), 1);
        for x in [d, d2, d3, d4] { let _ = std::fs::remove_dir_all(x); }
    }

    #[tokio::test]
    async fn a_phone_unsell_cancels_only_its_own_listing_and_revoke_stops_selling() {
        let v = vectors();
        let (now, desk) = (v["now"].as_i64().unwrap() + 2000, key(&v, "deskSecret"));
        let (d, id) = queued(&v, "unsell").await;
        let ops = Fake { held: 100_000_000, lots: RefCell::new(vec![("ab".repeat(32), 0, 3)]), ..Default::default() };
        tick(&ops, &d, &desk, now).await.unwrap();
        assert_eq!(status(&d, &id), "published");
        let lid = v["linkId"].as_str().unwrap();
        let mk = |uid: &str, dd: &str| { let s = phone_sign(&v, "unsell", json!({"v": 1, "linkId": lid, "id": uid, "d": dd, "created": now, "expires": now + 600_000}));
            pack(&key(&v, "phoneSecret"), v["deskKey"].as_str().unwrap(), "unsell", &s).unwrap() };
        // 이 폰이 올린 글이 아니면 거절.
        process(&d, &desk, &[mk(&"81".repeat(32), &format!("rvswap:{}:9", "cc".repeat(32)))], now + 1000, None).unwrap();
        assert!(results(&load(&d).unwrap()).iter().any(|b| b["id"] == json!("81".repeat(32)) && b["reason"] == "unknown-listing"));
        process(&d, &desk, &[mk(&"82".repeat(32), &format!("rvswap:{}:0", "ab".repeat(32)))], now + 2000, None).unwrap();
        assert_eq!(status(&d, &id), "cancelling");
        tick(&ops, &d, &desk, now + 3000).await.unwrap();
        assert_eq!((status(&d, &id), ops.n("cancel")), ("cancelled".into(), 1));
        let res = results(&load(&d).unwrap());
        assert!(res.iter().any(|b| b["id"] == json!(id) && b["status"] == "cancelled"));
        assert!(res.iter().any(|b| b["id"] == json!("82".repeat(32)) && b["status"] == "cancelled"));
        // 연결을 끊으면 판매 허용이 꺼지고 올리기 전 일은 멈춘다.
        let (d2, id2) = queued(&v, "revoke").await;
        revoke_with(&Null, &d2, &desk, lid, now).await.unwrap();
        let s = load(&d2).unwrap();
        assert!(!s.links[0].sell.enabled && s.sells[&id2].status == "cancelled");
        for x in [d, d2] { let _ = std::fs::remove_dir_all(x); }
    }
}
