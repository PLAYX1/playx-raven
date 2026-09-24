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
//! AI sends the selected task's question and disclosed form/context to the
//! configured provider. Node peers, IPFS and shop publication have their own
//! network paths. A local AI choice must never silently fall back to the cloud.

use serde_json::{json, Value};
use std::path::PathBuf;
static CUSTOM_GATE: std::sync::Mutex<()> = std::sync::Mutex::new(());

fn remove_key(path: &std::path::Path) -> Result<(), String> {
    match std::fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(_) => Err("이전 API 키를 지우지 못했습니다. 설정 폴더 권한을 확인하세요.".into()),
    }
}

fn write_private(path: &std::path::Path, bytes: &[u8]) -> Result<(), String> {
    use std::io::Write;
    let pending = path.with_extension(format!("pending-{:016x}", rand::random::<u64>()));
    let result = (|| -> std::io::Result<()> {
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)] { use std::os::unix::fs::OpenOptionsExt; options.mode(0o600); }
        let mut file = options.open(&pending)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        drop(file);
        std::fs::rename(&pending, path)
    })();
    if result.is_err() { let _ = std::fs::remove_file(&pending); }
    result.map_err(|_| "AI 설정을 저장하지 못했습니다. 설정 폴더 권한과 여유 공간을 확인하세요.".to_string())
}

fn save_key(provider: &str, key: &str) -> Result<(), String> {
    if key.len() > 4096 || key.chars().any(char::is_control) {
        return Err("API 키를 줄바꿈 없이 다시 입력하세요.".into());
    }
    let path = key_path(provider);
    if key.trim().is_empty() { remove_key(&path) } else { write_private(&path, key.trim().as_bytes()) }
}

/// Snapshot both files under the same lock as settings updates. A new endpoint
/// never gets the old endpoint's key, including partial-write failures.
fn custom_request_settings() -> Result<(String, String, String), String> {
    let _guard = CUSTOM_GATE.lock().map_err(|_| "AI 설정을 다시 저장해 주세요.".to_string())?;
    let (_, base, model) = custom_config().ok_or_else(|| "커스텀 제공자가 설정되지 않았습니다.".to_string())?;
    let key = read_key("custom").unwrap_or_default();
    let base = crate::ai_endpoint::validate(&base, &model, &key)?;
    Ok((base, model, key))
}

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
    let _guard = if provider == "custom" { Some(CUSTOM_GATE.lock().map_err(|_| "AI 설정을 다시 저장해 주세요.".to_string())?) } else { None };
    remove_key(&key_path(&provider))?;
    if provider == "custom" {
        remove_key(&config_dir().join("custom.json"))?;
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

    let _guard = if provider == "custom" { Some(CUSTOM_GATE.lock().map_err(|_| "AI 설정을 다시 저장해 주세요.".to_string())?) } else { None };
    if provider == "custom" && !key.trim().is_empty() {
        let (_, base, model) = custom_config().ok_or_else(|| "커스텀 제공자가 설정되지 않았습니다.".to_string())?;
        crate::ai_endpoint::validate(&base, &model, &key)?;
    }
    save_key(&provider, &key)
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
    let _guard = CUSTOM_GATE.lock().map_err(|_| "AI 설정을 다시 저장해 주세요.".to_string())?;
    let dir = config_dir();
    std::fs::create_dir_all(&dir).map_err(|e| format!("설정 폴더를 만들지 못했습니다: {e}"))?;

    if base_url.trim().is_empty() {
        remove_key(&key_path("custom"))?;
        remove_key(&dir.join("custom.json"))?;
        return Ok(());
    }
    let base = crate::ai_endpoint::validate(&base_url, &model, &key)?;
    let previous = custom_config().map(|v| v.1);
    let same_destination = previous.as_deref() == Some(base.as_str());
    // Empty HTTPS key preserves a key only for the identical endpoint. Before
    // changing destinations, remove the old key; fail closed if that fails.
    if !same_destination || base.starts_with("http://") { remove_key(&key_path("custom"))?; }

    let doc = json!({
        "label": if label.trim().is_empty() { base.clone() } else { label.trim().to_string() },
        "base_url": base,
        "model": model.trim(),
    });
    write_private(&dir.join("custom.json"), &serde_json::to_vec_pretty(&doc).map_err(|e| e.to_string())?)?;

    // A locally-run model needs no key, so an empty one is valid here.
    if !key.trim().is_empty() { save_key("custom", &key)?; }
    Ok(())
}

