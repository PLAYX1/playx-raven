import { deriveAddressAtHardenedPath, derivePrivateKeyAtHardenedPath, hardenedPathString, type DerivedAddress, type HardenedKeyPath } from '../wallet-keys/derive';

/*
 * 가게 서명 키 — 가게·상품·사진·판매자 안내·기기 증서·철회 목록·견적·티켓 발행·방 공지처럼 「가게 이름으로 서명하는 문서」의 키.
 * 돈 주소 키(m/44'/175'/0'/0/0 …)와 다른 전용 경로다. 데스크탑 Rust identity.rs PATH_SHOP 과 같은 값이어야 한다(store-key.test.ts 가 바이트로 고정).
 *
 * 🔴 되돌릴 수 없는 상수: 이 경로로 서명한 가게 문서를 공개(게시)하는 순간 공개키가 곧 가게 신원이 된다. 그 뒤에 경로를 바꾸면
 *    모든 가게 번호·상품 번호·티켓 발행자·기기 증서가 새 키로 다시 서명돼야 한다. 그래서 시험이 경로 문자열과 공개키를 못 박아 둔다.
 *
 * 돈 주소와의 관계: 가게 키는 돈을 받지 않는다. 상품 payTo·구매 대금·영수증·환불·투표 신원은 지갑 주소 키 그대로다(문서의 seller ≠ payTo).
 */
export const STORE_KEY_PATH: Readonly<HardenedKeyPath> = Object.freeze({ purpose: 44, coinType: 175, account: 7, branch: 1, index: 0 });
export const STORE_KEY_BIP32 = hardenedPathString(STORE_KEY_PATH);

/** 가게 개인키(32바이트). 호출자가 쓰고 fill(0) 한다. */
export const storePrivateKey = (seed: Uint8Array): Uint8Array => derivePrivateKeyAtHardenedPath(seed, STORE_KEY_PATH);
/** 가게 압축 공개키(66 hex, 문서의 seller/store/issuerKey)와 그 R… 주소(서명 확인용 — 돈을 받는 주소가 아니다). */
export const storeKeyInfo = (seed: Uint8Array): DerivedAddress => deriveAddressAtHardenedPath(seed, STORE_KEY_PATH);
