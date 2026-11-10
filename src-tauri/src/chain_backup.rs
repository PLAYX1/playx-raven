//! 체인 POS ④ — 백업 두 곳(본점 + 이웃 매장 1곳) (docs/CHAIN-POS.md).
//!
//! * 매장 매출 로그의 두 번째 사본은 이미 본점에 있다(③). 남은 것은 **본점의 chain/ 폴더** —
//!   발급 기록(issued.json)·끊기 목록(revocations.json)·받은 매출(sales/)·백업 설정(backup.json).
//! * 본점은 그것을 묶어(gzip JSON) **백업 열쇠**로 봉한다: key = HKDF-SHA256(salt `ravenvault-chain-backup-v1`,
//!   ikm = 체인 비밀, info = 체인 공개키) → XChaCha20-Poly1305(AAD = `RVCHB1\n<체인키>`). 본점 PC 는 체인 비밀이
//!   손에 있을 때 이 열쇠만 `chain/backup-key.json`(0600)에 둔다(③ sales-keys.json 과 같은 방식). 새 PC 에서는
//!   **12단어로 다시 만든다** — 그래서 12단어 없이는 아무도 열지 못하고, 봉함이 열리면 본점이 만든 것이다(위조 불가).
//! * 🔴 담지 않는 것: `sales-keys.json`·`backup-key.json`(열쇠 — 12단어로 다시 만든다) · `store.json`(매장 비밀) · 12단어 ·
//!   `backup/`·`held/`(백업 자신) · 그 밖에 정해진 이름이 아닌 파일 전부(허용 목록).
//! * 맡는 매장(이웃 1곳)은 본점이 정한다(`backup.json`). 그 매장이 ③ 보내기를 할 때 본점 답에 백업 요약(해시·크기·때)이
//!   실려 오고, 다르면 조각(384KiB)씩 받아 `chain/held/` 에 둔다. 매장은 해시만 맞춰 보고 **열 수 없다**.
//! * 새 본점 PC: 12단어로 지갑을 되살린 뒤 「본점 백업 되살리기」 → 맡은 매장에서 파일로 받아 온 백업을 고른다 →
//!   체인 비밀로 열고, 증서·끊기 목록 서명을 확인하고, 데이터 열쇠를 12단어로 다시 만든다.

use crate::chain_sales::{hkdf_key, key_from_hex, key_hex, open_raw, seal_raw, DataKey};
use crate::chain_store as cs;
use base64::{engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD}, Engine as _};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

pub const MAGIC: &[u8] = b"RVCHB1\n";
const KDF_SALT: &[u8] = b"ravenvault-chain-backup-v1";
const TEXT_PREFIX: &str = "rvchainbak1-";
/// 본점이 백업을 다시 묶는 간격.
pub const BUILD_EVERY_MS: i64 = 6 * 3600_000;
/// 한 번에 건네는 조각.
pub const CHUNK: usize = 384 * 1024;
/// 봉한 백업 · 풀어 놓은 내용의 상한(이보다 크면 묶지도 받지도 않는다).
pub const MAX_BLOB: u64 = 256 * 1024 * 1024;
const MAX_PLAIN: u64 = 512 * 1024 * 1024;
/// 맨 위에서 담는 파일(허용 목록). sales-keys.json 은 일부러 없다.
const TOP_FILES: [&str; 3] = ["issued.json", "revocations.json", "backup.json"];

pub const ERR_NOT_OWNER: &str = "이 컴퓨터는 본점이 아니에요.";
pub const ERR_NOT_STORE: &str = "이 컴퓨터는 체인 매장이 아니에요.";
pub const ERR_STORE_NUMBER: &str = "그 번호의 매장이 없거나 끊긴 매장이에요.";
pub const ERR_SAVE: &str = "이 컴퓨터에 저장하지 못했어요. 디스크 공간과 권한을 확인해 주세요.";
pub const ERR_FILE: &str = "본점 백업 파일이 아니거나 망가졌어요. 맡은 매장에서 다시 저장해 와 주세요.";
pub const ERR_OTHER_CHAIN: &str = "이 백업은 다른 12단어(다른 본점)의 것이라 열 수 없어요.";
pub const ERR_HAVE_HEAD: &str = "이 컴퓨터에는 이미 본점 기록이 있어요. 되살리기는 새 컴퓨터에서만 할 수 있어요.";
pub const ERR_IS_STORE: &str = "이 컴퓨터는 매장으로 연결돼 있어요. 본점 백업은 본점이 될 컴퓨터에서 되살려 주세요.";
pub const ERR_NO_HELD: &str = "이 매장이 맡아 둔 본점 백업이 아직 없어요.";
pub const ERR_TOO_BIG: &str = "본점 백업이 너무 커요.";
pub const ERR_NEED_KEY: &str = "본점 백업 열쇠가 아직 없어요. 12단어로 한 번 준비해 주세요.";

