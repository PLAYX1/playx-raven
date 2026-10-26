# 레이븐볼트 「내 게임·음악 올리기」 1단계 (creator publish)

작성 2026-10-10. 같은 문서가 두 저장소에 있다: 지갑 `ravenvault`(규칙 `core/creator/*`, 브랜치 `claude/rv-creator-core`)와
데스크탑 `playx-raven`(화면, 브랜치 `claude/rv-creator`). 설계 근거: 게임 저장소 `docs/design/asset-game-market.md`(f6a4fcd) §2·§3·§4·§5.
수수료는 규약 v4(지갑 5a25a3a · 게임 f070178) 그대로다.

> **2026-10-10 2단계(누구나 판매)로 바뀐 것** → `docs/open-seller-platform.md`: 이름은 대표 확정 `RV.<종류글자>.<작품이름>`(예: `RV.M.FOREST`, 제작자가 직접 발행하는 루트, 500 RVN 보증), 매니페스트 v2(게임·음악·책·티켓·디지털, `details` 칸, 이름 종류 글자 = type), 신뢰 3층(미검증·보증·검증됨)과 차단 목록, 판매 스위치. 아래 「임시 접두어 `<임시>/`」·v1·`game`/`music` 칸 설명은 1단계 기록이다(1단계 임시 접두어 이름은 폐기됐고 지금 검사에서 거절된다).

**이번 단계에서 실제로 하지 않은 것**: 실제 IPFS 업로드, 실제 자산 발행(소각), 메인넷 거래, 소각액의 체인 대조, 외부 핀 서비스 연결,
구매자 화면. 전부 모의 보관소·모의 발행기·시험망 응답으로만 시험했다. 법률·세무 판단은 하지 않았다(전문가 확인 필요).

---

## 1. 흐름

```
제작자(데스크탑, 판매자 기능 켬) ─ 게임 탭 「내 게임·음악 올리기」
 1 종류 고르기: 게임(웹 묶음) | 음악(오디오 + 표지)
 2 정보: 제목·설명·자산 이름(<임시>/…)·가격(RVN)·제작자 주소·받는 주소 (+ 게임: 여는 파일·외부 링크·요청 기능 / 음악: 미리듣기 구간)
 3 파일 고르기 → 「검사하기」: 크기·확장자·MIME·파일 머리·경로·글자 파일 UTF-8 → 문제(거절) / 경고(진행 가능)
 4 「올리고 서명하기」
     파일마다 보관(pin) → CID·SHA-256·크기 → 매니페스트(JSON)
     → 노드 signmessage(제작자 주소) → 받는 사람과 똑같이 자기 검사 → 매니페스트 보관 → 매니페스트 CID
 5 발행 전 확인: 자산 이름 · 소각 비용(대조 상태) · 매니페스트 CID · 네트워크 · 되돌릴 수 없음 4줄 · 막는 이유
     → 이름을 똑같이 다시 적어야 「발행하기」가 켜짐
     → issue NAME qty=1 units=0 reissuable=true ipfs_hash=<매니페스트 CID>
 6 발행 결과: 거래 번호 + 「등록 신청서」(rv-creator-listing-request, status unverified) — 저장·전달용
```

- 발견은 서버 없이 체인 자산 검색(`listassets "<임시>/*"`)으로 한다(`discoverListings`). 매니페스트를 못 받거나 서명·형식이 틀리면 숨긴다.
- 보이는 것은 전부 「미검증」 — 외부 링크로만 열고 지갑 신원·결제를 연결하지 않는다(설계 §3).
- 대표가 서명한 **제작자 허용 목록**에 (자산·종류·매니페스트 CID·매니페스트 바이트 SHA-256·제작자 주소·받는 주소)가 전부 같고 `verified` 일 때만
  「검증됨」이고, 그때만 지갑 안에서 열리거나 결제가 붙는다. 하나라도 바뀌면(새 매니페스트·받는 주소 변경) 다시 미검증(`changed-since-review`).
- 결제는 검증됨 + 가격 있음 + 매니페스트 선언 수수료율 = 목록 수수료율일 때만 열린다.

### 판매자 기능 스위치
- 입구(`#creator-open`)와 화면(`#page-creator`) 모두 `data-seller-only hidden inert`. 스위치(설정 → 판매자 기능, `localStorage rv-seller-mode`)를 끄면
  렌더·Tab·접근성 트리·프로그램 이동 전부 막힌다(`showPage` 가 `creator` 를 거절). 0.8.5 판매 대금 화면과 같은 방식.
