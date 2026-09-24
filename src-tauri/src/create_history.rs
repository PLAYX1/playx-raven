//! 「만들기」 기록 — 이 컴퓨터가 만든 것, 그리고 **원본 지문** 목록.
//!
//! ## 왜 따로 남기나
//!
//! 1. 완료 화면은 한 번 보고 나면 사라졌다. 증명서 50장을 만든 사장은 다음 날
//!    「3번 사람 것 다시 뽑아 주세요」를 들어도 찾을 곳이 없었다. 여기 남긴다.
//! 2. 🔴 받는 사람 이름·발급자·설명은 **체인에도 파일창고에도 안 올린다.**
//!    인쇄하는 종이와 이 파일에만 있다. 그래서 이 파일이 그 사람들의 유일한
//!    기록이고, 앱 자료 폴더(0700) 안에 0600 으로 둔다.
//! 3. 🔴 **원본 지문은 파일창고 주소처럼 생겼다**(`Qm…`, 파일 SHA-256 을 CIDv0
//!    모양으로 적은 것). 모양만으로는 가려낼 수 없어서, 예전에는 자동 보존이
//!    지문마다 `pin_add` 를 불러 한 장에 5분씩 기다렸고(50장이면 몇 시간),
//!    공개 목록(`/api/pins`)에도 「파일」로 나갔다. 이 컴퓨터가 지문으로 만든
//!    것은 **여기 적어 두고** 보존·확인·미리보기·공개 목록에서 뺀다.
//!    ⚠️ 남(폰·다른 컴퓨터)이 만든 지문은 알 길이 없다 — 화면이 정직하게
//!       「지문일 수도 있다」고 말한다. 여기서 추측하지 않는다.
//!
//! 지문은 **발행 길(`create_issue`)에서만** 적는다 — 노드가 받았거나(거래 번호),
//! 보냈는지 모를 때(시간 초과). 화면이 보낸 아무 `Qm…` 나 적으면 남의 진짜 파일을
//! 「지문」으로 여겨 보존에서 빼 버릴 수 있다(0.4.5 검수).
//!
//! 4. 🔴 **보냈는지 모름(`sent-unknown`)** — 발행 부름이 시간 초과로 끝나면 노드가
//!    실제로 보냈을 수 있다. 그 기록은 지우지 않고, 풀리기 전에는 새로 만들지
//!    않는다(`create_issue` 가 막는다). 「다시 확인」이 체인·지갑을 보고 푼다.
//! 5. 받는 사람·발급자·설명·서명·파일 이름은 가게의 회원 정보 보관 기간(설정이
//!    없으면 12개월)이 지나면 지운다. 체인 이름·지문·거래 번호는 남는다.
//! 6. 🔴 **보내는 중(`sending`)** — 발행을 부르기 **직전에** 적는다. 최대 3분을
//!    기다리는 동안 앱을 강제로 끄면 기록은 `started` 로 남아, 다시 켠 뒤 같은
//!    묶음을 다음 번호로 또 만들었다(검수 S10). `sending` 인데 지금 보내는 중이
//!    아니면(앱을 다시 켰다) 「보냈는지 모름」과 같게 본다.

use serde_json::{json, Map, Value};
use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::Mutex;

const FILE: &str = "create_history.json";
const MAX_ENTRIES: usize = 2_000;
const MAX_FINGERPRINTS: usize = 20_000;
/// 끝나지 않은 기록(이름 등록만 하고 그만둔 것)은 이만큼 지나면 지운다 —
/// 받는 사람 이름이 이유 없이 남지 않게.
const ABANDONED_AFTER_SECS: i64 = 30 * 24 * 3600;
/// 보냈는지 모르는 것을 「안 나갔다」고 말해도 되는 때. 노드가 거래를 만들었으면
/// 지갑에 바로(확인 0) 보인다 — 한 시간 넘게 안 보이면 만들지 않은 것이다.
pub const UNKNOWN_GIVE_UP_SECS: i64 = 3600;
/// 인쇄 파일(받는 사람 이름이 든 HTML)은 만든 지 이만큼 지나면 지운다. 다시 인쇄하면 새로 쓴다.
const PRINT_KEEP_SECS: u64 = 7 * 24 * 3600;
/// 가게가 보관 기간을 정한 적 없으면 받는 사람 이름 등을 이만큼 둔다.
const DEFAULT_KEEP_MONTHS: u32 = 12;
/// 보관 기간이 지나면 지우는 칸 — 사람을 알아볼 수 있는 것들.
/// `rows` 는 표로 올린 줄마다의 과정·등급·번호·비고 — 사진처럼 그 사람을 알아볼 수 있다.
const PERSONAL_KEYS: [&str; 6] = ["recipients", "rows", "issuer", "signer", "description", "file_name"];
pub const MAX_RECIPIENTS: usize = crate::create::MAX_COPIES;

static LOCK: Mutex<()> = Mutex::new(());

fn path() -> PathBuf {
    crate::paths::app_file(FILE)
}

fn now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

fn empty() -> Value {
    json!({ "version": 1, "fingerprints": [], "entries": [] })
}

/// 🔴 화면은 이 글자를 보고 「기록을 새로 시작」 단추를 낸다 — 바꾸면 `create-page.ts` 도.
pub const CORRUPT: &str = "CREATE_HISTORY_CORRUPT: 만든 기록 파일이 손상됐어요. 백업(설정 → 백업)에서 되살리거나, 「기록을 새로 시작」을 눌러 주세요 — 망가진 파일은 지우지 않고 옆에 남겨 둬요.";

/// 읽는다. 없으면 빈 기록. 🔴 **망가졌으면 오류다** — 빈 기록으로 보고 그 위에
/// 쓰면 지난 기록 전부가 조용히 사라진다.
fn load() -> Result<Value, String> {
    let bytes = match std::fs::read(path()) {
        Ok(b) => b,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(empty()),
        Err(_) => return Err("만든 기록을 읽지 못했어요. 앱 자료 폴더 권한을 확인해 주세요.".into()),
    };
    let v: Value = serde_json::from_slice(&bytes).map_err(|_| CORRUPT.to_string())?;
    if v.get("version").and_then(Value::as_i64) != Some(1)
        || !v.get("entries").map(Value::is_array).unwrap_or(false)
        || !v.get("fingerprints").map(Value::is_array).unwrap_or(false)
    {
        return Err(CORRUPT.into());
    }
    Ok(v)
}

/// 0600 으로 만들고 내용을 다 쓴 뒤에 이름을 바꾼다. 쓰다 죽어도 반쪽 파일이
/// 원본 자리에 남지 않는다.
pub(crate) fn write_private(path: &std::path::Path, bytes: &[u8]) -> Result<(), String> {
    use std::io::Write;
    let fail = |_| "이 컴퓨터에 기록을 남기지 못했어요. 앱 자료 폴더 권한과 여유 공간을 확인해 주세요.".to_string();
    if let Some(dir) = path.parent() {
        private_dir(dir).map_err(fail)?;
    }
    let pending = path.with_extension(format!("pending-{:016x}", rand::random::<u64>()));
    let result = (|| -> std::io::Result<()> {
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&pending)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        drop(file);
        std::fs::rename(&pending, path)
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&pending);
    }
    result.map_err(fail)
}

/// 폴더가 없으면 본인 전용(0700)으로 만든다. 이미 있으면 남에게 열려 있을 때만 조인다.
pub(crate) fn private_dir(dir: &std::path::Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dir)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(dir)?.permissions().mode();
        if mode & 0o077 != 0 {
            std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))?;
        }
    }
    Ok(())
}

fn save(v: &Value) -> Result<(), String> {
    let bytes = serde_json::to_vec_pretty(v).map_err(|e| e.to_string())?;
    write_private(&path(), &bytes)
}

fn with_store<T>(f: impl FnOnce(&mut Value) -> Result<T, String>) -> Result<T, String> {
    let _guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut store = load()?;
    let out = f(&mut store)?;
    save(&store)?;
    Ok(out)
}

pub fn is_cid_v0(s: &str) -> bool {
    const B58: &str = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
    s.len() == 46 && s.starts_with("Qm") && s.chars().all(|c| B58.contains(c))
}

/* ── 원본 지문 ─────────────────────────────────────────────────────── */

