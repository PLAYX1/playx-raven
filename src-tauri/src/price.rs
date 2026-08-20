//! Money ↔ RVN.
//!
//! A shop prices in won or dollars. A customer pays in RVN. Something has to
//! convert, and that something is a live market rate — which moves while the
//! customer is deciding.
//!
//! So a quote is *frozen* at the moment the order is made and carries its own
//! expiry. Without that, a customer who takes four minutes to pay sends an
//! amount the shop no longer considers correct, and both sides are right.
//!
//! Where a currency has a real RVN market — won and dollars — the rate comes
//! from exchanges quoting RVN against it directly, and several are compared
//! so one bad tick cannot misprice a menu — the middle value wins, not the mean.
//!
//! Nowhere else does. Nobody sells RVN for yen or euros, so a shop in Osaka can
//! only be priced through the dollar, and that is two guesses stacked. This
//! file used to refuse to do it, which was principled and meant the program
//! only worked in two countries. So it does it and **says so**: the rate
//! carries `direct: false` and both hops' sources, all the way into the ledger.
//! A hidden cross-rate is a lie; a declared one is a citation.
//!
//! One thing every ticker here shares: it reports the **last trade**, not a
//! live quote. On a market where nobody is trading that number just keeps being
//! served, looking fresh. So every source carries its 24-hour volume and the
//! dead ones are dropped rather than counted — see `blend`.
//!
//! This and the optional AI help are the only calls that leave the machine.
//! It carries nothing about the wallet: a public ticker is identical for
//! everyone who asks.

use serde_json::{json, Value};

/// How long a price is honoured. Long enough to walk to a counter and pay,
/// short enough that a moving market cannot be arbitraged against the shop.
const QUOTE_SECONDS: i64 = 300;

async fn get_json(url: &str) -> Option<Value> {
    reqwest::Client::new()
        .get(url)
        .timeout(std::time::Duration::from_secs(12))
        .send()
        .await
        .ok()?
        .json()
        .await
        .ok()
}

/// A price, and how much was actually traded to produce it.
///
/// ## Why the volume is not optional
///
/// Every one of these tickers reports a **last trade price**, not a live quote.
/// On a market where nobody is trading, that number is simply the last thing
/// that happened, however long ago — and it goes on being served, looking
/// exactly like a fresh price.
///
/// This is not hypothetical. 업비트's USDT-RVN market was measured at **zero**
/// 24-hour volume with its last trade eleven hours old, while it kept returning
/// 0.002358. Averaged against 바이낸스's live 0.00281, that produced a dollar
/// rate about 8% under the market — and every currency priced through the
/// dollar inherited the error. A shop in Osaka would have undercharged all day
/// without a single thing on screen looking wrong.
///
/// So a source carries its volume, and a source with no trading is discarded
/// rather than averaged. Two sources are better than one, but one live source
/// beats a live one blended with a dead one.
struct Tick {
    price: f64,
    /// 24h turnover, in that market's quote currency.
    volume: f64,
}

/// Below this a market is not producing a price, it is producing an echo.
/// Stated in each market's own quote currency.
const MIN_KRW_VOLUME: f64 = 1_000_000.0;
const MIN_USD_VOLUME: f64 = 1_000.0;

async fn upbit(market: &str) -> Option<Tick> {
    let v = get_json(&format!("https://api.upbit.com/v1/ticker?markets={market}")).await?;
    let t = v.as_array()?.first()?;
    Some(Tick {
        price: t.get("trade_price")?.as_f64()?,
        volume: t
            .get("acc_trade_price_24h")
            .and_then(Value::as_f64)
            .unwrap_or(0.0),
    })
}

async fn bithumb_krw() -> Option<Tick> {
    let v = get_json("https://api.bithumb.com/public/ticker/RVN_KRW").await?;
    let d = v.get("data")?;
    Some(Tick {
        price: d.get("closing_price")?.as_str()?.parse::<f64>().ok()?,
        volume: d
            .get("acc_trade_value_24H")
            .and_then(Value::as_str)
            .and_then(|s| s.parse::<f64>().ok())
            .unwrap_or(0.0),
    })
}

