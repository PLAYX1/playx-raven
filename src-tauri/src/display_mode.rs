//! 표시 방식 — 큰 창 · 작은 창(미니 S/M/L) · 칩(아주 작게) · 메뉴바만 + 대기화면(전체 화면).
//!
//! 설계: `docs/design/window-modes.md`. 여기는 **판단(순수 함수, 전부 시험)** 과 **창·트레이 배선**.
//!
//! ## 🔴 읽기 전용 원칙
//!
//! 칩은 미니 창(라벨 `mini`)의 다섯째 크기 `xs` 라서 미니 창 문지기(`mini::MINI_COMMANDS`)를 그대로 쓴다.
//! 대기화면(라벨 `standby`)은 `STANDBY_COMMANDS` 두 개만 부를 수 있다(`command_allowed`, lib.rs 에서
//! 명령 처리 **전에** 검사). 보내기·서명·복구 단어·비밀번호 입력은 어느 쪽에도 없다.
//! 금액은 미니 창과 같은 한 장(`mini::snapshot`, Rust 에서 가림)만 나간다 — 가림 기본 켬.
//! 메뉴바(트레이) 요약 줄도 같은 한 장에서 만든다. 주소·txid 는 어디에도 싣지 않는다.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::sync::Mutex;
use tauri::{Emitter, Manager};

pub const STANDBY: &str = "standby";
const FILE: &str = "display-mode.json";
const FAILURE: &str = "표시 방식을 바꾸지 못했어요.";

/// 대기화면이 부를 수 있는 앱 명령 **전부**.
pub const STANDBY_COMMANDS: [&str; 2] = ["standby_state", "standby_exit"];

pub fn command_allowed(label: &str, command: &str) -> bool {
    label != STANDBY || STANDBY_COMMANDS.contains(&command)
}

pub const MODES: [&str; 4] = ["window", "mini", "chip", "menubar"];

#[derive(Clone, Serialize, Deserialize, Debug, PartialEq)]
#[serde(default, deny_unknown_fields)]
pub struct Settings {
    /// window(큰 창) · mini(작은 창) · chip(아주 작은 칩) · menubar(메뉴바만)
    pub mode: String,
    /// 메뉴바만일 때 독 아이콘 숨기기(맥만). 큰 창을 열면 다시 보인다.
    pub hide_dock: bool,
    /// 메뉴막대 아이콘 옆 글자(맥만): alerts(새 소식 수) · balance(잔액, 가림이면 ••••) · none
    pub tray_text: String,
    /// 대기화면 어둡게 하는 시간(시, 0~23). from == to 이면 끔.
    pub dim_from: u8,
    pub dim_to: u8,
    /// 대기화면 번인 방지 — 1분마다 글자 묶음을 조금씩 옮긴다.
    pub shift: bool,
    pub locale: String,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            mode: "window".into(),
            hide_dock: true,
            tray_text: "alerts".into(),
            dim_from: 22,
            dim_to: 7,
            shift: true,
            locale: "ko".into(),
        }
    }
}

impl Settings {
    pub fn valid(&self) -> bool {
        MODES.contains(&self.mode.as_str())
            && ["alerts", "balance", "none"].contains(&self.tray_text.as_str())
            && self.dim_from < 24
            && self.dim_to < 24
            && ["ko", "en"].contains(&self.locale.as_str())
    }
}

#[derive(Deserialize, Debug, Default)]
#[serde(deny_unknown_fields)]
pub struct Prefs {
    pub mode: Option<String>,
    pub hide_dock: Option<bool>,
    pub tray_text: Option<String>,
    pub dim_from: Option<u8>,
    pub dim_to: Option<u8>,
    pub shift: Option<bool>,
    pub locale: Option<String>,
}

pub fn apply_prefs(mut s: Settings, p: Prefs) -> Result<Settings, String> {
    if let Some(v) = p.mode { s.mode = v; }
    if let Some(v) = p.hide_dock { s.hide_dock = v; }
    if let Some(v) = p.tray_text { s.tray_text = v; }
    if let Some(v) = p.dim_from { s.dim_from = v; }
    if let Some(v) = p.dim_to { s.dim_to = v; }
    if let Some(v) = p.shift { s.shift = v; }
    if let Some(v) = p.locale { s.locale = if v.starts_with("en") { "en".into() } else { "ko".into() }; }
    if s.valid() { Ok(s) } else { Err(FAILURE.into()) }
}

