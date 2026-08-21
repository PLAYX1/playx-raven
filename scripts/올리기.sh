#!/usr/bin/env bash
# 이 맥에서 만든 **애플 실리콘** 설치 파일을 공개 저장소에 올린다.
#
# 🔴 왜 손으로 하나 — 깃허브에서 맥을 돌리면 분(分)이 10배로 깎인다.
# 실측: 리눅스 18분×1=18 · 윈도우 22분×2=44 · 맥 20분×10=200.
# 맥 둘을 다 돌리면 한 번에 462분이라 무료 2,000분으로 넉 달치다.
# 애플 실리콘은 어차피 이 맥이 만들 수 있으니 여기서 만든다.
#
# ⚠️ 이걸 잊으면 **맥 사장만 옛 판을 받는다.** 윈도우·리눅스는 깃허브가
# 알아서 새로 올리는데 맥만 안 올라가고, 화면에는 아무 표시도 안 난다.
# 그래서 아래에서 저쪽에 올라간 판 번호와 **대조**한다.
#
# 쓰는 법:  bash scripts/올리기.sh 0.1.1
set -euo pipefail

V="${1:-}"
if [ -z "$V" ]; then
  echo "판 번호를 적어 주세요.  예:  bash scripts/올리기.sh 0.1.1" >&2
  exit 1
fi

HERE="$(cd "$(dirname "$0")/.." && pwd)"
KEY="$HOME/.playx-raven/releases_deploy"
[ -f "$KEY" ] || { echo "🔴 배포 열쇠가 없습니다: $KEY" >&2; exit 1; }

echo "── 만드는 중 (애플 실리콘) ──"
cd "$HERE"
npx tauri build

APP="src-tauri/target/release/bundle/macos/PLAY X Raven.app"
[ -d "$APP" ] || { echo "🔴 앱이 안 만들어졌습니다" >&2; exit 1; }

# 🔴 tauri 가 만든 서명은 깨져 있다("code has no resources but signature
#    indicates they must be present"). 그대로 두면 사장 화면에 **"손상되었습니다"**
#    가 뜨고, 그건 우클릭으로도 못 여는 상태다 — 되돌릴 방법이 없다.
#    "확인되지 않은 개발자" 는 우클릭으로 열리니 그쪽이 낫다.
echo "── 서명 다시 ──"
codesign --force --deep --sign - "$APP"
codesign --verify --deep --strict "$APP" || { echo "🔴 서명이 여전히 깨졌습니다" >&2; exit 1; }

echo "── 담는 중 ──"
STAGE="$(mktemp -d)/stage"
mkdir -p "$STAGE"
cp -R "$APP" "$STAGE/"
ln -s /Applications "$STAGE/Applications"
DMG="/tmp/PLAY-X-Raven-${V}-mac-apple-silicon.dmg"
rm -f "$DMG"
hdiutil create -volname "PLAY X Raven" -srcfolder "$STAGE" -ov -format UDZO "$DMG" >/dev/null

# 담은 뒤 **안의 앱을 다시 검사한다.** 담는 과정에서 깨질 수 있고, 그건
# 사장 컴퓨터에서야 드러난다.
hdiutil attach "$DMG" -nobrowse -quiet -mountpoint /tmp/pxrchk
codesign --verify --deep --strict "/tmp/pxrchk/PLAY X Raven.app" \
  || { hdiutil detach /tmp/pxrchk -quiet; echo "🔴 담은 뒤 서명이 깨졌습니다" >&2; exit 1; }
hdiutil detach /tmp/pxrchk -quiet
echo "  $(basename "$DMG") $(( $(stat -f%z "$DMG") / 1048576 ))MB · 서명 정상"

echo "── 올리는 중 ──"
WORK="$(mktemp -d)"
export GIT_SSH_COMMAND="ssh -i $KEY -o IdentitiesOnly=yes"
git clone -q --depth 1 --branch dist \
  git@github.com:PLAYX1/playx-raven-releases.git "$WORK/pub" 2>/dev/null \
  || git clone -q --depth 1 git@github.com:PLAYX1/playx-raven-releases.git "$WORK/pub"
cd "$WORK/pub"

# ⚠️ 저쪽이 다른 판이면 섞인 채로 올라간다. 맥만 새 판이고 나머지가 옛 판이면
#    사장마다 다른 프로그램을 쓰게 된다 — 그건 조용히 벌어지는 사고다.
OTHER="$(ls PLAY-X-Raven-*-windows.* PLAY-X-Raven-*-linux.* 2>/dev/null \
  | sed -E 's/PLAY-X-Raven-([0-9.]+)-.*/\1/' | sort -u | head -1 || true)"
if [ -n "$OTHER" ] && [ "$OTHER" != "$V" ]; then
  echo "🔴 저쪽은 $OTHER 판인데 지금 $V 를 올리려 합니다." >&2
  echo "   먼저 깃허브에서 $V 를 만드세요:" >&2
  echo "   gh workflow run '설치 파일 만들기' --repo PLAYX1/playx-raven -f version=$V" >&2
  exit 1
fi

# 옛 맥 파일은 치운다. 두 판이 나란히 있으면 어느 것을 눌러야 하는지 모른다.
rm -f PLAY-X-Raven-*-mac-apple-silicon.dmg
cp "$DMG" .
# 해시 목록을 다시 만든다. 안 하면 맥 파일만 목록에 없거나 옛 값이 남는다.
shasum -a 256 PLAY-X-Raven-* > SHA256SUMS.txt
git add -A
git -c user.name=playx1 -c user.email=playexercise@gmail.com \
  commit -q -m "맥(애플 실리콘) $V"
git push -q origin HEAD:dist
echo "  올렸습니다."
echo
echo "🔴 남은 일: 랜딩의 맥 단추와 해시를 새 값으로 바꾸세요."
echo "   sha256: $(shasum -a 256 "$DMG" | cut -d' ' -f1)"
