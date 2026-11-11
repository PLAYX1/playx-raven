//! 이야기 SNS 빈 곳 채우기(11-09) — 폰 `core/talk/{links,notify,search,nip05,export}.ts` 와 **같은 규약**.
//!
//! - 글 속 링크: `#낱말` → `t` 표, `nostr:npub…`·`nostr:nprofile…` → `p` 표(NIP-27·NIP-10). 답글은 맨 위 글쓴이도 `p` 로 단다.
//! - 읽기: `e` 표 중 `mention` 표시는 **답글이 아니다**(인용한 글).
//! - 알림: 내 글 답글 · 나를 부른 글(kind 1, p=나) · 나를 팔로우(kind 3, p=나). 「본 것」 기록은 화면(localStorage)이 갖는다.
//! - 찾기: #해시태그 글 · 낱말 찾기는 NIP-11 이 NIP-50 을 알린 릴레이에만 묻는다.
//! - NIP-05 이름 확인: 사이트의 `/.well-known/nostr.json` 을 **러스트가** 묻는다(화면 CSP 밖) — 넘겨주기 안 따름 · 5초 · 64KB · 24시간 기억.
//! - 내 글 모두 받기: 내 0·1·3·10002·10003 원본 서명 그대로(지우기 요청 낸 글은 뺀다). 🔴 비밀 열쇠는 넣지 않는다.
//!
//! 🔴 좋아요 수·리포스트·알고리즘은 넣지 않는다(대표 결정). 알림도 「누가 무엇을」만.

use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};

const KIND_NOTE: i64 = 1;
const KIND_FOLLOWS: i64 = 3;
const KIND_DELETE: i64 = 5;
pub(crate) const MAX_NOTE_TAGS: usize = 10;
const MAX_MENTIONS: usize = 20;
const HEX64_LEN: usize = 64;

fn is_hex64(s: &str) -> bool {
    s.len() == HEX64_LEN && s.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
fn now() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0)
}

// ── NIP-19 (npub · nprofile · note · nevent) ────────────────────────────
const CHARSET: &[u8; 32] = b"qpzry9x8gf2tvdw0s3jn54khce6mua7l";
const GEN: [u32; 5] = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];

fn polymod(values: &[u8]) -> u32 {
    let mut chk: u32 = 1;
    for &v in values {
        let top = chk >> 25;
        chk = ((chk & 0x1ffffff) << 5) ^ v as u32;
        for (i, g) in GEN.iter().enumerate() {
            if (top >> i) & 1 == 1 {
                chk ^= g;
            }
        }
    }
    chk
}
fn expand(hrp: &str) -> Vec<u8> {
    let mut v: Vec<u8> = hrp.bytes().map(|c| c >> 5).collect();
    v.push(0);
    v.extend(hrp.bytes().map(|c| c & 31));
    v
}
fn convert(data: &[u8], from: u32, to: u32, pad: bool) -> Option<Vec<u8>> {
    let (mut acc, mut bits) = (0u32, 0u32);
    let max = (1u32 << to) - 1;
    let mut out = Vec::new();
    for &v in data {
        acc = ((acc << from) | v as u32) & 0xffffff;
        bits += from;
        while bits >= to {
            bits -= to;
            out.push(((acc >> bits) & max) as u8);
        }
    }
    if pad {
        if bits > 0 {
            out.push(((acc << (to - bits)) & max) as u8);
        }
    } else if bits >= from || ((acc << (to - bits)) & max) != 0 {
        return None;
    }
    Some(out)
}
fn bech32_encode(hrp: &str, bytes: &[u8]) -> String {
    let data = convert(bytes, 8, 5, true).unwrap_or_default();
    let mut values = expand(hrp);
    values.extend(&data);
    values.extend([0u8; 6]);
    let m = polymod(&values) ^ 1;
    let mut out = format!("{hrp}1");
    for v in data.iter().copied().chain((0..6).map(|i| ((m >> (5 * (5 - i))) & 31) as u8)) {
        out.push(CHARSET[v as usize] as char);
    }
    out
}
fn bech32_decode(raw: &str) -> Option<(String, Vec<u8>)> {
    let s = raw.trim().to_ascii_lowercase();
    if s.len() < 8 || s.len() > 1000 {
        return None;
    }
    let at = s.rfind('1')?;
    if at < 1 {
        return None;
    }
    let hrp = &s[..at];
    let data: Vec<u8> = s[at + 1..].bytes().map(|c| CHARSET.iter().position(|&x| x == c).map(|p| p as u8)).collect::<Option<_>>()?;
    if data.len() < 6 {
        return None;
    }
    let mut values = expand(hrp);
    values.extend(&data);
    if polymod(&values) != 1 {
        return None;
    }
    Some((hrp.to_string(), convert(&data[..data.len() - 6], 5, 8, false)?))
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) enum Nip19 {
    Person(String),
    Note { id: String, author: String },
}

/// npub·nprofile·note·nevent(앞에 「nostr:」 있어도 됨) → 뜻. nsec 등 다른 것·틀린 것은 None(열쇠는 읽지 않는다).
pub(crate) fn decode_nip19(raw: &str) -> Option<Nip19> {
    let t = raw.trim();
    let t = if t.len() >= 6 && t[..6].eq_ignore_ascii_case("nostr:") { &t[6..] } else { t };
    let (hrp, bytes) = bech32_decode(t)?;
    match hrp.as_str() {
        "npub" | "note" => {
            if bytes.len() != 32 {
                return None;
            }
            let h = hex::encode(&bytes);
            Some(if hrp == "npub" { Nip19::Person(h) } else { Nip19::Note { id: h, author: String::new() } })
        }
        "nprofile" | "nevent" => {
            let mut main: Option<Vec<u8>> = None;
            let mut author: Option<Vec<u8>> = None;
            let mut i = 0;
            while i < bytes.len() {
                let t = bytes[i];
                let l = *bytes.get(i + 1)? as usize;
                if i + 2 + l > bytes.len() {
                    return None;
                }
                let v = bytes[i + 2..i + 2 + l].to_vec();
                if t == 0 && main.is_none() {
                    main = Some(v);
                } else if t == 2 && author.is_none() {
                    author = Some(v);
                }
                i += 2 + l;
            }
            let main = main.filter(|m| m.len() == 32)?;
            if hrp == "nprofile" {
                return Some(Nip19::Person(hex::encode(main)));
            }
            let author = author.filter(|a| a.len() == 32).map(hex::encode).unwrap_or_default();
            Some(Nip19::Note { id: hex::encode(main), author })
        }
        _ => None,
    }
}
pub(crate) fn npub_of(pub_hex: &str) -> Option<String> {
    if !is_hex64(pub_hex) {
        return None;
    }
    Some(bech32_encode("npub", &hex::decode(pub_hex).ok()?))
}
#[cfg(test)]
fn nprofile_of(pub_hex: &str, relays: &[&str]) -> String {
    let mut b = vec![0u8, 32];
    b.extend(hex::decode(pub_hex).unwrap());
    for r in relays {
        b.push(1);
        b.push(r.len() as u8);
        b.extend(r.as_bytes());
    }
    bech32_encode("nprofile", &b)
}

