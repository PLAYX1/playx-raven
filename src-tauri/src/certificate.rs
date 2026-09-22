//! 「만들기」 증명서를 **진짜 문서**로 — A4 한 장에 한 사람, 인쇄하거나 PDF로.
//!
//! ## 무엇이 들어가나
//!
//! 제목(사람이 적은 말 그대로) · 받는 사람 · 발급일 · 발급자 · 증서 번호(체인 이름) ·
//! 확인 QR · 원본 지문 · 확인하는 법 한 줄. 양식은 셋 — 수료증·증명서·감사장.
//!
//! ## 🔴 받는 사람 이름은 여기에만 있다
//!
//! 체인에는 로마자 제목에서 만든 이름만 나가고, 확인 QR 도 `?a=체인이름` 뿐이다.
//! 받는 사람·발급자·설명은 **이 종이와 이 컴퓨터의 기록(`create_history.rs`)에만**
//! 있다. 그래서 인쇄 파일도 앱 자료 폴더 안(0700)에 0600 으로 만든다 —
//! 바탕화면에 두면 클라우드 동기화(iCloud 「데스크탑 및 문서」·OneDrive)가
//! 회원 이름이 든 파일을 밖으로 가져간다. `backup.rs` 가 동기화 폴더를 따로
//! 가려 보는 것과 같은 이유다.
//!
//! ## 왜 `window.print()` 가 아닌가
//!
//! `recover.rs` 의 복구 카드와 같다 — 이 창(WKWebView)은 `print()` 를 조용히
//! 무시한다. 그래서 파일을 만들어 기본 브라우저로 연다. 거기서는 ⌘P 가 되고,
//! 인쇄 창에서 「PDF로 저장」을 고를 수 있다.
//!
//! ## 인터넷 없이
//!
//! 글꼴은 이 컴퓨터에 있는 것만, QR 은 SVG 로 파일 안에 굽는다. 바깥 주소는
//! 하나도 안 부른다(`ipfs.io` 같은 절대 주소 포함) — 확인 링크는 QR 과 글자로만 있다.

use serde_json::{json, Value};
use std::path::PathBuf;

const CSS: &str = include_str!("certificate.css");
pub const VERIFY_URL: &str = "https://ravenvault.ex.erci.se/verify/";

fn esc(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&#39;"),
            _ => out.push(c),
        }
    }
    out
}

