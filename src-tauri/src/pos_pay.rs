//! 체인 POS ② — 결제 기록 + 끊겨도 쌓이는 매출 로그 (docs/CHAIN-POS.md).
//!
//! * 가게에서 돈을 받은 **결과**만 적는다: 결제수단(카드 승인번호·현금·현금영수증 발급번호·RVN 거래 번호·기타),
//!   영수증 번호, 원화 금액, 매장 번호, 사업자등록번호(+종사업장 번호).
//!   🔴 카드 승인·현금영수증 발급·세금계산서는 하지 않는다(VAN·PG·국세청 몫). 이 파일에는 네트워크 호출이 **하나도 없다**.
//! * 덧붙이기만 하는 로그 — `lan_store`(lan/log/<가게>) 와 같은 꼴: 한 줄 = JSON 하나, 쓰고 `sync_data` 한 뒤에만 「됐어요」,
//!   쓰다 만 꼬리(끝 줄바꿈 없음)는 버린다, 파일 0600. 폴더 = `pos/log/<범위>/<YYYYMM>.jsonl` (+ `head.json`).
//!   범위 = 체인 매장이면 `chain-<본점 지문 16자>-<매장 번호>`, 아니면 `shop`. 매장이 되면 새 로그가 따로 시작한다.
//! * 줄마다 `prev` = 앞 줄(정본 JSON, sig 포함)의 SHA-256 — 중간 줄을 지우거나 고치면 다음 줄에서 끊김이 보인다.
//!   마지막 줄·통째 지우기는 `head.json`(마지막 번호·해시)과 비교해 본다. 체인 매장이면 줄마다 **매장 열쇠로 서명**
//!   (도메인 `ravenvault-chain-sale-v1`, lan_cert 서명 꼴) — ③에서 본점이 그대로 확인한다.
//! * 고치기 = 없다. 취소는 원래 줄을 가리키는 새 `void` 줄(금액은 원래 줄에서 가져와 음수). 같은 줄을 두 번 취소할 수 없다.
//! * 영수증 번호 = 줄 번호(seq). 매장마다 하나씩 늘기만 하고 다시 쓰지 않는다 — 로그가 잘려도 `head.json` 의 번호 다음부터 잇는다.
//!
//! 🔴 매장 비밀 열쇠는 오류·로그에 싣지 않는다(고정 문장만). 서명 뒤 `words::wipe*` 로 지운다(chain_store::sign_as_store_in).

use crate::lan_cert::{is_public_key, signed_by};
use crate::lan_proof::canonical_string;
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

pub const SALE_DOMAIN: &str = "ravenvault-chain-sale-v1";
pub const METHODS: [&str; 5] = ["card", "cash", "cash_receipt", "rvn", "other"];
pub const MAX_AMOUNT: i64 = 1_000_000_000;
const ZERO: &str = "0000000000000000000000000000000000000000000000000000000000000000";
const MAX_LINE: usize = 8 * 1024;
const HEAD_FILE: &str = "head.json";

pub const ERR_METHOD: &str = "결제 방법을 골라 주세요.";
pub const ERR_AMOUNT: &str = "금액을 원 단위 숫자로 적어 주세요.";
pub const ERR_CARD_NO: &str = "카드 단말기 영수증의 승인번호를 적어 주세요.";
pub const ERR_ISSUER: &str = "카드사 이름은 20자까지예요.";
pub const ERR_CASH_RECEIPT_NO: &str = "현금영수증 발급번호를 적어 주세요.";
pub const ERR_TXID: &str = "RVN 거래 번호(64자리)를 적어 주세요.";
pub const ERR_MEMO: &str = "메모는 40자까지예요(줄바꿈 없이).";
pub const ERR_ORDER: &str = "주문 번호가 올바르지 않아요.";
pub const ERR_ORDER_DONE: &str = "이 주문은 이미 결제 기록이 있어요.";
pub const ERR_NO_SALE: &str = "그 영수증 번호를 찾지 못했어요.";
pub const ERR_ALREADY_VOID: &str = "이미 취소한 결제예요.";
pub const ERR_SAVE: &str = "결제 기록을 저장하지 못했어요. 디스크 공간과 권한을 확인해 주세요.";
pub const ERR_SIGN: &str = "매장 열쇠로 서명하지 못했어요. 본점에 연락해 주세요.";
pub const ERR_CHAIN_BIZ: &str = "체인 매장은 본점이 정한 사업자 번호를 써요.";
pub const ERR_LOCKED: &str = crate::storesign::ERR_LOCKED;

fn pos_root() -> PathBuf {
    crate::paths::app_file("pos")
}

fn now_ms() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_millis() as i64)
}

// ── 이 컴퓨터가 누구인가 ──────────────────────────────────────────────

/// 체인 매장이면 증서에서, 아니면 `pos/settings.json` 에서.
#[derive(Debug, Clone)]
pub struct Ctx {
    pub scope: String,
    pub store: Option<u32>,
    pub name: Option<String>,
    pub chain: Option<String>,
    pub store_key: Option<String>,
    pub biz: Option<Value>,
}

impl Ctx {
    fn signed(&self) -> bool {
        self.store_key.is_some()
    }
}

pub fn ctx_in(root: &Path, chain_dir: &Path) -> Ctx {
    if let Some(s) = crate::chain_store::store_self_in(chain_dir) {
        let fp = crate::chain_store::chain_list_id(&s.chain);
        return Ctx {
            scope: format!("chain-{}-{}", &fp[..16.min(fp.len())], s.store),
            store: Some(s.store),
            name: Some(s.name),
            chain: Some(s.chain),
            store_key: Some(s.store_key),
            biz: Some(s.biz),
        };
    }
    let biz = read_json(&root.join("settings.json")).and_then(|v| v.get("biz").cloned()).filter(|b| {
        let no = b.get("no").and_then(Value::as_str).unwrap_or("");
        crate::chain_store::clean_biz(no, b.get("sub").and_then(Value::as_str)).ok().as_ref() == Some(b)
    });
    Ctx { scope: "shop".into(), store: None, name: None, chain: None, store_key: None, biz }
}

fn read_json(p: &Path) -> Option<Value> {
    serde_json::from_slice(&std::fs::read(p).ok()?).ok()
}

