//! Finds backups under the new name (레이븐볼트) and every old name, in one list.
//!
//! ## Read only
//!
//! The owner already has backups written as `PLAYXRaven-Backup/…/PLAYXRaven.zip.pxlock`
//! (and older `PLAYXRaven-백업`, `.zip.잠김`, `PLAYXRaven-이전.*`). Renaming must not
//! make them invisible, and finding them must not change them. Nothing here opens
//! a file for writing, renames, deletes or copies. The only side effect is reading.
//!
//! ## Rules per naming scheme
//!
//! - **New (`RavenVault*`)**: every file the current app writes has a completion
//!   receipt `.<name>.complete.json` with size and SHA-256. No receipt, or one that
//!   does not match, means the file is not offered.
//! - **Old (`PLAYXRaven*`)**: only the daily automatic copy ever had a receipt.
//!   A receipt that exists must match; a missing one is allowed but the row says
//!   it is unverified (same meaning as the old `legacy` folder rows).
//! - **Lock check (both)**: a `.pxlock` / `.잠김` file must start with `PXRLOCK1`;
//!   a `.zip` must start with `PK\x03\x04` or `PXRLOCK1`. Anything else is broken.
//!
//! The same bytes found twice (two names, two places, overlapping roots) are
//! listed once, preferring the new scheme, then a verified row, then the newest.

use serde_json::{json, Value};
use std::io::Read;
use std::path::{Path, PathBuf};

/// Folder the current app writes.
pub const NEW_DIR: &str = "RavenVault-Backup";
/// Folders older app versions wrote, newest first. Never written again.
pub const OLD_DIRS: &[&str] = &["PLAYXRaven-Backup", "PLAYXRaven-백업", "RavenVault Desktop 백업", "PLAY X Raven 백업"];
pub(crate) const MAX_BYTES: u64 = 4 * 1024 * 1024 * 1024;
/// 잠근 백업 파일의 첫 여덟 바이트. 끌어다 놓은 복원(`restore_drop.rs`)도 이 검사를 그대로 쓴다.
pub(crate) const LOCK_MAGIC: &[u8; 8] = b"PXRLOCK1";

fn scheme_of(name: &str) -> Option<(&'static str, bool)> {
    // (scheme, locked-by-name)
    let tail = |stem: &str| -> Option<bool> {
        let rest = name.strip_prefix(stem)?;
        if !(rest.starts_with('.') || rest.starts_with('-')) { return None; }
        if name.ends_with(".zip.pxlock") || name.ends_with(".zip.잠김") { Some(true) }
        else if name.ends_with(".zip") { Some(false) } else { None }
    };
    if let Some(locked) = tail("RavenVault") {
        // The current app never writes `.잠김`.
        if name.ends_with(".zip.잠김") { return None; }
        return Some(("ravenvault", locked));
    }
    tail("PLAYXRaven").map(|locked| ("playxraven", locked))
}

fn is_generation_folder(name: &str) -> Option<&'static str> {
    let (scheme, hex) = if let Some(h) = name.strip_prefix("RavenVault-") { ("ravenvault", h) }
        else if let Some(h) = name.strip_prefix("PLAYXRaven-") { ("playxraven", h) } else { return None };
    (hex.len() == 16 && hex.bytes().all(|b| b.is_ascii_hexdigit())).then_some(scheme)
}

pub(crate) fn digest(path: &Path) -> Option<(u64, String, [u8; 8])> {
    use sha2::{Digest, Sha256};
    let mut file = std::fs::File::open(path).ok()?;
    let mut hasher = Sha256::new();
    let mut head = [0u8; 8];
    let mut len = 0u64;
    let mut buf = [0u8; 65536];
    loop {
        let n = file.read(&mut buf).ok()?;
        if n == 0 { break; }
        if len < 8 {
            let take = (8 - len as usize).min(n);
            head[len as usize..len as usize + take].copy_from_slice(&buf[..take]);
        }
        hasher.update(&buf[..n]);
        len += n as u64;
    }
    Some((len, hex::encode(hasher.finalize()), head))
}

fn mtime(path: &Path) -> u64 {
    std::fs::metadata(path).and_then(|m| m.modified()).ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_secs()).unwrap_or(0)
}

fn day_of(at: u64) -> String {
    let at = at as i64;
    crate::backup::day_name(at - at.rem_euclid(86_400))
}

fn reject(rejected: &mut Vec<Value>, path: &Path, place: &str, why: &str) {
    rejected.push(json!({"path": path, "place": place, "why": why}));
}

