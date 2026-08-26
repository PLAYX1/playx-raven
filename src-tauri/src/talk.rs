//! 이야기 — **세계와 한 방에서.**
//!
//! ## 무엇을 푸는가
//!
//! 대표님: "지금 텔레그램 방에서 레이븐코인 멤버들과 대화하고 있거든.
//! 이런 식으로 가능했으면 하는데. 전세계 사람들이 원하는 방에서 대화도
//! 가능해야지."
//!
//! 텔레그램과 다른 점은 하나다 — **우리 앱을 안 깔아도 같은 방에 들어온다.**
//! Nostr 의 방(NIP-28)은 표준이라 damus·primal 쓰는 사람도 같은 글을 본다.
//! 우리가 방을 소유하지 않고, 우리가 문을 닫아도 방은 남는다.
//!
//! ## 🔴 왜 RVN 이 필요 없나 — 그게 이 기능의 요점이다
//!
//! 글을 쓰는 데 드는 값이 없다. 열쇠 하나면 되고 그건 공짜다. 지갑도
//! 코인도 필요 없다. **레이븐을 안 쓰는 사람이 그냥 들어와서 말을 한다.**
//!
//! 그러다 「이건 남기고 싶다」 싶을 때 파일창고에 굳히고, 「이건 내 것이다」
//! 싶을 때 자산으로 만든다. **그 순간 처음으로 지갑이 필요해진다.**
//! 문을 좁게 만들어 놓고 들어오라고 하는 것보다 이 순서가 낫다.
//!
//! ## 열쇠는 어디서 오나
//!
//! 12단어에서 뽑는다. 그래서 **씨앗만 있으면 이름도 글도 되살아난다.**
//! 가게 간판 열쇠와는 **다른 값**이다(표식이 다르다) — 간판을 직원에게
//! 맡겨도 내 이름으로 글을 쓰지는 못하게.
//!
//! 씨앗을 못 읽으면(지갑이 잠겼거나 12단어 지갑이 아니면) 무작위로 만들어
//! 파일에 둔다. 그때는 그 파일이 유일한 사본이고, 화면이 그렇게 말한다.

use serde_json::{json, Value};

/// 이름표(NIP-01 kind 0). 이름·한 줄 소개·사진.
///
/// 🔴 이게 없으면 대화 화면에 **16진수 64자**만 뜬다. 텔레그램 방에서
///    이름 대신 지문이 뜨는 셈이라 아무도 안 쓴다. 그리고 이건 표준이라
///    damus·primal 이 우리 이름표를 그대로 읽고, 우리도 그쪽 것을 읽는다.
const KIND_PROFILE: i64 = 0;
/// 사람 글(NIP-01). 세상 모든 Nostr 앱이 이걸 읽는다.
const KIND_NOTE: i64 = 1;
/// 방 만들기 · 방에 쓴 글(NIP-28).
const KIND_ROOM: i64 = 40;
const KIND_ROOM_MSG: i64 = 42;

/// 우리 글에 늘 붙는 표.
///
/// 🔴 이게 있어야 **다른 사람의 릴레이도** 이 글을 레이븐 이야기로 알아본다.
/// 우리 릴레이의 저장 규칙(`relay.rs`)도 이 표를 본다. 안 붙이면 우리가
/// 쓴 글이 우리 릴레이에 안 남는, 웃기는 일이 생긴다.
const TAG: &str = "ravencoin";

fn key_file() -> std::path::PathBuf {
    crate::paths::app_file("talkkey.json")
}

