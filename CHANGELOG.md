# 변경 기록

## 0.8.6

### 한국어

- 라비 대화: 개인 정보 선택을 아직 저장하지 않았거나 「지금은 취소」를 눌러도 질문을 버리지 않고, 개인 정보 없이 답할 수 있는 범위(시세·노드 상태·화면 열기 등)로 바로 답합니다. AI 열쇠를 넣으면 기다리던 질문을 다시 보냅니다. AI가 하나만 연결돼 있으면 「두 곳에 묻기」 단추를 감춥니다.
- 라비는 송금을 대신하지 않습니다. 「돈 보내줘」에는 보내기 화면 안내(주소 확인·소액 먼저)를 보여 주고, 실제 송금은 언제나 사람이 확인 화면에서 확정합니다.
- 라비 감정 표현: 입금 확인·경고·밤·오래 쉼 같은 상황에 맞춰 라비의 표정과 짧은 말이 바뀝니다. 돈이 나간 일을 기뻐하지 않고, 돈·보안 경고에는 진지한 얼굴을 씁니다.
- 금액 입력 안전: 화면 언어의 소수점·천 단위 관례대로 읽고, 두 가지로 읽힐 수 있는 입력(예: 쉼표 소수 지역의 `1.234`)이나 다른 지역 형식은 추측하지 않고 다시 적어 달라고 합니다. 금액은 내부에서 정수 단위로 저장해 언어를 바꿔도 값이 바뀌지 않습니다.
- 끌어놓기 올리기(판매자 기능을 켠 경우): 파일·폴더를 끌어다 놓으면 종류·제목·표지·장르를 자동으로 채운 카드를 한 화면에서 미리 보고, 템플릿으로 꾸밀 수 있습니다. 기존 단계별 마법사는 「자세히」로 남습니다.
- 창 모드: 미니 창(작게·보통·크게)에 더해 아주 작은 칩, 창 없이 메뉴바만 쓰는 모드, 전체 화면 대기화면을 추가했습니다. 작은 모양은 모두 읽기 전용이고 금액 가리기가 기본으로 켜져 있습니다. 미니 창은 입금·노드 상태 변화를 알려 줍니다.
- 메모리 절감: 창이 숨겨져 있을 때 화면을 계속 다시 훑던 작업을 멈춰 숨긴 상태의 처리량을 크게 줄였고, 처음 불러오는 묶음을 가볍게 했습니다.
- 백업 폴더 이름을 `RavenVault-Backup`(파일 `RavenVault.zip.pxlock`)으로 바꿨습니다. 옛 `PLAYXRaven-Backup` 백업은 그대로 두고 「백업 찾기」에서 읽기 전용으로 찾고 열 수 있습니다. 바뀐 뒤 첫 자동 백업은 새 폴더에 한 벌을 새로 씁니다.
- 작은 라비 얼굴(16~32px)과 메뉴바 아이콘의 대비를 높여 작은 크기에서도 표정이 구별됩니다. 큰 얼굴은 그대로입니다.
- 준비 중(이번 판에서 켜지지 않음): 장터 판매와 메인넷 자산 발행은 스위치가 꺼진 채 출하합니다. 관련 화면은 안내·미리보기까지만 동작합니다.
- 업데이트 검증(서명된 버전·해시·순서 확인)은 그대로 유지합니다.
- 공개되지 않았던 0.8.5 의 변경(아래)도 함께 들어 있습니다.

### English

- Ravi chat no longer drops your question when privacy choices are unsaved or you tap "Not now"; it answers right away with tools that need no personal data, and re-sends the pending question once an AI key is added. "Ask both" is hidden when only one AI is connected.
- Ravi never sends money for you. "Send money" shows how to use the Send screen (check the address, try a small amount first); a person always confirms the transfer.
- Ravi emotions: Ravi's face and short lines now react to situations such as confirmed deposits, warnings, night time and long idle periods. Ravi no longer looks happy when money leaves, and uses a serious face for money and security warnings.
- Safer amount entry: amounts are read with the decimal and grouping rules of the display language; inputs that could mean two different values, or that use another region's format, are rejected instead of guessed. Amounts are stored as integers, so switching language never changes the value.
- Drag-and-drop listing (when seller features are enabled): drop files or a folder to get a one-screen preview card with kind, title, cover and genre filled in, and style it with templates. The step-by-step wizard remains under "Details".
- Window modes: in addition to the mini window (S/M/L), a tiny chip, a menu-bar-only mode and a full-screen standby display. All small modes are read-only and hide amounts by default. The mini window notifies you of deposits and node status changes.
- Lower memory use: work that kept rescanning the page while the window was hidden is stopped, and the startup bundle is smaller.
- Backups are now saved in a `RavenVault-Backup` folder (`RavenVault.zip.pxlock`). Old `PLAYXRaven-Backup` backups are left untouched and can still be found and opened read-only via "Find backups". The first automatic backup after the update writes a fresh copy to the new folder.
- Higher-contrast small Ravi faces (16–32 px) and menu bar icons. The large face is unchanged.
- Coming later (not enabled in this release): marketplace sales and mainnet asset issuance ship switched off; those screens only explain and preview.
- Signed update checks (version, hash and sequence) are unchanged.
- Also includes the 0.8.5 changes below (0.8.5 was not published).

## 0.8.5

빌드·서명까지 했으나 공개 저장소(dist)에는 올리지 않았습니다(2026-10-11 기준 공개 최신 = 0.8.4). 아래 내용은 0.8.6 에 포함됩니다.

- 게임 탭의 라비 스토리 카드 글자가 보이도록 고쳤습니다.
- 게임 판매 대금 받기는 설정의 「판매자 기능」을 켠 경우에만 나타납니다(기본 꺼짐).
- 어두운 화면의 단추 글자 대비를 높였습니다. 서명된 업데이트 버전·해시·순서 검증을 유지합니다.

## 0.8.4

- 게임 판매 대금 받기: 기존 데스크탑 지갑 비밀번호 재인증 후 판매 계정의 받기 전용 번호(xpub), 복사, QR, 처음 받는 주소 3개를 표시합니다.
- 폰·웹과 같은 판매 계정 `m/44'/175'/100'` 및 받기 경로 `/0/i`를 사용합니다. 폰 core 공개 파생 코드를 재사용하고 Rust 계정 파생과 교차 시험합니다.
- 1분 경과, 화면 이동, 창 포커스 이탈, 페이지 숨김, 명시적 지갑 잠금 시 번호와 조회 결과를 숨깁니다. 늦게 도착한 인증·조회 응답은 다시 표시하지 않습니다.
- 기본 주소 100개(0~99)의 확정 금액을 읽기 전용으로 조회하고, 폰·웹에서 내 지갑으로 옮기는 절차를 안내합니다. 미확정 금액과 범위 밖 주소는 포함하지 않습니다.
- 라비 스토리 입구 카드는 기본 브라우저로 공식 게임 URL을 엽니다.
- 기존 앱 식별자·업데이트 검증키·최소 버전·순서·패키지 해시 검증을 유지합니다. 0.8.4 이상 릴리스 메타데이터는 검증된 macOS 서명 명세가 없으면 생성하지 않습니다.

패키징·서명·공증·공개는 별도 릴리스 작업입니다. 검증 결과와 제한은 `docs/handoff/desktop-084-report.md`를 참고하세요.
