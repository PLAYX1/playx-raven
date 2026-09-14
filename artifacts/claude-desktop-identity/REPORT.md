실제 사용 모델: `gpt-6-astra`

작업서 N1~N3를 구현하고 검사를 실행했습니다. 시작 HEAD는 `eb9ce8e`(0.4.2), 브랜치는 `claude/ravenvault-desktop-ux`입니다. 구현·검증 증거 커밋: `4c66ae44482a5a54c394b8dc287104ce0ba4bf49`. 이 보고서는 그 커밋 뒤의 문서 커밋에 들어갑니다.

**1. 이름 통일(N1)**

| 바꾼 파일 | 변경과 이유 |
|---|---|
| `index.html`, `src/main.ts`, `src/dict.ts` | 내 소개 기본 이름을 네 언어의 “아직 이름이 없습니다”로 변경. 빈 소개는 빈 상태로 유지. 라비 안내와 이름 입력칸 안내도 일치시킴. 판매 등록의 고정 작성자 `PLAY X`를 입력한 소개 이름으로 변경. |
| `src-tauri/src/services.rs`, `recover.rs`, `report.rs`, `knowledge.rs`, `electrum.rs`, `awake.rs`, `devfee.rs` | 설치·복원 안내, 진단 기기명, AI 프로그램 이름, Electrum 클라이언트 이름, 절전 방지 표시, 수수료 설명의 프로그램 브랜드를 RavenVault Desktop으로 통일. |
| `src-tauri/src/backup.rs`, `scripts/fixtures/backup-safety.rs` | 새 외부 저장 위치는 `RavenVault Desktop 백업`. 기존 `PLAY X Raven 백업` 폴더가 있으면 그대로 사용. 백업 설명문 변경. 두 이름에서 암호화 백업 생성·이전 세대 보존·복호화 내용 일치 검사를 추가. |
| `src-tauri/src/autostart.rs`, `prep.rs` | Linux 자동 시작 파일의 표시명만 변경. Windows 방화벽은 옛/새 표시명을 함께 찾아 첫 규칙을 갱신한 뒤 나머지 중복을 제거. 없을 때만 고정 Name으로 생성. |
| `web/admin.html`, `buy.html`, `customer.html`, `scan.html`, `shops.html`, `staff.html`, `wallet.html`, `manifest.json`, `ravi.js`, `report.js` | 로컬 페이지 제목·공통 머리글·앱 메타데이터·도움말 브랜드 변경. |
| `web/wallet.src.ts`, `wallet.bundle.js` | 패스키 생성 창의 `rp.name` 표시 문자열만 변경. 원본과 번들에 동일하게 적용. RP ID·사용자 ID·저장 키와 지갑 동작은 유지. |
| `.github/workflows/release.yml`, `scripts/release-manifest.mjs`, `release-manifest.test.mjs`, `verify-published-release.mjs`, `verify-published-release.test.mjs` | 다음 생성물은 `RavenVault-Desktop-<ver>-*`. 새/옛 입력 파일 이름 검증. 두 브랜드의 `latest-*` 별칭 제공. 기존 버전 디렉터리 덮어쓰기와 다운그레이드 거부는 유지. 새 릴리스의 검증은 옛 latest 별칭도 HEAD 조회하며, 없어지면 실패. |
| `scripts/check-desktop-integration.mjs` | 옛 HTML/웹 지갑의 바이트 일치 검사에서 승인된 브랜드 문자열·공통 머리글 변경만 허용. 그 외 노드·지갑·자산 동작과 설치 식별자 보존 검사는 유지. |

백업 호환 방법: 출력 경로를 정하는 `external_backup_dir()`를 일반 백업과 일일 완료 영수증 계산이 함께 사용합니다. 옛 폴더를 옮기거나 지우지 않으므로 같은 날 재시도·이전 암호화 사본 보존 규칙이 이어집니다. 복원은 선택한 경로와 파일 내용/확장자를 읽는 기존 동작을 유지하므로 옛 ZIP·`.pxlock`·`.잠김`도 그대로 받습니다. 합성 백업 안전 검사 15개와 저장/복원 검증이 통과했습니다.

