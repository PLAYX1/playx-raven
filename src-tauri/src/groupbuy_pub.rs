//! 공동구매 열림 쪽지 — Nostr kind 31406 `rv.groupbuy/1` (2026-11-22 대표 결정: 레이븐볼트는 플랫폼).
//!
//! ## 한 줄로
//!
//! 이 가게 메뉴의 공동구매 품목(`group` 칸이 있는 품목, `groupbuy.rs`)마다 서명한 「열림」 쪽지를 공개 릴레이에
//! 올린다. 폰·웹 장터의 「공동구매」 칩이 이것을 읽어 **PLAY X 장터만이 아니라 모든 판매자의** 공동구매를 보인다.
//! 누르면 이 가게의 고정 링크(`/s/…`, `map_format::shop_link_*`)로 가게 페이지(`/`)가 열리고, 손님은 거기서
//! 평소처럼 주문·결제한다(`/api/order`). **새 결제 창구는 없다.**
//!
//! ## 정본은 폰 쪽 문서다
//!
//! `ravenvault/docs/MERCHANT-EVENT-FORMAT.md` §6 (폰 `core/market/merchants/groupbuy.ts`). 한 칸이라도 다르면
//! 폰이 조용히 버린다 — 아래 시험이 문서의 시험 벡터(고정 키 0x15·0x17)를 그대로 대조한다.
//! 두 겹 서명(겉 Nostr · 안 레이븐코인 메시지 서명)과 열쇠는 지도 이름표와 **같은 것**(`map.rs keys`)을 쓴다 —
//! 그래야 폰이 이 쪽지와 그 가게 이름표를 같은 발행 주소로 묶는다.
//!
//! ## 언제 올리나
//!
//! 지도에 가게를 올려 둔 동안, 영업 신호 박동(5분, `map.rs`)마다 살핀다. 칸이 바뀌었거나 이번 실행 첫 박동이거나
//! 1시간이 지났으면 다시 올린다(폰은 24시간 넘게 소식 없는 것을 버린다). 마감·품목 삭제·공동구매 해제·[내리기] 때는
//! 마지막 칸 그대로 `ended` 를 한 번 올린다. 「지금 닫기」 동안에는 올리지 않는다(박동이 멈춘다).
//!
//! 🔴 손님 연락처·대기 명단·결제 장부는 **싣지 않는다**. 실리는 것은 메뉴판에 이미 공개된 것(이름·값·날짜·수량)뿐.

use crate::map_format::{self as fmt, RvnSigner};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use std::sync::atomic::{AtomicBool, Ordering};

pub const GROUPBUY_NOSTR_KIND: i64 = 31406;
pub const GROUPBUY_TAG: &str = "ravenvault-groupbuy";
pub const GROUPBUY_FORMAT: &str = "rv.groupbuy/1";
/// 칸이 그대로여도 이만큼 지나면 다시 올린다. 폰은 24시간 넘은 것을 버린다.
pub const REFRESH_SECS: i64 = 60 * 60;
/// 한 가게가 한 번에 올리는 최대 품목 수(폰은 판매자당 6개만 보인다 — 넉넉히).
const MAX_ITEMS: usize = 30;
const MAX_STOCK: i64 = 1_000_000;

/// 이번 실행에서 한 번이라도 살폈나 — 켤 때마다 한 번은 새로 올린다.
static FIRST_DONE: AtomicBool = AtomicBool::new(false);

/// 쪽지 한 장(서명 전).
#[derive(Clone, Debug, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct Gb {
    pub slug: String,
    pub item: String,
    pub state: String,
    pub title: String,
    pub price: String,
    pub currency: String,
    pub pickup: String,
    pub deadline: String,
    pub min: i64,
    pub max: i64,
    pub left: i64,
    pub delivery: Vec<String>,
    #[serde(default)]
    pub image: Option<String>,
    pub at: i64,
}

/// 품목 id — `sha256("rv.groupbuy/1\n" ‖ 품목 이름)` hex 앞 16자.
pub fn item_id(name: &str) -> String {
    hex::encode(Sha256::digest(format!("{GROUPBUY_FORMAT}\n{name}").as_bytes()))[..16].to_string()
}

