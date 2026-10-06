//! Small resident surface. No AI, wallet RPC, secrets, or service ownership here.
use crate::companion_layout::{layout, Layout};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use tauri::{Emitter, Manager};
const FAILURE: &str = "라비 창 설정을 적용하지 못했어요.";
struct TrayControls {
    greeting: tauri::menu::CheckMenuItem<tauri::Wry>,
    auto: tauri::menu::CheckMenuItem<tauri::Wry>,
    call: tauri::menu::MenuItem<tauri::Wry>,
    large: tauri::menu::MenuItem<tauri::Wry>,
    quit: tauri::menu::MenuItem<tauri::Wry>,
}
fn tray_copy(locale: &str, key: usize) -> &'static str {
    let col = match locale {
        "ko" => 0,
        "ja" => 2,
        "zh" => 3,
        _ => 1,
    };
    [
        [
            "라비 부르기 / 숨기기",
            "Call / hide Ravi",
            "ラビを呼ぶ / 隠す",
            "呼叫 / 隐藏拉比",
        ],
        [
            "큰 화면 열기",
            "Open main window",
            "メイン画面を開く",
            "打开主窗口",
        ],
        [
            "시작 인사",
            "Startup greeting",
            "起動時のあいさつ",
            "启动问候",
        ],
        [
            "로그인 때 자동 실행",
            "Start at login",
            "ログイン時に起動",
            "登录时启动",
        ],
        [
            "종료 (손님 주문도 멈춥니다)",
            "Quit (also stops orders)",
            "終了（注文受付も停止）",
            "退出（也停止接单）",
        ],
        [
            "레이븐볼트 · 라비",
            "RavenVault · Ravi",
            "RavenVault · ラビ",
            "RavenVault · 拉比",
        ],
    ][key][col]
}
const SHORTCUTS: [&str; 3] = ["Alt+Space", "Alt+Shift+Space", "Control+Shift+Space"];

