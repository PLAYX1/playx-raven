# RavenVault Desktop — 이름 통일 · 한눈에 보기 · 언어 설정 (2026-09-14)

**이건 무인 실행이다. 계획만 세우고 끝내면 완전 실패로 간주한다. 파일을 실제로 고치고, 검사를 실제로 돌리고, 결과를 보고하라.**
사용 모델은 반드시 `gpt-6-astra`. 보고 첫 줄에 실제로 쓴 모델을 적어라.

## 대표 요청 (원문)
> "접속하면 플레이엑스가 아니라 RavenVault Desktop 이라고 나와야 하는거 아닌가? RavenVault App 처럼 한눈에 보기 쉽게 언어도 설정 가능하고 그래야 하지 않나?"

## 작업 폴더 (여기서만)
- `~/wt-ravenvault-desktop-ux` (브랜치 `claude/ravenvault-desktop-ux`, HEAD = 공개된 0.4.2 = origin/main `eb9ce8e`).
- 참고용 새 웹앱(RavenVault App) 소스: `~/wt-ravenvault-web-ux` — **읽기만**. 특히 `phone/web/WalletAccess.tsx`, `phone/ui/MainNavigation.tsx`, `phone/ui/tokens.ts`, `phone/ui/language*`, 공개 화면 `https://ravenvault.ex.erci.se/wallet/`.
- 🔴 다른 워크트리(`~/wt-ravenvault-desktop`, `~/build/playx-raven`, `~/wt-ravenvault-resilience`, `~/playx` 등) 쓰기 금지. 커밋은 이 브랜치 로컬에만. push·태그·릴리스·버전 올리기 금지.
- 🔴 실행 중인 `/Applications/PLAY X Raven.app`(설치된 0.4.2)과 포트 8790 에 쓰기 금지. `/Applications` 의 파일 이름을 바꾸지 말 것. 실제 노드에 `sendrawtransaction`·`issue` 금지. `.env*`·지갑 파일·12단어 읽기 금지. pkill/sudo 금지.

## 절대 바꾸면 안 되는 것 (기존 사용자 지갑·업데이트가 끊긴다)
앱 식별자 `se.erci.ex.playx.raven`, 실행 파일 `playx-raven`, 자료 폴더 `PlayXRaven`, `src-tauri/src/paths.rs`, 업데이터 공개키·endpoint, Windows 설치 GUID/UpgradeCode/레지스트리 경로, 이미 공개된 릴리스 파일. `scripts/desktop-installer-identity.test.mjs` 가 계속 통과해야 한다.

## 해야 할 일

### N1. 사람이 보는 곳의 「PLAY X Raven」「플레이엑스」를 RavenVault Desktop 으로
- 실측으로 남아 있는 곳(전부가 아닐 수 있다 — 직접 전수 조사하라. 주석·시험 고정값·식별자는 제외):
  - 「내 소개」 기본 표시 `index.html` `#ar-nameview` "PLAY X" / `#ar-aboutview` "플레이엑스", `src/main.ts` 의 `about || (name ? "" : "플레이엑스")`, 라비 타일 문구 "손님이 PLAYX 를 보면 지금 「PLAY X · 플레이엑스」뿐입니다…" → 이름이 없으면 **"아직 이름이 없습니다"** 류의 빈 상태로(남의 브랜드를 기본값으로 보여 주지 않는다).
  - Rust 사용자 문구: `services.rs` "PLAY X Raven 을 다시 받아…", `recover.rs` "이 파일은 PLAY X Raven 백업이 아닙니다", `backup.rs` 백업 폴더 "PLAY X Raven 백업"·설명문, `report.rs` device_info, `knowledge.rs` AI 안내문, `health.rs`, `autostart.rs` 표시 이름, `prep.rs` 방화벽 규칙 표시 이름, `electrum.rs` 클라이언트 이름 등.
  - 🔴 호환: **새 백업 폴더 이름을 쓰더라도 옛 「PLAY X Raven 백업」 폴더와 옛 백업 파일은 계속 찾아 복원**할 수 있어야 한다(0.4.1 에서 고친 백업 보존·복원 규칙 유지, `scripts/check-backup-safety.mjs`·`verify-backup-storage.mjs` 통과). 자동 시작·방화벽 규칙은 이름을 바꾸면 **옛 항목이 중복으로 남지 않게**(옛 이름 항목을 찾아 정리하거나, 식별 키는 그대로 두고 표시 이름만) — 방법은 코드를 읽고 판단, 근거를 보고.
  - 앱이 띄우는 로컬 웹 페이지(`web/*.html`, 8790 에서 서빙: 주문·내 지갑·관리 등)의 제목·머리글 브랜드.
  - 릴리스 설치 파일 이름 `PLAY-X-Raven-<ver>-*` (`.github/workflows/release.yml`, `scripts/release-manifest.mjs`, 시험): 다음 릴리스부터 `RavenVault-Desktop-<ver>-*` 로. 🔴 단 **옛 `latest-*` 별칭 경로와 이미 공개된 파일 경로가 계속 살아 있어야** 하고(옛 다운로드 링크·업데이터), `release-manifest.test.mjs`·`verify-published-release*.mjs` 를 새/옛 이름 둘 다 검사하게 고친다.
