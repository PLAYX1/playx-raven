//! 복구 단어(12단어) **검사**와 **공개 주소** 만들기 — 되살리기(0.4.9)의 앞문.
//!
//! ## 왜 앱이 먼저 검사하나
//!
//! 🔴 레이븐 코어는 틀린 단어를 받으면 **단어 전체를 오류 문장에 넣어 `debug.log` 에
//! 적는다**(walletdb.cpp `SetMnemonic` → `invalid mnemonic: \`<입력 전체>\``). 윈도우에서는
//! 그 문장이 노드 stderr 를 거쳐 화면 오류·「문제 알리기」까지 간다(설계서 RV4 F7).
//! 그래서 **코어와 같은 규칙**(12·18·24단어 · 영어 목록과 글자 그대로 일치 · 체크섬)으로
//! 여기서 먼저 거르고, 통과한 단어만 노드에 건넨다. 틀린 단어는 노드가 영영 모른다.
//!
//! ## 🔴 단어는 오류에 절대 안 들어간다
//!
//! 이 파일의 모든 실패는 **몇 번째 칸인지(숫자)** 만 말한다. 단어 자체·앞 글자·
//! 「혹시 이것?」 제안은 화면(TS)이 사람이 친 칸 옆에 그린다 — 러스트 오류 문장에는
//! 없다. 시험 `errors_never_carry_words` 가 모든 실패 길을 지킨다.
//!
//! ## 왜 남의 crate 를 안 들였나
//!
//! `identity.rs` 와 같은 판단이다 — **12단어가 지나가는 자리에 공급망을 하나 더 들이지
//! 않는다.** RIPEMD-160·base58 은 짧은 표준 알고리즘이고, 아래 시험이 공식 시험값으로
//! 맞는지 증명한다. 주소는 폰·웹(`core/wallet-keys/derive.ts`)이 만든 값과
//! `scripts/fixtures/restore-vectors.json` 으로 한 글자까지 대조한다.

use sha2::{Digest, Sha256};

/// BIP39 영어 단어 목록. 🔴 **공식 파일 그대로**다(bitcoin/bips `bip-0039/english.txt`,
/// SHA-256 `2f5eed53…24dbda`). 화면(`src/bip39-english.txt`)과 **같은 파일 하나**를 쓴다.
pub const WORDLIST_TXT: &str = include_str!("../../src/bip39-english.txt");

fn wordlist() -> &'static [&'static str] {
    static LIST: std::sync::OnceLock<Vec<&'static str>> = std::sync::OnceLock::new();
    LIST.get_or_init(|| WORDLIST_TXT.lines().collect())
}

/// 목록에서 몇 번째인가. 영어 목록은 알파벳순이라 이분 탐색이 된다.
fn index_of(word: &str) -> Option<u16> {
    wordlist().binary_search(&word).ok().map(|i| i as u16)
}

/// 글자를 **지운 뒤** 버린다. `String` 을 그냥 떨어뜨리면 그 자리의 바이트가
/// 다음 할당까지 메모리에 남는다. 0 바이트는 올바른 UTF-8 이라 안전하다.
pub fn wipe(s: &mut String) {
    // SAFETY: 0 으로만 덮는다 — 0 바이트 열은 올바른 UTF-8 이다.
    let bytes = unsafe { s.as_bytes_mut() };
    for b in bytes.iter_mut() {
        // 최적화가 「어차피 버릴 값」이라며 쓰기를 빼 먹지 못하게 volatile 로 쓴다.
        unsafe { std::ptr::write_volatile(b, 0) };
    }
    s.clear();
}

/// 바이트 칸을 지운다(씨앗·개인키).
pub fn wipe_bytes(b: &mut [u8]) {
    for x in b.iter_mut() {
        unsafe { std::ptr::write_volatile(x, 0) };
    }
}

/// 정리한 복구 단어. 🔴 `Debug`·`Display`·`Clone` 이 **없다** — 실수로라도 로그·오류·
/// `format!` 에 못 들어가게. 떨어질 때 스스로 지운다.
pub struct Phrase(String);

