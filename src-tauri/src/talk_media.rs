//! 11-13 이야기 링크 미리보기 · 방 사진 · 내 사진 이름표 (폰 core/talk/url-links.ts · release-site/api/unfurl.mjs 와 같은 규칙).
//!
//! - `talk_unfurl`: 링크 미리보기는 **우리 사이트**(https://ravenvault.ex.erci.se/api/unfurl)에만 묻는다. 그림도 그 창구의
//!   서명된 주소(/api/unfurl?img=…)로만 받아 data: 주소로 화면에 넘긴다 — 화면(웹뷰)은 남의 사이트에 닿지 않는다(IP 가 새지 않게).
//! - `talk_blossom_upload`: 방 사진·내 사진을 공용 Nostr 사진 서버(Blossom, blossom.nostr.build)에 올린다. 폰 talkSession.ts 처럼
//!   한 번 쓰고 버리는 열쇠로 BUD-02(kind 24242, 이 지문 하나만 5분) 허락을 서명한다 — 이야기 열쇠와 사진이 묶이지 않는다.
//! - `picture_ok`: 이름표·방 사진으로 받는 주소는 라비 이모티콘 16종 주소 또는 Blossom 지문 주소뿐. 그 밖의 바깥 주소는 버린다.
use base64::Engine;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::time::Duration;

pub const SITE: &str = "https://ravenvault.ex.erci.se";
const BLOSSOM_UPLOAD: &str = "https://blossom.nostr.build/upload";
const MAX_JSON: usize = 64 * 1024;
const MAX_IMAGE: usize = 2_000_000;
const MAX_UPLOAD: usize = 4_000_000;
const STICKERS: [&str; 16] = [
    "ravi_hello", "ravi_thanks", "ravi_like", "ravi_love", "ravi_congrats", "ravi_laugh", "ravi_sad", "ravi_angry",
    "ravi_surprised", "ravi_curious", "ravi_cheer", "ravi_sorry", "ravi_goodnight", "ravi_gift", "ravi_waiting", "ravi_ok",
];

fn is_hex64(s: &str) -> bool { s.len() == 64 && s.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f')) }

/// Blossom 지문 주소인가 — 폰 core/talk/photo.ts BLOSSOM 과 같은 모양.
pub fn blossom_ok(url: &str) -> bool {
    let Some(rest) = url.strip_prefix("https://") else { return false };
    let Some((host, path)) = rest.split_once('/') else { return false };
    let host_ok = matches!(host, "blossom.nostr.build" | "image.nostr.build" | "i.nostr.build" | "media.nostr.build")
        || (host.len() == 63 + ".blossom.band".len()
            && host.ends_with(".blossom.band")
            && host.starts_with("npub1")
            && host[5..63].bytes().all(|b| b"qpzry9x8gf2tvdw0s3jn54khce6mua7l".contains(&b)));
    if !host_ok { return false; }
    let (hash, ext) = path.split_once('.').map(|(h, e)| (h, Some(e))).unwrap_or((path, None));
    is_hex64(hash) && ext.map_or(true, |e| matches!(e, "jpg" | "jpeg" | "png" | "webp" | "gif"))
}

/// 라비 이모티콘 주소인가(https://ravenvault.ex.erci.se/emoji/<이름>.webp).
pub fn sticker_ok(url: &str) -> bool {
    url.strip_prefix("https://ravenvault.ex.erci.se/emoji/")
        .and_then(|r| r.strip_suffix(".webp"))
        .map_or(false, |c| STICKERS.contains(&c))
}

/// 이름표 그림으로 받는 주소: 비움 · 라비 이모티콘 · Blossom 지문 주소.
pub fn picture_ok(url: &str) -> bool { url.is_empty() || sticker_ok(url) || blossom_ok(url) }
/// 방 사진으로 받는 주소: 비움 · Blossom 지문 주소.
pub fn room_picture_ok(url: &str) -> bool { url.is_empty() || blossom_ok(url) }

fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(5))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|e| e.to_string())
}

