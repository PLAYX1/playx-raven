//! Optional AI help for filling in forms.
//!
//! Filling a shop profile in four languages, or typing a menu item by item, is
//! the part people give up on. So this exists — but it is help, never a
//! decision: every field it produces lands in an input the owner can see and
//! edit, and nothing is issued, burned, or sent from here.
//!
//! ## Keys belong to the user
//!
//! We ship no API key and pay for no calls. The owner brings their own, it is
//! stored on this machine with owner-only permissions, and it is sent to the
//! provider they chose and nowhere else.
//!
//! ## This is the one thing in the app that leaves the machine
//!
//! Everything else talks to 127.0.0.1. When AI help is used, the text typed
//! into the box goes to Anthropic or OpenAI. The UI has to say so before the
//! first call, because a wallet that quietly ships data to a third party has
//! broken a promise the rest of the app makes.

use serde_json::{json, Value};
use std::path::PathBuf;

fn config_dir() -> PathBuf {
    crate::paths::app_dir()
}

fn key_path(provider: &str) -> PathBuf {
    config_dir().join(format!("{provider}.key"))
}

fn known(p: &str) -> bool {
    matches!(
        p,
        "anthropic" | "openai" | "google" | "groq" | "xai" | "custom"
    )
}

/// Providers that speak OpenAI's `/chat/completions`, with a sensible default
/// model. Adding one is a table entry, not a new code path — which is why Groq
/// and xAI cost almost nothing to support and why the custom slot stays free
/// for whatever comes next.
fn openai_compat(provider: &str) -> Option<(&'static str, &'static str)> {
    match provider {
        "openai" => Some(("https://api.openai.com/v1", DEFAULT_OPENAI)),
        "groq" => Some(("https://api.groq.com/openai/v1", DEFAULT_GROQ)),
        "xai" => Some(("https://api.x.ai/v1", DEFAULT_XAI)),
        _ => None,
    }
}

// Defaults, not constants of the universe. Providers retire model names on
// their own schedule — Google killed gemini-2.0-flash out from under a working
// install, and 3.6 was superseded by 3.7 within weeks — so these are a starting
// point and the owner overrides any of them in Settings without waiting for us
// to ship a new version. That override box is the actual fix; this line is just
// what a fresh install starts with.
const DEFAULT_ANTHROPIC: &str = "claude-sonnet-5";
const DEFAULT_OPENAI: &str = "gpt-4o";
const DEFAULT_GOOGLE: &str = "gemini-3.7-flash";
const DEFAULT_GROQ: &str = "openai/gpt-oss-120b";
const DEFAULT_XAI: &str = "grok-4";

pub fn default_model(provider: &str) -> &'static str {
    match provider {
        "anthropic" => DEFAULT_ANTHROPIC,
        "openai" => DEFAULT_OPENAI,
        "google" => DEFAULT_GOOGLE,
        "groq" => DEFAULT_GROQ,
        "xai" => DEFAULT_XAI,
        _ => "",
    }
}

/// The model this provider should use: whatever the owner set, else our default.
fn model_for(provider: &str) -> String {
    std::fs::read_to_string(config_dir().join("models.json"))
        .ok()
        .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
        .and_then(|v| {
            v.get(provider)
                .and_then(Value::as_str)
                .filter(|s| !s.trim().is_empty())
                .map(str::to_string)
        })
        .unwrap_or_else(|| default_model(provider).to_string())
}

/// Which model each provider is set to, with the defaults filled in.
#[tauri::command]
pub fn model_settings() -> Value {
    let mut out = serde_json::Map::new();
    for p in ["anthropic", "openai", "google", "groq", "xai"] {
        out.insert(
            p.to_string(),
            json!({ "model": model_for(p), "default": default_model(p) }),
        );
    }
    Value::Object(out)
}

/// Overrides the model for one provider. Empty restores the default.
#[tauri::command]
pub fn save_model(provider: String, model: String) -> Result<(), String> {
    if !known(&provider) {
        return Err("알 수 없는 제공자입니다.".into());
    }
    let dir = config_dir();
    std::fs::create_dir_all(&dir).map_err(|e| format!("설정 폴더를 만들지 못했습니다: {e}"))?;
    let path = dir.join("models.json");

    let mut doc = std::fs::read_to_string(&path)
        .ok()
        .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
        .unwrap_or_else(|| json!({}));

    if let Some(obj) = doc.as_object_mut() {
        if model.trim().is_empty() {
            obj.remove(&provider);
        } else {
            obj.insert(provider, json!(model.trim()));
        }
    }
    std::fs::write(&path, serde_json::to_vec_pretty(&doc).map_err(|e| e.to_string())?)
        .map_err(|e| format!("저장하지 못했습니다: {e}"))
}

/// Forgets a stored key.
///
/// Separate from saving an empty string: "I am done with this provider" is a
/// deliberate action and deserves its own button, not a side effect of
/// clearing a text box.
#[tauri::command]
pub fn delete_api_key(provider: String) -> Result<(), String> {
    if !known(&provider) {
        return Err("알 수 없는 제공자입니다.".into());
    }
    let _ = std::fs::remove_file(key_path(&provider));
    if provider == "custom" {
        let _ = std::fs::remove_file(config_dir().join("custom.json"));
    }
    Ok(())
}

/// Stores an API key with owner-only permissions.
#[tauri::command]
pub fn save_api_key(provider: String, key: String) -> Result<(), String> {
    if !known(&provider) {
        return Err("알 수 없는 제공자입니다.".into());
    }
    let dir = config_dir();
    std::fs::create_dir_all(&dir).map_err(|e| format!("설정 폴더를 만들지 못했습니다: {e}"))?;

    let path = key_path(&provider);
    if key.trim().is_empty() {
        let _ = std::fs::remove_file(&path);
        return Ok(());
    }
    std::fs::write(&path, key.trim()).map_err(|e| format!("키를 저장하지 못했습니다: {e}"))?;

    // 0600. The default would let every account on this machine read it, and on
    // a shop counter PC that is not a theoretical concern.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
    }
    Ok(())
}

