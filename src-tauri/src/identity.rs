//! 신원 — **12단어 하나에서 나오는 한 사람.**
//!
//! ## 무엇을 푸는가
//!
//! 대표님: "12단어로 **모든 것이 복구** 가능해야겠지?"
//!
//! 그동안 이 앱의 「나」는 셋으로 갈라져 있었다.
//!
//! * 돈은 12단어에서 나왔다(BIP44 표준). 어느 지갑에서도 같은 주소가 나온다.
//! * 데스크톱의 이야기 열쇠는 12단어에서 나오긴 했는데 **우리만 아는 방식**
//!   (표식 해시)이었다.
//! * 웹 지갑의 쪽지 열쇠는 **BIP32 경로**(`m/44'/175'/7'/0/0`)에서 나왔다.
//!
//! 그래서 같은 12단어를 넣어도 **데스크톱의 나와 폰의 나가 다른 사람**이었다.
//! 자문 결론이 이것이었다 — "이야기 열쇠와 지갑 열쇠가 다른 것이 가장 위험한
//! 어긋남이다. 향후 APP 이 또 다른 내가 될 위험도 전부 이 갈라짐의 증상이다."
//!
//! 이 파일이 그 갈라짐을 끝낸다. **앞으로 나오는 모든 열쇠는 여기서 나온다.**
//!
//! # 🔴 파생 경로표 — 이것이 계약이다
//!
//! 향후 네이티브 APP·다른 언어의 구현은 **이 표를 그대로 따라야** 같은
//! 사람이 된다. 표가 어긋나면 그 앱은 「또 다른 나」가 되고, 그 순간
//! 12단어로 복구된다는 말이 거짓말이 된다.
//!
//! | 경로 | 무엇 | 누가 이미 쓰고 있나 |
//! |---|---|---|
//! | `m/44'/175'/0'/0/*`   | **돈 · 받는 주소**   | 레이븐코어 · 웹 지갑 (BIP44 표준) |
//! | `m/44'/175'/0'/1/*`   | **돈 · 거스름 주소** | 레이븐코어 · 웹 지갑 |
//! | `m/44'/175'/7'/0/0`   | **사람** — 대화 · 쪽지 · 이름표 | 웹 지갑(`web/wallet.src.ts`) |
//! | `m/44'/175'/7'/1'/0'` | **가게 간판** (v2 · 아직 아무도 안 씀) | — |
//! | `m/44'/175'/7'/2'/0'` | **아티스트 이름** — 체인 자산에 박히는 열쇠 | — |
//!
//! 🔴 아티스트 자리(`2'`)는 **둘째·셋째 예명을 위해 `2'/1'`, `2'/2'` … 를
//! 남겨 둔다.** 늘려도 12단어 하나로 전부 복구된다.
//!
//! 씨앗은 BIP39 표준이다: `PBKDF2-HMAC-SHA512(12단어, "mnemonic"+암호, 2048회, 64바이트)`.
//! 레이븐코어가 쓰는 것과 같은 방식이라 돈 주소가 어느 지갑에서나 맞는다.
//!
//! ## 🔴 경화(hardened)에 대하여 — 어디를 왜 잠갔나
//!
//! `'` 가 붙은 자리가 경화된 자리다. 경화된 자리는 **위로 못 올라간다** —
//! 자식 개인키와 부모 확장공개키를 둘 다 손에 넣어도 부모를 복원할 수 없다.
//!
//! * `7'` (계정)이 경화라서 **이야기 열쇠가 통째로 새도 돈은 안전하다.**
//!   `0'`(돈)과 `7'`(사람)은 형제인데 둘 다 경화라, 한쪽에서 다른 쪽으로
//!   건너갈 길이 없다. 여기가 제일 중요한 자물쇠고, 잠겨 있다.
//! * `7'` 아래 마지막 두 자리(`0/0`)는 **경화가 아니다.** 웹 지갑이 이미
//!   그 자리에 열쇠를 만들어 세상 릴레이에 글을 썼기 때문이다. 여기를
//!   경화로 바꾸면 폰의 나와 데스크톱의 나가 또 갈라진다 — 지금 고치려는
//!   바로 그 병이다. 그래서 **웹에 맞춘다.**
//!   대신 대가를 정확히 적어 둔다: 계정 확장공개키(`m/44'/175'/7'` 의 xpub)와
//!   이야기 개인키가 **둘 다** 새면 그 계정 아래는 전부 털린다. 그래서
//!   이 파일은 **확장공개키도 체인코드도 절대 밖으로 내보내지 않는다.**
//!   나가는 것은 32바이트 개인키(호출한 쪽이 서명에만 쓴다)와 공개키뿐이다.
//! * 가게 간판(`1'/0'`)은 **경화로 정했다.** 간판 열쇠는 직원에게 맡길 수
//!   있는 물건이다. 직원이 쥔 열쇠에서 사장의 쪽지 열쇠로 건너갈 길이
//!   생기면 안 된다. 이 자리는 아직 아무도 안 쓰고 있어서 자유롭게 정할 수
//!   있었고, 그래서 안전한 쪽으로 정했다.
//!
//! ## 🔴 12단어는 여기서만 산다
//!
//! `getmywords` 로 받아서 씨앗을 만들고 나면 끝이다. 파일에도, 로그에도,
//! 화면에도, 오류 메시지에도 안 나간다. 이 파일의 모든 오류 문구는
//! **12단어를 담지 않는다** — 시험이 그것을 지킨다(`no_secret_leaves_this_file`).
//!
//! ## 🔴 왜 남의 crate 를 안 들였나
//!
//! BIP39·BIP32 를 하려면 HMAC-SHA512 와 PBKDF2 가 필요하다. `hmac`·`pbkdf2`
//! crate 를 들일 수도 있었지만, **12단어가 지나가는 자리에 공급망을 하나 더
//! 들이지 않는다**(`awake.rs` 와 같은 판단). 둘 다 짧은 표준 알고리즘이고,
//! 아래 시험이 **BIP39·BIP32 공식 시험값**으로 구현이 맞는지 증명한다.
//! 틀리면 시험이 즉시 잡는다 — 남의 코드를 믿는 것보다 이쪽이 확인이 된다.

use serde_json::{json, Value};
use sha2::{Digest, Sha512};

// ── 경로 — 한 번 정하면 못 바꾼다 ──────────────────────────────────────
//
// 🔴 이 문자열을 바꾸면 그날부터 **다른 사람**이 된다. 여태 쓴 글도, 남이
//    보낸 쪽지도 전부 남의 것이 된다. 그래서 아래 `const _` 가 컴파일
//    시점에 값을 못 박는다 — 고치면 **빌드가 실패한다.**
//    빌드가 실패하는 것이 목적이다. 실수로 못 바꾸게.

/// 사람. 대화·쪽지·이름표에 쓰는 열쇠.
///
/// ⚠️ 웹 지갑(`web/wallet.src.ts` 의 `nostrSecret()`)이 **이미 쓰고 있는 자리**다.
///    우리가 웹에 맞춘 것이지 웹이 우리에게 맞춘 것이 아니다.
pub const PATH_PERSON: &str = "m/44'/175'/7'/0/0";

/// 가게 간판 v2. **아직 아무도 안 쓴다** — `shopkey.rs` 참고.
///
/// 지금 가게들은 v1(표식 해시) 열쇠를 쓰고 그 공개키가 **체인에 박혀 있다.**
/// 여기로 옮기려면 자산 재발행(100 RVN)이 필요하다. 그래서 이 경로는
/// 정해만 두고, 옮기는 것은 사장이 값을 보고 고를 일이다.
pub const PATH_SHOP: &str = "m/44'/175'/7'/1'/0'";