// ── 글 속 링크 · 해시태그(폰 core/talk/links.ts noteSegments 와 같은 규칙) ──
const LINK_PREFIXES: [&str; 4] = ["npub1", "nprofile1", "note1", "nevent1"];
fn is_word(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_'
}
fn is_bech(c: char) -> bool {
    let l = c.to_ascii_lowercase();
    l.is_ascii() && CHARSET.contains(&(l as u8))
}
fn is_tag_char(c: char) -> bool {
    c.is_alphanumeric() || c == '_'
}
fn tag_lead(c: char) -> bool {
    c.is_whitespace() || "(（[{,.!?·".contains(c)
}

#[derive(Debug, Clone, PartialEq)]
enum Seg {
    Person(String),
    Note(String),
    Tag(String),
}

/// 글 → 링크 조각들(놓인 순서). 모양이 틀린 링크는 글자 그대로(조각 아님).
fn segments(text: &str) -> Vec<Seg> {
    let chars: Vec<(usize, char)> = text.char_indices().collect();
    let mut marks: Vec<(usize, usize, Seg)> = Vec::new();
    // 링크: (nostr:)?\b(npub1|nprofile1|note1|nevent1)[bech32]{20,600}\b  (대소문자 무시)
    let mut i = 0;
    while i < chars.len() {
        let at = chars[i].0;
        let prev_word = i > 0 && is_word(chars[i - 1].1);
        let rest = &text[at..];
        let hit = (!prev_word)
            .then(|| LINK_PREFIXES.iter().find(|p| rest.len() >= p.len() && rest.is_char_boundary(p.len()) && rest[..p.len()].eq_ignore_ascii_case(p)))
            .flatten();
        if let Some(p) = hit {
            let mut j = i + p.chars().count();
            let body_start = j;
            while j < chars.len() && is_bech(chars[j].1) {
                j += 1;
            }
            let n = j - body_start;
            let boundary = j >= chars.len() || !is_word(chars[j].1);
            if (20..=600).contains(&n) && boundary {
                let end = if j < chars.len() { chars[j].0 } else { text.len() };
                // 「nostr:」 이 바로 앞에 있으면 같은 링크다(regex 의 (?:nostr:)? 앞붙임).
                let start = if at >= 6 && text.is_char_boundary(at - 6) && text[at - 6..at].eq_ignore_ascii_case("nostr:") { at - 6 } else { at };
                if let Some(d) = decode_nip19(&text[at..end]) {
                    marks.push((start, end, match d { Nip19::Person(p) => Seg::Person(p), Nip19::Note { id, .. } => Seg::Note(id) }));
                }
                i = j;
                continue;
            }
        }
        i += 1;
    }
    // 해시태그: (^|[\s(（\[{,.!?·])#([\p{L}\p{N}_]{1,50}) · 숫자만은 아님
    for (k, &(at, c)) in chars.iter().enumerate() {
        if c != '#' || !(k == 0 || tag_lead(chars[k - 1].1)) {
            continue;
        }
        let mut j = k + 1;
        while j < chars.len() && j - (k + 1) < 50 && is_tag_char(chars[j].1) {
            j += 1;
        }
        if j == k + 1 {
            continue;
        }
        let word: String = chars[k + 1..j].iter().map(|x| x.1).collect();
        if word.chars().all(char::is_numeric) {
            continue;
        }
        let end = if j < chars.len() { chars[j].0 } else { text.len() };
        if marks.iter().any(|m| at < m.1 && end > m.0) {
            continue;
        }
        marks.push((at, end, Seg::Tag(word.to_lowercase())));
    }
    marks.sort_by_key(|m| m.0);
    let mut out = Vec::new();
    let mut pos = 0;
    for (at, end, s) in marks {
        if at < pos {
            continue;
        }
        out.push(s);
        pos = end;
    }
    out
}

/// 글 속 해시태그(소문자 · 겹침 없이 · 최대 10개).
pub(crate) fn hashtags_of(text: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for s in segments(text) {
        if let Seg::Tag(t) = s {
            if !out.contains(&t) {
                out.push(t);
            }
        }
    }
    out.truncate(MAX_NOTE_TAGS);
    out
}
/// 글 속에서 부른 사람(nostr:npub·nprofile) 공개키(최대 20).
pub(crate) fn mention_pubkeys(text: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for s in segments(text) {
        if let Seg::Person(p) = s {
            if !out.contains(&p) {
                out.push(p);
            }
        }
    }
    out.truncate(MAX_MENTIONS);
    out
}

/// 모두에게 글(kind 1)에 더 붙는 표 — 폰 `noteDraft` 와 같은 순서:
/// 맨 위 글쓴이 `p`(답글일 때) → 부른 사람 `p` → 해시태그 `t`. 이미 있는 `t`·`p` 는 다시 달지 않는다(ravencoin 표는 맨 앞 그대로).
pub(crate) fn extra_note_tags(existing: &[Value], text: &str, root_pub: Option<&str>) -> Vec<Value> {
    let mut have: HashSet<String> = existing
        .iter()
        .filter_map(|t| {
            let k = t.get(0)?.as_str()?;
            (k == "t" || k == "p").then(|| format!("{k}:{}", t.get(1).and_then(Value::as_str).unwrap_or("")))
        })
        .collect();
    let mut more = Vec::new();
    let mut add = |k: &str, v: &str| {
        if have.insert(format!("{k}:{v}")) {
            more.push(json!([k, v]));
        }
    };
    if let Some(r) = root_pub.filter(|r| is_hex64(r)) {
        add("p", r);
    }
    for p in mention_pubkeys(text) {
        add("p", &p);
    }
    for t in hashtags_of(text) {
        add("t", &t);
    }
    more
}

/// 공개 글에 열쇠(nsec)를 붙여 넣지 못하게(폰 postNote 와 같은 막음). 공개 글은 지울 수 없다.
pub(crate) fn has_nsec(text: &str) -> bool {
    let lower = text.to_ascii_lowercase();
    let mut from = 0;
    while let Some(i) = lower[from..].find("nsec1") {
        let at = from + i;
        let before_ok = at == 0 || !lower[..at].chars().next_back().is_some_and(is_word);
        let run = lower[at + 5..].chars().take_while(|c| is_bech(*c)).count();
        if before_ok && run >= 20 {
            return true;
        }
        from = at + 5;
    }
    false
}

