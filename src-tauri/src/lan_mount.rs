//! LAN 동기화 ⑤ — 기존 폰 서버(8790)에 `/lan/push`·`/lan/pull` 을 붙이는 자리와 켜기 스위치.
//!
//! 🔴 새 포트·새 listen 없음. `server.rs` 의 `build_phone_router` 가 이미 `0.0.0.0:8790` 에 묶는 그 라우터에
//!    `lan_handler::router` 조각을 `merge` 할 뿐이다. 바깥(터널)에서 온 `/lan/*` 은 원격 관리를 켜도 막는다(`server::outside_blocked`).
//! 🔴 기본 꺼짐. 앱 폴더 `lan/settings.json` 의 `lanSync` 가 **불리언 true** 일 때만 켠다(`LanConfig::from_json`).
//!    파일이 없거나 모양이 틀리면 꺼짐. 꺼져 있으면 열쇠 파일은 **읽지도 않는다**.
//! 🔴 끄면 이미 붙은 경로도 곧바로 404(`LanServerState::live`). 켜기는 폰 서버를 다시 켤 때 반영된다(라우터는 시작 때 한 번 만든다).

#![allow(dead_code)]

use crate::lan_handler::{LanConfig, LanServerState};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex};

/// 앱 폴더 안 LAN 동기화 폴더 이름.
pub const LAN_DIR: &str = "lan";
pub const SETTINGS_FILE: &str = "settings.json";

/// 왜 켜지지 않았나(또는 켜졌나). 화면·문제 알리기에 그대로 보인다 — 비밀 값은 싣지 않는다.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum MountState {
    /// 스위치가 꺼져 있다(기본).
    #[default]
    Off,
    /// 가게 번호·가게 공개키가 이 컴퓨터에 아직 없다.
    NoStore,
    /// 가게 번호/공개키 파일 모양이 틀렸다.
    BadStore,
    /// 데이터 열쇠가 아직 없다.
    NoDataKey,
    /// 데이터 열쇠 파일 모양이 틀렸다.
    BadDataKey,
    /// 로그 저장소를 열지 못했다(다른 프로그램이 쓰는 중·디스크 오류).
    StoreFailed,
    /// 켜져서 받는 중.
    On,
}
impl MountState {
    pub fn code(self) -> &'static str {
        match self {
            Self::Off => "off",
            Self::NoStore => "no-store",
            Self::BadStore => "bad-store",
            Self::NoDataKey => "no-data-key",
            Self::BadDataKey => "bad-data-key",
            Self::StoreFailed => "store-failed",
            Self::On => "on",
        }
    }
    /// 사장에게 보이는 쉬운 말.
    pub fn say(self) -> &'static str {
        match self {
            Self::Off => "같은 와이파이 자동 복사가 꺼져 있어요.",
            Self::NoStore => "가게 번호를 먼저 만들어 주세요.",
            Self::BadStore => "가게 번호 기록이 망가져 있어요. 가게 번호를 다시 저장해 주세요.",
            Self::NoDataKey => "기기끼리 나눌 데이터 열쇠가 아직 없어요.",
            Self::BadDataKey => "데이터 열쇠 기록이 망가져 있어요.",
            Self::StoreFailed => "복사 기록을 열지 못했어요. 앱을 다시 켜 주세요.",
            Self::On => "같은 와이파이의 내 기기와 자동으로 복사하고 있어요.",
        }
    }
}

/// 서버 상태에 들어가는 한 칸. 비어 있으면 `/lan/*` 경로는 만들지 않는다.
#[derive(Default)]
pub struct LanSlot {
    state: Mutex<Option<Arc<LanServerState>>>,
    mount: Mutex<MountState>,
    rev: Mutex<RevMeta>,
}

impl LanSlot {
    pub fn mount_state(&self) -> MountState {
        self.mount.lock().map(|m| *m).unwrap_or(MountState::Off)
    }
    pub fn state(&self) -> Option<Arc<LanServerState>> {
        self.state.lock().ok().and_then(|s| s.clone())
    }
    fn set_mount(&self, m: MountState) {
        if let Ok(mut g) = self.mount.lock() {
            *g = m;
        }
    }
    /// 스위치를 내린다: 붙어 있던 경로도 곧바로 404. 상태(로그 파일 잠금)는 버리지 않는다 —
    /// 서버가 도는 동안 다시 켜면 같은 상태를 다시 쓴다(옛 라우터가 잠금을 쥔 채 남아 있어 새로 열 수 없다).
    pub fn disarm(&self) {
        if let Some(st) = self.state() {
            st.live.store(false, Ordering::SeqCst);
        }
        self.set_mount(MountState::Off);
    }
    /// 켠다. 스위치가 꺼져 있으면 `make` 를 부르지 않는다(열쇠 파일을 읽지 않는다).
    /// 이미 만든 상태가 있으면 그대로 다시 켠다.
    pub fn arm<F>(&self, cfg: &LanConfig, make: F) -> MountState
    where
        F: FnOnce() -> Result<LanServerState, MountState>,
    {
        if !cfg.enabled {
            self.disarm();
            return MountState::Off;
        }
        if let Some(cur) = self.state() {
            cur.live.store(true, Ordering::SeqCst);
            self.set_mount(MountState::On);
            return MountState::On;
        }
        let m = match make() {
            Ok(st) => {
                if let Ok(mut g) = self.state.lock() {
                    *g = Some(Arc::new(st));
                }
                MountState::On
            }
            Err(MountState::On) => MountState::StoreFailed,
            Err(m) => m,
        };
        self.set_mount(m);
        m
    }
    /// `build_phone_router` 가 붙일 조각. 켜져 있지 않으면 None — 경로 자체가 없다.
    pub fn router(&self) -> Option<axum::Router> {
        if self.mount_state() != MountState::On {
            return None;
        }
        crate::lan_handler::router(&LanConfig { enabled: true }, self.state()?)
    }
}

