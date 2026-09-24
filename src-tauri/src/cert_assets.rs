//! 증명서에 들어가는 파일들 — 글꼴 · 발급처 로고 · 도장 · 받는 사람 사진.
//!
//! ## 글꼴
//! `cert-fonts/` 의 woff2 를 바이너리에 굽는다. 인쇄 파일에는 data: 로 넣어 그 파일
//! 하나만 있으면 어느 컴퓨터에서 열어도 같은 모양이다. 앱 안 미리보기는 같은 글꼴
//! CSS 를 한 번 받아 붙인다(`certificate_font_css`).
//!
//! ## 로고 · 도장 — 한 번 올리면 다음에도
//! 앱 자료 폴더 `cert-assets/logo.png`·`stamp.png`(0600). PNG·JPEG 만 받는다 — SVG 는
//! 안 받는다(그림 안에 스크립트가 들어갈 수 있다). 모양은 바이트 머리로 다시 본다.
//!
//! ## 사진 — 사람을 알아볼 수 있는 자료
//! `create-photos/<기록 id>/<줄 번호>.jpg`. 받는 사람 이름과 같게 다룬다: 기록을
//! 지우거나 보관 기간이 지나면 폴더째 지운다(`create_history.rs`). 서버로 보내지 않는다.

use serde_json::{json, Value};
use std::path::PathBuf;

const B64: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

pub fn b64_encode(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let n = (chunk[0] as u32) << 16 | (*chunk.get(1).unwrap_or(&0) as u32) << 8 | *chunk.get(2).unwrap_or(&0) as u32;
        for i in 0..4 {
            if i <= chunk.len() {
                out.push(B64[(n >> (18 - 6 * i) & 63) as usize] as char);
            } else {
                out.push('=');
            }
        }
    }
    out
}

pub fn b64_decode(s: &str) -> Option<Vec<u8>> {
    let s = s.trim_end_matches('=');
    let mut out = Vec::with_capacity(s.len() * 3 / 4);
    let (mut buf, mut bits) = (0u32, 0u32);
    for c in s.bytes() {
        let v = B64.iter().position(|&x| x == c)? as u32;
        buf = (buf << 6) | v;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((buf >> bits) as u8);
            buf &= (1 << bits) - 1;
        }
    }
    Some(out)
}

/* ── 글꼴 ─────────────────────────────────────────────────────────── */

const FONTS: [(&str, &str, &str, &[u8]); 5] = [
    ("RV Cert Serif", "400", "normal", include_bytes!("cert-fonts/RVCertSerif-Regular.woff2")),
    ("RV Cert Serif", "700", "normal", include_bytes!("cert-fonts/RVCertSerif-Bold.woff2")),
    ("RV Cert Serif", "800", "normal", include_bytes!("cert-fonts/RVCertSerif-ExtraBold.woff2")),
    ("Cormorant Garamond", "300 700", "normal", include_bytes!("cert-fonts/CormorantGaramond.woff2")),
    ("Cormorant Garamond", "300 700", "italic", include_bytes!("cert-fonts/CormorantGaramond-Italic.woff2")),
];

/// `@font-face` 다섯 개(글꼴은 data: 로). 한 번 만들어 둔다 — 1.7MB 쯤 된다.
pub fn font_css() -> &'static str {
    static CSS: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    CSS.get_or_init(|| {
        FONTS
            .iter()
            .map(|(family, weight, style, bytes)| {
                format!(
                    "@font-face{{font-family:\"{family}\";font-weight:{weight};font-style:{style};font-display:block;src:url(data:font/woff2;base64,{}) format(\"woff2\");}}\n",
                    b64_encode(bytes)
                )
            })
            .collect()
    })
}

/// 앱 안 미리보기가 한 번 받아 붙이는 글꼴 CSS.
#[tauri::command]
pub fn certificate_font_css() -> String {
    font_css().to_string()
}

/* ── 그림 확인 ─────────────────────────────────────────────────────── */