fn read_json(p: &Path) -> Option<Value> {
    serde_json::from_slice(&std::fs::read(p).ok()?).ok()
}
fn write_bytes(p: &Path, b: &[u8]) -> Result<(), &'static str> {
    if let Some(d) = p.parent() {
        std::fs::create_dir_all(d).map_err(|_| ERR_SAVE)?;
    }
    crate::server::atomic_write_0600(p, b).map_err(|_| ERR_SAVE)
}
fn write_json(p: &Path, v: &Value) -> Result<(), &'static str> {
    write_bytes(p, &serde_json::to_vec_pretty(v).map_err(|_| ERR_SAVE)?)
}
fn sha_hex(b: &[u8]) -> String {
    hex::encode(Sha256::digest(b))
}

// ── 어떤 파일을 담는가 (허용 목록) ─────────────────────────────────

fn plain_name(s: &str) -> bool {
    !s.is_empty() && s.len() <= 64 && !s.starts_with('.')
        && s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'-' || b == b'_')
        && (s.ends_with(".json") || s.ends_with(".jsonl"))
}
fn digits(s: &str) -> bool {
    (1..=4).contains(&s.len()) && s.bytes().all(|b| b.is_ascii_digit())
}
fn hex32(s: &str) -> bool {
    s.len() == 32 && s.bytes().all(|b| b.is_ascii_hexdigit())
}

/// 백업에 들어가도 되는 상대 경로인가(담을 때·되살릴 때 둘 다 이 한 함수로).
pub fn allowed_rel(rel: &str) -> bool {
    let parts: Vec<&str> = rel.split('/').collect();
    match parts.as_slice() {
        [top] => TOP_FILES.contains(top),
        ["sales", f] => plain_name(f),
        ["sales", n, f] => digits(n) && plain_name(f),
        ["sales", n, log, f] => digits(n) && hex32(log) && plain_name(f),
        _ => false,
    }
}

fn is_plain_file(p: &Path) -> bool {
    std::fs::symlink_metadata(p).is_ok_and(|m| m.file_type().is_file())
}
fn is_plain_dir(p: &Path) -> bool {
    std::fs::symlink_metadata(p).is_ok_and(|m| m.file_type().is_dir())
}

/// 본점 chain/ 폴더에서 담을 파일들(상대 경로 → 바이트). 바로가기(심볼릭 링크)는 따라가지 않는다.
fn collect(dir: &Path) -> Vec<(String, Vec<u8>)> {
    let mut out = Vec::new();
    for f in TOP_FILES {
        let p = dir.join(f);
        if is_plain_file(&p) {
            if let Ok(b) = std::fs::read(&p) {
                out.push((f.to_string(), b));
            }
        }
    }
    fn walk(base: &Path, rel: &str, depth: usize, out: &mut Vec<(String, Vec<u8>)>) {
        let Ok(rd) = std::fs::read_dir(base.join(rel)) else { return };
        let mut names: Vec<String> = rd.flatten().filter_map(|e| e.file_name().to_str().map(String::from)).collect();
        names.sort();
        for n in names {
            let r = format!("{rel}/{n}");
            let p = base.join(&r);
            if is_plain_dir(&p) && depth < 2 {
                walk(base, &r, depth + 1, out);
            } else if is_plain_file(&p) && allowed_rel(&r) {
                if let Ok(b) = std::fs::read(&p) {
                    out.push((r, b));
                }
            }
        }
    }
    walk(dir, "sales", 0, &mut out);
    out
}

// ── 봉하기 · 열기 ───────────────────────────────────────────────────