/// 앱 폴더의 LAN 폴더.
pub fn lan_dir() -> PathBuf {
    crate::paths::app_file(LAN_DIR)
}

/// 스위치 읽기. 파일이 없거나 JSON 이 아니면 꺼짐.
pub fn read_config(dir: &Path) -> LanConfig {
    std::fs::read_to_string(dir.join(SETTINGS_FILE))
        .ok()
        .and_then(|t| serde_json::from_str::<Value>(&t).ok())
        .map(|v| LanConfig::from_json(&v))
        .unwrap_or_default()
}

/// 스위치 쓰기(0600, 원자적). 🔴 켜기는 대표 승인 항목 — 이 함수를 부르는 화면·명령은 이 레인에서 만들지 않는다.
pub fn write_config(dir: &Path, on: bool) -> Result<(), String> {
    let doc = serde_json::to_vec_pretty(&json!({ "lanSync": on })).unwrap_or_default();
    crate::server::atomic_write_0600(&dir.join(SETTINGS_FILE), &doc).map_err(|_| "설정을 저장하지 못했어요.".to_string())
}

// ── ② 열쇠 공급 ──────────────────────────────────────────────
//
// 어디에 무엇이 있나(코드 근거 — 2026-10-15 이 브랜치):
//   · 가게 공개키: Rust 가 12단어에서 그때그때 뽑는다(`storesign::store_key_info`, 경로 `identity::PATH_SHOP`). 저장된 곳 없음.
//   · 가게 번호(storeId): 화면(웹뷰) localStorage 에만 있다(`src/store-doc-ui.ts localStoreDocStorage`, 키 rv-store-doc). Rust 는 못 읽는다.
//   · 철회 목록: 화면 localStorage `rv-devices-v1` 에만 있다(`src/device-connect.ts localDeviceStore`). 서명은 `store_sign_digest`(사장 확인창).
//   · 데이터 열쇠: **어디에도 없다**(Rust·화면 전체 검색 0건 — 화면 문구만 있음). 만들기·나눠 주기(sealDataKey)·백업 판 5 는 결정 대기.
// 그래서 운영 공급자는 앱 폴더 `lan/` 의 파일 세 개를 읽는다. 가게 키는 Rust 가 12단어로 직접 뽑아 적고(화면이 준 키를 믿지 않음),
// 가게 번호만 화면이 준다(틀려도 그 번호로 서명된 증서가 없으니 문이 열리지 않는다 — 닫힌 실패).

pub const STORE_FILE: &str = "store.json";
pub const DATA_KEY_FILE: &str = "data-key.json";
pub const REVOCATION_FILE: &str = "revocation.json";
pub const LOG_DIR: &str = "log";

/// 가게 번호 + 가게 공개키(압축 hex).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StoreIdentity {
    pub store_id: String,
    pub store_key: String,
}

