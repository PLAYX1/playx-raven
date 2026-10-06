# 키체인 잠김 복구와 명시적 기기 암호화 저장

## 결과

기준: RavenVault Desktop 0.8.0, `08ead5d233b071725f4bf7ecdcb9a52c885a87c0`. 요청한 기능 구현과 모의 검증을 완료했다. **전체 시험 통과라고 주장하지 않는다.** 이 실행 환경의 보안 제한으로 로컬 포트 및 Chrome 실행을 요구하는 기존 시험은 실행 완료할 수 없었다. 제한 우회, 실제 키체인 쓰기, 실제 AI 호출은 하지 않았다.

전달 ref: `refs/heads/claude/keyfallback` · 번들: `artifacts/keyfallback.bundle`. 임시 `GIT_INDEX_FILE`과 `commit-tree`를 사용한다. 작업 브랜치 HEAD와 일반 인덱스를 유지하고 push·태그를 만들지 않는다. 기존 사용자 변경 및 기존 산출물은 커밋 대상에서 제외한다. 번들 생성 후 커밋 해시·검증 결과는 `DELIVERY.json`에 기록한다.

## 구현

- macOS OSStatus -25293, -25308, -128, -25244, -25315 및 기존 잠김 상태를 `StoreError::KeychainLocked` → `keychain-locked`로 전달한다. “The user name or passphrase” 문구도 같은 분류로 처리한다. 원문은 메모리 안에서 분류할 때만 사용하고 IPC·로그에 전달하지 않는다. 잠김은 ACL 세대 복구 삭제를 유발하지 않는다.
- Windows 접근 거부·로그온 세션·취소 오류도 안전한 잠김 분류로 처리한다. Linux 기존 파일 저장 경로는 유지하며 파일 권한 오류를 별도로 안내한다.
- 한국어·영어·일본어·중국어 `desktop-copy`에 로그인 잠금 해제 단계, 현재/이전 Mac 암호, 최후 수단인 기본 키체인 재설정과 저장 암호 삭제 경고를 추가했다. Windows는 자격 증명 관리자 안내, Linux는 폴더 권한·여유 공간 안내를 표시한다.
- `open_external`은 macOS에서 정확히 `/System/Applications/Utilities/Keychain Access.app`만 추가 허용한다. 접두어, 하위 경로, file URL, 임의 앱, 뒤에 붙인 인수는 허용하지 않는다. 시험은 앱을 실제로 열지 않는다.
- 저장 실패 후 키는 password 입력칸에서 지우고 일시적인 복구 버튼 클로저 안에만 보관한다. 사용자가 덜 안전하다는 단추를 한 번 누르면 `consent: true`로 암호화 저장한다. 재입력은 필요 없다. 자동 대체 저장은 없다. 성공·닫기·제공자 변경·새 저장 시 복구 UI와 임시 참조를 정리한다.
- `{provider}.aead` 파일: AES-256-GCM, OS 난수 96비트 nonce, 128비트 인증 태그, 제공자 AAD. HKDF-SHA256은 기기 식별값, 고정 앱 salt, 제공자 이름으로 256비트 키를 유도한다. macOS IOPlatformUUID, Windows MachineGuid, Linux `/etc/machine-id`를 사용한다. 식별값을 얻지 못하면 32바이트 OS 난수 seed 파일을 쓴다. 헤더는 버전·seed 사용 여부·nonce만 포함한다. 키 평문과 키 접미사는 파일에 쓰지 않는다.
- Unix 파일은 생성 시 0600, 임시 파일 쓰기·fsync·rename·디렉터리 fsync를 사용한다. Windows 파일은 생성 시 상속 없는 소유자 전용 DACL을 적용한다. 읽기는 크기를 제한하고 Unix 심볼릭 링크를 거절한다. seed는 읽기 실패 때 재생성하지 않는다.
- 읽기는 현재 키체인 항목 우선, 없거나 실패하면 암호화 파일이다. 대체 저장 시 새 세대 번호를 예약해 교체 전 오래된 키체인 항목이 새 키를 가리지 않게 한다. 상태 IPC는 실제 읽은 저장소를 알리며 UI는 기기 암호화 사용과 낮은 보안 수준을 표시한다.
- 키체인 이동은 사용자 클릭으로만 시행한다. 쓰기 후 다시 읽어 동일함을 검증한 뒤 암호화 파일을 지운다. 실패하면 암호화 파일을 보존한다. Linux에서 키체인 이동은 허용하지 않는다.
- 삭제는 먼저 삭제 표식을 기록하고 키체인·암호화 파일·옛 파일을 정리한다. 키체인 삭제가 실패해도 파일 삭제를 시도하며 표식이 오래된 세대나 복원된 파일의 부활을 차단한다. 커스텀 제공자 변경도 목적지 검증 및 삭제 표식으로 보호한다.
- 인증 태그 오류·잘린 파일·잘못된 버전·seed 손실은 안전한 `corrupt` 코드로 보내고 “저장된 키를 읽을 수 없어요 — 다시 넣어 주세요”를 표시한다.

