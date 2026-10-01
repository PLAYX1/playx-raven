//! 가게 지도 이벤트 **형식** — 이름표(kind 31402)와 영업 중 신호(kind 31403).
//!
//! ## 정본은 폰 쪽 문서다
//!
//! `ravenvault/docs/MERCHANT-EVENT-FORMAT.md` (폰/웹 지도 `core/market/merchants/relay.ts`
//! 가 읽는 형식). 여기는 그 문서를 **글자 하나까지** 따라 만든다. 한 칸이라도 다르면
//! 폰이 **조용히 버린다** — 사장은 올린 줄 아는데 지도에는 안 뜬다. 그래서 문서의
//! 시험 벡터(고정 키 0x15·0x17)를 아래 시험이 그대로 대조한다.
//!
//! 이 파일은 **순수 형식·서명**만 한다(파일·네트워크 없음). 저장·게시·심장은 `map.rs`.
//!
//! ## 두 겹 서명
//!
//! - 겉봉투: 표준 Nostr 이벤트(NIP-01, BIP340 schnorr). 키는 아무 키나 된다.
//! - 안쪽: 레이븐코인 메시지 서명(발행 주소 `R…` 의 키). **이것이 진짜 권한**이다 —
//!   폰은 `pubkey → 주소 == issuer` 와 이 서명을 둘 다 확인한다.
//!   형식: `sha256d("\x16Raven Signed Message:\n" ‖ varint(len) ‖ msg)` 에
//!   secp256k1 ECDSA, **64바이트 r‖s(복구 바이트 없음, low-S)** 를 표준 base64 로.
//!   코어의 `signmessage` 는 65바이트(복구 바이트 포함)라 그대로 쓰면 폰이 거절한다.
//!
//! ## 🔴 정확한 위치는 싣지 않는다
//!
//! 동네는 geohash **정확히 5자리**(약 4.9km 칸)만. 더 긴 값은 자르지 않고 **거절**한다
//! — 잘라 주면 실수로 넣은 정확 좌표가 「됐다」는 말과 함께 지나간다.

use secp256k1::{Message, PublicKey, Secp256k1, SecretKey};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};

pub const CARD_NOSTR_KIND: i64 = 31402;
pub const BEAT_NOSTR_KIND: i64 = 31403;
pub const CARD_TAG: &str = "ravenvault-merchant";
pub const BEAT_TAG: &str = "ravenvault-presence";
pub const CARD_FORMAT: &str = "rv.merchant/1";
pub const BEAT_FORMAT: &str = "rv.shop-presence/1";
/// NIP-09 지우기. 「영업 끝」·「내리기」 때 신호·이름표를 거둔다.
pub const DELETE_KIND: i64 = 5;

/// 업종 — 폰 `MERCHANT_CATEGORIES` 와 같은 순서·같은 값.
pub const CATEGORIES: [(&str, &str); 8] = [
    ("food", "음식"),
    ("grocery", "과일·채소"),
    ("cafe", "카페"),
    ("fitness", "운동·체육관"),
    ("living", "생활"),
    ("repair", "수리"),
    ("education", "배움"),
    ("other", "기타"),
];

/// 동네 표 — 폰 `core/market/merchants/areas.ts` 의 25곳을 **그대로** 옮겼다
/// (이름·묶음·5자리). 좌표는 옮기지 않는다 — 이 프로그램은 좌표를 쓰지 않는다.
/// 같은 칸에 여러 동네가 들어갈 수 있다(안양 만안구·동안구·군포시 = wydk8).
pub const AREAS: [(&str, &str, &str); 25] = [
    ("의왕시", "의왕", "wydk3"),
    ("의왕 내손동", "의왕", "wydk9"),
    ("의왕 부곡동", "의왕", "wydk2"),
    ("안양 만안구", "안양·군포·과천", "wydk8"),
    ("안양 동안구", "안양·군포·과천", "wydk8"),
    ("군포시", "안양·군포·과천", "wydk8"),
    ("과천시", "안양·군포·과천", "wydkc"),
    ("수원 장안구", "수원", "wydk4"),
    ("수원 권선구", "수원", "wyd7c"),
    ("수원 팔달구", "수원", "wydk4"),
    ("수원 영통구", "수원", "wyd7g"),
    ("성남 수정구", "성남", "wydmj"),
    ("성남 중원구", "성남", "wydkv"),
    ("성남 분당구", "성남", "wydks"),
    ("서울 강남구", "서울", "wydm7"),
    ("서울 서초구", "서울", "wydm4"),
    ("서울 송파구", "서울", "wydmk"),
    ("서울 관악구", "서울", "wydm0"),
    ("서울 동작구", "서울", "wydm2"),
    ("서울 영등포구", "서울", "wydjr"),
    ("서울 마포구", "서울", "wydjx"),
    ("서울 종로구", "서울", "wydmc"),
    ("서울 용산구", "서울", "wydm9"),
    ("서울 강서구", "서울", "wydjw"),
    ("서울 노원구", "서울", "wydq5"),
];