- **보안 경계가 아니다.** 숨김은 복잡한 메뉴를 판매하지 않는 사람에게서 치우는 것뿐이다. 발행·서명은 노드 지갑이 직접 묻는다.

## 2. 매니페스트 `rv-creator-manifest` v1

IPFS 에 올리는 바이트 = **정본 JSON**(키 정렬·공백 없음·정수만, UTF-8). 그래서 허용 목록이 바이트 SHA-256 을 고정할 수 있다.

| 칸 | 규칙 |
|---|---|
| `format` `version` | `rv-creator-manifest`, `1`. 모르는 칸·빠진 칸은 거절(엄격) |
| `type` | `game` \| `music`. `game` 이면 `game` 칸 필수·`music` null, 반대도 같다 |
| `asset` | 이 매니페스트를 가리키는 자산 이름. 체인 자산과 다르면 거절(남의 매니페스트 도용 방지) |
| `title` `description` | 1~80자, 0~2000자. 제어 문자·양방향 제어 문자 금지 |
| `files[]` | `{path, cid, sha256, size, mime}`. CIDv0(`Qm…` 46자)만 — 체인이 CIDv0 만 받는다(데스크탑 upload.rs). 경로는 상대 경로·영문만, `..`·숨김 파일 금지 |
| `cover` | 표지 1장(PNG·JPG·WEBP) 또는 null |
| `creator` | `{address, receivingAddress}` — 서명 주소, 판매 대금 받을 주소(R… P2PKH) |
| `price` | `{atoms: "정수 문자열"}` 또는 null(무료). 상한 100,000 RVN. 수수료를 떼고 판매자 몫이 먼지(1000 atoms) 이상이어야 한다 |
| `fee` | `{policy: "rv-platform-fee-v4", declaredBps}` — 제작자가 **동의한 요율의 선언**. 실제 율·수수료 주소는 허용 목록·서명된 게임 등록부가 정한다 |
| `game` | `{entry(html), origin(https 또는 null — ex.erci.se 금지), capabilities{identity, payment}}`. 결제 요청은 가격이 있어야 한다 |
| `music` | `{previewFile, previewStartMs, previewEndMs}` — 구매 전 미리듣기, 1~60초 |
| `createdAt` | ISO 시각 |
| `signature` | `{scheme: "rvn-signmessage", domain: "RAVENVAULT-CREATOR-MANIFEST-V1", address, value}` |

서명 문구(노드 `signmessage` 가 서명하는 글):
```
RAVENVAULT-CREATOR-MANIFEST-V1
<자산 이름>
sha256:<signature 칸을 뺀 매니페스트 정본 JSON 의 SHA-256 hex>
```
검증은 65바이트 복구형 서명에서 주소를 되살려 `signature.address` = `creator.address` 와 비교한다. 레이븐코인 표준 메시지 해시
(`\x16Raven Signed Message:\n` + varint 길이)는 지갑 `ravencoinMessageHash` 와 같은 결과임을 시험으로 대조했다.
**실제 노드 signmessage 출력과는 대조하지 못했다**(노드 미사용 — 확인 필요, 아래 §5).

파일 검사 상한(초안, `core/creator/limits.ts` 한 곳): 게임 파일 하나 25MB·전체 200MB·2000개, 음악 파일 하나 200MB·전체 400MB·20개, 표지 5MB, 매니페스트 64KB.
허용 확장자는 표로 고정, 확장자↔MIME 일치, 바이너리는 파일 머리(PNG·JPG·GIF·WEBP·WAV·OGG·FLAC·MP3·M4A·WASM·WOFF·GLB) 일치, 글자 파일은 UTF-8.
음악 묶음에는 HTML·JS·SVG 가 못 들어간다.
경고(거절 아님): 외부 스크립트, eval·new Function, 바깥 창 접근(parent/top/opener), 채굴 이름, 복구 단어·개인키를 묻는 글, SVG 안 스크립트, 그리고 게임은 늘 「코드를 실행해요」.
화면은 언제나 「자동 검사는 나쁜 코드를 다 찾아내지 못해요」를 같이 보인다.

## 3. 자산 이름·소각

- 접두어 상수 `CREATOR_ASSET_PREFIX = '<임시>/'`(`core/creator/asset-name.ts` 한 곳, **임시**). `/` 로 끝나므로 **하위 자산**이다:
  부모 주인 표 `<임시>!` 를 가진 지갑만 발행할 수 있고, 소각은 하위 기준 100 RVN(저장소 기재값). 즉 이 값 그대로면 「누구나 올리기」가 아니다.
  확인 화면은 지갑에 `<임시>!` 가 없으면 발행을 막는다. `<임시>.` 처럼 점으로 바꾸면 루트(500 RVN·누구나)로 바뀐다(시험 있음).