/// 서명 대상 — `JSON.stringify(["rv.groupbuy/1", issuer, slug, item, state, title, price, currency, pickup, deadline, min, max, left, delivery.join(","), image ?? "", at])`.
pub fn message(issuer: &str, g: &Gb) -> String {
    serde_json::to_string(&json!([
        GROUPBUY_FORMAT,
        issuer,
        g.slug,
        g.item,
        g.state,
        g.title,
        g.price,
        g.currency,
        g.pickup,
        g.deadline,
        g.min,
        g.max,
        g.left,
        g.delivery.join(","),
        g.image.as_deref().unwrap_or(""),
        g.at
    ]))
    .unwrap_or_default()
}

fn js_len(s: &str) -> usize {
    s.encode_utf16().count()
}
fn hidden(c: char) -> bool {
    matches!(c as u32, 0..=0x1f | 0x7f | 0x200b..=0x200f | 0x202a..=0x202e | 0x2066..=0x2069 | 0xfeff)
}
fn is_ymd(s: &str) -> bool {
    s.len() == 10 && s.as_bytes().iter().enumerate().all(|(i, b)| if i == 4 || i == 7 { *b == b'-' } else { b.is_ascii_digit() }) && crate::groupbuy::parse_ymd(s).is_some()
}
fn is_price(s: &str) -> bool {
    let (int, frac) = match s.split_once('.') {
        Some((a, b)) => (a, Some(b)),
        None => (s, None),
    };
    let int_ok = int == "0" || (!int.is_empty() && int.len() <= 12 && !int.starts_with('0') && int.bytes().all(|b| b.is_ascii_digit()));
    int_ok && frac.map_or(true, |f| (1..=8).contains(&f.len()) && f.bytes().all(|b| b.is_ascii_digit()))
}
fn is_cid(s: &str) -> bool {
    (46..=100).contains(&s.len()) && s.bytes().all(|b| b.is_ascii_alphanumeric() && b != b'0')
}

/// 폰 `groupbuyProblem` 과 같은 규칙. 맞으면 None.
pub fn problem(issuer_ok: bool, g: &Gb) -> Option<&'static str> {
    if !issuer_ok {
        return Some("issuer");
    }
    if !fmt::is_slug(&g.slug) {
        return Some("slug");
    }
    if g.item.len() != 16 || !g.item.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)) {
        return Some("item");
    }
    if g.state != "open" && g.state != "ended" {
        return Some("state");
    }
    if g.title.trim().is_empty() || g.title.trim() != g.title || js_len(&g.title) > 80 || g.title.chars().any(hidden) {
        return Some("title");
    }
    if !is_price(&g.price) || g.currency.len() != 3 || !g.currency.bytes().all(|b| b.is_ascii_uppercase()) {
        return Some("price");
    }
    if !is_ymd(&g.pickup) || !is_ymd(&g.deadline) || g.deadline > g.pickup {
        return Some("dates");
    }
    if !(1..=MAX_STOCK).contains(&g.min) || !(1..=MAX_STOCK).contains(&g.max) || !(0..=g.max).contains(&g.left) {
        return Some("counts");
    }
    let d = &g.delivery;
    if d.is_empty() || d.len() > 2 || d.iter().any(|m| m != "store" && m != "courier") || (d.len() == 2 && d[0] == d[1]) {
        return Some("delivery");
    }
    if let Some(i) = &g.image {
        let ok = js_len(i) <= 300
            && !i.chars().any(hidden)
            && (i.strip_prefix("ipfs://").is_some_and(is_cid) || (fmt::is_shop_url(i) && !i.contains('?') && !i.contains('#')));
        if !ok {
            return Some("image");
        }
    }
    if g.at <= 0 {
        return Some("at");
    }
    None
}

