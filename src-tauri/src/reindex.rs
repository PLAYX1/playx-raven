//! 주소 색인을 **언제** 만들 것인가.
//!
//! 색인을 켜면 체인 43GB 를 처음부터 다시 훑는다. 몇 시간이 걸리고 그동안
//! **입금 확인이 멈춘다** — 손님 돈은 체인으로 잘 가지만 우리가 "받았습니다"를
//! 못 한다. 그래서 아무 때나 시작하면 안 된다.
//!
//! 🔴 **「밤에 하세요」로 짜면 안 된다.** 대표님 지적:
//!
//! > "어떤 사람은 밤에 일하는 사람도 있다는걸 기억해 줘야해"
//!
//! 포장마차·편의점·24시 헬스장·새벽 시장은 밤이 성수기다. 밤=한가함은
//! 개발자의 생활 리듬이지 사용자의 것이 아니고, 그렇게 짜면 **그 사람들에게만
//! 골라서** 장사를 멈춘다.
//!
//! 🔴 그리고 **「몇 시에 할까요」라고 물어도 안 된다.** 사장은 이게 몇 시간짜리
//! 일인지 모른다. 모르는 것을 물으면 아무 시간이나 고르고 장사 중에 멈춘다.
//! 물을 것은 사장이 즉답할 수 있는 **문 여는 시간·닫는 시간** 하나뿐이고,
//! 창은 우리가 계산한다. 그 값은 `shop.rs` 에 이미 있다.

use serde_json::{json, Value};

/// 하루 몇 분인가.
const DAY: i64 = 24 * 60;

/// `"09:00"` → 분. 못 읽으면 `None`.
fn hhmm(s: &str) -> Option<i64> {
    let (h, m) = s.split_once(':')?;
    let (h, m) = (h.trim().parse::<i64>().ok()?, m.trim().parse::<i64>().ok()?);
    // 🔴 `24:00` 을 거절하면 안 된다. 자정 마감을 그렇게 적는 곳이 많고,
    //    거절하면 그 요일이 통째로 「휴무」로 읽혀 **영업 중에 색인을 건다**.
    if h == 24 && m == 0 {
        return Some(24 * 60);
    }
    if !(0..=23).contains(&h) || !(0..=59).contains(&m) {
        return None;
    }
    Some(h * 60 + m)
}

/// 그 요일에 문을 여는 구간을 **분 단위 절대값**으로 편다.
///
/// 새벽까지 하는 가게(`22:00`~`02:00`)는 **다음 날로 넘어가는 한 구간**이다.
/// 이걸 잘못 다루면 새벽 장사가 「닫힘」으로 읽혀서, 하필 그 시간에 색인을
/// 걸게 된다 — 그 가게가 제일 바쁠 때.
fn busy_spans(hours: &Value) -> Option<Vec<(i64, i64)>> {
    let mut out = Vec::new();
    for d in 0..7i64 {
        let Some(e) = hours.get(d.to_string()) else { continue };
        let (Some(o), Some(c)) = (
            e.get("open").and_then(Value::as_str).and_then(hhmm),
            e.get("close").and_then(Value::as_str).and_then(hhmm),
        ) else {
            // 🔴 **못 읽은 것을 휴무로 치면 안 된다.** 적혀는 있는데 우리가
            //    못 읽는 것은 데이터가 깨진 것이고, 그걸 「한가함」으로 읽으면
            //    하필 장사 중에 색인을 건다. 모르면 모른다고 답한다.
            return None;
        };
        let start = d * DAY + o;
        // 닫는 시각이 여는 시각보다 이르면 자정을 넘긴 것이다.
        let end = if c > o { d * DAY + c } else { (d + 1) * DAY + c };
        out.push((start, end));
    }
    out.sort();
    Some(out)
}

/// 주중 어느 순간(`0`=일요일 00:00 부터의 분)이 장사 중인가.
fn busy_at(spans: &[(i64, i64)], minute: i64) -> bool {
    let week = 7 * DAY;
    spans.iter().any(|&(s, e)| {
        // 주를 넘어가는 구간(토요일 밤~일요일 새벽)을 위해 한 주씩 밀어 본다.
        [-week, 0, week]
            .iter()
            .any(|shift| minute >= s + shift && minute < e + shift)
    })
}

