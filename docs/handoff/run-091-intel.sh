#!/bin/bash
# 레이븐볼트 데스크탑 0.9.1 — 맥 두 대상(Apple Silicon + Intel) 따로 빌드 · 코드 서명 · 공증 · 업데이트 명세 서명
# run-090.sh 를 바탕으로 했다. 업로드(4단계)는 하지 않는다 — 끝에서 대표가 직접.
#
# 왜 0.9.1 인가: scripts/release-manifest.mjs 가 이미 있는 판(v0.9.0/)에 파일을 더하는 것을 막는다
#   ("Version already exists; use a new version"). 0.9.0 에 인텔만 덧붙일 수 없다.
# 왜 따로 빌드(권장안 A)인가: 유니버설 한 파일은 압축본이 약 128MB 로 커져
#   release-manifest·verify-published-release 의 파일 상한(95,000,000 바이트)과 GitHub 파일 한도(100MB)를 넘는다.
#   자세한 비교: ~/Desktop/레이븐볼트-인텔맥-빌드-준비.md
#
# 쓰는 법 (키 값은 화면/기록에 남기지 않는다. set -x 금지):
#   export RV_WANT_SHA=<0.9.1 로 올린 뒤 빌드할 커밋 SHA 앞 7자리 이상>   # 기본값 없음 — 꼭 정한다
#   export RV_WT=<그 커밋이 체크아웃된 작업 폴더>                         # 기본: /Users/gimmusong/wt-rv-desktop-091-intel
#   export RV_NOTARY_PROFILE="<notarytool 키체인 프로필 이름>"
#   export RV_UPDATE_KEY_FILE="<업데이트 서명 키 파일 경로>"
#   export RV_UPDATE_KEY_PASSWORD="<비밀번호>"      # 없으면 실행 중 숨김 입력으로 물어봄 (빈 값 가능)
#   (선택) export APPLE_SIGNING_IDENTITY="Developer ID Application: MOOSONG KIM (FSF7LXFW6L)"
#   (선택) export RV_SEQ=2026101302                  # 2026101301(0.9.0 서명 명세) 보다 커야 함. 두 대상이 같은 값을 쓴다
#   (선택) export RV_ARCHS="aarch64 x86_64"          # 기본 둘 다. 한쪽만 다시 돌릴 때 "x86_64" 처럼
#   (선택) export RV_MIN_MACOS=12.0                  # 기본 비움(=설정 그대로 10.13). 문서 「위험」 참고 — 대표 결정 후에만
#   bash ~/rv-release-091-intel/run-091-intel.sh
#
# 실패 뒤 다시 돌릴 때만(처음 실행에는 쓰지 않는다). RV_ARCHS 로 그 대상만 고르는 것을 권한다:
#   RV_SKIP_BUILD=1     — 빌드가 끝난 뒤 공증 단계에서 멈췄을 때
#   RV_SKIP_NOTARIZE=1  — 공증 Accepted·스테이플까지 끝난 뒤 그 다음 단계에서 멈췄을 때
#
# 어디서 멈춰도 같은 명령을 다시 돌리면 된다(앞 단계는 다시 한다). 틀리면 즉시 멈춘다.
set -euo pipefail

VER=0.9.1
PREV_SEQ=2026101301   # 0.9.0 darwin-aarch64 공개 명세의 sequence (2026-10-12 latest.json 에서 확인)
WT="${RV_WT:-/Users/gimmusong/wt-rv-desktop-091-intel}"
OUT="$HOME/rv-release-091-intel"
VDL="$HOME/rv-release-084/vendor-dl"   # 0.8.4 때 받아 해시 대조한 공식 꾸러미(없으면 아래에서 공식 주소로 다시 받는다)
RUSTUP_BIN="$HOME/.rustup/toolchains/stable-aarch64-apple-darwin/bin"

say() { printf '\n== %s\n' "$*"; }
die() { printf '\n[중단] %s\n' "$*" >&2; exit 1; }

# 대상별 이름표 ─────────────────────────────────────────────────
rust_target() { echo "$1-apple-darwin"; }
upd_target()  { echo "darwin-$1"; }
label()       { case "$1" in aarch64) echo mac-apple-silicon ;; x86_64) echo mac-intel ;; esac; }
dmg_arch()    { case "$1" in aarch64) echo aarch64 ;; x86_64) echo x64 ;; esac; }
lipo_arch()   { case "$1" in aarch64) echo arm64 ;; x86_64) echo x86_64 ;; esac; }