/// 아티스트 이름. **자산에 박아 넣을 공개키가 여기서 나온다.**
///
/// # 🔴 왜 사람 열쇠(`PATH_PERSON`)를 쓰면 안 되는가
///
/// 아티스트 공개키는 체인 자산(`PLAYX`)의 프로필에 **박힌다.** 체인은
/// 되돌릴 수 없고, 고치려면 재발행 100 RVN 이다.
///
/// 그 자리에 사람 열쇠를 박으면 **개인 대화 정체성과 공개 아티스트
/// 정체성이 영구히 묶인다.** 방에서 나눈 잡담, 1:1 로 주고받은 문의,
/// 중고로 판 자전거가 전부 「그 아티스트」와 같은 열쇠가 된다. 팔로우한
/// 사람 누구나 그 연결을 본다. 한 번 박으면 못 푼다.
///
/// 바로 위 `PATH_SHOP` 의 설명이 같은 사고를 이미 기록해 두었다 — 가게
/// v1 열쇠가 체인에 박혀서, 옮기려면 100 RVN 을 내야 하는 상태다.
/// **같은 실수를 두 번 하지 않는다.**
///
/// # 왜 가게(`PATH_SHOP`)와도 나누는가
///
/// 대표님: "가게 하면서 아티스트일수도 있지 않나? 따로 등록하고 싶을수도
/// 있고 혹은 자기 프로필은 있고 장사는 따로 일수도 있고 말야."
/// 셋은 **다른 자리**다. 한 사람이 셋을 다 가질 수 있고, 서로 연결되지
/// 않아야 한다.
///
/// # 왜 경화(`'`)인가
///
/// `PATH_PERSON` 의 마지막 두 자리가 경화가 아닌 것은 **웹 지갑이 이미
/// 그 자리에 글을 써 버려서** 맞춘 것이지 고른 것이 아니다(위 경로표
/// 참고). 아티스트 경로는 아직 아무도 안 쓴다. 제약이 없으니 **안전한
/// 쪽**을 고른다 — `PATH_SHOP` 과 같다.
///
/// # 마지막 자리가 `0'` 인 이유
///
/// 한 사람이 예명을 여럿 쓸 수 있다. `2'/1'`, `2'/2'` … 를 **둘째·셋째
/// 이름으로 남겨 둔다.** 지금 쓰는 것은 첫째뿐이다. 나중에 늘려도 12단어
/// 하나로 전부 복구된다 — 그것이 이 표의 계약이다.
pub const PATH_ARTIST: &str = "m/44'/175'/7'/2'/0'";

/// 돈. **여기서 파생하지 않는다** — 표에 적어 두는 것이 전부다.
/// 돈 주소는 레이븐코어가 만들고 우리는 손대지 않는다.
pub const PATH_MONEY: &str = "m/44'/175'/0'/0/*";

/// 컴파일 시점 문자열 비교. `==` 는 const 문맥에서 못 쓴다.
const fn same(a: &str, b: &str) -> bool {
    let (a, b) = (a.as_bytes(), b.as_bytes());
    if a.len() != b.len() {
        return false;
    }
    let mut i = 0;
    while i < a.len() {
        if a[i] != b[i] {
            return false;
        }
        i += 1;
    }
    true
}

// 🔴 경로를 고치면 **여기서 빌드가 멈춘다.** 이 줄을 같이 고치는 사람은
//    자기가 무엇을 하는지 아는 사람이어야 한다 — 옛 이름으로 쓴 글이
//    전부 고아가 되고, 되돌릴 길이 없다.
const _: () = assert!(
    same(PATH_PERSON, "m/44'/175'/7'/0/0"),
    "사람 열쇠 경로는 웹 지갑과 같아야 한다. 바꾸면 폰의 나와 데스크톱의 나가 갈라진다."
);
const _: () = assert!(
    same(PATH_SHOP, "m/44'/175'/7'/1'/0'"),
    "가게 간판 경로를 바꾸면 이미 옮긴 가게가 죽는다."
);
const _: () = assert!(
    same(PATH_ARTIST, "m/44'/175'/7'/2'/0'"),
    "아티스트 경로를 바꾸면 체인 자산에 박은 공개키가 고아가 된다. 되돌리려면 재발행(100 RVN)이다."
);
// 🔴 세 자리가 서로 겹치면 「따로」가 아니게 된다. 문자열이 다른지 여기서 막는다.
const _: () = assert!(
    !same(PATH_ARTIST, PATH_PERSON) && !same(PATH_ARTIST, PATH_SHOP),
    "아티스트·사람·가게는 서로 다른 자리여야 한다. 같으면 정체성이 묶인다."
);
const _: () = assert!(
    same(PATH_MONEY, "m/44'/175'/0'/0/*"),
    "돈 경로는 BIP44 표준이다. 우리가 정하는 값이 아니다."
);

// ── HMAC-SHA512 ────────────────────────────────────────────────────────
//
// RFC 2104. 블록 128바이트. 시험이 RFC 4231 값으로 확인한다.

fn hmac_sha512(key: &[u8], parts: &[&[u8]]) -> [u8; 64] {
    let mut k = [0u8; 128];
    if key.len() > 128 {
        let d = Sha512::digest(key);
        k[..64].copy_from_slice(&d);
    } else {
        k[..key.len()].copy_from_slice(key);
    }
    let mut ipad = [0x36u8; 128];
    let mut opad = [0x5cu8; 128];
    for i in 0..128 {
        ipad[i] ^= k[i];
        opad[i] ^= k[i];
    }
    let mut inner = Sha512::new();
    inner.update(ipad);
    for p in parts {
        inner.update(p);
    }
    let ih = inner.finalize();
    let mut outer = Sha512::new();
    outer.update(opad);
    outer.update(ih);
    let mut out = [0u8; 64];
    out.copy_from_slice(&outer.finalize());
    out
}

// ── BIP39: 12단어 → 씨앗 64바이트 ──────────────────────────────────────

/// 12단어에서 씨앗을 만든다. **BIP39 표준 그대로.**
///
/// * 소금은 `"mnemonic" + 암호`. 암호가 없으면 `"mnemonic"` 뿐이다.
/// * 2048번 돌리고 64바이트를 뽑는다. 뽑는 길이가 해시 길이와 같아서
///   블록이 하나뿐이다 — 그래서 PBKDF2 의 바깥 반복이 필요 없다.
///
/// ⚠️ **정규화.** 12단어는 소문자·한 칸 띄어쓰기가 표준인데 사람이 옮겨
///    적으면 대문자나 두 칸이 섞인다. 그러면 다른 씨앗이 나와서 복구가
///    조용히 실패한다 — 그게 제일 나쁜 실패다. 그래서 여기서 맞춘다.
///    (BIP39 는 NFKD 정규화도 요구하지만 영어 12단어는 전부 ASCII 라
///    NFKD 가 아무것도 바꾸지 않는다. 암호에 한글 같은 것이 들어가면
///    다를 수 있는데, 그 경우는 애초에 레이븐코어와 웹 지갑도 서로 안
///    맞으므로 여기서 만들어 낼 수 있는 답이 아니다.)
pub fn seed_from_words(words: &str, passphrase: &str) -> Option<[u8; 64]> {
    let norm = words
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase();
    if norm.split(' ').count() < 12 {
        return None;
    }
    let mut salt = Vec::with_capacity(8 + passphrase.len() + 4);
    salt.extend_from_slice(b"mnemonic");
    salt.extend_from_slice(passphrase.as_bytes());
    salt.extend_from_slice(&1u32.to_be_bytes()); // 블록 번호 1

    let mut u = hmac_sha512(norm.as_bytes(), &[&salt[..]]);
    let mut out = u;
    for _ in 1..2048 {
        u = hmac_sha512(norm.as_bytes(), &[&u[..]]);
        for i in 0..64 {
            out[i] ^= u[i];
        }
    }
    Some(out)
}

// ── BIP32: 씨앗 → 경로의 열쇠 ──────────────────────────────────────────

/// 경화된 자리의 시작. 이 값 이상이면 경화다.
const HARDENED: u32 = 0x8000_0000;

/// 경로 문자열을 자리 번호로 푼다. `m/44'/175'/7'/0/0` → `[44', 175', 7', 0, 0]`.
///
/// 못 읽는 경로면 `None`. **틀린 경로로 조용히 다른 열쇠를 만들지 않는다.**
fn parse_path(path: &str) -> Option<Vec<u32>> {
    let mut it = path.split('/');
    if it.next()? != "m" {
        return None;
    }
    let mut out = Vec::new();
    for part in it {
        let (num, hard) = match part.strip_suffix('\'').or_else(|| part.strip_suffix('h')) {
            Some(n) => (n, true),
            None => (part, false),
        };
        let n: u32 = num.parse().ok()?;
        if n >= HARDENED {
            return None;
        }
        out.push(if hard { n + HARDENED } else { n });
    }
    if out.is_empty() {
        return None;
    }
    Some(out)
}

