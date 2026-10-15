//! LAN 동기화 ⑤ — 기존 폰 서버(8790)에 `/lan/push`·`/lan/pull` 을 붙이는 자리와 켜기 스위치.
//!
//! 🔴 새 포트·새 listen 없음. `server.rs` 의 `build_phone_router` 가 이미 `0.0.0.0:8790` 에 묶는 그 라우터에
//!    `lan_handler::router` 조각을 `merge` 할 뿐이다. 바깥(터널)에서 온 `/lan/*` 은 원격 관리를 켜도 막는다(`server::outside_blocked`).
//! 🔴 기본 꺼짐. 앱 폴더 `lan/settings.json` 의 `lanSync` 가 **불리언 true** 일 때만 켠다(`LanConfig::from_json`).
//!    파일이 없거나 모양이 틀리면 꺼짐. 꺼져 있으면 열쇠 파일은 **읽지도 않는다**.
//! 🔴 끄면 이미 붙은 경로도 곧바로 404(`LanServerState::live`). 켜기는 폰 서버를 다시 켤 때 반영된다(라우터는 시작 때 한 번 만든다).
//! 🔴 켜기/다시 켜기마다 가게 번호·가게 키·데이터 열쇠·철회 목록 파일을 **다시 읽는다**. 지문이 같으면 그대로, 다르면 재료를 바꾸고,
//!    가게 번호가 바뀌면 그 가게의 로그(`lan/log/<가게 번호>/`)로 저장소까지 바꾼다 — 옛 가게 로그와 새 가게 증서가 섞이지 않는다.
//!    다시 읽다 실패하면(파일 망가짐 등) 붙어 있던 경로도 멈춘다(닫힌 실패).
//! 🔴 v2 열쇠 기록(`lan/keys.json`, 규격 §4): 데이터 열쇠 판·기기별 세션 열쇠·회전 메타·회전 때 철회 목록을 한 파일에.
//!    읽는 시점 = 켜기·다시 켜기·회전 저장 직후. 받는 조건(§4.2) — 목록 서명·가게, 메타 = 그 목록, 철회된 세션 없음(`LanKeyRecord::check`),
//!    판 단조·목록 seq 단조(`check_against`). 조건을 못 넘은 **새** 기록은 받지 않고 지금 상태를 그대로 두며 화면에 이유를 보인다.
//!    회전 관문(§4.3)은 요청마다 처리기가 본다(503 rotation-required) — 여기서는 상태에 「멈춤」을 정직하게 보인다.

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
    /// 열쇠 기록이 받는 조건(§4.2)을 못 넘었다 — 목록 서명·메타·철회된 세션.
    KeysRejected,
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
            Self::KeysRejected => "keys-rejected",
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
            Self::KeysRejected => "데이터 열쇠 기록이 철회 목록과 맞지 않아 쓰지 않았어요. 기기 연결 화면에서 열쇠를 다시 바꿔 주세요.",
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
    /// 철회 목록 갱신(읽기→판정→저장→교체)과 켜기(재료 다시 읽기)를 한 줄로 세운다(L5).
    serial: Mutex<()>,
    /// 마지막으로 받지 않은 열쇠 기록의 이유(지금 상태는 그대로 둔다 — §4.2). 받으면 지운다.
    keys_err: Mutex<Option<&'static str>>,
}

