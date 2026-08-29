//! 매출장부 — what was sold, for how much, and what the coin was worth then.
//!
//! ## Why a decentralised till still needs this
//!
//! Nothing about running your own node exempts a shop from filing taxes. The
//! chain proves *a transfer happened*: these coins moved, in this block, at
//! this minute, and anyone can check it. What the chain cannot say is **what
//! that was worth in money** — and that is the one number a tax office asks
//! for. A shop that took 1,368 RVN for a coffee has to be able to say it was
//! 4,500원, and be able to show why.
//!
//! We already compute that number. `price::quote_price` prices the order off
//! live exchanges — several of them, dead markets discarded — and hands the
//! customer a rate. Until now we showed it and threw it away. This module keeps
//! it, together with **which exchanges it came from and whether the currency
//! had a direct RVN market or was converted through the dollar**. A rate with
//! no provenance is a number somebody typed.
//!
//! ## Shape of the evidence
//!
//! Each sale keeps, in one row: the items, the price in the shop's own
//! currency, the coin amount that actually moved, the rate used, **which
//! exchanges that rate came from**, when it was quoted, when the payment was
//! seen, and the txid. The first six make the amount defensible; the txid makes
//! it checkable by someone who does not trust us — including the shop's own
//! accountant, who can look the transaction up without asking us for anything.
//!
//! ## Why append-only, one JSON per line
//!
//! A ledger that can be edited in place is not evidence, it is a note. Rows are
//! appended and never rewritten; a refund is its own row with a negative
//! amount, exactly as it would be on paper. A crash halfway through a write
//! costs the last line, not the file — which is why this is not one big JSON
//! document that must be rewritten whole on every sale.
//!
//! ## What this deliberately does not do
//!
//! It does not compute anyone's tax. It does not decide 과세 or 면세, it does
//! not know whether the shop is 간이 or 일반, and it does not file anything.
//! It records what happened, in a form a human accountant can use. Guessing at
//! the rest would produce confident numbers that are wrong in a place where
//! being wrong is expensive.

use serde_json::{json, Value};
use std::io::Write;
use std::path::PathBuf;

fn base() -> PathBuf {
    // 시험이 진짜 장부에 쓰지 않게 하는 출구는 `paths` 에 하나로 있다.
    // 규칙이 두 벌이면 언젠가 갈라지고, 갈라진 쪽이 진짜 장부를 건드린다.
    crate::paths::app_dir()
}

fn ledger_dir() -> PathBuf {
    base().join("ledger")
}

// ─── 날짜 ────────────────────────────────────────────────────────────────
//
// 표준 라이브러리에는 달력이 없고, 이것 하나 때문에 시간대 데이터베이스를
// 통째로 들여올 이유는 없다. 대신 화면이 자기 시간대(분 단위)를 넘겨준다 —
// 이 프로그램은 한국에서만 쓰이지 않는다.

/// Days since 1970-01-01 for a civil date. Hinnant's algorithm.
fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// The inverse.
fn civil_from_days(z: i64) -> (i64, i64, i64) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (if m <= 2 { y + 1 } else { y }, m, d)
}

/// YYYYMMDD as the shop's own clock saw it.
pub fn local_ymd(unix: i64, tz_offset_min: i64) -> i64 {
    let local = unix + tz_offset_min * 60;
    // 1970 이전으로 내려가도 나눗셈이 0 쪽으로 잘리지 않게.
    let days = local.div_euclid(86_400);
    let (y, m, d) = civil_from_days(days);
    y * 10_000 + m * 100 + d
}

/// Which file a row lives in. Bucketed by UTC month — an implementation
/// detail, never shown to anyone. Queries read the neighbouring months too, so
/// a shop's local month boundary never falls in a gap.
fn month_key(unix: i64) -> String {
    let (y, m, _) = civil_from_days(unix.div_euclid(86_400));
    format!("{y:04}-{m:02}")
}