const BASE32: &str = "0123456789bcdefghjkmnpqrstuvwxyz";

/// geohash 정확히 5자리인가(폰 `AREA_PATTERN` = `^[0-9b-hjkmnp-z]{5}$`).
pub fn is_area(v: &str) -> bool {
    v.chars().count() == 5 && v.chars().all(|c| BASE32.contains(c))
}

/// 표에 있는 동네 칸인가. 라비는 이것만 고를 수 있다(지어낸 칸은 거절).
pub fn known_area(v: &str) -> bool {
    AREAS.iter().any(|(_, _, a)| *a == v)
}

/// 동네 이름 또는 5자리 → 표의 칸. 이름은 공백을 무시하고 **정확히** 맞아야 한다.
pub fn resolve_known_area(v: &str) -> Option<&'static str> {
    let q: String = v.chars().filter(|c| !c.is_whitespace()).collect::<String>().to_lowercase();
    AREAS
        .iter()
        .find(|(name, _, a)| *a == q || name.chars().filter(|c| !c.is_whitespace()).collect::<String>() == q)
        .map(|(_, _, a)| *a)
}

pub fn is_category(v: &str) -> bool {
    CATEGORIES.iter().any(|(k, _)| *k == v)
}

/// JS `String.length` — UTF-16 단위. 폰이 이걸로 세므로 우리도 이걸로 센다.
fn js_len(s: &str) -> usize {
    s.encode_utf16().count()
}

/// 폰 `HIDDEN` — 제어문자(U+0000~001F, 007F), 폭 없는 글자(U+200B~200F), 양방향 제어(U+202A~202E, U+2066~2069), BOM(U+FEFF).
fn hidden(c: char) -> bool {
    matches!(c as u32, 0..=0x1f | 0x7f | 0x200b..=0x200f | 0x202a..=0x202e | 0x2066..=0x2069 | 0xfeff)
}

/// JS `\s` 에 들어가는 글자(유니코드 공백 + BOM).
fn js_space(c: char) -> bool {
    c.is_whitespace() || c == '\u{feff}'
}

fn is_text(v: &str, max: usize) -> bool {
    !v.trim().is_empty() && js_len(v) <= max && !v.chars().any(hidden)
}

/// `^[a-z0-9][a-z0-9-]{1,39}$`
pub fn is_slug(v: &str) -> bool {
    let b = v.as_bytes();
    (2..=40).contains(&b.len())
        && (b[0].is_ascii_lowercase() || b[0].is_ascii_digit())
        && b.iter().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || *c == b'-')
}

/// `^https:\/\/[^\s/]+\.[^\s]+$`(대소문자 무시) · 200자 이하 · 숨은 글자 없음.
pub fn is_shop_url(v: &str) -> bool {
    if js_len(v) > 200 || v.chars().any(hidden) || !v.get(..8).is_some_and(|h| h.eq_ignore_ascii_case("https://")) {
        return false;
    }
    let rest = &v[8..]; // 앞 8바이트가 ASCII 임을 위에서 확인했다
    if rest.is_empty() || rest.chars().any(js_space) {
        return false;
    }
    // 첫 `/` 앞(주소 이름)에 점이 하나 있고, 그 점이 맨 앞이 아니며 뒤에 글자가 있어야 한다.
    let host_end = rest.find('/').unwrap_or(rest.len());
    rest[..host_end]
        .char_indices()
        .any(|(i, c)| c == '.' && i >= 1 && i + 1 < rest.len())
}

