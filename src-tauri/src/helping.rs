//! 「돕기」로 켜 둔 컴퓨터가 **남의 가게 파일을 대신 들고 있는다.**
//!
//! ## 무엇이 문제였나 (실측)
//!
//! 가게 정보(`QmQ9SC…`)를 가진 곳이 **가게 컴퓨터 하나뿐**이었다:
//!
//! ```text
//! 집 노드(8790)   200  61바이트   ← 여기만 갖고 있다
//! ipfs.io         301             ← 안 준다
//! dweb.link       000             ← 안 닿는다
//! ```
//!
//! 그래서 사장이 컴퓨터를 끄면 **세상에서 그 가게의 이름·사진·메뉴가 사라졌다.**
//! 「탈중앙 장터」라면서 실은 가게 컴퓨터 한 대에 매달려 있었던 것이다. 중앙이
//! 우리가 아니라 사장님이었을 뿐이다.
//!
//! ## 🔴 왜 우리 서버에 두는 것이 답이 아닌가
//!
//! 우리가 사본을 들고 있으면 1곳이 2곳이 될 뿐이다. **덜 나쁜 중앙**이지
//! 탈중앙이 아니다. 대표 지적이 맞다.
//!
//! 진짜 답은 **노드들이 서로 붙잡는 것**이다. 그리고 재료는 이미 다 있었다 —
//! 「돕기」로 켜 둔 컴퓨터에서 IPFS 가 이미 돌고 있는데 **아무 일도 안 하고
//! 있었다.** 「돕기」가 이름뿐이었던 것이다.
//!
//! 돕는 사람이 늘수록 장터가 튼튼해진다. 우리 서버는 없어도 된다.
//!
//! ## 어떻게 하나
//!
//! ```text
//! ① 체인에 묻는다        listassets SHOP.*  → 이름마다 ipfs_hash
//! ② 이미 갖고 있나       block/stat         → 있으면 건너뛴다
//! ③ 아무 데서나 받는다   가게 주소(릴레이 힌트) → 게이트웨이
//! ④ 🔴 해시를 대조한다   sha256(받은 것) == CID 안의 32바이트
//! ⑤ 넣고 붙잡는다        block/put → pin/add
//! ⑥ 안에 든 것도 따라간다 metadata.json·사진 (폴더만 있으면 소용없다)
//! ```
//!
//! **출처를 안 믿는 것이 전부다.** ④ 를 통과한 바이트는 누가 줬든 진짜이므로,
//! 훔쳐 온 것이든 우리 서버에서 받은 것이든 상관없다.
//!
//! ## 왜 block/put 인가 (실측으로 확인함)
//!
//! `ipfs add` 로 다시 넣으면 조각내는 방식이 달라 **다른 주소**가 나온다.
//! `block/put` 은 바이트를 그대로 넣는다. 다만 kubo 가 돌려주는 주소는
//! `bafy…`(v1) 다 — 놀랄 것 없다. 블록은 **멀티해시로** 저장되므로 원래
//! `Qm…`(v0) 주소로 그대로 꺼내진다. 이 기계에서 확인했다:
//!
//! ```text
//! block/put → bafybeia227kn7bsoxruaaec5dvr7v572wzagbmhdestqj26rituxgn6rhy
//! block/get QmQ9SC6m3JMt… → 200, 61바이트, 바이트 동일
//! ```
//!
//! ## 하지 않는 것
//!
//! **아무 CID 나 붙잡지 않는다.** 체인에 있는 자산이 가리키는 것만 받는다.
//! 그러려면 누군가 500 RVN 을 태워야 하고, 그 흔적은 체인에 영원히 남는다.
//! 남의 디스크를 쓰레기로 채우려면 **비싸고 눈에 띄어야** 한다.

use serde_json::{json, Value};
use sha2::{Digest, Sha256};

const API: &str = "http://127.0.0.1:5001/api/v0";
/// 한 번에 볼 가게 수. 늘리면 남의 컴퓨터를 오래 붙잡는다.
const MAX_SHOPS: usize = 200;
/// 한 블록의 상한. 프로필 문서가 18KB, 사진 한 장이 수백 KB다.
const MAX_BLOCK: usize = 4 * 1024 * 1024;
/// 한 자산에서 따라갈 블록 수. 폴더 안에 사진이 서른 장까지다.
const MAX_FOLLOW: usize = 40;