async fn read_capped(mut r: reqwest::Response, cap: usize) -> Result<Vec<u8>, String> {
    let mut out = Vec::new();
    while let Some(chunk) = r.chunk().await.map_err(|e| e.to_string())? {
        if out.len() + chunk.len() > cap { return Err("too-big".into()); }
        out.extend_from_slice(&chunk);
    }
    Ok(out)
}

/// 우리 창구의 답 → 화면에 넘길 모양. 그림은 우리 창구 주소만 받는다.
pub fn clean_unfurl(v: &Value) -> Option<(Value, String)> {
    if v.get("none").and_then(Value::as_bool) == Some(true) { return None; }
    let s = |k: &str, n: usize| v.get(k).and_then(Value::as_str).unwrap_or("").chars().take(n).collect::<String>();
    let kind = match v.get("kind").and_then(Value::as_str) { Some("x") => "x", Some("youtube") => "youtube", _ => "page" };
    let (title, description) = (s("title", 200), s("description", 300));
    if title.is_empty() && description.is_empty() { return None; }
    let image = s("image", 2000);
    let image = if image.starts_with("/api/unfurl?img=") { image } else { String::new() };
    Some((json!({ "url": s("url", 2000), "kind": kind, "site": s("site", 80), "title": title, "description": description, "image": "" }), image))
}

/// 링크 미리보기 — 우리 사이트만 부른다. 없거나 못 읽으면 `{none:true}`.
#[tauri::command]
pub async fn talk_unfurl(url: String) -> Result<Value, String> {
    if url.len() > 2000 || !url.starts_with("https://") { return Ok(json!({ "none": true })); }
    let c = client()?;
    let api = format!("{SITE}/api/unfurl?u={}", urlencoding(&url));
    let Ok(r) = c.get(&api).send().await else { return Ok(json!({ "none": true })) };
    if !r.status().is_success() { return Ok(json!({ "none": true })); }
    let Ok(bytes) = read_capped(r, MAX_JSON).await else { return Ok(json!({ "none": true })) };
    let Ok(v) = serde_json::from_slice::<Value>(&bytes) else { return Ok(json!({ "none": true })) };
    let Some((mut out, image)) = clean_unfurl(&v) else { return Ok(json!({ "none": true })) };
    if !image.is_empty() {
        if let Ok(r) = c.get(format!("{SITE}{image}")).send().await {
            let ty = r.headers().get("content-type").and_then(|h| h.to_str().ok()).unwrap_or("").split(';').next().unwrap_or("").trim().to_ascii_lowercase();
            if r.status().is_success() && matches!(ty.as_str(), "image/jpeg" | "image/png" | "image/webp" | "image/gif") {
                if let Ok(b) = read_capped(r, MAX_IMAGE).await {
                    out["image"] = json!(format!("data:{ty};base64,{}", base64::engine::general_purpose::STANDARD.encode(b)));
                }
            }
        }
    }
    Ok(out)
}

fn urlencoding(s: &str) -> String {
    s.bytes().map(|b| match b { b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => (b as char).to_string(), _ => format!("%{b:02X}") }).collect()
}

/// BUD-02 올리기 허락(kind 24242) 초안 — 폰 core/talk/photo.ts blossomAuthDraft 와 같은 표.
pub fn blossom_auth_tags(hash: &str, now: i64) -> Value { json!([["t", "upload"], ["x", hash], ["expiration", (now + 300).to_string()]]) }