/// 이 컴퓨터가 지문으로 만든 해시를 적는다. 발행을 부르기 **전에** 부른다.
pub fn remember_fingerprint(cid: &str) -> Result<(), String> {
    if !is_cid_v0(cid) {
        return Err("파일 지문 모양이 올바르지 않습니다.".into());
    }
    with_store(|store| {
        let list = store["fingerprints"].as_array_mut().unwrap();
        if !list.iter().any(|v| v.as_str() == Some(cid)) {
            list.push(json!(cid));
            if list.len() > MAX_FINGERPRINTS {
                let extra = list.len() - MAX_FINGERPRINTS;
                list.drain(..extra);
            }
        }
        Ok(())
    })
}

/// 이 컴퓨터가 지문으로 만든 해시 전부. 못 읽으면 **빈 목록** — 보존이 예전처럼
/// 도는 쪽으로 넘어간다(지문을 파일로 잘못 보는 것은 시간 낭비일 뿐 해는 없다).
pub fn fingerprint_set() -> HashSet<String> {
    let _guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    load()
        .ok()
        .and_then(|v| {
            v["fingerprints"]
                .as_array()
                .map(|a| a.iter().filter_map(|x| x.as_str().map(str::to_string)).collect())
        })
        .unwrap_or_default()
}

/// 화면용. 자산 목록이 「원본 지문」을 알아보는 데 쓴다.
#[tauri::command]
pub fn create_fingerprints() -> Vec<String> {
    let mut v: Vec<String> = fingerprint_set().into_iter().collect();
    v.sort();
    v
}

/* ── 기록 한 줄 ────────────────────────────────────────────────────── */

fn clean_line(v: Option<&Value>, max: usize, what: &str) -> Result<Option<String>, String> {
    let Some(v) = v else { return Ok(None) };
    if v.is_null() {
        return Ok(None);
    }
    let s = v.as_str().ok_or_else(|| format!("{what}을(를) 확인해 주세요."))?;
    if s.chars().any(|c| c.is_control()) {
        return Err(format!("{what}에는 줄바꿈이나 제어 문자를 넣을 수 없어요."));
    }
    let s = s.trim();
    if s.chars().count() > max {
        return Err(format!("{what}은(는) {max}자까지 적을 수 있어요."));
    }
    Ok(if s.is_empty() { None } else { Some(s.to_string()) })
}

fn clean_text(v: Option<&Value>, max: usize, what: &str) -> Result<Option<String>, String> {
    let Some(v) = v else { return Ok(None) };
    if v.is_null() {
        return Ok(None);
    }
    let s = v.as_str().ok_or_else(|| format!("{what}을(를) 확인해 주세요."))?;
    if s.chars().any(|c| c.is_control() && c != '\n') {
        return Err(format!("{what}에는 제어 문자를 넣을 수 없어요."));
    }
    let s = s.trim();
    if s.chars().count() > max {
        return Err(format!("{what}은(는) {max}자까지 적을 수 있어요."));
    }
    Ok(if s.is_empty() { None } else { Some(s.to_string()) })
}

fn valid_ymd(s: &str) -> bool {
    let b = s.as_bytes();
    if b.len() != 10 || b[4] != b'-' || b[7] != b'-' {
        return false;
    }
    let num = |r: std::ops::Range<usize>| s[r].parse::<u32>().ok();
    matches!((num(0..4), num(5..7), num(8..10)), (Some(y), Some(m), Some(d)) if (2000..=2200).contains(&y) && (1..=12).contains(&m) && (1..=31).contains(&d))
}

/// 인쇄에 쓰는 것들. 체인에는 안 간다. 화면이 보낸 것을 **여기서 다시 본다.**
pub fn clean_details(d: &Value, kind: &str) -> Result<Map<String, Value>, String> {
    let mut out = Map::new();
    let template = match d.get("template").and_then(Value::as_str) {
        None | Some("") => None,
        Some(t @ ("course" | "proof" | "thanks")) => Some(t.to_string()),
        Some(_) => return Err("양식을 다시 골라 주세요.".into()),
    };
    if kind == "certificate" {
        out.insert("template".into(), json!(template.unwrap_or_else(|| "course".into())));
    }
    let mut recipients: Vec<String> = Vec::new();
    if let Some(list) = d.get("recipients") {
        let arr = list.as_array().ok_or("받는 사람 목록을 확인해 주세요.")?;
        if arr.len() > MAX_RECIPIENTS {
            return Err(format!("받는 사람은 한 번에 {MAX_RECIPIENTS}명까지예요."));
        }
        // 🔴 빈 줄도 **자리를 지킨다**("") — 표의 칸(rows)·사진(<차례>.img)·체인 이름이 차례로
        //    짝지어져 있어, 중간 한 줄을 비웠다고 앞으로 당기면 뒤 사람 이름이 앞 사람 사진·번호와
        //    붙어 인쇄된다(검수 09-24). 끝의 빈 줄만 뗀다.
        for v in arr {
            recipients.push(clean_line(Some(v), 60, "받는 사람 이름")?.unwrap_or_default());
        }
        while recipients.last().is_some_and(String::is_empty) {
            recipients.pop();
        }
    }
    if kind != "ticket" {
        out.insert("recipients".into(), json!(recipients));
    }
    if let Some(day) = d.get("issued_on").and_then(Value::as_str).filter(|s| !s.is_empty()) {
        if !valid_ymd(day) {
            return Err("발급일을 확인해 주세요.".into());
        }
        out.insert("issued_on".into(), json!(day));
    }
    for (key, max, what) in [("issuer", 80, "발급자 이름"), ("signer", 60, "서명 이름"), ("display_title", 80, "제목")] {
        if let Some(s) = clean_line(d.get(key), max, what)? {
            out.insert(key.into(), json!(s));
        }
    }
    if let Some(s) = clean_text(d.get("description"), 400, "설명")? {
        out.insert("description".into(), json!(s));
    }
    if let Some(s) = clean_line(d.get("file_name"), 200, "파일 이름")? {
        out.insert("file_name".into(), json!(s));
    }
    if let Some(lang) = d.get("lang").and_then(Value::as_str) {
        if matches!(lang, "ko" | "en" | "ja" | "zh") {
            out.insert("lang".into(), json!(lang));
        }
    }
    if kind == "certificate" {
        if let Some(on) = d.get("photo_slot").and_then(Value::as_bool) {
            out.insert("photo_slot".into(), json!(on));
        }
        // 표로 올린 줄마다의 칸 — 받는 사람과 같은 차례. 모두 비어 있으면 적지 않는다.
        if let Some(list) = d.get("rows") {
            let arr = list.as_array().ok_or("명단 표를 확인해 주세요.")?;
            if arr.len() > MAX_RECIPIENTS {
                return Err(format!("받는 사람은 한 번에 {MAX_RECIPIENTS}명까지예요."));
            }
            let mut rows = Vec::with_capacity(arr.len());
            let mut any = false;
            for (i, r) in arr.iter().enumerate() {
                let mut row = Map::new();
                for (key, max, what) in [("course", 80, "과정"), ("grade", 30, "등급"), ("number", 40, "번호"), ("note", 120, "비고")] {
                    if let Some(s) = clean_line(r.get(key), max, what)? {
                        row.insert(key.into(), json!(s));
                    }
                }
                if let Some(day) = r.get("date").and_then(Value::as_str).filter(|s| !s.is_empty()) {
                    if !valid_ymd(day) {
                        return Err(format!("{}번째 줄 발급일을 확인해 주세요.", i + 1));
                    }
                    row.insert("date".into(), json!(day));
                }
                any |= !row.is_empty();
                rows.push(Value::Object(row));
            }
            if any {
                out.insert("rows".into(), json!(rows));
            }
        }
    }
    Ok(out)
}

fn new_id() -> String {
    hex::encode(rand::random::<[u8; 16]>())
}

fn valid_id(id: &str) -> bool {
    id.len() == 32 && id.bytes().all(|b| b.is_ascii_hexdigit())
}

fn find<'a>(store: &'a mut Value, id: &str) -> Option<&'a mut Value> {
    store["entries"]
        .as_array_mut()
        .and_then(|a| a.iter_mut().find(|e| e["id"].as_str() == Some(id)))
}

