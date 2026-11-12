//! Talks to a local ravend over JSON-RPC.
//!
//! Authentication uses the .cookie file the node writes on startup rather than a
//! username and password in a config file. The cookie is regenerated every run
//! and is readable only by the user, so nothing has to be stored anywhere and
//! there is no credential to leak.

use serde::Deserialize;
use serde_json::{json, Value};
use std::path::PathBuf;

/// 레이븐 기본 RPC 포트.
const RPC_PORT_DEFAULT: u16 = 8766;

/// 노드에 말 거는 주소.
///
/// 🔴 여기가 `http://127.0.0.1:8766` 으로 **못 박혀** 있었다. 그런데
/// `rpcuser`·`rpcpassword` 를 적어 둘 정도로 손을 본 사람은 `rpcport` 도
/// 바꿔 뒀을 수 있다(채굴기·다른 지갑과 겹치지 않게 옮기는 일이 흔하다).
///
/// 그러면 노드가 멀쩡히 떠 있어도 우리는 빈 포트를 두드리고, 화면에는
/// 「노드가 꺼져 있습니다」가 뜬다. 설정 파일이 말하는 자리로 간다.
fn rpc_url() -> String {
    let port = conf_value("rpcport")
        .and_then(|v| v.parse::<u16>().ok())
        .unwrap_or(RPC_PORT_DEFAULT);
    format!("http://127.0.0.1:{port}")
}

/// `raven.conf` 에서 값 하나를 읽는다. 주석(`#`)으로 죽여 둔 줄은 안 본다.
fn conf_value(key: &str) -> Option<String> {
    let txt = std::fs::read_to_string(data_dir().join("raven.conf")).ok()?;
    txt.lines()
        .map(|l| l.trim())
        .filter(|l| !l.starts_with('#'))
        .find_map(|l| {
            let (k, v) = l.split_once('=')?;
            (k.trim() == key).then(|| v.trim().to_string())
        })
        .filter(|v| !v.is_empty())
}

/// One asset the wallet holds, with whatever IPFS content it points at.
#[derive(Debug, Clone, serde::Serialize)]
pub struct AssetEntry {
    pub name: String,
    pub amount: f64,
    pub ipfs_hash: Option<String>,
    /// Did this wallet issue it?
    ///
    /// Ravencoin answers this exactly: issuing mints an owner token named
    /// `ASSET!`, and only the issuer holds it. So holding `PLAYX!` means PLAYX
    /// is ours; holding only `PLAYX` means somebody sent it to us. This matters
    /// because anyone can send anything to any address — a wallet fills up with
    /// tokens nobody asked for, and they should not sit in the same list as the
    /// things the owner made.
    pub mine: bool,
    /// The part before the first `/` — what groups a family of assets together.
    pub root: String,
    /// 🔴 **쪼갤 수 있는 자릿수.** 0 이면 통째로만 오간다.
    ///
    /// 코어 지갑은 이 값을 들고 있는데(`assetrecord.h` 의 `units`) 우리는
    /// 안 들고 있었다. 그래서 **`SHOP.PLAYX` 가 1개·단위 0 으로 찍혀 손님
    /// 에게 나눠 줄 수 없다는 사실이 화면 어디에도 없었다.** 팔로우가 왜
    /// 성립 안 하는지 사장이 알 길이 없었던 것이다.
    ///
    /// 못 읽었으면 `None` — 0 으로 채우면 「쪼갤 수 없음」이라고 거짓말한다.
    pub units: Option<i64>,
    /// 🔴 **더 찍고 붙은 파일을 바꿀 수 있는가.**
    ///
    /// `false` 면 프로필을 **영영** 못 바꾼다. 100 RVN 을 태우기 전에
    /// 알아야 하는 값인데 코어 지갑도 이걸 목록에 안 보여 준다.
    pub reissuable: Option<bool>,
}

fn data_dir() -> PathBuf {
    // Only macOS for now; Windows and Linux use different conventions and are
    // added when those builds happen.
    crate::paths::raven_dir()
}

/// 노드에 붙을 때 쓸 `사용자:암호`.
///
/// ## 🔴 `.cookie` 하나만 보면 안 된다
///
/// 코어는 `raven.conf` 에 `rpcuser`·`rpcpassword` 가 **없을 때만** `.cookie` 를
/// 만든다. 그런데 레이븐 코어를 오래 쓴 사람은 그 둘을 적어 둔 경우가 많다
/// (지갑 프로그램·채굴기·스크립트를 붙이려면 그렇게 한다).
///
/// 그러면 노드가 **멀쩡히 떠 있어도** 우리는 영원히 못 붙는다. 화면에는
/// 「노드가 꺼져 있습니다」가 뜨고, 「지금 켜기」를 눌러도 아무 일도 안
/// 일어난다 — 이미 돌고 있으니 켤 것이 없기 때문이다. 사장은 왜 안 되는지
/// 알 길이 없다. 실측으로 이 상태를 만났다(2026-08-26).
///
/// 그래서 **둘 다 본다.** 쿠키가 먼저고, 없으면 설정 파일을 읽는다.
fn read_cookie() -> Result<String, String> {
    let path = data_dir().join(".cookie");
    if let Ok(v) = std::fs::read_to_string(&path) {
        let v = v.trim().to_string();
        if !v.is_empty() {
            return Ok(v);
        }
    }
    // 설정 파일에 적어 둔 것이 있으면 그걸 쓴다.
    if let Some((u, p)) = conf_rpc_auth() {
        return Ok(format!("{u}:{p}"));
    }
    Err(format!(
        "Could not read {}, and raven.conf has no rpcuser/rpcpassword. \
         The node is probably not running, or was started without server=1.",
        path.display()
    ))
}

/// `raven.conf` 의 `rpcuser`·`rpcpassword`. 둘 다 있어야 쓸모가 있다.
fn conf_rpc_auth() -> Option<(String, String)> {
    Some((conf_value("rpcuser")?, conf_value("rpcpassword")?))
}