## 위협 모델과 허용 이유

이 저장 방식은 OS 키체인과 같은 보안 경계를 제공하지 않는다. **기기 고유값은 비밀이 아니다. 같은 사용자 계정의 다른 프로그램은 기기 고유값과 설정 파일을 읽어 암호화 키를 다시 유도하고 API 키를 복호화할 수 있다.** 관리자, 악성 코드, 실행 중 프로세스 메모리 접근, 설정 폴더와 기기 식별값을 함께 확보한 공격자도 방어하지 못한다. seed 방식은 암호문과 seed를 함께 복사하면 복호화할 수 있다. 메모리의 완전한 영점화, 전체 디스크 복사에 대한 보호, 악성 사용자의 삭제 표식 제거에 대한 보호는 제공하지 않는다.

AEAD는 암호문/nonce 변조, 잘못된 기기·제공자 키 사용을 거절한다. 파일 권한은 일반적인 다른 사용자 접근을 제한한다. API 키를 평문 파일에 두지 않으며, 로그·오류 원문·HTML·localStorage에는 넣지 않는다. 기존 네 글자 접미사 UI 규칙은 유지한다. 정상 Linux 저장 및 과거 버전의 평문 파일 호환 경로는 이번에 암호화 저장으로 자동 변경하지 않았다.

로그인 키체인이 시스템 명령에서도 거부되어 사용자가 앱을 사용할 수 없는 상황의 복구 수단이므로 허용한다. 보안 수준을 낮춘다는 명시적 동의가 필수이며 자동 전환하지 않는다. 설정에서 저장 위치를 계속 알리고, 사용자가 원할 때 정상 키체인으로 옮기거나 삭제할 수 있다. 기기 변경·초기화로 고유값이 바뀌면 다시 입력해야 한다. AEAD는 파일 삭제/롤백 자체를 막지 않으며, 앱을 통한 삭제는 별도 tombstone으로 보호한다.

## 의존성·출처·라이선스

새 의존성 및 Cargo.lock 변경 없음. 이미 설치된 manifest와 registry 소스를 확인했다.

| 구성 | 잠긴 버전 | 출처 | 라이선스 |
|---|---|---|---|
| AES-256-GCM | aes-gcm 0.10.3 | RustCrypto AEADs, https://github.com/RustCrypto/AEADs · crates.io | Apache-2.0 OR MIT |
| HKDF-SHA256 | hkdf 0.12.4 | RustCrypto KDFs, https://github.com/RustCrypto/KDFs/ · crates.io | MIT OR Apache-2.0 |

기존 sha2 0.10.9, rand 0.8.7, windows-sys 0.61.2를 그대로 사용한다. 실제 기기 식별값 조회는 프로덕션 경로에만 있고 시험은 고정 모의 식별값을 사용한다.

## 검증 결과

