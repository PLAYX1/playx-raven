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
    let home = crate::paths::home().to_string_lossy().to_string();
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

/// 진행이 **멈췄나.**
///
/// ## 🔴 왜 필요한가
///
/// 대표님 화면에서 블록이 `732,977` 로 13분 동안 **한 칸도 안 움직였다.**
/// 그런데 우리 화면은 「따라잡는 중」이라고만 적고 있었다 — 도는 것과
/// 멈춘 것을 구별하지 못한 것이다. 사장은 그 앞에서 몇 시간을 기다린다.
///
/// 「몇 %」만 보여 주는 것으로는 부족하다. **지난번보다 늘었는가**를
/// 봐야 하고, 그건 우리가 기억해 둬야 안다.
///
/// ⚠️ 재색인 중에는 「따라잡음 %」가 거의 안 움직인다 — 초반 블록은
///    거래가 적어 작업량 기준으로 0.1% 도 안 되기 때문이다. 그래서
///    **블록 수**로 본다. 그게 실제로 나아가는 유일한 표시다.
use std::sync::Mutex;
static SEEN: Mutex<Option<(i64, i64)>> = Mutex::new(None); // (블록, 본 시각)
/// 마지막으로 **제대로 잰** 속도. 화면이 5초마다 묻는데 그 사이에 블록이
/// 안 늘면 「재는 중…」으로 돌아가 버려서, 사장 눈에는 숫자가 깜빡인다.
/// 한 번 잰 값은 다음 값이 나올 때까지 들고 있는다.
static RATE: Mutex<f64> = Mutex::new(0.0);

#[tauri::command]
pub async fn sync_stalled() -> Value {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    let blocks = crate::raven::call_rpc("getblockchaininfo", json!([]))
        .await
        .ok()
        .and_then(|v| v.get("blocks").and_then(Value::as_i64));
    let Some(blocks) = blocks else {
        // 노드가 답을 안 하면 그건 다른 이야기다. 여기서는 판단하지 않는다.
        return json!({ "known": false });
    };

    let mut g = match SEEN.lock() {
        Ok(g) => g,
        Err(e) => e.into_inner(),
    };
    let (last_blocks, since) = g.unwrap_or((blocks, now));
    let mut r = match RATE.lock() {
        Ok(r) => r,
        Err(e) => e.into_inner(),
    };
    if blocks > last_blocks {
        // **초당 몇 블록인지 같이 준다.** 「멈춘 거 아닌가」에 답하는 건
        // %가 아니라 이 숫자다. 대표님 로그에서 4초에 209블록이 지나갔는데
        // %는 0.0003%밖에 안 움직였다 — %만 보면 멎은 줄 안다.
        //
        // ⚠️ **너무 짧게 재지 않는다.** 화면이 5초마다 묻는데 그 창으로
        //    재면 값이 크게 튄다(장부를 디스크에 쏟는 동안에는 0 이 나온다).
        //    20초는 모아서 잰다. 그전에는 지난번 값을 그대로 보여 준다 —
        //    숫자가 깜빡이는 것보다 조금 묵은 숫자가 낫다.
        let secs = now - since;
        if secs >= 20 {
            *r = (blocks - last_blocks) as f64 / secs as f64;
            *g = Some((blocks, now));
        }
        return json!({
            "known": true, "stalled": false, "blocks": blocks,
            "rate": (*r * 10.0).round() / 10.0,
        });
    }
    // 처음 본 값이면 그때를 기준으로 잡는다.
    if g.is_none() {
        *g = Some((blocks, now));
    }
    let quiet_min = (now - since) / 60;
    json!({
        "known": true,
        // 10분은 넉넉히 잡은 것이다. 큰 블록 하나가 몇 분씩 걸릴 수 있다.
        "stalled": quiet_min >= 10,
        "blocks": blocks,
        "quiet_min": quiet_min,
        "why": "블록 수가 늘지 않고 있습니다. 디스크가 꽉 찼거나, 노드가 멈췄을 수 있습니다.",
    })
}

