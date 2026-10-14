# core/creator — 지갑 저장소에서 복사

원본: `ravenvault` 저장소 `core/creator/*` (브랜치 `claude/rv-wallet-lock` = `claude/rv-wallet-mainnet-integrated` 위에 구매자 열람권(RV-LOCK v1)을 얹은 것; 그 아래 통합 브랜치 `claude/rv-wallet-mainnet-integrated` — 메인넷 발행·판매 준비 통합 2026-10-12, 그 아래로 `claude/rv-asset-name-rv`·`claude/rv-signed-lists-core` 의 규칙 포함).
아래 파일은 원본과 **바이트가 같아야** 한다. SHA-256 은 `vendor-sha256.json` 에 고정했고 `scripts/creator-publish.test.mjs` 가 확인한다
(원본 체크아웃이 있으면 원본과도 직접 비교하고, 없으면 그 시험만 SKIP 으로 명시한다).

- `core/creator/bytes.ts` · `limits.ts` · `asset-name.ts` · `manifest.ts` · `publish.ts` · `fee-schedule.ts` · `listing.ts` · `open-market.ts` · `ticket.ts` · `lock.ts` · `lock-payment.ts` · `clip.ts`
  (`fee-schedule.ts` = 장터 수수료 일정 — 지갑 브랜치 `claude/rv-signed-lists-core` 위 2026-10-11, docs/fee-schedule.md)
- 통합(2026-10-12) 새 파일: `core/creator/mainnet-switches.ts` · `operating-keys.ts` · `payment-allowlist.ts` · `purchase-plan.ts` + `purchase-plan-vectors.json` · `owner-id.ts` + `owner-id-vectors.json`, `core/signed-lists/market-catalog.ts`(서명된 상품 목록 클라이언트 — 아직 화면에 연결하지 않음).
  `publish.ts`·`open-market.ts` 는 스위치 값을 `mainnet-switches.ts` 에서 다시 내보내는 지갑 원본 그대로다 — **패치 없음**(이전 0.9.2 의 「스위치 두 줄 패치」는 사라졌다).
  `core/creator/mainnet-switch.json` 도 지갑 원본과 같은 파일이지만 enable 커밋이 바꾸는 파일이라 `vendor-sha256.json` 에 해시를 고정하지 않는다(지갑 `scripts/check-mainnet-switches.mjs --desktop` 가 확인).
- 열람권(RV-LOCK v1, 2026-10-13) 새 파일: `core/creator/lock.ts`(조각 암호화·열람 요청/허가·판매자 처리) · `core/creator/lock-payment.ts`(판매자 몫 검사기) · `core/creator/clip.ts`(미리듣기 클립 PCM→WAV).
  `manifest.ts`(선택 `lock` 칸·음악 미리듣기 끔)·`publish.ts`(`lock` 옵션)는 같은 원본의 갱신본이다 — **패치 없음**. 시험(`lock.test.ts` · `lock-vectors.json`)은 지갑 저장소에서 돈다.
  🔴 암호 조합은 독립 검수 전이다(lock.ts 머리 주석).
- `core/game-registry/platform-fee.ts` (수수료 분할 — 지갑 v4 와 같은 파일)
- `core/signed-lists/envelope.ts` · `creator-parts.ts` · `sources.ts` (서명된 허용·차단 목록 실행 중 갱신 — 지갑 브랜치 `claude/rv-signed-lists-core`. 지갑 쪽 `wallet.ts`·`boot.ts`(게임 등록부 연결)는 복사하지 않았다)

- 동기화(2026-10-14, 지갑 통합 브랜치 `claude/rv-real-integ` 커밋 `25329eb` — 리뷰 수리 fix1·fix2·fix3 이후): `publish.ts`·`market-catalog.ts` 갱신본 + 새 파일 `core/creator/asset-testnet.ts`(노드 망 확인 `confirmNodeChain` — `planIssue` 의 `chain` 은 이제 확인 결과만 받는다) · `core/creator/manifest-assemble.ts` · `core/brand/brand.ts` · `core/brand/legacy-asset.ts` — 패치 없음, `vendor-sha256.json` 갱신.
  옛 `RV.` 이름 새 발행은 core 가 막는다(`legacyIssueGuard`, 우회 칸 없음). 데스크탑 화면은 그와 별개로 `src/creator-pause.ts` 의 `CREATOR_PUBLISH_PAUSED` 로 올리기·등록 단추를 잠근다(대표 결정 2026-10-14).
  `core/creator/legacy-manifest-fixture.ts` 도 같은 원본에서 복사했다 — **시험 전용**(이미 있는 옛 상품을 시험 안에서 재현해 읽기·검증·구매·열람 경로를 시험). 앱 코드(`src/**`)는 이것과 `manifest-assemble.ts` 를 import 하지 않는다(`scripts/creator-publish.test.mjs` 가 확인).

