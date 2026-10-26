//! Signed release statement binds package bytes to the advertised and embedded version.
use base64::Engine;
use semver::Version;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{io::Read, path::Path};
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Release {
    pub version: String,
    pub sha256: String,
    pub target: String,
    pub expires: u64,
    pub sequence: u64,
}
#[derive(Serialize, Deserialize)]
struct Floor {
    version: String,
    sequence: u64,
    sha256: String,
}
fn version(s: &str) -> Result<Version, String> {
    Version::parse(s).map_err(|_| "업데이트 버전 오류".into())
}
pub fn signed_release(text: &str, signature: &str, key: &str) -> Result<Release, String> {
    if text.len() > 4096 || signature.len() > 4096 {
        return Err("업데이트 메타데이터 크기 오류".into());
    }
    let key = base64::engine::general_purpose::STANDARD
        .decode(key)
        .map_err(|_| "업데이트 검증키 오류")?;
    let key = std::str::from_utf8(&key).map_err(|_| "업데이트 검증키 오류")?;
    let key = minisign_verify::PublicKey::decode(key).map_err(|_| "업데이트 검증키 오류")?;
    let sig = minisign_verify::Signature::decode(signature)
        .map_err(|_| "업데이트 메타데이터 서명 오류")?;
    key.verify(text.as_bytes(), &sig, false)
        .map_err(|_| "업데이트 메타데이터 서명 불일치")?;
    serde_json::from_str(text).map_err(|_| "업데이트 메타데이터 형식 오류".into())
}
/// 앱 쪽 스위치: 자동 업데이트를 **허용하는 대상**을 한 곳에 못 박는다.
/// (서버가 해당 대상의 `signed_releases` 를 게시하지 않으면 여기에 있어도 설치는 막힌다 — 1차 스위치.)
pub const UPDATE_TARGETS_ENABLED: &[&str] = &[
    "darwin-aarch64",
    "darwin-x86_64",
    "windows-x86_64",
    "linux-x86_64",
];

/// 🟡 **낮은 보증** 모드를 허용하는 대상. 패키지 안의 버전을 앱이 읽지 못하고
/// 서명된 진술의 version 을 그대로 믿는 대상만 여기에 둔다. 기본은 리눅스(AppImage)뿐.
/// 맥·윈도우는 반드시 `Verified` 여야 하므로 여기에 넣지 않는다.
pub const STATEMENT_ONLY_TARGETS: &[&str] = &["linux-x86_64"];

/// 패키지 바이트에서 앱이 얼마나 버전을 확인했는가.
#[derive(Debug, PartialEq, Eq)]
pub enum PackageVersion {
    /// 패키지 안의 버전을 앱이 직접 읽었다(맥 Info.plist · 윈도우 VS_VERSIONINFO).
    /// 서명자가 진술에 버전을 잘못 적으면 여기서 잡힌다.
    Verified(String),
    /// 🟡 형식(AppImage)만 확인했고 **버전은 읽지 않았다.** 버전은 서명된 진술을 그대로 믿는다.
    /// 서명 + sha256 이 바이트를 서명자에게 묶어 주지만, 「서명자가 옛 AppImage 에 새 버전을
    /// 적는 실수」는 클라이언트가 **못 잡는다.** (되돌림 방지는 sequence·Floor 가 따로 막는다.)
    StatementOnly,
}

/// AppImage 형식 확인: ELF 매직 + AppImage type 표지(offset 8 의 `AI\x01` 또는 `AI\x02`).
/// ELF/squashfs 내부는 **파싱하지 않는다**(공격면이 넓다).
pub fn is_appimage(bytes: &[u8]) -> bool {
    bytes.len() >= 64
        && bytes.starts_with(b"\x7fELF")
        && bytes[8] == b'A'
        && bytes[9] == b'I'
        && (bytes[10] == 1 || bytes[10] == 2)
}

/// 설치 직전 패키지를 **실행·압축해제 없이** 검사한다. 대상별로:
/// - `darwin-*`: 서명된 tar.gz 안 Info.plist → `Verified`
/// - `windows-x86_64`: NSIS exe 의 VS_VERSIONINFO → `Verified`
/// - `linux-x86_64`: AppImage 형식만 → `StatementOnly`
/// - 그 밖: Err (설치 차단)
pub fn package_version(bytes: &[u8], target: &str) -> Result<PackageVersion, String> {
    if !UPDATE_TARGETS_ENABLED.contains(&target) {
        return Err("이 플랫폼의 패키지 버전 검증은 아직 지원되지 않습니다. 설치 차단".into());
    }
    match target {
        "windows-x86_64" => crate::pe_version::product_version(bytes).map(PackageVersion::Verified),
        "linux-x86_64" => {
            if is_appimage(bytes) {
                Ok(PackageVersion::StatementOnly)
            } else {
                Err("AppImage 형식이 아닙니다. 설치 차단".into())
            }
        }
        _ => darwin_package_version(bytes).map(PackageVersion::Verified),
    }
}

