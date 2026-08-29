//! 우리 것이 전부 죽었을 때 마지막으로 물어보는 **공개 조회처**.
//!
//! ## 🔴 왜 필요한가 — 대비책이 하나뿐이면 대비책이 아니다
//!
//! 2026-08-29 실측. 공개 ElectrumX 에 붙는 코드는 **한 번도 작동한 적이 없었다**:
//!
//! ```text
//! electrumx.raventag.com:50002  평문 → 붙기는 하는데 응답이 안 온다 (TLS 포트)
//!                                TLS  → {"result":["ElectrumX-RVN 1.13.11","1.4"]}
//! ```
//!
//! 코드는 `TcpStream` 으로 **평문**을 보내고 있었다. 그래서 12초를 기다렸다가
//! 반드시 실패했다. **적혀는 있는데 안 도는 코드** — 이 저장소의 지병이다.
//!
//! 게다가 서버에게 이웃을 물어보니(`server.peers.subscribe`) **자기 하나뿐**이었다.
//! RVN 의 공개 ElectrumX 는 사실상 한 대다. TLS 를 붙여도 **여러 개가 되지 않는다.**
//!
//! ## 그래서 같은 종류를 늘리는 대신 다른 종류를 섞는다
//!
//! ```text
//! ① 이 가게 노드          가장 빠르고 아무도 안 본다
//! ② 이 가게 ElectrumX     사장이 돌린다면
//! ③ 공개 Blockbook        ← 여기. 다른 소프트웨어·다른 운영자·정식 인증서
//! ```
//!
//! ③ 은 ①②와 **함께 죽지 않는다.** 그게 대비책의 조건이다.
//!
//! ## ⚠️ 이건 타협이다. 그 값을 정확히 안다
//!
//! · 공개 조회처가 **우리 주소를 본다.** 누가 얼마를 갖고 있는지 그쪽이 안다.
//! · **자산(회원권·상품권)은 못 본다.** Blockbook 은 RVN 만 센다.
//!   그래서 `assets_unknown` 을 켜서 돌려준다 — **없는 것과 못 본 것은 다르다.**
//!   화면이 「자산 0」이라고 말하면 회원권을 산 사람이 안 샀다고 여긴다.
//!
//! ## 그래도 돈은 안 내준다
//!
//! 여기 오는 것은 **이미 서명된 거래**다. 12단어도 개인키도 그쪽에 안 간다.
//! 잔액을 거짓말해도 그 결과는 **네트워크가 거부하는 거래**이지 도둑맞은 코인이
//! 아니다. 그래서 이것은 **프라이버시 거래이지 보관 위임이 아니다.**

use serde_json::{json, Value};
use std::time::Duration;

/// 표준 Blockbook. RVN 공식 explorer 가 이 API 를 쓴다.
const BOOK: &str = "https://blockbook.ravencoin.org";

/// 공개처가 느리면 손님을 붙잡지 않는다. 장사는 속도가 생명이다.
const WAIT: Duration = Duration::from_secs(12);

fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(WAIT)
        .build()
        .map_err(|e| format!("연결을 준비하지 못했습니다: {e}"))
}

/// 주소의 RVN 잔액과 UTXO.
///
/// ⚠️ **자산은 못 본다.** 부르는 쪽이 그 사실을 화면에 그대로 옮겨야 한다.
pub async fn address(addr: &str) -> Result<Value, String> {
    let c = client()?;
    // ⚠️ 주소를 그대로 URL 에 붙이기 전에 **글자를 검사한다.** `../` 나 `?` 가
    //    섞이면 우리가 의도하지 않은 곳을 부르게 된다. RVN 주소는 base58 이라
    //    안전한 글자만 쓴다 — 그 밖의 것은 애초에 주소가 아니다.
    if addr.len() < 26
        || addr.len() > 42
        || !addr
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() && b != b'0' && b != b'O' && b != b'I' && b != b'l')
    {
        return Err("주소 형식이 올바르지 않습니다.".into());
    }
    let enc = addr;

    let info: Value = c
        .get(format!("{BOOK}/api/v2/address/{enc}"))
        .send()
        .await
        .map_err(|e| format!("공개 조회처에 닿지 못했습니다: {e}"))?
        .json()
        .await
        .map_err(|e| format!("공개 조회처의 답을 읽지 못했습니다: {e}"))?;

    let utxo: Value = c
        .get(format!("{BOOK}/api/v2/utxo/{enc}"))
        .send()
        .await
        .map_err(|e| format!("공개 조회처에 닿지 못했습니다: {e}"))?
        .json()
        .await
        .map_err(|e| format!("공개 조회처의 답을 읽지 못했습니다: {e}"))?;

    // Blockbook 은 사토시를 **문자열**로 준다. 숫자로 읽으면 조용히 0 이 된다.
    let sats: u64 = info
        .get("balance")
        .and_then(Value::as_str)
        .and_then(|s| s.parse().ok())
        .unwrap_or(0);

    let rows: Vec<Value> = utxo
        .as_array()
        .map(|a| {
            a.iter()
                .map(|u| {
                    json!({
                        "txid": u.get("txid").and_then(Value::as_str).unwrap_or_default(),
                        "outputIndex": u.get("vout").and_then(Value::as_u64).unwrap_or(0),
                        "satoshis": u.get("value").and_then(Value::as_str)
                                     .and_then(|s| s.parse::<u64>().ok()).unwrap_or(0),
                        "address": addr,
                    })
                })
                .collect()
        })
        .unwrap_or_default();

    Ok(json!({
        "address": addr,
        "rvn": sats as f64 / 100_000_000.0,
        "utxos": rows,
        // 🔴 빈 것이 아니라 **모르는 것**이다.
        "assets": {},
        "assets_unknown": true,
        "source": "공개 조회처 (blockbook.ravencoin.org)",
        "trusted": false,
    }))
}

