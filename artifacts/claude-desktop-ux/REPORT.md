실제 사용 모델: gpt-6-astra

RavenVault Desktop D1~D4 구현과 모의 검사를 완료했습니다. 작업 브랜치는 `claude/ravenvault-desktop-ux`이며 버전은 0.4.1 그대로입니다.

1. D1 — 폰 사용 안내 한 곳으로 정리

수정 파일: `index.html`, `src/main.ts`, `src/desktop-links.ts`, `src/desktop-copy.ts`, `scripts/check-desktop-integration.mjs`, `scripts/check-backup-ui.mjs`.

왼쪽 `rv-webwallet` 단추와 웹 지갑 홈 타일을 제거했습니다. 라비의 접힌 “폰에서 RavenVault 쓰기”에 웹앱 주소 QR, 브라우저 열기, 지갑별 잔액이 별개라는 설명을 모았습니다. 같은 컴퓨터 Chrome의 로컬 네트워크 접근 허용과 다른 기기에서 127.0.0.1을 사용할 수 없다는 설명을 넣었습니다. 없어진 단추의 리스너와 CSS를 제거하고, 옛 문구와 검사도 갱신했습니다.

기존 `server::qr_svg`로 생성한 QR을 브라우저에서 다시 해독해 `https://ravenvault.ex.erci.se/wallet/`와 일치함을 확인했습니다. 외부 브라우저 열기 호출도 같은 주소인지 모의 검사했습니다.

증거: [폰 안내 1120×780](phone-entry-ko-1120x780.png), [폰 안내 1440×900](phone-entry-ko-1440x900.png), [통합 검사](integration.log), [실제 생성한 QR](phone-url-qr.svg).

2. D2 — 읽기 전용 네트워크 상태

수정 파일: `src-tauri/src/companion.rs`, 새 `src-tauri/src/companion/network.rs`.

`GET /api/network`와 capabilities의 `network: true`를 추가했습니다. `getblockchaininfo`, `getpeerinfo`, `getmininginfo`만 조회합니다. 높이·헤더·최신 블록·동기화·진행률·해시레이트·내 노드 연결 분포·관측 시각을 반환하며, 못 읽은 선택 항목은 null입니다. 이웃 개별 주소는 응답에 넣지 않습니다.

실제 라우터에 모의 RPC를 주입해 허용 Origin의 CORS, 다른 Origin의 403 및 RPC 호출 없음, 미준비 노드의 JSON 오류/503/CORS, GET 전용/POST 405, OPTIONS의 사설망 허용 헤더를 검사했습니다. 혼잡 오류도 공통 CORS 처리를 거치도록 고쳤습니다. Rust 라우터가 만든 응답을 읽기 전용 웹 작업 폴더의 실제 `validateNetworkSnapshot`에 넣어 통과시켰습니다.

증거: [Rust 검사](cargo-companion.log), [실제 모의 라우터 응답](network-snapshot.json), [웹 파서와의 호환 검사](phone-transaction.log).

3. D3 — 폰의 서명 거래 받기와 확인 후 전파

수정 파일: `index.html`, `src/main.ts`, `src/desktop-copy.ts`, 새 `src/phone-transaction.ts`, `src/phone-transaction-qr.ts`, `src-tauri/src/companion/phone.rs`, `src-tauri/src/companion.rs`, `src-tauri/src/lib.rs`, 새 검사·합성 fixture 파일.

홈의 첫 타일에서 입력 화면을 엽니다. 단일 `ravenvault://transaction?v=1&hex=…` 또는 `playx://mesh` 분할 코드를 붙여넣을 수 있습니다. 분할 코드는 한 줄에 하나씩 입력하며, 순서가 바뀌어도 조립됩니다. 조각 헤더·전체 SHA-256 앞 8바이트·누락·충돌 중복을 검사합니다. 한 거래만 조립하고 최대 255조각, 입력 텍스트 600,000자, 조립 결과 200,100바이트, raw hex 200,000자(100KB)로 제한했습니다.