/// 만들기를 시작한다 — 확인 화면에서 「만들기」를 누른 순간. 아직 체인에는
/// 아무것도 안 나갔다. 🔴 지문 목록에는 **적지 않는다** — 발행 길(`create_issue`)이
/// 노드가 받은 뒤에 적는다.
#[tauri::command]
pub fn create_history_begin(entry: Value) -> Result<String, String> {
    let kind = entry.get("kind").and_then(Value::as_str).unwrap_or("");
    if !matches!(kind, "certificate" | "ticket" | "work") {
        return Err("무엇을 만드는지 다시 골라 주세요.".into());
    }
    let title = clean_line(entry.get("title"), 80, "제목")?.ok_or("무엇을 만드는지 제목을 적어 주세요.")?;
    let brand = entry.get("brand").and_then(Value::as_str).unwrap_or("");
    if crate::create::plan_call("brand", brand, &[], 0, None, None).is_err() {
        return Err("브랜드 이름을 확인해 주세요.".into());
    }
    let count = entry.get("count").and_then(Value::as_u64).unwrap_or(0);
    let max = if kind == "ticket" { crate::create::MAX_TICKETS } else { crate::create::MAX_COPIES as u64 };
    if !(1..=max).contains(&count) {
        return Err(format!("1부터 {max}까지 적어 주세요."));
    }
    let fingerprint = match entry.get("fingerprint").and_then(Value::as_str).filter(|s| !s.is_empty()) {
        Some(cid) if is_cid_v0(cid) => Some(cid.to_string()),
        Some(_) => return Err("파일 지문 모양이 올바르지 않습니다.".into()),
        None => None,
    };
    let details = clean_details(entry.get("details").unwrap_or(&Value::Null), kind)?;
    if kind == "certificate" {
        if let Some(r) = details.get("recipients").and_then(Value::as_array) {
            if r.len() as u64 > count {
                return Err("받는 사람이 장수보다 많아요.".into());
            }
        }
    }
    let id = new_id();
    let at = now();
    let mut row = json!({
        "id": id, "status": "started", "at": at, "kind": kind, "title": title,
        "brand": brand, "count": count, "fingerprint": fingerprint, "names": [],
    });
    for (k, v) in details {
        row[k] = v;
    }
    let mut dropped: Vec<String> = Vec::new();
    with_store(|store| {
        // 🔴 보냈는지 모르는 것이 있으면 새로 시작하지 않는다 — 같은 묶음을 두 번 태운다.
        if let Some(u) = unresolved_in(store) {
            return Err(unknown_pending_message(&u));
        }
        let entries = store["entries"].as_array_mut().unwrap();
        // 그만둔 것(끝나지 않고 한 달 넘은 것)은 지운다 — 받는 사람 이름이 남지 않게.
        // 보냈는지 모르는 것은 지우지 않는다(체인에 있을 수 있다).
        let keep = |e: &Value| e["status"] == "done" || is_unresolved(e) || at - e["at"].as_i64().unwrap_or(0) < ABANDONED_AFTER_SECS;
        dropped.extend(entries.iter().filter(|e| !keep(e)).filter_map(|e| e["id"].as_str().map(str::to_string)));
        entries.retain(keep);
        entries.push(row);
        if entries.len() > MAX_ENTRIES {
            let extra = entries.len() - MAX_ENTRIES;
            dropped.extend(entries[..extra].iter().filter_map(|e| e["id"].as_str().map(str::to_string)));
            entries.drain(..extra);
        }
        Ok(())
    })?;
    // 기록에서 빠진 줄의 사진·인쇄 파일도 같이(검수 09-24 — 사진만 영영 남을 뻔했다).
    for gone in &dropped {
        remove_prints(gone);
        crate::cert_assets::forget_photos(gone);
    }
    Ok(id)
}

/* ── 보냈는지 모름 ─────────────────────────────────────────────────── */

/// 보냈는지 모르는 줄 — 시간 초과로 끝난 것(`sent-unknown`)과 보내다 만 것(`sending`).
fn is_unresolved(e: &Value) -> bool {
    e["status"] == "sent-unknown" || e["status"] == "sending"
}

fn unresolved_in(store: &Value) -> Option<Value> {
    store["entries"].as_array()?.iter().find(|e| is_unresolved(e)).cloned()
}

fn unknown_pending_message(e: &Value) -> String {
    format!(
        "SENT_UNKNOWN_PENDING: 보냈는지 아직 모르는 만들기가 있어요({}). 기록될 때까지 기다린 뒤 「다시 확인」을 눌러 주세요 — 새로 만들면 같은 것을 두 번 태울 수 있어요.",
        e["title"].as_str().unwrap_or("")
    )
}

/// 지금 보내는 중이 아닌데 `sending` 으로 남은 줄 — 보내다가 앱이 꺼졌다. 노드는
/// 보냈을 수 있으니 「보냈는지 모름」으로 바꾼다. 🔴 보내는 중이면 건드리지 않는다
/// (`create_issue` 는 이 자물쇠 안에서만 `sending` 을 적는다).
fn settle_interrupted(store: &mut Value) -> bool {
    if crate::create::issuing_now() {
        return false;
    }
    let mut changed = false;
    for e in store["entries"].as_array_mut().unwrap() {
        if e["status"] == "sending" {
            e["status"] = json!("sent-unknown");
            e["interrupted"] = json!(true);
            changed = true;
        }
    }
    changed
}

/// 화면이 「만들기」를 열 때 — 보냈는지 모르는 기록(보내다 만 것 포함)이 있으면 그 줄.
/// 화면의 이어하기 표가 없어도(보내는 도중 앱이 꺼졌다) 이것으로 그 자리로 간다.
#[tauri::command]
pub fn create_unresolved() -> Result<Option<Value>, String> {
    let _guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut store = load()?;
    if settle_interrupted(&mut store) {
        save(&store)?;
    }
    Ok(unresolved_in(&store))
}

/// 보냈는지 모르는 기록 하나(있으면). 발행 길이 새로 보내기 전에 본다.
pub fn unresolved() -> Result<Option<Value>, String> {
    let _guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    Ok(unresolved_in(&load()?))
}

pub fn unknown_pending_error() -> Result<(), String> {
    match unresolved()? {
        Some(u) => Err(unknown_pending_message(&u)),
        None => Ok(()),
    }
}

/// 발행 부름이 시간 초과로 끝났다 — 노드가 보냈을 수 있다. 무엇을 보냈는지 적어 둔다.
pub fn mark_unknown(id: &str, step: &str, names: &[String]) -> Result<(), String> {
    if !valid_id(id) {
        return Err("기록 번호가 올바르지 않아요.".into());
    }
    with_store(|store| {
        let e = find(store, id).ok_or("그 기록을 찾지 못했어요.")?;
        e["status"] = json!("sent-unknown");
        e["unknown"] = json!({ "step": step, "names": names, "at": now() });
        Ok(())
    })
}

/// 🔴 발행을 부르기 **직전** — 무엇을 보내는지 먼저 적는다. 못 적으면 보내지 않는다
/// (보내는 도중 앱이 꺼지면 이 줄만이 「보냈을 수 있다」를 기억한다).
pub fn mark_sending(id: &str, step: &str, names: &[String]) -> Result<(), String> {
    if !valid_id(id) {
        return Err("기록 번호가 올바르지 않아요.".into());
    }
    with_store(|store| {
        let e = find(store, id).ok_or("그 기록을 찾지 못했어요.")?;
        let prev = e["status"].as_str().unwrap_or("started").to_string();
        if prev == "sending" || prev == "sent-unknown" || prev == "done" {
            return Err("이 기록은 이미 보냈거나 보냈는지 모르는 상태예요. 다시 보내지 않아요.".into());
        }
        e["prev_status"] = json!(prev);
        e["status"] = json!("sending");
        e["unknown"] = json!({ "step": step, "names": names, "at": now() });
        Ok(())
    })
}

/// 노드가 **분명히** 거절했다(아무것도 안 나갔다) — 보내기 전 상태로 되돌린다.
pub fn mark_not_sent(id: &str) -> Result<(), String> {
    if !valid_id(id) {
        return Err("기록 번호가 올바르지 않아요.".into());
    }
    with_store(|store| {
        let e = find(store, id).ok_or("그 기록을 찾지 못했어요.")?;
        restore_before_send(e);
        Ok(())
    })
}

fn restore_before_send(e: &mut Value) {
    let prev = e["prev_status"].as_str().filter(|p| matches!(*p, "started" | "brand-sent")).unwrap_or("started").to_string();
    e["status"] = json!(prev);
    if let Some(m) = e.as_object_mut() {
        m.remove("unknown");
        m.remove("prev_status");
        m.remove("interrupted");
    }
}

