# RavenVault Desktop 0.5.2 맥 서명·공증 준비 보고

## 상태와 변경 파일

0.5.2 소스와 CI는 준비했다. Developer ID 인증서·공증 API 키가 아직 제공되지 않아 실제 Apple 공증, Gatekeeper 수락, 0.5.1 → 0.5.2 사용자 데이터 연속성은 **미검증**이다. 이 세 가지를 실측하기 전에는 공개하지 않는다.

- `.github/workflows/release.yml`: 맥 두 대상의 비밀값 누락 검사, API 키 파일과 임시 키체인 생성, 포함 실행 파일 선서명, Tauri 앱 서명·공증, DMG 별도 공증·staple, 앱·DMG·updater 압축본 검사.
- `src-tauri/tauri.conf.json`: 0.5.2, 고정 `signingIdentity: "-"` 제거. 번들 identifier `se.erci.ex.playx.raven` 유지. `createUpdaterArtifacts: true`와 updater 공개 키도 유지.
- `package.json`, `package-lock.json`의 앱 항목, `src-tauri/Cargo.toml`, `src-tauri/Cargo.lock`의 `playx-raven` 항목: 0.5.2. 다른 잠금 패키지 버전은 그대로.
- `scripts/release-manifest.mjs`: 0.5.2 공개 노트와 0.5.1 변경 요약.

## 공개 워크플로

macOS arm64·x86_64 모두 `ravend`, `ipfs`를 검사한 해시로 받고 `resources`에 등록한다. 맥에서 필수 Apple 시크릿이 비거나 서명 신원이 `Developer ID Application: … (FSF7LXFW6L)` 형식이 아니면 빌드 전에 실패한다. base64 API 키는 `$RUNNER_TEMP/AuthKey_<키 ID>.p8`에 권한 600으로 풀고 경로만 `$GITHUB_ENV`에 기록한다. p12도 임시 키체인으로 가져온 뒤 임시 파일을 지운다. 값 자체는 출력하지 않는다.

`ravend`와 `ipfs` 원본에 Developer ID와 hardened runtime을 먼저 서명한다. 이 둘은 Tauri `externalBin`이 아니라 `bundle.resources`로 들어가므로 Tauri 자동 개별 서명 목록에 없다. Tauri는 리소스를 앱에 복사한 뒤 앱을 서명·공증·staple한다. `APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY`, `APPLE_API_ISSUER`, `APPLE_API_KEY`, `APPLE_API_KEY_PATH`를 맥 빌드 단계에 전달한다. 이어 DMG를 `notarytool submit --wait`로 별도 공증하고 staple한다. 앱과 포함 바이너리의 `codesign --verify --deep --strict --verbose=2`, TeamIdentifier, hardened runtime, 앱·DMG의 Gatekeeper 평가와 staple 티켓을 검사한다. `.app.tar.gz`를 풀어 같은 앱·포함 바이너리 검사를 다시 한다. 실패하면 해당 잡과 전체 공개가 실패한다.

Tauri updater 문서는 `createUpdaterArtifacts: true`일 때 이미 만들어진 `.app`에서 `.app.tar.gz`와 `.sig`를 생성한다고 명시한다. 번들 코드도 리소스 복사 → 내부 코드·앱 서명 → 앱 공증 순서다. CI의 압축본 실물 검사가 이 순서가 깨지지 않았는지 최종 확인한다. 별도 entitlements는 추가하지 않았다. 현재 앱은 App Sandbox를 켜지 않았고 네트워크 클라이언트·서버 및 외부 프로세스 실행에 이를 위한 entitlement가 필요하지 않다. 필요 없는 예외 권한은 넣지 않는다.

로컬에서 인증서 없이 `npm run tauri build`를 실행할 때는 설정에 서명 신원이 없으므로 공증을 요구하지 않는다. 로컬 산출물은 공개용이 아니며 Gatekeeper 우회를 보장하지 않는다. 로컬 환경에 `APPLE_*`가 설정되어 있으면 Tauri가 그 값을 사용할 수 있으므로 개발용 빌드에서는 해당 환경 변수를 해제한다. 공개 워크플로는 누락을 허용하지 않는다.

## 대표·세션이 나중에 넣을 GitHub Secrets

| 이름 | 형식 |
| --- | --- |
| `APPLE_CERTIFICATE` | 개인 키가 포함된 Developer ID Application `.p12` 파일의 base64 한 줄 |
| `APPLE_CERTIFICATE_PASSWORD` | 해당 p12 내보내기 비밀번호 |
| `APPLE_SIGNING_IDENTITY` | `Developer ID Application: 이름 (FSF7LXFW6L)` 전체 문자열 |
| `APPLE_API_ISSUER` | App Store Connect API Issuer UUID |
| `APPLE_API_KEY` | App Store Connect API Key ID (`AuthKey_<id>.p8`의 `<id>`) |
| `APPLE_API_KEY_P8_BASE64` | 해당 `.p8` 파일의 base64 한 줄 |