// ── 읽기: 답글인가(NIP-10) — mention 표는 답글 표시가 아니다 ──
/// (맨 위 글, 부모 글). 맨 위 글이면 ("",""). 폰 `noteOf` 와 같은 규칙.
pub(crate) fn thread_of(e: &Value) -> (String, String) {
    let es: Vec<(String, String)> = e
        .get("tags")
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .filter(|t| t.get(0).and_then(Value::as_str) == Some("e"))
                .filter_map(|t| {
                    let id = t.get(1).and_then(Value::as_str)?;
                    let mark = t.get(3).and_then(Value::as_str).unwrap_or("");
                    (is_hex64(id) && mark != "mention").then(|| (id.to_string(), mark.to_string()))
                })
                .collect()
        })
        .unwrap_or_default();
    if es.is_empty() {
        return (String::new(), String::new());
    }
    if es.iter().any(|(_, m)| m == "root" || m == "reply") {
        let root = es.iter().find(|(_, m)| m == "root").map(|x| x.0.clone()).unwrap_or_default();
        let parent = es.iter().find(|(_, m)| m == "reply").map(|x| x.0.clone()).unwrap_or_else(|| root.clone());
        let root = if root.is_empty() { parent.clone() } else { root };
        return (root, parent);
    }
    (es[0].0.clone(), es[es.len() - 1].0.clone())
}
fn has_tag(e: &Value, k: &str, v: &str) -> bool {
    e.get("tags").and_then(Value::as_array).is_some_and(|a| {
        a.iter().any(|t| t.get(0).and_then(Value::as_str) == Some(k) && t.get(1).and_then(Value::as_str) == Some(v))
    })
}
fn kind_of(e: &Value) -> i64 {
    e.get("kind").and_then(Value::as_i64).unwrap_or(-1)
}
fn pub_of(e: &Value) -> &str {
    e.get("pubkey").and_then(Value::as_str).unwrap_or("")
}
fn at_of(e: &Value) -> i64 {
    e.get("created_at").and_then(Value::as_i64).unwrap_or(0)
}
fn id_of(e: &Value) -> &str {
    e.get("id").and_then(Value::as_str).unwrap_or("")
}

// ── 알림(폰 core/talk/notify.ts classifyNotices — 「새것」 판단만 화면이 한다) ──
/// 나를 팔로우하는 사람(각자 가장 늦은 kind 3 에 내가 있을 때만)과 그 목록 시각.
pub(crate) fn followers_of(events: &[Value], me: &str) -> Vec<(String, i64)> {
    let mut latest: HashMap<String, &Value> = HashMap::new();
    for e in events.iter().filter(|e| kind_of(e) == KIND_FOLLOWS && pub_of(e) != me && is_hex64(pub_of(e))) {
        let cur = latest.get(pub_of(e));
        if cur.is_none_or(|c| at_of(e) > at_of(c)) {
            latest.insert(pub_of(e).to_string(), e);
        }
    }
    let mut out: Vec<(String, i64)> = latest.into_iter().filter(|(_, e)| has_tag(e, "p", me)).map(|(p, e)| (p, at_of(e))).collect();
    out.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(&b.0)));
    out
}

/// 알림 목록: { key, kind: reply|mention|follow, pubkey, at, noteId, text }. 최신이 앞.
pub(crate) fn classify_notices(events: &[Value], me: &str) -> Vec<Value> {
    if !is_hex64(me) {
        return vec![];
    }
    let mut out: Vec<Value> = Vec::new();
    let mut ids = HashSet::new();
    for e in events {
        if kind_of(e) != KIND_NOTE || pub_of(e) == me || !ids.insert(id_of(e).to_string()) || !is_hex64(id_of(e)) {
            continue;
        }
        if !has_tag(e, "p", me) {
            continue;
        }
        let text = e.get("content").and_then(Value::as_str).unwrap_or("").trim();
        if text.is_empty() {
            continue;
        }
        let (root, _) = thread_of(e);
        out.push(json!({
            "key": id_of(e), "kind": if root.is_empty() { "mention" } else { "reply" },
            "pubkey": pub_of(e), "at": at_of(e), "noteId": id_of(e),
            "text": text.chars().take(400).collect::<String>(),
        }));
    }
    for (p, at) in followers_of(events, me) {
        out.push(json!({ "key": format!("f:{p}"), "kind": "follow", "pubkey": p, "at": at, "noteId": "", "text": "" }));
    }
    out.sort_by_key(|n| -n["at"].as_i64().unwrap_or(0));
    out
}

// ── NIP-05 (폰 core/talk/nip05.ts) ──
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct Nip05 {
    pub name: String,
    pub domain: String,
}
pub(crate) const NIP05_MAX_BYTES: usize = 64 * 1024;
const NIP05_CACHE_SECS: u64 = 24 * 60 * 60;

fn name_ok(s: &str) -> bool {
    (1..=64).contains(&s.len()) && s.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b"._-".contains(&b))
}
fn domain_ok(s: &str) -> bool {
    if !(4..=253).contains(&s.len()) {
        return false;
    }
    let parts: Vec<&str> = s.split('.').collect();
    if parts.len() < 2 {
        return false;
    }
    let (tld, labels) = parts.split_last().unwrap();
    let tld_ok = (2..=63).contains(&tld.len()) && tld.bytes().all(|b| b.is_ascii_lowercase());
    tld_ok
        && labels.iter().all(|l| {
            (1..=63).contains(&l.len())
                && l.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
                && !l.starts_with('-')
                && !l.ends_with('-')
        })
}
/// 「이름@사이트」(또는 사이트만 = _@사이트) → 나눈 것. 틀리면 None.
pub(crate) fn parse_nip05(raw: &str) -> Option<Nip05> {
    let s = raw.trim().to_lowercase();
    if s.is_empty() || s.len() > 320 {
        return None;
    }
    let (name, domain) = match s.rfind('@') {
        Some(at) => (s[..at].to_string(), s[at + 1..].to_string()),
        None => ("_".to_string(), s.clone()),
    };
    (name_ok(&name) && domain_ok(&domain)).then_some(Nip05 { name, domain })
}
pub(crate) fn nip05_url(n: &Nip05) -> String {
    // 이름은 [a-z0-9._-] 뿐이라 따로 옮겨 적을 글자가 없다.
    format!("https://{}/.well-known/nostr.json?name={}", n.domain, n.name)
}
pub(crate) fn nip05_shown(n: &Nip05) -> String {
    if n.name == "_" { n.domain.clone() } else { format!("{}@{}", n.name, n.domain) }
}
pub(crate) fn nip05_matches(body: &Value, n: &Nip05, pubkey: &str) -> bool {
    is_hex64(pubkey)
        && body.get("names").and_then(Value::as_object).and_then(|m| m.get(&n.name)).and_then(Value::as_str).is_some_and(|v| v.to_ascii_lowercase() == pubkey)
}