/// 방 사진·내 사진 올리기. 화면이 512px 정사각 JPEG 으로 줄여 base64 로 넘긴다. 답 = `{ url }`(Blossom 지문 주소만).
#[tauri::command]
pub async fn talk_blossom_upload(data: String, mime: String) -> Result<Value, String> {
    if !matches!(mime.as_str(), "image/jpeg" | "image/png" | "image/webp") { return Err("사진 종류를 읽지 못했어요.".into()); }
    let bytes = base64::engine::general_purpose::STANDARD.decode(data.trim()).map_err(|_| "사진을 읽지 못했어요.".to_string())?;
    if bytes.is_empty() || bytes.len() > MAX_UPLOAD { return Err("사진이 너무 커요. 다른 사진을 골라 주세요.".into()); }
    let hash = hex::encode(Sha256::digest(&bytes));
    let bytes_kept = bytes.clone();
    // 11-23 내 데이터 통제 2단계: 사진마다 「이야기 열쇠 + 지문」에서 뽑은 열쇠로 서명한다(폰 photoUploadKey 와 같은 계산) —
    //   사진 서버는 사진마다 다른 낯선 열쇠만 보고, 나는 나중에 같은 열쇠를 다시 만들어 지워 달라고 할 수 있다.
    let mut person = crate::talk::signing_key()?;
    let derived = photo_upload_key(&person, &hash);
    person.fill(0);
    let mut photo_key = derived?;
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0);
    let auth = crate::shopkey::sign_with(&photo_key, 24242, blossom_auth_tags(&hash, now), "Upload RavenVault talk photo", now);
    photo_key.fill(0);
    let auth = auth?;
    let header = format!("Nostr {}", base64::engine::general_purpose::STANDARD.encode(auth.to_string()));
    let r = reqwest::Client::builder().timeout(Duration::from_secs(30)).build().map_err(|e| e.to_string())?
        .put(BLOSSOM_UPLOAD)
        .header("authorization", header)
        .header("content-type", &mime)
        .header("x-sha-256", &hash)
        .body(bytes)
        .send().await
        .map_err(|_| "사진 서버에 닿지 못했어요. 인터넷 연결을 확인해 주세요.".to_string())?;
    if !r.status().is_success() { return Err(format!("사진 서버가 받지 않았어요({}). 잠시 뒤 다시 해 주세요.", r.status().as_u16())); }
    let v: Value = r.json().await.map_err(|_| "사진 서버의 답을 읽지 못했어요.".to_string())?;
    let url = v.get("url").and_then(Value::as_str).unwrap_or("");
    if v.get("sha256").and_then(Value::as_str) != Some(hash.as_str()) || !url.contains(&hash) || !blossom_ok(url) {
        return Err("사진 서버의 답이 맞지 않아요. 다시 올려 주세요.".into());
    }
    // 11-23 내 사진 사본 — 올린 바이트 그대로 이 컴퓨터 사진 폴더에도 한 부(my_photos.rs · IPFS 아님).
    crate::my_photos::keep_uploaded(&hash, &bytes_kept);
    Ok(json!({ "url": url }))
}

// ── 11-23 내 데이터 통제 2단계: 사진 열쇠 · 사진 서버에 지워 달라기(BUD-02 DELETE) — 폰 core/talk/photo.ts 와 바이트까지 같다 ──
pub const PHOTO_KEY_SALT: &str = "ravenvault/blossom-photo-key/v1";
const CIPHER_SERVER: &str = "https://nostr.download";
const PHOTO_SERVER: &str = "https://blossom.nostr.build";

/// 사람(이야기) 열쇠 + 사진 파일 지문(sha256 hex, 올리는 바이트 그대로) → 이 사진만의 올리기·지우기 열쇠.
/// HKDF-SHA256(ikm=사람 열쇠, salt=PHOTO_KEY_SALT, info=지문 [+ "/n"], 32B) · 열쇠 범위 밖이면 "/1"… 로 다시(폰 photoUploadKey).
/// 🔴 쓰고 나면 부르는 쪽이 지운다(fill(0)). 이 열쇠로는 사진 하나 올리기·지우기 허락만 한다.
pub fn photo_upload_key(person: &[u8; 32], file_sha256: &str) -> Result<[u8; 32], String> {
    if !is_hex64(file_sha256) { return Err("사진 지문이 맞지 않아요.".into()); }
    let hk = hkdf::Hkdf::<Sha256>::new(Some(PHOTO_KEY_SALT.as_bytes()), person);
    for n in 0..8 {
        let info = if n == 0 { file_sha256.to_string() } else { format!("{file_sha256}/{n}") };
        let mut key = [0u8; 32];
        if hk.expand(info.as_bytes(), &mut key).is_err() { continue; }
        if crate::shopkey::pubkey_of(&key).is_ok() { return Ok(key); }
        key.fill(0);
    }
    Err("사진 열쇠를 만들지 못했어요.".into())
}

