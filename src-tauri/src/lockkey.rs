//! RV-LOCK v1(구매자 열람권) 열쇠 보관 · 열쇠 파일 내보내기/되돌리기 · 결제 거래 읽기.
//!
//! 암호 계산은 전부 화면(TS) 쪽 `core/creator/lock.ts` 가 한다. 이 파일은 **비밀을 디스크에 두고 꺼내는 일**만 한다.
//!
//! ## 🔴 규칙
//!
//! - **상품 열쇠(판매자)를 잃으면 판매자도 영영 못 연다.** 그래서 `lock_key_export` 로 백업 열쇠(52글자)로 한 번 더 잠근 별도 파일
//!   (`.pxlock`)을 사용자가 고른 폴더에 둔다 — 지갑 파일(`.rvwallet`)과 같은 잠금 방식, 이름·내용은 별개다.
//!   지갑 복구 단어에서 파생하지 않는다(키 분리). 화면은 백업 전에는 등록을 막는다.
//! - 이름 규칙: `s.<자산>` 판매자 상품 열쇠 · `b.<txid>` 구매자 열람 개인키 · `k.<자산>` 구매자가 받은 상품 열쇠. 값은 32바이트(hex 64글자).
//! - **덮어쓰지 않는다.** 같은 이름에 다른 값을 쓰려 하면 거절(`EXISTS`) — 이미 팔고 있는 상품의 열쇠를 실수로 바꾸는 사고를 막는다.
//! - 파일은 앱 폴더 `lock-keys/` 안, 유닉스 0600. 비밀은 로그·오류 문구·반환값(`lock_secret_get` 만 예외)에 넣지 않는다.
//! - 잠긴 동안(대기화면·매장용 읽기 전용)에는 이 명령들이 모두 거부된다 — `app_lock::LOCKED_ALLOWED` 에 넣지 않는다.
//! - `lock_tx_info` 는 노드에서 읽기만 한다(`getrawtransaction`). 돈·서명·전송은 없다.

use serde_json::{json, Value};
use std::path::{Path, PathBuf};

const KIND: &str = "rv-lock-product-key";
const MAX_FILE: u64 = 4096;

fn store_dir() -> PathBuf {
    crate::paths::app_file("lock-keys")
}

/// 이름 검사: 영문·숫자·`.`·`_`·`-` 만, 1~120자, `..` 금지.
pub fn name_ok(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 120
        && !name.contains("..")
        && name.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'_' || b == b'-')
}

