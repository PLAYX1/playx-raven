//! 가게 공지 방 — **가게 간판 열쇠가 쓰고, 단골이 끌어와 읽는다**(11-28 · 정본 ravenvault docs/SHOP-ROOMS.md §2).
//!
//! 카카오톡 채널은 가게가 손님에게 보내는 글마다 돈을 받는다. 여기서는 가게가 **자기 열쇠로 서명해 공개 릴레이에 올리는 글**이라
//! 0원이고, 회사 서버가 가게 자료를 쥐지 않는다.
//!
//! ## 형식(폰 core/talk/shop-room.ts 와 같은 바이트 규칙)
//! ```text
//! kind 40  tags [["t","ravencoin"],["t","ravenvault-shop"]]  content {"name","about","shop":1}     ← 가게 간판 열쇠 서명
//! kind 42  tags [["e",<방>,"","root"],["t","ravencoin"],(emoji…),["t","ravenvault-shop"]]           ← 가게 열쇠가 쓴 것만 「공지」
//! ```
//! - 한 가게에 공지 방은 **하나**: 지우지 않은 것 중 가장 먼저 만든 것(링크가 안 바뀐다 · 같은 시각이면 번호 작은 것).
//!   그래서 이미 방이 있으면 「만들기」는 새로 만들지 않고 그 방을 돌려준다.
//! - 공지 = 끌어오기(pull)만. 단골이 자기 폰에서 가게 방을 읽는다. **한꺼번에 쪽지 보내기는 없다.**
//! - 손님 화면은 24시간 안 공지를 5개까지만 펼쳐 보인다(나머지는 접힘). 데스크탑도 하루 5개에서 멈춘다 —
//!   더 올려 봐야 손님 눈에는 접혀 있고, 가게가 도배하는 통로가 되지 않게.
//! - 손님 답 = 방에 쓰지 않는다. 가게 열쇠로 1:1 쪽지(talk_dm.rs 「가게 쪽지」).
//!
//! 🔴 묻기·올리기는 **가게 칸 연결**(relay_pool::LANE_SHOP)로 — 사람 열쇠 물음과 같은 웹소켓에 안 섞인다.
//! 🔴 가게 열쇠가 없으면 만들지 않는다(shopkey::key_on_disk). 비밀값은 화면에 안 나간다 — 공개키·서명된 글만.

use serde_json::{json, Value};

pub(crate) const SHOP_TAG: &str = "ravenvault-shop";
const TALK_TAG: &str = "ravencoin";
const KIND_ROOM: i64 = 40;
const KIND_ROOM_META: i64 = 41;
const KIND_ROOM_MSG: i64 = 42;
/// 손님 화면이 24시간 안에 펼쳐 보이는 공지 수(폰 NOTICES_SHOWN_PER_DAY) — 데스크탑은 여기서 올리기를 멈춘다.
pub(crate) const NOTICES_PER_DAY: usize = 5;
const DAY: i64 = 86_400;
/// 공지 한 장 길이(폰 MESSAGE_MAX).
const NOTICE_MAX: usize = 8000;
const SHARE_ORIGIN: &str = "https://ravenvault.ex.erci.se";

fn hex64(s: &str) -> bool {
    s.len() == 64 && s.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
fn now() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0)
}
fn has_tag(e: &Value, name: &str, value: &str) -> bool {
    e.get("tags").and_then(Value::as_array).is_some_and(|t| {
        t.iter().any(|x| x.get(0).and_then(Value::as_str) == Some(name) && x.get(1).and_then(Value::as_str) == Some(value))
    })
}
fn kind_of(e: &Value) -> i64 {
    e.get("kind").and_then(Value::as_i64).unwrap_or(-1)
}
fn str_of<'a>(e: &'a Value, k: &str) -> &'a str {
    e.get(k).and_then(Value::as_str).unwrap_or("")
}
fn at_of(e: &Value) -> i64 {
    e.get("created_at").and_then(Value::as_i64).unwrap_or(0)
}

/// 가게 지문 — npub 앞 10자…끝 6자(폰 shopFingerprint · 같은 이름 다른 열쇠를 가른다).
pub(crate) fn fingerprint(npub: &str) -> String {
    let c: Vec<char> = npub.chars().collect();
    if c.len() < 20 {
        return String::new();
    }
    format!("{}…{}", c[..10].iter().collect::<String>(), c[c.len() - 6..].iter().collect::<String>())
}

