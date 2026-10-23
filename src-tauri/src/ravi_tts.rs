//! 라비 목소리(Supertonic 3) 모델 읽기 — **앱 자료 폴더 `ravi-voice/` 에서 읽기만 한다.**
//! 모델은 설치 파일에 들어 있지 않다. 사용자가 동의하면 `ravi_voice_pack.rs` 가 한 번 받아 둔다. 여기는 네트워크가 없다.
//! 합성 자체는 화면 쪽 워커가 한다.
//!
//! 화면은 글자 이름표(`key`)만 넘기고, 경로는 여기서만 만든다 → 이름표 밖의 파일은 읽을 수 없다.
//! 없거나 크기가 다르면 `ravi_tts_status` 가 「못 쓴다」를 알리고, 화면은 기기 목소리로 말한다.
use serde_json::{json, Value};
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};

/// (이름표, 리소스 안 경로, 정확한 크기). 크기는 모델 manifest.json 과 같다 — 깨진 파일을 걸러 낸다.
pub const FILES: [(&str, &str, u64); 8] = [
    ("dp", "onnx/duration_predictor.onnx", 3_700_147),
    ("enc", "onnx/text_encoder.onnx", 36_416_150),
    ("vec", "onnx/vector_estimator.onnx", 256_534_781),
    ("voc", "onnx/vocoder.onnx", 101_424_195),
    ("cfg", "onnx/tts.json", 8_253),
    ("indexer", "onnx/unicode_indexer.json", 277_676),
    ("style", "voice_styles/F1.json", 292_046),
    ("license", "LICENSE", 15_007),
];
/// 한 번에 넘기는 최대 크기(화면이 이어 붙인다).
pub const MAX_CHUNK: u64 = 32 * 1024 * 1024;

fn entry(key: &str) -> Option<(&'static str, u64)> {
    FILES.iter().find(|(k, _, _)| *k == key).map(|(_, p, s)| (*p, *s))
}

/// 받아 둔 모델 폴더: 앱 자료 폴더 `ravi-voice/`(RavenVault 폴더 이전 규칙을 따른다). 받기는 `ravi_voice_pack.rs`.
pub fn pack_dir() -> PathBuf { crate::paths::app_dir().join("ravi-voice") }

/// 모델을 읽는 곳. 설치 파일에는 모델이 없다(LICENSE·manifest.json 만). 개발 중에는 저장소의 `src-tauri/resources/ravi-voice` 도 본다.
fn roots() -> Vec<PathBuf> {
    let mut v = vec![pack_dir()];
    if cfg!(debug_assertions) { v.push(Path::new(env!("CARGO_MANIFEST_DIR")).join("resources").join("ravi-voice")); }
    v
}

/// 설치 파일에 같이 들어 있는 작은 파일(LICENSE) 자리 — 모델을 안 받았어도 라이선스 원문은 보여 준다.
fn bundled_roots(app: &tauri::AppHandle) -> Vec<PathBuf> {
    use tauri::Manager;
    let mut v = Vec::new();
    if let Ok(dir) = app.path().resource_dir() { v.push(dir.join("ravi-voice")); v.push(dir.join("resources").join("ravi-voice")); }
    if cfg!(debug_assertions) { v.push(Path::new(env!("CARGO_MANIFEST_DIR")).join("resources").join("ravi-voice")); }
    v
}

/// 순수: 한 폴더가 모델을 다 갖췄는가. 모자라는 이름표 목록(비어 있으면 완전).
pub fn missing_in(root: &Path) -> Vec<&'static str> {
    FILES.iter().filter(|(_, rel, size)| std::fs::metadata(root.join(rel)).map(|m| !m.is_file() || m.len() != *size).unwrap_or(true)).map(|(k, _, _)| *k).collect()
}

fn complete_root() -> Option<PathBuf> {
    roots().into_iter().find(|r| missing_in(r).is_empty())
}

/// 모델을 쓸 수 있는가(받아 뒀고 크기가 다 맞음).
pub fn is_installed(_app: &tauri::AppHandle) -> bool { complete_root().is_some() }

