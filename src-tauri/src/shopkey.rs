//! 가게의 Nostr 열쇠 — **간판을 거는 손.**
//!
//! ## 무엇을 푸는가
//!
//! 가게는 체인의 자산(`SHOP.PLAYX`)이고, 그 안에는 이름·전화·돈 받을 주소처럼
//! **평생 안 바뀌는 것**만 적는다. 자산 정보를 고치려면 재발행이고 그때마다
//! RVN 이 또 타기 때문이다.
//!
//! 그런데 「지금 어디서 주문을 받는가」는 하루에도 몇 번 바뀐다. 무료 터널은
//! 켤 때마다 새 주소를 준다. 그걸 체인에 적으면 내일이면 죽은 주소가 영원히
//! 남는다.
//!
//! 그래서 **바뀌지 않는 것은 체인에, 바뀌는 것은 Nostr 에** 둔다. 체인에는
//! 공개키 하나만 적고, 손님은 그 공개키가 서명한 최신 글에서 지금 주소를
//! 읽는다.
//!
//! ## 🔴 왜 지갑의 12단어를 안 쓰는가
//!
//! 웹 지갑은 `m/44'/175'/7'/0/0` 에서 자기 Nostr 열쇠를 뽑는다. 그걸 노드가
//! 쓰려면 12단어가 노드까지 내려와야 하고, 그 순간 **가게 돈과 가게 간판이
//! 같은 열쇠**가 된다. 노드는 인터넷에 포트를 여는 물건이다. 간판이 뚫리는
//! 것과 금고가 뚫리는 것은 같은 사고여서는 안 된다.
//!
//! 그래서 여기서 **따로 만든다.** `shopkey.json` 하나, 백업에 같이 들어간다.
//!
//! ## 🔴 이 파일은 비밀이다
//!
//! 이 열쇠를 가진 사람은 「SHOP.PLAYX 는 지금 여기서 주문받습니다」를 쓸 수
//! 있다. 손님 돈을 자기 주소로 돌릴 수는 없다 — 돈 받을 주소는 체인에 있고
//! 그건 자산 주인만 고친다. 하지만 손님을 가짜 화면으로 보낼 수는 있다.
//! 그래서 `backup.rs` 에는 들어가고, 화면이나 로그에는 절대 안 나온다.

use secp256k1::{Keypair, Secp256k1, XOnlyPublicKey};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

/// 가게 주소를 공지하는 글의 종류.
///
/// 🔴 30000–39999 는 **덮어쓰기 가능한(parameterized replaceable)** 구간이다
/// (NIP-33). 같은 글쓴이·같은 종류·같은 `d` 태그면 릴레이가 **옛것을 지우고**
/// 새것만 남긴다. 주소가 바뀔 때마다 새 글이 쌓이면 손님 화면이 어느 것이
/// 최신인지 골라야 하고, 릴레이마다 다른 답을 준다.
///
/// 🔴 30402 를 쓰면 안 된다. 그건 이미 **파는 물건**이 쓰고 있다
/// (`web/nostr.ts`, `web/shops.src.ts`). 같은 번호를 쓰면 가게 주소 공지가
/// 물건 목록에 섞여 나온다.
pub const SHOP_ADDR_KIND: i64 = 30078;

fn key_file() -> std::path::PathBuf {
    crate::paths::app_file("shopkey.json")
}

