//! 미니 창 — 애플 뮤직 미니 플레이어처럼 화면 구석에 작게 띄우는 **읽기 전용** 창.
//!
//! ## 🔴 이 창이 절대 하지 않는 것
//!
//! 보내기·서명·복구 단어·비밀번호 입력·열쇠 보기. 코드로 막는다:
//!   1. `command_allowed` — 라벨 `mini` 인 창이 부를 수 있는 앱 명령은 `MINI_COMMANDS` 다섯 개뿐.
//!      `lib.rs` invoke_handler 가 다른 모든 명령(send_rvn·unlock_for·reveal_seed…)을 거절한다.
//!   2. `capabilities/mini.json` — 플러그인·코어 권한은 이벤트 듣기와 창 끌기뿐(opener·dialog·
//!      process·updater 없음).
//!   3. 금액·자산 이름 가리기는 **Rust 에서** 한다(`mini_feed::snapshot`). 가림이 켜져 있으면
//!      창은 숫자를 받지도 않는다. 기본은 가림 켬.
//!   4. 화면 캡처 보호(`content_protected`) 기본 켬 — 화면 공유·스크린샷에 창이 비어 보인다.
//!
//! ## 크기 셋
//!
//! | 크기 | 논리 px | 보이는 것 |
//! |---|---|---|
//! | S | 220×60 | 상태 점 + 총잔액(가림 가능) 또는 「새 소식 N」 |
//! | M | 300×140 | 잔액 + 최근 변화 3건 + 노드 상태 |
//! | L | 360×260 | M + 잠금·깨워 두기 + (판매자 모드일 때만) 오늘 판매·입금 요약 |
//!
//! 지켜보기(입금·노드)는 `mini_watch.rs`, 판단은 `mini_feed.rs`.

use crate::mini_feed::{self, Bundler, Event, Health, Kind, Notice, Tracker};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use tauri::{Emitter, Manager};

pub const LABEL: &str = "mini";
const FILE: &str = "mini-window.json";
const FAILURE: &str = "미니 창 설정을 적용하지 못했어요.";

/// 미니 창이 부를 수 있는 앱 명령 **전부**. 하나라도 늘리면 아래 시험이 깨지게 해 두었다.
pub const MINI_COMMANDS: [&str; 5] = ["mini_state", "mini_set", "mini_show", "mini_open_main", "mini_seen"];

pub fn command_allowed(label: &str, command: &str) -> bool {
    label != LABEL || MINI_COMMANDS.contains(&command)
}

pub fn dims(size: &str) -> (f64, f64) {
    match size {
        "s" => (220.0, 60.0),
        "l" => (360.0, 260.0),
        _ => (300.0, 140.0),
    }
}

#[derive(Clone, Serialize, Deserialize, Debug, PartialEq)]
#[serde(default, deny_unknown_fields)]
pub struct Settings {
    pub size: String,
    pub on_top: bool,
    /// 금액·자산 이름 가리기. 🔴 기본 켬.
    pub mask: bool,
    /// 화면 공유·스크린샷에서 창 숨기기. 🔴 기본 켬.
    pub capture_guard: bool,
    /// 소리. 기본 끔.
    pub sound: bool,
    /// 미니 창이 안 보일 때 OS 알림.
    pub os_notify: bool,
    /// 「입금 확인됨」으로 볼 확인 수(1~12).
    pub need: u8,
    /// 현지 시각 오프셋(분, 동쪽 +). 「오늘」을 가르는 데만 쓴다.
    pub tz: i32,
    pub locale: String,
    /// 마지막에 열려 있었나 — 다음 실행에 다시 연다.
    pub open: bool,
    pub x: Option<i32>,
    pub y: Option<i32>,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            size: "m".into(),
            on_top: true,
            mask: true,
            capture_guard: true,
            sound: false,
            os_notify: true,
            need: 1,
            tz: 0,
            locale: "ko".into(),
            open: false,
            x: None,
            y: None,
        }
    }
}

impl Settings {
    pub fn valid(&self) -> bool {
        ["s", "m", "l"].contains(&self.size.as_str())
            && (1..=12).contains(&self.need)
            && (-840..=840).contains(&self.tz)
            && ["ko", "en"].contains(&self.locale.as_str())
    }
}