/// 이 모드에서 큰 창을 처음부터 띄우나. 트레이가 없으면(리눅스 일부) 늘 띄운다 — 돌아올 길이 없어지면 안 된다.
pub fn main_at_start(mode: &str, tray_ok: bool) -> bool {
    !tray_ok || mode == "window"
}

/// 메뉴바 요약 줄에 맞게 금액을 짧게(소수 둘째 자리까지 버림). 가림이면 ••••.
pub fn short_amount(v: Option<&str>) -> String {
    match v {
        None => "••••".into(),
        Some(s) => match s.split_once('.') {
            Some((i, f)) => {
                let f: String = f.chars().take(2).collect();
                let f = f.trim_end_matches('0');
                if f.is_empty() { i.to_string() } else { format!("{i}.{f}") }
            }
            None => s.to_string(),
        },
    }
}

/// 트레이(메뉴막대) 요약 — 읽기 전용 줄 셋과 아이콘 옆 글자. 입력은 가림이 이미 적용된 한 장.
#[derive(Debug, PartialEq)]
pub struct TrayLines {
    pub status: String,
    pub balance: String,
    pub alerts: String,
    pub title: Option<String>,
}

pub fn tray_lines(snap: &Value, tray_text: &str, locale: &str) -> TrayLines {
    let en = locale == "en";
    let state = snap["node"]["state"].as_str().unwrap_or("unknown");
    let node = match (state, en) {
        ("ok", false) => "노드 정상",
        ("ok", true) => "Node OK",
        ("syncing", false) => "따라잡는 중",
        ("syncing", true) => "Catching up",
        ("rescanning", false) => "지갑 되살리는 중",
        ("rescanning", true) => "Restoring wallet",
        ("down", false) => "노드 응답 없음",
        ("down", true) => "Node not responding",
        ("disconnected", false) => "연결 끊김",
        ("disconnected", true) => "Disconnected",
        ("stalled", false) => "동기화 멈춤",
        ("stalled", true) => "Sync stalled",
        (_, false) => "노드 확인 중",
        (_, true) => "Checking node",
    };
    let dot = match snap["status"].as_str() {
        Some("ok") => "●",
        Some("bad") => "▲",
        _ => "○",
    };
    let status = match snap["node"]["peers"].as_i64() {
        Some(p) if state != "down" => {
            if en { format!("{dot} {node} · {p} peers") } else { format!("{dot} {node} · 연결 {p}곳") }
        }
        _ => format!("{dot} {node}"),
    };
    let known = snap["balance"]["known"].as_bool().unwrap_or(false);
    let amount = short_amount(snap["balance"]["confirmed"].as_str());
    let balance = match (known, en) {
        (false, false) => "잔액 확인 중".to_string(),
        (false, true) => "Checking balance".to_string(),
        (true, false) => format!("잔액 {amount}{}", if amount == "••••" { "" } else { " RVN" }),
        (true, true) => format!("Balance {amount}{}", if amount == "••••" { "" } else { " RVN" }),
    };
    let unseen = snap["unseen"].as_u64().unwrap_or(0);
    let alerts = match (unseen, en) {
        (0, false) => "새 소식 없음".to_string(),
        (0, true) => "No new alerts".to_string(),
        (n, false) => format!("새 소식 {n}"),
        (n, true) => format!("{n} new"),
    };
    let title = match tray_text {
        "balance" if known => Some(if amount == "••••" { amount } else { format!("{amount} RVN") }),
        "none" => None,
        // alerts(기본) — 새 소식 수만. 잔액을 고른 사람도 잔액을 모르면 새 소식 수로.
        _ => (unseen > 0).then(|| format!("{}", unseen.min(99))),
    };
    TrayLines { status, balance, alerts, title }
}

/// 대기화면 어둡게 할 시간인가(현지 시 기준). from > to 면 자정을 넘는다(22→7).
pub fn dim_now(hour: u8, from: u8, to: u8) -> bool {
    if from == to {
        false
    } else if from < to {
        (from..to).contains(&hour)
    } else {
        hour >= from || hour < to
    }
}