async fn binance_usdt() -> Option<Tick> {
    // 24hr 엔드포인트는 가격과 거래량을 한 번에 준다. 가격만 받는 쪽과 호출
    // 횟수가 같으므로 굳이 덜 아는 쪽을 쓸 이유가 없다.
    let v = get_json("https://api.binance.com/api/v3/ticker/24hr?symbol=RVNUSDT").await?;
    Some(Tick {
        price: v.get("lastPrice")?.as_str()?.parse::<f64>().ok()?,
        volume: v
            .get("quoteVolume")
            .and_then(Value::as_str)
            .and_then(|s| s.parse::<f64>().ok())
            .unwrap_or(0.0),
    })
}

/// Every dollar market we watch.
///
/// Three, not two, and deliberately. Won has two Korean exchanges quoting RVN
/// directly, but **every other country in the world** is priced through this
/// list — so if it were one exchange, one outage would take the yen, the euro
/// and everything else with it. Measured together they sat within 0.2% of each
/// other, which is what makes the middle value meaningful.
///
/// 업비트's USDT market is still asked and still usually dropped for having no
/// trading. It stays because a market can come back, and `blend` reports what
/// it discarded rather than hiding it.
async fn usd_ticks() -> Vec<(Option<Tick>, &'static str)> {
    vec![
        (binance_usdt().await, "바이낸스"),
        (okx_usdt().await, "OKX"),
        // USDT, not USD. They track closely but are not the same thing, and
        // pretending otherwise is the kind of rounding that becomes a dispute
        // at scale.
        (upbit("USDT-RVN").await, "업비트"),
    ]
}

async fn okx_usdt() -> Option<Tick> {
    let v = get_json("https://www.okx.com/api/v5/market/ticker?instId=RVN-USDT").await?;
    let d = v.get("data")?.as_array()?.first()?;
    Some(Tick {
        price: d.get("last")?.as_str()?.parse::<f64>().ok()?,
        // volCcy24h 는 USDT 로 환산한 거래대금이다. vol24h 는 RVN 개수라
        // 그걸 쓰면 문턱이 통화마다 달라진다.
        volume: d
            .get("volCcy24h")
            .and_then(Value::as_str)
            .and_then(|s| s.parse::<f64>().ok())
            .unwrap_or(0.0),
    })
}

/// Drops the markets nobody is trading in, then takes the middle of what is left.
///
/// Returns `(rate, sources, spread, dropped)`. `dropped` is named out loud so
/// the screen can say "빗썸은 거래가 없어 빼고 계산했습니다" rather than quietly
/// showing a number from one exchange as though several had agreed.
///
/// ## Middle, not average
///
/// With three sources the median ignores one bad tick entirely, while an
/// average lets it drag the price by a third of however wrong it was. With two
/// the two are identical, so nothing is lost by always using the median.
fn blend(
    sources: Vec<(Option<Tick>, &str)>,
    floor: f64,
) -> Option<(f64, Vec<String>, f64, Vec<String>)> {
    let mut live: Vec<(f64, &str)> = Vec::new();
    let mut dropped: Vec<String> = Vec::new();

    for (t, name) in sources {
        match t {
            Some(t) if t.price > 0.0 && t.volume >= floor => live.push((t.price, name)),
            // 응답은 왔는데 거래가 없는 곳. 답이 아예 없는 곳과 구별해서
            // 말해 준다 — 사장이 볼 때 "장애" 와 "거래 없음" 은 다른 일이다.
            Some(_) => dropped.push(name.to_string()),
            None => {}
        }
    }

    if live.is_empty() {
        return None;
    }

    let mut prices: Vec<f64> = live.iter().map(|(p, _)| *p).collect();
    prices.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let n = prices.len();
    let rate = if n % 2 == 1 {
        prices[n / 2]
    } else {
        (prices[n / 2 - 1] + prices[n / 2]) / 2.0
    };

    // 가장 싼 곳과 가장 비싼 곳의 거리. 하나뿐이면 0 이다 — 비교할 상대가
    // 없다는 뜻이지, 안정적이라는 뜻이 아니므로 `sources` 를 같이 봐야 한다.
    let spread = if n > 1 {
        (prices[n - 1] - prices[0]) / rate
    } else {
        0.0
    };

    Some((
        rate,
        live.iter().map(|(_, n)| n.to_string()).collect(),
        spread,
        dropped,
    ))
}