/// 쪽지 이벤트 — 검사 → 안쪽 서명 → 겉봉투 서명. content 키 순서는 폰 `signGroupbuy` + `pubkey` 와 같다(시험 벡터 id 까지 맞게).
pub fn build_event(signer: &RvnSigner, nostr_sk: &[u8; 32], area: &str, g: &Gb) -> Result<Value, String> {
    if let Some(p) = problem(true, g) {
        return Err(format!("공동구매 칸이 올바르지 않아요({p})."));
    }
    if !fmt::is_area(area) {
        return Err("동네는 5자리 지역 코드만 쓸 수 있어요. 정확한 위치는 받지 않아요.".into());
    }
    let signature = signer.sign(&message(&signer.address, g));
    let mut m = Map::new();
    m.insert("kind".into(), json!(GROUPBUY_FORMAT));
    m.insert("issuer".into(), json!(signer.address));
    m.insert("slug".into(), json!(g.slug));
    m.insert("item".into(), json!(g.item));
    m.insert("state".into(), json!(g.state));
    m.insert("title".into(), json!(g.title));
    m.insert("price".into(), json!(g.price));
    m.insert("currency".into(), json!(g.currency));
    m.insert("pickup".into(), json!(g.pickup));
    m.insert("deadline".into(), json!(g.deadline));
    m.insert("min".into(), json!(g.min));
    m.insert("max".into(), json!(g.max));
    m.insert("left".into(), json!(g.left));
    m.insert("delivery".into(), json!(g.delivery));
    if let Some(i) = &g.image {
        m.insert("image".into(), json!(i));
    }
    m.insert("at".into(), json!(g.at));
    m.insert("signature".into(), json!(signature));
    m.insert("pubkey".into(), json!(signer.pubkey));
    let content = serde_json::to_string(&Value::Object(m)).unwrap_or_default();
    let tags = json!([
        ["d", format!("{}/{}/{}", signer.address, g.slug, g.item)],
        ["t", GROUPBUY_TAG],
        ["g", area]
    ]);
    crate::shopkey::sign_with(nostr_sk, GROUPBUY_NOSTR_KIND, tags, &content, g.at)
}

/// 값 → 10진 글자(소수 8자리까지, 끝 0 없음). 음수·NaN·너무 큰 값은 None.
pub fn price_text(p: f64) -> Option<String> {
    if !p.is_finite() || p <= 0.0 || p >= 1e12 {
        return None;
    }
    let s = format!("{p:.8}");
    let s = s.trim_end_matches('0').trim_end_matches('.').to_string();
    is_price(&s).then_some(s)
}

/// 메뉴 → 지금 열린 공동구매 쪽지들(순수 함수 · 시험).
///
/// - `menu` = 사장이 적은 메뉴(최대 수량 = `stock`), `left` = 품목 이름 → 지금 남은 수(결제 확정·잡아 둔 것을 뺀 값).
/// - 값 없는 품목·약속이 틀린 품목(`spec_problem`)·마감이 지난 품목(`today > deadline`)은 싣지 않는다.
/// - 통화는 품목에 적힌 것, 없으면 가게 통화.
pub fn open_items(menu: &Value, left: &Value, shop_currency: &str, delivery: &[&str], slug: &str, today: i64, at: i64) -> Vec<Gb> {
    let mut out = Vec::new();
    for it in menu.as_array().cloned().unwrap_or_default() {
        let Some(spec) = crate::groupbuy::spec_of(&it) else { continue };
        if crate::groupbuy::spec_problem(&it).is_some() || today > spec.deadline {
            continue;
        }
        let name = it.get("name").and_then(Value::as_str).unwrap_or("").trim().to_string();
        let Some(price) = it.get("price").and_then(Value::as_f64).and_then(price_text) else { continue };
        let Some(max) = it.get("stock").and_then(Value::as_i64).filter(|n| (1..=MAX_STOCK).contains(n)) else { continue };
        let currency = it
            .get("currency")
            .and_then(Value::as_str)
            .map(str::to_uppercase)
            .filter(|c| c.len() == 3 && c.bytes().all(|b| b.is_ascii_uppercase()))
            .unwrap_or_else(|| shop_currency.to_uppercase());
        let g = it.get("group").cloned().unwrap_or(Value::Null);
        let ymd = |k: &str| g.get(k).and_then(Value::as_str).map(str::trim).unwrap_or("").to_string();
        let left_now = left.get(&name).and_then(Value::as_i64).unwrap_or(max).clamp(0, max);
        let image = it
            .get("image")
            .and_then(Value::as_str)
            .map(|s| s.chars().filter(char::is_ascii_alphanumeric).collect::<String>())
            .filter(|c| is_cid(c))
            .map(|c| format!("ipfs://{c}"));
        let gb = Gb {
            slug: slug.to_string(),
            item: item_id(&name),
            state: "open".into(),
            title: name,
            price,
            currency,
            pickup: ymd("pickup"),
            deadline: ymd("deadline"),
            min: spec.min.min(MAX_STOCK),
            max,
            left: left_now,
            delivery: delivery.iter().map(|s| s.to_string()).collect(),
            image,
            at,
        };
        if problem(true, &gb).is_none() {
            out.push(gb);
        }
        if out.len() >= MAX_ITEMS {
            break;
        }
    }
    out
}