#[derive(Clone, Serialize, Deserialize, Debug, PartialEq)]
#[serde(default, deny_unknown_fields)]
pub struct Settings {
    pub always_visible: bool,
    pub quiet_start: u8,
    pub quiet_end: u8,
    pub daily_limit: u8,
    pub timezone: i32,
    pub locale: String,
    pub notice_seen: bool,
    pub alert_day: i64,
    pub alert_count: u8,
    pub muted_day: i64,
    pub size: u16,
    pub greeting: bool,
    pub sound: bool,
    pub reduced: bool,
    pub battery: bool,
    pub resident_start: bool,
    pub simple_window: bool,
    pub shortcut: String,
    pub x: Option<i32>,
    pub y: Option<i32>,
}
impl Default for Settings {
    fn default() -> Self {
        Self {
            always_visible: false,
            quiet_start: 22,
            quiet_end: 8,
            daily_limit: 5,
            timezone: 0,
            locale: "ko".into(),
            notice_seen: false,
            alert_day: -1,
            alert_count: 0,
            muted_day: -1,
            size: 160,
            greeting: true,
            sound: false,
            reduced: false,
            battery: false,
            resident_start: false,
            simple_window: false,
            shortcut: SHORTCUTS[0].into(),
            x: None,
            y: None,
        }
    }
}
impl Settings {
    fn valid(&self) -> bool {
        [120, 160, 200].contains(&self.size)
            && SHORTCUTS.contains(&self.shortcut.as_str())
            && self.quiet_start < 24
            && self.quiet_end < 24
            && self.daily_limit <= 20
            && (-840..=840).contains(&self.timezone)
            && ["ko", "en", "ja", "zh"].contains(&self.locale.as_str())
    }
}
#[derive(Default)]
struct Resident {
    settings: Mutex<Settings>,
    bubble: Mutex<bool>,
    main_opened: std::sync::atomic::AtomicBool,
    layout: Mutex<Layout>,
    message: Mutex<String>,
    generation: AtomicU64,
    responding: std::sync::atomic::AtomicBool,
}
#[derive(Serialize, Debug)]
struct Platform {
    transparent: bool,
    decorated: bool,
    top: bool,
    movable: bool,
    notice: &'static str,
}
fn platform(os: &str, wayland: bool, simple: bool) -> Platform {
    if simple || (os == "linux" && wayland) {
        return Platform {
            transparent: false,
            decorated: true,
            top: false,
            movable: false,
            notice: "이 환경에서는 일반 작은 창을 사용해요. 창틀로 옮길 수 있어요.",
        };
    }
    Platform {
        transparent: true,
        decorated: false,
        top: true,
        movable: true,
        notice: "",
    }
}
fn current_platform(s: &Settings) -> Platform {
    platform(
        std::env::consts::OS,
        std::env::var_os("WAYLAND_DISPLAY").is_some(),
        s.simple_window,
    )
}
#[derive(Clone, Copy, Debug, PartialEq)]
struct Rect {
    x: i32,
    y: i32,
    w: i32,
    h: i32,
}
fn clamp(x: i32, y: i32, w: i32, h: i32, monitors: &[Rect]) -> (i32, i32) {
    monitors
        .iter()
        .map(|m| {
            let px = x.clamp(m.x, m.x.saturating_add((m.w - w).max(0)));
            let py = y.clamp(m.y, m.y.saturating_add((m.h - h).max(0)));
            let distance = (x as i128 - px as i128).pow(2) + (y as i128 - py as i128).pow(2);
            (distance, px, py)
        })
        .min_by_key(|p| p.0)
        .map(|p| (p.1, p.2))
        .unwrap_or((0, 0))
}
fn monitors(w: &tauri::WebviewWindow) -> Vec<Rect> {
    w.available_monitors()
        .unwrap_or_default()
        .iter()
        .map(|m| {
            let a = m.work_area();
            Rect {
                x: a.position.x,
                y: a.position.y,
                w: a.size.width as i32,
                h: a.size.height as i32,
            }
        })
        .collect()
}
fn keep_inside(w: &tauri::WebviewWindow, x: i32, y: i32) -> Result<(i32, i32), String> {
    let size = w.outer_size().map_err(|_| FAILURE)?;
    let p = clamp(x, y, size.width as i32, size.height as i32, &monitors(w));
    w.set_position(tauri::PhysicalPosition::new(p.0, p.1))
        .map_err(|_| FAILURE)?;
    Ok(p)
}
fn read_settings() -> Settings {
    std::fs::read(crate::paths::app_file("ravi-companion.json"))
        .ok()
        .filter(|b| b.len() < 2048)
        .and_then(|b| serde_json::from_slice::<Settings>(&b).ok())
        .filter(Settings::valid)
        .unwrap_or_default()
}
fn persist(s: &Settings) -> Result<(), String> {
    crate::server::atomic_write_0600(
        &crate::paths::app_file("ravi-companion.json"),
        &serde_json::to_vec(s).map_err(|_| FAILURE)?,
    )
    .map_err(|_| FAILURE.into())
}
fn settings(app: &tauri::AppHandle) -> Settings {
    app.state::<Resident>()
        .settings
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clone()
}
#[tauri::command]
pub fn companion_settings(app: tauri::AppHandle) -> Value {
    let s = settings(&app);
    json!({"platform":current_platform(&s),"settings":s,"shortcuts":SHORTCUTS,
        "visible":app.get_webview_window("ravi-companion").is_some_and(|w|w.is_visible().unwrap_or(false)),
        "saved":crate::paths::app_file("ravi-companion.json").is_file(),
        "bubble":*app.state::<Resident>().bubble.lock().unwrap_or_else(|e|e.into_inner()),
        "layout":*app.state::<Resident>().layout.lock().unwrap_or_else(|e|e.into_inner()),
        "message":app.state::<Resident>().message.lock().unwrap_or_else(|e|e.into_inner()).clone(),
        "shortcut_active":false,"shortcut_notice":"전역 단축키는 공식 플러그인 설치가 필요해요. 지금은 메뉴바·트레이로 불러 주세요."})
}
#[tauri::command]
pub fn companion_save(app: tauri::AppHandle, mut value: Settings) -> Result<(), String> {
    if !value.valid() {
        return Err(FAILURE.into());
    }
    let prior = settings(&app);
    value.notice_seen |= prior.notice_seen;
    value.alert_day = prior.alert_day;
    value.alert_count = prior.alert_count;
    value.muted_day = prior.muted_day;
    value.x = prior.x;
    value.y = prior.y;
    persist(&value)?;
    *app.state::<Resident>()
        .settings
        .lock()
        .map_err(|_| FAILURE)? = value.clone();
    if let Some(controls) = app.try_state::<TrayControls>() {
        let c = controls.inner();
        let _ = c.greeting.set_checked(value.greeting);
        let _ = c.call.set_text(tray_copy(&value.locale, 0));
        let _ = c.large.set_text(tray_copy(&value.locale, 1));
        let _ = c.greeting.set_text(tray_copy(&value.locale, 2));
        let _ = c.auto.set_text(tray_copy(&value.locale, 3));
        let _ = c.quit.set_text(tray_copy(&value.locale, 4));
    }
    if let Some(tray) = app.tray_by_id("main") {
        let _ = tray.set_tooltip(Some(tray_copy(&value.locale, 5)));
    }
    let p = current_platform(&value);
    if let Some(w) = app.get_webview_window("ravi-companion") {
        let _ = w.set_title(tray_copy(&value.locale, 5));
        let _ = w.set_always_on_top(p.top);
        let _ = w.set_decorations(p.decorated);
        resize(&app, false, 140.0)?;
    }
    let _ = app.emit("companion-settings", &value);
    if !value.always_visible || main_active(&app) {
        hide(&app)?;
    } else {
        show(&app, false)?;
    }
    Ok(())
}
pub fn command_allowed(label: &str, command: &str) -> bool {
    label != "ravi-companion"
        || [
            "companion_settings",
            "companion_save",
            "companion_open_main",
            // Dictation-only boundary: transcript/consent, never general AI or keys.
            "voice_consent",
            "voice_set_consent",
            "voice_transcribe",
            "voice_cancel",
            "voice_open_microphone_settings",
            "companion_show",
            "companion_bubble",
            "companion_sample",
            "companion_move",
            "companion_dismiss",
            "companion_click",
            "companion_hold",
        ]
        .contains(&command)
}
static APP: std::sync::OnceLock<tauri::AppHandle> = std::sync::OnceLock::new();
pub fn notify_joy() {
    notify("deposit");
}
fn clock(s: &Settings) -> (i64, u8) {
    let seconds = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64
        - s.timezone as i64 * 60;
    (
        seconds.div_euclid(86400),
        (seconds.rem_euclid(86400) / 3600) as u8,
    )
}
fn allowed(s: &Settings, day: i64, hour: u8) -> bool {
    let quiet = if s.quiet_start < s.quiet_end {
        hour >= s.quiet_start && hour < s.quiet_end
    } else if s.quiet_start > s.quiet_end {
        hour >= s.quiet_start || hour < s.quiet_end
    } else {
        false
    };
    !quiet
        && s.muted_day != day
        && (s.alert_day != day || s.alert_count < s.daily_limit)
        && s.daily_limit > 0
}
pub fn notify(kind: &'static str) {
    if !["deposit", "order", "backup", "hello"].contains(&kind) {
        return;
    }
    if let Some(app) = APP.get() {
        let h = app.clone();
        let _ = app.run_on_main_thread(move || {
            // A badge remains even when quiet hours or an active main window suppress a visit.
            if let Some(tray) = h.tray_by_id("main") {
                let _ = tray.set_icon_as_template(false);
                let _ = tray.set_icon(Some(tray_badge_image()));
            }
            if h.state::<Resident>().responding.load(Ordering::Relaxed) {
                return;
            }
            if main_active(&h) {
                let _ = h.emit_to("main", "companion-notice", kind);
                return;
            }
            let mut s = settings(&h);
            let (day, hour) = clock(&s);
            if !allowed(&s, day, hour) {
                return;
            }
            if s.alert_day != day {
                s.alert_day = day;
                s.alert_count = 0;
            }
            s.alert_count += 1;
            if persist(&s).is_err() {
                return;
            }
            *h.state::<Resident>()
                .settings
                .lock()
                .unwrap_or_else(|e| e.into_inner()) = s;
            *h.state::<Resident>()
                .message
                .lock()
                .unwrap_or_else(|e| e.into_inner()) = kind.into();
            if show(&h, false).is_ok() {
                let _ = resize(&h, true, 140.0);
                let _ = h.emit_to("ravi-companion", "companion-notice", kind);
                expire(&h);
            }
        });
    }
}
fn main_active(app: &tauri::AppHandle) -> bool {
    app.get_webview_window("main")
        .is_some_and(|w| w.is_focused().unwrap_or(false) && !w.is_minimized().unwrap_or(false))
}
fn hide(app: &tauri::AppHandle) -> Result<(), String> {
    app.state::<Resident>()
        .responding
        .store(false, Ordering::Relaxed);
    app.state::<Resident>()
        .generation
        .fetch_add(1, Ordering::Relaxed);
    hit_visibility(app, false);
    if let Some(w) = app.get_webview_window("ravi-companion") {
        let _ = w.emit("companion-visible", false);
        w.hide().map_err(|_| FAILURE)?;
    }
    Ok(())
}
fn expire(app: &tauri::AppHandle) {
    let id = app
        .state::<Resident>()
        .generation
        .fetch_add(1, Ordering::Relaxed)
        + 1;
    let h = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_secs(12)).await;
        let app = h.clone();
        let _ = h.run_on_main_thread(move || {
            if app.state::<Resident>().generation.load(Ordering::Relaxed) != id {
                return;
            }
            if settings(&app).always_visible && !main_active(&app) {
                let _ = resize(&app, false, 140.0);
            } else {
                let _ = hide(&app);
            }
        });
    });
}
#[tauri::command]
pub fn companion_hold(app: tauri::AppHandle, hold: bool) {
    app.state::<Resident>()
        .responding
        .store(hold, Ordering::Relaxed);
    if hold {
        app.state::<Resident>()
            .generation
            .fetch_add(1, Ordering::Relaxed);
    } else {
        expire(&app);
    }
}
#[tauri::command]
pub fn companion_dismiss(app: tauri::AppHandle, today: bool) -> Result<(), String> {
    if today {
        let mut s = settings(&app);
        s.muted_day = clock(&s).0;
        persist(&s)?;
        *app.state::<Resident>()
            .settings
            .lock()
            .map_err(|_| FAILURE)? = s;
    }
    hide(&app)
}
#[tauri::command(async)]
pub fn companion_click(app: tauri::AppHandle) -> Result<(), String> {
    if app.get_webview_window("main").is_some() {
        open_main(&app)?;
        let _ = app.emit_to("main", "companion-chat", ());
        hide(&app)
    } else {
        resize(&app, true, 220.0)?;
        show(&app, true)
    }
}
#[derive(Default)]
struct Receipts {
    seen: std::collections::VecDeque<String>,
    sources: u8,
}
impl Receipts {
    #[cfg(test)]
    fn observe(&mut self, rows: &Value) -> bool {
        self.observe_rows(rows.as_array().into_iter().flatten(), 1)
    }
    fn observe_rows<'a>(&mut self, rows: impl Iterator<Item = &'a Value>, source: u8) -> bool {
        let initialized = self.sources & source != 0;
        let mut fresh = false;
        for row in rows.take(1024) {
            if row["category"] != "receive" {
                continue;
            }
            let Some(id) = row["txid"].as_str().filter(|s| s.len() <= 128) else {
                continue;
            };
            let id = format!("{}:{}", id, row["vout"].as_i64().unwrap_or(0));
            if !self.seen.contains(&id) {
                fresh |= initialized;
                self.seen.push_back(id);
            }
        }
        while self.seen.len() > 2048 {
            self.seen.pop_front();
        }
        self.sources |= source;
        fresh
    }
}
/// Piggyback existing RPC results; no extra wallet polling in a resident webview.
pub fn observe_rpc(method: &str, value: &Value) {
    static RECEIPTS: std::sync::OnceLock<Mutex<Receipts>> = std::sync::OnceLock::new();
    if !["listtransactions", "listsinceblock"].contains(&method) {
        return;
    }
    let rows: Vec<&Value> = if method == "listsinceblock" {
        ["transactions", "asset_transactions"]
            .iter()
            .flat_map(|key| value[*key].as_array().into_iter().flatten())
            .take(1024)
            .collect()
    } else {
        value.as_array().into_iter().flatten().take(1024).collect()
    };
    if let Ok(mut seen) = RECEIPTS
        .get_or_init(|| Mutex::new(Receipts::default()))
        .lock()
    {
        if seen.observe_rows(
            rows.into_iter(),
            if method == "listsinceblock" { 2 } else { 1 },
        ) {
            notify_joy();
        }
    }
}
fn ensure_window<T, E>(
    lookup: impl FnOnce() -> Option<T>,
    create: impl FnOnce() -> Result<T, E>,
    show: impl FnOnce(T) -> Result<(), E>,
) -> Result<(), E> {
    show(match lookup() {
        Some(w) => w,
        None => create()?,
    })
}
pub fn open_main(app: &tauri::AppHandle) -> Result<(), String> {
    ensure_window(
        || app.get_webview_window("main"),
        || {
            let config = app.config().app.windows.first().ok_or(FAILURE)?;
            let reopen = app
                .state::<Resident>()
                .main_opened
                .load(std::sync::atomic::Ordering::Relaxed);
            let s = settings(app);
            let mut builder =
                tauri::WebviewWindowBuilder::from_config(app, config).map_err(|_| FAILURE)?;
            if reopen || s.resident_start {
                builder = builder.initialization_script(
                    "try { sessionStorage.setItem('rv-ravi-start-seen','1'); } catch {}",
                );
            }
            if crate::paths::app_file("ravi-companion.json").is_file() {
                builder = builder.initialization_script(if s.greeting {
                    "try { localStorage.setItem('rv-ravi-start-off','0'); } catch {}"
                } else {
                    "try { localStorage.setItem('rv-ravi-start-off','1'); } catch {}"
                });
            }
            let w = builder.build().map_err(|_| FAILURE)?;
            app.state::<Resident>()
                .main_opened
                .store(true, std::sync::atomic::Ordering::Relaxed);
            let h = app.clone();
            w.on_window_event(move |e| {
                if let tauri::WindowEvent::DragDrop(d) = e {
                    let (name, payload) = match d {
                        tauri::DragDropEvent::Enter { .. } => ("drop-enter", json!({})),
                        tauri::DragDropEvent::Drop { paths, .. } => {
                            let paths: Vec<String> = paths
                                .iter()
                                .map(|p| p.to_string_lossy().into_owned())
                                .collect();
                            crate::dropbox::remember(&paths);
                            ("drop-files", json!({"paths":paths}))
                        }
                        _ => ("drop-leave", json!({})),
                    };
                    if let Some(w) = h.get_webview_window("main") {
                        let _ = w.emit(name, payload);
                    }
                }
                if matches!(
                    e,
                    tauri::WindowEvent::Focused(_) | tauri::WindowEvent::Resized(_)
                ) {
                    if main_active(&h) {
                        let _ = hide(&h);
                    } else if settings(&h).always_visible {
                        let _ = show(&h, false);
                    }
                }
                // Default close DESTROYS the webview; do not prevent_close/hide here.
                if let tauri::WindowEvent::Destroyed = e {
                    if settings(&h).always_visible {
                        let _ = show(&h, false);
                    } else {
                        let _ = hide(&h);
                    }
                }
            });
            if let Ok(Some(m)) = w.current_monitor() {
                let sf = m.scale_factor();
                let a = m.work_area().size.to_logical::<f64>(sf);
                let _ = w.set_size(tauri::LogicalSize::new(
                    1120.0_f64.min(a.width),
                    780.0_f64.min(a.height),
                ));
                let _ = w.center();
            }
            Ok(w)
        },
        |w| {
            hide(app)?;
            if let Some(tray) = app.tray_by_id("main") {
                let _ = tray.set_icon(Some(tray_image()));
                let _ = tray.set_icon_as_template(cfg!(target_os = "macos"));
            }
            w.show().map_err(|_| FAILURE)?;
            let _ = w.unminimize();
            w.set_focus().map_err(|_| FAILURE.into())
        },
    )
}
#[tauri::command(async)]
pub fn companion_open_main(app: tauri::AppHandle) -> Result<(), String> {
    open_main(&app)
}
fn resize(app: &tauri::AppHandle, bubble: bool, content: f64) -> Result<(), String> {
    let w = app.get_webview_window("ravi-companion").ok_or(FAILURE)?;
    let s = settings(app);
    let sf = w.scale_factor().unwrap_or(1.0);
    let m = w.current_monitor().map_err(|_| FAILURE)?.ok_or(FAILURE)?;
    let a = m.work_area();
    let pos = w.outer_position().map_err(|_| FAILURE)?;
    let previous = *app.state::<Resident>().layout.lock().map_err(|_| FAILURE)?;
    let aw = a.size.width as f64 / sf;
    let ah = a.size.height as f64 / sf;
    if bubble && (aw < 304.0 || ah < 400.0) {
        open_main(app)?;
        return Err(FAILURE.into());
    }
    let next = layout(
        (a.position.x as f64 / sf, a.position.y as f64 / sf, aw, ah),
        (
            pos.x as f64 / sf + previous.bird_left,
            pos.y as f64 / sf + previous.bird_top,
        ),
        s.size,
        bubble,
        content,
    );
    w.set_size(tauri::LogicalSize::new(next.width, next.height))
        .map_err(|_| FAILURE)?;
    w.set_position(tauri::LogicalPosition::new(next.x, next.y))
        .map_err(|_| FAILURE)?;
    *app.state::<Resident>().layout.lock().map_err(|_| FAILURE)? = next;
    *app.state::<Resident>().bubble.lock().map_err(|_| FAILURE)? = bubble;
    w.emit("companion-layout", next).map_err(|_| FAILURE)?;
    w.emit("companion-bubble", bubble)
        .map_err(|_| FAILURE.into())
}
pub fn show(app: &tauri::AppHandle, focus: bool) -> Result<(), String> {
    if main_active(app) {
        if focus {
            let _ = app.emit_to("main", "companion-chat", ());
        }
        return hide(app);
    }
    hit_visibility(app, true);
    let w = app.get_webview_window("ravi-companion").ok_or(FAILURE)?;
    if focus {
        *app.state::<Resident>()
            .message
            .lock()
            .map_err(|_| FAILURE)? = "call".into();
        resize(app, true, 220.0)?;
        let _ = w.emit("companion-notice", "call");
        if let Some(tray) = app.tray_by_id("main") {
            let _ = tray.set_icon(Some(tray_image()));
            let _ = tray.set_icon_as_template(cfg!(target_os = "macos"));
        }
    } else {
        resize(app, false, 140.0)?;
    }
    w.show().map_err(|_| FAILURE)?;
    if focus {
        let _ = w.set_focus();
        expire(app);
    }
    let _ = w.emit("companion-visible", true);
    Ok(())
}
#[tauri::command]
pub fn companion_show(app: tauri::AppHandle, visible: bool) -> Result<(), String> {
    if visible {
        show(&app, true)
    } else {
        hide(&app)
    }
}
#[tauri::command]
pub fn companion_bubble(
    app: tauri::AppHandle,
    open: bool,
    height: Option<f64>,
) -> Result<(), String> {
    let height = height.unwrap_or(220.0);
    if !height.is_finite() {
        return Err(FAILURE.into());
    }
    resize(&app, open, height)?;
    if !open && !settings(&app).always_visible {
        hide(&app)?;
    }
    Ok(())
}
#[tauri::command]
pub fn companion_move(app: tauri::AppHandle, x: i32, y: i32, save: bool) -> Result<Value, String> {
    let w = app.get_webview_window("ravi-companion").ok_or(FAILURE)?;
    if !current_platform(&settings(&app)).movable {
        return Err("창틀로 라비를 옮겨 주세요.".into());
    }
    let p = keep_inside(&w, x, y)?;
    if save {
        let state = app.state::<Resident>();
        let mut s = state.settings.lock().map_err(|_| FAILURE)?;
        s.x = Some(p.0);
        s.y = Some(p.1);
        persist(&s)?;
    }
    Ok(json!({"x":p.0,"y":p.1}))
}
#[tauri::command]
pub fn companion_sample(app: tauri::AppHandle) -> Result<Value, String> {
    let w = app.get_webview_window("ravi-companion").ok_or(FAILURE)?;
    let pos = w.outer_position().map_err(|_| FAILURE)?;
    let size = w.outer_size().map_err(|_| FAILURE)?;
    let cursor = w.cursor_position().ok();
    let ms = monitors(&w);
    let nearest = ms.iter().min_by_key(|m| {
        let p = clamp(pos.x, pos.y, size.width as i32, size.height as i32, &[**m]);
        (pos.x as i128 - p.0 as i128).pow(2) + (pos.y as i128 - p.1 as i128).pow(2)
    });
    Ok(
        json!({"x":pos.x,"y":pos.y,"scale":w.scale_factor().unwrap_or(1.0),
        "cursor":cursor.map(|p|json!({"x":p.x,"y":p.y})),
        "bounds":nearest.map(|m|json!({"left":m.x,"top":m.y,"right":m.x+(m.w-size.width as i32).max(0),"bottom":m.y+(m.h-size.height as i32).max(0)}))}),
    )
}
#[tauri::command]
pub fn companion_signal(app: tauri::AppHandle, kind: String) -> Result<(), String> {
    if !["joy", "sleep", "idle", "thinking", "working", "surprised"].contains(&kind.as_str()) {
        return Err(FAILURE.into());
    }
    app.emit_to("ravi-companion", "companion-state", kind)
        .map_err(|_| FAILURE.into())
}