fn read_key(provider: &str) -> Result<String, String> {
    if !known(provider) { return Err("알 수 없는 제공자입니다.".into()); }
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
{"type":"menu_add","name":"","name_en":"","price":0,"pass_months":0,"pass_days":0,"stock":null}
{"type":"menu_set","index":0,"field":"name|name_en|price|pass_months|pass_days|stock","value":""}
{"type":"menu_remove","index":0}
  · pass_months / pass_days: a pass item ("하루권", "한달권", "1년권", "3개월권").
    Count MONTHS in pass_months, not days — 3 months is a calendar quarter, not 90 days.
    "하루권"→pass_days:1  "2일권"→pass_days:2  "1주일권"→pass_days:7
    "한달권"→pass_months:1  "3개월권"→pass_months:3  "1년권"→pass_months:12
    Coffee and food are NOT passes. Leave both at 0.
  · stock: how many are left. OMIT IT (null) unless the owner states a number —
    null means unlimited, 0 means sold out. They are different. Most items are null.
{"type":"menu_clear"}
{"type":"issue_set","field":"name|qty|units|reissuable","value":""}
{"type":"go","screen":"assets|wallet|issue|shop|order|settings"}
{"type":"theme","accent":"RRGGBB","tint":"RRGGBB"}  (six hex digits, no leading hash)
{"type":"tile_add","label":"단골 쿠폰","sub":"눌러서 만들기","say":"단골 쿠폰 자산을 만들려고 합니다."}
{"type":"tile_remove","label":"단골 쿠폰"}
{"type":"report","text":"보내기를 눌렀는데 아무 일도 없습니다"}
{"type":"point","spot":"새 자산 만들기"}

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
- "report" opens the 문제 알리기 window with "text" already typed in. Emit it when the owner is telling you something is BROKEN in this program — "안 돼", "왜 이래", "먹통이야", "눌러도 아무 일이 없어" — or asks how to report a bug. Rewrite what they said into one plain sentence a repairer could act on, and put it in "text". Do NOT send it yourself: the window shows them what is attached (screen, errors) and they press the button. Never emit "report" for a question you can simply answer, and never for something that is working as designed — say so instead.
- 🔴 "point" is the most important thing you can do for a 40~70 year old shop
  owner. It takes them to the screen AND makes the button blink so they can see
  it. **You do not press it — they do.** Money and chain writes are behind some
  of these, and the decision must stay with the person.
  Use it whenever the answer to their question is "press that button", instead of
  describing where it is in words. Describing a location in words is how people
  get lost — the owner asked twice in one day where a button was, and both times
  the answer was a screen away.
  "spot" MUST be one of these exact strings. Anything else is silently ignored:
    새 자산 만들기 · 가게 열기 · 문 등록 · 회원 등록 · 이야기 방 만들기 ·
    방 초대하기 · 이 컴퓨터 준비하기 · 노드 상태 · 지갑 · 백업 · 손님 받기 순서 ·
    나눠주기 · 내 가게 · 내 소개
  Say in "reply" what they will see and what pressing it does, in plain Korean.
  Pair it with "go" only if you need a screen not in that list.
- "tile_remove" takes one off, matched by its exact label. Only their own tiles can be removed; the built-in ones cannot.
- Only emit actions the owner actually asked for. Do not tidy, rename, or "improve" things they did not mention.
- If they just want to talk, think something through, or ask what something is, answer in "reply" with an empty actions array. You are their assistant, not only a form filler."#
        }
        // 증서 본문 문구 세 가지. 사람이 하나 고르고 고쳐 쓴다 — 라비는 제안만.
        //
        // 사실을 지어내지 못하게 하는 줄이 가장 중요하다. 「120시간」「우수한
        // 성적」은 발급처가 책임지는 말이라, 입력에 없는 것이 증서에 찍히면 그
        // 거짓말은 발급처 이름으로 나간다. 슬롭 단어는 `AI_SLOP` 과 같은 목록이고
        // (시험이 어긋남을 잡는다), 그런 문구는 생성 뒤 `strip_slop` 이 버린다.
        "cert_phrases" => {
            r#"You suggest the body text of a certificate. The input is JSON: {"template":"course|proof|thanks","title":"","issuer":"","lang":"ko|en|ja|zh"}. Produce JSON only, no prose, no markdown fence:
{"phrases":["","",""]}
A person picks one phrase and may edit it before anything is printed. These are options, not the decision.
Rules:
- Exactly 3 phrases. Each is one or two sentences and at most 90 characters.
- Write in the language given by "lang": ko Korean, en English, ja Japanese, zh Chinese. If "lang" is missing or anything else, write Korean.
- Tone follows "template" (use course if it is missing or unknown):
  * course: completion (수료). The person completed the course.
  * proof: neutral attestation (증명). State the fact plainly. No warmth, no praise, no wishes.
  * thanks: warm gratitude (감사). Thank the person for what they did, in plain words.
- The three must be meaningfully different, in this order: 1) short and plain, 2) the standard formal wording, 3) warmer and a little fuller. For proof the third is fuller but stays neutral.
- Placeholders, copied literally with their braces: {이름} is the recipient's name, {과정} is the course. At least one of the three must use {이름}. In English, Japanese and Chinese write {name} and {course} instead (Latin letters, exactly as written); the program replaces them.
- Where the course belongs in a sentence, prefer {과정} (or {course}) to retyping the title, because each recipient's course is filled in per person.
- Korean: put 님 straight after {이름} ("{이름}님은", "{이름}님께") so the particle fits any name. After {과정}, choose 을/를 to fit the given title.
- Use the issuer's name exactly as given, or leave it out. Do not translate, shorten or decorate it.
- Formal register, as on a real certificate: Korean 합니다체 ("…수료하였기에 이 증서를 드립니다", "…임을 증명합니다"); Japanese and Chinese in formal written style; English plain and formal.
- Do not invent facts that are not in the input: no hours, sessions, dates, periods, grades, scores, ranks or awards. "수료하였습니다" is fine; "120시간의 과정을 우수한 성적으로 수료" is not. Never claim or imply a licence or qualification (자격 취득, 면허, licensed, qualified) unless the title itself says so.
- No praise slop. Never use these words; the program throws away any phrase that contains one: 정성을, 정성껏, 최고의, 특별한, 자랑하, 선사하, 풍미, 가득한, 프리미엄, 진정한, 완벽한, 감동, 명품, 일품, 엄선한, 깊은 맛. No inflated praise in any language either (탁월한, 훌륭한, 눈부신, 위대한, outstanding, exceptional, remarkable, incredible). Warmth comes from plain words ("덕분에", "고맙습니다", "thank you for"), not adjectives.
- No emoji, no markdown, no quotation marks around a phrase, no line breaks inside a phrase.
- If title or issuer is empty, write phrases that do not need it."#
        }
        // 종이 명단 사진 → 표. `ai_read_image` 만 이 안내를 쓴다.
        //
        // 여기서 틀린 이름은 보기에 멀쩡해서 그대로 인쇄된다. 빈칸은 확인 표에서
        // 사람이 채우지만, 그럴듯하게 고쳐 쓴 이름은 아무도 다시 보지 않는다.
        // 그래서 「고치지 말 것」「모르면 unsure 에 넣을 것」을 가장 세게 적는다.
        "cert_roster_photo" => {
            r#"You transcribe a photo of a paper roster (an attendance sheet, a sign-up list, a class register) so a person can issue certificates from it. Produce JSON only, no prose, no markdown fence:
{"rows":[{"recipient":"","course":"","grade":"","date":"","number":"","note":""}],"unsure":[],"why":""}
A person checks every row in a table before anything is issued. A blank they can fill in; a wrong name that looks right gets printed. So when in doubt, say so. Do not smooth it over.
Fields, one row per person:
- recipient: the person's name exactly as written, in the script it is written in.
- course: the course, class or programme for that person, from their line or from the sheet's title if it names one for everyone. Else "".
- grade: a grade, level or belt written for that person (e.g. 2급, 초급). Else "".
- date: a date written for that person or for the whole sheet. Output YYYY-MM-DD only when year, month and day are all clearly readable; otherwise copy it as written. Else "".
- number: a certificate, member or registration number written for that person (e.g. PLNE-2026-001). Not a plain running count 1, 2, 3 that only numbers the lines. Else "".
- note: anything else written on that person's line, briefly and as written. Else "".
Rules:
- Transcribe exactly as written. Never guess a missing letter, never correct spelling, never translate or romanise. A ditto mark (〃, 상동, 同上) means the value on the line above; copy that value.
- Never invent rows. One row per person line, top to bottom in the sheet's order. Do not merge two lines or split one.
- Skip header rows, column titles, totals, signatures, stamps, page numbers, empty lines, and any line that is crossed out.
- If you cannot read a name confidently, write your best reading and put that row's 0-based index in "unsure". Never drop a person because the name is hard to read.
- Leave a field "" when it is not there or not readable. No placeholders like "N/A", "-", "?" or "unknown".
- At most 500 rows.
- "why" is "" for a roster. If the image is not a roster or list of people, return {"rows":[],"unsure":[],"why":"<one short Korean sentence saying what the image shows instead>"}. If it is a roster but too blurry to read, return no rows and say that in "why" in one short Korean sentence."#
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
        // 증서 문구 후보(`cert_phrases`). 슬롭이 든 후보는 빼고 나머지만 보여
        // 준다 — 셋이 다 안 남을 수 있고, 화면은 남은 것만 내놓으면 된다.
        // 예의상 고르는 후보에 「최고의」가 섞여 있으면 그대로 인쇄된다.
        if let Some(list) = obj.get_mut("phrases").and_then(Value::as_array_mut) {
            let kept: Vec<Value> = list
                .iter()
                .filter_map(Value::as_str)
                .map(str::trim)
                .filter(|s| !s.is_empty() && !is_slop(s))
                .take(3)
                .map(|s| Value::String(s.to_string()))
                .collect();
            *list = kept;
        }
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
    // 명단 사진 안내는 그림이 있어야 뜻이 있고, 결과가 사람 이름이라 따로
    // 다듬는 길(`ai_read_image`)을 탄다. 글로 부르면 그 길을 건너뛴다.
    if task == "cert_roster_photo" {
        return Err("명단 사진은 사진 읽기로 넣어 주세요.".into());
    }
    if input.trim().is_empty() {
        return Err("무엇을 만들지 적어 주세요.".into());
    }
    // A configured local OpenAI-compatible model may intentionally have no key.
    let key = if provider == "custom" {
        String::new()
    } else {
        read_key(&provider)?
    };
    let system = instructions(&task)?;

    let client = crate::ai_endpoint::client()?;
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
            let (base, model, key) = custom_request_settings()?;
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
    openai_compatible_content(client, base, model, key, system, Value::String(input.to_string()), want_json).await
}

