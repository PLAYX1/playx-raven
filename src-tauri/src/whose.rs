//! 「이 주소가 내 것인가」와 「내 주인 표는 지금 어느 주소에 있나」.
//!
//! ## 🔴 왜 생겼나 (0.4.6)
//!
//! 대표님이 자기 `PLAYX!`(주인 표)가 있는 주소를 앱에서 **찾지 못했다.** 노드에
//! 직접 물으니 `validateaddress` 가 `ismine=true`, `hdkeypath m/44'/175'/0'/1/33`
//! 이었다 — 받기 주소가 아니라 **거스름 주소**였다. 앱은 세 군데서 모자랐다:
//!
//! 1. 「이 주소가 내 것인가」를 물을 칸이 없었다.
//! 2. 주소록은 받기 주소(`listreceivedbyaddress`)만 보여 준다.
//! 3. 주인 표(`…!`)는 자산 목록에서 일부러 숨긴다(`raven.rs` `list_assets`).
//!
//! 그리고 레이븐 코어는 하위 자산·고유·재발행을 할 때 `change_address` 가 비어
//! 있으면 주인 표를 **새 거스름 주소로 옮긴다**(assets.cpp `CreateAssetTransaction`,
//! 빈 값이면 키풀에서 새 키). 발행할 때마다 주인 표의 주소가 바뀌니, 「주인 표를
//! 가진 주소」로 발행자를 알아보는 공유 카드의 인증이 매번 깨졌다. 그래서 발행할 때
//! 주인 표가 **지금 있는 주소**를 `change_address` 로 넣어 제자리로 돌아오게 한다
//! (`owner_pin` · `with_change`).
//!
//! ## 여기서 부르는 노드 명령은 전부 읽기다
//!
//! `validateaddress` · `listunspent` · `listmyassets` · `gettxout`. 보내는 명령은
//! 없다 — 그래서 시간 초과는 「보냈는지 모름」이 아니라 그냥 「못 읽음」이다
//! (`raven::is_send_method` 에 이 넷은 없다).
//!
//! 판정은 노드 없이 시험할 수 있게 순수 함수로 떼어 두었다(아래 `tests`).

use crate::raven::call_rpc;
use serde_json::{json, Value};
use std::collections::HashMap;

/// `gettxout` 을 한 번에 이 이상 부르지 않는다. 넘으면 「일부만 확인」.
///
/// 고유 자산을 수천 장 가진 지갑에서 주소 하나를 물을 때마다 수천 번 노드를
/// 두드리면, 그동안 가게 화면의 다른 물음이 줄을 선다.
pub const MAX_TXOUT_LOOKUPS: usize = 200;

/// 발행 한 번에 주인 표 자리를 볼 때 따라가는 조각 수. 주인 표는 늘 한 조각
/// (수량 1)이고, 자격 증명(`#A`)만 여러 조각일 수 있다.
const MAX_PIN_OUTPOINTS: usize = 20;

// ─────────────────────────────────────────────────────────────────────────
// 붙여 넣은 글자 → 주소
// ─────────────────────────────────────────────────────────────────────────

/// 붙여 넣은 것에서 주소만 뽑는다.
///
/// 사람은 주소만 붙이지 않는다. `raven:R…?amount=1`, 앞뒤 공백·줄바꿈, 따옴표,
/// `<R…>` 가 같이 온다. 그대로 노드에 넘기면 「레이븐 주소가 아니에요」가 뜨고,
/// 사람은 **자기 주소가 틀린 줄 안다.**
pub fn clean_input(raw: &str) -> String {
    let wrap = |c: char| c.is_whitespace() || matches!(c, '"' | '\'' | '<' | '>' | '`' | '「' | '」' | '(' | ')');
    let mut s = raw.trim_matches(wrap);
    if s.get(..6).map(|p| p.eq_ignore_ascii_case("raven:")).unwrap_or(false) {
        s = s[6..].trim_start_matches('/');
    }
    let s = s.split(['?', '#', '&']).next().unwrap_or("");
    s.trim_matches(wrap).to_string()
}

/// 노드에 물어볼 만한 모양인가. 영문·숫자 1~100자.
///
/// 판정은 노드가 한다. 여기서는 문장 통째나 빈 칸을 노드에 넘기지 않을 뿐이다.
fn worth_asking(s: &str) -> bool {
    !s.is_empty() && s.len() <= 100 && s.bytes().all(|b| b.is_ascii_alphanumeric())
}

// ─────────────────────────────────────────────────────────────────────────
// validateaddress → 판정
// ─────────────────────────────────────────────────────────────────────────

/// 주소 하나에 대한 판정.
#[derive(Debug, Clone, PartialEq)]
pub struct Verdict {
    /// `mine` · `watch` · `not_mine` · `invalid`
    pub state: &'static str,
    /// 내 주소일 때만: `receive`(받기) · `change`(거스름) · `imported`(가져온 열쇠) · `hd`(길을 못 읽음)
    pub kind: Option<&'static str>,
    /// 받기·거스름 주소의 번호(n).
    pub index: Option<u64>,
}