자동 시작 호환 방법: macOS LaunchAgent LABEL `se.erci.playxraven`와 plist 경로, Linux `playx-raven.desktop` 경로, Windows Run 값 `PLAY X Raven`을 보존했습니다. Windows Run 값은 식별 이름과 표시 이름을 따로 둘 수 없는 기존 구현이므로 `health.rs`의 등록/삭제 코드까지 같은 값을 유지합니다. 새 Run 값을 추가하지 않아 중복 등록이 생기지 않습니다. Linux는 사용자가 자동 시작 설정을 적용할 때 같은 파일에 새 표시명을 씁니다.

**2. 한눈에 보기(N2)**

`index.html`과 `src/main.ts`에 모든 화면 공통 머리줄을 추가했습니다. 라비 얼굴·RavenVault Desktop·설정/현재 언어 단추가 항상 보입니다. 기존 맥 Overlay 제목줄 34px를 그대로 비워 두고 머리줄은 그 아래에 배치했습니다. 드래그용 요소에만 `data-tauri-drag-region`을 두며 단추에는 붙이지 않았습니다.

라비 맨 위에 내 노드·확정 잔액·받기·폰 서명 거래 보내기를 배치했습니다. 조회는 기존 `node_status`와 `wallet_balance`만 사용합니다. 유효한 `confirmed` 숫자만 잔액으로 표시하며, 실패/누락은 “확인 못 함”입니다. 합성 확정 잔액 12.5 RVN/미확정 9999 RVN에서 12.5만 표시되는 것, 조회 실패 시 0으로 표시하지 않는 것, 동기화 50.0%, 두 단추의 이동을 검사했습니다. 실제 계정 잔액을 조회하지 않았습니다.

흰 바탕, 주황 `#e7731f`, 굵은 제목, 본문/입력 안내 16px, 주요 단추 64px를 적용했습니다. 새 무한 애니메이션이나 이모지를 추가하지 않았습니다. 기존 타일과 가게 만들기 첫 칸 결정을 유지했고, 준비 안내는 타일 뒤로 옮겨 1120×780에서도 첫 타일이 보이게 했습니다. 1120×780·1440×900의 문서와 main 가로 넘침은 모두 0입니다. 긴 화면은 기존처럼 세로 스크롤합니다.

참조한 웹앱 소스는 `~/wt-ravenvault-web-ux/phone/web/WalletAccess.tsx`, `phone/ui/MainNavigation.tsx`, `phone/ui/tokens.ts`, `phone/screens/common.tsx`이며 읽기만 했습니다. 공개 지갑 URL은 웹 조회 도구에서 오류가 나 공개 화면 자체의 시각 대조는 못 했습니다.

**3. 네 언어와 회귀 검사(N3)**

`src/i18n.ts`는 페이지 reload를 없애고 텍스트 노드/속성의 원문과 번역 결과를 기억합니다. 한국어로 시작해도 MutationObserver가 동작합니다. 한국어·English·日本語·简体中文을 즉시 바꾸고 기존 `playx-raven-lang` 저장 키로 다음 실행에도 기억합니다. 소개/가게 이름 같은 사용자 값은 `translate="no"`로 보호합니다.

`src/desktop-copy.ts`와 `src/dict.ts`에서 누락 번역과 낡은 안내를 보완했습니다. `scripts/check-desktop-languages.mjs`는 격리 Chrome 프로필·임의 로컬 포트·합성 invoke를 사용하고 외부 요청을 차단합니다. 라비·이야기·지갑·자산·내 소개·내 가게·이 컴퓨터·설정·폰 거래 보내기·백업의 네 언어/두 크기, 총 80 화면을 검사합니다.