/// 번인 방지 이동 — 분(minute)마다 결정적으로 다른 자리(-max..=max, px). 같은 분이면 같은 자리.
pub fn shift_for(minute: i64, max: i32) -> (i32, i32) {
    if max <= 0 {
        return (0, 0);
    }
    let span = (2 * max + 1) as i64;
    let h = minute.wrapping_mul(2_654_435_761).rem_euclid(span * span);
    ((h % span) as i32 - max, (h / span) as i32 - max)
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

#[derive(Default)]
pub struct Display {
    pub settings: Mutex<Settings>,
    tray: Mutex<Option<TrayHandle>>,
}

struct TrayHandle {
    menu: tauri::menu::Menu<tauri::Wry>,
    status: tauri::menu::MenuItem<tauri::Wry>,
    balance: tauri::menu::MenuItem<tauri::Wry>,
    alerts: tauri::menu::MenuItem<tauri::Wry>,
    sep: tauri::menu::PredefinedMenuItem<tauri::Wry>,
    modes: Vec<(String, tauri::menu::CheckMenuItem<tauri::Wry>)>,
    summary_shown: bool,
}

pub fn settings(app: &tauri::AppHandle) -> Settings {
    app.try_state::<Display>()
        .map(|d| d.settings.lock().unwrap_or_else(|e| e.into_inner()).clone())
        .unwrap_or_else(read_settings)
}

/// 시작할 때 큰 창을 띄우나 — `ravi_companion::setup` 이 묻는다(설정 파일만 읽는다).
pub fn starts_without_main() -> bool {
    !main_at_start(&read_settings().mode, true)
}

/// 지켜보기(mini_watch)가 돌 이유 — 대기화면이 떠 있거나 창 없는 모드일 때.
pub fn wants_watch(app: &tauri::AppHandle) -> bool {
    // 잠긴 동안에도 돈다 — 잠긴 기본 화면·매장용 읽기 전용 화면의 입금 표시(읽기만).
    app.get_webview_window(STANDBY).is_some() || settings(app).mode != "window" || crate::app_lock::is_locked()
}

fn copy<'a>(locale: &str, ko: &'a str, en: &'a str) -> &'a str {
    if locale == "en" { en } else { ko }
}

fn mode_label(mode: &str, locale: &str) -> &'static str {
    let en = locale == "en";
    match (mode, en) {
        ("window", false) => "큰 창",
        ("window", true) => "Full window",
        ("mini", false) => "작은 창",
        ("mini", true) => "Mini window",
        ("chip", false) => "칩 (아주 작게)",
        ("chip", true) => "Chip (tiny)",
        (_, false) => "메뉴바만",
        (_, true) => "Menu bar only",
    }
}

/// 트레이 메뉴에 「표시 방식」 묶음을 넣고, 요약 줄을 붙일 자리를 기억한다.
/// `ravi_companion::setup` 이 메뉴를 만든 뒤 한 번 부른다.
pub fn attach_tray_menu(app: &tauri::App, menu: &tauri::menu::Menu<tauri::Wry>) -> tauri::Result<()> {
    use tauri::menu::{CheckMenuItem, MenuItem, PredefinedMenuItem, Submenu};
    let s = read_settings();
    let l = s.locale.as_str();
    let modes: Vec<(String, CheckMenuItem<tauri::Wry>)> = MODES
        .iter()
        .map(|m| CheckMenuItem::with_id(app, format!("dm-mode-{m}"), mode_label(m, l), true, s.mode == *m, None::<&str>).map(|i| (m.to_string(), i)))
        .collect::<tauri::Result<_>>()?;
    let standby = MenuItem::with_id(app, "dm-standby", copy(l, "대기화면 켜기", "Start standby screen"), true, None::<&str>)?;
    let sep = PredefinedMenuItem::separator(app)?;
    let mut items: Vec<&dyn tauri::menu::IsMenuItem<tauri::Wry>> = modes.iter().map(|(_, i)| i as &dyn tauri::menu::IsMenuItem<tauri::Wry>).collect();
    items.push(&sep);
    items.push(&standby);
    let sub = Submenu::with_items(app, copy(l, "표시 방식", "Display"), true, &items)?;
    // 「큰 화면 열기」 다음(라비 부르기·큰 화면·미니 창 묶음 뒤)에 둔다.
    let at = menu.items().map(|v| v.len().min(3)).unwrap_or(0);
    menu.insert(&sub, at)?;
    let status = MenuItem::with_id(app, "dm-sum-status", "", false, None::<&str>)?;
    let balance = MenuItem::with_id(app, "dm-sum-balance", "", false, None::<&str>)?;
    let alerts = MenuItem::with_id(app, "dm-sum-alerts", "", false, None::<&str>)?;
    let top_sep = PredefinedMenuItem::separator(app)?;
    app.manage(Display {
        settings: Mutex::new(s),
        tray: Mutex::new(Some(TrayHandle { menu: menu.clone(), status, balance, alerts, sep: top_sep, modes, summary_shown: false })),
    });
    Ok(())
}