/// 지금부터 가장 가까운 **한가한 창**.
///
/// 반환하는 `hours` 는 그 창이 몇 시간짜리인지다. 창이 색인보다 짧으면
/// 중간에 장사가 시작되므로, 그 사실을 화면이 말할 수 있어야 한다.
pub fn window_from(hours: &Value, now_min_of_week: i64, need_min: i64) -> Value {
    let Some(spans) = busy_spans(hours) else {
        return json!({ "kind": "bad_hours" });
    };
    if spans.is_empty() {
        // 시간표가 없다. 모르면 모른다고 답한다 — 아무 때나 걸면 안 된다.
        return json!({ "kind": "no_hours" });
    }
    let week = 7 * DAY;
    // 한 주를 1분씩 훑는다. 10,080번이라 눈 깜짝할 새고, 새벽·주말·휴무일을
    // 특별하게 다루는 분기를 안 만들어도 된다.
    let mut open_minutes = 0;
    for i in 0..week {
        if busy_at(&spans, (now_min_of_week + i) % week) {
            open_minutes += 1;
        }
    }
    if open_minutes >= week {
        // 24시간 영업. 🔴 「새벽에 하죠」로 넘기면 안 된다 — 그런 창이 없다.
        return json!({ "kind": "always_open" });
    }
    // 🔴 **1분짜리 틈은 창이 아니다.** 「00:00~23:59」로 적어 둔 24시간 가게는
    //    하루에 1분씩 비는데, 그걸 창이라고 답하면 몇 시간짜리 일을 1분 뒤에
    //    시작하겠다고 말하는 셈이 된다. 실제로 그렇게 답했다.
    // 🔴 여기에 **필요한 길이**를 넣어야 한다. 60분을 쓰면 점심 휴게 1시간에
    //    몇 시간짜리 일을 넣겠다고 답한다 — 그러면 장사 시작 뒤에도 색인이
    //    돌아 입금 확인이 또 죽는다.
    let min_useful = need_min.max(60);
    let mut wait = 0;
    let mut span = 0;
    while wait < week {
        // 다음 한가한 지점까지.
        while wait < week && busy_at(&spans, (now_min_of_week + wait) % week) {
            wait += 1;
        }
        if wait >= week {
            break;
        }
        span = 0;
        while span < week && !busy_at(&spans, (now_min_of_week + wait + span) % week) {
            span += 1;
        }
        if span >= min_useful {
            break;
        }
        // 너무 짧다. 이 틈은 건너뛰고 다음을 본다.
        wait += span;
        span = 0;
    }
    if span < min_useful {
        // 쓸 만한 창이 한 주 안에 없다 = 사실상 24시간 영업이다.
        return json!({ "kind": "always_open" });
    }
    json!({
        "kind": "window",
        "starts_in_min": wait,
        "window_min": span,
        // 넉넉하지 않으면 정직하게 알린다. 끊겨도 코어가 스스로 이어 하지만
        // (init.cpp:755 — 다 끝나야 표시를 지운다), 장사 중에 도는 것은 사실이다.
        "tight": span < need_min * 3 / 2,
        "need_min": need_min,
    })
}

/// 다시 훑는 데 잡아 두는 시간. 이 컴퓨터에서 실제로 재 보기 전까지의 어림수다.
pub const NEED_MIN: i64 = 6 * 60;

#[tauri::command]
pub fn reindex_window(now_unix: i64, tz_offset_min: i64) -> Value {
    let shop = crate::shop::shop_load();
    let hours = shop.get("hours").cloned().unwrap_or_else(|| json!({}));
    // 1970-01-01 은 목요일이라 요일 맞추는 자리에서 4를 더한다.
    let local = now_unix / 60 + tz_offset_min;
    let mow = ((local + 4 * DAY) % (7 * DAY) + 7 * DAY) % (7 * DAY);
    let mut w = window_from(&hours, mow, NEED_MIN);
    w["addressindex_on"] = json!(crate::conf::wants_addressindex());
    w
}

#[cfg(test)]
mod tests {
    use super::*;

    fn day(open: &str, close: &str) -> Value {
        json!({ "open": open, "close": close })
    }

    /// 10시~22시 가게. 새벽이 한가하다.
    #[test]
    fn 보통_가게는_문_닫은_뒤가_창이다() {
        let h = json!({
            "0": day("10:00","22:00"), "1": day("10:00","22:00"), "2": day("10:00","22:00"),
            "3": day("10:00","22:00"), "4": day("10:00","22:00"), "5": day("10:00","22:00"),
            "6": day("10:00","22:00"),
        });
        // 월요일 12:00 = 1일*1440 + 720
        let w = window_from(&h, DAY + 720, 6 * 60);
        assert_eq!(w["kind"], "window");
        assert_eq!(w["starts_in_min"], 600, "22시까지 10시간 남았다");
        assert_eq!(w["window_min"], 720, "22시~다음날 10시 = 12시간");
    }

