//! Raven Core holds datadir/.lock before opening a wallet until process exit.
//! Match Boost 1.71 interprocess file_lock (fcntl on Unix, LockFileEx on Windows).
//! Never substitute flock / std::fs::File::try_lock on Unix. See qa/restore-safety.

use std::fs::{self, File, OpenOptions};
use std::io;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};

// POSIX record locks belong to a process, not a File. A second open/close of
// .lock in this process could release the first guard. Serialize BEFORE open.
static IN_PROCESS: Mutex<()> = Mutex::new(());

// The caller's atomic in-process gate MUST be claimed before opening this file.
// This second, app-specific lock protects the shared decrypted scratch folder
// against another RavenVault process, including startup cleanup. It is not a
// substitute for the node datadir lock below.
pub(super) struct RestoreSessionGuard {
    file: File,
    path: PathBuf,
}
impl RestoreSessionGuard {
    pub(super) fn acquire(directory: &Path) -> Result<Self, String> {
        fs::create_dir_all(directory).map_err(lock_error)?;
        let path = fs::canonicalize(directory)
            .map_err(lock_error)?
            .join(".ravenvault-restore.lock");
        let mut options = OpenOptions::new();
        options.read(true).write(true).create(true).truncate(false);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options
                .mode(0o600)
                .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
        }
        #[cfg(windows)]
        {
            use std::os::windows::fs::OpenOptionsExt;
            use windows_sys::Win32::Storage::FileSystem::*;
            options
                .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE)
                .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT);
        }
        let file = options.open(&path).map_err(lock_error)?;
        if !file.metadata().map_err(lock_error)?.is_file() {
            return Err("복원 잠금 파일을 확인해 주세요.".into());
        }
        lock(&file).map_err(|_| {
            "다른 RavenVault에서 복원이나 정리를 진행 중입니다. 끝난 뒤 다시 시도해 주세요."
                .to_string()
        })?;
        let guard = Self { file, path };
        guard.check()?;
        Ok(guard)
    }
    pub(super) fn check(&self) -> Result<(), String> {
        if !same_file_at(&self.file, &self.path).unwrap_or(false) {
            return Err(
                "복원 잠금 파일이 바뀌었습니다. 복원을 멈추고 앱을 다시 열어 주세요.".into(),
            );
        }
        Ok(())
    }
}

pub(super) struct DataDirGuard {
    file: File,
    directory: File,
    requested: PathBuf,
    canonical: PathBuf,
    _process: MutexGuard<'static, ()>,
}

impl DataDirGuard {
    pub(super) fn acquire(directory: &Path) -> Result<Self, String> {
        let process = IN_PROCESS
            .try_lock()
            .map_err(|_| "다른 복원이 진행 중입니다. 끝난 뒤 다시 시도해 주세요.".to_string())?;
        let canonical = fs::canonicalize(directory)
            .map_err(|e| format!("노드 폴더를 확인하지 못했습니다. 폴더를 확인해 주세요: {e}"))?;
        let dir_file = open_directory(&canonical).map_err(lock_error)?;
        let path = canonical.join(".lock");
        let mut options = OpenOptions::new();
        options.read(true).write(true).create(true).truncate(false);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options
                .mode(0o600)
                .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
        }
        #[cfg(windows)]
        {
            use std::os::windows::fs::OpenOptionsExt;
            use windows_sys::Win32::Storage::FileSystem::*;
            // No FILE_SHARE_DELETE: keep this lock's name attached to its handle.
            options
                .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE)
                .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT);
        }
        let file = options.open(path).map_err(lock_error)?;
        if !file.metadata().map_err(lock_error)?.is_file() {
            return Err("노드 잠금 파일이 일반 파일이 아닙니다. 폴더를 확인해 주세요.".into());
        }
        lock(&file).map_err(lock_error)?;
        let guard = Self {
            file,
            directory: dir_file,
            requested: directory.to_path_buf(),
            canonical,
            _process: process,
        };
        guard.check()?;
        Ok(guard)
    }

    pub(super) fn directory(&self) -> &Path {
        &self.canonical
    }

    pub(super) fn check(&self) -> Result<(), String> {
        let valid = fs::canonicalize(&self.requested).ok().as_ref() == Some(&self.canonical)
            && same_file_at(&self.directory, &self.canonical).unwrap_or(false)
            && same_file_at(&self.file, &self.canonical.join(".lock")).unwrap_or(false);
        if !valid {
            return Err("노드 폴더나 잠금 파일이 바뀌었습니다. 복원을 멈췄습니다. 폴더를 확인한 뒤 다시 시도해 주세요.".into());
        }
        Ok(())
    }

    pub(super) fn check_wallet_paths(
        &self,
        source: &Path,
        destination: &Path,
    ) -> Result<(), String> {
        self.check()?;
        if destination != self.canonical.join("wallet.dat") {
            return Err(
                "확인한 노드 폴더의 지갑만 되돌릴 수 있습니다. 폴더를 다시 확인해 주세요.".into(),
            );
        }
        // Do not open a hard-link alias of .lock: closing it would drop a POSIX lock.
        for path in [source, destination] {
            if same_file_at(&self.file, path).unwrap_or(false) {
                return Err("지갑과 잠금 파일이 같은 파일입니다. 다른 백업을 골라 주세요.".into());
            }
        }
        Ok(())
    }
}

