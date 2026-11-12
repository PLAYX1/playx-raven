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
    let mut once = [0u8; 32];
    rand::RngCore::fill_bytes(&mut rand::thread_rng(), &mut once);
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0);
    let auth = crate::shopkey::sign_with(&once, 24242, blossom_auth_tags(&hash, now), "Upload RavenVault talk photo", now);
    once.fill(0);
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
    Ok(json!({ "url": url }))
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
    #[test]
    fn 올리기_허락은_이_지문_하나만_5분() {
        let t = blossom_auth_tags(H, 1000);
        assert_eq!(t, json!([["t", "upload"], ["x", H], ["expiration", "1300"]]));
    }
}
