모델: GPT-6 기반 Codex.

# RavenVault Desktop 0.4.1 — 기존 지갑 보존 및 백업·복원 검증

2026-09-14. 사용자 질문: 기존 PLAY X Raven을 업데이트해도 지갑·백업이 유지되는가?

## 결론과 확인 범위

업데이트 후 표시 이름은 RavenVault Desktop이지만, 앱 식별자 `se.erci.ex.playx.raven`, 실행 파일 `playx-raven`, 앱 자료 폴더 `PlayXRaven`, 기존 Ravencoin 자료 위치 선택 방식, 업데이트 공개키와 기존 업데이터 주소를 유지한다. `src-tauri/src/paths.rs`는 변경하지 않았다. 이름 변경 때문에 새 지갑을 만들거나 복원할 필요는 없다.

이것은 소스·설치 프로그램 구성·합성 자료에 대한 검증 결과다. 사용자의 실제 지갑, 백업 열쇠, 복구 단어, 고객 자료를 읽거나 옮기지 않았으며, 사용자 컴퓨터의 설치된 앱에 실제 업데이트·복원을 실행하지 않았다. 따라서 모든 기존 설치 환경에서 무조건 문제가 없다고 보증하지 않는다.

새 PWA는 별도의 브라우저 저장소를 쓴다. Desktop 지갑이 새 웹앱으로 자동 이동하지 않는다. 기존 웹 지갑은 `https://rvn.ex.erci.se/wallet`에 유지한다.

## 발견한 문제와 수정

기존 코드에서는 노드의 `backupwallet` 요청 실패 후에도 지갑이 없는 ZIP이 백업 완료로 표시될 수 있었다. 파일 읽기/압축 실패를 건너뛰고, 암호화 백업의 실제 확장자를 제대로 회전하지 않거나 새 백업 완료 전에 이전 자료를 정리하는 경로도 있었다. 복원은 RPC 연결 실패를 노드 종료로 오해할 수 있었으며, 부분 실패를 전체 완료로 표시하는 경로가 있었다.

수정본은 요청한 지갑이 빠지면 실패하고, 포함 파일과 암호화 결과를 확인한 후에만 완료를 표시한다. 새 백업을 별도로 작성한다. 실패하면 기존 최신·이전 두 세대를 보존하며, 성공하면 새 최신과 종전 최신의 두 세대로 회전한다. 완료된 로컬 폴더 백업은 최근 일곱 세대를 남긴다. 폴더 백업은 기존 폴더에 섞어 쓰지 않고 새로운 완결된 세대로 저장한다. 같은 날 검증된 자동 백업을 반복해서 회전하지 않는다.

지갑 파일 복원은 실제 노드와 호환되는 OS 파일 잠금을 확보해야 진행한다. 입력·원본 보존본을 확인하고 교체 시점에 실제로 덮이는 원본까지 별도 경로에 남긴다. 일부만 복원됐거나 교체 후 검증이 실패하면 전체 완료라고 표시하지 않고 이전 파일 위치를 보여준다.

## 변경 파일과 이유

| 파일 | 이유 |
| --- | --- |
| `src-tauri/src/backup.rs` | 지갑 누락 거부, 개별 파일/압축/암호화 검증, 독립 백업 세대, 실제 완료 뒤 상태 갱신과 보관 정책 |
| `src-tauri/src/backup_storage.rs`, `src-tauri/src/lib.rs` | 격리된 임시 폴더, 백업 대상 동시 접근 차단, 기존 암호화 파일 보존·실패 복구 |
| `src-tauri/src/lockbox.rs` | 기존 열쇠 읽기 실패 시 재생성 금지, 암호 정보만 남은 상태 차단, 잘못된 암호화 포맷의 패닉 방지; 기존 포맷 유지 |
| `src-tauri/src/recover.rs`, `src-tauri/src/restore_lock.rs` | 실제 노드 잠금·복원 작업 배타성, 입력 검증, 고유한 이전 파일 보존, 최종 교체 경쟁·부분 실패 보고 |
| `src-tauri/src/moving.rs` | 부분 복원 실패를 이사 완료로 반환하지 않음 |
| `src/backup-result.ts`, `src/main.ts` | 결과 조건에 따른 완료 표시, 오류·파일명 HTML 이스케이프, 자동 백업 실패 노출, 이전 파일 위치와 폴더 복원 선택 |
| `index.html`, `src/desktop-copy.ts` | 한국어·영어·일본어·중국어 백업 범위/열쇠 안내, 검증되지 않은 직접 이사 버튼 비활성화 |
| `package.json`, `package-lock.json`, `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml`, `src-tauri/Cargo.lock` | 0.4.1 버전 일치, OS 잠금/교체 API 의존성 선언 |
| `scripts/release-manifest.mjs`, `.github/workflows/release.yml` | 배포 설명, 네 플랫폼의 합성 백업·암호화·복원 검사 통과 후에만 게시 |
| `scripts/verify-published-release.mjs`, `scripts/verify-published-release.test.mjs` | 캐시 갱신을 최대 15분 기다린 뒤 마지막 20초 조회; 기존 workflow의 `verify_only`에서는 앱 빌드/서명/게시 없이 공개 자료만 확인 |
| `scripts/check-backup-result.mjs`, `scripts/check-backup-safety.mjs`, `scripts/fixtures/backup-safety.rs` | 실제 명령과 UI 경계에서 누락·불완전·실패 결과를 재현 |
| `scripts/verify-backup-storage.mjs` | 실제 저장/암호화 코드의 실패 주입·옛 포맷 호환·결함 탐지 검증; Windows CRLF 정규화 |
| `scripts/check-backup-ui.mjs` | 실제 번들 화면을 네 언어로 검증; native 명령은 모두 합성 응답으로 대체 |
| `qa/restore-safety/{Cargo.toml,Cargo.lock,build.rs,run.py,README.md,.gitignore,src/lock-peer.rs,tests/restore.rs,results/mutation-summary.json}` | 실제 앱/지갑을 실행하지 않는 복원·별도 프로세스 잠금·오류 주입 하네스와 근거 |
| 웹 worktree의 `release-site/download/{index.html,download.js}` | 업데이트 전 확인, Desktop 백업 제외 항목, USB 복원 안내를 네 언어로 게시 |

