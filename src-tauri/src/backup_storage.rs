//! Complete a backup before publishing it. No wallet, RPC, or application paths.
//!
//! Two filenames cannot be committed in a single filesystem operation. Before
//! either is changed, durable copies of both originals are kept in a private
//! transaction directory. A handled failure rolls both names back. If rollback
//! also fails (or the process is killed), those copies and the destination lock
//! remain for recovery; a later call must not silently steal that lock.

use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

static NEXT: AtomicU64 = AtomicU64::new(0);

pub struct Workspace {
    path: PathBuf,
    keep: bool,
}

impl Workspace {
    pub fn new(root: &Path) -> Result<Self, String> {
        if !root.is_absolute() || !root.is_dir() {
            return Err("백업 작업 폴더가 없습니다. 저장할 폴더를 다시 골라 주세요.".into());
        }
        let root = root.canonicalize().map_err(|e| format!("백업 폴더를 확인하지 못했습니다. 폴더 권한을 확인하세요: {e}"))?;
        for _ in 0..128 {
            let tick = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH)
                .map_err(|_| "컴퓨터 시간을 확인한 뒤 백업을 다시 시도하세요.")?.as_nanos();
            let path = root.join(format!(".rv-backup-{}-{tick:x}-{}", std::process::id(), NEXT.fetch_add(1, Ordering::Relaxed)));
            match private_directory(&path) {
                Ok(()) => return Ok(Self { path, keep: false }),
                Err(e) if e.kind() == io::ErrorKind::AlreadyExists => continue,
                Err(e) => return Err(format!("비공개 백업 작업 폴더를 만들지 못했습니다. 저장 공간과 권한을 확인하세요: {e}")),
            }
        }
        Err("백업 작업 폴더가 겹쳤습니다. 잠시 뒤 다시 시도하세요.".into())
    }

    pub fn path(&self) -> &Path { &self.path }
}

impl Drop for Workspace {
    fn drop(&mut self) {
        if !self.keep { let _ = fs::remove_dir_all(&self.path); }
    }
}

#[cfg(unix)]
fn private_directory(path: &Path) -> io::Result<()> {
    use std::os::unix::fs::DirBuilderExt;
    fs::DirBuilder::new().mode(0o700).create(path)
}

#[cfg(not(any(unix, windows)))]
fn private_directory(_: &Path) -> io::Result<()> {
    Err(io::Error::new(io::ErrorKind::Unsupported, "Private backup directories are unsupported on this system"))
}

#[cfg(windows)]
fn private_directory(path: &Path) -> io::Result<()> { windows::private_directory(path) }

fn new_file(path: &Path) -> io::Result<File> {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)] {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options.open(path)
}

fn regular(path: &Path) -> io::Result<bool> {
    match fs::symlink_metadata(path) {
        Ok(meta) if meta.file_type().is_file() => Ok(true),
        Ok(_) => Err(io::Error::new(io::ErrorKind::InvalidInput, "Expected a regular file, not a directory or symbolic link")),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(false),
        Err(e) => Err(e),
    }
}

type Hook<'a> = dyn FnMut(&str) -> io::Result<()> + 'a;

fn equal_files(a: &Path, b: &Path) -> io::Result<()> {
    if !regular(a)? || !regular(b)? { return Err(io::Error::new(io::ErrorKind::NotFound, "Backup comparison file is missing")); }
    let mut a = File::open(a)?;
    let mut b = File::open(b)?;
    if a.metadata()?.len() != b.metadata()?.len() {
        return Err(io::Error::new(io::ErrorKind::InvalidData, "Backup file size changed"));
    }
    let mut left = [0u8; 64 * 1024];
    let mut right = [0u8; 64 * 1024];
    loop {
        let count = a.read(&mut left)?;
        if count == 0 {
            if b.read(&mut right[..1])? != 0 { return Err(io::Error::new(io::ErrorKind::InvalidData, "Backup file grew")); }
            return Ok(());
        }
        b.read_exact(&mut right[..count])?;
        if left[..count] != right[..count] {
            return Err(io::Error::new(io::ErrorKind::InvalidData, "Backup readback did not match"));
        }
    }
}

