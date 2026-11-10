//! **내 글 서랍** (11-07 대표: 「본인이 쓴 글과 이미지를 데스크탑에서 따로 보고 폴더나 태그별로 관리할 수 있냐?」)
//!
//! 글은 이 컴퓨터 릴레이(`relay.rs`)가 지켜 둔 **내 이름으로 서명된 글**에서 읽는다 — 폰에서 쓴 글도 모여 있다.
//! 폴더는 **이 컴퓨터에만** 남는 나만의 분류다(`my-drawer.json`). 릴레이에 올리지 않고, 남은 볼 수 없다.
//! 태그는 글 안의 「#낱말」이라 공개 글과 함께 이미 공개다 — 화면이 글에서 읽어 거른다(따로 저장하지 않는다).
use serde_json::{json, Value};

const MAX_FOLDERS: usize = 50;
const MAX_FOLDER_NAME: usize = 30;
const MAX_ASSIGN: usize = 20_000;

fn file() -> std::path::PathBuf {
    crate::paths::app_file("my-drawer.json")
}

/// 서랍 파일 읽기. **없으면 빈 서랍, 깨졌으면 오류**(GPT P2 — 깨진 파일을 빈 서랍으로 보고 저장하면 분류가 사라진다).
fn load() -> Result<(Vec<Value>, serde_json::Map<String, Value>, u64), String> {
    let text = match std::fs::read_to_string(file()) {
        Ok(t) => t,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok((vec![], serde_json::Map::new(), 0)),
        Err(_) => return Err("서랍 파일을 읽지 못했어요. 폴더는 지금 바꿀 수 없어요.".into()),
    };
    let v = serde_json::from_str::<Value>(&text).map_err(|_| "서랍 파일을 읽지 못했어요. 폴더는 지금 바꿀 수 없어요.".to_string())?;
    let folders = v.get("folders").and_then(Value::as_array).cloned().unwrap_or_default();
    let assign = v.get("assign").and_then(Value::as_object).cloned().unwrap_or_default();
    let rev = v.get("rev").and_then(Value::as_u64).unwrap_or(0);
    Ok((folders, assign, rev))
}

/// 저장은 한 번에 하나(GPT P1 — 같은 옛 상태에서 만든 두 저장이 서로를 지웠다).
static SAVE_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

