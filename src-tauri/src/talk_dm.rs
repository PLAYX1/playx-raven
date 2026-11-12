//! 쪽지(NIP-17 1:1·단톡) — **이 창 안에서 카톡처럼.**
//!
//! 11-12 대표: 「레이븐볼트 켜 놓고 메신저로도 쓰게 — 메신저·피드 둘 다」. 예전 「쪽지」 단추는 인터넷 창에
//! 옛 지갑 화면을 열었다(쪽지 열쇠가 그 화면의 12단어에만 있다고 봤다). 그런데 이 앱의 이야기 열쇠(talkkey.json)는
//! 이미 12단어의 **사람 경로** `m/44'/175'/7'/0/0` 에서 나오고, 폰(core/talk/key.ts)·웹 지갑도 같은 자리다 —
//! 같은 12단어면 **같은 사람**이고 같은 쪽지를 연다.
//!
//! ## 🔴 열쇠는 러스트 밖으로 안 나간다
//! - 봉하기·풀기·서명은 전부 여기서 한다. 화면(webview)은 **내 대화의 글자**만 받는다. 12단어·비밀 열쇠는 안 받는다.
//! - 푼 글은 **메모리에만** 둔다(디스크에 평문으로 쓰지 않는다). 봉한 겉봉은 이 컴퓨터 릴레이가 이미 보관한다
//!   (쪽지 보관, relay.rs owner_wrap) — 다음에 켜면 그 겉봉을 다시 풀어 곧바로 그린다(먼저 그리기).
//!
//! ## 폰과 같은 바이트(core/talk/nip17.ts)
//! - 속지 kind 14(글)·15(암호 사진) · 봉인 13(내 열쇠로 서명) · 겉봉 1059(한 번 쓰는 열쇠) · 시각은 최대 이틀 앞당김.
//! - 속지 표: 받는 사람마다 `p` · 단톡이면 `subject` · 라비 이모티콘이면 `emoji`(NIP-30).
//! - 겉봉은 받는 사람마다 한 장 + **내 사본 한 장**(같은 속지·같은 시각).
//! - 단톡 = 보낸 이 + p 표 집합(셋 이상) · 최대 30명 · 방 열쇠 `g:` + sha256(정렬한 멤버를 쉼표로 이음) 앞 32자.
//! - 받을 때 검사: 겉봉·봉인 서명, 속지 보낸 이 = 봉인 서명자(사칭 막기), 속지 번호 다시 계산, p 표 60개 이하·모양,
//!   나에게 온 것이거나 내가 보낸 사본.

use serde::Serialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::sync::Mutex;

pub(crate) const KIND_DM: i64 = 14;
pub(crate) const KIND_FILE: i64 = 15;
const KIND_SEAL: i64 = 13;
const KIND_WRAP: i64 = 1059;
/// 단톡 최대 인원(나 포함) — 폰 MAX_GROUP_MEMBERS.
pub(crate) const MAX_GROUP_MEMBERS: usize = 30;
const MAX_P_TAGS: usize = 60;
/// 한 번에 보내는 글 길이. 겉봉은 32KB 를 넘으면 릴레이가 안 받는다(한국어 3바이트·base64 두 번).
const MAX_TEXT_CHARS: usize = 4000;
/// 이틀(NIP-59 시각 흐림) + 여유.
const FUZZ_SECS: i64 = 2 * 86_400 + 600;
const EMOJI_BASE: &str = "https://ravenvault.ex.erci.se/emoji/";
const RAVI_STICKERS: [&str; 16] = [
    "ravi_hello", "ravi_thanks", "ravi_like", "ravi_love", "ravi_congrats", "ravi_laugh", "ravi_sad", "ravi_angry",
    "ravi_surprised", "ravi_curious", "ravi_cheer", "ravi_sorry", "ravi_goodnight", "ravi_gift", "ravi_waiting", "ravi_ok",
];

fn hex64(s: &str) -> bool {
    s.len() == 64 && s.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
fn now() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0)
}
fn fuzzy(now: i64) -> i64 {
    use rand::Rng;
    now - rand::rngs::OsRng.gen_range(0..172_800)
}
fn event_id(pubkey: &str, created_at: i64, kind: i64, tags: &Value, content: &str) -> String {
    hex::encode(Sha256::digest(serde_json::to_string(&json!([0, pubkey, created_at, kind, tags, content])).unwrap_or_default().as_bytes()))
}

/// 푼 쪽지 하나. `members` 는 단톡(셋 이상)일 때만 · `photo` = 암호 사진(kind 15, 이 창은 아직 안 그린다).
#[derive(Debug, Clone, Serialize, PartialEq)]
pub(crate) struct Dm {
    pub id: String,
    pub from: String,
    pub to: String,
    pub at: i64,
    pub text: String,
    pub wrap: String,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub members: Vec<String>,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub subject: String,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub photo: bool,
}

/// 단톡 대화 열쇠(폰 groupKey): 「g:」 + sha256(정렬·중복 없는 멤버를 쉼표로) 앞 32자.
pub(crate) fn group_key(members: &[String]) -> String {
    let mut m: Vec<&str> = members.iter().map(String::as_str).collect();
    m.sort_unstable();
    m.dedup();
    format!("g:{}", &hex::encode(Sha256::digest(m.join(",").as_bytes()))[..32])
}