/// 켜기에 쓸 재료(디스크에서 막 읽은 것). 저장소는 아직 열지 않았다 — 같은 가게면 지금 것을 그대로 쓴다.
pub struct LanMaterial {
    pub auth: crate::lan_handler::LanAuth,
    /// 이 가게의 로그 폴더(가게 번호별).
    pub log_dir: PathBuf,
    pub now_ms: i64,
    /// 시험 전용: 새 상태의 시계를 고정한다.
    pub clock: Option<Box<dyn Fn() -> i64 + Send + Sync>>,
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
    /// 서버가 도는 동안 다시 켜면 같은 상태를 다시 쓴다(옛 라우터가 같은 상태를 쥐고 있다).
    pub fn disarm(&self) {
        if let Some(st) = self.state() {
            st.live.store(false, Ordering::SeqCst);
        }
        self.set_mount(MountState::Off);
    }
    /// 켠다. 스위치가 꺼져 있으면 `make` 를 부르지 않는다(열쇠 파일을 읽지 않는다).
    /// 켜져 있으면 **매번** `make` 로 재료를 새로 읽어 지금 상태와 맞춘다(M1):
    ///   지문 같음 → 그대로 · 같은 가게 → 재료만 교체 · 다른 가게 → 그 가게 로그로 저장소까지 교체 · 고장 난 저장소 → 다시 열어 복구.
    /// 읽기·열기에 실패하면 이미 붙은 경로도 멈추고(live=false) 그 이유를 돌려준다.
    pub fn arm<F>(&self, cfg: &LanConfig, make: F) -> MountState
    where
        F: FnOnce() -> Result<LanMaterial, MountState>,
    {
        if !cfg.enabled {
            self.disarm();
            return MountState::Off;
        }
        let _serial = self.serial.lock().unwrap_or_else(|p| p.into_inner());
        let cur = self.state();
        let stop = |m: MountState| {
            if let Some(st) = &cur {
                st.live.store(false, Ordering::SeqCst);
            }
            self.set_mount(m);
            m
        };
        let mat = match make() {
            Ok(m) => m,
            Err(MountState::On) => return stop(MountState::StoreFailed),
            Err(m) => return stop(m),
        };
        match &cur {
            None => {
                let store = match crate::lan_store::LanStore::open(&mat.log_dir, mat.now_ms) {
                    Ok(s) => s,
                    Err(_) => return stop(MountState::StoreFailed),
                };
                let mut st = LanServerState::new(mat.auth, store);
                if let Some(c) = mat.clock {
                    st.clock = c;
                }
                if let Ok(mut g) = self.state.lock() {
                    *g = Some(Arc::new(st));
                }
            }
            Some(st) => {
                let (same_store, failed) = st.store.lock().map(|s| (s.store_id == mat.auth.store_id && s.log_dir() == mat.log_dir, s.is_failed())).unwrap_or((false, true));
                if same_store {
                    if failed {
                        let ok = st.store.lock().map(|mut s| s.recover(mat.now_ms).is_ok()).unwrap_or(false);
                        if !ok {
                            return stop(MountState::StoreFailed);
                        }
                    }
                    if st.auth().fingerprint() != mat.auth.fingerprint() {
                        // §4.2 ①② — 열쇠 판·목록 seq 는 뒤로 가지 않는다. 못 넘으면 지금 상태(검증된 옛 기록)를 그대로 두고 이유만 남긴다.
                        if let Err(code) = accept_newer(&st.auth(), &mat.auth) {
                            self.set_keys_err(Some(code));
                            st.live.store(true, Ordering::SeqCst);
                            self.set_mount(MountState::On);
                            return MountState::On;
                        }
                        if st.replace_auth(mat.auth).is_err() {
                            return stop(MountState::StoreFailed);
                        }
                    }
                } else {
                    // 가게가 바뀌었다 — 새 가게의 로그를 연다(가게별 폴더라 옛 잠금과 부딪치지 않는다).
                    st.live.store(false, Ordering::SeqCst);
                    let store = match crate::lan_store::LanStore::open(&mat.log_dir, mat.now_ms) {
                        Ok(s) => s,
                        Err(_) => return stop(MountState::StoreFailed),
                    };
                    st.replace_store_and_auth(mat.auth, store);
                }
                st.live.store(true, Ordering::SeqCst);
            }
        }
        self.set_mount(MountState::On);
        self.set_keys_err(None);
        drop(_serial);
        self.note_loaded_list();
        MountState::On
    }
    fn set_keys_err(&self, e: Option<&'static str>) {
        if let Ok(mut g) = self.keys_err.lock() {
            *g = e;
        }
    }
    pub fn keys_error(&self) -> Option<&'static str> {
        self.keys_err.lock().ok().and_then(|g| *g)
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
/// 열쇠 기록 v2(`lan_keys::LanKeyRecord` — 데이터 열쇠·세션 표·회전 메타·회전 때 철회 목록). 옛 v1 `data-key.json` 은 읽지 않는다
/// (v1 와이어를 받지 않으므로 세션 표 없는 열쇠는 쓸 곳이 없다 — 그 파일을 만든 코드도 없었다).
pub const DATA_KEY_FILE: &str = "keys.json";
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
    /// 열쇠 기록(모양만 확인된 것). 없으면 NoDataKey, 모양이 틀리면 BadDataKey.
    fn key_record(&self) -> Result<crate::lan_keys::LanKeyRecord, MountState>;
    /// 열쇠 기록 저장(0600·원자적: 임시 파일 → fsync → 이름 바꾸기 → 폴더 fsync).
    fn save_key_record(&self, record: &Value) -> Result<(), String>;
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
    /// 모양: `lan_keys::LanKeyRecord::parse`(v:2). 🔴 이 파일을 처음 만드는 코드(데이터 열쇠 생성·회전)는 아직 없다(결정 대기).
    fn key_record(&self) -> Result<crate::lan_keys::LanKeyRecord, MountState> {
        match self.read(DATA_KEY_FILE) {
            None => Err(MountState::NoDataKey),
            Some(Err(())) => Err(MountState::BadDataKey),
            Some(Ok(v)) => crate::lan_keys::LanKeyRecord::parse(&v).map_err(|_| MountState::BadDataKey),
        }
    }
    fn save_key_record(&self, record: &Value) -> Result<(), String> {
        let doc = serde_json::to_vec(record).map_err(|_| "열쇠 기록을 저장하지 못했어요.".to_string())?;
        crate::server::atomic_write_0600(&self.dir.join(DATA_KEY_FILE), &doc).map_err(|_| "열쇠 기록을 저장하지 못했어요.".to_string())
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

/// 공급자에서 켜기 재료를 만든다(파일을 다시 읽는다). 하나라도 빠지면 그 이유(경로는 만들지 않음).
/// 로그 폴더는 가게 번호별: `<log_root>/<가게 번호>/`.
pub fn build_material(keys: &dyn LanKeySource, log_root: &Path, now_ms: i64) -> Result<LanMaterial, MountState> {
    let id = keys.store_identity()?;
    let record = keys.key_record()?;
    // §4.2 ③④ + 함께 저장된 목록의 서명·가게. 못 넘으면 이 기록은 쓰지 않는다.
    record.check(&id.store_key, &id.store_id).map_err(|_| MountState::KeysRejected)?;
    // 저장해 둔 목록도 가게 키 서명·가게 번호를 다시 본다. 못 넘으면 없는 것으로(= 모든 증서 거절, 닫힌 실패).
    let disk = keys.revocation_list().filter(|l| crate::lan_cert::verify_revocation_list(l, &id.store_key, &id.store_id).is_ok());
    // 회전 저장은 열쇠 기록(목록 동봉)을 먼저, revocation.json 을 나중에 쓴다. 그 사이에 멈췄으면 기록 쪽 목록이 더 새것 —
    // 받기 규칙(후퇴·되살리기 금지)으로 더 새것을 고르고 디스크 목록도 맞춰 둔다(실패해도 메모리는 새 목록 — 다음 켜기 때 다시).
    let list = match crate::lan_cert::accept_revocation_list(disk.as_ref(), &record.revocations, &id.store_key, &id.store_id) {
        Ok(crate::lan_cert::ListAccept::Newer(l, _)) if disk.as_ref() != Some(&l) => {
            let _ = keys.save_revocation_list(&l);
            Some(l)
        }
        Ok(_) => disk.or_else(|| Some(record.revocations.clone())),
        Err(_) => return Err(MountState::KeysRejected),
    };
    let log_dir = log_root.join(&id.store_id);
    let auth = crate::lan_handler::LanAuth::new(id.store_key, id.store_id, record, list);
    Ok(LanMaterial { auth, log_dir, now_ms, clock: None })
}

fn now_ms() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_millis() as i64)
}

/// `start_phone_server` 가 부른다. 스위치가 꺼져 있으면(기본) 아무 파일도 더 읽지 않는다.
pub fn arm_from_disk(slot: &LanSlot) -> MountState {
    let dir = lan_dir();
    let cfg = read_config(&dir);
    slot.arm(&cfg, || build_material(&FileLanKeys::new(dir.clone()), &dir.join(LOG_DIR), now_ms()))
}

// ── ③ 철회 목록 갱신 ────────────────────────────────────────
//
// 규칙(core 와 같음): 목록이 없거나 서명 시각이 24시간을 넘으면 **모든 증서를 거절**한다(`lan_cert` stale-revocation-list).
// 그래서 가게 키 PC 가 하루 안에 같은 목록을 seq+1 로 다시 서명해 이 길로 넣어 줘야 한다.
// 🔴 자동 재서명은 없다: 가게 키 서명은 매번 사장 확인창을 거친다(`storesign::store_sign_digest`). 화면은 `refreshBy` 전에 사장에게 묻는다.
// 실패하면 지금 목록을 그대로 둔다(망가진/옛 목록으로 바꾸지 않는다). 지금 목록이 낡았으면 그대로 「모두 거절 중」이라고 보인다.

