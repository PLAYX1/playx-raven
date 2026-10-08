# RavenVault Desktop 0.8.4 대표 실행 인계

이 작업에서는 웹 프런트엔드 검증 빌드와 Rust 검사·시험만 실행했다. 설치 파일 패키징, 코드 서명, 업데이트 서명, 공증, 실제 거래, 배포, push는 실행하지 않았다. 아래 명령은 대표가 최종 검증 후 별도 릴리스 환경에서 실행할 절차다.

## 공개 전 반드시 확인할 제한

- `secfix1`의 `secure_update.rs` / `update_policy.rs`를 유지한다. 광고 버전, 서명된 버전, 압축본 내부 앱 버전, SHA-256, 대상, 만료, 단조 증가 sequence가 모두 맞아야 설치된다.
- 기존 secfix1은 macOS 패키지 내부 버전 검사만 지원한다. Windows/Linux 자동 업데이트 설치는 계속 차단된다. 이를 우회하거나 지원 완료로 발표하지 않는다. 해당 OS의 신규 설치 패키지는 별도 QA 대상이다.
- 기존 `.github/workflows/release.yml`은 끝에 자동 공개가 있다. 사전 시험용으로 실행하지 않는다. 기존 워크플로에는 `signed_releases` 서명 명세 생성·전달 단계가 없으므로 0.8.4는 새 manifest gate에서 중단된다. 아래 수동 절차를 사용하거나, 동일한 공개 명세를 CI artifact로 전달하는 별도 변경을 검토한다.
- 판매 기능은 암호화된 니모닉 지갑만 지원한다. 오래된 비니모닉 지갑·암호 없는 지갑은 번호를 노출하지 않는다. 기존 native BIP39와 폰의 정규화가 다른 비 ASCII 추가 BIP39 암호는 조용히 다른 계정을 표시하지 않고 거절한다. 일반 지갑 잠금 비밀번호는 이 제한과 별개다.
- Chrome 실화면 시험은 이 작업 환경의 실행 단계에서 막혔다. 아래 수동 UI 검증을 끝내기 전 공개하지 않는다.

## 1. 소스 검증 (서명 전)

```bash
cd /Users/gimmusong/wt-rv-desktop-084
set -euo pipefail
npm ci --ignore-scripts
npm test
npm run typecheck
npm run check:pre-release
cargo check --locked --manifest-path src-tauri/Cargo.toml
cargo test --locked --manifest-path src-tauri/Cargo.toml --lib sales_account::tests
cargo test --locked --manifest-path src-tauri/Cargo.toml --lib update_policy::
node scripts/check-sales-browser.mjs
git diff --check
```

원본 폰 checkout이 없는 환경은 원본 실행 시험이 SKIP된다. 이 경우 저장된 공개 교차 벡터 검증은 계속 실행된다. 원본 교차 실행까지 통과한 이번 로그는 `desktop-084-npm-tests.txt`에 있다.

## 2. 대상별 패키징·코드 서명·공증

키·비밀번호 값은 문서, 명령 기록, `.env`, 로그에 복사하지 않는다. 셸 추적(`set -x`)을 사용하지 않는다. 기존 비밀 관리 수단으로 빌드 프로세스에 주입하고, 기존 Apple 키체인·공증 프로필·업데이트 서명 권한을 사용한다. 공개키/앱 ID/Windows upgradeCode를 교체하지 않는다.

macOS는 두 대상별 별도 작업 환경에서 수행한다. 각 환경에 **해당 아키텍처**의 검증된 `ravend`, `ipfs`를 `src-tauri/vendor/`에 준비한다. 공급원과 해시 검증은 기존 release.yml의 다운로드·검사 절차를 그대로 따른다. 아래 첫 두 변수는 각각 한 쌍만 선택한다.