/// 「다시 확인」 — 보냈는지 모르는 것이 체인·지갑에 있나 본다.
///
/// - 있으면: 이름 등록이면 `brand-sent`, 만들기면 `done` 으로 푼다(거래 번호는 모름).
/// - 없고 한 시간이 안 됐으면: 그대로 `unknown`.
/// - 없고 한 시간이 넘었으면: `not-sent` — 그때만 화면이 「처음부터 다시」를 연다.
#[tauri::command]
pub async fn create_resolve(id: String) -> Result<Value, String> {
    if !valid_id(&id) {
        return Err("기록 번호가 올바르지 않아요.".into());
    }
    let mut entry = create_history_get(id.clone())?;
    if entry["status"] == "sending" {
        // 지금 보내는 중이면 기다린다. 아니면 보내다가 앱이 꺼진 것 — 보냈는지 모름.
        if crate::create::issuing_now() {
            return Ok(json!({ "state": "sending", "entry": entry }));
        }
        let _ = create_unresolved()?;
        entry = create_history_get(id.clone())?;
    }
    if entry["status"] != "sent-unknown" {
        return Ok(json!({ "state": entry["status"], "entry": entry }));
    }
    let step = entry["unknown"]["step"].as_str().unwrap_or("").to_string();
    let names: Vec<String> = entry["unknown"]["names"]
        .as_array()
        .map(|a| a.iter().filter_map(|v| v.as_str().map(str::to_string)).collect())
        .unwrap_or_default();
    let probe = if step == "brand" {
        format!("{}!", entry["brand"].as_str().unwrap_or(""))
    } else {
        names.first().cloned().unwrap_or_default()
    };
    if probe.len() < 2 {
        return Err("그 기록을 찾지 못했어요.".into());
    }
    if crate::create::name_used(&probe).await? {
        if step == "brand" {
            mark_brand_sent(&id, "")?;
        } else {
            mark_done(&id, &names, "")?;
        }
        let entry = create_history_get(id)?;
        return Ok(json!({ "state": entry["status"], "entry": entry }));
    }
    let waited = now() - entry["unknown"]["at"].as_i64().unwrap_or(0);
    if waited >= UNKNOWN_GIVE_UP_SECS {
        return Ok(json!({ "state": "not-sent", "waited": waited }));
    }
    Ok(json!({ "state": "unknown", "waited": waited }))
}

/// 한 시간 넘게 체인·지갑 어디에도 안 보인 「보냈는지 모름」을 내려놓는다.
/// 🔴 러스트가 다시 확인한다 — 화면 말만 믿고 풀지 않는다.
#[tauri::command]
pub async fn create_resolve_not_sent(id: String) -> Result<(), String> {
    let r = create_resolve(id.clone()).await?;
    if r["state"] != "not-sent" {
        return Err("아직 보냈는지 몰라요. 기록될 때까지 기다린 뒤 다시 확인해 주세요.".into());
    }
    with_store(|store| {
        let e = find(store, &id).ok_or("그 기록을 찾지 못했어요.")?;
        restore_before_send(e);
        e["not_sent_at"] = json!(now());
        Ok(())
    })
}

/// 이름 등록이 나갔다(기록 전). 창을 닫아도 이어서 할 수 있게 적는다.
pub fn mark_brand_sent(id: &str, txid: &str) -> Result<(), String> {
    if !valid_id(id) {
        return Err("기록 번호가 올바르지 않아요.".into());
    }
    with_store(|store| {
        let e = find(store, id).ok_or("그 기록을 찾지 못했어요.")?;
        e["status"] = json!("brand-sent");
        e["brand_txid"] = json!(txid);
        if let Some(m) = e.as_object_mut() {
            m.remove("prev_status");
            m.remove("interrupted");
        }
        Ok(())
    })
}

/// 만들기가 끝났다. 체인 이름과 거래 번호를 적는다.
pub fn mark_done(id: &str, names: &[String], txid: &str) -> Result<(), String> {
    if !valid_id(id) {
        return Err("기록 번호가 올바르지 않아요.".into());
    }
    with_store(|store| {
        let e = find(store, id).ok_or("그 기록을 찾지 못했어요.")?;
        e["status"] = json!("done");
        e["names"] = json!(names);
        e["txid"] = json!(txid);
        e["done_at"] = json!(now());
        if let Some(m) = e.as_object_mut() {
            m.remove("prev_status");
            m.remove("interrupted");
        }
        Ok(())
    })
}

/// 인쇄할 것만 고친다(받는 사람 이름 오타·양식·발급자). 체인 이름·지문·장수는
/// 못 바꾼다 — 체인에 이미 있는 것이다.
#[tauri::command]
pub fn create_history_details(id: String, details: Value) -> Result<Value, String> {
    if !valid_id(&id) {
        return Err("기록 번호가 올바르지 않아요.".into());
    }
    with_store(|store| {
        let e = find(store, &id).ok_or("그 기록을 찾지 못했어요.")?;
        let kind = e["kind"].as_str().unwrap_or("").to_string();
        let clean = clean_details(&details, &kind)?;
        let copies = e["names"].as_array().map(Vec::len).filter(|n| *n > 0).unwrap_or(e["count"].as_u64().unwrap_or(0) as usize);
        if clean.get("recipients").and_then(Value::as_array).map(Vec::len).unwrap_or(0) > copies.max(1) {
            return Err("받는 사람이 장수보다 많아요.".into());
        }
        for key in ["template", "recipients", "issued_on", "issuer", "signer", "display_title", "description"] {
            match clean.get(key) {
                Some(v) => e[key] = v.clone(),
                None => {
                    if let Some(m) = e.as_object_mut() {
                        m.remove(key);
                    }
                }
            }
        }
        if let Some(l) = clean.get("lang") {
            e["lang"] = l.clone();
        }
        // 표 칸·사진 칸은 **보낸 때만** 바꾼다 — 한 장짜리 고치기 화면은 이것을 모른다.
        for key in ["rows", "photo_slot"] {
            if details.get(key).is_some() {
                match clean.get(key) {
                    Some(v) => e[key] = v.clone(),
                    None => {
                        if let Some(m) = e.as_object_mut() {
                            m.remove(key);
                        }
                    }
                }
            }
        }
        Ok(e.clone())
    })
}

/// 끝난 것만, 새것이 위로.
#[tauri::command]
pub fn create_history_list() -> Result<Vec<Value>, String> {
    let _guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let store = load()?;
    let mut out: Vec<Value> = store["entries"]
        .as_array()
        .map(|a| a.iter().filter(|e| e["status"] == "done").cloned().collect())
        .unwrap_or_default();
    out.sort_by_key(|e| std::cmp::Reverse(e["done_at"].as_i64().unwrap_or(0)));
    Ok(out)
}

#[tauri::command]
pub fn create_history_get(id: String) -> Result<Value, String> {
    if !valid_id(&id) {
        return Err("기록 번호가 올바르지 않아요.".into());
    }
    let _guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut store = load()?;
    find(&mut store, &id).cloned().ok_or_else(|| "그 기록을 찾지 못했어요.".into())
}

/// 기록 한 줄을 지운다(인쇄 파일도). 🔴 **지문 목록은 그대로 둔다** — 체인에는
/// 여전히 그 지문이 있고, 지우면 다시 「파일」로 보고 보존을 시도한다.
#[tauri::command]
pub fn create_history_forget(id: String) -> Result<(), String> {
    if !valid_id(&id) {
        return Err("기록 번호가 올바르지 않아요.".into());
    }
    with_store(|store| {
        // 🔴 보냈는지 모르는 줄은 못 지운다 — 지우면 같은 것을 다시 만들 수 있게 된다.
        if store["entries"].as_array().unwrap().iter().any(|e| e["id"].as_str() == Some(id.as_str()) && is_unresolved(e)) {
            return Err("보냈는지 아직 모르는 기록이라 지우지 않았어요. 기록될 때까지 기다린 뒤 「다시 확인」을 눌러 주세요.".into());
        }
        store["entries"].as_array_mut().unwrap().retain(|e| e["id"].as_str() != Some(id.as_str()));
        Ok(())
    })?;
    remove_prints(&id);
    crate::cert_assets::forget_photos(&id);
    Ok(())
}

/* ── 망가진 기록 · 보관 기간 · 인쇄 파일 정리 ───────────────────────── */

