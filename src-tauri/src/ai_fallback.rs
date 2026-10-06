//! Explicit device-bound fallback. Identifiers are NOT secrets; see threat model.
use super::{config_dir, write_private, StoreError};
use aes_gcm::{aead::{Aead, Payload}, Aes256Gcm, KeyInit, Nonce};
use rand::RngCore;
use std::{io::Read, path::{Path, PathBuf}};

const SALT: &[u8] = b"se.erci.ravenvault.desktop.ai.device.v1";
pub(super) fn path(provider: &str) -> PathBuf { config_dir().join(format!("{provider}.aead")) }
fn failure() -> String { StoreError::Corrupt.safe_message("get") }
fn private_read(path: &Path, limit: u64) -> Result<Vec<u8>, String> {
    let mut options = std::fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)] {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW);
    }
    let file = options.open(path).map_err(|_| failure())?;
    if !file.metadata().map_err(|_| failure())?.is_file() { return Err(failure()); }
    #[cfg(unix)] {
        use std::os::unix::fs::PermissionsExt;
        file.set_permissions(std::fs::Permissions::from_mode(0o600)).map_err(|_| failure())?;
    }
    let mut bytes = Vec::new();
    file.take(limit + 1).read_to_end(&mut bytes).map_err(|_| failure())?;
    if bytes.len() as u64 > limit { return Err(failure()); }
    Ok(bytes)
}
#[cfg(test)]
fn machine_id() -> Option<Vec<u8>> { Some(b"mock-device-identifier-not-a-secret".to_vec()) }
#[cfg(all(not(test), target_os = "macos"))]
fn machine_id() -> Option<Vec<u8>> {
    let output = std::process::Command::new("/usr/sbin/ioreg")
        .args(["-rd1", "-c", "IOPlatformExpertDevice"]).output().ok()?;
    if !output.status.success() { return None; }
    let text = String::from_utf8(output.stdout).ok()?;
    let line = text.lines().find(|line| line.contains("\"IOPlatformUUID\""))?;
    let id = line.split_once('=')?.1.trim().trim_matches('"');
    (!id.is_empty()).then(|| id.as_bytes().to_vec())
}
#[cfg(all(not(test), target_os = "windows"))]
fn machine_id() -> Option<Vec<u8>> {
    // Fixed registry query, no user-controlled command/path or shell.
    let output = std::process::Command::new("reg.exe")
        .args(["query", r"HKLM\SOFTWARE\Microsoft\Cryptography", "/v", "MachineGuid", "/reg:64"])
        .output().ok()?;
    if !output.status.success() { return None; }
    let text = String::from_utf8(output.stdout).ok()?;
    let id = text.lines().find(|line| line.contains("MachineGuid"))?.split_whitespace().last()?;
    (!id.is_empty()).then(|| id.as_bytes().to_vec())
}
#[cfg(all(not(test), not(any(target_os = "macos", target_os = "windows"))))]
fn machine_id() -> Option<Vec<u8>> {
    let id = std::fs::read_to_string("/etc/machine-id").ok()?;
    (!id.trim().is_empty()).then(|| id.trim().as_bytes().to_vec())
}
fn material(seed: bool, create: bool) -> Result<Vec<u8>, String> {
    if !seed { return machine_id().ok_or_else(failure); }
    let path = config_dir().join("ai-device.seed");
    if create && !path.try_exists().map_err(|_| failure())? {
        let mut bytes = [0u8; 32];
        rand::rngs::OsRng.fill_bytes(&mut bytes);
        write_private(&path, &bytes)?;
    }
    let bytes = private_read(&path, 32)?;
    if bytes.len() != 32 { return Err(failure()); }
    Ok(bytes)
}
fn cipher(provider: &str, seed: bool, create: bool) -> Result<Aes256Gcm, String> {
    let material = material(seed, create)?;
    let hkdf = hkdf::Hkdf::<sha2::Sha256>::new(Some(SALT), &material);
    let mut key = [0u8; 32];
    hkdf.expand(provider.as_bytes(), &mut key).map_err(|_| failure())?;
    Ok(Aes256Gcm::new((&key).into()))
}
pub(super) fn write(provider: &str, value: &str) -> Result<(), String> {
    let seed = machine_id().is_none();
    let cipher = cipher(provider, seed, true)?;
    let mut nonce = [0u8; 12];
    rand::rngs::OsRng.fill_bytes(&mut nonce);
    let encrypted = cipher.encrypt(Nonce::from_slice(&nonce), Payload { msg: value.as_bytes(), aad: provider.as_bytes() })
        .map_err(|_| StoreError::Unavailable.safe_message("set"))?;
    // Fixed version + material selection + nonce + ciphertext/tag. No secret metadata.
    let mut bytes = b"RVAI1".to_vec();
    bytes.push(u8::from(seed));
    bytes.extend_from_slice(&nonce);
    bytes.extend_from_slice(&encrypted);
    write_private(&path(provider), &bytes)
}
pub(super) fn read(provider: &str) -> Result<String, String> {
    let bytes = private_read(&path(provider), 8192)?;
    if bytes.len() < 34 || &bytes[..5] != b"RVAI1" || bytes[5] > 1 { return Err(failure()); }
    let cipher = cipher(provider, bytes[5] == 1, false)?;
    let plaintext = cipher.decrypt(Nonce::from_slice(&bytes[6..18]), Payload { msg: &bytes[18..], aad: provider.as_bytes() })
        .map_err(|_| failure())?;
    String::from_utf8(plaintext).map_err(|_| failure())
}

