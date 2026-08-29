//! Running the node and IPFS, instead of asking someone else to.
//!
//! ## The five steps that were the real problem
//!
//! Before this, opening the shop meant: start the Ravencoin node, start IPFS,
//! start this app, switch on the phone server, switch on the tunnel. Five
//! things, in order, every time the machine reboots. Nobody does that five
//! times and keeps doing it.
//!
//! This app already knows when each of those is down — the health check says
//! so in plain words. Knowing and not acting is the gap. So it starts them.
//!
//! ## What it deliberately does not do
//!
//! **It does not install anything.** Downloading and running a binary on
//! someone's behalf is how a shop POS becomes a malware vector, and a wallet
//! that fetches its own node cannot prove what it fetched. Missing software is
//! reported with the one command to install it, and that command is run by a
//! person who can read it.
//!
//! **It does not stop what it did not start.** If the owner already has a node
//! running — from Ravencoin Core, from a launch agent, from a terminal — this
//! attaches to it and leaves it alone. Killing someone else's node mid-sync is
//! not ours to do.

use serde_json::{json, Value};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;

/// Processes this app started, so it can stop exactly those and no others.
static OURS: Mutex<Option<Vec<(String, Child)>>> = Mutex::new(None);

/// 우리 설치 파일에 **같이 들어온** 프로그램이 있나.
///
/// 🔴 사장님께 「먼저 레이븐 코어를 받아 설치하세요」라고 말하는 순간 문이
/// 닫힌다. 70대 사장이 그걸 하지 않는다. 그래서 노드를 **우리 설치 파일에
/// 같이 넣는다.**
///
/// 실행 중에 내려받는 것과는 다르다. 그건 계속 안 한다 — 무엇을 받았는지
/// 증명할 수 없고, 계산대 프로그램이 악성코드가 되는 길이다. 같이 넣은 것은
/// **우리가 서명한 설치 파일 안**에 있고, 만들 때 체크섬으로 확인한다.
fn bundled(name: &str) -> Option<std::path::PathBuf> {
    let src = bundled_src(name)?;
    // 설치 폴더의 것을 **그대로 돌리지 않는다.** 아래 함수의 주석을 볼 것.
    Some(runnable_copy(&src).unwrap_or(src))
}

/// 같이 넣은 것을 **딴 자리로 복사해서 거기서 돌린다.**
///
/// ## 🔴 왜 이런 짓을 하나 — 업데이트가 통째로 막혔다
///
/// 윈도우는 **돌고 있는 실행 파일을 덮어쓰지 못한다.** 우리는 파일창고를
/// 설치 폴더(`...\PLAY X Raven\vendor\ipfs.exe`)에서 띄우고, 앱을 닫아도
/// 살아 있게 잡에서 떼어 놨다(`CREATE_BREAKAWAY_FROM_JOB`). 밤새 손님이
/// 사진을 볼 수 있어야 하니 그건 맞다.
///
/// 그런데 그 둘이 겹치니 **새 판을 설치할 수 없게 됐다.** 설치 프로그램이
/// 그 파일에서 멈추고 「다음 파일을 열 수 없습니다」를 띄운다. 자동으로
/// 켜지게 만든 바로 그날 업데이트가 막힌 것이다.
///
/// 고르는 길은 둘이었다. ① 설치 전에 죽인다 — 노드를 급하게 죽이면 장부가
/// 상할 수 있고, 설치 프로그램에 그 판단을 맡기고 싶지 않다. ② **설치 폴더의
/// 것은 건드리지 않는다.** 이쪽을 골랐다. 설치 프로그램이 잠긴 파일을 만날
/// 일이 아예 없어진다.
///
/// ⚠️ 같은 것인지는 **크기로** 본다. 우리가 넣는 것은 위쪽에 못 박아 둔
/// 판(ravend 4.8.0 · kubo 0.43.0)뿐이라, 판이 바뀌면 크기가 바뀐다.
/// 복사가 실패하면(= 지금 그게 돌고 있으면) 있던 것을 그대로 쓴다 —
/// 판을 올리려다 가게를 세우는 것이 제일 나쁘다.
fn runnable_copy(src: &std::path::Path) -> Option<std::path::PathBuf> {
    let dir = crate::paths::app_dir().join("run");
    std::fs::create_dir_all(&dir).ok()?;
    let dst = dir.join(src.file_name()?);
    let same = match (std::fs::metadata(src), std::fs::metadata(&dst)) {
        (Ok(a), Ok(b)) => a.len() == b.len(),
        _ => false,
    };
    if !same && std::fs::copy(src, &dst).is_ok() {
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&dst, std::fs::Permissions::from_mode(0o755));
        }
    }
    if dst.is_file() {
        Some(dst)
    } else {
        None
    }
}

fn bundled_src(name: &str) -> Option<std::path::PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let dir = exe.parent()?;
    let file = if cfg!(windows) { format!("{name}.exe") } else { name.to_string() };
    for p in [
        // 윈도우 NSIS·리눅스: 실행 파일 옆
        // Tauri `resources` 는 상대 경로를 그대로 살려 넣는다.
        // 우리는 `vendor/ravend` 로 넣으므로 그 자리를 먼저 본다.
        dir.join("vendor").join(&file),
        dir.join(&file),
        dir.join("bin").join(&file),
        // 맥: PLAY X Raven.app/Contents/MacOS/ 옆의 Resources/
        dir.join("../Resources/vendor").join(&file),
        dir.join("../Resources").join(&file),
        dir.join("../Resources/bin").join(&file),
        // 리눅스 AppImage: usr/bin/ 옆의 usr/lib/
        dir.join("../lib").join(&file),
    ] {
        if p.is_file() {
            return Some(p);
        }
    }
    None
}

