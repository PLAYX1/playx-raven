//! 오락실 게임 보관 — 두 가지. (2026-11-13 대표 방향: 플랫폼이 남의 게임 창고가 되지 않는다)
//!
//! ## ① 「내 게임 보관」(판매자 쪽 · 늘 켜짐)
//!
//! 게임은 **판매자 자신의 레이븐볼트**에 산다. 올릴 때(`arcade_upload::arcade_pin_folder` · `ipfs_add_file`) 이미 붙잡지만,
//! 붙잡은 것이 계속 붙잡혀 있는지·바깥에 알려지는지는 아무도 보지 않았다. 그래서 앱이 켜져 있는 동안 30분마다:
//!
//! 1. 내 지갑의 `RVLT/*` 자산(주인 표 `…!` 포함 → 이름에서 `!` 를 뗀다) ∩ 체인 목록 → 내 게임의 문서 CID.
//! 2. 문서 CID 가 붙잡혀 있나(`pin/ls`) — 아니면 붙잡는다(`pin/add`, 재귀). 사람이 자산 화면에서 「보관 안 하기」로 정한 주소는 건드리지 않는다.
//! 3. 문서를 읽어 게임 폴더 CID(`cid`)를 알아내고, 폴더도 같은 방법으로 붙잡혀 있게 한다.
//! 4. 둘 다 바깥에 알린다(`routing/provide`) — 공개 게이트웨이(ipfs.io·dweb.link)가 이 컴퓨터를 찾을 수 있게.
//!    폴더 안 파일까지(재귀)는 앱이 켜진 뒤 한 번, 그 뒤로는 뿌리만(파일창고가 22시간마다 전부 다시 알린다).
//!
//! 붙잡은 것(pin)은 파일창고를 다시 켜도·청소(GC)를 돌려도 남는다. 그러나 **이 컴퓨터가 꺼져 있으면 손님이 게임을 못 한다** —
//! 화면이 그 말을 숨기지 않는다.
//!
//! ## ② 「다른 판매자 게임 함께 보관하기 (돕기)」(누구나 · 기본 꺼짐)
//!
//! 🔴 **어느 모드에서도 알아서 켜지 않는다**(돕기·릴레이 컴퓨터 포함). 사람이 방식과 용량을 고른다:
//!    꺼짐(기본) · 「이 가게만 보관」(확인 가게 이름 `PLAYX` 또는 판매자 주소 `R…`, 최대 50곳) · 전부(확인 판매자 먼저).
//!    지갑 열쇠는 쓰지 않는다 — 서명을 확인하고 붙잡기만 한다.
//! 켜면 30분마다 화면(TS)이 구매 화면과 **같은 확인**(서명 · 「문서의 assetName = 그 자산」, `arcade-model productsFromSources`)을
//! 거친 문서 CID 를 넘기고, 여기는:
//!
//! - 그 문서가 **방금 이 코드가 읽은 체인 목록**에서 그 자산이 가리키는 것인지 다시 본다(화면 말만 믿고 아무 CID 나 붙잡지 않는다).
//! - 문서 바이트도 여기서 받은 것으로 다시 읽어 폴더 CID·assetName·파일 크기 합을 꺼낸다.
//! - 확인 판매자 게임 먼저 → 그다음 나머지(이름 순). 한 게임 상한(올리기 규칙 200MB + 여유) · 고른 용량 · 최대 개수.
//! - **이 기능이 붙잡은 것만 적어 두고(`arcade-share.json`) 그것만 푼다.** 원래 붙잡혀 있던 것(내 게임·내가 보관하기로 한 파일)은 적어도
//!   `pre` 표시가 붙어 절대 풀지 않는다. 자산이 더는 그 문서를 가리키지 않으면 푼다. 끄면 전부 푼다.
//! - 목록을 못 읽은 바퀴에서는 아무것도 풀지 않는다(잠깐의 실패로 지운 뒤 다시 받는 일이 없게).
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

use crate::arcade::{cid_ok, product_like};

const API: &str = "http://127.0.0.1:5001/api/v0";
const SHARE_FILE: &str = "arcade-share.json";
/// 한 게임 상한 = 올리기 규칙(core ARCADE_LIMITS · arcade_upload::MAX_TOTAL) + IPFS 겉포장 여유.
pub const PER_GAME_MAX: u64 = crate::arcade_upload::MAX_TOTAL + 16 * 1024 * 1024;
/// 고를 수 있는 용량(MB). 기본 1GB.
pub const BUDGET_CHOICES_MB: [u64; 5] = [256, 512, 1024, 2048, 5120];
pub const DEFAULT_BUDGET_MB: u64 = 1024;
/// 함께 보관하는 게임 수 상한.
pub const MAX_SHARED: usize = 200;
/// 화면이 받아 볼 문서 수(돕기 바퀴).
const SHARE_DOCS_MAX: usize = 200;
/// 「목록 읽기」와 「붙잡기」 사이에 쓸 수 있는 시간.
const CACHE_SECS: i64 = 15 * 60;
const MINE_EVERY_SECS: u64 = 30 * 60;
const MINE_FIRST_SECS: u64 = 120;

fn now() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0)
}

/* ── 문서에서 꺼내는 것 ─────────────────────────────────────────────── */

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct DocFacts {
    pub asset_name: Option<String>,
    pub folder: String,
    pub declared: u64,
    pub title: String,
    pub seller: String,
}

/// 상품 문서 바이트 → 폴더 CID · assetName · 파일 크기 합. 서명은 여기서 보지 않는다(돕기는 화면이 본다, 내 게임은 내 자산).
pub(crate) fn doc_facts(bytes: &[u8]) -> Option<DocFacts> {
    let v: Value = serde_json::from_slice(bytes).ok()?;
    if v.get("format")?.as_str()? != "rv-arcade-product" {
        return None;
    }
    let folder = v.get("cid")?.as_str()?.to_string();
    if !cid_ok(&folder) {
        return None;
    }
    let files = v.get("files")?.as_array()?;
    if files.is_empty() || files.len() > crate::arcade_upload::MAX_FILES {
        return None;
    }
    let mut declared: u64 = 0;
    for f in files {
        declared = declared.checked_add(f.get("size")?.as_u64()?)?;
    }
    Some(DocFacts {
        asset_name: v.get("assetName").and_then(Value::as_str).map(str::to_string),
        folder,
        declared,
        title: v.get("title").and_then(Value::as_str).unwrap_or("").chars().take(80).collect(),
        seller: v.get("seller").and_then(Value::as_str).unwrap_or("").chars().take(40).collect(),
    })
}

