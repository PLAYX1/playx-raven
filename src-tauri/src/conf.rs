//! Editing `raven.conf` without a text editor.
//!
//! The node's settings live in a plain text file that most shop owners will
//! never open, and the ones who do usually find advice on a forum, paste a line
//! they do not understand, and end up with a node that will not start.
//!
//! So this exposes a short list — the settings that actually change how the
//! machine behaves — each with what it does, what it costs, and whether it can
//! be undone. Everything else stays out. A settings screen that lists eighty
//! options is a text editor with extra steps.
//!
//! ## The rules that make this safe
//!
//! - **Never rewrite the whole file.** Lines this app does not know about are
//!   left exactly where they are; somebody put them there for a reason.
//! - **Keep a copy before writing.** A malformed `raven.conf` stops the node
//!   from starting at all, and the shop cannot take orders until someone finds
//!   the file.
//! - **Say when a change is irreversible.** `prune` deletes block files. Turning
//!   it off does not bring them back — it means re-downloading 45 GB.
//! - **Nothing takes effect until the node restarts**, and the screen says so
//!   rather than letting the owner believe a setting is live.

use serde_json::{json, Value};
use std::path::PathBuf;

fn conf_path() -> PathBuf {
    crate::paths::raven_dir().join("raven.conf")
}

/// The settings worth showing, in the order they matter to a shop.
///
/// `unit` and `hint` exist so the field can be a number box with a sentence
/// next to it rather than a key=value line the owner has to compose.
#[tauri::command]
pub fn conf_options() -> Value {
    json!([
        {
            "key": "prune", "label": "블록 정리", "unit": "MB", "type": "number",
            "recommended": 5000, "off": 0,
            "what": "오래된 블록 파일을 지워 디스크를 줄입니다. 잔액과 자산은 그대로입니다.",
            "cost": "45 GB → 약 5 GB",
            "warn": "한 번 켜면 되돌릴 수 없습니다. 끄려면 체인을 처음부터 다시 받아야 합니다(몇 시간). 그리고 이 상태에서는 12단어로 지갑을 되살려도 옛 거래를 찾지 못합니다 — 지금 지갑은 그대로 쓰지만, 나중에 백업으로 복구할 때는 전부 보관 상태로 맞춰야 합니다. 또 이 컴퓨터로는 ElectrumX 같은 공개 인프라를 영영 돌릴 수 없게 됩니다(전부 보관 + txindex가 필요한데, 둘은 같이 못 씁니다).",
            "danger": true
        },
        {
            "key": "dbcache", "label": "메모리 사용", "unit": "MB", "type": "number",
            "recommended": 300, "off": 0,
            "what": "노드가 쓰는 메모리. 적게 주면 느려지고, 많이 주면 다른 프로그램이 느려집니다.",
            "cost": "기본 450 · 저사양 300 · 넉넉하면 1000",
            "warn": "", "danger": false
        },
        {
            "key": "maxconnections", "label": "연결 수", "unit": "개", "type": "number",
            "recommended": 16, "off": 0,
            "what": "다른 노드와 몇 개까지 연결할지. 줄이면 인터넷과 CPU를 덜 씁니다.",
            "cost": "기본 125 · 저사양 16",
            "warn": "너무 낮추면(8 미만) 새 블록을 늦게 받습니다.", "danger": false
        },
        {
            "key": "maxmempool", "label": "대기 거래 보관", "unit": "MB", "type": "number",
            "recommended": 100, "off": 0,
            "what": "아직 블록에 안 들어간 거래를 얼마나 들고 있을지.",
            "cost": "기본 300 · 저사양 100",
            "warn": "", "danger": false
        },
        {
            "key": "assetindex", "label": "자산 전체 색인", "unit": "", "type": "switch",
            "recommended": 1, "off": 0,
            "what": "주소별로 어떤 자산을 갖고 있는지 조회할 수 있게 됩니다. 출입 확인이 체인에서 직접 됩니다.",
            "cost": "디스크가 조금 늘고, 켤 때 재색인에 몇 시간 걸립니다",
            // 🔴 이 스위치는 **켜는 것만으로는 아무 일도 안 한다.**
            // 코어가 자산 색인 변경을 검사하지 않는다(init.cpp 에 그 분기가
            // 없다 — txindex·addressindex 에는 있는데 assetindex 에만 없다).
            // 그래서 켜고 다시 켜면 노드는 **말없이 옛 상태로** 돌고,
            // 배당은 계속 "색인이 꺼져 있습니다" 를 답한다.
            // `-reindex` 를 붙여 다시 켜야 한다 — 그건 우리가 해 준다.
            "needs_reindex": true,
            "warn": "켜고 다시 시작하면 노드가 처음부터 다시 훑습니다 — 34GB 라 몇 시간 걸리고, 그동안 손님 주문 확인이 멈춥니다. 밤에 켜세요.",
            "danger": true
        },
        {
            "key": "addressindex", "label": "이 노드로 지갑도 열기", "unit": "", "type": "switch",
            "recommended": 1, "off": 0,
            "what": "손님이 이 가게에서 우리 서버 없이 잔액을 봅니다. 켜면 이 노드 자체가 지갑 서버가 됩니다.",
            "cost": "색인 디스크가 늘고, **이미 다 받아 놓은 노드**에서 켜면 재색인에 몇 시간 걸립니다",
            "warn": "처음 설치하는 컴퓨터라면 대가가 없습니다 — 동기화하면서 같이 쌓입니다. 이미 다 받아 놓았다면 영업이 끝난 뒤에 켜세요.",
            "danger": true
        },
        {
            "key": "server", "label": "이 앱과 연결", "unit": "", "type": "switch",
            "recommended": 1, "off": 0,
            "what": "이 프로그램이 노드와 말할 수 있게 합니다.",
            "cost": "",
            "warn": "끄면 이 앱이 아무것도 못 합니다. 켜 두세요.", "danger": true
        }
    ])
}

