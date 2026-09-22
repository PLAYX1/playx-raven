//! The other machines that are also mine.
//!
//! ## Why a list and not a discovery protocol
//!
//! Two computers running this program need to move assets between them — the
//! laptop issues a release, the counter sells it. Doing that by copying a
//! 34-character address every time is how an asset ends up at an address
//! nobody owns, and there is no undo on a chain.
//!
//! Nodes could find each other over PubSub and exchange addresses automatically.
//! They should not. An address arriving over the network still has to be
//! *believed*, and believing it is exactly the step that must be a person
//! looking at their own screen. So: register once, deliberately, and after that
//! send by name.
//!
//! ## What this refuses
//!
//! An address belonging to this same wallet. Sending assets to yourself and
//! calling it "moved to the shop" is the same failure as a sweep that pays into
//! its own pocket — it looks done and nothing happened.

use serde_json::{json, Value};
use std::path::PathBuf;

fn store() -> PathBuf {
    crate::paths::app_file("peers.json")
}

fn load() -> Vec<Value> {
    std::fs::read_to_string(store())
        .ok()
        .and_then(|t| serde_json::from_str::<Value>(&t).ok())
        .and_then(|v| v.get("peers").and_then(Value::as_array).cloned())
        .unwrap_or_default()
}

fn save(rows: &[Value]) -> Result<(), String> {
    let path = store();
    if let Some(d) = path.parent() {
        let _ = std::fs::create_dir_all(d);
    }
    let tmp = path.with_extension("json.tmp");
    std::fs::write(
        &tmp,
        serde_json::to_vec_pretty(&json!({ "peers": rows })).map_err(|e| e.to_string())?,
    )
    .map_err(|e| format!("저장하지 못했습니다: {e}"))?;
    std::fs::rename(&tmp, &path).map_err(|e| format!("저장하지 못했습니다: {e}"))
}

/// Every machine registered here.
#[tauri::command]
pub fn peer_list() -> Value {
    json!({ "peers": load() })
}

/// Registers another machine by the address it wants to receive on.
///
/// The address is checked against the chain's own validator and against this
/// wallet. Both matter: a typo produces a valid-looking string that nobody can
/// spend from, and an address of our own produces a transfer that succeeds and
/// achieves nothing.
#[tauri::command]
pub async fn peer_add(name: String, address: String, note: String, now_unix: i64) -> Result<Value, String> {
    let name = name.trim().to_string();
    if name.is_empty() {
        return Err("이름이 필요합니다 — 강남지점, 매장 계산대처럼요.".into());
    }

    let check = crate::send::check_address(address.trim().to_string()).await?;
    if !check["valid"].as_bool().unwrap_or(false) {
        return Err("주소가 올바르지 않습니다. 한 글자만 틀려도 자산이 사라집니다.".into());
    }
    if check["is_mine"].as_bool().unwrap_or(false) {
        return Err(
            "이 지갑의 주소입니다. 다른 컴퓨터의 [받을 주소 만들기]에서 나온 주소를 넣으세요."
                .into(),
        );
    }

    let mut rows = load();
    if rows
        .iter()
        .any(|r| r.get("address").and_then(Value::as_str) == Some(address.trim()))
    {
        return Err("이미 등록된 주소입니다.".into());
    }

    rows.push(json!({
        "name": name,
        "address": address.trim(),
        "note": note.trim(),
        "added": now_unix,
    }));
    save(&rows)?;
    Ok(peer_list())
}

#[tauri::command]
pub fn peer_remove(address: String) -> Result<Value, String> {
    let mut rows = load();
    rows.retain(|r| r.get("address").and_then(Value::as_str) != Some(address.as_str()));
    save(&rows)?;
    Ok(peer_list())
}

