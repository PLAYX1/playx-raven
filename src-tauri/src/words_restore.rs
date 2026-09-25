//! 복구 단어(12단어)로 지갑 되살리기 — 0.4.9. 설계서 `docs/RV4-desktop-restore-design.md` 의 A안.
//!
//! ## 한 줄로
//!
//! 노드를 멈추고 → 지금 `wallet.dat` 을 **지우지 않고 옆에 두고**(이름만 바꿈) → 코어가
//! `-mnemonic` 으로 새 지갑을 **한 번만** 만들게 하고 → 첫 주소가 정말 그 단어의 것인지 묻고
//! → 노드를 보통대로 다시 켜서(이제 노드는 단어를 모른다) → `rescanblockchain` 으로 옛 거래를 찾는다.
//!
//! ## 🔴 함정 셋 (전부 코어 소스·격리 노드로 확인 — scripts/check-restore-vectors.mjs)
//!
//! 1. **시작 옵션 `-rescan` 은 옛 거래를 못 찾는다.** 새 지갑의 생일이 「지금」이라 생일 −2시간보다
//!    오래된 블록을 건너뛴다(wallet.cpp 4867). regtest 실측: `-rescan` 0건 → `rescanblockchain` 110건.
//!    그래서 재검사는 **RPC `rescanblockchain`** 으로만 한다. 이 파일에 시작 옵션 `-rescan` 은 없다.
//! 2. **틀린 단어를 받은 코어는 단어 전체를 `debug.log` 에 적는다**(walletdb.cpp 1039). 실측으로
//!    재현했다. 그래서 `words::check`(코어와 같은 규칙)를 통과한 단어만 노드에 건넨다.
//! 3. **노드를 켜는 길이 여럿이다**(켤 때 `boot::run` · 「지금 켜기」 · 맥 launchd `KeepAlive`).
//!    지갑 자리가 비어 있을 때 누가 먼저 켜면 무작위 새 지갑이 생기고 `-mnemonic` 은 조용히
//!    무시된다. 그래서 상태 파일(`words-restore.json`, **단어 없음**)이 그 동안 모든 「켜기」를
//!    막고(`node_start_hold`), launchd 는 잠시 내린다(`reindex_run::agent_hold`).
//!
//! ## 🔴 단어가 지나가는 곳 — 어디에도 남기지 않는다(설계서 5절 표)
//!
//! * 명령줄: `-conf=<통로>` 만. 단어는 argv 에 없다 → `ps`·작업관리자·EDR 기록에 안 남는다.
//! * 통로: 유닉스는 0700 폴더 안 0600 **FIFO**, 윈도우는 현재 사용자만 여는 **이름 있는 파이프**.
//!   디스크에 내용이 안 쓰인다. 코어는 시작 맨 앞(데몬 분기 전)에 설정을 한 번 읽는다(ravend.cpp 107).
//!   `raven.conf`·`.conf.bak` 은 건드리지 않는다(통로 내용 = 단어 줄 + 지금 raven.conf 사본).
//! * 노드 메모리: 지갑이 만들어져 확인되면 곧바로 끄고 보통대로 다시 켠다.
//! * 오류: 이 파일의 모든 `Err` 는 **고정 문장**이다. 입력을 `format!` 하지 않는다(시험이 지킨다).
//!   노드 stderr 는 읽지 않는다(`Stdio::null`).
//! * 상태 파일: 단계·옆에 둔 파일 이름·첫 주소(공개값)만.
//! * 로그: `node_log_tail` 은 되살리기 도중·직후 기록을 보이지 않고, `mnemonic` 이 든 줄은 언제나 가린다.
//! * 러스트 메모리: `words::Phrase`·`Secret` 은 떨어질 때 스스로 0 으로 덮는다.
//!
//! 막을 수 없는 것도 적는다: 되살린 직후의 `wallet.dat` 은 단어를 **평문**으로 담는다(코어 F9 —
//! 이 앱에서 새로 생기는 모든 코어 지갑이 같다). 그래서 끝 화면이 지갑 암호를 강하게 권한다.

use crate::words::{self, Phrase};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

/// 지금 지갑에 돈·거래·자산이 있을 때 사람이 그대로 치는 문장(설계서 4.2).
pub const PHRASE_ASIDE: &str = "지금 지갑을 옆에 둡니다";
/// 옛 거래를 찾는 동안 노드에 묻는 모든 질문이 받는 답(raven.rs).
pub const RESCANNING_SAY: &str =
    "지갑을 되살리는 중입니다 — 옛 거래를 찾고 있습니다. 끝나면 다시 입금을 확인합니다.";
const HOLD_SAY: &str = "지갑을 되살리는 중이라 노드를 켜지 않았습니다. 「이 컴퓨터 › 백업 › 복구 단어로 되살리기」에서 이어 하거나 옛 지갑으로 되돌려 주세요.";
/// 윈도우에서 노드가 파이프를 안 읽었다 — 화면이 「임시 파일로 건네기」를 따로 묻는다.
pub const PIPE_UNREAD: &str = "PIPE_UNREAD: 이 컴퓨터에서는 디스크에 흔적 없이 단어를 건네지 못했습니다. 지금 지갑과 단어는 그대로입니다.";
const MASKED_LINE: &str = "(복구 단어가 들어 있을 수 있는 줄이라 가렸습니다)";
const STATE_FILE: &str = "words-restore.json";

/// 이 프로그램 안에서 되살리기 흐름이 도는 중(한 번에 하나).
static BUSY: AtomicBool = AtomicBool::new(false);
/// `rescanblockchain` 이 지금 도는 중. raven.rs 가 보고 질문을 쉰다.
static RESCAN: AtomicBool = AtomicBool::new(false);

pub fn rescanning() -> bool {
    RESCAN.load(Ordering::Acquire)
}

/// 떨어질 때 스스로 지우는 비밀 글자(추가 암호). `Debug`·`Clone` 없음.
pub struct Secret(String);
impl Secret {
    fn new(s: String) -> Self {
        Secret(s)
    }
    fn expose(&self) -> &str {
        &self.0
    }
}
impl Drop for Secret {
    fn drop(&mut self) {
        words::wipe(&mut self.0);
    }
}

// ── 상태 파일 (단어 없음) ────────────────────────────────────────────────

#[derive(Serialize, Deserialize, Default, Clone, Debug)]
pub(crate) struct State {
    pub v: u32,
    /// stopping · set_aside · creating · created · restarting · rescan_wait · rescanning ·
    /// rescan_stopped · reindexing · done · undoing · undone · closed
    pub stage: String,
    /// 옆에 둔 옛 지갑 파일 이름(노드 폴더 안). 경로가 아니라 이름만.
    pub aside: Option<String>,
    /// 옆에 둔 빈 지갑들(단어가 안 먹어 생긴 것 등).
    #[serde(default)]
    pub empties: Vec<String>,
    /// 되살린 지갑의 첫 받기 주소 — 공개값.
    pub first: Option<String>,
    /// new · full · prune
    pub branch: String,
    /// now · after_close
    pub rescan: String,
    #[serde(default)]
    pub held_agent: bool,
    #[serde(default)]
    pub log_from: u64,
    #[serde(default)]
    pub tip: u64,
    pub started: u64,
    pub updated: u64,
    #[serde(default)]
    pub result: Option<Value>,
    /// 고정 문장만.
    #[serde(default)]
    pub why: Option<String>,
}

fn now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// `20260925-143012` (UTC). 옆에 둔 파일 이름에 붙인다.
fn stamp() -> String {
    let t = now() as i64;
    let ymd = crate::ledger::local_ymd(t, 0);
    let s = t.rem_euclid(86_400);
    format!("{ymd}-{:02}{:02}{:02}", s / 3600, (s / 60) % 60, s % 60)
}

fn state_path(app_dir: &Path) -> PathBuf {
    app_dir.join(STATE_FILE)
}

pub(crate) fn read_state(app_dir: &Path) -> Option<State> {
    let txt = std::fs::read_to_string(state_path(app_dir)).ok()?;
    let st: State = serde_json::from_str(&txt).ok()?;
    // 옆에 둔 이름은 **우리가 만든 모양**일 때만 믿는다. 누가 상태 파일에
    // `../../` 를 적어 넣어도 노드 폴더 밖 파일을 옮기지 않는다.
    if st.aside.as_deref().is_some_and(|a| !safe_name(a)) {
        return None;
    }
    Some(st)
}

fn safe_name(name: &str) -> bool {
    name.starts_with("wallet.dat.")
        && name.len() < 80
        && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-')
}

fn write_state(app_dir: &Path, st: &State) -> Result<(), String> {
    std::fs::create_dir_all(app_dir).map_err(|_| "상태를 적을 폴더를 만들지 못했습니다.".to_string())?;
    let mut st = st.clone();
    st.v = 1;
    st.updated = now();
    let tmp = app_dir.join(format!("{STATE_FILE}.tmp-{}", std::process::id()));
    let body = serde_json::to_vec_pretty(&st).map_err(|_| "상태를 적지 못했습니다.".to_string())?;
    std::fs::write(&tmp, body).map_err(|_| "상태를 적지 못했습니다. 저장 공간을 확인해 주세요.".to_string())?;
    std::fs::rename(&tmp, state_path(app_dir)).map_err(|_| "상태를 적지 못했습니다.".to_string())
}

fn app_state() -> Option<State> {
    read_state(&crate::paths::app_dir())
}

/// 노드를 켜면 안 되는 단계. 지갑 자리가 비어 있거나(옆에 둠) 단어로 만드는 중이다.
fn blocking_stage(stage: &str) -> bool {
    matches!(stage, "set_aside" | "creating" | "undoing")
}

/// 🔴 노드를 켜는 모든 길(services::start_parts · reindex_run)이 먼저 묻는다.
/// `Some(이유)` 면 켜지 않는다.
pub fn node_start_hold() -> Option<String> {
    if rescanning() {
        return Some(RESCANNING_SAY.into());
    }
    let st = app_state()?;
    if blocking_stage(&st.stage) || (st.stage == "stopping" && BUSY.load(Ordering::Acquire)) {
        return Some(HOLD_SAY.into());
    }
    None
}

/// 백업 파일 되돌리기(recover.rs)가 끼어들면 안 되는 때.
pub fn file_restore_blocked() -> bool {
    BUSY.load(Ordering::Acquire)
        || rescanning()
        || app_state().is_some_and(|s| blocking_stage(&s.stage) || s.stage == "creating")
}

/// 노드 기록을 **아예** 보이지 않을 때 — 되살리기가 시작돼 사람이 「닫기」를 누르기 전까지.
pub fn log_hidden() -> bool {
    BUSY.load(Ordering::Acquire)
        || app_state().is_some_and(|s| !matches!(s.stage.as_str(), "closed" | "undone" | ""))
}