/// 이 쪽지가 속한 대화 열쇠: 단톡이면 group_key, 1:1 이면 상대 공개키(나에게 쓴 것이면 나).
pub(crate) fn chat_key_of(m: &Dm, me: &str) -> String {
    if m.members.len() > 2 {
        return group_key(&m.members);
    }
    if m.from == me { m.to.clone() } else { m.from.clone() }
}

fn tag_value<'a>(tags: &'a [Value], name: &str) -> &'a str {
    tags.iter()
        .find(|t| t.get(0).and_then(Value::as_str) == Some(name) && t.get(1).and_then(Value::as_str).is_some())
        .and_then(|t| t.get(1).and_then(Value::as_str))
        .unwrap_or("")
}

/// kind 15 속지의 모양 검사(폰 fileOf 와 같은 조건 · 그리지는 않으므로 맞는지만 본다).
fn file_ok(content: &str, tags: &[Value]) -> bool {
    let url = content.trim();
    let mime = tag_value(tags, "file-type");
    let hexn = |s: &str, n: usize| s.len() == n && s.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b));
    tag_value(tags, "encryption-algorithm") == "aes-gcm"
        && url.starts_with("https://") && url.len() <= 508 && !url.chars().any(char::is_whitespace)
        && ["image/jpeg", "image/png", "image/webp", "image/gif"].contains(&mime)
        && hexn(tag_value(tags, "decryption-key"), 64)
        && hexn(tag_value(tags, "decryption-nonce"), 24)
        && hexn(tag_value(tags, "x"), 64)
}

/// 겉봉 → 쪽지(폰 nip17.unwrap 과 같은 검사). 못 열거나(남의 것) 서명·보낸 이가 안 맞으면 None — 오류가 아니다.
pub(crate) fn open_wrap(my: &[u8; 32], gift: &Value) -> Option<Dm> {
    use crate::wallet_link::{conv_key, nip44_decrypt};
    if gift.get("kind")?.as_i64()? != KIND_WRAP || !crate::relay::verify(gift) {
        return None;
    }
    let seal: Value = serde_json::from_str(&nip44_decrypt(gift.get("content")?.as_str()?, &conv_key(my, gift.get("pubkey")?.as_str()?)?)?).ok()?;
    if seal.get("kind")?.as_i64()? != KIND_SEAL || !hex64(seal.get("pubkey")?.as_str()?) || !crate::relay::verify(&seal) {
        return None;
    }
    let from = seal.get("pubkey")?.as_str()?.to_string();
    let rumor: Value = serde_json::from_str(&nip44_decrypt(seal.get("content")?.as_str()?, &conv_key(my, &from)?)?).ok()?;
    let kind = rumor.get("kind")?.as_i64()?;
    if kind != KIND_DM && kind != KIND_FILE {
        return None;
    }
    let content = rumor.get("content")?.as_str()?;
    let tags_v = rumor.get("tags")?;
    let tags = tags_v.as_array()?;
    // 🔴 속지의 「보낸 이」는 서명이 없다. 봉인의 서명자와 같아야만 믿는다(사칭 막기).
    if rumor.get("pubkey")?.as_str()? != from {
        return None;
    }
    let at = rumor.get("created_at")?.as_i64().filter(|t| (0..=9_007_199_254_740_991).contains(t))?;
    let ps: Vec<&Value> = tags.iter().filter(|t| t.get(0).and_then(Value::as_str) == Some("p")).collect();
    if ps.len() > MAX_P_TAGS {
        return None;
    }
    let mut pk: Vec<String> = Vec::with_capacity(ps.len());
    for t in ps {
        let p = t.get(1).and_then(Value::as_str).filter(|p| hex64(p))?;
        pk.push(p.to_string());
    }
    let to = pk.first()?.clone();
    if rumor.get("id")?.as_str()? != event_id(&from, at, kind, tags_v, content) {
        return None;
    }
    let me = crate::shopkey::pubkey_of(my).ok()?;
    if !pk.contains(&me) && from != me {
        return None;
    }
    let mut members: Vec<String> = std::iter::once(from.clone()).chain(pk).collect();
    members.sort_unstable();
    members.dedup();
    let photo = kind == KIND_FILE;
    if photo && !file_ok(content, tags) {
        return None;
    }
    Some(Dm {
        id: rumor.get("id")?.as_str()?.to_string(),
        from,
        to,
        at,
        text: if photo { String::new() } else { content.chars().take(8000).collect() },
        wrap: gift.get("id")?.as_str()?.to_string(),
        members: if members.len() > 2 { members } else { vec![] },
        subject: tag_value(tags, "subject").trim().chars().take(60).collect(),
        photo,
    })
}