fn hex_ok(h: &str) -> bool {
    h.len() == 64 && h.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

fn path_of(dir: &Path, name: &str) -> Result<PathBuf, String> {
    if !name_ok(name) {
        return Err("열쇠 이름이 올바르지 않아요.".into());
    }
    Ok(dir.join(format!("{name}.key")))
}

/// 새로 쓴다. 이미 있고 같은 값이면 `Ok(false)`(그대로), 다른 값이면 `EXISTS` 오류.
pub fn put_in(dir: &Path, name: &str, hex: &str) -> Result<bool, String> {
    use std::io::Write;
    if !hex_ok(hex) {
        return Err("열쇠 값이 올바르지 않아요.".into());
    }
    let p = path_of(dir, name)?;
    std::fs::create_dir_all(dir).map_err(|_| "열쇠 폴더를 만들지 못했어요. 폴더 권한을 확인해 주세요.".to_string())?;
    let mut opts = std::fs::OpenOptions::new();
    opts.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    match opts.open(&p) {
        Ok(mut f) => {
            f.write_all(format!("{hex}\n").as_bytes()).map_err(|_| "열쇠를 쓰지 못했어요.".to_string())?;
            f.sync_all().map_err(|_| "열쇠를 쓰지 못했어요.".to_string())?;
            Ok(true)
        }
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => match std::fs::read_to_string(&p) {
            Ok(old) if old.trim() == hex => Ok(false),
            Ok(_) => Err("EXISTS:이 이름에는 이미 다른 열쇠가 있어요. 덮어쓰지 않았어요.".into()),
            Err(_) => Err("EXISTS:이 이름의 열쇠 파일을 읽지 못했어요. 덮어쓰지 않았어요.".into()),
        },
        Err(_) => Err("열쇠를 쓰지 못했어요. 폴더 권한을 확인해 주세요.".into()),
    }
}

pub fn get_in(dir: &Path, name: &str) -> Result<Option<String>, String> {
    let p = path_of(dir, name)?;
    match std::fs::read_to_string(&p) {
        Ok(s) => {
            let h = s.trim().to_string();
            if hex_ok(&h) { Ok(Some(h)) } else { Err("열쇠 파일이 손상됐어요. 지우거나 바꾸지 않았어요.".into()) }
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(_) => Err("열쇠 파일을 읽지 못했어요.".into()),
    }
}

/// 열쇠 파일 안에 들어갈 글(잠그기 전의 평문).
pub fn payload(asset: &str, key_hex: &str) -> String {
    json!({ "v": 1, "kind": KIND, "asset": asset, "key": key_hex }).to_string()
}
/// 풀린 글에서 (자산, 열쇠) 를 꺼낸다. 모양이 다르면 오류.
pub fn parse_payload(plain: &[u8]) -> Result<(String, String), String> {
    let v: Value = serde_json::from_slice(plain).map_err(|_| "열쇠 파일 내용이 올바르지 않아요.".to_string())?;
    let bad = || "열쇠 파일 내용이 올바르지 않아요.".to_string();
    if v["v"] != 1 || v["kind"] != KIND || v.as_object().map(|o| o.len()) != Some(4) {
        return Err(bad());
    }
    let asset = v["asset"].as_str().ok_or_else(bad)?.to_string();
    let key = v["key"].as_str().ok_or_else(bad)?.to_string();
    if !hex_ok(&key) || asset.is_empty() || asset.len() > 100 || !asset.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'_') {
        return Err(bad());
    }
    Ok((asset, key))
}

#[tauri::command]
pub fn lock_secret_put(name: String, hex: String) -> Result<Value, String> {
    let created = put_in(&store_dir(), &name, &hex)?;
    Ok(json!({ "ok": true, "created": created }))
}

#[tauri::command]
pub fn lock_secret_get(name: String) -> Result<Value, String> {
    Ok(match get_in(&store_dir(), &name)? {
        Some(h) => json!({ "hex": h }),
        None => json!({ "hex": Value::Null }),
    })
}

/// 상품 열쇠 백업 파일을 사용자가 고른 폴더에 **새 파일**로 둔다(덮어쓰기 없음). 백업 열쇠(52글자)로 잠그고, 쓴 뒤 다시 풀어 같은지 확인한다.
pub fn export_into(dir: &Path, asset: &str, dest_dir: &Path, key: &[u8; 32], stamp: &str) -> Result<(PathBuf, u64), String> {
    let hex = get_in(dir, &format!("s.{asset}"))?.ok_or_else(|| "이 상품의 열쇠가 이 컴퓨터에 없어요.".to_string())?;
    let work = dir.join(format!(".export-{}", rand::random::<u64>()));
    let plain = work.join("plain");
    let sealed = work.join("sealed");
    std::fs::create_dir_all(&work).map_err(|_| "임시 폴더를 만들지 못했어요.".to_string())?;
    let result = (|| -> Result<(PathBuf, u64), String> {
        std::fs::write(&plain, payload(asset, &hex)).map_err(|_| "임시 파일을 쓰지 못했어요.".to_string())?;
        crate::lockbox::lock_file(&plain, &sealed, key)?;
        // 다시 풀어 같은지.
        let back = work.join("back");
        crate::lockbox::unlock_file(&sealed, &back, key)?;
        if std::fs::read(&back).map_err(|_| "확인용 파일을 읽지 못했어요.".to_string())? != std::fs::read(&plain).map_err(|_| "확인용 파일을 읽지 못했어요.".to_string())? {
            return Err("백업 파일을 확인하지 못했어요. 파일을 만들지 않았어요.".into());
        }
        let name = format!("ravenvault-lockkey-{asset}-{stamp}.pxlock");
        let dest = dest_dir.join(&name);
        use std::io::Write;
        let bytes = std::fs::read(&sealed).map_err(|_| "백업 파일을 읽지 못했어요.".to_string())?;
        let mut f = std::fs::OpenOptions::new().write(true).create_new(true).open(&dest)
            .map_err(|_| "그 폴더에 새 파일을 만들지 못했어요(같은 이름이 있거나 쓸 수 없는 폴더예요).".to_string())?;
        f.write_all(&bytes).and_then(|_| f.sync_all()).map_err(|_| { let _ = std::fs::remove_file(&dest); "백업 파일을 쓰지 못했어요.".to_string() })?;
        // 쓴 파일을 다시 읽어 푼다.
        let check = work.join("check");
        let again = crate::lockbox::unlock_file(&dest, &check, key).and_then(|_| std::fs::read(&check).map_err(|_| "읽지 못했어요".to_string()));
        if again.map(|b| b == std::fs::read(&plain).unwrap_or_default()) != Ok(true) {
            let _ = std::fs::remove_file(&dest);
            return Err("쓴 파일을 다시 확인하지 못했어요. 파일을 지웠어요.".into());
        }
        Ok((dest, bytes.len() as u64))
    })();
    let _ = std::fs::remove_dir_all(&work);
    result
}

#[tauri::command]
pub fn lock_key_export(asset: String, dest: String) -> Result<Value, String> {
    if !name_ok(&asset) {
        return Err("상품 이름이 올바르지 않아요.".into());
    }
    let dest_dir = crate::walletfile::check_dest(&dest)?;
    let key = crate::lockbox::key_get_or_make()?;
    let stamp = crate::walletfile::stamp_name(std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0));
    let (path, size) = export_into(&store_dir(), &asset, &dest_dir, &key, &stamp)?;
    Ok(json!({ "ok": true, "path": path.to_string_lossy(), "folder": dest_dir.to_string_lossy(), "size": size, "verified": true }))
}

