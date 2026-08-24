//! Who is holding the screen.
//!
//! Until now this app had two kinds of person: the owner, who can do
//! everything, and the customer, who can do almost nothing. A real shop has
//! more:
//!
//! - **사장** — everything, including money and irreversible things
//! - **직원** — takes orders, moves them along, checks members in. Cannot see
//!   the wallet, cannot send, cannot issue
//! - **검표** — a tablet by the door that scans a ticket and answers yes or no.
//!   Nothing else
//! - **손님** — browses and orders
//!
//! ## Why each role gets its own token
//!
//! A single token shared by everyone is the owner's token, and once it is on a
//! staff phone it is on whatever that phone gets up to. Separate tokens mean a
//! staff member who leaves takes nothing with them: revoke that one token and
//! their screen stops working while the counter keeps running.
//!
//! Tokens are minted per role at start-up and can be rotated individually.
//! None of them is stored — a restart invalidates every screen, which is the
//! right default for devices that live in a shop.
//!
//! ## What a role cannot do is enforced by the router
//!
//! Not by hiding buttons. A staff screen does not merely lack a send button;
//! its token is rejected by every route that can spend. That distinction is the
//! whole point — a hidden button is a URL away from being pressed.

use serde_json::{json, Value};

/// The roles, in order of how much damage each can do.
pub const ROLES: [&str; 4] = ["owner", "staff", "scanner", "customer"];

/// What each role is for, and what it deliberately cannot reach.
#[tauri::command]
pub fn role_catalogue() -> Value {
    json!([
        {
            "id": "owner", "name": "사장",
            "can": ["주문·메뉴·회원 전부", "지갑과 송금", "자산 발행·판매", "설정"],
            "cannot": [],
            "where": "사장님 폰. 이 QR만 다른 사람에게 보이지 마세요.",
            "danger": true
        },
        {
            "id": "staff", "name": "직원",
            "can": ["들어온 주문 처리", "메뉴 품절 표시", "회원 출입 확인", "회원 정보 보기"],
            "cannot": ["지갑·잔액", "송금·환불", "자산 발행", "설정 변경", "회원권 발급"],
            "where": "직원 폰이나 주방 태블릿.",
            "danger": false
        },
        {
            "id": "scanner", "name": "검표",
            "can": ["티켓·회원권 확인", "입장 처리"],
            "cannot": ["주문 보기", "회원 명단", "그 밖의 모든 것"],
            "where": "문 앞 태블릿. 하루 종일 켜 두는 화면입니다.",
            "danger": false
        },
        {
            "id": "customer", "name": "손님",
            "can": ["메뉴 보기", "주문·결제", "질문"],
            "cannot": ["다른 사람 주문", "가게 정보 수정"],
            "where": "카운터에 붙이는 QR. 아무나 찍어도 됩니다.",
            "danger": false
        }
    ])
}

/// Which routes each role may reach.
///
/// Prefix matching, checked in the server before the handler runs. Listed here
/// rather than scattered through handlers so the whole permission surface can
/// be read in one place — a rule you cannot see is a rule nobody checks.
pub fn allowed(role: &str, path: &str) -> bool {
    match role {
        "owner" => true,
        "staff" => {
            path.starts_with("/api/staff/")
                || path.starts_with("/api/admin/orders")
                || path.starts_with("/api/admin/state")
                || path.starts_with("/api/admin/states")
                || path.starts_with("/api/admin/shop")
                // 환불은 돈이 나가는 일이라 예외로 열되, 금액은 refund.rs 가
                // 막는다. 권한을 여는 것과 한도를 거는 것은 다른 일이다.
                || path.starts_with("/api/staff/refund")
                // 손님이 내민 표가 진짜인지 보는 것까지. 확인(check)만 열고
                // 입장 처리(in)는 열지 않는다 — 읽는 일과 쓰는 일은 다르다.
                || path == "/api/scan/check"
                // 라비에게 묻기. 직원도 "부분 환불은 어떻게 하나요" 를 물을 수
                // 있어야 한다 — 못 물으면 사장에게 전화하고, 그 사이 손님이 선다.
                //
                // ⚠️ 답은 노드가 **사장 열쇠**로 만든다. 직원 폰에는 열쇠가
                // 없고 넣지도 않는다(`web/ravi.js` 첫 주석). 예산은 손님 응대와
                // 같은 지갑에서 나가므로 직원이 길게 놀면 손님 응대가 멈춘다 —
                // 그건 `take_ask_budget` 이 막는다.
                || path == "/api/owner-ask"
                || path == "/api/ai-status"
                || path == "/ravi.js"
                || path == "/staff"
        }
        "scanner" => path.starts_with("/api/scan/") || path == "/scan",
        // 손님 경로는 토큰이 없다. 여기 오는 일 자체가 없어야 한다.
        _ => false,
    }
}

