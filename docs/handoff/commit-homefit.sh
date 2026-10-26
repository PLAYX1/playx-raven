#!/usr/bin/env bash
set -euo pipefail
cd /Users/gimmusong/wt-rv-desktop-084
if [[ "$(git branch --show-current)" != 'claude/rv-desktop-084' ]]; then
  echo '지정 브랜치가 아니므로 중단합니다.' >&2
  exit 1
fi
if ! git diff --cached --quiet; then
  echo '다른 스테이징 변경이 있어 섞이지 않도록 중단합니다.' >&2
  exit 1
fi
git add -- \
  index.html package.json src/main.ts src/ravi-home.css src/ravi-panel.ts \
  scripts/check-home-browser.mjs scripts/check-home-onescreen.mjs scripts/check-ravi-panel.mjs \
  artifacts/home-onescreen/arithmetic.json \
  docs/handoff/homefit-report.md docs/handoff/commit-homefit.sh \
  docs/handoff/home-captures
# Repository ignores *.log globally; include only this task's synthetic checks.
git add -f -- docs/handoff/homefit-checks/*.log
git -c core.hooksPath=/dev/null commit -m "Fit desktop home into a compact grid and add production browser geometry checks"