전체 Desktop 수정 파일 목록은 커밋 `7d20a42a83cdef451a265c32e6a4503eaa96c7c8`과 검사 줄바꿈 수정 `2111422`에 있다. 원본 main은 수정·병합하지 않았다.

## 실행한 검사

모든 자료는 지정된 테스트 폴더에 만든 합성 자료다. 전체 기존 Cargo 테스트는 실행하지 않았다.

| 명령 | 로컬 결과 |
| --- | --- |
| `NODE_OPTIONS=--max-old-space-size=8192 npx tsc --noEmit -p tsconfig.json` | 통과 |
| `npx esbuild src/main.ts --bundle --platform=browser --outfile=/dev/null` | 통과 |
| `npm run build` | 통과. 기존 Vite 번들 크기 경고는 남아 있음 |
| `cargo check --tests --offline --manifest-path src-tauri/Cargo.toml` | 컴파일 통과. 실제 기존 테스트/앱 실행 없음; 기존 미사용 코드 경고 있음 |
| `node scripts/check-backup-safety.mjs` | 실제 명령의 지갑 누락 거부 + 합성 테스트 14개 통과 |
| `node scripts/check-backup-safety.mjs --baseline` | 수정 전 코드에서 실제 assertion 실패, exit 1 |
| `node scripts/check-backup-safety.mjs --mutant-omission` | 결함을 다시 넣으면 실제 assertion 실패, exit 1 |
| `node scripts/verify-backup-storage.mjs` | Mac 저장 9개·암호화 8개 통과, 6종 의도적 회귀는 실제 assertion 실패/exit 1로 탐지 |
| `cargo test --locked --manifest-path qa/restore-safety/Cargo.toml -- --test-threads=1` | Mac 23개 통과 |
| `python3 qa/restore-safety/run.py --offline --verify-mutations` | 전용 worktree에서 5종 의도적 결함을 assertion 실패/exit 1로 탐지, 정상 23개 재통과 |
| `node scripts/check-backup-result.mjs` 및 `--mutant-omission` | 정상 통과, 결함 삽입은 exit 1 |
| `node scripts/check-backup-ui.mjs` | 실제 번들 네 언어 화면에서 누락 거부·부분 복원·이전 경로·오류 이스케이프·폴더 선택 통과 |
| `node scripts/check-desktop-integration.mjs` | 앱 신원·저장 경로·기존 기능 소스 보존·번역 검사 통과 |
| `node --test scripts/release-manifest.test.mjs scripts/desktop-installer-identity.test.mjs` | 7개 통과 |
| `node --test scripts/verify-published-release.test.mjs` | 9개 통과. HEAD 누락 검사를 제거한 `node scripts/verify-published-release.test.mjs --mutant-head`는 실제 assertion 실패/exit 1 |
| Ruby YAML 파싱 및 verify-only job 조건 확인 | 통과. build가 skip되면 needs:build인 publish도 실행되지 않음 |
| `git diff --check` | 통과 |
| 웹 `node release-site/landing/tests/landing.test.mjs`, `node --check release-site/download/download.js` | 통과 |
| 웹 `node artifacts/release-qa/check-download-backup-ui.mjs` | 네 언어 선택 후 재열기·설치 안내·390px 가로 넘침 0 통과. `--missing-backup-copy`로 제외 안내를 제거하면 실제 assertion 실패/exit 1 |

