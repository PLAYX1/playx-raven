//! **이 컴퓨터 준비하기** — 단추 하나로 끝낸다.
//!
//! ## 무엇을 푸는가
//!
//! 대표님: "백신에 등록하던가 그런 거 다 알아서 해 줄 수는 없나?"
//!         "프로그램 하나로 처리가 안 되나?"
//!
//! 그동안 우리는 **사장에게 숙제를 냈다** — Windows 보안을 열어라, 제외
//! 항목을 찾아라, `%APPDATA%` 를 붙여넣어라, 방화벽을 허용해라, 메모리를
//! 올려라. 하나하나는 별것 아닌데 **다섯 개가 되면 아무도 안 한다.**
//! 그리고 못 한 채로 「느리다」고 겪는다.
//!
//! 여기서 한 번에 한다. 관리자 권한을 묻는 창은 **한 번만** 뜬다.
//!
//! ## 🔴 못 한 것을 못 했다고 말한다
//!
//! 우리가 못 하는 것이 실제로 있다:
//! · 다른 회사 백신(nProtect·V3·알약)은 스크립트로 못 만진다 — 손으로 해야 한다
//! · 맥에는 애초에 이런 예외 설정이 없다
//! · 사장이 관리자 창에서 「아니오」를 누를 수 있다
//!
//! 그때 조용히 넘어가면 사장은 다 된 줄 안다. **한 줄씩 결과를 돌려준다.**

use serde_json::{json, Value};

/// 한 가지 일의 결과. 화면에 그대로 한 줄씩 뿌린다.
fn step(what: &str, ok: bool, say: &str) -> Value {
    json!({ "what": what, "ok": ok, "say": say })
}

