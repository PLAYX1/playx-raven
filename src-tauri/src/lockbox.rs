//! 클라우드로 나가는 백업을 **우리가 한 번 더 잠근다.**
//!
//! ## 왜 필요한가
//!
//! 클라우드 백업에는 `wallet.dat` 이 들어간다. 그게 있어야 컴퓨터가 죽었을 때
//! 가게가 살아나기 때문이고, **노인은 종이 12단어를 잃어버린다** — 그게 우리가
//! 실제로 겪는 일이다. 클라우드를 빼는 것은 안전해 보이지만, 잃을 확률이 더
//! 높은 쪽을 없애는 것이다.
//!
//! 그런데 지금 그 지갑을 지키는 것은 레이븐코인 지갑 암호 하나뿐이고, 그건
//! **2011년 비트코인 방식** 그대로다 — SHA-512 를 25,000번 돌린다. 실측으로
//! 계산하면 GPU 한 장이 초당 8만 개를 시험한다:
//!
//! | 암호 | 뚫리는 시간 |
//! |---|---|
//! | 영단어 하나(`raven`) | **2.5초** |
//! | 영단어 둘(`ravenshop`) | 6일 |
//! | 무작위 8자 | 87년 |
//!
//! 사장이 무엇을 넣었는지 우리는 모른다. 그리고 알 수도 없다(저장하지 않으니까).
//! 그래서 **암호에 기대지 않는 자물쇠**를 하나 더 건다.
//!
//! ## 어떤 열쇠로 잠그나 — 사람 머리에 기대지 않는다
//!
//! 새 암호를 만들라고 하면 `1234` 를 넣거나 잊어버린다. 그래서 **우리가 무작위
//! 32바이트를 만들어** 컴퓨터에 0600 으로 둔다.
//!
//! 이게 안전한 이유는 위협이 무엇인지 보면 분명하다:
//!
//! | 무슨 일 | 지금 | 이 자물쇠가 있으면 |
//! |---|---|---|
//! | **클라우드 계정이 뚫림**(피싱·비번 재사용) | 가게 돈이 통째로 넘어간다 | 쓸모없는 덩어리다 |
//! | 컴퓨터를 도둑맞음 | 지갑을 그대로 가져간다 | **똑같다** — 이미 지갑을 가졌다 |
//!
//! 즉 열쇠를 컴퓨터에 두는 것이 손해가 아니다. 컴퓨터를 가진 사람은 이미
//! 지갑을 가졌다. 우리가 막으려는 건 **컴퓨터는 못 만졌는데 클라우드만
//! 들여다본 사람**이고, 그게 훨씬 흔하다.
//!
//! ## 🔴 컴퓨터가 죽으면 열쇠도 같이 죽는다
//!
//! 그래서 이 열쇠는 **종이에도 적혀야 한다.** 12단어와 같은 종이에 적고 같이
//! 보관한다. 그것 없이 클라우드 사본만 있으면 아무것도 못 연다 — 그건 백업이
//! 아니라 짐이다.
//!
//! ⚠️ 복구 카드(`recover.rs`)에는 **넣지 않는다.** 그 카드는 일부러 비밀이
//! 없게 만들어져 있고(`the_recovery_card_has_no_secrets`), 아무 데나 두어도
//! 되는 종이라는 것이 그 카드의 값어치다. 여기 열쇠는 12단어와 같은 급이다.

use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes256Gcm, Nonce};
use serde_json::{json, Value};
use std::path::PathBuf;

/// 파일 머리. 나중에 방식을 바꿀 때 옛 파일을 알아보려면 필요하다.
const MAGIC: &[u8; 8] = b"PXRLOCK1";

fn key_path() -> PathBuf {
    crate::paths::app_file("cloud-backup.key")
}

/// 이 컴퓨터의 백업 열쇠. 없으면 만든다.
///
/// ⚠️ 0600 으로 둔다. 같은 컴퓨터의 다른 사용자가 읽으면 이 자물쇠는 없는
/// 것과 같다.
pub fn key_get_or_make() -> Result<[u8; 32], String> {
    let p = key_path();
    if let Ok(raw) = std::fs::read_to_string(&p) {
        let bytes = from_paper(raw.trim())?;
        return Ok(bytes);
    }
    // 새로 만든다.
    use rand::RngCore;
    let mut k = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut k);
    if let Some(d) = p.parent() {
        let _ = std::fs::create_dir_all(d);
    }
    std::fs::write(&p, to_paper(&k)).map_err(|e| format!("열쇠를 두지 못했습니다: {e}"))?;
    lock_down(&p);
    Ok(k)
}