/// Which providers have a key stored. Never returns the keys themselves.
#[tauri::command]
pub fn api_key_status() -> Value {
    json!({
        "anthropic": key_path("anthropic").exists(),
        "openai": key_path("openai").exists(),
        "google": key_path("google").exists(),
        "groq": key_path("groq").exists(),
        "xai": key_path("xai").exists(),
        "custom": custom_config().is_some(),
        "custom_label": custom_config().map(|c| c.0).unwrap_or_default(),
    })
}

/// Where a custom OpenAI-compatible endpoint lives: (label, base_url, model).
///
/// xAI, DeepSeek, Groq, Together and a locally-run Ollama all speak the same
/// `/chat/completions` shape, so one setting covers every one of them — and an
/// owner who runs Ollama on this machine gets AI help with nothing leaving the
/// building at all.
fn custom_config() -> Option<(String, String, String)> {
    let raw = std::fs::read_to_string(config_dir().join("custom.json")).ok()?;
    let v: Value = serde_json::from_str(&raw).ok()?;
    Some((
        v.get("label")?.as_str()?.to_string(),
        v.get("base_url")?.as_str()?.to_string(),
        v.get("model")?.as_str()?.to_string(),
    ))
}

/// Saves a custom OpenAI-compatible endpoint.
#[tauri::command]
pub fn save_custom_provider(
    label: String,
    base_url: String,
    model: String,
    key: String,
) -> Result<(), String> {
    let dir = config_dir();
    std::fs::create_dir_all(&dir).map_err(|e| format!("설정 폴더를 만들지 못했습니다: {e}"))?;

    if base_url.trim().is_empty() {
        let _ = std::fs::remove_file(dir.join("custom.json"));
        let _ = std::fs::remove_file(key_path("custom"));
        return Ok(());
    }
    // Trailing slashes turn into "//chat/completions", which some servers 404 on.
    let base = base_url.trim().trim_end_matches('/').to_string();

    let doc = json!({
        "label": if label.trim().is_empty() { base.clone() } else { label.trim().to_string() },
        "base_url": base,
        "model": model.trim(),
    });
    std::fs::write(
        dir.join("custom.json"),
        serde_json::to_vec_pretty(&doc).map_err(|e| e.to_string())?,
    )
    .map_err(|e| format!("저장하지 못했습니다: {e}"))?;

    // A locally-run model needs no key, so an empty one is valid here.
    save_api_key("custom".into(), key)
}

fn read_key(provider: &str) -> Result<String, String> {
    std::fs::read_to_string(key_path(provider))
        .map(|s| s.trim().to_string())
        .map_err(|_| "API 키가 저장되어 있지 않습니다. 설정에서 넣어 주세요.".to_string())
}