/// 관리자 권한이 필요한 일들을 **한 장의 스크립트로** 묶어 한 번만 묻는다.
///
/// ⚠️ 창을 두 번 띄우면 두 번째는 대개 「아니오」를 누른다. 그래서 묶는다.
#[cfg(target_os = "windows")]
fn admin_part(raven: &str, app: &str) -> Vec<Value> {
    use std::io::Write;

    let node = crate::paths::app_dir().join("bin").join("ravend.exe");
    let ipfs = crate::paths::app_dir().join("bin").join("ipfs.exe");
    let done = std::env::temp_dir().join("playx-raven-prep.txt");
    let _ = std::fs::remove_file(&done);

    // 한 줄이라도 실패해도 나머지는 계속 간다 — 방화벽이 막혀도 백신 예외는
    // 넣어야 한다. 그래서 각 줄을 try/catch 로 감싸고 결과를 파일에 적는다.
    let ps = format!(
        r#"$r = @()
try {{ Add-MpPreference -ExclusionPath '{raven}' -ErrorAction Stop; $r += 'av-raven=ok' }} catch {{ $r += 'av-raven=' + $_.Exception.Message }}
try {{ Add-MpPreference -ExclusionPath '{app}' -ErrorAction Stop; $r += 'av-app=ok' }} catch {{ $r += 'av-app=' + $_.Exception.Message }}
try {{ New-NetFirewallRule -DisplayName 'PLAY X Raven node' -Direction Inbound -Program '{node}' -Action Allow -ErrorAction Stop | Out-Null; $r += 'fw-node=ok' }} catch {{ $r += 'fw-node=' + $_.Exception.Message }}
try {{ New-NetFirewallRule -DisplayName 'PLAY X Raven files' -Direction Inbound -Program '{ipfs}' -Action Allow -ErrorAction Stop | Out-Null; $r += 'fw-ipfs=' + 'ok' }} catch {{ $r += 'fw-ipfs=' + $_.Exception.Message }}
$r -join "`n" | Set-Content -Path '{done}' -Encoding UTF8
"#,
        raven = raven.replace('\'', "''"),
        app = app.replace('\'', "''"),
        node = node.to_string_lossy().replace('\'', "''"),
        ipfs = ipfs.to_string_lossy().replace('\'', "''"),
        done = done.to_string_lossy().replace('\'', "''"),
    );

    let script = std::env::temp_dir().join("playx-raven-prep.ps1");
    if let Ok(mut f) = std::fs::File::create(&script) {
        let _ = f.write_all(ps.as_bytes());
    } else {
        return vec![step("백신·방화벽", false, "준비 파일을 만들지 못했습니다.")];
    }

    // 여기서 관리자 창이 **한 번** 뜬다.
    let run = crate::quiet::cmd("powershell")
        .args([
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            &format!(
                "Start-Process powershell -Verb RunAs -Wait -WindowStyle Hidden \
                 -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File','{}'",
                script.to_string_lossy().replace('\'', "''")
            ),
        ])
        .output();

    let text = std::fs::read_to_string(&done).unwrap_or_default();
    let _ = std::fs::remove_file(&script);
    let _ = std::fs::remove_file(&done);

    if text.trim().is_empty() {
        let why = match run {
            Ok(o) if !o.status.success() => "관리자 권한을 주지 않으셨습니다.".to_string(),
            Ok(_) => "관리자 권한을 주지 않으셨거나, 회사 정책으로 막혀 있습니다.".to_string(),
            Err(e) => e.to_string(),
        };
        return vec![
            step("백신에서 빼기", false, &why),
            step("방화벽 열기", false, &why),
        ];
    }

    let got = |k: &str| -> (bool, String) {
        for line in text.lines() {
            if let Some(v) = line.strip_prefix(&format!("{k}=")) {
                return (v.trim() == "ok", v.trim().to_string());
            }
        }
        (false, "결과를 못 읽었습니다.".into())
    };
    let (av1, av1w) = got("av-raven");
    let (av2, _) = got("av-app");
    let (fw1, fw1w) = got("fw-node");
    let (fw2, _) = got("fw-ipfs");
    vec![
        step(
            "백신에서 빼기",
            av1 && av2,
            if av1 && av2 {
                "장부 폴더를 검사에서 뺐습니다. 훑는 속도가 빨라집니다."
            } else {
                &av1w
            },
        ),
        step(
            "방화벽 열기",
            fw1 && fw2,
            if fw1 && fw2 {
                "다른 노드가 이 컴퓨터에 붙을 수 있습니다."
            } else {
                &fw1w
            },
        ),
    ]
}

#[cfg(not(target_os = "windows"))]
fn admin_part(_raven: &str, _app: &str) -> Vec<Value> {
    // 맥에는 이런 예외 설정 자체가 없다. 있는 척하지 않는다.
    vec![]
}