fn darwin_package_version(bytes: &[u8]) -> Result<String, String> {
    let decoder = flate2::read::GzDecoder::new(bytes);
    let mut archive = tar::Archive::new(decoder.take(2 * 1024 * 1024 * 1024));
    let mut found = None;
    for entry in archive
        .entries()
        .map_err(|_| "업데이트 압축 형식 오류")?
        .take(100000)
    {
        let mut entry = entry.map_err(|_| "업데이트 압축 읽기 오류")?;
        let p = entry.path().map_err(|_| "업데이트 경로 오류")?.into_owned();
        let parts: Vec<_> = p.components().collect();
        if parts
            .iter()
            .any(|p| !matches!(p, std::path::Component::Normal(_)))
        {
            return Err("업데이트 경로 오류".into());
        }
        // Only top-level app metadata, never nested framework/helper metadata.
        if parts.len() == 3 && p.to_string_lossy().ends_with(".app/Contents/Info.plist") {
            if found.is_some()
                || !entry.header().entry_type().is_file()
                || entry.size() > 1024 * 1024
            {
                return Err("업데이트 앱 메타데이터 오류".into());
            }
            let mut data = Vec::new();
            entry
                .read_to_end(&mut data)
                .map_err(|_| "업데이트 버전 읽기 오류")?;
            let value = plist::Value::from_reader(std::io::Cursor::new(data))
                .map_err(|_| "업데이트 plist 오류")?;
            found = Some(
                value
                    .as_dictionary()
                    .and_then(|d| d.get("CFBundleShortVersionString"))
                    .and_then(|s| s.as_string())
                    .ok_or("패키지 버전 없음")?
                    .to_string(),
            );
        }
    }
    found.ok_or("패키지 버전 없음".into())
}
pub fn enforce(
    path: &Path,
    current: &str,
    advertised: &str,
    r: &Release,
    bytes: &[u8],
    target: &str,
    now: u64,
) -> Result<(), String> {
    let actual = package_version(bytes, target)?;
    // Verified: 패키지 안에서 읽은 버전이 진술과 같아야 한다.
    // StatementOnly: 허용 대상일 때만, 버전은 (서명된) 진술을 믿는다.
    let package_ok = match &actual {
        PackageVersion::Verified(a) => r.version == *a,
        PackageVersion::StatementOnly => STATEMENT_ONLY_TARGETS.contains(&target),
    };
    let v = version(&r.version)?;
    let installed = version(current)?;
    if r.version != advertised
        || !package_ok
        || v <= installed
        || r.target != target
        || r.expires <= now
        || r.sequence == 0
        || r.sha256 != hex::encode(Sha256::digest(bytes))
    {
        return Err("버전·패키지·서명 정책 불일치 또는 이전 버전 재생".into());
    }
    let floor = match std::fs::read(path) {
        Ok(b) => {
            serde_json::from_slice::<Floor>(&b).map_err(|_| "최소 버전 기록 손상: 설치 차단")?
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Floor {
            version: current.into(),
            sequence: 0,
            sha256: String::new(),
        },
        Err(_) => return Err("최소 버전 읽기 실패".into()),
    };
    let minimum = version(&floor.version)?;
    if v < minimum
        || r.sequence < floor.sequence
        || (r.sequence == floor.sequence
            && (r.version != floor.version || r.sha256 != floor.sha256))
        || (v == minimum && !floor.sha256.is_empty() && r.sha256 != floor.sha256)
    {
        return Err("최소 허용 버전/릴리스 순번보다 이전입니다.".into());
    }
    let next = Floor {
        version: r.version.clone(),
        sequence: r.sequence,
        sha256: r.sha256.clone(),
    };
    crate::payout_guard::atomic_write(
        path,
        &serde_json::to_vec(&next).map_err(|_| "최소 버전 기록 오류")?,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use ring::signature::KeyPair;
    fn package(v: &str) -> Vec<u8> {
        let mut a = tar::Builder::new(Vec::new());
        let data=format!("<?xml version=\"1.0\"?><plist version=\"1.0\"><dict><key>CFBundleShortVersionString</key><string>{v}</string></dict></plist>");
        let mut h = tar::Header::new_gnu();
        h.set_size(data.len() as u64);
        h.set_mode(0o644);
        h.set_cksum();
        a.append_data(&mut h, "Synthetic.app/Contents/Info.plist", data.as_bytes())
            .unwrap();
        let mut out = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
        std::io::Write::write_all(&mut out, &a.into_inner().unwrap()).unwrap();
        out.finish().unwrap()
    }
    fn release(v: &str, b: &[u8], sequence: u64) -> Release {
        release_for("darwin-aarch64", v, b, sequence)
    }
    fn release_for(target: &str, v: &str, b: &[u8], sequence: u64) -> Release {
        Release {
            version: v.into(),
            sha256: hex::encode(Sha256::digest(b)),
            target: target.into(),
            expires: 9999,
            sequence,
        }
    }
    // Ephemeral synthetic signer, entirely in memory. No key is logged or written.
    fn signed(r: &Release) -> (String, String, String) {
        let rng = ring::rand::SystemRandom::new();
        let pair = ring::signature::Ed25519KeyPair::generate_pkcs8(&rng).unwrap();
        let pair = ring::signature::Ed25519KeyPair::from_pkcs8(pair.as_ref()).unwrap();
        let statement = serde_json::to_string(r).unwrap();
        let digest = blake2::Blake2b512::digest(statement.as_bytes());
        let sig = pair.sign(&digest);
        let comment = "secfix2 ephemeral test";
        let global = pair.sign(&[sig.as_ref(), comment.as_bytes()].concat());
        let b64 = &base64::engine::general_purpose::STANDARD;
        let key = b64.encode(format!(
            "untrusted comment: ephemeral\n{}",
            b64.encode([b"Ed".as_slice(), &[0u8; 8], pair.public_key().as_ref()].concat())
        ));
        let signature = format!(
            "untrusted comment: ephemeral\n{}\ntrusted comment: {comment}\n{}",
            b64.encode([b"ED".as_slice(), &[0u8; 8], sig.as_ref()].concat()),
            b64.encode(global.as_ref())
        );
        (statement, signature, key)
    }
    #[test]
    fn valid_old_signature_does_not_authorize_replay_or_version_substitution() {
        let root = std::env::temp_dir().join(format!("secfix2-update-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let floor = root.join("minimum.json");
        let old = package("0.8.0");
        let (text, sig, key) = signed(&release("0.8.0", &old, 1));
        let verified = signed_release(&text, &sig, &key).unwrap();
        assert!(enforce(
            &floor,
            "0.8.3",
            "9.0.0",
            &verified,
            &old,
            "darwin-aarch64",
            100
        )
        .is_err());
        assert!(enforce(
            &floor,
            "0.8.3",
            "0.8.0",
            &verified,
            &old,
            "darwin-aarch64",
            100
        )
        .is_err());
        let substituted = release("9.0.0", &old, 2);
        assert!(enforce(
            &floor,
            "0.8.3",
            "9.0.0",
            &substituted,
            &old,
            "darwin-aarch64",
            100
        )
        .is_err());
        let new = package("0.9.0");
        let r = release("0.9.0", &new, 3);
        enforce(&floor, "0.8.3", "0.9.0", &r, &new, "darwin-aarch64", 100).unwrap();
        assert!(enforce(&floor, "0.9.0", "0.9.0", &r, &new, "darwin-aarch64", 100).is_err());
        let middle = package("0.8.5");
        assert!(enforce(
            &floor,
            "0.8.3",
            "0.8.5",
            &release("0.8.5", &middle, 2),
            &middle,
            "darwin-aarch64",
            100
        )
        .is_err());
        assert!(enforce(&floor, "0.8.3", "0.9.0", &r, &new, "darwin-aarch64", 10000).is_err());
        assert!(enforce(&floor, "0.8.3", "0.9.0", &r, &new, "windows-x86_64", 100).is_err());
        assert!(signed_release(&(text + " "), &sig, &key).is_err());
        assert!(enforce(&floor, "0.8.3", "0.9.0", &r, &old, "darwin-aarch64", 100).is_err());
        std::fs::write(&floor, b"corrupt").unwrap();
        assert!(enforce(&floor, "0.8.3", "0.9.0", &r, &new, "darwin-aarch64", 100).is_err());
        std::fs::remove_dir_all(root).unwrap();
    }
}

#[cfg(test)]
mod platform_tests {
    use super::*;
    use crate::pe_version::tests::synthetic_installer;
    const WIN: &str = "windows-x86_64";
    const LIN: &str = "linux-x86_64";
    fn appimage() -> Vec<u8> {
        let mut b = vec![0u8; 256];
        b[..4].copy_from_slice(b"\x7fELF");
        b[8..11].copy_from_slice(b"AI\x02");
        b
    }
    fn rel(target: &str, v: &str, b: &[u8], seq: u64) -> Release {
        Release {
            version: v.into(),
            sha256: hex::encode(Sha256::digest(b)),
            target: target.into(),
            expires: 9999,
            sequence: seq,
        }
    }
    fn floor(name: &str) -> (std::path::PathBuf, std::path::PathBuf) {
        let root = std::env::temp_dir().join(format!("updclient-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        (root.join("minimum.json"), root)
    }

    #[test]
    fn enabled_targets_are_pinned() {
        assert_eq!(
            UPDATE_TARGETS_ENABLED,
            &["darwin-aarch64", "darwin-x86_64", "windows-x86_64", "linux-x86_64"]
        );
        assert_eq!(STATEMENT_ONLY_TARGETS, &["linux-x86_64"]);
    }

    #[test]
    fn unknown_targets_are_still_rejected() {
        let (f, root) = floor("unknown");
        for t in ["windows-aarch64", "linux-aarch64", "freebsd-x86_64", "windows", "", "linux-x86_64 "] {
            let w = synthetic_installer("0.9.5");
            assert!(package_version(&w, t).is_err(), "{t}");
            assert!(enforce(&f, "0.9.0", "0.9.5", &rel(t, "0.9.5", &w, 1), &w, t, 100).is_err(), "{t}");
            let a = appimage();
            assert!(package_version(&a, t).is_err(), "{t}");
        }
        // statement-only 는 맥·윈도우에서 절대 안 나온다.
        assert!(package_version(&appimage(), "windows-x86_64").is_err());
        assert!(package_version(&appimage(), "darwin-aarch64").is_err());
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn windows_installer_is_verified_from_inside_the_package() {
        let (f, root) = floor("win");
        let new = synthetic_installer("0.9.5");
        assert_eq!(package_version(&new, WIN).unwrap(), PackageVersion::Verified("0.9.5".into()));
        // 진술이 패키지와 다른 버전을 주장 → 거부(서명자 실수/치환)
        assert!(enforce(&f, "0.9.0", "9.0.0", &rel(WIN, "9.0.0", &new, 1), &new, WIN, 100).is_err());
        // 오래된(서명된) 패키지에 새 버전을 붙인 치환 → 거부
        let old = synthetic_installer("0.8.0");
        assert!(enforce(&f, "0.8.3", "0.9.5", &rel(WIN, "0.9.5", &old, 1), &old, WIN, 100).is_err());
        // 오래된 패키지 + 오래된 진술 = 현재보다 낮음 → 되돌림 거부
        assert!(enforce(&f, "0.8.3", "0.8.0", &rel(WIN, "0.8.0", &old, 1), &old, WIN, 100).is_err());
        // 변조된 PE(바이트 하나 바뀜) → sha256 불일치
        let r = rel(WIN, "0.9.5", &new, 2);
        let mut bad = new.clone();
        let last = bad.len() - 1;
        bad[last] ^= 1;
        assert!(enforce(&f, "0.9.0", "0.9.5", &r, &bad, WIN, 100).is_err());
        // 변조된 PE 가 진술까지 맞춰져도(해시 재계산) 버전 문자열이 깨지면 거부
        let mut broken = new.clone();
        broken.truncate(broken.len() - 40);
        assert!(enforce(&f, "0.9.0", "0.9.5", &rel(WIN, "0.9.5", &broken, 2), &broken, WIN, 100).is_err());
        // 대상 불일치(진술은 darwin)
        assert!(enforce(&f, "0.9.0", "0.9.5", &rel("darwin-aarch64", "0.9.5", &new, 2), &new, WIN, 100).is_err());
        // 정상
        enforce(&f, "0.9.0", "0.9.5", &r, &new, WIN, 100).unwrap();
        // 재생: 같은 버전으로는 다시 안 됨, 더 낮은 sequence 로 다른 해시도 안 됨
        assert!(enforce(&f, "0.9.5", "0.9.5", &r, &new, WIN, 100).is_err());
        let other = synthetic_installer("0.9.6");
        assert!(enforce(&f, "0.9.0", "0.9.6", &rel(WIN, "0.9.6", &other, 1), &other, WIN, 100).is_err());
        // 만료
        assert!(enforce(&f, "0.9.0", "0.9.5", &r, &new, WIN, 10_000).is_err());
        // 맥 tar.gz·MSI 모양(CFB 머리)·zip 은 윈도우 대상에서 거부
        assert!(package_version(&[0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1], WIN).is_err());
        assert!(package_version(b"PK\x03\x04zipzip", WIN).is_err());
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn linux_appimage_is_statement_only_and_still_policy_checked() {
        let (f, root) = floor("lin");
        let a = appimage();
        assert_eq!(package_version(&a, LIN).unwrap(), PackageVersion::StatementOnly);
        // 형식이 아니면 거부: 빈 것·ELF 만·AI 표지 없음·잘못된 type·gz·deb(ar)
        assert!(package_version(b"", LIN).is_err());
        let mut elf_only = a.clone();
        elf_only[8..11].copy_from_slice(&[0, 0, 0]);
        assert!(package_version(&elf_only, LIN).is_err());
        let mut type3 = a.clone();
        type3[10] = 3;
        assert!(package_version(&type3, LIN).is_err());
        let mut noelf = a.clone();
        noelf[0] = 0;
        assert!(package_version(&noelf, LIN).is_err());
        assert!(package_version(b"\x1f\x8b\x08\0 gz gz gz gz gz gz gz gz gz gz gz gz gz gz gz gz gz", LIN).is_err());
        assert!(package_version(b"!<arch>\ndebian-binary   ", LIN).is_err());
        let mut type1 = a.clone();
        type1[10] = 1;
        assert_eq!(package_version(&type1, LIN).unwrap(), PackageVersion::StatementOnly);
        // 서명 진술의 version 을 믿되 나머지 정책은 그대로
        let r = rel(LIN, "0.9.5", &a, 3);
        assert!(enforce(&f, "0.9.0", "0.9.4", &r, &a, LIN, 100).is_err()); // 광고 불일치
        assert!(enforce(&f, "0.9.5", "0.9.5", &r, &a, LIN, 100).is_err()); // 새 버전 아님
        assert!(enforce(&f, "0.9.6", "0.9.5", &r, &a, LIN, 100).is_err()); // 되돌림
        assert!(enforce(&f, "0.9.0", "0.9.5", &r, &a, LIN, 10_000).is_err()); // 만료
        assert!(enforce(&f, "0.9.0", "0.9.5", &rel(WIN, "0.9.5", &a, 3), &a, LIN, 100).is_err()); // 대상 불일치
        assert!(enforce(&f, "0.9.0", "0.9.5", &rel(LIN, "0.9.5", &a, 0), &a, LIN, 100).is_err()); // sequence 0
        let mut tampered = a.clone();
        tampered[100] ^= 1;
        assert!(enforce(&f, "0.9.0", "0.9.5", &r, &tampered, LIN, 100).is_err()); // sha256
        enforce(&f, "0.9.0", "0.9.5", &r, &a, LIN, 100).unwrap();
        // Floor 되돌림: 같은 순번 다른 해시 / 낮은 순번
        let mut a2 = a.clone();
        a2[100] ^= 1;
        assert!(enforce(&f, "0.9.0", "0.9.5", &rel(LIN, "0.9.5", &a2, 3), &a2, LIN, 100).is_err());
        assert!(enforce(&f, "0.9.0", "0.9.6", &rel(LIN, "0.9.6", &a2, 2), &a2, LIN, 100).is_err());
        let _ = std::fs::remove_dir_all(root);
    }
}

pub fn remember_installed(path: &Path, current: &str) -> Result<(), String> {
    let installed = version(current)?;
    let mut floor = match std::fs::read(path) {
        Ok(b) => serde_json::from_slice::<Floor>(&b).map_err(|_| "최소 버전 기록 손상")?,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Floor {
            version: current.into(),
            sequence: 0,
            sha256: String::new(),
        },
        Err(_) => return Err("최소 버전 읽기 실패".into()),
    };
    if installed > version(&floor.version)? {
        floor.version = current.into();
        floor.sha256.clear();
    }
    crate::payout_guard::atomic_write(
        path,
        &serde_json::to_vec(&floor).map_err(|_| "최소 버전 기록 오류")?,
    )
}
#[cfg(test)]
mod floor_tests {
    use super::*;
    #[test]
    fn installed_floor_is_durable_monotonic_and_corruption_fails_closed() {
        let root = std::env::temp_dir().join(format!("secfix2-floor-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let p = root.join("floor.json");
        remember_installed(&p, "0.9.0").unwrap();
        assert!(
            p.exists(),
            "installed floor must be persisted before update checks"
        );
        remember_installed(&p, "0.8.3").unwrap();
        let floor: Floor = serde_json::from_slice(&std::fs::read(&p).unwrap()).unwrap();
        assert_eq!(floor.version, "0.9.0");
        std::fs::write(&p, b"damaged").unwrap();
        assert!(remember_installed(&p, "1.0.0").is_err());
        std::fs::remove_dir_all(root).unwrap();
    }
}