- `npm run build`: 통과. preflight·TypeScript·Vite 포함. 기존 번들 크기 경고만 남는다. `build.log`.
- 확장한 `check-ai-safety.mjs`, `check-ravi-key.mjs`: 통과. 실제 production handler를 모의 DOM/RPC에 실행해 4언어 × 3플랫폼 안내, 정확한 앱 경로, 재시도, 동의 버튼, 재시작 시 깨어남, 저장 위치, 비노출을 확인했다. 실 AI 호출 없음.
- Rust 모의 시험: 잠김 상태/문구 분류, 동의 없을 때 파일 없음, 실제 키체인 호출 없는 대체 저장, OS 키 교체 우선순위, 저장·읽기·캐시 없는 재읽기, 무작위 nonce, 0600, seed 재사용/손실, 잘린 파일/태그 변조/제공자 교체/심볼릭 링크 거절, 이동 실패 시 보존·성공 시 제거, 정상 저장으로 교체, 커스텀 목적지 검증, 삭제 실패와 복원 파일 부활 차단 모두 통과.
- 최초 지정 명령 `RV_BACKUP_FIXTURE_ROOT=$HOME/rv-test-fixture cargo test --manifest-path src-tauri/Cargo.toml`: fixture 하위 생성에서 `Operation not permitted`. 초기 구현 시점 결과 541 통과/213 실패/13 제외이며, 다수 실패가 같은 경로 생성 거부의 후속 실패다. `home-fixture-attempt.log`에 사실과 오류를 기록했다.
- `/tmp/rv-keyfallback-fixture`로 최종 전체 명령 재실행: **750 통과, 7 실패, 13 기존 제외**. 실패 7건은 모두 소켓 bind에서 `PermissionDenied / Operation not permitted`. `cargo-full-tmp.log`.
- 위 7개의 환경 차단 시험만 명시적 `--skip`으로 제외한 보조 실행: **750 통과, 0 실패, 13 기존 제외, 7 filtered out**, doc-test 1 기존 제외. `cargo-available-tests.log`. 소스 시험을 약화하거나 이 결과를 전체 통과로 표기하지 않았다.
- Windows 모듈 교차 타입 검사: 설치된 Rust 1.98.1 compiler를 `RUSTC`에 지정하고 `--offline --target x86_64-pc-windows-msvc`로 **통과**. 암호화 모듈 및 Win32 DACL 생성 경로를 포함한다. `windows-module-check.log`. Windows 전체 앱 빌드나 실제 Windows/Linux 실행을 했다는 뜻은 아니다.
- `scripts/check-*.mjs` 42개 모두 실행: **27 통과, 1 의도된 mutation RED, 14 환경 차단**. mutation 시험은 설계상 exit 1이며 해시 검증 제거를 탐지하고 원본을 복구했다. 기존 산출물 변경은 실행 전 복사본으로 복구했다. `check-results.json`과 각 로그 참조.
- `check-desktop-integration`은 새로 허용한 정확한 앱 경로 부분만 분리하고 기존 IPFS 본문·URL 규칙의 바이트 동일성 검증을 유지하도록 갱신했다. 통과.
- `git diff --check`: 통과. 새 모듈·수정 코드의 live-key 패턴, 로그/오류/IPC 경로와 복구 키 메모리 처리 검사 통과.

### 환경 차단 항목

Rust: `ai::connection_tests::loopback_mock_covers_http_refusal_and_delayed_response`, `ai_endpoint::tests::redirects_cannot_forward_a_question_to_another_destination`, `peers::tests::폴더_주소도_파일처럼_살아_있다고_본다`, `relay::tests::live_push_and_pairing_rooms_stay_off_disk`, `server::bind_probe::binding_the_phone_port_is_fast`, `server::wallet_usability_tests::actual_loopback_listener_supplies_peer_and_never_trusts_forwarding_headers`, `upload::photo_security_tests::streaming_size_mime_and_magic_are_checked_without_length`.

- `check-backup-ui.mjs`: 로컬 포트 생성 거부(EPERM)
- `check-cert-photos.mjs`: 브라우저 프로세스 시작 실패
- `check-certificate-bulk-ui.mjs`: 브라우저 프로세스 시작 실패
- `check-certificate-preview.mjs`: 로컬 포트 생성 거부(EPERM)
- `check-desktop-identity-fix.mjs`: 로컬 포트 생성 거부(EPERM)
- `check-desktop-languages.mjs`: 로컬 포트 생성 거부(EPERM)
- `check-desktop-ux.mjs`: 로컬 포트 생성 거부(EPERM)
- `check-ravi-panel-browser.mjs`: 브라우저 프로세스 시작 실패
- `check-ravi-promo-browser.mjs`: 브라우저 프로세스 시작 실패
- `check-ravi-understanding-browser.mjs`: 브라우저 프로세스 시작 실패
- `check-restore-vectors.mjs`: 로컬 포트 생성 거부(EPERM)
- `check-style-csp.mjs`: 로컬 포트 생성 거부(EPERM)
- `check-wallet-easy.mjs`: 로컬 포트 생성 거부(EPERM)
- `check-words-restore.mjs`: 로컬 포트 생성 거부(EPERM)

브라우저 이미지 QA는 이 실행에서 완료하지 못했다. 3개의 오래된 브라우저 프로필 충돌은 고유한 /tmp 산출물 경로를 가진 동일 시나리오 복사본으로 재시도했으나 포트 생성 거부에 걸렸다. 실제 키체인, 사용자 브라우저 프로필, 키체인 암호 재설정으로 우회하지 않았다. 브라우저/소켓 허용 환경에서 동일 전체 명령을 재실행해야 한다. 이 제한은 구현 오류를 다섯 번 수정한 실패가 아니라 실행 환경의 보안 경계이며, 이를 임의로 해제할 권한이 없다.
