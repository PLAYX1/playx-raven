# RavenVault Desktop 0.8.4 작업 보고

작업 폴더 `/Users/gimmusong/wt-rv-desktop-084`, 브랜치 `claude/rv-desktop-084`. 새 worktree를 만들지 않았고 소스 변경은 이 폴더에만 했다. 참고용 폰/웹 저장소는 읽기만 했다.

## 구현

1. 왼쪽 메뉴의 「더 보기 → 판매 대금 받기」에 전용 화면을 추가했다. 이미 열린 지갑도 기존 비밀번호를 재인증한다. Rust에서 재잠금 → 짧은 잠금 해제 → 계정 파생 → 재잠금 순서로 처리하고, 마지막 재잠금이 실패해도 xpub를 반환하지 않는다. 암호 없는 지갑·니모닉 없는 지갑은 거절한다.
2. 판매 계정은 폰과 같은 `m/44'/175'/100'`, 받기는 `/0/i`다. 폰 core 네 파일을 변경 없이 재사용했다. 실제 렌더러는 공개 파생 코드만 사용하고, seed를 필요로 하는 계정 파생은 Rust 안에서 수행한다. 폰 원본, 가져온 core, Rust가 기존 공개 시험 자료 5개의 같은 xpub를 만드는지 검증했다. 주소 0·1·2·99·100·9999도 비교했다.
3. 번호·QR·처음 받는 주소 3개, 복사를 제공한다. 60초, 화면 이동, 창 포커스 이탈, 문서 숨김, pagehide, 명시적 잠금 시 번호/QR/잔액을 비운다. 세대 번호로 늦은 인증·QR 응답을 버리고, 숨김 이후 잔액 응답도 버린다. 비밀번호 입력창도 이 화면을 떠나거나 포커스를 잃으면 취소·비운다.
4. 기본 받는 주소 100개(0~99)를 폰 core에서 파생한 후 로컬 노드의 읽기 RPC로 확정 금액을 조회한다. 메인넷 동기화·블록 높이·조회 전후 tip·정수 금액·중복 주소를 검사한다. 오류는 「확인 실패」이며 0으로 바꾸지 않는다. 큰 금액은 문자열/BigInt로 정확히 표시한다.
5. 「내 지갑으로 옮기기」는 폰·웹 판매 계정의 주소별 보내기 절차를 안내한다. Desktop에 송금·서명·개인키 가져오기 기능을 추가하지 않았다.
6. 「더 보기 → 게임」의 라비 스토리 카드는 고정 URL `https://ravenvault.ex.erci.se/game/ravi-story`를 Tauri OS opener `openUrl`로 연다. `shell.openExternal`과 같은 기본 브라우저 동작이며 iframe/내장 게임 WebView를 만들지 않는다. URL에 지갑 정보를 붙이지 않는다.
7. package.json/lock, Cargo.toml/lock, tauri.conf.json을 0.8.4로 올리고 CHANGELOG와 릴리스 노트를 갱신했다. 기존 앱 ID·Windows upgradeCode·업데이트 검증키·endpoint·CSP를 유지했다.
8. secfix1 업데이트 정책은 변경하지 않았다. 0.8.4 이상 manifest 준비에는 macOS 두 대상의 서명 명세를 필수로 요구한다. 공개키로 minisign ED 서명·trusted comment·버전·대상·최종 압축본 해시·만료·sequence 형식을 검증한 뒤 `signed_releases`를 넣는다. 자료 누락/변조 시 파일 게시 준비를 중단한다. 공개 후 검증기도 새 명세의 존재·구조·버전/대상/만료를 검사하고 latest/immutable 비교에 포함한다(공개 검증기는 HEAD 조회만 하며 암호학적 서명 검증은 준비 단계와 설치 단계가 맡는다).

## 비밀 정보 경계

실제 사용자 지갑·seed·개인키·암호·`.env` 값을 읽거나 출력하지 않았다. 새 화면은 비밀번호를 인증용 지역 변수와 IPC 요청에만 잠시 사용하고 입력창을 비운다. 복구 단어/seed/개인키는 렌더러나 renderer global에 전달하지 않는다. 비밀 RPC는 고정 allowlist와 고정 오류를 사용하고 기존 RPC 관찰자/로그 경로를 거치지 않는다. Rust의 소유 문자열·JSON·파생 버퍼는 수명 종료 시 덮어쓴다. 네트워크/암호 라이브러리 내부 및 JS immutable string의 모든 임시 메모리가 물리적으로 즉시 지워진다는 보장은 주장하지 않는다.