/// Shared JSON-RPC entry point. Public so sibling modules (issue, shop) do not
/// each grow their own copy of the cookie handling.
/// How long to wait for the node before giving up.
///
/// Long enough for the slow honest calls — `listtransactions` on a big wallet,
/// `listassets` with a wide prefix — and short enough that a wedged node shows
/// an error instead of a screen that says "확인 중…" until someone force-quits.
const RPC_TIMEOUT_SECS: u64 = 20;

/// 코인·자산이 움직이는 부름. 노드가 거래를 만들고 서명하고 퍼뜨리느라 20초를
/// 넘길 수 있다(지갑이 크거나, 따라잡는 중이거나).
///
/// 🔴 20초에 끊으면 **노드는 이미 보냈는데 화면은 「실패」**라고 했다. 사장은 다시
///    눌렀고, 같은 묶음이 두 번 태워졌다(0.4.5 검수 S5 — 최대 250 RVN 두 번).
///    그래서 이 부름들은 길게 기다리고, 그래도 시간이 넘으면 「실패」가 아니라
///    **「보냈는지 모름」**(`SENT_UNKNOWN: `)으로 돌려준다. 부르는 쪽은 그 말을 보면
///    다시 보내지 말고 체인·지갑에서 확인해야 한다.
const SEND_METHODS: &[&str] = &[
    "issue", "issueunique", "reissue", "transfer", "transferfromaddress", "transferfromaddresses",
    "sendtoaddress", "sendmany", "sendfromaddress", "sendrawtransaction",
    "issuequalifierasset", "issuerestrictedasset", "reissuerestrictedasset", "transferqualifier",
    "addtagtoaddress", "removetagfromaddress", "freezeaddress", "unfreezeaddress",
    "freezerestrictedasset", "unfreezerestrictedasset",
];
pub const SEND_TIMEOUT_SECS: u64 = 180;
/// 보냈는지 모를 때 오류 글자 앞에 붙는다. 화면·기록이 이것을 보고 다시 보내기를 막는다.
pub const SENT_UNKNOWN: &str = "SENT_UNKNOWN: ";

pub(crate) fn is_send_method(method: &str) -> bool {
    SEND_METHODS.contains(&method)
}

fn sent_unknown_message(method: &str, secs: u64) -> String {
    format!(
        "{SENT_UNKNOWN}노드가 {secs}초 안에 답하지 않았어요 ({method}). 보냈는지 아직 몰라요 — 기록될 때까지 기다려 주세요. 같은 것을 다시 보내지 마세요."
    )
}

/// One HTTP client for the whole app.
///
/// `Client::new()` per call built a fresh connection pool every time and threw
/// it away, so nothing was ever reused and every call paid for a new socket.
static CLIENT: std::sync::OnceLock<reqwest::Client> = std::sync::OnceLock::new();

fn client() -> &'static reqwest::Client {
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(RPC_TIMEOUT_SECS))
            .pool_idle_timeout(std::time::Duration::from_secs(90))
            .build()
            .unwrap_or_default()
    })
}

/// Caps how many requests are in flight at once, to the node's own thread count.
static GATE: std::sync::OnceLock<tokio::sync::Semaphore> = std::sync::OnceLock::new();

fn rpc_gate() -> &'static tokio::sync::Semaphore {
    GATE.get_or_init(|| tokio::sync::Semaphore::new(4))
}

#[derive(Debug)]
pub(crate) struct RpcFailure {
    pub code: Option<i64>,
    pub message: String,
}
impl From<String> for RpcFailure {
    fn from(message: String) -> Self { Self { code: None, message } }
}
impl From<&str> for RpcFailure {
    fn from(message: &str) -> Self { message.to_string().into() }
}

pub async fn call_rpc(method: &str, params: Value) -> Result<Value, String> {
    call_rpc_detailed(method, params).await.map_err(|error| error.message)
}

/// Preserve numeric RPC error codes for public chain adapters without exposing
/// node credentials, configuration paths, or raw RPC errors to browsers.
pub(crate) async fn call_rpc_detailed(method: &str, params: Value) -> Result<Value, RpcFailure> {
    call_rpc_inner(method, params, None).await
}

/// 화면이 **상태만** 물을 때 쓰는 짧은 부름(11-12).
///
/// 🔴 노드가 켜지는 중이거나 바쁘면 보통 부름은 대기열(`rpc_gate`, 넷)에서 기다리고 20초를 채운다.
///    그 사이 화면의 상태 질문(노드 상태·지갑 잠금·앱 잠금·잔액)이 전부 줄을 서서, 「문제 알리기」의
///    진단은 넷 다 1.5초 시간 초과였다(윈도우 0.9.35 신고). 화면은 멈춘 것처럼 보이고 노드는 「꺼짐」으로 읽혔다.
///
///    여기서는 줄을 `QUICK_GATE_MS` 넘게 서지 않고, 답도 `ms` 만 기다린다. 못 받으면 **이유를 가른다**:
///    연결 자체가 거부됐으면 `CODE_DOWN`(꺼짐), 연결은 됐는데 답이 늦으면 `CODE_BUSY`(살아 있고 바쁨).
///    ⚠️ 윈도우는 닫힌 포트에 붙을 때 거부를 받기까지 약 2초가 걸린다 — 그래서 `ms` 는 3초보다 짧게 잡지 않는다.
///    보내는 부름(`SEND_METHODS`)은 여기로 오면 안 되고, 와도 짧게 끊지 않는다.
pub(crate) async fn call_rpc_quick(method: &str, params: Value, ms: u64) -> Result<Value, RpcFailure> {
    call_rpc_inner(method, params, Some(std::time::Duration::from_millis(ms))).await
}