/// 이 사람의 열쇠. 없으면 만든다 — 씨앗에서 먼저 시도한다.
fn key() -> Result<[u8; 32], String> {
    if let Ok(s) = std::fs::read_to_string(key_file()) {
        if let Some(h) = serde_json::from_str::<Value>(&s)
            .ok()
            .and_then(|v| v.get("sk").and_then(Value::as_str).map(str::to_string))
        {
            if let Ok(b) = hex::decode(&h) {
                if b.len() == 32 {
                    let mut sk = [0u8; 32];
                    sk.copy_from_slice(&b);
                    if secp256k1::SecretKey::from_byte_array(&sk).is_ok() {
                        return Ok(sk);
                    }
                }
            }
        }
        // 깨진 파일을 덮어쓰지 않는다. 덮어쓰면 여태 쓴 글이 전부 남의
        // 이름이 되고, 되돌릴 길이 없다.
        return Err("이야기 열쇠 파일이 깨졌습니다. 백업에서 talkkey.json 을 되살려 주세요.".into());
    }

    let (sk, from) = match from_seed() {
        Some(b) => (b, "seed"),
        None => (
            secp256k1::Secp256k1::new()
                .generate_keypair(&mut rand::thread_rng())
                .0
                .secret_bytes(),
            "random",
        ),
    };
    let p = key_file();
    if let Some(d) = p.parent() {
        let _ = std::fs::create_dir_all(d);
    }
    let body = json!({
        "sk": hex::encode(sk),
        "from": from,
        "note": if from == "seed" {
            "이야기 열쇠입니다. 12단어에서 나왔으므로 12단어만 있으면 되살릴 수 있습니다."
        } else {
            "이야기 열쇠입니다. 무작위로 만들었으므로 이 파일이 유일한 사본입니다."
        },
    });
    std::fs::write(&p, serde_json::to_vec_pretty(&body).unwrap_or_default())
        .map_err(|e| format!("이야기 열쇠를 저장하지 못했습니다: {e}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o600));
    }
    Ok(sk)
}

/// ⚠️ 12단어는 **여기서만** 쓰고 어디에도 안 남긴다.
fn from_seed() -> Option<[u8; 32]> {
    let v = tauri::async_runtime::block_on(async {
        crate::raven::call_rpc("getmywords", json!([])).await
    })
    .ok()?;
    let words = v.get("word_list").and_then(Value::as_str)?;
    let pass = v.get("passphrase").and_then(Value::as_str).unwrap_or("");
    crate::shopkey::derive_tagged(crate::shopkey::SEED_TAG_TALK, words, pass)
}

fn now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// 내 이름표(공개키)와 되살릴 수 있는지.
#[tauri::command]
pub fn talk_me() -> Result<Value, String> {
    let sk = key()?;
    let from = std::fs::read_to_string(key_file())
        .ok()
        .and_then(|s| serde_json::from_str::<Value>(&s).ok())
        .and_then(|v| v.get("from").and_then(Value::as_str).map(str::to_string))
        .unwrap_or_else(|| "random".into());
    Ok(json!({
        "pubkey": crate::shopkey::pubkey_of(&sk)?,
        "recoverable": from == "seed",
        "why": if from == "seed" {
            "12단어만 있으면 이 이름을 되살릴 수 있습니다."
        } else {
            "이 이름은 무작위로 만들어졌습니다. 백업 파일이 유일한 사본입니다."
        },
    }))
}

/// 내 이름표를 정한다.
///
/// ⚠️ 이름표에는 **표(`t`)를 안 붙인다.** 이름표는 레이븐 이야기가 아니라
///    「나」다. 표를 붙이면 이야기 목록에 이름표가 섞여 나온다.
#[tauri::command]
pub async fn talk_profile_set(
    name: String,
    about: String,
    picture: String,
) -> Result<Value, String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("이름이 필요합니다.".into());
    }
    if name.chars().count() > 40 {
        return Err("이름이 너무 깁니다. 40자 아래로 줄여 주세요.".into());
    }
    let sk = key()?;
    let body = json!({
        "name": name,
        "about": about.trim(),
        "picture": picture.trim(),
    })
    .to_string();
    let ev = crate::shopkey::sign_with(&sk, KIND_PROFILE, json!([]), &body, now())?;
    crate::nostrpub::nostr_publish(ev.clone()).await?;
    Ok(ev)
}

