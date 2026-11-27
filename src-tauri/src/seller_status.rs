//! 판매자 상태판 1단계 — 「이 판매자 컴퓨터가 **지금** 열려 있다」 신호. Nostr kind 31407 `rv.seller-status/1`. (2026-11-28)
//!
//! ## 무엇을 푸는가
//!
//! 오락실 게임 쪽지(31405)는 「이 게임이 있다」만 말한다. 판매자 컴퓨터가 지금 켜져 있는지는 아무도 말하지 않았다 —
//! 손님은 눌러 봐야 안다. 그리고 앱을 다시 켜면 임시 터널 주소가 바뀌는데, 쪽지의 gw 는 30분 바퀴(arcade_keep)가
//! 다시 쌀 때까지 옛 주소라 사이트(/g/)가 몇 분 동안 죽은 주소부터 두드렸다.
//!
//! 그래서 앱이 켜져 있는 동안 **5분마다** 작은 신호 하나를 올린다(덮어쓰기 글 — 릴레이에는 판매자마다 마지막 하나만 남는다).
//! 손님 쪽(폰·웹 `core/creator/seller-status.ts`)은 12분 안의 신호면 「지금 영업 중」, 사이트는 그 신호의 gw 를 쪽지 gw 보다 먼저 쓴다.
//!
//! ## 형식 (정본 = 이 파일 + 폰 `core/creator/seller-status.ts`, 둘이 글자 하나까지 같아야 한다)
//!
//! - kind 31407 (매개변수 교체형 30000–39999 · 31402~31406 다음 빈 번호)
//! - tags = `[["d","rv.seller-status"],["t","ravenvault-seller-status"],["expiration","<at+1800>"]]`
//! - content(JSON, 키 순서 고정) = `{ kind:"rv.seller-status/1", state:"open"|"closed", at, app, name?, gw?, gwMs?, shopOpen?, games:[문서 CID…], gameCount }`
//!   · `at` = 겉봉투 `created_at` 과 같다. 읽는 쪽은 다르면 버린다.
//!   · `games` = 지금 바깥에 내주는 내 게임 **문서** CID(최대 50, 작은 것부터) · `gameCount` = 전체 수.
//!   · `gwMs` = 이 컴퓨터가 자기 바깥 주소를 두드려 답을 받기까지(ms). 손님 폰에서 잰 값이 아니라 대략의 빠르기다.
//!
//! ## 🔴 열쇠 = 오락실 쪽지 겉봉투 열쇠
//!
//! 손님 쪽은 쪽지(31405)의 겉봉투 공개키로 「이 게임의 판매자 신호」를 찾는다. 그 쪽지의 안쪽 판매자 서명 문구에 이 공개키가
//! 들어 있어 공개키 ↔ 판매자 R 주소의 묶임은 이미 증명돼 있다. 그래서 같은 열쇠(shopkey.json 에서 뽑은 값 · 지갑 잠김과 무관)로 싼다.
//! 지갑의 메시지 서명은 부르지 않는다 — 5분마다 지갑을 깨울 일이 아니다.
//!
//! ## 🔴 싣지 않는 것
//!
//! 잔액·주소·전화·위치·사람 이름은 싣지 않는다. 가게 이름(이미 30078 가게 공지에 공개)과 바깥 주소(이미 31405 gw 에 공개)뿐이다.
//!
//! ## 끄기
//!
//! 앱을 끝낼 때(`stop_on_exit`) 「closed」를 3초까지만 시도한다. 못 보내도(정전·강제 종료) 손님 쪽은 12분 뒤 저절로 쉬는 중으로 보고,
//! 릴레이는 expiration(30분) 뒤 지운다. 내줄 게임이 없으면 아무것도 올리지 않는다(지갑만 쓰는 사람의 컴퓨터는 조용하다).
use serde_json::{json, Map, Value};
use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};