/// 백업 열쇠 = HKDF-SHA256(salt `ravenvault-chain-backup-v1`, ikm = 체인 비밀, info = 체인 공개키).
/// 12단어만 있으면 언제든 다시 만들 수 있다. 본점은 체인 비밀이 손에 있을 때(매장 만들기·받을 준비·맡기기) 이 열쇠만
/// `chain/backup-key.json`(0600)에 둔다 — `sales-keys.json` 과 같은 자리·같은 등급. 백업에는 들어가지 않는다.
/// 🔸 공개키에게 봉하기(ECIES)를 쓰지 않은 이유: 체인 공개키는 공개라 **누구나** 그럴듯한 백업을 만들 수 있다(맡은 매장이
///    가짜 매출을 끼운 백업으로 바꿔치기). 대칭 열쇠는 봉함이 곧 「본점(또는 12단어)이 만들었다」는 증명이다.
fn derive_backup_key(chain_sk: &[u8; 32]) -> Option<(String, DataKey)> {
    let chain = cs::pubkey(chain_sk).ok()?;
    let k = hkdf_key(KDF_SALT, chain_sk, chain.as_bytes())?;
    Some((chain, k))
}
fn key_file(dir: &Path) -> PathBuf {
    dir.join("backup-key.json")
}
/// 본점: 체인 비밀이 손에 있을 때 백업 열쇠를 적어 둔다.
pub fn remember_key_in(dir: &Path, chain_sk: &[u8; 32]) -> Result<(), &'static str> {
    let (chain, k) = derive_backup_key(chain_sk).ok_or(ERR_SAVE)?;
    let mut h = key_hex(&k);
    let r = write_json(&key_file(dir), &json!({ "v": 1, "chain": chain, "key": h }));
    crate::words::wipe(&mut h);
    r
}
fn load_key(dir: &Path, chain: &str) -> Option<DataKey> {
    let mut v = read_json(&key_file(dir))?;
    let out = (v.get("chain").and_then(Value::as_str) == Some(chain)).then(|| v.get("key").and_then(Value::as_str).and_then(key_from_hex)).flatten();
    if let Some(Value::String(s)) = v.get_mut("key") {
        crate::words::wipe(s);
    }
    out
}
/// 본점에 백업 열쇠가 아직 없는가(12단어 한 번 필요).
pub fn needs_key(dir: &Path) -> bool {
    cs::load_history(dir).is_some_and(|(chain, _)| load_key(dir, &chain).is_none())
}

fn aad(chain: &str) -> Vec<u8> {
    [MAGIC, chain.as_bytes()].concat()
}

/// 내용(JSON)을 백업 열쇠로 봉한다 = MAGIC | nonce | 암호문(gzip).
pub fn seal_backup(key: &DataKey, chain: &str, plain: &[u8]) -> Option<Vec<u8>> {
    let mut gz = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
    gz.write_all(plain).ok()?;
    let packed = gz.finish().ok()?;
    let sealed = seal_raw(key, &aad(chain), &packed)?;
    Some([MAGIC, &sealed].concat())
}

/// 체인 비밀(12단어)로 연다 → 풀어 놓은 내용. 다른 12단어·바뀐 바이트·남이 만든 백업은 못 연다.
pub fn open_with_chain(chain_sk: &[u8; 32], blob: &[u8]) -> Result<Vec<u8>, &'static str> {
    let (chain, key) = derive_backup_key(chain_sk).ok_or(ERR_FILE)?;
    if blob.len() < MAGIC.len() + 40 || &blob[..MAGIC.len()] != MAGIC || blob.len() as u64 > MAX_BLOB {
        return Err(ERR_FILE);
    }
    let packed = open_raw(&key, &aad(&chain), &blob[MAGIC.len()..]).ok_or(ERR_OTHER_CHAIN)?;
    let mut plain = Vec::new();
    flate2::read::GzDecoder::new(&packed[..]).take(MAX_PLAIN + 1).read_to_end(&mut plain).map_err(|_| ERR_FILE)?;
    if plain.len() as u64 > MAX_PLAIN {
        return Err(ERR_TOO_BIG);
    }
    Ok(plain)
}

pub fn to_text(blob: &[u8]) -> String {
    format!("{TEXT_PREFIX}{}", URL_SAFE_NO_PAD.encode(blob))
}
pub fn from_text(text: &str) -> Result<Vec<u8>, &'static str> {
    let t = text.trim();
    if t.len() as u64 > MAX_BLOB * 4 / 3 + 64 {
        return Err(ERR_TOO_BIG);
    }
    URL_SAFE_NO_PAD.decode(t.strip_prefix(TEXT_PREFIX).ok_or(ERR_FILE)?).map_err(|_| ERR_FILE)
}

// ── 본점: 맡길 매장 · 묶기 · 건네기 ─────────────────────────────────

fn setting_file(dir: &Path) -> PathBuf {
    dir.join("backup.json")
}
fn out_bin(dir: &Path) -> PathBuf {
    dir.join("backup").join("out.rvb")
}
fn out_meta(dir: &Path) -> PathBuf {
    dir.join("backup").join("out.json")
}
fn setting(dir: &Path) -> Value {
    read_json(&setting_file(dir)).filter(Value::is_object).unwrap_or_else(|| json!({ "v": 1, "store": null }))
}
/// 맡는 매장 번호(본점이 정한 것).
pub fn keeper(dir: &Path) -> Option<u32> {
    setting(dir).get("store").and_then(Value::as_u64).map(|n| n as u32)
}