/// What we want back, per task. Kept as an explicit schema in the prompt rather
/// than parsed loosely, so a reply that does not fit is a visible error instead
/// of half-filled fields.
fn instructions(task: &str) -> Result<&'static str, String> {
    Ok(match task {
        "shop" => {
            r#"You help a shop owner register their shop. From their one-line description, produce JSON only, no prose, no markdown fence:
{"names":{"ko":"","en":"","ja":"","zh":""},"description_ko":"","asset":"","location":"","delivery":false,"pickup":true}
Rules:
- names: the shop's name in each language, natural to a native speaker. Not transliteration where a real translation exists.
- asset: A-Z 0-9 _ only, 3-25 chars, no SHOP. prefix, derived from the English name. This is permanent on a blockchain.
- description_ko: ONE sentence, at most 40 Korean characters. Use only nouns and verbs the user actually wrote. If they did not say it, do not add it.
- Never add adjectives of praise. Not 정성/최고/특별한/자랑/풍미/프리미엄/진정한. A shop that roasts its own beans is "원두를 직접 볶습니다", not "정성을 담아 최고의 원두를".
- location: only if the user stated one, else "".
- Infer delivery/pickup only from what they said; default pickup true, delivery false."#
        }
        // 자산 발행은 사람들이 가장 어려워하는 곳이다. 종류가 여섯이고, 이름
        // 규칙이 있고, 소각한 RVN 은 돌아오지 않고, 이름은 영구다. "무엇을
        // 발행해야 하나"는 답을 아는 사람만 답할 수 있는 질문이라, 사장이
        // 자기 말로 상황을 적으면 AI 가 종류로 번역해 준다.
        //
        // AI 는 **채우기만** 한다. 태우는 것은 언제나 사람이 누른다.
        "issue" => {
            r#"You help a shop owner choose which Ravencoin asset to issue. From their plain description of what they want to do, produce JSON only, no prose, no markdown fence:
{"kind":"","name":"","qty":1,"units":0,"reissuable":true,"burn_rvn":0,"why":"","permanent":"","alternative":""}
The six kinds and what each is for:
- "root" (burn 500): the shop or brand itself. One per business. Name is permanent forever.
- "sub" (burn 100): one product under a brand you already own, e.g. a song, a course. Needs the root's owner token.
- "unique" (burn 5): one-of-a-kind, one per person or per seat — memberships, tickets, certificates. The tag is random, so nobody types it.
- "qualifier" (burn 1000): a badge you grant to addresses, e.g. verified. Starts with #.
- "restricted" (burn 1500): only addresses holding a qualifier may hold it. For regulated things.
🔴 Do NOT suggest a "channel" (ROOT~name). Ravencoin has them, but this program
cannot make one — `issue.rs` classifies names into root, sub and unique only, and
`~` is not in the allowed characters. Suggesting it means the owner asks for a
channel, gets a name, and the app then refuses that name. An owner token already
works as a notice channel, so say that instead.
Rules:
- kind: exactly one of root, sub, unique, qualifier, restricted.
- name: A-Z 0-9 . _ only, 3-30 chars. NEVER Korean — the chain refuses it. Romanise. For sub use ROOT/NAME, for qualifier #NAME.
- burn_rvn: the number above for the kind you chose. Do not invent a number.
- qty: how many exist. For unique always 1. For a membership scheme the owner issues one per member, so still 1.
- units: decimal places, 0 unless the thing is divisible. Tickets and memberships are 0.
- reissuable: true if they may need to change the attached file or add supply later. For a shop root, true.
- why: ONE sentence in Korean saying why this kind fits what they said. Use their own words.
- permanent: ONE sentence in Korean naming exactly what cannot be undone. Always mention the name being permanent when kind is root or sub.
- alternative: if a cheaper or simpler kind would also work, name it in Korean in one sentence. Else "".
- If what they wrote is too vague to choose, set kind to "" and put the ONE question you need answered into why."#
        }
        "menu" => {
            r#"You turn a shop owner's rough menu text into structured data. Produce JSON only, no prose, no markdown fence:
{"items":[{"name":"","name_en":"","price":0}]}
Rules:
- price is a number, no currency symbol, no commas. If the user wrote 4,500 use 4500.
- name is exactly what the owner called it, in their language. Do not rename or "improve" dishes.
- name_en is a natural English rendering for foreign customers.
- Keep the owner's order. Include every item they listed and nothing they did not."#
        }
        "asset" => {
            r#"You help name and describe a blockchain asset. Produce JSON only, no prose, no markdown fence:
{"name":"","display_ko":"","display_en":"","description_ko":"","description_en":""}
Rules:
- name: A-Z 0-9 . _ only, 3-30 chars. Permanent and globally unique once issued.
- display_*: the human-readable name, which may use any script.
- descriptions: one sentence each."#
        }
        // The conversational one. It edits the forms the owner is looking at and
        // nothing else — there is no action here that burns, sends, or issues.
        // Those stay behind the retype-the-name gate on the desktop, because a
        // model that misreads "이거 지워줘" should cost a menu line, not 500 RVN.
        "chat" => {
            r#"You help a shop owner set up their shop by conversation, in Korean. You are given the CURRENT STATE of their forms. Produce JSON only, no prose outside it, no markdown fence:
{"reply":"","actions":[]}

"reply" is what you say to them, in Korean, one or two sentences. Always fill it.

"actions" is what should change. Empty array if nothing should. Allowed actions ONLY:
{"type":"shop_set","field":"name_ko|name_en|name_ja|name_zh|description|location|phone|asset|order_url","value":""}
{"type":"shop_flag","field":"pickup|delivery","value":true}
{"type":"closed","today":true,"note":"오늘 재료가 떨어졌습니다"}
{"type":"menu_add","name":"","name_en":"","price":0}
{"type":"menu_set","index":0,"field":"name|name_en|price","value":""}
{"type":"menu_remove","index":0}
{"type":"menu_clear"}
{"type":"issue_set","field":"name|qty|units|reissuable","value":""}
{"type":"go","screen":"assets|wallet|issue|shop|order|settings"}
{"type":"theme","accent":"RRGGBB","tint":"RRGGBB"}  (six hex digits, no leading hash)
{"type":"tile_add","label":"단골 쿠폰","sub":"눌러서 만들기","say":"단골 쿠폰 자산을 만들려고 합니다."}
{"type":"tile_remove","label":"단골 쿠폰"}

Rules:
- You can FILL IN the issue form, but you cannot issue. You cannot send money, burn RVN, or register the shop. When asked to, fill the form, use "go" to take them to that screen, and tell them they must press the button themselves because it cannot be undone.
- Asset names: root burns 500 RVN, sub (NAME/SUB) 100 RVN, unique (NAME#tag) 5 RVN. Say which one applies when you suggest a name.
- price is a plain number in the shop's currency. No symbols, no commas.
- asset must be A-Z 0-9 _ only and is permanent once registered — suggest it, never claim it is set.
- Indexes refer to the menu list you were given, counting from 0.
- "theme" changes the two colours the customer screen uses: `accent` (the one filled button, links) and `tint` (a very light wash behind badges). Emit it only when the owner asks about colour or look. Rules you must keep:
  * accent must be dark enough to carry white text — aim for a relative luminance under 0.25. A pale accent makes the order button unreadable in a bright shop.
  * tint must be very light (luminance over 0.85) in the same hue family as accent.
  * Never propose pure red for accent: red on a payment button reads as "danger" and people hesitate.
  * Say in "reply" what the colours are for, in plain Korean. The owner is choosing how their shop looks to customers, not editing CSS.
- "closed" is the one thing owners do most often: "오늘 쉰다", "재료 떨어졌다", "일찍 닫는다". Set today=true with a short note in the owner's own words, so customers see a reason rather than a locked door. today=false reopens. The note is shown to customers exactly as written — keep it to one line.
- "order_url" is where customers outside the shop's wifi go to order. Only set it if the owner gives you an address.
- "tile_add" puts a big button on their HOME screen. Pressing it later types "say" into this chat and sends it, so "say" must be a complete Korean sentence that YOU would know how to act on. Use it when the owner says they do something often ("맨날 이거 해", "이거 단추로 만들어줘"), or when you notice they have asked for the same thing three times. "label" is 2-6 Korean characters — it sits under an icon on a small tile. "sub" is one short line under it. Never add a tile they did not ask for, and never add one for something you cannot actually do.
- "tile_remove" takes one off, matched by its exact label. Only their own tiles can be removed; the built-in ones cannot.
- Only emit actions the owner actually asked for. Do not tidy, rename, or "improve" things they did not mention.
- If they just want to talk, think something through, or ask what something is, answer in "reply" with an empty actions array. You are their assistant, not only a form filler."#
        }
        _ => return Err("알 수 없는 작업입니다.".into()),
    })
}