기존 `TAURI_SIGNING_PRIVATE_KEY`와 `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`는 자동 업데이트 서명용으로 계속 필요하다. 이 작업은 비밀값 생성·열람·등록을 하지 않았다.

## 키체인·지갑·백업 연속성

`src-tauri/src/ai.rs`는 `keyring` 3.6.3의 `apple-native` 구현을 사용한다. 기본 AI 키 서비스명은 `se.erci.ravenvault.desktop.ai`, 계정명은 제공자(`openai` 등)다. `PLAYX_RAVEN_HOME`을 바꾼 설치에는 경로 해시를 덧붙인다. 앱의 bundle identifier와 기본 앱 데이터 경로를 바꾸지 않았으므로 조회 이름은 0.5.1과 같다.

macOS `keyring`은 `security-framework`의 `set_generic_password`/`find_generic_password`를 호출한다. `set_generic_password`는 기존 항목을 찾으면 수정하고, 없으면 `SecKeychainAddGenericPassword`를 호출한다. 별도 `SecAccess` 또는 ACL을 지정하지 않는다. Apple 문서에 따르면 기본 파일 기반 키체인의 ACL은 만든 앱을 신뢰하며, 다른 코드 서명 신원의 앱이 읽으려 할 때 사용자 허용 대화상자를 낼 수 있다. Apple의 코드 서명 문서는 키체인이 앱의 designated requirement로 신원을 추적한다고 설명한다. 기존 ad-hoc 서명에서 Developer ID로 바뀌면 같은 bundle identifier만으로 무조건 자동 접근이 보장되지는 않는다. 기존 ad-hoc 항목의 신원 조건이 새 서명과 맞지 않아 첫 조회 때 **「키체인 접근 허용」 대화상자**, 거절하면 조회 실패가 예상된다. 실제 경고 문구와 동작은 사용자 맥에서 확인해야 한다.

현재 `ai.rs`에서 키 읽기 실패는 AI 키가 없는 것처럼 보일 수 있다(`api_key_status`가 저장소 오류를 버리고 `has_key=false`로 표시). 실제 AI 사용도 실패한다. 키가 지워졌다고 단정하거나 기존 키체인 항목을 삭제하지 말고, 우선 macOS 키체인 허용 대화상자에서 **허용**을 선택하게 안내한다. 그래도 읽히지 않으면 설정 → AI에서 사용자가 자신의 키를 다시 붙여 넣고 저장하게 안내한다. 새 코드가 키체인 항목을 읽거나 갱신하지 못할 수 있으므로 실제 0.5.1 → 0.5.2 시험에서 재입력 성공까지 확인해야 한다. AI 키는 백업 ZIP에 포함되지 않는다.

파일 기반 데이터는 코드 서명 ACL에 묶이지 않는다. `paths.rs`의 맥 앱 데이터는 `~/Library/Application Support/PlayXRaven`, Raven Core 기본 데이터는 `~/Library/Application Support/Raven`이며, 선택한 별도 Raven 데이터 폴더는 앱 데이터의 `raven-datadir.txt`를 통해 찾는다. `wallet.dat`와 체인, 앱 설정·가게 데이터, 사용자가 고른 백업 위치는 동일 사용자·동일 경로에서 이어질 것으로 예상된다. 다만 파일 권한, 이동식 디스크 접근, 실제 업데이트 절차까지는 사용자 환경에서 실측해야 한다. 번들 identifier `se.erci.ex.playx.raven`은 유지했다.

## 인증서 수령 뒤 0.5.1 → 0.5.2 실제 시험

1. 세션이 위 시크릿을 비노출 방식으로 등록한 후 **공개 전** 로컬 맥에서 `APPLE_*` 환경 변수를 설정하고 `npm run tauri build`로 서명·공증 빌드를 수행한다. 로컬 앱·DMG·updater 압축본에 CI와 같은 검사를 적용한다. 실제 DMG에서 `xcrun stapler validate`, `spctl -a -vvv -t install`, 설치된 앱에서 `codesign --verify --deep --strict --verbose=2`, `spctl -a -vvv -t exec` 결과가 모두 통과하고 `source=Notarized Developer ID`, 팀 `FSF7LXFW6L`인지 확인한다. 새 맥 사용자 계정에서 DMG를 받아 앱을 한 번에 여는 장면을 캡처한다. 기존 `release.yml` 수동 실행은 끝에 공개 단계가 있으므로 이 사전 시험에 사용하지 않는다.
2. 기존 사용자 계정에 **0.5.1을 먼저 설치**하고 테스트용 AI API 키를 설정 → AI에 저장한다. 실제 키 값은 로그·보고서에 남기지 않는다. 키 상태와 간단한 AI 호출로 저장·읽기를 확인한다. 시험용 지갑/앱 데이터와 백업 위치도 기록하고, 실제 자산이 있는 지갑은 사용하지 않는다.
3. 0.5.2 updater `.app.tar.gz`/`.sig`를 테스트 엔드포인트에서 제공하고 0.5.1의 업데이트 단추로 설치한다. 업데이트 서명 검증·설치·재시작, 앱의 Developer ID 및 공증 상태를 확인한다. 첫 AI 키 조회에서 키체인 허용 대화상자 여부와 허용 뒤 읽기, 거절 뒤 복구·재입력, 앱/지갑/백업 데이터 유지 여부를 기록한다. Intel과 Apple Silicon에서 각각 확인한다.
4. 어느 한 항목이 실패하면 공개를 멈추고 원인과 복구 경로를 확정한다. 특히 키체인 항목을 임의로 삭제하거나 재서명하여 시험 결과를 가리지 않는다.

