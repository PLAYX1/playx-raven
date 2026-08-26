//! 켜면 **알아서 돌아가게** 한다.
//!
//! ## 왜 이 파일이 생겼나
//!
//! 여태 앱이 뜰 때 자동으로 켜지는 것은 가게 서버(릴레이가 그 안에 있다)
//! 하나뿐이었다. 노드와 파일창고는 사람이 「지금 켜기」를 눌러야만 켜졌고,
//! 그 단추는 **「이 컴퓨터 → RVN 노드」 안쪽**에 있었다. 거기까지 찾아
//! 들어가는 사장은 없다. 그래서 프로그램을 깔고 열면 표시등 다섯 개 중
//! 넷이 회색인 화면을 보게 됐다 — 고장으로 읽힌다.
//!
//! 여기서 하는 일은 셋이다.
//!
//! ① **첫 설치면 설정을 대신 갖춘다.** 특히 색인 — 나중에 켜면 장부를
//!    처음부터 다시 훑느라 몇 시간이 들지만, **아직 장부가 없을 때는 공짜다.**
//!    이 차이가 크다. 대표님 윈도우 컴퓨터가 지금 몇 시간짜리 재색인을
//!    앞두고 있는 이유가 바로 「처음에 안 켜서」다.
//!
//! ② **켤 수 있는 것은 묻지 않고 켠다.**
//!
//! ③ **못 켜는 것은 못 켠다고 적는다.** 채굴이 그렇다 — 캐는 프로그램과
//!    받을 주소가 있어야 하고, 전기를 쓰는 일이라 말없이 시작하면 안 된다.
//!
//! ## 🔴 파일창고가 첫 설치에서 **한 번도 켜진 적이 없다**
//!
//! `ipfs daemon` 은 저장소가 없으면 이렇게 답하고 죽는다:
//!
//! ```text
//! Error: no IPFS repo found in ~/.ipfs.
//! please run: 'ipfs init'
//! ```
//!
//! 그런데 `ipfs init` 을 부르는 코드가 **저장소 어디에도 없었다.** 그리고
//! 띄우는 쪽은 `spawn()` 이 `Ok` 면 「켰습니다」라고 답한다 — 노드에서
//! 똑같이 당했던 병이다(`services::spawn_node` 주석 ②). 그래서 새 컴퓨터에
//! 깐 사람은 파일창고가 영영 회색인 채로, 사진과 메뉴판이 손님에게 안 갔다.

use serde_json::{json, Value};

/// IPFS 저장소가 있나. 없으면 `ipfs daemon` 은 뜨자마자 죽는다.
fn ipfs_repo_ready() -> bool {
    // kubo 는 `IPFS_PATH` 가 있으면 그쪽을, 없으면 `~/.ipfs` 를 쓴다.
    // 우리는 `IPFS_PATH` 를 안 건드리므로 기본 자리를 본다.
    let dir = std::env::var("IPFS_PATH")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|_| crate::paths::home().join(".ipfs"));
    dir.join("config").exists()
}

/// 저장소가 없으면 만든다. 한 번이면 되고, 몇 초 걸린다.
///
/// `--profile=lowpower` 는 가게 컴퓨터를 위한 것이다. 계산대는 남는 힘으로
/// 파일을 나르는 자리지, 파일을 나르려고 있는 자리가 아니다.
fn ipfs_init() -> Result<(), String> {
    let Some(path) = crate::services::which("ipfs") else {
        return Err("파일창고 프로그램이 없습니다".into());
    };
    let out = crate::quiet::cmd(&path)
        .args(["init", "--profile=lowpower"])
        .output()
        .map_err(|e| e.to_string())?;
    if out.status.success() || ipfs_repo_ready() {
        return Ok(());
    }
    let why = String::from_utf8_lossy(&out.stderr).trim().to_string();
    Err(if why.is_empty() { "만들지 못했습니다".into() } else { why })
}