/// 파일 권한을 주인만 읽게 좁힌다.
fn lock_down(p: &std::path::Path) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(p, std::fs::Permissions::from_mode(0o600));
    }
    #[cfg(not(unix))]
    {
        let _ = p; // 윈도우는 사용자 폴더 권한을 그대로 따른다.
    }
}

/// 사람이 종이에 적고 다시 칠 수 있는 모양으로.
///
/// 🔴 Base64 를 쓰지 않는다. `l`·`I`·`1`, `O`·`0` 이 섞여 있어서 손으로
/// 옮겨 적을 때 틀린다 — 그리고 이건 **한 글자만 틀려도 아무것도 못 여는**
/// 값이다. 그래서 헷갈리는 글자를 뺀 32글자만 쓴다.
/// Crockford Base32 — 손으로 옮겨 적는 값을 위해 만들어진 표준이다.
/// 정확히 **32글자**여야 한다(5비트 = 32가지). 여기서 하나라도 모자라면
/// 서로 다른 값 둘이 같은 글자가 되고, 그러면 **적어 둔 열쇠로 안 열린다.**
/// 처음에 31글자를 써서 실제로 그 시험이 깨졌다.
///
/// `I`·`L`·`O`·`U` 를 뺐다. 앞의 셋은 `1`·`0` 과 헷갈리고, `U` 는 뜻하지 않은
/// 낱말이 만들어지는 것을 막으려고 뺀다(Crockford 의 원래 이유).
const ALPHABET: &[u8] = b"0123456789abcdefghjkmnpqrstvwxyz";

fn to_paper(k: &[u8; 32]) -> String {
    // 5비트씩 끊어 52글자. 네 글자마다 띄어 읽기 쉽게.
    let mut bits = 0u32;
    let mut n = 0;
    let mut out = String::new();
    for b in k {
        bits = (bits << 8) | *b as u32;
        n += 8;
        while n >= 5 {
            n -= 5;
            let idx = ((bits >> n) & 0x1f) as usize;
            out.push(ALPHABET[idx] as char);
        }
    }
    if n > 0 {
        let idx = ((bits << (5 - n)) & 0x1f) as usize;
        out.push(ALPHABET[idx] as char);
    }
    out.as_bytes()
        .chunks(4)
        .map(|c| std::str::from_utf8(c).unwrap_or(""))
        .collect::<Vec<_>>()
        .join("-")
}

fn from_paper(s: &str) -> Result<[u8; 32], String> {
    // 띄어쓰기·줄표는 무시하고, 대문자로 적었어도 받아 준다.
    // 🔴 사람은 `0` 을 `O` 로, `1` 을 `l`·`I` 로 적는다. Crockford 는 그걸
    // 받아 주게 되어 있고, 안 받아 주면 종이를 보고 그대로 쳤는데 "안 맞습니다"
    // 가 뜬다 — 컴퓨터가 죽은 날 그 화면을 보는 것이 제일 나쁘다.
    let clean: Vec<u8> = s
        .to_lowercase()
        .bytes()
        .map(|c| match c {
            b'o' => b'0',
            b'i' | b'l' => b'1',
            other => other,
        })
        .filter(|c| ALPHABET.contains(c))
        .collect();
    let mut bits = 0u32;
    let mut n = 0;
    let mut out = Vec::with_capacity(32);
    for c in clean {
        let Some(v) = ALPHABET.iter().position(|a| *a == c) else {
            continue;
        };
        bits = (bits << 5) | v as u32;
        n += 5;
        if n >= 8 {
            n -= 8;
            out.push(((bits >> n) & 0xff) as u8);
        }
    }
    if out.len() < 32 {
        return Err("열쇠가 짧습니다. 종이에 적힌 것을 다시 봐 주세요.".into());
    }
    let mut k = [0u8; 32];
    k.copy_from_slice(&out[..32]);
    Ok(k)
}