/// 임시 터널 주소인가 — 재시작마다 바뀐다.
pub fn is_temporary_url(v: &str) -> bool {
    v.to_ascii_lowercase().contains(".trycloudflare.com")
}

/// 이름표 한 장(서명 전).
#[derive(Clone, Debug, PartialEq)]
pub struct Card {
    pub slug: String,
    pub name: String,
    pub category: String,
    pub area: String,
    /// 데스크톱 화면은 넣지 않는다(올리는 것은 이름·업종·동네·링크뿐). 시험 벡터 대조용.
    pub contact: Option<String>,
    pub shop_url: Option<String>,
    pub created_at: i64,
}

impl Card {
    /// 앞뒤 공백을 걷고 빈 선택 칸은 **뺀다**(폰 `normalizeDraft` 와 같다 — 빈 문자열을 넣지 않는다).
    pub fn normalized(&self) -> Card {
        let opt = |o: &Option<String>| o.as_ref().map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
        Card {
            slug: self.slug.clone(),
            name: self.name.trim().to_string(),
            category: self.category.clone(),
            area: self.area.clone(),
            contact: opt(&self.contact),
            shop_url: opt(&self.shop_url),
            created_at: self.created_at,
        }
    }
}

/// 필드 검사 — 폰 `merchantDraftProblems` 와 같은 규칙·같은 문구(한국어 원문 = 번역 열쇠).
pub fn card_problems(c: &Card) -> Vec<&'static str> {
    let mut out = Vec::new();
    if !is_slug(&c.slug) {
        out.push("가게 주소 이름은 영문 소문자·숫자·- 로 2~40자여야 해요.");
    }
    if !is_text(&c.name, 40) {
        out.push("가게 이름은 1~40자여야 해요.");
    }
    if !is_category(&c.category) {
        out.push("업종을 골라 주세요.");
    }
    if !is_area(&c.area) {
        out.push("동네는 5자리 지역 코드만 쓸 수 있어요. 정확한 위치는 받지 않아요.");
    }
    if let Some(ct) = &c.contact {
        if !is_text(ct, 80) {
            out.push("연락처는 80자 이하로 적어 주세요.");
        }
    }
    if let Some(u) = &c.shop_url {
        if !is_shop_url(u) {
            out.push("가게 링크는 https:// 로 시작해야 해요.");
        }
    }
    if c.created_at <= 0 || c.created_at > 9_007_199_254_740_991 {
        out.push("시각이 올바르지 않아요.");
    }
    out
}

/// 서명 대상 — `JSON.stringify([kind, issuer, slug, name, category, area, contact ?? "", shopUrl ?? "", createdAt])`.
pub fn card_message(c: &Card, issuer: &str) -> String {
    serde_json::to_string(&json!([
        CARD_FORMAT,
        issuer,
        c.slug,
        c.name,
        c.category,
        c.area,
        c.contact.as_deref().unwrap_or(""),
        c.shop_url.as_deref().unwrap_or(""),
        c.created_at
    ]))
    .unwrap_or_default()
}

/// 서명 대상 — `JSON.stringify(["rv.shop-presence/1", issuer, slug, at, openItems ?? null])`.
pub fn beat_message(issuer: &str, slug: &str, at: i64, open_items: Option<u32>) -> String {
    serde_json::to_string(&json!([BEAT_FORMAT, issuer, slug, at, open_items])).unwrap_or_default()
}

/// 레이븐코인 메시지 해시 — `sha256d(varint(22) "Raven Signed Message:\n" varint(len) msg)`.
pub fn rvn_message_hash(msg: &str) -> [u8; 32] {
    const MAGIC: &[u8] = b"Raven Signed Message:\n";
    let mut buf = Vec::with_capacity(MAGIC.len() + msg.len() + 10);
    varint(&mut buf, MAGIC.len() as u64);
    buf.extend_from_slice(MAGIC);
    varint(&mut buf, msg.len() as u64);
    buf.extend_from_slice(msg.as_bytes());
    Sha256::digest(Sha256::digest(&buf)).into()
}