/// 가게(체인 아님)의 사업자 번호. 체인 매장은 증서 것을 쓰므로 거절.
pub fn biz_save_in(root: &Path, chain_dir: &Path, no: &str, sub: Option<&str>) -> Result<Value, String> {
    if ctx_in(root, chain_dir).chain.is_some() {
        return Err(ERR_CHAIN_BIZ.into());
    }
    let biz = if no.trim().is_empty() { Value::Null } else { crate::chain_store::clean_biz(no, sub).map_err(String::from)? };
    let bytes = serde_json::to_vec_pretty(&json!({ "v": 1, "biz": biz })).map_err(|_| ERR_SAVE.to_string())?;
    crate::server::atomic_write_0600(&root.join("settings.json"), &bytes).map_err(|_| ERR_SAVE.to_string())?;
    Ok(json!({ "biz": biz }))
}

// ── 줄 확인 ──────────────────────────────────────────────────────────

pub fn record_hash(v: &Value) -> Option<String> {
    Some(hex::encode(Sha256::digest(canonical_string(v).ok()?.as_bytes())))
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Break {
    /// 줄이 JSON 이 아니거나 모양이 틀렸다.
    Shape,
    /// 번호가 하나씩 늘지 않는다(줄을 지웠거나 끼워 넣었다).
    Seq,
    /// 앞 줄 해시가 다르다(앞 줄을 고쳤다).
    Prev,
    /// 서명이 없거나 틀렸다.
    Signature,
    /// head.json 과 다르다(마지막 줄을 지웠거나 고쳤다).
    Head,
}
impl Break {
    pub fn code(&self) -> &'static str {
        match self {
            Break::Shape => "shape",
            Break::Seq => "seq",
            Break::Prev => "prev",
            Break::Signature => "signature",
            Break::Head => "head",
        }
    }
}

/// 줄 모양(종류별 칸).
fn shape_ok(o: &Map<String, Value>) -> bool {
    let kind = o.get("kind").and_then(Value::as_str).unwrap_or("");
    let seq_ok = o.get("seq").and_then(Value::as_u64).is_some();
    let at_ok = o.get("at").and_then(Value::as_i64).is_some();
    let prev_ok = o.get("prev").and_then(Value::as_str).is_some_and(|p| p.len() == 64 && p.bytes().all(|b| b.is_ascii_hexdigit()));
    let v_ok = o.get("v").and_then(Value::as_u64) == Some(1);
    let key_ok = match o.get("key") {
        None => !o.contains_key("sig"),
        Some(k) => k.as_str().is_some_and(is_public_key) && o.get("sig").is_some_and(Value::is_string),
    };
    let body_ok = match kind {
        "open" => o.get("logId").and_then(Value::as_str).is_some_and(|s| s.len() == 32),
        "sale" => o.get("method").and_then(Value::as_str).is_some_and(|m| METHODS.contains(&m))
            && o.get("amount").and_then(Value::as_i64).is_some_and(|a| (1..=MAX_AMOUNT).contains(&a)),
        "void" => o.get("ref").and_then(Value::as_u64).is_some()
            && o.get("amount").and_then(Value::as_i64).is_some_and(|a| (-MAX_AMOUNT..=-1).contains(&a)),
        _ => false,
    };
    v_ok && seq_ok && at_ok && prev_ok && key_ok && body_ok
}

/// 로그 전체 확인 결과.
#[derive(Debug, Clone, Default)]
pub struct Check {
    pub records: usize,
    pub last_seq: Option<u64>,
    pub last_hash: Option<String>,
    pub broken: Option<(u64, Break)>,
    /// 처음 끊김 앞까지의 줄 수(③ 본점은 이 앞부분만 받아 둔다).
    pub ok_prefix: usize,
}

/// 줄들을 처음부터 본다: 번호 연속 → 앞 줄 해시 → 모양 → (체인 매장 로그면) 매장 열쇠 서명.
/// 첫 줄이 `open` 이고 거기 `chain` 이 있으면 모든 줄에 서명이 있어야 한다(서명을 떼어 내 가짜 줄로 바꾸는 길을 막는다).
/// `want_key` 를 주면 서명한 열쇠가 그 열쇠여야 한다(③ 본점 확인 — 증서의 storeKey).
pub fn verify_records(lines: &[Value], want_key: Option<&str>) -> Check {
    verify_records_from(lines, want_key, None)
}

/// 이어 받기(③ 본점): `start = (다음 번호, 앞 줄 해시)` 부터 이어지는 줄들을 본다. 이때는 모든 줄에 서명이 있어야 한다.
pub fn verify_records_from(lines: &[Value], want_key: Option<&str>, start: Option<(u64, &str)>) -> Check {
    let mut c = Check::default();
    let mut signed_log = start.is_some();
    let mut prev_hash = start.map_or_else(|| ZERO.to_string(), |s| s.1.to_string());
    let mut want_seq: u64 = start.map_or(0, |s| s.0);
    let mut prev_seq: Option<u64> = None;
    for (i, v) in lines.iter().enumerate() {
        let seq = v.get("seq").and_then(Value::as_u64).unwrap_or(u64::MAX);
        let fail = |c: &mut Check, b: Break| {
            if c.broken.is_none() {
                c.broken = Some((seq, b));
            }
        };
        let Some(o) = v.as_object().filter(|o| shape_ok(o)) else {
            fail(&mut c, Break::Shape);
            continue;
        };
        if i == 0 && start.is_none() {
            signed_log = o.get("kind").and_then(Value::as_str) == Some("open") && o.get("chain").is_some_and(|c| !c.is_null());
        }
        if seq != want_seq {
            fail(&mut c, Break::Seq);
        } else if o.get("prev").and_then(Value::as_str) != Some(prev_hash.as_str()) {
            fail(&mut c, Break::Prev);
        }
        if signed_log || o.contains_key("sig") {
            let key = o.get("key").and_then(Value::as_str).unwrap_or("");
            if !signed_by(SALE_DOMAIN, o, key) || want_key.is_some_and(|w| w != key) {
                fail(&mut c, Break::Signature);
            }
        }
        prev_seq = Some(seq);
        want_seq = seq.saturating_add(1);
        prev_hash = record_hash(v).unwrap_or_default();
        c.records += 1;
        if c.broken.is_none() {
            c.ok_prefix = i + 1;
        }
    }
    c.last_seq = prev_seq;
    c.last_hash = prev_seq.map(|_| prev_hash);
    c
}

// ── 로그 파일 ────────────────────────────────────────────────────────

