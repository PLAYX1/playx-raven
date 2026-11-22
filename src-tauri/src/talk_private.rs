//! **「나만」·「친구만」 글** (11-23 내 데이터 통제 3·4단계 — 폰 core/talk/private-note.ts · circle.ts 와 같은 형식)
//!
//! - 비공개 글 = kind 4470 · tags [] · content `{"v":1,"a":"self"|"friends",("e":세대),"c":NIP-44}`.
//!   「나만」 = 나→나 대화 열쇠 · 「친구만」 = 그 세대 서클 열쇠(대화 열쇠 자리에 그대로).
//!   속 = `{"v":1,"text":"…","photos":[DmFile…]}` — 사진은 쪽지 암호 사진과 같은 AES-256-GCM 암호문(nostr.download).
//! - 열쇠 꾸러미 = kind 30078 d=ravenvault/circle-keys/v1 · content `{"v":1,"self":NIP-44(나→나),"slots":[NIP-44(나→친구)…섞음]}`.
//! - 🔴 푼 글·친구 목록·서클 열쇠·사진 열쇠는 **메모리에만**(디스크에 쓰지 않는다). 디스크에 남기는 것은 「본 가장 높은 꾸러미」
//!   (세대 번호·시각 — 비밀 아님, `circle-seen.json`)뿐이다.
//! - 🔴 꾸러미 쓰기(폰 페이블 보안 검토 1): 쓰기 직전 **모든 릴레이 답**까지 읽고, 본 것보다 낮은 꾸러미(세대가 내려가거나 시각이 앞섬)
//!   위에는 쓰지도 그 열쇠로 잠그지도 않는다 · 새 꾸러미 시각 = max(지금, 이전+1) · 안 받은 릴레이는 화면에 알린다.
//! - 비공개 글·꾸러미는 이웃 전파·다시 올리기·바깥(터널) REQ 에 나가지 않는다(relay.rs·relay_share.rs).
use aes_gcm::aead::{Aead, KeyInit};
use base64::Engine;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::sync::Mutex;

use crate::relay::{CIRCLE_KEYS_D, KIND_PRIVATE_NOTE};
use crate::wallet_link::{conv_key, nip44_decrypt, nip44_encrypt};

/// 친구 상한(폰 CIRCLE_MAX · 11-23 꾸러미 크기 실측으로 30). 읽을 때는 칸 50개까지 받는다(줄이기 전 꾸러미).
pub const CIRCLE_MAX: usize = 30;
const CIRCLE_PARSE_MAX: usize = 50;
/// 내 칸에 남기는 옛 세대 열쇠 수 · 친구 칸에 넣는 세대 수(폰 SELF_KEEP_EPOCHS · SLOT_EPOCHS).
pub const SELF_KEEP_EPOCHS: usize = 64;
pub const SLOT_EPOCHS: usize = 3;
/// 11-23 우체국 F(폰 34c574d SLOT_ROUND): 꾸러미 칸을 빈 칸으로 10칸 단위까지 채워 친구 수를 가린다.
pub const SLOT_ROUND: usize = 10;
/// 친구 n 명 → 꾸러미 칸 수(빈 칸 포함). 친구가 없어도 10칸(「모두 뺐다」도 안 드러나게). 폰 paddedSlotCount 와 같다.
pub fn padded_slot_count(n: usize) -> usize { SLOT_ROUND.max(n.div_ceil(SLOT_ROUND) * SLOT_ROUND) }
/// 한 글 사진 최대 수 · 글 최대 길이(폰 MAX_POST_PHOTOS · MESSAGE_MAX).
const MAX_PHOTOS: usize = 4;
const MESSAGE_MAX: usize = 8000;
const CIPHER_UPLOAD: &str = "https://nostr.download/upload";
pub const CIRCLE_STALE: &str = "친구 목록이 아직 최신이 아니에요. 잠시 뒤 다시 해 주세요.";

fn is_hex(s: &str, n: usize) -> bool { s.len() == n && s.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f')) }
fn now() -> i64 { std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0) }
fn rand32() -> [u8; 32] { let mut k = [0u8; 32]; rand::RngCore::fill_bytes(&mut rand::rngs::OsRng, &mut k); k }
fn key32(hex_s: &str) -> Option<[u8; 32]> {
    let b = hex::decode(hex_s).ok().filter(|b| b.len() == 32)?;
    let mut k = [0u8; 32];
    k.copy_from_slice(&b);
    Some(k)
}
fn tag_d(e: &Value) -> Option<&str> {
    e.get("tags")?.as_array()?.iter().find(|t| t.get(0).and_then(Value::as_str) == Some("d"))?.get(1)?.as_str()
}

// ── 암호 사진(DmFile) ────────────────────────────────────────────────

/// 쪽지 암호 사진과 같은 모양(폰 cleanDmFile).
#[derive(Debug, Clone, PartialEq)]
pub struct DmFile { pub url: String, pub mime: String, pub key: String, pub nonce: String, pub sha256: String, pub plain_sha256: String, pub size: u64, pub width: u64, pub height: u64 }

impl DmFile {
    fn of(v: &Value) -> Option<DmFile> {
        let s = |k: &str| v.get(k).and_then(Value::as_str).map(str::to_string);
        let n = |k: &str| match v.get(k) { None => Some(0), Some(x) => x.as_u64() };
        let f = DmFile { url: s("url")?, mime: s("mime")?, key: s("key")?, nonce: s("nonce")?, sha256: s("sha256")?,
            plain_sha256: s("plainSha256").unwrap_or_default(), size: v.get("size")?.as_u64()?, width: n("width")?, height: n("height")? };
        // 🔴 암호 사진 주소는 우리 사진 길만(폰 26ce5ba — 추적 주소 자동 받기 막기).
        let ok = crate::talk_media::blossom_server_of(&f.url).is_some()
            && matches!(f.mime.as_str(), "image/jpeg" | "image/png" | "image/webp" | "image/gif")
            && is_hex(&f.key, 64) && is_hex(&f.nonce, 24) && is_hex(&f.sha256, 64)
            && (f.plain_sha256.is_empty() || is_hex(&f.plain_sha256, 64))
            && f.url.rsplit('/').next().and_then(|l| l.split('.').next()) == Some(f.sha256.as_str());
        ok.then_some(f)
    }
    fn json(&self) -> Value {
        json!({ "url": self.url, "mime": self.mime, "key": self.key, "nonce": self.nonce, "sha256": self.sha256,
                "plainSha256": self.plain_sha256, "size": self.size, "width": self.width, "height": self.height })
    }
}

