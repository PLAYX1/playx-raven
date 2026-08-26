//! **이 컴퓨터가 릴레이다.**
//!
//! ## 왜 우리가 돌리나
//!
//! 여태 남의 릴레이 세 곳(damus·nos.lol·primal)에 **올리기만** 했다. 그건
//! 남의 호의로 도는 것이고, 언제든 우리를 차단하거나 문을 닫을 수 있다.
//! 그때 모든 가게가 한꺼번에 장터에서 사라진다.
//!
//! 이 프로그램은 이미 노드이고 파일창고이고 계산대다. 릴레이 하나가 더
//! 붙으면 **가게가 늘수록 그물이 촘촘해진다** — 그게 이 판을 벌인 이유다.
//!
//! ## 🔴 NAT 뒤에서 어떻게 되나 — 처음엔 안 된다고 생각했다
//!
//! 릴레이는 바깥에서 **들어오는** 연결을 받아야 한다. 가게 컴퓨터는 공유기
//! 뒤에 있으니 안 된다고 판단했었다. 실제로 IPFS 가 정확히 그 이유로
//! 실패했다(ipfs.io 504, p2p-circuit 붙어 있어도 안 됨).
//!
//! 그런데 **우리에게는 이미 터널이 있다.** 「바깥에서 열기」를 켜면
//! `https://xxx.trycloudflare.com` 이 이 컴퓨터로 이어지고, Cloudflare 는
//! 웹소켓을 그대로 통과시킨다. 그러면 `wss://xxx.trycloudflare.com/relay`
//! 가 진짜 릴레이 주소가 된다.
//!
//! 터널을 안 켠 가게는 **가게 안에서만** 릴레이다(같은 와이파이). 그것도
//! 쓸모가 있다 — 인터넷이 끊겨도 가게 안에서는 공지가 돈다.
//!
//! ## 무엇을 지원하나
//!
//! Nostr 릴레이의 최소한(NIP-01)이다. `EVENT` 로 받고 `REQ` 로 준다.
//! 남의 릴레이를 대신하는 것이 아니라 **한 겹 더 두는 것**이라, 없는 기능은
//! 없다고 두고 있는 기능만 정확히 한다.
//!
//! ## 🔴 아무 글이나 받지 않는다
//!
//! 열어 두면 세상의 모든 Nostr 글이 이 컴퓨터로 쏟아진다. 가게 계산대는
//! 그런 것을 감당할 컴퓨터가 아니다. **가게에 관한 종류만** 받는다.

use axum::extract::ws::{Message, WebSocket};
use serde_json::{json, Value};
use std::sync::Mutex;

/// 우리가 받는 글의 종류.
///
/// 🔴 이 목록이 없으면 세상의 모든 글이 들어온다. 가게 계산대 컴퓨터에
/// 남의 소셜 타임라인을 저장할 이유가 없다.
///
///   30078 — 가게가 「지금 여기서 주문받습니다」를 올리는 글
///   30402 — 파는 물건(NIP-99). 장터의 물건 탭이 읽는다.
///      40 — 방 만들기 (NIP-28)
///      42 — 방에 쓴 글 (NIP-28)
///       1 — 사람 글
///
/// ## 🔴 왜 대화가 여기 들어왔나 — 그리고 왜 아무 글이나 안 받나
///
/// 대표님: "전세계 사람들이 원하는 방에서 대화도 가능해야지.
/// 이건 레이븐코인을 기반으로 하는 내용들만 저장해 두면 되지 않을까?"
///
/// 그 한 문장이 이 파일의 가장 어려운 문제를 풀었다. 가게 계산대 컴퓨터에
/// **세상의 모든 글을 저장할 수는 없다** — 디스크가 차면 그날 장사가 멈춘다.
/// 그렇다고 대화를 안 받으면 세계와 안 이어진다.
///
/// 답은 「전부냐 아무것도 아니냐」가 아니었다. **레이븐 이야기만 남긴다.**
/// 그 밖의 글은 지나가게 두되(중계는 한다) 디스크에 안 쓴다.
/// 우리가 세상의 저장소일 이유는 없지만, 레이븐 이야기의 저장소일 이유는 있다.
const KINDS: [i64; 5] = [30078, 30402, 40, 42, 1];

