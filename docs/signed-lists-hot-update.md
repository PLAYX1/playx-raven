# 서명된 허용·차단 목록 — 지갑·앱 재배포 없이 갱신 (signed lists hot update)

작성 2026-10-10. 지갑 저장소 `ravenvault` 브랜치 `claude/rv-signed-lists-core`(기준 `5d845db`), 데스크탑 `playx-raven` 브랜치
`claude/rv-signed-lists-desktop`(기준 `87116a5`). 같은 문서가 두 저장소에 있다.

**하지 않은 것**: 운영 키 생성, 실제 목록 서명·배포, push·배포·태그, 메인넷 거래. 시험은 전부 일회용 개발 키(시험 안에서 만들고 지움)와 모의 서버.
**출하 상태 그대로**: 믿는 목록 키 `SIGNED_LISTS_PUBLIC_KEYS` 와 제작자 목록 키 `CREATOR_ALLOWLIST_PUBLIC_KEYS` 는 **비어 있다** → 출하 지갑은 어떤 묶음도
받아들이지 않고 네트워크에 묻지도 않는다(늘 내장 기본 목록). 판매 스위치·메인넷 발행 스위치는 꺼진 채.

---

## 1. 한눈에

```
대표(오프라인 기기)                                     지갑 사이트(정적 파일, 서버·DB 없음)          지갑 / 데스크탑
 신청서 폴더 ─ review-queue.ts ─ candidate.json            release-site/lists/signed-lists.json   ──▶  시작 때 저장된 「마지막 유효 목록」 먼저 적용
   (이름·종류·자동 점검·소각 확인·승인/거절, 키 없음)        (선택) pointer.json → IPFS CID                 6시간마다 / 「목록 새로 받기」
 sign-lists.ts sign --key-file 대표키.pem ─ signed-lists.json ─┘                                         서명·일련번호·만료 검사 → 전부 통과해야 적용
                                                                                                         실패 = 그대로 유지(없으면 내장 기본값)
```

- 내장 목록(지갑 묶음 안의 게임 등록부, 비어 있는 제작자 허용·차단)은 **기본값(최소 시작 목록)** 으로 남는다.
- 게임/제작자를 검증·차단할 때마다 지갑을 다시 빌드할 필요가 없다: 대표가 새 묶음에 서명해 `release-site/lists/` 에 올리면 끝.
  (지금 이 파일을 사이트에 올리는 것도 사이트 배포다 — 지갑 묶음·무결성 해시는 바뀌지 않는다. 배포 없이 올리려면 IPFS 포인터 경로.)
- 크기: 묶음 8 MiB 상한. 게임 등록부 1,024개, 제작자 허용 4,096개, 차단 65,536개(기존 검사기 상한) — 게임이 많아져도 지갑 릴리스와 무관.

## 2. 묶음 형식 `rv-signed-lists` v1 (`core/signed-lists/envelope.ts`)

```json
{
  "format": "rv-signed-lists", "version": 1,
  "body": { "sequence": 7, "issuedAt": "…Z", "expiresAt": "…Z",
            "parts": { "gameRegistry": {"sha256": "…"} | null, "creatorAllowlist": {…} | null, "creatorDenylist": {…} | null } },
  "parts": { "gameRegistry": {"doc": …, "signature": …} | null, "creatorAllowlist": …, "creatorDenylist": … },
  "transitions": [ 키 전환 문 … ],
  "signature": { "keyId": "16 hex", "algorithm": "Ed25519", "domain": "RAVENVAULT-SIGNED-LISTS-V1", "signature": "base64url" }
}
```

- 바깥 서명 = `RAVENVAULT-SIGNED-LISTS-V1\n` + 정본 JSON(body). body 가 일련번호·발행·만료와 **세 목록 각각의 SHA-256**(정본 JSON `{doc, signature}`)을 묶는다.
- 안쪽 목록은 **원래 형식·원래 서명 그대로**: 게임 등록부 = `rv-game-allowlist-signature`(도메인 `RAVENVAULT-GAME-ALLOWLIST-V1`, 게임 저장소와 같은 바이트 규칙),
  제작자 허용 = `RAVENVAULT-CREATOR-ALLOWLIST-V1`, 차단 = `RAVENVAULT-CREATOR-DENYLIST-V1`. 원래 검사기(`verifyAllowlistSignature`+`validateRegistry`,
  `verifyCreatorAllowlist`, `verifyCreatorDenylist`)를 그대로 부른다. 도메인 문자열은 목적마다 새로 — 재사용 없음(바깥 `…SIGNED-LISTS-V1`, 키 전환 `…LIST-KEY-TRANSITION-V1`).
