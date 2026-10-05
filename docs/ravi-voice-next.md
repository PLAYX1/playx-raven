# 라비 음성 · 데스크톱 다음 단계

2026-10-05. 이번 구현은 승인된 proto3의 SVG 다각형·피벗·스프링 움직임을 `src/ravi-rig.ts`로 이식한다. 호수 반사는 같은 캐릭터 그룹을 `use`로 참조한다. 색 추출 기록은 `src/assets/ravi-palette.json`이다. 홈 중앙과 라비 메뉴는 같은 대화 DOM을 옮겨 쓰며 기존 AI 명령·사용자 키·의도 검사·금액 대조·지갑 잠금·수동 승인을 유지한다. 가짜 시안 응답은 이식하지 않는다.

현재 음성 입력은 WKWebView / WebView2에 `SpeechRecognition` 또는 `webkitSpeechRecognition`이 있을 때만 제공한다. 한국어 `ko-KR`와 interim 자막을 쓰며 결과는 대화 입력칸에만 넣는다. 사용자가 보내기를 눌러 기존 라비 경로로 질문한다. API가 없으면 마이크를 숨기고 오류 시 글로 질문하도록 안내한다. 읽기는 `speechSynthesis`, 기본 끔이며 한국어 자연 목소리가 있는 경우만 제공한다. 장난 목소리는 제외하고 한국어 목소리가 없으면 글로 안내한다. CSP 확장은 하지 않았다. 실제 WebView의 지원 여부·마이크 권한·음질은 OS별 실기기 점검이 필요하다.

홈·라비를 벗어나거나 승인·암호·백업·신고·키 시트가 열리면 음성과 리그를 중지한다. 창 포커스 상실과 탭 숨김도 중지하며 늦게 도착한 인식/낭독 콜백은 세션 번호로 폐기한다. 다시 활성화해도 인식과 낭독을 자동 재개하지 않는다. 승인 화면에 「음성으로는 승인할 수 없어요」를 표시한다. 음성 모듈은 RPC·송금·승인 콜백을 갖지 않는다.

## 네이티브 STT 후속 설계 (이번 구현 범위 밖)

- 맥: SFSpeechRecognizer 어댑터. 윈도: OS 음성 인식 어댑터. 네이티브 구현에 앞서 대상 OS·지원 언어·오프라인 지원·권한 표시·배포 서명 요구사항을 공식 문서로 확인한다.
- 공통 계약: `start(locale, sessionId)`, `abort(sessionId)`와 `interim`, `final`, `error`, `ended` 이벤트. 임시 마이크 세션은 전경에서 사용자가 누를 때만 시작한다. 원본 음성과 인식 텍스트는 파일·로그·분석 이벤트에 저장하지 않는다.
- JS는 동일한 `RaviRecognition` 계약을 통해 자막과 입력칸만 갱신한다. 네이티브 STT에 지갑·키·서명·승인 권한을 전달하지 않는다. 송금 요청도 기존 금액/의도 검사 후 칸 채우기까지만 허용한다.
- 승인 진입·백업·앱 비활성·권한 취소 시 세션을 폐기하고 네이티브 녹음을 즉시 중지한다. 세션 번호가 다른 이벤트는 버린다. 승인에는 기존 직접 클릭과 지갑 암호 검사를 그대로 사용한다.
- 대표 결정이 필요한 후속 범위: 네이티브 STT 도입 여부, 오프라인만 허용할지, 한국어 외 인식 언어, OS별 권한 설명과 실제 음성 품질 기준. 이번 단계에서는 플러그인·권한·CSP를 늘리지 않는다.

검증은 가짜 AI/RPC/음성 대역으로 실행한다. 실제 AI 호출·메인넷 전송·키 입력을 시험에 사용하지 않는다.

## 이번 검증 결과

- `npm run build`, `node scripts/check-send-confirmation.mjs`, `node scripts/check-ai-safety.mjs`, `node scripts/check-ravi-state.mjs` 통과. 리그 7개 상태·스프링 연속성·reduced-motion 깜빡임·중지, 음성 지원/오류·자막·자연 목소리 선택·늦은 이벤트 거부, 공유 홈/메뉴·승인/백업/키/신고 중지·다섯 손가락·입금 중복 반응 방지와 19개 문구의 세 언어 번역을 가짜 대역으로 검사한다.
- `RV_BACKUP_FIXTURE_ROOT=/tmp/rv-test-fixture cargo test --lib`: 실제 실행·컴파일 완료. 712 통과, 13 무시, 6 실패. 실패한 테스트는 로컬 소켓 바인딩의 `Operation not permitted`에 걸렸다. 해당 6개만 `--skip`한 재실행은 712 통과, 실패 0, 무시 13, 제외 6이다. 코드 실패나 전체 Rust 통과로 기록하지 않는다.
- 제외한 테스트: `ai_endpoint::tests::redirects_cannot_forward_a_question_to_another_destination`, `peers::tests::폴더_주소도_파일처럼_살아_있다고_본다`, `relay::tests::live_push_and_pairing_rooms_stay_off_disk`, `server::bind_probe::binding_the_phone_port_is_fast`, `server::wallet_usability_tests::actual_loopback_listener_supplies_peer_and_never_trusts_forwarding_headers`, `upload::photo_security_tests::streaming_size_mime_and_magic_are_checked_without_length`.
- 실제 브라우저 배치 검증 미실행: 검사 서버의 `127.0.0.1` 바인딩이 샌드박스에서 거부됐고 로컬 시험 화면의 `file:` URL은 브라우저 보안 정책이 거부했다. 언어 화면 검사도 기존 격리 프로필 충돌로 시작하지 못했다. 실측 스크린샷·겹침·WKWebView/WebView2 권한과 음질을 통과로 주장하지 않는다. 허용된 실기기 환경에서 홈 1120×780 / 1440×900의 중앙 라비와 옆 요약, 네 언어 줄바꿈, 키 연결 기지개, 마이크 노출, 승인 중지와 다섯 손가락 신고를 확인해야 한다.