- 이름 규칙: 영문 대문자·숫자·`.`·`_`, 점·밑줄 연속/처음/끝 금지, RVN·RAVEN·RAVENCOIN 금지, 전체 30자(주인 표 `!` 자리). assets.cpp 정규식을 옮긴 것이며 이번에 원본을 다시 대조하지 않았다.
- 소각액: 루트 500·하위 100·고유 5·재발행 100 RVN(데스크탑 issue.rs·issue2.rs 상수). 노드에 묻는 RPC 가 없어 **체인 파라미터와 대조할 수 없다** →
  화면에 「체인과 대조: 확인 불가」로 표시한다. 대조 값이 들어오는데 다르면(`mismatch`) 발행을 막는다.
- 실제 메인넷 발행 스위치 `REAL_MAINNET_ISSUE_ENABLED`(`core/creator/publish.ts` ← `core/creator/mainnet-switch.json` 의 `issue`, 커밋된 기본값 false). 꺼져 있는 동안 메인넷에서는 발행 단추가 잠기고, 시험망(test·regtest)에서만 노드 `issue_asset` 을 부른다.
- 발행 형태: qty 1, units 0, reissuable true(매니페스트를 고치려면 재발행이 필요하므로 잠그지 않는다). 발행 명령은 기존 `issue_asset`(주인 표 제자리 유지 포함)을 그대로 쓴다.

## 4. 보관(pin) 어댑터 — 누가 계속 붙들고 있나

| 어댑터 | 상태 | 누가 붙드나 |
|---|---|---|
| `local-kubo` (기본) | 구현(기존 `ipfs_add_file`, `pin=true&cid-version=0`) | **제작자 컴퓨터**. 꺼져 있거나 파일을 지우면 다른 사람이 못 받는다 |
| `mock` | 구현(시험 전용, 모양만 CIDv0 인 가짜 CID) | 아무도 |
| 외부 핀 서비스 | 자리만(`UnconfiguredPinService`, 부르면 실패) | 미정 — 서비스·계정·비용 주체가 대표 결정 |

검증된 항목은 설계 §2.6 대로 우리 노드도 고정하는 방안이 있다(데스크탑 `peers.rs` 방식). 1단계에는 넣지 않았다.

## 5. 구매자 쪽 (1단계: 데이터 모델·인터페이스·시험)

- `core/creator/purchase.ts`(지갑만). 검증된 항목을 게임 등록부 항목(`GameEntry`) 모양으로 바꿔 지갑의 **기존 v4 부품을 그대로** 쓴다:
  `checkCreatorPurchase` → `planDirectPayment` → `signDirectPayment`(서명 전 `inspectDirectPayment` 정확 일치).
- 거래 = 제작자 출력(가격 − 수수료) + RVDP v3 메모(gameIndex = 허용 목록 번호) + 플랫폼 수수료 출력 + 잔돈. 시험: 300 RVN → 255 + 45(초안 15%).
- 구매 목록 합류: 같은 `GameEntry` 로 기존 `readDirectHistory`(두 독립 출처)를 부르면 기존 직접 결제 이력과 같은 형식이 나오고, 게임 원본 검증기
  `verifyDirectPurchases` 가 그 거래를 `confirmed` 로 인정한다(시험).
- 미검증·수수료율 불일치·플랫폼 수수료 주소 없음 → 결제 없음. 허용 목록 gameIndex 가 게임 등록부 번호와 겹치면 거절. 65535 는 시험용 예약.
- 음악 미리듣기: `previewWindow(listing)` = 매니페스트 구간. 미검증은 외부 링크에서만 재생.
- 화면(구매 단추·미리듣기 플레이어)은 아직 없다.

## 6. 허용 목록 `rv-creator-allowlist` v1 (「검증됨」)

- 항목: `asset, type, manifestCid, manifestSha256, creatorAddress, receivingAddress, gameIndex, feeBps, origins, status(verified|suspended), verifiedAt`.
- 서명: Ed25519 분리 서명, 바이트 = `RAVENVAULT-CREATOR-ALLOWLIST-V1\n<listVersion>\n<issuedAt>\n<정본 JSON>`. 게임 등록부와 같은 방식이지만 도메인이 달라 서로 재사용할 수 없다(시험).
- **내장 공개키 목록 `CREATOR_ALLOWLIST_PUBLIC_KEYS` 는 비어 있다.** 운영 키를 정하기 전에는 출하 앱에서 아무것도 검증됨이 되지 않는다. 시험은 일회용 키를 쓴다.
- 만료(`expiresAt`)·원격 갱신(설계 B2)은 2단계.

