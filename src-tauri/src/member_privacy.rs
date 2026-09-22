//! Owner-controlled collection policy for ticket promotion.
use serde::{Deserialize, Serialize};
use std::sync::Mutex;

// Bump this version whenever the consent wording changes.
pub const CONSENT_VERSION: &str = "member-privacy-v2";
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
pub fn consent_text(policy: &Policy) -> serde_json::Value {
    let items = match policy.level.as_str() {
        "name" => ["이름을 받습니다.", "We collect your name.", "氏名を収集します。", "收集姓名。"],
        "name_last4" => ["이름과 전화번호 끝 4자리를 받습니다.", "We collect your name and the last 4 digits of your phone number.", "氏名と電話番号の下4桁を収集します。", "收集姓名和电话号码后4位。"],
        "name_phone" => ["이름과 전화번호 전체를 받습니다.", "We collect your name and full phone number.", "氏名と電話番号全体を収集します。", "收集姓名和完整电话号码。"],
        _ => ["이 가게는 회원 정보를 받지 않습니다.", "This shop does not collect member information.", "この店は会員情報を収集しません。", "本店不收集会员信息。"],
    };
    let n = policy.retention_months;
    serde_json::json!({
        "ko": format!("{} 출입과 회원 확인에 사용합니다. 기간권의 회원 정보는 종료 후 {n}개월 뒤 자동 삭제합니다. 횟수권과 종료일이 없는 이용권의 회원 정보는 마지막 이용 후 {n}개월 뒤 자동 삭제합니다. 이 가게 컴퓨터와 그 백업에 저장됩니다. 언제든 가게에 삭제를 요청할 수 있습니다.", items[0]),
        "en": format!("{} We use it for entry and member identification. Member information for period passes is automatically deleted {n} months after the pass ends. Member information for punch cards and passes without an end date is automatically deleted {n} months after last use. Information is stored on this shop's computer and its backups. You can ask the shop to delete it at any time.", items[1]),
        "ja": format!("{} 入退場と会員確認に使用します。期間券の会員情報は終了から{n}か月後に自動削除します。回数券と終了日のない利用券の会員情報は最終利用から{n}か月後に自動削除します。この店のコンピューターとそのバックアップに保存します。いつでも店に削除を依頼できます。", items[2]),
        "zh": format!("{} 用于出入和会员身份确认。期限卡的会员信息在到期{n}个月后自动删除。次卡和无到期日的卡的会员信息在最后使用{n}个月后自动删除。信息保存在本店电脑及其备份中。您可以随时要求本店删除。", items[3]),
    })
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CleanupResult {
    pub at: i64,
    pub ok: bool,
    pub redacted: usize,
    pub error: Option<String>,
}
const SETTINGS_ERROR: &str = "회원 정보 설정 파일이 손상되었습니다.";
const CLEANUP_ERROR: &str = "정리 중 오류가 났습니다.";

#[tauri::command]
pub fn member_privacy_state() -> serde_json::Value {
    let (policy, policy_error) = match member_privacy_get() {
        Ok(policy) => (Some(policy), None),
        Err(_) => (None, Some(SETTINGS_ERROR)),
    };
    let last_cleanup = std::fs::read(crate::paths::app_file("member_privacy_cleanup.json"))
        .ok().and_then(|bytes| serde_json::from_slice::<CleanupResult>(&bytes).ok());
    serde_json::json!({
        "consent_version": CONSENT_VERSION,
        "consent_text": policy.as_ref().map(consent_text),
        "policy": policy,
        "policy_error": policy_error,
        "last_cleanup": last_cleanup,
    })
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

pub fn run_cleanup_once(now: i64) -> CleanupResult {
    let outcome = member_privacy_get().map_err(|_| SETTINGS_ERROR)
        .and_then(|policy| crate::pass::redact_expired_members(now, policy.retention_months)
            .map_err(|e| if e == "회원 장부를 읽지 못했습니다." {
                "회원 장부를 읽지 못했습니다."
            } else { CLEANUP_ERROR }));
    let mut result = match outcome {
        Ok(redacted) => CleanupResult { at: now, ok: true, redacted, error: None },
        Err(error) => CleanupResult { at: now, ok: false, redacted: 0, error: Some(error.into()) },
    };
    let persist = || -> Result<(), std::io::Error> {
        std::fs::create_dir_all(crate::paths::app_dir())?;
        let tmp = crate::paths::app_file("member_privacy_cleanup.json.tmp");
        std::fs::write(&tmp, serde_json::to_vec(&result)?)?;
        std::fs::rename(tmp, crate::paths::app_file("member_privacy_cleanup.json"))
    };
    if persist().is_err() {
        result.ok = false;
        result.error = Some(CLEANUP_ERROR.into());
    }
    result
}

pub async fn run_cleanup() {
    loop {
        let result = tauri::async_runtime::spawn_blocking(|| {
            let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default().as_secs() as i64;
            run_cleanup_once(now)
        }).await;
        if !matches!(result, Ok(CleanupResult { ok: true, .. })) {
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
    fn consent_covers_every_language_level_and_retention() {
        for months in [3, 6, 12] {
            let texts: Vec<_> = ["none", "name", "name_last4", "name_phone"].iter()
                .map(|level| consent_text(&Policy { level: (*level).into(), retention_months: months })).collect();
            for lang in ["ko", "en", "ja", "zh"] {
                let mut unique = std::collections::HashSet::new();
                for text in &texts {
                    let text = text[lang].as_str().unwrap();
                    assert!(!text.is_empty());
                    assert!(text.contains(&months.to_string()));
                    assert!(unique.insert(text));
                }
            }
        }
    }

    #[test]
    fn cleanup_records_success_and_safe_failures_and_state_survives_corrupt_policy() {
        in_sandbox(|| {
            assert!(member_privacy_state()["last_cleanup"].is_null());
            let now = 1_800_000_000;
            crate::pass::save_member("SYNTHETIC-1".into(), "Synthetic Member".into(), "".into(),
                "period".into(), 20200101, 0, "".into(), now, None).unwrap();
            let result = run_cleanup_once(now);
            assert!(result.ok);
            assert_eq!(result.redacted, 1);
            let read_record = || serde_json::from_slice::<serde_json::Value>(
                &std::fs::read(crate::paths::app_file("member_privacy_cleanup.json")).unwrap()).unwrap();
            assert_eq!(read_record(), serde_json::json!({"at":now,"ok":true,"redacted":1,"error":null}));
            assert_eq!(member_privacy_state()["last_cleanup"], read_record());
            std::fs::write(crate::paths::app_file("passes.json"), b"broken synthetic ledger").unwrap();
            assert_eq!(run_cleanup_once(now).error.as_deref(), Some("회원 장부를 읽지 못했습니다."));
            std::fs::write(crate::paths::app_file("member_privacy.json"), b"broken synthetic settings").unwrap();
            let result = run_cleanup_once(now);
            assert!(!result.ok);
            assert_eq!(result.error.as_deref(), Some(SETTINGS_ERROR));
            assert_eq!(read_record(), serde_json::json!({"at":now,"ok":false,"redacted":0,"error":SETTINGS_ERROR}));
            let state = member_privacy_state();
            assert!(state["policy"].is_null());
            assert!(state["consent_text"].is_null());
            assert_eq!(state["policy_error"], SETTINGS_ERROR);
            assert_eq!(state["consent_version"], CONSENT_VERSION);
            assert_eq!(state["last_cleanup"], read_record());
        });
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
