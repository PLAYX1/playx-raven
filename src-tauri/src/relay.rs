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
//! (11-08 정직하게: 실제로 서로 붙는 것은 「릴레이 나누기」를 켠 컴퓨터끼리뿐이다 — relay_share.rs · docs/RELAY-SHARE.md.)
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
///      41 — 방 이름·설명 수정 (NIP-28). 누가 고칠 수 있는지는 읽는 쪽(talk.rs)이 본다.
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
///       5 — 지우기 요청(NIP-09). ravencoin 표가 있는 것만(폰·데스크탑이 단다).
///  0·3·10003 — 이름표·팔로우·북마크(NIP-01/02/51). **사람마다 하나만** 남는 글이다.
///       이미 레이븐 이야기를 남긴 사람 것만 받는다(이름표는 ravencoin 표로도) — 남의 SNS 목록 창고가 되지 않게.
///       11-06 GPT 지적: 이걸 안 받아서 우리 릴레이만 읽으면 이름이 안 뜨고 팔로우·북마크가 사라졌다.
///   10002 — 릴레이 목록(NIP-65). 릴레이 나누기(docs/RELAY-SHARE.md §6): 이름표처럼 사람마다 하나 · 같은 규칙.
const KINDS: [i64; 11] = [30078, 30402, 40, 41, 42, 1, 5, 0, 3, 10003, 10002];

/// 사람마다 하나만 남는 글(NIP-01 replaceable: 0·3·10000~19999). 같은 사람·같은 종류면 옛것을 지운다.
const PERSON_KINDS: [i64; 4] = [0, 3, 10003, 10002];
fn replaceable(kind: i64) -> bool { kind == 0 || kind == 3 || (10000..20000).contains(&kind) }

/// 대화 글의 종류. 이 셋은 위의 가게 규칙(JSON·d 태그)을 적용하면 안 된다 —
/// 사람이 쓴 글은 JSON 이 아니다.
const TALK_KINDS: [i64; 5] = [40, 41, 42, 1, 5];

/// 이 컴퓨터 주인에게 온 쪽지 겉봉(NIP-17 kind 1059)을 들고 있을 최대 수. 남의 글 한도(MAX_EVENTS)와 따로 센다.
const MAX_WRAPS: usize = 5_000;

/// 주인에게 온 겉봉인가: kind 1059 이고 `p` 태그가 주인 공개키. 글쓴이는 1회용 열쇠라 `pubkey` 로는 못 가린다.
fn owner_wrap(e: &Value, me: Option<&str>) -> bool {
    let Some(me) = me else { return false };
    e.get("kind").and_then(Value::as_i64) == Some(1059)
        && e.get("tags").and_then(Value::as_array).is_some_and(|t| {
            t.iter().any(|x| x.get(0).and_then(Value::as_str) == Some("p") && x.get(1).and_then(Value::as_str) == Some(me))
        })
}

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
            // 11-07: 임시 파일 → 이름 바꾸기. 실패하면 다음 차례에 다시 쓴다(표시를 되살린다).
            let tmp = file().with_extension("json.tmp");
            let ok = std::fs::write(&tmp, serde_json::to_vec(&json!({ "events": snapshot })).unwrap_or_default()).is_ok()
                && std::fs::rename(&tmp, file()).is_ok();
            if !ok {
                DIRTY.store(true, std::sync::atomic::Ordering::Relaxed);
            }
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

/// 읽기만 한다 — 저장할 것이 생긴 게 아니므로 디스크 쓰기 표시를 안 켠다
/// (폰이 몇 초마다 REQ 로 물어도 `relay-events.json` 을 다시 쓰지 않게).
fn peek<T>(f: impl FnOnce(&Vec<Value>) -> T) -> T {
    let mut g = STORE.lock().unwrap_or_else(|e| e.into_inner());
    let v = g.get_or_insert_with(load);
    f(v)
}