/// `m/44'/175'/0'/1/33` → `(1, 33)`. 옛 HD 모양(`m/0'/1'/33'`)도 같은 자리다.
///
/// 뒤에서 두 번째 칸이 `0` 이면 받기, `1` 이면 거스름, 마지막 칸이 번호.
pub fn hd_chain(path: &str) -> Option<(u32, u64)> {
    let parts: Vec<&str> = path.trim().split('/').collect();
    if parts.len() < 3 || parts[0] != "m" {
        return None;
    }
    let num = |s: &str| s.trim_end_matches(['\'', 'h', 'H']).parse::<u64>().ok();
    let n = num(parts[parts.len() - 1])?;
    let chain = num(parts[parts.len() - 2])?;
    (chain <= 1).then_some((chain as u32, n))
}

/// `validateaddress` 의 답을 읽는다. 노드는 부르지 않는다.
pub fn judge(v: &Value) -> Verdict {
    let flag = |k: &str| v.get(k).and_then(Value::as_bool).unwrap_or(false);
    if !flag("isvalid") {
        return Verdict { state: "invalid", kind: None, index: None };
    }
    if flag("ismine") {
        return match v.get("hdkeypath").and_then(Value::as_str) {
            Some(p) => match hd_chain(p) {
                Some((0, n)) => Verdict { state: "mine", kind: Some("receive"), index: Some(n) },
                Some((_, n)) => Verdict { state: "mine", kind: Some("change"), index: Some(n) },
                None => Verdict { state: "mine", kind: Some("hd"), index: None },
            },
            // 씨앗에서 나오지 않은 열쇠 — `importprivkey` 로 넣은 것.
            None => Verdict { state: "mine", kind: Some("imported"), index: None },
        };
    }
    if flag("iswatchonly") {
        return Verdict { state: "watch", kind: None, index: None };
    }
    Verdict { state: "not_mine", kind: None, index: None }
}

// ─────────────────────────────────────────────────────────────────────────
// 그 주소에 무엇이 있나
// ─────────────────────────────────────────────────────────────────────────

fn sats(v: f64) -> i64 {
    (v * 1e8).round() as i64
}
fn coins(s: i64) -> f64 {
    s as f64 / 1e8
}

/// `listunspent 0 9999999 [addr]` → (확인된 RVN, 확인 전 RVN).
///
/// 🔴 둘을 한 숫자로 합치지 않는다. 확인 전 돈을 받은 돈으로 치는 가게는 끝내
///    확인되지 않는 돈으로도 물건을 내준다.
pub fn rvn_at(unspent: &Value, addr: &str) -> (f64, f64) {
    let (mut done, mut wait) = (0i64, 0i64);
    for u in unspent.as_array().map(Vec::as_slice).unwrap_or(&[]) {
        if u.get("address").and_then(Value::as_str) != Some(addr) {
            continue;
        }
        let amount = sats(u.get("amount").and_then(Value::as_f64).unwrap_or(0.0));
        if u.get("confirmations").and_then(Value::as_i64).unwrap_or(0) >= 1 {
            done += amount;
        } else {
            wait += amount;
        }
    }
    (coins(done), coins(wait))
}

/// `listmyassets "*" true` 의 조각 하나.
#[derive(Debug, Clone, PartialEq)]
pub struct Outpoint {
    pub asset: String,
    pub txid: String,
    pub vout: u64,
    pub amount: f64,
}

/// `listmyassets … true`(verbose) 에서 조각을 모은다. **주인 표를 앞에** 둔다 —
/// 상한에 걸려 일부만 볼 때도 주인 표는 꼭 보게.
pub fn outpoints_of(verbose: &Value) -> Result<Vec<Outpoint>, String> {
    let map = verbose
        .as_object()
        .ok_or("지갑의 자산 목록을 읽지 못했어요.")?;
    let mut out = Vec::new();
    for (name, entry) in map {
        for o in entry.get("outpoints").and_then(Value::as_array).map(Vec::as_slice).unwrap_or(&[]) {
            let (Some(txid), Some(vout)) = (o.get("txid").and_then(Value::as_str), o.get("vout").and_then(Value::as_u64)) else {
                continue;
            };
            out.push(Outpoint {
                asset: name.clone(),
                txid: txid.to_string(),
                vout,
                amount: o.get("amount").and_then(Value::as_f64).unwrap_or(0.0),
            });
        }
    }
    out.sort_by(|a, b| {
        let (ao, bo) = (a.asset.ends_with('!'), b.asset.ends_with('!'));
        bo.cmp(&ao).then_with(|| a.asset.cmp(&b.asset)).then_with(|| a.txid.cmp(&b.txid)).then(a.vout.cmp(&b.vout))
    });
    Ok(out)
}

/// `gettxout txid vout true` 의 답에서 쓰는 것. `null` 이면 이미 쓰였다(멤풀에서 쓰인 것 포함).
#[derive(Debug, Clone, PartialEq)]
pub struct Seen {
    pub addresses: Vec<String>,
    pub confirmations: i64,
}

pub fn seen_of(txout: &Value) -> Option<Seen> {
    if txout.is_null() {
        return None;
    }
    let addresses = txout
        .get("scriptPubKey")
        .and_then(|s| s.get("addresses"))
        .and_then(Value::as_array)?
        .iter()
        .filter_map(Value::as_str)
        .map(str::to_string)
        .collect::<Vec<_>>();
    Some(Seen { addresses, confirmations: txout.get("confirmations").and_then(Value::as_i64).unwrap_or(0) })
}