/// 대화 글의 종류. 이 셋은 위의 가게 규칙(JSON·d 태그)을 적용하면 안 된다 —
/// 사람이 쓴 글은 JSON 이 아니다.
const TALK_KINDS: [i64; 3] = [40, 42, 1];

/// 들고 있을 글의 최대 수. 넘치면 오래된 것부터 버린다.
///
/// 가게 계산대는 서버가 아니다. 디스크가 차서 장사가 멈추면 그건 우리 잘못이다.
const MAX_EVENTS: usize = 5_000;

/// 글 하나의 최대 크기. 가게 정보를 다 합쳐도 몇 KB 다.
const MAX_EVENT_BYTES: usize = 32 * 1024;

static STORE: Mutex<Option<Vec<Value>>> = Mutex::new(None);
/// 저장할 것이 쌓였나. 글 하나마다 파일을 쓰지 않기 위한 표시.
static DIRTY: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// 모아 둔 것을 디스크에 내린다. 5초에 한 번.
///
/// 서버가 켜질 때 한 번 부른다. 앱이 도는 동안 계속 돈다.
pub fn start_saver() {
    tauri::async_runtime::spawn(async {
        loop {
            tokio::time::sleep(std::time::Duration::from_secs(5)).await;
            if !DIRTY.swap(false, std::sync::atomic::Ordering::Relaxed) {
                continue;
            }
            let snapshot = {
                let g = STORE.lock().unwrap_or_else(|e| e.into_inner());
                g.clone().unwrap_or_default()
            };
            let _ = std::fs::write(
                file(),
                serde_json::to_vec(&json!({ "events": snapshot })).unwrap_or_default(),
            );
        }
    });
}

fn file() -> std::path::PathBuf {
    crate::paths::app_file("relay-events.json")
}

fn load() -> Vec<Value> {
    std::fs::read_to_string(file())
        .ok()
        .and_then(|t| serde_json::from_str::<Value>(&t).ok())
        .and_then(|v| v.get("events").and_then(Value::as_array).cloned())
        .unwrap_or_default()
}

fn with<T>(f: impl FnOnce(&mut Vec<Value>) -> T) -> T {
    let mut g = STORE.lock().unwrap_or_else(|e| e.into_inner());
    let v = g.get_or_insert_with(load);
    let out = f(v);
    // 🔴 **글 하나마다 파일 전체를 다시 쓰면 안 된다.** 5,000개를 들고 있는
    // 상태에서 초당 몇 개만 들어와도 디스크가 그것만 한다 — 그리고 그 디스크는
    // 장사하는 컴퓨터의 것이다. 누가 일부러 밀어 넣으면 계산대가 느려진다.
    //
    // 모아 뒀다가 5초에 한 번 쓴다. 그 사이에 전원이 나가면 몇 초치를 잃는데,
    // 잃는 것은 **남의 공지 사본**이고 우리 것은 릴레이에 또 있다.
    DIRTY.store(true, std::sync::atomic::Ordering::Relaxed);
    out
}