/// 끊기지 않은 매장 번호들.
fn live_stores(dir: &Path) -> Vec<u32> {
    let Some((chain, certs)) = cs::load_history(dir) else { return Vec::new() };
    let revoked = cs::load_list(dir, &chain).map(|(_, i)| i.revoked).unwrap_or_default();
    let mut v: Vec<u32> = certs.iter()
        .filter(|c| !c.get("serial").and_then(Value::as_u64).is_some_and(|s| revoked.contains(&cs::store_cert_id(&chain, s))))
        .filter_map(|c| c.get("store").and_then(Value::as_u64).map(|n| n as u32)).collect();
    v.sort();
    v.dedup();
    v
}

/// 본점: 맡을 매장을 정한다(None = 안 맡김).
pub fn set_keeper_in(dir: &Path, store: Option<u32>) -> Result<Value, &'static str> {
    if cs::load_history(dir).is_none() {
        return Err(ERR_NOT_OWNER);
    }
    if store.is_some_and(|n| !live_stores(dir).contains(&n)) {
        return Err(ERR_STORE_NUMBER);
    }
    let mut s = setting(dir);
    if s.get("store").and_then(Value::as_u64) != store.map(u64::from) {
        // 맡는 곳이 바뀌면 「건넸다」 표시는 지운다.
        s["deliveredHash"] = Value::Null;
        s["deliveredAt"] = Value::Null;
    }
    s["v"] = json!(1);
    s["store"] = json!(store);
    write_json(&setting_file(dir), &s)?;
    Ok(owner_status_in(dir))
}

/// 본점: 지금 묶는다(받기 잠금 안에서 — 반쯤 쓴 줄을 담지 않게).
pub fn build_in(dir: &Path, now: i64) -> Result<Value, &'static str> {
    let (chain, _) = cs::load_history(dir).ok_or(ERR_NOT_OWNER)?;
    let files = crate::chain_sales::with_receive_lock(dir, || collect(dir)).ok_or(ERR_SAVE)?;
    let map: Map<String, Value> = files.iter().map(|(k, b)| (k.clone(), json!(STANDARD.encode(b)))).collect();
    let plain = serde_json::to_vec(&json!({ "v": 1, "kind": "chain-backup", "chain": chain, "at": now, "files": map })).map_err(|_| ERR_SAVE)?;
    if plain.len() as u64 > MAX_PLAIN {
        return Err(ERR_TOO_BIG);
    }
    let key = load_key(dir, &chain).ok_or(ERR_NEED_KEY)?;
    let blob = seal_backup(&key, &chain, &plain).ok_or(ERR_SAVE)?;
    if blob.len() as u64 > MAX_BLOB {
        return Err(ERR_TOO_BIG);
    }
    write_bytes(&out_bin(dir), &blob)?;
    let meta = json!({ "v": 1, "hash": sha_hex(&blob), "size": blob.len(), "at": now, "files": files.len() });
    write_json(&out_meta(dir), &meta)?;
    Ok(meta)
}

/// 본점 배경: 맡는 매장이 있고 마지막 묶음이 6시간 넘었으면 다시 묶는다.
pub fn build_if_due_in(dir: &Path, now: i64) -> bool {
    if keeper(dir).is_none() || cs::load_history(dir).is_none() {
        return false;
    }
    let at = read_json(&out_meta(dir)).and_then(|m| m.get("at").and_then(Value::as_i64));
    let due = at.is_none_or(|a| now - a >= BUILD_EVERY_MS || now < a) || !out_bin(dir).exists();
    due && build_in(dir, now).is_ok()
}

/// 본점 답(봉함 안)에 싣는 요약 — 맡는 매장에게만.
pub fn offer_for(dir: &Path, store: u32) -> Option<Value> {
    if keeper(dir) != Some(store) {
        return None;
    }
    let m = read_json(&out_meta(dir))?;
    Some(json!({ "hash": m.get("hash")?, "size": m.get("size")?, "at": m.get("at")? }))
}

/// 본점: 조각 하나(`op: "backup"`). 맡는 매장이 아니면 `{none:true}`.
pub fn chunk_reply(dir: &Path, store: u32, offset: u64, now: i64) -> Value {
    let Some(offer) = offer_for(dir, store) else { return json!({ "none": true }) };
    let Ok(blob) = std::fs::read(out_bin(dir)) else { return json!({ "none": true }) };
    let hash = offer["hash"].as_str().unwrap_or("");
    if sha_hex(&blob) != hash || offset > blob.len() as u64 {
        return json!({ "none": true });
    }
    let start = offset as usize;
    let end = (start + CHUNK).min(blob.len());
    if end == blob.len() {
        // 마지막 조각을 건넸다(받았는지는 매장의 다음 요약 비교로 다시 맞춰진다).
        let mut s = setting(dir);
        s["deliveredHash"] = json!(hash);
        s["deliveredAt"] = json!(now);
        let _ = write_json(&setting_file(dir), &s);
    }
    json!({ "hash": hash, "size": blob.len(), "at": offer["at"], "offset": offset, "data": STANDARD.encode(&blob[start..end]) })
}

