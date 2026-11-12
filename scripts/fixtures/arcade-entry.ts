// 시험 전용 묶음 — scripts/arcade-desk.test.mjs · arcade-desk-browser.test.mjs 가 쓴다(던져 버리는 키만).
import { secp256k1 } from "@noble/curves/secp256k1";
export { secp256k1 };
export * from "../../src/arcade-model";
export { ARCADE_FEE_BPS, encodeArcadeProduct, signArcadeProductForTest } from "../../core/creator/arcade-product";
export { addressOfPublicKey, MARKET_FEE_ADDRESS } from "../../core/creator/trade-primitives";
export { sha256Hex, utf8 } from "../../core/creator/bytes";
export { splitPrice } from "../../core/game-registry/platform-fee";
