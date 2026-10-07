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
/// Inspect the actual signed macOS archive without extracting/executing it. Other
/// native installer formats stay disabled until they have equivalent inspectors.
pub fn package_version(bytes: &[u8], target: &str) -> Result<String, String> {
    if !target.starts_with("darwin-") {
        return Err("이 플랫폼의 패키지 버전 검증은 아직 지원되지 않습니다. 설치 차단".into());
    }
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
    let v = version(&r.version)?;
    let installed = version(current)?;
    if r.version != advertised
        || r.version != actual
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
        Release {
            version: v.into(),
            sha256: hex::encode(Sha256::digest(b)),
            target: "darwin-aarch64".into(),
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
