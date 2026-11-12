//! 폰에서 「게임 올리기」 — 이 컴퓨터와 **연결된 사장 폰**이 게임 파일을 보내면, 이 컴퓨터가 같은 길(폴더 검사 → IPFS → 서명 → 알림 쪽지)로 올린다. (2026-11-13, 대표 추가)
//!
//! 길: 폰 → `POST /api/scan/sealed`(가게 봉함 v1 — x25519 + XChaCha20, 토큰은 선에 안 실림) → 안쪽 `POST /api/admin/arcade-upload`.
//!   · 사장 토큰(owner)만 · **봉함으로 온 것만**(SealedInner 확장값 — 네트워크에서 만들 수 없다). 평문·직원·검표 토큰은 거절.
//!   · action = start | chunk | finish | status | cancel | info.
//!     start  { files:[{path,size,sha256}] }  또는  { zip:{size,sha256} }  → { id, chunkBytes }
//!     chunk  { id, path, offset, data(base64) }  — 파일마다 앞에서부터 차례로(offset = 지금까지 받은 크기)
//!     finish { id, meta:{ title, description, genre, priceSats, minutes, tag, entry?, mode:'open'|'shop', shop? } } → 해시 확인·zip 풀기·폴더 훑기 → 일감 줄
//!     status { id } → { status, step, message, result }       info {} → { maxBytes, maxFiles, chunkBytes }
//! 🔴 열쇠는 이 컴퓨터를 떠나지 않는다. 폰은 파일과 글만 보낸다. 서명·IPFS·릴레이는 이 컴퓨터 화면(TS arcade-phone-upload.ts)이 같은 함수로 한다.
//! 🔴 상한: 모두 30MB · 파일 500개 · 조각 32KiB(base64·JSON 을 더해도 봉함 평문 64KiB 안) · 받는 중 일감 하나 · 30분 지나면 버림.
//! 🔴 zip: 경로마다 core safePath 규칙(.. · 절대 경로 · 숨김 · 이상한 글자 거절), 바로가기(symlink) 거절, 대소문자 겹침 거절,
//!    풀린 크기를 실제로 세어 상한(선언 크기를 믿지 않는다), 압축률 200배 넘으면 거절(zip 폭탄). 새 파일만 만든다(덮어쓰기 없음).
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

pub const MAX_TOTAL: u64 = 30 * 1024 * 1024;
pub const MAX_FILES: usize = 500;
pub const CHUNK_BYTES: usize = 32 * 1024; // base64 + JSON 이 봉인 안쪽 한도(shopseal MAX_PLAIN 64 KiB) 안에 들도록
pub const SESSION_TTL_SECS: u64 = 30 * 60;
const MAX_RATIO: u64 = 200;
const MAX_JOBS: usize = 3;
const GENRES: [&str; 12] = ["action", "puzzle", "arcade", "racing", "sports", "rhythm", "board", "adventure", "shooting", "casual", "kids", "other"];

#[derive(Clone, Debug)]
struct Want { path: String, size: u64, sha256: String, got: u64 }

#[derive(Clone, Debug)]
struct Session { id: String, dir: PathBuf, zip: bool, files: Vec<Want>, at: u64 }

#[derive(Clone, Debug)]
pub struct Job { pub id: String, pub dir: PathBuf, pub meta: Value, pub scan: Value, pub status: String, pub step: String, pub message: String, pub result: Value, pub at: u64 }

static SESSION: Mutex<Option<Session>> = Mutex::new(None);
static JOBS: Mutex<Vec<Job>> = Mutex::new(Vec::new());

fn now() -> u64 { std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0) }
fn hex(b: &[u8]) -> String { b.iter().map(|x| format!("{x:02x}")).collect() }
fn new_id() -> String { use rand::RngCore; let mut b = [0u8; 16]; rand::rngs::OsRng.fill_bytes(&mut b); hex(&b) }
fn is_hex64(s: &str) -> bool { s.len() == 64 && s.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)) }
fn err(code: &str, say: &str) -> (u16, Value) { (400, json!({ "code": code, "error": say })) }

