//! Phone AI spending: separate daily attempt budgets and bounded concurrency.
//! Persist before dispatch, including failed attempts. Never store request/key data.
use serde::{Deserialize, Serialize};
use std::{path::PathBuf, sync::{Arc, Mutex, OnceLock}};

pub const CUSTOMER_LIMIT: u32 = 200;
pub const OWNER_LIMIT: u32 = 200;
const BUSY_LIMIT: u32 = 2;
const LIMIT: &str = "[AI_LIMIT] 잠시 후 다시 물어봐 주세요. 오늘 사용 한도나 동시 실행 한도에 도달했습니다.";
const STORAGE: &str = "[AI_STORAGE] AI 사용량을 안전하게 저장하지 못했습니다. 설정 폴더를 확인하세요.";

#[derive(Clone, Copy)]
pub enum Lane { Customer, Owner }
impl Lane {
    fn index(self) -> usize { match self { Self::Customer => 0, Self::Owner => 1 } }
    fn limit(self) -> u32 { match self { Self::Customer => CUSTOMER_LIMIT, Self::Owner => OWNER_LIMIT } }
}

#[derive(Clone, Default, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Usage {
    day: i64,
    customer: u32,
    owner: u32,
    last_customer: i64,
}
impl Usage {
    fn count(&self, lane: Lane) -> u32 { match lane { Lane::Customer => self.customer, Lane::Owner => self.owner } }
    fn increment(&mut self, lane: Lane) { match lane { Lane::Customer => self.customer += 1, Lane::Owner => self.owner += 1 } }
    fn today(&mut self, now: i64) {
        let day = now - now % 86_400;
        if self.day != day { *self = Self { day, ..Self::default() }; }
    }
}
struct Inner { usage: Usage, busy: [u32; 2], broken: bool }
pub struct Budget { path: PathBuf, inner: Mutex<Inner> }

pub fn shared() -> Arc<Budget> {
    static BUDGET: OnceLock<Arc<Budget>> = OnceLock::new();
    BUDGET.get_or_init(|| Arc::new(Budget::load(crate::paths::app_file("ai-usage.json")))).clone()
}

impl Budget {
    fn load(path: PathBuf) -> Self {
        let doc = match std::fs::read(&path) {
            Ok(bytes) if bytes.len() <= 1024 => serde_json::from_slice::<Usage>(&bytes).ok()
                .filter(|u| u.day >= 0 && u.day % 86_400 == 0 && u.customer <= CUSTOMER_LIMIT && u.owner <= OWNER_LIMIT && u.last_customer >= 0),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Some(Usage::default()),
            _ => None,
        };
        let broken = doc.is_none();
        Self { path, inner: Mutex::new(Inner { usage: doc.unwrap_or_default(), busy: [0, 0], broken }) }
    }
    fn persist(&self, usage: &Usage) -> Result<(), String> {
        let bytes = serde_json::to_vec(usage).map_err(|_| STORAGE.to_string())?;
        crate::server::atomic_write_0600(&self.path, &bytes).map_err(|_| STORAGE.to_string())
    }
    pub fn begin(self: &Arc<Self>, lane: Lane) -> Result<Permit, String> {
        self.begin_at(lane, crate::server::now_unix())
    }
    fn begin_at(self: &Arc<Self>, lane: Lane, now: i64) -> Result<Permit, String> {
        let mut b = self.inner.lock().map_err(|_| STORAGE.to_string())?;
        if b.broken { return Err(STORAGE.into()); }
        b.usage.today(now);
        if b.usage.count(lane) >= lane.limit() || b.busy[lane.index()] >= BUSY_LIMIT { return Err(LIMIT.into()); }
        if matches!(lane, Lane::Customer) {
            if now - b.usage.last_customer < 3 { return Err(LIMIT.into()); }
            let mut next = b.usage.clone();
            next.last_customer = now;
            if let Err(e) = self.persist(&next) { b.broken = true; return Err(e); }
            b.usage = next;
        }
        b.busy[lane.index()] += 1;
        Ok(Permit { budget: self.clone(), lane })
    }
    pub fn counts(&self) -> (u32, u32) {
        let Ok(mut b) = self.inner.lock() else { return (CUSTOMER_LIMIT, OWNER_LIMIT) };
        if b.broken { return (CUSTOMER_LIMIT, OWNER_LIMIT); }
        b.usage.today(crate::server::now_unix());
        (b.usage.customer, b.usage.owner)
    }
}