pub fn which(name: &str) -> Option<String> {
    // 🔴 **이미 깔려 있는 것이 먼저다.** 우리가 넣은 것은 아무것도 없을 때의
    //    받침이다. 순서를 반대로 하면 이런 일이 난다:
    //
    //    사장이 IPFS 를 오래 써 왔고 자료가 옛 판 형식으로 쌓여 있다. 그런데
    //    우리가 넣은 새 판이 먼저 잡히면, 그 판은 **옛 자료를 그대로 못 읽고**
    //    「먼저 자료를 옮기세요」 하며 안 뜬다. 잘 돌던 가게가 우리 때문에
    //    멈추는 것이다. 코어 지갑도 같다 — 쓰던 것을 우리가 갈아 치우면 안 된다.
    //
    //    그래서 있는 것을 그대로 쓰고, 없을 때만 우리 것을 쓴다.
    // GUI 앱은 PATH 가 거의 비어 있다. 코어를 깔아 둔 자리를 직접 본다.
    let home = crate::paths::home();
    let mut cands: Vec<std::path::PathBuf> = Vec::new();
    #[cfg(target_os = "macos")]
    {
        cands.push(std::path::PathBuf::from("/opt/homebrew/bin").join(name));
        cands.push(std::path::PathBuf::from("/usr/local/bin").join(name));
        cands.push(home.join("RavencoinBuilds-4.8.0/macos-arm64").join(name));
        cands.push(std::path::PathBuf::from("/Applications/Raven-Qt.app/Contents/MacOS").join(name));
        cands.push(home.join("Applications/Raven-Qt.app/Contents/MacOS").join(name));
        cands.push(home.join(".local/bin").join(name));
    }
    #[cfg(target_os = "windows")]
    {
        let exe = format!("{name}.exe");
        for root in [
            std::env::var("ProgramFiles").unwrap_or_else(|_| r"C:\Program Files".into()),
            std::env::var("ProgramFiles(x86)").unwrap_or_else(|_| r"C:\Program Files (x86)".into()),
            std::env::var("LOCALAPPDATA").unwrap_or_default(),
            // 32비트로 도는 프로세스에서는 `ProgramFiles` 가 (x86) 을 가리킨다.
            // 진짜 64비트 자리는 이 변수에만 있다.
            std::env::var("ProgramW6432").unwrap_or_default(),
        ] {
            if root.is_empty() {
                continue;
            }
            let r = std::path::PathBuf::from(root);
            // 🔴 여기가 좁아서 **코어를 깔아 둔 컴퓨터에서도 못 찾았다.**
            //
            //    레이븐 코어 윈도우 설치본은 데몬을 `daemon\` 아래에 둔다
            //    (비트코인 코어와 같은 배치다). 그런데 예전 목록에는
            //    `Ravencoin\daemon` 만 있고 **`Raven\daemon` 이 없었다** —
            //    가장 흔한 자리가 빠져 있었던 것이다. 폴더 이름도 설치본마다
            //    다르다: `Raven`, `RavenCore`, `Raven Core`(공백), `Ravencoin`.
            //
            //    빠짐없이 훑는다. 파일이 있는지 보는 것뿐이라 값이 안 든다.
            for folder in [
                "Raven",
                "RavenCore",
                "Raven Core",
                "Ravencoin",
                "Ravencoin Core",
                "RavenCoin",
            ] {
                // 데몬을 `daemon\` 아래 두는 설치본이 더 흔하다. 먼저 본다.
                cands.push(r.join(folder).join("daemon").join(&exe));
                cands.push(r.join(folder).join(&exe));
                // Qt 만 깔린 컴퓨터도 있다. 그 옆에 데몬이 같이 오는 판이 많다.
                cands.push(r.join(folder).join("bin").join(&exe));
            }
        }
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        cands.push(std::path::PathBuf::from("/usr/bin").join(name));
        cands.push(std::path::PathBuf::from("/usr/local/bin").join(name));
        cands.push(home.join(".local/bin").join(name));
    }
    // 🔴 못 찾았을 때 **어디를 봤는지** 남긴다. 이게 없으면 화면은
    //    「설치되어 있지 않습니다」만 말하고, 코어를 멀쩡히 깔아 둔 사장은
    //    자기가 뭘 잘못했는지 영영 알 수 없다. 실제로 그 상태였다.
    let looked: Vec<String> = cands.iter().map(|p| p.to_string_lossy().to_string()).collect();
    let hit = cands
        .into_iter()
        .find(|p| p.is_file())
        .map(|p| p.to_string_lossy().to_string())
        .or_else(|| look_on_path(name))
        // 아무 데도 없으면 우리가 같이 넣은 것을 쓴다. 사장이 아무것도
        // 안 깔아도 가게가 돌아야 한다.
        .or_else(|| bundled(name).map(|p| p.to_string_lossy().to_string()));
    if hit.is_none() {
        if let Ok(mut g) = LOOKED.lock() {
            g.get_or_insert_with(Default::default)
                .insert(name.to_string(), looked);
        }
    }
    hit
}

