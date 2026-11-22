//! **내 사진 사본** (11-23 대표 「내 글 내 사진은 내 데스크탑에서 보관·통제, 삭제도 내 마음」 · 내 데이터 통제 1단계)
//!
//! 「내 글 지키기」(relay.rs)는 글만 모았다 — 사진은 남의 무료 사진 서버(Blossom)에만 있었다.
//! 이제 이 컴퓨터가 **내 사진 한 부**를 앱 자료 폴더 아래 **일반 폴더**(`my-photos/<sha256>.<확장자>`)에 둔다.
//!
//! - 무엇을: 내 글(kind 0·1·40·41·42)의 사진(imeta url·x, 글 속 우리 사진 길 주소 — `talk_media::blossom_ok` 만) ·
//!   나에게 온/내가 보낸 쪽지 사진의 **암호문**(kind 15 속지의 주소·x — 암호문 **그대로**, 풀지 않는다) ·
//!   이 데스크탑에서 올린 이름표·방 사진(`talk_media::talk_blossom_upload`).
//! - 🔴 IPFS pin 하지 않는다 — IPFS 에 넣으면 세상에 다시 내주게 되고(「삭제」「나만」이 깨진다) 지울 수도 없다.
//! - 🔴 바깥 터널로 이 폴더를 내주지 않는다 — server.rs 에 길이 없다. 화면은 tauri 명령(`my_photo_local`)으로 data: 주소를 받는다.
//! - 받기: upload.rs 의 DNS 고정·사설 IP 차단·다시 보내기 금지·스트리밍 상한(20MiB) · 받은 바이트의 sha256 이 주소 지문과 같아야 저장.
//! - 전체 상한(기본 2GB) — 넘으면 새로 안 받고 화면에 「가득 찼어요」. 이미 있으면 다시 안 받는다.
//! - 지우기: 내가 지운 글(kind 5)만 가리키던 사진은 이 폴더에서도 지운다(다른 글·올린 기록이 같은 사진을 쓰면 남긴다).
use base64::Engine;
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::sync::Mutex;

/// 이 폴더가 들 수 있는 전체 크기(기본 2GB). `index.json` 의 `cap_bytes` 로 바꿀 수 있다.
const DEFAULT_CAP: u64 = 2 * 1024 * 1024 * 1024;
/// 한 번 돌 때 새로 받는 최대 수(사진 서버를 한꺼번에 두드리지 않게). 남은 것은 15분 뒤 다음 번에.
const PER_PASS: usize = 200;
/// 글 하나에서 보는 사진 주소 최대 수.
const PER_EVENT: usize = 8;
/// 사진을 모으는 내 글 종류: 이름표·글·방·방 정보·방 글.
const PHOTO_KINDS: [i64; 5] = [0, 1, 40, 41, 42];
/// 내가 올린 사진(이름표·방 사진) 표시 — 글 번호 대신 남는 출처(글을 지워도 이 표가 있으면 남긴다).
const UPLOAD_SRC: &str = "upload";

pub(crate) fn dir() -> std::path::PathBuf { crate::paths::app_file("my-photos") }
fn index_file() -> std::path::PathBuf { dir().join("index.json") }

