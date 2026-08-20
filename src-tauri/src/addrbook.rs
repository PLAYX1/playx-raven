//! 받을 주소록 — 코어 지갑의 주소록을 그대로 쓴다.
//!
//! ## 왜 우리 파일을 따로 안 만드나
//!
//! 레이븐 코어는 주소마다 이름을 붙이는 자리를 이미 갖고 있다
//! (`setaccount`/`getaccount`). 우리가 별도 파일에 이름을 저장하면 코어 지갑을
//! 열었을 때 이름이 없고, 코어에서 붙인 이름이 우리 화면에 안 나온다. 같은
//! 지갑을 두 프로그램이 다르게 기억하는 것은 사고의 씨앗이다.
//!
//! ## HD 지갑에는 "진짜 주소" 가 없다
//!
//! 씨앗 하나에서 주소가 무한히 나오고 **전부 같은 지갑**이다. 잔액은 그
//! 주소들의 합이다. 주소를 여러 개 쓰는 건 사고가 아니라 사생활 보호 설계다 —
//! 주소 하나만 쓰면 그걸 아는 사람이 그 사람의 거래 전부를 볼 수 있다.
//!
//! 그래서 이 화면은 "내 주소" 를 하나 고르라고 하지 않는다. **무엇에 쓰는
//! 주소인지 이름을 붙이게** 한다 — 가게 매출, 플랫폼 수수료, 개인 용돈처럼.
//! 나중에 세무에서 갈라 보려면 그 이름이 유일한 단서다.

use crate::raven::call_rpc;
use serde_json::{json, Value};

/// 우리 코드가 붙이는 이름들. 사람이 붙인 것과 구별해야 주소록이 산다.
fn is_machine_label(l: &str) -> bool {
    l == "order"
        || l == "shop"
        || l.starts_with("sell:")
        || l.starts_with("order-test")
        || l.starts_with("pass:")
}

/// 주소 하나에 이름을 붙인다. 이미 있는 이름을 다시 붙여도 된다.
#[tauri::command]
pub async fn addr_label(address: String, label: String) -> Result<Value, String> {
    let a = address.trim();
    if a.is_empty() {
        return Err("주소가 비어 있습니다.".into());
    }
    // 내 주소가 아닌 것에 이름을 붙이면, 화면에는 있는데 돈은 못 받는 줄이 생긴다.
    let v = call_rpc("validateaddress", json!([a])).await?;
    if !v["isvalid"].as_bool().unwrap_or(false) {
        return Err("올바른 레이븐 주소가 아닙니다.".into());
    }
    if !v["ismine"].as_bool().unwrap_or(false) {
        return Err("이 지갑의 주소가 아닙니다. 받을 주소록에는 내 주소만 넣습니다.".into());
    }
    call_rpc("setaccount", json!([a, label.trim()])).await?;
    Ok(json!({ "address": a, "label": label.trim() }))
}

/// 이름을 붙이면서 새 주소를 만든다.
#[tauri::command]
pub async fn addr_new(label: String) -> Result<Value, String> {
    let l = label.trim().to_string();
    let v = call_rpc("getnewaddress", json!([l.clone()])).await?;
    let a = v.as_str().unwrap_or_default().to_string();
    if a.is_empty() {
        return Err("주소를 만들지 못했습니다.".into());
    }
    Ok(json!({ "address": a, "label": l }))
}