// ── 찾기(NIP-11 · NIP-50) ──
pub(crate) fn relay_info_url(relay: &str) -> Option<String> {
    let rest = relay.strip_prefix("wss://").or_else(|| relay.get(..6).filter(|p| p.eq_ignore_ascii_case("wss://")).map(|_| &relay[6..]))?;
    if rest.is_empty() || rest.contains(|c: char| c.is_whitespace() || c == '?' || c == '#') {
        return None;
    }
    let host = rest.split('/').next().unwrap_or("");
    if host.is_empty() {
        return None;
    }
    Some(format!("https://{rest}"))
}
pub(crate) fn relay_supports_search(info: &Value) -> bool {
    info.get("supported_nips").and_then(Value::as_array).is_some_and(|a| a.iter().any(|x| x.as_i64() == Some(50) || x.as_str() == Some("50")))
}

// ── 내 글 모두 받기(폰 core/talk/export.ts exportBundle) ──
pub(crate) const EXPORT_KINDS: [i64; 5] = [0, 1, 3, 10002, 10003];
const EXPORT_FORMAT: &str = "ravenvault-nostr-export";

/// 서명된 원본만 한 묶음으로. 바꿔 쓰는 목록(0·3·10002·10003)은 가장 늦은 것 하나, 글(1)은 지우기 요청(kind 5)한 것을 뺀다.
pub(crate) fn export_bundle(events: &[Value], me: &str, at: i64) -> Value {
    let mine: Vec<&Value> = events.iter().filter(|e| pub_of(e) == me).collect();
    let deleted: HashSet<String> = mine
        .iter()
        .filter(|e| kind_of(e) == KIND_DELETE)
        .flat_map(|e| e.get("tags").and_then(Value::as_array).cloned().unwrap_or_default())
        .filter(|t| t.get(0).and_then(Value::as_str) == Some("e"))
        .filter_map(|t| t.get(1).and_then(Value::as_str).filter(|i| is_hex64(i)).map(str::to_string))
        .collect();
    let mut latest: HashMap<i64, &Value> = HashMap::new();
    let mut notes: Vec<&Value> = Vec::new();
    let mut seen = HashSet::new();
    for e in mine.into_iter().filter(|e| EXPORT_KINDS.contains(&kind_of(e))) {
        if !seen.insert(id_of(e).to_string()) {
            continue;
        }
        let k = kind_of(e);
        if k == KIND_NOTE {
            if !deleted.contains(id_of(e)) {
                notes.push(e);
            }
        } else {
            let cur = latest.get(&k);
            if cur.is_none_or(|c| at_of(e) > at_of(c) || (at_of(e) == at_of(c) && id_of(e) < id_of(c))) {
                latest.insert(k, e);
            }
        }
    }
    let mut out: Vec<&Value> = latest.into_values().chain(notes).collect();
    out.sort_by(|a, b| at_of(a).cmp(&at_of(b)).then(kind_of(a).cmp(&kind_of(b))));
    let mut counts = serde_json::Map::new();
    for e in &out {
        let k = kind_of(e).to_string();
        let n = counts.get(&k).and_then(Value::as_i64).unwrap_or(0) + 1;
        counts.insert(k, json!(n));
    }
    let clean: Vec<Value> = out
        .iter()
        .map(|e| json!({ "id": e["id"], "pubkey": e["pubkey"], "created_at": e["created_at"], "kind": e["kind"], "tags": e["tags"], "content": e["content"], "sig": e["sig"] }))
        .collect();
    json!({ "format": EXPORT_FORMAT, "version": 1, "pubkey": me, "npub": npub_of(me).unwrap_or_default(), "exportedAt": at, "counts": counts, "events": clean })
}

/// 저장할 곳: 절대 경로 · `.json` 만.
fn json_path(path: &str) -> Result<std::path::PathBuf, String> {
    let p = std::path::PathBuf::from(path.trim());
    if !p.is_absolute() {
        return Err("저장할 곳을 다시 골라 주세요.".into());
    }
    let ok = p.extension().and_then(|x| x.to_str()).is_some_and(|x| x.eq_ignore_ascii_case("json"));
    Ok(if ok { p } else { p.with_extension("json") })
}

// ── 피드: 팔로우만 보기 = 그 사람들의 모든 맨 위 글(ravencoin 표 없이) · 모두에게 = ravencoin 표 글 ──
pub(crate) fn feed_filter(follows: Option<&[String]>, until: Option<i64>, limit: i64) -> Value {
    let mut f = json!({ "kinds": [KIND_NOTE], "limit": limit.clamp(1, 200) });
    match follows {
        Some(a) => f["authors"] = json!(a),
        None => f["#t"] = json!([crate::talk::TALK_TAG]),
    }
    if let Some(u) = until.filter(|u| *u > 0) {
        f["until"] = json!(u);
    }
    f
}
/// 물음에 맞는 글만(릴레이는 아무거나 줄 수 있다). 팔로우 모드는 맨 위 글 + 우리 표(ravencoin)가 달린 답글.
pub(crate) fn feed_keep(e: &Value, follows: Option<&HashSet<String>>, until: Option<i64>) -> bool {
    if kind_of(e) != KIND_NOTE || until.is_some_and(|u| u > 0 && at_of(e) > u) {
        return false;
    }
    let ours = has_tag(e, "t", crate::talk::TALK_TAG);
    match follows {
        Some(set) => set.contains(pub_of(e)) && (ours || thread_of(e).0.is_empty()),
        None => ours,
    }
}

// ── 명령 ─────────────────────────────────────────────────────────────
fn my_pub() -> Result<String, String> {
    crate::shopkey::pubkey_of(&crate::talk::signing_key()?)
}

/// 피드 한 쪽. `follows` = 팔로우만 보기. `until` = 이 시각까지(이어 불러오기: 가장 오래된 시각 − 1).
/// 돌려줌 { notes(최신이 앞), scanned(릴레이가 준 수), oldest(그중 가장 오래된 시각), follows(팔로우 수) }.
#[tauri::command]
pub async fn talk_feed(follows: bool, until: Option<i64>, limit: Option<i64>) -> Result<Value, String> {
    feed_notes(follows, until, limit.unwrap_or(60), false, None, &[]).await
}

