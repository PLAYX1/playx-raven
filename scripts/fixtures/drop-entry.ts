// Test-only entry: drop-publish pure modules + the vendored creator core (throwaway keys only).
import { secp256k1 } from '@noble/curves/secp256k1';
export * from '../../src/drop-detect';
export * from '../../src/drop-look';
export * from '../../src/drop-manifest';
export * from '../../src/drop-state';
export * from '../../src/drop-copy';
export * from '../../src/drop-genre';
export { addressOfPublicKey, signMessageForTest, validateManifest, verifyManifest, withSignature, encodeManifest, manifestSigningMessage } from '../../core/creator/manifest';
export { MockPinAdapter, MockIssuer, planIssue, publishContent, mockCid, REAL_MAINNET_ISSUE_ENABLED } from '../../core/creator/publish';
export { canonicalJson } from '../../core/creator/bytes';
import { addressOfPublicKey } from '../../core/creator/manifest';
export const randomKey = () => secp256k1.utils.randomPrivateKey();
export const addressOf = (key: Uint8Array) => addressOfPublicKey(secp256k1.getPublicKey(key, true));
