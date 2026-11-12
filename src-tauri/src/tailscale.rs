//! 테일스케일 퍼널(Funnel)로 **바뀌지 않는 가게 주소** 만들기.
//!
//! ## 왜
//!
//! 「바깥 연결」(tunnel.rs)의 무료 주소 `…trycloudflare.com` 은 앱을 다시 켤 때마다
//! 바뀐다. 지도·X 에 올린 링크가 다음 날 죽는다. 고정 주소를 얻는 길은 지금까지
//! 클라우드플레어 「이름 있는 터널」뿐이었는데, 그건 **내 도메인**이 있어야 한다.
//!
//! 테일스케일 퍼널은 도메인 없이 `https://내컴퓨터.무슨무슨.ts.net` 을 준다. 이 주소는
//! 컴퓨터 이름이 그대로인 한 바뀌지 않는다.
//!
//! ## 지키는 것
//!
//! - **가게 문(8790)만 연다.** 퍼널은 `--bg 8790` 하나만 켠다 — 지갑·노드·IPFS 자리는
//!   바깥에 나가지 않는다. 복구 단어·지갑은 이 일과 아무 상관이 없다.
//! - **명령줄은 고정이다.** 사람이 적은 글은 한 글자도 명령에 들어가지 않는다.
//!   셸을 거치지 않고 `Command` 로 실행 파일을 바로 부른다.
//! - **로그인은 사람이 한다.** 우리는 테일스케일이 내놓은 로그인·승인 주소를 브라우저로
//!   열어 줄 뿐이다. 암호를 받거나 대신 넣는 길은 없다.
//! - **연 주소는 `login.tailscale.com` 과 정해 둔 주소뿐**(`tailscale_open`).
//! - **된다고 말하기 전에 들어와 본다.** 퍼널이 켜졌다고 끝이 아니다 — 그 주소로
//!   실제로 대답이 오는지 본 다음에만 가게 링크로 쓴다.
//! - 보통 테일스케일 주소(100.x · 내 기기끼리만 보이는 주소)는 **손님에게 안 열린다.**
//!   그래서 퍼널 주소(`https://…ts.net`)만 쓴다.

use serde_json::{json, Value};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Child, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/// 가게 문. 퍼널은 이 자리 하나만 연다.
#[allow(dead_code)] // 시험(args_are_fixed)이 FUNNEL_ON_ARGS 와 맞춰 본다
pub const SHOP_PORT: u16 = 8790;
pub const DOWNLOAD_URL: &str = "https://tailscale.com/download";
const ADMIN_MACHINES_URL: &str = "https://login.tailscale.com/admin/machines";
const ADMIN_DNS_URL: &str = "https://login.tailscale.com/admin/dns";
/// CLI 가 내놓는 로그인·승인 주소는 이 앞자리로 시작할 때만 연다.
const LOGIN_PREFIX: &str = "https://login.tailscale.com/";

/// 사람이 승인하기를 기다리며 떠 있는 CLI(`tailscale login` / `tailscale funnel --bg`).
/// 승인되면 스스로 끝난다. 10분이 지나면 우리가 끝낸다.
struct Pending {
    child: Child,
    kind: &'static str,
    url: String,
}
static PENDING: Mutex<Option<Pending>> = Mutex::new(None);
/// 마지막으로 받은 로그인·승인 주소 — `tailscale_open("login" | "approve")` 이 연다.
static LAST_URL: Mutex<Option<String>> = Mutex::new(None);
const PENDING_LIMIT: Duration = Duration::from_secs(600);

// ── 고정 명령줄 ─────────────────────────────────────────────────────────────
// 🔴 여기 말고 다른 곳에서 인자를 만들지 않는다. 시험(`args_are_fixed`)이 지킨다.

