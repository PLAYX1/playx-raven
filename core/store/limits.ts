/*
 * 가게 문서·사진 한도 — 대표 결정 전 숫자는 전부 이 파일 한 곳(파라미터). (결정문 §21 A3, §26)
 * 🔶 표시된 값은 잠정 기본값이다. 임의 확정 금지.
 */
export const STORE_DOC_VERSION = 1;
export const STORE_SIGN_DOMAIN = 'RAVENVAULT-STORE-V1';
export const STORE_PHOTO_SIGN_DOMAIN = 'RAVENVAULT-STORE-PHOTO-V1';
export const MAX_STORE_DOC_BYTES = 8 * 1024;
export const STORE_NAME_MAX = 40;
export const STORE_INTRO_MAX = 400;
export const STORE_REGION_MAX = 40;
export const STORE_CONTACTS_MAX = 4;
export const STORE_PHOTOS_MAX = 8;
export const STORE_MAX_REV = 1_000_000;
/** 문서 수명(초, §29): 기본 90일·최대 365일. 만료 뒤에는 다시 서명해야 한다(재전송 방지). 만료 14일 전부터 갱신 알림. */
export const STORE_MIN_LIFETIME_SECONDS = 24 * 3600;
export const STORE_DEFAULT_LIFETIME_SECONDS = 90 * 24 * 3600;
export const STORE_MAX_LIFETIME_SECONDS = 365 * 24 * 3600;
export const STORE_EXPIRY_WARNING_SECONDS = 14 * 24 * 3600;
/** 판매자 고지 3단계(§29). 기본 「요청 시」. 'public-doc' 일 때만 별도 공개 문서(seller-notice.ts)가 의미를 가진다. */
export const STORE_NOTICE_MODES = ['none', 'on-request', 'public-doc'] as const;
export type StoreNoticeMode = typeof STORE_NOTICE_MODES[number];
export const STORE_NOTICE_DEFAULT: StoreNoticeMode = 'on-request';
/** 공개용 별도 「판매자 고지」 문서(§29). */
export const SELLER_NOTICE_SIGN_DOMAIN = 'RAVENVAULT-SELLER-NOTICE-V1';
export const MAX_SELLER_NOTICE_BYTES = 2 * 1024;
/** 🔶 판매자 고지 문서 수명 상한 30일(리뷰 2026-10-14 L1): 사업자 정보가 바뀌면 옛 판이 오래 떠돌지 않게 가게 문서(365일)보다 짧게. 하한은 가게 문서와 같은 1일. */
export const SELLER_NOTICE_MAX_LIFETIME_SECONDS = 30 * 24 * 3600;
export const SELLER_NOTICE_MAX_REV = 1_000_000;
/** 미래 시각 허용 오차(초): 시계가 조금 빨라도 받는다. */
export const STORE_CLOCK_SKEW_SECONDS = 600;
export const STORE_CATEGORIES = ['food', 'cafe', 'retail', 'used', 'music', 'book', 'game', 'service', 'digital', 'other'] as const;
export type StoreCategory = typeof STORE_CATEGORIES[number];
export const STORE_CATEGORY_LABELS: Readonly<Record<StoreCategory, string>> = Object.freeze({
  food: '음식점', cafe: '카페', retail: '소매', used: '중고', music: '음악', book: '책', game: '게임', service: '서비스', digital: '디지털', other: '기타',
});

/* ── 사진 ─────────────────────────────────────────────────────────── */
/** 🔶 업로드 원본 상한 8 MiB. */
export const PHOTO_MAX_INPUT_BYTES = 8 * 1024 * 1024;
/** 재인코딩 결과 상한 300 KiB(§29, 4:3 채택). */
export const PHOTO_MAX_OUTPUT_BYTES = 300 * 1024;
/** 재인코딩 결과 긴 변 최대 픽셀 1600(§29). */
export const PHOTO_MAX_DIMENSION = 1600;
export const PHOTO_MIN_DIMENSION = 16;
/** 🔶 원본 픽셀 수 상한(디코더 폭탄 방지). */
export const PHOTO_MAX_INPUT_PIXELS = 40_000_000;
/** 받는 형식. SVG·GIF·HEIC·PDF 등은 거절. */
export const PHOTO_INPUT_MIMES = ['image/jpeg', 'image/png', 'image/webp'] as const;
/** 내보내는 형식(메타데이터 없는 재인코딩 결과). */
export const PHOTO_OUTPUT_MIMES = ['image/jpeg', 'image/webp'] as const;
export const PHOTO_EXT_BY_MIME: Readonly<Record<string, string>> = Object.freeze({ 'image/jpeg': 'jpg', 'image/webp': 'webp' });
/** 🔶 레이븐볼트 전용 사진 호스트(잠정 이름 — 호스트·버킷은 배포 승인 때 확정, 코드는 이 목록 밖을 서빙 주소로 인정하지 않는다). */
export const PHOTO_SERVE_HOSTS: readonly string[] = Object.freeze(['photos.ravenvault.ex.erci.se']);
export const PHOTO_SERVE_PATH_PREFIX = '/store-photos/';