fn month_of(at_ms: i64) -> u32 {
    (crate::ledger::local_ymd(at_ms.div_euclid(1000), 0) / 100) as u32
}

fn month_files(dir: &Path) -> Vec<(u32, PathBuf)> {
    let mut out: Vec<(u32, PathBuf)> = std::fs::read_dir(dir).into_iter().flatten().flatten()
        .filter_map(|e| {
            let p = e.path();
            let stem = p.file_stem()?.to_str()?;
            (p.extension()? == "jsonl" && stem.len() == 6).then(|| stem.parse::<u32>().ok().map(|m| (m, p.clone())))?
        })
        .collect();
    out.sort();
    out
}

/// 파일을 읽어 줄로. 쓰다 만 꼬리(끝 줄바꿈 없음)는 잘라 낸다(lan_store 와 같음 — 「됐어요」를 받지 못한 줄이다).
fn read_lines(path: &Path, trim_tail: bool) -> Vec<Value> {
    let mut raw = Vec::new();
    let Ok(mut f) = std::fs::File::open(path) else { return Vec::new() };
    if f.read_to_end(&mut raw).is_err() {
        return Vec::new();
    }
    let good = raw.iter().rposition(|b| *b == b'\n').map_or(0, |i| i + 1);
    if trim_tail && good < raw.len() {
        if let Ok(f) = std::fs::OpenOptions::new().write(true).open(path) {
            let _ = f.set_len(good as u64).and_then(|_| f.sync_data());
        }
    }
    raw[..good].split(|b| *b == b'\n').filter(|l| !l.is_empty())
        .map(|l| if l.len() > MAX_LINE { Value::Null } else { serde_json::from_slice(l).unwrap_or(Value::Null) })
        .collect()
}

/// 이 컴퓨터의 매출 로그 전체(③ 본점 보내기용). (범위, 로그 번호, 줄들). 쓰다 만 꼬리는 읽지 않는다(자르지도 않는다).
pub fn log_lines_in(root: &Path, chain_dir: &Path) -> (String, Option<String>, Vec<Value>) {
    let ctx = ctx_in(root, chain_dir);
    let dir = root.join("log").join(&ctx.scope);
    let lines: Vec<Value> = month_files(&dir).iter().flat_map(|(_, p)| read_lines(p, false)).collect();
    let log_id = lines.first().filter(|v| v.get("kind").and_then(Value::as_str) == Some("open"))
        .and_then(|v| v.get("logId")).and_then(Value::as_str).map(String::from);
    (ctx.scope, log_id, lines)
}

pub(crate) fn pos_root_path() -> PathBuf {
    pos_root()
}

/// 메모리에 들고 있는 로그 머리(처음 한 번 전체를 읽어 확인한 뒤, 쓸 때마다 갱신).
struct Head {
    log_id: Option<String>,
    next_seq: u64,
    prev_hash: String,
    last_month: u32,
    broken: Option<(u64, Break)>,
    /// seq → (금액, 결제수단) — 취소할 때 원래 줄에서 가져온다.
    sales: HashMap<u64, (i64, String)>,
    voided: HashSet<u64>,
    /// 결제 기록이 있는(취소 안 된) 주문 → seq.
    orders: HashMap<String, u64>,
}

static HEADS: Mutex<Option<HashMap<PathBuf, Head>>> = Mutex::new(None);

fn load_head(dir: &Path) -> Head {
    let files = month_files(dir);
    let mut lines = Vec::new();
    let n = files.len();
    for (i, (_, p)) in files.iter().enumerate() {
        lines.extend(read_lines(p, i + 1 == n));
    }
    let check = verify_records(&lines, None);
    let mut h = Head {
        log_id: None,
        next_seq: check.last_seq.map_or(0, |s| s + 1),
        prev_hash: check.last_hash.clone().unwrap_or_else(|| ZERO.to_string()),
        last_month: files.last().map_or(0, |(m, _)| *m),
        broken: check.broken.clone(),
        sales: HashMap::new(),
        voided: HashSet::new(),
        orders: HashMap::new(),
    };
    for v in &lines {
        let seq = v.get("seq").and_then(Value::as_u64).unwrap_or(u64::MAX);
        match v.get("kind").and_then(Value::as_str) {
            Some("open") if h.log_id.is_none() => h.log_id = v.get("logId").and_then(Value::as_str).map(String::from),
            Some("sale") => {
                let amt = v.get("amount").and_then(Value::as_i64).unwrap_or(0);
                let m = v.get("method").and_then(Value::as_str).unwrap_or("other").to_string();
                h.sales.insert(seq, (amt, m));
                if let Some(o) = v.get("order").and_then(Value::as_str) {
                    h.orders.insert(o.to_string(), seq);
                }
            }
            Some("void") => {
                if let Some(r) = v.get("ref").and_then(Value::as_u64) {
                    h.voided.insert(r);
                    h.orders.retain(|_, s| *s != r);
                }
            }
            _ => {}
        }
    }
    // head.json: 마지막으로 「됐어요」 한 번호·해시. 로그가 그보다 짧거나 그 줄이 다르면 지워졌거나 고쳐졌다.
    if let Some(hd) = read_json(&dir.join(HEAD_FILE)) {
        let hseq = hd.get("seq").and_then(Value::as_u64);
        let hhash = hd.get("hash").and_then(Value::as_str);
        if let Some(hseq) = hseq {
            let at = lines.iter().find(|v| v.get("seq").and_then(Value::as_u64) == Some(hseq));
            let same = at.and_then(record_hash).as_deref() == hhash;
            if !same && h.broken.is_none() {
                h.broken = Some((hseq, Break::Head));
            }
            // 번호는 다시 쓰지 않는다 — 잘린 로그라도 head 다음부터.
            h.next_seq = h.next_seq.max(hseq + 1);
        }
        if h.log_id.is_none() {
            h.log_id = hd.get("logId").and_then(Value::as_str).map(String::from);
        }
    }
    h
}

fn with_head<R>(dir: &Path, f: impl FnOnce(&mut Head) -> R) -> R {
    let mut g = HEADS.lock().unwrap_or_else(|e| e.into_inner());
    let map = g.get_or_insert_with(HashMap::new);
    let h = map.entry(dir.to_path_buf()).or_insert_with(|| load_head(dir));
    f(h)
}

#[cfg(test)]
fn forget_head(dir: &Path) {
    if let Some(m) = HEADS.lock().unwrap_or_else(|e| e.into_inner()).as_mut() {
        m.remove(dir);
    }
}

