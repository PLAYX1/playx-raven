# secfix2 데스크톱 보안 수정 인계

2026-10-07 · `/Users/gimmusong/wt-rv-secfix1` · `claude/secfix1` · 기준 `2a2d8b8` 위 추가 변경.

## 범위와 사실 확인

감사 원본 `audit-astra.md`의 F01/F03/F06, `audit-fable.md`의 전달 무결성 지적과 기존 `secfix1-report.md`를 읽고 실제 호출 경로를 확인했다. 감사 원본은 수정하지 않았다. 적용할 AGENTS.md는 상위 경로 및 두 worktree 검색에서 발견하지 못했다. 새 worktree, 배포, push, 실제 송금, 메인넷 쓰기를 하지 않았다. 실지갑, 키체인, `.env` 값을 조회하지 않았다. 시험의 서명 재료는 메모리에서 생성하고 출력하지 않았다.

| 항목 | 기존 상태와 확인 | 이번 처리 |
|---|---|---|
| A-1 / F03 | 감사 당시 `main.ts:12814,12836`, `vending.rs:116,148,166`에 해당하는 현재 경로 확인. secfix1의 `fulfil_sale`에는 확정 결제 outpoint 가드가 이미 있었다. 따라서 수동 경로가 그대로 무방비라는 판정은 현재에는 맞지 않는다. 그러나 원격 수동 UI는 증빙을 넘기지 않아 차단됐고, 별도 `auto_deliver_web`은 실제로 직접 `transfer`를 호출했다. | 수동·자동 원격 주문을 Rust의 동일 주문 원장과 기존 outpoint 지급 가드로 연결. 완료 POST를 UI에서 제거하고 Rust outbox로 이동. |
| A-2 / F06 | secfix1은 updater 등록/설치 UI를 제거했다. 당시 재생이 현재 앱 내 설치로 가능한 상태는 아니었지만, 서명된 버전 결합과 최소 버전 정책은 없었다. | 제한된 Rust 설치 명령 구현. 광고 버전, 서명 메타데이터, 받은 바이트 해시, 내부 앱 버전, 현재/최소 버전, 대상 플랫폼, 순번, 만료를 설치 직전 검사. **내부 버전 검사 지원은 macOS tar.gz이며 Windows/Linux는 계속 설치 거부.** |
| A-3 / F01 | `send_rvn`/`send_asset`은 지급 전에 영속 intent를 쓰고, 결과 미확인 시 잠금을 유지한다. UI도 같은 요청 ID를 유지하고 doSend 동시 재진입을 막는다. 기존 이중 지급 재현은 이미 방어됐다. | 별도 `gateSend` 호출이 전송 중 버튼을 다시 켤 수 있는 UI 경로를 실패 시험으로 확인하고 `sendingNow` 조건 추가. Rust 잠금·receipt·ack 정책은 유지. |

## 원격 주문 원장과 복구

- 구현: `src-tauri/src/remote_sales.rs`의 bind/recover/verify_recipient/deliver/flush, 자동 경로 `auto.rs:629`, 수동/재조회 `src/main.ts:12681,12737,13001`.
- Rust Order에는 주문 ID, 결제 txid:vout, 입금 주소·금액, 자산·수량·수취 주소를 필수로 받는다. 최초 조건을 원자 쓰기로 고정하고 같은 ID의 조건 변경은 거부한다. 결제 outpoint도 주문 ID에 별도로 고정해 다른 ID의 결제 증빙 재사용을 거부한다.
- 로컬 Core의 확정 수신 detail로 출력·주소·금액을 검사한다. 입력의 이전 거래를 Core에서 읽어 모든 입력이 단일 P2PKH 수취 주소에 속하는지 확인한다. **거래소/공동 지갑 입력, 다른 주소로 받는 주문은 지원하지 않고 거부한다.** 서버가 말한 수취 주소만 믿지 않는다. 이는 SPV 구현이나 구매자 신원 인증이 아니다.
- 원장은 `<앱 자료>/remote-sales/`에 `prepared`, `completion_pending`, `completed`, 공개 주문 조건 및 지급 txid를 저장한다. 암호나 배송 토큰은 원장에 넣지 않는다. 지급 영수증은 기존 `<앱 자료>/payouts/sale-<outpoint>.done`을 사용한다.
- 모든 새 지급은 기존 sale outpoint 가드를 거친다. RPC 응답 유실·오류·크래시는 자동 재전송하지 않는다. 같은 주문 재조회는 저장된 txid만 반환한다. 전송 성공 후 outbox 쓰기 전에 종료되면 기존 지급 영수증을 읽어 outbox를 복구한다. 지급 여부를 알 수 없는 prepared 주문은 보류한다.
- 완료 큐는 저장된 ID·txid로만 POST한다. 전송 함수/RPC를 호출하지 않는다. HTTP 오류, 비성공 상태, 유효한 `ok: true` 응답이 없으면 큐를 유지하고 UI에 대기 상태를 표시한다. 재조회 시 원격 목록을 받기 전에 큐를 처리하므로 원격 목록에서 사라진 주문도 재시도할 수 있다.
- 파일은 임시 파일→write/fsync→rename→Unix 부모 폴더 fsync. 프로세스 간 긴 작업은 OS 파일 잠금으로 직렬화하며 프로세스 종료 시 해제된다. `.lock` 파일을 삭제하지 않아 다른 inode로 잠금이 갈리는 것을 막는다.
- 원격 API 구현은 이 worktree에 없다. GET 항목은 `id, asset, qty, to, order_addr, paid_rvn, payment_txid, payment_vout`가 필요하다. 기존 응답에 증빙 필드가 없으면 **계속 차단**된다. POST `{id, txid}`는 서버에서도 동일 내용 재시도를 허용하고 다른 txid 치환을 거부해야 한다. 서버 수정/검증은 수행하지 않았다.
- 기존 버전의 무가드 자동 배송에는 로컬 지급 영수증이 없을 수 있다. 과거 queued 주문을 운영에 연결하기 전에 Core 내역과 서버 주문을 대조해야 한다. 새 코드가 과거 전송을 소급 판별하지 않는다. 지급 결과 미확인 시 자동 잠금 해제/재송금 기능은 없다.