/// 백업 파일을 풀어 이 컴퓨터에 되돌린다. 같은 상품에 다른 열쇠가 이미 있으면 거절한다.
pub fn import_from(dir: &Path, file: &Path, paper: &str) -> Result<String, String> {
    let meta = std::fs::metadata(file).map_err(|_| "파일을 열 수 없어요.".to_string())?;
    if !meta.is_file() || meta.len() > MAX_FILE {
        return Err("열쇠 백업 파일이 아니에요.".into());
    }
    let k = crate::lockbox::from_paper(paper)?;
    let work = dir.join(format!(".import-{}", rand::random::<u64>()));
    std::fs::create_dir_all(&work).map_err(|_| "임시 폴더를 만들지 못했어요.".to_string())?;
    let out = work.join("plain");
    let r = crate::lockbox::unlock_file(file, &out, &k)
        .and_then(|_| std::fs::read(&out).map_err(|_| "읽지 못했어요".to_string()))
        .and_then(|b| parse_payload(&b));
    let _ = std::fs::remove_dir_all(&work);
    let (asset, key) = r?;
    put_in(dir, &format!("s.{asset}"), &key)?;
    Ok(asset)
}

#[tauri::command]
pub fn lock_key_import(file: String, key: String) -> Result<Value, String> {
    let asset = import_from(&store_dir(), Path::new(&file), &key)?;
    Ok(json!({ "ok": true, "asset": asset }))
}

/* ── 결제 거래 읽기(판매자 검사·구매자 서명 주소 찾기) ─────────────────────── */

fn sats(v: &Value) -> Option<i64> {
    // 노드는 금액을 RVN 소수로 준다. 부동소수 오차를 반올림으로 없앤다(1 RVN = 1e8 atoms).
    v.as_f64().map(|f| (f * 1e8).round() as i64).filter(|n| *n >= 0)
}

/// `getrawtransaction <txid> true` 결과와 입력이 쓴 이전 거래들 → 화면이 쓰는 요약. 순수 함수 — 시험.
pub fn tx_info_from(tx: &Value, prevs: &std::collections::HashMap<String, Value>, block_height: Option<i64>) -> Result<Value, String> {
    let bad = || "거래를 읽지 못했어요.".to_string();
    let txid = tx["txid"].as_str().ok_or_else(bad)?;
    let mut inputs: Vec<String> = Vec::new();
    for vin in tx["vin"].as_array().ok_or_else(bad)? {
        if vin.get("coinbase").is_some() {
            continue;
        }
        let prev = vin["txid"].as_str().ok_or_else(bad)?;
        let n = vin["vout"].as_u64().ok_or_else(bad)? as usize;
        let ptx = prevs.get(prev).ok_or_else(bad)?;
        let a = ptx["vout"][n]["scriptPubKey"]["addresses"][0].as_str().or_else(|| ptx["vout"][n]["scriptPubKey"]["address"].as_str());
        if let Some(a) = a {
            if !inputs.iter().any(|x| x == a) {
                inputs.push(a.to_string());
            }
        }
    }
    let mut outputs = Vec::new();
    for o in tx["vout"].as_array().ok_or_else(bad)? {
        let atoms = sats(&o["value"]).ok_or_else(bad)?;
        let script = o["scriptPubKey"]["hex"].as_str().ok_or_else(bad)?;
        outputs.push(json!({ "atoms": atoms.to_string(), "scriptHex": script }));
    }
    Ok(json!({
        "txid": txid,
        "confirmations": tx["confirmations"].as_i64().unwrap_or(0).max(0),
        "blockHeight": block_height,
        "inputAddresses": inputs,
        "outputs": outputs,
    }))
}