/// 노드가 남긴 기록의 **마지막 몇 줄.**
///
/// ## 🔴 왜 이걸 화면에 내놓나
///
/// 블록이 안 늘 때 우리는 「멈춘 것 같다」까지만 말할 수 있다. **왜**인지는
/// 노드만 안다. 코어는 그걸 `debug.log` 에 계속 적는데, 사장이 그 파일을
/// 찾아 열 방법이 없다 — 숨김 폴더 안이고, 43GB 짜리 폴더 안이다.
///
/// 그래서 마지막 줄들을 그대로 보여 준다. 우리가 해석하지 않는다 —
/// 해석해서 틀리면 사장을 엉뚱한 데로 보낸다. **노드가 한 말을 그대로**
/// 옮기고, 판단은 사람이 한다.
///
/// ⚠️ 마지막 40줄만 읽는다. 이 파일은 수백 MB 가 되기도 한다.
#[tauri::command]
pub fn node_log_tail() -> Value {
    let p = crate::paths::raven_dir().join("debug.log");
    let Ok(meta) = std::fs::metadata(&p) else {
        return json!({ "ok": false, "why": "노드 기록 파일을 찾지 못했습니다.", "path": p.to_string_lossy() });
    };
    // 끝에서부터 읽는다. 앞에서 읽으면 수백 MB 를 훑는다.
    let want: u64 = 16 * 1024;
    let from = meta.len().saturating_sub(want);
    let mut f = match std::fs::File::open(&p) {
        Ok(f) => f,
        Err(e) => return json!({ "ok": false, "why": e.to_string() }),
    };
    use std::io::{Read, Seek, SeekFrom};
    if f.seek(SeekFrom::Start(from)).is_err() {
        return json!({ "ok": false, "why": "기록을 읽지 못했습니다." });
    }
    let mut buf = Vec::new();
    if f.read_to_end(&mut buf).is_err() {
        return json!({ "ok": false, "why": "기록을 읽지 못했습니다." });
    }
    let text = String::from_utf8_lossy(&buf);
    let lines: Vec<&str> = text.lines().rev().take(40).collect();
    let tail: Vec<String> = lines.into_iter().rev().map(|s| s.to_string()).collect();
    json!({
        "ok": true,
        "path": p.to_string_lossy(),
        "size_mb": (meta.len() as f64 / 1_048_576.0 * 10.0).round() / 10.0,
        "lines": tail,
    })
}

/// **「남은 블록」을 믿어도 되는가.**
///
/// ## 🔴 화면이 거짓말을 하고 있었다
///
/// 우리는 `headers - blocks` 를 「남은 블록」으로 적었다. 평소에는 맞다 —
/// `headers` 가 남들이 알려 준 진짜 체인 끝이기 때문이다.
///
/// **재색인 중에는 아니다.** 그때 `headers` 는 디스크에서 읽어 나간 만큼만
/// 늘어난다. 그래서 둘의 차이가 늘 작게 나오고, 화면에는 「남은 블록
/// 167,999」처럼 **거의 다 온 것처럼** 적힌다. 실제로는 전체의 0.6% 였다.
///
/// 사장은 그걸 보고 「곧 끝나겠네」 하고 기다린다. 며칠이 걸린다.
///
/// ⚠️ 판별법: 따라잡음이 한참 남았는데(`progress` 가 낮은데) 남은 블록이
///    적게 나오면, 그 숫자는 진짜 끝까지의 거리가 아니다.
pub fn behind_is_honest(progress: f64, behind: i64, blocks: i64) -> bool {
    if progress >= 0.99 {
        return true; // 다 따라잡았으면 남은 것도 진짜다
    }
    // 아직 절반도 못 왔는데 남은 것이 지금까지 온 것보다 적다면,
    // `headers` 가 진짜 끝을 모르고 있다는 뜻이다.
    !(progress < 0.9 && behind < blocks)
}

#[cfg(test)]
mod behind_tests {
    use super::behind_is_honest;

    /// 대표님 화면에 실제로 뜬 값. 0.6% 인데 「남은 블록 167,999」였다.
    #[test]
    fn 재색인_중의_남은_블록은_믿지_않는다() {
        assert!(!behind_is_honest(0.0062, 167_999, 732_977));
    }