/* ── CIDv0 ────────────────────────────────────────────────────────────────
   `Qm…` 는 base58(0x12 0x20 ‖ sha256) 이다. 확인에 필요한 것은 sha256
   하나뿐이고 그건 이미 있다. 크레이트를 하나 더 들이지 않는다 — 이 프로그램
   에는 12단어가 있다.                                                      */

const B58: &[u8] = b"123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

fn b58_decode(s: &str) -> Option<Vec<u8>> {
    let mut out: Vec<u8> = vec![0];
    for ch in s.bytes() {
        let v = B58.iter().position(|&c| c == ch)? as u32;
        let mut carry = v;
        for b in out.iter_mut() {
            carry += (*b as u32) * 58;
            *b = (carry & 0xff) as u8;
            carry >>= 8;
        }
        while carry > 0 {
            out.push((carry & 0xff) as u8);
            carry >>= 8;
        }
    }
    for ch in s.bytes() {
        if ch != b'1' {
            break;
        }
        out.push(0);
    }
    out.reverse();
    Some(out)
}

fn b58_encode(bytes: &[u8]) -> String {
    let mut digits: Vec<u32> = vec![0];
    for &byte in bytes {
        let mut carry = byte as u32;
        for d in digits.iter_mut() {
            carry += *d << 8;
            *d = carry % 58;
            carry /= 58;
        }
        while carry > 0 {
            digits.push(carry % 58);
            carry /= 58;
        }
    }
    let mut out = String::new();
    for &b in bytes {
        if b != 0 {
            break;
        }
        out.push('1');
    }
    for d in digits.iter().rev() {
        out.push(B58[*d as usize] as char);
    }
    out
}

/// `Qm…` 안에 든 sha256 32바이트. 모양이 아니면 `None`.
fn cid_digest(cid: &str) -> Option<Vec<u8>> {
    if cid.len() != 46 || !cid.starts_with("Qm") {
        return None;
    }
    let raw = b58_decode(cid)?;
    if raw.len() != 34 || raw[0] != 0x12 || raw[1] != 0x20 {
        return None;
    }
    Some(raw[2..].to_vec())
}

/// 🔴 **이 함수가 이 파일의 전부다.** 이걸 통과한 바이트만 디스크에 넣는다.
fn verify(bytes: &[u8], cid: &str) -> bool {
    match cid_digest(cid) {
        Some(want) => {
            let got = Sha256::digest(bytes);
            // 길이가 같으니 한 바이트씩. 짧은 비교로 끝내지 않는다.
            got.len() == want.len() && got.iter().zip(want.iter()).fold(0u8, |a, (x, y)| a | (x ^ y)) == 0
        }
        None => false,
    }
}

/* ── dag-pb 를 아주 조금만 ───────────────────────────────────────────────
   폴더·파일 블록에서 **자식 CID 목록**만 꺼내면 된다. 프로토버프 전체를
   읽을 이유가 없다. PBNode { repeated PBLink Links = 2; }
   PBLink { bytes Hash = 1; }                                             */

fn varint(b: &[u8], i: &mut usize) -> Option<u64> {
    let mut n: u64 = 0;
    let mut shift = 0;
    while *i < b.len() {
        let byte = b[*i];
        *i += 1;
        n |= ((byte & 0x7f) as u64) << shift;
        if byte & 0x80 == 0 {
            return Some(n);
        }
        shift += 7;
        if shift > 63 {
            return None;
        }
    }
    None
}