- 수정 전 텍스트 노드 한글 잔존 **1,662건 → 0건**: [수정 전](languages-red.json), [최종](languages-green.json).
- 입력 안내문 검사에서 추가 발견한 **24건 → 0건**: [안내문 빨강 로그](languages-attributes.log), [최종 화면 로그](languages-layout-final.log).
- **224회 언어 전환 통과**: 현재 화면·거래 입력 보존, reload 없음, 저장 언어의 다음 로드 복원. [실행 로그](check-desktop-languages.log).
- 사용자 이름 `이야기`와 사용자 소개가 번역되지 않는 것, 빈 소개 이름은 해당 언어로 표시되는 것, 브라우저 런타임 오류 0을 검사했습니다.
- 합리적 예외는 언어 선택지의 고유 표기(한국어), 사용자가 입력한 값, 원문 URL/프로토콜 값입니다. 앱이 제공하는 빈 상태 이름은 예외 처리하지 않고 별도로 검사합니다.

스크린샷 24장(각 언어 × 두 크기 × 홈/소개/설정)은 이 폴더에 있습니다. `preferences-*`는 설정 화면과 머리줄 언어 메뉴를 함께 보여 줍니다.

| 언어 | 홈 1120 | 홈 1440 | 소개 1120 | 소개 1440 | 설정 1120 | 설정 1440 |
|---|---|---|---|---|---|---|
| ko | [홈](ravi-ko-1120x780.png) | [홈](ravi-ko-1440x900.png) | [소개](artist-ko-1120x780.png) | [소개](artist-ko-1440x900.png) | [설정](preferences-ko-1120x780.png) | [설정](preferences-ko-1440x900.png) |
| en | [홈](ravi-en-1120x780.png) | [홈](ravi-en-1440x900.png) | [소개](artist-en-1120x780.png) | [소개](artist-en-1440x900.png) | [설정](preferences-en-1120x780.png) | [설정](preferences-en-1440x900.png) |
| ja | [홈](ravi-ja-1120x780.png) | [홈](ravi-ja-1440x900.png) | [소개](artist-ja-1120x780.png) | [소개](artist-ja-1440x900.png) | [설정](preferences-ja-1120x780.png) | [설정](preferences-ja-1440x900.png) |
| zh | [홈](ravi-zh-1120x780.png) | [홈](ravi-zh-1440x900.png) | [소개](artist-zh-1120x780.png) | [소개](artist-zh-1440x900.png) | [설정](preferences-zh-1120x780.png) | [설정](preferences-zh-1440x900.png) |

**4. PLAY X 전수 조사에서 일부러 남긴 것**

[전수 조사 목록](brand-audit.json)은 추적 중인 코드·설정·워크플로·시험·라이선스를 대상으로 합니다. 생성된 웹 번들의 표시명도 별도로 검색했습니다. 주석과 시험 고정값은 제품 표시문구와 구분했습니다.

| 남긴 종류 | 예와 근거 |
|---|---|
| 설치/실행/데이터 식별자 | `se.erci.ex.playx.raven`, `playx-raven`, `PlayXRaven`, Windows GUID·UpgradeCode·레지스트리 경로. `paths.rs`, Tauri 설정, Cargo/package 버전은 시작 HEAD와 차이가 없습니다. |
| 업데이트 공개 경로 | 기존 updater endpoint·공개키, `PLAYX1/playx-raven-releases`, 옛 불변 버전 파일 URL와 `PLAY-X-Raven-latest-*`. 기존 업데이트·다운로드 링크를 유지합니다. |
| 자동 시작 식별자와 방화벽 이전 이름 검색 | LaunchAgent LABEL, Linux 파일명, Windows Run 값, 방화벽의 옛 표시명 검색 문자열. 중복 없이 같은 항목을 찾기 위한 값입니다. |
| 백업 저장·암호화 호환 | `PLAYXRaven-Backup`, `PLAYXRaven.zip.pxlock`, 이전 사본·완료 영수증 이름, `PXRLOCK1`, 옛 폴더 검색. 이미 저장된 파일을 계속 복원하고 같은 보존 규칙을 쓰기 위한 값입니다. |
| 체인 자산·프로토콜·저장 키 | `PLAYX`, `SHOP.PLAYX`, `PLAYX/SONG`, 발행 예시, `PLAYX-AUCTION`, 키 파생 문자열, localStorage 키, `PLAYX_HELP`. 자산과 프로토콜을 앱 브랜드와 혼동해 바꾸면 호환성이 깨집니다. |
| 제작자/아티스트 사실과 저작권 | LICENSE와 knowledge의 제작자 PLAY X/PLAX 사실. 제품 이름이 아니라 제작자·아티스트 이름입니다. |
| 주석·합성 시험 | 과거 장애 설명과 옛 이름 fixture는 회귀·호환성 근거이므로 보존했습니다. |

