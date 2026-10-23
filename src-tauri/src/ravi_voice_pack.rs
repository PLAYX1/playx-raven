//! 라비 목소리 모델 **받기** — 설치 파일에는 모델이 없고, 사용자가 동의하면 앱이 처음 한 번 받아 둔다.
//!
//! 두는 곳: `paths::app_dir()/ravi-voice/` (RavenVault 폴더 이전 규칙을 그대로 따른다).
//! 받는 파일: 모델 manifest.json(설치 파일에 들어 있는 작은 파일)에 적힌 크기·sha256 과 **둘 다 맞아야** 확정한다.
//!   - `<이름>.part` 에 받는다 → 크기·sha256 통과 후에만 이름을 바꿔 확정 → 틀리면 지운다.
//!   - 확정 전 파일은 아무도 읽지 않는다(앱을 끄거나 다시 켜도 안전). 끊기면 같은 `.part` 를 이어받는다(HTTP Range, 안 되면 처음부터).
//!   - 받기 전에 디스크 여유(필요한 양 × 1.5)를 보고, 모자라면 시작하지 않는다.
//!   - 주소는 https 만. 리다이렉트(CDN)는 따라가되 https 가 아니면 거부한다.
//! 화면(웹뷰 CSP)은 건드리지 않는다 — 받기는 전부 Rust(reqwest)가 한다.
use crate::ravi_tts::{missing_in, pack_dir, FILES};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

const MANIFEST: &str = include_str!("../resources/ravi-voice/manifest.json");
/// 모델 받는 곳(고정 리비전 → 파일이 바뀌어도 해시가 맞는다). 이 주소는 라비 목소리 받기에만 쓴다.
pub const HOST_BASE: &str = "https://huggingface.co/supertone-oss-archive/supertonic-3/resolve";
const ATTEMPTS: u32 = 3;
const READ_TIMEOUT: Duration = Duration::from_secs(40);

#[derive(Clone, Debug, PartialEq)]
pub struct Item { pub path: String, pub size: u64, pub sha: String }

#[derive(Debug, PartialEq)]
pub enum DlError {
    NoSpace { need: u64, have: u64 },
    Cancelled,
    Network,
    Mismatch(String),
    Insecure,
    Io,
}
impl DlError {
    pub fn reason(&self) -> &'static str {
        match self { DlError::NoSpace { .. } => "nospace", DlError::Cancelled => "cancelled", DlError::Network => "network", DlError::Mismatch(_) => "mismatch", DlError::Insecure => "insecure", DlError::Io => "io" }
    }
}

/// 연결 규칙. 실제 앱은 둘 다 true. 시험만 가짜 로컬 서버(http)를 위해 끈다.
#[derive(Clone, Copy)]
pub struct Net { pub https_initial: bool, pub https_redirects: bool, pub retry_ms: u64 }
pub const NET_STRICT: Net = Net { https_initial: true, https_redirects: true, retry_ms: 1500 };

/// 순수: manifest 에서 모델에 꼭 필요한 파일(FILES 의 8개)만 뽑는다. 크기가 코드와 다르면 오류(어긋남을 일찍 잡는다).
pub fn items_from_manifest(json_text: &str) -> Result<(String, Vec<Item>), String> {
    let v: Value = serde_json::from_str(json_text).map_err(|_| "manifest")?;
    let rev = v["sourceRevision"].as_str().filter(|r| r.len() >= 7 && r.chars().all(|c| c.is_ascii_hexdigit())).ok_or("revision")?.to_string();
    let files = v["files"].as_array().ok_or("files")?;
    let mut out = Vec::new();
    for (_, rel, size) in FILES.iter() {
        let f = files.iter().find(|f| f["path"] == *rel).ok_or("missing-in-manifest")?;
        let sha = f["sha256"].as_str().filter(|s| s.len() == 64).ok_or("sha")?.to_string();
        if f["size"].as_u64() != Some(*size) { return Err("size-differs".into()); }
        out.push(Item { path: rel.to_string(), size: *size, sha });
    }
    Ok((rev, out))
}
pub fn bundled_items() -> Result<(String, Vec<Item>), String> { items_from_manifest(MANIFEST) }

