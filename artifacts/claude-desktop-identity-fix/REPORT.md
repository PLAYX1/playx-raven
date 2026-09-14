실제 모델: gpt-6-astra

RavenVault Desktop Fable 검증 지적 F1 및 F2 1~8을 수정하고, 합성 UI·Rust·호환성 검사를 완료했다. 작업 브랜치는 `claude/ravenvault-desktop-ux`, 시작 HEAD는 `daa80d6c8bc748e0391f9f6d484a1abc6f8e7cb3`이다.

F1 사용자 표시값 변경은 **630건 → 0건**이다. [수정 전 원자료](user-content-red.json), [수정 후 원자료](user-content-green.json), [빨강 실행 로그](f1-red.log), [최종 언어 검사 로그](check-desktop-languages.log)에 값을 남겼다.

[`src/i18n.ts`](../../src/i18n.ts)의 역방향 `canonical` 사전을 없앴다. 이미 번역한 노드는 `originals`의 원문으로만 되돌리고, 새 노드는 번역값으로 원문을 추측하지 않는다. JS가 그리는 앱 문구는 정확한 텍스트 노드에 연결한 `setCopyText` 또는 원문을 명시한 `copyHtml`로 언어를 전환한다. 화면을 다시 열거나 조회·거래 검토를 다시 실행할 필요가 없다. 번역 후 같은 문자열이 되는 **31개 충돌 그룹·43개 원문**도 각 노드의 원문으로 돌아오는 것을 네 언어에서 검사했다.

[`src/main.ts`](../../src/main.ts)의 실제 이야기 글·작성자·방 이름·자산명·가게명·개인 타일·사용자 대화 등의 표시에는 `translate="no"` 경계를 넣었다. 자산 상세 메타데이터도 사용자 표시값으로 다룬다. [`src/phone-transaction.ts`](../../src/phone-transaction.ts)는 앱 안내와 거래 값을 분리해 언어를 바꿔도 검토 결과·주소·자산명·거래 ID·전송 가능 상태를 보존한다.

[`scripts/check-desktop-languages.mjs`](../../scripts/check-desktop-languages.mjs)는 기본 실행에 F1 검사를 포함한다. `talk_read`, `list_assets`, `shop_load` 합성 응답으로 실제 렌더러에 자료를 넣었다. 19개 영어·일본어·중국어·한국어 값에는 `More`, `Photo`, `Invite`, `Chat`, `Message`, `ファンクラブ`, `写真`, `My node`, `사진`, `이야기`, `그만두기`, `취소`가 포함된다. 이야기·자산·메뉴 입력·가게명을 최초 표시와 네 번의 언어 전환 후 대조하고, Fable의 표시 없는 외국어 노드·title 탐침도 별도로 대조했다. 총 **88묶음, 1,240개 표시값 대조**에서 변경이 0이다. 메뉴 입력값은 수정 전에도 바뀌지 않았고, 글·자산명·외국어 노드가 실제 실패한 영역이다. 초반 진행 보고의 785건은 글 역순·브라우저 정렬을 보정하기 전 수치이며, 동일한 최종 검사로 원래 코드를 다시 실행한 630건을 공식 기준으로 삼았다.

빨강 재현은 원본 작업 파일을 되돌리지 않고 `daa80d6`의 소스를 이 워크트리 안의 합성 디렉터리에 묶어 실행했다. 재현 명령은 아래와 같다. 두 번째 명령의 종료코드 **1**은 630건 변조를 검출한 의도된 실패다.

```sh
node artifacts/claude-desktop-identity-fix/build-baseline.mjs
RV_LANGUAGE_DIST=artifacts/claude-desktop-identity-fix/baseline-app node scripts/check-desktop-languages.mjs --probes-only --baseline
node scripts/check-desktop-languages.mjs
```

F2의 파일·판단·검증 근거는 다음과 같다.

