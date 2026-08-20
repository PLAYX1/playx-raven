//! Moving takings off the counter machine, and opening hours.
//!
//! ## Why a sweep matters more with ten shops than with one
//!
//! Each shop keeps its own node and its own wallet — that is what makes this
//! decentralised rather than a chain of terminals reporting to head office. It
//! also means every counter is a machine holding money, and the amount grows
//! all day while nobody watches it.
//!
//! A sweep moves everything above a threshold to a wallet that is not on a shop
//! counter. It does not make the counter safe; it makes the counter *shallow*.
//! By closing time the till holds a float, not a week of takings.
//!
//! ## The rule that keeps this from being the attack
//!
//! An automatic sender is exactly what an attacker would install. So the
//! destination is fixed when the feature is switched on and cannot be changed
//! without the passphrase — an intruder with the running app cannot redirect
//! the sweep, only trigger a payment to the owner's own cold wallet.
//!
//! ## Opening hours
//!
//! A shop that is closed should say so. Without it, a customer orders at 2am,
//! pays, and stands outside a dark building — and the refund path we have is
//! "the shop sends it back", which nobody is awake to do.

use crate::raven::call_rpc;
use serde_json::{json, Value};
use std::path::PathBuf;
use std::sync::Mutex;

fn store() -> PathBuf {
    crate::paths::app_file("sweep.json")
}

fn load() -> Value {
    std::fs::read_to_string(store())
        .ok()
        .and_then(|r| serde_json::from_str(&r).ok())
        .unwrap_or_else(|| json!({}))
}

fn save(v: &Value) -> Result<(), String> {
    if let Some(d) = store().parent() {
        let _ = std::fs::create_dir_all(d);
    }
    std::fs::write(store(), serde_json::to_vec_pretty(v).map_err(|e| e.to_string())?)
        .map_err(|e| format!("저장하지 못했습니다: {e}"))
}

/// Sets up the sweep. The destination is verified before it is stored.
///
/// `keep` is what stays behind — change, small refunds, the fee on the next
/// asset transfer. Sweeping to zero leaves a shop unable to send anything,
/// including the refund a customer is standing there asking for.
#[tauri::command]
pub async fn sweep_configure(
    to_address: String,
    above: f64,
    keep: f64,
    enabled: bool,
) -> Result<Value, String> {
    // 끄는 것은 검사하지 않는다. 잘못 저장해 둔 주소 때문에 **끌 수조차 없게**
    // 되면 사장님은 기능에 갇힌다. 끌 때는 있던 설정의 스위치만 내린다.
    if !enabled {
        let mut v = load();
        if !v.is_object() {
            v = json!({});
        }
        v["enabled"] = json!(false);
        save(&v)?;
        return Ok(v);
    }
    let check = crate::send::check_address(to_address.clone()).await?;
    if !check["valid"].as_bool().unwrap_or(false) {
        return Err("보낼 주소가 올바르지 않습니다.".into());
    }
    if check["is_mine"].as_bool().unwrap_or(false) {
        // 같은 지갑으로 보내면 옮긴 것이 아니다. 카운터에 그대로 남는다.
        return Err(
            "이 지갑의 주소입니다. 옮기는 의미가 없습니다 — 다른 컴퓨터의 지갑 주소를 넣으세요."
                .into(),
        );
    }
    if above <= keep {
        return Err("보내는 기준이 남길 금액보다 커야 합니다.".into());
    }
    if keep < 1.0 {
        return Err("최소 1 RVN은 남겨야 합니다. 수수료도 못 내면 환불도 못 합니다.".into());
    }

    let v = json!({
        "to": to_address,
        "above": above,
        "keep": keep,
        "enabled": enabled,
    });
    save(&v)?;
    Ok(v)
}

#[tauri::command]
pub fn sweep_read() -> Value {
    load()
}

/// Moves takings above the threshold, if configured and if there is enough.
///
/// Runs on the same loop as automatic fulfilment. Reports why it did nothing
/// rather than staying silent — a sweep that quietly never fires looks
/// identical to one that is working.

/// Until when the sweep must leave the balance alone.
///
/// Issuing an asset burns RVN — 500 for a root name — so the owner tops the
/// wallet up and then walks through a wizard. Meanwhile a sweep running every
/// five minutes sees a balance over the threshold and moves it out, and the
/// issue fails with "insufficient funds" for reasons nothing on screen explains.
static HOLD_UNTIL: Mutex<i64> = Mutex::new(0);

