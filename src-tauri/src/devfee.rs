//! 개발비 1% — **쌓아 두고, 사장이 한 번 눌러 보낸다.**
//!
//! ## 여태 어떻게 되어 있었나
//!
//! `shop::split_payment` 은 총액을 「가게 몫 99% + 개발비 1%」로 나눈다. 그
//! 숫자는 주문 화면에도 나가고 시험도 잠가 뒀다. 그런데 **그 1%가 실제 거래
//! 출력으로 나가는 길이 손님 경로에 없었다.**
//!
//! 손님이 카운터에서 찍는 QR 은 `raven:주소?amount=총액` 이다. 이 형식에는
//! 출력을 둘 넣을 자리가 없다 — 주소 하나에 금액 하나다. 그래서 총액이 전부
//! 가게 지갑으로 들어오고, 계산된 1% 는 화면에 뜬 뒤 버려졌다.
//!
//! ## 왜 손님 쪽을 안 고치는가
//!
//! 손님을 우리 지갑으로 몰면 걷을 수 있다. 안 한다. 카운터에 줄이 서 있고,
//! 손님이 어떤 지갑을 쓰든 QR 하나로 끝나야 한다. 지갑을 고르라고 하는
//! 순간 그건 장사 도구가 아니다.
//!
//! ## 그래서 이렇게 한다
//!
//! 돈은 전액 가게로 들어온다. 들어온 것이 확인된 순간 **여기에 1% 를 적어
//! 둔다.** 사장이 편할 때 「보내기」를 한 번 누르면 쌓인 만큼 한 거래로
//! 나간다.
//!
//! 자동으로 보내지 않는 이유는 하나다 — 자동으로 보내려면 **지갑을 계속
//! 열어 둬야 한다.** 가게 컴퓨터의 지갑 암호를 24시간 풀어 두는 것과 1% 를
//! 며칠 늦게 받는 것 중에서는, 늦게 받는 쪽이 낫다.
//!
//! ## 🔴 적힌 것은 지워지지 않는다
//!
//! 보내기가 실패해도 장부는 안 줄어든다. 줄이는 것은 **거래가 나간 뒤**
//! 뿐이다. 반대로 하면 네트워크가 한 번 끊길 때마다 우리 몫이 사라진다.

use serde_json::{json, Value};

fn ledger_file() -> std::path::PathBuf {
    crate::paths::app_file("devfee.json")
}

fn read() -> Value {
    std::fs::read_to_string(ledger_file())
        .ok()
        .and_then(|t| serde_json::from_str::<Value>(&t).ok())
        .unwrap_or_else(|| json!({ "owed": 0.0, "sent_total": 0.0, "history": [] }))
}

fn write(v: &Value) {
    let p = ledger_file();
    if let Some(dir) = p.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let _ = std::fs::write(&p, serde_json::to_vec_pretty(v).unwrap_or_default());
}

/// 8자리에서 자른다. 체인이 그 아래를 모른다.
fn round8(v: f64) -> f64 {
    (v * 1e8).round() / 1e8
}

/// 레이븐코인 주소처럼 생겼나.
///
/// 🔴 이 검사가 없어서 `fee.json` 에 `RSomewhere` 라는 **자리 표시 글자**가
/// 들어가 있었다. 그대로 `sendtoaddress` 를 부르면 노드가 거절하고, 화면에는
/// 영문 오류가 그대로 뜬다 — 사장은 자기 컴퓨터가 고장난 줄 안다.
///
/// 체인이 아는 검사(`validateaddress`)를 부르는 편이 정확하지만, 그건 노드가
/// 켜져 있어야 한다. 화면에 「보낼 수 있음/없음」을 그리는 데 노드를 깨울
/// 이유는 없다. 모양만 본다 — 진짜 검사는 보낼 때 노드가 한다.
pub fn looks_like_address(a: &str) -> bool {
    let a = a.trim();
    a.len() >= 26
        && a.len() <= 42
        && a.starts_with('R')
        && a.chars().all(|c| c.is_ascii_alphanumeric())
        // Base58 은 헷갈리는 네 글자를 뺀다. 여기 걸리면 사람이 손으로 적다
        // 틀린 것이다.
        && !a.contains(['0', 'O', 'I', 'l'])
}

