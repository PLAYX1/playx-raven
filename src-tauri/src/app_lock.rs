//! 지갑 잠금(앱 잠금) — 대기화면에 들어가는 순간, 또는 「매장용 읽기 전용 모드」를 켜는 순간.
//!
//! 설계·결정 근거: `docs/design/lock-and-dark.md`. 대표 결정(2026-10-11, 「(나)」):
//!
//! - 대기화면 **진입 즉시 잠금**. 화면만 덮는 것이 아니라 서명·복구 단어·보내기·백업 내보내기·
//!   열쇠 접근 IPC 가 **Rust 에서 실제로 거부**된다(`command_allowed`, lib.rs 에서 명령 처리 **전**).
//! - 대기화면을 끄면 **인증 없이** 잠긴 기본 화면으로 돌아간다. 지갑을 다시 쓰려면 지갑 암호.
//! - **시간 유예로 저절로 풀리지 않는다.** 「n분 안에 돌아오면 그냥 열림」 같은 면제가 없다(시험).
//! - **설정으로 잠금을 끄는 길이 없다.** 이 파일에 「끄기」 설정 칸이 없다(시험).
//! - 매장용 읽기 전용 모드 = 같은 잠금 + 조회 화면(금액 가림 기본, 거래 상세·주소·복구 단어·보내기 없음).
//!
//! ## 🔴 단일 진실
//!
//! 잠김 여부는 **여기 한 곳**(메모리 + `app-lock.json` 0600)에만 있다. 화면(JS)은 묻기만 한다.
//! 앱을 껐다 켜도 잠금은 그대로다(끝내고 다시 켜서 우회하지 못하게). 파일이 망가졌으면 **잠김**으로 읽는다.
//!
//! ## 허용 목록(잠긴 동안)
//!
//! 잠긴 동안 부를 수 있는 명령은 `LOCKED_ALLOWED` 뿐이다 — **목록에 없으면 거부**(새 명령도 기본 거부).
//! 상태 읽기·노드 켜기·잠금 풀기·종료·「힘을 줄이는」 명령(지갑 잠그기·자동 발송 끄기)만 넣었다.
//! 전체 분류표는 `docs/design/lock-and-dark.md` §4.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::sync::{Mutex, OnceLock};
use tauri::Emitter;

const FILE: &str = "app-lock.json";
pub const EVENT: &str = "app-lock-changed";
/// 폰·직원 화면(HTTP)에서 돈·열쇠·백업 일을 하려 할 때 PC 가 잠겨 있으면 돌려주는 말.
pub const REMOTE_LOCKED: &str = "PC 지갑이 잠겨 있어요(대기화면·매장용 읽기 전용). PC 에서 잠금을 푼 뒤 다시 해 주세요.";

/// 잠금 이유. 「manual」은 파일이 망가졌을 때 쓰는 안전한 기본값이다.
pub const REASONS: [&str; 3] = ["standby", "store", "manual"];

/// 🔴 잠긴 동안 부를 수 있는 앱 명령 **전부**. 나머지(보내기·서명·복구 단어·백업 내보내기·열쇠·
/// 발행·설정 바꾸기·AI·대화…)는 전부 거부된다. 늘릴 때는 시험과 문서 §4 를 같이 고친다.
pub const LOCKED_ALLOWED: &[&str] = &[
    // 잠금 자체
    "app_lock_state", "app_unlock", "app_lock_now",
    // 읽기 전용 입금 표시(미니 창·대기화면·칩) — 가림은 Rust(mini::snapshot). 가림 끄기는 mini_set 안에서 거부.
    "mini_state", "mini_set", "mini_show", "mini_open_main", "mini_seen",
    "display_mode_get", "standby_open", "standby_state", "standby_exit",
    // 라비 작은 창(떠 있는 얼굴) — 움직임·말풍선만. 설정 저장·받아쓰기(AI)는 빠짐.
    "companion_settings", "companion_open_main", "companion_show", "companion_bubble", "companion_sample",
    "companion_move", "companion_signal", "companion_click", "companion_dismiss", "companion_hold", "voice_cancel",
    // 종료 흐름(종료 전에 지갑을 잠근다 — ravi_prepare_quit). 잠금은 파일에 남아 다음 실행에도 잠겨 있다.
    "ravi_lifecycle_status", "ravi_take_close_request", "ravi_prepare_quit", "ravi_finish_quit",
    "ravi_cancel_quit", "ravi_hide_main",
    // 상태 읽기(값만, 비밀 없음) — 잠긴 화면 뒤의 큰 창이 「노드 꺼짐」으로 오해하지 않게.
    "node_status", "network_state", "wallet_balance", "recent_transactions", "wallet_since", "list_assets",
    "wallet_lock_state", "encryption_state", "services_status", "service_health", "money_status", "boot_report",
    "datadir_status", "node_identity", "node_version", "mode_get", "awake_status", "ipfs_status", "relay_status",
    "tunnel_status", "electrum_status", "mining_status", "miner_running", "mac_miners", "sync_stalled",
    "reindex_state", "reindex_progress", "words_restore_status", "backup_survey", "backup_pass_state",
    "autostart_status", "rvn_rate", "today_ymd", "check_update", "api_key_status", "model_settings",
    "ai_order_read", "ravi_consent", "shop_load", "ledger_range", "ledger_pending", "pin_list", "owner_tokens",
    "create_fingerprints", "create_history_list", "my_channels", "fee_owed", "sweep_read", "map_status",
    "map_load", "fee_read", "qr_svg",
    // 노드 켜기 — 노드가 꺼져 있으면 암호를 확인할 수 없다(잠금 풀기의 전제). 돈과 무관.
    "services_start",
    // 힘을 줄이는 것만(풀어 주는 것은 없음)
    "lock_wallet", "auto_disable",
];