fn copy_verified(source: &Path, dest: &Path, label: &str, hook: &mut Hook<'_>) -> io::Result<()> {
    hook(&format!("{label}:read"))?;
    if !regular(source)? { return Err(io::Error::new(io::ErrorKind::NotFound, "Backup source is missing")); }
    let mut input = File::open(source)?;
    let expected = input.metadata()?.len();
    hook(&format!("{label}:create"))?;
    let mut output = new_file(dest)?;
    let mut buf = [0u8; 64 * 1024];
    let mut count = 0u64;
    loop {
        let n = input.read(&mut buf)?;
        if n == 0 { break; }
        hook(&format!("{label}:write"))?;
        output.write_all(&buf[..n])?;
        count += n as u64;
    }
    if count != expected || input.metadata()?.len() != expected {
        return Err(io::Error::new(io::ErrorKind::InvalidData, "Backup source changed while copying"));
    }
    hook(&format!("{label}:sync"))?;
    output.sync_all()?;
    drop(output);
    hook(&format!("{label}:verify"))?;
    equal_files(source, dest)
}

#[cfg(unix)]
fn sync_directory(path: &Path) -> io::Result<()> { File::open(path)?.sync_all() }
#[cfg(not(unix))]
fn sync_directory(_: &Path) -> io::Result<()> {
    // Windows moves below use MOVEFILE_WRITE_THROUGH. File contents have
    // already been flushed with File::sync_all before their names are replaced.
    Ok(())
}

#[cfg(not(windows))]
fn replace(from: &Path, to: &Path) -> io::Result<()> { fs::rename(from, to) }
#[cfg(windows)]
fn replace(from: &Path, to: &Path) -> io::Result<()> { windows::replace(from, to) }

fn previous_path(latest: &Path) -> Result<PathBuf, String> {
    let name = latest.file_name().and_then(|n| n.to_str())
        .ok_or("백업 파일 이름을 읽지 못했습니다. 저장할 파일 이름을 확인하세요.")?;
    let (stem, suffix) = if let Some(stem) = name.strip_suffix(".zip.pxlock") { (stem, ".zip.pxlock") }
        else if let Some(stem) = name.strip_suffix(".zip") { (stem, ".zip") }
        else if let Some((stem, _)) = name.rsplit_once('.') { (stem, &name[stem.len()..]) }
        else { (name, "") };
    if stem.is_empty() { return Err("백업 파일 이름이 비어 있습니다. 다른 이름을 골라 주세요.".into()); }
    Ok(latest.with_file_name(format!("{stem}-이전{suffix}")))
}

struct DestinationLock { path: PathBuf, owned: bool }
impl DestinationLock {
    fn acquire(path: PathBuf) -> Result<Self, String> {
        let mut file = new_file(&path).map_err(|e| {
            if e.kind() == io::ErrorKind::AlreadyExists {
                format!("다른 백업이 저장 중이거나 이전 작업이 중단됐습니다. 백업 작업과 복구 사본을 확인한 뒤 다시 시도하세요. 잠금 파일: {}", path.display())
            } else { format!("백업 저장 잠금을 만들지 못했습니다. 폴더 권한을 확인하세요: {e}") }
        })?;
        let lock = Self { path, owned: true };
        writeln!(file, "RavenVault backup publication\nprocess={}", std::process::id())
            .and_then(|_| file.sync_all()).map_err(|e| format!("백업 저장 잠금을 확인하지 못했습니다. 다시 시도하세요: {e}"))?;
        Ok(lock)
    }
    fn release(&mut self) -> io::Result<()> {
        if self.owned { fs::remove_file(&self.path)?; self.owned = false; }
        Ok(())
    }
}
impl Drop for DestinationLock {
    fn drop(&mut self) { if self.owned { let _ = fs::remove_file(&self.path); } }
}

/// Publish a completed file without truncating the last successful backup.
/// `staged` is read-only and remains owned by the caller. Both paths must be
/// absolute. A stale lock is deliberately not stolen after a crash.
pub fn publish_file(staged: &Path, latest: &Path) -> Result<(), String> {
    publish_with(staged, latest, &mut |_| Ok(()))
}