fn base_dir() -> PathBuf { crate::paths::app_file("arcade-phone-upload") }

/// 들어온 요청 하나(봉함·사장 확인은 server.rs 가 이미 했다). (HTTP 상태, 본문)
pub fn handle(body: &Value) -> (u16, Value) { handle_in(&base_dir(), body) }

pub fn handle_in(base: &Path, body: &Value) -> (u16, Value) {
    let action = body.get("action").and_then(Value::as_str).unwrap_or("");
    match action {
        "info" => (200, json!({ "ok": true, "maxBytes": MAX_TOTAL, "maxFiles": MAX_FILES, "chunkBytes": CHUNK_BYTES })),
        "start" => start(base, body),
        "chunk" => chunk(body),
        "finish" => finish(body),
        "status" => status(body),
        "cancel" => { cancel(body); (200, json!({ "ok": true })) }
        _ => err("bad-action", "알 수 없는 요청이에요."),
    }
}

fn start(base: &Path, body: &Value) -> (u16, Value) {
    let mut wants = Vec::new();
    let zip = body.get("zip").is_some();
    if zip {
        let z = &body["zip"];
        let (size, sha) = (z["size"].as_u64().unwrap_or(0), z["sha256"].as_str().unwrap_or(""));
        if size == 0 || size > MAX_TOTAL || !is_hex64(sha) { return err("too-large", "zip 파일은 30MB 까지예요."); }
        wants.push(Want { path: "upload.zip".into(), size, sha256: sha.into(), got: 0 });
    } else {
        let Some(list) = body["files"].as_array() else { return err("bad-files", "보낼 파일 목록이 없어요."); };
        if list.is_empty() || list.len() > MAX_FILES { return err("too-many", "파일은 500개까지예요."); }
        let mut total = 0u64;
        let mut lower = std::collections::HashSet::new();
        for f in list {
            let (p, size, sha) = (f["path"].as_str().unwrap_or(""), f["size"].as_u64().unwrap_or(u64::MAX), f["sha256"].as_str().unwrap_or(""));
            if !crate::arcade_upload::safe_path(p) { return err("bad-path", "파일 이름에는 영문·숫자·점·밑줄·빼기만 쓸 수 있어요."); }
            if !lower.insert(p.to_ascii_lowercase()) { return err("bad-path", "같은 이름의 파일이 둘 있어요."); }
            if !is_hex64(sha) || size > MAX_TOTAL { return err("bad-files", "파일 정보가 올바르지 않아요."); }
            total = total.saturating_add(size);
            if total > MAX_TOTAL { return err("too-large", "모두 30MB 까지예요."); }
            wants.push(Want { path: p.into(), size, sha256: sha.into(), got: 0 });
        }
    }
    let id = new_id();
    let dir = base.join(&id);
    let _ = std::fs::remove_dir_all(&dir);
    if std::fs::create_dir_all(dir.join("in")).is_err() { return (500, json!({ "code": "disk", "error": "이 컴퓨터에 받을 자리를 만들지 못했어요." })); }
    // 받는 중인 일감은 하나 — 새로 시작하면 옛 것은 버린다(같은 사장 폰만 부를 수 있다).
    let old = SESSION.lock().ok().and_then(|mut s| s.replace(Session { id: id.clone(), dir, zip, files: wants, at: now() }));
    if let Some(o) = old { let _ = std::fs::remove_dir_all(&o.dir); }
    (200, json!({ "ok": true, "id": id, "chunkBytes": CHUNK_BYTES }))
}