pub fn url_for(base: &str, revision: &str, path: &str) -> String { format!("{}/{}/{}", base.trim_end_matches('/'), revision, path) }

fn part_path(dest: &Path) -> PathBuf { let mut s = dest.as_os_str().to_owned(); s.push(".part"); PathBuf::from(s) }

fn sha_of_file(p: &Path) -> Option<(String, u64)> {
    let mut f = std::fs::File::open(p).ok()?;
    let (mut h, mut buf, mut n) = (Sha256::new(), vec![0u8; 1 << 20], 0u64);
    loop { let k = f.read(&mut buf).ok()?; if k == 0 { break; } h.update(&buf[..k]); n += k as u64; }
    Some((format!("{:x}", h.finalize()), n))
}

/// 이미 확정된 파일인가(크기·sha256 모두 맞음).
fn is_final(dest: &Path, it: &Item) -> bool {
    std::fs::metadata(dest).map(|m| m.is_file() && m.len() == it.size).unwrap_or(false) && sha_of_file(dest).map(|(s, _)| s == it.sha).unwrap_or(false)
}

/// 앞으로 더 받아야 할 바이트(확정된 건 빼고, 이어받을 `.part` 는 그만큼 뺀다).
pub fn bytes_needed(root: &Path, items: &[Item]) -> u64 {
    items.iter().map(|it| {
        let dest = root.join(&it.path);
        if std::fs::metadata(&dest).map(|m| m.len() == it.size).unwrap_or(false) { return 0; } // 크기 맞는 확정본(해시는 받을 때 다시 본다)
        let have = std::fs::metadata(part_path(&dest)).map(|m| m.len()).unwrap_or(0).min(it.size);
        it.size - have
    }).sum()
}

/// 디스크 여유(바이트). 못 재면 None → 막지 않는다(쓰다가 실패하면 그때 알린다).
pub fn free_bytes(p: &Path) -> Option<u64> {
    #[cfg(unix)]
    {
        use std::os::unix::ffi::OsStrExt;
        let c = std::ffi::CString::new(p.as_os_str().as_bytes()).ok()?;
        let mut s: libc::statvfs = unsafe { std::mem::zeroed() };
        if unsafe { libc::statvfs(c.as_ptr(), &mut s) } != 0 { return None; }
        Some((s.f_bavail as u64).saturating_mul(s.f_frsize as u64))
    }
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        let w: Vec<u16> = p.as_os_str().encode_wide().chain(std::iter::once(0)).collect();
        let mut free: u64 = 0;
        let ok = unsafe { windows_sys::Win32::Storage::FileSystem::GetDiskFreeSpaceExW(w.as_ptr(), &mut free, std::ptr::null_mut(), std::ptr::null_mut()) };
        if ok != 0 { Some(free) } else { None }
    }
    #[cfg(not(any(unix, windows)))]
    { let _ = p; None }
}

/// 필요×1.5 가 여유보다 크면 거부.
pub fn check_space(root: &Path, items: &[Item], free: &(dyn Fn(&Path) -> Option<u64> + Sync)) -> Result<(), DlError> {
    let need = bytes_needed(root, items).saturating_mul(3) / 2;
    if need == 0 { return Ok(()); }
    let _ = std::fs::create_dir_all(root);
    match free(root) { Some(have) if have < need => Err(DlError::NoSpace { need, have }), _ => Ok(()) }
}