fn publish_with(staged: &Path, latest: &Path, hook: &mut Hook<'_>) -> Result<(), String> {
    if !staged.is_absolute() || !latest.is_absolute() {
        return Err("백업 저장 경로가 올바르지 않습니다. 저장 폴더를 다시 골라 주세요.".into());
    }
    let parent = latest.parent().ok_or("백업 저장 폴더가 없습니다.")?
        .canonicalize().map_err(|e| format!("백업 저장 폴더를 확인하지 못했습니다. 폴더 권한을 확인하세요: {e}"))?;
    let latest = parent.join(latest.file_name().ok_or("백업 파일 이름이 없습니다.")?);
    let previous = previous_path(&latest)?;
    if staged == latest || staged == previous {
        return Err("작업 파일과 기존 백업이 같은 경로입니다. 별도 작업 폴더에서 다시 만들어 주세요.".into());
    }
    let lock_path = parent.join(format!(".{}.publish-lock", latest.file_name().unwrap().to_string_lossy()));
    let mut lock = DestinationLock::acquire(lock_path)?;
    let mut work = Workspace::new(&parent)?;
    let new = work.path().join("new-file");
    let old_latest = work.path().join("old-latest");
    let old_previous = work.path().join("old-previous");
    let mut had_latest = false;
    let mut had_previous = false;
    let mut changed_latest = false;
    let mut changed_previous = false;

    let result = (|| -> io::Result<()> {
        copy_verified(staged, &new, "new", hook)?;
        if File::open(&new)?.metadata()?.len() == 0 {
            return Err(io::Error::new(io::ErrorKind::InvalidData, "Refusing an empty completed backup"));
        }
        had_latest = regular(&latest)?;
        had_previous = regular(&previous)?;
        if had_latest { copy_verified(&latest, &old_latest, "old_latest", hook)?; }
        if had_previous { copy_verified(&previous, &old_previous, "old_previous", hook)?; }
        let mut note = new_file(&work.path().join("RECOVERY.txt"))?;
        writeln!(note, "RavenVault interrupted backup publication\nlatest={}\nprevious={}\nold-latest={}\nold-previous={}\nDo not delete these original copies while the destination lock exists.", latest.display(), previous.display(), had_latest, had_previous)?;
        note.sync_all()?;
        drop(note);
        hook("snapshots:sync")?;
        sync_directory(work.path())?;
        sync_directory(&parent)?;
        if had_latest {
            let next_previous = work.path().join("next-previous");
            copy_verified(&old_latest, &next_previous, "next_previous", hook)?;
            // Verify that the files still match the originals immediately
            // before modifying either public name.
            equal_files(&old_latest, &latest)?;
            if had_previous { equal_files(&old_previous, &previous)?; }
            hook("previous:replace")?;
            replace(&next_previous, &previous)?;
            changed_previous = true;
        }
        hook("latest:replace")?;
        replace(&new, &latest)?;
        changed_latest = true;
        hook("published:sync")?;
        sync_directory(&parent)?;
        hook("published:verify")?;
        equal_files(staged, &latest)?;
        if had_latest { equal_files(&old_latest, &previous)?; }
        hook("lock:release")?;
        lock.release()?;
        Ok(())
    })();

    if let Err(error) = result {
        let mut recovery_errors = Vec::new();
        if changed_latest {
            if let Err(e) = restore_original(&latest, &old_latest, had_latest, work.path(), "rollback_latest", hook) { recovery_errors.push(e.to_string()); }
        }
        if changed_previous {
            if let Err(e) = restore_original(&previous, &old_previous, had_previous, work.path(), "rollback_previous", hook) { recovery_errors.push(e.to_string()); }
        }
        if changed_latest || changed_previous {
            if let Err(e) = sync_directory(&parent) { recovery_errors.push(e.to_string()); }
        }
        if !recovery_errors.is_empty() {
            work.keep = true;
            // Disarm Drop without removing the marker: recovery is required.
            lock.owned = false;
            return Err(format!("백업 저장과 원상 복구를 끝내지 못했습니다. 다시 저장하지 말고 보존한 원본을 확인하세요. 복구 폴더: {}. 잠금 파일: {}. 원인: {error}; {}", work.path().display(), lock.path.display(), recovery_errors.join("; ")));
        }
        return Err(format!("백업을 저장하지 못했습니다. 기존 백업은 보존했습니다. 저장 공간과 폴더 권한을 확인한 뒤 다시 시도하세요: {error}"));
    }
    Ok(())
}