/// 씨앗에서 경로를 따라 내려가 개인키를 얻는다.
///
/// ⚠️ **체인코드는 돌려주지 않는다.** 확장공개키를 만들 재료가 밖으로 나가면
///    경화 안 된 형제 열쇠를 유도당한다(위 경로표의 경고). 여기서 태우고
///    32바이트 개인키만 내보낸다.
pub fn derive(seed: &[u8; 64], path: &str) -> Option<[u8; 32]> {
    let steps = parse_path(path)?;

    // 뿌리: I = HMAC-SHA512("Bitcoin seed", 씨앗). 앞 32바이트가 열쇠,
    // 뒤 32바이트가 체인코드다.
    let i = hmac_sha512(b"Bitcoin seed", &[&seed[..]]);
    let mut k = [0u8; 32];
    k.copy_from_slice(&i[..32]);
    let mut c = [0u8; 32];
    c.copy_from_slice(&i[32..]);

    let secp = secp256k1::Secp256k1::new();
    let mut sk = secp256k1::SecretKey::from_byte_array(&k).ok()?;

    for step in steps {
        let data: Vec<u8> = if step >= HARDENED {
            // 경화: 부모 **개인키**를 넣는다. 그래서 확장공개키만으로는
            // 이 자식을 못 만든다 — 그것이 경화의 전부다.
            let mut v = Vec::with_capacity(37);
            v.push(0u8);
            v.extend_from_slice(&sk.secret_bytes());
            v.extend_from_slice(&step.to_be_bytes());
            v
        } else {
            let mut v = Vec::with_capacity(37);
            v.extend_from_slice(&secp256k1::PublicKey::from_secret_key(&secp, &sk).serialize());
            v.extend_from_slice(&step.to_be_bytes());
            v
        };
        let i = hmac_sha512(&c, &[&data[..]]);
        let mut tweak = [0u8; 32];
        tweak.copy_from_slice(&i[..32]);
        // 앞 32바이트가 곡선 차수보다 크거나 더한 값이 0 이면 그 자리는
        // 건너뛰라는 것이 BIP32 다. 확률이 2^-127 이라 실제로는 안 일어난다.
        // 일어나면 **틀린 열쇠를 만드는 대신 실패한다.**
        let scalar = secp256k1::Scalar::from_be_bytes(tweak).ok()?;
        sk = sk.add_tweak(&scalar).ok()?;
        c.copy_from_slice(&i[32..]);
    }
    Some(sk.secret_bytes())
}

// ── 노드에서 12단어를 받아 오는 길 ─────────────────────────────────────

/// 노드에 12단어를 물어본다. 잠겨 있거나 12단어로 만든 지갑이 아니면 `None`.
///
/// ⚠️ 돌려주는 값은 **호출한 쪽에서 씨앗으로 바꾸고 바로 버려야 한다.**
///    이 파일 밖으로 나가는 유일한 곳이 아래 두 함수뿐이고, 둘 다 씨앗으로
///    바꾼 뒤 즉시 버린다.
fn words_from_node() -> Option<(String, String)> {
    let v = tauri::async_runtime::block_on(async {
        crate::raven::call_rpc("getmywords", json!([])).await
    })
    .ok()?;
    split_words(&v)
}

/// 같은 일을 **async 로** 한다.
///
/// 🔴 왜 둘로 나뉘어 있나. `tauri::async_runtime::block_on` 은 이미 async
///    런타임 위에서 부르면 **터진다**("Cannot start a runtime from within a
///    runtime"). 아래 `#[tauri::command] pub async fn` 들은 전부 그 런타임
///    위에서 돈다. 그래서 async 인 자리에서는 이쪽을 쓴다.
///
///    위 sync 판은 `talk::key()` 가 sync 라서 남는다 — 거기 길은 예전부터
///    그랬고, 이 공사에서 바꾸는 것이 아니다.
async fn words_async() -> Option<(String, String)> {
    let v = crate::raven::call_rpc("getmywords", json!([])).await.ok()?;
    split_words(&v)
}

fn split_words(v: &Value) -> Option<(String, String)> {
    let words = v.get("word_list").and_then(Value::as_str)?.to_string();
    let pass = v
        .get("passphrase")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    Some((words, pass))
}

/// 12단어에서 **사람 열쇠**를 뽑는다. 웹 지갑과 같은 값이 나온다.
pub fn person_key_from(words: &str, passphrase: &str) -> Option<[u8; 32]> {
    derive(&seed_from_words(words, passphrase)?, PATH_PERSON)
}

/// 12단어에서 **가게 간판 v2 열쇠**를 뽑는다.
#[allow(dead_code)]
pub fn shop_key_from(words: &str, passphrase: &str) -> Option<[u8; 32]> {
    derive(&seed_from_words(words, passphrase)?, PATH_SHOP)
}

/// 12단어에서 **아티스트 열쇠**를 뽑는다. 체인 자산에 박을 공개키가 이것이다.
#[allow(dead_code)]
pub fn artist_key_from(words: &str, passphrase: &str) -> Option<[u8; 32]> {
    derive(&seed_from_words(words, passphrase)?, PATH_ARTIST)
}

/// 이 노드의 아티스트 열쇠. 12단어를 못 읽으면 `None`.
#[allow(dead_code)]
pub fn artist_key() -> Option<[u8; 32]> {
    let (words, pass) = words_from_node()?;
    artist_key_from(&words, &pass)
}

/// 이 노드의 사람 열쇠. 12단어를 못 읽으면 `None`.
pub fn person_key() -> Option<[u8; 32]> {
    let (words, pass) = words_from_node()?;
    person_key_from(&words, &pass)
}

/// 12단어를 **한 번만** 물어보고 두 열쇠를 같이 뽑는다.
///
/// 표준 경로의 「사람」과 옛 방식의 「옛 이름」. 상태 화면은 둘 다 필요한데
/// 따로 물어보면 노드에 RPC 가 두 번 간다.
///
/// ⚠️ 12단어는 이 함수 안에서만 살고 나갈 때는 열쇠 두 개뿐이다.
async fn both_keys_async() -> Option<([u8; 32], Option<[u8; 32]>)> {
    let (words, pass) = words_async().await?;
    let person = person_key_from(&words, &pass)?;
    let legacy = crate::shopkey::derive_tagged(crate::shopkey::SEED_TAG_TALK, &words, &pass);
    Some((person, legacy))
}

/// 화면에 보여 줄 경로표. **사람이 읽고 확인할 수 있어야** 계약이다.
#[tauri::command]
pub fn identity_paths() -> Value {
    json!({
        "seed": "BIP39 표준 (PBKDF2-HMAC-SHA512, 2048회)",
        "rows": [
            { "path": PATH_MONEY, "what": "돈 · 받는 주소",
              "who": "레이븐코어 · 웹 지갑 (BIP44 표준)",
              "note": "우리가 정하는 값이 아닙니다. 손대지 않습니다." },
            { "path": PATH_PERSON, "what": "사람 — 대화 · 쪽지 · 이름표",
              "who": "웹 지갑이 이미 쓰던 자리 · 이제 이 앱도 같은 자리",
              "note": "12단어만 있으면 어느 기계에서도 같은 이름이 나옵니다." },
            { "path": PATH_ARTIST, "what": "아티스트 이름 — 자산에 박히는 열쇠",
              "who": "아직 아무도 안 씀",
              "note": "이 공개키가 체인 자산에 박힙니다. 대화용 사람 열쇠와 일부러 나눴습니다 — 같이 쓰면 개인 대화와 아티스트 이름이 영원히 묶입니다." },
            { "path": PATH_SHOP, "what": "가게 간판 (v2)",
              "who": "아직 아무도 안 씀",
              "note": "지금 가게는 옛 방식 열쇠를 쓰고 그 공개키가 체인에 박혀 있습니다. 옮기려면 재발행(100 RVN)이 필요합니다." },
            { "path": "SHA256(\"PLAYX-RAVEN-TALKKEY-v1\" · 12단어)", "what": "옛 대화 열쇠",
              "who": "0.1.32 ~ 이 판 이전에 만든 이름",
              "note": "지우지 않습니다. 이 이름으로 쓴 글이 세계 릴레이에 남아 있습니다." },
            { "path": "SHA256(\"PLAYX-RAVEN-SHOPKEY-v1\" · 12단어)", "what": "가게 간판 (v1 · 지금 쓰는 것)",
              "who": "지금 모든 가게",
              "note": "12단어에서 나오므로 복구는 됩니다. 표준 경로가 아닐 뿐입니다." },
        ],
        "hardening": "계정 자리(7')가 경화라 대화 열쇠가 새도 돈은 안전합니다. 마지막 두 자리는 웹 지갑에 맞추느라 경화가 아닙니다 — 그래서 확장공개키를 어디에도 내보내지 않습니다.",
    })
}

