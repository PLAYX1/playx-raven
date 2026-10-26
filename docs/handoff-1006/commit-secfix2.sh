#!/usr/bin/env bash
set -eu
cd /Users/gimmusong/wt-rv-secfix1
[ "$(git branch --show-current)" = claude/secfix1 ] || { echo "브랜치가 다릅니다." >&2; exit 1; }
[ "$(git rev-parse HEAD)" = 2a2d8b81a7053e0cba9f9fe2f80e66aa5c54f4be ] || { echo "기준 HEAD가 바뀌었습니다." >&2; exit 1; }
git diff --cached --quiet || { echo "기존 staged 변경이 있어 중단합니다." >&2; exit 1; }
git -c core.hooksPath=/dev/null add -- \
  docs/handoff-1006/commit-secfix2.sh \
  docs/handoff-1006/run-secfix2-payout-harness.py \
  docs/handoff-1006/run-secfix2-rust.py \
  docs/handoff-1006/secfix1.test.mjs \
  docs/handoff-1006/secfix2-auto-red.txt \
  docs/handoff-1006/secfix2-build.txt \
  docs/handoff-1006/secfix2-cargo-check.txt \
  docs/handoff-1006/secfix2-floor-red.txt \
  docs/handoff-1006/secfix2-guard-tests.txt \
  docs/handoff-1006/secfix2-node-tests.txt \
  docs/handoff-1006/secfix2-outpoint-red.txt \
  docs/handoff-1006/secfix2-payout-harness-results.txt \
  docs/handoff-1006/secfix2-red.txt \
  docs/handoff-1006/secfix2-remote-tests.txt \
  docs/handoff-1006/secfix2-report.md \
  docs/handoff-1006/secfix2-rust-all.txt \
  docs/handoff-1006/secfix2-send-red.txt \
  docs/handoff-1006/secfix2-send.test.mjs \
  docs/handoff-1006/secfix2-update-tests.txt \
  docs/handoff-1006/secfix2-wiring.test.mjs \
  scripts/prepare-update-statement.py \
  src-tauri/Cargo.lock \
  src-tauri/Cargo.toml \
  src-tauri/src/auto.rs \
  src-tauri/src/lib.rs \
  src-tauri/src/payout_guard.rs \
  src-tauri/src/remote_sales.rs \
  src-tauri/src/secure_update.rs \
  src-tauri/src/update_policy.rs \
  src/main.ts
git -c core.hooksPath=/dev/null commit -m 'fix: persist remote sale outbox and enforce signed update versions'