/// 글 속 라비 짧은 이름마다 emoji 표 하나(폰 stickerTags 와 같다 — 같은 것은 한 번, 모르는 이름은 표 없음).
pub(crate) fn sticker_tags(text: &str) -> Vec<Value> {
    let mut out = Vec::new();
    let mut seen: Vec<&str> = Vec::new();
    let b = text.as_bytes();
    let mut i = 0;
    while i < b.len() {
        if b[i] == b':' {
            let mut j = i + 1;
            while j < b.len() && j - i <= 41 && (b[j].is_ascii_alphanumeric() || b[j] == b'_') {
                j += 1;
            }
            if j < b.len() && b[j] == b':' && j > i + 1 && j - i - 1 <= 40 {
                let code = &text[i + 1..j];
                if RAVI_STICKERS.contains(&code) && !seen.contains(&code) {
                    seen.push(code);
                    out.push(json!(["emoji", code, format!("{EMOJI_BASE}{code}.webp")]));
                }
                // 정규식 /g 처럼 닫는 콜론 다음부터 다시 찾는다.
                i = j + 1;
                continue;
            }
        }
        i += 1;
    }
    out
}

/// 속지(서명 없음, 폰 rumorOf).
fn rumor_of(me: &str, receivers: &[String], text: &str, subject: &str, at: i64) -> Value {
    let mut tags: Vec<Value> = receivers.iter().map(|p| json!(["p", p])).collect();
    let subject: String = subject.trim().chars().take(60).collect();
    if !subject.is_empty() {
        tags.push(json!(["subject", subject]));
    }
    tags.extend(sticker_tags(text));
    let tags = Value::Array(tags);
    let id = event_id(me, at, KIND_DM, &tags, text);
    json!({ "pubkey": me, "created_at": at, "kind": KIND_DM, "content": text, "tags": tags, "id": id })
}

/// 이미 만든 속지를 한 사람(for_whom)이 열 겉봉 하나로 싼다(폰 sealAndWrap).
fn seal_and_wrap(my: &[u8; 32], rumor: &Value, for_whom: &str, at: i64) -> Result<Value, String> {
    use crate::wallet_link::{conv_key, nip44_encrypt, random32};
    let ck = conv_key(my, for_whom).ok_or("받는 사람 열쇠가 올바르지 않습니다.")?;
    let sealed = nip44_encrypt(&rumor.to_string(), &ck, random32()).ok_or("쪽지가 너무 길어 봉하지 못했습니다.")?;
    let seal = crate::shopkey::sign_with(my, KIND_SEAL, json!([]), &sealed, fuzzy(at))?;
    let mut once = random32();
    while secp256k1::SecretKey::from_byte_array(&once).is_err() {
        once = random32();
    }
    let out = (|| {
        let ck2 = conv_key(&once, for_whom).ok_or("봉하지 못했습니다.")?;
        let content = nip44_encrypt(&seal.to_string(), &ck2, random32()).ok_or("쪽지가 너무 길어 봉하지 못했습니다.")?;
        crate::shopkey::sign_with(&once, KIND_WRAP, json!([["p", for_whom]]), &content, fuzzy(at))
    })();
    crate::words::wipe_bytes(&mut once);
    out
}

/// 1:1 또는 단톡 겉봉들(폰 wrapChat): 받는 사람마다 한 장 + 마지막에 내 사본 한 장(같은 속지·같은 시각).
/// 돌려줌 (겉봉들, 속지). 겉봉 순서 = 받는 사람 순서, 마지막이 내 것.
pub(crate) fn wrap_chat(my: &[u8; 32], receivers: &[String], text: &str, subject: &str, at: i64) -> Result<(Vec<(String, Value)>, Value), String> {
    let me = crate::shopkey::pubkey_of(my)?;
    let mut others: Vec<String> = Vec::new();
    for p in receivers {
        if !hex64(p) {
            return Err("받는 사람을 확인해 주세요.".into());
        }
        if *p != me && !others.contains(p) {
            others.push(p.clone());
        }
    }
    if others.len() + 1 > MAX_GROUP_MEMBERS {
        return Err("단톡은 30명까지예요.".into());
    }
    if others.is_empty() {
        let rumor = rumor_of(&me, std::slice::from_ref(&me), text, subject, at);
        let w = seal_and_wrap(my, &rumor, &me, at)?;
        return Ok((vec![(me, w)], rumor));
    }
    let rumor = rumor_of(&me, &others, text, subject, at);
    let mut out = Vec::with_capacity(others.len() + 1);
    for p in &others {
        out.push((p.clone(), seal_and_wrap(my, &rumor, p, at)?));
    }
    out.push((me.clone(), seal_and_wrap(my, &rumor, &me, at)?));
    Ok((out, rumor))
}

// ── 푼 쪽지 기억(메모리만) ────────────────────────────────────────────

#[derive(Default)]
struct Book {
    me: String,
    /// 겉봉 번호 → 푼 속지 번호(못 연 겉봉은 None — 다시 풀지 않는다).
    tried: HashMap<String, Option<String>>,
    msgs: HashMap<String, Dm>,
    /// 마지막으로 바깥을 끝까지 읽기 시작한 시각(다음엔 그 이틀 전부터만 묻는다).
    remote_at: i64,
}
static BOOK: Mutex<Option<Book>> = Mutex::new(None);
const MAX_TRIED: usize = 20_000;

fn with_book<T>(me: &str, f: impl FnOnce(&mut Book) -> T) -> T {
    let mut g = BOOK.lock().unwrap_or_else(|e| e.into_inner());
    if g.as_ref().map(|b| b.me != me).unwrap_or(true) {
        *g = Some(Book { me: me.to_string(), ..Default::default() });
    }
    f(g.as_mut().expect("book"))
}