/// 마지막으로 훑어 본 자리들. 「없습니다」라고 말할 때 같이 보여 준다.
static LOOKED: Mutex<Option<std::collections::HashMap<String, Vec<String>>>> = Mutex::new(None);

fn looked_at(name: &str) -> Vec<String> {
    LOOKED
        .lock()
        .ok()
        .and_then(|g| g.as_ref().and_then(|m| m.get(name).cloned()))
        .unwrap_or_default()
}

fn look_on_path(name: &str) -> Option<String> {
    #[cfg(target_os = "windows")]
    {
        let out = crate::quiet::cmd("where").arg(name).output().ok()?;
        if !out.status.success() {
            return None;
        }
        let line = String::from_utf8_lossy(&out.stdout)
            .lines()
            .next()?
            .trim()
            .to_string();
        return if line.is_empty() { None } else { Some(line) };
    }
    #[cfg(not(target_os = "windows"))]
    {
        let out = Command::new("which").arg(name).output().ok()?;
        if !out.status.success() {
            return None;
        }
        let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
        if s.is_empty() {
            None
        } else {
            Some(s)
        }
    }
}

/// Is each piece installed, running, and did we start it?
#[tauri::command]
pub async fn services_status() -> Value {
    let node_running = crate::raven::call_rpc("getblockchaininfo", json!([]))
        .await
        .is_ok();
    let ipfs_running = reqwest::Client::new()
        .post("http://127.0.0.1:5001/api/v0/id")
        .timeout(std::time::Duration::from_secs(4))
        .send()
        .await
        .map(|r| r.status().is_success())
        .unwrap_or(false);

    let started: Vec<String> = OURS
        .lock()
        .ok()
        .and_then(|g| g.as_ref().map(|v| v.iter().map(|(n, _)| n.clone()).collect()))
        .unwrap_or_default();

    json!({
        "node": {
            "running": node_running,
            "installed": which("ravend").is_some(),
            "path": which("ravend"),
            "ours": started.contains(&"node".to_string()),
            // 0.1.5 부터 윈도우·리눅스는 설치 파일에 같이 들어간다.
            // 맥(애플 실리콘)은 공식 배포가 없어 아직 따로 깔아야 한다.
            "install": if cfg!(target_os = "macos") {
                "레이븐 노드를 설치해 주세요. 애플 실리콘 맥은 공식 배포가 없어 아직 같이 넣지 못합니다."
            } else {
                "노드가 없습니다. PLAY X Raven 을 다시 받아 설치하시면 같이 들어옵니다."
            },
            // 못 찾았으면 어디를 봤는지 같이 준다. 사장이 자기 설치 자리를
            // 알려 주면 그 자리를 다음 판에 넣을 수 있다.
            "looked": looked_at("ravend"),
        },
        "ipfs": {
            "running": ipfs_running,
            "installed": which("ipfs").is_some(),
            "path": which("ipfs"),
            "ours": started.contains(&"ipfs".to_string()),
            // 🔴 여기가 「brew install ipfs」 라고 적혀 있었다. `brew` 는 맥
            //    명령어다. **윈도우 사장에게는 막다른 길**이고, 이 프로그램의
            //    사장은 터미널을 열어 본 적이 없다.
            //
            //    0.1.5 부터는 설치 파일에 같이 들어가므로 여기까지 오는 일이
            //    거의 없다. 그래도 올 수 있으니(옛 판을 쓰거나, 우리가 넣은
            //    것을 지웠거나) 사람이 할 수 있는 말로 적는다.
            "install": if cfg!(target_os = "windows") {
                "파일창고가 없습니다. PLAY X Raven 을 다시 받아 설치하시면 같이 들어옵니다."
            } else if cfg!(target_os = "macos") {
                "파일창고가 없습니다. PLAY X Raven 을 다시 받아 설치하시면 같이 들어옵니다. (직접 깔려면 brew install ipfs)"
            } else {
                "파일창고가 없습니다. PLAY X Raven 을 다시 받아 설치하시면 같이 들어옵니다."
            },
        },
    })
}

