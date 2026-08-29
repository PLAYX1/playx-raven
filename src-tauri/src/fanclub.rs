//! 팬클럽 — **산 사람들이 모이는 방.**
//!
//! ## 무엇을 푸는가
//!
//! 대표님: "음악을 팔았는데 팬이 이 음악의 채팅방에 있다거나, 1집·2집·싱글마다
//! 채팅방을 폴더별로 관리하거나, 폴더별로 새 음반이 나왔다고 메시지를 보내거나,
//! X.com 링크를 보내거나, 팬들을 관리할 수 있는 기능. 음악도 미술도 다른 것들도."
//!
//! ## 🔴 새로 만드는 것이 없다 — 이미 있는 부품을 잇는다
//!
//! - 1집·2집·싱글 = **자산**(`issue2.rs`). 폴더가 아니라 자산이 칸막이다.
//! - 파는 것 = **원자적 스왑**(`swap.rs`). 우리가 돈을 안 만진다.
//! - 방 = **자산으로 잠근 방**(`talk.rs`). 이미 된다. 우리는 그것을 **자산 기준으로
//!   묶어 보여 주고, 여러 방에 한 번에 공지**할 뿐이다.
//! - X 링크 = 글 본문에 붙인다(`tunnel.rs` 의 공유는 화면 쪽 길이라 여기서는
//!   주소만 검사하고 글에 담는다).
//!
//! ## 🔴 못 하는 것을 못 한다고 말한다 — 이 파일의 절반이 그 일이다
//!
//! ### ① 「1년 회원권」처럼 **기간을 정할 수 없다**
//!
//! 자산은 한 번 보내면 **그 사람 것**이다. 우리는 그걸 도로 뺏을 수 없고,
//! 뺏을 수 있게 만들 수도 없다(그럴 수 있으면 그건 소유가 아니다). 그래서
//! 「1년 뒤 만료되는 팬클럽」은 이 구조로 **안 된다.** 굳이 하려면 해마다
//! 새 자산(FANCLUB.2026 → FANCLUB.2027)을 내고 그 해의 방을 새 자산으로 거는
//! 것뿐이고, 그건 「만료」가 아니라 「올해 것을 새로 사는 것」이다.
//!
//! ### ② 자산 방은 **「쓰기」만 막고 「읽기」는 누구나**다
//!
//! `talk.rs` 가 막는 것은 글을 **쓰는** 쪽이다. 읽는 것은 아무나 된다 —
//! 자산이 없는 사람도 방의 글을 전부 본다. 팬을 모으는 데는 오히려 그게
//! 나을 수 있다(구경하다 사게 된다). 그러나 **비밀방이 아니다.** 그걸
//! 안 적어 두면 누군가 여기에 비밀을 쓴다.
//!
//! ### ③ 우리 규칙은 **우리 앱과 우리 릴레이 안에서만** 산다
//!
//! damus·nos.lol 같은 공개 릴레이는 우리 자산 규칙을 모른다. 다른 Nostr
//! 프로그램으로는 자산 없이도 그 방에 글을 쓸 수 있다.
//!
//! ### ④ 팬의 **지갑 주소는 돌려주지 않는다**
//!
//! 「누가 샀나」는 체인에 공개되어 있지만, 그걸 우리 화면에 **명단으로**
//! 펼쳐 놓는 것은 다른 일이다. 주소 하나가 그 사람의 모든 거래 내역이다.
//! 그래서 `fan_holders` 는 **숫자만** 돌려준다.

use serde_json::{json, Value};

/// 한 번에 보낼 수 있는 방의 수.
///
/// 방마다 릴레이에 왕복이 한 번씩 생긴다. 한꺼번에 물어보긴 하지만(아래
/// `join_all`), 수백 개를 열면 릴레이 쪽에서 우리를 끊는다. 넘치는 것은
/// 조용히 버리지 않고 **못 보냈다고 돌려준다.**
const MAX_ROOMS: usize = 20;

/// 공지 한 편의 길이. `talk.rs` 의 한계와 같게 맞춘다 — 거기서 잘리면
/// 방마다 똑같은 실패가 스무 번 뜬다. 여기서 미리 한 번 말한다.
const TEXT_MAX: usize = 8000;

/// 링크 길이. 이보다 긴 주소는 사람이 만든 것이 아니다.
const LINK_MAX: usize = 500;

// ─────────────────────────────────────────────────────────────────────────
// 못 하는 것 — 화면이 그대로 띄워야 하는 말
//
// 🔴 응답마다 담는다. 여기 한 곳에만 적어 두고 응답에서 빼면, 화면은
//    영영 모르고 사장은 「1년 회원권」을 팔겠다고 한다.
// ─────────────────────────────────────────────────────────────────────────

/// ① 기간을 정할 수 없다.
const FACT_NO_EXPIRY: &str = "「1년 회원권」처럼 기간을 정할 수는 없습니다. \
자산은 한 번 보내면 그분 것이고, 우리가 도로 가져올 수 없습니다. \
해마다 끊고 싶으시면 새 자산(예: FANCLUB.2026 → FANCLUB.2027)을 내고 \
그 해의 방을 새 자산으로 거는 방법뿐입니다.";

/// ② 읽기는 누구나 된다.
const FACT_READ_IS_OPEN: &str = "자산으로 잠근 방은 「쓰기」만 막습니다. \
「읽기」는 누구나 됩니다 — 자산이 없는 분도 이 방의 글을 전부 볼 수 있습니다. \
팬을 모으는 데는 그게 나을 수 있지만, 비밀 이야기는 여기 쓰시면 안 됩니다.";

/// ③ 우리 규칙은 우리 앱 안에서만 산다.
const FACT_OTHER_APPS: &str = "이 규칙은 우리 앱과 우리 릴레이가 지킵니다. \
다른 Nostr 프로그램으로는 자산 없이도 그 방에 글을 쓸 수 있습니다. \
「비밀방」이 아니라 「단골 방」입니다.";

/// ④ 방에 붙은 자산 이름은 그 방을 만든 사람이 스스로 적은 것이다.
const FACT_ROOM_CLAIM: &str = "방에 붙은 자산 이름은 그 방을 만든 분이 \
스스로 적은 것입니다. 남이 같은 자산 이름으로 방을 하나 더 만들 수도 있으니, \
보내시기 전에 방 이름을 확인해 주세요.";

/// ⑤ 사람 수가 아니라 주소 수다.
const FACT_ADDRESS_NOT_PERSON: &str = "주소의 개수입니다. 한 분이 여러 주소에 \
나눠 가질 수 있고, 거래소 주소 하나가 여러 분의 몫을 들고 있을 수도 있습니다. \
사람 수와 정확히 같지는 않습니다.";

/// ⑥ 주소는 안 돌려준다.
const FACT_NO_ADDRESS_LIST: &str = "누가 가졌는지 주소 목록은 보여 드리지 \
않습니다. 주소 하나가 그분의 모든 거래 내역이라, 팬의 사생활입니다.";

/// 응답마다 붙이는 「못 하는 것」 묶음.
fn limits() -> Value {
    json!({
        "no_expiry": FACT_NO_EXPIRY,
        "read_is_open": FACT_READ_IS_OPEN,
        "other_apps": FACT_OTHER_APPS,
        "room_claim": FACT_ROOM_CLAIM,
    })
}

// ─────────────────────────────────────────────────────────────────────────
// 검사 — 밖에서 들어온 값을 그대로 믿지 않는다
// ─────────────────────────────────────────────────────────────────────────

