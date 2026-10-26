//! 끌어다 놓은 백업 파일에서 되살리기 (0.9.0).
//!
//! 창에 `.pxlock`(가게 전체 백업) 또는 `.rvwallet`(wallet.dat 백업 파일)을 떨어뜨리면 화면이 이 명령들로
//! **확인 창**을 연다. 자산 드롭(`drop-files` → main.ts `onDropped`)과는 화면에서 확장자로 먼저 갈리고,
//! 여기서 머리(`PXRLOCK1`)로 한 번 더 확인한다.
//!
//! ## 🔴 규칙
//!
//! - **새 복원 경로를 만들지 않는다.** 되살리는 일은 기존 함수만 한다:
//!   - `.rvwallet` → `walletfile::wallet_import_prepare`(1단계, 현재 지갑을 건드리지 않음) →
//!     `walletfile::wallet_import_apply`(2단계, 지금 wallet.dat 을 `before-restore` 로 먼저 보관, 노드 꺼짐 요구)
//!   - `.pxlock` → `recover::restore_survey`(무엇이 들었나) → `recover::restore_apply`(같은 문)
//!   크기 상한(`MAX_IMPORT_BYTES`·4 GB)·압축 경로 조작 방어·머리 확인은 그 함수들 안의 것을 그대로 탄다.
//! - **바로 적용하지 않는다.** `inspect`(읽기만: 이름·크기·날짜) → `open`(지갑 암호 재인증 + 열쇠로 열어 보기,
//!   현재 지갑·가게 파일은 그대로) → `apply`(확인 체크 + 한 번 쓰는 표). `apply` 전에는 아무 파일도 바뀌지 않는다.
//! - **지갑 암호로 다시 인증**한다(`walletfile::reauth_for_restore` — 잠금 풀기와 같은 판단, 같은 기다림).
//! - **잘못된 열쇠·암호는 기다리게 한다**(`app_lock::backoff_secs`, 5번째부터).
//! - **잠긴 동안(대기화면·매장용 읽기 전용) 거부** — `app_lock::LOCKED_ALLOWED` 에 넣지 않는다.
//! - 표(ticket)는 메모리에만, 10분, 한 번. 열어 본 파일의 지문(SHA-256)에 묶여 있어서, 그 사이 파일이
//!   바뀌면 되살리지 않는다.
//! - 열쇠·암호·지갑 암호는 로그·오류 문구·반환값·표에 넣지 않는다.
//!
//! ## 0.9.0 병합 교차검토(GPT 6.1 sol, 2026-10-12) — 반영·보류
//!
//! - 반영: 열어 본 **뒤** 지문 재확인(open), 적용은 노드 확인 뒤 지문 확인 → 바로 적용(apply, 틈 축소),
//!   켤 때 지갑 가져오기 임시 폴더 정리(lib.rs setup), 메뉴 「백업에서 되돌리기」의 잠근 백업도 이 문으로(main.ts doRestore).
//! - 보류(대표 결정): 노드가 꺼져 있을 때 백업 암호 봉투를 재인증으로 인정 — 잠금 풀기(`app_lock::decide`)와 같은 판단이고,
//!   봉투 암호는 주인이 정한 비밀이며 현재 지갑은 `before-restore` 로 남는다. 더 엄격히 하려면 「열어 보기는 노드 켜고 지갑 암호로,
//!   적용은 노드 끄고」로 흐름을 바꿔야 한다(새 컴퓨터 첫 복구가 한 단계 늘어남).
//! - 보류(낮은 위험): 고른 파일을 앱 전용 폴더에 복사해 그 사본만 쓰는 완전한 TOCTOU 차단 — 같은 사용자 권한으로 파일을
//!   바꿀 수 있는 사람은 wallet.dat 를 직접 바꿀 수도 있다. 남은 틈은 지문 확인 → 기존 복원 함수가 다시 읽는 사이뿐.
//! - 보류(기존 경로): `restore_survey`·`restore_apply` IPC 는 그대로 열려 있고 시도 제한이 없다(잠그지 않은 zip·폴더 복원용).
//!   화면 경로는 잠근 백업을 이 문으로 보낸다.