/// Conversational editing. Same transport as `ai_fill`, different contract:
/// the model is given the current form state and answers with both a reply and
/// a list of edits.
#[tauri::command]
pub async fn ai_chat(
    provider: String,
    message: String,
    state: Value,
    history: Value,
) -> Result<Value, String> {
    let input = format!(
        "CURRENT STATE:\n{}\n\nRECENT CONVERSATION:\n{}\n\nOWNER SAYS:\n{}",
        serde_json::to_string_pretty(&state).unwrap_or_default(),
        serde_json::to_string(&history).unwrap_or_default(),
        message.trim()
    );
    ai_fill(provider, "chat".into(), input).await
}

/// Words that mark copy as machine-written Korean marketing.
///
/// Telling the model not to use them does not work — it fills empty space with
/// adjectives by default, and a prompt instruction is a suggestion. Refusing to
/// *save* the result is not a suggestion. So the check happens after
/// generation, and a sentence containing any of these is thrown away rather
/// than shown to the owner as a starting point they will accept out of
/// politeness.
const AI_SLOP: &[&str] = &[
    "정성을",
    "정성껏",
    "최고의",
    "특별한",
    "자랑하",
    "선사하",
    "풍미",
    "가득한",
    "프리미엄",
    "진정한",
    "완벽한",
    "감동",
    "명품",
    "일품",
    "엄선한",
    "깊은 맛",
];

/// Is this sentence the kind a model writes when it has nothing to say?
pub fn is_slop(text: &str) -> bool {
    AI_SLOP.iter().any(|w| text.contains(w))
}

/// Removes generated fields that read as AI marketing copy.
///
/// Applied to descriptions only. Names — of a shop, of a dish — are what the
/// owner called them, and rewriting those breaks the kitchen: staff cannot find
/// an item the owner renamed behind their back.
fn strip_slop(mut v: Value) -> Value {
    fn clean(obj: &mut serde_json::Map<String, Value>, keys: &[&str]) {
        for k in keys {
            if let Some(s) = obj.get(*k).and_then(Value::as_str) {
                if is_slop(s) {
                    // Dropped, not blanked with an apology: the form keeps
                    // whatever the owner already typed.
                    obj.remove(*k);
                }
            }
        }
    }
    if let Some(obj) = v.as_object_mut() {
        clean(obj, &["description_ko", "description", "description_en", "reply"]);
        if let Some(items) = obj.get_mut("items").and_then(Value::as_array_mut) {
            for it in items {
                if let Some(m) = it.as_object_mut() {
                    clean(m, &["description", "description_ko"]);
                }
            }
        }
    }
    v
}

/// Strips a markdown fence if the model wrapped its JSON in one.
fn unfence(text: &str) -> &str {
    let t = text.trim();
    if let Some(rest) = t.strip_prefix("```") {
        let rest = rest.strip_prefix("json").unwrap_or(rest);
        if let Some(end) = rest.rfind("```") {
            return rest[..end].trim();
        }
    }
    t
}

/// Asks the chosen provider to fill in a form.
///
/// Returns the parsed object. A reply that is not JSON is surfaced as an error
/// with the raw text attached — silently returning empty fields would look like
/// the feature worked and produced nothing.
#[tauri::command]
pub async fn ai_fill(provider: String, task: String, input: String) -> Result<Value, String> {
    if input.trim().is_empty() {
        return Err("무엇을 만들지 적어 주세요.".into());
    }
    let key = read_key(&provider)?;
    let system = instructions(&task)?;

    let client = reqwest::Client::new();
    let text = match provider.as_str() {
        "anthropic" => {
            let body = json!({
                "model": model_for("anthropic"),
                "max_tokens": 1500,
                "system": system,
                "messages": [{ "role": "user", "content": input }],
            });
            let response = client
                .post("https://api.anthropic.com/v1/messages")
                .header("x-api-key", key)
                .header("anthropic-version", "2023-06-01")
                .json(&body)
                .timeout(std::time::Duration::from_secs(90))
                .send()
                .await
                .map_err(|e| format!("연결하지 못했습니다: {e}"))?;

            let parsed: Value = response
                .json()
                .await
                .map_err(|e| format!("응답을 읽지 못했습니다: {e}"))?;
            if let Some(err) = parsed.get("error") {
                return Err(format!(
                    "제공자 오류: {}",
                    err.get("message").and_then(Value::as_str).unwrap_or("알 수 없음")
                ));
            }
            parsed
                .get("content")
                .and_then(Value::as_array)
                .and_then(|a| a.first())
                .and_then(|c| c.get("text"))
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string()
        }
        p if openai_compat(p).is_some() => {
            let (base, _) = openai_compat(p).unwrap();
            let model = model_for(p);
            openai_compatible(&client, base, &model, &key, system, &input, true).await?
        }
        "google" => {
            let body = json!({
                "systemInstruction": { "parts": [{ "text": system }] },
                "contents": [{ "role": "user", "parts": [{ "text": input }] }],
                "generationConfig": { "responseMimeType": "application/json" },
            });
            // The key goes in a header rather than the query string: URLs end up
            // in logs and error messages in a way headers do not.
            let response = client
                .post(format!("https://generativelanguage.googleapis.com/v1beta/models/{}:generateContent", model_for("google")))
                .header("x-goog-api-key", key)
                .json(&body)
                .timeout(std::time::Duration::from_secs(90))
                .send()
                .await
                .map_err(|e| format!("연결하지 못했습니다: {e}"))?;

            let parsed: Value = response
                .json()
                .await
                .map_err(|e| format!("응답을 읽지 못했습니다: {e}"))?;
            if let Some(err) = parsed.get("error") {
                return Err(format!(
                    "제공자 오류: {}",
                    err.get("message").and_then(Value::as_str).unwrap_or("알 수 없음")
                ));
            }
            parsed
                .get("candidates")
                .and_then(Value::as_array)
                .and_then(|a| a.first())
                .and_then(|c| c.get("content"))
                .and_then(|c| c.get("parts"))
                .and_then(Value::as_array)
                .and_then(|p| p.first())
                .and_then(|p| p.get("text"))
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string()
        }
        "custom" => {
            let (_, base, model) =
                custom_config().ok_or_else(|| "커스텀 제공자가 설정되지 않았습니다.".to_string())?;
            openai_compatible(&client, &base, &model, &key, system, &input, true).await?
        }
        _ => return Err("알 수 없는 제공자입니다.".into()),
    };

    serde_json::from_str::<Value>(unfence(&text))
        .map(strip_slop)
        .map_err(|_| format!("AI가 알아볼 수 없는 형식으로 답했습니다:\n\n{text}"))
}