/// 파일 하나를 잠근다. 원본은 그대로 두고 잠근 파일을 새로 만든다.
///
/// ⚠️ 열쇠를 그대로 쓰지 않고 Argon2id 를 한 번 지난다. 열쇠 파일이 새더라도
/// 곧바로 열리지 않게 하는 값은 아니지만(무작위 32바이트라 어차피 못 맞춘다),
/// **사람이 종이에 적은 값을 잘못 옮겨 적었을 때** 조용히 다른 열쇠가 되는
/// 대신 확실히 실패하게 만든다.
pub fn lock_file(src: &std::path::Path, dst: &std::path::Path, key: &[u8; 32]) -> Result<(), String> {
    use argon2::Argon2;
    use rand::RngCore;

    let plain = std::fs::read(src).map_err(|e| format!("읽지 못했습니다: {e}"))?;

    let mut salt = [0u8; 16];
    let mut nonce_b = [0u8; 12];
    rand::thread_rng().fill_bytes(&mut salt);
    rand::thread_rng().fill_bytes(&mut nonce_b);

    let mut derived = [0u8; 32];
    Argon2::default()
        .hash_password_into(key, &salt, &mut derived)
        .map_err(|e| format!("열쇠를 만들지 못했습니다: {e}"))?;

    let cipher = Aes256Gcm::new_from_slice(&derived).map_err(|e| format!("자물쇠 오류: {e}"))?;
    let sealed = cipher
        .encrypt(Nonce::from_slice(&nonce_b), plain.as_ref())
        .map_err(|_| "잠그지 못했습니다".to_string())?;

    // 머리 + 소금 + 논스 + 잠긴 내용. 한 파일로 둔다 — 옆 파일이 따로 있으면
    // 하나만 옮겨지고 나머지가 남는 일이 생긴다.
    let mut out = Vec::with_capacity(8 + 16 + 12 + sealed.len());
    out.extend_from_slice(MAGIC);
    out.extend_from_slice(&salt);
    out.extend_from_slice(&nonce_b);
    out.extend_from_slice(&sealed);
    std::fs::write(dst, out).map_err(|e| format!("쓰지 못했습니다: {e}"))?;
    Ok(())
}

/// 잠긴 파일을 연다. 종이에 적힌 열쇠로도 열 수 있다.
pub fn unlock_file(
    src: &std::path::Path,
    dst: &std::path::Path,
    key: &[u8; 32],
) -> Result<(), String> {
    use argon2::Argon2;

    let raw = std::fs::read(src).map_err(|e| format!("읽지 못했습니다: {e}"))?;
    if raw.len() < 8 + 16 + 12 || &raw[..8] != MAGIC {
        return Err("이 프로그램이 잠근 파일이 아닙니다.".into());
    }
    let salt = &raw[8..24];
    let nonce_b = &raw[24..36];
    let body = &raw[36..];

    let mut derived = [0u8; 32];
    Argon2::default()
        .hash_password_into(key, salt, &mut derived)
        .map_err(|e| format!("열쇠를 만들지 못했습니다: {e}"))?;

    let cipher = Aes256Gcm::new_from_slice(&derived).map_err(|e| format!("자물쇠 오류: {e}"))?;
    let plain = cipher
        .decrypt(Nonce::from_slice(nonce_b), body)
        .map_err(|_| "열쇠가 맞지 않습니다. 종이에 적힌 것을 다시 봐 주세요.".to_string())?;
    std::fs::write(dst, plain).map_err(|e| format!("쓰지 못했습니다: {e}"))?;
    Ok(())
}

/// 화면에 보여 줄 열쇠. **인쇄해서 12단어와 같이 두라고 말한다.**
#[tauri::command]
pub fn cloud_key_show() -> Result<Value, String> {
    let k = key_get_or_make()?;
    Ok(json!({
        "key": to_paper(&k),
        "where": key_path().to_string_lossy(),
    }))
}