/// Every month file a local date range could possibly touch.
fn months_for(from_ymd: i64, to_ymd: i64) -> Vec<String> {
    let unix_of = |ymd: i64| {
        days_from_civil(ymd / 10_000, (ymd / 100) % 100, ymd % 100) * 86_400
    };
    // 어느 시간대든 하루 이상 밀리지 않는다. 양쪽으로 이틀씩 넉넉히 잡는다.
    let start = unix_of(from_ymd) - 2 * 86_400;
    let end = unix_of(to_ymd) + 2 * 86_400;

    let mut out = Vec::new();
    let mut t = start;
    while t <= end {
        let k = month_key(t);
        if !out.contains(&k) {
            out.push(k);
        }
        t += 15 * 86_400; // 한 달을 건너뛸 수 없는 보폭
    }
    let last = month_key(end);
    if !out.contains(&last) {
        out.push(last);
    }
    out
}

// ─── 쓰기 ────────────────────────────────────────────────────────────────

fn append(row: &Value) -> Result<(), String> {
    let at = row["at"].as_i64().unwrap_or(0);
    let dir = ledger_dir();
    std::fs::create_dir_all(&dir).map_err(|e| format!("장부 폴더를 만들지 못했습니다: {e}"))?;
    let path = dir.join(format!("{}.jsonl", month_key(at)));

    let mut line = serde_json::to_string(row).map_err(|e| e.to_string())?;
    line.push('\n');

    let mut f = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|e| format!("장부를 열지 못했습니다: {e}"))?;
    f.write_all(line.as_bytes())
        .map_err(|e| format!("장부에 쓰지 못했습니다: {e}"))?;
    // 장사 중에 전원이 나가도 방금 판 것은 남아 있어야 한다.
    let _ = f.sync_all();
    Ok(())
}

// ─── 아직 결제되지 않은 주문 ─────────────────────────────────────────────
//
// 장부에는 실제로 팔린 것만 들어간다. 그래서 주문과 결제 사이에는 따로 둘
// 곳이 필요하다 — 결제되지 않고 떠난 주문까지 매출로 적으면 그건 장부가
// 아니라 희망사항이다.

fn pending_path() -> PathBuf {
    base().join("pending.json")
}

fn pending_load() -> Value {
    std::fs::read_to_string(pending_path())
        .ok()
        .and_then(|t| serde_json::from_str::<Value>(&t).ok())
        .unwrap_or_else(|| json!({}))
}

fn pending_save(v: &Value) -> Result<(), String> {
    let _ = std::fs::create_dir_all(base());
    let tmp = pending_path().with_extension("json.tmp");
    std::fs::write(&tmp, serde_json::to_vec_pretty(v).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, pending_path()).map_err(|e| e.to_string())
}

/// An order was placed. Nothing has been paid yet.
///
/// `quote` is what `price::quote_price` returned — the rate, the exchanges it
/// came from, and when it was taken. Keeping the whole thing is deliberate: a
/// rate without its sources and its timestamp is a number somebody typed.
pub fn open_order(
    address: &str,
    items: &Value,
    quote: &Value,
    at: i64,
    table: Option<&str>,
) -> Result<(), String> {
    let mut p = pending_load();
    let map = p.as_object_mut().ok_or("pending.json 이 손상되었습니다")?;

    map.insert(
        address.to_string(),
        json!({
            "address": address,
            "items": items,
            "krw": quote["amount"],
            "currency": quote["currency"],
            "rvn": quote["rvn"],
            "rate": quote["rate"],
            "sources": quote["sources"],
            "unstable": quote["unstable"],
            // 엔·유로처럼 RVN 직접 시장이 없는 통화는 달러를 거쳐 환산된다.
            // 그 사실이 증빙에 남아야 나중에 숫자를 다시 세울 수 있다.
            "direct": quote["direct"],
            "table": table,
            "quoted_at": at,
        }),
    );

    // 결제하지 않고 떠난 주문이 계속 쌓인다. 하루 지난 것은 버린다 — 그날
    // 결제되지 않은 주문은 다음 날 결제되지 않는다.
    let cutoff = at - 86_400;
    map.retain(|_, v| v["quoted_at"].as_i64().unwrap_or(0) >= cutoff);

    pending_save(&p)
}