pub const STATUS_ARGS: [&str; 2] = ["status", "--json"];
pub const LOGIN_ARGS: [&str; 1] = ["login"];
pub const UP_ARGS: [&str; 1] = ["up"];
/// 가게 문(8790)만 퍼널로 연다. `--bg` — 앱이 꺼져도, 컴퓨터를 다시 켜도 테일스케일이 이어 간다.
pub const FUNNEL_ON_ARGS: [&str; 3] = ["funnel", "--bg", "8790"];
/// 끄기 — 문서의 `tailscale funnel 8790 off`. 판에 따라 안 먹으면 `--https=443 off`.
/// `funnel reset` 은 쓰지 않는다: 사장이 따로 켜 둔 다른 공유까지 지운다.
pub const FUNNEL_OFF_ARGS: [&str; 3] = ["funnel", "8790", "off"];
pub const FUNNEL_OFF_FALLBACK_ARGS: [&str; 3] = ["funnel", "--https=443", "off"];

// ── 찾기 ──────────────────────────────────────────────────────────────────

/// 테일스케일 CLI 가 어디 있나.
///
/// tunnel.rs 와 같은 까닭으로 **아는 자리를 먼저 본다** — Finder 에서 켠 앱의 PATH 에는
/// brew 자리가 없다. PATH 는 마지막에 손으로 훑는다(`which` 를 부르지 않는다).
pub fn find_tailscale() -> Option<PathBuf> {
    let known: &[&str] = &[
        // 맥: 앱(스토어판·내려받기판 모두). 이 실행 파일에 인자를 주면 CLI 로 돈다.
        "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
        "/opt/homebrew/bin/tailscale",
        "/usr/local/bin/tailscale",
        "/usr/bin/tailscale",
        "/usr/sbin/tailscale",
        "/snap/bin/tailscale",
        "C:\\Program Files\\Tailscale\\tailscale.exe",
        "C:\\Program Files (x86)\\Tailscale\\tailscale.exe",
    ];
    for p in known {
        let p = PathBuf::from(p);
        if p.is_file() {
            return Some(p);
        }
    }
    let name = if cfg!(windows) { "tailscale.exe" } else { "tailscale" };
    std::env::var_os("PATH").and_then(|paths| {
        std::env::split_paths(&paths).map(|d| d.join(name)).find(|p| p.is_file())
    })
}

// ── 상태 읽기(순수 함수 — 시험 대상) ───────────────────────────────────────

#[derive(Debug, Clone, Default, PartialEq)]
pub struct TsStatus {
    /// `NoState` · `NeedsLogin` · `NeedsMachineAuth` · `Stopped` · `Starting` · `Running`
    pub backend: String,
    /// `Self.DNSName` 끝 점을 뗀 것. 퍼널 주소의 이름이다.
    pub host: Option<String>,
    /// 로그인 기다림이면 테일스케일이 준 주소(`AuthURL`).
    pub auth_url: Option<String>,
    /// `Self.CapMap` 에 퍼널 허락이 보이나. 판에 따라 칸이 없을 수 있어 `None` = 모름.
    pub funnel_allowed: Option<bool>,
}

/// `Self.DNSName`(예: `"shop-mac.tail1234.ts.net."`) → `shop-mac.tail1234.ts.net`.
/// 테일스케일 이름이 아니거나 이상한 글자가 있으면 `None` — 그 이름으로 링크를 만들지 않는다.
pub fn dns_host(dns_name: &str) -> Option<String> {
    let h = dns_name.trim().trim_end_matches('.').to_ascii_lowercase();
    let ok_chars = !h.is_empty()
        && h.len() <= 253
        && h.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-' || c == '.')
        && !h.starts_with(['.', '-'])
        && !h.contains("..");
    (ok_chars && h.ends_with(".ts.net") && h.len() > ".ts.net".len()).then_some(h)
}

/// 퍼널 주소. 경로·포트 없이 이름만 — 443 이 퍼널 자리다.
pub fn funnel_url(host: &str) -> String {
    format!("https://{host}")
}