    /// 평소 따라잡기(헤더가 진짜 끝을 안다)에서는 그대로 쓴다.
    #[test]
    fn 평소_따라잡기에서는_그대로_쓴다() {
        assert!(behind_is_honest(0.30, 3_000_000, 900_000));
        assert!(behind_is_honest(0.999, 12, 4_500_000));
    }
}

/// **장부가 깨졌나** — 노드 기록을 읽어서 판단한다.
///
/// ## 🔴 왜 우리가 읽어야 하나
///
/// 대표님 노드가 켤 때마다 죽었고, 「지금 켜기」를 몇 번이나 누르셨다.
/// 화면은 「노드가 꺼져 있습니다」만 반복했다. **왜 꺼졌는지는 우리가
/// 안 봤다.** 그런데 노드는 자기 기록에 정확히 적어 놨다:
///
///     Corrupted block database detected.
///     Please restart with -reindex or -reindex-chainstate to recover.
///
/// 사장이 그 파일을 찾아 열 방법은 없다. **우리가 읽고 고칠 단추를 준다.**
///
/// ⚠️ 마지막 부분만 본다. 옛날에 한 번 났던 오류를 지금 일로 착각하면
///    멀쩡한 노드를 몇 시간 세운다.
#[tauri::command]
pub fn chain_broken() -> Value {
    let tail = node_log_tail();
    if tail["ok"] != json!(true) {
        return json!({ "broken": false, "known": false });
    }
    let lines: Vec<String> = tail["lines"]
        .as_array()
        .map(|a| a.iter().filter_map(|v| v.as_str().map(String::from)).collect())
        .unwrap_or_default();
    let text = lines.join("\n");
    let broken = text.contains("Corrupted block database detected")
        || text.contains("irrecoverable inconsistency");
    // 🔴 **「고쳐지고 있는 중」을 「깨졌다」로 말하면 안 된다.**
    //
    //    2026-08-28: 대표님 컴퓨터에서 `ravend` 가 CPU 34.8% · 디스크
    //    34.5MB/s 로 **한창 다시 계산하고 있는데** 화면은 「장부가
    //    깨졌습니다 / 장부 고치기」를 내밀고 있었다. 그걸 누르면 잘 되던
    //    것을 껐다 켠다 — **하마터면 몇 시간을 날릴 뻔했다.**
    //
    //    까닭은 내가 「고쳐졌다」의 표시를 하나로만 봤기 때문이다:
    //    `init message: Verifying blocks`. 그런데 `-reindex-chainstate`
    //    중에는 그 줄이 안 나오고 **`UpdateTip` 이 계속 나온다.**
    //
    //    표시를 넓힌다 — 그 오류 뒤에 **노드가 일하고 있다는 어떤 흔적이든**
    //    있으면 「고쳐지는 중」으로 본다. 덜 막는 쪽이 안전하다:
    //    · 잘못 「깨졌다」고 하면 → 사장이 잘 되는 걸 껐다 켠다 (몇 시간 손해)
    //    · 잘못 「괜찮다」고 하면 → 다음에 켤 때 또 알게 된다 (손해 없음)
    const WORKING: [&str; 5] = [
        "init message: Verifying blocks",
        "UpdateTip",                       // 재계산·따라잡기 둘 다 이걸 찍는다
        "Rebuilding chain state",
        "Reindexing block file",
        "LoadBlockIndexDB",
    ];
    let bad = lines
        .iter()
        .rposition(|l| l.contains("Corrupted block database detected"));
    let working = lines
        .iter()
        .rposition(|l| WORKING.iter().any(|w| l.contains(w)));
    let recovered = match (bad, working) {
        (Some(b), Some(w)) => w > b,
        // 오류가 아예 없으면 깨진 것도 아니다.
        (None, _) => true,
        _ => false,
    };
    json!({
        "known": true,
        "broken": broken && !recovered,
        "why": "장부가 깨졌습니다. 노드가 켜질 때마다 그 자리를 만나 스스로 꺼집니다.",
        "how": "계산을 다시 하면 고쳐집니다. 블록 파일은 그대로 쓰므로 다시 받지 않습니다.",
    })
}

