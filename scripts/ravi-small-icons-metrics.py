import warnings; warnings.filterwarnings("ignore")
"""라비 작은 얼굴·메뉴바 아이콘 수치 + 갤러리 HTML. (Pillow 사용, 표준 라이브러리 외 의존은 이것뿐)

입력: node scripts/ravi-small-icons-gallery.mjs 결과(artifacts/small-icons/*.png, cells.json)
      python3 scripts/generate-ravi-tray-v2.py 결과(src-tauri/icons/ravi-tray-v2-*.rgba)
출력: artifacts/small-icons/metrics.json · index.html · strip-*.png · tray/*.png · menubar-*.png
측정:
 1) 눈 지름(px) — 전: face.webp 실측(어두운 눈동자 47/420, 흰 테 포함 61/420) × 크기. 후: 손맞춤 표(정수 픽셀).
 2) 표정 구별 — 실제 크롬 1x 렌더에서 같은 크기 표정 6개(평상·기쁨·걱정·졸림·놀람·사랑) 칸끼리
    평균 절대 픽셀 차이(%). 가장 헷갈리는 짝의 값(최솟값)과 평상~걱정 값을 본다. 클수록 잘 구별된다.
 3) 대비(WCAG 2.x 상대 휘도) — 설계 색끼리 + 실제 1x 렌더에서 잰 「눈 가장 어두운 칸 vs 얼굴 칸」.
 4) 메뉴바 — 템플릿은 2톤인지(알파 0/255 만), 알림 점과 머리 사이 틈(px), 라이트/다크 메뉴바 모의 그림.
"""
import json, itertools, os, sys
from pathlib import Path
from PIL import Image, ImageDraw

root = Path(__file__).resolve().parent.parent
out = Path(os.environ.get("RV_SMALL_OUT", root / "artifacts/small-icons"))
icons_before = root / "src-tauri/icons"  # 지금 앱이 쓰는 파일(전)
icons = Path(os.environ.get("RV_TRAY_DIR", root / "src-tauri/icons"))  # v2 파일(후)
rep = json.loads((out / "cells.json").read_text())
CELLS = rep["cells"]
SIZES = [16, 20, 22, 24, 32]
CORE = ["normal", "happy", "worried", "sleep", "surprised", "love"]

def lum(c):
    if isinstance(c, str):
        c = tuple(int(c.lstrip("#")[i:i + 2], 16) for i in (0, 2, 4))
    v = [x / 255 for x in c[:3]]
    v = [x / 12.92 if x <= 0.03928 else ((x + 0.055) / 1.055) ** 2.4 for x in v]
    return 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2]
def ratio(a, b):
    x, y = sorted([lum(a), lum(b)], reverse=True)
    return round((x + 0.05) / (y + 0.05), 2)

# ---------- 1) 눈 지름 ----------
LAYOUT = {16: (4, 5, 11, 9), 20: (5, 6.5, 13.5, 11.5), 22: (5, 7.5, 14.5, 12.5), 24: (6, 8, 16, 13), 32: (8, 10, 22, 17)}  # d, lx, rx, cy (src/ravi-face-small.ts 와 같아야 함 — 아래에서 TS 원문과 대조)
ts = (root / "src/ravi-face-small.ts").read_text()
for n, (d, lx, rx, cy) in LAYOUT.items():
    assert f"{n}: {{ n: {n}, d: {d}, lx: {lx}, rx: {rx}, cy: {cy}," in ts, f"LAYOUT {n} 이 TS 와 다름"
EYE_FLOOR = {16: 4, 20: 5, 22: 5, 24: 6, 32: 7}  # 목표 하한(대략 크기의 1/4)
eye = {n: {"before_dark": round(47 * n / 420, 1), "before_with_ring": round(61 * n / 420, 1), "after": LAYOUT[n][0], "floor": EYE_FLOOR[n], "pass": LAYOUT[n][0] >= EYE_FLOOR[n]} for n in SIZES}