/// 피드 한 쪽 — talk_feed · talk_view(talk_fast.rs) 가 같이 쓴다. `local`·`since`·`known` 은 talk::room_notes 와 같은 뜻.
/// 「팔로우만」을 이 컴퓨터에서만 읽을 때는 이 컴퓨터 릴레이에 있는 내 팔로우 목록을 쓴다(없으면 빈 쪽 — 바깥 답을 기다린다).
pub(crate) async fn feed_notes(follows: bool, until: Option<i64>, limit: i64, local: bool, since: Option<i64>, known: &[String]) -> Result<Value, String> {
    let limit = limit.clamp(1, 200);
    let (authors, set) = if follows {
        let me = my_pub()?;
        let list = if local {
            crate::relay::query_local(&[json!({ "kinds": [KIND_FOLLOWS], "authors": [me], "limit": 1 })]).into_iter().next()
        } else {
            crate::talk::my_follow_list_pub(&me).await?
        };
        if local && list.is_none() {
            return Ok(json!({ "notes": [], "scanned": 0, "oldest": 0, "follows": 0 }));
        }
        let mut a = crate::talk::follow_ids_of(list.as_ref());
        a.truncate(199);
        if !a.contains(&me) {
            a.push(me);
        }
        let set: HashSet<String> = a.iter().cloned().collect();
        (Some(a), Some(set))
    } else {
        (None, None)
    };
    let mut filter = feed_filter(authors.as_deref(), until, limit);
    if let Some(t) = since.filter(|t| *t > 0) {
        filter["since"] = json!(t);
    }
    let mut list = if local {
        crate::relay::query_local(std::slice::from_ref(&filter))
    } else {
        // 11-12: 화면이 이미 그린 글(known)의 지우기 요청은 본 물음과 **동시에** 묻는다.
        let (got, ()) = tokio::join!(crate::nostrpub::query_filters(vec![filter.clone()]), crate::talk_fast::learn_deletions(known.to_vec()));
        let (mut list, _) = got?;
        let who: Vec<String> = match &authors {
            Some(a) => a.clone(),
            None => list.iter().map(|e| pub_of(e).to_string()).collect(),
        };
        let mut ob = filter.clone();
        if let Some(o) = ob.as_object_mut() {
            o.remove("authors");
        }
        list.extend(crate::relay_share::outbox_extra(ob, who).await);
        // since 를 모르는 릴레이(옛 판 등)가 다 줘도 「새 글만」이 되게.
        list.retain(|e| since.is_none_or(|t| at_of(e) >= t));
        crate::talk_fast::learn_deletions_later(&list, known);
        list
    };
    let scanned = list.len();
    let oldest = list.iter().map(at_of).filter(|t| *t > 0).min().unwrap_or(0);
    let mut seen = HashSet::new();
    list.retain(|e| feed_keep(e, set.as_ref(), until) && !crate::relay::is_gone(e) && seen.insert(id_of(e).to_string()));
    if !local {
        crate::relay::absorb(list.clone());
    }
    list.sort_by_key(|e| -at_of(e));
    Ok(json!({ "notes": list, "scanned": scanned, "oldest": oldest, "follows": set.map(|s| s.len().saturating_sub(1)).unwrap_or(0) }))
}

/// 알림 재료: 지난 30일 나를 가리킨 글(kind 1, p=나) + 나를 담은 팔로우 목록(kind 3, p=나). 분류만 해서 준다 — 「새것」은 화면이 가른다.
#[tauri::command]
pub async fn talk_notices() -> Result<Value, String> {
    let me = my_pub()?;
    let since = now() - 30 * 86_400;
    let (got, reached) = crate::nostrpub::query_filters(vec![
        json!({ "kinds": [KIND_NOTE], "#p": [me], "limit": 100, "since": since }),
        json!({ "kinds": [KIND_FOLLOWS], "#p": [me], "limit": 100 }),
    ])
    .await?;
    Ok(json!({ "me": me, "notices": classify_notices(&got, &me), "reached": reached }))
}

/// #해시태그 글(다른 앱 글 · 답글 포함). 최신이 앞.
#[tauri::command]
pub async fn talk_tag_notes(tag: String) -> Result<Value, String> {
    let t = tag.trim().trim_start_matches('#').trim().to_string();
    if t.is_empty() || t.chars().count() > 50 || !t.chars().all(is_tag_char) {
        return Err("찾을 해시태그 모양이 아니에요.".into());
    }
    let low = t.to_lowercase();
    let vals: Vec<String> = if low == t { vec![low.clone()] } else { vec![low.clone(), t.clone()] };
    let (mut list, reached) = crate::nostrpub::query_filters(vec![json!({ "kinds": [KIND_NOTE], "#t": vals, "limit": 100 })]).await?;
    list.retain(|e| kind_of(e) == KIND_NOTE && vals.iter().any(|v| has_tag(e, "t", v)));
    Ok(json!({ "notes": list, "reached": reached }))
}

fn search_cache() -> &'static std::sync::Mutex<HashMap<String, (bool, std::time::Instant)>> {
    static C: std::sync::OnceLock<std::sync::Mutex<HashMap<String, (bool, std::time::Instant)>>> = std::sync::OnceLock::new();
    C.get_or_init(Default::default)
}
fn http() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(std::time::Duration::from_secs(5))
        .build()
        .map_err(|e| e.to_string())
}
/// 답 본문을 `max` 바이트까지만 읽는다. 넘으면 None.
async fn small_body(mut r: reqwest::Response, max: usize) -> Option<Vec<u8>> {
    if r.content_length().is_some_and(|n| n as usize > max) {
        return None;
    }
    let mut out = Vec::new();
    while let Ok(Some(c)) = r.chunk().await {
        out.extend_from_slice(&c);
        if out.len() > max {
            return None;
        }
    }
    Some(out)
}
async fn relay_can_search(relay: &str) -> bool {
    let Some(url) = relay_info_url(relay) else { return false };
    if let Some((ok, at)) = search_cache().lock().ok().and_then(|m| m.get(&url).copied()) {
        if at.elapsed().as_secs() < 6 * 3600 {
            return ok;
        }
    }
    let ok = async {
        let r = http().ok()?.get(&url).header("accept", "application/nostr+json").timeout(std::time::Duration::from_secs(4)).send().await.ok()?;
        if !r.status().is_success() {
            return Some(false);
        }
        let b = small_body(r, 256 * 1024).await?;
        Some(relay_supports_search(&serde_json::from_slice::<Value>(&b).ok()?))
    }
    .await
    .unwrap_or(false);
    if let Ok(mut m) = search_cache().lock() {
        m.insert(url, (ok, std::time::Instant::now()));
    }
    ok
}

