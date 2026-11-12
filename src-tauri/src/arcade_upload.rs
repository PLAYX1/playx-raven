//! 「게임 올리기」(오락실 판매자 쪽) — 폴더 고르기 · 살펴보기 · IPFS 에 붙잡기. (2026-11-13)
//!
//! 흐름(화면은 src/arcade-upload.ts): 폴더 고르기(이 컴퓨터 대화상자) → 살펴보기(파일 목록·sha256·크기·HTML 글) →
//! 화면이 규칙 검사(core/creator/arcade-product.ts 와 공유 사이트 게임 CSP) → 사람이 확인 → 폴더 붙잡기 → 문서 서명(sign_message)
//! → 문서 붙잡기(ipfs_add_file) → 자산 발행/재발행(issue_asset · reissue, 기존 문). 여기는 앞 셋만.
//!
//! 🔴 화면이 보낸 경로를 읽지 않는다 — 폴더는 이 명령이 연 **대화상자**에서 사람이 고른 것 하나만 기억하고, 그 폴더만 읽고 올린다.
//!    화면이 뚫려도 아무 폴더나 공개 IPFS 에 올릴 수 없게.
//! 🔴 붙잡을 때 파일을 **다시** 읽어 해시를 잰다 — 살펴본 뒤 바뀐 파일이 서명 문서와 다른 채로 나가지 않게(바뀌었으면 거절).
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

const API: &str = "http://127.0.0.1:5001/api/v0";
/// core ARCADE_LIMITS 와 같은 값.
pub const MAX_FILES: usize = 2000;
pub const MAX_TOTAL: u64 = 200 * 1024 * 1024;
/// HTML 글을 화면에 넘기는 총량(규칙 검사용).
const TEXT_MAX: usize = 8 * 1024 * 1024;

#[derive(Clone, Debug, PartialEq)]
pub struct Scanned {
    pub path: String,
    pub sha256: String,
    pub size: u64,
}

static PICKED: Mutex<Option<PathBuf>> = Mutex::new(None);

/// core limits.ts safePath 와 같은 규칙: 영문·숫자·점·밑줄·빼기, 숨김(.)·빈 칸·..·앞뒤 / 없음.
pub fn safe_path(p: &str) -> bool {
    !p.is_empty() && p.len() <= 200 && p.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'_' || b == b'-' || b == b'/')
        && !p.starts_with('/') && !p.ends_with('/') && !p.contains("//")
        && p.split('/').all(|s| s != "." && s != ".." && !s.starts_with('.'))
}

fn hex(b: &[u8]) -> String { b.iter().map(|x| format!("{x:02x}")).collect() }

/// 폴더를 훑는다. 숨김 파일(.DS_Store 등)은 건너뛰고 「건너뜀」으로 알린다. 링크는 따라가지 않는다.
pub fn scan_dir(root: &Path) -> Result<(Vec<Scanned>, Vec<String>, Vec<String>), String> {
    let mut out = Vec::new();
    let mut skipped = Vec::new();
    let mut bad = Vec::new();
    let mut stack = vec![(root.to_path_buf(), String::new())];
    let mut total: u64 = 0;
    while let Some((dir, prefix)) = stack.pop() {
        let rd = std::fs::read_dir(&dir).map_err(|_| "폴더를 읽지 못했습니다.".to_string())?;
        for e in rd.flatten() {
            let name = e.file_name().to_string_lossy().to_string();
            let rel = if prefix.is_empty() { name.clone() } else { format!("{prefix}/{name}") };
            let meta = match std::fs::symlink_metadata(e.path()) { Ok(m) => m, Err(_) => continue };
            if name.starts_with('.') { skipped.push(rel); continue; }
            if meta.file_type().is_symlink() { bad.push(rel); continue; }
            if meta.is_dir() { stack.push((e.path(), rel)); continue; }
            if !safe_path(&rel) { bad.push(rel); continue; }
            if out.len() >= MAX_FILES { return Err(format!("파일이 너무 많습니다({MAX_FILES}개까지).")); }
            total += meta.len();
            if total > MAX_TOTAL { return Err("폴더가 너무 큽니다(모두 200MB까지).".into()); }
            let bytes = std::fs::read(e.path()).map_err(|_| format!("파일을 읽지 못했습니다: {rel}"))?;
            out.push(Scanned { path: rel, sha256: hex(&Sha256::digest(&bytes)), size: bytes.len() as u64 });
        }
    }
    // 문서 files 는 경로 순(코드 포인트) — core checkFiles 와 같게.
    out.sort_by(|a, b| a.path.cmp(&b.path));
    skipped.sort();
    bad.sort();
    Ok((out, skipped, bad))
}

