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
/// 이 설치에서 업데이트 단추가 **스스로 설치해도 되는가**.
#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub enum InstallKind {
    /// 앱이 직접 바꿔 끼운다.
    Auto,
    /// 새 설치 파일을 사람이 내려받아야 한다(안내만 보여 준다).
    Manual,
}

/// 순수 판정(시험 가능). 입력은 전부 값으로 받는다.
/// - 리눅스: `APPIMAGE` 환경변수(AppImage 가 스스로 켜질 때만 생긴다)가 없거나 비었거나
///   절대 경로가 아니면 deb/rpm 설치로 보고 `Manual`(권한 상승이 필요한 길은 막는다).
///   내려받을 파일이 `.deb`/`.rpm` 이어도 `Manual`.
/// - 윈도우: 내려받을 파일이 `.msi`/`.zip` 이면 `Manual`(앱이 속을 읽어 확인하는 것은 NSIS exe 뿐).
///   ⚠️ 윈도우에서 MSI 로 깐 사람인지는 레지스트리를 봐야 알 수 있어 여기서는 판별하지 못한다.
/// - 맥: 항상 `Auto`(기존 동작 그대로).
pub fn install_kind(target: &str, appimage_env: Option<&str>, url_path: &str) -> InstallKind {
    let path = url_path.to_ascii_lowercase();
    match target {
        "linux-x86_64" => {
            let ok_env = appimage_env.is_some_and(|p| p.starts_with('/') && !p.trim().is_empty());
            if ok_env && !path.ends_with(".deb") && !path.ends_with(".rpm") {
                InstallKind::Auto
            } else {
                InstallKind::Manual
            }
        }
        "windows-x86_64" => {
            if path.ends_with(".msi") || path.ends_with(".zip") {
                InstallKind::Manual
            } else {
                InstallKind::Auto
            }
        }
        _ => InstallKind::Auto,
    }
}

/// `check_update` 가 보여 줄 상태(순수). 서버가 이 대상의 서명된 진술을 **게시하지 않았으면**
/// 설치할 수 없으니 「업데이트 있음」으로 내보내지 않는다 — 이것이 1차 스위치.
#[derive(Debug, PartialEq, Eq)]
pub enum Availability {
    Offer(InstallKind),
    NotEnabled,
    NotPublished,
}

pub fn availability(target: &str, raw: &Value, appimage_env: Option<&str>, url_path: &str) -> Availability {
    if !crate::update_policy::UPDATE_TARGETS_ENABLED.contains(&target) {
        return Availability::NotEnabled;
    }
    let m = &raw["signed_releases"][target];
    if m["statement"].as_str().is_none() || m["signature"].as_str().is_none() {
        return Availability::NotPublished;
    }
    Availability::Offer(install_kind(target, appimage_env, url_path))
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
    let Some(u) = update else {
        return Ok(json!({"version":null}));
    };
    let appimage = std::env::var("APPIMAGE").ok();
    Ok(match availability(&target(), &u.raw_json, appimage.as_deref(), u.download_url.path()) {
        Availability::Offer(kind) => {
            json!({"version":u.version, "manual": kind == InstallKind::Manual})
        }
        // 이 대상은 아직 자동 업데이트를 안 켰거나 서버가 서명된 진술을 안 올렸다.
        Availability::NotEnabled => json!({"version":null,"blocked":"target"}),
        Availability::NotPublished => json!({"version":null,"blocked":"unpublished"}),
    })
}

