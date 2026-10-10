//! 「끌어놓기 발행」이 창에 떨어뜨린 파일·폴더를 읽는 길(제작자 상품 올리기).
//!
//! ## 왜 이 파일이 필요한가
//!
//! 메인 창은 Tauri 의 끌어놓기 가로채기(dragDropEnabled 기본값 = 켜짐)를 쓴다
//! (`ravi_companion.rs` 의 `WindowEvent::DragDrop` → `drop-files` 이벤트). 그러면
//! 화면(웹뷰)은 HTML5 `drop` 의 `File` 이 아니라 **경로 문자열**만 받는다.
//! 경로만으로는 내용을 못 읽으니 러스트가 읽어 줘야 한다.
//!
//! ## 🔴 아무 경로나 읽지 않는다
//!
//! `dropbox.rs` 와 같은 규칙: **사람이 방금 떨어뜨린 경로(파일 또는 폴더)와 그
//! 폴더 안**만 읽는다. 목록은 러스트가 들고 있고 화면은 넣을 수 없다.
//! - 폴더 안 상대 경로는 `..`·절대 경로·숨김 칸·`\`·`:`·NUL 을 거절한다.
//! - 바로가기(심볼릭 링크)는 따라가지 않는다(폴더 밖 `wallet.dat` 을 가리킬 수 있다).
//! - 정규화한 실제 경로가 떨어뜨린 폴더 안인지 한 번 더 본다.
//! - 개수·깊이·크기 상한을 둔다.
//!
//! 읽기만 한다 — 올리기(IPFS)·서명·발행은 화면이 기존 명령(`ipfs_add_file`·`sign_message`·`issue_asset`)으로 한다.

use serde_json::{json, Value};
use std::path::{Path, PathBuf};

/// 한 번에 나열할 최대 파일 수(게임 묶음 상한 2000 과 같다 — core/creator/limits.ts).
const LIST_MAX_FILES: usize = 2000;
/// 폴더 깊이 상한.
const LIST_MAX_DEPTH: usize = 8;
/// 파일 하나 최대 크기(음악 파일 상한 200MB — core/creator/limits.ts).
const READ_MAX_BYTES: u64 = 200 * 1024 * 1024;
/// 붙여 넣은 CID 를 읽을 때 상한.
const CID_MAX_BYTES: u64 = 25 * 1024 * 1024;
const IPFS_API: &str = "http://127.0.0.1:5001/api/v0";

/// 사람이 고르는 일이 없는 OS 찌꺼기 — 조용히 뺀다.
fn is_junk(name: &str) -> bool {
    name.starts_with('.')
        || name.eq_ignore_ascii_case("Thumbs.db")
        || name.eq_ignore_ascii_case("desktop.ini")
        || name == "__MACOSX"
}

/// 폴더 안 상대 경로가 안전한가(`a/b.png` 모양만).
fn safe_rel(rel: &str) -> bool {
    !rel.is_empty()
        && rel.len() <= 1024
        && !rel.starts_with('/')
        && !rel.contains(['\\', ':', '\0'])
        && rel.split('/').all(|seg| !seg.is_empty() && seg != "." && seg != ".." && !seg.starts_with('.'))
}

fn walk(root: &Path, dir: &Path, depth: usize, out: &mut Vec<Value>, skipped: &mut usize) -> Result<(), String> {
    if depth > LIST_MAX_DEPTH {
        *skipped += 1;
        return Ok(());
    }
    let mut entries: Vec<_> = std::fs::read_dir(dir).map_err(|_| "폴더를 읽지 못했어요.")?.flatten().collect();
    entries.sort_by_key(|e| e.file_name());
    for e in entries {
        let name = e.file_name().to_string_lossy().to_string();
        if is_junk(&name) {
            continue;
        }
        let Ok(ft) = e.file_type() else { continue };
        if ft.is_symlink() {
            *skipped += 1;
            continue;
        }
        let path = e.path();
        if ft.is_dir() {
            walk(root, &path, depth + 1, out, skipped)?;
        } else if ft.is_file() {
            if out.len() >= LIST_MAX_FILES {
                return Err(format!("파일이 너무 많아요({LIST_MAX_FILES}개까지)."));
            }
            let rel = path
                .strip_prefix(root)
                .map_err(|_| "경로가 이상해요.")?
                .components()
                .map(|c| c.as_os_str().to_string_lossy().to_string())
                .collect::<Vec<_>>()
                .join("/");
            let size = e.metadata().map(|m| m.len()).unwrap_or(0);
            out.push(json!({ "rel": rel, "size": size }));
        }
    }
    Ok(())
}

/// 떨어뜨린 경로 하나의 목록. 파일이면 그 파일 하나(rel = ""), 폴더면 안의 파일 전부(상대 경로·크기). 내용은 안 읽는다.
#[tauri::command]
pub fn creator_dropped_list(path: String) -> Result<Value, String> {
    if !crate::dropbox::was_dropped(&path) {
        return Err("방금 창에 놓은 파일·폴더만 읽을 수 있어요.".into());
    }
    let p = Path::new(&path);
    let meta = std::fs::symlink_metadata(p).map_err(|_| "파일을 찾지 못했어요.")?;
    let name = p.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
    if meta.file_type().is_file() {
        return Ok(json!({ "folder": false, "name": name, "files": [{ "rel": "", "size": meta.len() }], "skipped": 0 }));
    }
    if !meta.file_type().is_dir() {
        return Err("파일이나 폴더가 아니에요(바로가기는 따라가지 않아요).".into());
    }
    let (mut files, mut skipped) = (Vec::new(), 0usize);
    walk(p, p, 0, &mut files, &mut skipped)?;
    Ok(json!({ "folder": true, "name": name, "files": files, "skipped": skipped }))
}

