//! Owner-controlled collection policy for ticket promotion.
use serde::{Deserialize, Serialize};
use std::sync::Mutex;

// Bump this version whenever the consent wording changes.
pub const CONSENT_VERSION: &str = "member-privacy-v1";
static LOCK: Mutex<()> = Mutex::new(());

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Policy {
    pub level: String,
    pub retention_months: u32,
}
impl Default for Policy {
    fn default() -> Self {
        Self { level: "name_last4".into(), retention_months: 6 }
    }
}
impl Policy {
    fn validate(&self) -> Result<(), String> {
        if !matches!(self.level.as_str(), "none" | "name" | "name_last4" | "name_phone") {
            return Err("회원 정보 수집 범위가 올바르지 않습니다.".into());
        }
        if !matches!(self.retention_months, 3 | 6 | 12) {
            return Err("회원 정보 보관 개월 수가 올바르지 않습니다.".into());
        }
        Ok(())
    }
}
#[tauri::command]
pub fn member_privacy_get() -> Result<Policy, String> {
    let _guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let bytes = match std::fs::read(crate::paths::app_file("member_privacy.json")) {
        Ok(bytes) => bytes,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Policy::default()),
        Err(_) => return Err("회원 정보 설정을 읽지 못했습니다.".into()),
    };
    let policy: Policy = serde_json::from_slice(&bytes)
        .map_err(|_| "회원 정보 설정이 손상되었습니다.".to_string())?;
    policy.validate()?;
    Ok(policy)
}
#[tauri::command]
pub fn member_privacy_set(level: String, retention_months: u32) -> Result<Policy, String> {
    let policy = Policy { level, retention_months };
    policy.validate()?;
    let _guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let dir = crate::paths::app_dir();
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join("member_privacy.json");
    let tmp = dir.join("member_privacy.json.tmp");
    std::fs::write(&tmp, serde_json::to_vec_pretty(&policy).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    if path.exists() {
        std::fs::copy(&path, dir.join("member_privacy.json.bak")).map_err(|e| e.to_string())?;
    }
    std::fs::rename(tmp, path).map_err(|e| e.to_string())?;
    Ok(policy)
}

pub async fn run_cleanup() {
    loop {
        let result = tauri::async_runtime::spawn_blocking(|| {
            let policy = member_privacy_get()?;
            let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH)
                .map_err(|e| e.to_string())?.as_secs() as i64;
            crate::pass::redact_expired_members(now, policy.retention_months)
        }).await;
        if !matches!(result, Ok(Ok(_))) {
            eprintln!("Member privacy cleanup failed; retrying in 24 hours");
        }
        tokio::time::sleep(std::time::Duration::from_secs(24 * 60 * 60)).await;
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    pub(crate) fn in_sandbox<T>(f: impl FnOnce() -> T) -> T {
        let _guard = crate::paths::TEST_ENV.lock().unwrap_or_else(|e| e.into_inner());
        let dir = std::env::temp_dir().join(format!("raven-member-privacy-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        struct Home(std::path::PathBuf, Option<std::ffi::OsString>);
        impl Drop for Home {
            fn drop(&mut self) {
                match &self.1 {
                    Some(old) => std::env::set_var("PLAYX_RAVEN_HOME", old),
                    None => std::env::remove_var("PLAYX_RAVEN_HOME"),
                }
                let _ = std::fs::remove_dir_all(&self.0);
            }
        }
        let _home = Home(dir.clone(), std::env::var_os("PLAYX_RAVEN_HOME"));
        std::env::set_var("PLAYX_RAVEN_HOME", &dir);
        f()
    }
    #[test]
    fn defaults_roundtrip_and_validation() {
        in_sandbox(|| {
            assert_eq!(member_privacy_get().unwrap(), Policy::default());
            for level in ["none", "name", "name_last4", "name_phone"] {
                for months in [3, 6, 12] {
                    let saved = member_privacy_set(level.into(), months).unwrap();
                    assert_eq!(member_privacy_get().unwrap(), saved);
                }
            }
            assert!(member_privacy_set("unknown".into(), 6).is_err());
            assert!(member_privacy_set("name".into(), 4).is_err());
            assert_eq!(member_privacy_get().unwrap().retention_months, 12);
            std::fs::write(crate::paths::app_file("member_privacy.json"), b"bad").unwrap();
            assert!(member_privacy_get().is_err());
        });
    }
}