/// 창에서 바꿀 수 있는 것만. 위치·열림은 창 이벤트가 정한다.
#[derive(Deserialize, Debug, Default)]
#[serde(deny_unknown_fields)]
pub struct Prefs {
    pub size: Option<String>,
    pub on_top: Option<bool>,
    pub mask: Option<bool>,
    pub capture_guard: Option<bool>,
    pub sound: Option<bool>,
    pub os_notify: Option<bool>,
    pub need: Option<u8>,
    pub tz: Option<i32>,
    pub locale: Option<String>,
}

pub fn apply(mut s: Settings, p: Prefs) -> Result<Settings, String> {
    if let Some(v) = p.size { s.size = v; }
    if let Some(v) = p.on_top { s.on_top = v; }
    if let Some(v) = p.mask { s.mask = v; }
    if let Some(v) = p.capture_guard { s.capture_guard = v; }
    if let Some(v) = p.sound { s.sound = v; }
    if let Some(v) = p.os_notify { s.os_notify = v; }
    if let Some(v) = p.need { s.need = v; }
    if let Some(v) = p.tz { s.tz = v; }
    if let Some(v) = p.locale { s.locale = if v.starts_with("en") { "en".into() } else { "ko".into() }; }
    if s.valid() { Ok(s) } else { Err(FAILURE.into()) }
}

#[cfg_attr(not(test), allow(dead_code))] // 화면(mini-view.ts nextSize)과 같은 순서 — 시험이 묶는다.
pub fn next_size(size: &str) -> &'static str {
    match size {
        "s" => "m",
        "m" => "l",
        _ => "s",
    }
}

fn read_settings() -> Settings {
    std::fs::read(crate::paths::app_file(FILE))
        .ok()
        .filter(|b| b.len() < 2048)
        .and_then(|b| serde_json::from_slice::<Settings>(&b).ok())
        .filter(Settings::valid)
        .unwrap_or_default()
}

fn persist(s: &Settings) -> Result<(), String> {
    crate::server::atomic_write_0600(&crate::paths::app_file(FILE), &serde_json::to_vec(s).map_err(|_| FAILURE)?)
        .map_err(|_| FAILURE.into())
}

/// 지켜보기 상태. 비밀 없음 — 공개 장부 줄과 노드 숫자뿐.
#[derive(Default)]
pub struct Feed {
    pub tracker: Tracker,
    pub health: Health,
    pub bundler: Bundler,
    pub cursor: Option<String>,
    pub balance: Option<(f64, f64)>,
    pub lock: String,
    pub unseen: u32,
    pub last_notice: Option<Notice>,
    pub awake_lost: bool,
}

#[derive(Default)]
pub struct Mini {
    pub settings: Mutex<Settings>,
    pub feed: Mutex<Feed>,
    /// 사용자가 미니 창을 한 번이라도 열었나(설정 파일이 있나). 안 열어 본 사람에게는
    /// 새 OS 알림도, 새 노드 질문도 만들지 않는다.
    pub enabled: AtomicBool,
}

struct TrayItems {
    toggle: tauri::menu::MenuItem<tauri::Wry>,
    top: tauri::menu::CheckMenuItem<tauri::Wry>,
    mask: tauri::menu::CheckMenuItem<tauri::Wry>,
}

static APP: std::sync::OnceLock<tauri::AppHandle> = std::sync::OnceLock::new();

pub fn settings(app: &tauri::AppHandle) -> Settings {
    app.state::<Mini>().settings.lock().unwrap_or_else(|e| e.into_inner()).clone()
}

fn store(app: &tauri::AppHandle, s: Settings) -> Result<(), String> {
    persist(&s)?;
    app.state::<Mini>().enabled.store(true, Ordering::Relaxed);
    *app.state::<Mini>().settings.lock().map_err(|_| FAILURE)? = s;
    Ok(())
}

pub fn visible(app: &tauri::AppHandle) -> bool {
    app.get_webview_window(LABEL).is_some_and(|w| w.is_visible().unwrap_or(false))
}

/// 노드에 물어볼 이유가 있나 — 창이 보이거나, 한 번 써 본 사람이 OS 알림을 켜 두었을 때만.
pub fn watch_wanted(app: &tauri::AppHandle) -> bool {
    visible(app) || (app.state::<Mini>().enabled.load(Ordering::Relaxed) && settings(app).os_notify)
}