/// 줄 서기를 이만큼만 기다린다(짧은 부름).
const QUICK_GATE_MS: u64 = 1000;
/// 짧은 부름의 기본 답 기다림. 윈도우의 연결 거부(약 2초)보다 길게.
pub(crate) const QUICK_MS: u64 = 3000;
/// 짧은 부름이 답을 못 받았다 — 연결은 됐다(살아 있고 바쁘거나 켜지는 중).
pub(crate) const CODE_BUSY: i64 = -90_001;
/// 짧은 부름이 노드에 닿지도 못했다(꺼져 있다).
pub(crate) const CODE_DOWN: i64 = -90_002;
/// 바쁠 때 화면에 가는 말. 화면의 `isWarming` 이 「노드가 바빠」를 알아본다.
pub(crate) const BUSY_SAY: &str = "노드가 바빠서 바로 답하지 못했어요. 켜지는 중이거나 장부를 따라잡는 중일 수 있어요.";

async fn call_rpc_inner(method: &str, params: Value, quick: Option<std::time::Duration>) -> Result<Value, RpcFailure> {
    let quick = quick.filter(|_| !is_send_method(method));
    let _transfer = if is_send_method(method) { Some(crate::ravi_lifecycle::begin_transfer()?) } else { None };
    #[cfg(test)]
    { let _ = (method, params, quick); return Err("Synthetic lib tests cannot access a live node; inject a mock RPC backend".into()); }
    #[cfg(not(test))]
    {
    // 🔴 0.4.9 — 지갑을 되살리며 옛 거래를 찾는 동안(`rescanblockchain`) 코어는 `cs_main` 을
    //    쥐고 있어 거의 모든 질문이 20초 뒤 시간 초과로 끝난다. 그 사이 주기 질문 네 개가
    //    대기열(`rpc_gate`)을 막고, 화면은 「노드가 답하지 않습니다」로 고장처럼 보인다.
    //    그래서 **묻지 않고 바로** 「되살리는 중」이라고 답한다. 멈추기·끄기만 지나간다.
    if crate::words_restore::rescanning() && !matches!(method, "abortrescan" | "stop") {
        return Err(crate::words_restore::RESCANNING_SAY.into());
    }
    let cookie = read_cookie()?;
    let (user, pass) = cookie
        .split_once(':')
        .ok_or_else(|| "Malformed .cookie file".to_string())?;

    let body = json!({
        "jsonrpc": "1.0",
        "id": "raven-studio",
        "method": method,
        "params": params,
    });

    // 노드는 RPC 스레드 4개, 대기열 16개로 돈다(httpserver.h). 그보다 많이
    // 쏘면 노드가 500으로 버리고, 우리는 그것을 "노드가 죽었다"로 읽는다.
    // 그래서 동시에 4개까지만 보낸다 — 줄 서는 쪽이 우리가 되게 한다.
    let _permit = match quick {
        // 짧은 부름은 줄을 오래 서지 않는다. 줄이 길다는 것은 앞선 부름들이 노드에서 늦고 있다는 뜻 — 바쁨이다.
        Some(_) => match tokio::time::timeout(std::time::Duration::from_millis(QUICK_GATE_MS), rpc_gate().acquire()).await {
            Ok(p) => p.map_err(|e| e.to_string())?,
            Err(_) => return Err(RpcFailure { code: Some(CODE_BUSY), message: BUSY_SAY.into() }),
        },
        None => rpc_gate().acquire().await.map_err(|e| e.to_string())?,
    };

    let send = is_send_method(method);
    let secs = if send { SEND_TIMEOUT_SECS } else { RPC_TIMEOUT_SECS };
    let wait = quick.unwrap_or(std::time::Duration::from_secs(secs));
    let response = client()
        .post(rpc_url())
        .basic_auth(user, Some(pass))
        .json(&body)
        .timeout(wait)
        .send()
        .await
        .map_err(|e| {
            if quick.is_some() {
                // 시간 초과가 먼저다 — 연결 도중 시간이 다 됐으면 닿았는지 모르므로 「바쁨」으로 둔다.
                return if e.is_timeout() {
                    RpcFailure { code: Some(CODE_BUSY), message: BUSY_SAY.into() }
                } else if e.is_connect() {
                    RpcFailure { code: Some(CODE_DOWN), message: format!("노드에 닿지 못했습니다 ({}): {e}", rpc_url()) }
                } else {
                    RpcFailure::from(format!("노드에 닿지 못했습니다 ({}): {e}", rpc_url()))
                };
            }
            // 닿지도 못했으면(연결 거부) 안 보낸 것이 확실하다. 그 밖에 보내는 부름이
            // 도중에 끊기면 노드가 받았는지 모른다.
            RpcFailure::from(if send && !e.is_connect() {
                sent_unknown_message(method, secs)
            } else if e.is_timeout() {
                // 타임아웃이 없던 시절, 노드가 한 번 늦으면 화면이 "확인 중…"에서
                // 영영 멈췄다. 멈춘 화면은 고장난 화면과 구별되지 않는다.
                format!("노드가 {RPC_TIMEOUT_SECS}초 안에 답하지 않았습니다 ({method}). 따라잡는 중이거나 바쁠 수 있습니다.")
            } else {
                format!("노드에 닿지 못했습니다 ({}): {e}", rpc_url())
            })
        })?;

    // 인증에서 막힌 답(401·403)은 노드가 부름을 읽지도 않은 것이다 — 모름이 아니다.
    let refused = matches!(response.status().as_u16(), 401 | 403);
    let parsed: Value = response.json().await.map_err(|e| {
        if quick.is_some() && e.is_timeout() {
            return RpcFailure { code: Some(CODE_BUSY), message: BUSY_SAY.into() };
        }
        RpcFailure::from(if send && !refused {
            // 답을 받다가 끊겼다 — 노드는 이미 보냈을 수 있다.
            sent_unknown_message(method, secs)
        } else {
            format!("Node returned something that is not JSON: {e}")
        })
    })?;

    // A JSON-RPC error arrives with HTTP 500 and a populated "error" field, so
    // surface the node's own message instead of a status code.
    if let Some(err) = parsed.get("error") {
        if !err.is_null() {
            let msg = err
                .get("message")
                .and_then(Value::as_str)
                .unwrap_or("unknown error");
            // 🔴 코어가 「THIS COMMAND IS NOT YET ACTIVE!」 라고 답하면 그건
            //    **자산 색인이 꺼져 있다**는 뜻이다. 그런데 그 답에는 명령
            //    사용법이 통째로 딸려 와서, 화면에 영어 열 줄이 쏟아졌다.
            //    사장은 그게 오류인지 설명인지도 모른다. 실측으로 봤다.
            //
            //    할 수 있는 일이 적힌 한 문장으로 바꾼다.
            if msg.contains("NOT YET ACTIVE") {
                return Err(
                    "자산 색인이 꺼져 있습니다. 「이 컴퓨터 → RVN 노드」에서 색인을 켜면 \
                     회원권·표·굿즈가 보입니다. 한 번 켜면 장부를 다시 훑느라 몇 시간 걸립니다."
                        .into(),
                );
            }
            return Err(RpcFailure { code: err.get("code").and_then(Value::as_i64), message: format!("{method}: {msg}") });
        }
    }

    if let Some(result) = parsed.get("result") { crate::ravi_companion::observe_rpc(method, result); }
    Ok(parsed
        .get("result")
        .cloned()
        .ok_or_else(|| format!("{method}: response had no result"))?)
    }
}