pub const SELLER_STATUS_KIND: i64 = 31407;
pub const SELLER_STATUS_TAG: &str = "ravenvault-seller-status";
pub const SELLER_STATUS_FORMAT: &str = "rv.seller-status/1";
/// 판매자마다 하나만 남게 하는 d. 판매자 구별은 겉봉투 공개키가 한다.
pub const SELLER_STATUS_D: &str = "rv.seller-status";
/// 5분마다. 🔴 손님 쪽 「지금 영업 중」 창(12분)의 절반 아래로 둘 것 — 늘리면 켜져 있는 가게가 쉬는 중으로 깜빡인다.
pub const BEAT_EVERY_SECS: u64 = 5 * 60;
/// 릴레이가 지우는 때(NIP-40). 꺼진 컴퓨터의 신호가 릴레이에 오래 남지 않게.
pub const EXPIRE_SECS: i64 = 30 * 60;
/// 신호에 싣는 게임 문서 CID 상한(이벤트를 작게 — 4KB 아래).
pub const MAX_GAMES: usize = 50;
/// 첫 신호까지 — 30분 바퀴(arcade_keep, 첫 바퀴 120초)가 내줄 게임 목록을 채운 뒤.
const FIRST_SECS: u64 = 150;
/// 바퀴 끝 「지금 한 번」이 5분 박동과 겹칠 때 너무 붙어 올리지 않게.
const MIN_GAP_SECS: i64 = 30;
const CONTENT_MAX: usize = 4096;

static RUNNING: AtomicBool = AtomicBool::new(false);
static BUSY: AtomicBool = AtomicBool::new(false);
/// 이번에 켠 뒤 「open」을 올린 적이 있나 — 있으면 끌 때·게임이 없어질 때 「closed」를 한 번 올린다.
static OPEN_SENT: AtomicBool = AtomicBool::new(false);
static LAST_AT: AtomicI64 = AtomicI64::new(0);

fn now() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0)
}

/// 신호 한 번에 담는 것. 순수 값 — 파일·네트워크 없음(시험이 그대로 만든다).
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Beat {
    pub open: bool,
    pub at: i64,
    pub app: String,
    pub name: Option<String>,
    pub gw: Option<String>,
    pub gw_ms: Option<u32>,
    pub shop_open: Option<bool>,
    pub games: Vec<String>,
}

/// 가게 이름 다듬기 — 앞뒤 공백 · 40자 · 보이지 않는 글자(제어·방향 바꾸기) 있으면 싣지 않는다.
pub(crate) fn clean_name(raw: &str) -> Option<String> {
    let s = raw.trim();
    if s.is_empty() || s.chars().any(|c| c.is_control() || matches!(c, '\u{200b}'..='\u{200f}' | '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}' | '\u{feff}')) {
        return None;
    }
    Some(s.chars().take(40).collect())
}

/// content(JSON 문자열) — 키 순서 고정. closed 면 앱 판·시각만(주소·게임 목록은 싣지 않는다).
pub fn content_of(b: &Beat) -> String {
    let mut m = Map::new();
    m.insert("kind".into(), json!(SELLER_STATUS_FORMAT));
    m.insert("state".into(), json!(if b.open { "open" } else { "closed" }));
    m.insert("at".into(), json!(b.at));
    m.insert("app".into(), json!(b.app.chars().take(20).collect::<String>()));
    if b.open {
        if let Some(n) = b.name.as_deref().and_then(clean_name) { m.insert("name".into(), json!(n)); }
        // gw 는 쪽지(31405)와 같은 모양 검사를 지난 것만.
        if let Some(g) = b.gw.as_deref().and_then(crate::arcade_listing::gateway_origin) {
            m.insert("gw".into(), json!(g));
            if let Some(ms) = b.gw_ms { m.insert("gwMs".into(), json!(ms.min(60_000))); }
        }
        if let Some(o) = b.shop_open { m.insert("shopOpen".into(), json!(o)); }
        let mut games: Vec<&String> = b.games.iter().filter(|c| crate::arcade::cid_ok(c)).collect();
        games.sort();
        games.dedup();
        let count = games.len();
        m.insert("games".into(), json!(games.into_iter().take(MAX_GAMES).collect::<Vec<_>>()));
        m.insert("gameCount".into(), json!(count));
    } else {
        m.insert("games".into(), json!([]));
        m.insert("gameCount".into(), json!(0));
    }
    serde_json::to_string(&Value::Object(m)).unwrap_or_default()
}

