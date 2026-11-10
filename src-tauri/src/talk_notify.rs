//! 11-10 이야기 컴퓨터 알림 — 레이븐볼트를 내려 두거나 다른 창을 보고 있어도 「연락이 왔다」를 알린다(카톡처럼).
//!
//! 규칙(대표·페이블 합의, 바꾸지 말 것):
//! - **본문은 없다.** 방 = 「방이름 · ○○님」, 답글 = 「○○님이 답글을 달았어요」, 여러 건 = 「방이름: 새 글 3개」.
//!   글 내용은 알림 센터·잠금 화면에 남지 않는다(입금 알림과 같은 가림 규칙).
//! - 알림 문장은 **여기서** 만든다. 창은 종류·방 이름·보낸 이 이름·개수만 넘긴다 — 창이 임의 문장으로 알림을 띄울 길이 없다.
//!   이름은 릴레이에서 온 남의 글자라 제어 문자를 빼고 24자로 자른다.
//! - 창이 앞에 있으면 띄우지 않는다(앱 안 소리·라비 카드가 이미 알린다). 3초 안에 다시 부르면 건너뛴다(창이 묶어서 부른다).
//! - 리눅스는 dbus 의존성을 들이지 않으므로 없음(트레이·앱 안 알림만) — mini.rs 와 같다.
use tauri::Manager;

fn clean(s: &str) -> String {
    let t: String = s.chars().filter(|c| !c.is_control()).collect::<String>().split_whitespace().collect::<Vec<_>>().join(" ");
    t.chars().take(24).collect()
}

/// (제목, 본문). 본문은 늘 고정 문장.
pub fn text_of(kind: &str, room: &str, from: &str, count: u32, locale: &str) -> Option<(String, String)> {
    let (room, from) = (clean(room), clean(from));
    let n = count.max(1);
    let en = locale.starts_with("en");
    let title = match kind {
        "room" if n > 1 => if en { format!("{room}: {n} new posts") } else { format!("{room}: 새 글 {n}개") },
        "room" => if from.is_empty() { room.clone() } else { format!("{room} · {from}") },
        "reply" if n > 1 => if en { format!("{n} new messages for you") } else { format!("연락 {n}개가 왔어요") },
        "reply" => if en { format!("{from} replied to you") } else { format!("{from}님이 답글을 달았어요") },
        "dm" => if en { format!("New message from {from}") } else { format!("{from}님의 새 쪽지") },
        _ => return None,
    };
    if title.trim().is_empty() { return None; }
    let body = if en { "Open RavenVault to read it." } else { "레이븐볼트에서 확인하세요." };
    Some((title, body.to_string()))
}

static LAST: std::sync::Mutex<i64> = std::sync::Mutex::new(0);

#[tauri::command]
pub fn talk_os_notify(app: tauri::AppHandle, kind: String, room: Option<String>, from: Option<String>, count: Option<u32>, locale: Option<String>, sound: Option<bool>) -> Result<bool, String> {
    if let Some(w) = app.get_webview_window("main") {
        if w.is_focused().unwrap_or(false) && w.is_visible().unwrap_or(false) && !w.is_minimized().unwrap_or(false) {
            return Ok(false);
        }
    }
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0);
    {
        let mut last = LAST.lock().unwrap_or_else(|e| e.into_inner());
        if now - *last < 3000 { return Ok(false); }
        *last = now;
    }
    let Some((title, body)) = text_of(&kind, room.as_deref().unwrap_or(""), from.as_deref().unwrap_or(""), count.unwrap_or(1), locale.as_deref().unwrap_or("ko")) else {
        return Err("알 수 없는 알림 종류입니다.".into());
    };
    show(&app, title, body, sound.unwrap_or(true));
    Ok(true)
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
fn show(app: &tauri::AppHandle, title: String, body: String, sound: bool) {
    let id = app.config().identifier.clone();
    std::thread::spawn(move || {
        let mut x = notify_rust::Notification::new();
        x.summary(&title).body(&body);
        #[cfg(target_os = "macos")]
        {
            let _ = notify_rust::set_application(if tauri::is_dev() { "com.apple.Terminal" } else { &id });
            if sound { x.sound_name("Ping"); }
        }
        #[cfg(target_os = "windows")]
        {
            let dev = std::env::current_exe().ok().and_then(|p| p.parent().map(|d| d.ends_with("debug") || d.ends_with("release"))).unwrap_or(true);
            if !dev { x.app_id(&id); }
            if sound { x.sound_name("Default"); }
        }
        let _ = x.show();
    });
}
#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn show(_app: &tauri::AppHandle, _title: String, _body: String, _sound: bool) {}

#[cfg(test)]
mod tests {
    use super::text_of;
    #[test]
    fn 본문은_늘_고정이고_이름은_자른다() {
        let (t, b) = text_of("room", "광장", "김무송", 1, "ko").unwrap();
        assert_eq!(t, "광장 · 김무송");
        assert_eq!(b, "레이븐볼트에서 확인하세요.");
        assert_eq!(text_of("room", "광장", "", 3, "ko").unwrap().0, "광장: 새 글 3개");
        assert_eq!(text_of("dm", "", "이영희", 1, "ko").unwrap().0, "이영희님의 새 쪽지");
        let long = text_of("reply", "", "가나다라마바사아자차카타파하가나다라마바사아자차카타\n\u{7}", 1, "ko").unwrap().0;
        assert!(long.chars().count() <= 24 + "님이 답글을 달았어요".chars().count() && !long.contains('\n'));
        assert!(text_of("evil", "", "", 1, "ko").is_none());
        assert_eq!(text_of("reply", "", "Kim", 1, "en").unwrap().0, "Kim replied to you");
    }
}
