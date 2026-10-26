//! Before money RPCs, persist an exclusive intent. Errors/crashes leave it blocked.
//! Reconciliation is intentionally manual until Core transaction matching is implemented.
use std::{
    fs::{self, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
};
const BLOCKED: &str = "이전 지급 결과가 미확인입니다. 재송금하지 말고 거래 내역과 지급 기록을 대표에게 확인받아 주세요.";
fn sync_parent(path: &Path) -> Result<(), String> {
    #[cfg(unix)]
    fs::File::open(path.parent().ok_or("저장 경로 오류")?)
        .and_then(|f| f.sync_all())
        .map_err(|_| "지급 기록 동기화 실패")?;
    Ok(())
}
fn private_new(path: &Path) -> std::io::Result<fs::File> {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options.open(path)
}
pub fn atomic_write(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let dir = path.parent().ok_or("저장 경로 오류")?;
    fs::create_dir_all(dir).map_err(|_| "저장 폴더 생성 실패")?;
    // Exclusive staging; stale staging is never read as a ledger or receipt.
    let tmp = path.with_extension(format!(
        "tmp-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(|_| "시계 오류")?
            .as_nanos()
    ));
    let result = (|| {
        let mut f = private_new(&tmp).map_err(|_| "임시 기록 생성 실패")?;
        f.write_all(bytes)
            .and_then(|_| f.sync_all())
            .map_err(|_| "기록 저장 실패")?;
        drop(f);
        fs::rename(&tmp, path).map_err(|_| "기록 교체 실패")?;
        sync_parent(path)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    result
}
// Serialize marker/receipt checks and acknowledgements across processes. A crash
// can leave this short-lived guard behind; recovery must fail closed as for pending.
struct MutationGuard(PathBuf);
impl MutationGuard {
    fn take(dir: &Path, lane: &str) -> Result<Self, String> {
        let path = dir.join(format!("{lane}.guard"));
        let f = private_new(&path).map_err(|_| BLOCKED)?;
        f.sync_all().map_err(|_| BLOCKED)?;
        sync_parent(&path)?;
        Ok(Self(path))
    }
}
impl Drop for MutationGuard {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.0);
    }
}

pub enum Begin {
    New(Pending),
    Done(String),
}
pub struct Pending {
    marker: PathBuf,
    receipt: PathBuf,
    intent: Vec<u8>,
}
pub fn begin(dir: &Path, lane: &str, id: &str, intent: &[u8]) -> Result<Begin, String> {
    if [lane, id].iter().any(|s| {
        s.is_empty() || s.len() > 128 || !s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
    }) {
        return Err("지급 식별자가 올바르지 않습니다.".into());
    }
    fs::create_dir_all(dir).map_err(|_| "지급 기록 폴더 생성 실패")?;
    let _mutation = MutationGuard::take(dir, lane)?;
    let marker = dir.join(format!("{lane}.pending"));
    let receipt = dir.join(format!("{lane}-{id}.done"));
    // A completed request can replay its receipt even while awaiting UI acknowledgement.
    if let Ok(bytes) = fs::read(&receipt) {
        if bytes.len() == intent.len() + 65
            && &bytes[65..] == intent
            && bytes[64] == b'\n'
            && bytes[..64].iter().all(|b| b.is_ascii_hexdigit())
        {
            return Ok(Begin::Done(
                String::from_utf8(bytes[..64].to_vec()).map_err(|_| "지급 기록 오류")?,
            ));
        }
        return Err("기존 지급 내용과 다릅니다. 대표 확인이 필요합니다.".into());
    }
    let mut f = private_new(&marker).map_err(|_| BLOCKED)?;
    let mut marker_bytes = id.as_bytes().to_vec();
    marker_bytes.push(b'\n');
    marker_bytes.extend(intent);
    f.write_all(&marker_bytes)
        .and_then(|_| f.sync_all())
        .map_err(|_| "지급 기록 저장 실패")?;
    drop(f);
    sync_parent(&marker)?;
    match fs::read(&receipt) {
        Ok(bytes) => {
            if bytes.len() != intent.len() + 65
                || &bytes[65..] != intent
                || bytes[64] != b'\n'
                || !bytes[..64].iter().all(|b| b.is_ascii_hexdigit())
            {
                return Err("기존 지급 내용과 다릅니다. 대표 확인이 필요합니다.".into());
            }
            let txid = String::from_utf8(bytes[..64].to_vec()).map_err(|_| "지급 기록 오류")?;
            fs::remove_file(&marker).map_err(|_| BLOCKED)?;
            sync_parent(&marker)?;
            Ok(Begin::Done(txid))
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Begin::New(Pending {
            marker,
            receipt,
            intent: intent.to_vec(),
        })),
        Err(_) => Err(BLOCKED.into()),
    }
}
impl Pending {
    pub fn complete_waiting_ack(&self, txid: &str) -> Result<(), String> {
        if txid.len() != 64 || !txid.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Err(BLOCKED.into());
        }
        let mut bytes = txid.as_bytes().to_vec();
        bytes.push(b'\n');
        bytes.extend(&self.intent);
        atomic_write(&self.receipt, &bytes)
    }
    pub fn complete(self, txid: &str) -> Result<(), String> {
        if txid.len() != 64 || !txid.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Err(BLOCKED.into());
        }
        let mut bytes = txid.as_bytes().to_vec();
        bytes.push(b'\n');
        bytes.extend(&self.intent);
        atomic_write(&self.receipt, &bytes)?;
        fs::remove_file(&self.marker).map_err(|_| BLOCKED)?;
        sync_parent(&self.marker)
    }
}