/// 잠긴 동안 이 명령을 불러도 되나.
pub fn allowed_while_locked(command: &str) -> bool {
    LOCKED_ALLOWED.contains(&command)
}

/// lib.rs 문지기. 안 잠겼으면 다 통과, 잠겼으면 허용 목록만.
pub fn command_allowed(command: &str) -> bool {
    !is_locked() || allowed_while_locked(command)
}

/// 파일에 남는 모양. 🔴 「언제까지」·「유예」 칸이 **없다** — 시간이 지나도 저절로 안 풀린다.
#[derive(Clone, Serialize, Deserialize, Debug, PartialEq, Default)]
#[serde(deny_unknown_fields)]
pub struct State {
    pub locked: bool,
    pub reason: Option<String>,
    /// 잠근 시각(유닉스 초) — 화면 표시용. 풀림 판단에 쓰지 않는다.
    pub since: Option<i64>,
}

impl State {
    pub fn locked(reason: &str, now: i64) -> Self {
        let reason = if REASONS.contains(&reason) { reason } else { "manual" };
        Self { locked: true, reason: Some(reason.into()), since: Some(now) }
    }
}

/// 파일 내용 → 상태. 없으면 열림, **망가졌으면 잠김**(안전한 쪽).
pub fn parse(bytes: Option<&[u8]>) -> State {
    match bytes {
        None => State::default(),
        Some(b) => match serde_json::from_slice::<State>(b) {
            Ok(s) if !s.locked => State::default(),
            Ok(s) if s.reason.as_deref().is_some_and(|r| REASONS.contains(&r)) => s,
            _ => State::locked("manual", 0),
        },
    }
}

fn read_file() -> State {
    match std::fs::read(crate::paths::app_file(FILE)) {
        Ok(b) => parse(Some(&b[..b.len().min(4096)])),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => State::default(),
        // 읽을 수 없는 파일 = 잠김(권한이 바뀌었다고 잠금이 풀리면 안 된다).
        Err(_) => State::locked("manual", 0),
    }
}

fn persist(s: &State) -> Result<(), String> {
    let bytes = serde_json::to_vec(s).map_err(|_| "잠금 상태를 저장하지 못했어요.".to_string())?;
    crate::server::atomic_write_0600(&crate::paths::app_file(FILE), &bytes)
        .map_err(|_| "잠금 상태를 저장하지 못했어요.".into())
}

struct Inner {
    state: State,
    /// 연달아 틀린 횟수와 다음 시도 가능 시각(유닉스 초). 메모리에만.
    failures: u32,
    next_try: i64,
}

#[cfg(not(test))]
fn cell() -> &'static Mutex<Inner> {
    static CELL: OnceLock<Mutex<Inner>> = OnceLock::new();
    CELL.get_or_init(|| Mutex::new(Inner { state: read_file(), failures: 0, next_try: 0 }))
}

/// 시험에서는 실(thread)마다 따로 — 한 시험이 잠근 것이 동시에 도는 다른 시험(폰 환불 등)을 막지 않게.
#[cfg(test)]
fn cell() -> &'static Mutex<Inner> {
    thread_local! {
        static CELL: &'static Mutex<Inner> = Box::leak(Box::new(Mutex::new(Inner { state: State::default(), failures: 0, next_try: 0 })));
    }
    CELL.with(|c| *c)
}