use serde_json::{json, Value};
use std::path::PathBuf;
use std::sync::atomic::{AtomicI64, AtomicU32, Ordering};
use std::sync::Mutex;

/// 표의 수명(초).
const TICKET_SECS: i64 = 600;
const NODE_RUNNING_SAY: &str = "레이븐 노드가 아직 켜져 있어요. 노드를 완전히 끈 뒤 다시 눌러 주세요. 아직 아무것도 바꾸지 않았어요.";

static KEY_FAILS: AtomicU32 = AtomicU32::new(0);
static KEY_NEXT: AtomicI64 = AtomicI64::new(0);

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Kind {
    /// `.pxlock`(옛 `.잠김`) — 가게 전체 백업: 지갑과 가게 기록.
    Full,
    /// `.rvwallet` — wallet.dat 하나만.
    Wallet,
}

impl Kind {
    fn name(self) -> &'static str {
        match self {
            Kind::Full => "full",
            Kind::Wallet => "wallet",
        }
    }
    fn max_bytes(self) -> u64 {
        match self {
            Kind::Full => crate::backup_find::MAX_BYTES,
            Kind::Wallet => crate::walletfile::MAX_IMPORT_BYTES,
        }
    }
}

/// 이름으로 고른다(화면의 `backupDropKind` 와 같은 규칙). 대소문자 무시.
pub fn kind_of_name(name: &str) -> Option<Kind> {
    let n = name.to_lowercase();
    if n.ends_with(".rvwallet") {
        Some(Kind::Wallet)
    } else if n.ends_with(".pxlock") || n.ends_with(".잠김") {
        Some(Kind::Full)
    } else {
        None
    }
}

struct Ticket {
    id: String,
    kind: Kind,
    path: PathBuf,
    sha256: String,
    expires: i64,
    /// `.rvwallet`: 1단계가 만든 임시 폴더 id.
    staging: Option<String>,
    /// `.pxlock`: 들어 있는 것(restore_survey 의 key 목록).
    keys: Vec<String>,
}

fn tickets() -> &'static Mutex<Option<Ticket>> {
    static T: Mutex<Option<Ticket>> = Mutex::new(None);
    &T
}

fn now() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0)
}

fn key_wait_left(at: i64) -> i64 {
    KEY_NEXT.load(Ordering::Acquire) - at
}

fn note_wrong_key(at: i64) {
    let f = KEY_FAILS.fetch_add(1, Ordering::AcqRel) + 1;
    KEY_NEXT.store(at + crate::app_lock::backoff_secs(f), Ordering::Release);
}

fn key_ok() {
    KEY_FAILS.store(0, Ordering::Release);
    KEY_NEXT.store(0, Ordering::Release);
}

/// 놓은 파일 확인(읽기만). 돌려주는 것: (종류, 정규 경로, 크기, SHA-256, 바뀐 시각).
fn check_file(path: &str) -> Result<(Kind, PathBuf, u64, String, u64), String> {
    let p = PathBuf::from(path.trim());
    if path.trim().is_empty() || !p.is_absolute() {
        return Err("백업 파일을 창에 끌어다 놓거나 파일 선택창에서 골라 주세요.".into());
    }
    let name = p.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
    let kind = kind_of_name(&name).ok_or_else(|| "레이븐볼트 백업 파일(.pxlock · .rvwallet)이 아니에요.".to_string())?;
    // 바로가기·폴더·특수 파일은 받지 않는다(가리키는 곳이 바뀔 수 있다).
    let meta = std::fs::symlink_metadata(&p).map_err(|_| "그 파일을 열 수 없어요. 다시 놓아 주세요.".to_string())?;
    if !meta.file_type().is_file() {
        return Err("일반 파일이 아니에요(바로가기·폴더는 받지 않아요). 원래 백업 파일을 놓아 주세요.".into());
    }
    if meta.len() == 0 {
        return Err("빈 파일이에요.".into());
    }
    if meta.len() > kind.max_bytes() {
        return Err("백업 파일로 보기에는 너무 커요. 다른 파일을 놓아 주세요.".into());
    }
    // backup_find 의 검사 그대로 — 첫 여덟 바이트가 PXRLOCK1 이어야 잠근 백업이다.
    let (size, sha, head) = crate::backup_find::digest(&p).ok_or_else(|| "파일을 읽지 못했어요. 권한을 확인해 주세요.".to_string())?;
    if &head != crate::backup_find::LOCK_MAGIC {
        return Err("잠근 백업 형식이 아니에요. 파일이 손상됐거나 다른 파일이에요.".into());
    }
    let at = meta.modified().ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_secs()).unwrap_or(0);
    Ok((kind, p, size, sha, at))
}