/// The UI received the successful result. A crash before this IPC leaves the lane locked.
pub fn acknowledge(dir: &Path, lane: &str, id: &str) -> Result<(), String> {
    if [lane, id].iter().any(|s| {
        s.is_empty() || s.len() > 128 || !s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
    }) {
        return Err("지급 식별자 오류".into());
    }
    let _mutation = MutationGuard::take(dir, lane)?;
    let receipt = fs::read(dir.join(format!("{lane}-{id}.done"))).map_err(|_| BLOCKED)?;
    if receipt.len() < 65
        || receipt[64] != b'\n'
        || !receipt[..64].iter().all(|b| b.is_ascii_hexdigit())
    {
        return Err(BLOCKED.into());
    }
    let mut expected = id.as_bytes().to_vec();
    expected.push(b'\n');
    expected.extend(&receipt[65..]);
    let marker = dir.join(format!("{lane}.pending"));
    let actual = match fs::read(&marker) {
        Ok(bytes) => bytes,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(_) => return Err(BLOCKED.into()),
    };
    if actual != expected {
        return Err(BLOCKED.into());
    }
    fs::remove_file(&marker).map_err(|_| BLOCKED)?;
    sync_parent(&marker)
}

/// Read only: never creates a pending intent or calls a payment RPC.
pub fn receipt(dir: &Path, lane: &str, id: &str, intent: &[u8]) -> Result<Option<String>, String> {
    if [lane, id].iter().any(|s| {
        s.is_empty() || s.len() > 128 || !s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
    }) {
        return Err("지급 식별자 오류".into());
    }
    let bytes = match fs::read(dir.join(format!("{lane}-{id}.done"))) {
        Ok(b) => b,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err(BLOCKED.into()),
    };
    if bytes.len() != intent.len() + 65
        || bytes[64] != b'\n'
        || &bytes[65..] != intent
        || !bytes[..64].iter().all(|b| b.is_ascii_hexdigit())
    {
        return Err("기존 지급 내용과 다릅니다.".into());
    }
    Ok(Some(
        String::from_utf8(bytes[..64].to_vec()).map_err(|_| BLOCKED)?,
    ))
}

/// OS-owned lock is released on process death. The file is never deleted: removing
/// it would permit two processes to lock different inodes for the same journal.
pub struct ProcessLock(std::fs::File);
impl ProcessLock {
    pub fn take(dir: &Path, name: &str) -> Result<Self, String> {
        fs::create_dir_all(dir).map_err(|_| "원장 폴더 생성 실패")?;
        let mut options = OpenOptions::new();
        options.read(true).write(true).create(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let file = options
            .open(dir.join(format!("{name}.lock")))
            .map_err(|_| "원장 잠금 파일 오류")?;
        file.try_lock()
            .map_err(|_| "다른 프로세스가 원장을 처리 중입니다.")?;
        Ok(Self(file))
    }
}
impl Drop for ProcessLock {
    fn drop(&mut self) {
        let _ = self.0.unlock();
    }
}