/// 방 만들기(kind 40) 본문과 표. 이름·설명 검사는 일반 방과 같다(talk::clean_room_meta — 줄바꿈·숨은 방향 문자 막기).
pub(crate) fn room_draft(name: &str, about: &str) -> Result<(String, Value), String> {
    let (name, about) = crate::talk::clean_room_meta(name, about)?;
    let body = json!({ "name": name, "about": about, "shop": 1 });
    Ok((body.to_string(), json!([["t", TALK_TAG], ["t", SHOP_TAG]])))
}

/// 이 kind 40 이 이 가게의 공지 방인가(두 표 + 본문 shop:1 + 글쓴이 = 가게).
pub(crate) fn is_shop_room(e: &Value, shop: &str) -> bool {
    kind_of(e) == KIND_ROOM
        && str_of(e, "pubkey") == shop
        && has_tag(e, "t", TALK_TAG)
        && has_tag(e, "t", SHOP_TAG)
        && serde_json::from_str::<Value>(str_of(e, "content")).ok().and_then(|v| v.get("shop").and_then(Value::as_i64)) == Some(1)
}

/// 가게가 지운 글 번호들(kind 5 · 글쓴이 = 가게 · e 표).
fn deleted_by(events: &[Value], shop: &str) -> Vec<String> {
    events
        .iter()
        .filter(|e| kind_of(e) == 5 && str_of(e, "pubkey") == shop)
        .flat_map(|e| e.get("tags").and_then(Value::as_array).cloned().unwrap_or_default())
        .filter(|t| t.get(0).and_then(Value::as_str) == Some("e"))
        .filter_map(|t| t.get(1).and_then(Value::as_str).map(str::to_string))
        .collect()
}

/// 이 가게의 공지 방 하나: 지우지 않은 것 중 가장 먼저 만든 것(같으면 번호 작은 것). 이름·설명은 가게가 쓴 최신 41 이 이긴다.
pub(crate) fn pick_room(events: &[Value], shop: &str) -> Option<Value> {
    let gone = deleted_by(events, shop);
    let first = events
        .iter()
        .filter(|e| is_shop_room(e, shop) && !gone.iter().any(|g| g == str_of(e, "id")))
        .min_by(|a, b| at_of(a).cmp(&at_of(b)).then_with(|| str_of(a, "id").cmp(str_of(b, "id"))))?;
    let id = str_of(first, "id").to_string();
    let body: Value = serde_json::from_str(str_of(first, "content")).unwrap_or(json!({}));
    let mut name = body.get("name").and_then(Value::as_str).unwrap_or("").to_string();
    let mut about = body.get("about").and_then(Value::as_str).unwrap_or("").to_string();
    let limit = now() + 600;
    if let Some(m) = events
        .iter()
        .filter(|e| kind_of(e) == KIND_ROOM_META && str_of(e, "pubkey") == shop && has_tag(e, "e", &id) && at_of(e) <= limit)
        .max_by_key(|e| at_of(e))
    {
        let mb: Value = serde_json::from_str(str_of(m, "content")).unwrap_or(json!({}));
        if let Some(n) = mb.get("name").and_then(Value::as_str).filter(|n| !n.trim().is_empty()) {
            name = n.to_string();
        }
        if let Some(a) = mb.get("about").and_then(Value::as_str) {
            about = a.to_string();
        }
    }
    let name: String = name.chars().filter(|c| !c.is_control()).take(60).collect();
    let about: String = about.chars().filter(|c| !c.is_control()).take(300).collect();
    Some(json!({ "id": id, "name": name.trim(), "about": about.trim(), "created_at": at_of(first) }))
}

/// 방 글이 가리키는 방(root e 표 · 없으면 첫 e 표).
fn root_of(e: &Value) -> Option<String> {
    let tags = e.get("tags").and_then(Value::as_array)?;
    let es: Vec<&Value> = tags.iter().filter(|t| t.get(0).and_then(Value::as_str) == Some("e")).collect();
    let root = es.iter().find(|t| t.get(3).and_then(Value::as_str) == Some("root")).or_else(|| es.first())?;
    root.get(1).and_then(Value::as_str).map(str::to_string)
}

