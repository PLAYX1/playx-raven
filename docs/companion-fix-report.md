# 라비 트레이·말풍선 수정 보고서

작성일: 2026-10-07 · 작업 폴더: `/Users/gimmusong/wt-rv-082`

## 결과와 범위

작업 시작 전에 병합 커밋 `52f11f0`과 부모 `0ed4b75`, `300ab24`를 확인했다. 신고 이미지 `4.png`, `5.png`를 직접 읽었다. macOS 불투명 대체 창, `#bubble`의 `min-width:0`, 캐릭터와 패널의 가로 flex 배치가 좁은 세로 글자·흰 틀을 만드는 원인이었다.

기본 상주는 트레이다. 신규·이전 설정 모두 `always_visible`이 없는 경우 **false**로 읽고, 네이티브 라비 창은 숨긴 상태로 생성한다. 첫 실행에는 메인 화면에 “라비는 트레이에 있어요. 필요할 때만 나타나요” 안내를 착지 후 한 번 표시한다. 메인 창 닫기는 큰 웹뷰를 파기하며 프로세스와 트레이는 유지한다.

- 트레이 호출은 일시적인 말풍선을 연다. 메인 창이 활성화돼 있으면 그 창의 대화를 연다.
- 입금 관찰·상점 주문·자동 백업 오류/경고·트레이 시작 인사는 공통 알림 제한을 거친다. 입금은 기존 RPC 결과를 관찰하며 새 지갑 폴링을 추가하지 않았다. 알림 본문에는 금액·주소·고객 정보 대신 고정된 상태 문구만 전달한다.
- 기본 조용한 시간은 **22시~08시**, 하루 상한은 **5회**, 자동 퇴장은 **12초**다. “오늘은 그만”은 해당 날짜 동안 자동 등장을 막는다. 상한 0은 자동 알림을 끈다. 직접 호출은 허용한다. 제한·사용 횟수·오늘 중지는 디스크에 보존돼 재시작으로 초기화되지 않는다. 시간 계산은 메인 화면에서 동기화한 기기 시간대 오프셋을 사용한다.
- 억제된 알림도 트레이 얼굴의 뱃지로 남는다. 호출·메인 열기로 뱃지를 해제한다. 입력/음성 응답 중에는 자동 퇴장을 보류하고 다른 알림이 대화를 덮지 않게 했다. 제출·포커스 이탈 후 다시 퇴장 시간을 잰다.
- “항상 떠 있는 라비”는 메인 설정에서만 직접 켤 수 있다. 활성 메인 창에서는 숨고, 메인 닫기·최소화 후 다시 나타난다. 이 경우에도 말풍선은 시간이 지나면 접힌다.
- 선택형 상시 모드는 투명·무테 캐릭터를 사용한다. 화면 높이와 작게/보통/크게 설정에 비례해 크기를 계산한다. 메인과 같은 `ravi-scene.svg`를 사용하며 불투명도 1과 원래 팔레트를 유지한다. 졸 때는 눈과 z 표시만 바뀐다.
- 말풍선은 캐릭터 위/아래로 배치한다. 너비는 **288~360 논리 픽셀**, 본문은 자동 줄바꿈한다. 실제 DOM 높이를 측정해 네이티브 창 크기를 조절한다. 화면 위쪽에서는 아래로 뒤집고, 오른쪽에서는 왼쪽으로 이동하며 꼬리 위치를 맞춘다. 극단적으로 작은 화면은 메인 창으로 연결한다. 평상시 캐릭터에는 패널·스크롤바가 없다. 내용이 화면 높이보다 길어질 때만 말풍선 안의 단일 스크롤 영역을 쓴다. 중첩 스크롤은 없고 꼬리는 별도로 유지한다.
- 라비 클릭은 기존 메인 창의 대화를 열거나, 메인이 없으면 한 줄 입력 말풍선을 연다. 설정은 메인 화면으로 옮겼다. 별도 좁은 설정 패널은 제거했다.
- 4개 언어 설정·알림·접근성 문구 42종과 트레이 메뉴를 제공한다. 스크린리더 이름·키보드 호출·동작 줄이기·기존 음성 동의/철회를 유지한다. Windows/macOS는 캐릭터 밖 투명 모서리의 클릭 통과를 네이티브 hit-test로 처리한다. 숨으면 프레임 루프와 hit-test 대기를 중지한다.

## 검증

`npm run check:pre-release`(preflight, TypeScript, Vite, 첫 실행, 기존 라비 물리/수명주기, 신규 companion 검사)는 통과했다. 빌드에는 기존 큰 청크 경고가 남는다. 새 companion 검사를 pre-release 경로에 연결했다.