/// `tailscale status --json` 읽기. JSON 이 아니면 `None`.
pub fn parse_status(text: &str) -> Option<TsStatus> {
    let v: Value = serde_json::from_str(text.trim()).ok()?;
    let me = v.get("Self");
    let backend = v.get("BackendState").and_then(Value::as_str).unwrap_or("").to_string();
    let host = me.and_then(|s| s.get("DNSName")).and_then(Value::as_str).and_then(dns_host);
    let auth_url = v
        .get("AuthURL")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|u| is_login_url(u))
        .map(str::to_string);
    let funnel_allowed = me.and_then(|s| {
        let cap_map = s.get("CapMap").and_then(Value::as_object).map(|m| m.keys().any(|k| is_funnel_cap(k)));
        let caps = s.get("Capabilities").and_then(Value::as_array).map(|a| a.iter().filter_map(Value::as_str).any(is_funnel_cap));
        match (cap_map, caps) {
            (None, None) => None,
            (a, b) => Some(a.unwrap_or(false) || b.unwrap_or(false)),
        }
    });
    Some(TsStatus { backend, host, auth_url, funnel_allowed })
}

fn is_funnel_cap(k: &str) -> bool {
    k == "funnel" || k.starts_with("https://tailscale.com/cap/funnel")
}

fn is_login_url(u: &str) -> bool {
    u.starts_with(LOGIN_PREFIX)
        && u.len() <= 300
        && u.chars().all(|c| c.is_ascii_alphanumeric() || "-._~:/?#[]@!$&'()*+,;=%".contains(c))
        && !u.contains(['\'', '(', ')', '[', ']'])
}

/// CLI 출력에서 첫 로그인·승인 주소를 찾는다(`login.tailscale.com` 만).
pub fn find_login_url(text: &str) -> Option<String> {
    let i = text.find(LOGIN_PREFIX)?;
    let u: String = text[i..].chars().take_while(|c| !c.is_whitespace() && *c != '"' && *c != '<' && *c != '>').collect();
    let u = u.trim_end_matches(['.', ',']).to_string();
    is_login_url(&u).then_some(u)
}

/// 다음에 할 일 — 상태만 보고 정한다.
#[derive(Debug, PartialEq)]
pub enum Step {
    /// 테일스케일이 아직 시작 중. 조금 뒤 다시.
    Starting,
    /// 로그인이 필요하다. 주소를 이미 알면 함께.
    NeedsLogin(Option<String>),
    /// 로그인은 했는데 꺼져 있다.
    Stopped,
    /// 내 테일넷 관리자가 이 컴퓨터를 승인해야 한다.
    NeedsMachineAuth,
    /// 켜져 있는데 이름(MagicDNS)이 없다 — 퍼널 주소를 만들 수 없다.
    NoName,
    /// 퍼널을 켤 차례.
    Funnel(String),
}

pub fn next_step(s: &TsStatus) -> Step {
    match s.backend.as_str() {
        "NeedsLogin" => Step::NeedsLogin(s.auth_url.clone()),
        // NoState 는 처음 깔고 로그인 전이거나 막 켜지는 중이다. 주소가 있으면 로그인.
        "NoState" => if s.auth_url.is_some() { Step::NeedsLogin(s.auth_url.clone()) } else { Step::Starting },
        "Starting" => Step::Starting,
        "Stopped" => Step::Stopped,
        "NeedsMachineAuth" => Step::NeedsMachineAuth,
        "Running" => match &s.host {
            Some(h) => Step::Funnel(h.clone()),
            None => Step::NoName,
        },
        _ => Step::Starting,
    }
}

/// `tailscale funnel --bg 8790` 이 어떻게 끝났나.
#[derive(Debug, PartialEq)]
pub enum FunnelOutcome {
    Started,
    /// 테일넷에서 퍼널(또는 HTTPS 인증서)을 한 번 허락해야 한다 — 그 주소.
    NeedsApproval(String),
    Failed(String),
}

pub fn classify_funnel(output: &str, exited_ok: Option<bool>) -> FunnelOutcome {
    if let Some(u) = find_login_url(output) {
        return FunnelOutcome::NeedsApproval(u);
    }
    match exited_ok {
        Some(true) => FunnelOutcome::Started,
        _ => FunnelOutcome::Failed(short(output)),
    }
}