/// 이 주소에 있는 자산. 조각을 자산별로 모은다. 순서: 주인 표 먼저, 그다음 이름순.
pub fn holdings_at(addr: &str, ops: &[Outpoint], seen: &[Option<Seen>]) -> Vec<Value> {
    let mut by: Vec<(String, i64, bool)> = Vec::new();
    for (o, s) in ops.iter().zip(seen) {
        let Some(s) = s else { continue };
        if !s.addresses.iter().any(|a| a == addr) {
            continue;
        }
        match by.iter_mut().find(|(n, _, _)| n == &o.asset) {
            Some(row) => {
                row.1 += sats(o.amount);
                row.2 |= s.confirmations < 1;
            }
            None => by.push((o.asset.clone(), sats(o.amount), s.confirmations < 1)),
        }
    }
    by.sort_by(|a, b| b.0.ends_with('!').cmp(&a.0.ends_with('!')).then_with(|| a.0.cmp(&b.0)));
    by.into_iter()
        .map(|(name, amount, unconfirmed)| {
            json!({ "owner": name.ends_with('!'), "name": name, "amount": coins(amount), "unconfirmed": unconfirmed })
        })
        .collect()
}

/// 주인 표마다 어느 주소에 있는지. `unknown` 은 따라가지 못한 조각 수.
pub fn owner_places(ops: &[Outpoint], seen: &[Option<Seen>]) -> Vec<Value> {
    let mut rows: Vec<(String, i64, Vec<String>, bool, u32)> = Vec::new();
    for (o, s) in ops.iter().zip(seen) {
        if !o.asset.ends_with('!') {
            continue;
        }
        let i = match rows.iter().position(|r| r.0 == o.asset) {
            Some(i) => i,
            None => {
                rows.push((o.asset.clone(), 0, Vec::new(), false, 0));
                rows.len() - 1
            }
        };
        let row = &mut rows[i];
        row.1 += sats(o.amount);
        match s {
            Some(s) => {
                for a in &s.addresses {
                    if !row.2.contains(a) {
                        row.2.push(a.clone());
                    }
                }
                row.3 |= s.confirmations < 1;
            }
            None => row.4 += 1,
        }
    }
    rows.sort_by(|a, b| a.0.cmp(&b.0));
    rows.into_iter()
        .map(|(name, amount, addresses, unconfirmed, unknown)| {
            json!({ "name": name, "amount": coins(amount), "addresses": addresses, "unconfirmed": unconfirmed, "unknown": unknown })
        })
        .collect()
}

/// 표 하나의 조각들이 **한 주소에만, 확인된 채로** 있으면 그 주소.
///
/// 아니면 이유: `not_found`(지갑에 없음) · `unknown`(따라가지 못함) ·
/// `many`(두 주소 이상) · `unconfirmed`(확인 0 만 있음).
pub fn pin_from(seen: &[Option<Seen>]) -> Result<String, &'static str> {
    if seen.is_empty() {
        return Err("not_found");
    }
    let mut addrs: Vec<&str> = Vec::new();
    let mut confirmed = false;
    for s in seen {
        let Some(s) = s else { return Err("unknown") };
        if s.addresses.is_empty() {
            return Err("unknown");
        }
        for a in &s.addresses {
            if !addrs.contains(&a.as_str()) {
                addrs.push(a);
            }
        }
        confirmed |= s.confirmations >= 1;
    }
    match addrs.as_slice() {
        [one] if confirmed => Ok(one.to_string()),
        [_] => Err("unconfirmed"),
        _ => Err("many"),
    }
}

// ─────────────────────────────────────────────────────────────────────────
// 발행 때 주인 표를 제자리로 — change_address
// ─────────────────────────────────────────────────────────────────────────

/// 이 발행이 쓰는 **부모 표**. `None` 이면 부모 표를 안 쓰는 발행이다
/// (루트 발행은 새 `NAME!` 를 만든다 — 옮길 표가 없다).
///
/// | 명령 | 이름 | 쓰는 표 |
/// |---|---|---|
/// | `issue` | `PLAYX/SONG` · `PLAYX#A` · `PLAYX~NEWS` | `PLAYX!` |
/// | `issue` | `PLAYX/SONG/X` | `PLAYX/SONG!` |
/// | `issueunique` | 루트 `PLAYX` | `PLAYX!` |
/// | `reissue` | `PLAYX` · `$SHARE` | `PLAYX!` · `SHARE!` |
/// | `issuerestrictedasset` | `$SHARE` | `SHARE!` |
/// | `issuequalifierasset` | `#KYC/#KR` | `#KYC` (자격 증명은 주인 표 대신 자기 자신을 쓴다) |
pub fn parent_token(method: &str, name: &str) -> Option<String> {
    let name = name.trim();
    if name.is_empty() {
        return None;
    }
    match method {
        "issueunique" => Some(format!("{name}!")),
        "reissue" | "issuerestrictedasset" => Some(format!("{}!", name.trim_start_matches('$'))),
        "issuequalifierasset" => name.rfind('/').filter(|&i| i > 0).map(|i| name[..i].to_string()),
        "issue" => {
            if name.starts_with(['#', '$']) {
                None
            } else if let Some(i) = name.find('#') {
                Some(format!("{}!", &name[..i]))
            } else if let Some(i) = name.find('~') {
                Some(format!("{}!", &name[..i]))
            } else {
                name.rfind('/').map(|i| format!("{}!", &name[..i]))
            }
        }
        _ => None,
    }
}

