use serde_json::{json, Value};
use tauri_plugin_updater::UpdaterExt;
static GATE: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
fn target() -> String {
    format!(
        "{}-{}",
        if cfg!(target_os = "macos") {
            "darwin"
        } else {
            std::env::consts::OS
        },
        std::env::consts::ARCH
    )
}
pub fn initialize_policy(current: &str) -> Result<(), String> {
    let root = crate::paths::app_file("update-policy");
    let _disk = crate::payout_guard::ProcessLock::take(&root, "install")?;
    crate::update_policy::remember_installed(&root.join("minimum.json"), current)
}
#[tauri::command]
pub async fn check_update(app: tauri::AppHandle) -> Result<Value, String> {
    initialize_policy(&app.package_info().version.to_string())?;
    let update = app
        .updater()
        .map_err(|_| "업데이트 설정 오류")?
        .check()
        .await
        .map_err(|_| "업데이트 확인 실패")?;
    Ok(update.map_or(json!({"version":null}), |u| json!({"version":u.version})))
}
#[tauri::command]
pub async fn install_update(app: tauri::AppHandle, expected_version: String) -> Result<(), String> {
    let _gate = GATE.lock().await;
    let root = crate::paths::app_file("update-policy");
    std::fs::create_dir_all(&root).map_err(|_| "최소 버전 폴더 오류")?;
    let _disk = crate::payout_guard::ProcessLock::take(&root, "install")?;
    let update = app
        .updater()
        .map_err(|_| "업데이트 설정 오류")?
        .check()
        .await
        .map_err(|_| "업데이트 확인 실패")?
        .ok_or("설치할 새 버전 없음")?;
    if update.version != expected_version {
        return Err("승인 후 광고 버전이 바뀌었습니다.".into());
    }
    let metadata = &update.raw_json["signed_releases"][target()];
    let text = metadata["statement"]
        .as_str()
        .ok_or("서명된 릴리스 메타데이터 없음: 설치 차단")?;
    let sig = metadata["signature"].as_str().ok_or("릴리스 서명 없음")?;
    let config: Value = serde_json::from_str(include_str!("../tauri.conf.json"))
        .map_err(|_| "업데이트 설정 오류")?;
    let key = config["plugins"]["updater"]["pubkey"]
        .as_str()
        .ok_or("검증키 없음")?;
    let release = crate::update_policy::signed_release(text, sig, key)?;
    // download verifies the existing package signature. Only these exact bytes reach install.
    let bytes = update
        .download(|_, _| {}, || {})
        .await
        .map_err(|_| "패키지 다운로드/서명 검증 실패")?;
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|_| "시계 오류")?
        .as_secs();
    crate::update_policy::enforce(
        &root.join("minimum.json"),
        &app.package_info().version.to_string(),
        &update.version,
        &release,
        &bytes,
        &target(),
        now,
    )?;
    update
        .install(&bytes)
        .map_err(|_| "업데이트 설치 실패 (최소 허용 버전은 유지됩니다.)".into())
}