/// 요약 줄 갱신(창 없는 모드에서만 메뉴 맨 위에 보인다). 금액은 가림 규칙을 거친 한 장에서.
pub fn on_snapshot(app: &tauri::AppHandle) {
    let Some(d) = app.try_state::<Display>() else { return };
    let s = settings(app);
    let snap = crate::mini::snapshot(app);
    if app.get_webview_window(STANDBY).is_some() {
        let _ = app.emit_to(STANDBY, "standby-snapshot", &snap);
    }
    // 잠긴 큰 창(잠긴 기본 화면·매장용 읽기 전용)도 같은 한 장(가림 적용)만 받는다.
    if crate::app_lock::is_locked() {
        let _ = app.emit_to("main", "app-lock-snapshot", &snap);
    }
    let want = s.mode != "window";
    let mut guard = d.tray.lock().unwrap_or_else(|e| e.into_inner());
    let Some(t) = guard.as_mut() else { return };
    let lines = tray_lines(&snap, &s.tray_text, &s.locale);
    if want {
        let _ = t.status.set_text(&lines.status);
        let _ = t.balance.set_text(&lines.balance);
        let _ = t.alerts.set_text(&lines.alerts);
    }
    if s.tray_text != "alerts" {
        if let Some(tray) = app.tray_by_id("main") {
            let _ = tray.set_title(lines.title.as_deref());
        }
    }
    if want != t.summary_shown {
        let ok = if want {
            t.menu.prepend_items(&[&t.status, &t.balance, &t.alerts, &t.sep]).is_ok()
        } else {
            [&t.status as &dyn tauri::menu::IsMenuItem<tauri::Wry>, &t.balance, &t.alerts, &t.sep]
                .iter()
                .all(|i| t.menu.remove(*i).is_ok())
        };
        if ok {
            t.summary_shown = want;
        }
    }
}

/// `mini::badge` 가 아이콘 옆 글자를 직접 써도 되나(기본 alerts = 새 소식 수). 잔액·없음은 `on_snapshot` 이 쓴다.
/// ⚠️ `mini::deliver` 는 지켜보기 잠금을 쥔 채 badge 를 부른다 — 여기서 한 장(snapshot)을 만들면 교착. 설정만 본다.
pub fn badge_sets_title(app: &tauri::AppHandle) -> bool {
    settings(app).tray_text == "alerts"
}

fn tray_ok(app: &tauri::AppHandle) -> bool {
    app.tray_by_id("main").is_some()
}

#[cfg(target_os = "macos")]
fn dock(app: &tauri::AppHandle, visible: bool) {
    let _ = app.set_dock_visibility(visible);
}
#[cfg(not(target_os = "macos"))]
fn dock(_app: &tauri::AppHandle, _visible: bool) {}

/// 모드를 실제 창에 적용한다.
fn enact(app: &tauri::AppHandle, s: &Settings, starting: bool) -> Result<(), String> {
    if s.mode != "window" && !tray_ok(app) {
        // 트레이가 없으면 창을 다 숨겼을 때 돌아올 길이 없다.
        return Err(copy(&s.locale, "이 컴퓨터에서는 트레이를 쓸 수 없어 큰 창만 쓸 수 있어요.", "No tray on this computer — only the full window is available.").into());
    }
    let hide_main = |app: &tauri::AppHandle| {
        if let Some(w) = app.get_webview_window("main") {
            let _ = w.hide();
        }
    };
    match s.mode.as_str() {
        "mini" | "chip" => {
            let size = crate::mini::settings(app).size;
            let want = if s.mode == "chip" { "xs".to_string() } else if size == "xs" { "m".to_string() } else { size };
            crate::mini::mini_set(app.clone(), crate::mini::Prefs { size: Some(want), ..Default::default() })?;
            crate::mini::show(app)?;
            hide_main(app);
            dock(app, true);
        }
        "menubar" => {
            let _ = crate::mini::hide(app);
            hide_main(app);
            dock(app, !s.hide_dock);
        }
        _ => {
            dock(app, true);
            if !starting {
                crate::ravi_companion::open_main(app)?;
            }
        }
    }
    if let Some(t) = app.tray_by_id("main") {
        // 메뉴바만: 왼쪽 클릭에 바로 요약 메뉴(윈도우·맥). 리눅스는 트레이 클릭 이벤트가 없다.
        let _ = t.set_show_menu_on_left_click(s.mode == "menubar");
    }
    sync_tray(app, s);
    on_snapshot(app);
    Ok(())
}

