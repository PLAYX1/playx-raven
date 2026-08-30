//! **손님을 받기까지 무엇이 남았나** — 한 자리에서 알려 준다.
//!
//! ## 🔴 왜 필요한가
//!
//! 대표님: "출입도 내 가게에서 하는 일 아닌가? 내 가게가 헬스장일지
//!          술집일지 모르는 거잖아. 내 가게 안에 구현되어야 하는 게 아닌가."
//!
//! 맞다. 지금은 한 가지 일이 **세 화면에 흩어져** 있다:
//!
//!   「자산」    회원권을 만든다
//!   「내 가게」 가게를 연다
//!   「출입」    입구에서 쓴다
//!
//! 그리고 **셋이 이어져 있다는 것을 아무 데도 안 알려 준다.** 사장은 어디서
//! 시작하는지도 모른다. 헬스장을 열려면 세 화면을 돌아야 하는데, 그 순서를
//! 아는 사람은 이 코드를 쓴 사람뿐이다.
//!
//! 화면 구조를 옮기는 것은 큰 일이라 나눠서 한다. 먼저 **순서를 말해 주고
//! 안 된 곳으로 데려간다.** 그것만으로 대부분이 풀린다.
//!
//! ## ⚠️ 모르면 「안 됐다」가 아니라 「모른다」
//!
//! 노드가 장부를 다시 훑는 중이면 자산을 못 읽는다. 그때 「아직 안 만드셨다」고
//! 하면 **이미 만든 사장에게 다시 만들라고 하는 것**이다. 100 RVN 이 두 번 탄다.
//! 이 저장소에서 오늘만 여러 번 낸 사고가 그것이다.

use serde_json::{json, Value};

/// 한 걸음.
fn step(key: &str, title: &str, why: &str, go: &str, state: &str, note: &str) -> Value {
    json!({
        "key": key,
        "title": title,
        "why": why,
        // 화면이 데려갈 곳. 왼쪽 차림표의 이름이다.
        "go": go,
        // "done" | "todo" | "unknown"  — 셋이다. 「모른다」를 빼면 사고가 난다.
        "state": state,
        "note": note,
    })
}

/// 지금 어디까지 왔나.
#[tauri::command]
pub async fn shop_setup() -> Value {
    // ── ① 팔 것이 있나 ──────────────────────────────────────────────
    let (asset_state, asset_note, asset_name) = match crate::shop::shop_detect_asset().await {
        Ok(v) => {
            let n = v.get("asset").and_then(Value::as_str).unwrap_or("").to_string();
            if n.is_empty() {
                (
                    "todo",
                    // 「없습니다」로 끝내면 다음에 뭘 할지가 없다.
                    "아직 없습니다. 아래 「가게 정보」에서 이름을 적고 등록하시면 됩니다."
                        .to_string(),
                    String::new(),
                )
            } else {
                ("done", format!("{n} 을(를) 갖고 계십니다."), n)
            }
        }
        // 🔴 못 읽은 것을 「없다」로 치지 않는다. 이미 만드신 분께 또 만들라고
        //    하면 100 RVN 이 두 번 탄다.
        Err(e) => ("unknown", format!("지금은 확인할 수 없습니다 — {e}"), String::new()),
    };

    // ── ② 손님이 살 수 있나 (가게가 열렸나) ─────────────────────────
    //    「열렸다」의 기준은 **체인에 가게 정보가 붙었나**다. 손님 화면
    //    서버가 도는 것만으로는 부족하다 — 그건 이 컴퓨터 안에서만 참이고,
    //    손님은 체인을 보고 찾아온다.
    let (shop_state, shop_note) = if asset_name.is_empty() {
        // 자산이 없으면 가게도 없다. 앞 걸음이 먼저다.
        if asset_state == "unknown" {
            ("unknown", "먼저 팔 것을 확인해야 합니다.".to_string())
        } else {
            ("todo", "팔 것을 먼저 만드셔야 합니다.".to_string())
        }
    } else {
        match crate::raven::call_rpc("getassetdata", json!([asset_name.clone()])).await {
            Ok(d) => {
                let cid = d.get("ipfs_hash").and_then(Value::as_str).unwrap_or("");
                if cid.is_empty() {
                    ("todo", "가게 이름·사진·파는 것을 아직 안 올리셨습니다.".to_string())
                } else {
                    ("done", "손님이 폰으로 볼 수 있습니다.".to_string())
                }
            }
            Err(e) => ("unknown", format!("지금은 확인할 수 없습니다 — {e}")),
        }
    };

    // ── ③ 입구에서 쓸 수 있나 (문) ──────────────────────────────────
    //    ⚠️ 이건 **모든 가게에 필요한 것이 아니다.** 헬스장·스터디카페에는
    //       필요하고 술집에는 필요 없다. 그래서 「해야 할 일」이 아니라
    //       「하실 수 있는 일」로 적는다.
    let doors = crate::door::door_list();
    let door_n = doors
        .get("doors")
        .and_then(Value::as_array)
        .or_else(|| doors.as_array())
        .map(|a| a.len())
        .unwrap_or(0);
    let (door_state, door_note) = if doors.is_null() {
        ("unknown", "지금은 확인할 수 없습니다.".to_string())
    } else if door_n > 0 {
        ("done", format!("문 {door_n}개가 등록돼 있습니다."))
    } else {
        ("todo", "회원이 스스로 들어오게 하시려면 문을 등록하세요.".to_string())
    };

    let steps = vec![
        // 🔴 **말과 하는 일이 달랐다.**
        //
        //    「팔 것 만들기 — 회원권·이용권·쿠폰을 만듭니다」라고 적고
        //    「지금 하기」는 **「자산」 화면**으로 보냈다. 그런데 이 걸음이
        //    끝났는지 보는 검사는 `SHOP.…`(가게 등록)이다. 즉 사장이
        //    시키는 대로 자산을 아무리 만들어도 **①이 영원히 안 끝난다.**
        //    `SHOP.` 을 내야 끝나는데 그 말은 어디에도 없었다.
        //
        //    대표님: "내 가게 가면 뭘 어떻게 하는 건지 모르겠어."
        //    모르는 게 당연하다. 커피집 사장에게 「회원권을 만들라」고 한
        //    것도 틀렸다 — 커피를 파는 데 회원권은 필요 없다.
        //
        //    이 걸음의 정체는 **가게 이름을 체인에 내는 것**이다. 그대로 적고,
        //    데려가는 곳도 그 위저드가 있는 「내 가게」로 맞춘다.
        step(
            "asset",
            "가게 이름 만들기",
            "가게 이름을 블록체인에 냅니다. 이게 있어야 손님이 찾아옵니다. 한 번만 하면 됩니다.",
            "shop",
            asset_state,
            &asset_note,
        ),
        step(
            "shop",
            "가게 열기",
            "손님이 폰으로 보고 살 수 있는 화면이 열립니다.",
            "shop",
            shop_state,
            &shop_note,
        ),
        step(
            "door",
            "입구에 문 달기 (선택)",
            "회원권을 가진 분이 스스로 들어오게 합니다. 헬스장·스터디카페에 씁니다.",
            "door",
            door_state,
            &door_note,
        ),
    ];

    // 🔴 **지금 할 것 하나만 가리킨다.** 셋을 나란히 놓으면 어느 것부터인지
    //    모른다. 「모르는 것」은 다음으로 안 고른다 — 확인이 안 될 뿐이지
    //    할 일이 아닐 수 있다.
    let next = steps
        .iter()
        .find(|s| s["state"] == json!("todo") && s["key"] != json!("door"))
        .and_then(|s| s["key"].as_str())
        .unwrap_or("")
        .to_string();

    json!({
        "steps": steps,
        "next": next,
        "asset": asset_name,
        // 다 됐으면 그 말을 한다. 끝이 안 보이면 사람은 계속 불안하다.
        "ready": next.is_empty(),
    })
}