impl Phrase {
    /// 노드에 건넬 때만 꺼낸다(설정 통로 한 줄). 다른 곳에서 부르지 않는다.
    pub fn expose(&self) -> &str {
        &self.0
    }
    pub fn count(&self) -> usize {
        self.0.split(' ').count()
    }
}

impl Drop for Phrase {
    fn drop(&mut self) {
        wipe(&mut self.0);
    }
}

/// 사람이 친 것을 코어가 받는 모양으로 맞춘다 — 소문자 · 한 칸 띄움.
/// (폰 `normalizePhrase` 와 같다. 영어 단어는 전부 ASCII 라 NFKD 가 바꾸는 것이 없다.)
pub fn normalize(input: &str) -> Phrase {
    let mut out = String::with_capacity(input.len());
    for (i, w) in input.split_whitespace().enumerate() {
        if i > 0 {
            out.push(' ');
        }
        for c in w.chars() {
            out.extend(c.to_lowercase());
        }
    }
    Phrase(out)
}

/// 무엇이 틀렸나. 🔴 **숫자만** 담는다 — 단어는 담지 않는다.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Problem {
    /// 단어 개수가 12·18·24 가 아니다(지금 몇 개인지).
    Count(usize),
    /// 목록에 없는 단어의 자리(사람이 세는 번호, 1부터).
    Unknown(Vec<usize>),
    /// 다 목록에 있는데 체크섬이 안 맞는다 — 어느 단어인지는 계산으로 알 수 없다.
    Checksum,
}

impl Problem {
    /// 화면에 띄울 **고정 문장**. 값은 숫자뿐이다.
    pub fn message(&self) -> String {
        match self {
            Problem::Count(n) => format!("복구 단어는 12개(또는 24개)여야 합니다. 지금 {n}개입니다."),
            Problem::Unknown(at) => format!(
                "{}번째 단어가 복구 단어 목록에 없습니다. 철자를 확인해 주세요.",
                at.iter().map(|n| n.to_string()).collect::<Vec<_>>().join("·")
            ),
            Problem::Checksum => "단어 하나가 틀렸거나 순서가 바뀌었습니다. 어느 것인지는 계산으로 알 수 없습니다 — 종이에서 흐린 글자, 비슷한 단어를 봐 주세요.".into(),
        }
    }
}

/// **코어 `CMnemonic::Check` 와 같은 규칙**으로 검사한다(bip39.cpp 89–160).
///
/// * 12·18·24단어만(코어도 그것만 받는다).
/// * 단어는 목록과 **글자 그대로** 같아야 한다(여기서는 소문자로 맞춘 뒤 비교).
/// * 체크섬: 엔트로피의 SHA-256 앞 (단어 수 / 3) 비트.
pub fn check(input: &str) -> Result<Phrase, Problem> {
    let phrase = normalize(input);
    let n = if phrase.0.is_empty() { 0 } else { phrase.count() };
    if !matches!(n, 12 | 18 | 24) {
        return Err(Problem::Count(n));
    }
    let mut idx = Vec::with_capacity(n);
    let mut unknown = Vec::new();
    for (i, w) in phrase.0.split(' ').enumerate() {
        match index_of(w) {
            Some(v) => idx.push(v),
            None => unknown.push(i + 1),
        }
    }
    if !unknown.is_empty() {
        wipe_u16(&mut idx);
        return Err(Problem::Unknown(unknown));
    }
    // 11비트씩 이어 붙인다: 엔트로피 n*11*32/33 비트 + 체크섬 n/3 비트.
    let total_bits = n * 11;
    let cs_bits = n / 3;
    let ent_bytes = (total_bits - cs_bits) / 8;
    let mut bits = vec![0u8; (total_bits + 7) / 8];
    for (k, v) in idx.iter().enumerate() {
        for b in 0..11 {
            if v & (1 << (10 - b)) != 0 {
                let pos = k * 11 + b;
                bits[pos / 8] |= 1 << (7 - pos % 8);
            }
        }
    }
    let mut digest: [u8; 32] = Sha256::digest(&bits[..ent_bytes]).into();
    let mask: u8 = 0xFFu8 << (8 - cs_bits);
    let ok = (bits[ent_bytes] & mask) == (digest[0] & mask);
    wipe_bytes(&mut bits);
    wipe_bytes(&mut digest);
    wipe_u16(&mut idx);
    if !ok {
        return Err(Problem::Checksum);
    }
    Ok(phrase)
}