/// 이 블록이 가리키는 자식 CID 들. 모르는 모양이면 빈 목록 — 지어내지 않는다.
fn child_cids(block: &[u8]) -> Vec<String> {
    let mut out = Vec::new();
    let mut i = 0usize;
    while i < block.len() {
        let key = match varint(block, &mut i) {
            Some(k) => k,
            None => break,
        };
        let (no, wire) = ((key >> 3) as u32, (key & 7) as u32);
        if wire != 2 {
            // 길이가 안 붙는 항목은 건너뛴다.
            if wire == 0 && varint(block, &mut i).is_some() {
                continue;
            }
            break;
        }
        let len = match varint(block, &mut i) {
            Some(l) => l as usize,
            None => break,
        };
        if i + len > block.len() {
            break;
        }
        let val = &block[i..i + len];
        i += len;
        if no != 2 {
            continue; // Links 만 본다
        }
        // PBLink 안의 Hash(=1)
        let mut j = 0usize;
        while j < val.len() {
            let k2 = match varint(val, &mut j) {
                Some(k) => k,
                None => break,
            };
            let (n2, w2) = ((k2 >> 3) as u32, (k2 & 7) as u32);
            if w2 != 2 {
                if w2 == 0 && varint(val, &mut j).is_some() {
                    continue;
                }
                break;
            }
            let l2 = match varint(val, &mut j) {
                Some(l) => l as usize,
                None => break,
            };
            if j + l2 > val.len() {
                break;
            }
            let h = &val[j..j + l2];
            j += l2;
            if n2 == 1 && h.len() == 34 && h[0] == 0x12 && h[1] == 0x20 {
                out.push(b58_encode(h));
            }
        }
    }
    out
}

/* ── IPFS 에게 말하기 ─────────────────────────────────────────────────── */

async fn have_block(cid: &str) -> bool {
    reqwest::Client::new()
        .post(format!("{API}/block/stat?arg={cid}"))
        .timeout(std::time::Duration::from_secs(4))
        .send()
        .await
        .map(|r| r.status().is_success())
        .unwrap_or(false)
}

/// 바이트를 **그대로** 넣는다. 조각내지 않으므로 주소가 안 바뀐다.
async fn put_block(bytes: Vec<u8>) -> bool {
    let part = reqwest::multipart::Part::bytes(bytes).file_name("b".to_string());
    let form = reqwest::multipart::Form::new().part("data", part);
    reqwest::Client::new()
        .post(format!(
            "{API}/block/put?cid-codec=dag-pb&mhtype=sha2-256&mhlen=32"
        ))
        .multipart(form)
        .timeout(std::time::Duration::from_secs(30))
        .send()
        .await
        .map(|r| r.status().is_success())
        .unwrap_or(false)
}

async fn pin(cid: &str) -> bool {
    reqwest::Client::new()
        // `recursive=false`: 자식은 우리가 이미 하나씩 넣어 뒀다. `true` 로 두면
        // kubo 가 없는 자식을 p2p 로 찾으러 나가 몇 분씩 멈춘다 — 가게가 NAT
        // 뒤에 있어서 애초에 못 찾는 바로 그 길이다.
        .post(format!("{API}/pin/add?arg={cid}&recursive=false"))
        .timeout(std::time::Duration::from_secs(20))
        .send()
        .await
        .map(|r| r.status().is_success())
        .unwrap_or(false)
}

/* ── 바이트를 어디서 구하나 ──────────────────────────────────────────── */

/// 이 CID 를 가졌을 만한 곳들. **한 곳도 안 믿는다** — 검증은 해시가 한다.
fn places(cid: &str, hints: &[String]) -> Vec<String> {
    let mut v: Vec<String> = hints
        .iter()
        .map(|h| format!("{}/ipfs/{}?format=raw", h.trim_end_matches('/'), cid))
        .collect();
    // 가게가 켜져 있으면 위에서 끝난다. 아래는 그다음이다.
    v.push(format!("https://rvn.ex.erci.se/ipfs/{cid}?format=raw"));
    v.push(format!("https://ipfs.io/ipfs/{cid}?format=raw"));
    v.push(format!("https://dweb.link/ipfs/{cid}?format=raw"));
    v
}

async fn fetch_raw(cid: &str, hints: &[String]) -> Option<Vec<u8>> {
    for url in places(cid, hints) {
        let r = reqwest::Client::new()
            .get(&url)
            .header("accept", "application/vnd.ipld.raw")
            .timeout(std::time::Duration::from_secs(8))
            .send()
            .await;
        let bytes = match r {
            Ok(x) if x.status().is_success() => x.bytes().await.ok(),
            _ => None,
        };
        if let Some(b) = bytes {
            if !b.is_empty() && b.len() <= MAX_BLOCK && verify(&b, cid) {
                return Some(b.to_vec());
            }
            // 검증에 떨어진 것은 **조용히 버린다.** 누군가 가짜를 주고 있을
            // 수도 있고, 그냥 게이트웨이가 오류 쪽지를 준 것일 수도 있다.
        }
    }
    None
}

