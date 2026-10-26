# 키체인 저장 실패 수정 보고서

대상은 HEAD `06a3457`의 0.7.0이다. 이전 시도의 끝 네 자리 복원 변경을 이어서 정리했다. 버전 번호는 유지했다.

제공받은 검수 사실을 전제로, 실패 지점은 연결 확인이 아니라 `set_password` 저장이다. 기존 `google` 항목의 서명·ACL 차이가 원인일 가능성이 있지만 이 작업에서는 실제 항목을 조회하거나 그 원인을 확정하지 않았다. 기존 코드가 모든 native 오류를 `Unavailable`로 바꾸던 문제는 소스에서 확인했다.

## 선택한 접근과 이유

자동 복구 + 세대 계정 + 최종 안내를 함께 구현했다. 이전 항목을 갱신하지 못하는 상황에서도 새 보안 항목을 저장할 수 있게 하면서, 기존 계정의 읽기 호환을 유지하기 위한 선택이다.

- 맥·윈도우의 native get/set/delete 오류를 접근 거부·ACL, 사용자 취소, 잠김·상호작용 불가, 중복, 기타로 나눈다. 맥 OSStatus와 윈도우 오류 코드는 native 오류 타입에서 숫자로만 추출한다. native 오류의 메시지·바이트·속성은 포맷하지 않는다.
- 접근 거부·중복으로 set이 실패한 경우에만 같은 계정을 삭제하고 한 번 재시도한다. 삭제가 거부되면 `google.2`처럼 새 계정을 만든다. 재시도도 접근 거부·중복이면 새 세대로 전환한다. 취소·잠김은 같은 계정 재시도나 세대 생성을 강행하지 않는다.
- `<provider>.generation`에는 세대 번호만 0600 파일로 기록한다. 새 계정을 만들기 전에 번호를 예약하여 중단 뒤에도 새 항목을 찾을 수 있게 한다. 키나 끝자리는 쓰지 않는다. 세대는 1024에서 제한하고 손상된 번호는 오류로 처리한다.
- 읽기는 최신 세대부터 찾는다. 최신 항목이 잠기거나 거부되면 옛 키로 몰래 바꾸지 않는다. 예약된 세대에 항목이 없으면 이전 세대를 찾으며, 번호 파일이 없으면 기존 account를 읽는다. 최신 세대가 생긴 뒤에는 읽기·교체·삭제가 그 계정을 따른다.
- 사용자 삭제는 먼저 삭제 표식을 저장한 뒤 현재 세대만 삭제한다. 표식으로 이전 세대 재등장을 막고, 접근 불가한 이전 앱의 항목을 반복해서 건드리지 않는다. 표식 저장 실패 시 보안 항목 삭제도 진행하지 않는다.
- 복구 오류는 실패 단계와 안전한 분류만 IPC로 전달한다. 앞선 복구 단계도 안전한 분류로 보존한다. 키 상태 IPC의 `storage_errors`에도 읽기 분류를 보존한다. 화면은 고정된 번역 문구·단계·분류만 사용하고 native 코드와 임의 오류문을 출력하지 않는다.
- 저장 중 키체인 허용 팝업 안내와 복구 실패 시 지정된 Keychain Access 수동 삭제 안내를 한국어·영어·일본어·중국어로 추가했다. 저장·상태·삭제·커스텀 저장 명령은 Tauri 비동기 명령으로 UI 스레드에서 분리했다.
- 보안 저장 실패 시 새 키를 평문 파일로 저장하거나 평문으로 우회하는 경로는 추가하지 않았다. 기존의 옛 평문 파일 읽기·마이그레이션 호환 시험은 유지했다.
- `refreshKeys`의 `····abcd` 표시와 기본·커스텀 키 행의 끝자리를 0.6.9 방식에 맞춰 복원했다. 정확히 마지막 Unicode 4글자만 반환·표시하고 4글자 미만은 숨긴다. 프런트엔드는 4글자가 아닌 IPC 값을 거부하고 HTML을 이스케이프한다. 저장 직후·재시작·교체·교체 후 재시작·삭제 시험을 추가했다.

## 검증 결과