fn is_sha_hex(s: &str) -> bool {
    s.len() == 64 && s.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

impl StoreIdentity {
    pub fn checked(store_id: &str, store_key: &str) -> Option<Self> {
        (is_sha_hex(store_id) && crate::lan_cert::is_public_key(store_key)).then(|| StoreIdentity { store_id: store_id.into(), store_key: store_key.into() })
    }
}

/// 처리기에 줄 값의 공급자. 시험 = 합성 값, 운영 = `FileLanKeys`.
pub trait LanKeySource: Send + Sync {
    fn store_identity(&self) -> Result<StoreIdentity, MountState>;
    fn data_key(&self) -> Result<crate::lan_seal::DataKey, MountState>;
    /// 마지막으로 받아 둔 서명된 철회 목록(없으면 None → 모든 증서 거절).
    fn revocation_list(&self) -> Option<Value>;
    fn save_revocation_list(&self, list: &Value) -> Result<(), String>;
}

/// 운영 공급자 — 앱 폴더 `lan/` 의 파일(0600).
pub struct FileLanKeys {
    pub dir: PathBuf,
}
impl FileLanKeys {
    pub fn new(dir: PathBuf) -> Self {
        FileLanKeys { dir }
    }
    fn read(&self, name: &str) -> Option<Result<Value, ()>> {
        match std::fs::read_to_string(self.dir.join(name)) {
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
            Err(_) => Some(Err(())),
            Ok(t) => Some(serde_json::from_str::<Value>(&t).map_err(|_| ())),
        }
    }
    /// 가게 번호 기록. 가게 키는 호출자가 12단어에서 직접 뽑은 값이어야 한다(`store_identity_from_words`).
    pub fn save_store_identity(&self, id: &StoreIdentity) -> Result<(), String> {
        let doc = serde_json::to_vec_pretty(&json!({ "v": 1, "storeId": id.store_id, "storeKey": id.store_key })).unwrap_or_default();
        crate::server::atomic_write_0600(&self.dir.join(STORE_FILE), &doc).map_err(|_| "가게 번호를 저장하지 못했어요.".to_string())
    }
}
impl LanKeySource for FileLanKeys {
    fn store_identity(&self) -> Result<StoreIdentity, MountState> {
        let v = match self.read(STORE_FILE) {
            None => return Err(MountState::NoStore),
            Some(Err(())) => return Err(MountState::BadStore),
            Some(Ok(v)) => v,
        };
        let ok = v.as_object().map_or(false, |o| o.len() == 3) && v["v"].as_u64() == Some(1);
        match (ok, v["storeId"].as_str(), v["storeKey"].as_str()) {
            (true, Some(id), Some(k)) => StoreIdentity::checked(id, k).ok_or(MountState::BadStore),
            _ => Err(MountState::BadStore),
        }
    }
    /// 모양: `{"v":1,"version":<1 이상>,"key":"<64 hex, 전부 0 아님>"}`. 🔴 이 파일을 만드는 코드는 아직 없다(결정 대기).
    fn data_key(&self) -> Result<crate::lan_seal::DataKey, MountState> {
        let v = match self.read(DATA_KEY_FILE) {
            None => return Err(MountState::NoDataKey),
            Some(Err(())) => return Err(MountState::BadDataKey),
            Some(Ok(v)) => v,
        };
        let ok = v.as_object().map_or(false, |o| o.len() == 3) && v["v"].as_u64() == Some(1);
        let version = v["version"].as_u64().filter(|n| (1..=9_007_199_254_740_991).contains(n));
        let key = v["key"].as_str().filter(|k| is_sha_hex(k)).and_then(|k| hex::decode(k).ok());
        match (ok, version, key) {
            (true, Some(version), Some(bytes)) if bytes.iter().any(|b| *b != 0) => {
                let mut key = [0u8; 32];
                key.copy_from_slice(&bytes);
                Ok(crate::lan_seal::DataKey { version, key })
            }
            _ => Err(MountState::BadDataKey),
        }
    }
    fn revocation_list(&self) -> Option<Value> {
        self.read(REVOCATION_FILE).and_then(Result::ok).filter(Value::is_object)
    }
    fn save_revocation_list(&self, list: &Value) -> Result<(), String> {
        let doc = serde_json::to_vec(list).map_err(|_| "철회 목록을 저장하지 못했어요.".to_string())?;
        crate::server::atomic_write_0600(&self.dir.join(REVOCATION_FILE), &doc).map_err(|_| "철회 목록을 저장하지 못했어요.".to_string())
    }
}

/// 12단어에서 가게 공개키를 뽑아 가게 번호와 묶는다. 단어와 비밀 열쇠는 바로 지운다(`storesign` 과 같은 규칙).
pub fn store_identity_from_words(words: &mut String, pass: &mut String, store_id: &str) -> Result<StoreIdentity, &'static str> {
    let sk = crate::storesign::store_secret(words, pass);
    crate::words::wipe(words);
    crate::words::wipe(pass);
    let mut sk = sk.ok_or(crate::storesign::ERR_KEY)?;
    let pk = crate::storesign::pubkey_hex(&sk);
    crate::words::wipe_bytes(&mut sk);
    StoreIdentity::checked(store_id, &pk?).ok_or("가게 번호 모양이 맞지 않아요.")
}

/// 공급자에서 처리기 상태를 만든다. 하나라도 빠지면 그 이유(경로는 만들지 않음).
pub fn build_state(keys: &dyn LanKeySource, log_dir: &Path, now_ms: i64) -> Result<LanServerState, MountState> {
    let id = keys.store_identity()?;
    let data_key = keys.data_key()?;
    let store = crate::lan_store::LanStore::open(log_dir, now_ms).map_err(|_| MountState::StoreFailed)?;
    // 저장해 둔 목록도 가게 키 서명·가게 번호를 다시 본다. 못 넘으면 없는 것으로(= 모든 증서 거절, 닫힌 실패).
    let list = keys.revocation_list().filter(|l| crate::lan_cert::verify_revocation_list(l, &id.store_key, &id.store_id).is_ok());
    let mut st = LanServerState::new(id.store_key, data_key, list, store);
    st.store_id = id.store_id;
    Ok(st)
}

fn now_ms() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_millis() as i64)
}

/// `start_phone_server` 가 부른다. 스위치가 꺼져 있으면(기본) 아무 파일도 더 읽지 않는다.
pub fn arm_from_disk(slot: &LanSlot) -> MountState {
    let dir = lan_dir();
    let cfg = read_config(&dir);
    let m = slot.arm(&cfg, || build_state(&FileLanKeys::new(dir.clone()), &dir.join(LOG_DIR), now_ms()));
    slot.note_loaded_list();
    m
}

