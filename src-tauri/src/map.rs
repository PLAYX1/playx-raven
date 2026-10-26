//! 「내 가게를 지도에 올리기」 — 이름표 게시·영업 중 신호(심장)·내리기.
//!
//! ## 서버가 없다
//!
//! 예약·주문은 **사장 컴퓨터가** 받는다. 그래서 「지금 이 가게가 받을 수 있나」는
//! 이 컴퓨터가 켜져 있는가와 같은 말이다. 켜져 있는 동안 5분마다 서명한 신호를
//! 공개 릴레이에 올리고, 손님 폰 지도는 10분 안의 신호가 있으면 「영업 중」으로 본다.
//! 꺼지면 신호가 끊겨 저절로 「쉬는 중」이 된다.
//!
//! 형식은 `map_format.rs`(폰 문서 정본을 따름). 여기는 저장·게시·심장만.
//!
//! ## 🔴 올라가는 것
//!
//! 이름·업종·5자리 동네(약 5km 칸)·가게 링크·영업 신호. **그것뿐이다.** 정확한
//! 주소·좌표·전화는 싣지 않는다(화면에도 한 줄로 적는다).
//!
//! ## 🔴 화면을 붙잡지 않는다
//!
//! 릴레이 세 곳에 붙는 데 몇 초가 걸리고, 하나씩 늘 죽는다. [올리기]는 저장만 하고
//! 바로 돌아오며, 게시는 뒤에서 한다. 실패는 조용히 기록하고 다음 박동(5분)에 다시 한다.

use crate::map_format::{self as fmt, Card, RvnSigner};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

/// 5분. 폰은 10분(600초) 안의 신호를 「영업 중」으로 본다 — 그 절반이라 한 번 빠져도 버틴다.
pub const BEAT_EVERY_SECS: u64 = 5 * 60;

static RUNNING: AtomicBool = AtomicBool::new(false);
static BUSY: AtomicBool = AtomicBool::new(false);
/// 「닫힘」을 이미 보냈나 — 닫혀 있는 동안 5분마다 지우기를 또 보내지 않게.
static CLOSED_SENT: AtomicBool = AtomicBool::new(false);
static STATUS: Mutex<RunStatus> = Mutex::new(RunStatus { card_ok_at: 0, beat_ok_at: 0, last_error: String::new(), closed: false });

#[derive(Clone, Default, Serialize)]
struct RunStatus {
    card_ok_at: i64,
    beat_ok_at: i64,
    last_error: String,
    closed: bool,
}

/// `map.json` — 이 컴퓨터에만. 비밀은 없다(열쇠는 `shopkey.json` 에서 뽑는다).
#[derive(Clone, Default, Serialize, Deserialize)]
struct MapConfig {
    #[serde(default)]
    registered: bool,
    #[serde(default)]
    slug: String,
    #[serde(default)]
    name: String,
    #[serde(default)]
    category: String,
    #[serde(default)]
    area: String,
    #[serde(default)]
    shop_url: String,
    /// 임시 터널 주소를 골랐으면, 터널 주소가 바뀔 때 이름표를 새 주소로 다시 올린다.
    #[serde(default)]
    follow_tunnel: bool,
    #[serde(default)]
    created_at: i64,
    /// 이름표를 아직 한 곳에도 못 올렸다 — 다음 박동에 다시 한다.
    #[serde(default)]
    card_pending: bool,
}

/// 화면이 넘기는 초안.
#[derive(Deserialize)]
pub struct MapDraft {
    name: String,
    category: String,
    area: String,
    #[serde(default)]
    shop_url: String,
}

fn now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

fn file() -> std::path::PathBuf {
    crate::paths::app_file("map.json")
}

fn load() -> MapConfig {
    std::fs::read_to_string(file())
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_default()
}

fn save(c: &MapConfig) -> Result<(), String> {
    let p = file();
    if let Some(d) = p.parent() {
        let _ = std::fs::create_dir_all(d);
    }
    // 반쯤 쓴 파일이 남지 않게 옆에 쓰고 바꿔 끼운다.
    let tmp = p.with_extension("json.tmp");
    std::fs::write(&tmp, serde_json::to_vec_pretty(c).unwrap_or_default())
        .and_then(|_| std::fs::rename(&tmp, &p))
        .map_err(|e| format!("지도 설정을 저장하지 못했습니다: {e}"))
}