## 업데이트와 필요한 릴리스 변경

구현: `update_policy.rs:25,42,89,254`, `secure_update.rs:15,32`. 기본 updater IPC 권한은 계속 없다. UI는 `check_update`, `install_update(expected_version)`만 사용한다. 설치 명령은 확인을 다시 수행해 승인한 광고 버전이 바뀌면 거부한다.

1. 패키지의 기존 Tauri/minisign 서명을 다운로드 과정에서 검증한다.
2. 고정된 앱 설정의 검증키로 **정확한 statement 문자열**의 별도 minisign 서명을 검증한다. statement는 `version, sha256, target, expires, sequence`만 포함한다.
3. 실제 다운로드된 macOS tar.gz에서 최상위 `.app/Contents/Info.plist`의 `CFBundleShortVersionString`을 읽는다. 중복 메타데이터, 경로 순회, 지원하지 않는 포맷을 거부한다. 압축 해제·패키지 실행은 하지 않는다.
4. 광고/서명/내부 버전이 같고 현재 설치보다 높아야 한다. SHA-256과 플랫폼이 일치해야 하며 만료·이전 순번·최소 버전 미달을 거부한다. 검사한 메모리 바이트 그대로 `install`에 넘긴다.
5. `<앱 자료>/update-policy/minimum.json`을 시작 시와 확인 시 현재 설치 버전 이상으로 유지한다. 설치 직전 검증된 새 버전/순번/해시를 원자 저장한 뒤 설치한다. 손상·쓰기 실패 시 설치하지 않는다. 실패한 설치도 floor를 낮추지 않으며 같은 서명 버전/해시의 재시도만 허용한다.

**서버에서 해야 할 일 — 이번 작업에서는 하지 않음:**

- 로컬 도구 `scripts/prepare-update-statement.py`로 완성된 macOS 패키지의 내부 버전과 해시를 읽어 statement를 생성한다. 인자: 패키지 경로, `--target darwin-aarch64|darwin-x86_64`, 단조 증가 `--sequence`, Unix 시각 `--expires`, `--output`.
- 릴리스 서명 권한자가 출력 문자열 바이트를 변경하지 않고 minisign의 prehashed 방식으로 서명한다. 비밀키를 저장소/이 보고서/명령 출력으로 옮기지 않는다.
- 기존 updater 응답에 `signed_releases[target].statement`(정확한 JSON 문자열), `signed_releases[target].signature`(원문 minisign 서명 텍스트)를 추가한다. 기존 패키지 서명 필드는 유지한다. statement는 URL이 아니라 실제 패키지 SHA-256에 결합된다.
- 클라이언트의 실제 설치 OS/아키텍처별 테스트를 마친 뒤 릴리스한다. Windows EXE/MSI·Linux 패키지의 내부 버전 검사기는 아직 없으므로 그 플랫폼의 앱 내 설치를 열지 않는다.

최소 버전 파일은 사용자 전용 파일 권한으로 보호된다. OS 관리자/동일 사용자 권한 공격자의 파일 삭제·롤백까지 막는 하드웨어 단조 카운터는 아니다. 만료 검사는 로컬 시계를 신뢰한다. 수동 OS 설치는 이 앱 내부 정책의 적용 대상이 아니다. 실제 OS 설치·재시작·전원 차단·Windows ACL/fsync는 시험하지 않았다.

## 시험 근거