pub fn tags_of(at: i64) -> Value {
    json!([["d", SELLER_STATUS_D], ["t", SELLER_STATUS_TAG], ["expiration", (at + EXPIRE_SECS).to_string()]])
}

/// 겉봉투까지 싼 신호(오락실 쪽지 겉봉투 열쇠).
pub fn build_event(nostr_sk: &[u8; 32], b: &Beat) -> Result<Value, String> {
    crate::shopkey::sign_with(nostr_sk, SELLER_STATUS_KIND, tags_of(b.at), &content_of(b), b.at)
}

/// 이 컴퓨터 릴레이(우체국)가 받을 모양인가 — 우리가 만든 모양 그대로만. 서명은 store 가 따로 본다.
pub(crate) fn shape(e: &Value) -> Result<(), String> {
    if e.get("kind").and_then(Value::as_i64) != Some(SELLER_STATUS_KIND) { return Err("판매자 신호가 아닙니다.".into()); }
    let tags = e.get("tags").and_then(Value::as_array).ok_or("태그가 없습니다.")?;
    let tag = |n: &str| tags.iter().filter(|t| t.get(0).and_then(Value::as_str) == Some(n)).filter_map(|t| t.get(1).and_then(Value::as_str)).collect::<Vec<_>>();
    if tag("d") != [SELLER_STATUS_D] { return Err("판매자 신호 d 가 다릅니다.".into()); }
    if !tag("t").contains(&SELLER_STATUS_TAG) { return Err("판매자 신호 표가 없습니다.".into()); }
    let raw = e.get("content").and_then(Value::as_str).ok_or("내용이 없습니다.")?;
    if raw.len() > CONTENT_MAX { return Err("판매자 신호가 너무 큽니다.".into()); }
    let c: Value = serde_json::from_str(raw).map_err(|_| "판매자 신호 내용이 JSON 이 아닙니다.".to_string())?;
    if c.get("kind").and_then(Value::as_str) != Some(SELLER_STATUS_FORMAT) { return Err("판매자 신호 형식이 다릅니다.".into()); }
    if !matches!(c.get("state").and_then(Value::as_str), Some("open" | "closed")) { return Err("판매자 신호 상태가 다릅니다.".into()); }
    if c.get("at").and_then(Value::as_i64) != e.get("created_at").and_then(Value::as_i64) { return Err("판매자 신호 시각이 겉봉투와 다릅니다.".into()); }
    let games = c.get("games").and_then(Value::as_array).ok_or("게임 목록이 없습니다.")?;
    if games.len() > MAX_GAMES || !games.iter().all(|g| g.as_str().is_some_and(crate::arcade::cid_ok)) { return Err("게임 목록 모양이 다릅니다.".into()); }
    Ok(())
}

/// 지금 이 컴퓨터의 신호 재료. 내줄 게임이 없으면 None(올리지 않는다).
async fn gather(at: i64) -> Option<Beat> {
    let games = crate::arcade_gw::served_docs();
    if games.is_empty() { return None; }
    let sh: Value = std::fs::read_to_string(crate::paths::app_file("shop.json")).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_else(|| json!({}));
    let name = sh.get("name").and_then(Value::as_str).and_then(clean_name);
    // 가게(POS)가 있는 컴퓨터만 — 「지금 닫기」를 눌러 두었으면 false.
    let shop_open = name.as_ref().map(|_| !sh.get("closed_now").and_then(Value::as_bool).unwrap_or(false));
    let (gw, gw_ms) = match crate::arcade_gw::outside_origin_timed().await { Some((o, ms)) => (Some(o), Some(ms)), None => (None, None) };
    Some(Beat { open: true, at, app: env!("CARGO_PKG_VERSION").into(), name, gw, gw_ms, shop_open, games })
}

fn closed_beat(at: i64) -> Beat {
    Beat { open: false, at, app: env!("CARGO_PKG_VERSION").into(), ..Beat::default() }
}

async fn send(b: &Beat) -> Result<(), String> {
    let sk = crate::arcade_listing::nostr_key()?;
    let ev = build_event(&sk, b)?;
    crate::nostrpub::nostr_publish(ev).await.map(|_| ())
}