fn varint(out: &mut Vec<u8>, n: u64) {
    match n {
        0..=0xfc => out.push(n as u8),
        0xfd..=0xffff => {
            out.push(0xfd);
            out.extend_from_slice(&(n as u16).to_le_bytes());
        }
        0x1_0000..=0xffff_ffff => {
            out.push(0xfe);
            out.extend_from_slice(&(n as u32).to_le_bytes());
        }
        _ => {
            out.push(0xff);
            out.extend_from_slice(&n.to_le_bytes());
        }
    }
}

/// 서명하는 쪽 — 레이븐코인 키 하나. 주소·공개키는 여기서 나온다.
pub struct RvnSigner {
    sk: SecretKey,
    /// 압축 공개키 33바이트 hex(66자, 02/03).
    pub pubkey: String,
    /// `R…` 메인넷 P2PKH 주소.
    pub address: String,
}

impl RvnSigner {
    pub fn new(secret: &[u8; 32]) -> Result<Self, String> {
        let sk = SecretKey::from_byte_array(secret).map_err(|e| format!("지도 서명 열쇠가 올바르지 않습니다: {e}"))?;
        let pk = PublicKey::from_secret_key(&Secp256k1::signing_only(), &sk).serialize();
        let address = crate::words::base58check(crate::words::MAINNET, &crate::words::ripemd160(&Sha256::digest(pk)));
        Ok(RvnSigner { sk, pubkey: hex::encode(pk), address })
    }

    /// 64바이트 r‖s(low-S, RFC6979 결정적) → 표준 base64.
    pub fn sign(&self, msg: &str) -> String {
        let m = Message::from_digest(rvn_message_hash(msg));
        let sig = Secp256k1::signing_only().sign_ecdsa(&m, &self.sk);
        crate::cert_assets::b64_encode(&sig.serialize_compact())
    }
}

/// 이름표 content(JSON 문자열). 키 순서는 폰 `signMerchant` 결과 + `pubkey` 와 같게 둔다
/// (폰은 순서를 안 보지만, 같게 두면 시험 벡터의 id 까지 맞춰 볼 수 있다).
fn card_content(c: &Card, signer: &RvnSigner, signature: &str) -> String {
    let mut m = Map::new();
    m.insert("kind".into(), json!(CARD_FORMAT));
    m.insert("slug".into(), json!(c.slug));
    m.insert("name".into(), json!(c.name));
    m.insert("category".into(), json!(c.category));
    m.insert("area".into(), json!(c.area));
    m.insert("createdAt".into(), json!(c.created_at));
    if let Some(ct) = &c.contact {
        m.insert("contact".into(), json!(ct));
    }
    if let Some(u) = &c.shop_url {
        m.insert("shopUrl".into(), json!(u));
    }
    m.insert("issuer".into(), json!(signer.address));
    m.insert("signature".into(), json!(signature));
    m.insert("pubkey".into(), json!(signer.pubkey));
    serde_json::to_string(&Value::Object(m)).unwrap_or_default()
}

/// 가게 id(= `d` 태그) — `issuer/slug`. 주소가 들어 있어 남이 덮어쓸 수 없다.
pub fn merchant_id(issuer: &str, slug: &str) -> String {
    format!("{issuer}/{slug}")
}

/// 이름표 이벤트 — 검사 → 안쪽 서명 → 겉봉투 서명. 틀린 칸이 있으면 **첫 문제**로 거절.
pub fn build_card_event(card: &Card, signer: &RvnSigner, nostr_sk: &[u8; 32]) -> Result<Value, String> {
    let c = card.normalized();
    if let Some(p) = card_problems(&c).first() {
        return Err((*p).to_string());
    }
    let signature = signer.sign(&card_message(&c, &signer.address));
    let content = card_content(&c, signer, &signature);
    let tags = json!([
        ["d", merchant_id(&signer.address, &c.slug)],
        ["t", CARD_TAG],
        ["g", c.area]
    ]);
    crate::shopkey::sign_with(nostr_sk, CARD_NOSTR_KIND, tags, &content, c.created_at)
}

