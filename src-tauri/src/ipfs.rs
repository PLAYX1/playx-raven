//! Talks to a local IPFS (kubo) daemon over its HTTP API.
//!
//! Every call is a POST, including the read-only ones — kubo rejects GET on the
//! API port to make cross-site requests from a browser harmless.
//!
//! Going through a local daemon rather than a public gateway is not only about
//! speed. Asking ipfs.io for each asset image tells that gateway exactly which
//! assets this wallet holds, which is a fingerprint nobody needs to hand out.

use serde_json::{json, Value};

const API: &str = "http://127.0.0.1:5001/api/v0";

async fn post(path: &str) -> Result<reqwest::Response, String> {
    reqwest::Client::new()
        .post(format!("{API}/{path}"))
        .send()
        .await
        .map_err(|e| format!("IPFS daemon is not reachable: {e}"))
}

/// Whether the daemon is up, and which version.
#[tauri::command]
pub async fn ipfs_status() -> Result<Value, String> {
    match post("id").await {
        Ok(r) => {
            let v: Value = r
                .json()
                .await
                .map_err(|e| format!("IPFS returned something unexpected: {e}"))?;
            // 🔴 **몇 곳과 이어져 있나.** 켜져 있다는 것만으로는 부족하다 —
            // 아무와도 안 이어진 파일창고는 켜져 있어도 사진을 못 나른다.
            // 못 세도 나머지는 보여야 하므로 실패는 `null` 이다.
            let peer_count = match post("swarm/peers").await {
                Ok(r) => r
                    .json::<Value>()
                    .await
                    .ok()
                    .and_then(|j| j.get("Peers").and_then(Value::as_array).map(|a| a.len() as i64)),
                Err(_) => None,
            };
            Ok(json!({
                "running": true,
                "peers": peer_count,
                "id": v.get("ID").and_then(Value::as_str).unwrap_or(""),
                "version": v.get("AgentVersion").and_then(Value::as_str).unwrap_or(""),
            }))
        }
        Err(_) => Ok(json!({ "running": false })),
    }
}

/// Is this CID retrievable right now?
///
/// Asks for a single byte rather than the whole file: the question is whether
/// anyone still has the content, and pulling a 40 MB image to answer it would
/// be wasteful. A timeout counts as dead — IPFS has no way to say "nobody has
/// this", it simply keeps looking, so waiting longer only delays the same answer.
#[tauri::command]
pub async fn check_alive(cid: String, timeout_secs: u64) -> Result<bool, String> {
    let response = reqwest::Client::new()
        .post(format!("{API}/cat?arg={cid}&length=1"))
        .timeout(std::time::Duration::from_secs(timeout_secs))
        .send()
        .await;

    Ok(matches!(response, Ok(r) if r.status().is_success()))
}

/// Pin a CID so this node keeps a copy.
///
/// Content that is merely cached gets swept away by garbage collection; pinned
/// content does not. This is the difference between "someone happens to have it
/// today" and "it survives".
#[tauri::command]
pub async fn pin_add(cid: String) -> Result<bool, String> {
    let response = reqwest::Client::new()
        .post(format!("{API}/pin/add?arg={cid}"))
        // Pinning fetches the whole object, which can take a while for large
        // files or poorly-seeded ones.
        .timeout(std::time::Duration::from_secs(300))
        .send()
        .await
        .map_err(|e| format!("Pinning failed: {e}"))?;

    if !response.status().is_success() {
        let detail = response.text().await.unwrap_or_default();
        return Err(format!("IPFS refused to pin {cid}: {detail}"));
    }
    Ok(true)
}

/// Stop keeping a copy. The file stays reachable as long as some other node
/// still holds it — this only releases our own storage.
#[tauri::command]
pub async fn pin_remove(cid: String) -> Result<bool, String> {
    let response = post(&format!("pin/rm?arg={cid}")).await?;
    if !response.status().is_success() {
        let detail = response.text().await.unwrap_or_default();
        return Err(format!("Could not unpin {cid}: {detail}"));
    }
    Ok(true)
}

