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
/// 다시 알리는 심장이 이미 뛰고 있는가. 켰다 껐다를 반복하면 루프가 하나씩
/// 늘어나고, 그만큼 릴레이에 같은 글을 여러 번 보낸다 — 차단당하는 길이다.
static BEAT: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

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

/// cloudflared 가 어디 있나.
///
/// 🔴 **`which` 로 찾으면 안 된다.** Finder 에서 켠 앱의 `PATH` 는
/// `/usr/bin:/bin:/usr/sbin:/sbin` 뿐이다 — 터미널에서 보이는 `/opt/homebrew/bin`
/// 이 없다. 그래서 cloudflared 가 **멀쩡히 깔려 있는데도** 화면은
/// 「없습니다 — 터미널에서 brew install 하세요」라고 말했다.
///
/// 사장은 시키는 대로 터미널을 열어 다시 깔고, 그래도 안 되는 것을 본다.
/// 실제로 이 컴퓨터가 그 상태였다(`/opt/homebrew/bin/cloudflared` 있음).
///
/// 그래서 **아는 자리를 직접 본다.** PATH 는 마지막 수단이다.
pub fn find_cloudflared() -> Option<std::path::PathBuf> {
    // 우리가 직접 받아 둔 것이 있으면 그게 첫째다 — 사장이 아무것도 안 해도
    // 되는 유일한 길이고, brew 가 지워도 살아 있다.
    let ours = crate::paths::app_file("cloudflared");
    if ours.is_file() {
        return Some(ours);
    }
    for p in [
        "/opt/homebrew/bin/cloudflared", // 애플 실리콘 brew
        "/usr/local/bin/cloudflared",    // 인텔 brew · 수동 설치
        "/usr/bin/cloudflared",
        "/snap/bin/cloudflared",
        "C:\\Program Files (x86)\\cloudflared\\cloudflared.exe",
    ] {
        let p = std::path::PathBuf::from(p);
        if p.is_file() {
            return Some(p);
        }
    }
    // 마지막으로 PATH. 터미널에서 켠 경우에는 이쪽이 맞는다.
    // 🔴 윈도우에는 `which` 가 없다. `where` 다. 그래서 cloudflared 를
    //    멀쩡히 깔아 둔 윈도우 사장에게 「없습니다」라고 말했다.
    crate::quiet::cmd(if cfg!(windows) { "where" } else { "which" })
        .arg("cloudflared")
        .output()
        .ok()
        .filter(|o| o.status.success())
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .map(|s| std::path::PathBuf::from(s.trim()))
        .filter(|p| p.is_file())
}

/// Is cloudflared installed, and is a tunnel up?
#[tauri::command]
pub fn tunnel_status() -> Value {
    let found = find_cloudflared();
    let installed = found.is_some();

    // 🔴 **「시작했다」를 기억하는 것과 「살아 있다」는 다른 일이다.**
    //
    //    여태 `CHILD` 가 `Some` 이기만 하면 「켜짐」이라고 답했다. cloudflared 가
    //    죽어도 그 기억은 남는다. 그래서 화면은 초록인데 주소는 530 을 내고,
    //    **앱은 그 죽은 주소를 릴레이에 계속 공지했다** — QR 을 찍은 손님이
    //    죽은 주소로 간다. 사진이 안 보이는 것보다 나쁘다.
    //
    //    `try_wait()` 로 실제로 끝났는지 본다. 끝났으면 기억을 지운다 —
    //    그래야 다음 공지에 죽은 주소가 안 실린다.
    let running = {
        let mut g = match CHILD.lock() {
            Ok(g) => g,
            Err(e) => e.into_inner(),
        };
        match g.as_mut() {
            None => false,
            Some(c) => match c.try_wait() {
                Ok(None) => true,          // 아직 돌고 있다
                _ => {
                    *g = None;             // 죽었다. 기억을 지운다
                    if let Ok(mut u) = URL.lock() {
                        *u = None;
                    }
                    false
                }
            },
        }
    };
    let url = URL.lock().ok().and_then(|g| g.clone());

    json!({
        "installed": installed,
        "running": running && url.is_some(),
        "url": url,
        // 🔴 「터미널에서 brew install 하세요」라고 적어 두면 안 된다. 이
        // 프로그램의 사장은 70대이고, 터미널을 열어 본 적이 없다. 우리가 받는다.
        "how": if installed { "" } else { "받기" },
        "path": found.as_ref().map(|p| p.to_string_lossy().to_string()),
    })
}