/// 낱말 찾기 — NIP-11 이 NIP-50 을 알린 릴레이에만 묻는다. asked = 물어본 릴레이 수(0 이면 화면이 이미 받은 글 안에서만 찾은 것).
#[tauri::command]
pub async fn talk_search(text: String) -> Result<Value, String> {
    let q: String = text.trim().chars().take(100).collect();
    if q.is_empty() {
        return Ok(json!({ "notes": [], "asked": 0 }));
    }
    let relays = crate::nostrpub::outside_relays();
    let ok = futures_util::future::join_all(relays.iter().map(|r| relay_can_search(r))).await;
    let usable: Vec<String> = relays.into_iter().zip(ok).filter(|(_, o)| *o).map(|(r, _)| r).collect();
    if usable.is_empty() {
        return Ok(json!({ "notes": [], "asked": 0 }));
    }
    let req = json!(["REQ", "s50", { "kinds": [KIND_NOTE], "search": q, "limit": 50 }]).to_string();
    let got = futures_util::future::join_all(usable.iter().map(|u| crate::nostrpub::read_one(u, &req, "s50"))).await;
    let mut seen = HashSet::new();
    let mut notes: Vec<Value> = got.into_iter().flatten().flatten().filter(|e| kind_of(e) == KIND_NOTE && seen.insert(id_of(e).to_string())).collect();
    notes.sort_by_key(|e| -at_of(e));
    notes.truncate(150);
    Ok(json!({ "notes": notes, "asked": usable.len() }))
}

fn ip_public(ip: std::net::IpAddr) -> bool {
    match ip {
        std::net::IpAddr::V4(a) => {
            let o = a.octets();
            !(a.is_loopback() || a.is_private() || a.is_link_local() || a.is_unspecified() || a.is_broadcast() || a.is_documentation()
                || o[0] == 0 || (o[0] == 100 && (64..128).contains(&o[1])) || o[0] >= 224)
        }
        std::net::IpAddr::V6(a) => {
            let seg = a.segments();
            if let Some(v4) = a.to_ipv4_mapped() {
                return ip_public(std::net::IpAddr::V4(v4));
            }
            !(a.is_loopback() || a.is_unspecified() || a.is_multicast() || (seg[0] & 0xfe00) == 0xfc00 || (seg[0] & 0xffc0) == 0xfe80)
        }
    }
}
/// 이 이름이 바깥(공개) 주소로만 풀리는가.
async fn public_host(domain: &str) -> bool {
    match tokio::net::lookup_host(format!("{domain}:443")).await {
        Ok(a) => {
            let v: Vec<std::net::SocketAddr> = a.collect();
            !v.is_empty() && v.iter().all(|x| ip_public(x.ip()))
        }
        Err(_) => false,
    }
}

fn nip05_cache() -> &'static std::sync::Mutex<HashMap<String, (bool, std::time::Instant)>> {
    static C: std::sync::OnceLock<std::sync::Mutex<HashMap<String, (bool, std::time::Instant)>>> = std::sync::OnceLock::new();
    C.get_or_init(Default::default)
}

/// NIP-05 이름 확인. `{ ok, shown }` — ok 면 shown 이 「이름@사이트」. 뜻은 「이 사이트가 이 이름표를 자기 이름으로 올려 두었다」까지(신원 확인 아님).
/// 넘겨주기를 따르지 않는다 · 5초 · 64KB. 답을 받은 결과는 24시간 기억한다(못 닿으면 기억하지 않고 다음에 다시 묻는다).
#[tauri::command]
pub async fn talk_nip05_check(pubkey: String, nip05: String) -> Result<Value, String> {
    let pubkey = pubkey.trim().to_ascii_lowercase();
    let Some(n) = parse_nip05(&nip05).filter(|_| is_hex64(&pubkey)) else {
        return Ok(json!({ "ok": false, "shown": "" }));
    };
    let key = format!("{pubkey}|{}@{}", n.name, n.domain);
    let shown = nip05_shown(&n);
    if let Some((ok, at)) = nip05_cache().lock().ok().and_then(|m| m.get(&key).copied()) {
        if at.elapsed().as_secs() < NIP05_CACHE_SECS {
            return Ok(json!({ "ok": ok, "shown": if ok { shown } else { String::new() } }));
        }
    }
    let answered = async {
        // 이름표에 적힌 사이트가 이 컴퓨터·집 안 기계(공유기 등)를 가리키면 묻지 않는다.
        if !public_host(&n.domain).await {
            return Some(false);
        }
        let r = http().ok()?.get(nip05_url(&n)).header("accept", "application/json").send().await.ok()?;
        if !r.status().is_success() {
            return Some(false); // 넘겨주기(3xx)·없음(404) = 확인 안 됨
        }
        let b = small_body(r, NIP05_MAX_BYTES).await;
        Some(b.and_then(|b| serde_json::from_slice::<Value>(&b).ok()).is_some_and(|v| nip05_matches(&v, &n, &pubkey)))
    }
    .await;
    let ok = answered.unwrap_or(false);
    if answered.is_some() {
        if let Ok(mut m) = nip05_cache().lock() {
            if m.len() > 500 {
                m.clear();
            }
            m.insert(key, (ok, std::time::Instant::now()));
        }
    }
    Ok(json!({ "ok": ok, "shown": if ok { shown } else { String::new() } }))
}

/// 글 번호로 글을 가져온다(「글 보기」·알림에서 열기). 50개까지.
#[tauri::command]
pub async fn talk_notes_by_id(ids: Vec<String>) -> Result<Value, String> {
    let ids: Vec<String> = ids.into_iter().map(|s| s.trim().to_ascii_lowercase()).filter(|s| is_hex64(s)).take(50).collect();
    let mut got = crate::nostrpub::nostr_query_ids(vec![KIND_NOTE], ids).await?;
    got.sort_by_key(|e| -at_of(e));
    Ok(json!(got))
}