/// 이 글이 진짜인가. **서명을 우리가 확인한다.**
///
/// 🔴 안 하면 아무나 남의 이름으로 「이 가게는 여기서 주문받습니다」를 올릴
/// 수 있고, 우리가 그것을 손님에게 나른다. 릴레이가 하는 일 중 이것만은
/// 빠뜨리면 안 된다.
fn verify(e: &Value) -> bool {
    use secp256k1::{schnorr::Signature, Secp256k1, XOnlyPublicKey};
    use sha2::{Digest, Sha256};

    let (Some(pk), Some(sig), Some(id)) = (
        e.get("pubkey").and_then(Value::as_str),
        e.get("sig").and_then(Value::as_str),
        e.get("id").and_then(Value::as_str),
    ) else {
        return false;
    };

    // id 는 `[0, pubkey, created_at, kind, tags, content]` 를 **공백 없이** 이은
    // JSON 의 SHA-256 이다(NIP-01). `to_string` 은 공백을 안 넣는다.
    let pre = match serde_json::to_string(&json!([
        0,
        pk,
        e.get("created_at").and_then(Value::as_i64).unwrap_or(0),
        e.get("kind").and_then(Value::as_i64).unwrap_or(0),
        e.get("tags").cloned().unwrap_or(json!([])),
        e.get("content").and_then(Value::as_str).unwrap_or(""),
    ])) {
        Ok(s) => s,
        Err(_) => return false,
    };
    let hash = Sha256::digest(pre.as_bytes());
    // 릴레이가 내용을 바꾸고 옛 id 를 붙일 수 있다. 다시 센다.
    if hex::encode(hash) != id.to_lowercase() {
        return false;
    }

    let (Ok(pkb), Ok(sigb)) = (hex::decode(pk), hex::decode(sig)) else {
        return false;
    };
    let (Ok(xpk), Ok(s)) = (
        XOnlyPublicKey::from_slice(&pkb),
        Signature::from_slice(&sigb),
    ) else {
        return false;
    };
    let msg: [u8; 32] = hash.into();
    Secp256k1::verification_only()
        .verify_schnorr(&s, &msg, &xpk)
        .is_ok()
}

/// 이 글이 걸러진 조건에 맞나. NIP-01 의 필터 중 **우리가 쓰는 것만.**
fn matches(e: &Value, f: &Value) -> bool {
    let want = |key: &str, val: Option<&str>| -> bool {
        match f.get(key).and_then(Value::as_array) {
            None => true, // 안 적었으면 안 따진다
            Some(list) => val
                .map(|v| list.iter().any(|x| x.as_str() == Some(v)))
                .unwrap_or(false),
        }
    };
    if let Some(kinds) = f.get("kinds").and_then(Value::as_array) {
        let k = e.get("kind").and_then(Value::as_i64).unwrap_or(-1);
        if !kinds.iter().any(|x| x.as_i64() == Some(k)) {
            return false;
        }
    }
    if !want("authors", e.get("pubkey").and_then(Value::as_str)) {
        return false;
    }
    if !want("ids", e.get("id").and_then(Value::as_str)) {
        return false;
    }
    // `#d`·`#p` 같은 태그 조건.
    for (key, vals) in f.as_object().cloned().unwrap_or_default() {
        let Some(name) = key.strip_prefix('#') else { continue };
        let Some(vals) = vals.as_array() else { continue };
        let hit = e
            .get("tags")
            .and_then(Value::as_array)
            .map(|tags| {
                tags.iter().any(|t| {
                    t.get(0).and_then(Value::as_str) == Some(name)
                        && vals.iter().any(|v| v == &t[1])
                })
            })
            .unwrap_or(false);
        if !hit {
            return false;
        }
    }
    true
}