fn wipe_u16(v: &mut [u16]) {
    for x in v.iter_mut() {
        unsafe { std::ptr::write_volatile(x, 0) };
    }
}

// ── RIPEMD-160 (공개키 → 주소에만 쓴다. 비밀이 지나가지 않는다) ─────────

const RL: [usize; 80] = [
    0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 7, 4, 13, 1, 10, 6, 15, 3, 12, 0, 9, 5,
    2, 14, 11, 8, 3, 10, 14, 4, 9, 15, 8, 1, 2, 7, 0, 6, 13, 11, 5, 12, 1, 9, 11, 10, 0, 8, 12, 4,
    13, 3, 7, 15, 14, 5, 6, 2, 4, 0, 5, 9, 7, 12, 2, 10, 14, 1, 3, 8, 11, 6, 15, 13,
];
const RR: [usize; 80] = [
    5, 14, 7, 0, 9, 2, 11, 4, 13, 6, 15, 8, 1, 10, 3, 12, 6, 11, 3, 7, 0, 13, 5, 10, 14, 15, 8, 12,
    4, 9, 1, 2, 15, 5, 1, 3, 7, 14, 6, 9, 11, 8, 12, 2, 10, 0, 4, 13, 8, 6, 4, 1, 3, 11, 15, 0, 5,
    12, 2, 13, 9, 7, 10, 14, 12, 15, 10, 4, 1, 5, 8, 7, 6, 2, 13, 14, 0, 3, 9, 11,
];
const SL: [u32; 80] = [
    11, 14, 15, 12, 5, 8, 7, 9, 11, 13, 14, 15, 6, 7, 9, 8, 7, 6, 8, 13, 11, 9, 7, 15, 7, 12, 15,
    9, 11, 7, 13, 12, 11, 13, 6, 7, 14, 9, 13, 15, 14, 8, 13, 6, 5, 12, 7, 5, 11, 12, 14, 15, 14,
    15, 9, 8, 9, 14, 5, 6, 8, 6, 5, 12, 9, 15, 5, 11, 6, 8, 13, 12, 5, 12, 13, 14, 11, 8, 5, 6,
];
const SR: [u32; 80] = [
    8, 9, 9, 11, 13, 15, 15, 5, 7, 7, 8, 11, 14, 14, 12, 6, 9, 13, 15, 7, 12, 8, 9, 11, 7, 7, 12,
    7, 6, 15, 13, 11, 9, 7, 15, 11, 8, 6, 6, 14, 12, 13, 5, 14, 13, 13, 7, 5, 15, 5, 8, 11, 14, 14,
    6, 14, 6, 9, 12, 9, 12, 5, 15, 8, 8, 5, 12, 9, 12, 5, 14, 6, 8, 13, 6, 5, 15, 13, 11, 11,
];
const KL: [u32; 5] = [0x0000_0000, 0x5A82_7999, 0x6ED9_EBA1, 0x8F1B_BCDC, 0xA953_FD4E];
const KR: [u32; 5] = [0x50A2_8BE6, 0x5C4D_D124, 0x6D70_3EF3, 0x7A6D_76E9, 0x0000_0000];

fn rf(j: usize, x: u32, y: u32, z: u32) -> u32 {
    match j / 16 {
        0 => x ^ y ^ z,
        1 => (x & y) | (!x & z),
        2 => (x | !y) ^ z,
        3 => (x & z) | (y & !z),
        _ => x ^ (y | !z),
    }
}