/// 내 글 모두 받기 — 기본 릴레이 + 이 컴퓨터 릴레이(보관해 둔 내 글)에서 내 0·1·3·10002·10003·5 를 끝까지 넘겨 읽어 한 파일로 저장.
/// 🔴 비밀 열쇠는 넣지 않는다(이 함수는 공개키만 쓴다). 북마크(10003)는 잠긴 암호문 그대로.
#[tauri::command]
pub async fn talk_export(path: String) -> Result<Value, String> {
    let target = json_path(&path)?;
    let me = my_pub()?;
    let local = format!("ws://127.0.0.1:{}/api/relay", crate::server::PORT);
    let mut urls = vec![local.clone()];
    urls.extend(crate::nostrpub::outside_relays());
    let kinds: Vec<i64> = vec![0, 1, 3, KIND_DELETE, 10002, 10003];
    let runs = urls.iter().map(|url| {
        let (url, me, kinds) = (url.clone(), me.clone(), kinds.clone());
        async move {
            let r = crate::nostrpub::page_all(|until| {
                let (url, me, kinds) = (url.clone(), me.clone(), kinds.clone());
                async move { crate::nostrpub::read_mine_page(&url, &me, &kinds, None, until).await }
            }, 30)
            .await;
            (url, r)
        }
    });
    let got = futures_util::future::join_all(runs).await;
    let mut all: HashMap<String, Value> = HashMap::new();
    let mut outside_ids: HashSet<String> = HashSet::new();
    let mut local_events: Vec<Value> = Vec::new();
    let mut reached = 0;
    let mut complete = true;
    for (url, r) in got {
        let Ok((events, done)) = r else { continue };
        reached += 1;
        complete &= done;
        for e in events.into_iter().filter(|e| pub_of(e) == me) {
            if url == local {
                local_events.push(e);
            } else {
                outside_ids.insert(id_of(&e).to_string());
                all.entry(id_of(&e).to_string()).or_insert(e);
            }
        }
    }
    if reached == 0 {
        return Err("릴레이에 연결하지 못했어요. 인터넷 연결을 확인하고 다시 눌러 주세요.".into());
    }
    let mut from_own = 0;
    for e in local_events {
        if !outside_ids.contains(id_of(&e)) && !all.contains_key(id_of(&e)) {
            from_own += 1;
        }
        all.entry(id_of(&e).to_string()).or_insert(e);
    }
    let events: Vec<Value> = all.into_values().collect();
    let bundle = export_bundle(&events, &me, now());
    let count = bundle["events"].as_array().map(Vec::len).unwrap_or(0);
    let body = serde_json::to_vec_pretty(&bundle).map_err(|e| e.to_string())?;
    std::fs::write(&target, body).map_err(|e| format!("저장하지 못했습니다: {e}"))?;
    Ok(json!({ "path": target.to_string_lossy(), "count": count, "counts": bundle["counts"], "from_own": from_own, "complete": complete, "npub": bundle["npub"] }))
}

#[cfg(test)]
mod tests {
    use super::*;
    const A: &str = "3bf0c63fcb93463407af97a5e5ee64fa883d107ef9e558472c4eb9aaaefa459d";
    const B: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    fn me() -> String {
        "a".repeat(64)
    }
    fn ev(id: char, pubkey: &str, kind: i64, at: i64, tags: Value, content: &str) -> Value {
        json!({ "id": id.to_string().repeat(64), "pubkey": pubkey, "kind": kind, "created_at": at, "tags": tags, "content": content, "sig": "0".repeat(128) })
    }

    #[test]
    fn nip19_round_trip_and_known_vector() {
        let n = npub_of(A).unwrap();
        assert_eq!(n, "npub180cvv07tjdrrgpa0j7j7tmnyl2yr6yr7l8j4s3evf6u64th6gkwsyjh6w6");
        assert_eq!(decode_nip19(&format!("nostr:{n}")), Some(Nip19::Person(A.into())));
        let np = nprofile_of(A, &["wss://r.x.com", "wss://djbas.sadkb.com"]);
        assert_eq!(decode_nip19(&np), Some(Nip19::Person(A.into())));
        // NIP-19 문서의 nprofile 시험 벡터
        assert_eq!(
            decode_nip19("nprofile1qqsrhuxx8l9ex335q7he0f09aej04zpazpl0ne2cgukyawd24mayt8gpp4mhxue69uhhytnc9e3k7mgpz4mhxue69uhkg6nzv9ejuumpv34kytnrdaksjlyr9p"),
            Some(Nip19::Person(A.into()))
        );
        let note = bech32_encode("note", &hex::decode("c".repeat(64)).unwrap());
        assert_eq!(decode_nip19(&note), Some(Nip19::Note { id: "c".repeat(64), author: String::new() }));
        // nsec 는 읽지 않는다 · 틀린 체크섬은 None
        assert_eq!(decode_nip19(&bech32_encode("nsec", &[7u8; 32])), None);
        let mut bad = n.clone();
        bad.pop();
        bad.push('q');
        assert_eq!(decode_nip19(&bad), None);
    }

    #[test]
    fn hashtags_and_mentions_follow_phone_rules() {
        let n = npub_of(A).unwrap();
        let text = format!("안녕 #레이븐 #Ravencoin #1 x#no (#괄호) 그리고 nostr:{n} 와 {n}. #레이븐 #a_b");
        assert_eq!(hashtags_of(&text), vec!["레이븐", "ravencoin", "괄호", "a_b"]);
        assert_eq!(mention_pubkeys(&text), vec![A.to_string()]);
        // 링크 안의 글자는 해시태그가 아니고, 단어에 붙은 npub 은 링크가 아니다
        assert!(mention_pubkeys(&format!("x{n}")).is_empty());
        let many: String = (0..15).map(|i| format!("#t{i} ")).collect();
        assert_eq!(hashtags_of(&many).len(), MAX_NOTE_TAGS);
        let long = format!("#{}", "가".repeat(60));
        assert_eq!(hashtags_of(&long), vec!["가".repeat(50)]);
    }

    #[test]
    fn note_tags_match_phone_note_draft() {
        let n = npub_of(A).unwrap();
        // 맨 위 글: [t ravencoin] + p 부른 사람 + t 해시태그 (ravencoin 은 두 번 달지 않는다)
        let base = vec![json!(["t", "ravencoin"])];
        let more = extra_note_tags(&base, &format!("#Ravencoin #시장 nostr:{n}"), None);
        assert_eq!(more, vec![json!(["p", A]), json!(["t", "시장"])]);
        // 답글의 답: 맨 위 글쓴이 p 도 단다 · 이미 있는 p 는 다시 안 단다
        let tags = crate::talk::reply_tags_for_test("p1", B, "r1");
        let more = extra_note_tags(&tags, &format!("hi nostr:{n}"), Some(A));
        assert_eq!(more, vec![json!(["p", A])]);
        let more = extra_note_tags(&tags, "hi", Some(B));
        assert!(more.is_empty(), "부모 글쓴이와 맨 위 글쓴이가 같으면 한 번만");
        assert!(has_nsec(&format!("내 열쇠 {}", bech32_encode("nsec", &[7u8; 32]))));
        assert!(!has_nsec("nsec1 은 열쇠 이름이에요"));
    }

