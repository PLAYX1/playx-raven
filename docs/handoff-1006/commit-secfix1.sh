#!/usr/bin/env bash
set -euo pipefail
cd /Users/gimmusong/wt-rv-secfix1
[ "$(git branch --show-current)" = claude/secfix1 ]
[ "$(git rev-parse HEAD)" = ced2bdaa50402ea2928fbfb592b13ac96b35c17d ]
git diff --cached --quiet
node scripts/build-wallet-integrity.mjs --check
node --test docs/handoff-1006/secfix1.test.mjs
git -c core.splitIndex=false add -- \
 preflight.mjs scripts/build-wallet-integrity.mjs scripts/check-wallet-manifest.mjs \
 scripts/check-desktop-integration.mjs scripts/check-send-confirmation.mjs \
 src-tauri/capabilities/default.json src-tauri/src/payout_guard.rs \
 src-tauri/src/devfee.rs src-tauri/src/lib.rs src-tauri/src/pairing.rs \
 src-tauri/src/pairing/desk.rs src-tauri/src/pairing/net.rs src-tauri/src/pairing/proto.rs \
 src-tauri/src/send.rs src-tauri/src/server.rs src-tauri/src/tunnel.rs \
 src-tauri/src/vending.rs src-tauri/src/words_restore.rs \
 src/main.ts src/pairing-ui.ts src/words-restore.ts \
 web/build.sh web/wallet.bundle.js web/wallet.html web/wallet.src.ts \
 web/wallet-integrity.js web/wallet-integrity.json docs/handoff-1006
git diff --cached --check
# Do not allow repository hooks to publish or deploy as a side effect.
git -c core.splitIndex=false -c core.hooksPath=/dev/null commit \
 -m "fix: harden wallet vault and signing; block uncertain payout retries"