/// 레이븐 자산 이름에 쓸 수 있는 글자.
///
/// 알파벳 대문자와 숫자, 그리고 `.`(가지) `_`(밑줄) `!`(소유권 표)
/// `/`(하위 자산) `#`(유일 자산) `~`(대화 통로) `^`(재발행 표) 다.
/// **`-` 는 없다** — 사람들이 제일 자주 틀리는 자리라 오류 문구에 적어 둔다.
const ASSET_CHARS: &str = "._!/#~^";

/// 자산 이름을 다듬는다. 화면에서 소문자로 들어와도 받는다.
///
/// ⚠️ 여기서 막는 것은 **오타**지 공격이 아니다(이름은 JSON 으로 나가므로
///    따옴표가 섞여도 형식이 깨지지 않는다). 그래도 검사한다 — 오타 하나로
///    노드에 왕복을 스무 번 하고 「알 수 없는 오류」를 보는 것보다,
///    여기서 **무엇이 틀렸는지** 말하는 쪽이 낫다.
fn norm_asset(raw: &str) -> Result<String, String> {
    let a = raw.trim().to_uppercase();
    if a.is_empty() {
        return Err("자산 이름이 비어 있습니다.".into());
    }
    if a.chars().count() > 80 {
        return Err(format!("자산 이름이 너무 깁니다: {}", &a.chars().take(20).collect::<String>()));
    }
    if let Some(bad) = a
        .chars()
        .find(|c| !c.is_ascii_uppercase() && !c.is_ascii_digit() && !ASSET_CHARS.contains(*c))
    {
        return Err(format!(
            "자산 이름에 쓸 수 없는 글자가 있습니다: {bad}\n\
             자산 이름은 영문 대문자와 숫자, 그리고 . _ ! / # ~ ^ 만 됩니다. \
             빼기표(-)와 띄어쓰기, 한글은 쓸 수 없습니다.\n\
             넣으신 것: {a}"
        ));
    }
    Ok(a)
}

/// 같이 보낼 링크(X 글 주소 같은 것)를 검사한다.
///
/// ## 🔴 왜 검사하나 — 이 글자는 **남의 화면에서 눌린다**
///
/// 공지는 방에 남고, 우리 앱과 남의 Nostr 앱이 그걸 그린다. 대부분의 앱은
/// 본문의 주소를 **누를 수 있는 링크로** 만든다. 거기에 `javascript:` 나
/// `data:` 로 시작하는 것이 들어가면, 그건 주소가 아니라 **남의 화면에서
/// 도는 코드**다. 우리가 보낸 글이 그 통로가 되면 안 된다.
///
/// `http`·`https` 만 받는다. `file:` 도 막는다 — 받는 사람 컴퓨터의 파일을
/// 가리키는 주소는 우리가 보낼 이유가 없다.
fn check_link(raw: &str) -> Result<String, String> {
    let l = raw.trim();
    if l.is_empty() {
        return Ok(String::new());
    }
    if l.chars().count() > LINK_MAX {
        return Err(format!("링크가 너무 깁니다. {LINK_MAX}자 아래로 줄여 주세요."));
    }
    // 사이에 낀 공백·줄바꿈은 주소를 두 동강 낸다. 받는 화면에서는 앞부분만
    // 링크가 되고 뒷부분은 글자로 남는다 — 보낸 사람은 보냈다고 안다.
    if l.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return Err("링크에 띄어쓰기나 줄바꿈이 들어 있습니다. 주소만 붙여넣어 주세요.".into());
    }
    let low = l.to_ascii_lowercase();
    if !low.starts_with("http://") && !low.starts_with("https://") {
        return Err(format!(
            "링크는 http:// 또는 https:// 로 시작해야 합니다.\n\
             넣으신 것: {l}"
        ));
    }
    Ok(l.to_string())
}

/// 공지 본문. 링크는 **줄을 바꿔** 붙인다.
///
/// 붙여 쓰면 앞 글자와 주소가 이어져 링크가 안 걸린다(`보세요https://…`).
fn announce_body(text: &str, link: &str) -> String {
    let t = text.trim();
    if link.is_empty() {
        t.to_string()
    } else {
        format!("{t}\n{link}")
    }
}

// ─────────────────────────────────────────────────────────────────────────
// 자산 색인 — 노드가 **오류를 정상 응답으로** 돌려주는 자리
// ─────────────────────────────────────────────────────────────────────────

/// 자산 색인이 꺼져 있나.
///
/// 🔴 이 노드는 `-assetindex` 가 없을 때 **오류가 아니라 오류 문장을 정상
///    응답으로** 돌려준다: "_This rpc call is not functional unless
///    -assetindex is enabled…". `is_ok()` 만 보면 통과해 버리고, 화면에는
///    영문 한 줄이 뜬다. (`rewards.rs` 가 같은 함정을 이미 밟았다.)
fn needs_index(v: &Value) -> bool {
    let t = v.as_str().unwrap_or("");
    t.contains("assetindex") || t.starts_with("_This rpc call is not functional")
}

/// 자산 색인을 켜라는 말. 얼마나 걸리는지까지 적는다 — 「켜세요」만
/// 적어 두면 장사 중에 켰다가 몇 시간 동안 노드가 멈춘다.
const FIX_INDEX: &str = "자산 색인이 꺼져 있어 몇 분이 가졌는지 셀 수 없습니다. \
「이 컴퓨터 → 고급 → 자산 전체 색인」을 켜고 노드를 다시 시작하세요. \
이미 다 받아 놓은 컴퓨터라면 처음부터 다시 훑느라 몇 시간 걸립니다 — 밤에 켜세요.";

/// 자산 몇 개 중 몇 개에 방이 있나 — **를 사람이 읽는 말로.**
///
/// 🔴 셈이 맞는다고 문장이 맞는 것이 아니다. 「자산 2개 중 0개」는 사실이지만
///    **고장으로 읽힌다**(대표님 지적, 2026-08-30). 방이 없는 것은 상태지
///    오류가 아니므로, 없을 때는 다음에 할 일을 적는다.
fn rooms_say(total: usize, with_room: usize) -> String {
    if total == 0 {
        return "이 지갑에는 자산이 없습니다. 음반이나 그림을 먼저 자산으로 내셔야 팬클럽 방을 걸 수 있습니다.".into();
    }
    if with_room == 0 {
        return format!(
            "자산 {total}개가 있습니다. 아직 팬 방은 없습니다 — 방을 열고 싶은 자산에서 「방 만들기」를 누르세요."
        );
    }
    if with_room >= total {
        return format!("자산 {total}개 모두 팬 방이 있습니다.");
    }
    format!("자산 {total}개 중 {with_room}개에 팬 방이 있습니다.")
}

/// **못 셌을 때의 답.** 오류가 아니라 「아직 모릅니다」다.
///
/// 노드가 어디까지 훑었는지를 같이 적는다. 「나중에 다시」만 적으면 사장은
/// 언제가 나중인지 모르고 오 분마다 누른다 — 87% 라고 적혀 있으면 기다린다.
///
/// ⚠️ 진행률을 **못 읽어도** 이 함수는 답을 돌려준다. 진행률은 곁들이인데
///    그걸 못 읽었다고 팬 수 화면까지 죽으면 같은 병을 한 겹 더 만드는 것이다.
async fn soft_count(asset: &str, why: &str) -> Value {
    let 어디까지 = match crate::raven::call_rpc("getblockchaininfo", json!([])).await {
        Ok(v) => v
            .get("verificationprogress")
            .and_then(Value::as_f64)
            .map(|p| format!("지금 장부를 {:.0}%까지 훑었습니다.", (p * 100.0).min(100.0))),
        Err(_) => None,
    };
    json!({
        "asset": asset,
        // 🔴 `null` 이다. `0` 을 주면 화면이 「가진 분이 없습니다」라고 적는다 —
        //    모르는 것과 없는 것은 다르다.
        "holders": Value::Null,
        "counted": false,
        "say": format!("{asset} — 몇 분이 가졌는지는 아직 못 셌습니다."),
        "why": match &어디까지 {
            Some(p) => format!("{why} {p} 다 훑으면 셀 수 있습니다."),
            None => format!("{why} 노드가 장부를 다 훑으면 셀 수 있습니다."),
        },
        // 🔴 **못 세도 공지는 보낼 수 있다.** 이걸 안 적으면 사장이 멈춘다.
        "ok_without": "이 숫자가 없어도 공지를 보내는 데는 지장이 없습니다.",
        "limits": limits(),
    })
}