/// Everything this node is currently pinning, as a flat list of CIDs.
#[tauri::command]
pub async fn pin_list() -> Result<Vec<String>, String> {
    let response = post("pin/ls?type=recursive").await?;
    let v: Value = response
        .json()
        .await
        .map_err(|e| format!("Could not read the pin list: {e}"))?;

    Ok(v.get("Keys")
        .and_then(Value::as_object)
        .map(|keys| keys.keys().cloned().collect())
        .unwrap_or_default())
}

/// What kind of file a CID points at, so the UI can decide whether to show it
/// inline or just offer to open it.
///
/// Reads the Content-Type from the local gateway rather than sniffing bytes
/// ourselves — kubo already does that work. Everything is served from
/// 127.0.0.1, so no public gateway learns which assets this wallet holds.
#[tauri::command]
pub async fn content_kind(cid: String) -> Result<Value, String> {
    let response = reqwest::Client::new()
        .head(format!("http://127.0.0.1:8080/ipfs/{cid}"))
        .timeout(std::time::Duration::from_secs(25))
        .send()
        .await
        .map_err(|e| format!("Could not reach the local gateway: {e}"))?;

    if !response.status().is_success() {
        return Ok(json!({ "available": false }));
    }

    let mime = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("application/octet-stream")
        .split(';')
        .next()
        .unwrap_or("")
        .to_string();

    let size = response
        .headers()
        .get(reqwest::header::CONTENT_LENGTH)
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.parse::<u64>().ok());

    // A directory answers as text/html — the gateway renders an index page. That
    // is a listing, not content, so ask the API what is actually inside instead
    // of showing the user a rendered file browser.
    let entries = if mime == "text/html" {
        dir_entries(&cid).await.unwrap_or_default()
    } else {
        Vec::new()
    };
    let is_dir = !entries.is_empty();

    // RIP-0014 metadata is a plain JSON file at the asset's own hash. Reading it
    // here means the panel can show a real name and description instead of a
    // wall of JSON — which is what an asset like FORGED_IN_FIRE currently is.
    let metadata = if mime == "application/json" && size.unwrap_or(u64::MAX) < 2_000_000 {
        fetch_json(&format!("http://127.0.0.1:8080/ipfs/{cid}")).await
    } else {
        None
    };

    Ok(json!({
        "available": true,
        "mime": mime,
        "size": size,
        "is_image": mime.starts_with("image/"),
        // Video and audio stream from the local gateway, which answers range
        // requests (verified: 206 + accept-ranges), so seeking works and the
        // whole file is not pulled before the first frame.
        "is_video": mime.starts_with("video/"),
        "is_audio": mime.starts_with("audio/"),
        "is_pdf": mime == "application/pdf",
        "is_dir": is_dir,
        "entries": entries,
        "metadata": metadata,
        // Served locally, so this URL is safe to put straight into an <img>.
        "url": format!("http://127.0.0.1:8080/ipfs/{cid}"),
    }))
}

/// What is inside a directory CID.
///
/// One CID can hold a whole folder — a 3D model, its preview image, and a
/// metadata file — which is how an asset points at more than one file without
/// needing anything added to the chain.
async fn dir_entries(cid: &str) -> Option<Vec<Value>> {
    let response = reqwest::Client::new()
        .post(format!("http://127.0.0.1:5001/api/v0/ls?arg={cid}"))
        .timeout(std::time::Duration::from_secs(25))
        .send()
        .await
        .ok()?;

    let parsed: Value = response.json().await.ok()?;
    let links = parsed
        .get("Objects")?
        .as_array()?
        .first()?
        .get("Links")?
        .as_array()?;

    Some(
        links
            .iter()
            .map(|l| {
                let name = l.get("Name").and_then(Value::as_str).unwrap_or("");
                json!({
                    "name": name,
                    "hash": l.get("Hash").and_then(Value::as_str).unwrap_or(""),
                    "size": l.get("Size").and_then(Value::as_u64).unwrap_or(0),
                    // Type 1 is a directory, 2 is a file.
                    "is_dir": l.get("Type").and_then(Value::as_u64) == Some(1),
                })
            })
            .collect(),
    )
}