/// `mnemonic` 이 든 줄은 언제나 가린다(설계서 F7 — 틀린 단어를 받은 코어가 적는 줄).
pub fn mask_line(line: &str) -> String {
    if line.to_ascii_lowercase().contains("mnemonic") {
        MASKED_LINE.to_string()
    } else {
        line.to_string()
    }
}

/// 노드 오류 문장(`services::node_why`)에 단어가 섞일 수 있으면 통째로 바꾼다.
pub fn masks_node_error(raw: &str) -> bool {
    raw.to_ascii_lowercase().contains("mnemonic")
}

// ── 노드에 말 걸기 ─────────────────────────────────────────────────────

/// 어느 노드에 무엇으로 붙나. 앱은 `Ctx::app()`, 시험은 격리 노드(`direct`).
pub(crate) struct Ctx {
    pub datadir: PathBuf,
    pub app_dir: PathBuf,
    pub ravend: Option<PathBuf>,
    pub direct: Option<Direct>,
    /// 시험용 격리 인자(포트·네트워크 끔). 앱은 비어 있다.
    pub extra: Vec<String>,
}

pub(crate) struct Direct {
    pub port: u16,
    pub cookie: PathBuf,
}

impl Ctx {
    fn app() -> Ctx {
        Ctx {
            datadir: crate::paths::raven_dir(),
            app_dir: crate::paths::app_dir(),
            ravend: crate::services::which("ravend").map(PathBuf::from),
            direct: None,
            extra: Vec::new(),
        }
    }
    fn is_app(&self) -> bool {
        self.direct.is_none()
    }
}

async fn direct_call(d: &Direct, method: &str, params: Value, secs: u64) -> Result<Value, String> {
    let cookie = std::fs::read_to_string(&d.cookie).map_err(|_| "노드에 닿지 못했습니다.".to_string())?;
    let (user, pass) = cookie.trim().split_once(':').ok_or("노드에 닿지 못했습니다.")?;
    let r = reqwest::Client::new()
        .post(format!("http://127.0.0.1:{}", d.port))
        .basic_auth(user, Some(pass))
        .timeout(Duration::from_secs(secs))
        .json(&json!({ "jsonrpc": "1.0", "id": "words", "method": method, "params": params }))
        .send()
        .await
        .map_err(|_| "노드에 닿지 못했습니다.".to_string())?;
    let v: Value = r.json().await.map_err(|_| "노드와의 연결이 끊겼습니다.".to_string())?;
    if let Some(e) = v.get("error").filter(|e| !e.is_null()) {
        return Err(format!("{method}: {}", e.get("message").and_then(Value::as_str).unwrap_or("error")));
    }
    Ok(v.get("result").cloned().unwrap_or(Value::Null))
}

async fn rpc(ctx: &Ctx, method: &str, params: Value) -> Result<Value, String> {
    match &ctx.direct {
        None => crate::raven::call_rpc(method, params).await,
        Some(d) => direct_call(d, method, params, 30).await,
    }
}

async fn rpc_long(ctx: &Ctx, method: &str, params: Value, secs: u64) -> Result<Value, String> {
    match &ctx.direct {
        None => crate::raven::call_rpc_long(method, params, secs).await,
        Some(d) => direct_call(d, method, params, secs).await,
    }
}

fn log_len(ctx: &Ctx) -> u64 {
    std::fs::metadata(ctx.datadir.join("debug.log")).map(|m| m.len()).unwrap_or(0)
}

/// `debug.log` 에서 `from` 뒤에 붙은 것(최대 256KB).
fn log_since(ctx: &Ctx, from: u64) -> String {
    use std::io::{Read, Seek, SeekFrom};
    let Ok(mut f) = std::fs::File::open(ctx.datadir.join("debug.log")) else {
        return String::new();
    };
    let len = f.metadata().map(|m| m.len()).unwrap_or(0);
    let start = if len > from + 256 * 1024 { len - 256 * 1024 } else { from.min(len) };
    if f.seek(SeekFrom::Start(start)).is_err() {
        return String::new();
    }
    let mut buf = Vec::new();
    let _ = f.take(256 * 1024).read_to_end(&mut buf);
    String::from_utf8_lossy(&buf).to_string()
}

/// 노드가 지갑까지 열어 답할 때까지 기다린다. 죽었으면 일찍 알린다.
async fn wait_ready(ctx: &Ctx, from: u64, mut child: Option<&mut std::process::Child>, secs: u64) -> Result<(), String> {
    let t0 = std::time::Instant::now();
    while t0.elapsed() < Duration::from_secs(secs) {
        if rpc(ctx, "getwalletinfo", json!([])).await.is_ok() {
            return Ok(());
        }
        if let Some(c) = child.as_deref_mut() {
            if let Ok(Some(_)) = c.try_wait() {
                return Err("노드가 켜지자마자 멈췄습니다. 옛 지갑은 옆에 그대로 있습니다.".into());
            }
        }
        let added = log_since(ctx, from);
        if added.contains("Shutdown: done") {
            if added.to_ascii_lowercase().contains("cannot obtain a lock") {
                return Err("다른 프로그램(레이븐 코어 등)이 노드 폴더를 쓰고 있습니다. 그 프로그램을 끄고 이어 해 주세요. 옛 지갑은 옆에 그대로 있습니다.".into());
            }
            return Err("노드가 켜지다가 멈췄습니다. 옛 지갑은 옆에 그대로 있습니다.".into());
        }
        tokio::time::sleep(Duration::from_millis(1000)).await;
    }
    Err("노드가 오래 답하지 않습니다. 옛 지갑은 옆에 그대로 있습니다.".into())
}

/// 노드에 「그만」이라 하고, **정말 꺼질 때까지**(`.lock` 이 풀릴 때까지) 기다린다.
/// 깨끗이 꺼졌는지(`database/` 기록이 정리됐는지)도 본다 — 설계서 4.1.
async fn stop_and_wait(ctx: &Ctx) -> Result<(), String> {
    let _ = rpc(ctx, "stop", json!([])).await;
    for _ in 0..300 {
        tokio::time::sleep(Duration::from_secs(1)).await;
        let answering = rpc(ctx, "getblockcount", json!([])).await.is_ok();
        if !answering && crate::recover::datadir_free(&ctx.datadir) {
            return if unclean(&ctx.datadir) {
                Err("노드가 깨끗이 꺼지지 않았습니다. 노드를 한 번 켰다가 끈 뒤 다시 해 주세요. 지금 지갑은 그대로입니다.".into())
            } else {
                Ok(())
            };
        }
    }
    Err("노드가 5분 안에 꺼지지 않았습니다. 지금 지갑은 그대로입니다.".into())
}

/// 코어는 깨끗이 끝나면 지갑 DB 의 `database/` 기록을 지운다(wallet/db.cpp 629–632).
/// 남아 있으면 비정상 종료 뒤라, 그 기록이 옛 파일을 가리킬 수 있다.
fn unclean(datadir: &Path) -> bool {
    std::fs::read_dir(datadir.join("database"))
        .map(|rd| rd.flatten().any(|e| e.file_name().to_string_lossy().starts_with("log.")))
        .unwrap_or(false)
}

/// 덮어쓰지 않는 이름 바꾸기. 도착 자리에 무엇이든 있으면 **멈춘다.**
fn move_no_clobber(from: &Path, to: &Path) -> Result<(), String> {
    if std::fs::symlink_metadata(to).is_ok() {
        return Err("옆에 둘 자리에 이미 파일이 있습니다. 아무것도 바꾸지 않았습니다.".into());
    }
    match std::fs::hard_link(from, to) {
        Ok(()) => std::fs::remove_file(from).map_err(|_| "지갑 파일 이름을 바꾸지 못했습니다.".to_string()),
        // 하드 링크를 못 거는 디스크(FAT 등) — 위에서 자리가 빈 것을 봤고 .lock 을 쥐고 있다.
        Err(_) => std::fs::rename(from, to).map_err(|_| "지갑 파일 이름을 바꾸지 못했습니다.".to_string()),
    }
}

/// `datadir/wallet.dat` 을 `wallet.dat.<꼬리>-<시각>` 로 옆에 둔다. 노드 잠금을 쥔 채로.
fn set_aside(ctx: &Ctx, tail: &str) -> Result<Option<String>, String> {
    crate::recover::with_datadir_locked(&ctx.app_dir, &ctx.datadir, |dir| {
        let cur = dir.join("wallet.dat");
        if std::fs::symlink_metadata(&cur).is_err() {
            return Ok(None);
        }
        let mut name = format!("wallet.dat.{tail}-{}", stamp());
        let mut n = 1;
        while std::fs::symlink_metadata(dir.join(&name)).is_ok() {
            n += 1;
            name = format!("wallet.dat.{tail}-{}-{n}", stamp());
        }
        move_no_clobber(&cur, &dir.join(&name))?;
        Ok(Some(name))
    })
}

// ── 단어를 노드에 건네는 통로 ───────────────────────────────────────────

/// 🔴 추가 암호는 설정 통로로 건네므로 설정 파일 문법에 걸리면 안 된다(설계서 F17):
/// `#` 부터는 주석, 값 앞뒤 빈칸은 잘린다. 그런 암호는 **명령줄로 돌리지 않고** 멈춘다.
pub fn passphrase_fits(p: &str) -> bool {
    !p.contains(['#', '\n', '\r', '\0']) && p.trim() == p
}

/// 통로에 흘릴 설정 글자. **단어 줄이 맨 위**다 — 코어는 먼저 나온 값을 쓴다(util.cpp 648).
/// 지금 raven.conf 의 나머지 줄(rpc·prune·색인 등)은 그대로 이어 붙인다 — `-conf` 를 주면
/// 코어가 raven.conf 를 따로 읽지 않기 때문이다.
fn channel_body(ctx: &Ctx, phrase: &Phrase, pass: &Secret) -> String {
    let base = std::fs::read_to_string(ctx.datadir.join("raven.conf")).unwrap_or_default();
    let mut body = String::with_capacity(base.len() + 512);
    body.push_str("mnemonic=");
    body.push_str(phrase.expose());
    body.push('\n');
    if !pass.expose().is_empty() {
        body.push_str("mnemonicpassphrase=");
        body.push_str(pass.expose());
        body.push('\n');
    }
    body.push_str("bip44=1\n");
    for line in base.lines() {
        let key = line.trim().split('=').next().unwrap_or("").trim().to_ascii_lowercase();
        // 옛 줄이 우리 값을 가리지 않게. `daemon` 은 명령줄이 정한다. `wallet`·`rescan` 은 이 흐름과 맞지 않는다.
        if matches!(key.as_str(), "mnemonic" | "mnemonicpassphrase" | "bip44" | "daemon" | "wallet" | "rescan") {
            continue;
        }
        body.push_str(line);
        body.push('\n');
    }
    body
}