/// Secret-bearing local RPC. Fixed allowlist, no observer/logging/raw errors;
/// owned JSON buffers are wiped before release. Never exposed as a Tauri command.
pub(crate) async fn sales_secret_rpc(method: &str, mut params: Value) -> Result<Value, String> {
    fn wipe(v: &mut Value) {
        match v {
            Value::String(s) => crate::words::wipe(s),
            Value::Array(a) => a.iter_mut().for_each(wipe),
            Value::Object(o) => o.values_mut().for_each(wipe),
            _ => {}
        }
    }
    struct Body(Vec<u8>);
    impl Drop for Body { fn drop(&mut self) { crate::words::wipe_bytes(&mut self.0); } }
    if !matches!(method, "walletpassphrase" | "getmywords") {
        wipe(&mut params); return Err("판매 계정 인증 실패".into());
    }
    #[cfg(test)]
    { wipe(&mut params); return Err("Synthetic tests cannot access a live node".into()); }
    #[cfg(not(test))]
    {
        let mut value = json!({"jsonrpc":"1.0","id":"sales","method":method});
        value["params"] = params.take();
        let encoded = serde_json::to_vec(&value);
        wipe(&mut value);
        let mut body = Body(encoded.map_err(|_| "판매 계정 인증 실패")?);
        let mut cookie = read_cookie().map_err(|_| "판매 계정 인증 실패")?;
        let auth = cookie.split_once(':').ok_or("판매 계정 인증 실패")?;
        let request = client().post(rpc_url()).basic_auth(auth.0, Some(auth.1))
            .header("Content-Type", "application/json").body(body.0.clone())
            .timeout(std::time::Duration::from_secs(15));
        crate::words::wipe(&mut cookie);
        crate::words::wipe_bytes(&mut body.0);
        let response = request.send().await.map_err(|_| "판매 계정 인증 실패")?;
        let mut bytes = Body(response.bytes().await.map_err(|_| "판매 계정 인증 실패")?.to_vec());
        let parsed = serde_json::from_slice::<Value>(&bytes.0);
        crate::words::wipe_bytes(&mut bytes.0);
        let mut parsed = parsed.map_err(|_| "판매 계정 인증 실패")?;
        if !parsed["error"].is_null() { wipe(&mut parsed); return Err("판매 계정 인증 실패".into()); }
        let result = parsed.get_mut("result").map(Value::take).ok_or("판매 계정 인증 실패")?;
        wipe(&mut parsed);
        Ok(result)
    }
}

/// 오래 걸리는 부름 하나(0.4.9 — `rescanblockchain`). 몇 시간이 걸릴 수 있다.
///
/// 🔴 위 `call_rpc` 와 다른 점 둘: ① 되살리는 중 문을 거치지 않는다(이 부름이 바로 그 일이다)
///    ② 동시에 넷까지의 대기열(`rpc_gate`)을 **쥐지 않는다** — 몇 시간 동안 한 자리를 막으면
///    나머지 화면이 셋으로 버틴다. 끊겨도 노드 안의 훑기는 계속되므로, 부르는 쪽이
///    `debug.log` 와 뒤이은 질문으로 끝났는지 판단한다(words_restore.rs).
pub(crate) async fn call_rpc_long(method: &str, params: Value, secs: u64) -> Result<Value, String> {
    #[cfg(test)]
    { let _ = (method, params, secs); return Err("Synthetic lib tests cannot access a live node".into()); }
    #[cfg(not(test))]
    {
    let cookie = read_cookie()?;
    let (user, pass) = cookie
        .split_once(':')
        .ok_or_else(|| "Malformed .cookie file".to_string())?;
    let body = json!({ "jsonrpc": "1.0", "id": "raven-studio", "method": method, "params": params });
    let response = client()
        .post(rpc_url())
        .basic_auth(user, Some(pass))
        .json(&body)
        .timeout(std::time::Duration::from_secs(secs))
        .send()
        .await
        .map_err(|e| format!("노드와의 연결이 끊겼습니다 ({method}): {}", if e.is_timeout() { "시간 초과" } else { "연결" }))?;
    let parsed: Value = response
        .json()
        .await
        .map_err(|_| format!("노드와의 연결이 끊겼습니다 ({method})"))?;
    if let Some(err) = parsed.get("error").filter(|e| !e.is_null()) {
        let msg = err.get("message").and_then(Value::as_str).unwrap_or("unknown error");
        return Err(format!("{method}: {msg}"));
    }
    parsed
        .get("result")
        .cloned()
        .ok_or_else(|| format!("{method}: response had no result"))
    }
}