// ── 갈라진 이름을 잇는다 ───────────────────────────────────────────────
//
// ## 🔴 Nostr 에 「열쇠를 옮겼습니다」 표준이 있는가 — 없다
//
// 찾아봤고, 결론은 **없다**. 만들어 낼 수 없어서 그대로 적는다.
//
// * **NIP-26**(위임 서명)은 nips 저장소에서 `unrecommended` 로 표시됐다 —
//   "얻는 것에 비해 짐이 크다". 쓰는 클라이언트가 사실상 없다.
// * **NIP-41**(열쇠 이전)은 본선에 들어온 적이 없고 가지(`pf7z-nip41`)에만
//   있다. 게다가 그 초안은 **털리기 전에 미리** `kind:1776` 백지수표를
//   올려 뒀어야 하고, OpenTimestamps 증명(`kind:1040`)까지 필요하다.
//   우리는 미리 올려 둔 것이 없다. 지금 와서는 쓸 수 없는 길이다.
// * **NIP-06**(12단어에서 열쇠 뽑기)은 있지만 "nsec 하나를 권장" 이라
//   되어 있고, 경로도 `m/44'/1237'/…` 라 레이븐과 다르다.
//
// 그래서 **표준이 아니라 사람이 읽는 방식**으로 잇는다. 표준인 척하지
// 않는다 — 다음 사람이 이 주석을 읽고 다시 조사하지 않아도 되게.
//
// 잇는 방법은 셋이고, 셋 다 세상 어느 Nostr 앱에서나 그냥 보인다.
//
// ① **옛 열쇠가** "나 여기로 옮겼다" 를 서명해 올린다. 옛 열쇠만이 할 수
//    있는 말이고, 그래서 이것이 증거다.
// ② **새 열쇠가** "나 예전에 저기였다" 를 서명해 올린다. 한쪽만 있으면
//    아무나 남의 이름을 자기 것이라 주장할 수 있다. 양쪽이 서명해야
//    맞물린다.
// ③ 옛 이름표(kind 0)를 **새 열쇠로 다시 올린다.** 이게 없으면 새 열쇠는
//    어느 앱에서나 16진수 64자로 보인다 — 이름이 안 따라오면 옮긴 것이
//    아니라 사라진 것이다.
//
// 둘 다 `t: ravencoin` 표를 단다. 안 달면 **우리 릴레이가 이 글을 안
// 남긴다**(`relay.rs` 의 저장 규칙). 이은 자국이 우리 릴레이에서 사라지면
// 이은 적이 없는 것과 같다.

fn now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// 이 이름표로 릴레이에 쓴 글이 있는가. 못 물어보면 `None`.
///
/// ⚠️ `false` 와 `None` 은 **다른 말**이다. 「글이 없다」와 「물어보지 못했다」를
///    뭉뚱그리면, 릴레이가 잠깐 죽은 날 남의 이름을 버려도 된다고 말하게 된다.
async fn has_history(pubkey: &str) -> Option<bool> {
    let got = crate::nostrpub::nostr_query_authors(
        vec![
            crate::talk::TALK_KIND_PROFILE,
            crate::talk::TALK_KIND_NOTE,
            crate::talk::TALK_KIND_ROOM_MSG,
        ],
        vec![pubkey.to_string()],
        5,
    )
    .await
    .ok()?;
    Some(!got.is_empty())
}

/// **지금 내 이름이 폰과 같은 사람인가.** 정직하게 답한다.
///
/// 🔴 이 화면이 이 공사의 핵심이다. 조용히 이름이 바뀌는 것이 제일 나쁘고,
///    그 다음으로 나쁜 것이 **갈라진 줄 모르는 것**이다.
///
/// ⚠️ 여기서 열쇠를 **만들지 않는다.** 상태를 물었을 뿐인데 사람이 하나
///    태어나면 안 된다.
#[tauri::command]
pub async fn identity_status() -> Value {
    let disk = crate::talk::key_on_disk();
    let now_pk = disk
        .as_ref()
        .and_then(|(sk, _, _)| crate::shopkey::pubkey_of(sk).ok());
    let now_path = disk.as_ref().map(|(_, _, p)| p.clone()).unwrap_or_default();
    let now_from = disk
        .as_ref()
        .map(|(_, f, _)| f.clone())
        .unwrap_or_else(|| "none".into());

    let both = both_keys_async().await;
    let canonical = both
        .as_ref()
        .and_then(|(p, _)| crate::shopkey::pubkey_of(p).ok());
    let legacy = both
        .as_ref()
        .and_then(|(_, l)| l.as_ref())
        .and_then(|k| crate::shopkey::pubkey_of(k).ok());

    let same = match (&now_pk, &canonical) {
        (Some(a), Some(b)) => Some(a == b),
        _ => None,
    };

    // 옛 이름에 남은 글이 있는지는 **옛 이름이 지금 이름이 아닐 때만** 묻는다.
    // 이미 그 이름을 쓰고 있으면 물어볼 것이 없다.
    let legacy_history = match (&legacy, &now_pk) {
        (Some(l), Some(n)) if l != n => has_history(l).await,
        _ => None,
    };

    let advice = if canonical.is_none() {
        "12단어를 읽지 못했습니다. 지갑이 잠겨 있으면 열어 주세요. 12단어로 만든 지갑이 아니면 이 이름은 백업 파일이 유일한 사본입니다."
    } else if now_pk.is_none() {
        "아직 이야기 이름이 없습니다. 처음 글을 쓸 때 12단어에서 만들어지고, 그때부터 폰·웹 지갑과 같은 사람이 됩니다."
    } else if same == Some(true) {
        "이 컴퓨터의 이름과 폰·웹 지갑의 이름이 같습니다. 12단어만 있으면 어디서나 이 사람으로 돌아옵니다."
    } else if now_from != "seed" {
        "이 이름은 무작위로 만들어져서 12단어로는 되살릴 수 없습니다. 옮기면 12단어로 되살아나지만, 옛 이름으로 쓴 글은 옛 이름에 남습니다 — 옮길 때 「이 글도 나다」를 양쪽 열쇠로 서명해 남깁니다."
    } else {
        "이 컴퓨터의 이름이 폰·웹 지갑과 다릅니다. 옛 방식으로 뽑은 이름이기 때문입니다. 옮기면 하나가 되고, 옛 이름과 새 이름을 잇는 글을 양쪽 열쇠로 서명해 남깁니다. 옛 열쇠 파일은 지우지 않습니다."
    };

    json!({
        "now": { "pubkey": now_pk, "path": now_path, "from": now_from },
        "canonical": { "pubkey": canonical, "path": PATH_PERSON },
        "legacy": { "pubkey": legacy, "path": "SHA256(\"PLAYX-RAVEN-TALKKEY-v1\" · 12단어)",
                    "has_history": legacy_history,
                    "history_why": match legacy_history {
                        Some(true) => "옛 이름으로 쓴 글이 릴레이에 있습니다.",
                        Some(false) => "옛 이름으로 쓴 글을 릴레이에서 못 찾았습니다.",
                        None => "릴레이에 물어보지 못했습니다 — 있는지 없는지 모릅니다.",
                    } },
        "same_as_wallet": same,
        "advice": advice,
        "shop": crate::shopkey::shopkey_origin(),
        "shop_note": "가게 간판 열쇠는 옮기지 않습니다. 그 공개키가 체인에 박혀 있어서, 바꾸려면 자산 재발행(100 RVN)이 필요합니다. 지금 열쇠도 12단어에서 나오므로 복구는 됩니다.",
    })
}