/// Starts whichever pieces are installed and not already running.
///
/// Attaching to something already up is the normal case and produces no output
/// — a shop that had its node running should see nothing happen, not a second
/// node fighting for the same wallet file.
#[tauri::command]
pub async fn services_start() -> Result<Value, String> {
    let status = services_status().await;
    let mut started = Vec::new();
    let mut skipped = Vec::new();

    // ── node ──
    if status["node"]["running"].as_bool().unwrap_or(false) {
        skipped.push(json!({ "what": "노드", "why": "이미 켜져 있습니다" }));
    } else if let Some(path) = which("ravend") {
        let datadir = crate::paths::raven_dir().to_string_lossy().to_string();

        // 🔴 자산 색인을 켜면 **다시 훑어야 한다.** 그런데 코어는 자산 색인이
        // 바뀐 것을 **검사하지 않는다**(init.cpp 에 txindex·addressindex 분기는
        // 있는데 assetindex 만 없다). 그래서 설정만 바꾸고 켜면 노드는 말없이
        // 옛 상태로 돌고, 배당은 계속 "색인이 꺼져 있습니다" 를 답한다.
        //
        // 우리가 대신 붙인다. 한 번 붙이고 나면 표시를 남겨 다음부터는 안 붙인다 —
        // 켤 때마다 34GB 를 다시 훑으면 그 가게는 영영 장사를 못 한다.
        let want_asset = crate::conf::wants_assetindex();
        let stamp = crate::paths::app_file("reindexed-assetindex");
        // 🔴 주소 색인도 같은 처리가 필요하다. 다만 이쪽은 코어가 검사해서,
        //    `-reindex` 없이 켜면 노드가 **아예 안 뜬다**. 조용히 틀리는 게
        //    아니라 가게가 멈춘다 — 더 급한 쪽이다.
        let want_addr = crate::conf::wants_addressindex();
        let addr_stamp = crate::paths::app_file("reindexed-addressindex");
        // 🔴 **여기서 대표님 컴퓨터가 34GB 를 처음부터 다시 훑었다.**
        //
        //    예전 줄: `(want_asset && !stamp.exists()) || (want_addr && !addr_stamp.exists())`
        //    표시 파일이 없으면 무조건 `-reindex` 를 붙였다. 그런데 표시가
        //    없는 것과 색인이 없는 것은 **다른 말이다.** 색인을 이미 갖춘
        //    노드에 우리 앱을 처음 깔면 표시만 없다 — 그런데 그 한 줄이
        //    말없이 몇 시간을 태웠다. 100% 였던 노드가 0% 가 됐다.
        //
        //    이제 **먼저 그냥 켜 본다.** 색인이 이미 있으면 잘 뜨고,
        //    표시만 남기면 끝난다. 정말 다시 훑어야 하는 경우에는 코어가
        //    「-reindex 로 다시 만들어야 한다」고 하며 안 뜨고, 그때
        //    **사람에게 물어본다.** 몇 시간짜리 일을 말없이 벌이지 않는다.
        //
        //    ⚠️ 한번 시작한 재색인은 **중간에 못 멈춘다.** 코어가 그 상태를
        //       디스크에 적어 두고 다음에 켜도 이어서 한다. 그래서 시작하기
        //       전이 유일한 기회다.
        //    ⚠️ 표시 이름은 **이미 있는 것을 쓴다**(`reindex-armed`). 새로
        //       만들면 「한가할 때 다시 훑기」 화면과 두 벌이 되고, 이
        //       저장소에서 그 병을 오늘만 세 번 봤다.
        let armed = crate::paths::app_file("reindex-armed").exists();
        let need_reindex = armed && ((want_asset && !stamp.exists()) || (want_addr && !addr_stamp.exists()));

        let mut cmd = Command::new(&path);
        cmd.arg(format!("-datadir={datadir}")).arg("-server=1");
        // 🔴 **장부가 깨졌을 때 스스로 못 일어나던 것.**
        //
        // 2026-08-27 대표님 노드가 켤 때마다 죽었다. 로그가 정확히 말했다:
        //
        //     ERROR: VerifyDB(): *** irrecoverable inconsistency at 732975
        //     : Corrupted block database detected.
        //     Please restart with -reindex or -reindex-chainstate to recover.
        //     Aborted block database rebuild. Exiting.
        //
        // 켤 때마다 「마지막 6블록 검증」에서 그 자리를 만나 스스로 종료한다.
        // 그래서 「지금 켜기」를 몇 번 눌러도 소용이 없다 — 사장은 왜인지
        // 모른 채 계속 누른다. 실제로 그렇게 겪으셨다.
        //
        // ⚠️ `-reindex` 가 아니라 **`-reindex-chainstate`** 다. 블록 파일은
        //    멀쩡하다(로그의 `Checking all blk files are present...` 통과).
        //    다시 받지 않고 **계산만 다시 한다.** 몇 시간 대 며칠의 차이다.
        //
        // ⚠️ 한 번만 붙인다. 표시를 지우고 붙이므로 다음 켜기에는 안 붙는다 —
        //    성공했는데 또 붙이면 매번 다시 계산하게 된다.
        let heal = crate::paths::app_file("chainstate-heal");
        let need_heal = heal.exists();
        if need_heal {
            let _ = std::fs::remove_file(&heal);
            cmd.arg("-reindex-chainstate");
        } else if need_reindex {
            cmd.arg("-reindex");
        }
        match spawn_node(cmd, &datadir).await {
            Ok(child) => {
                if let Some(c) = child {
                    remember("node", c);
                }
                if need_reindex {
                    // 한 번만 붙인다. 표시를 남기지 않으면 켤 때마다 다시 훑는다.
                    if want_asset {
                        let _ = std::fs::write(&stamp, "1");
                    }
                    if want_addr {
                        let _ = std::fs::write(&addr_stamp, "1");
                    }
                }
                started.push(json!({
                    "what": "노드",
                    "note": if need_reindex {
                        "자산 색인을 만드느라 처음부터 다시 훑습니다 — 몇 시간 걸립니다. 그동안 주문 확인이 멈춥니다."
                    } else {
                        "따라잡는 중입니다. 처음이면 며칠 걸릴 수 있습니다 — 남은 시간은 「이 컴퓨터 → RVN 노드」에서 보입니다"
                    },
                    "reindexing": need_reindex,
                }));
            }
            Err(why) => skipped.push(json!({ "what": "노드", "why": why })),
        }
    } else {
        skipped.push(json!({ "what": "노드", "why": "설치되어 있지 않습니다" }));
    }

    // ── ipfs ──
    if status["ipfs"]["running"].as_bool().unwrap_or(false) {
        skipped.push(json!({ "what": "IPFS", "why": "이미 켜져 있습니다" }));
    } else if let Some(path) = which("ipfs") {
        // `--migrate` because a kubo upgrade otherwise stops at a prompt nobody
        // is watching, and the shop just sees IPFS never coming up.
        // 🔴 창 숨김을 여기만 빠뜨렸다. 노드에는 걸어 두고 파일창고에는
        //    안 걸어서, 윈도우에서 **검은 창이 하나 떠 있었다.** 사장은
        //    「이게 뭐지」 하고 닫는다 — 닫으면 파일창고가 같이 죽는다.
        //
        //    그리고 잡에서 빠져나온다(BREAKAWAY). 안 그러면 앱을 닫을 때
        //    파일창고도 같이 죽어서, 손님이 밤에 사진을 못 본다.
        let mut ipfs_cmd = crate::quiet::cmd(&path);
        ipfs_cmd.args(["daemon", "--migrate=true"]);
        #[cfg(target_os = "windows")]
        {
            use std::os::windows::process::CommandExt;
            // CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP | CREATE_BREAKAWAY_FROM_JOB
            ipfs_cmd.creation_flags(0x0800_0000 | 0x0000_0200 | 0x0100_0000);
        }
        match ipfs_cmd
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
        {
            Ok(child) => {
                remember("ipfs", child);
                started.push(json!({ "what": "IPFS", "note": "" }));
            }
            Err(e) => skipped.push(json!({ "what": "IPFS", "why": e.to_string() })),
        }
    } else {
        skipped.push(json!({ "what": "IPFS", "why": "설치되어 있지 않습니다 — brew install ipfs" }));
    }

    Ok(json!({ "started": started, "skipped": skipped }))
}