/// 사진 바이트 → (암호문, DmFile 앞부분). 폰 dm-file.ts sealPhoto 와 같은 AES-256-GCM(암호문 뒤에 꼬리표 16바이트).
fn seal_photo(plain: &[u8], mime: &str) -> Result<(Vec<u8>, DmFile), String> {
    let mut key = rand32();
    let mut nonce = [0u8; 12];
    rand::RngCore::fill_bytes(&mut rand::rngs::OsRng, &mut nonce);
    let cipher = aes_gcm::Aes256Gcm::new_from_slice(&key).map_err(|_| "사진을 잠그지 못했어요.")?
        .encrypt(aes_gcm::Nonce::from_slice(&nonce), plain).map_err(|_| "사진을 잠그지 못했어요.")?;
    let sha = hex::encode(Sha256::digest(&cipher));
    let f = DmFile { url: format!("https://nostr.download/{sha}.bin"), mime: mime.into(), key: hex::encode(key), nonce: hex::encode(nonce),
        sha256: sha, plain_sha256: hex::encode(Sha256::digest(plain)), size: plain.len() as u64, width: 0, height: 0 };
    key.fill(0);
    Ok((cipher, f))
}
/// 받은 암호문 → 사진 바이트(지문·열쇠가 안 맞으면 None · 폰 openPhoto).
fn open_photo(cipher: &[u8], f: &DmFile) -> Option<Vec<u8>> {
    if hex::encode(Sha256::digest(cipher)) != f.sha256 { return None; }
    let mut key = key32(&f.key)?;
    let nonce = hex::decode(&f.nonce).ok().filter(|n| n.len() == 12)?;
    let plain = aes_gcm::Aes256Gcm::new_from_slice(&key).ok()?.decrypt(aes_gcm::Nonce::from_slice(&nonce), cipher).ok();
    key.fill(0);
    let plain = plain?;
    if !f.plain_sha256.is_empty() && hex::encode(Sha256::digest(&plain)) != f.plain_sha256 { return None; }
    Some(plain)
}