/// 발행 명령에서 `change_address` 가 몇 번째 인자인가(rpc/assets.cpp 의 인자 표).
pub fn change_slot(method: &str) -> Option<usize> {
    match method {
        "issue" | "reissue" | "issuequalifierasset" => Some(3),
        "issueunique" | "issuerestrictedasset" => Some(4),
        _ => None,
    }
}

/// 인자에 `change_address` 를 넣는다. 자리가 모자라면 손대지 않는다.
pub fn with_change(method: &str, mut params: Value, address: &str) -> Value {
    if let (Some(i), Some(a)) = (change_slot(method), params.as_array_mut()) {
        if i < a.len() {
            a[i] = json!(address);
        }
    }
    params
}

/// 한 발행의 주인 표 자리.
#[derive(Debug, Clone, PartialEq)]
pub struct Pin {
    /// 이 발행이 쓰는 부모 표. 없으면(루트) 나머지도 의미가 없다.
    pub token: Option<String>,
    /// 그 표가 지금 있는 내 주소. `None` 이면 `""` 로 보낸다(노드가 새 거스름 주소로).
    pub address: Option<String>,
    /// 못 고정한 까닭: `not_found` · `unknown` · `many` · `unconfirmed` · `not_mine`.
    pub why: Option<&'static str>,
}

impl Pin {
    fn none() -> Pin {
        Pin { token: None, address: None, why: None }
    }
    /// 거스름 자리에 넣을 값 — 고정했으면 그 주소, 못 했으면 예전처럼 `""`.
    pub fn change(&self) -> &str {
        self.address.as_deref().unwrap_or("")
    }
    /// 발행 결과에 붙이는 몫. 루트 발행이면 `owner_pinned: null`.
    pub fn report(&self) -> Value {
        match &self.token {
            None => json!({ "owner_token": null, "owner_pinned": null }),
            Some(t) => json!({
                "owner_token": t,
                "owner_pinned": self.address.is_some(),
                "owner_address": self.address,
                "owner_why": self.why,
            }),
        }
    }
}

/// 발행 결과 = 거래 번호 + 주인 표를 제자리에 뒀는지.
pub fn issued(txid: String, pin: &Pin) -> Value {
    let mut v = pin.report();
    v["txid"] = json!(txid);
    v
}

/// 방금 읽어 둔 자리. 화면이 「보내는 중」을 적기 **전에** 읽게 하려고 둔다
/// (`owner_pin_ready`). 한 번 쓰면 지운다. 오래된 것은 안 쓴다.
static READY: std::sync::Mutex<Option<HashMap<String, (Pin, std::time::Instant)>>> = std::sync::Mutex::new(None);
const READY_FOR: std::time::Duration = std::time::Duration::from_secs(300);

fn take_ready(token: &str) -> Option<Pin> {
    let mut g = READY.lock().ok()?;
    let (pin, at) = g.as_mut()?.remove(token)?;
    (at.elapsed() < READY_FOR).then_some(pin)
}

fn keep_ready(pin: &Pin) {
    if let (Some(t), Ok(mut g)) = (pin.token.clone(), READY.lock()) {
        g.get_or_insert_with(HashMap::new).insert(t, (pin.clone(), std::time::Instant::now()));
    }
}

/// 표 하나가 지금 있는 주소를 읽는다. **읽기만** 하고, 실패는 오류가 아니라
/// 「못 고정」이다 — 이것 때문에 발행이 막히면 안 된다.
async fn locate(token: &str) -> Pin {
    let miss = |why| Pin { token: Some(token.to_string()), address: None, why: Some(why) };
    let Ok(verbose) = call_rpc("listmyassets", json!([token, true])).await else { return miss("unknown") };
    let Ok(all) = outpoints_of(&verbose) else { return miss("unknown") };
    let ops: Vec<Outpoint> = all.into_iter().filter(|o| o.asset == token).collect();
    if ops.len() > MAX_PIN_OUTPOINTS {
        return miss("many");
    }
    let mut seen = Vec::with_capacity(ops.len());
    for o in &ops {
        match call_rpc("gettxout", json!([o.txid, o.vout, true])).await {
            Ok(v) => seen.push(seen_of(&v)),
            Err(_) => return miss("unknown"),
        }
    }
    let address = match pin_from(&seen) {
        Ok(a) => a,
        Err(why) => return miss(why),
    };
    // 🔴 거스름을 보낼 자리다. 이 지갑이 쓸 수 있는 주소가 아니면 절대 넣지 않는다.
    match call_rpc("validateaddress", json!([address])).await {
        Ok(v) if judge(&v).state == "mine" => Pin { token: Some(token.to_string()), address: Some(address), why: None },
        Ok(_) => miss("not_mine"),
        Err(_) => miss("unknown"),
    }
}

/// 이 발행의 주인 표 자리. 먼저 읽어 둔 것이 있으면 그것을 쓴다.
pub async fn owner_pin(method: &str, name: &str) -> Pin {
    let Some(token) = parent_token(method, name) else { return Pin::none() };
    if let Some(p) = take_ready(&token) {
        return p;
    }
    locate(&token).await
}