/// The `/chat/completions` shape, which xAI, DeepSeek, Groq, Together and
/// Ollama all implement.
#[allow(clippy::too_many_arguments)]
async fn openai_compatible(
    client: &reqwest::Client,
    base: &str,
    model: &str,
    key: &str,
    system: &str,
    input: &str,
    want_json: bool,
) -> Result<String, String> {
    let mut body = json!({
        "model": model,
        "messages": [
            { "role": "system", "content": system },
            { "role": "user", "content": input },
        ],
    });
    if want_json {
        body["response_format"] = json!({ "type": "json_object" });
    }

    let mut req = client
        .post(format!("{base}/chat/completions"))
        .json(&body)
        .timeout(std::time::Duration::from_secs(120));
    // A locally-run model has no key, and sending an empty bearer token makes
    // some servers reject the request outright.
    if !key.is_empty() {
        req = req.bearer_auth(key);
    }

    let response = req
        .send()
        .await
        .map_err(|e| format!("연결하지 못했습니다: {e}"))?;
    let parsed: Value = response
        .json()
        .await
        .map_err(|e| format!("응답을 읽지 못했습니다: {e}"))?;

    if let Some(err) = parsed.get("error") {
        return Err(format!(
            "제공자 오류: {}",
            err.get("message").and_then(Value::as_str).unwrap_or("알 수 없음")
        ));
    }
    Ok(parsed
        .get("choices")
        .and_then(Value::as_array)
        .and_then(|a| a.first())
        .and_then(|c| c.get("message"))
        .and_then(|m| m.get("content"))
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string())
}

/// Answers a customer's question from the shop's own information.
///
/// Three rules are hard, because the failure modes here are not cosmetic:
///
/// 1. **Only what the shop published.** A model that invents a dish, an
///    allergen, or an opening time is not being helpful — the shop will be
///    held to whatever it said, and nobody typed it.
/// 2. **Never confirm an order.** It can explain and recommend; taking money
///    requires a signed transaction, and no reply from here creates one.
/// 3. **"I don't know" is a correct answer** and is stated as such in the
///    prompt, because the default behaviour of every one of these models is to
///    produce something plausible instead.
/// Providers to try, cheapest-and-fastest first, for a question a customer asks.
///
/// ## Why order matters here and not elsewhere
///
/// A customer asks "does this have nuts" up to two hundred times a day and the
/// shop pays for every one. That question is not hard — the cheap fast tier
/// answers it exactly as well as the expensive one, and the difference lands on
/// the shop's bill rather than on the answer.
///
/// The owner is never *asked* to rank these — that question belongs with
/// `dbcache`. But an owner who does care can reorder them (`ai_order_save`),
/// and the saved order wins. Not offering the choice and hiding it are
/// different things; this hides it without taking it away.
const CUSTOMER_ORDER: [&str; 5] = ["groq", "google", "xai", "openai", "anthropic"];

/// The same list, best-first, for work the owner does a few times a day.
const OWNER_ORDER: [&str; 5] = ["anthropic", "openai", "xai", "google", "groq"];

/// The providers that actually have a key, in the order we should try them.
///
/// The owner's pick goes first when they made one — a chosen provider that gets
/// silently overruled is worse than no choice at all.
fn order_path() -> PathBuf {
    config_dir().join("ai-order.json")
}

/// The order the owner dragged into place, if they did. One list per lane —
/// the cheap tier that answers customers is a different decision from the one
/// that helps the owner write a notice, and merging them would force a trade.
fn saved_order(customer: bool) -> Vec<String> {
    let lane = if customer { "customer" } else { "owner" };
    std::fs::read_to_string(order_path())
        .ok()
        .and_then(|t| serde_json::from_str::<Value>(&t).ok())
        .and_then(|v| v.get(lane).cloned())
        .and_then(|v| v.as_array().cloned())
        .map(|a| {
            a.iter()
                .filter_map(|x| x.as_str())
                .filter(|p| known(p))
                .map(String::from)
                .collect()
        })
        .unwrap_or_default()
}

/// Read both lanes for the screen. Unsaved lanes come back as the default, so
/// the screen never has to know which constant it would have used.
#[tauri::command]
pub fn ai_order_read() -> Value {
    let fill = |customer: bool| {
        let mut out = saved_order(customer);
        let base = if customer { CUSTOMER_ORDER } else { OWNER_ORDER };
        // A provider added in a later version must not vanish because an old
        // saved list predates it. Anything missing is appended.
        for p in base {
            if !out.iter().any(|x| x == p) {
                out.push(p.to_string());
            }
        }
        json!({
            "order": out,
            "custom": !saved_order(customer).is_empty(),
        })
    };
    json!({ "customer": fill(true), "owner": fill(false) })
}