/// 노드를 띄우고, **정말 떴는지 확인해서** 답한다.
///
/// ## 🔴 왜 이 함수가 생겼나 — 셋 다 실제 결함이었다
///
/// ① **윈도우에서는 노드가 아예 안 떴다.** 예전 코드는 `-daemon` 을 조건 없이
///    붙였는데, 레이븐코어 원본이 이렇다:
///
///    ```text
///    ravend.cpp:166  "Error: -daemon is not supported on this operating system"
///                    return false;
///    ```
///
///    윈도우 갈래가 없어 맥·리눅스와 같은 줄을 탔고, 코어는 그 자리에서 죽었다.
///
/// ② **죽어도 성공으로 보고했다.** `stderr` 를 `Stdio::null()` 로 버리고
///    `spawn()` 이 `Ok` 면 「따라잡는 데 몇 분 걸립니다」를 띄웠다. 프로세스가
///    떴다가 곧바로 죽었는지 보는 코드가 한 곳도 없었다(`try_wait` 0곳).
///    사장은 몇 분을 기다리다 몇 시간을 기다린다.
///
/// ③ 그래서 여기서 **잠깐 기다렸다 살아 있는지 본다.** 실패면 코어가 낸
///    문장을 그대로 읽어 사장이 할 수 있는 말로 바꾼다.
///
/// ## 유닉스와 윈도우가 다른 이유
///
/// 유닉스는 `-daemon` 이 된다. 부모가 `fork` 하고 바로 끝나므로 부모의 종료
/// 코드로 초기 실패를 알 수 있다. 대신 부모가 이미 없으니 돌려줄 `Child` 가
/// 없다(`None`).
///
/// 윈도우는 `-daemon` 이 없으니 우리가 대신 떼어 놓는다 — `DETACHED_PROCESS`
/// 로 띄우면 이 앱을 닫아도 노드는 계속 돈다. 가게는 밤새 입금을 받아야 한다.
async fn spawn_node(mut cmd: Command, datadir: &str) -> Result<Option<Child>, String> {
    // 🔴 락 충돌은 **`stderr` 로 못 잡는다.** 레이븐코어 원본 순서가 이렇다:
    //
    //    ravend.cpp   "Raven server starting" → daemon(1, 0) → AppInitLockDataDirectory()
    //
    //    즉 락 실패는 **fork 이후**에 일어나고, `daemon(1, 0)` 의 둘째 인자 0 이
    //    FD 를 전부 닫아 버린다. 부모는 이미 0 으로 끝나 있다. 그래서 유닉스에서
    //    ravend 의 출력만 보면 **락 충돌이 성공으로 보인다.**
    //
    //    남는 자리는 `debug.log` 뿐이다. 다만 옛 줄을 읽으면 지난주 충돌을
    //    오늘 일로 착각하므로, **띄우기 전 길이를 재 두고 그 뒤에 붙은 것만**
    //    읽는다. 시각을 파싱할 필요가 없고 틀릴 자리도 없다.
    let log = std::path::Path::new(datadir).join("debug.log");
    let log_was = std::fs::metadata(&log).map(|m| m.len()).unwrap_or(0);

    let out = spawn_node_inner(&mut cmd).await;

    // 프로세스가 떴어도 락 때문에 곧 죽을 수 있다. 그 줄이 로그에 닿을 틈을 준다.
    tokio::time::sleep(std::time::Duration::from_millis(2500)).await;
    if let Some(added) = tail_since(&log, log_was) {
        if let Some(why) = lock_line(&added) {
            return Err(why);
        }
    }
    out
}

