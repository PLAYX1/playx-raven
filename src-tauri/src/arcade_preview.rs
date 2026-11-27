//! 11-27 「라비가 다 해 줄게요」 — 고른 게임 폴더를 **이 컴퓨터 안에서만** 미리 돌려 표지·미리보기 영상을 뜬다.
//!
//! 🔴 왜 server.rs(8790)가 아니라 따로인가: 8790 은 0.0.0.0 에 묶이고 터널이 통째로 넘겨받는다. 또 「지갑」 모드 컴퓨터는
//!    그 서버를 켜면 릴레이·자동 일까지 같이 켜진다. 미리보기는 127.0.0.1 에만 묶인 작은 서버 하나로 끝낸다 — 바깥에서 닿을 길이 없다.
//! 🔴 게임 파일은 남이 만든 코드다. 앱 창(지갑) 출처에서 돌리지 않는다: 화면은 `<iframe sandbox="allow-scripts">`(같은 출처 권한 없음)로만 열고,
//!    여기 답에는 CSP(이 열쇠 길 밖으로 연결·그림·스크립트 없음 + `sandbox allow-scripts`)를 붙인다.
//! 🔴 길 = `/arcade-preview/<열쇠>/<경로>`. 열쇠는 폴더를 고를 때마다 새로 만든다(arcade_upload.rs). 경로 규칙은 scan_dir 과 같다(safe_path · 링크 안 따라감).
//!    Host 머리가 정확히 `127.0.0.1:8791` 이 아니면 거절(DNS 리바인딩).
use axum::{extract::Path as AxPath, http::{HeaderMap, StatusCode}, response::{IntoResponse, Response}, routing::get, Router};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};

pub const PREVIEW_PORT: u16 = 8791;
pub const SHIM_NAME: &str = "__rv_capture.js";
const SHIM_JS: &str = include_str!("arcade_capture.js");
/// 미리보기로 내주는 파일 하나 상한(공유 사이트 4MB 보다 넉넉히 — 검사는 올리기 화면이 따로 한다).
const FILE_MAX: u64 = 64 * 1024 * 1024;
static STARTED: AtomicBool = AtomicBool::new(false);
static START_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

pub fn base_url(token: &str) -> String { format!("http://127.0.0.1:{PREVIEW_PORT}/arcade-preview/{token}/") }

pub async fn ensure_started() -> Result<(), String> {
    if STARTED.load(Ordering::Acquire) { return Ok(()); }
    let _g = START_LOCK.lock().await;
    if STARTED.load(Ordering::Acquire) { return Ok(()); }
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", PREVIEW_PORT)).await
        .map_err(|e| format!("미리보기 칸을 열지 못했어요({PREVIEW_PORT} 포트): {e}"))?;
    tokio::spawn(async move { let _ = axum::serve(listener, router()).await; });
    STARTED.store(true, Ordering::Release);
    Ok(())
}

pub fn router() -> Router {
    Router::new().route("/arcade-preview/{token}/{*path}", get(serve))
}

/// Host 가 정확히 하나 · `127.0.0.1:8791` · 프록시 머리 없음.
pub fn host_ok(headers: &HeaderMap) -> bool {
    let proxy = headers.keys().any(|h| { let h = h.as_str(); h.starts_with("x-forwarded-") || h.starts_with("cf-") || matches!(h, "forwarded" | "x-real-ip" | "via") });
    if proxy { return false; }
    let mut hosts = headers.get_all("host").iter();
    matches!((hosts.next(), hosts.next()), (Some(h), None) if h.to_str().ok() == Some(&format!("127.0.0.1:{PREVIEW_PORT}")))
}

/// 고른 폴더 안의 보통 파일만. safe_path(숨김·..·빈 칸 없음) + 가는 길의 모든 칸이 링크가 아니어야 한다.
pub fn resolve_file(root: &Path, rel: &str) -> Option<PathBuf> {
    if !crate::arcade_upload::safe_path(rel) { return None; }
    let mut cur = root.to_path_buf();
    for part in rel.split('/') {
        cur.push(part);
        let m = std::fs::symlink_metadata(&cur).ok()?;
        if m.file_type().is_symlink() { return None; }
    }
    let m = std::fs::symlink_metadata(&cur).ok()?;
    (m.is_file() && m.len() <= FILE_MAX).then_some(cur)
}