/// 🔴 윈도우 전용: 설치기가 파일을 덮어쓰기 **전에** 이 앱이 켠 것들을 정상 종료한다.
///
/// 윈도우 `update.install` 은 설치기를 띄운 뒤 `std::process::exit(0)` 로 끝낸다. 그러면
/// `RunEvent::Exit` 처리(lib.rs)가 **건너뛰어져** 노드(`stop` RPC)·파일창고·채굴기·바깥 연결·
/// 지도 「영업 중」이 정리되지 않는다. 그래서 같은 정리 함수들을 여기서 먼저 부른다
/// (새로 만들지 않고 기존 `stop_on_exit` 들을 그대로 재사용).
/// - 노드는 RPC `stop` 으로 부탁하고 스스로 닫히길 기다린 뒤에만 강제 종료한다(services.rs).
/// - 사장이 따로 켠 코어는 건드리지 않는다(우리 목록에 있는 것만).
/// - 실패·시간 초과여도 설치는 막지 않는다(막으면 업데이트가 영영 안 된다).
#[cfg(windows)]
async fn stop_services_before_install() -> bool {
    let work = tokio::task::spawn_blocking(|| {
        crate::mining::stop_on_exit();
        crate::services::stop_on_exit();
        crate::map::stop_on_exit();
        crate::tunnel::stop_on_exit();
    });
    matches!(
        tokio::time::timeout(std::time::Duration::from_secs(45), work).await,
        Ok(Ok(()))
    )
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
    // 리눅스 deb/rpm · 윈도우 MSI 처럼 앱이 스스로 못 바꾸는 설치는 여기서 막는다(UI 도 같은 판정으로 안내).
    let appimage = std::env::var("APPIMAGE").ok();
    if install_kind(&target(), appimage.as_deref(), update.download_url.path()) == InstallKind::Manual {
        return Err("이 설치 방식에서는 자동으로 바꿀 수 없습니다. 새 설치 파일을 내려받아 주세요.".into());
    }
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
    // 검증을 모두 통과한 뒤에만(= 거부될 업데이트로 가게를 멈추지 않는다) 정리한다.
    #[cfg(windows)]
    if !stop_services_before_install().await {
        eprintln!("update: 설치 전 정리가 시간 안에 끝나지 않았습니다(설치는 계속).");
    }
    update.install(&bytes).map_err(|_| {
        #[cfg(windows)]
        let msg = "업데이트 설치 실패 (최소 허용 버전은 유지됩니다.) 지갑 서버가 멈춰 있을 수 있으니 앱을 껐다가 다시 켜 주세요.";
        #[cfg(not(windows))]
        let msg = "업데이트 설치 실패 (최소 허용 버전은 유지됩니다.)";
        msg.to_string()
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    fn signed(target: &str) -> Value {
        json!({"signed_releases": { target: {"statement":"{}","signature":"x"} }})
    }
    #[test]
    fn linux_needs_appimage_env_and_non_package_url() {
        let l = "linux-x86_64";
        assert_eq!(install_kind(l, Some("/home/a/RV.AppImage"), "/d/RV.AppImage"), InstallKind::Auto);
        assert_eq!(install_kind(l, None, "/d/RV.AppImage"), InstallKind::Manual);
        assert_eq!(install_kind(l, Some(""), "/d/RV.AppImage"), InstallKind::Manual);
        assert_eq!(install_kind(l, Some("relative.AppImage"), "/d/RV.AppImage"), InstallKind::Manual);
        assert_eq!(install_kind(l, Some("/x/RV.AppImage"), "/d/RV_amd64.DEB"), InstallKind::Manual);
        assert_eq!(install_kind(l, Some("/x/RV.AppImage"), "/d/RV.rpm"), InstallKind::Manual);
    }
    #[test]
    fn windows_only_nsis_exe_is_automatic_and_mac_is_unchanged() {
        let w = "windows-x86_64";
        assert_eq!(install_kind(w, None, "/d/RV_x64-setup.exe"), InstallKind::Auto);
        assert_eq!(install_kind(w, None, "/d/RV.msi"), InstallKind::Manual);
        assert_eq!(install_kind(w, None, "/d/RV.nsis.zip"), InstallKind::Manual);
        assert_eq!(install_kind("darwin-aarch64", None, "/d/RV.app.tar.gz"), InstallKind::Auto);
    }
    #[test]
    fn no_signed_statement_means_no_offer() {
        let none = json!({"version":"1.0.0"});
        for t in ["darwin-aarch64", "darwin-x86_64", "windows-x86_64", "linux-x86_64"] {
            assert_eq!(availability(t, &none, Some("/a.AppImage"), "/x"), Availability::NotPublished, "{t}");
            assert!(matches!(availability(t, &signed(t), Some("/a.AppImage"), "/x"), Availability::Offer(_)), "{t}");
            // 다른 대상의 진술은 이 대상을 열어 주지 않는다
            assert_eq!(availability(t, &signed("other"), Some("/a.AppImage"), "/x"), Availability::NotPublished);
        }
        // 서명(signature) 칸이 없으면 게시된 것이 아니다
        let half = json!({"signed_releases":{"windows-x86_64":{"statement":"{}"}}});
        assert_eq!(availability("windows-x86_64", &half, None, "/x"), Availability::NotPublished);
        // 켜지 않은 대상은 진술이 있어도 막힌다
        assert_eq!(availability("windows-aarch64", &signed("windows-aarch64"), None, "/x"), Availability::NotEnabled);
        assert_eq!(availability("linux-aarch64", &signed("linux-aarch64"), None, "/x"), Availability::NotEnabled);
    }
    #[test]
    fn linux_deb_install_is_manual_even_when_published() {
        let a = availability("linux-x86_64", &signed("linux-x86_64"), None, "/d/RV.AppImage");
        assert_eq!(a, Availability::Offer(InstallKind::Manual));
    }
}