/// 발행 마법사의 종류 → 노드 명령.
fn method_of_kind(kind: &str) -> Option<&'static str> {
    match kind {
        "sub" | "unique" => Some("issue"),
        "bulk" => Some("issueunique"),
        "reissue" => Some("reissue"),
        "qualifier" => Some("issuequalifierasset"),
        "restricted" => Some("issuerestrictedasset"),
        _ => None,
    }
}

/// 마법사의 종류·이름 → 미리 읽어 둘 주인 표.
///
/// 화면은 자격 이름을 `#` 없이 넘길 수 있다(`A/#B`). `issue_qualifier` 가 앞에 `#` 를
/// 붙이는 것과 똑같이 붙여야 같은 표(`#A`)를 찾는다 — 안 붙이면 `A` 를 찾아 헛걸음한다.
pub fn ready_token(kind: &str, name: &str) -> Option<String> {
    let method = method_of_kind(kind)?;
    let name = if method == "issuequalifierasset" && !name.starts_with('#') {
        format!("#{name}")
    } else {
        name.to_string()
    };
    parent_token(method, &name)
}

/// 화면이 「보내는 중」을 적기 **전에** 부른다 — 주인 표 자리를 읽어 둔다.
///
/// 🔴 발행 마법사는 `issue_unknown_mark(… "sending")` 을 적은 뒤에 발행을 부른다.
///    그 뒤에 읽기를 하면, 읽다가 늦어진 것과 보내다 늦어진 것이 한 창 안에 섞인다.
///    읽기는 그 앞에서 끝낸다. 실패해도 오류를 내지 않는다(`owner_pinned: false`).
#[tauri::command]
pub async fn owner_pin_ready(kind: String, name: String) -> Value {
    let Some(token) = ready_token(&kind, &name) else { return Pin::none().report() };
    let pin = locate(&token).await;
    keep_ready(&pin);
    pin.report()
}

// ─────────────────────────────────────────────────────────────────────────
// 화면이 부르는 두 명령
// ─────────────────────────────────────────────────────────────────────────

/// 조각마다 `gettxout`. 상한까지만. (조각, 본 것, 일부만 봤나)
async fn follow(ops: Vec<Outpoint>) -> (Vec<Outpoint>, Vec<Option<Seen>>, usize) {
    let total = ops.len();
    let ops: Vec<Outpoint> = ops.into_iter().take(MAX_TXOUT_LOOKUPS).collect();
    // 노드 쪽 동시 부름은 `raven::call_rpc` 의 문(4개)이 줄 세운다.
    let seen = futures_util::future::join_all(ops.iter().map(|o| async move {
        call_rpc("gettxout", json!([o.txid, o.vout, true])).await.ok().and_then(|v| seen_of(&v))
    }))
    .await;
    (ops, seen, total)
}

/// 이 주소는 내 것인가 — 그리고 내 것이면 거기 무엇이 있나.
///
/// 판정: `mine`(받기 n번 · 거스름 n번 · 가져온 열쇠) · `watch`(감시만) ·
/// `not_mine` · `invalid`. 가진 것을 못 읽어도 판정은 돌려준다
/// (`holdings.error`) — 「내 주소예요」까지 못 보여 줄 까닭은 없다.
#[tauri::command]
pub async fn addr_whose(address: String) -> Result<Value, String> {
    let addr = clean_input(&address);
    if !worth_asking(&addr) {
        return Ok(json!({ "address": addr, "state": "invalid", "kind": null, "index": null, "holdings": null }));
    }
    let v = call_rpc("validateaddress", json!([addr])).await?;
    let verdict = judge(&v);
    let holdings = if verdict.state == "mine" { Some(holdings(&addr).await) } else { None };
    Ok(json!({
        "address": addr,
        "state": verdict.state,
        "kind": verdict.kind,
        "index": verdict.index,
        "holdings": holdings,
    }))
}

async fn holdings(addr: &str) -> Value {
    let mut errors: Vec<String> = Vec::new();
    let (confirmed, unconfirmed) = match call_rpc("listunspent", json!([0, 9_999_999, [addr]])).await {
        Ok(u) => rvn_at(&u, addr),
        Err(e) => {
            errors.push(e);
            (0.0, 0.0)
        }
    };
    let (assets, partial, checked, total) = match call_rpc("listmyassets", json!(["*", true])).await.and_then(|v| outpoints_of(&v)) {
        Ok(ops) => {
            let (ops, seen, total) = follow(ops).await;
            (holdings_at(addr, &ops, &seen), total > ops.len(), ops.len(), total)
        }
        Err(e) => {
            errors.push(e);
            (Vec::new(), false, 0, 0)
        }
    };
    json!({
        "rvn": { "confirmed": confirmed, "unconfirmed": unconfirmed },
        "assets": assets,
        "partial": partial,
        "checked": checked,
        "total": total,
        "error": errors.first(),
    })
}

/// 내 주인 표마다 어느 주소에 있나.
///
/// 자산 목록(`list_assets`)은 주인 표를 **일부러 숨긴다** — `PLAYX` 와 `PLAYX!` 가
/// 두 줄로 나오면 목록이 두 배가 되고 아무것도 설명하지 못한다. 대신 여기서
/// 「발행 권한 열쇠」로 따로 보여 준다. 보내기 단추는 없다.
#[tauri::command]
pub async fn owner_tokens_where() -> Result<Value, String> {
    let verbose = call_rpc("listmyassets", json!(["*", true])).await?;
    let ops: Vec<Outpoint> = outpoints_of(&verbose)?.into_iter().filter(|o| o.asset.ends_with('!')).collect();
    let (ops, seen, total) = follow(ops).await;
    Ok(json!({ "tokens": owner_places(&ops, &seen), "partial": total > ops.len() }))
}