/// Keeps a copy of every file the assets in this wallet point at.
///
/// ## Why the counter pins what the laptop issued
///
/// An asset carries one IPFS hash and nothing else — the cover, the audio, the
/// lyrics all live behind that hash, on whichever machines happen to be holding
/// it. Measured on this network, that is exactly one machine: ours. A public
/// gateway fetched a shop photo in 13 seconds through a relay and a second
/// gateway gave up entirely.
///
/// So when the issuing laptop is closed — and it is closed most of the time,
/// which is the correct place for an owner token to live — the cover art of
/// every release stops loading. The counter machine is on all day and already
/// runs IPFS. It should hold the files.
///
/// Returns what it pinned rather than a count, because "12개 보관 중" is not
/// checkable and a list of names is.
#[tauri::command]
pub async fn pin_my_assets() -> Result<Value, String> {
    let assets = crate::raven::list_assets().await?;
    // 🔴 「만들기」의 원본 지문은 파일이 아니다 — 올린 적이 없어서 붙들 것이 없다.
    //    예전에는 지문마다 5분씩 기다렸다(50장이면 몇 시간). 이 컴퓨터가 지문으로
    //    만든 것은 기록에 있으니 여기서 뺀다.
    let fingerprints = crate::create_history::fingerprint_set();
    let cids: Vec<String> = file_cids(assets.into_iter().map(|a| (a.name, a.ipfs_hash)), &fingerprints)
        .into_iter()
        .map(|(name, cid)| format!("{name}\u{1}{cid}"))
        .collect();
    pin_these(cids).await
}

/// 자산 목록에서 **파일을 가리키는 것만** — 주인 표·빈 해시·이 컴퓨터가 만든
/// 원본 지문을 뺀다. 보존(`pin_my_assets`)과 공개 목록(`my_cids`)이 같은 잣대를 쓴다.
fn file_cids(
    assets: impl IntoIterator<Item = (String, Option<String>)>,
    fingerprints: &std::collections::HashSet<String>,
) -> Vec<(String, String)> {
    assets
        .into_iter()
        .filter(|(name, _)| !name.ends_with('!'))
        .filter_map(|(name, hash)| {
            let cid = hash.filter(|h| h.starts_with("Qm") && !fingerprints.contains(h))?;
            Some((name, cid))
        })
        .collect()
}

/// 방금 찾지 못한 주소 — 한동안 다시 묻지 않는다.
///
/// 🔴 남(폰·다른 컴퓨터)이 만든 원본 지문은 모양으로 가려낼 수 없다. 그대로
///    `pin_add` 를 부르면 하나마다 5분을 기다린다. 먼저 20초만 물어보고(자산
///    화면의 「확인」과 같은 잣대), 없으면 6시간 동안은 건너뛴다.
static MISSED: std::sync::Mutex<Option<std::collections::HashMap<String, std::time::Instant>>> =
    std::sync::Mutex::new(None);
const MISS_QUIET: std::time::Duration = std::time::Duration::from_secs(6 * 3600);

fn recently_missed(cid: &str) -> bool {
    MISSED
        .lock()
        .ok()
        .and_then(|g| g.as_ref().and_then(|m| m.get(cid).map(|t| t.elapsed() < MISS_QUIET)))
        .unwrap_or(false)
}

fn note_missed(cid: &str) {
    if let Ok(mut g) = MISSED.lock() {
        let m = g.get_or_insert_with(Default::default);
        if m.len() > 5_000 {
            m.clear();
        }
        m.insert(cid.to_string(), std::time::Instant::now());
    }
}

/// 로컬 파일창고(kubo) HTTP API. `ipfs.rs` 와 같은 주소다(그 파일은 0.3.8 그대로 둔다).
const IPFS_API: &str = "http://127.0.0.1:5001/api/v0";