fn restore_original(target: &Path, snapshot: &Path, existed: bool, work: &Path, label: &str, hook: &mut Hook<'_>) -> io::Result<()> {
    if existed {
        let temporary = work.join(label);
        copy_verified(snapshot, &temporary, label, hook)?;
        hook(&format!("{label}:replace"))?;
        replace(&temporary, target)?;
        equal_files(snapshot, target)
    } else {
        hook(&format!("{label}:remove"))?;
        fs::remove_file(target)?;
        if regular(target)? { return Err(io::Error::new(io::ErrorKind::Other, "New backup could not be removed during rollback")); }
        Ok(())
    }
}

#[cfg(windows)]
mod windows {
    use super::*;
    use std::ffi::c_void;
    use std::os::windows::ffi::OsStrExt;
    #[repr(C)]
    struct SecurityAttributes { length: u32, descriptor: *mut c_void, inherit: i32 }
    #[link(name = "advapi32")]
    extern "system" {
        fn ConvertStringSecurityDescriptorToSecurityDescriptorW(value: *const u16, revision: u32, out: *mut *mut c_void, size: *mut u32) -> i32;
    }
    #[link(name = "kernel32")]
    extern "system" {
        fn CreateDirectoryW(path: *const u16, security: *const SecurityAttributes) -> i32;
        fn LocalFree(value: *mut c_void) -> *mut c_void;
        fn MoveFileExW(from: *const u16, to: *const u16, flags: u32) -> i32;
    }
    fn wide(path: &Path) -> io::Result<Vec<u16>> {
        let mut value: Vec<u16> = path.as_os_str().encode_wide().collect();
        if value.contains(&0) { return Err(io::Error::new(io::ErrorKind::InvalidInput, "NUL in backup path")); }
        value.push(0); Ok(value)
    }
    pub(super) fn private_directory(path: &Path) -> io::Result<()> {
        let path = wide(path)?;
        // Protected owner-rights DACL, inherited by files/subdirectories.
        // Windows applies ACLs only on filesystems supporting persistent ACLs.
        // https://learn.microsoft.com/windows/win32/api/fileapi/nf-fileapi-createdirectoryw
        let sddl: Vec<u16> = "D:P(A;OICI;FA;;;OW)\0".encode_utf16().collect();
        let mut descriptor = std::ptr::null_mut();
        unsafe {
            if ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl.as_ptr(), 1, &mut descriptor, std::ptr::null_mut()) == 0 { return Err(io::Error::last_os_error()); }
            let security = SecurityAttributes { length: std::mem::size_of::<SecurityAttributes>() as u32, descriptor, inherit: 0 };
            let result = CreateDirectoryW(path.as_ptr(), &security);
            let error = io::Error::last_os_error();
            LocalFree(descriptor);
            if result == 0 { Err(error) } else { Ok(()) }
        }
    }
    pub(super) fn replace(from: &Path, to: &Path) -> io::Result<()> {
        let from = wide(from)?; let to = wide(to)?;
        // Same-volume replacement; never COPY_ALLOWED/delete-then-copy.
        // https://learn.microsoft.com/windows/win32/api/winbase/nf-winbase-movefileexw
        if unsafe { MoveFileExW(from.as_ptr(), to.as_ptr(), 0x1 | 0x8) } == 0 { Err(io::Error::last_os_error()) } else { Ok(()) }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> Workspace {
        let path = PathBuf::from(std::env::var_os("RV_BACKUP_FIXTURE_ROOT").expect("Use a dedicated repository fixture directory"));
        Workspace::new(&path).unwrap()
    }
    fn setup(folder: &Path, name: &str) -> (PathBuf, PathBuf, PathBuf) {
        let staged = folder.join("staged.bin");
        let latest = folder.join(name);
        let previous = previous_path(&latest).unwrap();
        fs::write(&staged, vec![3u8; 70_001]).unwrap();
        fs::write(&latest, b"previous successful backup").unwrap();
        fs::write(&previous, b"older successful backup").unwrap();
        (staged, latest, previous)
    }
    fn check_originals(latest: &Path, previous: &Path) {
        assert_eq!(fs::read(latest).unwrap(), b"previous successful backup");
        assert_eq!(fs::read(previous).unwrap(), b"older successful backup");
    }
    #[test]
    fn successful_publication_rotates_both_supported_extensions() {
        for name in ["PLAYXRaven.zip", "PLAYXRaven.zip.pxlock", "wallet.dat", ".backup-complete.json"] {
            let f = fixture();
            let (staged, latest, previous) = setup(f.path(), name);
            publish_file(&staged, &latest).unwrap();
            equal_files(&staged, &latest).unwrap();
            assert_eq!(fs::read(previous).unwrap(), b"previous successful backup");
            assert_eq!(fs::read_dir(f.path()).unwrap().count(), 3);
        }
    }
    #[test]
    fn every_publication_failure_restores_both_original_names() {
        let f = fixture();
        let (staged, latest, _) = setup(f.path(), "baseline.zip.pxlock");
        let mut points = Vec::new();
        publish_with(&staged, &latest, &mut |point| { points.push(point.to_string()); Ok(()) }).unwrap();
        for stop in 0..points.len() {
            let f = fixture();
            let (staged, latest, previous) = setup(f.path(), "PLAYXRaven.zip.pxlock");
            let mut index = 0;
            let mut triggered = false;
            let result = publish_with(&staged, &latest, &mut |_| {
                let fail = index == stop;
                index += 1;
                if fail { triggered = true; Err(io::Error::other("synthetic disk failure")) } else { Ok(()) }
            });
            assert!(triggered && result.is_err(), "fault {} must be rejected", points[stop]);
            check_originals(&latest, &previous);
            assert_eq!(fs::read_dir(f.path()).unwrap().count(), 3, "temporary files leaked at {}", points[stop]);
        }
        println!("Checked {} real I/O checkpoints with originals preserved", points.len());
    }
    #[test]
    fn rollback_failure_keeps_original_snapshots_and_blocks_retry() {
        let f = fixture();
        let (staged, latest, previous) = setup(f.path(), "PLAYXRaven.zip.pxlock");
        let error = publish_with(&staged, &latest, &mut |point| {
            if point == "published:verify" || point == "rollback_latest:replace" || point == "rollback_previous:replace" {
                Err(io::Error::other("synthetic persistent disk failure"))
            } else { Ok(()) }
        }).unwrap_err();
        assert!(error.contains("복구 폴더"));
        let work = fs::read_dir(f.path()).unwrap().filter_map(Result::ok).find(|entry| entry.file_name().to_string_lossy().starts_with(".rv-backup-")).unwrap().path();
        assert_eq!(fs::read(work.join("old-latest")).unwrap(), b"previous successful backup");
        assert_eq!(fs::read(work.join("old-previous")).unwrap(), b"older successful backup");
        assert!(work.join("RECOVERY.txt").is_file());
        let current = fs::read(&latest).unwrap();
        let prior = fs::read(&previous).unwrap();
        assert!(publish_file(&staged, &latest).unwrap_err().contains("잠금 파일"));
        assert_eq!(fs::read(latest).unwrap(), current);
        assert_eq!(fs::read(previous).unwrap(), prior);
    }
    #[test]
    fn stale_lock_and_invalid_source_never_touch_existing_backups() {
        let f = fixture();
        let (staged, latest, previous) = setup(f.path(), "PLAYXRaven.zip.pxlock");
        let lock = f.path().join(".PLAYXRaven.zip.pxlock.publish-lock");
        fs::write(&lock, b"synthetic interrupted process").unwrap();
        assert!(publish_file(&staged, &latest).is_err());
        assert_eq!(fs::read(&lock).unwrap(), b"synthetic interrupted process");
        check_originals(&latest, &previous);
        fs::remove_file(lock).unwrap();
        fs::remove_file(&staged).unwrap();
        assert!(publish_file(&staged, &latest).is_err());
        check_originals(&latest, &previous);
    }
    #[test]
    fn initially_absent_files_stay_absent_after_failure() {
        for prior in [false, true] {
            let f = fixture();
            let staged = f.path().join("staged.bin");
            let latest = f.path().join("PLAYXRaven.zip");
            let previous = previous_path(&latest).unwrap();
            fs::write(&staged, b"synthetic new backup").unwrap();
            if prior { fs::write(&previous, b"older successful backup").unwrap(); }
            assert!(publish_with(&staged, &latest, &mut |point| {
                if point == "published:sync" { Err(io::Error::other("synthetic sync failure")) } else { Ok(()) }
            }).is_err());
            assert!(!latest.exists());
            if prior { assert_eq!(fs::read(&previous).unwrap(), b"older successful backup"); }
            else { assert!(!previous.exists()); }
        }
        let f = fixture();
        let (staged, latest, previous) = setup(f.path(), "PLAYXRaven.zip.pxlock");
        fs::remove_file(&previous).unwrap();
        assert!(publish_with(&staged, &latest, &mut |point| {
            if point == "published:sync" { Err(io::Error::other("synthetic sync failure")) } else { Ok(()) }
        }).is_err());
        assert_eq!(fs::read(latest).unwrap(), b"previous successful backup");
        assert!(!previous.exists());
    }
    #[test]
    fn workspaces_are_unique_private_and_remove_only_their_own_files() {
        let f = fixture();
        let first = Workspace::new(f.path()).unwrap();
        let second = Workspace::new(f.path()).unwrap();
        assert_ne!(first.path(), second.path());
        let first_path = first.path().to_owned();
        fs::write(second.path().join("keep"), b"synthetic").unwrap();
        #[cfg(unix)] {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(fs::metadata(first.path()).unwrap().permissions().mode() & 0o777, 0o700);
        }
        drop(first);
        assert!(!first_path.exists());
        assert!(second.path().join("keep").is_file());
    }
    #[cfg(unix)]
    #[test]
    fn symbolic_link_destinations_are_rejected() {
        use std::os::unix::fs::symlink;
        let f = fixture();
        let source = f.path().join("source");
        let latest = f.path().join("PLAYXRaven.zip");
        fs::write(&source, b"synthetic source").unwrap();
        symlink(&source, &latest).unwrap();
        assert!(publish_file(&source, &latest).is_err());
        assert_eq!(fs::read(source).unwrap(), b"synthetic source");
        assert!(fs::symlink_metadata(latest).unwrap().file_type().is_symlink());
    }

    #[test]
    fn readback_detects_actual_corruption_before_replacing_either_backup() {
        let f = fixture();
        let (staged, latest, previous) = setup(f.path(), "PLAYXRaven.zip.pxlock");
        assert!(publish_with(&staged, &latest, &mut |point| {
            if point == "new:verify" {
                let work = fs::read_dir(f.path())?.filter_map(Result::ok).find(|e| e.file_name().to_string_lossy().starts_with(".rv-backup-")).unwrap().path();
                fs::write(work.join("new-file"), vec![9u8; 70_001])?;
            }
            Ok(())
        }).is_err());
        check_originals(&latest, &previous);
    }

    #[test]
    fn concurrent_publication_is_rejected_while_the_first_owns_the_destination() {
        let f = fixture();
        let (staged, latest, previous) = setup(f.path(), "PLAYXRaven.zip.pxlock");
        let (ready_tx, ready_rx) = std::sync::mpsc::channel();
        let (resume_tx, resume_rx) = std::sync::mpsc::channel();
        let thread_staged = staged.clone();
        let thread_latest = latest.clone();
        std::thread::scope(|scope| {
            let first = scope.spawn(move || publish_with(&thread_staged, &thread_latest, &mut |point| {
                if point == "new:read" {
                    ready_tx.send(()).unwrap();
                    resume_rx.recv_timeout(std::time::Duration::from_secs(5)).unwrap();
                }
                Ok(())
            }));
            ready_rx.recv_timeout(std::time::Duration::from_secs(5)).unwrap();
            let second = publish_file(&staged, &latest);
            check_originals(&latest, &previous);
            resume_tx.send(()).unwrap();
            assert!(second.unwrap_err().contains("잠금 파일"));
            first.join().unwrap().unwrap();
        });
        equal_files(&staged, &latest).unwrap();
        assert_eq!(fs::read(previous).unwrap(), b"previous successful backup");
    }
}
