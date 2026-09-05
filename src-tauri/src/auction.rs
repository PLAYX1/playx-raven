//! 자산 경매 — **순수 규칙만**.
//!
//! 설계는 `DESIGN-AUCTION.md`. 이 파일은 그 설계의 첫 조각(PR 1)이고,
//! **릴레이·체인·지갑을 하나도 안 건드린다.** 여기 있는 것은 전부 값을
//! 넣으면 값이 나오는 함수라, 시험으로 끝까지 몰아 볼 수 있다.
//!
//! ## 왜 이 순서로 하나
//!
//! 경매는 돈이 오간다. 그리고 이 저장소가 하루에 열두 번 밟은 병은
//! **「적혀는 있는데 안 도는 코드」**다. 릴레이와 체인이 붙은 채로는 그
//! 병을 못 잡는다 — 안 돌아도 오류가 안 나기 때문이다. 그래서 **잴 수 있는
//! 것부터** 만든다.
//!
//! ## 🔴 우리는 낙찰금을 안 만진다
//!
//! 입찰은 **말**이다(서명된 Nostr 글). 돈은 마감 뒤 `swap_take` 한 번에
//! 사는 사람 → 파는 사람으로 바로 간다. 보증금도 안 받는다. 받는 순간
//! 우리가 돈을 들고 있는 것이 되고, 그건 전자금융업이다
//! (`noncustody.rs` 가 이 파일도 같이 지킨다).

/// 시작가 하한. 1 RVN 아래로 시작하면 1% 개발비가 0.01 RVN 미만이 되고,
/// `swap_take` 가 그 출력을 통째로 건너뛴다 — 즉 **1%를 못 받는다.**
pub const MIN_START_RVN: f64 = 1.0;

/// 「이 주소가 이 판의 나다」를 적는 글의 첫머리.
/// 다른 서명과 섞이지 않게 우리 문패를 박는다.
pub const BIND_PREFIX: &str = "PLAYX-AUCTION";

/// 다음 최소 입찰. **`max(1 RVN, 올림(현재가 × 5%))`** 만큼 올린다.
///
/// 5%만 쓰면 1 RVN 짜리에서 0.05 씩 올라가 판이 안 끝나고, 1 RVN 만 쓰면
/// 1,000 RVN 짜리에서 천 번을 눌러야 한다. 둘 중 큰 쪽을 쓴다.
///
/// ⚠️ 화면에 그대로 적히는 숫자다. 소수점이 나오면 40~70대가 못 읽는다 —
///    그래서 올림한 정수 단위로만 오른다.
pub fn min_next(current: f64) -> f64 {
    if !current.is_finite() || current <= 0.0 {
        return MIN_START_RVN;
    }
    let step = (current * 0.05).ceil().max(1.0);
    current + step
}

/// 경매에 올릴 수 있는 이름인가.
///
/// 🔴 **1차는 고유 자산(`이름#태그`, 수량 1)만이다.**
/// - `PLAYX/앨범` 처럼 여러 장인 것은 묶음 UTXO 가 장마다 달라 한 번에 못 판다.
/// - `PLAYX!` 는 **발행 권한**이지 팔 물건이 아니다. 이걸 팔면 산 사람이
///   그 자산을 무한히 찍을 수 있다.
pub fn is_unique_asset(name: &str) -> bool {
    let n = name.trim();
    if n.is_empty() || n.ends_with('!') {
        return false;
    }
    match n.split_once('#') {
        // `#` 앞뒤가 모두 있어야 한다. `#태그`(뿌리 없음)·`이름#`(태그 없음) 둘 다 아니다.
        Some((root, tag)) => !root.is_empty() && !tag.is_empty() && !tag.contains('#'),
        None => false,
    }
}

/// 「이 주소가 이 판의 이 사람이다」라고 적는 문장.
///
/// 주소 열쇠로 이걸 서명하면, 남이 내 Nostr 이름을 흉내 내도 **내 주소를
/// 가져다 쓸 수는 없다.** 넷 중 하나만 달라도 다른 문장이 된다.
///
/// 🔴 `auction_id` 가 **반드시** 들어간다. 없으면 지난 판에서 받은 서명을
///    이번 판에 그대로 붙일 수 있다.
pub fn bind_message(nostr_pk: &str, asset: &str, addr: &str, auction_id: &str) -> String {
    format!("{BIND_PREFIX}|{nostr_pk}|{asset}|{addr}|{auction_id}")
}