/// 본점 화면용(비밀·금액 없음).
pub fn owner_status_in(dir: &Path) -> Value {
    let s = setting(dir);
    let m = read_json(&out_meta(dir));
    let hash = m.as_ref().and_then(|m| m.get("hash").cloned()).unwrap_or(Value::Null);
    json!({
        "store": s.get("store").cloned().unwrap_or(Value::Null),
        "stores": live_stores(dir),
        "builtAt": m.as_ref().and_then(|m| m.get("at").cloned()),
        "size": m.as_ref().and_then(|m| m.get("size").cloned()),
        "deliveredAt": s.get("deliveredAt").cloned(),
        "delivered": !hash.is_null() && s.get("deliveredHash") == Some(&hash),
        "needKey": needs_key(dir),
    })
}

// ── 맡는 매장 (이웃) ────────────────────────────────────────────────

fn held_dir(chain_dir: &Path) -> PathBuf {
    chain_dir.join("held")
}
fn held_meta(chain_dir: &Path) -> Option<Value> {
    read_json(&held_dir(chain_dir).join("held.json"))
}

/// 맡아 둔 본점 백업(열 수 없다 — 크기·때만).
pub fn held_status_in(chain_dir: &Path) -> Value {
    match held_meta(chain_dir) {
        Some(m) => json!({ "at": m.get("at"), "size": m.get("size"), "gotAt": m.get("gotAt") }),
        None => Value::Null,
    }
}

/// 본점 요약을 보고 받을 조각의 시작점. 이미 같은 것을 갖고 있으면 None.
pub fn want_offset(chain_dir: &Path, offer: &Value) -> Option<u64> {
    let hash = offer.get("hash")?.as_str()?;
    let size = offer.get("size")?.as_u64()?;
    if hash.len() != 64 || size == 0 || size > MAX_BLOB {
        return None;
    }
    if held_meta(chain_dir).and_then(|m| m.get("hash").and_then(Value::as_str).map(String::from)).as_deref() == Some(hash) {
        return None;
    }
    let part = read_json(&held_dir(chain_dir).join("part.json"));
    let got = part.filter(|p| p.get("hash").and_then(Value::as_str) == Some(hash)).and_then(|p| p.get("got").and_then(Value::as_u64));
    let on_disk = std::fs::metadata(held_dir(chain_dir).join("part.rvb")).map(|m| m.len()).ok();
    Some(match (got, on_disk) {
        (Some(g), Some(d)) if g == d && g < size => g,
        _ => 0,
    })
}

/// 조각 하나를 받아 둔다. 다 모이면 해시를 맞춰 보고 `held/head.rvb` 로 바꾼다. → Ok(true) = 다 받음.
pub fn take_chunk_in(chain_dir: &Path, reply: &Value, now: i64) -> Result<bool, &'static str> {
    let (Some(hash), Some(size), Some(offset), Some(data)) = (
        reply.get("hash").and_then(Value::as_str), reply.get("size").and_then(Value::as_u64),
        reply.get("offset").and_then(Value::as_u64), reply.get("data").and_then(Value::as_str),
    ) else { return Err(ERR_FILE) };
    if hash.len() != 64 || size > MAX_BLOB {
        return Err(ERR_FILE);
    }
    let bytes = STANDARD.decode(data).map_err(|_| ERR_FILE)?;
    if bytes.len() > CHUNK || offset + bytes.len() as u64 > size {
        return Err(ERR_FILE);
    }
    let hd = held_dir(chain_dir);
    std::fs::create_dir_all(&hd).map_err(|_| ERR_SAVE)?;
    let part = hd.join("part.rvb");
    let mut oo = std::fs::OpenOptions::new();
    oo.create(true).write(true);
    if offset == 0 {
        oo.truncate(true);
    } else {
        oo.append(true);
        let have = std::fs::metadata(&part).map(|m| m.len()).unwrap_or(0);
        let ok = read_json(&hd.join("part.json")).is_some_and(|p| p.get("hash").and_then(Value::as_str) == Some(hash)) && have == offset;
        if !ok {
            return Err(ERR_FILE);
        }
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        oo.mode(0o600);
    }
    let mut f = oo.open(&part).map_err(|_| ERR_SAVE)?;
    f.write_all(&bytes).and_then(|_| f.sync_data()).map_err(|_| ERR_SAVE)?;
    drop(f);
    let got = offset + bytes.len() as u64;
    write_json(&hd.join("part.json"), &json!({ "hash": hash, "size": size, "got": got }))?;
    if got < size {
        return Ok(false);
    }
    let blob = std::fs::read(&part).map_err(|_| ERR_SAVE)?;
    if sha_hex(&blob) != hash || &blob[..MAGIC.len().min(blob.len())] != MAGIC {
        let _ = std::fs::remove_file(&part);
        let _ = std::fs::remove_file(hd.join("part.json"));
        return Err(ERR_FILE);
    }
    std::fs::rename(&part, hd.join("head.rvb")).map_err(|_| ERR_SAVE)?;
    let _ = std::fs::remove_file(hd.join("part.json"));
    write_json(&hd.join("held.json"), &json!({ "v": 1, "hash": hash, "size": size, "at": reply.get("at"), "gotAt": now }))?;
    Ok(true)
}