/// 이 글이 가게 공지가 **아닌** 무엇인가.
///
/// 껍데기가 맞아도 안을 봐야 한다. 판단은 셋뿐이고, 셋 다 「이게 정말
/// 가게 정보인가」를 묻는다. 글의 옳고 그름을 판정하지 않는다 — 그건
/// 우리가 할 일도 아니고, 하겠다고 나서면 그 열쇠를 우리가 갖게 된다.
fn smells_bad(e: &Value) -> Option<String> {
    // 대화 글은 다른 잣대로 본다. 아래 규칙은 전부 **가게 공지** 것이라
    // 사람이 쓴 글에 대면 전부 걸린다.
    let kind = e.get("kind").and_then(Value::as_i64).unwrap_or(-1);
    if TALK_KINDS.contains(&kind) {
        return talk_smells_bad(e);
    }
    // ① 통째로 너무 크다. 가게 이름·전화·좌표·영업시간·메뉴를 다 합쳐도
    //    몇 KB 다. 그보다 크면 이건 정보가 아니라 짐이다.
    let size = serde_json::to_string(e).map(|s| s.len()).unwrap_or(0);
    if size > MAX_EVENT_BYTES {
        return Some(format!("가게 글이 너무 큽니다({size}바이트)"));
    }
    let content = e.get("content").and_then(Value::as_str).unwrap_or("");
    // ② 가게 공지는 JSON 이다. 글줄이 아니다. 아무 글이나 담아 보내는
    //    가장 쉬운 길이 이것이라 여기서 막힌다.
    if !content.trim().is_empty() && serde_json::from_str::<Value>(content).is_err() {
        return Some("가게 글의 모양이 아닙니다".into());
    }
    // ③ `d` 태그는 가게 자산 이름이다. 체인에 있는 이름의 모양이어야 한다.
    //    이걸 요구하면 아무 글이나 올리려면 **자산을 먼저 발행**해야 하고,
    //    그건 돈이 들고 체인에 영구히 남는다 — 지울 수 없는 흔적이 남는
    //    쪽이 익명으로 던지고 사라지는 것보다 훨씬 낫다.
    let d = e
        .get("tags")
        .and_then(Value::as_array)
        .and_then(|t| {
            t.iter()
                .find(|x| x.get(0).and_then(Value::as_str) == Some("d"))
                .and_then(|x| x.get(1).and_then(Value::as_str))
        })
        .unwrap_or("");
    if !looks_like_asset(d) {
        return Some("어느 가게 것인지 적혀 있지 않습니다".into());
    }
    None
}

/// 대화 글을 **저장할** 것인가.
///
/// ## 무엇을 레이븐 이야기로 보나 — 셋 중 하나면 된다
///
/// ① 우리가 아는 방에 쓴 글. 방 하나가 통째로 레이븐 이야기라면 그 안의
///    글도 그렇다. 방 주인이 정하고 우리는 따른다.
/// ② `#ravencoin` · `#rvn` · `#playx` 같은 표를 단 글.
/// ③ 본문에 레이븐 주소(`R…`)나 자산 이름이 들어 있는 글.
///
/// 이 셋에 안 걸리면 **버리는 게 아니라 저장만 안 한다.** 그 글은 다른
/// 릴레이에 있고, 우리 화면은 거기서 읽는다. 계산대 디스크만 안 쓴다.
///
/// ⚠️ 글의 옳고 그름은 여전히 판정하지 않는다. 「레이븐 이야기인가」만 본다.
///    무엇이 좋은 글인지 정하는 열쇠를 우리가 가지면 안 된다.
fn talk_smells_bad(e: &Value) -> Option<String> {
    let size = serde_json::to_string(e).map(|s| s.len()).unwrap_or(0);
    if size > MAX_EVENT_BYTES {
        return Some(format!("글이 너무 큽니다({size}바이트)"));
    }
    // 방을 만드는 글(40)은 그 자체로 우리가 아는 방이 된다.
    if e.get("kind").and_then(Value::as_i64) == Some(40) {
        return None;
    }
    if about_ravencoin(e) {
        return None;
    }
    Some("레이븐 이야기가 아니라서 저장하지 않습니다".into())
}

/// 레이븐 이야기인가. 위 셋을 순서대로 본다.
fn about_ravencoin(e: &Value) -> bool {
    const MARKS: [&str; 6] = ["ravencoin", "rvn", "playx", "레이븐", "raven", "asset"];
    let tags = e.get("tags").and_then(Value::as_array).cloned().unwrap_or_default();

    // ① 방에 쓴 글이면 그 방을 아는지 본다. `e` 태그의 첫 값이 방 id 다.
    if e.get("kind").and_then(Value::as_i64) == Some(42) && known_room(&tags) {
        return true;
    }
    // ② 표(`t` 태그).
    for t in &tags {
        if t.get(0).and_then(Value::as_str) == Some("t") {
            let v = t.get(1).and_then(Value::as_str).unwrap_or("").to_lowercase();
            if MARKS.iter().any(|m| v.contains(m)) {
                return true;
            }
        }
    }
    // ③ 본문. 주소는 `R` 로 시작하고 34자다 — 그 모양이 있으면 레이븐 이야기다.
    let c = e.get("content").and_then(Value::as_str).unwrap_or("");
    let low = c.to_lowercase();
    if MARKS.iter().any(|m| low.contains(m)) {
        return true;
    }
    c.split(|ch: char| !ch.is_ascii_alphanumeric())
        .any(|w| w.len() == 34 && w.starts_with('R'))
}