/// 결제가 확인된 순간 1% 를 적는다.
///
/// 🔴 「주문이 들어왔을 때」가 아니라 **「돈이 들어온 것이 확인됐을 때」**다.
/// 주문만 하고 안 낸 손님의 1% 를 사장에게 물리면 그건 우리가 훔치는 것이다.
///
/// 사장이 수수료를 꺼 뒀으면 아무것도 안 적는다 — 껐는데 조용히 쌓아 두고
/// 나중에 청구하면 그건 끈 것이 아니다.
/// 이 거래에 **우리 주소로 나간 출력이 정말 있는가.**
///
/// 🔴 페이블 지적으로 만들었다. 앞서는 들어온 금액만 보고 갈랐는데,
/// 그러면 **외부 지갑으로 99% 만 보내면** 결제는 통과하고 장부에는 안 적힌다 —
/// 우리 지갑으로 낸 것처럼 위장해 1% 를 건너뛰는 정확한 우회였다.
/// 금액은 흉내 낼 수 있지만 **우리 주소로 간 출력은 흉내 낼 수 없다.**
///
/// `addressindex` 없이도 된다 — 거래 하나를 지목해서 묻는 것이라.
/// 못 읽으면 `None` 을 돌려준다. 그때는 부르는 쪽이 금액으로 어림잡는다.
pub fn tx_pays_us(vouts: &[Value], fee_rvn: f64, addr: &str) -> bool {
    vouts.iter().any(|o| {
        let paid = o.get("value").and_then(Value::as_f64).unwrap_or(0.0);
        if paid + 1e-8 < fee_rvn {
            return false;
        }
        o.get("scriptPubKey")
            .and_then(|s| s.get("addresses"))
            .and_then(Value::as_array)
            .map(|a| a.iter().any(|x| x.as_str() == Some(addr)))
            .unwrap_or(false)
    })
}

pub async fn fee_in_tx(txid: &str, fee_rvn: f64) -> Option<bool> {
    if txid.trim().is_empty() {
        return None;
    }
    let (_rate, addr) = crate::shop::fee_config();
    let tx = crate::raven::call_rpc("getrawtransaction", json!([txid, 1]))
        .await
        .ok()?;
    let vouts = tx.get("vout")?.as_array()?;
    Some(tx_pays_us(vouts, fee_rvn, &addr))
}

/// 이 결제에서 1% 가 **이미 체인으로** 나갔는가.
///
/// 🔴 손님이 내는 길이 둘인데 1% 가 나가는 방식이 다르다. 이걸 안 가르면
/// 우리 지갑을 쓴 손님의 결제에서 가게가 **2%** 를 낸다 — 실제로 그랬다.
///
/// | 낸 길 | 가게 주소에 들어온 것 | 1% 는 |
/// |---|---|---|
/// | 다른 지갑 (`raven:` 출력 하나) | 총액 100% | 아직 안 나감 → 장부에 적는다 |
/// | 우리 지갑 (`#pay`, 출력 둘) | 가게 몫 99% | 이미 나갔다 → 적지 않는다 |
///
/// `want` 는 가게 몫, `fee` 는 우리 몫이다.
pub fn already_on_chain(got: f64, want: f64, fee: f64) -> bool {
    // 1사토시 오차는 봐준다 — 8자리 반올림이 양쪽에서 일어난다.
    fee > 0.0 && got + 1e-8 < want + fee
}