/// 지우기 허락(BUD-02 kind 24242 t=delete) 표 — 이 지문 하나만 5분. content 는 영문만(폰 blossomDeleteDraft).
pub fn blossom_delete_tags(hash: &str, now: i64) -> Value { json!([["t", "delete"], ["x", hash], ["expiration", (now + 300).to_string()]]) }

/// 쪽지·비공개 글 암호 사진 주소(nostr.download/<지문>[.bin]).
fn cipher_url_ok(url: &str) -> bool {
    url.strip_prefix("https://nostr.download/")
        .map(|p| p.strip_suffix(".bin").unwrap_or(p))
        .is_some_and(is_hex64)
}

/// 우리 사진 길 주소 → 지울 때 부를 사진 서버(폰 blossomServerOf). 모르면 None.
pub fn blossom_server_of(url: &str) -> Option<&'static str> {
    if blossom_ok(url) { Some(PHOTO_SERVER) } else if cipher_url_ok(url) { Some(CIPHER_SERVER) } else { None }
}

/// 내 글 속 우리 사진 길 사진들 (주소, 지문) — 폰 photoFilesOf 와 같은 기준(imeta x 가 있으면 같아야 한다).
pub fn photo_files_of(e: &Value) -> Vec<(String, String)> {
    let mut out: Vec<(String, String)> = Vec::new();
    let mut add = |url: &str, x: &str| {
        if blossom_server_of(url).is_none() { return; }
        let h = url.rsplit('/').next().unwrap_or("").split('.').next().unwrap_or("");
        if !is_hex64(h) || (!x.is_empty() && x != h) || out.iter().any(|(_, have)| have == h) { return; }
        out.push((url.to_string(), h.to_string()));
    };
    for t in e.get("tags").and_then(Value::as_array).into_iter().flatten() {
        let Some(parts) = t.as_array() else { continue };
        if parts.first().and_then(Value::as_str) != Some("imeta") { continue; }
        let field = |name: &str| parts.iter().skip(1).filter_map(Value::as_str).find_map(|p| p.strip_prefix(name).map(str::trim)).unwrap_or("");
        add(field("url "), field("x "));
    }
    let content = e.get("content").and_then(Value::as_str).unwrap_or("");
    for w in content.split_whitespace().filter(|w| w.starts_with("https://")) { add(w, ""); }
    out
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Signer { Derived, Person }
/// 이 사진을 지워 달라고 서명할 열쇠 순서(폰 photoDeleteSigners). blossom.band 주소는 올린 열쇠의 npub 이 주소에 있어 바로 안다.
/// 둘 다 아니면 옛 일회용 열쇠 사진 — 지울 길이 없다(빈 목록).
pub fn photo_delete_signers(url: &str, person_pub: &str, derived_pub: &str) -> Vec<Signer> {
    if let Some(host) = url.strip_prefix("https://").and_then(|r| r.split('/').next()).and_then(|h| h.strip_suffix(".blossom.band")) {
        let npub = |p: &str| crate::talk_social::npub_of(p).unwrap_or_default();
        return if host == npub(derived_pub) { vec![Signer::Derived] } else if host == npub(person_pub) { vec![Signer::Person] } else { vec![] };
    }
    if cipher_url_ok(url) { return vec![Signer::Derived]; }
    if blossom_ok(url) { vec![Signer::Derived, Signer::Person] } else { vec![] }
}

/// 사진 서버에 이 사진을 지워 달라고 한다. 지웠으면(이미 없음 포함) true. 옛 일회용 열쇠 사진·닿지 못함은 false.
pub async fn delete_my_photo(person: &[u8; 32], url: &str, hash: &str) -> bool {
    let Some(server) = blossom_server_of(url) else { return false };
    let Ok(mut derived) = photo_upload_key(person, hash) else { return false };
    let (Ok(me), Ok(dpub)) = (crate::shopkey::pubkey_of(person), crate::shopkey::pubkey_of(&derived)) else { derived.fill(0); return false };
    let Ok(c) = reqwest::Client::builder().timeout(Duration::from_secs(15)).redirect(reqwest::redirect::Policy::none()).build() else { derived.fill(0); return false };
    let mut done = false;
    for who in photo_delete_signers(url, &me, &dpub) {
        let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0);
        let key = if who == Signer::Derived { &derived } else { person };
        let Ok(auth) = crate::shopkey::sign_with(key, 24242, blossom_delete_tags(hash, now), "Delete RavenVault talk photo", now) else { break };
        let header = format!("Nostr {}", base64::engine::general_purpose::STANDARD.encode(auth.to_string()));
        let Ok(r) = c.delete(format!("{server}/{hash}")).header("authorization", header).send().await else { break };
        let st = r.status().as_u16();
        if r.status().is_success() || st == 404 { done = true; break; }
        if st != 401 && st != 403 { break; } // 닿지 못함 — 다른 열쇠로 다시 해도 같다
    }
    derived.fill(0);
    done
}