/// 우리가 저장해 둔 방인가. 방을 만드는 글(40)을 받아 뒀으면 그 방을 안다.
fn known_room(tags: &[Value]) -> bool {
    let Some(room) = tags
        .iter()
        .find(|t| t.get(0).and_then(Value::as_str) == Some("e"))
        .and_then(|t| t.get(1).and_then(Value::as_str))
    else {
        return false;
    };
    STORE
        .lock()
        .ok()
        .and_then(|g| {
            g.as_ref().map(|v| {
                v.iter().any(|x| {
                    x.get("kind").and_then(Value::as_i64) == Some(40)
                        && x.get("id").and_then(Value::as_str) == Some(room)
                })
            })
        })
        .unwrap_or(false)
}

/// 레이븐코인 자산 이름의 모양인가.
///
/// 체인에 정말 있는지까지는 여기서 안 본다 — 릴레이는 노드가 따라잡는
/// 중에도 돌아야 하고, 글 하나마다 체인을 물으면 느려진다. 모양만 본다.
fn looks_like_asset(d: &str) -> bool {
    // `shop:` 접두는 우리가 붙인 것이라 벗긴다.
    let name = d.strip_prefix("shop:").unwrap_or(d);
    let core = name.split(['/', '#', '~']).next().unwrap_or("");
    (3..=31).contains(&core.len())
        && core
            .chars()
            .all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == '.' || c == '_')
        && core.chars().next().map(|c| c.is_ascii_uppercase()).unwrap_or(false)
}