/// Payment for this order has been seen on chain. Writes the sale.
///
/// Returns the row it wrote, or `None` if this address was not an open order —
/// which is also what makes it safe to call repeatedly. The order is removed
/// from the pending file before the row is written, so a second call for the
/// same payment finds nothing to settle and writes nothing. Double-counting
/// revenue is a worse failure here than missing a row, because a missing row
/// can be noticed and a duplicated one usually is not.
pub fn settle(address: &str, txid: &str, paid_at: i64, confirmations: i64) -> Option<Value> {
    let mut p = pending_load();
    let doc = p.as_object_mut()?.remove(address)?;
    // 먼저 지운다. 여기서 실패하면 장부에 안 쓰는 쪽을 택한다.
    pending_save(&p).ok()?;

    let row = json!({
        "kind": "sale",
        "at": paid_at,
        "address": address,
        "txid": txid,
        "items": doc["items"],
        // 가게가 매긴 값. 세무서가 묻는 숫자다.
        "amount": doc["krw"],
        "currency": doc["currency"],
        // 실제로 움직인 코인.
        "rvn": doc["rvn"],
        // 그 둘을 잇는 근거 — 시세, 어느 거래소에서 왔는지, 언제 잰 것인지.
        "rate": doc["rate"],
        "sources": doc["sources"],
        "rate_unstable": doc["unstable"],
        // false 면 달러를 거쳐 환산한 값이다. 세무 담당자가 이 열을 보고
        // 어느 환율표를 같이 확인해야 하는지 판단한다.
        "rate_direct": doc["direct"],
        // 몇 번 테이블이 얼마 썼는지. 가게가 실제로 묻는 질문이다.
        "table": doc["table"],
        "quoted_at": doc["quoted_at"],
        "confirmations": confirmations,
    });

    match append(&row) {
        Ok(()) => Some(row),
        Err(_) => None,
    }
}

/// Money went back out. Its own row, negative, exactly as on paper.
pub fn record_refund(
    to: &str,
    amount: f64,
    currency: &str,
    rvn: f64,
    rate: f64,
    reason: &str,
    txid: &str,
    at: i64,
) -> Result<(), String> {
    append(&json!({
        "kind": "refund",
        "at": at,
        "address": to,
        "txid": txid,
        // 환불은 매출을 줄인다. 부호로 남겨야 합계가 저절로 맞는다.
        "amount": -amount,
        "currency": currency,
        "rvn": -rvn,
        "rate": rate,
        "reason": reason,
    }))
}

// ─── 읽기 ────────────────────────────────────────────────────────────────

fn read_rows(from_ymd: i64, to_ymd: i64, tz: i64) -> Vec<Value> {
    let mut rows = Vec::new();
    for m in months_for(from_ymd, to_ymd) {
        let Ok(text) = std::fs::read_to_string(ledger_dir().join(format!("{m}.jsonl"))) else {
            continue;
        };
        for line in text.lines() {
            if line.trim().is_empty() {
                continue;
            }
            // 한 줄이 깨져도 나머지는 읽는다. 장부 전체가 안 열리는 것보다
            // 한 줄이 빠지는 편이 낫고, 빠졌다는 사실은 아래에서 센다.
            let Ok(v) = serde_json::from_str::<Value>(line) else {
                rows.push(json!({ "kind": "unreadable" }));
                continue;
            };
            let at = v["at"].as_i64().unwrap_or(0);
            let ymd = local_ymd(at, tz);
            if ymd >= from_ymd && ymd <= to_ymd {
                rows.push(v);
            }
        }
    }
    rows.sort_by_key(|r| r["at"].as_i64().unwrap_or(0));
    rows
}

