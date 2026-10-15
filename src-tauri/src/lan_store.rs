//! LAN 동기화 ③ — 추가만 되는 변경 로그 저장. 데스크탑(서버) 쪽.
//!
//! 한 파일(`lan-log.jsonl`)에 줄 단위로 덧붙이기만 한다(지우거나 고치지 않음). 줄 종류:
//!   {"t":"c","chunkId":<64hex>,"deviceId":<hex>,"entries":[...]}   받은 조각(push) — 조각 번호가 같으면 한 번만 반영
//!   {"t":"n","n":<nonce 32hex>,"at":<ms>}                          쓴 요청 nonce — 같은 nonce 를 다시 쓰면 거절(재전송 방어)
//!
//! 약속
//!  · 저장(쓰기 + sync_data)이 성공한 뒤에만 메모리에 반영하고 `Ok` 를 돌려준다. 저장이 실패하면 메모리는 그대로이고 오류를 돌려준다
//!    (처리기는 오류일 때 확인값 있는 성공 응답을 만들지 않는다).
//!  · 다시 열면 같은 상태로 돌아온다. 마지막 줄이 쓰다 만 것(끝 줄바꿈 없음)이면 그 줄만 버리고 파일을 그 앞까지 줄인다.
//!    중간 줄이 깨져 있으면 데이터를 조용히 잃지 않도록 열지 않는다(Corrupt).
//!  · 같은 항목 id 가 이미 있으면 처음 것을 지킨다(내용이 다르면 충돌로 세고 버림) — 폰 ChangeLog 와 같은 규칙.
//!  · nonce 는 NONCE_KEEP_MS(7일, 증서 기본 기간) 지나면 잊는다. 열 때 오래된 nonce 줄을 지우며 파일을 다시 쓴다(조각 줄은 그대로).
//!  · 한 번에 한 프로그램만 연다(파일 잠금).

#![allow(dead_code)] // 처리기(lan_handler)가 쓴다

use serde_json::{json, Value};
use std::collections::{HashMap, HashSet, VecDeque};
use std::fs::{File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};

pub const LOG_FILE: &str = "lan-log.jsonl";
pub const NONCE_KEEP_MS: i64 = 7 * 24 * 3600_000;
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
}

#[derive(Debug, PartialEq, Eq)]
pub enum Applied {
    /// 새 조각. 새로 붙은 항목 수 / 같은 id 인데 내용이 달라 버린 수 / 이미 있던 같은 항목 수.
    New { added: usize, conflict: usize, duplicate: usize },
    /// 이미 반영한 조각 번호 — 다시 반영하지 않았다.
    DuplicateChunk,
}

pub struct LanStore {
    path: PathBuf,
    file: File,
    /// 도착 순서대로의 항목. pull 커서는 이 목록의 위치다.
    entries: Vec<Value>,
    by_id: HashMap<String, usize>,
    chunks: HashSet<String>,
    nonces: HashMap<String, i64>,
    nonce_order: VecDeque<(i64, String)>,
    #[cfg(test)]
    pub(crate) fail_next_write: bool,
}