    #[test]
    fn mention_marked_e_tags_are_not_replies() {
        let quote = ev('1', A, 1, 10, json!([["e", "c".repeat(64), "", "mention"], ["t", "ravencoin"]]), "인용");
        assert_eq!(thread_of(&quote), (String::new(), String::new()));
        let reply = ev('2', A, 1, 10, json!([["e", "c".repeat(64), "", "root"], ["e", "d".repeat(64), "", "reply"]]), "답");
        assert_eq!(thread_of(&reply), ("c".repeat(64), "d".repeat(64)));
        let desk = ev('3', A, 1, 10, json!([["e", "d".repeat(64), "", "reply"]]), "답");
        assert_eq!(thread_of(&desk), ("d".repeat(64), "d".repeat(64)));
        let old = ev('4', A, 1, 10, json!([["e", "c".repeat(64)], ["e", "d".repeat(64)]]), "옛 모양");
        assert_eq!(thread_of(&old), ("c".repeat(64), "d".repeat(64)));
    }

    #[test]
    fn notices_are_classified_like_phone() {
        let me = me();
        let events = vec![
            ev('1', A, 1, 100, json!([["e", "c".repeat(64), "", "root"], ["p", me]]), "답글"),
            ev('2', A, 1, 90, json!([["p", me], ["e", "c".repeat(64), "", "mention"]]), "부름"),
            ev('3', &me, 1, 95, json!([["p", me]]), "내 글"),
            ev('4', A, 1, 80, json!([["t", "x"]]), "나와 무관"),
            ev('5', A, 3, 50, json!([["p", me]]), ""),
            ev('6', A, 3, 60, json!([["p", me], ["p", B]]), ""),
            ev('7', B, 3, 70, json!([["p", me]]), ""),
            ev('8', B, 3, 75, json!([["p", A]]), ""), // B 의 가장 늦은 목록에는 내가 없다 → 팔로우 아님
        ];
        let got = classify_notices(&events, &me);
        let kinds: Vec<(&str, &str)> = got.iter().map(|n| (n["kind"].as_str().unwrap(), n["pubkey"].as_str().unwrap())).collect();
        assert_eq!(kinds, vec![("reply", A), ("mention", A), ("follow", A)]);
        assert_eq!(got[2]["at"], 60);
        assert_eq!(got[2]["key"], format!("f:{A}"));
    }

    #[test]
    fn nip05_parse_and_match() {
        let n = parse_nip05(" Bob@Example.com ").unwrap();
        assert_eq!(n, Nip05 { name: "bob".into(), domain: "example.com".into() });
        assert_eq!(nip05_url(&n), "https://example.com/.well-known/nostr.json?name=bob");
        assert_eq!(nip05_shown(&parse_nip05("ravenvault.ex.erci.se").unwrap()), "ravenvault.ex.erci.se");
        assert!(parse_nip05("bob@localhost").is_none());
        assert!(parse_nip05("bo b@example.com").is_none());
        assert!(parse_nip05("bob@-bad.com").is_none());
        assert!(parse_nip05("").is_none());
        assert!(nip05_matches(&json!({ "names": { "bob": A.to_uppercase() } }), &n, A));
        assert!(!nip05_matches(&json!({ "names": { "bob": B } }), &n, A));
        assert!(!nip05_matches(&json!({ "names": ["bob"] }), &n, A));
    }

    #[test]
    fn nip05_does_not_ask_home_machines() {
        for ip in ["127.0.0.1", "10.0.0.1", "192.168.1.1", "100.100.1.1", "169.254.1.1", "::1", "fd00::1", "::ffff:192.168.0.1"] {
            assert!(!ip_public(ip.parse().unwrap()), "{ip}");
        }
        assert!(ip_public("1.1.1.1".parse().unwrap()) && ip_public("2606:4700::1111".parse().unwrap()));
    }

    #[test]
    fn relay_info_and_search_support() {
        assert_eq!(relay_info_url("wss://relay.damus.io").as_deref(), Some("https://relay.damus.io"));
        assert_eq!(relay_info_url("wss://playx.taile277f6.ts.net/relay").as_deref(), Some("https://playx.taile277f6.ts.net/relay"));
        assert!(relay_info_url("ws://127.0.0.1:1/api/relay").is_none());
        assert!(relay_supports_search(&json!({ "supported_nips": [1, 11, "50"] })));
        assert!(!relay_supports_search(&json!({ "supported_nips": [1, 11] })));
    }

    #[test]
    fn export_keeps_latest_lists_and_drops_deleted_notes() {
        let me = me();
        let events = vec![
            ev('1', &me, 0, 10, json!([]), "{\"name\":\"old\"}"),
            ev('2', &me, 0, 20, json!([]), "{\"name\":\"new\"}"),
            ev('3', &me, 1, 30, json!([["t", "ravencoin"]]), "남김"),
            ev('4', &me, 1, 31, json!([]), "지움"),
            ev('5', &me, 5, 32, json!([["e", "4".repeat(64)]]), ""),
            ev('6', A, 1, 33, json!([]), "남의 글"),
            ev('7', &me, 10003, 40, json!([]), "잠긴 암호문"),
        ];
        let b = export_bundle(&events, &me, 99);
        let ids: Vec<&str> = b["events"].as_array().unwrap().iter().map(|e| e["id"].as_str().unwrap()).collect();
        assert_eq!(ids, vec!["2".repeat(64), "3".repeat(64), "7".repeat(64)]);
        assert_eq!(b["counts"], json!({ "0": 1, "1": 1, "10003": 1 }));
        assert_eq!(b["format"], "ravenvault-nostr-export");
        assert!(!b.to_string().contains("nsec"), "열쇠는 넣지 않는다");
    }

    #[test]
    fn follow_feed_filter_has_no_topic_tag() {
        let f = feed_filter(Some(&[A.to_string()]), Some(500), 50);
        assert!(f.get("#t").is_none() && f["authors"] == json!([A]) && f["until"] == 500);
        let f = feed_filter(None, None, 60);
        assert_eq!(f["#t"], json!(["ravencoin"]));
        let set: HashSet<String> = [A.to_string()].into();
        let top = ev('1', A, 1, 10, json!([]), "다른 앱 글");
        let other_reply = ev('2', A, 1, 10, json!([["e", "c".repeat(64), "", "root"]]), "다른 앱 답글");
        let our_reply = ev('3', A, 1, 10, json!([["e", "c".repeat(64), "", "root"], ["t", "ravencoin"]]), "우리 답글");
        let stranger = ev('4', B, 1, 10, json!([]), "모르는 사람");
        assert!(feed_keep(&top, Some(&set), None));
        assert!(!feed_keep(&other_reply, Some(&set), None));
        assert!(feed_keep(&our_reply, Some(&set), None));
        assert!(!feed_keep(&stranger, Some(&set), None));
        assert!(!feed_keep(&top, None, None), "모두에게는 ravencoin 표 글만");
        assert!(!feed_keep(&our_reply, Some(&set), Some(5)), "until 뒤 글은 버린다");
    }
}