/// What sold between two dates, and what it came to.
///
/// Dates are YYYYMMDD **in the shop's own timezone**, which the screen passes
/// in as an offset. A shop closing at 1am must see that sale on the day it
/// happened, not the next one.
#[tauri::command]
pub fn ledger_range(from_ymd: i64, to_ymd: i64, tz_offset_min: i64) -> Value {
    let rows = read_rows(from_ymd, to_ymd, tz_offset_min);

    let mut sales = 0i64;
    let mut refunds = 0i64;
    let mut unreadable = 0i64;
    let mut total = 0.0;
    let mut total_rvn = 0.0;
    let mut currency = String::new();
    let mut mixed_currency = false;
    let mut unstable_rows = 0i64;

    // 품목별 — "기간을 넣으면 뭐가 팔렸는지" 가 이 표다.
    let mut by_item: std::collections::HashMap<String, (f64, f64)> = Default::default();
    // 날짜별 — 신고서는 보통 기간 합계지만, 맞는지 보려면 하루씩 봐야 한다.
    let mut by_day: std::collections::HashMap<i64, (f64, f64)> = Default::default();

    for r in &rows {
        match r["kind"].as_str().unwrap_or("") {
            "unreadable" => {
                unreadable += 1;
                continue;
            }
            "sale" => sales += 1,
            "refund" => refunds += 1,
            _ => {}
        }

        let amount = r["amount"].as_f64().unwrap_or(0.0);
        let rvn = r["rvn"].as_f64().unwrap_or(0.0);
        total += amount;
        total_rvn += rvn;

        if let Some(c) = r["currency"].as_str() {
            if currency.is_empty() {
                currency = c.to_string();
            } else if currency != c {
                mixed_currency = true;
            }
        }
        if r["rate_unstable"].as_bool().unwrap_or(false) {
            unstable_rows += 1;
        }

        let day = local_ymd(r["at"].as_i64().unwrap_or(0), tz_offset_min);
        let e = by_day.entry(day).or_insert((0.0, 0.0));
        e.0 += amount;
        e.1 += rvn;

        if let Some(items) = r["items"].as_array() {
            for it in items {
                let name = it["name"].as_str().unwrap_or("(이름 없음)").to_string();
                let qty = it["qty"].as_f64().unwrap_or(1.0);
                let price = it["price"].as_f64().unwrap_or(0.0);
                let e = by_item.entry(name).or_insert((0.0, 0.0));
                e.0 += qty;
                e.1 += qty * price;
            }
        }
    }

    let mut items: Vec<Value> = by_item
        .into_iter()
        .map(|(name, (qty, amount))| json!({ "name": name, "qty": qty, "amount": amount }))
        .collect();
    items.sort_by(|a, b| {
        b["amount"]
            .as_f64()
            .unwrap_or(0.0)
            .partial_cmp(&a["amount"].as_f64().unwrap_or(0.0))
            .unwrap_or(std::cmp::Ordering::Equal)
    });

    let mut days: Vec<Value> = by_day
        .into_iter()
        .map(|(d, (amount, rvn))| json!({ "date": d, "amount": amount, "rvn": rvn }))
        .collect();
    days.sort_by_key(|d| d["date"].as_i64().unwrap_or(0));

    json!({
        "from": from_ymd,
        "to": to_ymd,
        "rows": rows,
        "sales": sales,
        "refunds": refunds,
        "total": total,
        "total_rvn": total_rvn,
        "currency": currency,
        "by_item": items,
        "by_day": days,
        // 아래 셋은 화면이 그대로 문장으로 보여 줘야 하는 단서다. 조용히
        // 넘어가면 합계가 왜 이상한지 아무도 모른다.
        "mixed_currency": mixed_currency,
        "unstable_rows": unstable_rows,
        "unreadable_rows": unreadable,
        "note": "가게가 받은 총액입니다. 부가세 구분·과세 여부는 가게 사업자 유형에 따라 다르므로 세무 담당자와 확인하세요.",
    })
}

