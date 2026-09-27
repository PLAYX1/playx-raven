# RavenVault Desktop 0.5.0 · 밤 까마귀 작업 보고

2026-09-28 · 브랜치 `claude/desktop-v2`

## 바꾼 것

- 판 번호와 자동 업데이트 릴리스 노트를 0.5.0으로 맞췄다. Vite 빌드는 공유 `node_modules`의 쓰기 불가 임시 폴더를 피하도록 `--configLoader runner`를 쓴다.
- IBM Plex Sans KR 네 굵기와 밝게/어둡게/시스템 설정, 밤 까마귀 색을 적용했다. 설정은 이 컴퓨터의 localStorage에 기억한다.
- `RaviFace.dc.html`의 420×420 눈 좌표, 색, 9가지 표정, 깜빡임과 동작 줄이기를 옮겼다. 캐릭터 여덟 가지는 그림 경로를 가진 목록이며 현재 색만 다르다. 키가 없으면 잠든다.
- 홈은 기존 노드·잔액 명령과 최근 거래·방 목록을 사용한다. 대화는 공개 방이라고 표시하고, 4단 배치, 이름 없는 사람의 짧은 표시 이름, 색 아바타, 묶인 말풍선, 전송 상태를 보여 준다. `talk_post`는 릴레이 OK를 받은 뒤 결과를 돌려주므로 그때만 `✓ 전달됨`을 쓴다.
- 라비 AI 화면에서 추천 질문, 지원 WebView에서만 음성 입력, RVN 보내기 요청 카드를 제공한다. 카드가 주소·금액·노드 수수료를 확인해도 실제 송금은 기존 지갑 검토와 암호 확정에서만 진행된다. 라비가 대신 누르지 않는다.
- 이름표는 공개 Nostr kind 0을 그대로 사용한다. 프로필의 색·라비 캐릭터 선택은 이 컴퓨터에만 저장한다.
- 맥·윈도 AI 키는 OS 보안 저장소로 저장한다. 옛 파일은 저장 후 같은 키를 다시 읽고 끝 4자리 파일을 기록한 경우에만 0으로 덮고 삭제한다. 저장소가 실패하면 옛 파일을 남겨 계속 읽는다. Linux는 기존 0600 파일을 쓴다. `api_key_status`는 전체 키를 반환하지 않는다.
- 첫 대화 후 또는 받기 주소를 보여 주기 전에 백업 안내를 한 번 띄운다. 복구 단어 자체는 화면·로그에 표시하지 않는다.

## 디자인에 있지만 뺀 것

- 데스크톱에는 공개 방만 있어서 1:1 비공개 대화, 확인된 친구 배지, 친구 간 RVN 보내기 단추를 추가하지 않았다. 친구 추가 단추는 기존 폰 연결로 안내한다.
- 입력 중 표시, 읽음 표시, 반응, 답장 인용, 일반 파일 첨부는 실제 지원이 확인되지 않아 만들지 않았다. 기존 사진 보내기는 유지했다.
- 프로필 사진을 확인된 친구에게만 보여 줄 수 없어 추가하지 않았다.
- 원화 환산, Touch ID 잠금 상태, 업데이트 준비됨 같은 목업의 예시 수치는 실제 값을 확인할 명령 없이 표시하지 않았다.
- NIP-17/44/59, 릴레이 주소, 이벤트 형식, 지갑 서명·전송 로직은 바꾸지 않았다.

## 시험

