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

pub(crate) fn key_file() -> std::path::PathBuf {
    crate::paths::app_file("talkkey.json")
}

/// 이 사람의 열쇠. 없으면 만든다 — 씨앗에서 먼저 시도한다.
///
/// # 🔴 순서가 곧 「그 사람이 사라지지 않는다」이다
///
/// **파일이 있으면 파일이 이긴다.** 파일에 든 열쇠가 12단어에서 나온 것이든
/// 무작위든, 새 방식이든 옛 방식이든 상관없이 그대로 쓴다.
///
/// 이 앱은 예전에 열쇠를 **우리만 아는 방식**(`SEED_TAG_TALK` 표식 해시)으로
/// 뽑았다. 지금은 표준 경로(`identity::PATH_PERSON`)로 뽑는다. 둘은 다른
/// 값이다. 그런데 옛 이름으로 쓴 글이 **세계 릴레이에 이미 남아 있다.**
/// 여기서 「새 방식이 옳으니 갈아 끼우자」를 하면 그 사람이 그 순간
/// 사라진다 — 쓴 글도, 받은 쪽지도 전부 남의 것이 된다.
///
/// 그래서 **자동으로는 절대 안 바꾼다.** 바꾸는 길은 사장이 눌러야 하는
/// `identity_adopt_person_key` 하나뿐이고, 그때 옛 열쇠는 지우지 않고
/// 「이 글도 나다」를 양쪽 열쇠로 서명해 릴레이에 남긴다.
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
        // 🔴 **어디서 나온 열쇠인지 파일에 적는다.** 이게 없으면 나중에
        //    이 열쇠가 옛 방식인지 표준 경로인지 알 길이 없고, 그러면
        //    화면이 「폰과 같은 사람입니다」를 정직하게 말할 수 없다.
        "path": if from == "seed" { crate::identity::PATH_PERSON } else { "random" },
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

/// 12단어에서 **사람 열쇠**를 뽑는다 — 표준 경로 `m/44'/175'/7'/0/0`.
///
/// 🔴 예전에는 여기서 `SEED_TAG_TALK` 표식 해시를 썼다. 그 값은 웹 지갑과
///    **다른 사람**이었다 — 같은 12단어를 넣어도 폰의 나와 데스크톱의 나가
///    달랐다. 이제 웹이 쓰던 자리에 맞춘다(`identity.rs` 의 경로표).
///
/// ⚠️ 이 바꿈은 **새로 만드는 열쇠에만** 닿는다. 위 `key()` 가 파일을 먼저
///    보기 때문에, 이미 이름이 있는 사람은 아무 일도 일어나지 않는다.
///
/// ⚠️ 12단어는 `identity.rs` 안에서만 쓰이고 어디에도 안 남는다.
fn from_seed() -> Option<[u8; 32]> {
    crate::identity::person_key()
}

// 옛 방식(표식 해시)으로 뽑은 이야기 열쇠는 `identity::both_keys_async` 가
// 만든다. 여기 두면 12단어를 두 번 물어보게 되고, async 자리에서 부를 수도
// 없다(`block_on` 은 런타임 위에서 터진다).

/// 이 파일에 적힌 열쇠. **만들지 않는다** — 없으면 `None`.
///
/// 상태를 보여 주는 자리에서 쓴다. 「지금 어떤 상태인가」를 물었을 뿐인데
/// 열쇠가 새로 생기면, 묻는 것만으로 사람이 하나 태어나는 셈이다.
pub(crate) fn key_on_disk() -> Option<([u8; 32], String, String)> {
    let s = std::fs::read_to_string(key_file()).ok()?;
    let v: Value = serde_json::from_str(&s).ok()?;
    let b = hex::decode(v.get("sk").and_then(Value::as_str)?).ok()?;
    if b.len() != 32 {
        return None;
    }
    let mut sk = [0u8; 32];
    sk.copy_from_slice(&b);
    secp256k1::SecretKey::from_byte_array(&sk).ok()?;
    Some((
        sk,
        v.get("from").and_then(Value::as_str).unwrap_or("random").to_string(),
        v.get("path").and_then(Value::as_str).unwrap_or("").to_string(),
    ))
}