첫 배포 실행 `34772478676`은 Mac 두 종류와 Linux 빌드는 통과했지만 Windows에서 검사 도구의 CRLF 정규식 때문에 실패했다. 게시 단계는 실행되지 않았다. 검사 도구만 수정해 `34772777228`에서 재검증했다. 네 플랫폼 모두 백업 14개, 저장/암호화 회귀 모음, 복원(Mac·Linux 23개, Windows 21개), 배포/설치 신원 7개 검사를 통과하고 설치 파일을 생성했다. Windows는 Unix 전용 항목을 제외한다. 게시 push도 성공했으나, 게시 직후 GitHub 캐시가 이전 manifest를 반환하여 마지막 공개 조회 단계가 실패했다. 그 뒤 같은 공개 파일을 재작성하지 않고 아래 외부 검사를 모두 통과시켰다.

## 실화면·실패 증거

- [수정 전 실패 로그](/Users/gimmusong/wt-ravenvault-desktop/artifacts/backup-baseline.log), [수정 후 백업 검사](/Users/gimmusong/wt-ravenvault-desktop/artifacts/backup-final.log)
- [암호화/저장 검사와 의도적 결함 탐지](/Users/gimmusong/wt-ravenvault-desktop/artifacts/backup-storage-crlf-fix.log), [복원 검사](/Users/gimmusong/wt-ravenvault-desktop/artifacts/restore-final.log)
- [네 언어 Desktop 계측값](/Users/gimmusong/wt-ravenvault-desktop/artifacts/backup-ui/ui-measurements.json): 1120px 창에서 가로 넘침 0, 주요 버튼 높이 64px/글자 16px
- [한국어 백업 결과 화면](/Users/gimmusong/wt-ravenvault-desktop/artifacts/backup-ui/backup-complete-ko.png), [부분 복원 실패 화면](/Users/gimmusong/wt-ravenvault-desktop/artifacts/backup-ui/restore-partial-ko.png)
- 웹 증거는 `/Users/gimmusong/wt-ravenvault-resilience/artifacts/release-qa/download-backup-local/`에 있다. 390px에서 모든 언어 가로 넘침 0, 본문 15px 이상, 누를 곳 44px 이상을 확인했다. 이 로컬 화면은 아직 공개 전인 0.4.1 안내와 당시 공개 버전 0.4.0을 함께 보여 준다.
- Desktop 화면의 native 호출은 전부 모의 응답이다. 브라우저 통과를 실제 Tauri 설치/지갑 복원 통과로 표현하지 않는다.

## 사용자에게 필요한 절차

1. 기존 앱에서 별도 백업을 만들고 포함 목록에 `wallet.dat`이 있는지 확인한다. 백업 파일과 백업 암호 또는 종이에 적은 백업 열쇠를 보관한다. 이 열쇠는 지갑 복구 단어와 다르다.
2. 기존 Desktop의 업데이트 확인 기능을 사용한다. 앱 이름 변경을 이유로 지갑을 초기화하거나 복원할 필요는 없다.
3. 업데이트 후 새 백업을 만들어 검증 완료와 지갑 포함을 확인한다. 이미 보관한 이전 백업은 별도로 남겨 둔다.

## 안 한 것

사용자 앱 업데이트, 사용자 지갑·열쇠 열람, 실제 자금 이동·자산 발행, 실제 노드/채굴기/IPFS 실행, 원본 main 통합을 하지 않았다.

## 이번에 해결하지 못한 것

기존 컴퓨터 간 직접 이사 프로토콜의 암호 전달·호환성 문제는 재설계하지 않았다. 관련 버튼을 비활성화하고 암호화 백업 파일의 USB 이동·복원 경로를 안내한다. 원래의 노드·가게·채굴·IPFS·자산 판매/경매 전체를 새로 검증하거나 완성했다고 주장하지 않는다.

## 확인 못 한 것과 기술적 한계

