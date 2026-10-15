//! LAN 동기화 ③ — 추가만 되는 변경 로그 저장. 데스크탑(서버) 쪽.
//!
//! 한 파일(`lan-log.jsonl`)에 줄 단위로 덧붙이기만 한다(지우거나 고치지 않음). 줄 종류:
//!   {"t":"c","chunkId":<64hex>,"deviceId":<hex>,"entries":[...]}          받은 조각(push) — 조각 번호가 같으면 한 번만 반영
//!   {"t":"n","n":<nonce 32hex>,"at":<ms>,"x":<잊어도 되는 ms>,"d":<기기>}  쓴 요청 nonce — 같은 nonce 를 다시 쓰면 거절(재전송 방어)
//!     (옛 줄은 x·d 가 없다: x = at + NONCE_KEEP_MS 로 본다)
//!
//! 약속
//!  · 저장(쓰기 + sync_data)이 성공한 뒤에만 메모리에 반영하고 `Ok` 를 돌려준다. 저장이 실패하면 메모리는 그대로이고 오류를 돌려준다
//!    (처리기는 오류일 때 확인값 있는 성공 응답을 만들지 않는다).
//!  · 쓰다 실패한 꼬리를 되돌리지(set_len) 못하면 저장소는 **고장 상태**(Failed)가 된다. 그 뒤 모든 쓰기·읽기 요청은 Failed —
//!    다시 열어(`recover`) 꼬리를 정리하기 전에는 성공 응답이 나가지 않는다(뒤에 붙은 정상 줄이 성공으로 답했다가 재시작 때
//!    중간 깨짐(Corrupt)으로 저장소 전체가 안 열리는 일을 막는다).
//!  · 다시 열면 같은 상태로 돌아온다. 마지막 줄이 쓰다 만 것(끝 줄바꿈 없음)이면 그 줄만 버리고 파일을 그 앞까지 줄인다.
//!    중간 줄이 깨져 있으면 데이터를 조용히 잃지 않도록 열지 않는다(Corrupt).
//!  · 같은 항목 id 가 이미 있으면 처음 것을 지킨다(내용이 다르면 충돌). 처리기는 `conflicts` 로 미리 보고 충돌 조각을 통째로 거절한다.
//!  · nonce 는 그 요청에 쓰인 **증서가 끝나는 시각**(x)까지 기억한다 — 증서 최대 수명(30일)보다 먼저 잊으면 끝나지 않은 증서로 같은 요청을
//!    다시 낼 수 있다. 기기별·전체 개수 상한을 넘으면 기록하지 않고 Quota(처리기는 429).
//!  · 잊은 nonce 줄이 쌓이면 실행 중에도 압축한다(임시 파일은 처음부터 0600·create_new, 교체 뒤 폴더 fsync).
//!  · 한 번에 한 프로그램만 연다(파일 잠금).

#![allow(dead_code)] // 처리기(lan_handler)가 쓴다

use serde_json::{json, Value};
use std::collections::{BTreeSet, HashMap, HashSet};
use std::fs::{File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};

pub const LOG_FILE: &str = "lan-log.jsonl";
/// x 가 없는 옛 nonce 줄의 보관 기간 = 증서 최대 수명 + 시계 오차(이보다 짧으면 끝나지 않은 증서로 재전송 가능).
pub const NONCE_KEEP_MS: i64 = crate::lan_cert::DEVICE_CERT_MAX_MS + crate::lan_cert::DEVICE_CLOCK_SKEW_MS;
/// 기억 중인 nonce 상한 — 기기 하나 / 전체. 넘으면 새 요청을 받지 않는다(Quota → 429).
/// 폰은 손으로 「맞추기」를 누를 때만 요청한다(자동 반복 없음) — 기기당 30일 2만 번이면 하루 660번 꼴로 넉넉하다.
pub const MAX_NONCES_PER_DEVICE: usize = 20_000;
pub const MAX_NONCES_TOTAL: usize = 200_000;
/// 잊은 nonce 줄이 이만큼 넘고 기억 중인 것보다 많으면 실행 중 압축.
pub const COMPACT_MIN_STALE: usize = 4_096;
/// 한 줄 크기 상한(조각 ≤ 64KiB 평문이 JSON 으로 다시 쓰여도 넉넉).
const MAX_LINE_BYTES: usize = 512 * 1024;

#[derive(Debug, PartialEq, Eq)]
pub enum StoreError {
    /// 저장하지 못했다(디스크 오류 등). 아무것도 반영되지 않았다.
    Io,
    /// 파일 중간이 깨져 있다. 열지 않는다.
    Corrupt,
    /// 다른 프로그램이 이미 열고 있다.
    Busy,
    /// 이미 쓴 nonce.
    NonceReplay,
    /// nonce 개수 상한(기기별·전체).
    Quota,
    /// 쓰다 실패한 꼬리를 되돌리지 못했다 — 복구(`recover`) 전에는 아무 요청도 성공시키지 않는다.
    Failed,
}

