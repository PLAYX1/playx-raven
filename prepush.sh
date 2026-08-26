#!/usr/bin/env bash
# 🔴 **올릴 나무를 그대로 검사한다.** 내 작업 폴더가 아니라.
#
# ## 왜 있나
#
# 이 저장소는 공유 색인을 안 건드리려고 임시 GIT_INDEX_FILE + commit-tree 로
# 올린다(동시 세션 충돌 방지). 그 방식의 대가가 하나 있다: **올릴 파일을
# 손으로 적어야 한다.** 하나 빠뜨리면 내 컴퓨터에서는 멀쩡한데 올라간 판은
# 깨진다. 부르는 쪽만 가고 받는 쪽이 안 가기 때문이다.
#
# 2026-08-26 하루에 세 번 밟았다:
#   · blockcache.ts 누락      → 웹 배포가 죽음
#   · talk.rs·autostart.rs 누락 → 앱 빌드 네 개가 전부 죽음
#   · lib.rs 누락 (0.1.48)     → preflight 가 잡아서 배포는 막힘
#
# 셋 다 **올리기 전에 알 수 있었다.** 나무를 꺼내 검사만 하면 된다.
#
# 쓰는 법:  ./prepush.sh <tree-ish>
set -euo pipefail
TREE="${1:?올릴 나무(tree 또는 commit)를 주십시오}"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

git archive "$TREE" | tar -x -C "$TMP"

# preflight 는 부르는 쪽과 받는 쪽이 같은 이름을 쓰는지 본다.
# 여기서 돌리면 **올라갈 파일들끼리** 맞는지 보게 된다.
( cd "$TMP" && node preflight.mjs )

echo "✅ 올릴 나무가 검사를 통과했습니다"