fn short(s: &str) -> String {
    let s = s.trim();
    let tail: Vec<&str> = s.lines().rev().filter(|l| !l.trim().is_empty()).take(3).collect();
    tail.into_iter().rev().collect::<Vec<_>>().join(" ").chars().take(300).collect()
}

// ── 실행 ──────────────────────────────────────────────────────────────────

struct Run {
    /// 끝났으면 성공 여부, 아직 돌면 `None`.
    exited_ok: Option<bool>,
    out: String,
    /// `stop_at_login_url` 로 일찍 돌아왔을 때 아직 도는 프로세스.
    child: Option<Child>,
}

/// 정해 둔 인자로 실행하고 `limit` 안에 끝나기를 기다린다. 넘으면 끝낸다.
/// `stop_at_login_url` 이면 출력에 로그인·승인 주소가 보이는 순간 **끝내지 않고** 돌려준다 —
/// 사람이 승인하면 그 프로세스가 마저 일을 끝낸다.
fn run(exe: &Path, args: &[&str], limit: Duration, stop_at_login_url: bool) -> Result<Run, String> {
    let mut child = crate::quiet::cmd(exe)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("테일스케일을 실행하지 못했어요: {e}"))?;
    let buf = Arc::new(Mutex::new(String::new()));
    for pipe in [child.stdout.take().map(|p| Box::new(p) as Box<dyn Read + Send>), child.stderr.take().map(|p| Box::new(p) as Box<dyn Read + Send>)]
        .into_iter()
        .flatten()
    {
        let buf = buf.clone();
        std::thread::spawn(move || {
            let mut pipe = pipe;
            let mut chunk = [0u8; 2048];
            while let Ok(n) = pipe.read(&mut chunk) {
                if n == 0 {
                    break;
                }
                if let Ok(mut b) = buf.lock() {
                    if b.len() < 64 * 1024 {
                        b.push_str(&String::from_utf8_lossy(&chunk[..n]));
                    }
                }
            }
        });
    }
    let start = Instant::now();
    let text = |b: &Arc<Mutex<String>>| b.lock().map(|g| g.clone()).unwrap_or_default();
    loop {
        if let Ok(Some(st)) = child.try_wait() {
            // 남은 출력을 다 읽을 틈을 잠깐 준다.
            std::thread::sleep(Duration::from_millis(150));
            return Ok(Run { exited_ok: Some(st.success()), out: text(&buf), child: None });
        }
        if stop_at_login_url && find_login_url(&text(&buf)).is_some() {
            return Ok(Run { exited_ok: None, out: text(&buf), child: Some(child) });
        }
        if start.elapsed() > limit {
            let _ = child.kill();
            let _ = child.wait();
            return Ok(Run { exited_ok: None, out: text(&buf), child: None });
        }
        std::thread::sleep(Duration::from_millis(120));
    }
}

/// 기다리는 프로세스를 맡긴다. 10분이 지나면 끝낸다(남겨 두지 않는다).
fn park(child: Child, kind: &'static str, url: String) {
    if let Ok(mut g) = PENDING.lock() {
        if let Some(mut old) = g.take() {
            let _ = old.child.kill();
            let _ = old.child.wait();
        }
        *g = Some(Pending { child, kind, url });
    }
    std::thread::spawn(move || {
        std::thread::sleep(PENDING_LIMIT);
        if let Ok(mut g) = PENDING.lock() {
            if g.as_ref().is_some_and(|p| p.kind == kind) {
                if let Some(mut p) = g.take() {
                    let _ = p.child.kill();
                    let _ = p.child.wait();
                }
            }
        }
    });
}