static APP: OnceLock<tauri::AppHandle> = OnceLock::new();

pub fn is_locked() -> bool {
    cell().lock().unwrap_or_else(|e| e.into_inner()).state.locked
}

pub fn state() -> State {
    cell().lock().unwrap_or_else(|e| e.into_inner()).state.clone()
}

fn now() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0)
}

fn emit(s: &State) {
    if let Some(app) = APP.get() {
        let _ = app.emit(EVENT, json!({ "locked": s.locked, "reason": s.reason }));
        // 잠긴 화면의 읽기 전용 입금 표시: 지켜보기(mini_watch)는 잠긴 동안 돈다(display_mode::wants_watch).
        crate::display_mode::on_snapshot(app);
    }
}

/// 잠근다 — 대기화면 진입·매장 모드 켜기. 이미 잠겨 있으면 이유만 바꾼다(더 풀어 주는 일은 없다).
/// 저장에 실패해도 **메모리에서는 잠근다**(그 오류는 돌려준다).
pub fn lock(reason: &str) -> Result<State, String> {
    let s = {
        let mut g = cell().lock().unwrap_or_else(|e| e.into_inner());
        let since = if g.state.locked { g.state.since } else { Some(now()) };
        g.state = State { since, ..State::locked(reason, now()) };
        g.state.clone()
    };
    let saved = persist(&s);
    emit(&s);
    // 노드 지갑도 실제로 잠근다(암호 건 지갑이면 열려 있던 시간이 끝난다). 암호 없는 지갑은 오류 — 무시.
    // (시험에서는 노드를 부르지 않는다.)
    #[cfg(not(test))]
    tauri::async_runtime::spawn(async {
        let _ = crate::raven::call_rpc("walletlock", json!([])).await;
    });
    saved.map(|_| s)
}

/// 잠금을 푼다 — `app_unlock` 이 인증을 마친 뒤에만 부른다(이 파일 밖에서 부르지 않는다).
fn release() -> Result<(), String> {
    {
        let mut g = cell().lock().unwrap_or_else(|e| e.into_inner());
        g.state = State::default();
        g.failures = 0;
        g.next_try = 0;
    }
    let s = State::default();
    // 🔴 파일을 먼저 지우지 못하면 다음 실행에 다시 잠긴다 — 그쪽이 안전하므로 오류만 알린다.
    let r = persist(&s);
    emit(&s);
    r
}

/// 연달아 틀릴 때 기다릴 시간(초). 4번까지는 바로, 그 뒤 30·60·120… 최대 15분.
pub fn backoff_secs(failures: u32) -> i64 {
    if failures < 5 { 0 } else { (30i64 << (failures - 5).min(5)).min(900) }
}

/// 잠금 풀기 판단(순수 함수 — 시험). 노드에 물어본 결과와 백업 암호 봉투 대조 결과를 받는다.
#[derive(Debug, PartialEq)]
pub enum Probe {
    /// 지갑에 암호가 있고, 넣은 암호를 노드가 받았다/거절했다.
    EncryptedOk,
    EncryptedWrong,
    /// 지갑에 암호가 없다.
    NoPassword,
    /// 노드가 답하지 않는다(꺼짐·여는 중·연결 오류).
    NodeDown,
}