fn chunk(body: &Value) -> (u16, Value) {
    use base64::Engine as _;
    let mut g = match SESSION.lock() { Ok(g) => g, Err(_) => return (500, json!({ "code": "state" })) };
    let Some(s) = g.as_mut() else { return err("no-session", "받는 중인 게임이 없어요. 처음부터 다시 보내 주세요."); };
    if body["id"].as_str() != Some(s.id.as_str()) || now().saturating_sub(s.at) > SESSION_TTL_SECS { return err("no-session", "받는 중인 게임이 없어요. 처음부터 다시 보내 주세요."); }
    let path = body["path"].as_str().unwrap_or("");
    let Some(w) = s.files.iter_mut().find(|w| w.path == path) else { return err("bad-path", "목록에 없는 파일이에요."); };
    let data = body["data"].as_str().unwrap_or("");
    if data.len() > CHUNK_BYTES * 4 / 3 + 8 { return err("too-large", "조각이 너무 커요."); }
    let Ok(bytes) = base64::engine::general_purpose::STANDARD.decode(data) else { return err("bad-chunk", "조각을 읽지 못했어요."); };
    if bytes.is_empty() || bytes.len() > CHUNK_BYTES { return err("bad-chunk", "조각 크기가 맞지 않아요."); }
    if body["offset"].as_u64() != Some(w.got) { return (409, json!({ "code": "offset", "error": "조각 순서가 맞지 않아요.", "expect": w.got })); }
    if w.got + bytes.len() as u64 > w.size { return err("too-large", "선언한 크기보다 커요."); }
    let file = s.dir.join("in").join(&w.path);
    if let Some(parent) = file.parent() { let _ = std::fs::create_dir_all(parent); }
    let opened = if w.got == 0 { std::fs::OpenOptions::new().write(true).create_new(true).open(&file) } else { std::fs::OpenOptions::new().append(true).open(&file) };
    let Ok(mut fh) = opened else { return (500, json!({ "code": "disk", "error": "이 컴퓨터에 쓰지 못했어요." })) };
    if fh.write_all(&bytes).is_err() { return (500, json!({ "code": "disk", "error": "이 컴퓨터에 쓰지 못했어요." })); }
    w.got += bytes.len() as u64;
    let got = w.got;
    s.at = now();
    let done: u64 = s.files.iter().map(|w| w.got).sum();
    (200, json!({ "ok": true, "got": got, "received": done }))
}

fn text_ok(v: &Value, min: usize, max: usize) -> bool { v.as_str().is_some_and(|s| { let n = s.chars().count(); n >= min && n <= max && !s.chars().any(|c| c.is_control() && c != '\n') }) }

/// 폰이 적은 글 — 모양만(TS buildBody 가 문서 규칙으로 한 번 더 본다).
pub fn check_meta(m: &Value) -> Result<(), &'static str> {
    if !text_ok(&m["title"], 1, 80) { return Err("게임 이름은 1~80자예요."); }
    if !m["description"].is_null() && !text_ok(&m["description"], 0, 2000) { return Err("설명은 2000자까지예요."); }
    if !m["genre"].as_str().is_some_and(|g| GENRES.contains(&g)) { return Err("장르가 올바르지 않아요."); }
    if !m["priceSats"].as_str().is_some_and(|p| !p.is_empty() && p.len() <= 18 && p.bytes().all(|b| b.is_ascii_digit()) && (p == "0" || !p.starts_with('0'))) { return Err("값이 올바르지 않아요."); }
    if !m["minutes"].as_u64().is_some_and(|n| (1..=240).contains(&n)) { return Err("한 판 시간은 1~240분이에요."); }
    if !m["tag"].as_str().is_some_and(|t| !t.is_empty() && t.len() <= 20 && t.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_')) { return Err("꼬리표는 영문·숫자·밑줄로 적어 주세요."); }
    if !m["entry"].is_null() && !m["entry"].as_str().is_some_and(crate::arcade_upload::safe_path) { return Err("시작 파일 이름이 올바르지 않아요."); }
    match m["mode"].as_str() {
        Some("open") => {}
        Some("shop") => if !m["shop"].as_str().is_some_and(|s| !s.is_empty() && s.len() <= 30 && s.bytes().all(|b| b.is_ascii_uppercase() || b.is_ascii_digit() || b == b'.' || b == b'_')) { return Err("가게 이름이 올바르지 않아요."); },
        _ => return Err("올리는 곳이 올바르지 않아요."),
    }
    Ok(())
}

