//! 이야기를 **카톡처럼 빠르게**(11-12 대표: 「카톡처럼 평소에 메신저로 쓸 수 있어야 함」「모든 사용이 미친듯이 빨라야」).
//!
//! 세 겹이다.
//! 1. **연결 풀**(relay_pool.rs) — 릴레이마다 열린 연결 하나를 나눠 쓴다. 묻기마다 0.5~0.9초 손잡기가 없어진다.
//! 2. **먼저 그리기** — 화면은 `talk_view(local: true)` 로 이 컴퓨터 릴레이 저장분을 곧바로(몇 ms) 그리고,
//!    `talk_view(local: false)` 의 바깥 답이 오면 합쳐 다시 그린다. 바깥에서 읽은 글은 이 컴퓨터 릴레이에 남아
//!    다음에 열 때 먼저 그려진다.
//! 3. **새 글만** — 이미 받은 것이 있으면 `since`(마지막으로 받은 시각 − 여유) 이후만 묻는다.
//!    그 대신 화면이 가진 글(`known`)의 지우기 요청은 같이 물어 `gone` 으로 돌려준다 — 지운 글이 남지 않게.
//!
//! 🔴 받은 글의 서명은 예전처럼 읽는 곳(nostrpub::pooled_read)에서 본다. 이 컴퓨터 릴레이에 둘 때도 store 의 규칙 그대로다.

use serde_json::{json, Value};

/// 이 글들을 가리키는 지우기 요청(kind 5)을 묻고 적어 둔다(relay::note_deletions — 쓴 사람이 지운 것만 친다).
/// 50개씩 묶어 한 물음(필터 여럿)으로 · 닿지 못하면 조용히 넘어간다(다음 읽기에서 다시 묻는다).
pub(crate) async fn learn_deletions(mut ids: Vec<String>) {
    ids.retain(|i| i.len() == 64 && i.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)));
    ids.sort();
    ids.dedup();
    if ids.is_empty() {
        return;
    }
    let filters: Vec<Value> = ids.chunks(50).take(6).map(|c| json!({ "kinds": [5], "#e": c, "limit": 200 })).collect();
    if let Ok(dels) = crate::nostrpub::query_any(filters, "d1").await {
        crate::relay::note_deletions(&dels);
    }
}

/// 처음 보는 글(known 에 없는 것)의 지우기 요청을 뒤에서 묻는다 — 화면을 기다리게 하지 않는다.
pub(crate) fn learn_deletions_later(list: &[Value], known: &[String]) {
    let ids: Vec<String> = list
        .iter()
        .filter_map(|e| e.get("id").and_then(Value::as_str))
        .filter(|id| !known.iter().any(|k| k == id))
        .map(str::to_string)
        .collect();
    if ids.is_empty() {
        return;
    }
    if let Ok(h) = tokio::runtime::Handle::try_current() {
        h.spawn(learn_deletions(ids));
    }
}

/// 화면이 가진 글(`[글 번호, 쓴 사람]`) 중 지운 것.
fn gone_among(known: &[(String, String)]) -> Vec<String> {
    known
        .iter()
        .filter(|(id, pk)| crate::relay::is_gone(&json!({ "id": id, "pubkey": pk })))
        .map(|(id, _)| id.clone())
        .collect()
}

fn clean_known(known: Option<Vec<(String, String)>>) -> Vec<(String, String)> {
    let hex = |s: &str| s.len() == 64 && s.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b));
    known.unwrap_or_default().into_iter().filter(|(i, p)| hex(i) && hex(p)).take(300).collect()
}

/// 이야기 화면 한 판(광장 또는 방). 돌려줌 `{ notes(최신이 앞), gone(known 중 지운 글 번호), scanned, oldest }`.
///
/// - `local: true` → 이 컴퓨터 릴레이 저장분만. 바깥에 안 나간다(몇 ms).
/// - `since` → 이 시각 이후 글만(새 글만). `known` → 화면이 이미 그린 글 `[번호, 쓴 사람]`(지운 것을 알려 준다).
#[tauri::command]
pub async fn talk_view(
    room: Option<String>,
    follows: Option<bool>,
    limit: Option<i64>,
    local: Option<bool>,
    since: Option<i64>,
    known: Option<Vec<(String, String)>>,
) -> Result<Value, String> {
    let local = local == Some(true);
    let known = clean_known(known);
    let known_ids: Vec<String> = if local { vec![] } else { known.iter().map(|(i, _)| i.clone()).collect() };
    let limit = limit.unwrap_or(60);
    let room = room.filter(|r| !r.is_empty());
    let mut out = match &room {
        Some(_) => {
            let notes = crate::talk::room_notes(&room, limit, local, since, &known_ids).await?;
            json!({ "notes": notes, "scanned": 0, "oldest": 0 })
        }
        None => crate::talk_social::feed_notes(follows == Some(true), None, limit, local, since, &known_ids).await?,
    };
    out["gone"] = json!(gone_among(&known));
    Ok(out)
}

/// 이야기 화면을 열 때 부른다 — 기본 릴레이에 미리 붙어 둔다(이미 열려 있으면 아무것도 안 한다).
#[tauri::command]
pub fn talk_warm() {
    crate::nostrpub::warm_all();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 이상한_번호는_known_에서_뺀다() {
        let ok = ("a".repeat(64), "b".repeat(64));
        let got = clean_known(Some(vec![ok.clone(), ("x".into(), "b".repeat(64)), ("A".repeat(64), "b".repeat(64))]));
        assert_eq!(got, vec![ok]);
    }
}