/// 공지만: 방을 만든 가게 열쇠가 그 방에 쓴 42 · 같은 번호 한 번 · 지운 것 빼고 · 새것이 앞.
pub(crate) fn notices_of(events: &[Value], room: &str, shop: &str) -> Vec<Value> {
    let gone = deleted_by(events, shop);
    let mut seen = std::collections::HashSet::new();
    let mut out: Vec<Value> = events
        .iter()
        .filter(|e| kind_of(e) == KIND_ROOM_MSG && str_of(e, "pubkey") == shop && root_of(e).as_deref() == Some(room))
        .filter(|e| !gone.iter().any(|g| g == str_of(e, "id")))
        .filter(|e| seen.insert(str_of(e, "id").to_string()))
        .map(|e| json!({ "id": str_of(e, "id"), "at": at_of(e), "text": str_of(e, "content").chars().take(NOTICE_MAX).collect::<String>() }))
        .collect();
    out.sort_by(|a, b| at_of_v(b).cmp(&at_of_v(a)));
    out
}
fn at_of_v(v: &Value) -> i64 {
    v.get("at").and_then(Value::as_i64).unwrap_or(0)
}

/// 지난 24시간 안 공지 수.
pub(crate) fn recent_count(notices: &[Value], now: i64) -> usize {
    notices.iter().filter(|n| now - at_of_v(n) < DAY).count()
}

/// 공지 표(폰 shopNoticeDraft): 방(root) · ravencoin · 라비 이모티콘(NIP-30) · 가게 표.
pub(crate) fn notice_tags(room: &str, text: &str) -> Value {
    let mut tags = vec![json!(["e", room, "", "root"]), json!(["t", TALK_TAG])];
    tags.extend(crate::talk_dm::sticker_tags(text));
    tags.push(json!(["t", SHOP_TAG]));
    Value::Array(tags)
}

/// 공지에 붙일 수 있는 상품 링크 모양인가(폰 core/talk/product-ref.ts 가 카드로 그리는 것만):
/// `https://ravenvault.ex.erci.se/r/<상품 64 hex>[?d=…&s=…]` · `https://ravenvault.ex.erci.se/g/<문서 CID>`.
pub(crate) fn product_link_ok(raw: &str) -> bool {
    let s = raw.trim();
    if s.len() > 2048 || s.chars().any(char::is_whitespace) {
        return false;
    }
    let Some(rest) = s.strip_prefix(SHARE_ORIGIN) else { return false };
    if let Some(r) = rest.strip_prefix("/r/") {
        let (id, q) = r.split_once('?').unwrap_or((r, ""));
        let id = id.trim_end_matches('/');
        let q_ok = q.is_empty()
            || q.split('&').all(|kv| {
                let (k, v) = kv.split_once('=').unwrap_or((kv, ""));
                (k == "d" || k == "s") && !v.is_empty() && v.len() <= 200 && v.bytes().all(|b| b.is_ascii_alphanumeric() || b"-_.%".contains(&b))
            });
        return hex64(&id.to_ascii_lowercase()) && id.bytes().all(|b| !b.is_ascii_uppercase()) && q_ok;
    }
    if let Some(cid) = rest.strip_prefix("/g/") {
        let cid = cid.trim_end_matches('/');
        let v0 = cid.len() == 46 && cid.starts_with("Qm") && cid.bytes().all(|b| b.is_ascii_alphanumeric() && !matches!(b, b'0' | b'O' | b'I' | b'l'));
        let v1 = cid.len() == 59 && cid.starts_with('b') && cid.bytes().skip(1).all(|b| b.is_ascii_lowercase() || (b'2'..=b'7').contains(&b));
        return v0 || v1;
    }
    false
}

/// 방 초대 링크(desktop src/links.ts inviteLink 와 같다).
pub(crate) fn room_link(id: &str) -> String {
    format!("{SHARE_ORIGIN}/t/{id}")
}

fn shop_key() -> Result<[u8; 32], String> {
    crate::shopkey::key_on_disk().ok_or_else(|| "가게 간판 열쇠가 아직 없어요. 「가게 정보」에서 가게를 먼저 열어 주세요.".to_string())
}