/// §4.2 ①② — 같은 가게의 지금 재료(`cur`)에서 새 재료(`next`)로 바꿔도 되나: 열쇠 기록이 뒤로 가지 않고, 목록 seq 도 뒤로 가지 않는다.
fn accept_newer(cur: &crate::lan_handler::LanAuth, next: &crate::lan_handler::LanAuth) -> Result<(), &'static str> {
    next.keys.check_against(&cur.keys).map_err(|e| e.code())?;
    match (cur.revocation_info(), next.revocation_info()) {
        (Some(a), Some(b)) if b.seq < a.seq => Err("keys-list-rollback"),
        (Some(_), None) if next.revocation().is_some() => Err("keys-list"),
        _ => Ok(()),
    }
}

/// 회전 결과를 저장하고 바로 쓴다(규격 §4.1 ②③). `record` = 열쇠 기록 v2(새 데이터 열쇠·남은 기기 세션·새 철회 목록 동봉).
/// 순서: 모양 → §4.2 ③④(목록 서명·메타·철회된 세션 없음) → 지금 기록보다 새 판인지(①②) → **열쇠 기록 원자 저장**(임시 → fsync →
/// 이름 바꾸기 → 폴더 fsync) → 철회 목록 저장 → 켜져 있으면 재료를 한 번에 교체(옛 열쇠·옛 세션은 떨어지며 지워진다).
/// 🔴 회전 자체(새 데이터 열쇠 만들기·봉투 봉인·가게 키 서명)는 이 함수 밖이다 — 그 코드는 아직 없다(결정 표 L-6).
pub fn save_rotation(slot: &LanSlot, keys: &dyn LanKeySource, record: &Value) -> Value {
    let _serial = slot.serial.lock().unwrap_or_else(|p| p.into_inner());
    let fail = |code: &'static str| json!({ "ok": false, "error": code });
    let id = match keys.store_identity() {
        Ok(id) => id,
        Err(m) => return fail(m.code()),
    };
    let rec = match crate::lan_keys::LanKeyRecord::parse(record) {
        Ok(r) => r,
        Err(e) => return fail(e.code()),
    };
    if let Err(e) = rec.check(&id.store_key, &id.store_id) {
        return fail(e.code());
    }
    let next = crate::lan_handler::LanAuth::new(id.store_key.clone(), id.store_id.clone(), rec.clone(), Some(rec.revocations.clone()));
    let armed = slot.state().filter(|st| {
        let a = st.auth();
        a.store_key == id.store_key && a.store_id == id.store_id
    });
    // 지금 기준: 켜진 상태가 있으면 그것, 없으면 디스크의 기록(있으면).
    let current = armed.as_ref().map(|st| st.auth()).or_else(|| {
        keys.key_record().ok().map(|r| Arc::new(crate::lan_handler::LanAuth::new(id.store_key.clone(), id.store_id.clone(), r, keys.revocation_list())))
    });
    if let Some(cur) = &current {
        if let Err(code) = accept_newer(cur, &next) {
            return fail(code);
        }
    }
    if keys.save_key_record(&rec.to_json()).is_err() {
        return fail("save-failed");
    }
    // 목록은 열쇠 기록에도 들어 있으므로 여기서 실패해도 다음 켜기 때 기록 쪽 목록을 고른다(build_material).
    let list_saved = keys.save_revocation_list(&rec.revocations).is_ok();
    if let Some(st) = &armed {
        if st.replace_auth(next).is_err() {
            return fail("other-store");
        }
    }
    slot.set_keys_err(None);
    slot.note_loaded_list();
    json!({ "ok": true, "keyVersion": rec.key_version(), "sessions": rec.sessions.len(), "listSaved": list_saved, "applied": armed.is_some() })
}

/// 열쇠 상태(비밀 값 없음): 판·세션 수·회전 관문·마지막 거절 이유.
pub fn keys_status(slot: &LanSlot) -> Value {
    let Some(st) = slot.state() else { return json!({ "present": false, "lastError": slot.keys_error() }) };
    let a = st.auth();
    let gate = if a.gate_ok() { "ok" } else { "rotation-required" };
    let say = if a.gate_ok() {
        "기기별 열쇠가 철회 목록과 맞아요."
    } else {
        "끊은 기기가 있는데 데이터 열쇠를 아직 바꾸지 않아 자동 복사를 멈췄어요. 기기 연결 화면에서 열쇠를 바꿔 주세요."
    };
    json!({
        "present": true,
        "keyVersion": a.key_version(),
        "sessions": a.keys.sessions.len(),
        "revocationSeq": a.keys.revocation_seq,
        "gate": gate,
        "lastError": slot.keys_error(),
        "say": say,
    })
}

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
        let auth = st.auth();
        let info = auth.revocation_info().cloned();
        self.with_rev(|m| {
            m.seq = info.as_ref().map(|i| i.seq);
            m.issued_at = info.as_ref().map(|i| i.issued_at);
        });
    }
}

