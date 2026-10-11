# 데스크탑 통합 기록 — `claude/rv-desktop-int` (2026-10-11)

0.8.6 을 내기 전에 형제 브랜치를 한 줄로 모은 기록. **로컬 브랜치 커밋만** 했다(push·태그·배포·서명·공증 없음).
작업 폴더: `/Users/gimmusong/wt-rv-desktop-int` (저장소 `~/build/playx-raven`, 새 워크트리).

## 1. 합친 것

| 순서 | 브랜치 | SHA | 내용 | 결과 |
|---|---|---|---|---|
| 기준 | `claude/rv-signed-lists-desktop` | `4398376` | 수수료 일정 + 서명 목록 + 이름 `RV.<종류>` + creator 마법사 (0.8.5 `5a1bccb` 위) | 트렁크 |
| ① | `claude/rv-mini-window` | `365f45f` | 미니 창 S/M/L · 입금·노드 알림(읽기 전용) | merge `54c653f` — 자동, 충돌 0 |
| ② | `claude/rv-backup-rename` | `c1ee9a2` | 백업 이름 레이븐볼트 · 옛 PLAYXRaven 읽기 전용 · 「백업 찾기」 | merge `760e147` — 자동, 충돌 0 |

### 미합류 (선택 ③)

시작 시점(2026-10-11)에 세 브랜치 모두 **자기 커밋이 없었다** — 합칠 것이 없어 건드리지 않았다.

| 브랜치 | 워크트리 | 상태 | 합칠 방법 |
|---|---|---|---|
| `claude/rv-ravi-chat` | `~/wt-rv-ravi-chat-desktop` (지시서의 `wt-rv-ravi-chat` 는 지갑 저장소 `claude/ravi-chat1` — 다른 저장소) | HEAD = `4398376`(트렁크와 같음), **미커밋 변경 진행 중**: `lib.rs`·`ravi_agent.rs`·`dict.ts`·`main.ts`·`ravi-agent.ts`·`ravi-capabilities.json` | 커밋 뒤 이 브랜치에서 `git merge --no-ff <sha>`. `lib.rs` 는 미니 창 문지기(`mini::command_allowed`)·`mod backup_find` 줄과 겹칠 수 있다 — 둘 다 남긴다. 라비 새 명령을 미니 창 허용 목록에 넣지 말 것(`mini.rs` 시험이 5개 고정) |
| `claude/rv-window-modes` (지시서의 `rv-modes`) | `~/wt-rv-modes` | HEAD = `365f45f`(미니 창 커밋 그대로), 미추적 `artifacts/design-audit/`·`scripts/design-audit-browser.mjs` 만 | 창 모드·칩·메뉴바·대기화면을 커밋하면 미니 창을 이미 품으므로 그대로 merge. `mini.rs`·`lib.rs`·`vite.config.ts`·`index.html` 충돌 예상 |
| `claude/rv-drop-publish` | `~/wt-rv-dropdesign` | HEAD = `87116a5`(트렁크의 조상), 변경 없음 | 커밋 뒤 merge. `src/creator-publish.ts`·`src/main.ts` 는 트렁크(수수료 일정)가 이미 고쳤으니 수수료 문구는 트렁크 쪽(서명된 일정)을 살린다 |

## 2. 충돌 해결표

텍스트 충돌은 **0건**이었다. git 이 자동으로 합친 공통 파일과 의미 확인:

| 파일 | 양쪽 의도 | 결과 확인 |
|---|---|---|
| `src/main.ts` | 트렁크: 장터 수수료를 서명된 일정에서 · ①: 미니 창 열기·알림 · ②: 되돌리기 화면 「백업 찾기」 | 세 변경 모두 다른 구역. tsc 0, 화면 시험 통과 |
| `src-tauri/src/lib.rs` | ①: `mod mini/mini_feed/mini_watch` + 미니 창 문지기 + 명령 5개 + `mini::setup` · ②: `mod backup_find` | 둘 다 있음. 백업 찾기는 기존 `recover::backup_folders` 명령을 그대로 쓰므로 새 명령 없음 → 미니 창 허용 목록(5개) 불변 |
| `src-tauri/Cargo.toml`·`Cargo.lock` | ①만 `notify-rust 4.11`(맥·윈도우만) 추가 | 재생성 없이 ①의 lock 그대로. §3 |
| `package.json` | ①만 `test:mini`·`check:mini-regtest` 추가 | 그대로 |
| `index.html`·`src/dict.ts` | ②만 변경 | 그대로 |
| `ravi_companion.rs`·`vite.config.ts` | ①만 변경(미니 창 입력 `mini.html`) | 그대로 |

## 3. 의존성 변화 (트렁크 `4398376` 대비)

