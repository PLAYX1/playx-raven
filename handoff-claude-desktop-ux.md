# RavenVault Desktop — 중복 단추 정리 · 네트워크 상태 · 폰 서명 거래 받기 · 라비 (2026-09-14)

**이건 무인 실행이다. 계획만 세우고 끝내면 완전 실패로 간주한다. 파일을 실제로 고치고, 검사를 실제로 돌리고, 결과를 보고하라.**
사용 모델은 반드시 `gpt-6-astra`. 보고 첫 줄에 실제로 쓴 모델을 적어라.

## 작업 폴더 (여기서만)
- `~/wt-ravenvault-desktop-ux` (브랜치 `claude/ravenvault-desktop-ux`, 기준 `codex/ravenvault-desktop` 5da3cb6 = 공개된 0.4.1 소스 + 납품 기록).
- 새 웹앱 소스는 `~/wt-ravenvault-web-ux` 에 있다 — **읽기만**(다른 레인이 동시에 고치는 중).
- 🔴 `~/wt-ravenvault-desktop`, `~/wt-ravenvault-restore-safety`, `~/wt-ravenvault-backup-storage`, `~/build/playx-raven`, `~/wt-ravenvault-resilience`, `~/playx` 에 **쓰기 금지**.
- 커밋은 이 브랜치에 로컬로만. push·릴리스·버전 올리기·GitHub Actions 실행 **금지**. 릴리스는 Claude 가 판단한다.
- 🔴 실제 노드에 `sendrawtransaction`·`issue`·송금을 **절대 호출하지 마라.** 시험은 전부 모의(mock) 로. 실행 중인 `/Applications/PLAY X Raven.app` 과 포트 8790 을 건드리지 말 것(읽기 GET 만 허용).
- `.env*`·지갑 파일·12단어 읽기/출력 금지. pkill/sudo 금지.

## 제품 기준 (대표 확정)
- RavenVault = "모바일에서 오프라인으로도 빠르게 작동하는 최고의 레이븐코인 지갑". 돈 먼저, 증서 다음.
- 데스크톱의 역할: **폰을 돕는 쪽** — 내 노드로 조회하고, 폰이 서명한 거래를 네트워크에 내보내 준다. 열쇠는 폰에 남는다.
- 없는 기능을 있다고 쓰지 않는다. "확인 못 함"과 "가짜"를 섞지 않는다. 한국어 원문 + en/ja/zh (기존 `src/desktop-copy.ts`·`src/dict.ts` 방식).

## 해야 할 일 (방법은 스스로 판단, 완료 기준은 지켜라)

### D1. 「웹 지갑 · 파일」 단추가 세 군데 — 정리
- 실측: 왼쪽 메뉴 `index.html` 의 `<button id="rv-webwallet">웹 지갑 · 파일</button>`(메뉴 줄 사이에 테두리 상자로 튄다), 라비 홈 타일 「RavenVault 웹 지갑」(`src/main.ts` `raviTiles()`), 라비 화면 `<details class="rv-web-info">`. 셋 다 브라우저로 `https://ravenvault.ex.erci.se/wallet/` 을 연다.
- 문제: 데스크톱 지갑(노드 wallet.dat)과 웹 지갑(브라우저 12단어)이 한 프로그램에 나란히 보여 "내 돈이 어디 있지?" 혼란.
- 할 일: **왼쪽 메뉴 단추와 라비 타일을 뺀다.** 한 곳(「이 컴퓨터」 또는 라비 화면의 접힌 칸)만 남기고 이름을 **"폰에서 RavenVault 쓰기"** 로. 거기서: 웹앱 주소 QR(폰 카메라로 찍어 여는 용도 — 데스크톱에 이미 있는 QR 생성 코드를 재사용), 브라우저로 열기 단추, 그리고 정확한 연결 안내(같은 컴퓨터 크롬에서 `http://127.0.0.1:8790` 을 쓰면 「로컬 네트워크 접근」 허용이 필요, 다른 기기에서는 이 주소가 안 됨).
- 관련 CSS·리스너·`src/desktop-links.ts`·검사 스크립트(`scripts/check-desktop-integration.mjs` 등)가 옛 단추를 찾으면 함께 갱신. 사라진 id 를 참조하는 코드가 남아 런타임 오류가 나지 않게.

