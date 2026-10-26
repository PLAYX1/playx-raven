# 데스크톱 라비 대화 패널 수정

기준: `eb7cb42` (0.6.4), 대표의 `owner-desktop-064.png` 제보.

## 옛 그림이 나타난 원인 B

기준 커밋에서 `index.html:3695`의 `<span id="ravi-face" hidden>`를
`src/main.ts:17363`이 `raviFace("sleep", 184)`로 교체했다.
`src/ravi-face.ts:43`의 함수는 `span.ravi-face`에 184×184 크기를 주고,
`src/ravi-face.ts:50`에서 `/ravi/face.webp`를 넣는다. 살아 있는 SVG 리그와 별개인 옛 이미지다.

`index.html:2402`의 `.ravi-face { position:relative; display:inline-block; ... }`는
브라우저의 기본 `[hidden] { display:none }`보다 우선하는 작성자 CSS여서 숨김을 무효화했다.
`index.html:2403`은 그 안의 `img, svg`를 `position:absolute; left:0; top:0; width:100%; height:100%`로 쌓는다.
따라서 `hidden:true`여도 보라 배경의 옛 얼굴과 눈 SVG가 다시 나타난다.
홈으로 이동한 뒤에는 `#page-ravi`에만 있는 48px 크기 제한도 적용되지 않아 184px 크기로 보였다.
이 옛 얼굴은 fixed 패널이 아니며, 대화 주변에 남은 중복 hero 이미지였다.

옛 hero 자리·생성·이벤트 연결을 제거했다. 남아 있는 작은 얼굴의 `hidden`이 작성자 CSS로
무효화되지 않도록 `.ravi-face[hidden] { display:none !important }`도 적용했다.

## 바뀐 동작

- 대화 DOM은 body의 공통 패널 하나에만 붙인다. 페이지 이동·페이지 스크롤과 독립적이다.
- 홈은 큰 살아 있는 리그·인사·잔액·대화 열기 버튼으로 단순화한다. 헤더·홈·라비 메뉴·접힌 얼굴 버튼에서 같은 패널을 연다.
- 패널은 64px 살아 있는 리그·상태·크게/작게·접기 버튼, 남는 높이를 쓰는 기록, 한 줄 가로 스크롤 질문 칩, 읽기·마이크·고정 textarea로 구성한다.
- Enter는 보내기, Shift+Enter는 줄바꿈, IME 조합 중 Enter는 전송하지 않는다. 보내자마자 입력에 포커스를 유지하고, 늦은 답은 뒤 화면의 포커스를 가져오지 않는다.
- 맨 아래를 보고 있을 때만 새 답·내용 변경·크기 변경을 따라 내려간다. 위로 읽는 중에는 위치를 유지하고 `새 답 ↓` 칩을 표시한다.
- 열림·크기만 localStorage에 저장한다. 입력·대화·열쇠를 새로 저장하지 않는다. 저장소가 막히거나 값이 손상돼도 현재 세션은 동작한다.
- Esc로 접으며 포커스를 가두지 않는다. 패널에서 접으면 얼굴 버튼으로, 뒤 화면에서 접으면 기존 포커스를 유지한다.
- 승인·백업·신고·온보딩·QR·폰 거래 승인 화면에서는 리그·듣기·읽기를 멈추고 외부 승인 화면을 우선한다. 인라인 열쇠·보내기 요청 카드에서도 리그와 음성을 멈추고 Enter 전송을 막는다. 음성은 입력만 채운다.
- 보내기 요청 카드에는 닫기를 추가했고, 기존 보내기 검토 화면으로 이동하면 요청 카드를 숨긴다. 실제 확정·수수료 재계산은 기존 흐름을 유지한다.
- 도구·폰 거래·기존 메뉴·다섯 손가락 신고는 유지한다. ＋는 라비 도구 화면을 연다.
- 안내 말풍선·입금 알림·작업 알림은 패널 왼쪽 아래로 옮긴다. 패널은 헤더 아래 120px부터 시작하도록 높이를 제한한다.
- 새 문구는 `src/dict.ts`에 영어·일본어·중국어 번역을 추가했다.

## 검증 결과와 제한

통과:

- `npm run build` (preflight, TypeScript, Vite; 기존 큰 chunk 경고 있음)
- `node scripts/check-ravi-panel.mjs`: 실제 패널 코드의 자동 스크롤·새 답 칩·동적 내용·크기 변경·Enter/Shift+Enter/IME·즉시 입력 포커스·늦은 답의 포커스·Esc·열림/크기 복원·승인 일시 정지·저장소 오류. 실제 `chatSend`의 중복 요청·다음 입력 유지도 검사.
- `node scripts/check-ravi-state.mjs`: 리그·음성·세 리그의 승인 시 정지·배경 정지·오래된 음성 콜백 무효화·페이지를 넘는 패널·다섯 손가락 신고·입금 기쁨·27개 문구 번역.
- `node scripts/check-ai-safety.mjs`
- `node scripts/check-send-confirmation.mjs`
- `git diff --check`

`RV_BACKUP_FIXTURE_ROOT=/tmp/rv-test-fixture cargo test --lib`는 실제 실행됐다.
712 통과 / 6 실패 / 13 ignored. 실패한 6개는 모두 로컬 소켓을 여는 지점의
`Operation not permitted` 환경 제한이다 (`ai_endpoint`, `peers`, `relay`, `server` 2건, `upload`).
**cargo 미실행은 아니다.** Rust 코드는 변경하지 않았다.

`check-ravi-panel-browser.mjs`에 1280×720·1440×900·1920×1080 실제 브라우저
동작·입력/기록/헤더/토스트 기하 검사·합성 승인/음성 정지·상태 복원 검사를 추가했다.
이 환경에서는 로컬 서버 listen이 EPERM으로 막히고, 서버 없이 요청을 합성하는 방식도
Chrome 프로세스 실행 제한으로 막혔다. 연결된 Chrome에서 로컬 파일 미리보기를 여는
행동 역시 브라우저 보안 정책(허용 프로토콜 http/https)으로 거부됐다.
따라서 **실제 화면 크기별 겹침·스크린샷 검증은 미완료**이며 통과로 표시하지 않는다.
코드의 동작 검증은 합성 DOM으로 통과했으나, 실제 렌더링 검증과 같다고 볼 수 없다.

지갑 웹 번들은 변경하거나 다시 만들지 않았다. push·태그·배포는 하지 않았다.
기존 미추적 산출물·대표 스크린샷·합성 미리보기·지갑/열쇠 데이터는 커밋에 넣지 않는다.
Git worktree HEAD 쓰기가 막혀 임시 `GIT_INDEX_FILE`과 임시 Git 저장소를 이용한다.
전달 bundle의 ref는 `refs/heads/claude/desktop-ravi-chat`이고 기준 커밋 `eb7cb42`가 필요하다.