/// 일반 판매자 문서의 key(「<seller>/<id>」) — assetName 이 없는 문서에서만.
pub(crate) fn open_key_of(bytes: &[u8]) -> Option<String> {
    let v: Value = serde_json::from_slice(bytes).ok()?;
    if v.get("assetName").is_some() { return None; }
    Some(format!("{}/{}", v.get("seller")?.as_str()?, v.get("id")?.as_str()?))
}

/* ── kubo ───────────────────────────────────────────────────────────── */

async fn api(path: &str, secs: u64) -> Option<reqwest::Response> {
    let r = reqwest::Client::new().post(format!("{API}/{path}")).timeout(std::time::Duration::from_secs(secs)).send().await.ok()?;
    r.status().is_success().then_some(r)
}
async fn is_pinned(cid: &str) -> bool {
    api(&format!("pin/ls?arg={cid}&type=recursive"), 20).await.is_some()
}
async fn pin(cid: &str) -> bool {
    api(&format!("pin/add?arg={cid}&recursive=true"), 900).await.is_some()
}
async fn unpin(cid: &str) -> bool {
    api(&format!("pin/rm?arg={cid}"), 60).await.is_some()
}
/// 바깥에 알린다. 새 kubo 는 `routing/provide`, 옛 kubo 는 `dht/provide`. 실패는 조용히 — 파일창고가 22시간마다 다시 알린다.
async fn provide(cid: &str, recursive: bool) -> bool {
    let q = format!("arg={cid}&recursive={recursive}");
    api(&format!("routing/provide?{q}"), 120).await.is_some() || api(&format!("dht/provide?{q}"), 120).await.is_some()
}
/// 폴더의 실제 크기(뿌리 블록만 받으면 안다). 못 재면 None.
async fn cumulative(cid: &str) -> Option<u64> {
    let v: Value = api(&format!("files/stat?arg=/ipfs/{cid}"), 60).await?.json().await.ok()?;
    v.get("CumulativeSize").and_then(Value::as_u64)
}

/* ── ① 내 게임 보관 ─────────────────────────────────────────────────── */

/// 내 지갑 자산 이름 → 내 게임(상품) 이름. 주인 표 `RVLT/X/Y!` 는 `RVLT/X/Y` 로.
pub(crate) fn my_game_names(owned: &[String]) -> HashSet<String> {
    owned.iter().map(|n| n.trim_end_matches('!').to_string()).filter(|n| product_like(n)).collect()
}

static MINE: Mutex<Option<Value>> = Mutex::new(None);
static MINE_BUSY: AtomicBool = AtomicBool::new(false);
static PROVIDED_DEEP: Mutex<Option<HashSet<String>>> = Mutex::new(None);

async fn ensure_kept(cid: &str, skip: bool) -> bool {
    if is_pinned(cid).await {
        return true;
    }
    !skip && pin(cid).await
}

async fn mine_round_inner() -> Result<Value, String> {
    let owned_raw = crate::raven::call_rpc("listmyassets", json!(["RVLT/*"])).await?;
    let owned: Vec<String> = owned_raw.as_object().map(|m| m.keys().cloned().collect()).unwrap_or_default();
    let names = my_game_names(&owned);
    let (list, _) = crate::arcade::chain_list().await?;
    let prefs = crate::asset_keep::load();
    let mut games = Vec::new();
    let (mut kept, mut bytes) = (0usize, 0u64);
    for (name, hash) in list.iter().filter(|(n, _)| names.contains(n)) {
        let Some(doc) = hash.clone() else {
            games.push(json!({ "asset": name, "problem": "no-doc" }));
            continue;
        };
        let doc_kept = ensure_kept(&doc, prefs.is_skipped(&doc)).await;
        let facts = crate::arcade::fetch_doc(&doc).await.as_deref().and_then(doc_facts);
        let Some(f) = facts else {
            games.push(json!({ "asset": name, "docCid": doc, "docKept": doc_kept, "problem": "doc-unreadable" }));
            continue;
        };
        let folder_kept = ensure_kept(&f.folder, prefs.is_skipped(&f.folder)).await;
        if doc_kept && folder_kept {
            provide(&doc, false).await;
            let deep = PROVIDED_DEEP.lock().ok().map(|mut g| g.get_or_insert_with(HashSet::new).insert(f.folder.clone())).unwrap_or(false);
            provide(&f.folder, deep).await;
            kept += 1;
            bytes += f.declared;
        }
        games.push(json!({
            "asset": name, "title": f.title, "docCid": doc, "folderCid": f.folder, "bytes": f.declared,
            "docKept": doc_kept, "folderKept": folder_kept,
            "problem": if doc_kept && folder_kept { Value::Null } else { json!("not-kept") },
        }));
    }
    // 일반 판매자로 올린 내 게임(0 RVN · 체인 자산 없음) — 내 겉봉투 열쇠로 서명된 지금 쪽지가 가리키는 문서·폴더.
    if let Some(pk) = crate::arcade_listing::my_pubkey() {
        let events = crate::arcade_listing::read_listings().await;
        for (key, doc) in crate::arcade_listing::my_open_docs(&events, &pk) {
            let name = format!("open:{key}");
            let doc_kept = ensure_kept(&doc, prefs.is_skipped(&doc)).await;
            let Some(f) = crate::arcade::fetch_doc(&doc).await.as_deref().and_then(doc_facts) else {
                games.push(json!({ "asset": name, "docCid": doc, "docKept": doc_kept, "problem": "doc-unreadable" }));
                continue;
            };
            let folder_kept = ensure_kept(&f.folder, prefs.is_skipped(&f.folder)).await;
            if doc_kept && folder_kept {
                provide(&doc, false).await;
                let deep = PROVIDED_DEEP.lock().ok().map(|mut g| g.get_or_insert_with(HashSet::new).insert(f.folder.clone())).unwrap_or(false);
                provide(&f.folder, deep).await;
                kept += 1;
                bytes += f.declared;
            }
            games.push(json!({
                "asset": name, "listing": "open", "title": f.title, "docCid": doc, "folderCid": f.folder, "bytes": f.declared,
                "docKept": doc_kept, "folderKept": folder_kept,
                "problem": if doc_kept && folder_kept { Value::Null } else { json!("not-kept") },
            }));
        }
    }
    Ok(json!({ "at": now(), "games": games, "kept": kept, "bytes": bytes }))
}