// ── ③ 철회 목록 갱신 ────────────────────────────────────────
//
// 규칙(core 와 같음): 목록이 없거나 서명 시각이 24시간을 넘으면 **모든 증서를 거절**한다(`lan_cert` stale-revocation-list).
// 그래서 가게 키 PC 가 하루 안에 같은 목록을 seq+1 로 다시 서명해 이 길로 넣어 줘야 한다.
// 🔴 자동 재서명은 없다: 가게 키 서명은 매번 사장 확인창을 거친다(`storesign::store_sign_digest`). 화면은 `refreshBy` 전에 사장에게 묻는다.
// 실패하면 지금 목록을 그대로 둔다(망가진/옛 목록으로 바꾸지 않는다). 지금 목록이 낡았으면 그대로 「모두 거절 중」이라고 보인다.

/// 마지막 갱신 기록(메모리). 목록 본문은 담지 않는다.
#[derive(Debug, Clone, Default)]
pub struct RevMeta {
    pub seq: Option<u64>,
    pub issued_at: Option<i64>,
    pub last_try_at: Option<i64>,
    pub last_ok_at: Option<i64>,
    pub last_result: Option<&'static str>,
    pub last_error: Option<&'static str>,
}

impl LanSlot {
    pub fn rev_meta(&self) -> RevMeta {
        self.rev.lock().map(|m| m.clone()).unwrap_or_default()
    }
    fn with_rev(&self, f: impl FnOnce(&mut RevMeta)) {
        if let Ok(mut m) = self.rev.lock() {
            f(&mut m);
        }
    }
    /// 켤 때 실린 목록의 번호·시각을 적는다(이미 검증된 것만 실린다).
    fn note_loaded_list(&self) {
        let Some(st) = self.state() else { return };
        let list = st.revocation.lock().ok().and_then(|l| l.clone());
        let info = list.and_then(|l| crate::lan_cert::verify_revocation_list(&l, &st.store_key, &st.store_id).ok());
        self.with_rev(|m| {
            m.seq = info.as_ref().map(|i| i.seq);
            m.issued_at = info.as_ref().map(|i| i.issued_at);
        });
    }
}

/// 새로 서명된 철회 목록을 받는다. 순서: 가게 확인 → core 받기 규칙(후퇴·되살리기 금지) → 미래 시각 거절 → **디스크 저장 성공** → 메모리 교체.
pub fn update_revocation(slot: &LanSlot, keys: &dyn LanKeySource, raw: &Value, now: i64) -> Value {
    use crate::lan_cert::{accept_revocation_list, ListAccept, DEVICE_CLOCK_SKEW_MS};
    slot.with_rev(|m| m.last_try_at = Some(now));
    let fail = |code: &'static str| {
        slot.with_rev(|m| {
            m.last_error = Some(code);
            m.last_result = Some("failed");
        });
        json!({ "ok": false, "error": code, "revocation": revocation_status(slot, now) })
    };
    let id = match keys.store_identity() {
        Ok(id) => id,
        Err(m) => return fail(m.code()),
    };
    let armed = slot.state().filter(|st| st.store_key == id.store_key);
    let current = armed.as_ref().and_then(|st| st.revocation.lock().ok().and_then(|l| l.clone())).or_else(|| keys.revocation_list());
    match accept_revocation_list(current.as_ref(), raw, &id.store_key, &id.store_id) {
        Err(r) => fail(r.code()),
        Ok(ListAccept::KeptCurrent) => {
            slot.with_rev(|m| {
                m.last_result = Some("kept-current");
                m.last_error = None;
            });
            json!({ "ok": true, "changed": false, "revocation": revocation_status(slot, now) })
        }
        Ok(ListAccept::Newer(list, info)) => {
            if info.issued_at > now + DEVICE_CLOCK_SKEW_MS {
                return fail("not-yet");
            }
            if keys.save_revocation_list(&list).is_err() {
                return fail("save-failed");
            }
            if let Some(st) = armed {
                if let Ok(mut g) = st.revocation.lock() {
                    *g = Some(list);
                }
            }
            slot.with_rev(|m| {
                m.seq = Some(info.seq);
                m.issued_at = Some(info.issued_at);
                m.last_ok_at = Some(now);
                m.last_result = Some("updated");
                m.last_error = None;
            });
            json!({ "ok": true, "changed": true, "revocation": revocation_status(slot, now) })
        }
    }
}