#[cfg(test)]
mod tests {
    use super::*;

    // 🔴 시험 주소는 누가 봐도 가짜다. 진짜 지갑의 주소를 넣지 않는다.
    const A: &str = "RTestAddressAAAAAAAAAAAAAAAAAAAAAA";
    const B: &str = "RTestAddressBBBBBBBBBBBBBBBBBBBBBB";
    const TX1: &str = "1111111111111111111111111111111111111111111111111111111111111111";
    const TX2: &str = "2222222222222222222222222222222222222222222222222222222222222222";
    const TX3: &str = "3333333333333333333333333333333333333333333333333333333333333333";

    /// 레이븐 4.8 `validateaddress` 의 모양 그대로(rpc/misc.cpp).
    fn va(ismine: bool, watch: bool, path: Option<&str>) -> Value {
        let mut v = json!({
            "isvalid": true, "address": A, "scriptPubKey": "76a914000000000000000000000000000000000000000088ac",
            "ismine": ismine, "iswatchonly": watch, "isscript": false, "iswitness": false,
            "pubkey": "02".to_string() + &"00".repeat(32), "iscompressed": true, "account": "",
            "timestamp": 1_700_000_000,
        });
        if let Some(p) = path {
            v["hdkeypath"] = json!(p);
            v["hdseedid"] = json!("00".repeat(20));
        }
        v
    }

    #[test]
    fn 붙여넣은_것에서_주소만_뽑는다() {
        assert_eq!(clean_input(&format!("  {A}\n")), A);
        assert_eq!(clean_input(&format!("raven:{A}?amount=1.5&label=x")), A);
        assert_eq!(clean_input(&format!("RAVEN:{A}")), A);
        assert_eq!(clean_input(&format!("raven://{A}")), A);
        assert_eq!(clean_input(&format!("\"{A}\"")), A);
        assert_eq!(clean_input(&format!("<{A}>")), A);
        assert_eq!(clean_input("   "), "");
        // 한글이 섞여도 자르다가 죽지 않는다(바이트 경계).
        assert_eq!(clean_input("라비야"), "라비야");
        assert!(!worth_asking(&clean_input("라비야 이거 내꺼야")));
        assert!(worth_asking(A));
    }

    #[test]
    fn 거스름_주소_33번을_알아본다() {
        // 대표님이 겪은 그 모양 — 받기 주소가 아니라 거스름 주소였다.
        let v = judge(&va(true, false, Some("m/44'/175'/0'/1/33")));
        assert_eq!(v, Verdict { state: "mine", kind: Some("change"), index: Some(33) });
        let v = judge(&va(true, false, Some("m/44'/175'/0'/0/3")));
        assert_eq!(v, Verdict { state: "mine", kind: Some("receive"), index: Some(3) });
        // 옛 HD 모양도 같은 자리.
        assert_eq!(judge(&va(true, false, Some("m/0'/1'/7'"))).kind, Some("change"));
        assert_eq!(judge(&va(true, false, Some("m/0'/0'/7'"))).index, Some(7));
        // 길이 이상하면 번호를 지어내지 않는다.
        assert_eq!(judge(&va(true, false, Some("m"))), Verdict { state: "mine", kind: Some("hd"), index: None });
        assert_eq!(judge(&va(true, false, Some("m/44'/175'/0'/5/1"))).kind, Some("hd"));
    }

    #[test]
    fn 가져온_열쇠_감시_남의_잘못된_주소() {
        assert_eq!(judge(&va(true, false, None)), Verdict { state: "mine", kind: Some("imported"), index: None });
        assert_eq!(judge(&va(false, true, None)).state, "watch");
        assert_eq!(judge(&va(false, false, None)).state, "not_mine");
        // 잘못된 주소에는 isvalid 하나만 온다.
        assert_eq!(judge(&json!({ "isvalid": false })).state, "invalid");
        assert_eq!(judge(&json!({})).state, "invalid");
    }

    #[test]
    fn 받은_돈은_확인된_것과_확인_전을_나눈다() {
        // listunspent 4.8 모양.
        let u = json!([
            { "txid": TX1, "vout": 0, "address": A, "account": "", "scriptPubKey": "76a9", "amount": 1.1, "confirmations": 12, "spendable": true, "solvable": true, "safe": true },
            { "txid": TX2, "vout": 1, "address": A, "scriptPubKey": "76a9", "amount": 0.2, "confirmations": 0, "spendable": true, "solvable": true, "safe": true },
            { "txid": TX3, "vout": 0, "address": B, "scriptPubKey": "76a9", "amount": 99.0, "confirmations": 5, "spendable": true, "solvable": true, "safe": true },
        ]);
        let (done, wait) = rvn_at(&u, A);
        assert_eq!(done, 1.1);
        assert_eq!(wait, 0.2);
        assert_eq!(rvn_at(&json!([]), A), (0.0, 0.0));
    }

