# 0.8.2 병합 검증 보고서

작성일: 2026-10-07 · 작업 폴더: `/Users/gimmusong/wt-rv-082` · 브랜치: `claude/release-082`

## 결과

요청된 순서로 두 작업을 병합했다. 첫 병합은 `0ed4b75`이며 부모는 voice `45af607`과 firstrun `04b79ab`이다. 두 번째 병합은 이 보고서를 포함한 커밋이며, 부모는 `0ed4b75`와 coldhot `300ab246566a`다.

`npm run build`, 핵심 firstrun·voice·AI 안전·지갑 금고 검사는 통과했다. Rust는 전체 실행에서 **755 통과 / 포트 권한 실패 7 / 기존 ignored 13**이며, 그 7개만 명시적으로 제외한 최종 실행은 **755 통과 / 실패 0 / ignored 13 / filtered 7**이다. 바이너리 테스트 0개, doc-test 1개 기존 ignored도 확인했다.

`scripts/check-*.mjs` **45개 모두 실행**: 정상 종료 30개, 의도된 mutation 검출 1개, 환경 차단 14개. 따라서 **모든 JS 검사 통과 조건은 충족하지 못했다.** 환경 차단을 성공으로 바꾸거나 검사를 삭제하지 않았다. 추가 firstrun 브라우저 행렬도 Chrome 실행 단계에서 차단됐다. 실제 마이크·macOS 권한 창의 네이티브 실측은 수행하지 못했다.

## 충돌 해결

| 파일 | 해결 방식 |
|---|---|
| `companion.html` | voice의 마이크·동의·철회·상태·파형 UI 전체를 유지하고 firstrun의 `data-ravi-arriving="true"`를 결합했다. |
| `src/main.ts` | `createRaviHome`에 `voiceProvider`와 `afterLanding`을 함께 전달하고, agent의 `landed` 및 `afterLanding` 연결을 유지했다. |
| `src/ravi-companion.ts` | 마이크 모듈과 착지 barrier를 함께 초기화한다. 말풍선 열기는 착지 후 처리하며 닫기는 녹음을 중지한다. 시작 시 말풍선 자동열림 제거와 착지 완료 처리를 유지했다. |
| `src/ravi-home.ts` | API 타입에 `voiceProvider`와 `afterLanding`을 함께 보존했다. 동의 기반 마이크·포커스/권한 UX·녹음 취소와 패널의 착지 대기열 연결을 유지했다. |

`.github/workflows/release.yml`, `index.html`, `scripts/check-ravi-panel-browser.mjs`는 자동 병합됐다. QR·대화 자동열림 제거, 복구 경고 대기열, 릴리스 첫 실행 검사도 보존됐다. macOS `entitlements.plist`, `Info.plist`, 4개 언어 권한 설명과 음성 Rust/받아쓰기/마이크 핵심 파일은 voice 기준과 동일함을 확인했다.

coldhot은 충돌 없이 8개 파일을 추가했다: `core/wallet-hot.ts`, `core/wallet-vault.ts`, `src/ravi-wallet.ts`, `src/wallet-vault.ts`, `scripts/check-wallet-vault.mjs`, `docs/cold-hot-wallet.md`, `docs/cold-hot-wallet-wireframe.md`, `docs/cold-hot-wallet-copy.json`. 전달받은 설계·코어 범위를 그대로 보존했다.

## 추가 회귀 검증

`scripts/check-ravi-voice.mjs`의 실제 마이크 UI 어댑터 시험에 실제 `firstrun.ts` barrier를 연결했다. 착지 전 클릭은 동의 RPC와 장치 접근을 발생시키지 않고, 착지 후 대기 클릭이 준비 상태·동의 UI로 이어진다. 착지 완료만으로 장치 권한을 요청하지 않으며, 명시적 음성 동의 후에만 녹음한다. 기존 파형·텍스트 채움·수동 편집 취소·동의 철회 검사도 유지했다. 수정 후 검사 통과.

## 빌드 및 검사 환경