/// 이 주소를 지금 누가 들고 있나 — **뿌리 블록 하나만** 묻는다.
///
/// 🔴 `cat?length=1`(ipfs::check_alive)로 물으면 **폴더는 늘 「없음」**이다. kubo 의
///    `cat` 은 폴더에 「this dag node is a directory」 오류를 낸다. 곡·영상 묶음은
///    `wrap-with-directory` 로 올린 폴더라서, 그 잣대로는 보존도 서로 돕기도 영영
///    건너뛰었다(0.4.5 검수에서 잡힘). `block/stat` 은 파일이든 폴더든 뿌리 블록만
///    확인한다 — 폴더와 파일을 똑같이 대한다.
pub(crate) async fn root_alive_at(api: &str, cid: &str, timeout_secs: u64) -> bool {
    let response = reqwest::Client::new()
        .post(format!("{api}/block/stat?arg={cid}"))
        .timeout(std::time::Duration::from_secs(timeout_secs))
        .send()
        .await;
    matches!(response, Ok(r) if r.status().is_success())
}

async fn root_alive(cid: &str, timeout_secs: u64) -> bool {
    root_alive_at(IPFS_API, cid, timeout_secs).await
}

/// 자산 화면의 「확인」 — 파일이든 폴더든 찾을 수 있나. (`check_alive` 대신)
#[tauri::command]
pub async fn cid_alive(cid: String, timeout_secs: u64) -> Result<bool, String> {
    let cid = cid.trim();
    if !(cid.len() == 46 && cid.starts_with("Qm") && cid.bytes().all(|b| b.is_ascii_alphanumeric())) {
        return Ok(false);
    }
    Ok(root_alive(cid, timeout_secs.clamp(1, 60)).await)
}

/// 이름과 주소가 붙은 목록을 받아 **그것들을 이 컴퓨터가 들고 있게** 한다.
///
/// 🔴 내 것만 들어 주면 「서로 보완」이 아니다. 대표님: "내 406호 컴퓨터와
///    내 맥북이 서로를 보완해 줄수도 있으면 좋지 않나?"
///
///    맞다. 그리고 이게 **오늘 난 사고를 근본적으로 막는다** — 가게 사진이
///    사라진 것은 그 파일을 **한 대만** 들고 있었기 때문이다. 노트북이 닫히면
///    세상에서 사라진다. 계산대는 하루 종일 켜져 있다.
/// 한 번에 받아 줄 최대 개수. 이게 없으면 상대가 만 개를 보내도 다 붙든다.
const MAX_HELP: usize = 200;