/// 지금 한 바퀴(화면의 「지금 확인」·30분 박동). 겹치면 지난 결과를 돌려준다.
#[tauri::command]
pub async fn arcade_mine_round() -> Result<Value, String> {
    if MINE_BUSY.swap(true, Ordering::SeqCst) {
        return Ok(arcade_mine_state());
    }
    let r = mine_round_inner().await;
    MINE_BUSY.store(false, Ordering::SeqCst);
    let v = match r {
        Ok(v) => v,
        Err(e) => json!({ "at": now(), "error": e, "games": [], "kept": 0, "bytes": 0 }),
    };
    if let Ok(mut g) = MINE.lock() {
        *g = Some(v.clone());
    }
    Ok(v)
}

/// 마지막 바퀴 결과(아직 안 돌았으면 `{ at: null }`).
#[tauri::command]
pub fn arcade_mine_state() -> Value {
    MINE.lock().ok().and_then(|g| g.clone()).unwrap_or_else(|| json!({ "at": Value::Null, "games": [], "kept": 0, "bytes": 0 }))
}

/// 켤 때 한 번. 파일창고·노드가 올라올 시간을 주고, 그 뒤 30분마다.
pub fn start() {
    tauri::async_runtime::spawn(async {
        tokio::time::sleep(std::time::Duration::from_secs(MINE_FIRST_SECS)).await;
        loop {
            let _ = arcade_mine_round().await;
            tokio::time::sleep(std::time::Duration::from_secs(MINE_EVERY_SECS)).await;
        }
    });
}

/* ── ② 다른 판매자 게임 함께 보관하기 ──────────────────────────────── */

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Entry {
    pub asset: String,
    pub seller: String,
    pub folder: String,
    pub bytes: u64,
    /// 이 기능이 붙잡기 전부터 붙잡혀 있었다 — 절대 풀지 않는다.
    pub doc_pre: bool,
    pub folder_pre: bool,
}

/// 꺼짐(기본) · 고른 가게만 · 전부(확인 판매자 먼저).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Mode {
    Off,
    Shops,
    All,
}
impl Mode {
    fn as_str(self) -> &'static str {
        match self {
            Mode::Off => "off",
            Mode::Shops => "shops",
            Mode::All => "all",
        }
    }
    fn parse(s: &str) -> Option<Mode> {
        match s {
            "off" => Some(Mode::Off),
            "shops" => Some(Mode::Shops),
            "all" => Some(Mode::All),
            _ => None,
        }
    }
}
/// 고를 수 있는 가게 수.
pub const MAX_PICKS: usize = 50;