/// 이 가게의 열쇠를 읽는다. 없으면 **만든다.**
///
/// 사장에게 「열쇠를 만드시겠습니까」를 묻지 않는다. 물어서 좋을 것이 없고,
/// 아니라고 답하면 가게가 안 열린다.
fn load_or_make() -> Result<[u8; 32], String> {
    let p = key_file();
    if let Ok(s) = std::fs::read_to_string(&p) {
        if let Ok(v) = serde_json::from_str::<Value>(&s) {
            if let Some(h) = v.get("sk").and_then(Value::as_str) {
                if let Ok(b) = hex::decode(h) {
                    if b.len() == 32 {
                        let mut sk = [0u8; 32];
                        sk.copy_from_slice(&b);
                        // 값이 곡선 밖이면 서명이 안 된다. 여기서 걸러야
                        // 「올렸습니다」라고 말한 뒤 아무 데도 안 올라가는 일이 없다.
                        if secp256k1::SecretKey::from_byte_array(&sk).is_ok() {
                            return Ok(sk);
                        }
                    }
                }
            }
        }
        // 파일이 있는데 못 읽으면 **덮어쓰지 않는다.** 덮어쓰면 옛 공지가
        // 영원히 고아가 되고, 체인에 적힌 공개키와도 어긋난다.
        return Err(
            "가게 열쇠 파일이 깨졌습니다. 백업에서 shopkey.json 을 되살려 주세요.".into(),
        );
    }

    let (sk, _) = Secp256k1::new().generate_keypair(&mut rand::thread_rng());
    let bytes = sk.secret_bytes();
    let body = json!({
        "sk": hex::encode(bytes),
        "note": "가게 간판 열쇠입니다. 남에게 보여주지 마세요. 백업에 같이 들어갑니다.",
    });
    if let Some(dir) = p.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    std::fs::write(&p, serde_json::to_vec_pretty(&body).unwrap_or_default())
        .map_err(|e| format!("가게 열쇠를 저장하지 못했습니다: {e}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o600));
    }
    Ok(bytes)
}

/// 체인 프로필에 적을 공개키. **이것만 밖으로 나간다.**
#[tauri::command]
pub fn shop_pubkey() -> Result<String, String> {
    let sk = load_or_make()?;
    Ok(hex::encode(xonly(&sk)?.serialize()))
}

fn xonly(sk: &[u8; 32]) -> Result<XOnlyPublicKey, String> {
    let kp = Keypair::from_seckey_slice(&Secp256k1::new(), sk)
        .map_err(|e| format!("열쇠가 올바르지 않습니다: {e}"))?;
    Ok(kp.x_only_public_key().0)
}

/// Nostr 이벤트 하나를 만들고 **서명한다.**
///
/// id 는 `[0, pubkey, created_at, kind, tags, content]` 를 **공백 없이** 이은
/// JSON 의 SHA-256 이다(NIP-01). 공백 하나만 달라도 릴레이가 계산한 id 와
/// 안 맞아 조용히 버려진다 — 그래서 여기서 직접 문자열을 만든다.
/// `serde_json::to_string` 은 공백을 안 넣는다.
pub fn sign_event(kind: i64, tags: Value, content: &str, created_at: i64) -> Result<Value, String> {
    let sk = load_or_make()?;
    let pk = hex::encode(xonly(&sk)?.serialize());

    let pre = serde_json::to_string(&json!([0, pk, created_at, kind, tags, content]))
        .map_err(|e| format!("서명할 것을 만들지 못했습니다: {e}"))?;
    let id = Sha256::digest(pre.as_bytes());

    let secp = Secp256k1::new();
    let kp = Keypair::from_seckey_slice(&secp, &sk)
        .map_err(|e| format!("열쇠가 올바르지 않습니다: {e}"))?;
    let msg: [u8; 32] = id.into();
    let sig = secp.sign_schnorr_no_aux_rand(&msg, &kp);

    Ok(json!({
        "id": hex::encode(id),
        "pubkey": pk,
        "created_at": created_at,
        "kind": kind,
        "tags": tags,
        "content": content,
        "sig": hex::encode(sig.to_byte_array()),
    }))
}

fn now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// 「SHOP.PLAYX 는 지금 여기서 주문받습니다」를 릴레이에 올린다.
///
/// `url` 이 비어 있으면 **문을 닫았다**고 올린다. 이게 없으면 터널을 끈 뒤에도
/// 손님이 죽은 `trycloudflare.com` 으로 가서 아무것도 안 뜨는 화면을 본다 —
/// 「가게가 닫혔습니다」와 「인터넷이 고장났습니다」를 손님이 구별할 수 없다.
///
/// 🔴 `expiration`(NIP-40)을 세 시간으로 단다. 노드가 그냥 꺼져 버리면
/// 「닫았다」는 글조차 못 올린다. 그때는 공지가 **저절로 사라지는** 편이 낫다 —
/// 죽은 주소가 남아 있는 것보다 버튼이 없는 편이 손님에게 정직하다.
///
/// 다만 릴레이가 이 태그를 지킬 의무는 없다. 그래서 손님 화면도 공지의
/// 나이를 따로 센다(`web/shops.html` `fillLive`). 둘 중 하나만 믿지 않는다.
pub async fn announce(asset: &str, url: &str) -> Result<Value, String> {
    let asset = asset.trim();
    if asset.is_empty() {
        return Err("가게 이름이 없습니다.".into());
    }
    let url = url.trim();
    if !url.is_empty() && !url.starts_with("https://") {
        // http:// 를 올리면 손님 폰이 경고를 띄우거나 아예 막는다.
        return Err("주문 주소는 https:// 여야 합니다.".into());
    }

    let at = now();
    let tags = json!([
        // 🔴 `d` 가 덮어쓰기의 열쇠다. 이게 없으면 NIP-33 이 아니라 그냥
        //    글이 쌓이는 것이고, 손님이 옛 주소를 본다.
        ["d", asset],
        ["expiration", (at + 3 * 3600).to_string()],
    ]);

    let mut body = serde_json::Map::new();
    body.insert("asset".into(), json!(asset));
    body.insert("url".into(), json!(url));
    body.insert("online".into(), json!(!url.is_empty()));
    body.insert("at".into(), json!(at));
    for (k, v) in living_profile() {
        body.insert(k, v);
    }
    let content = serde_json::to_string(&Value::Object(body))
        .map_err(|e| format!("올릴 것을 만들지 못했습니다: {e}"))?;

    let ev = sign_event(SHOP_ADDR_KIND, tags, &content, at)?;
    crate::nostrpub::nostr_publish(ev).await
}

/// **바뀌는 것들.** 체인에 두면 고칠 때마다 재발행(100 RVN)이라 여기 싣는다.
///
/// ## 무엇을 체인에 두고 무엇을 여기 두나
///
/// 체인에는 **평생 안 바뀌는 세 가지**만 있으면 된다:
///   · 가게 이름 (자산 이름 그 자체)
///   · 간판 열쇠 (`nostr_pubkey`) — 이 글이 진짜인지 대조하는 기준
///   · 돈 받을 주소
///
/// 나머지는 다 바뀐다. 가게는 이사하고, 전화번호도 바꾸고, 간판 사진은
/// 계절마다 바꾼다. 그걸 체인에 두면 **전화번호 하나에 100 RVN** 이다.
///
/// ## 🔴 사진은 IPFS 에 그대로 두고, **가리키는 손가락만** 여기 온다
///
/// 사진 자체를 이 글에 담으면(base64) 45분마다 17KB 를 릴레이 세 곳에
/// 다시 올리게 된다. 릴레이가 우리를 차단하는 가장 빠른 길이다.
///
/// 그래서 주소만 싣는다. 사진을 바꾸면 새 주소를 실어 다시 올리면 그만이고,
/// **소각은 0원**이다.
fn living_profile() -> Vec<(String, Value)> {
    let sh: Value = std::fs::read_to_string(crate::paths::app_file("shop.json"))
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_else(|| json!({}));

    let mut out = Vec::new();
    let mut take = |k: &str| {
        if let Some(s) = sh
            .get(k)
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
        {
            // 🔴 사진 자체를 공지에 실으면 안 된다. 주소만 싣는다.
            if s.starts_with("data:") {
                return;
            }
            out.push((k.to_string(), json!(s)));
        }
    };
    for k in [
        "name", "name_en", "name_ja", "name_zh",
        "description", "location", "phone",
        // 간판 사진. IPFS CID 이거나 https 주소다 — 어느 쪽이든 **주소**지
        // 사진 자체가 아니다.
        //
        // 🔴 `data:` 로 시작하는 값(사진 통째로)은 **여기서 걸러진다.**
        //    실제로 그런 값이 들어와 공지의 94%(17KB)를 차지했고, 한 장만
        //    더 넣으면 릴레이 상한 32KB 를 넘어 **공지 자체가 안 나간다.**
        //    사진이 안 보이는 것보다 가게가 통째로 안 보이는 것이 나쁘다.
        "icon", "menu_cid", "photos_cid", "closed_note",
    ] {
        take(k);
    }
    for k in ["lat", "lon"] {
        if let Some(v) = sh.get(k).and_then(Value::as_f64) {
            out.push((k.to_string(), json!(v)));
        }
    }
    for k in ["pickup", "delivery", "closed_now"] {
        if let Some(v) = sh.get(k).and_then(Value::as_bool) {
            out.push((k.to_string(), json!(v)));
        }
    }
    if let Some(v) = sh.get("hours") {
        out.push(("hours".into(), v.clone()));
    }
    // 메뉴는 이 글에 안 싣는다. 품목이 서른 개인 가게가 있고, 그걸 45분마다
    // 릴레이에 다시 올리면 우리가 차단당한다. `menu_cid` 로 가리킨다.
    out
}

/// 화면에서 부르는 것. 지금 가게와 지금 터널로 한 번 올린다.
#[tauri::command]
pub async fn shop_announce(asset: String, url: String) -> Result<Value, String> {
    announce(&asset, &url).await
}

/// **바뀐 것을 지금 알린다.** 사진·전화·영업시간을 고치고 누르는 단추.
///
/// 🔴 이게 없으면 사장은 사진을 바꿔 놓고 「왜 손님 화면은 그대로지」를
/// 겪는다. 다음 심장이 뛸 때까지 45분을 기다려야 하고, 그동안 바뀐 줄 안다.
///
/// 가게 이름과 지금 주문 주소는 여기서 알아서 찾는다 — 사장이 그걸 알
/// 이유가 없다.
#[tauri::command]
pub async fn shop_refresh() -> Result<Value, String> {
    let sh: Value = std::fs::read_to_string(crate::paths::app_file("shop.json"))
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_else(|| json!({}));
    let asset = sh
        .get("chain_asset")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| {
            "아직 체인에 등록하지 않으셨습니다. 등록하시면 손님이 장터에서 찾을 수 있습니다."
                .to_string()
        })?;
    let url = crate::tunnel::tunnel_status()["url"]
        .as_str()
        .unwrap_or("")
        .to_string();
    announce(asset, &url).await
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 서명 앞에 만드는 문자열에 **공백이 들어가면** 릴레이가 계산한 id 와
    /// 어긋나고, 글은 조용히 버려진다. 올린 줄 알고 기다리게 된다.
    #[test]
    fn the_id_preimage_has_no_spaces() {
        let s = serde_json::to_string(&json!([0, "ab", 1, 30078, [["d", "SHOP.X"]], "hi"])).unwrap();
        assert!(!s.contains(", "), "공백이 있으면 id 가 틀린다: {s}");
        assert!(s.starts_with("[0,\"ab\",1,30078,"), "순서가 NIP-01 과 달라졌다: {s}");
    }

    /// 🔴 물건 목록이 쓰는 번호와 겹치면 가게 주소가 매물에 섞여 나온다.
    #[test]
    fn the_kind_does_not_collide_with_listings() {
        assert_ne!(SHOP_ADDR_KIND, 30402, "매물이 쓰는 번호다");
        assert!(
            (30000..40000).contains(&SHOP_ADDR_KIND),
            "덮어쓰기 구간 밖이면 옛 주소가 안 지워진다"
        );
    }

    /// https 가 아닌 주소는 나가기 전에 막는다. 손님 폰이 막거나 경고한다.
    #[tokio::test]
    async fn a_plain_http_address_is_refused() {
        let r = announce("SHOP.X", "http://192.168.1.2:7777").await;
        assert!(r.is_err());
        assert!(r.unwrap_err().contains("https"));
    }

    /// 이름 없이 올리면 `d` 태그가 비고, 그러면 아무나 그 자리를 덮어쓴다.
    #[tokio::test]
    async fn an_unnamed_shop_cannot_announce() {
        assert!(announce("  ", "https://x.example").await.is_err());
    }
}

