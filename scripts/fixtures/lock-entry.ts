// Test-only entry: RV-LOCK v1 core + the production memo/script helpers, bundled for node tests and the Chrome harness (throwaway keys only).
import { secp256k1 } from '@noble/curves/secp256k1';
import { addressOfPublicKey, signMessageForTest, verifyManifest } from '../../core/creator/manifest';
import { MockPinAdapter, mockCid, publishContent } from '../../core/creator/publish';
import { legacyManifestForTest } from '../../core/creator/legacy-manifest-fixture';
import {
  createLockGrant, createLockRequest, decodeLockGrant, decodeLockRequest, decryptToMemory, lockKeyId, lockRequestMessage, newLockKeypair, newProductKey,
  openLockGrant, processLockRequest, sealLockedFile, MemoryLedger,
} from '../../core/creator/lock';
import { p2pkhScriptHex, sellerSharePayment } from '../../core/creator/lock-payment';
import { OPEN_MARKET_GAME_INDEX, bondedItemId } from '../../core/creator/open-market';
import { memoScriptAccount } from '../../src/market-node';

export {
  MockPinAdapter, mockCid, publishContent, legacyManifestForTest, signMessageForTest, verifyManifest, createLockGrant, createLockRequest, decodeLockGrant, decodeLockRequest, decryptToMemory,
  lockKeyId, lockRequestMessage, newLockKeypair, newProductKey, openLockGrant, processLockRequest, sealLockedFile, MemoryLedger, p2pkhScriptHex, sellerSharePayment,
  OPEN_MARKET_GAME_INDEX, bondedItemId, memoScriptAccount,
};
export { CREATOR_PUBLISH_PAUSED } from '../../src/creator-pause';
export const randomKey = () => secp256k1.utils.randomPrivateKey();
export const addressOf = (key: Uint8Array) => addressOfPublicKey(secp256k1.getPublicKey(key, true));