fn lock_error(e: io::Error) -> String {
    format!(
        "노드 폴더를 단독으로 사용할 수 없습니다. 노드를 완전히 종료한 뒤 다시 시도해 주세요: {e}"
    )
}

pub(super) fn open_directory(path: &Path) -> io::Result<File> {
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        use windows_sys::Win32::Storage::FileSystem::*;
        options
            .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE)
            .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT);
    }
    let file = options.open(path)?;
    if !file.metadata()?.is_dir() {
        return Err(io::Error::other("expected a directory"));
    }
    Ok(file)
}

pub(super) fn same_file_at(file: &File, path: &Path) -> io::Result<bool> {
    let path_meta = fs::symlink_metadata(path)?;
    if path_meta.file_type().is_symlink() {
        return Ok(false);
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        let held = file.metadata()?;
        Ok(held.dev() == path_meta.dev() && held.ino() == path_meta.ino())
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::{MetadataExt, OpenOptionsExt};
        use windows_sys::Win32::Storage::FileSystem::*;
        if path_meta.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            return Ok(false);
        }
        // Metadata-only handle. It never reads the record-locked bytes.
        let probe = OpenOptions::new()
            .access_mode(0)
            .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE)
            .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT)
            .open(path)?;
        Ok(file_identity(file)? == file_identity(&probe)?)
    }
    #[cfg(not(any(unix, windows)))]
    {
        Err(io::Error::other("unsupported lock platform"))
    }
}

#[cfg(windows)]
fn file_identity(file: &File) -> io::Result<(u32, u32, u32)> {
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Storage::FileSystem::{
        GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION,
    };
    let mut info: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
    if unsafe { GetFileInformationByHandle(file.as_raw_handle() as _, &mut info) } == 0 {
        return Err(io::Error::last_os_error());
    }
    Ok((
        info.dwVolumeSerialNumber,
        info.nFileIndexHigh,
        info.nFileIndexLow,
    ))
}

#[cfg(unix)]
fn lock(file: &File) -> io::Result<()> {
    use std::os::fd::AsRawFd;
    let mut range: libc::flock = unsafe { std::mem::zeroed() };
    range.l_type = libc::F_WRLCK as _;
    range.l_whence = libc::SEEK_SET as _;
    range.l_start = 0;
    range.l_len = 0;
    loop {
        if unsafe { libc::fcntl(file.as_raw_fd(), libc::F_SETLK, &range) } != -1 {
            return Ok(());
        }
        let error = io::Error::last_os_error();
        if error.kind() != io::ErrorKind::Interrupted {
            return Err(error);
        }
    }
}

#[cfg(windows)]
fn lock(file: &File) -> io::Result<()> {
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Storage::FileSystem::{
        LockFileEx, LOCKFILE_EXCLUSIVE_LOCK, LOCKFILE_FAIL_IMMEDIATELY,
    };
    use windows_sys::Win32::System::IO::OVERLAPPED;
    let mut range: OVERLAPPED = unsafe { std::mem::zeroed() };
    if unsafe {
        LockFileEx(
            file.as_raw_handle() as _,
            LOCKFILE_EXCLUSIVE_LOCK | LOCKFILE_FAIL_IMMEDIATELY,
            0,
            u32::MAX,
            u32::MAX,
            &mut range,
        )
    } == 0
    {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

#[cfg(not(any(unix, windows)))]
fn lock(_: &File) -> io::Result<()> {
    Err(io::Error::other("unsupported lock platform"))
}

// Dropping the File releases the OS lock. Fields drop in declaration order, so
// the process mutex outlives both handles. Never unlink .lock, even on failure.