/// 한 자산의 파일을 통째로 붙잡는다. 몇 개를 새로 받았는지 돌려준다.
async fn hold(root: &str, hints: &[String]) -> usize {
    let mut got = 0usize;
    let mut queue = vec![root.to_string()];
    let mut seen: Vec<String> = Vec::new();
    while let Some(cid) = queue.pop() {
        if seen.len() >= MAX_FOLLOW || seen.contains(&cid) {
            continue;
        }
        seen.push(cid.clone());
        // 이미 갖고 있으면 받을 필요가 없다. 다만 **안에 든 것은 따라간다** —
        // 폴더만 있고 사진이 없으면 손님 화면에서는 없는 것과 같다.
        let bytes = if have_block(&cid).await {
            fetch_local(&cid).await
        } else {
            match fetch_raw(&cid, hints).await {
                Some(b) => {
                    if put_block(b.clone()).await {
                        pin(&cid).await;
                        got += 1;
                        Some(b)
                    } else {
                        None
                    }
                }
                None => None,
            }
        };
        if let Some(b) = bytes {
            for c in child_cids(&b) {
                queue.push(c);
            }
        }
    }
    got
}

async fn fetch_local(cid: &str) -> Option<Vec<u8>> {
    let r = reqwest::Client::new()
        .post(format!("{API}/block/get?arg={cid}"))
        .timeout(std::time::Duration::from_secs(8))
        .send()
        .await
        .ok()?;
    if !r.status().is_success() {
        return None;
    }
    let b = r.bytes().await.ok()?;
    (b.len() <= MAX_BLOCK).then(|| b.to_vec())
}

/* ── 한 바퀴 ─────────────────────────────────────────────────────────── */

/// 체인에 있는 가게들의 파일을 한 바퀴 붙잡는다.
///
/// 「돕기」에서만 부른다. 장사하는 컴퓨터는 자기 것만 들고 있으면 되고,
/// 계산대 디스크를 남의 사진으로 채우면 그건 도움이 아니라 민폐다.
#[tauri::command]
pub async fn help_round() -> Result<Value, String> {
    let raw = crate::raven::call_rpc(
        "listassets",
        json!(["SHOP.*", true, MAX_SHOPS, 0]),
    )
    .await?;
    let map = raw.as_object().ok_or("체인이 목록을 주지 않았습니다.")?;

    let mut held = 0usize;
    let mut fetched = 0usize;
    let mut skipped = 0usize;
    for (name, info) in map.iter() {
        let cid = match info.get("ipfs_hash").and_then(Value::as_str) {
            Some(c) if cid_digest(c).is_some() => c.to_string(),
            // 파일을 안 붙인 가게다. 붙잡을 것이 없다.
            _ => {
                skipped += 1;
                continue;
            }
        };
        let hints = live_urls(name).await;
        let n = hold(&cid, &hints).await;
        fetched += n;
        held += 1;
    }
    Ok(json!({
        "shops": held,
        "new_blocks": fetched,
        "no_file": skipped,
        "note": if fetched > 0 {
            "이 컴퓨터가 그 가게들의 사진과 정보를 대신 들고 있습니다. 가게가 꺼져 있어도 손님이 볼 수 있습니다."
        } else {
            "새로 받을 것이 없었습니다. 이미 들고 있거나, 지금 아무 데서도 못 구합니다."
        },
    }))
}