/// 망가진 기록을 **지우지 않고 옆에 두고** 새로 시작한다(「기록을 새로 시작」).
///
/// 원본 지문은 망가진 파일에서 건질 수 있는 만큼 건진다 — 이 기록에서 `Qm…` 은
/// 지문뿐이라(체인 이름은 `Qm` 으로 시작하지 않는다) 글자 그대로 찾아도 안전하다.
/// 못 건진 지문의 자산은 한동안 「파일」로 보일 뿐 해는 없다.
#[tauri::command]
pub fn create_history_restart() -> Result<Value, String> {
    let _guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    match load() {
        Ok(_) => return Err("만든 기록은 멀쩡해요 — 새로 시작할 필요가 없어요.".into()),
        Err(e) if e != CORRUPT => return Err(e),
        Err(_) => {}
    }
    let bytes = std::fs::read(path()).map_err(|_| "만든 기록을 읽지 못했어요. 앱 자료 폴더 권한을 확인해 주세요.".to_string())?;
    let kept = path().with_file_name(format!("create_history.corrupt-{}.json", now()));
    std::fs::rename(path(), &kept).map_err(|_| "망가진 기록을 옆으로 옮기지 못했어요. 앱 자료 폴더 권한을 확인해 주세요.".to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&kept, std::fs::Permissions::from_mode(0o600));
    }
    let salvaged = salvage_fingerprints(&bytes);
    let mut store = empty();
    store["fingerprints"] = json!(salvaged);
    save(&store)?;
    Ok(json!({
        "kept": kept.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default(),
        "fingerprints": salvaged.len(),
    }))
}

fn salvage_fingerprints(bytes: &[u8]) -> Vec<String> {
    let text = String::from_utf8_lossy(bytes);
    let mut out: Vec<String> = Vec::new();
    let mut rest = text.as_ref();
    while let Some(i) = rest.find("Qm") {
        let cand = rest.get(i..i + 46).unwrap_or("");
        if is_cid_v0(cand) && !out.iter().any(|c| c == cand) {
            out.push(cand.to_string());
        }
        rest = &rest[i + 2..];
    }
    out.truncate(MAX_FINGERPRINTS);
    out
}

/// 받는 사람 이름 등을 얼마나 두나. 가게가 회원 정보 보관 기간을 정했으면 그것,
/// 정한 적이 없으면(또는 설정을 못 읽으면) 12개월.
fn keep_personal_secs() -> i64 {
    let months = if crate::paths::app_file("member_privacy.json").exists() {
        crate::member_privacy::member_privacy_get().map(|p| p.retention_months).unwrap_or(DEFAULT_KEEP_MONTHS)
    } else {
        DEFAULT_KEEP_MONTHS
    };
    months as i64 * 31 * 24 * 3600
}

/// 보관 기간이 지난 기록의 사람 이름·발급자·설명을 지운다. 체인 이름·지문·거래
/// 번호는 남는다 — 그 뒤에 다시 인쇄하면 이름 칸이 빈 줄로 나온다.
pub fn purge_expired(now_unix: i64) -> Result<usize, String> {
    let keep = keep_personal_secs();
    let mut cleared = Vec::new();
    with_store(|store| {
        for e in store["entries"].as_array_mut().unwrap() {
            if e["status"] != "done" || e.get("personal_cleared_at").is_some() {
                continue;
            }
            let base = e["done_at"].as_i64().or_else(|| e["at"].as_i64()).unwrap_or(0);
            if base <= 0 || base + keep > now_unix {
                continue;
            }
            if let Some(m) = e.as_object_mut() {
                for key in PERSONAL_KEYS {
                    m.remove(key);
                }
                m.insert("personal_cleared_at".into(), json!(now_unix));
            }
            if let Some(id) = e["id"].as_str() {
                cleared.push(id.to_string());
            }
        }
        Ok(())
    })?;
    for id in &cleared {
        remove_prints(id);
        crate::cert_assets::forget_photos(id);
    }
    Ok(cleared.len())
}

/// 쓰다 만 파일(`*.pending-…`)은 이만큼 지난 것만 지운다 — 방금 쓰는 중인 파일을
/// 이름 바꾸기 직전에 지우면 그 저장이 실패한다.
const PENDING_KEEP_SECS: u64 = 10 * 60;

fn is_hex(s: &str, len: usize) -> bool {
    s.len() == len && s.bytes().all(|b| b.is_ascii_hexdigit())
}

/// 인쇄 폴더에서 **우리가 쓴 이름**만 알아본다.
/// `certificate-<32hex>.html` → `Some((id, false))`, `certificate-<32hex>.pending-<16hex>` → `Some((id, true))`.
/// 한 사람 한 장(`-<차례>.html`)과 묶음 파일(`-all.html`·`-list.xlsx`·`-list.csv`)도 그 id 로.
fn printout_name(name: &str) -> Option<(&str, bool)> {
    let rest = name.strip_prefix("certificate-")?;
    let (id, tail) = rest.split_at(rest.len().min(32));
    if !is_hex(id, 32) {
        return None;
    }
    // 쓰다 만 파일 — `write_private` 가 확장자 자리에 `.pending-<16hex>` 를 붙인 것.
    if let Some((stem, pend)) = tail.rsplit_once(".pending-") {
        return (is_hex(pend, 16) && (stem.is_empty() || matches!(stem, "-all" | "-list") || one_stem(stem))).then_some((id, true));
    }
    (tail == ".html" || shared_tail(tail) || one_tail(tail)).then_some((id, false))
}

/// 여러 기록의 이름이 같이 든 파일 — 전체 묶음 인쇄 · 번호 목록 표(쓰다 만 것 포함).
fn shared_tail(tail: &str) -> bool {
    matches!(tail, "-all.html" | "-list.xlsx" | "-list.csv")
        || tail.rsplit_once(".pending-").is_some_and(|(stem, pend)| matches!(stem, "-all" | "-list") && is_hex(pend, 16))
}

/// 한 사람 한 장의 차례 — `-1` … `-500`.
fn one_stem(stem: &str) -> bool {
    stem.strip_prefix('-')
        .map(|n| !n.is_empty() && n.len() <= 3 && n.bytes().all(|b| b.is_ascii_digit()) && !n.starts_with('0'))
        .unwrap_or(false)
}

/// 한 사람 한 장 — `-1.html` … `-500.html`.
fn one_tail(tail: &str) -> bool {
    tail.strip_suffix(".html").is_some_and(one_stem)
}

/// 그 기록의 인쇄 파일을 모두 지운다 — 한 사람 한 장까지. 묶음 파일은 다른 기록의
/// 이름도 들어 있어 **누구 것이든** 통째로 지운다(다시 누르면 다시 만든다).
/// 바로가기인 폴더·파일은 따라가지 않는다(`tidy` 와 같은 원칙).
pub fn remove_prints(id: &str) {
    let printouts = crate::paths::app_dir().join("printouts");
    match std::fs::symlink_metadata(&printouts) {
        Ok(m) if m.file_type().is_dir() => {}
        _ => return,
    }
    let Ok(dir) = std::fs::read_dir(&printouts) else { return };
    for f in dir.flatten() {
        let name = f.file_name().to_string_lossy().to_string();
        let Some((owner, _)) = printout_name(&name) else { continue };
        let shared = shared_tail(&name["certificate-".len() + 32..]);
        if (owner == id || shared) && f.metadata().map(|m| m.file_type().is_file()).unwrap_or(false) {
            let _ = std::fs::remove_file(f.path());
        }
    }
}

fn older_than(meta: &std::fs::Metadata, secs: u64) -> bool {
    meta.modified().ok().and_then(|t| t.elapsed().ok()).map(|age| age.as_secs() >= secs).unwrap_or(false)
}

/// 기록에 없는 사진 폴더(`create-photos/<id>`) — 기록이 망가져 새로 시작했거나 오래돼 빠진 것.
/// 🔴 사람 얼굴이다. 기록을 못 읽으면(망가짐) 아무것도 지우지 않는다. 방금 만든 폴더는
///    기록보다 늦게 생길 수 있어 10분 지난 것만. 바로가기는 따라가지 않는다.
fn sweep_orphan_photos(app: &std::path::Path) {
    let root = app.join("create-photos");
    if !std::fs::symlink_metadata(&root).map(|m| m.file_type().is_dir()).unwrap_or(false) {
        return;
    }
    let ids: HashSet<String> = {
        let _guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let Ok(store) = load() else { return };
        store["entries"].as_array().map(|a| a.iter().filter_map(|e| e["id"].as_str().map(str::to_string)).collect()).unwrap_or_default()
    };
    let Ok(dir) = std::fs::read_dir(&root) else { return };
    for d in dir.flatten() {
        let name = d.file_name().to_string_lossy().to_string();
        let Ok(meta) = d.metadata() else { continue };
        if is_hex(&name, 32) && meta.file_type().is_dir() && !ids.contains(&name) && older_than(&meta, PENDING_KEEP_SECS) {
            let _ = std::fs::remove_dir_all(d.path());
        }
    }
}