/// 글 하나를 받아 둔다.
///
/// 🔴 **덮어쓰기 가능한 글**(30000–39999)은 같은 글쓴이·같은 `d` 태그면
/// 옛것을 지운다(NIP-33). 안 그러면 가게가 주소를 바꿀 때마다 글이 쌓이고,
/// 손님 화면이 어느 것이 최신인지 골라야 한다.
fn store(e: Value) -> (bool, String) {
    if !KINDS.contains(&e.get("kind").and_then(Value::as_i64).unwrap_or(-1)) {
        return (false, "이 릴레이는 가게 글만 받습니다".into());
    }
    if !verify(&e) {
        return (false, "invalid: 서명이 맞지 않습니다".into());
    }
    // 🔴 **종류만 막고 내용은 안 막고 있었다**(제미나이 지적, 코드로 확인).
    //    「가게 공지」라는 껍데기만 맞으면 그 안의 글자는 자유였고, 누구든
    //    **사장 컴퓨터에 아무 글이나 남길 수** 있었다. 릴레이는 사장 집에서
    //    도는데, 남이 올린 것이 사장 디스크에 쌓이고 사장은 그걸 모른다.
    //
    //    세 가지로 좁힌다. 완전히 막을 수는 없지만 — 가게 공지에는 이름과
    //    설명이 있어야 하니까 — **비싸고 눈에 띄게** 만든다.
    if let Some(why) = smells_bad(&e) {
        return (false, why);
    }
    // 🔴 시각이 터무니없는 글은 안 받는다. 미래로 적으면 **덮어쓰기 규칙에서
    // 영원히 이기고**, 진짜 가게가 새 주소를 올려도 그 가짜가 계속 최신이 된다.
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    let at = e.get("created_at").and_then(Value::as_i64).unwrap_or(0);
    if at > now + 900 {
        return (false, "invalid: 시각이 미래입니다".into());
    }
    if at < now - 90 * 86_400 {
        return (false, "invalid: 너무 오래된 글입니다".into());
    }
    let kind = e.get("kind").and_then(Value::as_i64).unwrap_or(0);
    let pk = e.get("pubkey").and_then(Value::as_str).unwrap_or("").to_string();
    let d = e
        .get("tags")
        .and_then(Value::as_array)
        .and_then(|t| {
            t.iter()
                .find(|x| x.get(0).and_then(Value::as_str) == Some("d"))
                .and_then(|x| x.get(1).and_then(Value::as_str))
        })
        .unwrap_or("")
        .to_string();
    let at = e.get("created_at").and_then(Value::as_i64).unwrap_or(0);

    with(|v| {
        if (30000..40000).contains(&kind) {
            // 같은 자리에 더 새 글이 이미 있으면 이 글은 옛것이다.
            let newer = v.iter().any(|x| {
                x.get("kind").and_then(Value::as_i64) == Some(kind)
                    && x.get("pubkey").and_then(Value::as_str) == Some(pk.as_str())
                    && x.get("created_at").and_then(Value::as_i64).unwrap_or(0) > at
                    && x.get("tags")
                        .and_then(Value::as_array)
                        .map(|t| {
                            t.iter().any(|y| {
                                y.get(0).and_then(Value::as_str) == Some("d")
                                    && y.get(1).and_then(Value::as_str) == Some(d.as_str())
                            })
                        })
                        .unwrap_or(false)
            });
            if newer {
                return (true, "옛 글입니다".into());
            }
            v.retain(|x| {
                !(x.get("kind").and_then(Value::as_i64) == Some(kind)
                    && x.get("pubkey").and_then(Value::as_str) == Some(pk.as_str())
                    && x.get("tags")
                        .and_then(Value::as_array)
                        .map(|t| {
                            t.iter().any(|y| {
                                y.get(0).and_then(Value::as_str) == Some("d")
                                    && y.get(1).and_then(Value::as_str) == Some(d.as_str())
                            })
                        })
                        .unwrap_or(false))
            });
        } else if v
            .iter()
            .any(|x| x.get("id") == e.get("id"))
        {
            return (true, "이미 있습니다".into());
        }
        v.push(e.clone());
        if v.len() > MAX_EVENTS {
            let cut = v.len() - MAX_EVENTS;
            v.drain(0..cut);
        }
        (true, String::new())
    })
}

/// 손님·다른 가게가 붙는 자리. `wss://…/relay`
pub async fn serve(mut ws: WebSocket) {
    // 🔴 **한 연결이 쏟아붓는 것을 막는다.** 서명이 맞는 글은 누구나 얼마든지
    // 만들 수 있다(열쇠 하나면 된다). 막지 않으면 한 사람이 5,000개를 채워
    // **이 가게의 진짜 공지를 밀어내고**, 그 사이 디스크와 CPU 를 다 쓴다.
    //
    // 한 번 붙어서 200개까지. 더 보내려면 다시 붙어야 하고, 그건 눈에 띈다.
    let mut sent = 0usize;
    while let Some(Ok(msg)) = ws.recv().await {
        let Message::Text(txt) = msg else { continue };
        // 아주 큰 글은 안 받는다. 사진을 통째로 밀어 넣는 길이 된다.
        if txt.len() > 256 * 1024 {
            let _ = ws
                .send(Message::Text(
                    json!(["NOTICE", "글이 너무 큽니다"]).to_string().into(),
                ))
                .await;
            continue;
        }
        let Ok(a) = serde_json::from_str::<Value>(&txt) else { continue };
        let Some(cmd) = a.get(0).and_then(Value::as_str) else { continue };

        match cmd {
            "EVENT" => {
                let Some(e) = a.get(1).cloned() else { continue };
                let id = e.get("id").and_then(Value::as_str).unwrap_or("").to_string();
                sent += 1;
                if sent > 200 {
                    let _ = ws
                        .send(Message::Text(
                            json!(["OK", id, false, "rate-limited: 한 번에 너무 많습니다"])
                                .to_string()
                                .into(),
                        ))
                        .await;
                    continue;
                }
                let (ok, why) = store(e);
                let _ = ws
                    .send(Message::Text(
                        json!(["OK", id, ok, why]).to_string().into(),
                    ))
                    .await;
            }
            "REQ" => {
                let Some(sub) = a.get(1).and_then(Value::as_str) else { continue };
                // 걸러 낼 조건이 여럿 올 수 있다. 하나라도 맞으면 보낸다.
                let filters: Vec<Value> = a.as_array().map(|x| x[2..].to_vec()).unwrap_or_default();
                let hits = with(|v| {
                    let mut out: Vec<Value> = v
                        .iter()
                        .filter(|e| filters.iter().any(|f| matches(e, f)))
                        .cloned()
                        .collect();
                    // 최신이 먼저. 손님 화면이 첫 줄만 봐도 맞게.
                    out.sort_by_key(|e| -(e.get("created_at").and_then(Value::as_i64).unwrap_or(0)));
                    let cap = filters
                        .iter()
                        .filter_map(|f| f.get("limit").and_then(Value::as_u64))
                        .max()
                        .unwrap_or(200)
                        .min(500) as usize;
                    out.truncate(cap);
                    out
                });
                for e in hits {
                    let _ = ws
                        .send(Message::Text(
                            json!(["EVENT", sub, e]).to_string().into(),
                        ))
                        .await;
                }
                // 🔴 EOSE 를 안 보내면 부르는 쪽이 **영원히 기다린다.**
                let _ = ws
                    .send(Message::Text(json!(["EOSE", sub]).to_string().into()))
                    .await;
            }
            // 구독을 끊는다. 우리는 지금 것만 주고 끝내므로 할 일이 없다.
            "CLOSE" => {}
            _ => {}
        }
    }
}