#[derive(Debug, PartialEq)]
pub enum Decision {
    Unlock { verified_by: &'static str },
    Wrong,
    NeedPassword,
    CannotVerify,
}

/// `envelope`: 백업 암호 봉투가 있으면 Some(넣은 암호가 맞나), 없으면 None.
pub fn decide(probe: Probe, pass_given: bool, envelope: Option<bool>) -> Decision {
    match probe {
        Probe::EncryptedOk => Decision::Unlock { verified_by: "wallet" },
        Probe::EncryptedWrong => Decision::Wrong,
        // 지갑 암호가 없을 때: 백업 암호가 있으면 그것으로 확인. 둘 다 없으면 확인할 비밀이 없다
        // — 풀어 주되 화면이 「암호가 없어 누구나 풀 수 있어요」를 말한다(no_secret).
        Probe::NoPassword => match envelope {
            Some(true) => Decision::Unlock { verified_by: "backup" },
            Some(false) if pass_given => Decision::Wrong,
            Some(false) => Decision::NeedPassword,
            None => Decision::Unlock { verified_by: "none" },
        },
        // 노드가 꺼져 있으면 지갑 암호를 확인할 수 없다. 백업 암호 봉투(이 앱은 처음 암호를 걸 때 같은
        // 암호로 만든다)로만 확인한다. 그것도 없으면 노드를 켠 뒤 다시.
        Probe::NodeDown => match envelope {
            Some(true) => Decision::Unlock { verified_by: "backup" },
            Some(false) if pass_given => Decision::Wrong,
            _ => Decision::CannotVerify,
        },
    }
}

fn lock_view(s: &State) -> Value {
    json!({ "locked": s.locked, "reason": s.reason, "since": s.since })
}

#[tauri::command]
pub async fn app_lock_state() -> Value {
    let s = state();
    let wallet = crate::raven::wallet_lock_state().await.ok();
    let mut v = lock_view(&s);
    v["wallet_encrypted"] = wallet.as_ref().and_then(|w| w["encrypted"].as_bool()).map(Value::Bool).unwrap_or(Value::Null);
    v["backup_pass"] = json!(crate::lockbox::backup_pass_state()["set"].as_bool().unwrap_or(false));
    v
}

/// 화면이 알아보는 접두어 — 지갑 암호가 없어서 잠금을 못 켰다(암호 설정 안내를 띄운다).
pub const NEEDS_WALLET_PASS: &str = "NEEDS_WALLET_PASS:";
const NEEDS_WALLET_PASS_SAY: &str = "지갑 암호가 아직 없어요. 암호가 없으면 잠가도 누구나 바로 풀 수 있어서 잠금이 의미가 없어요. 먼저 「지갑 화면 → 암호 걸기」에서 10글자 이상 암호를 정한 뒤 다시 켜 주세요.";
const LOCK_CANNOT_CHECK_SAY: &str = "노드가 응답하지 않아 지갑 암호가 있는지 확인할 수 없어요. 노드를 켠 뒤 다시 켜 주세요.";

/// 🔴 잠금을 **켜기 전** 확인(순수 함수 — 시험). 암호 없는 지갑은 잠가 봐야 누구나 풀 수 있다 — 막고 암호 설정을 안내한다.
/// 노드가 꺼져 있어 모를 때는 백업 암호 봉투가 있을 때만(그걸로 풀 수 있으므로) 통과시킨다.
pub fn lock_gate(wallet_encrypted: Option<bool>, backup_pass: bool) -> Result<(), String> {
    match wallet_encrypted {
        Some(true) => Ok(()),
        Some(false) => Err(format!("{NEEDS_WALLET_PASS}{NEEDS_WALLET_PASS_SAY}")),
        None if backup_pass => Ok(()),
        None => Err(LOCK_CANNOT_CHECK_SAY.into()),
    }
}

/// 대기화면·매장용 읽기 전용을 켜기 전에 부른다. 이미 잠겨 있으면(더 풀어 주는 일이 아니므로) 통과.
pub async fn require_secret_to_lock() -> Result<(), String> {
    if is_locked() {
        return Ok(());
    }
    let enc = crate::raven::wallet_lock_state().await.ok().and_then(|w| w["encrypted"].as_bool());
    lock_gate(enc, crate::lockbox::backup_pass_state()["set"].as_bool().unwrap_or(false))
}

/// 화면에서 잠그기 — 매장용 읽기 전용 모드 켜기("store"). 대기화면은 `display_mode::checked_standby_open` 가 확인 뒤 잠근다.
/// 🔴 지갑 암호가 없으면 켜지 않는다(`lock_gate`) — 암호 설정을 안내한다.
#[tauri::command]
pub async fn app_lock_now(reason: String) -> Result<Value, String> {
    if reason != "store" && reason != "manual" {
        return Err("잠금 이유가 올바르지 않아요.".into());
    }
    if reason == "store" {
        require_secret_to_lock().await?;
    }
    lock(&reason).map(|s| lock_view(&s))
}

/// 잠금 풀기 — 지갑 암호(노드가 확인). 기존 인증 흐름(`walletpassphrase` 짧게 → 곧바로 `walletlock`)과 같다.
#[tauri::command]
pub async fn app_unlock(passphrase: Option<String>) -> Result<Value, String> {
    if !is_locked() {
        return Ok(json!({ "locked": false }));
    }
    {
        let g = cell().lock().unwrap_or_else(|e| e.into_inner());
        let wait = g.next_try - now();
        if wait > 0 {
            return Err(format!("여러 번 틀려서 잠시 기다려야 해요. {wait}초 뒤에 다시 해 주세요."));
        }
    }
    let pass = passphrase.unwrap_or_default();
    let given = !pass.is_empty();
    let probe = match crate::raven::wallet_lock_state().await {
        Ok(st) if st["encrypted"].as_bool() == Some(false) => Probe::NoPassword,
        Ok(_) if !given => return Err("지갑 암호를 넣어 주세요.".into()),
        Ok(_) => match crate::raven::call_rpc_detailed("walletpassphrase", json!([pass, 2])).await {
            Ok(_) => {
                let _ = crate::raven::call_rpc("walletlock", json!([])).await;
                Probe::EncryptedOk
            }
            Err(e) if e.code == Some(-14) => Probe::EncryptedWrong,
            Err(_) => Probe::NodeDown,
        },
        Err(_) => Probe::NodeDown,
    };
    let envelope = if matches!(probe, Probe::NoPassword | Probe::NodeDown) && given {
        crate::lockbox::pass_matches(&pass)
    } else if matches!(probe, Probe::NoPassword | Probe::NodeDown) {
        crate::lockbox::backup_pass_state()["set"].as_bool().unwrap_or(false).then_some(false)
    } else {
        None
    };
    match decide(probe, given, envelope) {
        Decision::Unlock { verified_by } => {
            release()?;
            Ok(json!({ "locked": false, "verified_by": verified_by, "no_secret": verified_by == "none" }))
        }
        Decision::Wrong => {
            let mut g = cell().lock().unwrap_or_else(|e| e.into_inner());
            g.failures = g.failures.saturating_add(1);
            g.next_try = now() + backoff_secs(g.failures);
            Err("암호가 맞지 않습니다.".into())
        }
        Decision::NeedPassword => Err("암호를 넣어 주세요.".into()),
        Decision::CannotVerify => Err("노드가 응답하지 않아 암호를 확인할 수 없어요. 노드를 켠 뒤 다시 해 주세요.".into()),
    }
}

/// 시작 때 한 번 — 이벤트를 보낼 손잡이를 기억하고, 파일에서 잠금 상태를 읽어 둔다.
pub fn setup(app: &tauri::App) {
    let _ = APP.set(app.handle().clone());
    let _ = is_locked();
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 🔴 잠긴 동안 반드시 거부되어야 하는 명령(돈·서명·복구 단어·백업 내보내기·열쇠·발행·설정).
    /// 문서 §4 표의 「거부」 핵심 줄과 같다. 하나라도 허용 목록에 들어가면 깨진다.
    pub const MUST_DENY: &[&str] = &[
        // 보내기·서명
        "send_rvn", "send_asset", "transfer_ownership", "move_owner_token", "send_from", "wallet_send_signed",
        "sign_message", "phone_transaction_review", "phone_transaction_send", "abandon_tx", "fee_rate_set",
        "fee_pay", "pay_order", "refund", "refund_payer", "staff_refund", "reward_distribute", "reward_now",
        "swap_make_lot", "swap_offer", "swap_take", "fulfil_sale", "deliver_remote_sale", "auto_fulfil",
        "auto_deliver_web", "auto_enable", "sweep_run", "sweep_configure", "ledger_sweep", "split_payment",
        "mark_sent", "publish_offer", "gb_refund_mark",
        // 지갑 파일 내보내기·가져오기·열쇠 인쇄(0.8.7)
        "wallet_export", "wallet_import_prepare", "wallet_import_apply", "wallet_import_cancel", "wallet_file_status", "key_sheet_print",
        // 발행·자산 권한
        "issue_asset", "create_issue", "reissue", "issue_many_unique", "issue_qualifier", "issue_restricted",
        "tag_address", "untag_address", "freeze", "unfreeze", "rehearse_fund", "rehearse_issue",
        // 지갑 암호·복구 단어·열쇠
        "unlock_for", "encrypt_wallet", "change_passphrase", "reveal_seed", "sales_account_reveal",
        "sales_account_balance", "cloud_key_show", "cloud_unlock", "backup_pass_set", "identity_adopt_person_key",
        "identity_restore_legacy_key", "shop_key_move", "shop_key_move_plan", "shop_pubkey", "artist_pubkey",
        "words_restore_preflight", "words_restore_check", "words_restore_start", "words_restore_rescan",
        "words_restore_abort", "words_restore_undo", "words_restore_close", "restore_apply", "restore_survey",
        // 백업 내보내기
        "backup_now", "backup_zip", "backup_auto", "usb_lock_set", "recovery_card_print", "ledger_export",
        "ledger_csv",
        // 기기·권한·설정
        "pairing_approve", "pairing_show_qr", "pairing_request_open", "pairing_set_public_backup",
        "rotate_role_token", "remote_admin_set", "start_phone_server", "publish_shop", "shop_announce",
        "install_update", "conf_write", "conf_read", "datadir_set", "mode_set", "display_mode_set",
        "companion_save", "save_api_key", "save_device_api_key", "delete_api_key", "move_api_key_to_keychain",
        "save_custom_provider", "tunnel_start", "tunnel_install", "open_share", "door_open", "open_for_member",
        // 라비 도구·AI·대화(열쇠·돈 도구를 부를 수 있음)
        "ravi_tool", "ravi_agent_chat", "ravi_consent_save", "ai_chat", "ai_answer", "voice_transcribe",
        "talk_post", "talk_photo_post", "fan_announce", "nostr_publish", "broadcast_message", "broadcast",
        "pubsub_send", "msg_send", "new_address", "receive_address", "addr_new", "keypool_fill",
    ];

    fn handler_commands() -> Vec<String> {
        let lib = include_str!("lib.rs");
        let start = lib.find("generate_handler![").unwrap();
        let end = start + lib[start..].find("];").unwrap();
        lib[start..end]
            .lines()
            .filter_map(|l| l.trim().strip_suffix(','))
            .filter_map(|l| l.split_once("::").map(|(_, c)| c.to_string()))
            .collect()
    }

    #[test]
    fn every_must_deny_command_is_refused_while_locked_and_passes_when_unlocked() {
        let registered = handler_commands();
        for c in MUST_DENY {
            assert!(!allowed_while_locked(c), "잠긴 동안 {c} 가 허용 목록에 있다");
        }
        // 실제 등록된 돈·열쇠 명령이 이 목록에서 빠지지 않았는지(이름 바뀜 감지): 대부분 등록돼 있어야 한다.
        let known = MUST_DENY.iter().filter(|c| registered.iter().any(|r| r == *c)).count();
        assert!(known >= MUST_DENY.len() - 2, "MUST_DENY 중 등록 안 된 이름이 많다 — 이름이 바뀌었나? {known}/{}", MUST_DENY.len());
        // 상태 기계로: 잠김 → 거부, 열림 → 통과(문지기 식 그대로)
        let gate = |locked: bool, c: &str| !locked || allowed_while_locked(c);
        for c in MUST_DENY {
            assert!(!gate(true, c), "{c}");
            assert!(gate(false, c), "{c}");
        }
    }

    #[test]
    fn allowlist_is_registered_and_carries_no_money_or_key_names() {
        let registered = handler_commands();
        assert!(registered.len() > 400, "명령 목록을 못 읽었다: {}", registered.len());
        for c in LOCKED_ALLOWED {
            assert!(registered.iter().any(|r| r == c), "허용 목록의 {c} 가 lib.rs 에 없다(오타?)");
            for bad in ["send", "sign", "seed", "reveal", "unlock_for", "passphrase", "key_show", "issue", "export",
                        "zip", "transfer", "pay", "refund", "sweep_run", "approve", "install", "word", "restore_apply",
                        "encrypt", "fulfil", "deliver", "swap", "_save", "write", "set_"] {
                // companion_signal = 라비 얼굴 표정 신호(joy·sleep…), 서명과 무관.
                assert!(!c.contains(bad) || c.ends_with("_state") || ["words_restore_status", "app_unlock", "companion_signal"].contains(c),
                    "허용 목록에 위험한 이름: {c} ({bad})");
            }
        }
        // 등록된 명령 중 허용되지 않은 것은 전부 잠긴 동안 거부된다(허용 목록 방식 — 새 명령도 기본 거부).
        let denied = registered.iter().filter(|c| !allowed_while_locked(c)).count();
        assert!(denied > 350, "거부되는 명령이 너무 적다: {denied}");
    }

    #[test]
    fn lib_checks_the_lock_before_any_handler_and_registers_the_commands() {
        let lib = include_str!("lib.rs");
        let gate = lib.find("app_lock::command_allowed").expect("lib.rs 에 잠금 문지기가 있어야 한다");
        assert!(gate < lib.find("generate_handler!").unwrap());
        for c in ["app_lock_state", "app_unlock", "app_lock_now"] {
            assert!(lib.contains(&format!("app_lock::{c}")), "{c} 등록");
        }
    }

    #[test]
    fn standby_entry_locks_before_the_window_exists() {
        let src = include_str!("display_mode.rs");
        let f = &src[src.find("fn open_standby").unwrap()..];
        let f = &f[..f.find("\nfn ").unwrap_or(f.len())];
        let lock_at = f.find("app_lock::lock(\"standby\")").expect("대기화면 진입이 잠금을 켜야 한다");
        let build_at = f.find("WebviewWindowBuilder").unwrap();
        let reuse_at = f.find("get_webview_window(STANDBY)").unwrap();
        assert!(lock_at < build_at && lock_at < reuse_at, "창을 만들거나 다시 쓰기 **전에** 잠근다");
        // 대기화면 끄기는 잠금을 풀지 않는다(인증 없이 잠긴 기본 화면으로).
        let exit = &src[src.find("fn exit_standby").unwrap()..];
        let exit = &exit[..exit.find("\n}\n").unwrap()];
        assert!(!exit.contains("release") && !exit.contains("app_unlock"), "대기화면 끄기가 잠금을 풀면 안 된다");
    }

    #[test]
    fn no_grace_period_and_no_off_switch() {
        // 상태에 시간 기한 칸이 없다 — 시간이 지나도 저절로 풀리지 않는다.
        let s = State::locked("standby", 1_000);
        let v = serde_json::to_value(&s).unwrap();
        let keys: Vec<_> = v.as_object().unwrap().keys().cloned().collect();
        assert_eq!(keys, ["locked", "reason", "since"]);
        assert!(serde_json::from_str::<State>(r#"{"locked":true,"reason":"standby","since":1,"until":2}"#).is_err());
        // 오래된 잠금(1년 전)도 잠김 그대로 읽는다.
        let old = parse(Some(br#"{"locked":true,"reason":"standby","since":1}"#));
        assert!(old.locked);
        // 이 파일에 잠금을 끄는 설정·유예 숫자가 없다.
        let me = include_str!("app_lock.rs");
        let body = &me[..me.find("#[cfg(test)]\nmod tests").unwrap()];
        for bad in ["grace", "disable_lock", "lock_enabled", "auto_unlock", "unlock_after", "timeout_secs"] {
            assert!(!body.contains(bad), "{bad}");
        }
        // release 는 app_unlock 안에서만 부른다.
        assert_eq!(body.matches("release()").count(), 2, "정의 + app_unlock 한 곳");
    }

    #[test]
    fn corrupt_or_unknown_file_reads_as_locked() {
        assert!(!parse(None).locked, "파일이 없으면 열림(처음 쓰는 사람)");
        assert!(parse(Some(b"garbage")).locked);
        assert!(parse(Some(br#"{"locked":true,"reason":"party","since":1}"#)).locked);
        assert_eq!(parse(Some(br#"{"locked":true,"reason":"party","since":1}"#)).reason.as_deref(), Some("manual"));
        assert!(parse(Some(br#"{"locked":true,"reason":"store","since":1,"x":1}"#)).locked, "모르는 칸 = 잠김");
        assert!(!parse(Some(br#"{"locked":false,"reason":null,"since":null}"#)).locked);
        assert_eq!(State::locked("weird", 5).reason.as_deref(), Some("manual"));
    }

    #[test]
    fn unlock_decisions() {
        use Decision::*;
        assert_eq!(decide(Probe::EncryptedOk, true, None), Unlock { verified_by: "wallet" });
        assert_eq!(decide(Probe::EncryptedWrong, true, None), Wrong);
        assert_eq!(decide(Probe::NoPassword, false, None), Unlock { verified_by: "none" });
        assert_eq!(decide(Probe::NoPassword, true, Some(true)), Unlock { verified_by: "backup" });
        assert_eq!(decide(Probe::NoPassword, true, Some(false)), Wrong);
        assert_eq!(decide(Probe::NoPassword, false, Some(false)), NeedPassword);
        assert_eq!(decide(Probe::NodeDown, true, Some(true)), Unlock { verified_by: "backup" });
        assert_eq!(decide(Probe::NodeDown, true, Some(false)), Wrong);
        assert_eq!(decide(Probe::NodeDown, true, None), CannotVerify, "노드가 꺼지고 봉투도 없으면 못 푼다");
        assert_eq!(decide(Probe::NodeDown, false, None), CannotVerify);
    }

    #[test]
    fn backoff_grows_and_caps() {
        assert_eq!((0..5).map(backoff_secs).collect::<Vec<_>>(), [0, 0, 0, 0, 0]);
        assert_eq!(backoff_secs(5), 30);
        assert_eq!(backoff_secs(6), 60);
        assert_eq!(backoff_secs(9), 480);
        assert_eq!(backoff_secs(10), 900);
        assert_eq!(backoff_secs(40), 900);
    }

    #[test]
    fn lock_persists_privately_and_survives_restart_until_release() {
        let _env = crate::paths::TEST_ENV.lock().unwrap_or_else(|e| e.into_inner());
        let path = crate::paths::app_file(FILE);
        let _ = std::fs::remove_file(&path);
        // 시작: 파일 없음 → 열림
        cell().lock().unwrap().state = read_file();
        assert!(!is_locked());
        assert!(command_allowed("send_rvn"));
        // 대기화면 진입과 같은 잠금
        lock("standby").unwrap();
        assert!(is_locked());
        for c in MUST_DENY {
            assert!(!command_allowed(c), "잠긴 동안 {c}");
        }
        assert!(command_allowed("standby_exit") && command_allowed("app_unlock") && command_allowed("wallet_balance"));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(std::fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);
        }
        // 「앱을 껐다 켜기」 = 파일에서 다시 읽기 → 여전히 잠김
        cell().lock().unwrap().state = read_file();
        assert!(is_locked(), "다시 켜도 잠금 유지");
        assert_eq!(state().reason.as_deref(), Some("standby"));
        // 매장 모드로 바꿔도 잠김은 그대로(이유만)
        lock("store").unwrap();
        assert!(is_locked());
        assert_eq!(state().reason.as_deref(), Some("store"));
        // 인증 뒤 풀기
        release().unwrap();
        assert!(!is_locked());
        for c in MUST_DENY {
            assert!(command_allowed(c), "풀린 뒤 {c}");
        }
        cell().lock().unwrap().state = read_file();
        assert!(!is_locked(), "풀린 것도 파일에 남는다");
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn phone_and_staff_money_paths_check_the_lock_first() {
        // 문지기(lib.rs)는 창 IPC 만 본다. 폰·직원 HTTP 와 폰 승인 보내기는 여기서 따로 막는다.
        let server = include_str!("server.rs");
        for (f, money) in [("async fn admin_issue(", "crate::issue::issue_asset("), ("async fn admin_backup(", "crate::backup::backup_zip("),
                           ("async fn staff_refund_route(", "crate::refund::staff_refund_response(")] {
            let body = &server[server.find(f).unwrap()..];
            let at_lock = body.find("crate::app_lock::is_locked()").expect(f);
            assert!(at_lock < body.find(money).unwrap(), "{f}: 잠금 확인이 돈 일보다 먼저");
        }
        let net = include_str!("pairing/net.rs");
        let send = &net[net.find("fn send_rvn<'a>").unwrap()..];
        assert!(send.find("crate::app_lock::is_locked()").unwrap() < send.find("crate::send::send_rvn(").unwrap());
    }

    #[test]
    fn locking_needs_a_wallet_password() {
        // 암호 없는 지갑: 막고, 화면이 알아보는 접두어로 암호 설정을 안내한다.
        let e = lock_gate(Some(false), false).unwrap_err();
        assert!(e.starts_with(NEEDS_WALLET_PASS) && e.contains("암호"));
        // 백업 암호가 있어도 지갑 암호가 없다고 확인되면 막는다.
        assert!(lock_gate(Some(false), true).is_err());
        assert!(lock_gate(Some(true), false).is_ok());
        // 노드가 꺼져 모를 때: 백업 암호 봉투가 있으면 통과, 없으면 막는다(접두어 없이 — 노드를 켜라는 안내).
        assert!(lock_gate(None, true).is_ok());
        let down = lock_gate(None, false).unwrap_err();
        assert!(!down.starts_with(NEEDS_WALLET_PASS));
        // 두 진입(매장 모드·대기화면)이 모두 이 확인을 거친다.
        let me = include_str!("app_lock.rs");
        let now = &me[me.find("pub async fn app_lock_now").unwrap()..];
        assert!(now[..now.find("lock(&reason)").unwrap()].contains("require_secret_to_lock"));
        let dm = include_str!("display_mode.rs");
        let std = &dm[dm.find("pub async fn standby_open").unwrap()..];
        assert!(std[..std.find("\n}\n").unwrap()].contains("checked_standby_open"));
        let chk = &dm[dm.find("async fn checked_standby_open").unwrap()..];
        let chk = &chk[..chk.find("\n}\n").unwrap()];
        assert!(chk.find("require_secret_to_lock").unwrap() < chk.find("open_standby(").unwrap());
        // 트레이 메뉴 길도 같은 문을 쓴다.
        assert!(dm.contains("checked_standby_open(&h)"));
    }

    #[test]
    fn app_lock_now_only_accepts_store_or_manual() {
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        assert!(rt.block_on(app_lock_now("standby".into())).is_err(), "대기화면 잠금은 대기화면을 열 때만");
        assert!(rt.block_on(app_lock_now("".into())).is_err());
    }
}