/// The same thing as a spreadsheet, because that is what an accountant wants.
#[tauri::command]
pub fn ledger_csv(from_ymd: i64, to_ymd: i64, tz_offset_min: i64) -> String {
    let rows = read_rows(from_ymd, to_ymd, tz_offset_min);

    // 엑셀이 UTF-8 을 알아보게 하는 표식. 없으면 한글이 깨져 나오고, 그러면
    // 세무 담당자는 이 파일을 안 쓴다.
    let mut out = String::from("\u{feff}");
    out.push_str(
        "날짜,시각,구분,품목,금액,통화,RVN,1RVN당가격,시세산출,시세출처,시세시각,확인수,거래ID,비고\n",
    );

    for r in rows {
        if r["kind"].as_str() == Some("unreadable") {
            continue;
        }
        let at = r["at"].as_i64().unwrap_or(0);
        let ymd = local_ymd(at, tz_offset_min);
        let local = at + tz_offset_min * 60;
        let secs = local.rem_euclid(86_400);
        let kind = if r["kind"].as_str() == Some("refund") {
            "환불"
        } else {
            "판매"
        };

        let names: Vec<String> = r["items"]
            .as_array()
            .map(|a| {
                a.iter()
                    .map(|i| {
                        let n = i["name"].as_str().unwrap_or("");
                        match i["qty"].as_f64() {
                            Some(q) if q != 1.0 => format!("{n}×{q}"),
                            _ => n.to_string(),
                        }
                    })
                    .collect()
            })
            .unwrap_or_default();
        // 환불은 사유가 비고 칸에 이미 들어간다. 품목 칸에 같은 문장을 또
        // 넣으면 표가 두 번 말하는 것처럼 보인다.
        let item = names.join(" / ");

        let sources = r["sources"]
            .as_array()
            .map(|a| {
                a.iter()
                    .filter_map(|s| s.as_str())
                    .collect::<Vec<_>>()
                    .join(" ")
            })
            .unwrap_or_default();

        let quoted = r["quoted_at"].as_i64().unwrap_or(0);
        let q_local = quoted + tz_offset_min * 60;
        let q_secs = q_local.rem_euclid(86_400);

        // 쉼표와 따옴표가 들어간 품목명이 표를 망가뜨리지 않게.
        let esc = |s: &str| format!("\"{}\"", s.replace('"', "\"\""));

        out.push_str(&format!(
            "{}-{:02}-{:02},{:02}:{:02}:{:02},{},{},{},{},{},{},{},{},{},{},{},{}\n",
            ymd / 10_000,
            (ymd / 100) % 100,
            ymd % 100,
            secs / 3600,
            (secs % 3600) / 60,
            secs % 60,
            kind,
            esc(&item),
            r["amount"].as_f64().unwrap_or(0.0),
            r["currency"].as_str().unwrap_or(""),
            r["rvn"].as_f64().unwrap_or(0.0),
            r["rate"].as_f64().unwrap_or(0.0),
            // 세무 담당자가 어느 환율표를 같이 봐야 하는지 판단하는 칸이다.
            match r["rate_direct"].as_bool() {
                Some(false) => "달러경유",
                Some(true) => "직접",
                None => "",
            },
            esc(&sources),
            if quoted > 0 {
                format!("{:02}:{:02}", q_secs / 3600, (q_secs % 3600) / 60)
            } else {
                String::new()
            },
            r["confirmations"].as_i64().unwrap_or(0),
            r["txid"].as_str().unwrap_or(""),
            esc(r["reason"].as_str().unwrap_or("")),
        ));
    }
    out
}

/// Writes the CSV next to the other exports and says where it went.
#[tauri::command]
pub fn ledger_export(from_ymd: i64, to_ymd: i64, tz_offset_min: i64) -> Result<Value, String> {
    let csv = ledger_csv(from_ymd, to_ymd, tz_offset_min);
    let home = crate::paths::home().to_string_lossy().to_string();
    let dir = PathBuf::from(&home).join("Downloads");
    let dir = if dir.is_dir() { dir } else { base() };
    let path = dir.join(format!("매출장부_{from_ymd}_{to_ymd}.csv"));
    std::fs::write(&path, csv.as_bytes()).map_err(|e| format!("파일을 쓰지 못했습니다: {e}"))?;
    Ok(json!({
        "path": path.to_string_lossy(),
        "where": path.parent().map(|p| p.to_string_lossy().to_string()),
    }))
}