    /// 🔴 이게 대표님이 짚으신 경우다. 밤 8시에 열어 새벽 4시에 닫는 포장마차.
    /// 「밤에 하세요」로 짰으면 이 가게는 **제일 바쁠 때** 멈춘다.
    #[test]
    fn 밤에_일하는_가게는_낮이_창이다() {
        let mut h = json!({});
        for d in 0..7 {
            h[d.to_string()] = day("20:00", "04:00");
        }
        // 화요일 밤 22:00 — 장사 중이다.
        let w = window_from(&h, 2 * DAY + 22 * 60, 6 * 60);
        assert_eq!(w["kind"], "window");
        let starts = w["starts_in_min"].as_i64().unwrap();
        // 새벽 4시까지 6시간 남았다. 밤중에 시작하면 안 된다.
        assert_eq!(starts, 6 * 60, "장사가 끝나는 새벽 4시부터가 창이다");
        assert_eq!(w["window_min"], 16 * 60, "04시~20시 = 16시간");
    }

    /// 24시간 영업에는 창이 없다. 「새벽에 하죠」로 넘기지 않는다.
    #[test]
    fn 하루종일_하는_가게는_창이_없다고_말한다() {
        let mut h = json!({});
        for d in 0..7 {
            h[d.to_string()] = day("00:00", "23:59");
        }
        // 23:59~00:00 사이 1분이 비어서 always_open 이 안 될 수 있다.
        // 진짜 24시간은 open==close 로 적히므로 그 경우도 본다.
        assert_eq!(
            window_from(&h, 0, 6 * 60)["kind"], "always_open",
            "하루 1분 비는 것을 창이라고 답하면 안 된다"
        );
    }

    /// 일요일 휴무. 24시간 영업이어도 휴무일이 창이 된다.
    #[test]
    fn 휴무일이_있으면_그날이_창이다() {
        let mut h = json!({});
        for d in 1..7 {
            h[d.to_string()] = day("00:00", "23:59");
        }
        // 일요일(0)은 아예 없음 = 휴무.
        let w = window_from(&h, DAY, 6 * 60); // 월요일 00:00
        assert_eq!(w["kind"], "window");
        let starts = w["starts_in_min"].as_i64().unwrap();
        // 🔴 「00:00~23:59」는 하루에 1분씩 빈다. 그 틈을 창이라고 답하면
        //    안 된다 — 진짜 창은 다음 일요일이다.
        assert!(starts > 5 * DAY, "1분짜리 틈을 창이라고 답했다: {starts}");
        assert!(w["window_min"].as_i64().unwrap() >= DAY - 1, "휴무일 하루가 통째로 창이다");
    }

    /// 🔴 그록 지적. `24:00` 을 못 읽어 그 요일을 통째로 휴무로 치면,
    /// 하필 장사 중에 색인을 건다.
    #[test]
    fn 자정을_24시로_적어도_읽는다() {
        let mut h = json!({});
        for d in 0..7 {
            h[d.to_string()] = day("09:00", "24:00");
        }
        let w = window_from(&h, DAY + 600, 6 * 60); // 월 10:00, 장사 중
        assert_eq!(w["kind"], "window");
        assert_eq!(w["starts_in_min"], 14 * 60, "24:00 에 닫는다 = 14시간 뒤");
    }

    /// 🔴 그록 지적. 못 읽는 것을 휴무로 치면 안 된다.
    #[test]
    fn 못_읽는_시간표는_휴무가_아니라_모름이다() {
        let mut h = json!({});
        for d in 0..7 {
            h[d.to_string()] = day("09:00", "18:00");
        }
        h["3"] = day("아홉시", "여섯시");
        assert_eq!(
            window_from(&h, 0, 6 * 60)["kind"], "bad_hours",
            "깨진 시간표를 「그날은 한가함」으로 읽으면 장사 중에 색인을 건다"
        );
    }

    /// 🔴 그록 지적. 1시간짜리 틈에 몇 시간짜리 일을 넣으면 안 된다.
    #[test]
    fn 필요한_길이보다_짧은_창은_고르지_않는다() {
        // 점심 두 시간만 쉬고 아침 저녁으로 여는 가게는 아직 표현이 안 되니,
        // 밤에 5시간만 닫는 가게로 본다.
        let mut h = json!({});
        for d in 0..7 {
            h[d.to_string()] = day("05:00", "24:00");
        }
        // 00:00~05:00 = 5시간 창. 6시간이 필요하면 골라선 안 된다.
        assert_eq!(
            window_from(&h, DAY + 6 * 60, 6 * 60)["kind"], "always_open",
            "5시간 창에 6시간짜리 일을 넣겠다고 답하면 안 된다"
        );
        // 4시간만 필요하면 그 창을 쓴다.
        assert_eq!(window_from(&h, DAY + 6 * 60, 4 * 60)["kind"], "window");
    }

    /// 시간표가 없으면 모른다고 답한다. 아무 때나 걸지 않는다.
    #[test]
    fn 시간표가_없으면_모른다고_한다() {
        assert_eq!(window_from(&json!({}), 0, 6 * 60)["kind"], "no_hours");
    }
}