pub fn content_type(p: &str) -> &'static str {
    let l = p.to_ascii_lowercase();
    let ext = l.rsplit('.').next().unwrap_or("");
    match ext {
        "html" | "htm" => "text/html; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "json" => "application/json",
        "png" => "image/png", "jpg" | "jpeg" => "image/jpeg", "webp" => "image/webp", "gif" => "image/gif", "svg" => "image/svg+xml",
        "mp3" => "audio/mpeg", "ogg" => "audio/ogg", "wav" => "audio/wav", "m4a" => "audio/mp4",
        "mp4" => "video/mp4", "webm" => "video/webm",
        "woff2" => "font/woff2", "woff" => "font/woff", "ttf" => "font/ttf", "otf" => "font/otf",
        "wasm" => "application/wasm", "txt" => "text/plain; charset=utf-8",
        _ => "application/octet-stream",
    }
}

/// 게임 HTML 에 붙잡기 도우미를 하나 붙인다 — 게임 스크립트보다 먼저(그림 출처 고치기가 먼저 돌아야 한다):
/// `<head…>` 바로 뒤 → 없으면 `<body…>` 바로 뒤 → 없으면 `<!doctype…>` 뒤(그 앞에 넣으면 쿼크 모드가 된다) → 맨 앞.
pub fn inject_shim(html: &str, src: &str) -> String {
    let tag = format!("<script src=\"{src}\"></script>");
    let low = html.to_ascii_lowercase();
    let after_open = |name: &str| -> Option<usize> {
        let mut from = 0;
        while let Some(i) = low[from..].find(name).map(|i| i + from) {
            let next = low.as_bytes().get(i + name.len()).copied();
            if matches!(next, Some(b'>') | Some(b' ') | Some(b'\t') | Some(b'\n') | Some(b'\r') | Some(b'/')) {
                return low[i..].find('>').map(|j| i + j + 1);
            }
            from = i + name.len();
        }
        None
    };
    let at = after_open("<head").or_else(|| after_open("<body")).or_else(|| after_open("<!doctype")).unwrap_or(0);
    format!("{}{}{}", &html[..at], tag, &html[at..])
}

/// CORS `*`: sandbox iframe(불투명 출처)이 자기 그림을 crossOrigin 으로 받아야 캔버스가 깨끗하다. 열쇠(192비트)를 아는 곳만 닿는다.
/// 이 열쇠 길 밖으로는 아무것도 못 나간다. 문서 자체도 sandbox(앱 창이 아닌 곳에서 열려도 불투명 출처).
pub fn csp(base: &str) -> String {
    format!("default-src 'none'; script-src {base}; style-src {base} 'unsafe-inline'; img-src {base} data: blob:; media-src {base} data: blob:; \
font-src {base} data:; connect-src {base}; worker-src {base} blob:; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; sandbox allow-scripts")
}

/// 한 요청의 답(시험 가능 — 폴더를 직접 받는다).
pub fn answer(root: &Path, token: &str, rel: &str) -> Response {
    let base = base_url(token);
    let send = |ct: &str, body: Vec<u8>| -> Response {
        ([("content-type", ct.to_string()), ("content-security-policy", csp(&base)), ("x-content-type-options", "nosniff".into()),
          // 11-27 CORS 는 * 가 아니라 "null" 만(네온) — 읽는 쪽은 sandbox iframe(불투명 출처 = null)뿐이다. 진짜 출처를 가진 웹 페이지는 못 읽는다.
          ("cache-control", "no-store".into()), ("referrer-policy", "no-referrer".into()), ("access-control-allow-origin", "null".into())], body).into_response()
    };
    if rel == SHIM_NAME { return send("text/javascript; charset=utf-8", SHIM_JS.as_bytes().to_vec()); }
    let Some(file) = resolve_file(root, rel) else { return (StatusCode::NOT_FOUND, "").into_response() };
    let Ok(bytes) = std::fs::read(&file) else { return (StatusCode::NOT_FOUND, "").into_response() };
    let ct = content_type(rel);
    if ct.starts_with("text/html") {
        let html = String::from_utf8_lossy(&bytes);
        return send(ct, inject_shim(&html, &format!("{base}{SHIM_NAME}")).into_bytes());
    }
    send(ct, bytes)
}