/// 앞서 남은 cloudflared 중 **우리 포트를 물고 있는 것**만 정리한다.
///
/// 고르는 조건이 두 겹이다. 이름이 `cloudflared` 이고, **명령줄에 우리 주소가
/// 그대로 들어 있어야** 한다. 둘 다 맞아야 죽인다 — 이 컴퓨터에서 남이
/// 자기 일로 켜 둔 터널을 죽이면 그건 우리가 낸 사고다.
/// 이 `ps` 한 줄이 **우리가 남긴 터널**인가.
///
/// 죽이는 일이라 판단을 떼어 둔다. 여기가 무르면 남의 프로그램을 죽인다.
fn is_our_orphan(line: &str, want: &str) -> bool {
    let line = line.trim();
    line.contains("cloudflared") && line.contains(want) && !line.contains("ps -axo")
}

fn kill_orphans(port: u16) -> usize {
    let want = format!("http://127.0.0.1:{port}");
    // 🔴 윈도우에는 `ps` 도 `kill` 도 없다. 여기가 유닉스 명령뿐이라
    //    **윈도우에서는 유령이 하나도 안 치워졌다** — 맥에서 고친 그 병이
    //    윈도우에는 그대로 남아 있었던 것이다.
    #[cfg(target_os = "windows")]
    {
        // 명령줄까지 보고 **우리 포트를 물고 있는 것만** 고른다.
        let script = format!(
            "Get-CimInstance Win32_Process -Filter \"Name='cloudflared.exe'\" |              Where-Object {{ $_.CommandLine -like '*{}*' }} |              ForEach-Object {{ Stop-Process -Id $_.ProcessId -Force; 'killed' }}",
            want
        );
        let out = crate::quiet::cmd("powershell")
            .args(["-NoProfile", "-Command", &script])
            .output();
        return out
            .map(|o| String::from_utf8_lossy(&o.stdout).matches("killed").count())
            .unwrap_or(0);
    }
    #[cfg(not(target_os = "windows"))]
    {
    let out = match crate::quiet::cmd("ps").args(["-axo", "pid=,command="]).output() {
        Ok(o) => o,
        Err(_) => return 0,
    };
    let mut n = 0;
    for line in String::from_utf8_lossy(&out.stdout).lines() {
        if !is_our_orphan(line, &want) {
            continue;
        }
        let pid = match line.split_whitespace().next().and_then(|p| p.parse::<i32>().ok()) {
            Some(p) if p > 1 => p,
            _ => continue,
        };
        if std::process::id() as i32 == pid {
            continue;
        }
        let _ = crate::quiet::cmd("kill").arg(pid.to_string()).output();
        n += 1;
    }
    n
    }
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

    // 전체 경로로 부른다. 이름만 주면 PATH 를 타고, Finder 에서 켠 앱의
    // PATH 에는 brew 자리가 없다.
    let exe = find_cloudflared()
        .ok_or_else(|| "cloudflared 를 찾지 못했습니다. 「받기」를 눌러 주세요.".to_string())?;

    // 🔴 **앞서 남은 유령을 먼저 치운다.**
    //
    //    `CHILD` 는 **이번에 켠 앱이 띄운 자식**만 기억한다. 앱을 껐다 켜면
    //    그 기억은 사라지는데 cloudflared 는 그대로 남는다. 실측(2026-08-25):
    //    5시간 10분째 살아 있으면서 **바깥 연결이 0개**인 프로세스가 있었다.
    //    떠 있기만 하고 주소를 못 받은 채 멈춘 것이다. 같은 자리에서 새로
    //    띄우면 붙는 것도 확인했다 — 망 문제가 아니라 그 프로세스 문제다.
    //
    //    그동안 사장은 「켰는데 왜 가게가 안 보이지」를 몇 시간씩 겪는다.
    //
    //    🔴 이름으로 싹 죽이지 않는다. **우리 포트를 물고 있는 것만** 고른다 —
    //    남이 자기 일로 켜 둔 cloudflared 를 죽이면 그건 우리가 낸 사고다.
    kill_orphans(port);
    let mut child = Command::new(exe)
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
    let mut reader = BufReader::new(stderr);
    // 🔴 `reader.lines()` 는 reader 를 통째로 가져간다. 그러면 주소를 찾은 뒤
    //    남은 출력을 비울 방법이 없어진다. 한 줄씩 손으로 읽는다.
    let mut line = String::new();
    for _ in 0..80 {
        line.clear();
        match std::io::BufRead::read_line(&mut reader, &mut line) {
            Ok(0) | Err(_) => break,
            Ok(_) => {}
        }
        let line = line.trim_end().to_string();
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

    // 🔴 **파이프를 계속 비워 줘야 한다.**
    //
    //    주소를 찾고 나면 여기서 읽기를 멈췄다. 그런데 cloudflared 는 그 뒤로도
    //    계속 기록을 뱉는다. 아무도 안 읽으면 파이프(64KB)가 차고, 그 순간
    //    cloudflared 가 **멈추거나 죽는다.** 그러면 화면은 「켜짐」인데 주소는
    //    530 이 되고, 앱은 그 죽은 주소를 손님에게 계속 공지한다.
    //
    //    실측으로 갈렸다 — 같은 명령을 터미널에서 돌리면 출력이 파일로 가서
    //    안 막히고 몇 시간이고 산다. 앱이 띄운 것만 죽었다.
    //
    //    버리는 스레드를 하나 둔다. 읽어서 그냥 버린다.
    {
        use std::io::Read;
        if let Some(mut out) = child.stdout.take() {
            std::thread::spawn(move || {
                let mut buf = [0u8; 4096];
                while matches!(out.read(&mut buf), Ok(n) if n > 0) {}
            });
        }
        // stderr 는 위에서 주소를 찾느라 이미 가져갔다. 그 나머지도 계속 비운다.
        let mut rest = reader;
        std::thread::spawn(move || {
            let mut buf = [0u8; 4096];
            while matches!(rest.read(&mut buf), Ok(n) if n > 0) {}
        });
    }

    match found {
        Some(url) => {
            if let Ok(mut g) = URL.lock() {
                *g = Some(url.clone());
            }
            if let Ok(mut g) = CHILD.lock() {
                *g = Some(child);
            }
            // 문이 열렸다고 손님에게 알린다. 이게 없으면 장터에서 이 가게의
            // 주문 버튼이 안 생긴다 — 체인에는 안 바뀌는 것만 적혀 있어서,
            // **지금 어디서 받는지**는 여기서만 나간다.
            announce_now(Some(url.clone()));
            start_heartbeat();
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
    // 🔴 닫았다고도 반드시 알린다. 안 하면 손님이 죽은 주소로 가서 아무것도
    // 안 뜨는 화면을 보고, 「가게가 닫혔다」와 「내 폰이 고장났다」를 구별할
    // 수 없다. 버튼이 없는 편이 정직하다.
    announce_now(None);
    Ok(())
}

/// 지금 가게 주소를 릴레이에 올린다 — **부르는 쪽을 안 세우고.**
///
/// 릴레이 세 곳에 붙는 데 몇 초가 걸린다. 그동안 「바깥에서 열기」 스위치가
/// 멈춰 있으면 사장은 껐다 켰다를 반복하고, 그때마다 터널 주소가 또 바뀐다.
///
/// 가게 이름은 `shop.json` 에서 읽는다. 아직 체인에 등록을 안 했으면 이름이
/// 없고, 그러면 **아무것도 안 한다** — 알릴 간판이 없는 것이지 오류가 아니다.
fn announce_now(url: Option<String>) {
    let asset = std::fs::read_to_string(crate::paths::app_file("shop.json"))
        .ok()
        .and_then(|t| serde_json::from_str::<Value>(&t).ok())
        .and_then(|v| {
            // 🔴 `asset` 이 아니라 `chain_asset` 이다. 앞의 것은 사장이
                // 치는 중인 글자(`GANGNAM_CAFE`)라, 그걸로 공지하면 손님이
                // 찾는 이름(`SHOP.GANGNAM_CAFE`)과 안 맞아 아무도 못 찾는다.
                // 이 칸은 발행 거래가 성공한 뒤에만 채워진다.
                v.get("chain_asset")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_string)
        });
    let Some(asset) = asset else { return };

    tauri::async_runtime::spawn(async move {
        let _ = crate::shopkey::announce(&asset, url.as_deref().unwrap_or("")).await;
    });
}

/// 몇 시간마다 같은 공지를 다시 올린다.
///
/// 🔴 공개 릴레이는 **보관을 약속하지 않는다.** 며칠 지나면 지우는 곳도 있고,
/// 그냥 재시작하면서 잃는 곳도 있다. 한 번만 올리고 마는 가게는 어느 날
/// 조용히 장터에서 사라진다 — 사장은 아무 알림도 못 받는다.
///
/// 🔴 45분이다. 손님 화면은 **두 시간 넘은 공지를 죽은 것으로 본다** — 노드가
/// 닫는다는 인사도 못 하고 그냥 꺼지는 경우(정전·강제종료)를 그렇게 걸러낸다.
/// 이 주기를 늘리면 멀쩡히 장사 중인 가게의 주문 버튼이 손님 화면에서
/// 사라진다. 두 시간의 절반 아래로 유지할 것.
fn start_heartbeat() {
    use std::sync::atomic::Ordering;
    if BEAT.swap(true, Ordering::SeqCst) {
        return;
    }
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(std::time::Duration::from_secs(45 * 60)).await;
            // 그새 문을 닫았으면 아무것도 안 한다. 닫았다는 공지는 `tunnel_stop`
            // 이 이미 올렸고, 여기서 또 올리면 만료 시각만 뒤로 밀린다.
            // 🔴 **죽은 주소를 다시 알리면 안 된다.** 45분마다 도는 이 심장이
            //    터널이 죽은 뒤에도 옛 주소를 계속 공지했다. 살아 있는지 먼저 본다.
            if !tunnel_status()["running"].as_bool().unwrap_or(false) {
                continue;
            }
            let Some(url) = URL.lock().ok().and_then(|g| g.clone()) else {
                continue;
            };
            announce_now(Some(url));
        }
    });
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

    // 🔴 **이 컴퓨터 자신은 바깥이 아니다.** 메뉴판·손님 화면을 브라우저로
    // 열어 보는 것은 사장이 「손님이 뭘 보나」를 확인하는 일이고, 그 주소는
    // 전부 127.0.0.1 이다. 그런데 화이트리스트에 없어서 「이 주소는 열 수
    // 없습니다」로 막혔다 — 자기 컴퓨터를 자기가 못 여는 셈이었다.
    //
    // 127.0.0.1 만 허용한다. 호스트 이름이 아니라 **숫자 주소로만** 본다:
    // `localhost` 를 허용하면 hosts 파일을 고쳐 다른 곳을 가리킬 수 있다.
    let ours = url.starts_with("http://127.0.0.1:8080/ipfs/")
        || url.starts_with("http://127.0.0.1:8790/");
    if !ours && !ALLOWED.iter().any(|p| url.starts_with(p)) {
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

/// cloudflared 를 **우리가 받는다.**
///
/// 🔴 화면에 「터미널에서 `brew install cloudflared`」라고 적어 두는 것은
/// 안내가 아니라 **거절**이다. 이 프로그램의 사장은 70대이고, 터미널을 열어
/// 본 적이 없다. 대표님 지적 그대로다 — "나야 터미널 할 수 있는데 노인들은
/// 모르잖아."
///
/// Cloudflare 가 공식으로 낱개 실행파일을 내놓는다. 받아서 앱 폴더에 두고
/// 실행 권한만 주면 끝이다. brew 도, 관리자 암호도, 터미널도 필요 없다.
///
/// ⚠️ 받는 곳은 GitHub 의 공식 배포다. 다른 곳에서 받으면 그건 우리가
/// 남의 컴퓨터에 낯선 실행파일을 심는 일이 된다.
#[tauri::command]
pub async fn tunnel_install() -> Result<Value, String> {
    if let Some(p) = find_cloudflared() {
        return Ok(json!({ "ok": true, "already": true, "path": p.to_string_lossy() }));
    }

    // 이 컴퓨터에 맞는 파일. 이름을 틀리면 받아 놓고 안 돌아간다.
    let name = match (std::env::consts::OS, std::env::consts::ARCH) {
        ("macos", "aarch64") => "cloudflared-darwin-arm64.tgz",
        ("macos", _) => "cloudflared-darwin-amd64.tgz",
        ("linux", "aarch64") => "cloudflared-linux-arm64",
        ("linux", _) => "cloudflared-linux-amd64",
        ("windows", _) => "cloudflared-windows-amd64.exe",
        _ => return Err("이 컴퓨터에 맞는 파일이 없습니다.".into()),
    };
    let url = format!(
        "https://github.com/cloudflare/cloudflared/releases/latest/download/{name}"
    );

    let client = reqwest::Client::builder()
        // 40MB 안팎이다. 가게 인터넷이 느릴 수 있으니 넉넉히 둔다.
        .timeout(std::time::Duration::from_secs(300))
        .build()
        .map_err(|e| e.to_string())?;
    let body = client
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("받지 못했습니다: {e}"))?
        .error_for_status()
        .map_err(|e| format!("받지 못했습니다: {e}"))?
        .bytes()
        .await
        .map_err(|e| format!("받는 중 끊겼습니다: {e}"))?;

    let dest = crate::paths::app_file("cloudflared");
    if let Some(d) = dest.parent() {
        let _ = std::fs::create_dir_all(d);
    }

    if name.ends_with(".tgz") {
        // 맥 판은 tar.gz 로 온다. 압축 도구는 맥에 기본으로 있다.
        let tmp = crate::paths::app_file("cloudflared.tgz");
        std::fs::write(&tmp, &body).map_err(|e| format!("저장하지 못했습니다: {e}"))?;
        let out = Command::new("/usr/bin/tar")
            .arg("-xzf")
            .arg(&tmp)
            .arg("-C")
            .arg(dest.parent().unwrap_or(std::path::Path::new(".")))
            .output()
            .map_err(|e| format!("압축을 풀지 못했습니다: {e}"))?;
        let _ = std::fs::remove_file(&tmp);
        if !out.status.success() {
            return Err("압축을 풀지 못했습니다.".into());
        }
    } else {
        std::fs::write(&dest, &body).map_err(|e| format!("저장하지 못했습니다: {e}"))?;
    }

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        // 실행 권한이 없으면 받아 놓고 「없습니다」가 그대로 뜬다.
        let _ = std::fs::set_permissions(&dest, std::fs::Permissions::from_mode(0o755));
    }

    // 🔴 받았다고 말하기 전에 **정말 돌아가는지** 확인한다. 반쯤 받힌 파일이
    // 자리에 있으면 그 뒤로 「깔려 있다」고 나오면서 켜지지는 않는다.
    let ok = Command::new(&dest)
        .arg("--version")
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false);
    if !ok {
        let _ = std::fs::remove_file(&dest);
        return Err("받은 파일이 돌아가지 않습니다. 잠시 뒤 다시 눌러 주세요.".into());
    }

    Ok(json!({ "ok": true, "already": false, "path": dest.to_string_lossy() }))
}