#[derive(Deserialize)]
struct ChainInfo {
    blocks: u64,
    headers: u64,
    verificationprogress: f64,
    mediantime: Option<i64>,
}

/// Height, sync progress, and whether the node is reachable at all.
pub async fn node_status() -> Result<Value, String> {
    node_status_with(None).await
}

/// 부름 하나 — `quick` 이면 짧게(`call_rpc_quick`), 아니면 보통으로.
async fn ask(method: &str, params: Value, quick: Option<u64>) -> Result<Value, String> {
    match quick {
        Some(ms) => call_rpc_quick(method, params, ms).await.map_err(|e| e.message),
        None => call_rpc(method, params).await,
    }
}

async fn node_status_with(quick: Option<u64>) -> Result<Value, String> {
    // 11-03 감사 B12: 세 물음(장부 정보·맨 끝 블록 시각·연결 수)을 차례로 기다리지 않고 한꺼번에 묻는다.
    // 동시에 셋 — RPC 동시 4개 제한(rpc_gate) 안이다.
    let tip = async {
        match ask("getbestblockhash", json!([]), quick).await {
            Ok(hash) => match hash.as_str() {
                Some(h) => ask("getblockheader", json!([h]), quick).await.ok().and_then(|hdr| hdr.get("time").and_then(Value::as_i64)),
                None => None,
            },
            Err(_) => None,
        }
    };
    let (raw, tip_time, peers) = tokio::join!(ask("getblockchaininfo", json!([]), quick), tip, ask("getconnectioncount", json!([]), quick));
    let info: ChainInfo =
        serde_json::from_value(raw?).map_err(|e| format!("Unexpected chain info: {e}"))?;

    // The tip's timestamp is what actually answers "is this node alive right
    // now" — a height is just a number to anyone who is not a node operator.
    // getblockchaininfo gives a median-of-11 time, which lags a few minutes, so
    // ask the tip itself.
    let tip_time = tip_time.or(info.mediantime);

    // 🔴 **연결 수를 같이 준다.** 「지금 얼마나 이어져 있나」가 사장이 진짜
    // 묻는 것이다 — 블록 수만 보면 멈춘 노드와 도는 노드를 구별 못 한다.
    // 못 읽어도 나머지는 보여야 하므로 실패는 `null` 이다.
    let peers = peers.ok().and_then(|v| v.as_i64());

    Ok(json!({
        "peers": peers,
        "blocks": info.blocks,
        "headers": info.headers,
        "progress": info.verificationprogress,
        "behind": info.headers.saturating_sub(info.blocks),
        // 🔴 재색인 중에는 위 숫자가 **진짜 끝까지의 거리가 아니다.**
        //    화면이 그걸 모르고 적으면 「곧 끝난다」고 거짓말한다.
        "behind_honest": crate::reindex_run::behind_is_honest(
            info.verificationprogress,
            info.headers.saturating_sub(info.blocks) as i64,
            info.blocks as i64,
        ),
        "tip_time": tip_time,
        // Treat "within a couple of blocks of the tip" as synced; an exact match
        // flickers every time a new block arrives.
        "synced": info.headers.saturating_sub(info.blocks) <= 2,
    }))
}

/// Every asset the wallet holds, paired with its IPFS hash where there is one.
///
/// listmyassets gives names and amounts but not the IPFS hash, so each asset
/// needs a second lookup. Assets are queried one at a time deliberately —
/// firing 200 concurrent RPCs at a node that is also validating blocks is a
/// good way to make the wallet unresponsive.
#[tauri::command]
pub async fn list_assets() -> Result<Vec<AssetEntry>, String> {
    let owned = call_rpc("listmyassets", json!([])).await?;
    let map = owned
        .as_object()
        .ok_or_else(|| "listmyassets did not return an object".to_string())?;

    // Owner tokens are held like any other asset, so they arrive in the same
    // list. Collect them first, then use them to label everything else.
    let owned_roots: std::collections::HashSet<String> = map
        .keys()
        .filter(|n| n.ends_with('!'))
        .map(|n| n.trim_end_matches('!').to_string())
        .collect();

    // 🔴 **자산 하나마다 줄 서서 묻고 있었다.**
    //
    //    예전에는 아래 반복문 안에서 `getassetdata` 를 `.await` 했다. 자산이
    //    스무 개면 스무 번을 차례로 기다린다. 노드가 한가할 때는 몇백
    //    밀리초라 안 보이지만, **재색인 중이면 한 번이 몇 초**다 — 그때
    //    자산 화면은 열리지 않는 화면이 된다. 대표님 윈도우가 지금 그 상태다.
    //
    //    한꺼번에 묻는다. 우리 노드는 같은 컴퓨터에 있고 동시 질문을 잘 받는다.
    let names: Vec<String> = map
        .keys()
        .filter(|n| !n.ends_with('!'))
        .cloned()
        .collect();
    let fetched = futures_util::future::join_all(
        names
            .iter()
            .map(|n| async move { (n.clone(), call_rpc("getassetdata", json!([n])).await) }),
    )
    .await;
    let mut cids: std::collections::HashMap<String, Option<String>> =
        std::collections::HashMap::new();
    // 단위·재발행은 **같은 응답 안에 이미 들어 있다.** 따로 물으면 자산
    // 개수만큼 왕복이 또 생긴다 — 위에서 한꺼번에 묻기로 고친 바로 그 병이다.
    let mut facts: std::collections::HashMap<String, (Option<i64>, Option<bool>)> =
        std::collections::HashMap::new();
    for (n, r) in fetched {
        // 못 읽었다고 목록에서 빼면 안 된다 — 가진 것은 여전히 진짜고,
        // 붙은 파일이 없을 뿐이다.
        let d = r.ok();
        let cid = d.as_ref().and_then(|d| {
            d.get("ipfs_hash")
                .and_then(Value::as_str)
                .filter(|h| !h.is_empty())
                .map(str::to_string)
        });
        // 못 읽었으면 `None` 으로 둔다. 0/false 로 채우면 **모르는 것을
        // 안다고 말하는 것**이고, 화면은 그걸 사실로 그린다.
        let units = d.as_ref().and_then(|d| d.get("units").and_then(Value::as_i64));
        let re = d
            .as_ref()
            .and_then(|d| d.get("reissuable").and_then(Value::as_i64))
            .map(|v| v != 0);
        facts.insert(n.clone(), (units, re));
        cids.insert(n, cid);
    }

    let mut out = Vec::with_capacity(map.len());
    for (name, amount) in map {
        // The owner token itself is bookkeeping, not a holding. Showing `PLAYX`
        // and `PLAYX!` as two rows doubles the list and explains nothing.
        if name.ends_with('!') {
            continue;
        }
        let ipfs_hash = cids.get(name.as_str()).cloned().flatten();

        // A unique asset PLAYX#tag and a sub-asset PLAYX/MUSIC both belong to
        // the PLAYX family, and both are ours if we hold PLAYX!.
        let root = name
            .split(['/', '#'])
            .next()
            .unwrap_or(&name)
            .trim_start_matches('$')
            .to_string();

        let (units, reissuable) = facts.get(name.as_str()).copied().unwrap_or((None, None));
        out.push(AssetEntry {
            name: name.clone(),
            amount: amount.as_f64().unwrap_or(0.0),
            ipfs_hash,
            mine: owned_roots.contains(root.as_str()) || owned_roots.contains(name.as_str()),
            root,
            units,
            reissuable,
        });
    }

    out.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    Ok(out)
}