/// 이 가게가 지금 어디서 답하는지. **안 믿는다** — 바이트를 어디서 구할지
/// 고르는 데만 쓴다. 가짜 주소를 줘도 해시에서 걸린다.
async fn live_urls(asset: &str) -> Vec<String> {
    let q = crate::nostrpub::nostr_query(vec![30078], vec![], vec![]).await;
    let mut out = Vec::new();
    if let Ok(v) = q {
        if let Some(list) = v.get("events").and_then(Value::as_array) {
            for e in list {
                let d = e
                    .get("tags")
                    .and_then(Value::as_array)
                    .and_then(|t| {
                        t.iter()
                            .find(|x| x.get(0).and_then(Value::as_str) == Some("d"))
                            .and_then(|x| x.get(1).and_then(Value::as_str))
                    })
                    .unwrap_or("");
                if !d.contains(asset) {
                    continue;
                }
                if let Some(c) = e.get("content").and_then(Value::as_str) {
                    if let Ok(j) = serde_json::from_str::<Value>(c) {
                        if let Some(u) = j.get("url").and_then(Value::as_str) {
                            if u.starts_with("https://") {
                                out.push(u.to_string());
                            }
                        }
                    }
                }
            }
        }
    }
    out.truncate(3);
    out
}

/// 테스트 자료를 읽는 데만 쓴다. 본 코드는 base64 를 안 쓴다.
#[cfg(test)]
fn b64_decode(s: &str) -> Option<Vec<u8>> {
    const T: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = Vec::new();
    let mut buf = 0u32;
    let mut bits = 0u32;
    for c in s.bytes() {
        if c == b'=' { break; }
        let v = T.iter().position(|&x| x == c)? as u32;
        buf = (buf << 6) | v;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push(((buf >> bits) & 0xff) as u8);
        }
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::{cid_digest, child_cids, verify};

    /// 실제 가게 문서의 주소. 이 기계에서 61바이트 루트 블록으로 확인했다.
    const REAL: &str = "QmQ9SC6m3JMtDyqRbRXo1TfiQBCmiu15NK8Usxfgauru8H";

    #[test]
    fn 진짜_주소는_32바이트를_준다() {
        assert_eq!(cid_digest(REAL).map(|d| d.len()), Some(32));
    }

    #[test]
    fn 주소가_아닌_것은_거른다() {
        assert!(cid_digest("").is_none());
        assert!(cid_digest("아무거나").is_none());
        assert!(cid_digest("Qm짧다").is_none());
        // CIDv1 은 안 받는다. 우리는 올릴 때 v0 을 못 박아 뒀다.
        assert!(cid_digest("bafybeia227kn7bsoxruaaec5dvr7v572wzagbmhdestqj26rituxgn6rhy").is_none());
        // 46자이지만 base58 이 아닌 글자
        assert!(cid_digest(&format!("Qm{}", "0".repeat(44))).is_none());
    }

    /// 🔴 이 파일에서 제일 중요한 시험이다. 여기가 무르면 남이 준 아무
    ///    바이트나 디스크에 들어가고, 그 순간 이 노드가 거짓말을 퍼뜨린다.
    #[test]
    fn 다른_바이트는_통과_못_한다() {
        assert!(!verify(b"", REAL));
        assert!(!verify(b"aaaa", REAL));
        assert!(!verify(&[0u8; 61], REAL), "길이만 같은 것도 안 된다");
    }

    #[test]
    fn 빈_블록에서_자식을_지어내지_않는다() {
        assert!(child_cids(&[]).is_empty());
        assert!(child_cids(b"not protobuf at all").len() < 3, "쓰레기에서 주소를 만들어 내면 안 된다");
    }
}

#[cfg(test)]
mod real_block {
    use super::child_cids;

    /// 🔴 **진짜 블록으로 확인한다.** 프로토버프를 손으로 읽는 코드라,
    ///    「테스트는 통과하는데 실제 블록에선 아무것도 못 찾는」 일이
    ///    제일 무섭다. 이 61바이트는 `SHOP.PLAYX` 의 실제 루트 폴더다.
    #[test]
    fn 진짜_폴더에서_자식을_찾는다() {
        let b64 = include_str!("../testdata/shop-root.b64");
        let bytes = super::b64_decode(b64.trim()).expect("테스트 자료가 깨졌습니다");
        let kids = child_cids(&bytes);
        assert_eq!(kids.len(), 1, "폴더 안에 metadata.json 하나다. 실제: {kids:?}");
        assert!(kids[0].starts_with("Qm"), "자식도 CIDv0 여야 한다: {}", kids[0]);
        assert_eq!(kids[0].len(), 46);
    }
}