#[derive(Debug, PartialEq, Eq)]
pub enum Applied {
    /// 새 조각. 새로 붙은 항목 수 / 같은 id 인데 내용이 달라 버린 수 / 이미 있던 같은 항목 수.
    New { added: usize, conflict: usize, duplicate: usize },
    /// 이미 반영한 조각 번호 — 다시 반영하지 않았다.
    DuplicateChunk,
}

#[cfg(test)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum FailMode {
    /// 쓰기 전에 실패(아무것도 안 씀).
    Write,
    /// 반쯤 쓰고 실패 + 되돌리기(set_len)도 실패.
    WriteAndRollback,
}

struct NonceRec {
    exp: i64,
    device: String,
}

pub struct LanStore {
    path: PathBuf,
    file: File,
    /// 도착 순서대로의 항목. pull 커서는 이 목록의 위치다.
    entries: Vec<Value>,
    by_id: HashMap<String, usize>,
    chunks: HashSet<String>,
    nonces: HashMap<String, NonceRec>,
    /// (잊는 시각, nonce) — 앞에서부터 잊는다.
    nonce_exp: BTreeSet<(i64, String)>,
    per_device: HashMap<String, usize>,
    /// 파일에 남아 있지만 이미 잊은 nonce 줄 수(압축 판단용).
    stale_lines: usize,
    /// 실행 중 압축 문턱(기본 COMPACT_MIN_STALE, 시험만 낮춘다).
    pub(crate) compact_min_stale: usize,
    failed: bool,
    #[cfg(test)]
    pub(crate) fail_next_write: bool,
    #[cfg(test)]
    pub(crate) fail_mode: Option<FailMode>,
}

fn is_hex(s: &str, n: usize) -> bool {
    s.len() == n && s.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// 폴더를 디스크까지 내린다(새 파일 생성·이름 바꾸기가 전원 장애 뒤에도 남도록).
fn sync_dir(dir: &Path) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        File::open(dir)?.sync_all()?;
    }
    #[cfg(not(unix))]
    let _ = dir;
    Ok(())
}

impl LanStore {
    /// 폴더 안의 로그를 열어 복구한다. `now_ms` 는 오래된 nonce 를 잊는 기준.
    pub fn open(dir: &Path, now_ms: i64) -> Result<Self, StoreError> {
        std::fs::create_dir_all(dir).map_err(|_| StoreError::Io)?;
        let path = dir.join(LOG_FILE);
        let existed = path.exists();
        let mut oo = OpenOptions::new();
        oo.read(true).append(true).create(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            oo.mode(0o600);
        }
        let mut file = oo.open(&path).map_err(|_| StoreError::Io)?;
        file.try_lock().map_err(|_| StoreError::Busy)?;
        if !existed {
            // 새로 만든 파일의 이름이 폴더에 남도록.
            sync_dir(dir).map_err(|_| StoreError::Io)?;
        }
        let mut raw = Vec::new();
        file.seek(SeekFrom::Start(0)).map_err(|_| StoreError::Io)?;
        file.read_to_end(&mut raw).map_err(|_| StoreError::Io)?;

        // 마지막 줄바꿈 뒤의 쓰다 만 조각은 버린다.
        let good_len = raw.iter().rposition(|b| *b == b'\n').map_or(0, |i| i + 1);
        let mut s = LanStore {
            path,
            file,
            entries: Vec::new(),
            by_id: HashMap::new(),
            chunks: HashSet::new(),
            nonces: HashMap::new(),
            nonce_exp: BTreeSet::new(),
            per_device: HashMap::new(),
            stale_lines: 0,
            compact_min_stale: COMPACT_MIN_STALE,
            failed: false,
            #[cfg(test)]
            fail_next_write: false,
            #[cfg(test)]
            fail_mode: None,
        };
        for line in raw[..good_len].split(|b| *b == b'\n').filter(|l| !l.is_empty()) {
            if line.len() > MAX_LINE_BYTES {
                return Err(StoreError::Corrupt);
            }
            let v: Value = serde_json::from_slice(line).map_err(|_| StoreError::Corrupt)?;
            match v.get("t").and_then(Value::as_str) {
                Some("c") => {
                    let id = v.get("chunkId").and_then(Value::as_str).filter(|s| is_hex(s, 64)).ok_or(StoreError::Corrupt)?;
                    let es = v.get("entries").and_then(Value::as_array).ok_or(StoreError::Corrupt)?;
                    s.chunks.insert(id.to_string());
                    s.merge(es);
                }
                Some("n") => {
                    let n = v.get("n").and_then(Value::as_str).filter(|s| is_hex(s, 32)).ok_or(StoreError::Corrupt)?;
                    let at = v.get("at").and_then(Value::as_i64).ok_or(StoreError::Corrupt)?;
                    let exp = match v.get("x") {
                        None => at.saturating_add(NONCE_KEEP_MS),
                        Some(x) => x.as_i64().ok_or(StoreError::Corrupt)?,
                    };
                    let device = match v.get("d") {
                        None => String::new(),
                        Some(d) => d.as_str().ok_or(StoreError::Corrupt)?.to_string(),
                    };
                    if exp < now_ms {
                        s.stale_lines += 1;
                    } else {
                        s.remember_nonce(n, exp, &device);
                    }
                }
                _ => return Err(StoreError::Corrupt),
            }
        }
        if good_len < raw.len() {
            s.file.set_len(good_len as u64).map_err(|_| StoreError::Io)?;
            s.file.sync_data().map_err(|_| StoreError::Io)?;
        }
        if s.stale_lines > 0 {
            s.compact()?;
        }
        Ok(s)
    }