/// 가진 사람 수만 뽑는다.
///
/// ## 🔴 주소는 여기서 끝난다
///
/// 이 함수가 돌려주는 것은 **숫자 하나**다. 노드가 주소 목록으로 답하더라도
/// 개수만 세고 목록은 여기서 버린다 — 돌려주는 형(型)이 숫자라서, 실수로
/// 주소를 밖에 흘리려면 **함수 서명을 고쳐야만** 한다. 주석이 아니라 형이
/// 지키게 해 둔 것이다.
fn holders_count(v: &Value) -> Option<i64> {
    if let Some(n) = v.as_i64() {
        return Some(n);
    }
    // 노드가 실수(f64)로 답하는 판이 있다.
    if let Some(f) = v.as_f64() {
        return Some(f as i64);
    }
    // 옛 노드는 `onlytotal` 을 무시하고 주소 목록으로 답한다. 그때도 세기는
    // 센다. 목록은 이 줄 밖으로 못 나간다.
    if let Some(o) = v.as_object() {
        return Some(o.len() as i64);
    }
    None
}

// ─────────────────────────────────────────────────────────────────────────
// 자산 ↔ 방 묶기
// ─────────────────────────────────────────────────────────────────────────

/// 내 자산과 방 목록을 받아 **자산 기준으로** 묶는다.
///
/// 노드도 릴레이도 안 부르는 순수 함수다 — 그래야 노드 없는 기계에서
/// 시험할 수 있다.
///
/// ## 소유권 표(`이름!`)를 목록에서 빼는 이유
///
/// 자산을 낸 사람은 `PLAYX` 와 함께 `PLAYX!` 를 갖는다. 그건 **팔 물건이
/// 아니라 발행 권한**이다(딱 한 개뿐이고, 넘기면 발행 권한이 넘어간다).
/// 팬클럽 목록에 끼워 두면 사장이 그걸 방에 걸거나 팔려고 한다.
/// 그래서 목록에서는 빼고, **「내가 낸 자산인가」 표시로만** 쓴다.
fn groups(names: &[String], rooms: &[Value]) -> Vec<Value> {
    let mut owner: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut fan: Vec<String> = Vec::new();
    for n in names {
        let up = n.trim().to_uppercase();
        if up.is_empty() {
            continue;
        }
        match up.strip_suffix('!') {
            Some(base) if !base.is_empty() => {
                owner.insert(base.to_string());
            }
            // 이름이 「!」 하나뿐인 것은 자산이 아니다. 목록에 넣으면 화면에
            // 이름 없는 빈 칸이 뜨고, 사장은 그걸 눌러 본다.
            Some(_) => continue,
            None => fan.push(up),
        }
    }
    fan.sort();
    fan.dedup();

    fan.into_iter()
        .map(|a| {
            let mut mine: Vec<Value> = rooms
                .iter()
                .filter(|r| {
                    r.get("asset")
                        .and_then(Value::as_str)
                        .map(|s| s.trim().to_uppercase())
                        .is_some_and(|s| s == a)
                })
                .map(|r| {
                    json!({
                        "id": r.get("id").cloned().unwrap_or(Value::Null),
                        "name": r.get("name").cloned().unwrap_or(Value::Null),
                        "about": r.get("about").cloned().unwrap_or(Value::Null),
                        "created_at": r.get("created_at").cloned().unwrap_or(Value::Null),
                    })
                })
                .collect();
            // 새 방이 위로. 사장이 방을 다시 만들었으면 그게 지금 쓰는 방이다.
            mine.sort_by_key(|r| -r.get("created_at").and_then(Value::as_i64).unwrap_or(0));
            let n = mine.len();
            json!({
                "asset": a,
                "i_issued": owner.contains(&a),
                "rooms": mine,
                "room_count": n,
                // 방이 없으면 팬클럽이 아직 없는 것이다. 화면이 「방 만들기」를
                // 띄울 수 있게 갈라서 말한다.
                "need_room": n == 0,
            })
        })
        .collect()
}

// ─────────────────────────────────────────────────────────────────────────
// 명령
// ─────────────────────────────────────────────────────────────────────────

/// **내 자산마다 방이 있는지.** 1집·2집·싱글 = 자산 = 방.
///
/// ## 🔴 못 읽었으면 「없다」가 아니라 「못 읽었다」다
///
/// 노드가 장부를 다시 훑는 중이거나 꺼져 있으면 `listmyassets` 가 답을
/// 못 한다. 그때 빈 목록을 돌려주고 화면이 「자산이 없습니다」라고 적으면,
/// 사장은 자기 음반이 사라진 줄 안다. 그래서 `assets_why`·`rooms_why` 를
/// 따로 돌려주고, `ok` 는 **둘 다 읽었을 때만** 참이다.
#[tauri::command]
pub async fn fan_rooms() -> Value {
    let (names, assets_why) = match crate::raven::call_rpc("listmyassets", json!([])).await {
        Ok(v) => (
            v.as_object()
                .map(|o| o.keys().cloned().collect::<Vec<String>>())
                .unwrap_or_default(),
            None,
        ),
        Err(e) => (Vec::new(), Some(e)),
    };
    // 방은 릴레이에서 온다 — 노드와 다른 길이라 따로 실패한다.
    let (rooms, rooms_why) = match crate::talk::talk_rooms().await {
        Ok(v) => (v.as_array().cloned().unwrap_or_default(), None),
        Err(e) => (Vec::new(), Some(e)),
    };

    let g = groups(&names, &rooms);
    let with_room = g
        .iter()
        .filter(|x| x.get("room_count").and_then(Value::as_i64).unwrap_or(0) > 0)
        .count();

    // 🔴 **「자산 2개 중 0개」는 실패로 읽힌다**(대표님 지적, 2026-08-30).
    //
    //    사실은 아무 문제도 없다 — 방을 아직 안 연 것뿐이다. 그런데 「0개」는
    //    무언가 고장 났다는 소리로 들리고, 사장은 없는 고장을 찾기 시작한다.
    //    **숫자가 사실이어도 읽히는 뜻이 틀리면 그건 틀린 문장이다.**
    //
    //    방이 없는 것은 상태지 오류가 아니므로, 없을 때는 다음에 할 일을
    //    적는다. 다 있을 때는 「모두」라고 적는다 — 「2개 중 2개」도 셈이다.
    let say = if let Some(w) = &assets_why {
        format!("자산을 읽지 못했습니다: {w}\n노드가 꺼져 있거나 장부를 다시 훑는 중일 수 있습니다. 자산이 없다는 뜻이 아닙니다.")
    } else if let Some(w) = &rooms_why {
        format!("자산은 {}개 읽었지만 방 목록을 읽지 못했습니다: {w}", g.len())
    } else {
        rooms_say(g.len(), with_room)
    };

    json!({
        "ok": assets_why.is_none() && rooms_why.is_none(),
        "groups": g,
        "with_room": with_room,
        // null 이면 잘 읽은 것이다. 문자열이면 그 이유를 화면이 그대로 띄운다.
        "assets_why": assets_why,
        "rooms_why": rooms_why,
        "say": say,
        "limits": limits(),
    })
}