/// 띄운 뒤 `debug.log` 에 **새로 붙은 부분**만 읽는다.
fn tail_since(log: &std::path::Path, from: u64) -> Option<String> {
    use std::io::{Read, Seek, SeekFrom};
    let mut f = std::fs::File::open(log).ok()?;
    f.seek(SeekFrom::Start(from)).ok()?;
    let mut buf = Vec::new();
    f.take(64 * 1024).read_to_end(&mut buf).ok()?;
    Some(String::from_utf8_lossy(&buf).to_string())
}

/// 새로 붙은 로그에 락 충돌이 있나.
fn lock_line(added: &str) -> Option<String> {
    let low = added.to_lowercase();
    if low.contains("cannot obtain a lock") || low.contains("probably already running") {
        return Some(node_why("Cannot obtain a lock on data directory"));
    }
    None
}

// `return` 을 일부러 적는다 — 아래 두 갈래가 `cfg` 로 갈리므로, 꼬리
// 표현식에 기대면 어느 쪽이 반환값인지가 대상 운영체제에 따라 달라진다.
#[allow(clippy::needless_return)]
async fn spawn_node_inner(cmd: &mut Command) -> Result<Option<Child>, String> {
    #[cfg(not(target_os = "windows"))]
    {
        // 부모는 `fork` 직후 끝난다. 그래서 기다려도 오래 안 걸린다.
        let out = cmd
            .arg("-daemon")
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .output()
            .map_err(|e| e.to_string())?;
        if out.status.success() {
            return Ok(None);
        }
        let mut why = String::from_utf8_lossy(&out.stderr).trim().to_string();
        if why.is_empty() {
            why = String::from_utf8_lossy(&out.stdout).trim().to_string();
        }
        // 🔴 `return` 을 명시한다. 아래에 윈도우 갈래가 또 있어서, 꼬리
        //    표현식에 기대면 어느 쪽이 반환값인지가 `cfg` 에 따라 달라진다.
        return Err(node_why(&why));
    }
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        // CREATE_NO_WINDOW          0x0800_0000  사장 화면에 검은 창이 안 뜬다
        // CREATE_NEW_PROCESS_GROUP  0x0000_0200  Ctrl+C 가 노드까지 안 간다
        // CREATE_BREAKAWAY_FROM_JOB 0x0100_0000  🔴 이게 핵심이다
        //
        // 🔴 `DETACHED_PROCESS` 만으로는 부족하다(그록 지적). Tauri/WebView2 는
        //    자식들을 **잡 오브젝트**에 묶고, 부모가 끝나면 윈도우가 그 잡을
        //    통째로 죽인다. 떼어 놓지 않으면 앱을 닫는 순간 노드도 같이 죽고,
        //    가게는 밤새 들어온 입금을 못 받는다.
        // 🔴 **설정 파일의 `daemon=1` 을 눌러 끈다.**
        //
        //    우리는 윈도우에서 `-daemon` 을 안 붙인다. 그런데 사장의
        //    `raven.conf` 에 `daemon=1` 이 적혀 있으면 코어가 **거기서 읽어**
        //    데몬이 되려 하고, 윈도우에서는 그 자리에서 죽는다:
        //
        //      ravend.cpp:166  "-daemon is not supported on this operating system"
        //
        //    레이븐 코어를 오래 쓴 사람에게 흔한 설정이다. 실측으로 만났다
        //    (2026-08-26). 명령줄이 설정 파일을 이기므로 여기서 못 박는다.
        cmd.arg("-daemon=0");
        const NO_WINDOW: u32 = 0x0800_0000;
        const NEW_GROUP: u32 = 0x0000_0200;
        const BREAKAWAY: u32 = 0x0100_0000;
        // 🔴 잡이 빠져나가기를 허락하지 않으면(`JOB_OBJECT_LIMIT_BREAKAWAY_OK`
        //    가 없으면) `CreateProcess` 가 **접근 거부로 통째로 실패**한다.
        //    그러면 노드가 아예 안 뜬다 — 고치려던 바로 그 병이 된다.
        //    그래서 한 번 더, 떼어 놓기 없이 시도한다. 앱과 함께 죽더라도
        //    켜지기는 하는 편이, 안 켜지는 것보다 낫다.
        let mut child = match cmd
            .creation_flags(NO_WINDOW | NEW_GROUP | BREAKAWAY)
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .spawn()
        {
            Ok(c) => c,
            Err(_) => cmd
                .creation_flags(NO_WINDOW | NEW_GROUP)
                .spawn()
                .map_err(|e| e.to_string())?,
        };
        // 뜨자마자 죽는 실패(락 충돌·설정 오류)는 1초 안에 끝난다. 그보다
        // 오래 살아 있으면 블록을 읽기 시작한 것이다.
        tokio::time::sleep(std::time::Duration::from_millis(1500)).await;
        match child.try_wait() {
            Ok(Some(_)) => {
                let mut buf = String::new();
                if let Some(mut e) = child.stderr.take() {
                    use std::io::Read;
                    let _ = e.read_to_string(&mut buf);
                }
                return Err(node_why(buf.trim()));
            }
            // 살아 있다. 이 `Child` 가 진짜 노드라 `services_stop` 이 끌 수 있다.
            _ => return Ok(Some(child)),
        }
    }
}