    /// 고장 상태에서 벗어난다: 파일을 처음부터 다시 연다(쓰다 만 꼬리는 버린다). 실패하면 고장 상태 그대로.
    pub fn recover(&mut self, now_ms: i64) -> Result<(), StoreError> {
        let dir = self.path.parent().map(Path::to_path_buf).ok_or(StoreError::Io)?;
        let _ = self.file.unlock();
        match LanStore::open(&dir, now_ms) {
            Ok(fresh) => {
                *self = fresh;
                Ok(())
            }
            Err(e) => {
                // 잠금을 다시 쥔다(다른 프로그램이 끼어들지 않게). 고장 상태는 그대로.
                let _ = self.file.try_lock();
                self.failed = true;
                Err(e)
            }
        }
    }

    /// 이 저장소의 폴더.
    pub fn log_dir(&self) -> PathBuf {
        self.path.parent().map(Path::to_path_buf).unwrap_or_default()
    }

    pub fn is_failed(&self) -> bool {
        self.failed
    }

    fn remember_nonce(&mut self, n: &str, exp: i64, device: &str) {
        if let Some(old) = self.nonces.insert(n.to_string(), NonceRec { exp, device: device.to_string() }) {
            self.nonce_exp.remove(&(old.exp, n.to_string()));
            if let Some(c) = self.per_device.get_mut(&old.device) {
                *c = c.saturating_sub(1);
            }
        }
        self.nonce_exp.insert((exp, n.to_string()));
        *self.per_device.entry(device.to_string()).or_insert(0) += 1;
    }

    /// 잊어도 되는 nonce 를 메모리에서 뺀다. 뺀 수만큼 파일의 낡은 줄이 늘어난다.
    fn prune_nonces(&mut self, now_ms: i64) {
        while let Some((exp, n)) = self.nonce_exp.first().cloned() {
            if exp >= now_ms {
                break;
            }
            self.nonce_exp.pop_first();
            if let Some(rec) = self.nonces.remove(&n) {
                if let Some(c) = self.per_device.get_mut(&rec.device) {
                    *c = c.saturating_sub(1);
                    if *c == 0 {
                        self.per_device.remove(&rec.device);
                    }
                }
            }
            self.stale_lines += 1;
        }
    }

    /// 항목을 id 로 합친다. (새로 붙은 수, 충돌 수, 같은 항목 수)
    fn merge(&mut self, es: &[Value]) -> (usize, usize, usize) {
        let (mut added, mut conflict, mut dup) = (0, 0, 0);
        for e in es {
            let Some(id) = e.get("id").and_then(Value::as_str) else { continue };
            match self.by_id.get(id) {
                None => {
                    self.by_id.insert(id.to_string(), self.entries.len());
                    self.entries.push(e.clone());
                    added += 1;
                }
                Some(&i) if self.entries[i] == *e => dup += 1,
                Some(_) => conflict += 1,
            }
        }
        (added, conflict, dup)
    }

    /// 이 항목들을 붙이면 충돌(같은 id, 다른 내용)이 나는 id 목록 — 이미 있는 것과도, 같은 조각 안끼리도.
    pub fn conflicts(&self, es: &[Value]) -> Vec<String> {
        let mut seen: HashMap<&str, &Value> = HashMap::new();
        let mut out: Vec<String> = Vec::new();
        for e in es {
            let Some(id) = e.get("id").and_then(Value::as_str) else { continue };
            let clash = match self.by_id.get(id) {
                Some(&i) => self.entries[i] != *e,
                None => seen.get(id).is_some_and(|prev| *prev != e),
            };
            if clash && !out.iter().any(|x| x == id) {
                out.push(id.to_string());
            }
            seen.entry(id).or_insert(e);
        }
        out
    }

