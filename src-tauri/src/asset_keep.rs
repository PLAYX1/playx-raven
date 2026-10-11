//! 자산 파일(IPFS) 보관 — 「내 뜻」 저장소 (0.8.8a).
//!
//! ## 왜 이 파일이 있나
//!
//! 앱은 30분마다 지갑의 모든 자산 파일을 **스스로** 붙잡는다(`peers::start_auto_pin`).
//! 그래서 화면에서 「보관 해제」를 눌러도 다음 주기에 같은 파일을 다시 붙잡았고,
//! 남이 아무 주소로 보낸 자산(스팸)의 파일까지 허락 없이 붙잡혔다.
//! 화면이 사용자의 뜻을 말하려면 **그 뜻을 Rust 쪽이 기억하고 지켜야** 한다.
//!
//! ## 저장하는 것 (이 컴퓨터에만)
//!
//! `asset-keep.json` (앱 폴더, 파일 권한 0600):
//!
//! - `decisions` — 파일 주소(CID)별로 `keep`(보관하기) · `skip`(보관 안 하기). 없으면 「아직 안 정함」.
//! - `auto_mine` — 내가 만든 자산 파일은 자동으로 보관한다(기본 켜짐).
//! - `migrated` — 0.8.7 이하에서 이미 붙잡고 있던 것을 `keep` 으로 옮겼는가.
//!
//! ## 자동 보관 규칙 (`auto_allowed`)
//!
//! | 자산 | 내 뜻 | 자동 보관 |
//! |---|---|---|
//! | 무엇이든 | `skip` | 안 한다 |
//! | 무엇이든 | `keep` | 한다 |
//! | 내가 만든 것 | 안 정함 | `auto_mine` 이 켜져 있으면 한다 |
//! | 받은 것 | 안 정함 | **안 한다** — 사용자가 화면에서 묻기 전에는 남의 파일을 붙잡지 않는다 |
//!
//! ## 안전
//!
//! - 파일이 깨졌거나 읽을 수 없으면 `damaged` — **자동 보관을 전부 멈춘다**. 알 수 없는 뜻으로
//!   움직이지 않는다. 사람이 「다시 켜기」를 눌러야 새 설정으로 시작하고, 그때 깨진 파일은
//!   `asset-keep.json.bad` 로 옮겨 둔다. 기존에 붙잡은 파일은 건드리지 않는다.
//! - 업데이트 직후 이미 붙잡고 있던 것은 조용히 풀지 않는다 — `keep` 으로 옮겨 적는다.
//! - 이 모듈은 파일을 지우지 않는다. 「보관 해제」는 IPFS pin 만 푼다(화면이 `pin_remove` 를 부른다).

use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::Mutex;

const FILE: &str = "asset-keep.json";
/// 판단을 적어 둘 수 있는 주소 수의 상한 — 파일이 끝없이 커지지 않게.
const MAX_DECISIONS: usize = 20_000;
/// 한 번에 바꿀 수 있는 주소 수.
const MAX_BATCH: usize = 2_000;

static LOCK: Mutex<()> = Mutex::new(());

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Decision {
    Keep,
    Skip,
}

