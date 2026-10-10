# core/creator — 지갑 저장소에서 복사

원본: `ravenvault` 저장소 `core/creator/*` (브랜치 `claude/rv-asset-name-rv`, 기준 `d9ac1c3` 위 — 2단계 누구나 판매 + 대표 확정 이름 `RV.<종류>.<이름>`).
아래 파일은 원본과 **바이트가 같아야** 한다. SHA-256 은 `vendor-sha256.json` 에 고정했고 `scripts/creator-publish.test.mjs` 가 확인한다
(원본 체크아웃이 있으면 원본과도 직접 비교하고, 없으면 그 시험만 SKIP 으로 명시한다).

- `core/creator/bytes.ts` · `limits.ts` · `asset-name.ts` · `manifest.ts` · `publish.ts` · `listing.ts` · `open-market.ts` · `ticket.ts`
- `core/game-registry/platform-fee.ts` (수수료 분할 — 지갑 v4 와 같은 파일)

복사하지 않은 것: `core/creator/purchase.ts`(구매자 거래 — 지갑의 직접 결제 부품에 기댄다)와 시험 파일. 구매자 쪽 거래 시험은 지갑 저장소에서 돈다.

`manifest.ts` 는 `core/wallet-offline/base58check.ts`(이미 같은 바이트로 복사돼 있음)와 `core/playx-asset-proof/crypto.ts` 의 `concatBytes` 를 쓴다.
규칙을 고칠 때는 지갑 저장소에서 고치고 시험한 뒤 다시 복사하고 `vendor-sha256.json` 을 갱신한다. 이 폴더에서 직접 고치지 않는다.