fn sha_file(p: &Path) -> Option<String> {
    let mut f = std::fs::File::open(p).ok()?;
    let mut h = Sha256::new();
    let mut buf = vec![0u8; 64 * 1024];
    loop { let n = f.read(&mut buf).ok()?; if n == 0 { break; } h.update(&buf[..n]); }
    Some(hex(&h.finalize()))
}

/// zip 을 game 폴더에 푼다(위 🔴 규칙). 맞으면 풀린 파일 수.
pub fn extract_zip(zip_path: &Path, out: &Path) -> Result<usize, String> {
    let f = std::fs::File::open(zip_path).map_err(|_| "zip 을 열지 못했어요.".to_string())?;
    let mut a = zip::ZipArchive::new(f).map_err(|_| "zip 파일이 아니에요.".to_string())?;
    if a.len() > MAX_FILES * 2 { return Err("zip 안 파일이 너무 많아요(500개까지).".into()); }
    // 모든 파일이 폴더 하나 아래에 있으면(흔한 「폴더째 압축」) 그 폴더를 뗀다.
    let mut names = Vec::new();
    for i in 0..a.len() {
        let e = a.by_index_raw(i).map_err(|_| "zip 을 읽지 못했어요.".to_string())?;
        if e.is_dir() { continue; }
        names.push(e.name().to_string());
    }
    let skip = |n: &str| n.starts_with("__MACOSX/") || n.split('/').any(|s| s.starts_with('.'));
    let real: Vec<&String> = names.iter().filter(|n| !skip(n)).collect();
    let top = real.first().and_then(|n| n.split_once('/').map(|(t, _)| format!("{t}/")));
    let strip = top.filter(|t| real.iter().all(|n| n.starts_with(t.as_str())));
    std::fs::create_dir_all(out).map_err(|_| "풀 자리를 만들지 못했어요.".to_string())?;
    let (mut total, mut count) = (0u64, 0usize);
    let mut lower = std::collections::HashSet::new();
    for i in 0..a.len() {
        let mut e = a.by_index(i).map_err(|_| "zip 을 읽지 못했어요.".to_string())?;
        let raw = e.name().to_string();
        if e.is_dir() || skip(&raw) { continue; }
        if e.unix_mode().is_some_and(|m| m & 0o170000 == 0o120000) { return Err(format!("zip 안의 바로가기는 받지 않아요: {raw}")); }
        if e.enclosed_name().is_none() { return Err(format!("zip 안 경로가 폴더 밖을 가리켜요: {raw}")); }
        let rel = strip.as_deref().and_then(|t| raw.strip_prefix(t)).unwrap_or(&raw).to_string();
        if !crate::arcade_upload::safe_path(&rel) { return Err(format!("파일 이름에는 영문·숫자·점·밑줄·빼기만 쓸 수 있어요: {raw}")); }
        if !lower.insert(rel.to_ascii_lowercase()) { return Err(format!("같은 이름의 파일이 둘 있어요: {rel}")); }
        count += 1;
        if count > MAX_FILES { return Err("zip 안 파일이 너무 많아요(500개까지).".into()); }
        if e.compressed_size() > 0 && e.size() / e.compressed_size().max(1) > MAX_RATIO { return Err(format!("압축이 지나치게 큰 파일이에요: {rel}")); }
        let dest = out.join(&rel);
        if let Some(p) = dest.parent() { std::fs::create_dir_all(p).map_err(|_| "풀 자리를 만들지 못했어요.".to_string())?; }
        let mut w = std::fs::OpenOptions::new().write(true).create_new(true).open(&dest).map_err(|_| format!("풀지 못했어요: {rel}"))?;
        // 선언 크기를 믿지 않는다 — 실제로 읽은 바이트를 센다.
        let left = MAX_TOTAL.saturating_sub(total);
        let n = std::io::copy(&mut (&mut e).take(left + 1), &mut w).map_err(|_| format!("풀지 못했어요: {rel}"))?;
        total += n;
        if total > MAX_TOTAL { return Err("풀면 30MB 를 넘어요.".into()); }
    }
    if count == 0 { return Err("zip 안에 게임 파일이 없어요.".into()); }
    Ok(count)
}