/// 「이 글도 나다」를 **양쪽 열쇠로 서명해** 릴레이에 남긴다.
///
/// 옛 열쇠가 없으면(파일이 아예 없던 경우) 새 열쇠 쪽 글만 올린다 —
/// 이을 상대가 없으면 이을 것도 없다.
async fn publish_link(old: Option<&[u8; 32]>, new: &[u8; 32]) -> Vec<Value> {
    let mut out = Vec::new();
    let new_pk = match crate::shopkey::pubkey_of(new) {
        Ok(v) => v,
        Err(_) => return out,
    };
    let t = json!(["t", crate::talk::TALK_TAG]);

    if let Some(old) = old {
        if let Ok(old_pk) = crate::shopkey::pubkey_of(old) {
            // ① 옛 열쇠가 말한다. **옛 열쇠만 할 수 있는 말이라 이게 증거다.**
            let ev = crate::shopkey::sign_with(
                old,
                crate::talk::TALK_KIND_NOTE,
                json!([["p", new_pk], t, ["alt", "nostr key migration announcement"]]),
                &format!("이 이름은 {new_pk} 로 옮겼습니다. 같은 사람입니다."),
                now(),
            );
            if let Ok(ev) = ev {
                if crate::nostrpub::nostr_publish(ev.clone()).await.is_ok() {
                    out.push(ev);
                }
            }
            // ② 새 열쇠가 되받는다. 한쪽만 있으면 아무나 남의 이름을
            //    자기 것이라 주장할 수 있다.
            let ev = crate::shopkey::sign_with(
                new,
                crate::talk::TALK_KIND_NOTE,
                json!([["p", old_pk], t, ["alt", "nostr key migration announcement"]]),
                &format!("이 이름은 예전에 {old_pk} 였습니다. 같은 사람입니다."),
                now(),
            );
            if let Ok(ev) = ev {
                if crate::nostrpub::nostr_publish(ev.clone()).await.is_ok() {
                    out.push(ev);
                }
            }
            // ③ 옛 이름표를 새 열쇠로 다시 올린다. 이름이 안 따라오면
            //    옮긴 것이 아니라 사라진 것이다.
            if let Ok(got) = crate::nostrpub::nostr_query_authors(
                vec![crate::talk::TALK_KIND_PROFILE],
                vec![old_pk.clone()],
                5,
            )
            .await
            {
                if let Some(content) = got
                    .iter()
                    .filter_map(|e| e.get("content").and_then(Value::as_str))
                    .find(|c| !c.trim().is_empty())
                {
                    // 이름표에는 표(`t`)를 안 붙인다 — 붙이면 이야기 목록에
                    // 이름표가 섞여 나온다(`talk_profile_set` 과 같은 이유).
                    if let Ok(ev) = crate::shopkey::sign_with(
                        new,
                        crate::talk::TALK_KIND_PROFILE,
                        json!([]),
                        content,
                        now(),
                    ) {
                        if crate::nostrpub::nostr_publish(ev.clone()).await.is_ok() {
                            out.push(ev);
                        }
                    }
                }
            }
        }
    }
    out
}

/// **이름을 하나로 합친다.** 사장이 눌러야 일어난다.
///
/// # 🔴 순서
///
/// 잇는 글을 **먼저 올리고**, 그 다음에 파일을 바꾼다. 파일을 먼저 바꾸면
/// 옛 열쇠로 서명할 기회가 사라진다 — 그러면 「이 글도 나다」를 영영 못
/// 남기고, 옛 이름은 주인 없는 글 더미가 된다.
///
/// 옛 열쇠 파일은 **지우지 않는다.** `talkkey-old-<시각>.json` 으로 옆에
/// 남는다(`talk::install_key`).
#[tauri::command]
pub async fn identity_adopt_person_key() -> Result<Value, String> {
    let (new, _) = both_keys_async().await.ok_or(
        "12단어를 읽지 못했습니다. 지갑이 잠겨 있으면 열어 주시고, 12단어로 만든 지갑이 아니면 이 길은 쓸 수 없습니다.",
    )?;
    let new_pk = crate::shopkey::pubkey_of(&new)?;

    let disk = crate::talk::key_on_disk();
    if let Some((sk, _, _)) = &disk {
        if crate::shopkey::pubkey_of(sk)? == new_pk {
            return Err("이미 폰·웹 지갑과 같은 이름을 쓰고 있습니다. 바꿀 것이 없습니다.".into());
        }
    }

    let old = disk.as_ref().map(|(sk, _, _)| *sk);
    let linked = publish_link(old.as_ref(), &new).await;

    // 이을 상대가 있었는데 하나도 못 올렸으면 **멈춘다.** 잇지도 못한 채
    // 이름만 바꾸면, 옛 이름으로 쓴 글이 그냥 고아가 된다.
    if old.is_some() && linked.is_empty() {
        return Err(
            "옛 이름과 새 이름을 잇는 글을 릴레이에 올리지 못했습니다. 그래서 **아무것도 바꾸지 않았습니다.** \
             인터넷이 연결됐는지 보고 다시 눌러 주세요."
                .into(),
        );
    }

    let pk = crate::talk::install_key(&new, "seed", PATH_PERSON)?;
    Ok(json!({
        "pubkey": pk,
        "path": PATH_PERSON,
        "old_pubkey": old.and_then(|k| crate::shopkey::pubkey_of(&k).ok()),
        "linked": linked.len(),
        "kept": "옛 열쇠는 talkkey-old-<시각>.json 으로 옆에 남겼습니다. 지우지 않았습니다.",
        "note": "이제 이 컴퓨터와 폰·웹 지갑이 같은 사람입니다. 옛 이름으로 쓴 글은 옛 이름에 그대로 남아 있고, 두 이름을 잇는 글을 양쪽 열쇠로 서명해 릴레이에 남겼습니다.",
    }))
}