fn is_html(p: &str) -> bool { let l = p.to_ascii_lowercase(); l.ends_with(".html") || l.ends_with(".htm") }

pub(crate) fn scan_answer(root: &Path) -> Result<Value, String> {
    let (files, skipped, bad) = scan_dir(root)?;
    let mut texts = serde_json::Map::new();
    let mut used = 0usize;
    for f in files.iter().filter(|f| is_html(&f.path)) {
        if used + f.size as usize > TEXT_MAX { break; }
        if let Ok(s) = std::fs::read_to_string(root.join(&f.path)) { used += s.len(); texts.insert(f.path.clone(), json!(s)); }
    }
    let name = root.file_name().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
    Ok(json!({
        "folder": name,
        "files": files.iter().map(|f| json!({ "path": f.path, "sha256": f.sha256, "size": f.size })).collect::<Vec<_>>(),
        "skipped": skipped, "badNames": bad, "htmlTexts": texts,
    }))
}

/// 폰 연결 올리기(arcade_phone.rs)가 받은 폴더를 「고른 폴더」로 둔다 — 화면이 경로를 보내지 않는 규칙은 그대로.
pub(crate) fn set_picked(dir: PathBuf) {
    if let Ok(mut p) = PICKED.lock() { *p = Some(dir); }
}

/// 이 컴퓨터 대화상자로 게임 폴더를 고른다. 고른 폴더만 기억한다(다음 고르기 전까지).
#[tauri::command]
pub async fn arcade_pick_folder(app: tauri::AppHandle) -> Result<Value, String> {
    use tauri_plugin_dialog::DialogExt;
    if crate::app_lock::is_locked() { return Err("앱이 잠겨 있습니다.".into()); }
    let picked = tokio::task::spawn_blocking(move || app.dialog().file().set_title("게임 폴더 고르기").blocking_pick_folder())
        .await.map_err(|_| "폴더 고르기 창을 열지 못했습니다.".to_string())?;
    let Some(fp) = picked else { return Ok(Value::Null) };
    let path = fp.into_path().map_err(|_| "폴더 경로를 읽지 못했습니다.".to_string())?;
    let answer = tokio::task::spawn_blocking({ let p = path.clone(); move || scan_answer(&p) }).await.map_err(|_| "폴더를 읽지 못했습니다.".to_string())??;
    *PICKED.lock().map_err(|_| "상태 오류")? = Some(path);
    Ok(answer)
}