fn client(net: Net) -> Result<reqwest::Client, DlError> {
    let https = net.https_redirects;
    let policy = reqwest::redirect::Policy::custom(move |a| {
        if https && a.url().scheme() != "https" { a.error("insecure-redirect") } else if a.previous().len() >= 5 { a.stop() } else { a.follow() }
    });
    reqwest::Client::builder().redirect(policy).connect_timeout(Duration::from_secs(20)).user_agent("RavenVault-Desktop").build().map_err(|_| DlError::Network)
}
fn map_req_err(e: &reqwest::Error) -> DlError { if e.is_redirect() { DlError::Insecure } else { DlError::Network } }

/// 한 번 시도. `.part` 가 있으면 이어받는다. 성공하면 확정(이름 바꿈)까지 마친다.
async fn try_once(c: &reqwest::Client, url: &str, dest: &Path, it: &Item, cancel: &AtomicBool, on_bytes: &mut (dyn FnMut(u64) + Send)) -> Result<(), DlError> {
    let part = part_path(dest);
    let mut have = std::fs::metadata(&part).map(|m| m.len()).unwrap_or(0);
    if have > it.size { let _ = std::fs::remove_file(&part); have = 0; }
    let mut hasher = Sha256::new();
    if have > 0 {
        let p = part.clone();
        let prev = tokio::task::spawn_blocking(move || { let mut f = std::fs::File::open(&p).ok()?; let (mut h, mut b) = (Sha256::new(), vec![0u8; 1 << 20]); loop { let k = f.read(&mut b).ok()?; if k == 0 { break; } h.update(&b[..k]); } Some(h) }).await.map_err(|_| DlError::Io)?;
        match prev { Some(h) => hasher = h, None => { let _ = std::fs::remove_file(&part); have = 0; } }
    }
    let mut req = c.get(url);
    if have > 0 { req = req.header(reqwest::header::RANGE, format!("bytes={have}-")); }
    let mut resp = req.send().await.map_err(|e| map_req_err(&e))?;
    let status = resp.status().as_u16();
    let append = match status {
        206 if have > 0 => true,
        200 => { have = 0; hasher = Sha256::new(); false }
        416 => { let _ = std::fs::remove_file(&part); return Err(DlError::Network); }
        _ => return Err(DlError::Network),
    };
    let mut f = std::fs::OpenOptions::new().create(true).write(true).append(append).truncate(!append).open(&part).map_err(|_| DlError::Io)?;
    on_bytes(have);
    loop {
        if cancel.load(Ordering::SeqCst) { drop(f); let _ = std::fs::remove_file(&part); return Err(DlError::Cancelled); }
        let chunk = match tokio::time::timeout(READ_TIMEOUT, resp.chunk()).await {
            Ok(Ok(Some(b))) => b,
            Ok(Ok(None)) => break,
            Ok(Err(_)) | Err(_) => return Err(DlError::Network), // 끊김: .part 를 남겨 이어받는다
        };
        have += chunk.len() as u64;
        if have > it.size { drop(f); let _ = std::fs::remove_file(&part); return Err(DlError::Mismatch(it.path.clone())); } // 너무 큼
        f.write_all(&chunk).map_err(|_| DlError::Io)?;
        hasher.update(&chunk);
        on_bytes(have);
    }
    f.sync_all().map_err(|_| DlError::Io)?; drop(f);
    if have != it.size || format!("{:x}", hasher.finalize()) != it.sha { let _ = std::fs::remove_file(&part); return Err(DlError::Mismatch(it.path.clone())); }
    std::fs::rename(&part, dest).map_err(|_| DlError::Io)?; // 여기서만 확정
    Ok(())
}

