//! Putting files into IPFS so an asset can point at them.
//!
//! Everything added here is pinned immediately. An unpinned file survives only
//! until the next garbage collection, and an asset pointing at a collected file
//! is an asset whose picture is gone — which is the exact failure this whole
//! app exists to prevent.
//!
//! One hard constraint from the chain: Ravencoin stores a 34-byte IPFS hash and
//! validates that it re-encodes to a 46-character `Qm…` string
//! (assets/assets.cpp: `CheckEncoded`). That is CIDv0. A CIDv1 hash is longer,
//! will not fit, and the node rejects the issue transaction — so every add here
//! forces `cid-version=0` rather than trusting the daemon's default, which a
//! user's own IPFS config can change.

use serde::Deserialize;
use serde_json::{json, Value};

const API: &str = "http://127.0.0.1:5001/api/v0";

/// One file on its way into IPFS.
#[derive(Deserialize)]
pub struct Incoming {
    pub name: String,
    pub bytes: Vec<u8>,
}

#[derive(Deserialize)]
struct AddedLine {
    #[serde(rename = "Name")]
    name: String,
    #[serde(rename = "Hash")]
    hash: String,
}

/// The add endpoint answers with newline-delimited JSON, one line per object it
/// created — every file, then every enclosing directory, deepest first.
fn parse_added(body: &str) -> Vec<AddedLine> {
    body.lines()
        .filter(|l| !l.trim().is_empty())
        .filter_map(|l| serde_json::from_str::<AddedLine>(l).ok())
        .collect()
}

async fn post_multipart(query: &str, form: reqwest::multipart::Form) -> Result<String, String> {
    let response = reqwest::Client::new()
        .post(format!("{API}/add?{query}"))
        .multipart(form)
        // Large files over localhost are still not instant, and a timeout that
        // fires mid-upload leaves a half-added file the user cannot see.
        .timeout(std::time::Duration::from_secs(600))
        .send()
        .await
        .map_err(|e| format!("IPFS에 올리지 못했습니다: {e}"))?;

    if !response.status().is_success() {
        return Err(format!("IPFS가 거부했습니다: {}", response.status()));
    }

    response
        .text()
        .await
        .map_err(|e| format!("IPFS 응답을 읽지 못했습니다: {e}"))
}

/// Adds a single file and returns its CIDv0.
#[tauri::command]
pub async fn ipfs_add_file(file: Incoming) -> Result<Value, String> {
    let size = file.bytes.len() as u64;
    let part = reqwest::multipart::Part::bytes(file.bytes).file_name(file.name.clone());
    let form = reqwest::multipart::Form::new().part("file", part);

    let body = post_multipart("pin=true&cid-version=0", form).await?;
    let added = parse_added(&body);
    let hash = added
        .last()
        .map(|a| a.hash.clone())
        .ok_or_else(|| "IPFS가 해시를 돌려주지 않았습니다".to_string())?;

    Ok(json!({ "cid": hash, "name": file.name, "size": size }))
}