    /// 한 줄을 파일 끝에 덧붙이고 디스크까지 내린다. 실패하면 파일을 이전 길이로 되돌린다 — 되돌리기까지 실패하면 고장 상태.
    fn append_line(&mut self, v: &Value) -> Result<(), StoreError> {
        if self.failed {
            return Err(StoreError::Failed);
        }
        #[cfg(test)]
        if std::mem::take(&mut self.fail_next_write) {
            return Err(StoreError::Io);
        }
        let mut line = serde_json::to_vec(v).map_err(|_| StoreError::Io)?;
        line.push(b'\n');
        let before = self.file.metadata().map_err(|_| StoreError::Io)?.len();
        #[cfg(test)]
        match self.fail_mode.take() {
            Some(FailMode::Write) => return Err(StoreError::Io),
            Some(FailMode::WriteAndRollback) => {
                let _ = self.file.write_all(&line[..line.len() / 2]);
                self.failed = true;
                return Err(StoreError::Failed);
            }
            None => {}
        }
        let res = self.file.write_all(&line).and_then(|_| self.file.sync_data());
        if res.is_err() {
            let rolled = self.file.set_len(before).and_then(|_| self.file.sync_data());
            if rolled.is_err() {
                self.failed = true;
                return Err(StoreError::Failed);
            }
            return Err(StoreError::Io);
        }
        Ok(())
    }

    /// 이미 쓴 nonce 인가(쓰지 않고 보기만 — 봉인을 열기 전 값싼 거절용).
    pub fn nonce_seen(&self, nonce: &str) -> bool {
        self.nonces.contains_key(nonce)
    }

    /// 요청 nonce 를 쓴 것으로 기록한다. `expires_ms` 까지 기억한다(증서 끝 시각). 이미 썼으면 NonceReplay,
    /// 상한이면 Quota. 저장이 성공해야 Ok.
    pub fn use_nonce(&mut self, nonce: &str, device: &str, now_ms: i64, expires_ms: i64) -> Result<(), StoreError> {
        if self.failed {
            return Err(StoreError::Failed);
        }
        self.prune_nonces(now_ms);
        if !is_hex(nonce, 32) {
            return Err(StoreError::Io);
        }
        if self.nonces.contains_key(nonce) {
            return Err(StoreError::NonceReplay);
        }
        if self.nonces.len() >= MAX_NONCES_TOTAL || self.per_device.get(device).copied().unwrap_or(0) >= MAX_NONCES_PER_DEVICE {
            return Err(StoreError::Quota);
        }
        // 실행 중 압축: 잊은 줄이 기억 중인 것보다 많아지면(최소 COMPACT_MIN_STALE) 파일을 다시 쓴다. 실패해도 원본은 그대로라 계속 받는다.
        if self.stale_lines >= self.compact_min_stale && self.stale_lines > self.nonces.len() {
            if let Err(e) = self.compact() {
                eprintln!("[lan] 로그 압축 실패(원본 유지): {e:?}");
                if self.failed {
                    return Err(StoreError::Failed);
                }
            }
        }
        let exp = expires_ms.max(now_ms);
        self.append_line(&json!({ "t": "n", "n": nonce, "at": now_ms, "x": exp, "d": device }))?;
        self.remember_nonce(nonce, exp, device);
        Ok(())
    }

    /// 받은 조각을 덧붙인다. 같은 조각 번호는 한 번만 반영한다. 저장이 성공한 뒤에만 Ok.
    pub fn append_chunk(&mut self, chunk_id: &str, device_id: &str, entries: &[Value]) -> Result<Applied, StoreError> {
        if self.failed {
            return Err(StoreError::Failed);
        }
        if self.chunks.contains(chunk_id) {
            return Ok(Applied::DuplicateChunk);
        }
        self.append_line(&json!({ "t": "c", "chunkId": chunk_id, "deviceId": device_id, "entries": entries }))?;
        self.chunks.insert(chunk_id.to_string());
        let (added, conflict, duplicate) = self.merge(entries);
        Ok(Applied::New { added, conflict, duplicate })
    }

    pub fn has_chunk(&self, chunk_id: &str) -> bool {
        self.chunks.contains(chunk_id)
    }
    pub fn len(&self) -> usize {
        self.entries.len()
    }
    pub fn entry(&self, i: usize) -> Option<&Value> {
        self.entries.get(i)
    }
    pub fn nonce_count(&self) -> usize {
        self.nonces.len()
    }
    pub fn stale_lines(&self) -> usize {
        self.stale_lines
    }