/// Spendable balance, plus anything still waiting for confirmations.
///
/// Unconfirmed funds are reported separately rather than folded into one number:
/// a shop that treats a zero-confirmation payment as settled is a shop that can
/// be paid with a transaction that never confirms.
pub async fn wallet_balance() -> Result<Value, String> {
    wallet_balance_with(None).await
}

async fn wallet_balance_with(quick: Option<u64>) -> Result<Value, String> {
    // 11-03 감사 B12: 두 잔액을 한꺼번에 묻는다.
    let (confirmed, unconfirmed) = tokio::join!(ask("getbalance", json!([]), quick), ask("getunconfirmedbalance", json!([]), quick));
    let confirmed = confirmed?;
    let unconfirmed = unconfirmed.unwrap_or(json!(0.0));

    Ok(json!({
        "confirmed": confirmed.as_f64().unwrap_or(0.0),
        "unconfirmed": unconfirmed.as_f64().unwrap_or(0.0),
    }))
}

/// 바깥에서 들어오는 연결이 있는가.
///
/// 연결된 상대(`getpeerinfo`) 중 `inbound` 인 곳이 있으면 이 노드는 접속을 **받고 있다**.
/// 없다고 해서 막혀 있다고 단정하지 않는다(아무도 아직 안 왔을 수도 있다) — 「못 받는 것으로 보임」까지만 말한다.
/// 연결이 하나도 없거나 읽지 못하면 `unknown`: 모르는 것을 없다고 하지 않는다.
pub(crate) fn reach_from_peers(peers: &Value) -> Value {
    let Some(list) = peers.as_array() else { return json!({"state": "unknown"}) };
    let total = list.len();
    let inbound = list.iter().filter(|p| p.get("inbound").and_then(Value::as_bool) == Some(true)).count();
    let state = if total == 0 { "unknown" } else if inbound > 0 { "receiving" } else { "not_seen" };
    json!({"state": state, "inbound": inbound, "total": total})
}

#[tauri::command]
pub async fn node_reachability() -> Value {
    match call_rpc("getpeerinfo", json!([])).await {
        Ok(v) => reach_from_peers(&v),
        Err(_) => json!({"state": "unknown"}),
    }
}

#[cfg(test)]
mod reach_tests {
    use super::*;

    #[test]
    fn reach_counts_inbound_peers_and_never_guesses() {
        let some = json!([{"inbound": false}, {"inbound": true}, {"inbound": false}]);
        assert_eq!(reach_from_peers(&some), json!({"state": "receiving", "inbound": 1, "total": 3}));
        let none = json!([{"inbound": false}, {"inbound": false}]);
        assert_eq!(reach_from_peers(&none)["state"], "not_seen");
        // 연결이 없거나 모양이 다르면 모른다 — 「막혔다」고 하지 않는다.
        assert_eq!(reach_from_peers(&json!([]))["state"], "unknown");
        assert_eq!(reach_from_peers(&json!({"error": "x"}))["state"], "unknown");
        assert_eq!(reach_from_peers(&json!([{"addr": "1.2.3.4"}]))["state"], "not_seen");
    }
}

/// Recent wallet activity, newest first.
///
/// 🔴 **자산은 여기 안 나온다.** 코어의 `listtransactions` 는 자산 배열을
///    만들어 놓고 **버린다**(`Ravencoin/src/wallet/rpcwallet.cpp:1790-1795`).
///    그래서 「자산을 보냈는데 장부에 안 보인다」가 된다.
///    자산까지 보려면 아래 `wallet_since` 를 쓴다.
#[tauri::command]
pub async fn recent_transactions(count: u32) -> Result<Value, String> {
    call_rpc("listtransactions", json!(["*", count, 0, true])).await
}