/// 🔴 **남이 준 CID 를 그대로 믿으면 안 된다.**
///
/// 여기는 다른 컴퓨터의 `/api/pins` 가 준 목록을 받는다. 그 컴퓨터가
/// 우리 것이 아닐 수도 있고, 우리 것이라도 뚫렸을 수 있다. 예전에는
/// **개수도 체인 대조도 없이** 받은 CID 를 전부 붙들었다 —
/// 가짜 주소 하나로 남의 디스크를 채울 수 있었다(실측 2026-09-08).
///
/// 그래서 `helping.rs` 가 이미 쓰고 있는 규칙을 여기에도 적용한다:
/// **체인이 그 CID 를 가리킬 때만 붙든다.** 자산 이름으로 체인에 묻고
/// (`getassetdata`), 거기 적힌 `ipfs_hash` 와 글자 그대로 같아야 한다.
/// 체인은 500 RVN 을 태워야 한 줄이 적히므로, 이것만으로 장난이 비싸진다.
async fn pin_these(items: Vec<String>) -> Result<Value, String> {
    let assets: Vec<(String, String)> = items
        .into_iter()
        .take(MAX_HELP)
        .filter_map(|s| {
            let (n, c) = s.split_once('\u{1}')?;
            // CIDv0 만 받는다. 레이븐 이름표는 34바이트라 `Qm…` 뿐이다.
            let c = c.trim();
            if !(c.len() == 46 && c.starts_with("Qm")) {
                return None;
            }
            Some((n.trim().to_string(), c.to_string()))
        })
        .collect();

    let mut pinned = Vec::new();
    let mut failed = Vec::new();
    let mut skipped = 0usize;
    let mut fingerprints_skipped = 0usize;
    let fingerprints = crate::create_history::fingerprint_set();

    for (name, cid) in assets {
        // 이 컴퓨터가 원본 지문으로 만든 것 — 파일이 아니다.
        if fingerprints.contains(&cid) {
            fingerprints_skipped += 1;
            continue;
        }
        // ── 체인 대조. 못 물어보면 **붙들지 않는다.** ──
        //    「확인 못 함」과 「맞음」을 같게 취급하면 검사가 없는 것과 같다.
        let 체인해시 = match crate::raven::call_rpc("getassetdata", json!([name.clone()])).await {
            Ok(d) => d
                .get("ipfs_hash")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string(),
            Err(_) => String::new(),
        };
        if 체인해시.is_empty() || 체인해시 != cid {
            skipped += 1;
            continue;
        }

        // 한 번 못 찾은 것은 한동안 묻지 않고, 처음 묻는 것도 20초만 기다린다.
        // 파일이 살아 있으면 첫 바이트는 금방 온다 — 그때만 붙든다.
        if recently_missed(&cid) {
            failed.push(json!({ "asset": name, "cid": cid }));
            continue;
        }
        if !root_alive(&cid, 20).await {
            note_missed(&cid);
            failed.push(json!({ "asset": name, "cid": cid }));
            continue;
        }

        match crate::ipfs::pin_add(cid.clone()).await {
            Ok(true) => pinned.push(json!({ "asset": name, "cid": cid })),
            // 붙들지 못했으면 한동안 다시 묻지 않는다 — 안 그러면 돌 때마다 5분씩 기다린다.
            Ok(false) | Err(_) => {
                note_missed(&cid);
                failed.push(json!({ "asset": name, "cid": cid }));
            }
        }
    }

    Ok(json!({
        "pinned": pinned,
        "failed": failed,
        "no_file": skipped,
        "fingerprints": fingerprints_skipped,
        "note": "체인이 가리키는 것만 받았습니다. 이 컴퓨터가 계속 갖고 있으니, 발행한 컴퓨터가 꺼져 있어도 손님 화면에서 열립니다.",
    }))
}

/// 이 컴퓨터가 들고 있는 자산 파일 목록. **다른 노드가 물어보는 자리다.**
///
/// 🔴 숨길 것이 없다. 자산 이름도 IPFS 주소도 **이미 체인에 공개**돼 있다.
///    여기서 새로 새는 것은 없고, 다만 「이 목록을 한 번에 받는 길」이
///    없어서 서로 도울 수가 없었을 뿐이다.
pub async fn my_cids() -> Value {
    let assets = match crate::raven::list_assets().await {
        Ok(v) => v,
        Err(e) => return json!({ "error": e, "items": [] }),
    };
    // 🔴 원본 지문은 「이 컴퓨터가 들고 있는 파일」이 아니다. 목록에 올리면 남의
    //    컴퓨터가 그걸 받으려고 몇 분씩 기다린다.
    let fingerprints = crate::create_history::fingerprint_set();
    let items: Vec<Value> = file_cids(assets.into_iter().map(|a| (a.name, a.ipfs_hash)), &fingerprints)
        .into_iter()
        .map(|(asset, cid)| json!({ "asset": asset, "cid": cid }))
        .collect();
    json!({ "items": items })
}