- macOS 설치된 앱 **파일 이름**(`/Applications/PLAY X Raven.app`)은 업데이터가 같은 경로를 덮어써서 안 바뀐다. 이것을 앱이 스스로 바꿀 수 있는지, 바꾸면 자동 시작(LaunchAgent/로그인 항목 경로)·업데이터가 깨지는지 **코드와 Tauri 문서로 조사만** 하고, 안전한 방법과 위험을 보고서에 적어라(구현은 안전이 증명될 때만, 기본은 안내 문구).

### N2. RavenVault App 처럼 한눈에
- 지금 데스크톱: 왼쪽 사이드바 172px + 라비 홈 타일 격자. 이름·버전·언어 선택이 사이드바 구석에 작게 있다.
- 할 일: 모든 화면 위에 **얇은 머리줄**을 둔다 — 왼쪽 "RavenVault Desktop" 로고(라비 작은 얼굴+글자), 오른쪽에 웹앱과 같은 모양의 **「설정 · 한국어」 알약 단추**(누르면 언어 즉시 바꾸기 + 설정으로). 머리줄은 창 드래그 영역 규칙(`data-tauri-drag-region`, 맥 Overlay 제목줄 34px)을 깨지 않게.
- 라비 홈 맨 위에 **「한눈에」 띠**: 내 노드 상태(켜짐/동기화 %/꺼짐), 지갑 잔액(확정만, 모르면 "확인 못 함"), 「받기」「폰에서 서명한 거래 보내기」 두 단추. 이미 앱에 있는 조회 명령만 쓴다(없는 값을 지어내지 않는다). 그 아래 기존 타일은 그대로(가게가 없으면 「가게 만들기」가 타일 첫 칸 — 대표 결정 유지).
- 디자인 토큰은 웹앱과 맞춘다: 흰 바탕, 굵은 제목, 주황 강조, 본문 16px↑, 누르는 곳 64px↑, 무한 애니메이션 추가 금지, 이모지 금지, 아이콘+라벨.
- 1120×780 과 1440×900 에서 넘침 0.

### N3. 언어 설정이 제대로
- 언어는 한국어·English·日本語·简体中文. 머리줄 단추에서 바꾸면 **다시 켜지 않고** 모든 보이는 문구가 바뀌고, 다음 실행에도 기억.
- 🔴 전수 검사: 네 언어로 각 1차 화면(라비·이야기·지갑·자산·내 소개·내 가게·이 컴퓨터·설정·폰 거래 보내기·백업)을 합성 invoke 로 띄우고, **en/ja/zh 화면에 한글이 남은 텍스트 노드**를 자동으로 찾아 목록화 → 사전(`src/dict.ts`/`src/desktop-copy.ts`)에 번역 추가. 실측 예: "이야기", "못 읽음", "바깥 연결이 꺼져 있습니다". 가게 이름처럼 사용자가 입력한 값은 제외. 이 검사를 스크립트(`scripts/check-desktop-languages.mjs` 등)로 남겨 회귀 방지 — 고치기 전 빨강(남은 한글 수) → 뒤 초록(0 또는 합리적 예외 목록).
- 번역은 짧고 자연스럽게. 기술 용어(RVN, IPFS, Nostr)는 그대로.

## 검사 (전부 실제로 돌리고 종료코드·출력 확인)
- `NODE_OPTIONS=--max-old-space-size=8192 npx tsc --noEmit -p tsconfig.json`, `npm run build`
- `cargo check --tests --offline --manifest-path src-tauri/Cargo.toml`, 바뀐 Rust 모듈 이름 필터 `cargo test --offline …` (backup·recover·autostart·companion 등 — 무엇을 돌렸는지 정확히)
- `node scripts/check-desktop-integration.mjs`, `check-desktop-ux.mjs`, `check-backup-ui.mjs`, `check-backup-safety.mjs`, `verify-backup-storage.mjs`, `check-phone-transaction.mjs`, `desktop-installer-identity.test.mjs`, `release-manifest.test.mjs`, `verify-published-release.test.mjs`, 새 언어 검사
- 스크린샷: 네 언어 × (1120×780, 1440×900) 라비 홈(머리줄+한눈에 띠), 내 소개 빈 상태, 설정 언어 단추 → `artifacts/claude-desktop-identity/`

## 보고 (한국어, `artifacts/claude-desktop-identity/REPORT.md` 에도)
1. 실제 사용 모델 한 줄
2. N1~N3: 바꾼 파일 · 이유 · 빨강→초록 또는 스크린샷
3. 「PLAY X」 전수 조사 결과: 바꾼 곳 / 일부러 남긴 곳(식별자·호환) 표
4. 맥 앱 파일 이름 조사 결론
5. 검사 명령과 결과, 확인 못 한 것, 로컬 커밋 해시
