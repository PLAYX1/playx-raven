//! 주소 색인을 **실제로 만드는** 자리.
//!
//! 여기 적힌 순서는 짐작이 아니라 `~/build/Ravencoin` 소스를 읽고 정한 것이다.
//! 돈이 걸린 컴퓨터의 데이터베이스를 다시 만드는 일이라, 한 단계라도 틀리면
//! **가게 노드가 영영 안 뜬다.**
//!
//! ## 소스에서 확인한 것 셋
//!
//! ① 🔴 **코어가 알려주는 방법이 틀렸다.**
//!    `init.cpp:1660` 은 addressindex 를 바꾸려면 `-reindex-chainstate` 를
//!    쓰라고 한다. 그런데 색인 표시를 다시 쓰는 자리(`validation.cpp:5258`)는
//!    `if (needs_init)` 안에 있고, `needs_init` 은 **블록 색인이 통째로 비었을
//!    때**(= `-reindex`) 만 참이다. `-reindex-chainstate` 로는 그 자리에
//!    닿지 못하므로 표시가 그대로 남고, 다음 시작에서 **같은 오류로 또 죽는다.**
//!    → 우리는 `-reindex` 를 쓴다. 오류 문구를 따라가면 안 된다.
//!
//! ② 중단돼도 이어서 한다. `-reindex` 는 시작할 때 디스크에 표시를 남기고
//!    (`init.cpp:1629`), 다음 시작에서 그 표시를 읽어 스스로 이어 한다
//!    (`validation.cpp:4852`). 그래서 정전이나 앱 종료로 끊겨도 안전하다.
//!
//! ③ 🔴 그런데 **launchd 가 먼저 끼어든다.** `se.erci.playx.raven.node.plist`
//!    는 `KeepAlive=true` 라, 우리가 노드를 끄면 30초 안에 launchd 가
//!    `-reindex` **없이** 되살린다. 그 순간 conf 에는 `addressindex=1` 이
//!    적혀 있고 디스크 표시는 아직 없으므로 → 위 ① 의 오류로 죽고,
//!    launchd 는 그걸 30초마다 영원히 반복한다. **가게 노드가 죽은 채로 남는다.**
//!    → 그래서 **먼저 launchd 를 내리고**, 우리가 띄운 뒤에 다시 올린다.

use serde_json::{json, Value};
use std::sync::atomic::{AtomicBool, Ordering};

/// 지금 다시 훑는 중인가. 화면이 이걸 보고 「하는 중」을 그린다.
static RUNNING: AtomicBool = AtomicBool::new(false);

fn plist_path() -> std::path::PathBuf {
    let home = std::env::var("HOME").unwrap_or_default();
    std::path::PathBuf::from(home).join("Library/LaunchAgents/se.erci.playx.raven.node.plist")
}

/// launchd 가 노드를 되살리지 못하게 잠시 내린다.
///
/// 파일은 지우지 않는다 — 지우면 재색인이 끝난 뒤 노드 자동 시작이 사라지고,
/// 사장은 그걸 눈치채지 못한 채 다음 정전에 가게가 멈춘다.
fn agent_hold() -> bool {
    let p = plist_path();
    if !p.is_file() {
        return false;
    }
    let _ = crate::quiet::cmd("launchctl")
        .args(["unload", "-w"])
        .arg(&p)
        .status();
    true
}

fn agent_release() {
    let p = plist_path();
    if p.is_file() {
        let _ = crate::quiet::cmd("launchctl")
            .args(["load", "-w"])
            .arg(&p)
            .status();
    }
}

fn armed_path() -> std::path::PathBuf {
    crate::paths::app_file("reindex-armed")
}

/// 「한가할 때 알아서 해 주세요」를 켜고 끈다.
///
/// 🔴 예약이라고 부르지만 **시계를 따로 두지 않는다.** 앱이 떠 있는 동안
/// 1분마다 「지금 한가한가」를 물어보고, 한가하면 시작한다. 시계를 따로
/// 두면 앱이 꺼져 있던 시간을 못 따라잡고, 사장은 예약해 놨는데 안 됐다고 겪는다.
#[tauri::command]
pub fn reindex_arm(on: bool) -> bool {
    if on {
        let _ = std::fs::write(armed_path(), "1");
    } else {
        let _ = std::fs::remove_file(armed_path());
    }
    armed_path().exists()
}

/// 지금 상태.
#[tauri::command]
pub fn reindex_state() -> Value {
    json!({
        "armed": armed_path().exists(),
        "running": RUNNING.load(Ordering::Relaxed),
        "wanted": crate::conf::wants_addressindex(),
        // 표시 파일이 있으면 이미 한 번 다시 훑었다는 뜻이다.
        "done": crate::paths::app_file("reindexed-addressindex").exists(),
    })
}