#[tauri::command]
pub async fn lock_tx_info(txid: String) -> Result<Value, String> {
    use crate::raven::call_rpc;
    if txid.len() != 64 || !txid.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)) {
        return Err("거래 번호가 올바르지 않아요.".into());
    }
    let tx = call_rpc("getrawtransaction", json!([txid, true])).await.map_err(|_| "노드에서 이 거래를 찾지 못했어요. 노드가 따라잡았는지 확인해 주세요.".to_string())?;
    let mut prevs = std::collections::HashMap::new();
    if let Some(vins) = tx["vin"].as_array() {
        if vins.len() > 50 {
            return Err("입력이 너무 많은 거래라 읽지 않아요.".into());
        }
        for vin in vins {
            if let Some(p) = vin["txid"].as_str() {
                if !prevs.contains_key(p) {
                    let ptx = call_rpc("getrawtransaction", json!([p, true])).await.map_err(|_| "이전 거래를 읽지 못했어요.".to_string())?;
                    prevs.insert(p.to_string(), ptx);
                }
            }
        }
    }
    let height = match tx["blockhash"].as_str() {
        Some(h) => call_rpc("getblockheader", json!([h])).await.ok().and_then(|b| b["height"].as_i64()),
        None => None,
    };
    tx_info_from(&tx, &prevs, height)
}

/* ── 암호문 구간 읽기(구매자 복호용) ────────────────────────────────────────
 * 기존 `creator_cid_read` 는 통째로 25MB 까지만 읽는다. 곡 하나가 최대 200MB 라 구간으로 읽는다(IPFS `cat?offset=&length=`).
 * 읽기 전용 — 평문은 여기를 지나지 않는다(암호문 그대로). 한 번에 8MB 까지. */
const IPFS_API: &str = "http://127.0.0.1:5001/api/v0";
pub const RANGE_MAX: u64 = 8 * 1024 * 1024;
pub const RANGE_OFFSET_MAX: u64 = 520 * 1024 * 1024;

/// 요청 구간이 허용 범위인가(순수 — 시험).
pub fn range_ok(cid: &str, offset: u64, length: u64) -> Result<(), String> {
    if !(cid.len() == 46 && cid.starts_with("Qm") && cid.bytes().all(|b| b.is_ascii_alphanumeric())) {
        return Err("CID 모양이 아니에요(Qm… 46자).".into());
    }
    if length == 0 || length > RANGE_MAX || offset > RANGE_OFFSET_MAX {
        return Err("읽을 구간이 허용 범위를 넘었어요.".into());
    }
    Ok(())
}

