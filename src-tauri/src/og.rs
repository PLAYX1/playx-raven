//! 공유 링크 미리보기(카톡·텔레그램 카드) — 손님 화면 HTML 에 가게 이름·설명·사진을 넣는다.
//!
//! 🔴 카톡·텔레그램의 미리보기 로봇은 **스크립트를 돌리지 않는다.** 화면이 나중에 그리는
//!    가게 이름은 못 보고, HTML 에 처음부터 박혀 있는 `og:` 태그만 읽는다. 그래서 가게 컴퓨터가
//!    페이지를 내줄 때 그 자리에서 채운다(RV7 §16.5).
//!
//! - 그림은 **가게가 가진 사진만** 쓴다(가게 간판 CID → 이 컴퓨터의 `/ipfs/` 중계). 남의 서버
//!   그림(예전 `rvn.ex.erci.se/og-raven.png`)은 쓰지 않는다. 사진이 없으면 그림 태그를 빼고
//!   작은 카드(`summary`)로 둔다.
//! - 가게 이름·설명은 **체인에서 온 남의 글자**다. 속성 값에 넣기 전에 전부 이스케이프한다.
//! - 절대 주소가 필요하다(미리보기 로봇은 상대 주소를 못 푼다). 고정·임시 터널 주소가 있으면
//!   그것, 없으면 요청의 Host 를 쓴다. Host 는 글자를 엄격히 거른다(머리 주입 방지).
//!
//! HTML 쪽 약속: `<!--og-->` … `<!--/og-->` 사이를 통째로 갈아 끼운다. 표시가 없으면 손대지 않는다.

use serde_json::Value;

const OPEN: &str = "<!--og-->";
const CLOSE: &str = "<!--/og-->";

/// 속성 값용 이스케이프. 줄바꿈도 공백으로 편다(카드에서 깨진다).
pub fn attr(s: &str) -> String {
    let mut o = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '&' => o.push_str("&amp;"),
            '<' => o.push_str("&lt;"),
            '>' => o.push_str("&gt;"),
            '"' => o.push_str("&quot;"),
            '\'' => o.push_str("&#39;"),
            '\n' | '\r' | '\t' => o.push(' '),
            c if c.is_control() => {}
            c => o.push(c),
        }
    }
    o
}

/// 글자 수로 자른다(바이트가 아니라). 카드 설명은 길면 잘려 보인다.
fn clip(s: &str, n: usize) -> String {
    let t = s.trim();
    if t.chars().count() <= n {
        return t.to_string();
    }
    let mut o: String = t.chars().take(n).collect();
    o.push('…');
    o
}

/// 미리보기용 바깥 주소. `https://가게.example` 꼴, 끝 `/` 없음. 이상하면 None.
pub fn base_from(tunnel: Option<&str>, host: Option<&str>, proto: Option<&str>) -> Option<String> {
    if let Some(t) = tunnel {
        let t = t.trim().trim_end_matches('/');
        if (t.starts_with("https://") || t.starts_with("http://")) && host_ok(t.split("://").nth(1).unwrap_or("")) {
            return Some(t.to_string());
        }
    }
    let h = host?.trim();
    if !host_ok(h) {
        return None;
    }
    let local = h.starts_with("localhost") || h.starts_with("127.") || h.starts_with("192.168.") || h.starts_with("10.");
    let scheme = match proto.map(|p| p.trim().to_ascii_lowercase()) {
        Some(p) if p == "https" => "https",
        Some(p) if p == "http" => "http",
        _ if local => "http",
        _ => "https",
    };
    Some(format!("{scheme}://{h}"))
}

fn host_ok(h: &str) -> bool {
    !h.is_empty()
        && h.len() <= 253
        && h.chars().all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-' || c == ':')
}

/// 가게 간판 → 이 컴퓨터가 내주는 사진 경로. CID(v0) 와 `Qm…/파일이름` 만. 바깥 주소·data: 는 안 쓴다.
pub fn shop_photo_path(icon: &str) -> Option<String> {
    let ic = icon.trim();
    let (cid, rest) = match ic.split_once('/') {
        Some((c, r)) => (c, Some(r)),
        None => (ic, None),
    };
    if !cid_v0(cid) {
        return None;
    }
    match rest {
        None => Some(format!("/ipfs/{cid}")),
        Some(r) if !r.is_empty() && r.len() <= 40 && r.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '.' || c == '-') && !r.contains("..") => {
            Some(format!("/ipfs/{cid}/{r}"))
        }
        _ => None,
    }
}