/// 단추 하나. **관리자 창은 한 번만.**
#[tauri::command]
pub async fn pc_prepare(boost: bool) -> Result<Value, String> {
    let raven = crate::paths::raven_dir();
    let app = crate::paths::app_dir();
    let mut out: Vec<Value> = Vec::new();

    // ── ① 관리자가 필요한 것 (윈도우) ───────────────────────────────
    let rs = raven.to_string_lossy().to_string();
    let ap = app.to_string_lossy().to_string();
    let admin = tauri::async_runtime::spawn_blocking(move || admin_part(&rs, &ap))
        .await
        .unwrap_or_default();
    out.extend(admin);

    // ── ② 메모리 (관리자 필요 없음) ─────────────────────────────────
    //    🔴 껐다 켜야 적용된다. 여기서 켜지 않는다 — 결제 확인이 몇 분 멈추고,
    //       장사 중이면 손님이 그 앞에 서 있다. **언제 끊을지는 사장이 정한다.**
    if boost {
        match crate::conf::dbcache_boost().await {
            Ok(v) => out.push(step(
                "메모리 넉넉히 주기",
                true,
                &format!(
                    "{} MB 로 올렸습니다. 노드를 껐다 켜야 적용됩니다.",
                    v.get("mb").and_then(Value::as_i64).unwrap_or(0)
                ),
            )),
            Err(e) => out.push(step("메모리 넉넉히 주기", false, &e)),
        }
    }

    // ── ③ 켤 때 같이 켜지기 ─────────────────────────────────────────
    if crate::autostart::autostart_get() {
        out.push(step("컴퓨터 켤 때 같이 켜기", true, "이미 켜져 있습니다."));
    } else {
        match crate::autostart::autostart_set(true) {
            Ok(true) => out.push(step(
                "컴퓨터 켤 때 같이 켜기",
                true,
                "이제 따로 실행 안 하셔도 됩니다 — 설정에서 끄실 수 있습니다.",
            )),
            Ok(false) | Err(_) => out.push(step(
                "컴퓨터 켤 때 같이 켜기",
                false,
                "이 컴퓨터에서는 못 켰습니다. 「이 컴퓨터 → 쉬운 설정」에서 다시 해 보십시오.",
            )),
        }
    }

    let bad = out.iter().filter(|s| s["ok"] != json!(true)).count();
    Ok(json!({
        "steps": out,
        "failed": bad,
        // 🔴 우리가 못 하는 것을 **먼저** 말한다. 다 된 줄 알고 기다리는 것이
        //    제일 나쁘다.
        "manual": if cfg!(target_os = "windows") {
            "다른 회사 백신(nProtect·V3·알약)을 쓰시면 그건 저희가 못 만집니다. \
             그 프로그램에서 아래 폴더를 검사 제외에 넣어 주십시오."
        } else {
            "맥에는 검사 제외 설정이 없습니다. 이 항목은 건너뜁니다."
        },
        "folder": raven.to_string_lossy(),
    }))
}

#[cfg(test)]
mod tests {
    /// 🔴 시험이 **자기 자신을 세면 안 된다.** 시험 글자에도 같은 낱말이
    ///    들어 있어서, 범위를 안 자르면 늘 통과하거나 늘 실패한다.
    ///    이 세션에서만 네 번 밟은 함정이다.
    fn 코드만() -> &'static str {
        let src = include_str!("prep.rs");
        let end = src.find("#[cfg(test)]").unwrap_or(src.len());
        &src[..end]
    }

    /// 🔴 관리자 창을 **두 번 띄우면 두 번째는 대개 「아니오」**다.
    ///    그래서 백신·방화벽을 한 장의 스크립트로 묶는다.
    #[test]
    fn 관리자_창은_한_번만_띄운다() {
        let n = 코드만().matches("-Verb RunAs").count();
        assert_eq!(n, 1, "관리자 창을 여러 번 띄우고 있다 — 두 번째는 거절당한다");
    }

    /// 한 줄이 실패해도 나머지는 가야 한다. 방화벽이 막혀도 백신 예외는 넣는다.
    #[test]
    fn 한_줄이_실패해도_나머지는_간다() {
        assert!(
            코드만().matches("catch {{").count() >= 4,
            "각 줄을 따로 감싸지 않고 있다 — 하나 실패하면 전부 멈춘다"
        );
    }

    /// 못 한 것을 못 했다고 말해야 한다. 다 된 줄 알고 기다리는 것이 제일 나쁘다.
    #[test]
    fn 우리가_못_하는_것을_말한다() {
        let src = 코드만();
        assert!(src.contains("nProtect"), "다른 백신은 못 만진다는 말이 없다");
        assert!(src.contains("\"manual\""), "손으로 할 일을 안 돌려준다");
    }

    /// 🔴 여기서 노드를 껐다 켜면 **장사 중에 결제 확인이 끊긴다.**
    ///    언제 끊을지는 사장이 정한다.
    #[test]
    fn 여기서_노드를_다시_켜지_않는다() {
        let src = 코드만();
        let i = src.find("pub async fn pc_prepare").expect("함수가 있어야 한다");
        assert!(
            !src[i..].contains("services_start"),
            "준비하면서 노드를 다시 켜고 있다 — 손님이 그 앞에 서 있을 수 있다"
        );
    }
}
