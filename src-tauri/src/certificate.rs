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

/// 양식마다 — 문서 이름, 위 로마자 한 줄, 받는 사람 이름표, 과정 칸 이름표,
/// 설명을 비워 뒀을 때 들어갈 문장.
struct Tpl {
    doc: &'static str,
    eyebrow: &'static str,
    who: &'static str,
    course: &'static str,
    body: &'static str,
}

fn template_words(template: &str, kind: &str, l: Lang) -> Tpl {
    if kind == "work" {
        return Tpl {
            doc: l.pick(["작품 보증서", "Certificate of Authenticity", "作品保証書", "作品证书"]),
            eyebrow: "Certificate of Authenticity",
            who: l.pick(["소장하는 분", "Owner", "所蔵者", "收藏者"]),
            course: l.pick(["작품", "Work", "作品", "作品"]),
            body: l.pick([
                "위 작품이 원본임을 증명합니다. 증서 번호마다 한 점뿐이에요.",
                "This certifies that the work above is an original. Each certificate number exists only once.",
                "上記の作品が原本であることを証明します。証書番号ごとに一点のみです。",
                "兹证明上述作品为原作。每个证书编号仅对应一件。",
            ]),
        };
    }
    match template {
        "proof" => Tpl {
            doc: l.pick(["증명서", "Certificate", "証明書", "证明书"]),
            eyebrow: "Certificate",
            who: l.pick(["성명", "Name", "氏名", "姓名"]),
            course: l.pick(["내용", "Subject", "内容", "内容"]),
            body: l.pick([
                "위 사람이 위 내용을 갖추었음을 증명합니다.",
                "This certifies that the person named above meets the requirements stated.",
                "上記の者が上記の内容を満たしていることを証明します。",
                "兹证明上述人员符合上述内容。",
            ]),
        },
        "thanks" => Tpl {
            doc: l.pick(["감사장", "Letter of Appreciation", "感謝状", "感谢状"]),
            eyebrow: "Letter of Appreciation",
            who: l.pick(["받는 분", "Presented to", "贈呈", "致"]),
            course: l.pick(["내용", "For", "内容", "内容"]),
            body: l.pick([
                "보내 주신 마음과 수고에 깊이 감사드리며 이 글을 드립니다.",
                "With sincere thanks for your kindness and dedication.",
                "日頃のご厚意とご尽力に深く感謝し、ここに感謝の意を表します。",
                "衷心感谢您的付出与支持，特此致谢。",
            ]),
        },
        _ => Tpl {
            doc: l.pick(["수료증", "Certificate of Completion", "修了証", "结业证书"]),
            eyebrow: "Certificate of Completion",
            who: l.pick(["성명", "Name", "氏名", "姓名"]),
            course: l.pick(["과정", "Course", "課程", "课程"]),
            body: l.pick([
                "위 사람은 위 과정을 성실히 마쳤기에 이 증서를 드립니다.",
                "This certifies that the person named above has successfully completed the course.",
                "上記の者は本課程を修了したことをここに証します。",
                "兹证明上述人员已圆满完成本课程。",
            ]),
        },
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

/// 글자 폭 어림(한글·한자 1, 로마자 대문자 .66, 소문자·숫자 .52, 빈칸 .3) — 이름 글자 크기를 고른다.
fn text_width(s: &str) -> f64 {
    s.chars()
        .map(|c| match c {
            ' ' => 0.3,
            'A'..='Z' => 0.66,
            c if c.is_ascii() => 0.52,
            _ => 1.0,
        })
        .sum()
}

/// 받는 사람 이름 칸 — 34pt 에 한글 10자쯤이 한 줄. 넘으면 한 단계씩 줄인다.
fn name_class(s: &str) -> &'static str {
    let w = text_width(s);
    let latin = !s.is_empty() && s.is_ascii();
    match (latin, w) {
        (_, w) if w > 24.0 => " xxlong",
        (_, w) if w > 17.0 => " xlong",
        (_, w) if w > 10.0 => " long",
        (true, _) => " latin",
        _ => "",
    }
}

fn str_of<'a>(v: &'a Value, key: &str) -> &'a str {
    v.get(key).and_then(Value::as_str).unwrap_or("")
}