| 항목 | 변경 파일과 근거 |
|---|---|
| 1. 미확정 잔액 | `src/main.ts`, `src/desktop-copy.ts`: ‘확인 대기 중’을 세 언어로 추가하고 숫자와 따로 렌더링했다. 언어 검사는 항상 확정 12.5·미확정 9,999 RVN 응답을 포함하며, 전환 시 정확한 안내 문자열까지 대조한다. 한눈에에는 확정 12.5 RVN만 나온다. |
| 2. 다크 OS 토큰 | `index.html`: 마지막 light `:root`에 `--faint:#626262`, `--ravi-tint:#fdf1e7` 및 나머지 테마 토큰을 모두 명시했다. [다크 1120×780](ravi-ko-dark-1120x780.png)과 computed style 검사가 흰 바탕·올바른 보조색을 확인한다. |
| 3. 브랜드 중복 | `index.html`: 사이드바 큰 라비·이름을 제거하고 버전과 업데이트 확인 알약을 유지했다. `nav` 172px, 사이드바·본문·문서 가로 넘침 0을 검사했다. |
| 4. 설정 아이콘 | `index.html`: 해 모양을 두 조절 막대와 손잡이 SVG로 바꿨다. 요청한 웹앱 파일을 읽기 전용으로 확인했으며, 현재 파일에는 별도 설정 아이콘 정의가 없어 요청한 조절 막대 의미를 같은 24px 선형 SVG로 구현했다. [열린 설정 메뉴](settings-menu-en-1440x900.png). |
| 5. 폰 거래 타일 중복 | `src/main.ts`: 폰 거래 타일을 제거했다. 한눈에 단추가 거래 패널을 열며, 기존 패널의 접기·펴기 및 검토·전송 동작은 유지한다. 가게가 없으면 첫 타일은 여전히 ‘가게 만들기’다. 기존 UX 검사도 타일 순번 대신 한눈에 단추를 누르게 변경했다. |
| 6. 주 행동 | `index.html`: ‘받기’와 ‘폰에서 서명한 거래 보내기’를 동일한 흰 바탕·테두리·글자색으로 맞췄다. 두 지갑 동작의 무게를 같게 하고, 첫 설정 행동인 ‘가게 만들기’에만 주황 채움을 남긴다. 두 단추의 computed background 및 첫 lead 타일을 검사했다. |
| 7. 손님 페이지 띠 | `web/wallet.html`, `buy.html`, `customer.html`, `shops.html`: 49px 브랜드 띠를 제거하고 `<title>`을 `RavenVault`로 맞췄다. 지갑·가게 페이지의 앱/공유 메타데이터도 손님 브랜드로 맞췄다. [390×844 가게 찾기](shops-ko-390x844.png)에서 띠 없음·넘침 0을 확인했다. 기존 구매·지갑 행동은 호환성 검사로 대조했다. |
| 8. 첫 조회 합치기 | `src/main.ts`: 인자 없는 `wallet_balance`·`node_status`의 첫 요청 Promise를 최대 1.5초 동안 공유한다. 첫 클릭/키 입력에 해제하고, 실패한 조회도 캐시에서 제거한다. 쓰기 명령과 유휴 조회는 캐시하지 않는다. 언어 변경은 기록된 문구만 다시 그린다. |

시작 호출 수는 Fable의 탐색 후 누계와 구분해 **페이지 로드 직후, 추가 탐색 전에** 측정했다. 같은 응답·화면·대기 조건의 [수정 전](layout-startup-red.json)과 [수정 후](layout-startup-green.json)는 다음과 같다.

| 합성 조건 | wallet_balance | node_status |
|---|---:|---:|
| 원래 코드, 일반 시작 | 5 | 6 |
| 수정 코드, ko/en × 두 창 크기 각각 | 1 | 1 |
| 원래 코드, 가게·글·자산 탐침 자료 포함 | 6 | 7 |
| 수정 코드, 동일 탐침 자료·네 언어 각각 | 1 | 1 |

Fable 기록의 8·7회는 추가 화면 탐색 뒤 누계였다. 동일한 합성 AI 설정이 있는 상태로 잰 **65초 유휴 호출은 전후 모두 wallet_balance 3회·node_status 6회·money_status 1회**다. 20초 상태 갱신·60초 money 갱신 등 기존 주기를 유지했다. Fable의 AI 설정 응답이 없는 조건과는 실행되는 갱신 경로가 달라 유휴 누계 자체를 직접 비교하지 않았다.