fn shop_json() -> Value {
    std::fs::read_to_string(crate::paths::app_file("shop.json"))
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_else(|| json!({}))
}

fn shop_str(sh: &Value, k: &str) -> String {
    sh.get(k).and_then(Value::as_str).map(str::trim).unwrap_or("").to_string()
}

/// 「지금 닫기」를 눌러 두었나. 닫혀 있으면 신호를 안 올린다.
fn shop_closed_now() -> bool {
    shop_json().get("closed_now").and_then(Value::as_bool).unwrap_or(false)
}

fn tunnel_url() -> Option<String> {
    crate::tunnel::tunnel_status()["url"].as_str().map(str::to_string).filter(|s| !s.is_empty())
}

/// (안쪽 서명자, 겉봉투 비밀값, 겉봉투 공개키)
fn keys() -> Result<(RvnSigner, [u8; 32], String), String> {
    let shop = crate::shopkey::secret_for_derivation()?;
    let (rk, nk) = fmt::derive_map_keys(&shop);
    let signer = RvnSigner::new(&rk)?;
    let npub = crate::shopkey::pubkey_of(&nk)?;
    Ok((signer, nk, npub))
}

fn card_of(c: &MapConfig) -> Card {
    Card {
        slug: c.slug.clone(),
        name: c.name.clone(),
        category: c.category.clone(),
        area: c.area.clone(),
        contact: None,
        shop_url: Some(c.shop_url.clone()).filter(|s| !s.trim().is_empty()),
        created_at: c.created_at,
    }
}

fn note_error(e: &str) {
    eprintln!("[map] {e}");
    if let Ok(mut s) = STATUS.lock() {
        s.last_error = e.chars().take(200).collect();
    }
}

async fn publish(ev: Value) -> Result<(), String> {
    crate::nostrpub::nostr_publish(ev).await.map(|_| ())
}

/// 한 박동. 이름표가 밀려 있으면 먼저 올리고, 그다음 영업 중 신호.
async fn tick() {
    // 박동은 한 번에 하나. [올리기] 직후 박동과 5분 박동이 겹치면 기다린다.
    let mut got = false;
    for _ in 0..30 {
        if !BUSY.swap(true, Ordering::SeqCst) {
            got = true;
            break;
        }
        tokio::time::sleep(std::time::Duration::from_secs(1)).await;
    }
    // 30초를 기다려도 앞 박동이 안 끝났으면 이번은 거른다(다음 박동이 한다).
    if !got {
        return;
    }
    tick_inner().await;
    BUSY.store(false, Ordering::SeqCst);
}

async fn tick_inner() {
    let mut cfg = load();
    if !cfg.registered {
        return;
    }
    let closed = shop_closed_now();
    if let Ok(mut s) = STATUS.lock() {
        s.closed = closed;
    }
    if closed {
        if !CLOSED_SENT.swap(true, Ordering::SeqCst) {
            send_close(&cfg, false).await;
        }
        return;
    }
    CLOSED_SENT.store(false, Ordering::SeqCst);
    let (signer, nk, _) = match keys() {
        Ok(k) => k,
        Err(e) => return note_error(&e),
    };

    // 임시 터널을 따라가는 가게: 주소가 바뀌었으면 이름표를 새로 서명한다.
    if cfg.follow_tunnel {
        if let Some(u) = tunnel_url() {
            if u != cfg.shop_url && fmt::is_shop_url(&u) {
                cfg.shop_url = u;
                cfg.created_at = now().max(cfg.created_at + 1);
                cfg.card_pending = true;
                let _ = save(&cfg);
            }
        }
    }
    if cfg.card_pending {
        match fmt::build_card_event(&card_of(&cfg), &signer, &nk) {
            Ok(ev) => match publish(ev).await {
                Ok(()) => {
                    cfg.card_pending = false;
                    let _ = save(&cfg);
                    if let Ok(mut s) = STATUS.lock() {
                        s.card_ok_at = now();
                        s.last_error.clear();
                    }
                }
                Err(e) => note_error(&e),
            },
            Err(e) => return note_error(&e),
        }
    }
    let at = now();
    match fmt::build_beat_event(&signer, &nk, &cfg.slug, &cfg.area, at, None) {
        Ok(ev) => match publish(ev).await {
            Ok(()) => {
                if let Ok(mut s) = STATUS.lock() {
                    s.beat_ok_at = at;
                    if !cfg.card_pending {
                        s.last_error.clear();
                    }
                }
            }
            Err(e) => note_error(&e),
        },
        Err(e) => note_error(&e),
    }
}