- 묶음은 **스냅숏**이다: 세 칸이 늘 있고 값은 목록 또는 `null`(「이 목록 없음」). 합치기(merge)가 없어 「일부만 바뀐」 상태가 생기지 않는다.
- **2026-10-11 네 번째 칸 `feeSchedule`(장터 수수료 일정)** — 안쪽 도메인 `RAVENVAULT-FEE-SCHEDULE-V1`. 칸이 없는 옛 세 칸 묶음도 받는다. 만료돼도 마지막으로 검증된 일정을 유지한다(차단 목록과 같은 처리). 정본: `docs/fee-schedule.md`.
- 안쪽 서명을 볼 키 = 그 목록의 원래 내장 키 + 믿는 목록 키(전환 반영) − 은퇴한 키.

## 3. 안전 규칙 (전부 시험이 있다)

| 규칙 | 동작 | 시험 |
|---|---|---|
| 일련번호 | `sequence` 가 지금 바닥보다 클 때만 적용. 같은 번호 + 같은 내용 = 「바뀐 것 없음」, 같은 번호 + 다른 내용 = 거절, 낮은 번호 = 거절(진짜 옛 묶음 재전송도) | `signed-lists.test.ts` §2 |
| 만료 | `expiresAt` 지남 = 거절. 발행 시각이 1일 넘게 미래 = 거절. 수명 180일 초과 = 거절. 적용된 묶음이 나중에 만료되면 **검증(허용·게임 등록부)은 기본값으로, 차단은 유지** | §3 |
| 실패 시 유지 | 서명 실패·형식 이상·크기 초과·JSON 아님·HTTP 오류·시간 초과·포털 페이지 → 상태 그대로(마지막 유효 목록, 없으면 내장 기본값). 저장소가 망가져도 내장 기본값 | §4·§5·§7, `boot.test.ts` |
| 부분 적용 금지 | 바깥 서명 + 세 목록 해시(쓰지 않는 목록도) + 쓰는 목록의 안쪽 서명 + 내용 검사가 **전부** 통과해야 상태가 바뀐다. 하나만 틀려도 묶음 전체 거절 | §5 |
| 차단 우선 | 같은 묶음의 허용·차단을 함께 쓰고 `judgeListing` 이 차단을 먼저 본다(자산·제작자 주소 둘 다). 차단은 그 묶음을 받는 즉시 효력 | §5, Chrome 시험 |
| 저장값 불신 | 저장소의 상태(묶음 글자·전환 문)는 읽을 때마다 처음부터 다시 검증한다 | §5·§6 |
| 결제 상한(지갑) | 받은 게임 등록부는 결제를 **새로 열거나 돈 받는 곳을 바꾸지 못한다** — §4 | §8 |

## 4. 지갑 연결 (`core/signed-lists/wallet.ts`, `boot.ts`, `phone/web/signed-lists-boot.ts`, `core/game-registry/registry.ts`)

- `phone/App.tsx` 가 시작 때 `startSignedLists()` 한 줄을 부른다: 저장된 마지막 유효 목록을 **네트워크 없이 먼저** 적용 → 믿는 키가 있으면
  `https://ravenvault.ex.erci.se/lists/signed-lists.json`(같은 출처, CSP 변경 없음)을 받아 본다 → 6시간마다 반복. 절대 던지지 않는다.
- `registry.ts`: `activeGameRegistry()` 가 「지금 쓰는 등록부」를 돌려주고, 조회 함수(`gameById`·`gameForOrigin`·`gameForRequest`·`gameTier`)와
  신원(`identity.ts`)·직접 결제(`direct-pay.ts` — 한 견적 검사 안에서는 한 번 고른 등록부만)·제작자 구매(`purchase.ts`)·결제 답변(`game-direct-pay-answer.ts`)의
  기본값이 이것이다. `adoptVerifiedRegistry` 를 거친(서명 확인 + 출하 규칙 재검사 + 얼림) 등록부만 활성이 될 수 있다.