// Windows equivalent of Unix 0600, applied at creation before writing bytes.
#[cfg(windows)]
pub(super) fn create_private_file(path: &Path) -> std::io::Result<std::fs::File> {
    use std::os::windows::{ffi::OsStrExt, io::FromRawHandle};
    use windows_sys::Win32::{Foundation::{LocalFree, GENERIC_WRITE, INVALID_HANDLE_VALUE},
        Security::{Authorization::{ConvertStringSecurityDescriptorToSecurityDescriptorW, SDDL_REVISION_1}, PSECURITY_DESCRIPTOR, SECURITY_ATTRIBUTES},
        Storage::FileSystem::{CreateFileW, CREATE_NEW, FILE_ATTRIBUTE_NORMAL}};
    let wide: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
    let sddl: Vec<u16> = "D:P(A;;GA;;;OW)\0".encode_utf16().collect();
    let mut sd: PSECURITY_DESCRIPTOR = std::ptr::null_mut();
    unsafe {
        if ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl.as_ptr(), SDDL_REVISION_1, &mut sd, std::ptr::null_mut()) == 0 {
            return Err(std::io::Error::last_os_error());
        }
        let sa = SECURITY_ATTRIBUTES { nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32, lpSecurityDescriptor: sd, bInheritHandle: 0 };
        let handle = CreateFileW(wide.as_ptr(), GENERIC_WRITE, 0, &sa, CREATE_NEW, FILE_ATTRIBUTE_NORMAL, std::ptr::null_mut());
        let error = std::io::Error::last_os_error();
        LocalFree(sd);
        if handle == INVALID_HANDLE_VALUE { Err(error) } else { Ok(std::fs::File::from_raw_handle(handle)) }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn provider_binding_headers_truncation_and_seed() {
        let _guard = crate::paths::TEST_ENV.lock().unwrap_or_else(|e| e.into_inner());
        let dir = crate::paths::test_fixture_root().join("device-envelope-tests");
        std::fs::create_dir_all(&dir).unwrap();
        std::env::set_var("PLAYX_RAVEN_HOME", &dir);
        let secret = format!("fixture-{:032x}", rand::random::<u128>());
        write("google", &secret).unwrap();
        let bytes = std::fs::read(path("google")).unwrap();
        std::fs::write(path("openai"), &bytes).unwrap();
        assert!(read("openai").is_err(), "provider-bound HKDF and AAD");
        for n in [0, 4, 6, 17, 33, bytes.len() - 1] {
            std::fs::write(path("google"), &bytes[..n]).unwrap();
            assert!(read("google").is_err());
        }
        let mut header = bytes.clone(); header[5] = 2;
        std::fs::write(path("google"), header).unwrap();
        assert!(read("google").is_err());
        let first = material(true, true).unwrap();
        assert!(first.len() == 32 && material(true, false).is_ok_and(|v| v == first));
        #[cfg(unix)] {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(std::fs::metadata(dir.join("ai-device.seed")).unwrap().permissions().mode() & 0o777, 0o600);
            std::fs::remove_file(path("google")).unwrap();
            std::os::unix::fs::symlink(path("openai"), path("google")).unwrap();
            assert!(read("google").is_err(), "do not follow symlinks");
        }
        let nonce = [42u8; 12];
        let encrypted = cipher("google", true, false).unwrap().encrypt(Nonce::from_slice(&nonce), Payload { msg: secret.as_bytes(), aad: b"google" }).unwrap();
        let mut seeded = b"RVAI1".to_vec(); seeded.push(1); seeded.extend_from_slice(&nonce); seeded.extend_from_slice(&encrypted);
        // Replace the symlink itself; never write through its target.
        write_private(&path("google"), &seeded).unwrap();
        assert!(read("google").is_ok_and(|v| v == secret));
        std::fs::remove_file(dir.join("ai-device.seed")).unwrap();
        assert!(read("google").is_err());
        assert!(material(true, false).is_err(), "reads never silently regenerate a missing seed");
        std::env::remove_var("PLAYX_RAVEN_HOME");
        std::fs::remove_dir_all(dir).unwrap();
    }
}