fn ui_settings(s: &Settings) -> Value {
    json!({"size":s.size,"on_top":s.on_top,"mask":s.mask,"capture_guard":s.capture_guard,
        "sound":s.sound,"os_notify":s.os_notify,"need":s.need,"locale":s.locale,
        "os_notify_supported": cfg!(any(target_os = "macos", target_os = "windows"))})
}

pub fn now() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0)
}

/// 지금 상태 한 장(가림 규칙 적용). 창으로 나가는 유일한 자료.
pub fn snapshot(app: &tauri::AppHandle) -> Value {
    let s = settings(app);
    let mode = crate::mode::mode_get()["mode"].as_str().unwrap_or("").to_string();
    let awake = crate::awake::awake_status();
    let feed = app.state::<Mini>();
    let f = feed.feed.lock().unwrap_or_else(|e| e.into_inner());
    let mut v = mini_feed::snapshot(&mini_feed::SnapshotIn {
        masked: s.mask,
        locale: &s.locale,
        now: now(),
        tz: s.tz,
        balance: f.balance,
        tracker: &f.tracker,
        health: &f.health,
        lock: if f.lock.is_empty() { "unknown" } else { &f.lock },
        awake_holding: awake["holding"].as_bool().unwrap_or(false),
        awake_note: if s.locale == "en" { "" } else { awake["note"].as_str().unwrap_or("") },
        seller: mode == "shop",
        unseen: f.unseen,
        need: s.need as i64,
    });
    v["watching"] = json!(f.tracker.has_baseline());
    v["notice"] = serde_json::to_value(&f.last_notice).unwrap_or(Value::Null);
    v
}

pub fn push_snapshot(app: &tauri::AppHandle) {
    if visible(app) {
        let _ = app.emit_to(LABEL, "mini-snapshot", snapshot(app));
    }
}

#[tauri::command]
pub fn mini_state(app: tauri::AppHandle) -> Value {
    json!({"settings": ui_settings(&settings(&app)), "snapshot": snapshot(&app)})
}

#[tauri::command]
pub fn mini_set(app: tauri::AppHandle, prefs: Prefs) -> Result<Value, String> {
    let prev = settings(&app);
    let next = apply(prev.clone(), prefs)?;
    store(&app, next.clone())?;
    if let Some(w) = app.get_webview_window(LABEL) {
        if prev.on_top != next.on_top {
            let _ = w.set_always_on_top(next.on_top);
        }
        if prev.capture_guard != next.capture_guard {
            let _ = w.set_content_protected(next.capture_guard);
        }
        if prev.size != next.size {
            let (wd, ht) = dims(&next.size);
            let _ = w.set_size(tauri::LogicalSize::new(wd, ht));
            if let Ok(p) = w.outer_position() {
                let _ = keep_inside(&w, p.x, p.y);
            }
        }
    }
    sync_tray(&app);
    push_snapshot(&app);
    Ok(json!({"settings": ui_settings(&next)}))
}

#[tauri::command(async)]
pub fn mini_show(app: tauri::AppHandle, visible: bool) -> Result<(), String> {
    if visible { show(&app) } else { hide(&app) }
}

#[tauri::command(async)]
pub fn mini_open_main(app: tauri::AppHandle) -> Result<(), String> {
    crate::ravi_companion::open_main(&app)
}

#[tauri::command]
pub fn mini_seen(app: tauri::AppHandle) {
    app.state::<Mini>().feed.lock().unwrap_or_else(|e| e.into_inner()).unseen = 0;
    badge(&app, 0);
    push_snapshot(&app);
}

#[derive(Clone, Copy)]
struct Rect { x: i32, y: i32, w: i32, h: i32 }

fn clamp(x: i32, y: i32, w: i32, h: i32, monitors: &[Rect]) -> (i32, i32) {
    monitors
        .iter()
        .map(|m| {
            let px = x.clamp(m.x, m.x.saturating_add((m.w - w).max(0)));
            let py = y.clamp(m.y, m.y.saturating_add((m.h - h).max(0)));
            ((x as i128 - px as i128).pow(2) + (y as i128 - py as i128).pow(2), px, py)
        })
        .min_by_key(|p| p.0)
        .map(|p| (p.1, p.2))
        .unwrap_or((x, y))
}