    fn verbose() -> Value {
        // listmyassets "*" true — 4.8 모양(rpc/assets.cpp listmyassets verbose).
        json!({
            "PLAYX": { "balance": 5.0, "outpoints": [
                { "txid": TX1, "vout": 2, "amount": 3.0 },
                { "txid": TX2, "vout": 1, "amount": 2.0 } ] },
            "PLAYX!": { "balance": 1.0, "outpoints": [ { "txid": TX3, "vout": 1, "amount": 1.0 } ] },
            "SHOP.TEST!": { "balance": 1.0, "outpoints": [ { "txid": TX2, "vout": 3, "amount": 1.0 } ] },
        })
    }
    fn txout(addr: &str, conf: i64) -> Option<Seen> {
        // gettxout 4.8 모양에서 읽는다.
        seen_of(&json!({
            "bestblock": "00".repeat(32), "confirmations": conf, "value": 0.0,
            "scriptPubKey": { "asm": "OP_DUP", "hex": "76a9", "reqSigs": 1, "type": "transfer_asset",
                "asset": { "name": "X", "amount": 1.0 }, "addresses": [addr] },
            "coinbase": false,
        }))
    }

    #[test]
    fn 주인_표가_먼저_오고_조각을_모두_읽는다() {
        let ops = outpoints_of(&verbose()).unwrap();
        assert_eq!(ops.len(), 4);
        assert!(ops[0].asset.ends_with('!') && ops[1].asset.ends_with('!'), "주인 표가 앞: {ops:?}");
        assert!(outpoints_of(&json!("nope")).is_err(), "못 읽은 것을 「없음」으로 넘기지 않는다");
        assert!(seen_of(&Value::Null).is_none(), "쓰인 조각(null)은 어디에도 없다");
    }

    #[test]
    fn 이_주소에_있는_것만_센다() {
        let ops = outpoints_of(&verbose()).unwrap();
        // 순서: PLAYX!(TX3:1) · SHOP.TEST!(TX2:3) · PLAYX(TX1:2) · PLAYX(TX2:1)
        let seen = vec![txout(A, 3), txout(B, 3), txout(A, 0), txout(A, 9)];
        let got = holdings_at(A, &ops, &seen);
        assert_eq!(got.len(), 2);
        assert_eq!(got[0]["name"], "PLAYX!");
        assert_eq!(got[0]["owner"], true);
        assert_eq!(got[1]["name"], "PLAYX");
        assert_eq!(got[1]["amount"], 5.0);
        assert_eq!(got[1]["unconfirmed"], true, "확인 0 조각이 섞였다");
        // 쓰인 조각(null)은 세지 않는다.
        let seen = vec![None, None, txout(A, 1), None];
        let got = holdings_at(A, &ops, &seen);
        assert_eq!(got, vec![json!({ "owner": false, "name": "PLAYX", "amount": 3.0, "unconfirmed": false })]);
    }

    #[test]
    fn 주인_표마다_보관_주소() {
        let ops = outpoints_of(&verbose()).unwrap();
        let seen = vec![txout(A, 3), None, txout(A, 1), txout(A, 1)];
        let rows = owner_places(&ops, &seen);
        assert_eq!(rows.len(), 2, "주인 표만: {rows:?}");
        assert_eq!(rows[0], json!({ "name": "PLAYX!", "amount": 1.0, "addresses": [A], "unconfirmed": false, "unknown": 0 }));
        assert_eq!(rows[1]["name"], "SHOP.TEST!");
        assert_eq!(rows[1]["unknown"], 1);
        assert_eq!(rows[1]["addresses"], json!([]));
    }

    #[test]
    fn 한_주소에_확인된_채로_있을_때만_고정한다() {
        assert_eq!(pin_from(&[txout(A, 3)]), Ok(A.to_string()));
        assert_eq!(pin_from(&[txout(A, 3), txout(A, 0)]), Ok(A.to_string()), "같은 주소, 확인된 조각이 있다");
        assert_eq!(pin_from(&[txout(A, 0)]), Err("unconfirmed"));
        assert_eq!(pin_from(&[txout(A, 3), txout(B, 3)]), Err("many"));
        assert_eq!(pin_from(&[txout(A, 3), None]), Err("unknown"));
        assert_eq!(pin_from(&[]), Err("not_found"));
    }

    #[test]
    fn 부모_표를_이름에서_찾는다() {
        assert_eq!(parent_token("issue", "PLAYX/SONG").as_deref(), Some("PLAYX!"));
        assert_eq!(parent_token("issue", "PLAYX/SONG/INEVITABLE").as_deref(), Some("PLAYX/SONG!"));
        assert_eq!(parent_token("issue", "PLAYX/GAME#LAMP001").as_deref(), Some("PLAYX/GAME!"));
        assert_eq!(parent_token("issue", "SHOP.TEST#M-1").as_deref(), Some("SHOP.TEST!"));
        assert_eq!(parent_token("issue", "PLAYX~NEWS").as_deref(), Some("PLAYX!"));
        assert_eq!(parent_token("issueunique", "PLAYX").as_deref(), Some("PLAYX!"));
        assert_eq!(parent_token("reissue", "PLAYX").as_deref(), Some("PLAYX!"));
        assert_eq!(parent_token("reissue", "PLAYX/SONG").as_deref(), Some("PLAYX/SONG!"));
        assert_eq!(parent_token("reissue", "$SHARE").as_deref(), Some("SHARE!"));
        assert_eq!(parent_token("issuerestrictedasset", "$SHARE").as_deref(), Some("SHARE!"));
        assert_eq!(parent_token("issuequalifierasset", "#KYC/#KR").as_deref(), Some("#KYC"));
        // 루트 발행은 새 NAME! 를 만든다 — 옮길 표가 없다.
        assert_eq!(parent_token("issue", "PLAYX"), None);
        assert_eq!(parent_token("issuequalifierasset", "#KYC"), None);
        assert_eq!(parent_token("issue", "#KYC"), None);
        assert_eq!(parent_token("sendtoaddress", "PLAYX/SONG"), None);
    }