모든 스크린샷은 이 디렉터리에 있다. `ravi-{ko,en,ja,zh}-{1120x780,1440x900}.png`, `artist-*`, `preferences-*`는 이전 작업서의 네 언어 요구를 충족한다. 추가로 `settings-menu-{ko,en}-*`, 다크 화면, 390px 손님 화면을 남겼다. 데스크톱·폰 거래·백업의 기존 화면 증거는 `desktop-ux/`, `backup-ui/`에 격리했으므로 이전부터 변경돼 있던 스크린샷에 덮어쓰지 않았다.

검사 명령과 최종 결과는 아래와 같다. [기계 판독 결과](checks.json)에도 27개 종료코드를 기록했다. tsc 로그는 **0바이트**, 종료코드는 **0**임을 직접 확인했다. Rust 제품 코드는 이번 작업에서 변경하지 않았으며, 이전 작업서의 모듈 필터까지 실행했다.

| 명령 | 종료코드 | 결과·로그 |
|---|---:|---|
| `node scripts/check-desktop-integration.mjs` | 0 | 통과 · [check-desktop-integration.log](check-desktop-integration.log) |
| `NODE_OPTIONS=--max-old-space-size=8192 npx tsc --noEmit -p tsconfig.json` | 0 | 출력 0바이트 확인, 오류 없음 · [tsc.log](tsc.log) |
| `node scripts/check-backup-safety.mjs` | 0 | 통과 · [check-backup-safety.log](check-backup-safety.log) |
| `RV_BACKUP_FIXTURE_ROOT="$PWD/artifacts/claude-desktop-identity-fix/rust-fixtures" cargo test --offline --manifest-path src-tauri/Cargo.toml backup -- --test-threads=1` | 0 | 20개 통과 · [cargo-test-backup.log](cargo-test-backup.log) |
| `cargo test --offline --manifest-path src-tauri/Cargo.toml recover -- --test-threads=1` | 0 | 8개 통과 · [cargo-test-recover.log](cargo-test-recover.log) |
| `cargo test --offline --manifest-path src-tauri/Cargo.toml autostart -- --test-threads=1` | 0 | 4개 통과 · [cargo-test-autostart.log](cargo-test-autostart.log) |
| `cargo test --offline --manifest-path src-tauri/Cargo.toml companion -- --test-threads=1` | 0 | 18개 통과 · [cargo-test-companion.log](cargo-test-companion.log) |
| `node scripts/check-backup-ui.mjs` | 0 | 통과 · [check-backup-ui.log](check-backup-ui.log) |
| `cargo test --offline --manifest-path src-tauri/Cargo.toml services:: -- --test-threads=1` | 0 | 9개 통과 · [cargo-test-services.log](cargo-test-services.log) |
| `cargo test --offline --manifest-path src-tauri/Cargo.toml report:: -- --test-threads=1` | 0 | 4개 통과 · [cargo-test-report.log](cargo-test-report.log) |
| `cargo test --offline --manifest-path src-tauri/Cargo.toml electrum:: -- --test-threads=1` | 0 | 2개 통과 · [cargo-test-electrum.log](cargo-test-electrum.log) |
| `cargo test --offline --manifest-path src-tauri/Cargo.toml awake:: -- --test-threads=1` | 0 | 4개 통과 · [cargo-test-awake.log](cargo-test-awake.log) |
| `cargo test --offline --manifest-path src-tauri/Cargo.toml devfee:: -- --test-threads=1` | 0 | 10개 통과 · [cargo-test-devfee.log](cargo-test-devfee.log) |
| `cargo test --offline --manifest-path src-tauri/Cargo.toml prep:: -- --test-threads=1` | 0 | 4개 통과 · [cargo-test-prep.log](cargo-test-prep.log) |
| `cargo test --offline --manifest-path src-tauri/Cargo.toml knowledge:: -- --test-threads=1` | 0 | 3개 통과 · [cargo-test-knowledge.log](cargo-test-knowledge.log) |
| `node scripts/verify-backup-storage.mjs` | 0 | 통과 · [verify-backup-storage.log](verify-backup-storage.log) |
| `node scripts/check-phone-transaction.mjs` | 0 | 통과 · [check-phone-transaction.log](check-phone-transaction.log) |
| `node scripts/desktop-installer-identity.test.mjs` | 0 | 통과 · [desktop-installer-identity.test.log](desktop-installer-identity.test.log) |
| `node scripts/release-manifest.test.mjs` | 0 | 통과 · [release-manifest.test.log](release-manifest.test.log) |
| `node scripts/verify-published-release.test.mjs` | 0 | 통과 · [verify-published-release.test.log](verify-published-release.test.log) |
| `node scripts/check-desktop-ux.mjs` | 0 | 통과 · [check-desktop-ux.log](check-desktop-ux.log) |
| `node scripts/check-desktop-identity-fix.mjs` | 0 | 넘침 0, 시작 각각 1회, 다크·390px·유휴 주기 통과 · [layout-green.log](layout-green.log) |
| `node scripts/check-desktop-identity-fix.mjs --baseline` | 0 | 통과 · [layout-baseline.log](layout-baseline.log) |
| `node scripts/check-desktop-languages.mjs` | 0 | 80화면·224회 전환·추가 거래 전환 32회·사용자 탐침 88검사 통과 · [check-desktop-languages.log](check-desktop-languages.log) |
| `npm run build` | 0 | 성공; Vite 번들 크기 경고만 있음 · [build.log](build.log) |
| `cargo check --tests --offline --manifest-path src-tauri/Cargo.toml` | 0 | 성공; 기존 unused/dead-code 경고 · [cargo-check.log](cargo-check.log) |
| `git diff --check` | 0 | 통과 · 출력 없음 |