/// `data:image/png;base64,…` 또는 jpeg 만 받아 바이트로. 머리 바이트로 모양을 다시 본다.
pub fn image_from_data_url(url: &str, max_bytes: usize) -> Result<(Vec<u8>, &'static str), String> {
    let (mime, b64) = if let Some(rest) = url.strip_prefix("data:image/png;base64,") {
        ("image/png", rest)
    } else if let Some(rest) = url.strip_prefix("data:image/jpeg;base64,") {
        ("image/jpeg", rest)
    } else {
        return Err("PNG 나 JPG 그림만 넣을 수 있어요.".into());
    };
    if b64.len() > max_bytes * 4 / 3 + 8 {
        return Err(format!("그림이 너무 커요({}KB 까지).", max_bytes / 1024));
    }
    let bytes = b64_decode(b64).ok_or("그림을 읽지 못했어요.")?;
    let ok = match mime {
        "image/png" => bytes.starts_with(b"\x89PNG\r\n\x1a\n"),
        _ => bytes.starts_with(&[0xFF, 0xD8, 0xFF]),
    };
    if !ok || bytes.len() > max_bytes {
        return Err("그림 파일이 아니거나 너무 커요.".into());
    }
    Ok((bytes, mime))
}

fn mime_of(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some("image/png")
    } else if bytes.starts_with(&[0xFF, 0xD8, 0xFF]) {
        Some("image/jpeg")
    } else {
        None
    }
}

fn data_url(bytes: &[u8]) -> Option<String> {
    Some(format!("data:{};base64,{}", mime_of(bytes)?, b64_encode(bytes)))
}

/* ── 로고 · 도장 ─────────────────────────────────────────────────── */

const MAX_MARK_BYTES: usize = 1536 * 1024;

fn mark_path(kind: &str) -> Result<PathBuf, String> {
    match kind {
        "logo" | "stamp" => Ok(crate::paths::app_dir().join("cert-assets").join(format!("{kind}.img"))),
        _ => Err("로고나 도장만 넣을 수 있어요.".into()),
    }
}

/// 저장된 로고·도장(data: 주소). 없거나 망가졌으면 None.
pub fn mark(kind: &str) -> Option<String> {
    let bytes = std::fs::read(mark_path(kind).ok()?).ok()?;
    data_url(&bytes)
}

#[tauri::command]
pub fn certificate_marks() -> Value {
    json!({ "logo": mark("logo"), "stamp": mark("stamp") })
}

#[tauri::command]
pub fn certificate_mark_save(kind: String, image: String) -> Result<Value, String> {
    let path = mark_path(&kind)?;
    let (bytes, _) = image_from_data_url(&image, MAX_MARK_BYTES)?;
    crate::create_history::write_private(&path, &bytes)?;
    Ok(certificate_marks())
}

#[tauri::command]
pub fn certificate_mark_clear(kind: String) -> Result<Value, String> {
    let path = mark_path(&kind)?;
    match std::fs::remove_file(&path) {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(_) => return Err("지우지 못했어요.".into()),
    }
    Ok(certificate_marks())
}

/* ── 받는 사람 사진 ──────────────────────────────────────────────── */

/// 한 장 사진의 최대 크기 — 화면이 긴 변 800px JPEG 로 줄여 보낸다(보통 60~120KB).
pub const MAX_PHOTO_BYTES: usize = 400 * 1024;

fn valid_id(id: &str) -> bool {
    id.len() == 32 && id.bytes().all(|b| b.is_ascii_hexdigit())
}

pub fn photos_dir(id: &str) -> PathBuf {
    crate::paths::app_dir().join("create-photos").join(id)
}

fn photo_path(id: &str, index: usize) -> PathBuf {
    photos_dir(id).join(format!("{index}.img"))
}

/// 기록 한 건의 사진을 줄 번호에 맞춰 저장한다. 빈 칸(null)은 그 줄 사진을 지운다.
#[tauri::command]
pub fn create_photos_save(id: String, photos: Vec<Option<String>>) -> Result<usize, String> {
    if !valid_id(&id) {
        return Err("기록을 찾지 못했어요.".into());
    }
    let entry = crate::create_history::create_history_get(id.clone())?;
    let people = entry
        .get("recipients")
        .and_then(Value::as_array)
        .map(Vec::len)
        .unwrap_or(0);
    if photos.len() > people.max(1) {
        return Err("사진이 받는 사람보다 많아요.".into());
    }
    // 먼저 전부 확인하고, 다 괜찮을 때만 쓴다 — 반만 저장되지 않게.
    let mut checked = Vec::with_capacity(photos.len());
    for p in &photos {
        checked.push(match p {
            Some(url) => Some(image_from_data_url(url, MAX_PHOTO_BYTES)?.0),
            None => None,
        });
    }
    let mut saved = 0;
    for (i, bytes) in checked.iter().enumerate() {
        let path = photo_path(&id, i);
        match bytes {
            Some(b) => {
                crate::create_history::write_private(&path, b)?;
                saved += 1;
            }
            None => {
                let _ = std::fs::remove_file(&path);
            }
        }
    }
    Ok(saved)
}