### D2. 컴패니언에 `/api/network` 가 없다
- 실측: 웹앱이 `GET /api/network` 를 부르는데 `src-tauri/src/companion.rs` 라우터(499줄 근처)에 없다 → CORS 헤더 없는 오류 → 웹 화면에 "Failed to fetch".
- 할 일: 읽기 전용 `GET /api/network` 추가. 응답 형식은 웹 쪽 `~/wt-ravenvault-web-ux/core/network/status.ts` 의 `validateNetworkSnapshot` 을 **읽고** 맞춘다. 노드 RPC 는 읽기 전용(getblockchaininfo/getnetworkinfo/getmininginfo 등)만. 노드가 준비 안 됐으면 기존 경로와 같은 방식의 JSON 오류 + **CORS 헤더 포함**. `/api/capabilities` 에 이 기능을 정확히 표시.
- 기존 라우터 시험(companion.rs 870줄 이후) 방식으로 Rust 시험 추가: 허용 origin 에 CORS 헤더, 다른 origin 403, 노드 미준비 시 오류 형식.

### D3. 폰에서 서명한 거래를 데스크톱이 못 받는다
- 실측: 웹앱은 오프라인 서명 거래를 `ravenvault://transaction?v=1&hex=…` QR 로 보여 준다(`~/wt-ravenvault-web-ux/core/wallet-offline/transaction-qr.ts` — 여러 장 조각 형식이 있으면 그것도). 데스크톱 소스에는 이 형식을 읽는 곳이 없다.
- 할 일: 데스크톱에 **"폰에서 서명한 거래 보내기"** 를 만든다. 받는 방법은 데스크톱 현실에 맞게 스스로 판단(웹캠 스캔, QR 이미지 붙여넣기/파일 열기, 텍스트 붙여넣기 — 적어도 붙여넣기는 반드시). 흐름:
  1. 입력 → 형식·버전·길이 검사(웹 쪽 파서와 같은 규칙, 크기 상한) → raw tx 파싱
  2. **보내기 전 확인 화면**: 받는 주소(메인넷 0x3c/0x7a 검사), RVN 금액, 자산 이름·수량(있으면), 가능하면 수수료. 모르는 칸은 "확인 못 함"으로. 이미 전파된 거래·잘못된 거래는 노드 응답을 사람 말로.
  3. 사용자가 확인 단추를 눌렀을 때만 노드에 전파. 데스크톱에 이미 있는 전파 경로(예: 컴패니언 `/api/chain/send` 가 쓰는 Rust 함수)를 재사용.
- 🔴 시험: 파서 단위 시험(웹 시험의 고정 hex 재사용, 한 글자 바꾼 것·다른 네트워크·너무 긴 것 거부), 확인 전에는 전파 함수가 **호출되지 않음**을 모의로 보증. 실제 노드 전파 절대 금지.

### D4. 라비가 약하다
- 실측: 사이드바 라비는 `.brandravi { width: 64px }` 로 창에서 엄지손톱만 하고, 라비 홈 머리 그림은 **얼굴만 잘린** 다른 그림이다. 랜딩·웹앱은 GPU 옆 전신 그림(`public/raven-hello.webp` 와 같은 그림)을 쓴다.
- 할 일: 데스크톱도 **같은 전신 그림**으로 통일하고, 라비 홈 머리에서 라비가 분명히 보이게 키운다(사이드바 172px 폭은 유지 — 넘치지 않게). 라비 역할 문장은 실제 기능만(물어보고 시키는 곳, AI 는 켤 때만).
- 1120×780 과 1440×900 에서 사이드바·라비 홈 스크린샷.

## 검사 (전부 실제로 돌리고 종료코드와 출력 둘 다 확인)
- `NODE_OPTIONS=--max-old-space-size=8192 npx tsc --noEmit -p tsconfig.json`, `npm run build`
- `cargo check --tests --offline --manifest-path src-tauri/Cargo.toml`, 추가·관련 Rust 시험 `cargo test --offline --manifest-path src-tauri/Cargo.toml companion` (이름 필터 사용, 전체 시험이 너무 길면 관련 모듈만 — 무엇을 돌렸는지 정확히 적기)
- `node scripts/check-desktop-integration.mjs`, `node scripts/check-desktop-mutation.mjs`, `node scripts/check-backup-ui.mjs` (합성 invoke 방식 참고해서 D1·D3·D4 화면 스크린샷도 이 방식으로)
- 스크린샷·로그는 `artifacts/claude-desktop-ux/` 에.

## 보고 (한국어, `artifacts/claude-desktop-ux/REPORT.md` 에도 저장)
1. 실제 사용 모델 한 줄
2. D1~D4 각각: 바꾼 파일 · 이유 · 빨강→초록 증거 또는 스크린샷 경로
3. 돌린 검사 명령과 결과
4. 확인 못 한 것은 따로 "확인 못 함"
5. 로컬 커밋 해시