# ── 0. 준비 확인 ────────────────────────────────────────────────
say "0. 준비 확인"
: "${RV_WANT_SHA:?RV_WANT_SHA 를 정하세요(0.9.1 로 올린 빌드 커밋 SHA). 기본값은 일부러 없습니다}"
: "${RV_NOTARY_PROFILE:?RV_NOTARY_PROFILE 을 정하세요(notarytool 키체인 프로필 이름)}"
: "${RV_UPDATE_KEY_FILE:?RV_UPDATE_KEY_FILE 을 정하세요(업데이트 서명 키 파일 경로)}"
[ -f "$RV_UPDATE_KEY_FILE" ] || die "업데이트 키 파일이 없습니다: $RV_UPDATE_KEY_FILE"
APPLE_SIGNING_IDENTITY="${APPLE_SIGNING_IDENTITY:-Developer ID Application: MOOSONG KIM (FSF7LXFW6L)}"
if [ -z "${RV_UPDATE_KEY_PASSWORD+x}" ]; then
  read -r -s -p "업데이트 키 비밀번호(없으면 그냥 Enter): " RV_UPDATE_KEY_PASSWORD; echo
fi
RV_SEQ="${RV_SEQ:-2026101302}"
[[ "$RV_SEQ" =~ ^[0-9]+$ ]] || die "RV_SEQ 는 숫자여야 합니다 (지금 $RV_SEQ)"
[ "$RV_SEQ" -gt "$PREV_SEQ" ] || die "RV_SEQ 는 $PREV_SEQ(0.9.0 서명 명세) 보다 커야 합니다 (지금 $RV_SEQ)"
RV_ARCHS="${RV_ARCHS:-aarch64 x86_64}"
for a in $RV_ARCHS; do case "$a" in aarch64|x86_64) ;; *) die "RV_ARCHS 에는 aarch64·x86_64 만 씁니다 (지금 $a)";; esac; done
N_ARCH=$(echo $RV_ARCHS | wc -w | tr -d ' ')
if [ -n "${RV_MIN_MACOS:-}" ]; then [[ "$RV_MIN_MACOS" =~ ^[0-9]+\.[0-9]+$ ]] || die "RV_MIN_MACOS 형식 오류: $RV_MIN_MACOS"; fi

FREE_GB=$(df -g "$HOME" | awk 'NR==2{print $4}')
# run-090: 한 대상 20GB. 대상 하나 더할 때마다 target/<대상>/ 에 약 12GB 를 더 쓴다.
NEED_GB=$(( 20 + 12 * (N_ARCH - 1) ))
[ "$FREE_GB" -ge "$NEED_GB" ] || die "디스크 여유 ${FREE_GB}GB — ${NEED_GB}GB 이상 필요(대상 $N_ARCH 개)"

[ -d "$WT/.git" ] || [ -f "$WT/.git" ] || die "작업 폴더가 git 작업 폴더가 아닙니다: $WT"
HEAD_SHA=$(git -C "$WT" rev-parse HEAD)
case "$HEAD_SHA" in "$RV_WANT_SHA"*) ;; *) die "작업 폴더 HEAD($HEAD_SHA) 가 RV_WANT_SHA($RV_WANT_SHA) 가 아닙니다";; esac
[ "${#RV_WANT_SHA}" -ge 7 ] || die "RV_WANT_SHA 는 7자리 이상"
# 추적 파일이 고쳐진 채로 빌드하지 않는다(artifacts/ 의 화면 캡처 변경은 빌드와 무관하므로 제외).
DIRTY=$(git -C "$WT" status --porcelain --untracked-files=no -- . ':!artifacts' | grep -v ' src-tauri/tauri.conf.json$' || true)
[ -z "$DIRTY" ] || die "작업 폴더에 커밋 안 된 변경이 있습니다:"$'\n'"$DIRTY"
for f in src-tauri/tauri.conf.json package.json; do
  grep -q "\"version\": \"$VER\"" "$WT/$f" || die "$f 버전이 $VER 이 아닙니다 (판 올림 커밋이 먼저)"