/// 자바스크립트 `encodeURIComponent` 와 같게 — 확인 페이지가 같은 주소를 받는다.
fn encode_component(s: &str) -> String {
    let mut out = String::new();
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&b) {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

/// 확인 페이지 주소. `/verify` 는 `a` 하나만 받는다(release-site/landing/verify.js).
pub fn verify_link(name: &str) -> String {
    format!("{VERIFY_URL}?a={}", encode_component(name))
}

fn qr_svg(text: &str) -> String {
    use qrcode::{render::svg, EcLevel, QrCode};
    let Ok(code) = QrCode::with_error_correction_level(text.as_bytes(), EcLevel::M) else {
        return String::new();
    };
    let s = code
        .render::<svg::Color>()
        .quiet_zone(false)
        .dark_color(svg::Color("#111111"))
        .light_color(svg::Color("#ffffff"))
        .build();
    // XML 머리말은 HTML 안에서 쓸모가 없다.
    match s.find("<svg") {
        // HTML 안의 SVG 에는 xmlns 가 필요 없다 — 인쇄 파일에 바깥 주소처럼 보이는 글자를 남기지 않는다.
        Some(i) => s[i..]
            .replacen(r#" xmlns="http://www.w3.org/2000/svg""#, "", 1)
            .replacen("<svg ", r#"<svg role="img" aria-label="QR" "#, 1),
        None => String::new(),
    }
}

/* ── 말 ────────────────────────────────────────────────────────────── */

#[derive(Clone, Copy, PartialEq)]
enum Lang {
    Ko,
    En,
    Ja,
    Zh,
}

impl Lang {
    fn from(s: &str) -> Lang {
        match s {
            "en" => Lang::En,
            "ja" => Lang::Ja,
            "zh" => Lang::Zh,
            _ => Lang::Ko,
        }
    }
    fn code(self) -> &'static str {
        match self {
            Lang::Ko => "ko",
            Lang::En => "en",
            Lang::Ja => "ja",
            Lang::Zh => "zh",
        }
    }
    fn pick(self, [ko, en, ja, zh]: [&'static str; 4]) -> &'static str {
        match self {
            Lang::Ko => ko,
            Lang::En => en,
            Lang::Ja => ja,
            Lang::Zh => zh,
        }
    }
}

struct Words {
    recipient: &'static str,
    date: &'static str,
    issuer: &'static str,
    signature: &'static str,
    number: &'static str,
    fingerprint: &'static str,
    how: &'static str,
    how_file: &'static str,
    bar: &'static str,
    print: &'static str,
    pages: &'static str,
}

fn words(l: Lang) -> Words {
    Words {
        recipient: l.pick(["받는 사람", "Presented to", "氏名", "姓名"]),
        date: l.pick(["발급일", "Date of issue", "発行日", "签发日期"]),
        issuer: l.pick(["발급자", "Issued by", "発行者", "签发方"]),
        signature: l.pick(["서명", "Signature", "署名", "签名"]),
        number: l.pick(["증서 번호", "Certificate No.", "証書番号", "证书编号"]),
        fingerprint: l.pick(["원본 지문", "Original fingerprint", "原本の指紋", "原件指纹"]),
        how: l.pick([
            "휴대폰 카메라로 QR을 찍거나 ravenvault.ex.erci.se/verify 에 증서 번호를 넣으면 누구나 진짜인지 확인할 수 있어요.",
            "Scan the QR code, or enter the certificate number at ravenvault.ex.erci.se/verify, to check that it is genuine.",
            "QRコードを読み取るか、ravenvault.ex.erci.se/verify に証書番号を入力すると、誰でも本物か確認できます。",
            "扫描二维码，或在 ravenvault.ex.erci.se/verify 输入证书编号，任何人都可以核实真伪。",
        ]),
        how_file: l.pick([
            "원본 파일을 함께 넣으면 지문이 같은지도 볼 수 있어요.",
            "Add the original file there to compare its fingerprint.",
            "原本ファイルを入れると、指紋が一致するかも確認できます。",
            "同时放入原件文件，还可以比对指纹是否一致。",
        ]),
        bar: l.pick([
            "인쇄하거나 PDF로 저장하려면 <b>⌘P</b>(윈도우는 <b>Ctrl+P</b>)를 누르세요. 이 안내 줄은 인쇄되지 않아요.",
            "To print or save as PDF, press <b>⌘P</b> (<b>Ctrl+P</b> on Windows). This bar is not printed.",
            "印刷またはPDF保存は <b>⌘P</b>（Windowsは <b>Ctrl+P</b>）。この案内は印刷されません。",
            "按 <b>⌘P</b>（Windows 为 <b>Ctrl+P</b>）即可打印或另存为 PDF。此提示不会被打印。",
        ]),
        print: l.pick(["인쇄 · PDF로 저장", "Print · Save as PDF", "印刷・PDF保存", "打印 · 存为 PDF"]),
        pages: l.pick(["{0}장", "{0} pages", "{0}枚", "{0} 张"]),
    }
}

/// 양식마다 윗줄 한 마디와, 설명을 비워 뒀을 때 들어갈 문장.
fn template_words(template: &str, kind: &str, l: Lang) -> (&'static str, &'static str) {
    if kind == "work" {
        return (
            "Certificate of Authenticity",
            l.pick([
                "위 작품이 원본임을 증명합니다. 증서 번호마다 한 점뿐이에요.",
                "This certifies that the work above is an original. Each certificate number exists only once.",
                "上記の作品が原本であることを証明します。証書番号ごとに一点のみです。",
                "兹证明上述作品为原作。每个证书编号仅对应一件。",
            ]),
        );
    }
    match template {
        "proof" => (
            "Certificate",
            l.pick([
                "위 사람이 위 내용을 갖추었음을 증명합니다.",
                "This certifies that the person named above meets the requirements stated.",
                "上記の者が上記の内容を満たしていることを証明します。",
                "兹证明上述人员符合上述内容。",
            ]),
        ),
        "thanks" => (
            "Letter of Appreciation",
            l.pick([
                "보내 주신 마음과 수고에 깊이 감사드리며 이 글을 드립니다.",
                "With sincere thanks for your kindness and dedication.",
                "日頃のご厚意とご尽力に深く感謝し、ここに感謝の意を表します。",
                "衷心感谢您的付出与支持，特此致谢。",
            ]),
        ),
        _ => (
            "Certificate of Completion",
            l.pick([
                "위 사람은 위 과정을 성실히 마쳤기에 이 증서를 드립니다.",
                "This certifies that the person named above has successfully completed the course.",
                "上記の者は本課程を修了したことをここに証します。",
                "兹证明上述人员已圆满完成本课程。",
            ]),
        ),
    }
}

fn format_date(ymd: &str, l: Lang) -> String {
    let parts: Vec<u32> = ymd.split('-').filter_map(|p| p.parse().ok()).collect();
    let [y, m, d] = parts[..] else { return esc(ymd) };
    const MONTHS: [&str; 12] = [
        "January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December",
    ];
    match l {
        Lang::Ko => format!("{y}년 {m}월 {d}일"),
        Lang::En => format!("{} {d}, {y}", MONTHS.get(m as usize - 1).copied().unwrap_or("")),
        Lang::Ja | Lang::Zh => format!("{y}年{m}月{d}日"),
    }
}

/* ── 장식 ─────────────────────────────────────────────────────────── */

/// 월계관. 잎을 원을 따라 두 줄로 세운다 — 그림 파일 없이 SVG 한 조각.
fn laurel() -> String {
    let (cx, cy, r) = (60.0f64, 36.0f64, 27.0f64);
    let mut leaves = String::new();
    for side in [-1.0f64, 1.0] {
        for i in 0..8 {
            // 아래(90°)에서 위로 올라가며 좌우 대칭.
            let deg = 104.0 + i as f64 * 17.5;
            let theta = if side < 0.0 { deg } else { 180.0 - deg };
            let rad = theta.to_radians();
            for (k, off) in [(0, -3.6f64), (1, 3.6f64)] {
                let x = cx + (r + off) * rad.cos();
                let y = cy + (r + off) * rad.sin();
                let tilt = if k == 0 { -24.0 } else { 24.0 } * side;
                let rot = theta + if side < 0.0 { 0.0 } else { 180.0 } + tilt;
                let size = 1.0 - i as f64 * 0.045;
                leaves.push_str(&format!(
                    r#"<ellipse cx="{x:.2}" cy="{y:.2}" rx="{:.2}" ry="{:.2}" transform="rotate({rot:.1} {x:.2} {y:.2})"/>"#,
                    2.3 * size,
                    5.6 * size
                ));
            }
        }
    }
    let arc = |a0: f64, a1: f64| {
        let (x0, y0) = (cx + r * a0.to_radians().cos(), cy + r * a0.to_radians().sin());
        let (x1, y1) = (cx + r * a1.to_radians().cos(), cy + r * a1.to_radians().sin());
        format!(r#"<path d="M{x0:.2} {y0:.2} A{r} {r} 0 0 1 {x1:.2} {y1:.2}" fill="none" stroke="currentColor" stroke-width=".7"/>"#)
    };
    format!(
        r#"<svg viewBox="0 0 120 72" width="38mm" height="22.8mm" aria-hidden="true"><g fill="currentColor">{leaves}</g>{}{}<circle cx="60" cy="{:.1}" r="1.6" fill="currentColor"/></svg>"#,
        arc(98.0, 232.0),
        arc(-52.0, 82.0),
        cy + r + 1.0
    )
}

/// 인증 표시 — 두 겹 원과 체크.
fn badge() -> String {
    r#"<svg viewBox="0 0 48 48" width="15mm" height="15mm" aria-hidden="true"><circle cx="24" cy="24" r="22" fill="none" stroke="currentColor" stroke-width="1.6"/><circle cx="24" cy="24" r="17.5" fill="none" stroke="currentColor" stroke-width=".7" stroke-dasharray="1.4 1.6"/><path d="M15.5 24.5l6 6 11-12" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg>"#.into()
}

/// 감사장 장식 — 가는 꽃줄 한 가닥.
fn flourish() -> String {
    r#"<svg viewBox="0 0 160 24" width="48mm" height="7.2mm" aria-hidden="true" fill="none" stroke="currentColor" stroke-width=".9" stroke-linecap="round"><path d="M6 12c18 0 26-9 40-9s18 9 34 9"/><path d="M154 12c-18 0-26-9-40-9s-18 9-34 9"/><path d="M40 12c10 0 16 7 26 7" stroke-width=".6"/><path d="M120 12c-10 0-16 7-26 7" stroke-width=".6"/><path d="M80 5.5l4.5 6.5-4.5 6.5-4.5-6.5z" fill="currentColor" stroke="none"/></svg>"#.into()
}

/* ── 한 장 ─────────────────────────────────────────────────────────── */

fn size_class(s: &str, long: usize, xlong: usize) -> &'static str {
    let n = s.chars().count();
    if n > xlong {
        " xlong"
    } else if n > long {
        " long"
    } else {
        ""
    }
}

fn str_of<'a>(v: &'a Value, key: &str) -> &'a str {
    v.get(key).and_then(Value::as_str).unwrap_or("")
}

fn sheet(entry: &Value, template: &str, l: Lang, name: &str, recipient: &str) -> String {
    let w = words(l);
    let kind = str_of(entry, "kind");
    let (eyebrow, default_body) = template_words(template, kind, l);
    let title = match str_of(entry, "display_title") {
        "" => str_of(entry, "title"),
        t => t,
    };
    let body = match str_of(entry, "description") {
        "" => default_body,
        d => d,
    };
    let emblem = match template {
        "proof" => badge(),
        "thanks" => flourish(),
        _ => laurel(),
    };
    let issued = str_of(entry, "issued_on");
    let issuer = str_of(entry, "issuer");
    let signer = str_of(entry, "signer");
    let fp = str_of(entry, "fingerprint");
    let name_html = if recipient.is_empty() {
        r#"<span class="blank"></span>"#.to_string()
    } else {
        esc(recipient)
    };
    let date = if issued.is_empty() { String::new() } else { format_date(issued, l) };
    let none = |empty: bool| if empty { " none" } else { "" };
    format!(
        r#"<section class="sheet"><div class="frame" aria-hidden="true"><i></i><i></i><i></i><i></i></div><div class="inner">
<div class="emblem">{emblem}</div>
<p class="eyebrow">{eyebrow}</p>
<h1 class="title{title_cls}">{title}</h1>
<div class="rule" aria-hidden="true"></div>
<div class="who"><span class="label">{l_rec}</span><p class="name{name_cls}">{name_html}</p></div>
<p class="body">{body}</p>
<div class="sign">
<div class="date{date_none}"><span class="label">{l_date}</span><span>{date}</span></div>
<div class="issuer-box{issuer_none}"><span class="label">{l_issuer}</span><span class="issuer">{issuer}</span></div>
<div class="sig{sig_none}"><span>{signer}</span><span class="sig-line"></span><span class="label">{l_sig}</span></div>
</div>
<footer class="proof"><div class="qr">{qr}</div><div><dl><dt>{l_num}</dt><dd>{number}</dd><dt class="fpk{fp_none}">{l_fp}</dt><dd class="fp{fp_none}">{fp}</dd></dl>
<p class="how">{how}{how_file}</p></div></footer>
</div></section>"#,
        title_cls = size_class(title, 22, 40),
        title = esc(title),
        eyebrow = esc(eyebrow),
        l_rec = if kind == "work" { l.pick(["소장하는 분", "Owner", "所蔵者", "收藏者"]) } else { w.recipient },
        name_cls = size_class(recipient, 16, 60),
        body = esc(body),
        date_none = none(date.is_empty()),
        l_date = w.date,
        issuer_none = none(issuer.is_empty()),
        l_issuer = w.issuer,
        issuer = esc(issuer),
        sig_none = none(signer.is_empty()),
        signer = esc(signer),
        l_sig = w.signature,
        qr = qr_svg(&verify_link(name)),
        l_num = w.number,
        number = esc(name),
        fp_none = none(fp.is_empty()),
        l_fp = w.fingerprint,
        fp = esc(fp),
        how = w.how,
        how_file = if fp.is_empty() { String::new() } else { format!(" {}", w.how_file) },
    )
}

/// 문서 전체. `preview` 면 첫 장만, 안내 줄 없이(앱 안 미리보기용).
pub fn render(entry: &Value, lang: &str, preview: bool) -> Result<String, String> {
    let kind = str_of(entry, "kind");
    if !matches!(kind, "certificate" | "work") {
        return Err("티켓은 인쇄 대신 판매 링크와 QR을 써요.".into());
    }
    let l = Lang::from(match str_of(entry, "lang") {
        "" => lang,
        saved => saved,
    });
    let template = match (kind, str_of(entry, "template")) {
        ("work", _) => "proof",
        (_, t @ ("course" | "proof" | "thanks")) => t,
        _ => "course",
    };
    let names: Vec<&str> = entry
        .get("names")
        .and_then(Value::as_array)
        .map(|a| a.iter().filter_map(Value::as_str).collect())
        .unwrap_or_default();
    if names.is_empty() {
        return Err("아직 체인 이름이 없어요. 만들기가 끝난 뒤에 인쇄할 수 있어요.".into());
    }
    let recipients: Vec<&str> = entry
        .get("recipients")
        .and_then(Value::as_array)
        .map(|a| a.iter().filter_map(Value::as_str).collect())
        .unwrap_or_default();
    let w = words(l);
    let shown = if preview { &names[..1] } else { &names[..] };
    let sheets: String = shown
        .iter()
        .enumerate()
        .map(|(i, name)| sheet(entry, template, l, name, recipients.get(i).copied().unwrap_or("")))
        .collect();
    let title = match str_of(entry, "display_title") {
        "" => str_of(entry, "title"),
        t => t,
    };
    let bar = if preview {
        String::new()
    } else {
        format!(
            r#"<div class="bar"><span>{}</span><span>{}</span><button type="button" onclick="window.print()">{}</button></div>"#,
            esc(&w.pages.replace("{0}", &names.len().to_string())),
            w.bar,
            w.print
        )
    };
    Ok(format!(
        r#"<!doctype html><html lang="{lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><title>{title}</title><style>{CSS}</style></head><body class="t-{template}{pv}">{bar}<main>{sheets}</main></body></html>"#,
        lang = l.code(),
        title = esc(title),
        pv = if preview { " preview" } else { "" },
    ))
}

/// 인쇄 파일 자리 — 앱 자료 폴더 안, 기록 한 줄에 파일 하나(다시 뽑으면 덮어쓴다).
pub fn print_path(id: &str) -> PathBuf {
    crate::paths::app_dir().join("printouts").join(format!("certificate-{id}.html"))
}

/// 기록을 읽어 인쇄 파일을 쓴다. 여는 것은 부르는 쪽 몫이다(시험에서 브라우저가 뜨면 안 된다).
pub fn write_print(id: &str, lang: &str) -> Result<PathBuf, String> {
    let entry = crate::create_history::create_history_get(id.to_string())?;
    if entry["status"] != "done" {
        return Err("아직 다 만들지 않았어요. 만들기가 끝난 뒤에 인쇄할 수 있어요.".into());
    }
    let html = render(&entry, lang, false)?;
    let path = print_path(id);
    crate::create_history::write_private(&path, html.as_bytes())?;
    Ok(path)
}

/// 인쇄할 파일을 만들고 기본 브라우저로 연다.
#[tauri::command]
pub fn create_print(id: String, lang: String) -> Result<Value, String> {
    let path = write_print(&id, &lang)?;
    open::that(&path).map_err(|e| format!("브라우저를 열지 못했어요: {e}"))?;
    Ok(json!({ "path": path.to_string_lossy() }))
}

/// 앱 안 미리보기 — 아직 저장하지 않은 칸으로 첫 장만 그린다. 파일은 안 쓴다.
#[tauri::command]
pub fn create_certificate_preview(entry: Value, lang: String) -> Result<String, String> {
    let kind = str_of(&entry, "kind").to_string();
    let mut clean = serde_json::Value::Object(crate::create_history::clean_details(entry.get("details").unwrap_or(&Value::Null), &kind)?);
    for key in ["kind", "title", "fingerprint"] {
        if let Some(v) = entry.get(key).and_then(Value::as_str) {
            if v.chars().count() <= 120 && !v.chars().any(char::is_control) {
                clean[key] = json!(v);
            }
        }
    }
    let name = entry.get("names").and_then(Value::as_array).and_then(|a| a.first()).and_then(Value::as_str).unwrap_or("");
    if name.is_empty() || name.len() > 40 {
        return Err("미리보기 이름을 확인해 주세요.".into());
    }
    clean["names"] = json!([name]);
    render(&clean, &lang, true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::create_history::tests::{begin_certificate, sandbox};

    fn entry(template: &str, recipients: &[&str], n: usize) -> Value {
        json!({
            "kind": "certificate", "title": "필라테스 지도자 과정 <b>수료</b>", "template": template,
            "names": (1..=n).map(|i| format!("HANBIT#PILATESEU260923-{i}")).collect::<Vec<_>>(),
            "recipients": recipients, "issued_on": "2026-09-23", "issuer": "PLAY X & 친구들",
            "signer": "홍길동", "fingerprint": "QmcwUFCZ8saJgoE6D9LEgVqtteCbVcdzWFcGzuhe7VTeW7",
        })
    }

    #[test]
    fn 한_사람에_한_장_받는사람과_번호가_짝지어진다() {
        for t in ["course", "proof", "thanks"] {
            let html = render(&entry(t, &["김하늘", "이바다", "박산"], 3), "ko", false).unwrap();
            assert_eq!(html.matches(r#"<section class="sheet">"#).count(), 3);
            let a = html.find("김하늘").unwrap();
            let b = html.find("HANBIT#PILATESEU260923-1").unwrap();
            let c = html.find("이바다").unwrap();
            assert!(a < b && b < c, "1번 이름 다음에 1번 번호, 그다음이 2번 사람");
            assert!(html.contains(&format!("t-{t}")));
            assert!(html.contains("2026년 9월 23일"));
            assert!(html.contains("원본 지문"));
            // 받는 사람보다 장수가 많으면 빈 줄(손으로 적는 자리).
            let blank = render(&entry(t, &["김하늘"], 2), "ko", false).unwrap();
            assert_eq!(blank.matches(r#"class="blank""#).count(), 1);
        }
    }

    #[test]
    fn 사람이_적은_글자는_그대로_글자로만_나간다() {
        let html = render(&entry("course", &["<script>alert(1)</script>"], 1), "ko", false).unwrap();
        assert!(!html.contains("<script>"));
        assert!(html.contains("&lt;script&gt;"));
        assert!(html.contains("필라테스 지도자 과정 &lt;b&gt;수료&lt;/b&gt;"));
        assert!(html.contains("PLAY X &amp; 친구들"));
    }

    #[test]
    fn 바깥에서_아무것도_안_부르고_확인_주소만_qr에_든다() {
        let html = render(&entry("thanks", &["김하늘"], 1), "en", false).unwrap();
        for bad in ["http://", "https://", "url(", "@import", "ipfs.io", "<link", "<img", "<script"] {
            assert!(!html.contains(bad), "인쇄 파일이 바깥을 부른다: {bad}");
        }
        assert!(html.contains("<svg"), "QR 이 파일 안에 구워져 있어야 한다");
        assert_eq!(verify_link("HANBIT#A-1"), "https://ravenvault.ex.erci.se/verify/?a=HANBIT%23A-1");
        assert_eq!(verify_link("HANBIT/B"), "https://ravenvault.ex.erci.se/verify/?a=HANBIT%2FB");
        assert!(html.contains("September 23, 2026"));
        assert!(html.contains("Presented to"));
        // 받는 사람 이름은 QR(주소)에 안 들어간다 — 주소는 체인 이름뿐.
        assert!(!verify_link("HANBIT#PILATESEU260923-1").contains("%EA"));
    }

    #[test]
    fn 티켓과_이름_없는_것은_인쇄하지_않는다() {
        let mut t = entry("course", &[], 1);
        t["kind"] = json!("ticket");
        assert!(render(&t, "ko", false).is_err());
        let mut e = entry("course", &[], 1);
        e["names"] = json!([]);
        assert!(render(&e, "ko", false).is_err());
        let pv = render(&entry("proof", &["가", "나"], 2), "ja", true).unwrap();
        assert_eq!(pv.matches(r#"<section class="sheet">"#).count(), 1, "미리보기는 첫 장만");
        assert!(!pv.contains("class=\"bar\""));
        assert!(pv.contains("2026年9月23日"));
    }

    #[test]
    fn 인쇄_파일은_앱폴더_안에_본인만_읽게_쓰인다() {
        sandbox(|dir| {
            let id = begin_certificate(&["김하늘", "이바다"]);
            assert!(write_print(&id, "ko").is_err(), "끝나기 전에는 인쇄하지 않는다");
            crate::create_history::mark_done(
                &id,
                &["HANBIT#PILATESEU260923-1".into(), "HANBIT#PILATESEU260923-2".into()],
                &"cd".repeat(32),
            )
            .unwrap();
            let path = write_print(&id, "ko").unwrap();
            assert!(path.starts_with(dir), "앱 자료 폴더 밖(바탕화면·동기화 폴더)에 쓰면 안 된다");
            let html = std::fs::read_to_string(&path).unwrap();
            assert_eq!(html.matches(r#"<section class="sheet">"#).count(), 2);
            assert!(html.contains("이바다"));
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                assert_eq!(std::fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);
                assert_eq!(std::fs::metadata(path.parent().unwrap()).unwrap().permissions().mode() & 0o777, 0o700);
            }
            // 다시 뽑으면 같은 파일을 덮어쓴다.
            assert_eq!(write_print(&id, "en").unwrap(), path);
            // 기록을 지우면 인쇄 파일도 지운다.
            crate::create_history::create_history_forget(id).unwrap();
            assert!(!path.exists());
        });
    }

    /// 사람이 눈으로 보는 견본 — `RV_CERT_SAMPLE_DIR` 이 있을 때만 쓴다.
    #[test]
    fn 견본_쓰기() {
        let Ok(dir) = std::env::var("RV_CERT_SAMPLE_DIR") else { return };
        let dir = std::path::PathBuf::from(dir);
        std::fs::create_dir_all(&dir).unwrap();
        let people = ["김하늘", "이바다", "Alexandra Montgomery-Whitfield"];
        for t in ["course", "proof", "thanks"] {
            for n in [1usize, 3] {
                let mut e = entry(t, &people[..n], n);
                e["title"] = json!(match t {
                    "course" => "필라테스 지도자 과정",
                    "proof" => "응급처치 기본 교육 이수 증명",
                    _ => "감사장",
                });
                e["issuer"] = json!("한빛 필라테스 아카데미");
                e["signer"] = json!("대표 홍길동");
                if t == "thanks" {
                    e["description"] = json!("한 해 동안 아이들의 수업을 함께 지켜 주셨습니다.\n보내 주신 마음에 깊이 감사드립니다.");
                }
                std::fs::write(dir.join(format!("{t}-{n}.html")), render(&e, "ko", false).unwrap()).unwrap();
                if n == 1 {
                    std::fs::write(dir.join(format!("preview-{t}.txt")), render(&e, "ko", true).unwrap()).unwrap();
                }
            }
        }
        let mut work = entry("proof", &["김하늘"], 1);
        work["kind"] = json!("work");
        work["title"] = json!("바다 그림 — 한정판");
        std::fs::write(dir.join("work-1.html"), render(&work, "ko", false).unwrap()).unwrap();
        let mut en = entry("course", &["Jane Doe"], 1);
        en["title"] = json!("Pilates Instructor Course");
        en["lang"] = json!("en");
        std::fs::write(dir.join("course-en.html"), render(&en, "ko", false).unwrap()).unwrap();
    }
}