// ── 비공개 글(4470) ───────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq)]
pub struct PrivateNote { pub id: String, pub pubkey: String, pub at: i64, pub audience: &'static str, pub text: String, pub photos: Vec<DmFile> }

fn body_json(text: &str, photos: &[DmFile]) -> Result<String, String> {
    let text = text.trim();
    if text.is_empty() && photos.is_empty() { return Err("쓸 내용이 없어요.".into()); }
    if text.chars().count() > MESSAGE_MAX { return Err("글이 너무 길어요. 8,000자 아래로 줄여 주세요.".into()); }
    Ok(json!({ "v": 1, "text": text, "photos": photos.iter().take(MAX_PHOTOS).map(DmFile::json).collect::<Vec<_>>() }).to_string())
}
fn body_of(plain: &str) -> Option<(String, Vec<DmFile>)> {
    let v: Value = serde_json::from_str(plain).ok()?;
    if v.get("v")?.as_i64()? != 1 { return None; }
    let text = v.get("text")?.as_str()?.chars().take(MESSAGE_MAX * 2).collect::<String>();
    let photos: Option<Vec<DmFile>> = v.get("photos")?.as_array()?.iter().take(MAX_PHOTOS).map(DmFile::of).collect();
    let photos = photos?;
    if text.trim().is_empty() && photos.is_empty() { return None; }
    Some((text, photos))
}

/// 「나만」 글 content.
pub fn self_note_content(sk: &[u8; 32], text: &str, photos: &[DmFile]) -> Result<String, String> {
    let me = crate::shopkey::pubkey_of(sk)?;
    let conv = conv_key(sk, &me).ok_or("열쇠를 읽지 못했어요.")?;
    let c = nip44_encrypt(&body_json(text, photos)?, &conv, rand32()).ok_or("글을 잠그지 못했어요.")?;
    Ok(json!({ "v": 1, "a": "self", "c": c }).to_string())
}
/// 「친구만」 글 content — 지금 세대 서클 열쇠로.
pub fn friends_note_content(epoch: i64, key: &[u8; 32], text: &str, photos: &[DmFile]) -> Result<String, String> {
    let c = nip44_encrypt(&body_json(text, photos)?, key, rand32()).ok_or("글을 잠그지 못했어요.")?;
    Ok(json!({ "v": 1, "a": "friends", "e": epoch, "c": c }).to_string())
}

/// 비공개 글 하나를 푼다(폰 openPrivateNote). 「나만」 = 내 것만 · 「친구만」 = 그 글쓴이의 그 세대 열쇠가 있을 때만. 못 열면 None(오류 아님).
pub fn open_private_note(e: &Value, sk: &[u8; 32], keys_of: &dyn Fn(&str) -> Option<HashMap<i64, [u8; 32]>>) -> Option<PrivateNote> {
    if e.get("kind")?.as_i64()? != KIND_PRIVATE_NOTE { return None; }
    let author = e.get("pubkey")?.as_str()?.to_string();
    let env: Value = serde_json::from_str(e.get("content")?.as_str()?).ok()?;
    if env.get("v")?.as_i64()? != 1 { return None; }
    let c = env.get("c")?.as_str()?;
    if c.len() > 200_000 { return None; }
    let (audience, conv) = match env.get("a")?.as_str()? {
        "self" => {
            let me = crate::shopkey::pubkey_of(sk).ok()?;
            if author != me { return None; }
            ("self", conv_key(sk, &me)?)
        }
        "friends" => {
            let ep = env.get("e")?.as_i64().filter(|n| *n > 0)?;
            ("friends", *keys_of(&author)?.get(&ep)?)
        }
        _ => return None,
    };
    let (text, photos) = body_of(&nip44_decrypt(c, &conv)?)?;
    Some(PrivateNote { id: e.get("id")?.as_str()?.to_string(), pubkey: author, at: e.get("created_at")?.as_i64()?, audience, text, photos })
}

// ── 열쇠 꾸러미(30078) ────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq, Default)]
pub struct CircleState { pub epoch: i64, pub friends: Vec<(String, i64)>, pub keys: Vec<(i64, String)> }

impl CircleState {
    pub fn current(&self) -> Option<(i64, [u8; 32])> {
        if self.epoch <= 0 { return None; }
        self.keys.iter().find(|(e, _)| *e == self.epoch).and_then(|(e, k)| key32(k).map(|k| (*e, k)))
    }
    pub fn key_map(&self) -> HashMap<i64, [u8; 32]> { self.keys.iter().filter_map(|(e, k)| key32(k).map(|k| (*e, k))).collect() }
    fn next(&self, friends: Vec<(String, i64)>, new_key: &[u8; 32]) -> CircleState {
        let epoch = self.epoch + 1;
        let mut keys: Vec<(i64, String)> = self.keys.iter().filter(|(e, _)| *e != epoch).cloned().collect();
        keys.push((epoch, hex::encode(new_key)));
        let cut = keys.len().saturating_sub(SELF_KEEP_EPOCHS);
        CircleState { epoch, friends, keys: keys.split_off(cut) }
    }
    /// 친구 넣기 — 새 세대(폰 circleAdd).
    pub fn add(&self, me: &str, friend: &str, new_key: &[u8; 32]) -> Result<CircleState, String> {
        if !is_hex(friend, 64) || friend == me { return Err("이 사람을 친구로 넣을 수 없어요.".into()); }
        if self.friends.iter().any(|(p, _)| p == friend) { return Ok(self.clone()); }
        if self.friends.len() >= CIRCLE_MAX { return Err(format!("친구는 {CIRCLE_MAX}명까지 넣을 수 있어요.")); }
        let mut f = self.friends.clone();
        f.push((friend.to_string(), self.epoch + 1));
        Ok(self.next(f, new_key))
    }
    /// 친구 빼기 — 새 세대. 뺀 친구는 새 열쇠를 못 받는다(옛 글은 회수 못 함).
    pub fn remove(&self, friend: &str, new_key: &[u8; 32]) -> CircleState {
        if !self.friends.iter().any(|(p, _)| p == friend) { return self.clone(); }
        self.next(self.friends.iter().filter(|(p, _)| p != friend).cloned().collect(), new_key)
    }
}

fn keys_of(v: &Value) -> Option<Vec<(i64, String)>> {
    v.as_array()?.iter().map(|x| {
        let a = x.as_array().filter(|a| a.len() == 2)?;
        let e = a[0].as_i64().filter(|e| *e > 0)?;
        let k = a[1].as_str().filter(|k| is_hex(k, 64))?;
        Some((e, k.to_string()))
    }).collect()
}
fn bundle_parts(e: &Value) -> Option<(String, Vec<String>)> {
    let v: Value = serde_json::from_str(e.get("content")?.as_str()?).ok()?;
    if v.get("v")?.as_i64()? != 1 { return None; }
    let slots = v.get("slots")?.as_array()?;
    if slots.len() > CIRCLE_PARSE_MAX { return None; }
    Some((v.get("self")?.as_str()?.to_string(), slots.iter().map(|s| s.as_str().map(str::to_string)).collect::<Option<Vec<_>>>()?))
}
fn is_bundle(e: &Value, author: &str) -> bool {
    e.get("kind").and_then(Value::as_i64) == Some(30078) && e.get("pubkey").and_then(Value::as_str) == Some(author) && tag_d(e) == Some(CIRCLE_KEYS_D)
}
/// 같은 사람의 가장 늦은 꾸러미(같은 시각이면 id 가 작은 것 · 폰 latestCircleBundle).
pub fn latest_bundle<'a>(events: &'a [Value], author: &str) -> Option<&'a Value> {
    let at = |e: &Value| e.get("created_at").and_then(Value::as_i64).unwrap_or(0);
    let id = |e: &'a Value| e.get("id").and_then(Value::as_str).unwrap_or("");
    events.iter().filter(|e| is_bundle(e, author)).fold(None, |best: Option<&Value>, e| match best {
        Some(b) if at(b) > at(e) || (at(b) == at(e) && id(b) <= id(e)) => Some(b),
        _ => Some(e),
    })
}
/// 내 꾸러미 → (서클 상태, 그 꾸러미 시각 · 없으면 0). 꾸러미가 없으면 빈 서클. 풀지 못하면 Err(덮어쓰지 않게).
pub fn open_my_circle(events: &[Value], sk: &[u8; 32]) -> Result<(CircleState, i64), String> {
    let me = crate::shopkey::pubkey_of(sk)?;
    let Some(e) = latest_bundle(events, &me) else { return Ok((CircleState::default(), 0)) };
    let fail = || "친구 목록을 풀지 못했어요. 덮어쓰지 않고 그대로 둘게요.".to_string();
    let (self_c, _) = bundle_parts(e).ok_or_else(fail)?;
    let conv = conv_key(sk, &me).ok_or_else(fail)?;
    let o: Value = nip44_decrypt(&self_c, &conv).and_then(|p| serde_json::from_str(&p).ok()).ok_or_else(fail)?;
    if o.get("v").and_then(Value::as_i64) != Some(1) { return Err(fail()); }
    let epoch = o.get("epoch").and_then(Value::as_i64).filter(|n| *n >= 0).ok_or_else(fail)?;
    let keys = o.get("keys").and_then(keys_of).ok_or_else(fail)?;
    let friends: Vec<(String, i64)> = o.get("friends").and_then(Value::as_array).ok_or_else(fail)?.iter().map(|f| {
        Some((f.get("p")?.as_str().filter(|p| is_hex(p, 64))?.to_string(), f.get("since")?.as_i64()?))
    }).collect::<Option<Vec<_>>>().ok_or_else(fail)?;
    Ok((CircleState { epoch, friends, keys }, e.get("created_at").and_then(Value::as_i64).unwrap_or(0)))
}
/// 남의 꾸러미 → 내 칸이 있으면 그 사람의 세대 열쇠들(폰 openFriendSlot).
pub fn open_friend_slot(bundle: &Value, sk: &[u8; 32]) -> Option<HashMap<i64, [u8; 32]>> {
    let (_, slots) = bundle_parts(bundle)?;
    let conv = conv_key(sk, bundle.get("pubkey")?.as_str()?)?;
    slots.iter().find_map(|s| {
        let o: Value = serde_json::from_str(&nip44_decrypt(s, &conv)?).ok()?;
        if o.get("v")?.as_i64()? != 1 { return None; }
        Some(keys_of(o.get("k")?)?.into_iter().filter_map(|(e, k)| key32(&k).map(|k| (e, k))).collect())
    })
}
/// 꾸러미 content(폰 circleBundleDraft) · 칸은 섞는다.
pub fn bundle_content(sk: &[u8; 32], st: &CircleState) -> Result<String, String> {
    use rand::seq::SliceRandom;
    let me = crate::shopkey::pubkey_of(sk)?;
    if st.friends.len() > CIRCLE_MAX { return Err(format!("친구는 {CIRCLE_MAX}명까지 넣을 수 있어요.")); }
    let conv = conv_key(sk, &me).ok_or("열쇠를 읽지 못했어요.")?;
    let friends: Vec<Value> = st.friends.iter().map(|(p, s)| json!({ "p": p, "since": s })).collect();
    let keys: Vec<Value> = st.keys.iter().map(|(e, k)| json!([e, k])).collect();
    let self_c = nip44_encrypt(&json!({ "v": 1, "epoch": st.epoch, "friends": friends, "keys": keys }).to_string(), &conv, rand32()).ok_or("친구 목록을 잠그지 못했어요.")?;
    let mut slots = Vec::new();
    let mut counts: Vec<usize> = Vec::new();
    for (p, since) in &st.friends {
        let mine: Vec<&(i64, String)> = st.keys.iter().filter(|(e, _)| e >= since).collect();
        let k: Vec<Value> = mine[mine.len().saturating_sub(SLOT_EPOCHS)..].iter().map(|(e, k)| json!([e, k])).collect();
        counts.push(k.len().max(1));
        let c = conv_key(sk, p).ok_or("친구 열쇠를 읽지 못했어요.")?;
        slots.push(nip44_encrypt(&json!({ "v": 1, "k": k }).to_string(), &c, rand32()).ok_or("친구 칸을 잠그지 못했어요.")?);
    }
    // 빈 칸: 진짜 칸과 같은 모양·같은 길이(열쇠 수를 진짜 칸 중 하나에서 빌린다)를 아무도 모르는 랜덤 열쇠로 잠근다 — 열리는 사람이 없다(폰 circleBundleDraft 와 같다).
    for i in slots.len()..padded_slot_count(st.friends.len()) {
        let n = if counts.is_empty() { 1 } else { counts[i % counts.len()] };
        let mut fake: Vec<Value> = (0..n).map(|j| json!([(st.epoch - j as i64).max(1), hex::encode(rand32())])).collect();
        fake.reverse();
        slots.push(nip44_encrypt(&json!({ "v": 1, "k": fake }).to_string(), &rand32(), rand32()).ok_or("친구 칸을 잠그지 못했어요.")?);
    }
    slots.shuffle(&mut rand::rngs::OsRng);
    Ok(json!({ "v": 1, "self": self_c, "slots": slots }).to_string())
}