fn monitors(w: &tauri::WebviewWindow) -> Vec<Rect> {
    w.available_monitors()
        .unwrap_or_default()
        .iter()
        .map(|m| {
            let a = m.work_area();
            Rect { x: a.position.x, y: a.position.y, w: a.size.width as i32, h: a.size.height as i32 }
        })
        .collect()
}

fn keep_inside(w: &tauri::WebviewWindow, x: i32, y: i32) -> Result<(i32, i32), String> {
    let size = w.outer_size().map_err(|_| FAILURE)?;
    let p = clamp(x, y, size.width as i32, size.height as i32, &monitors(w));
    w.set_position(tauri::PhysicalPosition::new(p.0, p.1)).map_err(|_| FAILURE)?;
    Ok(p)
}

fn build(app: &tauri::AppHandle, s: &Settings) -> Result<tauri::WebviewWindow, String> {
    let (wd, ht) = dims(&s.size);
    let w = tauri::WebviewWindowBuilder::new(app, LABEL, tauri::WebviewUrl::App("mini.html".into()))
        .title(if s.locale == "en" { "RavenVault mini" } else { "레이븐볼트 미니" })
        .inner_size(wd, ht)
        .resizable(false)
        .maximizable(false)
        .minimizable(false)
        .decorations(false)
        .always_on_top(s.on_top)
        .skip_taskbar(true)
        .focused(false)
        .visible(false)
        .content_protected(s.capture_guard)
        .build()
        .map_err(|_| FAILURE)?;
    let h = app.clone();
    w.on_window_event(move |e| match e {
        tauri::WindowEvent::Moved(p) => {
            let state = h.state::<Mini>();
            let mut s = state.settings.lock().unwrap_or_else(|e| e.into_inner());
            s.x = Some(p.x);
            s.y = Some(p.y);
        }
        tauri::WindowEvent::Focused(false) => {
            let _ = persist(&settings(&h));
        }
        tauri::WindowEvent::CloseRequested { api, .. } => {
            // 닫기 = 트레이로. 앱 종료가 아니다(밤새 입금을 받아야 하니까).
            api.prevent_close();
            let _ = hide(&h);
        }
        _ => {}
    });
    Ok(w)
}

pub fn show(app: &tauri::AppHandle) -> Result<(), String> {
    let mut s = settings(app);
    let w = match app.get_webview_window(LABEL) {
        Some(w) => w,
        None => build(app, &s)?,
    };
    let (wd, ht) = dims(&s.size);
    let _ = w.set_size(tauri::LogicalSize::new(wd, ht));
    let edge = monitors(&w)
        .first()
        .map(|m| {
            let sf = w.scale_factor().unwrap_or(1.0);
            (m.x + m.w - ((wd + 24.0) * sf) as i32, m.y + ((48.0) * sf) as i32)
        })
        .unwrap_or((0, 0));
    let p = keep_inside(&w, s.x.unwrap_or(edge.0), s.y.unwrap_or(edge.1))?;
    s.x = Some(p.0);
    s.y = Some(p.1);
    s.open = true;
    store(app, s)?;
    w.show().map_err(|_| FAILURE)?;
    sync_tray(app);
    push_snapshot(app);
    Ok(())
}

pub fn hide(app: &tauri::AppHandle) -> Result<(), String> {
    if let Some(w) = app.get_webview_window(LABEL) {
        w.hide().map_err(|_| FAILURE)?;
    }
    let mut s = settings(app);
    s.open = false;
    store(app, s)?;
    sync_tray(app);
    Ok(())
}

fn toggle(app: &tauri::AppHandle) -> Result<(), String> {
    if visible(app) { hide(app) } else { show(app) }
}

fn ko(app: &tauri::AppHandle) -> bool {
    settings(app).locale != "en"
}