- `npm run build; echo rc=$?` → `rc=0`. preflight, TypeScript, Vite 통과.
- `cd src-tauri && RV_BACKUP_FIXTURE_ROOT=/tmp/claude-501/rvfix CARGO_TARGET_DIR=/Users/gimmusong/wt-rv-desktop-049-target cargo test --offline --lib ai::keyring_tests -- --ignored --test-threads=1` → `rc=0`, 모의 보안 저장소 저장·삭제·이전·끝 4자리·상태 키 비노출 확인.
- `cd src-tauri && RV_BACKUP_FIXTURE_ROOT=/tmp/claude-501/rvfix CARGO_TARGET_DIR=/Users/gimmusong/wt-rv-desktop-049-target cargo test --offline 2>&1 | tail -30` (`set -o pipefail` 적용) → `rc=101`: 614개 통과, 4개 실패. 실패한 4개(`ai_endpoint`, `peers`, `relay`, `server`)는 이 샌드박스에서 로컬 포트 바인딩이 막힌다. 실제 오류: `Os { code: 1, kind: PermissionDenied, message: "Operation not permitted" }`.
- `for f in scripts/check-*.mjs; do node "$f" >/tmp/o.txt 2>&1; echo "$f rc=$?"; done` 실행. `rc=0`: `check-backup-result`, `check-cert-roster`, `check-easy-create`, `check-issue-gate`, `check-peer-help`, `check-phone-transaction`. `rc=1`(의도): `check-desktop-mutation`. `rc=1`(환경 차단): `check-backup-safety`, `check-backup-ui`, `check-cert-photos`, `check-certificate-bulk-ui`, `check-certificate-preview`, `check-desktop-identity-fix`, `check-desktop-integration`, `check-desktop-languages`, `check-desktop-ux`, `check-restore-vectors`, `check-style-csp`, `check-wallet-easy`, `check-words-restore`. 브라우저 격리 프로필 또는 `127.0.0.1` 바인딩 차단이며, `check-backup-safety`는 외부 crates.io에 닿지 못했다. 생성된 `artifacts/`는 되돌렸다.
- 기존 시험 파일은 수정·삭제·건너뛰지 않았다.

## 남은 일과 확신 없는 곳

- 이 샌드박스에서 Chrome 새 탭과 localhost 화면 캡처를 열 수 없었다. 밝게·어둡게·라비 깨우기 및 4단 대화 배치를 실제 창에서 시각 검수해야 한다.
- 전체 화면 시험과 Rust 포트 시험을 localhost 바인딩 및 격리 브라우저가 가능한 환경에서 다시 돌려야 한다.
- OS 보안 저장소의 실제 권한창과 Windows 경로는 모의 시험만 확인했다. 맥·윈도 실기기에서 이전 키 실패 복구까지 검수해야 한다.
- 폰과 웹/PWA, 소개 웹 배포는 이 데스크톱 레인의 변경 범위 밖이다.

## 2차 · 데스크톱 v2 결함 수리 (2026-09-28)

실제 Chrome 캡처 `docs/rv-chat/shots-r1/desk-light-talk.png`, `desk-dark-talk.png`, `desk-light-home.png`, `desk-light-ravi.png`, `desk-wake-1.png`를 열어 비교했다.

### 바꾼 것

- 내 말풍선은 밝게 `#15161D`/흰 글자, 어둡게 `#E2702A`/먹색 글자로 대화창의 더 구체적인 CSS 선택자에 명시했다. 사진 풍선도 글자색을 이어받는다.
- 릴레이 응답 순서에 기대지 않고 `created_at` 오름차순으로 그린다. 처음 열면 아래로 내리고, 위를 읽는 동안 새 글이 오면 위치를 유지하며 「새 메시지 ↓」 단추를 보여 준다. 대화 소리를 꺼도 열린 방의 글은 갱신한다. `talk_read`의 null/빈 응답은 빈 대화 안내로 처리한다.
- 라비 화면은 얼굴·이름·키 상태, 기존 AI 대화, 추천 질문, 입력줄을 먼저 보여 준다. 가게 타일과 상태 카드는 아래 「라비에게 시킬 수 있는 일」에 접어 두어 기능을 유지했다. 음성 단추는 브라우저 SpeechRecognition 지원 시에만 나타나며, RVN 요청은 수수료 확인 카드에서 기존 보내기 확정 화면으로 이어진다.
- 키 입력·저장·삭제의 ID와 끝 4자리 표시를 연결했다. 저장 뒤 입력값을 비우고 `빠밤! → surprised → wake → happy → normal`을 약 2.75초에 보여 준다. 마지막 키를 지우면 sleep으로 돌아간다. 표정 요소에 `data-ravi-mood`를 넣었다.
- 모든 화면의 메뉴를 76px 아이콘 레일로 맞췄다. 좁은 아래쪽은 신고 아이콘과 상태 점으로 표시하고 툴팁·접근성 이름을 달았다. 서로 다른 기능이 같은 「내 소개」였던 아티스트 메뉴 이름을 「아티스트」로 고쳤다.
- 이야기 머리의 의미 없는 「이름 없음」을 숨기고, 오른쪽 방 정보의 아바타를 64px 색 원과 이름으로 맞췄다. 홈 최근 활동은 `recent_transactions`의 `category`, `amount`, `confirmations`, `time`을 사용해 최신순으로 표시한다. `talk_me`·`talk_profiles`·`talk_rooms`의 null도 안전하게 처리한다.
- 홈 카드의 28/32px 여백, 56px 잔액 글자, 52px 동작 단추, 활동 행과 320px 정보 칸 등 `v2-Desktop`·`v2-DesktopHome` 숫자를 다시 적용했다. 새 문구는 한국어·영어·일본어·중국어 간체에 넣었다.