/// Save one lane. An empty list means "go back to the default".
#[tauri::command]
pub fn ai_order_save(customer: bool, order: Vec<String>) -> Result<Value, String> {
    for p in &order {
        if !known(p) {
            return Err(format!("알 수 없는 제공자입니다: {p}"));
        }
    }
    let lane = if customer { "customer" } else { "owner" };
    let dir = config_dir();
    std::fs::create_dir_all(&dir).map_err(|e| format!("설정 폴더를 만들지 못했습니다: {e}"))?;
    let mut v: Value = std::fs::read_to_string(order_path())
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_else(|| json!({}));
    if !v.is_object() {
        v = json!({});
    }
    if order.is_empty() {
        if let Some(o) = v.as_object_mut() {
            o.remove(lane);
        }
    } else {
        v[lane] = json!(order);
    }
    std::fs::write(
        order_path(),
        serde_json::to_vec_pretty(&v).map_err(|e| e.to_string())?,
    )
    .map_err(|e| format!("저장하지 못했습니다: {e}"))?;
    Ok(ai_order_read())
}

fn try_order(preferred: &str, customer: bool) -> Vec<String> {
    // 사장이 끌어다 놓은 순서가 있으면 그것이 이긴다. 없으면 기본값.
    let dragged = saved_order(customer);
    let base: Vec<String> = if dragged.is_empty() {
        (if customer { CUSTOMER_ORDER } else { OWNER_ORDER })
            .iter()
            .map(|s| s.to_string())
            .collect()
    } else {
        let mut b = dragged;
        // 나중에 늘어난 제공자가 옛 목록 때문에 아예 안 쓰이면 안 된다.
        for p in if customer { CUSTOMER_ORDER } else { OWNER_ORDER } {
            if !b.iter().any(|x| x == p) {
                b.push(p.to_string());
            }
        }
        b
    };
    let mut out: Vec<String> = Vec::new();
    if !preferred.is_empty() && read_key(preferred).map(|k| !k.is_empty()).unwrap_or(false) {
        out.push(preferred.to_string());
    }
    for p in &base {
        if out.iter().any(|x| x == p) {
            continue;
        }
        if read_key(p).map(|k| !k.is_empty()).unwrap_or(false) {
            out.push(p.clone());
        }
    }
    out
}

/// Asks a customer question, moving to the next provider if one is down.
///
/// One provider being over quota or having a bad afternoon should not show a
/// customer an error in a shop — they are standing there holding a phone.
#[tauri::command]
pub async fn ai_answer_any(
    provider: String,
    question: String,
    shop_context: Value,
) -> Result<Value, String> {
    let order = try_order(&provider, true);
    if order.is_empty() {
        return Err("API 키가 하나도 없습니다. 설정에서 넣어 주세요.".into());
    }
    let mut tried: Vec<String> = Vec::new();
    for p in &order {
        tried.push(p.clone());
        match ai_answer(p.clone(), question.clone(), shop_context.clone()).await {
            Ok(text) => {
                return Ok(json!({
                    "text": text,
                    "provider": p,
                    // 몇 번째로 성공했는지. 첫 번째가 계속 실패하면 사장이 알아야 한다.
                    "tried": tried,
                }))
            }
            Err(e) => {
                // 마지막 하나까지 실패하면 그때 이유를 보여 준다.
                if p == order.last().unwrap() {
                    return Err(format!("{}곳 모두 실패했습니다. 마지막 이유: {e}", order.len()));
                }
            }
        }
    }
    Err("답을 받지 못했습니다.".into())
}

/// One question to one provider. No JSON contract, no shop context — just
/// a system line and a user line.
///
/// Pulled out of `ai_answer` because three callers now need the same
/// transport with different instructions: the customer reply, the owner's
/// own questions, and the two-provider comparison. Copying the five
/// provider branches three times is how they drift apart.
pub async fn ai_raw(provider: String, system: String, input: String) -> Result<String, String> {
    let key = read_key(&provider).unwrap_or_default();
    if key.is_empty() && provider != "custom" {
        return Err("API 키가 저장되어 있지 않습니다.".into());
    }
    let client = reqwest::Client::new();
    match provider.as_str() {
        "anthropic" => {
            let body = json!({
                "model": model_for("anthropic"),
                "max_tokens": 600,
                "system": system,
                "messages": [{ "role": "user", "content": input }],
            });
            let parsed: Value = client
                .post("https://api.anthropic.com/v1/messages")
                .header("x-api-key", key)
                .header("anthropic-version", "2023-06-01")
                .json(&body)
                .timeout(std::time::Duration::from_secs(90))
                .send()
                .await
                .map_err(|e| format!("연결하지 못했습니다: {e}"))?
                .json()
                .await
                .map_err(|e| format!("응답을 읽지 못했습니다: {e}"))?;
            if let Some(err) = parsed.get("error") {
                return Err(format!(
                    "제공자 오류: {}",
                    err.get("message").and_then(Value::as_str).unwrap_or("알 수 없음")
                ));
            }
            Ok(parsed
                .get("content")
                .and_then(Value::as_array)
                .and_then(|a| a.first())
                .and_then(|c| c.get("text"))
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string())
        }
        p if openai_compat(p).is_some() => {
            let (base, _) = openai_compat(p).unwrap();
            let model = model_for(p);
            openai_compatible(&client, base, &model, &key, &system, &input, false).await
        }
        "google" => {
            let body = json!({
                "systemInstruction": { "parts": [{ "text": system }] },
                "contents": [{ "role": "user", "parts": [{ "text": input }] }],
            });
            let parsed: Value = client
                .post(format!("https://generativelanguage.googleapis.com/v1beta/models/{}:generateContent", model_for("google")))
                .header("x-goog-api-key", key)
                .json(&body)
                .timeout(std::time::Duration::from_secs(90))
                .send()
                .await
                .map_err(|e| format!("연결하지 못했습니다: {e}"))?
                .json()
                .await
                .map_err(|e| format!("응답을 읽지 못했습니다: {e}"))?;
            if let Some(err) = parsed.get("error") {
                return Err(format!(
                    "제공자 오류: {}",
                    err.get("message").and_then(Value::as_str).unwrap_or("알 수 없음")
                ));
            }
            Ok(parsed
                .get("candidates")
                .and_then(Value::as_array)
                .and_then(|a| a.first())
                .and_then(|c| c.get("content"))
                .and_then(|c| c.get("parts"))
                .and_then(Value::as_array)
                .and_then(|p| p.first())
                .and_then(|p| p.get("text"))
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string())
        }
        "custom" => {
            let (_, base, model) =
                custom_config().ok_or_else(|| "커스텀 제공자가 설정되지 않았습니다.".to_string())?;
            openai_compatible(&client, &base, &model, &key, &system, &input, false).await
        }
        _ => Err("알 수 없는 제공자입니다.".into()),
    }
}