- **결제 상한**(`HOT_UPDATE_MAY_OPEN_PAYMENT = false`): 받은 등록부의 게임은 결제 칸(받는 주소·가격표·수수료·분류·망·스위치·한도…)이
  내장 등록부와 글자 그대로 같을 때만 결제 문이 그대로다. 새 게임이거나 하나라도 다르면 `enabled:false, locked:true` 로 낮춘다 → 「검증됨」 배지·신원은 되고 결제는 안 된다.
  플랫폼 수수료 주소는 늘 내장본. 이유: 목록 키 하나가 새면 원격으로 돈 받는 주소를 바꿀 수 있게 되기 때문. 결제 변경은 지금처럼 지갑 릴리스로. (대표 결정 #3)
- 낮추는 쪽은 즉시: 게임을 빼거나 은퇴·잠금한 등록부를 받으면 바로 미검증·결제 닫힘.
- 내장본이 더 새것이면(받은 등록부의 안쪽 `listVersion` < 내장 `listVersion`, 지갑을 새로 받은 경우) 내장본을 쓴다.
- 제작자 허용·차단은 `creatorListsFrom` 이 같은 묶음에서 꺼낸다(지갑 장터 화면은 아직 없다 — 데스크탑이 쓴다).

## 5. 데스크탑 연결 (`playx-raven`)

- `core/signed-lists/{envelope,creator-parts,sources}.ts` 를 지갑에서 **바이트 그대로 복사**(SHA-256 고정: `core/creator/vendor-sha256.json`, 시험이 원본과도 대조).
- `src/market-lists.ts` + `src/open-market.ts`: 장터를 그릴 때마다 지금 목록을 읽고, `#mk-lists-say` 한 줄(「기본 목록」/「최신 목록 N번」/「기한 지남」)과
  받는 길이 있을 때만 「목록 새로 받기」 단추. 거절되면 「적용하지 않았어요(이유) → 지금 목록을 그대로 써요」.
- 🔴 출하 데스크탑에는 **받는 길이 없다**: 웹뷰 CSP `connect-src 'self'` 라 밖으로 못 나가고, 노드가 대신 받아 오는 Rust 명령은 만들지 않았다(다음 단계).
  지금은 늘 「기본 목록」. 시험은 모의 경로를 넣어 끝까지 돈다.

## 6. 운영 절차 (대표)

### 6.1 검증 신청 처리 → 서명 → 올리기
1. 제작자 신청서(`rv-creator-listing-request` JSON, 마법사 ⑧)를 한 폴더에 모은다. 전달 경로는 대표 결정(#6).
2. 자동 점검 결과(`checks.json`)와 소각 확인(`burns.json`: 자산 → 발행 거래·소각 RVN·확인 수)을 노드·데스크탑으로 확인해 적는다. 이 도구는 노드·인터넷에 묻지 않는다.
3. 대기열 보기(키 없음):
   `node --import tsx scripts/signed-lists/review-queue.ts list --requests 신청서/ --checks checks.json --burns burns.json --current release-site/lists/signed-lists.json --html queue.html`
   → 이름·종류·신청서 형식·자동 점검·소각 확인(500 RVN, 6확인 이상, 신청서 거래 번호와 같음)·상태(대기/이미 허용/차단됨). `queue.html` 은 읽기 전용 화면.
4. `decisions.json` 에 승인(`gameIndex`·`origins`·`feeBps`)·거절(선택: 차단 사유)을 적고 후보 만들기(키 없음):
   `… review-queue.ts candidate … --decisions decisions.json --out candidate.json`
   → 점검 통과 + 소각 확인이 없으면 **승인 보류**. 일련번호 = 지금 + 1, 바뀐 목록만 `listVersion` + 1, 안 바뀐 목록·게임 등록부는 서명째 그대로.
5. 서명(대표 키, 오프라인 기기): `node --import tsx scripts/signed-lists/sign-lists.ts sign --input candidate.json --key-file 대표키.pem --out signed-lists.json`
   - 키는 `--key-file` 또는 `RV_LIST_SIGNING_KEY_FILE` 경로로만. 권한이 600 이 아니면 거절. 키 내용은 어디에도 출력하지 않는다.
   - 서명 뒤 같은 검증기로 스스로 다시 확인하고 통과해야만 파일을 쓴다. 기본 만료 30일(`expiresInDays` 1~180).
6. 확인: `… sign-lists.ts verify --input signed-lists.json --keys keys.json` → `wouldApplyNow: true`.
7. `release-site/lists/signed-lists.json` 에 넣고 사이트 배포(대표). 또는 IPFS 에 올리고 `pointer.json` 만 바꾼다.
8. **만료 전에 다시 서명**(내용이 같아도 일련번호 + 1). 잊으면 검증됨은 기본값으로 돌아가고(안전 쪽), 차단은 유지된다.

### 6.2 키 만들기·전환
- 운영 키는 대표가 인터넷 없는 기기에서 만든다(PKCS#8 Ed25519 PEM, 예: `openssl genpkey -algorithm ed25519 -out key.pem && chmod 600 key.pem`). 이 저장소 도구는 키를 만들지 않는다.
- 처음: 공개키(`{keyId, publicKey}`)를 `envelope.ts SIGNED_LISTS_PUBLIC_KEYS` 에 넣고(여러 개 가능 — 예비 키를 같이 넣어 두면 분실에 대비), 제작자 목록도 같은 키로 서명하려면
  `listing.ts CREATOR_ALLOWLIST_PUBLIC_KEYS` 에도 넣는다(지갑 릴리스 한 번). 이후 목록 갱신에는 릴리스가 필요 없다.
- 전환(릴리스 없이): `… sign-lists.ts transition --key-file 지금키.pem --new-key-file 새키.pem --index <적용된 전환 수 + 1> [--retire <옛 keyId>] --out t.json`
  → 다음 후보의 `transitions` 에 지금까지의 전환 전부 + 새 전환을 싣고(`review-queue` 가 지금 묶음의 전환을 이어 붙인다) **새 키로** 서명.
  - 전환 문 = 지금 믿는 키 서명 + 새 키 자신의 서명(가진 증명), 순번 연속. 은퇴한 키는 바깥·안쪽 어느 서명도 못 하고 되살릴 수 없다. 믿는 키를 0개로 만드는 전환은 거절.
  - 지갑은 받은 전환을 저장하고, 전환 문을 빠뜨린 옛 묶음이 와도 이미 은퇴한 키는 믿지 않는다.
  - 다음 지갑 릴리스 때 내장 키 목록을 새 키로 바꿔 둔다(새로 설치한 지갑이 전환 사슬 없이도 믿게).
- 키가 **새었을 때**: 새 키로 전환 + 옛 키 은퇴를 담은 묶음을 즉시 올린다. 단, 공격자가 먼저 자기 키로 전환을 올리면 경쟁이 된다 — 그때는 지갑 릴리스로 내장 키를 바꾸는 수밖에 없다(위험 §9).

## 7. 내장 등록부 서명이 틀렸을 때 — 멈춤 vs 낮춤 (🔶 대표 결정 #1)

- 이전 결함(presale-hardening 보고): `GAME_REGISTRY` 가 모듈 최상위에서 서명을 검사해, 틀리면 던지고 → `phone/App.tsx` 전체가 시작하지 못한다.
- 이번에 정책 상수를 만들었다: `registry.ts BUILTIN_REGISTRY_FAILURE_POLICY`.
  - `'halt'`(**지금 값, 기존 동작 그대로**): 던진다. 안전 쪽이지만 사용자가 지갑을 못 연다.
  - `'degrade'`: 던지지 않고 게임 없는 등록부로 낮춘다 → 모든 게임 미검증(신원·결제 없음, 외부 링크만), 지갑의 다른 기능(보내기·받기·장터)은 열린다.
    그 뒤 서명된 최신 목록이 오면 그 게임들은 「검증됨」으로 돌아오지만 **결제는 잠긴 채**(결제 상한 — 비교할 내장 결제 칸이 없으므로).
  - 두 경로 모두 시험이 있다(§9). 한 줄만 바꾸면 된다. 판단 메모: 등록부 서명이 틀린 묶음은 빌드 관문(presale 브랜치 `build-pwa.mjs`)이 먼저 막으므로 출하될 가능성은 낮다.
    「낮춤」은 그 관문을 지나친 사고에서 지갑 열림을 지키고, 「멈춤」은 이상 신호를 크게 드러낸다.
- 실행 중 받은 목록 쪽은 정책과 무관하게 **늘 낮춤**: 틀린 묶음은 거절되고 마지막 유효 목록/내장본을 쓴다(지갑을 멈추지 않는다).

## 8. 작업 1 — 체인 이름 조회 「확인 불가」 (데스크탑)

- 결함: `issue.rs name_taken` 이 노드 오류 문구에 `Invalid`·`not found` 가 있으면 「비어 있음(false)」. `shop.rs shop_name_free` 도 같은 우회. 발행 문(`issue_asset`)은 조회 오류를
  `unwrap_or(false)` 로 「없음」 처리, 화면(`main.ts` 발행 마법사·가게 등록)도 오류를 삼켜 「없음/비어 있음」으로 넘겼다.
- 고침: `issue.rs` 에 세 상태 `NameLookup { Taken, Free, Unknown }` 과 순수 분류 함수 `classify_name_answer`.
  - `Taken`: 결과 객체의 `name` 이 묻는 이름과 정확히 같음. `Free`: 결과가 `null` **이고** 노드가 다 따라잡음(`initialblockdownload == false`, `blocks == headers > 0`). 그 밖 전부 `Unknown`
    (오류 문구 무엇이든·빈 답·다른 이름·문자열/숫자/배열·동기화 중·장부 상태 못 읽음·시간 초과).
  - `name_taken` 명령: 있음 `true`, 없음 `false`, 모름 = **오류**(「확인 불가: … 다시 조회」). `issue_asset`·`shop_name_free`·`create.rs name_used` 도 모름이면 막는다.
  - 화면: `src/name-lookup.ts` — 정확한 `true`/`false` 만 믿고 오류·불리언 아닌 답은 `null`(확인 불가). `planIssue({ nameTaken: null })` 이 등록을 막는다(기존 정책).
    발행 마법사·가게 등록 화면도 「확인 불가」를 보이고 진행을 막는다(가게는 앞서 확인한 다른 이름이 확인 칸에 남지 않게 비운다).
- 확신 낮음: Ravencoin `getassetdata` 가 없는 이름에 `null` 을 돌려준다는 것은 원본 기억 + 데스크탑 `companion.rs` 의 같은 가정에 기댄다. 실제 노드에서 다시 보지 않았다.
  틀렸다면(없는 이름에 오류를 준다면) 모든 새 이름이 「확인 불가」로 막힌다 — **안전 쪽 실패**이고, 그때는 그 정확한 응답만 `Free` 로 추가하면 된다.

## 9. 시험

- 지갑: `core/signed-lists/signed-lists.test.ts` 9묶음(서명 적용·출하 빈 키, 되돌림 3종 + 다시 읽기, 만료 3종 + 만료 뒤 허용 해제·차단 유지, 변조 15종, 부분 적용 금지·저장소 변조·차단 우선 2종,
  키 전환(적용·은퇴 키의 바깥/안쪽 서명 거절·전환 문 빠진 옛 묶음·다시 읽기·거절 6종·두 번째 전환·내장 키 여러 개), 네트워크 실패·HTTP 오류·포털·시간 초과·다음 경로·되돌림 경로 건너뛰기·IPFS 포인터·막힌 저장소, 지갑 등록부 결제 상한·활성 교체·내장본 우선·만료·시험 항목 거절·즉시 제거,
  내장 서명 실패 halt/degrade + 낮춘 뒤 목록 복구), `boot.test.ts` 2묶음(출하 상태 네트워크 없음, 시작·오프라인 재시작·망가진 저장소·던지지 않음),
  `tools.test.ts` 4묶음(대기열·HTML, 후보(소각 확인 없으면 보류), 서명(키 파일 권한·자기 검사·키 내용 출력 없음·검증 명령), 다음 차례 쌓기 + 키 전환 도구).
  지갑 전체 `check-all` 130/130(기준 127 + 새 3), `test:shell` 48/48, 타입 검사·이식성 검사·브라우저 묶음 12/12 통과.
- 데스크탑: Rust `issue::name_lookup_tests` 7개(오류 문구 12종, 정상 없음, 있음(동기화 무관), 형식 이상 11종, 미동기화 8종, 명령이 모름에 오류, 옛 우회 재발 방지).
  `cargo test --lib`(시험 고정 폴더 `RV_BACKUP_FIXTURE_ROOT` 지정) 781 통과·1 실패·13 무시 — 실패 1개 `recover::tests::the_recovery_card_has_no_secrets` 는 **기준 커밋에서도 같다**(이번 변경 전으로 되돌려 확인).
  `scripts/name-lookup.test.mjs` 4, `scripts/signed-lists-browser.test.mjs` 2(실제 Chrome: 미검증 → 목록 받기 → 검증됨 → 변조 거절 → 서버 오류 유지 → 다시 열어도 유지 → 차단으로 숨김 → 옛 묶음 되돌림 거절,
  390·1440 가로 넘침 없음, 출하 연결은 요청 0번). 데스크탑 `npm test` 66 중 65 — 실패 1개(`sales-account` 참조 체크아웃 빌드)는 기준에서도 같다. `preflight`·타입 검사 통과.

## 10. 위험 · 못 해 본 것 · 확신 낮은 부분

- **목록 키 = 원격 권한**: 키가 새면 공격자가 가짜 「검증됨」(신원 서명 허용)과 차단(서비스 방해)을 원격으로 퍼뜨릴 수 있다. 결제 주소 변경은 결제 상한이 막는다.
  두 사람 확인·하드웨어 키·오프라인 서명 기기는 절차로만 적었다(강제 장치 없음).
- 키 유출 뒤 공격자가 먼저 전환 문을 올리면 지갑이 공격자 키로 옮겨 갈 수 있다(전환은 지금 믿는 키 하나로 승인되므로). 대안: 전환에 두 키 이상 서명 요구 — 대표 결정 #4.
- 일련번호 바닥은 지갑 저장소(localStorage)에 있다 — 저장소를 지운 사용자에게는 옛(만료 전) 묶음을 다시 먹일 수 있다. 만료(기본 30일)가 그 창을 줄인다.
- 시계: 기기 시계가 크게 틀리면 정상 묶음이 「만료」나 「미래」로 거절된다(안전 쪽 — 내장본으로).
- 폰 지갑에 장터·게임 배지 화면이 아직 없어 Chrome 배지 시험은 **데스크탑 장터 화면**(실제 마크업 일부 + 실제 화면 코드, 앱 전체 빌드 아님)으로 했다. 폰 지갑은 단위 시험으로만 확인.
- 데스크탑이 실제로 목록을 받아 오는 Rust 명령(노드 프로세스가 고정 주소에서 받기)은 만들지 않았다.
- 실제 지갑 사이트에서 `/lists/` 헤더·배포 확인, IPFS 게이트웨이 실측 안 함. `release-site` 의 `share.test`·`web-metadata.test` 는 이 작업 환경에 빌드 산출물·og 패키지가 없어 돌지 않는다(이번 변경과 무관한 환경 문제, 확인 필요).
- 정본 JSON 은 JS `JSON.stringify` 의 수 표기에 기댄다(소수는 등록부의 `krwPerRvn` 하나). 다른 언어로 서명 도구를 새로 만들면 같은 바이트인지 대조 필요.
- 폰(Expo 네이티브) 앱에서 `fetch` 로 같은 https 주소를 받는 경로는 시험하지 않았다(웹과 같은 코드, 네이티브 실측 없음).

## 11. 대표 결정 목록

| # | 결정 | 지금 코드의 값 |
|---|---|---|
| 1 | 내장 등록부 서명 실패 시 지갑 전체 멈춤 vs 낮춤(모든 게임 미검증) | `BUILTIN_REGISTRY_FAILURE_POLICY = 'halt'`(기존 동작) |
| 2 | 운영 목록 키: 누가·어디서 만들고 보관(하드웨어 키·예비 키·두 사람) | `SIGNED_LISTS_PUBLIC_KEYS = []`, `CREATOR_ALLOWLIST_PUBLIC_KEYS = []` → 아무 묶음도 안 믿음 |
| 3 | 받은 목록이 결제를 열거나 결제 주소를 바꿀 수 있게 할지 | `HOT_UPDATE_MAY_OPEN_PAYMENT = false`(결제 변경은 지갑 릴리스로만) |
| 4 | 키 전환 승인 정족수(지금 키 1개 + 새 키 vs 2개 이상) | 1개 + 새 키 |
| 5 | 묶음 기본 만료 기간·재서명 주기 | 30일(최대 180일), 지갑 갱신 6시간마다 |
| 6 | 신청서 받는 경로·소각 확인 방법(누가 노드로 확인해 `burns.json` 을 만드나) | 형식·도구만 |
| 7 | 전달 경로: 지갑 사이트 정적 파일만 vs IPFS 포인터 병행(사이트 배포 없이 갱신) | 둘 다 어댑터 있음, 지갑 기본은 사이트 파일 하나 |
| 8 | 만료된 묶음의 차단 유지(지금) vs 차단도 해제 | 차단 유지 |
| 9 | 데스크탑이 목록을 받아 오는 Rust 명령 추가 여부 | 없음(늘 기본 목록) |