fn append_line(dir: &Path, month: u32, line: &[u8]) -> std::io::Result<()> {
    std::fs::create_dir_all(dir)?;
    let path = dir.join(format!("{month:06}.jsonl"));
    let mut oo = std::fs::OpenOptions::new();
    oo.append(true).create(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        oo.mode(0o600);
    }
    let mut f = oo.open(&path)?;
    let mut buf = Vec::with_capacity(line.len() + 1);
    buf.extend_from_slice(line);
    buf.push(b'\n');
    f.write_all(&buf)?;
    f.sync_data()
}

/// 한 줄 쓰기: 번호·앞 해시를 붙이고, (체인 매장이면) 서명하고, 덧붙이고, head.json 을 고친다.
/// 실패하면 메모리 머리는 그대로(다음에 같은 번호로 다시 쓴다 — 쓰다 만 꼬리는 다음에 열 때 버려진다).
fn append_in(root: &Path, chain_dir: &Path, ctx: &Ctx, h: &mut Head, mut body: Map<String, Value>, at: i64) -> Result<Value, String> {
    let dir = root.join("log").join(&ctx.scope);
    body.insert("v".into(), json!(1));
    body.insert("seq".into(), json!(h.next_seq));
    body.insert("at".into(), json!(at));
    body.insert("prev".into(), json!(h.prev_hash));
    if let Some(k) = &ctx.store_key {
        body.insert("key".into(), json!(k));
    }
    let mut rec = Value::Object(body);
    if ctx.signed() {
        rec = crate::chain_store::sign_as_store_in(chain_dir, SALE_DOMAIN, &rec).map_err(|_| ERR_SIGN.to_string())?;
    }
    let line = canonical_string(&rec).map_err(|_| ERR_SAVE.to_string())?;
    if line.len() > MAX_LINE {
        return Err(ERR_SAVE.into());
    }
    let hash = record_hash(&rec).ok_or_else(|| ERR_SAVE.to_string())?;
    // 시계가 뒤로 가도 파일 순서는 뒤로 가지 않는다(읽을 때 파일 이름 순서 = 줄 순서).
    let month = month_of(at).max(h.last_month);
    append_line(&dir, month, line.as_bytes()).map_err(|_| ERR_SAVE.to_string())?;
    h.next_seq += 1;
    h.prev_hash = hash.clone();
    h.last_month = month;
    let seq = rec["seq"].as_u64().unwrap_or(0);
    let head = json!({ "v": 1, "seq": seq, "hash": hash, "logId": h.log_id });
    // head 저장 실패는 기록을 되돌리지 않는다(줄은 이미 디스크에 있다) — 다음 쓰기에서 다시 맞춘다.
    let _ = crate::server::atomic_write_0600(&dir.join(HEAD_FILE), &serde_json::to_vec(&head).unwrap_or_default());
    Ok(rec)
}

fn ensure_open(root: &Path, chain_dir: &Path, ctx: &Ctx, h: &mut Head, at: i64) -> Result<(), String> {
    if h.next_seq > 0 {
        return Ok(());
    }
    use rand::RngCore;
    let mut id = [0u8; 16];
    rand::rngs::OsRng.fill_bytes(&mut id);
    let log_id = hex::encode(id);
    h.log_id = Some(log_id.clone());
    let mut b = Map::new();
    b.insert("kind".into(), json!("open"));
    b.insert("logId".into(), json!(log_id));
    b.insert("store".into(), json!(ctx.store));
    b.insert("chain".into(), json!(ctx.chain));
    b.insert("biz".into(), ctx.biz.clone().unwrap_or(Value::Null));
    append_in(root, chain_dir, ctx, h, b, at).map(|_| ())
}

// ── 입력 다듬기 ──────────────────────────────────────────────────────