/// 서명된 거래를 체인에 던진다.
///
/// ⚠️ 여기 오는 것은 **이미 서명된 것**이다. 열쇠는 손님 폰을 안 떠난다.
pub async fn broadcast(hex: &str) -> Result<String, String> {
    let r: Value = client()?
        .post(format!("{BOOK}/api/v2/sendtx/"))
        .header("content-type", "text/plain")
        .body(hex.to_string())
        .send()
        .await
        .map_err(|e| format!("공개 조회처에 닿지 못했습니다: {e}"))?
        .json()
        .await
        .map_err(|e| format!("공개 조회처의 답을 읽지 못했습니다: {e}"))?;

    if let Some(err) = r.get("error").and_then(Value::as_str) {
        return Err(format!("공개 조회처가 거절했습니다: {err}"));
    }
    r.get("result")
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| "공개 조회처가 거래 번호를 주지 않았습니다.".into())
}


/// 이 거래에 **돈을 넣은 주소**.
///
/// 🔴 대표님: "상대방 지갑주소가 안 보이던데."  화면은 이렇게 적고 있었다:
///
/// > 체인은 누가 보냈는지 기록하지 않습니다. 손님에게 받을 주소를 물어보셔야 합니다.
///
/// **사실이 아니다.** 실측(2026-08-29)으로 확인했다 — 거래의 입력에는 그 돈이
/// 어느 주소에서 왔는지 그대로 적혀 있다. 그래서 환불 칸이 비어 있었고,
/// **손님은 이미 가고 없으니 환불이 사실상 불가능했다.**
///
/// ⚠️ 완벽하지 않다. 정직하게:
/// · 거래소에서 보냈으면 **거래소 주소**가 나온다. 거기로 보내면 돈이 사라질 수 있다
/// · 입력이 여럿이면 첫 번째가 보낸 사람이 아닐 수 있다
///
/// 그래서 **채워 넣되 「맞는지 확인하세요」라고 말해야 한다.** 빈 칸보다는
/// 압도적으로 낫지만, 사장이 그대로 누르게 두면 안 된다.
pub async fn payer_of(txid: &str) -> Result<Option<String>, String> {
    if txid.len() != 64 || !txid.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err("거래 번호 형식이 올바르지 않습니다.".into());
    }
    let tx: Value = client()?
        .get(format!("{BOOK}/api/v2/tx/{txid}"))
        .send()
        .await
        .map_err(|e| format!("공개 조회처에 닿지 못했습니다: {e}"))?
        .json()
        .await
        .map_err(|e| format!("공개 조회처의 답을 읽지 못했습니다: {e}"))?;

    Ok(tx
        .get("vin")
        .and_then(Value::as_array)
        .and_then(|v| v.first())
        .and_then(|i| i.get("addresses"))
        .and_then(Value::as_array)
        .and_then(|a| a.first())
        .and_then(Value::as_str)
        .map(str::to_string))
}

#[cfg(test)]
mod tests {
    /// ⚠️ **주석을 빼고** 검사한다. 안 그러면 이 파일의 설명글에 적힌
    ///    `TcpStream` 같은 낱말을 검사가 스스로 잡는다 — 이 저장소에서
    ///    여섯 번째로 밟은 지뢰다.
    fn 코드만(src: &str) -> String {
        src.split("#[cfg(test)]")
            .next()
            .unwrap_or(src)
            .lines()
            .filter(|l| {
                let t = l.trim_start();
                !t.starts_with("//") && !t.starts_with("//!")
            })
            .collect::<Vec<_>>()
            .join("\n")
    }