/// 지금 몇 개를 들고 있나. 화면의 표시등이 읽는다.
#[tauri::command]
pub fn relay_status() -> Value {
    let n = with(|v| v.len());
    json!({
        // 🔴 `true` 를 박아 두면 안 된다. 8790 을 **옛 앱이나 남의 프로그램**이
        // 쥐고 있으면 손님 화면은 도는데 릴레이는 우리 것이 아니다. 그때
        // [릴레이 켜짐] 이라고 적으면 거짓말이고, 실제로 이 거짓말에
        // 세 번 속아서 멀쩡한 코드를 고장 났다고 판단했다.
        "running": crate::server::relay_live(),
        "events": n,
        // 바깥에서 붙을 수 있는 주소. 터널이 꺼져 있으면 가게 안에서만이다.
        "url": crate::tunnel::tunnel_status()["url"]
            .as_str()
            .map(|u| format!("{}/api/relay", u.replace("https://", "wss://"))),
    })
}

#[cfg(test)]
mod tests {
    /// 🔴 종류만 막고 **내용은 안 막고 있었다**(제미나이 지적). 껍데기가
    /// 맞으면 누구든 사장 컴퓨터에 아무 글이나 남길 수 있었다.
    #[test]
    fn 가게_글이_아닌_것은_안_받는다() {
        use super::*;
        let base = |content: &str, d: &str| {
            json!({
                "kind": 30078, "created_at": 0, "content": content,
                "tags": [["d", d]]
            })
        };
        // 진짜 가게 공지 — 통과해야 한다.
        assert!(smells_bad(&base(r#"{"name":"플레이엑스"}"#, "shop:SHOP.PLAYX")).is_none());
        assert!(smells_bad(&base("", "SHOP.PLAYX")).is_none(), "빈 것도 모양은 맞다");
        // 🔴 그냥 글줄을 담아 보내는 것 — 가장 쉬운 길이라 여기서 막는다.
        assert!(smells_bad(&base("여기에 아무 말이나 적는다", "shop:SHOP.PLAYX")).is_some());
        // 🔴 어느 가게 것인지 안 적힌 것.
        assert!(smells_bad(&base("{}", "")).is_some());
        assert!(smells_bad(&base("{}", "아무거나")).is_some());
        assert!(smells_bad(&base("{}", "ab")).is_some(), "너무 짧은 이름");
        // 🔴 짐 싣기 — 32KB 를 넘기면 안 받는다.
        let big = format!(r#"{{"x":"{}"}}"#, "가".repeat(40_000));
        assert!(smells_bad(&base(&big, "shop:SHOP.PLAYX")).is_some());
    }


    use super::*;

    /// 🔴 서명이 틀린 글을 받아 두면, 아무나 남의 이름으로 「이 가게는 여기서
    /// 주문받습니다」를 올리고 우리가 그것을 손님에게 나른다.
    #[test]
    fn a_forged_event_is_refused() {
        let e = json!({
            "id": "0".repeat(64),
            "pubkey": "1".repeat(64),
            "sig": "2".repeat(128),
            "kind": 30078,
            "created_at": 1_800_000_000,
            "tags": [["d", "SHOP.X"]],
            "content": "{}",
        });
        assert!(!verify(&e));
    }

    /// 가게 글이 아닌 것은 안 받는다. 열어 두면 세상의 모든 글이 쏟아진다.
    #[test]

    /// 🔴 대화를 받되 **세상의 모든 글을 저장하지는 않는다.**
    ///    가게 계산대 컴퓨터의 디스크가 차면 그날 장사가 멈춘다.
    ///    「레이븐 이야기만」이 그 선이다.
    #[test]
    fn 레이븐_이야기만_저장한다() {
        let mine = json!({ "kind": 1, "content": "RVN 자산 발행 해봤는데 잘 되네요", "tags": [] });
        assert!(super::talk_smells_bad(&mine).is_none(), "레이븐 이야기를 버렸다");

        let tagged = json!({ "kind": 1, "content": "hello", "tags": [["t", "ravencoin"]] });
        assert!(super::talk_smells_bad(&tagged).is_none(), "표가 붙은 글을 버렸다");

        let addr = json!({
            "kind": 1,
            "content": "보내주세요 RLFnbkjmf1VCVq7D9TZvRp7fv6W97rm2cB 로",
            "tags": []
        });
        assert!(super::talk_smells_bad(&addr).is_none(), "주소가 든 글을 버렸다");

        let other = json!({ "kind": 1, "content": "오늘 점심 뭐 먹지", "tags": [] });
        assert!(
            super::talk_smells_bad(&other).is_some(),
            "상관없는 글까지 저장하고 있다 — 계산대 디스크가 찬다"
        );
    }

    /// 사람이 쓴 글에 가게 공지 잣대(JSON·d 태그)를 대면 **전부 걸린다.**
    /// 두 갈래가 섞이면 대화가 통째로 막힌다.
    #[test]
    fn 대화에는_가게_잣대를_대지_않는다() {
        let talk = json!({ "kind": 42, "content": "안녕하세요", "tags": [] });
        let why = super::smells_bad(&talk);
        assert!(
            why.as_deref() != Some("가게 글의 모양이 아닙니다"),
            "사람 글에 가게 공지 규칙을 대고 있다"
        );
    }

    fn only_shop_kinds_are_taken() {
        let mut e = json!({ "kind": 1 });
        let (ok, why) = store(e.take());
        assert!(!ok);
        assert!(why.contains("가게 글만"), "{why}");
    }

    /// 걸러 내기가 종류·글쓴이·`d` 태그를 다 본다.
    #[test]
    fn the_filter_looks_at_what_it_should() {
        let e = json!({
            "kind": 30078,
            "pubkey": "aa",
            "id": "bb",
            "tags": [["d", "SHOP.PLAYX"]],
        });
        assert!(matches(&e, &json!({ "kinds": [30078] })));
        assert!(!matches(&e, &json!({ "kinds": [30402] })));
        assert!(matches(&e, &json!({ "authors": ["aa"] })));
        assert!(!matches(&e, &json!({ "authors": ["zz"] })));
        assert!(matches(&e, &json!({ "#d": ["SHOP.PLAYX"] })));
        assert!(!matches(&e, &json!({ "#d": ["SHOP.OTHER"] })));
        // 아무 조건도 없으면 다 맞는다.
        assert!(matches(&e, &json!({})));
    }
}