fn cid_v0(s: &str) -> bool {
    s.len() == 46
        && s.starts_with("Qm")
        && s.chars().all(|c| c.is_ascii_alphanumeric() && !matches!(c, '0' | 'O' | 'I' | 'l'))
}

/// 카드 태그 묶음.
pub fn tags(title: &str, desc: &str, image: Option<&str>, url: Option<&str>) -> String {
    let mut o = String::new();
    o.push_str("<meta property=\"og:type\" content=\"website\" />\n");
    o.push_str(&format!("    <meta property=\"og:title\" content=\"{}\" />\n", attr(&clip(title, 60))));
    o.push_str(&format!("    <meta property=\"og:description\" content=\"{}\" />\n", attr(&clip(desc, 110))));
    o.push_str(&format!("    <meta name=\"description\" content=\"{}\" />\n", attr(&clip(desc, 110))));
    if let Some(u) = url {
        o.push_str(&format!("    <meta property=\"og:url\" content=\"{}\" />\n", attr(u)));
    }
    match image {
        Some(i) => {
            o.push_str(&format!("    <meta property=\"og:image\" content=\"{}\" />\n", attr(i)));
            o.push_str("    <meta name=\"twitter:card\" content=\"summary_large_image\" />\n    ");
        }
        None => o.push_str("    <meta name=\"twitter:card\" content=\"summary\" />\n    "),
    }
    o
}

/// `<!--og-->…<!--/og-->` 를 갈아 끼우고 `<title>` 도 맞춘다.
pub fn inject(html: &str, title: &str, block: &str) -> String {
    let mut out = match (html.find(OPEN), html.find(CLOSE)) {
        (Some(a), Some(b)) if a < b => format!("{}{OPEN}{block}{}", &html[..a], &html[b..]),
        _ => html.to_string(),
    };
    let t = title.trim();
    if !t.is_empty() {
        if let (Some(a), Some(b)) = (out.find("<title>"), out.find("</title>")) {
            if a < b {
                out = format!("{}<title>{}{}", &out[..a], attr(&clip(t, 60)), &out[b..]);
            }
        }
    }
    out
}

/// 손님 주문 화면(`/`). `shop` 은 가게 문서(이름·설명·간판).
pub fn customer(html: &str, shop: &Value, base: Option<&str>, path_q: &str) -> String {
    let name = shop.get("name").and_then(Value::as_str).unwrap_or("").trim();
    if name.is_empty() {
        return html.to_string(); // 가게가 아직 없다 — 기본 카드 그대로
    }
    let desc = shop.get("description").and_then(Value::as_str).unwrap_or("").trim();
    let desc = if desc.is_empty() { "주문·예약 · 레이븐코인 결제" } else { desc };
    let image = base.and_then(|b| {
        shop.get("icon").and_then(Value::as_str).and_then(shop_photo_path).map(|p| format!("{b}{p}"))
    });
    let url = base.map(|b| format!("{b}{}", safe_path_q(path_q)));
    inject(html, name, &tags(name, desc, image.as_deref(), url.as_deref()))
}

/// 물건 사기 화면(`/buy?id=`). `offer` 는 그 판매 한 건(자산 이름·가게·사진 CID).
pub fn buy(html: &str, offer: Option<&Value>, base: Option<&str>, path_q: &str) -> String {
    let Some(o) = offer else { return html.to_string() };
    let asset = o.get("asset").and_then(Value::as_str).unwrap_or("").trim();
    if asset.is_empty() {
        return html.to_string();
    }
    let qty = o.get("qty").and_then(Value::as_i64).unwrap_or(1);
    let title = if qty > 1 { format!("{qty} × {asset}") } else { asset.to_string() };
    let shop = o.get("shop").and_then(Value::as_str).unwrap_or("").trim();
    let desc = if shop.is_empty() { "레이븐코인으로 바로 삽니다.".to_string() } else { format!("{shop} · 레이븐코인으로 바로 삽니다.") };
    let image = base.and_then(|b| {
        o.get("image").and_then(Value::as_str).filter(|c| cid_v0(c)).map(|c| format!("{b}/ipfs/{c}"))
    });
    let url = base.map(|b| format!("{b}{}", safe_path_q(path_q)));
    inject(html, &title, &tags(&title, &desc, image.as_deref(), url.as_deref()))
}

