# 변경 기록

## 0.9.5

### 한국어

- 라비가 답을 읽어 줄 때 이제 **라비 목소리**(Supertonic 3, 한국어 여성 목소리)를 씁니다. 이 컴퓨터 안에서 만들며 인터넷으로 보내지 않습니다. 목소리 파일이 없거나 깨졌거나, 만드는 데 너무 오래 걸리거나, 만들기에 실패하면 자동으로 기존 기기 목소리로 읽어서 라비는 늘 말할 수 있습니다.
- 설정 「라비와 AI」에 「라비 목소리: 라비 목소리(기본) / 기기 목소리」 선택을 더했습니다. 기존 「답 읽어 주기」 켜짐·꺼짐은 그대로입니다.
- 라비 목소리로 읽는 동안과 그 답 말풍선 옆에 「AI 음성」 표시가 늘 보입니다(기계가 만든 음성임을 밝히는 목소리 라이선스 OpenRAIL-M 의 요구).
- 「정보와 개발비」의 오픈소스 고지에 Supertonic 3 (OpenRAIL-M)·onnxruntime-web 출처와 라이선스 원문을 더했습니다.
- 라비 목소리는 처음에 동의하면 한 번 내려받습니다(약 380MB). 설치 파일에는 들어 있지 않습니다(설치 파일 크기는 0.9.4 와 거의 같습니다). 설정 「라비와 AI」의 「라비 목소리 받기」(또는 라비 창 옆 안내)에서 「받기」를 누르면 앱 자료 폴더에 받고, 크기와 sha256 이 맞을 때만 씁니다. 받기 전·실패·지운 뒤에는 기기 목소리로 말하며, 언제든 「지우기」로 지울 수 있습니다. 새로 허용한 인터넷 주소는 huggingface.co(라비 목소리 받기 전용) 하나뿐입니다. 처음 읽어 줄 때만 모델을 메모리에 올리고(수 초), 5분 동안 말이 없으면 다시 내려놓습니다.

### English