/// 가게가 받는 방법 → 쪽지의 `delivery`. 가게에서 받기(기본 켬) · 배달·택배. 둘 다 꺼져 있으면 가게에서 받기.
pub fn delivery_of(shop: &Value) -> Vec<&'static str> {
    let pickup = shop.get("pickup").and_then(Value::as_bool) != Some(false);
    let courier = shop.get("delivery").and_then(Value::as_bool) == Some(true);
    match (pickup, courier) {
        (_, false) => vec!["store"],
        (true, true) => vec!["store", "courier"],
        (false, true) => vec!["courier"],
    }
}

// ── 무엇을 다시 올릴까(순수) ─────────────────────────────────────────────

/// `groupbuy_pub.json` — 마지막으로 올린 쪽지(품목 id → 쪽지). 비밀 없음.
pub type Sent = std::collections::BTreeMap<String, Gb>;

/// 시각을 뺀 칸이 같나.
fn same_fields(a: &Gb, b: &Gb) -> bool {
    Gb { at: 0, ..a.clone() } == Gb { at: 0, ..b.clone() }
}

/// 이번에 올릴 것 — 열린 것 중 바뀐 것·처음·오래된 것, 그리고 사라진 것의 `ended`.
/// `at` 은 언제나 지난번보다 크게(같은 `d` 는 가장 새 것이 이긴다).
pub fn plan(sent: &Sent, now_open: &[Gb], now: i64, first: bool) -> Vec<Gb> {
    let mut out = Vec::new();
    let next_at = |id: &str| sent.get(id).map(|p| now.max(p.at + 1)).unwrap_or(now);
    for g in now_open {
        let due = match sent.get(&g.item) {
            None => true,
            Some(p) => first || p.state != "open" || !same_fields(p, g) || now - p.at >= REFRESH_SECS,
        };
        if due {
            out.push(Gb { at: next_at(&g.item), ..g.clone() });
        }
    }
    for (id, p) in sent {
        if p.state == "open" && !now_open.iter().any(|g| &g.item == id) {
            out.push(Gb { state: "ended".into(), at: next_at(id), ..p.clone() });
        }
    }
    out
}

// ── 저장·게시(파일·네트워크) ───────────────────────────────────────────

fn file() -> std::path::PathBuf {
    crate::paths::app_file("groupbuy_pub.json")
}

fn load() -> Sent {
    std::fs::read_to_string(file()).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default()
}

fn save(s: &Sent) {
    let p = file();
    if let Some(d) = p.parent() {
        let _ = std::fs::create_dir_all(d);
    }
    let tmp = p.with_extension("json.tmp");
    if std::fs::write(&tmp, serde_json::to_vec_pretty(s).unwrap_or_default()).is_ok() {
        let _ = std::fs::rename(&tmp, &p);
    }
}

fn now_unix() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0)
}

/// 지금 열린 공동구매(이 가게 메뉴 · 결제 장부 · 잡아 둔 재고 기준).
fn current(slug: &str, now: i64) -> Vec<Gb> {
    let shop = crate::shop::shop_load();
    let menu = shop.get("menu").cloned().unwrap_or(json!([]));
    let adjusted = crate::groupbuy::adjusted_menu(&menu);
    let left = crate::stock::stock_left(adjusted, now);
    let today = crate::ledger::local_ymd(now, crate::server::local_tz_offset_min());
    let delivery = delivery_of(&shop);
    open_items(&menu, &left, &crate::shop::currency(), &delivery, slug, today, now)
}

