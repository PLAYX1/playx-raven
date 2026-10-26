import MAINNET_SWITCH from './mainnet-switch.json';

/*
 * 메인넷 스위치 — 값은 core/creator/mainnet-switch.json **한 파일**이다. (C6 통합, 2026-10-12)
 *
 * 이 파일은 그 JSON 을 읽어 이름 붙인 상수로 내보낼 뿐이다(publish.ts / open-market.ts / purchase.ts 가 가져간다).
 * 데스크탑 앱은 이 파일·JSON·publish.ts·open-market.ts 를 **바이트 그대로** 복사해 가고, Rust(issue.rs · market.rs)는 같은 JSON 을 include_str! 로 읽는다.
 * 그래서 지갑·데스크탑·Rust 가 읽는 값은 한 파일의 한 번 바꿈이다.
 *
 *   issue          메인넷 자산 발행(소각 500 RVN)을 연다.       → REAL_MAINNET_ISSUE_ENABLED
 *   sales          제작자 상품 구매 거래를 만든다.              → OPEN_MARKET_SALES_ENABLED
 *   acknowledged   켜는 사람이 직접 true 로 바꾼다(시험 전용). issue·sales 가 켜졌는데 이것이 false 면 시험이 실패한다 — 슬쩍 켜진 커밋 방지.
 *   verifiedOnly   1단계 제한(안전 기본값 true). 대표 서명 허용 목록(creatorAllowlist)에 오른 상품만 결제. enable 커밋도 건드리지 않는다. → PAYMENT_ALLOWLIST_ONLY
 *
 * 커밋된 기본값은 issue·sales·acknowledged 가 **전부 false**. 켜는 것은 별도 브랜치의 「enable」 커밋 하나(JSON 세 줄)뿐이다.
 * 🔴 환경 변수·설정 파일·원격 목록으로 켜는 길은 없다. 이 JSON 이 유일한 문이다. (끄기 = 되돌린 새 릴리스)
 * 확인: node scripts/check-mainnet-switches.mjs --desktop <데스크탑 폴더> --require-desktop
 */
export const REAL_MAINNET_ISSUE_ENABLED: boolean = MAINNET_SWITCH.issue;
export const OPEN_MARKET_SALES_ENABLED: boolean = MAINNET_SWITCH.sales;
/**
 * 결제 허용 목록 전용(C10) = JSON 의 verifiedOnly. true 인 동안 지갑은 **대표가 서명한 허용 목록에 오른 상품에만** 구매 거래를 만든다(payment-allowlist.ts → checkCreatorPurchase).
 * 보증(b)층도 결제는 닫힌다(목록·미리보기·확인 화면은 그대로). 허용 목록이 비어 있으면 결제할 수 있는 상품이 없다.
 */
export const PAYMENT_ALLOWLIST_ONLY: boolean = MAINNET_SWITCH.verifiedOnly;
/** 시험·검사 도구용: JSON 전체(앱 코드는 위 세 상수만 쓴다). */
export const MAINNET_SWITCH_STATE = MAINNET_SWITCH;