/// 맡아 둔 백업을 글자로(USB 로 새 본점 PC 에 옮길 파일). 해시가 맞을 때만.
pub fn held_text_in(chain_dir: &Path) -> Result<String, &'static str> {
    let m = held_meta(chain_dir).ok_or(ERR_NO_HELD)?;
    let blob = std::fs::read(held_dir(chain_dir).join("head.rvb")).map_err(|_| ERR_NO_HELD)?;
    if m.get("hash").and_then(Value::as_str) != Some(sha_hex(&blob).as_str()) {
        return Err(ERR_NO_HELD);
    }
    Ok(to_text(&blob))
}

// ── 새 본점 PC: 되살리기 ────────────────────────────────────────────

/// 봉한 백업을 체인 비밀로 열어 이 컴퓨터의 chain/ 폴더에 되살린다. 데이터 열쇠는 체인 비밀로 다시 만든다.
/// 이미 본점·매장인 컴퓨터는 거절(덮어쓰지 않는다). issued.json 은 맨 마지막에 쓴다(반쯤 되살린 PC 가 본점으로 보이지 않게).
pub fn restore_in(dir: &Path, chain_sk: &[u8; 32], blob: &[u8]) -> Result<Value, String> {
    if dir.join("issued.json").exists() {
        return Err(ERR_HAVE_HEAD.into());
    }
    if dir.join("store.json").exists() {
        return Err(ERR_IS_STORE.into());
    }
    let chain = cs::pubkey(chain_sk).map_err(|_| ERR_FILE.to_string())?;
    let plain = open_with_chain(chain_sk, blob)?;
    let doc: Value = serde_json::from_slice(&plain).map_err(|_| ERR_FILE.to_string())?;
    if doc.get("kind").and_then(Value::as_str) != Some("chain-backup") || doc.get("v").and_then(Value::as_u64) != Some(1) {
        return Err(ERR_FILE.into());
    }
    if doc.get("chain").and_then(Value::as_str) != Some(chain.as_str()) {
        return Err(ERR_OTHER_CHAIN.into());
    }
    let files = doc.get("files").and_then(Value::as_object).ok_or(ERR_FILE)?;
    let mut decoded: Vec<(String, Vec<u8>)> = Vec::new();
    for (rel, b) in files {
        if !allowed_rel(rel) {
            return Err(ERR_FILE.into());
        }
        decoded.push((rel.clone(), STANDARD.decode(b.as_str().ok_or(ERR_FILE)?).map_err(|_| ERR_FILE.to_string())?));
    }
    let get = |name: &str| decoded.iter().find(|(r, _)| r == name).and_then(|(_, b)| serde_json::from_slice::<Value>(b).ok());
    let issued = get("issued.json").ok_or(ERR_FILE)?;
    let certs = issued.get("certs").and_then(Value::as_array).ok_or(ERR_FILE)?;
    if issued.get("chain").and_then(Value::as_str) != Some(chain.as_str()) || !certs.iter().all(|c| cs::cert_signed_ok(c, &chain)) {
        return Err(ERR_FILE.into());
    }
    if !get("revocations.json").is_some_and(|l| cs::list_ok(&l, &chain)) {
        return Err(ERR_FILE.into());
    }
    std::fs::create_dir_all(dir).map_err(|_| ERR_SAVE.to_string())?;
    for (rel, b) in decoded.iter().filter(|(r, _)| r != "issued.json") {
        write_bytes(&dir.join(rel), b)?;
    }
    let raw_issued = decoded.iter().find(|(r, _)| r == "issued.json").map(|(_, b)| b.clone()).unwrap_or_default();
    write_bytes(&dir.join("issued.json"), &raw_issued)?;
    // 데이터 열쇠(백업에 없다)를 12단어(체인 비밀)로 다시 만든다 — 끊긴 매장 것은 만들지 않는다.
    let burned = cs::burned_keys(dir);
    let mut keys: Vec<String> = certs.iter().filter_map(|c| c.get("storeKey").and_then(Value::as_str).map(String::from)).filter(|k| !burned.contains(k)).collect();
    keys.sort();
    keys.dedup();
    let mut made = 0;
    for k in &keys {
        if crate::chain_sales::remember_key_in(dir, chain_sk, k).is_ok() {
            made += 1;
        }
    }
    let _ = remember_key_in(dir, chain_sk);
    Ok(json!({ "ok": true, "stores": certs.len(), "files": decoded.len(), "keys": made, "at": doc.get("at") }))
}