fn clean_text(s: Option<&str>, max: usize, err: &'static str) -> Result<Option<String>, &'static str> {
    let Some(t) = s.map(str::trim).filter(|t| !t.is_empty()) else { return Ok(None) };
    if t.chars().count() > max || t.chars().any(|c| c.is_control() || matches!(c, '\u{200b}'..='\u{200f}' | '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}')) {
        return Err(err);
    }
    Ok(Some(t.to_string()))
}

/// 숫자·영문·빼기표만(공백은 뺀다). 길이 min..=max.
fn clean_code(s: Option<&str>, min: usize, max: usize, err: &'static str) -> Result<String, &'static str> {
    let t: String = s.unwrap_or("").chars().filter(|c| !c.is_whitespace()).collect();
    if (min..=max).contains(&t.len()) && t.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-') {
        Ok(t)
    } else {
        Err(err)
    }
}

/// 화면이 넘기는 결제 한 건.
#[derive(Debug, Default, Clone)]
pub struct PayInput {
    pub method: String,
    pub amount: Option<i64>,
    /// 카드 승인번호 / 현금영수증 발급번호 / RVN 거래 번호 — 결제수단마다 뜻이 다르다.
    pub number: Option<String>,
    pub issuer: Option<String>,
    pub order: Option<String>,
    pub memo: Option<String>,
}

/// 주문 주소로 매출장부(ledger)에서 찾은 RVN 판매: (원화 금액, txid, rvn 문자열). 원화 주문일 때만.
pub type OrderLookup<'a> = &'a dyn Fn(&str) -> Option<(i64, String, String)>;

fn ledger_lookup(order: &str) -> Option<(i64, String, String)> {
    let row = crate::ledger::settled_order(order, now_ms() / 1000)?;
    if row.get("currency").and_then(Value::as_str) != Some("KRW") {
        return None;
    }
    let krw = row.get("amount").and_then(Value::as_f64).filter(|a| a.is_finite() && *a >= 1.0)?.round() as i64;
    let txid = row.get("txid").and_then(Value::as_str)?.to_string();
    let rvn = row.get("rvn").map(|r| match r {
        Value::String(s) => s.clone(),
        other => other.to_string(),
    }).unwrap_or_default();
    Some((krw, txid, rvn))
}

fn is_txid(s: &str) -> bool {
    s.len() == 64 && s.bytes().all(|b| b.is_ascii_hexdigit())
}

/// 결제 한 건을 적는다. 돌려주는 값 = 쓴 줄(서명 포함).
pub fn record_in(root: &Path, chain_dir: &Path, input: &PayInput, lookup: OrderLookup, at: i64) -> Result<Value, String> {
    let method = METHODS.iter().find(|m| **m == input.method).copied().ok_or(ERR_METHOD)?;
    let order = match input.order.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        None => None,
        Some(o) if o.len() <= 100 && o.bytes().all(|b| b.is_ascii_alphanumeric()) => Some(o.to_string()),
        Some(_) => return Err(ERR_ORDER.into()),
    };
    let memo = clean_text(input.memo.as_deref(), 40, ERR_MEMO)?;
    let mut amount = input.amount;
    let mut b = Map::new();
    b.insert("kind".into(), json!("sale"));
    b.insert("method".into(), json!(method));
    match method {
        "card" => {
            b.insert("approval".into(), json!(clean_code(input.number.as_deref(), 4, 20, ERR_CARD_NO)?));
            if let Some(i) = clean_text(input.issuer.as_deref(), 20, ERR_ISSUER)? {
                b.insert("issuer".into(), json!(i));
            }
        }
        "cash_receipt" => {
            b.insert("cashReceipt".into(), json!(clean_code(input.number.as_deref(), 4, 40, ERR_CASH_RECEIPT_NO)?));
        }
        "rvn" => {
            // 주문이 매출장부에 있으면(원화 주문) 그때 얼린 원화 금액·txid 를 쓴다 — 지금 시세로 다시 재지 않는다.
            let found = order.as_deref().and_then(|o| lookup(o));
            let (txid, rvn) = match found {
                Some((krw, txid, rvn)) => {
                    amount = Some(krw);
                    b.insert("krwFrom".into(), json!("order"));
                    (txid, Some(rvn).filter(|r| !r.is_empty()))
                }
                None => {
                    let t = input.number.as_deref().map(str::trim).unwrap_or("").to_lowercase();
                    if !is_txid(&t) {
                        return Err(ERR_TXID.into());
                    }
                    b.insert("krwFrom".into(), json!("staff"));
                    (t, None)
                }
            };
            b.insert("txid".into(), json!(txid));
            if let Some(r) = rvn.filter(|r| r.len() <= 32) {
                b.insert("rvn".into(), json!(r));
            }
        }
        _ => {}
    }
    let amount = amount.filter(|a| (1..=MAX_AMOUNT).contains(a)).ok_or(ERR_AMOUNT)?;
    b.insert("amount".into(), json!(amount));
    if let Some(m) = memo {
        b.insert("memo".into(), json!(m));
    }
    let ctx = ctx_in(root, chain_dir);
    b.insert("store".into(), json!(ctx.store));
    b.insert("biz".into(), ctx.biz.clone().unwrap_or(Value::Null));
    if let Some(o) = &order {
        b.insert("order".into(), json!(o));
    }
    let dir = root.join("log").join(&ctx.scope);
    with_head(&dir, |h| {
        if order.as_ref().is_some_and(|o| h.orders.contains_key(o)) {
            return Err(ERR_ORDER_DONE.to_string());
        }
        ensure_open(root, chain_dir, &ctx, h, at)?;
        let rec = append_in(root, chain_dir, &ctx, h, b, at)?;
        let seq = rec["seq"].as_u64().unwrap_or(0);
        h.sales.insert(seq, (amount, method.to_string()));
        if let Some(o) = order {
            h.orders.insert(o, seq);
        }
        Ok(rec)
    })
}

/// 결제 취소 — 원래 줄을 가리키는 새 줄. 금액·결제수단은 원래 줄에서(화면이 주는 값을 믿지 않는다).
pub fn void_in(root: &Path, chain_dir: &Path, seq: u64, reason: Option<&str>, at: i64) -> Result<Value, String> {
    let reason = clean_text(reason, 40, ERR_MEMO)?;
    let ctx = ctx_in(root, chain_dir);
    let dir = root.join("log").join(&ctx.scope);
    with_head(&dir, |h| {
        let (amt, method) = h.sales.get(&seq).cloned().ok_or(ERR_NO_SALE)?;
        if h.voided.contains(&seq) {
            return Err(ERR_ALREADY_VOID.to_string());
        }
        let mut b = Map::new();
        b.insert("kind".into(), json!("void"));
        b.insert("ref".into(), json!(seq));
        b.insert("method".into(), json!(method));
        b.insert("amount".into(), json!(-amt));
        b.insert("store".into(), json!(ctx.store));
        b.insert("biz".into(), ctx.biz.clone().unwrap_or(Value::Null));
        if let Some(r) = reason {
            b.insert("reason".into(), json!(r));
        }
        let rec = append_in(root, chain_dir, &ctx, h, b, at)?;
        h.voided.insert(seq);
        h.orders.retain(|_, s| *s != seq);
        Ok(rec)
    })
}

/// 화면에 보낼 줄(서명·열쇠·앞 해시는 빼고).
fn row_for_screen(v: &Value, voided: &HashSet<u64>) -> Value {
    let mut o = v.as_object().cloned().unwrap_or_default();
    for k in ["sig", "key", "prev", "v", "biz", "store"] {
        o.shift_remove(k);
    }
    let seq = v.get("seq").and_then(Value::as_u64).unwrap_or(0);
    o.insert("voided".into(), json!(voided.contains(&seq)));
    Value::Object(o)
}

/// 하루(또는 아무 구간) 목록 + 결제수단별 합계(취소는 빼고 센다).
pub fn day_in(root: &Path, chain_dir: &Path, from_ms: i64, to_ms: i64) -> Value {
    let ctx = ctx_in(root, chain_dir);
    let dir = root.join("log").join(&ctx.scope);
    let (broken, voided) = with_head(&dir, |h| (h.broken.clone(), h.voided.clone()));
    let first = month_of(from_ms);
    let mut rows = Vec::new();
    let mut totals: Map<String, Value> = METHODS.iter().map(|m| (m.to_string(), json!(0))).collect();
    let mut net = 0i64;
    let mut count = 0u64;
    for (m, p) in month_files(&dir) {
        if m < first {
            continue;
        }
        for v in read_lines(&p, false) {
            let at = v.get("at").and_then(Value::as_i64).unwrap_or(0);
            let kind = v.get("kind").and_then(Value::as_str).unwrap_or("");
            if !(from_ms..to_ms).contains(&at) || !matches!(kind, "sale" | "void") {
                continue;
            }
            let amt = v.get("amount").and_then(Value::as_i64).unwrap_or(0);
            let method = v.get("method").and_then(Value::as_str).unwrap_or("other").to_string();
            if let Some(t) = totals.get_mut(&method) {
                *t = json!(t.as_i64().unwrap_or(0) + amt);
            }
            net += amt;
            if kind == "sale" {
                count += 1;
            }
            rows.push(row_for_screen(&v, &voided));
        }
    }
    rows.reverse();
    json!({
        "rows": rows, "totals": totals, "net": net, "count": count,
        "store": ctx.store, "name": ctx.name, "biz": ctx.biz, "chain": ctx.chain.is_some(),
        "check": match broken { None => json!({ "ok": true }), Some((s, b)) => json!({ "ok": false, "at": s, "why": b.code() }) },
    })
}