    /// 잊은 nonce 줄을 뺀 새 파일로 바꾼다(임시 파일에 쓰고 이름 바꾸기). 조각 줄은 그대로 옮긴다.
    /// 임시 파일은 처음부터 0600 으로 **새로**(create_new) 만든다 — umask 022 에서 잠깐이라도 0644 로 열리지 않게.
    fn compact(&mut self) -> Result<(), StoreError> {
        let mut text = Vec::new();
        self.file.seek(SeekFrom::Start(0)).map_err(|_| StoreError::Io)?;
        self.file.read_to_end(&mut text).map_err(|_| StoreError::Io)?;
        let mut out = Vec::with_capacity(text.len());
        for line in text.split(|b| *b == b'\n').filter(|l| !l.is_empty()) {
            let v: Value = serde_json::from_slice(line).map_err(|_| StoreError::Corrupt)?;
            let keep = match v.get("t").and_then(Value::as_str) {
                Some("n") => v.get("n").and_then(Value::as_str).map_or(false, |n| self.nonces.contains_key(n)),
                _ => true,
            };
            if keep {
                out.extend_from_slice(line);
                out.push(b'\n');
            }
        }
        let tmp = self.path.with_extension("jsonl.tmp");
        let dir = self.path.parent().map(Path::to_path_buf).ok_or(StoreError::Io)?;
        // 지난번에 남은 임시 파일(권한을 모름)은 지우고 새로 만든다.
        match std::fs::remove_file(&tmp) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => return Err(StoreError::Io),
        }
        {
            let mut oo = OpenOptions::new();
            oo.write(true).create_new(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                oo.mode(0o600);
            }
            let mut t = oo.open(&tmp).map_err(|_| StoreError::Io)?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                let mode = t.metadata().map_err(|_| StoreError::Io)?.permissions().mode() & 0o777;
                if mode != 0o600 {
                    let _ = std::fs::remove_file(&tmp);
                    return Err(StoreError::Io);
                }
            }
            if t.write_all(&out).and_then(|_| t.sync_all()).is_err() {
                let _ = std::fs::remove_file(&tmp);
                return Err(StoreError::Io);
            }
        }
        if std::fs::rename(&tmp, &self.path).is_err() {
            let _ = std::fs::remove_file(&tmp);
            return Err(StoreError::Io);
        }
        // 여기부터는 원본이 이미 바뀌었다 — 다시 열지 못하면 고장 상태(옛 파일 손잡이로 쓰면 지워진 파일에 쓰게 된다).
        let reopened = (|| {
            sync_dir(&dir).map_err(|_| StoreError::Io)?;
            let mut oo = OpenOptions::new();
            oo.read(true).append(true);
            let f = oo.open(&self.path).map_err(|_| StoreError::Io)?;
            f.try_lock().map_err(|_| StoreError::Busy)?;
            Ok::<File, StoreError>(f)
        })();
        match reopened {
            Ok(f) => {
                self.file = f;
                self.stale_lines = 0;
                Ok(())
            }
            Err(e) => {
                self.failed = true;
                Err(e)
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dir(name: &str) -> PathBuf {
        use std::sync::atomic::{AtomicU32, Ordering};
        static N: AtomicU32 = AtomicU32::new(0);
        let base = std::env::var_os("RV_BACKUP_FIXTURE_ROOT").map(PathBuf::from).unwrap_or_else(std::env::temp_dir);
        let d = base.join(format!("lan-store-{}-{}-{}", name, std::process::id(), N.fetch_add(1, Ordering::SeqCst)));
        let _ = std::fs::remove_dir_all(&d);
        d
    }
    const NOW: i64 = 1_800_000_000_000;
    fn entry(i: u8, data: Value) -> Value {
        json!({ "id": format!("{:02x}", i).repeat(16), "origin": "ef".repeat(16), "seq": i, "ts": NOW, "kind": "note", "data": data })
    }
    fn cid(i: u8) -> String {
        format!("{:02x}", i).repeat(32)
    }
    fn nonce(i: u8) -> String {
        format!("{:02x}", i).repeat(16)
    }

    #[test]
    fn new_chunks_are_added_and_survive_a_restart() {
        let d = dir("restart");
        {
            let mut s = LanStore::open(&d, NOW).unwrap();
            assert_eq!(s.append_chunk(&cid(1), "dev", &[entry(1, json!(1)), entry(2, json!(2))]).unwrap(), Applied::New { added: 2, conflict: 0, duplicate: 0 });
            assert_eq!(s.append_chunk(&cid(2), "dev", &[entry(3, json!(3))]).unwrap(), Applied::New { added: 1, conflict: 0, duplicate: 0 });
            s.use_nonce(&nonce(1), "dev", NOW, NOW + NONCE_KEEP_MS).unwrap();
            assert_eq!(s.len(), 3);
        }
        let mut s = LanStore::open(&d, NOW + 1000).unwrap();
        assert_eq!(s.len(), 3);
        assert_eq!(s.entry(0), Some(&entry(1, json!(1))));
        assert_eq!(s.entry(2), Some(&entry(3, json!(3))));
        assert!(s.has_chunk(&cid(1)) && s.has_chunk(&cid(2)));
        // 다시 켜도 같은 조각·같은 nonce 는 거절/무시
        assert_eq!(s.append_chunk(&cid(1), "dev", &[entry(1, json!(1))]).unwrap(), Applied::DuplicateChunk);
        assert_eq!(s.use_nonce(&nonce(1), "dev", NOW + 2000, NOW + 2000 + NONCE_KEEP_MS), Err(StoreError::NonceReplay));
        assert_eq!(s.len(), 3);
    }

    #[test]
    fn a_repeated_chunk_number_is_not_applied_twice() {
        let mut s = LanStore::open(&dir("dup"), NOW).unwrap();
        s.append_chunk(&cid(1), "dev", &[entry(1, json!(1))]).unwrap();
        // 같은 번호에 다른 내용이 와도 반영하지 않는다
        assert_eq!(s.append_chunk(&cid(1), "dev", &[entry(9, json!(9))]).unwrap(), Applied::DuplicateChunk);
        assert_eq!(s.len(), 1);
    }

    #[test]
    fn same_item_id_keeps_the_first_and_counts_conflicts() {
        let mut s = LanStore::open(&dir("conf"), NOW).unwrap();
        s.append_chunk(&cid(1), "dev", &[entry(1, json!("a"))]).unwrap();
        assert_eq!(s.append_chunk(&cid(2), "dev", &[entry(1, json!("a")), entry(1, json!("b"))]).unwrap(), Applied::New { added: 0, conflict: 1, duplicate: 1 });
        assert_eq!(s.len(), 1);
        assert_eq!(s.entry(0), Some(&entry(1, json!("a"))));
    }

    #[test]
    fn a_replayed_nonce_is_refused_and_old_ones_are_forgotten_on_open() {
        let d = dir("nonce");
        {
            let mut s = LanStore::open(&d, NOW).unwrap();
            s.use_nonce(&nonce(1), "dev", NOW, NOW + NONCE_KEEP_MS).unwrap();
            assert_eq!(s.use_nonce(&nonce(1), "dev", NOW + 5, NOW + 5 + NONCE_KEEP_MS), Err(StoreError::NonceReplay));
            s.use_nonce(&nonce(2), "dev", NOW + 10, NOW + 10 + NONCE_KEEP_MS).unwrap();
            s.append_chunk(&cid(1), "dev", &[entry(1, json!(1))]).unwrap();
        }
        // 7일 뒤에 열면 nonce 는 잊고, 조각은 그대로 남는다(파일은 줄어든다)
        let before = std::fs::metadata(d.join(LOG_FILE)).unwrap().len();
        let mut s = LanStore::open(&d, NOW + NONCE_KEEP_MS + 100).unwrap();
        assert!(std::fs::metadata(d.join(LOG_FILE)).unwrap().len() < before);
        assert_eq!(s.len(), 1);
        assert!(s.has_chunk(&cid(1)));
        s.use_nonce(&nonce(1), "dev", NOW + NONCE_KEEP_MS + 200, NOW + NONCE_KEEP_MS + 200 + NONCE_KEEP_MS).unwrap();
        // 압축 뒤에도 덧붙이기가 된다
        s.append_chunk(&cid(2), "dev", &[entry(2, json!(2))]).unwrap();
        drop(s);
        assert_eq!(LanStore::open(&d, NOW + NONCE_KEEP_MS + 300).unwrap().len(), 2);
    }

    #[test]
    fn a_failed_save_applies_nothing_and_is_an_error() {
        let d = dir("fail");
        let mut s = LanStore::open(&d, NOW).unwrap();
        s.fail_next_write = true;
        assert_eq!(s.append_chunk(&cid(1), "dev", &[entry(1, json!(1))]), Err(StoreError::Io));
        assert_eq!(s.len(), 0);
        assert!(!s.has_chunk(&cid(1)));
        // 같은 조각을 다시 보내면 정상 저장된다(실패가 번호를 태우지 않았다)
        assert_eq!(s.append_chunk(&cid(1), "dev", &[entry(1, json!(1))]).unwrap(), Applied::New { added: 1, conflict: 0, duplicate: 0 });
        s.fail_next_write = true;
        assert_eq!(s.use_nonce(&nonce(7), "dev", NOW, NOW + NONCE_KEEP_MS), Err(StoreError::Io));
        s.use_nonce(&nonce(7), "dev", NOW, NOW + NONCE_KEEP_MS).unwrap(); // 실패한 nonce 는 쓴 것으로 치지 않았다
    }

    #[test]
    fn a_failed_rollback_fails_the_store_until_it_is_recovered() {
        let d = dir("rollback");
        let mut s = LanStore::open(&d, NOW).unwrap();
        s.append_chunk(&cid(1), "dev", &[entry(1, json!(1))]).unwrap();
        s.fail_mode = Some(FailMode::WriteAndRollback);
        assert_eq!(s.append_chunk(&cid(2), "dev", &[entry(2, json!(2))]), Err(StoreError::Failed));
        assert!(s.is_failed());
        // 고장 상태에서는 아무것도 성공하지 않는다(뒤에 정상 줄이 붙어 성공 응답이 나가지 않게).
        assert_eq!(s.append_chunk(&cid(3), "dev", &[entry(3, json!(3))]), Err(StoreError::Failed));
        assert_eq!(s.use_nonce(&nonce(1), "dev", NOW, NOW + NONCE_KEEP_MS), Err(StoreError::Failed));
        assert_eq!(s.len(), 1);
        // 복구 = 다시 열기: 쓰다 만 꼬리를 버리고 정상으로.
        s.recover(NOW).unwrap();
        assert!(!s.is_failed());
        assert_eq!(s.len(), 1);
        assert!(!s.has_chunk(&cid(2)));
        s.append_chunk(&cid(2), "dev", &[entry(2, json!(2))]).unwrap();
        drop(s);
        assert_eq!(LanStore::open(&d, NOW).unwrap().len(), 2, "재시작해도 깨짐 없이 열린다");
    }

    #[test]
    fn a_plain_write_failure_with_a_good_rollback_does_not_fail_the_store() {
        let mut s = LanStore::open(&dir("rollok"), NOW).unwrap();
        s.fail_mode = Some(FailMode::Write);
        assert_eq!(s.append_chunk(&cid(1), "dev", &[entry(1, json!(1))]), Err(StoreError::Io));
        assert!(!s.is_failed());
        s.append_chunk(&cid(1), "dev", &[entry(1, json!(1))]).unwrap();
    }

    #[test]
    fn nonces_are_kept_until_the_cert_ends_not_seven_days() {
        let d = dir("keep");
        const DAY: i64 = 24 * 3600_000;
        {
            let mut s = LanStore::open(&d, NOW).unwrap();
            // 30일짜리 증서로 쓴 nonce 는 8일 뒤에도 기억한다.
            s.use_nonce(&nonce(1), "dev", NOW, NOW + 30 * DAY).unwrap();
            assert_eq!(s.use_nonce(&nonce(1), "dev", NOW + 8 * DAY, NOW + 30 * DAY), Err(StoreError::NonceReplay));
        }
        let mut s = LanStore::open(&d, NOW + 29 * DAY).unwrap();
        assert_eq!(s.use_nonce(&nonce(1), "dev", NOW + 29 * DAY, NOW + 30 * DAY), Err(StoreError::NonceReplay), "다시 켜도 기억");
        drop(s);
        // 증서가 끝난 뒤에야 잊는다.
        let mut s = LanStore::open(&d, NOW + 30 * DAY + 1).unwrap();
        assert_eq!(s.nonce_count(), 0);
        s.use_nonce(&nonce(1), "dev", NOW + 30 * DAY + 1, NOW + 31 * DAY).unwrap();
        // x 가 없는 옛 줄은 증서 최대 수명(30일)+오차만큼 기억한다.
        assert!(NONCE_KEEP_MS >= crate::lan_cert::DEVICE_CERT_MAX_MS);
    }

    #[test]
    fn nonce_quota_per_device_and_in_total() {
        let mut s = LanStore::open(&dir("quota"), NOW).unwrap();
        // 상한을 빠르게 채우려고 메모리만 채운다(파일 쓰기 없이). 상한 판정은 메모리 수로 한다.
        for i in 0..MAX_NONCES_PER_DEVICE {
            s.remember_nonce(&format!("{:032x}", i), NOW + NONCE_KEEP_MS, "a");
        }
        assert_eq!(s.use_nonce(&nonce(0xee), "a", NOW, NOW + NONCE_KEEP_MS), Err(StoreError::Quota));
        let before = std::fs::metadata(d_of(&s)).unwrap().len();
        assert_eq!(before, 0, "상한에 걸린 요청은 디스크에 아무것도 안 쓴다");
        s.use_nonce(&nonce(0xee), "b", NOW, NOW + NONCE_KEEP_MS).unwrap();
        for i in s.nonce_count()..MAX_NONCES_TOTAL {
            s.remember_nonce(&format!("{:032x}", 1_000_000 + i), NOW + NONCE_KEEP_MS, &format!("d{}", i % 50));
        }
        assert_eq!(s.use_nonce(&nonce(0xef), "c", NOW, NOW + NONCE_KEEP_MS), Err(StoreError::Quota));
        // 시간이 지나 잊으면 다시 받는다.
        s.use_nonce(&nonce(0xef), "c", NOW + NONCE_KEEP_MS + 1, NOW + 2 * NONCE_KEEP_MS).unwrap();
    }
    fn d_of(s: &LanStore) -> PathBuf {
        s.path.clone()
    }

    #[test]
    fn stale_nonce_lines_are_compacted_while_running() {
        let d = dir("runcompact");
        let mut s = LanStore::open(&d, NOW).unwrap();
        s.append_chunk(&cid(1), "dev", &[entry(1, json!(1))]).unwrap();
        s.compact_min_stale = 40; // 디스크 동기화가 느려 문턱만 낮춘다(규칙은 같다)
        for i in 0..50u32 {
            s.use_nonce(&format!("{:032x}", i), "dev", NOW, NOW + 1000).unwrap();
        }
        let big = std::fs::metadata(d.join(LOG_FILE)).unwrap().len();
        // 모두 잊을 시각에 새 요청 하나 → 실행 중 압축.
        s.use_nonce(&nonce(0xaa), "dev", NOW + 5000, NOW + 9000).unwrap();
        assert_eq!(s.stale_lines(), 0);
        let small = std::fs::metadata(d.join(LOG_FILE)).unwrap().len();
        assert!(small * 10 < big, "{small} vs {big}");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(std::fs::metadata(d.join(LOG_FILE)).unwrap().permissions().mode() & 0o777, 0o600);
        }
        s.append_chunk(&cid(2), "dev", &[entry(2, json!(2))]).unwrap();
        drop(s);
        let s = LanStore::open(&d, NOW + 6000).unwrap();
        assert_eq!(s.len(), 2);
        assert!(s.nonce_seen(&nonce(0xaa)));
    }

    #[cfg(unix)]
    #[test]
    fn compaction_makes_a_fresh_0600_tmp_and_removes_a_leftover_0644_one() {
        use std::os::unix::fs::PermissionsExt;
        let d = dir("perm");
        {
            let mut s = LanStore::open(&d, NOW).unwrap();
            s.use_nonce(&nonce(1), "dev", NOW, NOW + 10).unwrap();
            s.append_chunk(&cid(1), "dev", &[entry(1, json!(1))]).unwrap();
        }
        // 지난번에 남은 0644 임시 파일(누군가 열어 둘 수 있는 것) — 재사용하지 않고 지운 뒤 새로 만든다.
        let tmp = d.join(LOG_FILE).with_extension("jsonl.tmp");
        std::fs::write(&tmp, b"junk").unwrap();
        std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o644)).unwrap();
        let s = LanStore::open(&d, NOW + 100).unwrap(); // 잊은 nonce → 압축
        assert_eq!(s.stale_lines(), 0);
        assert_eq!(std::fs::metadata(d.join(LOG_FILE)).unwrap().permissions().mode() & 0o777, 0o600);
        assert!(!tmp.exists());
        assert_eq!(s.len(), 1);
    }

    #[test]
    fn conflicts_are_reported_before_writing() {
        let mut s = LanStore::open(&dir("conflicts"), NOW).unwrap();
        s.append_chunk(&cid(1), "dev", &[entry(1, json!("a"))]).unwrap();
        assert!(s.conflicts(&[entry(1, json!("a")), entry(2, json!(2))]).is_empty());
        assert_eq!(s.conflicts(&[entry(1, json!("b"))]), vec!["01".repeat(16)]);
        // 같은 조각 안에서 같은 id 다른 내용
        assert_eq!(s.conflicts(&[entry(3, json!(1)), entry(3, json!(2))]), vec!["03".repeat(16)]);
    }

    #[test]
    fn a_torn_last_line_is_dropped_and_the_rest_recovered() {
        let d = dir("torn");
        {
            let mut s = LanStore::open(&d, NOW).unwrap();
            s.append_chunk(&cid(1), "dev", &[entry(1, json!(1))]).unwrap();
        }
        let p = d.join(LOG_FILE);
        let mut f = OpenOptions::new().append(true).open(&p).unwrap();
        f.write_all(br#"{"t":"c","chunkId":"0202"#).unwrap(); // 쓰다 전원이 나간 줄
        drop(f);
        let mut s = LanStore::open(&d, NOW).unwrap();
        assert_eq!(s.len(), 1);
        assert!(!s.has_chunk(&cid(2)));
        assert!(std::fs::read(&p).unwrap().ends_with(b"\n"));
        s.append_chunk(&cid(2), "dev", &[entry(2, json!(2))]).unwrap();
        drop(s);
        assert_eq!(LanStore::open(&d, NOW).unwrap().len(), 2);
    }

    #[test]
    fn a_damaged_middle_line_refuses_to_open() {
        let d = dir("corrupt");
        {
            let mut s = LanStore::open(&d, NOW).unwrap();
            s.append_chunk(&cid(1), "dev", &[entry(1, json!(1))]).unwrap();
            s.append_chunk(&cid(2), "dev", &[entry(2, json!(2))]).unwrap();
        }
        let p = d.join(LOG_FILE);
        let text = std::fs::read_to_string(&p).unwrap();
        std::fs::write(&p, text.replacen("\"t\":\"c\"", "\"t\":\"x\"", 1)).unwrap();
        assert!(matches!(LanStore::open(&d, NOW), Err(StoreError::Corrupt)));
    }

    #[test]
    fn only_one_opener_at_a_time() {
        let d = dir("lock");
        let _a = LanStore::open(&d, NOW).unwrap();
        assert!(matches!(LanStore::open(&d, NOW), Err(StoreError::Busy)));
    }
}