/// 새로 서명된 철회 목록을 받는다. 순서: 가게 확인 → core 받기 규칙(후퇴·되살리기 금지) → 미래 시각 거절 → **디스크 저장 성공** → 메모리 교체.
/// 읽기(지금 목록)→판정→저장→교체를 `serial` 잠금 하나로 묶는다(L5) — 동시에 두 목록이 들어와 낮은 번호가 덮어쓰지 않게.
pub fn update_revocation(slot: &LanSlot, keys: &dyn LanKeySource, raw: &Value, now: i64) -> Value {
    use crate::lan_cert::{accept_revocation_list, ListAccept, DEVICE_CLOCK_SKEW_MS};
    let _serial = slot.serial.lock().unwrap_or_else(|p| p.into_inner());
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
    // 켜진 상태가 **같은 가게(키와 번호 둘 다)** 일 때만 그 메모리 목록을 기준으로 삼고 바꾼다. 다른 가게로 켜져 있으면
    // 디스크에만 저장하고, 다음 켜기 때 재료를 다시 읽으며 가게째 바뀐다.
    let armed = slot.state().filter(|st| {
        let a = st.auth();
        a.store_key == id.store_key && a.store_id == id.store_id
    });
    let current = armed.as_ref().and_then(|st| st.revocation_list()).or_else(|| keys.revocation_list());
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
                st.set_revocation(Some(list));
            }
            slot.with_rev(|m| {
                m.seq = Some(info.seq);
                m.issued_at = Some(info.issued_at);
                m.last_ok_at = Some(now);
                m.last_result = Some("updated");
                m.last_error = None;
            });
            // 회전 없이 새로 철회된 증서가 있으면 관문이 닫힌다(처리기 503) — 화면이 바로 알 수 있게 열쇠 상태를 함께 싣는다.
            json!({ "ok": true, "changed": true, "revocation": revocation_status(slot, now), "keys": keys_status(slot) })
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
    json!({ "state": m.code(), "on": m == MountState::On, "say": m.say(), "revocation": revocation_status(slot, now), "keys": keys_status(slot) })
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
    use crate::lan_keys::LanKeyRecord;
    use crate::lan_store::LanStore;
    use crate::lan_testkit as kit;

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
    /// 합성 목록 이름 → 가게 키(0x11 합성)로 서명한 목록. empty = seq 1 빈 목록, stale = 하루 넘게 낡음.
    pub(crate) fn named_list(name: &str) -> Value {
        match name {
            "stale" => kit::list_at(1, kit::NOW - 25 * 3600_000, &[]),
            _ => kit::list(1, &[]),
        }
    }
    /// 합성 값만: 합성 가게(0x11)·합성 기기·합성 데이터 열쇠 판 3.
    pub(crate) fn synthetic_state(dir: &Path, list: &str) -> LanServerState {
        let store = LanStore::open(&dir.join("log"), kit::NOW).unwrap();
        let mut st = LanServerState::new(kit::auth(3, &kit::all(), &named_list(list)), store);
        st.clock = Box::new(|| kit::NOW);
        st.seal_nonce = Box::new(|| [9u8; 24]);
        st
    }
    /// 켜기 재료(합성). 시계는 시험 시각에 고정.
    pub(crate) fn synthetic_material(dir: &Path, list: &str) -> LanMaterial {
        LanMaterial { auth: kit::auth(3, &kit::all(), &named_list(list)), log_dir: dir.join("log"), now_ms: kit::NOW, clock: Some(Box::new(|| kit::NOW)) }
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
        assert_eq!(slot.arm(&LanConfig { enabled: true }, || Ok(synthetic_material(&d, "empty"))), MountState::On);
        let st = slot.state().unwrap();
        let auth0 = st.auth();
        assert!(slot.router().is_some());
        // 다시 켜면 재료를 다시 읽는다 — 같으면(지문 같음) 같은 상태·같은 재료 그대로(로그 잠금을 두 번 잡지 않는다).
        assert_eq!(slot.arm(&LanConfig { enabled: true }, || Ok(synthetic_material(&d, "empty"))), MountState::On);
        assert!(Arc::ptr_eq(&st, &slot.state().unwrap()));
        assert!(Arc::ptr_eq(&auth0, &st.auth()), "바뀐 것이 없으면 재료도 그대로");
        slot.arm(&LanConfig::default(), || panic!("꺼짐이면 파일을 읽지 않는다"));
        assert!(!st.live.load(Ordering::SeqCst), "끄면 이미 붙은 경로도 멈춘다");
        assert!(slot.router().is_none());
        assert_eq!(slot.mount_state(), MountState::Off);
        // 서버가 도는 중에 다시 켜면 같은 상태를 다시 쓴다.
        assert_eq!(slot.arm(&LanConfig { enabled: true }, || Ok(synthetic_material(&d, "empty"))), MountState::On);
        assert!(st.live.load(Ordering::SeqCst));
    }

    #[test]
    fn m1_rearm_rereads_keys_and_follows_a_new_data_key() {
        let d = fixture("rekey");
        let slot = LanSlot::default();
        slot.arm(&LanConfig { enabled: true }, || Ok(synthetic_material(&d, "empty")));
        let st = slot.state().unwrap();
        assert_eq!(pull(&st, 1), 200);
        // 데이터 열쇠 파일이 새 판으로 바뀌었다 → 다시 켜면 새 열쇠로.
        let mut m = synthetic_material(&d, "empty");
        m.auth = kit::auth(4, &kit::all(), &kit::list(1, &[]));
        assert_eq!(slot.arm(&LanConfig { enabled: true }, || Ok(m)), MountState::On);
        assert!(Arc::ptr_eq(&st, &slot.state().unwrap()), "옛 라우터가 쥔 같은 상태가 새 재료를 쓴다");
        assert_eq!(st.auth().key_version(), 4);
        assert_eq!(pull_v(&st, 9, 3), 410, "옛 판 요청은 열쇠 필요");
        assert_eq!(pull_v(&st, 10, 4), 200);
        // 철회 목록이 디스크에서 망가졌으면(서명 깨짐) 디스크 목록은 버리고, 열쇠 기록에 함께 서명돼 있는 목록을 쓴다.
        let v = vec();
        let mut bad = v["lists"]["empty"].clone();
        bad["seq"] = json!(41);
        let keys = synth();
        *keys.list.lock().unwrap() = Some(bad);
        *keys.key.lock().unwrap() = Ok(kit::record(4, &kit::all(), &kit::list(1, &[])));
        assert_eq!(slot.arm(&LanConfig { enabled: true }, || build_material(&keys, &d.join("log-root"), v["now"].as_i64().unwrap()).map(|mut m| {
            m.log_dir = d.join("log"); // 같은 가게·같은 로그
            m
        })), MountState::On);
        assert_eq!(st.revocation_list(), Some(kit::list(1, &[])), "망가진 디스크 목록 대신 기록 쪽 서명된 목록");
        assert_eq!(pull(&st, 2), 200);
        // 기록 쪽 목록까지 깨졌으면 그 기록은 받지 않는다 — 처음 켜기라면 경로를 만들지 않는다.
        let mut broken = kit::record(4, &kit::all(), &kit::list(1, &[])).to_json();
        broken["revocations"]["seq"] = json!(77);
        let bad_keys = synth();
        *bad_keys.key.lock().unwrap() = Ok(LanKeyRecord::parse(&broken).unwrap());
        assert_eq!(build_material(&bad_keys, &d.join("log-x"), kit::NOW).err(), Some(MountState::KeysRejected));
        // 다시 켤 때 열쇠 파일이 망가졌으면 붙어 있던 경로도 멈춘다(닫힌 실패).
        assert_eq!(slot.arm(&LanConfig { enabled: true }, || Err(MountState::BadDataKey)), MountState::BadDataKey);
        assert!(!st.live.load(Ordering::SeqCst));
        assert!(slot.router().is_none());
    }

    #[test]
    fn m1_a_new_store_number_swaps_the_log_and_refuses_old_store_certs() {
        let d = fixture("restore");
        let v = vec();
        let now = v["now"].as_i64().unwrap();
        let slot = LanSlot::default();
        slot.arm(&LanConfig { enabled: true }, || Ok(synthetic_material(&d, "empty")));
        let st = slot.state().unwrap();
        st.store.lock().unwrap().append_chunk(&"01".repeat(32), "x", &[json!({ "id": "aa".repeat(16), "origin": "bb".repeat(16), "seq": 1, "ts": 1, "kind": "draft", "data": 1 })]).unwrap();
        assert_eq!(st.store.lock().unwrap().len(), 1);
        // 같은 가게 키, 다른 가게 번호(B) — 목록은 B 것이 없다.
        let other = "cd".repeat(32);
        let m = LanMaterial {
            auth: crate::lan_handler::LanAuth::new(v["storeKey"].as_str().unwrap().into(), other.clone(), kit::record(3, &kit::all(), &kit::list(1, &[])), None),
            log_dir: d.join("log-b"),
            now_ms: now,
            clock: None,
        };
        assert_eq!(slot.arm(&LanConfig { enabled: true }, || Ok(m)), MountState::On);
        assert!(Arc::ptr_eq(&st, &slot.state().unwrap()));
        assert_eq!(st.auth().store_id, other);
        assert_eq!(st.store.lock().unwrap().store_id, other);
        assert_eq!(st.store.lock().unwrap().len(), 0, "B 가게는 A 가게 로그를 보지 않는다");
        // A 가게 증서는 B 상태에서 받지 않는다.
        let r = kit::post(&st, false, &kit::pull_req(&kit::replica(), 0, &"ab".repeat(16)));
        assert_eq!(r.status, 403);
        // A 로 되돌리면 A 로그가 다시 보인다(가게별 폴더 — 옛 잠금은 풀렸다).
        assert_eq!(slot.arm(&LanConfig { enabled: true }, || Ok(synthetic_material(&d, "empty"))), MountState::On);
        assert_eq!(st.store.lock().unwrap().len(), 1);
        assert_eq!(pull(&st, 3), 200);
    }

    #[test]
    fn m1_rearm_recovers_a_failed_store() {
        let d = fixture("recover");
        let slot = LanSlot::default();
        slot.arm(&LanConfig { enabled: true }, || Ok(synthetic_material(&d, "empty")));
        let st = slot.state().unwrap();
        st.store.lock().unwrap().fail_mode = Some(crate::lan_store::FailMode::WriteAndRollback);
        assert_eq!(pull(&st, 1), 500);
        assert_eq!(pull(&st, 2), 500, "복구 전에는 계속 실패");
        assert_eq!(slot.arm(&LanConfig { enabled: true }, || Ok(synthetic_material(&d, "empty"))), MountState::On);
        assert_eq!(pull(&st, 3), 200);
    }

    #[test]
    fn l5_revocation_updates_and_arming_share_one_lock() {
        // 갱신 도중(잠금 보유)에는 다른 갱신·켜기가 끼어들지 못한다: 잠금을 쥔 채 다른 스레드의 갱신이 끝나지 않는지 본다.
        let d = fixture("serial");
        let v = vec();
        let t0 = v["now"].as_i64().unwrap();
        let slot = Arc::new(LanSlot::default());
        slot.arm(&LanConfig { enabled: true }, || Ok(synthetic_material(&d, "empty")));
        let keys = Arc::new(synth());
        let held = slot.serial.lock().unwrap();
        let (s2, k2) = (slot.clone(), keys.clone());
        let fresh = signed_list(5, t0, &[]);
        let h = std::thread::spawn(move || update_revocation(&s2, &*k2, &fresh, t0));
        std::thread::sleep(std::time::Duration::from_millis(150));
        assert!(!h.is_finished(), "잠금을 쥔 동안 갱신이 진행되면 안 된다");
        drop(held);
        let r = h.join().unwrap();
        assert_eq!(r["changed"], true, "{r}");
        // 순서대로 들어온 낮은 번호는 높은 번호를 덮지 못한다.
        let r = update_revocation(&slot, &*keys, &signed_list(4, t0, &[]), t0);
        assert_eq!(r["changed"], false);
        assert_eq!(slot.state().unwrap().auth().revocation_info().unwrap().seq, 5);
    }

    #[test]
    fn l5_an_update_for_another_store_does_not_touch_the_running_state() {
        let d = fixture("revother");
        let v = vec();
        let t0 = v["now"].as_i64().unwrap();
        let slot = LanSlot::default();
        // 다른 가게 번호(cd..)로 켜져 있다.
        let m = LanMaterial {
            auth: crate::lan_handler::LanAuth::new(v["storeKey"].as_str().unwrap().into(), "cd".repeat(32), kit::record(3, &kit::all(), &kit::list(1, &[])), None),
            log_dir: d.join("log-b"),
            now_ms: t0,
            clock: None,
        };
        slot.arm(&LanConfig { enabled: true }, || Ok(m));
        let keys = synth(); // 디스크의 가게 = ab..
        let r = update_revocation(&slot, &keys, &signed_list(5, t0, &[]), t0);
        assert_eq!(r["ok"], true, "{r}");
        assert!(slot.state().unwrap().revocation_list().is_none(), "다른 가게 상태에 A 목록을 넣지 않는다");
        assert_eq!(keys.list.lock().unwrap().as_ref().unwrap()["seq"], 5, "디스크에는 저장");
    }

    /// 합성 공급자(시험 전용).
    pub(crate) struct SynthKeys {
        pub id: Result<StoreIdentity, MountState>,
        pub key: Mutex<Result<LanKeyRecord, MountState>>,
        pub list: Mutex<Option<Value>>,
    }
    impl LanKeySource for SynthKeys {
        fn store_identity(&self) -> Result<StoreIdentity, MountState> {
            self.id.clone()
        }
        fn key_record(&self) -> Result<LanKeyRecord, MountState> {
            self.key.lock().unwrap().clone()
        }
        fn save_key_record(&self, record: &Value) -> Result<(), String> {
            *self.key.lock().unwrap() = Ok(LanKeyRecord::parse(record).map_err(|e| e.code().to_string())?);
            Ok(())
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
            key: Mutex::new(Ok(kit::record(3, &kit::all(), &kit::list(1, &[])))),
            list: Mutex::new(Some(kit::list(1, &[]))),
        }
    }

    #[test]
    fn build_material_needs_every_piece() {
        let d = fixture("build");
        let v = vec();
        let now = v["now"].as_i64().unwrap();
        let m = build_material(&synth(), &d.join("log"), now).unwrap();
        assert_eq!(m.auth.store_key, v["storeKey"].as_str().unwrap());
        assert_eq!(m.auth.key_version(), 3);
        assert!(m.auth.revocation().is_some());
        assert_eq!(m.log_dir, d.join("log").join(v["storeId"].as_str().unwrap()), "로그는 가게 번호별 폴더");
        let mut k = synth();
        k.id = Err(MountState::NoStore);
        assert_eq!(build_material(&k, &d.join("log2"), now).err().map(|e| e), Some(MountState::NoStore));
        let k = synth();
        *k.key.lock().unwrap() = Err(MountState::NoDataKey);
        assert_eq!(build_material(&k, &d.join("log3"), now).err(), Some(MountState::NoDataKey));
        // 로그 폴더를 다른 쪽이 쥐고 있으면 켜기가 StoreFailed.
        let held = crate::lan_store::LanStore::open(&d.join("log4").join(v["storeId"].as_str().unwrap()), now).unwrap();
        let slot = LanSlot::default();
        assert_eq!(slot.arm(&LanConfig { enabled: true }, || build_material(&synth(), &d.join("log4"), now)), MountState::StoreFailed);
        drop(held);
    }

    #[test]
    fn file_keys_read_only_well_formed_files() {
        let d = fixture("files");
        let k = FileLanKeys::new(d.clone());
        assert_eq!(k.store_identity(), Err(MountState::NoStore));
        assert_eq!(k.key_record().err(), Some(MountState::NoDataKey));
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
        // 합성 열쇠 기록 파일(시험 폴더 안에만) — 저장은 0600·원자적.
        let rec = kit::record(2, &kit::all(), &kit::list(1, &[]));
        k.save_key_record(&rec.to_json()).unwrap();
        let got = k.key_record().unwrap();
        assert_eq!((got.key_version(), got.to_json()), (2, rec.to_json()));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(std::fs::metadata(d.join(DATA_KEY_FILE)).unwrap().permissions().mode() & 0o777, 0o600);
        }
        assert!(std::fs::read_dir(&d).unwrap().all(|e| !e.unwrap().file_name().to_string_lossy().ends_with(".tmp")), "임시 파일이 남지 않는다");
        let mut j0 = rec.to_json();
        j0["keyVersion"] = json!(0);
        let mut j1 = rec.to_json();
        j1["dataKey"] = json!("00".repeat(32));
        let mut j2 = rec.to_json();
        j2["keyVersion"] = json!("2");
        let mut j3 = rec.to_json();
        j3["seed"] = json!("x");
        for bad in [json!({ "v": 1, "version": 2, "key": "07".repeat(32) }), j0, j1, j2, j3] {
            std::fs::write(d.join(DATA_KEY_FILE), bad.to_string()).unwrap();
            assert_eq!(k.key_record().err(), Some(MountState::BadDataKey), "{bad}");
        }
        std::fs::write(d.join(DATA_KEY_FILE), "{broken").unwrap();
        assert_eq!(k.key_record().err(), Some(MountState::BadDataKey));
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
        slot.arm(&LanConfig { enabled: true }, || build_material(&synth(), &d.join("log"), vec()["now"].as_i64().unwrap()));
        let s = status_json(&slot).to_string();
        assert!(s.contains("\"on\":true"));
        assert!(!s.contains(&hex::encode(kit::data_key(3).key)) && !s.contains(vec()["storeKey"].as_str().unwrap()));
        assert!(!s.contains(&hex::encode(kit::replica().session)), "세션 열쇠도 싣지 않는다");
    }

    fn signed_list(seq: u64, issued: i64, revoked: &[&str]) -> Value {
        kit::list_at(seq, issued, revoked)
    }
    fn pull(st: &LanServerState, n: u8) -> u16 {
        pull_v(st, n, st.auth().key_version())
    }
    fn pull_v(st: &LanServerState, n: u8, version: u64) -> u16 {
        kit::post(st, false, &kit::pull_req_v(&kit::replica(), 0, &format!("{:02x}", n).repeat(16), version)).status
    }

    #[test]
    fn a_fresh_list_reopens_the_door_and_a_day_later_it_closes_again() {
        const DAY: i64 = 24 * 3600_000;
        let d = fixture("rev");
        let v = vec();
        let t0 = v["now"].as_i64().unwrap();
        let keys = synth();
        *keys.list.lock().unwrap() = Some(named_list("stale")); // seq 1, 하루 넘게 낡음
        let slot = LanSlot::default();
        slot.arm(&LanConfig { enabled: true }, || build_material(&keys, &d.join("log"), t0).map(|mut m| {
            m.clock = Some(Box::new(move || t0)); // 시험 벡터 시각에 고정
            m
        }));
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
        slot.arm(&LanConfig { enabled: true }, || build_material(&keys, &d.join("log"), t0));
        let st = slot.state().unwrap();
        let before = st.revocation_list();
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
            fn key_record(&self) -> Result<LanKeyRecord, MountState> { self.0.key_record() }
            fn save_key_record(&self, r: &Value) -> Result<(), String> { self.0.save_key_record(r) }
            fn revocation_list(&self) -> Option<Value> { self.0.revocation_list() }
            fn save_revocation_list(&self, _: &Value) -> Result<(), String> { Err("disk".into()) }
        }
        let r = update_revocation(&slot, &NoSave(synth()), &signed_list(5, t0, &[a.as_str()]), t0);
        assert_eq!(r["error"], "save-failed");
        assert_eq!(st.revocation_list(), before, "실패하면 지금 목록 그대로");
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
        let m = build_material(&keys, &d.join("log"), v["now"].as_i64().unwrap()).unwrap();
        assert_eq!(m.auth.revocation(), Some(&kit::list(1, &[])), "망가진 디스크 목록은 버리고 열쇠 기록의 서명된 목록");
        // 디스크에도 기록에도 쓸 목록이 없으면(기록 목록의 서명이 깨짐) 켜지 않는다.
        let mut j = kit::record(3, &kit::all(), &kit::list(1, &[])).to_json();
        j["revocations"]["revoked"] = json!(["aa".repeat(32)]);
        *keys.key.lock().unwrap() = Ok(LanKeyRecord::parse(&j).unwrap());
        assert_eq!(build_material(&keys, &d.join("log"), v["now"].as_i64().unwrap()).err(), Some(MountState::KeysRejected));
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

    // ── v2 회전 저장·다시 읽기 ───────────────────────────────────────

    fn armed(name: &str) -> (LanSlot, Arc<LanServerState>, SynthKeys, PathBuf) {
        let d = fixture(name);
        let keys = synth();
        let slot = LanSlot::default();
        assert_eq!(slot.arm(&LanConfig { enabled: true }, || build_material(&keys, &d.join("log"), kit::NOW).map(|mut m| {
            m.clock = Some(Box::new(|| kit::NOW));
            m
        })), MountState::On);
        let st = slot.state().unwrap();
        (slot, st, keys, d)
    }
    fn pull_as(st: &LanServerState, dev: &kit::Dev, n: u32, version: u64) -> (u16, Option<String>) {
        let r = kit::post(st, false, &kit::pull_req_v(dev, 0, &kit::nonce(n), version));
        (r.status, r.body["reason"].as_str().map(str::to_string))
    }

    /// 철회 + 회전을 한 번에 저장하면 즉시 새 판으로: 남은 기기는 새 판만, 끊긴 기기는 revoked, 옛 판은 410.
    #[test]
    fn v2_a_saved_rotation_swaps_keys_list_and_sessions_at_once() {
        let (slot, st, keys, _d) = armed("rotate");
        let (lost, me) = (kit::remote(), kit::replica());
        assert_eq!(pull_as(&st, &me, 1, 3).0, 200);
        let old = st.auth();
        let rotated = kit::record(4, &kit::all(), &kit::list(2, &[&lost.cert_id]));
        let r = save_rotation(&slot, &keys, &rotated.to_json());
        assert_eq!(r["ok"], true, "{r}");
        assert_eq!((r["keyVersion"].as_u64(), r["applied"].as_bool(), r["listSaved"].as_bool()), (Some(4), Some(true), Some(true)));
        let a = st.auth();
        assert!(!Arc::ptr_eq(&old, &a), "재료 한 벌이 통째로 바뀐다");
        assert_eq!((a.key_version(), a.revocation_info().unwrap().seq, a.gate_ok()), (4, 2, true));
        assert!(!a.keys.sessions.contains_key(&lost.cert_id), "끊긴 기기의 세션은 없다");
        assert_eq!(keys.key.lock().unwrap().as_ref().unwrap().to_json(), rotated.to_json(), "디스크(공급자)에 열쇠 기록");
        assert_eq!(keys.list.lock().unwrap().as_ref().unwrap()["seq"], 2, "디스크에 새 목록");
        assert_eq!(pull_as(&st, &me, 2, 3), (410, Some("key-version".into())), "옛 판 = 열쇠 필요");
        assert_eq!(pull_as(&st, &me, 3, 4).0, 200);
        assert_eq!(pull_as(&st, &lost, 4, 4), (403, Some("revoked".into())));
        assert_eq!(pull_as(&st, &lost, 5, 3), (403, Some("revoked".into())), "옛 열쇠를 쥐고 있어도");
        let s = status_json_at(&slot, kit::NOW);
        assert_eq!((s["keys"]["keyVersion"].as_u64(), s["keys"]["gate"].as_str()), (Some(4), Some("ok")));
        assert!(!s.to_string().contains(&hex::encode(rotated.data_key.key)), "상태에 열쇠 바이트 없음");
    }

    /// 받는 조건(§4.2)을 못 넘은 회전은 저장도 교체도 하지 않는다.
    #[test]
    fn v2_a_bad_rotation_is_refused_and_changes_nothing() {
        let (slot, st, keys, _d) = armed("rotbad");
        let lost = kit::remote();
        let good = kit::record(4, &kit::all(), &kit::list(2, &[&lost.cert_id]));
        assert_eq!(save_rotation(&slot, &keys, &good.to_json())["ok"], true);
        let before = st.auth().fingerprint();
        let saved = keys.key.lock().unwrap().as_ref().unwrap().to_json();
        let l2 = kit::list(2, &[&lost.cert_id]);
        // ① 같은 판에 다른 열쇠(되감기·덮어쓰기)
        let mut same = kit::record(4, &kit::all(), &l2);
        same.data_key.key[0] ^= 1;
        // ② 옛 판
        let older = kit::record(3, &kit::all(), &l2);
        // ③ 메타가 목록과 다름
        let mut meta = kit::record(5, &kit::all(), &l2);
        meta.revoked_at_rotation.clear();
        // ④ 철회된 기기의 세션이 남음
        let mut revoked_sess = kit::record(5, &kit::all(), &l2);
        revoked_sess.sessions.insert(lost.cert_id.clone(), crate::lan_keys::SessionEntry { key: crate::lan_keys::Secret32(lost.session), device_id: lost.device_id.clone(), cert_sig: lost.cert["sig"].as_str().unwrap().into() });
        // ⑤ 목록 서명 깨짐
        let mut forged = kit::record(5, &kit::all(), &l2).to_json();
        forged["revocations"]["revoked"] = json!([]);
        forged["revokedAtRotation"] = json!([]);
        // ⑥ 지금보다 옛 목록(seq 1)으로 회전
        let old_list = kit::record(5, &kit::all(), &kit::list(1, &[]));
        // ⑦ 모양
        let shape = json!({ "v": 1, "version": 5, "key": "07".repeat(32) });
        for (want, rec) in [
            ("keys-rollback", same.to_json()),
            ("keys-rollback", older.to_json()),
            ("keys-meta", meta.to_json()),
            ("keys-revoked-session", revoked_sess.to_json()),
            ("keys-list", forged),
            ("keys-list-rollback", old_list.to_json()),
            ("keys-shape", shape),
        ] {
            let r = save_rotation(&slot, &keys, &rec);
            assert_eq!((r["ok"].clone(), r["error"].as_str()), (json!(false), Some(want)), "{r}");
            assert_eq!(st.auth().fingerprint(), before, "{want}: 상태 그대로");
            assert_eq!(keys.key.lock().unwrap().as_ref().unwrap().to_json(), saved, "{want}: 디스크 그대로");
        }
        assert_eq!(pull_as(&st, &kit::replica(), 1, 4).0, 200);
    }

    /// 철회만 하고 회전을 안 하면(다른 화면·수동 편집) 동기화 전체가 503, 상태에도 「멈춤」. 회전을 저장하면 다시 열린다.
    #[test]
    fn v2_revoking_without_rotating_closes_the_gate_until_rotation() {
        let (slot, st, keys, _d) = armed("gate");
        let (lost, me) = (kit::remote(), kit::replica());
        let l2 = kit::list(2, &[&lost.cert_id]);
        let r = update_revocation(&slot, &keys, &l2, kit::NOW);
        assert_eq!(r["changed"], true, "{r}");
        assert_eq!(r["keys"]["gate"], "rotation-required", "갱신 응답에서 바로 보인다");
        assert_eq!(pull_as(&st, &me, 1, 3), (503, Some("rotation-required".into())));
        assert_eq!(status_json_at(&slot, kit::NOW)["keys"]["gate"], "rotation-required");
        // 다시 켜도(같은 디스크) 닫힌 그대로 — 조용히 넘어가지 않는다.
        assert_eq!(slot.arm(&LanConfig { enabled: true }, || build_material(&keys, &fixture("gate-x").join("log"), kit::NOW).map(|mut m| {
            m.log_dir = st.store.lock().unwrap().log_dir();
            m
        })), MountState::On);
        assert_eq!(pull_as(&st, &me, 2, 3).0, 503);
        let r = save_rotation(&slot, &keys, &kit::record(4, &kit::all(), &l2).to_json());
        assert_eq!(r["ok"], true, "{r}");
        assert_eq!(pull_as(&st, &me, 3, 4).0, 200);
        assert_eq!(status_json_at(&slot, kit::NOW)["keys"]["gate"], "ok");
    }

    /// 열쇠 기록은 저장됐는데 revocation.json 저장 전에 멈춘 경우: 다시 켜면 기록 쪽(더 새) 목록을 고른다 — 반쪽 회전이 남지 않는다.
    #[test]
    fn v2_a_crash_between_the_two_files_recovers_from_the_key_record() {
        let (slot, _st, keys, d) = armed("halfway");
        let lost = kit::remote();
        struct NoListSave<'a>(&'a SynthKeys);
        impl LanKeySource for NoListSave<'_> {
            fn store_identity(&self) -> Result<StoreIdentity, MountState> { self.0.store_identity() }
            fn key_record(&self) -> Result<LanKeyRecord, MountState> { self.0.key_record() }
            fn save_key_record(&self, r: &Value) -> Result<(), String> { self.0.save_key_record(r) }
            fn revocation_list(&self) -> Option<Value> { self.0.revocation_list() }
            fn save_revocation_list(&self, _: &Value) -> Result<(), String> { Err("disk".into()) }
        }
        let r = save_rotation(&slot, &NoListSave(&keys), &kit::record(4, &kit::all(), &kit::list(2, &[&lost.cert_id])).to_json());
        assert_eq!((r["ok"].as_bool(), r["listSaved"].as_bool()), (Some(true), Some(false)), "{r}");
        assert_eq!(keys.list.lock().unwrap().as_ref().unwrap()["seq"], 1, "디스크 목록은 옛것(멈춘 상황)");
        // 새 프로세스처럼 처음부터 켠다.
        let fresh = LanSlot::default();
        assert_eq!(fresh.arm(&LanConfig { enabled: true }, || build_material(&keys, &d.join("log2"), kit::NOW).map(|mut m| {
            m.clock = Some(Box::new(|| kit::NOW));
            m
        })), MountState::On);
        let st = fresh.state().unwrap();
        assert_eq!((st.auth().key_version(), st.auth().revocation_info().unwrap().seq, st.auth().gate_ok()), (4, 2, true));
        assert_eq!(keys.list.lock().unwrap().as_ref().unwrap()["seq"], 2, "디스크 목록도 기록 쪽으로 맞춘다");
        assert_eq!(pull_as(&st, &lost, 1, 4).1.as_deref(), Some("revoked"));
    }

    /// 다시 켤 때 디스크에 옛 판 기록이 놓여 있으면(되감기) 받지 않고, 지금 상태로 계속 받으며 이유를 보인다(§4.2).
    #[test]
    fn v2_rearm_never_goes_back_to_an_older_key_record() {
        let (slot, st, keys, d) = armed("rearm-old");
        let lost = kit::remote();
        let l2 = kit::list(2, &[&lost.cert_id]);
        assert_eq!(save_rotation(&slot, &keys, &kit::record(4, &kit::all(), &l2).to_json())["ok"], true);
        // 누군가 옛 기록(판 3, 목록 seq 1)을 디스크에 되돌려 놓았다.
        *keys.key.lock().unwrap() = Ok(kit::record(3, &kit::all(), &kit::list(1, &[])));
        let rearm = || slot.arm(&LanConfig { enabled: true }, || build_material(&keys, &d.join("log"), kit::NOW));
        assert_eq!(rearm(), MountState::On);
        assert_eq!(st.auth().key_version(), 4, "옛 기록으로 바꾸지 않는다");
        assert_eq!(status_json_at(&slot, kit::NOW)["keys"]["lastError"], "keys-rollback");
        assert_eq!(pull_as(&st, &kit::replica(), 1, 4).0, 200);
        assert_eq!(pull_as(&st, &lost, 2, 3).1.as_deref(), Some("revoked"));
        // 디스크가 다시 맞으면 이유가 지워진다.
        *keys.key.lock().unwrap() = Ok(kit::record(4, &kit::all(), &l2));
        assert_eq!(rearm(), MountState::On);
        assert!(status_json_at(&slot, kit::NOW)["keys"]["lastError"].is_null());
    }

    /// 실제 파일 공급자: 회전 저장은 keys.json(0600)·revocation.json 을 원자적으로 쓰고, 임시 파일을 남기지 않으며, 다시 읽으면 같은 재료.
    #[test]
    fn v2_file_keys_save_a_rotation_atomically() {
        let d = fixture("rotfiles");
        let k = FileLanKeys::new(d.clone());
        k.save_store_identity(&StoreIdentity::checked(&kit::store_id(), kit::STORE_KEY).unwrap()).unwrap();
        k.save_key_record(&kit::record(3, &kit::all(), &kit::list(1, &[])).to_json()).unwrap();
        k.save_revocation_list(&kit::list(1, &[])).unwrap();
        let slot = LanSlot::default();
        assert_eq!(slot.arm(&LanConfig { enabled: true }, || build_material(&k, &d.join(LOG_DIR), kit::NOW).map(|mut m| {
            m.clock = Some(Box::new(|| kit::NOW));
            m
        })), MountState::On);
        let lost = kit::remote();
        let rotated = kit::record(4, &kit::all(), &kit::list(2, &[&lost.cert_id]));
        assert_eq!(save_rotation(&slot, &k, &rotated.to_json())["ok"], true);
        let names: Vec<String> = std::fs::read_dir(&d).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().to_string()).collect();
        assert!(names.iter().all(|n| !n.ends_with(".tmp")), "{names:?}");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            for f in [DATA_KEY_FILE, REVOCATION_FILE] {
                assert_eq!(std::fs::metadata(d.join(f)).unwrap().permissions().mode() & 0o777, 0o600, "{f}");
            }
        }
        assert_eq!(k.key_record().unwrap().to_json(), rotated.to_json());
        assert_eq!(k.revocation_list().unwrap()["seq"], 2);
        // 다시 읽은 재료 = 지금 재료(지문 같음 → 그대로).
        let st = slot.state().unwrap();
        let a = st.auth();
        assert_eq!(slot.arm(&LanConfig { enabled: true }, || build_material(&k, &d.join(LOG_DIR), kit::NOW)), MountState::On);
        assert!(Arc::ptr_eq(&a, &st.auth()));
    }
}
