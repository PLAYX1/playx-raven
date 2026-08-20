//! Making this machine reachable from outside the shop.
//!
//! ## The problem this fixes
//!
//! The phone server binds to the local network, so a sale link looks like
//! `http://192.168.0.5:8790/buy?id=…`. That address exists only inside the
//! building. Posted on X it opens for nobody — which quietly turns "online
//! selling" into "selling to people standing in the shop".
//!
//! A home computer is behind a router that refuses unsolicited connections.
//! Getting past that means either opening a port on the router — which most
//! owners cannot do and should not be talked into — or letting something
//! outside hold the connection open on our behalf. That is a tunnel.
//!
//! ## What it costs, said plainly
//!
//! Everything else in this app talks to 127.0.0.1. A tunnel is the one piece
//! that puts a company between the shop and its customers: Cloudflare carries
//! the traffic, and while payments are still signed by wallets and settled on
//! the chain, the *page* is served through them. The app must say so rather
//! than presenting a public URL as if it appeared by magic.
//!
//! ## The trap with the free version
//!
//! `--url` mode issues a throwaway hostname and a new one on every restart.
//! A link posted to X on Monday is dead on Tuesday, and the customer sees an
//! error rather than a shop. So the UI has to warn before anyone publishes one,
//! and a shop that sells regularly needs a named tunnel on their own domain.

use serde_json::{json, Value};
use std::io::{BufRead, BufReader};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;

/// The running tunnel, if any. Killed when the app exits or the owner stops it.
static CHILD: Mutex<Option<Child>> = Mutex::new(None);
static URL: Mutex<Option<String>> = Mutex::new(None);

/// Percent-encoding for share URLs.
///
/// Written out rather than pulled from a crate: this needs the strict RFC 3986
/// unreserved set, and several encoding helpers leave `+`, `&` or `/` alone —
/// which silently truncates a shared message at the first ampersand.
pub fn urlencode(s: &str) -> String {
    s.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                (b as char).to_string()
            }
            _ => format!("%{b:02X}"),
        })
        .collect()
}

/// Is cloudflared installed, and is a tunnel up?
#[tauri::command]
pub fn tunnel_status() -> Value {
    let installed = Command::new("which")
        .arg("cloudflared")
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false);

    let url = URL.lock().ok().and_then(|g| g.clone());
    let running = CHILD
        .lock()
        .ok()
        .map(|g| g.is_some())
        .unwrap_or(false);

    json!({
        "installed": installed,
        "running": running && url.is_some(),
        "url": url,
        "how": if installed { "" } else { "brew install cloudflared" },
    })
}

/// Opens a public address that forwards to the phone server.
///
/// Reads cloudflared's own output for the hostname rather than guessing it.
/// The process stays alive for as long as the app does; stopping it closes the
/// address immediately, which is the only "take it down" that actually works.
#[tauri::command]
pub fn tunnel_start(port: u16) -> Result<Value, String> {
    if CHILD.lock().map(|g| g.is_some()).unwrap_or(false) {
        return Err("이미 켜져 있습니다.".into());
    }

    let mut child = Command::new("cloudflared")
        .args([
            "tunnel",
            "--url",
            &format!("http://127.0.0.1:{port}"),
            // Without this the banner and update checks bury the hostname.
            "--no-autoupdate",
        ])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("cloudflared를 실행하지 못했습니다: {e}"))?;

    // The hostname is announced on stderr, usually within a few seconds.
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "cloudflared 출력을 읽지 못했습니다".to_string())?;

    let mut found: Option<String> = None;
    let reader = BufReader::new(stderr);
    for line in reader.lines().map_while(Result::ok).take(80) {
        if let Some(pos) = line.find("https://") {
            let rest = &line[pos..];
            let url: String = rest
                .chars()
                .take_while(|c| !c.is_whitespace() && *c != '|')
                .collect();
            if url.contains("trycloudflare.com") {
                found = Some(url);
                break;
            }
        }
    }

    match found {
        Some(url) => {
            if let Ok(mut g) = URL.lock() {
                *g = Some(url.clone());
            }
            if let Ok(mut g) = CHILD.lock() {
                *g = Some(child);
            }
            Ok(json!({
                "url": url,
                // Said every time, not once in a help page: this is the fact
                // that breaks a link somebody already posted.
                "warning": "이 주소는 임시입니다. 앱이나 터널을 다시 켜면 주소가 바뀌고, \
                            이미 올린 링크는 열리지 않습니다.",
            }))
        }
        None => {
            let _ = child.kill();
            Err("주소를 받지 못했습니다. 인터넷 연결을 확인해 주세요.".into())
        }
    }
}

/// Closes the public address.
#[tauri::command]
pub fn tunnel_stop() -> Result<(), String> {
    if let Ok(mut g) = CHILD.lock() {
        if let Some(mut c) = g.take() {
            let _ = c.kill();
            let _ = c.wait();
        }
    }
    if let Ok(mut g) = URL.lock() {
        *g = None;
    }
    Ok(())
}