/// 명단 한 줄의 칸(과정·등급·발급일·번호). 표로 올리지 않았으면 모두 비어 있다.
fn row_field<'a>(entry: &'a Value, i: usize, key: &str) -> &'a str {
    entry
        .get("rows")
        .and_then(Value::as_array)
        .and_then(|rows| rows.get(i))
        .map(|r| str_of(r, key))
        .unwrap_or("")
}

/// 설명 속 `{이름}`·`{과정}`(또는 `{name}`·`{course}`)을 그 줄 값으로.
fn fill(body: &str, recipient: &str, course: &str) -> String {
    body.replace("{이름}", recipient)
        .replace("{name}", recipient)
        .replace("{과정}", course)
        .replace("{course}", course)
}

/// 한 장에 들어가는 것 — 순서대로 부른다.
struct One<'a> {
    name: &'a str,
    recipient: &'a str,
    index: usize,
    photo: Option<&'a str>,
}

fn sheet(entry: &Value, template: &str, l: Lang, one: One, marks: &Marks) -> String {
    let w = words(l);
    let kind = str_of(entry, "kind");
    let tpl = template_words(template, kind, l);
    let title = match str_of(entry, "display_title") {
        "" => str_of(entry, "title"),
        t => t,
    };
    let course = match row_field(entry, one.index, "course") {
        "" => title,
        c => c,
    };
    let grade = row_field(entry, one.index, "grade");
    let number = row_field(entry, one.index, "number");
    let issued = match row_field(entry, one.index, "date") {
        "" => str_of(entry, "issued_on"),
        d => d,
    };
    let body = match str_of(entry, "description") {
        "" => tpl.body.to_string(),
        d => fill(d, one.recipient, course),
    };
    let emblem = match (template, kind) {
        (_, "work") | ("proof", _) => badge(),
        ("thanks", _) => flourish(),
        _ => laurel(),
    };
    let issuer = str_of(entry, "issuer");
    let signer = str_of(entry, "signer");
    let fp = str_of(entry, "fingerprint");
    let latin_doc = l == Lang::En;
    let slot = entry.get("photo_slot").and_then(Value::as_bool).unwrap_or(false);
    let photo = match (slot, one.photo) {
        (true, Some(src)) => format!(r#"<figure class="photo"><img src="{}" alt=""></figure>"#, esc(src)),
        (true, None) => format!(r#"<figure class="photo empty"><span>{}</span></figure>"#, l.pick(["사진", "Photo", "写真", "照片"])),
        _ => String::new(),
    };
    let mark = if marks.logo { r#"<i class="logo" role="img" aria-label="logo"></i>"#.to_string() } else { emblem.clone() };
    let watermark = if marks.logo { r#"<i class="logo"></i>"#.to_string() } else { emblem };
    let name_html = if one.recipient.is_empty() { r#"<span class="blank"></span>"#.to_string() } else { esc(one.recipient) };
    let blank = r#"<span class="line"></span>"#;
    let cell = |v: &str| if v.is_empty() { blank.to_string() } else { esc(v) };
    let seal = if marks.stamp {
        r#"<span class="seal"><i class="stamp"></i></span>"#.to_string()
    } else if !signer.is_empty() {
        format!(r#"<span class="seal none">{}</span>"#, l.pick(["(인)", "", "(印)", "(章)"]))
    } else {
        String::new()
    };
    let fact = |label: &str, value: &str, small: bool| {
        if value.is_empty() {
            String::new()
        } else {
            format!(r#"<div><dt>{}</dt><dd{}>{}</dd></div>"#, esc(label), if small { r#" class="small""# } else { "" }, esc(value))
        }
    };
    format!(
        r#"<section class="sheet t-{template}{has_photo}"><div class="frame" aria-hidden="true"><i></i><i></i><i></i><i></i></div>
<div class="wm" aria-hidden="true">{watermark}</div>{photo}
<div class="inner">
<header class="head"><div class="mark">{mark}</div>{eyebrow}<h1 class="doc{doc_cls}">{doc}</h1><div class="rule" aria-hidden="true"></div></header>
<div class="who"><span class="label">{l_who}</span><p class="name{name_cls}">{name_html}</p></div>
<dl class="facts">{f_course}{f_grade}{f_number}</dl>
<p class="body">{body}</p>
<div class="sign">
<div class="cell date"><span class="label">{l_date}</span><span class="v">{date}</span></div>
<div class="cell issuer"><span class="label">{l_issuer}</span><span class="v">{issuer}</span></div>
<div class="cell sig"><span class="label">{l_sig}</span><span class="v">{signer}{seal}</span></div>
</div>
<footer class="proof"><div><dl><dt>{l_num}</dt><dd>{number_chain}</dd><dt>{l_url}</dt><dd>{url}</dd><dt class="fpk{fp_none}">{l_fp}</dt><dd class="fp{fp_none}">{fp}</dd></dl>
<p class="how">{how}{how_file}</p></div><div class="qr">{qr}</div></footer>
</div></section>"#,
        has_photo = if slot { " has-photo" } else { "" },
        eyebrow = if latin_doc { String::new() } else { format!(r#"<p class="eyebrow">{}</p>"#, esc(tpl.eyebrow)) },
        doc_cls = if latin_doc { " latin" } else { "" },
        doc = esc(tpl.doc),
        l_who = esc(tpl.who),
        name_cls = name_class(one.recipient),
        f_course = fact(tpl.course, course, text_width(course) > 30.0),
        f_grade = fact(l.pick(["등급", "Grade", "等級", "等级"]), grade, false),
        f_number = fact(l.pick(["발급 번호", "No.", "発行番号", "编号"]), number, true),
        body = esc(&body),
        l_date = w.date,
        date = if issued.is_empty() { blank.to_string() } else { esc(&format_date(issued, l)) },
        l_issuer = w.issuer,
        issuer = cell(issuer),
        l_sig = w.signature,
        signer = if signer.is_empty() && !marks.stamp { blank.to_string() } else { esc(signer) },
        l_num = w.number,
        number_chain = esc(one.name),
        l_url = l.pick(["확인 주소", "Verify at", "確認先", "核验网址"]),
        url = "ravenvault.ex.erci.se/verify",
        fp_none = if fp.is_empty() { " none" } else { "" },
        l_fp = w.fingerprint,
        fp = esc(fp),
        how = w.how,
        how_file = if fp.is_empty() { String::new() } else { format!(" {}", w.how_file) },
        qr = qr_svg(&verify_link(one.name)),
    )
}

/// 발급처 로고·도장이 있나. 그림은 문서 머리의 CSS 변수로 **한 번만** 넣는다 —
/// 500장을 뽑아도 로고가 500번 들어가지 않게.
struct Marks {
    logo: bool,
    stamp: bool,
    css: String,
}

fn marks() -> Marks {
    let logo = crate::cert_assets::mark("logo");
    let stamp = crate::cert_assets::mark("stamp");
    let mut css = String::new();
    if let Some(u) = &logo {
        css.push_str(&format!(":root{{--logo:url({u})}}"));
    }
    if let Some(u) = &stamp {
        css.push_str(&format!(":root{{--stamp:url({u})}}"));
    }
    Marks { logo: logo.is_some(), stamp: stamp.is_some(), css }
}

/// 기록 한 건의 장들. `preview` 면 첫 장만, `only` 면 그 사람 한 장만.
///
/// 사진: 인쇄는 기록 id 의 사진 폴더에서(`cert_assets::photo`), 미리보기는 화면이 넘긴
/// `preview_photo` 한 장에서.
fn sheets_of(entry: &Value, lang: &str, preview: bool, only: Option<usize>, m: &Marks) -> Result<(Lang, String, usize), String> {
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
    let picked: Vec<usize> = match (preview, only) {
        (true, _) => vec![0],
        (false, Some(i)) if i < names.len() => vec![i],
        (false, Some(_)) => return Err("그 차례의 증서가 없어요.".into()),
        (false, None) => (0..names.len()).collect(),
    };
    let id = str_of(entry, "id");
    let sheets = picked
        .iter()
        .map(|&i| {
            let photo = if preview {
                entry.get("preview_photo").and_then(Value::as_str).map(str::to_string)
            } else {
                crate::cert_assets::photo(id, i)
            };
            sheet(entry, template, l, One { name: names[i], recipient: recipients.get(i).copied().unwrap_or(""), index: i, photo: photo.as_deref() }, m)
        })
        .collect();
    Ok((l, sheets, picked.len()))
}

/// 종이 여러 장을 문서 하나로 — 글꼴·로고·도장은 머리에 한 번만.
fn document(l: Lang, title: &str, sheets: &str, pages: usize, preview: bool, m: &Marks) -> String {
    let w = words(l);
    let bar = if preview {
        String::new()
    } else {
        format!(
            r#"<div class="bar"><span>{}</span><span>{}</span><button type="button" onclick="window.print()">{}</button></div>"#,
            esc(&w.pages.replace("{0}", &pages.to_string())),
            w.bar,
            w.print
        )
    };
    let fonts = if preview { "" } else { crate::cert_assets::font_css() };
    format!(
        r#"<!doctype html><html lang="{lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><title>{title}</title><style>{fonts}{CSS}{marks}</style></head><body{pv}>{bar}<main>{sheets}</main></body></html>"#,
        lang = l.code(),
        title = esc(title),
        marks = m.css,
        pv = if preview { r#" class="preview""# } else { "" },
    )
}

fn title_of(entry: &Value) -> &str {
    match str_of(entry, "display_title") {
        "" => str_of(entry, "title"),
        t => t,
    }
}

/// 문서 전체. `preview` 면 첫 장만, 안내 줄·글꼴 없이(앱 안 미리보기는 글꼴 CSS 를 따로 한 번 받는다).
pub fn render(entry: &Value, lang: &str, preview: bool) -> Result<String, String> {
    render_one(entry, lang, preview, None)
}

/// `only` — 그 사람 한 장만(「한 장씩 PDF」).
pub fn render_one(entry: &Value, lang: &str, preview: bool, only: Option<usize>) -> Result<String, String> {
    let m = marks();
    let (l, sheets, pages) = sheets_of(entry, lang, preview, only, &m)?;
    Ok(document(l, title_of(entry), &sheets, pages, preview, &m))
}

/// 한 묶음 발행(50장씩 나눠 만든 기록 여러 건)을 한 파일로 — 「전체 묶음 PDF」.
pub fn render_many(entries: &[Value], lang: &str) -> Result<String, String> {
    let first = entries.first().ok_or("인쇄할 기록이 없어요.")?;
    let m = marks();
    let (mut all, mut pages, mut lang0) = (String::new(), 0, None);
    for e in entries {
        let (l, sheets, n) = sheets_of(e, lang, false, None, &m)?;
        lang0.get_or_insert(l);
        all.push_str(&sheets);
        pages += n;
    }
    Ok(document(lang0.unwrap_or(Lang::Ko), title_of(first), &all, pages, false, &m))
}

/// 인쇄 파일 자리 — 앱 자료 폴더 안, 기록 한 줄에 파일 하나(다시 뽑으면 덮어쓴다).
pub fn print_path(id: &str) -> PathBuf {
    crate::paths::app_dir().join("printouts").join(format!("certificate-{id}.html"))
}

/// 한 사람 한 장 — `certificate-<id>-<차례>.html`.
pub fn print_path_one(id: &str, index: usize) -> PathBuf {
    crate::paths::app_dir().join("printouts").join(format!("certificate-{id}-{}.html", index + 1))
}

/// 여러 기록을 묶은 파일(전체 묶음 인쇄 · 번호 목록 표). 첫 기록 id 로 이름을 짓는다 —
/// 🔴 다른 기록의 이름도 들어 있어서, 어느 기록이든 지우면 이 파일들은 통째로 지운다
/// (`create_history::remove_prints`). 다시 누르면 다시 만든다.
pub fn shared_path(first_id: &str, tail: &str) -> PathBuf {
    crate::paths::app_dir().join("printouts").join(format!("certificate-{first_id}-{tail}"))
}

fn done_entry(id: &str) -> Result<Value, String> {
    let entry = crate::create_history::create_history_get(id.to_string())?;
    if entry["status"] != "done" {
        return Err("아직 다 만들지 않았어요. 만들기가 끝난 뒤에 인쇄할 수 있어요.".into());
    }
    Ok(entry)
}

/// 기록을 읽어 인쇄 파일을 쓴다(`index` 면 그 사람 한 장만). 여는 것은 부르는 쪽 몫이다
/// (시험에서 브라우저가 뜨면 안 된다).
pub fn write_print_one(id: &str, lang: &str, index: Option<usize>) -> Result<PathBuf, String> {
    let entry = done_entry(id)?;
    let html = render_one(&entry, lang, false, index)?;
    let path = match index {
        Some(i) => print_path_one(id, i),
        None => print_path(id),
    };
    crate::create_history::write_private(&path, html.as_bytes())?;
    Ok(path)
}

/// 한 묶음(기록 여러 건)을 한 파일로.
pub fn write_print_many(ids: &[String], lang: &str) -> Result<PathBuf, String> {
    if ids.is_empty() || ids.len() > MAX_BATCH_ENTRIES {
        return Err(format!("한 번에 기록 {MAX_BATCH_ENTRIES}건까지 묶어 인쇄할 수 있어요."));
    }
    let entries = ids.iter().map(|id| done_entry(id)).collect::<Result<Vec<_>, _>>()?;
    let html = render_many(&entries, lang)?;
    let path = shared_path(&ids[0], "all.html");
    crate::create_history::write_private(&path, html.as_bytes())?;
    Ok(path)
}

/// 500줄 ÷ 50장 = 10건. 여유를 두고 20건까지.
pub const MAX_BATCH_ENTRIES: usize = 20;

/// 인쇄할 파일을 만들고 기본 브라우저로 연다. `index` 가 있으면 그 사람 한 장만.
#[tauri::command]
pub fn create_print(id: String, lang: String, index: Option<usize>) -> Result<Value, String> {
    let path = write_print_one(&id, &lang, index)?;
    open::that(&path).map_err(|e| format!("브라우저를 열지 못했어요: {e}"))?;
    Ok(json!({ "path": path.to_string_lossy() }))
}

/// 한 묶음 전체를 한 파일로 만들어 연다 — 인쇄 창에서 「PDF로 저장」하면 A4 여러 쪽 PDF 하나.
#[tauri::command]
pub fn create_print_many(ids: Vec<String>, lang: String) -> Result<Value, String> {
    let path = write_print_many(&ids, &lang)?;
    open::that(&path).map_err(|e| format!("브라우저를 열지 못했어요: {e}"))?;
    Ok(json!({ "path": path.to_string_lossy() }))
}

/// 방금 만든 샘플 파일 — 「엑셀로 열기」는 이것만 연다(화면이 아무 경로나 열게 하지 않는다).
static SAMPLES: std::sync::Mutex<Vec<PathBuf>> = std::sync::Mutex::new(Vec::new());

fn remember_sample(path: &std::path::Path) {
    if let Ok(mut list) = SAMPLES.lock() {
        if list.len() > 20 {
            list.clear();
        }
        list.push(path.to_path_buf());
    }
}

/// 방금 받은 샘플 표를 기본 프로그램(엑셀·Numbers)으로 연다. 다시 쓰지 않는다.
#[tauri::command]
pub fn certificate_sample_open(path: String) -> Result<(), String> {
    let p = PathBuf::from(&path);
    if !SAMPLES.lock().map(|l| l.contains(&p)).unwrap_or(false) {
        return Err("방금 받은 샘플 파일만 열 수 있어요.".into());
    }
    open::that(&p).map_err(|e| format!("파일을 열지 못했어요: {e}"))
}

/// 표 파일 저장.
///
/// - `sample` — 「샘플 표 받기」. 개인정보가 없는 예시라 다운로드 폴더에 둔다.
///   이름은 `증서_명단_샘플.xlsx`·`.csv` 둘만 받는다.
/// - `list` — 발행 뒤 「번호 목록 표」. 받는 사람 이름이 들어 있어 인쇄 파일처럼 앱 자료
///   폴더(0600)에 쓰고 기본 프로그램(엑셀·Numbers)으로 연다 — 거기서 원하는 곳에 저장한다.
///   `name` 은 `<첫 기록 id>.xlsx` 또는 `.csv`.
///
/// `open` 이면 쓴 뒤 기본 프로그램으로 연다.
#[tauri::command]
pub fn certificate_file_save(kind: String, name: String, data: String, open: bool) -> Result<Value, String> {
    const MAX: usize = 8 * 1024 * 1024;
    if data.len() > MAX * 4 / 3 + 8 {
        return Err("파일이 너무 커요.".into());
    }
    let bytes = crate::cert_assets::b64_decode(&data).ok_or("파일을 읽지 못했어요.")?;
    let path = match kind.as_str() {
        "sample" => {
            let Some((stem, ext)) = name.rsplit_once('.').filter(|(s, e)| *s == "증서_명단_샘플" && matches!(*e, "xlsx" | "csv")) else {
                return Err("샘플 파일 이름이 올바르지 않아요.".into());
            };
            let home = crate::paths::home();
            let downloads = home.join("Downloads");
            let dir = if downloads.is_dir() { downloads } else { home };
            // 🔴 덮어쓰지 않는다 — 샘플을 그 자리에서 채운 명단일 수 있다(검수 09-24).
            //    있으면 「(2)」「(3)」… 새 이름으로, 바로가기도 따라가지 않는다(create_new).
            let path = (1..100)
                .map(|n| dir.join(if n == 1 { format!("{stem}.{ext}") } else { format!("{stem} ({n}).{ext}") }))
                .find_map(|p| {
                    use std::io::Write;
                    let mut f = std::fs::OpenOptions::new().write(true).create_new(true).open(&p).ok()?;
                    f.write_all(&bytes).ok()?;
                    Some(p)
                })
                .ok_or("다운로드 폴더에 샘플 파일을 만들지 못했어요.")?;
            remember_sample(&path);
            path
        }
        "list" => {
            let (id, ext) = name.rsplit_once('.').ok_or("파일 이름이 올바르지 않아요.")?;
            if !matches!(ext, "xlsx" | "csv") {
                return Err("파일 이름이 올바르지 않아요.".into());
            }
            done_entry(id)?;
            let path = shared_path(id, &format!("list.{ext}"));
            crate::create_history::write_private(&path, &bytes)?;
            path
        }
        _ => return Err("알 수 없는 파일이에요.".into()),
    };
    if open {
        open::that(&path).map_err(|e| format!("파일을 열지 못했어요: {e}"))?;
    }
    Ok(json!({ "path": path.to_string_lossy(), "where": path.parent().map(|p| p.to_string_lossy().to_string()) }))
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
    // 미리보기 사진 한 장 — 저장하지 않고 이번 그림에만 쓴다. 모양·크기는 저장할 때와 같이 본다.
    if let Some(url) = entry.get("preview_photo").and_then(Value::as_str) {
        crate::cert_assets::image_from_data_url(url, crate::cert_assets::MAX_PHOTO_BYTES)?;
        clean["preview_photo"] = json!(url);
    }
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
            assert_eq!(html.matches(r#"<section class="sheet "#).count(), 3);
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
        for bad in ["http://", "https://", "@import", "ipfs.io", "<link", "<script"] {
            assert!(!html.contains(bad), "인쇄 파일이 바깥을 부른다: {bad}");
        }
        // 글꼴·로고·사진은 파일 안(data:)으로만 — 바깥 주소나 옆 파일을 부르지 않는다.
        assert!(html.matches("url(").count() >= 5, "글꼴 다섯 개가 파일 안에 있어야 한다");
        assert_eq!(html.matches("url(").count(), html.matches("url(data:").count());
        assert_eq!(html.matches("<img").count(), html.matches(r#"<img src="data:"#).count());
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
        assert_eq!(pv.matches(r#"<section class="sheet "#).count(), 1, "미리보기는 첫 장만");
        assert!(!pv.contains("class=\"bar\""));
        assert!(pv.contains("2026年9月23日"));
    }

    #[test]
    fn 인쇄_파일은_앱폴더_안에_본인만_읽게_쓰인다() {
        sandbox(|dir| {
            let id = begin_certificate(&["김하늘", "이바다"]);
            assert!(write_print_one(&id, "ko", None).is_err(), "끝나기 전에는 인쇄하지 않는다");
            crate::create_history::mark_done(
                &id,
                &["HANBIT#PILATESEU260923-1".into(), "HANBIT#PILATESEU260923-2".into()],
                &"cd".repeat(32),
            )
            .unwrap();
            let path = write_print_one(&id, "ko", None).unwrap();
            assert!(path.starts_with(dir), "앱 자료 폴더 밖(바탕화면·동기화 폴더)에 쓰면 안 된다");
            let html = std::fs::read_to_string(&path).unwrap();
            assert_eq!(html.matches(r#"<section class="sheet "#).count(), 2);
            assert!(html.contains("이바다"));
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                assert_eq!(std::fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);
                assert_eq!(std::fs::metadata(path.parent().unwrap()).unwrap().permissions().mode() & 0o777, 0o700);
            }
            // 다시 뽑으면 같은 파일을 덮어쓴다.
            assert_eq!(write_print_one(&id, "en", None).unwrap(), path);
            // 기록을 지우면 인쇄 파일도 지운다.
            crate::create_history::create_history_forget(id).unwrap();
            assert!(!path.exists());
        });
    }

    #[test]
    fn 한_사람만_뽑거나_여러_기록을_한_파일로_묶는다() {
        let a = entry("course", &["김하늘", "이바다", "박산"], 3);
        let one = render_one(&a, "ko", false, Some(1)).unwrap();
        assert_eq!(one.matches(r#"<section class="sheet"#).count(), 1);
        assert!(one.contains("이바다") && !one.contains("김하늘"));
        assert!(one.contains("HANBIT#PILATESEU260923-2"));
        assert!(render_one(&a, "ko", false, Some(3)).is_err(), "없는 차례");
        let mut b = entry("thanks", &["최별"], 1);
        b["names"] = json!(["HANBIT#PILATESEU260923B-1"]);
        let many = render_many(&[a, b], "ko").unwrap();
        assert_eq!(many.matches(r#"<section class="sheet"#).count(), 4);
        // 양식은 장마다 — 한 파일에 수료증과 감사장이 섞여도 제 모양.
        assert_eq!(many.matches("sheet t-course").count(), 3);
        assert_eq!(many.matches("sheet t-thanks").count(), 1);
        assert_eq!(many.matches("@font-face").count(), 5, "글꼴은 머리에 한 번만");
        assert!(many.contains("4장"));
    }

    #[test]
    fn 묶음_파일은_어느_기록을_지워도_같이_지운다() {
        sandbox(|_| {
            let a = begin_certificate(&["김하늘"]);
            let b = begin_certificate(&["이바다"]);
            let prints = crate::paths::app_dir().join("printouts");
            std::fs::create_dir_all(&prints).unwrap();
            for p in [print_path(&a), print_path_one(&a, 0), shared_path(&a, "all.html"), shared_path(&a, "list.xlsx"), print_path(&b), print_path_one(&b, 0)] {
                std::fs::write(p, b"x").unwrap();
            }
            let other = prints.join("tax-return.pdf");
            std::fs::write(&other, b"x").unwrap();
            crate::create_history::create_history_forget(b.clone()).unwrap();
            assert!(!print_path(&b).exists() && !print_path_one(&b, 0).exists());
            assert!(!shared_path(&a, "all.html").exists(), "b 의 이름이 든 묶음 파일");
            assert!(!shared_path(&a, "list.xlsx").exists());
            assert!(print_path(&a).exists() && print_path_one(&a, 0).exists(), "a 의 제 파일은 남는다");
            assert!(other.exists(), "우리 이름이 아닌 파일은 안 건드린다");
        });
    }

    #[test]
    fn 표_파일은_정해진_이름과_자리에만() {
        sandbox(|_| {
            let data = crate::cert_assets::b64_encode(b"PK");
            assert!(certificate_file_save("sample".into(), "../../evil.xlsx".into(), data.clone(), false).is_err());
            assert!(certificate_file_save("list".into(), "0123456789abcdef0123456789abcdef.xlsx".into(), data.clone(), false).is_err(), "없는 기록");
            assert!(certificate_file_save("list".into(), "../x.xlsx".into(), data.clone(), false).is_err());
            assert!(certificate_file_save("other".into(), "a.xlsx".into(), data.clone(), false).is_err());
            assert!(certificate_sample_open("/etc/hosts".into()).is_err(), "받은 샘플만 연다");
        });
    }

    /// 사람이 눈으로 보는 견본 — `RV_CERT_SAMPLE_DIR` 이 있을 때만 쓴다.
    #[test]
    fn 견본_쓰기() {
        let Ok(dir) = std::env::var("RV_CERT_SAMPLE_DIR") else { return };
        let dir = std::path::PathBuf::from(dir);
        std::fs::create_dir_all(&dir).unwrap();
        // 로고·도장·사진 견본(검사 스크립트가 브라우저로 그려 넘긴다). 없으면 그 견본만 건너뛴다.
        let assets = std::env::var("RV_CERT_SAMPLE_ASSETS").ok().map(std::path::PathBuf::from);
        let write = |name: &str, html: String| std::fs::write(dir.join(name), html).unwrap();
        sandbox(|home| {
            // 이름 세 가지 — 짧은 한글 · 한글 20자 · 긴 로마자.
            let names = [
                ("short", "김산"),
                ("long", "남궁가나다라마바사아자차카타파하거너더러"),
                ("latin", "Alexandra Montgomery-Whitfield"),
            ];
            let dress = |e: &mut Value, t: &str| {
                e["title"] = json!(match t {
                    "course" => "필라테스 지도자 과정",
                    "proof" => "응급처치 기본 교육 이수",
                    _ => "2026 봄 학기 봉사",
                });
                e["issuer"] = json!("한빛 필라테스 아카데미");
                e["signer"] = json!("대표 홍길동");
                if t == "thanks" {
                    e["description"] = json!("{이름} 님, 한 해 동안 아이들의 수업을 함께 지켜 주셨습니다. 보내 주신 마음에 깊이 감사드립니다.");
                }
            };
            for t in ["course", "proof", "thanks"] {
                for (v, who) in names {
                    let mut e = entry(t, &[who], 1);
                    dress(&mut e, t);
                    write(&format!("{t}-{v}.html"), render(&e, "ko", false).unwrap());
                    write(&format!("preview-{t}-{v}.txt"), render(&e, "ko", true).unwrap());
                }
                let mut e = entry(t, &["김하늘", "이바다", "Alexandra Montgomery-Whitfield"], 3);
                dress(&mut e, t);
                write(&format!("{t}-3.html"), render(&e, "ko", false).unwrap());
            }
            let mut work = entry("proof", &["김하늘"], 1);
            work["kind"] = json!("work");
            work["title"] = json!("바다 그림 — 한정판");
            write("work-1.html", render(&work, "ko", false).unwrap());
            let mut en = entry("course", &["Jane Doe"], 1);
            en["title"] = json!("Pilates Instructor Course");
            en["lang"] = json!("en");
            write("course-en.html", render(&en, "ko", false).unwrap());

            // 발급처 로고·도장 + 사진 칸 + 명단 표 칸(과정·등급·번호).
            let Some(assets) = &assets else { return };
            let marks = home.join("cert-assets");
            std::fs::create_dir_all(&marks).unwrap();
            for kind in ["logo", "stamp"] {
                std::fs::copy(assets.join(format!("{kind}.png")), marks.join(format!("{kind}.img"))).unwrap();
            }
            let photo = std::fs::read(assets.join("photo.jpg")).unwrap();
            let id = "0123456789abcdef0123456789abcdef";
            let people = ["김하늘", "남궁가나다라마바사아자차카타파하거너더러"];
            std::fs::create_dir_all(crate::cert_assets::photos_dir(id)).unwrap();
            std::fs::write(crate::cert_assets::photos_dir(id).join("0.img"), &photo).unwrap();
            for t in ["course", "proof", "thanks"] {
                let mut e = entry(t, &people, 2);
                dress(&mut e, t);
                e["id"] = json!(id);
                e["photo_slot"] = json!(true);
                e["rows"] = json!([
                    { "course": "필라테스 지도자 과정 2급", "grade": "2급", "number": "HB-2026-0001", "date": "2026-09-20" },
                    { "course": "", "grade": "", "number": "HB-2026-0002", "date": "" },
                ]);
                write(&format!("{t}-brand.html"), render(&e, "ko", false).unwrap());
                e["preview_photo"] = json!(format!("data:image/jpeg;base64,{}", crate::cert_assets::b64_encode(&photo)));
                write(&format!("preview-{t}-brand.txt"), render(&e, "ko", true).unwrap());
            }
        });
        std::fs::write(dir.join("fonts.css"), crate::cert_assets::font_css()).unwrap();
    }
}