/// 영업 중 신호 이벤트. `g` 에는 **이름표와 같은 5자리**를 넣는다(폰은 9칸을 g 로 찾는다).
pub fn build_beat_event(
    signer: &RvnSigner,
    nostr_sk: &[u8; 32],
    slug: &str,
    area: &str,
    at: i64,
    open_items: Option<u32>,
) -> Result<Value, String> {
    if !is_slug(slug) {
        return Err("가게 주소 이름은 영문 소문자·숫자·- 로 2~40자여야 해요.".into());
    }
    if !is_area(area) {
        return Err("동네는 5자리 지역 코드만 쓸 수 있어요. 정확한 위치는 받지 않아요.".into());
    }
    if at <= 0 {
        return Err("시각이 올바르지 않아요.".into());
    }
    if open_items.is_some_and(|n| n > 100_000) {
        return Err("열린 상품 수가 올바르지 않아요.".into());
    }
    let signature = signer.sign(&beat_message(&signer.address, slug, at, open_items));
    let mut m = Map::new();
    m.insert("kind".into(), json!(BEAT_FORMAT));
    m.insert("issuer".into(), json!(signer.address));
    m.insert("slug".into(), json!(slug));
    m.insert("at".into(), json!(at));
    if let Some(n) = open_items {
        m.insert("openItems".into(), json!(n));
    }
    m.insert("signature".into(), json!(signature));
    m.insert("pubkey".into(), json!(signer.pubkey));
    let content = serde_json::to_string(&Value::Object(m)).unwrap_or_default();
    let tags = json!([
        ["d", merchant_id(&signer.address, slug)],
        ["t", BEAT_TAG],
        ["g", area]
    ]);
    crate::shopkey::sign_with(nostr_sk, BEAT_NOSTR_KIND, tags, &content, at)
}

/// 「닫힘」 — NIP-09 지우기(kind 5)로 우리 신호(·이름표)를 거둔다.
///
/// 폰 형식에는 「닫힘」 이벤트가 따로 없다(신호가 10분 넘게 없으면 쉬는 중). 그냥
/// 멈추면 손님 지도는 최대 10분 동안 「영업 중」으로 남는다. 지우기를 지키는 릴레이
/// (damus·nos.lol 은 지킨다)에서는 곧바로 신호가 사라져 「쉬는 중」이 된다.
/// 폰은 kind 5 를 읽지 않으므로 형식과 부딪히지 않는다.
pub fn build_delete_event(nostr_sk: &[u8; 32], nostr_pubkey: &str, issuer: &str, slug: &str, with_card: bool, at: i64) -> Result<Value, String> {
    let d = merchant_id(issuer, slug);
    let mut tags = vec![
        json!(["a", format!("{BEAT_NOSTR_KIND}:{nostr_pubkey}:{d}")]),
        json!(["k", BEAT_NOSTR_KIND.to_string()]),
    ];
    if with_card {
        tags.push(json!(["a", format!("{CARD_NOSTR_KIND}:{nostr_pubkey}:{d}")]));
        tags.push(json!(["k", CARD_NOSTR_KIND.to_string()]));
    }
    crate::shopkey::sign_with(nostr_sk, DELETE_KIND, Value::Array(tags), "", at)
}

/// 가게 주소 이름(slug) 제안 — 체인 이름(`SHOP.GANGNAM_CAFE` → `gangnam-cafe`)에서, 없으면 `shop`.
/// 한 번 올린 뒤에는 **바꾸지 않는다**(가게 id 가 바뀌면 지도에 가게가 둘로 보인다).
pub fn suggest_slug(chain_asset: &str) -> String {
    let base = chain_asset.trim();
    let base = base.strip_prefix("SHOP.").or_else(|| base.strip_prefix("shop.")).unwrap_or(base);
    let mut s = String::new();
    for c in base.chars() {
        let c = c.to_ascii_lowercase();
        if c.is_ascii_lowercase() || c.is_ascii_digit() {
            s.push(c);
        } else if !s.ends_with('-') && !s.is_empty() {
            s.push('-');
        }
        if s.len() >= 40 {
            break;
        }
    }
    let s = s.trim_end_matches('-').to_string();
    if is_slug(&s) { s } else { "shop".into() }
}

