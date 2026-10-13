/*
 * 브랜드 상수 — 결정문 §19(이름) · §25(브랜드 상수 파일).
 * 원칙: 「표시 이름」은 바꿀 수 있고, 「영구 식별자」는 영원히 안 바뀐다. 둘은 이 파일 안에서도 서로 계산해 만들지 않는다
 * (식별자를 표시 이름에서 파생시키면 이름을 바꾸는 순간 서명·자산·번들이 깨진다).
 * 의존성 없음(순수 TS). 읽기 전용(전부 freeze).
 */
export type BrandLang = 'ko' | 'en' | 'ja' | 'zh';

/** 사용자에게 보이는 이름. 이름을 바꿀 때 고치는 곳은 여기 한 줄뿐(다른 줄은 건드리지 않는다). ja·zh 는 현재 로마자 표기 그대로 쓰는 중. */
export const BRAND_DISPLAY_NAME: Readonly<Record<BrandLang, string>> = Object.freeze({ ko: '레이븐볼트', en: 'RavenVault', ja: 'RavenVault', zh: 'RavenVault' });

/** 대표 확정(2026-10-13): 주소 유지. 끝 슬래시 없음. */
export const BRAND_ORIGIN = 'https://ravenvault.ex.erci.se';

/** 스토어 병기 후보(§19 위험 신호: 동명 앱 존재 → 필요 시 「by PLAY X」). 지금은 병기하지 않는다. */
export const BRAND_STORE_SUFFIX = '' as string;

/**
 * 영구 식별자 — 표시 이름과 무관. 값을 바꾸면 이미 발행된 서명·체인 자산·설치된 앱이 깨진다. 바꾸지 말 것(테스트가 고정).
 * - bundleId: iOS bundleIdentifier · Android package (phone/app.json, 스토어 링크).
 * - rootAsset / purchaseMemoMagic: 체인 루트 자산 RVLT · 구매 메모(OP_RETURN) 매직. 소각은 이름 확정 전 보류(§19).
 * - signingDomainPrefix: 모든 서명 domain 문자열의 앞머리(전체 목록은 SIGNING_DOMAINS).
 */
export const BRAND_IDS = Object.freeze({
  bundleId: 'se.erci.ravenvault',
  rootAsset: 'RVLT',
  purchaseMemoMagic: 'RVLT',
  purchaseMemoVersion: 2, // §29 ② 주문 해시 v2(총액·단가·수량·분할표) — 배포 전 마지막 변경으로 1 → 2.
  signingDomainPrefix: 'RAVENVAULT',
});

/** 폐기 예정(§21 A1, 대표 승인 대기): 옛 자산 이름 접두어 「RV.」. 새 발행에는 쓰지 않는다. 기존 코드 호환용으로만 남김. */
export const LEGACY_ASSET_PREFIX = 'RV.';

/** 서명 domain 전체(리터럴 고정). 키 이름은 코드 쪽 상수 이름과 같다. 실제 코드 상수와의 일치는 brand.test.ts 가 대조한다. */
export const SIGNING_DOMAINS = Object.freeze({
  FEE_TRACK_V1: 'RAVENVAULT-FEE-TRACK-V1',
  FEE_TRACK_V2: 'RAVENVAULT-FEE-TRACK-V2',
  FEE_SCHEDULE_V1: 'RAVENVAULT-FEE-SCHEDULE-V1',
  LOCK_REQ_V1: 'RAVENVAULT-LOCK-REQ-V1',
  CREATOR_ALLOWLIST_V1: 'RAVENVAULT-CREATOR-ALLOWLIST-V1',
  CREATOR_DENYLIST_V1: 'RAVENVAULT-CREATOR-DENYLIST-V1',
  CREATOR_MANIFEST_V2: 'RAVENVAULT-CREATOR-MANIFEST-V2',
  PRODUCT_V1: 'RAVENVAULT-PRODUCT-V1',
  ORDER_V2: 'RAVENVAULT-ORDER-V2', // §29 ② 주문 원문 v2. 배포 전이라 V1 은 남기지 않는다.
  TICKET_V1: 'RAVENVAULT-TICKET-V1',
  ENTITLEMENT_V1: 'RAVENVAULT-ENTITLEMENT-V1',
  GAME_IDENTITY_V1: 'RAVENVAULT-GAME-IDENTITY-V1',
  GAME_ALLOWLIST_V1: 'RAVENVAULT-GAME-ALLOWLIST-V1',
  SIGNED_LISTS_V1: 'RAVENVAULT-SIGNED-LISTS-V1',
  LIST_KEY_TRANSITION_V1: 'RAVENVAULT-LIST-KEY-TRANSITION-V1',
  MARKET_CATALOG_V1: 'RAVENVAULT-MARKET-CATALOG-V1',
});
export type SigningDomainKey = keyof typeof SIGNING_DOMAINS;

export type Brand = Readonly<{
  displayName: Readonly<Record<BrandLang, string>>;
  origin: string;
  ids: typeof BRAND_IDS;
  signingDomains: typeof SIGNING_DOMAINS;
}>;

/** 기본 브랜드. */
export const BRAND: Brand = Object.freeze({ displayName: BRAND_DISPLAY_NAME, origin: BRAND_ORIGIN, ids: BRAND_IDS, signingDomains: SIGNING_DOMAINS });

/**
 * 시험·미리보기용: 표시 이름만 바꾼 브랜드를 만든다. 식별자·서명 domain·주소는 항상 기본값 그대로(인자로 못 바꾼다).
 * 「이름만 바꿔도 서명·자산·번들 ID 는 불변」을 코드 구조로 보장하는 지점.
 */
export function createBrand(displayName: Partial<Record<BrandLang, string>> = {}): Brand {
  return Object.freeze({ displayName: Object.freeze({ ...BRAND_DISPLAY_NAME, ...displayName }), origin: BRAND_ORIGIN, ids: BRAND_IDS, signingDomains: SIGNING_DOMAINS });
}

export const brandName = (lang: BrandLang = 'ko', brand: Brand = BRAND): string => brand.displayName[lang] ?? brand.displayName.en;

/** 주소 만들기. path 는 「/download」·「lists/x.json」 모두 허용. 절대 주소·`//`·`..` 는 거절(주소 바꿔치기 방지). */
export function brandUrl(path = '', brand: Brand = BRAND): string {
  if (/^[a-z][a-z0-9+.-]*:|^\/\//i.test(path) || /(^|\/)\.\.(\/|$)/.test(path)) throw new Error('brandUrl: relative path only');
  return brand.origin + (path === '' ? '' : path.startsWith('/') ? path : '/' + path);
}

export const isBrandOrigin = (url: string, brand: Brand = BRAND): boolean => url === brand.origin || url.startsWith(brand.origin + '/');

/** 문구 안의 {brand} 자리를 표시 이름으로 바꾼다(i18n 문구가 이름을 하드코딩하지 않게 하려는 용도). */
export const withBrandName = (text: string, lang: BrandLang = 'ko', brand: Brand = BRAND): string => text.split('{brand}').join(brandName(lang, brand));

/** 서명 domain 조회(키 오타는 컴파일 오류). */
export const signingDomain = (key: SigningDomainKey): string => SIGNING_DOMAINS[key];
/** 문자열이 우리 서명 domain 형식(접두 + 「-」)인지. */
export const isBrandSigningDomain = (s: string): boolean => s.startsWith(BRAND_IDS.signingDomainPrefix + '-');