/// 여러 사람의 이름표를 한 번에 가져온다. `{ 공개키: {name, about, picture} }`.
///
/// 못 찾은 사람은 목록에 없다 — 화면이 그때는 16진수 앞자리를 쓴다.
/// **없는 이름을 지어내지 않는다.**
#[tauri::command]
pub async fn talk_profiles(pubkeys: Vec<String>) -> Result<Value, String> {
    let got = crate::nostrpub::nostr_query_authors(vec![KIND_PROFILE], pubkeys, 60).await?;
    let mut out = serde_json::Map::new();
    for e in got {
        let Some(pk) = e.get("pubkey").and_then(Value::as_str) else {
            continue;
        };
        let body: Value = e
            .get("content")
            .and_then(Value::as_str)
            .and_then(|c| serde_json::from_str(c).ok())
            .unwrap_or(Value::Null);
        let name = body.get("name").and_then(Value::as_str).unwrap_or("").trim();
        if name.is_empty() {
            continue;
        }
        out.insert(
            pk.to_string(),
            json!({
                "name": name.chars().take(40).collect::<String>(),
                "about": body.get("about").and_then(Value::as_str).unwrap_or(""),
                "picture": body.get("picture").and_then(Value::as_str).unwrap_or(""),
            }),
        );
    }
    Ok(Value::Object(out))
}

/// **12단어만으로 어디까지 되살아나는가.**
///
/// 대표님: "레이븐코어에서 쓰던 시드로 모든 게 복구되나? 대화, 상점 등등."
///
/// 답이 갈리는 지점이 하나 있다 — **코어 지갑이 12단어로 만들어졌는가.**
/// 레이븐코어는 12단어로 만든 지갑에만 `getmywords` 를 내준다. 옛날에 그냥
/// 만든 `wallet.dat` 이면 12단어가 아예 없고, 그러면 우리 열쇠들도 씨앗에서
/// 못 나와 무작위가 된다 — 그때는 **백업 파일이 유일한 길**이다.
///
/// 감추지 않고 그대로 보여 준다. 「복구됩니다」라고 해 놓고 안 되는 것이
/// 제일 나쁘다.
#[tauri::command]
pub fn recovery_status() -> Value {
    let words = tauri::async_runtime::block_on(async {
        crate::raven::call_rpc("getmywords", json!([])).await
    });
    // 잠긴 것과 12단어가 없는 것은 **다른 말**이다. 잠긴 것은 열면 되고,
    // 없는 것은 지갑을 새로 만들어 옮겨야 한다. 뭉뚱그리면 안 된다.
    let (seed, seed_why) = match &words {
        Ok(_) => (true, "12단어가 있습니다.".to_string()),
        Err(e) if e.contains("passphrase") || e.contains("잠") => (
            false,
            "지갑이 잠겨 있어 확인하지 못했습니다. 열고 다시 봐 주세요.".into(),
        ),
        Err(_) => (
            false,
            "이 지갑은 12단어로 만들어지지 않았습니다. 그래서 씨앗만으로는 되살릴 수 없습니다."
                .into(),
        ),
    };

    let shop = crate::shopkey::shopkey_origin();
    let talk_from = std::fs::read_to_string(key_file())
        .ok()
        .and_then(|s| serde_json::from_str::<Value>(&s).ok())
        .and_then(|v| v.get("from").and_then(Value::as_str).map(str::to_string));

    json!({
        "seed": seed,
        "seed_why": seed_why,
        "parts": [
            { "what": "지갑 · 돈", "ok": seed,
              "why": "12단어로 만든 지갑이면 어느 기계에서도 같은 주소가 나옵니다." },
            { "what": "가진 자산 · 가게", "ok": true,
              "why": "체인에 있습니다. 지갑이 되살아나면 자산도 같이 보입니다." },
            { "what": "가게 간판 열쇠",
              "ok": shop["recoverable"].as_bool().unwrap_or(false) || !shop["exists"].as_bool().unwrap_or(false),
              "why": shop["why"].as_str().unwrap_or("아직 만들지 않았습니다 — 만들 때 12단어에서 뽑습니다.") },
            { "what": "대화 이름",
              "ok": talk_from.as_deref() != Some("random"),
              "why": match talk_from.as_deref() {
                  Some("seed") => "12단어에서 나왔습니다.",
                  Some(_) => "무작위로 만들어졌습니다. 백업 파일이 유일한 사본입니다.",
                  None => "아직 만들지 않았습니다 — 만들 때 12단어에서 뽑습니다.",
              } },
            { "what": "쓴 글 · 방", "ok": true,
              "why": "릴레이에 있습니다. 이름 열쇠가 되살아나면 내 글로 다시 찾습니다." },
            { "what": "사진 · 메뉴", "ok": true,
              "why": "파일창고에 있습니다. 아무도 안 들고 있으면 찾을 수 없게 되니, 이 컴퓨터가 계속 들고 있습니다." },
        ],
    })
}