| 검증 | 결과/증거 |
|---|---|
| 최초 구현 연결 RED | `secfix2-red.txt`: 원격 자동 가드/원격 outbox/제한 설치 경로 부재로 3개 실패, exit 1. |
| 실제 이전 자동 함수 재현 | `run-secfix2-payout-harness.py --baseline-auto`는 `git show 2a2d8b8:.../auto.rs`를 메모리에서 읽어 모의 RPC로 실행. 증빙 없이 두 번 전달되는 기존 함수를 새 assertion이 탐지. `secfix2-auto-red.txt` exit 101. 이후 같은 시험의 수정 코드 exit 0. |
| 결제 출력 재사용 RED | `secfix2-outpoint-red.txt`: 다른 주문 ID에 같은 outpoint를 결합하는 assertion 실패 → 수정 후 실제 harness 통과. |
| F01 버튼 RED | `secfix2-send-red.txt`: 전송 중 버튼 재활성화 assertion 실패, exit 1 → 수정 후 통과. 기존 doSend 동시 호출·같은 ID 유지 시험도 통과. |
| F06 floor RED | `secfix2-floor-red.txt`: 현재 설치 버전의 내구성 있는 최소 기록이 없는 상태에서 assertion 실패, exit 101 → 구현 후 통과. secfix1은 설치 자체 차단 상태였으므로 현재 기준본에서 실제 다운그레이드 설치가 성공했다고 주장하지 않는다. |
| Node 회귀 | `secfix2-node-tests.txt`: 16/16, exit 0. secfix1 updater 시험은 설치 전면 차단 기대에서 새 제한 설치 경로/기본 IPC 차단 기대에 맞게 갱신. |
| 실제 지급 함수 모의 실행 | `secfix2-payout-harness-results.txt`: 4/4, exit 0. 실제 send/fee/fulfil/remote/auto 함수를 사용. 동일 주문/자동 재조회 transfer 1회, 수취 주소 치환 0회, 응답 유실 후 재전송 없음. 네트워크 0. |
| 별도 프로세스 재시작 | 위 Rust 시험 및 `remote_sales::restart_tests`: 지급 receipt 저장 직후 `process::exit` → 완료 POST 실패 → 재시작/재조회 → 완료 성공 → 추가 재조회. 지급 접수 표식 1 유지. OS 잠금도 프로세스 종료 후 재획득. |
| 유효 과거 서명 재생 | `secfix2-update-tests.txt` 및 전체 Rust: 메모리에서 만든 실제 Ed25519/minisign 서명 검증 성공 후 과거 버전·광고 바꿔치기·패키지 불일치 거부. 현재와 같은 버전, 최소 버전/순번 이전, 만료, 지원하지 않는 플랫폼, 손상 기록도 거부. |
| 기존 payout_guard | `secfix2-guard-tests.txt`: exit 0. 미확인/중첩/쓰기 실패/ack 전 재시작·동일 receipt 재사용·0600 시험 유지. |
| 빌드/타입 검사 | `secfix2-build.txt`: npm run build(preflight→tsc→Vite) exit 0. `secfix2-cargo-check.txt`: cargo check --offline exit 0. OOM/heap/타입 오류 없이 정상 종료 확인. |
| 전체 Rust lib | `secfix2-rust-all.txt`: **762 통과, 7 실패, 13 ignored; exit 101**. 7건 모두 secfix1과 같은 로컬 listener EPERM. 기존 ignored를 새로 추가하지 않았다. |

초기 추가 실패 1건은 시험 root `/private/tmp/...`의 `private` 문자열을 기존 recovery-card 시험이 비밀 문자열로 오인한 것이었다. `/tmp/...`로 같은 합성 폴더를 지정하자 통과했다. 실제 복구 카드나 실제 사용자 저장소를 읽은 것이 아니다.

시험 로그에는 종료코드와 결과를 남겼고, 실제 지급 harness 및 전체 Rust 실행기는 assertion 값/요청 데이터 덤프를 보관하지 않는다. 전체 시험 통과, 독립 감사 완료, 모든 OS 업데이트 지원을 주장하지 않는다.

## 커밋

일반 추가 커밋을 이 브랜치에서 시도한다. 배포/push는 하지 않는다. 커밋 결과는 아래 후속 기록을 따른다.

### 커밋 시도 결과: 권한 제한으로 미생성

다음 명령을 실제 실행했으나 add와 commit 모두 exit 128이었다.

```sh
git -c core.hooksPath=/dev/null add -- src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/src/auto.rs src-tauri/src/lib.rs src-tauri/src/payout_guard.rs src-tauri/src/remote_sales.rs src-tauri/src/secure_update.rs src-tauri/src/update_policy.rs src/main.ts scripts/prepare-update-statement.py docs/handoff-1006
git -c core.hooksPath=/dev/null commit -m "fix: persist remote sale outbox and enforce signed update versions"
```

```text
fatal: Unable to create '/Users/gimmusong/build/playx-raven/.git/worktrees/wt-rv-secfix1/index.lock': Operation not permitted
```

HEAD `2a2d8b81a7053e0cba9f9fe2f80e66aa5c54f4be`는 그대로이며 staged 파일도 없다. index.lock 삭제, 별도 index, 가상 커밋으로 우회하지 않았다. 일반 커밋용 `docs/handoff-1006/commit-secfix2.sh`를 남겼다. 이 스크립트는 브랜치/기준 HEAD/빈 index를 검사한 뒤 지정된 변경 파일만 add하고 `git -c core.hooksPath=/dev/null commit`한다. push/배포 명령은 없다. 사용자 터미널에서 `bash docs/handoff-1006/commit-secfix2.sh`로 실행할 수 있다.