fn build_resident(
    app: &tauri::App,
    s: &Settings,
    p: &Platform,
) -> tauri::Result<tauri::WebviewWindow> {
    let builder = tauri::WebviewWindowBuilder::new(
        app,
        "ravi-companion",
        tauri::WebviewUrl::App("companion.html".into()),
    )
    .title(tray_copy(&s.locale, 5))
    .inner_size(s.size as f64, s.size as f64)
    .resizable(false)
    .decorations(p.decorated)
    .always_on_top(p.top)
    .skip_taskbar(true)
    .shadow(false)
    .focused(false)
    .visible(false)
    .transparent(p.transparent);
    builder.build()
}

// Conservative native hit region: only the transparent outside corners pass clicks through.
// The bubble is fully interactive. No screen contents or global keystrokes are read.
fn hit_region(x: f64, y: f64, width: f64, height: f64, bubble: bool) -> bool {
    if bubble {
        return true;
    }
    let nx = (x - width * 0.5) / (width * 0.46);
    let ny = (y - height * 0.53) / (height * 0.49);
    nx * nx + ny * ny <= 1.0
}
type HitGate = std::sync::Arc<(Mutex<bool>, std::sync::Condvar)>;
fn hit_visibility(app: &tauri::AppHandle, visible: bool) {
    if !cfg!(any(target_os = "windows", target_os = "macos")) {
        return;
    }
    let Some(gate) = app.try_state::<HitGate>() else {
        return;
    };
    let gate = gate.inner();
    *gate.0.lock().unwrap_or_else(|e| e.into_inner()) = visible;
    gate.1.notify_all();
    if visible {
        if let Some(w) = app.get_webview_window("ravi-companion") {
            let _ = w.set_ignore_cursor_events(false);
        }
    }
}
fn start_hit_test(app: &tauri::AppHandle) {
    if !cfg!(any(target_os = "windows", target_os = "macos")) {
        return;
    }
    let gate: HitGate = std::sync::Arc::new((Mutex::new(false), std::sync::Condvar::new()));
    app.manage(gate.clone());
    let app = app.clone();
    std::thread::spawn(move || loop {
        let mut visible = gate.0.lock().unwrap_or_else(|e| e.into_inner());
        while !*visible {
            visible = gate.1.wait(visible).unwrap_or_else(|e| e.into_inner());
        }
        drop(visible);
        let Some(w) = app.get_webview_window("ravi-companion") else {
            break;
        };
        if let (Ok(cursor), Ok(pos), Ok(size)) =
            (w.cursor_position(), w.inner_position(), w.inner_size())
        {
            let bubble = *app
                .state::<Resident>()
                .bubble
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            let simple = settings(&app).simple_window;
            let hit = simple
                || hit_region(
                    cursor.x - pos.x as f64,
                    cursor.y - pos.y as f64,
                    size.width as f64,
                    size.height as f64,
                    bubble,
                );
            let _ = w.set_ignore_cursor_events(!hit);
        }
        let visible = gate.0.lock().unwrap_or_else(|e| e.into_inner());
        // 2 Hz native cursor hit testing only while shown; indefinite wait when hidden.
        if *visible {
            drop(
                gate.1
                    .wait_timeout(visible, std::time::Duration::from_millis(500)),
            );
        }
    });
}