fn finish(body: &Value) -> (u16, Value) {
    let meta = body["meta"].clone();
    if let Err(say) = check_meta(&meta) { return err("bad-meta", say); }
    let s = match SESSION.lock() { Ok(mut g) => match g.take() { Some(s) if body["id"].as_str() == Some(s.id.as_str()) => s, other => { *g = other; return err("no-session", "받는 중인 게임이 없어요. 처음부터 다시 보내 주세요."); } }, Err(_) => return (500, json!({ "code": "state" })) };
    let fail = |s: &Session, code: &str, say: String| { let _ = std::fs::remove_dir_all(&s.dir); (400u16, json!({ "code": code, "error": say })) };
    for w in &s.files {
        if w.got != w.size { return fail(&s, "incomplete", format!("다 받지 못한 파일이 있어요: {}", w.path)); }
        if sha_file(&s.dir.join("in").join(&w.path)).as_deref() != Some(w.sha256.as_str()) { return fail(&s, "hash", format!("받은 파일이 보낸 것과 달라요: {}", w.path)); }
    }
    let game = if s.zip {
        let g = s.dir.join("game");
        if let Err(say) = extract_zip(&s.dir.join("in").join("upload.zip"), &g) { return fail(&s, "zip", say); }
        g
    } else { s.dir.join("in") };
    let scan = match crate::arcade_upload::scan_answer(&game) { Ok(v) => v, Err(say) => return fail(&s, "scan", say) };
    let job = Job { id: s.id.clone(), dir: game, meta, scan, status: "queued".into(), step: "".into(), message: "".into(), result: Value::Null, at: now() };
    if let Ok(mut j) = JOBS.lock() {
        j.retain(|x| now().saturating_sub(x.at) < 24 * 3600);
        while j.len() >= MAX_JOBS { let o = j.remove(0); let _ = std::fs::remove_dir_all(o.dir.parent().unwrap_or(&o.dir)); }
        j.push(job);
    }
    (200, json!({ "ok": true, "status": "queued" }))
}

fn job_json(j: &Job) -> Value { json!({ "id": j.id, "status": j.status, "step": j.step, "message": j.message, "result": j.result }) }

fn status(body: &Value) -> (u16, Value) {
    let id = body["id"].as_str().unwrap_or("");
    if let Ok(j) = JOBS.lock() { if let Some(x) = j.iter().find(|x| x.id == id) { return (200, job_json(x)); } }
    if let Ok(g) = SESSION.lock() { if g.as_ref().is_some_and(|s| s.id == id) { return (200, json!({ "id": id, "status": "receiving" })); } }
    (404, json!({ "code": "unknown", "error": "그런 일감이 없어요." }))
}

fn cancel(body: &Value) {
    let id = body["id"].as_str().unwrap_or("");
    if let Ok(mut g) = SESSION.lock() { if g.as_ref().is_some_and(|s| s.id == id) { if let Some(s) = g.take() { let _ = std::fs::remove_dir_all(&s.dir); } } }
    if let Ok(mut j) = JOBS.lock() { for x in j.iter_mut().filter(|x| x.id == id && x.status == "queued") { x.status = "cancelled".into(); } }
}

// ── 이 컴퓨터 화면(TS)이 부르는 것 ────────────────────────────────────────

/// 기다리는 일감(queued · needs-desktop). 화면이 몇 초마다 묻는다.
#[tauri::command(async)]
pub fn arcade_phone_jobs() -> Value {
    let j = JOBS.lock().map(|j| j.clone()).unwrap_or_default();
    json!(j.iter().filter(|x| x.status == "queued" || x.status == "needs-desktop")
        .map(|x| json!({ "id": x.id, "status": x.status, "meta": x.meta, "scan": x.scan })).collect::<Vec<_>>())
}