- **npm**: `package-lock.json` 변화 없음(스크립트 두 줄만).
- **Cargo**: 기존 패키지 **판 변경 0**. 새로 들어온 것 8개(모두 ①의 `notify-rust` 때문):
  `notify-rust 4.18.2`, `mac-notification-sys 0.6.15`, `tauri-winrt-notification 0.8.1`, `windows 0.62.2`,
  `windows-collections 0.3.2`, `windows-future 0.3.2`, `windows-numerics 0.3.1`, `windows-threading 0.2.1`.
  cargo 로 lock 을 다시 만들지 않았다(`--offline` 으로 그대로 빌드됨).

## 4. vendor 사본 대조 (지갑 통합 `claude/rv-wallet-int` `0148b6c`, `~/wt-rv-wallet-int`)

- `core/creator/vendor-sha256.json` 의 13개 파일: **데스크탑 = 고정값 = 지갑 통합본, 13/13 바이트 일치.** 갱신할 것 없음.
  `RV_WALLET_CORE=/Users/gimmusong/wt-rv-wallet-int node --test scripts/creator-publish.test.mjs` → 6/6 통과(원본 직접 비교 포함).
- 고정 목록 밖의 `core/` 파일 중 지갑과 다른 것 2개: `core/crypto-backend.ts`, `core/playx-asset-proof/crypto.ts`.
  데스크탑 쪽은 0.8.4 때부터 일부러 줄인 사본(데스크탑에 필요한 함수만)이고 SHA 고정 대상이 아니다 — 바꾸지 않았다.
- 폰 판매 계정 사본 4개(`wallet-keys/derive.ts`·`sales-account.ts`·`official-sales/xpub.ts`·`wallet-offline/base58check.ts`)는 `~/wt-rv-web1008` 와 바이트 일치.

## 5. 검증 결과 (기준 대비)

모두 이 워크트리에서, 기준은 같은 워크트리를 그 SHA 로 잠시 옮겨(detached) 같은 명령으로 돌렸다. Rust 시험 고정 폴더 `RV_BACKUP_FIXTURE_ROOT=/tmp/rv-desktop-int-fixture`.

| 검사 | 트렁크 4398376 | ① 365f45f | ② c1ee9a2 | **통합** |
|---|---|---|---|---|
| `npm test` | 67/68 | 64/66 | 64/66 | **67/68** |
| `npm run test:mini` (Chrome 포함) | — | 41/41 | — | **41/41** |
| `cargo test --lib` | 782 통과·0 실패·13 무시 | 801·0·13 | 788·0·13 | **807·0·13** (= 782+19+6, 빠진 것 없음) |
| 스크립트 묶음 33개 | 21 통과 / 11 실패 / 1 없음 | 21/11/1 | 22/11/0 | **22 / 11 / 0** — 실패 11개는 네 곳 모두 **같은 목록** |
| `tsc --noEmit` · `preflight` · `npm run build` | — | — | — | 0 · 통과 · 통과 |
| `cargo check --offline` | — | — | — | 통과(경고 41, 오류 0) |
| `mini-regtest-latency` (regtest 노드, 임시 datadir) | — | — | — | 통과(잠긴 지갑에서도 감지) |

실제 Chrome(`/Applications/Google Chrome.app`, puppeteer, 네트워크 차단·명령 가짜) 하네스 — 통합본에서 통과:
백업 찾기(`check-backup-find-ui`, 390·1440 × 밝음·어두움), 미니 창(`mini-window-browser.test`), 마법사(`creator-publish-browser.test`),
장터·서명 목록(`signed-lists-browser.test`), 판매·첫 화면(`check-sales-browser`·`check-opening-browser`·`check-home-browser`), CSP(`check-style-csp`).
**라비 브라우저 하네스 3개는 실패 — 기준 네 곳 모두 같은 실패**(아래 표).

### 기존 실패 판정 (회귀 아님)

| 실패 | 판정 | 근거 |
|---|---|---|
| `sales-account.test` 「vendored phone sources … reference cross-check」 | **시험 환경** | 바이트 비교는 통과. 그 뒤 참조 체크아웃 `~/wt-rv-web1008` 의 `derive.ts` 를 esbuild 로 묶다가 그 폴더에 `node_modules` 가 없어 `@noble/hashes` 등을 못 찾음. 데스크탑 사본과 바이트가 같고 데스크탑 쪽 도출 시험은 통과하므로 결과는 같다. 그 워크트리는 건드리지 않았다 |
| `creator-publish.test` 「vendored creator core」(①·② 기준만) | **기준 시점 어긋남, 통합에서 해소** | ①·②의 기반 `09d23b6` 고정값이 지금의 `~/wt-rv-signed-lists-core` 와 다름(`manifest.ts`). 트렁크가 다시 복사해 맞췄고 통합에서 통과 |
| lockbox 간헐 | **재현 안 됨** | 전체 4회 + `lockbox` 만 3회, 모두 16/16 |
| `recover::tests::the_recovery_card_has_no_secrets` | **시험 환경** | 복구 카드에 고정 폴더 경로가 들어가는데, 경로가 `/private/tmp/…` 이면 금지어 `private` 에 걸린다. `/private/tmp` 로 재현(실패), `/tmp/…` 로는 통과. 제품 문제 아님 — 고정 폴더 경로에 `private` 글자를 쓰지 말 것 |
| 라비 브라우저 3개(`check-ravi-panel-browser`·`-understanding-browser`·`-promo-browser`) | **기존 실패(트렁크부터)** | `#ravi-open` 을 눌러도 `#ravi-panel` 이 안 보임 / 특가 카드 대기 시간 초과. 미합류 `claude/rv-ravi-chat`(라비 대화 흐름 수정)이 다루는 곳으로 보임 — 확신 중간 |
| `check-ravi-agent`(`t is not defined`)·`check-send-confirmation`(`sendingNow is not defined`)·`check-desktop-integration`(auto.rs 원문 비교) | **낡은 시험** | 소스에서 함수를 잘라 돌리는 방식이라 코드가 바뀌며 깨짐. 기준 네 곳 동일 |
| `check-home-onescreen`·`check-desktop-ux`·`check-wallet-easy`(라비 도착 말풍선이 받기 단추를 덮음)·`check-words-restore`·`check-desktop-languages` | **기존 실패** | 기준 네 곳 동일. `check-wallet-easy` 의 「말풍선이 단추를 덮음」은 실제 화면 문제일 수 있음 — 확신 낮음, 별도 확인 필요 |