fn sync_tray(app: &tauri::AppHandle, s: &Settings) {
    if let Some(d) = app.try_state::<Display>() {
        if let Some(t) = d.tray.lock().unwrap_or_else(|e| e.into_inner()).as_ref() {
            for (m, item) in &t.modes {
                let _ = item.set_checked(*m == s.mode);
            }
        }
    }
    // 아이콘 옆 글자도 새 설정으로.
    let unseen = app.state::<crate::mini::Mini>().feed.lock().map(|f| f.unseen).unwrap_or(0);
    crate::mini::badge(app, unseen);
}

fn store(app: &tauri::AppHandle, s: Settings) -> Result<(), String> {
    persist(&s)?;
    if let Some(d) = app.try_state::<Display>() {
        *d.settings.lock().map_err(|_| FAILURE)? = s;
    }
    Ok(())
}

fn ui(app: &tauri::AppHandle, s: &Settings) -> Value {
    json!({
        "settings": s,
        "supports": {
            "dock": cfg!(target_os = "macos"),
            "tray_text": cfg!(target_os = "macos"),
            "tray": tray_ok(app),
            "tray_click_menu": cfg!(any(target_os = "macos", target_os = "windows")),
            "os": std::env::consts::OS,
        },
        "standby_open": app.get_webview_window(STANDBY).is_some(),
    })
}

#[tauri::command]
pub fn display_mode_get(app: tauri::AppHandle) -> Value {
    ui(&app, &settings(&app))
}

#[tauri::command(async)]
pub fn display_mode_set(app: tauri::AppHandle, prefs: Prefs) -> Result<Value, String> {
    let prev = settings(&app);
    let next = apply_prefs(prev.clone(), prefs)?;
    if next.mode != "window" && !tray_ok(&app) {
        return Err(copy(&next.locale, "이 컴퓨터에서는 트레이를 쓸 수 없어 큰 창만 쓸 수 있어요.", "No tray on this computer — only the full window is available.").into());
    }
    store(&app, next.clone())?;
    // 모드가 바뀔 때만 창을 움직인다(어둡게 할 시간 같은 칸만 바꾸면 창은 그대로).
    if prev.mode != next.mode || prev.hide_dock != next.hide_dock {
        enact(&app, &next, false)?;
    } else {
        sync_tray(&app, &next);
        on_snapshot(&app);
    }
    Ok(ui(&app, &next))
}

/// 대기화면 열기 — 큰 창이 있는 모니터(없으면 첫 모니터)를 덮는 전체 화면, 읽기 전용.
#[tauri::command]
pub async fn standby_open(app: tauri::AppHandle) -> Result<(), String> {
    checked_standby_open(&app).await
}

/// 🔴 지갑 암호가 없으면 대기화면(= 잠금)을 켜지 않는다 — 잠가 봐야 누구나 풀 수 있다. 암호 설정을 안내한다.
async fn checked_standby_open(app: &tauri::AppHandle) -> Result<(), String> {
    crate::app_lock::require_secret_to_lock().await?;
    open_standby(app)
}