/// Held for the entire fallback sequence; Drop also releases on cancellation.
pub struct Permit { budget: Arc<Budget>, lane: Lane }
impl Permit {
    pub fn charge(&self) -> Result<(), String> { self.charge_at(crate::server::now_unix()) }
    fn charge_at(&self, now: i64) -> Result<(), String> {
        let mut b = self.budget.inner.lock().map_err(|_| STORAGE.to_string())?;
        if b.broken { return Err(STORAGE.into()); }
        b.usage.today(now);
        if b.usage.count(self.lane) >= self.lane.limit() { return Err(LIMIT.into()); }
        let mut next = b.usage.clone();
        next.increment(self.lane);
        if let Err(e) = self.budget.persist(&next) { b.broken = true; return Err(e); }
        b.usage = next;
        Ok(())
    }
    pub fn left(&self) -> u32 {
        let Ok(mut b) = self.budget.inner.lock() else { return 0 };
        b.usage.today(crate::server::now_unix());
        self.lane.limit().saturating_sub(b.usage.count(self.lane))
    }
}
impl Drop for Permit {
    fn drop(&mut self) {
        if let Ok(mut b) = self.budget.inner.lock() { b.busy[self.lane.index()] = b.busy[self.lane.index()].saturating_sub(1); }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> (Arc<Budget>, PathBuf) {
        let path = std::env::temp_dir().join(format!("rv-ai-budget-{}", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
        (Arc::new(Budget::load(path.clone())), path)
    }
    #[test]
    fn attempts_failures_restart_and_lanes() {
        let (b, path) = fixture(); let now = 86_400 * 20 + 10;
        let customer = b.begin_at(Lane::Customer, now).unwrap();
        for _ in 0..CUSTOMER_LIMIT { customer.charge_at(now).unwrap(); }
        assert!(customer.charge_at(now).is_err());
        assert!(b.begin_at(Lane::Customer, now + 3).is_err());
        let owner = b.begin_at(Lane::Owner, now).unwrap(); owner.charge_at(now).unwrap();
        drop(owner); drop(customer); drop(b);
        let reloaded = Arc::new(Budget::load(path.clone()));
        assert!(reloaded.begin_at(Lane::Customer, now + 5).is_err());
        let owner = reloaded.begin_at(Lane::Owner, now).unwrap();
        assert_eq!(reloaded.inner.lock().unwrap().usage.owner, 1);
        owner.charge_at(now + 86_400).unwrap();
        assert_eq!(reloaded.inner.lock().unwrap().usage.customer, 0);
        #[cfg(unix)] { use std::os::unix::fs::PermissionsExt; assert_eq!(std::fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600); }
        assert!(!path.with_extension("tmp.tmp").exists());
        std::fs::remove_file(path).unwrap();
    }
    #[test]
    fn concurrency_rate_limit_and_drop() {
        let (b, path) = fixture(); let now = 86_400 * 20 + 10;
        let a = b.begin_at(Lane::Customer, now).unwrap();
        assert!(b.begin_at(Lane::Customer, now + 1).is_err());
        let c = b.begin_at(Lane::Customer, now + 3).unwrap();
        assert!(b.begin_at(Lane::Customer, now + 6).is_err());
        let owner = b.begin_at(Lane::Owner, now).unwrap();
        drop(a);
        assert!(b.begin_at(Lane::Customer, now + 6).is_ok());
        drop(c); drop(owner); std::fs::remove_file(path).unwrap();
    }
    #[test]
    fn storage_errors_stop_before_dispatch_and_do_not_refund() {
        let (b, path) = fixture(); let now = 86_400 * 20 + 10;
        let p = b.begin_at(Lane::Owner, now).unwrap();
        p.charge_at(now).unwrap();
        std::fs::remove_file(&path).unwrap(); std::fs::create_dir(&path).unwrap();
        assert!(p.charge_at(now).unwrap_err().starts_with("[AI_STORAGE]"));
        assert_eq!(b.inner.lock().unwrap().usage.owner, 1);
        std::fs::remove_dir(&path).unwrap();
        let _ = std::fs::remove_file(path.with_extension("tmp.tmp"));
        std::fs::write(&path, b"invalid").unwrap();
        assert!(Arc::new(Budget::load(path.clone())).begin_at(Lane::Owner, now).is_err());
        std::fs::remove_file(path).unwrap();
    }
}