/// Tells the sweep to stand down while something expensive is being prepared.
#[tauri::command]
pub fn sweep_hold(until_unix: i64) {
    if let Ok(mut g) = HOLD_UNTIL.lock() {
        *g = until_unix;
    }
}

#[tauri::command]
pub async fn sweep_run(passphrase: Option<String>) -> Result<Value, String> {
    // 자동 발송이 켜져 있으면 그 암호를 같이 쓴다. 스윕만 따로 또 물으면
    // 사람은 안 넣고, 안 넣으면 스윕은 영영 안 돈다 — 실제로 그랬다.
    let passphrase = passphrase.or_else(crate::auto::armed_pass);
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    if HOLD_UNTIL.lock().map(|g| *g > now).unwrap_or(false) {
        return Ok(json!({ "swept": false, "why": "발행 준비 중이라 잠시 멈춰 있습니다" }));
    }

    let cfg = load();
    if !cfg["enabled"].as_bool().unwrap_or(false) {
        return Ok(json!({ "swept": false, "why": "꺼져 있습니다" }));
    }
    let to = cfg["to"].as_str().unwrap_or("").to_string();
    let above = cfg["above"].as_f64().unwrap_or(0.0);
    let keep = cfg["keep"].as_f64().unwrap_or(0.0);
    if to.is_empty() || above <= 0.0 {
        return Ok(json!({ "swept": false, "why": "설정이 비어 있습니다" }));
    }

    let balance = call_rpc("getbalance", json!([]))
        .await
        .ok()
        .and_then(|v| v.as_f64())
        .unwrap_or(0.0);

    if balance < above {
        return Ok(json!({
            "swept": false,
            "why": "아직 기준에 못 미칩니다",
            "balance": balance,
            "above": above,
        }));
    }

    // 수수료 여유를 남긴다. 잔액 전부를 보내려 하면 수수료 때문에 거부된다.
    let amount = ((balance - keep) * 1e8).floor() / 1e8;
    if amount <= 0.0 {
        return Ok(json!({ "swept": false, "why": "남길 금액을 빼면 보낼 것이 없습니다" }));
    }

    let locked = matches!(
        call_rpc("getwalletinfo", json!([]))
            .await
            .ok()
            .and_then(|i| i.get("unlocked_until").and_then(Value::as_i64)),
        Some(0)
    );
    if locked {
        // 🔴 여기서 그냥 오류를 냈고, 5분마다 도는 배경 호출이 그 오류를
        // **조용히 삼켰다.** 사장은 번 돈이 금고로 가는 줄 알고 계산대를
        // 두고 나가는데, 실제로는 **한 푼도 안 옮겨진 채** 그 컴퓨터에 쌓인다.
        //
        // 잠긴 지갑에서 자동으로 보낼 방법은 없다 — 그건 잠금의 뜻이다.
        // 그러니 못 하는 것을 **말한다.** 화면이 이 이유를 그대로 띄운다.
        let Some(pass) = passphrase else {
            return Ok(json!({
                "swept": false,
                "why": "locked",
                "say": "지갑이 잠겨 있어 옮기지 못하고 있습니다.                         「이 컴퓨터」에서 자동 발송을 켜면 그때 넣은 암호로 같이 옮깁니다.",
                "would_move": amount,
            }));
        };
        call_rpc("walletpassphrase", json!([pass, 30])).await?;
    }

    let result = call_rpc(
        "sendtoaddress",
        json!([to, amount, "매출 이동", "", false]),
    )
    .await;

    if locked {
        let _ = call_rpc("walletlock", json!([])).await;
    }

    let txid = result?
        .as_str()
        .map(str::to_string)
        .unwrap_or_default();
    crate::refund::remember_ours(&txid);

    Ok(json!({ "swept": true, "amount": amount, "to": to, "txid": txid, "kept": keep }))
}

// ── 영업시간 ───────────────────────────────────────────────────────────────