/// 「닫힘」 — 신호(와 내릴 때는 이름표)를 NIP-09 로 거둔다. 실패해도 10분 뒤 폰은 쉬는 중으로 본다.
async fn send_close(cfg: &MapConfig, with_card: bool) {
    let Ok((signer, nk, npub)) = keys() else { return };
    if !fmt::is_slug(&cfg.slug) {
        return;
    }
    match fmt::build_delete_event(&nk, &npub, &signer.address, &cfg.slug, with_card, now()) {
        Ok(ev) => {
            if let Err(e) = publish(ev).await {
                note_error(&e);
            } else if let Ok(mut s) = STATUS.lock() {
                s.beat_ok_at = 0;
            }
        }
        Err(e) => note_error(&e),
    }
}

/// 켤 때 부른다. 올려 둔 가게면 곧바로 한 번, 그 뒤 5분마다.
pub fn start() {
    if RUNNING.swap(true, Ordering::SeqCst) {
        return;
    }
    tauri::async_runtime::spawn(async {
        loop {
            tick().await;
            tokio::time::sleep(std::time::Duration::from_secs(BEAT_EVERY_SECS)).await;
        }
    });
}

/// 지금 한 번(기다리지 않는다).
fn kick() {
    tauri::async_runtime::spawn(tick());
}

/// 앱을 끝낼 때 — 「닫힘」을 짧게 시도한다. 🔴 3초 넘게 종료를 붙잡지 않는다.
pub fn stop_on_exit() {
    let cfg = load();
    if !cfg.registered {
        return;
    }
    // `rt::block` — 런타임 안에서 불려도 죽지 않는다(rt.rs).
    crate::rt::block(async move {
        let _ = tokio::time::timeout(std::time::Duration::from_secs(3), send_close(&cfg, false)).await;
    });
}

fn draft_card(d: &MapDraft, slug: &str) -> Card {
    Card {
        slug: slug.to_string(),
        name: d.name.clone(),
        category: d.category.clone(),
        area: d.area.trim().to_string(),
        contact: None,
        shop_url: Some(d.shop_url.trim().to_string()).filter(|s| !s.is_empty()),
        created_at: now().max(1),
    }
    .normalized()
}

fn slug_for(cfg: &MapConfig) -> String {
    if fmt::is_slug(&cfg.slug) {
        cfg.slug.clone()
    } else {
        fmt::suggest_slug(&shop_str(&shop_json(), "chain_asset"))
    }
}

/// 화면이 처음 그릴 때 — 저장된 값(없으면 가게 정보에서 제안)·동네 표·업종·터널 주소.
#[tauri::command]
pub fn map_load() -> Value {
    let cfg = load();
    let sh = shop_json();
    let tunnel = tunnel_url();
    let order_url = shop_str(&sh, "order_url");
    let suggested_url = if !cfg.shop_url.is_empty() {
        cfg.shop_url.clone()
    } else if fmt::is_shop_url(&order_url) {
        order_url.clone()
    } else {
        tunnel.clone().unwrap_or_default()
    };
    let issuer = keys().map(|k| k.0.address).ok();
    json!({
        "registered": cfg.registered,
        "name": if cfg.name.is_empty() { shop_str(&sh, "name") } else { cfg.name.clone() },
        "category": cfg.category,
        "area": cfg.area,
        "shop_url": suggested_url,
        "tunnel_url": tunnel,
        "order_url": order_url,
        "issuer": issuer,
        "areas": fmt::AREAS.iter().map(|(n, g, a)| json!({"name": n, "group": g, "area": a})).collect::<Vec<_>>(),
        "categories": fmt::CATEGORIES.iter().map(|(k, n)| json!({"key": k, "name": n})).collect::<Vec<_>>(),
    })
}

/// 미리보기 — 무엇이 올라가는지 그대로, 그리고 문제 목록. 서명·게시는 하지 않는다.
#[tauri::command]
pub fn map_check(draft: MapDraft) -> Value {
    let cfg = load();
    let c = draft_card(&draft, &slug_for(&cfg));
    let problems = fmt::card_problems(&c);
    let url = c.shop_url.clone().unwrap_or_default();
    json!({
        "problems": problems,
        "preview": {
            "name": c.name, "category": c.category, "area": c.area,
            "shopUrl": c.shop_url,
        },
        "temporary_url": !url.is_empty() && fmt::is_temporary_url(&url),
        "no_url": url.is_empty(),
    })
}