/// 낙찰 수수료 **10%**. 맞교환의 1% 와 **다른 값이고, 그게 맞다.**
///
/// ## 왜 여기만 더 받나
///
/// 갈림선은 **「우리가 빠져도 그 일이 되는가」**다.
/// 그냥 맞교환은 우리가 빠져도 둘이 지갑끼리 직접 한다 — 그래서 1% 다.
/// 경매는 다르다. **값을 만드는 것이 경쟁 그 자체**라, 판을 열고 사람을
/// 모으고 마감을 지키는 쪽이 없으면 아예 성립하지 않는다.
///
/// 바깥 기준도 그렇다. 미술 경매는 낙찰가에 **25%** 를 얹는다(구매자
/// 프리미엄). eBay 는 13%, 크립토 장터는 2.5% 다. 10% 는 그 사이에서
/// **아무도 놀라지 않는 자리**다.
///
/// ## 🔴 끄는 길이 없다 — 맞교환 1% 와 같은 규칙이다
///
/// 대표님 지시(2026-08-23, "무조건 1% 받을거야 · 이거 설정하는거 없애")는
/// **요율을 못 바꾸게 하라**가 아니라 **끄는 스위치를 두지 마라**였다.
/// 그래서 여기도 상수 하나이고 설정 파일을 읽지 않는다.
/// 시험 `there_is_no_way_to_turn_the_auction_fee_off` 이 그걸 지킨다.
///
/// ⚠️ **화면에 미리 적어야 한다.** 낙찰된 뒤에 알게 되면 그게 신뢰를 깬다.
///    `winner_pays()` 가 그 한 숫자를 준다.
///
/// 🔴 **배선하는 사람에게 — 반드시 이 요율을 넘겨라.**
/// ```ignore
/// swap_take(hex, true, passphrase, Some(auction::SETTLE_FEE_RATE))
/// ```
/// 마지막 인자를 빼면 `fee_config()` 의 **1%** 가 걷힌다. 그러면 화면은
/// 10% 라 적고 체인은 1% 를 가져간다 — 돈에서 제일 나쁜 종류의 어긋남이다.
/// 시험 `the_advertised_rate_must_be_collectable` 이 이걸 지킨다.
pub const SETTLE_FEE_RATE: f64 = 0.10;

/// 낙찰 수수료 (RVN). 사토시 자리에서 반올림한다.
///
/// ⚠️ **0.01 RVN 미만이면 0 이다.** 체인이 먼지만 한 출력을 거절해서
///    `swap.rs` 가 그 출력을 통째로 건너뛴다(`MIN_DEV_FEE`). 10% 이므로 낙찰가가
///    **0.1 RVN 미만**일 때 그렇게 되는데, `MIN_START_RVN` 이 1 RVN 이라
///    정상적인 판에서는 일어나지 않는다. 시작가 하한을 낮추는 사람은
///    이 줄을 먼저 읽을 것.
pub fn settle_fee(price: f64) -> f64 {
    if !price.is_finite() || price <= 0.0 {
        return 0.0;
    }
    let fee = (price * SETTLE_FEE_RATE * 1e8).round() / 1e8;
    if fee < crate::swap::MIN_DEV_FEE { 0.0 } else { fee }
}

/// **입찰 전에 화면에 적을 한 숫자.** 낙찰되면 이만큼 나간다.
///
/// 낙찰가 + 낙찰 수수료 + 체인 수수료를 합친 값이다.
/// 🔴 셋을 따로 보여 주고 더하게 시키지 마라 — 그게 「그래서 얼마
///    넣으면 되나요」에 아무도 답 못 하게 만든다.
pub fn winner_pays(price: f64) -> f64 {
    preview_need(price, SETTLE_FEE_RATE)
}

/// 사는 사람이 실제로 준비해야 하는 RVN 한 숫자.
///
/// 🔴 **한 숫자여야 한다.** 낙찰가·수수료·체인 수수료를 따로 보여 주면
///    「그래서 얼마 넣으면 되나요」에 아무도 답을 못 한다. 모자라면 거래가
///    통째로 안 되고, 그건 산 사람 잘못처럼 보인다.
pub fn preview_need(price: f64, rate: f64) -> f64 {
    let fee = (price * rate * 1e8).round() / 1e8;
    price + fee + crate::swap::FEE
}