## 6. 남은 위험

- 미니 창 알림은 `notify-rust`(맥 `mac-notification-sys`) — **서명·공증된 앱에서 알림 권한이 실제로 뜨는지는 못 봤다**(번들 빌드 금지). 0.8.6 서명본에서 첫 알림 확인 필요.
- 백업 이름 변경: 첫 자동 백업 날 외장·클라우드에 새 폴더로 한 벌을 새로 쓴다(공간 두 배). iCloud 「다운로드 안 됨」 파일은 「백업 찾기」가 읽는 순간 내려받기 시작(실제 iCloud 시험 안 함). 윈도우·리눅스 실기 확인 없음.
- 미니 창 × 백업 찾기 동시 동작(같은 앱에서 둘 다 켜짐)은 단위·화면 시험으로만 확인, 실제 Tauri 창에서는 못 봄.
- 라비 브라우저 하네스가 트렁크부터 깨져 있어 라비 화면 회귀는 이 통합에서 **검출 불가**.
- 미합류 3개가 나중에 커밋되면 `lib.rs`·`main.ts`·`index.html` 에서 충돌이 날 가능성이 높다.

## 7. 릴리스 0.8.6 준비 체크리스트 (이번에는 하지 않음)

- [ ] 미합류 브랜치(라비 대화·창 모드·끌어놓기 발행) 넣을지 대표 결정 → 넣으면 이 브랜치에 merge 후 §5 전부 다시
- [ ] 버전 올림 `0.8.5 → 0.8.6`: `package.json`, `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml`(+ `Cargo.lock` 의 자기 줄), CHANGELOG·업데이트 안내문
- [ ] 업데이트 서버 패치: 0.8.6 업데이트 묶음·안내문, 서명된 릴리스 메타데이터(`scripts/signed-release-metadata.mjs`·`release-manifest.mjs`) 생성·검증(`verify-published-release`)
- [ ] 서명 목록(수수료 일정 포함) **일련번호 +1 로 재서명, 만료 2026-11-09 전에** — 만료되면 허용 목록·게임 등록부가 기본값으로 돌아간다(차단·마지막 수수료 일정은 유지)
- [ ] 앱 서명·공증(대표 손) → 서명본에서 미니 창 알림 권한·백업 찾기·마법사 실기 확인
- [ ] `docs/pre-release-checklist.md` 전 항목, 판매·메인넷 발행 스위치가 꺼진 채인지 확인
- [ ] `~/rv-release-084`·`~/rv-release-085` 는 이 작업에서 열지 않았다 — 0.8.6 산출물은 새 폴더에

## 8. 릴리스 0.8.7 준비 메모 (2026-10-11, 서명·배포 없음)

- 서명 목록(수수료 일정 포함): **만료 2026-11-09 그대로 유지**. 다음 재서명의 일련번호는 `YYYYMMDDNN` 꼴이며 지금 바닥 `2026101002` 보다 커야 한다(예: 2026101101). 이 저장소는 서명 목록 파일을 갖고 있지 않아 이번 작업에서 서명·갱신하지 않았다(대표 키 손).
- 서명된 릴리스 메타데이터(`signed_releases`)의 `sequence` 는 직전 공개분보다 커야 하고 `expires` 가 지나지 않아야 한다(`scripts/signed-release-metadata.mjs` 검사). 만들기·서명·업로드는 하지 않았다.
- 실제 메인넷 발행은 `REAL_MAINNET_ISSUE_ENABLED = false` 로 출하(`src-tauri/src/issue.rs`). 켜는 길은 상수를 바꾸고 새로 빌드하는 것뿐이다.
- 실제 iCloud·USB 로의 내보내기, 실제 노드와의 가져오기 전환, 서명본에서의 폴더 선택창은 실기 확인이 필요하다(이 작업은 앱을 실행하지 않았다).