/// 첫 설치면 `raven.conf` 를 대신 갖춘다.
///
/// 🔴 **이미 적혀 있는 줄은 절대 안 건드린다.** 대표님 컴퓨터의
/// `rpcuser`·`rpcpassword` 는 play.ex.erci.se 가 쓰고 있어서, 그걸 지우면
/// 그쪽이 죽는다. `conf_write` 가 모르는 줄을 순서까지 그대로 남긴다.
fn prep_conf() -> Vec<String> {
    let mut did = Vec::new();
    let dir = crate::paths::raven_dir();
    if std::fs::create_dir_all(&dir).is_err() {
        return did;
    }

    let cur = crate::conf::conf_read();
    let vals = cur["values"].as_object().cloned().unwrap_or_default();
    let is = |k: &str| vals.get(k).and_then(Value::as_i64).unwrap_or(0) == 1;

    let mut want = serde_json::Map::new();
    for (k, v) in &vals {
        want.insert(k.clone(), v.clone());
    }

    // ① 우리가 노드에 말을 걸려면 이게 있어야 한다. 없으면 아무것도 못 읽는다.
    if !is("server") {
        want.insert("server".into(), json!(1));
        did.push("노드에 말을 걸 수 있게 열었습니다".to_string());
    }

    // ② 색인. **장부가 아직 없을 때만** 켠다.
    //
    //    장부가 있는 컴퓨터에서 이걸 켜면 우리 코드가 `-reindex` 를 붙여
    //    34GB 를 처음부터 다시 훑는다 — 몇 시간, 그동안 주문 확인이 멈춘다.
    //    말없이 그런 일을 벌이면 안 된다. 그때는 사람이 「한가한 시간」을
    //    골라서 하는 것이 맞고, 그 화면은 이미 있다.
    let st = crate::paths::datadir_status();
    let has_chain = st["has_chain"].as_bool().unwrap_or(false);
    if !has_chain {
        let mut turned = Vec::new();
        if !is("assetindex") {
            want.insert("assetindex".into(), json!(1));
            turned.push("자산");
        }
        if !is("addressindex") {
            want.insert("addressindex".into(), json!(1));
            turned.push("주소");
        }
        if !turned.is_empty() {
            // 처음부터 훑을 것이라 **다시 훑을 것이 없다.** 표시를 남겨
            // `-reindex` 가 안 붙게 한다 — 안 그러면 첫 화면부터
            // 「몇 시간 걸립니다」라는 겁주는 안내가 뜬다.
            let _ = std::fs::write(crate::paths::app_file("reindexed-assetindex"), "1");
            let _ = std::fs::write(crate::paths::app_file("reindexed-addressindex"), "1");
            did.push(format!(
                "{} 색인을 처음부터 켰습니다 — 지금은 공짜입니다. 나중에 켜면 몇 시간 걸립니다.",
                turned.join("·")
            ));
        }
    }

    if did.is_empty() {
        return did;
    }
    if let Err(e) = crate::conf::conf_write(Value::Object(want)) {
        return vec![format!("설정을 갖추지 못했습니다: {e}")];
    }
    did
}

/// 컴퓨터를 켜면 이 프로그램도 같이 켜지게 한다. **처음 한 번만.**
///
/// ## 왜 기본으로 켜나
///
/// 대표님 말: "카카오톡도 텔레그램도 그냥 컴퓨터에 켜 놓고 쉽게 쓰잖아."
/// 그 프로그램들의 공통점은 **재부팅해도 돌아온다**는 것이다. 우리는 안
/// 돌아왔다. 계산대 컴퓨터는 정전 한 번이면 끝이고, 그날 밤 입금은
/// 아무도 확인하지 않는다. 켜 두라고 만든 프로그램이 켜져 있질 못했다.
///
/// ## 한 번만 하는 이유
///
/// 사장이 껐으면 그건 결정이다. 켤 때마다 다시 켜면 그건 우리가 사장을
/// 이기려 드는 것이고, 그런 프로그램은 지워진다. 표시를 남겨 한 번만 한다.
fn prep_autostart() -> Option<String> {
    let stamp = crate::paths::app_file("autostart-asked");
    if stamp.exists() || crate::autostart::autostart_get() {
        return None;
    }
    let _ = std::fs::write(&stamp, "1");
    match crate::autostart::autostart_set(true) {
        Ok(true) => Some(
            "컴퓨터를 켜면 이 프로그램도 같이 켜지게 했습니다 — 설정에서 끄실 수 있습니다"
                .into(),
        ),
        // 못 켰다고 시끄럽게 굴 일이 아니다. 조용히 넘어간다.
        _ => None,
    }
}