/// Everything a role is not allowed to do, as sentences for the screen.
///
/// Shown on the staff and scanner screens themselves, so the person holding it
/// knows why a thing is missing instead of assuming the app is broken.
#[tauri::command]
pub fn role_limits(role: String) -> Value {
    let cat = role_catalogue();
    let found = cat
        .as_array()
        .and_then(|a| {
            a.iter()
                .find(|r| r.get("id").and_then(Value::as_str) == Some(role.as_str()))
        })
        .cloned();
    found.unwrap_or(json!({}))
}

#[cfg(test)]
mod tests {
    use super::allowed;

    /// 직원 화면은 브라우저가 그대로 읽는다. TypeScript 문법이 한 줄이라도
    /// 있으면 그 줄에서 스크립트가 멈추고, 주문 목록은 "불러오는 중…" 에
    /// 영원히 남는다. 실제로 환불 칸의 `as HTMLInputElement` 가 그렇게 했다.
    #[test]
    fn staff_screen_is_plain_javascript() {
        let html = include_str!("../../web/staff.html");
        assert!(
            !html.contains(" as HTML")
                && !html.contains(" as unknown")
                && !html.contains(" as any")
                && !html.contains(" as string"),
            "직원 화면에 TypeScript 문법이 있습니다 — 화면이 통째로 멈춥니다"
        );
    }

    /// The staff screen's own source is the specification.
    ///
    /// This exists because the staff screen shipped completely dead: every one
    /// of the six paths it calls was refused, and the screen rendered the 401s
    /// as "아직 주문이 없습니다". Nothing failed loudly — not the compiler, not
    /// the tests, not the screen. Reading the paths out of the file means the
    /// permission list can no longer drift away from the screen that needs it.
    #[test]
    fn staff_screen_can_reach_everything_it_calls() {
        let html = include_str!("../../web/staff.html");

        let mut paths: Vec<&str> = Vec::new();
        let mut rest = html;
        while let Some(i) = rest.find("\"/api/") {
            rest = &rest[i + 1..];
            if let Some(end) = rest.find('"') {
                let p = &rest[..end];
                // 템플릿으로 조립되는 주소는 건너뛴다.
                if !p.contains("${") && !paths.contains(&p) {
                    paths.push(p);
                }
            }
        }

        assert!(
            paths.len() >= 5,
            "직원 화면에서 경로를 못 읽었습니다 — 화면이 바뀌었으면 이 시험도 고쳐야 합니다: {paths:?}"
        );
        for p in paths {
            assert!(
                allowed("staff", p),
                "직원 화면은 {p} 를 부르는데 직원 권한에 없습니다"
            );
        }
    }

    /// 권한을 여는 것과 다 여는 것은 다르다.
    #[test]
    fn staff_cannot_reach_the_owners_things() {
        for p in [
            "/api/admin/publish",  // 체인에 쓰는 일
            "/api/admin/issue",    // 자산 발행 — RVN 이 탄다
            "/api/admin/machine",  // 노드 재시작
            "/api/admin/backup",   // 지갑이 들어가는 백업
            "/api/scan/in",        // 입장 처리는 쓰는 일이다
            "/wallet",
        ] {
            assert!(!allowed("staff", p), "직원에게 {p} 가 열려 있습니다");
        }
    }
}
