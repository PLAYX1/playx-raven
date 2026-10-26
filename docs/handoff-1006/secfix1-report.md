# secfix1 보안 수정 인계

- 작업일: 2026-10-07. 브랜치 `claude/secfix1`, 기존 worktree `/Users/gimmusong/wt-rv-secfix1`만 수정.
- 기준 커밋: `ced2bdaa50402ea2928fbfb592b13ac96b35c17d` (`claude/desktop-simple`). 새 worktree를 만들지 않았다.
- `audit-fable.md` 334줄과 `audit-astra.md` 425줄을 모두 읽고, 아래 원래 위치의 실제 소스와 호출 경로를 확인했다. 두 감사 보고서는 수정하지 않았다.
- 배포·push·실송금·메인넷 쓰기를 하지 않았다. 실제 지갑 저장소·시드·키·암호·`.env` 값을 읽거나 복사하지 않았다. 시험은 합성 데이터/모의 RPC를 사용했다. 출력에는 사례 이름·결과만 남기고 실패 assertion의 값/소스 덤프는 제거했다.
- **전체 완료/전체 시험 통과로 판정하지 않는다.** 별도 PWA 소스와 pdfjs 의존성은 이 worktree에 없고, OS·브라우저 실동작 시험 일부는 환경 제한으로 미검증이다.

## 사실 확인과 처리