/// 파일 하나: 이미 맞으면 건너뛰고, 아니면 최대 3번(끊김·불일치는 다시).
async fn fetch_file(c: &reqwest::Client, net: Net, url: &str, dest: &Path, it: &Item, cancel: &AtomicBool, on_bytes: &mut (dyn FnMut(u64) + Send)) -> Result<(), DlError> {
    if let Some(dir) = dest.parent() { std::fs::create_dir_all(dir).map_err(|_| DlError::Io)?; }
    if is_final(dest, it) { on_bytes(it.size); return Ok(()); }
    let _ = std::fs::remove_file(dest); // 크기·해시가 틀린 확정본 찌꺼기
    let mut last = DlError::Network;
    for attempt in 0..ATTEMPTS {
        if cancel.load(Ordering::SeqCst) { return Err(DlError::Cancelled); }
        match try_once(c, url, dest, it, cancel, on_bytes).await {
            Ok(()) => return Ok(()),
            Err(e @ (DlError::Cancelled | DlError::Insecure | DlError::Io)) => return Err(e),
            Err(e) => { last = e; if attempt + 1 < ATTEMPTS { tokio::time::sleep(Duration::from_millis(net.retry_ms)).await; } }
        }
    }
    Err(last)
}

/// 전부 받기. `progress(받은 바이트, 전체 바이트)`.
pub async fn download_all(base: &str, revision: &str, items: &[Item], root: &Path, net: Net, cancel: &AtomicBool, free: &(dyn Fn(&Path) -> Option<u64> + Sync), progress: &mut (dyn FnMut(u64, u64) + Send)) -> Result<(), DlError> {
    if net.https_initial && !base.starts_with("https://") { return Err(DlError::Insecure); }
    check_space(root, items, free)?;
    let c = client(net)?;
    let total: u64 = items.iter().map(|i| i.size).sum();
    let mut before = 0u64;
    progress(0, total);
    for it in items {
        let url = url_for(base, revision, &it.path);
        let b = before;
        fetch_file(&c, net, &url, &root.join(&it.path), it, cancel, &mut |n| progress(b + n, total)).await?;
        before += it.size;
    }
    Ok(())
}

// ── 명령 ──
struct Run { cancel: Arc<AtomicBool>, done: AtomicU64, total: u64 }
static RUN: Mutex<Option<Arc<Run>>> = Mutex::new(None);
static LAST: Mutex<Option<Value>> = Mutex::new(None);

fn status_json(app_ok: bool) -> Value {
    let run = RUN.lock().ok().and_then(|g| g.clone());
    let dir = pack_dir();
    let total = bundled_items().map(|(_, v)| v.iter().map(|i| i.size).sum::<u64>()).unwrap_or(0);
    json!({
        "installed": app_ok,
        "removable": dir.exists() && std::fs::read_dir(&dir).map(|mut d| d.next().is_some()).unwrap_or(false),
        "downloading": run.is_some(),
        "done": run.as_ref().map(|r| r.done.load(Ordering::SeqCst)).unwrap_or(0),
        "total": run.as_ref().map(|r| r.total).unwrap_or(total),
        "last": LAST.lock().ok().and_then(|g| g.clone()),
    })
}

#[tauri::command]
pub async fn ravi_voice_pack_status(app: tauri::AppHandle) -> Value { status_json(crate::ravi_tts::is_installed(&app)) }