- `npm run build`: preflight·TypeScript·Vite 통과. 기존 500 kB 이상 청크 경고만 있음.
- 이 worktree에 `node_modules`가 없어 기존 로컬 캐시를 복사했다. 누락된 SheetJS는 정확히 `0.20.3` 캐시를 사용했다. 의존성 선언·lockfile 변경 없음.
- Cargo는 `CARGO_NET_OFFLINE=true`, `CARGO_TARGET_DIR=/private/tmp/rv-082-cargo-target`로 실행했다. 기존 캐시를 복사했으며 공유 빌드 폴더에 쓰지 않았다.
- 시험 fixture는 `/tmp/rv-082-fixtures` 아래 격리했다. 처음 `/private/tmp/rv-082-fixtures`를 사용했을 때 복구 카드의 공개 경로에 포함된 `private` 문자열을 비밀 필드로 오인해 추가 실패 1개가 발생했다. 경로 표기를 `/tmp`로 교정한 전체 재실행에서 해당 검사는 통과했다. 검사나 제품 코드를 약화하지 않았다.
- mutation 검사는 소스를 일시적으로 변경하므로 전체 빌드·Rust 검사와 겹치지 않게 실행했다. 예상 종료 1 및 의도된 assertion을 확인하고 소스 SHA-256 복구 확인 후 Rust 최종 검사를 다시 실행했다.
- `plutil -lint`: Info.plist·entitlements·ko/en/ja/zh 권한 설명 6개 모두 통과.
- `git diff --check`: 통과.
- 실제 송금·실제 지갑/키 저장소·외부 AI 사용 없음. push·태그 생성 없음. 보고서에는 시드·토큰·비밀번호를 포함하지 않았다.

## JS 검사 전체 결과

| 검사 | 종료 코드 | 결과 |
|---|---:|---|
| `check-ai-safety.mjs` | 0 | 통과 |
| `check-backup-result.mjs` | 0 | 통과 |
| `check-backup-safety.mjs` | 0 | 통과 |
| `check-backup-ui.mjs` | 1 | 루프백 listen EPERM |
| `check-cert-photos.mjs` | 1 | Chrome 프로세스 실행 실패 |
| `check-cert-roster.mjs` | 0 | 통과 |
| `check-certificate-bulk-ui.mjs` | 1 | Chrome 프로세스 실행 실패 |
| `check-certificate-preview.mjs` | 1 | 루프백 listen EPERM |
| `check-desktop-identity-fix.mjs` | 1 | 루프백 listen EPERM |
| `check-desktop-integration.mjs` | 0 | 통과 |
| `check-desktop-languages.mjs` | 1 | 루프백 listen EPERM |
| `check-desktop-mutation.mjs` | 1 | 의도적으로 제거한 거래 해시 검증을 시험이 검출; 원본 SHA-256 일치 확인 |
| `check-desktop-ux.mjs` | 1 | 루프백 listen EPERM |
| `check-easy-create.mjs` | 0 | 통과 |
| `check-firstrun.mjs` | 0 | 통과 |
| `check-issue-gate.mjs` | 0 | 통과 |
| `check-local-wallet-publish.mjs` | 0 | 통과 |
| `check-map-copy.mjs` | 0 | 통과 |
| `check-merchant-map.mjs` | 0 | 통과 |
| `check-peer-help.mjs` | 0 | 통과 |
| `check-phone-transaction.mjs` | 0 | 통과 |
| `check-ravi-agent.mjs` | 0 | 모의·Rust 통과; 내부 선택적 Chrome 검사는 미검증 |
| `check-ravi-companion.mjs` | 0 | 통과 |
| `check-ravi-key.mjs` | 0 | 통과 |
| `check-ravi-panel-browser.mjs` | 1 | Chrome 프로세스 실행 실패 |
| `check-ravi-panel.mjs` | 0 | 통과 |
| `check-ravi-promo-browser.mjs` | 1 | Chrome 프로세스 실행 실패 |
| `check-ravi-promo-card.mjs` | 0 | 통과 |
| `check-ravi-promo.mjs` | 0 | 통과 |
| `check-ravi-similarity.mjs` | 0 | 통과 |
| `check-ravi-state.mjs` | 0 | 통과 |
| `check-ravi-understanding-browser.mjs` | 1 | Chrome 프로세스 실행 실패 |
| `check-ravi-understanding.mjs` | 0 | 통과 |
| `check-ravi-understanding2.mjs` | 0 | 통과 |
| `check-ravi-understanding3.mjs` | 0 | 통과 |
| `check-ravi-understanding5.mjs` | 0 | 통과 |
| `check-ravi-voice.mjs` | 0 | 통과 |
| `check-restore-vectors.mjs` | 1 | 격리 Core 시험의 빈 포트 확보 실패(루프백 bind EPERM); --no-core 재실행 통과 |
| `check-send-confirmation.mjs` | 0 | 통과 |
| `check-shop-seal.mjs` | 0 | 통과 |
| `check-staff-refund.mjs` | 0 | 통과 |
| `check-style-csp.mjs` | 1 | 루프백 listen EPERM |
| `check-wallet-easy.mjs` | 1 | 루프백 listen EPERM |
| `check-wallet-vault.mjs` | 0 | 통과 |
| `check-words-restore.mjs` | 1 | 루프백 listen EPERM |