/// 처음 보는 겉봉만 푼다. 돌려줌: 새로 생긴 쪽지들.
fn ingest(my: &[u8; 32], me: &str, wraps: &[Value]) -> Vec<Dm> {
    let fresh: Vec<&Value> = with_book(me, |b| {
        wraps
            .iter()
            .filter(|w| w.get("id").and_then(Value::as_str).is_some_and(|id| !b.tried.contains_key(id)))
            .collect()
    });
    if fresh.is_empty() {
        return vec![];
    }
    let opened: Vec<(String, Option<Dm>)> = fresh
        .into_iter()
        .map(|w| (w.get("id").and_then(Value::as_str).unwrap_or_default().to_string(), open_wrap(my, w)))
        .collect();
    with_book(me, |b| {
        if b.tried.len() > MAX_TRIED {
            b.tried.retain(|_, v| v.is_some());
        }
        let mut added = Vec::new();
        for (wid, m) in opened {
            b.tried.insert(wid, m.as_ref().map(|m| m.id.clone()));
            if let Some(m) = m {
                if !b.msgs.contains_key(&m.id) {
                    b.msgs.insert(m.id.clone(), m.clone());
                    added.push(m);
                }
            }
        }
        added
    })
}

/// 보낸 쪽지를 곧바로 기억한다(바깥 답을 기다리지 않고 그린다).
fn remember_sent(me: &str, m: Dm) {
    with_book(me, |b| {
        b.tried.insert(m.wrap.clone(), Some(m.id.clone()));
        b.msgs.entry(m.id.clone()).or_insert(m);
    });
}

fn all_msgs(me: &str) -> Vec<Dm> {
    with_book(me, |b| b.msgs.values().cloned().collect())
}

/// 이 컴퓨터 릴레이에 보관된 나에게 온 겉봉(웹소켓 안 거침 · 몇 ms).
fn local_wraps(me: &str) -> Vec<Value> {
    crate::relay::query_local(&[json!({ "kinds": [KIND_WRAP], "#p": [me], "limit": 500 })])
}

/// 바깥(기본 릴레이 + 이 컴퓨터)에서 새 겉봉을 읽어 이 컴퓨터 릴레이에 남기고 푼다. 닿은 곳이 없으면 Err.
async fn fetch_remote(my: &[u8; 32], me: &str) -> Result<usize, String> {
    let started = now();
    let since = with_book(me, |b| if b.remote_at > 0 { b.remote_at - FUZZ_SECS } else { 0 });
    let (wraps, complete) = crate::nostrpub::nostr_query_inbox(me, since).await?;
    crate::relay::absorb(wraps.clone());
    let sk = *my;
    let me2 = me.to_string();
    let added = tokio::task::spawn_blocking(move || ingest(&sk, &me2, &wraps).len()).await.unwrap_or(0);
    if complete {
        with_book(me, |b| b.remote_at = started);
    }
    Ok(added)
}