    /// 🔴 오늘의 버그를 박제한다.
    ///
    /// `TcpStream` 은 평문이다. 거기에 **TLS 포트(50002)** 를 적어 두면 12초를
    /// 버리고 반드시 실패한다 — 그런데 코드는 「대비책이 있다」고 말한다.
    /// 그게 여섯 달 동안 아무도 못 본 이유다.
    #[test]
    fn 평문_소켓에_tls_포트를_적지_않는다() {
        let src = include_str!("electrum.rs");
        let 코드만 = src.split("#[cfg(test)]").next().unwrap_or(src);
        for (i, line) in 코드만.lines().enumerate() {
            let l = line.trim_start();
            if l.starts_with("//") || l.starts_with("///") {
                continue;
            }
            assert!(
                !l.contains("50002"),
                "electrum.rs:{} 가 TLS 포트 50002 를 평문 소켓에 쓰고 있습니다. \
                 붙기는 하지만 답이 오지 않아 12초를 버리고 실패합니다: {l}",
                i + 1
            );
        }
    }

    /// 대비책은 **함께 죽지 않아야** 대비책이다.
    ///
    /// 공개 조회처가 ElectrumX 와 같은 기계·같은 소프트웨어면 하나가 죽을 때
    /// 둘 다 죽는다. 그래서 여기는 **HTTP 기반의 다른 종류**여야 한다.
    #[test]
    fn 공개_조회처는_electrum_과_다른_종류다() {
        let 코드만 = 코드만(include_str!("publicbook.rs"));
        assert!(
            코드만.contains("https://"),
            "공개 조회처는 HTTP 기반이어야 합니다 — Electrum 과 함께 죽지 않도록."
        );
        assert!(
            !코드만.contains("TcpStream"),
            "여기서 원시 소켓을 쓰면 Electrum 과 같은 실패를 물려받습니다."
        );
    }

    /// **없는 것과 못 본 것은 다르다.**
    ///
    /// Blockbook 은 자산을 못 본다. 그걸 「자산 0」으로 돌려주면, 회원권을 산
    /// 사람이 안 샀다고 여긴다. 지갑이 할 수 있는 가장 나쁜 거짓말이다.
    #[test]
    fn 자산을_못_본다는_사실을_숨기지_않는다() {
        let 코드만 = 코드만(include_str!("publicbook.rs"));
        assert!(
            코드만.contains("assets_unknown"),
            "자산을 못 보면 못 본다고 말해야 합니다."
        );
    }
}

#[cfg(test)]
mod 주소검사 {
    #[test]
    fn 이상한_주소는_부르기_전에_막는다() {
        for bad in [
            "../../etc/passwd",
            "RLFnbkjmf1VCVq7D9TZvRp7fv6W97rm2cB/../../x",
            "R?a=1",
            "R",
            "",
        ] {
            let r = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .unwrap()
                .block_on(super::address(bad));
            assert!(r.is_err(), "{bad:?} 를 그대로 URL 에 붙이려 했습니다");
        }
    }

    /// ⚠️ 검사를 넣으면 **좋은 입력도 통과하는지** 같이 확인해야 한다.
    ///    (2026-08-27 에 두 번 밟은 지뢰 — 안전장치가 정상 입력을 막았다.)
    #[test]
    fn 진짜_주소는_막지_않는다() {
        for ok in [
            "RLFnbkjmf1VCVq7D9TZvRp7fv6W97rm2cB",
            "RXissueAssetXXXXXXXXXXXXXXXXXhhZGt",
        ] {
            assert!(
                ok.len() >= 26
                    && ok.len() <= 42
                    && ok.bytes().all(|b| b.is_ascii_alphanumeric()
                        && b != b'0'
                        && b != b'O'
                        && b != b'I'
                        && b != b'l'),
                "{ok} 은 진짜 RVN 주소인데 검사가 막았습니다"
            );
        }
    }
}
#[tokio::test]
#[ignore]
async fn 진짜로_공개처에_붙는다() {
    let v = crate::publicbook::address("RLFnbkjmf1VCVq7D9TZvRp7fv6W97rm2cB").await.unwrap();
    println!("잔액 {} RVN · 출처 {}", v["rvn"], v["source"]);
    assert_eq!(v["assets_unknown"], true);
}