#[tauri::command]
pub async fn ai_answer(
    provider: String,
    question: String,
    shop_context: Value,
) -> Result<String, String> {
    if question.trim().is_empty() {
        return Err("질문이 비어 있습니다.".into());
    }
    let key = read_key(&provider).unwrap_or_default();
    if key.is_empty() && provider != "custom" {
        return Err("API 키가 저장되어 있지 않습니다.".into());
    }

    // 손님이 "이게 뭐예요", "레이븐코인이 뭐예요" 를 물으면 지금은 답할 것이
    // 없었다. 노드가 사실을 들고 있게 한다 — 다만 **밝히는 소개**까지다.
    // 숨은 칭찬을 넣으면 화면에 적어 둔 "가게가 올린 정보로만 답합니다" 가
    // 거짓말이 되고, 이 프로그램을 쓰는 다른 가게 사장이 동의한 적 없이
    // 자기 손님에게 우리 광고를 하게 된다.
    let system = format!("You answer customer questions for a shop, in the customer's own language.\n\
        Use ONLY the shop information given below. It is the entire truth you have.\n\
        - If the answer is not in it, say you do not know and suggest asking the shop directly. Never guess a price, an ingredient, an allergen, or an opening time.\n\
        - Never confirm, accept, or promise an order. You cannot take payment. If they want to order, tell them to use the order button.\n\
        - Be brief. Two or three sentences.\n\
        - Prices are as listed; do not convert or discount them.\n\
        - The block below is background you may use when they ask what this shop, \
this program, or Ravencoin is. State it plainly; it is an introduction, not a pitch.\n{}",
        crate::knowledge::customer_brief());

    let input = format!(
        "SHOP INFORMATION:\n{}\n\nCUSTOMER QUESTION:\n{}",
        serde_json::to_string_pretty(&shop_context).unwrap_or_default(),
        question.trim()
    );

    ai_raw(provider, system, input).await
}

#[cfg(test)]
mod order_tests {
    use super::{CUSTOMER_ORDER, OWNER_ORDER};

    #[test]
    fn both_orders_cover_every_provider() {
        // 한쪽에만 있는 제공자가 생기면, 키를 넣었는데 영영 안 쓰이는 일이 난다.
        let mut a = CUSTOMER_ORDER;
        let mut b = OWNER_ORDER;
        a.sort_unstable();
        b.sort_unstable();
        assert_eq!(a, b);
    }

    #[test]
    fn the_cheap_tier_leads_for_customers() {
        // 손님 질문은 하루 200번이고 가게가 낸다. 비싼 것이 앞에 오면 답은
        // 같은데 요금만 오른다.
        assert_eq!(CUSTOMER_ORDER[0], "groq");
        assert_eq!(OWNER_ORDER[0], "anthropic");
    }
}

#[cfg(test)]
mod issue_guide_tests {
    use super::instructions;

    #[test]
    fn the_issue_guide_states_every_burn() {
        let t = instructions("issue").expect("issue 작업이 없습니다");
        // 소각량을 프롬프트에 적어 두지 않으면 모델이 지어낸다. 그 숫자는
        // 사람이 태우는 돈이라 지어내면 안 된다.
        for n in ["500", "100", "5", "1000", "1500"] {
            assert!(t.contains(n), "소각량 {n} 이 안내에 없습니다");
        }
    }

    #[test]
    fn it_refuses_korean_names() {
        let t = instructions("issue").expect("issue 작업이 없습니다");
        // 체인이 한글 이름을 거부한다. 모델이 그걸 모르면 "필연" 을 제안하고
        // 사용자는 발행 직전에 막힌다.
        assert!(t.contains("NEVER Korean"), "한글 금지 규칙이 없습니다");
    }

    #[test]
    fn it_must_say_what_cannot_be_undone() {
        let t = instructions("issue").expect("issue 작업이 없습니다");
        assert!(t.contains("permanent"), "되돌릴 수 없는 것을 말하게 하지 않습니다");
    }
}

#[cfg(test)]
mod order_pref_tests {
    use super::*;

    /// ⚠️ 환경변수는 프로세스 전체에 걸린다. 다른 시험과 동시에 돌면 그 시험이
    /// 임시 폴더를 진짜 폴더로 착각한다. 그래서 장부 시험과 같은 관례를 따른다 —
    /// 평소엔 건너뛰고, 부를 때만 단독으로 돈다:
    ///   cargo test --lib -- --ignored --test-threads=1 order_tests
    fn with_home<T>(name: &str, f: impl FnOnce() -> T) -> T {
        let _g = crate::paths::TEST_ENV.lock().unwrap_or_else(|e| e.into_inner());
        let dir = std::env::temp_dir().join(format!("playx-raven-test-{name}"));
        let _ = std::fs::remove_dir_all(&dir);
        std::env::set_var("PLAYX_RAVEN_HOME", &dir);
        let r = f();
        std::env::remove_var("PLAYX_RAVEN_HOME");
        let _ = std::fs::remove_dir_all(&dir);
        r
    }