/// 코어가 낸 영어 문장을, 사장이 **할 수 있는 일**이 적힌 문장으로 바꾼다.
///
/// 「Cannot obtain a lock on data directory」를 그대로 보여 주면 사장은 할 수
/// 있는 것이 없다. 이건 사실 가장 흔한 경우고 — 레이븐 코어를 쓰시던 분이
/// 코어를 켜 둔 채 이 앱을 여는 것 — 답도 한 줄이다.
fn node_why(raw: &str) -> String {
    let low = raw.to_lowercase();
    if low.contains("cannot obtain a lock") || low.contains("probably already running") {
        return "레이븐 코어가 이미 켜져 있습니다. 같은 지갑은 한 프로그램만 쓸 수 있습니다. \
                코어를 끄고 다시 눌러 주세요. 돈은 그대로입니다."
            .into();
    }
    if low.contains("-daemon is not supported") {
        // 여기 오면 안 된다 — 윈도우에서는 `-daemon` 을 안 붙이니까. 오면
        // 그건 위의 갈래가 깨진 것이므로, 그렇게 적는다.
        return "이 컴퓨터에서는 노드를 뒤로 돌릴 수 없습니다. 프로그램을 다시 받아 주세요.".into();
    }
    if raw.is_empty() {
        return "노드가 켜지자마자 멈췄습니다. 레이븐 코어가 켜져 있는지 확인해 주세요.".into();
    }
    // 모르는 이유는 지어내지 않는다. 코어가 한 말을 그대로 옮긴다.
    format!("노드가 켜지지 않았습니다: {}", raw.chars().take(200).collect::<String>())
}

fn remember(name: &str, child: Child) {
    if let Ok(mut g) = OURS.lock() {
        g.get_or_insert_with(Vec::new).push((name.to_string(), child));
    }
}

/// Stops only what this app started.
#[tauri::command]
pub fn services_stop() -> Result<Value, String> {
    let mut stopped = Vec::new();
    if let Ok(mut g) = OURS.lock() {
        if let Some(list) = g.as_mut() {
            for (name, child) in list.iter_mut() {
                let _ = child.kill();
                let _ = child.wait();
                stopped.push(name.clone());
            }
            list.clear();
        }
    }
    Ok(json!({ "stopped": stopped }))
}

/// 앱이 끝날 때 **우리가 켠 것만** 끈다.
///
/// ## 노드는 죽이지 않고 「그만」이라고 말한다
///
/// `kill` 은 장부를 쓰던 중이면 상하게 할 수 있고, 그러면 다음에 켤 때
/// 34GB 를 다시 훑는다. 코어에는 `stop` 이라는 정중한 문이 있다 — 쓰던
/// 것을 마저 쓰고 스스로 닫는다. 몇 초 기다려 준다.
///
/// 파일창고는 그냥 끈다. 저장소가 상해도 다음에 켤 때 알아서 고치고,
/// 무엇보다 **거기엔 남의 돈이 없다.**
pub fn stop_on_exit() {
    // 우리가 띄운 노드가 있을 때만 말을 건다. 사장이 따로 켜 둔 코어를
    // 우리가 끄면 안 된다 — 그건 우리 것이 아니다.
    let ours_node = OURS
        .lock()
        .ok()
        .and_then(|g| g.as_ref().map(|v| v.iter().any(|(n, _)| n == "node")))
        .unwrap_or(false);
    if ours_node {
        let _ = tauri::async_runtime::block_on(async {
            let r = crate::raven::call_rpc("stop", json!([])).await;
            // 스스로 닫는 데 몇 초 걸린다. 안 기다리면 앱이 먼저 사라지고
            // 노드는 어정쩡하게 남는다 — 지금 겪고 있는 그 모습이다.
            tokio::time::sleep(std::time::Duration::from_millis(2500)).await;
            r
        });
    }
    let _ = services_stop();
}

/// Everything needed to open the shop, in one press.
///
/// Ordered by dependency: the node first, because IPFS coming up without a node
/// gives a shop that can show pictures and take no money.
#[tauri::command]
pub async fn open_shop() -> Result<Value, String> {
    let svc = services_start().await?;

    // Give the node a moment to open its RPC port before anything asks it a
    // question — the first health check otherwise reports "down" on a node that
    // is fine and starting.
    tokio::time::sleep(std::time::Duration::from_millis(1500)).await;

    let health = crate::health::service_health(false, false).await;
    Ok(json!({ "services": svc, "health": health }))
}

#[cfg(test)]
mod tests {
    use super::node_why;

    /// 🔴 **설치 폴더의 것을 그대로 돌리면 업데이트가 막힌다.**
    ///    윈도우는 돌고 있는 실행 파일을 못 덮어쓰는데, 우리는 앱을 닫아도
    ///    파일창고가 살아 있게 떼어 놨다. 그래서 설치 프로그램이 그 파일에서
    ///    멈추고 「다음 파일을 열 수 없습니다」를 띄웠다 — 실제로 겪었다.
    ///    누가 다시 vendor 경로를 바로 돌리게 바꾸면 그날 또 막힌다.
    #[test]
    fn 같이_넣은_것은_복사해서_돌린다() {
        let src = include_str!("services.rs");
        let i = src.find("fn bundled(").expect("찾는 함수가 있어야 한다");
        let end = src[i..].find("fn runnable_copy").expect("복사 함수가 있어야 한다");
        let body = &src[i..i + end];
        assert!(
            body.contains("runnable_copy"),
            "설치 폴더의 것을 그대로 돌리고 있다 — 다음 판을 설치할 수 없게 된다"
        );
    }