#[cfg(test)]
mod tests {
    fn 코드만() -> &'static str {
        let src = include_str!("setupflow.rs");
        let end = src.find("#[cfg(test)]").unwrap_or(src.len());
        &src[..end]
    }

    /// 🔴 **못 읽은 것을 「안 했다」로 치면 안 된다.** 이미 만드신 분께
    ///    또 만들라고 하면 100 RVN 이 두 번 탄다.
    #[test]
    fn 모를_때는_모른다고_한다() {
        let src = 코드만();
        // ⚠️ **개수를 세지 않는다.** 코드를 조금만 고쳐도 개수가 바뀌어
        //    시험이 깨진다(실제로 깨졌다). 세 걸음이 **각각** 「모른다」를
        //    다루는지 본다.
        for (걸음, 표) in [
            ("① 팔 것", "let (asset_state"),
            ("② 가게", "let (shop_state"),
            ("③ 문", "let (door_state"),
        ] {
            let i = src.find(표).unwrap_or_else(|| panic!("{걸음} 걸음을 못 찾았다"));
            let end = src[i..].find("\n\n").unwrap_or(src.len() - i);
            assert!(
                src[i..i + end].contains("\"unknown\""),
                "{걸음} 이 「모른다」를 안 다룬다 — 못 읽은 것을 「안 했다」로 치면 \
                 이미 만드신 분께 또 만들라고 한다"
            );
        }
    }

    /// 🔴 「모르는 것」을 다음 할 일로 고르면, 확인이 안 될 뿐인데 사장을
    ///    엉뚱한 데로 보낸다.
    #[test]
    fn 모르는_것을_다음으로_고르지_않는다() {
        let src = 코드만();
        let i = src.find("let next = steps").expect("다음을 고르는 곳이 있어야 한다");
        let seg = &src[i..i + 400.min(src.len() - i)];
        assert!(seg.contains(r#"json!("todo")"#), "「할 일」만 고르고 있지 않다");
    }

    /// ⚠️ 문은 **모든 가게에 필요하지 않다.** 술집에 문 달라고 하면 안 된다.
    #[test]
    fn 문은_선택이다() {
        let src = 코드만();
        assert!(src.contains("입구에 문 달기 (선택)"), "문을 필수로 적고 있다");
        let i = src.find("let next = steps").expect("있어야 한다");
        assert!(
            src[i..].contains(r#"s["key"] != json!("door")"#),
            "문을 다음 할 일로 고르고 있다 — 술집 사장에게 문을 달라고 한다"
        );
    }
}