// ─── 나머지 나라들 ───────────────────────────────────────────────────────
//
// RVN 을 엔이나 위안으로 직접 사는 시장은 없다. 원화와 달러에만 실제 호가가
// 있고, 그 외 통화로 값을 매기려면 반드시 두 단계를 거쳐야 한다.
//
// 이 파일의 원칙은 교차환율 금지였다 — 추측을 두 번 쌓지 말라는 뜻이었고, 그
// 자체로는 옳다. 하지만 그 원칙을 그대로 두면 이 프로그램은 한국과 미국에서만
// 쓸 수 있다. 그래서 원칙을 바꾸는 대신 **표시를 바꾼다**: 교차환율을 쓰되,
// 두 단계였다는 사실과 각 단계의 출처를 값에 붙여 보낸다. 화면도 장부도 그걸
// 그대로 보여 준다. 숨긴 교차환율은 거짓말이지만, 밝힌 교차환율은 근거다.

/// 유럽중앙은행이 매 영업일 공시하는 기준환율.
///
/// 실시간 호가가 아니라 하루 한 번 발표되는 값인데, 여기서는 그게 **장점**이다.
/// 세무 담당자가 나중에 "그날 환율이 얼마였느냐" 를 물으면 같은 공표값을 누구나
/// 다시 찾아볼 수 있다. 초 단위로 흔들리는 사설 호가는 그게 안 된다.
async fn ecb_per_usd(cur: &str) -> Option<(f64, String)> {
    // .app 은 2026년에 .dev 로 옮겨가며 301 을 돌려준다. reqwest 가 따라가기는
    // 하지만, 리다이렉트를 타는 요청은 언젠가 조용히 끊긴다. 최종 주소를 적는다.
    let v = get_json(&format!(
        "https://api.frankfurter.dev/v1/latest?from=USD&to={cur}"
    ))
    .await?;
    let rate = v.get("rates")?.get(cur)?.as_f64()?;
    let date = v.get("date").and_then(Value::as_str).unwrap_or("");
    Some((rate, format!("ECB {date}")))
}

/// ECB 가 답하지 않을 때. 쉬는 날과 장애는 다른 문제이므로 대비가 필요하다.
async fn erapi_per_usd(cur: &str) -> Option<(f64, String)> {
    let v = get_json("https://open.er-api.com/v6/latest/USD").await?;
    let rate = v.get("rates")?.get(cur)?.as_f64()?;
    Some((rate, "exchangerate-api".to_string()))
}

/// 환율은 하루에 한 번 바뀐다. 주문마다 물어볼 이유가 없다.
static FX: std::sync::OnceLock<std::sync::Mutex<std::collections::HashMap<String, (i64, f64, String)>>> =
    std::sync::OnceLock::new();

const FX_CACHE_SECS: i64 = 6 * 3600;

fn now_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// How many units of `cur` one US dollar buys, and where that came from.
async fn fiat_per_usd(cur: &str) -> Option<(f64, String)> {
    let cell = FX.get_or_init(Default::default);
    if let Ok(m) = cell.lock() {
        if let Some((at, rate, src)) = m.get(cur) {
            if now_secs() - at < FX_CACHE_SECS {
                return Some((*rate, src.clone()));
            }
        }
    }

    let got = match ecb_per_usd(cur).await {
        Some(v) => Some(v),
        None => erapi_per_usd(cur).await,
    }?;

    if let Ok(mut m) = cell.lock() {
        m.insert(cur.to_string(), (now_secs(), got.0, got.1.clone()));
    }
    Some(got)
}