Rust에서 URL/QR 버전, 거래 버전 1·2, 정규 길이 인코딩, 입력·출력 수, 빈 서명, 중복 입력, 잘림·후행 바이트를 검사합니다. 노드의 메인넷 상태와 디코드 결과를 확인하고, 받는 주소는 Base58Check 및 0x3c/0x7a를 검사합니다. 거스름돈을 포함한 모든 출력의 주소·RVN·자산을 보여 주고, 자동으로 받는 사람과 거스름돈을 구분한다고 주장하지 않습니다. 자산 수량은 큰 값도 소수점 8자리를 문자열로 보존합니다. 미지원 스크립트의 자산·알 수 없는 주소·읽지 못한 수수료는 “확인 못 함”입니다. 수수료 조회는 최대 20개 입력/3초, 전체 검토는 18초로 제한합니다.

검토 경로는 조회 RPC만 사용합니다. 확인 단추에서만 별도의 native 명령이 `confirmed`와 검토 거래 ID를 받아, 기존 `/api/chain/send`와 공유하는 전파 함수를 호출합니다. 입력 수정·취소·늦게 도착한 검토 응답은 기존 확인 상태를 무효화합니다. 전파 중 중복 클릭도 막습니다. 이미 알려진 거래, 입력을 못 찾은 거래, 노드 거부, 전파 결과 불명확을 구분해 안내합니다.

웹 `phone/screens/resilience.test.ts`의 고정 합성 입력과 서명 생성식을 그대로 사용해 public raw hex fixture를 만들었습니다. 웹의 실제 거래 파서도 같은 fixture를 수락했습니다. 한 글자 비-hex 변경·거래 버전 변경·잘림·과대 입력·다른 네트워크 주소/노드를 거부하는 Rust 시험, 분할 페이로드 변조 거부 시험, 확인 전 전파 RPC 호출 0회 시험이 통과했습니다. 브라우저 시험도 실제 홈 타일과 확인 단추를 눌러 확인 전 0회, 확인 후 1회, 수정·지연 응답·중복 클릭 차단을 검증했습니다.

증거: [입력](transaction-input-ko-1120x780.png), [보내기 전 확인](transaction-review-ko-1120x780.png), [1440×900 확인](transaction-review-ko-1440x900.png), [거래 검사](phone-transaction.log), [화면 측정 및 호출 경계](ux-measurements.json).

4. D4 — 라비 전신 통일

수정 파일: `index.html`, `src/main.ts`, `src/desktop-copy.ts`.

사이드바와 라비 홈 모두 기존 `/raven-hello.webp` 전신/GPU 그림을 사용합니다. 사이드바 폭은 172px, 그림은 112px, 홈 그림은 184px입니다. 라비 소개는 내 노드 조회·폰 서명 거래 전파·질문/지시와 직접 켠 AI로 한정했습니다. 새 문구는 기존 한국어 원문 사전 방식으로 en/ja/zh를 추가했습니다.

1120×780 및 1440×900 × ko/en/ja/zh 총 8조합에서 사이드바 그림이 경계 안에 있고 가로 넘침 0, 브라우저 runtime error 0임을 확인했습니다. 스크린샷은 폰 안내·입력·검토·라비 홈 32장과 기존 백업 회귀 16장, 총 48장입니다.

증거: [라비 1120×780](ravi-ko-1120x780.png), [라비 1440×900](ravi-ko-1440x900.png), [영어 화면](ravi-en-1120x780.png), [실측 JSON](ux-measurements.json).

5. 실제 검사 명령과 결과