fn check_file(path: &Path, place: &str, items: &mut Vec<Value>, rejected: &mut Vec<Value>) {
    let name = path.file_name().unwrap_or_default().to_string_lossy().to_string();
    let Some((scheme, locked_name)) = scheme_of(&name) else { return };
    match std::fs::symlink_metadata(path) {
        Ok(m) if m.file_type().is_file() => {
            if m.len() == 0 { return reject(rejected, path, place, "빈 파일입니다."); }
            if m.len() > MAX_BYTES { return reject(rejected, path, place, "백업 크기가 4 GB를 넘습니다."); }
        }
        Ok(_) => return reject(rejected, path, place, "일반 파일이 아닙니다."),
        Err(_) => return,
    }
    let Some((size, sha256, head)) = digest(path) else { return reject(rejected, path, place, "파일을 읽지 못했습니다.") };
    let locked = &head == LOCK_MAGIC;
    if locked_name && !locked { return reject(rejected, path, place, "잠근 백업 형식이 아닙니다. 파일이 손상됐을 수 있습니다."); }
    if !locked && head[..4] != *b"PK\x03\x04" { return reject(rejected, path, place, "백업 파일 형식이 아닙니다."); }
    let receipt_file = crate::backup::receipt_path(path);
    let receipt = match std::fs::read(&receipt_file) {
        Ok(bytes) => match serde_json::from_slice::<Value>(&bytes) {
            Ok(v) if v["size"] == size && v["sha256"] == sha256 => Some(v),
            _ => return reject(rejected, path, place, "완료 영수증과 내용이 다릅니다."),
        },
        Err(_) => None,
    };
    if receipt.is_none() && scheme == "ravenvault" {
        return reject(rejected, path, place, "완료 영수증이 없습니다. 끝까지 저장되지 않은 백업일 수 있습니다.");
    }
    let at = receipt.as_ref().and_then(|v| v["at"].as_u64()).unwrap_or_else(|| mtime(path));
    let previous = name.contains("-previous.") || name.contains("-이전.");
    items.push(json!({
        "kind": "file", "path": path, "name": name, "place": place, "scheme": scheme,
        "previous": previous, "locked": locked, "size": size, "sha256": sha256, "at": at,
        "day": receipt.as_ref().and_then(|v| v["day"].as_str().map(str::to_string)).unwrap_or_else(|| day_of(at)),
        "verification": if receipt.is_some() { "complete" } else { "legacy" },
    }));
}

fn check_folder(path: &Path, scheme: &str, place: &str, verify: &dyn Fn(&Path) -> bool, items: &mut Vec<Value>, rejected: &mut Vec<Value>) {
    if !std::fs::symlink_metadata(path).is_ok_and(|m| m.file_type().is_dir()) { return; }
    let marker = path.join(".backup-complete.json");
    let has_marker = std::fs::symlink_metadata(&marker).is_ok();
    if has_marker && !verify(path) { return reject(rejected, path, place, "백업 내용이 완료 기록과 다릅니다."); }
    if !has_marker {
        if scheme == "ravenvault" { return reject(rejected, path, place, "완료 기록이 없는 폴더입니다."); }
        if !path.join("wallet.dat").is_file() { return; }
    }
    let at = mtime(if has_marker { &marker } else { path });
    items.push(json!({
        "kind": "folder", "path": path, "name": path.file_name().unwrap_or_default().to_string_lossy(),
        "place": place, "scheme": scheme, "previous": false, "locked": false, "at": at, "day": day_of(at),
        "verification": if has_marker { "complete" } else { "legacy" },
    }));
}

fn dirs_to_scan(root: &Path) -> Vec<PathBuf> {
    let names: Vec<&str> = std::iter::once(NEW_DIR).chain(OLD_DIRS.iter().copied()).collect();
    let mut out = Vec::new();
    for outer in &names {
        let dir = root.join(outer);
        if !dir.is_dir() { continue; }
        out.push(dir.clone());
        // Old automatic backups nested: `PLAYXRaven-Backup/RavenVault Desktop 백업/`.
        for inner in &names {
            let nested = dir.join(inner);
            if nested.is_dir() { out.push(nested); }
        }
    }
    out
}

fn key(path: &Path) -> PathBuf { path.canonicalize().unwrap_or_else(|_| path.to_path_buf()) }