#[tauri::command]
pub async fn lock_cid_range(cid: String, offset: u64, length: u64) -> Result<Value, String> {
    let cid = cid.trim().to_string();
    range_ok(&cid, offset, length)?;
    let r = reqwest::Client::new()
        .post(format!("{IPFS_API}/cat?arg={cid}&offset={offset}&length={length}"))
        .timeout(std::time::Duration::from_secs(60))
        .send()
        .await
        .map_err(|_| "IPFS 에 닿지 못했어요. IPFS 가 켜져 있는지 확인해 주세요.".to_string())?;
    if !r.status().is_success() {
        return Err("이 파일을 지금 받을 수 없어요.".into());
    }
    let bytes = r.bytes().await.map_err(|_| "받는 중에 끊겼어요.".to_string())?;
    if bytes.len() as u64 > length {
        return Err("받은 크기가 요청보다 커요.".into());
    }
    Ok(json!({ "size": bytes.len(), "data": crate::cert_assets::b64_encode(&bytes) }))
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Dir(PathBuf);
    impl Dir {
        fn new(tag: &str) -> Self {
            let p = crate::paths::test_fixture_root().join(format!("lockkey-{tag}-{}", rand::random::<u32>()));
            std::fs::create_dir_all(&p).unwrap();
            Dir(p)
        }
    }
    impl Drop for Dir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
    const K1: &str = "0101010101010101010101010101010101010101010101010101010101010101";
    const K2: &str = "0202020202020202020202020202020202020202020202020202020202020202";

    #[test]
    fn names_are_restricted() {
        for ok in ["s.RV.M.SONG", "b.ab12", "k.RV.X.A_B-1"] {
            assert!(name_ok(ok), "{ok}");
        }
        for bad in ["", "a/b", "..", "a..b", "a b", "한글", &"x".repeat(121), "a\\b"] {
            assert!(!name_ok(bad), "{bad}");
        }
    }

    #[test]
    fn put_get_never_overwrites_a_different_key() {
        let d = Dir::new("put");
        assert_eq!(put_in(&d.0, "s.RV.M.SONG", K1).unwrap(), true);
        assert_eq!(get_in(&d.0, "s.RV.M.SONG").unwrap().as_deref(), Some(K1));
        assert_eq!(put_in(&d.0, "s.RV.M.SONG", K1).unwrap(), false, "same value is a no-op");
        let e = put_in(&d.0, "s.RV.M.SONG", K2).unwrap_err();
        assert!(e.starts_with("EXISTS:"), "{e}");
        assert_eq!(get_in(&d.0, "s.RV.M.SONG").unwrap().as_deref(), Some(K1), "old key untouched");
        assert_eq!(get_in(&d.0, "s.none").unwrap(), None);
        assert!(put_in(&d.0, "s.bad", "zz").is_err());
        assert!(put_in(&d.0, "../escape", K1).is_err());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(d.0.join("s.RV.M.SONG.key")).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, 0o600);
        }
        // 손상된 파일은 읽지 못하고, 덮어쓰지도 않는다.
        std::fs::write(d.0.join("s.broken.key"), "not hex").unwrap();
        assert!(get_in(&d.0, "s.broken").is_err());
        assert!(put_in(&d.0, "s.broken", K1).unwrap_err().starts_with("EXISTS:"));
    }

    #[test]
    fn payload_round_trip_and_strict_shape() {
        let p = payload("RV.M.SONG", K1);
        assert_eq!(parse_payload(p.as_bytes()).unwrap(), ("RV.M.SONG".to_string(), K1.to_string()));
        for bad in [
            r#"{"v":2,"kind":"rv-lock-product-key","asset":"RV.M.A","key":"0101010101010101010101010101010101010101010101010101010101010101"}"#,
            r#"{"v":1,"kind":"other","asset":"RV.M.A","key":"0101010101010101010101010101010101010101010101010101010101010101"}"#,
            r#"{"v":1,"kind":"rv-lock-product-key","asset":"RV.M.A","key":"short"}"#,
            r#"{"v":1,"kind":"rv-lock-product-key","asset":"RV.M.A","key":"0101010101010101010101010101010101010101010101010101010101010101","x":1}"#,
            r#"{"v":1,"kind":"rv-lock-product-key","asset":"../x","key":"0101010101010101010101010101010101010101010101010101010101010101"}"#,
            "[]", "",
        ] {
            assert!(parse_payload(bad.as_bytes()).is_err(), "{bad}");
        }
    }

    #[test]
    fn export_then_import_restores_the_key_and_refuses_wrong_paper_key() {
        let d = Dir::new("export");
        let store = d.0.join("store");
        let dest = d.0.join("dest");
        std::fs::create_dir_all(&dest).unwrap();
        put_in(&store, "s.RV.M.SONG", K1).unwrap();
        let backup_key = [9u8; 32];
        let (path, size) = export_into(&store, "RV.M.SONG", &dest, &backup_key, "20261013-000000").unwrap();
        assert!(path.file_name().unwrap().to_string_lossy().ends_with(".pxlock"));
        assert!(size > 0 && size < MAX_FILE);
        // 파일에는 열쇠 글자가 평문으로 없다.
        let raw = std::fs::read(&path).unwrap();
        assert!(!String::from_utf8_lossy(&raw).contains(K1));
        // 같은 이름으로 다시 내보내면 덮어쓰지 않고 거절.
        assert!(export_into(&store, "RV.M.SONG", &dest, &backup_key, "20261013-000000").is_err());
        assert_eq!(std::fs::read(&path).unwrap(), raw, "existing backup untouched");
        // 다른 컴퓨터(빈 저장소)로 되돌린다.
        let fresh = d.0.join("fresh");
        let paper = crate::lockbox::to_paper(&backup_key);
        assert_eq!(import_from(&fresh, &path, &paper).unwrap(), "RV.M.SONG");
        assert_eq!(get_in(&fresh, "s.RV.M.SONG").unwrap().as_deref(), Some(K1));
        // 틀린 52글자 열쇠 → 거절, 아무것도 안 둠.
        let other = d.0.join("other");
        assert!(import_from(&other, &path, &crate::lockbox::to_paper(&[8u8; 32])).is_err());
        assert_eq!(get_in(&other, "s.RV.M.SONG").unwrap(), None);
        // 이미 다른 열쇠가 있는 상품에는 덮어쓰지 않는다.
        let clash = d.0.join("clash");
        put_in(&clash, "s.RV.M.SONG", K2).unwrap();
        assert!(import_from(&clash, &path, &paper).unwrap_err().starts_with("EXISTS:"));
        assert_eq!(get_in(&clash, "s.RV.M.SONG").unwrap().as_deref(), Some(K2));
        // 임시 평문은 남지 않는다.
        for sub in [&store, &fresh, &other, &clash] {
            for e in std::fs::read_dir(sub).unwrap().flatten() {
                assert!(!e.file_name().to_string_lossy().starts_with('.'), "temp left: {:?}", e.file_name());
            }
        }
        // 열쇠 없는 상품은 내보낼 수 없다.
        assert!(export_into(&store, "RV.M.NONE", &dest, &backup_key, "x").is_err());
        // 큰 파일·가짜 파일.
        let junk = d.0.join("junk.pxlock");
        std::fs::write(&junk, vec![0u8; 5000]).unwrap();
        assert!(import_from(&fresh, &junk, &paper).is_err());
    }

    #[test]
    fn range_requests_are_bounded() {
        let cid = format!("Qm{}", "a".repeat(44));
        assert!(range_ok(&cid, 0, 65576).is_ok());
        assert!(range_ok(&cid, RANGE_OFFSET_MAX, RANGE_MAX).is_ok());
        for (c, o, l) in [("x", 0, 10), (cid.as_str(), 0, 0), (cid.as_str(), 0, RANGE_MAX + 1), (cid.as_str(), RANGE_OFFSET_MAX + 1, 10)] {
            assert!(range_ok(c, o, l).is_err(), "{c} {o} {l}");
        }
        assert!(range_ok(&format!("Qm{}/../x", "a".repeat(40)), 0, 10).is_err());
    }

    #[test]
    fn tx_info_reads_inputs_outputs_and_confirmations() {
        let tx = json!({ "txid": "aa", "confirmations": 7,
            "vin": [{ "txid": "p1", "vout": 1 }, { "txid": "p1", "vout": 0 }, { "coinbase": "00" }],
            "vout": [{ "value": 285.0, "scriptPubKey": { "hex": "76a914aa88ac" } }, { "value": 0.00000001, "scriptPubKey": { "hex": "6a02aabb" } }] });
        let mut prevs = std::collections::HashMap::new();
        prevs.insert("p1".to_string(), json!({ "vout": [{ "scriptPubKey": { "addresses": ["RAAA"] } }, { "scriptPubKey": { "addresses": ["RBBB"] } }] }));
        let info = tx_info_from(&tx, &prevs, Some(2000)).unwrap();
        assert_eq!(info["confirmations"], 7);
        assert_eq!(info["blockHeight"], 2000);
        assert_eq!(info["inputAddresses"], json!(["RBBB", "RAAA"]));
        assert_eq!(info["outputs"][0]["atoms"], "28500000000");
        assert_eq!(info["outputs"][1]["atoms"], "1");
        // 이전 거래를 못 읽으면 지어내지 않고 오류.
        assert!(tx_info_from(&tx, &std::collections::HashMap::new(), None).is_err());
        // 멤풀 거래: confirmations 없음 → 0, 블록 높이 null.
        let mem = json!({ "txid": "bb", "vin": [], "vout": [] });
        let m = tx_info_from(&mem, &std::collections::HashMap::new(), None).unwrap();
        assert_eq!((m["confirmations"].as_i64(), m["blockHeight"].is_null()), (Some(0), true));
    }
}