- 실제 사용자의 OS/설치 버전과 지갑 자료를 이용한 설치 전후 동작은 확인하지 않았다.
- Mac Intel 바이너리는 Apple Silicon 러너에서 교차 빌드한다. 실제 Intel Mac 실행 확인은 별도다.
- 파일 바이트와 이전 포맷 호환은 검증했지만 실제 wallet 데이터베이스의 유효성은 노드가 시작할 때 확인해야 한다.
- 파일 시스템 잠금·교체를 지원하지 않는 환경은 실패 처리한다. 실제 전원 차단, 저장장치 고장, 같은 OS 계정의 악성 프로그램에 대한 보장을 하지 않는다. Windows 교체 API는 전원 차단 시 트랜잭션 보장을 제공하지 않는다.
- USB 등의 파일 시스템은 Unix 권한/Windows ACL을 제공하지 않을 수 있다. 암호화 백업을 권장하며, 기존의 평문 폴더 백업은 암호화됐다고 표시하지 않는다.
- 클라우드 동기화 폴더에 저장 성공은 클라우드 업로드 완료 증거가 아니다.
- Desktop 백업은 요청한 `wallet.dat`과 존재하는 지정 JSON 9개(`shop.json`, `shopkey.json`, `tickets.json`, `bookings.json`, `passes.json`, `sessions.json`, `orders.json`, `fills.json`, `sweep.json`)를 담는다. 앱 자료 폴더 전체 백업이 아니다. 대화 계정 열쇠 `talkkey.json`과 대화 자료, PWA/브라우저 지갑·파일, IPFS 원본, AI API 키 등은 제외되므로 별도 보관이 필요하다.
- 현재 복원 대상은 선택된 Ravencoin 자료 폴더의 `wallet.dat`이다. 이름 있는 지갑·여러 지갑·별도 `walletdir` 환경의 자동 백업/복원은 검증하지 않았으며 해당 환경에 이 자동 복원을 사용하도록 권하지 않는다. 업데이트가 기존 자료 위치를 유지한다는 결론과, 모든 형태의 지갑 자동 복원을 지원한다는 주장은 다르다.
- Mac Developer ID 공증과 Windows 게시자 인증 상태는 이번 백업 수정과 별개이며, 설치 안내에 기존 상태를 유지한다.

## 공개 확인

**0.4.1 공개 완료.** 실제 앱 소스는 `2111422934ffff79b2d438bb7e6a7a7085d7ac16`, 공개 파일 저장소 `dist` 커밋은 `987023d20cb13c8e6a9f1cb3e85effa7872e4322`다. [빌드·게시 실행](https://github.com/PLAYX1/playx-raven/actions/runs/34772777228)은 네 빌드와 게시 push가 성공했고, 마지막 50초 안의 캐시 갱신 확인만 실패했다. 아래 확인을 별도로 수행했으므로 이 실행 전체를 녹색 통과했다고 보고하지 않는다.

- 공개 설치/업데이트 파일 7개를 실제로 받아 고정된 공개 커밋의 SHA256SUMS와 대조했다. 네 플랫폼 업데이트 서명을 실제 Tauri 공개키로 검증했고, 각각 한 바이트를 바꾼 복사본은 exit 1로 거부됐다. 다운로드 파일을 실행하지 않았다.
- 공개 전후 Git 트리를 비교해 이전 버전 파일 33개의 Git blob 신원이 모두 유지됐음을 확인했다. 합성 트리에서 한 파일을 변경하면 검사에서 assertion 실패/exit 1로 거부됐다.
- 기존 `rvn.ex.erci.se`와 새 `ravenvault.ex.erci.se`의 네 플랫폼 모두 **0.3.8 및 0.4.0 → 0.4.1**, **현재 0.4.1 → HTTP 204**를 확인했다. URL과 서명은 공개 manifest와 일치한다. 잘못된 기대 버전 0.4.2는 실제 assertion 실패/exit 1로 거부됐다.
- 설치 안내는 [ravenvault.ex.erci.se/download](https://ravenvault.ex.erci.se/download/)에 반영했다. 웹 배포는 `ravenvault-fxtfz5tm2-playx1s-projects.vercel.app`이다. PWA revision `df289911fe9476aa487d`와 오프라인 준비 파일 208개는 그대로다.
- 공개 웹 경로 14/14 통과. 실제 공개 설치 화면에서 네 언어 모두 0.4.1, 언어 선택 후 재열기 유지, 포함/제외/고급 지갑/USB 안내를 확인했다. 390px 가로 넘침 0, 본문 17px, 설치 버튼 최소 높이 60px, 언어 선택 높이 52px/글자 16px.

공개 증거는 `/Users/gimmusong/wt-ravenvault-resilience/artifacts/release-qa/desktop-public-0.4.1/{verified.json,updaters.json}`, `download-backup-live/measurements.json`, `download-backup-live/download-ko-390.png`, `backup-live-check.log`에 있다.


후속 배포 검사 보완 커밋은 `d479691`이다. 이 커밋은 앱 코드·버전을 바꾸지 않는다. 이미 공개한 설치 파일의 실제 빌드 소스는 위 `2111422` 그대로이며, 후속 workflow를 공개된 자료를 읽기만 하는 `verify_only` 모드로 실행했다. [검사 전용 실행 34774207898](https://github.com/PLAYX1/playx-raven/actions/runs/34774207898)이 성공했다. 합성 검사 9개와 공개 메타데이터·7개 파일 HEAD 확인이 통과했고, build/publish job은 실제로 모두 skipped임을 확인했다. 로그는 `artifacts/backup-ci-public-verification.log`, 상태는 `artifacts/backup-ci-verify-only.json`에 있다.