/// Same transport, but the user turn is any JSON `content` — a plain string
/// (every text task, byte-for-byte the same body as before), or the
/// `[{"type":"text"…},{"type":"image_url"…}]` array a photo needs. One function
/// so the endpoint check, the keyless-local rule and the error shape cannot
/// drift apart between text and image calls.
#[allow(clippy::too_many_arguments)]
async fn openai_compatible_content(
    client: &reqwest::Client,
    base: &str,
    model: &str,
    key: &str,
    system: &str,
    content: Value,
    want_json: bool,
) -> Result<String, String> {
    let base = crate::ai_endpoint::validate(base, model, key)?;
    let mut body = json!({
        "model": model,
        "messages": [
            { "role": "system", "content": system },
            { "role": "user", "content": content },
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

// ── 종이 명단 사진 읽기 ─────────────────────────────────────────────────────

/// 사진은 6MB 까지. 휴대폰 사진 한 장이 넉넉히 들어가고, 그보다 크면 제공자
/// 쪽에서 먼저 거절한다.
const ROSTER_PHOTO_MAX_BYTES: usize = 6 * 1024 * 1024;
const ROSTER_PHOTO_ASK: &str = "이 명단을 표로 옮겨 주세요.";
const ROSTER_FIELDS: [&str; 6] = ["recipient", "course", "grade", "date", "number", "note"];
const ROSTER_MAX_ROWS: usize = 500;
const ROSTER_MAX_CELL: usize = 120;
const ROSTER_MAX_WHY: usize = 200;

/// 종이 명단(출석부·신청서·수강생 명단) 사진을 증서 발급 표로 옮긴다.
///
/// 🔴 사진에는 사람 이름이 적혀 있다. 그래서 이 함수는:
/// - 사용자가 단추를 **누를 때만** 불린다. 사진은 그때 한 번만 이 컴퓨터를
///   떠나고, 미리 보내거나 뒤에서 다시 보내는 일은 없다.
/// - 한 번 누르면 **정확히 한 번** 부른다. 재시도도, 다른 제공자로 넘기기도
///   없다(`ai_answer_any` 와 다르다) — 실패하면 오류를 보여 주고 멈춘다.
///   사람이 고른 제공자 한 곳 말고는 사진을 받는 곳이 없어야 한다.
/// - 사용자 **자신의 API 키**로, 사용자가 고른 제공자에게만 보낸다.
/// - 결과는 곧장 발급되지 않는다. 언제나 확인 표를 거쳐 사람이 고치고 누른다.
///   읽기 어려운 이름은 `unsure` 로 표에 표시된다.
///
/// 이름을 다루므로 `strip_slop` 을 타지 않는다 — 「최고봉」 같은 이름이 지워지면
/// 안 된다. 대신 `sanitize_roster` 가 모양만 다듬는다(칸 여섯·길이·줄 수).
#[tauri::command]
pub async fn ai_read_image(provider: String, task: String, image: String) -> Result<Value, String> {
    // 네트워크 전에 전부 거른다: 작업 → 그림 → 제공자·키.
    if task != "cert_roster_photo" {
        return Err("알 수 없는 작업입니다.".into());
    }
    let system = instructions(&task)?;
    let (bytes, mime) = crate::cert_assets::image_from_data_url(&image, ROSTER_PHOTO_MAX_BYTES)?;
    drop(image);
    // 검사를 통과한 바이트를 다시 인코딩해서 보낸다. 느슨하게 적힌 base64
    // (패딩 빠짐 등)도 통과하는 검사라, 이렇게 해야 컴퓨터를 떠나는 것이
    // 정확히 검사한 그 그림이고 제공자도 표준 base64 를 받는다.
    let b64 = crate::cert_assets::b64_encode(&bytes);
    drop(bytes);
    let data_url = format!("data:{mime};base64,{b64}");

    // A configured local OpenAI-compatible model may intentionally have no key.
    let key = if provider == "custom" { String::new() } else { read_key(&provider)? };
    let client = crate::ai_endpoint::client()?;
    let openai_content = || {
        json!([
            { "type": "text", "text": ROSTER_PHOTO_ASK },
            { "type": "image_url", "image_url": { "url": data_url } },
        ])
    };

    let text = match provider.as_str() {
        "anthropic" => {
            let body = json!({
                "model": model_for("anthropic"),
                // 한 사람에 몇십 토큰. 긴 명단은 잘릴 수 있고, 그러면 아래에서
                // 「나눠 찍어 보세요」로 알린다 — 몰래 이어 부르지 않는다.
                "max_tokens": 4000,
                "system": system,
                "messages": [{
                    "role": "user",
                    "content": [
                        { "type": "image", "source": { "type": "base64", "media_type": mime, "data": b64 } },
                        { "type": "text", "text": ROSTER_PHOTO_ASK },
                    ],
                }],
            });
            let response = client
                .post("https://api.anthropic.com/v1/messages")
                .header("x-api-key", key)
                .header("anthropic-version", "2023-06-01")
                .json(&body)
                .timeout(std::time::Duration::from_secs(120))
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
            openai_compatible_content(&client, base, &model, &key, system, openai_content(), true).await?
        }
        "google" => {
            let body = json!({
                "systemInstruction": { "parts": [{ "text": system }] },
                "contents": [{
                    "role": "user",
                    "parts": [
                        { "inline_data": { "mime_type": mime, "data": b64 } },
                        { "text": ROSTER_PHOTO_ASK },
                    ],
                }],
                "generationConfig": { "responseMimeType": "application/json" },
            });
            // The key goes in a header rather than the query string: URLs end up
            // in logs and error messages in a way headers do not.
            let response = client
                .post(format!("https://generativelanguage.googleapis.com/v1beta/models/{}:generateContent", model_for("google")))
                .header("x-goog-api-key", key)
                .json(&body)
                .timeout(std::time::Duration::from_secs(120))
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
            let (base, model, key) = custom_request_settings()?;
            openai_compatible_content(&client, &base, &model, &key, system, openai_content(), true).await?
        }
        _ => return Err("알 수 없는 제공자입니다.".into()),
    };

    // 형식이 틀리면 빈 표를 돌려주지 않는다 — 「읽었는데 아무도 없다」로 보여
    // 사람이 명단이 비었다고 믿게 된다. 오류로 알리고, 받은 글 앞부분을 붙인다.
    let unreadable = || {
        let head: String = text.chars().take(600).collect();
        format!("AI가 명단을 표로 옮기지 못했습니다. 명단이 길면 반씩 나눠 찍어 다시 눌러 보세요.\n\n{head}")
    };
    let parsed: Value = serde_json::from_str(unfence(&text)).map_err(|_| unreadable())?;
    sanitize_roster(&parsed).ok_or_else(unreadable)
}

/// Unicode "format" characters that are invisible but change how a name is
/// shown or matched: zero-width space, LRM/RLM, bidi embeddings and overrides,
/// bidi isolates, BOM. A name carrying one looks right on the certificate and
/// then fails every search. ZWJ/ZWNJ are left alone — some scripts need them.
fn is_invisible_format(c: char) -> bool {
    matches!(c, '\u{200B}' | '\u{200E}' | '\u{200F}' | '\u{202A}'..='\u{202E}' | '\u{2066}'..='\u{2069}' | '\u{FEFF}')
}

/// One cell of a transcribed roster: trimmed, no control or invisible
/// direction characters, at most `max` characters. Anything that is not text
/// becomes "" — except a number, which some models return for 번호 or 점수 and
/// which is copied as its digits.
fn roster_cell(v: Option<&Value>, max: usize) -> String {
    let raw = match v {
        Some(Value::String(s)) => s.as_str(),
        Some(Value::Number(n)) => return roster_cell(Some(&Value::String(n.to_string())), max),
        _ => return String::new(),
    };
    // A line break inside a name becomes a space, not nothing: "Kim\nMinsu"
    // is two words, and gluing them would change the name.
    let cleaned: String = raw
        .chars()
        .filter_map(|c| {
            if c.is_control() {
                c.is_whitespace().then_some(' ')
            } else if is_invisible_format(c) {
                None
            } else {
                Some(c)
            }
        })
        .collect();
    let capped: String = cleaned.trim().chars().take(max).collect();
    capped.trim_end().to_string()
}

/// Brings a model's roster reply into exactly the shape the confirmation table
/// reads: `{"rows":[{six string fields}],"unsure":[row indices],"why":""}`.
///
/// Shape only, never content — no slop filter, no spelling fixes, because every
/// value here is something written on paper about a real person. Rows that are
/// not objects or are entirely empty are dropped, and `unsure` indices are
/// moved to follow the rows that remain, so a flag never lands on the wrong
/// person. `None` when there is no `rows` array at all: an unusable reply must
/// be an error, not an empty roster.
fn sanitize_roster(v: &Value) -> Option<Value> {
    let rows_in = v.get("rows")?.as_array()?;
    let mut rows: Vec<Value> = Vec::new();
    // Model's row index → our row index, for the rows we kept.
    let mut moved: Vec<Option<usize>> = vec![None; rows_in.len()];
    for (i, row) in rows_in.iter().enumerate() {
        if rows.len() >= ROSTER_MAX_ROWS {
            break;
        }
        let Some(obj) = row.as_object() else { continue };
        let mut out = serde_json::Map::new();
        for field in ROSTER_FIELDS {
            out.insert(field.to_string(), Value::String(roster_cell(obj.get(field), ROSTER_MAX_CELL)));
        }
        if out.values().all(|x| x.as_str() == Some("")) {
            continue;
        }
        moved[i] = Some(rows.len());
        rows.push(Value::Object(out));
    }
    let mut unsure: Vec<usize> = v
        .get("unsure")
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .filter_map(Value::as_u64)
                .filter_map(|i| usize::try_from(i).ok())
                .filter_map(|i| moved.get(i).copied().flatten())
                .collect()
        })
        .unwrap_or_default();
    unsure.sort_unstable();
    unsure.dedup();
    Some(json!({
        "rows": rows,
        "unsure": unsure,
        "why": roster_cell(v.get("why"), ROSTER_MAX_WHY),
    }))
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

fn provider_available(provider: &str) -> bool {
    if provider == "custom" {
        custom_config().is_some()
    } else {
        read_key(provider).map(|k| !k.is_empty()).unwrap_or(false)
    }
}

fn try_order(preferred: &str, customer: bool) -> Vec<String> {
    // Choosing a local/custom endpoint must not silently send a failed request
    // to a cloud provider whose key happens to be stored on this computer.
    if preferred == "custom" {
        return if provider_available("custom") {
            vec!["custom".to_string()]
        } else {
            Vec::new()
        };
    }
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
    if !preferred.is_empty() && provider_available(preferred) {
        out.push(preferred.to_string());
    }
    for p in &base {
        if out.iter().any(|x| x == p) {
            continue;
        }
        if provider_available(p) {
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
    let key = if provider == "custom" { String::new() } else { read_key(&provider)? };
    if key.is_empty() && provider != "custom" {
        return Err("API 키가 저장되어 있지 않습니다.".into());
    }
    let client = crate::ai_endpoint::client()?;
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
            let (base, model, key) = custom_request_settings()?;
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
    let key = if provider == "custom" { String::new() } else { read_key(&provider)? };
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
mod cert_ai_tests {
    use super::*;

    /// 🔴 이 시험들의 제공자는 **없는 이름**이다. 거르기가 망가져 통과해 버려도
    /// 키를 읽는 자리에서 막혀, 시험이 진짜 제공자를 부를 길이 아예 없다.
    const NO_NETWORK: &str = "__no_network_in_tests__";

    fn png_url(body: &[u8]) -> String {
        format!("data:image/png;base64,{}", crate::cert_assets::b64_encode(body))
    }

    #[test]
    fn both_certificate_tasks_have_a_schema() {
        let p = instructions("cert_phrases").expect("cert_phrases 작업이 없습니다");
        assert!(p.contains("\"phrases\""), "문구 모양이 안내에 없습니다");
        assert!(p.contains("{이름}") && p.contains("{name}"), "자리표시가 안내에 없습니다");
        let r = instructions("cert_roster_photo").expect("cert_roster_photo 작업이 없습니다");
        assert!(r.contains("\"rows\"") && r.contains("\"unsure\""), "명단 모양이 안내에 없습니다");
        for f in ROSTER_FIELDS {
            assert!(r.contains(&format!("\"{f}\"")), "명단 칸 {f} 가 안내에 없습니다");
        }
    }

    /// 프롬프트의 금지어 목록과 `AI_SLOP` 이 어긋나면, 모델은 모르는 단어 때문에
    /// 문구를 통째로 버림받는다. 한쪽만 고치면 여기서 걸린다.
    #[test]
    fn the_phrase_prompt_names_every_slop_word() {
        let p = instructions("cert_phrases").unwrap();
        for w in AI_SLOP {
            assert!(p.contains(w), "금지어 「{w}」 가 cert_phrases 안내에 없습니다");
        }
    }

    #[test]
    fn slop_phrases_are_dropped_and_the_rest_kept() {
        let v = strip_slop(json!({ "phrases": [
            "  {이름}님은 {과정}을 수료하였습니다. ",
            "{이름}님의 최고의 노력에 감사드립니다.",
            "",
            7,
            "위 사람은 {과정}을 마쳤음을 증명합니다.",
            "{이름}님께 고마운 마음을 전합니다.",
            "넷째 후보는 버립니다.",
        ]}));
        assert_eq!(
            v["phrases"],
            json!([
                "{이름}님은 {과정}을 수료하였습니다.",
                "위 사람은 {과정}을 마쳤음을 증명합니다.",
                "{이름}님께 고마운 마음을 전합니다.",
            ])
        );
    }

    #[tokio::test]
    async fn a_wrong_task_is_refused_before_anything_else() {
        let png = png_url(b"\x89PNG\r\n\x1a\n\0\0\0\0");
        for task in ["cert_phrases", "shop", "", "CERT_ROSTER_PHOTO"] {
            let e = ai_read_image(NO_NETWORK.into(), task.into(), png.clone()).await.unwrap_err();
            assert_eq!(e, "알 수 없는 작업입니다.", "작업 {task:?}");
        }
    }

    #[tokio::test]
    async fn only_real_png_or_jpeg_leaves_the_checks() {
        let svg = format!(
            "data:image/svg+xml;base64,{}",
            crate::cert_assets::b64_encode(b"<svg xmlns=\"http://www.w3.org/2000/svg\"><script>alert(1)</script></svg>")
        );
        let bad = [
            "data:text/plain;base64,aGVsbG8=".to_string(),
            "https://example.invalid/roster.png".to_string(),
            "".to_string(),
            svg,
            // PNG 라고 적었지만 속은 GIF.
            png_url(b"GIF89a\x01\0\x01\0\0\0\0"),
            // JPEG 라고 적었지만 머리가 없다.
            format!("data:image/jpeg;base64,{}", crate::cert_assets::b64_encode(b"not a jpeg")),
            "data:image/png;base64,@@@@".to_string(),
        ];
        for url in bad {
            let e = ai_read_image(NO_NETWORK.into(), "cert_roster_photo".into(), url.clone()).await.unwrap_err();
            assert!(e.contains("그림"), "{url:.40} 이 그림 검사에서 걸리지 않았습니다: {e}");
        }
    }

    /// 거르기가 진짜 PNG 까지 막으면 기능이 죽는다. 통과한 뒤 모르는 제공자에서
    /// 멈추는지 본다 — 여기도 네트워크 전이다.
    #[tokio::test]
    async fn a_real_png_passes_and_an_unknown_provider_stops_it() {
        let e = ai_read_image(NO_NETWORK.into(), "cert_roster_photo".into(), png_url(b"\x89PNG\r\n\x1a\n\0\0\0\0"))
            .await
            .unwrap_err();
        assert_eq!(e, "알 수 없는 제공자입니다.");
    }

    #[tokio::test]
    async fn the_roster_task_cannot_go_through_the_text_path() {
        let e = ai_fill(NO_NETWORK.into(), "cert_roster_photo".into(), "홍길동".into()).await.unwrap_err();
        assert!(e.contains("사진"), "{e}");
    }

    #[test]
    fn the_sanitiser_keeps_six_string_fields_only() {
        let v = sanitize_roster(&json!({
            "rows": [{
                "recipient": "  김하늘 ",
                "course": "필라테스 지도자 과정",
                "grade": 2,
                "date": "2026-09-24",
                "number": null,
                "note": "우수",
                "phone": "010-0000-0000",
                "photo": "x.jpg",
            }],
            "unsure": [],
            "why": "",
            "extra": true,
        }))
        .unwrap();
        assert_eq!(
            v,
            json!({
                "rows": [{
                    "recipient": "김하늘", "course": "필라테스 지도자 과정", "grade": "2",
                    "date": "2026-09-24", "number": "", "note": "우수",
                }],
                "unsure": [],
                "why": "",
            })
        );
    }

    #[test]
    fn the_sanitiser_caps_rows_and_cells() {
        let rows: Vec<Value> = (0..600).map(|i| json!({ "recipient": format!("사람{i}") })).collect();
        let v = sanitize_roster(&json!({ "rows": rows, "unsure": [499, 500, 599] })).unwrap();
        assert_eq!(v["rows"].as_array().unwrap().len(), ROSTER_MAX_ROWS);
        assert_eq!(v["rows"][499]["recipient"], json!("사람499"));
        assert_eq!(v["unsure"], json!([499]), "잘린 줄을 가리키는 표시는 남으면 안 됩니다");

        let long = "가".repeat(300);
        let v = sanitize_roster(&json!({ "rows": [{ "recipient": long, "note": "a\u{0}b\tc\u{202E}d\u{200B}e" }], "why": "x".repeat(500) })).unwrap();
        assert_eq!(v["rows"][0]["recipient"].as_str().unwrap().chars().count(), ROSTER_MAX_CELL);
        assert_eq!(v["rows"][0]["note"], json!("ab cde"));
        assert_eq!(v["why"].as_str().unwrap().chars().count(), ROSTER_MAX_WHY);
    }

    #[test]
    fn unsure_follows_the_rows_that_remain() {
        let v = sanitize_roster(&json!({
            "rows": [
                { "recipient": "가" },
                "not a row",
                { "recipient": "", "course": "  " },
                { "recipient": "나" },
                { "recipient": "다" },
            ],
            // 3 = 「나」, 4 = 「다」. 1·2 는 버린 줄, 나머지는 잘못된 값.
            "unsure": [4, 3, 3, 1, 2, -1, 5, 99, "0", 0.5, null],
        }))
        .unwrap();
        let names: Vec<&str> = v["rows"].as_array().unwrap().iter().map(|r| r["recipient"].as_str().unwrap()).collect();
        assert_eq!(names, ["가", "나", "다"]);
        assert_eq!(v["unsure"], json!([1, 2]), "표시가 다른 사람에게 옮겨 붙었습니다");
    }

    /// 이 길은 `strip_slop` 을 타지 않는다. 이름·비고에 「최고」「정성을」이
    /// 들어 있어도 한 글자도 바뀌면 안 된다.
    #[test]
    fn names_with_slop_words_are_untouched() {
        let v = sanitize_roster(&json!({
            "rows": [
                { "recipient": "최고봉", "note": "최고의 정성을 다함" },
                { "recipient": "정성을", "course": "특별한 과정" },
            ],
            "unsure": [0],
        }))
        .unwrap();
        assert_eq!(v["rows"][0]["recipient"], json!("최고봉"));
        assert_eq!(v["rows"][0]["note"], json!("최고의 정성을 다함"));
        assert_eq!(v["rows"][1]["recipient"], json!("정성을"));
        assert_eq!(v["rows"][1]["course"], json!("특별한 과정"));
        assert_eq!(v["unsure"], json!([0]));
    }

    #[test]
    fn a_reply_without_rows_is_an_error_not_an_empty_roster() {
        assert!(sanitize_roster(&json!([{ "recipient": "가" }])).is_none());
        assert!(sanitize_roster(&json!({ "people": [] })).is_none());
        assert!(sanitize_roster(&json!({ "rows": "가, 나" })).is_none());
        let empty = sanitize_roster(&json!({ "rows": [], "unsure": [], "why": "명단이 아니라 풍경 사진입니다." })).unwrap();
        assert_eq!(empty["rows"], json!([]));
        assert_eq!(empty["why"], json!("명단이 아니라 풍경 사진입니다."));
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
    fn custom_keyless_stays_local_even_when_cloud_keys_exist() {
        with_home("rv-custom-local", || {
            save_custom_provider("Synthetic local".into(), "http://127.0.0.1:11434/v1".into(), "synthetic".into(), "".into()).unwrap();
            save_api_key("openai".into(), "synthetic-not-a-real-key".into()).unwrap();
            assert_eq!(try_order("custom", false), vec!["custom"]);
            assert_eq!(try_order("custom", true), vec!["custom"]);
            assert!(custom_request_settings().unwrap().2.is_empty());
            delete_api_key("custom".into()).unwrap();
            assert!(try_order("custom", false).is_empty(), "An unavailable selected local provider must not switch to cloud");
        });
    }

    #[test]
    #[ignore]
    fn custom_destination_change_does_not_reuse_a_previous_key() {
        with_home("rv-custom-origin", || {
            save_custom_provider("Synthetic".into(), "https://alpha.example/v1".into(), "synthetic-a".into(), "synthetic-not-a-real-key".into()).unwrap();
            save_custom_provider("Synthetic".into(), "https://alpha.example/v1".into(), "synthetic-b".into(), "".into()).unwrap();
            assert_eq!(custom_request_settings().unwrap().2, "synthetic-not-a-real-key", "A model-only edit must preserve the same endpoint key");
            save_custom_provider("Synthetic".into(), "https://beta.example/v1".into(), "synthetic-b".into(), "".into()).unwrap();
            let (base, _, key) = custom_request_settings().unwrap();
            assert_eq!(base, "https://beta.example/v1");assert!(key.is_empty(), "A new destination must never inherit a previous key");
            assert!(save_custom_provider("Synthetic".into(), "http://192.168.1.5:8000/v1".into(), "synthetic".into(), "synthetic-not-a-real-key".into()).is_err());
            assert_eq!(custom_request_settings().unwrap().0, "https://beta.example/v1");
            assert!(read_key("../unknown").is_err());
        });
    }

    #[cfg(unix)]
    #[test]
    #[ignore]
    fn custom_key_is_private_at_creation_and_failure_preserves_existing_files() {
        use std::os::unix::fs::PermissionsExt;
        with_home("rv-custom-private", || {
            save_custom_provider("Synthetic".into(), "https://alpha.example/v1".into(), "synthetic".into(), "synthetic-not-a-real-key".into()).unwrap();
            assert_eq!(std::fs::metadata(key_path("custom")).unwrap().permissions().mode() & 0o777, 0o600);
            let config = std::fs::read(config_dir().join("custom.json")).unwrap();
            let destination = config_dir().join("synthetic-directory");std::fs::create_dir(&destination).unwrap();
            assert!(write_private(&destination, b"synthetic").is_err());
            assert_eq!(std::fs::read(config_dir().join("custom.json")).unwrap(), config);
            assert_eq!(custom_request_settings().unwrap().2, "synthetic-not-a-real-key");
            assert!(std::fs::read_dir(config_dir()).unwrap().all(|entry| !entry.unwrap().file_name().to_string_lossy().contains("pending-")));
        });
    }

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
        "You are the assistant inside RavenVault Desktop, talking to the shop owner in Korean.\n\
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

#[cfg(test)]
mod point_tests {
    /// 🔴 **라비가 아는 자리와 화면이 가진 자리가 같아야 한다.**
    ///
    /// 라비에게 「이 이름들만 쓰라」고 적어 놓고 화면이 그 이름을 모르면,
    /// 사장은 「라비가 시킨 대로 했는데 아무 일도 안 난다」를 겪는다.
    /// 그게 이 저장소에서 오늘만 스무 번 나온 병이고, 라비가 하면 더 나쁘다 —
    /// 사람은 프로그램이 고장 났다고 생각하지 않고 자기가 잘못했다고 생각한다.
    #[test]
    fn 라비가_아는_자리를_화면도_안다() {
        let prompt = include_str!("ai.rs");
        let ui = include_str!("../../src/main.ts");
        // 프롬프트에 적어 둔 목록을 뽑는다.
        let i = prompt.find("\"spot\" MUST be one of these").expect("목록 안내가 있어야 한다");
        let end = prompt[i..].find("Say in \"reply\"").expect("목록 끝을 못 찾음");
        let listed: Vec<&str> = prompt[i..i + end]
            .split('·')
            .flat_map(|x| x.split('\n'))
            .map(str::trim)
            .filter(|x| {
                !x.is_empty()
                    && x.chars().next().is_some_and(|c| ('가'..='힣').contains(&c))
            })
            .collect();
        assert!(listed.len() >= 8, "목록을 제대로 못 읽었다: {listed:?}");
        for name in listed {
            assert!(
                ui.contains(&format!("\"{name}\":")),
                "라비는 「{name}」을 가리킬 수 있다고 배웠는데 화면에 그 자리가 없다 — \
                 사장이 시킨 대로 했는데 아무 일도 안 난다"
            );
        }
    }

    /// ⚠️ **라비가 대신 누르면 안 된다.** 돈이 나가는 일이 섞여 있다.
    #[test]
    fn 라비는_누르지_않는다() {
        let ui = include_str!("../../src/main.ts");
        let i = ui.find("case \"point\":").expect("가리키기가 있어야 한다");
        let seg = &ui[i..i + 400.min(ui.len() - i)];
        assert!(
            !seg.contains(".click()"),
            "라비가 단추를 대신 누르고 있다 — 승인은 사람이 해야 한다"
        );
    }

#[cfg(test)]
mod 양방향 {
    /// 🔴 여태 검사는 **한 방향만** 봤다: 「AI 가 아는 이름이 화면에 있나」.
    ///
    /// 그래서 화면에 새 자리를 넣어도 **AI 는 모른 채로 통과**했다.
    /// 오늘 「나눠주기」·「내 가게」가 정확히 그렇게 빠져 있었다 —
    /// 누가 "자산 가진 사람들한테 나눠주려면 어디로 가?" 하고 물으면
    /// 라비가 **아무 데도 못 가리켰다.**
    ///
    /// 대표님: "라비가 이걸 어떻게 사용하는지도 다 설명이 가능해야해"
    #[test]
    fn 양쪽_다_안다() {
        let ts = include_str!("../../src/main.ts");
        // ⚠️ **주석을 빼고 본다.** 이 검사의 설명글에 「나눠주기」라고 적혀
        //    있으면 `contains` 가 늘 참이 되어 **아무것도 안 잡는다.**
        //    (이 파일에서 실제로 그랬다 — 오늘 여섯 번째 같은 함정이다.)
        let ai: String = include_str!("ai.rs")
            .lines()
            .filter(|l| {
                let t = l.trim_start();
                !t.starts_with("//") && !t.starts_with("///")
            })
            .collect::<Vec<_>>()
            .join("\n");
        // main.ts 의 RAVI_SPOTS 열쇠들
        // ⚠️ **한 줄짜리만 보면 안 된다.** `RAVI_SPOTS` 항목은 짧으면 한 줄,
        //    길면 여러 줄로 적힌다. 처음 만든 검사는 한 줄만 봐서, 오늘 새로
        //    넣은 「나눠주기」(여러 줄)를 **놓쳤다** — 일부러 깨뜨려 보고 나서야
        //    알았다. 검사를 넣었으면 **깨뜨려 보고 잡히는지** 확인해야 한다.
        let blk = ts
            .split("const RAVI_SPOTS")
            .nth(1)
            .and_then(|r| r.split("\n};").next())
            .unwrap_or("");
        let mut 화면 = vec![];
        for line in blk.lines() {
            let t = line.trim_start();
            if t.starts_with("//") {
                continue;
            }
            if let Some(rest) = t.strip_prefix('"') {
                if let Some(end) = rest.find("\": {") {
                    화면.push(rest[..end].to_string());
                }
            }
        }
        assert!(화면.len() >= 10, "RAVI_SPOTS 를 못 읽었습니다: {}", 화면.len());
        for name in &화면 {
            assert!(
                ai.as_str().contains(name.as_str()),
                "화면에는 「{name}」 자리가 있는데 **라비는 모릅니다.** \
                 ai.rs 의 안내 목록에 넣어 주세요 — 모르는 곳은 가리킬 수 없습니다."
            );
        }
    }
}
}
