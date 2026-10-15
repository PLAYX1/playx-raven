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
}