/// 이 가게의 방·공지 글들: 이 컴퓨터 릴레이 저장분 + (local 이 아니면) 바깥(가게 칸 연결).
async fn gather(shop: &str, local: bool) -> (Vec<Value>, bool) {
    let base = vec![
        json!({ "kinds": [KIND_ROOM, KIND_ROOM_META, 5], "authors": [shop], "limit": 100 }),
    ];
    let mut all = crate::relay::query_local(&base);
    let mut reached = true;
    if !local {
        match crate::nostrpub::shop_query(base.clone()).await {
            Ok(mut v) => all.append(&mut v),
            Err(_) => reached = false,
        }
    }
    if let Some(room) = pick_room(&all, shop) {
        let id = room["id"].as_str().unwrap_or("").to_string();
        // 🔴 글쓴이를 가게로 좁혀 묻는다(남이 쓴 글이 최근 글 칸을 밀어내지 못하게 · 폰 shopNoticeFilter).
        let f = vec![json!({ "kinds": [KIND_ROOM_MSG], "authors": [shop], "#e": [id], "limit": 60 })];
        all.extend(crate::relay::query_local(&f));
        if !local {
            match crate::nostrpub::shop_query(f).await {
                Ok(mut v) => all.append(&mut v),
                Err(_) => reached = false,
            }
        }
    }
    // 바깥에서 받은 것은 서명을 본 뒤에만 쓴다(nostrpub 읽기가 이미 보지만, 이 컴퓨터 저장분과 같은 규칙으로 한 번 더).
    all.retain(crate::relay::verify);
    (all, reached)
}

fn view(shop: &str, events: &[Value], reached: bool) -> Value {
    let npub = crate::talk_social::npub_of(shop).unwrap_or_default();
    let room = pick_room(events, shop);
    let notices = room.as_ref().map(|r| notices_of(events, r["id"].as_str().unwrap_or(""), shop)).unwrap_or_default();
    let recent = recent_count(&notices, now());
    let link = room.as_ref().and_then(|r| r["id"].as_str()).map(room_link).unwrap_or_default();
    json!({
        "shop": shop,
        "npub": npub,
        "fingerprint": fingerprint(&npub),
        "room": room,
        "link": link,
        "notices": notices.into_iter().take(30).collect::<Vec<_>>(),
        "recent": recent,
        "per_day": NOTICES_PER_DAY,
        "reached": reached,
    })
}

/// 가게 공지 방 한 판 `{ shop, npub, fingerprint, room|null, link, notices, recent, per_day, reached }` 또는 `{ none: true }`.
#[tauri::command]
pub async fn shop_room_get(local: Option<bool>) -> Result<Value, String> {
    let Some(shop) = crate::shopkey::pubkey_on_disk() else {
        return Ok(json!({ "none": true }));
    };
    let (events, reached) = gather(&shop, local == Some(true)).await;
    Ok(view(&shop, &events, reached))
}

/// 공지 방 만들기. 이미 있으면 새로 만들지 않고 그 방을 돌려준다(`existed: true` — 링크가 안 바뀐다).
#[tauri::command]
pub async fn shop_room_create(name: String, about: String) -> Result<Value, String> {
    let (body, tags) = room_draft(&name, &about)?;
    let mut sk = shop_key()?;
    let shop = crate::shopkey::pubkey_of(&sk)?;
    let (events, _) = gather(&shop, false).await;
    if pick_room(&events, &shop).is_some() {
        crate::words::wipe_bytes(&mut sk);
        let mut v = view(&shop, &events, true);
        v["existed"] = json!(true);
        return Ok(v);
    }
    let ev = crate::shopkey::sign_with(&sk, KIND_ROOM, tags, &body, now());
    crate::words::wipe_bytes(&mut sk);
    let ev = ev?;
    crate::nostrpub::shop_publish(ev.clone()).await?;
    let mut all = events;
    all.push(ev);
    Ok(view(&shop, &all, true))
}

/// 공지 올리기(kind 42 · 가게 열쇠). 24시간 안 5개에서 멈춘다(손님 화면이 그 넘는 것은 접는다).
#[tauri::command]
pub async fn shop_notice_post(text: String) -> Result<Value, String> {
    let text = text.trim().to_string();
    if text.is_empty() {
        return Err("공지에 쓸 말을 적어 주세요.".into());
    }
    if text.chars().count() > NOTICE_MAX {
        return Err("공지가 너무 길어요. 8,000자 아래로 줄여 주세요.".into());
    }
    let mut sk = shop_key()?;
    let shop = crate::shopkey::pubkey_of(&sk)?;
    let (events, _) = gather(&shop, false).await;
    let Some(room) = pick_room(&events, &shop) else {
        crate::words::wipe_bytes(&mut sk);
        return Err("공지 방을 먼저 만들어 주세요.".into());
    };
    let id = room["id"].as_str().unwrap_or("").to_string();
    if recent_count(&notices_of(&events, &id, &shop), now()) >= NOTICES_PER_DAY {
        crate::words::wipe_bytes(&mut sk);
        return Err(format!("공지는 24시간에 {NOTICES_PER_DAY}개까지예요. 더 올리면 손님 화면에서 접혀 보여요. 내일 다시 올려 주세요."));
    }
    let ev = crate::shopkey::sign_with(&sk, KIND_ROOM_MSG, notice_tags(&id, &text), &text, now());
    crate::words::wipe_bytes(&mut sk);
    let ev = ev?;
    crate::nostrpub::shop_publish(ev.clone()).await?;
    let mut all = events;
    all.push(ev);
    Ok(view(&shop, &all, true))
}