## 근거 및 남은 위험

- [Tauri macOS 서명·공증 환경 변수](https://v2.tauri.app/distribute/sign/macos/), [Tauri macOS 번들 순서](https://github.com/tauri-apps/tauri/blob/dev/crates/tauri-bundler/src/bundle/macos/app.rs), [Tauri updater 생성 순서](https://docs.rs/crate/tauri-bundler/2.10.0/source/src/bundle.rs), [Tauri updater 산출물](https://v2.tauri.app/plugin/updater/).
- [keyring 3.6.3 macOS 구현](https://github.com/open-source-cooperative/keyring-rs/blob/v3.6.3/src/macos.rs), [Apple 기본 키체인 ACL](https://developer.apple.com/documentation/security/secaccesscreate(_:_:_:)), [Apple 코드 서명과 키체인 신원](https://developer.apple.com/library/archive/technotes/tn2206/).
- 인증서 미발급 상태여서 Developer ID 서명·Apple 공증 결과, 포함한 서드파티 Mach-O의 공증 통과, Gatekeeper 첫 실행, ad-hoc 키체인 마이그레이션은 아직 실측하지 못했다. 서명으로 파일 데이터가 사라지지는 않지만 OS 대화상자와 접근 결과는 실제 사용자 맥에서 확인해야 한다.

## 이 작업 환경에서의 검증 결과

- `cargo check --locked` rc=0, 루트 `node preflight.mjs` rc=0, YAML 파싱 rc=0, 워크플로의 bash 단계 문법 rc=0, `git diff --check` rc=0. 비어 있는 Apple 시크릿에 대한 공개 빌드 차단도 예상대로 rc=1이었다. `scripts/preflight.mjs`는 없고 루트 `preflight.mjs`를 실행했다. `actionlint`는 설치되지 않았다.
- `npm run build`는 rc=2. 현재 환경에서 npm registry와 SheetJS CDN DNS 조회가 실패하여 `npm ci`가 의존성을 설치하지 못했다. 다른 체크아웃의 기존 `node_modules`를 이 작업 폴더로 복사해 재시도했지만 그 복사본에도 `xlsx`가 없어 TypeScript가 `Cannot find module 'xlsx'`로 멈췄다. 소스 수정에 의한 실패로 해석할 근거는 없다. 네트워크가 열리는 CI에서 정확한 잠금 파일로 `npm ci && npm run build` 재검증이 필요하다.
- `node --test scripts/release-manifest.test.mjs`의 릴리스 테스트는 통과했다. 통합 실행한 `scripts/desktop-installer-identity.test.mjs`는 테스트가 임시 Cargo 프로젝트의 `handlebars`를 가져오려다 crates.io DNS 실패로 중단됐다.

## 실측 결과 (2026-09-29, 세션)

- GitHub Secrets 6개 등록(값 비노출): APPLE_CERTIFICATE·APPLE_CERTIFICATE_PASSWORD(대표 직접)·APPLE_SIGNING_IDENTITY·APPLE_API_ISSUER·APPLE_API_KEY·APPLE_API_KEY_P8_BASE64(fastlane ASC 키 재사용).
- 로컬 애플 실리콘 서명·공증 빌드: 앱 `spctl -t exec` accepted · `source=Notarized Developer ID` · TeamIdentifier FSF7LXFW6L · hardened runtime · staple OK. dmg `notarytool` Accepted → staple → `spctl -t install` accepted.
- 연속성(대표 맥, 실제 0.5.1 ad-hoc 설치본 → 공증 0.5.2 로 교체): 첫 라비 열기에 「키체인 접근 허용」 대화상자 1회 → 허용 후 기존 Google AI 키 그대로 읽힘, 라비 깨어 있음. 파일 데이터(지갑·노드·앱 설정) 영향 없음. 릴리스 노트에 「항상 허용」 안내 추가.
- 업데이터 서명 키(TAURI_SIGNING)는 그대로라 0.5.1 → 0.5.2 자동 업데이트 서명 검증 경로는 변화 없음. 인텔 대상은 CI 검사 단계가 확인.
- 0.5.2 에 대표 요청 2건 추가: 머리글 라비 → 라비 화면, 왼쪽 아래 상태 점 이름 표시.