검사 중 드러난 설정 문제도 수정했다. Rust `backup` 필터는 전용 fixture 환경변수가 없을 때 실제 자료 접근 전 중단됐고, 이 워크트리 안의 빈 합성 폴더를 지정해 20개를 통과했다. 기존 UX 검사의 ‘사이드바 큰 그림’·‘두 번째 폰 타일’ 기대값은 새 요구와 맞게 바꿨다. 브라우저 검사는 모든 검증·종료·프로필 제거 이후에도 도구 IPC가 프로세스 종료를 지연해, 성공 경로의 마지막에 명시적으로 종료하도록 했다. 최종 세 브라우저 게이트의 실제 종료코드 0을 다시 확인했다. 로그 마지막의 빈 줄만 정리했으며 검사 출력 내용은 유지했다.

확인 범위의 한계: 설치된 `/Applications/PLAY X Raven.app`를 실행하거나 수정하지 않았으므로 실제 Tauri WebView·OS 창 드래그·업데이트 설치는 재시험하지 않았다. 실제 지갑·노드·8790·실거래를 사용하지 않았고, 네트워크와 native invoke는 합성 응답으로 차단했다. 실제 Windows 설치·릴리스 배포도 실행하지 않았다. 이 항목들은 요청된 금지 범위이며, 정적 식별자·자료 경로·업데이터·설치 GUID·구형 백업·릴리스 이름 호환성 검사는 통과했다. 전체 앱의 모든 가능한 서버 응답 조합을 자동 검사한 것은 아니며, 본 보고서의 언어 보장은 명시한 화면·탐침·전환 상태에 대한 실행 결과다.

로컬 구현·검사·스크린샷 커밋: `557a85885cd0efe78187a6bb02ae56c64253328d`. 이 보고서는 해당 구현 커밋을 가리키는 후속 문서 커밋에 기록한다. push·태그·릴리스·버전 변경은 하지 않았다. 다른 워크트리는 읽기 전용 참조만 했으며, 앱 식별자·실행 파일·자료 폴더·`src-tauri/src/paths.rs`·업데이터 설정·설치 GUID는 변경하지 않았다. 시작 시 이미 존재하던 관련 없는 변경·검증 산출물은 커밋에 포함하지 않았다.