**5. Mac 앱 파일 이름 조사 결론**

앱 스스로 실행 중인 `/Applications/PLAY X Raven.app`을 이름 바꾸는 구현은 하지 않았습니다. 설정에 기존 파일 이름이 남을 수 있다는 안내를 넣었습니다.

Tauri의 `productName`은 제품 표시/번들 이름을 정하지만, 설치된 기존 경로의 이동을 보장하지 않습니다. [Tauri 구성 문서](https://v2.tauri.app/reference/config/#productname), [업데이터 문서](https://v2.tauri.app/plugin/updater/).

이 저장소가 사용하는 tauri-plugin-updater 2.10.1의 소스에서 `extract_path_from_executable()`은 현재 실행 파일로부터 `.app` 경로를 구합니다. macOS `install_inner()`는 압축 파일의 최상위 앱 이름을 제거해 임시 폴더에 풀고, 최종 결과를 `self.extract_path`에 옮깁니다. 따라서 새 번들 이름이어도 기존 경로가 유지됩니다. [버전 고정 업데이터 소스](https://github.com/tauri-apps/plugins-workspace/blob/updater-v2.10.1/plugins/updater/src/updater.rs#L1210-L1380). 로컬 캐시의 동일 버전 소스도 대조했습니다.

우리 `autostart.rs::launch_argv()`는 현재 `.app` 경로를 `/usr/bin/open -a`의 인수로 기록합니다. 앱만 이름 바꾸면 기존 LaunchAgent가 옛 경로를 계속 가리킵니다. 이미 생성한 updater 객체도 옛 추출 경로를 보유할 수 있습니다. 안전한 기본은 기존 경로를 유지하면서 앱 내부 표시명만 통일하는 것입니다. 향후 파일명 이관은 앱 종료 후의 원자적 이동, 동일 LABEL의 로그인 경로 갱신, 다음 기동/다음 업데이트/롤백 검증을 갖춘 별도 마이그레이션으로 다뤄야 합니다. 현재 안전성이 증명되지 않아 구현하지 않았습니다.

Windows 방화벽 변경은 `Set-NetFirewallRule -NewDisplayName`으로 기존 규칙을 갱신하며 프로그램 경로도 함께 갱신합니다. [Microsoft 공식 명령 문서](https://learn.microsoft.com/en-us/powershell/module/netsecurity/set-netfirewallrule?view=windowsserver2025-ps). 실제 Windows 방화벽 실행 검증은 이번 Mac 환경에서 하지 못했습니다.

**6. 검사 명령과 결과**

모든 지정 검사의 종료코드는 0입니다. [명령·종료코드·소요 시간](checks.json), [최종 추가 확인](additional-checks.json). 실행 시 `NODE_OPTIONS=--max-old-space-size=8192`, `CARGO_NET_OFFLINE=true`를 적용했고, Rust 시험의 임시 파일과 앱 데이터는 이 워크트리 아래 합성 경로를 사용했습니다. 앱 프로세스를 실행하지 않았습니다.

| 실행 명령 | 종료코드 | 출력 |
|---|---:|---|
| `node scripts/check-backup-safety.mjs` | 0 | [로그](check-backup-safety.log) |
| `node scripts/verify-backup-storage.mjs` | 0 | [로그](verify-backup-storage.log) |
| `node scripts/check-phone-transaction.mjs` | 0 | [로그](check-phone-transaction.log) |
| `cargo check --tests --offline --manifest-path src-tauri/Cargo.toml` | 0 | [로그](cargo-check.log) |
| `cargo test --offline --manifest-path src-tauri/Cargo.toml backup:: -- --test-threads=1` | 0 | [로그](cargo-backup.log) |
| `cargo test --offline --manifest-path src-tauri/Cargo.toml recover:: -- --test-threads=1` | 0 | [로그](cargo-recover.log) |
| `cargo test --offline --manifest-path src-tauri/Cargo.toml autostart:: -- --test-threads=1` | 0 | [로그](cargo-autostart.log) |
| `cargo test --offline --manifest-path src-tauri/Cargo.toml companion:: -- --test-threads=1` | 0 | [로그](cargo-companion.log) |
| `cargo test --offline --manifest-path src-tauri/Cargo.toml services:: -- --test-threads=1` | 0 | [로그](cargo-services.log) |
| `cargo test --offline --manifest-path src-tauri/Cargo.toml report:: -- --test-threads=1` | 0 | [로그](cargo-report.log) |
| `cargo test --offline --manifest-path src-tauri/Cargo.toml electrum:: -- --test-threads=1` | 0 | [로그](cargo-electrum.log) |
| `cargo test --offline --manifest-path src-tauri/Cargo.toml awake:: -- --test-threads=1` | 0 | [로그](cargo-awake.log) |
| `cargo test --offline --manifest-path src-tauri/Cargo.toml devfee:: -- --test-threads=1` | 0 | [로그](cargo-devfee.log) |
| `cargo test --offline --manifest-path src-tauri/Cargo.toml prep:: -- --test-threads=1` | 0 | [로그](cargo-prep.log) |
| `cargo test --offline --manifest-path src-tauri/Cargo.toml knowledge:: -- --test-threads=1` | 0 | [로그](cargo-knowledge.log) |
| `NODE_OPTIONS=--max-old-space-size=8192 npx tsc --noEmit -p tsconfig.json` | 0 | [로그](tsc.log) |
| `npm run build` | 0 | [로그](build.log) |
| `node scripts/check-desktop-integration.mjs` | 0 | [로그](check-desktop-integration.log) |
| `node scripts/check-desktop-ux.mjs` | 0 | [로그](check-desktop-ux.log) |
| `node scripts/check-backup-ui.mjs` | 0 | [로그](check-backup-ui.log) |
| `node scripts/desktop-installer-identity.test.mjs` | 0 | [로그](desktop-installer-identity.test.log) |
| `node scripts/release-manifest.test.mjs` | 0 | [로그](release-manifest.test.log) |
| `node scripts/verify-published-release.test.mjs` | 0 | [로그](verify-published-release.test.log) |
| `node scripts/check-desktop-languages.mjs` | 0 | [로그](check-desktop-languages.log) |

Rust 필터별 실제 통과 수: `autostart::` 4개, `awake::` 4개, `backup::` 2개, `companion::` 18개, `devfee::` 10개, `electrum::` 2개, `knowledge::` 3개, `prep::` 4개, `recover::` 7개, `report::` 4개, `services::` 9개. 합계 67개입니다. 별도 합성 백업 명령 안전 검사 15개, 공개 릴리스 검증 11개, 웹 지갑 단위 검사 4개도 통과했습니다.

확인 범위와 남은 제약: Chrome 합성 렌더링으로 화면을 검증했습니다. 설치된 0.4.2 앱, 실제 노드·지갑·패스키, 실제 macOS 드래그/업데이트 설치, Windows/Linux 자동 시작·방화벽의 운영체제 실행은 검사하지 않았습니다. 공개 릴리스의 새 파일은 생성·업로드하지 않았으므로 새 공개 URL의 실제 HEAD 조회도 실행하지 않았고 합성 fetch로 검증했습니다. Rust의 기존 unused/dead-code 경고와 Vite의 번들 크기 경고가 남아 있으며 오류는 없습니다.

`/Applications` 파일 변경, 포트 8790 연결/쓰기, 실제 `sendrawtransaction`·`issue`, `.env*`·실제 지갑 파일·복구 단어 읽기, 다른 워크트리 쓰기, push·태그·릴리스·버전 올리기는 하지 않았습니다. 작업 전부터 존재하던 다른 artifacts 변경은 커밋 대상에서 제외했습니다. 기존 화면 검사 스크립트가 갱신한 과거 artifacts 출력도 이번 커밋에 넣지 않았습니다.