/// 본 꾸러미보다 낮은가(폰 circleIsStale).
pub fn circle_is_stale(got: (i64, i64), seen: Option<(i64, i64)>) -> bool { seen.is_some_and(|(e, a)| got.0 < e || got.1 < a) }
/// 새 꾸러미 시각 = max(지금, 이전 + 1).
pub fn bundle_time(prev_at: i64, now: i64) -> i64 { now.max(prev_at + 1) }

// ── 이 기기가 본 꾸러미(비밀 아님) · 메모리 ───────────────────────────────

fn seen_file() -> std::path::PathBuf { crate::paths::app_file("circle-seen.json") }
fn seen_of(me: &str) -> Option<(i64, i64)> {
    let v: Value = serde_json::from_str(&std::fs::read_to_string(seen_file()).ok()?).ok()?;
    let x = v.get(me)?;
    Some((x.get("epoch")?.as_i64()?, x.get("at")?.as_i64()?))
}
fn remember_seen(me: &str, got: (i64, i64)) {
    let mut v: Value = std::fs::read_to_string(seen_file()).ok().and_then(|s| serde_json::from_str(&s).ok()).filter(Value::is_object).unwrap_or(json!({}));
    let (e, a) = seen_of(me).map_or(got, |(e, a)| (e.max(got.0), a.max(got.1)));
    v[me] = json!({ "epoch": e, "at": a });
    let tmp = seen_file().with_extension("json.tmp");
    if std::fs::write(&tmp, v.to_string()).is_ok() { let _ = std::fs::rename(&tmp, seen_file()); }
}

/// 메모리만: (주인, 내 서클, 꾸러미 시각) · 친구에게 받은 세대 열쇠 · 푼 글(사진 열쇠 포함).
static CIRCLE: Mutex<Option<(String, CircleState, i64)>> = Mutex::new(None);
static FRIEND_KEYS: Mutex<Option<HashMap<String, HashMap<i64, [u8; 32]>>>> = Mutex::new(None);
static NOTES: Mutex<Option<(String, Vec<PrivateNote>)>> = Mutex::new(None);
/// 꾸러미 쓰기는 하나씩.
static WRITING: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

fn signing() -> Result<([u8; 32], String), String> {
    let sk = crate::talk::signing_key()?;
    let me = crate::shopkey::pubkey_of(&sk)?;
    Ok((sk, me))
}
fn circle_filter(authors: &[String]) -> Value { json!({ "kinds": [30078], "authors": authors, "#d": [CIRCLE_KEYS_D], "limit": (authors.len() * 2).max(5) }) }

/// 내 꾸러미 읽기. `for_write` = 쓰거나 그 열쇠로 잠그기 직전 — 모든 릴레이 답까지 기다린다.
async fn read_my_circle(sk: &[u8; 32], me: &str, for_write: bool) -> Result<(CircleState, i64), String> {
    let me_v = vec![me.to_string()];
    let (mut events, reached) = if for_write {
        crate::nostrpub::query_all_wait(vec![circle_filter(&me_v)]).await
    } else {
        crate::nostrpub::query_filters(vec![circle_filter(&me_v)]).await.unwrap_or_default()
    };
    events.extend(crate::relay::events_of(me, &[30078]).0);
    if reached == 0 { return Err("친구 목록을 읽지 못했어요. 인터넷 연결을 확인해 주세요.".into()); }
    let (state, at) = open_my_circle(&events, sk)?;
    if circle_is_stale((state.epoch, at), seen_of(me)) { return Err(CIRCLE_STALE.into()); }
    remember_seen(me, (state.epoch, at));
    *CIRCLE.lock().unwrap_or_else(|e| e.into_inner()) = Some((me.to_string(), state.clone(), at));
    Ok((state, at))
}

