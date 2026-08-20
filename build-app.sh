#!/bin/bash
# PLAY X Raven 앱을 만드는 **유일한** 방법.
#
# 🔴 tauri build 만으로는 게이트키퍼가 "손상되었기 때문에 열 수 없습니다" 를
#    띄운다. Tauri 가 만든 번들은 자원을 봉인(seal)하지 않아서 서명이 깨진
#    것으로 판정된다(Sealed Resources=none). 그건 신뢰의 문제가 아니라 파일이
#    깨진 것으로 취급되어, **보안 설정에 「그래도 열기」 버튼이 안 나온다.**
#
#    임시서명을 제대로 다시 걸면 Sealed Resources 가 채워지고 판정이
#    "확인되지 않은 개발자" 로 내려온다 — 그건 사람이 보안 설정에서 열 수 있다.
#    실측으로 확인했다(2026-08-20).
#
# 애플 개발자 등록($99)을 하면 이 단계가 진짜 서명으로 바뀌고 그때는 더블클릭
# 한 번에 열린다. 그 전까지는 이게 최선이다.
set -e
cd "$(dirname "$0")"
MODE="${1:-debug}"
[ "$MODE" = "release" ] && FLAG="" || FLAG="--debug"

NODE_OPTIONS=--max-old-space-size=8192 npx tauri build $FLAG --bundles app

APP="src-tauri/target/$MODE/bundle/macos/PLAY X Raven.app"
[ -d "$APP" ] || { echo "🔴 번들이 없습니다: $APP"; exit 1; }

codesign --force --deep --sign - "$APP"
codesign --verify --deep --strict "$APP" || { echo "🔴 서명 검증 실패"; exit 1; }

sealed=$(codesign -dvv "$APP" 2>&1 | grep -c "Sealed Resources version")
[ "$sealed" -ge 1 ] || { echo "🔴 자원이 봉인되지 않았습니다 — 받는 사람이 '손상됨' 을 봅니다"; exit 1; }

echo "만듦: $APP (임시서명 · 자원 봉인됨)"