/// 한 판에 들어온 입찰 하나. 릴레이에서 읽은 것을 이 모양으로 줄여 놓는다.
#[derive(Debug, Clone, PartialEq)]
pub struct Bid {
    /// 이 입찰이 속한 판. 1079 의 `d` 태그.
    pub auction_id: String,
    /// 입찰자의 Nostr 공개키.
    pub bidder: String,
    /// 부른 값 (RVN).
    pub price: f64,
    /// 이벤트 시각 (Unix 초). 같은 값이면 **먼저 부른 사람이 이긴다.**
    pub at: i64,
    /// 주소 묶기 서명이 확인됐나. 확인 안 된 것은 1등이 될 수 없다.
    pub bound: bool,
}

/// 1등을 고른다.
///
/// 규칙은 셋뿐이고, **셋 다 필요하다**:
/// 1. 이 판(`auction_id`)의 입찰만. 다른 판 것을 섞으면 지난 판 서명이 산다.
/// 2. 주소 묶기가 확인된 것만. 안 그러면 남의 이름으로 값을 올려 판을 망칠 수 있다.
/// 3. 시작가 아래는 안 센다.
///
/// 같은 값이면 **먼저 부른 사람**이다. 그게 경매장의 규칙이고, 나중 사람이
/// 이기면 마지막 순간에 같은 값을 던지는 것이 이득이 된다.
pub fn rank_top<'a>(bids: &'a [Bid], auction_id: &str, start_price: f64) -> Option<&'a Bid> {
    bids.iter()
        .filter(|b| b.auction_id == auction_id && b.bound)
        .filter(|b| b.price.is_finite() && b.price >= start_price)
        .reduce(|a, b| {
            if b.price > a.price || (b.price == a.price && b.at < a.at) {
                b
            } else {
                a
            }
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 다음_최소는_읽을_수_있는_숫자다() {
        // 작은 판은 1 RVN 씩. 0.05 씩 오르면 판이 안 끝난다.
        assert_eq!(min_next(1.0), 2.0);
        assert_eq!(min_next(10.0), 11.0);
        // 19 × 5% = 0.95 → 올려서 1
        assert_eq!(min_next(19.0), 20.0);
        // 20 × 5% = 1.0 → 그대로 1
        assert_eq!(min_next(20.0), 21.0);
        // 큰 판은 5% 씩. 1 RVN 씩이면 천 번을 눌러야 한다.
        assert_eq!(min_next(1000.0), 1050.0);
        // 🔴 소수점이 남으면 화면에 「1050.0000001」 같은 것이 뜬다.
        for v in [1.0, 7.0, 19.0, 20.0, 100.0, 999.0, 1000.0] {
            let n = min_next(v);
            assert_eq!(n, n.round(), "{v} 다음이 정수가 아니다: {n}");
        }
    }

    #[test]
    fn 이상한_현재가는_시작가로_돌린다() {
        // 이 값들이 그대로 화면에 가면 「NaN RVN 부터」가 뜬다.
        assert_eq!(min_next(0.0), MIN_START_RVN);
        assert_eq!(min_next(-5.0), MIN_START_RVN);
        assert_eq!(min_next(f64::NAN), MIN_START_RVN);
        assert_eq!(min_next(f64::INFINITY), MIN_START_RVN);
    }

    #[test]
    fn 팔_수_있는_것과_없는_것() {
        // 팔 수 있다 — 고유 자산
        assert!(is_unique_asset("PLAYX#001"));
        assert!(is_unique_asset("PLAYX/MUSIC#첫판"));
        // 🔴 오너 토큰은 **발행 권한**이다. 팔면 산 사람이 무한히 찍는다.
        assert!(!is_unique_asset("PLAYX!"));
        assert!(!is_unique_asset("PLAYX#001!"));
        // 여러 장짜리는 1차 범위 밖 — 묶음 UTXO 가 장마다 다르다.
        assert!(!is_unique_asset("PLAYX"));
        assert!(!is_unique_asset("PLAYX/MUSIC"));
        // 모양이 깨진 것
        assert!(!is_unique_asset("#001"));
        assert!(!is_unique_asset("PLAYX#"));
        assert!(!is_unique_asset("PLAYX#a#b"));
        assert!(!is_unique_asset(""));
        assert!(!is_unique_asset("   "));
    }

    #[test]
    fn 묶는_문장은_넷_중_하나만_달라도_달라진다() {
        let a = bind_message("pk1", "PLAYX#001", "R1", "au1");
        assert!(a.starts_with(BIND_PREFIX), "문패가 없으면 다른 서명과 섞인다");
        // 🔴 하나라도 같은 문장이 나오면 그 서명을 옮겨 붙일 수 있다.
        assert_ne!(a, bind_message("pk2", "PLAYX#001", "R1", "au1"));
        assert_ne!(a, bind_message("pk1", "PLAYX#002", "R1", "au1"));
        assert_ne!(a, bind_message("pk1", "PLAYX#001", "R2", "au1"));
        // 🔴 이것이 제일 중요하다 — 지난 판 서명을 이번 판에 못 쓰게 한다.
        assert_ne!(a, bind_message("pk1", "PLAYX#001", "R1", "au2"));
    }

    fn 입찰(id: &str, who: &str, price: f64, at: i64, bound: bool) -> Bid {
        Bid { auction_id: id.into(), bidder: who.into(), price, at, bound }
    }

    #[test]
    fn 일등은_제일_높은_값이고_같으면_먼저_부른_사람() {
        let bids = vec![
            입찰("au1", "A", 10.0, 100, true),
            입찰("au1", "B", 30.0, 200, true),
            입찰("au1", "C", 30.0, 300, true), // 같은 값, 늦게
            입찰("au1", "D", 20.0, 150, true),
        ];
        let top = rank_top(&bids, "au1", 1.0).expect("1등이 있어야 한다");
        assert_eq!(top.bidder, "B", "같은 값이면 먼저 부른 사람이 이겨야 한다");
    }

    #[test]
    fn 일등이_될_수_없는_입찰들() {
        let bids = vec![
            // 🔴 다른 판. 섞이면 지난 판 서명이 이번 판에서 산다.
            입찰("au0", "옛판", 999.0, 100, true),
            // 🔴 주소 묶기가 없다. 남의 이름으로 값을 올려 판을 망칠 수 있다.
            입찰("au1", "안묶임", 500.0, 100, false),
            // 시작가 아래
            입찰("au1", "너무낮음", 0.5, 100, true),
            // 이것만 진짜
            입찰("au1", "진짜", 10.0, 100, true),
        ];
        let top = rank_top(&bids, "au1", 1.0).expect("1등이 있어야 한다");
        assert_eq!(top.bidder, "진짜");

        // ⚠️ **좋은 입찰이 하나도 없을 때 아무나 뽑으면 안 된다.**
        let 없음 = vec![입찰("au1", "안묶임", 500.0, 100, false)];
        assert!(rank_top(&없음, "au1", 1.0).is_none());
        assert!(rank_top(&[], "au1", 1.0).is_none());
    }

    #[test]
    fn 사는_사람이_준비할_돈은_한_숫자다() {
        // 100 RVN 에 1% + 체인 수수료 0.1
        let need = preview_need(100.0, 0.01);
        assert!((need - 101.1).abs() < 1e-9, "{need}");
        // 🔴 낙찰가보다 **반드시 커야 한다.** 같거나 작으면 거래가 통째로
        //    안 되고, 산 사람은 자기 잘못인 줄 안다.
        for p in [1.0, 7.5, 100.0, 12345.0] {
            assert!(preview_need(p, 0.01) > p, "{p} 에서 준비할 돈이 낙찰가 이하다");
        }
    }

    /// 🔴 **1 RVN 아래로 시작하면 1%를 못 받는다.**
    /// `swap_take` 는 0.01 RVN 미만 출력을 건너뛴다 — 즉 개발비 출력이
    /// 통째로 안 생긴다. 이건 설정으로 끌 수 있는 것이 아니라, 시작가
    /// 하한으로 막아야 하는 것이다.
    #[test]
    fn 시작가_하한이_개발비를_지킨다() {
        let 최소_출력 = 0.01_f64;
        assert!(
            MIN_START_RVN * 0.01 >= 최소_출력,
            "시작가 하한 {MIN_START_RVN} RVN 의 1% 가 {최소_출력} RVN 미만이다 — 개발비가 안 걷힌다"
        );
    }

    // ── 낙찰 수수료 ───────────────────────────────────────────────────

    /// 🔴 **끄는 길이 없어야 한다.** 맞교환 1% 와 같은 규칙이다.
    /// 상수 하나이고 설정 파일을 안 읽는다는 것을 여기서 못 박는다.
    #[test]
    fn there_is_no_way_to_turn_the_auction_fee_off() {
        assert!(SETTLE_FEE_RATE > 0.0, "낙찰 수수료가 0 이 됐다");
        assert!((SETTLE_FEE_RATE - 0.10).abs() < 1e-9,
                "낙찰 수수료가 10% 가 아니다: {SETTLE_FEE_RATE}");
        // 값이 있는 판에서는 반드시 걷힌다 — 조건부로 0 이 되면 안 된다.
        for price in [1.0, 7.0, 100.0, 1_234.5] {
            assert!(settle_fee(price) > 0.0, "{price} RVN 판에서 수수료가 0 이다");
        }
    }

    /// 경매는 10%, 가게·맞교환은 1%. **둘이 섞이면 안 된다.**
    /// 하나로 합치려는 사람이 여기서 빨간불을 본다.
    #[test]
    fn the_auction_takes_more_than_a_plain_swap() {
        let (shop_rate, _) = crate::shop::fee_config();
        assert!((shop_rate - 0.01).abs() < 1e-9, "가게 요율이 1% 가 아니다");
        assert!(SETTLE_FEE_RATE > shop_rate, "경매가 맞교환보다 적게 받는다");
        // 100 RVN 판: 가게라면 1, 경매는 10.
        assert!((settle_fee(100.0) - 10.0).abs() < 1e-8);
    }

    /// 화면에 적는 숫자와 실제로 나가는 숫자가 같아야 한다.
    #[test]
    fn the_number_on_screen_is_the_number_that_leaves() {
        let price = 50.0;
        let shown = winner_pays(price);
        let by_hand = price + settle_fee(price) + crate::swap::FEE;
        assert!((shown - by_hand).abs() < 1e-8,
                "화면값 {shown} 과 실제 {by_hand} 가 다르다");
        assert!(shown > price, "수수료가 안 얹혔다");
    }

    /// 이상한 값이 들어와도 조용히 이상한 돈을 만들지 않는다.
    #[test]
    fn a_broken_price_yields_no_fee() {
        for bad in [0.0, -1.0, f64::NAN, f64::INFINITY] {
            assert_eq!(settle_fee(bad), 0.0, "{bad} 에서 수수료가 생겼다");
        }
    }

    /// 시작가 하한이 지키는 것: 10% 가 먼지(0.01 RVN)보다 커야 한다.
    /// 하한을 낮추면 이 시험이 먼저 빨개진다.
    #[test]
    fn the_start_floor_keeps_the_fee_collectable() {
        assert!(settle_fee(MIN_START_RVN) >= crate::swap::MIN_DEV_FEE,
                "시작가 하한에서 수수료가 먼지보다 작다 — 한 푼도 못 걷는다");
    }

    /// 🔴 **화면에 적은 요율을 실제로 걷을 수 있어야 한다.**
    ///
    /// 2026-09-06 에 실제로 밟았다: 10% 를 상수로 넣어 놓고 걷는 길인
    /// `swap_take` 는 요율을 받을 자리가 없었다. 그대로 배선했으면 화면은
    /// 10%, 체인은 1% 였다. 이 시험은 **소스를 읽어서** 그 자리가 아직
    /// 있는지 본다 — 없어지면 여기가 먼저 빨개진다.
    #[test]
    fn the_advertised_rate_must_be_collectable() {
        let src = include_str!("swap.rs");
        assert!(src.contains("fee_rate: Option<f64>"),
                "swap_take 가 요율을 못 받는다 — 경매 10% 는 화면에만 남는다");
        assert!(src.contains("pub async fn swap_check_at"),
                "요율을 골라 계산하는 길이 사라졌다");
        assert!(src.contains("rate.unwrap_or(기본요율)"),
                "요율을 안 주면 기본으로 떨어지는 안전장치가 사라졌다");
    }

    /// 화면에 보이는 한 숫자가 체인이 실제로 요구하는 값과 같아야 한다.
    /// `swap` 이 만드는 식과 **같은 식**으로 여기서도 센다.
    #[test]
    fn the_shown_total_matches_what_the_chain_will_ask() {
        for price in [1.0, 12.0, 137.5, 1000.0] {
            let 체인이_셀_값 = {
                let fee = (price * SETTLE_FEE_RATE * 1e8).round() / 1e8;
                price + fee + crate::swap::FEE
            };
            let 화면 = winner_pays(price);
            assert!((화면 - 체인이_셀_값).abs() < 1e-8,
                    "{price} RVN 판: 화면 {화면}, 체인 {체인이_셀_값}");
        }
    }
}