| 항목 | 원래 근거와 재확인 | 처리/판정 |
|---|---|---|
| H1 / Astra F04 금고 | `web/wallet.src.ts:55,59,339,3031,3057,3591`, `web/wallet.html:700` 확인. 공개 상수로 무잠금 금고를 쓰고 자동으로 열었으며 KDF는 210,000회였다. **숫자만 허용하는 정규식은 없었다.** 실제 검사는 6자 이상이고 키보드가 숫자용이었다. | 신규 무잠금 저장/버튼 제거. 문자와 숫자 또는 기호를 섞은 12~256자 암호, PBKDF2-SHA256 600,000회. PRF 기기 인증 경로 유지. v1 읽기→v2 새 봉인→복호 왕복 검증→원자적인 localStorage 교체. 구형 무잠금/약한 암호는 이전 화면으로만 진입. 실패/다른 탭 변경 시 원본 보존. |
| H2 서명 | `wallet.src.ts:435-470,596-628` 확인. 입력 script만 검사하고 금액은 서버 제공값을 믿었다. **1 RVN 상한 상수는 원래 존재했다.** 문제는 상한 계산의 입력합이 미검증이라는 점이다. PWA의 `validatePublicCoin`, `verifyRvnInputs`를 읽어 동일 검증 원칙을 적용했다. | `/api/chain/coin`의 원거래로 txid 재계산, vout·금액·script·소유 주소 대조. 중복 입력/안전정수/200개 상한 검사. 검증된 합으로 실제 수수료를 구하고 승인된 수수료와 일치 및 1 RVN 절대 상한을 서명 전에 확인. 확인 화면에 상한 명시. 원거래를 못 받으면 서명하지 않는다. |
| H3 cloudflared | `tunnel.rs:613-690`의 latest 다운로드→압축 해제→실행을 확인. 앱 관리 경로의 기존 파일도 우선 실행했다. | **자동 설치 차단으로 완화. 대표 확인 필요.** 고정 버전/공식 플랫폼별 체크섬을 확인하지 못했으므로 값을 만들지 않았다. 다운로드·압축 해제·시험 실행 코드를 제거하고 설치 명령은 오류를 반환한다. 과거 앱 다운로드 경로와 임의 PATH 검색도 제거. 알려진 OS 패키지 관리자/관리자 설치 위치의 수동 설치만 탐지한다. 수동 설치 파일의 독립 해시 검증은 미구현이다. |
| H4 / Astra F05 전달 무결성 | 별도 감사 작업본의 `scripts/pwa-worker-template.js`, `phone/web/Pwa.tsx`, `release-site/check-integrity.mjs`를 읽어 캐시 우선·수동 활성화·운영자 CLI 검증임을 확인. **해당 디렉터리는 지정 worktree에 없다.** | 로컬 브라우저 지갑에 한해 빌드 해시 매니페스트, 실행 전 전체 script 해시 확인, 실행 응답 SRI, 주기/전경 복귀 재검증 및 실패 시 잠금/경고를 추가했다. 외부 script 금지 CSP 유지. **공개 PWA에는 미적용이며 H4 전체 해결 아님.** 별도 저장소를 변경/복사하지 않았다. |
| Astra F01 데스크톱 중복 송금 | `main.ts:8883,8907,8979`, `send.rs:235,288`, `raven.rs` 결과 미확인 경로 확인. 오류 후 새로운 지급 RPC가 다시 가능했다. | UI 재진입 방지와 승인 객체/요청 ID 고정. Rust에서 송금 전에 영속 exclusive intent 기록. 오류·응답 유실·크래시는 잠금 유지. 성공 receipt를 저장하고 같은 ID 재시도는 결과만 재사용. UI가 성공 결과를 받은 뒤 `send_ack`로 잠금 해제한다. 그 전에 재시작하면 새 ID도 차단한다. |
| Astra F02 개발비 중복 정산 | `devfee.rs:49,354,385,402,416` 확인. RPC 이후 장부 갱신, 저장 오류 무시였다. | 정산 RPC 전에 영속 잠금. 오류·빈/잘못된 txid·장부 저장 실패 시 후속 지급 차단. 장부는 임시 파일(Unix 0600)→write/fsync→rename→부모 디렉터리 fsync. 최종 저장 오류 전달. 환불 차감에도 장부 mutex 추가. 정산 1회 1,000 RVN 상한. 기존 자동 정산 주기는 유지되지만 미확인 상태에서 재송금하지 않는다. |
| Astra F03 주문 중복 전달 | `main.ts:12828,12836`, `vending.rs:116,148,166` 확인. 원격 완료 기록 실패와 자산 지급이 분리돼 있었다. | 로컬 결제 주소·금액·txid:vout를 필수로 받아 Core의 확정 수/수금/거래 detail을 대조. 지급 조건을 영속 receipt에 결합한다. 동일 결제 출력/동일 조건은 기존 txid만 반환, 조건 변경이나 미확인 전송은 거부. **로컬 증빙을 넘기지 않는 원격 웹 주문 전달은 차단**된다. 원격 주문 서버 연계 복구는 남은 작업이다. |
| Astra F06 업데이트 재생 | `lib.rs:116`, `main.ts:2295,2331` 및 설치된 updater 2.10.1 소스의 원격 버전 비교와 별도 패키지 서명 검증 경로를 확인. 서명된 버전/해시 결합은 없었다. | **앱 내 업데이트 설치 차단으로 완화.** Rust updater 등록·기본 capability 제거, UI 설치 경로 제거 및 수동 설치 안내. 서명된 메타데이터/최소 버전 정책과 OS별 재생 거절 시험은 미구현. 이를 완전한 재생 방어 구현으로 표현하면 안 된다. |
| M 페어링 한도 | `pairing.rs:137` 상한 1,000,000 RVN 확인. 기존 기본값은 이미 `desktop`, 0 RVN이었다. | 기본값은 그대로 유지. 신규 상한 1,000 RVN. 기존 저장값을 삭제/변경하지 않고, 초과 설정의 자동 송금 유효 한도는 0으로 처리. 새 요청과 잠금 해제 대기 재시도 모두 적용. 화면에 초과 설정 재연결 안내. |
| M Windows 복구 | `words_restore.rs:562-600`의 실제 임시 conf 쓰기 경로 확인. | Windows 파일 fallback 거부를 복구 흐름 시작 전과 실행 직전에 적용. 해당 파일 쓰기 분기 제거. UI의 임시 파일 선택 제거. Unix FIFO와 Windows 이름 있는 파이프는 유지. Windows 실기기 확인은 미실행. |
| M pdfjs-dist | 별도 `phone/package.json`에 5.6.205가 있음을 확인. 지정 worktree의 package/lock에는 pdfjs-dist가 없다. | **미수정.** 이 브랜치에 무관한 의존성을 추가하거나 다른 저장소를 수정하지 않았다. PWA/폰 브랜치에서 업그레이드와 PDF 회귀 시험이 필요하다. 최신 취약점 DB 조회/업그레이드 성공을 주장하지 않는다. |

## 변경 위치