| 검증 | 결과 |
| --- | --- |
| `npm run build` | 통과. 기존 미사용 명령·번들 크기 경고 있음 |
| `node scripts/check-ai-safety.mjs` | 통과. native 분류·모의 저장소 격리·평문 우회 금지·끝 네 자리 제한·안전한 화면 검사 포함 |
| `check-ravi-*.mjs` 비브라우저 10개 | 전부 통과 |
| `check-ravi-*-browser.mjs` 3개 | Chrome 프로세스 시작 단계 실패. 화면 검사 실행 못 함 |
| 모의 `key_security_tests` | 25개 통과, 실패 0 |
| 지정된 `$HOME/rv-test-fixture` 전체 cargo 명령 | fixture 쓰기가 `Operation not permitted`로 거부됨. 526 통과 / 211 실패 / 13 ignored |
| 쓰기 가능한 `/tmp/rv-keychain-fixture` 전체 cargo 시험 | 730 통과 / 7 실패 / 13 ignored. 실패 7개 모두 루프백 포트 바인딩 `Operation not permitted` |

따라서 요청된 **기존 시험 전체 통과 조건은 이 실행 환경에서 충족하지 못했다**. 실패를 건너뛰거나 시험을 약화해 통과로 표시하지 않았다. `/tmp` 경로는 허용된 임시 fixture이며 실제 사용자 앱 데이터와 키체인을 사용하는 경로가 아니다.

루프백 바인딩으로 실패한 시험은 `ai::connection_tests::loopback_mock_covers_http_refusal_and_delayed_response`, `ai_endpoint::tests::redirects_cannot_forward_a_question_to_another_destination`, `peers::tests::폴더_주소도_파일처럼_살아_있다고_본다`, `relay::tests::live_push_and_pairing_rooms_stay_off_disk`, `server::bind_probe::binding_the_phone_port_is_fast`, `server::wallet_usability_tests::actual_loopback_listener_supplies_peer_and_never_trusts_forwarding_headers`, `upload::photo_security_tests::streaming_size_mime_and_magic_are_checked_without_length`이다.

모의 시험은 오류 종류별 재시도 여부, 삭제 거부 후 세대 전환, 여러 세대·재시작·키 교체, 최신 세대 읽기 거부, 안전한 오류 분류, 손상된 메타데이터, 삭제 표식 실패, 옛 계정 읽기 호환과 비밀 비노출을 검사한다. 화면 시험은 4언어 저장 중 안내, 대기 중 중복 저장 차단, 단계·분류 번역, 저장 실패 시 연결 확인 미실행, 끝자리 수명주기를 실행한다. 결과 요약은 `summary.json`, 개별 로그는 이 폴더에 있다.

## 실제로 확인하지 못한 부분

실제 AI 호출, 실제 OS 키체인 읽기·쓰기·삭제, `security` 명령 실행은 하지 않았다. Rust 시험은 `cfg(test)`의 MemoryStore만 사용한다. 맥 native 오류 타입의 숫자 추출은 만들어 넣은 오류 객체로 확인했다.

Developer ID 서명 앱이 이전 ACL 항목을 삭제할 수 있는지, 새 세대 항목이 실제 login 키체인에 만들어지는지, 「항상 허용」 팝업의 실제 표시·인증·응답, 실제 앱 재시작 후 키체인 읽기와 라비 기상은 검증하지 않았다. 윈도우 자격 증명 관리자 실동작도 미검증이다. 사용자가 제공한 ACL·서명 추정은 확정된 진단이 아니다.

## 전달

임시 `GIT_INDEX_FILE`로 대상 코드·시험·이 보고서·결과 요약만 커밋한다. 작업 브랜치 HEAD와 원래 Git 인덱스는 유지한다. 기존의 별도 artifacts 변경은 커밋에서 제외한다. push·태그는 만들지 않는다.

번들은 `artifacts/keychain.bundle`, ref는 `refs/heads/claude/keychain`이다. 번들은 기준 커밋 `06a3457`을 prerequisite로 하는 증분 번들이며, 적용 저장소에 그 기준 커밋이 있어야 한다.