/// Templates. Not "profiles" — a shop picks one on the first day and forgets.
#[tauri::command]
pub fn conf_templates() -> Value {
    json!([
        {
            "id": "lowspec", "name": "오래된 컴퓨터",
            "why": "사무실에 굴러다니던 PC, 노트북. 디스크와 메모리를 아낍니다.",
            "values": { "prune": 5000, "dbcache": 300, "maxconnections": 16, "maxmempool": 100, "server": 1 },
            "note": "디스크 45 GB → 5 GB. 되돌리려면 체인을 다시 받아야 합니다."
        },
        {
            "id": "normal", "name": "보통",
            "why": "요즘 컴퓨터. 디스크가 넉넉하면 이쪽이 빠릅니다.",
            "values": { "dbcache": 450, "maxconnections": 40, "server": 1 },
            "note": "블록을 전부 보관합니다(약 45 GB)."
        },
        {
            "id": "shop", "name": "가게용",
            "why": "출입 확인을 체인에서 직접 하고 싶을 때. 재색인이 필요합니다.",
            "values": { "dbcache": 600, "maxconnections": 40, "assetindex": 1, "addressindex": 1, "server": 1 },
            "note": "처음 설치하는 컴퓨터면 그냥 켜집니다 — 동기화하면서 색인이 같이 쌓입니다(소스로 확인: 새 DB 는 설정값을 그대로 씁니다). 이미 다 받아 놓은 컴퓨터라면 한 번 몇 시간 다시 훑으니 밤에 켜세요."
        }
    ])
}

/// What is set right now, plus everything else in the file untouched.
#[tauri::command]
pub fn conf_read() -> Value {
    let text = std::fs::read_to_string(conf_path()).unwrap_or_default();
    let mut known = serde_json::Map::new();
    let mut others: Vec<String> = Vec::new();

    for line in text.lines() {
        let t = line.trim();
        if t.is_empty() || t.starts_with('#') {
            continue;
        }
        match t.split_once('=') {
            Some((k, v)) => {
                let k = k.trim();
                let v = v.trim();
                if ["prune", "dbcache", "maxconnections", "maxmempool", "assetindex", "addressindex", "server"]
                    .contains(&k)
                {
                    known.insert(k.to_string(), json!(v.parse::<i64>().unwrap_or(0)));
                } else {
                    // 우리가 모르는 줄. 누군가 이유가 있어 넣은 것이므로 손대지 않는다.
                    others.push(t.to_string());
                }
            }
            None => others.push(t.to_string()),
        }
    }

    json!({
        "path": conf_path().to_string_lossy(),
        "exists": conf_path().exists(),
        "values": known,
        "others": others,
    })
}