- 금고/서명: `web/wallet.src.ts`의 `strongPassword`, `storeVerifiedVault`, `requireVaultUpgrade`, `verifiedInputSum`, `assertFee`, `fetchInputTransactions`, `buildAndSign`. UI `web/wallet.html` 및 생성된 `web/wallet.bundle.js` 갱신.
- 무결성: `web/wallet-integrity.js`, `web/wallet-integrity.json`, `scripts/build-wallet-integrity.mjs`, `web/build.sh`, `src-tauri/src/server.rs`. `preflight.mjs`가 manifest의 stale 상태를 거부한다.
- 영속 지급: `src-tauri/src/payout_guard.rs`, `send.rs`, `devfee.rs`, `vending.rs`, `src/main.ts`. 지급 기록에는 공개 지급 조건/txid만 포함하며 암호·시드·개인키는 기록하지 않는다.
- 정책/차단: `tunnel.rs`, `pairing.rs`, `pairing/proto.rs`, `pairing/desk.rs`, `pairing/net.rs`, `src/pairing-ui.ts`, `words_restore.rs`, `src/words-restore.ts`, updater 등록/capability.
- 기존 시험 2개 갱신: 송금 시험 VM에 새 무결성 상태를 주입. 데스크톱 통합 시험의 구형 지갑 파일 byte-for-byte 동결만 새 보안 회귀 시험으로 대체하고 다른 Core 동작/식별자 비교는 유지.

## 시험과 증거

실제 노드의 RPC는 호출하지 않았다. 기존 Rust lib 시험은 원래 `#[cfg(test)]`에서 live RPC를 거절하며 전용 합성 경로를 사용한다.

| 시험 | 결과 | 증거 |
|---|---|---|
| 항목별 수정 전 회귀 시험 | 실패를 먼저 기록 | `red-node.txt`, `red-integrity.txt`, `red-rust.txt` |
| 새 Node 회귀 | 12/12 통과, exit 0 | `green-node.txt`, `secfix1.test.mjs` |
| 실제 원거래 검증/서명 연결 | 변조 금액·script·txid·중복 입력·초과 수수료에서 signer 호출 0, 정상 1 | 위 Node 시험 |
| 금고 이전 | 약한 암호 거부, 210k 구형/600k 신형 왕복, 저장 실패 원본 보존, 레거시 무잠금의 자동 사용 거부 | 위 Node 시험. 시험용 비밀은 메모리에만 생성 |
| 영속 지급 파일 | 응답 유실/재시작/중첩 요청/저장 실패/조건 변경/성공 후 UI ack 전 크래시 차단, Unix 0600 | `green-rust.txt`, `payout-guard-tests.rs` |
| 실제 지급 함수 모의 실행 | `send_rvn`, `fee_pay`, `fulfil_sale` 소스에서 함수를 추출해 Rust로 실행. 모의 접수 1회, 실패 후 추가 접수 차단, 동일 주문 결과 재사용 | `payout-harness-results.txt`, `run-payout-harness.py` |
| 데스크톱 tsc | exit 0. 출력 오류/OOM 없음 | `tsc.txt`, 최종 `build.txt` |
| 브라우저 지갑 별도 strict tsc | exit 0. 루트 tsconfig가 web을 제외하므로 별도 확인 | `web-tsc.txt` |
| 웹 번들/무결성 빌드 | exit 0 | `web-build.txt` |
| npm run build | 최종 exit 0. preflight → tsc → Vite 완료. 크기 경고만 있음 | `build.txt` |
| 기존 Rust 전체 lib | **757 통과, 7 실패, 13 ignored; exit 101** | `cargo-test-final.txt` |
| 기존 JS 검사 52개 묶음 | **39개 통과, 13개 미통과/미검증** | `existing-final.json`; 최초 `existing-tests.json`; 보완 `existing-direct.json`, `backup-safety-result.json` |
| 기존 backup production 모듈 | 15/15 통과 | `backup-safety-result.json` |

Rust 실패 7건은 AI mock/endpoint, peers, relay, server bind/wallet loopback, upload의 **로컬 리스너 바인딩 EPERM**이다. 시험 무시로 통과 수를 만들지 않았다. 13 ignored는 원래 제외된 시험이다. GUI 검사도 Chrome 실행/리스너 제한을 만났으며 일부 재실행은 시험 경로 어댑터 문제로 종료됐다. UI 실증 성공으로 집계하지 않았다. 초기 의존성 공유 폴더에 xlsx가 없어 tsc가 실패했으나, worktree 내부 node_modules에서 기존 설치본을 읽는 링크로 해결했고 최종 tsc와 전체 빌드가 성공했다. 의존성 버전/lock 변경은 없다.

