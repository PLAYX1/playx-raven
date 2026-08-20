#!/bin/bash
# 지갑 번들을 만드는 **유일한** 방법.
#
# 🔴 --inject:buffer-shim.ts 를 빼면 번들이 브라우저에서 실행되기도 전에
#    "Buffer is not defined" 로 죽는다. 화면은 "지갑을 여는 중…" 에서 멈추고
#    오류는 콘솔에만 남아, 폰에서는 그냥 빈 화면으로 보인다.
#    2026-08-20 에 이걸로 지갑을 두 번 죽였다. 명령을 손으로 다시 짓지 말고
#    이 파일을 쓸 것.
set -e
cd "$(dirname "$0")"
../node_modules/.bin/esbuild wallet.src.ts \
  --bundle --format=iife --target=es2020 --minify \
  --inject:buffer-shim.ts \
  --outfile=wallet.bundle.js

# 만든 즉시 확인한다. Buffer 가 안 들어가면 여기서 멈춘다.
grep -q "Buffer" wallet.bundle.js || { echo "🔴 Buffer 가 번들에 없습니다"; exit 1; }
n=$(wc -c < wallet.bundle.js)
[ "$n" -gt 650000 ] || { echo "🔴 번들이 너무 작습니다($n) — 뭔가 빠졌습니다"; exit 1; }
echo "지갑 번들 $n 바이트"