async fn fetch_json(url: &str) -> Option<Value> {
    reqwest::Client::new()
        .get(url)
        .timeout(std::time::Duration::from_secs(25))
        .send()
        .await
        .ok()?
        .json()
        .await
        .ok()
}

/// Pulls the readable parts out of RIP-0014 metadata.
///
/// The standard has no field for other languages — `asset_data.name` is one
/// string. So a Korean or Japanese name has to live in `other_data`, which the
/// spec leaves open for exactly this. Wallets that do not know about it ignore
/// the extra keys and still show the English name, which is the behaviour we
/// want: adding a Korean name must never make the asset look broken elsewhere.
#[tauri::command]
pub fn read_metadata(doc: Value, lang: String) -> Value {
    let m = doc
        .get("rip0014")
        .and_then(|r| r.get("metadata"))
        .unwrap_or(&doc);

    let asset = m.get("asset_data");
    let other = m.get("other_data");

    let localized = |base: &str| -> Option<String> {
        // other_data.name_ko wins over asset_data.name when we have it.
        other
            .and_then(|o| o.get(format!("{base}_{lang}")))
            .and_then(Value::as_str)
            .or_else(|| asset.and_then(|a| a.get(base)).and_then(Value::as_str))
            .map(str::to_string)
    };

    json!({
        "name": localized("name"),
        "description": localized("description"),
        // Icons are inline base64 data URIs in this standard, not IPFS hashes.
        "icon": asset.and_then(|a| a.get("icon")).and_then(Value::as_str),
        "keywords": asset.and_then(|a| a.get("keywords")).and_then(Value::as_str),
        "website": m.get("admin_data").and_then(|a| a.get("website_url")).and_then(Value::as_str),
        "issuer": m.get("admin_data").and_then(|a| a.get("issuer")).and_then(Value::as_str),
        // Both attachment forms the spec defines, so a viewer does not have to
        // guess which one an issuer used.
        "attachments": m.get("ipfs_attachments").cloned().unwrap_or(json!([])),
    })
}

/// Hands a local gateway URL to the system browser.
///
/// Rendering arbitrary PDFs and documents inside a wallet-adjacent window is not
/// worth the attack surface, and the OS already has viewers for all of it.
/// Only localhost URLs are accepted — this must never become a way to open
/// something arbitrary from a asset's metadata.
#[tauri::command]
pub async fn open_external(url: String) -> Result<(), String> {
    // 🔴 여태 IPFS 주소 하나만 허용했다. 그래서 「열쇠 받기」·「채굴기 받기」를
    // 누르면 **"Refusing to open a non-local URL"** 이 떴다 — 사장은 무슨 말인지
    // 알 수 없고, 열쇠를 못 받으니 라비도 못 깨운다.
    //
    // 아무 주소나 열면 안 되는 이유는 그대로다: 이 함수는 화면이 준 글자를
    // 그대로 받는데, 화면에는 자산 발행자가 적은 남의 글자가 섞인다. 그래서
    // **우리가 아는 곳만** 연다. 목록에 없는 곳은 열지 않는다.
    const ALLOWED: &[&str] = &[
        "http://127.0.0.1:8080/ipfs/",       // 우리 IPFS 게이트웨이
        "https://console.groq.com/",         // 열쇠 받기 — Groq
        "https://console.anthropic.com/",    // 열쇠 받기 — Anthropic
        "https://console.x.ai/",             // 열쇠 받기 — xAI
        "https://aistudio.google.com/",      // 열쇠 받기 — Google (…/apikey)
        "https://platform.openai.com/",      // 열쇠 받기 — OpenAI
        "https://openrouter.ai/",            // 열쇠 받기 — OpenRouter
        "https://ollama.com/",               // 내 컴퓨터의 AI
        "https://lmstudio.ai/",              // 내 컴퓨터의 AI
        "https://github.com/trexminer/",     // 채굴기 받기
        "https://github.com/todxx/",         // 채굴기 받기
        "https://www.ravencoin.org/",        // 레이븐코인 공식
        "https://rvn.ex.erci.se/",           // 우리 사이트
    ];
    if !ALLOWED.iter().any(|p| url.starts_with(p)) {
        // 오류 문구도 한국어로. 영어 원문은 사장에게 아무것도 알려주지 않는다.
        return Err(format!(
            "이 주소는 열지 않습니다. 우리가 아는 곳만 엽니다.\n{url}"
        ));
    }

    // Call `open` directly rather than going through a helper crate. The same
    // question came up while fixing the Ravencoin wallet: on macOS the tidy
    // abstraction reported success while nothing opened, and `open` is the call
    // that actually works and actually reports failure.
    #[cfg(target_os = "macos")]
    {
        let status = std::process::Command::new("/usr/bin/open")
            .arg(&url)
            .status()
            .map_err(|e| format!("Could not run /usr/bin/open: {e}"))?;
        if !status.success() {
            return Err(format!("/usr/bin/open exited with {status}"));
        }
        return Ok(());
    }

    #[cfg(not(target_os = "macos"))]
    {
        open::that(&url).map_err(|e| format!("Could not open it: {e}"))
    }
}