검사 산출물을 한곳에 두기 위해 `run-existing.mjs`, `run-existing-direct.mjs`, `test-paths.cjs`에서 **시험 실행에만** 경로를 조정했다. 원본 시험의 assertion을 건너뛰지 않았다. 해당 어댑터 한계가 있는 실행은 미검증으로 남겼다. 생성한 합성 지갑/키 파일·임시 profile·컴파일 캐시는 인계물에서 제거했다.

### 재실행

```sh
bash web/build.sh
node --test docs/handoff-1006/secfix1.test.mjs
CARGO_MANIFEST_DIR="$PWD" rustc --edition=2021 --test docs/handoff-1006/payout-guard-tests.rs -o docs/handoff-1006/guard-tests
docs/handoff-1006/guard-tests
CARGO_TARGET_DIR="$PWD/docs/handoff-1006/cargo-target" python3 docs/handoff-1006/run-payout-harness.py
NODE_OPTIONS=--max-old-space-size=8192 npm run build
RV_BACKUP_FIXTURE_ROOT="$PWD/docs/handoff-1006/fixtures" CARGO_TARGET_DIR="$PWD/docs/handoff-1006/cargo-target" cargo test --offline --manifest-path src-tauri/Cargo.toml --lib
```

실운영 경로를 시험 fixture로 지정하지 말 것. 마지막 전체 시험은 로컬 포트 바인딩과 실제 브라우저를 허용한 별도 시험 환경에서 다시 수행해야 한다.

## 서비스워커 갱신 정책과 무결성 한계

1. 이 브랜치의 로컬 지갑은 매니페스트/번들을 `no-store`로 읽고 해시 검증 뒤 SRI로 실행한다. 빌드 시 6개 실행 스크립트의 해시를 생성한다. 60초마다 및 전경 복귀 때 재검증하며, 실패하면 메모리 지갑 상태를 잠그고 화면을 경고로 교체한다. 네트워크 단절도 검증 실패로 취급해 가용성이 줄어든다.
2. 공개 PWA의 서비스워커는 별도 브랜치다. 기존 캐시 우선/사용자 활성화 정책을 이번 커밋으로 바꾸지 못했다. PWA 수정 시 HTML·매니페스트·worker·번들을 한 버전으로 묶고, 설치 중 모든 해시 확인에 성공한 경우에만 새 캐시를 완성해야 한다. 활성화 때 이전 shell 캐시만 정리하고 지갑 IndexedDB/localStorage는 지우지 않아야 한다. 보안 강제 갱신은 지갑 잠금→worker 활성화→재로드 순서 및 미방송 거래 보존을 실제로 시험해야 한다. **이 문단의 PWA 정책은 후속 구현 기준이며 현재 구현됐다는 뜻이 아니다.**
3. 로컬 `wallet-boot.js`에도 `/sw.js` 등록 시도가 있으나 이 worktree에는 해당 서비스워커 구현/라우트가 없다. 이를 PWA 캐시 보호가 된 근거로 사용하지 않는다. 공개 PWA의 캐시 청소·긴급 활성화 실동작도 미검증이다.
4. HTML·검증기·매니페스트가 모두 같은 서버에서 온다. 서버/배포 권한 탈취자가 셋을 함께 바꾸는 공격, 악성 확장, 이미 실행된 악성 코드에는 독립적인 신뢰 기준이 아니다. SRI와 해시는 잘못된/변조된 개별 산출물·캐시 혼합 탐지에 유용하지만 **서버 침해로부터 시드가 안전하다고 주장할 수 없다.**

## 배포 전 영향과 남은 위험

