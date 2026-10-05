# 라비 이해·실행 계약 개선 결과 (2026-10-06)

범위: 데스크톱 저장소만. 기준 커밋: `953ba90337b974ea7e894d01b68c1271fdfbc09f` (작업 당시 package 0.6.7).
지정된 `RV-ravi-understanding-audit-1006.md`는 작업 시작과 최종 확인 때 존재하지 않았다. 따라서 사장 25·손님 20·일반 15문항을 직접 재구성했다. 사용자 제공 원래 60문항과 동일한 시험이라고 주장하지 않는다. 폰 저장소는 수정하거나 개선 점수를 측정하지 않았다.

| 시험 | 개선 전 | 개선 후 | 오매칭 전 → 후 |
|---|---:|---:|---:|
| 사용자 제공 0.6.6 데스크톱 감사 | 14/60 (23.3%) | 재측정 안 함 | 10 → 미측정 |
| 재구성 동일 시험 전체 | 15/60 (25.0%) | 60/60 (100%) | 10 → 0 |
| 사장 | 1/25 | 25/25 | 4 → 0 |
| 손님 | 9/20 | 20/20 | 5 → 0 |
| 일반 | 5/15 | 15/15 | 1 → 0 |

새 60문항에서 여전히 실패하는 문항: **없음**. 통과는 의도와 답 종류·실제 화면/탭 연결을 확인하며, 정직한 기능 제한 안내도 요청한 기준에 따라 통과로 계산한다. 휴무 저장, 메뉴·가게 수정, 주문 링크 입력, 화면 테마·글씨 크기 변경, 파일·영상 전송, 중고 거래 대행은 키 없는 라비가 직접 실행하지 않는다고 안내한다. 단순한 이해 통과율이며 새 기능 구현률이나 자유문장 전체 정확도를 뜻하지 않는다.

변경: `src/ravi-capabilities.json`에서 안내·카테고리·4언어 문구·시작 칩·AI 액션 스키마·실제 페이지/탭을 제공한다. 충돌하거나 근거가 부족한 질문은 명시적으로 거절하고 관련 입력 단추 3개를 제공한다. 도움말과 대안 단추는 말을 입력하고, 사용자가 제출한다. 4개 시작 칩 × 4언어 모두 통과했다. 도움말은 4언어로 범주별 표시하며 AI가 필요한 기능을 구분한다.
기존에 없는 `order`/`issue` 페이지 연결은 실제 가게 주문 탭과 만들기 화면으로 이었다. 매출은 가게 매출 탭으로, 가게 정보는 가게 정보 탭으로 연결한다. 가게 필드·휴무·메뉴는 직접 수정할 때 기존 자동 저장 경로를 이용하며, 라비가 값만 채운 상태는 저장되지 않은 초안임을 알린다. 주문 링크는 AI 액션 목록과 필드 실행 목록에서 제거했다. 현재 만들기 화면과 연결되지 않는 예전 숨은 발행 양식의 `issue_set` 액션도 목록과 실행기에서 제거했고, 기존 만들기 화면/자산 만들기 단추 안내만 남겼다. 테마는 실제 기존 가게 색 미리보기와 수동 저장만 남겼다.
금액·주소 파서는 변경하지 않았다. 기존 송금 준비 실행기의 주소 출처, 유한 양수 금액, 사용자 확인 화면 조건을 실제 함수로 다시 확인했다. 라비에는 직접 송금·결제 액션이 없다. 붙여 넣은 자격 증명/시드 형태의 입력은 화면에 되풀이하거나 AI에 전달하기 전에 거절한다. 모든 새 테스트는 합성 데이터와 모의 RPC이며 실제 AI 호출·실제 송금은 하지 않았다.

## 검증

- `npm run build`: 통과 (기존 큰 청크 경고만).
- `node scripts/check-ravi-understanding.mjs`: 60/60, 오매칭 0. 실제 `chatSendExisting`, 화면/탭 연결, 4언어 도움말/단추 입력, 거절 단추, 비밀 입력 차단, 실제 송금 준비 핸들러를 검사했다.
- `CARGO_NET_OFFLINE=true node --test scripts/*.test.mjs web/*.test.mjs`: 57/57 통과. 첫 실행의 installer test 의존성 다운로드 실패는 캐시 사용으로 해결했다.
- 기존 라비 Node 검사(panel/state/promo/card), AI 안전, 송금 확인, 폰 거래 검사: 통과. 백업 안전 합성 검사 15/15, 백업 결과·자산 만들기·발행 게이트·지도·도움말·환불·명단·로컬 발행 검사도 통과.
- 요청 그대로 `RV_BACKUP_FIXTURE_ROOT=$HOME/rv-test-fixture cargo test --manifest-path src-tauri/Cargo.toml`: 실행했으나 지정 폴더 쓰기가 샌드박스로 차단되어 521 통과/202 실패/13 제외. 이후 허용된 작업 폴더의 별도 합성 fixture로 전체 재실행: **718 통과/6 실패/13 제외**. 남은 6개는 아래 로컬 포트 바인딩 EPERM이다.
- 모든 `scripts/check-*.mjs`를 실행 시도했다. 브라우저 관련 검사는 Chrome 실행 또는 localhost listen EPERM으로 끝나서 실제 브라우저 시각 검증은 미완료다. 새 브라우저 검사 스크립트도 함께 제공하며 모의 UI 함수 검사를 통과시켰다.
- `check-desktop-integration.mjs`는 이전 Ravi hero `<span id="ravi-face">`를 기대하는 기존의 낡은 단정에서 실패한다. 기준 커밋의 HTML도 이미 그 hero를 제거했다. 해당 무관한 테스트 단정은 변경하지 않았다.
- `check-desktop-mutation.mjs`의 의도적 hash 검증 제거는 예상대로 RED(101)이고 소스는 바이트 단위 복원했다. 테스트가 바꾼 기존 증거 파일도 원복했다.
- 상세 검사 상태: `verification.json`. 원시 로그는 같은 작업 artifact 폴더에 있다. 전부 통과했다고 보고하지 않는다.

남은 Rust 환경 실패:

- `ai_endpoint::tests::redirects_cannot_forward_a_question_to_another_destination`: `Operation not permitted` (합성 localhost listen).
- `peers::tests::폴더_주소도_파일처럼_살아_있다고_본다`: `Operation not permitted` (합성 localhost listen).
- `relay::tests::live_push_and_pairing_rooms_stay_off_disk`: `Operation not permitted` (합성 localhost listen).
- `server::bind_probe::binding_the_phone_port_is_fast`: `Operation not permitted` (합성 localhost listen).
- `server::wallet_usability_tests::actual_loopback_listener_supplies_peer_and_never_trusts_forwarding_headers`: `Operation not permitted` (합성 localhost listen).
- `upload::photo_security_tests::streaming_size_mime_and_magic_are_checked_without_length`: `Operation not permitted` (합성 localhost listen).

## 전달

임시 `GIT_INDEX_FILE`에 이번 변경 파일만 올리고 `git commit-tree`로 커밋을 작성하여 `refs/heads/claude/ravi-understand`로 전달한다. 기존 HEAD/브랜치와 공유 인덱스를 변경하지 않는다. `artifacts/ravi-understand.bundle`은 위 기준 커밋을 전제하는 증분 번들이다. push·태그는 하지 않는다.
