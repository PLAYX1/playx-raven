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
}