pub fn status_in(root: &Path, chain_dir: &Path) -> Value {
    let ctx = ctx_in(root, chain_dir);
    json!({ "chain": ctx.chain.is_some(), "store": ctx.store, "name": ctx.name, "biz": ctx.biz, "signed": ctx.signed() })
}

// ── 명령 ─────────────────────────────────────────────────────────────

fn refuse_locked() -> Result<(), String> {
    if crate::app_lock::is_locked() {
        Err(ERR_LOCKED.into())
    } else {
        Ok(())
    }
}

/// 결제 기록. 인터넷이 없어도 된다(매출장부 조회도 이 컴퓨터 파일).
#[tauri::command(async)]
pub fn pos_record(method: String, amount: Option<i64>, number: Option<String>, issuer: Option<String>, order: Option<String>, memo: Option<String>) -> Result<Value, String> {
    refuse_locked()?;
    let input = PayInput { method, amount, number, issuer, order, memo };
    let rec = record_in(&pos_root(), &crate::chain_store::chain_dir_path(), &input, &ledger_lookup, now_ms())?;
    Ok(json!({ "ok": true, "receipt": rec["seq"], "amount": rec["amount"], "method": rec["method"], "at": rec["at"] }))
}

#[tauri::command(async)]
pub fn pos_void(seq: u64, reason: Option<String>) -> Result<Value, String> {
    refuse_locked()?;
    let rec = void_in(&pos_root(), &crate::chain_store::chain_dir_path(), seq, reason.as_deref(), now_ms())?;
    Ok(json!({ "ok": true, "receipt": rec["seq"], "ref": rec["ref"] }))
}

/// 하루 매출 — 금액이 보이므로 잠김이면 거절.
#[tauri::command(async)]
pub fn pos_day(from_ms: i64, to_ms: i64) -> Result<Value, String> {
    refuse_locked()?;
    Ok(day_in(&pos_root(), &crate::chain_store::chain_dir_path(), from_ms, to_ms))
}

/// 체인 매장인지·사업자 번호가 있는지만(금액 없음).
#[tauri::command(async)]
pub fn pos_status() -> Value {
    status_in(&pos_root(), &crate::chain_store::chain_dir_path())
}

#[tauri::command(async)]
pub fn pos_biz_save(biz_no: String, biz_sub: Option<String>) -> Result<Value, String> {
    refuse_locked()?;
    biz_save_in(&pos_root(), &crate::chain_store::chain_dir_path(), &biz_no, biz_sub.as_deref())
}

#[cfg(test)]
mod tests {
    use super::*;

    const WORDS: &str = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
    const NOW: i64 = 1_790_000_000_000;

    fn fresh(name: &str) -> (PathBuf, PathBuf) {
        let d = crate::paths::test_fixture_root().join(format!("pos-pay-{name}"));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        let (root, chain) = (d.join("pos"), d.join("chain"));
        forget_head(&root.join("log").join("shop"));
        (root, chain)
    }
    fn none(_: &str) -> Option<(i64, String, String)> {
        None
    }
    fn pay(method: &str, amount: i64, number: Option<&str>) -> PayInput {
        PayInput { method: method.into(), amount: Some(amount), number: number.map(String::from), ..Default::default() }
    }
    fn log_dir(root: &Path, chain: &Path) -> PathBuf {
        root.join("log").join(ctx_in(root, chain).scope)
    }
    fn all_lines(dir: &Path) -> Vec<Value> {
        month_files(dir).iter().flat_map(|(_, p)| read_lines(p, false)).collect()
    }
    /// 체인 매장 PC 를 만든다(본점 발급 → 매장 합류).
    fn join_store(name: &str, n: u32) -> (PathBuf, PathBuf, String) {
        let (root, chain) = fresh(name);
        let owner = chain.parent().unwrap().join("owner");
        std::fs::create_dir_all(&owner).unwrap();
        let csk = crate::identity::chain_key_from(WORDS, "").unwrap();
        let ssk = crate::identity::chain_store_key_from(WORDS, "", n, 0).unwrap();
        let biz = crate::chain_store::clean_biz("123-45-67890", Some("0002")).unwrap();
        let r = crate::chain_store::issue_in(&owner, &csk, &ssk, n, "강남점", &biz, NOW).unwrap();
        std::fs::create_dir_all(&chain).unwrap();
        crate::chain_store::join_in(&chain, &r.bundle, &r.install_words, NOW).unwrap();
        forget_head(&log_dir(&root, &chain));
        (root, chain, r.store_pubkey)
    }