# ---------- 2) 표정 구별 ----------
def crops(which, theme):
    img = Image.open(out / f"sheet-{which}-{theme}-1x.png").convert("RGB")
    res = {}
    for c in CELLS[f"{which}-{theme}-1x"]:
        x, y, w = round(c["x"]), round(c["y"]), round(c["w"])
        res[(c["size"], c["mood"])] = img.crop((x, y, x + w, y + w))
    return res
def diff(a, b):
    pa, pb = list(a.getdata()), list(b.getdata())
    return sum(abs(p[i] - q[i]) for p, q in zip(pa, pb) for i in range(3)) / (len(pa) * 3 * 255) * 100
distinct = {}
for theme in ("light", "dark"):
    for which in ("before", "after"):
        cr = crops(which, theme)
        for n in SIZES:
            pairs = {f"{a}~{b}": round(diff(cr[(n, a)], cr[(n, b)]), 2) for a, b in itertools.combinations(CORE, 2)}
            lo = min(pairs, key=pairs.get)
            distinct.setdefault(theme, {}).setdefault(str(n), {})[which] = {"min_pct": pairs[lo], "closest": lo, "normal~worried": pairs["normal~worried"], "mean_pct": round(sum(pairs.values()) / len(pairs), 2), "pairs": pairs}

# ---------- 3) 대비 ----------
B = dict(eye="#22201F", face="#FBB680", beak="#EC7D25", hair="#2F386E", ribbon="#6D4199", bg="#9686C9")
A = dict(eye="#12101C", face="#FFC896", beak="#EC7D25", hair="#2F386E", ribbon="#B98CF2", bg="#9686C9", outline="#0E1028")
contrast = {
    "eye_vs_face": {"before": ratio(B["eye"], B["face"]), "after": ratio(A["eye"], A["face"]), "goal": 7},
    "hair_edge_vs_bg": {"before": ratio(B["hair"], B["bg"]), "after": ratio(A["outline"], A["bg"]), "goal": 3, "note": "후: 머리 둘레 진남색 외곽선이 배경과 만난다"},
    "beak_edge_vs_face": {"before": ratio(B["beak"], B["face"]), "after": ratio(A["eye"], A["face"]), "goal": 3, "note": "후: 부리 둘레 검정 테 — 테 바깥은 살구, 안은 주황"},
    "beak_fill_vs_outline": {"before": None, "after": ratio(A["beak"], A["eye"]), "goal": 3},
    "ribbon_vs_hair": {"before": ratio(B["ribbon"], B["hair"]), "after": ratio(A["ribbon"], A["hair"]), "goal": 3},
    "ribbon_edge_vs_bg": {"before": ratio(B["ribbon"], B["bg"]), "after": ratio(A["outline"], A["bg"]), "goal": 3, "note": "후: 리본 테"},
    "face_vs_hair": {"before": ratio(B["face"], B["hair"]), "after": ratio(A["face"], A["hair"]), "goal": 3},
    "brow_vs_face": {"before": ratio("#1B1A25", B["hair"]), "after": ratio(A["eye"], A["face"]), "goal": 3, "note": "전: 걱정 눈썹이 남색 머리 위(#1B1A25 vs #2F386E) / 후: 살구 위에만 찍음"},
}
# 실제 렌더에서 잰 눈 대비(1x, 라이트): 눈 칸 안 가장 어두운 픽셀 vs 얼굴 칸
measured = {}
for which in ("before", "after"):
    cr = crops(which, "light")
    for n in SIZES:
        im = cr[(n, "normal")]
        if which == "before":
            ex, ey, r = 135 * n / 420, 240 * n / 420, 30 * n / 420
            fx, fy = 110 * n / 420, 292 * n / 420
        else:
            d, lx, rx, cy = LAYOUT[n]; ex, ey, r = lx, cy, d / 2
            fx, fy = lx, cy + d / 2 + 0.6
        box = [im.getpixel((x, y)) for x in range(int(ex - r), int(ex + r) + 1) for y in range(int(ey - r), int(ey + r) + 1) if 0 <= x < n and 0 <= y < n]
        dark = min(box, key=lum)
        face = im.getpixel((int(fx), int(fy)))
        measured.setdefault(str(n), {})[which] = {"eye_px": "#%02X%02X%02X" % dark[:3], "face_px": "#%02X%02X%02X" % face[:3], "ratio": ratio(dark, face)}