/// The address a sale link should use: the tunnel if there is one, else the
/// local one.
#[tauri::command]
pub fn public_base(local_ip: String, port: u16) -> Value {
    let tunnel = URL.lock().ok().and_then(|g| g.clone());
    match tunnel {
        Some(u) => json!({ "base": u, "public": true }),
        None => json!({
            "base": format!("http://{local_ip}:{port}"),
            "public": false,
            // 링크를 올리기 전에 알아야 하는 사실이다. 올린 뒤에 알면
            // 손님은 깨진 링크를 본 것이고 그 손님은 다시 안 온다.
            "note": "이 주소는 같은 wifi 안에서만 열립니다. X에 올려도 밖에서는 안 보입니다.",
        }),
    }
}

/// Opens a share page for a link the owner is publishing.
///
/// Separate from `open_external`, which only ever opens `127.0.0.1` — that
/// restriction exists so a URL sitting in someone else's asset metadata cannot
/// make this app launch a browser at an arbitrary address, and it should stay.
///
/// This path is different: the owner pressed a button about their own listing.
/// Still whitelisted by host, because "the user meant it" stops being true the
/// moment a bug puts a different string in that variable.
#[tauri::command]
pub fn open_share(url: String) -> Result<(), String> {
    // Only the share endpoints, and only by exact prefix. A whitelist by host
    // alone would let a crafted path through, and this is the one command that
    // opens the outside world from inside a wallet.
    const ALLOWED: &[&str] = &[
        "https://twitter.com/intent/",
        "https://x.com/intent/",
        "https://www.threads.net/intent/",
        "https://threads.net/intent/",
        "https://www.facebook.com/sharer/",
        "https://t.me/share/",
        "https://telegram.me/share/",
        "https://line.me/R/msg/",
        "https://social-plugins.line.me/lineit/",
        "https://wa.me/",
        "https://sharer.kakao.com/",
        // 좌표가 맞는지 눈으로 확인하는 링크. 계정도 키도 필요 없다.
        "https://www.openstreetmap.org/?mlat=",
    ];
    if !ALLOWED.iter().any(|p| url.starts_with(p)) {
        return Err("이 주소는 열 수 없습니다.".into());
    }

    #[cfg(target_os = "macos")]
    {
        let status = std::process::Command::new("/usr/bin/open")
            .arg(&url)
            .status()
            .map_err(|e| format!("브라우저를 열지 못했습니다: {e}"))?;
        if !status.success() {
            return Err(format!("브라우저가 {status} 로 끝났습니다"));
        }
        Ok(())
    }
    #[cfg(not(target_os = "macos"))]
    {
        open::that(&url).map_err(|e| format!("브라우저를 열지 못했습니다: {e}"))
    }
}


/// Where a listing can be shared, and how.
///
/// Instagram and TikTok are absent on purpose, not by oversight: neither has a
/// web share endpoint and neither lets a post carry a link. The honest answer
/// there is the saved QR image, uploaded by hand — so the UI says that instead
/// of showing a button that cannot work.
///
/// KakaoTalk needs their JavaScript SDK and an app key registered to a domain,
/// which is a real setup step rather than a URL. Listed as "not yet" rather
/// than pretending it is impossible.
#[tauri::command]
pub fn share_targets(text: String, url: String) -> Value {
    let t = urlencode(&text);
    let u = urlencode(&url);
    let both = urlencode(&format!("{text}\n{url}"));

    json!({
        "links": [
            { "id": "x",        "name": "X",        "url": format!("https://twitter.com/intent/tweet?text={t}&url={u}") },
            { "id": "threads",  "name": "스레드",    "url": format!("https://www.threads.net/intent/post?text={both}") },
            { "id": "facebook", "name": "페이스북",  "url": format!("https://www.facebook.com/sharer/sharer.php?u={u}") },
            { "id": "telegram", "name": "텔레그램",  "url": format!("https://t.me/share/url?url={u}&text={t}") },
            { "id": "line",     "name": "라인",      "url": format!("https://line.me/R/msg/text/?{both}") },
            { "id": "whatsapp", "name": "왓츠앱",    "url": format!("https://wa.me/?text={both}") }
        ],
        // 버튼을 만들 수 없는 곳들. 왜 없는지 화면에 적어야, 사용자가 우리가
        // 빠뜨린 것으로 오해하지 않는다.
        "manual": [
            { "name": "인스타그램", "why": "게시물에 링크를 넣을 수 없습니다. 저장한 QR 사진을 올리세요." },
            { "name": "틱톡",       "why": "게시물에 링크를 넣을 수 없습니다. 저장한 QR 사진을 올리세요." },
            { "name": "카카오톡",   "why": "카카오 개발자 앱키가 있어야 붙일 수 있습니다. 지금은 링크를 복사해 붙여넣으세요." }
        ]
    })
}