/// How much space the local IPFS store is using.
#[tauri::command]
pub async fn repo_size() -> Result<Value, String> {
    let response = post("repo/stat").await?;
    let v: Value = response
        .json()
        .await
        .map_err(|e| format!("Could not read repo stats: {e}"))?;

    Ok(json!({
        "used_bytes": v.get("RepoSize").and_then(Value::as_u64).unwrap_or(0),
        "max_bytes": v.get("StorageMax").and_then(Value::as_u64).unwrap_or(0),
        "objects": v.get("NumObjects").and_then(Value::as_u64).unwrap_or(0),
    }))
}

/// 사진·메뉴판을 얼마까지 둘지 정한다.
///
/// 🔴 「쉬운 설정」이 이걸 부른다. **여기서 조용히 실패하면 화면의 "다 됐습니다"
/// 가 거짓말이 된다** — 그래서 실패를 삼키지 않고 그대로 돌려준다.
///
/// IPFS 는 이 값을 `Datastore.StorageMax` 에 문자열로 둔다(`"15GB"`). 숫자로
/// 넣으면 데몬이 조용히 무시한다 — 화면에는 바뀐 것처럼 보이고 실제로는
/// 안 바뀐다.
///
/// ⚠️ 바뀐 값은 **데몬을 다시 켜야** 적용된다. 그 사실을 같이 돌려준다.
/// "설정했습니다" 만 말하고 안 되어 있으면 그게 제일 나쁘다.
#[tauri::command]
pub async fn ipfs_set_storage_max(gb: f64) -> Result<Value, String> {
    // 5GB 아래면 사진 몇 장에 차 버려서 "왜 사진이 안 올라가지" 가 된다.
    // 위쪽은 디스크를 통째로 먹지 않게 막는다.
    if !(5.0..=500.0).contains(&gb) {
        return Err("5GB 에서 500GB 사이로 정해 주세요.".into());
    }
    let want = format!("{}GB", gb.round() as i64);
    let r = reqwest::Client::new()
        .post(format!("{API}/config?arg=Datastore.StorageMax&arg={want}"))
        .send()
        .await
        .map_err(|e| format!("IPFS 에 닿지 못했습니다: {e}"))?;
    if !r.status().is_success() {
        return Err(format!("IPFS 가 거절했습니다({}).", r.status()));
    }
    Ok(json!({ "storage_max": want, "needs_restart": true }))
}