/// **여러 방에 한 번에 공지한다.** X 링크를 같이 담는다.
///
/// ## 🔴 한 방이 실패해도 나머지는 보낸다
///
/// 방 다섯 곳에 새 음반을 알리는데 세 번째에서 릴레이가 안 받았다고 통째로
/// 멈추면, 사장은 **어디까지 갔는지 모른 채** 다시 누른다. 그러면 앞의 두 방에
/// 같은 글이 두 번 뜬다. 그래서 방마다 따로 세고, **어디에 갔고 어디에 못
/// 갔는지**를 돌려준다. 다시 보낼 때는 못 간 곳만 고르면 된다.
///
/// ## 왜 한꺼번에 보내나
///
/// 방 하나에 릴레이 왕복이 최대 7초다. 줄 세우면 스무 방에 2분이 넘고,
/// 그 화면은 아무도 안 쓴다. `join_all` 로 한꺼번에 물어 제일 느린 한 곳만큼만
/// 기다린다(`nostrpub.rs` 가 릴레이에 같은 방식을 쓴다).
///
/// ## ⚠️ 공지도 공개다
///
/// 자산 방은 **쓰기만** 막는다. 여기 적은 공지는 자산이 없는 사람도 다 본다.
/// 「팬에게만 몰래」가 아니다 — 응답의 `limits` 가 그 말을 담는다.
#[tauri::command]
pub async fn fan_announce(
    assets: Vec<String>,
    text: String,
    link: Option<String>,
) -> Result<Value, String> {
    let text = text.trim().to_string();
    if text.is_empty() {
        return Err("보낼 내용이 없습니다.".into());
    }
    let link = check_link(link.as_deref().unwrap_or(""))?;
    let body = announce_body(&text, &link);
    // 🔴 길이는 **여기서 한 번** 본다. 안 보면 방마다 똑같은 실패가 스무 번 뜬다.
    if body.len() > TEXT_MAX {
        return Err(format!(
            "공지가 너무 깁니다. {TEXT_MAX}자 아래로 줄여 주세요. (지금 {}자)",
            body.len()
        ));
    }

    // 자산 이름 다듬기. 하나가 이상해도 나머지는 보낸다 — 여기서도 전부 멈추지 않는다.
    let mut want: Vec<String> = Vec::new();
    let mut failed: Vec<Value> = Vec::new();
    for a in &assets {
        match norm_asset(a) {
            Ok(n) => {
                if !want.contains(&n) {
                    want.push(n);
                }
            }
            Err(e) => failed.push(json!({ "asset": a, "room": Value::Null, "why": e })),
        }
    }
    if want.is_empty() && failed.is_empty() {
        return Err("어느 자산의 방에 보낼지 골라 주세요.".into());
    }

    // 방 목록은 **한 번만** 읽는다. 방마다 읽으면 릴레이에 스무 번 왕복한다.
    let rooms = match crate::talk::talk_rooms().await {
        Ok(v) => v.as_array().cloned().unwrap_or_default(),
        Err(e) => {
            return Err(format!(
                "방 목록을 읽지 못해 아무 곳에도 보내지 않았습니다: {e}"
            ))
        }
    };

    // 자산 → 방. 방이 없는 자산은 못 보낸 곳으로 센다.
    let mut targets: Vec<(String, String, String)> = Vec::new(); // (자산, 방 번호, 방 이름)
    for a in &want {
        let mut found = 0usize;
        for r in &rooms {
            let is_mine = r
                .get("asset")
                .and_then(Value::as_str)
                .map(|s| s.trim().to_uppercase())
                .is_some_and(|s| &s == a);
            if !is_mine {
                continue;
            }
            let Some(id) = r.get("id").and_then(Value::as_str) else {
                continue;
            };
            let name = r
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or("이름 없는 방")
                .to_string();
            targets.push((a.clone(), id.to_string(), name));
            found += 1;
        }
        if found == 0 {
            failed.push(json!({
                "asset": a,
                "room": Value::Null,
                "room_name": Value::Null,
                "why": "이 자산으로 만든 방이 없습니다. 「이야기 → 방 만들기」에서 이 자산을 걸고 방을 먼저 만들어 주세요.",
            }));
        }
    }

    // 너무 많으면 넘치는 것을 **조용히 버리지 않는다.**
    if targets.len() > MAX_ROOMS {
        for (a, id, name) in targets.split_off(MAX_ROOMS) {
            failed.push(json!({
                "asset": a,
                "room": id,
                "room_name": name,
                "why": format!("한 번에 {MAX_ROOMS}개 방까지만 보냅니다. 이 방은 아직 안 보냈습니다 — 다시 눌러 주세요."),
            }));
        }
    }

    if targets.is_empty() {
        return Ok(json!({
            "sent": [],
            "failed": failed,
            "sent_count": 0,
            "failed_count": failed.len(),
            "say": "보낼 방이 없습니다. 못 보낸 이유를 확인해 주세요.",
            "limits": limits(),
        }));
    }

    // 🔴 **열쇠를 먼저 한 번 만들어 둔다.**
    //
    //    `talk_post` 는 처음 쓸 때 이야기 열쇠를 만든다. 그것을 스무 개
    //    동시에 부르면, 열쇠 파일이 없는 첫 사용자에게서 스무 갈래가 **각자**
    //    열쇠를 만든다. 씨앗에서 뽑히면 같은 값이라 티가 안 나지만, 씨앗을
    //    못 읽어 무작위로 만드는 경우에는 **방마다 다른 사람 이름으로** 공지가
    //    나간다. 먼저 한 번 불러 파일을 굳혀 놓는다.
    crate::talk::talk_me()?;

    // 방마다 한꺼번에. 한 곳이 실패해도 나머지는 그대로 간다.
    use futures_util::future::join_all;
    let results = join_all(
        targets
            .iter()
            .map(|(_, id, _)| crate::talk::talk_post(body.clone(), Some(id.clone()), None, None)),
    )
    .await;

    let mut sent: Vec<Value> = Vec::new();
    for ((asset, id, name), r) in targets.into_iter().zip(results) {
        match r {
            Ok(v) => sent.push(json!({
                "asset": asset,
                "room": id,
                "room_name": name,
                "event": v.get("event").and_then(|e| e.get("id")).cloned().unwrap_or(Value::Null),
            })),
            Err(e) => failed.push(json!({
                "asset": asset,
                "room": id,
                "room_name": name,
                "why": e,
            })),
        }
    }

    let say = if failed.is_empty() {
        format!("{}곳에 보냈습니다.", sent.len())
    } else if sent.is_empty() {
        format!("{}곳 모두 못 보냈습니다. 아래 이유를 봐 주세요.", failed.len())
    } else {
        format!(
            "{}곳에 보내고 {}곳에는 못 보냈습니다. 못 간 곳만 다시 보내시면 됩니다.",
            sent.len(),
            failed.len()
        )
    };

    Ok(json!({
        "sent": sent,
        "failed": failed,
        "sent_count": sent.len(),
        "failed_count": failed.len(),
        "say": say,
        // 🔴 「보냈습니다」로 끝내지 않는다. 릴레이 한 곳만 받아도 성공으로
        //    치므로, 세상 모든 앱에 뜬다는 보장은 없다.
        "caveat": "릴레이 한 곳이라도 받으면 보낸 것으로 칩니다. \
모든 릴레이와 모든 프로그램에 뜬다고 보장할 수는 없습니다.",
        "limits": limits(),
    }))
}