contrast["measured_eye_vs_face_1x"] = measured

# ---------- 4) 메뉴바 ----------
def load_rgba(name, n):
    d = icons if "-v2-" in name else icons_before
    return Image.frombytes("RGBA", (n, n), (d / f"{name}.rgba").read_bytes())
(out / "tray").mkdir(exist_ok=True)
before = {"t22": load_rgba("ravi-tray-template-22", 22), "t44": load_rgba("ravi-tray-template-44", 44), "c16": load_rgba("ravi-tray-16", 16), "c32": load_rgba("ravi-tray-32", 32)}
badge = before["c32"].copy()  # 앱 Rust tray_badge_image 를 그대로 흉내(32×32 위에 (26,6) 반지름²≤30 빨강)
for y in range(12):
    for x in range(20, 32):
        if (x - 26) ** 2 + (y - 6) ** 2 <= 30: badge.putpixel((x, y), (237, 99, 69, 255))
before["c32-alert"] = badge
for k, im in before.items(): im.save(out / "tray" / f"before-{k}.png")
after = {}
for box in (18, 22, 36, 44):
    for v in ("", "-alert", "-sleep"):
        after[f"t{box}{v}"] = load_rgba(f"ravi-tray-v2-template-{box}{v}", box)
for n in (16, 32):
    for v in ("", "-alert", "-sleep"):
        im = load_rgba(f"ravi-tray-v2-{n}{v}", n); after[f"c{n}{v}"] = im; im.save(out / "tray" / f"ravi-tray-v2-{n}{v}.png")
two_tone = all(set(im.getchannel("A").getdata()) <= {0, 255} for k, im in after.items() if k.startswith("t"))
two_tone_before = all(set(before[k].getchannel("A").getdata()) <= {0, 255} for k in ("t22", "t44"))
# 알림 점 틈: 점(오른쪽 위 원) 과 나머지 검정 사이 최소 거리(px, 체비쇼프)
def gap(im):
    a = im.getchannel("A"); n = im.width
    blk = {(x, y) for y in range(n) for x in range(n) if a.getpixel((x, y))}
    cx, cy, r = 15.5 * n / 18, 2.5 * n / 18, 2.6 * n / 18
    dot = {p for p in blk if (p[0] + .5 - cx) ** 2 + (p[1] + .5 - cy) ** 2 <= r * r}
    rest = blk - dot
    return min(max(abs(p[0] - q[0]), abs(p[1] - q[1])) for p in dot for q in rest) - 1, len(dot)
tray = {"two_tone_after": two_tone, "two_tone_before": two_tone_before,
        "alert_gap_px": {"18": gap(after["t18-alert"])[0], "36": gap(after["t36-alert"])[0]},
        "alert_dot_px": {"18": gap(after["t18-alert"])[1], "36": gap(after["t36-alert"])[1]},
        "template_vs_menubar": {"light(#ECECEE)": ratio("#000000", "#ECECEE"), "dark(#2A2A2E)": ratio("#FFFFFF", "#2A2A2E")},
        "before_alert": {"badge_vs_navy": ratio((237, 99, 69), "#2A356B"), "badge_vs_light_bar": ratio((237, 99, 69), "#ECECEE"), "badge_vs_dark_bar": ratio((237, 99, 69), "#2A2A2E"), "note": "전: 알림 때 템플릿을 끄고 색 아이콘 + 빨강 점(메뉴바 라이트/다크 자동 반전 없음)"},
        "before_template_eyes": "구멍(투명) — 머리 실루엣에 뚫린 두 구멍 = 해골 인상"}

def tint(im, color):
    c = Image.new("RGBA", im.size, color + (0,)); c.putalpha(im.getchannel("A")); return c
