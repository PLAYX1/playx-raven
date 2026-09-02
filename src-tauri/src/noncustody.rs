//! **우리는 남의 돈을 만지지 않는다.** 그 선을 코드가 지킨다.
//!
//! ## 🔴 왜 이 파일이 있나
//!
//! 대표님: "탈중앙은 PG사랑 세무 등 복잡한 책임이 얽혀 있지 않아서,
//!          회색지대고 마음대로 할 수 있고 심플해서야."
//!
//! 절반은 맞고 절반은 위험하다. 실측해 보니 우리는 **정말로 돈을 안 만진다**:
//!
//!   · 맞교환    `outs.insert(seller, price)` — 파는 사람에게 **직접** 간다
//!   · 가게 결제 한 거래에서 가게 몫·우리 몫이 **각자에게** 나뉜다
//!   · 원화      PG·카드·계좌 코드가 **0줄**
//!
//! 그래서 PG 계약도, 정산 책임도, 전자금융업 등록도 없다. **그건 진짜 장점이다.**
//!
//! 그런데 「회색지대라 마음대로」는 틀렸다. **회색지대가 아니라 「규제 밖」**이고,
//! 둘은 완전히 다르다. 선을 넘는 순간 규제 안이다:
//!
//!   ① 손님 돈을 **잠깐이라도** 우리가 보관   → 전자금융업·가상자산사업자
//!   ② 원화 ↔ RVN 환전                        → 자금이체업
//!   ③ 우리가 거래를 붙여 주고 수수료          → 가상자산사업자 신고 의무
//!
//! 지금은 셋 다 안 넘는다. **문제는 내일이다.** 언젠가 누가(또는 내가)
//! 「손님 돈을 잠깐 받아 뒀다 주면 편하겠네」 하고 한 줄을 넣는다. 그날
//! 이 사업은 규제 안으로 들어가고, **대표님은 한국 실명 개인사업자다.**
//!
//! 사람 기억에 맡기면 안 된다. 그래서 시험이 지킨다.
//!
//! ⚠️ 나는 변호사가 아니다. 이 시험은 법 자문이 아니라 **우리가 정한 선**을
//!    지키는 장치다. 실제 판단은 변호사에게 받아야 한다.

/// 넘으면 안 되는 선을 나타내는 낱말들.
///
/// ⚠️ 이름만 보고 막지 않는다 — 시세를 「rate」라 부르는 것은 괜찮고,
///    남의 돈을 우리 주소로 받는 것이 문제다. 그래서 **함수 이름이 아니라
///    실제로 하는 일**을 나타내는 조합을 본다.
pub const CUSTODY_MARKS: &[&str] = &[
    "escrow_hold",
    "hold_customer_funds",
    "custody_wallet",
    "pool_address",
    "omnibus",
];

/// 환전을 뜻하는 조합.
pub const EXCHANGE_MARKS: &[&str] = &[
    "krw_to_rvn",
    "rvn_to_krw",
    "fiat_swap",
    "sell_rvn_for",
    "buy_rvn_with",
];

#[cfg(test)]
mod tests {
    use super::{CUSTODY_MARKS, EXCHANGE_MARKS};

    /// 우리 코드 전부를 훑는다.
    fn 모든_소스() -> Vec<(&'static str, &'static str)> {
        vec![
            ("shop.rs", include_str!("shop.rs")),
            ("swap.rs", include_str!("swap.rs")),
            ("server.rs", include_str!("server.rs")),
            ("devfee.rs", include_str!("devfee.rs")),
            ("refund.rs", include_str!("refund.rs")),
            ("wallet.rs", include_str!("wallet.rs")),
            // 경매는 낙찰금을 우리가 안 만진다. 그 약속을 여기서 지킨다.
            ("auction.rs", include_str!("auction.rs")),
        ]
    }

    /// 🔴 **손님 돈을 우리가 들고 있으면 안 된다.**
    ///
    /// 넘는 순간 전자금융업·가상자산사업자다. 미신고 영업은 형사처벌이고,
    /// 대표님은 페이퍼컴퍼니 뒤에 숨은 사람이 아니라 **실명 개인사업자**다.
    #[test]
    fn 손님_돈을_보관하지_않는다() {
        for (name, src) in 모든_소스() {
            let end = src.find("#[cfg(test)]").unwrap_or(src.len());
            for m in CUSTODY_MARKS {
                assert!(
                    !src[..end].contains(m),
                    "{name} 에 「{m}」 이 생겼습니다.\n\
                     손님 돈을 우리가 잠깐이라도 들고 있으면 전자금융업·\
                     가상자산사업자가 됩니다. 지금 구조는 파는 사람에게 **직접** \
                     보냅니다 — 그 선을 넘지 마십시오."
                );
            }
        }
    }

    /// 🔴 **환전하지 않는다.** 원화↔RVN 을 우리가 바꿔 주면 자금이체업이다.
    #[test]
    fn 환전하지_않는다() {
        for (name, src) in 모든_소스() {
            let end = src.find("#[cfg(test)]").unwrap_or(src.len());
            for m in EXCHANGE_MARKS {
                assert!(
                    !src[..end].contains(m),
                    "{name} 에 「{m}」 이 생겼습니다.\n\
                     원화와 RVN 을 우리가 바꿔 주면 자금이체업입니다. \
                     시세를 **보여 주는 것**과 **바꿔 주는 것**은 다릅니다."
                );
            }
        }
    }

    /// 🔴 **가게 결제는 한 거래에서 각자에게 나뉜다.** 우리 주소를 거쳐
    ///    가게로 보내는 구조가 되면 그 순간 보관이다.
    #[test]
    fn 가게_몫이_우리를_거치지_않는다() {
        let src = include_str!("shop.rs");
        let i = src.find("pub fn split_payment").expect("쪼개는 함수가 있어야 한다");
        let end = src[i..].find("\n}").unwrap_or(src.len() - i);
        let body = &src[i..i + end];
        // 쪼개기만 하고 **보내지 않는다.** 보내는 것은 손님 지갑이 한다.
        assert!(
            !body.contains("sendtoaddress") && !body.contains("sendmany"),
            "쪼개는 함수가 돈을 보내고 있습니다 — 그러면 우리가 만지는 것입니다"
        );
        assert!(
            body.contains("shop_gets"),
            "가게 몫을 따로 계산하지 않고 있습니다"
        );
    }

    /// 지키려는 것을 **글로도 남긴다.** 시험만 있으면 다음 사람은 왜 막혔는지
    /// 모르고 시험을 지운다.
    #[test]
    fn 왜_이_선을_지키는지_적혀_있다() {
        let src = include_str!("noncustody.rs");
        for 말 in ["전자금융업", "자금이체업", "실명 개인사업자", "변호사"] {
            assert!(src.contains(말), "「{말}」 이 안 적혀 있습니다");
        }
    }
}
