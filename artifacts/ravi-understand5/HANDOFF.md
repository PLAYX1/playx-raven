# 컴퓨터 라비 이해 5차

기준: 1667f85f2a2be689297c263407bca6c28caa7fb0
전달 ref: refs/heads/claude/ravi-understand5
전달 bundle: artifacts/ravi-understand5.bundle

## 구현

- 지갑 암호 분실(password) 안내: 보관한 복구 단어로 지갑을 되살린 뒤 새 암호를 설정한다. 단어도 없으면 잊은 암호 복구 불가를 명시한다. 단어·암호를 대화로 받거나 잠금을 풀지 않는다. 버튼은 기존 설정 화면까지만 연다.
- 지난 매출(sales): 어제·지난주·이번 달·장사·손님 수 구어체를 보강한다. 기존 매출 화면을 안내하며 실제 숫자를 읽거나 추측하지 않는다.
- 주변 가게 찾기(map): 컴퓨터의 map-card.ts/index.html에는 자기 가게 등록 화면만 있으므로 폰 앱 지도를 안내한다. 없는 검색 화면 버튼이나 위치·영업 상태를 만들지 않는다.
- 카톡·카카오톡·단톡 게시글 요청은 홍보 도우미로 확정한다. 메뉴를 소재로 글을 쓰는 것과 실제 메뉴 수정 요청을 구분한다. 독립된 여러 요청은 두 후보를 유지한다.
- 나에게 보내 준다는 표현은 받기 방향으로 구분한다. 송금/이체 및 돈+보내기는 보내기 안내로 확정한다. 주소·금액 추정 및 직접 송금 없음.
- 여섯 대상 의도마다 한국어 구어체를 15개 이상 추가했다. 35→37개 의도, 624→734개 예문(+110). 검수자 제시 문장을 학습 표에 그대로 넣지 않았으며 기존 120문항과 문자/어미 정규화 중복 0을 검사했다.
- password의 pass는 회원권이 아니므로 영문 단어 경계를 적용한다. 기존 거래 내역·돌려받기·연락처·매상 내보내기 신호를 보강해 예문 추가에 따른 회귀를 막았다.
- 쓰이지 않는 옛 번역 13개를 제거해 안내 모듈 30KB 증가 한도를 유지했다. 사용 중인 제목·본문·버튼의 네 언어 번역은 유지한다.
- main.ts, Rust, 송금/승인/비밀 입력 처리 및 문턱(0.68/0.15/0.06)은 수정하지 않았다. 실제 AI·송금 없이 합성 DOM/RPC 차단 fixture에서 검사했다.

## 검증

- npm run build 통과. 안내 모듈 증가 26,966 bytes / 제한 30,000 bytes.
- scripts/check-ravi-*.mjs 12개 전부 실행: 비브라우저 9개 통과, 브라우저 3개는 Chrome 프로세스 실행 실패로 검증 불가. 검사기를 완화하거나 실패를 통과로 표시하지 않았다(checks.json 및 개별 로그).
- 기존 60문항 60/60, 120문항 120/120, 기존 상황 40문항 40/40. 오매칭 0, 120/40문항 언어 누수 0. 120문항 원본은 변경하지 않았다(summary.json에 SHA-256 기록).
- 새 분리 평가 36문항 36/36, 모두 확정·오매칭 0·언어 누수 0. 새 두 안내 네 언어 검사 8건 및 복합 요청·지원 불가·송금 준비 화면·기록 전 비밀 차단도 검사했다.
- 비공개 검수자 40문항 원본은 없어 재시험하지 못했다. 위 36문항은 새 회귀 시험이며 비공개 87.5%의 재측정 결과가 아니다.

## 5겹 교차검증

의도별 i%5 분할로 매번 나머지 네 겹에서 IDF와 예문 벡터를 재구축했다. 120/40 및 새 36 시험 문장은 학습/문턱 선정에 쓰지 않았다. 문턱을 낮추지 않고 확정률을 높였다.

| 동일한 기존 제외 문장 비교 | 이전 | 이후 |
|---|---:|---:|
| 보내기 확정 | 7/18 (38.9%) | 14/18 (77.8%) |
| 받기 확정 | 12/18 (66.7%) | 18/18 (100%) |
| 전체 확정 | 368/624 (59.0%) | 378/624 (60.6%) |
| 확정 오매칭 | 3/368 (0.82%) | 0/378 (0%) |

확장된 734개 전체는 확정 481/734 (65.5%), 확정 정답 481/481, 오매칭 0%다. 올바른 후보/거절 포함 통과는 661/734 (90.05%)이며 의미 이해 100%를 주장하지 않는다. results5.json에 동일 문장 비교와 의도/겹 지표, cross-validation.json에 검색 단독/전체 판별 지표를 기록했다.

## Rust 환경 제한

요청한 `RV_BACKUP_FIXTURE_ROOT=$HOME/rv-test-fixture cargo test --manifest-path src-tauri/Cargo.toml`을 그대로 실행했다. HOME 아래 fixture 쓰기 권한이 없어 522 통과/202 실패/13 무시였다(cargo-requested.log).

쓰기 가능한 `/tmp/ravi5-rust-fixture`로 전체 재실행: 718 통과/6 실패/13 무시. 남은 6개는 모두 로컬 포트 바인딩의 Operation not permitted다(cargo-writable-full.log).

- ai_endpoint::tests::redirects_cannot_forward_a_question_to_another_destination
- peers::tests::폴더_주소도_파일처럼_살아_있다고_본다
- relay::tests::live_push_and_pairing_rooms_stay_off_disk
- server::bind_probe::binding_the_phone_port_is_fast
- server::wallet_usability_tests::actual_loopback_listener_supplies_peer_and_never_trusts_forwarding_headers
- upload::photo_security_tests::streaming_size_mime_and_magic_are_checked_without_length

위 여섯 환경 제한 검사만 명령행에서 제외한 추가 실행: 718 통과/0 실패/13 무시/6 제외, main 시험 완료 및 doc-test 1 무시(cargo-accessible.log). Rust 코드를 바꾸거나 보안 검사를 삭제하지 않았다. 전체 Rust와 브라우저가 통과했다고 보고할 수 없다.

## 전달

선택한 소스·새 검사·이 폴더 검증 기록만 임시 GIT_INDEX_FILE로 commit-tree에 넣는다. 지정 ref의 증분 bundle로 전달한다. 작업 브랜치 HEAD와 원래 Git 인덱스는 유지하고 기존 검증 산출물은 복원했다. push·태그 없음. 번들 검증과 HEAD/index 보존 결과는 delivery.json(번들 외부)에 기록한다.