/// 한 박동(`map.rs tick`) — 바뀐 것만 올리고, 올린 것을 적어 둔다. `end_all` 이면 열린 것을 모두 `ended` 로 닫는다([내리기]).
/// 실패는 다음 박동에 다시 한다(적지 않았으므로).
pub async fn sync(signer: &RvnSigner, nostr_sk: &[u8; 32], slug: &str, area: &str, end_all: bool) {
    if !fmt::is_slug(slug) || !fmt::is_area(area) {
        return;
    }
    let now = now_unix();
    let mut sent = load();
    let open = if end_all { Vec::new() } else { current(slug, now) };
    let first = !FIRST_DONE.swap(true, Ordering::SeqCst);
    for g in plan(&sent, &open, now, first) {
        let ev = match build_event(signer, nostr_sk, area, &g) {
            Ok(ev) => ev,
            Err(e) => {
                eprintln!("[groupbuy_pub] {e}");
                continue;
            }
        };
        match crate::nostrpub::nostr_publish(ev).await {
            Ok(_) => {
                if g.state == "ended" {
                    sent.remove(&g.item);
                } else {
                    sent.insert(g.item.clone(), g);
                }
                save(&sent);
            }
            Err(e) => eprintln!("[groupbuy_pub] {e}"),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const VEC_ISSUER: &str = "RMem8GvhCRTBMi7Gr1ZaC4xfEr1RFCRBbR";
    /// 문서 §6 시험 벡터(폰 `core/market/merchants/groupbuy.test.ts` 가 만든 값).
    const VEC_ITEM: &str = "69d2a861f76bbfb7";
    const VEC_MESSAGE: &str = r#"["rv.groupbuy/1","RMem8GvhCRTBMi7Gr1ZaC4xfEr1RFCRBbR","playx-gym","69d2a861f76bbfb7","open","제주 귤 5kg","25000","KRW","2026-09-30","2026-09-25",10,40,28,"store,courier","ipfs://QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG",1790000300]"#;
    const VEC_SIGNATURE: &str = "1Uznc+Hj7ahs6UW4weqWbkKgxybyf6CwbpXWCw+gO1U8ZE4clpJuuuLhPmTwu20PRKrqHysTn0pXaBIrtig8EA==";
    const VEC_ID: &str = "455dc6967ef58d01090879a5a0a9fdfc87c7e5a35f391497cab4f35aa9de14ef";

    fn vec_gb() -> Gb {
        Gb {
            slug: "playx-gym".into(),
            item: item_id("제주 귤 5kg"),
            state: "open".into(),
            title: "제주 귤 5kg".into(),
            price: "25000".into(),
            currency: "KRW".into(),
            pickup: "2026-09-30".into(),
            deadline: "2026-09-25".into(),
            min: 10,
            max: 40,
            left: 28,
            delivery: vec!["store".into(), "courier".into()],
            image: Some("ipfs://QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG".into()),
            at: 1_790_000_300,
        }
    }

    #[test]
    fn 문서_시험_벡터와_글자_하나까지_같다() {
        assert_eq!(item_id("제주 귤 5kg"), VEC_ITEM);
        let signer = RvnSigner::new(&[0x15; 32]).unwrap();
        assert_eq!(signer.address, VEC_ISSUER);
        assert_eq!(message(&signer.address, &vec_gb()), VEC_MESSAGE);
        assert_eq!(signer.sign(VEC_MESSAGE), VEC_SIGNATURE, "안쪽 서명(RFC6979)이 폰과 같다");
        let ev = build_event(&signer, &[0x17; 32], "wydk3", &vec_gb()).unwrap();
        assert_eq!(ev["kind"], 31406);
        assert_eq!(ev["id"], VEC_ID, "content 키 순서까지 같다");
        assert_eq!(ev["tags"], json!([["d", format!("{VEC_ISSUER}/playx-gym/{VEC_ITEM}")], ["t", "ravenvault-groupbuy"], ["g", "wydk3"]]));
        assert!(crate::relay::verify(&ev), "겉봉투 서명");
        let now = now_unix();
        let fresh = build_event(&signer, &[0x17; 32], "wydk3", &Gb { at: now, ..vec_gb() }).unwrap();
        assert_eq!(crate::nostrpub::validate_publish_event(&fresh), Ok(()), "중계 검사가 31406 을 받는다");
    }

    #[test]
    fn 틀린_칸은_거절한다() {
        let ok = vec_gb();
        assert_eq!(problem(true, &ok), None);
        let bad = |f: &dyn Fn(&mut Gb)| {
            let mut g = ok.clone();
            f(&mut g);
            problem(true, &g)
        };
        assert_eq!(bad(&|g| g.deadline = "2026-10-01".into()), Some("dates"));
        assert_eq!(bad(&|g| g.left = 41), Some("counts"));
        assert_eq!(bad(&|g| g.price = "1.123456789".into()), Some("price"));
        assert_eq!(bad(&|g| g.price = "01".into()), Some("price"));
        assert_eq!(bad(&|g| g.title = " 귤 ".into()), Some("title"));
        assert_eq!(bad(&|g| g.title = "귤\u{202e}".into()), Some("title"));
        assert_eq!(bad(&|g| g.delivery = vec!["store".into(), "store".into()]), Some("delivery"));
        assert_eq!(bad(&|g| g.image = Some("http://x.example.com/a.png".into())), Some("image"));
        assert_eq!(bad(&|g| g.state = "paused".into()), Some("state"));
        assert!(build_event(&RvnSigner::new(&[0x15; 32]).unwrap(), &[0x17; 32], "wydk3x", &ok).is_err(), "동네는 5자리만");
    }

    #[test]
    fn 메뉴에서_열린_공동구매만_뽑는다() {
        let menu = json!([
            { "name": "제주 귤 5kg", "price": 25000.0, "stock": 40, "image": "QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG",
              "group": { "pickup": "2026-09-30", "deadline": "2026-09-25", "min": 10 } },
            { "name": "아메리카노", "price": 4000, "stock": 10 },
            { "name": "마감 지난 사과", "price": 1000, "stock": 5, "group": { "pickup": "2026-09-10", "deadline": "2026-09-05" } },
            { "name": "수량 없는 배", "price": 1000, "group": { "pickup": "2026-09-30", "deadline": "2026-09-25" } },
            { "name": "공짜 감", "price": 0, "stock": 5, "group": { "pickup": "2026-09-30", "deadline": "2026-09-25" } },
            { "name": "달러 꿀", "price": 12.5, "currency": "usd", "stock": 3, "group": { "pickup": "2026-09-30", "deadline": "2026-09-30" } }
        ]);
        let left = json!({ "제주 귤 5kg": 28, "달러 꿀": 9 });
        let got = open_items(&menu, &left, "KRW", &["store", "courier"], "playx-gym", 20260920, 1_790_000_300);
        assert_eq!(got.len(), 2, "{got:?}");
        assert_eq!(got[0], vec_gb(), "벡터와 같은 쪽지");
        assert_eq!((got[1].price.as_str(), got[1].currency.as_str(), got[1].left, got[1].min), ("12.5", "USD", 3, 1), "남은 수는 최대를 넘지 않는다");
        assert!(open_items(&menu, &left, "KRW", &["store"], "playx-gym", 20260926, 1).iter().all(|g| g.title == "달러 꿀"), "마감 지남");
        assert_eq!(delivery_of(&json!({})), vec!["store"]);
        assert_eq!(delivery_of(&json!({ "delivery": true })), vec!["store", "courier"]);
        assert_eq!(delivery_of(&json!({ "pickup": false, "delivery": true })), vec!["courier"]);
        assert_eq!(price_text(25000.0).as_deref(), Some("25000"));
        assert_eq!(price_text(0.1 + 0.2).as_deref(), Some("0.3"));
        assert_eq!(price_text(-1.0), None);
    }

    #[test]
    fn 바뀐_것만_다시_올리고_사라진_것은_닫는다() {
        let g = vec_gb();
        let mut sent = Sent::new();
        let p = plan(&sent, std::slice::from_ref(&g), 100, false);
        assert_eq!(p.len(), 1, "처음은 올린다");
        sent.insert(g.item.clone(), p[0].clone());
        assert!(plan(&sent, std::slice::from_ref(&g), 200, false).is_empty(), "그대로면 안 올린다");
        assert_eq!(plan(&sent, std::slice::from_ref(&g), 200, true).len(), 1, "이번 실행 첫 박동은 올린다");
        assert_eq!(plan(&sent, std::slice::from_ref(&g), 100 + REFRESH_SECS, false).len(), 1, "1시간 지나면 다시");
        let changed = Gb { left: 27, ..g.clone() };
        let p2 = plan(&sent, std::slice::from_ref(&changed), 100, false);
        assert_eq!((p2.len(), p2[0].at), (1, 101), "바뀌면 올리고, 시각은 지난번보다 크게");
        let ended = plan(&sent, &[], 300, false);
        assert_eq!((ended.len(), ended[0].state.as_str(), ended[0].left, ended[0].at), (1, "ended", 28, 300), "사라지면 마지막 칸 그대로 ended");
        let signer = RvnSigner::new(&[0x15; 32]).unwrap();
        assert!(build_event(&signer, &[0x17; 32], "wydk3", &ended[0]).is_ok());
    }
}