#[tauri::command]
pub async fn ravi_voice_download(app: tauri::AppHandle) -> Value {
    use tauri::Emitter;
    if crate::ravi_tts::is_installed(&app) { return json!({ "ok": true, "already": true }); }
    let (rev, items) = match bundled_items() { Ok(x) => x, Err(_) => return json!({ "ok": false, "reason": "manifest" }) };
    let root = pack_dir();
    let total: u64 = items.iter().map(|i| i.size).sum();
    let run = Arc::new(Run { cancel: Arc::new(AtomicBool::new(false)), done: AtomicU64::new(0), total });
    {
        let mut g = RUN.lock().unwrap_or_else(|e| e.into_inner());
        if g.is_some() { return json!({ "ok": false, "reason": "busy" }); }
        // 시작 전에 여유를 본다 → 모자라면 시작하지 않고 바로 알린다.
        if let Err(DlError::NoSpace { need, have }) = check_space(&root, &items, &free_bytes) {
            return json!({ "ok": false, "reason": "nospace", "needMb": need / 1_048_576, "haveMb": have / 1_048_576 });
        }
        *g = Some(run.clone());
    }
    *LAST.lock().unwrap_or_else(|e| e.into_inner()) = None;
    tauri::async_runtime::spawn(async move {
        let mut last_emit = std::time::Instant::now();
        let r = download_all(HOST_BASE, &rev, &items, &root, NET_STRICT, &run.cancel, &free_bytes, &mut |d, t| {
            run.done.store(d, Ordering::SeqCst);
            if last_emit.elapsed() > Duration::from_millis(300) || d == t { last_emit = std::time::Instant::now(); let _ = app.emit("ravi-voice-progress", json!({ "done": d, "total": t })); }
        }).await;
        // 마지막 확인: 쓰는 쪽(ravi_tts)이 보는 기준(8개 모두 크기 일치)과 같은 눈으로 한 번 더.
        let r = r.and_then(|_| if missing_in(&root).is_empty() { Ok(()) } else { Err(DlError::Mismatch("final".into())) });
        let out = match &r {
            Ok(()) => json!({ "ok": true }),
            Err(DlError::NoSpace { need, have }) => json!({ "ok": false, "reason": "nospace", "needMb": need / 1_048_576, "haveMb": have / 1_048_576 }),
            Err(e) => json!({ "ok": false, "reason": e.reason() }),
        };
        *LAST.lock().unwrap_or_else(|e| e.into_inner()) = Some(out.clone());
        *RUN.lock().unwrap_or_else(|e| e.into_inner()) = None;
        let _ = app.emit("ravi-voice-done", out);
    });
    json!({ "ok": true, "started": true })
}

#[tauri::command]
pub async fn ravi_voice_cancel() -> Value {
    match RUN.lock().ok().and_then(|g| g.clone()) { Some(r) => { r.cancel.store(true, Ordering::SeqCst); json!({ "ok": true }) } None => json!({ "ok": true, "idle": true }) }
}

