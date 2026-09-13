//! Validate a user-selected AI destination before saving AND before every request.
//! This module has no filesystem, key access, network, or provider fallback.
use std::net::IpAddr;

pub(crate) fn local_host(host: &str) -> bool {
    if host == "localhost" {
        return true;
    }
    match host.trim_matches(['[', ']']).parse::<IpAddr>() {
        Ok(IpAddr::V4(ip)) => ip.is_loopback() || ip.is_private(),
        Ok(IpAddr::V6(ip)) => ip.is_loopback() || ip.is_unique_local(),
        _ => false,
    }
}

pub(crate) fn validate(base: &str, model: &str, key: &str) -> Result<String, String> {
    if base.len() > 2048 || base.chars().any(char::is_control) {
        return Err("AI 주소를 다시 입력하세요. HTTPS 또는 로컬 HTTP 주소를 사용하세요.".into());
    }
    if model.trim().is_empty() || model.len() > 200 || model.chars().any(char::is_control) {
        return Err("AI 서버에 설치된 모델 이름을 입력하세요.".into());
    }
    if key.len() > 4096 || key.chars().any(char::is_control) {
        return Err("API 키를 줄바꿈 없이 다시 입력하세요.".into());
    }
    let url = reqwest::Url::parse(base.trim()).map_err(|_| {
        "AI 주소를 다시 입력하세요. HTTPS 또는 로컬 HTTP 주소를 사용하세요.".to_string()
    })?;
    if !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || url.host_str().is_none()
        || url.port() == Some(0)
    {
        return Err("AI 주소에서 아이디·비밀번호·물음표 뒤 값을 빼고 다시 저장하세요.".into());
    }
    match url.scheme() {
        "https" => {}
        "http" if local_host(url.host_str().unwrap_or_default()) && key.trim().is_empty() => {}
        _ => {
            return Err(
                "HTTP는 로컬·사설망의 키 없는 AI만 사용할 수 있습니다. 원격 AI는 HTTPS로 바꾸세요."
                    .into(),
            )
        }
    }
    Ok(url.to_string().trim_end_matches('/').to_string())
}

pub(crate) fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(std::time::Duration::from_secs(15))
        .timeout(std::time::Duration::from_secs(120))
        .build()
        .map_err(|_| "AI 연결을 준비하지 못했습니다. 앱을 다시 열어 주세요.".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn local_keyless_and_remote_https_are_explicit_destinations() {
        for base in [
            "http://127.0.0.1:11434/v1/",
            "http://localhost:11434/v1",
            "http://192.168.1.12:8000/v1",
            "http://[::1]:11434/v1",
        ] {
            assert!(validate(base, "synthetic-model", "").is_ok(), "{base}");
            assert!(
                validate(base, "synthetic-model", "synthetic-key").is_err(),
                "{base}"
            );
        }
        assert_eq!(
            validate("https://example.test/v1/", "model", "synthetic-key").unwrap(),
            "https://example.test/v1"
        );
    }
    #[test]
    fn remote_plaintext_and_url_credentials_are_refused() {
        for base in [
            "http://example.test/v1",
            "http://127.0.0.1.evil.test/v1",
            "http://169.254.169.254/v1",
            "https://user:pass@example.test/v1",
            "https://example.test/v1?key=synthetic",
            "https://example.test/v1#key",
            "file:///tmp/model",
            "https://example.test:0/v1",
        ] {
            assert!(validate(base, "synthetic", "").is_err(), "{base}");
        }
        assert!(validate("https://example.test/v1", "", "").is_err());
        assert!(validate("https://example.test/v1", "model", "synthetic\nkey").is_err());
    }
    #[tokio::test]
    async fn redirects_cannot_forward_a_question_to_another_destination() {
        use std::io::{Read, Write};
        let socket = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = socket.local_addr().unwrap();
        let server = std::thread::spawn(move || {
            let (mut connection, _) = socket.accept().unwrap();
            connection
                .set_read_timeout(Some(std::time::Duration::from_secs(5)))
                .unwrap();
            let mut request = [0u8; 2048];
            connection.read(&mut request).unwrap();
            write!(connection, "HTTP/1.1 307 Temporary Redirect\r\nLocation: http://{address}/redirected\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").unwrap();
            drop(connection);
            socket.set_nonblocking(true).unwrap();
            let deadline = std::time::Instant::now() + std::time::Duration::from_millis(300);
            while std::time::Instant::now() < deadline {
                if let Ok((mut extra, _)) = socket.accept() {
                    let _ = extra.write_all(
                        b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}",
                    );
                    return false;
                }
                std::thread::sleep(std::time::Duration::from_millis(10));
            }
            true
        });
        let response = client()
            .unwrap()
            .post(format!("http://{address}/v1/chat/completions"))
            .body("synthetic question only")
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), reqwest::StatusCode::TEMPORARY_REDIRECT);
        assert!(
            server.join().unwrap(),
            "The redirected endpoint must never receive a request"
        );
    }
}