/// 🔴 **받은 돈이 장부에 안 써지고 있었다.**
///
/// 대표님 화면(2026-08-29): 「들어온 주문」에는 5일 전 0.01 RVN 이 **결제됨**인데
/// 「매출·장부」는 전부 0 이고 「아직 입금되지 않은 주문 1건」이라고 적혀 있었다.
/// 같은 앱이 같은 주문을 놓고 **두 가지로 말하고 있었다.**
///
/// ## 왜 그랬나
///
/// 장부에 줄을 쓰는 `settle()` 에 닿는 길이 **하나뿐**이었다:
///
/// ```text
/// 손님 폰이 /api/order-state 를 물어봄
///   → sweep_payments()
///     → 메모리 맵에 그 주소가 WAITING 일 때만
///       → settle()
/// ```
///
/// 그 메모리 맵은 **디스크에 없다.** 앱을 껐다 켜면 비고, 그러면 체인에
/// 돈이 들어와 있어도 장부에 닿는 길이 **끊긴다.** 손님은 이미 가서 폰으로
/// 다시 물어보지도 않는다.
///
/// ## 그래서 사장 쪽에서도 정산한다
///
/// 「들어온 주문」을 볼 때마다 **아직 안 적힌 주문을 체인에 직접 물어보고**,
/// 확인수가 찼으면 장부에 적는다. 손님 폰이 켜져 있든 말든 상관없다.
///
/// ⚠️ 두 번 적히면 매출이 부풀고 **그건 아무도 못 알아챈다.** `settle()` 은
///    적기 전에 pending 에서 먼저 지우므로 두 번째 호출은 쓸 것을 못 찾는다.
///    그 성질에 기댄다 — 여기서 따로 중복 검사를 하지 않는다.
#[tauri::command]
pub async fn ledger_sweep(min_conf: u32) -> Result<Value, String> {
    let p = pending_load();
    let addrs: Vec<String> = p
        .as_object()
        .map(|m| m.keys().cloned().collect())
        .unwrap_or_default();

    let mut 적음 = 0usize;
    let mut 기다림 = 0usize;
    for addr in addrs {
        // 체인에 물어본다. 못 물어보면 **넘어간다** — 모르는 것을 결제로
        // 치면 안 된다.
        let Ok(v) = crate::shop::incoming_payments(addr.clone(), min_conf).await else {
            기다림 += 1;
            continue;
        };
        let rows = v.get("payments").and_then(Value::as_array).cloned().unwrap_or_default();
        let done = rows.iter().find(|r| {
            r.get("settled").and_then(Value::as_bool).unwrap_or(false)
        });
        match done {
            Some(r) => {
                let txid = r.get("txid").and_then(Value::as_str).unwrap_or("");
                let at = r.get("at").and_then(Value::as_i64).unwrap_or_else(|| std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0));
                let conf = r.get("confirmations").and_then(Value::as_i64).unwrap_or(0);
                if settle(&addr, txid, at, conf).is_some() {
                    적음 += 1;
                }
            }
            None => 기다림 += 1,
        }
    }
    Ok(json!({ "settled": 적음, "waiting": 기다림 }))
}

/// Orders taken but not paid. Shown so nobody wonders where an order went.
#[tauri::command]
pub fn ledger_pending() -> Value {
    let p = pending_load();
    let rows: Vec<Value> = p
        .as_object()
        .map(|m| m.values().cloned().collect())
        .unwrap_or_default();
    json!({ "count": rows.len(), "orders": rows })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn civil_dates_round_trip() {
        for (y, m, d) in [
            (1970, 1, 1),
            (2000, 2, 29), // 400 으로 나눠지는 윤년
            (1900, 3, 1),  // 100 으로 나눠지지만 윤년이 아닌 해의 다음 날
            (2026, 8, 20),
            (2038, 1, 19), // 32비트가 끝나는 날
        ] {
            let z = days_from_civil(y, m, d);
            assert_eq!(civil_from_days(z), (y, m, d), "{y}-{m}-{d}");
        }
    }

    #[test]
    fn local_date_uses_the_shops_own_clock() {
        // 2026-08-20 15:00 UTC = 한국 21일 0시. 마감 매출이 다음 날로 밀리면
        // 일별 합계가 통째로 어긋난다.
        let utc = days_from_civil(2026, 8, 20) * 86_400 + 15 * 3600;
        assert_eq!(local_ymd(utc, 0), 20_260_820);
        assert_eq!(local_ymd(utc, 9 * 60), 20_260_821);
        // 서쪽으로도 같은 방식으로 밀린다.
        assert_eq!(local_ymd(utc, -8 * 60), 20_260_820);
        let early = days_from_civil(2026, 8, 20) * 86_400 + 3 * 3600;
        assert_eq!(local_ymd(early, -8 * 60), 20_260_819);
    }

    #[test]
    fn month_window_covers_the_edges() {
        // 월초 하루만 물어봐도 앞 달 파일을 읽어야 한다. 시간대 때문에 그
        // 매출이 앞 달 파일에 들어가 있을 수 있다.
        let ms = months_for(20_260_801, 20_260_801);
        assert!(ms.contains(&"2026-07".to_string()), "{ms:?}");
        assert!(ms.contains(&"2026-08".to_string()), "{ms:?}");

        // 긴 기간도 사이의 달이 하나도 안 빠져야 한다.
        let ms = months_for(20_260_101, 20_261_231);
        for m in 1..=12 {
            assert!(ms.contains(&format!("2026-{m:02}")), "{m}월이 빠졌습니다");
        }
    }

    #[test]
    fn csv_survives_a_comma_in_an_item_name() {
        // 품목명에 쉼표가 있으면 열이 밀린다. 밀린 표는 금액이 품목 칸에
        // 들어가고, 그걸 그대로 신고하면 숫자가 틀린다.
        let esc = |s: &str| format!("\"{}\"", s.replace('"', "\"\""));
        assert_eq!(esc("아메리카노, 아이스"), "\"아메리카노, 아이스\"");
        assert_eq!(esc("12\"케이크"), "\"12\"\"케이크\"");
    }
}