async fn load(my: &[u8; 32], me: &str, local: bool) -> (bool, Option<String>) {
    let empty = with_book(me, |b| b.tried.is_empty());
    if empty || local {
        let sk = *my;
        let me2 = me.to_string();
        let _ = tokio::task::spawn_blocking(move || ingest(&sk, &me2, &local_wraps(&me2))).await;
    }
    if local {
        return (true, None);
    }
    match fetch_remote(my, me).await {
        Ok(_) => (true, None),
        Err(e) => (false, Some(e)),
    }
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub(crate) struct Thread {
    pub key: String,
    /// "dm" | "group"
    pub kind: &'static str,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub with: String,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub members: Vec<String>,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub subject: String,
    pub last: Dm,
    pub count: usize,
    pub unread: usize,
}

/// 쪽지 → 대화 목록(폰 conversationsFrom + chatRows 의 쪽지 부분). 최근 대화가 앞.
/// 안 읽은 수 = 읽음 시각(read[key]) 이후에 **남이** 쓴 글 수. muted = 안 보기 한 사람(1:1 은 통째로 뺀다).
pub(crate) fn threads_from(msgs: &[Dm], me: &str, read: &HashMap<String, i64>, muted: &[String]) -> Vec<Thread> {
    let mut by: HashMap<String, Vec<&Dm>> = HashMap::new();
    for m in msgs {
        by.entry(chat_key_of(m, me)).or_default().push(m);
    }
    let mut out: Vec<Thread> = by
        .into_iter()
        .filter_map(|(key, mut list)| {
            list.sort_by(|a, b| a.at.cmp(&b.at).then(a.id.cmp(&b.id)));
            let last = (*list.last()?).clone();
            let group = list.iter().any(|m| m.members.len() > 2);
            if !group && muted.contains(&key) {
                return None;
            }
            let seen = read.get(&key).copied().unwrap_or(0);
            let unread = list.iter().filter(|m| m.from != me && !muted.contains(&m.from) && m.at > seen).count();
            let members = if group { list.iter().rev().find(|m| m.members.len() > 2).map(|m| m.members.clone()).unwrap_or_default() } else { vec![] };
            let subject = if group { list.iter().rev().find(|m| !m.subject.is_empty()).map(|m| m.subject.clone()).unwrap_or_default() } else { String::new() };
            Some(Thread {
                with: if group { String::new() } else { key.clone() },
                kind: if group { "group" } else { "dm" },
                key,
                members,
                subject,
                count: list.len(),
                unread,
                last,
            })
        })
        .collect();
    out.sort_by(|a, b| b.last.at.cmp(&a.last.at).then(a.key.cmp(&b.key)));
    out
}

fn identity_view(me: &str) -> Value {
    let path = crate::talk::key_on_disk().map(|(_, _, p)| p).unwrap_or_default();
    json!({
        "me": me,
        "npub": crate::talk_social::npub_of(me).unwrap_or_default(),
        // 폰·웹 지갑과 같은 이름인가(같은 12단어일 때) — 아니면 화면이 그렇게 말한다.
        "same_as_wallet": path == crate::identity::PATH_PERSON,
    })
}

/// 방마다 마지막 글(이 컴퓨터 릴레이 저장분 · 몇 ms) — 채팅 목록에 방을 섞어 시각순으로 놓으려고.
fn rooms_last(rooms: &[String]) -> Value {
    let mut out = serde_json::Map::new();
    for r in rooms.iter().filter(|r| hex64(r)).take(60) {
        let got = crate::relay::query_local(&[json!({ "kinds": [crate::talk::TALK_KIND_ROOM_MSG], "#e": [r], "limit": 1 })]);
        if let Some(e) = got.into_iter().next() {
            out.insert(
                r.clone(),
                json!({
                    "at": e.get("created_at").and_then(Value::as_i64).unwrap_or(0),
                    "from": e.get("pubkey").and_then(Value::as_str).unwrap_or(""),
                    "text": e.get("content").and_then(Value::as_str).unwrap_or("").chars().take(120).collect::<String>(),
                }),
            );
        }
    }
    Value::Object(out)
}

/// 채팅 목록 한 판. `local: true` 면 이 컴퓨터 저장분만(몇 ms) · 아니면 바깥 새 겉봉까지.
/// 돌려줌 `{ me, npub, same_as_wallet, threads, rooms_last, reached, why? }` — 글자만, 열쇠는 없다.
#[tauri::command]
pub async fn talk_dm_threads(
    local: Option<bool>,
    read: Option<HashMap<String, i64>>,
    muted: Option<Vec<String>>,
    rooms: Option<Vec<String>>,
    quiet: Option<bool>,
) -> Result<Value, String> {
    // 뒤에서 살피기(앱 시작 때부터)는 열쇠를 **만들지 않는다** — 묻는 것만으로 이름이 태어나지 않게(talk::key_on_disk).
    if quiet == Some(true) && crate::talk::key_on_disk().is_none() {
        return Ok(json!({ "none": true, "threads": [], "rooms_last": {} }));
    }
    let mut sk = crate::talk::signing_key()?;
    let me = crate::shopkey::pubkey_of(&sk)?;
    let (reached, why) = load(&sk, &me, local == Some(true)).await;
    crate::words::wipe_bytes(&mut sk);
    let msgs = all_msgs(&me);
    let threads = threads_from(&msgs, &me, &read.unwrap_or_default(), &muted.unwrap_or_default());
    let mut v = identity_view(&me);
    v["threads"] = json!(threads);
    v["rooms_last"] = rooms_last(&rooms.unwrap_or_default());
    v["reached"] = json!(reached);
    if let Some(w) = why {
        v["why"] = json!(w);
    }
    Ok(v)
}

/// 한 대화의 글(오래된 것이 앞, 최근 300개). key = 상대 공개키 또는 「g:…」.
#[tauri::command]
pub async fn talk_dm_read(key: String, local: Option<bool>) -> Result<Value, String> {
    let key = key.trim().to_ascii_lowercase();
    if !(hex64(&key) || (key.len() == 34 && key.starts_with("g:") && key[2..].bytes().all(|b| b.is_ascii_hexdigit()))) {
        return Err("대화를 찾지 못했습니다.".into());
    }
    let mut sk = crate::talk::signing_key()?;
    let me = crate::shopkey::pubkey_of(&sk)?;
    let (reached, why) = load(&sk, &me, local == Some(true)).await;
    crate::words::wipe_bytes(&mut sk);
    let mut list: Vec<Dm> = all_msgs(&me).into_iter().filter(|m| chat_key_of(m, &me) == key).collect();
    list.sort_by(|a, b| a.at.cmp(&b.at).then(a.id.cmp(&b.id)));
    let skip = list.len().saturating_sub(300);
    let list: Vec<Dm> = list.into_iter().skip(skip).collect();
    let mut v = identity_view(&me);
    v["messages"] = json!(list);
    v["reached"] = json!(reached);
    if let Some(w) = why {
        v["why"] = json!(w);
    }
    Ok(v)
}

/// npub1… 또는 64자 16진수 → 공개키.
pub(crate) fn clean_pub(s: &str) -> Option<String> {
    let s = s.trim().trim_start_matches("nostr:");
    if hex64(&s.to_ascii_lowercase()) {
        return Some(s.to_ascii_lowercase());
    }
    match crate::talk_social::decode_nip19(s)? {
        crate::talk_social::Nip19::Person(h) => Some(h),
        _ => None,
    }
}

/// 붙여 넣은 아이디들(npub1… · 16진수) → 공개키. 하나라도 틀리면 그것을 알려 준다(조용히 빼지 않는다).
#[tauri::command]
pub fn talk_dm_peers(ids: Vec<String>) -> Result<Vec<String>, String> {
    if ids.len() > MAX_GROUP_MEMBERS {
        return Err("단톡은 30명까지예요.".into());
    }
    ids.iter()
        .map(|s| clean_pub(s).ok_or_else(|| format!("이야기 아이디가 아닙니다: {}", s.chars().take(24).collect::<String>())))
        .collect()
}

/// 단톡 대화 열쇠(폰 groupKey) — 화면이 새 단톡을 열 때 같은 열쇠로 찾게.
#[tauri::command]
pub fn talk_dm_group_key(members: Vec<String>) -> Result<String, String> {
    if members.iter().any(|m| !hex64(m)) || members.len() > MAX_GROUP_MEMBERS {
        return Err("단톡 사람을 확인해 주세요.".into());
    }
    Ok(group_key(&members))
}

/// 쪽지 보내기. `to` = 받는 사람들(나 빼고 · 1명이면 1:1, 둘 이상이면 단톡) · `subject` = 단톡 이름.
/// 받는 사람마다 겉봉 하나 + 내 사본 하나를 **한꺼번에** 올린다. 내 사본은 이 컴퓨터 릴레이에도 곧바로 둔다.
/// 돌려줌 `{ message, delivered, total, failed }` — 한 사람에게도 못 갔으면 Err.
#[tauri::command]
pub async fn talk_dm_send(to: Vec<String>, text: String, subject: Option<String>) -> Result<Value, String> {
    let text = text.trim().to_string();
    if text.is_empty() {
        return Err("보낼 말을 적어 주세요.".into());
    }
    if text.chars().count() > MAX_TEXT_CHARS {
        return Err(format!("쪽지가 너무 깁니다. {MAX_TEXT_CHARS}자 아래로 나눠 보내 주세요."));
    }
    let mut receivers = Vec::new();
    for p in &to {
        receivers.push(clean_pub(p).ok_or("받는 사람 이야기 아이디를 확인해 주세요.")?);
    }
    if receivers.is_empty() {
        return Err("받는 사람을 골라 주세요.".into());
    }
    let mut sk = crate::talk::signing_key()?;
    let me = crate::shopkey::pubkey_of(&sk)?;
    let made = wrap_chat(&sk, &receivers, &text, subject.as_deref().unwrap_or(""), now());
    crate::words::wipe_bytes(&mut sk);
    let (wraps, rumor) = made?;
    let mine = wraps.last().map(|(_, w)| w.clone());
    // 🔴 내 사본을 **먼저** 이 컴퓨터 릴레이에 둔다 — 다음에 켜도 내가 보낸 말이 보인다.
    if let Some(w) = &mine {
        crate::relay::absorb(vec![w.clone()]);
    }
    let runs = wraps.iter().map(|(who, w)| {
        let w = w.clone();
        let who = who.clone();
        async move { (who, crate::nostrpub::nostr_publish(w).await) }
    });
    let results = futures_util::future::join_all(runs).await;
    let others: Vec<&(String, Result<Value, String>)> = results.iter().filter(|(who, _)| *who != me).collect();
    let total = others.len();
    let delivered = others.iter().filter(|(_, r)| r.is_ok()).count();
    let failed: Vec<&str> = others.iter().filter(|(_, r)| r.is_err()).map(|(w, _)| w.as_str()).collect();
    if total > 0 && delivered == 0 {
        let why = others.iter().find_map(|(_, r)| r.as_ref().err().cloned()).unwrap_or_default();
        return Err(format!("쪽지를 보내지 못했습니다. {why}"));
    }
    if total == 0 && results.iter().all(|(_, r)| r.is_err()) {
        return Err("쪽지를 올리지 못했습니다. 인터넷을 확인해 주세요.".into());
    }
    let tags = rumor.get("tags").and_then(Value::as_array).cloned().unwrap_or_default();
    let mut members: Vec<String> = std::iter::once(me.clone())
        .chain(tags.iter().filter(|t| t.get(0).and_then(Value::as_str) == Some("p")).filter_map(|t| t.get(1).and_then(Value::as_str).map(str::to_string)))
        .collect();
    members.sort_unstable();
    members.dedup();
    let m = Dm {
        id: rumor["id"].as_str().unwrap_or_default().to_string(),
        from: me.clone(),
        to: tags.iter().find(|t| t.get(0).and_then(Value::as_str) == Some("p")).and_then(|t| t.get(1).and_then(Value::as_str)).unwrap_or_default().to_string(),
        at: rumor["created_at"].as_i64().unwrap_or(0),
        text: text.clone(),
        wrap: mine.as_ref().and_then(|w| w.get("id").and_then(Value::as_str)).unwrap_or_default().to_string(),
        members: if members.len() > 2 { members } else { vec![] },
        subject: tag_value(&tags, "subject").to_string(),
        photo: false,
    };
    remember_sent(&me, m.clone());
    Ok(json!({ "message": m, "key": chat_key_of(&m, &me), "delivered": delivered, "total": total, "failed": failed }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn vectors() -> Value {
        serde_json::from_str(include_str!("../../scripts/fixtures/talk-dm-vectors.json")).unwrap()
    }
    fn key(h: &str) -> [u8; 32] {
        hex::decode(h).unwrap().try_into().unwrap()
    }
    fn sk(n: u8) -> [u8; 32] {
        let mut b = [7u8; 32];
        b[31] = n;
        b
    }
    fn pubk(n: u8) -> String {
        crate::shopkey::pubkey_of(&sk(n)).unwrap()
    }

    #[test]
    fn 폰이_봉한_1대1_쪽지를_연다() {
        let v = vectors();
        let bob = key(v["bobSecret"].as_str().unwrap());
        for c in v["direct"].as_array().unwrap() {
            let m = open_wrap(&bob, &c["wrap"]).expect("phone wrap opens");
            assert_eq!(m.from, v["alice"].as_str().unwrap());
            assert_eq!(m.to, v["bob"].as_str().unwrap());
            assert_eq!(m.text, c["text"].as_str().unwrap());
            assert_eq!(m.id, c["rumorId"].as_str().unwrap());
            assert!(m.members.is_empty() && m.subject.is_empty());
            assert_eq!(chat_key_of(&m, v["bob"].as_str().unwrap()), v["alice"].as_str().unwrap());
            // 남(carol)은 못 연다.
            assert!(open_wrap(&key(v["carolSecret"].as_str().unwrap()), &c["wrap"]).is_none());
        }
        // 폰이 만든 내 사본(alice 가 연다) — 보낸 사람 화면에도 같은 대화(상대 = bob).
        let mine = open_wrap(&key(v["aliceSecret"].as_str().unwrap()), &v["directSelfCopy"]).expect("self copy opens");
        assert_eq!(chat_key_of(&mine, v["alice"].as_str().unwrap()), v["bob"].as_str().unwrap());
    }

    #[test]
    fn 폰이_봉한_단톡을_같은_방_열쇠로_연다() {
        let v = vectors();
        let g = &v["group"];
        for (who, wrap) in [("bobSecret", &g["wrapBob"]), ("carolSecret", &g["wrapCarol"]), ("aliceSecret", &g["wrapAlice"])] {
            let m = open_wrap(&key(v[who].as_str().unwrap()), wrap).expect("group wrap opens");
            assert_eq!(m.members.len(), 3);
            assert_eq!(m.subject, g["subject"].as_str().unwrap());
            assert_eq!(m.text, g["text"].as_str().unwrap());
            assert_eq!(group_key(&m.members), g["key"].as_str().unwrap(), "폰 groupKey 와 같은 열쇠");
        }
        // 이모티콘 표(NIP-30)를 폰과 같이 만든다.
        assert_eq!(json!(sticker_tags(g["text"].as_str().unwrap())), g["emojiTags"]);
    }

    #[test]
    fn 여기서_봉한_것을_폰_규격으로_되풀어도_같다() {
        let v = vectors();
        let (alice, bob, carol) = (key(v["aliceSecret"].as_str().unwrap()), v["bob"].as_str().unwrap().to_string(), v["carol"].as_str().unwrap().to_string());
        let (wraps, rumor) = wrap_chat(&alice, &[bob.clone()], "안녕하세요 :ravi_hello:", "", now()).unwrap();
        assert_eq!(wraps.len(), 2, "상대 것 + 내 것");
        for (_, w) in &wraps {
            crate::nostrpub::validate_publish_event(w).expect("relay accepts");
        }
        let got = open_wrap(&key(v["bobSecret"].as_str().unwrap()), &wraps[0].1).unwrap();
        assert_eq!(got.id, rumor["id"].as_str().unwrap());
        assert_eq!(got.text, "안녕하세요 :ravi_hello:");
        assert!(open_wrap(&alice, &wraps[0].1).is_none(), "상대 겉봉은 나도 못 연다");
        assert_eq!(open_wrap(&alice, &wraps[1].1).unwrap().id, got.id, "내 사본은 같은 속지");
        // 단톡: 사람마다 한 장 + 내 것, 셋 다 같은 방 열쇠.
        let (gw, _) = wrap_chat(&alice, &[bob.clone(), carol.clone()], "모여요", "  주말 모임 ", 1_793_600_000).unwrap();
        assert_eq!(gw.len(), 3);
        let keys: Vec<String> = [("bobSecret", 0), ("carolSecret", 1), ("aliceSecret", 2)]
            .iter()
            .map(|(s, i)| {
                let m = open_wrap(&key(v[*s].as_str().unwrap()), &gw[*i].1).unwrap();
                assert_eq!(m.subject, "주말 모임");
                group_key(&m.members)
            })
            .collect();
        assert!(keys.iter().all(|k| k == &keys[0]));
    }

    #[test]
    fn 사칭_남의_쪽지_번호_바꾼_것은_안_연다() {
        use crate::wallet_link::{conv_key, nip44_encrypt, random32};
        let (alice, bob, mallory) = (sk(1), sk(2), sk(3));
        let (a, b) = (pubk(1), pubk(2));
        // 속지 보낸 이를 alice 로 적고 mallory 가 봉인 — 봉인 서명자와 달라 버린다.
        let rumor = rumor_of(&a, std::slice::from_ref(&b), "돈 보내 주세요", "", 1_793_600_000);
        let forged = seal_and_wrap(&mallory, &rumor, &b, 1_793_600_000).unwrap();
        assert!(open_wrap(&bob, &forged).is_none());
        // 속지 번호가 내용과 다르면 버린다.
        let mut bad = rumor_of(&a, std::slice::from_ref(&b), "원래 글", "", 1_793_600_000);
        bad["content"] = json!("바꾼 글");
        assert!(open_wrap(&bob, &seal_and_wrap(&alice, &bad, &b, 1_793_600_000).unwrap()).is_none());
        // 나와 상관없는 쪽지(p 에 내가 없음)를 나에게 감싸 보내도 대화에 끼우지 않는다.
        let other = rumor_of(&a, &[pubk(4)], "남의 글", "", 1_793_600_000);
        assert!(open_wrap(&bob, &seal_and_wrap(&alice, &other, &b, 1_793_600_000).unwrap()).is_none());
        // 서명이 틀린 겉봉은 버린다.
        let mut w = wrap_chat(&alice, std::slice::from_ref(&b), "안녕", "", 1_793_600_000).unwrap().0.remove(0).1;
        w["sig"] = json!("0".repeat(128));
        assert!(open_wrap(&bob, &w).is_none());
        let _ = (conv_key, nip44_encrypt, random32);
    }

    #[test]
    fn 받는_사람_검사와_30명_한도() {
        let alice = sk(1);
        assert!(wrap_chat(&alice, &["x".into()], "a", "", 1).is_err());
        let many: Vec<String> = (10..40u8).map(pubk).collect();
        assert_eq!(many.len(), 30);
        assert!(wrap_chat(&alice, &many, "a", "", 1).is_err(), "나 포함 31명");
        assert!(wrap_chat(&alice, &many[..29], "a", "", 1).is_ok(), "나 포함 30명");
        // 나에게만 쓰면 한 장.
        assert_eq!(wrap_chat(&alice, &[pubk(1)], "메모", "", 1).unwrap().0.len(), 1);
        assert_eq!(clean_pub(&crate::talk_social::npub_of(&pubk(2)).unwrap()), Some(pubk(2)));
        assert_eq!(clean_pub(&format!("nostr:{}", crate::talk_social::npub_of(&pubk(2)).unwrap())), Some(pubk(2)));
        assert_eq!(clean_pub(&pubk(2).to_ascii_uppercase()), Some(pubk(2)));
        assert_eq!(clean_pub("hello"), None);
    }

    #[test]
    fn 대화_목록_최근순_안읽음_안보기() {
        let me = pubk(1);
        let (b, c) = (pubk(2), pubk(3));
        let dm = |id: &str, from: &str, to: &str, at: i64, members: Vec<String>, subject: &str| Dm {
            id: id.into(), from: from.into(), to: to.into(), at, text: id.into(), wrap: format!("w{id}"), members, subject: subject.into(), photo: false,
        };
        let mut g = vec![me.clone(), b.clone(), c.clone()];
        g.sort();
        let msgs = vec![
            dm("1", &b, &me, 100, vec![], ""),
            dm("2", &me, &b, 110, vec![], ""),
            dm("3", &b, &me, 120, vec![], ""),
            dm("4", &c, &me, 200, g.clone(), "모임"),
            dm("5", &me, &b, 300, g.clone(), ""),
        ];
        let mut read = HashMap::new();
        read.insert(b.clone(), 105);
        let t = threads_from(&msgs, &me, &read, &[]);
        assert_eq!(t.len(), 2);
        assert_eq!(t[0].kind, "group");
        assert_eq!(t[0].key, group_key(&g));
        assert_eq!(t[0].subject, "모임", "마지막으로 붙은 이름");
        assert_eq!(t[0].unread, 1, "내가 쓴 것은 안 셈");
        assert_eq!(t[1].with, b);
        assert_eq!(t[1].unread, 1, "읽음 이후 남이 쓴 것만");
        assert_eq!(t[1].last.id, "3");
        let muted = threads_from(&msgs, &me, &read, &[b.clone()]);
        assert_eq!(muted.len(), 1, "안 보기 한 사람과의 1:1 은 뺀다");
        assert_eq!(muted[0].unread, 1);
    }

    #[test]
    fn 이모티콘_표() {
        assert_eq!(sticker_tags("hi :ravi_love: :ravi_love: :nope: :ravi_ok:").len(), 2);
        assert_eq!(sticker_tags(":ravi_ok::ravi_sad:").len(), 2);
        assert!(sticker_tags("시간 10:30:00").is_empty());
    }

    #[test]
    fn 기억은_주인이_바뀌면_비운다() {
        let a = "a".repeat(64);
        let b = "b".repeat(64);
        remember_sent(&a, Dm { id: "x".into(), from: a.clone(), to: a.clone(), at: 1, text: "t".into(), wrap: "w".into(), members: vec![], subject: String::new(), photo: false });
        assert_eq!(all_msgs(&a).len(), 1);
        assert!(all_msgs(&b).is_empty());
        assert!(all_msgs(&a).is_empty(), "다른 주인으로 바뀐 뒤 옛 글이 안 남는다");
    }
}