fn note_view(n: &PrivateNote) -> Value {
    json!({ "id": n.id, "pubkey": n.pubkey, "at": n.at, "audience": n.audience, "text": n.text,
            "photos": n.photos.iter().map(|f| json!({ "sha256": f.sha256, "mime": f.mime })).collect::<Vec<_>>() })
}
fn remember_notes(me: &str, list: Vec<PrivateNote>) {
    let mut g = NOTES.lock().unwrap_or_else(|e| e.into_inner());
    let mut all: Vec<PrivateNote> = g.take().filter(|(p, _)| p == me).map(|(_, v)| v).unwrap_or_default();
    for n in list { if !all.iter().any(|x| x.id == n.id) { all.push(n); } }
    all.sort_by_key(|n| std::cmp::Reverse(n.at));
    all.truncate(500);
    *g = Some((me.to_string(), all));
}
fn forget_note(id: &str) {
    if let Some((_, v)) = NOTES.lock().unwrap_or_else(|e| e.into_inner()).as_mut() { v.retain(|n| n.id != id); }
}
fn cached_note(me: &str, id: &str) -> Option<PrivateNote> {
    NOTES.lock().unwrap_or_else(|e| e.into_inner()).as_ref().filter(|(p, _)| p == me).and_then(|(_, v)| v.iter().find(|n| n.id == id).cloned())
}

/// 내 「나만」·「친구만」 글 + 나를 친구로 넣은 사람(내가 팔로우한 사람)의 「친구만」 글. 최신이 앞.
/// 돌려줌 `{ notes: [{id,pubkey,at,audience,text,photos:[{sha256,mime}]}], friends: [공개키], circle_problem? }` — 열쇠는 안 나간다.
#[tauri::command]
pub async fn talk_private_load() -> Result<Value, String> {
    let (mut sk, me) = signing()?;
    let circle = read_my_circle(&sk, &me, false).await;
    let (mine_keys, friends, problem) = match &circle {
        Ok((st, _)) => (st.key_map(), st.friends.iter().map(|(p, _)| p.clone()).collect::<Vec<_>>(), None),
        Err(e) => (HashMap::new(), vec![], Some(e.clone())),
    };
    // 나를 넣었을지 모르는 사람 = 내가 팔로우한 사람(kind 3 p 표 · 이 컴퓨터가 지켜 둔 것).
    let follows: Vec<String> = crate::relay::events_of(&me, &[3]).0.first()
        .and_then(|e| e.get("tags").and_then(Value::as_array).cloned()).unwrap_or_default().iter()
        .filter(|t| t.get(0).and_then(Value::as_str) == Some("p"))
        .filter_map(|t| t.get(1).and_then(Value::as_str).filter(|p| is_hex(p, 64) && *p != me).map(str::to_string))
        .take(200).collect();
    if !follows.is_empty() {
        if let Ok((bundles, _)) = crate::nostrpub::query_filters(vec![circle_filter(&follows)]).await {
            let mut g = FRIEND_KEYS.lock().unwrap_or_else(|e| e.into_inner());
            let fk = g.get_or_insert_with(HashMap::new);
            for a in &follows {
                if let Some(keys) = latest_bundle(&bundles, a).and_then(|b| open_friend_slot(b, &sk)) {
                    fk.entry(a.clone()).or_default().extend(keys); // 예전에 받은 세대 열쇠도 이 실행 동안은 남긴다
                }
            }
        }
    }
    let fk: HashMap<String, HashMap<i64, [u8; 32]>> = FRIEND_KEYS.lock().unwrap_or_else(|e| e.into_inner()).clone().unwrap_or_default();
    let mut authors: Vec<String> = vec![me.clone()];
    authors.extend(fk.keys().cloned());
    let mut events = crate::relay::events_of(&me, &[KIND_PRIVATE_NOTE]).0;
    let (got, _) = crate::nostrpub::query_filters(vec![json!({ "kinds": [KIND_PRIVATE_NOTE], "authors": authors, "limit": 300 })]).await.unwrap_or_default();
    events.extend(got);
    let keys_of = |a: &str| if a == me { Some(mine_keys.clone()) } else { fk.get(a).cloned() };
    let mut seen = std::collections::HashSet::new();
    let mut opened: Vec<PrivateNote> = events.iter().filter_map(|e| open_private_note(e, &sk, &keys_of)).filter(|n| seen.insert(n.id.clone())).collect();
    crate::words::wipe_bytes(&mut sk);
    // 지운 글은 뺀다 — 내 것은 이 컴퓨터가 지켜 둔 지우기 요청, 친구 것은 그 사람 kind 5 를 묻는다.
    let mut gone: std::collections::HashSet<String> = crate::relay::events_of(&me, &[5]).1.into_iter().collect();
    let theirs: Vec<String> = opened.iter().filter(|n| n.pubkey != me).map(|n| n.id.clone()).collect();
    if !theirs.is_empty() {
        let authors: Vec<String> = fk.keys().cloned().collect();
        if let Ok((dels, _)) = crate::nostrpub::query_filters(vec![json!({ "kinds": [5], "authors": authors, "#e": theirs, "limit": 300 })]).await {
            for d in dels.iter().filter(|d| crate::relay::verify(d)) {
                let by = d.get("pubkey").and_then(Value::as_str).unwrap_or("");
                for t in d.get("tags").and_then(Value::as_array).into_iter().flatten() {
                    if t.get(0).and_then(Value::as_str) == Some("e") {
                        if let Some(id) = t.get(1).and_then(Value::as_str) {
                            if opened.iter().any(|n| n.id == id && n.pubkey == by) { gone.insert(id.to_string()); }
                        }
                    }
                }
            }
        }
    }
    opened.retain(|n| !gone.contains(&n.id));
    opened.sort_by_key(|n| std::cmp::Reverse(n.at));
    let view: Vec<Value> = opened.iter().map(note_view).collect();
    remember_notes(&me, opened);
    Ok(json!({ "me": me, "notes": view, "friends": friends, "circle_problem": problem }))
}

/// 비공개 글 사진 한 장 → data: 주소(메모리에서만 푼다 · 평문은 디스크에 안 쓴다). 이 컴퓨터 사진 폴더에 암호문 사본이 있으면 그것 먼저.
#[tauri::command]
pub async fn talk_private_photo(sha256: String) -> Result<Option<String>, String> {
    if !is_hex(&sha256, 64) { return Ok(None); }
    let file = NOTES.lock().unwrap_or_else(|e| e.into_inner()).as_ref()
        .and_then(|(_, v)| v.iter().flat_map(|n| n.photos.iter()).find(|f| f.sha256 == sha256).cloned());
    let Some(f) = file else { return Ok(None) };
    let cipher = match crate::my_photos::local_cipher(&sha256) {
        Some(b) => b,
        None => crate::upload::download_talk_cipher(&f.url).await?,
    };
    let Some(plain) = open_photo(&cipher, &f) else { return Ok(None) };
    if !crate::my_photos::is_image(&plain) { return Ok(None); }
    Ok(Some(format!("data:{};base64,{}", f.mime, base64::engine::general_purpose::STANDARD.encode(&plain))))
}