/// 이야기 열쇠를 갈아 끼운다. **옛 파일은 지우지 않고 옆에 남긴다.**
///
/// 🔴 `talkkey-old-<시각>.json` 으로 이름만 바꾼다. 지운 것은 못 되돌리고,
///    그 파일이 그 사람의 유일한 사본일 수도 있다.
pub(crate) fn install_key(sk: &[u8; 32], from: &str, path: &str) -> Result<String, String> {
    let p = key_file();
    if p.exists() {
        let stamp = now();
        let kept = p.with_file_name(format!("talkkey-old-{stamp}.json"));
        std::fs::rename(&p, &kept)
            .map_err(|e| format!("옛 이야기 열쇠를 옆에 남기지 못했습니다. 그래서 아무것도 바꾸지 않았습니다: {e}"))?;
    }
    if let Some(d) = p.parent() {
        let _ = std::fs::create_dir_all(d);
    }
    let body = json!({
        "sk": hex::encode(sk),
        "from": from,
        "path": path,
        "note": "이야기 열쇠입니다. 12단어에서 나왔으므로 12단어만 있으면 되살릴 수 있습니다.",
    });
    std::fs::write(&p, serde_json::to_vec_pretty(&body).unwrap_or_default())
        .map_err(|e| format!("이야기 열쇠를 저장하지 못했습니다: {e}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o600));
    }
    crate::shopkey::pubkey_of(sk)
}

/// 우리 글에 붙는 표. `identity.rs` 가 「이 글도 나다」에 같은 표를 붙인다 —
/// 안 붙이면 **우리 릴레이가 그 글을 안 남긴다**(`relay.rs` 의 저장 규칙).
pub(crate) const TALK_TAG: &str = TAG;
pub(crate) const TALK_KIND_PROFILE: i64 = KIND_PROFILE;
pub(crate) const TALK_KIND_NOTE: i64 = KIND_NOTE;
pub(crate) const TALK_KIND_ROOM_MSG: i64 = KIND_ROOM_MSG;

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
    let path = key_on_disk().map(|(_, _, p)| p).unwrap_or_default();
    Ok(json!({
        "pubkey": crate::shopkey::pubkey_of(&sk)?,
        "recoverable": from == "seed",
        "path": path,
        // 🔴 「같은 사람인가」를 여기서도 말한다. 이름표만 보여 주면 폰의
        //    이름과 다르다는 것을 사장이 알 길이 없다.
        "same_as_wallet": path == crate::identity::PATH_PERSON,
        "why": if from != "seed" {
            "이 이름은 무작위로 만들어졌습니다. 백업 파일이 유일한 사본입니다."
        } else if path == crate::identity::PATH_PERSON {
            "12단어만 있으면 이 이름을 되살릴 수 있습니다. 폰·웹 지갑과 같은 이름입니다."
        } else {
            "12단어만 있으면 이 이름을 되살릴 수 있습니다. 다만 옛 방식이라 폰·웹 지갑에서는 다른 이름으로 보입니다."
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
    // 🔴 **자산 방이면 가진 사람만 쓴다.**
    //
    //    ⚠️ 모를 때는 막지 않는다. 노드가 장부를 다시 훑는 중이면
    //       `listmyassets` 가 답을 못 하는데, 그때 막으면 **자기 방에
    //       자기가 못 쓴다.** 재색인은 며칠 걸리기도 한다.
    //       모르는 것을 「없다」로 치는 것이 이 앱에서 오늘만 여러 번 낸 사고다.
    if let Some(id) = &room {
        if let Some(a) = room_asset(id).await {
            let (has, unknown) = hold_state(&a).await;
            if !has && unknown.is_none() {
                return Err(format!(
                    "이 방은 {a} 을(를) 가진 분들의 방입니다. 아직 갖고 계시지 않습니다."
                ));
            }
        }
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

/// 사진 한 장의 크기 한계.
///
/// ## 🔴 왜 8MB 인가 — 우리 디스크 걱정이 아니라 **받는 사람 걱정**이다
///
/// 파일창고에 올린 사진은 처음에 **이 컴퓨터 한 곳에만** 있다. 상대는 그물을
/// 뒤져 우리 컴퓨터를 찾아내 받아 간다. 집 인터넷의 올리는 속도, 공유기를
/// 뚫는 시간까지 더하면 실제로 나가는 속도는 초당 몇백 KB다. 8MB 면 그것만도
/// 십수 초에서 1분이다. 더 크면 상대 화면에서는 「느린 사진」이 아니라
/// **끝내 안 뜨는 사진**이 된다 — 그리고 보낸 사람은 보낸 줄 안다.
///
/// 8MB 는 요즘 폰 사진을 거의 다 담는다(아이폰·갤럭시가 내놓는 JPEG·HEIC 이
/// 보통 2~6MB). 그래서 **사진은 되고 영상은 안 되는** 선이 여기다. 영상은
/// 이 길로 나르면 안 된다 — 그건 다른 문제고 다르게 풀어야 한다.
const PHOTO_MAX: usize = 8 * 1024 * 1024;

/// 사진에 붙이는 글의 한계. 릴레이가 받는 크기(32KB)를 넘기지 않는 선이다.
const PHOTO_TEXT_MAX: usize = 2000;

/// 이름(확장자)으로 보는 검사.
///
/// ⚠️ 이건 **이름만** 본다. 이름은 누구나 바꿀 수 있으니 이것만 믿으면 안 된다 —
///    안을 보는 검사(`sniff`)와 **둘 다** 통과해야 보낸다.
///
/// SVG 는 일부러 뺐다. 그림 파일처럼 보이지만 안에 스크립트를 품을 수 있어서,
/// 여는 쪽 화면에서 그게 돈다. 사진을 주고받자고 그 문을 열 이유가 없다.
fn ext_kind(name: &str) -> Option<&'static str> {
    if !name.contains('.') {
        return None;
    }
    let ext = name.rsplit('.').next().unwrap_or("").to_ascii_lowercase();
    match ext.as_str() {
        "jpg" | "jpeg" => Some("image/jpeg"),
        "png" => Some("image/png"),
        "gif" => Some("image/gif"),
        "webp" => Some("image/webp"),
        "heic" | "heif" => Some("image/heic"),
        "avif" => Some("image/avif"),
        _ => None,
    }
}

/// 안(첫 몇 바이트)을 보는 검사.
///
/// 🔴 이게 없으면 `트로이목마.exe` 를 `사진.jpg` 로 바꿔 놓은 것이 그대로
///    파일창고에 올라가고, 그건 **공개고 지울 수 없다.**
///
/// ⚠️ 한계도 적어 둔다: 우리는 **앞머리만** 본다. 앞은 진짜 JPEG 이고 뒤에
///    다른 것을 붙여 놓은 파일은 이 검사로 못 가른다. 다만 우리는 그걸
///    실행하지 않고 그림으로만 보여 주므로, 실용적인 선은 여기다.
fn sniff(b: &[u8]) -> Option<&'static str> {
    // 12바이트도 안 되면 어떤 사진도 아니다. 아래에서 b[4..12] 를 보므로
    // 이 검사가 자리 넘침도 같이 막는다.
    if b.len() < 12 {
        return None;
    }
    if b.starts_with(&[0xFF, 0xD8, 0xFF]) {
        return Some("image/jpeg");
    }
    if b.starts_with(&[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A]) {
        return Some("image/png");
    }
    if b.starts_with(b"GIF87a") || b.starts_with(b"GIF89a") {
        return Some("image/gif");
    }
    // RIFF 는 WAV·AVI 도 쓰는 껍데기다. 8번째부터 WEBP 라고 적혀 있어야 사진이다.
    if &b[0..4] == b"RIFF" && &b[8..12] == b"WEBP" {
        return Some("image/webp");
    }
    // HEIC·AVIF 는 ISO 상자 형식이라 4번째부터 ftyp, 그다음이 종류다.
    if &b[4..8] == b"ftyp" {
        return match &b[8..12] {
            b"heic" | b"heix" | b"hevc" | b"hevx" | b"heim" | b"heis" | b"hevm" | b"hevs"
            | b"mif1" | b"msf1" => Some("image/heic"),
            b"avif" | b"avis" => Some("image/avif"),
            _ => None,
        };
    }
    None
}

/// 사람이 읽는 크기.
fn human_size(n: usize) -> String {
    if n >= 1024 * 1024 {
        format!("{:.1}MB", n as f64 / (1024.0 * 1024.0))
    } else {
        format!("{}KB", n / 1024)
    }
}

/// 이 파일을 사진으로 받아도 되나. 되면 **안을 보고 알아낸** 종류를 돌려준다.
///
/// 오류 문구는 전부 「무엇을 하면 되는지」까지 적는다. "거부되었습니다" 만
/// 뜨면 사장은 사진 보내기를 포기하고 다시 안 온다.
fn photo_kind(name: &str, bytes: &[u8]) -> Result<&'static str, String> {
    if bytes.is_empty() {
        return Err("빈 파일입니다. 사진을 다시 골라 주세요.".into());
    }
    if bytes.len() > PHOTO_MAX {
        return Err(format!(
            "사진이 너무 큽니다({}). {}MB 까지만 보낼 수 있습니다.\n\
             이 사진은 우리 컴퓨터에서만 나가기 때문에, 이보다 크면 받는 분 화면에서 \
             끝내 안 뜹니다. 사진 크기를 줄여서 다시 보내 주세요.",
            human_size(bytes.len()),
            PHOTO_MAX / (1024 * 1024),
        ));
    }
    // 🔴 이름과 안을 **둘 다** 본다. 하나만 보면 이름을 바꾼 실행 파일이 지나간다.
    if ext_kind(name).is_none() {
        return Err(format!(
            "사진만 보낼 수 있습니다. 보낼 수 있는 것: JPG · PNG · GIF · WEBP · HEIC · AVIF.\n\
             고르신 것: {name}"
        ));
    }
    let by_bytes = sniff(bytes).ok_or_else(|| {
        "사진 파일이 아닙니다. 이름은 사진인데 안은 다른 파일이라 보내지 않았습니다.".to_string()
    })?;
    // 이름과 안이 어긋날 수 있다(.jpg 인데 실제로는 PNG). 흔하고 해롭지도 않으니
    // 막지 않는다 — 다만 **안을 믿는다.** 상대 화면에 넘길 종류는 내용에서 나온 것이다.
    Ok(by_bytes)
}

/// 파일창고에 올릴 때 쓸 이름. 사람이 지은 이름을 그대로 믿지 않는다.
///
/// `/` 가 들어 있으면 파일창고 안에 엉뚱한 폴더가 생기고, 줄바꿈이 들어 있으면
/// 올리는 형식 자체가 깨진다.
fn safe_name(name: &str) -> String {
    // 글자를 문자열로 적어 둔다(`'"'` 같은 홑따옴표 글자로 안 쓴다). 아래 시험의
    // 주석 거르개가 홑따옴표 글자를 못 알아보기 때문이다 — 거기 따옴표가 하나
    // 끼면 그 뒤 주석이 안 걸러진다.
    const BAD: &str = "/\\\"";
    let cleaned: String = name
        .chars()
        .map(|c| if c.is_control() || BAD.contains(c) { '_' } else { c })
        .collect();
    let cleaned = cleaned.trim().to_string();
    if cleaned.is_empty() {
        return "photo".into();
    }
    cleaned.chars().take(80).collect()
}

/// **사진 한 장을 방에 올린다.**
///
/// ## 왜 이게 있어야 하나
///
/// 자문(2026-08): "사진·파일은 이 세대(40~70대) 대화의 본문입니다.
/// 메뉴·영수증·「이거요」를 못 보내면 첫 방문이 마지막입니다."
///
/// 글만 되는 대화방은 이 나이대에게는 **빈 방**이다. 「이거 얼마예요」가
/// 사진 한 장이고 「여기로 오세요」도 사진 한 장이다.
///
/// ## 어떻게 나르나
///
/// 사진 자체는 릴레이에 안 넣는다. 릴레이는 **글**을 나르지 사진을 보관하지
/// 않고, 우리 릴레이는 32KB 에서 자른다 — 넣으면 조용히 버려지고 보낸 사람은
/// 보낸 줄 안다. 그래서 사진은 파일창고(IPFS)에 두고 **글에는 주소만** 넣는다.
///
/// Nostr 관례 그대로다: 본문에 URL 한 줄, `imeta` 태그(NIP-92)에 종류·크기·
/// 지문. 그러면 damus·primal 같은 남의 앱도 이 사진을 그려 준다.
/// 우리 앱만 아는 `ipfs` 태그를 하나 더 붙여서, 우리 화면은 남의 게이트웨이
/// 대신 **이 컴퓨터의 파일창고**에서 곧장 그린다.
///
/// ## 🔴 못 하는 것을 못 한다고 말한다
///
/// 올린 사진은 처음에 **이 컴퓨터 한 곳에만** 있다. 아직 아무도 사본을 안
/// 가졌으면, 이 컴퓨터를 끄는 순간 상대 화면에서 사진이 안 뜬다.
/// 「보냈습니다」로 끝내면 그건 거짓말이다. 그래서 응답에 `say` 를 담아
/// **화면이 그 말을 그대로 띄우게** 한다.
///
/// ## 사진은 어디서 오나 — 두 길뿐이다
///
/// - `path`: 창에 **떨어뜨린** 파일. 아무 경로나 받으면 화면이 뚫리는 날
///   `wallet.dat` 이 공개 파일창고로 올라간다. 그래서 러스트가 들고 있는
///   「방금 떨어뜨린 목록」에 있는 것만 읽는다(`dropbox.rs`).
/// - `name` + `bytes`: 화면의 사진 고르기가 읽어 준 내용. 이건 애초에
///   경로가 아니라 내용이라 남의 파일을 가리킬 수가 없다.
#[tauri::command]
pub async fn talk_photo_post(
    path: Option<String>,
    name: Option<String>,
    bytes: Option<Vec<u8>>,
    text: Option<String>,
    room: Option<String>,
    reply_to: Option<String>,
    reply_pub: Option<String>,
) -> Result<Value, String> {
    let text = text.unwrap_or_default().trim().to_string();
    if text.chars().count() > PHOTO_TEXT_MAX {
        return Err(format!(
            "사진에 붙이는 글이 너무 깁니다. {PHOTO_TEXT_MAX}자 아래로 줄여 주세요."
        ));
    }

    // 1) 사진을 가져온다.
    let (fname, raw) = match (path, bytes) {
        (Some(p), _) => {
            if !crate::dropbox::was_dropped(&p) {
                return Err(
                    "이 파일은 창에 떨어뜨린 것이 아닙니다. 사진을 창에 끌어다 놓거나 \
                     「사진 고르기」로 골라 주세요."
                        .into(),
                );
            }
            let pb = std::path::Path::new(&p);
            let n = pb
                .file_name()
                .map(|s| s.to_string_lossy().to_string())
                .unwrap_or_else(|| "photo".into());
            let b = std::fs::read(pb).map_err(|e| format!("사진을 읽지 못했습니다: {e}"))?;
            (n, b)
        }
        (None, Some(b)) => (name.unwrap_or_else(|| "photo".into()), b),
        (None, None) => return Err("보낼 사진이 없습니다.".into()),
    };

    // 2) 사진인가 · 크기가 되나. **올리기 전에** 본다 — 파일창고는 공개고,
    //    한 번 올라간 것은 되물릴 수 없다.
    let mime = photo_kind(&fname, &raw)?;

    // 3) 🔴 **자산 방이면 가진 사람만 쓴다** — 이것도 올리기 전에 본다.
    //    올린 다음에 막으면, 아무도 못 볼 사진만 파일창고에 남는다.
    //
    //    ⚠️ 모를 때는 막지 않는다. 노드가 장부를 다시 훑는 중이면
    //       `listmyassets` 가 답을 못 하는데, 그때 막으면 자기 방에 자기가
    //       사진을 못 올린다. 재색인은 며칠 걸리기도 한다.
    if let Some(id) = &room {
        if let Some(a) = room_asset(id).await {
            let (has, unknown) = hold_state(&a).await;
            if !has && unknown.is_none() {
                return Err(format!(
                    "이 방은 {a} 을(를) 가진 분들의 방입니다. 아직 갖고 계시지 않습니다."
                ));
            }
        }
    }

    // 4) 🔴 **파일창고가 꺼져 있으면 여기서 멈춘다.** 켜져 있는 줄 알고
    //    올리기를 시도하면 「IPFS에 올리지 못했습니다: connection refused」
    //    라는, 사장에게 아무것도 안 알려 주는 글자가 뜬다.
    let status = crate::ipfs::ipfs_status().await.unwrap_or(json!({ "running": false }));
    if !status.get("running").and_then(Value::as_bool).unwrap_or(false) {
        return Err(
            "사진을 둘 파일창고가 꺼져 있습니다. 「켜기」를 눌러 파일창고를 켠 다음 \
             다시 보내 주세요. 글은 지금도 보낼 수 있습니다."
                .into(),
        );
    }
    // 켜져 있어도 **아무와도 안 이어져 있으면** 밖에서는 못 받는다. 막지는
    // 않는다 — 방금 켰을 수도 있다. 대신 아래에서 그대로 말한다.
    let peers = status.get("peers").and_then(Value::as_i64);

    // 5) 파일창고에 올린다. 지문은 올리기 전에 낸다 — `Incoming` 이 내용을 가져간다.
    use sha2::Digest as _;
    let sha = hex::encode(sha2::Sha256::digest(&raw));
    let size = raw.len();
    let added = crate::upload::ipfs_add_file(crate::upload::Incoming {
        // 🔴 파일 이름은 파일창고까지만 간다. 글에는 **안 적는다** —
        //    「김무송_통장사본.jpg」 같은 이름이 세상 모든 릴레이에 남으면 안 된다.
        name: safe_name(&fname),
        bytes: raw,
    })
    .await?;
    let cid = added
        .get("cid")
        .and_then(Value::as_str)
        .ok_or_else(|| "파일창고가 사진 주소를 안 돌려줬습니다.".to_string())?
        .to_string();

    // 6) 글을 만든다.
    //
    // 본문에 넣는 주소는 **공개 게이트웨이**다. 우리 집 주소(127.0.0.1)를
    // 적으면 남의 화면에서는 자기 컴퓨터를 가리키게 되어 아무것도 안 뜬다.
    // 우리 화면은 아래 `ipfs` 태그를 보고 집 주소로 바꿔 그린다.
    let gateway = format!("https://ipfs.io/ipfs/{cid}");
    let content = if text.is_empty() {
        gateway.clone()
    } else {
        format!("{text}\n{gateway}")
    };

    let sk = key()?;
    // imeta(NIP-92)는 한 태그 안에 「열쇠 값」을 띄어쓰기로 잇는다.
    // 이게 있어야 남의 앱이 사진인 줄 알고 접어서 그린다.
    let imeta = json!([
        "imeta",
        format!("url {gateway}"),
        format!("m {mime}"),
        format!("x {sha}"),
        format!("size {size}"),
    ]);
    let (kind, tags) = match (&room, &reply_to) {
        (_, Some(id)) => {
            let mut t = vec![
                json!(["e", id, "", "reply"]),
                json!(["t", TAG]),
                imeta,
                json!(["ipfs", cid]),
            ];
            if let Some(pk) = &reply_pub {
                t.push(json!(["p", pk]));
            }
            (
                if room.is_some() { KIND_ROOM_MSG } else { KIND_NOTE },
                Value::Array(t),
            )
        }
        (Some(id), None) => (
            KIND_ROOM_MSG,
            json!([["e", id, "", "root"], ["t", TAG], imeta, ["ipfs", cid]]),
        ),
        (None, None) => (KIND_NOTE, json!([["t", TAG], imeta, ["ipfs", cid]])),
    };

    let ev = crate::shopkey::sign_with(&sk, kind, tags, &content, now())?;
    // 사진은 이미 올라갔는데 글만 실패할 수 있다. 그때 주소를 안 알려 주면
    // 사장은 올린 사진을 영영 못 찾는다 — 지운 것도 아닌데.
    let sent = crate::nostrpub::nostr_publish(ev.clone())
        .await
        .map_err(|e| format!("사진은 올라갔는데({cid}) 글을 못 보냈습니다: {e}"))?;

    // 7) 🔴 **되는 척하지 않는다.** 이 말을 화면이 그대로 띄워야 한다.
    let say = if peers == Some(0) {
        "사진을 올렸습니다. 다만 지금 이 컴퓨터가 파일창고 그물에 아무와도 이어져 \
         있지 않아, 밖에 계신 분은 이 사진을 못 받습니다. 잠시 뒤 다시 확인해 주세요."
    } else {
        "사진은 지금 이 컴퓨터가 들고 있습니다. 다른 곳에 사본이 생기기 전까지는, \
         이 컴퓨터를 끄면 상대가 사진을 못 볼 수 있습니다."
    };

    Ok(json!({
        "event": ev,
        "sent": sent,
        "cid": cid,
        "mime": mime,
        "size": size,
        "sha256": sha,
        // 우리 화면은 이걸 쓴다. 남의 게이트웨이를 거치지 않으니 빠르고,
        // 우리가 무슨 사진을 보는지 바깥에 알리지도 않는다.
        "local_url": format!("http://127.0.0.1:8080/ipfs/{cid}"),
        "url": gateway,
        "peers": peers,
        "say": say,
    }))
}

/// 내가 가진 자산 이름들. 방을 만들 때 고르게 하려고 준다.
///
/// 🔴 **하나도 없으면 그렇다고 말한다.** 목록을 비워 두면 사장은 「고장났나」
///    하고 기다린다. 자산이 없다는 것과 못 읽었다는 것도 갈라서 말한다.
/// 내가 쓴 글을 **지워 달라고 요청한다.**
///
/// 🔴 이름이 「삭제」가 아니라 **「지우기 요청」**인 이유가 전부다.
///
/// Nostr 에서 글을 지우는 방법은 kind 5 를 올리는 것뿐인데, 그건 **부탁**이지
/// 명령이 아니다. **릴레이가 따를 의무가 없다.** 세계에 흩어진 릴레이 중
/// 몇 곳은 따르고 몇 곳은 무시한다. 이미 받아 본 사람의 화면에도 남는다.
///
/// ⚠️ 그런데 오타나 전화번호를 잘못 쓴 사람에게는 **거둘 길이 있어야 한다.**
///    그래서 단추는 만들되 **되는 척하지 않는다:**
///
/// ```text
/// 「삭제」        →  지워졌다고 믿는다. 안 지워졌는데
/// 「지우기 요청」  →  부탁했다는 것을 안다. 사실이다
/// ```
///
/// 보낸 뒤에도 화면에서 글을 없애거나 「삭제된 메시지」로 바꾸지 않는다.
/// **「지우기 요청함」**으로 둔다 — 되는 척하지 않는 쪽이 신뢰다.
#[tauri::command]
pub async fn talk_delete_request(id: String) -> Result<Value, String> {
    if id.len() != 64 || !id.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err("글 번호가 올바르지 않습니다.".into());
    }
    let sk = key()?;
    // kind 5 = 지움 요청. `e` 태그로 어느 글인지 가리킨다(NIP-09).
    let tags = json!([["e", id]]);
    let ev = crate::shopkey::sign_with(&sk, 5, tags, "", now())?;
    crate::nostrpub::nostr_publish(ev).await?;
    Ok(json!({
        "ok": true,
        // 🔴 이 말을 화면이 그대로 띄워야 한다.
        "say": "지워 달라고 요청했습니다. 따르는 릴레이에서는 사라지지만, \
이미 본 사람의 화면과 따르지 않는 릴레이에는 남을 수 있습니다.",
    }))
}

#[tauri::command]
pub async fn talk_my_assets() -> Value {
    match crate::raven::call_rpc("listmyassets", json!([])).await {
        Ok(v) => {
            let mut names: Vec<String> = v
                .as_object()
                .map(|o| o.keys().cloned().collect())
                .unwrap_or_default();
            names.sort();
            json!({ "ok": true, "assets": names })
        }
        // 노드가 아직 안 따라잡았거나 꺼져 있으면 못 읽는다. **없다고 하지 않는다.**
        Err(e) => json!({ "ok": false, "why": e, "assets": [] }),
    }
}

/// 그 방이 자산을 요구하나. 요구하면 그 이름.
async fn room_asset(room_id: &str) -> Option<String> {
    let rooms = talk_rooms().await.ok()?;
    rooms
        .as_array()?
        .iter()
        .find(|r| r.get("id").and_then(Value::as_str) == Some(room_id))?
        .get("asset")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .map(String::from)
}

/// 내가 그 자산을 가졌나.
///
/// ## 🔴 모르면 「없다」가 아니라 「모른다」다
///
/// 노드가 장부를 다시 훑는 중이면 `listmyassets` 가 답을 못 한다. 그때
/// 「없습니다」라고 막으면, **자기 방에 자기가 못 들어간다.** 재색인은
/// 며칠 걸리기도 한다 — 그동안 가게 방이 통째로 닫히는 것이다.
///
/// 그래서 셋으로 나눈다: 가졌다 / 없다 / 아직 모른다.
async fn hold_state(asset: &str) -> (bool, Option<String>) {
    match crate::raven::call_rpc("listmyassets", json!([asset])).await {
        Ok(v) => {
            let has = v
                .as_object()
                .map(|o| o.values().any(|x| x.as_f64().unwrap_or(0.0) > 0.0))
                .unwrap_or(false);
            (has, None)
        }
        Err(e) => (false, Some(e)),
    }
}

/// 방을 만든다. 자산을 걸면 **그것을 가진 사람만** 쓰는 방이 된다.
///
/// ## 🔴 왜 이게 레이븐이라서 되는가
///
/// 텔레그램은 「초대받은 사람」까지만 안다. 우리는 **「지금 이 자산을 가진
/// 사람」**을 안다 — 넘기면 그 순간 끊긴다. 관리자가 추방하는 게 아니라
/// **합의가 정한다.** 푸시 서버도 방장도 필요 없다.
///
/// 그록 실측 지적(2026-08-27): "가게 자산 210억 개를 팔로우 토큰으로 찍어
/// 놓고 방에 안 물렸다. 남이 베낄 수 없는 기능은 이미 노드 안에 있고,
/// 방과 장터에만 안 연결돼 있다."
///
/// ## ⚠️ 우리가 강제할 수 있는 범위를 넘겨 말하지 않는다
///
/// 우리 앱과 우리 릴레이는 이 규칙을 지킨다. 그러나 damus·nos.lol 같은
/// 공개 릴레이는 우리 규칙을 모른다 — **다른 프로그램으로는 쓸 수 있다.**
/// 그러니 이건 「비밀방」이 아니라 **「단골 방」**이다. 화면에도 그렇게 적는다.
/// 비밀이 필요하면 그건 암호(E2EE)의 일이지 자산의 일이 아니다.
#[tauri::command]
pub async fn talk_make_room(
    name: String,
    about: String,
    asset: Option<String>,
) -> Result<Value, String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("방 이름이 필요합니다.".into());
    }
    let asset = asset.map(|a| a.trim().to_uppercase()).filter(|a| !a.is_empty());
    // 🔴 **내가 못 가진 자산으로 방을 만들지 않는다.** 만들어 놓고 자기가
    //    못 들어가는 방이 된다. 모를 때는 막지 않고 그대로 진행한다 —
    //    노드가 훑는 중일 뿐일 수 있고, 그때 막으면 아무것도 못 만든다.
    if let Some(a) = &asset {
        let (has, unknown) = hold_state(a).await;
        if !has && unknown.is_none() {
            return Err(format!(
                "{a} 을(를) 갖고 계시지 않습니다. 자기가 못 들어가는 방이 됩니다."
            ));
        }
    }
    let sk = key()?;
    let body = json!({
        "name": name,
        "about": about.trim(),
        // 방 정보 안에도 넣는다 — 태그를 못 읽는 프로그램도 볼 수 있게.
        "asset": asset.clone().unwrap_or_default(),
    })
    .to_string();
    let mut tags = vec![json!(["t", TAG])];
    if let Some(a) = &asset {
        tags.push(json!(["asset", a]));
    }
    let ev = crate::shopkey::sign_with(&sk, KIND_ROOM, json!(tags), &body, now())?;
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
        // 🔴 자산을 **두 곳에서** 찾는다. 태그가 규격이고 본문은 받침이다 —
        //    태그만 보면 옛 프로그램이 만든 방을 못 읽고, 본문만 보면
        //    태그로 거르는 릴레이에서 안 걸린다.
        let asset = e
            .get("tags")
            .and_then(Value::as_array)
            .and_then(|ts| {
                ts.iter().find_map(|t| {
                    let a = t.as_array()?;
                    (a.first()?.as_str()? == "asset").then(|| a.get(1)?.as_str())?
                })
            })
            .or_else(|| body.get("asset").and_then(Value::as_str))
            .unwrap_or("")
            .to_string();
        out.push(json!({
            "id": id,
            "name": body.get("name").and_then(Value::as_str).unwrap_or("이름 없는 방"),
            "about": body.get("about").and_then(Value::as_str).unwrap_or(""),
            "asset": asset,
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

    // ─────────────────────────────────────────────────────────────────
    // 사진 보내기
    // ─────────────────────────────────────────────────────────────────

    /// 진짜 사진들의 앞머리. 시험에서 「진짜」로 쓰는 것들이다.
    fn 사진들() -> Vec<(&'static str, Vec<u8>, &'static str)> {
        let 채우기 = |mut v: Vec<u8>| {
            v.resize(64, 0);
            v
        };
        vec![
            ("밥.jpg", 채우기(vec![0xFF, 0xD8, 0xFF, 0xE0]), "image/jpeg"),
            (
                "메뉴.PNG",
                채우기(vec![0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A]),
                "image/png",
            ),
            ("웃김.gif", 채우기(b"GIF89a....".to_vec()), "image/gif"),
            (
                "간판.webp",
                채우기(b"RIFF\x40\x00\x00\x00WEBP".to_vec()),
                "image/webp",
            ),
            (
                "폰사진.heic",
                채우기(b"\x00\x00\x00\x18ftypheic".to_vec()),
                "image/heic",
            ),
            (
                "새것.avif",
                채우기(b"\x00\x00\x00\x1cftypavif".to_vec()),
                "image/avif",
            ),
        ]
    }

    /// 🔴 **좋은 입력이 통과하는지 먼저 본다.** 막는 것만 시험하면, 아무것도
    ///    안 통과시키는 검사가 만점을 받는다 — 이 저장소에서 실제로 낸 사고다.
    #[test]
    fn 진짜_사진은_통과한다() {
        for (이름, 내용, 종류) in 사진들() {
            let r = super::photo_kind(이름, &내용);
            assert_eq!(r, Ok(종류), "{이름} 이 막혔다 — 사진을 못 보낸다");
        }
    }

    /// 🔴 이름만 사진인 실행 파일. 이게 지나가면 파일창고에 남고 지울 수 없다.
    #[test]
    fn 이름만_바꾼_실행파일은_잡힌다() {
        let 실행파일들: Vec<(&str, Vec<u8>)> = vec![
            ("사진.jpg", b"\xcf\xfa\xed\xfe\x0c\x00\x00\x01\x00\x00\x00\x00".to_vec()), // 맥
            ("사진.png", b"\x7fELF\x02\x01\x01\x00\x00\x00\x00\x00".to_vec()),          // 리눅스
            ("사진.jpeg", b"MZ\x90\x00\x03\x00\x00\x00\x04\x00\x00\x00".to_vec()),      // 윈도우
            ("사진.gif", b"#!/bin/sh\nrm -rf /\n".to_vec()),                            // 스크립트
            ("사진.webp", b"RIFF\x40\x00\x00\x00WAVEfmt ".to_vec()),                    // 소리 파일
            ("사진.png", b"PK\x03\x04\x14\x00\x00\x00\x08\x00\x00\x00".to_vec()),       // 압축 파일
        ];
        for (이름, 내용) in 실행파일들 {
            assert!(
                super::photo_kind(이름, &내용).is_err(),
                "{이름} 이 사진으로 지나갔다 — 실행 파일이 오간다"
            );
        }
    }

    /// 안은 진짜 사진이어도 **이름이 사진이 아니면** 안 받는다.
    /// 앞은 JPEG 이고 뒤에 딴것을 붙인 파일이 `.command` 로 내려가면 실행된다.
    #[test]
    fn 이름이_사진이_아니면_잡힌다() {
        let 진짜 = {
            let mut v = vec![0xFF, 0xD8, 0xFF, 0xE0];
            v.resize(64, 0);
            v
        };
        for 이름 in ["사진.exe", "사진.sh", "사진.command", "사진.svg", "사진", "사진.jpg.exe"] {
            assert!(
                super::photo_kind(이름, &진짜).is_err(),
                "{이름} 이 지나갔다"
            );
        }
        // ⚠️ 되받아 확인: 같은 내용을 사진 이름으로 주면 **통과해야** 한다.
        //    아니면 위 시험은 「전부 막는 검사」를 칭찬하고 있는 것이다.
        assert!(super::photo_kind("사진.jpg", &진짜).is_ok());
    }

    /// 크기. 한 바이트 차이로 갈리는지까지 본다.
    #[test]
    fn 큰_사진은_잡히고_딱_맞는_것은_통과한다() {
        let 만들기 = |n: usize| {
            let mut v = vec![0xFF, 0xD8, 0xFF, 0xE0];
            v.resize(n, 0);
            v
        };
        assert!(super::photo_kind("큰.jpg", &만들기(super::PHOTO_MAX)).is_ok(), "딱 맞는 것이 막혔다");
        let e = super::photo_kind("큰.jpg", &만들기(super::PHOTO_MAX + 1)).unwrap_err();
        assert!(e.contains("너무 큽니다"), "큰 사진이 지나갔다: {e}");
        // 왜 안 되는지까지 말해야 한다. "거부" 만 뜨면 사장은 그냥 포기한다.
        assert!(e.contains("줄여서"), "무엇을 하면 되는지 안 알려 준다: {e}");
    }

    /// 빈 파일과 너무 짧은 파일. 여기서 자리 넘침이 나면 앱이 죽는다.
    #[test]
    fn 빈_파일과_짧은_파일은_잡힌다() {
        assert!(super::photo_kind("사진.jpg", b"").is_err());
        assert!(super::photo_kind("사진.jpg", b"\xFF\xD8\xFF").is_err(), "12바이트도 안 되는 것이 지나갔다");
        // 자리 넘침이 안 나는지도 본다 — 아래 길이들이 sniff 안의 b[4..12] 를 밟는다.
        for n in 0..16usize {
            let _ = super::sniff(&vec![0u8; n]);
        }
    }

    /// 파일 이름은 파일창고까지만 간다. 폴더를 만들거나 형식을 깨면 안 된다.
    #[test]
    fn 파일_이름을_그대로_믿지_않는다() {
        assert_eq!(super::safe_name("../../wallet.dat"), ".._.._wallet.dat");
        assert_eq!(super::safe_name("사\n진.jpg"), "사_진.jpg");
        assert_eq!(super::safe_name("   "), "photo");
        assert!(super::safe_name(&"가".repeat(300)).chars().count() <= 80);
    }

    /// 우리 릴레이의 저장 규칙이 이 표를 본다. 안 붙이면 **우리가 쓴 글이
    /// 우리 릴레이에 안 남는다.**
    #[test]
    fn 글에는_레이븐_표가_붙는다() {
        let src = include_str!("talk.rs");
        let i = src.find("pub async fn talk_post").expect("쓰는 함수가 있어야 한다");
        // 🔴 범위를 **talk_post 하나**로 자른다. 예전에는 「다음 함수 이름」으로
        //    잘랐는데, 그 사이에 다른 함수(사진 보내기)를 넣자 그 함수의 표까지
        //    같이 세게 됐다 — talk_post 가 표를 안 붙여도 통과하는 시험이 된다.
        let end = src[i..].find("\n#[tauri::command]").unwrap_or(src.len() - i);
        assert!(
            src[i..i + end].matches("\"t\", TAG").count() >= 2,
            "글에 레이븐 표가 안 붙는다 — 우리 릴레이가 자기 글을 버린다"
        );
    }
}

#[cfg(test)]
mod gate_tests {
    /// 시험이 **자기 자신을 세지 않게** 범위를 자른다. 이 저장소에서
    /// 오늘만 네 번 밟은 함정이다.
    fn 코드만() -> &'static str {
        let src = include_str!("talk.rs");
        let end = src.find("#[cfg(test)]").unwrap_or(src.len());
        &src[..end]
    }

    /// 주석을 걷어 낸 코드.
    ///
    /// ## 🔴 왜 이게 필요한가 — 이 저장소에서 여러 번 밟은 함정
    ///
    /// 아래 시험들은 「코드에 이 검사가 있는가」를 글자로 찾는다. 그런데 우리는
    /// **주석을 아주 길게 쓴다.** 주석에 「크기를 본다」라고 적어 놓기만 하고
    /// 실제로 안 보는 코드가, 시험을 통과한다. 시험이 자기 주석을 잡는 것이다.
    ///
    /// ⚠️ 반대 함정도 같이 막는다: 주소 안의 `//`(`https://…`)를 주석 시작으로
    ///    오해하면 코드가 통째로 날아가고, 그러면 **아무 시험도 아무것도 못 찾아**
    ///    엉뚱하게 실패한다. 그래서 문자열 안은 건드리지 않는다.
    ///
    /// ⚠️ 홑따옴표 글자(`'"'` 같은 것)는 안 다룬다 — `&'static str` 의 `'` 와
    ///    구별하려면 러스트 문법을 다 알아야 한다. 대신 코드 쪽에서 그런 글자를
    ///    안 쓰기로 했고, 아래 `홑따옴표_따옴표를_안_쓴다` 가 그것을 지킨다.
    fn 주석빼기(src: &str) -> String {
        let b: Vec<char> = src.chars().collect();
        let mut out = String::with_capacity(src.len());
        let (mut 한줄, mut 여러줄, mut 문자열) = (false, false, false);
        let mut i = 0;
        while i < b.len() {
            let c = b[i];
            let n = b.get(i + 1).copied().unwrap_or('\0');
            if 한줄 {
                if c == '\n' {
                    한줄 = false;
                    out.push(c);
                }
                i += 1;
            } else if 여러줄 {
                if c == '*' && n == '/' {
                    여러줄 = false;
                    i += 2;
                } else {
                    i += 1;
                }
            } else if 문자열 {
                // 문자열 안에서는 어떤 것도 주석이 아니다. 역슬래시로 escape 한
                // 따옴표를 닫는 따옴표로 세면 그 뒤가 통째로 어긋난다.
                if c == '\\' {
                    out.push(c);
                    if i + 1 < b.len() {
                        out.push(n);
                    }
                    i += 2;
                    continue;
                }
                if c == '"' {
                    문자열 = false;
                }
                out.push(c);
                i += 1;
            } else if c == '/' && n == '/' {
                한줄 = true;
                i += 2;
            } else if c == '/' && n == '*' {
                여러줄 = true;
                i += 2;
            } else {
                if c == '"' {
                    문자열 = true;
                }
                out.push(c);
                i += 1;
            }
        }
        out
    }

    fn 주석뺀_코드() -> String {
        주석빼기(코드만())
    }

    /// 🔴 **거르개부터 일부러 깨뜨려 본다.** 거르개가 고장 나면 아래 시험들이
    ///    전부 거짓으로 통과하거나 전부 거짓으로 실패한다.
    #[test]
    fn 주석_거르개가_제대로_거른다() {
        // (1) 주석은 없어져야 한다 — 안 없어지면 시험이 자기 주석을 잡는다.
        let s = 주석빼기("let a = 1; // 여기서 PHOTO_MAX 를 본다\nlet b = 2;\n");
        assert!(!s.contains("PHOTO_MAX"), "주석을 못 걸렀다 — 시험이 주석을 잡는다");
        assert!(s.contains("let b = 2;"), "주석 뒤 코드까지 지웠다");

        // (2) 문자열 안의 // 는 주석이 아니다 — 이걸 틀리면 주소가 사라진다.
        let s = 주석빼기("let u = \"https://ipfs.io/ipfs/Qm\"; let v = 3;");
        assert!(s.contains("https://ipfs.io/ipfs/Qm"), "주소 안의 // 를 주석으로 봤다");
        assert!(s.contains("let v = 3;"), "주소 뒤 코드가 날아갔다");

        // (3) 여러 줄 주석과 escape 한 따옴표.
        assert!(!주석빼기("/* 숨김 */ let a = 1;").contains("숨김"));
        let s = 주석빼기("let a = \"따옴표 \\\" 안\"; // 지움\n");
        assert!(s.contains("따옴표"), "escape 한 따옴표에서 어긋났다");
        assert!(!s.contains("지움"), "escape 한 따옴표 뒤 주석을 못 걸렀다");
    }

    /// 거르개가 못 다루는 글자를 코드가 안 쓰는지 본다. 하나만 끼어도 그 뒤
    /// 주석이 통째로 안 걸러진다.
    #[test]
    fn 홑따옴표_따옴표를_안_쓴다() {
        let 코드 = 주석뺀_코드();
        assert!(
            !코드.contains("'\"'"),
            "홑따옴표로 감싼 따옴표를 쓰고 있다 — 주석 거르개가 그 뒤로 어긋난다"
        );
    }

    /// 사진 보내기 함수의 몸통(주석 뺀 것).
    fn 사진_함수() -> String {
        let 코드 = 주석뺀_코드();
        let i = 코드
            .find("pub async fn talk_photo_post")
            .expect("사진 보내는 함수가 있어야 한다");
        let 뒤 = &코드[i..];
        let end = 뒤.find("\n#[tauri::command]").unwrap_or(뒤.len());
        뒤[..end].to_string()
    }

    /// 🔴 **사진인지 이름과 안을 둘 다 본다.** 하나만 보면 실행 파일이 오간다.
    #[test]
    fn 사진인지_이름과_안을_둘_다_본다() {
        let f = 사진_함수();
        assert!(f.contains("photo_kind"), "사진인지 안 보고 올리고 있다");
        let 검사 = {
            let 코드 = 주석뺀_코드();
            let i = 코드.find("fn photo_kind").expect("검사 함수가 있어야 한다");
            코드[i..].to_string()
        };
        assert!(검사.contains("ext_kind"), "이름(확장자)을 안 보고 있다");
        assert!(검사.contains("sniff"), "안(매직 바이트)을 안 보고 있다");
        assert!(검사.contains("PHOTO_MAX"), "크기를 안 보고 있다");
    }

    /// 🔴 **검사는 전부 올리기 전에.** 파일창고는 공개고 한 번 올라간 것은
    ///    되물릴 수 없다. 올린 뒤에 막으면 아무도 못 볼 사진만 남는다.
    #[test]
    fn 검사가_모두_올리기_전에_있다() {
        let f = 사진_함수();
        let 올림 = f.find("ipfs_add_file").expect("파일창고에 올리는 곳이 있어야 한다");
        for (무엇, 글자) in [
            ("사진인지", "photo_kind"),
            ("방에 쓸 수 있는지", "hold_state"),
            ("파일창고가 켜져 있는지", "ipfs_status"),
        ] {
            let i = f.find(글자).unwrap_or_else(|| panic!("{무엇} 을 안 보고 있다"));
            assert!(i < 올림, "{무엇} 를 올린 다음에 보고 있다");
        }
    }

    /// 🔴 **파일창고가 꺼져 있으면 「켜세요」라고 말한다.** 그냥 올리려 들면
    ///    connection refused 라는, 사장에게 아무것도 안 알려 주는 글자가 뜬다.
    #[test]
    fn 파일창고가_꺼졌으면_켜라고_말한다() {
        let f = 사진_함수();
        assert!(f.contains("꺼져 있습니다"), "꺼진 것을 말하지 않는다");
        assert!(f.contains("켜"), "켜라고 말하지 않는다");
    }

    /// 🔴 **되는 척하지 않는다.** 올린 사진은 처음에 이 컴퓨터 한 곳에만 있다.
    ///    「보냈습니다」로 끝내면 그건 거짓말이고, 사장은 사진이 안 뜨는 이유를
    ///    영영 모른다.
    #[test]
    fn 사라질_수_있다고_말한다() {
        let f = 사진_함수();
        assert!(
            f.contains("사본이 생기기 전까지"),
            "이 컴퓨터를 끄면 안 보일 수 있다는 말을 응답에 안 담고 있다"
        );
        assert!(f.contains("\"say\""), "화면이 띄울 말을 안 돌려주고 있다");
        // 이어진 곳이 없으면 밖에서는 아예 못 받는다. 그것도 갈라서 말한다.
        assert!(f.contains("peers"), "몇 곳과 이어져 있는지 안 보고 있다");
    }

    /// 아무 경로나 읽어 주면 화면이 뚫리는 날 `wallet.dat` 이 공개 파일창고로
    /// 올라간다. 거기서는 지울 수가 없다.
    #[test]
    fn 아무_경로나_안_읽는다() {
        let f = 사진_함수();
        assert!(
            f.contains("was_dropped"),
            "떨어뜨린 파일인지 안 보고 경로를 읽고 있다"
        );
    }

    /// 파일 이름은 파일창고까지만. 글(릴레이)에는 안 적는다 —
    /// 「김무송_통장사본.jpg」 같은 이름이 세상에 남으면 안 된다.
    #[test]
    fn 파일_이름을_글에_안_적는다() {
        let f = 사진_함수();
        let i = f.find("let content").expect("글 본문을 만드는 곳이 있어야 한다");
        let 본문 = &f[i..f[i..].find("sign_with").map(|e| i + e).unwrap_or(f.len())];
        assert!(!본문.contains("fname"), "파일 이름을 글 본문에 적고 있다");
    }

    /// 🔴 **모르는 것을 「없다」로 치면 자기 방에 자기가 못 들어간다.**
    ///    노드가 장부를 다시 훑는 중이면 `listmyassets` 가 답을 못 한다.
    ///    재색인은 며칠 걸리기도 한다 — 그동안 가게 방이 통째로 닫힌다.
    #[test]
    fn 모를_때는_막지_않는다() {
        let src = 코드만();
        let i = src.find("pub async fn talk_post").expect("쓰는 함수가 있어야 한다");
        let end = src[i..].find("\n#[tauri::command]").unwrap_or(src.len() - i);
        let body = &src[i..i + end];
        assert!(
            body.contains("unknown.is_none()"),
            "확인 못 했을 때도 막고 있다 — 노드가 훑는 동안 자기 방에 자기가 못 쓴다"
        );
    }

    /// 자기가 못 가진 자산으로 방을 만들면 **자기가 못 들어가는 방**이 된다.
    #[test]
    fn 못_가진_자산으로_방을_안_만든다() {
        let src = 코드만();
        let i = src.find("pub async fn talk_make_room").expect("만드는 함수가 있어야 한다");
        assert!(
            src[i..].contains("hold_state"),
            "방을 만들 때 보유를 안 보고 있다"
        );
    }

    /// 🔴 방 정보를 **태그와 본문 둘 다**에 넣는다. 태그가 규격이고 본문은
    ///    받침이다 — 한쪽만 두면 다른 프로그램이 못 읽는 자리가 생긴다.
    #[test]
    fn 자산을_태그와_본문_둘_다에_적는다() {
        let src = 코드만();
        let i = src.find("pub async fn talk_make_room").expect("있어야 한다");
        let seg = &src[i..];
        assert!(seg.contains(r#"json!(["asset", a])"#), "태그에 안 적고 있다");
        assert!(seg.contains(r#""asset": asset"#), "본문에 안 적고 있다");
    }

    /// ⚠️ 자산 방은 **비밀방이 아니다.** 공개 릴레이는 우리 규칙을 모른다.
    ///    「비밀」이라고 적으면 사람이 비밀인 줄 알고 비밀을 쓴다.
    #[test]
    fn 비밀방이라고_말하지_않는다() {
        let src = 코드만();
        let i = src.find("pub async fn talk_make_room").expect("있어야 한다");
        // 주석에 그 한계를 적어 뒀는지 본다. 안 적으면 다음 사람이 넓혀 쓴다.
        let head = &src[i.saturating_sub(2200)..i];
        assert!(
            head.contains("공개 릴레이는 우리 규칙을 모른다"),
            "우리가 강제 못 하는 범위를 안 적고 있다"
        );
    }
}