/// 「이 가게만 보관」 한 칸: 확인 가게 이름(`RVLT/<가게>` 의 <가게>, 대문자) 또는 판매자 주소(R…).
pub(crate) fn clean_pick(raw: &str) -> Option<String> {
    let t = raw.trim().trim_start_matches("RVLT/");
    if t.len() >= 26 && t.len() <= 35 && t.starts_with('R') && t.bytes().all(|b| b.is_ascii_alphanumeric()) {
        return Some(t.to_string());
    }
    let up = t.to_ascii_uppercase();
    (!up.is_empty() && up.len() <= 30 && up.bytes().all(|b| b.is_ascii_uppercase() || b.is_ascii_digit() || b == b'.' || b == b'_')).then_some(up)
}
/// 자산 이름 → 가게 이름(`RVLT/PLAYX#RUN` → `PLAYX`).
pub(crate) fn shop_of(asset: &str) -> String {
    // 일반 판매자 게임(「open:<판매자 주소>/<id>」)은 가게 이름이 없다 — 판매자 주소로 묶는다.
    if let Some(k) = asset.strip_prefix("open:") { return k.split('/').next().unwrap_or("").to_string(); }
    asset.trim_start_matches("RVLT/").split(['/', '#']).next().unwrap_or("").to_string()
}
/// 이 게임을 고른 가게 목록이 받아들이나.
pub(crate) fn picked(picks: &[String], asset: &str, seller: &str) -> bool {
    let shop = shop_of(asset);
    picks.iter().any(|p| *p == shop || (!seller.is_empty() && *p == seller))
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Share {
    pub mode: Mode,
    pub picks: Vec<String>,
    pub budget_mb: u64,
    pub games: BTreeMap<String, Entry>,
    pub last_at: Option<i64>,
    pub last_note: Option<String>,
}
impl Default for Share {
    fn default() -> Self {
        Share { mode: Mode::Off, picks: Vec::new(), budget_mb: DEFAULT_BUDGET_MB, games: BTreeMap::new(), last_at: None, last_note: None }
    }
}

pub(crate) fn parse_share(text: &str) -> Share {
    let Ok(v) = serde_json::from_str::<Value>(text) else { return Share::default() };
    let mut s = Share::default();
    s.mode = v.get("mode").and_then(Value::as_str).and_then(Mode::parse).unwrap_or(Mode::Off);
    s.picks = v.get("picks").and_then(Value::as_array).map(|a| {
        let mut out: Vec<String> = Vec::new();
        for p in a.iter().filter_map(Value::as_str).filter_map(clean_pick) {
            if !out.contains(&p) && out.len() < MAX_PICKS { out.push(p); }
        }
        out
    }).unwrap_or_default();
    s.budget_mb = v.get("budget_mb").and_then(Value::as_u64).filter(|b| BUDGET_CHOICES_MB.contains(b)).unwrap_or(DEFAULT_BUDGET_MB);
    s.last_at = v.get("last_at").and_then(Value::as_i64);
    s.last_note = v.get("last_note").and_then(Value::as_str).map(str::to_string);
    if let Some(m) = v.get("games").and_then(Value::as_object) {
        for (doc, e) in m {
            let (Some(asset), Some(folder)) = (e.get("asset").and_then(Value::as_str), e.get("folder").and_then(Value::as_str)) else { continue };
            if !cid_ok(doc) || !cid_ok(folder) {
                continue;
            }
            s.games.insert(doc.clone(), Entry {
                asset: asset.to_string(), folder: folder.to_string(),
                seller: e.get("seller").and_then(Value::as_str).unwrap_or("").to_string(),
                bytes: e.get("bytes").and_then(Value::as_u64).unwrap_or(0),
                // 모르면 「원래 있던 것」으로 — 남의 것을 잘못 푸는 쪽보다 덜 푸는 쪽이 안전하다.
                doc_pre: e.get("doc_pre").and_then(Value::as_bool).unwrap_or(true),
                folder_pre: e.get("folder_pre").and_then(Value::as_bool).unwrap_or(true),
            });
        }
    }
    s
}
fn render_share(s: &Share) -> Vec<u8> {
    let games: serde_json::Map<String, Value> = s.games.iter().map(|(d, e)| (d.clone(), json!({
        "asset": e.asset, "seller": e.seller, "folder": e.folder, "bytes": e.bytes, "doc_pre": e.doc_pre, "folder_pre": e.folder_pre,
    }))).collect();
    serde_json::to_vec_pretty(&json!({ "version": 1, "mode": s.mode.as_str(), "picks": s.picks, "budget_mb": s.budget_mb, "games": games, "last_at": s.last_at, "last_note": s.last_note })).unwrap_or_default()
}
fn share_path() -> std::path::PathBuf {
    crate::paths::app_file(SHARE_FILE)
}
pub(crate) fn load_share() -> Share {
    std::fs::read_to_string(share_path()).map(|t| parse_share(&t)).unwrap_or_default()
}
fn save_share(s: &Share) -> Result<(), String> {
    let p = share_path();
    if let Some(d) = p.parent() {
        let _ = std::fs::create_dir_all(d);
    }
    let tmp = p.with_extension("json.tmp");
    std::fs::write(&tmp, render_share(s)).and_then(|_| std::fs::rename(&tmp, &p)).map_err(|e| format!("설정을 저장하지 못했습니다: {e}"))
}

/// 붙잡을 후보 한 개(체인 닻 · 문서 사실 확인 끝).
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Cand {
    pub doc: String,
    pub asset: String,
    pub folder: String,
    pub seller: String,
    pub bytes: u64,
    /// 0 = 확인 판매자 · 1 = 그 밖의 공개 목록.
    pub tier: u8,
}

#[derive(Debug, Default, PartialEq)]
pub(crate) struct Plan {
    pub add: Vec<Cand>,
    pub drop: Vec<String>,
    pub skipped: Vec<(String, &'static str)>,
}

/// 무엇을 새로 붙잡고 무엇을 풀까 — 순수 함수.
/// `chain` = 방금 읽은 체인 목록(이름 → 문서 CID). 이미 지키는 것은 그 자산이 아직 그 문서를 가리키면 남긴다
/// (이번 바퀴에 문서를 못 받았어도 — 잠깐의 실패로 풀지 않는다). 남긴 것이 먼저 용량을 차지한다.
pub(crate) fn plan(cur: &BTreeMap<String, Entry>, chain: &HashMap<String, String>, cands: &[Cand], budget: u64, mine: &HashSet<String>, mode: Mode, picks: &[String]) -> Plan {
    let mut p = Plan::default();
    // 확인 판매자 = 체인 자산이 이 문서를 가리킨다 · 일반 판매자 = 화면이 서명을 본 지금 쪽지가 이 문서를 가리킨다(「open:<key>」 · 내리면 빠진다).
    let anchored = |doc: &str, asset: &str| (product_like(asset) || asset.starts_with("open:")) && chain.get(asset).map(String::as_str) == Some(doc);
    let wanted = |asset: &str, seller: &str| match mode {
        Mode::Off => false,
        Mode::All => true,
        Mode::Shops => picked(picks, asset, seller),
    };
    let (mut count, mut used) = (0usize, 0u64);
    for (doc, e) in cur {
        if anchored(doc, &e.asset) && !mine.contains(&e.asset) && wanted(&e.asset, &e.seller) {
            count += 1;
            used += e.bytes;
        } else {
            p.drop.push(doc.clone());
        }
    }
    let mut order: Vec<&Cand> = cands.iter().filter(|c| !cur.contains_key(&c.doc)).collect();
    order.sort_by(|a, b| a.tier.cmp(&b.tier).then(a.asset.cmp(&b.asset)).then(a.doc.cmp(&b.doc)));
    let mut seen = HashSet::new();
    for c in order {
        if !seen.insert(c.doc.clone()) {
            continue;
        }
        let why = if !wanted(&c.asset, &c.seller) {
            Some("not-picked")
        } else if mine.contains(&c.asset) {
            Some("mine")
        } else if !anchored(&c.doc, &c.asset) {
            Some("not-anchored")
        } else if c.bytes > PER_GAME_MAX {
            Some("too-large")
        } else if count >= MAX_SHARED {
            Some("count")
        } else if used + c.bytes > budget {
            Some("budget")
        } else {
            None
        };
        match why {
            Some(w) => p.skipped.push((c.asset.clone(), w)),
            None => {
                count += 1;
                used += c.bytes;
                p.add.push(c.clone());
            }
        }
    }
    p
}

/// 풀 때: 이 기능이 붙잡았고(pre 아님) 남은 게임이 같은 폴더를 쓰지 않는 것만.
pub(crate) fn unpin_targets(remaining: &BTreeMap<String, Entry>, dropped: &[(String, Entry)]) -> Vec<String> {
    let used: HashSet<&str> = remaining.values().map(|e| e.folder.as_str()).collect();
    let mut out = Vec::new();
    for (doc, e) in dropped {
        if !e.doc_pre && !out.contains(doc) {
            out.push(doc.clone());
        }
        if !e.folder_pre && !used.contains(e.folder.as_str()) && !out.contains(&e.folder) {
            out.push(e.folder.clone());
        }
    }
    out
}

static SHARE_BUSY: AtomicBool = AtomicBool::new(false);
type Cache = (i64, HashMap<String, String>, HashMap<String, Vec<u8>>);
static CACHE: Mutex<Option<Cache>> = Mutex::new(None);

/// 가게별 묶음(「PLAYX 게임 7개 보관 중 · 0.4 MB」) — 개수 많은 순 → 이름 순.
pub(crate) fn by_shop(games: &BTreeMap<String, Entry>) -> Vec<(String, usize, u64)> {
    let mut m: BTreeMap<String, (usize, u64)> = BTreeMap::new();
    for e in games.values() {
        let k = m.entry(shop_of(&e.asset)).or_default();
        k.0 += 1;
        k.1 += e.bytes;
    }
    let mut v: Vec<(String, usize, u64)> = m.into_iter().map(|(s, (n, b))| (s, n, b)).collect();
    v.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(&b.0)));
    v
}

fn share_view(s: &Share) -> Value {
    let bytes: u64 = s.games.values().map(|e| e.bytes).sum();
    json!({
        "mode": s.mode.as_str(), "picks": s.picks, "budgetMb": s.budget_mb, "choicesMb": BUDGET_CHOICES_MB,
        "games": s.games.len(), "bytes": bytes, "lastAt": s.last_at, "lastNote": s.last_note,
        "shops": by_shop(&s.games).into_iter().map(|(shop, n, b)| json!({ "shop": shop, "games": n, "bytes": b })).collect::<Vec<_>>(),
    })
}