/// 내 「친구만」 볼 사람들(내가 고른 친구). 못 읽으면 오류.
#[tauri::command]
pub async fn talk_circle() -> Result<Value, String> {
    let (mut sk, me) = signing()?;
    let r = read_my_circle(&sk, &me, false).await;
    crate::words::wipe_bytes(&mut sk);
    let (st, _) = r?;
    Ok(json!({ "friends": st.friends.iter().map(|(p, _)| p).collect::<Vec<_>>(), "max": CIRCLE_MAX }))
}

/// 친구 넣기·빼기 — 바꾸기 직전 모든 릴레이에서 다시 읽고, 새 세대 열쇠로 꾸러미를 다시 올린다. `refused` = 안 받은 릴레이.
#[tauri::command]
pub async fn talk_circle_set(friend: String, add: bool) -> Result<Value, String> {
    let _w = WRITING.lock().await;
    let friend = friend.trim().to_ascii_lowercase();
    let (mut sk, me) = signing()?;
    let out = async {
        let (before, at) = read_my_circle(&sk, &me, true).await?;
        let mut fresh = rand32();
        let next = if add { before.add(&me, &friend, &fresh) } else { Ok(before.remove(&friend, &fresh)) };
        fresh.fill(0);
        let next = next?;
        if next == before { return Ok(json!({ "friends": before.friends.iter().map(|(p, _)| p).collect::<Vec<_>>(), "refused": [] })); }
        let created = bundle_time(at, now());
        let ev = crate::shopkey::sign_with(&sk, 30078, json!([["d", CIRCLE_KEYS_D]]), &bundle_content(&sk, &next)?, created)?;
        let (ok, refused) = crate::nostrpub::publish_private_all(ev).await?;
        if ok.is_empty() { return Err("릴레이가 모두 받지 않았어요. 잠시 뒤 다시 해 주세요.".to_string()); }
        remember_seen(&me, (next.epoch, created));
        *CIRCLE.lock().unwrap_or_else(|e| e.into_inner()) = Some((me.clone(), next.clone(), created));
        let host = |u: &String| u.split("://").nth(1).unwrap_or(u).split('/').next().unwrap_or(u).to_string();
        Ok(json!({ "friends": next.friends.iter().map(|(p, _)| p).collect::<Vec<_>>(), "refused": refused.iter().map(host).collect::<Vec<_>>(),
                   "say": if add { "" } else { "지금부터 올리는 글만 안 보여요. 예전 글은 남을 수 있어요" } }))
    }.await;
    crate::words::wipe_bytes(&mut sk);
    out
}

/// 사진 한 장 잠가 올리기(쪽지 암호 사진 길 · 사진 열쇠 서명 → nostr.download).
async fn upload_sealed(sk: &[u8; 32], plain: &[u8], mime: &str) -> Result<DmFile, String> {
    let (cipher, file) = seal_photo(plain, mime)?;
    let mut pk = crate::talk_media::photo_upload_key(sk, &file.sha256)?;
    let t = now();
    let auth = crate::shopkey::sign_with(&pk, 24242, crate::talk_media::blossom_auth_tags(&file.sha256, t), "Upload RavenVault talk photo", t);
    pk.fill(0);
    let header = format!("Nostr {}", base64::engine::general_purpose::STANDARD.encode(auth?.to_string()));
    let r = reqwest::Client::builder().timeout(std::time::Duration::from_secs(60)).build().map_err(|e| e.to_string())?
        .put(CIPHER_UPLOAD).header("authorization", header).header("content-type", "application/octet-stream").header("x-sha-256", &file.sha256)
        .body(cipher.clone()).send().await.map_err(|_| "사진 서버에 닿지 못했어요. 인터넷 연결을 확인해 주세요.".to_string())?;
    if !r.status().is_success() { return Err(format!("사진 서버가 받지 않았어요({}). 잠시 뒤 다시 해 주세요.", r.status().as_u16())); }
    let v: Value = r.json().await.map_err(|_| "사진 서버의 답을 읽지 못했어요.".to_string())?;
    if v.get("sha256").and_then(Value::as_str) != Some(file.sha256.as_str()) { return Err("사진 서버의 답이 맞지 않아요. 다시 올려 주세요.".into()); }
    crate::my_photos::keep_cipher(&file.sha256, &cipher);
    Ok(file)
}

/// 「나만」·「친구만」 글 올리기. audience = "self" | "friends". 사진은 화면이 고른 것(떨어뜨린 경로 또는 내용) 한 장까지.
#[tauri::command]
pub async fn talk_private_post(text: String, audience: String, path: Option<String>, name: Option<String>, bytes: Option<Vec<u8>>) -> Result<Value, String> {
    let text = text.trim().to_string();
    if crate::talk_social::has_nsec(&text) { return Err("열쇠처럼 보이는 글은 올릴 수 없어요.".into()); }
    let (mut sk, me) = signing()?;
    let out = async {
        // 친구만 — 잠글 열쇠는 늘 모든 릴레이에서 새로 읽은 것(낡은 세대 열쇠로 잠그지 않게). 친구가 없으면 사진을 올리기 전에 멈춘다.
        let lock = if audience == "friends" {
            let _w = WRITING.lock().await;
            let (st, _) = read_my_circle(&sk, &me, true).await?;
            let now_key = st.current().filter(|_| !st.friends.is_empty())
                .ok_or("친구를 먼저 정해 주세요. 사람 이름표에서 「친구만 글 보여 주기」를 눌러요.")?;
            Some((now_key, st.key_map()))
        } else if audience == "self" { None } else { return Err("누구에게 보일지 골라 주세요.".to_string()) };
        let raw = match (path, bytes) {
            (Some(p), _) => {
                if !crate::dropbox::was_dropped(&p) { return Err("이 파일은 창에 떨어뜨린 것이 아닙니다. 사진을 창에 끌어다 놓거나 「사진 고르기」로 골라 주세요.".to_string()); }
                Some(std::fs::read(&p).map_err(|e| format!("사진을 읽지 못했습니다: {e}"))?)
            }
            (None, Some(b)) => Some(b),
            (None, None) => None,
        };
        let _ = name;
        let mut photos = Vec::new();
        if let Some(b) = raw {
            if b.len() > crate::upload::MAX_TALK_PHOTO_BYTES { return Err("사진이 너무 커요. 20MB 아래 사진을 골라 주세요.".to_string()); }
            let mime = crate::my_photos::image_mime(&b).filter(|m| *m != "image/avif").ok_or("JPG·PNG·GIF·WebP 사진만 보낼 수 있어요.")?;
            photos.push(upload_sealed(&sk, &b, mime).await?);
        }
        let content = match &lock {
            Some(((ep, key), _)) => friends_note_content(*ep, key, &text, &photos)?,
            None => self_note_content(&sk, &text, &photos)?,
        };
        let ev = crate::shopkey::sign_with(&sk, KIND_PRIVATE_NOTE, json!([]), &content, now())?;
        let (ok, _) = crate::nostrpub::publish_private_all(ev.clone()).await?;
        if ok.is_empty() { return Err("릴레이가 모두 받지 않았어요. 잠시 뒤 다시 해 주세요.".to_string()); }
        let mine_keys = lock.map(|(_, m)| m).unwrap_or_default();
        let n = open_private_note(&ev, &sk, &|a: &str| (a == me).then(|| mine_keys.clone())).ok_or("올린 글을 다시 열지 못했어요.")?;
        let view = note_view(&n);
        remember_notes(&me, vec![n]);
        Ok(json!({ "note": view }))
    }.await;
    crate::words::wipe_bytes(&mut sk);
    out
}