impl Decision {
    fn as_str(self) -> &'static str {
        match self {
            Decision::Keep => "keep",
            Decision::Skip => "skip",
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Prefs {
    pub auto_mine: bool,
    pub migrated: bool,
    /// 설정 파일을 읽을 수 없다 — 알 수 없는 뜻으로 움직이지 않는다.
    pub damaged: bool,
    pub decisions: BTreeMap<String, Decision>,
}

impl Default for Prefs {
    fn default() -> Self {
        Prefs { auto_mine: true, migrated: false, damaged: false, decisions: BTreeMap::new() }
    }
}

impl Prefs {
    fn damaged() -> Self {
        Prefs { damaged: true, ..Prefs::default() }
    }

    pub(crate) fn decision(&self, cid: &str) -> Option<Decision> {
        self.decisions.get(cid).copied()
    }

    /// 내가 보관 안 하기로 한 주소인가.
    pub(crate) fn is_skipped(&self, cid: &str) -> bool {
        self.decision(cid) == Some(Decision::Skip)
    }
}

/// 자동 보관이 이 파일을 붙잡아도 되는가. 순수 함수 — 시험이 여기를 본다.
pub(crate) fn auto_allowed(prefs: &Prefs, mine: bool, cid: &str) -> bool {
    // 설정을 못 읽었거나 옛 보관을 아직 옮겨 적지 못했으면(파일창고가 꺼져 있어서) 아무것도 안 한다.
    if prefs.damaged || !prefs.migrated {
        return false;
    }
    match prefs.decision(cid) {
        Some(Decision::Skip) => false,
        Some(Decision::Keep) => true,
        None => mine && prefs.auto_mine,
    }
}

fn is_cid(s: &str) -> bool {
    s.len() == 46 && s.starts_with("Qm") && s.bytes().all(|b| b.is_ascii_alphanumeric())
}

fn path() -> PathBuf {
    crate::paths::app_file(FILE)
}

/// 문자열 → 설정. 모양이 틀리면 `None`(= 손상).
pub(crate) fn parse(text: &str) -> Option<Prefs> {
    let v: Value = serde_json::from_str(text).ok()?;
    let o = v.as_object()?;
    let mut p = Prefs::default();
    if let Some(x) = o.get("auto_mine") {
        p.auto_mine = x.as_bool()?;
    }
    if let Some(x) = o.get("migrated") {
        p.migrated = x.as_bool()?;
    }
    if let Some(d) = o.get("decisions") {
        for (cid, val) in d.as_object()? {
            // 모르는 값·모르는 주소는 「안 정함」으로 둔다 — 중립이다.
            let dec = match val.as_str() {
                Some("keep") => Decision::Keep,
                Some("skip") => Decision::Skip,
                _ => continue,
            };
            if is_cid(cid) {
                p.decisions.insert(cid.clone(), dec);
            }
        }
    }
    Some(p)
}

fn render(p: &Prefs) -> Vec<u8> {
    let decisions: serde_json::Map<String, Value> =
        p.decisions.iter().map(|(k, v)| (k.clone(), json!(v.as_str()))).collect();
    serde_json::to_vec_pretty(&json!({
        "version": 1,
        "auto_mine": p.auto_mine,
        "migrated": p.migrated,
        "decisions": decisions,
    }))
    .unwrap_or_default()
}

/// 읽는다. 파일이 없으면 처음 쓰는 컴퓨터 — 기본값. 읽을 수 없거나 깨졌으면 `damaged`.
pub(crate) fn load() -> Prefs {
    let p = path();
    match std::fs::read_to_string(&p) {
        Ok(text) => match parse(&text) {
            Some(prefs) => prefs,
            // 깨진 파일은 그대로 둔다 — 사람이 「다시 켜기」를 누를 때까지 계속 「손상」으로 읽는다.
            None => Prefs::damaged(),
        },
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Prefs::default(),
        Err(_) => Prefs::damaged(),
    }
}

#[cfg(unix)]
fn open_private(path: &std::path::Path) -> std::io::Result<std::fs::File> {
    use std::os::unix::fs::OpenOptionsExt;
    std::fs::OpenOptions::new().write(true).create(true).truncate(true).mode(0o600).open(path)
}

#[cfg(not(unix))]
fn open_private(path: &std::path::Path) -> std::io::Result<std::fs::File> {
    std::fs::OpenOptions::new().write(true).create(true).truncate(true).open(path)
}

fn save(prefs: &Prefs) -> Result<(), String> {
    use std::io::Write;
    let path = path();
    if let Some(d) = path.parent() {
        let _ = std::fs::create_dir_all(d);
    }
    let tmp = path.with_extension("json.tmp");
    let fail = |e: std::io::Error| format!("보관 설정을 저장하지 못했습니다: {e}");
    {
        let mut f = open_private(&tmp).map_err(fail)?;
        f.write_all(&render(prefs)).map_err(fail)?;
        f.sync_all().map_err(fail)?;
    }
    std::fs::rename(&tmp, &path).map_err(fail)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
    }
    Ok(())
}

/// 화면에 주는 모양.
fn view(p: &Prefs) -> Value {
    let decisions: serde_json::Map<String, Value> =
        p.decisions.iter().map(|(k, v)| (k.clone(), json!(v.as_str()))).collect();
    json!({
        "auto_mine": p.auto_mine,
        "migrated": p.migrated,
        "damaged": p.damaged,
        "decisions": decisions,
    })
}

/// 0.8.7 이하에서 이미 붙잡고 있던 것을 「보관하기」로 옮겨 적는다. 이미 정한 것은 건드리지 않는다.
pub(crate) fn apply_migration(p: &mut Prefs, pins: &[String]) {
    for cid in pins {
        if p.decisions.len() >= MAX_DECISIONS {
            break;
        }
        if is_cid(cid) {
            p.decisions.entry(cid.clone()).or_insert(Decision::Keep);
        }
    }
    p.migrated = true;
}

/// 읽고, 아직이면 옮겨 적는다. 파일창고가 꺼져 있으면 `migrated` 가 거짓인 채로 돌려준다
/// (그동안 자동 보관은 아무것도 안 한다 — `auto_allowed`).
pub(crate) async fn ensure_migrated() -> Prefs {
    let first = load();
    if first.damaged || first.migrated {
        return first;
    }
    let Ok(pins) = crate::ipfs::pin_list().await else {
        return first;
    };
    let _guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut p = load();
    if p.damaged || p.migrated {
        return p;
    }
    apply_migration(&mut p, &pins);
    let _ = save(&p);
    p
}

/// 지금 내 뜻. 자산 화면이 열릴 때 부른다.
#[tauri::command]
pub async fn asset_keep_state() -> Value {
    view(&ensure_migrated().await)
}

/// 주소 여럿의 뜻을 한꺼번에 바꾼다. `decision` 은 `keep` · `skip` · `clear`(안 정함으로 되돌림).
#[tauri::command]
pub async fn asset_keep_set(cids: Vec<String>, decision: String) -> Result<Value, String> {
    let dec = match decision.as_str() {
        "keep" => Some(Decision::Keep),
        "skip" => Some(Decision::Skip),
        "clear" => None,
        _ => return Err("알 수 없는 보관 설정입니다.".into()),
    };
    if cids.len() > MAX_BATCH {
        return Err("한 번에 바꿀 수 있는 개수를 넘었습니다.".into());
    }
    let valid: Vec<String> = cids.into_iter().filter(|c| is_cid(c)).collect();
    // migrated 가 거짓이면 먼저 옮겨 적는다(꺼져 있으면 그대로) — 아래 쓰기가 옮겨 적기를 덮지 않게.
    let _ = ensure_migrated().await;
    let _guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut p = load();
    if p.damaged {
        return Err("보관 설정 파일이 손상되어 있어요. 「자동 보관 다시 켜기」를 먼저 눌러 주세요.".into());
    }
    for cid in &valid {
        match dec {
            Some(d) => {
                if p.decisions.len() < MAX_DECISIONS || p.decisions.contains_key(cid) {
                    p.decisions.insert(cid.clone(), d);
                }
            }
            None => {
                p.decisions.remove(cid);
            }
        }
        // 「보관하기」를 눌렀으면 6시간 기다리지 않고 다음 주기에 곧바로 다시 찾는다.
        if dec == Some(Decision::Keep) {
            crate::peers::forget_missed(cid);
        }
    }
    save(&p)?;
    Ok(view(&p))
}

/// 내가 만든 자산 파일을 자동으로 보관할지.
#[tauri::command]
pub async fn asset_keep_auto_mine(on: bool) -> Result<Value, String> {
    let _ = ensure_migrated().await;
    let _guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut p = load();
    if p.damaged {
        return Err("보관 설정 파일이 손상되어 있어요. 「자동 보관 다시 켜기」를 먼저 눌러 주세요.".into());
    }
    p.auto_mine = on;
    save(&p)?;
    Ok(view(&p))
}

/// 손상된 설정을 새로 시작한다. 이미 붙잡은 파일은 건드리지 않고(다음 `ensure_migrated` 가 「보관하기」로 옮겨 적는다),
/// 예전에 「보관 안 하기」로 정한 목록은 잃는다 — 그래서 사람이 직접 눌러야만 한다.
#[tauri::command]
pub async fn asset_keep_reset() -> Result<Value, String> {
    {
        let _guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());
        // 깨진 파일은 지우지 않고 옆으로 치운다 — 사람이 볼 수 있게.
        let p = path();
        if p.exists() {
            let _ = std::fs::rename(&p, p.with_extension("json.bad"));
        }
        save(&Prefs::default())?;
    }
    Ok(view(&ensure_migrated().await))
}

