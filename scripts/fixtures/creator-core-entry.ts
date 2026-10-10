// Test-only entry: bundles the vendored creator core for node tests and the Chrome harness (throwaway keys only).
import { secp256k1 } from '@noble/curves/secp256k1';
import { addressOfPublicKey, signMessageForTest, verifyManifest } from '../../core/creator/manifest';
import { MockPinAdapter, REAL_MAINNET_ISSUE_ENABLED, mockCid, planIssue, publishContent } from '../../core/creator/publish';
import { OPEN_MARKET_SALES_ENABLED } from '../../core/creator/open-market';
import { ticketCodeMessage } from '../../core/creator/ticket';

export { MockPinAdapter, REAL_MAINNET_ISSUE_ENABLED, OPEN_MARKET_SALES_ENABLED, mockCid, planIssue, publishContent, signMessageForTest, verifyManifest, ticketCodeMessage };
export const randomKey = () => secp256k1.utils.randomPrivateKey();
export const addressOf = (key: Uint8Array) => addressOfPublicKey(secp256k1.getPublicKey(key, true));