/// 다음에 켤 때 **계산을 다시 하게** 표시해 둔다.
#[tauri::command]
pub async fn chain_heal() -> Result<Value, String> {
    std::fs::write(crate::paths::app_file("chainstate-heal"), "1")
        .map_err(|e| format!("표시를 못 남겼습니다: {e}"))?;
    // 꺼져 있으면 그냥 켠다. 켜져 있으면 껐다 켠다 — 어느 쪽이든 새 인자로 뜬다.
    let _ = crate::services::services_stop();
    tokio::time::sleep(std::time::Duration::from_secs(3)).await;
    let r = crate::services::services_start().await;
    Ok(json!({
        "ok": r.is_ok(),
        "note": "계산을 다시 하기 시작했습니다. 블록 파일은 다시 받지 않습니다 — \
                 몇 시간 걸릴 수 있고, 그동안 컴퓨터를 켜 두시면 됩니다.",
    }))
}

#[cfg(test)]
mod heal_tests {
    /// 🔴 **`-reindex` 가 아니라 `-reindex-chainstate`** 여야 한다.
    ///    블록 파일은 멀쩡한데 다시 받으면 며칠이 걸린다.
    #[test]
    fn 블록을_다시_받지_않는다() {
        let src = include_str!("services.rs");
        let end = src.find("#[cfg(test)]").unwrap_or(src.len());
        assert!(
            src[..end].contains("-reindex-chainstate"),
            "고칠 때 계산만 다시 하는 인자를 안 쓰고 있다"
        );
    }

    /// 표시를 지우고 붙인다. 안 지우면 켤 때마다 다시 계산한다.
    #[test]
    fn 한_번만_고친다() {
        let src = include_str!("services.rs");
        let i = src.find("let heal = crate::paths::app_file").expect("있어야 한다");
        let seg = &src[i..i + 400.min(src.len() - i)];
        assert!(seg.contains("remove_file"), "표시를 안 지우고 있다 — 매번 다시 계산한다");
    }
}

#[cfg(test)]
mod broken_tests {
    /// 「깨졌나」를 판정하는 함수 본문만 잘라 온다.
    fn 판정함수() -> &'static str {
        let src = include_str!("reindex_run.rs");
        let i = src.find("pub fn chain_broken").expect("판정 함수가 있어야 한다");
        let end = src[i..].find("\n/// 다음에 켤 때").unwrap_or(src.len() - i);
        &src[i..i + end]
    }

    /// 🔴 **한창 고치는 중인데 「깨졌다」고 하면 안 된다.**
    ///
    /// 2026-08-28 대표님 컴퓨터에서 실제로 그랬다 — `ravend` 가 디스크를
    /// 초당 34MB 씩 읽으며 다시 계산하고 있는데 화면은 「장부 고치기」를
    /// 내밀었다. 눌렀으면 잘 되던 것을 껐다 켜서 몇 시간을 날렸다.
    #[test]
    fn 재계산_중을_깨진_것으로_보지_않는다() {
        // ⚠️ 이 파일에는 `#[cfg(test)]` 가 여럿이라 「첫 것까지」로 자르면
        //    보려는 함수가 범위 밖으로 나간다(실제로 그래서 시험이 헛돌았다).
        //    **볼 함수 본문만** 잘라서 본다.
        let code = 판정함수();
        // `-reindex-chainstate` 중에 노드가 실제로 찍는 줄들이 표시에 있어야 한다.
        for 표시 in ["UpdateTip", "Rebuilding chain state"] {
            assert!(
                code.contains(&format!("\"{표시}")) || code.contains(표시),
                "「{표시}」 을 「일하는 중」 표시로 안 보고 있다 — \
                 재계산 중인 노드를 「깨졌다」고 말하게 된다"
            );
        }
    }

    /// 오류가 아예 없으면 깨진 것도 아니다. 「모름」을 「깨짐」으로 치면
    /// 멀쩡한 노드를 껐다 켜게 만든다.
    #[test]
    fn 오류가_없으면_깨진_것이_아니다() {
        assert!(
            판정함수().contains("(None, _) => true"),
            "오류가 없을 때 「고쳐짐」으로 안 보고 있다"
        );
    }
}