/// 인쇄할 때 — 그 줄 사진(data: 주소). 없으면 None.
pub fn photo(id: &str, index: usize) -> Option<String> {
    if !valid_id(id) {
        return None;
    }
    let bytes = std::fs::read(photo_path(id, index)).ok()?;
    data_url(&bytes)
}

/// 기록을 지우거나 보관 기간이 지났을 때 — 그 기록의 사진 폴더째.
pub fn forget_photos(id: &str) {
    if valid_id(id) {
        let _ = std::fs::remove_dir_all(photos_dir(id));
    }
}

/* ── 창에 떨어뜨린 명단 표 · 사진 ───────────────────────────────── */
//
// 🔴 `dropbox.rs` 와 같은 원칙 — **사람이 방금 창에 떨어뜨린 경로만** 읽는다. 화면이
//    아무 경로나 읽게 하면, 화면이 한 번 뚫리는 날 지갑 파일이 읽힌다. 거기에 더해
//    명단 표와 사진 확장자만, 크기도 정해 둔다. 읽은 것은 화면 안에서만 쓴다(올리지 않는다).

const DROP_MAX_BYTES: u64 = 25 * 1024 * 1024;
const DROP_MAX_FILES: usize = 600;

fn drop_ext(name: &str) -> Option<&'static str> {
    let ext = name.rsplit_once('.')?.1.to_ascii_lowercase();
    match ext.as_str() {
        "xlsx" | "xls" | "csv" => Some("table"),
        "jpg" | "jpeg" | "png" | "webp" | "heic" | "heif" | "gif" => Some("image"),
        _ => None,
    }
}

fn read_dropped_file(path: &std::path::Path, want: Option<&str>) -> Result<Value, String> {
    let name = path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
    let kind = drop_ext(&name).ok_or("명단 표(xlsx·xls·csv)나 사진 파일만 읽어요.")?;
    if want.is_some_and(|w| w != kind) {
        return Err("사진 파일만 읽어요.".into());
    }
    // 바로가기는 따라가지 않는다 — 놓은 것이 가리키는 다른 파일을 읽지 않게.
    let meta = std::fs::symlink_metadata(path).map_err(|_| "파일을 찾지 못했어요.")?;
    if !meta.file_type().is_file() {
        return Err("파일이 아니에요.".into());
    }
    if meta.len() > DROP_MAX_BYTES {
        return Err(format!("{name} — 너무 커요({}MB 까지).", DROP_MAX_BYTES / 1024 / 1024));
    }
    let bytes = std::fs::read(path).map_err(|_| "파일을 읽지 못했어요.")?;
    Ok(json!({ "name": name, "kind": kind, "data": b64_encode(&bytes) }))
}

/// 창에 떨어뜨린 파일 하나를 읽는다. 폴더를 떨어뜨렸으면 그 안(한 층)의 표·사진 이름만.
#[tauri::command]
pub fn create_dropped_read(path: String) -> Result<Value, String> {
    if !crate::dropbox::was_dropped(&path) {
        return Err("방금 창에 놓은 파일만 읽을 수 있어요.".into());
    }
    let p = std::path::Path::new(&path);
    let meta = std::fs::symlink_metadata(p).map_err(|_| "파일을 찾지 못했어요.")?;
    if meta.file_type().is_dir() {
        let mut files: Vec<String> = std::fs::read_dir(p)
            .map_err(|_| "폴더를 읽지 못했어요.")?
            .flatten()
            .filter(|f| f.file_type().map(|t| t.is_file()).unwrap_or(false))
            .map(|f| f.file_name().to_string_lossy().to_string())
            .filter(|n| !n.starts_with('.') && drop_ext(n) == Some("image"))
            .collect();
        files.sort();
        if files.len() > DROP_MAX_FILES {
            return Err(format!("한 폴더에 사진 {DROP_MAX_FILES}장까지 읽어요."));
        }
        return Ok(json!({ "folder": true, "files": files }));
    }
    read_dropped_file(p, None)
}

