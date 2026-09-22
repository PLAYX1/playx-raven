//! Owner-controlled collection policy for ticket promotion.
use serde::{Deserialize, Serialize};
use std::sync::Mutex;

// Bump this version whenever the consent wording changes.
pub const CONSENT_VERSION: &str = "member-privacy-v3";
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
    let mut text = serde_json::json!({
        "ko": format!("{} 출입과 회원 확인에 사용합니다. 기간권의 회원 정보는 종료 후 {n}개월 뒤 자동 삭제합니다. 횟수권과 종료일이 없는 이용권의 회원 정보는 마지막 이용 후 {n}개월 뒤 자동 삭제합니다. 이 가게 컴퓨터와 그 백업에 저장됩니다. 언제든 가게에 삭제를 요청할 수 있습니다.", items[0]),
        "en": format!("{} We use it for entry and member identification. Member information for period passes is automatically deleted {n} months after the pass ends. Member information for punch cards and passes without an end date is automatically deleted {n} months after last use. Information is stored on this shop's computer and its backups. You can ask the shop to delete it at any time.", items[1]),
        "ja": format!("{} 入退場と会員確認に使用します。期間券の会員情報は終了から{n}か月後に自動削除します。回数券と終了日のない利用券の会員情報は最終利用から{n}か月後に自動削除します。この店のコンピューターとそのバックアップに保存します。いつでも店に削除を依頼できます。", items[2]),
        "zh": format!("{} 用于出入和会员身份确认。期限卡的会员信息在到期{n}个月后自动删除。次卡和无到期日的卡的会员信息在最后使用{n}个月后自动删除。信息保存在本店电脑及其备份中。您可以随时要求本店删除。", items[3]),
    });
    if policy.level != "none" {
        for (lang, memo) in [
            ("ko", "직원이 적는 메모(이용 관련 사항)도 받습니다.\n건강 상태 같은 민감한 정보는 적지 마세요."),
            ("en", "We also collect notes written by staff (about your use of the shop).\nDo not write sensitive information such as health conditions."),
            ("ja", "スタッフが記入するメモ（利用に関する事項）も収集します。\n健康状態などの機微な情報は記入しないでください。"),
            ("zh", "也收集员工填写的备注（与使用相关的事项）。\n请勿填写健康状况等敏感信息。"),
        ] {
            text[lang] = serde_json::json!(format!("{}\n{memo}", text[lang].as_str().unwrap()));
        }
    }
    text
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

// Lock order: GROUPS_LOCK -> pass::STORE_LOCK -> ticket lock. Never acquire
// GROUPS_LOCK from inside a ledger operation. Hold it through validation and save
// so assignments/registration cannot race a rename or deletion.
static GROUPS_LOCK: Mutex<()> = Mutex::new(());

#[derive(Serialize, Deserialize)]
struct GroupList { groups: Vec<String> }

pub fn validate_group_list(groups: &[String]) -> Result<Vec<String>, String> {
    if groups.len() > 20 {
        return Err("GROUP_INVALID: 분류는 20개까지 만들 수 있습니다.".into());
    }
    let mut clean = Vec::new();
    for value in groups {
        let name = value.trim();
        if value.chars().any(char::is_control) || !(1..=12).contains(&name.chars().count()) {
            return Err("GROUP_INVALID: 분류 이름은 제어문자 없이 1~12자로 적어 주세요.".into());
        }
        if clean.iter().any(|old| old == name) {
            return Err("GROUP_INVALID: 같은 분류 이름을 두 번 쓸 수 없습니다.".into());
        }
        clean.push(name.to_string());
    }
    Ok(clean)
}

pub fn clean_member_groups(list: &[String], allowed: &[String]) -> Result<Vec<String>, String> {
    // Limit the submitted array too, even if duplicates would reduce its size.
    if list.len() > 5 {
        return Err("GROUP_INVALID: 회원 분류는 5개까지 지정할 수 있습니다.".into());
    }
    let mut clean = Vec::new();
    for value in list {
        let name = value.trim();
        if value.chars().any(char::is_control) || !allowed.iter().any(|v| v == name) {
            return Err("GROUP_INVALID: 가게 목록에 있는 분류를 골라 주세요.".into());
        }
        if !clean.iter().any(|v| v == name) { clean.push(name.to_string()); }
    }
    Ok(clean)
}

pub fn parse_member_groups(value: &serde_json::Value) -> Result<Vec<String>, String> {
    serde_json::from_value::<Vec<String>>(value.clone())
        .map_err(|_| "GROUP_INVALID: 분류는 문자열 배열로 보내 주세요.".into())
}

fn read_groups() -> Result<Vec<String>, String> {
    let bytes = match std::fs::read(crate::paths::app_file("member_groups.json")) {
        Ok(bytes) => bytes,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(_) => return Err("회원 분류 설정을 읽지 못했습니다.".into()),
    };
    let list: GroupList = serde_json::from_slice(&bytes)
        .map_err(|_| "회원 분류 설정이 손상되었습니다.".to_string())?;
    validate_group_list(&list.groups)
        .map_err(|_| "회원 분류 설정이 손상되었습니다.".to_string())
}

pub(crate) fn with_member_groups<T>(f: impl FnOnce(&[String]) -> Result<T, String>) -> Result<T, String> {
    let _guard = GROUPS_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    f(&read_groups()?)
}

#[tauri::command]
pub fn member_groups_get() -> Result<Vec<String>, String> {
    with_member_groups(|groups| Ok(groups.to_vec()))
}