pub fn setup(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    use tauri::menu::{CheckMenuItem, Menu, MenuItem};
    let _ = APP.set(app.handle().clone());
    let mut s = read_settings();
    let p = current_platform(&s);
    app.manage(Resident {
        settings: Mutex::new(s.clone()),
        bubble: Mutex::new(false),
        main_opened: std::sync::atomic::AtomicBool::new(false),
        ..Resident::default()
    });
    let w = match build_resident(app, &s, &p) {
        Ok(w) => w,
        Err(_) => {
            s.simple_window = true;
            *app.state::<Resident>()
                .settings
                .lock()
                .unwrap_or_else(|e| e.into_inner()) = s.clone();
            build_resident(app, &s, &current_platform(&s))?
        }
    };
    start_hit_test(app.handle());
    let pos = w.outer_position()?;
    let edge = monitors(&w)
        .first()
        .map(|m| {
            (
                m.x + m.w - s.size as i32 - 24,
                m.y + m.h - s.size as i32 - 24,
            )
        })
        .unwrap_or((pos.x, pos.y));
    keep_inside(&w, s.x.unwrap_or(edge.0), s.y.unwrap_or(edge.1)).map_err(std::io::Error::other)?;
    let h = app.handle().clone();
    w.on_window_event(move |e| {
        if let tauri::WindowEvent::Moved(pos) = e {
            if let Some(w) = h.get_webview_window("ravi-companion") {
                let size = w.outer_size().ok();
                let valid = size
                    .map(|size| {
                        clamp(
                            pos.x,
                            pos.y,
                            size.width as i32,
                            size.height as i32,
                            &monitors(&w),
                        )
                    })
                    .unwrap_or((pos.x, pos.y));
                if valid != (pos.x, pos.y) && current_platform(&settings(&h)).movable {
                    let _ = w.set_position(tauri::PhysicalPosition::new(valid.0, valid.1));
                }
                if !*h
                    .state::<Resident>()
                    .bubble
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                {
                    let state = h.state::<Resident>();
                    let mut s = state.settings.lock().unwrap_or_else(|e| e.into_inner());
                    s.x = Some(valid.0);
                    s.y = Some(valid.1);
                }
            }
        }
        if matches!(
            e,
            tauri::WindowEvent::Focused(false) | tauri::WindowEvent::CloseRequested { .. }
        ) {
            let _ = persist(&settings(&h));
        }
        if let tauri::WindowEvent::CloseRequested { api, .. } = e {
            api.prevent_close();
            if h.tray_by_id("main").is_some() {
                let _ = companion_show(h.clone(), false);
            } else {
                let _ = open_main(&h);
            }
        }
        if let tauri::WindowEvent::Focused(_) = e {
            // Tauri 2.11 has no portable occlusion event. Conservative blur suspension.
            let _ = h.emit_to(
                "ravi-companion",
                "companion-visible",
                h.get_webview_window("ravi-companion")
                    .is_some_and(|w| w.is_visible().unwrap_or(false)),
            );
        }
    });
    let call = MenuItem::with_id(
        app,
        "ravi-call",
        tray_copy(&s.locale, 0),
        true,
        None::<&str>,
    )?;
    let large = MenuItem::with_id(
        app,
        "ravi-large",
        tray_copy(&s.locale, 1),
        true,
        None::<&str>,
    )?;
    let greeting = CheckMenuItem::with_id(
        app,
        "ravi-greeting",
        tray_copy(&s.locale, 2),
        true,
        s.greeting,
        None::<&str>,
    )?;
    let auto = CheckMenuItem::with_id(
        app,
        "ravi-autostart",
        tray_copy(&s.locale, 3),
        true,
        crate::autostart::autostart_get(),
        None::<&str>,
    )?;
    let quit = MenuItem::with_id(
        app,
        "ravi-quit",
        tray_copy(&s.locale, 4),
        true,
        None::<&str>,
    )?;
    app.manage(TrayControls {
        call: call.clone(),
        large: large.clone(),
        greeting: greeting.clone(),
        auto: auto.clone(),
        quit: quit.clone(),
    });
    let menu = Menu::with_items(app, &[&call, &large, &greeting, &auto, &quit])?;
    let tray = tauri::tray::TrayIconBuilder::with_id("main")
        .icon(crate::ravi_companion::tray_image())
        .icon_as_template(cfg!(target_os = "macos"))
        .tooltip(tray_copy(&s.locale, 5))
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(move |app, e| match e.id().as_ref() {
            "ravi-call" => {
                if let Some(w) = app.get_webview_window("ravi-companion") {
                    let _ = companion_show(app.clone(), !w.is_visible().unwrap_or(false));
                }
            }
            "ravi-large" => {
                let _ = open_main(app);
            }
            "ravi-greeting" => {
                let mut s = settings(app);
                s.greeting = !s.greeting;
                let ok = companion_save(app.clone(), s).is_ok();
                let _ = greeting.set_checked(settings(app).greeting);
                if !ok {
                    let _ = show(app, true);
                    let _ = app.emit("companion-error", FAILURE);
                }
            }
            "ravi-autostart" => {
                let result = crate::autostart::autostart_set(!crate::autostart::autostart_get());
                let _ = auto.set_checked(crate::autostart::autostart_get());
                if result.is_err() {
                    let _ = show(app, true);
                    let _ = app.emit("companion-error", "자동 실행 설정을 바꾸지 못했어요.");
                }
            }
            "ravi-quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if matches!(
                event,
                tauri::tray::TrayIconEvent::Click {
                    button: tauri::tray::MouseButton::Left,
                    button_state: tauri::tray::MouseButtonState::Up,
                    ..
                }
            ) {
                let _ = show(tray.app_handle(), true);
            }
        })
        .build(app);
    // A missing Linux tray must never strand the application without a route back.
    if tray.is_err() || !s.resident_start {
        open_main(app.handle()).map_err(std::io::Error::other)?;
    }
    if s.resident_start && s.greeting {
        notify("hello");
    }
    if s.resident_start && s.always_visible {
        show(app.handle(), false).map_err(std::io::Error::other)?;
    }
    Ok(())
}
fn tray_badge_image() -> tauri::image::Image<'static> {
    let mut pixels = include_bytes!("../icons/ravi-tray-32.rgba").to_vec();
    for y in 0..12 {
        for x in 20..32 {
            if (x as i32 - 26).pow(2) + (y as i32 - 6).pow(2) <= 30 {
                let i = (y * 32 + x) * 4;
                pixels[i..i + 4].copy_from_slice(&[237, 99, 69, 255]);
            }
        }
    }
    tauri::image::Image::new_owned(pixels, 32, 32)
}
fn tray_image() -> tauri::image::Image<'static> {
    // Native trays require raster pixels. Source is our vector; no bitmap character animation.
    if cfg!(target_os = "macos") {
        tauri::image::Image::new_owned(
            include_bytes!("../icons/ravi-tray-template-44.rgba").to_vec(),
            44,
            44,
        )
    } else {
        tauri::image::Image::new_owned(
            include_bytes!("../icons/ravi-tray-32.rgba").to_vec(),
            32,
            32,
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn notifications_quiet_limit_mute_midnight_and_migration() {
        let mut s: Settings =
            serde_json::from_str(r#"{"size":160,"resident_start":true}"#).unwrap();
        assert!(!s.always_visible);
        for hour in 0..24 {
            assert_eq!(allowed(&s, 100, hour), (8..22).contains(&hour));
        }
        s.quiet_start = 10;
        s.quiet_end = 12;
        assert!(!allowed(&s, 100, 10));
        assert!(allowed(&s, 100, 12));
        s.quiet_start = 0;
        s.quiet_end = 0;
        s.alert_day = 100;
        s.alert_count = 5;
        assert!(!allowed(&s, 100, 12));
        assert!(allowed(&s, 101, 12));
        s.muted_day = 101;
        assert!(!allowed(&s, 101, 12));
        assert!(allowed(&s, 102, 12));
        s.daily_limit = 0;
        assert!(!allowed(&s, 102, 12));
        s.daily_limit = 21;
        assert!(!s.valid());
        for locale in ["ko", "en", "ja", "zh"] {
            for key in 0..6 {
                assert!(!tray_copy(locale, key).is_empty());
            }
        }
    }
    #[test]
    fn resident_cannot_invoke_wallet_ai_or_keys() {
        for command in [
            "send_rvn",
            "ravi_agent_chat",
            "save_api_key",
            "wallet_balance",
            "companion_signal",
        ] {
            assert!(!command_allowed("ravi-companion", command));
            assert!(command_allowed("main", command));
        }
        assert!(command_allowed("ravi-companion", "companion_open_main"));
        for command in [
            "voice_consent",
            "voice_set_consent",
            "voice_transcribe",
            "voice_cancel",
            "voice_open_microphone_settings",
        ] {
            assert!(command_allowed("ravi-companion", command));
        }
        for command in ["open_external", "ai_raw", "api_key_status", "send_asset"] {
            assert!(!command_allowed("ravi-companion", command));
        }
    }
    #[test]
    fn destroyed_main_is_recreated_then_focused() {
        use std::cell::Cell;
        let alive = Cell::new(false);
        let creates = Cell::new(0);
        let focuses = Cell::new(0);
        let open = || {
            ensure_window(
                || alive.get().then_some(()),
                || {
                    alive.set(true);
                    creates.set(creates.get() + 1);
                    Ok::<_, ()>(())
                },
                |_| {
                    focuses.set(focuses.get() + 1);
                    Ok(())
                },
            )
        };
        open().unwrap();
        open().unwrap();
        assert_eq!(creates.get(), 1);
        alive.set(false);
        open().unwrap();
        assert_eq!(creates.get(), 2);
        assert_eq!(focuses.get(), 3);
    }
    #[test]
    fn receipts_baseline_duplicates_and_new_arrival() {
        let mut seen = Receipts::default();
        let a = json!([{"category":"receive","txid":"synthetic-a","vout":0}]);
        assert!(!seen.observe(&a));
        assert!(!seen.observe(&a));
        assert!(seen.observe(&json!([{"category":"receive","txid":"synthetic-b","vout":0}])));
        assert!(!seen.observe(&a));
        assert!(!seen.observe(&json!([{"category":"send","txid":"synthetic-c"}])));
    }
    #[test]
    fn settings_file_roundtrip_private_and_corrupt_fallback() {
        let _env = crate::paths::TEST_ENV
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let s = Settings {
            size: 200,
            sound: true,
            x: Some(-700),
            y: Some(80),
            ..Settings::default()
        };
        persist(&s).unwrap();
        assert_eq!(read_settings(), s);
        let path = crate::paths::app_file("ravi-companion.json");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
        std::fs::write(&path, b"invalid fixture").unwrap();
        assert_eq!(read_settings(), Settings::default());
        std::fs::remove_file(path).unwrap();
    }
    #[test]
    fn transparent_gutters_pass_through_and_bubble_is_interactive() {
        assert!(!hit_region(0.0, 0.0, 160.0, 160.0, false));
        assert!(hit_region(80.0, 85.0, 160.0, 160.0, false));
        assert!(hit_region(0.0, 0.0, 460.0, 440.0, true));
    }
    #[test]
    fn platform_fallbacks() {
        assert!(platform("macos", false, false).transparent);
        assert!(platform("windows", false, false).transparent);
        assert!(platform("linux", false, false).top);
        assert!(platform("linux", true, false).decorated);
        assert!(!platform("linux", true, false).movable);
        assert!(!platform("windows", false, true).top);
    }
    #[test]
    fn settings_roundtrip_and_rejection() {
        let s = Settings::default();
        assert_eq!(
            serde_json::from_slice::<Settings>(&serde_json::to_vec(&s).unwrap()).unwrap(),
            s
        );
        assert!(!s.sound);
        assert!(!Settings {
            size: 900,
            ..s.clone()
        }
        .valid());
        assert!(!Settings {
            shortcut: "arbitrary".into(),
            ..s
        }
        .valid());
        assert!(serde_json::from_str::<Settings>(r#"{"key":"never-store"}"#).is_err());
    }
    #[test]
    fn disconnected_and_negative_monitors() {
        let ms = [
            Rect {
                x: -1920,
                y: 0,
                w: 1920,
                h: 1080,
            },
            Rect {
                x: 200,
                y: 100,
                w: 1600,
                h: 900,
            },
        ];
        assert_eq!(clamp(-3000, 3000, 160, 160, &ms), (-1920, 920));
        assert_eq!(clamp(50, 50, 160, 160, &ms), (200, 100));
        assert_eq!(clamp(i32::MAX, 0, 160, 160, &ms), (1640, 100));
        assert_eq!(clamp(-500, 0, 160, 160, &ms[1..]), (200, 100));
    }
}
