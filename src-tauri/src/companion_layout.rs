//! Logical-pixel geometry shared by native sizing and the DOM (no webview guesses).
use serde::Serialize;
#[derive(Clone, Copy, Debug, Default, Serialize)]
pub struct Layout {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    pub bird: f64,
    pub bird_left: f64,
    pub bird_top: f64,
    pub bubble_width: f64,
    pub bubble_height: f64,
    pub below: bool,
}
pub fn layout(
    area: (f64, f64, f64, f64),
    anchor: (f64, f64),
    size: u16,
    bubble: bool,
    content: f64,
) -> Layout {
    let (left, top, aw, ah) = area;
    let bird = (ah * 0.18 * size as f64 / 160.0)
        .clamp(96.0, 240.0)
        .min(aw)
        .min(ah);
    // If even 288 logical pixels do not fit, callers use the main window instead.
    let bw = 360.0_f64.min((aw - 16.0).max(288.0));
    let bh = content.clamp(100.0, (ah - bird - 24.0).max(100.0));
    let width = if bubble { bw + 16.0 } else { bird };
    let height = if bubble { bird + bh + 24.0 } else { bird };
    let below = bubble && anchor.1 - top < bh + 24.0;
    let x = anchor.0.clamp(left, left + (aw - width).max(0.0));
    let y = (if bubble && !below {
        anchor.1 - bh - 24.0
    } else {
        anchor.1
    })
    .clamp(top, top + (ah - height).max(0.0));
    Layout {
        x,
        y,
        width,
        height,
        bird,
        bird_left: (anchor.0 - x).clamp(0.0, (width - bird).max(0.0)),
        bird_top: if bubble && !below { bh + 24.0 } else { 0.0 },
        bubble_width: bw,
        bubble_height: bh,
        below,
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn property_no_narrow_bubbles_and_all_monitor_edges() {
        for aw in (320..=3840).step_by(37) {
            for ah in (480..=2160).step_by(79) {
                for size in [120, 160, 200] {
                    for (ax, ay) in [
                        (-4000., -2000.),
                        (-1920., 0.),
                        (-100., 4000.),
                        (5000., 5000.),
                    ] {
                        for content in [0., 100., 240., 9000.] {
                            let l = layout(
                                (-1920., -200., aw as f64, ah as f64),
                                (ax, ay),
                                size,
                                true,
                                content,
                            );
                            assert!(l.bubble_width >= 288. && l.bubble_width <= 360.);
                            assert!(l.x >= -1920. && l.y >= -200.);
                            assert!(l.x + l.width <= -1920. + aw as f64 + 0.001);
                            assert!(l.y + l.height <= -200. + ah as f64 + 0.001);
                            assert!(l.bird_left + l.bird <= l.width + 0.001);
                        }
                    }
                }
            }
        }
        assert!(layout((0., 0., 1280., 800.), (0., 0.), 160, true, 160.).below);
        assert!(!layout((0., 0., 1280., 800.), (1100., 650.), 160, true, 160.).below);
        assert_eq!(
            layout((0., 0., 1280., 800.), (20., 20.), 160, false, 160.).width,
            144.
        );
    }
}