fn open_standby(app: &tauri::AppHandle) -> Result<(), String> {
    // 🔴 들어가는 **순간** 지갑을 잠근다(대표 결정 2026-10-11) — 창을 만들기 전에. 창 만들기가 실패해도
    //    잠금은 남는다(안전한 쪽). 끌 때는 인증 없이 잠긴 기본 화면으로(`exit_standby` 는 풀지 않는다).
    //    저장 실패는 메모리 잠금이 이미 걸렸으므로 대기화면을 막지 않는다.
    let _ = crate::app_lock::lock("standby");
    if let Some(w) = app.get_webview_window(STANDBY) {
        let _ = w.set_focus();
        return Ok(());
    }
    let s = settings(app);
    let guard = crate::mini::settings(app).capture_guard;
    let w = tauri::WebviewWindowBuilder::new(app, STANDBY, tauri::WebviewUrl::App("standby.html".into()))
        .title(copy(&s.locale, "레이븐볼트 대기화면", "RavenVault standby"))
        .decorations(false)
        .resizable(false)
        .skip_taskbar(true)
        .visible(false)
        .focused(true)
        .content_protected(guard)
        .build()
        .map_err(|_| FAILURE)?;
    let target = app
        .get_webview_window("main")
        .and_then(|m| m.current_monitor().ok().flatten())
        .or_else(|| w.primary_monitor().ok().flatten());
    if let Some(m) = target {
        let _ = w.set_position(*m.position());
    }
    let h = app.clone();
    w.on_window_event(move |e| {
        if let tauri::WindowEvent::CloseRequested { api, .. } = e {
            api.prevent_close();
            let _ = exit_standby(&h);
        }
    });
    let _ = w.set_fullscreen(true);
    w.show().map_err(|_| FAILURE)?;
    let _ = w.set_focus();
    on_snapshot(app);
    Ok(())
}

fn exit_standby(app: &tauri::AppHandle) -> Result<(), String> {
    if let Some(w) = app.get_webview_window(STANDBY) {
        // 숨기지 않고 닫는다 — 대기화면 타이머(시계·이동)가 뒤에서 돌지 않게.
        let _ = w.destroy();
    }
    // 원래 모드로. 큰 창 모드면 큰 창을 앞으로.
    let s = settings(app);
    enact(app, &s, false)
}

#[tauri::command]
pub fn standby_state(app: tauri::AppHandle) -> Value {
    let s = settings(&app);
    json!({
        "snapshot": crate::mini::snapshot(&app),
        "settings": {"dim_from": s.dim_from, "dim_to": s.dim_to, "shift": s.shift, "locale": s.locale},
    })
}

#[tauri::command(async)]
pub fn standby_exit(app: tauri::AppHandle) -> Result<(), String> {
    exit_standby(&app)
}

pub fn on_menu(app: &tauri::AppHandle, id: &str) {
    let r = if let Some(m) = id.strip_prefix("dm-mode-") {
        display_mode_set(app.clone(), Prefs { mode: Some(m.to_string()), ..Default::default() }).map(|_| ())
    } else if id == "dm-standby" {
        // 트레이 메뉴는 비동기로 확인한다. 막히면 큰 창에 안내를 띄운다(메뉴는 말할 데가 없다).
        let h = app.clone();
        tauri::async_runtime::spawn(async move {
            if let Err(e) = checked_standby_open(&h).await {
                if let Some(w) = h.get_webview_window("main") {
                    let _ = w.show();
                    let _ = w.set_focus();
                }
                let _ = h.emit("app-lock-refused", e);
                sync_tray(&h, &settings(&h));
            }
        });
        Ok(())
    } else {
        Ok(())
    };
    if r.is_err() {
        sync_tray(app, &settings(app));
    }
}

/// 큰 창에 손이 가면 독 아이콘을 돌려준다(메뉴바만 + 독 숨김일 때). 숨김은 모드를 다시 고르거나 다음 실행에.
pub fn on_main_event(app: &tauri::AppHandle, e: &tauri::WindowEvent) {
    if let tauri::WindowEvent::Focused(true) = e {
        let s = settings(app);
        if s.mode == "menubar" && s.hide_dock {
            dock(app, true);
        }
    }
}