#[tauri::command]
pub fn arcade_share_get() -> Value {
    share_view(&load_share())
}

/// 방식(off·shops·all)·고른 가게·용량. 끄면 이 기능이 붙잡은 것을 전부 푼다(원래 있던 것은 그대로).
/// 고른 가게에서 빠진 게임은 다음 바퀴에 푼다.
#[tauri::command]
pub async fn arcade_share_set(mode: Option<String>, picks: Option<Vec<String>>, budget_mb: Option<u64>) -> Result<Value, String> {
    let mut s = load_share();
    if let Some(m) = mode {
        s.mode = Mode::parse(&m).ok_or("고를 수 있는 방식이 아닙니다.")?;
    }
    if let Some(list) = picks {
        let mut out: Vec<String> = Vec::new();
        for raw in list.iter().take(MAX_PICKS * 2) {
            let p = clean_pick(raw).ok_or_else(|| format!("가게 이름이나 판매자 주소가 아닙니다: {}", raw.chars().take(40).collect::<String>()))?;
            if !out.contains(&p) && out.len() < MAX_PICKS { out.push(p); }
        }
        s.picks = out;
    }
    if let Some(b) = budget_mb {
        if !BUDGET_CHOICES_MB.contains(&b) {
            return Err("고를 수 있는 용량이 아닙니다.".into());
        }
        s.budget_mb = b;
    }
    if s.mode == Mode::Off && !s.games.is_empty() {
        let dropped: Vec<(String, Entry)> = std::mem::take(&mut s.games).into_iter().collect();
        for cid in unpin_targets(&BTreeMap::new(), &dropped) {
            let _ = unpin(&cid).await;
        }
    }
    save_share(&s)?;
    Ok(share_view(&s))
}

/// 돕기 바퀴 1단계 — 체인 목록과 문서(화면이 서명을 본다). 켜져 있을 때만. 받은 것은 15분 기억해 2단계가 다시 쓴다.
#[tauri::command]
pub async fn arcade_share_sources() -> Result<Value, String> {
    if load_share().mode == Mode::Off {
        return Err("꺼져 있습니다.".into());
    }
    let (list, source) = crate::arcade::chain_list().await?;
    let (docs, open) = futures_util::future::join(crate::arcade::docs_for(&list, SHARE_DOCS_MAX), crate::arcade::open_sources()).await;
    let chain: HashMap<String, String> = list.iter().filter_map(|(n, h)| h.clone().map(|h| (n.clone(), h))).collect();
    // 일반 판매자 문서 바이트도 같은 칸에(CID 열쇠) — 2단계는 화면이 서명을 확인한 것만 쓴다.
    let mut all: HashMap<String, Vec<u8>> = docs.iter().cloned().collect();
    if let Some(m) = open.get("docs").and_then(Value::as_object) {
        use base64::Engine as _;
        for (cid, b64) in m {
            if let Some(b) = b64.as_str().and_then(|t| base64::engine::general_purpose::STANDARD.decode(t).ok()) { all.entry(cid.clone()).or_insert(b); }
        }
    }
    if let Ok(mut g) = CACHE.lock() {
        *g = Some((now(), chain, all));
    }
    let mut out = crate::arcade::sources_json(&list, &docs, source);
    out["open"] = open;
    Ok(out)
}

/// 돕기 바퀴 2단계 — 화면이 확인한 문서 CID(`[{docCid, verified}]`)를 붙잡고, 더는 가리켜지지 않는 것을 푼다.
#[tauri::command]
pub async fn arcade_share_apply(checked: Vec<Value>) -> Result<Value, String> {
    if SHARE_BUSY.swap(true, Ordering::SeqCst) {
        return Ok(share_view(&load_share()));
    }
    let r = share_apply_inner(checked).await;
    SHARE_BUSY.store(false, Ordering::SeqCst);
    r
}

