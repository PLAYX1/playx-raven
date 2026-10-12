/*
 * 운영 서명 공개키 — 한 곳. (메인넷 발행·판매 준비 C4, 2026-10-12)
 *
 * 대표가 오프라인 기기에서 만든 Ed25519 운영 서명 키의 **공개키**만 여기에 둔다. 이 배열 하나가 아래 세 자리를 모두 채운다:
 *   · core/signed-lists/envelope.ts  SIGNED_LISTS_PUBLIC_KEYS      — 서명된 목록 묶음(바깥 서명)
 *   · core/creator/fee-schedule.ts   FEE_SCHEDULE_PUBLIC_KEYS      — 수수료 일정 안쪽 서명
 *   · core/creator/listing.ts        CREATOR_ALLOWLIST_PUBLIC_KEYS — 제작자 허용·차단 목록 안쪽 서명
 *   · core/signed-lists/market-catalog.ts — 장터 상품 목록 서명(기본 키)
 * 데스크탑 앱은 위 파일을 바이트 그대로 복사해 가므로 이 파일도 같이 복사한다(core/creator/PROVENANCE.md 에 올린다).
 *
 * 🔴 지금은 **비어 있다.** 비어 있으면: 출하 앱은 어떤 서명 묶음도 믿지 않고(네트워크에도 묻지 않음), 수수료 일정이 없으니
 *    MISSING_SCHEDULE_POLICY='refuse' 에 따라 구매 거래를 만들지 않으며, 「검증됨」인 상품이 하나도 없다.
 * 🔴 여기에는 공개키만. 개인키·키 파일 경로·비밀 값은 어떤 형태로도 넣지 않는다(시험이 모양을 검사한다).
 * 🔴 개발·시험 키는 운영 키가 될 수 없다: DEV_KEY_IDS 에 든 keyId 가 이 배열에 있으면 시험이 실패한다
 *    (게임 허용 목록의 개발·초안 키 c7b2a3efd0ec641b 포함). 시험은 일회용 키를 verifier 인자로 직접 넘긴다 — 이 배열을 바꾸지 않는다.
 *
 * 채우는 법(대표): 오프라인 기기에서 키 생성 → 공개키를 {keyId, publicKey} 로 한 줄 추가. keyId = 공개키 32바이트 SHA-256 의 앞 8바이트 hex,
 *   publicKey = 공개키 32바이트의 base64url. (docs/mainnet-turn-on-order.md §2)
 * 이 파일은 의존성이 없다(다른 파일이 가져가도 순환하지 않는다).
 */
export type OperatingKey = { readonly keyId: string; readonly publicKey: string };

export const OPERATING_LIST_KEYS: readonly OperatingKey[] = Object.freeze([]);

/** 운영 키가 될 수 없는 keyId(개발·시험·초안 키). 운영 키를 채우기 전에 시험이 대조한다. */
export const DEV_KEY_IDS: readonly string[] = Object.freeze([
  // core/game-registry/allowlist.ts ALLOWLIST_PUBLIC_KEYS 의 개발·초안 키(2026-10-10) — 게임 등록부 전용, 장터 서명에는 쓰지 않는다.
  'c7b2a3efd0ec641b',
]);