/// 요청 경로+쿼리를 og:url 에 넣을 수 있는 글자만 남긴다.
fn safe_path_q(p: &str) -> String {
    let p: String = p
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || "/?=&-_.~%".contains(*c))
        .take(200)
        .collect();
    if p.starts_with('/') { p } else { "/".into() }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const CID: &str = "QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG";

    #[test]
    fn customer_html_has_the_marker_and_no_outside_image() {
        let src = include_str!("../../web/customer.html");
        assert!(src.contains(OPEN) && src.contains(CLOSE), "손님 화면에 og 자리표시가 없다");
        assert!(!src.contains("rvn.ex.erci.se/og-raven.png"), "미리보기 그림이 남의 서버를 가리킨다");
        let buy = include_str!("../../web/buy.html");
        assert!(buy.contains(OPEN) && buy.contains(CLOSE), "구매 화면에 og 자리표시가 없다");
        assert!(!buy.contains("rvn.ex.erci.se/og-raven.png"));
    }

    #[test]
    fn shop_name_photo_and_url_go_into_the_card() {
        let src = include_str!("../../web/customer.html");
        let shop = json!({ "name": "리리네 \"과일\" <가게>", "description": "샤인머스캣 공동구매", "icon": format!("{CID}/icon.jpg") });
        let out = customer(src, &shop, Some("https://shop.example.com"), "/?table=3");
        assert!(out.contains("og:title\" content=\"리리네 &quot;과일&quot; &lt;가게&gt;\""));
        assert!(out.contains(&format!("og:image\" content=\"https://shop.example.com/ipfs/{CID}/icon.jpg\"")));
        assert!(out.contains("og:url\" content=\"https://shop.example.com/?table=3\""));
        assert!(out.contains("<title>리리네 &quot;과일&quot; &lt;가게&gt;</title>"));
        assert!(!out.contains("<가게>"), "남의 글자가 그대로 들어갔다");
        assert_eq!(out.matches("og:title").count(), 1, "카드 태그가 두 벌이다");
    }

    #[test]
    fn outside_or_bad_photos_are_dropped() {
        assert!(shop_photo_path("https://evil.example/x.png").is_none());
        assert!(shop_photo_path("data:image/png;base64,AAAA").is_none());
        assert!(shop_photo_path(&format!("{CID}/../../etc")).is_none());
        assert!(shop_photo_path(&format!("{CID}/a\"b.png")).is_none());
        let src = include_str!("../../web/customer.html");
        let out = customer(src, &json!({ "name": "가게", "icon": "https://evil.example/x.png" }), Some("https://s.example"), "/");
        assert!(!out.contains("og:image"), "가게 사진이 없으면 그림 태그를 빼야 한다");
        assert!(out.contains("twitter:card\" content=\"summary\""));
    }

    #[test]
    fn host_header_is_filtered() {
        assert_eq!(base_from(None, Some("shop.example.com"), Some("https")).as_deref(), Some("https://shop.example.com"));
        assert_eq!(base_from(None, Some("192.168.0.5:8790"), None).as_deref(), Some("http://192.168.0.5:8790"));
        assert!(base_from(None, Some("evil.com\"><script>"), None).is_none());
        assert!(base_from(None, Some("a b"), None).is_none());
        assert_eq!(base_from(Some("https://x.trycloudflare.com/"), Some("127.0.0.1:8790"), None).as_deref(), Some("https://x.trycloudflare.com"));
    }

    #[test]
    fn no_shop_keeps_the_default_card() {
        let src = include_str!("../../web/customer.html");
        assert_eq!(customer(src, &json!({}), Some("https://s.example"), "/"), src);
    }

    #[test]
    fn buy_card_uses_the_offer() {
        let src = include_str!("../../web/buy.html");
        let o = json!({ "asset": "PLAYX/TICKET", "qty": 2, "shop": "플레이엑스", "image": CID, "gateway": "https://ipfs.io" });
        let out = buy(src, Some(&o), Some("https://s.example"), "/buy?id=abc");
        assert!(out.contains("og:title\" content=\"2 × PLAYX/TICKET\""));
        assert!(out.contains(&format!("https://s.example/ipfs/{CID}")), "사진은 가게 컴퓨터에서");
        assert!(!out.contains("ipfs.io"), "바깥 게이트웨이를 카드에 쓰면 안 된다");
        assert_eq!(buy(src, None, Some("https://s.example"), "/buy"), src);
    }
}