/// 지도 서명 열쇠 두 개를 가게 열쇠에서 뽑는다 — (레이븐코인 안쪽, Nostr 겉봉투).
///
/// 🔴 왜 지갑 주소(`signmessage`)가 아닌가:
///    ① 신호는 **5분마다** 서명한다. 지갑에 암호가 걸려 있으면 그때마다 암호를
///       물어야 하고, 그러면 아무도 안 쓴다. ② 코어 서명은 65바이트라 폰 형식과 다르다.
///    ③ 지갑 열쇠를 심장 박동에 쓰면 금고 열쇠가 하루 288번 밖에 나간다.
///    그래서 가게 열쇠(`shopkey.json`, 12단어에서 나옴 · 백업에 들어감)에서 **표식을
///    붙여 따로** 뽑는다. 같은 가게 열쇠면 언제나 같은 주소가 나와 지도 id 가 유지된다.
/// ⚠️ 표식 문자열은 **절대 바꾸지 마라.** 바꾸면 지도 위 가게 id 가 바뀐다.
pub const MAP_RVN_TAG: &str = "PLAYX-RAVEN-MAPKEY-v1";
pub const MAP_NOSTR_TAG: &str = "PLAYX-RAVEN-MAPNOSTR-v1";

pub fn derive_map_keys(shop_secret: &[u8; 32]) -> ([u8; 32], [u8; 32]) {
    let d = |tag: &str| -> [u8; 32] {
        let mut h = Sha256::new();
        h.update(tag.as_bytes());
        h.update(shop_secret);
        h.finalize().into()
    };
    (d(MAP_RVN_TAG), d(MAP_NOSTR_TAG))
}

#[cfg(test)]
mod tests {
    use super::*;

    const VEC_ISSUER: &str = "RMem8GvhCRTBMi7Gr1ZaC4xfEr1RFCRBbR";
    const VEC_RVN_PUB: &str = "03d793631af7aa0e709439dd47fc001acd0b0727670b6670ea528ac83cb0127f4a";
    const VEC_NOSTR_PUB: &str = "57eb3638f51f4dc5c8d5a7324b47df99e816cfcc5b5eb1245bc8c98029f9e674";

    fn vec_card() -> Card {
        Card {
            slug: "playx-gym".into(),
            name: "PLAY X 체육관".into(),
            category: "fitness".into(),
            area: "wydk3".into(),
            contact: Some("031-421-8585".into()),
            shop_url: Some("https://shop.example.com/playx".into()),
            created_at: 1_790_000_000,
        }
    }

    /// 🔴 폰 문서 §4 시험 벡터 — 주소·공개키·서명 대상·안쪽 서명·이벤트 id 가 **한 글자까지** 같아야 한다.
    #[test]
    fn merchant_card_matches_the_phone_vector() {
        let signer = RvnSigner::new(&[0x15; 32]).unwrap();
        assert_eq!(signer.address, VEC_ISSUER);
        assert_eq!(signer.pubkey, VEC_RVN_PUB);
        let c = vec_card();
        assert_eq!(
            card_message(&c, &signer.address),
            "[\"rv.merchant/1\",\"RMem8GvhCRTBMi7Gr1ZaC4xfEr1RFCRBbR\",\"playx-gym\",\"PLAY X 체육관\",\"fitness\",\"wydk3\",\"031-421-8585\",\"https://shop.example.com/playx\",1790000000]"
        );
        let ev = build_card_event(&c, &signer, &[0x17; 32]).unwrap();
        assert_eq!(ev["pubkey"], VEC_NOSTR_PUB);
        assert_eq!(ev["kind"], 31402);
        assert_eq!(ev["created_at"], 1_790_000_000);
        assert_eq!(ev["tags"], json!([["d", format!("{VEC_ISSUER}/playx-gym")], ["t", "ravenvault-merchant"], ["g", "wydk3"]]));
        let content: Value = serde_json::from_str(ev["content"].as_str().unwrap()).unwrap();
        assert_eq!(content["signature"], "3AUBN2tI0gLyhHirCrFc9L58QEPGF4+0qJNamZYfAJBB+AenTcoHslb4e2ilgoFQCuERlWTN+rr66Crs2SbOvQ==");
        assert_eq!(content["pubkey"], VEC_RVN_PUB);
        // content 키 순서까지 같게 만들었으므로 id 도 같다(sig 는 보조 난수 차이로 다를 수 있다).
        assert_eq!(ev["id"], "24ef603a0435ef2520b0fec902f717e668b20b48b0742ef1df354f294eda5a91");
    }