/// 바깥 연결도 켠다.
///
/// ## 🔴 왜 자동으로 켜나 — 안 켜면 가게가 **안에서만** 열린다
///
/// 대표님: "릴레이 바깥 연결이 자동으로 작동해야 하는 거 아닌가?"
///
/// 맞다. 표시등 넷이 다 초록이어도 이게 꺼져 있으면 **가게 밖에서는
/// 아무도 못 들어온다.** 손님이 QR 을 찍어도 안 열린다. 그런데 그 사실이
/// 화면 안쪽에만 적혀 있어서, 사장은 다 켜진 줄 알고 장사를 시작한다.
///
/// 켜는 데 드는 값이 없다 — 무료 터널이고, 여는 것은 **우리 손님 화면
/// 하나**뿐이다. 지갑도 노드 RPC 도 그 길로 안 나간다.
///
/// ⚠️ 준비물이 없으면 조용히 넘어간다. 받아 오는 것은 사람이 정한다 —
///    말없이 인터넷에서 프로그램을 내려받는 계산대는 만들지 않는다.
fn prep_tunnel() -> Option<String> {
    let st = crate::tunnel::tunnel_status();
    if st["running"].as_bool().unwrap_or(false) {
        return None;
    }
    if !st["installed"].as_bool().unwrap_or(false) {
        return Some("바깥 연결은 준비물이 아직 없습니다 — 「이 컴퓨터 → 바깥 연결」에서 받으실 수 있습니다".into());
    }
    match crate::tunnel::tunnel_start(crate::server::PORT) {
        Ok(v) => v["url"]
            .as_str()
            .map(|u| format!("바깥 연결을 켰습니다 — 손님이 가게 밖에서도 들어옵니다 ({u})")),
        Err(e) => Some(format!("바깥 연결을 켜지 못했습니다: {e}")),
    }
}

/// 채굴을 왜 지금 못 켜는가. **켤 수 있으면 그것도 적는다.**
///
/// 🔴 자동으로 켜지 않는다. 전기를 쓰는 일이고, 남의 컴퓨터에서 말없이
///    전기를 쓰기 시작하는 프로그램은 그 자체로 나쁜 프로그램이다.
///    할 수 있는 것은 **준비가 됐는지 대신 확인해 주는 것**까지다.
fn mining_why() -> Value {
    match crate::services::which("kawpowminer") {
        Some(p) => json!({
            "ready": true,
            "why": "캐는 프로그램이 있습니다. 「채굴」에서 켜기만 하면 됩니다.",
            "path": p,
        }),
        None => json!({
            "ready": false,
            // 못 하는 것을 「준비 중」이라고 얼버무리지 않는다.
            "why": "이 컴퓨터로는 못 캡니다 — 캐는 프로그램(kawpowminer)이 없습니다. \
                    채굴은 그래픽카드가 있는 따로 있는 기계에서 하고, 이 지갑 주소로 받으시면 됩니다.",
        }),
    }
}