## 7. 위험

1. **소각액 미대조** — 저장소 상수가 틀리면 사람이 본 금액과 실제 소각이 다르다. 메인넷 스위치를 켜기 전에 원본 chainparams·시험망 실측으로 대조해야 한다.
2. **접두어 `<임시>/` 는 하위 자산** — 체인에 `<임시>` 가 발행돼 있는지, 누가 `<임시>!` 를 가졌는지 확인하지 않았다. 이 값 그대로면 제작자는 직접 발행할 수 없다.
3. **핀 주체 없음** — 기본은 제작자 컴퓨터. 꺼지면 매니페스트·파일을 못 받아 목록에서 숨겨진다.
4. **악성 콘텐츠** — 파일 검사는 실수·위장만 거른다. 미검증은 지갑 안에서 실행하지 않는 것이 실제 방어다. 미검증 목록 노출 범위 자체가 법률 확인 항목.
5. **서명 형식** — 노드 signmessage 실제 출력과 대조하지 않았다(복구 바이트 27~34 가정). 실패하면 화면이 「서명 확인 실패」로 멈추고 매니페스트를 올리지 않는다(안전한 쪽).
6. **정본 JSON** — 정수만 허용하는 정렬 키 JSON. JCS(RFC 8785) 를 공식 채택할지 결정 필요(지금 문서에 소수가 없어 결과는 같다).
7. **매니페스트 크기·파일 수 상한**은 근거 없는 초안.
8. 법률·세무(통신판매중개·가상자산·게임물 등급·콘텐츠 책임·수수료 매출)는 **전문가 확인 필요**. 이 문서는 판단하지 않는다.

## 8. 대표 결정 목록

| # | 결정 | 지금 코드의 임시값 | 메모 |
|---|---|---|---|
| 1 | 핀(보관) 서비스와 비용 주체 | 제작자 컴퓨터(kubo), 외부 서비스 자리만 | 검증 항목은 우리 노드도 고정할지 |
| 2 | 자산 접두어·방식 | ~~`<임시>/`(하위, 100 RVN, `<임시>!` 필요)~~ → **대표 확정 `RV.<종류>.<이름>`**(루트, 500 RVN, 누구나) | 남은 확인은 `docs/open-seller-platform.md` §9 #2(체인 중복 조회·예약어 원본 대조) |
| 3 | 수수료율 | 초안 15%(`DRAFT_PLATFORM_FEE_BPS`) | 규약 v4 상수 하나 |
| 4 | 검증 방식·운영 키 | 허용 목록 Ed25519, 내장 키 없음 | 키 생성 장소·두 사람 확인·만료(B2) |
| 5 | 미검증 노출 범위 | 발견은 되지만 외부 링크만 | 기본 화면에 숨길지(설계 T12), 한국 사용자 처리 |
| 6 | 메인넷 발행 켜기 | `core/creator/mainnet-switch.json` `issue: false` (docs/mainnet-enable.md) | 소각액 대조·접두어·핀 주체 결정 뒤 |
| 7 | 등록 신청서 전달 경로 | 화면에서 복사만 | 대외 메일 등 |
| 8 | 파일 크기·개수 상한 | 게임 25MB/200MB/2000, 음악 200MB/400MB/20 | 보관 비용과 함께 |
| 9 | 법률 확인 | — | 통신판매중개·특금법·게임물 등급·콘텐츠 책임·세무 — 전문가 확인 필요 |

## 9. 파일

- 지갑: `core/creator/{bytes,limits,asset-name,manifest,publish,listing,purchase}.ts`, 시험 `core/creator/creator.test.ts`.
- 데스크탑: `core/creator/*`(지갑에서 바이트 그대로 복사, `vendor-sha256.json` 고정, `PROVENANCE.md`), `core/game-registry/platform-fee.ts`(복사),
  `src/creator-publish.ts`·`.css`, `index.html`(`#creator-open`, `#page-creator`), `src/main.ts`(배선·라우트 차단),
  시험 `scripts/creator-publish.test.mjs`, `scripts/creator-publish-browser.test.mjs`, `scripts/fixtures/creator-core-entry.ts`, `scripts/desktop-ui-browser.test.mjs`(판매자 입구 목록에 추가).