#[cfg(test)]
mod alive_tests {
    /// 🔴 **「시작했다」와 「살아 있다」는 다른 일이다.**
    ///
    /// 여태 우리가 띄웠다는 기억만으로 「켜짐」이라 답했다. cloudflared 가
    /// 죽어도 그 기억이 남아, 화면은 초록인데 주소는 530 을 냈고 **앱은 그
    /// 죽은 주소를 릴레이에 계속 공지했다.** QR 을 찍은 손님이 죽은 주소로
    /// 간다 — 실측으로 확인한 사고다.
    #[test]
    fn 살아_있는지_실제로_확인한다() {
        let src = include_str!("tunnel.rs");
        assert!(src.contains("try_wait()"), "프로세스가 살아 있는지 안 본다");
        // 죽었으면 주소도 지워야 한다. 안 지우면 다음 공지에 다시 실린다.
        // 🔴 주석에도 그 낱말이 있어서 첫 번째를 잡으면 엉뚱한 데를 본다.
        //    실제 호출부(`c.try_wait()`)를 찾는다.
        let i = src.find("c.try_wait()").expect("실제로 부르는 자리가 없다");
        let after: String = src[i..].chars().take(400).collect();
        assert!(after.contains("URL.lock()"), "죽은 뒤 주소를 안 지운다");
    }

