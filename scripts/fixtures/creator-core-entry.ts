// Test-only entry: bundles the vendored creator core for node tests and the Chrome harness (throwaway keys only).
import { secp256k1 } from '@noble/curves/secp256k1';
import { addressOfPublicKey, signMessageForTest, verifyManifest } from '../../core/creator/manifest';
import { MockPinAdapter, REAL_MAINNET_ISSUE_ENABLED, mockCid, planIssue, publishContent } from '../../core/creator/publish';
import { OPEN_MARKET_SALES_ENABLED } from '../../core/creator/open-market';
import { ticketCodeMessage } from '../../core/creator/ticket';

export { MockPinAdapter, REAL_MAINNET_ISSUE_ENABLED, OPEN_MARKET_SALES_ENABLED, mockCid, planIssue, publishContent, signMessageForTest, verifyManifest, ticketCodeMessage };
// 이미 세상에 있는 옛 RV. 상품을 시험 안에서 재현하는 길(읽기·검증·구매·열람 시험용). 새 발행(publishContent)은 옛 이름을 막는다.
export { legacyManifestForTest } from '../../core/creator/legacy-manifest-fixture';
export { RVN_MAIN_GENESIS, confirmNodeChain } from '../../core/creator/asset-testnet';
export { CREATOR_PUBLISH_PAUSED, CREATOR_PAUSE_SAY } from '../../src/creator-pause';
import { RVN_MAIN_GENESIS, confirmNodeChain } from '../../core/creator/asset-testnet';
/** 시험용 「노드가 확인한 망」(검증 함수는 늘 참 — 실제 노드에 묻지 않는다). */
export const confirmedChainForTest = (chain: string) => confirmNodeChain({ chain, genesisHash: chain === 'main' ? RVN_MAIN_GENESIS : 'ab'.repeat(32) }, () => true);
export const randomKey = () => secp256k1.utils.randomPrivateKey();
export const addressOf = (key: Uint8Array) => addressOfPublicKey(secp256k1.getPublicKey(key, true));
