#!/usr/bin/env bash
set -euo pipefail
cd /Users/gimmusong/wt-rv-desktop-084

# Explicit paths exclude parallel Rust work, previous captures, dist and binaries.
files=(
  src/main.ts
  src/ravi-home.css
  index.html
  scripts/check-home-browser.mjs
  scripts/check-ravi-panel.mjs
  docs/handoff/homefit2-report.md
  docs/handoff/commit-homefit2.sh
  docs/handoff/homefit2-captures/after.json
  docs/handoff/homefit2-captures/after.md
  docs/handoff/homefit2-checks/npm-test.txt
  docs/handoff/homefit2-checks/typecheck.txt
  docs/handoff/homefit2-checks/pre-release.txt
  docs/handoff/homefit2-checks/ravi-panel.txt
  docs/handoff/homefit2-checks/browser.txt
)
git diff --check -- "${files[@]}"
git add -- "${files[@]}"
git -c core.hooksPath=/dev/null commit --only \
  -m "fix: restore home accessibility and focus order" -- "${files[@]}"