/// 지금 시작한다.
///
/// 화면은 이걸 **한가한 창에서만** 부른다. 여기서는 시간을 따지지 않는다 —
/// 사장이 「지금 바로」를 눌렀을 수도 있고, 그건 사장의 판단이다.
#[tauri::command]
pub async fn reindex_start() -> Result<Value, String> {
    if RUNNING.swap(true, Ordering::Relaxed) {
        return Err("이미 다시 훑고 있습니다.".into());
    }
    // 🔴 몇 시간짜리 일이다. 그동안 컴퓨터가 잠들면 **처음부터 다시** 훑는다.
    //    색인 전용으로 세워 둔 컴퓨터는 대개 「돕기」라 평소에는 안 붙잡는데,
    //    여기서만은 붙잡아야 한다. 끝나면 놓는다.
    crate::awake::sync_with_mode();
    let out = run().await;
    if out.is_err() {
        RUNNING.store(false, Ordering::Relaxed);
        crate::awake::sync_with_mode();
    }
    // 끝났으면(성공이든 실패든) 원래 규칙으로 돌아간다 — 「돕기」면 놓는다.
    crate::awake::sync_with_mode();
    out
}

async fn run() -> Result<Value, String> {
    // ── 1. launchd 를 **가장 먼저** 내린다 ───────────────────────────
    // 🔴 그록 지적으로 순서를 바꿨다. conf 를 먼저 적으면, 그 순간부터
    //    노드가 무슨 이유로든 재기동될 때 `addressindex` 불일치로 죽고,
    //    KeepAlive 가 그걸 반복한다. **설정을 적기 전에 감독자를 내린다.**
    let held = agent_hold();

    // ── 2. 설정에 적는다 ─────────────────────────────────────────────
    // 🔴 **둘을 같이 켠다.** 자산 색인이 꺼져 있어서 「배당」 화면이 눌러도
    //    아무 일도 안 났다(실측: `listaddressesbyasset` 이 거절). 그런데 그걸
    //    켜는 일도 **똑같이 43GB 를 다시 훑는 것**이다. 따로 하면 사장이
    //    장사를 두 번 멈춘다. 한 번에 끝낸다.
    if let Err(e) = crate::conf::conf_write(json!({ "addressindex": 1, "assetindex": 1 })) {
        if held {
            agent_release();
        }
        return Err(e);
    }

    // ── 3. 노드를 끈다 ───────────────────────────────────────────────
    let _ = crate::raven::call_rpc("stop", json!([])).await;
    // 꺼질 때까지 기다린다. LevelDB 는 파일을 잠그므로, 안 기다리고 띄우면
    // "Cannot obtain a lock on data directory" 로 죽는다.
    for _ in 0..60 {
        tokio::time::sleep(std::time::Duration::from_secs(1)).await;
        if crate::raven::call_rpc("getblockcount", json!([])).await.is_err() {
            break;
        }
    }

    // ── 4. -reindex 를 붙여 띄운다 ───────────────────────────────────
    let Some(path) = crate::services::which("ravend") else {
        if held {
            agent_release();
        }
        return Err("ravend 를 찾지 못했습니다.".into());
    };
    let datadir = crate::paths::raven_dir().to_string_lossy().to_string();
    crate::quiet::cmd(&path)
        .arg(format!("-datadir={datadir}"))
        .arg("-server=1")
        // 🔴 `-reindex-chainstate` 가 아니다. 위 ① 참고.
        .arg("-reindex")
        .arg("-daemon")
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .map_err(|e| {
            if held {
                agent_release();
            }
            format!("노드를 다시 띄우지 못했습니다: {e}")
        })?;

    // ── 5. 정말 떴는지 본다 ──────────────────────────────────────────
    //    떴다고 적어 두고 안 떠 있으면 사장은 몇 시간 뒤에야 안다.
    let mut alive = false;
    for _ in 0..90 {
        tokio::time::sleep(std::time::Duration::from_secs(2)).await;
        if crate::raven::call_rpc("getblockchaininfo", json!([])).await.is_ok() {
            alive = true;
            break;
        }
    }
    if !alive {
        // 우리 것이 안 떴으면 감독자라도 돌려놔야 한다 — 안 그러면
        // 가게가 자동 시작 없이 남는다.
        if held {
            agent_release();
        }
        RUNNING.store(false, Ordering::Relaxed);
        crate::awake::sync_with_mode();
        return Err("노드가 다시 뜨지 않았습니다. 「이 컴퓨터」에서 상태를 봐 주세요.".into());
    }
    // ── 6. 감독자는 **아직 올리지 않는다** ───────────────────────────
    // 🔴 그록 지적. 지금 올리면 launchd 가 `RunAtLoad` 로 **두 번째**
    //    ravend 를 띄우려 하고, 우리 재색인 프로세스가 datadir 을 쥐고
    //    있으므로 자물쇠에 막혀 30초마다 실패를 반복한다. 끝난 것을
    //    확인한 뒤에 올린다 — 표시를 남겨 두고 `reindex_progress` 가 푼다.
    if held {
        let _ = std::fs::write(crate::paths::app_file("reindex-agent-held"), "1");
    }
    // 🔴 표시 파일은 여기서 안 쓴다. 「걸었다」가 아니라 **「색인이 실제로
    //    답한다」** 일 때만 적어야 한다 — 그록 지적. 아래 진행률에서 쓴다.
    Ok(json!({ "started": true }))
}