fn license_ok(root: &Path) -> bool {
    FILES.iter().find(|(k, _, _)| *k == "license").map(|(_, rel, size)| std::fs::metadata(root.join(rel)).map(|m| m.is_file() && m.len() == *size).unwrap_or(false)).unwrap_or(false)
}

/// 순수: 이름표 + 범위 → 읽은 바이트. 범위가 파일 밖이면 오류.
pub fn read_range(root: &Path, key: &str, offset: u64, len: u64) -> Result<Vec<u8>, String> {
    let (rel, size) = entry(key).ok_or("key")?;
    if len == 0 || len > MAX_CHUNK || offset >= size { return Err("range".into()); }
    let len = len.min(size - offset);
    let mut f = std::fs::File::open(root.join(rel)).map_err(|_| "open")?;
    f.seek(SeekFrom::Start(offset)).map_err(|_| "seek")?;
    let mut buf = vec![0u8; len as usize];
    f.read_exact(&mut buf).map_err(|_| "read")?;
    Ok(buf)
}

#[tauri::command]
pub async fn ravi_tts_status(_app: tauri::AppHandle) -> Value {
    match complete_root() {
        Some(_) => json!({ "ok": true, "sizes": FILES.iter().map(|(k, _, s)| json!([k, s])).collect::<Vec<_>>() }),
        None => {
            let miss = roots().first().map(|r| missing_in(r)).unwrap_or_else(|| vec!["root"]);
            json!({ "ok": false, "missing": miss })
        }
    }
}

#[tauri::command]
pub async fn ravi_tts_read(app: tauri::AppHandle, key: String, offset: u64, len: u64) -> Result<tauri::ipc::Response, String> {
    // 라이선스 원문은 모델을 안 받았어도 설치 파일 쪽 사본으로 읽어 준다(이름표 8개 밖은 여전히 못 읽는다).
    let root = match complete_root() {
        Some(r) => r,
        None if key == "license" => bundled_roots(&app).into_iter().chain(roots()).find(|r| license_ok(r)).ok_or("missing")?,
        None => return Err("missing".into()),
    };
    tauri::async_runtime::spawn_blocking(move || read_range(&root, &key, offset, len)).await.map_err(|_| "join".to_string())?.map(tauri::ipc::Response::new)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture(sizes_ok: bool, name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("rv-tts-{}-{}", std::process::id(), name));
        let _ = std::fs::remove_dir_all(&dir);
        for (_, rel, size) in FILES.iter() {
            let p = dir.join(rel); std::fs::create_dir_all(p.parent().unwrap()).unwrap();
            // 큰 모델은 구멍 난(sparse) 파일로 — 디스크를 안 쓴다.
            let f = std::fs::File::create(&p).unwrap(); f.set_len(if sizes_ok { *size } else { size - 1 }).unwrap();
        }
        dir
    }
    #[test]
    fn complete_folder_is_usable() {
        let d = fixture(true, "a"); assert!(missing_in(&d).is_empty()); let _ = std::fs::remove_dir_all(d);
    }
    #[test]
    fn broken_or_absent_folder_is_not_usable() {
        let d = fixture(false, "b"); assert_eq!(missing_in(&d).len(), FILES.len()); let _ = std::fs::remove_dir_all(d);
        assert_eq!(missing_in(Path::new("/nonexistent-ravi-voice")).len(), FILES.len());
    }
    #[test]
    fn read_range_is_bounded_and_keyed() {
        let d = fixture(true, "c");
        assert_eq!(read_range(&d, "license", 0, 10).unwrap().len(), 10);
        assert_eq!(read_range(&d, "license", 15_000, 100).unwrap().len(), 7, "끝은 잘라서");
        assert!(read_range(&d, "license", 15_007, 1).is_err());
        assert!(read_range(&d, "../../etc/passwd", 0, 1).is_err(), "이름표 밖은 못 읽는다");
        assert!(read_range(&d, "vec", 0, MAX_CHUNK + 1).is_err());
        assert!(read_range(&d, "vec", 0, 0).is_err());
        let _ = std::fs::remove_dir_all(d);
    }
}
