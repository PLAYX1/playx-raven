"""라비 메뉴바(트레이) 템플릿 아이콘 v2 — 표준 라이브러리만, 다시 돌리면 같은 바이트가 나온다.

macOS 템플릿 이미지 규칙: 검정(알파 255) + 투명(알파 0) 두 톤만. 시스템이 라이트/다크 메뉴바에 맞춰 뒤집는다.
옛 아이콘(ravi-tray-template-*.rgba)은 머리 실루엣을 칠하고 눈을 구멍으로 뚫어 「해골」처럼 보였다.
v2: 라비의 살구 얼굴 자리를 구멍으로, 눈·부리·리본·볏은 검정 — 검은 눈이 빈 얼굴 안에 떠 있으니 해골이 아니다.
  · 18px 은 칸마다 손으로 찍은 그림(아래 BASE18). 36px(@2x) 은 그 그림을 2배로 + 눈만 더 둥근 원(d=8)으로.
  · 리본은 머리와 1px(36: 2px) 틈 · 눈 둘레 1px 은 늘 투명(눈이 머리 테와 붙으면 눈구멍=해골)
  · 이마의 남색 V(두 눈 사이) 를 남겨 라비 얼굴 구조를 살림
  · 변형: normal(평상) · alert(알림 점 — 오른쪽 위, 머리를 1px 물어뜯는 점) · sleep(감은 눈 ∪ + z, 숨김/대기)
크기: 18·36 = 새 권장(메뉴바 글리프 18pt @1x/@2x), 22·44 = 앱이 지금 쓰는 칸(같은 그림을 가운데 두고 2/4px 여백).

출력(기존 파일은 덮어쓰지 않는다 — 교체는 보고서의 방법대로 별도로):
  src-tauri/icons/ravi-tray-v2-template-{18,36,22,44}[-alert|-sleep].rgba   (RGBA 8bit 행 우선 — 앱이 include_bytes 하는 형식과 같음)
  artifacts/small-icons/tray/*.png   (같은 그림 PNG — 갤러리·눈 확인용)
사용: python3 scripts/generate-ravi-tray-v2.py
"""
import os, struct, zlib
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
# RV_TRAY_DIR / RV_SMALL_OUT: 시험용 출력 위치(기본은 앱 아이콘 폴더·갤러리 폴더)
ICONS = Path(os.environ.get("RV_TRAY_DIR", ROOT / "src-tauri/icons"))
PNGS = Path(os.environ.get("RV_SMALL_OUT", ROOT / "artifacts/small-icons")) / "tray"

# 18×18. '#' = 검정. 눈은 따로 찍는다(변형마다 다름). 왼쪽 위 = 리본(머리와 1px 틈), 위 = 볏 두 가닥.
BASE18 = [
    "#...#...#..#......",
    "##.##...##.##.....",
    "#####.##########..",
    "##.##.###########.",
    "#...#.############",
    "......############",
    "##......##......##",
    "##......##......##",
    "##..............##",
    "##..............##",
    "##..............##",
    "##.....####.....##",
    ".##.....##.....##.",
    ".##............##.",
    "..##..........##..",
    "...###......###...",
    ".....########.....",
    "..................",
]
EYES18 = ((5, 9), (13, 9))  # 지름 4 원의 중심(짝수 지름 → 정수 중심)
Z18 = ["####", "..#.", ".#..", "####"]


def disc(cx, cy, d):
    r = d / 2 + .05
    return {(x, y) for y in range(int(cy - d) - 1, int(cy + d) + 2) for x in range(int(cx - d) - 1, int(cx + d) + 2)
            if (x + .5 - cx) ** 2 + (y + .5 - cy) ** 2 <= r * r}


def dilate(px, r):
    return {(x + dx, y + dy) for x, y in px for dx in range(-r, r + 1) for dy in range(-r, r + 1)}


def art(rows, ox=0, oy=0):
    return {(ox + x, oy + y) for y, row in enumerate(rows) for x, c in enumerate(row) if c == "#"}


def glyph(n, variant):
    s = n // 18  # 1 또는 2
    base = {(x * s + i, y * s + j) for x, y in art(BASE18) for i in range(s) for j in range(s)}
    eyes = set()
    for ex, ey in EYES18:
        cx, cy, d = ex * s, ey * s, 4 * s
        if variant == "sleep":
            # 감은 눈 ∪: 원의 아래 테두리(굵기 s)
            ring = disc(cx, cy, d) - disc(cx, cy - s, d)
            eyes |= {(x, y) for x, y in ring if y >= cy}
        else:
            eyes |= disc(cx, cy, d)
    black = (base - dilate(eyes, s if variant != "sleep" else 0)) | eyes
    if variant == "alert":
        dot = disc(15.5 * s, 2.5 * s, 5 * s)
        black = (black - dilate(dot, s)) | dot
    if variant == "sleep":
        z = {(x * s + i, y * s + j) for x, y in art(Z18, 13, 0) for i in range(s) for j in range(s)}
        black = (black - dilate(z, s)) | z
    return {(x, y) for x, y in black if 0 <= x < n and 0 <= y < n}


def pad(px, n, m):
    o = (m - n) // 2
    return {(x + o, y + o) for x, y in px}


def rgba(px, n):
    out = bytearray(n * n * 4)
    for x, y in px:
        i = (y * n + x) * 4
        out[i:i + 4] = b"\x00\x00\x00\xff"
    return bytes(out)


def png(raw, n):
    rows = b"".join(b"\x00" + raw[y * n * 4:(y + 1) * n * 4] for y in range(n))
    chunk = lambda t, d: struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xffffffff)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", n, n, 8, 6, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(rows, 9)) + chunk(b"IEND", b"")


def main():
    assert all(len(r) == 18 for r in BASE18) and len(BASE18) == 18
    PNGS.mkdir(parents=True, exist_ok=True)
    ICONS.mkdir(parents=True, exist_ok=True)
    written = []
    for variant in ("normal", "alert", "sleep"):
        suffix = "" if variant == "normal" else f"-{variant}"
        for n, box in ((18, 18), (36, 36), (18, 22), (36, 44)):
            raw = rgba(pad(glyph(n, variant), n, box), box)
            name = f"ravi-tray-v2-template-{box}{suffix}"
            (ICONS / f"{name}.rgba").write_bytes(raw)
            (PNGS / f"{name}.png").write_bytes(png(raw, box))
            written.append(name)
    print("ok", len(written), "files")


if __name__ == "__main__":
    main()