#[cfg(test)]
mod tests {
    use super::*;

    const A: &str = "QmcwUFCZ8saJgoE6D9LEgVqtteCbVcdzWFcGzuhe7VTeW7";
    const B: &str = "QmQ9SC6m3JMtK2ciA5Ds8yVq6o9h6x5zZ8kcN2d5wV8aXb";

    fn ready() -> Prefs {
        Prefs { migrated: true, ..Prefs::default() }
    }

    /// 🔴 받은 자산은 내가 묻기 전에는 자동으로 붙잡지 않는다. 내가 만든 것은 기본 켜짐.
    #[test]
    fn 자동_보관은_받은_것을_묻기_전에는_건너뛴다() {
        let p = ready();
        assert!(auto_allowed(&p, true, A), "내가 만든 것은 기본 보관");
        assert!(!auto_allowed(&p, false, A), "받은 것은 아직 안 정했으면 건너뜀");
    }

    /// 🔴 「보관 안 하기」는 내가 만든 것이어도 지켜진다 — 이게 안 지켜지면 화면이 거짓말을 한다.
    #[test]
    fn 보관_안_하기는_자동_보관이_건너뛴다() {
        let mut p = ready();
        p.decisions.insert(A.into(), Decision::Skip);
        p.decisions.insert(B.into(), Decision::Keep);
        assert!(!auto_allowed(&p, true, A));
        assert!(!auto_allowed(&p, false, A));
        assert!(auto_allowed(&p, false, B), "받은 것이어도 내가 보관하기로 했으면 한다");
        assert!(p.is_skipped(A) && !p.is_skipped(B));
    }