/// 만들기 한 번에 쓰는 명령줄. 🔴 단어가 없다 — 통로 경로만.
fn creation_args(ctx: &Ctx, conf: &str) -> Vec<String> {
    let mut a = vec![
        format!("-datadir={}", ctx.datadir.to_string_lossy()),
        format!("-conf={conf}"),
        "-server=1".to_string(),
        // 단어를 쥔 몇 분 동안은 밖과 잇지 않는다. 지갑을 만들고 확인만 하고 끈다.
        "-listen=0".to_string(),
        "-connect=0".to_string(),
        "-upnp=0".to_string(),
    ];
    a.extend(ctx.extra.iter().cloned());
    a
}

fn pipe_dir(ctx: &Ctx) -> PathBuf {
    ctx.app_dir.join("words-pipe")
}

/// 통로 폴더를 늘 지운다(끝나거나 실패하거나).
struct PipeDir(PathBuf);
impl Drop for PipeDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn make_pipe_dir(ctx: &Ctx) -> Result<PipeDir, String> {
    let dir = pipe_dir(ctx);
    let _ = std::fs::remove_dir_all(&dir);
    #[cfg_attr(not(unix), allow(unused_mut))]
    let mut b = std::fs::DirBuilder::new();
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        b.mode(0o700);
    }
    b.create(&dir).map_err(|_| "단어를 건넬 통로를 만들지 못했습니다.".to_string())?;
    Ok(PipeDir(dir))
}

/// 노드를 단어와 함께 **한 번** 띄운다. 돌려주는 `Child` 는 윈도우에서만 있다.
#[cfg(unix)]
async fn spawn_with_words(ctx: &Ctx, phrase: &Phrase, pass: &Secret, file: bool) -> Result<Option<std::process::Child>, String> {
    use std::ffi::CString;
    use std::os::unix::ffi::OsStrExt;
    use std::os::unix::fs::{FileTypeExt, PermissionsExt};
    let ravend = ctx.ravend.clone().ok_or("노드 프로그램(ravend)을 찾지 못했습니다.")?;
    let dir = make_pipe_dir(ctx)?;
    let conf = dir.0.join(format!("c-{:016x}.conf", rand::random::<u64>()));
    let mut body = channel_body(ctx, phrase, pass);
    if file {
        // A-2(사람이 따로 고른 때만): 0600 파일에 쓰고, 노드가 읽은 뒤 0 으로 덮고 지운다.
        use std::io::Write;
        use std::os::unix::fs::OpenOptionsExt;
        let mut f = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&conf)
            .map_err(|_| "단어를 건넬 통로를 만들지 못했습니다.".to_string())?;
        let w = f.write_all(body.as_bytes()).and_then(|_| f.sync_all());
        words::wipe(&mut body);
        w.map_err(|_| "단어를 건넬 통로를 만들지 못했습니다.".to_string())?;
    } else {
        let c = CString::new(conf.as_os_str().as_bytes()).map_err(|_| "통로 경로가 올바르지 않습니다.".to_string())?;
        if unsafe { libc::mkfifo(c.as_ptr(), 0o600) } != 0 {
            words::wipe(&mut body);
            return Err("단어를 건넬 통로를 만들지 못했습니다.".into());
        }
        let meta = std::fs::symlink_metadata(&conf).map_err(|_| "통로를 확인하지 못했습니다.".to_string())?;
        if !meta.file_type().is_fifo() || meta.permissions().mode() & 0o077 != 0 {
            words::wipe(&mut body);
            return Err("통로가 이 사용자 전용이 아닙니다. 멈췄습니다.".into());
        }
    }
    let mut cmd = std::process::Command::new(&ravend);
    cmd.args(creation_args(ctx, &conf.to_string_lossy()))
        .arg("-daemon")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        // 🔴 stderr 를 읽지 않는다 — 틀린 단어였다면 코어가 거기에 단어를 적는다.
        .stderr(std::process::Stdio::null());
    let mut child = cmd.spawn().map_err(|_| {
        "노드를 띄우지 못했습니다. 옛 지갑은 옆에 그대로 있습니다.".to_string()
    })?;
    if !file {
        // FIFO 에 쓴다: 노드가 읽으러 열 때까지 막히지 않게 O_NONBLOCK 으로 두드리다가,
        // 열리면 보통 쓰기로 바꿔 끝까지 쓰고 닫는다(닫으면 노드가 파일 끝을 본다).
        let path = conf.clone();
        let mut owned = std::mem::take(&mut body);
        let pid = child.id();
        let wrote = tokio::task::spawn_blocking(move || {
            let out = write_fifo(&path, owned.as_bytes(), pid);
            words::wipe(&mut owned);
            out
        })
        .await
        .unwrap_or(false);
        if !wrote {
            let _ = child.kill();
            let _ = child.wait();
            return Err("노드가 단어 통로를 열지 않았습니다. 옛 지갑은 옆에 그대로 있습니다.".into());
        }
    }
    words::wipe(&mut body);
    // `-daemon` 부모는 설정을 읽고 갈라진 뒤 곧 끝난다(ravend.cpp 107 → 148).
    let t0 = std::time::Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(s)) => break Some(s),
            Ok(None) if t0.elapsed() < Duration::from_secs(180) => tokio::time::sleep(Duration::from_millis(200)).await,
            _ => break None,
        }
    };
    if file {
        // 부모가 끝났으면 이미 읽었다. 0 으로 덮고 지운다(SSD 는 덮어쓴다는 보장이 없다 — 설계서 5.2).
        scrub_file(&conf);
    }
    drop(dir);
    match status {
        Some(s) if s.success() => Ok(None),
        _ => Err("노드가 켜지지 않았습니다. 옛 지갑은 옆에 그대로 있습니다.".into()),
    }
}

