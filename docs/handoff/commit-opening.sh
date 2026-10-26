#!/usr/bin/env bash
set -euo pipefail
cd /Users/gimmusong/wt-rv-desktop-084
if [[ "$(git branch --show-current)" != 'claude/rv-desktop-084' ]]; then
  echo '지정 브랜치가 아니므로 중단합니다.' >&2
  exit 1
fi
if ! git diff --cached --quiet; then
  echo '이미 스테이징된 변경이 있습니다. 다른 작업과 섞이지 않도록 먼저 확인해 주세요.' >&2
  exit 1
fi
# 기존 desktop-084 브라우저 증거 파일은 포함하지 않습니다.
git add -- \
  package.json \
  scripts/check-firstrun.mjs scripts/check-ravi-companion.mjs \
  scripts/check-opening-browser.mjs scripts/opening.test.mjs \
  src/dict.ts src/firstrun.ts src/main.ts src/ravi-agent.ts \
  src/ravi-companion.ts src/ravi-home.css src/ravi-home.ts src/ravi-rig.ts \
  src/ravi-choreography.ts src/ravi-opening.ts \
  src/ravi-lifecycle.ts src/ravi-lifecycle.css src/ravi-lifecycle-copy.ts \
  src-tauri/src/lib.rs src-tauri/src/publicbook.rs src-tauri/src/raven.rs \
  src-tauri/src/ravi_companion.rs src-tauri/src/ravi_lifecycle.rs \
  docs/handoff/opening-report.md docs/handoff/opening-art-needs.md \
  docs/handoff/opening-checks docs/handoff/opening-captures \
  docs/handoff/commit-opening.sh
git -c core.hooksPath=/dev/null commit -m "Refine Ravi rig opening, quit confirmation, and idle privacy"