pub fn ripemd160(msg: &[u8]) -> [u8; 20] {
    let mut h: [u32; 5] = [0x6745_2301, 0xEFCD_AB89, 0x98BA_DCFE, 0x1032_5476, 0xC3D2_E1F0];
    let mut data = msg.to_vec();
    let bit_len = (msg.len() as u64).wrapping_mul(8);
    data.push(0x80);
    while data.len() % 64 != 56 {
        data.push(0);
    }
    data.extend_from_slice(&bit_len.to_le_bytes());
    for block in data.chunks(64) {
        let mut x = [0u32; 16];
        for (i, w) in x.iter_mut().enumerate() {
            *w = u32::from_le_bytes([block[i * 4], block[i * 4 + 1], block[i * 4 + 2], block[i * 4 + 3]]);
        }
        let (mut al, mut bl, mut cl, mut dl, mut el) = (h[0], h[1], h[2], h[3], h[4]);
        let (mut ar, mut br, mut cr, mut dr, mut er) = (h[0], h[1], h[2], h[3], h[4]);
        for j in 0..80 {
            let t = al
                .wrapping_add(rf(j, bl, cl, dl))
                .wrapping_add(x[RL[j]])
                .wrapping_add(KL[j / 16])
                .rotate_left(SL[j])
                .wrapping_add(el);
            al = el;
            el = dl;
            dl = cl.rotate_left(10);
            cl = bl;
            bl = t;
            let t = ar
                .wrapping_add(rf(79 - j, br, cr, dr))
                .wrapping_add(x[RR[j]])
                .wrapping_add(KR[j / 16])
                .rotate_left(SR[j])
                .wrapping_add(er);
            ar = er;
            er = dr;
            dr = cr.rotate_left(10);
            cr = br;
            br = t;
        }
        let t = h[1].wrapping_add(cl).wrapping_add(dr);
        h[1] = h[2].wrapping_add(dl).wrapping_add(er);
        h[2] = h[3].wrapping_add(el).wrapping_add(ar);
        h[3] = h[4].wrapping_add(al).wrapping_add(br);
        h[4] = h[0].wrapping_add(bl).wrapping_add(cr);
        h[0] = t;
    }
    let mut out = [0u8; 20];
    for (i, v) in h.iter().enumerate() {
        out[i * 4..i * 4 + 4].copy_from_slice(&v.to_le_bytes());
    }
    out
}

// ── base58check ─────────────────────────────────────────────────────────

const B58: &[u8; 58] = b"123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

pub fn base58check(version: u8, payload: &[u8]) -> String {
    let mut data = Vec::with_capacity(1 + payload.len() + 4);
    data.push(version);
    data.extend_from_slice(payload);
    let sum = Sha256::digest(Sha256::digest(&data));
    data.extend_from_slice(&sum[..4]);
    // 큰 수를 58 진법으로. 앞의 0 바이트는 「1」 하나씩.
    let zeros = data.iter().take_while(|b| **b == 0).count();
    let mut digits: Vec<u8> = Vec::new();
    for &byte in &data[zeros..] {
        let mut carry = byte as u32;
        for d in digits.iter_mut() {
            carry += (*d as u32) << 8;
            *d = (carry % 58) as u8;
            carry /= 58;
        }
        while carry > 0 {
            digits.push((carry % 58) as u8);
            carry /= 58;
        }
    }
    let mut s = String::with_capacity(zeros + digits.len());
    for _ in 0..zeros {
        s.push('1');
    }
    for d in digits.iter().rev() {
        s.push(B58[*d as usize] as char);
    }
    s
}

/// 레이븐 메인넷 P2PKH 접두(`R`). regtest·testnet 은 111.
pub const MAINNET: u8 = 60;
pub const TESTNET: u8 = 111;

/// 씨앗 → `m/44'/175'/0'/{change}/{index}` 의 **공개 주소**. 개인키는 여기서 태운다.
pub fn address_at(seed: &[u8; 64], change: u32, index: u32, version: u8) -> Option<String> {
    let coin = if version == MAINNET { 175 } else { 1 };
    let path = format!("m/44'/{coin}'/0'/{change}/{index}");
    let mut key = crate::identity::derive(seed, &path)?;
    let secp = secp256k1::Secp256k1::new();
    let sk = secp256k1::SecretKey::from_byte_array(&key).ok();
    wipe_bytes(&mut key);
    let pk = secp256k1::PublicKey::from_secret_key(&secp, &sk?).serialize();
    let h = ripemd160(&Sha256::digest(pk));
    Some(base58check(version, &h))
}