    #[test]
    fn 마법사가_미리_읽을_표() {
        assert_eq!(ready_token("sub", "PLAYX/SONG").as_deref(), Some("PLAYX!"));
        assert_eq!(ready_token("unique", "PLAYX#CERT1").as_deref(), Some("PLAYX!"));
        assert_eq!(ready_token("bulk", "PLAYX").as_deref(), Some("PLAYX!"));
        assert_eq!(ready_token("reissue", "PLAYX").as_deref(), Some("PLAYX!"));
        assert_eq!(ready_token("restricted", "SHARE").as_deref(), Some("SHARE!"));
        assert_eq!(ready_token("restricted", "$SHARE").as_deref(), Some("SHARE!"));
        // 화면이 `#` 를 빼고 넘겨도 `issue_qualifier` 와 같은 표를 찾는다.
        assert_eq!(ready_token("qualifier", "KYC/#KR").as_deref(), Some("#KYC"));
        assert_eq!(ready_token("qualifier", "#KYC/#KR").as_deref(), Some("#KYC"));
        assert_eq!(ready_token("qualifier", "KYC"), None);
        assert_eq!(ready_token("root", "PLAYX"), None);
    }

    #[test]
    fn 거스름_자리에_넣는다() {
        // rpc/assets.cpp 의 인자 표 그대로.
        let p = with_change("issue", json!(["PLAYX/SONG", 100, "", "", 0, true, false, ""]), A);
        assert_eq!(p, json!(["PLAYX/SONG", 100, "", A, 0, true, false, ""]));
        let p = with_change("issueunique", json!(["PLAYX", ["A-1"], null, "", ""]), A);
        assert_eq!(p, json!(["PLAYX", ["A-1"], null, "", A]));
        let p = with_change("reissue", json!(["PLAYX", 0, B, "", true, -1, "Qm"]), A);
        assert_eq!(p[2], json!(B), "받는 주소는 그대로");
        assert_eq!(p[3], json!(A));
        let p = with_change("issuequalifierasset", json!(["#KYC/#KR", 1, "", "", false, ""]), A);
        assert_eq!(p[3], json!(A));
        let p = with_change("issuerestrictedasset", json!(["$SHARE", 1, "#KYC", B, "", 0, true, false, ""]), A);
        assert_eq!(p[4], json!(A));
        // 모르는 명령·짧은 인자는 손대지 않는다.
        assert_eq!(with_change("transfer", json!(["X", 1, B]), A), json!(["X", 1, B]));
        assert_eq!(with_change("issue", json!(["X"]), A), json!(["X"]));
    }

    #[test]
    fn 결과에_고정했는지를_적는다() {
        let pinned = Pin { token: Some("PLAYX!".into()), address: Some(A.into()), why: None };
        let v = issued("ab".repeat(32), &pinned);
        assert_eq!(v["txid"], "ab".repeat(32));
        assert_eq!(v["owner_pinned"], true);
        assert_eq!(v["owner_address"], A);
        let missed = Pin { token: Some("PLAYX!".into()), address: None, why: Some("many") };
        let v = issued("cd".repeat(32), &missed);
        assert_eq!(v["owner_pinned"], false);
        assert_eq!(v["owner_why"], "many");
        let root = issued("ef".repeat(32), &Pin::none());
        assert!(root["owner_pinned"].is_null(), "루트 발행은 고정할 것이 없다");
    }

    #[test]
    fn 읽어_둔_자리는_한_번만_쓴다() {
        let p = Pin { token: Some("TESTPINONCE!".into()), address: Some(A.into()), why: None };
        keep_ready(&p);
        assert_eq!(take_ready("TESTPINONCE!"), Some(p));
        assert_eq!(take_ready("TESTPINONCE!"), None);
    }

    /// 🔴 이 파일은 읽기만 한다. 보내는 명령이 섞이면 시간 초과가 「보냈는지 모름」이 된다.
    #[test]
    fn 읽기_명령만_부른다() {
        let src = include_str!("whose.rs");
        let body = &src[..src.find("#[cfg(test)]").unwrap()];
        for m in ["validateaddress", "listunspent", "listmyassets", "gettxout"] {
            assert!(!crate::raven::is_send_method(m), "{m}");
        }
        for (i, _) in body.match_indices("call_rpc(\"") {
            let m = &body[i + 10..];
            let m = &m[..m.find('"').unwrap()];
            assert!(["validateaddress", "listunspent", "listmyassets", "gettxout"].contains(&m), "읽기가 아닌 부름: {m}");
        }
    }
}