// ── 명령 ─────────────────────────────────────────────────────────────

fn now_ms() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_millis() as i64)
}
fn refuse_locked() -> Result<(), String> {
    if crate::app_lock::is_locked() {
        Err(crate::storesign::ERR_LOCKED.into())
    } else {
        Ok(())
    }
}

/// 본점: 백업을 맡을 매장(None = 안 맡김). 정하면 바로 한 번 묶는다. 백업 열쇠가 없으면 12단어를 한 번 받는다.
#[tauri::command]
pub async fn chain_backup_set(store: Option<u32>) -> Result<Value, String> {
    refuse_locked()?;
    let dir = cs::chain_dir_path();
    set_keeper_in(&dir, store)?;
    if store.is_none() {
        return Ok(owner_status_in(&dir));
    }
    if needs_key(&dir) {
        let (mut chain_sk, _) = cs::owner_keys(None, Vec::new()).await?;
        let r = remember_key_in(&dir, &chain_sk);
        crate::words::wipe_bytes(&mut chain_sk);
        r?;
    }
    let d = dir.clone();
    tokio::task::spawn_blocking(move || build_in(&d, now_ms())).await.map_err(|_| ERR_SAVE.to_string())??;
    Ok(owner_status_in(&dir))
}

/// 맡은 매장: 본점 백업을 파일로(USB 로 새 본점 컴퓨터에). 열 수 없는 봉한 글자 그대로.
#[tauri::command(async)]
pub fn chain_backup_held_save(path: String) -> Result<Value, String> {
    refuse_locked()?;
    let dir = cs::chain_dir_path();
    if cs::store_self_in(&dir).is_none() {
        return Err(ERR_NOT_STORE.into());
    }
    let p = PathBuf::from(&path);
    if !p.is_absolute() || !p.file_name().and_then(|f| f.to_str()).is_some_and(|f| f.ends_with(".rvchainbak.txt")) {
        return Err(ERR_SAVE.into());
    }
    let text = held_text_in(&dir)?;
    crate::server::atomic_write_0600(&p, format!("{text}\n").as_bytes()).map_err(|_| ERR_SAVE.to_string())?;
    Ok(json!({ "path": path }))
}

/// 새 본점 컴퓨터: 맡은 매장에서 받아 온 백업 파일로 본점 기록을 되살린다(12단어 한 번 — 체인 열쇠는 쓰고 바로 지운다).
#[tauri::command]
pub async fn chain_backup_restore(path: String) -> Result<Value, String> {
    refuse_locked()?;
    let dir = cs::chain_dir_path();
    if dir.join("issued.json").exists() {
        return Err(ERR_HAVE_HEAD.into());
    }
    if dir.join("store.json").exists() {
        return Err(ERR_IS_STORE.into());
    }
    let p = PathBuf::from(&path);
    let meta = std::fs::metadata(&p).map_err(|_| ERR_FILE.to_string())?;
    if !meta.is_file() || meta.len() > MAX_BLOB * 4 / 3 + 64 {
        return Err(ERR_FILE.into());
    }
    let text = std::fs::read_to_string(&p).map_err(|_| ERR_FILE.to_string())?;
    let blob = from_text(&text)?;
    let (mut chain_sk, _) = cs::owner_keys(None, Vec::new()).await?;
    let sk = chain_sk;
    let r = tokio::task::spawn_blocking(move || {
        let mut sk = sk;
        let r = restore_in(&dir, &sk, &blob);
        crate::words::wipe_bytes(&mut sk);
        r
    }).await.map_err(|_| ERR_SAVE.to_string());
    crate::words::wipe_bytes(&mut chain_sk);
    r?
}

#[cfg(test)]
mod tests {
    use super::*;

    const WORDS: &str = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
    const NOW: i64 = 1_790_000_000_000;