/// 받은 모델 지우기(앱 자료 폴더의 `ravi-voice/` 만). 받는 중이면 거부.
#[tauri::command]
pub async fn ravi_voice_remove() -> Value {
    if RUN.lock().map(|g| g.is_some()).unwrap_or(false) { return json!({ "ok": false, "reason": "busy" }); }
    let dir = pack_dir();
    let r = if dir.exists() { std::fs::remove_dir_all(&dir) } else { Ok(()) };
    *LAST.lock().unwrap_or_else(|e| e.into_inner()) = None;
    match r { Ok(()) => json!({ "ok": true }), Err(_) => json!({ "ok": false, "reason": "io" }) }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    enum Reply { Body(Vec<u8>), Redirect(String), DropAfter(Vec<u8>, usize), Status(u16) }
    type Handler = Arc<dyn Fn(&str, usize) -> Reply + Send + Sync>;

    /// 가짜 로컬 서버. (경로, 그 경로를 몇 번째로 받았는지) → 답. Range 를 알아듣는다.
    async fn serve(handler: Handler) -> String {
        let l = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = l.local_addr().unwrap();
        let counts = Arc::new(Mutex::new(std::collections::HashMap::<String, usize>::new()));
        tokio::spawn(async move {
            loop {
                let (mut s, _) = match l.accept().await { Ok(x) => x, Err(_) => return };
                let (h, counts) = (handler.clone(), counts.clone());
                tokio::spawn(async move {
                    let mut buf = vec![0u8; 8192]; let n = s.read(&mut buf).await.unwrap_or(0);
                    let req = String::from_utf8_lossy(&buf[..n]).to_string();
                    let path = req.split_whitespace().nth(1).unwrap_or("/").to_string();
                    let range = req.lines().find_map(|l| l.to_ascii_lowercase().strip_prefix("range: bytes=").map(|r| r.trim_end_matches('-').trim().parse::<usize>().unwrap_or(0)));
                    let nth = { let mut c = counts.lock().unwrap(); let e = c.entry(path.clone()).or_insert(0); *e += 1; *e };
                    match h(&path, nth) {
                        Reply::Redirect(to) => { let _ = s.write_all(format!("HTTP/1.1 302 Found\r\nLocation: {to}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").as_bytes()).await; }
                        Reply::Status(c) => { let _ = s.write_all(format!("HTTP/1.1 {c} X\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").as_bytes()).await; }
                        Reply::Body(b) => match range {
                            Some(from) if from > 0 && from < b.len() => { let part = &b[from..]; let _ = s.write_all(format!("HTTP/1.1 206 Partial Content\r\nContent-Range: bytes {from}-{}/{}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", b.len() - 1, b.len(), part.len()).as_bytes()).await; let _ = s.write_all(part).await; }
                            _ => { let _ = s.write_all(format!("HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", b.len()).as_bytes()).await; let _ = s.write_all(&b).await; }
                        },
                        Reply::DropAfter(b, k) => { let _ = s.write_all(format!("HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", b.len()).as_bytes()).await; let _ = s.write_all(&b[..k]).await; let _ = s.flush().await; } // 약속한 길이보다 먼저 끊는다
                    }
                    let _ = s.shutdown().await;
                });
            }
        });
        format!("http://{addr}")
    }
    fn sha(b: &[u8]) -> String { format!("{:x}", Sha256::digest(b)) }
    fn item(path: &str, b: &[u8]) -> Item { Item { path: path.into(), size: b.len() as u64, sha: sha(b) } }
    fn tmp(name: &str) -> PathBuf { let d = std::env::temp_dir().join(format!("rv-pack-{}-{}", std::process::id(), name)); let _ = std::fs::remove_dir_all(&d); d }
    const LOOSE: Net = Net { https_initial: false, https_redirects: false, retry_ms: 0 };
    fn plenty(_: &Path) -> Option<u64> { Some(u64::MAX / 4) }
    fn body(n: usize, seed: u8) -> Vec<u8> { (0..n).map(|i| (i as u8).wrapping_mul(7).wrapping_add(seed)).collect() }

    #[test]
    fn manifest_matches_code_and_is_the_pinned_revision() {
        let (rev, items) = bundled_items().expect("manifest 이 코드의 파일 목록과 같다");
        assert_eq!(rev.len(), 40); assert_eq!(items.len(), FILES.len());
        assert!(items.iter().all(|i| i.sha.len() == 64));
        assert_eq!(url_for(HOST_BASE, &rev, "onnx/tts.json"), format!("https://huggingface.co/supertone-oss-archive/supertonic-3/resolve/{rev}/onnx/tts.json"));
        assert!(HOST_BASE.starts_with("https://"));
        let total: u64 = items.iter().map(|i| i.size).sum(); assert!(total > 390_000_000 && total < 410_000_000, "{total}");
    }

    #[tokio::test]
    async fn downloads_verifies_and_finalizes() {
        let (a, b) = (body(300_000, 1), body(1234, 2));
        let (ac, bc) = (a.clone(), b.clone());
        let base = serve(Arc::new(move |p, _| match p { p if p.ends_with("/a.bin") => Reply::Body(ac.clone()), p if p.ends_with("/sub/b.json") => Reply::Body(bc.clone()), _ => Reply::Status(404) })).await;
        let root = tmp("ok"); let items = vec![item("a.bin", &a), item("sub/b.json", &b)];
        let mut last = (0, 0);
        download_all(&base, "rev", &items, &root, LOOSE, &AtomicBool::new(false), &plenty, &mut |d, t| last = (d, t)).await.unwrap();
        assert_eq!(last, (301_234, 301_234));
        assert_eq!(std::fs::read(root.join("a.bin")).unwrap(), a); assert_eq!(std::fs::read(root.join("sub/b.json")).unwrap(), b);
        assert!(!root.join("a.bin.part").exists(), "확정 뒤에는 .part 가 남지 않는다");
        // 두 번째 실행은 아무것도 다시 받지 않는다(서버가 404 만 줘도 통과).
        let dead = serve(Arc::new(|_, _| Reply::Status(404))).await;
        download_all(&dead, "rev", &items, &root, LOOSE, &AtomicBool::new(false), &plenty, &mut |_, _| {}).await.unwrap();
        let _ = std::fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn sha_mismatch_is_rejected_and_nothing_is_finalized() {
        let good = body(5000, 3); let mut bad = good.clone(); bad[10] ^= 0xff; // 크기는 같고 내용만 다름
        let base = serve(Arc::new(move |_, _| Reply::Body(bad.clone()))).await;
        let root = tmp("sha"); let items = vec![item("m.onnx", &good)];
        let r = download_all(&base, "rev", &items, &root, LOOSE, &AtomicBool::new(false), &plenty, &mut |_, _| {}).await;
        assert_eq!(r, Err(DlError::Mismatch("m.onnx".into())));
        assert!(!root.join("m.onnx").exists() && !root.join("m.onnx.part").exists(), "틀린 파일은 확정도 남기지도 않는다");
        let _ = std::fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn size_mismatch_is_rejected() {
        let want = body(5000, 4); let short = want[..4000].to_vec(); let long = [want.clone(), vec![0u8; 100]].concat();
        for (name, served) in [("short", short), ("long", long)] {
            let s = served.clone();
            let base = serve(Arc::new(move |_, _| Reply::Body(s.clone()))).await;
            let root = tmp(name);
            let r = download_all(&base, "rev", &[item("m.onnx", &want)], &root, LOOSE, &AtomicBool::new(false), &plenty, &mut |_, _| {}).await;
            assert!(matches!(r, Err(DlError::Mismatch(_))), "{name}: {r:?}");
            assert!(!root.join("m.onnx").exists() && !root.join("m.onnx.part").exists());
            let _ = std::fs::remove_dir_all(root);
        }
    }

    #[tokio::test]
    async fn dropped_connection_is_retried_and_resumed_from_part() {
        let data = body(200_000, 5); let d = data.clone();
        // 첫 요청은 절반에서 끊고, 다음 요청은 정상(Range 이어받기).
        let base = serve(Arc::new(move |_, nth| if nth == 1 { Reply::DropAfter(d.clone(), 90_000) } else { Reply::Body(d.clone()) })).await;
        let root = tmp("drop");
        download_all(&base, "rev", &[item("m.onnx", &data)], &root, LOOSE, &AtomicBool::new(false), &plenty, &mut |_, _| {}).await.unwrap();
        assert_eq!(std::fs::read(root.join("m.onnx")).unwrap(), data);
        let _ = std::fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn keeps_failing_after_three_tries_without_finalizing() {
        let data = body(50_000, 6); let d = data.clone();
        let base = serve(Arc::new(move |_, _| Reply::DropAfter(d.clone(), 100))).await; // 늘 끊긴다
        let root = tmp("fail");
        let r = download_all(&base, "rev", &[item("m.onnx", &data)], &root, LOOSE, &AtomicBool::new(false), &plenty, &mut |_, _| {}).await;
        assert_eq!(r, Err(DlError::Network)); assert!(!root.join("m.onnx").exists(), "확정 전 파일은 이름이 다르다");
        let _ = std::fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn refuses_when_disk_is_too_small_before_starting() {
        let data = body(1000, 7);
        let base = serve(Arc::new(|_, _| Reply::Status(500))).await; // 서버에 닿으면 안 된다
        let root = tmp("space");
        let r = download_all(&base, "rev", &[item("m.onnx", &data)], &root, LOOSE, &AtomicBool::new(false), &|_| Some(1499), &mut |_, _| panic!("시작하면 안 된다")).await;
        assert_eq!(r, Err(DlError::NoSpace { need: 1500, have: 1499 }));
        // 딱 필요×1.5 이면 통과
        assert!(check_space(&root, &[item("m.onnx", &data)], &|_| Some(1500)).is_ok());
        assert!(!root.join("m.onnx").exists());
        let _ = std::fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn only_https_is_allowed() {
        let data = body(100, 8);
        // 처음 주소가 http 면 거부(엄격 모드)
        let r = download_all("http://example.invalid/x", "rev", &[item("m.onnx", &data)], &tmp("h1"), NET_STRICT, &AtomicBool::new(false), &plenty, &mut |_, _| {}).await;
        assert_eq!(r, Err(DlError::Insecure));
        // 리다이렉트가 http 로 가면 거부, 따라가지 않는다
        let d = data.clone();
        let base = serve(Arc::new(move |p, _| if p.ends_with("/m.onnx") { Reply::Redirect("http://127.0.0.1:9/never".into()) } else { Reply::Body(d.clone()) })).await;
        let root = tmp("h2");
        let strict_redirects = Net { https_initial: false, https_redirects: true, retry_ms: 0 };
        let r = download_all(&base, "rev", &[item("m.onnx", &data)], &root, strict_redirects, &AtomicBool::new(false), &plenty, &mut |_, _| {}).await;
        assert_eq!(r, Err(DlError::Insecure)); assert!(!root.join("m.onnx").exists());
        // 시험용 느슨한 모드에서는 같은 서버 안 리다이렉트를 따라간다(CDN 흉내)
        let d = data.clone();
        let base = serve(Arc::new(move |p, _| if p.ends_with("/m.onnx") { Reply::Redirect("/cdn/blob".into()) } else if p == "/cdn/blob" { Reply::Body(d.clone()) } else { Reply::Status(404) })).await;
        let root = tmp("h3");
        // 상대 Location 은 같은 http 서버로 가므로 https 요구를 끈 상태에서만 통과
        download_all(&base, "rev", &[item("m.onnx", &data)], &root, LOOSE, &AtomicBool::new(false), &plenty, &mut |_, _| {}).await.unwrap();
        assert_eq!(std::fs::read(root.join("m.onnx")).unwrap(), data);
        let _ = std::fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn cancel_stops_and_removes_part() {
        let data = body(400_000, 9); let d = data.clone();
        let base = serve(Arc::new(move |_, _| Reply::Body(d.clone()))).await;
        let root = tmp("cancel"); let cancel = AtomicBool::new(false);
        let r = download_all(&base, "rev", &[item("m.onnx", &data)], &root, LOOSE, &cancel, &plenty, &mut |d, _| { if d > 0 { cancel.store(true, Ordering::SeqCst); } }).await;
        assert_eq!(r, Err(DlError::Cancelled));
        assert!(!root.join("m.onnx").exists() && !root.join("m.onnx.part").exists());
        let _ = std::fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn stale_wrong_final_file_is_replaced_and_unverified_part_never_counts() {
        let data = body(3000, 10); let d = data.clone();
        let base = serve(Arc::new(move |_, _| Reply::Body(d.clone()))).await;
        let root = tmp("stale"); std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("m.onnx"), vec![0u8; 3000]).unwrap(); // 크기만 맞고 내용이 다른 찌꺼기
        std::fs::write(root.join("m.onnx.part"), vec![9u8; 100]).unwrap(); // 엉뚱한 .part → 이어받기 뒤 해시가 틀려 한 번 버리고 다시
        let items = vec![item("m.onnx", &data)];
        assert!(!is_final(&root.join("m.onnx"), &items[0]));
        download_all(&base, "rev", &items, &root, LOOSE, &AtomicBool::new(false), &plenty, &mut |_, _| {}).await.unwrap();
        assert_eq!(std::fs::read(root.join("m.onnx")).unwrap(), data);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn free_bytes_reads_something_real() {
        let v = free_bytes(&std::env::temp_dir()); assert!(v.map(|x| x > 0).unwrap_or(true));
    }
}
