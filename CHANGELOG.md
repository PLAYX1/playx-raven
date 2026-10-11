# 변경 기록

## 0.8.7

### 한국어

- 지갑 파일 내보내기·가져오기(설정 → 백업): 저장할 폴더를 폴더 선택창에서 직접 고릅니다(iCloud 폴더·USB 등). 내보낸 파일(`.rvwallet`)은 항상 백업 열쇠(52글자)로 한 번 더 잠근 파일뿐이고, 잠그지 않은 파일은 만들지 않습니다. 지갑 암호가 없으면 막고 암호 설정을 안내하며, 만들기 전에 지갑 암호로 본인 확인을 합니다. 쓰기 전에 폴더·빈 공간·권한을 확인하고, 쓴 뒤에는 다시 읽어 열쇠로 풀어 원본과 같은지 확인합니다(다르면 파일을 지움). 끝에 파일 위치와 「백업 열쇠 52글자를 종이에 적었는지」 확인이 있어야 끝낼 수 있습니다.
- 가져오기: 52글자 열쇠 또는 백업 암호로 풀어 보고, 지금 지갑은 건드리지 않습니다. 확인한 뒤 전환하면 지금 지갑을 먼저 따로 보관(`wallet.dat.before-restore…`)한 다음 바꿉니다. 노드가 켜져 있으면 거절됩니다.
- 대기화면·잠긴 동안에는 지갑 파일 내보내기·가져오기·열쇠 인쇄가 앱 안쪽에서 거절됩니다(허용 목록에 넣지 않음).
- 백업 화면: 「컴퓨터가 죽으면, 이 52글자가 없으면 못 엽니다」 안내와 함께 열쇠 보기 → 종이에 적기·인쇄(인쇄용 파일은 앱 전용 폴더에 만들어 브라우저로 열고 10분 뒤 지움)·복사(30초 뒤 클립보드 지움) → 12단어와 같이 보관 확인 단계를 넣었습니다.
- 지갑 암호가 없으면 대기화면과 매장용 읽기 전용 모드를 켜지 않고 암호 설정을 안내합니다(암호 없는 지갑은 잠가도 누구나 풀 수 있기 때문).
- 정보 화면에 Ravencoin Core v4.8.0 의 MIT 라이선스 고지(저작권 문구 포함)를 넣었습니다.
- 안전: 실제 메인넷 자산 발행을 막는 스위치(`REAL_MAINNET_ISSUE_ENABLED`, 기본 꺼짐)를 모든 발행 명령(발행·재발행·고유·자격 증명·제한 자산·만들기 마법사) 앞에 넣었습니다. 메인넷이거나 어느 네트워크인지 모르면 노드에 보내기 전에 거절하고, 테스트넷·리그테스트(연습 모드)는 그대로 됩니다.
- 화면 언어 6개 추가: 이탈리아어·스페인어·프랑스어·포르투갈어(브라질)·독일어·러시아어(AI 번역). 설정과 머리 메뉴에서 직접 골라야 하며(컴퓨터 언어만 보고 저절로 고르지 않음), 고른 말의 사전만 읽습니다(`public/i18n/<말>.json`, 번들·CSS 늘지 않음). 번역은 AI 가 했고 일부는 다른 AI 의 역번역 검수를 거쳤습니다. 송금·복구 단어·보안·수수료·메인넷·법적 문구 중 검수 합의가 없는 것은 그 말에서 영어로 나옵니다. 「AI 번역입니다 · 오류 신고」 안내를 언어 선택 옆에 둡니다. 금액 표기는 쉼표 소수 언어에서 엄격하게 읽습니다.
- 업데이트 검증(서명된 버전·해시·순서 확인)은 그대로 유지합니다. 0.8.6 의 변경도 함께 들어 있습니다.

### English

