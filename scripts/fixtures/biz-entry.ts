// Test-only entry: desktop 「기기 연결」 · 「상품 대량 등록」 pure rules + throwaway-key helpers for node tests and the Chrome harness.
import { secp256k1 } from '@noble/curves/secp256k1';
import { keyDigestSignerForTest } from '../../core/signer/test-key';
import { hex } from '../../core/creator/bytes';
import { deviceCertId, verifyDeviceCert, DEVICE_CERT_DEFAULT_DAYS, DEVICE_ROLE_SCOPES, deviceIdOf, encodeDeviceCert } from '../../core/device/cert';
import { verifyDeviceRevocationList } from '../../core/device/revoke';
export * from '../../src/device-connect';
export * from '../../src/bulk-products-ui';
export * from '../../src/store-doc-ui';
export { verifyStoreDoc, storeIdOf, storeDocHash, encodeStoreDoc, StoreError } from '../../core/store/store-doc';
export { storeKeyInfo, STORE_KEY_BIP32 } from '../../core/store/store-key';
export { parseBulkProducts, BULK_LIMITS } from '../../core/creator/bulk-products';
export { CREATOR_PUBLISH_PAUSED } from '../../src/creator-pause';
export { sellerAddressOf } from '../../core/creator/product-doc';
export { t, tf, hasOwnTranslation } from '../../src/i18n';
export { deviceCertId, verifyDeviceCert, verifyDeviceRevocationList, DEVICE_CERT_DEFAULT_DAYS, DEVICE_ROLE_SCOPES, deviceIdOf, encodeDeviceCert };
/** 시험용 고정 가짜 키(실제 키 아님). */
export const fakePriv = (n: number) => Uint8Array.from({ length: 32 }, (_, i) => (i === 31 ? n : 0));
export const pubOf = (priv: Uint8Array) => hex(secp256k1.getPublicKey(priv, true));
export const signerOf = (priv: Uint8Array) => keyDigestSignerForTest(priv);
