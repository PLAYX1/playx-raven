//! Small resident surface. No AI, wallet RPC, secrets, or service ownership here.
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::sync::Mutex;
use tauri::{Emitter, Manager};
const FAILURE: &str = "라비 창 설정을 적용하지 못했어요.";
struct TrayControls(tauri::menu::CheckMenuItem<tauri::Wry>);
const SHORTCUTS: [&str; 3] = ["Alt+Space", "Alt+Shift+Space", "Control+Shift+Space"];

#[derive(Clone, Serialize, Deserialize, Debug, PartialEq)]
#[serde(default, deny_unknown_fields)]
pub struct Settings {
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
        [120, 160, 200].contains(&self.size) && SHORTCUTS.contains(&self.shortcut.as_str())
    }
}
#[derive(Default)]
struct Resident {
    settings: Mutex<Settings>,
    bubble: Mutex<bool>,
    main_opened: std::sync::atomic::AtomicBool,
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
        transparent: os != "macos",
        decorated: false,
        top: true,
        movable: true,
        notice: if os == "macos" {
            "맥에서는 작은 배경판과 함께 나타나요."
        } else {
            "창 효과가 불편하면 ‘일반 작은 창’을 켜 주세요."
        },
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
        "saved":crate::paths::app_file("ravi-companion.json").is_file(),
        "bubble":*app.state::<Resident>().bubble.lock().unwrap_or_else(|e|e.into_inner()),
        "shortcut_active":false,"shortcut_notice":"전역 단축키는 공식 플러그인 설치가 필요해요. 지금은 메뉴바·트레이로 불러 주세요."})
}
#[tauri::command]
pub fn companion_save(app: tauri::AppHandle, mut value: Settings) -> Result<(), String> {
    if !value.valid() {
        return Err(FAILURE.into());
    }
    let prior = settings(&app);
    value.x = prior.x;
    value.y = prior.y;
    persist(&value)?;
    *app.state::<Resident>()
        .settings
        .lock()
        .map_err(|_| FAILURE)? = value.clone();
    if let Some(controls) = app.try_state::<TrayControls>() {
        let _ = controls.inner().0.set_checked(value.greeting);
    }
    let p = current_platform(&value);
    if let Some(w) = app.get_webview_window("ravi-companion") {
        let _ = w.set_always_on_top(p.top);
        let _ = w.set_decorations(p.decorated);
        resize(&app, false)?;
    }
    let _ = app.emit("companion-settings", &value);
    Ok(())
}
pub fn command_allowed(label: &str, command: &str) -> bool {
    label != "ravi-companion"
        || [
            "companion_settings",
            "companion_save",
            "companion_open_main",
            "companion_show",
            "companion_bubble",
            "companion_sample",
            "companion_move",
        ]
        .contains(&command)
}
static APP: std::sync::OnceLock<tauri::AppHandle> = std::sync::OnceLock::new();
pub fn notify_joy() {
    if let Some(app) = APP.get() {
        let _ = app.emit_to("ravi-companion", "companion-state", "joy");
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
                // Default close DESTROYS the webview; do not prevent_close/hide here.
                if let tauri::WindowEvent::Destroyed = e {
                    let _ = show(&h, false);
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
fn resize(app: &tauri::AppHandle, bubble: bool) -> Result<(), String> {
    let w = app.get_webview_window("ravi-companion").ok_or(FAILURE)?;
    let s = settings(app);
    let pos = w.outer_position().map_err(|_| FAILURE)?;
    let sf = w.scale_factor().unwrap_or(1.0);
    let area = w
        .current_monitor()
        .ok()
        .flatten()
        .map(|m| m.work_area().size.to_logical::<f64>(sf));
    let (width, height) = if bubble {
        (460.0, 440.0)
    } else {
        (s.size as f64, s.size as f64)
    };
    w.set_size(tauri::LogicalSize::new(
        area.map_or(width, |a| width.min(a.width)),
        area.map_or(height, |a| height.min(a.height)),
    ))
    .map_err(|_| FAILURE)?;
    keep_inside(&w, pos.x, pos.y)?;
    *app.state::<Resident>().bubble.lock().map_err(|_| FAILURE)? = bubble;
    w.emit("companion-bubble", bubble)
        .map_err(|_| FAILURE.into())
}
pub fn show(app: &tauri::AppHandle, focus: bool) -> Result<(), String> {
    hit_visibility(app, true);
    let w = app.get_webview_window("ravi-companion").ok_or(FAILURE)?;
    w.show().map_err(|_| FAILURE)?;
    if focus {
        resize(app, true)?;
        let _ = w.set_focus();
    }
    let _ = w.emit("companion-visible", true);
    Ok(())
}
#[tauri::command]
pub fn companion_show(app: tauri::AppHandle, visible: bool) -> Result<(), String> {
    if visible {
        return show(&app, true);
    }
    hit_visibility(&app, false);
    if let Some(w) = app.get_webview_window("ravi-companion") {
        let _ = w.emit("companion-visible", false);
        w.hide().map_err(|_| FAILURE)?;
    }
    Ok(())
}
#[tauri::command]
pub fn companion_bubble(app: tauri::AppHandle, open: bool) -> Result<(), String> {
    resize(&app, open)
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
    .title("레이븐볼트 · 라비")
    .inner_size(s.size as f64, s.size as f64)
    .resizable(false)
    .decorations(p.decorated)
    .always_on_top(p.top)
    .skip_taskbar(true)
    .shadow(false)
    .focused(false);
    #[cfg(not(target_os = "macos"))]
    let builder = builder.transparent(p.transparent);
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
    if !cfg!(target_os = "windows") {
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
    if !cfg!(target_os = "windows") {
        return;
    }
    let gate: HitGate = std::sync::Arc::new((Mutex::new(true), std::sync::Condvar::new()));
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
        if let tauri::WindowEvent::Focused(on) = e {
            // Tauri 2.11 has no portable occlusion event. Conservative blur suspension.
            let _ = h.emit_to("ravi-companion", "companion-visible", *on);
        }
    });
    let call = MenuItem::with_id(app, "ravi-call", "라비 부르기 / 숨기기", true, None::<&str>)?;
    let large = MenuItem::with_id(app, "ravi-large", "큰 화면 열기", true, None::<&str>)?;
    let greeting = CheckMenuItem::with_id(
        app,
        "ravi-greeting",
        "인사 켜기",
        true,
        s.greeting,
        None::<&str>,
    )?;
    app.manage(TrayControls(greeting.clone()));
    let auto = CheckMenuItem::with_id(
        app,
        "ravi-autostart",
        "로그인 때 자동 실행",
        true,
        crate::autostart::autostart_get(),
        None::<&str>,
    )?;
    let quit = MenuItem::with_id(
        app,
        "ravi-quit",
        "종료 (손님 주문도 멈춥니다)",
        true,
        None::<&str>,
    )?;
    let menu = Menu::with_items(app, &[&call, &large, &greeting, &auto, &quit])?;
    let tray = tauri::tray::TrayIconBuilder::with_id("main")
        .icon(crate::ravi_companion::tray_image())
        .icon_as_template(cfg!(target_os = "macos"))
        .tooltip("레이븐볼트 · 라비")
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
    Ok(())
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
        assert!(!platform("macos", false, false).transparent);
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