/// 달러 한 개가 이 나라 돈으로 얼마인지. 한도 계산이 쓴다.
pub async fn fiat_per_usd_public(cur: &str) -> Option<f64> {
    if cur == "USD" {
        return Some(1.0);
    }
    fiat_per_usd(cur).await.map(|(r, _)| r)
}

/// 화면에 붙는 기호. 모르는 통화는 코드를 그대로 쓴다 — 틀린 기호보다 낫다.
pub fn symbol_for(cur: &str) -> String {
    symbol_of(cur)
}

fn symbol_of(cur: &str) -> String {
    match cur {
        "KRW" => "₩",
        "USD" => "$",
        "JPY" | "CNY" => "¥",
        "EUR" => "€",
        "GBP" => "£",
        "INR" => "₹",
        "PHP" => "₱",
        "THB" => "฿",
        "VND" => "₫",
        "TRY" => "₺",
        "BRL" => "R$",
        "AUD" | "CAD" | "NZD" | "SGD" | "HKD" | "TWD" | "MXN" => "$",
        other => return other.to_string(),
    }
    .to_string()
}

/// What one RVN is worth in the given currency.
///
/// Two independent sources per currency, averaged. One exchange can lag, go
/// down for maintenance, or print a bad tick; averaging two costs nothing and
/// stops a single bad source from mispricing a whole menu. If only one answers,
/// that one is used and the UI is told which.
///
/// Queried one after another rather than concurrently — two requests to two
/// hosts is not worth pulling in an async runtime dependency, and a menu that
/// takes an extra half second to price is not a problem anyone has.
#[tauri::command]
pub async fn rvn_rate(currency: String) -> Result<Value, String> {
    let cur = currency.to_uppercase();

    let blended = match cur.as_str() {
        "KRW" => blend(
            vec![
                (upbit("KRW-RVN").await, "업비트"),
                (bithumb_krw().await, "빗썸"),
            ],
            MIN_KRW_VOLUME,
        ),
        "USD" => blend(usd_ticks().await, MIN_USD_VOLUME),
        // 직접 시장이 없는 통화. 달러를 거쳐 간다.
        _ => {
            if cur.len() != 3 || !cur.bytes().all(|b| b.is_ascii_uppercase()) {
                return Err(format!(
                    "{cur} 는 통화 코드가 아닙니다. JPY·EUR 처럼 세 글자로 적어 주세요."
                ));
            }
            let Some((usd, usd_src, spread, dropped)) =
                blend(usd_ticks().await, MIN_USD_VOLUME)
            else {
                return Err(
                    "지금은 RVN 시세를 가져오지 못했습니다. RVN 금액으로만 받을 수 있습니다.".into(),
                );
            };
            let Some((fx, fx_src)) = fiat_per_usd(&cur).await else {
                return Err(format!(
                    "{cur} 환율을 가져오지 못했습니다. 이 통화를 아직 지원하지 않거나, 환율 기관이 지금 응답하지 않습니다."
                ));
            };
            return Ok(json!({
                "currency": cur,
                "rate": usd * fx,
                // 두 단계였다는 사실과 각 단계의 출처를 값에 붙여 보낸다.
                // 화면과 장부가 이걸 그대로 보여 주므로, 나중에 이 숫자가
                // 어떻게 나왔는지 다시 세울 수 있다.
                "sources": [format!("{} (RVN/USD)", usd_src.join("·")), fx_src],
                // 달러 단계의 불일치를 그대로 물려받는다. 여기서 0 으로 적으면
                // 거래소가 갈라져 있어도 화면은 안정된 값처럼 보인다.
                "spread": spread,
                "unstable": spread > 0.02,
                "dropped": dropped,
                "direct": false,
                "usd_rate": usd,
                "fx": fx,
                "symbol": symbol_of(&cur),
            }));
        }
    };

    let Some((rate, sources, spread, dropped)) = blended else {
        return Err(format!(
            "지금은 {cur} 시세를 가져오지 못했습니다. RVN 금액으로만 받을 수 있습니다."
        ));
    };

    Ok(json!({
        "currency": cur,
        "rate": rate,
        "sources": sources,
        "spread": spread,
        // Over ~2% the two exchanges disagree enough to say so out loud.
        "unstable": spread > 0.02,
        // 거래가 멎어 계산에서 뺀 거래소. 화면이 이걸 말해 줘야, 출처가 하나로
        // 줄어든 것을 사장이 알아챈다.
        "dropped": dropped,
        // 이 통화에는 실제 RVN 시장이 있다. 한 단계로 나온 값이다.
        "direct": true,
        "symbol": symbol_of(&cur),
    }))
}