/// **그 자산을 가진 사람이 몇 명인지.** 숫자만이다.
///
/// ## 🔴 주소 목록은 안 돌려준다
///
/// 체인에 공개되어 있다는 것과, 우리가 그것을 **명단으로 화면에 펼치는**
/// 것은 다른 일이다. 레이븐 주소 하나면 그분이 무엇을 언제 얼마에 샀는지
/// 전부 따라갈 수 있다. 팬클럽 운영에 필요한 것은 「몇 분이 가지셨나」지
/// 「누구인가」가 아니다.
///
/// 그래서 노드에도 **`onlytotal` 을 켜서** 묻는다 — 주소가 애초에 이 앱
/// 안으로 안 들어온다. 옛 노드가 그 인자를 무시하고 목록으로 답하면
/// `holders_count` 가 개수만 세고 버린다.
#[tauri::command]
pub async fn fan_holders(asset: String) -> Result<Value, String> {
    let a = norm_asset(&asset)?;
    // 두 번째 인자가 `onlytotal` 이다. 주소 대신 개수만 달라는 뜻.
    //
    // 🔴 **못 세는 것은 고장이 아니다**(대표님 지적, 2026-08-30).
    //
    //    「노드가 20초 안에 답하지 않았습니다」가 빨간 글씨로 떴다. 그런데
    //    팬 수는 **있으면 좋은 숫자**지 팬클럽을 쓰는 조건이 아니다 —
    //    공지를 보내는 데는 이 숫자가 하나도 안 쓰인다. 빨간 글씨는
    //    「지금 아무것도 하면 안 된다」는 뜻으로 읽히니, 사장은 멈춘다.
    //
    //    그래서 못 셌을 때는 **오류로 던지지 않고** 「아직 못 셌습니다」와
    //    노드가 어디까지 훑었는지를 같이 돌려준다. 색인이 아예 꺼진 것만
    //    오류다 — 그건 사람이 켜 줘야 바뀌는 일이기 때문이다.
    let v = match crate::raven::call_rpc("listaddressesbyasset", json!([a, true])).await {
        Ok(v) => v,
        Err(e) => return Ok(soft_count(&a, &format!("노드가 답하지 않았습니다: {e}")).await),
    };
    // 🔴 색인이 꺼져 있으면 이 노드는 **오류 문장을 정상 응답으로** 준다.
    if needs_index(&v) {
        return Err(FIX_INDEX.into());
    }
    let Some(n) = holders_count(&v) else {
        return Ok(soft_count(&a, "노드가 숫자로 답하지 않았습니다.").await);
    };
    Ok(json!({
        "asset": a,
        "holders": n,
        "say": if n == 0 {
            format!("{a} 을(를) 가진 주소가 아직 없습니다.")
        } else {
            format!("{a} 을(를) 가진 주소가 {n}곳입니다.")
        },
        // 🔴 숫자만 주고 끝내면 화면이 「팬 82명」이라고 적는다. 그건 사실이 아니다.
        "caveat": FACT_ADDRESS_NOT_PERSON,
        "privacy": FACT_NO_ADDRESS_LIST,
        "limits": limits(),
    }))
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    // ─────────────────────────────────────────────────────────────────
    // 자산 이름
    // ─────────────────────────────────────────────────────────────────

    /// 🔴 **좋은 입력이 통과하는지 먼저 본다.** 막는 것만 시험하면 「전부
    ///    막는 검사」가 만점을 받는다 — 이 저장소에서 실제로 낸 사고다.
    #[test]
    fn 진짜_자산_이름은_통과한다() {
        for (넣은것, 나올것) in [
            ("PLAYX", "PLAYX"),
            // 화면에서 소문자로 들어와도 받는다. 사람은 대문자로 안 친다.
            ("playx", "PLAYX"),
            ("  PLAYX  ", "PLAYX"),
            // 1집·2집·싱글 = 하위 자산.
            ("PLAYX/ALBUM1", "PLAYX/ALBUM1"),
            ("PLAY.X", "PLAY.X"),
            ("MOOSONG_2026", "MOOSONG_2026"),
            // 그림 한 점 = 유일 자산.
            ("PLAYX#GOLD", "PLAYX#GOLD"),
            ("PLAYX!", "PLAYX!"),
            ("PLAYX~MSG", "PLAYX~MSG"),
            // 붙여넣기에는 줄바꿈이 딸려 온다. 그걸로 막으면 사장은 왜 안 되는지
            // 영영 모른다 — 앞뒤 공백·줄바꿈은 떼고 받는다.
            ("PLAYX/ALBUM1\n", "PLAYX/ALBUM1"),
        ] {
            assert_eq!(
                super::norm_asset(넣은것),
                Ok(나올것.to_string()),
                "{넣은것} 이 막혔다 — 자기 자산에 공지를 못 보낸다"
            );
        }
    }

    /// 오타는 잡고, **무엇이 틀렸는지 말한다.**
    #[test]
    fn 이상한_자산_이름은_잡힌다() {
        // ⚠️ 앞뒤 줄바꿈은 떼지만 **가운데 낀 것**은 막아야 한다.
        //    떼고 나서도 이름 안에 남아 있으면 그건 두 이름이 붙은 것이다.
        for 나쁜것 in ["", "   ", "PLAY X", "PLAY-X", "플레이엑스", "PLAYX%", "PLAY\nX"] {
            assert!(
                super::norm_asset(나쁜것).is_err(),
                "{나쁜것:?} 가 자산 이름으로 지나갔다"
            );
        }
        assert!(super::norm_asset(&"A".repeat(200)).is_err(), "너무 긴 이름이 지나갔다");
        // 제일 자주 하는 오타(빼기표)에는 무엇을 하면 되는지까지 적혀 있어야 한다.
        let e = super::norm_asset("PLAY-X").unwrap_err();
        assert!(e.contains("빼기표"), "왜 안 되는지 안 알려 준다: {e}");
    }

    // ─────────────────────────────────────────────────────────────────
    // 링크
    // ─────────────────────────────────────────────────────────────────

    /// X 링크는 이 기능의 핵심이다. 막히면 안 된다.
    #[test]
    fn 진짜_링크는_통과한다() {
        for 좋은것 in [
            "https://x.com/playx/status/1234567890",
            "https://twitter.com/playx",
            "http://127.0.0.1:8790/",
            // 사람이 대문자로 붙여넣는 일이 있다.
            "HTTPS://X.COM/PlayX",
            "https://ex.erci.se/play/r/필연?a=1&b=2",
        ] {
            assert_eq!(
                super::check_link(좋은것),
                Ok(좋은것.trim().to_string()),
                "{좋은것} 이 막혔다 — X 링크를 못 보낸다"
            );
        }
        // 링크를 안 넣는 것도 정상이다.
        assert_eq!(super::check_link(""), Ok(String::new()));
        assert_eq!(super::check_link("   "), Ok(String::new()));
    }

    /// 🔴 남의 화면에서 도는 것을 보내면 안 된다.
    #[test]
    fn 위험하거나_깨진_링크는_잡힌다() {
        for 나쁜것 in [
            "javascript:alert(1)",
            "JavaScript:alert(1)",
            "data:text/html,<script>1</script>",
            "file:///Users/gimmusong/wallet.dat",
            "ftp://example.com/a",
            // 주소만 덜렁 적으면 링크가 안 걸린다.
            "x.com/playx",
            // 사이에 낀 공백은 주소를 두 동강 낸다.
            "https://x.com/play x",
            "https://x.com/a\nhttps://evil.example",
        ] {
            assert!(
                super::check_link(나쁜것).is_err(),
                "{나쁜것:?} 가 링크로 지나갔다"
            );
        }
        assert!(
            super::check_link(&format!("https://x.com/{}", "a".repeat(super::LINK_MAX))).is_err(),
            "너무 긴 링크가 지나갔다"
        );
    }

    /// 링크는 줄을 바꿔 붙인다. 붙여 쓰면 링크가 안 걸린다.
    #[test]
    fn 링크는_줄을_바꿔_붙인다() {
        assert_eq!(
            super::announce_body("2집 나왔습니다", "https://x.com/playx/status/1"),
            "2집 나왔습니다\nhttps://x.com/playx/status/1"
        );
        // 링크가 없으면 군더더기 줄바꿈이 안 붙는다.
        assert_eq!(super::announce_body("  2집 나왔습니다  ", ""), "2집 나왔습니다");
    }

    // ─────────────────────────────────────────────────────────────────
    // 자산 ↔ 방 묶기
    // ─────────────────────────────────────────────────────────────────

    fn 방들() -> Vec<serde_json::Value> {
        vec![
            json!({ "id": "a1", "name": "1집 팬방", "about": "", "asset": "PLAYX/ALBUM1", "created_at": 100 }),
            json!({ "id": "a2", "name": "1집 팬방(새로)", "about": "", "asset": "playx/album1", "created_at": 200 }),
            json!({ "id": "b1", "name": "2집 팬방", "about": "", "asset": "PLAYX/ALBUM2", "created_at": 150 }),
            // 자산을 안 건 그냥 방. 팬클럽이 아니다.
            json!({ "id": "c1", "name": "아무나 방", "about": "", "asset": "", "created_at": 300 }),
            // 내가 안 가진 자산의 방. 내 팬클럽이 아니다.
            json!({ "id": "d1", "name": "남의 방", "about": "", "asset": "SOMEONE", "created_at": 400 }),
        ]
    }

    #[test]
    fn 자산마다_방을_묶는다() {
        let 내자산 = vec![
            "PLAYX/ALBUM1".to_string(),
            "PLAYX/ALBUM2".to_string(),
            "PLAYX/SINGLE1".to_string(),
        ];
        let g = super::groups(&내자산, &방들());
        assert_eq!(g.len(), 3, "자산 세 개가 세 묶음이어야 한다");

        let 일집 = g.iter().find(|x| x["asset"] == "PLAYX/ALBUM1").unwrap();
        // 대소문자가 달라도 같은 자산이다 — 놓치면 자기 방을 못 찾는다.
        assert_eq!(일집["room_count"], 2, "소문자로 적힌 방을 놓쳤다");
        // 새 방이 위로.
        assert_eq!(일집["rooms"][0]["id"], "a2");
        assert_eq!(일집["need_room"], false);

        let 싱글 = g.iter().find(|x| x["asset"] == "PLAYX/SINGLE1").unwrap();
        assert_eq!(싱글["room_count"], 0);
        assert_eq!(싱글["need_room"], true, "방 없는 자산을 안 알려 준다");

        // 자산을 안 건 방과 남의 자산 방은 어느 묶음에도 안 들어간다.
        for x in &g {
            for r in x["rooms"].as_array().unwrap() {
                assert_ne!(r["id"], "c1");
                assert_ne!(r["id"], "d1");
            }
        }
    }

    /// 🔴 **「자산 2개 중 0개」는 고장으로 읽힌다**(대표님 지적, 2026-08-30).
    ///
    /// 셈은 맞았다. 그런데 사장은 그 문장을 보고 없는 고장을 찾기 시작했다.
    /// 방이 없는 것은 **상태**지 오류가 아니다 — 그러면 다음에 할 일을 적어야지
    /// 「0개」를 적으면 안 된다.
    #[test]
    fn 방이_없는_것을_고장처럼_말하지_않는다() {
        let 말 = super::rooms_say(2, 0);
        assert!(
            !말.contains("0개"),
            "0개라고 적으면 고장으로 읽힌다: {말}"
        );
        assert!(
            말.contains("방 만들기"),
            "다음에 할 일이 안 적혀 있으면 사장은 멈춘다: {말}"
        );

        // 다 있을 때 「2개 중 2개」도 셈이다. 「모두」라고 말해야 사람 말이다.
        let 다있음 = super::rooms_say(2, 2);
        assert!(다있음.contains("모두"), "{다있음}");
        assert!(!다있음.contains("중"), "{다있음}");

        // 🔴 **좋은 입력도 통과하는지 같이 본다.** 막는 것만 시험하면
        //    「전부 뭉뚱그리는 함수」가 만점을 받는다.
        let 반쯤 = super::rooms_say(3, 1);
        assert!(반쯤.contains('3') && 반쯤.contains('1'), "{반쯤}");

        // 자산이 아예 없을 때는 방 이야기를 꺼내지 않는다 — 낼 것이 먼저다.
        let 없음 = super::rooms_say(0, 0);
        assert!(없음.contains("자산이 없습니다"), "{없음}");
        assert!(!없음.contains("방 만들기"), "낼 자산도 없는데 방을 권한다: {없음}");
    }

    /// 🔴 소유권 표(`이름!`)는 팔 물건이 아니라 발행 권한이다. 목록에 끼면
    ///    사장이 그걸 방에 걸거나 팔려고 한다.
    #[test]
    fn 소유권_표는_목록에서_빠지고_발행_표시로만_쓰인다() {
        let 내자산 = vec![
            "PLAYX/ALBUM1".to_string(),
            "PLAYX/ALBUM1!".to_string(),
            // 내가 산 남의 자산. 소유권 표가 없다.
            "OTHERBAND".to_string(),
        ];
        let g = super::groups(&내자산, &방들());
        let 이름들: Vec<&str> = g.iter().map(|x| x["asset"].as_str().unwrap()).collect();
        assert_eq!(이름들, vec!["OTHERBAND", "PLAYX/ALBUM1"], "소유권 표가 목록에 남았다");

        let 내것 = g.iter().find(|x| x["asset"] == "PLAYX/ALBUM1").unwrap();
        assert_eq!(내것["i_issued"], true, "내가 낸 자산인 것을 못 알아본다");
        let 남의것 = g.iter().find(|x| x["asset"] == "OTHERBAND").unwrap();
        assert_eq!(남의것["i_issued"], false, "남이 낸 자산을 내가 낸 것으로 본다");
    }

    /// 자산이 없으면 빈 묶음. 여기서 죽으면 첫 사용자가 화면을 못 연다.
    #[test]
    fn 자산이_없어도_안_죽는다() {
        assert!(super::groups(&[], &[]).is_empty());
        assert!(super::groups(&["!".to_string(), "  ".to_string()], &[]).is_empty());
        // 방 값이 엉망이어도 안 죽는다 — 릴레이에서 오는 값이라 우리가 못 정한다.
        let 엉망 = vec![json!({}), json!({ "asset": 3 }), json!("문자열"), json!(null)];
        let g = super::groups(&["PLAYX".to_string()], &엉망);
        assert_eq!(g[0]["room_count"], 0);
    }

    // ─────────────────────────────────────────────────────────────────
    // 몇 분이 가졌나
    // ─────────────────────────────────────────────────────────────────

    /// 🔴 **주소는 밖으로 안 나간다.** 노드가 목록으로 답해도 개수만 남는다.
    #[test]
    fn 가진_사람은_숫자만_센다() {
        // 요즘 노드: onlytotal 을 알아듣고 숫자로 답한다.
        assert_eq!(super::holders_count(&json!(82)), Some(82));
        assert_eq!(super::holders_count(&json!(0)), Some(0));
        assert_eq!(super::holders_count(&json!(82.0)), Some(82));
        // 옛 노드: onlytotal 을 무시하고 주소 목록으로 답한다.
        let 목록 = json!({
            "RXaddr1111111111111111111111111111": 10.0,
            "RXaddr2222222222222222222222222222": 5.0,
        });
        assert_eq!(super::holders_count(&목록), Some(2));
        // 답이 아닌 것은 「모른다」다. 0 으로 치면 화면이 「팬이 없습니다」라고 적는다.
        assert_eq!(super::holders_count(&json!(null)), None);
        assert_eq!(super::holders_count(&json!("_This rpc call is not functional")), None);
    }

    /// 🔴 색인이 꺼졌을 때 이 노드는 **오류가 아니라 오류 문장**을 준다.
    ///    그걸 못 알아보면 화면에 영문 한 줄이 뜬다.
    #[test]
    fn 색인이_꺼진_것을_알아본다() {
        assert!(super::needs_index(&json!(
            "_This rpc call is not functional unless -assetindex is enabled. To enable this, please run the wallet with -assetindex, this will require a reindex to occur"
        )));
        // ⚠️ 되받아 확인: 정상 응답은 **통과해야** 한다. 아니면 이 검사는
        //    색인이 켜진 노드에서도 늘 「꺼졌다」고 우긴다.
        assert!(!super::needs_index(&json!(82)), "정상 숫자를 색인 오류로 봤다");
        assert!(!super::needs_index(&json!({ "RXaddr": 1.0 })), "정상 목록을 색인 오류로 봤다");
        assert!(!super::needs_index(&json!(null)));
    }

    /// 못 하는 것을 **응답이 담고 있는지**. 상수만 있고 안 담으면 화면은 영영 모른다.
    #[test]
    fn 못_하는_것을_응답에_담는다() {
        let l = super::limits();
        assert!(
            l["no_expiry"].as_str().unwrap_or("").contains("기간을 정할 수는 없습니다"),
            "기간을 못 정한다는 말이 응답에 없다"
        );
        assert!(
            l["read_is_open"].as_str().unwrap_or("").contains("읽기"),
            "읽기는 누구나 된다는 말이 응답에 없다"
        );
        assert!(
            l["other_apps"].as_str().unwrap_or("").contains("비밀방"),
            "비밀방이 아니라는 말이 응답에 없다"
        );
        assert!(l["room_claim"].as_str().unwrap_or("").contains("스스로 적은"));
    }
}