/// 방금 고른 폴더를 이 컴퓨터 IPFS 에 붙잡는다(공개). `expect` = 화면이 문서에 적을 files — 다시 잰 값과 같아야 한다.
#[tauri::command]
pub async fn arcade_pin_folder(expect: Vec<Value>) -> Result<Value, String> {
    let root = PICKED.lock().map_err(|_| "상태 오류")?.clone().ok_or("먼저 게임 폴더를 골라 주세요.")?;
    let (files, _, _) = tokio::task::spawn_blocking({ let r = root.clone(); move || scan_dir(&r) }).await.map_err(|_| "폴더를 읽지 못했습니다.".to_string())??;
    let want: Vec<(String, String, u64)> = expect.iter().map(|v| (
        v["path"].as_str().unwrap_or("").to_string(), v["sha256"].as_str().unwrap_or("").to_string(), v["size"].as_u64().unwrap_or(u64::MAX),
    )).collect();
    let have: Vec<(String, String, u64)> = files.iter().map(|f| (f.path.clone(), f.sha256.clone(), f.size)).collect();
    if want != have { return Err("살펴본 뒤 폴더 안 파일이 바뀌었습니다. 다시 골라 주세요.".into()); }
    let mut form = reqwest::multipart::Form::new();
    // 폴더 칸을 먼저(깊은 순서와 상관없이 부모가 앞에) — Kubo 는 디렉터리 칸이 자식보다 앞에 와야 한다.
    let mut dirs: Vec<String> = vec!["game".into()];
    for f in &files {
        let parts: Vec<&str> = f.path.split('/').collect();
        for i in 1..parts.len() { let d = format!("game/{}", parts[..i].join("/")); if !dirs.contains(&d) { dirs.push(d); } }
    }
    dirs.sort_by_key(|d| d.matches('/').count());
    for d in &dirs {
        let part = reqwest::multipart::Part::bytes(Vec::new()).file_name(d.clone()).mime_str("application/x-directory").map_err(|e| e.to_string())?;
        form = form.part("file", part);
    }
    for f in &files {
        let bytes = std::fs::read(root.join(&f.path)).map_err(|_| format!("파일을 읽지 못했습니다: {}", f.path))?;
        if hex(&Sha256::digest(&bytes)) != f.sha256 { return Err("올리는 사이에 파일이 바뀌었습니다. 다시 골라 주세요.".into()); }
        form = form.part("file", reqwest::multipart::Part::bytes(bytes).file_name(format!("game/{}", f.path)));
    }
    let r = reqwest::Client::new().post(format!("{API}/add?pin=true&cid-version=0"))
        .multipart(form).timeout(std::time::Duration::from_secs(600)).send().await
        .map_err(|e| format!("IPFS 파일창고에 올리지 못했습니다: {e}"))?;
    if !r.status().is_success() { return Err(format!("IPFS 파일창고가 거부했습니다: {}", r.status())); }
    let body = r.text().await.map_err(|e| e.to_string())?;
    let cid = folder_cid(&body).ok_or("IPFS 파일창고가 폴더 해시를 돌려주지 않았습니다.")?;
    Ok(json!({ "cid": cid, "files": files.len() }))
}

/// Kubo add 답(줄마다 JSON)에서 이름이 「game」인 줄의 해시.
pub fn folder_cid(body: &str) -> Option<String> {
    body.lines().filter_map(|l| serde_json::from_str::<Value>(l).ok())
        .find(|v| v["Name"].as_str() == Some("game"))
        .and_then(|v| v["Hash"].as_str().map(str::to_string))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 경로_규칙은_core_safePath_와_같다() {
        for ok in ["index.html", "js/app.js", "img/a-b_c.png"] { assert!(safe_path(ok), "{ok}"); }
        for bad in ["", "/x", "x/", "a//b", "../x", ".hidden", "a/.git/x", "한글.png", "a b.png"] { assert!(!safe_path(bad), "{bad}"); }
    }

    #[test]
    fn 폴더_훑기는_숨김을_빼고_경로_순으로_해시를_잰다() {
        let base = std::env::temp_dir().join(format!("rv-arcade-scan-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(base.join("js")).unwrap();
        std::fs::write(base.join("index.html"), b"<script src=\"js/a.js\"></script>").unwrap();
        std::fs::write(base.join("js/a.js"), b"1").unwrap();
        std::fs::write(base.join(".DS_Store"), b"x").unwrap();
        std::fs::write(base.join("bad name.png"), b"x").unwrap();
        let (files, skipped, bad) = scan_dir(&base).unwrap();
        assert_eq!(files.iter().map(|f| f.path.as_str()).collect::<Vec<_>>(), vec!["index.html", "js/a.js"]);
        assert_eq!(files[1].sha256, "6b86b273ff34fce19d6b804eff5a3f5747ada4eaa22f1d49c01e52ddb7875b4b"); // sha256("1")
        assert_eq!(skipped, vec![".DS_Store"]);
        assert_eq!(bad, vec!["bad name.png"]);
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn 폴더_해시는_game_줄에서() {
        let body = "{\"Name\":\"game/index.html\",\"Hash\":\"QmA\"}\n{\"Name\":\"game\",\"Hash\":\"QmRoot\"}\n";
        assert_eq!(folder_cid(body).as_deref(), Some("QmRoot"));
        assert_eq!(folder_cid("{\"Name\":\"x\",\"Hash\":\"Q\"}"), None);
    }
}