/// Turns a menu document into a page anyone can open.
///
/// Deliberately one file with no scripts and no external anything: it has to
/// render from an IPFS gateway on a phone with no network beyond the shop's
/// wifi, and anything fetched from elsewhere would simply not arrive.
///
/// Image paths are relative — `./QmXXX` resolves inside the same directory when
/// the pictures were uploaded with the menu, and falls back to the gateway path
/// otherwise. Returns `None` for anything that is not a menu, so other kinds of
/// bundle are unaffected.
/// 자산 한 장. 주소를 열면 **표지와 내용이 보이게** 한다.
///
/// 🔴 왜 필요한가(실측 2026-09-08): 먼저 낸 곡 셋은 체인에 그림조차 없어서
///    (`has_ipfs:0`) 산 사람 지갑에는 `PLAYX/SONG/INEVITABLE 100` 이라는
///    **글자만** 보인다. 대표: "자산으로 주면 노래도 나오고 앨범 표지도 있고
///    가사도 있고 좀 뭐가 있어야 하는 거 아냐?"
///
/// 🔴 **우리가 없어져도 남아야 한다.** 이 프로젝트가 수수료를 가르는 기준이
///    「우리가 빠져도 되는가」다. 그래서 표지·내용을 **IPFS 폴더 안에** 두고,
///    우리 페이지 주소는 「있는 동안 더 볼 수 있는 곳」으로만 덧붙인다.
///
/// 🔴 **직접 고친 것이 있으면 그것을 그대로 쓴다**(`html`). 대표: "내 마음대로
///    수정도 가능하고" — 템플릿은 시작점이지 감옥이 아니다.
///
/// ⚠️ 노래·책 파일 자체는 안 넣는다. 곡당 3~5MB 를 영구히 드는 것은 별도 결정이다.
fn render_song(doc: &Value) -> Option<String> {
    let a = doc.get("playx_asset").or_else(|| doc.get("playx_song"))?;
    let g = |k: &str| a.get(k).and_then(Value::as_str).unwrap_or("").to_string();

    // 손으로 고친 것이 있으면 템플릿을 건너뛴다.
    let 손질 = g("html");
    if !손질.trim().is_empty() {
        return Some(손질);
    }

    let esc = |s: &str| {
        s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;")
    };
    let title = g("title");
    if title.is_empty() {
        return None;
    }
    let kind = g("kind");
    let maker = g("maker");
    let cover = g("cover");
    let body = g("body");          // 가사·소개·설명 — 종류마다 부르는 이름이 다르다
    let credits = g("credits");
    let listen = g("listen");
    let asset = g("asset");
    let note = g("note");          // 티켓의 날짜·장소 같은 한 줄

    /* 🔴 화면에서 고른 것과 여기서 굽는 것이 **같은 표**를 써야 한다 —
       미리보기와 실제가 다르면 미리보기가 거짓말이 된다.
       (같은 네 가지가 `main.ts` 의 `느낌표` 에도 있다. 하나를 고치면 둘 다 고친다.) */
    let (bg, fg, dim, accent) = match g("theme").as_str() {
        "paper" => ("#f4f1ea", "#1c1b18", "#6b675e", "#8a5a2b"),
        "warm"  => ("#241a17", "#f2e6dc", "#b79a86", "#e2915c"),
        "mint"  => ("#0f1f1c", "#e4f2ec", "#8fb3a8", "#5fd0a8"),
        _       => ("#12141c", "#e9e5da", "#9fb3ad", "#7fd6c0"),
    };

    // 종류마다 부르는 이름이 다르다. 「가사」라고 적힌 책은 이상하다.
    let (본문제목, 만든이제목, 표지비율) = match kind.as_str() {
        "book"   => ("소개", "지은이", "3 / 4"),
        "ticket" => ("안내", "여는 곳", "16 / 9"),
        "game"   => ("설명", "만든 사람", "1 / 1"),
        _        => ("가사", "만든 사람", "1 / 1"),
    };

    let 본문 = if body.trim().is_empty() {
        String::new()
    } else {
        format!("<h2>{}</h2><pre class=\"ly\">{}</pre>", 본문제목, esc(&body))
    };
    let 크레딧 = if credits.trim().is_empty() {
        String::new()
    } else {
        format!("<h2>{}</h2><pre class=\"ly\">{}</pre>", 만든이제목, esc(&credits))
    };
    let 한줄 = if note.trim().is_empty() {
        String::new()
    } else {
        format!("<p class=\"nt\">{}</p>", esc(&note))
    };
    let 표지 = if cover.trim().is_empty() {
        String::new()
    } else {
        format!("<img class=\"cv\" src=\"{}\" alt=\"\">", esc(&cover))
    };
    let 들으러 = if listen.trim().is_empty() {
        String::new()
    } else {
        let 말 = match kind.as_str() {
            "book"   => "책 보러 가기",
            "ticket" => "자세히 보기",
            "game"   => "레이븐홀드에서 보기",
            _        => "노래 듣기 · 악보 보기",
        };
        format!(
            "<p class=\"go\"><a href=\"{}\" target=\"_blank\" rel=\"noopener noreferrer\">{}</a><br>\
             <small>이 주소는 만든 곳이 살아 있는 동안 열립니다. 위의 표지와 내용은 이 폴더 안에 있어 그와 무관하게 남습니다.</small></p>",
            esc(&listen), 말
        )
    };
    let 이름표 = if asset.trim().is_empty() { String::new() } else { format!("<p class=\"as\">{}</p>", esc(&asset)) };
    let 만든이줄 = if maker.trim().is_empty() { String::new() } else { format!("<p class=\"ar\">{}</p>", esc(&maker)) };

    Some(format!(
        "<!doctype html><html lang=\"ko\"><head><meta charset=\"utf-8\">\
<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">\
<title>{t}</title>\
<style>\
:root{{color-scheme:light dark}}\
body{{margin:0;background:{bg};color:{fg};font:16px/1.7 -apple-system,BlinkMacSystemFont,'Apple SD Gothic Neo','Noto Sans KR',system-ui,sans-serif}}\
main{{max-width:640px;margin:0 auto;padding:28px 18px 72px}}\
.cv{{width:100%;aspect-ratio:{ratio};object-fit:cover;border-radius:14px;display:block;margin-bottom:22px}}\
h1{{font-size:28px;line-height:1.3;margin:0 0 6px;letter-spacing:-.01em}}\
.ar{{color:{dim};margin:0 0 6px;font-size:16px}}\
.nt{{color:{accent};margin:0 0 6px;font-size:15px}}\
.as{{color:{dim};opacity:.72;font-size:13px;margin:0 0 22px;word-break:break-all}}\
h2{{font-size:13px;color:{dim};margin:28px 0 8px;letter-spacing:.1em;text-transform:none}}\
.ly{{white-space:pre-wrap;font:15px/1.9 inherit;margin:0}}\
.go{{margin-top:30px;padding-top:18px;border-top:1px solid {dim}44}}\
.go a{{color:{accent};font-size:16px}}\
.go small{{color:{dim};opacity:.8;font-size:13px;line-height:1.6;display:block;margin-top:8px}}\
</style></head><body><main>{cv}<h1>{t}</h1>{ar}{nt}{as}{ly}{cr}{go}</main></body></html>",
        t = esc(&title), cv = 표지, ar = 만든이줄, nt = 한줄, as = 이름표,
        ly = 본문, cr = 크레딧, go = 들으러,
        bg = bg, fg = fg, dim = dim, accent = accent, ratio = 표지비율
    ))
}