- 2차 동기화(2026-10-14, 지갑 통합 브랜치 `claude/rv-real-integ` 커밋 `91aef5a`): `lock.ts` 갱신(열람 함수가 `LockHolder` = asset+lock 두 칸만 받음 · 확인 수 6 을 `FINAL_MIN_CONFIRMATIONS` 로) + 새 의존 파일 `core/receipts/params.ts`, `core/game-registry/platform-fee.ts` 주석 갱신 — 패치 없음, `vendor-sha256.json` 갱신.
  상품 문서(`RAVENVAULT-PRODUCT-V1`, 지갑 `core/creator/product-doc.ts` — §38 새 선택 칸 lock·lock.files[].cipher·format·downloadDays·media 객체 항목)는 **데스크탑이 읽지 않는다**(Rust·TS 어디에도 파서 없음) — 복사하지 않았다.
  데스크탑이 읽는 것은 제작자 매니페스트(`rv-creator-manifest` v2, 위 `manifest.ts`)뿐이고, 그 lock 칸은 지갑 원본과 같게 정확한 키만 받는다. `scripts/lock-ui.test.mjs` 가 둘 다 고정한다.

- 3차 동기화(2026-10-14, 지갑 통합 브랜치 `claude/rv-real-integ` 커밋 `6c923e2`): 기기 증서 `core/device/*`(cert · revoke · data-key · index) · CSV 대량 등록 `core/creator/bulk-products.ts` · 상점 주문 `core/shop-order/*`(직원 권한 확대) · 영수증 `core/receipts/*`(기간 합계 CSV · 복원 연습) 과 이들이 import 하는 파일 전부(`core/brand/*` · `core/store/*` · `core/signer/*` · `core/creator/{product-doc,media-ref,download-terms,fee-policy,fee-track-v2,product-lock-shape,product-preview,trade-primitives}.ts`)를 바이트 그대로 복사 — 패치 없음. 방식: 이전 동기화와 같다(지갑 체크아웃에서 복사 → `vendor-sha256.json` 갱신 → `scripts/creator-publish.test.mjs` 가 고정 수와 원본 일치 확인; 별도 동기화 스크립트는 없다).
  데스크탑 전용 어댑터 `core/crypto-backend.ts` · `core/playx-asset-proof/crypto.ts` 는 지갑 본문이 아니라 고정하지 않는다 — 후자에 `hexToBytes` · `utf8Bytes` 두 함수를 지갑 본문 그대로 더했다. `tsconfig.json` 의 lib 를 ES2022 로 올렸다(`Object.hasOwn` 타입).

- 4차 동기화(2026-10-14, 지갑 통합 브랜치 `claude/rv-real-integ` 커밋 `0334229`): 가게 문서 `core/store/{store-doc,limits,photo,store-key}.ts` 를 바이트 그대로 복사 — 패치 없음. 가게 문서는 시험과 「가게 문서 만들기」 화면(`src/store-doc-ui.ts`)에서만 import 한다(올리기·공개 길 없음).
  `store-key.ts` 가 쓰는 hardened 경로 파생(`HardenedKeyPath` · `derivePrivateKeyAtHardenedPath` 등) 때문에 `core/wallet-keys/derive.ts` 를 통합 원본과 같은 파일로 바꿨다(옛 파일에 함수 3개와 타입 하나를 더한 것뿐 — 기존 함수 불변; 데스크탑 전용 어댑터 `crypto-backend.ts`·`playx-asset-proof/crypto.ts` 는 건드리지 않았다). 앱의 가게 키 파생은 여전히 Rust(`storesign.rs`)이고, TS 쪽 `store-key.ts` 는 시험에서 Rust 와 바이트가 같은지 확인하는 데만 쓴다.
  시험 파일(`store.test.ts` · `store-vectors.json` · `fixtures.ts` · `store-key.test.ts`)은 복사하지 않았다 — 지갑 저장소에서 돈다.

복사하지 않은 것: `core/creator/purchase.ts`(구매자 거래 — 지갑의 직접 결제 부품에 기댄다)와 시험 파일. 구매자 쪽 거래 시험은 지갑 저장소에서 돈다. 데스크탑은 `purchase.ts` 대신 공통 순수 부품(`purchase-plan.ts`·`payment-allowlist.ts`·`owner-id.ts`)을 쓰고, 러스트 거래 검사는 같은 공유 벡터로 시험한다.

`manifest.ts` 는 `core/wallet-offline/base58check.ts`(이미 같은 바이트로 복사돼 있음)와 `core/playx-asset-proof/crypto.ts` 의 `concatBytes` 를 쓴다.
규칙을 고칠 때는 지갑 저장소에서 고치고 시험한 뒤 다시 복사하고 `vendor-sha256.json` 을 갱신한다. 이 폴더에서 직접 고치지 않는다.
