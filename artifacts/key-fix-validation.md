# 라비 저장 키 회귀 수정 검증

기준 커밋: `5748a51ade40a6fc42551d70ee6d3a7eacbdca8a` (컴퓨터 앱 0.6.9)
전달 ref: `refs/heads/claude/key-fix`
번들: `artifacts/key-fix.bundle`

저장 성공만으로 라비가 깨어납니다. 연결 확인은 회사별로 시작 시 한 번, 새 키 저장 시 한 번 백그라운드에서 진행합니다. 수동 재확인도 가능합니다. 400/401/403으로 거절된 회사만 제외하며 다른 저장 키로 전환합니다. 거절 기록에는 회사 이름과 숫자 상태 코드만 저장합니다. 같은 키의 재확인에서 시간 초과가 나더라도 앞선 명확한 거절은 유지하고, 새 키 저장 또는 확인 성공으로 해제합니다.

이전 `rv-ai-pending-checks` 기록은 앱 시작 시 제거합니다. 진행 중 확인은 메모리에서만 관리하며 라비의 활성 여부와 분리했습니다. 키 교체·삭제 후 도착한 이전 결과는 무시합니다. 백그라운드 결과가 입력 중인 설정 폼이나 키 저장 실패 안내를 덮지 않습니다.

저장 실패, 키 거절 및 Google AI Studio/Generative Language API 힌트, 429 한도, 5xx 회사 서버, 네트워크·시간 초과 안내를 한국어·영어·일본어·중국어로 제공합니다. 붙여넣기 공백·줄바꿈·따옴표·Bearer/key= 접두를 프런트와 네이티브 저장 전에 제거합니다. 연결 오류 IPC는 허용된 분류와 숫자 상태 코드만 반환하고 응답 본문·키·원시 네트워크 오류는 반환하지 않습니다. 화면의 키 끝자리 표시도 저장 여부 문구로 바꿨습니다.

실제 AI 키나 OS 키 저장소의 실제 사용자 키를 읽지 않았고 실제 AI 회사에 호출하지 않았습니다. 모든 시험은 합성 키, 모의 IPC/HTTP, 시험 전용 메모리 키 저장소를 사용했습니다.

## 통과

- `npm run build` (preflight, TypeScript, Vite). 기존 큰 청크 경고는 남습니다.
- `node scripts/check-ai-safety.mjs`: 안전 검사 및 실제 production 함수 기반 키 회귀 시험.
- 브라우저가 필요 없는 `scripts/check-ravi-*.mjs` 10개 전부: key, panel, promo-card, promo, similarity, state, understanding, understanding2, understanding3, understanding5.
- 허용된 시험 폴더에서 AI Rust 시험: `RV_BACKUP_FIXTURE_ROOT=/private/tmp/rv-key-fix-fixture cargo test --manifest-path src-tauri/Cargo.toml ai:: -- --skip loopback_mock_covers_http_refusal_and_delayed_response`: 55 통과, 7 기존 ignored. 로컬 소켓 모의 서버 시험은 이 명령에서 명시적으로 제외했습니다.
- 모의 HTTP 200/400/401/403/429/500/503/404, 네트워크·시간 초과, 4언어, 저장 실패, Google 입력 자동 선택, 느린 확인 중 재조회에도 깨어 있음, 실패 후 재시작, 과거 pending 마이그레이션, 다른 회사 정상 유지, 재확인·교체·삭제의 늦은 결과, 키/본문/로그 비노출.
- 회귀 변이 검증: pending 여부를 활성 문턱으로 되돌린 임시 소스는 실제 production 함수 기반 회귀 시험에서 실패했습니다. 변이 파일은 제거했습니다.
- `git diff --check`.

## 환경 때문에 전체 통과를 확인하지 못한 검증

요청된 정확한 명령 `RV_BACKUP_FIXTURE_ROOT=$HOME/rv-test-fixture cargo test --manifest-path src-tauri/Cargo.toml`을 실행했으나 이 세션의 쓰기 허용 목록에 해당 홈 폴더가 없어 시험 하위 폴더 생성이 `Operation not permitted`로 실패했습니다. 결과: 525 통과, 204 실패, 13 ignored.

허용된 작업 폴더로 바꿔 전체 시험을 추가 실행했습니다: `RV_BACKUP_FIXTURE_ROOT=$PWD/artifacts/key-fix-fixture cargo test --manifest-path src-tauri/Cargo.toml`. 결과: 722 통과, 7 실패, 13 ignored. 아래 7개는 모두 로컬 소켓 생성이 `Operation not permitted`로 실패했습니다. 시험을 변경하거나 무시해 전체 통과로 처리하지 않았습니다.

- `ai::connection_tests::loopback_mock_covers_http_refusal_and_delayed_response` (새 루프백 HTTP 200/400/401/403/429/503·연결 거부·지연 시험)
- `ai_endpoint::tests::redirects_cannot_forward_a_question_to_another_destination`
- `peers::tests::폴더_주소도_파일처럼_살아_있다고_본다`
- `relay::tests::live_push_and_pairing_rooms_stay_off_disk`
- `server::bind_probe::binding_the_phone_port_is_fast`
- `server::wallet_usability_tests::actual_loopback_listener_supplies_peer_and_never_trusts_forwarding_headers`
- `upload::photo_security_tests::streaming_size_mime_and_magic_are_checked_without_length`

`check-ravi-panel-browser.mjs`, `check-ravi-promo-browser.mjs`, `check-ravi-understanding-browser.mjs`도 모두 실행했으나 Chrome 시작 단계에서 `Failed to launch the browser process!`로 실패했습니다. 실제 UI 브라우저 검증은 완료하지 못했습니다.

임시 `GIT_INDEX_FILE`로 필요한 소스·시험·이 보고서만 커밋하고, 현재 HEAD와 사용자 인덱스·관련 없는 기존 변경을 유지합니다. push와 태그 생성은 하지 않습니다.