    #[test]
    fn presence_matches_the_phone_vector() {
        let signer = RvnSigner::new(&[0x15; 32]).unwrap();
        assert_eq!(
            beat_message(&signer.address, "playx-gym", 1_790_000_300, Some(12)),
            "[\"rv.shop-presence/1\",\"RMem8GvhCRTBMi7Gr1ZaC4xfEr1RFCRBbR\",\"playx-gym\",1790000300,12]"
        );
        assert!(beat_message(&signer.address, "playx-gym", 1, None).ends_with(",1,null]"), "없으면 null");
        let ev = build_beat_event(&signer, &[0x17; 32], "playx-gym", "wydk3", 1_790_000_300, Some(12)).unwrap();
        let content: Value = serde_json::from_str(ev["content"].as_str().unwrap()).unwrap();
        assert_eq!(content["signature"], "/iaSgFq7hTEviLLv1bEHHZD2toITVw6/x01KWSfJArEyRhB4ueFLMfujBH5vnL8zDrNTZpxbVHE6dmuiThx1cw==");
        assert_eq!(ev["kind"], 31403);
        assert_eq!(ev["tags"], json!([["d", format!("{VEC_ISSUER}/playx-gym")], ["t", "ravenvault-presence"], ["g", "wydk3"]]));
        assert_eq!(ev["id"], "ca650c5d8d12fc6d8dfbde05a35d11d5db6df24f905d16b2743377387ea3caef");
    }

    /// 빈 선택 칸은 키째 빠진다 — 빈 문자열을 넣으면 폰이 거절한다.
    #[test]
    fn empty_optional_fields_are_left_out() {
        let signer = RvnSigner::new(&[0x15; 32]).unwrap();
        let mut c = vec_card();
        c.contact = Some("  ".into());
        c.shop_url = None;
        let ev = build_card_event(&c, &signer, &[0x17; 32]).unwrap();
        let content: Value = serde_json::from_str(ev["content"].as_str().unwrap()).unwrap();
        assert!(content.get("contact").is_none() && content.get("shopUrl").is_none());
        let ev = build_beat_event(&signer, &[0x17; 32], "playx-gym", "wydk3", 5, None).unwrap();
        assert!(!ev["content"].as_str().unwrap().contains("openItems"));
    }

    /// 🔴 정확한 위치는 거절한다 — 잘라 주지 않는다.
    #[test]
    fn exact_location_is_refused_not_trimmed() {
        let signer = RvnSigner::new(&[0x15; 32]).unwrap();
        for bad in ["wydk3b", "wydk", "WYDK3", "wydka", "37.3448,126.9683"] {
            let mut c = vec_card();
            c.area = bad.into();
            assert!(build_card_event(&c, &signer, &[0x17; 32]).is_err(), "{bad}");
            assert!(build_beat_event(&signer, &[0x17; 32], "playx-gym", bad, 5, None).is_err(), "{bad}");
        }
    }

