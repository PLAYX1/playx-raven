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