/// 아직 승인을 기다리는 중인 그 일의 주소. 끝났으면 치우고 `None`.
fn pending_url(kind: &str) -> Option<String> {
    let mut g = PENDING.lock().ok()?;
    let alive = match g.as_mut() {
        Some(p) if p.kind == kind => matches!(p.child.try_wait(), Ok(None)),
        _ => return None,
    };
    if alive {
        g.as_ref().map(|p| p.url.clone())
    } else {
        *g = None;
        None
    }
}

fn drop_pending() {
    if let Ok(mut g) = PENDING.lock() {
        if let Some(mut p) = g.take() {
            let _ = p.child.kill();
            let _ = p.child.wait();
        }
    }
}

fn remember_url(u: &str) {
    if let Ok(mut g) = LAST_URL.lock() {
        *g = Some(u.to_string());
    }
}

fn state(s: &str) -> Value {
    json!({ "state": s })
}

fn read_status(exe: &Path) -> Result<TsStatus, Value> {
    let r = run(exe, &STATUS_ARGS, Duration::from_secs(10), false).map_err(|e| json!({ "state": "failed", "detail": e }))?;
    // 꺼져 있어도 `status --json` 은 JSON 을 낼 때가 있다(BackendState: Stopped 등). 먼저 읽어 본다.
    if let Some(s) = parse_status(&r.out) {
        return Ok(s);
    }
    // JSON 이 아니면 테일스케일 자체가 안 돌고 있다(맥 앱이 꺼짐 · tailscaled 없음).
    Err(json!({ "state": "not_running", "detail": short(&r.out) }))
}

/// 한 걸음 — 지금 할 수 있는 데까지 하고, 사람이 할 일이 있으면 그 자리에서 멈춘다.
fn setup_step() -> Value {
    let Some(exe) = find_tailscale() else {
        return state("not_installed");
    };
    let st = match read_status(&exe) {
        Ok(s) => s,
        Err(v) => return v,
    };
    match next_step(&st) {
        Step::Starting => state("starting"),
        Step::Stopped => {
            // 로그인은 돼 있고 꺼져만 있다 — 켜 본다. 예전에 다른 설정으로 켰으면 `up` 이
            // 거절하는데, 그때는 사람에게 앱에서 켜 달라고 한다.
            match run(&exe, &UP_ARGS, Duration::from_secs(20), true) {
                Ok(r) if r.exited_ok == Some(true) => state("starting"),
                Ok(r) => match (find_login_url(&r.out), r.child) {
                    (Some(u), Some(c)) => {
                        remember_url(&u);
                        park(c, "login", u);
                        state("needs_login")
                    }
                    _ => state("stopped"),
                },
                Err(_) => state("stopped"),
            }
        }
        Step::NeedsMachineAuth => state("needs_machine_auth"),
        Step::NoName => state("no_name"),
        Step::NeedsLogin(known) => {
            if pending_url("login").is_some() {
                return state("needs_login");
            }
            if let Some(u) = known {
                remember_url(&u);
                return state("needs_login");
            }
            match run(&exe, &LOGIN_ARGS, Duration::from_secs(20), true) {
                Ok(Run { child: Some(c), out, .. }) => {
                    let u = find_login_url(&out).unwrap_or_default();
                    remember_url(&u);
                    park(c, "login", u);
                    state("needs_login")
                }
                // 이미 로그인돼 바로 끝났으면 다음 걸음에서 이어 간다.
                Ok(Run { exited_ok: Some(true), .. }) => state("starting"),
                // 맥·윈도우 앱은 CLI 가 주소를 안 낼 수도 있다 — 앱에서 로그인하게 한다.
                _ => state("needs_login_app"),
            }
        }
        Step::Funnel(host) => {
            drop_login_if_any();
            if pending_url("funnel").is_some() {
                return state("needs_funnel");
            }
            match run(&exe, &FUNNEL_ON_ARGS, Duration::from_secs(30), true) {
                Ok(r) => match classify_funnel(&r.out, r.exited_ok) {
                    FunnelOutcome::Started => json!({ "state": "funnel_on", "url": funnel_url(&host) }),
                    FunnelOutcome::NeedsApproval(u) => {
                        remember_url(&u);
                        if let Some(c) = r.child {
                            park(c, "funnel", u);
                        }
                        state("needs_funnel")
                    }
                    FunnelOutcome::Failed(d) => json!({ "state": "failed", "detail": d }),
                },
                Err(e) => json!({ "state": "failed", "detail": e }),
            }
        }
    }
}