fn sync_tray(app: &tauri::AppHandle) {
    let k = ko(app);
    let s = settings(app);
    if let Some(t) = app.try_state::<TrayItems>() {
        let _ = t.toggle.set_text(match (visible(app), k) {
            (true, true) => "미니 창 닫기",
            (true, false) => "Hide mini window",
            (false, true) => "미니 창 열기",
            (false, false) => "Show mini window",
        });
        let _ = t.top.set_checked(s.on_top);
        let _ = t.mask.set_checked(s.mask);
    }
}

/// 트레이(메뉴막대) 배지 — 새 소식 수만. 🔴 금액은 절대 싣지 않는다.
pub fn badge(app: &tauri::AppHandle, unseen: u32) {
    let k = ko(app);
    if let Some(tray) = app.tray_by_id("main") {
        // macOS: 메뉴막대 아이콘 옆 글자. 윈도우·리눅스는 툴팁으로 대신한다.
        let _ = tray.set_title(if unseen > 0 { Some(format!("{}", unseen.min(99))) } else { None });
        let base = if k { "레이븐볼트 · 라비" } else { "RavenVault · Ravi" };
        let _ = tray.set_tooltip(Some(if unseen > 0 {
            if k { format!("{base} · 새 소식 {unseen}") } else { format!("{base} · {unseen} new") }
        } else {
            base.to_string()
        }));
    }
}

/// 트레이 메뉴의 「미니 창」 묶음. `ravi_companion::setup` 이 자기 메뉴에 붙인다.
pub fn tray_submenu(app: &tauri::App) -> tauri::Result<tauri::menu::Submenu<tauri::Wry>> {
    use tauri::menu::{CheckMenuItem, MenuItem, PredefinedMenuItem, Submenu};
    let s = read_settings();
    let k = s.locale != "en";
    let toggle = MenuItem::with_id(app, "mini-toggle", if k { "미니 창 열기" } else { "Show mini window" }, true, None::<&str>)?;
    let sm = MenuItem::with_id(app, "mini-size-s", if k { "작게 (한 줄)" } else { "Small (one line)" }, true, None::<&str>)?;
    let mm = MenuItem::with_id(app, "mini-size-m", if k { "보통" } else { "Medium" }, true, None::<&str>)?;
    let lm = MenuItem::with_id(app, "mini-size-l", if k { "크게" } else { "Large" }, true, None::<&str>)?;
    let top = CheckMenuItem::with_id(app, "mini-top", if k { "항상 위에" } else { "Keep on top" }, true, s.on_top, None::<&str>)?;
    let mask = CheckMenuItem::with_id(app, "mini-mask", if k { "금액 가리기" } else { "Hide amounts" }, true, s.mask, None::<&str>)?;
    app.manage(TrayItems { toggle: toggle.clone(), top: top.clone(), mask: mask.clone() });
    let sep = PredefinedMenuItem::separator(app)?;
    Submenu::with_items(app, if k { "미니 창" } else { "Mini window" }, true, &[&toggle, &sep, &sm, &mm, &lm, &top, &mask])
}

pub fn on_menu(app: &tauri::AppHandle, id: &str) {
    let r = match id {
        "mini-toggle" => toggle(app),
        "mini-size-s" | "mini-size-m" | "mini-size-l" => {
            let size = id.trim_start_matches("mini-size-").to_string();
            mini_set(app.clone(), Prefs { size: Some(size), ..Prefs::default() }).and_then(|_| show(app))
        }
        "mini-top" => {
            let v = !settings(app).on_top;
            mini_set(app.clone(), Prefs { on_top: Some(v), ..Prefs::default() }).map(|_| ())
        }
        "mini-mask" => {
            let v = !settings(app).mask;
            mini_set(app.clone(), Prefs { mask: Some(v), ..Prefs::default() }).map(|_| ())
        }
        _ => Ok(()),
    };
    if r.is_err() {
        sync_tray(app);
    }
}

/// `ravi_companion::notify` 가 부른다 — 손님 주문(판매자 모드)만 받아 묶음에 넣는다.
pub fn companion_notice(kind: &str) {
    if kind != "order" {
        return;
    }
    if let Some(app) = APP.get() {
        if crate::mode::mode_get()["mode"].as_str() != Some("shop") || !watch_wanted(app) {
            return;
        }
        let mini = app.state::<Mini>();
        let mut f = mini.feed.lock().unwrap_or_else(|e| e.into_inner());
        f.bundler.push(Event { kind: Kind::Order, amount: None, asset: None, sale: true, at: now() });
    }
}