    /// 🔴 윈도우에서 노드가 안 뜨던 두 이유를 못 박는다. 둘 다 실측으로
    ///    만났고, 둘 다 **오류 없이 조용히 실패**한다.
    #[test]
    fn 윈도우는_데몬을_눌러_끄고_창을_안_띄운다() {
        let src = include_str!("services.rs");
        let i = src.find("fn spawn_node_inner").expect("띄우는 함수가 있어야 한다");
        let body = &src[i..];
        // 설정 파일에 daemon=1 이 있으면 코어가 거기서 읽어 데몬이 되려 하고,
        // 윈도우에서는 그 자리에서 죽는다. 명령줄로 눌러 끈다.
        assert!(
            body.contains(&format!("\"-daemon{}0\"", "=")),
            "설정 파일의 daemon=1 을 안 누르면 윈도우에서 노드가 죽는다"
        );
        // 잡에서 안 빠져나오면 앱을 닫을 때 노드도 같이 죽는다.
        assert!(body.contains("BREAKAWAY"), "잡에서 빠져나와야 밤새 산다");
    }

    /// 🔴 사장이 읽는 문장이다. 여기가 틀리면 코어를 켜 둔 사장이 「노드가
    ///    켜지는 중」을 몇 시간 기다린다. 실제로 그랬다.
    #[test]
    fn 락_충돌은_끄라고_말한다() {
        // 레이븐코어 원본 문장(init.cpp). 문자열을 그대로 적지 않고 조립한다 —
        // 테스트가 제 소스를 읽고 통과하는 일이 이 저장소에서 세 번 있었다.
        let core = format!(
            "Error: {} on data directory /x. Ravencoin Core is probably already running.",
            "Cannot obtain a lock"
        );
        let said = node_why(&core);
        assert!(said.contains("레이븐 코어가 이미 켜져 있습니다"), "실제: {said}");
        assert!(said.contains("돈은 그대로입니다"), "무서우면 앱을 닫는다");
        // 사장이 할 수 있는 일이 아닌 말은 안 나와야 한다.
        assert!(!said.contains("lock"), "영어 원문을 그대로 보이면 안 된다");
        assert!(!said.contains("datadir"));
    }

    #[test]
    fn 조용히_죽은_경우도_말을_한다() {
        let said = node_why("");
        assert!(!said.is_empty());
        assert!(said.contains("코어"), "무엇을 확인할지 알려야 한다: {said}");
    }

    #[test]
    fn 모르는_이유는_지어내지_않는다() {
        let said = node_why("Error: Prune mode is incompatible with -txindex.");
        assert!(said.contains("Prune mode"), "코어가 한 말을 옮겨야 한다: {said}");
    }


    /// 🔴 옛 줄을 읽으면 **지난주 충돌을 오늘 일로** 착각한다. 그래서
    ///    「띄우기 전 길이 뒤에 붙은 것만」 읽는 설계가 맞는지 확인한다.
    #[test]
    fn 지난번_락은_오늘_일이_아니다() {
        let dir = std::env::temp_dir().join(format!("pxr-log-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        let log = dir.join("debug.log");
        // 지난주에 락 충돌이 한 번 있었다.
        let old = format!("2026-08-01 Error: {} on data directory /x.\n", "Cannot obtain a lock");
        std::fs::write(&log, &old).unwrap();
        let before = std::fs::metadata(&log).unwrap().len();
        // 오늘은 정상으로 떴다.
        std::fs::write(&log, format!("{old}2026-08-25 Raven server starting\n")).unwrap();

        let added = super::tail_since(&log, before).expect("붙은 부분을 읽어야 한다");
        assert!(super::lock_line(&added).is_none(), "옛 줄을 오늘 일로 읽었다: {added}");
        // 반대로, 전체를 읽었다면 잘못 걸렸을 것이다 — 그게 이 설계의 이유다.
        let whole = super::tail_since(&log, 0).unwrap();
        assert!(super::lock_line(&whole).is_some(), "전체를 읽으면 걸린다(그래서 안 읽는다)");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn 이번에_난_락은_잡는다() {
        let dir = std::env::temp_dir().join(format!("pxr-log2-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        let log = dir.join("debug.log");
        std::fs::write(&log, "2026-08-25 Raven server starting\n").unwrap();
        let before = std::fs::metadata(&log).unwrap().len();
        let line = format!("Error: {} on data directory /x. Ravencoin Core is probably already running.", "Cannot obtain a lock");
        std::fs::write(&log, format!("2026-08-25 Raven server starting\n{line}\n")).unwrap();

        let added = super::tail_since(&log, before).unwrap();
        let why = super::lock_line(&added).expect("이번 충돌은 잡아야 한다");
        assert!(why.contains("코어를 끄고"), "실제: {why}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 로그가 아예 없는 컴퓨터(첫 실행)에서 터지면 안 된다.
    #[test]
    fn 로그가_없어도_안_터진다() {
        let none = std::path::Path::new("/이런/파일은/없다/debug.log");
        assert!(super::tail_since(none, 0).is_none());
    }

    /// 아주 긴 오류가 화면을 밀어내지 않게. 200자에서 끊는다.
    #[test]
    fn 아주_긴_오류는_끊는다() {
        let said = node_why(&"E".repeat(5000));
        assert!(said.chars().count() < 260, "실제 길이: {}", said.chars().count());
    }
}