/// 내 비공개 글 지우기 — kind 5(e·k=4470·t) + 그 글 암호 사진마다 사진 서버 DELETE + 이 컴퓨터 사진 폴더 사본 지움. 결과 문구는 폰과 같다.
#[tauri::command]
pub async fn talk_private_delete(id: String) -> Result<Value, String> {
    let id = id.trim().to_ascii_lowercase();
    if !is_hex(&id, 64) { return Err("글 번호가 올바르지 않습니다.".into()); }
    let (mut sk, me) = signing()?;
    let out = async {
        let note = cached_note(&me, &id).ok_or("내 글로 확인되지 않았어요. 화면을 다시 열어 주세요.")?;
        if note.pubkey != me { return Err("내 글만 지울 수 있어요.".to_string()); }
        let ev = crate::shopkey::sign_with(&sk, 5, json!([["e", id], ["k", KIND_PRIVATE_NOTE.to_string()], ["t", crate::talk::TALK_TAG]]), "", now())?;
        crate::nostrpub::nostr_publish(ev).await?;
        let mut left = 0usize;
        for f in &note.photos {
            if !crate::talk_media::delete_my_photo(&sk, &f.url, &f.sha256).await { left += 1; }
        }
        crate::my_photos::drop_sources(&std::collections::HashSet::from([id.clone()]));
        forget_note(&id);
        Ok(json!({ "ok": true, "photos": note.photos.len(), "photos_left": left, "say": crate::talk_media::delete_outcome_text(note.photos.len(), left) }))
    }.await;
    crate::words::wipe_bytes(&mut sk);
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    fn sk(n: u8) -> [u8; 32] { let mut k = [0u8; 32]; k[31] = n; k }

    #[test]
    fn 나만_친구만_글을_쓰고_다시_연다() {
        let me = sk(7);
        let mp = crate::shopkey::pubkey_of(&me).unwrap();
        let photo = DmFile { url: format!("https://nostr.download/{}.bin", "a".repeat(64)), mime: "image/jpeg".into(), key: "1".repeat(64), nonce: "2".repeat(24),
            sha256: "a".repeat(64), plain_sha256: String::new(), size: 3, width: 0, height: 0 };
        let c = self_note_content(&me, "나만 봐요", &[photo.clone()]).unwrap();
        let e = crate::shopkey::sign_with(&me, KIND_PRIVATE_NOTE, json!([]), &c, 1000).unwrap();
        let n = open_private_note(&e, &me, &|_| None).unwrap();
        assert_eq!((n.audience, n.text.as_str(), n.photos.len()), ("self", "나만 봐요", 1));
        assert!(open_private_note(&e, &sk(8), &|_| None).is_none(), "남은 「나만」을 못 연다");
        let key = [9u8; 32];
        let fc = friends_note_content(3, &key, "친구만", &[]).unwrap();
        let fe = crate::shopkey::sign_with(&me, KIND_PRIVATE_NOTE, json!([]), &fc, 1000).unwrap();
        let ok = open_private_note(&fe, &sk(8), &|a| (a == mp).then(|| HashMap::from([(3, key)]))).unwrap();
        assert_eq!(ok.audience, "friends");
        assert!(open_private_note(&fe, &sk(8), &|_| Some(HashMap::from([(2, key)]))).is_none(), "다른 세대 열쇠로는 못 연다");
        // 우리 사진 길이 아닌 주소는 사진으로 안 받는다(추적 주소).
        let bad = DmFile { url: format!("https://evil.example/{}.bin", "a".repeat(64)), ..photo };
        assert!(DmFile::of(&bad.json()).is_none());
    }

    #[test]
    fn 꾸러미_넣기_빼기_세대와_칸() {
        let me = sk(7);
        let mp = crate::shopkey::pubkey_of(&me).unwrap();
        let (a, b) = (crate::shopkey::pubkey_of(&sk(8)).unwrap(), crate::shopkey::pubkey_of(&sk(9)).unwrap());
        let s1 = CircleState::default().add(&mp, &a, &[1u8; 32]).unwrap();
        let s2 = s1.add(&mp, &b, &[2u8; 32]).unwrap();
        let s3 = s2.remove(&a, &[3u8; 32]);
        assert_eq!((s3.epoch, s3.friends.len(), s3.keys.len()), (3, 1, 3));
        let ev = crate::shopkey::sign_with(&me, 30078, json!([["d", CIRCLE_KEYS_D]]), &bundle_content(&me, &s3).unwrap(), 50).unwrap();
        let (open, at) = open_my_circle(&[ev.clone()], &me).unwrap();
        assert_eq!((open, at), (s3.clone(), 50));
        assert!(open_friend_slot(&ev, &sk(8)).is_none(), "뺀 친구는 새 칸이 없다");
        let bk = open_friend_slot(&ev, &sk(9)).unwrap();
        assert_eq!(bk.len(), 2, "넣은 세대(2)부터만: {bk:?}");
        assert!(CircleState::default().add(&mp, &mp, &[1u8; 32]).is_err());
        assert!(circle_is_stale((2, 100), Some((3, 50))) && circle_is_stale((3, 40), Some((3, 50))) && !circle_is_stale((3, 50), Some((3, 50))));
        assert_eq!((bundle_time(100, 50), bundle_time(10, 50)), (101, 50));
    }

    /// 11-23 우체국 F: 칸 수는 10 단위(0~10명 10칸 · 11~20 20칸 · 21~30 30칸) · 빈 칸은 아무도 못 열고, 진짜 칸과 길이가 같다 · 30명도 32KB 안.
    #[test]
    fn 꾸러미_칸을_10칸_단위로_채운다() {
        assert_eq!([0, 1, 10, 11, 20, 21, 30].map(padded_slot_count), [10, 10, 10, 20, 20, 30, 30]);
        let me = sk(7);
        let mp = crate::shopkey::pubkey_of(&me).unwrap();
        let slots_of = |st: &CircleState| -> Vec<String> {
            let c: Value = serde_json::from_str(&bundle_content(&me, st).unwrap()).unwrap();
            c["slots"].as_array().unwrap().iter().map(|x| x.as_str().unwrap().to_string()).collect()
        };
        assert_eq!(slots_of(&CircleState::default()).len(), 10, "친구가 없어도 10칸");
        let mut st = CircleState::default();
        for i in 0..11u8 { st = st.add(&mp, &crate::shopkey::pubkey_of(&sk(20 + i)).unwrap(), &[i + 1; 32]).unwrap(); }
        let s = slots_of(&st);
        assert_eq!(s.len(), 20);
        // 진짜 칸은 열쇠 1~3개라 길이가 셋뿐 — 빈 칸이 다른 길이를 만들지 않는다.
        let lens: std::collections::HashSet<usize> = s.iter().map(String::len).collect();
        assert!(lens.len() <= SLOT_EPOCHS, "빈 칸이 다른 길이를 만든다: {lens:?}");
        let one = CircleState::default().add(&mp, &crate::shopkey::pubkey_of(&sk(8)).unwrap(), &[1u8; 32]).unwrap();
        let l1: std::collections::HashSet<usize> = slots_of(&one).iter().map(String::len).collect();
        assert_eq!(l1.len(), 1, "친구 1명: 빈 칸 9개가 진짜 칸과 길이가 다르다: {l1:?}");
        let ev = crate::shopkey::sign_with(&me, 30078, json!([["d", CIRCLE_KEYS_D]]), &bundle_content(&me, &st).unwrap(), 50).unwrap();
        assert!(open_friend_slot(&ev, &sk(25)).is_some(), "진짜 친구는 연다");
        assert!(open_friend_slot(&ev, &sk(99)).is_none(), "남은 빈 칸도 못 연다");
        assert_eq!(open_my_circle(&[ev], &me).unwrap().0, st);
        for i in 11..30u8 { st = st.add(&mp, &crate::shopkey::pubkey_of(&sk(20 + i)).unwrap(), &[i + 1; 32]).unwrap(); }
        assert_eq!(slots_of(&st).len(), 30);
        let ev = crate::shopkey::sign_with(&me, 30078, json!([["d", CIRCLE_KEYS_D]]), &bundle_content(&me, &st).unwrap(), 50).unwrap();
        assert!(serde_json::to_vec(&ev).unwrap().len() < crate::relay::MAX_EVENT_BYTES, "30명 꾸러미가 32KB 를 넘는다");
    }

    #[test]
    fn 암호_사진_잠그고_푼다() {
        let plain = b"\xff\xd8\xff-fixture".to_vec();
        let (cipher, f) = seal_photo(&plain, "image/jpeg").unwrap();
        assert_eq!(open_photo(&cipher, &f).unwrap(), plain);
        let mut bad = cipher.clone();
        bad[0] ^= 1;
        assert!(open_photo(&bad, &f).is_none());
    }

    /// 폰 코드(tsx)로 만든 꾸러미·「나만」·「친구만」 글을 데스크탑이 연다 — 고정 값(scripts 아님, 11-23 생성).
    #[test]
    fn 폰이_만든_꾸러미와_글을_연다() {
        let v: Value = serde_json::from_str(include_str!("../tests/fixtures/phone-private.json")).unwrap();
        let me = sk(7);
        let friend = sk(8);
        let bundle = &v["bundle"];
        // 11-23 폰 34c574d: 친구 1명이어도 10칸(빈 칸 9).
        let slots: Value = serde_json::from_str(bundle["content"].as_str().unwrap()).unwrap();
        assert_eq!(slots["slots"].as_array().unwrap().len(), 10, "폰 꾸러미가 10칸이 아니다");
        let (st, _) = open_my_circle(std::slice::from_ref(bundle), &me).unwrap();
        assert_eq!(st.epoch, v["epoch"].as_i64().unwrap());
        let fk = open_friend_slot(bundle, &friend).expect("친구 칸");
        let selfn = open_private_note(&v["self_note"], &me, &|_| None).unwrap();
        assert_eq!(selfn.text, v["self_text"].as_str().unwrap());
        let author = bundle["pubkey"].as_str().unwrap().to_string();
        let fr = open_private_note(&v["friends_note"], &friend, &|a| (a == author).then(|| fk.clone())).unwrap();
        assert_eq!(fr.text, v["friends_text"].as_str().unwrap());
        assert_eq!(fr.photos.len(), 1);
    }

    /// 데스크탑이 만든 것을 폰이 열 수 있게 고정 값을 낸다: `RV_EMIT_DESK_PRIVATE=<파일> cargo test --lib emit_desk_private -- --ignored`
    #[test]
    #[ignore]
    fn emit_desk_private() {
        let me = sk(7);
        let mp = crate::shopkey::pubkey_of(&me).unwrap();
        let fp = crate::shopkey::pubkey_of(&sk(8)).unwrap();
        let st = CircleState::default().add(&mp, &fp, &[4u8; 32]).unwrap();
        let bundle = crate::shopkey::sign_with(&me, 30078, json!([["d", CIRCLE_KEYS_D]]), &bundle_content(&me, &st).unwrap(), 2000).unwrap();
        let (ep, key) = st.current().unwrap();
        let self_note = crate::shopkey::sign_with(&me, KIND_PRIVATE_NOTE, json!([]), &self_note_content(&me, "데스크탑 나만", &[]).unwrap(), 2000).unwrap();
        let friends_note = crate::shopkey::sign_with(&me, KIND_PRIVATE_NOTE, json!([]), &friends_note_content(ep, &key, "데스크탑 친구만", &[]).unwrap(), 2000).unwrap();
        let out = json!({ "bundle": bundle, "self_note": self_note, "friends_note": friends_note, "epoch": ep });
        std::fs::write(std::env::var("RV_EMIT_DESK_PRIVATE").unwrap(), out.to_string()).unwrap();
    }
}