/// 이 글이 진짜인가. **서명을 우리가 확인한다.**
///
/// 🔴 안 하면 아무나 남의 이름으로 「이 가게는 여기서 주문받습니다」를 올릴
/// 수 있고, 우리가 그것을 손님에게 나른다. 릴레이가 하는 일 중 이것만은
/// 빠뜨리면 안 된다.
pub(crate) fn verify(e: &Value) -> bool {
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
    // 11-07 GPT P1: 대소문자만 바꾼 id 가 「다른 글」로 쌓였다(중복 검사는 원래 문자열을 본다) — id 는 소문자 그대로만 받는다.
    if hex::encode(hash) != id {
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

/// 지킴이 표시(NIP-58) — 확인 서버 열쇠가 서명한 정의(kind 30009)와 수여(kind 8)만.
/// 노드 지킴이(d=rv-node-keeper)·릴레이 지킴이(d=rv-relay-keeper, docs/KEEPER-THANKS.md §1) 둘.
/// 다른 열쇠가 쓴 같은 종류는 여전히 안 받는다(스팸 길을 열지 않는다). 서명은 store 가 따로 본다.
const KEEPER_BADGE_DS: [&str; 2] = [crate::node_keeper::AWARD_A, crate::relay_keeper::AWARD_A];
fn node_keeper_badge(e: &Value) -> bool {
    let kind = e.get("kind").and_then(Value::as_i64).unwrap_or(-1);
    if !matches!(kind, 8 | 30009) || e.get("pubkey").and_then(Value::as_str) != Some(crate::node_keeper::NODE_KEEPER_PUB) {
        return false;
    }
    let pk = crate::node_keeper::NODE_KEEPER_PUB;
    e.get("tags").and_then(Value::as_array).is_some_and(|t| {
        t.iter().any(|x| {
            let (Some(name), Some(val)) = (x.get(0).and_then(Value::as_str), x.get(1).and_then(Value::as_str)) else { return false };
            KEEPER_BADGE_DS.iter().any(|d| if kind == 8 { name == "a" && val == format!("30009:{pk}:{d}") } else { name == "d" && val == *d })
        })
    })
}

/// 이 글이 가게 공지가 **아닌** 무엇인가.
///
/// 껍데기가 맞아도 안을 봐야 한다. 판단은 셋뿐이고, 셋 다 「이게 정말
/// 가게 정보인가」를 묻는다. 글의 옳고 그름을 판정하지 않는다 — 그건
/// 우리가 할 일도 아니고, 하겠다고 나서면 그 열쇠를 우리가 갖게 된다.
fn smells_bad(e: &Value) -> Option<String> {
    // 대화 글은 다른 잣대로 본다. 아래 규칙은 전부 **가게 공지** 것이라
    // 사람이 쓴 글에 대면 전부 걸린다.
    if node_keeper_badge(e) {
        return None;
    }
    let kind = e.get("kind").and_then(Value::as_i64).unwrap_or(-1);
    if TALK_KINDS.contains(&kind) {
        return talk_smells_bad(e);
    }
    if PERSON_KINDS.contains(&kind) {
        return person_smells_bad(e);
    }
    // 0.9.17 맞교환 물건(kind 30402 + `rv-swap` 표)은 가게 공지가 아니다 — 본문은 설명 글이고
    // `d` 는 `rvswap:<txid>:<vout>` 이다. 아래 ②③ 에 대면 **우리 릴레이가 장터 물건을 전부 버린다**
    // (regtest 실측 11-07: 「가게 글의 모양이 아닙니다」). 대신 사는 쪽과 같은 모양 검사
    // (`market_listing::parse_listing`)를 통과한 것만 받는다. 체인 확인은 읽는 쪽이 한다.
    if kind == 30402 && has_t(e, "rv-swap") {
        let size = serde_json::to_string(e).map(|s| s.len()).unwrap_or(0);
        if size > MAX_EVENT_BYTES {
            return Some(format!("물건 글이 너무 큽니다({size}바이트)"));
        }
        return crate::market_listing::parse_listing(e).err().map(|why| format!("맞교환 물건 모양이 아닙니다: {why}"));
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

fn has_t(e: &Value, val: &str) -> bool {
    e.get("tags").and_then(Value::as_array).is_some_and(|t| {
        t.iter().any(|x| x.get(0).and_then(Value::as_str) == Some("t") && x.get(1).and_then(Value::as_str) == Some(val))
    })
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

/// 이름표·팔로우·북마크를 **저장할** 것인가. 크기 한도 + 이미 레이븐 이야기를 남긴 사람(이름표는 ravencoin 표도 된다).
fn person_smells_bad(e: &Value) -> Option<String> {
    let size = serde_json::to_string(e).map(|s| s.len()).unwrap_or(0);
    if size > MAX_EVENT_BYTES {
        return Some(format!("글이 너무 큽니다({size}바이트)"));
    }
    let pk = e.get("pubkey").and_then(Value::as_str).unwrap_or("");
    if known_author(pk) {
        return None;
    }
    let tagged = e.get("tags").and_then(Value::as_array).map(|t| {
        t.iter().any(|x| x.get(0).and_then(Value::as_str) == Some("t") && x.get(1).and_then(Value::as_str) == Some("ravencoin"))
    }).unwrap_or(false);
    if e.get("kind").and_then(Value::as_i64) == Some(0) && tagged {
        return None;
    }
    // 릴레이 목록(10002)은 레이븐 표(ravencoin) 또는 릴레이 나누기 표(ravenvault-relay)가 있으면 처음 보는 사람이어도 받는다 —
    // 이웃 데스크탑이 서로를 찾는 글이다. 사람마다 하나만 남고(덮어쓰기), 크기 한도는 위에서 봤다.
    if e.get("kind").and_then(Value::as_i64) == Some(10002) && (tagged || has_t(e, crate::relay_share::SHARE_TAG)) {
        return None;
    }
    Some("레이븐 이야기를 남긴 사람 것만 저장합니다".into())
}

/// 이 사람이 남긴 레이븐 이야기(글·방·이름표)가 이미 있나.
fn known_author(pk: &str) -> bool {
    if pk.is_empty() {
        return false;
    }
    STORE
        .lock()
        .ok()
        .and_then(|g| {
            g.as_ref().map(|v| {
                v.iter().any(|x| {
                    x.get("pubkey").and_then(Value::as_str) == Some(pk)
                        && matches!(x.get("kind").and_then(Value::as_i64), Some(0 | 1 | 40 | 41 | 42))
                })
            })
        })
        .unwrap_or(false)
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
    // 11-08 쪽지 보관(docs/SYNC-ARCHIVE.md §1): 겉봉(1059)은 **주인에게 온 것만** 받는다. 남의 겉봉은 디스크를 채울 뿐이다.
    let me = owner();
    let wrap = owner_wrap(&e, me.as_deref());
    if !wrap && !KINDS.contains(&e.get("kind").and_then(Value::as_i64).unwrap_or(-1)) && !node_keeper_badge(&e) {
        return (false, "이 릴레이는 가게 글만 받습니다".into());
    }
    if !verify(&e) {
        return (false, "invalid: 서명이 맞지 않습니다".into());
    }
    // 11-07 GPT P1: 서명이 덮는 일곱 칸만 남긴다 — 서명 밖에 큰 칸을 붙여 디스크를 채우지 못하게. 크기 검사는 주인 글에도 건다.
    let e = json!({
        "id": e["id"], "pubkey": e["pubkey"], "created_at": e["created_at"], "kind": e["kind"],
        "tags": e.get("tags").cloned().unwrap_or(json!([])), "content": e.get("content").cloned().unwrap_or(json!("")), "sig": e["sig"],
    });
    if serde_json::to_vec(&e).map(|b| b.len()).unwrap_or(usize::MAX) > MAX_EVENT_BYTES {
        return (false, "invalid: 글이 너무 큽니다".into());
    }
    // 🔴 **종류만 막고 내용은 안 막고 있었다**(제미나이 지적, 코드로 확인).
    //    「가게 공지」라는 껍데기만 맞으면 그 안의 글자는 자유였고, 누구든
    //    **사장 컴퓨터에 아무 글이나 남길 수** 있었다. 릴레이는 사장 집에서
    //    도는데, 남이 올린 것이 사장 디스크에 쌓이고 사장은 그걸 모른다.
    //
    //    세 가지로 좁힌다. 완전히 막을 수는 없지만 — 가게 공지에는 이름과
    //    설명이 있어야 하니까 — **비싸고 눈에 띄게** 만든다.
    // 11-07 대표: 「자기 글도 지키려면 자기 릴레이에 올려야」 — **이 컴퓨터 주인의 글은 내용·나이·자리 규칙을 받지 않는다.**
    //    서명은 위에서 확인했다. 주인 열쇠로 서명된 글은 주인이 쓴 것이고, 주인 디스크에 주인 글을 남기는 것은 막을 이유가 없다.
    // 주인 겉봉은 봉한 내용이라 글 모양 규칙을 대지 않는다(풀지 않는다). 크기 한도는 위에서 봤다.
    let mine = wrap || me.as_deref().is_some_and(|o| e.get("pubkey").and_then(Value::as_str) == Some(o));
    if !mine {
        if let Some(why) = smells_bad(&e) {
            return (false, why);
        }
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
    // 이름표·팔로우·북마크는 몇 달 안 고치는 게 보통이라 오래돼도 받는다(사람마다 하나라 쌓이지 않는다).
    let person = PERSON_KINDS.contains(&e.get("kind").and_then(Value::as_i64).unwrap_or(-1));
    if !person && !mine && at < now - 90 * 86_400 {
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
        if replaceable(kind) {
            // 같은 사람의 더 새 이름표·목록이 있으면 이 글은 옛것이다.
            let same = |x: &Value| x.get("kind").and_then(Value::as_i64) == Some(kind) && x.get("pubkey").and_then(Value::as_str) == Some(pk.as_str());
            // NIP-01: 더 늦은 것이 이기고, 같은 시각이면 id 가 사전순으로 작은 것이 이긴다(GPT 2차 지적 — 도착 순서로 정하면 릴레이마다 달라진다).
            let my_id = e.get("id").and_then(Value::as_str).unwrap_or("").to_string();
            let wins_over_me = |x: &Value| {
                let xa = x.get("created_at").and_then(Value::as_i64).unwrap_or(0);
                xa > at || (xa == at && x.get("id").and_then(Value::as_str).unwrap_or("") < my_id.as_str())
            };
            if v.iter().any(|x| same(x) && wins_over_me(x)) {
                return (true, "옛 글입니다".into());
            }
            if v.iter().any(|x| x.get("id") == e.get("id")) {
                return (true, "이미 있습니다".into());
            }
            v.retain(|x| !same(x));
        } else if (30000..40000).contains(&kind) {
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
        // 11-07 감사: 오래된 것부터 자르면 한 사람이 재접속하며 5,000개를 채워 남의 글(가게 공지 포함)을 모두 밀어낸다.
        //   → 넘칠 때는 **가장 많이 쓴 사람의 가장 오래된 글**부터 뺀다. 한 열쇠의 도배는 자기 글만 밀어낸다.
        //   11-07: **주인 글은 밀어내지 않는다** — 주인이 가장 많이 쓴 사람이어도 남의 글부터 뺀다. 한도는 남의 글에만 걸린다.
        let is_mine = |x: &Value| me.as_deref().is_some_and(|o| x.get("pubkey").and_then(Value::as_str) == Some(o)) || owner_wrap(x, me.as_deref());
        // 주인 겉봉은 따로 한도(MAX_WRAPS) — 넘치면 가장 오래된 겉봉부터. 남이 주인에게 쪽지를 쏟아도 이 칸만 찬다.
        if wrap {
            while v.iter().filter(|x| owner_wrap(x, me.as_deref())).count() > MAX_WRAPS {
                let oldest = v.iter().enumerate().filter(|(_, x)| owner_wrap(x, me.as_deref()))
                    .min_by_key(|(_, x)| x.get("created_at").and_then(Value::as_i64).unwrap_or(0)).map(|(i, _)| i);
                match oldest { Some(i) => { v.remove(i); } None => break }
            }
        }
        while v.iter().filter(|x| !is_mine(x)).count() > MAX_EVENTS {
            let mut counts: std::collections::HashMap<&str, usize> = std::collections::HashMap::new();
            for x in v.iter().filter(|x| !is_mine(x)) {
                *counts.entry(x.get("pubkey").and_then(Value::as_str).unwrap_or("")).or_default() += 1;
            }
            let top = counts.into_iter().max_by_key(|(_, n)| *n).map(|(k, _)| k.to_string()).unwrap_or_default();
            match v.iter().position(|x| !is_mine(x) && x.get("pubkey").and_then(Value::as_str).unwrap_or("") == top) {
                Some(i) => { v.remove(i); }
                None => break,
            }
        }
        (true, String::new())
    })
}

// ── 내 글 지키기(11-07) ─────────────────────────────────────────────────────
//
// 대표: 「자기 글도 지키려면 자기 릴레이에 올려야 되는 거 아냐?」
//   데스크탑에서 쓴 글은 `nostrpub::targets()` 가 맨 먼저 이 컴퓨터 릴레이에 둔다.
//   **폰·웹에서 쓴 글은 여기 오지 않았다** — 공용 릴레이가 지우고 N100 이 꺼지면 사라질 수 있었다.
//   같은 12단어면 폰과 데스크탑은 같은 이름(열쇠)이다. 그래서 데스크탑이 바깥 릴레이에서
//   **내 이름으로 서명된 글**을 주기적으로 모아 여기 남긴다. 폰은 아무것도 안 해도 된다.
//   남에게 이 컴퓨터를 열어 주는 것이 아니다 — 이 컴퓨터가 바깥에 묻기만 한다.

/// 주인(이 컴퓨터의 이야기 이름) 공개 열쇠. 파일만 읽는다 — 여기서 열쇠를 **만들지 않는다**.
/// 1분 동안 기억한다(글 하나 받을 때마다 파일을 읽지 않게, 「같은 이름으로 바꾸기」 뒤에는 곧 따라가게).
static OWNER: Mutex<(Option<String>, i64)> = Mutex::new((None, 0));
#[cfg(test)]
static TEST_OWNER: Mutex<Option<String>> = Mutex::new(None);
fn owner() -> Option<String> {
    #[cfg(test)]
    if let Some(o) = TEST_OWNER.lock().unwrap_or_else(|e| e.into_inner()).clone() { return Some(o); }
    let now = now_secs();
    let mut g = OWNER.lock().unwrap_or_else(|e| e.into_inner());
    if now - g.1 >= 60 || (g.0.is_none() && now - g.1 >= 5) {
        g.0 = crate::talk::key_on_disk().and_then(|(sk, _, _)| crate::shopkey::pubkey_of(&sk).ok());
        g.1 = now;
    }
    g.0.clone()
}

/// 내 글 서랍(my_drawer.rs)이 쓴다: 주인 공개키.
pub(crate) fn owner_pub() -> Option<String> { owner() }
/// 한 사람의 글(종류 지정), 새 글이 먼저 + 그 사람이 지운 글 번호들.
/// 잠금 안에서는 그 사람 글만 복사하고, 거르기·정렬은 잠금 밖에서 한다(GPT P2 — 릴레이가 기다리지 않게).
pub(crate) fn events_of(pubkey: &str, kinds: &[i64]) -> (Vec<Value>, Vec<String>) {
    let mine: Vec<Value> = peek(|v| v.iter().filter(|x| x.get("pubkey").and_then(Value::as_str) == Some(pubkey)).cloned().collect());
    let deleted: std::collections::HashSet<String> = mine.iter()
        .filter(|x| x.get("kind").and_then(Value::as_i64) == Some(5))
        .flat_map(|x| x.get("tags").and_then(Value::as_array).cloned().unwrap_or_default())
        .filter(|t| t.get(0).and_then(Value::as_str) == Some("e"))
        .filter_map(|t| t.get(1).and_then(Value::as_str).map(str::to_string))
        .collect();
    let mut out: Vec<Value> = mine.into_iter()
        .filter(|x| x.get("kind").and_then(Value::as_i64).is_some_and(|k| kinds.contains(&k)))
        .filter(|x| x.get("id").and_then(Value::as_str).is_some_and(|id| !deleted.contains(id)))
        .collect();
    out.sort_by_key(|x| std::cmp::Reverse(x.get("created_at").and_then(Value::as_i64).unwrap_or(0)));
    (out, deleted.into_iter().collect())
}

/// 지킬 내 글의 종류: 글·방·방 글·지우기 요청·이름표·팔로우·북마크.
const MINE_KINDS: [i64; 8] = [1, 40, 41, 42, 5, 0, 3, 10003];
/// 마지막으로 **끝까지** 모은 (주인 공개키, 시각). 주인이 바뀌면 처음부터 다시 모은다(GPT P2).
static OWN_BACKUP: Mutex<Option<(String, i64)>> = Mutex::new(None);
/// 마지막 시도의 문제(없으면 None) — 화면이 「지키는 중」이라고 거짓말하지 않게.
static OWN_BACKUP_PROBLEM: Mutex<Option<String>> = Mutex::new(None);
fn own_backup_at() -> Option<i64> {
    let me = owner()?;
    OWN_BACKUP.lock().unwrap_or_else(|e| e.into_inner()).as_ref().filter(|(p, _)| *p == me).map(|(_, t)| *t)
}
fn own_backup_file() -> std::path::PathBuf {
    file().with_file_name("my-notes-backup.json")
}
/// 이 컴퓨터 이야기 이름이 폰·웹 지갑(같은 12단어)과 같은 이름인가. 다르면 폰 글은 모을 수 없다(GPT P2).
fn owner_same_as_wallet() -> bool {
    crate::talk::key_on_disk().is_some_and(|(_, from, path)| from == "seed" && path == crate::identity::PATH_PERSON)
}

/// 지금 들고 있는 글을 **바로** 디스크에 쓴다(임시 파일 → 이름 바꾸기). 성공해야 true.
fn flush_now() -> bool {
    let snapshot = peek(|v| v.clone());
    let Ok(body) = serde_json::to_vec(&json!({ "events": snapshot })) else { return false };
    let tmp = file().with_extension("json.tmp");
    std::fs::write(&tmp, body).is_ok() && std::fs::rename(&tmp, file()).is_ok()
}

/// 한 릴레이에서 쪽을 넘기며 끝까지 읽는다(내 글 또는 나에게 온 겉봉). 릴레이마다 따로 넘긴다(합친 뒤 넘기면 가운데가 빠진다 — GPT P2).
/// 같은 초의 글이 쪽 경계에 걸려도 빠지지 않게 `until` 은 그 초를 **포함**하고, 이미 본 id 로 진전을 잰다.
/// 11-08: 쪽마다 바로 저장한다 — 오래 걸리는 첫 모으기 동안에도 모은 수가 화면에 늘어난다(진행 표시, docs/SYNC-ARCHIVE.md §2).
/// 반환: (새로 저장한 수, 끝까지 읽었나).
async fn read_from<F, Fut>(mut page: F) -> Result<(usize, bool), String>
where
    F: FnMut(Option<i64>) -> Fut,
    Fut: std::future::Future<Output = Result<(Vec<Value>, bool), String>>,
{
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut added = 0usize;
    let mut until: Option<i64> = None;
    for _ in 0..60 {
        let (events, eose) = page(until).await?;
        if !eose { return Ok((added, false)); }
        let mut fresh = 0usize;
        let mut oldest = i64::MAX;
        for e in events.iter() {
            if let Some(at) = e.get("created_at").and_then(Value::as_i64) { oldest = oldest.min(at); }
            if let Some(id) = e.get("id").and_then(Value::as_str) {
                if seen.insert(id.to_string()) {
                    fresh += 1;
                    if keep_one(e.clone()) { added += 1; }
                }
            }
        }
        if events.len() < crate::nostrpub::INBOX_PAGE { return Ok((added, true)); }
        if fresh == 0 {
            // 한 초에 한 쪽보다 많은 글 — 그 초를 건너뛰면 빠지니 끝까지 못 읽은 것으로 남긴다.
            return Ok((added, false));
        }
        until = Some(oldest);
    }
    Ok((added, false))
}

/// 하나 저장하고, **새로** 들어왔으면 true.
fn keep_one(e: Value) -> bool {
    let had = e.get("id").and_then(Value::as_str).map(|id| peek(|v| v.iter().any(|x| x.get("id").and_then(Value::as_str) == Some(id)))).unwrap_or(true);
    store(e).0 && !had
}

/// 마지막으로 **끝까지** 모은 쪽지(겉봉) (주인 공개키, 시각). 글과 따로 — 0.9.25 까지 글만 모았으니 첫 쪽지 모으기는 처음부터.
static OWN_DM_BACKUP: Mutex<Option<(String, i64)>> = Mutex::new(None);
fn own_dm_backup_at() -> Option<i64> {
    let me = owner()?;
    OWN_DM_BACKUP.lock().unwrap_or_else(|e| e.into_inner()).as_ref().filter(|(p, _)| *p == me).map(|(_, t)| *t)
}
/// 지난 글 모으기(처음·이름이 바뀐 뒤·사흘 넘게 꺼져 있던 뒤) 중인가. 화면이 「모으는 중」을 띄운다.
static BACKFILL: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
/// 사흘 넘게 못 모았으면 「지난 글 모으기」로 본다(화면 표시만 다르다 — 읽는 범위는 늘 지난번 끝 이틀 전부터).
const BACKFILL_GAP_SECS: i64 = 3 * 86_400;
/// 겉봉 시각은 최대 이틀 앞당겨진다(NIP-59) — 지난번 끝에서 사흘 전부터 다시 읽는다.
const WRAP_OVERLAP_SECS: i64 = 3 * 86_400;
fn is_backfill(notes_at: Option<i64>, dms_at: Option<i64>, now: i64) -> bool {
    [notes_at, dms_at].iter().any(|t| t.is_none_or(|t| now - t > BACKFILL_GAP_SECS))
}

/// 이 컴퓨터에 보관된 (내 글 kind 1 수, 나에게 온 쪽지 겉봉 수).
fn kept_counts() -> (usize, usize) {
    let Some(me) = owner() else { return (0, 0) };
    peek(|v| {
        let notes = v.iter().filter(|x| x.get("pubkey").and_then(Value::as_str) == Some(me.as_str()) && x.get("kind").and_then(Value::as_i64) == Some(1)).count();
        let dms = v.iter().filter(|x| owner_wrap(x, Some(&me))).count();
        (notes, dms)
    })
}

fn save_backup_marks(me: &str, notes_at: Option<i64>, dms_at: Option<i64>) {
    let tmp = own_backup_file().with_extension("json.tmp");
    let body = json!({ "at": notes_at, "dm_at": dms_at, "pubkey": me });
    if std::fs::write(&tmp, serde_json::to_vec(&body).unwrap_or_default()).is_ok() {
        let _ = std::fs::rename(&tmp, own_backup_file());
    }
}

/// 한 번 모으기. 처음(또는 주인이 바뀐 뒤)에는 옛 글까지, 그다음부터는 지난번 끝낸 시각 이틀(쪽지는 사흘) 전부터.
/// 내 글과 **나에게 온 쪽지 겉봉**(봉한 그대로, 풀지 않는다)을 함께 모은다.
/// 모든 닿은 릴레이를 끝까지 읽고 **디스크에 쓴 뒤에만** 「끝냄」을 남긴다(GPT P2).
pub(crate) async fn backup_my_notes_once() -> Result<usize, String> {
    let Some(me) = owner() else { return Ok(0) };
    let (notes_at, dms_at) = (own_backup_at(), own_dm_backup_at());
    let since = notes_at.map(|t| t - 2 * 86_400);
    let dm_since = dms_at.map(|t| t - WRAP_OVERLAP_SECS);
    let started = now_secs();
    BACKFILL.store(is_backfill(notes_at, dms_at, started), std::sync::atomic::Ordering::Relaxed);
    struct Done;
    impl Drop for Done { fn drop(&mut self) { BACKFILL.store(false, std::sync::atomic::Ordering::Relaxed); } }
    let _done = Done;
    use futures_util::future::join_all;
    let urls = crate::nostrpub::outside_relays();
    let (got, got_dm) = tokio::join!(
        join_all(urls.iter().map(|u| read_from(|until| crate::nostrpub::read_mine_page(u, &me, &MINE_KINDS, since, until)))),
        join_all(urls.iter().map(|u| read_from(|until| crate::nostrpub::read_wraps_page(u, &me, dm_since, until)))),
    );
    let reached = got.iter().chain(got_dm.iter()).filter(|r| r.is_ok()).count();
    if reached == 0 {
        *OWN_BACKUP_PROBLEM.lock().unwrap_or_else(|e| e.into_inner()) = Some("바깥 릴레이에 닿지 못했습니다".into());
        return Err("바깥 릴레이에 닿지 못했습니다".into());
    }
    let all_done = |rs: &[Result<(usize, bool), String>]| rs.iter().any(|r| r.is_ok()) && rs.iter().all(|r| match r { Ok((_, done)) => *done, Err(_) => true });
    let (complete, dm_complete) = (all_done(&got), all_done(&got_dm));
    let added: usize = got.iter().chain(got_dm.iter()).filter_map(|r| r.as_ref().ok().map(|(n, _)| *n)).sum();
    if !flush_now() {
        *OWN_BACKUP_PROBLEM.lock().unwrap_or_else(|e| e.into_inner()) = Some("디스크에 쓰지 못했습니다".into());
        return Err("디스크에 쓰지 못했습니다".into());
    }
    if complete { *OWN_BACKUP.lock().unwrap_or_else(|e| e.into_inner()) = Some((me.clone(), started)); }
    if dm_complete { *OWN_DM_BACKUP.lock().unwrap_or_else(|e| e.into_inner()) = Some((me.clone(), started)); }
    if complete || dm_complete { save_backup_marks(&me, own_backup_at(), own_dm_backup_at()); }
    *OWN_BACKUP_PROBLEM.lock().unwrap_or_else(|e| e.into_inner()) =
        if complete && dm_complete { None } else { Some("아직 다 모으지 못했습니다(다음에 이어서)".into()) };
    Ok(added)
}

/// 앱이 켜져 있는 동안: 30초 뒤 한 번, 그다음 15분마다 내 글을 모은다. 프로세스마다 한 번만 시작한다(GPT P2).
pub fn start_own_backup() {
    static STARTED: std::sync::Once = std::sync::Once::new();
    STARTED.call_once(|| {
        if let Ok(s) = std::fs::read_to_string(own_backup_file()) {
            if let Ok(v) = serde_json::from_str::<Value>(&s) {
                if let Some(p) = v.get("pubkey").and_then(Value::as_str) {
                    if let Some(t) = v.get("at").and_then(Value::as_i64) {
                        *OWN_BACKUP.lock().unwrap_or_else(|e| e.into_inner()) = Some((p.to_string(), t));
                    }
                    if let Some(t) = v.get("dm_at").and_then(Value::as_i64) {
                        *OWN_DM_BACKUP.lock().unwrap_or_else(|e| e.into_inner()) = Some((p.to_string(), t));
                    }
                }
            }
        }
        tauri::async_runtime::spawn(async {
            tokio::time::sleep(std::time::Duration::from_secs(30)).await;
            loop {
                let _ = backup_my_notes_once().await;
                tokio::time::sleep(std::time::Duration::from_secs(15 * 60)).await;
            }
        });
    });
}

// ── 연결 방(RV6) — 디스크에 안 쓰는 이벤트 ─────────────────────────────────
//
// 🔴 폰↔데스크톱 연결 이벤트는 `relay-events.json` 에 **남기지 않는다.** 내용은 봉해져
//    있지만 「언제 어느 기기끼리」는 남기 때문이다. 메모리에만, 24시간, 최대 2,000개.

const EPHEMERAL_MAX: usize = 2_000;
const EPHEMERAL_TTL_SECS: i64 = 24 * 3600;
/// 한 연결이 1분에 올릴 수 있는 연결 이벤트(규격 §7: 1분 180개).
const PAIR_PER_MINUTE: usize = 180;
/// 한 연결이 동시에 열어 둘 수 있는 구독.
const MAX_SUBS: usize = 16;

static EPHEMERAL: Mutex<std::collections::VecDeque<Value>> = Mutex::new(std::collections::VecDeque::new());
static LIVE: std::sync::OnceLock<tokio::sync::broadcast::Sender<Value>> = std::sync::OnceLock::new();

/// 열린 구독에 바로 밀어 주는 방송. 느린 연결은 밀린 것을 잃는다(최대 256개 뒤처짐) —
/// 그래도 다음 REQ 에서 저장분·메모리분으로 다시 받는다.
fn live() -> &'static tokio::sync::broadcast::Sender<Value> {
    LIVE.get_or_init(|| tokio::sync::broadcast::channel(256).0)
}

fn now_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// 연결 방 이벤트를 메모리에 두고 열린 구독에 밀어 준다. 디스크에는 안 쓴다.
pub fn publish_ephemeral(e: Value) {
    {
        let mut g = EPHEMERAL.lock().unwrap_or_else(|x| x.into_inner());
        let cut = now_secs() - EPHEMERAL_TTL_SECS;
        g.retain(|x| x.get("created_at").and_then(Value::as_i64).unwrap_or(0) >= cut);
        if g.iter().any(|x| x.get("id") == e.get("id")) {
            return;
        }
        g.push_back(e.clone());
        while g.len() > EPHEMERAL_MAX {
            g.pop_front();
        }
    }
    let _ = live().send(e);
}

fn room_of(e: &Value) -> &str {
    e.get("tags").and_then(|t| t.get(0)).and_then(|t| t.get(1)).and_then(Value::as_str).unwrap_or("")
}

/// 연결 방 글이면 서명을 확인하고(메모리에 두고·연결 쪽에 넘기고) 답을 준다. 아니면 None.
fn take_pairing_event(e: &Value) -> Option<(bool, String)> {
    if e.get("kind").and_then(Value::as_i64) != Some(42) || !crate::pairing::net::is_pairing_room(room_of(e)) {
        return None;
    }
    if crate::pairing::proto::verify_chat_event(e).is_err() {
        return Some((false, "invalid: 서명이 맞지 않습니다".into()));
    }
    publish_ephemeral(e.clone());
    crate::pairing::net::on_event(e.clone());
    Some((true, String::new()))
}

/// 손님·다른 가게가 붙는 자리. `wss://…/relay`
///
/// REQ 에는 저장분(+연결 방 메모리분)을 주고 EOSE 를 보낸 뒤, **구독을 열어 둔다** —
/// 그 뒤로 들어오는 맞는 글을 바로 밀어 준다(CLOSE 하거나 연결이 끊길 때까지).
/// 한꺼번에 붙어 있을 수 있는 연결 수. 폰 몇 대·손님 화면·다른 가게면 넉넉하다.
/// 🔴 없으면 같은 Wi-Fi(또는 터널)의 누군가가 소켓을 수천 개 열어 계산대 메모리를 다 쓴다.
const MAX_CONNS: usize = 64;
static OPEN_CONNS: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);

/// 연결 한 자리. 떨어질 때(연결이 끝날 때) 자리를 돌려준다.
struct ConnSlot;
impl ConnSlot {
    fn take() -> Option<Self> {
        use std::sync::atomic::Ordering::SeqCst;
        OPEN_CONNS
            .fetch_update(SeqCst, SeqCst, |n| (n < MAX_CONNS).then_some(n + 1))
            .ok()
            .map(|_| ConnSlot)
    }
}
impl Drop for ConnSlot {
    fn drop(&mut self) {
        OPEN_CONNS.fetch_sub(1, std::sync::atomic::Ordering::SeqCst);
    }
}

/// 11-07 감사: 연결마다 200개 제한은 다시 붙으면 풀린다 → 열쇠마다 한 시간 200개를 연결과 상관없이 센다.
const AUTHOR_PER_HOUR: u32 = 200;
fn author_budget_ok(pubkey: &str) -> bool {
    use std::sync::Mutex;
    static BUDGET: std::sync::OnceLock<Mutex<std::collections::HashMap<String, (std::time::Instant, u32)>>> = std::sync::OnceLock::new();
    let mut m = BUDGET.get_or_init(Default::default).lock().unwrap_or_else(|e| e.into_inner());
    let now = std::time::Instant::now();
    if m.len() > 20_000 {
        m.retain(|_, (at, _)| now.duration_since(*at).as_secs() < 3600);
    }
    let slot = m.entry(pubkey.to_string()).or_insert((now, 0));
    if now.duration_since(slot.0).as_secs() >= 3600 {
        *slot = (now, 0);
    }
    slot.1 += 1;
    slot.1 <= AUTHOR_PER_HOUR
}

/// 11-07 감사: 말 없는 연결이 자리 64개를 영영 붙잡지 않게 — 60초마다 ping, 150초 동안 아무것도(pong 포함) 안 오면 끊는다.
const PING_EVERY_SECS: u64 = 60;
const SILENT_CLOSE_SECS: u64 = 150;

pub async fn serve(mut ws: WebSocket) {
    let Some(_slot) = ConnSlot::take() else {
        let _ = ws
            .send(Message::Text(json!(["NOTICE", "지금 연결이 너무 많습니다. 잠시 뒤에 다시 붙어 주세요."]).to_string().into()))
            .await;
        let _ = ws.send(Message::Close(None)).await;
        return;
    };
    // 🔴 **한 연결이 쏟아붓는 것을 막는다.** 서명이 맞는 글은 누구나 얼마든지
    // 만들 수 있다(열쇠 하나면 된다). 막지 않으면 한 사람이 5,000개를 채워
    // **이 가게의 진짜 공지를 밀어내고**, 그 사이 디스크와 CPU 를 다 쓴다.
    //
    // 한 번 붙어서 200개까지. 더 보내려면 다시 붙어야 하고, 그건 눈에 띈다.
    // (연결 방 글은 오래 붙어 있는 폰이 쓰므로 따로 1분 180개로 센다.)
    let mut sent = 0usize;
    let mut pair_times: std::collections::VecDeque<std::time::Instant> = Default::default();
    let mut subs: Vec<(String, Vec<Value>)> = Vec::new();
    let mut rx = live().subscribe();
    let mut heard = std::time::Instant::now();
    let mut ping = tokio::time::interval(std::time::Duration::from_secs(PING_EVERY_SECS));
    ping.tick().await;
    loop {
        let msg = tokio::select! {
            m = ws.recv() => { heard = std::time::Instant::now(); m },
            _ = ping.tick() => {
                let pinged = tokio::time::timeout(std::time::Duration::from_secs(10), ws.send(Message::Ping(Vec::new().into()))).await;
                if heard.elapsed().as_secs() >= SILENT_CLOSE_SECS || !matches!(pinged, Ok(Ok(()))) {
                    let _ = ws.send(Message::Close(None)).await;
                    return;
                }
                continue;
            }
            pushed = rx.recv() => {
                match pushed {
                    Ok(e) => {
                        let hits: Vec<String> = subs.iter().filter(|(_, fs)| fs.iter().any(|f| matches(&e, f))).map(|(id, _)| id.clone()).collect();
                        for id in hits {
                            // 읽지 않는 상대에게 밀다가 영영 멈추지 않게 10초 제한.
                            let pushed = tokio::time::timeout(std::time::Duration::from_secs(10), ws.send(Message::Text(json!(["EVENT", id, e]).to_string().into()))).await;
                            if !matches!(pushed, Ok(Ok(()))) {
                                return;
                            }
                        }
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {}
                    Err(_) => {}
                }
                continue;
            }
        };
        let Some(Ok(msg)) = msg else { break };
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
                let pairing = e.get("kind").and_then(Value::as_i64) == Some(42)
                    && crate::pairing::net::is_pairing_room(room_of(&e));
                let limited = if pairing {
                    let now = std::time::Instant::now();
                    while pair_times.front().map(|t| now.duration_since(*t).as_secs() >= 60).unwrap_or(false) {
                        pair_times.pop_front();
                    }
                    pair_times.push_back(now);
                    pair_times.len() > PAIR_PER_MINUTE
                } else {
                    sent += 1;
                    // 열쇠별 예산은 **서명이 맞는 글만** 센다(11-07 재검사: 남의 공개키를 적은 가짜 글로 그 사람을 막을 수 있었다).
                    sent > 200 || (verify(&e) && !author_budget_ok(e.get("pubkey").and_then(Value::as_str).unwrap_or("")))
                };
                if limited {
                    let _ = ws
                        .send(Message::Text(
                            json!(["OK", id, false, "rate-limited: 한 번에 너무 많습니다"])
                                .to_string()
                                .into(),
                        ))
                        .await;
                    continue;
                }
                let (ok, why) = match take_pairing_event(&e) {
                    Some(r) => r,
                    None => {
                        let r = store(e.clone());
                        // 새로 저장한 것만 열린 구독에 민다(「이미 있습니다」·「옛 글」은 안 민다).
                        if r.0 && r.1.is_empty() {
                            let _ = live().send(e);
                        }
                        r
                    }
                };
                let _ = ws
                    .send(Message::Text(
                        json!(["OK", id, ok, why]).to_string().into(),
                    ))
                    .await;
            }
            "REQ" => {
                let Some(sub) = a.get(1).and_then(Value::as_str) else { continue };
                let sub = sub.chars().take(64).collect::<String>();
                // 걸러 낼 조건이 여럿 올 수 있다. 하나라도 맞으면 보낸다.
                let filters: Vec<Value> = a.as_array().map(|x| x.iter().skip(2).take(10).cloned().collect()).unwrap_or_default();
                let mut hits = peek(|v| {
                    v.iter()
                        .filter(|e| filters.iter().any(|f| matches(e, f)))
                        .cloned()
                        .collect::<Vec<Value>>()
                });
                {
                    let g = EPHEMERAL.lock().unwrap_or_else(|x| x.into_inner());
                    let cut = now_secs() - EPHEMERAL_TTL_SECS;
                    hits.extend(
                        g.iter()
                            .filter(|e| e.get("created_at").and_then(Value::as_i64).unwrap_or(0) >= cut)
                            .filter(|e| filters.iter().any(|f| matches(e, f)))
                            .cloned(),
                    );
                }
                // 최신이 먼저. 손님 화면이 첫 줄만 봐도 맞게.
                hits.sort_by_key(|e| -(e.get("created_at").and_then(Value::as_i64).unwrap_or(0)));
                let cap = filters
                    .iter()
                    .filter_map(|f| f.get("limit").and_then(Value::as_u64))
                    .max()
                    .unwrap_or(200)
                    .min(500) as usize;
                hits.truncate(cap);
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
                // 구독을 열어 둔다(같은 이름이면 바꾼다). 한 연결에 16개까지 — 넘으면 가장 옛것을 닫는다.
                subs.retain(|(id, _)| *id != sub);
                subs.push((sub, filters));
                while subs.len() > MAX_SUBS {
                    subs.remove(0);
                }
            }
            // 구독을 끊는다.
            "CLOSE" => {
                if let Some(sub) = a.get(1).and_then(Value::as_str) {
                    subs.retain(|(id, _)| id != sub);
                }
            }
            _ => {}
        }
    }
}

/// 지금 몇 개를 들고 있나. 화면의 표시등이 읽는다.
#[tauri::command]
pub fn relay_status() -> Value {
    let n = with(|v| v.len());
    let (mine, dms) = kept_counts();
    json!({
        // 내 글 지키기: 이 컴퓨터에 남은 내 글 수 · 마지막으로 바깥 릴레이에서 모아 온 시각(초, 없으면 null).
        "my_notes": mine,
        // 11-08 쪽지 보관·지난 글 모으기 진행(docs/SYNC-ARCHIVE.md §2). 전체 수는 모르므로 모은 수만.
        "my_dms": dms,
        "my_backfill": BACKFILL.load(std::sync::atomic::Ordering::Relaxed),
        "my_backup_at": own_backup_at(),
        "my_same_as_wallet": owner_same_as_wallet(),
        "my_backup_problem": OWN_BACKUP_PROBLEM.lock().unwrap_or_else(|e| e.into_inner()).clone(),
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

    /// 주인·저장소 전역값을 만지는 시험은 하나씩 돈다.
    static OWNER_TEST_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    /// 11-07 GPT P1: 주인 글이라도 ① 대소문자만 바꾼 id 는 안 받고 ② 서명 밖 칸은 버리고 ③ 크기 한도는 그대로다.
    #[test]
    fn owner_exception_keeps_id_and_size_rules() {
        use super::*;
        let _g = OWNER_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let me_sk = [11u8; 32];
        let me = crate::shopkey::pubkey_of(&me_sk).unwrap();
        *TEST_OWNER.lock().unwrap() = Some(me.clone());
        *STORE.lock().unwrap() = Some(vec![]);
        let tags = json!([["t", "ravencoin"]]);
        let e = crate::shopkey::sign_with(&me_sk, 1, tags.clone(), "내 글", now_secs()).unwrap();
        let mut upper = e.clone();
        upper["id"] = json!(e["id"].as_str().unwrap().to_uppercase());
        assert!(!store(upper).0, "대문자 id 를 받았다");
        let mut padded = e.clone();
        padded["junk"] = json!("x".repeat(1_000_000));
        assert!(store(padded).0, "서명이 맞는 주인 글을 버렸다");
        assert!(peek(|v| v.iter().all(|x| x.get("junk").is_none())), "서명 밖 칸이 저장됐다");
        let big = crate::shopkey::sign_with(&me_sk, 1, tags, &"가".repeat(MAX_EVENT_BYTES), now_secs()).unwrap();
        assert!(!store(big).0, "크기 한도를 넘는 주인 글을 받았다");
        *TEST_OWNER.lock().unwrap() = None;
        *STORE.lock().unwrap() = None;
    }

    /// 11-07 내 글 지키기: 주인 글은 90일이 지나도 받고, 남의 글이 넘쳐도 밀려나지 않는다. 남의 옛 글은 여전히 안 받는다.
    #[test]
    fn owner_notes_are_kept_old_and_never_evicted() {
        use super::*;
        let _g = OWNER_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let me_sk = [7u8; 32];
        let other_sk = [9u8; 32];
        let me = crate::shopkey::pubkey_of(&me_sk).unwrap();
        *TEST_OWNER.lock().unwrap() = Some(me.clone());
        *STORE.lock().unwrap() = Some(vec![]);
        let old = now_secs() - 200 * 86_400;
        let tags = json!([["t", "ravencoin"]]);
        let mine_old = crate::shopkey::sign_with(&me_sk, 1, tags.clone(), "옛날에 쓴 내 글", old).unwrap();
        assert!(store(mine_old.clone()).0, "주인의 200일 된 글을 버렸다");
        let other_old = crate::shopkey::sign_with(&other_sk, 1, tags.clone(), "남의 옛 글", old).unwrap();
        assert!(!store(other_old).0, "남의 200일 된 글을 받았다");
        // 주인이 남보다 많이 써도, 넘칠 때는 남의 글부터 빠진다.
        with(|v| {
            for i in 0..MAX_EVENTS {
                v.push(json!({ "id": format!("o{i}"), "pubkey": "b".repeat(64), "kind": 1, "created_at": now_secs() }));
            }
            for i in 0..(MAX_EVENTS + 10) {
                v.push(json!({ "id": format!("m{i}"), "pubkey": me.clone(), "kind": 1, "created_at": now_secs() }));
            }
        });
        let fresh = crate::shopkey::sign_with(&other_sk, 1, tags, "남의 새 글", now_secs()).unwrap();
        let _ = store(fresh);
        let (mine_n, others_n, has_old) = peek(|v| (
            v.iter().filter(|x| x.get("pubkey").and_then(Value::as_str) == Some(me.as_str())).count(),
            v.iter().filter(|x| x.get("pubkey").and_then(Value::as_str) != Some(me.as_str())).count(),
            v.iter().any(|x| x.get("id") == mine_old.get("id")),
        ));
        assert_eq!(mine_n, MAX_EVENTS + 11, "주인 글이 밀려났다");
        assert!(has_old, "주인 옛 글이 밀려났다");
        assert_eq!(others_n, MAX_EVENTS, "남의 글 한도가 지켜지지 않았다");
        *TEST_OWNER.lock().unwrap() = None;
        *STORE.lock().unwrap() = None;
    }

    /// 방 이름·설명 수정(kind 41)도 레이븐 이야기다 — 우리 릴레이가 안 남기면 이 컴퓨터는
    /// 공개 릴레이가 다 막힌 날 고친 이름을 못 본다. 누가 고칠 수 있는지는 talk.rs 가 본다.
    #[test]
    fn room_meta_edits_are_kept_as_talk() {
        assert!(KINDS.contains(&41) && TALK_KINDS.contains(&41));
        let e = json!({ "kind": 41, "content": "{\"name\":\"방\"}", "tags": [["e", "a".repeat(64), "", "root"], ["t", "ravencoin"]] });
        assert_eq!(super::smells_bad(&e), None, "레이븐 표가 붙은 방 수정 글을 버린다");
    }
    /// 11-06: 이름표·팔로우·북마크·지우기 요청도 받는다 — 단 레이븐 이야기를 남긴 사람 것만, 사람마다 하나만.
    #[test]
    fn person_lists_are_kept_only_for_raven_people() {
        use super::*;
        for k in [0, 3, 5, 10003] { assert!(KINDS.contains(&k), "kind {k} 를 받는다"); }
    }

    #[test]
    fn node_keeper_badge_only_from_check_server() {
        let pk = crate::node_keeper::NODE_KEEPER_PUB;
        let a = format!("30009:{pk}:rv-node-keeper");
        assert!(node_keeper_badge(&json!({ "kind": 30009, "pubkey": pk, "tags": [["d", "rv-node-keeper"]], "content": "" })));
        assert!(node_keeper_badge(&json!({ "kind": 8, "pubkey": pk, "tags": [["a", a], ["p", "b".repeat(64)]], "content": "" })));
        assert!(smells_bad(&json!({ "kind": 30009, "pubkey": pk, "tags": [["d", "rv-node-keeper"]], "content": "" })).is_none());
        // 다른 열쇠 · 다른 배지 · 다른 종류는 안 된다
        assert!(!node_keeper_badge(&json!({ "kind": 30009, "pubkey": "c".repeat(64), "tags": [["d", "rv-node-keeper"]], "content": "" })));
        assert!(!node_keeper_badge(&json!({ "kind": 30009, "pubkey": pk, "tags": [["d", "other"]], "content": "" })));
        assert!(!node_keeper_badge(&json!({ "kind": 1, "pubkey": pk, "tags": [["d", "rv-node-keeper"]], "content": "" })));
        // 릴레이 지킴이(docs/KEEPER-THANKS.md §1)도 같은 열쇠 것만 받는다.
        let ra = format!("30009:{pk}:rv-relay-keeper");
        assert!(node_keeper_badge(&json!({ "kind": 30009, "pubkey": pk, "tags": [["d", "rv-relay-keeper"]], "content": "" })));
        assert!(node_keeper_badge(&json!({ "kind": 8, "pubkey": pk, "tags": [["a", ra], ["p", "b".repeat(64)]], "content": "" })));
        assert!(smells_bad(&json!({ "kind": 8, "pubkey": pk, "tags": [["a", format!("30009:{pk}:rv-relay-keeper")]], "content": "" })).is_none());
        assert!(!node_keeper_badge(&json!({ "kind": 30009, "pubkey": "c".repeat(64), "tags": [["d", "rv-relay-keeper"]], "content": "" })));
        assert!(!node_keeper_badge(&json!({ "kind": 8, "pubkey": pk, "tags": [["a", "30009:x:rv-relay-keeper"]], "content": "" })));
        // kind 8 에 d 만 · kind 30009 에 a 만 달린 것은 안 된다.
        assert!(!node_keeper_badge(&json!({ "kind": 8, "pubkey": pk, "tags": [["d", "rv-relay-keeper"]], "content": "" })));
        assert!(!node_keeper_badge(&json!({ "kind": 30009, "pubkey": pk, "tags": [["a", format!("30009:{pk}:rv-relay-keeper")]], "content": "" })));
        assert!(replaceable(0) && replaceable(3) && replaceable(10003) && !replaceable(1) && !replaceable(30402));
        let stranger = "9".repeat(64);
        // 처음 보는 사람의 팔로우·북마크는 저장하지 않는다(남의 SNS 창고가 되지 않게).
        assert!(person_smells_bad(&json!({ "kind": 3, "pubkey": stranger, "tags": [["p", "a".repeat(64)]], "content": "" })).is_some());
        assert!(person_smells_bad(&json!({ "kind": 10003, "pubkey": stranger, "tags": [], "content": "x" })).is_some());
        // 이름표는 ravencoin 표가 있으면 처음 보는 사람이어도 받는다(폰·데스크탑이 단다).
        assert!(person_smells_bad(&json!({ "kind": 0, "pubkey": stranger, "tags": [["t", "ravencoin"]], "content": "{}" })).is_none());
        assert!(person_smells_bad(&json!({ "kind": 0, "pubkey": stranger, "tags": [], "content": "{}" })).is_some());
        // 지우기 요청은 대화 잣대 — ravencoin 표가 있어야 한다.
        assert!(smells_bad(&json!({ "kind": 5, "pubkey": stranger, "tags": [["e", "a".repeat(64)], ["t", "ravencoin"]], "content": "" })).is_none());
        assert!(smells_bad(&json!({ "kind": 5, "pubkey": stranger, "tags": [["e", "a".repeat(64)]], "content": "" })).is_some());
    }
    /// 릴레이 나누기 §6: 10002 는 레이븐·릴레이 나누기 표가 있을 때만, 사람마다 가장 새 것 하나만 남는다.
    #[test]
    fn relay_lists_are_kept_with_raven_tags_and_replaced() {
        use super::*;
        let _g = OWNER_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        *TEST_OWNER.lock().unwrap() = None;
        *STORE.lock().unwrap() = Some(vec![]);
        assert!(KINDS.contains(&10002) && PERSON_KINDS.contains(&10002) && replaceable(10002));
        let sk = [0x31u8; 32];
        let at = now_secs();
        let first = crate::relay_share::build_list(&sk, Some("wss://a.trycloudflare.com/api/relay"), at - 100).unwrap();
        assert_eq!(store(first.clone()), (true, String::new()), "레이븐볼트 릴레이 목록을 버린다");
        let second = crate::relay_share::build_list(&sk, Some("wss://b.trycloudflare.com/api/relay"), at).unwrap();
        assert_eq!(store(second.clone()), (true, String::new()));
        let kept = peek(|v| v.iter().filter(|x| x["kind"] == 10002).cloned().collect::<Vec<_>>());
        assert_eq!(kept.len(), 1, "사람마다 하나만 남아야 한다");
        assert_eq!(kept[0]["id"], second["id"]);
        // 옛 목록이 뒤늦게 와도 새 것을 덮지 않는다.
        assert!(store(first).0);
        assert_eq!(peek(|v| v.iter().filter(|x| x["kind"] == 10002).count()), 1);
        assert_eq!(peek(|v| v.iter().find(|x| x["kind"] == 10002).unwrap()["id"].clone()), second["id"]);
        // 표 없는 남의 10002 는 저장하지 않는다(남의 SNS 창고가 되지 않게).
        let plain = crate::shopkey::sign_with(&[0x32u8; 32], 10002, json!([["r", "wss://relay.example.com"]]), "", at).unwrap();
        assert!(!store(plain).0);
        // 릴레이 나누기 표만 있어도 받는다.
        let only_share = crate::shopkey::sign_with(&[0x33u8; 32], 10002, json!([["r", "wss://relay.example.com"], ["t", "ravenvault-relay"]]), "", at).unwrap();
        assert!(store(only_share).0);
        *STORE.lock().unwrap() = None;
    }
    /// 🔴 0.9.17 장터 물건(30402 + rv-swap)을 우리 릴레이가 버리고 있었다(regtest 실측 11-07) —
    /// 본문이 JSON 이 아니고 d 가 자산 이름이 아니라서. 모양이 맞는 물건만 받고, 가게 공지 규칙은 그대로.
    #[test]
    fn swap_listings_are_kept_but_only_well_formed() {
        use super::*;
        let tx = "ab".repeat(32);
        let good = json!({ "kind": 30402, "content": "설명 글", "tags": [
            ["d", format!("rvswap:{tx}:1")], ["title", "물건"], ["summary", "설명"], ["published_at", "1"],
            ["price", "2.50000000", "RVN"], ["t", "playx"], ["t", "ravencoin"], ["t", "rv-swap"], ["t", "game"],
            ["status", "active"], ["asset", "RVTESTGAME", "1"], ["outpoint", tx, "1"], ["pay", "mPayAddr111"],
            ["swap", "0200aa", "v1"],
        ]});
        assert_eq!(smells_bad(&good), None, "모양이 맞는 맞교환 물건을 버린다");
        let mut bad = good.clone();
        bad["tags"][0] = json!(["d", format!("rvswap:{tx}:0")]);
        assert!(smells_bad(&bad).is_some(), "d 와 동전이 다른 물건을 받는다");
        let mut big = good.clone();
        big["content"] = json!("x".repeat(MAX_EVENT_BYTES));
        assert!(smells_bad(&big).is_some(), "너무 큰 물건 글을 받는다");
        // rv-swap 표가 없는 30402 는 여전히 가게 공지 규칙(본문 JSON·d 자산 이름).
        let mut shop = good.clone();
        shop["tags"].as_array_mut().unwrap().retain(|t| t[1] != "rv-swap");
        assert!(smells_bad(&shop).is_some(), "가게 공지 규칙이 풀렸다");
    }

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
    fn connection_slots_are_capped_and_returned() {
        let before = OPEN_CONNS.load(std::sync::atomic::Ordering::SeqCst);
        let mut held = Vec::new();
        while let Some(s) = ConnSlot::take() {
            held.push(s);
            assert!(held.len() <= MAX_CONNS);
        }
        assert_eq!(OPEN_CONNS.load(std::sync::atomic::Ordering::SeqCst), MAX_CONNS);
        drop(held.pop());
        assert!(ConnSlot::take().is_some(), "끝난 연결의 자리는 돌아온다");
        drop(held);
        assert_eq!(OPEN_CONNS.load(std::sync::atomic::Ordering::SeqCst), before);
    }

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

    /// RV6: 열린 구독은 새 글을 **바로** 받는다(REQ→EOSE 뒤에도). 연결 방 글은 디스크
    /// 저장소에 안 들어가고 메모리에만 있다. CLOSE 한 구독에는 안 간다.
    #[tokio::test]
    async fn live_push_and_pairing_rooms_stay_off_disk() {
        use futures_util::{SinkExt, StreamExt};
        use tokio_tungstenite::tungstenite::Message as M;
        let _g = crate::paths::TEST_ENV.lock().unwrap_or_else(|e| e.into_inner());
        let home = crate::paths::test_fixture_root().join(format!("rv6-relay-{}", std::process::id()));
        std::fs::create_dir_all(&home).unwrap();
        std::env::set_var("PLAYX_RAVEN_HOME", &home);

        let app = axum::Router::new().route(
            "/api/relay",
            axum::routing::get(|ws: axum::extract::ws::WebSocketUpgrade| async { ws.max_message_size(512 * 1024).max_frame_size(512 * 1024).on_upgrade(serve) }),
        );
        let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = l.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(l, app).await.unwrap() });
        let url = format!("ws://{addr}/api/relay");

        use crate::pairing::proto::*;
        let keys = DeviceKeys::generate().unwrap();
        let pair = Room { key: [5u8; 32], id: "ab".repeat(32) };
        let chat = Room { key: [6u8; 32], id: "cd".repeat(32) };
        crate::pairing::net::test_mark_room(&pair.id);
        let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs() as i64;
        let pe = seal_text(&pair, &keys, "{\"v\":1}", now, SealOpts::default()).unwrap().to_value();
        let ce = seal_text(&chat, &keys, "hello raven", now, SealOpts::default()).unwrap().to_value();

        let (mut a, _) = tokio_tungstenite::connect_async(url.as_str()).await.unwrap();
        a.send(M::Text(json!(["REQ", "s1", { "kinds": [42], "#e": [pair.id, chat.id] }]).to_string().into())).await.unwrap();
        type Ws = tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;
        async fn next(a: &mut Ws) -> Option<Value> {
            match tokio::time::timeout(std::time::Duration::from_secs(3), a.next()).await {
                Ok(Some(Ok(M::Text(t)))) => Some(serde_json::from_str::<Value>(&t).unwrap()),
                _ => None,
            }
        }
        assert_eq!(next(&mut a).await.unwrap(), json!(["EOSE", "s1"]));

        let (mut b, _) = tokio_tungstenite::connect_async(url.as_str()).await.unwrap();
        for e in [&pe, &ce] {
            b.send(M::Text(json!(["EVENT", e]).to_string().into())).await.unwrap();
            let ok = next(&mut b).await.unwrap();
            assert_eq!(ok[2], true, "{ok}");
        }
        // A 는 둘 다 바로 받는다.
        let got1 = next(&mut a).await.expect("live push 1");
        let got2 = next(&mut a).await.expect("live push 2");
        let ids: Vec<Value> = vec![got1[2]["id"].clone(), got2[2]["id"].clone()];
        assert!(ids.contains(&pe["id"]) && ids.contains(&ce["id"]), "{ids:?}");

        // 연결 방 글: 디스크 저장소에는 없고 메모리에만. 대화 방 글: 저장소에 있다.
        assert!(!peek(|v| v.iter().any(|x| x["id"] == pe["id"])), "pairing event must not be persisted");
        assert!(peek(|v| v.iter().any(|x| x["id"] == ce["id"])));
        assert!(EPHEMERAL.lock().unwrap().iter().any(|x| x["id"] == pe["id"]));

        // 새로 붙은 C 가 REQ 하면 메모리분도 받는다.
        let (mut c, _) = tokio_tungstenite::connect_async(url.as_str()).await.unwrap();
        c.send(M::Text(json!(["REQ", "s2", { "#e": [pair.id] }]).to_string().into())).await.unwrap();
        assert_eq!(next(&mut c).await.unwrap()[2]["id"], pe["id"]);
        assert_eq!(next(&mut c).await.unwrap(), json!(["EOSE", "s2"]));

        // CLOSE 한 구독에는 더 안 간다.
        a.send(M::Text(json!(["CLOSE", "s1"]).to_string().into())).await.unwrap();
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        let pe2 = seal_text(&pair, &keys, "{\"v\":2}", now, SealOpts::default()).unwrap().to_value();
        b.send(M::Text(json!(["EVENT", pe2]).to_string().into())).await.unwrap();
        assert_eq!(next(&mut b).await.unwrap()[2], true);
        assert_eq!(next(&mut c).await.unwrap()[2]["id"], pe2["id"], "open sub still gets it");
        assert!(next(&mut a).await.is_none(), "closed sub gets nothing");
        // 서명 틀린 연결 방 글은 거절.
        let mut bad = pe2.clone();
        bad["sig"] = json!("0".repeat(128));
        b.send(M::Text(json!(["EVENT", bad]).to_string().into())).await.unwrap();
        assert_eq!(next(&mut b).await.unwrap()[2], false);
        std::env::remove_var("PLAYX_RAVEN_HOME");
    }

    /// 11-08 쪽지 보관: 겉봉(1059)은 p 가 주인일 때만 받는다 — 이틀 앞당긴 시각·오래된 겉봉도. 남에게 가는 겉봉·주인 없음은 거절.
    #[test]
    fn relay_accepts_gift_wraps_only_for_owner() {
        use super::*;
        let _g = OWNER_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let me = crate::shopkey::pubkey_of(&[7u8; 32]).unwrap();
        let stranger = crate::shopkey::pubkey_of(&[8u8; 32]).unwrap();
        let once = [11u8; 32];
        *TEST_OWNER.lock().unwrap() = Some(me.clone());
        *STORE.lock().unwrap() = Some(vec![]);
        let fuzzed = now_secs() - 2 * 86_400 + 5;
        let to_me = crate::shopkey::sign_with(&once, 1059, json!([["p", me.clone()]]), "sealed-1", fuzzed).unwrap();
        assert!(store(to_me.clone()).0, "주인에게 온 겉봉을 버렸다");
        let old = crate::shopkey::sign_with(&once, 1059, json!([["p", me.clone()]]), "sealed-old", now_secs() - 400 * 86_400).unwrap();
        assert!(store(old).0, "주인에게 온 옛 겉봉을 버렸다(보관)");
        let to_other = crate::shopkey::sign_with(&once, 1059, json!([["p", stranger.clone()]]), "sealed-2", now_secs()).unwrap();
        assert!(!store(to_other).0, "남에게 가는 겉봉을 저장했다");
        let no_p = crate::shopkey::sign_with(&once, 1059, json!([]), "sealed-3", now_secs()).unwrap();
        assert!(!store(no_p).0, "받는 이 없는 겉봉을 저장했다");
        let big = crate::shopkey::sign_with(&once, 1059, json!([["p", me.clone()]]), &"x".repeat(MAX_EVENT_BYTES), now_secs()).unwrap();
        assert!(!store(big).0, "크기 한도를 넘는 겉봉을 받았다");
        let mut forged = to_me.clone();
        forged["content"] = json!("changed");
        assert!(!store(forged).0, "서명이 안 맞는 겉봉을 받았다");
        assert_eq!(kept_counts(), (0, 2));
        // 주인이 없으면(이야기 이름 아직 없음) 어떤 겉봉도 안 받는다.
        *TEST_OWNER.lock().unwrap() = None;
        assert!(!owner_wrap(&to_me, None));
        *TEST_OWNER.lock().unwrap() = Some(me.clone());
        // 겉봉 한도: 넘치면 가장 오래된 겉봉부터 빠지고, 내 글·남의 글은 건드리지 않는다.
        with(|v| {
            for i in 0..MAX_WRAPS {
                v.push(json!({ "id": format!("w{i}"), "pubkey": "c".repeat(64), "kind": 1059, "created_at": 1_000 + i as i64, "tags": [["p", me.clone()]] }));
            }
        });
        let newest = crate::shopkey::sign_with(&once, 1059, json!([["p", me.clone()]]), "sealed-new", now_secs()).unwrap();
        assert!(store(newest.clone()).0);
        let (n, has_new, has_first) = peek(|v| (
            v.iter().filter(|x| owner_wrap(x, Some(&me))).count(),
            v.iter().any(|x| x.get("id") == newest.get("id")),
            v.iter().any(|x| x.get("id") == Some(&json!("w0"))),
        ));
        assert_eq!(n, MAX_WRAPS, "겉봉 한도가 지켜지지 않았다");
        assert!(has_new && !has_first, "가장 오래된 겉봉부터 빠져야 한다");
        *TEST_OWNER.lock().unwrap() = None;
        *STORE.lock().unwrap() = None;
    }

    /// 11-08 지킴이가 겉봉을 쪽 넘기며 모은다: 쪽마다 바로 저장하고, 새로 저장한 수만 센다. 남의 겉봉이 섞여 와도 저장하지 않는다.
    #[tokio::test]
    async fn keeper_collects_gift_wraps_page_by_page() {
        use super::*;
        let _g = OWNER_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let me = crate::shopkey::pubkey_of(&[7u8; 32]).unwrap();
        let other = crate::shopkey::pubkey_of(&[8u8; 32]).unwrap();
        *TEST_OWNER.lock().unwrap() = Some(me.clone());
        *STORE.lock().unwrap() = Some(vec![]);
        let base = now_secs() - 10 * 86_400;
        let page_n = crate::nostrpub::INBOX_PAGE;
        // 첫 쪽: 꽉 찬 200장(내 것) · 둘째 쪽: 3장(내 것 2 + 남의 것 1, 남의 것은 거절).
        let first: Vec<Value> = (0..page_n).map(|i| crate::shopkey::sign_with(&[12u8; 32], 1059, json!([["p", me.clone()]]), &format!("s{i}"), base + 1_000 + i as i64).unwrap()).collect();
        let second: Vec<Value> = vec![
            crate::shopkey::sign_with(&[13u8; 32], 1059, json!([["p", me.clone()]]), "a", base + 10).unwrap(),
            crate::shopkey::sign_with(&[13u8; 32], 1059, json!([["p", me.clone()]]), "b", base + 11).unwrap(),
            crate::shopkey::sign_with(&[13u8; 32], 1059, json!([["p", other.clone()]]), "c", base + 12).unwrap(),
        ];
        let calls = std::sync::Mutex::new(Vec::<Option<i64>>::new());
        let (added, done) = read_from(|until| {
            calls.lock().unwrap().push(until);
            let out = if until.is_none() { first.clone() } else { second.clone() };
            async move { Ok((out, true)) }
        }).await.unwrap();
        assert!(done, "끝까지 읽었는데 덜 읽었다고 했다");
        assert_eq!(added, page_n + 2, "새로 저장한 수가 틀렸다");
        assert_eq!(calls.lock().unwrap().clone(), vec![None, Some(base + 1_000)], "until 로 쪽을 넘겨야 한다");
        assert_eq!(kept_counts().1, page_n + 2);
        // 다시 모으면 이미 있는 것은 새로 센 수에 안 들어간다.
        let (again, _) = read_from(|_| { let out = second.clone(); async move { Ok((out, true)) } }).await.unwrap();
        assert_eq!(again, 0);
        // EOSE 없이 끊기면 「덜 읽음」.
        let (_, partial) = read_from(|_| async { Ok((vec![], false)) }).await.unwrap();
        assert!(!partial);
        *TEST_OWNER.lock().unwrap() = None;
        *STORE.lock().unwrap() = None;
    }

    /// 11-08 진행 표시: 처음·사흘 넘게 못 모은 뒤면 「지난 글 모으는 중」, 아니면 아니다. 수는 보관된 것만 센다.
    #[test]
    fn backfill_progress_counts() {
        use super::*;
        let _g = OWNER_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let now = 2_000_000_000;
        assert!(is_backfill(None, None, now), "처음은 지난 글 모으기");
        assert!(is_backfill(Some(now - 60), None, now), "쪽지를 아직 한 번도 안 모았다(0.9.25 에서 올라온 컴퓨터)");
        assert!(is_backfill(Some(now - 4 * 86_400), Some(now - 60), now), "나흘 꺼져 있었다");
        assert!(!is_backfill(Some(now - 900), Some(now - 900), now), "15분마다 도는 평소 모으기");
        let me_sk = [7u8; 32];
        let me = crate::shopkey::pubkey_of(&me_sk).unwrap();
        *TEST_OWNER.lock().unwrap() = Some(me.clone());
        *STORE.lock().unwrap() = Some(vec![]);
        let tags = json!([["t", "ravencoin"]]);
        for i in 0..3 { assert!(store(crate::shopkey::sign_with(&me_sk, 1, tags.clone(), &format!("글 {i}"), now_secs() - i).unwrap()).0); }
        assert!(store(crate::shopkey::sign_with(&me_sk, 3, json!([]), "", now_secs()).unwrap()).0);
        assert!(store(crate::shopkey::sign_with(&[14u8; 32], 1059, json!([["p", me.clone()]]), "x", now_secs()).unwrap()).0);
        assert_eq!(kept_counts(), (3, 1), "글은 kind 1 만, 쪽지는 나에게 온 겉봉만");
        let st = relay_status();
        assert_eq!(st["my_notes"], 3);
        assert_eq!(st["my_dms"], 1);
        assert_eq!(st["my_backfill"], false);
        *TEST_OWNER.lock().unwrap() = None;
        *STORE.lock().unwrap() = None;
    }
}