/// 1) 놓은 파일 보기 — **읽기만** 한다. 이름·크기·날짜와 되살리는 범위.
#[tauri::command]
pub fn restore_drop_inspect(path: String) -> Result<Value, String> {
    let (kind, p, size, _sha, at) = check_file(&path)?;
    Ok(json!({
        "kind": kind.name(),
        "name": p.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default(),
        "path": p.to_string_lossy(),
        "size": size,
        "modified": at,
        "day": crate::backup::day_name(at as i64 - (at as i64).rem_euclid(86_400)),
        // 되살리는 범위 — 화면이 확인 창에 분명히 적는다.
        "scope": match kind { Kind::Full => "wallet_and_shop", Kind::Wallet => "wallet_only" },
    }))
}

/// 2) 지갑 암호로 다시 인증하고, 열쇠(52글자) 또는 백업 암호로 **열어 보기만** 한다. 현재 지갑·가게 파일은 그대로.
///
/// `mode`: `"key"`(종이의 52글자) | `"pass"`(백업 암호). `.pxlock` 은 이 컴퓨터에서 만든 것이면 비워 둬도 열린다.
#[tauri::command]
pub async fn restore_drop_open(path: String, mode: String, secret: String, wallet_pass: String) -> Result<Value, String> {
    let wait = key_wait_left(now());
    if wait > 0 {
        return Err(format!("열쇠·암호를 여러 번 틀려서 잠시 기다려야 해요. {wait}초 뒤에 다시 해 주세요."));
    }
    if mode != "key" && mode != "pass" {
        return Err("여는 방법이 올바르지 않아요.".into());
    }
    let (kind, p, _size, sha, _at) = check_file(&path)?;
    // 지갑 암호 재인증(노드가 켜져 있으면 노드, 꺼져 있으면 백업 암호 봉투). 틀리면 같은 기다림.
    let verified_by = crate::walletfile::reauth_for_restore(&wallet_pass).await?;
    drop(wallet_pass);
    // 열어 보기 — 기존 함수 그대로.
    let opened: Result<(Option<String>, Vec<String>, Value), String> = match kind {
        Kind::Wallet => {
            if secret.is_empty() {
                return Err("종이의 52글자 열쇠 또는 백업 암호를 넣어 주세요.".into());
            }
            crate::walletfile::wallet_import_prepare(p.to_string_lossy().to_string(), mode, secret).await.map(|r| {
                let id = r["id"].as_str().map(str::to_string);
                (id, vec!["wallet".to_string()], json!({
                    "fingerprint": r["fingerprint"], "size": r["size"], "same_as_current": r["same_as_current"],
                    "items": [{ "key": "wallet", "what": "지갑", "why": "잔액과 자산의 열쇠입니다" }],
                }))
            })
        }
        Kind::Full => crate::recover::restore_survey(p.to_string_lossy().to_string(), Some(secret)).map(|r| {
            let keys = r["items"].as_array().map(|a| a.iter().filter_map(|i| i["key"].as_str().map(str::to_string)).collect()).unwrap_or_default();
            (None, keys, json!({ "items": r["items"], "day": r["day"], "empty": r["empty"], "note": r["note"] }))
        }),
    };
    let (staging, keys, view) = match opened {
        Ok(v) => v,
        Err(e) => {
            // 다른 작업과 겹친 것은 열쇠 탓이 아니다.
            if !e.contains("진행 중") {
                note_wrong_key(now());
            }
            return Err(e);
        }
    };
    key_ok();
    // 0.9.0 병합(GPT 교차검토 Q2) — 확인(check_file)과 열어 보기(prepare/survey) 사이에 파일이 바뀌었으면
    // 열어 본 내용이 지문과 다를 수 있다. 열어 본 뒤 한 번 더 지문을 보고, 다르면 풀어 둔 것을 치우고 멈춘다.
    match check_file(&p.to_string_lossy()) {
        Ok((k2, _, _, sha2, _)) if k2 == kind && sha2 == sha => {}
        _ => {
            let _ = cancel_all();
            return Err("확인하는 사이에 파일이 바뀌었어요. 아무것도 바꾸지 않았어요. 처음부터 다시 해 주세요.".into());
        }
    }
    if keys.is_empty() {
        crate::recover::청소();
        return Err("이 백업에는 되돌릴 것이 없어요. 다른 백업을 놓아 주세요.".into());
    }
    let id = {
        use rand::RngCore;
        let mut b = [0u8; 16];
        rand::thread_rng().fill_bytes(&mut b);
        hex::encode(b)
    };
    *tickets().lock().unwrap_or_else(|e| e.into_inner()) =
        Some(Ticket { id: id.clone(), kind, path: p, sha256: sha, expires: now() + TICKET_SECS, staging, keys });
    let mut out = view;
    out["ticket"] = json!(id);
    out["kind"] = json!(kind.name());
    out["verified_by"] = json!(verified_by);
    out["expires_in"] = json!(TICKET_SECS);
    Ok(out)
}