/// 켤 때(그리고 하루에 한 번) — 보관 기간 지난 이름 지우기, 7일 지난 인쇄 파일과
/// 기록에 없는 인쇄 파일, 쓰다 만 `*.pending-*` 파일 지우기.
///
/// 🔴 남의 파일을 지우지 않는다(검수: `printouts` 가 다른 폴더를 가리키는 바로가기면
///    그 폴더의 일주일 지난 `tax-return.pdf` 까지 지웠다).
///    - 바로가기(심볼릭 링크)인 폴더·파일은 따라가지 않는다.
///    - 우리가 쓰는 이름(`certificate-<32hex>.html` 과 그 `.pending-<16hex>`)만 지운다.
///    - 쓰다 만 파일은 10분 넘은 것만 — 또는 기록 자물쇠를 쥔 채로(만든 기록).
pub fn tidy(now_unix: i64) {
    let _ = purge_expired(now_unix);
    // 보내다 만 줄(앱이 꺼졌다) → 보냈는지 모름. 보내는 중이면 건드리지 않는다.
    {
        let _guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());
        if let Ok(mut store) = load() {
            if settle_interrupted(&mut store) {
                let _ = save(&store);
            }
        }
    }
    let app = crate::paths::app_dir();
    sweep_orphan_photos(&app);
    {
        // 만든 기록의 쓰다 만 파일 — 자물쇠를 쥐면 지금 쓰는 사람이 없다.
        let _guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());
        if let Ok(dir) = std::fs::read_dir(&app) {
            for f in dir.flatten() {
                let name = f.file_name().to_string_lossy().to_string();
                let ours = name.strip_prefix("create_history.pending-").map(|h| is_hex(h, 16)).unwrap_or(false);
                if ours && f.file_type().map(|t| t.is_file()).unwrap_or(false) {
                    let _ = std::fs::remove_file(f.path());
                }
            }
        }
    }
    let printouts = app.join("printouts");
    match std::fs::symlink_metadata(&printouts) {
        Ok(m) if m.file_type().is_dir() => {}
        _ => return, // 없거나, 바로가기거나, 폴더가 아니다 — 손대지 않는다.
    }
    // 기록을 못 읽으면(망가짐) 「기록에 없는 인쇄 파일」은 가리지 않는다 — 날짜로만 지운다.
    let ids: Option<HashSet<String>> = {
        let _guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());
        load().ok().map(|v| {
            v["entries"]
                .as_array()
                .map(|a| a.iter().filter_map(|e| e["id"].as_str().map(str::to_string)).collect())
                .unwrap_or_default()
        })
    };
    let Ok(dir) = std::fs::read_dir(&printouts) else { return };
    for f in dir.flatten() {
        let name = f.file_name().to_string_lossy().to_string();
        let Some((id, pending)) = printout_name(&name) else { continue };
        // DirEntry::metadata 는 바로가기를 따라가지 않는다 — 진짜 파일만.
        let Ok(meta) = f.metadata() else { continue };
        if !meta.file_type().is_file() {
            continue;
        }
        let gone = if pending {
            older_than(&meta, PENDING_KEEP_SECS)
        } else {
            let orphan = ids.as_ref().map(|ids| !ids.contains(id)).unwrap_or(false);
            // 방금 쓴 인쇄 파일은 기록보다 먼저 생길 수 없지만, 그래도 10분은 둔다.
            older_than(&meta, PRINT_KEEP_SECS) || (orphan && older_than(&meta, PENDING_KEEP_SECS))
        };
        if gone {
            let _ = std::fs::remove_file(f.path());
        }
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    const CID: &str = "QmcwUFCZ8saJgoE6D9LEgVqtteCbVcdzWFcGzuhe7VTeW7";

    /// 시험마다 빈 앱 폴더. `PLAYX_RAVEN_HOME` 은 프로세스 전역이라 자물쇠를 잡는다.
    pub(crate) fn sandbox<T>(f: impl FnOnce(&std::path::Path) -> T) -> T {
        let _env = crate::paths::TEST_ENV.lock().unwrap_or_else(|e| e.into_inner());
        let dir = std::env::temp_dir().join(format!("rv-create-history-{}-{:x}", std::process::id(), rand::random::<u64>()));
        std::fs::create_dir_all(&dir).unwrap();
        let old = std::env::var("PLAYX_RAVEN_HOME").ok();
        std::env::set_var("PLAYX_RAVEN_HOME", &dir);
        let out = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| f(&dir)));
        match old {
            Some(v) => std::env::set_var("PLAYX_RAVEN_HOME", v),
            None => std::env::remove_var("PLAYX_RAVEN_HOME"),
        }
        let _ = std::fs::remove_dir_all(&dir);
        match out {
            Ok(v) => v,
            Err(p) => std::panic::resume_unwind(p),
        }
    }

    pub(crate) fn begin_certificate(recipients: &[&str]) -> String {
        create_history_begin(json!({
            "kind": "certificate", "title": "필라테스 지도자 과정", "brand": "HANBIT", "count": recipients.len().max(1),
            "fingerprint": CID,
            "details": { "template": "course", "recipients": recipients, "issued_on": "2026-09-23",
                         "issuer": "한빛 필라테스", "signer": "홍길동", "lang": "ko", "file_name": "수료 명단.pdf" }
        }))
        .unwrap()
    }

    #[test]
    fn 기록은_앱폴더에_본인만_읽게_남고_끝난것만_보인다() {
        sandbox(|dir| {
            let id = begin_certificate(&["김하늘", "이바다"]);
            // 시작만 한 것은 목록에 없다.
            assert!(create_history_list().unwrap().is_empty());
            mark_brand_sent(&id, &"ab".repeat(32)).unwrap();
            let names = vec!["HANBIT#PILATESEU260923-1".to_string(), "HANBIT#PILATESEU260923-2".to_string()];
            mark_done(&id, &names, &"cd".repeat(32)).unwrap();
            let list = create_history_list().unwrap();
            assert_eq!(list.len(), 1);
            assert_eq!(list[0]["recipients"], json!(["김하늘", "이바다"]));
            assert_eq!(list[0]["names"], json!(names));
            assert_eq!(list[0]["template"], "course");
            assert_eq!(list[0]["fingerprint"], CID);
            let file = dir.join(FILE);
            assert!(file.is_file());
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                assert_eq!(std::fs::metadata(&file).unwrap().permissions().mode() & 0o777, 0o600);
            }
            // 쓰다 만 임시 파일이 남지 않는다.
            assert!(std::fs::read_dir(dir).unwrap().all(|e| !e.unwrap().file_name().to_string_lossy().contains("pending")));
        });
    }

    #[test]
    fn 지문은_발행_길에서만_적히고_기록을_지워도_남는다() {
        sandbox(|_| {
            assert!(fingerprint_set().is_empty());
            let id = begin_certificate(&["김하늘"]);
            // 🔴 시작만으로는 적지 않는다 — 화면이 보낸 아무 Qm… 나 지문이 되면 안 된다.
            assert!(fingerprint_set().is_empty(), "기록 시작이 지문 목록을 건드리면 안 된다");
            remember_fingerprint(CID).unwrap(); // create_issue 가 노드가 받은 뒤에 부르는 자리
            assert!(fingerprint_set().contains(CID));
            assert_eq!(create_fingerprints(), vec![CID.to_string()]);
            create_history_forget(id).unwrap();
            assert!(fingerprint_set().contains(CID), "기록을 지웠다고 지문을 잊으면 다시 보존을 시도한다");
            remember_fingerprint(CID).unwrap();
            assert_eq!(create_fingerprints().len(), 1, "같은 지문을 두 번 적지 않는다");
            assert!(remember_fingerprint("QmBad").is_err());
        });
    }

    #[test]
    fn 망가진_기록은_덮어쓰지_않는다() {
        sandbox(|dir| {
            std::fs::write(dir.join(FILE), b"{broken").unwrap();
            assert!(create_history_list().is_err());
            assert!(remember_fingerprint(CID).is_err(), "망가진 파일 위에 새로 쓰면 지난 기록이 사라진다");
            assert_eq!(std::fs::read(dir.join(FILE)).unwrap(), b"{broken");
            // 읽기 쪽은 빈 목록으로 넘어간다 — 보존이 예전처럼 돈다.
            assert!(fingerprint_set().is_empty());
        });
    }

    #[test]
    fn 인쇄할_것은_다시_보고_고칠_수_있다() {
        sandbox(|_| {
            // 제어 문자·너무 긴 이름·틀린 양식·틀린 날짜는 받지 않는다.
            let bad = |details: Value| {
                create_history_begin(json!({"kind":"certificate","title":"수료","brand":"HANBIT","count":2,"details":details})).is_err()
            };
            assert!(bad(json!({"recipients": ["김\u{0007}하늘"]})));
            assert!(bad(json!({"recipients": ["가".repeat(61)]})));
            assert!(bad(json!({"template": "fancy"})));
            assert!(bad(json!({"issued_on": "2026-13-01"})));
            assert!(bad(json!({"recipients": ["가", "나", "다"]})), "받는 사람이 장수보다 많다");
            assert!(create_history_begin(json!({"kind":"certificate","title":"수료","brand":"RVN","count":1})).is_err());
            assert!(create_history_begin(json!({"kind":"work","title":"그림","brand":"HANBIT","count":51})).is_err());

            let id = begin_certificate(&["김하늘"]);
            mark_done(&id, &["HANBIT#PILATESEU260923-1".to_string()], &"cd".repeat(32)).unwrap();
            let fixed = create_history_details(id.clone(), json!({"template":"thanks","recipients":["김하늘님"],"issuer":"PLAY X","lang":"en"})).unwrap();
            assert_eq!(fixed["recipients"], json!(["김하늘님"]));
            assert_eq!(fixed["template"], "thanks");
            assert_eq!(fixed["lang"], "en");
            assert!(fixed.get("signer").is_none(), "비운 칸은 지운다");
            assert_eq!(fixed["names"], json!(["HANBIT#PILATESEU260923-1"]), "체인 이름은 못 바꾼다");
            assert!(create_history_details(id.clone(), json!({"recipients":["가","나"]})).is_err());
            assert!(create_history_details("../../etc".into(), json!({})).is_err());
            assert!(create_history_get(id).is_ok());
        });
    }

    /// 검수 S5 — 시간 초과로 보냈는지 모르는 것이 있으면 새 만들기를 시작하지 않는다.
    #[test]
    fn 보냈는지_모르는_것이_있으면_새로_시작하지_않는다() {
        sandbox(|_| {
            let id = begin_certificate(&["김하늘", "이바다"]);
            let names = vec!["HANBIT#PILATESEU260923-1".to_string(), "HANBIT#PILATESEU260923-2".to_string()];
            mark_unknown(&id, "uniques", &names).unwrap();
            let e = create_history_get(id.clone()).unwrap();
            assert_eq!(e["status"], "sent-unknown");
            assert_eq!(e["unknown"]["names"], json!(names));
            let again = create_history_begin(json!({"kind":"certificate","title":"필라테스 지도자 과정","brand":"HANBIT","count":2}));
            assert!(again.unwrap_err().starts_with("SENT_UNKNOWN_PENDING: "), "같은 묶음을 두 번 태우는 길을 막는다");
            assert!(unknown_pending_error().is_err());
            assert!(unresolved().unwrap().is_some());
            // 끝난 것처럼 목록에 나오지도, 한 달이 지났다고 지워지지도 않는다.
            assert!(create_history_list().unwrap().is_empty());
            mark_done(&id, &names, "").unwrap();
            assert!(unknown_pending_error().is_ok(), "체인에서 찾아 풀면 다시 만들 수 있다");
            assert_eq!(create_history_list().unwrap().len(), 1);
        });
    }

    #[test]
    fn 보관_기간이_지나면_받는_사람_이름을_지우고_체인_이름은_남긴다() {
        sandbox(|dir| {
            let id = begin_certificate(&["김하늘"]);
            let names = vec!["HANBIT#SURYO260923-1".to_string()];
            mark_done(&id, &names, &"cd".repeat(32)).unwrap();
            let done_at = create_history_get(id.clone()).unwrap()["done_at"].as_i64().unwrap();
            std::fs::create_dir_all(dir.join("printouts")).unwrap();
            std::fs::write(crate::certificate::print_path(&id), b"x").unwrap();
            // 설정이 없으면 12개월 — 11개월째에는 그대로.
            assert_eq!(purge_expired(done_at + 11 * 31 * 24 * 3600).unwrap(), 0);
            assert_eq!(purge_expired(done_at + 12 * 31 * 24 * 3600 + 1).unwrap(), 1);
            let e = create_history_get(id.clone()).unwrap();
            for key in PERSONAL_KEYS {
                assert!(e.get(key).is_none(), "{key} 는 지워져야 한다");
            }
            assert_eq!(e["names"], json!(names));
            assert_eq!(e["fingerprint"], CID);
            assert_eq!(e["txid"], json!("cd".repeat(32)));
            assert!(!crate::certificate::print_path(&id).exists(), "이름이 든 인쇄 파일도 지운다");
            // 가게가 3개월로 정했으면 그것을 따른다.
            crate::member_privacy::member_privacy_set("name_last4".into(), 3).unwrap();
            let id2 = begin_certificate(&["이바다"]);
            mark_done(&id2, &["HANBIT#SURYO260923-2".to_string()], "").unwrap();
            let at2 = create_history_get(id2.clone()).unwrap()["done_at"].as_i64().unwrap();
            assert_eq!(purge_expired(at2 + 4 * 31 * 24 * 3600).unwrap(), 1);
        });
    }

    #[test]
    fn 정리는_기록에_없는_인쇄_파일과_쓰다_만_파일을_지운다() {
        sandbox(|dir| {
            let aged = |p: &std::path::Path, secs: u64| {
                let t = std::time::SystemTime::now() - std::time::Duration::from_secs(secs);
                std::fs::File::options().write(true).open(p).unwrap().set_modified(t).unwrap();
            };
            let id = begin_certificate(&["김하늘"]);
            mark_done(&id, &["HANBIT#SURYO260923-1".to_string()], "").unwrap();
            let prints = dir.join("printouts");
            std::fs::create_dir_all(&prints).unwrap();
            let mine = crate::certificate::print_path(&id);
            std::fs::write(&mine, b"keep").unwrap();
            let orphan = prints.join(format!("certificate-{}.html", "0".repeat(32)));
            std::fs::write(&orphan, b"orphan").unwrap();
            aged(&orphan, 20 * 60);
            let fresh_orphan = prints.join(format!("certificate-{}.html", "1".repeat(32)));
            std::fs::write(&fresh_orphan, b"just written").unwrap();
            let half = prints.join(format!("certificate-{}.pending-0123456789abcdef", "0".repeat(32)));
            std::fs::write(&half, b"half").unwrap();
            aged(&half, 20 * 60);
            let writing = prints.join(format!("certificate-{}.pending-fedcba9876543210", "2".repeat(32)));
            std::fs::write(&writing, b"being written").unwrap();
            let theirs = prints.join("tax-return.pdf");
            std::fs::write(&theirs, b"not ours").unwrap();
            aged(&theirs, 30 * 24 * 3600);
            let odd = prints.join("certificate-x.pending-0123456789abcdef");
            std::fs::write(&odd, b"not our pattern").unwrap();
            aged(&odd, 30 * 24 * 3600);
            let half_store = dir.join("create_history.pending-0123456789abcdef");
            std::fs::write(&half_store, b"half").unwrap();
            tidy(now());
            assert!(mine.exists(), "기록에 있고 7일이 안 된 인쇄 파일은 둔다");
            assert!(!orphan.exists());
            assert!(fresh_orphan.exists(), "방금 쓴 것은 10분 둔다");
            assert!(!half.exists());
            assert!(writing.exists(), "쓰는 중일 수 있는 파일은 10분 둔다");
            assert!(theirs.exists(), "우리 이름이 아닌 파일은 절대 안 지운다");
            assert!(odd.exists(), "이름 모양이 다르면 안 지운다");
            assert!(!half_store.exists(), "만든 기록의 쓰다 만 파일은 자물쇠를 쥐고 지운다");
            aged(&mine, 8 * 24 * 3600);
            tidy(now());
            assert!(!mine.exists(), "7일 지난 인쇄 파일은 지운다");
        });
    }

    /// 검수 09-24 — 중간 빈 줄을 당기면 뒤 사람 이름이 앞 사람 사진·번호와 붙는다.
    #[test]
    fn 받는_사람_빈_줄은_자리를_지키고_끝_빈_줄만_뗀다() {
        sandbox(|_| {
            let id = create_history_begin(json!({
                "kind": "certificate", "title": "필라테스 지도자 과정", "brand": "HANBIT", "count": 4,
                "details": { "template": "course", "recipients": ["김하늘", "", "박바다", "", " "], "issued_on": "2026-09-23" }
            }))
            .unwrap();
            assert_eq!(create_history_get(id).unwrap()["recipients"], json!(["김하늘", "", "박바다"]));
        });
    }

    /// 검수 09-24 — 묶음 인쇄·목록 표·한 장 인쇄도 `write_private` 가 쓰다 만 이름을 남긴다.
    #[test]
    fn 쓰다_만_인쇄_파일_이름을_알아본다() {
        let id = "a".repeat(32);
        for tail in ["", "-all", "-list", "-12"] {
            let name = format!("certificate-{id}{tail}.pending-0123456789abcdef");
            assert_eq!(printout_name(&name), Some((id.as_str(), true)), "{name}");
        }
        for bad in ["-0", "-1234", "-x", "-all-list"] {
            let name = format!("certificate-{id}{bad}.pending-0123456789abcdef");
            assert_eq!(printout_name(&name), None, "{name}");
        }
        assert_eq!(printout_name(&format!("certificate-{id}-all.pending-0123")), None, "16자리 아님");
        assert!(shared_tail("-list.pending-0123456789abcdef"));
    }

    /// 검수 09-24 — 기록에서 빠진 사진 폴더는 켤 때 지운다(얼굴이다).
    #[test]
    fn 기록에_없는_사진_폴더는_정리할_때_지운다() {
        sandbox(|dir| {
            let aged = |p: &std::path::Path| {
                let t = std::time::SystemTime::now() - std::time::Duration::from_secs(20 * 60);
                std::fs::File::open(p).unwrap().set_modified(t).unwrap();
            };
            let id = begin_certificate(&["김하늘"]);
            let root = dir.join("create-photos");
            let mine = root.join(&id);
            let gone = root.join("0".repeat(32));
            let fresh = root.join("1".repeat(32));
            let odd = root.join("not-an-id");
            for d in [&mine, &gone, &fresh, &odd] {
                std::fs::create_dir_all(d).unwrap();
                std::fs::write(d.join("0.img"), [0xFF, 0xD8, 0xFF]).unwrap();
            }
            for d in [&mine, &gone, &odd] {
                aged(d);
            }
            tidy(now());
            assert!(mine.exists(), "기록에 있는 것은 둔다");
            assert!(!gone.exists(), "기록에 없는 것은 지운다");
            assert!(fresh.exists(), "방금 만든 것은 10분 둔다");
            assert!(odd.exists(), "이름 모양이 다르면 안 지운다");
            // 기록이 망가져 못 읽으면 아무것도 안 지운다.
            std::fs::write(dir.join(FILE), b"{broken").unwrap();
            let gone2 = root.join("2".repeat(32));
            std::fs::create_dir_all(&gone2).unwrap();
            aged(&gone2);
            sweep_orphan_photos(dir);
            assert!(gone2.exists());
        });
    }

    /// 검수 09-24 — 새로 시작할 때 오래돼 빠지는 기록의 사진도 같이 지운다.
    #[test]
    fn 그만둔_기록이_빠질_때_사진도_지운다() {
        sandbox(|dir| {
            let old = begin_certificate(&["김하늘"]);
            let photos = dir.join("create-photos").join(&old);
            std::fs::create_dir_all(&photos).unwrap();
            std::fs::write(photos.join("0.img"), [0xFF, 0xD8, 0xFF]).unwrap();
            with_store(|store| {
                for e in store["entries"].as_array_mut().unwrap() {
                    e["at"] = json!(now() - ABANDONED_AFTER_SECS - 10);
                }
                Ok(())
            })
            .unwrap();
            let _new = begin_certificate(&["이바다"]);
            assert!(create_history_get(old).is_err());
            assert!(!photos.exists());
        });
    }

    /// 검수 — `printouts` 가 다른 폴더를 가리키는 바로가기여도 그 폴더를 비우지 않는다.
    #[cfg(unix)]
    #[test]
    fn 정리는_바로가기_폴더를_따라가지_않는다() {
        sandbox(|dir| {
            let other = dir.join("elsewhere");
            std::fs::create_dir_all(&other).unwrap();
            let victim = other.join(format!("certificate-{}.html", "0".repeat(32)));
            std::fs::write(&victim, b"not ours").unwrap();
            let old = std::time::SystemTime::now() - std::time::Duration::from_secs(10 * 24 * 3600);
            std::fs::File::options().write(true).open(&victim).unwrap().set_modified(old).unwrap();
            let tax = other.join("tax-return.pdf");
            std::fs::write(&tax, b"not ours").unwrap();
            std::fs::File::options().write(true).open(&tax).unwrap().set_modified(old).unwrap();
            std::os::unix::fs::symlink(&other, dir.join("printouts")).unwrap();
            tidy(now() + 5 * 366 * 24 * 3600);
            assert!(victim.exists() && tax.exists(), "바로가기 너머는 손대지 않는다");
        });
    }

    /// 검수 S10 — 보내는 도중 앱이 꺼지면 `sending` 이 남는다. 다시 켜면 「보냈는지 모름」.
    #[test]
    fn 보내다_꺼진_기록은_다시_켜면_보냈는지_모름이다() {
        sandbox(|_| {
            let id = begin_certificate(&["가", "나"]);
            let names = vec!["HANBIT#A260923-1".to_string(), "HANBIT#A260923-2".to_string()];
            mark_sending(&id, "uniques", &names).unwrap();
            assert!(mark_sending(&id, "uniques", &names).is_err(), "보내는 중인 것을 또 보내지 않는다");
            assert!(create_history_begin(json!({"kind":"work","title":"그림","brand":"HANBIT","count":1})).is_err());
            assert!(create_history_forget(id.clone()).is_err(), "보냈는지 모르는 줄은 못 지운다");
            // 앱을 다시 켰다(보내는 중인 발행이 없다).
            let u = create_unresolved().unwrap().unwrap();
            assert_eq!(u["id"], id.as_str());
            assert_eq!(u["status"], "sent-unknown");
            assert_eq!(u["unknown"]["names"], json!(names));
            // 노드가 분명히 거절한 경우는 보내기 전으로 돌아간다.
            let id2 = {
                with_store(|s| { find(s, &id).unwrap()["status"] = json!("done"); Ok(()) }).unwrap();
                begin_certificate(&["다"])
            };
            mark_sending(&id2, "uniques", &names).unwrap();
            mark_not_sent(&id2).unwrap();
            let e = create_history_get(id2).unwrap();
            assert_eq!(e["status"], "started");
            assert!(e.get("unknown").is_none());
        });
    }

    #[test]
    fn 망가진_기록은_옆에_두고_새로_시작하고_지문은_건진다() {
        sandbox(|dir| {
            let broken = format!("{{\"version\":1,\"fingerprints\":[\"{CID}\"],\"entries\":[{{\"id\":");
            std::fs::write(dir.join(FILE), &broken).unwrap();
            let err = create_history_list().unwrap_err();
            assert!(err.starts_with("CREATE_HISTORY_CORRUPT: "), "화면이 「기록을 새로 시작」을 내려면 표지가 있어야 한다");
            let r = create_history_restart().unwrap();
            assert_eq!(r["fingerprints"], 1);
            let kept = dir.join(r["kept"].as_str().unwrap());
            assert_eq!(std::fs::read_to_string(&kept).unwrap(), broken, "망가진 파일은 지우지 않고 그대로 남긴다");
            assert!(create_history_list().unwrap().is_empty());
            assert!(fingerprint_set().contains(CID));
            assert!(create_history_restart().is_err(), "멀쩡한 기록은 새로 시작하지 않는다");
        });
    }
}