/// 앱이 뜨면 **한 번** 부른다.
///
/// 오래 걸릴 수 있으므로 창을 띄우는 길과 떨어뜨려 돌린다. 여기서 막히면
/// 첫 화면이 「응답하지 않습니다」가 된다.
pub async fn run() -> Value {
    let mut notes = prep_conf();
    if let Some(n) = prep_autostart() {
        notes.push(n);
    }

    // 파일창고 저장소부터. 이게 없으면 아래 `services_start` 가 띄워도
    // 곧바로 죽는다 — 그리고 죽은 줄 모르고 「켰습니다」라고 답한다.
    let mut ipfs_note: Option<String> = None;
    if !ipfs_repo_ready() && crate::services::which("ipfs").is_some() {
        match ipfs_init() {
            Ok(()) => notes.push("파일창고를 처음 준비했습니다".into()),
            Err(e) => ipfs_note = Some(format!("파일창고를 준비하지 못했습니다: {e}")),
        }
    }

    let r = crate::services::services_start().await;

    // 손님 화면이 뜬 뒤에 바깥 길을 연다. 순서가 바뀌면 터널이 죽은
    // 포트를 가리킨다.
    if let Some(n) = prep_tunnel() {
        notes.push(n);
    }

    let (started, mut skipped) = match r {
        Ok(v) => (
            v["started"].as_array().cloned().unwrap_or_default(),
            v["skipped"].as_array().cloned().unwrap_or_default(),
        ),
        Err(e) => (vec![], vec![json!({ "what": "켜기", "why": e })]),
    };
    if let Some(n) = ipfs_note {
        skipped.push(json!({ "what": "파일창고", "why": n }));
    }

    json!({
        "notes": notes,
        "started": started,
        "skipped": skipped,
        "mining": mining_why(),
    })
}

/// 화면이 「처음 준비에서 무슨 일이 있었나」를 물어볼 때 쓴다.
#[tauri::command]
pub async fn boot_report() -> Value {
    LAST.lock()
        .ok()
        .and_then(|g| g.clone())
        .unwrap_or_else(|| json!({ "pending": true }))
}

use std::sync::Mutex;
static LAST: Mutex<Option<Value>> = Mutex::new(None);

pub fn remember(v: Value) {
    if let Ok(mut g) = LAST.lock() {
        *g = Some(v);
    }
}

#[cfg(test)]
mod tests {
    /// 🔴 **채굴은 자동으로 켜지면 안 된다.** 남의 컴퓨터에서 말없이 전기를
    ///    쓰기 시작하는 것이라, 이건 취향이 아니라 선이다. 언젠가 「다
    ///    자동으로」를 밀어붙이다 여기까지 넘어갈 수 있어서 시험으로 박아 둔다.
    #[test]
    fn 채굴은_자동으로_켜지지_않는다() {
        let src = include_str!("boot.rs");
        let i = src.find("pub async fn run").expect("시작 함수가 있어야 한다");
        // 🔴 **시험 칸은 빼고 본다.** 안 그러면 이 시험이 자기가 찾는 글자를
        //    자기 안에 들고 있어서 늘 걸린다. 이 저장소에서 네 번째다.
        let end = src[i..].find("#[cfg(test)]").unwrap_or(src.len() - i);
        let body = &src[i..i + end];
        // 금지어도 조립해서 쓴다 — 위와 같은 이유다.
        let banned = format!("miner{}start", "_");
        assert!(
            !body.contains(&banned),
            "처음 켤 때 채굴을 시작하고 있다 — 전기는 사람이 정한다"
        );
    }

    /// 장부가 있는 컴퓨터에서 색인을 말없이 켜면 몇 시간짜리 재색인이 돈다.
    /// `has_chain` 을 보는 줄이 사라지면 그 사고가 난다.
    #[test]
    fn 장부가_있으면_색인을_건드리지_않는다() {
        let src = include_str!("boot.rs");
        let i = src.find("fn prep_conf").expect("설정 함수가 있어야 한다");
        let end = src[i..].find("\nfn mining_why").unwrap_or(src.len() - i);
        let body = &src[i..i + end];
        assert!(
            body.contains("has_chain") && body.contains("if !has_chain"),
            "장부가 있는지 안 보고 색인을 켜고 있다"
        );
    }
}