/// 글을 쓴다. 방을 지정하면 그 방에, 아니면 모두에게.
#[tauri::command]
pub async fn talk_post(
    text: String,
    room: Option<String>,
    reply_to: Option<String>,
    reply_pub: Option<String>,
) -> Result<Value, String> {
    let text = text.trim().to_string();
    if text.is_empty() {
        return Err("쓸 내용이 없습니다.".into());
    }
    // 32KB 는 우리 릴레이가 받는 한계다. 넘으면 조용히 버려진다 —
    // 보낸 사람은 올라간 줄 안다. 여기서 미리 말한다.
    if text.len() > 8000 {
        return Err("글이 너무 깁니다. 8,000자 아래로 줄여 주세요.".into());
    }
    let sk = key()?;
    // 🔴 답글은 **가리키는 글**이 있어야 대화가 된다(NIP-10).
    //    `e` 는 어느 글에 다는가, `p` 는 누구에게 알리는가다. `p` 가 없으면
    //    상대는 자기 글에 답이 달린 줄 모른다 — 세상 모든 Nostr 앱이
    //    그 태그로 알림을 만든다.
    let (kind, tags) = match (&room, &reply_to) {
        (_, Some(id)) => {
            let mut t = vec![json!(["e", id, "", "reply"]), json!(["t", TAG])];
            if let Some(pk) = &reply_pub {
                t.push(json!(["p", pk]));
            }
            // 방 안의 답글은 방 글이고, 밖의 답글은 그냥 글이다.
            (
                if room.is_some() { KIND_ROOM_MSG } else { KIND_NOTE },
                Value::Array(t),
            )
        }
        (Some(id), None) => (KIND_ROOM_MSG, json!([["e", id, "", "root"], ["t", TAG]])),
        (None, None) => (KIND_NOTE, json!([["t", TAG]])),
    };
    let ev = crate::shopkey::sign_with(&sk, kind, tags, &text, now())?;
    let r = crate::nostrpub::nostr_publish(ev.clone()).await?;
    Ok(json!({ "event": ev, "sent": r }))
}

/// 방을 만든다. 이름과 한 줄 설명만 있으면 된다.
#[tauri::command]
pub async fn talk_make_room(name: String, about: String) -> Result<Value, String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("방 이름이 필요합니다.".into());
    }
    let sk = key()?;
    let body = json!({ "name": name, "about": about.trim() }).to_string();
    let ev = crate::shopkey::sign_with(&sk, KIND_ROOM, json!([["t", TAG]]), &body, now())?;
    crate::nostrpub::nostr_publish(ev.clone()).await?;
    Ok(ev)
}

