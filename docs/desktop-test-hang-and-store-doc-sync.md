# 데스크탑 시험 정체 원인 · 가게 문서(store-doc) 동기화 준비 (2026-10-14)

## 1. `npm test` 가 「108번째 뒤에서 멈춘다」 — 원인
- 멈춘 파일은 **없다**. 파일 하나씩 따로 돌리면 36개 모두 끝난다(기준선 실패 1 = `sales-account.test.mjs:50` 제외, 아래 시간표).
- 전체를 한 번에 돌리면 `node --test` 가 파일들을 동시에 돌리고, 결과는 **파일 순서대로** 출력한다. 느린 파일(`memory-budget-browser` 단독 179초,
  `layout-gate-browser` 101초)이 앞 순번에 있으면 그 뒤 결과가 안 보여서 멈춘 것처럼 보인다. 동시에 다른 작업 폴더의 vite/esbuild·Chrome 이 CPU 를 나눠 쓰면 더 느려진다.
- 이번 실측: 전체 완주 430~445초(종료코드 1 = 기준선 1건). 314개 중 통과 297 · 실패 1 · 건너뜀 16 · 취소 0.
  (이전 보고의 311개 → 314개: 그 사이 다른 커밋의 시험이 늘었다. 새 실패 없음.)
- 크롬 누수: 이 저장소의 브라우저 시험 18개는 모두 `close()` 한다. 완주 뒤 이 저장소가 띄운 headless Chrome 은 0개.
  남아 있는 오래된 headless Chrome(3일 전 `rv-mkt-chrome-*` 등)은 이 작업이 띄운 것이 아니라 건드리지 않았다.
- 고친 것: `npm test` 에 `--test-timeout=900000`(시험 하나당 15분) — 진짜로 멈추는 시험이 생기면 무한 대기 대신 실패로 끝난다. 시험 내용·기준은 그대로.
  (혼자 돌릴 때 가장 긴 시험이 3분이라 정상 상태에서는 걸리지 않는다.) 확인용으로 보고 싶으면 `node --test --test-reporter=spec <파일들>` 로 순서 없이 진행이 보인다.
- `sales-account.test.mjs:50` 기준선 실패: 비교 대상 `/Users/gimmusong/wt-rv-web1008` 에 node_modules 가 없어 esbuild 가 의존성을 못 찾는다(환경 문제, 코드 문제 아님).

시간표(단독): memory-budget 179s · layout-gate 101s · window-modes 49s · settings-talk 48s · i18n-packs 49s · creator-publish-browser 48s · 나머지 각 0~16s (합계 약 10분).

## 2. 가게 문서(번호 storeId)를 데스크탑에서 만드는 길 — 설계만 (동기화는 「대기」)
기준: 통합 `/Users/gimmusong/wt-rv-real-integ` (e9ec2f4). 가게 키 쪽 브랜치 `claude/rv-storekey`(12b9dae)는 core 에 `core/store/store-key.ts`·`store-key.test.ts`,
`core/wallet-keys/derive.ts` 의 hardened 경로 함수를 더하는 중이다(폰도 같은 PATH_SHOP 로 전환 중). 그것이 통합에 합쳐진 뒤에 동기화한다.

### 복사 대상 (바이트 그대로, 데스크탑 core 에 없는 것)
| 파일 | 용도 |
|---|---|
| core/store/store-doc.ts | 가게 문서 v1: 본문 만들기·서명·검증·rev 체인, `storeIdOf`(rev0 = 본문 해시) |
| core/store/limits.ts | 길이·기간 상수, STORE_SIGN_DOMAIN |
| core/store/photo.ts | 사진 규격·SSRF 검사(store-doc 이 import) |
| (키 쪽) core/store/store-key.ts | storekey 가 합쳐지면 포함 — PATH_SHOP 경로 상수·파생 |
이미 있고 통합 원본과 **바이트 같음**: core/store/claim-words.ts · ssrf-host.ts, core/creator/{bytes,limits,product-doc,media-ref,download-terms,product-lock-shape,product-preview,trade-primitives,operating-keys}.ts,
core/brand/forbidden-phrases.ts, core/signer/{signmessage,test-key}.ts, core/wallet-offline/base58check.ts.
의존 npm: `@noble/curves`(1.9.7)·`@noble/hashes` 이미 package.json 에 있음 → 새 패키지 없음.

### 복사하면 안 되는 것 (데스크탑 전용 어댑터라 원본과 다름)
- core/crypto-backend.ts · core/playx-asset-proof/crypto.ts — 데스크탑 쪽이 다른 파일이다. 덮어쓰면 안 된다(3차 동기화도 어댑터에만 한 줄씩 추가).
- core/wallet-keys/derive.ts — 이미 원본과 다르다(`vendor-sha256.json` 에 고정 안 됨, wallet-keys/PROVENANCE.md 기준). storekey 합류 뒤 hardened 함수 3개가 필요하면 그 파일만 따로 판단.
  단 데스크탑 가게 키는 Rust(`storesign.rs`)가 파생하므로 TS 쪽 derive 는 필요 없을 수 있다 — store-key.test.ts(PATH_SHOP 바이트 일치)는 지갑 저장소에서 돈다.

### 동기화 절차 (e8968a1 방식)
1. 위 파일을 통합 원본에서 `cp`(바이트 복사, 줄바꿈 변환 금지).
2. `core/creator/vendor-sha256.json` 의 files 에 3(+1)개 해시 추가, `source` 문구 갱신.
3. `core/creator/PROVENANCE.md` 에 「4차 동기화」 단락(커밋 SHA, 패치 없음, 가게 문서는 시험·화면에서만 import) 추가.
4. 시험 영향: `scripts/creator-publish.test.mjs` 의 `assert.equal(files.length, 64)` → 새 개수로(64→67, store-key 포함 시 68). 같은 시험이 원본(`RV_WALLET_CORE`)과도 비교한다.
   store-doc 의 시험(`store.test.ts`, `store-vectors.json`, `fixtures.ts`)은 지갑 저장소에서 돌고 `og-guard`·`seller-notice`·`test-assert` 에 의존하므로 복사하지 않는다.
   데스크탑 쪽에는 「store-doc 을 번들해 `tauriStoreKey` 서명으로 rev0 문서 생성 → verifyStoreDoc 통과」 시험을 새로 한 개 둔다(가짜 시드만, `scripts/fixtures/creator-core-entry.ts` 처럼 esbuild 번들).
   `tsc --noEmit`(tsconfig include = src 만)에는 영향 없음, src 에서 import 할 때부터 포함된다.
5. 그 다음에야 화면: 가게 이름·소개·카테고리·지역 입력 → store-doc 본문 → `store_sign_digest`(앱 잠금 중 거절·사장 확인) 서명 → 올리기는 기존처럼 잠금 유지.

### 막힌 점 / 대표 결정
- 동기화는 `claude/rv-storekey` 가 통합에 합쳐진 뒤. 지금은 **대기**.
- 데스크탑 어댑터 2개가 원본과 달라 「전부 덮어쓰기」 식 동기화는 안 된다 — 파일 목록 기준으로만.