/// 철회 목록 상태 — 갱신 시각·마감·실패를 정직하게.
pub fn revocation_status(slot: &LanSlot, now: i64) -> Value {
    use crate::lan_cert::{DEVICE_CLOCK_SKEW_MS, REVOCATION_LIST_MAX_AGE_MS};
    let m = slot.rev_meta();
    let present = m.issued_at.is_some();
    let stale = m.issued_at.map_or(true, |t| now - t > REVOCATION_LIST_MAX_AGE_MS);
    let future = m.issued_at.is_some_and(|t| t > now + DEVICE_CLOCK_SKEW_MS);
    let rejects_all = !present || stale || future;
    let say = if !present {
        "기기 확인 목록이 없어 모든 기기를 막고 있어요. 「기기 연결」에서 목록을 새로 만들어 주세요."
    } else if rejects_all {
        "기기 확인 목록이 하루가 지나 모든 기기를 막고 있어요. 이 컴퓨터에서 목록을 다시 확인해 주세요."
    } else {
        "기기 확인 목록이 최신이에요."
    };
    json!({
        "present": present,
        "seq": m.seq,
        "issuedAt": m.issued_at,
        "refreshBy": m.issued_at.map(|t| t + REVOCATION_LIST_MAX_AGE_MS),
        "ageMs": m.issued_at.map(|t| now - t),
        "stale": stale,
        "rejectsAll": rejects_all,
        "lastTryAt": m.last_try_at,
        "lastOkAt": m.last_ok_at,
        "lastResult": m.last_result,
        "lastError": m.last_error,
        // 다시 서명은 사장 확인창을 거친다 — 저절로 되지 않는다.
        "autoRefresh": false,
        "say": say,
    })
}

/// 화면이 읽는 상태. 비밀 값(열쇠·목록 본문)은 싣지 않는다. 파일을 읽지 않는다(메모리만).
pub fn status_json(slot: &LanSlot) -> Value {
    status_json_at(slot, now_ms())
}
pub fn status_json_at(slot: &LanSlot, now: i64) -> Value {
    let m = slot.mount_state();
    json!({ "state": m.code(), "on": m == MountState::On, "say": m.say(), "revocation": revocation_status(slot, now) })
}

/// 가게 키 PC 화면이 새로 서명한 철회 목록을 넣는 길(`device-connect.ts resignList` 뒤에 부른다).
/// 스위치가 꺼져 있어도 저장해 둔다 — 켤 때 그 목록으로 시작한다. 목록은 서명된 공개 문서라 비밀이 아니다.
#[tauri::command]
pub fn lan_revocation_update(state: tauri::State<'_, crate::server::ServerState>, list: Value) -> Value {
    update_revocation(&state.lan_slot(), &FileLanKeys::new(lan_dir()), &list, now_ms())
}

/// 같은 와이파이 기기 복사 상태(읽기만).
#[tauri::command]
pub fn lan_sync_status(state: tauri::State<'_, crate::server::ServerState>) -> Value {
    status_json(&state.lan_slot())
}