#[cfg(test)]
mod gate_tests {
    //! 코드가 실제로 그렇게 하고 있는지 **글자로 확인**하는 시험들.
    //!
    //! 여기 있는 것들은 노드도 릴레이도 없이 도는 대신, 코드를 문자열로 읽는다.
    //! 그래서 **주석을 먼저 걷어 내야** 한다 — 우리는 주석을 아주 길게 쓰고,
    //! 주석에 「이렇게 한다」라고 적어 놓기만 한 코드가 시험을 통과해 버린다.

    /// 시험이 **자기 자신을 세지 않게** 범위를 자른다.
    fn 코드만() -> &'static str {
        let src = include_str!("fanclub.rs");
        let end = src.find("#[cfg(test)]").unwrap_or(src.len());
        &src[..end]
    }

    /// 주석을 걷어 낸 코드. (`talk.rs` 의 같은 거르개와 같은 규칙이다.)
    ///
    /// ⚠️ 반대 함정도 같이 막는다: 주소 안의 `//`(`https://…`)를 주석으로
    ///    오해하면 코드가 통째로 날아가고, 그러면 아무 시험도 아무것도 못 찾아
    ///    엉뚱하게 실패한다. 그래서 문자열 안은 건드리지 않는다.
    fn 주석빼기(src: &str) -> String {
        let b: Vec<char> = src.chars().collect();
        let mut out = String::with_capacity(src.len());
        let (mut 한줄, mut 여러줄, mut 문자열) = (false, false, false);
        let mut i = 0;
        while i < b.len() {
            let c = b[i];
            let n = b.get(i + 1).copied().unwrap_or('\0');
            if 한줄 {
                if c == '\n' {
                    한줄 = false;
                    out.push(c);
                }
                i += 1;
            } else if 여러줄 {
                if c == '*' && n == '/' {
                    여러줄 = false;
                    i += 2;
                } else {
                    i += 1;
                }
            } else if 문자열 {
                if c == '\\' {
                    out.push(c);
                    if i + 1 < b.len() {
                        out.push(n);
                    }
                    i += 2;
                    continue;
                }
                if c == '"' {
                    문자열 = false;
                }
                out.push(c);
                i += 1;
            } else if c == '/' && n == '/' {
                한줄 = true;
                i += 2;
            } else if c == '/' && n == '*' {
                여러줄 = true;
                i += 2;
            } else {
                if c == '"' {
                    문자열 = true;
                }
                out.push(c);
                i += 1;
            }
        }
        out
    }

    fn 주석뺀_코드() -> String {
        주석빼기(코드만())
    }

    /// 🔴 **거르개부터 일부러 깨뜨려 본다.** 거르개가 고장 나면 아래 시험들이
    ///    전부 거짓으로 통과하거나 전부 거짓으로 실패한다.
    #[test]
    fn 주석_거르개가_제대로_거른다() {
        // (1) 주석은 없어져야 한다.
        let s = 주석빼기("let a = 1; // 여기서 onlytotal 을 켠다\nlet b = 2;\n");
        assert!(!s.contains("onlytotal"), "주석을 못 걸렀다 — 시험이 주석을 잡는다");
        assert!(s.contains("let b = 2;"), "주석 뒤 코드까지 지웠다");

        // (2) 문자열 안의 // 는 주석이 아니다.
        let s = 주석빼기("let u = \"https://x.com/playx\"; let v = 3;");
        assert!(s.contains("https://x.com/playx"), "주소 안의 // 를 주석으로 봤다");
        assert!(s.contains("let v = 3;"), "주소 뒤 코드가 날아갔다");

        // (3) 여러 줄 주석과 escape 한 따옴표.
        assert!(!주석빼기("/* 숨김 */ let a = 1;").contains("숨김"));
        let s = 주석빼기("let a = \"따옴표 \\\" 안\"; // 지움\n");
        assert!(s.contains("따옴표"), "escape 한 따옴표에서 어긋났다");
        assert!(!s.contains("지움"), "escape 한 따옴표 뒤 주석을 못 걸렀다");
    }

    /// 거르개가 못 다루는 글자를 코드가 안 쓰는지 본다. 하나만 끼어도 그 뒤
    /// 주석이 통째로 안 걸러진다.
    #[test]
    fn 홑따옴표_따옴표를_안_쓴다() {
        assert!(
            !주석뺀_코드().contains("'\"'"),
            "홑따옴표로 감싼 따옴표를 쓰고 있다 — 주석 거르개가 그 뒤로 어긋난다"
        );
    }

    /// 한 명령의 몸통(주석 뺀 것).
    fn 함수(이름: &str) -> String {
        let 코드 = 주석뺀_코드();
        let i = 코드
            .find(&format!("pub async fn {이름}"))
            .unwrap_or_else(|| panic!("{이름} 이 있어야 한다"));
        let 뒤 = &코드[i..];
        let end = 뒤.find("\n#[tauri::command]").unwrap_or(뒤.len());
        뒤[..end].to_string()
    }

    /// 🔴 **한 방이 실패해도 나머지는 보낸다.** 통째로 멈추면 사장은 어디까지
    ///    갔는지 모른 채 다시 누르고, 앞의 방에는 같은 글이 두 번 뜬다.
    #[test]
    fn 한_방이_실패해도_나머지를_보낸다() {
        let f = 함수("fan_announce");
        let 뿌림 = f.find("join_all").expect("방을 줄 세워 보내고 있다 — 한 곳이 막히면 뒤가 다 막힌다");
        // 🔴 **뿌린 뒤만** 본다.
        //
        //    처음에는 함수 전체에서 글자를 찾았다. 그런데 이 함수는 앞쪽(자산
        //    이름 검사)에서도 `Err(e) => failed.push` 를 쓴다. 그래서 뿌린 뒤의
        //    실패 처리를 통째로 `Err(_) => {}` 로 바꿔 놓아도 **시험이 통과했다.**
        //    일부러 깨뜨려 보고 잡은 구멍이다 — 범위를 자르지 않은 글자 검사는
        //    다른 곳의 같은 글자를 세고 만족한다.
        let 뒤 = &f[뿌림..];
        assert!(뒤.contains("Ok(v) => sent.push"), "보낸 방을 안 모으고 있다");
        assert!(뒤.contains("Err(e) => failed.push"), "실패한 방을 못 간 곳으로 안 세고 있다");
        // 보낸 결과에 방 번호가 있어야 「못 간 곳만 다시」가 된다.
        assert!(뒤.contains("\"room\": id"), "어느 방인지 안 돌려주고 있다");
    }

    /// 방이 없는 자산도 **못 간 곳**으로 세야 한다. 조용히 빠지면 사장은
    /// 보낸 줄 안다.
    #[test]
    fn 방이_없는_자산도_못_간_곳으로_센다() {
        let f = 함수("fan_announce");
        assert!(f.contains("이 자산으로 만든 방이 없습니다"), "방 없는 자산을 조용히 빠뜨리고 있다");
        assert!(f.contains("MAX_ROOMS"), "한 번에 보내는 개수 한계를 안 보고 있다");
        // 넘치는 방을 **조용히 자르지** 않는다. 잘린 방도 못 간 곳에 들어가야 한다.
        assert!(f.contains("split_off"), "넘치는 방을 세지 않고 있다");
        assert!(f.contains("아직 안 보냈습니다"), "잘린 방을 조용히 버리고 있다");
    }

    /// 🔴 **팬의 지갑 주소를 화면에 주지 않는다.** 주소 하나가 그분의 모든
    ///    거래 내역이다.
    #[test]
    fn 팬의_주소를_안_돌려준다() {
        let f = 함수("fan_holders");
        // ① 노드에 애초에 개수만 달라고 묻는다 — 주소가 앱 안으로 안 들어온다.
        assert!(
            f.contains("json!([a, true])"),
            "onlytotal 을 안 켜고 있다 — 주소 목록이 앱 안으로 들어온다"
        );
        // ② 주소를 거르는 일을 **형(型)이** 한다. 세는 함수가 숫자를 돌려주므로,
        //    주소를 밖으로 흘리려면 함수 서명을 고쳐야만 한다.
        assert!(
            주석뺀_코드().contains("fn holders_count(v: &Value) -> Option<i64>"),
            "개수를 세는 함수가 숫자가 아닌 것을 돌려준다 — 주소가 샐 수 있다"
        );
        // ③ 응답에는 **센 숫자**만 담는다. 노드가 준 값(v)을 그대로 담으면
        //    옛 노드에서 주소 목록이 그대로 화면으로 간다.
        let 응답 = &f[f.find("Ok(json!({").expect("응답을 만드는 곳이 있어야 한다")..];
        assert!(응답.contains("\"holders\": n"), "센 숫자가 아닌 것을 돌려주고 있다");
        for 금지 in ["&v", ": v,", "listaddressesbyasset", "owners", "addr"] {
            assert!(!응답.contains(금지), "응답에 주소가 들어갈 자리가 있다: {금지}");
        }
        // ④ 그리고 그 사실을 말한다.
        assert!(f.contains("FACT_NO_ADDRESS_LIST"), "주소를 안 준다는 말을 응답에 안 담고 있다");
    }

    /// 🔴 색인이 꺼진 것을 **숫자를 세기 전에** 알아채야 한다. 안 그러면
    ///    오류 문장을 세어 「0명」이 된다.
    #[test]
    fn 색인이_꺼졌으면_켜라고_말한다() {
        let f = 함수("fan_holders");
        let 검사 = f.find("needs_index").expect("색인이 켜졌는지 안 보고 있다");
        let 세기 = f.find("holders_count").expect("개수를 세는 곳이 있어야 한다");
        assert!(검사 < 세기, "오류 문장을 먼저 세고 있다 — 「0명」이 된다");
        assert!(f.contains("FIX_INDEX"), "무엇을 켜야 하는지 안 알려 준다");
    }

    /// 🔴 **못 하는 것을 명령마다 담는다.** 한 곳이라도 빠지면 화면은
    ///    그 화면에서만 「기간을 정할 수 있다」고 오해한다.
    #[test]
    fn 세_명령이_모두_못_하는_것을_담는다() {
        for 이름 in ["fan_rooms", "fan_announce", "fan_holders"] {
            assert!(
                함수(이름).contains("limits()"),
                "{이름} 이 못 하는 것을 응답에 안 담고 있다"
            );
        }
    }

    /// 🔴 **못 읽은 것을 「없다」로 치지 않는다.** 노드가 훑는 중이면
    ///    자산이 안 읽힌다. 그때 빈 목록만 주면 화면은 「자산이 없습니다」라고
    ///    적고, 사장은 자기 음반이 사라진 줄 안다.
    #[test]
    fn 못_읽은_것을_없다고_하지_않는다() {
        let f = 함수("fan_rooms");
        assert!(f.contains("assets_why"), "자산을 왜 못 읽었는지 안 돌려주고 있다");
        assert!(f.contains("rooms_why"), "방을 왜 못 읽었는지 안 돌려주고 있다");
        assert!(
            f.contains("자산이 없다는 뜻이 아닙니다"),
            "못 읽은 것과 없는 것을 안 갈라 말하고 있다"
        );
    }

    /// 🔴 링크를 그대로 글에 넣지 않는다. `javascript:` 가 남의 화면에서 돈다.
    #[test]
    fn 링크를_검사하고_넣는다() {
        let f = 함수("fan_announce");
        let 검사 = f.find("check_link").expect("링크를 안 보고 있다");
        let 담기 = f.find("announce_body").expect("본문을 만드는 곳이 있어야 한다");
        assert!(검사 < 담기, "검사하기 전에 글에 담고 있다");
    }

    /// 🔴 여러 갈래가 동시에 열쇠를 만들면 **방마다 다른 사람 이름**으로
    ///    공지가 나간다. 먼저 한 번 만들어 굳혀 놓아야 한다.
    #[test]
    fn 열쇠를_먼저_한_번_만든다() {
        let f = 함수("fan_announce");
        let 열쇠 = f.find("talk_me()").expect("열쇠를 먼저 안 만들고 있다");
        let 뿌리기 = f.find("join_all").expect("한꺼번에 보내는 곳이 있어야 한다");
        assert!(열쇠 < 뿌리기, "열쇠를 만들기 전에 스무 갈래로 뿌리고 있다");
    }
}