fn is_hex64(s: &str) -> bool { s.len() == 64 && s.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f')) }

/// 주소 끝 `<지문>.<확장자>` 의 지문.
fn hash_of_url(url: &str) -> Option<String> {
    let last = url.rsplit('/').next()?;
    let h = last.split('.').next()?;
    is_hex64(h).then(|| h.to_string())
}

/// 쪽지 사진 암호문 주소 — 우리 사진 길(Blossom) 또는 암호문을 받는 공용 서버 nostr.download(폰 talkSession.ts CIPHER_BLOSSOM_SERVER ·
/// release-site/api/blob.mjs HOSTS 와 같다). 그 밖의 바깥 주소는 받지 않는다.
fn cipher_url_ok(url: &str) -> bool {
    if crate::talk_media::blossom_ok(url) { return true; }
    let Some(path) = url.strip_prefix("https://nostr.download/") else { return false };
    let (h, ext) = path.split_once('.').map(|(h, e)| (h, Some(e))).unwrap_or((path, None));
    is_hex64(h) && ext.map_or(true, |e| e == "bin")
}

/// 글 하나 → 사진 (주소, 지문). imeta 표(url·x)와 글 속 주소(이름표·방 정보 JSON 의 picture 포함) 둘 다 본다.
/// 우리 사진 길 주소만 · imeta 의 x 가 주소 지문과 다르면 버린다.
pub(crate) fn photos_of_event(e: &Value) -> Vec<(String, String)> {
    let mut out: Vec<(String, String)> = Vec::new();
    let mut push = |url: &str, x: Option<&str>| {
        if out.len() >= PER_EVENT || !crate::talk_media::blossom_ok(url) { return; }
        let Some(h) = hash_of_url(url) else { return };
        if x.is_some_and(|x| x != h) { return; }
        if !out.iter().any(|(_, have)| *have == h) { out.push((url.to_string(), h)); }
    };
    for t in e.get("tags").and_then(Value::as_array).into_iter().flatten() {
        let Some(parts) = t.as_array() else { continue };
        if parts.first().and_then(Value::as_str) != Some("imeta") { continue; }
        let field = |name: &str| parts.iter().skip(1).filter_map(Value::as_str).find_map(|p| p.strip_prefix(name).map(str::trim));
        if let Some(u) = field("url ") { push(u, field("x ")); }
    }
    let content = e.get("content").and_then(Value::as_str).unwrap_or("");
    for (i, _) in content.match_indices("https://") {
        let rest = &content[i..];
        let end = rest.find(|c: char| c.is_whitespace() || "\"'<>\\,()[]{}".contains(c)).unwrap_or(rest.len());
        push(&rest[..end], None);
    }
    out
}

/// 사진 바이트 → (확장자, mime). 사진이 아니면 None.
fn image_kind(b: &[u8]) -> Option<(&'static str, &'static str)> {
    if b.starts_with(&[0xff, 0xd8, 0xff]) { return Some(("jpg", "image/jpeg")); }
    if b.starts_with(b"\x89PNG\r\n\x1a\n") { return Some(("png", "image/png")); }
    if b.starts_with(b"GIF87a") || b.starts_with(b"GIF89a") { return Some(("gif", "image/gif")); }
    if b.starts_with(b"RIFF") && b.get(8..12) == Some(b"WEBP") { return Some(("webp", "image/webp")); }
    if b.get(4..8) == Some(b"ftyp") && matches!(b.get(8..12), Some(b"avif") | Some(b"avis")) { return Some(("avif", "image/avif")); }
    None
}

// ── 장부(index.json) ────────────────────────────────────────────────
// { "items": { "<지문>": { "ext": "jpg", "bytes": n, "kind": "photo"|"cipher", "src": ["글 번호" | "upload"] } }, "cap_bytes"?: n }

static INDEX: Mutex<Option<Map<String, Value>>> = Mutex::new(None);
/// 지난 번에 상한 때문에 못 받은 것이 있었나 — 화면이 「가득 찼어요」를 띄운다.
static FULL: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
static RUNNING: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
/// 이번 실행에서 이미 열어 본 겉봉(15분마다 5,000개를 다시 풀지 않게).
static SEEN_WRAPS: Mutex<Option<HashSet<String>>> = Mutex::new(None);

fn with_index<T>(f: impl FnOnce(&mut Map<String, Value>) -> T) -> T {
    let mut g = INDEX.lock().unwrap_or_else(|e| e.into_inner());
    if g.is_none() {
        let v = std::fs::read_to_string(index_file()).ok().and_then(|s| serde_json::from_str::<Value>(&s).ok()).unwrap_or(json!({}));
        let mut m = v.as_object().cloned().unwrap_or_default();
        if !m.get("items").is_some_and(Value::is_object) { m.insert("items".into(), json!({})); }
        *g = Some(m);
    }
    f(g.as_mut().expect("방금 채웠다"))
}
fn items(m: &mut Map<String, Value>) -> &mut Map<String, Value> {
    m.entry("items").or_insert_with(|| json!({})).as_object_mut().expect("items 는 늘 객체")
}
fn save_index(m: &Map<String, Value>) {
    let _ = std::fs::create_dir_all(dir());
    let tmp = index_file().with_extension("json.tmp");
    if std::fs::write(&tmp, serde_json::to_vec(m).unwrap_or_default()).is_ok() { let _ = std::fs::rename(&tmp, index_file()); }
}
fn cap_of(m: &Map<String, Value>) -> u64 { m.get("cap_bytes").and_then(Value::as_u64).filter(|n| *n > 0).unwrap_or(DEFAULT_CAP) }
fn total_of(m: &Map<String, Value>) -> u64 {
    m.get("items").and_then(Value::as_object).map(|o| o.values().filter_map(|v| v.get("bytes").and_then(Value::as_u64)).sum()).unwrap_or(0)
}
fn path_of(hash: &str, ext: &str) -> std::path::PathBuf { dir().join(format!("{hash}.{ext}")) }

/// 이미 있으면 출처만 더한다. 새로 들어왔으면 true.
fn note_source(hash: &str, src: &str) -> bool {
    with_index(|m| {
        let Some(it) = items(m).get_mut(hash) else { return false };
        let ext = it.get("ext").and_then(Value::as_str).unwrap_or("").to_string();
        if !path_of(hash, &ext).is_file() { return false; } // 장부엔 있는데 파일이 없다 — 다시 받는다.
        let list = it.as_object_mut().expect("항목은 객체").entry("src").or_insert_with(|| json!([]));
        if let Some(a) = list.as_array_mut() {
            if !a.iter().any(|x| x.as_str() == Some(src)) { a.push(json!(src)); save_index(m); }
        }
        true
    })
}

/// 바이트를 저장한다(지문 대조 · 상한). 성공하면 true.
fn store(hash: &str, bytes: &[u8], kind: &str, src: &str) -> Result<bool, String> {
    if hex::encode(Sha256::digest(bytes)) != hash { return Err("사진이 주소 지문과 맞지 않아요".into()); }
    let ext = if kind == "cipher" { "bin" } else { image_kind(bytes).ok_or("사진 파일이 아니에요")?.0 };
    with_index(|m| {
        if total_of(m) + bytes.len() as u64 > cap_of(m) {
            FULL.store(true, std::sync::atomic::Ordering::Relaxed);
            return Ok(false);
        }
        std::fs::create_dir_all(dir()).map_err(|_| "사진 폴더를 만들지 못했어요".to_string())?;
        let path = path_of(hash, ext);
        let tmp = path.with_extension("part");
        std::fs::write(&tmp, bytes).and_then(|_| std::fs::rename(&tmp, &path)).map_err(|_| {
            let _ = std::fs::remove_file(&tmp);
            "사진을 저장하지 못했어요".to_string()
        })?;
        items(m).insert(hash.to_string(), json!({ "ext": ext, "bytes": bytes.len(), "kind": kind, "src": [src] }));
        save_index(m);
        Ok(true)
    })
}

/// 지운 글들. 그 글들**만** 가리키던 사진은 파일째 지우고, 다른 출처가 남은 사진은 출처만 뺀다. 지운 수.
pub(crate) fn drop_sources(gone: &HashSet<String>) -> usize {
    if gone.is_empty() { return 0; }
    with_index(|m| {
        let mut removed = 0usize;
        let mut changed = false;
        let list = items(m);
        let keys: Vec<String> = list.keys().cloned().collect();
        for k in keys {
            let Some(it) = list.get_mut(&k) else { continue };
            let src: Vec<String> = it.get("src").and_then(Value::as_array).map(|a| a.iter().filter_map(Value::as_str).map(str::to_string).collect()).unwrap_or_default();
            if src.is_empty() || !src.iter().any(|s| gone.contains(s)) { continue; }
            let left: Vec<String> = src.into_iter().filter(|s| !gone.contains(s)).collect();
            changed = true;
            if left.is_empty() {
                let ext = it.get("ext").and_then(Value::as_str).unwrap_or("").to_string();
                let _ = std::fs::remove_file(path_of(&k, &ext));
                list.remove(&k);
                removed += 1;
            } else {
                it["src"] = json!(left);
            }
        }
        if changed { save_index(m); }
        removed
    })
}

/// talk_media 가 이 데스크탑에서 올린 이름표·방 사진 한 부를 바로 둔다(받을 필요 없이 올린 바이트 그대로). 실패해도 올리기는 막지 않는다.
pub(crate) fn keep_uploaded(hash: &str, bytes: &[u8]) {
    if note_source(hash, UPLOAD_SRC) { return; }
    let _ = store(hash, bytes, "photo", UPLOAD_SRC);
}

/// 11-23 talk_private.rs 가 이 데스크탑에서 올린 비공개 글 암호 사진 한 부(암호문 그대로).
pub(crate) fn keep_cipher(hash: &str, cipher: &[u8]) {
    if note_source(hash, UPLOAD_SRC) { return; }
    let _ = store(hash, cipher, "cipher", UPLOAD_SRC);
}
/// 이 컴퓨터에 있는 암호문 사본(지문이 맞을 때만). 없으면 None — 부르는 쪽이 사진 서버에서 받는다.
pub(crate) fn local_cipher(hash: &str) -> Option<Vec<u8>> {
    if !is_hex64(hash) { return None; }
    let ext = with_index(|m| items(m).get(hash).and_then(|v| v.get("ext").and_then(Value::as_str).map(str::to_string)))?;
    let b = std::fs::read(path_of(hash, &ext)).ok()?;
    (b.len() <= crate::upload::MAX_TALK_PHOTO_BYTES && hex::encode(Sha256::digest(&b)) == hash).then_some(b)
}
pub(crate) fn is_image(b: &[u8]) -> bool { image_kind(b).is_some() }
pub(crate) fn image_mime(b: &[u8]) -> Option<&'static str> { image_kind(b).map(|(_, m)| m) }

/// 받을 것 하나: (주소, 지문, 종류, 출처 글 번호).
type Want = (String, String, &'static str, String);

/// 지금 지킬 사진 목록 + 내가 지운 글 번호들.
fn wanted(me: &str) -> (Vec<Want>, HashSet<String>) {
    let (events, deleted) = crate::relay::events_of(me, &PHOTO_KINDS);
    let mut out: Vec<Want> = Vec::new();
    for e in &events {
        let id = e.get("id").and_then(Value::as_str).unwrap_or("");
        if !is_hex64(id) { continue; }
        for (url, h) in photos_of_event(e) { out.push((url, h, "photo", id.to_string())); }
    }
    // 쪽지 사진 암호문 — 열쇠가 이 컴퓨터에 있을 때만(여기서 열쇠를 만들지 않는다).
    if let Some((mut sk, _, _)) = crate::talk::key_on_disk() {
        if crate::shopkey::pubkey_of(&sk).ok().as_deref() == Some(me) {
            let wraps = crate::relay::owner_wraps(me);
            let mut seen = SEEN_WRAPS.lock().unwrap_or_else(|e| e.into_inner());
            let seen = seen.get_or_insert_with(HashSet::new);
            for w in &wraps {
                let Some(wid) = w.get("id").and_then(Value::as_str) else { continue };
                if seen.contains(wid) { continue; }
                if let Some((dm, Some((url, x)))) = crate::talk_dm::open_wrap_with_file(&sk, w) {
                    if cipher_url_ok(&url) && hash_of_url(&url).as_deref() == Some(x.as_str()) {
                        out.push((url, x, "cipher", dm.id));
                    }
                }
                // 연 겉봉은 다음 번에 다시 풀지 않는다. 사진을 못 받은 것(상한·오류)이 있으면 sync_once 가 이 표를 비워 다시 보게 한다.
                seen.insert(wid.to_string());
            }
        }
        // 11-23 「나만·친구만」 비공개 글(4470)의 암호 사진도 — 속을 메모리에서만 풀어 주소·지문을 읽고, 받는 것은 암호문 그대로.
        if crate::shopkey::pubkey_of(&sk).ok().as_deref() == Some(me) {
            let (private, _) = crate::relay::events_of(me, &[crate::relay::KIND_PRIVATE_NOTE, 30078]);
            let circle = private.iter().find(|e| e.get("kind").and_then(Value::as_i64) == Some(30078) && crate::relay::private_event(e))
                .map(|e| circle_keys(&sk, me, e)).unwrap_or_default();
            for e in private.iter().filter(|e| e.get("kind").and_then(Value::as_i64) == Some(crate::relay::KIND_PRIVATE_NOTE)) {
                let id = e.get("id").and_then(Value::as_str).unwrap_or("");
                if !is_hex64(id) { continue; }
                for (url, x) in private_note_files(&sk, me, e, &circle) { out.push((url, x, "cipher", id.to_string())); }
            }
        }
        crate::words::wipe_bytes(&mut sk);
    }
    (out, deleted.into_iter().collect())
}

/// 내 열쇠 꾸러미(30078 d=ravenvault/circle-keys/v1)의 self 칸 → 세대별 서클 열쇠(메모리만 · 폰 core/talk/circle.ts).
fn circle_keys(sk: &[u8; 32], me: &str, e: &Value) -> Vec<(i64, [u8; 32])> {
    let Some(conv) = crate::wallet_link::conv_key(sk, me) else { return vec![] };
    let outer: Value = serde_json::from_str(e.get("content").and_then(Value::as_str).unwrap_or("")).unwrap_or(Value::Null);
    let Some(plain) = outer.get("self").and_then(Value::as_str).and_then(|c| crate::wallet_link::nip44_decrypt(c, &conv)) else { return vec![] };
    let v: Value = serde_json::from_str(&plain).unwrap_or(Value::Null);
    v.get("keys").and_then(Value::as_array).into_iter().flatten().filter_map(|k| {
        let epoch = k.get(0)?.as_i64()?;
        let b = hex::decode(k.get(1)?.as_str()?).ok().filter(|b| b.len() == 32)?;
        let mut key = [0u8; 32];
        key.copy_from_slice(&b);
        Some((epoch, key))
    }).collect()
}

/// 4470 글 하나 → 그 글 암호 사진들의 (주소, 암호문 지문). 「나만」은 나→나 NIP-44, 「친구만」은 그 세대 서클 열쇠(폰 core/talk/private-note.ts).
/// 🔴 푼 속은 이 함수 안에서만 쓴다 — 디스크에 쓰지 않는다. 사진 열쇠(key·nonce)도 꺼내지 않는다.
fn private_note_files(sk: &[u8; 32], me: &str, e: &Value, circle: &[(i64, [u8; 32])]) -> Vec<(String, String)> {
    let env: Value = serde_json::from_str(e.get("content").and_then(Value::as_str).unwrap_or("")).unwrap_or(Value::Null);
    if env.get("v").and_then(Value::as_i64) != Some(1) { return vec![]; }
    let Some(c) = env.get("c").and_then(Value::as_str) else { return vec![] };
    let conv = match env.get("a").and_then(Value::as_str) {
        Some("self") => crate::wallet_link::conv_key(sk, me),
        Some("friends") => env.get("e").and_then(Value::as_i64).and_then(|ep| circle.iter().find(|(n, _)| *n == ep).map(|(_, k)| *k)),
        _ => None,
    };
    let Some(plain) = conv.and_then(|k| crate::wallet_link::nip44_decrypt(c, &k)) else { return vec![] };
    let body: Value = serde_json::from_str(&plain).unwrap_or(Value::Null);
    body.get("photos").and_then(Value::as_array).into_iter().flatten().take(4).filter_map(|f| {
        let url = f.get("url")?.as_str()?.to_string();
        let x = f.get("sha256")?.as_str()?.to_string();
        (cipher_url_ok(&url) && hash_of_url(&url).as_deref() == Some(x.as_str())).then_some((url, x))
    }).collect()
}

/// 한 번 돌기: 지운 글의 사진 지우기 → 새 사진 받기(이미 있으면 출처만 더함). 동시에 두 번 돌지 않는다.
pub(crate) async fn sync_once() {
    if RUNNING.swap(true, std::sync::atomic::Ordering::AcqRel) { return; }
    struct Done;
    impl Drop for Done { fn drop(&mut self) { RUNNING.store(false, std::sync::atomic::Ordering::Release); } }
    let _done = Done;
    let Some(me) = crate::relay::owner_pub() else { return };
    let (want, deleted) = wanted(&me);
    drop_sources(&deleted);
    FULL.store(false, std::sync::atomic::Ordering::Relaxed);
    let mut fetched = 0usize;
    let mut retry_wraps: Vec<String> = Vec::new();
    for (url, hash, kind, src) in want {
        if deleted.contains(&src) || note_source(&hash, &src) { continue; }
        if FULL.load(std::sync::atomic::Ordering::Relaxed) || fetched >= PER_PASS {
            if kind == "cipher" { retry_wraps.push(src); }
            continue;
        }
        fetched += 1;
        let got = if kind == "cipher" { crate::upload::download_talk_cipher(&url).await } else { crate::upload::download_talk_photo(&url).await };
        let ok = match got { Ok(bytes) => store(&hash, &bytes, kind, &src).unwrap_or(false), Err(_) => false };
        if !ok && kind == "cipher" { retry_wraps.push(src); }
    }
    // 못 받은 쪽지 사진은 다음 번에 다시 본다(겉봉을 다시 풀게 「본 것」에서 뺀다 — 겉봉 번호를 모르니 통째로 비운다).
    if !retry_wraps.is_empty() { *SEEN_WRAPS.lock().unwrap_or_else(|e| e.into_inner()) = None; }
}

/// (사진 수, 쪽지 암호 사진 수, 쓰는 크기, 상한).
fn counts() -> (usize, usize, u64, u64) {
    with_index(|m| {
        let list = items(m);
        let photos = list.values().filter(|v| v.get("kind").and_then(Value::as_str) == Some("photo")).count();
        let ciphers = list.len() - photos;
        let total = list.values().filter_map(|v| v.get("bytes").and_then(Value::as_u64)).sum();
        (photos, ciphers, total, cap_of(m))
    })
}

/// 서랍이 그릴 「이 컴퓨터에 있는 내 글 사진」 지문들(쪽지 암호문은 그림이 아니니 빼고).
pub(crate) fn local_photo_hashes() -> Vec<String> {
    with_index(|m| items(m).iter().filter(|(_, v)| v.get("kind").and_then(Value::as_str) == Some("photo")).map(|(k, _)| k.clone()).collect())
}

/// 화면 한 줄: `{ photos, ciphers, count, bytes, cap, full }`.
#[tauri::command(async)]
pub fn my_photos_status() -> Value {
    let (photos, ciphers, bytes, cap) = counts();
    json!({ "photos": photos, "ciphers": ciphers, "count": photos + ciphers, "bytes": bytes, "cap": cap,
            "full": FULL.load(std::sync::atomic::Ordering::Relaxed) })
}

/// 이 컴퓨터에 있는 내 사진 한 장 → data: 주소(웹뷰 안에서만 · 바깥 터널로는 안 나간다). 없으면 null(화면이 공용 주소로 그린다).
#[tauri::command(async)]
pub fn my_photo_local(hash: String) -> Option<String> {
    if !is_hex64(&hash) { return None; }
    let ext = with_index(|m| items(m).get(&hash).filter(|v| v.get("kind").and_then(Value::as_str) == Some("photo"))
        .and_then(|v| v.get("ext").and_then(Value::as_str).map(str::to_string)))?;
    let bytes = std::fs::read(path_of(&hash, &ext)).ok()?;
    if bytes.len() > crate::upload::MAX_TALK_PHOTO_BYTES || hex::encode(Sha256::digest(&bytes)) != hash { return None; }
    let (_, mime) = image_kind(&bytes)?;
    Some(format!("data:{mime};base64,{}", base64::engine::general_purpose::STANDARD.encode(&bytes)))
}

/// 사진 폴더를 컴퓨터의 파일 창(파인더·탐색기)으로 연다.
#[tauri::command(async)]
pub fn my_photos_open_folder() -> Result<(), String> {
    std::fs::create_dir_all(dir()).map_err(|_| "사진 폴더를 만들지 못했어요.".to_string())?;
    tauri_plugin_opener::open_path(dir(), None::<&str>).map_err(|_| "사진 폴더를 열지 못했어요.".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    const H: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

    #[test]
    fn 글에서_우리_사진_주소만_뽑는다() {
        let e = json!({ "kind": 1, "content": format!("밥 https://blossom.nostr.build/{H}.jpg 그리고 https://evil.example/{H}.jpg"),
            "tags": [["imeta", format!("url https://blossom.nostr.build/{H}.jpg"), format!("x {H}")]] });
        assert_eq!(photos_of_event(&e), vec![(format!("https://blossom.nostr.build/{H}.jpg"), H.to_string())]);
        // 이름표(JSON) 속 picture 도 본다.
        let p = json!({ "kind": 0, "content": format!("{{\"name\":\"나\",\"picture\":\"https://image.nostr.build/{H}.png\"}}"), "tags": [] });
        assert_eq!(photos_of_event(&p).len(), 1);
        // imeta x 가 주소 지문과 다르면 버린다.
        let bad = json!({ "kind": 1, "content": "", "tags": [["imeta", format!("url https://blossom.nostr.build/{H}.jpg"), format!("x {}", "f".repeat(64))]] });
        assert!(photos_of_event(&bad).is_empty());
    }

    /// 11-23 「나만·친구만」 4470 글: 메모리에서만 풀어 암호 사진 주소·지문을 읽는다(열쇠는 안 꺼낸다).
    #[test]
    fn 비공개_글의_암호_사진도_사본_대상() {
        use crate::wallet_link::{conv_key, nip44_encrypt};
        let sk = [7u8; 32];
        let me = crate::shopkey::pubkey_of(&sk).unwrap();
        let body = json!({ "v": 1, "text": "나만", "photos": [{ "url": format!("https://nostr.download/{H}.bin"), "mime": "image/jpeg",
            "key": "1".repeat(64), "nonce": "2".repeat(24), "sha256": H, "plainSha256": "", "size": 10, "width": 1, "height": 1 }] }).to_string();
        let selfc = nip44_encrypt(&body, &conv_key(&sk, &me).unwrap(), [3u8; 32]).unwrap();
        let e = json!({ "kind": 4470, "content": json!({ "v": 1, "a": "self", "c": selfc }).to_string() });
        assert_eq!(private_note_files(&sk, &me, &e, &[]), vec![(format!("https://nostr.download/{H}.bin"), H.to_string())]);
        // 「친구만」 — 꾸러미 self 칸에서 그 세대 열쇠를 찾아 연다.
        let ck = [5u8; 32];
        let fc = nip44_encrypt(&body, &ck, [4u8; 32]).unwrap();
        let fe = json!({ "kind": 4470, "content": json!({ "v": 1, "a": "friends", "e": 2, "c": fc }).to_string() });
        let selfslot = nip44_encrypt(&json!({ "v": 1, "epoch": 2, "friends": [], "keys": [[2, hex::encode(ck)]] }).to_string(), &conv_key(&sk, &me).unwrap(), [6u8; 32]).unwrap();
        let bundle = json!({ "kind": 30078, "tags": [["d", crate::relay::CIRCLE_KEYS_D]], "content": json!({ "v": 1, "self": selfslot, "slots": [] }).to_string() });
        let circle = circle_keys(&sk, &me, &bundle);
        assert_eq!(circle.len(), 1);
        assert_eq!(private_note_files(&sk, &me, &fe, &circle).len(), 1);
        assert!(private_note_files(&sk, &me, &fe, &[]).is_empty(), "열쇠가 없으면 조용히 버린다");
    }

    #[test]
    fn 암호문_주소는_우리_길과_nostr_download_만() {
        assert!(cipher_url_ok(&format!("https://nostr.download/{H}")));
        assert!(cipher_url_ok(&format!("https://nostr.download/{H}.bin")));
        assert!(cipher_url_ok(&format!("https://blossom.nostr.build/{H}")));
        assert!(!cipher_url_ok(&format!("https://nostr.download/{H}.exe")));
        assert!(!cipher_url_ok(&format!("https://nostr.download.evil/{H}")));
        assert!(!cipher_url_ok("https://nostr.download/abc"));
    }

    #[test]
    fn 저장_지문대조_상한_지우기() {
        let _g = crate::paths::TEST_ENV.lock().unwrap_or_else(|e| e.into_inner());
        let home = crate::paths::test_fixture_root().join(format!("my-photos-{}", rand::random::<u32>()));
        std::fs::create_dir_all(&home).unwrap();
        std::env::set_var("PLAYX_RAVEN_HOME", &home);
        *INDEX.lock().unwrap() = None;
        let png = b"\x89PNG\r\n\x1a\nfixture-photo".to_vec();
        let h = hex::encode(Sha256::digest(&png));
        // 지문이 다르면 저장하지 않는다.
        assert!(store(H, &png, "photo", "a").is_err());
        assert!(store(&h, &png, "photo", "a").unwrap());
        assert!(dir().join(format!("{h}.png")).is_file());
        assert!(note_source(&h, "b"), "이미 있으면 다시 안 받고 출처만 더한다");
        // 암호문은 사진 모양이 아니어도 .bin 으로 그대로.
        let cipher = b"\x00\x01not-an-image".to_vec();
        let ch = hex::encode(Sha256::digest(&cipher));
        assert!(store(&ch, &cipher, "cipher", "dm1").unwrap());
        assert!(dir().join(format!("{ch}.bin")).is_file());
        assert!(my_photo_local(ch.clone()).is_none(), "암호문은 그림으로 내주지 않는다");
        assert!(my_photo_local(h.clone()).unwrap().starts_with("data:image/png;base64,"));
        // 글 a 를 지워도 b 가 같은 사진을 쓰면 남는다. b 까지 지우면 파일째 지운다.
        assert_eq!(drop_sources(&HashSet::from(["a".to_string()])), 0);
        assert!(dir().join(format!("{h}.png")).is_file());
        assert_eq!(drop_sources(&HashSet::from(["b".to_string()])), 1);
        assert!(!dir().join(format!("{h}.png")).exists());
        // 올린 사진은 글을 지워도 남는다.
        keep_uploaded(&h, &png);
        assert_eq!(drop_sources(&HashSet::from(["b".to_string()])), 0);
        assert!(dir().join(format!("{h}.png")).is_file());
        // 상한을 넘으면 새로 안 받고 「가득」.
        with_index(|m| { m.insert("cap_bytes".into(), json!(10)); });
        let jpg = b"\xff\xd8\xff-fixture-jpeg".to_vec();
        assert!(!store(&hex::encode(Sha256::digest(&jpg)), &jpg, "photo", "c").unwrap());
        assert!(FULL.load(std::sync::atomic::Ordering::Relaxed));
        let st = my_photos_status();
        assert_eq!((st["photos"].as_u64(), st["ciphers"].as_u64(), st["full"].as_bool()), (Some(1), Some(1), Some(true)));
        *INDEX.lock().unwrap() = None;
        FULL.store(false, std::sync::atomic::Ordering::Relaxed);
        std::env::remove_var("PLAYX_RAVEN_HOME");
        let _ = std::fs::remove_dir_all(&home);
    }
}