- When Ravi reads replies aloud she now uses the **Ravi voice** (Supertonic 3, Korean female voice), generated on this computer and never sent over the internet. If the voice files are missing or damaged, synthesis is too slow, or it fails, the app automatically falls back to the existing device voice, so Ravi can always speak.
- Adds "Ravi's voice: Ravi's voice (default) / Device voice" to Settings > Ravi and AI. The existing "Read replies aloud" on/off is unchanged.
- An "AI voice" label is always shown while the Ravi voice is speaking and next to that reply bubble (the voice license, OpenRAIL-M, requires disclosing machine-generated speech).
- Adds Supertonic 3 (OpenRAIL-M) and onnxruntime-web credits plus the full license text to the open-source notice in "About and developer fee".
- The Ravi voice is downloaded once, with your consent (about 380 MB). It is not inside the installer (installer size stays about the same as 0.9.4). Press "Download" under Settings > Ravi and AI > "Get Ravi's voice" (or in the notice next to Ravi's window); the files go to the app data folder and are used only after their size and sha256 match. Before the download, after a failure, or after deleting them, the device voice is used; "Delete" removes them any time. The only newly allowed internet address is huggingface.co, used solely for this voice download. The model is loaded into memory only when Ravi first reads aloud (a few seconds) and released after 5 idle minutes.

## 0.9.4

### 한국어

- 새 윈도우 PC 에서 「RVN 서버」가 켜지지 않던 문제를 고칩니다. 노드 데이터 폴더(%APPDATA%\Raven)가 없으면 코어가 멈췄는데, 이제 켜기 전에 앱이 폴더를 만듭니다(있으면 그대로 둡니다).
- 앱 자료 폴더 이름을 PlayXRaven 에서 RavenVault 로 바꿉니다. 옛 폴더만 있으면 이름만 바꾸고(복사·삭제 없음), 둘 다 자료가 있으면 합치지 않고 RavenVault 를 쓰며 안내합니다. 바꿀 수 없으면 옛 폴더를 그대로 씁니다.
- 「문제 알리기」에 「노드 기록도 같이 보내기」를 더합니다(기본 꺼짐). 보내기 전에 가려진 내용을 미리 볼 수 있고, 컴퓨터 사용자 이름·IP·지갑 주소·열쇠처럼 보이는 줄은 가려서 마지막 약 100줄만 갑니다. 서버가 60초 넘게 안 켜지면 「기록과 함께 알리기」 단추가 나옵니다.
- 홈 화면을 단순하게 정리했습니다(큰 잔액, 받기·보내기 큰 단추, 안전 띠는 필요할 때만).
- 켜기 전에 데이터 폴더가 있는 드라이브의 남은 공간을 확인해, 약 40GB 보다 적으면 「남은 공간이 부족합니다(현재 ○○GB, 필요 약 40GB)」를 보여 줍니다. 막지는 않고 그래도 켤지 묻습니다. 공간을 못 재면 아무 말 없이 켭니다.
- 「메모리 넉넉히 주기」가 컴퓨터 전체가 아니라 지금 비어 있는 메모리를 읽어 정합니다(빈 메모리의 약 1/4, 최소 450MB·최대 4096MB). 실제로 적용한 값을 화면에 그대로 적습니다. 못 읽으면 예전 셈을 씁니다.
- 「한 번에 준비하기」에서 「백신에서 빼기」가 늘 「결과를 못 읽었습니다」로 나오던 문제를 고칩니다(윈도우가 결과 파일 맨 앞에 붙이는 눈에 안 보이는 표시 때문이었습니다). 그래도 자동으로 안 되면 Windows 보안에서 직접 폴더를 제외하는 방법을 화면에 보여 줍니다.
- 「진행이 멈춰 있습니다」 카드에 「기록과 함께 알리기」 단추를 더합니다.

### English

- Fixes the node failing to start on a fresh Windows PC: the core stopped when the data folder (%APPDATA%\Raven) did not exist; the app now creates it before starting (an existing folder is left untouched).
- Renames the app data folder from PlayXRaven to RavenVault. If only the old folder exists it is renamed (no copy, no delete); if both hold data they are not merged, RavenVault is used and a notice is shown. If the rename is not possible, the old folder keeps being used.
- Adds "Also send node log" to Report a problem (off by default). You can preview what will be sent; user names, IPs, wallet addresses and key-like lines are masked and only the last ~100 lines are sent. A "Report with log" button appears when the node does not start within 60 seconds.
- Simplifies the home screen (large balance, large receive/send buttons, safety bar only when needed).
- Before starting, checks free space on the drive holding the data folder; below about 40 GB it shows "Not enough free space (now XX GB, about 40 GB needed)". It does not block: it asks whether to start anyway, and stays silent if the space cannot be measured.
- "Give memory generously" now reads the currently free memory instead of total memory (about 1/4 of free, min 450 MB, max 4096 MB) and shows the value actually applied. If free memory cannot be read, the old calculation is used.
- Fixes "Exclude from antivirus" in "Prepare in one go" always showing "could not read the result" (an invisible marker Windows puts at the start of the result file). If it still cannot be done automatically, the screen explains how to exclude the folder by hand in Windows Security.
- Adds a "Report with log" button to the "Progress has stalled" card.

## 0.9.3

### 한국어

- AI 열쇠 넣기에 Meta AI 를 더합니다(주소 api.meta.ai/v1, 기본 모델 muse-spark-1.3). 설정의 AI 열쇠 칸에 「Meta AI」가 생기고, 모델 이름은 다른 회사처럼 직접 바꿀 수 있습니다. 열쇠 받는 곳 안내(dev.meta.ai)도 열립니다.
- 새로 허용한 인터넷 주소는 Meta AI 하나뿐입니다. 그 밖의 연결 범위·판매·메인넷 동작은 0.9.2 와 같습니다.
- 자동 업데이트 대상은 맥(Apple Silicon·Intel)입니다. 0.9.2 의 변경도 함께 들어 있습니다.

### English

- Adds Meta AI as an AI-key provider (endpoint api.meta.ai/v1, default model muse-spark-1.3). A "Meta AI" row appears in the AI key settings; the model name can be overridden like any other provider, and the key-help link (dev.meta.ai) opens.
- Meta AI is the only newly allowed internet address. Everything else (other connections, sales, mainnet behaviour) is the same as 0.9.2.
- Automatic updates cover macOS (Apple Silicon and Intel). Includes the 0.9.2 changes.

## 0.9.2

### 한국어

- 「폰 연결」을 더합니다(기본 꺼짐). 같은 집 안 와이파이에서 내 폰을 이 데스크탑에 연결해 가게 정보를 주고받는 기능입니다. 기기 연결 화면의 「폰 연결」 카드에서 새 기기 연결 요청을 보고 허락할 수 있고, 꺼져 있으면 꺼져 있다고 그대로 보여 줍니다. 바깥 인터넷(터널)으로는 열리지 않습니다.
- 폰 연결 보안을 강화했습니다: 요청마다 기기 개인키 서명을 확인하고, 기기마다 증서를 발급해 서명·만료·철회·권한을 확인합니다. 기기를 끊으면 데이터 열쇠를 새로 바꾸고 그 기기를 철회 목록에 올리는 일을 한 번의 확인으로 함께 합니다. 옛 방식 요청은 거절합니다. 철회 목록은 서명을 확인하고, 되돌리거나 오래된 목록은 받지 않습니다.
- 메인넷(진짜 레이븐 체인) 자산 발행·판매 스위치가 켜진 상태로 들어 있습니다. 자산 발행에는 되돌릴 수 없는 500 RVN 보증 소각이 따릅니다. 한 번 태운 RVN 은 돌려받을 수 없으니, 화면에 뜬 이름과 금액을 꼭 확인하고 진행하세요.
- 맥 빌드 스크립트(build-app.sh)가 옛 앱 이름 때문에 빌드 뒤 서명 단계에서 실패하던 것을 고쳤습니다(앱 동작은 바뀌지 않음).
- 자동 업데이트 대상은 맥(Apple Silicon·Intel)입니다. 업데이트 검증(서명된 버전·해시·순서 확인)은 그대로 유지합니다. 0.9.1 의 변경도 함께 들어 있습니다.

### English

- Adds "Phone pairing" (off by default): connect your phone to this desktop over the same home Wi-Fi to exchange store data. The device-connection screen has a "Phone pairing" card where you can see and approve new device requests; when it is off, it says so. It is never opened through the internet tunnel.
- Hardens phone pairing: every request is signed with the device's private key, each device gets a certificate whose signature, expiry, revocation and permissions are checked. Disconnecting a device rotates the data key and revokes that device in one confirmed step. Old-protocol requests are refused. The revocation list is signature-checked, and rollbacks or stale lists are rejected.
- The mainnet (real Ravencoin chain) asset issue/sale switch ships turned on. Issuing an asset comes with an irreversible 500 RVN burn as a deposit. Burned RVN cannot be recovered, so check the name and amount shown on screen before you continue.
- Fixes the macOS build script (build-app.sh), whose signing step failed after the build because of an old app name (no change to app behaviour).
- Automatic updates cover macOS (Apple Silicon and Intel). Signed update version/hash/order verification is unchanged. Includes the 0.9.1 changes.

## 0.9.1

### 한국어

- 인텔 맥(x86_64) 설치 파일을 추가합니다. Apple Silicon 판과 같은 0.9.1 코드로 만듭니다.
- 윈도우·리눅스 지원 준비로 고친 것(맥 동작은 바뀌지 않음):
  - 윈도우: 가게 시간대가 늘 UTC 로 잡히던 것을 고쳐 윈도우 시간대 설정(서머타임 포함)을 읽습니다.
  - 윈도우: 메모리·디스크 조회, 기기 ID, 채굴기 찾기, 터널을 부를 때 검은 콘솔 창이 깜빡이지 않게 했습니다.
  - 윈도우: 노드를 끌 때 먼저 정상 종료(RPC stop)를 요청하고 최대 20초 기다린 뒤에만 강제로 끝냅니다.
  - 윈도우: 폰 연결에 쓰는 집 안 주소를 ipconfig 에서 모두 읽습니다.
  - 리눅스: deb·AppImage 에 같이 넣은 노드·파일창고(`usr/lib/RavenVault Desktop/vendor/`)를 찾습니다.
- 자동 업데이트 대상은 맥(Apple Silicon·Intel)입니다. 업데이트 검증(서명된 버전·해시·순서 확인)은 그대로 유지합니다. 0.9.0 의 변경도 함께 들어 있습니다.

### English

- Adds an Intel Mac (x86_64) installer, built from the same 0.9.1 code as the Apple Silicon version.
- Fixes made while preparing Windows and Linux support (macOS behaviour is unchanged):
  - Windows: the shop time zone was always UTC; it now reads the Windows time zone setting (including daylight saving time).
  - Windows: no black console window flashes when checking memory/disk, reading the device ID, finding the miner or starting the tunnel.
  - Windows: stopping the node first asks it to shut down cleanly (RPC stop) and waits up to 20 seconds before forcing it to end.
  - Windows: all home network addresses used for phone pairing are read from ipconfig.
  - Linux: finds the bundled node and file store inside deb and AppImage packages (`usr/lib/RavenVault Desktop/vendor/`).
- Automatic updates cover macOS (Apple Silicon and Intel). Signed update version/hash/order verification is unchanged. Includes the 0.9.0 changes.

## 0.9.0

### 한국어

- 설정 화면 개편: 왼쪽 목록(설정 찾기 · 쉬운 설정 · 주제 8개)에서 주제를 고르면 오른쪽에 그 주제 하나만 보입니다. 찾기는 주제 이름과 안의 글자를 찾고, ↑↓ 키로 주제를 옮길 수 있습니다. 좁은 창에서는 목록이 위로 갑니다.
- 이야기: 처음 들어오면 「이름을 정해 주세요」 카드가 나옵니다(「나중에 할게요」를 누르면 다시 뜨지 않음). 내 글에도 이름과 라비 아이콘이 붙습니다. 「내 색」 설정은 없앴습니다.
- 이야기 방: 내가 만든 방에서만 「방 설정」으로 방 이름(40자)·설명(80자)을 고칠 수 있습니다(방을 만든 열쇠로 서명, 공개 릴레이 몇 곳이 받았는지 표시). 남이 보낸 이름 변경은 무시합니다. 「이 방 숨기기」로 방을 목록에서 숨기고 「숨긴 방」에서 되돌릴 수 있습니다. 공개 릴레이에 올라간 방은 완전히 지울 수 없어 「지우기」는 두지 않았습니다.
- 백업: 이름을 「wallet.dat 백업 파일 내보내기(잠금)」·「wallet.dat 백업 파일 가져오기」로 정리하고, 레이븐볼트용(.rvwallet, 52글자 열쇠로 한 번 더 잠금)과 레이븐 코어용(코어용 wallet.dat)을 구분표로 보여 줍니다.
- 끌어다 놓아 복원: `.rvwallet`(wallet.dat만) 또는 `.pxlock`(가게 전체 백업)을 창에 끌어다 놓으면 먼저 무엇을 되살리는지 보여 주고, 열쇠·백업 암호와 지갑 암호 확인, 열어 보기, 확인 체크를 거친 뒤에만 기존 복원 기능으로 되살립니다. 노드가 켜져 있으면 아무것도 바꾸지 않습니다. 지금 것은 지우지 않고 따로 보관합니다.
- 레이븐 코어로 옮기기: 「코어용 wallet.dat」을 고른 폴더에 새 파일로 꺼냅니다(52글자 잠금 없음, 지갑 암호로만 보호). 지갑 암호가 있어야만 되고, 지갑 암호를 한 번 더 확인하며, 노드가 만든 사본을 다시 읽어 대조합니다. 함께 든 레이븐 코어(4.8.0)가 만든 이 파일이 같은 코어에서 열리는 것은 시험으로 확인했습니다. 쓰려면 지갑 암호가 필요하고 잔액은 블록체인 동기화 뒤에 보입니다. 다른 버전의 코어에서는 확인하지 않았습니다.
- 가게: 새 가게의 공개 이름은 `RV.S.<가게이름>` 으로 만들어집니다. 옛 `SHOP.*` 가게는 그대로 읽고 씁니다. 가게 토큰 수량·보내기가 고정 `SHOP.PLAYX` 대신 이 가게의 토큰 이름을 씁니다.
- 12단어로 되살리기: 추가 암호에 `#` 이나 앞뒤 빈칸이 있을 때의 안내를 확인되지 않은 「레이븐 코어에서 되살리기」 대신 다른 백업으로 되살리라는 안내로 바꿨습니다.
- 업데이트 검증(서명된 버전·해시·순서 확인)은 그대로 유지합니다. 0.8.5~0.8.8 의 변경도 함께 들어 있습니다.

### English

- Settings redesign: pick a topic in the list on the left (search settings · easy settings · 8 topics) and only that topic is shown on the right. Search matches topic names and the text inside; ↑↓ keys move between topics. In a narrow window the list moves to the top.
- Chat: the first visit shows a "Choose your name" card ("Later" does not show it again). Your own messages now carry your name and Ravi icon too. The "My colour" setting was removed.
- Chat rooms: only in rooms you created, "Room settings" lets you edit the room name (40 characters) and description (80 characters), signed with the key that created the room, showing how many public relays accepted it. Name changes from anyone else are ignored. "Hide this room" hides a room from the list and "Hidden rooms" brings it back. There is no "Delete", because rooms on public relays cannot be fully removed.
- Backup: renamed to "Export wallet.dat backup file (locked)" / "Import wallet.dat backup file", with a table that separates the RavenVault file (.rvwallet, locked once more with the 52-character key) from the Raven Core file (wallet.dat for Raven Core).
- Drag-and-drop restore: drop a `.rvwallet` (wallet.dat only) or `.pxlock` (full shop backup) onto the window. It first shows what would be restored, then asks for the key or backup password and the wallet password, opens it to check, and restores with the existing restore functions only after you tick the confirmation. Nothing changes while the node is running. What you have now is set aside, not deleted.
- Move to Raven Core: saves a "wallet.dat for Raven Core" as a new file in a folder you choose (no 52-character lock; protected only by the wallet password). It requires a wallet password, asks for it once more, and reads the node's copy back to compare. We tested that this file, made by the bundled Raven Core (4.8.0), opens in that same Core. Using it needs the wallet password, and the balance appears after the blockchain has synced. Other Core versions were not tested.
- Shop: new shops get the public name `RV.S.<shop name>`. Older `SHOP.*` shops keep working. Shop token amounts and sending use this shop's token name instead of a fixed `SHOP.PLAYX`.
- Restore from 12 words: when the extra passphrase contains `#` or leading/trailing spaces, the message now points to another backup instead of the unverified "restore in Raven Core".
- Signed update version/hash/order verification is unchanged. Includes the 0.8.5–0.8.8 changes.

## 0.8.8

### 한국어

- 라비 대화: 「몇 살이야」「생일이 언제야」 같은 라비 자신에 대한 질문은 이 컴퓨터 안에서 바로 답합니다(나이는 오늘 날짜로 계산). 위로·응원·피곤·외로움·불안·화·기쁨 같은 감정 표현에도 답하고, 위기 표현에는 항상 전문기관 안내를 먼저 보여 줍니다. 내 정보가 필요 없는 일반 질문에는 정보 선택(동의) 카드를 띄우지 않습니다. 시작 인사 문구도 고른 화면 언어로 나옵니다.
- 체인 정보(읽기 전용): 내 노드 높이·해시율·난이도·대기 거래·연결 수와 51% 공격 비용 기준 보안 순위를 보여 줍니다. 오래된 정보는 표시가 바뀌고, 못 읽으면 「정보 없음」, 따라잡는 중에는 해시율을 숨깁니다. 투자 조언이 아닙니다. 라비도 이 두 가지를 읽기만 할 수 있습니다(보내기·바꾸기 없음).
- 자산 파일(IPFS) 보관: 자산 화면에서 한 번 탭하면 보관, 길게 누르면 해제(5초 안에 되돌리기 가능)합니다. 자동 보관은 「보관 안 하기」와 아직 정하지 않은 받은 자산을 건너뜁니다. 0.8.7 에서 이미 보관 중이던 것은 그대로 「보관하기」로 옮겨 적습니다. 앱 안 「진짜인지 확인」은 체인의 자산 정보·주인·보유 주소·끌어놓은 파일을 대조하고, 노드가 따라잡는 중이면 「확인 못 함」으로 표시합니다.
- 이야기 방 초대 링크가 옛 웹 지갑(rvn.ex.erci.se) 대신 새 지갑(`https://ravenvault.ex.erci.se/wallet/?room=…`)을 엽니다.
- 업데이트 단추: 새 버전이 없을 때 「확인 중…」으로 남던 것을 고쳐 「지금이 최신입니다.」로 바뀝니다. 확인에 실패하면 단추를 숨깁니다.
- 업데이트 검증(서명된 버전·해시·순서 확인)은 그대로 유지합니다.

### English

- Ravi chat: questions about Ravi itself ("How old are you?", "When is your birthday?") are answered locally on this computer (age is computed from today's date). Ravi also replies to feelings such as comfort, encouragement, tiredness, loneliness, worry, anger and joy, and crisis wording always shows professional help first. General questions that need none of your information no longer show the information-choice (consent) card. The startup greeting now follows the chosen screen language.
- Chain info (read-only): your node's height, hash rate, difficulty, pending transactions and connections, plus a security rank based on the cost of a 51% attack. Stale data is marked, unreadable data shows "no data", and the hash rate is hidden while the node is catching up. Not investment advice. Ravi can read these two as well (nothing is sent or changed).
- Asset file (IPFS) keeping: tap once on the Assets screen to keep a file, long-press to release it (undo within 5 seconds). Automatic keeping skips assets marked "Don't keep" and received assets you have not decided on yet. Files already kept in 0.8.7 are recorded as "Keep". The in-app "Check it's genuine" compares the chain's asset data, owner, holding addresses and a dropped file, and shows "Could not check" while the node is catching up.
- Chat room invite links now open the new wallet (`https://ravenvault.ex.erci.se/wallet/?room=…`) instead of the old web wallet (rvn.ex.erci.se).
- Update button: it no longer stays on "Checking…" when there is no new version; it now says "You are up to date." and is hidden if the check fails.
- Signed update version/hash/order verification is unchanged.

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