새 교차 fixture에는 기존 공개 fixture 순번과 공개 xpub/주소만 있다. 단어·seed·개인키·비밀번호를 새 파일로 복사하지 않았다. 서명 검증 시험은 메모리의 일회용 시험 키만 사용하며 키를 파일/출력에 남기지 않는다. 클립보드는 명시적으로 복사한 xpub만 받으며 자동 삭제되지 않을 수 있음을 화면에 안내한다.

## 검증 결과

| 명령 | 결과 | 증거 |
|---|---|---|
| `npm test` | 27 통과, 실패/skip 0 | `desktop-084-npm-tests.txt` |
| `npm run typecheck` | 통과 | `desktop-084-typecheck.txt` |
| `npm run check:pre-release` | 통과: preflight, tsc, Vite, first-run, companion, home 검사 | `desktop-084-pre-release.txt` |
| `cargo check --offline --manifest-path src-tauri/Cargo.toml` | 통과; 기존 unused/dead-code 경고 | `desktop-084-cargo-check.txt` |
| `cargo test --offline --manifest-path src-tauri/Cargo.toml --lib sales_account::tests` | 5 통과 | `desktop-084-native-tests.txt` |
| `cargo test --offline --manifest-path src-tauri/Cargo.toml --lib update_policy::` | 2 통과 | `desktop-084-update-tests.txt` |
| `node --test docs/handoff-1006/secfix1.test.mjs` | 12 통과 | `desktop-084-secfix1-tests.txt` (결과 요약만 저장) |
| `git diff --check` | 통과 | 최종 검사 |
| `node scripts/check-sales-browser.mjs` | **실행 차단: Chrome launch 실패** | `desktop-084-browser.json` |

초기 시험 harness의 모듈 로딩·비동기 대기 문제는 수정하고 재실행했다. 최종 통과 수만 위 표에 적었다. 실제 DOM controller는 모의 DOM/네이티브로 재인증·QR·복사·100주소·오류·blur·시간 만료를 시험했다. 이를 실제 Tauri UI/Chrome 시각 검증으로 간주하지 않았다. home 검사는 기존 CSS 산술 검사이며 브라우저 geometry 검증이 아니다.

## 남은 제한과 대표 확인

- 패키징, 실제 코드/업데이트 서명, 공증, 공개 릴리스, push, 메인넷 거래, 실제 송금은 하지 않았다. 실행 중인 실제 지갑에 연결한 종단 시험도 하지 않았다.
- Chrome 실화면/QR 디코딩/실제 OS 기본 브라우저 실행은 대표의 GUI 환경에서 확인해야 한다. 이번 시험의 브라우저 실행 실패를 통과로 처리하지 않았다.
- 미확정 거래와 주소 100번 이후 금액은 포함하지 않으며 화면에 이를 명시한다. 더 넓은 범위는 폰·웹에서 조회한다. 데스크탑 일반 잔액에 판매 계정이 자동 합산되지는 않는다.
- 비 ASCII 추가 BIP39 암호는 기존 native 정규화 차이 때문에 안전하게 거절한다. 일반 지갑 잠금 비밀번호와는 별개의 제한이다. 기본 12단어/빈 추가 암호 및 기존 공개 fixture의 ASCII 추가 암호는 교차 검증했다.
- secfix1의 Windows/Linux 자동 업데이트 내부 버전 검사 미지원 차단은 유지된다.
- 기존 자동 공개 workflow는 서명 명세 생성 단계가 없으므로 0.8.4 manifest gate에서 멈춘다. 서명 명세를 준비하는 수동 명령과 정확한 서명→공증→메타 검증→업로드 순서는 `release-084.md`에 있다. 기존 워크플로를 사전 시험용으로 실행하면 안 된다.
- 오프라인 npm 의존성 추가는 캐시 부족으로 실패했다. 이후 지정 폴더 안에 기존 설치된 패키지를 복사하고 원본의 고정 버전/lock 항목을 반영해 검증했다. 네트워크를 사용한 깨끗한 `npm ci` 재설치는 이번 환경에서 검증하지 않았다. Vite의 기존 큰 chunk 경고와 Rust 경고는 남아 있다.

## 커밋

`git add`와 `git -c core.hooksPath=/dev/null commit -m 'feat(desktop): add protected sales account and prepare 0.8.4'`를 모두 시도했다. 둘 다 공유 Git 메타데이터의 `index.lock` 생성이 `Operation not permitted`로 거절되어 종료 코드 128로 실패했다. 커밋은 만들어지지 않았고 push도 하지 않았다. 잠금 파일을 삭제하거나 새 worktree를 만들지 않았다.

`docs/handoff/commit-desktop-084.sh`에 브랜치/기존 stage 확인, npm 검증, 정확한 파일 목록, 지정된 hooks 비활성화 커밋 명령을 남겼다. 대표가 Git 메타데이터 쓰기 권한이 있는 환경에서 실행하면 된다. 스크립트는 push·배포·서명을 하지 않는다.