/// 환불한 만큼 우리 몫을 **되돌린다.**
///
/// 🔴 환불이 개발비 장부를 전혀 안 건드리고 있었다. 손님에게 돈을 돌려준
/// 뒤에도 그 매출의 1% 는 가게가 우리에게 빚진 채로 남았다 —
/// **취소된 장사에서 우리가 돈을 받는 것**이고, 그건 받으면 안 되는 돈이다.
///
/// 건별로 못 되돌린다. 환불은 주문 주소가 아니라 **손님 주소와 금액**만
/// 받기 때문이다. 그래서 남은 빚에서 1% 만큼 깎는다. 총액으로는 맞고,
/// 낱건으로는 어긋날 수 있다 — 어긋나는 방향은 **가게에게 유리한 쪽**이다.
///
/// 이미 체인으로 나간 몫(우리 지갑 결제)은 못 되돌린다. 빚이 0 이면
/// 아무 일도 안 하고 0 을 돌려준다 — 깎았다고 거짓말하지 않는다.
pub fn refund_credit(refunded_rvn: f64) -> f64 {
    if refunded_rvn <= 0.0 {
        return 0.0;
    }
    let (rate, _addr) = crate::shop::fee_config();
    if rate <= 0.0 {
        return 0.0;
    }
    let mut v = read();
    let owed = v["owed"].as_f64().unwrap_or(0.0);
    if owed <= 0.0 {
        return 0.0;
    }
    // 빚보다 많이 깎지 않는다. 마이너스 장부는 다음 매출을 공짜로 만든다.
    let back = round8((refunded_rvn * rate).min(owed));
    v["owed"] = json!(round8(owed - back));
    if let Some(h) = v["history"].as_array_mut() {
        h.push(json!({ "order": "refund", "rvn": -back, "at": now() }));
    }
    write(&v);
    back
}

/// 받은 1% 를 장부에 적는다.
///
/// ## 🔴 **받은 그 순간의 시세를 같이 적는다**
///
/// 대표님: "만에 하나 돈을 받을 때 시점의 rvn 가격을 기록해 두는 게
///          좋을라나? 혹시 모르니 말야."
///
/// 「혹시」가 아니라 **필수**다. 나중에 이 RVN 을 팔 때 내는 세금이
/// `(판 금액 − 받았을 때 가액)` 으로 계산되는데, **받았을 때 가액을
/// 증명 못 하면 판 금액 전부가 차익으로 보일 여지가 있다.**
///
/// 그리고 **나중에 만들 수 없다.** 지난 시세를 짜맞춘 것은 증빙으로
/// 안 봐 줄 수 있다. 적는 시점은 지금뿐이다.
///
/// ⚠️ 매출장부(`ledger.rs`)는 이미 `1RVN당가격` 을 적고 있었다. 그런데
///    **우리 몫 장부만 안 적고 있었다** — `{order, rvn, at}` 이 전부였다.
///
/// ⚠️ 시세를 못 얻어도 **적는 것은 멈추지 않는다.** 1% 기록을 통째로
///    빠뜨리는 것이 시세 한 칸 비는 것보다 훨씬 나쁘다. 대신 **0 을 적지
///    않는다** — 0 을 적으면 나중에 「그때 0원이었다」로 읽힌다.
pub async fn accrue(order_addr: &str, fee_rvn: f64) {
    if fee_rvn <= 0.0 {
        return;
    }
    let (rate, _addr) = crate::shop::fee_config();
    if rate <= 0.0 {
        return;
    }

    let mut v = read();
    // 같은 주문을 두 번 적지 않는다. sweep 은 주기적으로 도는 함수라
    // 같은 주소를 다시 볼 수 있고, 그때마다 더하면 장부가 부풀어 오른다.
    let already = v["history"]
        .as_array()
        .map(|h| {
            h.iter()
                .any(|e| e.get("order").and_then(Value::as_str) == Some(order_addr))
        })
        .unwrap_or(false);
    if already {
        return;
    }

    let owed = round8(v["owed"].as_f64().unwrap_or(0.0) + fee_rvn);
    v["owed"] = json!(owed);

    // 🔴 **받은 그 순간의 시세를 같이 적는다. 나중에 못 만든다.**
    //
    // ⚠️ **달러를 기준으로 적는다.** 이 프로그램은 한국에서만 쓰는 것이
    //    아니다. 원화로만 적으면 브라질·독일 상인은 자기 세무에 못 쓴다.
    //    RVN/USD 가 세계 공통 기준이고, 각 나라 통화는 거기서 환산한다.
    //
    // ⚠️ 장부를 빌리기 **전에** 얻는다. 빌린 채로 기다리면 그동안 이 파일을
    //    아무도 못 만진다.
    //
    // ⚠️ 시세를 못 얻어도 **적는 것은 멈추지 않는다.** 1% 기록을 통째로
    //    빠뜨리는 것이 시세 한 칸 비는 것보다 훨씬 나쁘다. 그리고 **0 을
    //    적지 않는다** — 0 은 「그때 0원이었다」로 읽힌다.
    let (usd, src) = match crate::price::rvn_rate("USD".into()).await {
        Ok(r) => (
            r.get("rate").and_then(Value::as_f64),
            r.get("sources")
                .and_then(Value::as_array)
                .map(|a| a.iter().filter_map(Value::as_str).collect::<Vec<_>>().join("·"))
                .unwrap_or_default(),
        ),
        Err(e) => (None, format!("못 얻음: {e}")),
    };

    if let Some(h) = v["history"].as_array_mut() {
        h.push(json!({
            "order": order_addr,
            "rvn": round8(fee_rvn),
            "at": now(),
            // 1 RVN 이 그때 몇 달러였나. 못 얻었으면 null 이고 까닭은 아래.
            "usd_per_rvn": usd,
            "price_src": src,
        }));
        // 장부가 무한히 자라면 가게 컴퓨터에서 이 파일을 읽는 데만 시간이
        // 걸린다. 합계(`owed`·`sent_total`)는 남고 낱개만 줄인다.
        let n = h.len();
        if n > 5_000 {
            h.drain(0..n - 5_000);
        }
    }
    write(&v);
}