async fn tick() {
    if BUSY.swap(true, Ordering::SeqCst) { return; }
    let at = now();
    if at - LAST_AT.load(Ordering::SeqCst) >= MIN_GAP_SECS {
        match gather(at).await {
            Some(b) => match send(&b).await {
                Ok(()) => { OPEN_SENT.store(true, Ordering::SeqCst); LAST_AT.store(at, Ordering::SeqCst); }
                Err(e) => eprintln!("[seller-status] 못 올렸습니다: {e}"),
            },
            // 내주던 게임이 없어졌다 — 「open」을 올린 적이 있으면 「closed」를 한 번.
            None if OPEN_SENT.load(Ordering::SeqCst) => {
                if send(&closed_beat(at)).await.is_ok() { OPEN_SENT.store(false, Ordering::SeqCst); LAST_AT.store(at, Ordering::SeqCst); }
            }
            None => {}
        }
    }
    BUSY.store(false, Ordering::SeqCst);
}

/// 켤 때 한 번. 첫 바퀴 뒤 5분마다.
pub fn start() {
    if RUNNING.swap(true, Ordering::SeqCst) { return; }
    tauri::async_runtime::spawn(async {
        tokio::time::sleep(std::time::Duration::from_secs(FIRST_SECS)).await;
        loop {
            tick().await;
            tokio::time::sleep(std::time::Duration::from_secs(BEAT_EVERY_SECS)).await;
        }
    });
}

/// 지금 한 번(기다리지 않는다) — 「내 게임」 바퀴가 바깥 주소·내줄 목록을 새로 정한 직후(arcade_keep).
/// 앱을 다시 켜 터널 주소가 바뀐 경우 손님 쪽이 5분 박동을 기다리지 않고 새 gw 를 본다.
pub fn kick() {
    if !RUNNING.load(Ordering::SeqCst) { return; }
    tauri::async_runtime::spawn(tick());
}