/// 지난번 이후로 지갑에 생긴 일 — **RVN 과 자산 둘 다.**
///
/// 코어 지갑은 돈이 들어오면 그 자리에서 보여 주고 소리를 낸다. 우리는 그게
/// 없어서, 대표님이 폰으로 보낸 RVN 이 들어오는지 화면만 보고는 알 수 없었다.
///
/// `listsinceblock` 은 `listtransactions` 와 달리 **`asset_transactions` 를
/// 함께 준다**(실측 2026-09-07: RVN 126건 + 자산 83건). 색인이 없어도 된다.
/// `block` 을 비우면 처음부터, 주면 그 뒤로 생긴 것만 온다 — 그래서 이걸
/// 반복해서 부르면 「새로 생긴 것」만 골라낼 수 있다.
///
/// 돌려주는 것에 `lastblock` 이 들어 있다. 다음 번에 그걸 그대로 넣으면 된다.
#[tauri::command]
pub async fn wallet_since(block: Option<String>) -> Result<Value, String> {
    let args = match block.as_deref() {
        Some(b) if !b.is_empty() => json!([b, 1, true]),
        // 처음에는 기준이 없다. 지갑 전체를 한 번 읽어 「이미 본 것」을 채운다.
        _ => json!([]),
    };
    call_rpc("listsinceblock", args).await
}

/// 지갑 전체의 **자산** 거래 줄(확인 0·버린 것 포함) — 발행·재발행·보낸 자산을 찾을 때.
///
/// 🔴 `listtransactions` 에는 자산 줄이 없다(위 `recent_transactions` 참고). 그걸 읽은
///    「보냈는지 모름」 확인은 진짜 노드에서 늘 빈손이었고, 한 시간 뒤 같은 더 찍기가
///    또 나갈 수 있었다(검수 R3-1). 줄마다 asset_name·asset_type·amount·destination·
///    category·confirmations·time·abandoned 가 있다(rpcwallet.cpp ListTransactions).
pub async fn wallet_asset_txs() -> Result<Value, String> {
    asset_transactions_of(call_rpc("listsinceblock", json!([])).await?)
}

/// `listsinceblock` 답에서 자산 줄만. 모양이 다르면 오류 — 「못 읽음」을 「없음」으로
/// 넘기면 이미 나간 발행·배송을 또 보낸다.
pub(crate) fn asset_transactions_of(mut v: Value) -> Result<Value, String> {
    match v.get_mut("asset_transactions").map(Value::take) {
        Some(rows @ Value::Array(_)) => Ok(rows),
        _ => Err("지갑의 자산 기록을 읽지 못했어요. 노드가 따라잡은 뒤 다시 해 주세요.".into()),
    }
}

/// What has arrived at one address, counting only confirmed payments.
///
/// This is how an order gets matched to a payment: each order has its own
/// address, so a balance here means that specific order was paid. `min_conf`
/// is the caller's decision — a coffee can ship on one confirmation, a laptop
/// should not.
#[tauri::command]
pub async fn received_by_address(address: String, min_conf: u32) -> Result<f64, String> {
    let result = call_rpc("getreceivedbyaddress", json!([address, min_conf])).await?;
    Ok(result.as_f64().unwrap_or(0.0))
}

/// Is the wallet encrypted, and is it currently unlocked?
///
/// Automatic sending needs an unlocked wallet, which means the keys are usable
/// by anything running on this machine for as long as it stays open. The UI has
/// to be able to say so plainly, so it needs to know.
pub async fn wallet_lock_state() -> Result<Value, String> {
    wallet_lock_state_with(None).await
}

/// 화면의 상태 질문용(짧게). 앱 잠금 상태(`app_lock_state`)도 이것을 쓴다.
pub async fn wallet_lock_state_quick() -> Result<Value, String> {
    wallet_lock_state_with(Some(QUICK_MS)).await
}

async fn wallet_lock_state_with(quick: Option<u64>) -> Result<Value, String> {
    let info = ask("getwalletinfo", json!([]), quick).await?;

    // unlocked_until is absent on wallets that were never encrypted, 0 when
    // locked, and a unix timestamp while temporarily unlocked.
    let until = info.get("unlocked_until").and_then(Value::as_i64);
    Ok(json!({
        "encrypted": until.is_some(),
        "unlocked": match until {
            None => true,        // no passphrase set: always spendable
            Some(0) => false,
            Some(_) => true,
        },
        "unlocked_until": until,
    }))
}

/// A fresh address, so each order can be told apart by where the money landed.
///
/// Reusing one address makes two payments of the same amount indistinguishable,
/// which is exactly the case a shop hits on a busy day.
#[tauri::command]
pub async fn new_address(label: String) -> Result<String, String> {
    let result = call_rpc("getnewaddress", json!([label])).await?;
    result
        .as_str()
        .map(str::to_string)
        .ok_or_else(|| "getnewaddress did not return an address".to_string())
}

/// Whether this node can still see the rest of the network, and what that
/// changes.
///
/// ## Why the shop has to be told
///
/// A node with zero peers keeps answering questions. It reports balances, it
/// accepts transactions into its mempool, it looks completely healthy — it just
/// stops learning anything new. So a payment that arrives during an outage is
/// shown as received, and a zero-confirmation sale is accepted, and neither
/// claim can be checked against a network nobody is talking to.
///
/// That is precisely when a double-spend works: broadcast one transaction to
/// the shop's isolated node and a different one to everybody else. So the
/// shop's connection count is not a diagnostic detail, it is a payment rule.
///
/// ## What keeps working, and it is most of it
///
/// Orders, membership scans, the class list, the menu on a customer's phone —
/// all of that is this computer talking to phones on its own Wi-Fi and reading
/// its own files. A shop with a dead internet line can still run a full day of
/// service; it just cannot *settle*.
#[tauri::command]
pub async fn network_state() -> Value {
    let peers = call_rpc("getconnectioncount", json!([]))
        .await
        .ok()
        .and_then(|v| v.as_i64())
        .unwrap_or(0);
    let online = peers > 0;

    json!({
        "peers": peers,
        "online": online,
        // 인터넷이 끊기면 0회 확인은 검증할 방법이 사라진다. 확인 수를 올려도
        // 소용없다 — 블록 자체가 안 온다. 그래서 "기다리세요"가 아니라
        // "현금으로 받으세요"가 맞는 안내다.
        "zero_conf_ok": online,
        "headline": if online {
            format!("{peers}곳과 연결됨")
        } else {
            "인터넷이 끊겼습니다".to_string()
        },
        "still_works": [
            "손님 폰 주문 (가게 와이파이만 있으면 됩니다)",
            "회원권 확인·출입 QR",
            "수업 신청과 대기자",
            "메뉴·사진 보여주기",
        ],
        "stopped": if online { json!([]) } else { json!([
            "받은 돈 확인 — 새 블록이 오지 않습니다",
            "보내기 — 받아 두었다가 인터넷이 돌아오면 나갑니다",
        ]) },
        "advice": if online {
            ""
        } else {
            "인터넷이 돌아올 때까지 큰 금액은 현금으로 받으세요. 소액도 확인이 안 된 상태입니다."
        },
        // 멤풀은 336시간(14일) 보관한다. 그 안에 인터넷이 돌아오면 저절로 나간다.
        "held_hours": 336,
    })
}