/// Writes the settings back, keeping every line this app does not manage.
///
/// A value of `null` removes the key, which is how "back to default" works —
/// writing `prune=0` and deleting the line are not the same thing to the node.
#[tauri::command]
pub fn conf_write(values: Value) -> Result<Value, String> {
    let path = conf_path();
    let existing = std::fs::read_to_string(&path).unwrap_or_default();

    // 쓰기 전에 사본. 잘못된 conf 는 노드를 아예 못 뜨게 만들고, 그때 가게는
    // 주문을 못 받는다.
    if path.exists() {
        let _ = std::fs::copy(&path, path.with_extension("conf.bak"));
    }

    let managed = ["prune", "dbcache", "maxconnections", "maxmempool", "assetindex", "addressindex", "server"];
    let mut out: Vec<String> = Vec::new();

    // 우리 것이 아닌 줄은 순서까지 그대로 남긴다.
    for line in existing.lines() {
        let t = line.trim();
        let is_managed = t
            .split_once('=')
            .map(|(k, _)| managed.contains(&k.trim()))
            .unwrap_or(false);
        if !is_managed {
            out.push(line.to_string());
        }
    }

    let obj = values.as_object().cloned().unwrap_or_default();
    let mut wrote = Vec::new();
    for k in managed {
        match obj.get(k) {
            Some(Value::Null) | None => {}
            Some(v) => {
                let n = v.as_i64().unwrap_or(0);
                out.push(format!("{k}={n}"));
                wrote.push(json!({ "key": k, "value": n }));
            }
        }
    }

    // 파일 끝의 빈 줄이 계속 쌓이지 않게 정리한다.
    while out.last().map(|l| l.trim().is_empty()).unwrap_or(false) {
        out.pop();
    }
    let body = format!("{}\n", out.join("\n"));

    let tmp = path.with_extension("conf.tmp");
    std::fs::write(&tmp, body).map_err(|e| format!("쓰지 못했습니다: {e}"))?;
    std::fs::rename(&tmp, &path).map_err(|e| format!("쓰지 못했습니다: {e}"))?;

    Ok(json!({
        "wrote": wrote,
        "backup": path.with_extension("conf.bak").to_string_lossy(),
        // 노드는 시작할 때만 이 파일을 읽는다. 바꿨다고 지금 달라지지 않는다.
        "needs_restart": true,
    }))
}

#[cfg(test)]
mod defaults {
    /// 🔴 새 가게가 설치하면 **그 노드가 곧 지갑 서버**가 되어야 한다.
    ///
    /// 이게 빠져 있으면 손님은 잔액을 보려고 우리 서버를 거쳐야 하고, 그러면
    /// 가게가 100곳이어도 지갑 서버는 하나다 — 우리가 문을 닫으면 다 멈춘다.
    ///
    /// 레이븐 소스로 확인한 사실(validation.cpp:5259):
    ///   새 DB 를 만들 때는 **설정한 값을 그대로 쓴다.** 그래서 처음 설치하는
    ///   컴퓨터는 재색인이 없다 — 동기화하며 색인이 같이 쌓인다. 재색인은
    ///   이미 만들어진 DB 의 값과 달라질 때만 요구된다(init.cpp:1659).
    #[test]
    fn a_new_shop_becomes_a_wallet_server() {
        let src = include_str!("../src/conf.rs");
        let shop = src
            .find(r#""id": "shop""#)
            .map(|i| src[i..].chars().take(400).collect::<String>())
            .expect("가게용 묶음이 없습니다");
        assert!(
            shop.contains(r#""addressindex": 1"#),
            "가게용 기본값에 addressindex 가 없습니다 — 새 가게가 지갑 서버가 못 됩니다"
        );
        // 관리 목록에 없으면 화면에서 켜도 파일에 안 써진다.
        assert!(
            src.contains(r#""addressindex", "server""#),
            "addressindex 가 관리 목록에 없습니다 — 켜도 저장이 안 됩니다"
        );
    }
}

/// 설정 파일이 자산 색인을 켜라고 하는가.
///
/// 노드를 켤 때 `-reindex` 를 붙여야 하는지 정하는 데 쓴다. 코어가 이 변경을
/// 검사하지 않으므로(init.cpp 에 assetindex 분기가 없다) 우리가 챙긴다.
pub fn wants_assetindex() -> bool {
    std::fs::read_to_string(conf_path())
        .ok()
        .map(|t| {
            t.lines().any(|l| {
                let l = l.trim();
                !l.starts_with('#') && (l == "assetindex=1" || l == "assetindex=true")
            })
        })
        .unwrap_or(false)
}

#[cfg(test)]
mod assetindex_tests {
    /// 🔴 코어는 자산 색인이 바뀐 것을 **검사하지 않는다.** txindex 와
    /// addressindex 에는 그 분기가 있는데 assetindex 에만 없다. 그래서 설정만
    /// 바꾸고 켜면 노드가 **말없이 옛 상태로** 돌고, 배당은 계속 안 된다.
    /// 우리가 `-reindex` 를 붙여야 한다.
    #[test]
    fn we_add_reindex_because_core_will_not_ask() {
        let src = include_str!("services.rs");
        assert!(
            src.contains("wants_assetindex") && src.contains("\"-reindex\""),
            "자산 색인을 켰는데 -reindex 를 안 붙인다 — 아무 일도 안 일어난다",
        );
        // 켤 때마다 붙이면 그 가게는 영영 장사를 못 한다.
        assert!(
            src.contains("reindexed-assetindex"),
            "한 번만 붙였다는 표시가 없다 — 켤 때마다 34GB 를 다시 훑는다",
        );
    }
}