Rust 크기 순수 함수 시험은 **101,376 조합**(320~3840 너비, 480~2160 높이의 일정 간격 표본, 3개 크기, 음수 좌표/화면 바깥 4개 앵커, 4개 콘텐츠 높이)을 순회해 말풍선 최소·최대 너비, 화면 내부 배치, 캐릭터 범위를 검증한다. 위/아래 방향 전환도 별도로 검사한다. 이는 해당 입력 범위의 결정적 속성 시험이며 모든 가능한 실수 입력에 대한 형식 증명은 아니다.

조용한 시간의 자정 넘김/당일 범위/끄기, 횟수 상한, 날짜 변경, 오늘 중지, 설정 마이그레이션, 입력 유효성, 4개 언어 트레이 문구도 Rust에서 검사한다. 최종 관련 Rust 필터는 **28개 통과**다. 기존 첫 실행·음성 동의/철회·직접 수정 취소 시험도 재실행해 통과했다.

전체 Rust: **757 통과 / 환경 실패 7 / 기존 ignored 13**. 환경 실패 7개만 명시적으로 제외한 재실행: **757 통과 / 실패 0 / ignored 13 / filtered 7**. 바이너리 시험 0개, doc-test의 기존 ignored 1개도 확인했다. 7개 실패는 다음 루프백 소켓 시험의 macOS sandbox `PermissionDenied / EPERM`이다.

1. `ai::connection_tests::loopback_mock_covers_http_refusal_and_delayed_response`
2. `ai_endpoint::tests::redirects_cannot_forward_a_question_to_another_destination`
3. `peers::tests::폴더_주소도_파일처럼_살아_있다고_본다`
4. `relay::tests::live_push_and_pairing_rooms_stay_off_disk`
5. `server::bind_probe::binding_the_phone_port_is_fast`
6. `server::wallet_usability_tests::actual_loopback_listener_supplies_peer_and_never_trusts_forwarding_headers`
7. `upload::photo_security_tests::streaming_size_mime_and_magic_are_checked_without_length`

기존 `check-*.mjs` 45개를 모두 실행했다. 재실행까지 반영한 결과는 **30 통과 / 의도된 mutation 검출 1 / 환경 차단 14**다. 신규 검사 1개까지 합하면 **31 통과 / mutation 검출 1 / 환경 차단 14**다. 따라서 **기존 check 전부 통과 조건은 충족하지 못했다.** 포트/Chrome 차단을 성공으로 바꾸거나 assertion을 제거하지 않았다.

새 백업 알림 연결로 격리 시험에 `ravi_companion` 어댑터가 없어 컴파일이 실패했다. 시험 어댑터를 추가하고 고정 `backup` 이벤트만 허용하도록 assertion을 넣어 수정했다. 백업 안전 시험 15개가 재통과했다. 과거 실행이 남긴 브라우저 프로필 경로 충돌 3개는 새 격리 artifact 경로로 재실행했고 실제 차단 원인이 루프백 EPERM임을 확인했다. mutation 실행 후 대상 원본이 HEAD와 동일함을 확인했다. 복구 벡터 `--no-core` 추가 실행은 30개 통과했고 Core 구간 통과를 뜻하지 않는다.

| 검사 | 결과 |
|---|---|
| `check-ai-safety.mjs` | 통과 |
| `check-backup-result.mjs` | 통과 |
| `check-backup-safety.mjs` | 통과 |
| `check-backup-ui.mjs` | 환경 차단 · 루프백 bind EPERM |
| `check-cert-photos.mjs` | 환경 차단 · Chrome 프로세스 실행 차단 |
| `check-cert-roster.mjs` | 통과 |
| `check-certificate-bulk-ui.mjs` | 환경 차단 · Chrome 프로세스 실행 차단 |
| `check-certificate-preview.mjs` | 환경 차단 · 루프백 bind EPERM |
| `check-desktop-identity-fix.mjs` | 환경 차단 · 루프백 bind EPERM |
| `check-desktop-integration.mjs` | 통과 |
| `check-desktop-languages.mjs` | 환경 차단 · 루프백 bind EPERM |
| `check-desktop-ux.mjs` | 환경 차단 · 루프백 bind EPERM |
| `check-easy-create.mjs` | 통과 |
| `check-firstrun.mjs` | 통과 |
| `check-issue-gate.mjs` | 통과 |
| `check-local-wallet-publish.mjs` | 통과 |
| `check-map-copy.mjs` | 통과 |
| `check-merchant-map.mjs` | 통과 |
| `check-peer-help.mjs` | 통과 |
| `check-phone-transaction.mjs` | 통과 |
| `check-ravi-agent.mjs` | 통과 |
| `check-ravi-companion.mjs` | 통과 |
| `check-ravi-key.mjs` | 통과 |
| `check-ravi-panel-browser.mjs` | 환경 차단 · Chrome 프로세스 실행 차단 |
| `check-ravi-panel.mjs` | 통과 |
| `check-ravi-promo-browser.mjs` | 환경 차단 · Chrome 프로세스 실행 차단 |
| `check-ravi-promo-card.mjs` | 통과 |
| `check-ravi-promo.mjs` | 통과 |
| `check-ravi-similarity.mjs` | 통과 |
| `check-ravi-state.mjs` | 통과 |
| `check-ravi-understanding-browser.mjs` | 환경 차단 · Chrome 프로세스 실행 차단 |
| `check-ravi-understanding.mjs` | 통과 |
| `check-ravi-understanding2.mjs` | 통과 |
| `check-ravi-understanding3.mjs` | 통과 |
| `check-ravi-understanding5.mjs` | 통과 |
| `check-ravi-voice.mjs` | 통과 |
| `check-restore-vectors.mjs` | 환경 차단 · 루프백 bind EPERM |
| `check-send-confirmation.mjs` | 통과 |
| `check-shop-seal.mjs` | 통과 |
| `check-staff-refund.mjs` | 통과 |
| `check-style-csp.mjs` | 환경 차단 · 루프백 bind EPERM |
| `check-wallet-easy.mjs` | 환경 차단 · 루프백 bind EPERM |
| `check-wallet-vault.mjs` | 통과 |
| `check-words-restore.mjs` | 환경 차단 · 루프백 bind EPERM |
| `check-desktop-mutation.mjs` | 의도된 mutation 검출 |
| `check-companion-fix.mjs` | 통과 |

