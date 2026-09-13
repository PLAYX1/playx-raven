//! Separate process implementing Boost's reference lock convention directly.
//! Never imports the production lock helper (an incorrect helper must be caught).
use std::{
    env,
    fs::OpenOptions,
    io::{self, Read, Write},
    path::Path,
};

fn run() -> io::Result<i32> {
    let args: Vec<String> = env::args().collect();
    let mode = args
        .get(1)
        .ok_or_else(|| io::Error::other("missing mode"))?;
    let path = Path::new(
        args.get(2)
            .ok_or_else(|| io::Error::other("missing synthetic path"))?,
    );
    let fixtures = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("fixtures")
        .canonicalize()?;
    if !path
        .parent()
        .ok_or_else(|| io::Error::other("no parent"))?
        .canonicalize()?
        .starts_with(fixtures)
    {
        return Err(io::Error::other("synthetic fixture directory required"));
    }
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(path)?;
    #[cfg(unix)]
    let locked = {
        use std::os::fd::AsRawFd;
        let mut range: libc::flock = unsafe { std::mem::zeroed() };
        range.l_type = libc::F_WRLCK as _;
        range.l_whence = libc::SEEK_SET as _;
        range.l_start = 0;
        range.l_len = 0;
        unsafe { libc::fcntl(file.as_raw_fd(), libc::F_SETLK, &range) != -1 }
    };
    #[cfg(windows)]
    let locked = {
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::{Storage::FileSystem::*, System::IO::OVERLAPPED};
        let mut range: OVERLAPPED = unsafe { std::mem::zeroed() };
        unsafe {
            LockFileEx(
                file.as_raw_handle() as _,
                LOCKFILE_EXCLUSIVE_LOCK | LOCKFILE_FAIL_IMMEDIATELY,
                0,
                u32::MAX,
                u32::MAX,
                &mut range,
            ) != 0
        }
    };
    if !locked {
        return Ok(73);
    }
    if mode == "hold" {
        println!("LOCKED");
        io::stdout().flush()?;
        let mut one = [0u8; 1];
        io::stdin().read_exact(&mut one)?;
    } else if mode != "probe" {
        return Err(io::Error::other("unknown mode"));
    }
    drop(file);
    Ok(0)
}

fn main() {
    std::process::exit(match run() {
        Ok(code) => code,
        Err(error) => {
            eprintln!("{error}");
            74
        }
    });
}