fn resolve_inside(root: &str, rel: &str) -> Result<PathBuf, String> {
    if !crate::dropbox::was_dropped(root) {
        return Err("방금 창에 놓은 파일·폴더만 읽을 수 있어요.".into());
    }
    let base = Path::new(root);
    if rel.is_empty() {
        return Ok(base.to_path_buf());
    }
    if !safe_rel(rel) {
        return Err("파일 경로가 올바르지 않아요.".into());
    }
    let joined = base.join(rel);
    // 중간 칸에 바로가기가 끼어 있으면 폴더 밖으로 나갈 수 있다 — 정규화해 다시 본다.
    let real_base = std::fs::canonicalize(base).map_err(|_| "폴더를 찾지 못했어요.")?;
    let real = std::fs::canonicalize(&joined).map_err(|_| "파일을 찾지 못했어요.")?;
    if !real.starts_with(&real_base) {
        return Err("놓은 폴더 밖의 파일은 읽지 않아요.".into());
    }
    Ok(joined)
}

/// 떨어뜨린 파일(rel = "") 또는 떨어뜨린 폴더 안 파일 하나의 내용(base64).
#[tauri::command]
pub fn creator_dropped_read(root: String, rel: String) -> Result<Value, String> {
    let path = resolve_inside(&root, &rel)?;
    let meta = std::fs::symlink_metadata(&path).map_err(|_| "파일을 찾지 못했어요.")?;
    if !meta.file_type().is_file() {
        return Err("파일이 아니에요(바로가기는 따라가지 않아요).".into());
    }
    if meta.len() > READ_MAX_BYTES {
        return Err(format!("파일이 너무 커요({}MB 까지).", READ_MAX_BYTES / 1024 / 1024));
    }
    let bytes = std::fs::read(&path).map_err(|_| "파일을 읽지 못했어요.")?;
    Ok(json!({ "size": bytes.len(), "data": crate::cert_assets::b64_encode(&bytes) }))
}

/// 붙여 넣은 CID(CIDv0)의 내용을 이 컴퓨터의 IPFS 에서 읽는다(상한 25MB). 못 받으면 오류 — 화면은 그 CID 를 거절한다.
#[tauri::command]
pub async fn creator_cid_read(cid: String, max_bytes: Option<u64>) -> Result<Value, String> {
    let cid = cid.trim().to_string();
    if !(cid.len() == 46 && cid.starts_with("Qm") && cid.bytes().all(|b| b.is_ascii_alphanumeric())) {
        return Err("CID 모양이 아니에요(Qm… 46자).".into());
    }
    let max = max_bytes.unwrap_or(CID_MAX_BYTES).clamp(1, CID_MAX_BYTES);
    let r = reqwest::Client::new()
        .post(format!("{IPFS_API}/cat?arg={cid}&length={}", max + 1))
        .timeout(std::time::Duration::from_secs(30))
        .send()
        .await
        .map_err(|_| "IPFS 에 닿지 못했어요. IPFS 가 켜져 있는지 확인해 주세요.")?;
    if !r.status().is_success() {
        return Err("이 CID 를 지금 받을 수 없어요.".into());
    }
    let bytes = r.bytes().await.map_err(|_| "받는 중에 끊겼어요.")?;
    if bytes.len() as u64 > max {
        return Err(format!("너무 커요({}MB 까지).", max / 1024 / 1024));
    }
    Ok(json!({ "size": bytes.len(), "data": crate::cert_assets::b64_encode(&bytes) }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 상대_경로는_폴더_안만() {
        assert!(safe_rel("img/a.png"));
        assert!(safe_rel("index.html"));
        for bad in ["", "/etc/passwd", "../wallet.dat", "a/../../b", "a/.hidden", "C:x.jpg", "a\\b", "a//b", "./a"] {
            assert!(!safe_rel(bad), "{bad}");
        }
    }

    #[test]
    fn 떨어뜨리지_않은_것은_안_읽는다() {
        assert!(creator_dropped_list("/Users/x/Library/Application Support/Raven/wallet.dat".into()).is_err());
        assert!(creator_dropped_read("/Users/x/Library".into(), "Raven/wallet.dat".into()).is_err());
    }

    #[test]
    fn 폴더_목록과_읽기() {
        let dir = std::env::temp_dir().join(format!("rv-drop-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("img")).unwrap();
        std::fs::write(dir.join("index.html"), b"<!doctype html>").unwrap();
        std::fs::write(dir.join("img/a.png"), b"png").unwrap();
        std::fs::write(dir.join(".DS_Store"), b"x").unwrap();
        let root = dir.to_string_lossy().to_string();
        crate::dropbox::remember(&[root.clone()]);
        let v = creator_dropped_list(root.clone()).unwrap();
        let rels: Vec<String> = v["files"].as_array().unwrap().iter().map(|f| f["rel"].as_str().unwrap().to_string()).collect();
        assert_eq!(rels, vec!["img/a.png".to_string(), "index.html".to_string()]);
        let r = creator_dropped_read(root.clone(), "index.html".into()).unwrap();
        assert_eq!(r["size"], 15);
        assert!(creator_dropped_read(root.clone(), "../x".into()).is_err());
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink("/etc", dir.join("link")).unwrap();
            assert!(creator_dropped_read(root.clone(), "link/hosts".into()).is_err(), "링크를 따라 폴더 밖으로 나가면 안 된다");
        }
        let _ = std::fs::remove_dir_all(&dir);
    }
}