/// 받을 주소록. 이름이 붙은 것과 돈이 오간 것만 보여 준다.
///
/// 코어가 만든 **거스름돈 주소**까지 전부 보여 주면 목록이 수십 줄이 되고,
/// 사장은 자기가 만든 적 없는 주소를 보며 "이게 뭐냐" 고 묻게 된다. 실제로
/// 이 지갑은 21개 주소 중 6개에만 돈이 있고 제일 큰 것이 거스름돈 주소다.
#[tauri::command]
pub async fn addr_book() -> Result<Value, String> {
    // 받은 적 있는 주소 — 이름과 누적 수령액이 여기 있다.
    let got = call_rpc("listreceivedbyaddress", json!([0, true])).await?;
    // 지금 잔액이 있는 주소 — 주소별로 모은다.
    let unspent = call_rpc("listunspent", json!([0, 9_999_999])).await?;

    let mut bal: std::collections::HashMap<String, f64> = std::collections::HashMap::new();
    for u in unspent.as_array().cloned().unwrap_or_default() {
        let asset = u.get("assetName").and_then(Value::as_str).unwrap_or("RVN");
        if asset != "RVN" {
            continue;
        }
        if let (Some(a), Some(v)) = (
            u.get("address").and_then(Value::as_str),
            u.get("amount").and_then(Value::as_f64),
        ) {
            *bal.entry(a.to_string()).or_insert(0.0) += v;
        }
    }

    let mut rows: Vec<Value> = Vec::new();
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    for r in got.as_array().cloned().unwrap_or_default() {
        let a = r.get("address").and_then(Value::as_str).unwrap_or("").to_string();
        if a.is_empty() {
            continue;
        }
        let label = r
            .get("label")
            .or_else(|| r.get("account"))
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        let received = r.get("amount").and_then(Value::as_f64).unwrap_or(0.0);
        let here = bal.get(&a).copied().unwrap_or(0.0);
        // 이름도 없고 받은 적도 없고 잔액도 없으면 보여 줄 이유가 없다.
        if label.is_empty() && received <= 0.0 && here <= 0.0 {
            continue;
        }
        // 🔴 우리 앱이 기계적으로 붙인 이름은 주소록이 아니다.
        //
        // 손님 주문마다 `getnewaddress "order"` 를 부르므로, 하루 장사하면
        // 이 목록이 `order` 로만 수십 줄이 된다. 실측: 대표님 지갑에서
        // 56줄 중 40줄이 `order` 였고, 직접 붙인 이름 여덟 개가 그 사이에
        // 묻혀 있었다. 주소록은 **사람이 붙인 이름**을 위한 자리다.
        if is_machine_label(&label) && here <= 0.0 {
            continue;
        }
        seen.insert(a.clone());
        rows.push(json!({
            "address": a, "label": label,
            "received": received, "balance": here,
            "used": received > 0.0,
        }));
    }
    // 잔액은 있는데 받은 목록에 없는 것(거스름돈)도 빠뜨리지 않는다.
    for (a, v) in bal {
        if seen.contains(&a) || v <= 0.0 {
            continue;
        }
        rows.push(json!({
            "address": a, "label": "", "received": 0.0, "balance": v,
            "used": false, "change": true,
        }));
    }
    // 이름 붙은 것 먼저, 그 다음 잔액 큰 순.
    rows.sort_by(|x, y| {
        let lx = !x["label"].as_str().unwrap_or("").is_empty();
        let ly = !y["label"].as_str().unwrap_or("").is_empty();
        ly.cmp(&lx).then(
            y["balance"]
                .as_f64()
                .unwrap_or(0.0)
                .partial_cmp(&x["balance"].as_f64().unwrap_or(0.0))
                .unwrap_or(std::cmp::Ordering::Equal),
        )
    });
    let total: f64 = rows.iter().filter_map(|r| r["balance"].as_f64()).sum();
    Ok(json!({ "rows": rows, "total": total, "count": rows.len() }))
}

#[cfg(test)]
mod tests {
    use super::is_machine_label;

    /// 우리가 붙인 이름이 주소록에 섞이면, 사장이 직접 붙인 이름이 그 사이에
    /// 묻힌다. 실측: 대표님 지갑 56줄 중 40줄이 `order` 였다.
    #[test]
    fn our_own_labels_are_not_address_book_entries() {
        for l in ["order", "shop", "sell:PLAYX#ABC", "order-test-1", "pass:1234"] {
            assert!(is_machine_label(l), "{l} 를 기계 이름으로 못 알아본다");
        }
    }

    /// 사람이 붙인 이름은 절대 숨기지 않는다. 하나라도 숨기면 그 사람은
    /// 자기 주소가 사라졌다고 생각한다.
    #[test]
    fn a_persons_own_label_is_never_hidden() {
        for l in [
            "NewravenMoosong", "윤경 바이낸스", "망고팜", "디센트무송",
            "김무송 작은 지갑", "무송레이븐바이낸스", "nowpayment",
            "PLAYX 풀노드로 전송", "문트리로 BM26 전달", "",
        ] {
            assert!(!is_machine_label(l), "{l} 가 숨겨진다");
        }
    }
}

// ── 밖의 지갑으로 받기 ─────────────────────────────────────────────────────
//
// 사장이 폰에 지갑을 하나 두고(rvn.ex.erci.se/wallet), 계산대는 그 주소로
// 받게 하고 싶을 수 있다. 가게 컴퓨터가 도둑맞아도 돈은 폰에 있고, 매출을
// 개인 지갑과 갈라 두기도 쉽다.
//
// 🔴 그 주소는 **이 지갑의 것이 아니다.** 그래서 두 가지가 따라온다:
//  · 이 앱은 그 돈을 **보낼 수 없다**(개인키가 폰에 있다). 환불도 폰에서 한다.
//  · 들어왔는지 보려면 **감시 주소로 등록**해야 한다. 등록해도 지갑 잔액에는
//    안 잡힌다 — 감시일 뿐이다.