/// **저쪽 컴퓨터의 파일을 이쪽이 들어 준다.**
///
/// 대표님: "탈중앙인데 서로가 보완해 가면서 가는 구조가 좋은데 말야."
///
/// 맞다. 그리고 이건 겉멋이 아니라 **오늘 난 사고의 근본 처방**이다 —
/// 가게 사진이 사라진 것은 그 파일을 **한 대만** 들고 있었기 때문이다.
/// 발행하는 노트북은 닫혀 있는 게 맞고(소유권 토큰이 사는 자리다), 계산대는
/// 하루 종일 켜져 있다. 그러면 **켜져 있는 쪽이 들고 있어야** 한다.
///
/// ⚠️ **저쪽이 꺼져 있으면 그냥 넘어간다.** 도우려다 이쪽이 멈추면 안 된다.
#[tauri::command]
pub async fn peer_help(url: String) -> Result<Value, String> {
    let base = url.trim().trim_end_matches('/').to_string();
    if !base.starts_with("http://") && !base.starts_with("https://") {
        return Err("주소는 http:// 나 https:// 로 시작해야 합니다.".into());
    }
    let r = reqwest::Client::new()
        .get(format!("{base}/api/pins"))
        .timeout(std::time::Duration::from_secs(20))
        .send()
        .await
        .map_err(|e| format!("그 컴퓨터에 못 닿았습니다 — {e}"))?;
    let body: Value = r
        .json()
        .await
        .map_err(|e| format!("답을 못 읽었습니다 — {e}"))?;
    let items: Vec<String> = body
        .get("items")
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .filter_map(|x| {
                    let n = x.get("asset").and_then(Value::as_str)?;
                    let c = x.get("cid").and_then(Value::as_str)?;
                    Some(format!("{n}\u{1}{c}"))
                })
                .collect()
        })
        .unwrap_or_default();
    if items.is_empty() {
        return Ok(json!({
            "pinned": [], "failed": [], "skipped": 0,
            "note": "그 컴퓨터에는 파일이 붙은 자산이 없습니다."
        }));
    }
    pin_these(items).await
}

/// **켜 두면 알아서 지킨다.**
///
/// 🔴 대표님: "사람들은 블록체인이면 인공지능처럼 자동으로 되는걸 원할걸."
///
///    「내 파일 지키기」를 단추로 만들어 놨는데, 단추는 누가 눌러야 한다.
///    그런데 이 일은 **되돌릴 수 있고 돈이 안 든다** — 자동이 맞는 자리다.
///    (발행·재발행·보내기는 절대 자동이면 안 된다. 그건 되돌릴 수 없다.)
///
///    오늘 가게 사진이 사라진 것은 그 파일을 **한 대만** 들고 있었기
///    때문이다. 사장이 누르는 것을 잊으면 같은 일이 또 난다.
///
/// ⚠️ **지갑을 안 연다.** 핀은 파일창고의 일이라 개인키가 필요 없다 —
///    그래서 자동으로 돌려도 안전하다. 개발비 자동송금과 다른 점이 이것이다.
///
/// ⚠️ 실패해도 조용히 넘어간다. 파일창고가 잠깐 꺼져 있다고 앱이 멈추면 안 된다.
pub fn start_auto_pin() {
    tauri::async_runtime::spawn(async {
        // 처음 한 번은 조금 기다린다. 앱이 켜지는 동안 파일창고도 올라온다.
        tokio::time::sleep(std::time::Duration::from_secs(90)).await;
        loop {
            let _ = pin_my_assets().await;
            // 30분마다. 자산이 자주 바뀌는 물건이 아니라 이보다 잦을 이유가 없다.
            tokio::time::sleep(std::time::Duration::from_secs(1800)).await;
        }
    });
}


#[cfg(test)]
mod tests {
    use serde_json::json;

    const FP: &str = "QmcwUFCZ8saJgoE6D9LEgVqtteCbVcdzWFcGzuhe7VTeW7";
    const FILE: &str = "QmQ9SC6m3JMtK2ciA5Ds8yVq6o9h6x5zZ8kcN2d5wV8aXb";