fn render_page(doc: &Value) -> Option<String> {
    // 곡이면 곡 화면으로. 없으면 아래 메뉴판으로 떨어진다.
    if let Some(page) = render_song(doc) {
        return Some(page);
    }
    let menu = doc.get("playx_menu")?;
    let currency = menu.get("currency").and_then(Value::as_str).unwrap_or("KRW");
    let unit = match currency {
        "KRW" => "원",
        "USD" => "$",
        _ => "RVN",
    };
    let items = menu.get("items")?.as_array()?;

    let esc = |s: &str| {
        s.replace('&', "&amp;")
            .replace('<', "&lt;")
            .replace('>', "&gt;")
            .replace('"', "&quot;")
    };

    let rows: String = items
        .iter()
        .map(|it| {
            let name = it.get("name").and_then(Value::as_str).unwrap_or("");
            let price = it.get("price").and_then(Value::as_f64);
            let img = it.get("image").and_then(Value::as_str).unwrap_or("");
            let pic = if img.is_empty() {
                String::new()
            } else {
                format!("<img src=\"/ipfs/{}\" alt=\"\" loading=\"lazy\">", esc(img))
            };
            // 가격이 없는 줄은 빈칸이 아니라 그렇게 적는다. 빈칸은 고장으로 읽힌다.
            let cost = match price {
                Some(p) if p > 0.0 => format!("{} {unit}", (p as i64)),
                _ => "가격 문의".to_string(),
            };
            format!(
                "<li>{pic}<div><b>{}</b><span>{cost}</span></div></li>",
                esc(name)
            )
        })
        .collect();

    Some(format!(
        "<!doctype html><meta charset=\"utf-8\">\
         <meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">\
         <title>메뉴</title><style>\
         body{{font:16px/1.6 -apple-system,BlinkMacSystemFont,'Apple SD Gothic Neo',sans-serif;\
         margin:0;padding:24px;background:#fbfbfe;color:#161d2b}}\
         h1{{font-size:22px;margin:0 0 18px}}\
         ul{{list-style:none;margin:0;padding:0;max-width:560px}}\
         li{{display:flex;gap:14px;align-items:center;padding:14px 0;border-bottom:1px solid #e6eaf4}}\
         li img{{width:64px;height:64px;object-fit:cover;border-radius:10px;flex:none;background:#eef1f8}}\
         li div{{display:flex;justify-content:space-between;flex:1;gap:12px}}\
         li b{{font-weight:600}} li span{{color:#5b6478;white-space:nowrap}}\
         @media(prefers-color-scheme:dark){{body{{background:#0b1018;color:#dde3f2}}\
         li{{border-color:#2f3b57}}li span{{color:#8f9bb3}}}}\
         </style><h1>메뉴</h1><ul>{rows}</ul>"
    ))
}

/// Adds several files as one directory and returns the directory's CIDv0.
///
/// This is how an asset points at more than one thing without needing anything
/// added to the chain: the asset stores one hash, and that hash is a folder
/// holding the model, the preview image, and the metadata.
///
/// `metadata` is written into the folder as `metadata.json` when provided, so
/// the description travels with the files rather than living somewhere else
/// that can be lost separately.
/// 끌어다 놓은 **파일 경로**를 읽어 파일창고에 올린다.
///
/// ## 🔴 왜 경로로 받나
///
/// 창에 파일을 떨어뜨리면 Tauri 가 그걸 가로채서 **경로**를 준다(브라우저의
/// `File` 객체가 아니다). 그래서 화면 쪽에서는 내용을 읽을 수가 없고,
/// 여기서 읽어야 한다.
///
/// ⚠️ **아무 경로나 읽어 주면 안 된다.** 화면이 뚫리면 그 순간
///    `wallet.dat` 이든 `shopkey.json` 이든 읽어서 올릴 수 있게 된다.
///    그래서 사람이 **방금 떨어뜨린 파일만** 받는다 — 그 목록은 러스트가
///    들고 있고 화면은 못 만든다.
#[tauri::command]
pub async fn ipfs_add_dropped(path: String) -> Result<Value, String> {
    if !crate::dropbox::was_dropped(&path) {
        return Err("이 파일은 창에 떨어뜨린 것이 아닙니다.".into());
    }
    let p = std::path::Path::new(&path);
    let name = p
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "file".into());
    let bytes = std::fs::read(p).map_err(|e| format!("파일을 읽지 못했습니다: {e}"))?;
    ipfs_add_file(Incoming { name, bytes }).await
}

#[tauri::command]
pub async fn ipfs_add_bundle(
    files: Vec<Incoming>,
    metadata: Option<Value>,
) -> Result<Value, String> {
    if files.is_empty() && metadata.is_none() {
        return Err("올릴 파일이 없습니다".into());
    }

    let mut form = reqwest::multipart::Form::new();
    let mut listed: Vec<Value> = Vec::new();

    for f in files {
        let size = f.bytes.len() as u64;
        // The filename carries the path inside the wrapper directory. Slashes
        // in a user-supplied name would create unexpected nesting, so flatten.
        let safe = f.name.replace(['/', '\\'], "_");
        let part = reqwest::multipart::Part::bytes(f.bytes).file_name(safe.clone());
        form = form.part("file", part);
        listed.push(json!({ "name": safe, "size": size }));
    }

    if let Some(doc) = &metadata {
        let text = serde_json::to_vec_pretty(doc).map_err(|e| e.to_string())?;
        let size = text.len() as u64;
        let part = reqwest::multipart::Part::bytes(text).file_name("metadata.json".to_string());
        form = form.part("file", part);
        listed.push(json!({ "name": "metadata.json", "size": size }));

        // 사람이 볼 수 있는 화면도 같이 넣는다.
        //
        // 여기 metadata.json 만 있던 동안, "메뉴판을 올렸습니다"를 누른 사장이
        // 그 주소를 열면 파일 목록 한 줄이 나왔다. 자기가 올린 메뉴를 자기가
        // 못 보는 것이고, 손님에게 그 주소를 줘도 마찬가지다.
        //
        // 게이트웨이는 디렉터리에 index.html 이 있으면 그것을 그린다. 그러니
        // 같은 폴더 안에 한 장을 넣어 두면, 주소 하나가 곧 메뉴판이 된다 —
        // 우리 앱도, 브라우저도, 손님 폰도 같은 것을 본다.
        if let Some(page) = render_page(doc) {
            let bytes = page.into_bytes();
            let size = bytes.len() as u64;
            let part = reqwest::multipart::Part::bytes(bytes).file_name("index.html".to_string());
            form = form.part("file", part);
            listed.push(json!({ "name": "index.html", "size": size }));
        }
    }

    let body = post_multipart("pin=true&cid-version=0&wrap-with-directory=true", form).await?;
    let added = parse_added(&body);

    // The wrapper directory is the entry with an empty name; it is emitted last,
    // but match on the name rather than the position — relying on ordering here
    // would silently point the asset at one file inside the folder instead.
    let dir = added
        .iter()
        .find(|a| a.name.is_empty())
        .or_else(|| added.last())
        .ok_or_else(|| "IPFS가 폴더 해시를 돌려주지 않았습니다".to_string())?;

    Ok(json!({ "cid": dir.hash, "files": listed }))
}

/// Builds a RIP-0014 metadata document.
///
/// The standard has one `name` and one `description`, both single strings, and
/// no concept of other languages. Korean and Japanese names therefore go into
/// `other_data`, which the spec leaves open for issuer-defined keys. A wallet
/// that has never heard of `name_ko` reads `asset_data.name` and shows the
/// English one — so adding a Korean name can never make the asset look broken
/// somewhere else.
#[tauri::command]
pub fn build_metadata(
    name: String,
    description: String,
    names: Value,
    descriptions: Value,
    website: Option<String>,
    issuer: Option<String>,
    keywords: Option<String>,
) -> Value {
    let mut other = serde_json::Map::new();
    for (lang, value) in names.as_object().cloned().unwrap_or_default() {
        if let Some(s) = value.as_str().filter(|s| !s.trim().is_empty()) {
            other.insert(format!("name_{lang}"), json!(s));
        }
    }
    for (lang, value) in descriptions.as_object().cloned().unwrap_or_default() {
        if let Some(s) = value.as_str().filter(|s| !s.trim().is_empty()) {
            other.insert(format!("description_{lang}"), json!(s));
        }
    }

    let mut asset_data = serde_json::Map::new();
    asset_data.insert("name".into(), json!(name));
    asset_data.insert("description".into(), json!(description));
    if let Some(k) = keywords.filter(|s| !s.trim().is_empty()) {
        asset_data.insert("keywords".into(), json!(k));
    }

    let mut admin = serde_json::Map::new();
    if let Some(w) = website.filter(|s| !s.trim().is_empty()) {
        admin.insert("website_url".into(), json!(w));
    }
    if let Some(i) = issuer.filter(|s| !s.trim().is_empty()) {
        admin.insert("issuer".into(), json!(i));
    }

    let mut metadata = serde_json::Map::new();
    metadata.insert("asset_data".into(), Value::Object(asset_data));
    if !admin.is_empty() {
        metadata.insert("admin_data".into(), Value::Object(admin));
    }
    if !other.is_empty() {
        metadata.insert("other_data".into(), Value::Object(other));
    }

    json!({ "rip0014": { "metadata": Value::Object(metadata) } })
}

/// 남의 사진 서버에 올라간 사진을 **받아서 이 컴퓨터에도 한 부 둔다.**
///
/// ## 왜
///
/// 장터 사진은 Nostr 미디어 서버(nostr.build 등)에 올라간다. 우리가 갖고
/// 있지 않아서, **그곳이 문을 닫으면 사진이 사라진다.** 우리도 못 되살린다.
///
/// 대표님 물음: *"Nostr 이거는 노드 돌리는 사람들이 같이 안 돌려주나?
/// 우리 시스템에서 안 돌려주나?"* — 안 돌려준다. Nostr 릴레이는 **글**을
/// 나르지 사진을 보관하지 않는다.
///
/// 그래서 **사본을 하나 더 둔다.** 남의 서버가 닫혀도 노드 하나가 살아
/// 있으면 사진이 남는다.
///
/// ## 🔴 우리가 사진 서버가 되는 것과는 다르다
///
/// 남의 사진을 받아 **인터넷에 내주는 것**(NIP-96 서버)은 하지 않는다.
/// 디스크가 계속 늘고, 대역폭이 나가고, 노드가 바깥에 열려 있어야 하고,
/// 누가 불법 사진을 올리면 그게 우리 디스크에 남는다. 그 노드는 손님 결제를
/// 확인해야 하는 노드다.
///
/// 여기서 하는 것은 **내가 올린 내 사진 한 부**를 내 컴퓨터에 두는 것뿐이다.
///
/// ⚠️ 실패해도 오류를 던지지 않는다. 사본은 덤이다 — 이것 때문에 물건
///    올리기가 막히면 안 된다.
#[tauri::command]
pub async fn ipfs_keep_url(url: String) -> Value {
    // https 만. 남이 준 주소로 이 컴퓨터의 파일을 읽게 하면 안 된다.
    if !url.starts_with("https://") {
        return json!({ "kept": false, "why": "https 주소만 보관합니다" });
    }
    // 사진 한 장에 이보다 크면 우리가 받을 이유가 없다.
    const MAX: usize = 12 * 1024 * 1024;

    let Ok(r) = reqwest::Client::new()
        .get(&url)
        .timeout(std::time::Duration::from_secs(60))
        .send()
        .await
    else {
        return json!({ "kept": false, "why": "사진을 받지 못했습니다" });
    };
    if !r.status().is_success() {
        return json!({ "kept": false, "why": format!("{}", r.status()) });
    }
    let Ok(bytes) = r.bytes().await else {
        return json!({ "kept": false, "why": "사진을 다 받지 못했습니다" });
    };
    if bytes.len() > MAX {
        return json!({ "kept": false, "why": "사진이 너무 큽니다" });
    }

    let name = url.rsplit('/').next().unwrap_or("photo").to_string();
    let part = reqwest::multipart::Part::bytes(bytes.to_vec()).file_name(name);
    let form = reqwest::multipart::Form::new().part("file", part);
    let Ok(body) = post_multipart("pin=true&cid-version=0", form).await else {
        return json!({ "kept": false, "why": "파일창고가 꺼져 있습니다" });
    };
    match parse_added(&body).last() {
        Some(a) => json!({ "kept": true, "cid": a.hash, "bytes": bytes.len() }),
        None => json!({ "kept": false, "why": "파일창고가 답을 안 했습니다" }),
    }
}