fn is_note_id(s: &str) -> bool {
    s.len() == 64 && s.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
fn is_folder_id(s: &str) -> bool {
    !s.is_empty() && s.len() <= 16 && s.bytes().all(|b| b.is_ascii_alphanumeric())
}

/// 폴더·배정을 검사해 정리한다. 이상한 것은 버리지 않고 **거절**한다(조용히 지우면 사장의 분류가 사라진다).
pub(crate) fn clean(folders: &[Value], assign: &serde_json::Map<String, Value>) -> Result<(Vec<Value>, serde_json::Map<String, Value>), String> {
    if folders.len() > MAX_FOLDERS {
        return Err(format!("폴더는 {MAX_FOLDERS}개까지예요."));
    }
    let mut ids = std::collections::HashSet::new();
    let mut out_f = Vec::new();
    for f in folders {
        let id = f.get("id").and_then(Value::as_str).unwrap_or("");
        let name = f.get("name").and_then(Value::as_str).unwrap_or("").trim().to_string();
        if !is_folder_id(id) || !ids.insert(id.to_string()) {
            return Err("폴더 번호가 올바르지 않아요.".into());
        }
        if name.is_empty() || name.chars().count() > MAX_FOLDER_NAME {
            return Err(format!("폴더 이름은 1~{MAX_FOLDER_NAME}자로 지어 주세요."));
        }
        out_f.push(json!({ "id": id, "name": name }));
    }
    if assign.len() > MAX_ASSIGN {
        return Err("폴더에 넣은 글이 너무 많아요.".into());
    }
    let mut out_a = serde_json::Map::new();
    for (note, folder) in assign {
        let Some(fid) = folder.as_str() else { return Err("폴더 배정이 올바르지 않아요.".into()) };
        if !is_note_id(note) || !ids.contains(fid) {
            continue; // 지운 폴더를 가리키는 배정은 정리한다(폴더를 지우면 글은 「폴더 없음」으로 돌아간다).
        }
        out_a.insert(note.clone(), json!(fid));
    }
    Ok((out_f, out_a))
}

/// 내 글(이 컴퓨터가 지켜 둔 것) + 폴더 + 판 번호(rev). 새 글이 먼저.
/// `collected`: 이 컴퓨터가 내 글을 한 번이라도 끝까지 모았나 — 아니면 화면이 바깥에서 읽는 옛 길을 쓴다.
/// `deleted`: 내가 지운 글 번호(옛 길에서도 다시 보이지 않게).
#[tauri::command(async)]
pub fn my_notes() -> Result<Value, String> {
    let Some(me) = crate::relay::owner_pub() else {
        return Ok(json!({ "me": null, "notes": [], "folders": [], "assign": {}, "rev": 0, "collected": false, "deleted": [] }));
    };
    let (notes, deleted) = crate::relay::events_of(&me, &[1]);
    let (folders, assign, rev, problem) = match load() {
        Ok((f, a, r)) => match clean(&f, &a) { Ok((f, a)) => (f, a, r, None), Err(e) => (vec![], serde_json::Map::new(), r, Some(e)) },
        Err(e) => (vec![], serde_json::Map::new(), 0, Some(e)),
    };
    let status = crate::relay::relay_status();
    let collected = !status["my_backup_at"].is_null();
    Ok(json!({ "me": me, "notes": notes, "deleted": deleted, "folders": folders, "assign": assign, "rev": rev, "drawer_problem": problem, "collected": collected, "status": status }))
}

/// 폴더와 배정을 통째로 저장한다. `rev` 가 지금 판과 같아야 한다 — 다르면 다른 곳에서 바뀐 것이니 거절한다.
#[tauri::command(async)]
pub fn my_drawer_save(folders: Vec<Value>, assign: serde_json::Map<String, Value>, rev: u64) -> Result<Value, String> {
    let _g = SAVE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let (_, _, now) = load()?;
    if now != rev {
        return Err("다른 곳에서 바뀌었어요. 서랍을 다시 열어 주세요.".into());
    }
    let (folders, assign) = clean(&folders, &assign)?;
    let next = now + 1;
    let body = serde_json::to_vec_pretty(&json!({ "folders": folders, "assign": assign, "rev": next })).map_err(|_| "저장하지 못했어요.".to_string())?;
    let tmp = file().with_extension("json.tmp");
    std::fs::write(&tmp, body).map_err(|_| "저장하지 못했어요.".to_string())?;
    std::fs::rename(&tmp, file()).map_err(|_| "저장하지 못했어요.".to_string())?;
    Ok(json!({ "folders": folders, "assign": assign, "rev": next }))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn clean_rejects_bad_and_drops_orphans() {
        let f = vec![json!({ "id": "a1", "name": "운동" })];
        let mut a = serde_json::Map::new();
        a.insert("b".repeat(64), json!("a1"));
        a.insert("c".repeat(64), json!("gone"));
        let (f2, a2) = clean(&f, &a).unwrap();
        assert_eq!(f2.len(), 1);
        assert_eq!(a2.len(), 1, "지운 폴더 배정이 남았다");
        assert!(clean(&[json!({ "id": "a1", "name": "" })], &serde_json::Map::new()).is_err());
        assert!(clean(&[json!({ "id": "../x", "name": "x" })], &serde_json::Map::new()).is_err());
        assert!(clean(&[json!({ "id": "a1", "name": "x" }), json!({ "id": "a1", "name": "y" })], &serde_json::Map::new()).is_err());
        let many: Vec<Value> = (0..51).map(|i| json!({ "id": format!("f{i}"), "name": "x" })).collect();
        assert!(clean(&many, &serde_json::Map::new()).is_err());
    }
}