/// Opening hours, per weekday, plus a manual override.
///
/// The override exists because reality wins: a shop closes early for a funeral,
/// opens late after a delivery. A schedule with no way to say "not today" is a
/// schedule people stop trusting.
#[tauri::command]
pub fn hours_save(hours: Value, closed_note: String) -> Result<(), String> {
    let mut v = load();
    if let Some(o) = v.as_object_mut() {
        o.insert("hours".into(), hours);
        o.insert("closed_note".into(), json!(closed_note));
    }
    save(&v)
}

/// Is the shop open right now?
///
/// `now_minutes` is minutes since local midnight and `weekday` is 0=Sunday,
/// both passed in from the frontend — the browser already knows the local time
/// and timezone, and deriving it again here is one more thing to get wrong.
#[tauri::command]
pub fn is_open(now_minutes: i64, weekday: usize) -> Value {
    let v = load();
    let manual = v["manual"].as_str().unwrap_or("");
    if manual == "closed" {
        return json!({
            "open": false,
            "why": v["closed_note"].as_str().unwrap_or("지금은 주문을 받지 않습니다"),
            "manual": true,
        });
    }
    if manual == "open" {
        return json!({ "open": true, "manual": true });
    }

    let hours = &v["hours"];
    let today = hours.get(weekday.to_string());
    let Some(d) = today else {
        // 설정이 없으면 열려 있는 것으로 본다. 설정을 안 한 가게가 하루아침에
        // 닫힌 것으로 보이면, 그건 우리가 만든 고장이다.
        return json!({ "open": true, "why": "" });
    };
    if !d["open"].as_bool().unwrap_or(true) {
        return json!({ "open": false, "why": "오늘은 쉽니다" });
    }

    let from = d["from"].as_i64().unwrap_or(0);
    let to = d["to"].as_i64().unwrap_or(1440);
    // 새벽 영업(22:00~02:00)은 to < from 으로 표현된다.
    let open = if to >= from {
        now_minutes >= from && now_minutes < to
    } else {
        now_minutes >= from || now_minutes < to
    };

    json!({
        "open": open,
        "why": if open { "" } else { "지금은 영업 시간이 아닙니다" },
        "from": from,
        "to": to,
    })
}

/// Force open or closed, or go back to the schedule.
#[tauri::command]
pub fn set_manual(state: String) -> Result<(), String> {
    if !["open", "closed", "auto"].contains(&state.as_str()) {
        return Err("알 수 없는 상태입니다.".into());
    }
    let mut v = load();
    if let Some(o) = v.as_object_mut() {
        o.insert("manual".into(), json!(if state == "auto" { "" } else { &state }));
    }
    save(&v)
}

#[cfg(test)]
mod tests {
    /// 저장 키와 화면이 읽는 키가 어긋나면, 켜 두고도 **꺼진 것처럼 보인다.**
    /// 사장님은 금고 설정을 다시 하고, 그동안 돈은 계속 카운터에 쌓인다.
    /// 실제로 그렇게 나 있었다(`to` 로 저장하고 `to_address` 로 읽음). 언어가
    /// 둘이라 컴파일러가 못 잡으므로 화면 소스를 읽어 대조한다.
    #[test]
    fn the_screen_reads_the_key_we_save() {
        let ts = include_str!("../../src/main.ts");
        let here = &ts[ts.find("async function loadSweep").expect("loadSweep 이 없다")..];
        let body: String = here.chars().take(700).collect();
        assert!(
            body.contains("s?.to;") || body.contains("s.to "),
            "화면이 sweep 설정에서 `to` 를 읽지 않는다"
        );
        assert!(
            !body.contains("to_address"),
            "저장 키는 `to` 인데 화면이 `to_address` 를 읽는다 — 켜 둬도 꺼져 보인다"
        );
    }

    /// 끄기가 주소 검사를 통과해야만 된다면, 주소를 잘못 저장한 사장님은
    /// 기능을 **끌 수 없다**. 가둬 놓는 스위치는 스위치가 아니다.
    #[test]
    fn turning_it_off_never_needs_a_valid_address() {
        let src = include_str!("sweep.rs");
        let f = &src[src.find("pub async fn sweep_configure").expect("함수가 없다")..];
        let head: String = f.chars().take(500).collect();
        let off = head.find("if !enabled").expect("끄기 지름길이 없다");
        let check = head.find("check_address").expect("주소 검사가 없다");
        assert!(off < check, "주소 검사가 끄기보다 먼저다 — 잘못된 주소면 못 끈다");
    }
}