    #[test]
    fn 자동_보관_끄면_안_정한_내_것도_건너뛴다() {
        let mut p = ready();
        p.auto_mine = false;
        assert!(!auto_allowed(&p, true, A));
        p.decisions.insert(A.into(), Decision::Keep);
        assert!(auto_allowed(&p, true, A), "명시적으로 보관하기로 한 것은 한다");
    }

    /// 🔴 손상됐거나 옛 보관을 아직 못 옮겼으면 아무것도 안 한다(알 수 없는 뜻으로 움직이지 않는다).
    #[test]
    fn 손상_또는_미이전이면_아무것도_안_한다() {
        assert!(!auto_allowed(&Prefs::damaged(), true, A));
        assert!(!auto_allowed(&Prefs::default(), true, A), "migrated=false");
    }

    #[test]
    fn 모양이_틀린_설정은_손상이고_알_수_없는_값은_무시한다() {
        assert!(parse("not json").is_none());
        assert!(parse("[]").is_none());
        assert!(parse(r#"{"auto_mine":"yes"}"#).is_none());
        assert!(parse(r#"{"decisions":[]}"#).is_none());
        let p = parse(&format!(r#"{{"migrated":true,"decisions":{{"{A}":"keep","{B}":"maybe","zzz":"skip"}}}}"#)).unwrap();
        assert!(p.migrated && p.auto_mine);
        assert_eq!(p.decision(A), Some(Decision::Keep));
        assert_eq!(p.decision(B), None, "모르는 값은 안 정함");
        assert_eq!(p.decisions.len(), 1, "주소가 아닌 키는 버린다");
    }

    #[test]
    fn 옮겨_적기는_이미_정한_뜻을_덮지_않는다() {
        let mut p = Prefs::default();
        p.decisions.insert(A.into(), Decision::Skip);
        apply_migration(&mut p, &[A.to_string(), B.to_string(), "bad".to_string()]);
        assert!(p.migrated);
        assert_eq!(p.decision(A), Some(Decision::Skip));
        assert_eq!(p.decision(B), Some(Decision::Keep));
        assert_eq!(p.decisions.len(), 2);
    }

    #[test]
    fn 저장과_읽기_파일_권한_0600_손상_복구() {
        crate::create_history::tests::sandbox(|dir| {
            // 처음에는 파일이 없다 = 기본값(손상 아님).
            let p = load();
            assert!(!p.damaged && p.auto_mine && !p.migrated);

            let mut p = Prefs { migrated: true, ..Prefs::default() };
            p.decisions.insert(A.into(), Decision::Skip);
            save(&p).unwrap();
            assert_eq!(load(), p);
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                let mode = std::fs::metadata(dir.join(FILE)).unwrap().permissions().mode() & 0o777;
                assert_eq!(mode, 0o600);
            }

            // 깨뜨리면 손상으로 읽는다. 자동 보관은 멈춘다.
            std::fs::write(dir.join(FILE), b"{ broken").unwrap();
            let d = load();
            assert!(d.damaged);
            assert!(!auto_allowed(&d, true, A));
            assert!(load().damaged, "다시 읽어도 계속 손상 — 조용히 기본값으로 돌아가지 않는다");
            assert!(dir.join(FILE).exists());
        });
    }

    #[test]
    fn 손상일_때_바꾸기는_거절한다() {
        crate::create_history::tests::sandbox(|dir| {
            std::fs::write(dir.join(FILE), b"{ broken").unwrap();
            let r = tauri::async_runtime::block_on(asset_keep_set(vec![A.into()], "skip".into()));
            assert!(r.is_err());
            let r = tauri::async_runtime::block_on(asset_keep_auto_mine(false));
            assert!(r.is_err());
        });
    }
}