/// 읽는다. 방을 지정하면 그 방 글, 아니면 레이븐 이야기 전체.
///
/// 🔴 **우리 릴레이만 보지 않는다.** 그러면 우리 컴퓨터에 저장된 것만
///    보이고, 그건 세계와 이어진 것이 아니라 우리 안에서 도는 것이다.
///    공개 릴레이도 같이 물어보고 합친다.
#[tauri::command]
pub async fn talk_read(room: Option<String>, limit: Option<i64>) -> Result<Value, String> {
    let limit = limit.unwrap_or(60).clamp(1, 200);
    let mut list = match &room {
        // 방 글은 그 방을 가리키는 표(`e`)로 찾는다.
        Some(id) => {
            crate::nostrpub::nostr_query_tag(
                vec![KIND_ROOM_MSG],
                "e".into(),
                vec![id.clone()],
                limit,
            )
            .await?
        }
        None => {
            crate::nostrpub::nostr_query_tag(
                vec![KIND_NOTE],
                "t".into(),
                vec![TAG.into()],
                limit,
            )
            .await?
        }
    };

    // 같은 글이 여러 릴레이에서 온다. id 로 하나만 남긴다.
    let mut seen = std::collections::HashSet::new();
    list.retain(|e| {
        e.get("id")
            .and_then(Value::as_str)
            .map(|i| seen.insert(i.to_string()))
            .unwrap_or(false)
    });
    // 최신이 위로.
    list.sort_by_key(|e| -e.get("created_at").and_then(Value::as_i64).unwrap_or(0));
    Ok(json!(list))
}

/// 이 글들에 달린 답글을 한꺼번에 가져온다.
///
/// 🔴 글마다 따로 물으면 스무 번을 왕복한다. 한 번에 여덟 개까지 묶어
///    묻는다 — 릴레이가 받는 한 요청의 값 개수 한도를 넘지 않는 선이다.
#[tauri::command]
pub async fn talk_replies(ids: Vec<String>) -> Result<Value, String> {
    let ids: Vec<String> = ids.into_iter().filter(|s| !s.is_empty()).take(8).collect();
    if ids.is_empty() {
        return Ok(json!({}));
    }
    let got = crate::nostrpub::nostr_query_tag(
        vec![KIND_NOTE, KIND_ROOM_MSG],
        "e".into(),
        ids.clone(),
        100,
    )
    .await?;

    // 어느 글에 달린 것인지로 묶는다.
    let mut out = serde_json::Map::new();
    for e in got {
        let Some(tags) = e.get("tags").and_then(Value::as_array) else {
            continue;
        };
        let Some(parent) = tags
            .iter()
            .find(|t| t.get(0).and_then(Value::as_str) == Some("e"))
            .and_then(|t| t.get(1).and_then(Value::as_str))
        else {
            continue;
        };
        if !ids.iter().any(|i| i == parent) {
            continue;
        }
        out.entry(parent.to_string())
            .or_insert_with(|| json!([]))
            .as_array_mut()
            .map(|a| a.push(e.clone()));
    }
    // 오래된 것이 위로. 답글은 시간 순서가 곧 대화다.
    for (_, v) in out.iter_mut() {
        if let Some(a) = v.as_array_mut() {
            a.sort_by_key(|e| e.get("created_at").and_then(Value::as_i64).unwrap_or(0));
        }
    }
    Ok(Value::Object(out))
}

/// 읽는 사람 말로 옮긴다.
///
/// ## 🔴 왜 화면이 직접 안 부르나 — CORS
///
/// 앱의 출처는 `tauri://localhost` 다. 거기서 `rvn.ex.erci.se` 로 곧장
/// 부르면 브라우저가 **CORS 로 막고**, 화면에는 `TypeError: Load failed`
/// 라는 뜻 모를 글자만 뜬다. 실제로 그렇게 났다.
///
/// 러스트에는 그 규칙이 없다. `nostrpub.rs` 가 릴레이에 올릴 때 같은
/// 이유로 같은 길을 쓴다 — 화면은 부탁하고 나가는 일은 노드가 한다.
#[tauri::command]
pub async fn talk_translate(text: String, to: String) -> Result<Value, String> {
    let body = json!({ "text": text, "to": to });
    let r = reqwest::Client::new()
        .post("https://rvn.ex.erci.se/api/translate")
        .json(&body)
        .timeout(std::time::Duration::from_secs(20))
        .send()
        .await
        .map_err(|e| format!("옮기지 못했습니다: {e}"))?;
    let v: Value = r
        .json()
        .await
        .map_err(|e| format!("답을 읽지 못했습니다: {e}"))?;
    if let Some(t) = v.get("translation").and_then(Value::as_str) {
        return Ok(json!({ "translation": t }));
    }
    Err(v
        .get("error")
        .and_then(Value::as_str)
        .unwrap_or("옮기지 못했습니다")
        .to_string())
}