/// 얼마나 왔나. 끝났으면 `running` 이 꺼진다.
#[tauri::command]
pub async fn reindex_progress() -> Value {
    let info = crate::raven::call_rpc("getblockchaininfo", json!([])).await.ok();
    let pct = info
        .as_ref()
        .and_then(|v| v["verificationprogress"].as_f64())
        .unwrap_or(0.0);
    // 🔴 진행률만 보고 「끝났다」 하면 안 된다. 색인이 정말 답을 하는지
    //    물어봐야 한다 — 다 훑고도 색인이 비어 있으면 지갑은 여전히 못 쓴다.
    // 🔴 둘 다 답하는지 본다. 주소 색인만 보고 「끝났다」 하면 배당은 여전히
    //    안 된다 — 화면은 초록인데 눌러도 아무 일이 없는 그 상태가 된다.
    let assets_ok = crate::raven::call_rpc("listaddressesbyasset", json!(["SHOP.PLAYX"]))
        .await
        .is_ok();
    let answers = crate::raven::call_rpc(
        "getaddressbalance",
        json!([{ "addresses": ["RXissueAssetXXXXXXXXXXXXXXXXXhhZGt"] }]),
    )
    .await
    .is_ok();
    let answers = answers && assets_ok;
    if answers {
        RUNNING.store(false, Ordering::Relaxed);
        crate::awake::sync_with_mode();
        // 색인이 진짜 답을 했다. 이제서야 표시를 남긴다.
        let _ = std::fs::write(crate::paths::app_file("reindexed-addressindex"), "1");
        let _ = std::fs::write(crate::paths::app_file("reindexed-assetindex"), "1");
        // 그리고 감독자를 돌려놓는다. 이 시점에는 노드가 정상이라
        // launchd 가 두 번째를 띄우려다 실패해도 곧 KeepAlive 가 잠잠해진다.
        let held = crate::paths::app_file("reindex-agent-held");
        if held.exists() {
            agent_release();
            let _ = std::fs::remove_file(held);
        }
    }
    json!({
        "running": RUNNING.load(Ordering::Relaxed),
        "progress": pct,
        "blocks": info.as_ref().map(|v| v["blocks"].clone()).unwrap_or(Value::Null),
        "answers": answers,
        "assets": assets_ok,
    })
}

#[cfg(test)]
mod tests {
    /// 🔴 코어의 오류 문구를 따라가면 안 된다는 것을 코드에 못 박는다.
    /// 누가 나중에 "코어가 -reindex-chainstate 를 쓰라던데" 하고 바꾸면
    /// 가게 노드가 안 뜬다. 그 변경을 여기서 막는다.
    #[test]
    fn 전체_재색인을_쓴다_코어_문구를_따르지_않는다() {
        let src = include_str!("reindex_run.rs");
        assert!(src.contains(r#".arg("-reindex")"#), "-reindex 를 붙여야 한다");
        // 🔴 금지 문자열을 시험 안에 그대로 적으면 **자기 자신을 읽고** 걸린다.
        //    실제로 그렇게 실패했다. 조각으로 나눠 붙인다.
        let banned = format!(".arg(\"-reindex{}\")", "-chainstate");
        assert!(
            !src.contains(&banned),
            "-reindex-chainstate 로는 색인 표시가 안 바뀐다 (validation.cpp:5258 이 needs_init 안에 있다)"
        );
    }

    /// launchd 를 안 내리고 노드를 끄면 30초 뒤에 되살아나 죽는다.
    #[test]
    fn launchd_를_먼저_내린다() {
        let src = include_str!("reindex_run.rs");
        let hold = src.find("let held = agent_hold();").expect("launchd 를 내리는 자리가 있어야 한다");
        let stop = src.find(r#"call_rpc("stop""#).expect("노드를 끄는 자리가 있어야 한다");
        assert!(hold < stop, "노드를 끄기 **전에** launchd 를 내려야 한다");
    }
}