#[cfg(test)]
mod conf_tests {
    /// 🔴 레이븐 코어를 오래 쓴 사람은 raven.conf 에 손을 대 둔다.
    ///    그걸 안 읽으면 노드가 멀쩡히 떠 있어도 「꺼져 있습니다」가 뜬다.
    ///    실측으로 만난 상태다(2026-08-26).
    #[test]
    fn 설정을_읽는_길이_있다() {
        let src = include_str!("raven.rs");
        // 쿠키가 없을 때 설정 파일의 사용자·암호를 쓴다.
        assert!(src.contains("conf_rpc_auth"), "rpcuser 를 안 읽으면 못 붙는다");
        assert!(src.contains(&format!("\"rpc{}\"", "user")));
        assert!(src.contains(&format!("\"rpc{}\"", "password")));
        // 포트를 옮겨 뒀을 수도 있다.
        assert!(src.contains(&format!("\"rpc{}\"", "port")), "포트가 못 박혀 있으면 빈 자리를 두드린다");
    }
}

#[cfg(test)]
mod send_timeout_tests {
    /// 검수 S5 — 코인이 움직이는 부름은 오래 기다리고, 끝내 모르면 「실패」가 아니라
    /// 「보냈는지 모름」으로 말한다. 읽기 부름은 예전처럼 20초.
    #[test]
    fn 보내는_부름은_길게_기다리고_모르면_모른다고_말한다() {
        for m in ["issue", "issueunique", "reissue", "transfer", "sendtoaddress", "sendrawtransaction", "issuequalifierasset"] {
            assert!(super::is_send_method(m), "{m}");
        }
        for m in ["getassetdata", "listmyassets", "getbalance", "getwalletinfo", "walletpassphrase"] {
            assert!(!super::is_send_method(m), "{m}");
        }
        assert!(super::SEND_TIMEOUT_SECS >= 120);
        let msg = super::sent_unknown_message("issueunique", super::SEND_TIMEOUT_SECS);
        assert!(msg.starts_with(super::SENT_UNKNOWN));
        assert!(msg.contains("보냈는지 아직 몰라요"));
        assert!(!msg.contains("실패"));
    }
}

/// 화면이 부르는 **상태** 명령들(11-12) — 같은 이름, 짧은 부름.
///
/// 🔴 러스트 안쪽(보내기·잠금 풀기·내보내기)은 위의 보통 함수를 그대로 쓴다. 그쪽은 「못 받음」을
///    「꺼짐」으로 읽고 다음 일을 정하므로(예: `walletfile` 의 `Probe::NodeDown`) 짧게 끊으면 안 된다.
///    화면만 짧게 묻고, 바쁘면 바쁘다고(`BUSY_SAY`) 듣는다 — 화면이 멈춘 것처럼 보이지 않게.
pub mod quick {
    use super::*;

    #[tauri::command]
    pub async fn node_status() -> Result<Value, String> {
        node_status_with(Some(QUICK_MS)).await
    }

    #[tauri::command]
    pub async fn wallet_lock_state() -> Result<Value, String> {
        wallet_lock_state_quick().await
    }

    /// 잔액은 큰 지갑에서 몇 초 걸릴 수 있어 조금 더 기다린다.
    #[tauri::command]
    pub async fn wallet_balance() -> Result<Value, String> {
        wallet_balance_with(Some(8_000)).await
    }
}

#[cfg(test)]
mod quick_tests {
    use super::*;

    /// 보내는 부름은 짧게 끊지 않는다 — 끊으면 「보냈는지 모름」이 「실패」로 둔갑한다.
    #[test]
    fn 보내는_부름은_짧은_부름이_되지_않는다() {
        let src = include_str!("raven.rs");
        let body = &src[src.find("async fn call_rpc_inner").unwrap()..];
        assert!(body.contains("let quick = quick.filter(|_| !is_send_method(method));"));
        assert!(QUICK_MS >= 3000, "윈도우 연결 거부(약 2초)보다 짧으면 꺼진 노드를 「바쁨」으로 잘못 읽는다");
    }

    /// 화면의 상태 명령은 짧은 쪽으로 등록돼 있어야 한다.
    #[test]
    fn 화면_상태_명령은_짧은_부름으로_등록된다() {
        let lib = include_str!("lib.rs");
        for c in ["raven::quick::node_status,", "raven::quick::wallet_lock_state,", "raven::quick::wallet_balance,", "node_boot::node_boot_progress,"] {
            assert!(lib.contains(c), "{c} 가 등록돼 있지 않다");
        }
        for c in ["raven::node_status,", "raven::wallet_lock_state,", "raven::wallet_balance,"] {
            assert!(!lib.contains(&format!("            {c}")), "{c} 보통(긴) 부름이 화면 명령으로 남아 있다");
        }
    }
}