/// 묶인 알림을 내보낸다(미니 창 안 + 필요하면 OS). 지켜보기 한 바퀴마다 부른다.
pub fn deliver(app: &tauri::AppHandle) {
    let s = settings(app);
    let notice = {
        let mini = app.state::<Mini>();
        let mut f = mini.feed.lock().unwrap_or_else(|e| e.into_inner());
        let Some(batch) = f.bundler.flush(now()) else { return };
        let notable = batch.iter().filter(|e| e.kind != Kind::NodeRecovered).count() as u32;
        f.unseen = f.unseen.saturating_add(notable);
        let n = mini_feed::notice(&batch, s.mask, &s.locale);
        f.last_notice = n.clone();
        badge(app, f.unseen);
        n
    };
    let Some(n) = notice else { return };
    if visible(app) {
        let _ = app.emit_to(LABEL, "mini-notice", &n);
    } else if s.os_notify {
        os_notify(app, &n, s.sound);
    }
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
fn os_notify(app: &tauri::AppHandle, n: &Notice, sound: bool) {
    let id = app.config().identifier.clone();
    let (title, body) = (n.title.clone(), n.body.clone());
    // 알림 센터 호출이 늦게 돌아올 수 있어 따로 돌린다. 실패는 조용히 — 미니 창·배지가 남는다.
    std::thread::spawn(move || {
        let mut x = notify_rust::Notification::new();
        x.summary(&title).body(&body);
        #[cfg(target_os = "macos")]
        {
            let _ = notify_rust::set_application(if tauri::is_dev() { "com.apple.Terminal" } else { &id });
            if sound {
                x.sound_name("Ping");
            }
        }
        #[cfg(target_os = "windows")]
        {
            let dev = std::env::current_exe()
                .ok()
                .and_then(|p| p.parent().map(|d| d.ends_with("debug") || d.ends_with("release")))
                .unwrap_or(true);
            if !dev {
                x.app_id(&id);
            }
            if sound {
                x.sound_name("Default");
            }
        }
        let _ = x.show();
    });
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn os_notify(_app: &tauri::AppHandle, _n: &Notice, _sound: bool) {
    // 리눅스: dbus 의존성을 들이지 않는다 — 트레이 툴팁·미니 창만.
}

pub fn setup(app: &mut tauri::App) {
    let _ = APP.set(app.handle().clone());
    let s = read_settings();
    let enabled = crate::paths::app_file(FILE).is_file();
    app.manage(Mini { settings: Mutex::new(s.clone()), enabled: AtomicBool::new(enabled), ..Mini::default() });
    crate::mini_watch::start(app.handle().clone());
    if s.open {
        let _ = show(app.handle());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mini_window_can_only_reach_read_only_commands() {
        for c in [
            "send_rvn", "send_asset", "send_from", "wallet_send_signed", "unlock_for", "lock_wallet", "encrypt_wallet",
            "change_passphrase", "reveal_seed", "recovery_card", "words_restore_start", "words_restore_check",
            "sales_account_reveal", "sign_message", "save_api_key", "ai_chat", "ravi_agent_chat", "open_external",
            "phone_transaction_send", "swap_take", "fee_pay", "cloud_key_show", "backup_pass_set", "companion_save",
            "wallet_balance", "recent_transactions", "mode_set", "services_stop", "install_update",
        ] {
            assert!(!command_allowed(LABEL, c), "미니 창이 {c} 를 부를 수 있으면 안 된다");
            assert!(command_allowed("main", c));
        }
        for c in MINI_COMMANDS {
            assert!(command_allowed(LABEL, c));
            // 이름에 비밀·돈 냄새가 나는 명령은 목록에 들어오지 않는다.
            for bad in ["send", "sign", "seed", "pass", "unlock", "key", "word", "reveal"] {
                assert!(!c.contains(bad), "{c}");
            }
        }
        assert_eq!(MINI_COMMANDS.len(), 5, "목록을 늘릴 때는 이 시험과 docs/mini-window.md 를 같이 고친다");
    }

    #[test]
    fn lib_routes_every_invoke_through_the_mini_gate() {
        let lib = include_str!("lib.rs");
        let gate = lib.find("mini::command_allowed").expect("lib.rs invoke_handler 에 미니 창 문지기가 있어야 한다");
        let handler = lib.find("generate_handler!").unwrap();
        assert!(gate < handler, "문지기는 명령을 처리하기 **전에** 있어야 한다");
        for c in MINI_COMMANDS {
            assert!(lib.contains(&format!("mini::{c}")), "{c} 가 등록돼야 한다");
        }
    }

    #[test]
    fn capability_is_minimal_and_main_capability_excludes_mini() {
        let cap: Value = serde_json::from_str(include_str!("../capabilities/mini.json")).unwrap();
        assert_eq!(cap["windows"], json!([LABEL]));
        let allowed = ["core:event:allow-listen", "core:event:allow-unlisten", "core:window:allow-start-dragging"];
        for p in cap["permissions"].as_array().unwrap() {
            assert!(allowed.contains(&p.as_str().unwrap()), "미니 창에 넓은 권한: {p}");
        }
        for f in [include_str!("../capabilities/default.json"), include_str!("../capabilities/companion.json")] {
            let v: Value = serde_json::from_str(f).unwrap();
            assert!(!v["windows"].as_array().unwrap().iter().any(|w| w == LABEL));
        }
    }

    #[test]
    fn defaults_protect_privacy() {
        let s = Settings::default();
        assert!(s.mask && s.capture_guard && !s.sound);
        assert!(s.valid());
    }

    #[test]
    fn prefs_validate_and_reject_unknown() {
        let s = Settings::default();
        let l = apply(s.clone(), Prefs { size: Some("l".into()), mask: Some(false), ..Prefs::default() }).unwrap();
        assert_eq!((l.size.as_str(), l.mask), ("l", false));
        assert!(apply(s.clone(), Prefs { size: Some("xl".into()), ..Prefs::default() }).is_err());
        assert!(apply(s.clone(), Prefs { need: Some(0), ..Prefs::default() }).is_err());
        assert!(apply(s.clone(), Prefs { need: Some(13), ..Prefs::default() }).is_err());
        assert!(apply(s.clone(), Prefs { tz: Some(9999), ..Prefs::default() }).is_err());
        assert_eq!(apply(s, Prefs { locale: Some("en-US".into()), ..Prefs::default() }).unwrap().locale, "en");
        assert!(serde_json::from_str::<Prefs>(r#"{"passphrase":"x"}"#).is_err(), "모르는 칸은 거절");
        assert!(serde_json::from_str::<Prefs>(r#"{"x":5}"#).is_err(), "위치는 창이 정한다");
        assert_eq!((next_size("s"), next_size("m"), next_size("l")), ("m", "l", "s"));
        assert_eq!(dims("s"), (220.0, 60.0));
        assert_eq!(dims("m"), (300.0, 140.0));
        assert_eq!(dims("l"), (360.0, 260.0));
    }

    #[test]
    fn settings_remembered_private_and_corrupt_fallback() {
        let _env = crate::paths::TEST_ENV.lock().unwrap_or_else(|e| e.into_inner());
        let s = Settings { size: "s".into(), on_top: false, open: true, x: Some(-1500), y: Some(40), tz: 540, ..Settings::default() };
        persist(&s).unwrap();
        assert_eq!(read_settings(), s, "크기·위치·열림을 다음 실행에 기억");
        let path = crate::paths::app_file(FILE);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(std::fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);
        }
        std::fs::write(&path, br#"{"size":"m","seed":"never"}"#).unwrap();
        assert_eq!(read_settings(), Settings::default(), "모르는 칸이 있으면 기본값");
        std::fs::write(&path, b"broken").unwrap();
        assert_eq!(read_settings(), Settings::default());
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn position_stays_on_some_monitor() {
        let ms = [Rect { x: -1920, y: 0, w: 1920, h: 1080 }, Rect { x: 0, y: 0, w: 1440, h: 900 }];
        assert_eq!(clamp(5000, 5000, 300, 140, &ms), (1140, 760));
        assert_eq!(clamp(-3000, -10, 220, 60, &ms), (-1920, 0));
        assert_eq!(clamp(100, 100, 220, 60, &[]), (100, 100));
    }
}
