# 폰 core 재사용

참고 저장소: `/Users/gimmusong/wt-rv-web1008` (판매 계정 설계와 SalesAccount 화면).

다음 네 파일은 해당 저장소에서 바이트 변경 없이 가져왔습니다.

- `core/wallet-keys/derive.ts`
- `core/wallet-keys/sales-account.ts`
- `core/official-sales/xpub.ts`
- `core/wallet-offline/base58check.ts`

`core/crypto-backend.ts`와 `core/playx-asset-proof/crypto.ts`는 이 네 파일에 필요한 최소 플랫폼 어댑터입니다. 전자는 기존 noble 구현을 호출하고 후자는 바이트 연결·공개키 16진수 변환만 제공합니다.

제품 렌더러는 `official-sales/xpub.ts`와 계정 상수만 사용합니다. seed를 받는 `derive.ts`는 교차 시험에만 사용하고, 실제 지갑의 비밀 파생은 Rust `sales_account.rs`에 둡니다. TypeScript 구현을 렌더러에 실행하기 위해 실제 seed를 꺼내지 않습니다.

`npm test`는 기존 공개 BIP39 fixture를 메모리에서 읽어 계정과 주소를 비교합니다. 추가된 `sales-public-vectors.json`은 기존 fixture의 순번과 공개 결과만 담습니다. 원본 저장소가 있으면 원본 코드와 바이트 동일성 및 실행 결과도 검사하고, 없으면 그 시험만 SKIP으로 명시합니다. Rust도 같은 공개 결과를 비교합니다. 단어·seed·개인키·암호를 새 fixture나 출력에 기록하지 않습니다.


2026-10-14 갱신: `core/wallet-keys/derive.ts` 는 이제 통합 원본(`wt-rv-real-integ`, 0334229)과 바이트가 같다. 옛 파일에 가게 키용 hardened 경로 함수(`HardenedKeyPath` · `hardenedPathString` · `derivePrivateKeyAtHardenedPath` · `deriveAddressAtHardenedPath`)만 더해졌고 기존 함수는 그대로다(`scripts/sales-account.test.mjs` 가 통합 원본과 비교).