/// 앱을 끝낼 때 — 「closed」를 짧게 시도한다. 🔴 3초 넘게 종료를 붙잡지 않는다.
pub fn stop_on_exit() {
    if !OPEN_SENT.load(Ordering::SeqCst) { return; }
    crate::rt::block(async move {
        let _ = tokio::time::timeout(std::time::Duration::from_secs(3), send(&closed_beat(now()))).await;
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    const DOC_A: &str = "QmAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    const DOC_Z: &str = "QmZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ";
    const SK: [u8; 32] = [0x21; 32];

    fn open_beat() -> Beat {
        Beat { open: true, at: 1_800_000_000, app: "0.9.58".into(), name: Some(" 플레이엑스 오락실 ".into()), gw: Some("https://kiosk.tail1234.ts.net".into()),
            gw_ms: Some(420), shop_open: Some(true), games: vec![DOC_Z.into(), DOC_A.into(), DOC_A.into(), "../etc".into()] }
    }

    /// 🔴 폰 `core/creator/seller-status.ts` 시험이 이 글자를 그대로 대조한다 — 한 칸이라도 바뀌면 둘 다 고친다.
    #[test]
    fn 내용은_키_순서_고정_게임은_모양_맞는_문서만_정렬_겹침없이() {
        assert_eq!(content_of(&open_beat()), format!(
            "{{\"kind\":\"rv.seller-status/1\",\"state\":\"open\",\"at\":1800000000,\"app\":\"0.9.58\",\"name\":\"플레이엑스 오락실\",\"gw\":\"https://kiosk.tail1234.ts.net\",\"gwMs\":420,\"shopOpen\":true,\"games\":[\"{DOC_A}\",\"{DOC_Z}\"],\"gameCount\":2}}"));
    }

    #[test]
    fn 닫힘에는_주소도_게임도_이름도_없다() {
        let mut b = open_beat();
        b.open = false;
        assert_eq!(content_of(&b), "{\"kind\":\"rv.seller-status/1\",\"state\":\"closed\",\"at\":1800000000,\"app\":\"0.9.58\",\"games\":[],\"gameCount\":0}");
    }

    #[test]
    fn 모양이_틀린_바깥_주소는_싣지_않고_응답_시간도_뺀다() {
        let mut b = open_beat();
        b.gw = Some("http://192.168.0.5:8790".into());
        let c: Value = serde_json::from_str(&content_of(&b)).unwrap();
        assert!(c.get("gw").is_none() && c.get("gwMs").is_none());
    }

    #[test]
    fn 잔액_주소_전화_위치는_싣지_않는다() {
        let c: Value = serde_json::from_str(&content_of(&open_beat())).unwrap();
        let keys: Vec<&str> = c.as_object().unwrap().keys().map(String::as_str).collect();
        assert_eq!(keys, ["kind", "state", "at", "app", "name", "gw", "gwMs", "shopOpen", "games", "gameCount"]);
        let src = include_str!("seller_status.rs");
        let body = &src[..src.find("#[cfg(test)]").unwrap()];
        for word in ["getbalance", "listunspent", "signmessage", "sign_message", "\"phone\"", "\"lat\"", "\"lon\""] {
            assert!(!body.contains(word), "{word}");
        }
    }

    #[test]
    fn 이름은_다듬고_숨은_글자가_있으면_뺀다() {
        assert_eq!(clean_name("  가게  ").as_deref(), Some("가게"));
        assert_eq!(clean_name(&"가".repeat(60)).map(|s| s.chars().count()), Some(40));
        assert_eq!(clean_name("가\u{202e}게"), None);
        assert_eq!(clean_name("   "), None);
    }

    #[test]
    fn 겉봉투는_교체형_번호_d_t_만료_30분() {
        let ev = build_event(&SK, &open_beat()).unwrap();
        assert_eq!(ev["kind"], 31407);
        assert_eq!(ev["created_at"], 1_800_000_000i64);
        assert_eq!(ev["tags"], json!([["d", "rv.seller-status"], ["t", "ravenvault-seller-status"], ["expiration", "1800001800"]]));
        assert!(crate::relay::verify(&ev), "서명이 맞아야 릴레이가 받는다");
        assert_eq!(shape(&ev), Ok(()));
        // 다른 가게 글 번호와 겹치지 않는다(31402 지도 · 31403 영업 신호 · 31404 고정 링크 · 31405 오락실 · 31406 공동구매).
        assert!((30000..40000).contains(&SELLER_STATUS_KIND));
        assert!(![30078, 30402, 31402, 31403, 31404, 31405, 31406].contains(&SELLER_STATUS_KIND));
    }

    #[test]
    fn 바깥으로_올리는_검사와_이_컴퓨터_릴레이가_받는다() {
        let mut b = open_beat();
        b.at = now();
        let ev = build_event(&SK, &b).unwrap();
        assert_eq!(crate::nostrpub::validate_publish_event(&ev), Ok(()), "nostr_publish 가 31407 을 받아야 한다");
        assert!(crate::relay::accepts_kind(SELLER_STATUS_KIND), "키오스크 우체국이 신호를 남겨야 한다");
    }

    #[test]
    fn 모양_검사는_d_상태_시각_게임목록을_본다() {
        let ok = build_event(&SK, &open_beat()).unwrap();
        let mut bad = ok.clone();
        bad["tags"] = json!([["d", "other"], ["t", SELLER_STATUS_TAG]]);
        assert!(shape(&bad).is_err());
        let mut bad = ok.clone();
        bad["created_at"] = json!(1_800_000_001i64);
        assert!(shape(&bad).is_err(), "content.at 과 created_at 이 다르면 버린다");
        let mut bad = ok.clone();
        bad["content"] = json!(content_of(&open_beat()).replace("\"open\"", "\"maybe\""));
        assert!(shape(&bad).is_err());
        let mut many = open_beat();
        const B58: &[u8] = b"123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
        many.games = (0..60).map(|i| format!("Qm{}{}{}", "A".repeat(42), B58[i / B58.len()] as char, B58[i % B58.len()] as char)).collect();
        let c: Value = serde_json::from_str(&content_of(&many)).unwrap();
        assert_eq!(c["games"].as_array().unwrap().len(), MAX_GAMES);
        assert_eq!(c["gameCount"], 60);
        assert!(content_of(&many).len() < CONTENT_MAX);
    }
}