### 디자인에 있지만 뺀 것

1차의 제외 항목을 그대로 유지했다. 입력 중·읽음·반응·인용·일반 파일 첨부는 실제 전송 기능이 없어 넣지 않았다. 공개 방을 비공개라고 표시하지 않았고, 라비가 송금을 직접 확정하지 않는다.

### 시험과 남은 일

- `npm run build; echo rc=$?` → `rc=1`. Vite 설정 임시 파일을 공유 `node_modules/.vite-temp`에 쓰려다 `EPERM: operation not permitted`.
- `node preflight.mjs && npx tsc && npx vite build --configLoader runner; echo rc=$?` → `rc=0`.
- `node scripts/check-style-csp.mjs; echo rc=$?` → `rc=1`, `listen EPERM: operation not permitted 127.0.0.1`.
- `node scripts/check-desktop-languages.mjs; echo rc=$?` → `rc=1`, `AssertionError: A new isolated browser profile is required`.
- `node scripts/check-desktop-ux.mjs; echo rc=$?` → `rc=1`, 같은 격리 프로필 오류.
- 기존 시험은 지우거나 건너뛰지 않았고, 디자인에 고정된 시험도 수정하지 않았다. 이번 환경에서는 새 Chrome 캡처를 만들 수 없어 라비 키 저장·삭제와 밝게/어둡게 레이아웃을 실제 창에서 다시 확인해야 한다. 프로토콜·암호·릴레이 주소·송금 확정 로직은 변경하지 않았다.

## 3차 · 라비 AI 키 보안 저장 수리 (2026-09-28)

### 바꾼 것

- 16자 미만 키 저장을 거절하고, 끝 4자리는 16자 이상인 키에만 표시한다. 기존 짧은 키의 `.last4` 값은 상태 조회에서 노출하지 않고 정리한다.
- `KEY_LOCK` 하나가 키 읽기·이전·저장·삭제·상태 조회와 custom 목적지 저장을 직렬화한다. 상태 조회는 이전을 수행하지 않으며, 이전은 앱 시작과 키 사용 직전에 수행한다.
- `KeyStore`로 저장소를 분리했다. 운영은 맥·윈도 OS 보안 저장소와 Linux 파일, 시험은 항상 메모리 저장소를 사용한다. 기본 설정 폴더의 기존 service 이름은 유지하고, 별도 설정 폴더는 경로 SHA-256 앞 8자리로 service를 분리한다.
- 이전은 `NoEntry`와 읽기 오류를 구분하고, 저장소에 키가 있어도 남은 옛 파일을 정리한다. 저장 때도 옛 `.key`를 지우며, 0 덮어쓰기가 실패해도 삭제를 시도한다. 삭제는 저장소·`.last4`·`.key`를 모두 시도하고 오류를 합친다. `.deleted` 표식이 남은 옛 키의 자동 이전을 막고 새 저장이 성공하면 제거한다.
- 상태를 `configured`, `has_key`, `available`, `last4`로 분리했다. 라비의 잠/깨움과 제공자 선택은 키가 있는 제공자 또는 키 없는 로컬 custom의 `available`을 사용한다. 저장 실패, 화면 이동, 카드 닫기에도 키 입력을 비우며 실패 시 재입력을 안내한다.
- 외부 제공자 오류와 응답 파싱 오류에 키 문자열, 앞 8자, 끝 8자를 `[키 가림]`으로 바꾸는 공통 함수를 적용했다.

