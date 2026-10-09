//! Main-window lifecycle. Tracks only operation counts, never arguments or secrets.
use serde_json::{json, Value};
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};
static REQUESTED: AtomicBool = AtomicBool::new(false);
use tauri::{Emitter, Manager};
#[derive(Default)]
struct Gate { active: usize, closing: bool }
static GATE: Mutex<Gate> = Mutex::new(Gate { active: 0, closing: false });
pub(crate) struct Transfer;
impl Drop for Transfer {
    fn drop(&mut self) { let mut g=GATE.lock().unwrap_or_else(|e|e.into_inner()); g.active=g.active.saturating_sub(1); }
}
pub(crate) fn begin_transfer() -> Result<Transfer, String> {
    let mut g=GATE.lock().unwrap_or_else(|e|e.into_inner());
    if g.closing { return Err("프로그램 종료를 준비하고 있어요.".into()); }
    g.active+=1; Ok(Transfer)
}
pub(crate) fn request_close(app: &tauri::AppHandle) {
    REQUESTED.store(true, Ordering::SeqCst);
    let _=crate::ravi_companion::open_main(app);
    let _=app.emit_to("main", "ravi-close-requested", ());
}
async fn lock_state() -> &'static str {
    match crate::raven::wallet_lock_state().await {
        Ok(v) if v["encrypted"] == false => "unencrypted",
        Ok(v) if v["unlocked"] == false => "locked",
        Ok(v) if v["encrypted"] == true && v["unlocked"] == true => "open",
        _ => "unknown",
    }
}
#[tauri::command]
pub async fn ravi_lifecycle_status(app: tauri::AppHandle) -> Result<Value,String> {
    let lock=lock_state().await;
    let active=GATE.lock().unwrap_or_else(|e|e.into_inner()).active;
    Ok(json!({"lock":lock,"active":active,"tray":app.tray_by_id("main").is_some()}))
}
#[tauri::command]
pub async fn ravi_prepare_quit() -> Result<Value,String> {
    {
        let mut g=GATE.lock().unwrap_or_else(|e|e.into_inner());
        if g.active>0 || g.closing { return Err("진행 중인 전송이 끝난 뒤 종료해 주세요.".into()); }
        g.closing=true;
    }
    let mut lock=lock_state().await;
    if lock=="open" {
        if crate::wallet::lock_wallet().await.is_err() {
            GATE.lock().unwrap_or_else(|e|e.into_inner()).closing=false;
            return Err("지갑을 잠그지 못했어요. 계속 쓰기로 돌아가 다시 확인해 주세요.".into());
        }
        lock=lock_state().await;
        if lock!="locked" {
            GATE.lock().unwrap_or_else(|e|e.into_inner()).closing=false;
            return Err("지갑 잠금을 확인하지 못했어요.".into());
        }
    }
    Ok(json!({"lock":lock}))
}
#[tauri::command]
pub fn ravi_finish_quit(app: tauri::AppHandle) -> Result<(),String> {
    let g=GATE.lock().unwrap_or_else(|e|e.into_inner());
    if !g.closing || g.active>0 { return Err("종료 준비가 끝나지 않았어요.".into()); }
    app.exit(0); Ok(())
}
#[tauri::command]
pub fn ravi_cancel_quit() { GATE.lock().unwrap_or_else(|e|e.into_inner()).closing=false; }
#[tauri::command]
pub fn ravi_hide_main(app: tauri::AppHandle) -> Result<(),String> {
    if app.tray_by_id("main").is_none() { return Err("트레이를 사용할 수 없어요.".into()); }
    app.get_webview_window("main").ok_or("창을 찾지 못했어요.")?.hide().map_err(|_|"창을 숨기지 못했어요.".into())
}
#[cfg(test)]
mod tests {
    #[test]
    fn transfer_guard_blocks_quit_and_releases_on_drop() {
        let guard=super::begin_transfer().unwrap();
        assert_eq!(super::GATE.lock().unwrap().active,1);
        drop(guard);
        let mut gate=super::GATE.lock().unwrap();assert_eq!(gate.active,0);gate.closing=true;drop(gate);
        assert!(super::begin_transfer().is_err());super::ravi_cancel_quit();
        assert!(super::begin_transfer().is_ok());
    }
}

#[tauri::command]
pub fn ravi_take_close_request() -> bool { REQUESTED.swap(false, Ordering::SeqCst) }