/// 밖의 주소를 감시 목록에 넣는다.
///
/// `rescan` 은 끈다. 켜면 34GB 를 처음부터 다시 훑어 **몇 시간** 걸리고,
/// 그동안 노드가 다른 일을 못 한다. 끄면 **등록한 뒤에 들어오는 것만** 본다 —
/// 받을 주소로 쓰려는 것이니 그걸로 충분하다. 예전 것까지 보고 싶으면
/// 「이 컴퓨터」에서 다시 훑기를 따로 돌리면 된다.
#[tauri::command]
pub async fn watch_add(address: String, label: String) -> Result<Value, String> {
    let a = address.trim();
    if a.is_empty() {
        return Err("주소가 비어 있습니다.".into());
    }
    let v = call_rpc("validateaddress", json!([a])).await?;
    if !v["isvalid"].as_bool().unwrap_or(false) {
        return Err("올바른 레이븐 주소가 아닙니다.".into());
    }
    if v["ismine"].as_bool().unwrap_or(false) {
        return Err("이미 이 지갑의 주소입니다. 감시로 넣을 필요가 없습니다.".into());
    }
    if v["iswatchonly"].as_bool().unwrap_or(false) {
        return Ok(json!({ "address": a, "already": true }));
    }
    call_rpc("importaddress", json!([a, label.trim(), false])).await?;
    Ok(json!({ "address": a, "label": label.trim(), "already": false }))
}

/// 받을 QR 하나. 주소는 내 것이든 밖의 것이든 상관없다 — QR 은 그냥 주소다.
///
/// 금액을 넣으면 손님 지갑이 그 금액을 미리 채워 준다. 안 넣으면 손님이
/// 정한다. 가게가 아니라 **사람에게 받을 때**(정산·용돈)는 안 넣는 편이 낫다.
#[tauri::command]
pub async fn recv_qr(address: String, amount: Option<f64>, label: Option<String>) -> Result<Value, String> {
    let a = address.trim();
    let v = call_rpc("validateaddress", json!([a])).await?;
    if !v["isvalid"].as_bool().unwrap_or(false) {
        return Err("올바른 레이븐 주소가 아닙니다.".into());
    }
    let mut uri = format!("raven:{a}");
    let mut q: Vec<String> = Vec::new();
    if let Some(x) = amount {
        if x > 0.0 {
            q.push(format!("amount={x}"));
        }
    }
    if let Some(l) = label.as_ref().map(|s| s.trim()).filter(|s| !s.is_empty()) {
        // 공백과 한글이 그대로 들어가면 지갑에 따라 URI 를 못 읽는다.
        q.push(format!("label={}", urlish(l)));
    }
    if !q.is_empty() {
        uri.push('?');
        uri.push_str(&q.join("&"));
    }
    let svg = crate::server::qr_svg(uri.clone())?;
    Ok(json!({
        "address": a,
        "uri": uri,
        "svg": svg,
        "mine": v["ismine"].as_bool().unwrap_or(false),
        "watching": v["iswatchonly"].as_bool().unwrap_or(false),
    }))
}

/// URI 안에 넣을 수 있게. 완전한 퍼센트 인코딩은 아니고, 깨질 글자만 바꾼다.
fn urlish(s: &str) -> String {
    s.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                (b as char).to_string()
            }
            b' ' => "%20".into(),
            _ => format!("%{b:02X}"),
        })
        .collect()
}

#[cfg(test)]
mod qr_tests {
    use super::urlish;

    /// 한글 라벨이 그대로 들어가면 지갑에 따라 URI 를 통째로 못 읽는다 —
    /// 그러면 손님이 QR 을 찍어도 아무 일이 안 일어난다.
    #[test]
    fn a_korean_label_survives_the_uri() {
        let out = urlish("라비 커피");
        assert!(!out.contains(' '), "공백이 남았다");
        assert!(out.is_ascii(), "URI 에 못 들어갈 글자가 남았다: {out}");
        assert!(out.contains("%20"), "공백이 인코딩되지 않았다");
    }

    /// 영문·숫자는 그대로 둔다. 다 바꾸면 사람이 읽을 수 없게 된다.
    #[test]
    fn plain_text_is_left_alone() {
        assert_eq!(urlish("Ravi-Coffee_1.0"), "Ravi-Coffee_1.0");
    }
}