| 명령 | 종료코드 | 확인한 출력 |
|---|---:|---|
| `NODE_OPTIONS=--max-old-space-size=8192 npx tsc --noEmit -p tsconfig.json` | 0 | [오류 출력 없음](tsc.log) |
| `npm run build` | 0 | [preflight 통과, Vite build 완료](build.log) |
| `cargo check --tests --offline --manifest-path src-tauri/Cargo.toml` | 0 | [dev profile 완료](cargo-check.log) |
| `cargo test --offline --manifest-path src-tauri/Cargo.toml companion` | 0 | [18 passed, 0 failed, 419 filtered out](cargo-companion.log) |
| `node scripts/check-desktop-integration.mjs` | 0 | [주소·기존 동작·DESKTOP_COPY 69문구의 en/ja/zh 통과](integration.log) |
| `node scripts/check-desktop-mutation.mjs` | 1, 예상값 | [EXPECTED RED, 내부 Cargo 101](mutation.log) |
| `node scripts/check-backup-ui.mjs` | 0 | [네 언어 백업·복원 회귀 통과](backup-ui.log) |
| `node scripts/check-phone-transaction.mjs` | 0 | [분할 코드·웹 거래 파서·네트워크 응답 호환 통과](phone-transaction.log) |
| `node scripts/check-desktop-ux.mjs` | 0 | [8조합 화면·전파 경계·QR 해독 통과](desktop-ux.log) |

변이 시험은 이전 거래 해시 대조를 고의로 없애고 “A different transaction hash must not be accepted” 단정에서 실패해야 성공인 검사입니다. 실제로 그 단정에서 실패했고, 원본 복원 후 마지막 정상 Rust 시험 18개가 통과했습니다. [변이 원문 출력](native-mutant-red.txt)을 보존했습니다. Cargo 전체 시험은 돌리지 않았고 `companion` 필터만 실행했습니다. QR/네트워크 응답 저장을 위해 해당 실행에만 `RV_DESKTOP_UX_ARTIFACTS=/Users/gimmusong/wt-ravenvault-desktop-ux/artifacts/claude-desktop-ux`를 지정했습니다. 모든 명령의 종료코드·환경·로그 파일은 [check-results.json](check-results.json)에 있습니다.

빌드에는 500KB 초과 번들 경고가 남습니다. Cargo에는 기존 모듈의 unused/dead-code/중복 test 속성 경고가 남지만 오류는 없습니다. 원문 로그의 마지막 빈 줄도 보존했습니다.

6. 확인 못 함

- 실행 중인 `/Applications/PLAY X Raven.app`과 포트 8790은 사용하지 않았습니다. 실제 설치 앱의 WebView·운영체제 창 장식·실제 Chrome 권한 팝업은 확인 못 했습니다. 화면은 임시 포트의 정적 빌드와 격리된 headless Chrome, 전부 모의 native invoke로 검사했습니다.
- 실제 노드 거래 전파·발행·송금·블록 확정은 실행하지 않았습니다. 실제 지갑 파일·12단어·`.env*`를 읽거나 출력하지 않았습니다. 시험의 거래·주소·수량은 공개 합성 fixture입니다.
- 원시 거래에는 네트워크 식별자나 별도 전송 체크섬이 없습니다. 메인넷 여부는 노드와 주소로 제한합니다. raw hex의 임의의 유효한 한 글자 변경까지 파서만으로 모두 알아낼 수 있다는 의미는 아닙니다. 서명·합의 유효성의 최종 판단은 노드에 있으며 실제 노드로는 확인 못 했습니다. 분할 코드에는 전체 조각 해시 검사도 적용됩니다.
- 웹캠·QR 이미지 입력은 이번 구현에 포함하지 않았습니다. 단일/분할 코드의 텍스트 붙여넣기를 제공합니다. 미지원 스크립트 정보와 수수료 조회 실패는 확인 못 함으로 남깁니다.
- 기존 화면의 일부 한국어 미번역 문구는 남아 있습니다. 이번에 추가·변경한 폰 안내·거래 흐름·라비 역할 문구는 네 언어로 검사했습니다.

7. 로컬 커밋

구현·시험·로그·스크린샷 커밋: `988dadad8f3785a5d19ea30cb43dde8adbb1ebc5`.

이 보고서는 위 구현 커밋을 가리키는 후속 로컬 기록 커밋에 저장합니다. push·릴리스·버전 변경·GitHub Actions 실행은 하지 않았습니다. 읽기 전용 웹 작업 폴더와 금지된 작업 폴더에는 쓰지 않았습니다. 사용자가 제공한 untracked `handoff-claude-desktop-ux.md` 원본은 그대로 두었습니다.