/// 파일까지 실제로 쓰고 다시 읽는 확인. 진짜 장부를 건드리지 않게 따로 둔다.
/// `PLAYX_RAVEN_HOME=/tmp/... cargo test --lib -- --ignored --nocapture ledger_roundtrip`
#[cfg(test)]
mod roundtrip {
    use super::*;

    #[test]
    #[ignore]
    fn ledger_roundtrip() {
        assert!(
            std::env::var("PLAYX_RAVEN_HOME").is_ok(),
            "PLAYX_RAVEN_HOME 없이 돌리면 진짜 장부에 씁니다"
        );
        let at = days_from_civil(2026, 8, 20) * 86_400 + 5 * 3600; // 한국 14시

        let quote = json!({
            "amount": 4500.0, "currency": "KRW", "rvn": 1335.31157270,
            "rate": 3.3699, "sources": ["업비트", "빗썸"], "unstable": false, "direct": true,
        });
        let items = json!([{ "name": "아메리카노, 아이스", "price": 4500, "qty": 1 }]);

        open_order("Rtest111111111111111111111111111", &items, &quote, at, Some("3")).unwrap();
        assert_eq!(ledger_pending()["count"], 1, "주문이 대기에 안 들어갔습니다");

        let row = settle("Rtest111111111111111111111111111", "abc123", at + 40, 1)
            .expect("결제가 장부에 안 적혔습니다");
        assert_eq!(row["amount"], 4500.0);
        assert_eq!(ledger_pending()["count"], 0, "결제된 주문이 대기에 남았습니다");

        // 같은 결제를 두 번 봐도 매출이 두 배가 되면 안 된다.
        assert!(
            settle("Rtest111111111111111111111111111", "abc123", at + 41, 2).is_none(),
            "같은 결제가 두 번 적혔습니다"
        );

        record_refund("Rtest2222222222222222222222222222", 1500.0, "KRW",
                      445.0, 3.3699, "우유 빠짐", "def456", at + 600).unwrap();

        let r = ledger_range(20_260_820, 20_260_820, 9 * 60);
        println!("{}", serde_json::to_string_pretty(&r["by_item"]).unwrap());
        assert_eq!(r["sales"], 1);
        assert_eq!(r["refunds"], 1);
        // 4,500 판매 - 1,500 환불 = 3,000
        assert_eq!(r["total"], 3000.0, "환불이 합계에서 안 빠졌습니다");
        assert_eq!(r["by_item"][0]["name"], "아메리카노, 아이스");

        // 하루 어긋나면 안 보여야 한다 — 날짜 필터가 실제로 도는지.
        assert_eq!(ledger_range(20_260_819, 20_260_819, 9 * 60)["sales"], 0);

        let csv = ledger_csv(20_260_820, 20_260_820, 9 * 60);
        println!("{csv}");
        let line = csv.lines().nth(1).unwrap();
        assert!(line.starts_with("2026-08-20,14:00:"), "현지 시각이 틀립니다: {line}");
        assert!(line.contains("\"아메리카노, 아이스\""), "쉼표 있는 품목이 안 감싸졌습니다");
        assert!(line.contains("abc123"));
        assert!(line.contains("직접"));
    }
}