    /// 다시 알리는 심장이 죽은 주소를 뿌리면 안 된다.
    /// 🔴 **파이프를 안 비우면 cloudflared 가 죽는다.**
    ///
    /// 주소를 찾은 뒤 읽기를 멈추면 파이프(64KB)가 차고, 그 순간 cloudflared
    /// 가 멈추거나 죽는다. 실측으로 갈렸다 — 같은 명령을 터미널에서 돌리면
    /// 출력이 파일로 가서 안 막히고 몇 시간이고 살았다. 앱이 띄운 것만 죽었다.
    #[test]
    fn 출력_파이프를_계속_비운다() {
        // 🔴 예전엔 함수 시작 뒤 **3,000자만** 봤다. 그 앞에 코드나 주석이
        //    조금만 늘어도(실제로 유령 정리를 넣자 그랬다) 뒷부분이 창 밖으로
        //    밀려나 **멀쩡한 코드를 없다고 말한다.** 시험이 무르면 고칠 것도
        //    없는데 사람을 붙잡는다. 함수 **전체**를 본다.
        let src = include_str!("tunnel.rs");
        let i = src.find("pub fn tunnel_start").expect("시작 함수가 있어야 한다");
        let end = src[i..].find("\n}").map(|k| i + k + 2).unwrap_or(src.len());
        let body: String = src[i..end].to_string();
        assert!(body.contains("child.stdout.take()"), "stdout 을 안 비운다");
        assert!(
            body.matches("thread::spawn").count() >= 2,
            "stdout·stderr 둘 다 비워야 한다"
        );
    }