/// 받기 `receive` 개 · 거스름 `change` 개의 공개 주소. 씨앗은 여기서 만들고 여기서 지운다.
pub fn addresses(phrase: &Phrase, passphrase: &str, receive: u32, change: u32, version: u8) -> Option<(Vec<String>, Vec<String>)> {
    let mut seed = crate::identity::seed_from_words(phrase.expose(), passphrase)?;
    let out = (|| {
        let r = (0..receive).map(|i| address_at(&seed, 0, i, version)).collect::<Option<Vec<_>>>()?;
        let c = (0..change).map(|i| address_at(&seed, 1, i, version)).collect::<Option<Vec<_>>>()?;
        Some((r, c))
    })();
    wipe_bytes(&mut seed);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hex(b: &[u8]) -> String {
        b.iter().map(|x| format!("{x:02x}")).collect()
    }

    /// U1 — 목록은 공식 파일 그대로여야 한다. 한 글자라도 다르면 되살린 지갑이 다른 사람이다.
    #[test]
    fn wordlist_is_the_official_file() {
        assert_eq!(wordlist().len(), 2048);
        assert_eq!(
            hex(&Sha256::digest(WORDLIST_TXT.as_bytes())),
            "2f5eed53a4727b4bf8880d8f3f199efc90e58503646d9ff8eff3a2ed3b24dbda"
        );
        let mut sorted = wordlist().to_vec();
        sorted.sort();
        assert_eq!(sorted, wordlist(), "이분 탐색은 정렬된 목록에서만 맞다");
    }

    #[test]
    fn ripemd160_official_vectors() {
        assert_eq!(hex(&ripemd160(b"")), "9c1185a5c5e9fc54612808977ee8f548b2258d31");
        assert_eq!(hex(&ripemd160(b"abc")), "8eb208f7e05d987a9b044a8e98c6b087f15a0bfc");
        assert_eq!(hex(&ripemd160(b"message digest")), "5d0689ef49d2fae572b881b123a85ffa21595f36");
        assert_eq!(
            hex(&ripemd160(b"abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq")),
            "12a053384a9c0c88e405a06c27dcf49ada62eb2b"
        );
        assert_eq!(hex(&ripemd160(&vec![b'a'; 1_000_000])), "52783243c1697bdbe16d37f97f68f08325dc1528");
    }

    #[test]
    fn base58check_known_value() {
        // 비트코인 위키의 hash160(0 x20) = 주소 1111111111111111111114oLvT2 (버전 0).
        assert_eq!(base58check(0, &[0u8; 20]), "1111111111111111111114oLvT2");
    }

    /// U2 — 공식 BIP39 시험 벡터(Trezor)는 전부 통과, 개수·목록·체크섬 틀림은 거절.
    #[test]
    fn checksum_matches_core_rule() {
        for ok in [
            "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
            "legal winner thank year wave sausage worth useful legal winner thank yellow",
            "letter advice cage absurd amount doctor acoustic avoid letter advice cage above",
            "zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo wrong",
            "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon agent",
            "zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo vote",
            "  Abandon  ABANDON abandon\tabandon abandon abandon abandon abandon abandon abandon abandon\nabout ",
        ] {
            assert!(check(ok).is_ok(), "통과해야 한다(길이 {})", ok.len());
        }
        let twelve_a = "abandon ".repeat(12);
        assert_eq!(check(&twelve_a).err(), Some(Problem::Checksum));
        assert_eq!(check(&"abandon ".repeat(11)).err(), Some(Problem::Count(11)));
        assert_eq!(check(&"abandon ".repeat(13)).err(), Some(Problem::Count(13)));
        assert_eq!(check(&"abandon ".repeat(15)).err(), Some(Problem::Count(15)));
        assert_eq!(check(&"abandon ".repeat(21)).err(), Some(Problem::Count(21)));
        assert_eq!(check("").err(), Some(Problem::Count(0)));
        let typo = "abandon abandn abandon abandon abandon abandon abandon abandon abandon abandon abandon abaut";
        assert_eq!(check(typo).err(), Some(Problem::Unknown(vec![2, 12])));
        // 두 단어를 바꿔 넣으면 체크섬이 걸려야 한다.
        let swapped = "legal winner thank year wave sausage worth useful legal winner yellow thank";
        assert_eq!(check(swapped).err(), Some(Problem::Checksum));
    }

    /// U3 — 씨앗은 공식 BIP39 벡터(추가 암호 TREZOR)와 같아야 한다.
    #[test]
    fn seed_matches_official_vector() {
        let p = check("abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about").ok().unwrap();
        let seed = crate::identity::seed_from_words(p.expose(), "TREZOR").unwrap();
        assert!(hex(&seed).starts_with("c55257c360c07c72029aebc1b53c05ed0362ada38ead3e3e9efa3708e53495531f09a6987599d18264c1e1c92f2cf141630c7a3c4ab7c81b2f001698e7463b04"));
    }

    /// U5 — 폰·웹(`core/wallet-keys/derive.ts`)이 만든 주소와 한 글자까지 같아야 한다.
    /// 표는 폰 코드가 만든 것이다(`scripts/check-restore-vectors.mjs` 가 다시 만들어 대조).
    #[test]
    fn addresses_match_phone_fixture() {
        let fixture: serde_json::Value =
            serde_json::from_str(include_str!("../../scripts/fixtures/restore-vectors.json")).unwrap();
        let vectors = fixture["vectors"].as_array().unwrap();
        assert!(vectors.len() >= 4);
        for v in vectors {
            let p = check(v["mnemonic"].as_str().unwrap()).ok().expect("공개 벡터는 체크섬을 통과한다");
            let recv: Vec<&str> = v["receive"].as_array().unwrap().iter().map(|a| a.as_str().unwrap()).collect();
            let chg: Vec<&str> = v["change"].as_array().unwrap().iter().map(|a| a.as_str().unwrap()).collect();
            let (r, c) = addresses(&p, v["passphrase"].as_str().unwrap(), recv.len() as u32, chg.len() as u32, MAINNET).unwrap();
            assert_eq!(r, recv, "받기 주소가 폰과 다르다: {}", v["name"]);
            assert_eq!(c, chg, "거스름 주소가 폰과 다르다: {}", v["name"]);
            assert!(r.iter().chain(c.iter()).all(|a| a.starts_with('R')));
        }
    }

    /// U6 — 어떤 실패 문장에도 친 단어가 없다(폰 `throwsMessageSafe` 와 같은 방식).
    #[test]
    fn errors_never_carry_words() {
        let tries = [
            "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon".to_string(),
            "legal winner thank year wave sausage worth useful legal winner yellow thank".to_string(),
            "zebra zebra zebra".to_string(),
            "abandon abandn abandon abandon abandon abandon abandon abandon abandon abandon abandon abaut".to_string(),
            "letter advice cage absurd amount doctor acoustic avoid letter advice cage above extra".to_string(),
            "사과 바다 구름 호랑이 레몬 피아노 대양 촛불 숲 로켓 은색 강".to_string(),
        ];
        for t in &tries {
            let Err(problem) = check(t) else { panic!("실패해야 한다") };
            let said = problem.message();
            let dbg = format!("{problem:?}");
            for w in t.split_whitespace() {
                if w.chars().all(|c| c.is_ascii_digit()) {
                    continue;
                }
                assert!(!said.contains(w), "오류 문장에 단어가 샜다");
                assert!(!dbg.contains(w), "디버그 표시에 단어가 샜다");
            }
        }
    }

    /// 🔴 소스 검사 — `Phrase` 에 `Debug`·`Clone`·`Display` 를 붙이면 로그로 샐 길이 생긴다.
    #[test]
    fn phrase_has_no_debug_or_clone() {
        let src = include_str!("words.rs");
        let i = src.find(&format!("pub struct {}(String)", "Phrase")).unwrap();
        let head = &src[i.saturating_sub(300)..i];
        assert!(!head.contains("derive("), "Phrase 에 derive 를 붙이면 안 된다");
        let impl_display = format!("impl std::fmt::Display for {}", "Phrase");
        assert!(!src.contains(&impl_display));
    }

    #[test]
    fn wipe_clears() {
        let mut s = String::from("abandon about");
        wipe(&mut s);
        assert!(s.is_empty());
    }
}
