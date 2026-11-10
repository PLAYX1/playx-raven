//! 11-10 글자 크기(작게·보통·크게) — 대표·페이블 합의.
//!
//! - CSS `zoom` 이 아니라 **웹뷰 확대**(Ctrl+ 와 같음)를 쓴다. 글자가 606곳 px 로 박혀 있어 글꼴 배율로는 안 닿고,
//!   CSS zoom 은 화면 폭 규칙·고정 위치를 어긋나게 한다. 웹뷰 확대는 화면 폭이 실제로 줄어 기존 좁은 화면 규칙이 그대로 돈다.
//! - **창 최소 폭도 같이 곱한다.** 720px 창을 130% 로 키우면 실제 폭 554px → 폰 배치로 떨어진다(「글자 키웠더니 화면이 바뀌었다」).
//!   그래서 최소 폭 = 720 × 배율, 지금 창이 그보다 좁으면 넓혀 준다 → 실제 폭은 늘 720 이상.
//! - 받는 값은 세 낱말뿐. 그 밖의 값은 거절한다.
use tauri::{LogicalSize, Manager, Size};

const MIN_W: f64 = 720.0;
const MIN_H: f64 = 480.0;

/// 낱말 → 배율. 기본(저장값 없음)은 「보통」 115% — 본문 16px × 1.15 ≈ 18px(11-07 「본문 18+」).
pub fn zoom_of(level: &str) -> Option<f64> {
    match level {
        "small" => Some(1.0),
        "normal" => Some(1.15),
        "large" => Some(1.3),
        _ => None,
    }
}

#[tauri::command]
pub fn set_text_zoom(app: tauri::AppHandle, level: String) -> Result<f64, String> {
    let z = zoom_of(&level).ok_or("글자 크기는 작게·보통·크게만 고를 수 있어요.")?;
    let w = app.get_webview_window("main").ok_or("창을 찾지 못했어요.")?;
    let min = LogicalSize::new(MIN_W * z, MIN_H);
    w.set_min_size(Some(Size::Logical(min))).map_err(|e| e.to_string())?;
    if let (Ok(size), Ok(scale)) = (w.inner_size(), w.scale_factor()) {
        let cur = size.to_logical::<f64>(scale);
        if cur.width < min.width {
            let _ = w.set_size(Size::Logical(LogicalSize::new(min.width, cur.height.max(MIN_H))));
        }
    }
    w.set_zoom(z).map_err(|e| e.to_string())?;
    Ok(z)
}

#[cfg(test)]
mod tests {
    #[test]
    fn 세_낱말만_받는다() {
        assert_eq!(super::zoom_of("small"), Some(1.0));
        assert_eq!(super::zoom_of("normal"), Some(1.15));
        assert_eq!(super::zoom_of("large"), Some(1.3));
        assert_eq!(super::zoom_of("2.0"), None);
        assert_eq!(super::zoom_of(""), None);
    }
}