    /// 🔴 이 컴퓨터가 만든 원본 지문은 보존·공개 목록 어디에도 「파일」로 안 나간다.
    ///    진짜 파일과 주인 표 규칙은 그대로다.
    #[test]
    fn 원본_지문은_보존과_공개_목록에서_빠진다() {
        crate::create_history::tests::sandbox(|_| {
            crate::create_history::remember_fingerprint(FP).unwrap();
            let fps = crate::create_history::fingerprint_set();
            let rows = vec![
                ("HANBIT#SURYO260923-1".to_string(), Some(FP.to_string())),
                ("PLAYX/SONG/INEVITABLE".to_string(), Some(FILE.to_string())),
                ("PLAYX!".to_string(), Some(FILE.to_string())),
                ("PLAYX".to_string(), None),
                ("ODD".to_string(), Some("bafyfoo".to_string())),
            ];
            let out = super::file_cids(rows, &fps);
            assert_eq!(out, vec![("PLAYX/SONG/INEVITABLE".to_string(), FILE.to_string())]);

            // 붙드는 쪽도 지문이면 체인·파일창고에 묻지도 않고 넘어간다(여기서 네트워크를 부르면 시험이 멈춘다).
            let r = tauri::async_runtime::block_on(super::pin_these(vec![format!("HANBIT#SURYO260923-1\u{1}{FP}")])).unwrap();
            assert_eq!(r["fingerprints"], json!(1));
            assert_eq!(r["pinned"], json!([]));
            assert_eq!(r["failed"], json!([]));
        });
    }

    /// 폴더(곡·영상 묶음)도 파일과 똑같이 「있음」이어야 한다. 가짜 파일창고를 띄워
    /// kubo 처럼 `cat` 은 폴더에 오류를 내게 하고, 뿌리 블록 확인이 폴더·파일을 다
    /// 살리는지, 없는 것만 「없음」인지 본다. 진짜 파일창고·네트워크는 안 부른다.
    #[test]
    fn 폴더_주소도_파일처럼_살아_있다고_본다() {
        use axum::{extract::Query, http::StatusCode, routing::post, Router};
        use std::collections::HashMap;
        const DIR: &str = "QmFolderBundleSongAndCoverWrapWithDirectory00";
        const FILE: &str = "QmPlainFileCoverImageNotAFolder0000000000000";
        const GONE: &str = "QmNobodyHoldsThisAnymore000000000000000000000";
        tauri::async_runtime::block_on(async {
            let known = |q: &HashMap<String, String>| matches!(q.get("arg").map(String::as_str), Some(DIR) | Some(FILE));
            let app = Router::new()
                .route("/api/v0/block/stat", post(move |Query(q): Query<HashMap<String, String>>| async move {
                    if known(&q) { (StatusCode::OK, "{\"Key\":\"x\",\"Size\":1}") } else { (StatusCode::INTERNAL_SERVER_ERROR, "block not found") }
                }))
                .route("/api/v0/cat", post(|Query(q): Query<HashMap<String, String>>| async move {
                    if q.get("arg").map(String::as_str) == Some(DIR) { (StatusCode::INTERNAL_SERVER_ERROR, "this dag node is a directory") } else { (StatusCode::OK, "x") }
                }));
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let addr = listener.local_addr().unwrap();
            tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
            let api = format!("http://{addr}/api/v0");
            // 예전 잣대(cat)는 폴더를 「없음」으로 봤다 — 이 가짜가 kubo 와 같게 구는지부터.
            let cat = reqwest::Client::new().post(format!("{api}/cat?arg={DIR}&length=1")).send().await.unwrap();
            assert!(!cat.status().is_success(), "가짜 파일창고도 폴더에 cat 오류를 내야 시험이 된다");
            assert!(super::root_alive_at(&api, DIR, 5).await, "폴더 묶음은 살아 있다");
            assert!(super::root_alive_at(&api, FILE, 5).await, "보통 파일도 그대로 살아 있다");
            assert!(!super::root_alive_at(&api, GONE, 5).await, "아무도 없는 것만 「없음」");
        });
    }

    #[test]
    fn 못_찾은_주소는_한동안_다시_묻지_않는다() {
        let cid = "QmTestMissedAddressForBackoffOnly000000000000";
        assert!(!super::recently_missed(cid));
        super::note_missed(cid);
        assert!(super::recently_missed(cid));
    }
}