    /// 나중에 제공자가 하나 늘었는데 옛 목록을 저장해 둔 가게에서 그곳이
    /// **영원히 안 쓰이면**, 키를 넣어도 아무 일이 없다. 조용해서 더 나쁘다.
    #[test]
    #[ignore]
    fn a_provider_added_later_still_gets_tried() {
        with_home("order-new", || {
            ai_order_save(true, vec!["openai".into(), "groq".into()]).unwrap();
            let v = ai_order_read();
            let got: Vec<String> = v["customer"]["order"]
                .as_array()
                .unwrap()
                .iter()
                .filter_map(|x| x.as_str().map(String::from))
                .collect();
            assert_eq!(&got[..2], &["openai", "groq"], "고른 순서가 앞에 와야 한다");
            for p in CUSTOMER_ORDER {
                assert!(got.iter().any(|x| x == p), "{p} 가 목록에서 사라졌다");
            }
        });
    }

    /// 두 줄은 서로 다른 결정이다. 손님 쪽을 싼 곳으로 바꿨다고 사장 일까지
    /// 싼 곳으로 끌려가면, 고른 적 없는 손해를 보게 된다.
    #[test]
    #[ignore]
    fn the_two_lanes_do_not_move_together() {
        with_home("order-lanes", || {
            ai_order_save(true, vec!["groq".into()]).unwrap();
            let v = ai_order_read();
            assert_eq!(v["customer"]["order"][0], json!("groq"));
            assert_eq!(
                v["owner"]["order"][0],
                json!(OWNER_ORDER[0]),
                "사장 줄이 손님 줄을 따라 움직였다"
            );
            assert_eq!(v["owner"]["custom"], json!(false));
        });
    }

    /// 빈 목록 = 기본값으로. 이게 없으면 한 번 바꾼 사장님은 돌아갈 길이 없다.
    #[test]
    #[ignore]
    fn saving_nothing_restores_the_default() {
        with_home("order-reset", || {
            ai_order_save(true, vec!["anthropic".into()]).unwrap();
            assert_eq!(ai_order_read()["customer"]["custom"], json!(true));
            ai_order_save(true, vec![]).unwrap();
            let v = ai_order_read();
            assert_eq!(v["customer"]["custom"], json!(false));
            assert_eq!(v["customer"]["order"][0], json!(CUSTOMER_ORDER[0]));
        });
    }

    /// 모르는 이름이 들어가면 순서가 조용히 망가진다.
    #[test]
    #[ignore]
    fn an_unknown_provider_is_refused() {
        with_home("order-bad", || {
            assert!(ai_order_save(true, vec!["deepseek".into()]).is_err());
        });
    }
}

// ── 두 곳에 같이 물어보기 ──────────────────────────────────────────────────
//
// 가격을 정하거나 공지 문구를 고를 때, 한 곳의 답은 그럴듯해서 반박할 거리가
// 없다. 서로 다른 회사의 모델 둘에게 같은 것을 물으면 **어긋나는 지점**이
// 드러나고, 거기가 사장이 실제로 결정해야 할 자리다.
//
// 🔴 손님 응대에는 쓰지 않는다. 값도 두 배, 기다림도 두 배인데 카운터에는
// 줄이 서 있다 — "장사하는 사람은 속도가 생명" 과 정면으로 부딪힌다.
// 사장이 스스로 누를 때만 돈다.

/// Ask two different providers the same question and return both answers.
///
/// Deliberately no third "judge" call. A judge would hide the disagreement,
/// and the disagreement is the product — the owner decides, not us.
#[tauri::command]
pub async fn ai_debate(question: String) -> Result<Value, String> {
    if question.trim().is_empty() {
        return Err("질문이 비어 있습니다.".into());
    }
    let order = try_order("", false);
    if order.len() < 2 {
        return Err(
            "두 곳 이상의 API 키가 있어야 합니다. 설정에서 하나 더 넣어 주세요.".into(),
        );
    }
    // 같은 회사 모델 둘은 같은 편향을 갖는다. 목록 순서상 앞의 서로 다른 둘.
    let (a, b) = (order[0].clone(), order[1].clone());

    let ask = |p: String, q: String| async move {
        let sys = format!(
            "You advise a shop owner, in Korean. Answer the question directly in 4~6 sentences.\n\
             Give your actual recommendation, not a list of considerations. Say the strongest \
             reason someone might disagree with you, in one sentence at the end.\n{}",
            crate::knowledge::owner_brief()
        );
        ai_raw(p.clone(), sys, q).await.map(|t| (p, t))
    };

    let (ra, rb) = tokio::join!(ask(a.clone(), question.clone()), ask(b.clone(), question));
    let one = |r: Result<(String, String), String>| match r {
        Ok((p, t)) => json!({ "provider": p, "text": t }),
        Err(e) => json!({ "provider": "", "error": e }),
    };
    Ok(json!({ "a": one(ra), "b": one(rb) }))
}

/// A plain question to one provider — no JSON contract, no form actions.
///
/// `ai_chat` makes the model answer in a fixed JSON shape so it can edit forms.
/// That shape gets in the way when the owner just wants to think out loud, and
/// a model that must emit `actions` tends to invent one.
#[tauri::command]
pub async fn ai_ask_owner(provider: String, question: String) -> Result<Value, String> {
    if question.trim().is_empty() {
        return Err("질문이 비어 있습니다.".into());
    }
    let order = try_order(&provider, false);
    if order.is_empty() {
        return Err("API 키가 하나도 없습니다. 설정에서 넣어 주세요.".into());
    }
    let sys = format!(
        "You are the assistant inside PLAY X Raven, talking to the shop owner in Korean.\n\
         Be concrete and brief — 3~6 sentences unless they ask for more.\n{}",
        crate::knowledge::owner_brief()
    );
    let mut last = String::new();
    for p in &order {
        match ai_raw(p.clone(), sys.clone(), question.clone()).await {
            Ok(t) => return Ok(json!({ "provider": p, "text": t })),
            Err(e) => last = e,
        }
    }
    Err(format!("{}곳 모두 실패했습니다. 마지막 이유: {last}", order.len()))
}