환경 차단 14개는 루프백 포트 9개와 Chrome 프로세스 실행 5개다. `check-restore-vectors.mjs --no-core`는 추가 실행하여 통과했으며, 이는 포트가 필요한 Core 부분의 통과를 뜻하지 않는다. `check-firstrun.mjs --browser`는 추가 실행했으나 Chrome 실행 실패로 미검증이다. 정상 종료 30개 중 `check-ravi-agent.mjs`의 선택적 Chrome 부분도 내부에서 미검증으로 기록됐다.

## Rust 포트 시험 7개

아래 7개 모두 소켓 바인딩에서 macOS 샌드박스의 `PermissionDenied / Operation not permitted (EPERM)`로 차단됐다.

| 시험 | 차단된 동작 |
|---|---|
| `ai::connection_tests::loopback_mock_covers_http_refusal_and_delayed_response` | HTTP 거부·지연 응답 모의 서버 |
| `ai_endpoint::tests::redirects_cannot_forward_a_question_to_another_destination` | 리디렉션 모의 서버 |
| `peers::tests::폴더_주소도_파일처럼_살아_있다고_본다` | 폴더 주소 응답 모의 서버 |
| `relay::tests::live_push_and_pairing_rooms_stay_off_disk` | 릴레이·페어링 루프백 서버 |
| `server::bind_probe::binding_the_phone_port_is_fast` | 휴대폰 서버 포트 바인딩 |
| `server::wallet_usability_tests::actual_loopback_listener_supplies_peer_and_never_trusts_forwarding_headers` | 실제 루프백 연결의 peer 검증 |
| `upload::photo_security_tests::streaming_size_mime_and_magic_are_checked_without_length` | 스트리밍 업로드 모의 서버 |

전체 실행: `RV_BACKUP_FIXTURE_ROOT=/tmp/rv-082-fixtures cargo test --offline --manifest-path src-tauri/Cargo.toml`. 최종 실행은 같은 명령에 `--` 뒤로 위 7개의 전체 이름을 각각 `--skip` 인자로 전달했다. 다른 실패·검사는 제외하지 않았다.

## Git 메타데이터 제약

일반 `git merge`는 원래 worktree 메타데이터의 `ORIG_HEAD.lock` 생성에서 `Operation not permitted`로 막혔다. `/private/tmp/rv-082-merge-git`에 이 worktree 전용 HEAD·인덱스·병합 상태를 두고, `commondir`는 원래 저장소 `/Users/gimmusong/build/playx-raven/.git`를 가리키도록 했다. 따라서 **커밋 객체와 `claude/release-082` 브랜치는 원래 공유 저장소에 기록**된다. 다른 worktree의 HEAD·인덱스는 변경하지 않았다.

원래 `/Users/gimmusong/build/playx-raven/.git/worktrees/wt-rv-082/index`로의 동기화도 샌드박스가 거부했다. 따라서 기본 `git status`에는 이전 인덱스와 새 HEAD 사이의 차이가 나타날 수 있다. 검증에 사용한 이 worktree 전용 인덱스로 보는 명령은 다음과 같다.

```sh
GIT_INDEX_FILE=/private/tmp/rv-082-merge-git/index git status --short
```

이 인덱스 제약은 브랜치에 기록된 두 병합 커밋의 부모·내용에는 영향을 주지 않는다. 원래 메타데이터 쓰기가 허용된 환경에서 인덱스를 HEAD에 동기화하려면, 추가 변경이 없는지 확인한 뒤 `git read-tree HEAD`를 실행하면 된다. 이 명령은 작업 파일을 수정하지 않는다.

상세 실행 로그·최종 검사 목록은 `/private/tmp/rv-082-results`에 보관했다. 원문 로그는 커밋하지 않았다. 검사들이 생성한 기존 추적 artifact 변경은 복원하고, 이번 작업이 만든 임시 backup-safety artifact는 제거했다.