#[cfg(unix)]
fn write_fifo(path: &Path, bytes: &[u8], _pid: u32) -> bool {
    use std::ffi::CString;
    use std::io::Write;
    use std::os::unix::ffi::OsStrExt;
    use std::os::unix::io::FromRawFd;
    let Ok(c) = CString::new(path.as_os_str().as_bytes()) else { return false };
    let t0 = std::time::Instant::now();
    loop {
        let fd = unsafe { libc::open(c.as_ptr(), libc::O_WRONLY | libc::O_NONBLOCK | libc::O_CLOEXEC) };
        if fd >= 0 {
            unsafe {
                let fl = libc::fcntl(fd, libc::F_GETFL);
                libc::fcntl(fd, libc::F_SETFL, fl & !libc::O_NONBLOCK);
            }
            let mut f = unsafe { std::fs::File::from_raw_fd(fd) };
            let ok = f.write_all(bytes).is_ok();
            drop(f);
            return ok;
        }
        // ENXIO = 아직 아무도 읽으러 안 열었다.
        if t0.elapsed() > Duration::from_secs(90) {
            return false;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
}

fn scrub_file(path: &Path) {
    if let Ok(meta) = std::fs::metadata(path) {
        let _ = std::fs::write(path, vec![0u8; meta.len() as usize]);
    }
    let _ = std::fs::remove_file(path);
}

#[cfg(windows)]
async fn spawn_with_words(ctx: &Ctx, phrase: &Phrase, pass: &Secret, file: bool) -> Result<Option<std::process::Child>, String> {
    use std::os::windows::process::CommandExt;
    let ravend = ctx.ravend.clone().ok_or("노드 프로그램(ravend)을 찾지 못했습니다.")?;
    const NO_WINDOW: u32 = 0x0800_0000;
    let mut body = channel_body(ctx, phrase, pass);
    if file {
        // A-2 — 사람이 「임시 파일로 건네기」를 따로 고른 때만 온다.
        let dir = make_pipe_dir(ctx)?;
        let conf = dir.0.join(format!("c-{:016x}.conf", rand::random::<u64>()));
        let w = std::fs::write(&conf, body.as_bytes());
        words::wipe(&mut body);
        w.map_err(|_| "단어를 건넬 통로를 만들지 못했습니다.".to_string())?;
        let child = std::process::Command::new(&ravend)
            .args(creation_args(ctx, &conf.to_string_lossy()))
            .arg("-daemon=0")
            .creation_flags(NO_WINDOW)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn();
        let mut child = match child {
            Ok(c) => c,
            Err(_) => {
                scrub_file(&conf);
                return Err("노드를 띄우지 못했습니다. 옛 지갑은 옆에 그대로 있습니다.".into());
            }
        };
        // 윈도우는 「읽었다」를 알려 주는 부모 종료가 없다 — RPC 가 답하면 설정은 이미 읽었다.
        let from = log_len(ctx);
        let ready = wait_ready(ctx, from, Some(&mut child), 900).await;
        scrub_file(&conf);
        drop(dir);
        ready?;
        return Ok(Some(child));
    }
    let name = format!(r"\\.\pipe\ravenvault-{:016x}", rand::random::<u64>());
    let server = win_pipe::Server::create(&name).map_err(|_| {
        words::wipe(&mut body);
        "단어를 건넬 통로를 만들지 못했습니다.".to_string()
    })?;
    let writer = server.serve(std::mem::take(&mut body));
    words::wipe(&mut body);
    let child = std::process::Command::new(&ravend)
        .args(creation_args(ctx, &name))
        .arg("-daemon=0")
        .creation_flags(NO_WINDOW)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        // 🔴 stderr 를 읽지 않는다(services::node_why 가 앞 200자를 화면 오류로 만들던 길 — 설계서 부록 A 3).
        .stderr(std::process::Stdio::null())
        .spawn();
    let mut child = match child {
        Ok(c) => c,
        Err(_) => {
            writer.cancel(&name);
            return Err("노드를 띄우지 못했습니다. 옛 지갑은 옆에 그대로 있습니다.".into());
        }
    };
    // 노드가 파이프를 읽었나 — 최대 90초. 【윈도우 미실측】 mingw 빌드 ravend 의
    // `fs::ifstream` 이 `\\.\pipe\…` 를 여는지 이 저장소에서는 재 보지 못했다.
    let t0 = std::time::Instant::now();
    loop {
        if writer.delivered() {
            break;
        }
        let dead = matches!(child.try_wait(), Ok(Some(_)));
        if dead || t0.elapsed() > Duration::from_secs(90) {
            writer.cancel(&name);
            let _ = child.kill();
            let _ = child.wait();
            // 노드가 파이프 없이 떴다면 무작위 새 지갑을 만들었을 수 있다 — 거래 0건이 확실하다
            // (방금 생겼다). 부르는 쪽이 `empty-words` 로 옆에 둔다.
            return Err(PIPE_UNREAD.into());
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
    writer.join();
    Ok(Some(child))
}

/// 윈도우 이름 있는 파이프 — **현재 사용자만**(보호 DACL `OW`), 원격 거부, 한 번만.
#[cfg(windows)]
mod win_pipe {
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;
    use windows_sys::Win32::Foundation::{CloseHandle, GetLastError, LocalFree, ERROR_PIPE_CONNECTED, GENERIC_READ, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::Security::Authorization::{ConvertStringSecurityDescriptorToSecurityDescriptorW, SDDL_REVISION_1};
    use windows_sys::Win32::Security::{PSECURITY_DESCRIPTOR, SECURITY_ATTRIBUTES};
    use windows_sys::Win32::Storage::FileSystem::{CreateFileW, FlushFileBuffers, WriteFile, FILE_FLAG_FIRST_PIPE_INSTANCE, OPEN_EXISTING, PIPE_ACCESS_OUTBOUND};
    use windows_sys::Win32::System::Pipes::{ConnectNamedPipe, CreateNamedPipeW, DisconnectNamedPipe, PIPE_REJECT_REMOTE_CLIENTS, PIPE_TYPE_BYTE, PIPE_WAIT};

    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(std::iter::once(0)).collect()
    }

    pub struct Server {
        handle: usize,
    }
    pub struct Writer {
        done: Arc<AtomicBool>,
        cancelled: Arc<AtomicBool>,
        thread: Option<std::thread::JoinHandle<()>>,
    }

    impl Server {
        pub fn create(name: &str) -> Result<Server, ()> {
            // D:P = 상속 안 받는 보호 DACL. OW = 개체 소유자(이 파이프를 만든 사용자)만 전부.
            let sddl = wide("D:P(A;;GA;;;OW)");
            let mut sd: PSECURITY_DESCRIPTOR = std::ptr::null_mut();
            let ok = unsafe {
                ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl.as_ptr(), SDDL_REVISION_1, &mut sd, std::ptr::null_mut())
            };
            if ok == 0 {
                return Err(());
            }
            let sa = SECURITY_ATTRIBUTES {
                nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
                lpSecurityDescriptor: sd,
                bInheritHandle: 0,
            };
            let n = wide(name);
            let h = unsafe {
                CreateNamedPipeW(
                    n.as_ptr(),
                    PIPE_ACCESS_OUTBOUND | FILE_FLAG_FIRST_PIPE_INSTANCE,
                    PIPE_TYPE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS,
                    1,
                    64 * 1024,
                    0,
                    0,
                    &sa,
                )
            };
            unsafe { LocalFree(sd as _) };
            if h == INVALID_HANDLE_VALUE {
                return Err(());
            }
            Ok(Server { handle: h as usize })
        }

        /// 다른 스레드에서 연결을 기다렸다가 한 번 쓰고 닫는다. 글자는 쓴 뒤 0 으로 덮는다.
        pub fn serve(self, mut body: String) -> Writer {
            let done = Arc::new(AtomicBool::new(false));
            let cancelled = Arc::new(AtomicBool::new(false));
            let (d, c) = (done.clone(), cancelled.clone());
            let handle = self.handle;
            let thread = std::thread::spawn(move || {
                let h = handle as windows_sys::Win32::Foundation::HANDLE;
                let connected = unsafe { ConnectNamedPipe(h, std::ptr::null_mut()) } != 0
                    || unsafe { GetLastError() } == ERROR_PIPE_CONNECTED;
                if connected && !c.load(Ordering::Acquire) {
                    let bytes = body.as_bytes();
                    let mut off = 0usize;
                    let mut ok = true;
                    while off < bytes.len() {
                        let mut wrote: u32 = 0;
                        let r = unsafe {
                            WriteFile(h, bytes[off..].as_ptr(), (bytes.len() - off) as u32, &mut wrote, std::ptr::null_mut())
                        };
                        if r == 0 || wrote == 0 {
                            ok = false;
                            break;
                        }
                        off += wrote as usize;
                    }
                    unsafe {
                        FlushFileBuffers(h);
                        DisconnectNamedPipe(h);
                    }
                    if ok {
                        d.store(true, Ordering::Release);
                    }
                }
                crate::words::wipe(&mut body);
                unsafe { CloseHandle(h) };
            });
            Writer { done, cancelled, thread: Some(thread) }
        }
    }

    impl Writer {
        pub fn delivered(&self) -> bool {
            self.done.load(Ordering::Acquire)
        }
        /// 기다리는 스레드를 풀어 준다 — 우리가 직접 한 번 붙었다 떨어진다(아무것도 안 읽는다).
        pub fn cancel(mut self, name: &str) {
            self.cancelled.store(true, Ordering::Release);
            let n = wide(name);
            let h = unsafe { CreateFileW(n.as_ptr(), GENERIC_READ, 0, std::ptr::null(), OPEN_EXISTING, 0, std::ptr::null_mut()) };
            if h != INVALID_HANDLE_VALUE {
                unsafe { CloseHandle(h) };
            }
            if let Some(t) = self.thread.take() {
                let _ = t.join();
            }
        }
        pub fn join(mut self) {
            if let Some(t) = self.thread.take() {
                let _ = t.join();
            }
        }
    }
}

// ── 흐름 ───────────────────────────────────────────────────────────────

/// 사람이 고른 것.
#[derive(Clone)]
pub(crate) struct Opts {
    pub confirm: String,
    pub rescan: String,
    pub prune_reindex: bool,
    /// true = A-2 임시 파일(윈도우에서 파이프가 안 읽혔을 때 사람이 따로 고른 때만).
    pub file: bool,
}

/// 지금 이 컴퓨터를 살핀다(단어 없이). 화면의 ①과 시작 직전 서버 쪽 확인이 같은 것을 쓴다.
pub(crate) async fn survey(ctx: &Ctx) -> Value {
    let conf = std::fs::read_to_string(ctx.datadir.join("raven.conf")).unwrap_or_default();
    let conf_has = |k: &str| {
        conf.lines().map(str::trim).filter(|l| !l.starts_with('#')).any(|l| {
            l.split_once('=')
                .is_some_and(|(a, b)| a.trim().eq_ignore_ascii_case(k) && !b.trim().is_empty() && b.trim() != "0")
        })
    };
    let wallet_file = std::fs::symlink_metadata(ctx.datadir.join("wallet.dat")).is_ok();
    let chain = rpc(ctx, "getblockchaininfo", json!([])).await.ok();
    let running = chain.is_some();
    let mut wallet = Value::Null;
    let mut has_value = false;
    let mut wallet_read = false;
    if running {
        if let Ok(w) = rpc(ctx, "getwalletinfo", json!([])).await {
            wallet_read = true;
            let assets = rpc(ctx, "listmyassets", json!([])).await.ok();
            let asset_n = assets.as_ref().and_then(Value::as_object).map(|o| o.len()).unwrap_or(0);
            let f = |k: &str| w.get(k).and_then(Value::as_f64).unwrap_or(0.0);
            let txcount = w.get("txcount").and_then(Value::as_u64).unwrap_or(0);
            has_value = txcount > 0
                || f("balance") > 0.0
                || f("unconfirmed_balance") > 0.0
                || f("immature_balance") > 0.0
                || asset_n > 0;
            // 옛(12단어 없는) 지갑인가. 🔴 답에 **지금 지갑의 단어**가 실려 오면 곧바로 지운다.
            let bip44 = match rpc(ctx, "getmywords", json!([])).await {
                Ok(mut v) => {
                    if let Some(Value::String(s)) = v.get_mut("word_list") {
                        words::wipe(s);
                    }
                    if let Some(Value::String(s)) = v.get_mut("passphrase") {
                        words::wipe(s);
                    }
                    json!(true)
                }
                Err(e) if e.contains("12 words") => json!(false),
                Err(_) => Value::Null,
            };
            wallet = json!({
                "txcount": txcount,
                "balance": f("balance"),
                "unconfirmed": f("unconfirmed_balance") + f("immature_balance"),
                "assets": asset_n,
                "encrypted": w.get("unlocked_until").is_some(),
                "bip44": bip44,
            });
        }
    }
    let c = chain.clone().unwrap_or(Value::Null);
    let pruned = c.get("pruned").and_then(Value::as_bool).unwrap_or(false);
    let pruneheight = c.get("pruneheight").and_then(Value::as_u64).unwrap_or(0);
    let blocks = c.get("blocks").and_then(Value::as_u64).unwrap_or(0);
    let branch = if !running {
        if wallet_file { "unknown" } else { "new" }
    } else if pruned && pruneheight > 0 {
        "prune"
    } else if blocks < 50_000 {
        "new"
    } else {
        "full"
    };
    let brand_new = !wallet_file && !running;
    let blocked: Option<&str> = if conf_has("disablewallet") || conf_has("wallet") {
        Some("이 컴퓨터의 노드 설정이 지갑을 끄거나 다른 지갑 파일을 쓰게 되어 있어 여기서는 되살릴 수 없습니다.")
    } else if ctx.ravend.is_none() {
        Some("노드 프로그램(ravend)을 찾지 못했습니다. RavenVault Desktop 을 다시 설치해 주세요.")
    } else if !running && wallet_file {
        Some("노드를 켜서 지금 지갑을 확인한 뒤에 할 수 있습니다. 왼쪽 아래 연결 점을 눌러 노드를 켜 주세요.")
    } else if running && !wallet_read {
        Some("지갑을 읽지 못했습니다. 노드가 다 켜진 뒤(몇 분) 다시 열어 주세요.")
    } else {
        None
    };
    json!({
        "running": running,
        "brand_new": brand_new,
        "wallet_file": wallet_file,
        "wallet": wallet,
        "has_value": has_value,
        "need_confirm": has_value,
        "chain": if running { json!({ "blocks": blocks, "headers": c.get("headers"), "pruned": pruned, "pruneheight": pruneheight,
            "ibd": c.get("initialblockdownload"), "progress": c.get("verificationprogress") }) } else { Value::Null },
        "branch": branch,
        "blocked": blocked,
        "phrase": PHRASE_ASIDE,
    })
}

/// 흐름 전체. 단어는 여기로 **옮겨져** 들어오고, 이 함수가 끝나면 떨어지며 지워진다.
pub(crate) async fn run_flow(ctx: &Ctx, phrase: Phrase, pass: Secret, opts: Opts) -> Result<Value, String> {
    let info = survey(ctx).await;
    if let Some(b) = info["blocked"].as_str() {
        // 새 컴퓨터가 아닌데 막힌 경우만 멈춘다. (지갑 자리가 비어 있는 이어 하기는 아래에서 따로 본다.)
        let resuming = read_state(&ctx.app_dir).is_some_and(|s| blocking_stage(&s.stage));
        if !resuming {
            return Err(b.to_string());
        }
    }
    let branch = info["branch"].as_str().unwrap_or("full").to_string();
    if branch == "prune" && !opts.prune_reindex {
        return Err("이 컴퓨터는 장부를 아껴 쓰고 있어(prune) 옛 거래를 찾을 수 없습니다. 「장부를 처음부터 다시 받으며 되살리기」를 고르셔야 합니다.".into());
    }
    let prev = read_state(&ctx.app_dir);
    let resuming = prev.as_ref().is_some_and(|s| blocking_stage(&s.stage) && s.stage != "undoing");
    let (first, first_change) = {
        let (r, c) = words::addresses(&phrase, pass.expose(), 1, 1, if ctx.extra.iter().any(|a| a == "-regtest") { words::TESTNET } else { words::MAINNET })
            .ok_or("주소를 만들지 못했습니다.")?;
        (r[0].clone(), c[0].clone())
    };
    let mut st = prev.clone().filter(|_| resuming).unwrap_or_else(|| State {
        started: now(),
        branch: branch.clone(),
        rescan: if opts.rescan == "after_close" { "after_close".into() } else { "now".into() },
        ..Default::default()
    });
    st.first = Some(first.clone());
    st.why = None;

    if !resuming {
        // 같은 지갑이면 되살릴 것이 없다.
        if info["running"].as_bool() == Some(true) {
            let same = rpc(ctx, "validateaddress", json!([first])).await.ok();
            if same.as_ref().and_then(|v| v["ismine"].as_bool()) == Some(true) {
                return Err("이미 이 컴퓨터의 지갑입니다. 되살릴 것이 없습니다. 옛 거래가 안 보이면 「옛 거래 다시 찾기」를 누르세요.".into());
            }
        }
        if info["has_value"].as_bool() == Some(true) && opts.confirm.trim() != PHRASE_ASIDE {
            return Err("지금 지갑에 돈·거래·자산이 있습니다. 확인 문장을 그대로 입력해야 옆에 둡니다.".into());
        }
        // ── 1. 노드 멈추기 ─────────────────────────────────────────────
        st.stage = "stopping".into();
        if ctx.is_app() {
            st.held_agent = crate::reindex_run::agent_hold();
        }
        write_state(&ctx.app_dir, &st)?;
        if info["running"].as_bool() == Some(true) {
            if let Err(e) = stop_and_wait(ctx).await {
                return Err(abandon(ctx, &mut st, e));
            }
        } else if !crate::recover::datadir_free(&ctx.datadir) {
            return Err(abandon(ctx, &mut st, "다른 프로그램이 노드 폴더를 쓰고 있습니다. 그 프로그램을 끄고 다시 해 주세요.".into()));
        }
        // ── 2. 옆에 두기 ───────────────────────────────────────────────
        match set_aside(ctx, "before-words") {
            Ok(name) => st.aside = name,
            Err(e) => return Err(abandon(ctx, &mut st, e)),
        }
        st.stage = "set_aside".into();
        write_state(&ctx.app_dir, &st)?;
    } else {
        // 이어 하기: 누가 그 사이 노드를 켰으면 끄고, 생긴 지갑이 우리 것인지 본다.
        if rpc(ctx, "getblockchaininfo", json!([])).await.is_ok() {
            let mine = rpc(ctx, "validateaddress", json!([first])).await.ok();
            let empty = rpc(ctx, "getwalletinfo", json!([])).await.ok().and_then(|w| w["txcount"].as_u64()) == Some(0);
            stop_and_wait(ctx).await.map_err(|e| keep(ctx, &mut st, e))?;
            if mine.as_ref().and_then(|v| v["ismine"].as_bool()) != Some(true) {
                if !empty {
                    return Err(keep(ctx, &mut st, "지갑 자리에 거래가 있는 다른 지갑이 생겼습니다. 여기서 멈춥니다 — 백업을 먼저 만들어 주세요.".into()));
                }
                if let Some(n) = set_aside(ctx, "empty-words").map_err(|e| keep(ctx, &mut st, e))? {
                    st.empties.push(n);
                }
            }
        }
    }

    // ── 3. 단어로 새 지갑 만들기 ───────────────────────────────────────
    let mut attempt = 0;
    let child = loop {
        attempt += 1;
        if std::fs::symlink_metadata(ctx.datadir.join("wallet.dat")).is_ok() {
            // 누가 먼저 무작위 지갑을 만들었다(설계서 7절 「단어가 안 먹음」). 방금 생겼으니 옆에 둔다.
            if let Some(n) = set_aside(ctx, "empty-words").map_err(|e| keep(ctx, &mut st, e))? {
                st.empties.push(n);
            }
        }
        st.stage = "creating".into();
        write_state(&ctx.app_dir, &st)?;
        let from = log_len(ctx);
        let mut child = match spawn_with_words(ctx, &phrase, &pass, opts.file).await {
            Ok(c) => c,
            Err(e) => {
                if e == PIPE_UNREAD {
                    // 파이프 없이 뜬 노드가 만든 빈 지갑은 옆에 둔다(거래 0건 — 방금 생겼다).
                    if let Ok(Some(n)) = set_aside(ctx, "empty-words") {
                        st.empties.push(n);
                    }
                }
                return Err(keep(ctx, &mut st, e));
            }
        };
        if let Err(e) = wait_ready(ctx, from, child.as_mut(), 900).await {
            if let Some(c) = child.as_mut() {
                let _ = c.kill();
                let _ = c.wait();
            }
            return Err(keep(ctx, &mut st, e));
        }
        // ── 4. 단어가 정말 들어갔나 ─────────────────────────────────
        let r = rpc(ctx, "validateaddress", json!([first])).await.ok();
        let c = rpc(ctx, "validateaddress", json!([first_change])).await.ok();
        let path_ok = r.as_ref().is_some_and(|v| v["ismine"].as_bool() == Some(true) && v["hdkeypath"].as_str().is_some_and(|p| p.ends_with("/0'/0/0")))
            && c.as_ref().is_some_and(|v| v["ismine"].as_bool() == Some(true) && v["hdkeypath"].as_str().is_some_and(|p| p.ends_with("/0'/1/0")));
        if path_ok {
            break child;
        }
        // 단어가 안 먹었다 — 누가 먼저 지갑을 만들었다. 끄고 그 빈 지갑을 옆에 두고 한 번만 더.
        stop_and_wait(ctx).await.map_err(|e| keep(ctx, &mut st, e))?;
        if let Some(mut c) = child {
            let _ = c.wait();
        }
        if attempt >= 2 {
            return Err(keep(ctx, &mut st, "다른 프로그램이 노드를 먼저 켜서 단어가 들어가지 않았습니다. 레이븐 코어 등을 끄고 이어 해 주세요.".into()));
        }
    };
    st.stage = "created".into();
    let keypool = rpc(ctx, "getwalletinfo", json!([])).await.ok();
    write_state(&ctx.app_dir, &st)?;

    // ── 5. 끄고 보통대로 다시 켜기 — 여기서부터 노드는 단어를 모른다 ─────────
    stop_and_wait(ctx).await.map_err(|e| keep(ctx, &mut st, e))?;
    if let Some(mut c) = child {
        let _ = c.wait();
    }
    drop(phrase);
    drop(pass);
    st.stage = "restarting".into();
    write_state(&ctx.app_dir, &st)?;
    start_normal(ctx, &mut st).await?;

    // ── 6. 옛 거래 찾기 ────────────────────────────────────────────────
    if st.branch == "prune" {
        st.stage = "reindexing".into();
        write_state(&ctx.app_dir, &st)?;
    } else if st.rescan == "after_close" {
        st.stage = "rescan_wait".into();
        write_state(&ctx.app_dir, &st)?;
    } else {
        rescan(ctx, &mut st).await?;
    }
    Ok(json!({
        "stage": st.stage,
        "first": st.first,
        "aside": st.aside,
        "keypool": keypool.as_ref().map(|w| json!({ "receive": w["keypoolsize"], "change": w["keypoolsize_hd_internal"] })),
    }))
}

/// 옆에 두기 **전에** 실패 — 아무것도 안 바뀌었다. 상태를 지우고 launchd 를 돌려놓는다.
fn abandon(ctx: &Ctx, st: &mut State, why: String) -> String {
    let _ = std::fs::remove_file(state_path(&ctx.app_dir));
    if st.held_agent && ctx.is_app() {
        crate::reindex_run::agent_release();
    }
    why
}

/// 옆에 둔 **뒤** 실패 — 지갑 자리가 비어 있다. 🔴 노드 켜기 문을 닫아 둔 채로 멈춘다
/// (여기서 누가 켜면 무작위 지갑이 생긴다). 화면이 [이어 하기]·[옛 지갑으로 되돌리기]를 준다.
fn keep(ctx: &Ctx, st: &mut State, why: String) -> String {
    st.stage = "set_aside".into();
    st.why = Some(why.clone());
    let _ = write_state(&ctx.app_dir, st);
    why
}

/// 단어 없이 보통대로 켠다. 앱: launchd 를 내려 뒀으면 돌려놔 그쪽이 켜게 하고, 아니면 우리가 켠다.
async fn start_normal(ctx: &Ctx, st: &mut State) -> Result<(), String> {
    let from = log_len(ctx);
    if ctx.is_app() {
        if st.branch == "prune" {
            // 장부를 처음부터 다시 받는다 — 붙는 블록마다 지갑이 제 거래를 잡는다(설계서 F13).
            let _ = std::fs::write(crate::paths::app_file("words-reindex"), "1");
        }
        if st.held_agent && st.branch != "prune" {
            crate::reindex_run::agent_release();
            st.held_agent = false;
        } else {
            let files = crate::mode::autostart_now().files;
            let _ = crate::services::start_parts(files).await;
        }
    } else {
        let ravend = ctx.ravend.clone().ok_or("노드 프로그램(ravend)을 찾지 못했습니다.")?;
        let mut cmd = std::process::Command::new(ravend);
        cmd.arg(format!("-datadir={}", ctx.datadir.to_string_lossy())).arg("-server=1").args(&ctx.extra);
        #[cfg(unix)]
        cmd.arg("-daemon");
        let _ = cmd.stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null()).status();
    }
    write_state(&ctx.app_dir, st)?;
    wait_ready(ctx, from, None, 900).await.map_err(|_| {
        "지갑은 되살렸지만 노드가 아직 안 켜졌습니다. 왼쪽 아래 연결 점을 눌러 켠 뒤 「옛 거래 찾기」를 눌러 주세요.".to_string()
    })
}

/// `rescanblockchain` — 생일과 상관없이 처음부터 훑는다. 끝날 때까지 노드는 다른 질문에 답을 못 한다.
async fn rescan(ctx: &Ctx, st: &mut State) -> Result<(), String> {
    st.stage = "rescanning".into();
    st.log_from = log_len(ctx);
    st.tip = rpc(ctx, "getblockcount", json!([])).await.ok().and_then(|v| v.as_u64()).unwrap_or(0);
    write_state(&ctx.app_dir, st)?;
    if ctx.is_app() {
        RESCAN.store(true, Ordering::Release);
        crate::awake::sync_with_mode();
    }
    let r = rpc_long(ctx, "rescanblockchain", json!([]), 72 * 3600).await;
    let mut outcome = match &r {
        Ok(_) => "done",
        Err(e) if e.contains("Rescan aborted") => "rescan_stopped",
        Err(_) => "unknown",
    };
    if outcome == "unknown" {
        // 연결만 끊겼을 수 있다 — 노드 안의 훑기는 계속된다. 지갑이 다시 답하면 끝난 것이다.
        let mut answered = false;
        for _ in 0..(72 * 60) {
            if rpc_long(ctx, "getwalletinfo", json!([]), 30).await.is_ok() {
                answered = true;
                break;
            }
            tokio::time::sleep(Duration::from_secs(30)).await;
            if !ctx.is_app() {
                break;
            }
        }
        let tail = log_since(ctx, st.log_from);
        outcome = if answered && !tail.contains("Rescan aborted") { "done" } else { "rescan_stopped" };
    }
    RESCAN.store(false, Ordering::Release);
    if ctx.is_app() {
        crate::awake::sync_with_mode();
    }
    if outcome == "done" {
        st.result = Some(summary(ctx).await);
        st.stage = "done".into();
        if st.held_agent && ctx.is_app() {
            crate::reindex_run::agent_release();
            st.held_agent = false;
        }
    } else {
        st.stage = "rescan_stopped".into();
    }
    write_state(&ctx.app_dir, st)
}

/// 끝 화면: 잔액 · 자산 · 증서 · 거래 수 · 지갑 암호 여부.
async fn summary(ctx: &Ctx) -> Value {
    let w = rpc(ctx, "getwalletinfo", json!([])).await.unwrap_or(Value::Null);
    let assets = rpc(ctx, "listmyassets", json!([])).await.ok();
    let names: Vec<String> = assets
        .as_ref()
        .and_then(Value::as_object)
        .map(|o| o.keys().cloned().collect())
        .unwrap_or_default();
    let certs = names.iter().filter(|n| n.contains('#')).count();
    json!({
        "balance": w["balance"],
        "unconfirmed": w["unconfirmed_balance"],
        "immature": w["immature_balance"],
        "txcount": w["txcount"],
        // 주인 표(`이름!`)와 증서(`#`)는 따로 센다.
        "assets": names.iter().filter(|n| !n.ends_with('!') && !n.contains('#')).count(),
        "certs": certs,
        "encrypted": w.get("unlocked_until").is_some(),
        "keypool": w["keypoolsize"],
        "keypool_change": w["keypoolsize_hd_internal"],
    })
}

/// [옛 지갑으로 되돌리기] — 되살린 지갑도 **지우지 않는다**(`from-words` 로 옆에 둔다).
pub(crate) async fn undo(ctx: &Ctx) -> Result<Value, String> {
    let mut st = read_state(&ctx.app_dir).ok_or("되돌릴 되살리기 기록이 없습니다.")?;
    let aside = st.aside.clone().ok_or("옆에 둔 옛 지갑이 없습니다(처음부터 지갑이 없던 컴퓨터).")?;
    if std::fs::symlink_metadata(ctx.datadir.join(&aside)).is_err() {
        return Err("옆에 둔 옛 지갑 파일을 찾지 못했습니다. 노드 폴더를 확인해 주세요.".into());
    }
    if ctx.is_app() && !st.held_agent {
        st.held_agent = crate::reindex_run::agent_hold();
    }
    if rpc(ctx, "getblockchaininfo", json!([])).await.is_ok() {
        stop_and_wait(ctx).await?;
    }
    st.stage = "undoing".into();
    write_state(&ctx.app_dir, &st)?;
    crate::recover::with_datadir_locked(&ctx.app_dir, &ctx.datadir, |dir| {
        let cur = dir.join("wallet.dat");
        if std::fs::symlink_metadata(&cur).is_ok() {
            let mut name = format!("wallet.dat.from-words-{}", stamp());
            let mut n = 1;
            while std::fs::symlink_metadata(dir.join(&name)).is_ok() {
                n += 1;
                name = format!("wallet.dat.from-words-{}-{n}", stamp());
            }
            move_no_clobber(&cur, &dir.join(&name))?;
        }
        move_no_clobber(&dir.join(&aside), &cur)
    })?;
    st.stage = "undone".into();
    st.aside = None;
    write_state(&ctx.app_dir, &st)?;
    let _ = start_normal(ctx, &mut st).await;
    Ok(json!({ "stage": "undone" }))
}

// ── 화면이 부르는 것 ────────────────────────────────────────────────────

/// ① — 단어를 받기 **전에** 이 컴퓨터를 살핀다.
#[tauri::command]
pub async fn words_restore_preflight() -> Value {
    let ctx = Ctx::app();
    let mut v = survey(&ctx).await;
    v["state"] = read_state(&ctx.app_dir).map(|s| json!(s)).unwrap_or(Value::Null);
    v["busy"] = json!(BUSY.load(Ordering::Acquire));
    v["rescanning"] = json!(rescanning());
    v["shop"] = json!(crate::mode::mode_get()["mode"] == "shop");
    v["channel"] = json!(if cfg!(windows) { "pipe" } else { "fifo" });
    v
}

fn problem_value(p: &words::Problem) -> Value {
    let (kind, at, count) = match p {
        words::Problem::Count(n) => ("count", vec![], *n),
        words::Problem::Unknown(at) => ("unknown", at.clone(), 0),
        words::Problem::Checksum => ("checksum", vec![], 0),
    };
    json!({ "ok": false, "kind": kind, "at": at, "count": count, "message": p.message() })
}

/// ②→③ — 단어를 코어와 같은 규칙으로 검사하고, **공개 주소로만** 노드에 묻는다.
#[tauri::command]
pub async fn words_restore_check(words: String, passphrase: Option<String>) -> Value {
    let mut words = words;
    let pass = Secret::new(passphrase.unwrap_or_default());
    let checked = words::check(&words);
    words::wipe(&mut words);
    let phrase = match checked {
        Ok(p) => p,
        Err(p) => return problem_value(&p),
    };
    if !passphrase_fits(pass.expose()) {
        return json!({ "ok": false, "kind": "passphrase", "message": "추가 암호에 # 이나 앞뒤 빈칸이 있으면 이 방법으로는 건넬 수 없습니다. 그런 암호였다면 레이븐 코어(Raven-Qt)에서 되살려 주세요." });
    }
    let Some((recv, chg)) = words::addresses(&phrase, pass.expose(), 20, 20, words::MAINNET) else {
        return json!({ "ok": false, "kind": "derive", "message": "주소를 만들지 못했습니다." });
    };
    let count = phrase.count();
    drop(phrase);
    drop(pass);
    let ctx = Ctx::app();
    let mut same = Value::Null;
    let mut history = "unknown";
    if rpc(&ctx, "getblockchaininfo", json!([])).await.is_ok() {
        same = rpc(&ctx, "validateaddress", json!([recv[0]])).await.ok().map(|v| v["ismine"].clone()).unwrap_or(Value::Null);
        let all: Vec<&String> = recv.iter().chain(chg.iter()).collect();
        history = match rpc(&ctx, "getaddresstxids", json!([{ "addresses": all }])).await {
            Ok(Value::Array(a)) if !a.is_empty() => "found",
            Ok(Value::Array(_)) => "none",
            _ => "unknown",
        };
    }
    json!({ "ok": true, "count": count, "first": recv[0], "same_wallet": same, "history": history })
}

/// ③→④ — 시작. 흐름은 뒤에서 돌고, 화면은 `words_restore_status` 로 따라간다.
#[tauri::command]
pub async fn words_restore_start(
    words: String,
    passphrase: Option<String>,
    confirm: Option<String>,
    rescan: Option<String>,
    prune_reindex: Option<bool>,
    channel: Option<String>,
) -> Result<Value, String> {
    let mut words = words;
    let pass = Secret::new(passphrase.unwrap_or_default());
    let checked = words::check(&words);
    words::wipe(&mut words);
    let phrase = checked.map_err(|p| p.message())?;
    if !passphrase_fits(pass.expose()) {
        return Err("추가 암호에 # 이나 앞뒤 빈칸이 있으면 이 방법으로는 건넬 수 없습니다.".into());
    }
    if BUSY.swap(true, Ordering::AcqRel) {
        return Err("이미 되살리는 중입니다.".into());
    }
    let opts = Opts {
        confirm: confirm.unwrap_or_default(),
        rescan: rescan.unwrap_or_else(|| "now".into()),
        prune_reindex: prune_reindex.unwrap_or(false),
        file: channel.as_deref() == Some("file"),
    };
    tauri::async_runtime::spawn(async move {
        let ctx = Ctx::app();
        let r = run_flow(&ctx, phrase, pass, opts).await;
        if let Err(why) = r {
            // 상태 파일이 남아 있으면(옆에 둔 뒤) 거기 이유를 이미 적었다. 아니면 마지막 실패만 기억한다.
            if let Ok(mut g) = LAST_ERROR.lock() {
                *g = Some(why);
            }
        }
        BUSY.store(false, Ordering::Release);
    });
    Ok(json!({ "started": true }))
}

static LAST_ERROR: std::sync::Mutex<Option<String>> = std::sync::Mutex::new(None);
/// 옛 거래 찾기 진행 — (관찰한 시각, 진행률). 남은 시간을 셈한다.
static SAMPLES: std::sync::Mutex<Vec<(u64, f64)>> = std::sync::Mutex::new(Vec::new());

/// `Still rescanning. At block N. Progress=p` 의 마지막 줄.
fn rescan_progress(text: &str) -> Option<(u64, f64)> {
    let line = text.lines().rev().find(|l| l.contains("Still rescanning. At block "))?;
    let after = line.split("At block ").nth(1)?;
    let height: u64 = after.split('.').next()?.trim().parse().ok()?;
    let p: f64 = after.split("Progress=").nth(1)?.trim().parse().ok()?;
    Some((height, p))
}

/// ④⑤ — 지금 어디까지 왔나. 단어 없음.
#[tauri::command]
pub async fn words_restore_status() -> Value {
    let ctx = Ctx::app();
    let st = read_state(&ctx.app_dir);
    let mut v = json!({
        "state": st.as_ref().map(|s| json!(s)),
        "busy": BUSY.load(Ordering::Acquire),
        "rescanning": rescanning(),
        "error": LAST_ERROR.lock().ok().and_then(|g| g.clone()),
    });
    if let Some(s) = st.as_ref().filter(|s| s.stage == "rescanning") {
        if let Some((h, p)) = rescan_progress(&log_since(&ctx, s.log_from)) {
            let t = now();
            let mut eta = Value::Null;
            if let Ok(mut g) = SAMPLES.lock() {
                if g.last().map(|x| x.1) != Some(p) {
                    g.push((t, p));
                }
                if let (Some(a), Some(b)) = (g.first(), g.last()) {
                    if b.1 > a.1 && b.0 > a.0 {
                        let rate = (b.1 - a.1) / (b.0 - a.0) as f64;
                        eta = json!(((1.0 - b.1) / rate / 60.0).ceil());
                    }
                }
            }
            v["progress"] = json!({ "height": h, "tip": s.tip, "pct": (p * 1000.0).round() / 10.0, "eta_min": eta });
        }
    }
    if let Some(s) = st.as_ref().filter(|s| s.stage == "reindexing") {
        if let Ok(c) = rpc(&ctx, "getblockchaininfo", json!([])).await {
            let p = c["verificationprogress"].as_f64().unwrap_or(0.0);
            v["progress"] = json!({ "height": c["blocks"], "pct": (p * 1000.0).round() / 10.0 });
            if p > 0.9999 && c["initialblockdownload"].as_bool() == Some(false) {
                let mut s2 = s.clone();
                s2.result = Some(summary(&ctx).await);
                s2.stage = "done".into();
                if s2.held_agent {
                    crate::reindex_run::agent_release();
                    s2.held_agent = false;
                }
                let _ = write_state(&ctx.app_dir, &s2);
                v["state"] = json!(s2);
            }
        }
    }
    v
}

/// [옛 거래 찾기 / 이어 찾기] — 가게면 「마감 뒤」 예약이 여기로 온다.
#[tauri::command]
pub async fn words_restore_rescan() -> Result<Value, String> {
    if BUSY.swap(true, Ordering::AcqRel) {
        return Err("이미 되살리는 중입니다.".into());
    }
    let ctx = Ctx::app();
    let mut st = read_state(&ctx.app_dir).unwrap_or_else(|| State {
        // 「이미 이 컴퓨터의 지갑」인데 옛 거래가 안 보일 때 — 되살리기 없이 찾기만.
        started: now(),
        branch: "full".into(),
        rescan: "now".into(),
        ..Default::default()
    });
    if blocking_stage(&st.stage) || st.stage == "reindexing" {
        BUSY.store(false, Ordering::Release);
        return Err("지금은 찾을 수 없습니다. 되살리기를 먼저 이어 해 주세요.".into());
    }
    tauri::async_runtime::spawn(async move {
        if rpc(&ctx, "getblockchaininfo", json!([])).await.is_err() {
            if let Err(e) = start_normal(&ctx, &mut st).await {
                if let Ok(mut g) = LAST_ERROR.lock() {
                    *g = Some(e);
                }
                BUSY.store(false, Ordering::Release);
                return;
            }
        }
        if let Ok(mut g) = SAMPLES.lock() {
            g.clear();
        }
        if let Err(e) = rescan(&ctx, &mut st).await {
            if let Ok(mut g) = LAST_ERROR.lock() {
                *g = Some(e);
            }
        }
        BUSY.store(false, Ordering::Release);
    });
    Ok(json!({ "started": true }))
}

/// [그만 찾기] — 멈춰도 지갑은 되살아나 있다. 나중에 [이어 찾기].
#[tauri::command]
pub async fn words_restore_abort() -> Result<Value, String> {
    let r = crate::raven::call_rpc("abortrescan", json!([])).await?;
    Ok(json!({ "stopped": r }))
}

/// [옛 지갑으로 되돌리기]
#[tauri::command]
pub async fn words_restore_undo() -> Result<Value, String> {
    if BUSY.swap(true, Ordering::AcqRel) {
        return Err("되살리는 중에는 되돌릴 수 없습니다. 끝나거나 멈춘 뒤 눌러 주세요.".into());
    }
    let r = undo(&Ctx::app()).await;
    BUSY.store(false, Ordering::Release);
    r
}

/// [닫기] — 끝난 되살리기를 접는다. 옆에 둔 파일 이름은 남긴다(나중에 되돌리기).
#[tauri::command]
pub fn words_restore_close() -> Result<Value, String> {
    let app = crate::paths::app_dir();
    let Some(mut st) = read_state(&app) else {
        return Ok(json!({ "closed": true }));
    };
    if !matches!(st.stage.as_str(), "done" | "undone" | "rescan_stopped" | "rescan_wait" | "reindexing" | "closed") {
        return Err("아직 끝나지 않았습니다.".into());
    }
    if st.stage == "done" || st.stage == "undone" {
        st.stage = "closed".into();
        write_state(&app, &st)?;
    }
    if let Ok(mut g) = LAST_ERROR.lock() {
        *g = None;
    }
    Ok(json!({ "closed": true }))
}

#[cfg(test)]
mod tests {
    use super::*;

    const V1: &str = "legal winner thank year wave sausage worth useful legal winner thank yellow";

    fn scratch(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("rvw-{name}-{}-{:x}", std::process::id(), rand::random::<u32>()));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn ctx(dir: &Path) -> Ctx {
        let datadir = dir.join("node");
        std::fs::create_dir_all(&datadir).unwrap();
        Ctx { datadir, app_dir: dir.join("app"), ravend: None, direct: Some(Direct { port: 9, cookie: dir.join("none") }), extra: vec![] }
    }

    /// U7 — 명령줄에는 단어가 없다. 통로 경로만.
    #[test]
    fn command_line_never_carries_words() {
        let d = scratch("argv");
        let c = ctx(&d);
        let args = creation_args(&c, "/x/c-1.conf").join(" ");
        assert!(!args.contains("mnemonic"), "명령줄에 단어 옵션이 들어갔다");
        assert!(args.contains("-conf=/x/c-1.conf"));
        assert!(!args.contains("-rescan"), "시작 옵션 -rescan 은 생일 함정이다(F11)");
        // 소스에서도: 명령줄을 만드는 곳에 단어를 꺼내는 부름이 없다.
        let src = include_str!("words_restore.rs");
        let i = src.find("fn creation_args").unwrap();
        let body = &src[i..i + src[i..].find("\n}\n").unwrap()];
        assert!(!body.contains("expose"), "명령줄 만드는 곳에서 단어를 꺼낸다");
        let _ = std::fs::remove_dir_all(&d);
    }

    /// U7 — 통로 내용: 단어 줄이 맨 위, raven.conf 의 나머지는 그대로, 옛 mnemonic 줄은 빠진다.
    #[test]
    fn channel_body_puts_words_first_and_keeps_conf() {
        let d = scratch("body");
        let c = ctx(&d);
        std::fs::write(c.datadir.join("raven.conf"), "rpcport=9999\nmnemonic=old stuff\nprune=5000\ndaemon=1\nwallet=x.dat\n").unwrap();
        let p = words::check(V1).ok().unwrap();
        let mut body = channel_body(&c, &p, &Secret::new("TREZOR".into()));
        assert!(body.starts_with("mnemonic=legal winner"));
        assert!(body.contains("\nmnemonicpassphrase=TREZOR\n"));
        assert!(body.contains("\nrpcport=9999\n") && body.contains("\nprune=5000\n"));
        assert!(!body.contains("old stuff") && !body.contains("daemon=1") && !body.contains("wallet=x.dat"));
        words::wipe(&mut body);
        // raven.conf 는 그대로다(conf.bak 도 안 생긴다).
        assert!(std::fs::read_to_string(c.datadir.join("raven.conf")).unwrap().contains("mnemonic=old stuff"));
        assert!(!c.datadir.join("raven.conf.bak").exists());
        let _ = std::fs::remove_dir_all(&d);
    }

    /// F17 — 설정 파일 문법에 걸리는 추가 암호는 받지 않는다(명령줄로 돌리지도 않는다).
    #[test]
    fn passphrase_that_config_would_mangle_is_refused() {
        assert!(passphrase_fits(""));
        assert!(passphrase_fits("TREZOR"));
        assert!(passphrase_fits("한글 암호 가운데 빈칸"));
        for bad in ["a#b", " lead", "trail ", "two\nlines", "cr\r"] {
            assert!(!passphrase_fits(bad), "받으면 안 된다: {bad:?}");
        }
    }

    /// U7 — FIFO 는 0700 폴더 안 0600, 끝나면 폴더째 지워진다.
    #[cfg(unix)]
    #[test]
    fn pipe_dir_is_private_and_removed() {
        use std::os::unix::fs::PermissionsExt;
        let d = scratch("pipe");
        let c = ctx(&d);
        std::fs::create_dir_all(&c.app_dir).unwrap();
        {
            let pd = make_pipe_dir(&c).unwrap();
            let mode = std::fs::metadata(&pd.0).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, 0o700);
        }
        assert!(!pipe_dir(&c).exists(), "통로 폴더가 남았다");
        let _ = std::fs::remove_dir_all(&d);
    }

    /// U8 — 노드 켜기 문: 옆에 둔 뒤·만드는 중·되돌리는 중에는 닫힌다. 끝나면 열린다.
    #[test]
    fn gate_blocks_only_while_wallet_slot_is_empty() {
        for s in ["set_aside", "creating", "undoing"] {
            assert!(blocking_stage(s), "{s} 에서 노드를 켜면 무작위 지갑이 생긴다");
        }
        for s in ["", "created", "restarting", "rescanning", "rescan_wait", "rescan_stopped", "done", "closed", "undone", "reindexing"] {
            assert!(!blocking_stage(s), "{s} 에서 노드를 막으면 안 된다");
        }
        // 서비스·재색인 쪽이 정말 이 문을 묻는지(소스).
        let services = include_str!("services.rs");
        let i = services.find("pub async fn start_parts").unwrap();
        assert!(services[i..i + 1500].contains("words_restore::node_start_hold()"), "start_parts 가 문을 안 묻는다");
        let rx = include_str!("reindex_run.rs");
        let j = rx.find("pub async fn reindex_start").unwrap();
        assert!(rx[j..j + 800].contains("words_restore::node_start_hold()"), "reindex_start 가 문을 안 묻는다");
    }

    /// U8 — 옆에 두기: 이름만 바꾸고, 자리에 무엇이 있으면 덮지 않고 멈춘다. 지우는 길은 없다.
    /// 다른 시험(recover.rs)이 같은 프로세스 복원 문을 잠깐 쥐고 있을 수 있다 — 잠시 기다려 다시.
    fn aside_retry(c: &Ctx) -> Result<Option<String>, String> {
        let mut last = Err(String::new());
        for _ in 0..200 {
            last = set_aside(c, "before-words");
            match &last {
                Err(e) if e.contains("진행 중") => std::thread::sleep(Duration::from_millis(25)),
                _ => break,
            }
        }
        last
    }

    #[test]
    fn set_aside_moves_without_clobbering() {
        let d = scratch("aside");
        let c = ctx(&d);
        std::fs::create_dir_all(&c.app_dir).unwrap();
        std::fs::write(c.datadir.join("wallet.dat"), b"old wallet bytes").unwrap();
        let name = aside_retry(&c).unwrap().unwrap();
        assert!(safe_name(&name) && name.starts_with("wallet.dat.before-words-"));
        assert!(!c.datadir.join("wallet.dat").exists());
        assert_eq!(std::fs::read(c.datadir.join(&name)).unwrap(), b"old wallet bytes");
        // 덮지 않는다.
        std::fs::write(c.datadir.join("a"), b"1").unwrap();
        std::fs::write(c.datadir.join("b"), b"2").unwrap();
        assert!(move_no_clobber(&c.datadir.join("a"), &c.datadir.join("b")).is_err());
        assert_eq!(std::fs::read(c.datadir.join("b")).unwrap(), b"2");
        assert!(c.datadir.join("a").exists());
        // 지갑이 없으면 아무것도 안 한다.
        assert!(aside_retry(&c).unwrap().is_none());
        // 이 파일에 지갑을 지우는 부름이 없다(통로 파일·상태 파일만 지운다).
        let src = include_str!("words_restore.rs");
        let end = src.find("#[cfg(test)]").unwrap();
        for line in src[..end].lines().filter(|l| l.contains("remove_file(") || l.contains("remove_dir_all(")) {
            assert!(!line.contains("wallet.dat") && !line.contains("aside") && !line.contains("datadir"), "지갑을 지우는 줄: {line}");
        }
        let _ = std::fs::remove_dir_all(&d);
    }

    /// 상태 파일을 누가 고쳐 `../` 를 넣어도 노드 폴더 밖을 옮기지 않는다.
    #[test]
    fn state_with_foreign_name_is_ignored() {
        let d = scratch("state");
        std::fs::create_dir_all(&d).unwrap();
        std::fs::write(d.join(STATE_FILE), r#"{"v":1,"stage":"set_aside","aside":"../../etc/passwd","branch":"full","rescan":"now","started":1,"updated":1}"#).unwrap();
        assert!(read_state(&d).is_none());
        let _ = std::fs::remove_dir_all(&d);
    }

    /// U9 — 로그 가림: `mnemonic` 이 든 줄은 화면·복사·신고로 안 나간다.
    #[test]
    fn log_lines_with_mnemonic_are_masked() {
        let core = format!("2026-09-25 Error: SetMnemonic: invalid {}: `{V1}`", "mnemonic");
        let m = mask_line(&core);
        for w in V1.split(' ') {
            assert!(!m.contains(w), "가린 줄에 단어가 남았다");
        }
        assert_eq!(mask_line("UpdateTip: new best"), "UpdateTip: new best");
        assert!(masks_node_error(&core));
    }

    /// U6 — 이 파일의 오류 문장은 고정이다. 단어를 꺼내는 `expose()` 가 `format!`/`Err(` 안에 없다.
    #[test]
    fn no_error_formats_the_words() {
        let src = include_str!("words_restore.rs");
        let end = src.find("#[cfg(test)]").unwrap();
        for (k, line) in src[..end].lines().enumerate() {
            if line.contains("expose()") {
                assert!(!line.contains("format!") && !line.contains("Err(") && !line.contains("println") && !line.contains("eprintln"),
                    "{}번째 줄에서 단어가 문장으로 나간다: {line}", k + 1);
            }
        }
        // 흐름의 어떤 실패도 단어를 싣지 않는다 — 실제로 실패시켜 본다(노드 없음).
        let d = scratch("errs");
        let c = ctx(&d);
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        for bad in [V1, "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about"] {
            let p = words::check(bad).ok().unwrap();
            let e = rt.block_on(run_flow(&c, p, Secret::new("TREZOR".into()), Opts { confirm: String::new(), rescan: "now".into(), prune_reindex: false, file: false }))
                .err()
                .unwrap_or_default();
            assert!(!e.is_empty());
            for w in bad.split(' ') {
                assert!(!e.contains(w), "실패 문장에 단어가 있다");
            }
            assert!(!e.contains("TREZOR"));
        }
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn rescan_progress_reads_core_line() {
        let log = "2026-09-25 12:00:00 Still rescanning. At block 2130000. Progress=0.481234\nother\n";
        assert_eq!(rescan_progress(log), Some((2_130_000, 0.481234)));
        assert_eq!(rescan_progress("nothing"), None);
    }

    /// 🔴 격리한 **진짜 코어**로 흐름 전체를 돈다(메인넷 주소 · 네트워크 끔 · 새 포트 · 임시 폴더).
    /// `RV_TEST_RAVEND=<ravend 경로>` 가 있을 때만: `cargo test real_flow -- --ignored --nocapture`.
    /// 대표님 노드·폴더는 건드리지 않는다. 우리가 띄운 노드만 RPC `stop` 으로 끈다.
    #[test]
    #[ignore]
    fn real_flow_on_isolated_core() {
        let Ok(ravend) = std::env::var("RV_TEST_RAVEND") else { return };
        let base = PathBuf::from(format!("/tmp/claude-501/rv049-flow-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(base.join("node")).unwrap();
        std::fs::create_dir_all(base.join("app")).unwrap();
        let port = 39_950 + (std::process::id() % 40) as u16;
        let rpcport = port + 1;
        let extra: Vec<String> = [
            "-listen=0", "-connect=0", "-dnsseed=0", "-upnp=0", "-discover=0", "-maxconnections=0",
            "-rpcbind=127.0.0.1", "-rpcallowip=127.0.0.1", "-printtoconsole=0",
        ]
        .iter()
        .map(|s| s.to_string())
        .chain([format!("-port={port}"), format!("-rpcport={rpcport}")])
        .collect();
        let c = Ctx {
            datadir: base.join("node"),
            app_dir: base.join("app"),
            ravend: Some(PathBuf::from(&ravend)),
            direct: Some(Direct { port: rpcport, cookie: base.join("node/.cookie") }),
            extra: extra.clone(),
        };
        let rt = tokio::runtime::Builder::new_multi_thread().enable_all().build().unwrap();
        rt.block_on(async {
            // 0) 무작위 지갑이 있는 보통 노드(= 「지금 이 컴퓨터 지갑」, 거래 0건).
            let from = log_len(&c);
            start_normal(&c, &mut State::default()).await.unwrap();
            wait_ready(&c, from, None, 120).await.unwrap();
            let before = rpc(&c, "getnewaddress", json!([])).await.unwrap();
            // 1) 흐름 전체 — 단어 FIFO 통로 · 옆에 두기 · 확인 · 다시 켜기 · rescanblockchain.
            let p = words::check(V1).ok().unwrap();
            let fixture: Value = serde_json::from_str(include_str!("../../scripts/fixtures/restore-vectors.json")).unwrap();
            let v = &fixture["vectors"][1];
            let watch_ps = std::thread::spawn(|| {
                // 만드는 동안 프로세스 목록을 여러 번 훑는다.
                let mut seen = false;
                for _ in 0..60 {
                    let out = std::process::Command::new("ps").args(["-axww", "-o", "args="]).output().unwrap();
                    let s = String::from_utf8_lossy(&out.stdout).to_string();
                    if s.contains("sausage worth useful") || s.contains("-mnemonic") {
                        seen = true;
                    }
                    std::thread::sleep(Duration::from_millis(250));
                }
                seen
            });
            let out = run_flow(&c, p, Secret::new(String::new()), Opts { confirm: String::new(), rescan: "now".into(), prune_reindex: false, file: false })
                .await
                .unwrap();
            assert!(!watch_ps.join().unwrap(), "프로세스 목록에 단어가 보였다");
            eprintln!("flow → {out}");
            let st = read_state(&c.app_dir).unwrap();
            assert_eq!(st.stage, "done");
            let aside = st.aside.clone().unwrap();
            assert!(c.datadir.join(&aside).exists(), "옛 지갑이 옆에 없다");
            // 되살린 지갑 = 폰 주소(받기·거스름 25개씩).
            for (ch, key) in [(0, "receive"), (1, "change")] {
                for (i, a) in v[key].as_array().unwrap().iter().enumerate() {
                    let va = rpc(&c, "validateaddress", json!([a])).await.unwrap();
                    assert_eq!(va["ismine"], true, "{key} {i}");
                    assert_eq!(va["hdkeypath"], format!("m/44'/175'/0'/{ch}/{i}"));
                }
            }
            // 옛 지갑의 주소는 이제 내 것이 아니다(옆에 있다).
            let old = rpc(&c, "validateaddress", json!([before])).await.unwrap();
            assert_eq!(old["ismine"], false);
            // 흔적: 통로 폴더 없음 · debug.log 에 단어 없음 · 상태 파일에 단어 없음.
            assert!(!pipe_dir(&c).exists());
            let log = std::fs::read_to_string(c.datadir.join("debug.log")).unwrap();
            assert!(!log.contains("sausage worth useful") && !log.contains("mnemonic="));
            let state_txt = std::fs::read_to_string(state_path(&c.app_dir)).unwrap();
            assert!(!state_txt.contains("sausage"));
            // 2) 되돌리기 — 옛 지갑이 돌아오고, 되살린 지갑도 옆에 남는다.
            undo(&c).await.unwrap();
            let back = rpc(&c, "validateaddress", json!([before])).await.unwrap();
            assert_eq!(back["ismine"], true, "옛 지갑이 안 돌아왔다");
            let names: Vec<String> = std::fs::read_dir(&c.datadir).unwrap().flatten().map(|e| e.file_name().to_string_lossy().to_string()).collect();
            assert!(names.iter().any(|n| n.starts_with("wallet.dat.from-words-")), "되살린 지갑이 옆에 없다");
            stop_and_wait(&c).await.unwrap();
        });
        let _ = std::fs::remove_dir_all(&base);
    }
}