done
grep -qE "^version = \"$VER\"" "$WT/src-tauri/Cargo.toml" || die "Cargo.toml 버전이 $VER 이 아닙니다"
for l in it es fr pt-BR de ru; do [ -f "$WT/public/i18n/$l.json" ] || die "언어 사전 없음: $l"; done
security find-identity -v -p codesigning | grep -qF "$APPLE_SIGNING_IDENTITY" || die "코드 서명 신원을 찾지 못했습니다: $APPLE_SIGNING_IDENTITY"
(cd "$WT" && node scripts/i18n/check-packs.mjs >/dev/null) || die "언어 사전 검사 실패"
command -v lipo >/dev/null || die "lipo 가 없습니다(Xcode 명령행 도구 필요)"

# 러스트: Homebrew rustc 에는 x86_64-apple-darwin 표준 라이브러리가 없다(실측 2026-10-12).
# 두 대상 모두 rustup stable 로 빌드한다(0.8.4 인텔 빌드도 rustup 으로 성공).
if [ -x "$RUSTUP_BIN/rustc" ]; then export PATH="$RUSTUP_BIN:$PATH"; fi
SYSROOT=$(rustc --print sysroot)
for a in $RV_ARCHS; do
  [ -d "$SYSROOT/lib/rustlib/$(rust_target "$a")" ] || die "러스트 대상 $(rust_target "$a") 가 없습니다 — rustup target add $(rust_target "$a")"
done
echo "rustc: $(rustc -V)  ($SYSROOT)"
mkdir -p "$OUT"/{input,statements,checks,vendor}