/// 방 목록. 우리가 만든 것과 남이 만든 것을 같이 본다.
#[tauri::command]
pub async fn talk_rooms() -> Result<Value, String> {
    let got =
        crate::nostrpub::nostr_query_tag(vec![KIND_ROOM], "t".into(), vec![TAG.into()], 50).await?;
    let mut out = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for e in got {
        let Some(id) = e.get("id").and_then(Value::as_str) else {
            continue;
        };
        if !seen.insert(id.to_string()) {
            continue;
        }
        let body: Value = e
            .get("content")
            .and_then(Value::as_str)
            .and_then(|c| serde_json::from_str(c).ok())
            .unwrap_or(Value::Null);
        out.push(json!({
            "id": id,
            "name": body.get("name").and_then(Value::as_str).unwrap_or("이름 없는 방"),
            "about": body.get("about").and_then(Value::as_str).unwrap_or(""),
            "created_at": e.get("created_at"),
        }));
    }
    Ok(json!(out))
}

#[cfg(test)]
mod tests {
    /// 🔴 가게 간판 열쇠와 사람 열쇠가 **같으면 안 된다.** 간판을 직원에게
    ///    맡기는 순간 그 사람이 내 이름으로 글을 쓸 수 있게 된다.
    #[test]
    fn 간판_열쇠와_사람_열쇠는_다르다() {
        let w = "abandon abandon abandon abandon abandon abandon \
                 abandon abandon abandon abandon abandon about";
        let shop = crate::shopkey::derive_tagged("PLAYX-RAVEN-SHOPKEY-v1", w, "");
        let talk = crate::shopkey::derive_tagged(crate::shopkey::SEED_TAG_TALK, w, "");
        assert!(shop.is_some() && talk.is_some(), "둘 다 나와야 한다");
        assert_ne!(shop, talk, "간판 열쇠와 사람 열쇠가 같다");
    }

    /// 같은 12단어면 **언제나 같은 열쇠**여야 한다. 아니면 복구가 안 된다.
    #[test]
    fn 같은_열두단어면_같은_열쇠다() {
        let w = "legal winner thank year wave sausage worth useful legal winner thank yellow";
        let a = crate::shopkey::derive_tagged(crate::shopkey::SEED_TAG_TALK, w, "");
        // 사람이 옮겨 적으면 대문자와 두 칸이 섞인다. 그래도 같아야 한다.
        let b = crate::shopkey::derive_tagged(
            crate::shopkey::SEED_TAG_TALK,
            "  Legal  Winner THANK year wave sausage worth useful legal winner thank yellow ",
            "",
        );
        assert_eq!(a, b, "띄어쓰기나 대소문자가 다르면 열쇠가 달라진다 — 복구가 실패한다");
    }

    /// 우리 릴레이의 저장 규칙이 이 표를 본다. 안 붙이면 **우리가 쓴 글이
    /// 우리 릴레이에 안 남는다.**
    #[test]
    fn 글에는_레이븐_표가_붙는다() {
        let src = include_str!("talk.rs");
        let i = src.find("pub async fn talk_post").expect("쓰는 함수가 있어야 한다");
        let end = src[i..].find("pub async fn talk_make_room").unwrap_or(src.len() - i);
        assert!(
            src[i..i + end].matches("\"t\", TAG").count() >= 2,
            "글에 레이븐 표가 안 붙는다 — 우리 릴레이가 자기 글을 버린다"
        );
    }
}