/// 공지에 붙일 수 있는 내 상품 링크 — 이 컴퓨터가 올린 오락실 게임(올림 상태)의 공유 링크. 이 컴퓨터 저장분만 본다(바깥에 안 묻는다).
#[tauri::command]
pub fn shop_notice_products() -> Value {
    let Some(pk) = crate::shopkey::key_on_disk().and_then(|sk| crate::shopkey::pubkey_of(&crate::arcade_listing::derive_arcade_key(&sk)).ok()) else {
        return json!({ "items": [] });
    };
    let events = crate::relay::query_local(&[json!({ "kinds": [31405], "authors": [pk], "limit": 200 })]);
    let items: Vec<Value> = crate::arcade_listing::my_open_docs(&events, &pk)
        .into_iter()
        .take(30)
        .map(|(d, cid)| json!({ "label": d, "link": format!("{SHARE_ORIGIN}/g/{cid}") }))
        .collect();
    json!({ "items": items })
}

/// 붙여 넣은 상품 링크 확인(모양만). 맞으면 다듬은 링크, 아니면 Err(사람에게 보일 말).
#[tauri::command]
pub fn shop_notice_check_link(link: String) -> Result<String, String> {
    let l = link.trim().trim_end_matches(['.', ',', ')', '」']).to_string();
    if product_link_ok(&l) {
        Ok(l)
    } else {
        Err("레이븐볼트 상품 공유 링크(ravenvault.ex.erci.se/r/… 또는 /g/…)만 붙일 수 있어요.".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sk(n: u8) -> [u8; 32] {
        let mut b = [5u8; 32];
        b[31] = n;
        b
    }
    fn pk(n: u8) -> String {
        crate::shopkey::pubkey_of(&sk(n)).unwrap()
    }
    fn room_ev(n: u8, name: &str, at: i64) -> Value {
        let (body, tags) = room_draft(name, "동네 빵집").unwrap();
        crate::shopkey::sign_with(&sk(n), KIND_ROOM, tags, &body, at).unwrap()
    }

    #[test]
    fn 방_만들기_모양은_폰_규격과_같다() {
        let e = room_ev(1, "  빵굽는 집 ", now());
        assert!(is_shop_room(&e, &pk(1)));
        assert!(!is_shop_room(&e, &pk(2)), "다른 열쇠가 쓴 것이면 그 가게 방이 아니다");
        let body: Value = serde_json::from_str(e["content"].as_str().unwrap()).unwrap();
        assert_eq!(body, json!({ "name": "빵굽는 집", "about": "동네 빵집", "shop": 1 }));
        assert_eq!(e["tags"], json!([["t", "ravencoin"], ["t", "ravenvault-shop"]]));
        crate::nostrpub::validate_publish_event(&e).expect("relay accepts");
        // 이름 없음·줄바꿈은 막는다.
        assert!(room_draft(" ", "").is_err());
        assert!(room_draft("빵\n집", "").is_err());
        // 가게 표가 없거나 shop:1 이 아니면 일반 방.
        let plain = crate::shopkey::sign_with(&sk(1), KIND_ROOM, json!([["t", "ravencoin"]]), r#"{"name":"a","shop":1}"#, 1).unwrap();
        assert!(!is_shop_room(&plain, &pk(1)));
        let not1 = crate::shopkey::sign_with(&sk(1), KIND_ROOM, json!([["t", "ravencoin"], ["t", SHOP_TAG]]), r#"{"name":"a"}"#, 1).unwrap();
        assert!(!is_shop_room(&not1, &pk(1)));
    }

    #[test]
    fn 가게마다_방은_하나_가장_먼저_만든_것_지운_것_빼고() {
        let a = room_ev(1, "첫 방", 100);
        let b = room_ev(1, "둘째 방", 200);
        let other = room_ev(2, "남의 가게", 50);
        let got = pick_room(&[b.clone(), a.clone(), other.clone()], &pk(1)).unwrap();
        assert_eq!(got["id"], a["id"]);
        assert_eq!(got["name"], "첫 방");
        // 첫 방을 지우면 둘째 방.
        let del = crate::shopkey::sign_with(&sk(1), 5, json!([["e", a["id"]], ["k", "40"]]), "", 300).unwrap();
        assert_eq!(pick_room(&[a.clone(), b.clone(), del.clone()], &pk(1)).unwrap()["id"], b["id"]);
        // 남이 쓴 지우기 요청은 안 친다.
        let fake = crate::shopkey::sign_with(&sk(2), 5, json!([["e", a["id"]]]), "", 300).unwrap();
        assert_eq!(pick_room(&[a.clone(), b.clone(), fake], &pk(1)).unwrap()["id"], a["id"]);
        // 이름 고치기(41)는 가게 것만.
        let meta = crate::shopkey::sign_with(&sk(1), KIND_ROOM_META, json!([["e", a["id"]]]), r#"{"name":"새 이름","about":"새 설명"}"#, 400).unwrap();
        let fake_meta = crate::shopkey::sign_with(&sk(2), KIND_ROOM_META, json!([["e", a["id"]]]), r#"{"name":"사칭"}"#, 500).unwrap();
        let r = pick_room(&[a.clone(), meta, fake_meta], &pk(1)).unwrap();
        assert_eq!((r["name"].as_str(), r["about"].as_str()), (Some("새 이름"), Some("새 설명")));
        assert!(pick_room(&[other], &pk(1)).is_none());
    }

    #[test]
    fn 공지는_가게가_그_방에_쓴_것만_하루_5개() {
        let room = room_ev(1, "빵집", 100);
        let id = room["id"].as_str().unwrap();
        let t = now();
        let notice = |n: u8, text: &str, at: i64| crate::shopkey::sign_with(&sk(n), KIND_ROOM_MSG, notice_tags(id, text), text, at).unwrap();
        let mine: Vec<Value> = (0..5).map(|i| notice(1, &format!("공지 {i} :ravi_hello:"), t - 100 * i)).collect();
        let spam = notice(2, "사기 글", t);
        let old = notice(1, "옛 공지", t - 2 * DAY);
        let mut all = vec![room.clone(), spam, old];
        all.extend(mine.iter().cloned());
        let got = notices_of(&all, id, &pk(1));
        assert_eq!(got.len(), 6, "남이 쓴 글은 공지가 아니다");
        assert_eq!(got[0]["text"], "공지 0 :ravi_hello:", "새것이 앞");
        assert_eq!(recent_count(&got, t), 5);
        // 표 모양: 방 root · ravencoin · emoji · 가게 표(마지막).
        let tags = mine[0]["tags"].as_array().unwrap();
        assert_eq!(tags[0], json!(["e", id, "", "root"]));
        assert_eq!(tags[1], json!(["t", "ravencoin"]));
        assert_eq!(tags.last().unwrap(), &json!(["t", SHOP_TAG]));
        assert!(tags.iter().any(|x| x[0] == "emoji"));
        crate::nostrpub::validate_publish_event(&mine[0]).expect("relay accepts");
        // 지운 공지는 빠진다.
        let del = crate::shopkey::sign_with(&sk(1), 5, json!([["e", mine[0]["id"]]]), "", t).unwrap();
        all.push(del);
        assert_eq!(notices_of(&all, id, &pk(1)).len(), 5);
    }

    #[test]
    fn 상품_링크_모양() {
        let h = "a".repeat(64);
        assert!(product_link_ok(&format!("https://ravenvault.ex.erci.se/r/{h}")));
        assert!(product_link_ok(&format!("https://ravenvault.ex.erci.se/r/{h}?d=abc&s=x1")));
        assert!(!product_link_ok(&format!("https://ravenvault.ex.erci.se/r/{h}?evil=1")));
        assert!(!product_link_ok(&format!("https://ravenvault.ex.erci.se/r/{}", "A".repeat(64))));
        assert!(!product_link_ok(&format!("https://evil.example/r/{h}")));
        assert!(!product_link_ok(&format!("https://ravenvault.ex.erci.se.evil.io/r/{h}")));
        assert!(product_link_ok("https://ravenvault.ex.erci.se/g/QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG"));
        assert!(!product_link_ok("https://ravenvault.ex.erci.se/g/nope"));
        assert!(!product_link_ok("https://ravenvault.ex.erci.se/t/abc"));
        assert_eq!(room_link(&h), format!("https://ravenvault.ex.erci.se/t/{h}"));
        assert_eq!(fingerprint("npub1abcdefghijklmnopqrstuvwxyz0123456789"), "npub1abcde…456789");
        assert_eq!(fingerprint("short"), "");
    }
}