fn now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// 지금 얼마가 쌓여 있나. 화면에 그대로 보여 준다.
#[tauri::command]
pub fn fee_owed() -> Value {
    let v = read();
    let (rate, addr) = crate::shop::fee_config();
    json!({
        "owed": round8(v["owed"].as_f64().unwrap_or(0.0)),
        "sent_total": round8(v["sent_total"].as_f64().unwrap_or(0.0)),
        "count": v["history"].as_array().map(|h| h.len()).unwrap_or(0),
        "rate": rate,
        "address": addr,
        // 🔴 주소가 안 정해졌으면 「보낼 수 있다」고 말하면 안 된다. 눌렀다가
        // 실패하는 것보다 왜 못 누르는지 먼저 보이는 편이 낫다.
        "ready": looks_like_address(&addr),
    })
}

/// 쌓인 만큼 한 거래로 보낸다.
///
/// 🔴 순서가 중요하다. **거래가 나간 것을 확인한 뒤에** 장부를 줄인다.
/// 먼저 줄이면 인터넷이 한 번 끊길 때마다 그만큼이 사라진다.
/// 밀린 개발비를 **사장이 안 눌러도** 스스로 보낸다.
///
/// 🔴 다른 지갑으로 낸 결제는 총액이 가게 주소로 통째로 들어온다. 그 돈을
/// 움직일 수 있는 것은 가게 지갑뿐이라, 우리 몫은 **사장이 「개발비 보내기」를
/// 누를 때만** 나갔다. 안 누르면 영영 안 온다. 그건 받는 방식이 아니라
/// 기다리는 방식이다.
///
/// ## 암호를 저장하지 않는다
///
/// 가게 지갑은 암호로 잠겨 있다(실측). 자동으로 보내려면 암호가 필요한데,
/// **암호를 파일에 적어 두는 순간 그 컴퓨터를 가져간 사람이 가게 돈을 다
/// 가져간다.** 그래서 적지 않는다.
///
/// 대신 **이미 풀려 있는 순간**에 보낸다. 사장이 환불·발행·백업 때문에
/// 지갑을 풀면 그때 조용히 나간다. 잠겨 있으면 아무 일도 안 하고 다음을
/// 기다린다 — 잠금을 풀라고 조르지 않는다.
///
/// 암호가 아예 없는 지갑(개인이 돕는 노드 등)이면 언제나 바로 나간다.
pub fn start_auto_pay() {
    tauri::async_runtime::spawn(async {
        loop {
            // 3분마다 본다. 결제 하나에 곧바로 반응할 필요는 없다 —
            // 몇 분 늦게 가는 것이 지갑을 열어 두는 것보다 낫다.
            tokio::time::sleep(std::time::Duration::from_secs(180)).await;
            // 쌓인 것이 보낼 값어치가 되나. 0.01 RVN 미만이면 보내는 데
            // 드는 값이 더 크다.
            if read()["owed"].as_f64().unwrap_or(0.0) < 0.01 {
                continue;
            }
            // 지금 풀려 있나. 잠겨 있으면 **아무 말 없이** 넘어간다.
            let spendable = crate::raven::wallet_lock_state()
                .await
                .ok()
                .and_then(|v| v["unlocked"].as_bool())
                .unwrap_or(false);
            if !spendable {
                continue;
            }
            let _ = fee_pay().await;
        }
    });
}