```bash
# Apple Silicon 작업 환경
RV_TARGET=aarch64-apple-darwin
RV_LABEL=mac-apple-silicon
# Intel 작업 환경에서는 위 두 줄 대신 다음 두 줄
# RV_TARGET=x86_64-apple-darwin
# RV_LABEL=mac-intel

: "${APPLE_SIGNING_IDENTITY:?기존 Developer ID 신원 필요}"
: "${RV_NOTARY_PROFILE:?기존 notarytool 키체인 프로필 이름 필요}"
: "${RV_RELEASE_INPUT_DIR:?완성된 공개 산출물만 모을 절대 경로 필요}"
for binary in src-tauri/vendor/ravend src-tauri/vendor/ipfs; do
  test -f "$binary"
  codesign --force --sign "$APPLE_SIGNING_IDENTITY" --options runtime --timestamp "$binary"
  codesign --verify --strict "$binary"
done
node --input-type=module -e 'import fs from "node:fs"; const p="src-tauri/tauri.conf.json", c=JSON.parse(fs.readFileSync(p)); c.bundle.resources=["vendor/ravend","vendor/ipfs"]; fs.writeFileSync(p,JSON.stringify(c,null,2)+"\n");'
# APPLE_* / TAURI_SIGNING_*는 기존 비밀 관리 수단으로 주입되어 있어야 한다.
# Tauri가 앱 코드서명·공증·staple 및 updater 압축본 서명을 수행한다.
npm run tauri -- build --target "$RV_TARGET"
RV_BUNDLE="src-tauri/target/$RV_TARGET/release/bundle"
RV_APP="$RV_BUNDLE/macos/RavenVault Desktop.app"
RV_DMG=$(find "$RV_BUNDLE/dmg" -maxdepth 1 -name '*.dmg')
test "$(find "$RV_BUNDLE/dmg" -maxdepth 1 -name '*.dmg' | wc -l | tr -d ' ')" = 1
xcrun notarytool submit "$RV_DMG" --keychain-profile "$RV_NOTARY_PROFILE" --wait
xcrun stapler staple "$RV_DMG"
xcrun stapler validate "$RV_APP"
xcrun stapler validate "$RV_DMG"
codesign --verify --deep --strict "$RV_APP"
spctl -a -vvv -t exec "$RV_APP"
spctl -a -vvv -t install "$RV_DMG"
test "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$RV_APP/Contents/Info.plist")" = 0.8.4
mkdir -p "$RV_RELEASE_INPUT_DIR"
cp "$RV_DMG" "$RV_RELEASE_INPUT_DIR/RavenVault-Desktop-0.8.4-$RV_LABEL.dmg"
cp "$RV_BUNDLE/macos/RavenVault Desktop.app.tar.gz" "$RV_RELEASE_INPUT_DIR/RavenVault-Desktop-0.8.4-$RV_LABEL.tar.gz"
cp "$RV_BUNDLE/macos/RavenVault Desktop.app.tar.gz.sig" "$RV_RELEASE_INPUT_DIR/RavenVault-Desktop-0.8.4-$RV_LABEL.tar.gz.sig"
```

`codesign -dv --verbose=4`로 앱과 포함 바이너리 각각의 TeamIdentifier가 기존 팀이고 hardened runtime이 켜졌는지 확인한다. 압축본을 별도 빈 디렉터리에 풀어 **그 안의 앱에도** 동일한 codesign/Gatekeeper/staple/버전 검사를 수행한다. 검사 후 updater 압축본을 재압축하거나 수정하지 않는다. 변경했다면 패키지 서명부터 다시 해야 한다.

Windows x86_64, Linux x86_64는 각각 해당 OS 작업 환경에서 기존 release.yml의 의존성·vendor 준비를 끝낸 후 실행한다.

```bash
# Windows 빌드 작업 환경
npm run tauri -- build --target x86_64-pc-windows-msvc
# Linux 빌드 작업 환경
npm run tauri -- build --target x86_64-unknown-linux-gnu
```

기존 workflow의 수집 단계와 같은 이름으로 아래 파일들을 `$RV_RELEASE_INPUT_DIR`에 모은다. **모두 필수**이며 임의 이름·빈 파일·서명 누락은 manifest 준비에서 거절된다.

- `RavenVault-Desktop-0.8.4-windows.exe`, `.exe.sig`, `RavenVault-Desktop-0.8.4-windows.msi`
- 위 macOS 단계의 두 DMG, 두 tar.gz, 두 tar.gz.sig
- `RavenVault-Desktop-0.8.4-linux.AppImage`, `.AppImage.sig` (추가 deb/rpm은 선택)

## 3. 최종 바이트에 대한 버전 명세 서명

Tauri 패키지 서명 외에 **동일한 기존 업데이트 서명 권한**의 minisign 명세 서명이 필요하다. `RV_MINISIGN_KEY_FILE`은 이미 안전하게 보관된 기존 파일의 경로이며, 키 내용을 새 파일에 복사하지 않는다. minisign은 prehashed `ED` 모드를 사용해야 한다(legacy `-l` 금지). 서명 도구가 없거나 기존 권한의 파일이 없으면 중단한다. 이 작업 환경에는 minisign이 없었고 실제 서명은 검증하지 않았다.

`RV_RELEASE_SEQUENCE`는 마지막 공개/설치 승인 명세의 sequence보다 큰 정수로 대표가 정한다. 임의로 1로 초기화하지 않는다. 이전 sequence를 모르면 공개를 중단한다.