fn drop_login_if_any() {
    if let Ok(g) = PENDING.lock() {
        if !g.as_ref().is_some_and(|p| p.kind == "login") {
            return;
        }
    }
    drop_pending();
}

/// 그 주소로 정말 대답이 오나. 처음 켜면 인증서를 받느라 수십 초 걸릴 수 있어 몇 번 본다.
/// 500 미만이면 가게 문까지 닿은 것이다(502 = 퍼널은 됐지만 8790 이 안 받음).
async fn answers(url: &str) -> bool {
    let Ok(client) = reqwest::Client::builder()
        .timeout(Duration::from_secs(12))
        .redirect(reqwest::redirect::Policy::none())
        .build()
    else {
        return false;
    };
    for i in 0..5 {
        if i > 0 {
            tokio::time::sleep(Duration::from_secs(4)).await;
        }
        if let Ok(r) = client.get(url).send().await {
            if r.status().as_u16() < 500 {
                return true;
            }
        }
    }
    false
}

/// [테일스케일로 고정 주소 만들기] — 한 번 부를 때마다 한 걸음.
///
/// 돌려주는 `state`:
/// `not_installed` · `not_running` · `starting` · `stopped` · `needs_login` · `needs_login_app` ·
/// `needs_machine_auth` · `no_name` · `needs_funnel` · `not_answering` · `ready` · `failed`.
/// `ready` 면 `url` 과, 이미 지도에 올린 가게면 새 주소로 다시 올렸는지(`published`).
///
/// 🔴 화면 스레드를 막지 않는다 — CLI 는 블로킹 스레드에서, 확인은 비동기로.
#[tauri::command]
pub async fn tailscale_fixed_setup() -> Value {
    let step = tauri::async_runtime::spawn_blocking(setup_step)
        .await
        .unwrap_or_else(|e| json!({ "state": "failed", "detail": e.to_string() }));
    if step["state"] != "funnel_on" {
        return step;
    }
    let url = step["url"].as_str().unwrap_or("").to_string();
    if !answers(&url).await {
        return json!({ "state": "not_answering", "url": url });
    }
    let published = crate::map::adopt_fixed_shop_url(&url).unwrap_or(false);
    json!({ "state": "ready", "url": url, "published": published })
}

/// [끄기] — 가게 문 퍼널만 닫는다.
#[tauri::command]
pub async fn tailscale_funnel_off() -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let exe = find_tailscale().ok_or_else(|| "테일스케일이 이 컴퓨터에 없어요.".to_string())?;
        drop_pending();
        let first = run(&exe, &FUNNEL_OFF_ARGS, Duration::from_secs(20), false)?;
        if first.exited_ok != Some(true) {
            let second = run(&exe, &FUNNEL_OFF_FALLBACK_ARGS, Duration::from_secs(20), false)?;
            if second.exited_ok != Some(true) {
                return Err(format!("끄지 못했어요: {}", short(&second.out)));
            }
        }
        Ok(json!({ "ok": true }))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 사람이 할 일이 있는 곳을 브라우저(또는 테일스케일 앱)로 연다.
/// `target` 은 이름뿐이다 — 주소는 여기서 정한다(받은 글을 그대로 열지 않는다).
#[tauri::command(async)]
pub fn tailscale_open(target: String) -> Result<(), String> {
    let url = match target.as_str() {
        "download" => DOWNLOAD_URL.to_string(),
        "machines" => ADMIN_MACHINES_URL.to_string(),
        "dns" => ADMIN_DNS_URL.to_string(),
        "login" | "approve" => LAST_URL
            .lock()
            .ok()
            .and_then(|g| g.clone())
            .filter(|u| is_login_url(u))
            .ok_or_else(|| "열 주소가 아직 없어요. 다시 눌러 주세요.".to_string())?,
        "app" => return open_app(),
        _ => return Err("이 주소는 열 수 없습니다.".into()),
    };
    open::that(&url).map_err(|e| format!("브라우저를 열지 못했어요: {e}"))
}