    #[test]
    fn field_rules_follow_the_phone() {
        let mut c = vec_card();
        c.name = "가".repeat(41);
        assert_eq!(card_problems(&c), vec!["가게 이름은 1~40자여야 해요."]);
        c.name = "이름\u{202e}뒤집기".into();
        assert!(!card_problems(&c).is_empty(), "양방향 제어문자");
        c = vec_card();
        c.category = "bank".into();
        assert_eq!(card_problems(&c), vec!["업종을 골라 주세요."]);
        for (u, ok) in [
            ("https://a.b", true),
            ("HTTPS://shop.example.com/x?y=1", true),
            ("http://shop.example.com", false),
            ("https://localhost", false),
            ("https://.com", false),
            ("https://a.", false),
            ("https://a b.com", false),
            ("https:///a.com", false),
        ] {
            assert_eq!(is_shop_url(u), ok, "{u}");
        }
        assert!(is_slug("playx-gym") && !is_slug("a") && !is_slug("-ab") && !is_slug("Ab"));
    }

    #[test]
    fn area_table_matches_the_phone_table() {
        assert_eq!(AREAS.len(), 25);
        assert!(AREAS.iter().all(|(_, _, a)| is_area(a)));
        assert_eq!(resolve_known_area("의왕 내손동"), Some("wydk9"));
        assert_eq!(resolve_known_area("의왕내손동"), Some("wydk9"));
        assert_eq!(resolve_known_area("wydk8"), Some("wydk8"));
        assert_eq!(resolve_known_area("wydq9"), None, "표에 없는 칸은 라비가 못 고른다");
        assert_eq!(resolve_known_area("부산"), None);
    }

    #[test]
    fn slug_suggestion_is_valid() {
        assert_eq!(suggest_slug("SHOP.GANGNAM_CAFE"), "gangnam-cafe");
        assert_eq!(suggest_slug("SHOP.PLAYX"), "playx");
        assert_eq!(suggest_slug(""), "shop");
        assert_eq!(suggest_slug("가게"), "shop");
        assert!(is_slug(&suggest_slug(&"A".repeat(80))));
    }

    #[test]
    fn map_keys_are_separate_and_stable() {
        let (a, b) = derive_map_keys(&[7; 32]);
        assert_ne!(a, b);
        assert_ne!(a, [7; 32]);
        assert_eq!(derive_map_keys(&[7; 32]), (a, b));
    }

    #[test]
    fn delete_event_points_at_our_presence() {
        let ev = build_delete_event(&[0x17; 32], VEC_NOSTR_PUB, VEC_ISSUER, "playx-gym", true, 1_790_000_400).unwrap();
        assert_eq!(ev["kind"], 5);
        let tags = ev["tags"].to_string();
        assert!(tags.contains(&format!("31403:{VEC_NOSTR_PUB}:{VEC_ISSUER}/playx-gym")));
        assert!(tags.contains(&format!("31402:{VEC_NOSTR_PUB}:{VEC_ISSUER}/playx-gym")));
    }

    /// 데스크톱이 만든 이벤트를 **폰 코드가 직접** 검사하게 넘긴다.
    /// `MAP_CROSSCHECK_OUT=파일 cargo test map_format` → `node scripts/check-merchant-map.mjs 파일`.
    #[test]
    fn write_events_for_the_phone_to_check() {
        let Ok(path) = std::env::var("MAP_CROSSCHECK_OUT") else { return };
        let signer = RvnSigner::new(&[0x15; 32]).unwrap();
        let mut c = vec_card();
        c.contact = None;
        c.name = "  동네 \"과일\" 가게 🍎  ".into();
        let card = build_card_event(&c, &signer, &[0x17; 32]).unwrap();
        let beat = build_beat_event(&signer, &[0x17; 32], "playx-gym", "wydk3", 1_790_000_300, None).unwrap();
        let (rk, nk) = derive_map_keys(&[9; 32]);
        let s2 = RvnSigner::new(&rk).unwrap();
        let mut c2 = vec_card();
        c2.slug = "shop".into();
        c2.area = "wydq5".into();
        let card2 = build_card_event(&c2, &s2, &nk).unwrap();
        let beat2 = build_beat_event(&s2, &nk, "shop", "wydq5", 1_790_000_301, Some(3)).unwrap();
        std::fs::write(path, serde_json::to_string_pretty(&json!({"events": [card, beat, card2, beat2]})).unwrap()).unwrap();
    }
}