# ── 0b. 포함 바이너리 준비 (공식 꾸러미 → 고정 해시 대조 → 꺼내기 → 아키텍처 확인) ──
# 출처·해시는 .github/workflows/release.yml 과 같은 값. 2026-10-12 공식 주소에서 다시 대조했다.
fetch_pkg() { # <로컬 파일> <URL>
  if [ ! -s "$1" ]; then
    mkdir -p "$(dirname "$1")"
    echo "받기: $2"
    curl -fsSL --retry 2 --retry-delay 3 --max-time 300 "$2" -o "$1.part" && mv "$1.part" "$1"
  fi
  [ -s "$1" ] || die "못 받았습니다: $2"
}
prepare_vendor() { # <arch>
  local a="$1" d="$OUT/vendor/$1" t node_url node_sha ipfs_url ipfs_sha512 got
  rm -rf "$d"; mkdir -p "$d"; t=$(mktemp -d)
  case "$a" in
    x86_64)
      node_url=https://github.com/RavenProject/Ravencoin/releases/download/v4.8.0/raven-4.8.0-225491298-osx64.tar.gz
      node_sha=8610c117476697e7f34dedf0b85bf8386c79ecebfa36740eedc1260c7d1d5c5a
      ipfs_url=https://github.com/ipfs/kubo/releases/download/v0.43.0/kubo_v0.43.0_darwin-amd64.tar.gz
      ipfs_sha512=7edd038e9208b8024ef14329102a8bc40827c21337bb2d38ea52400c57a04e3c092086a11c9d342b85083a71df4bf77130fd676bdb68628b2d9e8e6f511ee305
      fetch_pkg "$VDL/x64/node.pkg" "$node_url"; fetch_pkg "$VDL/x64/ipfs.pkg" "$ipfs_url"
      got=$(shasum -a 256 "$VDL/x64/node.pkg" | cut -d' ' -f1); [ "$got" = "$node_sha" ] || die "레이븐 노드(osx64) 해시 불일치: $got"
      got=$(shasum -a 512 "$VDL/x64/ipfs.pkg" | cut -d' ' -f1); [ "$got" = "$ipfs_sha512" ] || die "kubo darwin-amd64 해시 불일치"
      tar -xzf "$VDL/x64/node.pkg" -C "$t"
      cp "$(find "$t" -type f -path '*/bin/ravend' | head -1)" "$d/ravend"
      mkdir -p "$t/i"; tar -xzf "$VDL/x64/ipfs.pkg" -C "$t/i"
      cp "$(find "$t/i" -type f -name ipfs | head -1)" "$d/ipfs" ;;
    aarch64)
      # 공식 v4.8.0 에 애플 실리콘 판이 없어 우리가 소스(v4.8.0-2-g0894f15de, 수정 없음)에서 빌드해 올린 파일.
      node_url=https://github.com/PLAYX1/playx-raven-releases/releases/download/vendor-ravend-4.8.0/ravend-macos-arm64
      node_sha=d008e5ed56497dc394ce32e95f61a5e5b19fb59a0cbb5b6600c7aa3bc69a4806
      ipfs_url=https://github.com/ipfs/kubo/releases/download/v0.43.0/kubo_v0.43.0_darwin-arm64.tar.gz
      ipfs_sha512=2377bc886b340087b20d5a9bdd025e5a6ed4b7e910ac04fa0d0e26f5b7e189b31a33f6cc682c0aaec2695a65b8a38d1f5bfce505c2948c0ea08ee64009034ef6
      fetch_pkg "$VDL/arm64/node.pkg" "$node_url"; fetch_pkg "$VDL/arm64/ipfs.pkg" "$ipfs_url"
      got=$(shasum -a 256 "$VDL/arm64/node.pkg" | cut -d' ' -f1); [ "$got" = "$node_sha" ] || die "레이븐 노드(arm64) 해시 불일치: $got"
      got=$(shasum -a 512 "$VDL/arm64/ipfs.pkg" | cut -d' ' -f1); [ "$got" = "$ipfs_sha512" ] || die "kubo darwin-arm64 해시 불일치"
      cp "$VDL/arm64/node.pkg" "$d/ravend"
      mkdir -p "$t/i"; tar -xzf "$VDL/arm64/ipfs.pkg" -C "$t/i"
      cp "$(find "$t/i" -type f -name ipfs | head -1)" "$d/ipfs" ;;
  esac
  rm -rf "$t"
  chmod +x "$d/ravend" "$d/ipfs"
  for f in "$d/ravend" "$d/ipfs"; do
    [ "$(lipo -archs "$f")" = "$(lipo_arch "$a")" ] || die "$f 아키텍처가 $(lipo_arch "$a") 가 아닙니다: $(lipo -archs "$f")"
  done
  # 지금 붙어 있는 라이브러리가 맥 기본(libSystem·libc++) 뿐인지 — 홈브루에 물린 파일이면 남의 맥에서 안 돈다.
  if otool -L "$d/ravend" | tail -n +2 | grep -vqE '^\s+/usr/lib/|^\s+/System/'; then die "ravend 가 맥 기본 밖의 라이브러리를 씁니다"; fi
  shasum -a 256 "$d/ravend" "$d/ipfs" | tee "$OUT/checks/vendor-$a.sha256"
}

# ── 공통: 설정 원본 보관·복구 ────────────────────────────────────
cd "$WT"
# 원본은 작업 파일이 아니라 커밋에서 꺼낸다 — 지난 실행이 중간에 죽어 고친 설정이 남아 있어도 원본이 오염되지 않게.
git -C "$WT" show HEAD:src-tauri/tauri.conf.json > "$OUT/tauri.conf.json.orig"
restore() {
  cp "$OUT/tauri.conf.json.orig" "$WT/src-tauri/tauri.conf.json" 2>/dev/null || true
  rm -f "$WT/src-tauri/vendor/ravend" "$WT/src-tauri/vendor/ipfs" 2>/dev/null || true
}
trap restore EXIT

stale_mounts() {
  # 출력: <통째 장치>\t<image-path>\t<마운트 위치>   (붙어 있는 볼륨마다 한 줄)
  hdiutil info | awk -F'\t' '
    /^=====/ { img = ""; whole = ""; next }
    /^image-path[ ]*: / { sub(/^image-path[ ]*: /, ""); img = $0; next }
    /^\/dev\/disk[0-9]+[ \t]*$/ || /^\/dev\/disk[0-9]+\t/ { d = $1; gsub(/[ \t]+$/, "", d); if (whole == "") whole = d }
    /^\/dev\/disk/ && $3 ~ /^\/Volumes\// { m = $3; gsub(/[ \t]+$/, "", m); print whole "\t" img "\t" m }'
}

