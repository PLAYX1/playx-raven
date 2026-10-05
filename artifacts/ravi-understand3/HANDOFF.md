# 라비 이해 3차 수리

기준 커밋: a4d5fd5069b9fe1a318ea75172965900d2219369
전달 ref: refs/heads/claude/ravi-understand3
전달 bundle: artifacts/ravi-understand3.bundle

## 구현

- 외부 모델·네트워크·추가 의존성 없이 TS로 문자 2/3-gram, NFD 한글 자모 2/3-gram, 짧은 영문 토큰(AI/QR/CSV 등) 벡터의 IDF 가중 코사인 유사도를 계산한다. 공백·조사·어미 정규화는 검색 특성에만 적용하며 송금 데이터는 고치지 않는다.
- 의도별 최고 예문 점수를 비교한다. 확정 문턱 0.68, 후보 문턱 0.15, 1·2위 차이 문턱 0.06. 낮거나 거절 예문이 우세하면 정직 거절과 대안, 중간 점수·작은 차이는 두 후보 버튼을 제시한다.
- 기존 명시 신호와 금액+보내기는 유지한다. 넓은 기존 규칙과 학습 표현이 충돌하면 확정하지 않고 확인한다. 정규식 의도 규칙은 새 상황별로 늘리지 않았다. 기존 금액+보내기의 단위에 `개`를 포함했다.
- raviCandidates/matchGuide와 도움말·홍보 판별이 같은 검색 모델을 쓴다. 후보에서 도움말·홍보도 선택 가능하며 기존 입력/번역 처리로 연결한다.
- 35개 의도, 624개 학습 표현, 의도별 최소 15개. 구어체·반말·질문·상황 설명 및 기존 UI의 실제 번역 표현을 포함한다. 언어 설정 안내는 기존 화면 상단 언어 선택기를 안내한다. 「일본어로」는 일본어 안내로 답한다.
- 120문항은 변경하지 않았다. 표와의 문자 정규화 및 조사·어미 정규화 후 중복도 0이다. 검수자가 알려준 실패 문장은 학습 표에 넣지 않았다.
- 실제 AI·송금·발행 실행은 시험에서 금지했고, 기존 비밀 입력의 기록 전 차단, 주소/금액 출처 검사, 최종 사용자 승인 검사는 유지했다. main.ts와 Rust 실행 코드는 수정하지 않았다.
- 대상은 컴퓨터 앱이다. 매출·세무 CSV·홍보가 실제 제공되므로 기존 해당 화면/도우미로 안내한다. 근거: main.ts의 loadSales, exportSales → ledger_export, openRaviPromo → createPromoCard. 지원하지 않는 기능에 다른 앱의 기능을 추측해 붙이지 않았다. 기존 거절 안내의 이야기/가게 등 대안은 그대로 유지한다.

## 교차 검증

학습 표만 의도별로 5겹 분할했다. 각 겹은 나머지 4겹으로 예문 벡터와 IDF를 다시 만들고 제외된 표현을 평가했다. 120문항 및 추가 40문항은 문턱 선정에 사용하지 않았다. 문턱 격자에서 확정 응답의 오매칭률 ≤2%를 만족하는 조합을 골랐다. 현재 수치는 cross-validation.json에 있다.

- 검색 단독: 원시 1위 정확도 56.73%; 확정 51/51 정답, 오매칭 0%; 후보 정답 포함 363/531. 거절 정답을 포함한 통과율 67.31%.
- 기존 규칙을 합친 실제 판별: 확정 365/368 정답, 오매칭률 3/368 = 0.815%; 후보 정답 포함 169/233; 거절 정답 11건. 후보를 포함한 통과율 545/624 = 87.34%.
- 따라서 교차 검증을 100%라고 주장하지 않는다. 새 표현에 대한 의미 이해에는 여전히 한계가 있다.

## 시험 결과

- npm run build: 통과.
- 실제 Vite JS 합계 증가: 22,263 bytes (30,000 bytes 이하). 동일 UTF-8/minify 조건의 안내 모듈 비교도 +21,902 bytes. 외부 의존성 추가 없음.
- 기존 120문항: 120/120, 확정·거절 102, 올바른 두 후보 18. 오매칭 0, 제목/본문/버튼 언어 누수 0.
- 추가 상황 40문항: 40/40, 확정·거절 21, 올바른 두 후보 19. 오매칭 0, 언어 누수 0. 이는 저장소에 새로 만든 회귀 시험이며 검수자의 비공개 40문항을 다시 시험한 결과는 아니다.
- 「엄마한테 10개 보내줘」는 실제 chatSend 앞단에서 송금 안내로 도달한다. 이 경로는 수신자 주소를 추정하거나 송금을 파싱·실행하지 않는다. 안내 버튼을 누른 다음 기존 사용자의 주소 입력/검토/승인 절차를 따른다.
- 기존 60문항과 보안·패널·홍보·상태 검사 통과. 새 계약에 따라 올바른 후보도 통과로 인정하도록 검사기를 수정했다. 의미가 불확실한 기존 「10 RVN에 대해 설명해줘」는 두 안내 후보를 보일 수 있다. 비밀 입력, 실행 제한, 출처·금액·승인 검사는 완화하지 않았다.
- scripts/check-ravi-*.mjs 11개 모두 실행. 비브라우저 8개 통과. 브라우저 3개는 Chrome 프로세스 실행 실패로 검증하지 못했다. 실패를 통과로 바꾸거나 건너뛰는 변경은 하지 않았다. checks.json 및 개별 로그 참조.

## Rust 검증 제한

요청된 명령 `RV_BACKUP_FIXTURE_ROOT=$HOME/rv-test-fixture cargo test --manifest-path src-tauri/Cargo.toml`을 실행했다. 이 세션의 쓰기 허용 경로에 해당 HOME 하위 폴더가 포함되지 않아 합성 시험 하위 폴더 생성이 PermissionDenied로 실패했다(cargo-requested.log).

쓰기 가능한 `/tmp/ravi3-rust-fixture`로 전체를 다시 실행한 결과 718 통과, 6 실패, 13 무시였다(cargo-writable-full.log). 실패 6개는 모두 로컬 포트 바인딩의 Operation not permitted다:

- ai_endpoint::tests::redirects_cannot_forward_a_question_to_another_destination
- peers::tests::폴더_주소도_파일처럼_살아_있다고_본다
- relay::tests::live_push_and_pairing_rooms_stay_off_disk
- server::bind_probe::binding_the_phone_port_is_fast
- server::wallet_usability_tests::actual_loopback_listener_supplies_peer_and_never_trusts_forwarding_headers
- upload::photo_security_tests::streaming_size_mime_and_magic_are_checked_without_length

환경에 막힌 위 6개만 명령행에서 제외해 나머지 검사를 다시 확인했다: 718 통과, 0 실패, 13 무시, 6 제외. main/doc-test도 완료했다(cargo-accessible.log). 저장소의 Rust 시험이나 보안 경로는 고치지 않았다. 전체 Rust 및 브라우저 검증은 모두 통과했다고 보고할 수 없다. 포트 바인딩·Chrome 실행과 지정 fixture 경로 쓰기가 가능한 환경에서 재실행이 필요하다.

## 전달

임시 GIT_INDEX_FILE로 선택한 변경만 commit-tree에 넣고 지정 ref를 생성한다. 작업 브랜치 HEAD와 원래 index는 움직이지 않는다. bundle은 기준 커밋을 전제로 한 증분 bundle이며 git bundle verify로 검사한다. push·태그 없음.