/// 이 일감의 폴더를 「고른 폴더」로 — arcade_pin_folder 가 그 폴더만 다시 재서 올린다(화면이 경로를 보내지 않는다).
#[tauri::command(async)]
pub fn arcade_phone_take(id: String) -> Result<(), String> {
    let dir = JOBS.lock().map_err(|_| "상태 오류")?.iter().find(|x| x.id == id).map(|x| x.dir.clone()).ok_or("그런 일감이 없어요.")?;
    crate::arcade_upload::set_picked(dir);
    Ok(())
}

/// 진행·결과 적기(폰이 status 로 읽는다). status = working | needs-desktop | done | failed | rejected.
#[tauri::command(async)]
pub fn arcade_phone_report(id: String, status: String, step: String, message: String, result: Option<Value>) -> Result<(), String> {
    if !["working", "needs-desktop", "done", "failed", "rejected"].contains(&status.as_str()) { return Err("상태 이름이 올바르지 않아요.".into()); }
    let mut j = JOBS.lock().map_err(|_| "상태 오류")?;
    let x = j.iter_mut().find(|x| x.id == id).ok_or("그런 일감이 없어요.")?;
    x.status = status; x.step = step.chars().take(40).collect(); x.message = message.chars().take(600).collect();
    if let Some(r) = result { x.result = json!({ "docCid": r["docCid"].as_str().unwrap_or(""), "key": r["key"].as_str().unwrap_or("") }); }
    Ok(())
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use base64::Engine as _;

    fn sha(b: &[u8]) -> String { hex(&Sha256::digest(b)) }
    fn tmp(name: &str) -> PathBuf { let d = std::env::temp_dir().join(format!("rv-arcade-phone-{}-{name}", std::process::id())); let _ = std::fs::remove_dir_all(&d); std::fs::create_dir_all(&d).unwrap(); d }
    fn meta() -> Value { json!({ "title": "Star Run", "description": "", "genre": "arcade", "priceSats": "50000000", "minutes": 3, "tag": "STAR_RUN", "mode": "open" }) }
    fn send(id: &str, path: &str, bytes: &[u8]) -> (u16, Value) {
        let mut off = 0usize; let mut last = (200, Value::Null);
        for c in bytes.chunks(CHUNK_BYTES) {
            last = chunk(&json!({ "id": id, "path": path, "offset": off, "data": base64::engine::general_purpose::STANDARD.encode(c) }));
            if last.0 != 200 { return last; }
            off += c.len();
        }
        last
    }
    // SESSION 은 프로세스 하나에 하나 — 시험끼리 겹치지 않게 줄 세운다.
    pub(crate) static SERIAL: Mutex<()> = Mutex::new(());

    #[test]
    fn 파일_여러_개를_조각으로_받아_해시를_맞추고_일감으로() {
        let _g = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
        let base = tmp("files");
        let html = b"<!doctype html><script src=\"js/a.js\"></script>".to_vec();
        let js = vec![b'x'; CHUNK_BYTES * 2 + 17];
        let (st, r) = handle_in(&base, &json!({ "action": "start", "files": [
            { "path": "index.html", "size": html.len(), "sha256": sha(&html) }, { "path": "js/a.js", "size": js.len(), "sha256": sha(&js) } ] }));
        assert_eq!(st, 200, "{r}");
        let id = r["id"].as_str().unwrap().to_string();
        assert_eq!(send(&id, "index.html", &html).0, 200);
        // 순서가 틀린 조각은 409
        assert_eq!(chunk(&json!({ "id": id, "path": "js/a.js", "offset": 5, "data": "eHg=" })).0, 409);
        assert_eq!(send(&id, "js/a.js", &js).0, 200);
        // 선언보다 큰 조각
        assert_eq!(chunk(&json!({ "id": id, "path": "js/a.js", "offset": js.len(), "data": "eHg=" })).0, 400);
        let (st, r) = handle_in(&base, &json!({ "action": "finish", "id": id, "meta": meta() }));
        assert_eq!(st, 200, "{r}");
        let jobs = arcade_phone_jobs();
        let job = jobs.as_array().unwrap().iter().find(|j| j["id"] == id.as_str()).unwrap().clone();
        assert_eq!(job["scan"]["files"].as_array().unwrap().len(), 2);
        assert!(job["scan"]["htmlTexts"]["index.html"].as_str().unwrap().contains("js/a.js"));
        arcade_phone_report(id.clone(), "done".into(), "done".into(), "".into(), Some(json!({ "docCid": "QmX", "key": "R/x" }))).unwrap();
        assert_eq!(handle_in(&base, &json!({ "action": "status", "id": id })).1["status"], "done");
        assert!(arcade_phone_report(id, "hacked".into(), "".into(), "".into(), None).is_err());
    }

    #[test]
    fn 크기_개수_이름_해시_상한() {
        let _g = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
        let base = tmp("caps");
        let s = |files: Value| handle_in(&base, &json!({ "action": "start", "files": files })).0;
        let h = "a".repeat(64);
        assert_eq!(s(json!([{ "path": "a.bin", "size": MAX_TOTAL + 1, "sha256": h }])), 400, "30MB 넘음");
        assert_eq!(s(json!([{ "path": "a.bin", "size": MAX_TOTAL, "sha256": h }, { "path": "b.bin", "size": 1, "sha256": h }])), 400, "합계 30MB 넘음");
        let many: Vec<Value> = (0..=MAX_FILES).map(|i| json!({ "path": format!("f{i}.js"), "size": 1, "sha256": h })).collect();
        assert_eq!(s(json!(many)), 400, "501개");
        for bad in ["../x.js", "/etc/passwd", "a/../../b", ".hidden", "한글.png", "a\\b.js", "a//b"] {
            assert_eq!(s(json!([{ "path": bad, "size": 1, "sha256": h }])), 400, "{bad}");
        }
        assert_eq!(s(json!([{ "path": "A.js", "size": 1, "sha256": h }, { "path": "a.js", "size": 1, "sha256": h }])), 400, "대소문자 겹침");
        assert_eq!(handle_in(&base, &json!({ "action": "start", "zip": { "size": MAX_TOTAL + 1, "sha256": h } })).0, 400);
        // 해시가 다르면 finish 거절(받은 것을 지운다)
        let (_, r) = handle_in(&base, &json!({ "action": "start", "files": [{ "path": "index.html", "size": 3, "sha256": h }] }));
        let id = r["id"].as_str().unwrap().to_string();
        assert_eq!(send(&id, "index.html", b"abc").0, 200);
        let (st, r) = handle_in(&base, &json!({ "action": "finish", "id": id, "meta": meta() }));
        assert_eq!((st, r["code"].as_str()), (400, Some("hash")));
        // 다 안 보냄 · 모르는 id
        let (_, r) = handle_in(&base, &json!({ "action": "start", "files": [{ "path": "index.html", "size": 3, "sha256": sha(b"abc") }] }));
        let id = r["id"].as_str().unwrap().to_string();
        assert_eq!(handle_in(&base, &json!({ "action": "finish", "id": id, "meta": meta() })).1["code"], "incomplete");
        assert_eq!(chunk(&json!({ "id": "nope", "path": "index.html", "offset": 0, "data": "YQ==" })).0, 400);
    }

    #[test]
    fn 글_모양() {
        assert!(check_meta(&meta()).is_ok());
        let with = |k: &str, v: Value| { let mut m = meta(); m[k] = v; m };
        for bad in [with("title", json!("")), with("genre", json!("casino")), with("priceSats", json!("-1")), with("priceSats", json!("01")),
            with("minutes", json!(0)), with("tag", json!("별")), with("mode", json!("chain")), with("entry", json!("../x.html")),
            { let mut m = meta(); m["mode"] = json!("shop"); m }, { let mut m = meta(); m["mode"] = json!("shop"); m["shop"] = json!("bad shop"); m }] {
            assert!(check_meta(&bad).is_err(), "{bad}");
        }
        let mut shop = meta(); shop["mode"] = json!("shop"); shop["shop"] = json!("PLAYX");
        assert!(check_meta(&shop).is_ok());
    }

    fn make_zip(path: &Path, entries: &[(&str, &[u8])], symlink: Option<&str>) {
        let f = std::fs::File::create(path).unwrap();
        let mut z = zip::ZipWriter::new(f);
        let opt = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
        for (n, b) in entries { z.start_file(*n, opt).unwrap(); z.write_all(b).unwrap(); }
        if let Some(l) = symlink { z.add_symlink(l, "/etc/passwd", opt).unwrap(); }
        z.finish().unwrap();
    }

    #[test]
    fn zip_풀기_경로_넘기_막기() {
        let d = tmp("zip");
        // 폴더째 압축 → 윗 폴더를 뗀다 · 숨김·__MACOSX 는 건너뛴다
        make_zip(&d.join("ok.zip"), &[("star/index.html", b"<html>"), ("star/js/a.js", b"1"), ("__MACOSX/star/._a", b"x"), ("star/.DS_Store", b"x")], None);
        assert_eq!(extract_zip(&d.join("ok.zip"), &d.join("ok")).unwrap(), 2);
        assert!(d.join("ok/index.html").exists() && d.join("ok/js/a.js").exists());
        for (name, entries) in [
            ("slip", vec![("../evil.js", b"x".as_slice())]),
            ("abs", vec![("/tmp/evil.js", b"x".as_slice())]),
            ("deep", vec![("a/../../evil.js", b"x".as_slice())]),
            ("hangul", vec![("그림.png", b"x".as_slice())]),
            ("case", vec![("a.js", b"x".as_slice()), ("A.js", b"y".as_slice())]),
        ] {
            make_zip(&d.join(format!("{name}.zip")), &entries, None);
            assert!(extract_zip(&d.join(format!("{name}.zip")), &d.join(name)).is_err(), "{name}");
            assert!(!d.join("evil.js").exists() && !d.parent().unwrap().join("evil.js").exists(), "{name} wrote outside");
        }
        make_zip(&d.join("link.zip"), &[("index.html", b"<html>")], Some("link.js"));
        assert!(extract_zip(&d.join("link.zip"), &d.join("link")).unwrap_err().contains("바로가기"));
        // zip 폭탄(압축률)
        let zeros = vec![0u8; 4 * 1024 * 1024];
        make_zip(&d.join("bomb.zip"), &[("index.html", &zeros)], None);
        assert!(extract_zip(&d.join("bomb.zip"), &d.join("bomb")).unwrap_err().contains("압축"));
        std::fs::write(d.join("not.zip"), b"hello").unwrap();
        assert!(extract_zip(&d.join("not.zip"), &d.join("not")).is_err());
    }

    #[test]
    fn zip_으로_보내도_같은_길() {
        let _g = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
        let base = tmp("zipflow");
        let zp = base.join("src.zip");
        make_zip(&zp, &[("game/index.html", b"<!doctype html><script src=\"g.js\"></script>"), ("game/g.js", b"go()")], None);
        let bytes = std::fs::read(&zp).unwrap();
        let (_, r) = handle_in(&base, &json!({ "action": "start", "zip": { "size": bytes.len(), "sha256": sha(&bytes) } }));
        let id = r["id"].as_str().unwrap().to_string();
        assert_eq!(send(&id, "upload.zip", &bytes).0, 200);
        assert_eq!(handle_in(&base, &json!({ "action": "finish", "id": id, "meta": meta() })).0, 200);
        let jobs = arcade_phone_jobs();
        let job = jobs.as_array().unwrap().iter().find(|j| j["id"] == id.as_str()).unwrap().clone();
        let paths: Vec<&str> = job["scan"]["files"].as_array().unwrap().iter().map(|f| f["path"].as_str().unwrap()).collect();
        assert_eq!(paths, vec!["g.js", "index.html"]);
        arcade_phone_take(id.clone()).unwrap();
        handle_in(&base, &json!({ "action": "cancel", "id": id }));
    }
}