### 시험

- `RV_BACKUP_FIXTURE_ROOT=/tmp/claude-501/rvfix CARGO_TARGET_DIR=/Users/gimmusong/wt-rv-desktop-049-target cargo test --offline ai::` → `rc=0`, 27개 통과·7개 기존 ignored.
- 기존 ignored 7개를 메모리 저장소로 단독 실행: `rc=0`, 7개 통과.
- `node preflight.mjs && npx tsc && npx vite build --configLoader runner`: `rc=0`.
- 메모리 저장소 시험에 짧은 키, 접미사, 이전 각 실패 단계, 삭제 부분 실패, 저장·이전 교차, 데이터 폴더 격리, 오류 문구 가림을 포함했다. OS 키체인을 사용하는 시험은 없다.

## 4차 · 데스크톱 작은 화면 결함 (2026-09-28)

### 확인하고 고친 것

- `docs/rv-chat/shots-r2/desk-light-ravi.png`, `desk-wake-4.png`, `desk-light-talk.png`, `desk-light-home.png`를 직접 확인했다. 라비 제공자 이름은 그리드의 좁은 칸에 눌려 세로로 쪼개졌고, 왼쪽 라비 선택 칸에는 얼굴이 보이지 않았다.
- 제공자 다섯 단추를 최소 글자 폭의 한 줄 칩으로 만들고, 좁아지면 다음 줄로 감기게 했다. 고른 제공자의 「어디서 받나요 ↗」는 칩 아래 한 줄 링크로 옮겼다. 선택을 바꾸면 링크의 공식 콘솔 주소와 입력칸 예시도 함께 바뀐다.
- 라비 머리의 중복 역할 문구를 한 줄로 줄였다. 왼쪽 메뉴의 라비 얼굴을 가리던 `span` 숨김 선택자를 고치고 현재 표정의 `RaviFace`를 24px로 표시한다. 나머지 메뉴의 SVG 24px와 선택 배경은 기존 캡처 및 `showPage` 선택 상태 코드로 확인했다.
- 대화 머리의 「초대하기」「더 보기」와 경고 띠의 「알겠습니다」를 40px 높이·14px 글자로 맞췄다. 공통 64px/16px 강제 규칙보다 구체적인 규칙을 써서 이 세 단추에만 적용한다.
- 맨 위 34px 띠는 `titleBarStyle: Overlay`와 `hiddenTitle: true`인 macOS 창의 드래그 영역(`data-tauri-drag-region`)이다. 일반 Chrome 캡처에는 신호등 단추가 없어 빈 띠로 보이지만 실제 앱의 제목줄 자리이므로 유지했다.

### 시험과 제한

- `node preflight.mjs && npx tsc && npx vite build --configLoader runner; echo rc=$?` → `rc=0`.
- 새 화면 캡처 시도는 이 환경의 `127.0.0.1` 바인딩 `EPERM`으로 실패했다. 서버 없이 Chrome을 띄우는 재시도도 브라우저 프로세스 실행 단계에서 실패했다. 따라서 이번 수정의 시각 검수는 기존 실제 Chrome 캡처와 CSS·DOM 경로 확인에 한정된다.
- `ai.rs` 키 저장 로직과 `package.json`은 변경하지 않았다. 새 `style` 속성은 추가하지 않았다.