/// 표를 꺼낸다(맞으면 비운다). 틀리거나 지났으면 그대로 두지 않고 오류.
fn take_ticket(id: &str) -> Result<Ticket, String> {
    let mut g = tickets().lock().unwrap_or_else(|e| e.into_inner());
    match g.as_ref() {
        Some(t) if t.id == id && t.expires > now() => Ok(g.take().unwrap()),
        Some(t) if t.id == id => {
            *g = None;
            Err("확인한 지 오래돼서 다시 확인해야 해요. 처음부터 다시 해 주세요.".into())
        }
        _ => Err("되살리기 준비가 없어요(이미 쓰였거나 취소됐어요). 처음부터 다시 해 주세요.".into()),
    }
}

fn put_back(t: Ticket) {
    *tickets().lock().unwrap_or_else(|e| e.into_inner()) = Some(t);
}

/// 3) 사용자가 확인한 뒤에만 되살린다 — 기존 복원 함수 그대로. 노드가 켜져 있으면 아무것도 바꾸지 않고 거절.
///
/// `secret`: `.pxlock` 은 되살릴 때 다시 열어야 하므로 같은 열쇠·암호를 한 번 더 받는다(어디에도 저장하지 않는다).
#[tauri::command]
pub async fn restore_drop_apply(ticket: String, secret: String, confirmed: bool) -> Result<Value, String> {
    if !confirmed {
        return Err("되살리기 전에 확인이 필요해요.".into());
    }
    let t = take_ticket(&ticket)?;
    // 노드가 켜져 있으면(지갑 파일 밑을 바꾸면 안 된다) 아무것도 하지 않고 표를 돌려준다.
    if crate::raven::call_rpc("getblockchaininfo", json!([])).await.is_ok() {
        put_back(t);
        return Err(NODE_RUNNING_SAY.into());
    }
    // 열어 본 그 파일이어야 한다(그 사이 바뀌었으면 되살리지 않는다). 노드 확인(네트워크 대기) **뒤**, 적용 바로 앞에서
    // 본다 — 확인과 적용 사이 틈을 줄인다(0.9.0 병합, GPT 교차검토 Q2).
    match check_file(&t.path.to_string_lossy()) {
        Ok((kind, _, _, sha, _)) if kind == t.kind && sha == t.sha256 => {}
        _ => {
            let _ = cancel_all();
            return Err("확인한 뒤에 파일이 바뀌었어요. 아무것도 바꾸지 않았어요. 처음부터 다시 해 주세요.".into());
        }
    }
    let r = match t.kind {
        Kind::Wallet => {
            let id = t.staging.clone().unwrap_or_default();
            crate::walletfile::wallet_import_apply(id, true).await
        }
        Kind::Full => crate::recover::restore_apply(t.path.to_string_lossy().to_string(), t.keys.clone(), Some(secret)).await,
    };
    drop(t);
    r
}