- **대표 검토 후 수동 배포만.** 이 작업에서는 배포/push를 수행하지 않았다. 자동 업데이트와 cloudflared 자동 설치가 중지되는 제품 동작 변경을 먼저 확인해야 한다.
- 구형 무잠금/약한 암호 사용자는 첫 진입에 새 암호 또는 PRF 인증 설정이 필요하다. 실패/취소 때 기존 암호문은 남는다. 이전 암호문이 이미 외부로 복사됐다면 새 암호화가 그 사본을 회수하지 못한다. localStorage 디스크 흔적의 안전 삭제도 보장하지 않는다. 저성능 폰/PWA·실제 패스키·다중 탭·전원 차단 마이그레이션은 추가 실기기 시험 대상이다.
- 원거래 조회를 제공하지 않는 Electrum/Blockbook fallback, 미동기/색인 없는 로컬 노드에서는 이제 보내기가 거부될 수 있다. 서명 안전을 위해 허용하지 않았다. 원거래 검증은 블록 포함/헤더 체인/SPV/미사용 여부의 독립 합의 검증이 아니다.
- 미확인 지급은 `<앱 자료>/payouts/`의 lane별 `.pending`으로 보류된다. 기록 상태 검사/ack 경쟁은 프로세스 간 `.guard` 파일로 직렬화하며, 그 짧은 구간의 크래시도 보수적으로 보류될 수 있다. 파일이 남았다는 이유로 실패 거래라고 단정하면 안 된다. **자동 삭제/자동 재송금 UI는 만들지 않았다.** 대표가 노드 내역과 의도/receipt를 대조한 뒤 복구해야 한다. 전체 exactly-once 정산 시스템·자동 reconciliation·재조직 대응을 완성한 것은 아니다. 보수적으로 무관한 후속 지급까지 차단할 수 있다.
- 기존 버전에서 이미 발생한 미확인 송금/개발비 정산/주문은 새 기록이 없다. 업데이트 전에 대표가 기존 거래와 장부를 대조해야 한다. 새 코드가 과거 중복 여부를 소급 판별하지 못한다.
- 기존 수동 판매 UI에는 로컬 결제 outpoint를 연결했으나 원격 웹 주문은 증빙이 없어 보류된다. 원격 서버의 완료 기록 재시도만 구현해 판매를 다시 열면 안 된다. 온체인 증빙·주문 ID·상품 조건의 신뢰할 수 있는 연결이 선행돼야 한다.
- 초과 페어링 한도 설정은 저장값을 보존하지만 자동 송금은 막는다. 해당 기기는 데스크톱에서 연결 해제 후 1,000 RVN 이하로 다시 승인해야 한다. 기본 `desktop`/0 설정은 바뀌지 않는다.
- 개발비 장부는 원자 쓰기를 적용했지만 기존 f64 회계 표현과 모든 적립 호출자의 오류 전달 구조를 전면 개편하지 않았다. 로컬 장부 변조에 대한 암호학적 증명은 없다. 일반 적립 저장 실패는 고정 오류 로그로 표시하며 end-to-end 정산 복구 UI는 남았다. Windows 디렉터리 fsync/ACL/전원 차단 내구성은 미검증이다.
- 자동 업데이트 재생의 구조적 해결(서명된 버전·해시·플랫폼·만료/최소 허용 버전), cloudflared 공식 고정 해시 검토, 별도 PWA 무결성 및 pdfjs 업그레이드는 남았다. Astra의 중간 항목 전체와 새 게임 실결제는 이번 범위의 완성물로 주장하지 않는다.
- 이 결과는 내부 수정/로컬 시험이며 독립 보안 인증이나 운영 배포물 검증이 아니다. **현재 상태에서 “높음 항목 전부 해결”, “기존 시험 전부 통과”, “Core보다 안전”이라고 보고하면 부정확하다.**

## 커밋 상태 — 실행환경 권한으로 미완료

일반 브랜치 커밋을 위해 `git -c core.splitIndex=false add ...`를 실행했지만, 다음 worktree 전용 인덱스 lock 생성이 거부됐다.

```text
/Users/gimmusong/build/playx-raven/.git/worktrees/wt-rv-secfix1/index.lock
Operation not permitted
```

실제 경로가 다른 저장소로 연결된 symlink 문제는 아니었다. `git diff --cached --name-only`는 비어 있고 `claude/secfix1` HEAD는 기준 커밋 그대로다. **커밋은 생성되지 않았다.** 공유 인덱스를 수정하거나 별도 인덱스/가상 커밋으로 우회하지 않았다. 현재 세션은 권한 확대가 허용되지 않는다.

소스·생성 번들·검사 결과·이 보고서는 지정 worktree에 모두 남아 있다. `commit-secfix1.sh`에 검토된 파일만 포함하는 일반 커밋 명령을 준비했다. 쓰기가 허용된 사용자 터미널에서 실행할 수 있으며, push·배포 명령은 없다. 기존 staged 변경이 있거나 브랜치/기준 HEAD가 달라지면 실행을 중단한다.