```bash
: "${RV_RELEASE_INPUT_DIR:?필수}"
: "${RV_STATEMENTS_DIR:?공개 명세 디렉터리 절대 경로 필요}"
: "${RV_MINISIGN_KEY_FILE:?기존 서명 권한 파일 경로 필요}"
: "${RV_RELEASE_SEQUENCE:?기존 최대 sequence보다 큰 정수 필요}"
mkdir -p "$RV_STATEMENTS_DIR"
RV_EXPIRES=$(python3 -c 'import time; print(int(time.time()) + 30*24*60*60)')
for pair in darwin-aarch64:mac-apple-silicon darwin-x86_64:mac-intel; do
  RV_OS_TARGET=${pair%%:*}
  RV_OS_LABEL=${pair#*:}
  python3 scripts/prepare-update-statement.py \
    "$RV_RELEASE_INPUT_DIR/RavenVault-Desktop-0.8.4-$RV_OS_LABEL.tar.gz" \
    --target "$RV_OS_TARGET" --sequence "$RV_RELEASE_SEQUENCE" --expires "$RV_EXPIRES" \
    --output "$RV_STATEMENTS_DIR/$RV_OS_TARGET.json"
  minisign -S -s "$RV_MINISIGN_KEY_FILE" \
    -m "$RV_STATEMENTS_DIR/$RV_OS_TARGET.json" \
    -x "$RV_STATEMENTS_DIR/$RV_OS_TARGET.json.minisig"
done
```

## 4. 검증된 메타데이터 준비 → 검토 → 업로드

별도 릴리스 환경에서 기존 공개 저장소 `dist` checkout을 사용한다. 아래 명령은 대표가 실행할 **실제 업로드 명령**이며 이번 작업에서는 실행하지 않았다. `RV_PUBLISH_DIR`는 기존 dist checkout 경로, `RV_RELEASE_INPUT_DIR`와 `RV_STATEMENTS_DIR`는 앞 단계의 경로다.

```bash
: "${RV_PUBLISH_DIR:?기존 릴리스 dist checkout 절대 경로 필요}"
test "$(git -C "$RV_PUBLISH_DIR" branch --show-current)" = dist
node scripts/release-manifest.mjs \
  "$RV_RELEASE_INPUT_DIR" "$RV_PUBLISH_DIR" 0.8.4 "$RV_STATEMENTS_DIR"
# 위 명령은 업로드하지 않음. 키·서명·버전/해시/대상/만료 검증 실패 시 중단.
# 여기서 latest.json 및 v0.8.4/manifest.json의 signed_releases 두 대상을 검토.
git -C "$RV_PUBLISH_DIR" add --pathspec-from-file="$(dirname "$RV_PUBLISH_DIR")/release-paths.txt"
git -C "$RV_PUBLISH_DIR" -c core.hooksPath=/dev/null commit -m 'Release RavenVault Desktop 0.8.4'
git -C "$RV_PUBLISH_DIR" push origin HEAD:dist
node scripts/verify-published-release.mjs 0.8.4
```

서비스 `https://rvn.ex.erci.se/update/...`가 `signed_releases`를 누락 없이 전달하는지도 확인한다. 실제 업데이트 응답을 구버전 시험 설치에서 확인하고, 잘못된 서명·해시·버전·대상·만료·낮은 sequence를 각각 거절하는지 본다. 기존 버전별 파일은 삭제·덮어쓰기하지 않는다.

## 대표 최종 체크리스트

- [ ] 판매 메뉴와 게임 카드가 기본/작은 창에서 발견 가능하고 잘리지 않는다.
- [ ] 폰과 데스크탑에서 같은 시험 지갑의 판매 번호·처음 주소 3개가 같다. 시험 자료는 출력·촬영하지 않는다.
- [ ] 잠긴 지갑/이미 열린 지갑 모두 재인증한다. 틀린 암호·취소·서버 오류 때 xpub/QR가 보이지 않는다.
- [ ] 60초, 화면 이동, 창 전환, 잠금 후 공개 정보가 사라지고 늦은 응답으로 되살아나지 않는다.
- [ ] 복사/QR가 같은 xpub를 나타낸다. 클립보드는 자동 삭제되지 않는다는 안내를 확인한다.
- [ ] 100개 주소의 확정 금액 표시와 범위 밖/미확정 제외 안내가 맞다. 색인 꺼짐·미동기화·네트워크 실패를 0으로 표시하지 않는다.
- [ ] 옮기기는 안내만 제공하고 실제 송금·키 가져오기·지갑 자동 전환이 발생하지 않는다.
- [ ] 라비 스토리가 기본 브라우저로 정확한 HTTPS URL을 열고 iframe/내장 창/지갑 자료 전달이 없다.
- [ ] 두 macOS 앱·DMG·압축본의 버전/서명/공증/staple/포함 바이너리를 확인한다. 신규 계정 첫 실행도 확인한다.
- [ ] Windows/Linux 신규 설치 QA 및 자동 업데이트 차단 제한을 사용자 안내에 반영한다.
- [ ] 승인된 sequence, 만료 시각, SHA-256, 두 signed_releases, 실제 업데이트 API 전달을 확인한다.
- [ ] 원본 지갑·시드·키·암호·`.env` 값이 로그/문서/커밋/산출물에 들어가지 않았는지 확인한다.