/// 가게 번호를 LAN 복사용으로 적는다. 가게 키는 화면이 주지 않는다 — Rust 가 12단어에서 직접 뽑는다(앱 잠금 중 거절).
#[tauri::command]
pub async fn lan_store_set(store_id: String) -> Result<Value, String> {
    if crate::app_lock::is_locked() {
        return Err(crate::storesign::ERR_LOCKED.into());
    }
    if !is_sha_hex(&store_id) {
        return Err("가게 번호 모양이 맞지 않아요.".into());
    }
    let (mut w, mut p) = crate::identity::words_async().await.map_err(crate::identity::SeedFailure::public_error)?;
    let id = store_identity_from_words(&mut w, &mut p, &store_id).map_err(String::from)?;
    FileLanKeys::new(lan_dir()).save_store_identity(&id)?;
    Ok(json!({ "storeId": id.store_id, "fingerprint": crate::storesign::fingerprint(&id.store_key) }))
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::lan_seal::DataKey;
    use crate::lan_store::LanStore;

    pub(crate) fn vec() -> Value {
        serde_json::from_str(include_str!("../testdata/rv-lan-cert-vectors.json")).unwrap()
    }
    pub(crate) fn fixture(name: &str) -> PathBuf {
        use std::sync::atomic::AtomicU32;
        static N: AtomicU32 = AtomicU32::new(0);
        let d = crate::paths::test_fixture_root().join(format!("lan-m-{name}-{}", N.fetch_add(1, Ordering::SeqCst)));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }
    /// 합성 값만: 시험 벡터의 가게 공개키(개인키 0x11 반복으로 폰이 만든 것)·합성 데이터 열쇠.
    pub(crate) fn synthetic_state(dir: &Path, list: &str) -> LanServerState {
        let v = vec();
        let now = v["now"].as_i64().unwrap();
        let mut k = [0u8; 32];
        for (i, b) in k.iter_mut().enumerate() {
            *b = i as u8 + 1;
        }
        let store = LanStore::open(&dir.join("log"), now).unwrap();
        let mut st = LanServerState::new(v["storeKey"].as_str().unwrap().into(), DataKey { version: 3, key: k }, Some(v["lists"][list].clone()), store);
        st.clock = Box::new(move || now);
        st.seal_nonce = Box::new(|| [9u8; 24]);
        st
    }

    #[test]
    fn the_switch_is_off_unless_the_file_says_boolean_true() {
        let d = fixture("cfg");
        assert!(!read_config(&d).enabled, "파일 없음 = 꺼짐");
        for bad in ["{broken", "{\"lanSync\":\"true\"}", "{\"lanSync\":1}", "[]", "{\"lansync\":true}"] {
            std::fs::write(d.join(SETTINGS_FILE), bad).unwrap();
            assert!(!read_config(&d).enabled, "{bad}");
        }
        write_config(&d, true).unwrap();
        assert!(read_config(&d).enabled);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(std::fs::metadata(d.join(SETTINGS_FILE)).unwrap().permissions().mode() & 0o777, 0o600);
        }
        write_config(&d, false).unwrap();
        assert!(!read_config(&d).enabled);
    }

    #[test]
    fn off_never_reads_keys_and_makes_no_routes() {
        let slot = LanSlot::default();
        assert!(slot.router().is_none(), "기본 = 경로 없음");
        let called = std::cell::Cell::new(false);
        let m = slot.arm(&LanConfig::default(), || {
            called.set(true);
            Err(MountState::NoStore)
        });
        assert_eq!(m, MountState::Off);
        assert!(!called.get(), "꺼져 있으면 열쇠를 읽는 함수를 부르지 않는다");
        assert!(slot.router().is_none());
    }

    #[test]
    fn a_missing_piece_is_reported_and_mounts_nothing() {
        let slot = LanSlot::default();
        for m in [MountState::NoStore, MountState::BadStore, MountState::NoDataKey, MountState::BadDataKey, MountState::StoreFailed] {
            assert_eq!(slot.arm(&LanConfig { enabled: true }, || Err(m)), m);
            assert_eq!(slot.mount_state(), m);
            assert!(slot.router().is_none(), "{m:?}");
            assert!(!m.say().is_empty());
        }
    }

    #[test]
    fn arm_then_disarm_cuts_the_running_routes() {
        let d = fixture("arm");
        let slot = LanSlot::default();
        assert_eq!(slot.arm(&LanConfig { enabled: true }, || Ok(synthetic_state(&d, "empty"))), MountState::On);
        let st = slot.state().unwrap();
        assert!(slot.router().is_some());
        // 다시 켜도 같은 상태(로그 파일 잠금을 두 번 잡지 않는다).
        assert_eq!(slot.arm(&LanConfig { enabled: true }, || panic!("두 번 만들면 안 된다")), MountState::On);
        assert!(Arc::ptr_eq(&st, &slot.state().unwrap()));
        slot.arm(&LanConfig::default(), || panic!("꺼짐"));
        assert!(!st.live.load(Ordering::SeqCst), "끄면 이미 붙은 경로도 멈춘다");
        assert!(slot.router().is_none());
        assert_eq!(slot.mount_state(), MountState::Off);
        // 서버가 도는 중에 다시 켜면 같은 상태를 다시 쓴다(로그 잠금을 새로 잡지 않는다).
        assert_eq!(slot.arm(&LanConfig { enabled: true }, || panic!("새로 만들면 잠금 충돌")), MountState::On);
        assert!(st.live.load(Ordering::SeqCst));
    }

    /// 합성 공급자(시험 전용).
    pub(crate) struct SynthKeys {
        pub id: Result<StoreIdentity, MountState>,
        pub key: Result<DataKey, MountState>,
        pub list: Mutex<Option<Value>>,
    }
    impl LanKeySource for SynthKeys {
        fn store_identity(&self) -> Result<StoreIdentity, MountState> {
            self.id.clone()
        }
        fn data_key(&self) -> Result<DataKey, MountState> {
            self.key.clone()
        }
        fn revocation_list(&self) -> Option<Value> {
            self.list.lock().unwrap().clone()
        }
        fn save_revocation_list(&self, list: &Value) -> Result<(), String> {
            *self.list.lock().unwrap() = Some(list.clone());
            Ok(())
        }
    }
    pub(crate) fn synth() -> SynthKeys {
        let v = vec();
        SynthKeys {
            id: Ok(StoreIdentity::checked(v["storeId"].as_str().unwrap(), v["storeKey"].as_str().unwrap()).unwrap()),
            key: Ok(DataKey { version: 3, key: [7u8; 32] }),
            list: Mutex::new(Some(v["lists"]["empty"].clone())),
        }
    }

    #[test]
    fn build_state_needs_every_piece() {
        let d = fixture("build");
        let v = vec();
        let now = v["now"].as_i64().unwrap();
        let st = build_state(&synth(), &d.join("log"), now).unwrap();
        assert_eq!(st.store_key, v["storeKey"].as_str().unwrap());
        assert_eq!(st.data_key.version, 3);
        assert!(st.revocation.lock().unwrap().is_some());
        drop(st);
        let mut k = synth();
        k.id = Err(MountState::NoStore);
        assert_eq!(build_state(&k, &d.join("log2"), now).err(), Some(MountState::NoStore));
        let mut k = synth();
        k.key = Err(MountState::NoDataKey);
        assert_eq!(build_state(&k, &d.join("log3"), now).err(), Some(MountState::NoDataKey));
        // 로그 폴더를 다른 쪽이 쥐고 있으면 StoreFailed.
        let held = crate::lan_store::LanStore::open(&d.join("log4"), now).unwrap();
        assert_eq!(build_state(&synth(), &d.join("log4"), now).err(), Some(MountState::StoreFailed));
        drop(held);
    }

    #[test]
    fn file_keys_read_only_well_formed_files() {
        let d = fixture("files");
        let k = FileLanKeys::new(d.clone());
        assert_eq!(k.store_identity(), Err(MountState::NoStore));
        assert_eq!(k.data_key().err(), Some(MountState::NoDataKey));
        assert!(k.revocation_list().is_none());
        let v = vec();
        let id = StoreIdentity::checked(v["storeId"].as_str().unwrap(), v["storeKey"].as_str().unwrap()).unwrap();
        k.save_store_identity(&id).unwrap();
        assert_eq!(k.store_identity().unwrap(), id);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(std::fs::metadata(d.join(STORE_FILE)).unwrap().permissions().mode() & 0o777, 0o600);
        }
        for bad in [
            "{broken".to_string(),
            json!({ "v": 1, "storeId": "AB".repeat(32), "storeKey": v["storeKey"] }).to_string(),
            json!({ "v": 1, "storeId": v["storeId"], "storeKey": "02".to_string() + &"00".repeat(32) }).to_string(),
            json!({ "v": 2, "storeId": v["storeId"], "storeKey": v["storeKey"] }).to_string(),
            json!({ "v": 1, "storeId": v["storeId"], "storeKey": v["storeKey"], "x": 1 }).to_string(),
        ] {
            std::fs::write(d.join(STORE_FILE), &bad).unwrap();
            assert_eq!(k.store_identity(), Err(MountState::BadStore), "{bad}");
        }
        // 합성 데이터 열쇠 파일(시험 폴더 안에만).
        std::fs::write(d.join(DATA_KEY_FILE), json!({ "v": 1, "version": 2, "key": "07".repeat(32) }).to_string()).unwrap();
        let dk = k.data_key().unwrap();
        assert_eq!((dk.version, dk.key), (2, [7u8; 32]));
        for bad in [
            json!({ "v": 1, "version": 0, "key": "07".repeat(32) }),
            json!({ "v": 1, "version": 2, "key": "00".repeat(32) }),
            json!({ "v": 1, "version": 2, "key": "07".repeat(31) }),
            json!({ "v": 1, "version": "2", "key": "07".repeat(32) }),
            json!({ "v": 1, "version": 2, "key": "07".repeat(32), "seed": "x" }),
        ] {
            std::fs::write(d.join(DATA_KEY_FILE), bad.to_string()).unwrap();
            assert_eq!(k.data_key().err(), Some(MountState::BadDataKey), "{bad}");
        }
    }

    #[test]
    fn the_store_key_comes_from_the_words_not_from_the_screen() {
        // 공개 BIP39 시험 단어(합성) — storesign 시험과 같은 값.
        let mut w = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about".to_string();
        let mut p = String::new();
        let id = store_identity_from_words(&mut w, &mut p, &"ab".repeat(32)).unwrap();
        assert_eq!(id.store_key, "037821115dd0aa762d3a393fa861ce8e784403b9e0ec578bc37e72e6e9e70a1c09");
        assert!(!w.contains("abandon"), "단어는 쓰고 바로 지운다");
        let mut w = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about".to_string();
        assert!(store_identity_from_words(&mut w, &mut String::new(), "nothex").is_err());
    }

    #[test]
    fn status_carries_no_secret_values() {
        let d = fixture("status");
        let slot = LanSlot::default();
        assert_eq!(status_json(&slot)["state"], "off");
        slot.arm(&LanConfig { enabled: true }, || build_state(&synth(), &d.join("log"), vec()["now"].as_i64().unwrap()));
        let s = status_json(&slot).to_string();
        assert!(s.contains("\"on\":true"));
        assert!(!s.contains(&"07".repeat(32)) && !s.contains(vec()["storeKey"].as_str().unwrap()));
    }

    fn signed_list(seq: u64, issued: i64, revoked: &[&str]) -> Value {
        let v = vec();
        let body = json!({ "v": 1, "storeId": v["storeId"], "seq": seq, "revoked": revoked, "issuedAt": issued, "prunedBefore": 0 });
        crate::lan_cert::sign_doc(crate::lan_cert::DEVICE_REVOKE_DOMAIN, &body, v["storeKey"].as_str().unwrap(), crate::lan_cert::tests::synth_signer).unwrap()
    }
    fn pull(st: &LanServerState, n: u8) -> u16 {
        let v = vec();
        let body = json!({ "cert": v["certs"]["replica"], "cursor": 0, "nonce": format!("{:02x}", n).repeat(16) });
        crate::lan_handler::handle_pull(st, &serde_json::to_vec(&body).unwrap()).status
    }

    #[test]
    fn a_fresh_list_reopens_the_door_and_a_day_later_it_closes_again() {
        const DAY: i64 = 24 * 3600_000;
        let d = fixture("rev");
        let v = vec();
        let t0 = v["now"].as_i64().unwrap();
        let keys = synth();
        *keys.list.lock().unwrap() = Some(v["lists"]["stale"].clone()); // seq 3, 하루 넘게 낡음
        let slot = LanSlot::default();
        slot.arm(&LanConfig { enabled: true }, || build_state(&keys, &d.join("log"), t0).map(|mut st| {
            st.clock = Box::new(move || t0); // 시험 벡터 시각에 고정
            st
        }));
        slot.note_loaded_list();
        let st = slot.state().unwrap();
        let s = status_json_at(&slot, t0);
        assert_eq!(s["revocation"]["stale"], true);
        assert_eq!(s["revocation"]["rejectsAll"], true, "낡은 목록 = 모두 거절이라고 정직하게");
        assert_eq!(pull(&st, 1), 403);

        // 새로 서명한 목록(seq 4, 지금 시각) → 저장 → 바로 문이 열린다.
        let fresh = signed_list(4, t0, &[]);
        let r = update_revocation(&slot, &keys, &fresh, t0);
        assert_eq!(r["ok"], true, "{r}");
        assert_eq!(r["revocation"]["rejectsAll"], false);
        assert_eq!(r["revocation"]["refreshBy"], t0 + DAY);
        assert_eq!(keys.list.lock().unwrap().as_ref(), Some(&fresh), "디스크(공급자)에 먼저 저장");
        assert_eq!(pull(&st, 2), 200);

        // 하루가 지나면 상태가 다시 「모두 거절」.
        let later = t0 + DAY + 1;
        assert_eq!(status_json_at(&slot, later)["revocation"]["rejectsAll"], true);
    }

    #[test]
    fn a_failed_update_keeps_the_current_list_and_says_why() {
        let d = fixture("revfail");
        let v = vec();
        let t0 = v["now"].as_i64().unwrap();
        let keys = synth(); // empty 목록(seq 1, 신선)
        let slot = LanSlot::default();
        slot.arm(&LanConfig { enabled: true }, || build_state(&keys, &d.join("log"), t0));
        slot.note_loaded_list();
        let st = slot.state().unwrap();
        let before = st.revocation.lock().unwrap().clone();
        let a = "aa".repeat(32);
        // ① 서명이 틀린 목록
        let mut forged = signed_list(5, t0, &[]);
        forged["seq"] = json!(6);
        let r = update_revocation(&slot, &keys, &forged, t0);
        assert_eq!((r["ok"].clone(), r["error"].clone()), (json!(false), json!("signature")));
        // ② 미래 시각
        let r = update_revocation(&slot, &keys, &signed_list(5, t0 + 3_600_000, &[]), t0);
        assert_eq!(r["error"], "not-yet");
        // ③ 저장 실패
        struct NoSave(SynthKeys);
        impl LanKeySource for NoSave {
            fn store_identity(&self) -> Result<StoreIdentity, MountState> { self.0.store_identity() }
            fn data_key(&self) -> Result<DataKey, MountState> { self.0.data_key() }
            fn revocation_list(&self) -> Option<Value> { self.0.revocation_list() }
            fn save_revocation_list(&self, _: &Value) -> Result<(), String> { Err("disk".into()) }
        }
        let r = update_revocation(&slot, &NoSave(synth()), &signed_list(5, t0, &[a.as_str()]), t0);
        assert_eq!(r["error"], "save-failed");
        assert_eq!(*st.revocation.lock().unwrap(), before, "실패하면 지금 목록 그대로");
        assert_eq!(r["revocation"]["lastError"], "save-failed");
        assert_eq!(r["revocation"]["rejectsAll"], false, "지금 목록이 아직 신선하면 계속 받는다");
        // ④ 옛 번호는 바꾸지 않음(성공이지만 changed=false)
        let r = update_revocation(&slot, &keys, &v["lists"]["empty"], t0);
        assert_eq!((r["ok"].clone(), r["changed"].clone()), (json!(true), json!(false)));
        // ⑤ 가게 번호가 없으면
        let mut k = synth();
        k.id = Err(MountState::NoStore);
        assert_eq!(update_revocation(&slot, &k, &signed_list(9, t0, &[]), t0)["error"], "no-store");
        // 상태에 목록 본문·서명이 실리지 않는다.
        let s = status_json_at(&slot, t0).to_string();
        assert!(!s.contains(v["lists"]["empty"]["sig"].as_str().unwrap()));
    }

    #[test]
    fn a_saved_list_with_a_bad_signature_is_not_loaded() {
        let d = fixture("revbad");
        let v = vec();
        let keys = synth();
        let mut bad = v["lists"]["empty"].clone();
        bad["seq"] = json!(7);
        *keys.list.lock().unwrap() = Some(bad);
        let st = build_state(&keys, &d.join("log"), v["now"].as_i64().unwrap()).unwrap();
        assert!(st.revocation.lock().unwrap().is_none(), "망가진 목록은 없는 것으로 = 모두 거절");
    }

    #[test]
    fn while_off_an_update_is_saved_for_later_without_mounting() {
        let v = vec();
        let t0 = v["now"].as_i64().unwrap();
        let keys = synth();
        *keys.list.lock().unwrap() = None;
        let slot = LanSlot::default();
        let r = update_revocation(&slot, &keys, &signed_list(2, t0, &[]), t0);
        assert_eq!(r["ok"], true, "{r}");
        assert!(keys.list.lock().unwrap().is_some());
        assert!(slot.router().is_none(), "목록을 넣어도 스위치는 그대로 꺼짐");
    }
}