build_one() { # <arch>
  local a="$1" RT UT LB B APP DMG X INNER EXP
  RT=$(rust_target "$a"); UT=$(upd_target "$a"); LB=$(label "$a")
  B="$WT/src-tauri/target/$RT/release/bundle"
  say "■ 대상 $RT ($LB)"

  if [ "${RV_SKIP_BUILD:-0}" = "1" ]; then
    say "1·2. 빌드 건너뜀 (RV_SKIP_BUILD=1 — 앞서 만든 산출물 사용)"
  else
    # ── 1. 포함 바이너리 서명 + 설정 임시 수정 (끝나면 원상 복구) ───────
    say "1. 포함 바이너리(ravend·ipfs) 준비·서명 — $a"
    prepare_vendor "$a"
    cp "$OUT/tauri.conf.json.orig" src-tauri/tauri.conf.json
    mkdir -p src-tauri/vendor
    rm -f src-tauri/vendor/ravend src-tauri/vendor/ipfs   # 앞 대상의 바이너리가 남지 않게
    cp "$OUT/vendor/$a/ravend" "$OUT/vendor/$a/ipfs" src-tauri/vendor/
    for f in src-tauri/vendor/ravend src-tauri/vendor/ipfs; do
      [ "$(lipo -archs "$f")" = "$(lipo_arch "$a")" ] || die "$f 아키텍처 불일치"
      codesign --force --sign "$APPLE_SIGNING_IDENTITY" --options runtime --timestamp "$f"
      codesign --verify --strict "$f"
    done
    RV_MIN_MACOS="${RV_MIN_MACOS:-}" node --input-type=module -e 'import fs from "node:fs";const p="src-tauri/tauri.conf.json",c=JSON.parse(fs.readFileSync(p));c.bundle.resources=["vendor/ravend","vendor/ipfs"];if(process.env.RV_MIN_MACOS){c.bundle.macOS=c.bundle.macOS||{};c.bundle.macOS.minimumSystemVersion=process.env.RV_MIN_MACOS;}fs.writeFileSync(p,JSON.stringify(c,null,2)+"\n")'

    # ── 1b. 지난 빌드가 남긴 dmg 작업 이미지 정리 (run-090 과 같음, 대상별 $B) ──
    say "1b. 지난 빌드의 dmg 작업 이미지 정리"
    while IFS=$'\t' read -r dev img mnt; do
      [ -n "$dev" ] || continue
      case "$mnt" in "/Volumes/RavenVault Desktop"|/Volumes/dmg.*) ;; *) continue ;; esac
      case "$img" in
        "$B"/macos/rw.*.dmg|"$B"/dmg/rw.*.dmg|"$B"/dmg/*.dmg)
          echo "떼기: $mnt ($dev ← $img)"
          hdiutil detach "$dev" >/dev/null 2>&1 || hdiutil detach -force "$dev" >/dev/null || die "떼지 못했습니다: $mnt ($dev)" ;;
        *)
          if [ "$mnt" = "/Volumes/RavenVault Desktop" ]; then
            die "「$mnt」 에 이 빌드가 만들지 않은 이미지가 붙어 있습니다($img). Finder 에서 직접 꺼낸 뒤 다시 돌려 주세요."
          fi
          echo "(건드리지 않음) $mnt ← $img — 이 빌드의 이미지가 아님" ;;
      esac
    done < <(stale_mounts)
    if stale_mounts | awk -F'\t' -v b="$B/" 'index($2, b) == 1 { found = 1 } END { exit !found }'; then
      die "이 빌드 폴더의 이미지가 아직 붙어 있습니다 — hdiutil info 로 확인해 주세요"
    fi
    for d in "$B/macos" "$B/dmg"; do
      [ -d "$d" ] || continue
      find "$d" -maxdepth 1 -type f -name 'rw.*.dmg' -print -delete
      # 옛 판 dmg 가 남아 있으면 아래 ls 가 엉뚱한 것을 집을 수 있다 — 이 판 것만 남긴다.
      find "$d" -maxdepth 1 -type f -name '*.dmg' ! -name "*_${VER}_*" -print -delete
    done

    # ── 2. 빌드 ─────────────────────────────────────────────────────
    say "2. 빌드 $RT (20~40분)"
    export TAURI_SIGNING_PRIVATE_KEY="$RV_UPDATE_KEY_FILE"
    export TAURI_SIGNING_PRIVATE_KEY_PASSWORD="$RV_UPDATE_KEY_PASSWORD"
    export APPLE_SIGNING_IDENTITY
    npm run tauri -- build --target "$RT" 2>&1 | tee "$OUT/build-$a.log"
    [ "${PIPESTATUS[0]}" -eq 0 ] || die "빌드 실패 — $OUT/build-$a.log 마지막 줄을 보세요"
    unset TAURI_SIGNING_PRIVATE_KEY TAURI_SIGNING_PRIVATE_KEY_PASSWORD
  fi

  APP="$B/macos/RavenVault Desktop.app"
  DMG=$(ls "$B"/dmg/*_${VER}_$(dmg_arch "$a").dmg 2>/dev/null | head -1)
  [ -d "$APP" ] && [ -f "$DMG" ] || die "빌드 산출물(.app/.dmg)이 없습니다 — $B"
  # 이 대상의 바이너리인지(앞 대상 것이 섞이지 않았는지)
  for f in "$APP/Contents/MacOS/playx-raven" "$APP/Contents/Resources/vendor/ravend" "$APP/Contents/Resources/vendor/ipfs"; do
    [ "$(lipo -archs "$f")" = "$(lipo_arch "$a")" ] || die "$f 가 $(lipo_arch "$a") 가 아닙니다: $(lipo -archs "$f" 2>&1)"
  done

  # ── 3. 공증 · 스테이플 · 검증 ───────────────────────────────────
  say "3. 공증 $LB (5~15분, 길면 더)"
  if [ "${RV_SKIP_NOTARIZE:-0}" = "1" ]; then
    echo "공증 제출 건너뜀 (RV_SKIP_NOTARIZE=1 — 이미 Accepted·스테이플 끝난 .dmg 사용)"
  else
    xcrun notarytool submit "$DMG" --keychain-profile "$RV_NOTARY_PROFILE" --wait 2>&1 | tee "$OUT/notarize-$a.log"
    grep -q "status: Accepted" "$OUT/notarize-$a.log" || die "공증이 Accepted 가 아닙니다 — $OUT/notarize-$a.log"
    xcrun stapler staple "$DMG"
  fi
  xcrun stapler validate "$DMG"
  xcrun stapler validate "$APP" || echo "(참고) .app 단독 파일에는 공증 표가 없음 — .dmg 에는 있음. 정상."
  codesign --verify --deep --strict "$APP"
  spctl -a -vvv -t exec "$APP"
  spctl -a -vvv -t install "$DMG"
  [ "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$APP/Contents/Info.plist")" = "$VER" ] || die "앱 버전이 $VER 이 아닙니다"
  codesign -dv --verbose=4 "$APP/Contents/Resources/vendor/ravend" 2>&1 | grep -E 'TeamIdentifier=FSF7LXFW6L' >/dev/null || die "ravend 팀 서명 확인 실패"
  codesign -dv --verbose=4 "$APP/Contents/Resources/vendor/ravend" 2>&1 | grep -q 'flags=.*runtime' || die "ravend hardened runtime 꺼짐"
  codesign -dv --verbose=4 "$APP/Contents/Resources/vendor/ipfs" 2>&1 | grep -q 'flags=.*runtime' || die "ipfs hardened runtime 꺼짐"

  # ── 4. 산출물 복사 ─────────────────────────────────────────────
  say "4. 산출물 복사 $LB"
  cp "$DMG" "$OUT/input/RavenVault-Desktop-$VER-$LB.dmg"
  cp "$B/macos/RavenVault Desktop.app.tar.gz"     "$OUT/input/RavenVault-Desktop-$VER-$LB.tar.gz"
  cp "$B/macos/RavenVault Desktop.app.tar.gz.sig" "$OUT/input/RavenVault-Desktop-$VER-$LB.tar.gz.sig"
  for f in "$OUT/input/RavenVault-Desktop-$VER-$LB".{dmg,tar.gz}; do
    [ "$(stat -f %z "$f")" -lt 95000000 ] || die "$f 가 95,000,000 바이트 이상 — release-manifest 가 거절합니다"
  done

  # ── 5. 업데이트 명세 만들고 서명 ───────────────────────────────
  say "5. 업데이트 명세 $UT (sequence=$RV_SEQ)"
  EXP=$(python3 -c 'import time;print(int(time.time())+30*24*3600)')
  python3 scripts/prepare-update-statement.py "$OUT/input/RavenVault-Desktop-$VER-$LB.tar.gz" \
    --target "$UT" --sequence "$RV_SEQ" --expires "$EXP" --output "$OUT/statements/$UT.json"
  cat "$OUT/statements/$UT.json"; echo
  rm -f "$OUT/statements/$UT.json.sig" "$OUT/statements/$UT.json.minisig"
  env -u TAURI_SIGNING_PRIVATE_KEY -u TAURI_SIGNING_PRIVATE_KEY_PASSWORD npx tauri signer sign -f "$RV_UPDATE_KEY_FILE" -p "$RV_UPDATE_KEY_PASSWORD" "$OUT/statements/$UT.json" 2>&1 | tee "$OUT/sign-statement-$a.log" >/dev/null
  [ -f "$OUT/statements/$UT.json.sig" ] || die "명세 서명 파일이 없습니다 — $OUT/sign-statement-$a.log"
  base64 -d < "$OUT/statements/$UT.json.sig" > "$OUT/statements/$UT.json.minisig"

  # ── 6. 압축본 속 앱도 확인 ─────────────────────────────────────
  say "6. 압축본 속 앱 확인 $LB"
  X=$(mktemp -d)
  tar -xzf "$OUT/input/RavenVault-Desktop-$VER-$LB.tar.gz" -C "$X"
  INNER=$(ls -d "$X"/*.app | head -1)
  codesign --verify --deep --strict "$INNER"
  spctl -a -vvv -t exec "$INNER"
  [ "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$INNER/Contents/Info.plist")" = "$VER" ] || die "압축본 안 앱 버전이 $VER 이 아닙니다"
  [ "$(lipo -archs "$INNER/Contents/MacOS/playx-raven")" = "$(lipo_arch "$a")" ] || die "압축본 안 앱 아키텍처 불일치"
  rm -rf "$X"
}

for a in $RV_ARCHS; do build_one "$a"; done

# ── 7. 명세 서명을 공개키로 다시 확인 (release-manifest 가 하는 검사와 같은 함수) ──
say "7. 명세 서명 확인"
for a in $RV_ARCHS; do
  UT=$(upd_target "$a"); LB=$(label "$a")
  RV_S="$OUT/statements/$UT.json" RV_P="$OUT/input/RavenVault-Desktop-$VER-$LB.tar.gz" RV_T="$UT" RV_V="$VER" \
  node --input-type=module -e '
    import fs from "node:fs"; import {createHash} from "node:crypto";
    const {verifyStatement} = await import(process.cwd()+"/scripts/signed-release-metadata.mjs");
    const c = JSON.parse(fs.readFileSync("src-tauri/tauri.conf.json","utf8"));
    const e = process.env;
    verifyStatement(fs.readFileSync(e.RV_S,"utf8"), fs.readFileSync(e.RV_S+".minisig","utf8"), c.plugins.updater.pubkey,
      {version:e.RV_V, target:e.RV_T, sha256:createHash("sha256").update(fs.readFileSync(e.RV_P)).digest("hex")});
    console.log("명세 서명 OK:", e.RV_T);'
done
shasum -a 256 "$OUT"/input/RavenVault-Desktop-$VER-* | tee "$OUT/checks/SHA256SUMS-input.txt"

say "끝 — 3단계 완료 ($RV_ARCHS)"
echo "설치본: $OUT/input/"
echo "다음(대표):"
echo "  1) 인텔 설치본은 Rosetta 로 먼저 시험 — ~/Desktop/레이븐볼트-인텔맥-빌드-준비.md 「Rosetta 시험 체크리스트」"
echo "  2) 업로드 준비(업로드 아님): node scripts/release-manifest.mjs $OUT/input <dist checkout> $VER $OUT/statements --targets darwin-aarch64,darwin-x86_64"
echo "     (윈도우·리눅스 0.9.1 이 같이 준비됐으면 같은 실행에 그 대상과 파일을 함께 넣는다 — v$VER/ 폴더는 한 번만 만들 수 있다)"