async fn share_apply_inner(checked: Vec<Value>) -> Result<Value, String> {
    let mut s = load_share();
    if s.mode == Mode::Off {
        return Ok(share_view(&s));
    }
    let (at, mut chain, docs) = CACHE.lock().ok().and_then(|g| g.clone()).ok_or("먼저 목록을 읽어야 합니다.")?;
    if now() - at > CACHE_SECS {
        return Err("목록이 오래되었습니다. 다시 읽어 주세요.".into());
    }
    let by_doc: HashMap<&str, Vec<&str>> = chain.iter().fold(HashMap::new(), |mut m, (n, d)| { m.entry(d.as_str()).or_default().push(n.as_str()); m });
    let mut cands = Vec::new();
    let mut open_anchor: Vec<(String, String)> = Vec::new();
    for c in checked.iter().take(SHARE_DOCS_MAX) {
        let Some(doc) = c.get("docCid").and_then(Value::as_str) else { continue };
        let tier = if c.get("verified").and_then(Value::as_bool) == Some(true) { 0 } else { 1 };
        let Some(f) = docs.get(doc).and_then(|b| doc_facts(b)) else { continue };
        // 일반 판매자(mergeArcadeSources 의 verified=false · listing=open): 화면이 두 서명·docHash·CID 를 본 쪽지의 key 로 묶는다.
        // 문서 스스로의 seller/id 가 그 key 와 같아야 하고, assetName 이 있으면 안 된다. 앵커 = 이번 바퀴의 쪽지(다음 바퀴에 없으면 푼다).
        if c.get("listing").and_then(Value::as_str) == Some("open") {
            let Some(key) = c.get("key").and_then(Value::as_str) else { continue };
            if f.asset_name.is_some() || tier != 1 || open_key_of(docs.get(doc).map(Vec::as_slice).unwrap_or(&[])).as_deref() != Some(key) { continue; }
            let asset = format!("open:{key}");
            open_anchor.push((asset.clone(), doc.to_string()));
            let bytes = f.declared + docs.get(doc).map(|b| b.len() as u64).unwrap_or(0);
            cands.push(Cand { doc: doc.to_string(), asset, folder: f.folder, seller: f.seller, bytes, tier });
            continue;
        }
        let Some(asset) = f.asset_name.clone() else { continue };
        // 문서가 스스로 말하는 자산이 체인에서 정말 이 문서를 가리켜야 한다.
        if !by_doc.get(doc).is_some_and(|ns| ns.contains(&asset.as_str())) {
            continue;
        }
        let bytes = f.declared + docs.get(doc).map(|b| b.len() as u64).unwrap_or(0);
        cands.push(Cand { doc: doc.to_string(), asset, folder: f.folder, seller: f.seller, bytes, tier });
    }
    chain.extend(open_anchor);
    // 내 게임은 「내 게임 보관」이 맡는다.
    let mut mine = crate::raven::call_rpc("listmyassets", json!(["RVLT/*"])).await.ok()
        .and_then(|v| v.as_object().map(|m| my_game_names(&m.keys().cloned().collect::<Vec<_>>()))).unwrap_or_default();
    // 내가 일반 판매자로 올린 게임도 「내 게임 보관」이 맡는다(판매자 주소 = 이 지갑이 쓰는 판매 주소는 TS 만 알아서, 겉봉투 열쇠로 가린다).
    if let Some(pk) = crate::arcade_listing::my_pubkey() {
        let mine_open: HashSet<String> = crate::arcade_listing::my_open_docs(&crate::arcade_listing::read_listings().await, &pk).into_iter().map(|(k, _)| format!("open:{k}")).collect();
        mine.extend(mine_open);
    }
    // 실제 크기가 적힌 것보다 크면 그 값으로(겉포장 포함).
    for c in cands.iter_mut().filter(|c| !s.games.contains_key(&c.doc)) {
        if let Some(real) = cumulative(&c.folder).await {
            c.bytes = c.bytes.max(real);
        }
    }
    let p = plan(&s.games, &chain, &cands, s.budget_mb * 1024 * 1024, &mine, s.mode, &s.picks);
    let dropped: Vec<(String, Entry)> = p.drop.iter().filter_map(|d| s.games.remove(d).map(|e| (d.clone(), e))).collect();
    let keep_prefs = crate::asset_keep::load();
    for cid in unpin_targets(&s.games, &dropped) {
        if keep_prefs.decision(&cid) == Some(crate::asset_keep::Decision::Keep) {
            continue;
        }
        let _ = unpin(&cid).await;
    }
    let mut added = 0usize;
    let mut failed = 0usize;
    for c in &p.add {
        let doc_pre = is_pinned(&c.doc).await;
        if !doc_pre && !pin(&c.doc).await {
            failed += 1;
            continue;
        }
        let folder_pre = is_pinned(&c.folder).await || s.games.values().any(|e| e.folder == c.folder);
        if !folder_pre && !pin(&c.folder).await {
            if !doc_pre {
                let _ = unpin(&c.doc).await;
            }
            failed += 1;
            continue;
        }
        provide(&c.doc, false).await;
        provide(&c.folder, true).await;
        s.games.insert(c.doc.clone(), Entry { asset: c.asset.clone(), seller: c.seller.clone(), folder: c.folder.clone(), bytes: c.bytes, doc_pre, folder_pre });
        added += 1;
        save_share(&s)?; // 큰 게임 사이에 앱이 꺼져도 붙잡은 것이 적혀 있게.
    }
    s.last_at = Some(now());
    s.last_note = Some(format!("added={added} removed={} skipped={} failed={failed}", dropped.len(), p.skipped.len()));
    save_share(&s)?;
    let mut v = share_view(&s);
    v["added"] = json!(added);
    v["removed"] = json!(dropped.len());
    v["failed"] = json!(failed);
    v["skipped"] = json!(p.skipped.iter().map(|(a, w)| json!({ "asset": a, "why": w })).collect::<Vec<_>>());
    Ok(v)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn q(n: u8) -> String {
        format!("Qm{}", (n as char).to_string().repeat(44))
    }
    fn e(asset: &str, folder: &str, bytes: u64) -> Entry {
        Entry { asset: asset.into(), seller: String::new(), folder: folder.into(), bytes, doc_pre: false, folder_pre: false }
    }
    fn c(doc: &str, asset: &str, folder: &str, bytes: u64, tier: u8) -> Cand {
        Cand { doc: doc.into(), asset: asset.into(), folder: folder.into(), seller: String::new(), bytes, tier }
    }
    fn all(cur: &BTreeMap<String, Entry>, chain: &HashMap<String, String>, cands: &[Cand], budget: u64, mine: &HashSet<String>) -> Plan {
        plan(cur, chain, cands, budget, mine, Mode::All, &[])
    }
    const MB: u64 = 1024 * 1024;

    #[test]
    fn 문서에서_폴더와_크기를_꺼낸다() {
        let doc = format!(r#"{{"format":"rv-arcade-product","cid":"{}","assetName":"RVLT/A#B","title":"Run","files":[{{"path":"index.html","size":10}},{{"path":"a.js","size":5}}]}}"#, q(b'W'));
        let f = doc_facts(doc.as_bytes()).unwrap();
        assert_eq!((f.folder, f.declared, f.asset_name.as_deref(), f.title.as_str()), (q(b'W'), 15, Some("RVLT/A#B"), "Run"));
        assert!(doc_facts(b"nope").is_none());
        assert!(doc_facts(br#"{"format":"other","cid":"x","files":[]}"#).is_none());
        let bad_cid = r#"{"format":"rv-arcade-product","cid":"../../x","files":[{"size":1}]}"#;
        assert!(doc_facts(bad_cid.as_bytes()).is_none(), "경로 같은 CID 는 받지 않는다");
        let no_files = format!(r#"{{"format":"rv-arcade-product","cid":"{}","files":[]}}"#, q(b'W'));
        assert!(doc_facts(no_files.as_bytes()).is_none());
    }

    #[test]
    fn 내_게임은_주인_표에서도_찾는다() {
        let got = my_game_names(&["RVLT/PLAYX!".into(), "RVLT/PLAYX#RUN!".into(), "RVLT/PLAYX/JUMP".into(), "OTHER".into()]);
        assert_eq!(got, ["RVLT/PLAYX#RUN", "RVLT/PLAYX/JUMP"].iter().map(|s| s.to_string()).collect());
    }

    /// 🔴 돕기는 누구에게나 기본 꺼짐 — 모드·릴레이로 알아서 켜지지 않는다.
    #[test]
    fn 돕기는_기본_꺼짐이고_모드를_보지_않는다() {
        assert_eq!(Share::default().mode, Mode::Off);
        assert_eq!(parse_share("{}").mode, Mode::Off);
        assert_eq!(parse_share("not json").mode, Mode::Off);
        assert_eq!(parse_share(r#"{"mode":"everything"}"#).mode, Mode::Off, "모르는 값은 꺼짐");
        assert!(all(&BTreeMap::new(), &HashMap::new(), &[], 1, &HashSet::new()).add.is_empty());
        assert_eq!(parse_share(r#"{"budget_mb":7}"#).budget_mb, DEFAULT_BUDGET_MB, "고를 수 없는 용량은 기본값");
        let src = include_str!("arcade_keep.rs");
        let body = &src[..src.find("#[cfg(test)]").unwrap()];
        for word in ["mode_get", "autostart", "relay_share", "talk_push", "taile277f6"] {
            assert!(!body.contains(word), "{word} 를 보고 켜면 안 된다(특정 컴퓨터용 코드 없음)");
        }
    }

    #[test]
    fn 저장과_읽기_모르면_원래_있던_것으로() {
        let mut s = Share { mode: Mode::Shops, picks: vec!["PLAYX".into()], budget_mb: 512, ..Share::default() };
        s.games.insert(q(b'D'), e("RVLT/A#B", &q(b'F'), 9));
        let back = parse_share(std::str::from_utf8(&render_share(&s)).unwrap());
        assert_eq!(back.games, s.games);
        assert!(back.mode == Mode::Shops && back.budget_mb == 512 && back.picks == vec!["PLAYX".to_string()]);
        let old = format!(r#"{{"games":{{"{}":{{"asset":"RVLT/A#B","folder":"{}"}}}}}}"#, q(b'D'), q(b'F'));
        let g = parse_share(&old).games;
        assert!(g[&q(b'D')].doc_pre && g[&q(b'D')].folder_pre, "표시가 없으면 풀지 않는 쪽으로");
    }

    #[test]
    fn 확인_판매자_먼저_용량과_상한을_지킨다() {
        let chain: HashMap<String, String> = [("RVLT/A#X", q(b'a')), ("RVLT/B#X", q(b'b')), ("RVLT/C#X", q(b'c')), ("RVLT/D#X", q(b'd'))]
            .into_iter().map(|(n, d)| (n.to_string(), d)).collect();
        let cands = vec![
            c(&q(b'a'), "RVLT/A#X", &q(b'A'), 30 * MB, 1),
            c(&q(b'b'), "RVLT/B#X", &q(b'B'), 40 * MB, 0),
            c(&q(b'c'), "RVLT/C#X", &q(b'C'), 50 * MB, 0),
            c(&q(b'd'), "RVLT/D#X", &q(b'D'), 10 * MB, 1),
        ];
        let p = all(&BTreeMap::new(), &chain, &cands, 100 * MB, &HashSet::new());
        let added: Vec<&str> = p.add.iter().map(|c| c.asset.as_str()).collect();
        // 확인 판매자 B(40)·C(50)가 먼저 → 90. 그다음 A(30)는 넘쳐서 빠지고 D(10)는 들어간다.
        assert_eq!(added, vec!["RVLT/B#X", "RVLT/C#X", "RVLT/D#X"]);
        assert_eq!(p.skipped, vec![("RVLT/A#X".to_string(), "budget")]);
        // 한 게임 상한
        let big = vec![c(&q(b'a'), "RVLT/A#X", &q(b'A'), PER_GAME_MAX + 1, 0)];
        assert_eq!(all(&BTreeMap::new(), &chain, &big, 10_000 * MB, &HashSet::new()).skipped, vec![("RVLT/A#X".to_string(), "too-large")]);
    }

    /// 🔴 화면 말만 믿고 아무 CID 나 붙잡지 않는다 — 체인 자산이 그 문서를 가리켜야 한다. 내 게임은 건너뛴다.
    #[test]
    fn 체인이_가리키지_않으면_안_붙잡는다() {
        let chain: HashMap<String, String> = [("RVLT/A#X".to_string(), q(b'a'))].into_iter().collect();
        let cands = vec![c(&q(b'z'), "RVLT/A#X", &q(b'Z'), MB, 0), c(&q(b'a'), "RVLT/SHOP", &q(b'A'), MB, 0), c(&q(b'a'), "RVLT/A#X", &q(b'A'), MB, 0)];
        let mine: HashSet<String> = HashSet::new();
        let p = all(&BTreeMap::new(), &chain, &cands, 1024 * MB, &mine);
        assert_eq!(p.add.len(), 1);
        assert_eq!(p.add[0].doc, q(b'a'));
        let mine: HashSet<String> = ["RVLT/A#X".to_string()].into_iter().collect();
        let p = all(&BTreeMap::new(), &chain, &cands[2..], 1024 * MB, &mine);
        assert!(p.add.is_empty() && p.skipped == vec![("RVLT/A#X".to_string(), "mine")]);
    }

    /// 일반 판매자 게임(mergeArcadeSources verified=false): 확인 판매자 다음 차례 · 이번 바퀴 쪽지가 가리킬 때만 · 내리면(쪽지 없음) 푼다 · 내 게임은 건너뛴다.
    #[test]
    fn 일반_판매자_게임은_확인_판매자_다음_쪽지가_가리킬_때만() {
        let k = "open:RHMKPy3Ana5NyzTgo6qWXXMiHAxzPyMgG1/star-run";
        let chain: HashMap<String, String> = [("RVLT/B#X".to_string(), q(b'b')), (k.to_string(), q(b'o'))].into_iter().collect();
        let cands = vec![c(&q(b'o'), k, &q(b'O'), 60 * MB, 1), c(&q(b'b'), "RVLT/B#X", &q(b'B'), 60 * MB, 0)];
        let p = all(&BTreeMap::new(), &chain, &cands, 100 * MB, &HashSet::new());
        assert_eq!(p.add.iter().map(|c| c.asset.as_str()).collect::<Vec<_>>(), vec!["RVLT/B#X"], "확인 판매자 먼저 — 남는 자리가 없으면 일반 판매자는 빠진다");
        let p = all(&BTreeMap::new(), &chain, &cands[..1], 100 * MB, &HashSet::new());
        assert_eq!(p.add.len(), 1, "자리가 있으면 일반 판매자도 돕는다");
        // 쪽지가 다른 문서를 가리키거나 없으면 붙잡지 않는다
        let bad: HashMap<String, String> = [(k.to_string(), q(b'z'))].into_iter().collect();
        assert!(all(&BTreeMap::new(), &bad, &cands[..1], 100 * MB, &HashSet::new()).add.is_empty());
        // 내렸으면(이번 바퀴 쪽지 없음) 푼다
        let mut cur = BTreeMap::new();
        cur.insert(q(b'o'), e(k, &q(b'O'), MB));
        assert_eq!(all(&cur, &HashMap::new(), &[], 100 * MB, &HashSet::new()).drop, vec![q(b'o')]);
        // 내 일반 판매자 게임은 「내 게임 보관」이 맡는다
        let mine: HashSet<String> = [k.to_string()].into_iter().collect();
        assert!(all(&BTreeMap::new(), &chain, &cands[..1], 100 * MB, &mine).add.is_empty());
        assert_eq!(shop_of(k), "RHMKPy3Ana5NyzTgo6qWXXMiHAxzPyMgG1", "가게 이름 대신 판매자 주소로 묶는다");
        let doc = br#"{"format":"rv-arcade-product","seller":"RHMKPy3Ana5NyzTgo6qWXXMiHAxzPyMgG1","id":"star-run"}"#;
        assert_eq!(open_key_of(doc).as_deref(), Some("RHMKPy3Ana5NyzTgo6qWXXMiHAxzPyMgG1/star-run"));
        assert_eq!(open_key_of(br#"{"seller":"R","id":"x","assetName":"RVLT/A#X"}"#), None, "자산 문서는 일반 판매자 key 가 없다");
    }

    #[test]
    fn 자산이_다른_문서를_가리키면_풀고_잠깐_못_받은_것은_남긴다() {
        let mut cur = BTreeMap::new();
        cur.insert(q(b'a'), e("RVLT/A#X", &q(b'A'), 10 * MB)); // 그대로 가리킴(이번 바퀴 후보엔 없음 — 문서를 잠깐 못 받음)
        cur.insert(q(b'b'), e("RVLT/B#X", &q(b'B'), 10 * MB)); // 새 판으로 바뀜
        cur.insert(q(b'c'), e("RVLT/C#X", &q(b'C'), 10 * MB)); // 자산이 사라짐
        let chain: HashMap<String, String> = [("RVLT/A#X", q(b'a')), ("RVLT/B#X", q(b'n'))].into_iter().map(|(n, d)| (n.to_string(), d)).collect();
        let p = all(&cur, &chain, &[c(&q(b'n'), "RVLT/B#X", &q(b'B'), 10 * MB, 0)], 1024 * MB, &HashSet::new());
        assert_eq!(p.drop, vec![q(b'b'), q(b'c')]);
        assert_eq!(p.add.len(), 1, "새 판은 붙잡는다");
    }

    /// 🔴 이 기능이 붙잡은 것만 푼다. 원래 있던 것·남은 게임이 같이 쓰는 폴더는 그대로.
    #[test]
    fn 풀_것은_우리가_붙잡은_것만() {
        let mut remaining = BTreeMap::new();
        remaining.insert(q(b'n'), e("RVLT/B#X", &q(b'B'), 1)); // 새 판이 같은 폴더를 쓴다
        let dropped = vec![
            (q(b'b'), e("RVLT/B#X", &q(b'B'), 1)),
            (q(b'c'), Entry { doc_pre: true, folder_pre: true, ..e("RVLT/C#X", &q(b'C'), 1) }),
            (q(b'd'), e("RVLT/D#X", &q(b'D'), 1)),
        ];
        assert_eq!(unpin_targets(&remaining, &dropped), vec![q(b'b'), q(b'd'), q(b'D')]);
    }

    /// 「이 가게만 보관」 — PLAYX 만 고르면 PLAYX 게임만. 판매자 주소로 고르면 그 판매자 것만. 빠진 가게는 다음 바퀴에 푼다.
    #[test]
    fn 이_가게만_보관() {
        let seller = "RLFnbkjmf1VCVq7D9TZvRp7fv6W97rm2cB";
        let chain: HashMap<String, String> = [("RVLT/PLAYX#RUN", q(b'a')), ("RVLT/PLAYX/JUMP", q(b'b')), ("RVLT/OTHER#X", q(b'c'))]
            .into_iter().map(|(n, d)| (n.to_string(), d)).collect();
        let mut other = c(&q(b'c'), "RVLT/OTHER#X", &q(b'C'), MB, 0);
        other.seller = seller.into();
        let cands = vec![c(&q(b'a'), "RVLT/PLAYX#RUN", &q(b'A'), MB, 0), c(&q(b'b'), "RVLT/PLAYX/JUMP", &q(b'B'), MB, 0), other];
        let picks = vec![clean_pick("playx").unwrap()];
        let p = plan(&BTreeMap::new(), &chain, &cands, 1024 * MB, &HashSet::new(), Mode::Shops, &picks);
        assert_eq!(p.add.iter().map(|c| c.asset.as_str()).collect::<Vec<_>>(), vec!["RVLT/PLAYX#RUN", "RVLT/PLAYX/JUMP"]);
        assert_eq!(p.skipped, vec![("RVLT/OTHER#X".to_string(), "not-picked")]);
        let by_addr = plan(&BTreeMap::new(), &chain, &cands, 1024 * MB, &HashSet::new(), Mode::Shops, &[seller.to_string()]);
        assert_eq!(by_addr.add.len(), 1);
        assert_eq!(by_addr.add[0].asset, "RVLT/OTHER#X");
        // 이미 지키던 PLAYX 게임은 PLAYX 를 목록에서 빼면 풀린다.
        let mut cur = BTreeMap::new();
        cur.insert(q(b'a'), e("RVLT/PLAYX#RUN", &q(b'A'), MB));
        assert_eq!(plan(&cur, &chain, &[], 1024 * MB, &HashSet::new(), Mode::Shops, &[]).drop, vec![q(b'a')]);
        // 가게 이름 정리: RVLT/ 떼기 · 대문자 · 주소는 그대로 · 이상한 글자 거절
        assert_eq!(clean_pick(" RVLT/playx ").as_deref(), Some("PLAYX"));
        assert_eq!(clean_pick(seller).as_deref(), Some(seller));
        assert!(clean_pick("a b").is_none() && clean_pick("").is_none() && clean_pick("PLAYX#RUN").is_none());
        assert_eq!(shop_of("RVLT/PLAYX#RUN"), "PLAYX");
    }

    #[test]
    fn 가게별_묶음() {
        let mut g = BTreeMap::new();
        g.insert(q(b'a'), e("RVLT/PLAYX#RUN", &q(b'A'), 300_000));
        g.insert(q(b'b'), e("RVLT/PLAYX/JUMP", &q(b'B'), 100_000));
        g.insert(q(b'c'), e("RVLT/ZED#X", &q(b'C'), 5));
        assert_eq!(by_shop(&g), vec![("PLAYX".to_string(), 2, 400_000), ("ZED".to_string(), 1, 5)]);
    }
}