/// Freezes a fiat price into an RVN amount for a fixed window.
///
/// `expires_at` is a wall-clock deadline the UI counts down from and the shop
/// checks when the payment lands. A payment arriving after expiry is not wrong
/// — it is priced at the old rate, which is the shop's call to accept or not.
/// So this returns the fact and lets the shop decide.
///
/// `now_unix` is passed in rather than read here: the frontend already has the
/// clock the countdown will run against, and two clocks that disagree by a few
/// seconds produce a quote that expires before it is shown.
#[tauri::command]
pub async fn quote_price(
    amount: f64,
    currency: String,
    now_unix: i64,
) -> Result<Value, String> {
    if amount <= 0.0 {
        return Err("금액이 0보다 커야 합니다.".into());
    }
    let rate_info = rvn_rate(currency.clone()).await?;
    let rate = rate_info["rate"].as_f64().unwrap_or(0.0);
    if rate <= 0.0 {
        return Err("시세가 올바르지 않습니다.".into());
    }

    // Rounded up at 8 decimals. Rounding down would leave the shop a fraction
    // short on every single order, which adds up in exactly one direction.
    let rvn = (amount / rate * 1e8).ceil() / 1e8;

    Ok(json!({
        "amount": amount,
        "currency": rate_info["currency"],
        "symbol": rate_info["symbol"],
        "rvn": rvn,
        "rate": rate,
        "sources": rate_info["sources"],
        "unstable": rate_info["unstable"],
        // 직접 시세인지 달러를 거친 값인지. 장부가 이걸 그대로 적는다.
        "direct": rate_info["direct"],
        "expires_at": now_unix + QUOTE_SECONDS,
        "valid_seconds": QUOTE_SECONDS,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn t(price: f64, volume: f64) -> Option<Tick> {
        Some(Tick { price, volume })
    }

    /// 실제로 재서 나온 값이다. 업비트 USDT-RVN 은 24시간 거래대금 0,
    /// 마지막 체결 11시간 전에 0.002358 을 계속 내보내고 있었고, 바이낸스는
    /// 245,114 USDT 를 거래하며 0.00281 이었다.
    #[test]
    fn a_market_with_no_trading_is_not_a_price() {
        let (rate, sources, spread, dropped) = blend(
            vec![
                (t(0.002358, 0.0), "업비트"),
                (t(0.00281, 245_114.0), "바이낸스"),
            ],
            MIN_USD_VOLUME,
        )
        .expect("살아 있는 출처가 하나 있으면 값이 나와야 합니다");

        assert_eq!(rate, 0.00281, "죽은 시장이 평균에 섞였습니다");
        assert_eq!(sources, vec!["바이낸스"]);
        assert_eq!(spread, 0.0);
        assert_eq!(dropped, vec!["업비트"], "뺐다는 사실을 말해야 합니다");

        // 예전 방식이 냈을 값. 8% 낮다 — 달러를 거쳐 값을 매기는 모든 나라가
        // 하루 종일 그만큼 싸게 팔았을 것이다.
        let averaged = (0.002358 + 0.00281) / 2.0;
        assert!((averaged / rate - 1.0).abs() > 0.07);
    }

    #[test]
    fn two_live_markets_are_averaged_and_their_gap_reported() {
        let (rate, sources, spread, dropped) = blend(
            vec![(t(3.37, 2.6e9), "업비트"), (t(3.437, 1.17e8), "빗썸")],
            MIN_KRW_VOLUME,
        )
        .unwrap();
        assert!((rate - 3.4035).abs() < 1e-9);
        assert_eq!(sources.len(), 2);
        assert!(dropped.is_empty());
        // 2% 안쪽이면 조용히 넘어간다. 커피값에 매번 경고를 띄우면 아무도 안 읽는다.
        assert!(spread < 0.02, "{spread}");
    }

    /// 셋 중 하나가 튀어도 값이 안 흔들려야 한다. 평균이면 끌려간다.
    #[test]
    fn the_middle_value_ignores_one_bad_tick() {
        let (rate, sources, spread, _) = blend(
            vec![
                (t(0.002810, 245_114.0), "바이낸스"),
                (t(0.002804, 53_568.0), "OKX"),
                (t(0.004500, 5_000.0), "튄곳"),
            ],
            MIN_USD_VOLUME,
        )
        .unwrap();
        assert_eq!(rate, 0.002810, "중앙값이 아니라 끌려간 값입니다");
        assert_eq!(sources.len(), 3, "튄 곳도 셋에 포함해 보여 줘야 합니다");
        // 값은 안 흔들려도, 벌어져 있다는 사실은 말해야 한다.
        assert!(spread > 0.5, "{spread}");
    }

    #[test]
    fn everything_dead_is_no_price_at_all() {
        // 둘 다 멎었으면 값을 지어내지 않는다. 옛 값으로 파는 것보다
        // "지금은 원화로 못 받습니다" 가 낫다.
        assert!(blend(vec![(t(3.0, 0.0), "a"), (t(3.1, 0.0), "b")], MIN_KRW_VOLUME).is_none());
        assert!(blend(vec![(None, "a"), (None, "b")], MIN_KRW_VOLUME).is_none());
    }

    #[test]
    fn a_zero_price_is_never_used() {
        // 거래량이 충분해도 가격이 0 이면 그건 응답 오류다. 그대로 쓰면
        // 나눗셈에서 무한대가 나오고 손님은 0 RVN 을 내고 커피를 가져간다.
        assert!(blend(vec![(t(0.0, 1e9), "a"), (None, "b")], MIN_KRW_VOLUME).is_none());
    }

    #[test]
    fn unknown_currency_codes_are_refused_before_any_network_call() {
        // 세 글자 대문자가 아니면 환율 기관에 물어볼 것도 없다.
        for bad in ["", "K", "KRWW", "krw", "12", "원"] {
            let ok = bad.len() == 3 && bad.bytes().all(|b| b.is_ascii_uppercase());
            assert!(!ok, "{bad} 가 통과했습니다");
        }
    }
}

/// 실제 거래소를 두드리는 확인. 평소 시험에는 안 낀다.
/// `cargo test --lib -- --ignored --nocapture live_rates`
#[cfg(test)]
mod live {
    #[tokio::test]
    #[ignore]
    async fn live_rates() {
        for c in ["KRW", "USD", "JPY", "EUR", "CNY", "GBP", "XYZ"] {
            match super::rvn_rate(c.into()).await {
                Ok(v) => println!(
                    "  {c}: 1 RVN = {:.6} {}  직접={} 출처={} 뺀곳={} 벌어짐={:.2}%",
                    v["rate"].as_f64().unwrap_or(0.0),
                    v["symbol"].as_str().unwrap_or(""),
                    v["direct"].as_bool().unwrap_or(false),
                    v["sources"],
                    v["dropped"],
                    v["spread"].as_f64().unwrap_or(0.0) * 100.0,
                ),
                Err(e) => println!("  {c}: 거절 — {e}"),
            }
        }
    }
}