    fn fresh(name: &str) -> PathBuf {
        let d = crate::paths::test_fixture_root().join(format!("chain-backup-{name}"));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn allow_list_takes_only_known_names() {
        for ok in ["issued.json", "revocations.json", "backup.json", "sales/rejects.jsonl", "sales/7/state.json",
            "sales/7/0123456789abcdef0123456789abcdef/202611.jsonl", "sales/7/0123456789abcdef0123456789abcdef/index.json"] {
            assert!(allowed_rel(ok), "{ok}");
        }
        for bad in ["sales-keys.json", "store.json", "talkkey.json", "../x.json", "sales/../issued.json", "/etc/passwd", "sales/7/.lock",
            "backup/out.rvb", "held/head.rvb", "sales/abc/state.json", "sales/7/xyz/202611.jsonl", "sales/7/a/b/c.json", "push.json", ""] {
            assert!(!allowed_rel(bad), "{bad}");
        }
    }

    #[test]
    fn only_the_chain_secret_opens_the_box_and_nobody_else_can_make_one() {
        let csk = crate::identity::chain_key_from(WORDS, "").unwrap();
        let chain = cs::pubkey(&csk).unwrap();
        let d = fresh("key");
        remember_key_in(&d, &csk).unwrap();
        let key = load_key(&d, &chain).unwrap();
        let blob = seal_backup(&key, &chain, b"{\"hello\":\"head office\"}").unwrap();
        assert!(!blob.windows(11).any(|w| w == b"head office"), "평문이 보인다");
        assert_eq!(open_with_chain(&csk, &blob).unwrap(), b"{\"hello\":\"head office\"}");
        // 매장 열쇠·다른 12단어로는 못 연다
        let ssk = crate::identity::chain_store_key_from(WORDS, "", 1, 0).unwrap();
        assert!(open_with_chain(&ssk, &blob).is_err());
        let other = crate::identity::chain_key_from("zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo wrong", "").unwrap();
        assert_eq!(open_with_chain(&other, &blob).unwrap_err(), ERR_OTHER_CHAIN);
        // 체인 공개키만 아는 사람(맡은 매장)이 만든 「백업」은 열리지 않는다 — 바꿔치기 불가.
        let forged_key = hkdf_key(KDF_SALT, chain.as_bytes(), chain.as_bytes()).unwrap();
        let forged = seal_backup(&forged_key, &chain, b"{}").unwrap();
        assert!(open_with_chain(&csk, &forged).is_err());
        // 한 바이트만 바꿔도 못 연다
        let mut bad = blob.clone();
        let n = bad.len() - 1;
        bad[n] ^= 1;
        assert!(open_with_chain(&csk, &bad).is_err());
        // 글자 파일로 오가도 같다. 열쇠 파일에 12단어·체인 비밀은 없다.
        assert_eq!(from_text(&to_text(&blob)).unwrap(), blob);
        assert!(from_text("hello").is_err());
        let kf = std::fs::read_to_string(key_file(&d)).unwrap();
        assert!(!kf.contains(&hex::encode(csk)) && !kf.contains("abandon"));
    }

    #[test]
    fn big_backup_comes_in_pieces_resumes_and_is_kept_only_when_the_hash_matches() {
        let d = fresh("chunks").join("store-chain");
        let mut blob = MAGIC.to_vec();
        blob.extend((0..(CHUNK * 2 + 1000)).map(|i| (i * 7 % 251) as u8));
        let hash = sha_hex(&blob);
        let offer = json!({ "hash": hash, "size": blob.len(), "at": NOW });
        let piece = |off: usize| {
            let end = (off + CHUNK).min(blob.len());
            json!({ "hash": hash, "size": blob.len(), "at": NOW, "offset": off, "data": STANDARD.encode(&blob[off..end]) })
        };
        assert_eq!(want_offset(&d, &offer), Some(0));
        assert_eq!(take_chunk_in(&d, &piece(0), NOW), Ok(false));
        // 끊겼다가 다시: 받은 곳부터. 엉뚱한 자리 조각은 받지 않는다.
        assert_eq!(want_offset(&d, &offer), Some(CHUNK as u64));
        assert!(take_chunk_in(&d, &piece(CHUNK * 2), NOW).is_err());
        assert_eq!(take_chunk_in(&d, &piece(CHUNK), NOW), Ok(false));
        assert_eq!(take_chunk_in(&d, &piece(CHUNK * 2), NOW), Ok(true));
        assert_eq!(held_status_in(&d)["size"], blob.len());
        assert_eq!(want_offset(&d, &offer), None, "같은 것은 다시 받지 않는다");
        assert_eq!(from_text(&held_text_in(&d).unwrap()).unwrap(), blob);
        // 해시가 안 맞는 새 백업은 다 받아도 버리고, 맡아 둔 옛것은 그대로.
        let fake = json!({ "hash": "00".repeat(32), "size": 10, "at": NOW, "offset": 0, "data": STANDARD.encode(b"RVCHB1\nabc") });
        assert!(take_chunk_in(&d, &fake, NOW).is_err());
        assert_eq!(from_text(&held_text_in(&d).unwrap()).unwrap(), blob);
    }
}