/// [올리기] — 저장하고 바로 돌아온다. 게시(이름표 + 첫 신호)는 뒤에서.
#[tauri::command]
pub fn map_publish(draft: MapDraft) -> Result<Value, String> {
    let mut cfg = load();
    let slug = slug_for(&cfg);
    let c = draft_card(&draft, &slug);
    if let Some(p) = fmt::card_problems(&c).first() {
        return Err((*p).to_string());
    }
    // 열쇠가 깨졌으면 올렸다고 말하기 전에 막는다.
    let issuer = keys()?.0.address;
    let url = c.shop_url.clone().unwrap_or_default();
    cfg.registered = true;
    cfg.slug = slug;
    cfg.name = c.name.clone();
    cfg.category = c.category.clone();
    cfg.area = c.area.clone();
    cfg.follow_tunnel = fmt::is_temporary_url(&url) && tunnel_url().as_deref() == Some(url.as_str());
    cfg.shop_url = url;
    // 같은 가게 id 는 더 새 것이 이긴다 — 같은 초에 두 번 눌러도 뒤의 것이 이기게.
    cfg.created_at = now().max(cfg.created_at + 1);
    cfg.card_pending = true;
    save(&cfg)?;
    CLOSED_SENT.store(false, Ordering::SeqCst);
    start();
    kick();
    Ok(json!({ "ok": true, "issuer": issuer, "id": fmt::merchant_id(&issuer, &cfg.slug) }))
}

/// [내리기] — 신호를 멈추고 이름표·신호를 거둔다(지우기를 지키는 릴레이에서).
#[tauri::command]
pub fn map_unpublish() -> Result<Value, String> {
    let mut cfg = load();
    if !cfg.registered {
        return Ok(json!({ "ok": true }));
    }
    cfg.registered = false;
    cfg.card_pending = false;
    save(&cfg)?;
    if let Ok(mut s) = STATUS.lock() {
        s.beat_ok_at = 0;
        s.card_ok_at = 0;
    }
    tauri::async_runtime::spawn(async move { send_close(&cfg, true).await });
    Ok(json!({ "ok": true }))
}

/// 상태등·카드가 읽는 것.
#[tauri::command]
pub fn map_status() -> Value {
    let cfg = load();
    let s = STATUS.lock().map(|g| g.clone()).unwrap_or_default();
    json!({
        "registered": cfg.registered,
        "card_pending": cfg.card_pending,
        "card_ok_at": s.card_ok_at,
        "beat_ok_at": s.beat_ok_at,
        "closed": cfg.registered && shop_closed_now(),
        "last_error": s.last_error,
        "area": cfg.area,
        "temporary_url": fmt::is_temporary_url(&cfg.shop_url),
    })
}

/// 「영업 중」/「지금 닫기」를 눌렀을 때 — 기다리지 않고 바로 신호(또는 닫힘)를 보낸다.
#[tauri::command]
pub fn map_presence_now() {
    if load().registered {
        kick();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 저장 파일에 **좌표 칸이 없다** — 정확 위치는 이 기능 어디에도 들어오지 않는다.
    #[test]
    fn the_saved_config_has_no_coordinates() {
        let v = serde_json::to_value(MapConfig::default()).unwrap();
        for k in ["lat", "lon", "lng", "latitude", "longitude", "address", "phone"] {
            assert!(v.get(k).is_none(), "{k}");
        }
    }

    /// 화면 초안의 빈 링크는 「없음」이다 — 빈 문자열을 싣지 않는다.
    #[test]
    fn an_empty_link_is_left_out() {
        let d = MapDraft { name: " 가게 ".into(), category: "cafe".into(), area: "wydk3".into(), shop_url: "  ".into() };
        let c = draft_card(&d, "shop");
        assert_eq!(c.name, "가게");
        assert!(c.shop_url.is_none());
        assert!(fmt::card_problems(&c).is_empty());
    }

    #[test]
    fn the_beat_is_well_inside_the_phone_window() {
        assert!(BEAT_EVERY_SECS * 2 <= 600, "폰은 10분 안의 신호만 영업 중으로 본다");
    }
}