fn cancel_all() -> Value {
    let had = tickets().lock().unwrap_or_else(|e| e.into_inner()).take().is_some();
    let _ = crate::walletfile::wallet_import_cancel();
    crate::recover::청소();
    json!({ "ok": true, "had": had })
}

/// 그만두기 — 표와 임시로 풀어 둔 것을 치운다. 현재 지갑·가게 파일은 처음부터 그대로다.
#[tauri::command]
pub fn restore_drop_cancel() -> Value {
    cancel_all()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    const NEW: [&str; 4] = ["restore_drop_inspect", "restore_drop_open", "restore_drop_apply", "restore_drop_cancel"];

    fn dir(name: &str) -> PathBuf {
        let d = crate::paths::test_fixture_root().join(name);
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn snapshot(dir: &Path) -> Vec<(PathBuf, Vec<u8>)> {
        let mut out = Vec::new();
        let mut stack = vec![dir.to_path_buf()];
        while let Some(d) = stack.pop() {
            for e in std::fs::read_dir(&d).unwrap().flatten() {
                let p = e.path();
                if p.is_dir() { stack.push(p) } else { out.push((p.clone(), std::fs::read(&p).unwrap())) }
            }
        }
        out.sort();
        out
    }

    fn code() -> &'static str {
        let src = include_str!("restore_drop.rs");
        &src[..src.find("#[cfg(test)]\nmod tests").unwrap()]
    }

    fn body_of<'a>(src: &'a str, head: &str) -> &'a str {
        let f = &src[src.find(head).unwrap()..];
        &f[..f.find("\n}\n").unwrap()]
    }

    #[test]
    fn names_pick_the_kind_like_the_screen_does() {
        assert_eq!(kind_of_name("RavenVault.zip.pxlock"), Some(Kind::Full));
        assert_eq!(kind_of_name("PLAYXRaven.zip.잠김"), Some(Kind::Full));
        assert_eq!(kind_of_name("RavenVault-wallet-20261012.RVWALLET"), Some(Kind::Wallet));
        for n in ["photo.png", "wallet.dat", "RavenVault.zip", "x.pxlock.png", "rvwallet", ""] {
            assert_eq!(kind_of_name(n), None, "{n}");
        }
        // 화면 쪽(src/backup-drop-route.ts)과 같은 확장자 셋인지는 scripts/backup-drop.test.mjs 가 본다.
    }

    #[test]
    fn inspect_reads_only_and_refuses_what_is_not_a_locked_backup() {
        let d = dir("rd-inspect");
        let good = d.join("RavenVault-wallet-S.rvwallet");
        std::fs::write(&good, [b"PXRLOCK1".as_slice(), &[7u8; 64]].concat()).unwrap();
        let full = d.join("RavenVault.zip.pxlock");
        std::fs::write(&full, [b"PXRLOCK1".as_slice(), &[9u8; 64]].concat()).unwrap();
        let before = snapshot(&d);
        let v = restore_drop_inspect(good.to_string_lossy().to_string()).unwrap();
        assert_eq!(v["kind"], "wallet");
        assert_eq!(v["scope"], "wallet_only");
        assert_eq!(v["size"], 72);
        assert_eq!(v["name"], "RavenVault-wallet-S.rvwallet");
        let v = restore_drop_inspect(full.to_string_lossy().to_string()).unwrap();
        assert_eq!((v["kind"].as_str(), v["scope"].as_str()), (Some("full"), Some("wallet_and_shop")));
        assert_eq!(snapshot(&d), before, "보기만 했는데 파일이 바뀌었다");
        // 머리가 다르면(이름만 .pxlock) 거절.
        let fake = d.join("fake.pxlock");
        std::fs::write(&fake, b"PK\x03\x04 not locked").unwrap();
        assert!(restore_drop_inspect(fake.to_string_lossy().to_string()).is_err());
        // 빈 파일 · 모르는 확장자 · 상대 경로 · 폴더 · 없는 파일.
        let empty = d.join("e.rvwallet");
        std::fs::write(&empty, b"").unwrap();
        assert!(restore_drop_inspect(empty.to_string_lossy().to_string()).is_err());
        let png = d.join("a.png");
        std::fs::write(&png, b"PXRLOCK1 but a png name").unwrap();
        assert!(restore_drop_inspect(png.to_string_lossy().to_string()).is_err());
        assert!(restore_drop_inspect("relative/x.rvwallet".into()).is_err());
        assert!(restore_drop_inspect("".into()).is_err());
        let folder = d.join("folder.pxlock");
        std::fs::create_dir_all(&folder).unwrap();
        assert!(restore_drop_inspect(folder.to_string_lossy().to_string()).is_err());
        assert!(restore_drop_inspect(d.join("missing.rvwallet").to_string_lossy().to_string()).is_err());
        // 크기 상한(.rvwallet 은 walletfile 의 MAX_IMPORT_BYTES) — 성긴 파일로.
        let big = d.join("big.rvwallet");
        let f = std::fs::File::create(&big).unwrap();
        f.set_len(crate::walletfile::MAX_IMPORT_BYTES + 1).unwrap();
        drop(f);
        assert!(restore_drop_inspect(big.to_string_lossy().to_string()).unwrap_err().contains("너무 커요"));
        let _ = std::fs::remove_file(&big);
    }

    #[cfg(unix)]
    #[test]
    fn inspect_refuses_symlinks() {
        let d = dir("rd-link");
        let real = d.join("real.rvwallet");
        std::fs::write(&real, [b"PXRLOCK1".as_slice(), &[1u8; 8]].concat()).unwrap();
        let link = d.join("link.rvwallet");
        std::os::unix::fs::symlink(&real, &link).unwrap();
        assert!(restore_drop_inspect(link.to_string_lossy().to_string()).is_err());
    }

    #[test]
    fn nothing_changes_before_the_confirmation_and_without_a_ticket() {
        let _g = crate::paths::TEST_ENV.lock().unwrap_or_else(|e| e.into_inner());
        let app = dir("rd-app");
        let raven = dir("rd-raven");
        std::fs::write(raven.join("wallet.dat"), b"synthetic current wallet").unwrap();
        std::fs::write(app.join("raven-datadir.txt"), raven.to_string_lossy().as_bytes()).unwrap();
        std::env::set_var("PLAYX_RAVEN_HOME", &app);
        let drop_dir = dir("rd-drop");
        let file = drop_dir.join("RavenVault-wallet-S.rvwallet");
        std::fs::write(&file, [b"PXRLOCK1".as_slice(), &[3u8; 128]].concat()).unwrap();
        let before = (snapshot(&raven), snapshot(&drop_dir));
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        let path = file.to_string_lossy().to_string();
        // 보기.
        restore_drop_inspect(path.clone()).unwrap();
        // 열어 보기 — 시험에는 노드도 백업 암호 봉투도 없다 → 지갑 암호를 확인할 수 없어 거절, 표 없음.
        let e = rt.block_on(restore_drop_open(path.clone(), "key".into(), "0".repeat(52), "synthetic-wallet-pass".into())).unwrap_err();
        assert!(!e.contains("synthetic-wallet-pass") && !e.contains(&"0".repeat(52)), "오류에 비밀이 들어갔다: {e}");
        assert!(tickets().lock().unwrap().is_none(), "인증 없이 표가 생겼다");
        assert!(rt.block_on(restore_drop_open(path.clone(), "other".into(), "x".into(), "y".into())).is_err());
        // 확인 없이 · 표 없이 · 지어낸 표로는 되살리지 않는다.
        assert!(rt.block_on(restore_drop_apply("a".repeat(32), String::new(), false)).is_err());
        assert!(rt.block_on(restore_drop_apply("a".repeat(32), String::new(), true)).is_err());
        assert!(rt.block_on(restore_drop_apply(String::new(), String::new(), true)).is_err());
        restore_drop_cancel();
        assert_eq!((snapshot(&raven), snapshot(&drop_dir)), before, "확인 전에 지갑·백업 파일이 바뀌었다");
        assert!(!crate::paths::app_file("wallet-import").exists(), "임시 폴더가 남았다");
        std::env::remove_var("PLAYX_RAVEN_HOME");
    }

    #[test]
    fn a_ticket_is_one_shot_expires_and_is_bound_to_the_file() {
        // 표는 하나뿐(전역) — 표를 보는 다른 시험과 겹치지 않게 같은 자물쇠를 잡는다.
        let _g = crate::paths::TEST_ENV.lock().unwrap_or_else(|e| e.into_inner());
        let d = dir("rd-ticket");
        let file = d.join("RavenVault-wallet-T.rvwallet");
        std::fs::write(&file, [b"PXRLOCK1".as_slice(), &[4u8; 32]].concat()).unwrap();
        let (_, p, _, sha, _) = check_file(&file.to_string_lossy()).unwrap();
        let put = |id: &str, expires: i64, sha: &str| put_back(Ticket { id: id.into(), kind: Kind::Wallet, path: p.clone(), sha256: sha.into(), expires, staging: None, keys: vec!["wallet".into()] });
        put("t1", now() + 60, &sha);
        assert!(take_ticket("nope").is_err(), "다른 표로 꺼내졌다");
        assert!(take_ticket("t1").is_ok());
        assert!(take_ticket("t1").is_err(), "한 번 쓴 표가 또 쓰였다");
        put("t2", now() - 1, &sha);
        assert!(take_ticket("t2").is_err(), "지난 표가 쓰였다");
        assert!(tickets().lock().unwrap().is_none());
        // 확인한 뒤 파일이 바뀌면 되살리지 않는다(노드에 묻기 전에, 지갑 파일을 건드리기 전에).
        put("t3", now() + 60, &sha);
        std::fs::write(&file, [b"PXRLOCK1".as_slice(), &[5u8; 32]].concat()).unwrap();
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        let e = rt.block_on(restore_drop_apply("t3".into(), String::new(), true)).unwrap_err();
        assert!(e.contains("바뀌었어요"), "{e}");
        assert!(tickets().lock().unwrap().is_none());
    }

    #[test]
    fn wrong_keys_wait_after_five_tries() {
        let (f0, n0) = (KEY_FAILS.load(Ordering::Acquire), KEY_NEXT.load(Ordering::Acquire));
        KEY_FAILS.store(0, Ordering::Release);
        KEY_NEXT.store(0, Ordering::Release);
        let t = 2_000_000;
        for _ in 0..4 {
            note_wrong_key(t);
            assert!(key_wait_left(t) <= 0);
        }
        note_wrong_key(t);
        assert_eq!(key_wait_left(t), 30);
        key_ok();
        assert!(key_wait_left(t) <= 0, "맞히면 기다림이 풀린다");
        // open 은 기다림을 가장 먼저 본다(인증·파일 열기 전에).
        let f = body_of(code(), "pub async fn restore_drop_open");
        assert!(f.find("key_wait_left(").unwrap() < f.find("reauth_for_restore").unwrap());
        assert!(f.find("reauth_for_restore").unwrap() < f.find("wallet_import_prepare").unwrap());
        assert!(f.find("reauth_for_restore").unwrap() < f.find("restore_survey").unwrap());
        KEY_FAILS.store(f0, Ordering::Release);
        KEY_NEXT.store(n0, Ordering::Release);
    }

    #[test]
    fn only_the_existing_restore_functions_change_files() {
        let c = code();
        // 새 복원 경로가 없다: 파일을 쓰거나 옮기거나 지우는 코드가 이 파일에 없다.
        for bad in ["fs::write", "fs::copy", "fs::rename", "remove_file", "remove_dir", "create_dir", "OpenOptions", "unlock_file", "extract_archive", "ZipArchive"] {
            assert!(!c.contains(bad), "restore_drop.rs 에 {bad}");
        }
        // 되살리기는 확인 → 표 → 같은 파일 → 노드 꺼짐 → 기존 함수 순서.
        let a = body_of(c, "pub async fn restore_drop_apply");
        let at = |s: &str| a.find(s).unwrap_or_else(|| panic!("{s}"));
        // 0.9.0 병합: 노드 확인(네트워크 대기)을 먼저, 지문 확인은 적용 바로 앞 — 확인과 적용 사이 틈을 줄인다.
        assert!(at("if !confirmed") < at("take_ticket(") && at("take_ticket(") < at("getblockchaininfo") && at("getblockchaininfo") < at("check_file("));
        assert!(at("check_file(") < at("wallet_import_apply(") && at("check_file(") < at("restore_apply("));
        // 열어 보기도 열어 본 **뒤** 지문을 한 번 더 본다(확인과 열어 보기 사이 바꿔치기).
        let o = body_of(c, "pub async fn restore_drop_open");
        let first = o.find("check_file(").unwrap();
        let again = o[first + 1..].find("check_file(").map(|i| i + first + 1).expect("열어 본 뒤 지문 재확인이 없다");
        assert!(o.find("wallet_import_prepare").unwrap() < again && o.find("restore_survey").unwrap() < again);
        assert!(o[again..].contains("cancel_all()"), "지문이 다르면 풀어 둔 것을 치워야 한다");
        // 켤 때 지갑 가져오기 임시 폴더(풀어 둔 wallet.dat)를 쓴다.
        let lib = include_str!("lib.rs");
        assert!(lib[lib.find(".setup(|app|").unwrap()..].contains("walletfile::wallet_import_cancel()"));
        // 열어 보기는 되살리지 않는다.
        let o = body_of(c, "pub async fn restore_drop_open");
        assert!(!o.contains("restore_apply") && !o.contains("wallet_import_apply"));
        // 반환값·표에 비밀이 없다.
        let ticket = &c[c.find("struct Ticket").unwrap()..];
        let ticket = &ticket[..ticket.find("\n}\n").unwrap()];
        for bad in ["secret", "pass", "key:"] {
            assert!(!ticket.contains(bad), "표에 {bad}");
        }
        for f in [o, a] {
            assert!(!f.contains("\"secret\"") && !f.contains("\"wallet_pass\""));
        }
    }

    #[test]
    fn the_drop_commands_are_refused_while_locked_and_registered_behind_the_gate() {
        for c in NEW {
            assert!(!crate::app_lock::allowed_while_locked(c), "{c} 가 잠긴 동안 허용 목록에 있다");
        }
        // app-lock.json 은 같은 임시 이름으로 쓴다 — 잠금을 쓰는 다른 시험과 겹치지 않게 같은 자물쇠를 잡는다.
        let _g = crate::paths::TEST_ENV.lock().unwrap_or_else(|e| e.into_inner());
        crate::app_lock::lock("standby").unwrap();
        assert!(crate::app_lock::is_locked());
        for c in NEW {
            assert!(!crate::app_lock::command_allowed(c), "잠긴 동안 {c} 가 통과한다");
        }
        crate::app_lock::lock("store").unwrap();
        for c in NEW {
            assert!(!crate::app_lock::command_allowed(c), "매장용 읽기 전용에서 {c} 가 통과한다");
        }
        let lib = include_str!("lib.rs");
        assert!(lib.find("app_lock::command_allowed").unwrap() < lib.find("generate_handler!").unwrap());
        for c in NEW {
            assert!(lib.contains(&format!("restore_drop::{c},")), "{c} 등록");
        }
        assert!(!include_str!("server.rs").contains("restore_drop"), "폰·직원 HTTP 에 열려 있다");
    }
}