fn is_hex(s: &str, n: usize) -> bool {
    s.len() == n && s.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

impl LanStore {
    /// 폴더 안의 로그를 열어 복구한다. `now_ms` 는 오래된 nonce 를 잊는 기준.
    pub fn open(dir: &Path, now_ms: i64) -> Result<Self, StoreError> {
        std::fs::create_dir_all(dir).map_err(|_| StoreError::Io)?;
        let path = dir.join(LOG_FILE);
        let mut oo = OpenOptions::new();
        oo.read(true).append(true).create(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            oo.mode(0o600);
        }
        let mut file = oo.open(&path).map_err(|_| StoreError::Io)?;
        file.try_lock().map_err(|_| StoreError::Busy)?;
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
            nonce_order: VecDeque::new(),
            #[cfg(test)]
            fail_next_write: false,
        };
        let mut expired = false;
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
                    if now_ms - at > NONCE_KEEP_MS {
                        expired = true;
                    } else {
                        s.remember_nonce(n, at);
                    }
                }
                _ => return Err(StoreError::Corrupt),
            }
        }
        if good_len < raw.len() {
            s.file.set_len(good_len as u64).map_err(|_| StoreError::Io)?;
        }
        if expired {
            s.compact()?;
        }
        Ok(s)
    }

    fn remember_nonce(&mut self, n: &str, at: i64) {
        self.nonces.insert(n.to_string(), at);
        self.nonce_order.push_back((at, n.to_string()));
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

    /// 한 줄을 파일 끝에 덧붙이고 디스크까지 내린다. 실패하면 파일을 이전 길이로 되돌리려 시도한다.
    fn append_line(&mut self, v: &Value) -> Result<(), StoreError> {
        #[cfg(test)]
        if std::mem::take(&mut self.fail_next_write) {
            return Err(StoreError::Io);
        }
        let mut line = serde_json::to_vec(v).map_err(|_| StoreError::Io)?;
        line.push(b'\n');
        let before = self.file.metadata().map_err(|_| StoreError::Io)?.len();
        let res = self.file.write_all(&line).and_then(|_| self.file.sync_data());
        if res.is_err() {
            let _ = self.file.set_len(before);
            return Err(StoreError::Io);
        }
        Ok(())
    }

    /// 요청 nonce 를 쓴 것으로 기록한다. 이미 썼으면 NonceReplay. 저장이 성공해야 Ok.
    pub fn use_nonce(&mut self, nonce: &str, now_ms: i64) -> Result<(), StoreError> {
        while let Some((at, n)) = self.nonce_order.front().cloned() {
            if now_ms - at <= NONCE_KEEP_MS {
                break;
            }
            self.nonce_order.pop_front();
            if self.nonces.get(&n) == Some(&at) {
                self.nonces.remove(&n);
            }
        }
        if !is_hex(nonce, 32) {
            return Err(StoreError::Io);
        }
        if self.nonces.contains_key(nonce) {
            return Err(StoreError::NonceReplay);
        }
        self.append_line(&json!({ "t": "n", "n": nonce, "at": now_ms }))?;
        self.remember_nonce(nonce, now_ms);
        Ok(())
    }

    /// 받은 조각을 덧붙인다. 같은 조각 번호는 한 번만 반영한다. 저장이 성공한 뒤에만 Ok.
    pub fn append_chunk(&mut self, chunk_id: &str, device_id: &str, entries: &[Value]) -> Result<Applied, StoreError> {
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

    /// 오래된 nonce 줄을 뺀 새 파일로 바꾼다(임시 파일에 쓰고 이름 바꾸기). 조각 줄은 그대로 옮긴다.
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
        {
            let mut t = File::create(&tmp).map_err(|_| StoreError::Io)?;
            t.write_all(&out).and_then(|_| t.sync_all()).map_err(|_| StoreError::Io)?;
        }
        std::fs::rename(&tmp, &self.path).map_err(|_| StoreError::Io)?;
        // 이름이 바뀐 새 파일을 다시 연다(잠금도 새 파일에).
        let mut oo = OpenOptions::new();
        oo.read(true).append(true);
        let f = oo.open(&self.path).map_err(|_| StoreError::Io)?;
        f.try_lock().map_err(|_| StoreError::Busy)?;
        self.file = f;
        Ok(())
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
            s.use_nonce(&nonce(1), NOW).unwrap();
            assert_eq!(s.len(), 3);
        }
        let mut s = LanStore::open(&d, NOW + 1000).unwrap();
        assert_eq!(s.len(), 3);
        assert_eq!(s.entry(0), Some(&entry(1, json!(1))));
        assert_eq!(s.entry(2), Some(&entry(3, json!(3))));
        assert!(s.has_chunk(&cid(1)) && s.has_chunk(&cid(2)));
        // 다시 켜도 같은 조각·같은 nonce 는 거절/무시
        assert_eq!(s.append_chunk(&cid(1), "dev", &[entry(1, json!(1))]).unwrap(), Applied::DuplicateChunk);
        assert_eq!(s.use_nonce(&nonce(1), NOW + 2000), Err(StoreError::NonceReplay));
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
            s.use_nonce(&nonce(1), NOW).unwrap();
            assert_eq!(s.use_nonce(&nonce(1), NOW + 5), Err(StoreError::NonceReplay));
            s.use_nonce(&nonce(2), NOW + 10).unwrap();
            s.append_chunk(&cid(1), "dev", &[entry(1, json!(1))]).unwrap();
        }
        // 7일 뒤에 열면 nonce 는 잊고, 조각은 그대로 남는다(파일은 줄어든다)
        let before = std::fs::metadata(d.join(LOG_FILE)).unwrap().len();
        let mut s = LanStore::open(&d, NOW + NONCE_KEEP_MS + 100).unwrap();
        assert!(std::fs::metadata(d.join(LOG_FILE)).unwrap().len() < before);
        assert_eq!(s.len(), 1);
        assert!(s.has_chunk(&cid(1)));
        s.use_nonce(&nonce(1), NOW + NONCE_KEEP_MS + 200).unwrap();
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
        assert_eq!(s.use_nonce(&nonce(7), NOW), Err(StoreError::Io));
        s.use_nonce(&nonce(7), NOW).unwrap(); // 실패한 nonce 는 쓴 것으로 치지 않았다
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