def menubar(theme, scale):
    H = 24 * scale; W = 300 * scale
    bg, fg = ((236, 236, 238), (0, 0, 0)) if theme == "light" else ((42, 42, 46), (255, 255, 255))
    bar = Image.new("RGBA", (W, H), bg + (255,)); dr = ImageDraw.Draw(bar)
    x = 8 * scale
    def put(im, label=None):
        nonlocal x
        bar.alpha_composite(im, (x, (H - im.height) // 2)); x += im.width + 10 * scale
    # 다른 앱 글리프 흉내(단순 도형 — 브랜드 아이콘 아님)
    dr.ellipse((W - 70 * scale, 6 * scale, W - 58 * scale, 18 * scale), outline=fg, width=scale)
    dr.rectangle((W - 50 * scale, 8 * scale, W - 30 * scale, 16 * scale), outline=fg, width=scale)
    dr.rectangle((W - 24 * scale, 7 * scale, W - 12 * scale, 17 * scale), fill=fg)
    t = "t44" if scale == 2 else "t22"
    put(tint(before[t], fg))
    c = before["c32"].resize((22 * scale, 22 * scale), Image.LANCZOS); put(c)
    put(before["c32-alert"].resize((22 * scale, 22 * scale), Image.LANCZOS))
    x += 14 * scale; dr.line((x - 12 * scale, 4 * scale, x - 12 * scale, H - 4 * scale), fill=(128, 128, 128), width=1)
    for v in ("", "-alert", "-sleep"): put(tint(after[f"t{44 if scale == 2 else 22}{v}"], fg))
    return bar
for theme in ("light", "dark"):
    for s in (1, 2):
        menubar(theme, s).save(out / f"menubar-{theme}-{s}x.png")

# 줄 그림(크기별 핵심 표정 6개) — 갤러리에서 1·2·4배로 확대
for theme in ("light", "dark"):
    for which in ("before", "after"):
        cr = crops(which, theme)
        for n in SIZES:
            strip = Image.new("RGB", (len(CORE) * (n + 6), n + 4), (247, 246, 243) if theme == "light" else (15, 16, 22))
            for i, m in enumerate(CORE): strip.paste(cr[(n, m)], (i * (n + 6) + 3, 2))
            strip.save(out / f"strip-{which}-{theme}-{n}.png")

metrics = {"eye_diameter_px": eye, "mood_distinct_pct": distinct, "contrast": contrast, "tray": tray,
           "big_unchanged": {"dom_same": sum(r["same"] for r in rep["bigSame"]), "of": len(rep["bigSame"]), "pixel_same": rep["bigPixelSame"]}}
(out / "metrics.json").write_text(json.dumps(metrics, ensure_ascii=False, indent=1))

# ---------- 갤러리 HTML ----------
def row_d(theme):
    r = []
    for n in SIZES:
        b, a = distinct[theme][str(n)]["before"], distinct[theme][str(n)]["after"]
        r.append(f"<tr><td>{n}px</td><td>{b['min_pct']} <small>{b['closest']}</small></td><td><b>{a['min_pct']}</b> <small>{a['closest']}</small></td><td>{b['normal~worried']}</td><td><b>{a['normal~worried']}</b></td><td>{b['mean_pct']}</td><td><b>{a['mean_pct']}</b></td></tr>")
    return "".join(r)
crow = "".join(f"<tr><td>{k}</td><td>{v.get('before')}</td><td><b>{v.get('after')}</b></td><td>≥{v.get('goal')}</td><td><small>{v.get('note', '')}</small></td></tr>" for k, v in contrast.items() if k != "measured_eye_vs_face_1x")
mrow = "".join(f"<tr><td>{n}px</td><td>{measured[str(n)]['before']['ratio']} <small>{measured[str(n)]['before']['eye_px']} / {measured[str(n)]['before']['face_px']}</small></td><td><b>{measured[str(n)]['after']['ratio']}</b> <small>{measured[str(n)]['after']['eye_px']} / {measured[str(n)]['after']['face_px']}</small></td></tr>" for n in SIZES)
erow = "".join(f"<tr><td>{n}px</td><td>{e['before_dark']} <small>(흰 테 포함 {e['before_with_ring']})</small></td><td><b>{e['after']}</b></td><td>≥{e['floor']}</td><td>{'통과' if e['pass'] else '미달'}</td></tr>" for n, e in eye.items())
def strips(theme):
    h = []
    for n in SIZES:
        cells = "".join(f"<figure><img src='strip-{w}-{theme}-{n}.png' style='width:{z * len(CORE) * (n + 6)}px'><figcaption>{'전' if w == 'before' else '후'} · {z}배</figcaption></figure>" for z in (1, 2, 4) for w in ("before", "after"))
        h.append(f"<h3>{n}px <small>평상·기쁨·걱정·졸림·놀람·사랑</small></h3><div class='strips'>{cells}</div>")
    return "".join(h)
tray_imgs = "".join(f"<figure><img class='tp' src='tray/{f}.png' style='width:{w}px'><figcaption>{c}</figcaption></figure>" for f, w, c in [
    ("before-t44", 88, "전 템플릿 44 (해골 인상)"), ("ravi-tray-v2-template-36", 72, "후 36 평상"), ("ravi-tray-v2-template-36-alert", 72, "후 36 알림"), ("ravi-tray-v2-template-36-sleep", 72, "후 36 졸림"),
    ("ravi-tray-v2-template-18", 72, "후 18 (4배)"), ("ravi-tray-v2-template-18-alert", 72, "후 18 알림 (4배)"), ("ravi-tray-v2-template-18-sleep", 72, "후 18 졸림 (4배)"),
    ("before-c32", 64, "전 색 32"), ("before-c32-alert", 64, "전 색 32 알림"), ("ravi-tray-v2-32", 64, "후 색 32"), ("ravi-tray-v2-32-alert", 64, "후 색 32 알림"), ("ravi-tray-v2-16", 64, "후 색 16 (4배)")])
html = f"""<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>라비 작은 아이콘</title>
<style>
:root{{--bg:#F7F6F3;--panel:#FFFFFF;--text:#1B1A25;--muted:#5C5A66;--line:#E2E0DA;--tp:#ECECEE}}
@media (prefers-color-scheme: dark){{:root:not([data-theme="light"]){{--bg:#0F1016;--panel:#15161D;--text:#ECEDF3;--muted:#A3A7B7;--line:#2A2D3A;--tp:#2A2A2E}}}}
:root[data-theme="dark"]{{--bg:#0F1016;--panel:#15161D;--text:#ECEDF3;--muted:#A3A7B7;--line:#2A2D3A;--tp:#2A2A2E}}
body{{margin:0;padding:16px;background:var(--bg);color:var(--text);font:15px/1.55 system-ui,-apple-system,"Apple SD Gothic Neo",sans-serif}}
main{{max-width:1100px;margin:0 auto}} h1{{font-size:24px;margin:0 0 4px}} h2{{font-size:19px;margin:28px 0 8px}} h3{{font-size:15px;margin:16px 0 6px}}
small{{color:var(--muted)}} img{{image-rendering:pixelated;display:block;max-width:none}}
.wrap{{overflow-x:auto}} table{{border-collapse:collapse;margin:6px 0 10px;font-size:14px}} td,th{{border-bottom:1px solid var(--line);padding:5px 10px;text-align:left;vertical-align:top}}
.strips{{display:flex;flex-wrap:wrap;gap:10px 16px;align-items:flex-end}} figure{{margin:0}} figcaption{{font-size:12px;color:var(--muted)}}
.tray{{display:flex;flex-wrap:wrap;gap:14px}} .tp{{background:var(--tp)}} .card{{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:12px 14px;margin:10px 0}}
</style></head><body><main>
<h1>라비 작은 얼굴 · 메뉴바 아이콘</h1>
<p><small>큰 얼굴(33px 이상)은 그대로 — 변경 전·후 DOM 일치 {metrics['big_unchanged']['dom_same']}/{metrics['big_unchanged']['of']}, 화면 픽셀 일치 {'예' if rep['bigPixelSame'] else '아니오'}. 16~32px 만 손맞춤 그림으로 바뀜. 모든 그림은 실제 Chrome 렌더.</small></p>
<div class="card"><b>한눈에</b> — 라이트 · 2배 실제 렌더(전 → 후)<div class="wrap"><img src="sheet-before-light-2x.png" style="width:644px;image-rendering:auto"><img src="sheet-after-light-2x.png" style="width:644px;image-rendering:auto"></div></div>
<div class="card"><b>다크</b><div class="wrap"><img src="sheet-before-dark-2x.png" style="width:644px;image-rendering:auto"><img src="sheet-after-dark-2x.png" style="width:644px;image-rendering:auto"></div></div>
<h2>크기별 1·2·4배 확대 (라이트)</h2><div class="wrap">{strips('light')}</div>
<h2>크기별 1·2·4배 확대 (다크)</h2><div class="wrap">{strips('dark')}</div>
<h2>돈·보안 경고 감정은 진지하게 (감정 엔진 경로, 20·24·32px)</h2><div class="wrap"><img src="emotions-light.png" style="width:640px;image-rendering:auto"><img src="emotions-dark.png" style="width:640px;image-rendering:auto"></div>
<h2>메뉴바 모의 (왼쪽 셋 = 지금: 템플릿·색·색+알림 / 오른쪽 셋 = 새 템플릿: 평상·알림·졸림)</h2>
<div class="wrap"><img src="menubar-light-2x.png" style="width:600px;image-rendering:auto"><img src="menubar-dark-2x.png" style="width:600px;image-rendering:auto"><img src="menubar-light-1x.png" style="width:300px"><img src="menubar-dark-1x.png" style="width:300px"><img src="menubar-light-1x.png" style="width:1200px"><img src="menubar-dark-1x.png" style="width:1200px"></div>
<h2>트레이 파일</h2><div class="tray">{tray_imgs}</div>
<p><small>템플릿 2톤(알파 0/255만): 후 {'예' if two_tone else '아니오'} · 알림 점 틈 18px={tray['alert_gap_px']['18']}px, 36px={tray['alert_gap_px']['36']}px</small></p>
<h2>수치</h2>
<h3>눈 지름 (px)</h3><div class="wrap"><table><tr><th>크기</th><th>전(어두운 눈동자)</th><th>후</th><th>목표</th><th></th></tr>{erow}</table></div>
<h3>표정 구별 — 칸끼리 평균 픽셀 차이 % (라이트, 클수록 구별 쉬움)</h3><div class="wrap"><table><tr><th>크기</th><th>전 최소 짝</th><th>후 최소 짝</th><th>전 평상~걱정</th><th>후 평상~걱정</th><th>전 평균</th><th>후 평균</th></tr>{row_d('light')}</table></div>
<h3>표정 구별 (다크)</h3><div class="wrap"><table><tr><th>크기</th><th>전 최소 짝</th><th>후 최소 짝</th><th>전 평상~걱정</th><th>후 평상~걱정</th><th>전 평균</th><th>후 평균</th></tr>{row_d('dark')}</table></div>
<h3>대비 (WCAG) — 설계 색</h3><div class="wrap"><table><tr><th>짝</th><th>전</th><th>후</th><th>목표</th><th></th></tr>{crow}</table></div>
<h3>대비 — 실제 1x 렌더에서 잰 눈(가장 어두운 칸) vs 얼굴</h3><div class="wrap"><table><tr><th>크기</th><th>전</th><th>후</th></tr>{mrow}</table></div>
</main></body></html>"""
(out / "index.html").write_text(html)
json.dump({k: metrics[k] for k in ("eye_diameter_px", "contrast", "tray", "big_unchanged")}, sys.stdout, ensure_ascii=False, indent=1)
print()
for th in ("light", "dark"):
    for n in SIZES:
        b, a = distinct[th][str(n)]["before"], distinct[th][str(n)]["after"]
        print(th, n, "min", b["min_pct"], b["closest"], "->", a["min_pct"], a["closest"], "| n~w", b["normal~worried"], "->", a["normal~worried"], "| mean", b["mean_pct"], "->", a["mean_pct"])