/// **옛 이름을 되찾는다.** `talkkey.json` 을 잃고 12단어로만 돌아온 사람용.
///
/// 표준 경로로 뽑은 열쇠는 그 사람이 아니다. 옛 이름으로 쓴 글이 릴레이에
/// 남아 있으면 이 길로 돌아간다.
#[tauri::command]
pub async fn identity_restore_legacy_key() -> Result<Value, String> {
    let old = both_keys_async()
        .await
        .and_then(|(_, l)| l)
        .ok_or(
        "12단어를 읽지 못했습니다. 지갑이 잠겨 있으면 열어 주시고, 12단어로 만든 지갑이 아니면 이 길은 쓸 수 없습니다.",
    )?;
    let old_pk = crate::shopkey::pubkey_of(&old)?;

    if let Some((sk, _, _)) = crate::talk::key_on_disk() {
        if crate::shopkey::pubkey_of(&sk)? == old_pk {
            return Err("이미 옛 이름을 쓰고 있습니다. 바꿀 것이 없습니다.".into());
        }
    }

    let pk = crate::talk::install_key(&old, "seed", "legacy-talkkey-v1")?;
    Ok(json!({
        "pubkey": pk,
        "path": "SHA256(\"PLAYX-RAVEN-TALKKEY-v1\" · 12단어)",
        "kept": "직전 열쇠는 talkkey-old-<시각>.json 으로 옆에 남겼습니다. 지우지 않았습니다.",
        "note": "옛 이름으로 돌아왔습니다. 폰·웹 지갑에서는 다른 이름으로 보입니다 — 하나로 합치려면 「이름 합치기」를 눌러 주세요.",
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hx(s: &str) -> Vec<u8> {
        hex::decode(s).unwrap()
    }

    /// RFC 4231 시험값 2 — HMAC-SHA512 가 맞는지.
    ///
    /// 이게 틀리면 아래 전부가 틀린다. 제일 먼저 확인한다.
    #[test]
    fn hmac_matches_rfc_4231() {
        let got = hmac_sha512(b"Jefe", &[&b"what do ya want for nothing?"[..]]);
        assert_eq!(
            hex::encode(got),
            "164b7a7bfcf819e2e395fbe73b56e0a387bd64222e831fd610270cd7ea250554\
             9758bf75c05a994a6d034f65f8f0e6fdcaeab1a34d4a6b4b636e070a38bce737"
        );
    }

    /// 열쇠가 블록(128바이트)보다 길 때 — RFC 4231 시험값 6.
    ///
    /// 🔴 **이 길은 실제로 쓰인다.** BIP39 는 12단어 자체를 HMAC 의 열쇠로
    ///    넣는데, 24단어짜리 지갑은 그 문자열이 187바이트라 128을 넘는다.
    ///    여기가 틀리면 24단어 지갑만 조용히 복구에 실패한다 — 12단어로
    ///    시험하면 안 잡히는 자리다.
    #[test]
    fn hmac_handles_a_long_key() {
        let key = vec![0xaau8; 131];
        let got = hmac_sha512(&key, &[&b"Test Using Larger Than Block-Size Key - Hash Key First"[..]]);
        assert_eq!(
            hex::encode(got),
            "80b24263c7c1a3ebb71493c1dd7be8b49b46d1f41b4aeec1121b013783f8f352\
             6b56d037e05f2598bd0fd2215d6a1e5295e64f73f63f0aec8b915a985d786598"
        );
    }

    /// 24단어 지갑도 맞는지 — 끝에서 끝까지.
    ///
    /// 기댓값은 우리가 계산한 것이 아니라 `bip39` 라이브러리를 돌려 받은
    /// 값이다. 187바이트 열쇠라 위의 긴-열쇠 길을 지나간다.
    #[test]
    fn bip39_handles_twenty_four_words() {
        let m = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon \
                 abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon \
                 abandon abandon abandon art";
        let seed = seed_from_words(m, "TREZOR").unwrap();
        assert_eq!(
            hex::encode(seed),
            "bda85446c68413707090a52022edd26a1c9462295029f2e60cd7c4f2bbd30971\
             70af7a4d73245cafa9c3cca8d561a7c3de6f5d4a10be8ed2a5e608d68f92fcc8"
        );
    }

    /// BIP39 공식 시험값(Trezor). 12단어 + 암호 "TREZOR" → 씨앗.
    ///
    /// 🔴 이게 맞아야 **레이븐코어가 만든 돈 주소와 우리 계산이 같은 씨앗**
    ///    에서 나온다. 틀리면 「12단어로 복구됩니다」가 거짓말이 된다.
    #[test]
    fn bip39_matches_the_official_vector() {
        let m = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
        let seed = seed_from_words(m, "TREZOR").unwrap();
        assert_eq!(
            hex::encode(seed),
            "c55257c360c07c72029aebc1b53c05ed0362ada38ead3e3e9efa3708e53495531f09a6987599d18264c1e1c92f2cf141630c7a3c4ab7c81b2f001698e7463b04"
        );
    }

    /// 암호가 **없을 때**도 공식값과 맞는지.
    ///
    /// 🔴 이 경우가 실제로 제일 중요하다. 웹 지갑은 BIP39 암호를 아예 안
    ///    받는다(`getHDKey` → `mnemonicToSeedSync(mnemonic)`). 그러니 폰과
    ///    데스크톱이 같은 사람이 되는 것은 **암호가 빈 지갑일 때**다.
    #[test]
    fn bip39_with_no_passphrase_matches() {
        let seed = seed_from_words(
            "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
            "",
        )
        .unwrap();
        assert_eq!(
            hex::encode(seed),
            "5eb00bbddcf069084889a8ab9155568165f5c453ccb85e70811aaed6f6da5fc19a5ac40b389cd370d086206dec8aa6c43daea6690f20ad3d8d48b2d2ce9e38e4"
        );
    }

    /// BIP32 공식 시험값 1 — 뿌리와 경화·비경화가 섞인 경로.
    ///
    /// `m/0'/1/2'/2/1000000000` 은 경화와 비경화를 둘 다 지나간다. 우리
    /// 경로(`m/44'/175'/7'/0/0`)와 같은 모양이라 이걸로 충분하다.
    #[test]
    fn bip32_matches_the_official_vector_one() {
        // ⚠️ 시험값의 씨앗은 16바이트다. 실제 코드의 씨앗은 언제나
        //    64바이트라, 길이를 안 따지는 시험용 길로 돌린다.
        let s = hx("000102030405060708090a0b0c0d0e0f");
        let i = hmac_sha512(b"Bitcoin seed", &[&s[..]]);
        assert_eq!(
            hex::encode(&i[..32]),
            "e8f32e723decf4051aefac8e2c93c9c5b214313817cdb01a1494b917c8436b35"
        );
        assert_eq!(
            hex::encode(&i[32..]),
            "873dff81c02f525623fd1fe5167eac3a55a049de3d314bb42ee227ffed37d508"
        );

        let got = derive_from_raw_seed(&s, "m/0'/1/2'/2/1000000000").unwrap();
        assert_eq!(
            hex::encode(got),
            "471b76e389e528d6de6d816857e012c5455051cad6660850e58372a6c3e6e7c8"
        );
    }

    /// BIP32 공식 시험값 2 — 큰 자리 번호가 섞인 경로.
    #[test]
    fn bip32_matches_the_official_vector_two() {
        let s = hx("fffcf9f6f3f0edeae7e4e1dedbd8d5d2cfccc9c6c3c0bdbab7b4b1aeaba8a5a29f9c999693908d8a8784817e7b7875726f6c696663605d5a5754514e4b484542");
        let got = derive_from_raw_seed(&s, "m/0/2147483647'/1/2147483646'/2").unwrap();
        assert_eq!(
            hex::encode(got),
            "bb7d39bdb83ecf58f2fd82b6d918341cbef428661ef01ab97c28a4842125ac23"
        );
    }

    /// 경로 문자열을 어떻게 읽는지. **좋은 입력이 통과하는지도 같이 본다** —
    /// 나쁜 것만 막고 좋은 것도 막으면 그건 고장이다.
    #[test]
    fn paths_parse_the_way_we_think_they_do() {
        // 좋은 것은 통과해야 한다.
        assert_eq!(
            parse_path("m/44'/175'/7'/0/0").unwrap(),
            vec![44 + HARDENED, 175 + HARDENED, 7 + HARDENED, 0, 0]
        );
        assert_eq!(
            parse_path("m/44h/175h/7h/1h/0h").unwrap(),
            vec![44 + HARDENED, 175 + HARDENED, 7 + HARDENED, 1 + HARDENED, HARDENED]
        );
        assert_eq!(parse_path("m/0").unwrap(), vec![0]);
        // 나쁜 것은 막아야 한다.
        assert!(parse_path("").is_none());
        assert!(parse_path("m").is_none(), "뿌리만 있는 경로는 열쇠가 아니다");
        assert!(parse_path("44'/175'").is_none(), "m 으로 시작하지 않는다");
        assert!(parse_path("m/44'/x/0").is_none());
        assert!(parse_path("m/2147483648").is_none(), "자리 번호가 넘친다");
        assert!(parse_path("m/-1").is_none());
    }

    /// 🔴 **경로가 고정되어 있는가.**
    ///
    /// 문자열은 위 `const _` 가 컴파일 시점에 막는다. 여기서는 한 걸음 더
    /// 가서 **결과 열쇠**를 못 박는다. 씨앗 만드는 방식이나 경로를 읽는
    /// 방식을 바꿔도 여기서 잡힌다.
    ///
    /// 아래 값은 공개키(이름표)다 — 개인키가 아니라서 적어 두어도 된다.
    /// 12단어는 BIP39 시험용으로 세상에 공개된 것이라 비밀이 아니다.
    #[test]
    fn the_person_path_is_frozen() {
        let m = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
        let sk = person_key_from(m, "").unwrap();
        assert_eq!(
            crate::shopkey::pubkey_of(&sk).unwrap(),
            PINNED_PERSON_PUBKEY,
            "사람 열쇠가 바뀌었습니다. 웹 지갑·폰과 다른 사람이 됩니다. \
             경로도 씨앗 만드는 방식도 바꾸면 안 됩니다."
        );
    }

    #[test]
    fn the_shop_path_is_frozen() {
        let m = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
        let sk = shop_key_from(m, "").unwrap();
        assert_eq!(
            crate::shopkey::pubkey_of(&sk).unwrap(),
            PINNED_SHOP_PUBKEY,
            "가게 간판 열쇠가 바뀌었습니다."
        );
    }

    /// 🔴 **돈과 사람이 다른 열쇠인가.** 같아지면 대화하다 돈이 샌다.
    #[test]
    fn the_person_key_is_not_a_money_key() {
        let m = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
        let seed = seed_from_words(m, "").unwrap();
        let person = derive(&seed, PATH_PERSON).unwrap();
        for i in 0..5 {
            let money = derive(&seed, &format!("m/44'/175'/0'/0/{i}")).unwrap();
            assert_ne!(person, money);
            let change = derive(&seed, &format!("m/44'/175'/0'/1/{i}")).unwrap();
            assert_ne!(person, change);
        }
        let shop = derive(&seed, PATH_SHOP).unwrap();
        assert_ne!(person, shop, "사람과 가게 간판은 달라야 한다");
        // 🔴 아티스트 열쇠가 사람·가게·돈 어느 것과도 같으면 안 된다.
        //    같으면 체인에 박는 순간 그 정체성들이 영구히 묶인다.
        let artist = derive(&seed, PATH_ARTIST).unwrap();
        assert_ne!(artist, person, "아티스트와 사람은 달라야 한다");
        assert_ne!(artist, shop, "아티스트와 가게 간판은 달라야 한다");
        for i in 0..5 {
            let money = derive(&seed, &format!("m/44'/175'/0'/0/{i}")).unwrap();
            assert_ne!(artist, money, "아티스트 열쇠로 돈을 못 움직여야 한다");
        }
        // 둘째 예명을 열어 둔 자리도 첫째와 달라야 한다.
        let artist2 = derive(&seed, "m/44'/175'/7'/2'/1'").unwrap();
        assert_ne!(artist, artist2, "예명끼리도 달라야 한다");
    }

    /// 아티스트 열쇠는 **12단어에서 늘 같은 값**이 나와야 한다.
    /// 이 값이 흔들리면 자산에 박은 공개키가 복구 뒤에 안 맞는다.
    #[test]
    fn artist_key_is_stable_from_words() {
        let m = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
        let a = artist_key_from(m, "").unwrap();
        let b = artist_key_from(m, "").unwrap();
        assert_eq!(a, b, "같은 12단어면 같은 아티스트 열쇠가 나와야 한다");
        // 암호가 붙으면 다른 사람이다(BIP39 규칙).
        assert_ne!(a, artist_key_from(m, "x").unwrap());
    }

    /// 옛 방식(표식 해시)과 새 방식이 **다른 값**인지. 같으면 옮길 것이
    /// 없다는 뜻인데, 실제로는 다르다 — 그래서 이 공사를 하는 것이다.
    #[test]
    fn the_old_way_and_the_new_way_really_differ() {
        let m = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
        let old = crate::shopkey::derive_tagged(crate::shopkey::SEED_TAG_TALK, m, "").unwrap();
        let new = person_key_from(m, "").unwrap();
        assert_ne!(old, new);
    }

    /// 12단어를 조금 다르게 적어도 같은 씨앗이 나오는가. 복구하는 사람은
    /// 종이에서 옮겨 적는다 — 대문자 하나로 실패하면 안 된다.
    #[test]
    fn sloppy_typing_still_recovers_the_same_person() {
        let clean = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
        let messy = "  Abandon   ABANDON abandon abandon abandon abandon\tabandon abandon abandon abandon abandon About ";
        assert_eq!(
            person_key_from(clean, "").unwrap(),
            person_key_from(messy, "").unwrap()
        );
    }

    /// 12단어가 모자라면 **만들어 내지 않는다.**
    #[test]
    fn too_few_words_is_a_refusal_not_a_guess() {
        assert!(person_key_from("abandon abandon about", "").is_none());
        assert!(seed_from_words("", "").is_none());
    }

    /// 🔴 **12단어가 이 파일 밖으로 나가지 않는가.**
    ///
    /// 소스를 읽어 「단어를 로그·오류·파일로 내보내는 모양」이 있는지 본다.
    /// ⚠️ 주석은 걸러낸다 — 이 파일은 주석에 `12단어`·`words` 가 잔뜩
    ///    나오고, 그걸 잡으면 **좋은 것도 막는 검사**가 된다.
    ///    (`feedback_guards_must_pass_the_good` 에서 두 번 데인 자리다.)
    #[test]
    fn no_secret_leaves_this_file() {
        // ⚠️ 시험 칸은 빼고 본다. 아래 찾을 문구가 시험 코드에 그대로
        //    적혀 있어서, 안 빼면 **검사가 자기 자신을 잡는다.**
        let src = include_str!("identity.rs");
        let real = src.split("#[cfg(test)]").next().unwrap();
        let code = strip_comments(real);

        // 검사기 자신이 멀쩡한지 먼저 본다. 주석을 못 걸러내면 아래
        // 검사는 언제나 통과하는 장식이 된다.
        assert!(
            !code.contains("파생 경로표"),
            "주석 걸러내기가 고장났다 — 주석 문구가 코드에 남아 있다"
        );
        assert!(
            code.contains("fn person_key_from"),
            "주석 걸러내기가 코드까지 지웠다 — 그러면 아래 검사가 전부 헛것이다"
        );

        for bad in [
            "println!", "eprintln!", "dbg!", "log::", "std::fs::write",
        ] {
            assert!(
                !code.contains(bad),
                "12단어가 지나가는 파일에 `{bad}` 이 있습니다. 단어가 새는 길이 될 수 있습니다."
            );
        }
        // 오류·응답으로 나가는 문자열에 단어를 끼워 넣는 모양.
        for bad in ["{words}", "{word_list}", "{passphrase}", "{pass}", "{m}", "{seed}"] {
            assert!(
                !code.contains(bad),
                "문자열에 `{bad}` 를 끼워 넣고 있습니다. 그 값이 화면이나 로그로 나갑니다."
            );
        }
    }

    /// 위 검사가 **일부러 깨뜨렸을 때 잡는지** 확인한다.
    /// 검사가 아무것도 안 잡는 검사인지 아닌지는 이렇게만 알 수 있다.
    #[test]
    fn the_leak_check_would_actually_catch_a_leak() {
        let pretend = "fn person_key_from() { println!(\"{words}\"); }";
        let code = strip_comments(pretend);
        assert!(code.contains("println!"));
        assert!(code.contains("{words}"));
        // 그리고 주석에만 있는 것은 안 잡아야 한다 — 좋은 입력도 통과.
        let innocent = "// println! 은 여기 쓰면 안 된다\nfn person_key_from() { }";
        let code = strip_comments(innocent);
        assert!(!code.contains("println!"));
    }

    /// 사람 열쇠는 **경로표에 적힌 그 자리**에서만 나오는가.
    /// (표를 화면에 보여 주는데 실제와 다르면 그건 거짓말이다.)
    #[test]
    fn the_table_on_screen_matches_the_code() {
        let t = identity_paths();
        let rows = t["rows"].as_array().unwrap();
        assert!(rows.iter().any(|r| r["path"] == PATH_PERSON));
        assert!(rows.iter().any(|r| r["path"] == PATH_SHOP));
        assert!(rows.iter().any(|r| r["path"] == PATH_MONEY));
    }

    // ── 옛 이름이 사라지지 않는가 ──────────────────────────────────────

    /// 시험용 데이터 폴더 하나. `PLAYX_RAVEN_HOME` 은 프로세스 전역이라
    /// 자물쇠를 잡고 들어간다(`paths::TEST_ENV`).
    fn in_a_temp_home<T>(f: impl FnOnce(&std::path::Path) -> T) -> T {
        let _g = crate::paths::TEST_ENV.lock().unwrap_or_else(|e| e.into_inner());
        let dir = std::env::temp_dir().join(format!("playx-identity-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::env::set_var("PLAYX_RAVEN_HOME", &dir);
        let out = f(&dir);
        std::env::remove_var("PLAYX_RAVEN_HOME");
        let _ = std::fs::remove_dir_all(&dir);
        out
    }

    /// 🔴 **옛 열쇠 파일이 지워지지 않는가.** 이 시험이 이 공사 전체에서
    ///    제일 중요하다. 지워지면 그 이름으로 쓴 글이 세계 릴레이에서
    ///    주인 없는 글이 되고, **되돌릴 길이 없다.**
    #[test]
    fn switching_names_never_deletes_the_old_key() {
        in_a_temp_home(|dir| {
            let old = [7u8; 32];
            let new = [9u8; 32];
            let p = dir.join("talkkey.json");
            std::fs::write(
                &p,
                serde_json::to_vec_pretty(&json!({ "sk": hex::encode(old), "from": "seed" }))
                    .unwrap(),
            )
            .unwrap();

            crate::talk::install_key(&new, "seed", PATH_PERSON).unwrap();

            // 새 열쇠가 자리를 잡았고
            let (got, _, path) = crate::talk::key_on_disk().unwrap();
            assert_eq!(got, new);
            assert_eq!(path, PATH_PERSON);

            // 옛 열쇠는 **옆에 살아 있다.**
            let kept: Vec<_> = std::fs::read_dir(dir)
                .unwrap()
                .filter_map(|e| e.ok())
                .map(|e| e.file_name().to_string_lossy().to_string())
                .filter(|n| n.starts_with("talkkey-old-"))
                .collect();
            assert_eq!(kept.len(), 1, "옛 열쇠 파일이 없어졌습니다: {kept:?}");
            let back: Value =
                serde_json::from_str(&std::fs::read_to_string(dir.join(&kept[0])).unwrap())
                    .unwrap();
            assert_eq!(
                back["sk"].as_str().unwrap(),
                hex::encode(old),
                "옆에 남긴 파일의 열쇠가 옛 열쇠가 아닙니다"
            );
        });
    }

    /// 옛 이름이 있으면 **그것을 쓴다.** 새 방식이 옳다고 갈아 끼우지 않는다.
    ///
    /// 파일이 있는 채로 `key_on_disk` 가 무엇을 읽는지로 확인한다. 실제
    /// `key()` 는 노드에 12단어를 물어보는 길이 있어 시험에서 못 부른다.
    #[test]
    fn an_existing_name_wins_over_the_new_way() {
        in_a_temp_home(|dir| {
            let old = [3u8; 32];
            std::fs::write(
                dir.join("talkkey.json"),
                serde_json::to_vec_pretty(&json!({
                    "sk": hex::encode(old), "from": "seed", "path": "legacy-talkkey-v1"
                }))
                .unwrap(),
            )
            .unwrap();
            let (got, from, path) = crate::talk::key_on_disk().unwrap();
            assert_eq!(got, old);
            assert_eq!(from, "seed");
            assert_eq!(path, "legacy-talkkey-v1");
        });
    }

    /// 파일이 없을 때 **상태를 물어봤다고 이름이 생기지는 않는가.**
    /// 물어보는 것만으로 사람이 태어나면 안 된다.
    #[test]
    fn asking_about_my_name_does_not_create_one() {
        in_a_temp_home(|dir| {
            assert!(crate::talk::key_on_disk().is_none());
            assert!(!dir.join("talkkey.json").exists());
        });
    }

    /// 깨진 파일은 **덮어쓰지 않는다** — 읽지 못했다고 답한다.
    /// (덮어쓰면 그 사람이 사라지고, 그게 최악이다.)
    #[test]
    fn a_broken_key_file_is_not_silently_replaced() {
        in_a_temp_home(|dir| {
            std::fs::write(dir.join("talkkey.json"), b"{ this is not json").unwrap();
            assert!(crate::talk::key_on_disk().is_none());
            // 파일은 그대로 있어야 한다.
            assert_eq!(
                std::fs::read(dir.join("talkkey.json")).unwrap(),
                b"{ this is not json"
            );
        });
    }

    // ── 시험 도우미 ────────────────────────────────────────────────────

    /// 못 박은 이름표. **공개키라서** 적어 두어도 되는 값이다. 12단어도
    /// BIP39 시험용으로 세상에 공개된 것이라 비밀이 아니다.
    ///
    /// 🔴 이 두 줄은 우리가 계산해서 적은 것이 **아니다.** 웹 지갑이 실제로
    ///    쓰는 라이브러리(`@ravenrebels/ravencoin-key`)를 직접 돌려서 나온
    ///    값이다. 그래서 이 시험이 통과하면 「데스크톱의 나 = 폰의 나」가
    ///    말이 아니라 증명이 된다. 우리 구현끼리만 맞춰 보면 둘 다 틀려도
    ///    통과하는 시험이 된다 — 그건 시험이 아니라 장식이다.
    ///
    ///    다시 뽑는 법:
    ///    node -e 'const K=require("@ravenrebels/ravencoin-key");
    ///             const hd=K.getHDKey("rvn", MNEMONIC);
    ///             console.log(K.getAddressByPath("rvn",hd,PATH).publicKey.slice(2))'
    const PINNED_PERSON_PUBKEY: &str =
        "b2b99a84f316d90b893ebd5e11c0b8d87adc0eb380371c5c3b58190f70895bb0";
    const PINNED_SHOP_PUBKEY: &str =
        "7821115dd0aa762d3a393fa861ce8e784403b9e0ec578bc37e72e6e9e70a1c09";

    /// BIP32 공식 시험값은 씨앗 길이가 제각각이라(16·64바이트) 시험에서만
    /// 길이를 안 따지는 길을 쓴다. 실제 코드는 언제나 64바이트다.
    fn derive_from_raw_seed(seed: &[u8], path: &str) -> Option<[u8; 32]> {
        let steps = parse_path(path)?;
        let i = hmac_sha512(b"Bitcoin seed", &[seed]);
        let mut k = [0u8; 32];
        k.copy_from_slice(&i[..32]);
        let mut c = [0u8; 32];
        c.copy_from_slice(&i[32..]);
        let secp = secp256k1::Secp256k1::new();
        let mut sk = secp256k1::SecretKey::from_byte_array(&k).ok()?;
        for step in steps {
            let data: Vec<u8> = if step >= HARDENED {
                let mut v = vec![0u8];
                v.extend_from_slice(&sk.secret_bytes());
                v.extend_from_slice(&step.to_be_bytes());
                v
            } else {
                let mut v = Vec::new();
                v.extend_from_slice(&secp256k1::PublicKey::from_secret_key(&secp, &sk).serialize());
                v.extend_from_slice(&step.to_be_bytes());
                v
            };
            let i = hmac_sha512(&c, &[&data[..]]);
            let mut tweak = [0u8; 32];
            tweak.copy_from_slice(&i[..32]);
            sk = sk.add_tweak(&secp256k1::Scalar::from_be_bytes(tweak).ok()?).ok()?;
            c.copy_from_slice(&i[32..]);
        }
        Some(sk.secret_bytes())
    }

    /// 아주 단순한 주석 지우개. `//` 부터 줄 끝까지 지운다.
    /// 문자열 안의 `//` 는 남긴다 — 안 그러면 코드를 지워 버린다.
    fn strip_comments(src: &str) -> String {
        let mut out = String::with_capacity(src.len());
        for line in src.lines() {
            let bytes = line.as_bytes();
            let mut in_str = false;
            let mut cut = line.len();
            let mut i = 0;
            while i < bytes.len() {
                match bytes[i] {
                    b'\\' if in_str => i += 1,
                    b'"' => in_str = !in_str,
                    b'/' if !in_str && i + 1 < bytes.len() && bytes[i + 1] == b'/' => {
                        cut = i;
                        break;
                    }
                    _ => {}
                }
                i += 1;
            }
            out.push_str(&line[..cut]);
            out.push('\n');
        }
        out
    }
}