fn open_app() -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        crate::quiet::cmd("/usr/bin/open").args(["-a", "Tailscale"]).status().map(|_| ()).map_err(|e| e.to_string())
    }
    #[cfg(target_os = "windows")]
    {
        let p = "C:\\Program Files\\Tailscale\\tailscale-ipn.exe";
        crate::quiet::cmd(p).spawn().map(|_| ()).map_err(|e| e.to_string())
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        Err("테일스케일을 켜 주세요.".into())
    }
}

pub fn stop_on_exit() {
    drop_pending();
}

#[cfg(test)]
mod tests {
    use super::*;

    const RUNNING: &str = r#"{
      "Version": "1.76.1", "BackendState": "Running", "AuthURL": "",
      "Self": { "DNSName": "Shop-Mac.tail1234.ts.net.", "TailscaleIPs": ["100.101.102.103"],
                "CapMap": { "https": null, "funnel": null, "https://tailscale.com/cap/funnel-ports?ports=443,8443,10000": null } },
      "CurrentTailnet": { "Name": "me@example.com", "MagicDNSSuffix": "tail1234.ts.net", "MagicDNSEnabled": true }
    }"#;

    #[test]
    fn 이름_끝의_점을_떼고_퍼널_주소를_만든다() {
        let s = parse_status(RUNNING).unwrap();
        assert_eq!(s.backend, "Running");
        assert_eq!(s.host.as_deref(), Some("shop-mac.tail1234.ts.net"));
        assert_eq!(s.funnel_allowed, Some(true));
        assert_eq!(next_step(&s), Step::Funnel("shop-mac.tail1234.ts.net".into()));
        assert_eq!(funnel_url("shop-mac.tail1234.ts.net"), "https://shop-mac.tail1234.ts.net");
    }

    #[test]
    fn 로그아웃이면_로그인부터() {
        let t = r#"{"BackendState":"NeedsLogin","AuthURL":"https://login.tailscale.com/a/1a2b3c4d","Self":{"DNSName":""}}"#;
        let s = parse_status(t).unwrap();
        assert_eq!(s.host, None);
        assert_eq!(next_step(&s), Step::NeedsLogin(Some("https://login.tailscale.com/a/1a2b3c4d".into())));
        // 로그인 주소가 아직 없을 때
        let s = parse_status(r#"{"BackendState":"NeedsLogin","AuthURL":"","Self":null}"#).unwrap();
        assert_eq!(next_step(&s), Step::NeedsLogin(None));
        // 처음 깐 직후(NoState)
        let s = parse_status(r#"{"BackendState":"NoState"}"#).unwrap();
        assert_eq!(next_step(&s), Step::Starting);
        assert_eq!(next_step(&parse_status(r#"{"BackendState":"Stopped","Self":{"DNSName":"a.tail1.ts.net."}}"#).unwrap()), Step::Stopped);
        assert_eq!(next_step(&parse_status(r#"{"BackendState":"NeedsMachineAuth"}"#).unwrap()), Step::NeedsMachineAuth);
    }

    #[test]
    fn 남의_주소는_로그인_주소로_안_받는다() {
        let t = r#"{"BackendState":"NeedsLogin","AuthURL":"https://evil.example/a/1"}"#;
        assert_eq!(parse_status(t).unwrap().auth_url, None);
        assert_eq!(find_login_url("visit https://login.tailscale.com.evil.example/x"), None);
        assert_eq!(find_login_url("no url here"), None);
    }

    #[test]
    fn 퍼널_허락이_없으면_승인_주소를_찾는다() {
        let s = parse_status(r#"{"BackendState":"Running","Self":{"DNSName":"pc.tail9.ts.net.","CapMap":{"https":null}}}"#).unwrap();
        assert_eq!(s.funnel_allowed, Some(false));
        // 그래도 다음 걸음은 퍼널 — 승인 주소는 CLI 가 알려 준다.
        assert_eq!(next_step(&s), Step::Funnel("pc.tail9.ts.net".into()));
        let out = "Funnel is not enabled on your tailnet.\nTo enable, visit:\n\n         https://login.tailscale.com/f/funnel?node=nXyZ123CNTRL\n\n";
        assert_eq!(
            classify_funnel(out, None),
            FunnelOutcome::NeedsApproval("https://login.tailscale.com/f/funnel?node=nXyZ123CNTRL".into())
        );
        let ok = "Available on the internet:\n\nhttps://pc.tail9.ts.net/\n|-- proxy http://127.0.0.1:8790\n\nFunnel started and running in the background.\n";
        assert_eq!(classify_funnel(ok, Some(true)), FunnelOutcome::Started);
        assert!(matches!(classify_funnel("error: something", Some(false)), FunnelOutcome::Failed(_)));
        // 칸이 아예 없는 옛 판 = 모름
        assert_eq!(parse_status(r#"{"BackendState":"Running","Self":{"DNSName":"pc.tail9.ts.net."}}"#).unwrap().funnel_allowed, None);
    }

    #[test]
    fn 이름이_없거나_이상하면_링크를_안_만든다() {
        let s = parse_status(r#"{"BackendState":"Running","Self":{"DNSName":""}}"#).unwrap();
        assert_eq!(next_step(&s), Step::NoName);
        assert_eq!(dns_host("100.64.0.1"), None, "100.x 주소는 손님에게 안 열린다");
        assert_eq!(dns_host("pc.local."), None);
        assert_eq!(dns_host("ts.net."), None);
        assert_eq!(dns_host("a b.tail1.ts.net."), None);
        assert_eq!(dns_host("x.tail1.ts.net/evil."), None);
        assert_eq!(dns_host("pc.tail1.ts.net"), Some("pc.tail1.ts.net".into()));
        assert_eq!(parse_status("failed to connect to local tailscaled"), None);
    }

    /// 퍼널 주소는 「임시 주소예요」 경고를 띄우지 않는다(map_check 의 temporary_url).
    #[test]
    fn 퍼널_주소는_임시_주소가_아니다() {
        let u = funnel_url("shop-mac.tail1234.ts.net");
        assert!(crate::map_format::is_shop_url(&u));
        assert!(!crate::map_format::is_temporary_url(&u));
        assert!(crate::map_format::is_temporary_url("https://abc-def.trycloudflare.com"));
    }

    /// 명령줄은 고정이다 — 가게 문(8790)만, 셸 없이.
    #[test]
    fn args_are_fixed() {
        assert_eq!(FUNNEL_ON_ARGS, ["funnel", "--bg", "8790"]);
        assert_eq!(FUNNEL_ON_ARGS[2], SHOP_PORT.to_string());
        assert_eq!(FUNNEL_OFF_ARGS, ["funnel", "8790", "off"]);
        assert_eq!(STATUS_ARGS, ["status", "--json"]);
        let src = include_str!("tailscale.rs");
        let body = &src[..src.find("#[cfg(test)]").unwrap()];
        assert!(!body.contains("\"sh\"") && !body.contains("\"-c\"") && !body.contains("cmd.exe") && !body.contains("powershell"), "셸을 거치지 않는다");
        assert!(!body.contains("funnel\", \"reset"), "reset 은 남의 공유까지 지운다");
        // 실행은 run() 한 곳뿐이고, 인자는 위의 상수만 들어간다.
        for line in body.lines().filter(|l| l.contains("run(&exe,")) {
            assert!(line.contains("_ARGS"), "고정 인자만: {line}");
        }
        // 여는 주소는 이름으로만 고른다.
        assert!(tailscale_open("https://evil.example".into()).is_err());
    }
}