- Wallet file export/import (Settings → Backup): you pick the folder yourself in the folder dialog (iCloud folder, USB, etc.). Exported files (`.rvwallet`) are always locked once more with the backup key (52 characters); an unlocked file is never created. It is refused when the wallet has no password (with guidance to set one) and asks for the wallet password to confirm it is you. Before writing it checks the folder, free space and permissions; after writing it reads the file back, unlocks it with the key and compares with the original (deleting the file if it differs). You can only finish after seeing the file location and confirming you wrote the 52-character key on paper.
- Import: tries the 52-character key or the backup password and does not touch your current wallet. After you confirm, your current wallet is set aside first (`wallet.dat.before-restore…`) and then replaced. It is refused while the node is running.
- While the wallet is locked (standby / store read-only), wallet file export/import and key printing are refused inside the app (not on the allowlist).
- Backup screen: "If the computer dies, you cannot open it without these 52 characters" with show key → write/print (the printable file is made in the app-private folder, opened in the browser and deleted after 10 minutes) / copy (clipboard cleared after 30 seconds) → confirm you keep it with your 12 words.
- Standby and store read-only mode are not turned on while the wallet has no password, and the app explains how to set one (a lock on a passwordless wallet can be opened by anyone).
- About: added the Ravencoin Core v4.8.0 MIT license notice, including its copyright lines.
- Safety: a switch (`REAL_MAINNET_ISSUE_ENABLED`, off by default) now guards every issuing command (issue, reissue, unique, qualifier, restricted, create wizard). On mainnet, or when the network cannot be determined, the request is refused before it reaches the node; testnet and regtest (practice mode) still work.
- Six new screen languages (AI translation): Italian, Spanish, French, Brazilian Portuguese, German and Russian. You must pick one yourself in Settings or the header menu (the computer's language never selects them), and only the chosen language's dictionary is read (`public/i18n/<lang>.json`; bundle and CSS do not grow). The translations were produced by AI and partly cross-checked by a second AI's back-translation. Wording about sending money, recovery words, security, fees, mainnet and legal notices that has not been double-checked stays in English in those languages. An "AI translation · Report an error" note sits next to the language choice. Amounts are read strictly in comma-decimal languages.
- Signed update version/hash/order verification is unchanged. Includes the 0.8.6 changes.

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
- 대기화면을 켜면 지갑이 바로 잠깁니다. 잠긴 동안 보내기·서명·복구 단어·백업 내보내기는 앱 안쪽에서 거절되고, 들어온 돈만 읽기 전용으로 보입니다. 대기화면을 끄면 잠긴 화면으로 돌아오며, 지갑 암호를 넣어야 다시 쓸 수 있습니다. 시간이 지나도 저절로 풀리지 않고, 앱을 다시 켜도 잠금이 유지됩니다.
- 매장용 읽기 전용 모드(설정 「표시 방식」): 켜면 지갑이 잠기고 잔액·최근 입금만 보입니다(금액 가림). 끌 때는 지갑 암호가 필요합니다.
- 어두운 화면에서 지갑 잔액·보내기 검토·복구 단어 창이 흰 카드로 뜨던 것을 어두운 카드로 바꿨습니다(글자 대비 4.5:1 이상). 보내기 검토에 「아직 보내지 않았어요」 상태 줄을 넣었습니다. 밝은 화면은 그대로입니다.
- 복구 단어 창: 보여 준 지 3분이 지나면 단어를 저절로 가리고(다시 보려면 지갑 암호), 단어를 고르거나 복사할 수 없게 했습니다. 화면 캡처 보호는 그대로 켜집니다.
- 미니 창: 끌어다 놓으면 화면 가장자리에 붙고(트레이 메뉴에서 끌 수 있음), 트레이 메뉴 「구석으로 보내기」로 네 구석에 바로 둘 수 있습니다. 「항상 위에」는 그대로 고를 수 있습니다.
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
- Starting the standby screen now locks the wallet immediately. While locked, sending, signing, recovery words and backup export are refused inside the app; only incoming money is shown, read-only. Leaving standby returns to the locked screen, and the wallet password is needed to use the wallet again. The lock never expires on a timer and stays on after restarting the app.
- Store read-only mode (Settings › Display): locks the wallet and shows only the balance and recent deposits (amounts hidden). Turning it off needs the wallet password.
- In the dark theme, the wallet balance, send review and recovery-word window no longer appear as white cards; they use dark cards with at least 4.5:1 text contrast. The send review shows a "Not sent yet" status line. The light theme is unchanged.
- Recovery-word window: words hide automatically 3 minutes after being shown (the wallet password is needed to see them again) and can't be selected or copied. Screen-capture protection stays on.
- Mini window: snaps to screen edges after dragging (can be turned off in the tray menu), and "Move to corner" in the tray menu places it in any of the four corners. "Keep on top" is still available.
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