/// Every backup under `places` (label, root) plus `extra` rows, merged, de-duplicated
/// and sorted newest first. `verify` checks a folder's completion marker.
pub fn find(places: &[(String, PathBuf)], verify: &dyn Fn(&Path) -> bool, extra: Vec<Value>) -> Value {
    let mut items = extra;
    let mut rejected = Vec::new();
    let mut seen_dirs = std::collections::HashSet::new();
    for (label, root) in places {
        if !root.is_dir() { continue; }
        let mut dirs = vec![root.clone()];
        dirs.extend(dirs_to_scan(root));
        for (i, dir) in dirs.iter().enumerate() {
            if !seen_dirs.insert(key(dir)) { continue; }
            let Ok(entries) = std::fs::read_dir(dir) else { continue };
            for entry in entries.flatten() {
                let path = entry.path();
                let name = entry.file_name().to_string_lossy().to_string();
                if let Some(scheme) = is_generation_folder(&name) {
                    check_folder(&path, scheme, label, verify, &mut items, &mut rejected);
                } else if i > 0 {
                    // Loose files are only taken from the backup folders themselves.
                    check_file(&path, label, &mut items, &mut rejected);
                }
            }
        }
    }
    // Newest first, then prefer new scheme and verified rows when bytes repeat.
    let rank = |v: &Value| (v["scheme"] == "ravenvault" || v["scheme"] == "app", v["verification"] == "complete");
    items.sort_by(|a, b| {
        b["at"].as_u64().cmp(&a["at"].as_u64())
            .then_with(|| rank(b).cmp(&rank(a)))
            .then_with(|| a["path"].to_string().cmp(&b["path"].to_string()))
    });
    let mut by_path = std::collections::HashSet::new();
    let mut by_hash: std::collections::HashMap<String, usize> = std::collections::HashMap::new();
    let mut merged: Vec<Value> = Vec::new();
    for item in items {
        let path = key(Path::new(item["path"].as_str().unwrap_or("")));
        if !by_path.insert(path) { continue; }
        if let Some(hash) = item["sha256"].as_str().map(str::to_string) {
            if let Some(&at) = by_hash.get(&hash) {
                // Keep the better-ranked copy; remember the other place only.
                if rank(&item) > rank(&merged[at]) {
                    let other = merged[at]["path"].clone();
                    merged[at] = item;
                    merged[at]["also"] = json!([other]);
                } else if let Some(list) = merged[at].get_mut("also") {
                    list.as_array_mut().map(|a| a.push(item["path"].clone()));
                } else {
                    merged[at]["also"] = json!([item["path"]]);
                }
                continue;
            }
            by_hash.insert(hash, merged.len());
        }
        merged.push(item);
    }
    json!({"items": merged, "rejected": rejected})
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn root(name: &str) -> PathBuf {
        let r = crate::paths::test_fixture_root().join(format!("backup-find-{name}-{:x}", rand::random::<u64>()));
        fs::create_dir_all(&r).unwrap();
        r
    }
    fn locked(bytes: &[u8]) -> Vec<u8> { [b"PXRLOCK1".as_slice(), bytes].concat() }
    fn write_with_receipt(path: &Path, bytes: &[u8], at: u64) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, bytes).unwrap();
        let (size, sha, _) = digest(path).unwrap();
        fs::write(crate::backup::receipt_path(path), json!({"day": day_of(at), "at": at, "size": size, "sha256": sha}).to_string()).unwrap();
    }
    fn snapshot(dir: &Path) -> Vec<(PathBuf, Vec<u8>)> {
        let mut out = Vec::new();
        let mut stack = vec![dir.to_path_buf()];
        while let Some(d) = stack.pop() {
            for e in fs::read_dir(&d).unwrap().flatten() {
                let p = e.path();
                if p.is_dir() { stack.push(p) } else { out.push((p.clone(), fs::read(&p).unwrap())) }
            }
        }
        out.sort();
        out
    }
    fn places(r: &Path) -> Vec<(String, PathBuf)> { vec![("fixture".into(), r.to_path_buf())] }
    fn never(_: &Path) -> bool { false }

    #[test]
    fn old_only_is_found_read_only() {
        let r = root("old");
        let old = r.join("PLAYXRaven-Backup").join("RavenVault Desktop 백업");
        fs::create_dir_all(&old).unwrap();
        fs::write(old.join("PLAYXRaven.zip.pxlock"), locked(b"synthetic old latest")).unwrap();
        fs::write(old.join("PLAYXRaven-이전.zip.pxlock"), locked(b"synthetic old previous")).unwrap();
        fs::create_dir_all(r.join("PLAYXRaven-백업")).unwrap();
        fs::write(r.join("PLAYXRaven-백업").join("PLAYXRaven.zip.잠김"), locked(b"synthetic oldest")).unwrap();
        let before = snapshot(&r);
        let v = find(&places(&r), &never, vec![]);
        assert_eq!(v["items"].as_array().unwrap().len(), 3, "{v}");
        assert!(v["items"].as_array().unwrap().iter().all(|i| i["scheme"] == "playxraven" && i["verification"] == "legacy"));
        assert!(v["items"].as_array().unwrap().iter().any(|i| i["previous"] == true));
        assert_eq!(snapshot(&r), before, "finding must not change old backups");
    }

    #[test]
    fn new_only_requires_matching_receipt() {
        let r = root("new");
        let dir = r.join(NEW_DIR);
        write_with_receipt(&dir.join("RavenVault.zip.pxlock"), &locked(b"new latest"), 2_000);
        fs::write(dir.join("RavenVault-previous.zip.pxlock"), locked(b"no receipt")).unwrap();
        write_with_receipt(&dir.join("RavenVault-shop.zip.pxlock"), &locked(b"labelled"), 1_000);
        fs::write(dir.join("RavenVault-shop.zip.pxlock"), locked(b"changed after receipt")).unwrap();
        let v = find(&places(&r), &never, vec![]);
        let items = v["items"].as_array().unwrap();
        assert_eq!(items.len(), 1, "{v}");
        assert_eq!(items[0]["verification"], "complete");
        assert_eq!(v["rejected"].as_array().unwrap().len(), 2);
    }

    #[test]
    fn both_schemes_merge_sort_and_dedupe() {
        let r = root("both");
        let new = r.join(NEW_DIR);
        write_with_receipt(&new.join("RavenVault.zip.pxlock"), &locked(b"same bytes"), 3_000);
        write_with_receipt(&new.join("RavenVault-previous.zip.pxlock"), &locked(b"newer only"), 4_000);
        let old = r.join("PLAYXRaven-Backup").join("RavenVault Desktop 백업");
        write_with_receipt(&old.join("PLAYXRaven.zip.pxlock"), &locked(b"same bytes"), 3_000);
        write_with_receipt(&old.join("PLAYXRaven-이전.zip.pxlock"), &locked(b"old only"), 1_000);
        // Same root listed twice (e.g. Documents inside a cloud folder).
        let mut p = places(&r);
        p.push(("again".into(), r.clone()));
        let v = find(&p, &never, vec![json!({"kind":"folder","path":"/synthetic/app/2026-01-01","scheme":"app","at":2_000,"verification":"complete"})]);
        let items = v["items"].as_array().unwrap();
        let ats: Vec<u64> = items.iter().map(|i| i["at"].as_u64().unwrap()).collect();
        assert_eq!(ats, vec![4_000, 3_000, 2_000, 1_000], "{v}");
        assert_eq!(items[1]["scheme"], "ravenvault", "same bytes prefer the new name");
        assert_eq!(items[1]["also"].as_array().unwrap().len(), 1);
        assert_eq!(items[3]["scheme"], "playxraven");
    }

    #[test]
    fn broken_files_are_refused() {
        let r = root("broken");
        let old = r.join("PLAYXRaven-Backup");
        fs::create_dir_all(&old).unwrap();
        fs::write(old.join("PLAYXRaven.zip.pxlock"), b"not locked at all").unwrap();
        fs::write(old.join("PLAYXRaven.zip"), b"not a zip").unwrap();
        fs::write(old.join("PLAYXRaven-x.zip.pxlock"), b"").unwrap();
        write_with_receipt(&old.join("PLAYXRaven-y.zip.pxlock"), &locked(b"receipt then change"), 5);
        fs::write(old.join("PLAYXRaven-y.zip.pxlock"), locked(b"changed")).unwrap();
        fs::write(old.join("unrelated.zip"), b"PK\x03\x04 other app").unwrap();
        let v = find(&places(&r), &never, vec![]);
        assert_eq!(v["items"].as_array().unwrap().len(), 0, "{v}");
        assert_eq!(v["rejected"].as_array().unwrap().len(), 4);
    }

    #[test]
    fn generation_folders_follow_their_own_rules() {
        let r = root("folders");
        for (name, marker) in [("RavenVault-00112233aabbccdd", true), ("RavenVault-1111111111111111", false), ("PLAYXRaven-2222222222222222", false)] {
            let d = r.join(name);
            fs::create_dir_all(&d).unwrap();
            fs::write(d.join("wallet.dat"), b"synthetic").unwrap();
            if marker { fs::write(d.join(".backup-complete.json"), b"{}").unwrap(); }
        }
        let ok = |p: &Path| p.ends_with("RavenVault-00112233aabbccdd");
        let v = find(&places(&r), &ok, vec![]);
        let items = v["items"].as_array().unwrap();
        assert_eq!(items.len(), 2, "{v}");
        assert!(items.iter().any(|i| i["scheme"] == "playxraven" && i["verification"] == "legacy"));
        assert_eq!(v["rejected"].as_array().unwrap().len(), 1);
    }
}