// 🔴 **끄는 길을 두지 않는다.** 처음엔 스위치를 만들었다가 지웠다.
//    개발비는 끌 수 있는 것이 아니고(랜딩에도 그렇게 적혀 있다),
//    「누르는 것을 잊어서 안 가는 것」은 끄는 것과 결과가 같다.
//    끄고 싶은 사람은 소스가 열려 있으니 포크하면 된다 — 그게 우리 주장이다.

#[tauri::command]
pub async fn fee_pay() -> Result<Value, String> {
    let v = read();
    let owed = round8(v["owed"].as_f64().unwrap_or(0.0));
    let (_rate, addr) = crate::shop::fee_config();

    if !looks_like_address(&addr) {
        return Err("보낼 주소가 아직 정해지지 않았습니다.".into());
    }
    // 수수료보다 적은 돈을 보내면 보내는 값보다 드는 값이 크다.
    if owed < 0.01 {
        return Err("아직 보낼 만큼 쌓이지 않았습니다.".into());
    }

    let txid = crate::raven::call_rpc(
        "sendtoaddress",
        json!([addr, owed, "PLAY X 개발비", "", false]),
    )
    .await?;
    let txid = txid.as_str().unwrap_or_default().to_string();
    if txid.is_empty() {
        // 노드가 거래 번호를 안 줬으면 나갔는지 알 수 없다. 장부를 안 줄인다.
        return Err("보내지 못했습니다. 지갑이 잠겨 있는지 확인해 주세요.".into());
    }

    // 나간 것을 확인했다. 이제 줄인다. 그 사이 새로 쌓인 것이 있을 수 있으니
    // 다시 읽어서 **보낸 만큼만** 뺀다 — 통째로 0 으로 만들면 그 사이의
    // 결제 한 건이 조용히 사라진다.
    let mut fresh = read();
    let left = round8((fresh["owed"].as_f64().unwrap_or(0.0) - owed).max(0.0));
    fresh["owed"] = json!(left);
    fresh["sent_total"] = json!(round8(
        fresh["sent_total"].as_f64().unwrap_or(0.0) + owed
    ));
    if let Some(h) = fresh["history"].as_array_mut() {
        h.push(json!({ "sent": owed, "txid": txid, "at": now() }));
    }
    write(&fresh);

    Ok(json!({ "txid": txid, "sent": owed, "left": left }))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 🔴 `fee.json` 에 실제로 들어 있던 자리 표시 글자다. 이게 통과하면
    /// 우리 수수료가 존재하지 않는 주소로 나간다 — 체인은 되돌리지 않는다.
    #[test]
    fn the_placeholder_that_was_really_in_the_config_is_refused() {
        assert!(!looks_like_address("RSomewhere"));
        assert!(!looks_like_address(""));
        assert!(!looks_like_address("  "));
    }

    /// 노드가 검사해 준 진짜 주소는 통과해야 한다. 안 그러면 켜도 못 보낸다.
    #[test]
    fn the_validated_address_passes() {
        assert!(looks_like_address("RLFnbkjmf1VCVq7D9TZvRp7fv6W97rm2cB"));
    }

    #[test]
    fn round8_keeps_what_the_chain_can_hold() {
        assert_eq!(round8(0.123_456_789), 0.123_456_79);
        assert_eq!(round8(1.0), 1.0);
    }

    /// 🔴 0 이하를 적으면 장부가 이상해진다. 음수 수수료는 우리가 가게에
    /// 돈을 주는 것이고, 그런 길은 있어서는 안 된다.
    #[test]
    fn nothing_is_written_for_a_zero_or_negative_fee() {
        // 🔴 대표님의 **진짜 장부**를 건드리면 안 된다. 여태 이 시험이
        //    실제 devfee.json 을 읽고 있었고, 앱이 돌면서 거기 기록이
        //    쌓이자 시험이 깨졌다 — 시험이 남의 돈 장부를 보고 있었다.
        //    옆의 환불 시험처럼 공용 자물쇠를 잡고 임시 폴더로 보낸다.
        let _g = crate::paths::TEST_ENV.lock().unwrap_or_else(|e| e.into_inner());
        let d = std::env::temp_dir().join("playx-devfee-zero-test");
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        std::env::set_var("PLAYX_RAVEN_HOME", &d);
        // 파일을 안 건드리는 것으로 확인한다 — accrue 는 0 이하에서 즉시 나간다.
        let before = std::fs::read(ledger_file()).ok();
        tauri::async_runtime::block_on(accrue("RtestZero", 0.0));
        tauri::async_runtime::block_on(accrue("RtestNeg", -5.0));
        assert_eq!(std::fs::read(ledger_file()).ok(), before);
        let _ = std::fs::remove_dir_all(&d);
    }

    /// 🔴 자동 송금에 **끄는 길이 있으면 안 된다.** 한 번 만들었다가 지웠고,
    /// 다시 들어오지 못하게 여기서 막는다. 「누르는 것을 잊어서 안 가는 것」은
    /// 끄는 것과 결과가 같다.
    #[test]
    fn 자동_송금을_끌_수_있는_길이_없다() {
        // 🔴 이 시험은 **자기 소스를 읽는다.** 금지어를 그대로 적으면 자기
        //    자신에 걸려 늘 실패한다. 조립해서 쓴다 — 이 저장소에서 같은
        //    함정을 네 번째로 본다.
        //
        //    그리고 이 시험은 여태 **한 번도 안 돌았다.** 위 시험의 본문이
        //    깨져 있어서 이게 안쪽 함수가 됐고, 안쪽 함수의 `#[test]` 는
        //    무시된다. 「있는데 안 도는 코드」가 시험에도 있었다.
        let src = include_str!("devfee.rs");
        for banned in [
            format!("fee{}auto{}set", "_", "_"),
            format!("auto{}off", "_"),
            format!("devfee{}auto", "-"),
        ] {
            let banned = banned.as_str();
            assert!(!src.contains(banned), "개발비를 끄는 길이 생겼다: {banned}");
        }
        assert!(src.contains("start_auto_pay"), "자동 송금이 있어야 한다");
        // 🔴 암호를 파일에 적으면 그 컴퓨터를 가져간 사람이 가게 돈을 다 가져간다.
        for banned in [
            format!("pass{}\"", "phrase"),
            format!("wallet{}{}", "pass", "phrase"),
        ] {
            let banned = banned.as_str();
            assert!(!src.contains(banned), "개발비 코드가 지갑 암호를 만지고 있다: {banned}");
        }
    }

    /// 🔴 환불했는데 그 매출의 1% 를 계속 받고 있던 것.
    #[test]
    fn 환불하면_우리_몫도_되돌린다() {
        // 🔴 대표님의 진짜 장부를 건드리면 안 된다. `paths.rs` 의 공용
        //    자물쇠를 잡고 임시 폴더로 보낸다.
        let _g = crate::paths::TEST_ENV.lock().unwrap_or_else(|e| e.into_inner());
        let d = std::env::temp_dir().join("playx-devfee-refund-test");
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        std::env::set_var("PLAYX_RAVEN_HOME", &d);
        {
            tauri::async_runtime::block_on(accrue("Rorder1", 1.0)); // 100 RVN 매출의 1%
            assert_eq!(fee_owed()["owed"].as_f64().unwrap(), 1.0);
            // 50 RVN 을 환불하면 0.5 를 깎는다.
            assert_eq!(refund_credit(50.0), 0.5);
            assert_eq!(fee_owed()["owed"].as_f64().unwrap(), 0.5);
            // 빚보다 많이 환불해도 마이너스로 안 간다.
            assert_eq!(refund_credit(10_000.0), 0.5);
            assert_eq!(fee_owed()["owed"].as_f64().unwrap(), 0.0);
            // 빚이 0 이면 깎았다고 거짓말하지 않는다.
            assert_eq!(refund_credit(50.0), 0.0);
        }
        let _ = std::fs::remove_dir_all(&d);
        std::env::remove_var("PLAYX_RAVEN_HOME");
    }

    /// 🔴 우리 지갑으로 낸 손님의 결제에서 가게가 2% 를 내던 것.
    #[test]
    fn 우리_지갑으로_내면_장부에_또_적지_않는다() {
        // 총액 100, 가게 몫 99, 우리 몫 1.
        // 다른 지갑: 가게 주소에 100 이 들어온다 → 아직 안 냈다.
        assert!(!already_on_chain(100.0, 99.0, 1.0), "총액이 다 왔으면 장부에 적어야 한다");
        // 우리 지갑: 가게 주소에 99 만 들어온다 → 체인에서 이미 냈다.
        assert!(already_on_chain(99.0, 99.0, 1.0), "99%만 왔으면 이미 나간 것이다");
        // 1사토시 더 들어온 경우도 「이미 나갔다」로 본다.
        assert!(already_on_chain(99.000000005, 99.0, 1.0));
        // 조금 더 낸 손님(총액보다 많이) — 아직 안 낸 것이다.
        assert!(!already_on_chain(100.5, 99.0, 1.0));
        // 우리 몫이 0 이면 가를 것이 없다.
        assert!(!already_on_chain(50.0, 50.0, 0.0));
    }



    /// 🔴 페이블 지적. 금액만 보면 99% 송금으로 1% 를 건너뛸 수 있다.
    /// 체인에서 **우리 주소로 나간 출력**을 보면 흉내 낼 수 없다.
    #[test]
    fn 우리_주소로_간_출력이_있어야_이미_낸_것이다() {
        let us = "RLFnbkjmf1VCVq7D9TZvRp7fv6W97rm2cB";
        let vout = |v: f64, a: &str| {
            json!({ "value": v, "scriptPubKey": { "addresses": [a] } })
        };
        // 우리 지갑 결제: 가게 99 + 우리 1
        let ours = vec![vout(99.0, "Rshop"), vout(1.0, us)];
        assert!(tx_pays_us(&ours, 1.0, us));
        // 🔴 우회 시도: 외부 지갑으로 99 만 보냄. 우리 출력이 없다.
        let dodge = vec![vout(99.0, "Rshop")];
        assert!(!tx_pays_us(&dodge, 1.0, us), "99%만 보내는 우회를 잡아야 한다");
        // 우리 주소로 가긴 했는데 액수가 모자란 경우도 아니다.
        let short = vec![vout(99.0, "Rshop"), vout(0.1, us)];
        assert!(!tx_pays_us(&short, 1.0, us), "모자란 액수를 낸 것으로 치면 안 된다");
    }
}