    #[test]
    fn 심장은_살아_있을_때만_알린다() {
        let src = include_str!("tunnel.rs");
        let i = src.find("fn start_heartbeat").expect("심장이 있어야 한다");
        let body: String = src[i..].chars().take(1200).collect();
        assert!(body.contains("tunnel_status()"), "심장이 살아 있는지 안 보고 알린다");
    }
}

#[cfg(test)]
mod orphan_tests {
    use super::is_our_orphan;

    /// 🔴 죽이는 판단이다. 여기가 무르면 **남이 자기 일로 켜 둔 터널**을
    ///    우리가 죽인다. 그건 우리가 낸 사고다.
    #[test]
    fn 남의_터널은_안_죽인다() {
        let want = "http://127.0.0.1:8790";
        // 다른 포트 — 남의 일이다
        assert!(!is_our_orphan("101 cloudflared tunnel --url http://127.0.0.1:3000", want));
        // 이름 있는 터널 — 남의 도메인이다
        assert!(!is_our_orphan("102 cloudflared tunnel run mysite", want));
        // 아예 다른 프로그램
        assert!(!is_our_orphan("103 node server.js", want));
        assert!(!is_our_orphan("", want));
    }

    #[test]
    fn 우리_것은_잡는다() {
        let want = "http://127.0.0.1:8790";
        assert!(is_our_orphan(
            " 36756 /opt/homebrew/bin/cloudflared tunnel --url http://127.0.0.1:8790 --no-autoupdate",
            want
        ));
    }

    /// 우리가 방금 돌린 `ps` 자신을 잡으면 우스운 일이 된다.
    #[test]
    fn ps_자기자신은_거른다() {
        assert!(!is_our_orphan(
            "999 ps -axo pid=,command= cloudflared http://127.0.0.1:8790",
            "http://127.0.0.1:8790"
        ));
    }
}