## 미검증과 제한

- **수정된 실제 네이티브 창 캡처는 하지 못했다.** CUA 앱 목록에는 RavenVault가 실행 중이지 않았다. 기존 브라우저 검사들은 sandbox에서 Chrome 실행 또는 루프백 서버 생성에 실패했다. 별도 로컬 모의 미리보기는 브라우저 보안 정책이 `file:` 프로토콜을 거부했다. 우회하지 않았으며 이 검사를 시각적 통과로 기록하지 않는다. 실제 macOS 투명 합성, 트레이 클릭, 최소화/포커스 순서, DPI 이동, 클릭 통과는 GUI 환경에서 추가 실측이 필요하다.
- 네이티브 RSS/CPU는 실측하지 않았다. 큰 웹뷰 파기, 숨김 상태 0 프레임, 기존 메모리 합산 시험을 유지했으며 별도 서비스 폴링이나 큰 상주 웹뷰를 추가하지 않았다. 특정 메모리 예산 수치의 달성을 주장하지 않는다.
- 전역 단축키는 구현하지 않았다. 공식 플러그인이 현재 의존성·로컬 Cargo 캐시에 없으며 제한된 네트워크 환경에서 새 의존성을 확보하지 못했다. 4개 언어 설정에 트레이 호출 경로와 미지원 상태를 명시했다.
- macOS 투명을 위해 Cargo의 `macos-private-api`와 Tauri `macOSPrivateApi`를 켰다. Wayland/일반 창 대체 모드의 기존 제한은 유지한다. 클릭 통과는 전체 SVG 알파 픽셀 판독이 아닌 보수적인 캐릭터 타원 영역이다.

## 산출물과 재현

- 보고서: `docs/companion-fix-report.md`
- 비밀값 없는 시험 요약: `artifacts/companion-fix-checks.json`
- 전달 번들: `artifacts/companion-fix.bundle` (병합 커밋 `52f11f0`을 prerequisite로 하는 증분 번들)
- 기본 인덱스는 이전 병합 때와 같이 오래된 상태여서 건드리지 않았다. `GIT_INDEX_FILE=/private/tmp/rv-companion-fix.index`를 HEAD로 초기화해 변경과 커밋을 관리했다. worktree 메타데이터는 `/private/tmp/rv-companion-fix-git`, 객체·브랜치는 원래 공유 Git 저장소에 기록한다.

재현 명령:

```sh
npm run check:pre-release
RV_BACKUP_FIXTURE_ROOT=/tmp/rv-082-fixtures CARGO_TARGET_DIR=/private/tmp/rv-082-cargo-target cargo test --offline --manifest-path src-tauri/Cargo.toml companion --lib
GIT_INDEX_FILE=/private/tmp/rv-companion-fix.index git status --short
git bundle verify artifacts/companion-fix.bundle
```

전체 로그는 `/private/tmp/companion-fix-checks`와 `/private/tmp/companion-fix-*.log`에 두고 커밋하지 않았다. 기존 추적 시험 artifact의 일시적 변경은 복원했다. 실제 송금·외부 AI 호출·push·태그 생성은 하지 않았다. 시드·토큰·비밀번호를 보고서나 요약에 포함하지 않았다.