async fn serve(AxPath((token, path)): AxPath<(String, String)>, headers: HeaderMap) -> Response {
    if !host_ok(&headers) { return (StatusCode::FORBIDDEN, "").into_response(); }
    let Some(root) = crate::arcade_upload::preview_root(&token) else { return (StatusCode::NOT_FOUND, "").into_response() };
    tokio::task::spawn_blocking(move || answer(&root, &token, &path)).await.unwrap_or_else(|_| (StatusCode::INTERNAL_SERVER_ERROR, "").into_response())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn h(pairs: &[(&str, &str)]) -> HeaderMap {
        let mut m = HeaderMap::new();
        for (k, v) in pairs { m.append(axum::http::HeaderName::from_bytes(k.as_bytes()).unwrap(), v.parse().unwrap()); }
        m
    }

    #[test]
    fn host_는_127_0_0_1_8791_하나만() {
        assert!(host_ok(&h(&[("host", "127.0.0.1:8791")])));
        for bad in [vec![], vec![("host", "localhost:8791")], vec![("host", "127.0.0.1:8790")], vec![("host", "evil.example")],
            vec![("host", "127.0.0.1:8791"), ("host", "127.0.0.1:8791")], vec![("host", "127.0.0.1:8791"), ("x-forwarded-for", "1.2.3.4")],
            vec![("host", "127.0.0.1:8791"), ("cf-connecting-ip", "1.2.3.4")]] {
            assert!(!host_ok(&h(&bad)), "{bad:?}");
        }
    }

    #[test]
    fn 경로는_고른_폴더_안_보통_파일만() {
        let base = std::env::temp_dir().join(format!("rv-arcade-preview-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(base.join("js")).unwrap();
        std::fs::write(base.join("index.html"), b"<html><body><canvas></canvas></body></html>").unwrap();
        std::fs::write(base.join("js/a.js"), b"1").unwrap();
        std::fs::write(base.join(".secret"), b"x").unwrap();
        let outside = std::env::temp_dir().join(format!("rv-arcade-preview-out-{}", std::process::id()));
        std::fs::write(&outside, b"wallet").unwrap();
        #[cfg(unix)]
        { let _ = std::os::unix::fs::symlink(&outside, base.join("link.js")); let _ = std::os::unix::fs::symlink(std::env::temp_dir(), base.join("dir")); }
        assert!(resolve_file(&base, "index.html").is_some());
        assert!(resolve_file(&base, "js/a.js").is_some());
        for bad in ["", "../x", "js/../index.html", ".secret", "/etc/passwd", "js", "missing.js", "a//b", "link.js", "dir/x"] {
            assert!(resolve_file(&base, bad).is_none(), "{bad}");
        }
        // 답: HTML 에는 도우미가 붙고, 모든 답에 CSP(sandbox) 가 붙는다.
        let tok = "ab".repeat(24);
        let r = answer(&base, &tok, "index.html");
        assert_eq!(r.status(), StatusCode::OK);
        let c = r.headers().get("content-security-policy").unwrap().to_str().unwrap().to_string();
        assert!(c.contains("sandbox allow-scripts") && c.contains(&format!("script-src {}", base_url(&tok))) && c.contains("connect-src http://127.0.0.1:8791/arcade-preview/"));
        assert!(!c.contains("'unsafe-eval'") && !c.contains("script-src 'self'"));
        assert_eq!(answer(&base, &tok, "../x").status(), StatusCode::NOT_FOUND);
        assert_eq!(answer(&base, &tok, "link.js").status(), StatusCode::NOT_FOUND);
        assert_eq!(answer(&base, &tok, SHIM_NAME).status(), StatusCode::OK);
        let _ = std::fs::remove_dir_all(&base);
        let _ = std::fs::remove_file(&outside);
    }

    #[test]
    fn 도우미는_게임_스크립트보다_먼저() {
        let s = "/arcade-preview/t/__rv_capture.js";
        let t = format!("<script src=\"{s}\"></script>");
        assert_eq!(inject_shim("<!doctype html><HTML><Head lang=x><title>a</title><header>", s), format!("<!doctype html><HTML><Head lang=x>{t}<title>a</title><header>"));
        assert_eq!(inject_shim("<!doctype html><header></header><body class=a><canvas>", s), format!("<!doctype html><header></header><body class=a>{t}<canvas>"));
        assert_eq!(inject_shim("<!DOCTYPE html><canvas>", s), format!("<!DOCTYPE html>{t}<canvas>"));
        assert_eq!(inject_shim("<canvas>", s), format!("{t}<canvas>"));
        assert_eq!(content_type("A.JS"), "text/javascript; charset=utf-8");
        assert_eq!(content_type("x.bin"), "application/octet-stream");
    }
}