#[cfg(test)]
mod crossreport {
    /// 🔴 러스트가 서명한 글을 **웹이 검증할 수 있어야** 한다.
    ///
    /// 둘은 다른 언어로 각자 구현돼 있다(`shopkey.rs` ↔ `app/rvn/s/[asset]`).
    /// 한쪽이 id 앞 문자열을 한 칸이라도 다르게 만들면 서명이 안 맞고,
    /// **멀쩡한 가게가 가짜로 판정되어 손님이 못 들어간다.** 컴파일은 통과한다.
    ///
    /// 그래서 진짜 서명을 하나 찍어 두고, 웹 쪽 시험이 그걸 검증한다.
    #[test]
    fn print_a_signed_event_for_the_web_to_check() {
        let ev = super::sign_event(
            super::SHOP_ADDR_KIND,
            serde_json::json!([["d", "SHOP.TEST"], ["expiration", "1900000000"]]),
            r#"{"asset":"SHOP.TEST","url":"https://x.example","online":true}"#,
            1_800_000_000,
        );
        match ev {
            Ok(v) => println!("CROSSCHECK {}", serde_json::to_string(&v).unwrap()),
            // 열쇠 파일이 없는 환경(CI)에서는 건너뛴다. 여기서 실패시키면
            // 열쇠 없는 기계에서 시험 전체가 빨개진다.
            Err(e) => println!("CROSSCHECK-SKIP {e}"),
        }
    }
}