/// 시작 때 한 번 — 창 없는 모드면 미니/칩을 띄우거나 독을 숨긴다(큰 창은 `ravi_companion` 이 이미 안 띄웠다).
pub fn setup(app: &mut tauri::App) {
    let h = app.handle().clone();
    if app.try_state::<Display>().is_none() {
        app.manage(Display { settings: Mutex::new(read_settings()), tray: Mutex::new(None) });
    }
    let s = settings(&h);
    if s.mode != "window" {
        if enact(&h, &s, true).is_err() {
            // 트레이가 없으면 큰 창으로 돌아간다(돌아올 길을 남긴다).
            let _ = crate::ravi_companion::open_main(&h);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn snap(masked: bool, unseen: u64, state: &str) -> Value {
        json!({
            "masked": masked, "status": if state == "ok" { "ok" } else { "bad" },
            "node": {"state": state, "peers": 8},
            "balance": {"known": true, "confirmed": if masked { Value::Null } else { json!("1,234.56789") }},
            "unseen": unseen,
        })
    }

    #[test]
    fn standby_can_only_reach_its_two_read_only_commands() {
        for c in [
            "send_rvn", "send_asset", "wallet_send_signed", "unlock_for", "reveal_seed", "words_restore_start",
            "sales_account_reveal", "sign_message", "wallet_balance", "mini_set", "display_mode_set", "standby_open",
            "open_external", "mode_set", "install_update",
        ] {
            assert!(!command_allowed(STANDBY, c), "대기화면이 {c} 를 부를 수 있으면 안 된다");
            assert!(command_allowed("main", c));
        }
        for c in STANDBY_COMMANDS {
            assert!(command_allowed(STANDBY, c));
            for bad in ["send", "sign", "seed", "pass", "unlock", "key", "word", "reveal", "set"] {
                assert!(!c.contains(bad), "{c}");
            }
        }
        assert_eq!(STANDBY_COMMANDS.len(), 2, "늘릴 때는 이 시험과 docs/design/window-modes.md 를 같이 고친다");
    }

    #[test]
    fn mini_window_cannot_change_display_mode_or_open_standby() {
        // 칩은 미니 창의 한 크기 — 미니 문지기가 그대로 막는다.
        for c in ["display_mode_set", "display_mode_get", "standby_open", "standby_exit"] {
            assert!(!crate::mini::command_allowed(crate::mini::LABEL, c), "{c}");
        }
    }

    #[test]
    fn lib_routes_standby_through_the_gate_before_the_handler() {
        let lib = include_str!("lib.rs");
        let gate = lib.find("display_mode::command_allowed").expect("lib.rs 에 대기화면 문지기가 있어야 한다");
        assert!(gate < lib.find("generate_handler!").unwrap());
        for c in STANDBY_COMMANDS.iter().chain(["display_mode_get", "display_mode_set", "standby_open"].iter()) {
            assert!(lib.contains(&format!("display_mode::{c}")), "{c} 등록");
        }
    }

    #[test]
    fn standby_capability_is_event_listen_only() {
        let cap: Value = serde_json::from_str(include_str!("../capabilities/standby.json")).unwrap();
        assert_eq!(cap["windows"], json!([STANDBY]));
        let allowed = ["core:event:allow-listen", "core:event:allow-unlisten"];
        for p in cap["permissions"].as_array().unwrap() {
            assert!(allowed.contains(&p.as_str().unwrap()), "대기화면에 넓은 권한: {p}");
        }
        for f in [include_str!("../capabilities/default.json"), include_str!("../capabilities/companion.json"), include_str!("../capabilities/mini.json")] {
            let v: Value = serde_json::from_str(f).unwrap();
            assert!(!v["windows"].as_array().unwrap().iter().any(|w| w == STANDBY));
        }
    }

    #[test]
    fn defaults_and_validation() {
        let s = Settings::default();
        assert!(s.valid());
        assert_eq!(s.mode, "window", "기본은 지금과 같은 큰 창");
        assert_eq!(s.tray_text, "alerts", "메뉴막대 글자 기본 = 새 소식 수(금액 아님)");
        assert!(apply_prefs(s.clone(), Prefs { mode: Some("standby".into()), ..Default::default() }).is_err(), "대기화면은 모드가 아니라 동작");
        assert!(apply_prefs(s.clone(), Prefs { tray_text: Some("address".into()), ..Default::default() }).is_err());
        assert!(apply_prefs(s.clone(), Prefs { dim_from: Some(24), ..Default::default() }).is_err());
        assert_eq!(apply_prefs(s.clone(), Prefs { mode: Some("chip".into()), ..Default::default() }).unwrap().mode, "chip");
        assert!(serde_json::from_str::<Prefs>(r#"{"seed":"x"}"#).is_err());
        assert!(serde_json::from_str::<Prefs>(r#"{"mask":false}"#).is_err(), "가림은 미니 설정 한 곳에서만");
    }

    #[test]
    fn main_window_at_start_only_in_window_mode_or_without_tray() {
        assert!(main_at_start("window", true));
        assert!(!main_at_start("menubar", true));
        assert!(!main_at_start("chip", true));
        for m in MODES {
            assert!(main_at_start(m, false), "트레이가 없으면 {m} 이어도 큰 창");
        }
    }

    #[test]
    fn tray_lines_never_show_amounts_when_masked() {
        let t = tray_lines(&snap(true, 3, "ok"), "balance", "ko");
        assert_eq!(t.balance, "잔액 ••••");
        assert_eq!(t.title.as_deref(), Some("••••"));
        assert_eq!(t.status, "● 노드 정상 · 연결 8곳");
        assert_eq!(t.alerts, "새 소식 3");
        for s in [&t.status, &t.balance, &t.alerts] {
            assert!(!s.contains("1,234") && !s.contains("RVN"), "{s}");
        }
        let open = tray_lines(&snap(false, 0, "ok"), "balance", "en");
        assert_eq!(open.balance, "Balance 1,234.56 RVN");
        assert_eq!(open.title.as_deref(), Some("1,234.56 RVN"));
        assert_eq!(tray_lines(&snap(false, 0, "ok"), "alerts", "ko").title, None);
        assert_eq!(tray_lines(&snap(false, 120, "ok"), "alerts", "ko").title.as_deref(), Some("99"));
        assert_eq!(tray_lines(&snap(false, 4, "ok"), "none", "ko").title, None);
        let down = tray_lines(&snap(true, 0, "down"), "alerts", "ko");
        assert_eq!(down.status, "▲ 노드 응답 없음", "응답 없음이면 연결 수를 안 붙인다");
    }

    #[test]
    fn short_amounts() {
        assert_eq!(short_amount(Some("1,234.56789")), "1,234.56");
        assert_eq!(short_amount(Some("12.50")), "12.5");
        assert_eq!(short_amount(Some("7.00000")), "7");
        assert_eq!(short_amount(Some("42")), "42");
        assert_eq!(short_amount(None), "••••");
    }

    #[test]
    fn dimming_window_wraps_midnight() {
        assert!(dim_now(23, 22, 7) && dim_now(3, 22, 7) && !dim_now(12, 22, 7) && !dim_now(7, 22, 7));
        assert!(dim_now(13, 12, 14) && !dim_now(14, 12, 14));
        assert!(!dim_now(5, 6, 6), "같으면 끔");
    }

    #[test]
    fn burn_in_shift_is_bounded_and_moves() {
        let mut seen = std::collections::HashSet::new();
        for m in 0..120 {
            let (x, y) = shift_for(m, 24);
            assert!((-24..=24).contains(&x) && (-24..=24).contains(&y));
            seen.insert((x, y));
        }
        assert!(seen.len() > 60, "두 시간 동안 자리가 충분히 바뀐다: {}", seen.len());
        assert_eq!(shift_for(5, 24), shift_for(5, 24));
        assert_eq!(shift_for(5, 0), (0, 0));
        // 화면(standby-view.ts shiftFor)과 같은 값 — scripts/window-modes.test.mjs 가 같은 셋을 잰다.
        assert_eq!(shift_for(5, 24), (22, -12));
        assert_eq!(shift_for(29_000_000, 24), (23, 1));
        assert_eq!(shift_for(29_000_001, 24), (-7, 14));
    }

    #[test]
    fn settings_file_private_and_corrupt_fallback() {
        let _env = crate::paths::TEST_ENV.lock().unwrap_or_else(|e| e.into_inner());
        let s = Settings { mode: "menubar".into(), tray_text: "balance".into(), ..Settings::default() };
        persist(&s).unwrap();
        assert_eq!(read_settings(), s);
        assert!(starts_without_main());
        let path = crate::paths::app_file(FILE);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(std::fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);
        }
        std::fs::write(&path, br#"{"mode":"menubar","passphrase":"x"}"#).unwrap();
        assert_eq!(read_settings(), Settings::default());
        assert!(!starts_without_main());
        std::fs::remove_file(path).unwrap();
    }
}
