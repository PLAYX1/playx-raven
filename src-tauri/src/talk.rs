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

#[cfg(test)]
mod gate_tests {
    /// 시험이 **자기 자신을 세지 않게** 범위를 자른다. 이 저장소에서
    /// 오늘만 네 번 밟은 함정이다.
    fn 코드만() -> &'static str {
        let src = include_str!("talk.rs");
        let end = src.find("#[cfg(test)]").unwrap_or(src.len());
        &src[..end]
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
