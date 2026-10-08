#!/usr/bin/env bash
set -euo pipefail
cd /Users/gimmusong/wt-rv-desktop-084
if [[ "$(git branch --show-current)" != 'claude/rv-desktop-084' ]]; then
  echo 'claude/rv-desktop-084 브랜치에서 실행해 주세요.' >&2
  exit 1
fi
if ! git diff --cached --quiet; then
  echo '이미 stage된 변경이 있습니다. 다른 작업을 섞지 않도록 먼저 확인해 주세요.' >&2
  exit 1
fi
npm test
npm run typecheck
npm run check:pre-release
git diff --check
git add -- \
  CHANGELOG.md index.html package.json package-lock.json \
  core/crypto-backend.ts core/official-sales/xpub.ts \
  core/playx-asset-proof/crypto.ts core/wallet-offline/base58check.ts \
  core/wallet-keys/derive.ts core/wallet-keys/sales-account.ts core/wallet-keys/PROVENANCE.md \
  scripts/release-manifest.mjs scripts/release-manifest.test.mjs \
  scripts/verify-published-release.mjs scripts/verify-published-release.test.mjs \
  scripts/signed-release-metadata.mjs scripts/signed-release-metadata.test.mjs \
  scripts/sales-account.test.mjs scripts/check-sales-browser.mjs scripts/fixtures/sales-public-vectors.json \
  src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/tauri.conf.json \
  src-tauri/src/identity.rs src-tauri/src/lib.rs src-tauri/src/raven.rs src-tauri/src/sales_account.rs \
  src/desktop-links.ts src/main.ts src/sales-account.ts src/sales-account.css \
  docs/handoff/commit-desktop-084.sh docs/handoff/release-084.md docs/handoff/desktop-084-report.md \
  docs/handoff/desktop-084-npm-tests.txt docs/handoff/desktop-084-typecheck.txt \
  docs/handoff/desktop-084-pre-release.txt docs/handoff/desktop-084-native-tests.txt \
  docs/handoff/desktop-084-update-tests.txt docs/handoff/desktop-084-secfix1-tests.txt \
  docs/handoff/desktop-084-cargo-check.txt docs/handoff/desktop-084-browser.json
git -c core.hooksPath=/dev/null commit -m 'feat(desktop): add protected sales account and prepare 0.8.4'
# No push, package, signing, notarization, deployment or transactions.