/// 종이에 적힌 열쇠로 잠긴 백업을 연다. 컴퓨터가 죽었을 때 쓰는 길이다.
#[tauri::command]
pub fn cloud_unlock(locked: String, out: String, key: String) -> Result<Value, String> {
    let k = from_paper(&key)?;
    unlock_file(std::path::Path::new(&locked), std::path::Path::new(&out), &k)?;
    Ok(json!({ "ok": true, "path": out }))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 종이에 적었다가 다시 친 값이 같아야 한다. 여기서 한 글자라도 어긋나면
    /// 컴퓨터가 죽은 날 백업이 열리지 않는다.
    #[test]
    fn what_goes_on_paper_comes_back() {
        let k = [7u8; 32];
        let paper = to_paper(&k);
        assert_eq!(from_paper(&paper).unwrap(), k);
    }

    /// 사람은 대문자로 적고, 띄어 쓰고, 줄표를 빼먹는다. 다 받아 줘야 한다.
    #[test]
    fn a_human_can_retype_it_sloppily() {
        let mut k = [0u8; 32];
        for (i, b) in k.iter_mut().enumerate() {
            *b = (i * 7 % 251) as u8;
        }
        let paper = to_paper(&k);
        for messy in [
            paper.to_uppercase(),
            paper.replace('-', " "),
            paper.replace('-', ""),
            format!("  {paper}  "),
        ] {
            assert_eq!(from_paper(&messy).unwrap(), k, "이렇게 적으면 못 읽는다: {messy}");
        }
    }

    /// 🔴 헷갈리는 글자가 섞여 있으면 손으로 옮겨 적을 때 틀린다. 그리고 이건
    /// 한 글자만 틀려도 아무것도 못 여는 값이다.
    #[test]
    fn the_alphabet_has_no_lookalikes() {
        assert_eq!(ALPHABET.len(), 32, "32글자가 아니면 값 하나가 뭉개진다");
        for c in [b'i', b'l', b'o', b'u'] {
            assert!(!ALPHABET.contains(&c), "헷갈리는 글자가 있다: {}", c as char);
        }
        // 그리고 사람이 헷갈려 적은 것을 받아 줘야 한다.
        let k = [9u8; 32];
        let paper = to_paper(&k);
        let swapped = paper.replace('0', "O").replace('1', "l");
        assert_eq!(from_paper(&swapped).unwrap(), k, "O·l 로 적으면 못 읽는다");
    }

    /// 잠그고 여는 것이 실제로 되는지. 그리고 **틀린 열쇠로는 안 열리는지.**
    #[test]
    fn it_locks_and_only_the_right_key_opens_it() {
        let dir = std::env::temp_dir().join("playx-lockbox-test");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let src = dir.join("plain.bin");
        let locked = dir.join("locked.bin");
        let back = dir.join("back.bin");
        let body = b"wallet.dat pretend contents";
        std::fs::write(&src, body).unwrap();

        let good = [1u8; 32];
        let bad = [2u8; 32];
        lock_file(&src, &locked, &good).unwrap();

        // 잠긴 파일 안에 원문이 그대로 보이면 안 된다.
        let raw = std::fs::read(&locked).unwrap();
        assert!(
            !raw.windows(body.len()).any(|w| w == body),
            "잠갔는데 원문이 그대로 보인다"
        );

        assert!(unlock_file(&locked, &back, &bad).is_err(), "틀린 열쇠로 열렸다");
        unlock_file(&locked, &back, &good).unwrap();
        assert_eq!(std::fs::read(&back).unwrap(), body);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 같은 내용을 두 번 잠가도 결과가 달라야 한다. 같으면 "어제와 오늘이
    /// 같은 파일" 이라는 사실이 밖에서 보인다.
    #[test]
    fn locking_twice_does_not_give_the_same_file() {
        let dir = std::env::temp_dir().join("playx-lockbox-test2");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let src = dir.join("p.bin");
        std::fs::write(&src, b"same content").unwrap();
        let k = [3u8; 32];
        lock_file(&src, &dir.join("a.bin"), &k).unwrap();
        lock_file(&src, &dir.join("b.bin"), &k).unwrap();
        assert_ne!(
            std::fs::read(dir.join("a.bin")).unwrap(),
            std::fs::read(dir.join("b.bin")).unwrap()
        );
        let _ = std::fs::remove_dir_all(&dir);
    }
}