/// 떨어뜨린 폴더 안의 사진 한 장. 이름에 경로가 섞이면 안 받는다.
#[tauri::command]
pub fn create_dropped_read_in(folder: String, name: String) -> Result<Value, String> {
    if !crate::dropbox::was_dropped(&folder) {
        return Err("방금 창에 놓은 폴더만 읽을 수 있어요.".into());
    }
    // `:` — 윈도우에서 `C:x.jpg` 는 폴더 밖(그 드라이브의 현재 폴더)을 가리킨다(검수 09-24).
    if name.is_empty() || name.starts_with('.') || name.contains(['/', '\\', '\0', ':']) || name == ".." {
        return Err("파일 이름이 올바르지 않아요.".into());
    }
    let dir = std::path::Path::new(&folder);
    if !std::fs::symlink_metadata(dir).map(|m| m.file_type().is_dir()).unwrap_or(false) {
        return Err("폴더가 아니에요.".into());
    }
    read_dropped_file(&dir.join(&name), Some("image"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base64_앞뒤가_맞는다() {
        for s in ["", "f", "fo", "foo", "foob", "fooba", "foobar"] {
            let e = b64_encode(s.as_bytes());
            assert_eq!(b64_decode(&e).unwrap(), s.as_bytes(), "{s}");
        }
        assert_eq!(b64_encode(b"foobar"), "Zm9vYmFy");
        assert_eq!(b64_encode(b"fo"), "Zm8=");
        assert!(b64_decode("@@@").is_none());
    }

    #[test]
    fn 글꼴은_다섯_개_모두_data_로() {
        let css = font_css();
        assert_eq!(css.matches("@font-face").count(), 5);
        assert!(css.contains("font-family:\"RV Cert Serif\";font-weight:800"));
        assert!(!css.contains("http"), "바깥 주소를 부르면 안 된다");
        for (_, _, _, bytes) in FONTS {
            assert!(bytes.starts_with(b"wOF2"), "woff2 가 아니다");
        }
    }

    #[test]
    fn 떨어뜨린_것만_표와_사진만_읽는다() {
        let dir = std::env::temp_dir().join(format!("rv-drop-{:x}", rand::random::<u64>()));
        std::fs::create_dir_all(dir.join("photos")).unwrap();
        std::fs::write(dir.join("명단.xlsx"), b"PK").unwrap();
        std::fs::write(dir.join("wallet.dat"), b"secret").unwrap();
        std::fs::write(dir.join("photos/김하늘.jpg"), [0xFF, 0xD8, 0xFF]).unwrap();
        std::fs::write(dir.join("photos/.hidden.jpg"), [0xFF, 0xD8, 0xFF]).unwrap();
        std::fs::write(dir.join("photos/메모.txt"), b"x").unwrap();
        let s = |p: &std::path::Path| p.to_string_lossy().to_string();
        let table = s(&dir.join("명단.xlsx"));
        assert!(create_dropped_read(table.clone()).is_err(), "놓지 않은 파일");
        crate::dropbox::remember(&[table.clone(), s(&dir.join("wallet.dat")), s(&dir.join("photos"))]);
        let got = create_dropped_read(table).unwrap();
        assert_eq!(got["kind"], "table");
        assert_eq!(b64_decode(got["data"].as_str().unwrap()).unwrap(), b"PK");
        assert!(create_dropped_read(s(&dir.join("wallet.dat"))).is_err(), "놓았어도 표·사진이 아니면 안 읽는다");
        let folder = create_dropped_read(s(&dir.join("photos"))).unwrap();
        assert_eq!(folder["files"], json!(["김하늘.jpg"]));
        assert!(create_dropped_read_in(s(&dir.join("photos")), "김하늘.jpg".into()).is_ok());
        assert!(create_dropped_read_in(s(&dir.join("photos")), "../wallet.dat".into()).is_err());
        assert!(create_dropped_read_in(s(&dir.join("photos")), "C:wallet.dat".into()).is_err(), "윈도우 드라이브 상대 경로");
        assert!(create_dropped_read_in(s(&dir), "wallet.dat".into()).is_err(), "놓지 않은 폴더");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn 그림은_png_jpeg_만_머리까지_본다() {
        let png = format!("data:image/png;base64,{}", b64_encode(b"\x89PNG\r\n\x1a\nrest"));
        assert_eq!(image_from_data_url(&png, 1024).unwrap().1, "image/png");
        let fake = format!("data:image/png;base64,{}", b64_encode(b"<svg onload=alert(1)>"));
        assert!(image_from_data_url(&fake, 1024).is_err(), "머리가 PNG 가 아닌데 받았다");
        assert!(image_from_data_url("data:image/svg+xml;base64,PHN2Zz4=", 1024).is_err());
        let big = format!("data:image/jpeg;base64,{}", b64_encode(&[vec![0xFF, 0xD8, 0xFF], vec![0; 4000]].concat()));
        assert!(image_from_data_url(&big, 1024).is_err(), "크기 한도");
    }
}