    #[test]
    fn append_chains_hashes_and_receipts_only_go_up() {
        let (root, chain) = fresh("chain");
        let a = record_in(&root, &chain, &pay("cash", 4500, None), &none, NOW).unwrap();
        let b = record_in(&root, &chain, &pay("card", 12000, Some("3051 2299")), &none, NOW + 1).unwrap();
        let c = record_in(&root, &chain, &pay("cash_receipt", 8000, Some("123-456-789")), &none, NOW + 2).unwrap();
        assert_eq!((a["seq"].as_u64(), b["seq"].as_u64(), c["seq"].as_u64()), (Some(1), Some(2), Some(3)), "0번은 로그 시작 줄");
        assert_eq!(b["approval"], "30512299");
        assert_eq!(b["prev"].as_str(), record_hash(&a).as_deref());
        let dir = log_dir(&root, &chain);
        let lines = all_lines(&dir);
        assert_eq!(lines[0]["kind"], "open");
        let ck = verify_records(&lines, None);
        assert!(ck.broken.is_none(), "{:?}", ck.broken);
        assert_eq!(ck.last_seq, Some(3));
        // 다시 열어도(메모리 머리 버림) 다음 번호는 4
        forget_head(&dir);
        assert_eq!(record_in(&root, &chain, &pay("cash", 1000, None), &none, NOW + 3).unwrap()["seq"], 4);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            for (_, p) in month_files(&dir) {
                assert_eq!(std::fs::metadata(p).unwrap().permissions().mode() & 0o777, 0o600);
            }
        }
    }

    #[test]
    fn deleting_or_editing_a_line_is_detected_and_numbers_are_not_reused() {
        let (root, chain) = fresh("tamper");
        for i in 0..4 {
            record_in(&root, &chain, &pay("cash", 1000 + i, None), &none, NOW + i).unwrap();
        }
        let dir = log_dir(&root, &chain);
        let (_, file) = month_files(&dir).pop().unwrap();
        let text = std::fs::read_to_string(&file).unwrap();
        let lines: Vec<&str> = text.lines().collect();

        // 가운데 줄 금액 고치기 → 다음 줄의 prev 가 안 맞는다
        let mut edited: Vec<String> = lines.iter().map(|s| s.to_string()).collect();
        edited[2] = edited[2].replace("\"amount\":1001", "\"amount\":9");
        std::fs::write(&file, edited.join("\n") + "\n").unwrap();
        forget_head(&dir);
        assert_eq!(day_in(&root, &chain, 0, i64::MAX)["check"]["why"], "prev");

        // 가운데 줄 지우기 → 번호가 건너뛴다
        let mut cut: Vec<&str> = lines.clone();
        cut.remove(2);
        std::fs::write(&file, cut.join("\n") + "\n").unwrap();
        forget_head(&dir);
        assert_eq!(day_in(&root, &chain, 0, i64::MAX)["check"]["why"], "seq");

        // 마지막 줄 지우기 → head.json 과 다르다. 번호는 다시 쓰지 않는다(5 다음).
        std::fs::write(&file, lines[..4].join("\n") + "\n").unwrap();
        forget_head(&dir);
        let d = day_in(&root, &chain, 0, i64::MAX);
        assert_eq!(d["check"]["why"], "head");
        assert_eq!(record_in(&root, &chain, &pay("cash", 500, None), &none, NOW + 9).unwrap()["seq"], 5, "4번은 지워졌어도 다시 쓰지 않는다");

        // 쓰다 만 꼬리는 버리고 그대로 잇는다(고장 아님)
        let (root, chain) = fresh("torn");
        record_in(&root, &chain, &pay("cash", 100, None), &none, NOW).unwrap();
        let dir = log_dir(&root, &chain);
        let (_, file) = month_files(&dir).pop().unwrap();
        std::fs::OpenOptions::new().append(true).open(&file).unwrap().write_all(b"{\"v\":1,\"kind\":\"sa").unwrap();
        forget_head(&dir);
        assert_eq!(record_in(&root, &chain, &pay("cash", 200, None), &none, NOW + 1).unwrap()["seq"], 2);
        assert_eq!(day_in(&root, &chain, 0, i64::MAX)["check"]["ok"], true);
        assert!(verify_records(&all_lines(&dir), None).broken.is_none());
    }

    #[test]
    fn void_is_a_new_line_and_only_once() {
        let (root, chain) = fresh("void");
        let s = record_in(&root, &chain, &pay("card", 30000, Some("88776655")), &none, NOW).unwrap();
        record_in(&root, &chain, &pay("cash", 5000, None), &none, NOW + 1).unwrap();
        let seq = s["seq"].as_u64().unwrap();
        let v = void_in(&root, &chain, seq, Some("손님 변심"), NOW + 2).unwrap();
        assert_eq!((v["kind"].as_str(), v["ref"].as_u64(), v["amount"].as_i64(), v["method"].as_str()), (Some("void"), Some(seq), Some(-30000), Some("card")));
        assert_eq!(void_in(&root, &chain, seq, None, NOW + 3).unwrap_err(), ERR_ALREADY_VOID);
        assert_eq!(void_in(&root, &chain, v["seq"].as_u64().unwrap(), None, NOW + 3).unwrap_err(), ERR_NO_SALE, "취소 줄은 취소 못 한다");
        assert_eq!(void_in(&root, &chain, 99, None, NOW).unwrap_err(), ERR_NO_SALE);
        let d = day_in(&root, &chain, NOW - 1000, NOW + 1000);
        assert_eq!(d["net"], 5000);
        assert_eq!(d["totals"]["card"], 0);
        assert_eq!(d["totals"]["cash"], 5000);
        assert_eq!(d["count"], 2);
        let rows = d["rows"].as_array().unwrap();
        assert_eq!(rows.len(), 3);
        assert!(rows.iter().any(|r| r["seq"] == seq && r["voided"] == true));
        // 원래 줄은 그대로 남아 있다
        let lines = all_lines(&log_dir(&root, &chain));
        assert_eq!(lines.iter().find(|l| l["seq"] == seq).unwrap()["amount"], 30000);
        assert!(verify_records(&lines, None).broken.is_none());
        // 바깥 구간은 안 센다
        assert_eq!(day_in(&root, &chain, NOW + 10_000, NOW + 20_000)["count"], 0);
    }

    #[test]
    fn inputs_are_checked_and_nothing_is_written_on_error() {
        let (root, chain) = fresh("inputs");
        assert_eq!(record_in(&root, &chain, &pay("bank", 1000, None), &none, NOW).unwrap_err(), ERR_METHOD);
        assert_eq!(record_in(&root, &chain, &pay("cash", 0, None), &none, NOW).unwrap_err(), ERR_AMOUNT);
        assert_eq!(record_in(&root, &chain, &pay("cash", MAX_AMOUNT + 1, None), &none, NOW).unwrap_err(), ERR_AMOUNT);
        assert_eq!(record_in(&root, &chain, &pay("card", 1000, None), &none, NOW).unwrap_err(), ERR_CARD_NO);
        assert_eq!(record_in(&root, &chain, &pay("card", 1000, Some("12<>")), &none, NOW).unwrap_err(), ERR_CARD_NO);
        assert_eq!(record_in(&root, &chain, &pay("cash_receipt", 1000, None), &none, NOW).unwrap_err(), ERR_CASH_RECEIPT_NO);
        assert_eq!(record_in(&root, &chain, &pay("rvn", 1000, Some("abc")), &none, NOW).unwrap_err(), ERR_TXID);
        let mut p = pay("other", 1000, None);
        p.memo = Some("가".repeat(41));
        assert_eq!(record_in(&root, &chain, &p, &none, NOW).unwrap_err(), ERR_MEMO);
        p.memo = None;
        p.order = Some("../x".into());
        assert_eq!(record_in(&root, &chain, &p, &none, NOW).unwrap_err(), ERR_ORDER);
        assert!(month_files(&log_dir(&root, &chain)).is_empty(), "틀린 입력은 한 줄도 쓰지 않는다");
    }

    #[test]
    fn rvn_order_takes_the_frozen_krw_from_the_ledger_and_cannot_be_recorded_twice() {
        let (root, chain) = fresh("rvn");
        let tx = "ab".repeat(32);
        let tx2 = tx.clone();
        let look = move |o: &str| (o == "RAddr1").then(|| (4500i64, tx2.clone(), "1368.5".to_string()));
        let mut p = pay("rvn", 999_999, None);
        p.order = Some("RAddr1".into());
        let r = record_in(&root, &chain, &p, &look, NOW).unwrap();
        assert_eq!((r["amount"].as_i64(), r["txid"].as_str(), r["rvn"].as_str(), r["krwFrom"].as_str()), (Some(4500), Some(tx.as_str()), Some("1368.5"), Some("order")));
        assert_eq!(record_in(&root, &chain, &p, &look, NOW + 1).unwrap_err(), ERR_ORDER_DONE);
        // 취소하면 다시 적을 수 있다
        void_in(&root, &chain, r["seq"].as_u64().unwrap(), None, NOW + 2).unwrap();
        assert!(record_in(&root, &chain, &p, &look, NOW + 3).is_ok());
        // 장부에 없는 주문이면 직원이 txid·금액을 적는다
        let mut q = pay("rvn", 7000, Some(&"CD".repeat(32)));
        q.order = Some("RAddr2".into());
        let r2 = record_in(&root, &chain, &q, &look, NOW + 4).unwrap();
        assert_eq!((r2["amount"].as_i64(), r2["krwFrom"].as_str(), r2["txid"].as_str()), (Some(7000), Some("staff"), Some("cd".repeat(32).as_str())));
        // 다시 읽어도 주문 중복 막기가 살아 있다
        forget_head(&log_dir(&root, &chain));
        assert_eq!(record_in(&root, &chain, &q, &look, NOW + 5).unwrap_err(), ERR_ORDER_DONE);
    }

    #[test]
    fn works_offline_with_no_network_code() {
        // 이 파일에는 네트워크 호출이 없어야 한다(카드 승인·발급은 VAN·PG 몫, 우리는 번호만 적는다).
        let src = include_str!("pos_pay.rs");
        let body = &src[..src.find("#[cfg(test)]").unwrap()];
        for bad in ["reqwest", "nostr_publish", "TcpStream", "http://", "https://", "rvn_rate", "quote_price", "electrum"] {
            assert!(!body.contains(bad), "{bad} 가 있다");
        }
        let (root, chain) = fresh("offline");
        assert!(record_in(&root, &chain, &pay("cash", 3000, None), &none, NOW).is_ok());
    }

    #[test]
    fn shop_biz_settings_are_copied_into_records() {
        let (root, chain) = fresh("biz");
        assert!(biz_save_in(&root, &chain, "12345", None).is_err());
        biz_save_in(&root, &chain, "123-45-67890", Some("")).unwrap();
        let r = record_in(&root, &chain, &pay("cash", 1000, None), &none, NOW).unwrap();
        assert_eq!(r["biz"], json!({ "no": "1234567890" }));
        assert!(r["store"].is_null() && r.get("sig").is_none());
        assert_eq!(status_in(&root, &chain)["chain"], false);
    }

    #[test]
    fn chain_store_records_are_signed_with_the_store_key() {
        let (root, chain, store_pub) = join_store("signed", 7);
        let ctx = ctx_in(&root, &chain);
        assert!(ctx.scope.starts_with("chain-") && ctx.scope.ends_with("-7"));
        let r = record_in(&root, &chain, &pay("card", 15000, Some("11223344")), &none, NOW).unwrap();
        assert_eq!(r["store"], 7);
        assert_eq!(r["biz"], json!({ "no": "1234567890", "sub": "0002" }));
        assert_eq!(r["key"].as_str(), Some(store_pub.as_str()));
        assert!(signed_by(SALE_DOMAIN, r.as_object().unwrap(), &store_pub));
        void_in(&root, &chain, r["seq"].as_u64().unwrap(), None, NOW + 1).unwrap();
        let dir = log_dir(&root, &chain);
        let lines = all_lines(&dir);
        assert!(lines.iter().all(|l| l["key"] == store_pub && l.get("sig").is_some()));
        assert!(verify_records(&lines, Some(&store_pub)).broken.is_none());
        // 다른 열쇠를 기대하면 틀림
        let other = crate::storesign::pubkey_hex(&crate::identity::chain_store_key_from(WORDS, "", 8, 0).unwrap()).unwrap();
        assert_eq!(verify_records(&lines, Some(&other)).broken.map(|b| b.1), Some(Break::Signature));
        // 서명을 떼고 고친 줄(마지막 줄이라 prev 로는 안 걸린다) → 서명 끊김
        let mut forged = lines.clone();
        forged.last_mut().unwrap()["amount"] = json!(-1);
        assert_eq!(verify_records(&forged, None).broken.map(|b| b.1), Some(Break::Signature));
        let last = forged.last_mut().unwrap().as_object_mut().unwrap();
        last.shift_remove("sig");
        last.shift_remove("key");
        assert_eq!(verify_records(&forged, None).broken.map(|b| b.1), Some(Break::Signature), "체인 로그에서 서명 없는 줄은 받지 않는다");
        // 비밀 열쇠는 로그에 없다
        let ssk = crate::identity::chain_store_key_from(WORDS, "", 7, 0).unwrap();
        for (_, p) in month_files(&dir) {
            assert!(!std::fs::read_to_string(p).unwrap().contains(&hex::encode(ssk)));
        }
        // 매장 열쇠로 증서·끊기 목록 도메인에는 서명하지 않는다
        assert!(crate::chain_store::sign_as_store_in(&chain, crate::chain_store::CHAIN_DOMAIN, &json!({"x":1})).is_err());
        // 체인 매장은 사업자 번호를 바꾸지 못한다
        assert_eq!(biz_save_in(&root, &chain, "9999999999", None).unwrap_err(), ERR_CHAIN_BIZ);
    }
}