/// 「한 번에 지우기」 결과 문구(폰 phone/screens/talkDeleteText.ts 와 같다 · 대표 확정). 「완전히 지웠어요」는 쓰지 않는다.
pub fn delete_outcome_text(photos: usize, photos_left: usize) -> &'static str {
    if photos_left > 0 { return "레이븐볼트에서는 지웠어요. 사진 서버에서는 지우지 못했어요."; }
    if photos == 0 { return "내 컴퓨터와 레이븐볼트에서 지웠어요. 이미 본 사람이 저장한 것은 못 지워요."; }
    "내 컴퓨터와 레이븐볼트에서 지웠어요. 사진 서버에도 지워 달라고 보냈어요. 이미 본 사람이 저장한 것은 못 지워요."
}

#[cfg(test)]
mod tests {
    use super::*;
    const H: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    #[test]
    fn 우리_사진_주소만_받는다() {
        assert!(blossom_ok(&format!("https://blossom.nostr.build/{H}.jpg")));
        assert!(blossom_ok(&format!("https://image.nostr.build/{H}")));
        assert!(blossom_ok(&format!("https://npub1{}.blossom.band/{H}.png", "q".repeat(58))));
        for bad in [
            format!("http://blossom.nostr.build/{H}.jpg"), format!("https://evil.example/{H}.jpg"), format!("https://blossom.nostr.build.evil/{H}"),
            format!("https://blossom.nostr.build/{H}.svg"), "https://blossom.nostr.build/abc.jpg".into(), format!("https://blossom.nostr.build/{H}.jpg?x=1"),
            format!("https://npub1{}.blossom.band/{H}", "b".repeat(58)),
        ] { assert!(!blossom_ok(&bad), "{bad}"); }
        assert!(picture_ok("https://ravenvault.ex.erci.se/emoji/ravi_love.webp"));
        assert!(!picture_ok("https://ravenvault.ex.erci.se/emoji/other.webp"));
        assert!(picture_ok(""));
        assert!(!picture_ok("https://example.com/me.jpg"), "바깥 주소는 안 받는다");
        assert!(!room_picture_ok("https://ravenvault.ex.erci.se/emoji/ravi_love.webp"), "방 사진은 진짜 사진만");
    }
    #[test]
    fn 미리보기_답은_우리_창구_그림만() {
        let (v, img) = clean_unfurl(&json!({ "url": "https://x.com/a/status/1", "kind": "x", "site": "X", "title": "T", "description": "D", "image": "/api/unfurl?img=a&s=b" })).unwrap();
        assert_eq!(v["kind"], json!("x")); assert_eq!(img, "/api/unfurl?img=a&s=b"); assert_eq!(v["image"], json!(""));
        let (_, img2) = clean_unfurl(&json!({ "title": "T", "image": "https://tracker.example/p.gif" })).unwrap();
        assert_eq!(img2, "", "바깥 그림 주소는 버린다");
        assert!(clean_unfurl(&json!({ "none": true })).is_none());
        assert!(clean_unfurl(&json!({ "title": "", "description": "" })).is_none());
        assert_eq!(urlencoding("https://a.b/c?d=e&f"), "https%3A%2F%2Fa.b%2Fc%3Fd%3De%26f");
    }
    /// 폰 core/talk/photo.ts photoUploadKey 와 같은 입력 → 같은 열쇠(폰 코드로 뽑은 값 · 11-23 tsx 로 계산).
    #[test]
    fn 사진_열쇠는_폰과_바이트까지_같다() {
        let mut me = [0u8; 32];
        me[31] = 7;
        let ka = photo_upload_key(&me, &"a".repeat(64)).unwrap();
        assert_eq!(hex::encode(ka), "c66fa5c3eb37f1e2cbb8342eafe6ca009e4774174197467530dab2c1873762f7");
        assert_eq!(crate::shopkey::pubkey_of(&ka).unwrap(), "aa5c6a4165fa6a15a8a30085dd8a0f8c51a7ca090164de23cbf76a50682dc12a");
        let kb = photo_upload_key(&me, &"b".repeat(64)).unwrap();
        assert_eq!(hex::encode(kb), "51ee637b0b830f8c483059121650ed65f43f8da477b8304985943a3be6623e92");
        assert_eq!(PHOTO_KEY_SALT, "ravenvault/blossom-photo-key/v1");
        assert!(photo_upload_key(&me, "xyz").is_err());
    }
    #[test]
    fn 지우기_서명_순서와_문구() {
        let mut me = [0u8; 32];
        me[31] = 7;
        let mpub = crate::shopkey::pubkey_of(&me).unwrap();
        let dpub = crate::shopkey::pubkey_of(&photo_upload_key(&me, H).unwrap()).unwrap();
        let band = |p: &str| format!("https://{}.blossom.band/{H}.jpg", crate::talk_social::npub_of(p).unwrap());
        assert_eq!(photo_delete_signers(&band(&dpub), &mpub, &dpub), vec![Signer::Derived]);
        assert_eq!(photo_delete_signers(&band(&mpub), &mpub, &dpub), vec![Signer::Person]);
        let mut other = [0u8; 32];
        other[31] = 8;
        assert!(photo_delete_signers(&band(&crate::shopkey::pubkey_of(&other).unwrap()), &mpub, &dpub).is_empty(), "옛 일회용 열쇠 사진은 지울 길 없음");
        assert_eq!(photo_delete_signers(&format!("https://nostr.download/{H}.bin"), &mpub, &dpub), vec![Signer::Derived]);
        assert_eq!(photo_delete_signers(&format!("https://blossom.nostr.build/{H}.jpg"), &mpub, &dpub), vec![Signer::Derived, Signer::Person]);
        assert_eq!(blossom_delete_tags(H, 1000), json!([["t", "delete"], ["x", H], ["expiration", "1300"]]));
        let e = json!({ "content": format!("밥\nhttps://blossom.nostr.build/{H}.jpg"), "tags": [["imeta", format!("url https://blossom.nostr.build/{H}.jpg"), format!("x {H}")]] });
        assert_eq!(photo_files_of(&e).len(), 1);
        for t in [delete_outcome_text(0, 0), delete_outcome_text(2, 0), delete_outcome_text(2, 1)] { assert!(!t.contains("완전히"), "{t}"); }
        assert_eq!(delete_outcome_text(2, 1), "레이븐볼트에서는 지웠어요. 사진 서버에서는 지우지 못했어요.");
    }
    #[test]
    fn 올리기_허락은_이_지문_하나만_5분() {
        let t = blossom_auth_tags(H, 1000);
        assert_eq!(t, json!([["t", "upload"], ["x", H], ["expiration", "1300"]]));
    }
}