#[tauri::command]
pub fn member_groups_set(groups: Vec<String>, renames: Option<Vec<(String, String)>>) -> Result<Vec<String>, String> {
    let groups = validate_group_list(&groups)?;
    // IPC contract: renames is an optional array of [oldName, newName] pairs.
    // Apply each pair once to the original value (including swaps), not as a chain.
    let renames: Vec<_> = renames.unwrap_or_default().into_iter()
        .map(|(old, new)| (old.trim().to_string(), new.trim().to_string())).collect();
    with_member_groups(|old_groups| {
        let mut seen = std::collections::HashSet::new();
        for (old, new) in &renames {
            if !old_groups.contains(old) || !groups.contains(new) || !seen.insert(old) {
                return Err("GROUP_INVALID: 이름 바꾸기의 이전·새 분류와 중복을 확인해 주세요.".into());
            }
        }
        crate::pass::reconcile_member_groups(&groups, &renames, || {
            let dir = crate::paths::app_dir();
            std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
            let path = crate::paths::app_file("member_groups.json");
            let tmp = crate::paths::app_file("member_groups.json.tmp");
            let bytes = serde_json::to_vec_pretty(&GroupList { groups: groups.clone() }).map_err(|e| e.to_string())?;
            std::fs::write(&tmp, bytes).map_err(|e| e.to_string())?;
            if path.exists() {
                std::fs::copy(&path, dir.join("member_groups.json.bak")).map_err(|e| e.to_string())?;
            }
            std::fs::rename(tmp, path).map_err(|e| e.to_string())
        })?;
        Ok(groups.clone())
    })
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
    fn group_list_validation_limits_unicode_controls_and_duplicates() {
        let twenty: Vec<_> = (0..20).map(|i| format!("분류{i}")).collect();
        assert_eq!(validate_group_list(&twenty).unwrap(), twenty);
        assert_eq!(validate_group_list(&[format!(" {} ", "가".repeat(12))]).unwrap(), vec!["가".repeat(12)]);
        for list in [
            (0..21).map(|i| format!("분류{i}")).collect(), vec!["가".repeat(13)],
            vec!["".into()], vec!["  ".into()], vec!["a".into(), " a ".into()],
            vec!["a\n".into()], vec!["a\t".into()], vec!["a\0".into()], vec!["a\u{7f}".into()],
        ] {
            assert!(validate_group_list(&list).unwrap_err().starts_with("GROUP_INVALID: "));
        }
        assert_eq!(validate_group_list(&["A".into(), "a".into()]).unwrap().len(), 2);
    }

    #[test]
    fn member_group_validation_deduplicates_and_limits_submitted_values() {
        let allowed: Vec<_> = (0..6).map(|i| format!("Group{i}")).collect();
        assert_eq!(clean_member_groups(&[" Group0 ".into(), "Group0".into()], &allowed).unwrap(), vec!["Group0"]);
        assert_eq!(clean_member_groups(&allowed[..5], &allowed).unwrap().len(), 5);
        for list in [allowed.clone(), vec!["Group0".into(); 6], vec!["missing".into()], vec!["".into()]] {
            assert!(clean_member_groups(&list, &allowed).unwrap_err().starts_with("GROUP_INVALID: "));
        }
        for value in [serde_json::json!(null), serde_json::json!({}), serde_json::json!([1]), serde_json::json!("Group0")] {
            assert!(parse_member_groups(&value).unwrap_err().starts_with("GROUP_INVALID: "));
        }
    }

    #[test]
    fn groups_roundtrip_backup_and_corruption_fail_closed() {
        in_sandbox(|| {
            assert!(member_groups_get().unwrap().is_empty());
            assert_eq!(member_groups_set(vec![" First ".into()], None).unwrap(), vec!["First"]);
            assert_eq!(member_groups_get().unwrap(), vec!["First"]);
            member_groups_set(vec!["Second".into()], None).unwrap();
            let backup: serde_json::Value = serde_json::from_slice(&std::fs::read(crate::paths::app_file("member_groups.json.bak")).unwrap()).unwrap();
            assert_eq!(backup, serde_json::json!({"groups":["First"]}));
            assert!(!crate::paths::app_file("member_groups.json.tmp").exists());
            for bad in ["bad", "{}", r#"{"groups":[1]}"#, r#"{"groups":["a","a"]}"#] {
                std::fs::write(crate::paths::app_file("member_groups.json"), bad).unwrap();
                assert!(member_groups_get().is_err());
            }
        });
    }

    #[test]
    fn consent_covers_every_language_level_and_retention() {
        for months in [3, 6, 12] {
            let texts: Vec<_> = ["none", "name", "name_last4", "name_phone"].iter()
                .map(|level| consent_text(&Policy { level: (*level).into(), retention_months: months })).collect();
            for lang in ["ko", "en", "ja", "zh"] {
                let mut unique = std::collections::HashSet::new();
                for (level, text) in texts.iter().enumerate() {
                    let text = text[lang].as_str().unwrap();
                    assert!(!text.is_empty());
                    assert!(text.contains(&months.to_string()));
                    assert!(unique.insert(text));
                    let (memo, sensitive) = match lang {
                        "ko" => ("직원이 적는 메모(이용 관련 사항)", "건강 상태 같은 민감한 정보는 적지 마세요."),
                        "en" => ("notes written by staff (about your use of the shop)", "Do not write sensitive information such as health conditions."),
                        "ja" => ("スタッフが記入するメモ（利用に関する事項）", "健康状態などの機微な情報は記入しないでください。"),
                        _ => ("员工填写的备注（与使用相关的事项）", "请勿填写健康状况等敏感信息。"),
                    };
                    assert_eq!(text.contains(memo), level != 0);
                    assert_eq!(text.contains(sensitive), level != 0);
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
